from datetime import datetime
from enum import Enum

from pydantic import BaseModel, Field


class Role(str, Enum):
    user = "user"
    admin = "admin"


class AuthUser(BaseModel):
    id: str
    name: str
    email: str
    role: Role = Role.user


class StoredUser(BaseModel):
    id: str
    name: str
    email: str
    password_hash: str
    role: Role = Role.user
    created_at: datetime
    last_login_at: datetime | None = None
    login_count: int = 0

    def public(self) -> AuthUser:
        return AuthUser(id=self.id, name=self.name, email=self.email, role=self.role)


class SessionRecord(BaseModel):
    id: str
    token_digest: str
    user_id: str
    name: str
    email: str
    role: Role
    created_at: datetime
    last_seen_at: datetime
    expires_at: datetime
    ip: str | None = None
    user_agent: str | None = None


class RegisterRequest(BaseModel):
    name: str = Field(max_length=80)
    email: str = Field(max_length=254)
    password: str = Field(max_length=128)


class LoginRequest(BaseModel):
    email: str = Field(max_length=254)
    password: str = Field(max_length=128)


class LoginResponse(BaseModel):
    token: str
    expires_at: datetime
    user: AuthUser


class AdminSession(BaseModel):
    id: str
    user_id: str
    name: str
    email: str
    role: Role
    signed_in_at: datetime
    last_seen_at: datetime
    expires_at: datetime
    online: bool
    ip: str | None = None
    user_agent: str | None = None


class AdminUser(BaseModel):
    id: str
    name: str
    email: str
    role: Role
    created_at: datetime
    last_login_at: datetime | None = None
    last_seen_at: datetime | None = None
    login_count: int
    signed_in: bool
    online: bool
    active_sessions: int


class AdminOverview(BaseModel):
    total_users: int
    signed_in_users: int
    online_users: int
    users: list[AdminUser]
    sessions: list[AdminSession]
