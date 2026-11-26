import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import CityMap from '../../components/CityMap.jsx'
import { Loader, Modal, Tick, useToast } from '../../components/ui.jsx'
import { Vehicle } from '../../motion/vehicles.jsx'
import { DEMO, get, post, subscribe } from '../../api/client.js'
import { useRouter, Link } from '../../lib/router.jsx'
import { useT } from '../../lib/i18n.js'
import { makeRoute, haversineKm } from '../../lib/geo.js'
import { rupees, statusLabel, time } from '../../lib/format.js'

const STEPS = ['searching', 'assigned', 'arrived', 'in_progress', 'completed']

export default function Ride() {
  const { params, navigate } = useRouter()
  const t = useT()
  const toast = useToast()
  const [ride, setRide] = useState(null)
  const [driverPos, setDriverPos] = useState(null)
  const [sheet, setSheet] = useState(null)   // 'cancel' | 'chat' | 'call' | 'sos'
  const load = useCallback(() => get(`/rides/${params.id}`).then((r) => { setRide(r); if (r.driver?.lat) setDriverPos((p) => p || { lat: r.driver.lat, lng: r.driver.lng }) }), [params.id])

  useEffect(() => {
    load()
    const off = subscribe(`ride:${params.id}`, (m) => {
      if (m.event === 'driver.location') setDriverPos({ lat: m.data.lat, lng: m.data.lng })
      if (m.event === 'ride.status') load()
    })
    const poll = setInterval(load, 8000)
    return () => { off(); clearInterval(poll) }
  }, [params.id, load])

  const route = useMemo(() => ride ? (ride.route || makeRoute(ride.pickup, ride.drop)) : null, [ride])
  if (!ride) return <Loader label="Loading your ride" />
  const step = STEPS.indexOf(ride.status)
  const live = ['assigned', 'arrived', 'in_progress'].includes(ride.status)
  const approach = ride.status === 'assigned' && driverPos ? makeRoute(driverPos, ride.pickup, 12) : null
  const eta = driverPos && ride.status === 'assigned' ? Math.max(1, Math.round(haversineKm(driverPos, ride.pickup) * 1.3 / 20 * 60)) : null

  return (
    <div className="ride-grid">
      <div className="ride-map">
        <CityMap center={ride.pickup} pickup={ride.pickup} drop={ride.drop} route={ride.status === 'assigned' ? approach : route}
                 driver={live ? driverPos : null} vehicle={ride.category} height="100%" label="Live trip map" />
        {ride.status === 'searching' && <Radar />}
      </div>

      <section className="ride-panel stack lg" aria-live="polite">
        <div>
          <div className="row between"><span className="chip">{ride.code}</span><span className="small muted">{ride.category_name}</span></div>
          <h1 style={{ fontSize: 'var(--t-2xl)', marginTop: 10 }}>{statusLabel[ride.status]}</h1>
          {eta && <p className="muted">Arriving in about {eta} min</p>}
          {ride.status === 'scheduled' && <p className="muted">We’ll start looking for a driver 15 minutes before {time(ride.scheduled_for)}.</p>}
        </div>

        {step >= 0 && ride.status !== 'completed' && (
          <ol className="progress" aria-label="Trip progress">
            {['Booked', 'Driver assigned', 'Arrived', 'On trip', 'Done'].map((l, i) => <li key={l} className={i <= step ? 'on' : ''}><span className="sr-only">{i <= step ? 'Done: ' : ''}</span>{l}</li>)}
          </ol>
        )}

        {ride.status === 'searching' && (
          <div className="tile stack">
            <Loader type={ride.category} label={t('searching')} />
            <button className="btn ghost" onClick={() => setSheet('cancel')}>{t('cancelRide')}</button>
          </div>
        )}

        {ride.driver && live && (
          <div className="panel stack">
            <div className="row">
              <div className="avatar">{ride.driver.name.split(' ').map((p) => p[0]).join('').slice(0, 2)}</div>
              <div className="grow">
                <strong>{ride.driver.name}</strong>
                <div className="small muted">★ {ride.driver.rating} · {ride.driver.tier}</div>
              </div>
              <Vehicle type={ride.category} width={84} />
            </div>
            <div className="tile row between">
              <div><div className="num" style={{ fontSize: 'var(--t-lg)' }}>{ride.driver.vehicle?.reg}</div><div className="small muted">{ride.driver.vehicle?.colour} {ride.driver.vehicle?.make} {ride.driver.vehicle?.model}</div></div>
              {ride.otp && <div style={{ textAlign: 'right' }}><div className="tiny muted">OTP</div><div className="num otp">{ride.otp}</div></div>}
            </div>
            {ride.otp && <p className="small muted">{t('otp')}</p>}
            <div className="grid-3">
              <button className="btn sage" onClick={() => setSheet('call')}>{t('callDriver')}</button>
              <button className="btn sage" onClick={() => setSheet('chat')}>{t('chat')}</button>
              <button className="btn danger" onClick={() => setSheet('sos')}>{t('sos')}</button>
            </div>
            <div className="row between">
              <button className="btn ghost sm" onClick={() => { navigator.clipboard?.writeText(`${location.origin}/#/ride/${ride.id}`); toast('Trip link copied. Share it with family.') }}>Share trip</button>
              {ride.status !== 'in_progress' && <button className="btn ghost sm" onClick={() => setSheet('cancel')}>{t('cancelRide')}</button>}
            </div>
            {DEMO && ride.status === 'arrived' && <DemoStart ride={ride} onStarted={load} />}
          </div>
        )}

        {live && (
          <div className="tile small stack" style={{ gap: 6 }}>
            <div className="row between"><span className="muted">{t('estimate')}</span><span className="num">{rupees(ride.estimate.low)} – {rupees(ride.estimate.high)}</span></div>
            <div className="row between"><span className="muted">Payment</span><span>{ride.payment_method === 'cash' ? 'Cash to driver' : 'UPI / Card after the trip'}</span></div>
            <div className="row between"><span className="muted">Drop</span><span style={{ textAlign: 'right' }}>{ride.drop.address}</span></div>
          </div>
        )}

        {ride.status === 'completed' && <Completed ride={ride} reload={load} />}

        {['cancelled', 'no_driver'].includes(ride.status) && (
          <div className="panel stack">
            <p>{ride.status === 'no_driver' ? 'No driver accepted in time. You were not charged.' : 'This ride was cancelled.'}</p>
            <button className="btn" onClick={() => navigate('/book')}>Book again</button>
          </div>
        )}
      </section>

      {sheet === 'cancel' && <CancelSheet ride={ride} onClose={() => setSheet(null)} onDone={load} />}
      {sheet === 'chat' && <ChatSheet ride={ride} onClose={() => setSheet(null)} />}
      {sheet === 'call' && <CallSheet ride={ride} onClose={() => setSheet(null)} />}
      {sheet === 'sos' && <SosSheet ride={ride} onClose={() => setSheet(null)} />}

      <style>{`
        .ride-grid { display: grid; grid-template-columns: 1.5fr 1fr; gap: 20px; min-height: calc(100vh - 150px); }
        .ride-map { position: relative; border-radius: var(--r-lg); overflow: hidden; min-height: 420px; }
        .ride-panel { align-content: start; }
        .avatar { width: 48px; height: 48px; border-radius: 50%; background: var(--accent); color: var(--cream); display: grid; place-items: center; font-weight: 700; font-family: var(--font-display); }
        .otp { font-size: var(--t-2xl); letter-spacing: .18em; color: var(--accent); }
        .progress { list-style: none; padding: 0; margin: 0; display: grid; grid-template-columns: repeat(5, 1fr); gap: 4px; font-size: var(--t-xs); color: var(--ink-soft); }
        .progress li { border-top: 4px solid var(--sage); padding-top: 6px; transition: border-color .6s var(--ease-out); }
        .progress li.on { border-color: var(--accent); color: var(--ink); font-weight: 600; }
        @media (max-width: 900px) { .ride-grid { grid-template-columns: 1fr; } .ride-map { height: 340px; min-height: 0; } }
      `}</style>
    </div>
  )
}

