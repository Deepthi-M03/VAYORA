"""Super Admin API. Every state-changing route writes an AuditLog row in the same transaction."""
import csv
import io
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import and_, case, func, or_, select
from sqlalchemy.orm import Session

from app.api.serializers import ride as ride_out
from app.core.database import get_db
from app.core.deps import audit, require_perm, snapshot
from app.core.security import ADMIN_ROLES, Perm, hash_password
from app.engines import commission
from app.engines.settlement import EntryType, PayoutStatus, transition
from app.models import (AccountAction, AuditLog, Cancellation, City, CityVehicle, Complaint, ComplaintAction, Coupon,
                        DriverDocument, DriverProfile, FareRuleRow, LedgerEntry, PaymentTxn, Payout, Refund, Ride,
                        ServiceZone, Settlement, User, Vehicle, VehicleCategory)
from app.models.ride import RideStatus
from app.services import config_store, ledger, notify, payments

router = APIRouter(prefix="/admin", tags=["admin"])
IST = timezone(timedelta(hours=5, minutes=30))


def _range(days: int):
    end = datetime.now(timezone.utc)
    return end - timedelta(days=days), end


# =============================================================== A. OVERVIEW
@router.get("/overview")
def overview(days: int = 30, admin: User = Depends(require_perm(Perm.VIEW_DASHBOARD)), db: Session = Depends(get_db)):
    start, end = _range(days)
    in_range = and_(Ride.created_at >= start, Ride.created_at < end)
    counts = dict(db.execute(select(Ride.status, func.count()).where(in_range).group_by(Ride.status)).all())
    money = db.execute(select(func.coalesce(func.sum(Ride.final_total), 0), func.coalesce(func.sum(Ride.company_commission), 0),
                              func.coalesce(func.sum(Ride.driver_earnings), 0), func.coalesce(func.sum(Ride.discount), 0))
                       .where(in_range, Ride.status == RideStatus.COMPLETED)).one()
    by_city = db.execute(select(City.name, func.count(Ride.id), func.coalesce(func.sum(Ride.final_total), 0),
                                func.sum(case((Ride.status == "cancelled", 1), else_=0)))
                         .join(Ride, Ride.city_id == City.id).where(in_range).group_by(City.name)).all()
    by_vehicle = db.execute(select(VehicleCategory.name, func.count(Ride.id), func.coalesce(func.sum(Ride.final_total), 0))
                            .join(Ride, Ride.category_id == VehicleCategory.id).where(in_range).group_by(VehicleCategory.name)).all()
    daily = db.execute(select(func.date(Ride.created_at), func.count(), func.coalesce(func.sum(Ride.company_commission), 0))
                       .where(in_range).group_by(func.date(Ride.created_at)).order_by(func.date(Ride.created_at))).all()
    return {
        "range_days": days,
        "kpis": {
            "total_bookings": sum(counts.values()), "completed": counts.get("completed", 0), "cancelled": counts.get("cancelled", 0),
            "live_rides": db.scalar(select(func.count()).select_from(Ride).where(Ride.status.in_(["assigned", "arrived", "in_progress"]))),
            "active_drivers": db.scalar(select(func.count()).select_from(DriverProfile).where(DriverProfile.is_online.is_(True))),
            "approved_drivers": db.scalar(select(func.count()).select_from(DriverProfile).where(DriverProfile.onboarding_status == "approved")),
            "pending_driver_approvals": db.scalar(select(func.count()).select_from(DriverProfile).where(DriverProfile.onboarding_status == "submitted")),
            "registered_customers": db.scalar(select(func.count()).select_from(User).where(User.role == "customer")),
            "gross_bookings_value": str(money[0]), "company_commission": str(money[1]), "driver_earnings": str(money[2]),
            "promotions_cost": str(money[3]),
            "pending_settlements": str(db.scalar(select(func.coalesce(func.sum(LedgerEntry.amount), 0)).where(LedgerEntry.settlement_id.is_(None)))),
            "payout_failures": db.scalar(select(func.count()).select_from(Payout).where(Payout.status == "failed")),
            "open_complaints": db.scalar(select(func.count()).select_from(Complaint).where(Complaint.status.in_(["open", "investigating", "awaiting_evidence"]))),
            "open_safety": db.scalar(select(func.count()).select_from(Complaint).where(Complaint.priority == "P1", Complaint.status != "resolved")),
        },
        "by_city": [{"city": c, "rides": n, "gbv": str(v), "cancelled": x or 0} for c, n, v, x in by_city],
        "by_vehicle": [{"vehicle": c, "rides": n, "gbv": str(v)} for c, n, v in by_vehicle],
        "daily": [{"date": str(d), "rides": n, "commission": str(c)} for d, n, c in daily],
    }


@router.get("/rides")
def list_rides(status: str | None = None, city_id: int | None = None, q: str | None = None, page: int = 1,
               admin: User = Depends(require_perm(Perm.VIEW_DASHBOARD)), db: Session = Depends(get_db)):
    stmt = select(Ride).order_by(Ride.id.desc()).limit(50).offset((page - 1) * 50)
    if status:
        stmt = stmt.where(Ride.status == status)
    if city_id:
        stmt = stmt.where(Ride.city_id == city_id)
    if q:
        stmt = stmt.where(Ride.code.ilike(f"%{q}%"))
    return [ride_out(db, r, admin) for r in db.scalars(stmt)]


