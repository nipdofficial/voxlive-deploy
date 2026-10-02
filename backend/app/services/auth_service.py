"""Account and session storage for role-based sign-in.

Users and sessions are persisted as JSON under ``DATA_DIR`` (the same local
persistence model as transcript history). Passwords are hashed with PBKDF2 and
session tokens are stored only as SHA-256 digests, so neither file contains a
usable credential.

The administrator is not a stored account: it signs in with ``ADMIN_EMAIL`` /
``ADMIN_PASSWORD`` from the environment and that email can never be registered.
"""

import asyncio
import hashlib
import hmac
import json
import re
import secrets
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

from app.core.config import get_settings
from app.models.auth import AuthUser, Role, SessionRecord, StoredUser

ADMIN_USER_ID = "admin"
ONLINE_WINDOW = timedelta(minutes=2)
_PBKDF2_ITERATIONS = 390_000
_EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_MAX_FAILED_LOGINS = 5
_FAILED_LOGIN_WINDOW_SECONDS = 15 * 60


class AuthError(Exception):
    """A user-facing authentication failure."""

    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.status_code = status_code


def _now() -> datetime:
    return datetime.now(timezone.utc)


def normalize_email(email: str) -> str:
    return email.strip().lower()


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, _PBKDF2_ITERATIONS)
    return f"pbkdf2_sha256${_PBKDF2_ITERATIONS}${salt.hex()}${digest.hex()}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        _, iterations, salt, expected = encoded.split("$")
        digest = hashlib.pbkdf2_hmac(
            "sha256", password.encode(), bytes.fromhex(salt), int(iterations)
        )
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(digest.hex(), expected)


def _token_digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _write_json(path: Path, payload: str) -> None:
    """Atomically replace a store so a crash cannot leave partial JSON."""
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(payload, encoding="utf-8")
    temporary.replace(path)


