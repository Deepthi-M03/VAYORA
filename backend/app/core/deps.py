"""FastAPI dependencies: current user, role guards, permission guards, audit logging."""
from __future__ import annotations

from datetime import datetime, timezone

import jwt
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.security import ADMIN_ROLES, decode_token
from app.models import AuditLog, User

bearer = HTTPBearer(auto_error=False)


def current_user(creds: HTTPAuthorizationCredentials | None = Depends(bearer), db: Session = Depends(get_db)) -> User:
    if not creds:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not signed in")
    try:
        data = decode_token(creds.credentials)
    except jwt.PyJWTError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session expired, please sign in again")
    user = db.get(User, int(data["sub"]))
    if not user or user.session_version != data.get("sv"):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session revoked")
    if user.status in ("suspended", "deactivated"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, f"Account {user.status}. Contact support to appeal.")
    return user


def require_role(*roles: str):
    def guard(user: User = Depends(current_user)) -> User:
        if user.role not in roles:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Not allowed for this account type")
        return user
    return guard


def require_perm(perm: str):
    def guard(user: User = Depends(require_role("admin"))) -> User:
        if perm not in ADMIN_ROLES.get(user.admin_role or "", set()):
            raise HTTPException(status.HTTP_403_FORBIDDEN, f"Missing permission {perm}")
        return user
    return guard


def audit(db: Session, request: Request | None, actor: User | None, action: str, entity: str,
          entity_id=None, before: dict | None = None, after: dict | None = None, reason: str | None = None) -> None:
    """Add an audit row in the caller's transaction, so the change and its log commit together."""
    db.add(AuditLog(
        at=datetime.now(timezone.utc), actor_id=actor.id if actor else None,
        actor_role=(actor.admin_role or actor.role) if actor else "system", action=action, entity=entity,
        entity_id=None if entity_id is None else str(entity_id), before=before, after=after, reason=reason,
        ip=request.client.host if request and request.client else None,
        user_agent=(request.headers.get("user-agent", "")[:200] if request else None),
    ))


def snapshot(obj, fields: list[str]) -> dict:
    out = {}
    for f in fields:
        v = getattr(obj, f, None)
        out[f] = v if isinstance(v, (int, float, bool, str, type(None), list, dict)) else str(v)
    return out