# =============================================================== B/C. CUSTOMERS & DRIVERS
@router.get("/users")
def users(role: str = "customer", q: str | None = None, status: str | None = None, page: int = 1,
          admin: User = Depends(require_perm(Perm.MANAGE_CUSTOMERS)), db: Session = Depends(get_db)):
    stmt = select(User).where(User.role == role).order_by(User.id.desc()).limit(50).offset((page - 1) * 50)
    if q:
        stmt = stmt.where(or_(User.full_name.ilike(f"%{q}%"), User.email.ilike(f"%{q}%"), User.phone.ilike(f"%{q}%")))
    if status:
        stmt = stmt.where(User.status == status)
    out = []
    for u in db.scalars(stmt):
        rides_n = db.scalar(select(func.count()).select_from(Ride).where(Ride.customer_id == u.id)) if role == "customer" else None
        out.append({"id": u.id, "name": u.full_name, "email": u.email, "phone": u.phone, "status": u.status,
                    "fraud_flag": u.fraud_flag, "joined": u.created_at, "last_login": u.last_login_at, "rides": rides_n,
                    "driver": u.driver and {"id": u.driver.id, "onboarding": u.driver.onboarding_status, "tier": u.driver.rank_tier,
                                            "score": str(u.driver.rank_score), "online": u.driver.is_online,
                                            "wallet": str(u.driver.wallet_balance),
                                            "city": u.driver.city_id and db.get(City, u.driver.city_id).name,
                                            "vehicle": (v := u.driver.active_vehicle_id and db.get(Vehicle, u.driver.active_vehicle_id)) and
                                                       {"category": v.category.code, "reg": v.registration_number}}})
    return out


@router.get("/users/{uid}")
def user_detail(uid: int, admin: User = Depends(require_perm(Perm.MANAGE_CUSTOMERS)), db: Session = Depends(get_db)):
    u = db.get(User, uid) or _404()
    rides_q = select(Ride).where(Ride.customer_id == u.id if u.role == "customer" else Ride.driver_id == (u.driver.id if u.driver else -1))
    return {"user": {"id": u.id, "name": u.full_name, "email": u.email, "phone": u.phone, "role": u.role, "status": u.status,
                     "restricted_until": u.restricted_until, "fraud_flag": u.fraud_flag},
            "rides": [ride_out(db, r, admin) for r in db.scalars(rides_q.order_by(Ride.id.desc()).limit(25))],
            "cancellations": db.scalar(select(func.count()).select_from(Cancellation).where(Cancellation.initiator_user_id == u.id)),
            "complaints_against": [{"ticket": c.ticket, "category": c.category, "status": c.status}
                                   for c in db.scalars(select(Complaint).where(Complaint.against_user_id == u.id))],
            "account_actions": [{"action": a.action, "reason": a.reason, "at": a.created_at, "until": a.until}
                                for a in db.scalars(select(AccountAction).where(AccountAction.target_type == "user", AccountAction.target_id == u.id).order_by(AccountAction.id.desc()))]}


def _404():
    raise HTTPException(404, "Not found")


class AccountActionIn(BaseModel):
    action: str = Field(pattern="^(warn|restrict|suspend|deactivate|restore|appeal_upheld|appeal_rejected)$")
    reason: str = Field(min_length=5, max_length=300)
    days: int | None = Field(None, ge=1, le=365)
    complaint_id: int | None = None


STATUS_FOR = {"restrict": "restricted", "suspend": "suspended", "deactivate": "deactivated", "restore": "active",
              "appeal_upheld": "active"}


@router.post("/users/{uid}/action")
def user_action(uid: int, body: AccountActionIn, request: Request,
                admin: User = Depends(require_perm(Perm.MANAGE_CUSTOMERS)), db: Session = Depends(get_db)):
    u = db.get(User, uid) or _404()
    if u.role == "admin":
        raise HTTPException(403, "Use admin management for admin accounts")
    before = snapshot(u, ["status", "restricted_until"])
    until = datetime.now(timezone.utc) + timedelta(days=body.days) if body.days else None
    if body.action in STATUS_FOR:
        u.status = STATUS_FOR[body.action]
        u.restricted_until = until if body.action in ("restrict", "suspend") else None
        if body.action in ("suspend", "deactivate"):
            u.session_version += 1          # kick active sessions
            if u.driver:
                u.driver.is_online = False
    db.add(AccountAction(target_type="user", target_id=u.id, action=body.action, reason=body.reason,
                         complaint_id=body.complaint_id, until=until, actor_id=admin.id))
    audit(db, request, admin, f"user.{body.action}", "user", u.id, before, snapshot(u, ["status", "restricted_until"]), body.reason)
    notify.send(db, u, "Account update", {"warn": "You have received a warning from VAYORA.",
                                          "restore": "Your account has been restored."}.get(body.action,
                f"Your account is now {u.status}. Reason: {body.reason}. You can appeal from Support."), "account")
    db.commit()
    return {"ok": True, "status": u.status}


@router.get("/drivers/pending")
def pending_drivers(admin: User = Depends(require_perm(Perm.VERIFY_DOCUMENTS)), db: Session = Depends(get_db)):
    out = []
    for d in db.scalars(select(DriverProfile).where(DriverProfile.onboarding_status == "submitted")):
        out.append({"driver_id": d.id, "name": d.user.full_name, "city_id": d.city_id, "licence": d.licence_number,
                    "submitted_at": d.updated_at, "bank_verified": d.bank_verified,
                    "documents": [{"id": x.id, "type": x.doc_type, "status": x.status, "file": f"/admin/documents/{x.id}/file"} for x in d.documents],
                    "vehicles": [{"id": v.id, "reg": v.registration_number, "category": v.category.code, "status": v.status,
                                  "insurance_expiry": v.insurance_expiry} for v in d.vehicles]})
    return out


class DocReview(BaseModel):
    status: str = Field(pattern="^(verified|rejected)$")
    note: str | None = Field(None, max_length=300)


