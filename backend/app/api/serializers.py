"""Response shaping. Personal phone numbers never leave the server through these helpers."""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import CallSession, Ride, User, Vehicle


def user_public(u: User) -> dict:
    return {"id": u.id, "name": u.full_name, "avatar": u.avatar_url}


def me(u: User) -> dict:
    return {"id": u.id, "role": u.role, "admin_role": u.admin_role, "name": u.full_name, "email": u.email,
            "phone": u.phone, "language": u.language, "status": u.status, "referral_code": u.referral_code,
            "avatar": u.avatar_url, "outstanding_dues": str(u.outstanding_dues or 0),
            "driver_id": u.driver.id if u.role == "driver" and u.driver else None}


def ride(db: Session, r: Ride, viewer: User) -> dict:
    out = {
        "id": r.id, "code": r.code, "status": r.status, "category": r.category.code, "category_name": r.category.name,
        "city": r.city.name, "pickup": {"address": r.pickup_address, "lat": r.pickup_lat, "lng": r.pickup_lng},
        "drop": {"address": r.drop_address, "lat": r.drop_lat, "lng": r.drop_lng},
        "scheduled_for": r.scheduled_for, "created_at": r.created_at,
        "estimate": {"low": str(r.est_fare_low), "high": str(r.est_fare_high), "distance_km": str(r.est_distance_km),
                     "duration_min": str(r.est_duration_min), "breakdown": r.est_breakdown, "is_estimate": True},
        "final": None if r.final_total is None else {"total": str(r.final_total), "discount": str(r.discount),
                                                      "breakdown": r.final_breakdown, "is_estimate": False},
        "payment_method": r.payment_method, "payment_status": r.payment_status,
        "timeline": {"assigned": r.assigned_at, "arrived": r.arrived_at, "started": r.started_at, "completed": r.completed_at},
        "sos": r.sos_triggered,
    }
    if r.driver_id:
        v = db.get(Vehicle, r.vehicle_id)
        d = r.driver
        out["driver"] = {"id": d.id, "name": d.user.full_name, "avatar": d.user.avatar_url, "rating": d.rank_snapshot.get("rating", {}).get("bayesian"),
                         "tier": d.rank_tier, "lat": d.last_lat, "lng": d.last_lng,
                         "vehicle": {"reg": v.registration_number, "make": v.make, "model": v.model, "colour": v.colour} if v else None}
    sess = db.scalar(select(CallSession).where(CallSession.ride_id == r.id, CallSession.active.is_(True)))
    if sess:
        out["masked_number"] = sess.virtual_number
    if viewer.id == r.customer_id:
        out["otp"] = r.otp if r.status in ("assigned", "arrived") else None
    if viewer.role == "driver":
        out["customer"] = user_public(r.customer)
        out["earning"] = None if r.driver_earnings is None else {
            "ride_fare": str(r.ride_fare), "commission_rate": str(r.commission_rate),
            "commission": str(r.company_commission), "driver_earnings": str(r.driver_earnings)}
    if viewer.role == "admin":
        out["finance"] = r.commission_snapshot
        out["customer"] = user_public(r.customer)
    return out
