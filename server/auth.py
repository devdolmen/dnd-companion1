"""Passwords, session tokens, the session cookie and login lock-out (spec §2, §3 Auth).

- Passwords: ``hashlib.scrypt(n=2**14, r=8, p=1)`` with a 16-byte random salt, stored as
  ``scrypt$<salt_hex>$<hash_hex>``.
- Sessions: 32 random bytes as hex in the ``tt_session`` cookie (HttpOnly, SameSite=Lax, Path=/,
  Secure on https). The database keeps only the SHA-256 of the token, so a leaked database
  cannot be replayed as cookies.
- Lock-out: after 5 consecutive failed logins for a username, further attempts for that
  username get 429 for 60 seconds. A successful login resets the counter.
"""
from __future__ import annotations

import hashlib
import hmac
import re
import secrets

from starlette.requests import Request
from starlette.responses import Response

from .db import Database, now_ms

COOKIE_NAME = "tt_session"

SCRYPT_N, SCRYPT_R, SCRYPT_P = 2**14, 8, 1
SCRYPT_DKLEN = 64
SCRYPT_MAXMEM = 64 * 1024 * 1024

USERNAME_RE = re.compile(r"[A-Za-z0-9_.-]{3,32}")
MIN_PASSWORD = 8
MAX_PASSWORD = 1024

LOCK_AFTER = 5          # failures
LOCK_MS = 60_000        # lock duration
_STALE_LOCK_MS = 24 * 3600 * 1000


# ---------------------------------------------------------------------------- passwords
def _scrypt(password: str, salt: bytes, dklen: int = SCRYPT_DKLEN) -> bytes:
    return hashlib.scrypt(
        password.encode("utf-8", "surrogatepass"),
        salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, maxmem=SCRYPT_MAXMEM, dklen=dklen,
    )


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    return f"scrypt${salt.hex()}${_scrypt(password, salt).hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, salt_hex, hash_hex = stored.split("$")
        salt, expected = bytes.fromhex(salt_hex), bytes.fromhex(hash_hex)
    except (ValueError, AttributeError):
        return False
    if scheme != "scrypt" or not expected:
        return False
    return hmac.compare_digest(_scrypt(password, salt, len(expected)), expected)


def burn_time(password: str) -> None:
    """Spend the same effort as a real check, so unknown usernames cannot be timed."""
    _scrypt(password, bytes(16))


def valid_username(value: object) -> str | None:
    """The username (surrounding whitespace removed) if it is 3-32 chars of [A-Za-z0-9_.-]."""
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value if USERNAME_RE.fullmatch(value) else None


def password_problem(value: object) -> str | None:
    if not isinstance(value, str) or len(value) < MIN_PASSWORD:
        return f"Password must be at least {MIN_PASSWORD} characters"
    if len(value) > MAX_PASSWORD:
        return f"Password must be at most {MAX_PASSWORD} characters"
    return None


# ---------------------------------------------------------------------------- sessions
def token_key(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8", "surrogatepass")).hexdigest()


def create_session(db: Database, user_id: str, days: int) -> str:
    token = secrets.token_hex(32)
    now = now_ms()
    db.execute("DELETE FROM sessions WHERE expires <= ?", (now,))
    db.execute(
        "INSERT INTO sessions (token, user_id, created, expires) VALUES (?, ?, ?, ?)",
        (token_key(token), user_id, now, now + days * 86_400_000),
    )
    return token


def session_user(db: Database, token: str | None) -> dict | None:
    """The signed-in user ``{id, username}`` for a cookie value, or None."""
    if not token or len(token) > 256:
        return None
    key = token_key(token)
    row = db.one(
        "SELECT u.id, u.username, s.expires FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?",
        (key,),
    )
    if row is None:
        return None
    if row["expires"] <= now_ms():
        db.execute("DELETE FROM sessions WHERE token = ?", (key,))
        return None
    return {"id": row["id"], "username": row["username"]}


def end_session(db: Database, token: str | None) -> None:
    if token:
        db.execute("DELETE FROM sessions WHERE token = ?", (token_key(token),))


def end_other_sessions(db: Database, user_id: str, keep_token: str | None) -> None:
    db.execute(
        "DELETE FROM sessions WHERE user_id = ? AND token != ?",
        (user_id, token_key(keep_token) if keep_token else ""),
    )


# ---------------------------------------------------------------------------- cookie
def cookie_secure(request: Request, force: bool) -> bool:
    """Secure when forced (COOKIE_SECURE=1), the request is https, or a proxy says it was."""
    if force or request.url.scheme == "https":
        return True
    proto = request.headers.get("x-forwarded-proto", "")
    return proto.split(",")[0].strip().lower() == "https"


def set_session_cookie(response: Response, token: str, days: int, secure: bool) -> None:
    response.set_cookie(
        COOKIE_NAME, token, max_age=days * 86_400, path="/", secure=secure, httponly=True, samesite="lax"
    )


def clear_session_cookie(response: Response, secure: bool) -> None:
    response.delete_cookie(COOKIE_NAME, path="/", secure=secure, httponly=True, samesite="lax")


# ---------------------------------------------------------------------------- lock-out
def lock_key(username: object) -> str:
    return str(username).strip().lower()[:64]


def lock_remaining_ms(db: Database, key: str, now: int | None = None) -> int:
    """Milliseconds left on this username's lock (0 when not locked)."""
    now = now_ms() if now is None else now
    until = db.value("SELECT locked_until FROM login_attempts WHERE key = ?", (key,))
    return max(0, until - now) if until else 0


def record_failure(db: Database, key: str, now: int | None = None) -> None:
    now = now_ms() if now is None else now
    with db.tx():
        row = db.one("SELECT count, locked_until FROM login_attempts WHERE key = ?", (key,))
        count = row["count"] if row else 0
        if row and row["locked_until"] and row["locked_until"] <= now:
            count = 0  # the previous lock ran out: start counting afresh
        count += 1
        locked_until = now + LOCK_MS if count >= LOCK_AFTER else None
        db.execute(
            "INSERT INTO login_attempts (key, count, locked_until) VALUES (?, ?, ?) "
            "ON CONFLICT(key) DO UPDATE SET count = excluded.count, locked_until = excluded.locked_until",
            (key, count, locked_until),
        )
        db.execute(
            "DELETE FROM login_attempts WHERE locked_until IS NOT NULL AND locked_until < ?",
            (now - _STALE_LOCK_MS,),
        )


def clear_failures(db: Database, key: str) -> None:
    db.execute("DELETE FROM login_attempts WHERE key = ?", (key,))