@router.post("/documents/{doc_id}/review")
def review_doc(doc_id: int, body: DocReview, request: Request,
               admin: User = Depends(require_perm(Perm.VERIFY_DOCUMENTS)), db: Session = Depends(get_db)):
    doc = db.get(DriverDocument, doc_id) or _404()
    before = snapshot(doc, ["status"])
    doc.status, doc.review_note, doc.reviewer_id = body.status, body.note, admin.id
    audit(db, request, admin, f"document.{body.status}", "driver_document", doc.id, before, {"status": doc.status}, body.note)
    db.commit()
    return {"ok": True}


class DriverDecision(BaseModel):
    approve: bool
    reason: str | None = Field(None, max_length=300)


@router.post("/drivers/{driver_id}/decision")
def driver_decision(driver_id: int, body: DriverDecision, request: Request,
                    admin: User = Depends(require_perm(Perm.MANAGE_DRIVERS)), db: Session = Depends(get_db)):
    d = db.get(DriverProfile, driver_id) or _404()
    if body.approve:
        unverified = [x.doc_type for x in d.documents if x.status != "verified"]
        if unverified:
            raise HTTPException(422, f"Verify all documents first: {', '.join(unverified)}")
    before = snapshot(d, ["onboarding_status"])
    d.onboarding_status = "approved" if body.approve else "rejected"
    d.rejection_reason = None if body.approve else body.reason
    if body.approve:
        for v in d.vehicles:
            if v.status == "pending":
                v.status = "approved"
    audit(db, request, admin, "driver.approve" if body.approve else "driver.reject", "driver", d.id, before,
          {"onboarding_status": d.onboarding_status}, body.reason)
    notify.send(db, d.user, "Welcome to VAYORA!" if body.approve else "Application update",
                "You can now go online and start earning." if body.approve else f"Your application needs changes: {body.reason}", "onboarding")
    db.commit()
    return {"ok": True}


# =============================================================== D. VEHICLES & CATEGORIES
@router.get("/vehicles")
def vehicles(status: str | None = None, admin: User = Depends(require_perm(Perm.MANAGE_VEHICLES)), db: Session = Depends(get_db)):
    stmt = select(Vehicle).order_by(Vehicle.id.desc()).limit(200)
    if status:
        stmt = stmt.where(Vehicle.status == status)
    return [{"id": v.id, "reg": v.registration_number, "category": v.category.code, "make": v.make, "model": v.model,
             "driver": v.driver.user.full_name, "status": v.status, "insurance_expiry": v.insurance_expiry,
             "insurance_expired": bool(v.insurance_expiry and v.insurance_expiry < date.today())} for v in db.scalars(stmt)]


class VehicleStatusIn(BaseModel):
    status: str = Field(pattern="^(approved|suspended|rejected)$")
    reason: str = Field(min_length=3, max_length=300)


@router.post("/vehicles/{vid}/status")
def vehicle_status(vid: int, body: VehicleStatusIn, request: Request,
                   admin: User = Depends(require_perm(Perm.MANAGE_VEHICLES)), db: Session = Depends(get_db)):
    v = db.get(Vehicle, vid) or _404()
    before = snapshot(v, ["status"])
    v.status = body.status
    if body.status != "approved" and v.driver.active_vehicle_id == v.id:
        v.driver.is_online = False
    db.add(AccountAction(target_type="vehicle", target_id=v.id, action=body.status, reason=body.reason, actor_id=admin.id))
    audit(db, request, admin, f"vehicle.{body.status}", "vehicle", v.id, before, {"status": v.status}, body.reason)
    db.commit()
    return {"ok": True}


@router.get("/categories")
def categories(admin: User = Depends(require_perm(Perm.MANAGE_VEHICLES)), db: Session = Depends(get_db)):
    return [{"id": c.id, "code": c.code, "name": c.name, "seats": c.seats, "globally_active": c.globally_active,
             "is_interstate": c.is_interstate} for c in db.scalars(select(VehicleCategory).order_by(VehicleCategory.sort_order))]


class ToggleIn(BaseModel):
    active: bool
    reason: str = Field(min_length=3, max_length=300)


@router.post("/categories/{cid}/toggle")
def toggle_category(cid: int, body: ToggleIn, request: Request,
                    admin: User = Depends(require_perm(Perm.MANAGE_VEHICLES)), db: Session = Depends(get_db)):
    """Discontinue (or resume) a vehicle type platform-wide. Online drivers of that type are taken offline."""
    c = db.get(VehicleCategory, cid) or _404()
    before = {"globally_active": c.globally_active}
    c.globally_active = body.active
    if not body.active:
        for d in db.scalars(select(DriverProfile).join(Vehicle, Vehicle.id == DriverProfile.active_vehicle_id)
                            .where(Vehicle.category_id == c.id, DriverProfile.is_online.is_(True))):
            d.is_online = False
    audit(db, request, admin, "category.toggle", "vehicle_category", c.id, before, {"globally_active": c.globally_active}, body.reason)
    db.commit()
    return {"ok": True}


# =============================================================== E. CITIES
class CityIn(BaseModel):
    name: str = Field(max_length=80)
    state: str = Field(max_length=80)
    tier: str = Field(pattern="^(metro|tier_2|other)$")
    center_lat: float
    center_lng: float
    boundary: list[list[float]] | None = None
    operating_hours: dict = Field(default_factory=lambda: {"open": "00:00", "close": "23:59"})
    restrictions: dict = Field(default_factory=dict)


