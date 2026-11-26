import { useContext, useEffect, useState } from 'react'
import { PageHead } from '../../components/Layouts.jsx'
import { Empty, Field, Loader, Modal, useReveal, useToast } from '../../components/ui.jsx'
import { Vehicle } from '../../motion/vehicles.jsx'
import { del, get, patch, post } from '../../api/client.js'
import { useRouter } from '../../lib/router.jsx'
import { LANGS, LangCtx } from '../../lib/i18n.js'
import { useSession } from '../../lib/session.jsx'
import { PLACES } from '../../lib/geo.js'
import { date, dateTime, rupees, statusLabel, statusTone, titleCase } from '../../lib/format.js'

/* ------------------------------------------------------------------ ride history + receipts */
export function History() {
  const { navigate, query } = useRouter()
  const [rides, setRides] = useState(null)
  const [receipt, setReceipt] = useState(null)
  useEffect(() => { get('/rides').then(setRides) }, [])
  useEffect(() => { if (query.receipt) get(`/rides/${query.receipt}/receipt`).then(setReceipt).catch(() => {}) }, [query.receipt])
  useReveal()
  if (!rides) return <Loader label="Loading rides" />
  return (
    <>
      <PageHead title="My rides" sub="Every trip with its fare, receipt and status." />
      {rides.length === 0 ? <Empty title="No rides yet" action={<button className="btn" onClick={() => navigate('/book')}>Book your first ride</button>}>Your trips will appear here with their receipts.</Empty> : (
        <div className="stack">
          {rides.map((r) => (
            <div key={r.id} className="panel history-row" data-reveal>
              <Vehicle type={r.category} width={r.category === 'tourist' ? 96 : 78} />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="row wrap" style={{ gap: 8 }}><strong>{r.drop.address}</strong><span className={`chip ${statusTone[r.status] || ''}`}>{statusLabel[r.status]}</span></div>
                <div className="small muted">From {r.pickup.address} · {dateTime(r.created_at)} · {r.code}</div>
              </div>
              <div className="num" style={{ fontSize: 'var(--t-lg)' }}>{r.final ? rupees(Number(r.final.total) - Number(r.final.discount || 0)) : '—'}</div>
              <div className="row">
                {['searching', 'assigned', 'arrived', 'in_progress', 'scheduled'].includes(r.status) && <button className="btn sm" onClick={() => navigate(`/ride/${r.id}`, { vehicle: r.category })}>Track</button>}
                {r.status === 'completed' && <button className="btn ghost sm" onClick={() => get(`/rides/${r.id}/receipt`).then(setReceipt)}>Receipt</button>}
                {r.status === 'completed' && !r.rated && <button className="btn ghost sm" onClick={() => navigate(`/ride/${r.id}`, { vehicle: r.category })}>Rate</button>}
              </div>
            </div>
          ))}
        </div>
      )}
      {receipt && <Receipt data={receipt} onClose={() => setReceipt(null)} />}
      <style>{'.history-row { display: flex; align-items: center; gap: 18px; padding: 16px 20px; flex-wrap: wrap; }'}</style>
    </>
  )
}

function Receipt({ data, onClose }) {
  const r = data.ride
  return (
    <Modal title="Receipt" onClose={onClose}>
      <div className="stack receipt-print">
        <div className="row between"><strong>{data.company.name}</strong><span className="small muted">{data.receipt_no}</span></div>
        <div className="small muted">{dateTime(data.issued_at)} · {r.category_name} · {r.city}</div>
        <div className="tile small stack" style={{ gap: 4 }}><div><strong>From</strong> {r.pickup.address}</div><div><strong>To</strong> {r.drop.address}</div>
          {r.driver && <div><strong>Driver</strong> {r.driver.name} · {r.driver.vehicle?.reg}</div>}</div>
        <div className="stack small" style={{ gap: 6 }}>
          {r.final.breakdown.lines.map((l) => <div key={l.label} className="row between"><span>{l.label}</span><span>{rupees(l.amount, true)}</span></div>)}
          {Number(r.final.discount) > 0 && <div className="row between"><span>Coupon discount</span><span>−{rupees(r.final.discount, true)}</span></div>}
          <hr className="divider" />
          <div className="row between"><strong>Total paid ({r.payment_method === 'cash' ? 'cash' : 'online'})</strong><strong className="num">{rupees(Number(r.final.total) - Number(r.final.discount || 0), true)}</strong></div>
          <div className="row between muted"><span>Estimate at booking</span><span>{rupees(r.estimate.low)} – {rupees(r.estimate.high)}</span></div>
        </div>
        <p className="tiny muted">Questions about this fare? Contact {data.company.support} or raise a ticket from Support.</p>
        <button className="btn ghost" onClick={() => window.print()}>Print or save as PDF</button>
      </div>
    </Modal>
  )
}

