import { useCallback, useEffect, useMemo, useState } from 'react'
import { PageHead } from '../../components/Layouts.jsx'
import CityMap from '../../components/CityMap.jsx'
import { BarChart, Counter, Empty, Field, Loader, Meter, Modal, Ring, Stat, Switch, Tick, useToast } from '../../components/ui.jsx'
import { Vehicle } from '../../motion/vehicles.jsx'
import { DEMO, download, get, post, subscribe } from '../../api/client.js'
import { useSession } from '../../lib/session.jsx'
import { makeRoute } from '../../lib/geo.js'
import { date, dateTime, plural, rupees, titleCase } from '../../lib/format.js'

const CHENNAI = { lat: 13.0827, lng: 80.2707 }

/* ================================================================== Drive (dashboard) */
export function Drive() {
  const toast = useToast()
  const { user } = useSession()
  const [online, setOnline] = useState(false)
  const [offer, setOffer] = useState(null)
  const [ride, setRide] = useState(null)
  const [today, setToday] = useState(null)
  const [onb, setOnb] = useState(null)
  const [done, setDone] = useState(null)
  const [pos, setPos] = useState({ lat: CHENNAI.lat + 0.004, lng: CHENNAI.lng + 0.006 })

  const refresh = useCallback(() => { get('/driver/current').then(setRide); get('/driver/earnings').then((e) => setToday(e.today)) }, [])
  useEffect(() => { refresh(); get('/driver/onboarding').then(setOnb) }, [refresh])
  useEffect(() => subscribe(`user:${user.id}`, (m) => { if (m.event === 'ride.offer') setOffer({ ...m.data, received: Date.now() }) }), [user.id])

  // Share location every 10 s while online (real GPS when available).
  useEffect(() => {
    if (!online || DEMO) return
    const send = () => navigator.geolocation?.getCurrentPosition((p) => {
      const c = { lat: p.coords.latitude, lng: p.coords.longitude }; setPos(c); post('/driver/location', c).catch(() => {}) })
    send(); const iv = setInterval(send, 10000); return () => clearInterval(iv)
  }, [online])

  const toggle = async (v) => {
    try { const r = await post('/driver/status', { online: v, ...pos }); setOnline(r.online); toast(r.online ? 'You are online. Requests will appear here.' : 'You are offline.') }
    catch (e) { toast(e.detail || e.message, 'bad') }
  }
  const accept = async () => { try { setRide(await post(`/driver/rides/${offer.ride_id}/accept`)); setOffer(null) } catch (e) { toast(e.detail || e.message, 'bad'); setOffer(null) } }
  const reject = async () => { await post(`/driver/rides/${offer.ride_id}/reject`); setOffer(null) }

  if (onb && onb.status !== 'approved') return (
    <Empty title={onb.status === 'submitted' ? 'Your documents are being verified' : 'Finish your registration'} action={<a className="btn" href="#/driver/onboarding">Go to documents</a>}>
      {onb.status === 'submitted' ? 'Our team usually verifies new drivers within 24 hours. We’ll notify you as soon as you can go online.' : 'Upload your documents and bank details so we can verify your account.'}
    </Empty>)

  return (
    <div className="drive-grid">
      <section className="stack lg">
        <div className={`panel online-card ${online ? 'on' : ''}`}>
          <div className="row between">
            <div><div className="small" style={{ opacity: .8 }}>{online ? 'You are online' : 'You are offline'}</div>
              <h2 style={{ fontSize: 'var(--t-2xl)' }}>{online ? 'Looking for riders' : 'Go online to get rides'}</h2></div>
            <Switch checked={online} onChange={toggle} label="Online" />
          </div>
          {online && !ride && !offer && <div className="scan" aria-hidden="true"><span /></div>}
        </div>

        {today && (
          <div className="grid-3">
            <Stat label="Today’s earnings" value={today.earnings} format={(n) => rupees(n)} tone="accent" />
            <Stat label="Trips" value={today.rides} />
            <Stat label="Cash collected" value={today.cash_collected} format={(n) => rupees(n)} />
          </div>
        )}

        {offer && <OfferCard offer={offer} onAccept={accept} onReject={reject} />}
        {ride && <ActiveTrip ride={ride} setRide={setRide} onDone={(r) => { setRide(null); setDone(r); refresh() }} />}
        {done && (
          <Modal title="Trip completed" onClose={() => setDone(null)}>
            <div className="stack" style={{ justifyItems: 'center', textAlign: 'center' }}>
              <Tick />
              <div className="num" style={{ fontSize: 'var(--t-3xl)', color: 'var(--accent)' }}>{rupees(done.earning.driver_earnings, true)}</div>
              <p className="muted small">Your earnings for {done.code}</p>
              <div className="tile small stack" style={{ width: '100%', gap: 6 }}>
                <div className="row between"><span>Ride fare</span><span>{rupees(done.earning.ride_fare, true)}</span></div>
                <div className="row between"><span>VAYORA commission ({Math.round(done.earning.commission_rate * 100)}%)</span><span>−{rupees(done.earning.commission, true)}</span></div>
                {Number(done.earning.driver_earnings) - (Number(done.earning.ride_fare) - Number(done.earning.commission)) > 0.004 && (
                  <div className="row between"><span>Tolls & parking (100% yours)</span><span>+{rupees(Number(done.earning.driver_earnings) - (Number(done.earning.ride_fare) - Number(done.earning.commission)), true)}</span></div>)}
                <div className="row between"><strong>{done.payment_method === 'cash' ? `Collect ${rupees(Number(done.final.total) - Number(done.final.discount || 0))} in cash` : 'Paid online, settles tomorrow'}</strong></div>
              </div>
              {done.payment_method === 'cash' && <p className="tiny muted">The commission on this cash ride is deducted from tomorrow’s payout.</p>}
              <button className="btn block" onClick={() => setDone(null)}>Back to driving</button>
            </div>
          </Modal>
        )}
      </section>
      <div className="drive-map">
        <CityMap center={pos} driver={!ride ? pos : null} pickup={ride?.pickup} drop={ride?.drop} vehicle={ride?.category || 'auto'}
                 route={ride ? (ride.status === 'in_progress' ? makeRoute(ride.pickup, ride.drop) : makeRoute(pos, ride.pickup, 14)) : null} height="100%" label="Your area" />
      </div>
      <style>{`
        .drive-grid { display: grid; grid-template-columns: minmax(340px, 1fr) 1.2fr; gap: 20px; min-height: calc(100vh - 120px); }
        .drive-map { border-radius: var(--r-lg); overflow: hidden; min-height: 420px; position: sticky; top: 20px; height: calc(100vh - 80px); }
        .online-card { transition: background .5s, color .5s; position: relative; overflow: hidden; }
        .online-card.on { background: var(--accent); color: var(--accent-ink); }
        .scan { height: 4px; margin-top: 18px; border-radius: 4px; background: rgba(246,233,216,.2); overflow: hidden; }
        .scan span { display: block; height: 100%; width: 30%; background: var(--cream); animation: scan 1.6s var(--ease-drive) infinite alternate; }
        @keyframes scan { to { transform: translateX(240%) } }
        @media (max-width: 900px) { .drive-grid { grid-template-columns: 1fr; } .drive-map { position: relative; height: 320px; } }
      `}</style>
    </div>
  )
}

