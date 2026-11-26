"""Field-level encryption for bank account numbers (Fernet key derived from JWT_SECRET; use KMS in production)."""
import base64
import hashlib

from cryptography.fernet import Fernet

from app.core.config import get_settings


def _f() -> Fernet:
    key = hashlib.sha256(("vayora-field:" + get_settings().JWT_SECRET).encode()).digest()
    return Fernet(base64.urlsafe_b64encode(key))


def encrypt(s: str) -> str:
    return _f().encrypt(s.encode()).decode()


def decrypt(s: str) -> str:
    return _f().decrypt(s.encode()).decode()
