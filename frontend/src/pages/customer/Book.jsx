import { useEffect, useMemo, useRef, useState } from 'react'
import CityMap from '../../components/CityMap.jsx'
import { Field, Switch, useToast } from '../../components/ui.jsx'
import { Vehicle } from '../../motion/vehicles.jsx'
import { get, post } from '../../api/client.js'
import { useRouter } from '../../lib/router.jsx'
import { useT } from '../../lib/i18n.js'
import { PLACES, makeRoute } from '../../lib/geo.js'
import { rupees } from '../../lib/format.js'
import { setChosenVehicle } from '../../lib/session.jsx'

function PlaceInput({ label, value, onChange, city, saved, onFocus, autoFocus, icon }) {
  const [q, setQ] = useState(value?.address || '')
  const [open, setOpen] = useState(false)
  const [remote, setRemote] = useState([])
  useEffect(() => { setQ(value?.address || '') }, [value])
  useEffect(() => {
    if (!open || q.length < 2) return setRemote([])
    const t = setTimeout(() => get(`/places?q=${encodeURIComponent(q)}&city=${encodeURIComponent(city?.name || '')}`).then(setRemote).catch(() => setRemote([])), 220)
    return () => clearTimeout(t)
  }, [q, open, city])
  const local = useMemo(() => (PLACES[city?.name] || []).map(([address, lat, lng]) => ({ address, lat, lng }))
    .filter((p) => !q || p.address.toLowerCase().includes(q.toLowerCase())), [q, city])
  const options = [...saved.map((s) => ({ ...s, address: s.address, tag: s.label })), ...remote, ...local]
    .filter((p, i, a) => a.findIndex((x) => x.address === p.address) === i).slice(0, 8)
  return (
    <div style={{ position: 'relative' }}>
      <label className="place-field">
        <span className="place-icon" aria-hidden="true">{icon}</span>
        <span className="sr-only">{label}</span>
        <input className="input" placeholder={label} value={q} autoFocus={autoFocus} role="combobox" aria-expanded={open} aria-autocomplete="list"
               onFocus={() => { setOpen(true); onFocus?.() }} onBlur={() => setTimeout(() => setOpen(false), 160)}
               onChange={(e) => { setQ(e.target.value); setOpen(true) }} />
      </label>
      {open && options.length > 0 && (
        <ul className="suggest" role="listbox">
          {options.map((p) => (
            <li key={p.address} role="option" aria-selected={false} onMouseDown={() => { onChange(p); setQ(p.address); setOpen(false) }}>
              {p.tag && <span className="chip">{p.tag}</span>} {p.address}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default function Book() {
  const t = useT()
  const toast = useToast()
  const { navigate, query } = useRouter()
  const [cities, setCities] = useState([])
  const [city, setCity] = useState(null)
  const [saved, setSaved] = useState([])
  const [pickup, setPickup] = useState(null)
  const [drop, setDrop] = useState(null)
  const [pickTarget, setPickTarget] = useState('drop')
  const [scheduled, setScheduled] = useState(false)
  const [when, setWhen] = useState('')
  const [quote, setQuote] = useState(null)
  const [loading, setLoading] = useState(false)
  const [sel, setSel] = useState(query.category || 'auto')
  const [pay, setPay] = useState('cash')
  const [coupon, setCoupon] = useState('')
  const [coupons, setCoupons] = useState([])
  const [showBreakdown, setShowBreakdown] = useState(false)
  const [booking, setBooking] = useState(false)
  const quoteSeq = useRef(0)

  useEffect(() => {
    get('/cities').then((cs) => {
      setCities(cs)
      const c = cs.find((x) => x.name === 'Chennai') || cs[0]
      setCity(c)
      const fallback = { address: (PLACES[c.name]?.[2]?.[0]) || `${c.name} centre`, lat: PLACES[c.name]?.[2]?.[1] ?? c.center[0], lng: PLACES[c.name]?.[2]?.[2] ?? c.center[1] }
      setPickup(fallback)
      if (query.drop) {
        const want = query.drop.toLowerCase().replace(/^(to|till)\s+/, '').trim()
        const m = (PLACES[c.name] || []).find(([n]) => n.toLowerCase().includes(want) || want.includes(n.toLowerCase().split(/[,(]/)[0].trim()))
        if (m) setDrop({ address: m[0], lat: m[1], lng: m[2] })
      }
    })
    get('/auth/addresses').then(setSaved).catch(() => {})
    get('/coupons').then(setCoupons).catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const useMyLocation = () => {
    if (!navigator.geolocation) return toast('Location is not available on this device.')
    navigator.geolocation.getCurrentPosition(
      (pos) => setPickup({ address: 'Current location', lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => toast('Allow location access, or choose a pickup point.'), { enableHighAccuracy: true, timeout: 8000 })
  }

  useEffect(() => {
    if (!pickup || !drop) { setQuote(null); return }
    const seq = ++quoteSeq.current
    setLoading(true)
    post('/rides/quote', { pickup_lat: pickup.lat, pickup_lng: pickup.lng, drop_lat: drop.lat, drop_lng: drop.lng,
                           scheduled_for: scheduled && when ? new Date(when).toISOString() : null })
      .then((q) => { if (seq !== quoteSeq.current) return
        setQuote(q)
        if (!q.options.some((o) => o.category === sel) && q.options[0]) setSel(q.options[0].category) })
      .catch((e) => { setQuote(null); toast(e.detail || e.message, 'bad') })
      .finally(() => seq === quoteSeq.current && setLoading(false))
  }, [pickup, drop, scheduled, when]) // eslint-disable-line react-hooks/exhaustive-deps

  const option = quote?.options.find((o) => o.category === sel)
  const route = useMemo(() => quote?.route || (pickup && drop ? makeRoute(pickup, drop) : null), [quote, pickup, drop])

  const confirm = async () => {
    setBooking(true)
    try {
      const r = await post('/rides', { quote_token: option.quote_token, pickup_address: pickup.address, drop_address: drop.address, payment_method: pay,
                                       scheduled_for: scheduled && when ? new Date(when).toISOString() : null, coupon_code: coupon || null })
      setChosenVehicle(sel)
      navigate(`/ride/${r.id}`, { vehicle: sel })
    } catch (e) { toast(e.detail || e.message, 'bad') } finally { setBooking(false) }
  }

  const minWhen = new Date(Date.now() + 25 * 6e4 - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 16)

  return (
    <div className="book">
      <div className="book-map">
        {city && <CityMap center={{ lat: city.center[0], lng: city.center[1] }} pickup={pickup} drop={drop} route={drop ? route : null} vehicle={sel} height="100%" insetLeft={typeof window !== 'undefined' && window.innerWidth > 760 ? 0.45 : 0}
                          label="Tap the map to set your pickup or drop" onPick={(p) => {
                            const pt = { address: `Pinned location (${p.lat.toFixed(4)}, ${p.lng.toFixed(4)})`, ...p }
                            pickTarget === 'pickup' ? setPickup(pt) : setDrop(pt)
                          }} />}
        <div className="map-hint glass small">Tap the map to set your <strong>{pickTarget === 'pickup' ? 'pickup' : 'drop'}</strong></div>
      </div>

      <section className="book-panel glass" aria-label={t('book')}>
        <div className="row between">
          <h1 style={{ fontSize: 'var(--t-2xl)' }}>{t('whereTo')}</h1>
          <select className="input" style={{ width: 'auto' }} value={city?.id || ''} aria-label="City"
                  onChange={(e) => { const c = cities.find((x) => x.id === Number(e.target.value)); setCity(c); setDrop(null)
                    const p = PLACES[c.name]?.[0]; setPickup(p ? { address: p[0], lat: p[1], lng: p[2] } : { address: `${c.name} centre`, lat: c.center[0], lng: c.center[1] }) }}>
            {cities.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>

        <div className="trip-inputs">
          <PlaceInput label={t('pickup')} value={pickup} onChange={setPickup} city={city} saved={saved} onFocus={() => setPickTarget('pickup')}
                      icon={<span className="pin-dot" />} />
          <PlaceInput label={t('drop')} value={drop} onChange={setDrop} city={city} saved={saved} onFocus={() => setPickTarget('drop')} autoFocus={!query.drop}
                      icon={<span className="pin-sq" />} />
          <div className="row between">
            <button className="btn ghost sm" type="button" onClick={useMyLocation}>{t('useLocation')}</button>
            <label className="row small" style={{ gap: 8 }}>{t('schedule')} <Switch checked={scheduled} onChange={setScheduled} label="Schedule for later" /></label>
          </div>
          {scheduled && <Field label="Pickup time" hint="At least 20 minutes from now."><input type="datetime-local" className="input" min={minWhen} value={when} onChange={(e) => setWhen(e.target.value)} /></Field>}
        </div>

        {!drop && saved.length > 0 && (
          <div className="row wrap">{saved.map((s) => <button key={s.id} className="btn ghost sm" onClick={() => setDrop(s)}>{s.label}</button>)}</div>
        )}

        {loading && <div className="stack">{[0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 74 }} />)}</div>}

        {!loading && quote && (
          <>
            <div className="stack" role="radiogroup" aria-label="Vehicle">
              {quote.options.length === 0 && <p className="muted">No vehicles are running for this trip right now.</p>}
              {quote.options.map((o) => (
                <button key={o.category} role="radio" aria-checked={sel === o.category} className={`veh-option ${sel === o.category ? 'on' : ''}`}
                        onClick={() => { setSel(o.category); setChosenVehicle(o.category) }}>
                  <div className="veh-art"><Vehicle type={o.category} moving={sel === o.category} width={o.category === 'tourist' ? 92 : 76} /></div>
                  <div style={{ textAlign: 'left' }}>
                    <strong>{o.name}</strong> <span className="muted small">· {o.seats} seat{o.seats > 1 ? 's' : ''}</span>
                    <div className="small muted">{o.eta_pickup_min ? `${o.eta_pickup_min} min away` : 'Few drivers nearby'} · {o.duration_min} min trip</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div className="num">{Number(o.estimate_low) === Number(o.estimate_high) ? rupees(o.estimate_low) : `${rupees(o.estimate_low)}–${rupees(o.estimate_high).replace('₹', '')}`}</div>
                    {o.peak && <span className="chip warn">Peak</span>}
                  </div>
                </button>
              ))}
            </div>

            {option && (
              <>
                <div className="row between small">
                  <span className="muted">{t('estimate')} for {option.distance_km} km</span>
                  <button className="btn ghost sm" onClick={() => setShowBreakdown((x) => !x)} aria-expanded={showBreakdown}>{showBreakdown ? 'Hide' : 'How it’s calculated'}</button>
                </div>
                {showBreakdown && (
                  <div className="tile small stack" style={{ gap: 6 }}>
                    {option.breakdown.lines.map((l) => <div key={l.label} className="row between"><span>{l.label}</span><span>{rupees(l.amount, true)}</span></div>)}
                    <hr className="divider" />
                    <p className="tiny muted">{quote.note}</p>
                  </div>
                )}
                <div className="row" role="radiogroup" aria-label="Payment">
                  {[['cash', t('cash')], ['online', t('online')]].map(([v, l]) => (
                    <button key={v} role="radio" aria-checked={pay === v} className={`btn sm ${pay === v ? '' : 'ghost'}`} onClick={() => setPay(v)}>{l}</button>
                  ))}
                  <input className="input grow" style={{ padding: '7px 12px' }} placeholder={t('coupon')} value={coupon} onChange={(e) => setCoupon(e.target.value.toUpperCase())} aria-label={t('coupon')} />
                </div>
                {coupons.length > 0 && !coupon && (
                  <div className="row wrap small">{coupons.slice(0, 3).map((c) => <button key={c.code} className="chip" style={{ border: 0, cursor: 'pointer' }} onClick={() => setCoupon(c.code)}>{c.code}: {c.description}</button>)}</div>
                )}
                <button className="btn lg block" onClick={confirm} disabled={booking || (scheduled && !when)}>
                  {booking ? 'Booking…' : scheduled ? 'Schedule ride' : `${t('confirm')} · ${option.name}`}
                </button>
                <p className="tiny muted" style={{ textAlign: 'center' }}>Free cancellation for 15 minutes after booking.</p>
              </>
            )}
          </>
        )}
      </section>

      <style>{`
        .book { position: relative; height: calc(100vh - 150px); min-height: 640px; }
        .book-map { position: absolute; inset: 0; border-radius: var(--r-lg); overflow: hidden; box-shadow: var(--shadow-1); }
        .map-hint { position: absolute; right: 16px; top: 16px; padding: 8px 14px; border-radius: 99px; }
        .book-panel { position: absolute; top: 16px; left: 16px; bottom: 16px; width: min(440px, calc(100% - 32px)); padding: 22px; overflow: auto; display: grid; gap: 16px; align-content: start; }
        .trip-inputs { display: grid; gap: 10px; }
        .place-field { display: flex; align-items: center; gap: 10px; }
        .place-icon { width: 18px; display: grid; place-items: center; }
        .pin-dot { width: 12px; height: 12px; border-radius: 50%; background: var(--sage-deep); box-shadow: 0 0 0 4px rgba(126,129,116,.25); }
        .pin-sq { width: 12px; height: 12px; border-radius: 3px; background: var(--accent); }
        .suggest { position: absolute; z-index: 20; left: 28px; right: 0; top: 100%; margin: 4px 0 0; padding: 6px; list-style: none; background: var(--paper);
          border-radius: 14px; box-shadow: var(--shadow-2); max-height: 280px; overflow: auto; }
        .suggest li { padding: 10px 12px; border-radius: 10px; cursor: pointer; font-size: var(--t-sm); }
        .suggest li:hover { background: var(--cream-soft); }
        .veh-option { display: grid; grid-template-columns: 96px 1fr auto; gap: 12px; align-items: center; padding: 10px 14px; border-radius: 18px; border: 1.5px solid transparent;
          background: rgba(255,255,255,.55); cursor: pointer; transition: border-color .2s, background .2s, transform .2s var(--ease-out); }
        .veh-option:hover { transform: translateX(3px); }
        .veh-option.on { border-color: var(--accent); background: var(--paper); }
        .veh-option.on .veh-art > div { animation: pullup .6s var(--ease-out); }
        @keyframes pullup { from { transform: translateX(-30px); opacity: .3 } }
        .veh-art { display: grid; place-items: center; }
        @media (max-width: 760px) {
          .book { height: auto; min-height: 0; display: grid; gap: 12px; }
          .book-map { position: relative; height: 300px; }
          .book-panel { position: relative; inset: auto; width: 100%; }
        }
      `}</style>
    </div>
  )
}