function OfferCard({ offer, onAccept, onReject }) {
  const [left, setLeft] = useState(offer.expires_in)
  useEffect(() => {
    const iv = setInterval(() => setLeft((l) => { if (l <= 1) { clearInterval(iv); onReject(); return 0 } return l - 1 }), 1000)
    return () => clearInterval(iv)
  }, [offer.ride_id]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="panel stack offer" role="alertdialog" aria-label="New ride request">
      <div className="row between">
        <div><span className="chip accent">New request</span><h3 style={{ marginTop: 8 }}>{rupees(offer.est_earning)} estimated earning</h3>
          <div className="small muted">{offer.payment_method === 'cash' ? 'Cash ride' : 'Online payment'} · {offer.distance_km} km trip · pickup {offer.pickup_distance_km} km away</div></div>
        <Ring value={left} max={offer.expires_in} size={72} label={`${left} seconds left`}><text x="70" y="82" textAnchor="middle" fontSize="38" fontWeight="700" fill="var(--ink)">{left}</text></Ring>
      </div>
      <div className="tile small stack" style={{ gap: 6 }}>
        <div className="row"><span className="pin-dot" style={{ width: 10, height: 10, borderRadius: '50%', background: 'var(--sage-deep)' }} /> {offer.pickup}</div>
        <div className="row"><span style={{ width: 10, height: 10, borderRadius: 2, background: 'var(--accent)' }} /> {offer.drop}</div>
      </div>
      <div className="row"><button className="btn ghost grow" onClick={onReject}>Decline</button><button className="btn grow lg" onClick={onAccept}>Accept</button></div>
      <style>{'.offer { animation: rise .45s var(--ease-out); border: 2px solid var(--accent); }'}</style>
    </div>
  )
}

