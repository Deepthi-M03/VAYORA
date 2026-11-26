import hashlib
import secrets
from datetime import datetime, timedelta, timezone

import jwt
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.api.serializers import me
from app.core.config import get_settings
from app.core.database import get_db
from app.core.deps import current_user
from app.core.security import create_token, decode_token, hash_password, reset_token, verify_password
from app.models import EmergencyContact, PasswordReset, Referral, SavedAddress, User

router = APIRouter(prefix="/auth", tags=["auth"])
PHONE = r"^\+91[6-9]\d{9}$"


class Register(BaseModel):
    full_name: str = Field(min_length=2, max_length=120)
    email: EmailStr
    phone: str = Field(pattern=PHONE)
    password: str = Field(min_length=8, max_length=128)
    role: str = Field("customer", pattern="^(customer|driver)$")
    referral_code: str | None = None


class Login(BaseModel):
    identifier: str          # email or phone
    password: str


def _tokens(u: User) -> dict:
    return {"access_token": create_token(u.id, u.role, "access", u.session_version),
            "refresh_token": create_token(u.id, u.role, "refresh", u.session_version), "user": me(u)}


@router.post("/register")
def register(body: Register, db: Session = Depends(get_db)):
    if db.scalar(select(User).where(or_(User.email == body.email.lower(), User.phone == body.phone))):
        raise HTTPException(409, "An account with this email or phone already exists")
    u = User(full_name=body.full_name, email=body.email.lower(), phone=body.phone, role=body.role,
             password_hash=hash_password(body.password), referral_code=secrets.token_hex(3).upper())
    db.add(u)
    db.flush()
    if body.role == "driver":
        from app.models import DriverProfile
        db.add(DriverProfile(user_id=u.id))
    if body.referral_code:
        ref = db.scalar(select(User).where(User.referral_code == body.referral_code.upper()))
        if ref and ref.id != u.id:
            db.add(Referral(referrer_id=ref.id, referee_id=u.id))
    db.commit()
    return _tokens(u)


_attempts: dict[str, list[datetime]] = {}


@router.post("/login")
def login(body: Login, request: Request, db: Session = Depends(get_db)):
    key = f"{request.client.host if request.client else '-'}:{body.identifier.lower()}"
    window = [t for t in _attempts.get(key, []) if t > datetime.now(timezone.utc) - timedelta(minutes=15)]
    if len(window) >= 8:
        raise HTTPException(429, "Too many attempts. Try again in 15 minutes.")
    u = db.scalar(select(User).where(or_(User.email == body.identifier.lower(), User.phone == body.identifier)))
    if not u or not verify_password(body.password, u.password_hash or ""):
        _attempts[key] = [*window, datetime.now(timezone.utc)]
        raise HTTPException(401, "Incorrect email/phone or password")
    if u.status in ("suspended", "deactivated"):
        raise HTTPException(403, f"Account {u.status}. Contact support to appeal.")
    _attempts.pop(key, None)
    u.last_login_at = datetime.now(timezone.utc)
    db.commit()
    return _tokens(u)


class GoogleLogin(BaseModel):
    id_token: str
    phone: str | None = Field(None, pattern=PHONE)


@router.post("/google")
def google(body: GoogleLogin, db: Session = Depends(get_db)):
    """Verify a Google Identity Services ID token server-side."""
    from google.auth.transport import requests as greq
    from google.oauth2 import id_token
    try:
        info = id_token.verify_oauth2_token(body.id_token, greq.Request(), get_settings().GOOGLE_CLIENT_ID)
    except ValueError:
        raise HTTPException(401, "Google sign-in failed")
    u = db.scalar(select(User).where(or_(User.google_sub == info["sub"], User.email == info.get("email", "").lower())))
    if not u:
        if not body.phone:
            raise HTTPException(428, "Add your mobile number to finish signing up")
        u = User(full_name=info.get("name", "Rider"), email=info["email"].lower(), phone=body.phone, role="customer",
                 google_sub=info["sub"], avatar_url=info.get("picture"), referral_code=secrets.token_hex(3).upper())
        db.add(u)
    u.google_sub = info["sub"]
    db.commit()
    return _tokens(u)


