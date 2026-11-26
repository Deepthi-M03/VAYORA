"""Razorpay (customer payments, refunds) and RazorpayX (driver payouts).

Nothing here ever marks money as moved on its own. Captures and payouts change state only
after an HMAC-verified callback or webhook from Razorpay.
"""
from __future__ import annotations

import hashlib
import hmac
import logging
import uuid
from decimal import Decimal

import requests

from app.core.config import get_settings

log = logging.getLogger("vayora.payments")
API = "https://api.razorpay.com/v1"


def _auth():
    s = get_settings()
    return (s.RAZORPAY_KEY_ID, s.RAZORPAY_KEY_SECRET)


def enabled() -> bool:
    s = get_settings()
    return bool(s.RAZORPAY_KEY_ID and s.RAZORPAY_KEY_SECRET)


def create_order(amount: Decimal, receipt: str) -> dict:
    paise = int((amount * 100).to_integral_value())
    if not enabled():
        return {"id": f"order_dev_{uuid.uuid4().hex[:12]}", "amount": paise, "currency": "INR", "dev": True}
    r = requests.post(f"{API}/orders", auth=_auth(), json={"amount": paise, "currency": "INR", "receipt": receipt}, timeout=15)
    r.raise_for_status()
    return r.json()


def verify_checkout_signature(order_id: str, payment_id: str, signature: str) -> bool:
    secret = get_settings().RAZORPAY_KEY_SECRET.encode()
    expected = hmac.new(secret, f"{order_id}|{payment_id}".encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature or "")


def verify_webhook(body: bytes, signature: str) -> bool:
    secret = get_settings().RAZORPAY_WEBHOOK_SECRET.encode()
    if not secret:
        return False
    return hmac.compare_digest(hmac.new(secret, body, hashlib.sha256).hexdigest(), signature or "")


def refund(payment_id: str, amount: Decimal, note: str) -> dict:
    if not enabled():
        return {"id": f"rfnd_dev_{uuid.uuid4().hex[:10]}", "status": "pending", "dev": True}
    r = requests.post(f"{API}/payments/{payment_id}/refund", auth=_auth(),
                      json={"amount": int(amount * 100), "notes": {"reason": note}}, timeout=15)
    r.raise_for_status()
    return r.json()


def create_payout(fund_account_id: str, amount: Decimal, reference: str) -> dict:
    """RazorpayX payout. Returns the provider object; status is 'queued'/'processing' until webhook."""
    s = get_settings()
    if not enabled() or not s.RAZORPAYX_ACCOUNT_NUMBER:
        return {"id": f"pout_dev_{uuid.uuid4().hex[:10]}", "status": "processing", "dev": True}
    r = requests.post(f"{API}/payouts", auth=_auth(), timeout=20,
                      headers={"X-Payout-Idempotency": reference},
                      json={"account_number": s.RAZORPAYX_ACCOUNT_NUMBER, "fund_account_id": fund_account_id,
                            "amount": int(amount * 100), "currency": "INR", "mode": "IMPS",
                            "purpose": "payout", "queue_if_low_balance": True, "reference_id": reference})
    r.raise_for_status()
    return r.json()
