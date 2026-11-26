from datetime import datetime, timedelta, timezone
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.serializers import ride as ride_out
from app.core.database import get_db
from app.core.deps import current_user, require_role
from app.models import (CallLog, CallSession, ChatMessage, City, Complaint, Coupon, FavouriteDriver, Notification,
                        Rating, Referral, Ride, User)
from app.models.ride import RideStatus
from app.models.support import COMPLAINT_CATEGORIES, SAFETY_CATEGORIES
from app.services import config_store, rides, telephony
from app.services.realtime import publish_sync

router = APIRouter(tags=["customer"])
customer = require_role("customer")


@router.get("/cities")
def public_cities(db: Session = Depends(get_db)):
    """Active cities and the vehicle types currently available in each (customers see only active ones)."""
    out = []
    for c in db.scalars(select(City).where(City.status == "active").order_by(City.name)):
        out.append({"id": c.id, "name": c.name, "state": c.state, "tier": c.tier, "center": [c.center_lat, c.center_lng],
                    "vehicles": [{"code": v.code, "name": v.name, "seats": v.seats, "description": v.description}
                                 for v in config_store.active_categories(db, c)]})
    return out


@router.get("/places")
def places(q: str, city: str | None = None, user: User = Depends(current_user)):
    """Place search through Google Places (server-side key). Returns [] when no key is configured."""
    import requests
    from app.core.config import get_settings
    key = get_settings().GOOGLE_MAPS_API_KEY
    if not key or len(q) < 2:
        return []
    try:
        r = requests.get("https://maps.googleapis.com/maps/api/place/textsearch/json", timeout=6,
                         params={"query": f"{q} {city or ''}".strip(), "region": "in", "key": key})
        return [{"address": x["name"] + (", " + x.get("formatted_address", "") if x.get("formatted_address") else ""),
                 "lat": x["geometry"]["location"]["lat"], "lng": x["geometry"]["location"]["lng"]}
                for x in r.json().get("results", [])[:7]]
    except Exception:  # noqa: BLE001
        return []


class QuoteIn(BaseModel):
    pickup_lat: float = Field(ge=6, le=37)
    pickup_lng: float = Field(ge=68, le=98)
    drop_lat: float = Field(ge=6, le=37)
    drop_lng: float = Field(ge=68, le=98)
    scheduled_for: datetime | None = None
    interstate: bool = False


@router.post("/rides/quote")
def quote(body: QuoteIn, user: User = Depends(customer), db: Session = Depends(get_db)):
    return rides.quote(db, user, body.model_dump())


class BookIn(BaseModel):
    quote_token: str
    pickup_address: str = Field(max_length=300)
    drop_address: str = Field(max_length=300)
    payment_method: str = Field("cash", pattern="^(cash|online)$")
    scheduled_for: datetime | None = None
    coupon_code: str | None = Field(None, max_length=20)


@router.post("/rides")
def book(body: BookIn, user: User = Depends(customer), db: Session = Depends(get_db)):
    r = rides.book(db, user, body.model_dump())
    db.commit()
    return ride_out(db, r, user)


@router.get("/rides")
def history(page: int = 1, user: User = Depends(current_user), db: Session = Depends(get_db)):
    q = select(Ride).order_by(Ride.created_at.desc()).limit(20).offset((page - 1) * 20)
    q = q.where(Ride.customer_id == user.id) if user.role == "customer" else q.where(Ride.driver_id == user.driver.id)
    return [ride_out(db, r, user) for r in db.scalars(q)]


def _ride_for(db, user: User, ride_id: int) -> Ride:
    r = db.get(Ride, ride_id)
    if not r:
        raise HTTPException(404, "Ride not found")
    if user.role == "admin" or r.customer_id == user.id or (user.role == "driver" and r.driver_id == user.driver.id):
        return r
    raise HTTPException(404, "Ride not found")