class AuthStore:
    def __init__(self) -> None:
        self._users: dict[str, StoredUser] = {}
        self._sessions: dict[str, SessionRecord] = {}
        self._failed_logins: dict[str, list[float]] = {}
        self._lock = asyncio.Lock()
        self._loaded = False

    @property
    def _users_path(self) -> Path:
        return get_settings().data_dir / "users.json"

    @property
    def _sessions_path(self) -> Path:
        return get_settings().data_dir / "sessions.json"

    async def _ensure_loaded(self) -> None:
        if self._loaded:
            return
        async with self._lock:
            if self._loaded:
                return
            if self._users_path.exists():
                raw = await asyncio.to_thread(self._users_path.read_text, encoding="utf-8")
                for item in json.loads(raw or "[]"):
                    user = StoredUser.model_validate(item)
                    self._users[user.id] = user
            if self._sessions_path.exists():
                raw = await asyncio.to_thread(self._sessions_path.read_text, encoding="utf-8")
                for item in json.loads(raw or "[]"):
                    session = SessionRecord.model_validate(item)
                    self._sessions[session.token_digest] = session
            self._loaded = True

    async def _persist_users(self) -> None:
        payload = json.dumps(
            [user.model_dump(mode="json") for user in self._users.values()], indent=2
        )
        await asyncio.to_thread(_write_json, self._users_path, payload)

    async def _persist_sessions(self) -> None:
        now = _now()
        for digest in [d for d, s in self._sessions.items() if s.expires_at <= now]:
            del self._sessions[digest]
        payload = json.dumps(
            [session.model_dump(mode="json") for session in self._sessions.values()], indent=2
        )
        await asyncio.to_thread(_write_json, self._sessions_path, payload)

    def _find_user_by_email(self, email: str) -> StoredUser | None:
        return next((user for user in self._users.values() if user.email == email), None)

    def _check_rate_limit(self, key: str) -> None:
        cutoff = time.monotonic() - _FAILED_LOGIN_WINDOW_SECONDS
        attempts = [stamp for stamp in self._failed_logins.get(key, []) if stamp > cutoff]
        self._failed_logins[key] = attempts
        if len(attempts) >= _MAX_FAILED_LOGINS:
            raise AuthError("Too many failed sign-in attempts. Try again in 15 minutes.", 429)

    def _record_failure(self, key: str) -> None:
        self._failed_logins.setdefault(key, []).append(time.monotonic())

    async def register(self, name: str, email: str, password: str) -> AuthUser:
        await self._ensure_loaded()
        name = " ".join(name.split())
        email = normalize_email(email)
        if not name:
            raise AuthError("Enter your name")
        if not _EMAIL_PATTERN.match(email):
            raise AuthError("Enter a valid email address")
        if len(password) < 8:
            raise AuthError("Password must be at least 8 characters")
        admin_email = get_settings().admin_email
        if admin_email and email == normalize_email(admin_email):
            raise AuthError("This email cannot be registered", 409)
        async with self._lock:
            existing = self._find_user_by_email(email)
            if existing:
                # Repeated registration attempts with the same valid
                # credentials are harmless and recover the normal sign-in
                # path after a stale client session. Never overwrite the
                # stored password or accept a different password here.
                if verify_password(password, existing.password_hash):
                    return existing.public()
                raise AuthError("An account with this email already exists", 409)
            user = StoredUser(
                id=str(uuid4()),
                name=name,
                email=email,
                password_hash=hash_password(password),
                created_at=_now(),
            )
            self._users[user.id] = user
            await self._persist_users()
        return user.public()

    async def login(
        self, email: str, password: str, *, ip: str | None, user_agent: str | None
    ) -> tuple[str, SessionRecord]:
        await self._ensure_loaded()
        settings = get_settings()
        email = normalize_email(email)
        rate_key = f"{email}|{ip or ''}"
        self._check_rate_limit(rate_key)

        admin_email = normalize_email(settings.admin_email or "")
        if admin_email and email == admin_email:
            if not settings.admin_password or not hmac.compare_digest(
                password.encode(), settings.admin_password.encode()
            ):
                self._record_failure(rate_key)
                raise AuthError("Incorrect email or password", 401)
            identity = AuthUser(id=ADMIN_USER_ID, name="Administrator", email=admin_email, role=Role.admin)
        else:
            user = self._find_user_by_email(email)
            if user is None or not verify_password(password, user.password_hash):
                self._record_failure(rate_key)
                raise AuthError("Incorrect email or password", 401)
            identity = user.public()

        self._failed_logins.pop(rate_key, None)
        now = _now()
        token = secrets.token_urlsafe(32)
        session = SessionRecord(
            id=uuid4().hex[:12],
            token_digest=_token_digest(token),
            user_id=identity.id,
            name=identity.name,
            email=identity.email,
            role=identity.role,
            created_at=now,
            last_seen_at=now,
            expires_at=now + timedelta(hours=settings.auth_session_hours),
            ip=ip,
            user_agent=(user_agent or "")[:200] or None,
        )
        async with self._lock:
            self._sessions[session.token_digest] = session
            stored = self._users.get(identity.id)
            if stored is not None:
                stored.last_login_at = now
                stored.login_count += 1
                await self._persist_users()
            await self._persist_sessions()
        return token, session

    async def authenticate(self, token: str) -> SessionRecord | None:
        """Return the live session for ``token`` and refresh its activity time."""
        await self._ensure_loaded()
        digest = _token_digest(token)
        session = self._sessions.get(digest)
        if session is None:
            return None
        now = _now()
        if session.expires_at <= now:
            async with self._lock:
                self._sessions.pop(digest, None)
                await self._persist_sessions()
            return None
        if session.user_id != ADMIN_USER_ID and session.user_id not in self._users:
            return None
        # Keep actively used sessions alive. Persist activity at most once a
        # minute so the heartbeat does not cause excessive disk writes.
        should_persist = now - session.last_seen_at >= timedelta(seconds=60)
        session.expires_at = now + timedelta(hours=get_settings().auth_session_hours)
        if should_persist:
            session.last_seen_at = now
            async with self._lock:
                await self._persist_sessions()
        else:
            session.last_seen_at = now
        return session

    async def logout(self, token: str) -> None:
        await self._ensure_loaded()
        async with self._lock:
            if self._sessions.pop(_token_digest(token), None) is not None:
                await self._persist_sessions()

    async def revoke_session(self, session_id: str) -> bool:
        await self._ensure_loaded()
        async with self._lock:
            digest = next(
                (d for d, s in self._sessions.items() if s.id == session_id), None
            )
            if digest is None:
                return False
            del self._sessions[digest]
            await self._persist_sessions()
            return True

    async def list_users(self) -> list[StoredUser]:
        await self._ensure_loaded()
        return sorted(self._users.values(), key=lambda user: user.created_at, reverse=True)

    async def list_sessions(self) -> list[SessionRecord]:
        await self._ensure_loaded()
        now = _now()
        live = [session for session in self._sessions.values() if session.expires_at > now]
        return sorted(live, key=lambda session: session.last_seen_at, reverse=True)


def is_online(session: SessionRecord) -> bool:
    return _now() - session.last_seen_at <= ONLINE_WINDOW


auth_store = AuthStore()