function ActiveTrip({ ride, setRide, onDone }) {
  const toast = useToast()
  const [otp, setOtp] = useState('')
  const [tolls, setTolls] = useState('')
  const [parking, setParking] = useState('')
  const [chat, setChat] = useState(false)
  const [cancelInfo, setCancelInfo] = useState(null)
  const act = async (path, body) => { try { const r = await post(`/driver/rides/${ride.id}/${path}`, body); path === 'complete' ? onDone(r) : setRide(r) } catch (e) { toast(e.detail || e.message, 'bad') } }
  const nav = (p) => window.open(`https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}`, '_blank', 'noopener')
  return (
    <div className="panel stack">
      <div className="row between"><span className="chip">{ride.code}</span><Vehicle type={ride.category} width={70} /></div>
      <div><strong>{ride.customer?.name}</strong><div className="small muted">{ride.payment_method === 'cash' ? 'Cash' : 'Online'} · estimate {rupees(ride.estimate.low)}–{rupees(ride.estimate.high)}</div></div>
      <div className="tile small stack" style={{ gap: 6 }}><div><strong>Pickup</strong> {ride.pickup.address}</div><div><strong>Drop</strong> {ride.drop.address}</div></div>
      <div className="row wrap">
        <button className="btn sage sm" onClick={() => nav(ride.status === 'in_progress' ? ride.drop : ride.pickup)}>Navigate</button>
        <button className="btn sage sm" onClick={() => post(`/rides/${ride.id}/call`).then((r) => toast(r.message))}>Call rider (private)</button>
        <button className="btn sage sm" onClick={() => setChat(true)}>Chat</button>
      </div>
      {ride.status === 'assigned' && <button className="btn lg" onClick={() => act('arrived')}>I’ve arrived at pickup</button>}
      {ride.status === 'arrived' && (
        <form className="row" onSubmit={(e) => { e.preventDefault(); act('start', { otp }) }}>
          <input className="input num" inputMode="numeric" maxLength={4} placeholder="Rider’s OTP" value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} aria-label="Rider OTP" style={{ fontSize: 'var(--t-xl)', letterSpacing: '.3em' }} />
          <button className="btn lg" disabled={otp.length !== 4}>Start trip</button>
        </form>
      )}
      {DEMO && ride.status === 'arrived' && <p className="tiny muted">Demo rider’s OTP is 4821.</p>}
      {ride.status === 'in_progress' && (
        <div className="stack">
          <div className="grid-2">
            <Field label="Tolls paid (₹)"><input className="input" inputMode="decimal" value={tolls} onChange={(e) => setTolls(e.target.value)} /></Field>
            <Field label="Parking paid (₹)"><input className="input" inputMode="decimal" value={parking} onChange={(e) => setParking(e.target.value)} /></Field>
          </div>
          <button className="btn lg" onClick={() => act('complete', { tolls: Number(tolls || 0), parking: Number(parking || 0) })}>Complete trip</button>
          <p className="tiny muted">Tolls and parking are added to the fare and paid to you in full.</p>
        </div>
      )}
      {['assigned', 'arrived'].includes(ride.status) && !cancelInfo && (
        <button className="btn ghost sm" onClick={async () => setCancelInfo(await get(`/rides/${ride.id}/cancel-preview`))}>Cancel trip</button>
      )}
      {cancelInfo && (
        <div className="tile small stack">
          <span>{cancelInfo.free ? 'Cancelling now is free (within 15 minutes of booking).' : `Cancelling now costs ₹${cancelInfo.fee_if_cancelled} and lowers your ranking.`}</span>
          <div className="row"><button className="btn ghost sm" onClick={() => setCancelInfo(null)}>Keep trip</button>
            <button className="btn danger sm" onClick={async () => { await post(`/rides/${ride.id}/cancel`, { reason: 'Driver cancelled' }); setRide(null); toast('Trip cancelled. The rider is being matched with another driver.') }}>Cancel trip</button></div>
        </div>
      )}
      {chat && <DriverChat ride={ride} onClose={() => setChat(false)} />}
    </div>
  )
}