@router.get("/cities")
def cities(admin: User = Depends(require_perm(Perm.MANAGE_CITIES)), db: Session = Depends(get_db)):
    cats = db.scalars(select(VehicleCategory).order_by(VehicleCategory.sort_order)).all()
    out = []
    for c in db.scalars(select(City).order_by(City.name)):
        switches = {cv.category_id: cv.active for cv in c.vehicles}
        out.append({"id": c.id, "name": c.name, "state": c.state, "tier": c.tier, "status": c.status,
                    "center": [c.center_lat, c.center_lng], "operating_hours": c.operating_hours, "restrictions": c.restrictions,
                    "zones": [{"id": z.id, "name": z.name, "kind": z.kind, "active": z.active} for z in c.zones],
                    "vehicles": [{"category_id": k.id, "code": k.code, "name": k.name, "active": switches.get(k.id, False),
                                  "globally_active": k.globally_active, "priced": bool(config_store.current_rule(db, c.id, k.id))} for k in cats],
                    "rides_30d": db.scalar(select(func.count()).select_from(Ride).where(Ride.city_id == c.id, Ride.created_at >= datetime.now(timezone.utc) - timedelta(days=30)))})
    return out


@router.post("/cities")
def create_city(body: CityIn, request: Request, admin: User = Depends(require_perm(Perm.MANAGE_CITIES)), db: Session = Depends(get_db)):
    if db.scalar(select(City).where(func.lower(City.name) == body.name.lower())):
        raise HTTPException(409, "City already exists")
    c = City(**body.model_dump(), status="draft")    # never active on creation
    db.add(c)
    db.flush()
    for cat in db.scalars(select(VehicleCategory)):
        db.add(CityVehicle(city_id=c.id, category_id=cat.id, active=False))
    audit(db, request, admin, "city.create", "city", c.id, None, body.model_dump())
    db.commit()
    return {"id": c.id, "status": c.status}


@router.patch("/cities/{cid}")
def edit_city(cid: int, body: CityIn, request: Request, admin: User = Depends(require_perm(Perm.MANAGE_CITIES)), db: Session = Depends(get_db)):
    c = db.get(City, cid) or _404()
    fields = list(body.model_dump().keys())
    before = snapshot(c, fields)
    for k, v in body.model_dump().items():
        setattr(c, k, v)
    audit(db, request, admin, "city.edit", "city", c.id, before, snapshot(c, fields))
    db.commit()
    return {"ok": True}


class CityStatusIn(BaseModel):
    status: str = Field(pattern="^(active|paused|pending_approval)$")
    reason: str = Field(min_length=3, max_length=300)


@router.post("/cities/{cid}/status")
def city_status(cid: int, body: CityStatusIn, request: Request,
                admin: User = Depends(require_perm(Perm.MANAGE_CITIES)), db: Session = Depends(get_db)):
    """Ops admins can pause or request approval; only the Super Admin (cities:activate) can make a city live."""
    c = db.get(City, cid) or _404()
    if body.status == "active":
        if Perm.ACTIVATE_CITIES not in ADMIN_ROLES.get(admin.admin_role or "", set()):
            raise HTTPException(403, "Only the Super Admin can activate a city")
        if not any(config_store.current_rule(db, c.id, cv.category_id) and cv.active for cv in c.vehicles):
            raise HTTPException(422, "Enable and price at least one vehicle type before activating")
        c.activated_by = admin.id
    before = {"status": c.status}
    c.status = body.status
    audit(db, request, admin, f"city.{body.status}", "city", c.id, before, {"status": c.status}, body.reason)
    db.commit()
    return {"ok": True}


class CityVehicleIn(BaseModel):
    active: bool


@router.post("/cities/{cid}/vehicles/{cat_id}")
def city_vehicle(cid: int, cat_id: int, body: CityVehicleIn, request: Request,
                 admin: User = Depends(require_perm(Perm.MANAGE_CITIES)), db: Session = Depends(get_db)):
    cv = db.scalar(select(CityVehicle).where(CityVehicle.city_id == cid, CityVehicle.category_id == cat_id))
    if not cv:
        cv = CityVehicle(city_id=cid, category_id=cat_id, active=False)
        db.add(cv)
    before = {"active": cv.active}
    cv.active = body.active
    audit(db, request, admin, "city.vehicle_toggle", "city_vehicle", f"{cid}:{cat_id}", before, {"active": cv.active})
    db.commit()
    return {"ok": True}


class ZoneIn(BaseModel):
    name: str
    polygon: list[list[float]] = Field(min_length=3)
    kind: str = Field("service", pattern="^(service|airport|no_pickup)$")


@router.post("/cities/{cid}/zones")
def add_zone(cid: int, body: ZoneIn, request: Request, admin: User = Depends(require_perm(Perm.MANAGE_CITIES)), db: Session = Depends(get_db)):
    z = ServiceZone(city_id=cid, **body.model_dump())
    db.add(z)
    db.flush()
    audit(db, request, admin, "zone.create", "zone", z.id, None, body.model_dump())
    db.commit()
    return {"id": z.id}


# =============================================================== PRICING
class FareIn(BaseModel):
    base_fare: Decimal = Field(ge=0)
    per_km: Decimal = Field(ge=0)
    per_min: Decimal = Field(ge=0)
    per_wait_min: Decimal = Field(Decimal(0), ge=0)
    free_waiting_min: int = Field(3, ge=0, le=30)
    minimum_fare: Decimal = Field(ge=0)
    max_peak_multiplier: Decimal = Field(Decimal(2), ge=1, le=3)
    tax_rate: Decimal = Field(Decimal(0), ge=0, le=Decimal("0.28"))
    peak_windows: list[dict] = Field(default_factory=list)


