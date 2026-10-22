"""Write session data back into an Aurora Builder ``.dnd5e`` file (spec §3.1).

``patch_aurora(xml, ch)`` makes targeted text replacements on the raw XML string. Only the
listed elements inside ``<build><input>`` change. Every other character stays exactly as it
was, including the BOM, CRLF line endings, indentation, comments and the multi-megabyte base64
portrait. A tag that is absent stays absent.

Each target is found by walking direct children (root > build > input > name), so the
``<name>`` inside ``<organization>`` or ``<display-properties>`` is never touched. Comments
and CDATA sections are masked before scanning, so markup-like text inside them (for example a
backstory that quotes ``</input>``) cannot be taken for a tag.

Values written:
  build/input/name                      <- ch.name                  (escaped text)
  build/input/experience                <- ch.xp                    (integer)
  build/input/currency/copper..platinum <- ch.coins.cp|sp|ep|gp|pp  (integers)
  build/input/backstory                 <- ch.bio.backstory         (CDATA)
  build/input/background-traits|ideals|bonds|flaws <- ch.bio.traits|ideals|bonds|flaws (CDATA)
  build/input/organization/allies       <- ch.bio.allies            (CDATA)
  build/input/notes/note[@column=left]  <- session summary          (escaped plain text)
A value that is missing from ``ch`` (None / absent key) leaves its element unchanged.
"""
from __future__ import annotations

import math
import re
from datetime import datetime
from typing import Any, NamedTuple

__all__ = ["patch_aurora", "split_cdata", "session_summary"]

_MASK_RE = re.compile(r"<!\[CDATA\[.*?\]\]>|<!--.*?-->", re.S)
# Start or end tag: group 1 = "/" for an end tag, 2 = name, 3 = everything up to ">" (quotes respected).
_TAG_RE = re.compile(r"""<(/?)([A-Za-z_:][-\w.:]*)((?:"[^"]*"|'[^']*'|[^'">])*)>""")
_ATTR_RE = re.compile(r"""([A-Za-z_:][-\w.:]*)\s*=\s*(?:"([^"]*)"|'([^']*)')""")
# Characters XML 1.0 cannot carry (C0 controls except tab/LF/CR, surrogates, U+FFFE/U+FFFF).
_INVALID_XML_RE = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff￾￿]")
_SLOT_TARGET_RE = re.compile(r"spellSlots\.([1-9])")

_DURATION_TEXT = {
    "permanent": "permanent",
    "short": "until short rest",
    "long": "until long rest",
    "manual": "until cancelled",
}


# ------------------------------------------------------------------------------ text helpers
def _clean(text: str) -> str:
    return _INVALID_XML_RE.sub("", text)


def _escape(text: str) -> str:
    return _clean(text).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def split_cdata(text: str) -> str:
    """Wrap ``text`` in CDATA so it can hold anything, including ``]]>``.

    A CDATA section cannot contain ``]]>``, so each occurrence is split across two sections
    (``]]`` ends the first, ``>`` opens the next): ``a]]>b`` -> ``<![CDATA[a]]]]><![CDATA[>b]]>``.
    Any XML parser reads the result back as the original text.
    """
    return "<![CDATA[" + _clean(str(text)).replace("]]>", "]]]]><![CDATA[>") + "]]>"


