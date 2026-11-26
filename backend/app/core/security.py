"""Password hashing, JWTs, and permission constants for RBAC."""
from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone

import jwt
from passlib.context import CryptContext

from .config import get_settings

pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")


def hash_password(p: str) -> str:
    return pwd.hash(p)


def verify_password(p: str, h: str) -> bool:
    return bool(h) and pwd.verify(p, h)


def create_token(sub: int, role: str, kind: str = "access", session_version: int = 0) -> str:
    s = get_settings()
    exp = timedelta(minutes=s.JWT_ACCESS_MINUTES) if kind == "access" else timedelta(days=s.JWT_REFRESH_DAYS)
    now = datetime.now(timezone.utc)
    return jwt.encode({"sub": str(sub), "role": role, "typ": kind, "sv": session_version,
                       "iat": now, "exp": now + exp, "jti": secrets.token_hex(8)}, s.JWT_SECRET, algorithm="HS256")


def decode_token(token: str, kind: str = "access") -> dict:
    data = jwt.decode(token, get_settings().JWT_SECRET, algorithms=["HS256"])
    if data.get("typ") != kind:
        raise jwt.InvalidTokenError("wrong token type")
    return data


def reset_token() -> tuple[str, str]:
    """Returns (raw token emailed to user, sha256 stored in DB)."""
    import hashlib
    raw = secrets.token_urlsafe(32)
    return raw, hashlib.sha256(raw.encode()).hexdigest()


# --- RBAC -------------------------------------------------------------------------------
class Perm:
    VIEW_DASHBOARD = "dashboard:view"
    MANAGE_CUSTOMERS = "customers:manage"
    MANAGE_DRIVERS = "drivers:manage"
    VERIFY_DOCUMENTS = "documents:verify"
    MANAGE_VEHICLES = "vehicles:manage"
    MANAGE_CITIES = "cities:manage"
    ACTIVATE_CITIES = "cities:activate"          # super admin only
    MANAGE_PRICING = "pricing:manage"
    MANAGE_FINANCE = "finance:manage"
    VIEW_FINANCE = "finance:view"
    MANAGE_COMPLAINTS = "complaints:manage"
    MANAGE_CONFIG = "config:manage"
    MANAGE_ADMINS = "admins:manage"
    VIEW_AUDIT = "audit:view"


ADMIN_ROLES: dict[str, set[str]] = {
    "super_admin": {v for k, v in vars(Perm).items() if not k.startswith("_")},
    "ops_admin": {Perm.VIEW_DASHBOARD, Perm.MANAGE_CUSTOMERS, Perm.MANAGE_DRIVERS, Perm.VERIFY_DOCUMENTS,
                  Perm.MANAGE_VEHICLES, Perm.MANAGE_CITIES, Perm.MANAGE_COMPLAINTS, Perm.VIEW_AUDIT},
    "finance_admin": {Perm.VIEW_DASHBOARD, Perm.VIEW_FINANCE, Perm.MANAGE_FINANCE, Perm.MANAGE_PRICING, Perm.VIEW_AUDIT},
    "support_agent": {Perm.VIEW_DASHBOARD, Perm.MANAGE_COMPLAINTS, Perm.MANAGE_CUSTOMERS},
}