@router.get("/cities/{cid}/fares")
def fares(cid: int, admin: User = Depends(require_perm(Perm.MANAGE_PRICING)), db: Session = Depends(get_db)):
    out = []
    for cat in db.scalars(select(VehicleCategory).order_by(VehicleCategory.sort_order)):
        r = config_store.current_rule(db, cid, cat.id)
        out.append({"category_id": cat.id, "code": cat.code, "name": cat.name,
                    "rule": r and {k: str(getattr(r, k)) for k in FareIn.model_fields if k != "peak_windows"} | {"peak_windows": r.peak_windows, "version": r.version}})
    return out


@router.put("/cities/{cid}/fares/{cat_id}")
def set_fare(cid: int, cat_id: int, body: FareIn, request: Request,
             admin: User = Depends(require_perm(Perm.MANAGE_PRICING)), db: Session = Depends(get_db)):
    """Creates a new version; old rides keep pointing at the version they were quoted with."""
    for w in body.peak_windows:
        if not {"start", "end", "multiplier"} <= set(w) or Decimal(str(w["multiplier"])) > body.max_peak_multiplier:
            raise HTTPException(422, "Each peak window needs start, end, multiplier ≤ max_peak_multiplier")
    old = config_store.current_rule(db, cid, cat_id)
    if old:
        old.is_current = False
    row = FareRuleRow(city_id=cid, category_id=cat_id, version=(old.version + 1) if old else 1, is_current=True,
                      created_by=admin.id, **body.model_dump())
    db.add(row)
    audit(db, request, admin, "fare.update", "fare_rule", f"{cid}:{cat_id}",
          old and {k: str(getattr(old, k)) for k in ("base_fare", "per_km", "per_min", "minimum_fare", "version")},
          {k: str(v) for k, v in body.model_dump().items()})
    db.commit()
    return {"version": row.version}


# =============================================================== F. FINANCE
class SlabsIn(BaseModel):
    slabs: list[dict]
    commission_tax_rate: Decimal = Field(Decimal(0), ge=0, le=Decimal("0.28"))
    reason: str = Field(min_length=3)


@router.get("/finance/commission")
def get_commission(admin: User = Depends(require_perm(Perm.VIEW_FINANCE)), db: Session = Depends(get_db)):
    slabs = config_store.slabs(db)
    examples = {x: commission.split(Decimal(x), slabs=slabs).to_dict() for x in ("200", "500", "1000")}
    return {"slabs": config_store.get(db, "commission_slabs"), "commission_tax_rate": config_store.get(db, "commission_tax_rate"),
            "examples": examples}


@router.put("/finance/commission")
def set_commission(body: SlabsIn, request: Request, admin: User = Depends(require_perm(Perm.MANAGE_FINANCE)), db: Session = Depends(get_db)):
    try:
        parsed = commission.slabs_from_config(body.slabs)
    except (ValueError, KeyError) as exc:
        raise HTTPException(422, str(exc))
    before = {"slabs": config_store.get(db, "commission_slabs")}
    config_store.put(db, "commission_slabs", commission.slabs_to_config(parsed), admin.id)
    config_store.put(db, "commission_tax_rate", str(body.commission_tax_rate), admin.id)
    audit(db, request, admin, "commission.update", "setting", "commission_slabs", before, {"slabs": body.slabs}, body.reason)
    db.commit()
    return {"ok": True}


@router.get("/finance/transactions")
def transactions(page: int = 1, admin: User = Depends(require_perm(Perm.VIEW_FINANCE)), db: Session = Depends(get_db)):
    return [{"id": t.id, "ride_id": t.ride_id, "amount": str(t.amount), "method": t.method, "status": t.status,
             "provider_payment_id": t.provider_payment_id, "at": t.created_at}
            for t in db.scalars(select(PaymentTxn).order_by(PaymentTxn.id.desc()).limit(100).offset((page - 1) * 100))]


@router.get("/finance/settlements")
def all_settlements(day: date | None = None, status: str | None = None,
                    admin: User = Depends(require_perm(Perm.VIEW_FINANCE)), db: Session = Depends(get_db)):
    stmt = select(Settlement).order_by(Settlement.id.desc()).limit(300)
    if day:
        stmt = stmt.where(Settlement.business_date == day)
    if status:
        stmt = stmt.where(Settlement.status == status)
    out = []
    for s in db.scalars(stmt):
        p = db.scalar(select(Payout).where(Payout.settlement_id == s.id))
        d = db.get(DriverProfile, s.driver_id)
        out.append({"id": s.id, "driver": d.user.full_name, "driver_id": d.id, "date": s.business_date, "online": str(s.online_earnings),
                    "cash_commission": str(s.cash_commission_due), "other": str(s.other_adjustments), "net": str(s.net),
                    "status": s.status, "note": s.note,
                    "payout": p and {"id": p.id, "status": p.status, "attempts": p.attempts, "utr": p.utr, "failure": p.failure_reason}})
    return out


@router.post("/finance/payouts/{pid}/retry")
def retry_payout(pid: int, request: Request, admin: User = Depends(require_perm(Perm.MANAGE_FINANCE)), db: Session = Depends(get_db)):
    p = db.get(Payout, pid) or _404()
    try:
        transition(p.status, PayoutStatus.PROCESSING, attempts=p.attempts)
    except ValueError as exc:
        raise HTTPException(409, str(exc))
    from app.workers.tasks import execute_payout
    audit(db, request, admin, "payout.retry", "payout", p.id, {"status": p.status, "attempts": p.attempts}, None)
    db.commit()
    execute_payout.delay(p.id)
    return {"ok": True}


