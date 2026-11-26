from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, Float, ForeignKey, Numeric, SmallInteger, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from ._base import Timestamps, Money, Decimal


class RideStatus:
    SCHEDULED = "scheduled"
    SEARCHING = "searching"
    ASSIGNED = "assigned"
    ARRIVED = "arrived"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    CANCELLED = "cancelled"
    NO_DRIVER = "no_driver"

    FLOW = {
        "scheduled": {"searching", "cancelled"},
        "searching": {"assigned", "cancelled", "no_driver"},
        "assigned": {"arrived", "cancelled", "searching"},   # back to searching if driver cancels
        "arrived": {"in_progress", "cancelled", "searching"},
        "in_progress": {"completed"},
        "completed": set(), "cancelled": set(), "no_driver": set(),
    }


class Ride(Timestamps, Base):
    __tablename__ = "rides"
    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(12), unique=True, index=True)   # e.g. VY8K2Q9M
    customer_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    driver_id: Mapped[int | None] = mapped_column(ForeignKey("driver_profiles.id"), index=True)
    vehicle_id: Mapped[int | None] = mapped_column(ForeignKey("vehicles.id"))
    city_id: Mapped[int] = mapped_column(ForeignKey("cities.id"), index=True)
    category_id: Mapped[int] = mapped_column(ForeignKey("vehicle_categories.id"), index=True)
    fare_rule_id: Mapped[int] = mapped_column(ForeignKey("fare_rules.id"))
    status: Mapped[str] = mapped_column(String(20), index=True, default=RideStatus.SEARCHING)

    pickup_address: Mapped[str] = mapped_column(String(300))
    pickup_lat: Mapped[float] = mapped_column(Float)
    pickup_lng: Mapped[float] = mapped_column(Float)
    drop_address: Mapped[str] = mapped_column(String(300))
    drop_lat: Mapped[float] = mapped_column(Float)
    drop_lng: Mapped[float] = mapped_column(Float)
    scheduled_for: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)

    est_distance_km: Mapped[Decimal] = mapped_column(Numeric(8, 2))
    est_duration_min: Mapped[Decimal] = mapped_column(Numeric(8, 1))
    est_fare_low: Mapped[Decimal] = mapped_column(Money)
    est_fare_high: Mapped[Decimal] = mapped_column(Money)
    est_breakdown: Mapped[dict] = mapped_column(JSON)

    actual_distance_km: Mapped[Decimal | None] = mapped_column(Numeric(8, 2))
    actual_duration_min: Mapped[Decimal | None] = mapped_column(Numeric(8, 1))
    waiting_min: Mapped[Decimal] = mapped_column(Numeric(6, 1), default=0)
    tolls: Mapped[Decimal] = mapped_column(Money, default=0)
    parking: Mapped[Decimal] = mapped_column(Money, default=0)
    final_breakdown: Mapped[dict | None] = mapped_column(JSON)
    ride_fare: Mapped[Decimal | None] = mapped_column(Money)      # commissionable
    final_total: Mapped[Decimal | None] = mapped_column(Money)    # what the customer pays
    discount: Mapped[Decimal] = mapped_column(Money, default=0)
    coupon_id: Mapped[int | None] = mapped_column(ForeignKey("coupons.id"))
    commission_rate: Mapped[Decimal | None] = mapped_column(Numeric(5, 4))
    company_commission: Mapped[Decimal | None] = mapped_column(Money)
    driver_earnings: Mapped[Decimal | None] = mapped_column(Money)
    commission_snapshot: Mapped[dict | None] = mapped_column(JSON)  # slabs used, for audit

    payment_method: Mapped[str] = mapped_column(String(10), default="cash")   # cash | online
    payment_status: Mapped[str] = mapped_column(String(20), default="pending")  # pending|paid|failed|refunded|partially_refunded
    otp: Mapped[str] = mapped_column(String(4))               # rider shares with driver to start trip
    assigned_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    arrived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    route_trace: Mapped[list] = mapped_column(JSON, default=list)   # sampled [lat,lng,ts]
    sos_triggered: Mapped[bool] = mapped_column(Boolean, default=False)
    declined_by: Mapped[list] = mapped_column(JSON, default=list)   # driver ids who rejected

    customer = relationship("User", foreign_keys=[customer_id])
    driver = relationship("DriverProfile", foreign_keys=[driver_id])
    category = relationship("VehicleCategory")
    city = relationship("City")


class RideEvent(Base):
    """Append-only timeline for every ride (status changes, SOS, location milestones)."""
    __tablename__ = "ride_events"
    id: Mapped[int] = mapped_column(primary_key=True)
    ride_id: Mapped[int] = mapped_column(ForeignKey("rides.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(30))
    actor_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    data: Mapped[dict] = mapped_column(JSON, default=dict)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)


class Rating(Timestamps, Base):
    __tablename__ = "ratings"
    __table_args__ = (UniqueConstraint("ride_id", "rater_id"),)   # one rating per ride per side
    id: Mapped[int] = mapped_column(primary_key=True)
    ride_id: Mapped[int] = mapped_column(ForeignKey("rides.id"), index=True)
    rater_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    ratee_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    direction: Mapped[str] = mapped_column(String(20))        # customer_to_driver | driver_to_customer
    stars: Mapped[int] = mapped_column(SmallInteger)
    tags: Mapped[list] = mapped_column(JSON, default=list)     # ["Punctual","Clean vehicle"]
    comment: Mapped[str | None] = mapped_column(Text)
    verified: Mapped[bool] = mapped_column(Boolean, default=True)
    excluded_reason: Mapped[str | None] = mapped_column(String(60))


class Cancellation(Timestamps, Base):
    __tablename__ = "cancellations"
    id: Mapped[int] = mapped_column(primary_key=True)
    ride_id: Mapped[int] = mapped_column(ForeignKey("rides.id"), index=True)
    booking_created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    cancelled_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    initiator: Mapped[str] = mapped_column(String(10))
    initiator_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True)
    reason: Mapped[str] = mapped_column(String(200))
    policy_applied: Mapped[str] = mapped_column(String(80))
    within_free_window: Mapped[bool] = mapped_column(Boolean)
    fee: Mapped[Decimal] = mapped_column(Money, default=0)
    fee_payer: Mapped[str | None] = mapped_column(String(10))
    refund_status: Mapped[str] = mapped_column(String(20), default="not_applicable")
    abuse_flag: Mapped[bool] = mapped_column(Boolean, default=False)
    decision: Mapped[dict] = mapped_column(JSON)


class ChatMessage(Base):
    __tablename__ = "chat_messages"
    id: Mapped[int] = mapped_column(primary_key=True)
    ride_id: Mapped[int] = mapped_column(ForeignKey("rides.id", ondelete="CASCADE"), index=True)
    sender_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    body: Mapped[str] = mapped_column(String(500))
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    read: Mapped[bool] = mapped_column(Boolean, default=False)
