import csv
import io
import os
import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.serializers import ride as ride_out
from app.core.config import get_settings
from app.core.database import get_db
from app.core.deps import require_role
from app.models import (DriverDocument, LedgerEntry, Payout, Rating, Ride, Settlement, User, Vehicle, VehicleCategory)
from app.models.ride import RideStatus
from app.services import rides
from app.services.crypto import encrypt
from app.services.realtime import publish_sync

router = APIRouter(prefix="/driver", tags=["driver"])
driver = require_role("driver")
IST = timezone(timedelta(hours=5, minutes=30))
DOC_TYPES = {"photo", "licence", "aadhaar", "pan", "rc", "insurance", "vehicle_photo", "bank_proof", "permit"}
REQUIRED_DOCS = {"photo", "licence", "aadhaar", "rc", "insurance", "vehicle_photo", "bank_proof"}


# ---------------- onboarding ----------------
class ProfileIn(BaseModel):
    city_id: int
    licence_number: str = Field(pattern=r"^[A-Z]{2}[0-9]{2}[ -]?[0-9]{4}[0-9]{7}$")
    licence_expiry: date


@router.get("/onboarding")
def onboarding(user: User = Depends(driver)):
    d = user.driver
    docs = {doc.doc_type: {"status": doc.status, "note": doc.review_note} for doc in d.documents}
    return {"status": d.onboarding_status, "rejection_reason": d.rejection_reason, "city_id": d.city_id,
            "licence_number": d.licence_number, "bank": {"last4": d.bank_account_last4, "ifsc": d.bank_ifsc, "verified": d.bank_verified},
            "documents": docs, "missing": sorted(REQUIRED_DOCS - set(docs)),
            "vehicles": [{"id": v.id, "reg": v.registration_number, "category": v.category.code, "status": v.status}
                         for v in d.vehicles]}


@router.put("/onboarding/profile")
def set_profile(body: ProfileIn, user: User = Depends(driver), db: Session = Depends(get_db)):
    if body.licence_expiry <= date.today():
        raise HTTPException(422, "Driving licence has expired")
    d = user.driver
    d.city_id, d.licence_number, d.licence_expiry = body.city_id, body.licence_number, body.licence_expiry
    db.commit()
    return {"ok": True}


class BankIn(BaseModel):
    account_number: str = Field(pattern=r"^\d{9,18}$")
    ifsc: str = Field(pattern=r"^[A-Z]{4}0[A-Z0-9]{6}$")
    holder_name: str = Field(max_length=120)


@router.put("/onboarding/bank")
def set_bank(body: BankIn, user: User = Depends(driver), db: Session = Depends(get_db)):
    d = user.driver
    d.bank_account_enc, d.bank_account_last4 = encrypt(body.account_number), body.account_number[-4:]
    d.bank_ifsc, d.bank_holder_name, d.bank_verified = body.ifsc, body.holder_name, False   # re-verify on change
    db.commit()
    from app.workers.tasks import verify_bank_account
    verify_bank_account.delay(d.id)   # penny-drop via RazorpayX fund account validation
    return {"ok": True, "message": "Bank details saved. Verification usually takes a few minutes."}


class VehicleIn(BaseModel):
    category: str
    registration_number: str = Field(pattern=r"^[A-Z]{2}[0-9]{1,2}[A-Z]{0,3}[0-9]{4}$")
    make: str
    model: str
    colour: str
    year: int = Field(ge=2008, le=2030)
    seats: int = Field(ge=1, le=20)
    insurance_expiry: date
    permit_type: str | None = None


@router.post("/onboarding/vehicle")
def add_vehicle(body: VehicleIn, user: User = Depends(driver), db: Session = Depends(get_db)):
    cat = db.scalar(select(VehicleCategory).where(VehicleCategory.code == body.category))
    if not cat:
        raise HTTPException(422, "Unknown vehicle category")
    if cat.is_interstate and not body.permit_type:
        raise HTTPException(422, "Interstate tourist vehicles need an All-India Tourist Permit")
    if db.scalar(select(Vehicle).where(Vehicle.registration_number == body.registration_number)):
        raise HTTPException(409, "Vehicle already registered")
    v = Vehicle(driver_id=user.driver.id, category_id=cat.id, **body.model_dump(exclude={"category"}))
    db.add(v)
    db.flush()
    if not user.driver.active_vehicle_id:
        user.driver.active_vehicle_id = v.id
    db.commit()
    return {"id": v.id}


