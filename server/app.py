"""Tome & Table HTTP API (FastAPI + SQLite) and static host for ``web/``.

Contract: docs/superpowers/specs/2026-10-13-multiuser-server-design.md (§2, §3, §7).

Run locally:  py -m uvicorn server.app:app --port 8787 --app-dir dnd-companion
Environment:  DATA_DIR (default <repo>/data), PORT (8787, used by ``py -m server.app``),
              SESSION_DAYS (30), ALLOW_SIGNUP (1), COOKIE_SECURE (auto; 1 forces Secure cookies).

Conventions: every error is ``{"error": "..."}``; mutating /api requests need the header
``X-Requested-With: TomeAndTable`` (else 403); records the caller may not see answer 404,
records they can see but may not change answer 403.
"""
from __future__ import annotations

import copy
import json
import math
import mimetypes
import os
import re
import secrets
import sqlite3
import string
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import MutableHeaders
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import auth
from .aurora_patch import patch_aurora
from .db import Database, new_id, now_ms

REPO_ROOT = Path(__file__).resolve().parent.parent
DAY_MS = 86_400_000
PURGE_AFTER_MS = 30 * DAY_MS
MAX_BODY_BYTES = 64 * 1024 * 1024
CSRF_VALUE = b"TomeAndTable"

# Fields the server owns: merged into every character on read, stripped from every write.
SERVER_FIELDS = frozenset({
    "id", "owner_id", "owner_name", "campaign_id", "source", "has_aurora",
    "can_edit", "can_override", "updated", "created", "deleted",
})
# Base fields locked to the Aurora export (§2.1); hitDice.total/die, spellcasting.ability and
# slot maxima are handled in lock_base_fields().
BASE_FIELDS = ("abilities", "saveProf", "skillProf", "classes", "race", "background", "alignment")
OVERRIDE_MODES = ("add", "set")
OVERRIDE_DURATIONS = ("permanent", "short", "long", "manual")
INVITE_ALPHABET = string.ascii_uppercase + string.digits

# Windows can map .js to text/plain through the registry, which breaks ES modules.
for _ext, _type in ((".js", "text/javascript"), (".mjs", "text/javascript"), (".css", "text/css"),
                    (".json", "application/json"), (".webmanifest", "application/manifest+json"),
                    (".svg", "image/svg+xml"), (".html", "text/html"), (".png", "image/png"),
                    (".ico", "image/x-icon"), (".woff2", "font/woff2"), (".txt", "text/plain")):
    mimetypes.add_type(_type, _ext)


# ================================================================================ settings
@dataclass(frozen=True)
class Settings:
    data_dir: Path
    web_dir: Path
    session_days: int = 30
    allow_signup: bool = True
    cookie_secure: bool = False  # True forces Secure; otherwise decided per request (https / proxy)

    @property
    def aurora_dir(self) -> Path:
        return self.data_dir / "aurora"

    @property
    def db_path(self) -> Path:
        return self.data_dir / "tome.db"