function Radar() {
  return (
    <div aria-hidden="true" style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', pointerEvents: 'none' }}>
      {[0, 1, 2].map((i) => <span key={i} style={{ position: 'absolute', width: 160, height: 160, borderRadius: '50%', border: '2px solid var(--accent)', animation: `radar 2.4s ${i * 0.8}s var(--ease-out) infinite` }} />)}
      <style>{'@keyframes radar { from { transform: scale(.2); opacity: .8 } to { transform: scale(2.6); opacity: 0 } }'}</style>
    </div>
  )
}

function DemoStart({ ride, onStarted }) {
  // Demo only: there is no second phone, so the rider can play the driver entering the OTP.
  const start = () => { window.dispatchEvent(new CustomEvent('vy-demo-start', { detail: ride.id })); setTimeout(onStarted, 300) }
  return <button className="btn ghost sm" onClick={start}>Demo: driver enters OTP {ride.otp}</button>
}

function CancelSheet({ ride, onClose, onDone }) {
  const [preview, setPreview] = useState(null)
  const [reason, setReason] = useState('Plans changed')
  const toast = useToast()
  useEffect(() => { get(`/rides/${ride.id}/cancel-preview`).then(setPreview) }, [ride.id])
  const go = async () => {
    try { const r = await post(`/rides/${ride.id}/cancel`, { reason }); toast(r.cancellation.fee ? `Cancelled. Fee ₹${r.cancellation.fee}.` : 'Ride cancelled. No charge.'); onDone(); onClose() }
    catch (e) { toast(e.detail || e.message, 'bad') }
  }
  return (
    <Modal title="Cancel this ride?" onClose={onClose}>
      {!preview ? <Loader /> : (
        <div className="stack">
          <div className="tile">
            {preview.free ? <><strong>No cancellation fee</strong><p className="small muted">You can cancel free for another {Math.ceil(preview.minutes_left_free)} min.</p></>
                          : <><strong>A ₹{preview.fee_if_cancelled} fee applies</strong><p className="small muted">The free 15-minute window after booking has passed. The fee goes to the driver who was on the way.</p></>}
          </div>
          <div className="stack" role="radiogroup" aria-label="Reason">
            {['Plans changed', 'Driver is too far', 'Driver asked me to cancel', 'Booked by mistake', 'Found another ride'].map((r) => (
              <label key={r} className="row small"><input type="radio" name="reason" checked={reason === r} onChange={() => setReason(r)} /> {r}</label>
            ))}
          </div>
          <div className="row"><button className="btn ghost grow" onClick={onClose}>Keep ride</button><button className="btn danger grow" onClick={go}>Cancel ride</button></div>
        </div>
      )}
    </Modal>
  )
}

