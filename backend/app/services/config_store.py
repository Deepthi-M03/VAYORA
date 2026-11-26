"""Reads admin-editable platform settings with safe defaults."""
from __future__ import annotations

from dataclasses import asdict
from datetime import time
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.engines import commission
from app.engines.cancellation import CancellationPolicy
from app.engines.fare import FareRule, PeakWindow
from app.models import City, CityVehicle, FareRuleRow, PlatformSetting, VehicleCategory

DEFAULTS = {
    "commission_slabs": commission.slabs_to_config(commission.DEFAULT_SLABS),
    "commission_tax_rate": "0",
    "cancellation_policy": {k: str(v) if isinstance(v, Decimal) else v for k, v in asdict(CancellationPolicy()).items()},
    "referral": {"referrer_reward": "75", "referee_reward": "50"},
    "sos": {"police": "112", "women_helpline": "181", "ops_desk": "+91-44-0000-0000"},
    "dispatch": {"radius_km": 5, "offer_timeout_sec": 20, "max_offers": 6},
    "settlement": {"min_payout": "1.00", "run_at_ist": "00:30"},
}


def get(db: Session, key: str):
    row = db.get(PlatformSetting, key)
    return row.value if row else DEFAULTS[key]


def put(db: Session, key: str, value, user_id: int | None):
    row = db.get(PlatformSetting, key)
    if row:
        row.value, row.updated_by = value, user_id
    else:
        db.add(PlatformSetting(key=key, value=value, updated_by=user_id))


def slabs(db: Session):
    return commission.slabs_from_config(get(db, "commission_slabs"))


def cancellation_policy(db: Session) -> CancellationPolicy:
    raw = dict(get(db, "cancellation_policy"))
    for k in ("customer_fee_after_window", "customer_fee_if_driver_arrived", "driver_fee_after_window"):
        raw[k] = Decimal(str(raw[k]))
    return CancellationPolicy(**raw)


def _t(s: str) -> time:
    h, m = s.split(":")
    return time(int(h), int(m))


def to_engine_rule(row: FareRuleRow) -> FareRule:
    return FareRule(
        base_fare=Decimal(row.base_fare), per_km=Decimal(row.per_km), per_min=Decimal(row.per_min),
        minimum_fare=Decimal(row.minimum_fare), per_wait_min=Decimal(row.per_wait_min),
        free_waiting_min=row.free_waiting_min, max_peak_multiplier=Decimal(row.max_peak_multiplier),
        tax_rate=Decimal(row.tax_rate),
        peak_windows=tuple(PeakWindow(_t(w["start"]), _t(w["end"]), Decimal(str(w["multiplier"])),
                                      tuple(w.get("weekdays", range(7)))) for w in (row.peak_windows or [])),
    )


def current_rule(db: Session, city_id: int, category_id: int) -> FareRuleRow | None:
    return db.scalar(select(FareRuleRow).where(FareRuleRow.city_id == city_id, FareRuleRow.category_id == category_id,
                                               FareRuleRow.is_current.is_(True)))


def active_categories(db: Session, city: City) -> list[VehicleCategory]:
    """A category is bookable only if: city active, category globally active, city switch on, pricing exists."""
    if city.status != "active":
        return []
    rows = db.scalars(
        select(VehicleCategory).join(CityVehicle, CityVehicle.category_id == VehicleCategory.id)
        .where(CityVehicle.city_id == city.id, CityVehicle.active.is_(True), VehicleCategory.globally_active.is_(True))
        .order_by(VehicleCategory.sort_order)
    ).all()
    return [c for c in rows if current_rule(db, city.id, c.id)]
