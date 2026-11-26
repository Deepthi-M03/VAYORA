"""Ride lifecycle: quote -> book -> dispatch -> accept -> arrive -> start(OTP) -> complete -> rate.

All money is computed here on the server from stored fare rules. The client never sends a fare.
"""
from __future__ import annotations

import secrets
import string
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.engines import cancellation as cancel_engine
from app.engines import commission, fare
from app.engines.geo import Candidate, point_in_polygon, rank_candidates
from app.engines.quote import QuoteError, sign_quote, verify_quote
from app.engines.settlement import EntryType
from app.models import (CallSession, Cancellation, City, Coupon, CouponRedemption, DriverProfile, FareRuleRow,
                        PaymentTxn, Ride, RideEvent, User, Vehicle, VehicleCategory)
from app.models.ride import RideStatus
from app.services import config_store, ledger, maps, notify, telephony
from app.services.realtime import publish_sync


def now() -> datetime:
    return datetime.now(timezone.utc)


def _code(prefix="VY", n=6):
    return prefix + "".join(secrets.choice(string.ascii_uppercase + string.digits) for _ in range(n))


def event(db: Session, ride: Ride, kind: str, actor: User | None = None, **data):
    db.add(RideEvent(ride_id=ride.id, kind=kind, actor_id=actor.id if actor else None, data=data, at=now()))


def set_status(db: Session, ride: Ride, new: str, actor: User | None = None, **data):
    if new not in RideStatus.FLOW.get(ride.status, set()):
        raise HTTPException(409, f"Ride is {ride.status}; cannot move to {new}")
    ride.status = new
    event(db, ride, f"status:{new}", actor, **data)
    payload = {"ride_id": ride.id, "code": ride.code, "status": new, **data}
    publish_sync(f"ride:{ride.id}", "ride.status", payload)
    publish_sync("admin:live", "ride.status", payload)


# ------------------------------------------------------------------ quoting
def city_for_point(db: Session, lat: float, lng: float) -> City:
    cities = db.scalars(select(City).where(City.status == "active")).all()
    for c in cities:
        if c.boundary and point_in_polygon(lat, lng, c.boundary):
            return c
    # fallback: nearest active city within 60 km of its centre
    from app.engines.geo import haversine_km
    best = min(cities, key=lambda c: haversine_km(lat, lng, c.center_lat, c.center_lng), default=None)
    if best and haversine_km(lat, lng, best.center_lat, best.center_lng) <= 60:
        return best
    raise HTTPException(422, "VAYORA is not yet available at this pickup location")


def quote(db: Session, user: User, p: dict) -> dict:
    city = city_for_point(db, p["pickup_lat"], p["pickup_lng"])
    when = p.get("scheduled_for") or now()
    options = []
    for cat in config_store.active_categories(db, city):
        if cat.is_interstate is False and p.get("interstate"):
            continue
        row = config_store.current_rule(db, city.id, cat.id)
        km, mins, src = maps.route(p["pickup_lat"], p["pickup_lng"], p["drop_lat"], p["drop_lng"], cat.code)
        if not cat.is_interstate and km > 80:
            continue  # long trips are offered only as tourist/interstate
        rule = config_store.to_engine_rule(row)
        inp = fare.FareInput(km, mins, when.astimezone(timezone(timedelta(hours=5, minutes=30))))
        lo, hi = fare.estimate_range(rule, inp)
        bd = fare.calculate_fare(rule, inp)
        token = sign_quote({"uid": user.id, "city": city.id, "cat": cat.id, "rule": row.id, "km": str(km), "min": str(mins),
                            "lo": str(lo), "hi": str(hi), "p": [p["pickup_lat"], p["pickup_lng"]],
                            "d": [p["drop_lat"], p["drop_lng"]], "at": when.isoformat()},
                           get_settings().QUOTE_SECRET, ttl_seconds=600)
        options.append({"category": cat.code, "name": cat.name, "seats": cat.seats, "eta_pickup_min": _eta(db, city, cat, p),
                        "distance_km": str(km), "duration_min": str(mins), "route_source": src,
                        "estimate_low": str(lo), "estimate_high": str(hi), "breakdown": bd.to_dict(),
                        "peak": str(bd.peak_multiplier) != "1.0", "quote_token": token})
    return {"city": {"id": city.id, "name": city.name, "tier": city.tier}, "options": options,
            "note": "Estimated fare. Final fare is based on actual distance, time, waiting, tolls and parking."}


