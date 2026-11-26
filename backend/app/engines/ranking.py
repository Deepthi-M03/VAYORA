"""Driver ranking engine.

Score 0-100 built from five transparent factors, shown to the driver with the exact
contribution of each so they understand what moves their rank.

    rating       40 %  Bayesian-smoothed average of *verified* ratings
    completion   20 %  completed / accepted rides
    acceptance   15 %  accepted / offered requests
    cancellation 10 %  1 - driver cancellations / accepted (after the free window only)
    safety       15 %  1 - weighted upheld safety complaints

Anti-manipulation rules for ratings
-----------------------------------
* A rating counts only if it is tied to a COMPLETED ride, given by that ride's customer,
  once per ride (DB unique constraint), within 7 days of the ride.
* Repeat raters are dampened: the n-th rating from the same customer for the same driver in
  30 days weighs 1/n, so friends or a single angry rider cannot swing the score.
* Ratings from accounts flagged for fraud, or rides under 0.5 km / 2 min, are excluded.
* Bayesian prior (mean 4.5, weight 15) stops a driver with three 5-star rides outranking a
  driver with 2,000 rides at 4.85.
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import Decimal, ROUND_HALF_UP

WEIGHTS = {"rating": Decimal("0.40"), "completion": Decimal("0.20"), "acceptance": Decimal("0.15"),
           "cancellation": Decimal("0.10"), "safety": Decimal("0.15")}
PRIOR_MEAN = Decimal("4.5")
PRIOR_WEIGHT = Decimal("15")
SAFETY_PENALTY = {"minor": Decimal("0.05"), "major": Decimal("0.20"), "critical": Decimal("0.50")}


@dataclass(frozen=True)
class RatingEvent:
    ride_id: int
    customer_id: int
    stars: int
    rated_at: datetime
    ride_completed: bool
    ride_completed_at: datetime | None
    rater_is_ride_customer: bool
    ride_distance_km: Decimal
    ride_duration_min: Decimal
    rater_flagged: bool = False


@dataclass(frozen=True)
class DriverStats:
    offered: int
    accepted: int
    completed: int
    driver_cancellations_after_window: int
    upheld_safety: dict  # severity -> count


def verified(e: RatingEvent) -> bool:
    if not (1 <= e.stars <= 5) or not e.ride_completed or not e.rater_is_ride_customer or e.rater_flagged:
        return False
    if e.ride_completed_at is None or e.rated_at - e.ride_completed_at > timedelta(days=7):
        return False
    if e.ride_distance_km < Decimal("0.5") or e.ride_duration_min < Decimal("2"):
        return False
    return True


def weighted_rating(events: list[RatingEvent]) -> tuple[Decimal, Decimal, int]:
    """Returns (bayesian mean, effective weight, verified count). One rating per ride enforced here too."""
    seen_rides: set[int] = set()
    per_customer: dict[int, list[datetime]] = defaultdict(list)
    total, weight, count = Decimal(0), Decimal(0), 0
    for e in sorted(events, key=lambda x: x.rated_at):
        if e.ride_id in seen_rides or not verified(e):
            continue
        seen_rides.add(e.ride_id)
        recent = [t for t in per_customer[e.customer_id] if e.rated_at - t <= timedelta(days=30)]
        w = Decimal(1) / Decimal(len(recent) + 1)
        per_customer[e.customer_id].append(e.rated_at)
        total += Decimal(e.stars) * w
        weight += w
        count += 1
    mean = (total + PRIOR_MEAN * PRIOR_WEIGHT) / (weight + PRIOR_WEIGHT)
    return mean, weight, count


def _ratio(n, d, default=Decimal(1)):
    return default if d == 0 else max(Decimal(0), min(Decimal(1), Decimal(n) / Decimal(d)))


def _q(x):
    return Decimal(x).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP)


def score(events: list[RatingEvent], stats: DriverStats) -> dict:
    mean, w, n = weighted_rating(events)
    factors = {
        "rating": (mean - 1) / 4,                    # 1..5 -> 0..1
        "completion": _ratio(stats.completed, stats.accepted),
        "acceptance": _ratio(stats.accepted, stats.offered),
        "cancellation": 1 - _ratio(stats.driver_cancellations_after_window, stats.accepted, Decimal(0)),
        "safety": max(Decimal(0), 1 - sum((SAFETY_PENALTY.get(k, Decimal(0)) * v for k, v in stats.upheld_safety.items()), Decimal(0))),
    }
    contributions = {k: factors[k] * WEIGHTS[k] * 100 for k in WEIGHTS}
    total = sum(contributions.values(), Decimal(0))
    tips = []
    if factors["acceptance"] < Decimal("0.8"):
        tips.append("Accept more requests while online: acceptance is below 80%.")
    if factors["cancellation"] < Decimal("0.95"):
        tips.append("Cancelling after the free 15-minute window lowers your rank.")
    if mean < Decimal("4.6") and n >= 10:
        tips.append("Riders mention punctuality and vehicle cleanliness most often in high ratings.")
    if factors["safety"] < 1:
        tips.append("An upheld safety complaint is affecting your score. It decays after 90 days without incidents.")
    tier = "Platinum" if total >= 90 else "Gold" if total >= 80 else "Silver" if total >= 65 else "Bronze"
    return {
        "score": str(_q(total)), "tier": tier,
        "rating": {"bayesian": str(mean.quantize(Decimal("0.01"))), "verified_count": n, "effective_weight": str(_q(w))},
        "factors": {k: {"value": str((factors[k] * 100).quantize(Decimal("0.1"))), "weight": str(WEIGHTS[k] * 100),
                        "points": str(_q(contributions[k]))} for k in WEIGHTS},
        "tips": tips,
    }