@router.get("/finance/reconciliation")
def reconciliation(day: date, admin: User = Depends(require_perm(Perm.VIEW_FINANCE)), db: Session = Depends(get_db)):
    """Per-day check that rides, payments, ledger and payouts agree. Mismatches are listed for follow-up."""
    start = datetime(day.year, day.month, day.day, tzinfo=IST)
    end = start + timedelta(days=1)
    done = db.scalars(select(Ride).where(Ride.status == "completed", Ride.completed_at >= start, Ride.completed_at < end)).all()
    issues = []
    for r in done:
        has_ledger = db.scalar(select(func.count()).select_from(LedgerEntry).where(LedgerEntry.ride_id == r.id, LedgerEntry.entry_type.in_(
            [EntryType.RIDE_EARNING_ONLINE, EntryType.RIDE_COMMISSION_CASH])))
        if r.payment_method == "online":
            cap = db.scalar(select(PaymentTxn).where(PaymentTxn.ride_id == r.id, PaymentTxn.status == "captured"))
            if not cap:
                issues.append({"ride": r.code, "issue": "online ride without captured payment"})
            elif not has_ledger:
                issues.append({"ride": r.code, "issue": "captured payment not posted to driver ledger"})
        elif not has_ledger:
            issues.append({"ride": r.code, "issue": "cash ride commission not posted"})
    cash = [r for r in done if r.payment_method == "cash"]
    online = [r for r in done if r.payment_method == "online"]
    return {"date": day, "completed_rides": len(done),
            "cash": {"rides": len(cash), "collected_by_drivers": str(sum((Decimal(r.final_total) - Decimal(r.discount) for r in cash), Decimal(0))),
                     "commission_receivable": str(sum((Decimal(r.company_commission) for r in cash), Decimal(0)))},
            "online": {"rides": len(online), "collected": str(sum((Decimal(r.final_total) - Decimal(r.discount) for r in online), Decimal(0))),
                       "driver_payable": str(sum((Decimal(r.driver_earnings) for r in online), Decimal(0)))},
            "issues": issues}


class AdjustIn(BaseModel):
    driver_id: int
    amount: Decimal = Field(ge=-50000, le=50000)
    reason: str = Field(min_length=5, max_length=200)


@router.post("/finance/adjustments")
def adjustment(body: AdjustIn, request: Request, admin: User = Depends(require_perm(Perm.MANAGE_FINANCE)), db: Session = Depends(get_db)):
    ref = f"adj-{admin.id}-{int(datetime.now().timestamp())}"
    e = ledger.post(db, body.driver_id, EntryType.ADJUSTMENT, body.amount, reference=ref, memo=body.reason, created_by=admin.id)
    audit(db, request, admin, "ledger.adjust", "driver", body.driver_id, None, {"amount": str(body.amount), "ref": ref}, body.reason)
    db.commit()
    return {"ok": True, "entry_id": e.id if e else None}


class RefundIn(BaseModel):
    amount: Decimal = Field(gt=0)
    reason: str = Field(min_length=5, max_length=200)


@router.post("/rides/{ride_id}/refund")
def refund(ride_id: int, body: RefundIn, request: Request, admin: User = Depends(require_perm(Perm.MANAGE_FINANCE)), db: Session = Depends(get_db)):
    r = db.get(Ride, ride_id) or _404()
    if r.status != "completed":
        raise HTTPException(409, "Only completed rides can be refunded")
    already = db.scalar(select(func.coalesce(func.sum(Refund.amount), 0)).where(Refund.ride_id == r.id, Refund.status != "failed"))
    if Decimal(already) + body.amount > Decimal(r.ride_fare):
        raise HTTPException(422, f"Refund exceeds remaining refundable ride fare (₹{Decimal(r.ride_fare) - Decimal(already)})")
    orig = commission.CommissionResult(**{k: Decimal(v) for k, v in r.commission_snapshot.items()
                                          if k in commission.CommissionResult.__dataclass_fields__})
    rev = commission.reverse_for_refund(orig, body.amount)
    pay = db.scalar(select(PaymentTxn).where(PaymentTxn.ride_id == r.id, PaymentTxn.status == "captured"))
    rf = Refund(ride_id=r.id, payment_id=pay.id if pay else None, amount=body.amount, reason=body.reason,
                commission_reversal=rev["commission_reversal"], driver_reversal=rev["driver_reversal"], requested_by=admin.id)
    db.add(rf)
    db.flush()
    if pay:
        res = payments.refund(pay.provider_payment_id, body.amount, body.reason)
        rf.provider_refund_id = res.get("id")
    else:
        rf.status = "processed"   # cash ride: refunded as wallet credit / UPI manually; recorded here
    ledger.post(db, r.driver_id, EntryType.REFUND_REVERSAL, rev["driver_reversal"], ride_id=r.id, reference=f"rf{rf.id}",
                memo=f"Refund ₹{body.amount} on {r.code}: driver share reversed", created_by=admin.id)
    r.payment_status = "refunded" if Decimal(already) + body.amount >= Decimal(r.ride_fare) else "partially_refunded"
    audit(db, request, admin, "ride.refund", "ride", r.id, None, {"amount": str(body.amount), **{k: str(v) for k, v in rev.items()}}, body.reason)
    db.commit()
    return {"ok": True, "reversal": {k: str(v) for k, v in rev.items()}}