def _eta(db, city, cat, p) -> int | None:
    drivers = _online_drivers(db, city.id, cat.id)
    ranked = rank_candidates(p["pickup_lat"], p["pickup_lng"], drivers, radius_km=6)
    return None if not ranked else max(2, round(ranked[0][1] / 22 * 60))


def _online_drivers(db, city_id, cat_id, exclude: list[int] | None = None) -> list[Candidate]:
    rows = db.execute(
        select(DriverProfile, Vehicle).join(Vehicle, Vehicle.id == DriverProfile.active_vehicle_id)
        .join(User, User.id == DriverProfile.user_id)
        .where(DriverProfile.city_id == city_id, DriverProfile.is_online.is_(True), Vehicle.category_id == cat_id,
               Vehicle.status == "approved", DriverProfile.onboarding_status == "approved", User.status == "active",
               DriverProfile.last_seen_at > now() - timedelta(minutes=3))
    ).all()
    busy = set(db.scalars(select(Ride.driver_id).where(Ride.status.in_([RideStatus.ASSIGNED, RideStatus.ARRIVED,
                                                                         RideStatus.IN_PROGRESS]))).all())
    out = []
    for d, _v in rows:
        if d.id in busy or (exclude and d.id in exclude) or d.last_lat is None:
            continue
        idle = (now() - (d.online_since or now())).total_seconds() / 60
        out.append(Candidate(d.id, d.last_lat, d.last_lng, float(d.rank_score or 0), idle))
    return out


# ------------------------------------------------------------------ booking
def book(db: Session, user: User, body: dict) -> Ride:
    if user.booking_cooldown_until and user.booking_cooldown_until > now():
        raise HTTPException(429, "Too many recent cancellations. You can book again shortly.")
    if db.scalar(select(func.count()).select_from(Ride).where(
            Ride.customer_id == user.id, Ride.status.in_([RideStatus.SEARCHING, RideStatus.ASSIGNED,
                                                          RideStatus.ARRIVED, RideStatus.IN_PROGRESS]))):
        raise HTTPException(409, "You already have an active ride")
    try:
        q = verify_quote(body["quote_token"], get_settings().QUOTE_SECRET)
    except QuoteError as exc:
        raise HTTPException(422, str(exc))
    if q["uid"] != user.id:
        raise HTTPException(403, "Quote belongs to another user")
    cat = db.get(VehicleCategory, q["cat"])
    city = db.get(City, q["city"])
    if cat not in config_store.active_categories(db, city):
        raise HTTPException(422, f"{cat.name} is not available in {city.name} right now")
    row = db.get(FareRuleRow, q["rule"])
    rule = config_store.to_engine_rule(row)
    est = fare.calculate_fare(rule, fare.FareInput(Decimal(q["km"]), Decimal(q["min"]), datetime.fromisoformat(q["at"])))

    scheduled = body.get("scheduled_for")
    if scheduled and scheduled < now() + timedelta(minutes=20):
        raise HTTPException(422, "Scheduled rides must be at least 20 minutes ahead")
    ride = Ride(code=_code(), customer_id=user.id, city_id=city.id, category_id=cat.id, fare_rule_id=row.id,
                status=RideStatus.SCHEDULED if scheduled else RideStatus.SEARCHING, scheduled_for=scheduled,
                pickup_address=body["pickup_address"], pickup_lat=q["p"][0], pickup_lng=q["p"][1],
                drop_address=body["drop_address"], drop_lat=q["d"][0], drop_lng=q["d"][1],
                est_distance_km=Decimal(q["km"]), est_duration_min=Decimal(q["min"]),
                est_fare_low=Decimal(q["lo"]), est_fare_high=Decimal(q["hi"]), est_breakdown=est.to_dict(),
                payment_method=body.get("payment_method", "cash"), otp=f"{secrets.randbelow(10000):04d}")
    db.add(ride)
    db.flush()
    if body.get("coupon_code"):
        ride.coupon_id = validate_coupon(db, user, body["coupon_code"], city.id, cat.code, est.ride_fare).id
    event(db, ride, "booked", user, quote_low=q["lo"], quote_high=q["hi"])
    if not scheduled:
        dispatch(db, ride)
    return ride


