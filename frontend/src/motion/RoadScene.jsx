/* Hero illustration: a winding road climbing toward a destination pin, with VAYORA's four
   vehicles travelling along it (CSS motion path, so it stays on the compositor). */
import { Vehicle } from './vehicles.jsx'

const ROAD = 'M -40 600 C 120 560, 140 470, 250 440 S 430 420, 440 320 S 300 210, 360 140 S 520 60, 640 40'

export default function RoadScene({ size = 560 }) {
  const fleet = [['bike', 0, 84], ['car', -4.5, 108], ['auto', -9, 94], ['tourist', -13.5, 132]]
  return (
    <div className="road-scene" style={{ width: size, height: size, position: 'relative' }} aria-hidden="true">
      <div style={{ width: 600, height: 600, transform: `scale(${size / 600})`, transformOrigin: '0 0', position: 'absolute' }}>
        <svg width="600" height="600" viewBox="0 0 600 600" style={{ position: 'absolute', inset: 0, overflow: 'visible' }}>
          {/* terrain */}
          <circle cx="470" cy="130" r="210" fill="rgba(232,210,181,.07)" />
          <circle cx="470" cy="130" r="130" fill="rgba(232,210,181,.06)" />
          {[...Array(9)].map((_, i) => <rect key={i} x={40 + i * 60} y={520 - (i % 3) * 30 - i * 12} width="34" height={60 + (i % 4) * 26} rx="4" fill="rgba(165,167,155,.16)" />)}
          {/* road */}
          <path d={ROAD} stroke="rgba(0,0,0,.25)" strokeWidth="74" fill="none" strokeLinecap="round" transform="translate(0 8)" />
          <path d={ROAD} stroke="#2E2A25" strokeWidth="70" fill="none" strokeLinecap="round" />
          <path d={ROAD} stroke="var(--cream)" strokeWidth="70" fill="none" strokeLinecap="round" strokeDasharray="0 0" opacity=".08" />
          <path d={ROAD} stroke="var(--cream)" strokeWidth="3" fill="none" strokeDasharray="18 16" className="road-centre" />
          {/* destination pin */}
          <g transform="translate(560 40)">
            <circle r="16" fill="var(--cream)" className="pulse" />
            <path d="M0 0 C-5 -12 -20 -16 -20 -32 a20 20 0 0 1 40 0 C20 -16 5 -12 0 0z" fill="var(--cream)" />
            <circle cy="-32" r="7" fill="var(--accent)" />
          </g>
          {/* trees */}
          {[[90, 470], [520, 300], [210, 330], [330, 520], [110, 300]].map(([x, y], i) => (
            <g key={i} transform={`translate(${x} ${y})`}><rect x="-2" y="0" width="4" height="16" fill="#5d574c" /><circle cy="-6" r="14" fill="var(--sage)" opacity=".85" /></g>
          ))}
        </svg>
        {fleet.map(([type, delay, w]) => (
          <div key={type} className="road-traveller" style={{ offsetPath: `path("${ROAD}")`, animationDelay: `${delay}s`, width: w }}>
            <Vehicle type={type} moving width={w} />
          </div>
        ))}
      </div>
      <style>{`
        .road-traveller { position: absolute; left: 0; top: 0; offset-rotate: auto; offset-anchor: 50% 88%;
          animation: travel 18s linear infinite; will-change: offset-distance; }
        @keyframes travel { from { offset-distance: 0% } to { offset-distance: 100% } }
        .road-centre { animation: dash 1.6s linear infinite; }
        @media (prefers-reduced-motion: reduce) {
          .road-traveller { animation: none; }
          .road-traveller:nth-of-type(2) { offset-distance: 30% } .road-traveller:nth-of-type(3) { offset-distance: 55% }
          .road-traveller:nth-of-type(4) { offset-distance: 78% } .road-traveller:nth-of-type(5) { offset-distance: 12% }
        }
      `}</style>
    </div>
  )
}