/* ------------------------------------------------------------------ offers, referral, favourites */
export function Offers() {
  const toast = useToast()
  const [coupons, setCoupons] = useState([])
  const [ref, setRef] = useState(null)
  const [favs, setFavs] = useState([])
  useEffect(() => { get('/coupons').then(setCoupons); get('/referral').then(setRef); get('/favourites').then(setFavs) }, [])
  return (
    <>
      <PageHead title="Offers and rewards" />
      <div className="grid-2">
        <div className="stack">
          {coupons.map((c) => (
            <div key={c.code} className="panel coupon">
              <div><div className="num" style={{ fontSize: 'var(--t-xl)', color: 'var(--accent)' }}>{c.kind === 'flat' ? rupees(c.value) : `${Number(c.value)}%`} off</div>
                <p className="small">{c.description}</p><p className="tiny muted">Valid till {date(c.valid_to)}{Number(c.min_fare) ? ` · min fare ${rupees(c.min_fare)}` : ''}</p></div>
              <button className="btn cream sm" onClick={() => { navigator.clipboard?.writeText(c.code); toast(`${c.code} copied. Paste it when you book.`) }}>{c.code}</button>
            </div>
          ))}
        </div>
        <div className="stack">
          {ref && (
            <div className="panel" style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}>
              <h3>Invite friends, ride for less</h3>
              <p className="small" style={{ opacity: .85, margin: '8px 0 16px' }}>Your friend gets ₹{ref.friend_gets} off their first ride. You get ₹{ref.reward_each} when they complete it.</p>
              <div className="row between"><span className="num" style={{ fontSize: 'var(--t-2xl)', letterSpacing: '.1em' }}>{ref.code}</span>
                <button className="btn cream sm" onClick={() => { navigator.share ? navigator.share({ text: `Ride with VAYORA. Use my code ${ref.code} for ₹${ref.friend_gets} off.` }) : navigator.clipboard?.writeText(ref.code); toast('Invite ready to share') }}>Share invite</button></div>
              <p className="tiny" style={{ opacity: .75, marginTop: 10 }}>{ref.invited} invited · {ref.rewarded} rewarded</p>
            </div>
          )}
          <div className="panel">
            <h3>Favourite drivers</h3>
            <p className="small muted" style={{ margin: '6px 0 12px' }}>When a favourite is nearby and online, they get your request first.</p>
            {favs.length === 0 ? <p className="small muted">Mark a driver as favourite after a 5-star trip.</p> :
              favs.map((f) => <div key={f.driver_id} className="row between small" style={{ padding: '8px 0' }}><span>{f.name} · {f.tier}</span><span className={`chip ${f.online ? 'good' : ''}`}>{f.online ? 'Online' : 'Offline'}</span></div>)}
          </div>
        </div>
      </div>
      <style>{'.coupon { display: flex; justify-content: space-between; align-items: center; gap: 16px; border-left: 6px solid var(--accent); }'}</style>
    </>
  )
}

/* ------------------------------------------------------------------ support & complaints */
const CATS = [['driver_behaviour', 'Driver behaviour'], ['unsafe_driving', 'Unsafe driving'], ['harassment_safety', 'Harassment or safety issue'], ['vehicle_condition', 'Vehicle condition'],
              ['wrong_fare', 'Wrong fare'], ['payment_dispute', 'Payment problem'], ['lost_item', 'Lost belongings'], ['trip_issue', 'Trip issue'], ['other', 'Something else']]