def validate_coupon(db, user, code, city_id, cat_code, fare_amount) -> Coupon:
    c = db.scalar(select(Coupon).where(func.upper(Coupon.code) == code.upper(), Coupon.active.is_(True)))
    if not c or not (c.valid_from <= now() <= c.valid_to):
        raise HTTPException(422, "Coupon is invalid or expired")
    if (c.city_id and c.city_id != city_id) or (c.category_code and c.category_code != cat_code):
        raise HTTPException(422, "Coupon not valid for this city or vehicle")
    used = db.scalar(select(func.count()).select_from(CouponRedemption).where(CouponRedemption.coupon_id == c.id,
                                                                              CouponRedemption.user_id == user.id))
    if used >= c.per_user_limit:
        raise HTTPException(422, "You have already used this coupon")
    if c.total_limit and db.scalar(select(func.count()).select_from(CouponRedemption)
                                   .where(CouponRedemption.coupon_id == c.id)) >= c.total_limit:
        raise HTTPException(422, "Coupon fully redeemed")
    if Decimal(fare_amount) < c.min_fare:
        raise HTTPException(422, f"Coupon needs a minimum fare of ₹{c.min_fare}")
    return c


def coupon_discount(c: Coupon, ride_fare: Decimal) -> Decimal:
    d = c.value if c.kind == "flat" else (ride_fare * c.value / 100)
    return min(Decimal(d), Decimal(c.max_discount), ride_fare).quantize(Decimal("0.01"))


def dispatch(db: Session, ride: Ride):
    """Offer to the best candidate drivers. They race to accept; first valid accept wins."""
    cfg = config_store.get(db, "dispatch")
    cands = _online_drivers(db, ride.city_id, ride.category_id, exclude=ride.declined_by)
    ranked = rank_candidates(ride.pickup_lat, ride.pickup_lng, cands, radius_km=cfg["radius_km"])[: cfg["max_offers"]]
    if not ranked:
        event(db, ride, "dispatch:none")
        publish_sync(f"ride:{ride.id}", "ride.searching", {"ride_id": ride.id, "candidates": 0})
        return
    offer = {"ride_id": ride.id, "code": ride.code, "pickup": ride.pickup_address, "drop": ride.drop_address,
             "distance_km": str(ride.est_distance_km), "est_earning": str(_driver_estimate(db, ride)),
             "payment_method": ride.payment_method, "expires_in": cfg["offer_timeout_sec"]}
    for driver_id, dist, _ in ranked:
        d = db.get(DriverProfile, driver_id)
        d.offered_count += 1
        publish_sync(f"user:{d.user_id}", "ride.offer", {**offer, "pickup_distance_km": dist})
    event(db, ride, "dispatch:offered", drivers=[r[0] for r in ranked])


def _driver_estimate(db, ride) -> Decimal:
    mid = (Decimal(ride.est_fare_low) + Decimal(ride.est_fare_high)) / 2
    return commission.split(mid, slabs=config_store.slabs(db)).driver_earnings


# ------------------------------------------------------------------ driver actions
def accept(db: Session, driver_user: User, ride_id: int) -> Ride:
    d = driver_user.driver
    ride = db.scalar(select(Ride).where(Ride.id == ride_id).with_for_update())   # row lock: no double-accept
    if not ride or ride.status != RideStatus.SEARCHING:
        raise HTTPException(409, "Ride already taken or cancelled")
    if not d.is_online or d.onboarding_status != "approved":
        raise HTTPException(403, "Go online with an approved profile to accept rides")
    veh = db.get(Vehicle, d.active_vehicle_id)
    if not veh or veh.category_id != ride.category_id or veh.status != "approved":
        raise HTTPException(403, "Your active vehicle does not match this ride")
    ride.driver_id, ride.vehicle_id, ride.assigned_at = d.id, veh.id, now()
    d.accepted_count += 1
    set_status(db, ride, RideStatus.ASSIGNED, driver_user, driver_id=d.id)
    _open_call_bridge(db, ride)
    notify.send(db, ride.customer, "Driver on the way",
                f"{driver_user.full_name} · {veh.colour} {veh.make} {veh.model} · {veh.registration_number}", "ride", {"ride_id": ride.id})
    return ride


