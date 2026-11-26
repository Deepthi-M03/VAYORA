"""Company commission engine.

Default slabs (configurable from the admin dashboard, stored as JSON in PlatformSetting):

    ride fare <= ₹300            -> 10 %
    ₹300 < ride fare < ₹700      -> 15 %
    ride fare >= ₹700            -> 20 %

The slab is chosen from the *ride fare* and the whole fare is charged at that one rate
(not marginal). ₹200 -> ₹20, ₹500 -> ₹75, ₹1,000 -> ₹200.

What is commissionable (documented policy)
-----------------------------------------
* Commission applies to ``ride_fare`` only: base, distance, time, waiting, peak, minimum-fare top-up.
* Tolls and parking are pass-through: the driver paid them, so the driver gets 100 %.
* Taxes collected on the fare are remitted, not split: they never enter commission or driver earnings.
* GST on the platform's own commission (``commission_tax_rate``) is charged to the driver's
  side when the platform is registered for it; default 0 so the brief's examples hold exactly.
* Coupons/promotions are funded by the company: the driver is paid on the pre-discount fare,
  and the discount reduces the company's net take (it can go negative; that is a marketing cost).
* Refunds reverse the commission proportionally (``reverse_for_refund``).
"""
from __future__ import annotations

from dataclasses import dataclass, asdict
from decimal import Decimal

from .money import D, paise, ZERO


@dataclass(frozen=True)
class Slab:
    upper: Decimal | None      # None = no upper bound
    rate: Decimal              # 0.10 = 10 %
    upper_inclusive: bool = True


DEFAULT_SLABS: tuple[Slab, ...] = (
    Slab(upper=Decimal("300"), rate=Decimal("0.10"), upper_inclusive=True),   # up to and including ₹300
    Slab(upper=Decimal("700"), rate=Decimal("0.15"), upper_inclusive=False),  # above ₹300, below ₹700
    Slab(upper=None, rate=Decimal("0.20")),                                   # ₹700 and above
)


def slabs_from_config(raw: list[dict]) -> tuple[Slab, ...]:
    slabs = tuple(
        Slab(upper=None if s.get("upper") in (None, "") else D(s["upper"]),
             rate=D(s["rate"]), upper_inclusive=bool(s.get("upper_inclusive", True)))
        for s in raw
    )
    validate_slabs(slabs)
    return slabs


def slabs_to_config(slabs: tuple[Slab, ...]) -> list[dict]:
    return [{"upper": None if s.upper is None else str(s.upper), "rate": str(s.rate),
             "upper_inclusive": s.upper_inclusive} for s in slabs]


def validate_slabs(slabs: tuple[Slab, ...]) -> None:
    if not slabs or slabs[-1].upper is not None:
        raise ValueError("last slab must be open-ended (upper = null)")
    prev = D(0)
    for s in slabs:
        if not (D(0) <= s.rate <= D("0.5")):
            raise ValueError("commission rate must be between 0% and 50%")
        if s.upper is not None:
            if s.upper <= prev:
                raise ValueError("slab upper bounds must be strictly increasing")
            prev = s.upper


def rate_for(ride_fare: Decimal, slabs: tuple[Slab, ...] = DEFAULT_SLABS) -> Decimal:
    f = D(ride_fare)
    for s in slabs:
        if s.upper is None:
            return s.rate
        if (f <= s.upper) if s.upper_inclusive else (f < s.upper):
            return s.rate
    return slabs[-1].rate


@dataclass
class CommissionResult:
    gross_fare: Decimal          # ride fare + pass-through (excl. taxes)
    ride_fare: Decimal           # commissionable
    commission_rate: Decimal
    company_commission: Decimal
    commission_tax: Decimal
    pass_through: Decimal        # tolls + parking -> driver
    discount: Decimal            # coupon, company-funded
    customer_paid: Decimal       # what the customer actually paid (incl. taxes, after discount)
    taxes: Decimal
    driver_earnings: Decimal     # what the driver is owed for the ride
    company_net: Decimal         # commission - discount

    def to_dict(self) -> dict:
        return {k: str(v) for k, v in asdict(self).items()}


def split(ride_fare, *, tolls=ZERO, parking=ZERO, taxes=ZERO, discount=ZERO,
          slabs: tuple[Slab, ...] = DEFAULT_SLABS, commission_tax_rate=ZERO) -> CommissionResult:
    ride_fare = paise(ride_fare)
    rate = rate_for(ride_fare, slabs)
    commission = paise(ride_fare * rate)
    commission_tax = paise(commission * D(commission_tax_rate))
    pass_through = paise(D(tolls) + D(parking))
    discount = paise(min(D(discount), ride_fare))
    driver = paise(ride_fare - commission - commission_tax + pass_through)
    return CommissionResult(
        gross_fare=paise(ride_fare + pass_through), ride_fare=ride_fare, commission_rate=rate,
        company_commission=commission, commission_tax=commission_tax, pass_through=pass_through,
        discount=discount, customer_paid=paise(ride_fare + pass_through + D(taxes) - discount),
        taxes=paise(taxes), driver_earnings=driver, company_net=paise(commission + commission_tax - discount),
    )


def reverse_for_refund(original: CommissionResult, refund_amount) -> dict:
    """Proportional reversal of a ride's split for a (partial) refund of the ride fare.

    Returns the negative adjustments to post to the ledgers.
    """
    refund = paise(min(D(refund_amount), original.ride_fare))
    if original.ride_fare == 0 or refund == 0:
        return {"commission_reversal": ZERO, "driver_reversal": ZERO, "refund": ZERO}
    share = refund / original.ride_fare
    commission_rev = paise(original.company_commission * share)
    return {"commission_reversal": -commission_rev, "driver_reversal": -(refund - commission_rev), "refund": refund}