function ChatSheet({ ride, onClose }) {
  const [msgs, setMsgs] = useState([])
  const [text, setText] = useState('')
  const end = useRef(null)
  const load = useCallback(() => get(`/rides/${ride.id}/messages`).then(setMsgs), [ride.id])
  useEffect(() => { load(); return subscribe(`ride:${ride.id}`, (m) => m.event === 'chat' && load()) }, [ride.id, load])
  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }) }, [msgs])
  const send = async (b) => { if (!b.trim()) return; setText(''); await post(`/rides/${ride.id}/messages`, { body: b }); load() }
  return (
    <Modal title={`Chat with ${ride.driver?.name?.split(' ')[0] || 'driver'}`} onClose={onClose}>
      <div className="stack" style={{ maxHeight: 320, overflow: 'auto', padding: 4 }}>
        {msgs.length === 0 && <p className="muted small">Messages are only visible to you and your driver during this trip.</p>}
        {msgs.map((m) => <div key={m.id} className="bubble" data-mine={m.mine}>{m.body}<span className="tiny muted"> {time(m.at)}</span></div>)}
        <div ref={end} />
      </div>
      <div className="row wrap" style={{ margin: '10px 0' }}>{['I’m at the pickup point', 'Where are you?', 'Please come to the main gate'].map((q) => <button key={q} className="chip" style={{ border: 0, cursor: 'pointer' }} onClick={() => send(q)}>{q}</button>)}</div>
      <form className="row" onSubmit={(e) => { e.preventDefault(); send(text) }}>
        <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Type a message" aria-label="Message" maxLength={500} />
        <button className="btn">Send</button>
      </form>
      <style>{'.bubble { max-width: 80%; padding: 10px 14px; border-radius: 16px; background: var(--cream-soft); } .bubble[data-mine="true"] { margin-left: auto; background: var(--accent); color: var(--accent-ink); } .bubble[data-mine="true"] .muted { color: rgba(246,233,216,.7) }'}</style>
    </Modal>
  )
}