export function Support() {
  const toast = useToast()
  const { query } = useRouter()
  const [rides, setRides] = useState([])
  const [mine, setMine] = useState([])
  const [f, setF] = useState({ category: query.category || 'trip_issue', ride_id: '', description: query.summary || '' })
  const load = () => get('/complaints').then(setMine)
  useEffect(() => { get('/rides').then((r) => setRides(r.slice(0, 10))); load() }, [])
  const submit = async (e) => {
    e.preventDefault()
    if (f.description.trim().length < 10) return toast('Describe what happened in at least 10 characters.', 'bad')
    const r = await post('/complaints', { ...f, ride_id: f.ride_id ? Number(f.ride_id) : null })
    toast(`Ticket ${r.ticket} created. We’ll respond within ${r.sla_hours} hour${r.sla_hours > 1 ? 's' : ''}.`)
    setF({ ...f, description: '' }); load()
  }
  const safety = ['unsafe_driving', 'harassment_safety'].includes(f.category)
  return (
    <>
      <PageHead title="Support" sub="Tell us what went wrong. Safety issues go to the top of the queue and get a response within an hour." />
      <div className="grid-2">
        <form className="panel stack" onSubmit={submit}>
          <h3>Raise a ticket</h3>
          <Field label="What is it about?">
            <select className="input" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{CATS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          </Field>
          {safety && <p className="tile small" style={{ background: 'rgba(158,42,34,.1)' }}>If you are in danger right now, call <a href="tel:112"><strong>112</strong></a> or use SOS on your live trip.</p>}
          <Field label="Which ride?">
            <select className="input" value={f.ride_id} onChange={(e) => setF({ ...f, ride_id: e.target.value })}>
              <option value="">Not about a specific ride</option>
              {rides.map((r) => <option key={r.id} value={r.id}>{date(r.created_at)} · {r.drop.address} · {r.code}</option>)}
            </select>
          </Field>
          <Field label={f.category === 'lost_item' ? 'Describe the item and where you left it' : 'What happened?'}>
            <textarea className="input" rows={5} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} maxLength={2000} />
          </Field>
          <button className="btn">Send to support</button>
        </form>
        <div className="stack">
          <div className="panel">
            <h3>Your tickets</h3>
            {mine.length === 0 ? <p className="small muted" style={{ marginTop: 8 }}>No tickets yet.</p> : mine.map((c) => (
              <div key={c.ticket} className="row between small" style={{ padding: '10px 0', borderBottom: '1px solid var(--line)' }}>
                <span><strong>{c.ticket}</strong> · {titleCase(c.category)}</span>
                <span className={`chip ${c.status === 'resolved' ? 'good' : c.priority === 'P1' ? 'bad' : 'warn'}`}>{titleCase(c.status)}</span>
              </div>))}
          </div>
          <div className="panel stack small">
            <h3>Quick answers</h3>
            <details><summary>When is cancelling free?</summary><p className="muted">For both you and the driver, within 15 minutes of booking. After that a ₹30 fee applies (₹50 if the driver has arrived). You see it before confirming.</p></details>
            <details><summary>Why was my fare different from the estimate?</summary><p className="muted">The final fare uses the actual distance and time, plus waiting after 3 free minutes, tolls and parking. Your receipt lists each part.</p></details>
            <details><summary>Can the driver see my number?</summary><p className="muted">No. Calls go through a temporary VAYORA number that stops working 30 minutes after the trip.</p></details>
          </div>
        </div>
      </div>
    </>
  )
}