@router.post("/onboarding/documents")
async def upload_doc(doc_type: str = Form(...), vehicle_id: int | None = Form(None), file: UploadFile = File(...),
                     user: User = Depends(driver), db: Session = Depends(get_db)):
    if doc_type not in DOC_TYPES:
        raise HTTPException(422, "Unknown document type")
    if file.content_type not in ("image/jpeg", "image/png", "application/pdf"):
        raise HTTPException(415, "Upload a JPG, PNG or PDF")
    data = await file.read(8 * 1024 * 1024 + 1)
    if len(data) > 8 * 1024 * 1024:
        raise HTTPException(413, "File must be under 8 MB")
    ext = {"image/jpeg": "jpg", "image/png": "png", "application/pdf": "pdf"}[file.content_type]
    key = f"drivers/{user.driver.id}/{doc_type}-{uuid.uuid4().hex}.{ext}"   # never trust the client filename
    path = os.path.join(get_settings().UPLOAD_DIR, key)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(data)
    db.add(DriverDocument(driver_id=user.driver.id, vehicle_id=vehicle_id, doc_type=doc_type, file_key=key))
    db.commit()
    return {"ok": True}


@router.post("/onboarding/submit")
def submit(user: User = Depends(driver), db: Session = Depends(get_db)):
    d = user.driver
    missing = REQUIRED_DOCS - {doc.doc_type for doc in d.documents}
    if missing or not d.licence_number or not d.vehicles or not d.bank_account_last4:
        raise HTTPException(422, f"Complete your profile first. Missing: {', '.join(sorted(missing)) or 'profile/vehicle/bank'}")
    d.onboarding_status = "submitted"
    db.commit()
    publish_sync("admin:live", "driver.submitted", {"driver_id": d.id, "name": user.full_name})
    return {"ok": True}


# ---------------- live operations ----------------
class OnlineIn(BaseModel):
    online: bool
    lat: float | None = None
    lng: float | None = None


@router.post("/status")
def set_online(body: OnlineIn, user: User = Depends(driver), db: Session = Depends(get_db)):
    d = user.driver
    if body.online:
        if d.onboarding_status != "approved":
            raise HTTPException(403, "Your profile is awaiting approval")
        v = d.active_vehicle_id and db.get(Vehicle, d.active_vehicle_id)
        if not v or v.status != "approved":
            raise HTTPException(403, "Your active vehicle is not approved or is suspended")
        if not v.category or not v.category.globally_active:
            raise HTTPException(403, f"{v.category.name} rides are currently paused on VAYORA")
        d.online_since = datetime.now(timezone.utc)
    d.is_online = body.online
    if body.lat is not None:
        d.last_lat, d.last_lng, d.last_seen_at = body.lat, body.lng, datetime.now(timezone.utc)
    db.commit()
    return {"online": d.is_online}


class LocIn(BaseModel):
    lat: float
    lng: float
    heading: float | None = None
    speed_kmph: float | None = None


@router.post("/location")
def location(body: LocIn, user: User = Depends(driver), db: Session = Depends(get_db)):
    d = user.driver
    d.last_lat, d.last_lng, d.last_seen_at = body.lat, body.lng, datetime.now(timezone.utc)
    active = db.scalar(select(Ride).where(Ride.driver_id == d.id, Ride.status.in_(
        [RideStatus.ASSIGNED, RideStatus.ARRIVED, RideStatus.IN_PROGRESS])))
    if active:
        if active.status == RideStatus.IN_PROGRESS:
            active.route_trace = [*(active.route_trace or [])[-2000:], [body.lat, body.lng, int(d.last_seen_at.timestamp())]]
        publish_sync(f"ride:{active.id}", "driver.location", {"lat": body.lat, "lng": body.lng, "heading": body.heading})
    db.commit()
    return {"ok": True}


