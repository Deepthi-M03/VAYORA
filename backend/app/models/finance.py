from datetime import date, datetime

from sqlalchemy import JSON, Date, DateTime, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from ._base import Timestamps, Money, Decimal


class LedgerEntry(Timestamps, Base):
    """Immutable driver ledger. Corrections are new rows, never updates of amount.

    The (ride_id, entry_type) unique key makes posting idempotent: completing a ride twice,
    or replaying a webhook, cannot deduct commission twice.
    """
    __tablename__ = "ledger_entries"
    __table_args__ = (UniqueConstraint("ride_id", "entry_type", "reference", name="uq_ledger_idem"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    driver_id: Mapped[int] = mapped_column(ForeignKey("driver_profiles.id"), index=True)
    ride_id: Mapped[int | None] = mapped_column(ForeignKey("rides.id"), index=True)
    entry_type: Mapped[str] = mapped_column(String(30), index=True)
    reference: Mapped[str] = mapped_column(String(60), default="")   # refund id / adjustment id
    amount: Mapped[Decimal] = mapped_column(Money)                    # + owed to driver, - owed by driver
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    settlement_id: Mapped[int | None] = mapped_column(ForeignKey("settlements.id"), index=True)
    memo: Mapped[str] = mapped_column(String(200), default="")
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))


class Settlement(Timestamps, Base):
    __tablename__ = "settlements"
    __table_args__ = (UniqueConstraint("driver_id", "business_date"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    driver_id: Mapped[int] = mapped_column(ForeignKey("driver_profiles.id"), index=True)
    business_date: Mapped[date] = mapped_column(Date, index=True)
    idempotency_key: Mapped[str] = mapped_column(String(60), unique=True)
    online_earnings: Mapped[Decimal] = mapped_column(Money)
    cash_commission_due: Mapped[Decimal] = mapped_column(Money)
    other_adjustments: Mapped[Decimal] = mapped_column(Money)
    net: Mapped[Decimal] = mapped_column(Money)
    action: Mapped[str] = mapped_column(String(20))      # payout | on_hold | carried_forward
    status: Mapped[str] = mapped_column(String(20))      # pending | paid | failed | carried_forward | on_hold
    note: Mapped[str] = mapped_column(String(200), default="")
    breakdown: Mapped[dict] = mapped_column(JSON, default=dict)


class Payout(Timestamps, Base):
    __tablename__ = "payouts"
    id: Mapped[int] = mapped_column(primary_key=True)
    settlement_id: Mapped[int] = mapped_column(ForeignKey("settlements.id"), unique=True)
    driver_id: Mapped[int] = mapped_column(ForeignKey("driver_profiles.id"), index=True)
    amount: Mapped[Decimal] = mapped_column(Money)
    status: Mapped[str] = mapped_column(String(20), default="created", index=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    provider: Mapped[str] = mapped_column(String(20), default="razorpayx")
    provider_payout_id: Mapped[str | None] = mapped_column(String(60), unique=True)
    utr: Mapped[str | None] = mapped_column(String(40))          # bank reference, from provider only
    failure_reason: Mapped[str | None] = mapped_column(String(200))
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    history: Mapped[list] = mapped_column(JSON, default=list)


class PaymentTxn(Timestamps, Base):
    """Customer payments via Razorpay. ``status=captured`` only from a verified signature/webhook."""
    __tablename__ = "payment_txns"
    id: Mapped[int] = mapped_column(primary_key=True)
    ride_id: Mapped[int] = mapped_column(ForeignKey("rides.id"), index=True)
    customer_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    amount: Mapped[Decimal] = mapped_column(Money)
    method: Mapped[str] = mapped_column(String(10))        # online | cash
    provider_order_id: Mapped[str | None] = mapped_column(String(60), unique=True)
    provider_payment_id: Mapped[str | None] = mapped_column(String(60), unique=True)
    status: Mapped[str] = mapped_column(String(20), default="created")  # created|captured|failed|refunded|cash_recorded
    raw: Mapped[dict] = mapped_column(JSON, default=dict)


class Refund(Timestamps, Base):
    __tablename__ = "refunds"
    id: Mapped[int] = mapped_column(primary_key=True)
    ride_id: Mapped[int] = mapped_column(ForeignKey("rides.id"), index=True)
    payment_id: Mapped[int | None] = mapped_column(ForeignKey("payment_txns.id"))
    amount: Mapped[Decimal] = mapped_column(Money)
    reason: Mapped[str] = mapped_column(String(200))
    status: Mapped[str] = mapped_column(String(20), default="initiated")  # initiated|processed|failed
    provider_refund_id: Mapped[str | None] = mapped_column(String(60))
    commission_reversal: Mapped[Decimal] = mapped_column(Money, default=0)
    driver_reversal: Mapped[Decimal] = mapped_column(Money, default=0)
    requested_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
