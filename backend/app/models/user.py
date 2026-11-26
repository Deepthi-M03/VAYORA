from datetime import datetime
from decimal import Decimal

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, Numeric, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from ._base import Timestamps


class User(Timestamps, Base):
    """One table for customers, drivers and admins. ``role`` decides which portal they use."""
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    role: Mapped[str] = mapped_column(String(20), index=True)          # customer | driver | admin
    admin_role: Mapped[str | None] = mapped_column(String(30))          # super_admin | ops_admin | ...
    full_name: Mapped[str] = mapped_column(String(120))
    email: Mapped[str | None] = mapped_column(String(160), unique=True, index=True)
    phone: Mapped[str] = mapped_column(String(20), unique=True, index=True)   # never returned to the other party
    password_hash: Mapped[str | None] = mapped_column(String(200))
    google_sub: Mapped[str | None] = mapped_column(String(64), unique=True)
    avatar_url: Mapped[str | None] = mapped_column(String(300))
    language: Mapped[str] = mapped_column(String(8), default="en")
    status: Mapped[str] = mapped_column(String(20), default="active", index=True)  # active|restricted|suspended|deactivated
    restricted_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    booking_cooldown_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    fraud_flag: Mapped[bool] = mapped_column(Boolean, default=False)
    session_version: Mapped[int] = mapped_column(Integer, default=0)   # bump to revoke all tokens
    referral_code: Mapped[str | None] = mapped_column(String(12), unique=True)
    outstanding_dues: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=0)  # unpaid late-cancel fees, added to next ride
    fcm_token: Mapped[str | None] = mapped_column(String(300))
    home_city_id: Mapped[int | None] = mapped_column(ForeignKey("cities.id"))
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    addresses = relationship("SavedAddress", back_populates="user", cascade="all, delete-orphan")
    contacts = relationship("EmergencyContact", back_populates="user", cascade="all, delete-orphan")
    driver = relationship("DriverProfile", back_populates="user", uselist=False)


class SavedAddress(Timestamps, Base):
    __tablename__ = "saved_addresses"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    label: Mapped[str] = mapped_column(String(40))   # Home, Work, Gym...
    address: Mapped[str] = mapped_column(String(300))
    lat: Mapped[float] = mapped_column(Float)
    lng: Mapped[float] = mapped_column(Float)
    user = relationship("User", back_populates="addresses")


class EmergencyContact(Timestamps, Base):
    __tablename__ = "emergency_contacts"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(120))
    phone: Mapped[str] = mapped_column(String(20))
    relation: Mapped[str | None] = mapped_column(String(40))
    user = relationship("User", back_populates="contacts")


class PasswordReset(Timestamps, Base):
    __tablename__ = "password_resets"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    used: Mapped[bool] = mapped_column(Boolean, default=False)


class FavouriteDriver(Timestamps, Base):
    __tablename__ = "favourite_drivers"
    __table_args__ = (UniqueConstraint("customer_id", "driver_id"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    customer_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    driver_id: Mapped[int] = mapped_column(ForeignKey("driver_profiles.id", ondelete="CASCADE"))
