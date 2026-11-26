"""Fare calculation engine.

Pure functions, no I/O, so the same code produces the quote shown to the customer,
re-validates it on booking, and computes the final fare at trip end.

Formula
-------
    metered      = base + per_km * km + per_min * minutes
    waiting      = per_wait_min * max(0, waiting_min - free_waiting_min)
    peak         = metered * (peak_multiplier - 1)        (only inside a configured peak window)
    ride_fare    = max(minimum_fare, metered + waiting + peak)   -> rounded to whole rupees
    pass_through = tolls + parking                           (paid out 100% to the driver)
    total        = ride_fare + pass_through + taxes

``ride_fare`` is the commissionable amount (see commission.py).
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from datetime import datetime, time
from decimal import Decimal

from .money import D, paise, whole_rupees, ZERO


class CityTier:
    METRO = "metro"
    TIER_2 = "tier_2"
    OTHER = "other"


@dataclass(frozen=True)
class PeakWindow:
    start: time
    end: time
    multiplier: Decimal
    weekdays: tuple[int, ...] = (0, 1, 2, 3, 4, 5, 6)  # Monday = 0

    def applies(self, at: datetime) -> bool:
        if at.weekday() not in self.weekdays:
            return False
        t = at.time()
        if self.start <= self.end:
            return self.start <= t < self.end
        return t >= self.start or t < self.end  # window crosses midnight


@dataclass(frozen=True)
class FareRule:
    """Pricing for one (city, vehicle category). Configured by the admin."""
    base_fare: Decimal
    per_km: Decimal
    per_min: Decimal
    minimum_fare: Decimal
    per_wait_min: Decimal = ZERO
    free_waiting_min: int = 3
    peak_windows: tuple[PeakWindow, ...] = ()
    max_peak_multiplier: Decimal = Decimal("2.0")  # regulatory cap
    tax_rate: Decimal = ZERO                        # GST on the ride fare, if the city/category requires it


@dataclass
class FareInput:
    distance_km: Decimal
    duration_min: Decimal
    at: datetime
    waiting_min: Decimal = ZERO
    tolls: Decimal = ZERO
    parking: Decimal = ZERO


@dataclass
class FareBreakdown:
    base: Decimal
    distance_charge: Decimal
    time_charge: Decimal
    waiting_charge: Decimal
    peak_charge: Decimal
    peak_multiplier: Decimal
    minimum_fare_adjustment: Decimal
    ride_fare: Decimal          # commissionable
    tolls: Decimal
    parking: Decimal
    taxes: Decimal
    total: Decimal
    is_estimate: bool = True
    lines: list[dict] = field(default_factory=list)

    def to_dict(self) -> dict:
        d = asdict(self)
        return {k: (str(v) if isinstance(v, Decimal) else v) for k, v in d.items()}


def peak_multiplier_for(rule: FareRule, at: datetime) -> Decimal:
    m = Decimal("1.0")
    for w in rule.peak_windows:
        if w.applies(at):
            m = max(m, D(w.multiplier))
    return min(m, D(rule.max_peak_multiplier))


def calculate_fare(rule: FareRule, inp: FareInput, *, is_estimate: bool = True) -> FareBreakdown:
    km, mins = D(inp.distance_km), D(inp.duration_min)
    if km < 0 or mins < 0 or D(inp.waiting_min) < 0:
        raise ValueError("distance, duration and waiting must be non-negative")

    base = paise(rule.base_fare)
    distance_charge = paise(D(rule.per_km) * km)
    time_charge = paise(D(rule.per_min) * mins)
    billable_wait = max(ZERO, D(inp.waiting_min) - D(rule.free_waiting_min))
    waiting_charge = paise(D(rule.per_wait_min) * billable_wait)

    metered = base + distance_charge + time_charge
    multiplier = peak_multiplier_for(rule, inp.at)
    peak_charge = paise(metered * (multiplier - 1))

    subtotal = metered + waiting_charge + peak_charge
    min_adj = paise(max(ZERO, D(rule.minimum_fare) - subtotal))
    ride_fare = whole_rupees(subtotal + min_adj)

    tolls, parking = paise(inp.tolls), paise(inp.parking)
    taxes = paise(ride_fare * D(rule.tax_rate))
    total = paise(ride_fare + tolls + parking + taxes)

    lines = [
        {"label": "Base fare", "amount": str(base)},
        {"label": f"Distance · {km} km × ₹{rule.per_km}", "amount": str(distance_charge)},
        {"label": f"Time · {mins} min × ₹{rule.per_min}", "amount": str(time_charge)},
    ]
    if waiting_charge:
        lines.append({"label": f"Waiting · {billable_wait} min", "amount": str(waiting_charge)})
    if peak_charge:
        lines.append({"label": f"Peak hours ×{multiplier}", "amount": str(peak_charge)})
    if min_adj:
        lines.append({"label": "Minimum fare adjustment", "amount": str(min_adj)})
    if tolls:
        lines.append({"label": "Tolls", "amount": str(tolls)})
    if parking:
        lines.append({"label": "Parking", "amount": str(parking)})
    if taxes:
        lines.append({"label": "Taxes", "amount": str(taxes)})

    return FareBreakdown(
        base=base, distance_charge=distance_charge, time_charge=time_charge,
        waiting_charge=waiting_charge, peak_charge=peak_charge, peak_multiplier=multiplier,
        minimum_fare_adjustment=min_adj, ride_fare=ride_fare, tolls=tolls, parking=parking,
        taxes=taxes, total=total, is_estimate=is_estimate, lines=lines,
    )


def estimate_range(rule: FareRule, inp: FareInput, traffic_buffer: Decimal = Decimal("0.15")) -> tuple[Decimal, Decimal]:
    """Shown to customers as 'Estimated ₹X – ₹Y' so the estimate is never mistaken for the final fare."""
    low = calculate_fare(rule, inp).total
    slow = FareInput(inp.distance_km, D(inp.duration_min) * (1 + traffic_buffer), inp.at,
                     inp.waiting_min, inp.tolls, inp.parking)
    high = calculate_fare(rule, slow).total
    return low, max(low, high)


# Sensible defaults per tier, used by the seed script. Admins override per city.
DEFAULT_RULES: dict[str, dict[str, dict]] = {
    CityTier.METRO: {
        "bike":    dict(base_fare="25", per_km="8",  per_min="1.0", minimum_fare="40",  per_wait_min="1"),
        "auto":    dict(base_fare="35", per_km="14", per_min="1.5", minimum_fare="60",  per_wait_min="1.5"),
        "car":     dict(base_fare="60", per_km="18", per_min="2.0", minimum_fare="120", per_wait_min="2"),
        "tourist": dict(base_fare="500", per_km="22", per_min="1.0", minimum_fare="2500", per_wait_min="3"),
    },
    CityTier.TIER_2: {
        "bike":    dict(base_fare="20", per_km="7",  per_min="0.8", minimum_fare="35",  per_wait_min="1"),
        "auto":    dict(base_fare="30", per_km="12", per_min="1.2", minimum_fare="50",  per_wait_min="1"),
        "car":     dict(base_fare="50", per_km="15", per_min="1.6", minimum_fare="100", per_wait_min="1.5"),
        "tourist": dict(base_fare="450", per_km="19", per_min="0.8", minimum_fare="2200", per_wait_min="2.5"),
    },
    CityTier.OTHER: {
        "bike":    dict(base_fare="18", per_km="6",  per_min="0.6", minimum_fare="30",  per_wait_min="1"),
        "auto":    dict(base_fare="25", per_km="11", per_min="1.0", minimum_fare="45",  per_wait_min="1"),
        "car":     dict(base_fare="45", per_km="14", per_min="1.4", minimum_fare="90",  per_wait_min="1.5"),
        "tourist": dict(base_fare="400", per_km="18", per_min="0.7", minimum_fare="2000", per_wait_min="2"),
    },
}