function DriverChat({ ride, onClose }) {
  const [msgs, setMsgs] = useState([])
  const [text, setText] = useState('')
  const load = useCallback(() => get(`/rides/${ride.id}/messages`).then(setMsgs), [ride.id])
  useEffect(() => { load(); return subscribe(`ride:${ride.id}`, (m) => m.event === 'chat' && load()) }, [load, ride.id])
  return (
    <Modal title="Chat with rider" onClose={onClose}>
      <div className="stack" style={{ maxHeight: 260, overflow: 'auto' }}>{msgs.map((m) => <div key={m.id} className={`tile small`} style={{ marginLeft: m.mine ? 'auto' : 0, maxWidth: '80%' }}>{m.body}</div>)}</div>
      <div className="row wrap" style={{ margin: '10px 0' }}>{['Reaching in 2 minutes', 'I’m at the pickup point', 'Stuck in traffic, coming'].map((q) => <button key={q} className="chip" style={{ border: 0, cursor: 'pointer' }} onClick={async () => { await post(`/rides/${ride.id}/messages`, { body: q }); load() }}>{q}</button>)}</div>
      <form className="row" onSubmit={async (e) => { e.preventDefault(); if (!text) return; await post(`/rides/${ride.id}/messages`, { body: text }); setText(''); load() }}>
        <input className="input" value={text} onChange={(e) => setText(e.target.value)} aria-label="Message" /><button className="btn">Send</button>
      </form>
    </Modal>
  )
}

