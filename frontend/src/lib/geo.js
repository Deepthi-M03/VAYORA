/* Geo helpers shared by the map and the demo backend. */
export const haversineKm = (a, b) => {
  const R = 6371, toR = (d) => (d * Math.PI) / 180
  const dLat = toR(b.lat - a.lat), dLng = toR(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

export function seeded(seed) {
  let s = Math.abs(Math.floor(seed * 1e6)) % 2147483647 || 1
  return () => (s = (s * 16807) % 2147483647) / 2147483647
}

/** A plausible street-following route: two or three orthogonal-ish legs with gentle bends. */
export function makeRoute(a, b, steps = 48) {
  const mid1 = { lat: a.lat + (b.lat - a.lat) * 0.15, lng: a.lng + (b.lng - a.lng) * 0.62 }
  const mid2 = { lat: a.lat + (b.lat - a.lat) * 0.78, lng: a.lng + (b.lng - a.lng) * 0.7 }
  const legs = [a, mid1, mid2, b]
  const pts = []
  for (let l = 0; l < legs.length - 1; l++) {
    const p = legs[l], q = legs[l + 1]
    const n = Math.max(4, Math.round(steps / 3))
    for (let i = 0; i < n; i++) {
      const t = i / n
      const bend = Math.sin(t * Math.PI) * 0.0012 * (l % 2 ? 1 : -1)
      pts.push({ lat: p.lat + (q.lat - p.lat) * t + bend, lng: p.lng + (q.lng - p.lng) * t - bend })
    }
  }
  pts.push(b)
  return pts
}

export const routeLengthKm = (pts) => pts.slice(1).reduce((s, p, i) => s + haversineKm(pts[i], p), 0)

/** Point at fraction t (0..1) along a polyline, by distance. */
export function along(pts, t) {
  if (!pts?.length) return null
  const total = routeLengthKm(pts)
  let target = total * Math.max(0, Math.min(1, t))
  for (let i = 1; i < pts.length; i++) {
    const seg = haversineKm(pts[i - 1], pts[i])
    if (target <= seg) {
      const f = seg ? target / seg : 0
      return { lat: pts[i - 1].lat + (pts[i].lat - pts[i - 1].lat) * f, lng: pts[i - 1].lng + (pts[i].lng - pts[i - 1].lng) * f }
    }
    target -= seg
  }
  return pts[pts.length - 1]
}

/* Landmarks used for search suggestions in demo mode (real mode also queries /api/places). */
export const PLACES = {
  Chennai: [
    ['Chennai Central', 13.0827, 80.2752], ['Marina Beach', 13.0500, 80.2824], ['T. Nagar, Pondy Bazaar', 13.0418, 80.2341],
    ['Phoenix MarketCity, Velachery', 12.9915, 80.2167], ['Chennai Airport (MAA)', 12.9941, 80.1709], ['IIT Madras', 12.9916, 80.2336],
    ['Anna Nagar Tower Park', 13.0878, 80.2085], ['Besant Nagar Beach', 13.0003, 80.2717], ['Tidel Park, Taramani', 12.9893, 80.2483],
    ['Mylapore, Kapaleeshwarar Temple', 13.0339, 80.2696], ['Mahabalipuram', 12.6208, 80.1945], ['Pondicherry (Puducherry)', 11.9416, 79.8083],
  ],
  Bengaluru: [
    ['MG Road Metro', 12.9755, 77.6067], ['Koramangala 5th Block', 12.9352, 77.6245], ['Indiranagar 100ft Road', 12.9719, 77.6412],
    ['Kempegowda Airport (BLR)', 13.1986, 77.7066], ['Whitefield, ITPL', 12.9877, 77.7360], ['Electronic City', 12.8452, 77.6602],
    ['Lalbagh Botanical Garden', 12.9507, 77.5848], ['Mysuru Palace', 12.3052, 76.6551],
  ],
  Mumbai: [
    ['Gateway of India', 18.9220, 72.8347], ['Bandra Bandstand', 19.0454, 72.8193], ['Mumbai Airport T2 (BOM)', 19.0974, 72.8742],
    ['BKC, G Block', 19.0660, 72.8679], ['Powai Lake', 19.1270, 72.9050], ['Chhatrapati Shivaji Terminus', 18.9398, 72.8355], ['Lonavala', 18.7546, 73.4062],
  ],
  Hyderabad: [['Charminar', 17.3616, 78.4747], ['HITEC City', 17.4435, 78.3772], ['Banjara Hills Rd 12', 17.4126, 78.4382], ['RGIA Airport (HYD)', 17.2403, 78.4294], ['Gachibowli Stadium', 17.4474, 78.3489]],
  Delhi: [['Connaught Place', 28.6315, 77.2167], ['India Gate', 28.6129, 77.2295], ['IGI Airport T3 (DEL)', 28.5562, 77.1000], ['Hauz Khas Village', 28.5535, 77.1940], ['Cyber Hub, Gurugram', 28.4950, 77.0895], ['Agra, Taj Mahal', 27.1751, 78.0421]],
  Kochi: [['Fort Kochi Beach', 9.9658, 76.2421], ['Lulu Mall Edappally', 10.0271, 76.3082], ['Kochi Airport (COK)', 10.1520, 76.4019], ['Marine Drive', 9.9816, 76.2756], ['Munnar', 10.0889, 77.0595]],
  Coimbatore: [['Gandhipuram Bus Stand', 11.0183, 76.9674], ['Brookefields Mall', 11.0089, 76.9606], ['Coimbatore Airport (CJB)', 11.0300, 77.0434], ['Isha Yoga Centre', 10.9725, 76.7400], ['Ooty Lake', 11.4086, 76.6950]],
  Pune: [['Shaniwar Wada', 18.5195, 73.8553], ['Koregaon Park', 18.5362, 73.8940], ['Hinjewadi Phase 1', 18.5913, 73.7389], ['Pune Airport (PNQ)', 18.5822, 73.9197]],
}
