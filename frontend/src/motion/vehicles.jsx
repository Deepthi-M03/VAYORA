/* Original VAYORA vehicle illustrations. All face right, drawn on a 220 x 120 grid, ground at y = 108.
   Wheels carry .spin so they turn while the vehicle drives; the body carries .bob for suspension. */

const C = {
  accent: 'var(--accent)', cream: 'var(--cream)', sage: 'var(--sage)', sageDeep: 'var(--sage-deep)',
  ink: '#2A2722', glass: '#CFE0DF', tyre: '#1F1D1A', rim: '#D9D4C7', skin: '#B27C5A',
}

function Wheel({ cx, cy, r, moving }) {
  return (
    <g className={moving ? 'spin' : undefined}>
      <circle cx={cx} cy={cy} r={r} fill={C.tyre} />
      <circle cx={cx} cy={cy} r={r * 0.62} fill={C.rim} />
      {[0, 60, 120].map((a) => (
        <rect key={a} x={cx - r * 0.58} y={cy - 1.2} width={r * 1.16} height={2.4} rx={1.2} fill="#8B867A" transform={`rotate(${a} ${cx} ${cy})`} />
      ))}
      <circle cx={cx} cy={cy} r={r * 0.18} fill={C.ink} />
    </g>
  )
}

function Bike({ moving }) {
  return (
    <svg viewBox="0 0 220 120" role="img" aria-label="Motorbike">
      <ellipse cx="110" cy="110" rx="78" ry="5" fill="rgba(0,0,0,.18)" />
      <g className={moving ? 'bob' : undefined}>
        {/* frame */}
        <path d="M58 86 L96 62 L140 62 L160 86" stroke={C.ink} strokeWidth="6" fill="none" strokeLinecap="round" />
        <path d="M150 50 L170 86" stroke="#6E6A61" strokeWidth="5" strokeLinecap="round" />
        {/* tank and seat */}
        <path d="M96 60 C100 44 128 42 142 50 L146 62 L98 64 Z" fill={C.accent} />
        <path d="M62 58 C70 52 92 52 100 58 L98 64 L64 66 Z" fill={C.ink} />
        <rect x="104" y="64" width="30" height="16" rx="5" fill="#4A463F" />
        {/* exhaust */}
        <path d="M70 84 L116 84" stroke="#B9B2A3" strokeWidth="5" strokeLinecap="round" />
        {/* headlight + bars */}
        <circle cx="160" cy="50" r="7" fill={C.cream} stroke={C.ink} strokeWidth="2" />
        <path d="M146 40 L156 36" stroke={C.ink} strokeWidth="4" strokeLinecap="round" />
        {/* rider */}
        <path d="M86 56 C84 36 96 24 110 26 L128 46 L114 52 Z" fill={C.sageDeep} />
        <path d="M118 36 L146 42" stroke={C.sageDeep} strokeWidth="8" strokeLinecap="round" />
        <path d="M96 58 L120 68 L124 88" stroke={C.ink} strokeWidth="9" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="108" cy="16" r="12" fill={C.accent} />
        <path d="M112 10 h10 a4 4 0 0 1 0 10 h-10 z" fill={C.glass} />
      </g>
      <Wheel cx={58} cy={88} r={20} moving={moving} />
      <Wheel cx={168} cy={88} r={20} moving={moving} />
    </svg>
  )
}

function Auto({ moving }) {
  return (
    <svg viewBox="0 0 220 120" role="img" aria-label="Auto-rickshaw">
      <ellipse cx="110" cy="111" rx="86" ry="5" fill="rgba(0,0,0,.18)" />
      <g className={moving ? 'bob' : undefined}>
        {/* canopy */}
        <path d="M34 34 C40 14 120 8 158 18 L166 34 Z" fill={C.ink} />
        <path d="M30 34 H170 V42 H30 Z" fill={C.cream} />
        {/* body */}
        <path d="M30 42 H128 L150 44 C168 46 180 60 182 80 L182 92 H28 Z" fill={C.sage} />
        <path d="M128 42 C140 40 166 44 176 66 L182 80 L148 78 Z" fill={C.accent} />
        {/* cabin opening + seat */}
        <path d="M42 46 H112 V80 H42 Z" fill="#E9E3D6" opacity=".55" />
        <rect x="50" y="62" width="44" height="14" rx="5" fill={C.accent} />
        <path d="M114 46 L130 46 L146 74 L114 76 Z" fill={C.glass} opacity=".8" />
        {/* driver silhouette */}
        <circle cx="122" cy="52" r="7" fill={C.skin} />
        <path d="M114 60 C116 56 128 56 130 62 L130 76 L114 76 Z" fill={C.cream} />
        {/* stripes + lamp */}
        <rect x="28" y="84" width="154" height="5" fill={C.cream} />
        <circle cx="180" cy="68" r="5" fill={C.cream} stroke={C.ink} strokeWidth="2" />
        <rect x="24" y="70" width="8" height="12" rx="2" fill={C.accent} />
      </g>
      <Wheel cx={56} cy={94} r={15} moving={moving} />
      <Wheel cx={160} cy={94} r={15} moving={moving} />
    </svg>
  )
}