class Refresh(BaseModel):
    refresh_token: str


@router.post("/refresh")
def refresh(body: Refresh, db: Session = Depends(get_db)):
    try:
        data = decode_token(body.refresh_token, "refresh")
    except jwt.PyJWTError:
        raise HTTPException(401, "Please sign in again")
    u = db.get(User, int(data["sub"]))
    if not u or u.session_version != data.get("sv"):
        raise HTTPException(401, "Session revoked")
    return _tokens(u)


@router.post("/logout-all")
def logout_all(user: User = Depends(current_user), db: Session = Depends(get_db)):
    user.session_version += 1
    db.commit()
    return {"ok": True}


class Forgot(BaseModel):
    email: EmailStr


@router.post("/forgot")
def forgot(body: Forgot, db: Session = Depends(get_db)):
    u = db.scalar(select(User).where(User.email == body.email.lower()))
    if u:
        raw, digest = reset_token()
        db.add(PasswordReset(user_id=u.id, token_hash=digest, expires_at=datetime.now(timezone.utc) + timedelta(minutes=30)))
        db.commit()
        from app.workers.tasks import send_reset_email
        send_reset_email.delay(u.email, raw)
    return {"ok": True, "message": "If the email exists, a reset link has been sent."}   # no account enumeration


class Reset(BaseModel):
    token: str
    password: str = Field(min_length=8, max_length=128)


@router.post("/reset")
def reset(body: Reset, db: Session = Depends(get_db)):
    pr = db.scalar(select(PasswordReset).where(PasswordReset.token_hash == hashlib.sha256(body.token.encode()).hexdigest()))
    if not pr or pr.used or pr.expires_at < datetime.now(timezone.utc):
        raise HTTPException(400, "Reset link invalid or expired")
    u = db.get(User, pr.user_id)
    u.password_hash, pr.used = hash_password(body.password), True
    u.session_version += 1
    db.commit()
    return {"ok": True}


# ---------------- profile ----------------
@router.get("/me")
def get_me(user: User = Depends(current_user)):
    return me(user)


class ProfileUpdate(BaseModel):
    full_name: str | None = Field(None, min_length=2, max_length=120)
    language: str | None = Field(None, pattern="^(en|ta|hi|ml|kn|te)$")
    fcm_token: str | None = None


@router.patch("/me")
def update_me(body: ProfileUpdate, user: User = Depends(current_user), db: Session = Depends(get_db)):
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(user, k, v)
    db.commit()
    return me(user)


class AddressIn(BaseModel):
    label: str = Field(max_length=40)
    address: str = Field(max_length=300)
    lat: float
    lng: float


@router.get("/addresses")
def addresses(user: User = Depends(current_user)):
    return [{"id": a.id, "label": a.label, "address": a.address, "lat": a.lat, "lng": a.lng} for a in user.addresses]


@router.post("/addresses")
def add_address(body: AddressIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    if len(user.addresses) >= 20:
        raise HTTPException(422, "Maximum 20 saved places")
    db.add(SavedAddress(user_id=user.id, **body.model_dump()))
    db.commit()
    return {"ok": True}


@router.delete("/addresses/{aid}")
def del_address(aid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    a = db.get(SavedAddress, aid)
    if not a or a.user_id != user.id:
        raise HTTPException(404)
    db.delete(a)
    db.commit()
    return {"ok": True}


class ContactIn(BaseModel):
    name: str = Field(max_length=120)
    phone: str = Field(pattern=PHONE)
    relation: str | None = None


@router.get("/contacts")
def contacts(user: User = Depends(current_user)):
    return [{"id": c.id, "name": c.name, "phone": c.phone, "relation": c.relation} for c in user.contacts]


@router.post("/contacts")
def add_contact(body: ContactIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    if len(user.contacts) >= 5:
        raise HTTPException(422, "Maximum 5 emergency contacts")
    db.add(EmergencyContact(user_id=user.id, **body.model_dump()))
    db.commit()
    return {"ok": True}


@router.delete("/contacts/{cid}")
def del_contact(cid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    c = db.get(EmergencyContact, cid)
    if not c or c.user_id != user.id:
        raise HTTPException(404)
    db.delete(c)
    db.commit()
    return {"ok": True}