function CallSheet({ ride, onClose }) {
  const [res, setRes] = useState(null)
  const [error, setError] = useState('')
  useEffect(() => { post(`/rides/${ride.id}/call`).then(setRes).catch((e) => setError(e.detail || e.message)) }, [ride.id])
  return (
    <Modal title="Private call" onClose={onClose}>
      {error ? <p className="error-text">{error}</p> : !res ? <Loader label="Connecting" /> : (
        <div className="stack" style={{ textAlign: 'center' }}>
          <div className="num" style={{ fontSize: 'var(--t-2xl)' }}>{res.virtual_number}</div>
          <p className="muted">{res.message}</p>
          <p className="tiny muted">The number works from driver assignment until 30 minutes after your trip. Calls are not recorded.</p>
          <a className="btn" href={`tel:${res.virtual_number.replace(/\s/g, '')}`}>Call now</a>
        </div>
      )}
    </Modal>
  )
}

function SosSheet({ ride, onClose }) {
  const [res, setRes] = useState(null)
  const [holding, setHolding] = useState(false)
  const timer = useRef(null)
  const trigger = () => post(`/rides/${ride.id}/sos`).then(setRes)
  return (
    <Modal title="Emergency help" onClose={onClose}>
      {res ? (
        <div className="stack">
          <Tick />
          <p><strong>{res.message}</strong></p>
          <p className="small muted">Safety ticket {res.ticket}</p>
          <div className="row wrap">
            <a className="btn danger" href={`tel:${res.helplines.police}`}>Call police {res.helplines.police}</a>
            <a className="btn ghost" href={`tel:${res.helplines.women_helpline}`}>Women helpline {res.helplines.women_helpline}</a>
          </div>
        </div>
      ) : (
        <div className="stack" style={{ textAlign: 'center' }}>
          <p className="muted">Press and hold for 2 seconds. We’ll alert the VAYORA safety desk and your emergency contacts with your live location.</p>
          <button className="sos-btn" aria-label="Hold to send SOS"
                  onPointerDown={() => { setHolding(true); timer.current = setTimeout(trigger, 2000) }}
                  onPointerUp={() => { setHolding(false); clearTimeout(timer.current) }} onPointerLeave={() => { setHolding(false); clearTimeout(timer.current) }}
                  onKeyDown={(e) => e.key === 'Enter' && trigger()} data-holding={holding}>SOS</button>
          <a className="small" href="tel:112">Or call 112 directly</a>
        </div>
      )}
      <style>{`.sos-btn { width: 150px; height: 150px; margin: 10px auto; border-radius: 50%; border: 0; background: var(--bad); color: #fff; font: 800 2rem var(--font-display); cursor: pointer;
        box-shadow: 0 0 0 0 rgba(158,42,34,.5); transition: box-shadow 2s linear; } .sos-btn[data-holding="true"] { box-shadow: 0 0 0 40px rgba(158,42,34,.18); }`}</style>
    </Modal>
  )
}

