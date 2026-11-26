"""Unit tests for VAYORA's pure business engines. Run: pytest -q"""
from datetime import date, datetime, time, timedelta
from decimal import Decimal as Dec

import pytest

from app.engines import cancellation, commission, fare, quote, ranking, settlement, geo
from app.engines.settlement import EntryType, LedgerLine, PayoutStatus, SettlementAction


# ---------------- commission (the brief's exact examples) ----------------
@pytest.mark.parametrize("ride,company,driver", [
    ("200", "20.00", "180.00"),
    ("500", "75.00", "425.00"),
    ("1000", "200.00", "800.00"),
])
def test_commission_brief_examples(ride, company, driver):
    r = commission.split(Dec(ride))
    assert r.company_commission == Dec(company)
    assert r.driver_earnings == Dec(driver)


@pytest.mark.parametrize("ride,rate", [
    ("300", "0.10"), ("300.01", "0.15"), ("699.99", "0.15"), ("700", "0.20"), ("0", "0.10"),
])
def test_commission_boundaries(ride, rate):
    assert commission.rate_for(Dec(ride)) == Dec(rate)


def test_tolls_pass_through_and_discount_company_funded():
    r = commission.split(Dec("500"), tolls=Dec("60"), parking=Dec("20"), discount=Dec("50"))
    assert r.company_commission == Dec("75.00")
    assert r.driver_earnings == Dec("505.00")      # 425 + 80 pass-through, discount not borne by driver
    assert r.customer_paid == Dec("530.00")
    assert r.company_net == Dec("25.00")


def test_refund_reversal_proportional():
    r = commission.split(Dec("1000"))
    rev = commission.reverse_for_refund(r, Dec("500"))
    assert rev["commission_reversal"] == Dec("-100.00")
    assert rev["driver_reversal"] == Dec("-400.00")


def test_slab_validation():
    with pytest.raises(ValueError):
        commission.slabs_from_config([{"upper": "300", "rate": "0.1"}])  # not open-ended
    custom = commission.slabs_from_config([{"upper": "250", "rate": "0.08"}, {"upper": None, "rate": "0.12"}])
    assert commission.split(Dec("1000"), slabs=custom).company_commission == Dec("120.00")


# ---------------- fare ----------------
RULE = fare.FareRule(base_fare=Dec("50"), per_km=Dec("15"), per_min=Dec("2"), minimum_fare=Dec("100"),
                     per_wait_min=Dec("2"), free_waiting_min=3,
                     peak_windows=(fare.PeakWindow(time(8), time(11), Dec("1.5")),))


def test_fare_offpeak():
    b = fare.calculate_fare(RULE, fare.FareInput(Dec("10"), Dec("25"), datetime(2026, 11, 24, 14, 0)))
    assert b.ride_fare == Dec("250.00") and b.peak_charge == 0


def test_fare_peak_waiting_tolls():
    b = fare.calculate_fare(RULE, fare.FareInput(Dec("10"), Dec("25"), datetime(2026, 11, 24, 9, 0),
                                                 waiting_min=Dec("8"), tolls=Dec("40")))
    assert b.peak_charge == Dec("125.00") and b.waiting_charge == Dec("10.00")
    assert b.ride_fare == Dec("385.00") and b.total == Dec("425.00")


def test_minimum_fare():
    b = fare.calculate_fare(RULE, fare.FareInput(Dec("0.5"), Dec("2"), datetime(2026, 11, 24, 14, 0)))
    assert b.ride_fare == Dec("100.00") and b.minimum_fare_adjustment > 0


def test_peak_window_over_midnight_and_cap():
    r = fare.FareRule(base_fare=Dec("10"), per_km=Dec("1"), per_min=Dec("0"), minimum_fare=Dec("0"),
                      peak_windows=(fare.PeakWindow(time(23), time(5), Dec("3.0")),), max_peak_multiplier=Dec("2.0"))
    assert fare.peak_multiplier_for(r, datetime(2026, 1, 1, 2, 0)) == Dec("2.0")
    assert fare.peak_multiplier_for(r, datetime(2026, 1, 1, 12, 0)) == Dec("1.0")


def test_estimate_range_ordered():
    lo, hi = fare.estimate_range(RULE, fare.FareInput(Dec("10"), Dec("25"), datetime(2026, 11, 24, 14)))
    assert lo <= hi


def test_negative_rejected():
    with pytest.raises(ValueError):
        fare.calculate_fare(RULE, fare.FareInput(Dec("-1"), Dec("2"), datetime.now()))


# ---------------- cancellation ----------------
T0 = datetime(2026, 11, 24, 10, 0)


@pytest.mark.parametrize("who", ["customer", "driver"])
def test_free_within_15_minutes_both_sides(who):
    d = cancellation.decide(initiator=who, booking_created_at=T0, cancelled_at=T0 + timedelta(minutes=15),
                            driver_arrived=True, recent_cancellations=0)
    assert d.within_free_window and d.fee == 0


def test_fee_after_window():
    d = cancellation.decide(initiator="customer", booking_created_at=T0, cancelled_at=T0 + timedelta(minutes=16),
                            driver_arrived=False, recent_cancellations=0, prepaid_amount=Dec("200"))
    assert d.fee == Dec("30.00") and d.fee_payer == "customer" and d.refund_due == Dec("170.00")