/* ================================================================== Earnings */
export function Earnings() {
  const [e, setE] = useState(null)
  const [settle, setSettle] = useState([])
  const [ledger, setLedger] = useState([])
  const [tab, setTab] = useState('settlements')
  useEffect(() => { get('/driver/earnings').then(setE); get('/driver/settlements').then(setSettle); get('/driver/ledger').then(setLedger) }, [])
  const month = new Date().toISOString().slice(0, 7)
  if (!e) return <Loader label="Loading earnings" />
  return (
    <>
      <PageHead title="Earnings" sub={e.policy}>
        <button className="btn ghost" onClick={() => download(`/driver/statement.csv?month=${month}`, `vayora-statement-${month}.csv`,
          [['Date', 'Entry', 'Amount', 'Details'], ...ledger.map((l) => [dateTime(l.at), titleCase(l.type), l.amount, l.memo])])}>Download {month} statement</button>
      </PageHead>
      <div className="grid-4">
        <Stat label="Today" value={e.today.earnings} format={(n) => rupees(n)} tone="accent" note={plural(e.today.rides, 'trip')} />
        <Stat label="This week" value={e.week.earnings} format={(n) => rupees(n)} note={`${plural(e.week.rides, 'trip')} · commission ${rupees(e.week.commission)}`} />
        <Stat label="This month" value={e.month.earnings} format={(n) => rupees(n)} note={plural(e.month.rides, 'trip')} />
        <Stat label="Settles tomorrow" value={Math.max(0, e.pending_settlement)} format={(n) => rupees(n)}
              note={Number(e.cash_commission_due) > 0 ? `Cash commission due ${rupees(e.cash_commission_due)}` : 'After cash commission'} />
      </div>
      <div className="grid-2" style={{ marginTop: 20 }}>
        <div className="panel"><h3 style={{ marginBottom: 14 }}>Last 14 days</h3><BarChart data={e.daily} x="date" y="earnings" format={(v) => rupees(v)} label="Daily earnings, last 14 days" /></div>
        <div className="panel stack">
          <h3>How your money moves</h3>
          {[['Online rides', 'Customer pays VAYORA. We deduct commission and pay you the rest the next morning.'],
            ['Cash rides', 'You keep the cash. The commission is deducted from your next online payout. If online earnings don’t cover it, it carries forward.'],
            ['Tolls & parking', 'Always 100% yours, never commissioned.'],
            ['Payout status', 'Marked paid only after the bank confirms, with the UTR reference.']].map(([h, b]) => <div key={h} className="small"><strong>{h}.</strong> <span className="muted">{b}</span></div>)}
        </div>
      </div>
      <div className="panel" style={{ marginTop: 20 }}>
        <div className="row" role="tablist">{[['settlements', 'Settlements'], ['ledger', 'Ledger']].map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={`btn sm ${tab === k ? '' : 'ghost'}`} onClick={() => setTab(k)}>{l}</button>)}</div>
        <div className="table-wrap" style={{ marginTop: 14 }}>
          {tab === 'settlements' ? (
            <table className="table"><thead><tr><th>Day</th><th>Online earnings</th><th>Cash commission</th><th>Net</th><th>Status</th><th>Bank reference</th></tr></thead>
              <tbody>{settle.map((s) => <tr key={s.date}><td>{date(s.date)}</td><td>{rupees(s.online)}</td><td>{rupees(s.cash_commission)}</td><td className="num">{rupees(s.net)}</td>
                <td><span className={`chip ${s.status === 'paid' ? 'good' : s.status === 'failed' ? 'bad' : 'warn'}`}>{titleCase(s.status)}</span></td>
                <td className="small">{s.payout?.utr || s.payout?.failure || s.note}</td></tr>)}</tbody></table>
          ) : (
            <table className="table"><thead><tr><th>When</th><th>Entry</th><th>Amount</th><th>Details</th><th>Settled</th></tr></thead>
              <tbody>{ledger.map((l) => <tr key={l.id}><td>{dateTime(l.at)}</td><td>{titleCase(l.type)}</td><td className="num" style={{ color: Number(l.amount) < 0 ? 'var(--bad)' : 'var(--good)' }}>{rupees(l.amount, true)}</td><td className="small">{l.memo}</td><td>{l.settled ? 'Yes' : 'Pending'}</td></tr>)}</tbody></table>
          )}
        </div>
      </div>
    </>
  )
}

/* ================================================================== Performance / ranking */
const FACTOR_COPY = { rating: 'Verified rider ratings', completion: 'Trips completed after accepting', acceptance: 'Requests accepted while online', cancellation: 'No cancellations after 15 minutes', safety: 'Safety record (last 90 days)' }

