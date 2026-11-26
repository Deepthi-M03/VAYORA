"""Posts ride money to the driver ledger. Idempotent through the uq_ledger_idem constraint."""
from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.engines.settlement import EntryType
from app.models import DriverProfile, LedgerEntry, Ride


def post(db: Session, driver_id: int, entry_type: str, amount: Decimal, *, ride_id: int | None = None,
         reference: str = "", memo: str = "", created_by: int | None = None) -> LedgerEntry | None:
    """Insert in a SAVEPOINT so a duplicate is silently ignored without aborting the outer transaction."""
    entry = LedgerEntry(driver_id=driver_id, ride_id=ride_id, entry_type=entry_type, reference=reference,
                        amount=amount, occurred_at=datetime.now(timezone.utc), memo=memo, created_by=created_by)
    try:
        with db.begin_nested():
            db.add(entry)
            db.flush()
    except IntegrityError:
        return None
    refresh_wallet(db, driver_id)
    return entry


def refresh_wallet(db: Session, driver_id: int):
    bal = db.scalar(select(func.coalesce(func.sum(LedgerEntry.amount), 0))
                    .where(LedgerEntry.driver_id == driver_id, LedgerEntry.settlement_id.is_(None)))
    db.get(DriverProfile, driver_id).wallet_balance = bal


def post_ride(db: Session, ride: Ride):
    if ride.payment_method == "online":
        post(db, ride.driver_id, EntryType.RIDE_EARNING_ONLINE, Decimal(ride.driver_earnings), ride_id=ride.id,
             memo=f"Ride {ride.code}: fare ₹{ride.ride_fare} − commission ₹{ride.company_commission}")
    else:
        # Driver collected the cash; they owe the platform its commission (+ commission tax). A coupon is
        # company-funded, so the cash the driver did NOT collect is offset here (can make the entry positive).
        snap = ride.commission_snapshot or {}
        owed = (Decimal(ride.company_commission) + Decimal(snap.get("commission_tax", "0")) - Decimal(ride.discount or 0)
                + Decimal(snap.get("prior_dues", "0")))   # driver also collected the rider's old cancellation fee
        post(db, ride.driver_id, EntryType.RIDE_COMMISSION_CASH, -owed, ride_id=ride.id,
             memo=f"Ride {ride.code}: cash ₹{Decimal(ride.final_total) - Decimal(ride.discount or 0)} collected, "
                  f"commission ₹{ride.company_commission} payable")
