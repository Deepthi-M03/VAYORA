"""Driver settlement engine (T+1 payouts).

Every money movement for a driver is an immutable row in the driver ledger. Signs are from
the driver's point of view: + = the platform owes the driver, - = the driver owes the platform.

    online ride   -> +driver_earnings            (customer paid the platform)
    cash ride     -> -company_commission         (driver already holds the full cash fare)
    refunds       -> -driver share of the refund
    cancel fees   -> +fee to driver / -fee from driver
    adjustments   -> +/- (admin, always with reason + audit log)

Each night (00:30 IST) the settlement job takes every *unsettled* entry that occurred before
the end of the previous business day and nets it per driver:

    net > min_payout and bank verified -> create Payout for `net`, lock the entries to it
    net > 0 but bank not verified      -> ON_HOLD, nothing locked
    net <= min_payout                  -> CARRIED_FORWARD, entries stay unsettled (dues roll over)

Cash commission therefore nets automatically against online earnings, and an entry can be
in at most one settlement (``settlement_id`` is set once; DB unique key on ride/entry type
prevents double posting). Payouts are marked SUCCESS only by a verified provider webhook.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal

from .money import D, paise, ZERO


class EntryType:
    RIDE_EARNING_ONLINE = "ride_earning_online"
    RIDE_COMMISSION_CASH = "ride_commission_cash"
    REFUND_REVERSAL = "refund_reversal"
    CANCEL_FEE_CREDIT = "cancel_fee_credit"
    CANCEL_FEE_DEBIT = "cancel_fee_debit"
    INCENTIVE = "incentive"
    ADJUSTMENT = "adjustment"


class SettlementAction:
    PAYOUT = "payout"
    ON_HOLD = "on_hold"
    CARRIED_FORWARD = "carried_forward"


@dataclass(frozen=True)
class LedgerLine:
    id: int
    entry_type: str
    amount: Decimal
    settled: bool = False


@dataclass
class SettlementPlan:
    driver_id: int
    business_date: date
    idempotency_key: str
    entry_ids: list[int]
    online_earnings: Decimal
    cash_commission_due: Decimal
    other_adjustments: Decimal
    net: Decimal
    action: str
    note: str = ""
    breakdown: dict = field(default_factory=dict)


def plan_settlement(driver_id: int, business_date: date, lines: list[LedgerLine], *,
                    bank_verified: bool, min_payout: Decimal = Decimal("1.00")) -> SettlementPlan:
    open_lines = [l for l in lines if not l.settled]
    online = paise(sum((D(l.amount) for l in open_lines if l.entry_type == EntryType.RIDE_EARNING_ONLINE), ZERO))
    cash_due = paise(sum((D(l.amount) for l in open_lines if l.entry_type == EntryType.RIDE_COMMISSION_CASH), ZERO))
    other = paise(sum((D(l.amount) for l in open_lines
                       if l.entry_type not in (EntryType.RIDE_EARNING_ONLINE, EntryType.RIDE_COMMISSION_CASH)), ZERO))
    net = paise(online + cash_due + other)
    key = f"settle:{driver_id}:{business_date.isoformat()}"

    if net <= D(min_payout):
        action, ids = SettlementAction.CARRIED_FORWARD, []
        note = (f"Driver owes ₹{-net} in cash commission; carried forward and netted against future online earnings"
                if net < 0 else "Below minimum payout; carried forward")
    elif not bank_verified:
        action, ids, note = SettlementAction.ON_HOLD, [], "Bank account not verified; payout on hold"
    else:
        action, ids, note = SettlementAction.PAYOUT, [l.id for l in open_lines], "Payout scheduled"

    return SettlementPlan(
        driver_id=driver_id, business_date=business_date, idempotency_key=key, entry_ids=ids,
        online_earnings=online, cash_commission_due=cash_due, other_adjustments=other, net=net,
        action=action, note=note,
        breakdown={"entries": len(open_lines), "online": str(online), "cash_commission": str(cash_due),
                   "other": str(other), "net": str(net)},
    )


# ----- payout state machine -------------------------------------------------------------

class PayoutStatus:
    CREATED = "created"
    PROCESSING = "processing"
    SUCCESS = "success"
    FAILED = "failed"
    REVERSED = "reversed"


_ALLOWED = {
    PayoutStatus.CREATED: {PayoutStatus.PROCESSING, PayoutStatus.FAILED},
    PayoutStatus.PROCESSING: {PayoutStatus.SUCCESS, PayoutStatus.FAILED},
    PayoutStatus.FAILED: {PayoutStatus.PROCESSING},          # retry
    PayoutStatus.SUCCESS: {PayoutStatus.REVERSED},           # bank bounced after success
    PayoutStatus.REVERSED: set(),
}

MAX_PAYOUT_ATTEMPTS = 5


def transition(current: str, new: str, *, provider_confirmed: bool = False, attempts: int = 0) -> str:
    """Validate a payout status change. SUCCESS needs provider confirmation, never a local guess."""
    if new not in _ALLOWED.get(current, set()):
        raise ValueError(f"illegal payout transition {current} -> {new}")
    if new == PayoutStatus.SUCCESS and not provider_confirmed:
        raise PermissionError("payout can only be marked successful on provider confirmation")
    if current == PayoutStatus.FAILED and new == PayoutStatus.PROCESSING and attempts >= MAX_PAYOUT_ATTEMPTS:
        raise ValueError("maximum payout retries reached; manual review required")
    return new