def _env_bool(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None or value.strip().lower() in ("", "auto"):
        return default
    return value.strip().lower() in ("1", "true", "yes", "on")


def _env_int(name: str, default: int) -> int:
    try:
        return max(1, int(os.environ.get(name, default)))
    except ValueError:
        return default


def _resolve_dir(value: str | os.PathLike) -> Path:
    path = Path(value).expanduser()
    return path if path.is_absolute() else REPO_ROOT / path


def load_settings(data_dir=None, *, web_dir=None, session_days=None, allow_signup=None, cookie_secure=None) -> Settings:
    """Explicit arguments win; anything left as None comes from the environment."""
    return Settings(
        data_dir=_resolve_dir(data_dir if data_dir is not None else os.environ.get("DATA_DIR") or "data"),
        web_dir=_resolve_dir(web_dir if web_dir is not None else "web"),
        session_days=session_days if session_days is not None else _env_int("SESSION_DAYS", 30),
        allow_signup=allow_signup if allow_signup is not None else _env_bool("ALLOW_SIGNUP", True),
        cookie_secure=cookie_secure if cookie_secure is not None else _env_bool("COOKIE_SECURE", False),
    )


# ================================================================================ errors & request bodies
class ApiError(Exception):
    def __init__(self, status: int, message: str, headers: dict[str, str] | None = None):
        super().__init__(message)
        self.status, self.message, self.headers = status, message, headers


def _finite_float(text: str) -> float:
    value = float(text)
    if not math.isfinite(value):
        raise ValueError("number out of range")
    return value


def _reject_constant(name: str):
    raise ValueError(f"{name} is not allowed")


_ESCAPED_SURROGATE = re.compile(rb"\\u[dD][89a-fA-F]")
_LONE_SURROGATE = re.compile("[\ud800-\udfff]")


def _scrub(value: Any) -> Any:
    """Replace lone UTF-16 surrogates (only reachable through \\uD8xx escapes) with U+FFFD so every
    stored string can be encoded as UTF-8 again."""
    if isinstance(value, str):
        return _LONE_SURROGATE.sub("�", value)
    if isinstance(value, list):
        return [_scrub(v) for v in value]
    if isinstance(value, dict):
        return {_scrub(k): _scrub(v) for k, v in value.items()}
    return value


async def read_json(request: Request) -> Any:
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > MAX_BODY_BYTES:
        raise ApiError(413, "Request body is too large")
    chunks, size = [], 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > MAX_BODY_BYTES:
            raise ApiError(413, "Request body is too large")
        chunks.append(chunk)
    raw = b"".join(chunks)
    if not raw.strip():
        return None
    try:
        value = json.loads(raw, parse_float=_finite_float, parse_constant=_reject_constant)
        return _scrub(value) if _ESCAPED_SURROGATE.search(raw) else value
    except (ValueError, RecursionError):
        raise ApiError(400, "Request body is not valid JSON") from None


async def read_object(request: Request) -> dict:
    body = await read_json(request)
    if body is None:
        return {}
    if not isinstance(body, dict):
        raise ApiError(400, "Request body must be a JSON object")
    return body


def _dump(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def _load_obj(text: str | None) -> dict:
    try:
        value = json.loads(text or "{}")
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


def _truthy(value: Any) -> bool:
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "on")
    return value is True or (isinstance(value, (int, float)) and value == 1)


def _no_content() -> Response:
    return Response(status_code=204)


# ================================================================================ request context
def _db(request: Request) -> Database:
    return request.app.state.db


def _settings(request: Request) -> Settings:
    return request.app.state.settings


def current_user(request: Request) -> dict:
    user = auth.session_user(_db(request), request.cookies.get(auth.COOKIE_NAME))
    if user is None:
        raise ApiError(401, "Not signed in")
    return user


# ================================================================================ characters: helpers
CHAR_SELECT = "SELECT c.*, u.username AS owner_name FROM characters c JOIN users u ON u.id = c.owner_id"
NOTE_SELECT = "SELECT n.*, u.username AS owner_name FROM notes n JOIN users u ON u.id = n.owner_id"


def aurora_path(settings: Settings, character_id: str) -> Path:
    return settings.aurora_dir / f"{character_id}.dnd5e"


def write_aurora(settings: Settings, character_id: str, xml: str) -> None:
    """Store the XML as UTF-8, byte for byte as received (no newline translation)."""
    path = aurora_path(settings, character_id)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(xml.encode("utf-8"))
    os.replace(tmp, path)


def remove_aurora(settings: Settings, character_id: str) -> None:
    try:
        aurora_path(settings, character_id).unlink(missing_ok=True)
    except OSError:
        pass


def character_out(row: dict, viewer_id: str, viewer_is_dm: bool, settings: Settings) -> dict:
    """Flattened character (§2.1): stored data plus the server fields."""
    out = {k: v for k, v in _load_obj(row["data"]).items() if k not in SERVER_FIELDS}
    owner = row["owner_id"] == viewer_id
    out.update(
        id=row["id"], owner_id=row["owner_id"], owner_name=row["owner_name"], campaign_id=row["campaign_id"],
        source=row["source"], has_aurora=aurora_path(settings, row["id"]).is_file(),
        can_edit=owner, can_override=owner or viewer_is_dm,
        updated=row["updated"], created=row["created"], deleted=row["deleted"],
    )
    return out


def character_data(obj: dict) -> dict:
    """Client object minus server fields (and the transport-only ``xml``)."""
    return {k: v for k, v in obj.items() if k not in SERVER_FIELDS and k != "xml"}


def load_character(db: Database, character_id: str) -> dict | None:
    return db.one(CHAR_SELECT + " WHERE c.id = ?", (character_id,))


def character_for(db: Database, user: dict, character_id: str) -> tuple[dict, bool, bool]:
    """(row, caller owns it, caller DMs its campaign); 404 when the caller cannot see it.
    Visible: own characters (trashed too) and non-deleted ones in a campaign I DM or belong to."""
    row = load_character(db, character_id)
    if row is None:
        raise ApiError(404, "Character not found")
    owner = row["owner_id"] == user["id"]
    role = db.campaign_role(user["id"], row["campaign_id"]) if row["campaign_id"] else None
    if not owner and (row["deleted"] is not None or role is None):
        raise ApiError(404, "Character not found")
    return row, owner, role == "dm"


def normalize_overrides(value: Any, user_id: str, now: int) -> list[dict]:
    if not isinstance(value, list):
        raise ApiError(400, "overrides must be an array")
    out = []
    for i, item in enumerate(value):
        if not isinstance(item, dict):
            raise ApiError(400, f"overrides[{i}] must be an object")
        if not isinstance(item.get("target"), str) or not item["target"].strip():
            raise ApiError(400, f"overrides[{i}].target must be a non-empty string")
        if item.get("mode") not in OVERRIDE_MODES:
            raise ApiError(400, f"overrides[{i}].mode must be 'add' or 'set'")
        if item.get("duration") not in OVERRIDE_DURATIONS:
            raise ApiError(400, f"overrides[{i}].duration must be one of {', '.join(OVERRIDE_DURATIONS)}")
        o = dict(item)
        if not o.get("id"):
            o["id"] = new_id()
        if not o.get("createdBy"):
            o["createdBy"] = user_id
        if o.get("createdAt") is None:
            o["createdAt"] = now
        out.append(o)
    return out


def _as_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return float(value)
    if isinstance(value, (int, float)):
        return float(value) if math.isfinite(value) else None
    if isinstance(value, str):
        try:
            n = float(value.strip())
        except ValueError:
            return None
        return n if math.isfinite(n) else None
    return None


def _clamp_used(value: Any, limit: int, fallback: Any = 0) -> int:
    n = _as_number(value)
    if n is None:
        n = _as_number(fallback) or 0.0
    return max(0, min(int(n), limit))


def slot_bonus(overrides: Any) -> dict[str, float]:
    """Sum of ``spellSlots.<n>`` overrides per slot level, as rules.js applyOverrides() adds them."""
    bonus: dict[str, float] = {}
    for o in overrides if isinstance(overrides, list) else []:
        if isinstance(o, dict):
            m = re.fullmatch(r"spellSlots\.([1-9])", str(o.get("target") or ""))
            if m:
                bonus[m.group(1)] = bonus.get(m.group(1), 0.0) + (_as_number(o.get("value")) or 0.0)
    return bonus


def lock_base_fields(incoming: dict, stored: dict) -> dict:
    """Copy the §2.1 base fields of an Aurora character from the stored record over ``incoming``.

    Slots: every stored ``spellcasting.slots[k]`` keeps its stored max (and other stored
    properties such as a pact slot's level); the incoming ``used`` is accepted, clamped to
    0..(stored max + active spellSlots.k overrides). Incoming slot keys that are not in the
    stored record are dropped, except a level created by an active ``spellSlots.k`` override
    (kept with max 0, the way applyOverrides() creates it, so used extra slots persist).
    """
    out = dict(incoming)
    for key in BASE_FIELDS:
        if key in stored:
            out[key] = copy.deepcopy(stored[key])
        else:
            out.pop(key, None)

    stored_hd = stored.get("hitDice") if isinstance(stored.get("hitDice"), dict) else None
    if stored_hd is not None or "hitDice" in out:
        hd = dict(out["hitDice"]) if isinstance(out.get("hitDice"), dict) else {}
        for key in ("total", "die"):
            if stored_hd and key in stored_hd:
                hd[key] = copy.deepcopy(stored_hd[key])
            else:
                hd.pop(key, None)
        out["hitDice"] = hd

    stored_sc = stored.get("spellcasting") if isinstance(stored.get("spellcasting"), dict) else None
    if stored_sc is not None or "spellcasting" in out:
        stored_sc = stored_sc or {}
        sc = dict(out["spellcasting"]) if isinstance(out.get("spellcasting"), dict) else {}
        if "ability" in stored_sc:
            sc["ability"] = copy.deepcopy(stored_sc["ability"])
        else:
            sc.pop("ability", None)
        stored_slots = stored_sc.get("slots") if isinstance(stored_sc.get("slots"), dict) else {}
        in_slots = sc.get("slots") if isinstance(sc.get("slots"), dict) else {}
        bonus = slot_bonus(out.get("overrides"))
        slots: dict[str, Any] = {}
        for key, s_slot in stored_slots.items():
            s_slot = s_slot if isinstance(s_slot, dict) else {}
            i_slot = in_slots.get(key) if isinstance(in_slots.get(key), dict) else {}
            base_max = _as_number(s_slot.get("max")) or 0.0
            limit = max(0, math.floor(base_max + bonus.get(key, 0.0)))
            merged = {**i_slot, **{k: copy.deepcopy(v) for k, v in s_slot.items() if k != "used"}}
            merged["max"] = copy.deepcopy(s_slot.get("max", 0))
            merged["used"] = _clamp_used(i_slot.get("used", s_slot.get("used", 0)), limit, s_slot.get("used", 0))
            slots[key] = merged
        for key, extra in bonus.items():
            if key in slots or not isinstance(in_slots.get(key), dict):
                continue
            merged = dict(in_slots[key])
            merged["max"] = 0
            merged["used"] = _clamp_used(merged.get("used", 0), max(0, math.floor(extra)))
            slots[key] = merged
        sc["slots"] = slots
        out["spellcasting"] = sc
    return out


def _keep_or_normalize_overrides(data: dict, stored: dict, user_id: str, now: int) -> None:
    if data.get("overrides") is not None:
        data["overrides"] = normalize_overrides(data["overrides"], user_id, now)
    else:
        data["overrides"] = stored.get("overrides") if isinstance(stored.get("overrides"), list) else []


def _xml_field(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ApiError(400, "xml must be a non-empty string")
    return value


def attachment_header(name: Any) -> str:
    base = re.sub(r'[\x00-\x1f\x7f"\\/:*?<>|]+', "_", str(name or "")).strip(" .")[:100] or "character"
    ascii_name = base.encode("ascii", "replace").decode("ascii").replace("?", "_")
    value = f'attachment; filename="{ascii_name}.dnd5e"'
    if ascii_name != base:
        value += f"; filename*=UTF-8''{quote(base + '.dnd5e', safe='')}"
    return value


# ================================================================================ notes: helpers
def note_out(row: dict, viewer_id: str) -> dict:
    try:
        tags = json.loads(row["tags"] or "[]")
    except ValueError:
        tags = []
    return {
        "id": row["id"], "owner_id": row["owner_id"], "owner_name": row["owner_name"],
        "campaign_id": row["campaign_id"], "characterId": row["character_id"],
        "title": row["title"], "folder": row["folder"], "body": row["body"],
        "tags": tags if isinstance(tags, list) else [], "shared": 1 if row["shared"] else 0,
        "can_edit": row["owner_id"] == viewer_id,
        "created": row["created"], "updated": row["updated"], "deleted": row["deleted"],
    }


def load_note(db: Database, note_id: str) -> dict | None:
    return db.one(NOTE_SELECT + " WHERE n.id = ?", (note_id,))


def note_for(db: Database, user: dict, note_id: str) -> tuple[dict, bool]:
    """(row, caller owns it); 404 when the caller cannot see it. Visible: my notes (trashed too),
    non-deleted notes in a campaign I DM, and the DM's shared notes in a campaign I belong to."""
    row = load_note(db, note_id)
    if row is None:
        raise ApiError(404, "Note not found")
    if row["owner_id"] == user["id"]:
        return row, True
    if row["deleted"] is None and row["campaign_id"]:
        role = db.campaign_role(user["id"], row["campaign_id"])
        if role == "dm":
            return row, False
        if role == "member" and row["shared"]:
            dm_id = db.value("SELECT dm_id FROM campaigns WHERE id = ?", (row["campaign_id"],))
            if row["owner_id"] == dm_id:
                return row, False
    raise ApiError(404, "Note not found")


def _text(value: Any, key: str) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return str(value)
    raise ApiError(400, f"{key} must be a string")


def _tags(value: Any) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ApiError(400, "tags must be an array of strings")
    out = []
    for tag in value:
        if isinstance(tag, str):
            out.append(tag)
        elif isinstance(tag, (int, float)) and not isinstance(tag, bool):
            out.append(str(tag))
        else:
            raise ApiError(400, "tags must be an array of strings")
    return out


def _optional_id(value: Any, key: str) -> str | None:
    if value is None or value == "":
        return None
    if not isinstance(value, str) or len(value) > 200:
        raise ApiError(400, f"{key} must be a string or null")
    return value


def note_fields(body: dict, creating: bool) -> dict:
    """Column values for title/folder/body/tags/character_id; on update only keys present in body."""
    out: dict[str, Any] = {}
    for key in ("title", "folder", "body"):
        if key in body:
            out[key] = _text(body[key], key)
        elif creating:
            out[key] = ""
    if "tags" in body:
        out["tags"] = _dump(_tags(body["tags"]))
    elif creating:
        out["tags"] = "[]"
    char_key = "characterId" if "characterId" in body else "character_id" if "character_id" in body else None
    if char_key:
        out["character_id"] = _optional_id(body[char_key], "characterId")
    elif creating:
        out["character_id"] = None
    return out


def campaign_choice(db: Database, user_id: str, value: Any) -> tuple[str | None, str | None]:
    """(campaign_id, my role in it) for a requested campaign_id; 400 unless I DM or belong to it."""
    if value is None or value == "":
        return None, None
    if not isinstance(value, str):
        raise ApiError(400, "campaign_id must be a string or null")
    role = db.campaign_role(user_id, value)
    if role is None:
        raise ApiError(400, "You can only use a campaign you run or belong to")
    return value, role


# ================================================================================ campaigns: helpers
def campaign_out(db: Database, camp: dict, viewer_id: str) -> dict:
    return {
        "id": camp["id"], "name": camp["name"], "dm_id": camp["dm_id"], "dm_name": camp["dm_name"],
        "invite_code": camp["invite_code"] if camp["dm_id"] == viewer_id else None,
        "members": db.campaign_members(camp["id"]), "created": camp["created"],
    }


def campaign_for(db: Database, user: dict, campaign_id: str) -> tuple[dict, str]:
    """(campaign, 'dm' | 'member'); 404 for campaigns the caller is not part of."""
    camp = db.campaign(campaign_id)
    role = db.campaign_role(user["id"], campaign_id) if camp else None
    if camp is None or role is None:
        raise ApiError(404, "Campaign not found")
    return camp, role


def require_dm(role: str) -> None:
    if role != "dm":
        raise ApiError(403, "Only the campaign's DM can do that")


def campaign_name(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ApiError(400, "Campaign name is required")
    value = value.strip()
    if len(value) > 100:
        raise ApiError(400, "Campaign name must be at most 100 characters")
    return value


def new_invite_code(db: Database) -> str:
    for _ in range(50):
        code = "".join(secrets.choice(INVITE_ALPHABET) for _ in range(8))
        if db.value("SELECT 1 FROM campaigns WHERE invite_code = ?", (code,)) is None:
            return code
    raise RuntimeError("could not generate a unique invite code")


def detach_from_campaign(db: Database, campaign_id: str, owner_id: str | None, now: int) -> None:
    """Clear campaign_id (and the note share flag) on records in a campaign, all or one owner's."""
    owner_sql, params = (" AND owner_id = ?", (owner_id,)) if owner_id else ("", ())
    db.execute(f"UPDATE characters SET campaign_id = NULL, updated = ? WHERE campaign_id = ?{owner_sql}",
               (now, campaign_id, *params))
    db.execute(f"UPDATE notes SET campaign_id = NULL, shared = 0, updated = ? WHERE campaign_id = ?{owner_sql}",
               (now, campaign_id, *params))


def purge_expired(db: Database, settings: Settings, now: int) -> None:
    """Hard-delete characters and notes that have been in the trash for more than 30 days."""
    cutoff = now - PURGE_AFTER_MS
    old = [r["id"] for r in db.query("SELECT id FROM characters WHERE deleted IS NOT NULL AND deleted < ?", (cutoff,))]
    if not old and db.value("SELECT 1 FROM notes WHERE deleted IS NOT NULL AND deleted < ? LIMIT 1", (cutoff,)) is None:
        return  # bootstrap is polled every 20 s; skip the write transaction when nothing is due
    with db.tx():
        for cid in old:
            db.execute("DELETE FROM characters WHERE id = ?", (cid,))
            db.execute("UPDATE notes SET character_id = NULL, updated = ? WHERE character_id = ?", (now, cid))
        db.execute("DELETE FROM notes WHERE deleted IS NOT NULL AND deleted < ?", (cutoff,))
    for cid in old:
        remove_aurora(settings, cid)


# ================================================================================ routes
router = APIRouter()


# ---------------------------------------------------------------------- auth
def _signed_in(request: Request, user: dict, status: int) -> JSONResponse:
    db, settings = _db(request), _settings(request)
    auth.end_session(db, request.cookies.get(auth.COOKIE_NAME))  # replace this browser's old session
    token = auth.create_session(db, user["id"], settings.session_days)
    response = JSONResponse({"user": user}, status_code=status)
    auth.set_session_cookie(response, token, settings.session_days, auth.cookie_secure(request, settings.cookie_secure))
    return response


@router.post("/api/auth/signup")
async def signup(request: Request):
    db, settings = _db(request), _settings(request)
    if not settings.allow_signup:
        raise ApiError(403, "Sign-up is disabled on this server")
    body = await read_object(request)
    username = auth.valid_username(body.get("username"))
    if username is None:
        raise ApiError(400, "Username must be 3-32 characters: letters, digits, dots, dashes or underscores")
    problem = auth.password_problem(body.get("password"))
    if problem:
        raise ApiError(400, problem)
    if db.user_by_name(username):
        raise ApiError(409, "That username is taken")
    password_hash = await run_in_threadpool(auth.hash_password, body["password"])
    user = {"id": new_id(), "username": username}
    try:
        db.execute("INSERT INTO users (id, username, password_hash, created) VALUES (?, ?, ?, ?)",
                   (user["id"], username, password_hash, now_ms()))
    except sqlite3.IntegrityError:
        raise ApiError(409, "That username is taken") from None
    return _signed_in(request, user, 201)


@router.post("/api/auth/login")
async def login(request: Request):
    db = _db(request)
    body = await read_object(request)
    username, password = body.get("username"), body.get("password")
    if not isinstance(username, str) or not isinstance(password, str) or not username.strip() or not password:
        raise ApiError(400, "Username and password are required")
    key = auth.lock_key(username)
    remaining = auth.lock_remaining_ms(db, key)
    if remaining:
        raise ApiError(429, "Too many failed sign-in attempts. Try again in a minute.",
                       headers={"Retry-After": str(max(1, math.ceil(remaining / 1000)))})
    row = db.user_by_name(username.strip()) if len(username) <= 64 else None
    ok = False
    if row is not None and len(password) <= auth.MAX_PASSWORD:
        ok = await run_in_threadpool(auth.verify_password, password, row["password_hash"])
    elif len(password) <= auth.MAX_PASSWORD:
        await run_in_threadpool(auth.burn_time, password)
    if not ok:
        auth.record_failure(db, key)
        raise ApiError(401, "Wrong username or password")
    auth.clear_failures(db, key)
    return _signed_in(request, {"id": row["id"], "username": row["username"]}, 200)


@router.post("/api/auth/logout")
async def logout(request: Request):
    auth.end_session(_db(request), request.cookies.get(auth.COOKIE_NAME))
    response = _no_content()
    auth.clear_session_cookie(response, auth.cookie_secure(request, _settings(request).cookie_secure))
    return response


@router.get("/api/auth/me")
async def me(request: Request):
    return {"user": current_user(request)}


@router.put("/api/auth/password")
async def change_password(request: Request):
    db = _db(request)
    user = current_user(request)
    body = await read_object(request)
    current, new = body.get("current"), body.get("new")
    if not isinstance(current, str):
        raise ApiError(400, "Current password is required")
    problem = auth.password_problem(new)
    if problem:
        raise ApiError(400, problem)
    stored = db.value("SELECT password_hash FROM users WHERE id = ?", (user["id"],))
    # 403 rather than 401: the session is fine, and 401 would send the client to the sign-in screen.
    if len(current) > auth.MAX_PASSWORD or not await run_in_threadpool(auth.verify_password, current, stored):
        raise ApiError(403, "Current password is incorrect")
    new_hash = await run_in_threadpool(auth.hash_password, new)
    with db.tx():
        db.execute("UPDATE users SET password_hash = ? WHERE id = ?", (new_hash, user["id"]))
        auth.end_other_sessions(db, user["id"], request.cookies.get(auth.COOKIE_NAME))
    return _no_content()


# ---------------------------------------------------------------------- bootstrap
@router.get("/api/bootstrap")
async def bootstrap(request: Request):
    db, settings = _db(request), _settings(request)
    user = current_user(request)
    uid, now = user["id"], now_ms()
    purge_expired(db, settings, now)
    dm_ids, _member_ids = db.campaign_ids(uid)
    params = {"uid": uid}

    campaigns = [campaign_out(db, c, uid) for c in db.query(
        "SELECT c.*, u.username AS dm_name FROM campaigns c JOIN users u ON u.id = c.dm_id "
        "WHERE c.dm_id = :uid OR c.id IN (SELECT campaign_id FROM campaign_members WHERE user_id = :uid) "
        "ORDER BY c.created, c.id", params)]

    characters = [character_out(r, uid, r["campaign_id"] in dm_ids, settings) for r in db.query(
        CHAR_SELECT + " WHERE c.owner_id = :uid OR (c.deleted IS NULL AND c.campaign_id IN ("
        "SELECT id FROM campaigns WHERE dm_id = :uid "
        "UNION SELECT campaign_id FROM campaign_members WHERE user_id = :uid)) "
        "ORDER BY c.created, c.id", params)]

    notes = [note_out(r, uid) for r in db.query(
        NOTE_SELECT + " WHERE n.owner_id = :uid"
        " OR (n.deleted IS NULL AND n.campaign_id IN (SELECT id FROM campaigns WHERE dm_id = :uid))"
        " OR (n.deleted IS NULL AND n.shared = 1 AND EXISTS ("
        "SELECT 1 FROM campaigns c JOIN campaign_members m ON m.campaign_id = c.id "
        "WHERE c.id = n.campaign_id AND m.user_id = :uid AND c.dm_id = n.owner_id)) "
        "ORDER BY n.created, n.id", params)]

    return JSONResponse({"user": user, "campaigns": campaigns, "characters": characters,
                         "notes": notes, "serverTime": now})


# ---------------------------------------------------------------------- characters
@router.post("/api/characters")
async def create_character(request: Request):
    db, settings = _db(request), _settings(request)
    user = current_user(request)
    body = await read_object(request)
    xml = _xml_field(body["xml"]) if body.get("xml") is not None else None
    now = now_ms()
    data = character_data(body)
    data["overrides"] = normalize_overrides(data.get("overrides") if data.get("overrides") is not None else [],
                                            user["id"], now)
    cid = new_id()
    if xml is not None:
        write_aurora(settings, cid, xml)
    try:
        db.execute(
            "INSERT INTO characters (id, owner_id, campaign_id, source, data, created, updated, deleted) "
            "VALUES (?, ?, NULL, ?, ?, ?, ?, NULL)",
            (cid, user["id"], "aurora" if xml is not None else "manual", _dump(data), now, now))
    except Exception:
        if xml is not None:
            remove_aurora(settings, cid)
        raise
    return JSONResponse(character_out(load_character(db, cid), user["id"], False, settings), status_code=201)


@router.put("/api/characters/{cid}")
async def update_character(cid: str, request: Request):
    db, settings = _db(request), _settings(request)
    user = current_user(request)
    body = await read_object(request)
    row, owner, is_dm = character_for(db, user, cid)
    if not owner:
        raise ApiError(403, "Only the owner can edit this character")
    stored, now = _load_obj(row["data"]), now_ms()
    data = character_data(body)
    _keep_or_normalize_overrides(data, stored, user["id"], now)
    if row["source"] == "aurora":
        data = lock_base_fields(data, stored)
    db.execute("UPDATE characters SET data = ?, updated = ? WHERE id = ?", (_dump(data), now, cid))
    return character_out(load_character(db, cid), user["id"], is_dm, settings)


@router.put("/api/characters/{cid}/aurora")
async def reimport_character(cid: str, request: Request):
    db, settings = _db(request), _settings(request)
    user = current_user(request)
    body = await read_object(request)
    row, owner, is_dm = character_for(db, user, cid)
    if not owner:
        raise ApiError(403, "Only the owner can re-import this character")
    if not isinstance(body.get("data"), dict):
        raise ApiError(400, "data must be a character object")
    xml = _xml_field(body.get("xml"))
    now = now_ms()
    data = character_data(body["data"])
    _keep_or_normalize_overrides(data, _load_obj(row["data"]), user["id"], now)
    write_aurora(settings, cid, xml)
    db.execute("UPDATE characters SET source = 'aurora', data = ?, updated = ? WHERE id = ?", (_dump(data), now, cid))
    return character_out(load_character(db, cid), user["id"], is_dm, settings)


@router.put("/api/characters/{cid}/overrides")
async def set_overrides(cid: str, request: Request):
    db, settings = _db(request), _settings(request)
    user = current_user(request)
    body = await read_object(request)
    row, owner, is_dm = character_for(db, user, cid)
    if not (owner or is_dm):
        raise ApiError(403, "Only the owner or the campaign's DM can change overrides")
    if "overrides" not in body:
        raise ApiError(400, "overrides is required")
    now = now_ms()
    data = _load_obj(row["data"])
    data["overrides"] = normalize_overrides(body["overrides"], user["id"], now)
    db.execute("UPDATE characters SET data = ?, updated = ? WHERE id = ?", (_dump(data), now, cid))
    return character_out(load_character(db, cid), user["id"], is_dm, settings)


@router.put("/api/characters/{cid}/campaign")
async def assign_campaign(cid: str, request: Request):
    db, settings = _db(request), _settings(request)
    user = current_user(request)
    body = await read_object(request)
    row, owner, _ = character_for(db, user, cid)
    if not owner:
        raise ApiError(403, "Only the owner can move this character between campaigns")
    if "campaign_id" not in body:
        raise ApiError(400, "campaign_id is required (null to leave the campaign)")
    campaign_id, role = campaign_choice(db, user["id"], body["campaign_id"])
    db.execute("UPDATE characters SET campaign_id = ?, updated = ? WHERE id = ?", (campaign_id, now_ms(), cid))
    return character_out(load_character(db, cid), user["id"], role == "dm", settings)


@router.delete("/api/characters/{cid}")
async def delete_character(cid: str, request: Request):
    db = _db(request)
    user = current_user(request)
    _, owner, _ = character_for(db, user, cid)
    if not owner:
        raise ApiError(403, "Only the owner can delete this character")
    now = now_ms()
    db.execute("UPDATE characters SET deleted = ?, updated = ? WHERE id = ? AND deleted IS NULL", (now, now, cid))
    return _no_content()


@router.post("/api/characters/{cid}/restore")
async def restore_character(cid: str, request: Request):
    db, settings = _db(request), _settings(request)
    user = current_user(request)
    _, owner, is_dm = character_for(db, user, cid)
    if not owner:
        raise ApiError(403, "Only the owner can restore this character")
    db.execute("UPDATE characters SET deleted = NULL, updated = ? WHERE id = ?", (now_ms(), cid))
    return character_out(load_character(db, cid), user["id"], is_dm, settings)


@router.delete("/api/characters/{cid}/purge")
async def purge_character(cid: str, request: Request):
    db, settings = _db(request), _settings(request)
    user = current_user(request)
    _, owner, _ = character_for(db, user, cid)
    if not owner:
        raise ApiError(403, "Only the owner can delete this character")
    with db.tx():
        db.execute("DELETE FROM characters WHERE id = ?", (cid,))
        db.execute("UPDATE notes SET character_id = NULL, updated = ? WHERE character_id = ?", (now_ms(), cid))
    remove_aurora(settings, cid)
    return _no_content()


@router.get("/api/characters/{cid}/aurora.dnd5e")
async def download_aurora(cid: str, request: Request):
    db, settings = _db(request), _settings(request)
    user = current_user(request)
    row, owner, is_dm = character_for(db, user, cid)
    if not (owner or is_dm):
        raise ApiError(403, "Only the owner or the campaign's DM can download this file")
    path = aurora_path(settings, cid)
    if not path.is_file():
        raise ApiError(404, "This character has no Aurora file")
    data = _load_obj(row["data"])

    def build() -> bytes:
        # surrogateescape keeps any byte the file holds, so untouched regions round-trip exactly.
        xml = path.read_bytes().decode("utf-8", "surrogateescape")
        return patch_aurora(xml, data).encode("utf-8", "surrogateescape")

    content = await run_in_threadpool(build)
    return Response(content, media_type="application/octet-stream",
                    headers={"Content-Disposition": attachment_header(data.get("name"))})


# ---------------------------------------------------------------------- notes
@router.post("/api/notes")
async def create_note(request: Request):
    db = _db(request)
    user = current_user(request)
    body = await read_object(request)
    fields = note_fields(body, creating=True)
    campaign_id, role = campaign_choice(db, user["id"], body.get("campaign_id"))
    shared = 1 if _truthy(body.get("shared")) and role == "dm" else 0
    nid, now = new_id(), now_ms()
    db.execute(
        "INSERT INTO notes (id, owner_id, campaign_id, character_id, title, folder, body, tags, shared, created, updated, deleted) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
        (nid, user["id"], campaign_id, fields["character_id"], fields["title"], fields["folder"], fields["body"],
         fields["tags"], shared, now, now))
    return JSONResponse(note_out(load_note(db, nid), user["id"]), status_code=201)


@router.put("/api/notes/{nid}")
async def update_note(nid: str, request: Request):
    db = _db(request)
    user = current_user(request)
    body = await read_object(request)
    row, owner = note_for(db, user, nid)
    if not owner:
        raise ApiError(403, "Only the owner can edit this note")
    fields = note_fields(body, creating=False)
    if "campaign_id" in body:
        campaign_id, role = campaign_choice(db, user["id"], body["campaign_id"])
    else:
        campaign_id = row["campaign_id"]
        role = db.campaign_role(user["id"], campaign_id)
    requested = body["shared"] if "shared" in body else row["shared"]
    fields.update(campaign_id=campaign_id, shared=1 if _truthy(requested) and role == "dm" else 0, updated=now_ms())
    assignments = ", ".join(f"{column} = ?" for column in fields)  # column names are fixed keys
    db.execute(f"UPDATE notes SET {assignments} WHERE id = ?", (*fields.values(), nid))
    return note_out(load_note(db, nid), user["id"])


@router.delete("/api/notes/{nid}")
async def delete_note(nid: str, request: Request):
    db = _db(request)
    user = current_user(request)
    _, owner = note_for(db, user, nid)
    if not owner:
        raise ApiError(403, "Only the owner can delete this note")
    now = now_ms()
    db.execute("UPDATE notes SET deleted = ?, updated = ? WHERE id = ? AND deleted IS NULL", (now, now, nid))
    return _no_content()


@router.post("/api/notes/{nid}/restore")
async def restore_note(nid: str, request: Request):
    db = _db(request)
    user = current_user(request)
    _, owner = note_for(db, user, nid)
    if not owner:
        raise ApiError(403, "Only the owner can restore this note")
    db.execute("UPDATE notes SET deleted = NULL, updated = ? WHERE id = ?", (now_ms(), nid))
    return note_out(load_note(db, nid), user["id"])


@router.delete("/api/notes/{nid}/purge")
async def purge_note(nid: str, request: Request):
    db = _db(request)
    user = current_user(request)
    _, owner = note_for(db, user, nid)
    if not owner:
        raise ApiError(403, "Only the owner can delete this note")
    db.execute("DELETE FROM notes WHERE id = ?", (nid,))
    return _no_content()


# ---------------------------------------------------------------------- campaigns
@router.post("/api/campaigns")
async def create_campaign(request: Request):
    db = _db(request)
    user = current_user(request)
    body = await read_object(request)
    name = campaign_name(body.get("name"))
    camp_id = new_id()
    db.execute("INSERT INTO campaigns (id, name, dm_id, invite_code, created) VALUES (?, ?, ?, ?, ?)",
               (camp_id, name, user["id"], new_invite_code(db), now_ms()))
    return JSONResponse(campaign_out(db, db.campaign(camp_id), user["id"]), status_code=201)


@router.post("/api/campaigns/join")
async def join_campaign(request: Request):
    db = _db(request)
    user = current_user(request)
    body = await read_object(request)
    code = body.get("code")
    if not isinstance(code, str) or not code.strip():
        raise ApiError(400, "Invite code is required")
    code = re.sub(r"[\s-]+", "", code).upper()
    camp = db.one("SELECT c.*, u.username AS dm_name FROM campaigns c JOIN users u ON u.id = c.dm_id "
                  "WHERE c.invite_code = ?", (code,))
    if camp is None:
        raise ApiError(404, "No campaign has that invite code")
    if camp["dm_id"] == user["id"]:
        raise ApiError(400, "You are the DM of this campaign")
    db.execute("INSERT OR IGNORE INTO campaign_members (campaign_id, user_id, joined) VALUES (?, ?, ?)",
               (camp["id"], user["id"], now_ms()))
    return campaign_out(db, camp, user["id"])


@router.put("/api/campaigns/{camp_id}")
async def rename_campaign(camp_id: str, request: Request):
    db = _db(request)
    user = current_user(request)
    body = await read_object(request)
    _, role = campaign_for(db, user, camp_id)
    require_dm(role)
    db.execute("UPDATE campaigns SET name = ? WHERE id = ?", (campaign_name(body.get("name")), camp_id))
    return campaign_out(db, db.campaign(camp_id), user["id"])


@router.post("/api/campaigns/{camp_id}/invite/rotate")
async def rotate_invite(camp_id: str, request: Request):
    db = _db(request)
    user = current_user(request)
    _, role = campaign_for(db, user, camp_id)
    require_dm(role)
    db.execute("UPDATE campaigns SET invite_code = ? WHERE id = ?", (new_invite_code(db), camp_id))
    return campaign_out(db, db.campaign(camp_id), user["id"])


@router.post("/api/campaigns/{camp_id}/leave")
async def leave_campaign(camp_id: str, request: Request):
    db = _db(request)
    user = current_user(request)
    _, role = campaign_for(db, user, camp_id)
    if role == "dm":
        raise ApiError(400, "The DM cannot leave their own campaign; delete it instead")
    with db.tx():
        detach_from_campaign(db, camp_id, user["id"], now_ms())
        db.execute("DELETE FROM campaign_members WHERE campaign_id = ? AND user_id = ?", (camp_id, user["id"]))
    return _no_content()


@router.post("/api/campaigns/{camp_id}/members/{member_id}/remove")
async def remove_member(camp_id: str, member_id: str, request: Request):
    db = _db(request)
    user = current_user(request)
    _, role = campaign_for(db, user, camp_id)
    require_dm(role)
    if db.value("SELECT 1 FROM campaign_members WHERE campaign_id = ? AND user_id = ?", (camp_id, member_id)) is None:
        raise ApiError(404, "That user is not a member of this campaign")
    with db.tx():
        detach_from_campaign(db, camp_id, member_id, now_ms())
        db.execute("DELETE FROM campaign_members WHERE campaign_id = ? AND user_id = ?", (camp_id, member_id))
    return _no_content()


@router.delete("/api/campaigns/{camp_id}")
async def delete_campaign(camp_id: str, request: Request):
    db = _db(request)
    user = current_user(request)
    _, role = campaign_for(db, user, camp_id)
    require_dm(role)
    with db.tx():
        detach_from_campaign(db, camp_id, None, now_ms())
        db.execute("DELETE FROM campaign_members WHERE campaign_id = ?", (camp_id,))
        db.execute("DELETE FROM campaigns WHERE id = ?", (camp_id,))
    return _no_content()


# ---------------------------------------------------------------------- misc
@router.get("/api/health")
async def health():
    return {"ok": True}




# ================================================================================ app assembly
class ApiGuard:
    """Pure ASGI middleware for /api: CSRF header on mutating methods, and no-store caching."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        path = scope.get("path", "") if scope["type"] == "http" else ""
        if not (path == "/api" or path.startswith("/api/")):
            await self.app(scope, receive, send)
            return
        if scope["method"] not in ("GET", "HEAD", "OPTIONS"):
            value = next((v for k, v in scope["headers"] if k == b"x-requested-with"), b"")
            if value.strip() != CSRF_VALUE:
                response = JSONResponse({"error": "Missing or invalid X-Requested-With header"}, status_code=403,
                                        headers={"Cache-Control": "no-store"})
                await response(scope, receive, send)
                return

        async def send_no_store(message):
            if message["type"] == "http.response.start":
                MutableHeaders(scope=message).setdefault("Cache-Control", "no-store")
            await send(message)

        await self.app(scope, receive, send_no_store)


def _is_api(request: Request) -> bool:
    return request.url.path == "/api" or request.url.path.startswith("/api/")


async def _api_error(request: Request, exc: ApiError):
    return JSONResponse({"error": exc.message}, status_code=exc.status, headers=exc.headers)


async def _http_error(request: Request, exc: StarletteHTTPException):
    headers = getattr(exc, "headers", None)
    if exc.status_code in (204, 304):
        return Response(status_code=exc.status_code, headers=headers)
    if _is_api(request):
        return JSONResponse({"error": str(exc.detail)}, status_code=exc.status_code, headers=headers)
    return PlainTextResponse(str(exc.detail), status_code=exc.status_code, headers=headers)


# ---------------------------------------------------------------- Aurora content (element descriptions)
# Any signed-in user may upload descriptions parsed (client-side) from Aurora Builder's content XML files.
# The table is shared by everyone on the instance: the content is the same for the whole table.
import json as _json

MAX_ELEMENTS_PER_UPLOAD = 2000


def _element_in(raw: Any) -> dict | None:
    if not isinstance(raw, dict):
        return None
    eid = str(raw.get("id") or "").strip()
    name = str(raw.get("name") or "").strip()
    etype = str(raw.get("type") or "").strip()
    if not eid or not name or len(eid) > 200 or len(name) > 300:
        return None
    sheet_raw = raw.get("sheet") if isinstance(raw.get("sheet"), list) else []
    sheet = []
    for s in sheet_raw[:20]:
        if isinstance(s, dict) and str(s.get("text") or "").strip():
            try:
                level = int(s.get("level") or 0)
            except (TypeError, ValueError):
                level = 0
            sheet.append({"level": level, "text": str(s.get("text"))[:4000]})
    meta_raw = raw.get("meta") if isinstance(raw.get("meta"), dict) else {}
    meta = {str(k)[:60]: str(v)[:500] for k, v in list(meta_raw.items())[:40]}
    return {
        "id": eid, "name": name, "type": etype[:60], "source": str(raw.get("source") or "")[:200],
        "sheet": sheet, "desc": str(raw.get("desc") or "")[:20000],
        "usage": str(raw.get("usage") or "")[:60], "action": str(raw.get("action") or "")[:40], "meta": meta,
    }


def element_out(row: dict) -> dict:
    def _loads(text: str | None, default: Any) -> Any:
        try:
            return _json.loads(text) if text else default
        except ValueError:
            return default
    return {
        "id": row["id"], "name": row["name"], "type": row["type"], "source": row.get("source") or "",
        "sheet": _loads(row.get("sheet"), []), "desc": row.get("desc") or "", "usage": row.get("usage") or "",
        "action": row.get("action") or "", "meta": _loads(row.get("meta"), {}), "updated": row.get("updated"),
    }


@router.put("/api/aurora/elements")
async def upsert_elements(request: Request):
    db = _db(request)
    current_user(request)
    body = await read_object(request)
    items = body.get("elements")
    if not isinstance(items, list):
        raise ApiError(400, "elements must be a list")
    if len(items) > MAX_ELEMENTS_PER_UPLOAD:
        raise ApiError(400, f"Send at most {MAX_ELEMENTS_PER_UPLOAD} elements per request")
    now = now_ms()
    stored = 0
    with db.tx():
        for raw in items:
            e = _element_in(raw)
            if not e:
                continue
            db.execute(
                "INSERT INTO aurora_elements (id, name, type, source, sheet, desc, usage, action, meta, updated) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, type = excluded.type, "
                "source = excluded.source, sheet = excluded.sheet, desc = excluded.desc, usage = excluded.usage, "
                "action = excluded.action, meta = excluded.meta, updated = excluded.updated",
                (e["id"], e["name"], e["type"], e["source"], _dump(e["sheet"]), e["desc"], e["usage"], e["action"], _dump(e["meta"]), now),
            )
            stored += 1
    return {"stored": stored, "total": db.value("SELECT COUNT(*) FROM aurora_elements")}


@router.post("/api/aurora/elements/lookup")
async def lookup_elements(request: Request):
    db = _db(request)
    current_user(request)
    body = await read_object(request)
    ids = [x for x in (body.get("ids") or []) if isinstance(x, str) and x][:2000] if isinstance(body.get("ids"), list) else []
    names = [x for x in (body.get("names") or []) if isinstance(x, str) and x.strip()][:200] if isinstance(body.get("names"), list) else []
    etype = str(body.get("type") or "").strip()
    elements: dict[str, dict] = {}
    for start in range(0, len(ids), 500):
        chunk = ids[start:start + 500]
        marks = ",".join("?" for _ in chunk)
        for row in db.query(f"SELECT * FROM aurora_elements WHERE id IN ({marks})", chunk):
            elements[row["id"]] = element_out(row)
    by_name: dict[str, dict] = {}
    for n in names:
        if etype:
            row = db.one("SELECT * FROM aurora_elements WHERE name = ? COLLATE NOCASE AND type = ? ORDER BY updated DESC LIMIT 1", (n.strip(), etype))
        else:
            row = db.one("SELECT * FROM aurora_elements WHERE name = ? COLLATE NOCASE ORDER BY updated DESC LIMIT 1", (n.strip(),))
        if row:
            by_name[n] = element_out(row)
    return {"elements": elements, "byName": by_name}


@router.get("/api/aurora/elements/stats")
async def element_stats(request: Request):
    db = _db(request)
    current_user(request)
    return {
        "count": db.value("SELECT COUNT(*) FROM aurora_elements") or 0,
        "sources": db.value("SELECT COUNT(DISTINCT source) FROM aurora_elements") or 0,
        "updated": db.value("SELECT MAX(updated) FROM aurora_elements"),
    }


# Catch-all for unknown /api paths. It must stay the LAST route on the router.
@router.api_route("/api/{rest:path}", methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
async def api_not_found(rest: str):
    raise ApiError(404, "Not found")


async def _validation_error(request: Request, exc: RequestValidationError):
    return JSONResponse({"error": "Invalid request"}, status_code=400)


async def _server_error(request: Request, exc: Exception):
    return JSONResponse({"error": "Internal server error"}, status_code=500)


def create_app(data_dir=None, *, web_dir=None, session_days=None, allow_signup=None, cookie_secure=None) -> FastAPI:
    """Build the app. Arguments override the environment (DATA_DIR, SESSION_DAYS, ALLOW_SIGNUP, COOKIE_SECURE)."""
    settings = load_settings(data_dir, web_dir=web_dir, session_days=session_days,
                             allow_signup=allow_signup, cookie_secure=cookie_secure)
    settings.aurora_dir.mkdir(parents=True, exist_ok=True)
    db = Database(settings.db_path)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        yield
        db.close()

    app = FastAPI(title="Tome & Table", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    app.state.settings = settings
    app.state.db = db
    app.add_middleware(ApiGuard)
    app.add_exception_handler(ApiError, _api_error)
    app.add_exception_handler(StarletteHTTPException, _http_error)
    app.add_exception_handler(RequestValidationError, _validation_error)
    app.add_exception_handler(Exception, _server_error)
    app.include_router(router)
    if settings.web_dir.is_dir():
        app.mount("/", StaticFiles(directory=settings.web_dir, html=True), name="web")
    return app


app = create_app()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=os.environ.get("HOST", "0.0.0.0"), port=int(os.environ.get("PORT", "8787")))
