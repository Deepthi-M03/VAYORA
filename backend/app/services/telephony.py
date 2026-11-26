"""Masked calling. Provider-agnostic: swap Exotel for Knowlarity/Plivo/Twilio by adding an adapter.

Flow: when a driver is assigned, ``open_session`` reserves a virtual number from the pool and
tells the provider "calls to this number from customer X go to driver Y and vice versa". The
app only ever shows the virtual number. The session expires 30 min after the ride ends.
"""
from __future__ import annotations

import abc
import itertools
import logging
import uuid
from dataclasses import dataclass

import requests

from app.core.config import get_settings

log = logging.getLogger("vayora.telephony")


@dataclass
class BridgeResult:
    virtual_number: str
    provider_session_id: str


@dataclass
class CallResult:
    provider_call_id: str
    status: str
    failure_reason: str | None = None


class TelephonyProvider(abc.ABC):
    name = "base"

    @abc.abstractmethod
    def open_session(self, ride_code: str, customer_phone: str, driver_phone: str) -> BridgeResult: ...

    @abc.abstractmethod
    def connect(self, from_phone: str, to_phone: str, virtual_number: str) -> CallResult: ...

    @abc.abstractmethod
    def close_session(self, provider_session_id: str) -> None: ...


class MockProvider(TelephonyProvider):
    """Development provider: no real calls, deterministic virtual numbers."""
    name = "mock"
    _counter = itertools.count(1)

    def open_session(self, ride_code, customer_phone, driver_phone):
        return BridgeResult(f"+91 80{next(self._counter):08d}"[:16], f"mock-{uuid.uuid4().hex[:10]}")

    def connect(self, from_phone, to_phone, virtual_number):
        return CallResult(f"mockcall-{uuid.uuid4().hex[:10]}", "initiated")

    def close_session(self, provider_session_id):
        return None


class ExotelProvider(TelephonyProvider):
    """Exotel 'Connect two numbers' API with a virtual number (ExoPhone) as caller ID."""
    name = "exotel"

    def __init__(self):
        s = get_settings()
        self.sid, self.key, self.token, self.sub = s.EXOTEL_SID, s.EXOTEL_API_KEY, s.EXOTEL_API_TOKEN, s.EXOTEL_SUBDOMAIN
        self.pool = [n.strip() for n in s.EXOTEL_VIRTUAL_NUMBERS.split(",") if n.strip()]
        self.record = s.CALL_RECORDING_ENABLED
        if not (self.sid and self.key and self.token and self.pool):
            raise RuntimeError("Exotel credentials or virtual number pool missing")

    def open_session(self, ride_code, customer_phone, driver_phone):
        # Number pool allocation; production should lease from Redis to avoid collisions across workers.
        number = self.pool[hash(ride_code) % len(self.pool)]
        return BridgeResult(number, f"exo-{ride_code}")

    def connect(self, from_phone, to_phone, virtual_number):
        url = f"https://{self.key}:{self.token}@{self.sub}/v1/Accounts/{self.sid}/Calls/connect.json"
        try:
            r = requests.post(url, data={"From": from_phone, "To": to_phone, "CallerId": virtual_number,
                                         "Record": "true" if self.record else "false"}, timeout=10)
            r.raise_for_status()
            call = r.json().get("Call", {})
            return CallResult(call.get("Sid", ""), "initiated")
        except requests.RequestException as exc:
            log.warning("Exotel connect failed: %s", exc)
            return CallResult(f"failed-{uuid.uuid4().hex[:8]}", "failed", str(exc)[:120])

    def close_session(self, provider_session_id):
        return None


def get_provider() -> TelephonyProvider:
    return {"mock": MockProvider, "exotel": ExotelProvider}[get_settings().TELEPHONY_PROVIDER]()
