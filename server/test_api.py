"""API tests for the Tome & Table server (spec §8), using FastAPI's TestClient and a throw-away DATA_DIR.

Run from the repo root:   py -m server.test_api        (or)   py server\\test_api.py
Prints every failed check and a final "N passed, M failed" line; exits 1 on any failure.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import sys
import tempfile
import traceback
import warnings
import xml.etree.ElementTree as ET
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

TMP = Path(tempfile.mkdtemp(prefix="tome-test-"))
# The module-level app in server.app is built on import: point it at the temp dir too.
os.environ["DATA_DIR"] = str(TMP / "module-app")
for _name in ("ALLOW_SIGNUP", "COOKIE_SECURE", "SESSION_DAYS"):
    os.environ.pop(_name, None)
# Newer Starlette warns that its TestClient is moving from httpx to httpx2; irrelevant here.
warnings.filterwarnings("ignore", message=r".*httpx.*")

from fastapi.testclient import TestClient  # noqa: E402

from server import app as app_module  # noqa: E402
from server.app import create_app  # noqa: E402
from server.aurora_patch import patch_aurora, split_cdata  # noqa: E402

CSRF = {"X-Requested-With": "TomeAndTable"}
PASSWORD = "correct horse battery"
DAY_MS = 86_400_000

# ---------------------------------------------------------------------------------------- harness
PASSED = 0
FAILED: list[str] = []
_current = [""]


def check(cond: bool, label: str, detail: object = None) -> bool:
    global PASSED
    if cond:
        PASSED += 1
    else:
        FAILED.append(f"[{_current[0]}] {label}" + ("" if detail is None else f"  -> {detail}"))
    return bool(cond)


def eq(actual, expected, label: str) -> bool:
    return check(actual == expected, label, f"expected {expected!r}, got {actual!r}")


def status(resp, code: int, label: str) -> bool:
    return check(resp.status_code == code, f"{label} -> HTTP {code}", f"got {resp.status_code}: {resp.text[:300]}")


def is_error(resp, code: int, label: str) -> bool:
    ok = status(resp, code, label)
    try:
        body = resp.json()
    except ValueError:
        body = None
    return check(isinstance(body, dict) and isinstance(body.get("error"), str) and body["error"],
                 f'{label}: body is {{"error": "..."}}', resp.text[:200]) and ok


TESTS = []


def test(fn):
    TESTS.append(fn)
    return fn


class Env:
    """One app instance with its own DATA_DIR."""
    apps: list = []

    def __init__(self, name: str, **settings):
        self.dir = TMP / name
        self.app = create_app(self.dir, **settings)
        self.db = self.app.state.db
        Env.apps.append(self.app)
        self._n = 0

    def client(self, csrf: bool = True) -> TestClient:
        return TestClient(self.app, headers=CSRF if csrf else None)

    def username(self, prefix: str) -> str:
        self._n += 1
        return f"{prefix}{self._n}"

    def user(self, prefix: str = "user"):
        """A signed-in client plus its user dict."""
        c = self.client()
        r = c.post("/api/auth/signup", json={"username": self.username(prefix), "password": PASSWORD})
        assert r.status_code == 201, r.text
        return c, r.json()["user"]


MAIN = Env("main")


def boot(c: TestClient) -> dict:
    r = c.get("/api/bootstrap")
    assert r.status_code == 200, r.text
    return r.json()


def by_id(items: list, item_id: str):
    return next((x for x in items if x["id"] == item_id), None)


def new_char(c: TestClient, name="Hero", xml=None, **extra) -> dict:
    body = {
        "name": name, "race": "Elf", "classes": [{"name": "Wizard", "level": 3, "subclass": ""}],
        "background": "Sage", "alignment": "NG", "xp": 900,
        "abilities": {"str": 8, "dex": 14, "con": 13, "int": 16, "wis": 12, "cha": 10},
        "saveProf": {"int": True, "wis": True}, "skillProf": {"arcana": 1}, "hp": {"current": 14, "max": 14, "temp": 0},
        "hitDice": {"total": 3, "used": 0, "die": 6}, "conditions": [], "exhaustion": 0,
        "spellcasting": {"ability": "int", "slots": {"1": {"max": 4, "used": 0}, "2": {"max": 2, "used": 0}}, "spells": []},
        "coins": {"cp": 0, "sp": 0, "ep": 0, "gp": 10, "pp": 0},
        "bio": {"appearance": "", "backstory": "", "allies": "", "traits": "", "ideals": "", "bonds": "", "flaws": ""},
    }
    body.update(extra)
    if xml is not None:
        body["xml"] = xml
    r = c.post("/api/characters", json=body)
    assert r.status_code == 201, r.text
    return r.json()


def new_note(c: TestClient, title="Note", **extra) -> dict:
    r = c.post("/api/notes", json={"title": title, "folder": "", "body": f"# {title}", "tags": [], **extra})
    assert r.status_code == 201, r.text
    return r.json()


# Synthetic Aurora file in the real layout: BOM, CRLF, decoys in comments/CDATA/display-properties,
# a self-closing <background-bonds />, and no <background-flaws> at all.
SYNTH_XML = "﻿" + "\r\n".join([
    '<?xml version="1.0" encoding="utf-8"?>',
    '<character version="1.0.3" preview="false">',
    "\t<!-- Aurora - https://www.aurorabuilder.com -->",
    "\t<!-- decoy: <build><input><name>Comment</name><experience>1</experience></input></build> -->",
    '\t<display-properties favorite="false">',
    "\t\t<name>Testa</name>",
    "\t\t<portrait>",
    "\t\t\t<base64><![CDATA[iVBORw0KGgo</name><experience>2</experience>AAAA]]></base64>",
    "\t\t</portrait>",
    "\t</display-properties>",
    "\t<build>",
    "\t\t<input>",
    "\t\t\t<name>Testa</name>",
    "\t\t\t<gender>Female</gender>",
    "\t\t\t<experience>300</experience>",
    "\t\t\t<attacks>",
    "\t\t\t\t<description><![CDATA[]]></description>",
    "\t\t\t</attacks>",
    "\t\t\t<backstory><![CDATA[Old story that quotes </input> and <name>Fake</name>.]]></backstory>",
    "\t\t\t<background-trinket>",
    "\t\t\t</background-trinket>",
    "\t\t\t<background-traits>",
    "\t\t\t</background-traits>",
    "\t\t\t<background-ideals>",
    "\t\t\t</background-ideals>",
    "\t\t\t<background-bonds />",
    "\t\t\t<organization>",
    "\t\t\t\t<name>",
    "\t\t\t\t</name>",
    "\t\t\t\t<allies><![CDATA[]]></allies>",
    "\t\t\t</organization>",
    "\t\t\t<currency>",
    "\t\t\t\t<copper>1</copper>",
    "\t\t\t\t<silver>2</silver>",
    "\t\t\t\t<electrum>3</electrum>",
    "\t\t\t\t<gold>4</gold>",
    "\t\t\t\t<platinum>5</platinum>",
    "\t\t\t\t<equipment><![CDATA[50 ft. rope]]></equipment>",
    "\t\t\t</currency>",
    "\t\t\t<notes>",
    '\t\t\t\t<note column="left">',
    "\t\t\t\t</note>",
    '\t\t\t\t<note column="right">Keep this &amp; that</note>',
    "\t\t\t</notes>",
    "\t\t</input>",
    "\t\t<abilities available-points=\"0\">",
    "\t\t\t<strength>8</strength>",
    "\t\t</abilities>",
    "\t\t<equipment>",
    '\t\t\t<item identifier="x" name="Rope" id="ID_ROPE">',
    "\t\t\t\t<details card=\"false\">",
    "\t\t\t\t\t<name>Rope</name>",
    "\t\t\t\t\t<notes>coiled</notes>",
    "\t\t\t\t</details>",
    "\t\t\t</item>",
    "\t\t</equipment>",
    "\t</build>",
    "</character>",
    "",
])


# ---------------------------------------------------------------------------------------- tests
@test
def health_and_static():
    c = MAIN.client()
    r = c.get("/api/health")
    status(r, 200, "GET /api/health")
    eq(r.json(), {"ok": True}, "health body")
    eq(r.headers.get("cache-control"), "no-store", "/api responses are not cacheable")
    r = c.get("/")
    status(r, 200, "GET /")
    check(r.headers.get("content-type", "").startswith("text/html"), "/ is text/html", r.headers.get("content-type"))
    eq(r.content, (ROOT / "web" / "index.html").read_bytes(), "/ serves web/index.html byte for byte")
    js = sorted((ROOT / "web" / "js").glob("*.js"))
    if check(bool(js), "web/js has .js files"):
        r = c.get(f"/js/{js[0].name}")
        status(r, 200, f"GET /js/{js[0].name}")
        check(r.headers.get("content-type", "").startswith("text/javascript"), "JS served as text/javascript",
              r.headers.get("content-type"))
    is_error(c.get("/api/does-not-exist"), 404, "unknown API route")
    is_error(c.post("/api/does-not-exist", json={}), 404, "unknown API route (POST)")
    status(c.get("/no-such-file.txt"), 404, "unknown static file")


@test
def signup_login_logout_me():
    c = MAIN.client()
    name = MAIN.username("Alice")
    r = c.post("/api/auth/signup", json={"username": name, "password": PASSWORD})
    status(r, 201, "signup")
    user = r.json().get("user", {})
    eq(user.get("username"), name, "signup returns the username as typed")
    check(re.fullmatch(r"[0-9a-f]{32}", user.get("id", "")) is not None, "user id is uuid4 hex", user.get("id"))
    cookie = r.headers.get("set-cookie", "")
    check("tt_session=" in cookie, "signup sets tt_session", cookie)
    check("httponly" in cookie.lower(), "cookie is HttpOnly", cookie)
    check("samesite=lax" in cookie.lower(), "cookie is SameSite=Lax", cookie)
    check("path=/" in cookie.lower(), "cookie has Path=/", cookie)
    check("secure" not in cookie.lower(), "cookie not Secure on plain http", cookie)
    token = c.cookies.get("tt_session")
    r = c.get("/api/auth/me")
    status(r, 200, "me after signup")
    eq(r.json().get("user"), user, "me returns {user}")

    is_error(MAIN.client().post("/api/auth/signup", json={"username": name.upper(), "password": PASSWORD}), 409,
             "signup with same name, other case")
    for bad in ("ab", "has space", "x" * 33, "semi;colon", 42, None):
        is_error(MAIN.client().post("/api/auth/signup", json={"username": bad, "password": PASSWORD}), 400,
                 f"signup bad username {bad!r}")
    is_error(MAIN.client().post("/api/auth/signup", json={"username": MAIN.username("Shorty"), "password": "short"}),
             400, "signup short password")
    is_error(MAIN.client().post("/api/auth/signup", content=b"{not json", headers={"Content-Type": "application/json"}),
             400, "signup with invalid JSON")
    is_error(MAIN.client().post("/api/auth/signup", json=[1, 2]), 400, "signup with non-object JSON")

    status(c.post("/api/auth/logout"), 204, "logout")
    is_error(c.get("/api/auth/me"), 401, "me after logout")
    raw = TestClient(MAIN.app)
    is_error(raw.get("/api/auth/me", headers={"Cookie": f"tt_session={token}"}), 401, "old token rejected after logout")
    is_error(raw.get("/api/auth/me"), 401, "me without cookie")
    is_error(raw.get("/api/bootstrap"), 401, "bootstrap without cookie")

    is_error(c.post("/api/auth/login", json={"username": name, "password": "wrong password"}), 401, "login wrong password")
    is_error(c.post("/api/auth/login", json={"username": "nobody-here", "password": PASSWORD}), 401, "login unknown user")
    is_error(c.post("/api/auth/login", json={"username": name}), 400, "login without password")
    r = c.post("/api/auth/login", json={"username": name.lower(), "password": PASSWORD})
    status(r, 200, "login (username case-insensitive)")
    eq(r.json().get("user"), user, "login returns the stored user")
    status(c.get("/api/auth/me"), 200, "me after login")

    # Password change; other sessions of the same user end, this one stays.
    other = MAIN.client()
    status(other.post("/api/auth/login", json={"username": name, "password": PASSWORD}), 200, "second session")
    is_error(c.put("/api/auth/password", json={"current": "not it at all", "new": "brand new password"}), 403,
             "password change with wrong current")
    is_error(c.put("/api/auth/password", json={"current": PASSWORD, "new": "short"}), 400, "password change too short")
    status(c.put("/api/auth/password", json={"current": PASSWORD, "new": "brand new password"}), 204, "password change")
    status(c.get("/api/auth/me"), 200, "current session survives password change")
    is_error(other.get("/api/auth/me"), 401, "other session ended by password change")
    is_error(MAIN.client().post("/api/auth/login", json={"username": name, "password": PASSWORD}), 401, "old password")
    status(MAIN.client().post("/api/auth/login", json={"username": name, "password": "brand new password"}), 200,
           "new password")


@test
def login_lockout():
    c, user = MAIN.user("Locky")
    name = user["username"]
    anon = MAIN.client()
    for i in range(5):
        is_error(anon.post("/api/auth/login", json={"username": name, "password": f"bad password {i}"}), 401,
                 f"bad login #{i + 1}")
    r = anon.post("/api/auth/login", json={"username": name, "password": PASSWORD})
    is_error(r, 429, "6th attempt (correct password) is locked out")
    check(r.headers.get("retry-after", "").isdigit(), "429 carries Retry-After", r.headers.get("retry-after"))
    is_error(anon.post("/api/auth/login", json={"username": name.upper(), "password": PASSWORD}), 429,
             "lock is per username, case-insensitive")
    _, other = MAIN.user("Unlocked")
    status(MAIN.client().post("/api/auth/login", json={"username": other["username"], "password": PASSWORD}), 200,
           "another username is not locked")
    status(c.get("/api/auth/me"), 200, "existing session unaffected by lock")
    # Let the 60 s lock run out.
    MAIN.db.execute("UPDATE login_attempts SET locked_until = 1 WHERE key = ?", (name.lower(),))
    status(anon.post("/api/auth/login", json={"username": name, "password": PASSWORD}), 200, "login after lock expiry")
    is_error(anon.post("/api/auth/login", json={"username": name, "password": "bad again"}), 401,
             "one failure after success is 401, not 429")


@test
def csrf_header_required():
    plain = MAIN.client(csrf=False)
    is_error(plain.post("/api/auth/signup", json={"username": MAIN.username("Csrf"), "password": PASSWORD}), 403,
             "signup without X-Requested-With")
    is_error(plain.post("/api/auth/login", json={"username": "whoever", "password": PASSWORD}), 403,
             "login without X-Requested-With")
    is_error(plain.post("/api/auth/signup", json={"username": MAIN.username("Csrf"), "password": PASSWORD},
                        headers={"X-Requested-With": "XMLHttpRequest"}), 403, "wrong X-Requested-With value")
    c, _ = MAIN.user("CsrfUser")
    ch = new_char(c)
    for method, url in (("POST", "/api/characters"), ("PUT", f"/api/characters/{ch['id']}"),
                        ("DELETE", f"/api/characters/{ch['id']}"), ("POST", "/api/auth/logout"),
                        ("POST", "/api/campaigns")):
        r = c.request(method, url, json={"name": "x"}, headers={"X-Requested-With": ""})
        is_error(r, 403, f"{method} {url} without X-Requested-With")
    status(c.get("/api/auth/me"), 200, "still signed in (logout without header was refused)")
    status(c.get("/api/bootstrap", headers={"X-Requested-With": ""}), 200, "GET needs no header")
    check(by_id(boot(c)["characters"], ch["id"])["deleted"] is None, "refused DELETE did not delete")


@test
def signup_disabled_and_secure_cookie():
    env = Env("nosignup", allow_signup=False)
    is_error(env.client().post("/api/auth/signup", json={"username": "someone", "password": PASSWORD}), 403,
             "signup with ALLOW_SIGNUP=0")
    r = MAIN.client().post("/api/auth/signup", json={"username": MAIN.username("Proxied"), "password": PASSWORD},
                           headers={"X-Forwarded-Proto": "https"})
    status(r, 201, "signup behind https proxy")
    check("secure" in r.headers.get("set-cookie", "").lower(), "Secure cookie when X-Forwarded-Proto is https",
          r.headers.get("set-cookie"))
    env2 = Env("securecookie", cookie_secure=True)
    r = env2.client().post("/api/auth/signup", json={"username": "secured", "password": PASSWORD})
    status(r, 201, "signup with COOKIE_SECURE=1")
    check("secure" in r.headers.get("set-cookie", "").lower(), "Secure cookie when COOKIE_SECURE=1",
          r.headers.get("set-cookie"))


@test
def character_crud():
    c, me = MAIN.user("Crud")
    outsider, _ = MAIN.user("CrudOut")
    r = c.post("/api/characters", json={"name": "Manual Mo", "id": "evil", "owner_id": "x", "source": "aurora",
                                        "has_aurora": True, "campaign_id": "nope", "deleted": 5, "can_edit": False,
                                        "hp": {"current": 5, "max": 9, "temp": 0}})
    status(r, 201, "create manual character")
    ch = r.json()
    check(re.fullmatch(r"[0-9a-f]{32}", ch["id"]) is not None and ch["id"] != "evil", "server assigns the id", ch["id"])
    eq((ch["owner_id"], ch["owner_name"], ch["source"], ch["has_aurora"], ch["campaign_id"], ch["deleted"]),
       (me["id"], me["username"], "manual", False, None, None), "server fields ignored on create")
    eq((ch["can_edit"], ch["can_override"]), (True, True), "owner can edit and override")
    check(isinstance(ch["created"], int) and isinstance(ch["updated"], int) and ch["created"] > 1_600_000_000_000,
          "timestamps are Unix ms ints", (ch["created"], ch["updated"]))
    eq(ch["name"], "Manual Mo", "client fields kept")
    eq(ch["overrides"], [], "overrides default to []")
    stored = json.loads(MAIN.db.value("SELECT data FROM characters WHERE id = ?", (ch["id"],)))
    check(not ({"id", "owner_id", "source", "has_aurora", "campaign_id", "deleted", "can_edit"} & set(stored)),
          "data column holds no server fields", sorted(stored))

    upd = dict(ch, name="Manual Max", hp={"current": 3, "max": 9, "temp": 2}, owner_id="someone-else",
               source="aurora", campaign_id="zzz", created=1, deleted=123)
    r = c.put(f"/api/characters/{ch['id']}", json=upd)
    status(r, 200, "update character")
    got = r.json()
    eq((got["name"], got["hp"]), ("Manual Max", {"current": 3, "max": 9, "temp": 2}), "update applied")
    eq((got["owner_id"], got["source"], got["campaign_id"], got["created"], got["deleted"]),
       (me["id"], "manual", None, ch["created"], None), "server fields ignored on update")
    check(got["updated"] >= ch["updated"], "updated moves forward")
    eq(by_id(boot(c)["characters"], ch["id"])["name"], "Manual Max", "bootstrap returns the update")

    is_error(outsider.put(f"/api/characters/{ch['id']}", json=upd), 404, "outsider PUT")
    is_error(outsider.delete(f"/api/characters/{ch['id']}"), 404, "outsider DELETE")
    is_error(c.put("/api/characters/0123456789abcdef0123456789abcdef", json=upd), 404, "PUT unknown id")
    is_error(c.post("/api/characters", json=["not", "an", "object"]), 400, "create with array body")
    is_error(c.post("/api/characters", json={"name": "Bad", "overrides": "nope"}), 400, "create with bad overrides")
    is_error(c.post("/api/characters", json={"name": "Bad", "xml": 7}), 400, "create with non-string xml")
    is_error(c.post("/api/characters", content=b'{"name": NaN}', headers={"Content-Type": "application/json"}), 400,
             "NaN rejected")
    is_error(c.post("/api/characters", content=b'{"xp": 1e999}', headers={"Content-Type": "application/json"}), 400,
             "Infinity rejected")
    r = c.post("/api/characters", content=b'{"name": "Lone \\ud800 surrogate"}', headers={"Content-Type": "application/json"})
    status(r, 201, "lone surrogate accepted")
    eq(r.json().get("name"), "Lone � surrogate", "lone surrogate replaced with U+FFFD")

    status(c.delete(f"/api/characters/{ch['id']}"), 204, "soft delete")
    b = by_id(boot(c)["characters"], ch["id"])
    check(b is not None and isinstance(b["deleted"], int), "trashed character still in my bootstrap with deleted set", b)
    status(c.delete(f"/api/characters/{ch['id']}"), 204, "soft delete is idempotent")
    r = c.post(f"/api/characters/{ch['id']}/restore")
    status(r, 200, "restore")
    eq(r.json().get("deleted"), None, "restore clears deleted")
    status(c.delete(f"/api/characters/{ch['id']}/purge"), 204, "purge")
    eq(by_id(boot(c)["characters"], ch["id"]), None, "purged character gone from bootstrap")
    is_error(c.put(f"/api/characters/{ch['id']}", json=upd), 404, "PUT after purge")


@test
def base_field_lock_and_reimport():
    c, me = MAIN.user("Locker")
    ch = new_char(c, "Aura", xml=SYNTH_XML)
    eq((ch["source"], ch["has_aurora"]), ("aurora", True), "created with xml -> source aurora, has_aurora")
    path = MAIN.dir / "aurora" / f"{ch['id']}.dnd5e"
    check(path.is_file(), "XML stored at DATA_DIR/aurora/<id>.dnd5e", path)
    eq(path.read_bytes(), SYNTH_XML.encode("utf-8"), "XML stored byte for byte (BOM and CRLF kept)")

    tampered = dict(ch)
    tampered.update(
        abilities={"str": 20, "dex": 20, "con": 20, "int": 20, "wis": 20, "cha": 20},
        saveProf={"str": True}, skillProf={"stealth": 2}, classes=[{"name": "Fighter", "level": 20, "subclass": ""}],
        race="Dragon", background="Noble", alignment="CE",
        hitDice={"total": 20, "used": 1, "die": 12},
        spellcasting={"ability": "cha", "spells": [{"name": "Wish"}],
                      "slots": {"1": {"max": 9, "used": 7}, "2": {"max": 2, "used": 1}, "9": {"max": 3, "used": 0}}},
        name="Aura Renamed", hp={"current": 2, "max": 14, "temp": 5}, xp=1500, coins={"cp": 1, "sp": 2, "ep": 3, "gp": 99, "pp": 4},
    )
    r = c.put(f"/api/characters/{ch['id']}", json=tampered)
    status(r, 200, "PUT tampered aurora character")
    got = r.json()
    for key in ("abilities", "saveProf", "skillProf", "classes", "race", "background", "alignment"):
        eq(got[key], ch[key], f"aurora base field {key} unchanged")
    eq((got["hitDice"]["total"], got["hitDice"]["die"], got["hitDice"]["used"]), (3, 6, 1),
       "hitDice total/die locked, used accepted")
    eq(got["spellcasting"]["ability"], "int", "spellcasting.ability locked")
    eq(got["spellcasting"]["slots"], {"1": {"max": 4, "used": 4}, "2": {"max": 2, "used": 1}},
       "slot max locked, used clamped to max, unknown slot level dropped")
    eq(got["spellcasting"]["spells"], [{"name": "Wish"}], "spell list is not a base field")
    eq((got["name"], got["hp"], got["xp"], got["coins"]["gp"]), ("Aura Renamed", {"current": 2, "max": 14, "temp": 5}, 1500, 99),
       "tracked state accepted")
    stored = json.loads(MAIN.db.value("SELECT data FROM characters WHERE id = ?", (ch["id"],)))
    eq(stored["abilities"], ch["abilities"], "stored abilities unchanged")

    # Spell-slot overrides raise the clamp limit and may create a level (kept with max 0).
    ov = [{"target": "spellSlots.1", "mode": "add", "value": 1, "duration": "long"},
          {"target": "spellSlots.3", "mode": "add", "value": 1, "duration": "manual"}]
    status(c.put(f"/api/characters/{ch['id']}/overrides", json={"overrides": ov}), 200, "add slot overrides")
    body = dict(got)
    body.pop("overrides")
    body["spellcasting"] = dict(got["spellcasting"], slots={"1": {"max": 5, "used": 6}, "2": {"max": 2, "used": 0},
                                                            "3": {"max": 1, "used": 1}})
    r = c.put(f"/api/characters/{ch['id']}", json=body)
    status(r, 200, "PUT with slot overrides active")
    eq(r.json()["spellcasting"]["slots"], {"1": {"max": 4, "used": 5}, "2": {"max": 2, "used": 0}, "3": {"max": 0, "used": 1}},
       "used may reach base max + override; override-created level kept with max 0")
    eq(len(r.json()["overrides"]), 2, "PUT without overrides keeps the stored overrides")

    m = new_char(c, "Manny")
    changed = dict(m, abilities={"str": 18, "dex": 14, "con": 13, "int": 16, "wis": 12, "cha": 10},
                   classes=[{"name": "Wizard", "level": 4, "subclass": "Evocation"}],
                   spellcasting={"ability": "wis", "slots": {"1": {"max": 9, "used": 0}}, "spells": []})
    r = c.put(f"/api/characters/{m['id']}", json=changed)
    status(r, 200, "PUT manual character")
    eq((r.json()["abilities"]["str"], r.json()["classes"][0]["level"], r.json()["spellcasting"]["ability"],
        r.json()["spellcasting"]["slots"]["1"]["max"]), (18, 4, "wis", 9), "manual character base fields editable")

    # Re-import replaces base fields and the file.
    new_xml = SYNTH_XML.replace("<gender>Female</gender>", "<gender>Male</gender>")
    data = dict(got, abilities={"str": 9, "dex": 15, "con": 14, "int": 17, "wis": 12, "cha": 10},
                classes=[{"name": "Wizard", "level": 4, "subclass": "Evocation"}],
                hitDice={"total": 4, "used": 0, "die": 6})
    r = c.put(f"/api/characters/{ch['id']}/aurora", json={"data": data, "xml": new_xml})
    status(r, 200, "re-import via /aurora")
    eq((r.json()["abilities"]["str"], r.json()["classes"][0]["level"], r.json()["hitDice"]["total"]), (9, 4, 4),
       "re-import changes base fields")
    eq(r.json()["source"], "aurora", "re-import keeps source aurora")
    eq(path.read_bytes(), new_xml.encode("utf-8"), "re-import replaces the stored XML")
    r = c.put(f"/api/characters/{m['id']}/aurora", json={"data": dict(m), "xml": SYNTH_XML})
    status(r, 200, "re-import turns a manual character into an aurora one")
    eq((r.json()["source"], r.json()["has_aurora"]), ("aurora", True), "manual -> aurora after re-import")
    is_error(c.put(f"/api/characters/{ch['id']}/aurora", json={"data": data}), 400, "re-import without xml")
    is_error(c.put(f"/api/characters/{ch['id']}/aurora", json={"xml": new_xml}), 400, "re-import without data")
    other, _ = MAIN.user("LockOut")
    is_error(other.put(f"/api/characters/{ch['id']}/aurora", json={"data": data, "xml": new_xml}), 404,
             "outsider re-import")


def campaign_setup(prefix: str):
    """DM with a campaign, two players who joined, one outsider; each player has a character in it."""
    dm, dm_user = MAIN.user(f"{prefix}DM")
    p1, p1_user = MAIN.user(f"{prefix}P1")
    p2, p2_user = MAIN.user(f"{prefix}P2")
    out, out_user = MAIN.user(f"{prefix}Out")
    camp = dm.post("/api/campaigns", json={"name": f"{prefix} campaign"}).json()
    for p in (p1, p2):
        assert p.post("/api/campaigns/join", json={"code": camp["invite_code"]}).status_code == 200
    c1 = new_char(p1, f"{prefix} One", xml=SYNTH_XML)
    c2 = new_char(p2, f"{prefix} Two")
    for p, ch in ((p1, c1), (p2, c2)):
        assert p.put(f"/api/characters/{ch['id']}/campaign", json={"campaign_id": camp["id"]}).status_code == 200
    return dict(dm=dm, dm_user=dm_user, p1=p1, p1_user=p1_user, p2=p2, p2_user=p2_user, out=out, out_user=out_user,
                camp=camp, c1=c1, c2=c2)


@test
def overrides_permissions():
    s = campaign_setup("Ovr")
    cid = s["c1"]["id"]
    ov = [{"target": "ac", "mode": "add", "value": 2, "duration": "long", "label": "Shield of Faith"}]
    r = s["p1"].put(f"/api/characters/{cid}/overrides", json={"overrides": ov, "name": "Ignored"})
    status(r, 200, "owner sets overrides")
    o = r.json()["overrides"][0]
    eq(o["createdBy"], s["p1_user"]["id"], "createdBy = caller")
    check(isinstance(o.get("createdAt"), int) and bool(o.get("id")), "createdAt and id filled in", o)
    eq(r.json()["name"], s["c1"]["name"], "only overrides change")

    ov2 = r.json()["overrides"] + [{"target": "abilities.str", "mode": "add", "value": 2, "duration": "short"}]
    r = s["dm"].put(f"/api/characters/{cid}/overrides", json={"overrides": ov2})
    status(r, 200, "campaign DM sets overrides")
    eq([x["createdBy"] for x in r.json()["overrides"]], [s["p1_user"]["id"], s["dm_user"]["id"]],
       "existing createdBy kept, new one = DM")
    eq((r.json()["can_edit"], r.json()["can_override"]), (False, True), "DM view: can_override but not can_edit")
    eq(r.json()["abilities"], s["c1"]["abilities"], "DM overrides do not touch base fields")

    is_error(s["p2"].put(f"/api/characters/{cid}/overrides", json={"overrides": []}), 403, "other member sets overrides")
    is_error(s["out"].put(f"/api/characters/{cid}/overrides", json={"overrides": []}), 404, "outsider sets overrides")
    is_error(s["dm"].put(f"/api/characters/{cid}", json=dict(s["c1"], name="DM edit")), 403, "DM ordinary PUT")
    is_error(s["p2"].put(f"/api/characters/{cid}", json=dict(s["c1"], name="P2 edit")), 403, "member ordinary PUT")
    is_error(s["dm"].put(f"/api/characters/{cid}/aurora", json={"data": s["c1"], "xml": SYNTH_XML}), 403, "DM re-import")
    is_error(s["dm"].delete(f"/api/characters/{cid}"), 403, "DM delete")
    for bad, why in (({"overrides": "x"}, "not an array"), ({}, "missing"),
                     ({"overrides": [1]}, "item not object"),
                     ({"overrides": [{"mode": "add", "value": 1, "duration": "long"}]}, "no target"),
                     ({"overrides": [{"target": "ac", "mode": "mul", "value": 1, "duration": "long"}]}, "bad mode"),
                     ({"overrides": [{"target": "ac", "mode": "add", "value": 1, "duration": "forever"}]}, "bad duration")):
        is_error(s["p1"].put(f"/api/characters/{cid}/overrides", json=bad), 400, f"invalid overrides ({why})")
    is_error(s["p1"].put(f"/api/characters/{cid}", json=dict(s["c1"], overrides=[{"target": "ac"}])), 400,
             "ordinary PUT validates overrides too")
    eq(len(by_id(boot(s["p1"])["characters"], cid)["overrides"]), 2, "rejected writes changed nothing")
    # A short rest done by the owner (ordinary PUT without the short override) removes it.
    current = by_id(boot(s["p1"])["characters"], cid)
    rested = dict(current, overrides=[x for x in current["overrides"] if x["duration"] != "short"])
    eq(len(s["p1"].put(f"/api/characters/{cid}", json=rested).json()["overrides"]), 1, "owner PUT can expire overrides")


@test
def campaigns_and_visibility():
    dm, dm_user = MAIN.user("VisDM")
    p1, p1_user = MAIN.user("VisP1")
    p2, p2_user = MAIN.user("VisP2")
    out, out_user = MAIN.user("VisOut")

    is_error(dm.post("/api/campaigns", json={"name": "   "}), 400, "campaign without name")
    r = dm.post("/api/campaigns", json={"name": "Curse of Tests"})
    status(r, 201, "create campaign")
    camp = r.json()
    check(re.fullmatch(r"[A-Z0-9]{8}", camp.get("invite_code") or "") is not None, "invite code is 8 upper alnum", camp)
    eq((camp["name"], camp["dm_id"], camp["dm_name"], camp["members"]), ("Curse of Tests", dm_user["id"], dm_user["username"], []),
       "campaign object")
    check(isinstance(camp.get("created"), int), "campaign created is int ms")
    code = camp["invite_code"]

    r = p1.post("/api/campaigns/join", json={"code": code.lower()})
    status(r, 200, "join with lower-case code")
    eq(r.json()["invite_code"], None, "members do not see the invite code")
    eq(r.json()["members"], [p1_user], "member list after join")
    status(p1.post("/api/campaigns/join", json={"code": code}), 200, "join again (idempotent)")
    is_error(dm.post("/api/campaigns/join", json={"code": code}), 400, "DM cannot join own campaign")
    is_error(out.post("/api/campaigns/join", json={"code": "ZZZZZZZZ"}), 404, "join with unknown code")
    status(p2.post("/api/campaigns/join", json={"code": code}), 200, "second player joins")

    c1, c2, c_out = new_char(p1, "P1 Hero"), new_char(p2, "P2 Hero"), new_char(out, "Out Hero")
    c1_private = new_char(p1, "P1 Private")
    dm_npc = new_char(dm, "DM NPC")
    r = p1.put(f"/api/characters/{c1['id']}/campaign", json={"campaign_id": camp["id"]})
    status(r, 200, "member assigns own character")
    eq(r.json()["campaign_id"], camp["id"], "campaign_id set")
    status(p2.put(f"/api/characters/{c2['id']}/campaign", json={"campaign_id": camp["id"]}), 200, "p2 assigns")
    status(dm.put(f"/api/characters/{dm_npc['id']}/campaign", json={"campaign_id": camp["id"]}), 200, "DM assigns own NPC")
    is_error(out.put(f"/api/characters/{c_out['id']}/campaign", json={"campaign_id": camp["id"]}), 400,
             "outsider cannot assign to a campaign they are not in")
    is_error(p1.put(f"/api/characters/{c1_private['id']}/campaign", json={"campaign_id": "f" * 32}), 400,
             "assign to unknown campaign")
    is_error(p1.put(f"/api/characters/{c1_private['id']}/campaign", json={}), 400, "assign without campaign_id")
    is_error(dm.put(f"/api/characters/{c1['id']}/campaign", json={"campaign_id": None}), 403,
             "DM cannot reassign a player's character")

    # Notes and the shared flag.
    n_p1 = new_note(p1, "P1 campaign note", campaign_id=camp["id"], shared=True)
    eq(n_p1["shared"], 0, "shared forced to 0 for a player's note")
    n_p1_private = new_note(p1, "P1 private")
    n_p2 = new_note(p2, "P2 campaign note", campaign_id=camp["id"])
    n_dm_shared = new_note(dm, "DM handout", campaign_id=camp["id"], shared=True)
    eq(n_dm_shared["shared"], 1, "DM note in own campaign can be shared")
    n_dm_secret = new_note(dm, "DM secret", campaign_id=camp["id"], shared=False)
    eq(n_dm_secret["shared"], 0, "DM unshared note")
    n_dm_loose = new_note(dm, "DM loose", shared=True)
    eq(n_dm_loose["shared"], 0, "shared forced to 0 without a campaign")
    is_error(out.post("/api/notes", json={"title": "x", "campaign_id": camp["id"]}), 400,
             "note in a campaign I am not in")
    r = p1.put(f"/api/notes/{n_p1['id']}", json=dict(n_p1, body="edited", shared=True))
    status(r, 200, "player edits own note")
    eq((r.json()["body"], r.json()["shared"]), ("edited", 0), "player note stays unshared")
    eq((n_p1["owner_name"], n_p1["characterId"], n_p1["can_edit"]), (p1_user["username"], None, True), "note fields")

    # Bootstrap visibility.
    bd = boot(dm)
    eq(bd["user"], dm_user, "bootstrap user")
    check(isinstance(bd["serverTime"], int), "serverTime is int ms")
    dmc = by_id(bd["campaigns"], camp["id"])
    eq((dmc["invite_code"], [m["id"] for m in dmc["members"]]), (code, [p1_user["id"], p2_user["id"]]),
       "DM sees invite code and members (DM not listed)")
    ids = {x["id"] for x in bd["characters"]}
    check({c1["id"], c2["id"], dm_npc["id"]} <= ids, "DM sees members' characters")
    check(c1_private["id"] not in ids and c_out["id"] not in ids, "DM does not see characters outside the campaign")
    v = by_id(bd["characters"], c1["id"])
    eq((v["can_edit"], v["can_override"], v["owner_name"]), (False, True, p1_user["username"]), "DM flags on player's sheet")
    nids = {x["id"] for x in bd["notes"]}
    check({n_p1["id"], n_p2["id"], n_dm_shared["id"], n_dm_secret["id"], n_dm_loose["id"]} <= nids,
          "DM sees all campaign notes and own notes")
    check(n_p1_private["id"] not in nids, "DM does not see a player's non-campaign note")
    eq(by_id(bd["notes"], n_p1["id"])["can_edit"], False, "DM cannot edit player's note")

    b1 = boot(p1)
    eq(by_id(b1["campaigns"], camp["id"])["invite_code"], None, "member bootstrap hides invite code")
    ids = {x["id"] for x in b1["characters"]}
    check({c1["id"], c1_private["id"], c2["id"], dm_npc["id"]} <= ids, "member sees own + campaign characters")
    v = by_id(b1["characters"], c2["id"])
    eq((v["can_edit"], v["can_override"]), (False, False), "member: other sheet is read-only, no overrides")
    nids = {x["id"] for x in b1["notes"]}
    check({n_p1["id"], n_p1_private["id"], n_dm_shared["id"]} <= nids, "member sees own notes and DM's shared note")
    check(not ({n_p2["id"], n_dm_secret["id"], n_dm_loose["id"]} & nids),
          "member sees neither other players' notes nor the DM's unshared notes")

    bo = boot(out)
    eq(bo["campaigns"], [], "outsider has no campaigns")
    check({x["id"] for x in bo["characters"]} == {c_out["id"]}, "outsider sees only own character")
    eq(bo["notes"], [], "outsider sees no notes")

    is_error(dm.put(f"/api/notes/{n_p1['id']}", json={"title": "DM edit"}), 403, "DM edits player's note")
    is_error(p1.put(f"/api/notes/{n_dm_shared['id']}", json={"title": "hack"}), 403, "member edits DM's shared note")
    is_error(p1.put(f"/api/notes/{n_dm_secret['id']}", json={"title": "peek"}), 404, "member cannot reach unshared DM note")
    is_error(p2.put(f"/api/notes/{n_p1['id']}", json={"title": "peek"}), 404, "member cannot reach another member's note")
    is_error(out.delete(f"/api/notes/{n_p1['id']}"), 404, "outsider deletes note")

    # Trashed records disappear for the campaign but not for the owner.
    status(p2.delete(f"/api/characters/{c2['id']}"), 204, "p2 trashes campaign character")
    status(p2.delete(f"/api/notes/{n_p2['id']}"), 204, "p2 trashes campaign note")
    check(by_id(boot(dm)["characters"], c2["id"]) is None, "DM no longer sees trashed character")
    check(by_id(boot(dm)["notes"], n_p2["id"]) is None, "DM no longer sees trashed note")
    check(by_id(boot(p1)["characters"], c2["id"]) is None, "member no longer sees trashed character")
    is_error(dm.put(f"/api/characters/{c2['id']}/overrides", json={"overrides": []}), 404, "DM overrides a trashed sheet")
    check(by_id(boot(p2)["characters"], c2["id"])["deleted"] is not None, "owner still sees trashed character")
    status(p2.post(f"/api/characters/{c2['id']}/restore"), 200, "restore character")
    status(p2.post(f"/api/notes/{n_p2['id']}/restore"), 200, "restore note")
    check(by_id(boot(dm)["characters"], c2["id"]) is not None, "DM sees restored character")

    # Rename / rotate.
    r = dm.put(f"/api/campaigns/{camp['id']}", json={"name": "Curse of Tests II"})
    status(r, 200, "DM renames")
    eq(r.json()["name"], "Curse of Tests II", "renamed")
    is_error(p1.put(f"/api/campaigns/{camp['id']}", json={"name": "mine"}), 403, "member renames")
    is_error(out.put(f"/api/campaigns/{camp['id']}", json={"name": "mine"}), 404, "outsider renames")
    r = dm.post(f"/api/campaigns/{camp['id']}/invite/rotate")
    status(r, 200, "DM rotates invite")
    check(r.json()["invite_code"] != code and re.fullmatch(r"[A-Z0-9]{8}", r.json()["invite_code"]) is not None,
          "new invite code", r.json()["invite_code"])
    is_error(p1.post(f"/api/campaigns/{camp['id']}/invite/rotate"), 403, "member rotates invite")
    is_error(out.post("/api/campaigns/join", json={"code": code}), 404, "old code no longer works")
    code = r.json()["invite_code"]

    # Leave.
    is_error(dm.post(f"/api/campaigns/{camp['id']}/leave"), 400, "DM cannot leave")
    is_error(out.post(f"/api/campaigns/{camp['id']}/leave"), 404, "outsider leaves")
    status(p2.post(f"/api/campaigns/{camp['id']}/leave"), 204, "p2 leaves")
    b2 = boot(p2)
    eq(b2["campaigns"], [], "p2 has no campaigns after leaving")
    eq((by_id(b2["characters"], c2["id"])["campaign_id"], by_id(b2["notes"], n_p2["id"])["campaign_id"]), (None, None),
       "leaving clears campaign_id on my character and note")
    bd = boot(dm)
    check(by_id(bd["characters"], c2["id"]) is None and by_id(bd["notes"], n_p2["id"]) is None,
          "DM no longer sees the leaver's records")
    eq([m["id"] for m in by_id(bd["campaigns"], camp["id"])["members"]], [p1_user["id"]], "member list after leave")
    check(by_id(boot(p1)["characters"], c2["id"]) is None, "remaining member no longer sees leaver's sheet")

    # Remove.
    status(p2.post("/api/campaigns/join", json={"code": code}), 200, "p2 rejoins")
    is_error(p2.post(f"/api/campaigns/{camp['id']}/members/{p1_user['id']}/remove"), 403, "member removes member")
    is_error(dm.post(f"/api/campaigns/{camp['id']}/members/{out_user['id']}/remove"), 404, "remove a non-member")
    status(dm.post(f"/api/campaigns/{camp['id']}/members/{p1_user['id']}/remove"), 204, "DM removes p1")
    b1 = boot(p1)
    eq([c["id"] for c in b1["campaigns"]], [], "removed player has no campaigns")
    eq((by_id(b1["characters"], c1["id"])["campaign_id"], by_id(b1["notes"], n_p1["id"])["campaign_id"]), (None, None),
       "removal clears campaign_id on the player's character and note")
    check(by_id(b1["notes"], n_dm_shared["id"]) is None, "removed player loses the DM's shared note")
    bd = boot(dm)
    check(by_id(bd["characters"], c1["id"]) is None and by_id(bd["notes"], n_p1["id"]) is None,
          "DM no longer sees removed player's records")

    # Delete.
    status(p1.post("/api/campaigns/join", json={"code": code}), 200, "p1 rejoins")
    status(p1.put(f"/api/characters/{c1['id']}/campaign", json={"campaign_id": camp["id"]}), 200, "p1 reassigns")
    is_error(p1.delete(f"/api/campaigns/{camp['id']}"), 403, "member deletes campaign")
    is_error(out.delete(f"/api/campaigns/{camp['id']}"), 404, "outsider deletes campaign")
    status(dm.delete(f"/api/campaigns/{camp['id']}"), 204, "DM deletes campaign")
    for who in (dm, p1, p2):
        eq(boot(who)["campaigns"], [], "no campaigns after delete")
    bd = boot(dm)
    eq((by_id(bd["characters"], dm_npc["id"])["campaign_id"], by_id(bd["notes"], n_dm_shared["id"])["campaign_id"],
        by_id(bd["notes"], n_dm_shared["id"])["shared"]), (None, None, 0),
       "deleting clears campaign_id (and shared) on the DM's own records")
    check(by_id(bd["characters"], c1["id"]) is None, "DM no longer sees p1's character")
    eq(by_id(boot(p1)["characters"], c1["id"])["campaign_id"], None, "p1's character left the deleted campaign")
    eq(MAIN.db.value("SELECT COUNT(*) FROM campaign_members WHERE campaign_id = ?", (camp["id"],)), 0, "members removed")


@test
def notes_trash_restore_purge():
    c, me = MAIN.user("Noter")
    n = new_note(c, "Scratch", folder="Misc", tags=["a", "b"], characterId="abc")
    eq((n["title"], n["folder"], n["tags"], n["characterId"], n["campaign_id"], n["shared"], n["deleted"]),
       ("Scratch", "Misc", ["a", "b"], "abc", None, 0, None), "note created")
    is_error(c.post("/api/notes", json={"title": "x", "tags": "nope"}), 400, "tags must be an array")
    r = c.put(f"/api/notes/{n['id']}", json={"title": "Scratch 2"})
    status(r, 200, "partial note update")
    eq((r.json()["title"], r.json()["body"], r.json()["tags"]), ("Scratch 2", n["body"], ["a", "b"]),
       "fields not sent are kept")
    status(c.delete(f"/api/notes/{n['id']}"), 204, "note soft delete")
    check(isinstance(by_id(boot(c)["notes"], n["id"])["deleted"], int), "trashed note in my bootstrap")
    r = c.post(f"/api/notes/{n['id']}/restore")
    status(r, 200, "note restore")
    eq(r.json()["deleted"], None, "restored")
    status(c.delete(f"/api/notes/{n['id']}/purge"), 204, "note purge")
    eq(by_id(boot(c)["notes"], n["id"]), None, "purged note gone")
    is_error(c.put(f"/api/notes/{n['id']}", json={"title": "x"}), 404, "update purged note")


@test
def thirty_day_purge():
    c, _ = MAIN.user("Purger")
    old_ch = new_char(c, "Old", xml=SYNTH_XML)
    recent_ch = new_char(c, "Recent")
    old_note, recent_note = new_note(c, "Old note"), new_note(c, "Recent note")
    linked = new_note(c, "Linked", characterId=old_ch["id"])
    for path in (f"/api/characters/{old_ch['id']}", f"/api/characters/{recent_ch['id']}",
                 f"/api/notes/{old_note['id']}", f"/api/notes/{recent_note['id']}"):
        status(c.delete(path), 204, f"trash {path}")
    from server.db import now_ms
    now = now_ms()
    MAIN.db.execute("UPDATE characters SET deleted = ? WHERE id = ?", (now - 31 * DAY_MS, old_ch["id"]))
    MAIN.db.execute("UPDATE notes SET deleted = ? WHERE id = ?", (now - 31 * DAY_MS, old_note["id"]))
    MAIN.db.execute("UPDATE characters SET deleted = ? WHERE id = ?", (now - 29 * DAY_MS, recent_ch["id"]))
    MAIN.db.execute("UPDATE notes SET deleted = ? WHERE id = ?", (now - 29 * DAY_MS, recent_note["id"]))
    b = boot(c)
    eq((by_id(b["characters"], old_ch["id"]), by_id(b["notes"], old_note["id"])), (None, None),
       "records trashed > 30 days ago are purged by bootstrap")
    check(by_id(b["characters"], recent_ch["id"]) is not None and by_id(b["notes"], recent_note["id"]) is not None,
          "records trashed 29 days ago are kept")
    check(not (MAIN.dir / "aurora" / f"{old_ch['id']}.dnd5e").exists(), "purged character's XML removed")
    eq(by_id(b["notes"], linked["id"])["characterId"], None, "notes linked to a purged character are unlinked")


@test
def aurora_download():
    s = campaign_setup("Dl")
    cid = s["c1"]["id"]
    backstory = "New story.\nIt says ]]> twice ]]> and <b>bold</b> & more."
    ch = dict(s["c1"])
    ch.update(name="Testa & Co", xp=2750, coins={"cp": 11, "sp": 22, "ep": 33, "gp": 444, "pp": 5},
              bio={"appearance": "tall", "backstory": backstory, "traits": "Brave", "ideals": "Freedom",
                   "bonds": "My sister", "flaws": "Greedy", "allies": "The Harpers"},
              hp={"current": 7, "max": 14, "temp": 3}, conditions=["Poisoned", "Prone"], exhaustion=2,
              spellcasting=dict(s["c1"]["spellcasting"], slots={"1": {"max": 4, "used": 3}, "2": {"max": 2, "used": 0}}))
    status(s["p1"].put(f"/api/characters/{cid}", json=ch), 200, "save session state")
    ov = [{"target": "ac", "mode": "add", "value": 2, "duration": "long", "label": "Shield of Faith"}]
    status(s["dm"].put(f"/api/characters/{cid}/overrides", json={"overrides": ov}), 200, "DM adds override")

    r = s["p1"].get(f"/api/characters/{cid}/aurora.dnd5e")
    status(r, 200, "owner downloads .dnd5e")
    eq(r.headers.get("content-disposition"), 'attachment; filename="Testa & Co.dnd5e"', "Content-Disposition")
    out = r.content.decode("utf-8")
    check(r.content.startswith(b"\xef\xbb\xbf"), "BOM preserved")
    eq(r.content.count(b"\n"), r.content.count(b"\r\n"), "every newline is still CRLF")

    # Expected document: the original with exactly the §3.1 regions replaced.
    m = re.search(r'<note column="left">(.*?)</note>', out, re.S)
    note_text = m.group(1) if m else ""
    exp_backstory = "<![CDATA[New story.\r\nIt says ]]]]><![CDATA[> twice ]]]]><![CDATA[> and <b>bold</b> & more.]]>"
    expected = SYNTH_XML
    for old, new in (
        ("\t\t<input>\r\n\t\t\t<name>Testa</name>", "\t\t<input>\r\n\t\t\t<name>Testa &amp; Co</name>"),
        ("<experience>300</experience>", "<experience>2750</experience>"),
        ("<backstory><![CDATA[Old story that quotes </input> and <name>Fake</name>.]]></backstory>",
         f"<backstory>{exp_backstory}</backstory>"),
        ("<background-traits>\r\n\t\t\t</background-traits>", "<background-traits><![CDATA[Brave]]></background-traits>"),
        ("<background-ideals>\r\n\t\t\t</background-ideals>", "<background-ideals><![CDATA[Freedom]]></background-ideals>"),
        ("<background-bonds />", "<background-bonds><![CDATA[My sister]]></background-bonds>"),
        ("<allies><![CDATA[]]></allies>", "<allies><![CDATA[The Harpers]]></allies>"),
        ("<copper>1</copper>", "<copper>11</copper>"), ("<silver>2</silver>", "<silver>22</silver>"),
        ("<electrum>3</electrum>", "<electrum>33</electrum>"), ("<gold>4</gold>", "<gold>444</gold>"),
        ("<platinum>5</platinum>", "<platinum>5</platinum>"),
        ('<note column="left">\r\n\t\t\t\t</note>', f'<note column="left">{note_text}</note>'),
    ):
        check(expected.count(old) == 1, f"fixture has exactly one {old[:40]!r}")
        expected = expected.replace(old, new, 1)
    eq(out, expected, "download = original with only the §3.1 regions patched (rest byte-identical)")
    check("background-flaws" not in out, "absent <background-flaws> stays absent")

    root = ET.fromstring(r.content)
    inp = root.find("build/input")
    eq(inp.findtext("name"), "Testa & Co", "parsed name")
    eq(inp.findtext("experience"), "2750", "parsed XP")
    eq([inp.findtext(f"currency/{k}") for k in ("copper", "silver", "electrum", "gold", "platinum")],
       ["11", "22", "33", "444", "5"], "parsed coins")
    eq(inp.findtext("backstory"), backstory, "backstory with ]]> survives the CDATA split")
    eq([inp.findtext(t) for t in ("background-traits", "background-ideals", "background-bonds")],
       ["Brave", "Freedom", "My sister"], "parsed traits / ideals / bonds")
    eq(inp.findtext("organization/allies"), "The Harpers", "parsed allies")
    eq(inp.findtext("currency/equipment"), "50 ft. rope", "unpatched sibling unchanged")
    eq(root.findtext("display-properties/name"), "Testa", "display-properties name untouched")
    eq(root.findtext("build/equipment/item/details/name"), "Rope", "equipment item name untouched")
    left = inp.find("notes/note[@column='left']").text or ""
    for line in (f"Date: {datetime.now().date().isoformat()}", "HP: 7/14 (temp 3)", "Conditions: Poisoned, Prone",
                 "Exhaustion: 2", "Spell slots used: 1st 3/4, 2nd 0/2", "Active overrides:",
                 "- Shield of Faith: ac +2 (until long rest)", "Exported from Tome & Table"):
        check(line in left.split("\n"), f"notes block has line {line!r}", left)
    eq(inp.find("notes/note[@column='right']").text, "Keep this & that", "right-hand note untouched")

    status(s["dm"].get(f"/api/characters/{cid}/aurora.dnd5e"), 200, "campaign DM downloads")
    is_error(s["p2"].get(f"/api/characters/{cid}/aurora.dnd5e"), 403, "other member cannot download")
    is_error(s["out"].get(f"/api/characters/{cid}/aurora.dnd5e"), 404, "outsider cannot download")
    is_error(s["p2"].get(f"/api/characters/{s['c2']['id']}/aurora.dnd5e"), 404, "manual character has no file")
    r = s["p1"].get("/api/characters/{0}/aurora.dnd5e".format(new_char(s["p1"], "Zoë/Ünïcode", xml=SYNTH_XML)["id"]))
    status(r, 200, "download non-ASCII name")
    eq(r.headers.get("content-disposition"),
       "attachment; filename=\"Zo___n_code.dnd5e\"; filename*=UTF-8''Zo%C3%AB_%C3%9Cn%C3%AFcode.dnd5e",
       "non-ASCII filename gets an ASCII fallback plus filename*")


@test
def aurora_patch_unit():
    eq(split_cdata("a]]>b"), "<![CDATA[a]]]]><![CDATA[>b]]>", "split_cdata splits ]]>")
    eq(ET.fromstring("<x>" + split_cdata("]]>]]>x]]") + "</x>").text, "]]>]]>x]]", "split_cdata round-trips")
    eq(split_cdata(""), "<![CDATA[]]>", "split_cdata empty")
    plain = '<?xml version="1.0"?><character><display-properties><name>A</name></display-properties></character>'
    eq(patch_aurora(plain, {"name": "B", "xp": 5}), plain, "file without <build> is returned unchanged")
    no_input = "<character><build><abilities/></build></character>"
    eq(patch_aurora(no_input, {"name": "B"}), no_input, "<build> without <input> unchanged")
    sparse = "<character><build><input><name>A</name></input></build></character>"
    eq(patch_aurora(sparse, {"name": "B", "xp": 9, "coins": {"gp": 3}, "bio": {"backstory": "x"}}),
       "<character><build><input><name>B</name></input></build></character>", "absent tags stay absent")
    eq(patch_aurora(sparse, {}), sparse, "values missing from ch leave tags alone")
    nested = ("<character><build><input><organization><name>Org</name></organization><name>A</name>"
              "</input></build></character>")
    eq(patch_aurora(nested, {"name": "B"}),
       "<character><build><input><organization><name>Org</name></organization><name>B</name></input></build></character>",
       "only the direct <input><name> child is patched")
    when = datetime(2026, 10, 13, 12, 0)
    ch = {"name": "N", "xp": "12", "coins": {"gp": 7.0}, "bio": {"backstory": "a]]>b", "bonds": "c"}}
    once = patch_aurora(SYNTH_XML, ch, now=when)
    eq(patch_aurora(once, ch, now=when), once, "patching is idempotent")
    check("<experience>12</experience>" in once and "<gold>7</gold>" in once, "numbers written as integers")
    lf = SYNTH_XML.replace("\r\n", "\n")
    out = patch_aurora(lf, {"bio": {"backstory": "one\r\ntwo"}}, now=when)
    check("\r" not in out, "LF files stay LF")


# ---------------------------------------------------------------------------------------- runner
def main() -> int:
    try:
        for fn in TESTS:
            _current[0] = fn.__name__
            try:
                fn()
            except Exception:
                FAILED.append(f"[{fn.__name__}] raised:\n{traceback.format_exc()}")
    finally:
        for app in Env.apps + [app_module.app]:
            try:
                app.state.db.close()
            except Exception:
                pass
        shutil.rmtree(TMP, ignore_errors=True)
    for line in FAILED:
        print("FAIL", line)
    print(f"{PASSED} passed, {len(FAILED)} failed")
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