def reject(db: Session, driver_user: User, ride_id: int):
    ride = db.get(Ride, ride_id)
    if ride and driver_user.driver.id not in (ride.declined_by or []):
        ride.declined_by = [*(ride.declined_by or []), driver_user.driver.id]


def _open_call_bridge(db, ride: Ride):
    prov = telephony.get_provider()
    res = prov.open_session(ride.code, ride.customer.phone, ride.driver.user.phone)
    db.add(CallSession(ride_id=ride.id, provider=prov.name, virtual_number=res.virtual_number,
                       provider_session_id=res.provider_session_id, expires_at=now() + timedelta(hours=6)))


def mark_arrived(db, driver_user, ride: Ride):
    _own(driver_user, ride)
    ride.arrived_at = now()
    set_status(db, ride, RideStatus.ARRIVED, driver_user)
    notify.send(db, ride.customer, "Your driver has arrived", f"Share OTP {ride.otp} to start the ride", "ride", {"ride_id": ride.id})


def start(db, driver_user, ride: Ride, otp: str):
    _own(driver_user, ride)
    if not secrets.compare_digest(otp, ride.otp):
        raise HTTPException(422, "Incorrect OTP")
    ride.started_at = now()
    if ride.arrived_at:
        ride.waiting_min = Decimal(round((ride.started_at - ride.arrived_at).total_seconds() / 60, 1))
    set_status(db, ride, RideStatus.IN_PROGRESS, driver_user)


def complete(db, driver_user, ride: Ride, *, actual_km: Decimal | None, tolls: Decimal, parking: Decimal) -> Ride:
    _own(driver_user, ride)
    ride.completed_at = now()
    ride.actual_duration_min = Decimal(max(1, round((ride.completed_at - ride.started_at).total_seconds() / 60)))
    # Distance: GPS trace if the driver app sent enough points, else the planned route. Cap at 1.5x to block GPS spoofing.
    km = Decimal(actual_km) if actual_km else Decimal(ride.est_distance_km)
    ride.actual_distance_km = min(km, Decimal(ride.est_distance_km) * Decimal("1.5")).quantize(Decimal("0.01"))
    ride.tolls, ride.parking = tolls, parking

    row = db.get(FareRuleRow, ride.fare_rule_id)  # the pricing version quoted at booking
    bd = fare.calculate_fare(config_store.to_engine_rule(row),
                             fare.FareInput(ride.actual_distance_km, ride.actual_duration_min,
                                            ride.started_at.astimezone(timezone(timedelta(hours=5, minutes=30))),
                                            Decimal(ride.waiting_min), tolls, parking), is_estimate=False)
    if ride.coupon_id:
        c = db.get(Coupon, ride.coupon_id)
        ride.discount = coupon_discount(c, bd.ride_fare)
        db.add(CouponRedemption(coupon_id=c.id, user_id=ride.customer_id, ride_id=ride.id, amount=ride.discount))
    split = commission.split(bd.ride_fare, tolls=tolls, parking=parking, taxes=bd.taxes, discount=ride.discount,
                             slabs=config_store.slabs(db),
                             commission_tax_rate=Decimal(config_store.get(db, "commission_tax_rate")))
    final = bd.to_dict()
    dues = Decimal(ride.customer.outstanding_dues or 0)
    if dues > 0:   # earlier late-cancellation fee, company revenue; not commissionable, not driver money
        final["lines"].append({"label": "Previous cancellation fee", "amount": str(dues)})
        final["total"] = str(bd.total + dues)
        ride.customer.outstanding_dues = Decimal(0)
        split.customer_paid += dues
    ride.final_breakdown, ride.ride_fare, ride.final_total = final, bd.ride_fare, Decimal(final["total"])
    ride.commission_rate, ride.company_commission, ride.driver_earnings = split.commission_rate, split.company_commission, split.driver_earnings
    ride.commission_snapshot = {**split.to_dict(), "prior_dues": str(dues), "slabs": config_store.get(db, "commission_slabs")}
    driver_user.driver.completed_count += 1
    set_status(db, ride, RideStatus.COMPLETED, driver_user, final_total=str(bd.total))

    if ride.payment_method == "cash":
        ride.payment_status = "paid"
        db.add(PaymentTxn(ride_id=ride.id, customer_id=ride.customer_id, amount=split.customer_paid,
                          method="cash", status="cash_recorded"))
        ledger.post_ride(db, ride)
    # online: ledger posts when Razorpay confirms capture (see routes/payments.py)
    sess = db.scalar(select(CallSession).where(CallSession.ride_id == ride.id))
    if sess:
        sess.expires_at = now() + timedelta(minutes=30)
    notify.send(db, ride.customer, "Trip completed", f"Final fare ₹{split.customer_paid}. Rate your ride!", "ride", {"ride_id": ride.id})
    return ride


