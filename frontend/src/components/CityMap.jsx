/* Stylised vector city map. Projects real lat/lng, draws procedurally generated streets around the
   city centre, animates the route and the live driver. Swap for Google Maps / Mapbox by keeping
   the same props (see README "Maps"). */
import { useMemo, useRef } from 'react'
import { seeded } from '../lib/geo.js'
import { Vehicle } from '../motion/vehicles.jsx'

const W = 800, H = 600

function useStreets(center) {
  return useMemo(() => {
    const rnd = seeded(center.lat * 13 + center.lng * 7)
    const arterials = [], minor = [], parks = [], water = []
    for (let i = 0; i < 7; i++) {
      const horizontal = i % 2 === 0
      const off = (rnd() - 0.5) * 0.22
      const pts = []
      for (let k = 0; k <= 8; k++) {
        const t = -0.16 + (k / 8) * 0.32
        const wob = Math.sin(k * 0.9 + i) * 0.006
        pts.push(horizontal ? { lat: center.lat + off + wob, lng: center.lng + t } : { lat: center.lat + t, lng: center.lng + off + wob })
      }
      arterials.push(pts)
    }
    const angle = rnd() * 0.25
    for (let i = -18; i <= 18; i++) {
      const d = i * 0.0085
      minor.push([{ lat: center.lat - 0.16, lng: center.lng + d + angle * 0.02 }, { lat: center.lat + 0.16, lng: center.lng + d - angle * 0.02 }])
      minor.push([{ lat: center.lat + d, lng: center.lng - 0.16 }, { lat: center.lat + d + angle * 0.01, lng: center.lng + 0.16 }])
    }
    for (let i = 0; i < 9; i++) parks.push({ lat: center.lat + (rnd() - 0.5) * 0.24, lng: center.lng + (rnd() - 0.5) * 0.24, r: 0.004 + rnd() * 0.008 })
    const wx = center.lng + 0.06 + rnd() * 0.04
    water.push([...Array(9)].map((_, k) => ({ lat: center.lat - 0.18 + k * 0.045, lng: wx + Math.sin(k) * 0.01 })))
    return { arterials, minor, parks, water }
  }, [center.lat, center.lng])
}