@router.get("/current")
def current(user: User = Depends(driver), db: Session = Depends(get_db)):
    r = db.scalar(select(Ride).where(Ride.driver_id == user.driver.id, Ride.status.in_(
        [RideStatus.ASSIGNED, RideStatus.ARRIVED, RideStatus.IN_PROGRESS])))
    return ride_out(db, r, user) if r else None


@router.post("/rides/{ride_id}/accept")
def accept(ride_id: int, user: User = Depends(driver), db: Session = Depends(get_db)):
    r = rides.accept(db, user, ride_id)
    db.commit()
    return ride_out(db, r, user)


@router.post("/rides/{ride_id}/reject")
def reject(ride_id: int, user: User = Depends(driver), db: Session = Depends(get_db)):
    rides.reject(db, user, ride_id)
    db.commit()
    return {"ok": True}


@router.post("/rides/{ride_id}/arrived")
def arrived(ride_id: int, user: User = Depends(driver), db: Session = Depends(get_db)):
    r = db.get(Ride, ride_id)
    rides.mark_arrived(db, user, r)
    db.commit()
    return ride_out(db, r, user)


class StartIn(BaseModel):
    otp: str = Field(pattern=r"^\d{4}$")


@router.post("/rides/{ride_id}/start")
def start(ride_id: int, body: StartIn, user: User = Depends(driver), db: Session = Depends(get_db)):
    r = db.get(Ride, ride_id)
    rides.start(db, user, r, body.otp)
    db.commit()
    return ride_out(db, r, user)


class CompleteIn(BaseModel):
    tolls: Decimal = Field(Decimal(0), ge=0, le=5000)
    parking: Decimal = Field(Decimal(0), ge=0, le=1000)


@router.post("/rides/{ride_id}/complete")
def complete(ride_id: int, body: CompleteIn, user: User = Depends(driver), db: Session = Depends(get_db)):
    r = db.get(Ride, ride_id)
    km = _trace_km(r.route_trace or [])
    rides.complete(db, user, r, actual_km=km, tolls=body.tolls, parking=body.parking)
    db.commit()
    return ride_out(db, r, user)


def _trace_km(trace: list) -> Decimal | None:
    from app.engines.geo import haversine_km
    if len(trace) < 5:
        return None
    return Decimal(str(round(sum(haversine_km(a[0], a[1], b[0], b[1]) for a, b in zip(trace, trace[1:])), 2)))


# ---------------- earnings & settlements ----------------
def _earned_between(db, did, start, end) -> dict:
    q = select(func.count(Ride.id), func.coalesce(func.sum(Ride.ride_fare), 0), func.coalesce(func.sum(Ride.company_commission), 0),
               func.coalesce(func.sum(Ride.driver_earnings), 0)).where(
        Ride.driver_id == did, Ride.status == RideStatus.COMPLETED, Ride.completed_at >= start, Ride.completed_at < end)
    n, gross, comm, net = db.execute(q).one()
    cash = db.scalar(select(func.coalesce(func.sum(Ride.final_total), 0)).where(
        Ride.driver_id == did, Ride.status == RideStatus.COMPLETED, Ride.payment_method == "cash",
        Ride.completed_at >= start, Ride.completed_at < end))
    return {"rides": n, "gross_fare": str(gross), "commission": str(comm), "earnings": str(net), "cash_collected": str(cash)}


@router.get("/earnings")
def earnings(user: User = Depends(driver), db: Session = Depends(get_db)):
    d = user.driver
    now = datetime.now(IST)
    today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    week = today - timedelta(days=today.weekday())
    month = today.replace(day=1)
    daily = []
    for i in range(13, -1, -1):
        s = today - timedelta(days=i)
        daily.append({"date": s.date().isoformat(), **_earned_between(db, d.id, s, s + timedelta(days=1))})
    pending = db.scalar(select(func.coalesce(func.sum(LedgerEntry.amount), 0)).where(
        LedgerEntry.driver_id == d.id, LedgerEntry.settlement_id.is_(None)))
    paid = db.scalar(select(func.coalesce(func.sum(Payout.amount), 0)).where(Payout.driver_id == d.id, Payout.status == "success"))
    return {"today": _earned_between(db, d.id, today, now + timedelta(seconds=1)),
            "week": _earned_between(db, d.id, week, now + timedelta(seconds=1)),
            "month": _earned_between(db, d.id, month, now + timedelta(seconds=1)),
            "lifetime_paid_out": str(paid), "pending_settlement": str(pending),
            "cash_commission_due": str(-min(Decimal(pending), Decimal(0))), "daily": daily,
            "policy": "Online earnings are paid to your verified bank account the next day after commission. "
                      "Commission on cash rides is netted against that payout."}