# =============================================================== G. COMPLAINTS
@router.get("/complaints")
def complaints(status: str | None = None, priority: str | None = None, category: str | None = None,
               admin: User = Depends(require_perm(Perm.MANAGE_COMPLAINTS)), db: Session = Depends(get_db)):
    stmt = select(Complaint).order_by(Complaint.priority, Complaint.sla_due_at).limit(200)
    for col, val in ((Complaint.status, status), (Complaint.priority, priority), (Complaint.category, category)):
        if val:
            stmt = stmt.where(col == val)
    now = datetime.now(timezone.utc)
    return [{"id": c.id, "ticket": c.ticket, "category": c.category, "priority": c.priority, "status": c.status,
             "description": c.description, "ride_id": c.ride_id, "raised_by": db.get(User, c.raised_by).full_name,
             "against": c.against_user_id and db.get(User, c.against_user_id).full_name, "against_user_id": c.against_user_id,
             "against_vehicle_id": c.against_vehicle_id, "sla_due_at": c.sla_due_at, "overdue": c.sla_due_at < now and c.status != "resolved",
             "created_at": c.created_at, "assigned_to": c.assigned_to,
             "actions": [{"kind": a.kind, "body": a.body, "internal": a.internal, "at": a.created_at} for a in c.actions]}
            for c in db.scalars(stmt)]


class ComplaintUpdate(BaseModel):
    kind: str = Field(pattern="^(note|request_evidence|assign|resolve|reject|appeal)$")
    body: str = Field(min_length=2, max_length=2000)
    internal: bool = True
    upheld: bool | None = None
    severity: str | None = Field(None, pattern="^(minor|major|critical)$")


@router.post("/complaints/{cid}/update")
def complaint_update(cid: int, body: ComplaintUpdate, request: Request,
                     admin: User = Depends(require_perm(Perm.MANAGE_COMPLAINTS)), db: Session = Depends(get_db)):
    c = db.get(Complaint, cid) or _404()
    before = snapshot(c, ["status", "upheld", "severity", "assigned_to"])
    if body.kind == "assign":
        c.assigned_to, c.status = admin.id, "investigating"
    elif body.kind == "request_evidence":
        c.status = "awaiting_evidence"
        body.internal = False
    elif body.kind in ("resolve", "reject"):
        if c.category in ("unsafe_driving", "harassment_safety") and body.upheld and not body.severity:
            raise HTTPException(422, "Set a severity for upheld safety complaints")
        c.status = "resolved" if body.kind == "resolve" else "rejected"
        c.resolution, c.upheld, c.severity = body.body, body.upheld, body.severity
        body.internal = False
    elif body.kind == "appeal":
        c.status = "appealed"
    db.add(ComplaintAction(complaint_id=c.id, actor_id=admin.id, kind=body.kind, body=body.body, internal=body.internal))
    audit(db, request, admin, f"complaint.{body.kind}", "complaint", c.id, before, snapshot(c, ["status", "upheld", "severity", "assigned_to"]))
    if not body.internal:
        notify.send(db, db.get(User, c.raised_by), f"Update on ticket {c.ticket}", body.body[:300], "support")
    db.commit()
    if c.upheld and c.against_user_id:
        u = db.get(User, c.against_user_id)
        if u.driver:
            from app.workers.tasks import recompute_rank
            recompute_rank.delay(u.driver.id)
    return {"ok": True, "status": c.status}


# =============================================================== H. CONFIGURATION
@router.get("/config")
def get_config(admin: User = Depends(require_perm(Perm.MANAGE_CONFIG)), db: Session = Depends(get_db)):
    return {k: config_store.get(db, k) for k in config_store.DEFAULTS}


class ConfigIn(BaseModel):
    value: dict | list | str
    reason: str = Field(min_length=3)


@router.put("/config/{key}")
def put_config(key: str, body: ConfigIn, request: Request, admin: User = Depends(require_perm(Perm.MANAGE_CONFIG)), db: Session = Depends(get_db)):
    if key not in config_store.DEFAULTS or key.startswith("commission"):
        raise HTTPException(422, "Unknown key (commission is edited under Finance)")
    if key == "cancellation_policy":
        merged = {**config_store.DEFAULTS[key], **body.value}
        if int(merged["free_window_min"]) < 15:
            raise HTTPException(422, "The free cancellation window cannot be shorter than 15 minutes (platform promise)")
        body.value = merged
    before = config_store.get(db, key)
    config_store.put(db, key, body.value, admin.id)
    audit(db, request, admin, "config.update", "setting", key, {"value": before}, {"value": body.value}, body.reason)
    db.commit()
    return {"ok": True}


class CouponIn(BaseModel):
    code: str = Field(pattern=r"^[A-Z0-9]{4,20}$")
    description: str
    kind: str = Field(pattern="^(flat|percent)$")
    value: Decimal = Field(gt=0)
    max_discount: Decimal = Field(gt=0)
    min_fare: Decimal = Field(Decimal(0), ge=0)
    city_id: int | None = None
    category_code: str | None = None
    per_user_limit: int = 1
    total_limit: int | None = None
    valid_from: datetime
    valid_to: datetime


@router.get("/coupons")
def list_coupons(admin: User = Depends(require_perm(Perm.MANAGE_CONFIG)), db: Session = Depends(get_db)):
    return [{"id": c.id, "code": c.code, "description": c.description, "kind": c.kind, "value": str(c.value), "active": c.active,
             "valid_to": c.valid_to} for c in db.scalars(select(Coupon).order_by(Coupon.id.desc()))]


@router.post("/coupons")
def create_coupon(body: CouponIn, request: Request, admin: User = Depends(require_perm(Perm.MANAGE_CONFIG)), db: Session = Depends(get_db)):
    if body.kind == "percent" and body.value > 100:
        raise HTTPException(422, "Percent cannot exceed 100")
    c = Coupon(**body.model_dump())
    db.add(c)
    db.flush()
    audit(db, request, admin, "coupon.create", "coupon", c.id, None, {k: str(v) for k, v in body.model_dump().items()})
    db.commit()
    return {"id": c.id}