def _number(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        n = float(value)
    elif isinstance(value, str):
        try:
            n = float(value.strip())
        except ValueError:
            return None
    else:
        return None
    return n if math.isfinite(n) else None


def _int_text(value: Any) -> str | None:
    if isinstance(value, int) and not isinstance(value, bool):
        return str(value)
    n = _number(value)
    return None if n is None else str(int(round(n)))


def _num_or_zero(value: Any) -> float:
    if isinstance(value, bool):
        return float(value)  # JavaScript Number(true) === 1, matching rules.js
    n = _number(value)
    return 0.0 if n is None else n


def _fmt(n: Any) -> str:
    if isinstance(n, float) and n.is_integer():
        return str(int(n))
    return str(n)


def _ordinal(n: int) -> str:
    if 10 <= n % 100 <= 20:
        suffix = "th"
    else:
        suffix = {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}{suffix}"


def _one_line(text: str) -> str:
    return " ".join(str(text).split())


def _newlines(text: str, newline: str) -> str:
    """Use the file's own line-ending style for inserted text (parsers read both the same)."""
    return re.sub(r"\r\n|\r|\n", newline, text)


# ------------------------------------------------------------------------------ session summary
def _override_text(o: dict) -> str:
    target = str(o.get("target") or "?")
    if o.get("mode") == "set":
        change = f"{target} = {_one_line(o.get('value'))}"
    else:
        n = _num_or_zero(o.get("value"))
        change = f"{target} {'+' if n >= 0 else ''}{_fmt(n)}"
    label = _one_line(o.get("label") or "")
    text = f"{label}: {change}" if label else change
    duration = o.get("duration")
    if duration:
        text += f" ({_DURATION_TEXT.get(duration, _one_line(duration))})"
    note = _one_line(o.get("note") or "")
    if note:
        text += f" - {note}"
    return text


def session_summary(ch: dict, now: datetime | None = None, newline: str = "\n") -> str:
    """Plain-text block for ``<note column="left">``: date, HP, conditions, exhaustion,
    spell slots used, active overrides (one per line) and ``Exported from Tome & Table``.
    HP maximum and slot maxima include active overrides, as on the sheet."""
    now = now or datetime.now()
    overrides = [o for o in (ch.get("overrides") or []) if isinstance(o, dict)] if isinstance(ch.get("overrides"), list) else []

    hp = ch.get("hp") if isinstance(ch.get("hp"), dict) else {}
    hp_bonus = sum(_num_or_zero(o.get("value")) for o in overrides if o.get("target") == "hp.max")
    hp_max = max(0.0, _num_or_zero(hp.get("max")) + hp_bonus)
    lines = [
        f"Date: {now.date().isoformat()}",
        f"HP: {_fmt(_num_or_zero(hp.get('current')))}/{_fmt(hp_max)} (temp {_fmt(_num_or_zero(hp.get('temp')))})",
    ]

    conditions = ch.get("conditions") if isinstance(ch.get("conditions"), list) else []
    names = [_one_line(c.get("name", "") if isinstance(c, dict) else c) for c in conditions]
    names = [n for n in names if n]
    lines.append("Conditions: " + (", ".join(names) if names else "none"))
    lines.append(f"Exhaustion: {_fmt(_num_or_zero(ch.get('exhaustion')))}")

    sc = ch.get("spellcasting") if isinstance(ch.get("spellcasting"), dict) else {}
    slots = sc.get("slots") if isinstance(sc.get("slots"), dict) else {}
    bonus: dict[str, float] = {}
    for o in overrides:
        m = _SLOT_TARGET_RE.fullmatch(str(o.get("target") or ""))
        if m:
            bonus[m.group(1)] = bonus.get(m.group(1), 0.0) + _num_or_zero(o.get("value"))
    keys = set(slots) | set(bonus)
    parts = []
    for key in sorted(keys, key=lambda k: (0, int(k), "") if str(k).isdigit() else (1, 0, str(k))):
        slot = slots.get(key) if isinstance(slots.get(key), dict) else {}
        top = max(0.0, _num_or_zero(slot.get("max")) + bonus.get(key, 0.0))
        used = _num_or_zero(slot.get("used"))
        if not top and not used:
            continue
        if str(key).isdigit():
            label = _ordinal(int(key))
        else:
            label = _one_line(str(key)).capitalize()
            if slot.get("level"):
                label += f" (level {_fmt(slot['level'])})"
        parts.append(f"{label} {_fmt(used)}/{_fmt(top)}")
    lines.append("Spell slots used: " + (", ".join(parts) if parts else "none"))

    if overrides:
        lines.append("Active overrides:")
        lines.extend("- " + _override_text(o) for o in overrides)
    else:
        lines.append("Active overrides: none")
    lines.append("Exported from Tome & Table")
    return newline.join(lines)


# ------------------------------------------------------------------------------ XML scanning
class _Open(NamedTuple):
    name: str
    start: int          # index of "<"
    end: int            # index just past ">"
    self_closing: bool


def _mask(xml: str) -> str:
    """Same-length copy of ``xml`` with CDATA and comment contents blanked out."""
    def blank(m: re.Match) -> str:
        s = m.group(0)
        if s.startswith("<![CDATA["):
            return "<![CDATA[" + " " * (len(s) - 12) + "]]>"
        return "<!--" + " " * (len(s) - 7) + "-->"
    return _MASK_RE.sub(blank, xml)


def _attrs(raw: str) -> dict[str, str]:
    return {m.group(1): m.group(2) if m.group(2) is not None else m.group(3) for m in _ATTR_RE.finditer(raw)}


def _find_child(masked: str, start: int, name: str, attrs: dict[str, str] | None = None) -> _Open | None:
    """First direct child called ``name`` (with matching attributes) of the element whose
    content starts at ``start``; None once that element closes."""
    depth = 0
    for m in _TAG_RE.finditer(masked, start):
        if m.group(1):
            depth -= 1
            if depth < 0:
                return None
            continue
        self_closing = m.group(3).rstrip().endswith("/")
        if depth == 0 and m.group(2) == name and (
            not attrs or all(_attrs(m.group(3)).get(k) == v for k, v in attrs.items())
        ):
            return _Open(name, m.start(), m.end(), self_closing)
        if not self_closing:
            depth += 1
    return None


def _close_of(masked: str, el: _Open) -> tuple[int, int] | None:
    """(start, end) of the end tag that matches ``el``."""
    depth = 1
    for m in _TAG_RE.finditer(masked, el.end):
        if m.group(1):
            depth -= 1
            if depth == 0:
                return m.start(), m.end()
        elif not m.group(3).rstrip().endswith("/"):
            depth += 1
    return None


def _input_element(masked: str) -> _Open | None:
    root = _TAG_RE.search(masked)  # the XML declaration, comments and DOCTYPE never match
    if root is None or root.group(1) or root.group(3).rstrip().endswith("/"):
        return None
    build = _find_child(masked, root.end(), "build")
    if build is None or build.self_closing:
        return None
    inp = _find_child(masked, build.end, "input")
    if inp is None or inp.self_closing:
        return None
    return inp


def _locate(masked: str, parent: _Open, path: tuple) -> _Open | None:
    el = parent
    for i, step in enumerate(path):
        name, attrs = step if isinstance(step, tuple) else (step, None)
        el = _find_child(masked, el.end, name, attrs)
        if el is None or (el.self_closing and i < len(path) - 1):
            return None
    return el


def _replacement(xml: str, masked: str, el: _Open, inner: str) -> tuple[int, int, str] | None:
    if el.self_closing:  # <backstory /> -> <backstory>inner</backstory>
        opening = xml[el.start:el.end][:-1].rstrip()[:-1].rstrip() + ">"
        return el.start, el.end, f"{opening}{inner}</{el.name}>"
    close = _close_of(masked, el)
    if close is None:
        return None
    return el.end, close[0], inner


# ------------------------------------------------------------------------------ entry point
def patch_aurora(xml: str, ch: dict, *, now: datetime | None = None) -> str:
    """Return ``xml`` with the character's session data written back (see module docstring)."""
    if not isinstance(xml, str):
        raise TypeError("xml must be a str")
    ch = ch if isinstance(ch, dict) else {}
    masked = _mask(xml)
    inp = _input_element(masked)
    if inp is None:
        return xml

    newline = "\r\n" if "\r\n" in xml else "\n"
    bio = ch.get("bio") if isinstance(ch.get("bio"), dict) else {}
    coins = ch.get("coins") if isinstance(ch.get("coins"), dict) else {}

    def cdata(key: str) -> str | None:
        value = bio.get(key)
        return None if value is None else split_cdata(_newlines(str(value), newline))

    name = ch.get("name")
    edits: list[tuple[tuple, str | None]] = [
        (("name",), None if name is None else _escape(_one_line(name))),
        (("experience",), _int_text(ch.get("xp"))),
        (("currency", "copper"), _int_text(coins.get("cp"))),
        (("currency", "silver"), _int_text(coins.get("sp"))),
        (("currency", "electrum"), _int_text(coins.get("ep"))),
        (("currency", "gold"), _int_text(coins.get("gp"))),
        (("currency", "platinum"), _int_text(coins.get("pp"))),
        (("backstory",), cdata("backstory")),
        (("background-traits",), cdata("traits")),
        (("background-ideals",), cdata("ideals")),
        (("background-bonds",), cdata("bonds")),
        (("background-flaws",), cdata("flaws")),
        (("organization", "allies"), cdata("allies")),
        (("notes", ("note", {"column": "left"})), _escape(session_summary(ch, now, newline))),
    ]

    replacements = []
    for path, inner in edits:
        if inner is None:
            continue
        el = _locate(masked, inp, path)
        if el is None:
            continue  # absent tags stay absent
        rep = _replacement(xml, masked, el, inner)
        if rep is not None:
            replacements.append(rep)

    parts, pos = [], 0
    for start, end, text in sorted(replacements):
        parts.append(xml[pos:start])
        parts.append(text)
        pos = end
    parts.append(xml[pos:])
    return "".join(parts)