export default function CityMap({ center, pickup, drop, driver, route, vehicle = 'car', markers = [], onPick, height = 520, rounded = true, label = 'Map', insetLeft = 0 }) {
  const svgRef = useRef(null)
  const streets = useStreets(center)

  // Fit view to the points of interest, else ~7 km around the centre.
  const view = useMemo(() => {
    // Fit to the trip; the moving driver only counts when there is no trip yet (avoids jittery re-zooming).
    const pts = [pickup, drop, ...(route || []), ...(pickup || drop ? [] : [driver])].filter(Boolean)
    let span = 0.03
    let c = center
    if (pts.length) {
      const lats = pts.map((p) => p.lat), lngs = pts.map((p) => p.lng)
      c = { lat: (Math.min(...lats) + Math.max(...lats)) / 2, lng: (Math.min(...lngs) + Math.max(...lngs)) / 2 }
      span = Math.max(0.012, (Math.max(...lats) - Math.min(...lats)) * 0.75, (Math.max(...lngs) - Math.min(...lngs)) * 0.58)
    }
    return { c, k: ((H / 2) / span) * 0.8 * (1 - insetLeft * 0.6), cos: Math.cos((c.lat * Math.PI) / 180), ox: insetLeft * W * 0.62 }
  }, [insetLeft, center, pickup, drop, route, pickup || drop ? null : driver]) // eslint-disable-line react-hooks/exhaustive-deps

  const P = (p) => [W / 2 + view.ox / 2 + (p.lng - view.c.lng) * view.k * view.cos, H / 2 - (p.lat - view.c.lat) * view.k]
  const path = (pts) => pts.map((p, i) => (i ? 'L' : 'M') + P(p).map((n) => n.toFixed(1)).join(' ')).join(' ')

  const click = (e) => {
    if (!onPick) return
    const svg = svgRef.current
    const pt = svg.createSVGPoint()
    pt.x = e.clientX; pt.y = e.clientY
    const { x, y } = pt.matrixTransform(svg.getScreenCTM().inverse())   // correct under 'slice' scaling
    onPick({ lat: view.c.lat - (y - H / 2) / view.k, lng: view.c.lng + (x - W / 2 - view.ox / 2) / (view.k * view.cos) })
  }
  const routeD = route?.length ? path(route) : null
  const [dx, dy] = driver ? P(driver) : [0, 0]

  return (
    <div style={{ position: 'relative', height, borderRadius: rounded ? 'var(--r-lg)' : 0, overflow: 'hidden', background: '#E4E2D8' }}>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid slice" width="100%" height="100%"
           onClick={click} style={{ cursor: onPick ? 'crosshair' : 'default', display: 'block' }} role="img" aria-label={label}>
        <rect width={W} height={H} fill="#E6E3D9" />
        {streets.water.map((w, i) => <path key={i} d={path(w)} stroke="#B9CBCB" strokeWidth={Math.max(18, view.k * 0.004)} fill="none" strokeLinecap="round" />)}
        {streets.parks.map((p, i) => { const [x, y] = P(p); return <circle key={i} cx={x} cy={y} r={p.r * view.k} fill="#C9CCB8" /> })}
        {streets.minor.map((s, i) => <path key={i} d={path(s)} stroke="#F4EFE6" strokeWidth="5" fill="none" />)}
        {streets.arterials.map((s, i) => (
          <g key={i}>
            <path d={path(s)} stroke="#D6CBB8" strokeWidth="15" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            <path d={path(s)} stroke="#FBF6EC" strokeWidth="11" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </g>
        ))}
        {routeD && (
          <g key={routeD.length}>
            <path d={routeD} stroke="rgba(101,9,7,.25)" strokeWidth="14" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            <path d={routeD} stroke="var(--accent)" strokeWidth="6" fill="none" strokeLinecap="round" strokeLinejoin="round"
                  pathLength="1" strokeDasharray="1" strokeDashoffset="1" style={{ animation: 'drawroute 1.4s var(--ease-out) forwards' }} />
            <path d={routeD} stroke="var(--cream)" strokeWidth="2" fill="none" className="dash-flow" opacity=".9" />
          </g>
        )}
        {markers.map((m, i) => { const [x, y] = P(m); return (
          <g key={i} transform={`translate(${x} ${y})`}>
            <circle r="9" fill={m.busy ? 'var(--sage-deep)' : 'var(--accent)'} stroke="#fff" strokeWidth="2.5" />
            <title>{m.title}</title>
          </g>) })}
        {pickup && (() => { const [x, y] = P(pickup); return (
          <g transform={`translate(${x} ${y})`}>
            <circle r="12" fill="var(--sage-deep)" className="pulse" />
            <circle r="11" fill="var(--sage-deep)" stroke="#fff" strokeWidth="4" />
          </g>) })()}
        {drop && (() => { const [x, y] = P(drop); return (
          <g transform={`translate(${x} ${y - 26})`}><g style={{ animation: 'droppin .6s var(--ease-out) both' }}>
            <path d="M0 26 C-4 16 -16 12 -16 0 a16 16 0 0 1 32 0 C16 12 4 16 0 26 z" fill="var(--accent)" />
            <rect x="-6" y="-6" width="12" height="12" rx="2" fill="var(--cream)" />
          </g></g>) })()}
        {driver && (
          <g style={{ transform: `translate(${dx}px, ${dy}px)`, transition: 'transform 1.1s linear' }} aria-label="Driver location">
            <foreignObject x="-38" y="-52" width="76" height="46">
              <div style={{ background: 'var(--paper)', borderRadius: 14, padding: '3px 8px', border: '2px solid var(--accent)', boxShadow: 'var(--shadow-1)' }}>
                <Vehicle type={vehicle} moving width={56} />
              </div>
            </foreignObject>
            <circle r="5" fill="var(--accent)" stroke="#fff" strokeWidth="2" />
          </g>
        )}
        <style>{'@keyframes drawroute { to { stroke-dashoffset: 0 } } @keyframes droppin { from { transform: translateY(-40px); opacity: 0 } }'}</style>
      </svg>
    </div>
  )
}