class AdminIn(BaseModel):
    full_name: str
    email: str
    phone: str
    password: str = Field(min_length=12)
    admin_role: str


@router.get("/admins")
def admins(admin: User = Depends(require_perm(Perm.MANAGE_ADMINS)), db: Session = Depends(get_db)):
    return {"roles": {k: sorted(v) for k, v in ADMIN_ROLES.items()},
            "admins": [{"id": u.id, "name": u.full_name, "email": u.email, "admin_role": u.admin_role, "status": u.status}
                       for u in db.scalars(select(User).where(User.role == "admin"))]}


@router.post("/admins")
def create_admin(body: AdminIn, request: Request, admin: User = Depends(require_perm(Perm.MANAGE_ADMINS)), db: Session = Depends(get_db)):
    if body.admin_role not in ADMIN_ROLES:
        raise HTTPException(422, "Unknown admin role")
    u = User(role="admin", admin_role=body.admin_role, full_name=body.full_name, email=body.email.lower(), phone=body.phone,
             password_hash=hash_password(body.password))
    db.add(u)
    db.flush()
    audit(db, request, admin, "admin.create", "user", u.id, None, {"email": u.email, "admin_role": u.admin_role})
    db.commit()
    return {"id": u.id}


@router.get("/audit")
def audit_log(entity: str | None = None, actor_id: int | None = None, page: int = 1,
              admin: User = Depends(require_perm(Perm.VIEW_AUDIT)), db: Session = Depends(get_db)):
    stmt = select(AuditLog).order_by(AuditLog.id.desc()).limit(100).offset((page - 1) * 100)
    if entity:
        stmt = stmt.where(AuditLog.entity == entity)
    if actor_id:
        stmt = stmt.where(AuditLog.actor_id == actor_id)
    return [{"id": a.id, "at": a.at, "actor_id": a.actor_id, "actor_role": a.actor_role, "action": a.action, "entity": a.entity,
             "entity_id": a.entity_id, "before": a.before, "after": a.after, "reason": a.reason, "ip": a.ip} for a in db.scalars(stmt)]


# =============================================================== I. REPORTS (CSV)
REPORTS = {
    "rides": (["Code", "City", "Vehicle", "Status", "Payment", "Ride fare", "Commission", "Driver", "Created"],
              lambda db, s, e: [[r.code, r.city.name, r.category.code, r.status, r.payment_method, r.ride_fare, r.company_commission,
                                 r.driver_earnings, r.created_at] for r in db.scalars(select(Ride).where(Ride.created_at >= s, Ride.created_at < e))]),
    "cancellations": (["Ride", "Initiator", "Minutes", "Free window", "Fee", "Policy", "Reason", "Abuse"],
                      lambda db, s, e: [[c.ride_id, c.initiator, c.decision.get("minutes_since_booking"), c.within_free_window, c.fee,
                                         c.policy_applied, c.reason, c.abuse_flag] for c in db.scalars(select(Cancellation).where(Cancellation.cancelled_at >= s, Cancellation.cancelled_at < e))]),
    "complaints": (["Ticket", "Category", "Priority", "Status", "Upheld", "Severity", "Created"],
                   lambda db, s, e: [[c.ticket, c.category, c.priority, c.status, c.upheld, c.severity, c.created_at]
                                     for c in db.scalars(select(Complaint).where(Complaint.created_at >= s, Complaint.created_at < e))]),
    "settlements": (["Date", "Driver", "Online", "Cash commission", "Other", "Net", "Status"],
                    lambda db, s, e: [[x.business_date, x.driver_id, x.online_earnings, x.cash_commission_due, x.other_adjustments, x.net, x.status]
                                      for x in db.scalars(select(Settlement).where(Settlement.business_date >= s.date(), Settlement.business_date < e.date()))]),
    "drivers": (["Driver", "City", "Tier", "Score", "Offered", "Accepted", "Completed", "Late cancels"],
                lambda db, s, e: [[d.user.full_name, d.city_id, d.rank_tier, d.rank_score, d.offered_count, d.accepted_count, d.completed_count,
                                   d.late_cancel_count] for d in db.scalars(select(DriverProfile).where(DriverProfile.onboarding_status == "approved"))]),
}


@router.get("/reports/{kind}.csv")
def report(kind: str, start: date, end: date, admin: User = Depends(require_perm(Perm.VIEW_DASHBOARD)), db: Session = Depends(get_db)):
    if kind not in REPORTS:
        raise HTTPException(404, "Unknown report")
    head, rows = REPORTS[kind]
    s = datetime(start.year, start.month, start.day, tzinfo=IST)
    e = datetime(end.year, end.month, end.day, tzinfo=IST) + timedelta(days=1)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(head)
    w.writerows(rows(db, s, e))
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv",
                             headers={"Content-Disposition": f"attachment; filename=vayora-{kind}-{start}-{end}.csv"})


@router.get("/documents/{doc_id}/file")
def document_file(doc_id: int, request: Request, admin: User = Depends(require_perm(Perm.VERIFY_DOCUMENTS)), db: Session = Depends(get_db)):
    """KYC files are only served to authorised admins, and every view is audited."""
    import os
    from fastapi.responses import FileResponse
    from app.core.config import get_settings
    doc = db.get(DriverDocument, doc_id) or _404()
    root = os.path.realpath(get_settings().UPLOAD_DIR)
    path = os.path.realpath(os.path.join(root, doc.file_key))
    if not path.startswith(root + os.sep) or not os.path.exists(path):
        raise HTTPException(404, "File missing")
    audit(db, request, admin, "document.view", "driver_document", doc.id)
    db.commit()
    return FileResponse(path)
