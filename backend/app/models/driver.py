from datetime import date, datetime

from sqlalchemy import JSON, Boolean, Date, DateTime, Float, ForeignKey, Integer, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from ._base import Timestamps, Money, Decimal


class DriverProfile(Timestamps, Base):
    __tablename__ = "driver_profiles"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), unique=True)
    city_id: Mapped[int | None] = mapped_column(ForeignKey("cities.id"), index=True)
    onboarding_status: Mapped[str] = mapped_column(String(20), default="incomplete")  # incomplete|submitted|approved|rejected
    rejection_reason: Mapped[str | None] = mapped_column(String(300))
    licence_number: Mapped[str | None] = mapped_column(String(40))
    licence_expiry: Mapped[date | None] = mapped_column(Date)
    # Bank details: account number stored encrypted at rest (pgcrypto / KMS) - see services/crypto.py
    bank_account_enc: Mapped[str | None] = mapped_column(String(400))
    bank_account_last4: Mapped[str | None] = mapped_column(String(4))
    bank_ifsc: Mapped[str | None] = mapped_column(String(11))
    bank_holder_name: Mapped[str | None] = mapped_column(String(120))
    bank_verified: Mapped[bool] = mapped_column(Boolean, default=False)
    razorpay_fund_account_id: Mapped[str | None] = mapped_column(String(40))

    is_online: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    last_lat: Mapped[float | None] = mapped_column(Float)
    last_lng: Mapped[float | None] = mapped_column(Float)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    online_since: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    active_vehicle_id: Mapped[int | None] = mapped_column(ForeignKey("vehicles.id", use_alter=True))

    # cached ranking (recomputed nightly + after each rating)
    rank_score: Mapped[Decimal] = mapped_column(Numeric(5, 1), default=0)
    rank_tier: Mapped[str] = mapped_column(String(12), default="New")
    rank_snapshot: Mapped[dict] = mapped_column(JSON, default=dict)
    offered_count: Mapped[int] = mapped_column(Integer, default=0)
    accepted_count: Mapped[int] = mapped_column(Integer, default=0)
    completed_count: Mapped[int] = mapped_column(Integer, default=0)
    late_cancel_count: Mapped[int] = mapped_column(Integer, default=0)
    wallet_balance: Mapped[Decimal] = mapped_column(Money, default=0)   # cached sum of unsettled ledger

    user = relationship("User", back_populates="driver")
    vehicles = relationship("Vehicle", back_populates="driver", foreign_keys="Vehicle.driver_id")
    documents = relationship("DriverDocument", back_populates="driver", cascade="all, delete-orphan")


class Vehicle(Timestamps, Base):
    __tablename__ = "vehicles"
    id: Mapped[int] = mapped_column(primary_key=True)
    driver_id: Mapped[int] = mapped_column(ForeignKey("driver_profiles.id", ondelete="CASCADE"), index=True)
    category_id: Mapped[int] = mapped_column(ForeignKey("vehicle_categories.id"))
    registration_number: Mapped[str] = mapped_column(String(16), unique=True)
    make: Mapped[str] = mapped_column(String(40))
    model: Mapped[str] = mapped_column(String(40))
    colour: Mapped[str] = mapped_column(String(30))
    year: Mapped[int] = mapped_column(Integer)
    seats: Mapped[int] = mapped_column(Integer, default=1)
    insurance_expiry: Mapped[date | None] = mapped_column(Date)
    permit_type: Mapped[str | None] = mapped_column(String(30))     # all-India tourist permit for interstate
    status: Mapped[str] = mapped_column(String(20), default="pending")  # pending|approved|suspended|rejected
    photos: Mapped[list] = mapped_column(JSON, default=list)
    driver = relationship("DriverProfile", back_populates="vehicles", foreign_keys=[driver_id])
    category = relationship("VehicleCategory")


class DriverDocument(Timestamps, Base):
    __tablename__ = "driver_documents"
    id: Mapped[int] = mapped_column(primary_key=True)
    driver_id: Mapped[int] = mapped_column(ForeignKey("driver_profiles.id", ondelete="CASCADE"), index=True)
    vehicle_id: Mapped[int | None] = mapped_column(ForeignKey("vehicles.id"))
    doc_type: Mapped[str] = mapped_column(String(30))  # photo|licence|aadhaar|pan|rc|insurance|vehicle_photo|bank_proof|permit
    file_key: Mapped[str] = mapped_column(String(300))  # object-storage key, served via signed URL
    status: Mapped[str] = mapped_column(String(20), default="pending")  # pending|verified|rejected|expired
    reviewer_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    review_note: Mapped[str | None] = mapped_column(String(300))
    expires_on: Mapped[date | None] = mapped_column(Date)
    driver = relationship("DriverProfile", back_populates="documents")
