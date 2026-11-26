"""Razorpay checkout + webhooks (payments and RazorpayX payouts)."""
import json
from datetime import datetime, timezone
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.database import get_db
from app.core.deps import audit, require_role
from app.engines.settlement import PayoutStatus, transition
from app.models import PaymentTxn, Payout, Ride, Settlement, User
from app.services import ledger, payments

router = APIRouter(prefix="/payments", tags=["payments"])


@router.post("/rides/{ride_id}/order")
def create_order(ride_id: int, user: User = Depends(require_role("customer")), db: Session = Depends(get_db)):
    r = db.get(Ride, ride_id)
    if not r or r.customer_id != user.id or r.status != "completed" or r.payment_method != "online":
        raise HTTPException(409, "Nothing to pay for this ride")
    if r.payment_status == "paid":
        raise HTTPException(409, "Already paid")
    amount = Decimal(r.final_total) - Decimal(r.discount or 0)       # computed by the server, never by the client
    order = payments.create_order(amount, receipt=r.code)
    db.add(PaymentTxn(ride_id=r.id, customer_id=user.id, amount=amount, method="online", provider_order_id=order["id"], raw=order))
    db.commit()
    return {"order_id": order["id"], "amount_paise": order["amount"], "currency": "INR",
            "key_id": get_settings().RAZORPAY_KEY_ID, "dev_mode": bool(order.get("dev"))}


class VerifyIn(BaseModel):
    razorpay_order_id: str
    razorpay_payment_id: str
    razorpay_signature: str


@router.post("/verify")
def verify(body: VerifyIn, user: User = Depends(require_role("customer")), db: Session = Depends(get_db)):
    txn = db.scalar(select(PaymentTxn).where(PaymentTxn.provider_order_id == body.razorpay_order_id))
    if not txn or txn.customer_id != user.id:
        raise HTTPException(404, "Order not found")
    dev_ok = (not payments.enabled() and get_settings().ENV != "production"
              and body.razorpay_order_id.startswith("order_dev_"))      # local development without Razorpay keys
    if not dev_ok and not payments.verify_checkout_signature(body.razorpay_order_id, body.razorpay_payment_id, body.razorpay_signature):
        raise HTTPException(400, "Payment signature invalid")
    _capture(db, txn, body.razorpay_payment_id)
    db.commit()
    return {"ok": True}


def _capture(db: Session, txn: PaymentTxn, payment_id: str):
    if txn.status == "captured":
        return  # idempotent: checkout callback and webhook may both arrive
    txn.status, txn.provider_payment_id = "captured", payment_id
    r = db.get(Ride, txn.ride_id)
    r.payment_status = "paid"
    ledger.post_ride(db, r)   # driver's online earning enters the ledger -> next-day settlement


@router.post("/webhook")
async def webhook(request: Request, db: Session = Depends(get_db)):
    body = await request.body()
    if not payments.verify_webhook(body, request.headers.get("X-Razorpay-Signature", "")):
        raise HTTPException(400, "Bad signature")
    evt = json.loads(body)
    kind = evt.get("event", "")
    pl = evt.get("payload", {})
    if kind == "payment.captured":
        p = pl["payment"]["entity"]
        txn = db.scalar(select(PaymentTxn).where(PaymentTxn.provider_order_id == p.get("order_id")))
        if txn:
            _capture(db, txn, p["id"])
    elif kind == "payment.failed":
        p = pl["payment"]["entity"]
        txn = db.scalar(select(PaymentTxn).where(PaymentTxn.provider_order_id == p.get("order_id")))
        if txn and txn.status != "captured":
            txn.status = "failed"
    elif kind.startswith("payout."):
        po = pl["payout"]["entity"]
        payout = db.scalar(select(Payout).where(Payout.provider_payout_id == po["id"]))
        if payout:
            _payout_event(db, payout, kind, po)
    db.commit()
    return {"ok": True}


def _payout_event(db: Session, payout: Payout, kind: str, po: dict):
    s = db.get(Settlement, payout.settlement_id)
    hist = [*(payout.history or []), {"event": kind, "at": datetime.now(timezone.utc).isoformat(), "status": po.get("status")}]
    if kind == "payout.processed" and payout.status != PayoutStatus.SUCCESS:
        payout.status = transition(payout.status, PayoutStatus.SUCCESS, provider_confirmed=True)
        payout.utr, payout.confirmed_at, s.status = po.get("utr"), datetime.now(timezone.utc), "paid"
    elif kind in ("payout.failed", "payout.rejected") and payout.status == PayoutStatus.PROCESSING:
        payout.status = transition(payout.status, PayoutStatus.FAILED)
        payout.failure_reason = (po.get("status_details") or {}).get("description") or po.get("failure_reason")
        s.status = "failed"
        # Entries stay locked to this settlement; the same payout is retried (auto backoff or admin) so it
        # can never be paid twice by a later settlement.
        from app.workers.tasks import execute_payout
        if payout.attempts < 5:
            execute_payout.apply_async((payout.id,), countdown=60 * 15 * payout.attempts)
    elif kind == "payout.reversed" and payout.status == PayoutStatus.SUCCESS:
        payout.status = transition(payout.status, PayoutStatus.REVERSED)
        s.status = "failed"
        _release_entries(db, s)
    payout.history = hist
    audit(db, None, None, kind, "payout", payout.id, None, {"status": payout.status, "utr": payout.utr})


def _release_entries(db: Session, s: Settlement):
    """Reversed payout (terminal): entries go back to 'unsettled' so tomorrow's settlement pays them once more."""
    from app.models import LedgerEntry
    for e in db.scalars(select(LedgerEntry).where(LedgerEntry.settlement_id == s.id)):
        e.settlement_id = None
    ledger.refresh_wallet(db, s.driver_id)
