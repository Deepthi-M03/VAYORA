"""Money helpers. All financial maths in VAYORA uses Decimal rupees rounded to paise.

Floats are never used for money: every amount entering an engine goes through ``D``
and every amount leaving one goes through ``paise`` (ROUND_HALF_UP, 2 dp).
"""
from decimal import Decimal, ROUND_HALF_UP

ZERO = Decimal("0.00")


def D(value) -> Decimal:
    """Convert int/str/Decimal to Decimal. Floats are converted via str() to avoid binary noise."""
    if isinstance(value, Decimal):
        return value
    if isinstance(value, float):
        return Decimal(str(value))
    return Decimal(value)


def paise(value) -> Decimal:
    return D(value).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def whole_rupees(value) -> Decimal:
    """Customer-facing fares are rounded to the nearest rupee."""
    return D(value).quantize(Decimal("1"), rounding=ROUND_HALF_UP).quantize(Decimal("0.01"))
