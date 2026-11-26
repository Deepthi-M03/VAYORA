/* Hash router with VAYORA's signature transition: a vehicle drives across the bottom of the screen
   and pulls the next page in behind it. One reusable system for every navigation in the app. */
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Vehicle, VEHICLES } from '../motion/vehicles.jsx'

const RouterCtx = createContext(null)
const MatchCtx = createContext(null)   // each rendered layer (current or incoming) gets its own params/query
export function useRouter() {
  const ctx = useContext(RouterCtx)
  const m = useContext(MatchCtx)
  return m ? { ...ctx, params: m.params, query: m.query, path: m.path } : ctx
}

const readHash = () => (window.location.hash.replace(/^#/, '') || '/')
export const prefersReducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

function match(routes, fullPath) {
  const [path, qs] = fullPath.split('?')
  const query = Object.fromEntries(new URLSearchParams(qs || ''))
  for (const r of routes) {
    const keys = []
    const re = new RegExp('^' + r.path.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '/?$')
    const m = path.match(re)
    if (m) return { route: r, params: Object.fromEntries(keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])), query, path }
  }
  return { route: routes[routes.length - 1], params: {}, query, path }
}

export function RouterProvider({ routes, defaultVehicle, children }) {
  const [current, setCurrent] = useState(() => ({ ...match(routes, readHash()), key: 'k0' }))
  const [next, setNext] = useState(null)       // { match, vehicle }
  const pendingVehicle = useRef(null)
  const vehicleFor = useRef(defaultVehicle)
  vehicleFor.current = defaultVehicle

  useEffect(() => {
    const onHash = () => {
      const m = match(routes, readHash())
      const vehicle = pendingVehicle.current || vehicleFor.current?.(m) || 'car'
      pendingVehicle.current = null
      if (m.path === current.path && JSON.stringify(m.query) === JSON.stringify(current.query)) return
      setNext({ match: { ...m, key: 'k' + Date.now() }, vehicle })
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [routes, current])

  const navigate = useCallback((to, opts = {}) => {
    if (opts.vehicle) pendingVehicle.current = opts.vehicle
    if (opts.replace) {
      history.replaceState(null, '', '#' + to)
      setCurrent({ ...match(routes, to), key: 'k' + Date.now() })
      return
    }
    if (readHash() === to) return
    window.location.hash = to
  }, [routes])

  const finish = useCallback(() => {
    setCurrent(next.match)
    setNext(null)
    window.scrollTo(0, 0)
  }, [next])

  const value = useMemo(() => ({ ...current, navigate, transitioning: !!next }), [current, navigate, next])
  return <RouterCtx.Provider value={value}>{children({ current, next, finish })}</RouterCtx.Provider>
}

export function Link({ to, vehicle, className, children, ...rest }) {
  const { navigate, path } = useRouter()
  const active = path === to.split('?')[0]
  return (
    <a href={'#' + to} className={[className, active ? 'active' : ''].filter(Boolean).join(' ')} aria-current={active ? 'page' : undefined}
       onClick={(e) => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); navigate(to, { vehicle }) }} {...rest}>
      {children}
    </a>
  )
}

/* ---------------------------------------------------------------------------------------------- */

/* Both pages live side by side under stable keys, so when the transition ends the incoming page
   simply becomes the base layer: no remount, no refetch, no lost state. */
export function Stage({ current, next, finish, render }) {
  const layers = [{ m: current, incoming: false }, next && { m: next.match, incoming: true, vehicle: next.vehicle }].filter(Boolean)
  return (
    <div className="stage">
      {layers.map(({ m, incoming, vehicle }) => (
        <Layer key={m.key} incoming={incoming} vehicle={vehicle} onDone={finish} hidden={!incoming && !!next}>
          <MatchCtx.Provider value={m}>{render(m)}</MatchCtx.Provider>
        </Layer>
      ))}
    </div>
  )
}

function Layer({ incoming, vehicle, onDone, hidden, children }) {
  const pageRef = useRef(null)
  return (
    <>
      <div ref={pageRef} className={incoming ? 'stage-next' : 'stage-layer'} aria-hidden={hidden || undefined}
           style={incoming ? { clipPath: 'inset(0 100% 0 0)' } : undefined}>{children}</div>
      {incoming && <VehicleTransition pageRef={pageRef} vehicle={vehicle} onDone={onDone} />}
    </>
  )
}

export function VehicleTransition({ pageRef, vehicle, onDone }) {
  const carRef = useRef(null)
  const roadRef = useRef(null)
  const v = VEHICLES[vehicle] || VEHICLES.car
  const W = Math.min(v.width * (window.innerWidth < 600 ? 0.75 : 1.1), window.innerWidth * 0.45)

  useLayoutEffect(() => {
    const page = pageRef.current
    if (prefersReducedMotion() || !page.animate) {
      const a = page.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 160 })
      if (a) a.onfinish = onDone; else onDone()
      return () => { if (a) { a.onfinish = null; a.cancel() } }
    }
    const vw = window.innerWidth
    const drive = Math.round(980 * v.speed)
    const ease = 'cubic-bezier(.65,.02,.25,1)'
    const road = roadRef.current.animate(
      [{ transform: 'scaleX(0)', opacity: 1 }, { transform: 'scaleX(1)', opacity: 1, offset: 0.18 },
       { transform: 'scaleX(1)', opacity: 1, offset: 0.82 }, { transform: 'scaleX(1)', opacity: 0 }],
      { duration: drive + 260, easing: 'ease-out', fill: 'forwards' })
    const opts = { duration: drive, delay: 180, easing: ease, fill: 'forwards' }
    const car = carRef.current.animate([{ transform: `translateX(${-W}px)` }, { transform: `translateX(${vw}px)` }], opts)
    // The revealed edge stays under the vehicle body, so the vehicle visibly drags the new page across.
    const reveal = page.animate([{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0% 0 0)' }], opts)
    reveal.onfinish = () => { page.style.clipPath = ''; reveal.cancel(); onDone() }
    return () => { reveal.onfinish = null; [road, car, reveal].forEach((a) => a.cancel()) }   // StrictMode-safe
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={`transit transit-${vehicle}`} aria-hidden="true">
      <div ref={roadRef} className="transit-road" style={vehicle === 'tourist' ? { height: 96, background: '#34302b' } : undefined} />
      <div ref={carRef} className="transit-vehicle" style={{ transform: `translateX(${-W - 50}px)` }}>
        <Vehicle type={vehicle} moving width={W} />
      </div>
    </div>
  )
}