export function Performance() {
  const [p, setP] = useState(null)
  useEffect(() => { get('/driver/performance').then(setP) }, [])
  if (!p) return <Loader label="Loading ranking" />
  const f = p.snapshot.factors || {}
  return (
    <>
      <PageHead title="Your ranking" sub="Built only from verified ratings on completed trips (one per trip) and your own record. Repeat ratings from the same rider count less, so no one can game it." />
      <div className="grid-2">
        <div className="panel row" style={{ gap: 28, flexWrap: 'wrap' }}>
          <Ring value={p.score} size={170} label={`Score ${p.score} out of 100`}>
            <text x="70" y="70" textAnchor="middle" fontSize="34" fontWeight="800" fill="var(--ink)" fontFamily="var(--font-display)">{Number(p.score).toFixed(0)}</text>
            <text x="70" y="92" textAnchor="middle" fontSize="12" fill="var(--ink-soft)">of 100</text>
          </Ring>
          <div className="stack">
            <span className="chip accent" style={{ justifySelf: 'start' }}>{p.tier}</span>
            <div className="num" style={{ fontSize: 'var(--t-3xl)' }}>#<Counter value={p.city_rank} /></div>
            <div className="muted small">in your city, out of {p.city_total} drivers</div>
            <div className="small">★ {p.snapshot.rating?.bayesian} from {p.snapshot.rating?.verified_count} verified ratings</div>
          </div>
        </div>
        <div className="panel stack">
          <h3>What would raise your score</h3>
          {(p.snapshot.tips || []).map((t) => <p key={t} className="small">{t}</p>)}
        </div>
      </div>
      <div className="panel stack" style={{ marginTop: 20 }}>
        <h3>Score breakdown</h3>
        {Object.entries(f).map(([k, v]) => (
          <div key={k} className="factor">
            <div className="row between small"><span><strong>{FACTOR_COPY[k]}</strong> <span className="muted">· weight {Number(v.weight)}%</span></span><span className="num">{v.points} pts</span></div>
            <Meter value={v.value} tone={Number(v.value) < 80 ? 'bad' : undefined} />
            <div className="tiny muted">{v.value}%</div>
          </div>
        ))}
      </div>
      <div className="grid-2" style={{ marginTop: 20 }}>
        <div className="panel"><h3>Your numbers</h3>
          <div className="grid-2" style={{ marginTop: 12 }}>{Object.entries(p.counts).map(([k, v]) => <div key={k} className="tile"><div className="tiny muted">{titleCase(k)}</div><div className="num" style={{ fontSize: 'var(--t-xl)' }}><Counter value={v} /></div></div>)}</div>
        </div>
        <div className="panel stack"><h3>Recent feedback</h3>
          {p.feedback.map((fb, i) => <div key={i} className="small" style={{ borderBottom: '1px solid var(--line)', paddingBottom: 8 }}>
            <span style={{ color: 'var(--accent)' }}>{'★'.repeat(fb.stars)}</span><span className="muted">{'★'.repeat(5 - fb.stars)}</span> {fb.tags?.join(', ')}
            {fb.comment && <div className="muted">“{fb.comment}”</div>}</div>)}
        </div>
      </div>
    </>
  )
}

/* ================================================================== Onboarding / documents */
const DOCS = [['photo', 'Profile photo'], ['licence', 'Driving licence'], ['aadhaar', 'Aadhaar / Government ID'], ['rc', 'Vehicle registration (RC)'], ['insurance', 'Vehicle insurance'],
              ['vehicle_photo', 'Vehicle photos'], ['bank_proof', 'Cancelled cheque or passbook']]