def test_abuse_cooldown_keeps_free_promise():
    d = cancellation.decide(initiator="customer", booking_created_at=T0, cancelled_at=T0 + timedelta(minutes=2),
                            driver_arrived=False, recent_cancellations=3)
    assert d.fee == 0 and d.abuse_flag and d.cooldown_until is not None


# ---------------- settlement ----------------
def test_settlement_nets_cash_commission_against_online():
    lines = [LedgerLine(1, EntryType.RIDE_EARNING_ONLINE, Dec("425")),
             LedgerLine(2, EntryType.RIDE_COMMISSION_CASH, Dec("-20")),
             LedgerLine(3, EntryType.RIDE_EARNING_ONLINE, Dec("800")),
             LedgerLine(4, EntryType.RIDE_EARNING_ONLINE, Dec("999"), settled=True)]
    p = settlement.plan_settlement(7, date(2026, 11, 23), lines, bank_verified=True)
    assert p.action == SettlementAction.PAYOUT and p.net == Dec("1205.00") and p.entry_ids == [1, 2, 3]
    assert p.idempotency_key == "settle:7:2026-11-23"


def test_settlement_cash_only_carries_dues():
    p = settlement.plan_settlement(7, date(2026, 11, 23), [LedgerLine(1, EntryType.RIDE_COMMISSION_CASH, Dec("-75"))],
                                   bank_verified=True)
    assert p.action == SettlementAction.CARRIED_FORWARD and p.net == Dec("-75.00") and p.entry_ids == []


def test_settlement_unverified_bank_on_hold():
    p = settlement.plan_settlement(7, date(2026, 11, 23), [LedgerLine(1, EntryType.RIDE_EARNING_ONLINE, Dec("100"))],
                                   bank_verified=False)
    assert p.action == SettlementAction.ON_HOLD


def test_payout_success_requires_provider():
    with pytest.raises(PermissionError):
        settlement.transition(PayoutStatus.PROCESSING, PayoutStatus.SUCCESS)
    assert settlement.transition(PayoutStatus.PROCESSING, PayoutStatus.SUCCESS, provider_confirmed=True) == "success"
    with pytest.raises(ValueError):
        settlement.transition(PayoutStatus.CREATED, PayoutStatus.SUCCESS, provider_confirmed=True)
    with pytest.raises(ValueError):
        settlement.transition(PayoutStatus.FAILED, PayoutStatus.PROCESSING, attempts=5)


# ---------------- ranking ----------------
def _ev(ride, cust, stars, **kw):
    base = dict(ride_id=ride, customer_id=cust, stars=stars, rated_at=T0 + timedelta(minutes=ride),
                ride_completed=True, ride_completed_at=T0, rater_is_ride_customer=True,
                ride_distance_km=Dec("5"), ride_duration_min=Dec("15"))
    base.update(kw)
    return ranking.RatingEvent(**base)


def test_duplicate_and_unverified_ratings_ignored():
    evs = [_ev(1, 1, 5), _ev(1, 1, 1), _ev(2, 2, 1, ride_completed=False), _ev(3, 3, 1, rater_is_ride_customer=False),
           _ev(4, 4, 1, ride_distance_km=Dec("0.1"))]
    _, _, n = ranking.weighted_rating(evs)
    assert n == 1


def test_repeat_rater_dampened():
    spam = [_ev(i, 99, 1) for i in range(1, 21)]
    fair = [_ev(100 + i, 100 + i, 1) for i in range(20)]
    assert ranking.weighted_rating(spam)[0] > ranking.weighted_rating(fair)[0]


def test_bayesian_prior_and_score_shape():
    few = ranking.weighted_rating([_ev(i, i, 5) for i in range(3)])[0]
    many = ranking.weighted_rating([_ev(i, i, 5) for i in range(500)])[0]
    assert few < many
    s = ranking.score([_ev(i, i, 5) for i in range(50)],
                      ranking.DriverStats(offered=100, accepted=95, completed=93, driver_cancellations_after_window=1,
                                          upheld_safety={}))
    assert set(s["factors"]) == {"rating", "completion", "acceptance", "cancellation", "safety"}
    assert 0 <= float(s["score"]) <= 100


# ---------------- quote signing ----------------
def test_quote_tamper_and_expiry():
    tok = quote.sign_quote({"fare": "250"}, "secret", ttl_seconds=60, now=1000)
    assert quote.verify_quote(tok, "secret", now=1010)["fare"] == "250"
    raw, sig = tok.split(".")
    forged = quote.sign_quote({"fare": "1"}, "other", now=1000).split(".")[0] + "." + sig
    with pytest.raises(quote.QuoteError):
        quote.verify_quote(forged, "secret", now=1010)
    with pytest.raises(quote.QuoteError):
        quote.verify_quote(tok, "secret", now=2000)


# ---------------- geo ----------------
def test_geo_basics():
    km = geo.haversine_km(13.0827, 80.2707, 12.9716, 77.5946)   # Chennai -> Bengaluru
    assert 280 < km < 300
    square = [[0, 0], [0, 1], [1, 1], [1, 0]]
    assert geo.point_in_polygon(0.5, 0.5, square) and not geo.point_in_polygon(2, 2, square)
    ranked = geo.rank_candidates(13.0, 80.0, [geo.Candidate(1, 13.0, 80.001, 90, 5), geo.Candidate(2, 13.03, 80.03, 99, 30),
                                              geo.Candidate(3, 14.0, 81.0, 100, 30)])
    assert [r[0] for r in ranked][0] == 1 and 3 not in [r[0] for r in ranked]
