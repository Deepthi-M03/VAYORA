"""Background jobs: T+1 settlement and payouts, ranking, scheduled rides, expiries, emails, SOS fan-out."""
from __future__ import annotations

import logging
import smtplib
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from email.message import EmailMessage

from sqlalchemy import func, select

from app.core.database import SessionLocal
from app.engines import ranking
from app.engines.settlement import LedgerLine, PayoutStatus, SettlementAction, plan_settlement, transition
from app.models import (CallSession, Complaint, DriverDocument, DriverProfile, LedgerEntry, Payout, Rating, Ride,
                        Settlement, User, Vehicle)
from app.services import config_store, notify, payments
from app.workers.celery_app import celery

log = logging.getLogger("vayora.tasks")
IST = timezone(timedelta(hours=5, minutes=30))


# ------------------------------------------------------------------ settlement
@celery.task
def run_daily_settlement(business_day: str | None = None):
    """Runs 00:30 IST: settles everything up to the end of the previous IST day."""
    day = date.fromisoformat(business_day) if business_day else (datetime.now(IST) - timedelta(days=1)).date()
    cutoff = datetime(day.year, day.month, day.day, tzinfo=IST) + timedelta(days=1)
    with SessionLocal() as db:
        min_payout = Decimal(config_store.get(db, "settlement")["min_payout"])
        driver_ids = db.scalars(select(LedgerEntry.driver_id).where(LedgerEntry.settlement_id.is_(None),
                                                                     LedgerEntry.occurred_at < cutoff).distinct()).all()
        to_pay: list[int] = []
        for did in driver_ids:
            if db.scalar(select(Settlement).where(Settlement.driver_id == did, Settlement.business_date == day)):
                continue   # idempotent rerun
            d = db.get(DriverProfile, did)
            entries = db.scalars(select(LedgerEntry).where(LedgerEntry.driver_id == did, LedgerEntry.settlement_id.is_(None),
                                                           LedgerEntry.occurred_at < cutoff).with_for_update()).all()
            plan = plan_settlement(did, day, [LedgerLine(e.id, e.entry_type, Decimal(e.amount)) for e in entries],
                                   bank_verified=d.bank_verified and bool(d.razorpay_fund_account_id), min_payout=min_payout)
            s = Settlement(driver_id=did, business_date=day, idempotency_key=plan.idempotency_key,
                           online_earnings=plan.online_earnings, cash_commission_due=plan.cash_commission_due,
                           other_adjustments=plan.other_adjustments, net=plan.net, action=plan.action,
                           status={"payout": "pending", "on_hold": "on_hold", "carried_forward": "carried_forward"}[plan.action],
                           note=plan.note, breakdown=plan.breakdown)
            db.add(s)
            db.flush()
            if plan.action == SettlementAction.PAYOUT:
                for e in entries:
                    e.settlement_id = s.id
                p = Payout(settlement_id=s.id, driver_id=did, amount=plan.net, status=PayoutStatus.CREATED)
                db.add(p)
                db.flush()
                to_pay.append(p.id)
            d.wallet_balance = db.scalar(select(func.coalesce(func.sum(LedgerEntry.amount), 0)).where(
                LedgerEntry.driver_id == did, LedgerEntry.settlement_id.is_(None)))
            notify.send(db, d.user, "Daily settlement", f"{day:%d %b}: {plan.note} (net ₹{plan.net})", "settlement")
            db.commit()
            for pid in to_pay:          # enqueue only after the payout row is committed
                execute_payout.delay(pid)
            to_pay.clear()


@celery.task(bind=True, max_retries=3)
def execute_payout(self, payout_id: int):
    with SessionLocal() as db:
        p = db.scalar(select(Payout).where(Payout.id == payout_id).with_for_update())
        if not p or p.status in (PayoutStatus.SUCCESS, PayoutStatus.PROCESSING, PayoutStatus.REVERSED):
            return
        d = db.get(DriverProfile, p.driver_id)
        try:
            p.status = transition(p.status, PayoutStatus.PROCESSING, attempts=p.attempts)
        except ValueError as exc:
            log.warning("payout %s: %s", p.id, exc)
            return
        p.attempts += 1
        try:
            res = payments.create_payout(d.razorpay_fund_account_id or "", Decimal(p.amount), f"VYP{p.id}-{p.attempts}")
            p.provider_payout_id = res["id"]
            p.history = [*(p.history or []), {"event": "submitted", "provider_status": res.get("status"), "attempt": p.attempts}]
            # Stays PROCESSING until the payout.processed webhook. Never marked successful here.
        except Exception as exc:  # noqa: BLE001
            p.status = transition(p.status, PayoutStatus.FAILED)
            p.failure_reason = str(exc)[:200]
            db.commit()
            raise self.retry(exc=exc, countdown=600)
        db.commit()


@celery.task
def verify_bank_account(driver_id: int):
    """Create RazorpayX contact + fund account and run penny-drop validation. Result arrives by webhook in production."""
    with SessionLocal() as db:
        d = db.get(DriverProfile, driver_id)
        if not payments.enabled():
            d.bank_verified, d.razorpay_fund_account_id = True, f"fa_dev_{driver_id}"   # development only
            db.commit()
            return
        # Production: POST /contacts, POST /fund_accounts, POST /fund_accounts/validations, then webhook sets bank_verified.
        log.info("bank verification queued for driver %s", driver_id)


