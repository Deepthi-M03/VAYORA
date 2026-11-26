"""In-app notifications + Firebase Cloud Messaging push. Push failure never breaks a request."""
from __future__ import annotations

import logging

from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models import Notification, User
from app.services.realtime import publish_sync

log = logging.getLogger("vayora.notify")
_fcm_app = None


def _fcm():
    global _fcm_app
    path = get_settings().FCM_CREDENTIALS_FILE
    if not path:
        return None
    if _fcm_app is None:
        import firebase_admin
        from firebase_admin import credentials
        _fcm_app = firebase_admin.initialize_app(credentials.Certificate(path))
    return _fcm_app


def send(db: Session, user: User, title: str, body: str, kind: str, data: dict | None = None):
    n = Notification(user_id=user.id, title=title, body=body, kind=kind, data=data or {})
    db.add(n)
    publish_sync(f"user:{user.id}", "notification", {"title": title, "body": body, "kind": kind, "data": data or {}})
    if user.fcm_token and _fcm():
        try:
            from firebase_admin import messaging
            messaging.send(messaging.Message(token=user.fcm_token,
                                             notification=messaging.Notification(title=title, body=body),
                                             data={k: str(v) for k, v in (data or {}).items()}))
        except Exception as exc:  # noqa: BLE001
            log.warning("FCM push failed for user %s: %s", user.id, exc)
