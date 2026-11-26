from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from ._base import Timestamps

SAFETY_CATEGORIES = {"unsafe_driving", "harassment_safety"}
COMPLAINT_CATEGORIES = ["driver_behaviour", "customer_behaviour", "unsafe_driving", "vehicle_condition",
                        "payment_dispute", "wrong_fare", "trip_issue", "harassment_safety", "lost_item", "other"]


class Complaint(Timestamps, Base):
    __tablename__ = "complaints"
    id: Mapped[int] = mapped_column(primary_key=True)
    ticket: Mapped[str] = mapped_column(String(12), unique=True)
    ride_id: Mapped[int | None] = mapped_column(ForeignKey("rides.id"), index=True)
    raised_by: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    against_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True)
    against_vehicle_id: Mapped[int | None] = mapped_column(ForeignKey("vehicles.id"))
    category: Mapped[str] = mapped_column(String(30), index=True)
    priority: Mapped[str] = mapped_column(String(10), index=True)   # P1 (safety) .. P4
    status: Mapped[str] = mapped_column(String(20), default="open", index=True)  # open|investigating|awaiting_evidence|resolved|rejected|appealed
    description: Mapped[str] = mapped_column(Text)
    evidence: Mapped[list] = mapped_column(JSON, default=list)
    assigned_to: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    severity: Mapped[str | None] = mapped_column(String(10))       # minor|major|critical when upheld
    upheld: Mapped[bool | None] = mapped_column(Boolean)
    resolution: Mapped[str | None] = mapped_column(Text)
    sla_due_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    actions = relationship("ComplaintAction", back_populates="complaint", order_by="ComplaintAction.id")


class ComplaintAction(Timestamps, Base):
    """Investigation notes, evidence requests, decisions - the complaint's audit trail."""
    __tablename__ = "complaint_actions"
    id: Mapped[int] = mapped_column(primary_key=True)
    complaint_id: Mapped[int] = mapped_column(ForeignKey("complaints.id", ondelete="CASCADE"), index=True)
    actor_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    kind: Mapped[str] = mapped_column(String(30))   # note|request_evidence|status_change|account_action|appeal
    body: Mapped[str] = mapped_column(Text)
    internal: Mapped[bool] = mapped_column(Boolean, default=True)
    complaint = relationship("Complaint", back_populates="actions")


class AccountAction(Timestamps, Base):
    """Every warning, restriction, suspension, deactivation, restoration and appeal outcome."""
    __tablename__ = "account_actions"
    id: Mapped[int] = mapped_column(primary_key=True)
    target_type: Mapped[str] = mapped_column(String(10))   # user | vehicle
    target_id: Mapped[int] = mapped_column(Integer, index=True)
    action: Mapped[str] = mapped_column(String(20))        # warn|restrict|suspend|deactivate|restore|appeal_upheld|appeal_rejected
    reason: Mapped[str] = mapped_column(String(300))
    complaint_id: Mapped[int | None] = mapped_column(ForeignKey("complaints.id"))
    until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    actor_id: Mapped[int] = mapped_column(ForeignKey("users.id"))


class CallSession(Timestamps, Base):
    """A masked-number bridge valid for one ride. Neither party ever receives the other's number."""
    __tablename__ = "call_sessions"
    id: Mapped[int] = mapped_column(primary_key=True)
    ride_id: Mapped[int] = mapped_column(ForeignKey("rides.id"), unique=True)
    provider: Mapped[str] = mapped_column(String(20))
    virtual_number: Mapped[str] = mapped_column(String(20))
    provider_session_id: Mapped[str | None] = mapped_column(String(60))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    active: Mapped[bool] = mapped_column(Boolean, default=True)


class CallLog(Timestamps, Base):
    """Metadata only. No audio is stored unless CALL_RECORDING_ENABLED and disclosed."""
    __tablename__ = "call_logs"
    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("call_sessions.id"), index=True)
    caller_role: Mapped[str] = mapped_column(String(10))
    provider_call_id: Mapped[str | None] = mapped_column(String(60), unique=True)
    status: Mapped[str] = mapped_column(String(20))   # initiated|ringing|completed|no_answer|busy|failed
    duration_sec: Mapped[int] = mapped_column(Integer, default=0)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    failure_reason: Mapped[str | None] = mapped_column(String(120))
