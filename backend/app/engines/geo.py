"""Geo helpers: distance, ETA fallback, point-in-polygon for service zones, driver matching."""
from __future__ import annotations

import math
from dataclasses import dataclass
from decimal import Decimal

EARTH_KM = 6371.0088
ROAD_FACTOR = 1.32  # straight-line -> typical Indian urban road distance


def haversine_km(lat1, lon1, lat2, lon2) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_KM * math.asin(math.sqrt(a))


AVG_SPEED_KMPH = {"bike": 24, "auto": 20, "car": 22, "tourist": 45}


def estimate_route(lat1, lon1, lat2, lon2, category: str) -> tuple[Decimal, Decimal]:
    """Fallback when the maps provider is unavailable. Returns (km, minutes)."""
    km = haversine_km(lat1, lon1, lat2, lon2) * ROAD_FACTOR
    mins = km / AVG_SPEED_KMPH.get(category, 22) * 60
    return Decimal(str(round(km, 2))), Decimal(str(max(1, round(mins))))


def point_in_polygon(lat: float, lon: float, polygon: list[list[float]]) -> bool:
    """Ray casting. polygon = [[lat, lon], ...]"""
    inside, j = False, len(polygon) - 1
    for i in range(len(polygon)):
        yi, xi = polygon[i]
        yj, xj = polygon[j]
        if ((xi > lon) != (xj > lon)) and (lat < (yj - yi) * (lon - xi) / ((xj - xi) or 1e-12) + yi):
            inside = not inside
        j = i
    return inside


@dataclass
class Candidate:
    driver_id: int
    lat: float
    lon: float
    rank_score: float      # 0..100
    idle_minutes: float
    favourite: bool = False


def rank_candidates(pickup_lat, pickup_lon, candidates: list[Candidate], radius_km: float = 5.0) -> list[tuple[int, float, float]]:
    """Order drivers for dispatch: mostly distance, then quality, fairness (idle time), favourites.

    Returns [(driver_id, distance_km, dispatch_score)], best first.
    """
    out = []
    for c in candidates:
        d = haversine_km(pickup_lat, pickup_lon, c.lat, c.lon)
        if d > radius_km:
            continue
        s = (1 - d / radius_km) * 60 + (c.rank_score / 100) * 25 + min(c.idle_minutes, 30) / 30 * 10 + (5 if c.favourite else 0)
        out.append((c.driver_id, round(d, 3), round(s, 3)))
    return sorted(out, key=lambda x: -x[2])
