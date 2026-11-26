from sqlalchemy import JSON, Boolean, ForeignKey, Integer, Numeric, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from ._base import Timestamps, Money, Decimal


class City(Timestamps, Base):
    __tablename__ = "cities"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(80), unique=True)
    state: Mapped[str] = mapped_column(String(80))
    tier: Mapped[str] = mapped_column(String(10))                   # metro | tier_2 | other
    status: Mapped[str] = mapped_column(String(20), default="draft") # draft | pending_approval | active | paused
    center_lat: Mapped[float] = mapped_column()
    center_lng: Mapped[float] = mapped_column()
    boundary: Mapped[list | None] = mapped_column(JSON)              # [[lat, lng], ...]
    timezone: Mapped[str] = mapped_column(String(40), default="Asia/Kolkata")
    operating_hours: Mapped[dict] = mapped_column(JSON, default=lambda: {"open": "00:00", "close": "23:59"})
    restrictions: Mapped[dict] = mapped_column(JSON, default=dict)   # e.g. {"bike": "no airport pickups"}
    activated_by: Mapped[int | None] = mapped_column(
    ForeignKey("users.id", use_alter=True, name="fk_cities_activated_by_users")
)

    zones = relationship("ServiceZone", back_populates="city", cascade="all, delete-orphan")
    vehicles = relationship("CityVehicle", back_populates="city", cascade="all, delete-orphan")


class ServiceZone(Timestamps, Base):
    __tablename__ = "service_zones"
    id: Mapped[int] = mapped_column(primary_key=True)
    city_id: Mapped[int] = mapped_column(ForeignKey("cities.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(80))
    polygon: Mapped[list] = mapped_column(JSON)
    kind: Mapped[str] = mapped_column(String(20), default="service")  # service | airport | no_pickup
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    city = relationship("City", back_populates="zones")


class VehicleCategory(Timestamps, Base):
    __tablename__ = "vehicle_categories"
    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(20), unique=True)   # bike | auto | car | tourist
    name: Mapped[str] = mapped_column(String(60))
    seats: Mapped[int] = mapped_column(Integer)
    description: Mapped[str] = mapped_column(String(200), default="")
    is_interstate: Mapped[bool] = mapped_column(Boolean, default=False)
    globally_active: Mapped[bool] = mapped_column(Boolean, default=True)   # discontinue platform-wide
    sort_order: Mapped[int] = mapped_column(Integer, default=0)


class CityVehicle(Timestamps, Base):
    """Per-city switch for each vehicle type. Customers see a category only if both switches are on."""
    __tablename__ = "city_vehicles"
    __table_args__ = (UniqueConstraint("city_id", "category_id"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    city_id: Mapped[int] = mapped_column(ForeignKey("cities.id", ondelete="CASCADE"))
    category_id: Mapped[int] = mapped_column(ForeignKey("vehicle_categories.id"))
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    city = relationship("City", back_populates="vehicles")
    category = relationship("VehicleCategory")


class FareRuleRow(Timestamps, Base):
    """Versioned so every ride stores which pricing produced its fare."""
    __tablename__ = "fare_rules"
    __table_args__ = (UniqueConstraint("city_id", "category_id", "version"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    city_id: Mapped[int] = mapped_column(ForeignKey("cities.id", ondelete="CASCADE"), index=True)
    category_id: Mapped[int] = mapped_column(ForeignKey("vehicle_categories.id"))
    version: Mapped[int] = mapped_column(Integer, default=1)
    is_current: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    base_fare: Mapped[Decimal] = mapped_column(Money)
    per_km: Mapped[Decimal] = mapped_column(Money)
    per_min: Mapped[Decimal] = mapped_column(Money)
    per_wait_min: Mapped[Decimal] = mapped_column(Money, default=0)
    free_waiting_min: Mapped[int] = mapped_column(Integer, default=3)
    minimum_fare: Mapped[Decimal] = mapped_column(Money)
    max_peak_multiplier: Mapped[Decimal] = mapped_column(Numeric(4, 2), default=2)
    tax_rate: Mapped[Decimal] = mapped_column(Numeric(5, 4), default=0)
    peak_windows: Mapped[list] = mapped_column(JSON, default=list)  # [{"start":"08:00","end":"11:00","multiplier":"1.3","weekdays":[0..4]}]
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
