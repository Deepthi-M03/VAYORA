"""Tamper-proof fare quotes.

The browser never sends a fare. It receives a signed quote token from /rides/quote and sends
only that token back on /rides/book. The server verifies the HMAC, checks expiry and that the
pickup/drop/category in the token match the booking, then recomputes the fare itself.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time


class QuoteError(ValueError):
    pass


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def sign_quote(payload: dict, secret: str, ttl_seconds: int = 300, now: float | None = None) -> str:
    body = dict(payload, exp=int((now or time.time()) + ttl_seconds))
    raw = json.dumps(body, sort_keys=True, separators=(",", ":")).encode()
    sig = hmac.new(secret.encode(), raw, hashlib.sha256).digest()
    return f"{_b64(raw)}.{_b64(sig)}"


def verify_quote(token: str, secret: str, now: float | None = None) -> dict:
    try:
        raw_b64, sig_b64 = token.split(".")
        raw, sig = _unb64(raw_b64), _unb64(sig_b64)
    except Exception as exc:  # noqa: BLE001
        raise QuoteError("malformed quote") from exc
    if not hmac.compare_digest(sig, hmac.new(secret.encode(), raw, hashlib.sha256).digest()):
        raise QuoteError("quote signature invalid")
    body = json.loads(raw)
    if body.get("exp", 0) < (now or time.time()):
        raise QuoteError("quote expired, please refresh the fare")
    return body
