"""Route distance/time via Google Distance Matrix (server-side key), haversine fallback."""
from __future__ import annotations

import logging
from decimal import Decimal

import requests

from app.core.config import get_settings
from app.engines.geo import estimate_route

log = logging.getLogger("vayora.maps")


def route(lat1, lng1, lat2, lng2, category: str) -> tuple[Decimal, Decimal, str]:
    """Returns (km, minutes, source)."""
    key = get_settings().GOOGLE_MAPS_API_KEY
    if key:
        try:
            r = requests.get("https://maps.googleapis.com/maps/api/distancematrix/json", timeout=6, params={
                "origins": f"{lat1},{lng1}", "destinations": f"{lat2},{lng2}", "key": key,
                "departure_time": "now", "mode": "driving", "region": "in"})
            el = r.json()["rows"][0]["elements"][0]
            if el.get("status") == "OK":
                secs = el.get("duration_in_traffic", el["duration"])["value"]
                return (Decimal(el["distance"]["value"]) / 1000).quantize(Decimal("0.01")), \
                    Decimal(max(1, round(secs / 60))), "google"
        except Exception as exc:  # noqa: BLE001
            log.warning("Distance Matrix failed, using fallback: %s", exc)
    km, mins = estimate_route(lat1, lng1, lat2, lng2, category)
    return km, mins, "estimate"
