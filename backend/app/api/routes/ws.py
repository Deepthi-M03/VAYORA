"""WebSocket endpoint. Connect with ?token=<access token>; subscribe to rides you are part of."""
import json

import jwt
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.core.database import SessionLocal
from app.core.security import decode_token
from app.models import Ride, User
from app.services.realtime import hub

router = APIRouter()


@router.websocket("/ws")
async def ws(websocket: WebSocket, token: str):
    try:
        data = decode_token(token)
    except jwt.PyJWTError:
        await websocket.close(code=4401)
        return
    with SessionLocal() as db:
        user = db.get(User, int(data["sub"]))
        if not user or user.status in ("suspended", "deactivated"):
            await websocket.close(code=4403)
            return
        role, uid, did = user.role, user.id, user.driver.id if user.driver else None
    await websocket.accept()
    await hub.join(f"user:{uid}", websocket)
    if role == "admin":
        await hub.join("admin:live", websocket)
    try:
        while True:
            msg = json.loads(await websocket.receive_text())
            if msg.get("op") == "subscribe_ride":
                with SessionLocal() as db:
                    r = db.get(Ride, int(msg["ride_id"]))
                    allowed = r and (role == "admin" or r.customer_id == uid or (did and r.driver_id == did))
                if allowed:
                    await hub.join(f"ride:{r.id}", websocket)
                    await websocket.send_text(json.dumps({"event": "subscribed", "ride_id": r.id}))
            elif msg.get("op") == "ping":
                await websocket.send_text('{"event":"pong"}')
    except (WebSocketDisconnect, RuntimeError, ValueError):
        hub.leave(websocket)
