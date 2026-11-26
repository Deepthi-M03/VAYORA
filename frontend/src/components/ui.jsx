import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { prefersReducedMotion } from '../lib/router.jsx'
import { Vehicle } from '../motion/vehicles.jsx'

/* ------------------------------------------------------------------ toasts */
const ToastCtx = createContext(() => {})
export const useToast = () => useContext(ToastCtx)
export function ToastProvider({ children }) {
  const [items, setItems] = useState([])
  const push = useCallback((text, tone = '') => {
    const id = Math.random()
    setItems((x) => [...x, { id, text, tone }])
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), 4200)
  }, [])
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => <div key={t.id} className={`toast ${t.tone}`}>{t.text}</div>)}
      </div>
    </ToastCtx.Provider>
  )
}

/* ------------------------------------------------------------------ modal */
export function Modal({ title, onClose, children, width }) {
  const ref = useRef(null)
  useEffect(() => {
    const prev = document.activeElement
    ref.current?.focus()
    const esc = (e) => e.key === 'Escape' && onClose?.()
    window.addEventListener('keydown', esc)
    return () => { window.removeEventListener('keydown', esc); prev?.focus?.() }
  }, [onClose])
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref} style={width ? { width } : undefined}>
        <div className="row between" style={{ marginBottom: 16 }}>
          <h2 style={{ fontSize: 'var(--t-xl)' }}>{title}</h2>
          {onClose && <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>}
        </div>
        {children}
      </div>
    </div>
  )
}

export function Switch({ checked, onChange, label, disabled }) {
  return <button type="button" role="switch" aria-checked={!!checked} aria-label={label} className="switch" disabled={disabled}
                 onClick={() => onChange(!checked)} />
}

export function Field({ label, children, hint }) {
  return <label className="field"><span>{label}</span>{children}{hint && <small className="muted tiny">{hint}</small>}</label>
}

/* ------------------------------------------------------------------ motion helpers */
export function useReveal() {
  useEffect(() => {
    const els = document.querySelectorAll('[data-reveal]:not(.in)')
    if (prefersReducedMotion() || !('IntersectionObserver' in window)) { els.forEach((e) => e.classList.add('in')); return }
    const io = new IntersectionObserver((entries) => entries.forEach((en) => {
      if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target) }
    }), { threshold: 0.15 })
    els.forEach((e) => io.observe(e))
    return () => io.disconnect()
  })
}

/** Counts up to `value` once visible. Keeps the formatted output stable for screen readers. */
export function Counter({ value, format = (n) => Math.round(n).toLocaleString('en-IN'), duration = 1100 }) {
  const [shown, setShown] = useState(prefersReducedMotion() ? Number(value) : 0)
  const ref = useRef(null)
  useEffect(() => {
    const target = Number(value) || 0
    if (prefersReducedMotion()) { setShown(target); return }
    let raf, start
    const from = 0
    const tick = (t) => {
      start ??= t
      const p = Math.min(1, (t - start) / duration)
      setShown(from + (target - from) * (1 - Math.pow(1 - p, 3)))
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value, duration])
  return <span ref={ref} aria-label={format(Number(value) || 0)}>{format(shown)}</span>
}

/** Loader: a small vehicle driving on a looping road. */
export function Loader({ type = 'auto', label = 'Loading' }) {
  return (
    <div className="loader" role="status" aria-label={label} style={{ display: 'grid', justifyItems: 'center', gap: 10, padding: 30 }}>
      <div style={{ position: 'relative', width: 220, height: 70, overflow: 'hidden' }}>
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 4, height: 8, borderRadius: 4, background: '#3a3630' }}>
          <div className="dash-road" style={{ height: 2, marginTop: 3, background: 'repeating-linear-gradient(90deg, var(--cream) 0 14px, transparent 14px 28px)', animation: 'roadscroll .5s linear infinite' }} />
        </div>
        <Vehicle type={type} moving width={100} style={{ position: 'absolute', left: 60, bottom: 6 }} />
      </div>
      <span className="muted small">{label}…</span>
      <style>{'@keyframes roadscroll { to { background-position: -28px 0 } }'}</style>
    </div>
  )
}