function Car({ moving }) {
  return (
    <svg viewBox="0 0 220 120" role="img" aria-label="Car">
      <ellipse cx="110" cy="111" rx="96" ry="5" fill="rgba(0,0,0,.18)" />
      <g className={moving ? 'bob' : undefined}>
        <path d="M14 82 C14 66 24 60 42 58 L66 56 C80 38 96 32 122 32 C146 32 162 40 178 56 L196 60 C206 62 210 70 210 82 L210 90 H14 Z" fill={C.accent} />
        <path d="M76 56 C88 42 100 38 120 38 L122 56 Z" fill={C.glass} />
        <path d="M128 38 C146 38 158 44 170 56 L128 56 Z" fill={C.glass} />
        <path d="M124 38 V88" stroke="rgba(0,0,0,.25)" strokeWidth="2" />
        <path d="M70 60 H190" stroke="rgba(255,255,255,.18)" strokeWidth="3" />
        <rect x="100" y="64" width="12" height="3" rx="1.5" fill={C.cream} />
        <rect x="140" y="64" width="12" height="3" rx="1.5" fill={C.cream} />
        <path d="M200 66 h8 v8 h-10 z" fill={C.cream} />
        <path d="M14 68 h6 v10 h-6 z" fill="#E0614F" />
        <rect x="14" y="84" width="196" height="6" rx="3" fill="#3E1110" />
      </g>
      <Wheel cx={52} cy={90} r={17} moving={moving} />
      <Wheel cx={172} cy={90} r={17} moving={moving} />
    </svg>
  )
}

function Tourist({ moving }) {
  return (
    <svg viewBox="0 0 260 120" role="img" aria-label="Tourist vehicle">
      <ellipse cx="130" cy="111" rx="118" ry="5" fill="rgba(0,0,0,.18)" />
      <g className={moving ? 'bob' : undefined}>
        {/* roof carrier with luggage */}
        <rect x="40" y="10" width="150" height="5" rx="2" fill={C.ink} />
        <rect x="52" y="0" width="34" height="11" rx="3" fill={C.accent} />
        <rect x="92" y="3" width="26" height="8" rx="3" fill={C.sageDeep} />
        <path d="M18 88 V36 C18 24 26 18 40 18 H196 C214 18 222 28 232 46 L246 64 C252 70 252 78 252 88 Z" fill={C.cream} />
        <path d="M18 70 H252 V78 H18 Z" fill={C.accent} />
        <path d="M18 62 H252 V66 H18 Z" fill={C.sage} />
        {[30, 70, 110, 150].map((x) => <rect key={x} x={x} y="28" width="32" height="24" rx="5" fill={C.glass} />)}
        <path d="M192 28 H212 C220 28 226 36 232 52 H192 Z" fill={C.glass} />
        <path d="M244 60 h8 v8 h-10 z" fill="#FFF4DD" />
        <rect x="18" y="84" width="234" height="6" rx="3" fill="#3B3731" />
      </g>
      <Wheel cx={58} cy={92} r={16} moving={moving} />
      <Wheel cx={208} cy={92} r={16} moving={moving} />
    </svg>
  )
}

export const VEHICLES = {
  bike: { name: 'Bike', Comp: Bike, width: 150, speed: 1.0 },
  auto: { name: 'Auto', Comp: Auto, width: 170, speed: 1.15 },
  car: { name: 'Car', Comp: Car, width: 190, speed: 1.05 },
  tourist: { name: 'Tourist', Comp: Tourist, width: 240, speed: 1.3 },
}

export function Vehicle({ type = 'car', moving = false, width, style, className }) {
  const v = VEHICLES[type] || VEHICLES.car
  return (
    <div className={className} style={{ width: width ?? v.width, ...style }}>
      <v.Comp moving={moving} />
    </div>
  )
}