def _own(driver_user: User, ride: Ride):
    if ride.driver_id != driver_user.driver.id:
        raise HTTPException(403, "Not your ride")


# ------------------------------------------------------------------ cancellation
def cancel(db: Session, actor: User, ride: Ride, reason: str, initiator: str) -> Cancellation:
    if ride.status in (RideStatus.COMPLETED, RideStatus.CANCELLED, RideStatus.IN_PROGRESS):
        raise HTTPException(409, f"Ride is {ride.status} and cannot be cancelled")
    window_start = now() - timedelta(hours=24)
    recent = db.scalar(select(func.count()).select_from(Cancellation).where(
        Cancellation.initiator_user_id == actor.id, Cancellation.cancelled_at >= window_start)) or 0
    paid = db.scalar(select(func.coalesce(func.sum(PaymentTxn.amount), 0)).where(
        PaymentTxn.ride_id == ride.id, PaymentTxn.status == "captured")) or 0
    decision = cancel_engine.decide(initiator=initiator, booking_created_at=ride.created_at, cancelled_at=now(),
                                    driver_arrived=ride.status == RideStatus.ARRIVED, recent_cancellations=recent,
                                    prepaid_amount=paid, policy=config_store.cancellation_policy(db))
    c = Cancellation(ride_id=ride.id, booking_created_at=ride.created_at, cancelled_at=now(), initiator=initiator,
                     initiator_user_id=actor.id, reason=reason[:200], policy_applied=decision.policy_applied,
                     within_free_window=decision.within_free_window, fee=decision.fee, fee_payer=decision.fee_payer,
                     refund_status="pending" if decision.refund_due > 0 else "not_applicable",
                     abuse_flag=decision.abuse_flag, decision=decision.to_dict())
    db.add(c)
    if decision.cooldown_until:
        actor.booking_cooldown_until = decision.cooldown_until
        actor.fraud_flag = actor.fraud_flag or recent + 1 >= 2 * config_store.cancellation_policy(db).abuse_threshold

    if initiator == "driver":
        # Driver cancels: ride goes back to the pool for the customer, driver is excluded.
        d = actor.driver
        if not decision.within_free_window:
            d.late_cancel_count += 1
        if decision.fee:
            ledger.post(db, d.id, EntryType.CANCEL_FEE_DEBIT, -decision.fee, ride_id=ride.id, memo="Late cancellation")
        ride.declined_by = [*(ride.declined_by or []), d.id]
        ride.driver_id = ride.vehicle_id = None
        set_status(db, ride, RideStatus.SEARCHING, actor, reason="driver_cancelled")
        dispatch(db, ride)
    else:
        set_status(db, ride, RideStatus.CANCELLED, actor, by=initiator, fee=str(decision.fee))
        if decision.fee and decision.fee_payer == "customer" and Decimal(paid) < decision.fee:
            # Not prepaid: the fee is shown up-front and added to the customer's next ride.
            ride.customer.outstanding_dues = Decimal(ride.customer.outstanding_dues or 0) + decision.fee - Decimal(paid)
        if decision.fee and ride.driver_id and decision.fee_payer == "customer":
            # Customer late-cancel fee compensates the driver who was on the way.
            ledger.post(db, ride.driver_id, EntryType.CANCEL_FEE_CREDIT, decision.fee, ride_id=ride.id,
                        memo="Customer late-cancellation compensation")
    return c