export function Onboarding() {
  const toast = useToast()
  const [o, setO] = useState(null)
  const [veh, setVeh] = useState({ category: 'auto', registration_number: '', make: '', model: '', colour: '', year: 2023, seats: 3, insurance_expiry: '' })
  const [bank, setBank] = useState({ account_number: '', ifsc: '', holder_name: '' })
  const load = () => get('/driver/onboarding').then(setO)
  useEffect(() => { load() }, [])
  const upload = async (type, file) => {
    if (!file) return
    if (file.size > 8 * 1024 * 1024) return toast('Files must be under 8 MB', 'bad')
    const fd = new FormData(); fd.append('doc_type', type); fd.append('file', file)
    const { api } = await import('../../api/client.js')
    await api('POST', '/driver/onboarding/documents', fd, { form: true }); toast('Uploaded. Our team will verify it.'); load()
  }
  const done = useMemo(() => o ? DOCS.filter(([k]) => o.documents[k]).length : 0, [o])
  if (!o) return <Loader label="Loading documents" />
  return (
    <>
      <PageHead title="Documents & verification" sub="Everything here is checked by the VAYORA team before you can go online. Your bank and ID details are encrypted.">
        <span className={`chip ${o.status === 'approved' ? 'good' : o.status === 'rejected' ? 'bad' : 'warn'}`}>{titleCase(o.status)}</span>
      </PageHead>
      {o.rejection_reason && <p className="tile" style={{ marginBottom: 16 }}>Changes needed: {o.rejection_reason}</p>}
      <div className="grid-2">
        <div className="panel stack">
          <div className="row between"><h3>Documents</h3><span className="small muted">{done} of {DOCS.length}</span></div>
          <Meter value={done} max={DOCS.length} />
          {DOCS.map(([k, label]) => {
            const d = o.documents[k]
            return (
              <div key={k} className="row between doc-row">
                <span>{label}</span>
                <div className="row">
                  {d && <span className={`chip ${d.status === 'verified' ? 'good' : d.status === 'rejected' ? 'bad' : 'warn'}`}>{titleCase(d.status)}</span>}
                  {d?.status !== 'verified' && <label className="btn ghost sm">{d ? 'Replace' : 'Upload'}<input type="file" accept="image/jpeg,image/png,application/pdf" hidden onChange={(e) => upload(k, e.target.files[0])} /></label>}
                </div>
              </div>)
          })}
        </div>
        <div className="stack lg">
          <form className="panel stack" onSubmit={async (e) => { e.preventDefault(); try { await post('/driver/onboarding/vehicle', { ...veh, year: Number(veh.year), seats: Number(veh.seats) }); toast('Vehicle added'); load() } catch (er) { toast(er.detail || er.message, 'bad') } }}>
            <h3>Vehicle</h3>
            {o.vehicles.map((v) => <div key={v.id} className="row between small"><span className="row"><Vehicle type={v.category} width={60} /> {v.reg}</span><span className={`chip ${v.status === 'approved' ? 'good' : 'warn'}`}>{titleCase(v.status)}</span></div>)}
            {o.vehicles.length === 0 && (<>
              <div className="row wrap">{['bike', 'auto', 'car', 'tourist'].map((c) => <button type="button" key={c} className={`btn sm ${veh.category === c ? '' : 'ghost'}`} onClick={() => setVeh({ ...veh, category: c })}>{titleCase(c)}</button>)}</div>
              <div className="grid-2">
                <Field label="Registration no."><input className="input" required placeholder="TN09AB1234" value={veh.registration_number} onChange={(e) => setVeh({ ...veh, registration_number: e.target.value.toUpperCase().replace(/\s/g, '') })} /></Field>
                <Field label="Insurance valid till"><input className="input" type="date" required value={veh.insurance_expiry} onChange={(e) => setVeh({ ...veh, insurance_expiry: e.target.value })} /></Field>
                <Field label="Make"><input className="input" required value={veh.make} onChange={(e) => setVeh({ ...veh, make: e.target.value })} /></Field>
                <Field label="Model"><input className="input" required value={veh.model} onChange={(e) => setVeh({ ...veh, model: e.target.value })} /></Field>
                <Field label="Colour"><input className="input" required value={veh.colour} onChange={(e) => setVeh({ ...veh, colour: e.target.value })} /></Field>
                <Field label="Year"><input className="input" type="number" min="2008" max="2030" value={veh.year} onChange={(e) => setVeh({ ...veh, year: e.target.value })} /></Field>
              </div>
              {veh.category === 'tourist' && <p className="tiny muted">Interstate trips need an All-India Tourist Permit. Upload it with your documents.</p>}
              <button className="btn">Add vehicle</button></>)}
          </form>
          <form className="panel stack" onSubmit={async (e) => { e.preventDefault(); try { const r = await post('/driver/onboarding/bank', bank); toast(r.message); load() } catch (er) { toast(er.detail || er.message, 'bad') } }}>
            <div className="row between"><h3>Bank account for payouts</h3>{o.bank?.verified && <span className="chip good">Verified ••{o.bank.last4}</span>}</div>
            <Field label="Account holder"><input className="input" required value={bank.holder_name} onChange={(e) => setBank({ ...bank, holder_name: e.target.value })} /></Field>
            <div className="grid-2">
              <Field label="Account number"><input className="input" required inputMode="numeric" value={bank.account_number} onChange={(e) => setBank({ ...bank, account_number: e.target.value.replace(/\D/g, '') })} /></Field>
              <Field label="IFSC"><input className="input" required value={bank.ifsc} onChange={(e) => setBank({ ...bank, ifsc: e.target.value.toUpperCase() })} /></Field>
            </div>
            <button className="btn ghost">Save bank details</button>
          </form>
          {o.status !== 'approved' && o.status !== 'submitted' && <button className="btn lg" onClick={async () => { try { await post('/driver/onboarding/submit'); toast('Submitted for verification'); load() } catch (er) { toast(er.detail || er.message, 'bad') } }}>Submit for verification</button>}
        </div>
      </div>
      <style>{'.doc-row { padding: 8px 0; border-bottom: 1px solid var(--line); font-size: var(--t-sm); }'}</style>
    </>
  )
}
