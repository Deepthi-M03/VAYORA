from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.deps import current_user
from app.models import Ride, User
from app.services import ai, config_store

router = APIRouter(prefix="/ai", tags=["ai"])
_rate: dict[int, list[datetime]] = {}


class ChatIn(BaseModel):
    message: str = Field(min_length=1, max_length=1500)
    history: list[dict] = Field(default_factory=list, max_length=20)
    language: str = "en"


def _context(db: Session, user: User) -> dict:
    if user.role == "customer":
        active = db.scalar(select(Ride).where(Ride.customer_id == user.id, Ride.status.in_(
            ["searching", "assigned", "arrived", "in_progress"])).order_by(Ride.id.desc()))
        recent = db.scalars(select(Ride).where(Ride.customer_id == user.id).order_by(Ride.id.desc()).limit(3)).all()
        return {"name": user.full_name.split()[0],
                "active_ride": active and {"code": active.code, "status": active.status, "pickup": active.pickup_address,
                                           "drop": active.drop_address, "estimate": [str(active.est_fare_low), str(active.est_fare_high)]},
                "recent_rides": [{"code": r.code, "status": r.status, "total": str(r.final_total), "breakdown": r.final_breakdown or r.est_breakdown}
                                 for r in recent],
                "saved_places": [a.label + ": " + a.address for a in user.addresses],
                "cancellation_policy": config_store.get(db, "cancellation_policy")}
    if user.role == "driver":
        from app.api.routes.driver import earnings, performance
        return {"earnings": earnings(user, db), "performance": performance(user, db),
                "commission_slabs": config_store.get(db, "commission_slabs")}
    from app.api.routes.admin import overview
    return {"kpis": overview(7, user, db)}


@router.post("/chat")
def chat(body: ChatIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    now = datetime.now(timezone.utc)
    window = [t for t in _rate.get(user.id, []) if t > now - timedelta(minutes=1)]
    if len(window) >= 12:
        raise HTTPException(429, "Slow down a little. Try again in a minute.")
    _rate[user.id] = [*window, now]
    return ai.chat(user.role, body.message, body.history, _context(db, user), body.language)