@router.get("/ledger")
def ledger_view(page: int = 1, user: User = Depends(driver), db: Session = Depends(get_db)):
    rows = db.scalars(select(LedgerEntry).where(LedgerEntry.driver_id == user.driver.id)
                      .order_by(LedgerEntry.id.desc()).limit(50).offset((page - 1) * 50))
    return [{"id": e.id, "type": e.entry_type, "amount": str(e.amount), "memo": e.memo, "at": e.occurred_at,
             "settled": e.settlement_id is not None} for e in rows]


@router.get("/settlements")
def settlements(user: User = Depends(driver), db: Session = Depends(get_db)):
    out = []
    for s in db.scalars(select(Settlement).where(Settlement.driver_id == user.driver.id).order_by(Settlement.business_date.desc()).limit(60)):
        p = db.scalar(select(Payout).where(Payout.settlement_id == s.id))
        out.append({"date": s.business_date, "online": str(s.online_earnings), "cash_commission": str(s.cash_commission_due),
                    "other": str(s.other_adjustments), "net": str(s.net), "status": s.status, "note": s.note,
                    "payout": p and {"status": p.status, "utr": p.utr, "failure": p.failure_reason}})
    return out


@router.get("/statement.csv")
def statement(month: str, user: User = Depends(driver), db: Session = Depends(get_db)):
    y, m = map(int, month.split("-"))
    start = datetime(y, m, 1, tzinfo=IST)
    end = datetime(y + (m == 12), m % 12 + 1, 1, tzinfo=IST)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Date", "Ride", "Payment", "Ride fare", "Commission %", "Commission", "Tolls+Parking", "Driver earnings"])
    for r in db.scalars(select(Ride).where(Ride.driver_id == user.driver.id, Ride.status == RideStatus.COMPLETED,
                                           Ride.completed_at >= start, Ride.completed_at < end).order_by(Ride.completed_at)):
        w.writerow([r.completed_at.astimezone(IST).strftime("%Y-%m-%d %H:%M"), r.code, r.payment_method, r.ride_fare,
                    f"{Decimal(r.commission_rate) * 100:.0f}", r.company_commission, Decimal(r.tolls) + Decimal(r.parking), r.driver_earnings])
    buf.seek(0)
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv",
                             headers={"Content-Disposition": f"attachment; filename=vayora-statement-{month}.csv"})


@router.get("/performance")
def performance(user: User = Depends(driver), db: Session = Depends(get_db)):
    d = user.driver
    feedback = db.execute(select(Rating.stars, Rating.tags, Rating.comment, Rating.created_at).where(
        Rating.ratee_user_id == user.id, Rating.verified.is_(True)).order_by(Rating.id.desc()).limit(30)).all()
    city_rank = db.scalar(select(func.count()).select_from(type(d)).where(type(d).city_id == d.city_id, type(d).rank_score > d.rank_score)) + 1
    city_total = db.scalar(select(func.count()).select_from(type(d)).where(type(d).city_id == d.city_id, type(d).onboarding_status == "approved"))
    return {"score": str(d.rank_score), "tier": d.rank_tier, "city_rank": city_rank, "city_total": city_total,
            "snapshot": d.rank_snapshot, "counts": {"offered": d.offered_count, "accepted": d.accepted_count,
                                                    "completed": d.completed_count, "late_cancellations": d.late_cancel_count},
            "feedback": [{"stars": s, "tags": t, "comment": c, "at": at} for s, t, c, at in feedback]}