/* ------------------------------------------------------------------ profile */
export function Profile() {
  const toast = useToast()
  const { user, setUser } = useSession()
  const { lang, setLang } = useContext(LangCtx)
  const [name, setName] = useState(user?.name || '')
  const [addresses, setAddresses] = useState([])
  const [contacts, setContacts] = useState([])
  const [notes, setNotes] = useState([])
  const [addr, setAddr] = useState({ label: '', place: '' })
  const [ct, setCt] = useState({ name: '', phone: '+91', relation: '' })
  const load = () => { get('/auth/addresses').then(setAddresses); get('/auth/contacts').then(setContacts); get('/notifications').then(setNotes) }
  useEffect(load, [])
  const places = PLACES.Chennai.concat(PLACES.Bengaluru)
  return (
    <>
      <PageHead title="Profile" />
      <div className="grid-2">
        <div className="stack lg">
          <form className="panel stack" onSubmit={async (e) => { e.preventDefault(); setUser(await patch('/auth/me', { full_name: name, language: lang })); toast('Profile saved') }}>
            <h3>Your details</h3>
            <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <div className="grid-2">
              <Field label="Email"><input className="input" value={user?.email || ''} disabled /></Field>
              <Field label="Mobile"><input className="input" value={user?.phone || ''} disabled /></Field>
            </div>
            <Field label="App language"><select className="input" value={lang} onChange={(e) => setLang(e.target.value)}>{Object.entries(LANGS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
            {Number(user?.outstanding_dues) > 0 && <p className="tile small">₹{user.outstanding_dues} from an earlier late cancellation will be added to your next ride.</p>}
            <button className="btn">Save</button>
          </form>
          <div className="panel stack">
            <h3>Saved places</h3>
            {addresses.map((a) => <div key={a.id} className="row between small"><span><strong>{a.label}</strong> · {a.address}</span><button className="btn ghost sm" onClick={async () => { await del(`/auth/addresses/${a.id}`); load() }}>Remove</button></div>)}
            <form className="row wrap" onSubmit={async (e) => {
              e.preventDefault(); const p = places.find((x) => x[0] === addr.place); if (!p || !addr.label) return toast('Pick a place and give it a name', 'bad')
              await post('/auth/addresses', { label: addr.label, address: p[0], lat: p[1], lng: p[2] }); setAddr({ label: '', place: '' }); load() }}>
              <input className="input" style={{ flex: '1 1 120px' }} placeholder="Name, e.g. Gym" value={addr.label} onChange={(e) => setAddr({ ...addr, label: e.target.value })} />
              <select className="input" style={{ flex: '2 1 200px' }} value={addr.place} onChange={(e) => setAddr({ ...addr, place: e.target.value })}>
                <option value="">Choose a place</option>{places.map((p) => <option key={p[0]}>{p[0]}</option>)}
              </select>
              <button className="btn sm">Add place</button>
            </form>
          </div>
        </div>
        <div className="stack lg">
          <div className="panel stack">
            <h3>Emergency contacts</h3>
            <p className="small muted">They get your live location if you press SOS during a ride.</p>
            {contacts.map((c) => <div key={c.id} className="row between small"><span><strong>{c.name}</strong> · {c.relation} · {c.phone}</span><button className="btn ghost sm" onClick={async () => { await del(`/auth/contacts/${c.id}`); load() }}>Remove</button></div>)}
            <form className="grid-3" onSubmit={async (e) => { e.preventDefault(); try { await post('/auth/contacts', ct); setCt({ name: '', phone: '+91', relation: '' }); load() } catch (er) { toast(er.detail || er.message, 'bad') } }}>
              <input className="input" placeholder="Name" required value={ct.name} onChange={(e) => setCt({ ...ct, name: e.target.value })} />
              <input className="input" placeholder="+91…" required value={ct.phone} onChange={(e) => setCt({ ...ct, phone: e.target.value })} />
              <input className="input" placeholder="Relation" value={ct.relation} onChange={(e) => setCt({ ...ct, relation: e.target.value })} />
              <button className="btn sm">Add contact</button>
            </form>
          </div>
          <div className="panel stack">
            <div className="row between"><h3>Notifications</h3><button className="btn ghost sm" onClick={async () => { await post('/notifications/read-all'); load() }}>Mark all read</button></div>
            {notes.map((n) => <div key={n.id} className="small" style={{ opacity: n.read ? .6 : 1 }}><strong>{n.title}</strong> · {n.body}</div>)}
          </div>
        </div>
      </div>
    </>
  )
}