export function Empty({ title, children, action }) {
  return (
    <div className="panel flat" style={{ textAlign: 'center', padding: 40 }}>
      <h3>{title}</h3>
      <p className="muted" style={{ margin: '8px auto 18px', maxWidth: 420 }}>{children}</p>
      {action}
    </div>
  )
}

export function Stat({ label, value, format, note, tone }) {
  return (
    <div className="panel" style={{ padding: 18 }}>
      <div className="muted small">{label}</div>
      <div className="num" style={{ fontSize: 'var(--t-2xl)', marginTop: 6, color: tone === 'accent' ? 'var(--accent)' : undefined }}>
        <Counter value={value} format={format} />
      </div>
      {note && <div className="tiny muted" style={{ marginTop: 4 }}>{note}</div>}
    </div>
  )
}

/* ------------------------------------------------------------------ charts (SVG, single-hue, labelled) */
export function BarChart({ data, x, y, format = (v) => v, height = 200, label }) {
  const max = Math.max(1, ...data.map((d) => Number(d[y])))
  const w = 100 / Math.max(1, data.length)
  return (
    <figure style={{ margin: 0 }}>
      <svg viewBox={`0 0 100 ${height / 4}`} preserveAspectRatio="none" style={{ width: '100%', height }} role="img" aria-label={label}>
        {[0.25, 0.5, 0.75].map((g) => <line key={g} x1="0" x2="100" y1={(height / 4) * g} y2={(height / 4) * g} stroke="rgba(42,39,34,.08)" strokeWidth=".2" />)}
        {data.map((d, i) => {
          const h = (Number(d[y]) / max) * (height / 4 - 4)
          return (
            <rect key={i} x={i * w + w * 0.18} width={w * 0.64} y={height / 4 - h} height={h} rx=".8"
                  fill={i === data.length - 1 ? 'var(--accent)' : 'var(--sage-deep)'} style={{ transformOrigin: 'bottom', transformBox: 'fill-box', animation: `grow .7s ${i * 25}ms var(--ease-out) both` }}>
              <title>{`${d[x]}: ${format(d[y])}`}</title>
            </rect>
          )
        })}
      </svg>
      <div className="row between tiny muted" style={{ marginTop: 6 }}>
        <span>{data[0]?.[x]}</span><span>{data[data.length - 1]?.[x]}</span>
      </div>
      <style>{'@keyframes grow { from { transform: scaleY(0) } }'}</style>
    </figure>
  )
}

export function Ring({ value, max = 100, size = 150, label, children }) {
  const r = 58, c = 2 * Math.PI * r
  const p = Math.max(0, Math.min(1, Number(value) / max))
  return (
    <svg viewBox="0 0 140 140" width={size} height={size} role="img" aria-label={label}>
      <circle cx="70" cy="70" r={r} fill="none" stroke="var(--sage-mist)" strokeWidth="12" />
      <circle cx="70" cy="70" r={r} fill="none" stroke="var(--accent)" strokeWidth="12" strokeLinecap="round"
              strokeDasharray={c} strokeDashoffset={c * (1 - p)} transform="rotate(-90 70 70)"
              style={{ transition: 'stroke-dashoffset 1.2s var(--ease-out)' }} />
      {children}
    </svg>
  )
}

export function Meter({ value, max = 100, tone }) {
  return (
    <div style={{ height: 8, borderRadius: 8, background: 'var(--sage-mist)', overflow: 'hidden' }}>
      <div style={{ width: `${Math.min(100, (Number(value) / max) * 100)}%`, height: '100%', borderRadius: 8,
                    background: tone === 'bad' ? 'var(--bad)' : 'var(--accent)', transition: 'width 1s var(--ease-out)' }} />
    </div>
  )
}

/* Animated confirmation tick (payments, bookings) */
export function Tick({ size = 84 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 84 84" role="img" aria-label="Done">
      <circle cx="42" cy="42" r="38" fill="var(--accent)" style={{ animation: 'pop .5s var(--ease-out) both' }} />
      <path d="M26 43 l11 11 l22 -24" fill="none" stroke="var(--cream)" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round"
            strokeDasharray="60" strokeDashoffset="60" style={{ animation: 'draw .5s .35s var(--ease-out) forwards' }} />
      <style>{'@keyframes pop { from { transform: scale(.3); transform-origin: center; opacity: 0 } } @keyframes draw { to { stroke-dashoffset: 0 } }'}</style>
    </svg>
  )
}