@router.get("/rides/{ride_id}")
def get_ride(ride_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    return ride_out(db, _ride_for(db, user, ride_id), user)


@router.get("/rides/{ride_id}/receipt")
def receipt(ride_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    r = _ride_for(db, user, ride_id)
    if r.status != RideStatus.COMPLETED:
        raise HTTPException(409, "Receipt is available after the ride is completed")
    return {"receipt_no": f"VYR-{r.code}", "issued_at": r.completed_at, "ride": ride_out(db, r, user),
            "company": {"name": "VAYORA Mobility Pvt. Ltd.", "gstin": "To be configured", "support": "support@vayora.in"}}


class CancelIn(BaseModel):
    reason: str = Field(min_length=2, max_length=200)


@router.post("/rides/{ride_id}/cancel")
def cancel(ride_id: int, body: CancelIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    r = _ride_for(db, user, ride_id)
    initiator = "customer" if r.customer_id == user.id else "driver" if user.role == "driver" else "admin"
    c = rides.cancel(db, user, r, body.reason, initiator)
    db.commit()
    return {"ride": ride_out(db, r, user), "cancellation": c.decision}


@router.get("/rides/{ride_id}/cancel-preview")
def cancel_preview(ride_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Shown in the cancel sheet so the user knows the fee (if any) before confirming."""
    r = _ride_for(db, user, ride_id)
    pol = config_store.cancellation_policy(db)
    mins = (datetime.now(timezone.utc) - r.created_at).total_seconds() / 60
    free = mins <= pol.free_window_min
    return {"free": free, "minutes_left_free": max(0, round(pol.free_window_min - mins, 1)),
            "fee_if_cancelled": "0" if free else str(pol.customer_fee_if_driver_arrived if r.status == "arrived" and user.role == "customer"
                                                     else pol.customer_fee_after_window if user.role == "customer" else pol.driver_fee_after_window)}


class RateIn(BaseModel):
    stars: int = Field(ge=1, le=5)
    tags: list[str] = Field(default_factory=list, max_length=6)
    comment: str | None = Field(None, max_length=500)
    favourite: bool = False


@router.post("/rides/{ride_id}/rate")
def rate(ride_id: int, body: RateIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    r = _ride_for(db, user, ride_id)
    if r.status != RideStatus.COMPLETED:
        raise HTTPException(409, "You can rate after the ride is completed")
    if r.completed_at < datetime.now(timezone.utc) - timedelta(days=7):
        raise HTTPException(409, "Rating window (7 days) has closed")
    if db.scalar(select(Rating).where(Rating.ride_id == r.id, Rating.rater_id == user.id)):
        raise HTTPException(409, "You have already rated this ride")
    is_customer = r.customer_id == user.id
    ratee = r.driver.user_id if is_customer else r.customer_id
    excluded = None
    if user.fraud_flag:
        excluded = "rater_flagged"
    elif Decimal(r.actual_distance_km or 0) < Decimal("0.5"):
        excluded = "ride_too_short"
    db.add(Rating(ride_id=r.id, rater_id=user.id, ratee_user_id=ratee, stars=body.stars, tags=body.tags,
                  comment=body.comment, direction="customer_to_driver" if is_customer else "driver_to_customer",
                  verified=excluded is None, excluded_reason=excluded))
    if is_customer and body.favourite and not db.scalar(select(FavouriteDriver).where(
            FavouriteDriver.customer_id == user.id, FavouriteDriver.driver_id == r.driver_id)):
        db.add(FavouriteDriver(customer_id=user.id, driver_id=r.driver_id))
    db.commit()
    if is_customer:
        from app.workers.tasks import recompute_rank
        recompute_rank.delay(r.driver_id)
    return {"ok": True}


@router.post("/rides/{ride_id}/sos")
def sos(ride_id: int, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    r = _ride_for(db, user, ride_id)
    r.sos_triggered = True
    rides.event(db, r, "sos", user, lat=r.driver.last_lat if r.driver else None, lng=r.driver.last_lng if r.driver else None)
    tk = Complaint(ticket=rides._code("SOS", 5), ride_id=r.id, raised_by=user.id, category="harassment_safety", priority="P1",
                   description="SOS triggered from app", sla_due_at=datetime.now(timezone.utc) + timedelta(minutes=5),
                   against_user_id=(r.driver.user_id if r.customer_id == user.id and r.driver else r.customer_id))
    db.add(tk)
    db.commit()
    publish_sync("admin:live", "sos", {"ride_id": r.id, "code": r.code, "by": user.full_name, "ticket": tk.ticket})
    from app.workers.tasks import alert_emergency_contacts
    alert_emergency_contacts.delay(user.id, r.id)
    sos_cfg = config_store.get(db, "sos")
    return {"ok": True, "ticket": tk.ticket, "helplines": sos_cfg,
            "message": "Our safety team has been alerted and your emergency contacts are being notified with your live location."}


# ---------------- in-app chat & masked calls ----------------
class MsgIn(BaseModel):
    body: str = Field(min_length=1, max_length=500)


@router.get("/rides/{ride_id}/messages")
def messages(ride_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    r = _ride_for(db, user, ride_id)
    return [{"id": m.id, "mine": m.sender_id == user.id, "body": m.body, "at": m.at}
            for m in db.scalars(select(ChatMessage).where(ChatMessage.ride_id == r.id).order_by(ChatMessage.id))]


@router.post("/rides/{ride_id}/messages")
def send_message(ride_id: int, body: MsgIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    r = _ride_for(db, user, ride_id)
    if r.status not in (RideStatus.ASSIGNED, RideStatus.ARRIVED, RideStatus.IN_PROGRESS):
        raise HTTPException(409, "Chat is available only during an active ride")
    m = ChatMessage(ride_id=r.id, sender_id=user.id, body=body.body, at=datetime.now(timezone.utc))
    db.add(m)
    db.commit()
    publish_sync(f"ride:{r.id}", "chat", {"id": m.id, "sender_id": user.id, "body": m.body, "at": m.at})
    return {"ok": True}


@router.post("/rides/{ride_id}/call")
def call(ride_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Bridges the two parties through the virtual number. Neither phone number is returned."""
    r = _ride_for(db, user, ride_id)
    sess = db.scalar(select(CallSession).where(CallSession.ride_id == r.id, CallSession.active.is_(True)))
    if not sess or sess.expires_at < datetime.now(timezone.utc):
        raise HTTPException(409, "Calling is available from driver assignment until 30 minutes after the trip")
    caller_is_customer = r.customer_id == user.id
    other = r.driver.user if caller_is_customer else r.customer
    res = telephony.get_provider().connect(user.phone, other.phone, sess.virtual_number)
    db.add(CallLog(session_id=sess.id, caller_role="customer" if caller_is_customer else "driver",
                   provider_call_id=res.provider_call_id, status=res.status, failure_reason=res.failure_reason,
                   started_at=datetime.now(timezone.utc)))
    db.commit()
    if res.status == "failed":
        raise HTTPException(502, "Could not connect the call. Please use in-app chat or try again.")
    return {"status": "connecting", "virtual_number": sess.virtual_number,
            "message": "You will receive a call from this number shortly. Your number stays private."}


# ---------------- complaints, coupons, referral, notifications, favourites ----------------
class ComplaintIn(BaseModel):
    category: str
    description: str = Field(min_length=10, max_length=2000)
    ride_id: int | None = None


@router.post("/complaints")
def create_complaint(body: ComplaintIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    if body.category not in COMPLAINT_CATEGORIES:
        raise HTTPException(422, "Unknown complaint category")
    against = vehicle = None
    if body.ride_id:
        r = _ride_for(db, user, body.ride_id)
        if r.customer_id == user.id and r.driver_id:
            against, vehicle = r.driver.user_id, r.vehicle_id
        elif user.role == "driver":
            against = r.customer_id
    safety = body.category in SAFETY_CATEGORIES
    prio = "P1" if safety else "P2" if body.category in ("payment_dispute", "wrong_fare", "lost_item") else "P3"
    sla = {"P1": timedelta(hours=1), "P2": timedelta(hours=24), "P3": timedelta(hours=72)}[prio]
    c = Complaint(ticket=rides._code("TK", 6), ride_id=body.ride_id, raised_by=user.id, against_user_id=against,
                  against_vehicle_id=vehicle, category=body.category, priority=prio, description=body.description,
                  sla_due_at=datetime.now(timezone.utc) + sla)
    db.add(c)
    db.commit()
    if safety:
        publish_sync("admin:live", "complaint.safety", {"ticket": c.ticket, "id": c.id})
    return {"ticket": c.ticket, "priority": prio, "sla_hours": int(sla.total_seconds() // 3600)}


@router.get("/complaints")
def my_complaints(user: User = Depends(current_user), db: Session = Depends(get_db)):
    return [{"ticket": c.ticket, "category": c.category, "status": c.status, "priority": c.priority,
             "created_at": c.created_at, "resolution": c.resolution,
             "updates": [{"body": a.body, "at": a.created_at} for a in c.actions if not a.internal]}
            for c in db.scalars(select(Complaint).where(Complaint.raised_by == user.id).order_by(Complaint.id.desc()))]


@router.get("/coupons")
def coupons(user: User = Depends(customer), db: Session = Depends(get_db)):
    now = datetime.now(timezone.utc)
    return [{"code": c.code, "description": c.description, "kind": c.kind, "value": str(c.value),
             "max_discount": str(c.max_discount), "min_fare": str(c.min_fare), "valid_to": c.valid_to}
            for c in db.scalars(select(Coupon).where(Coupon.active.is_(True), Coupon.valid_from <= now, Coupon.valid_to >= now))]


@router.get("/referral")
def referral(user: User = Depends(customer), db: Session = Depends(get_db)):
    rows = db.scalars(select(Referral).where(Referral.referrer_id == user.id)).all()
    cfg = config_store.get(db, "referral")
    return {"code": user.referral_code, "invited": len(rows), "rewarded": sum(r.status == "rewarded" for r in rows),
            "reward_each": cfg["referrer_reward"], "friend_gets": cfg["referee_reward"]}


@router.get("/favourites")
def favourites(user: User = Depends(customer), db: Session = Depends(get_db)):
    from app.models import DriverProfile
    out = []
    for f in db.scalars(select(FavouriteDriver).where(FavouriteDriver.customer_id == user.id)):
        d = db.get(DriverProfile, f.driver_id)
        out.append({"driver_id": d.id, "name": d.user.full_name, "tier": d.rank_tier, "online": d.is_online})
    return out


@router.get("/notifications")
def notifications(user: User = Depends(current_user), db: Session = Depends(get_db)):
    rows = db.scalars(select(Notification).where(Notification.user_id == user.id).order_by(Notification.id.desc()).limit(50))
    return [{"id": n.id, "title": n.title, "body": n.body, "kind": n.kind, "read": n.read, "at": n.created_at} for n in rows]


@router.post("/notifications/read-all")
def read_all(user: User = Depends(current_user), db: Session = Depends(get_db)):
    for n in db.scalars(select(Notification).where(Notification.user_id == user.id, Notification.read.is_(False))):
        n.read = True
    db.commit()
    return {"ok": True}
