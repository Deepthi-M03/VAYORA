"""Cancellation policy engine.

Default policy
--------------
* Customer and driver may both cancel FREE within 15 minutes of the booking's creation time.
  The window is measured from ``booking.created_at`` (server clock), never from client time.
* After 15 minutes the admin-configured rules apply (fee for the customer, fee/penalty for the driver).
* Abuse protection: the free window is a promise and is always honoured, but repeated
  cancellations inside a rolling window put the account on a booking cooldown and raise a
  fraud flag for review. Admins may optionally switch on "charge after N free cancellations".
"""
from __future__ import annotations

from dataclasses import dataclass, asdict
from datetime import datetime, timedelta
from decimal import Decimal

from .money import D, paise, ZERO


@dataclass(frozen=True)
class CancellationPolicy:
    free_window_min: int = 15
    customer_fee_after_window: Decimal = Decimal("30")
    customer_fee_if_driver_arrived: Decimal = Decimal("50")
    driver_fee_after_window: Decimal = Decimal("25")      # deducted from driver wallet
    abuse_window_hours: int = 24
    abuse_threshold: int = 3                               # cancellations in window before cooldown
    cooldown_minutes: int = 60
    charge_after_threshold: bool = False                   # optional stricter mode
    version: str = "2026.1"


@dataclass
class CancellationDecision:
    initiator: str
    minutes_since_booking: Decimal
    within_free_window: bool
    fee: Decimal
    fee_payer: str | None
    policy_applied: str
    cooldown_until: datetime | None
    abuse_flag: bool
    refund_due: Decimal

    def to_dict(self):
        d = asdict(self)
        return {k: (str(v) if isinstance(v, (Decimal, datetime)) else v) for k, v in d.items()}


def decide(*, initiator: str, booking_created_at: datetime, cancelled_at: datetime,
           driver_arrived: bool, recent_cancellations: int, prepaid_amount=ZERO,
           policy: CancellationPolicy = CancellationPolicy()) -> CancellationDecision:
    """``recent_cancellations`` = this actor's cancellations in the abuse window, excluding this one."""
    if initiator not in ("customer", "driver", "system", "admin"):
        raise ValueError("unknown initiator")
    if cancelled_at < booking_created_at:
        raise ValueError("cancellation cannot precede booking")

    elapsed = D((cancelled_at - booking_created_at).total_seconds()) / D(60)
    in_window = elapsed <= policy.free_window_min
    total_in_window = recent_cancellations + 1
    abusive = total_in_window > policy.abuse_threshold

    fee, payer, label = ZERO, None, f"free<= {policy.free_window_min}m"
    if initiator in ("system", "admin"):
        label = "no-fault (system/admin)"
    elif not in_window:
        if initiator == "customer":
            fee = policy.customer_fee_if_driver_arrived if driver_arrived else policy.customer_fee_after_window
        else:
            fee = policy.driver_fee_after_window
        payer, label = initiator, f"after {policy.free_window_min}m"
    elif abusive and policy.charge_after_threshold:
        fee = policy.customer_fee_after_window if initiator == "customer" else policy.driver_fee_after_window
        payer, label = initiator, f"repeat-cancellation (> {policy.abuse_threshold} in {policy.abuse_window_hours}h)"

    cooldown = cancelled_at + timedelta(minutes=policy.cooldown_minutes) if abusive and initiator in ("customer", "driver") else None
    refund = paise(D(prepaid_amount) - (fee if payer == "customer" else ZERO))
    return CancellationDecision(
        initiator=initiator, minutes_since_booking=paise(elapsed), within_free_window=in_window,
        fee=paise(fee), fee_payer=payer, policy_applied=f"{policy.version}:{label}",
        cooldown_until=cooldown, abuse_flag=abusive, refund_due=max(ZERO, refund),
    )