function Completed({ ride, reload }) {
  const toast = useToast()
  const [stars, setStars] = useState(0)
  const [tags, setTags] = useState([])
  const [comment, setComment] = useState('')
  const [fav, setFav] = useState(false)
  const [paid, setPaid] = useState(ride.payment_status === 'paid')
  const [rated, setRated] = useState(ride.rated)
  const finalTotal = Number(ride.final.total) - Number(ride.final.discount || 0)
  const inRange = finalTotal <= Number(ride.estimate.high)
  const payNow = async () => {
    const order = await post(`/payments/rides/${ride.id}/order`)
    if (order.dev_mode || !window.Razorpay) {
      await post('/payments/verify', { ride_id: ride.id, razorpay_order_id: order.order_id, razorpay_payment_id: 'pay_dev', razorpay_signature: 'dev' })
      setPaid(true); reload(); return
    }
    new window.Razorpay({ key: order.key_id, order_id: order.order_id, amount: order.amount_paise, currency: 'INR', name: 'VAYORA', theme: { color: '#650907' },
      handler: async (r) => { await post('/payments/verify', r); setPaid(true); reload() } }).open()
  }
  const rate = async () => {
    try { await post(`/rides/${ride.id}/rate`, { stars, tags, comment: comment || null, favourite: fav }); setRated(true); toast('Thanks for rating your trip.') }
    catch (e) { toast(e.detail || e.message, 'bad') }
  }
  return (
    <div className="stack lg">
      <div className="panel stack">
        <div className="row"><Tick size={56} /><div><strong>You’ve arrived</strong><div className="small muted">{ride.drop.address}</div></div></div>
        <div className="grid-2">
          <div className="tile"><div className="tiny muted">Estimated</div><div className="num">{rupees(ride.estimate.low)} – {rupees(ride.estimate.high)}</div></div>
          <div className="tile" style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}><div className="tiny" style={{ opacity: .8 }}>Final fare</div><div className="num" style={{ fontSize: 'var(--t-xl)' }}>{rupees(finalTotal, true)}</div></div>
        </div>
        <p className="small muted">{inRange ? 'Your final fare is within the estimate.' : 'Your final fare is above the estimate because the trip took longer or included extra charges. See the breakdown below.'}</p>
        <details><summary className="small">Fare breakdown</summary>
          <div className="stack small" style={{ gap: 6, marginTop: 8 }}>
            {ride.final.breakdown.lines.map((l) => <div key={l.label} className="row between"><span>{l.label}</span><span>{rupees(l.amount, true)}</span></div>)}
            {Number(ride.final.discount) > 0 && <div className="row between"><span>Coupon</span><span>−{rupees(ride.final.discount, true)}</span></div>}
          </div>
        </details>
        {ride.payment_method === 'online' && !paid && <button className="btn lg block" onClick={payNow}>Pay {rupees(finalTotal, true)}</button>}
        {paid && ride.payment_method === 'online' && <span className="chip good">Paid online</span>}
        {ride.payment_method === 'cash' && <span className="chip">Pay {rupees(finalTotal)} in cash to your driver</span>}
        <Link to={`/rides?receipt=${ride.id}`} className="small">View receipt</Link>
      </div>
      {!rated ? (
        <div className="panel stack">
          <h3>Rate {ride.driver?.name?.split(' ')[0]}</h3>
          <div className="row" role="radiogroup" aria-label="Stars">
            {[1, 2, 3, 4, 5].map((s) => <button key={s} role="radio" aria-checked={stars === s} aria-label={`${s} star${s > 1 ? 's' : ''}`} onClick={() => setStars(s)}
              style={{ fontSize: 34, background: 'none', border: 0, cursor: 'pointer', color: s <= stars ? 'var(--accent)' : 'var(--sage)', transition: 'transform .2s', transform: s <= stars ? 'scale(1.1)' : 'none' }}>★</button>)}
          </div>
          {stars > 0 && (
            <>
              <div className="row wrap">{(stars >= 4 ? ['Punctual', 'Clean vehicle', 'Safe driving', 'Friendly', 'Knew the route'] : ['Late pickup', 'Rash driving', 'Unclean vehicle', 'Rude behaviour', 'Longer route']).map((x) => (
                <button key={x} className={`chip ${tags.includes(x) ? 'accent' : ''}`} style={{ border: 0, cursor: 'pointer' }} onClick={() => setTags((t) => t.includes(x) ? t.filter((y) => y !== x) : [...t, x])}>{x}</button>))}
              </div>
              <textarea className="input" rows={2} placeholder="Anything else? (optional)" value={comment} onChange={(e) => setComment(e.target.value)} />
              <label className="row small"><input type="checkbox" checked={fav} onChange={(e) => setFav(e.target.checked)} /> Add to favourite drivers</label>
              <button className="btn" onClick={rate}>Submit rating</button>
            </>
          )}
        </div>
      ) : <p className="muted small">Thanks for your rating.</p>}
    </div>
  )
}