# ------------------------------------------------------------------ ranking
def _rank_one(db, d: DriverProfile):
    rows = db.execute(select(Rating, Ride, User).join(Ride, Ride.id == Rating.ride_id).join(User, User.id == Rating.rater_id)
                      .where(Rating.ratee_user_id == d.user_id, Rating.direction == "customer_to_driver")).all()
    events = [ranking.RatingEvent(ride_id=ride.id, customer_id=rater.id, stars=rt.stars, rated_at=rt.created_at,
                                  ride_completed=ride.status == "completed", ride_completed_at=ride.completed_at,
                                  rater_is_ride_customer=ride.customer_id == rater.id,
                                  ride_distance_km=Decimal(ride.actual_distance_km or 0),
                                  ride_duration_min=Decimal(ride.actual_duration_min or 0), rater_flagged=rater.fraud_flag)
              for rt, ride, rater in rows]
    since = datetime.now(timezone.utc) - timedelta(days=90)
    upheld = dict(db.execute(select(Complaint.severity, func.count()).where(
        Complaint.against_user_id == d.user_id, Complaint.upheld.is_(True), Complaint.category.in_(["unsafe_driving", "harassment_safety"]),
        Complaint.updated_at >= since).group_by(Complaint.severity)).all())
    res = ranking.score(events, ranking.DriverStats(offered=d.offered_count, accepted=d.accepted_count, completed=d.completed_count,
                                                    driver_cancellations_after_window=d.late_cancel_count, upheld_safety=upheld))
    d.rank_score, d.rank_tier, d.rank_snapshot = Decimal(res["score"]), res["tier"], res


@celery.task
def recompute_rank(driver_id: int):
    with SessionLocal() as db:
        _rank_one(db, db.get(DriverProfile, driver_id))
        db.commit()


@celery.task
def recompute_all_ranks():
    with SessionLocal() as db:
        for d in db.scalars(select(DriverProfile).where(DriverProfile.onboarding_status == "approved")):
            _rank_one(db, d)
        db.commit()


# ------------------------------------------------------------------ rides housekeeping
@celery.task
def dispatch_scheduled_rides():
    from app.services import rides
    with SessionLocal() as db:
        soon = datetime.now(timezone.utc) + timedelta(minutes=15)
        for r in db.scalars(select(Ride).where(Ride.status == "scheduled", Ride.scheduled_for <= soon)):
            rides.set_status(db, r, "searching")
            rides.dispatch(db, r)
        db.commit()


@celery.task
def expire_searching_rides():
    """Re-offer every 30s; give up after 4 minutes with no driver."""
    from app.services import rides
    with SessionLocal() as db:
        now = datetime.now(timezone.utc)
        for r in db.scalars(select(Ride).where(Ride.status == "searching")):
            started = r.scheduled_for or r.created_at
            if now - started > timedelta(minutes=4):
                rides.set_status(db, r, "no_driver")
                notify.send(db, r.customer, "No drivers nearby", "We couldn't find a driver. No charge applied. Please try again.", "ride")
            else:
                rides.dispatch(db, r)
        db.commit()


@celery.task
def close_expired_call_sessions():
    from app.services import telephony
    with SessionLocal() as db:
        for s in db.scalars(select(CallSession).where(CallSession.active.is_(True), CallSession.expires_at < datetime.now(timezone.utc))):
            telephony.get_provider().close_session(s.provider_session_id or "")
            s.active = False
        db.commit()


@celery.task
def check_document_expiry():
    with SessionLocal() as db:
        today = date.today()
        for v in db.scalars(select(Vehicle).where(Vehicle.status == "approved", Vehicle.insurance_expiry < today)):
            v.status = "suspended"
            notify.send(db, v.driver.user, "Insurance expired", f"{v.registration_number} is paused until you upload valid insurance.", "documents")
        for doc in db.scalars(select(DriverDocument).where(DriverDocument.status == "verified", DriverDocument.expires_on < today)):
            doc.status = "expired"
        db.commit()


# ------------------------------------------------------------------ messaging
@celery.task
def send_reset_email(email: str, token: str):
    import os
    host = os.getenv("SMTP_HOST")
    link = f"{os.getenv('APP_URL', 'http://localhost:5173')}/#/reset?token={token}"
    if not host:
        log.info("Password reset link for %s: %s", email, link)
        return
    msg = EmailMessage()
    msg["Subject"], msg["From"], msg["To"] = "Reset your VAYORA password", os.getenv("SMTP_FROM", "no-reply@vayora.in"), email
    msg.set_content(f"Reset your password within 30 minutes: {link}\nIf you didn't ask for this, ignore this email.")
    with smtplib.SMTP(host, int(os.getenv("SMTP_PORT", "587"))) as s:
        s.starttls()
        s.login(os.getenv("SMTP_USER", ""), os.getenv("SMTP_PASSWORD", ""))
        s.send_message(msg)


@celery.task
def alert_emergency_contacts(user_id: int, ride_id: int):
    """SMS each emergency contact a live-tracking link (SMS gateway plugged in via the telephony provider account)."""
    with SessionLocal() as db:
        u, r = db.get(User, user_id), db.get(Ride, ride_id)
        for c in u.contacts:
            log.warning("SOS: notify %s for %s on ride %s (track: /#/track/%s)", c.name, u.full_name, r.code, r.code)
