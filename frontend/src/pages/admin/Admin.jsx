import { useCallback, useEffect, useMemo, useState } from 'react'
import { PageHead } from '../../components/Layouts.jsx'
import CityMap from '../../components/CityMap.jsx'
import { BarChart, Empty, Field, Loader, Modal, Stat, Switch, useToast } from '../../components/ui.jsx'
import { Vehicle } from '../../motion/vehicles.jsx'
import { DEMO, download, get, post, put, subscribe } from '../../api/client.js'
import { date, dateTime, num, rupees, titleCase } from '../../lib/format.js'

/* A reason is required for every admin action; it is stored in the audit log. */
function useReasonPrompt() {
  const [req, setReq] = useState(null)
  const ask = (title, onSubmit, extra) => setReq({ title, onSubmit, extra })
  const ui = req && <ReasonModal {...req} onClose={() => setReq(null)} />
  return [ask, ui]
}
function ReasonModal({ title, onSubmit, onClose, extra }) {
  const [reason, setReason] = useState('')
  const [days, setDays] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <Modal title={title} onClose={onClose}>
      <form className="stack" onSubmit={async (e) => { e.preventDefault(); setBusy(true); try { await onSubmit(reason, days ? Number(days) : null); onClose() } finally { setBusy(false) } }}>
        <Field label="Reason (saved in the audit log)"><textarea className="input" rows={3} required minLength={5} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        {extra === 'days' && <Field label="Duration in days (leave empty for indefinite)"><input className="input" type="number" min="1" max="365" value={days} onChange={(e) => setDays(e.target.value)} /></Field>}
        <button className="btn" disabled={busy}>Confirm</button>
      </form>
    </Modal>
  )
}
const err = (toast) => (e) => toast(e.detail || e.message, 'bad')

/* ================================================================== A. Overview */
export function Overview() {
  const [d, setD] = useState(null)
  const [days, setDays] = useState(30)
  const [feed, setFeed] = useState([])
  const [ai, setAi] = useState(null)
  useEffect(() => { setD(null); get(`/admin/overview?days=${days}`).then(setD) }, [days])
  useEffect(() => subscribe('admin:live', (m) => setFeed((f) => [{ ...m, at: new Date() }, ...f].slice(0, 8))), [])
  if (!d) return <Loader type="car" label="Loading dashboard" />
  const k = d.kpis
  const maxCity = Math.max(...d.by_city.map((c) => c.gbv), 1)
  return (
    <>
      <PageHead title="Overview" sub={`Platform performance over the last ${days} days.`}>
        <div className="row" role="tablist">{[7, 30, 90].map((n) => <button key={n} role="tab" aria-selected={days === n} className={`btn sm ${days === n ? '' : 'ghost'}`} onClick={() => setDays(n)}>{n} days</button>)}</div>
        <button className="btn ghost" onClick={() => post('/ai/chat', { message: 'Summarise this week for the leadership team' }).then(setAi)}>Ask AI for a summary</button>
      </PageHead>
      {ai && <div className="panel" style={{ marginBottom: 20, whiteSpace: 'pre-line', borderLeft: '6px solid var(--accent)' }}><strong>AI summary</strong><p className="small" style={{ marginTop: 8 }}>{ai.reply}</p></div>}
      <div className="grid-4">
        <Stat label="Total bookings" value={k.total_bookings} note={`${num(k.completed)} completed · ${num(k.cancelled)} cancelled`} />
        <Stat label="Gross bookings value" value={k.gross_bookings_value} format={(n) => rupees(n)} />
        <Stat label="Company commission" value={k.company_commission} format={(n) => rupees(n)} tone="accent" note={`Promotions cost ${rupees(k.promotions_cost)}`} />
        <Stat label="Driver earnings" value={k.driver_earnings} format={(n) => rupees(n)} />
        <Stat label="Drivers online now" value={k.active_drivers} note={`${num(k.approved_drivers)} approved · ${k.pending_driver_approvals} awaiting approval`} />
        <Stat label="Registered customers" value={k.registered_customers} />
        <Stat label="Pending settlements" value={k.pending_settlements} format={(n) => rupees(n)} note={`${k.payout_failures} payout failures`} />
        <Stat label="Open complaints" value={k.open_complaints} note={`${k.open_safety} safety (P1)`} />
      </div>
      <div className="grid-2" style={{ marginTop: 20 }}>
        <div className="panel"><div className="row between" style={{ marginBottom: 12 }}><h3>Daily bookings</h3><span className="small muted">Latest day highlighted</span></div>
          <BarChart data={d.daily} x="date" y="rides" format={num} label="Bookings per day" /></div>
        <div className="panel"><h3 style={{ marginBottom: 12 }}>Revenue by city</h3>
          <div className="stack" style={{ gap: 10 }}>{d.by_city.map((c) => (
            <div key={c.city} className="small"><div className="row between"><span>{c.city}</span><span className="num">{rupees(c.gbv)}</span></div>
              <div style={{ height: 8, background: 'var(--sage-mist)', borderRadius: 8 }}><div style={{ width: `${(c.gbv / maxCity) * 100}%`, height: '100%', background: 'var(--accent)', borderRadius: 8, transition: 'width 1s var(--ease-out)' }} /></div>
              <div className="tiny muted">{num(c.rides)} rides · {c.rides ? Math.round((c.cancelled / c.rides) * 100) : 0}% cancelled</div></div>))}</div>
        </div>
      </div>
      <div className="grid-2" style={{ marginTop: 20 }}>
        <div className="panel"><h3 style={{ marginBottom: 12 }}>By vehicle type</h3>
          <div className="grid-2">{d.by_vehicle.map((v) => <div key={v.vehicle} className="tile row"><Vehicle type={v.vehicle.toLowerCase()} width={64} />
            <div><strong>{v.vehicle}</strong><div className="small muted">{num(v.rides)} rides · {rupees(v.gbv)}</div></div></div>)}</div></div>
        <div className="panel"><h3 style={{ marginBottom: 12 }}>Live activity</h3>
          {feed.length === 0 ? <p className="small muted">New SOS alerts, safety complaints and driver applications appear here instantly.</p> :
            feed.map((f, i) => <div key={i} className="small row between"><span>{titleCase(f.event)}: {f.data?.code || f.data?.ticket || f.data?.name}</span><span className="muted">{f.at.toLocaleTimeString()}</span></div>)}
        </div>
      </div>
    </>
  )
}

/* ================================================================== C. Drivers */
export function Drivers() {
  const toast = useToast()
  const [pending, setPending] = useState([])
  const [list, setList] = useState([])
  const [q, setQ] = useState('')
  const [ask, reasonUi] = useReasonPrompt()
  const load = useCallback(() => { get('/admin/drivers/pending').then(setPending); get(`/admin/users?role=driver&q=${encodeURIComponent(q)}`).then(setList) }, [q])
  useEffect(() => { load() }, [load])
  const review = (doc, status) => post(`/admin/documents/${doc.id}/review`, { status, note: status === 'rejected' ? 'Image unclear, please re-upload' : null }).then(load)
  return (
    <>
      <PageHead title="Drivers" sub="Approve new drivers after checking each document. Every decision is recorded in the audit log." />
      <h3 style={{ marginBottom: 12 }}>Awaiting approval ({pending.length})</h3>
      {pending.length === 0 ? <p className="muted small" style={{ marginBottom: 24 }}>No applications waiting.</p> : (
        <div className="grid-3" style={{ marginBottom: 28 }}>
          {pending.map((p) => (
            <div key={p.driver_id} className="panel stack">
              <div className="row between"><strong>{p.name}</strong><Vehicle type={p.vehicles[0]?.category} width={64} /></div>
              <div className="small muted">{p.city} · {p.vehicles[0]?.reg} · licence {p.licence}</div>
              <div className="stack" style={{ gap: 6 }}>{p.documents.map((d) => (
                <div key={d.id} className="row between small"><span>{titleCase(d.type)}</span>
                  {d.status === 'pending' ? <span className="row" style={{ gap: 4 }}>
                    {!DEMO && <button className="btn ghost sm" onClick={() => download(`/admin/documents/${d.id}/file`, `${p.name}-${d.type}`, [])}>View</button>}
                    <button className="btn sage sm" onClick={() => review(d, 'verified')}>Verify</button><button className="btn ghost sm" onClick={() => review(d, 'rejected')}>Reject</button></span>
                    : <span className={`chip ${d.status === 'verified' ? 'good' : 'bad'}`}>{titleCase(d.status)}</span>}</div>))}</div>
              <div className="row">
                <button className="btn ghost grow" onClick={() => ask(`Reject ${p.name}?`, (reason) => post(`/admin/drivers/${p.driver_id}/decision`, { approve: false, reason }).then(load))}>Reject</button>
                <button className="btn grow" onClick={() => post(`/admin/drivers/${p.driver_id}/decision`, { approve: true }).then(() => { toast(`${p.name} approved`); load() }).catch(err(toast))}>Approve</button>
              </div>
            </div>))}
        </div>
      )}
      <div className="panel">
        <div className="row between" style={{ marginBottom: 12 }}><h3>All drivers</h3><input className="input" style={{ maxWidth: 280 }} placeholder="Search name, email, phone" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Driver</th><th>City</th><th>Vehicle</th><th>Rank</th><th>Status</th><th /></tr></thead>
          <tbody>{list.map((u) => (
            <tr key={u.id}><td><strong>{u.name}</strong><div className="tiny muted">{u.phone}</div></td><td>{u.driver?.city}</td>
              <td><span className="row" style={{ gap: 6 }}><Vehicle type={u.driver?.vehicle?.category} width={44} /> {u.driver?.vehicle?.reg}</span></td>
              <td>{u.driver?.tier} · {u.driver?.score}</td>
              <td><span className={`chip ${u.status === 'active' ? (u.driver?.online ? 'good' : '') : 'bad'}`}>{u.status === 'active' ? (u.driver?.online ? 'Online' : 'Offline') : titleCase(u.status)}</span></td>
              <td><AccountActions user={u} ask={ask} reload={load} /></td></tr>))}</tbody></table></div>
      </div>
      {reasonUi}
    </>
  )
}

function AccountActions({ user, ask, reload }) {
  const toast = useToast()
  const act = (action, label, extra) => ask(`${label} ${user.name}`, (reason, days) => post(`/admin/users/${user.id}/action`, { action, reason, days }).then(() => { toast(`${label} done`); reload() }).catch(err(toast)), extra)
  return user.status === 'active' ? (
    <div className="row" style={{ gap: 4 }}>
      <button className="btn ghost sm" onClick={() => act('warn', 'Warn')}>Warn</button>
      <button className="btn ghost sm" onClick={() => act('restrict', 'Restrict', 'days')}>Restrict</button>
      <button className="btn danger sm" onClick={() => act('suspend', 'Suspend', 'days')}>Suspend</button>
    </div>
  ) : (
    <div className="row" style={{ gap: 4 }}>
      <button className="btn sage sm" onClick={() => act('restore', 'Restore')}>Restore</button>
      <button className="btn ghost sm" onClick={() => act('appeal_upheld', 'Accept appeal of')}>Appeal upheld</button>
      {user.status !== 'deactivated' && <button className="btn ghost sm" onClick={() => act('deactivate', 'Permanently deactivate')}>Deactivate</button>}
    </div>
  )
}

/* ================================================================== B. Customers */
export function Customers() {
  const [list, setList] = useState([])
  const [q, setQ] = useState('')
  const [ask, reasonUi] = useReasonPrompt()
  const load = useCallback(() => get(`/admin/users?role=customer&q=${encodeURIComponent(q)}`).then(setList), [q])
  useEffect(() => { load() }, [load])
  return (
    <>
      <PageHead title="Customers" sub="Search riders, review their activity and act on complaints."><input className="input" style={{ width: 300 }} placeholder="Search name, email, phone" value={q} onChange={(e) => setQ(e.target.value)} /></PageHead>
      <div className="panel table-wrap"><table className="table">
        <thead><tr><th>Customer</th><th>Contact</th><th>Rides</th><th>Joined</th><th>Status</th><th /></tr></thead>
        <tbody>{list.map((u) => <tr key={u.id}><td><strong>{u.name}</strong>{u.fraud_flag && <span className="chip bad" style={{ marginLeft: 6 }}>Flagged</span>}</td>
          <td className="small">{u.email}<div className="muted">{u.phone}</div></td><td>{u.rides}</td><td>{date(u.joined)}</td>
          <td><span className={`chip ${u.status === 'active' ? 'good' : 'bad'}`}>{titleCase(u.status)}</span></td><td><AccountActions user={u} ask={ask} reload={load} /></td></tr>)}</tbody>
      </table></div>
      {reasonUi}
    </>
  )
}

/* ================================================================== D. Vehicles & categories */
export function Fleet() {
  const toast = useToast()
  const [cats, setCats] = useState([])
  const [vehicles, setVehicles] = useState([])
  const [ask, reasonUi] = useReasonPrompt()
  const load = () => { get('/admin/categories').then(setCats); get('/admin/vehicles').then(setVehicles) }
  useEffect(load, [])
  return (
    <>
      <PageHead title="Vehicles" sub="Pause a vehicle type across India here, or per city under Cities. Customers only see types that are switched on in both places." />
      <div className="grid-4">
        {cats.map((c) => (
          <div key={c.id} className="panel stack" style={{ opacity: c.globally_active ? 1 : 0.6 }}>
            <Vehicle type={c.code} width={c.code === 'tourist' ? 150 : 120} moving={c.globally_active} />
            <div className="row between"><strong>{c.name}</strong>
              <Switch checked={c.globally_active} label={`${c.name} active`} onChange={(v) => ask(`${v ? 'Resume' : 'Discontinue'} ${c.name} platform-wide?`, (reason) =>
                post(`/admin/categories/${c.id}/toggle`, { active: v, reason }).then(() => { toast(`${c.name} ${v ? 'resumed' : 'discontinued'}`); load() }))} /></div>
            <span className="small muted">{c.seats} seats{c.is_interstate ? ' · interstate' : ''}</span>
          </div>))}
      </div>
      <div className="panel table-wrap" style={{ marginTop: 20 }}><table className="table">
        <thead><tr><th>Vehicle</th><th>Driver</th><th>Insurance</th><th>Status</th><th /></tr></thead>
        <tbody>{vehicles.map((v) => <tr key={v.id}><td><span className="row"><Vehicle type={v.category} width={48} /><span><strong>{v.reg}</strong><div className="tiny muted">{v.make} {v.model}</div></span></span></td>
          <td>{v.driver}</td><td><span className={v.insurance_expired ? 'chip bad' : 'small'}>{date(v.insurance_expiry)}</span></td>
          <td><span className={`chip ${v.status === 'approved' ? 'good' : v.status === 'pending' ? 'warn' : 'bad'}`}>{titleCase(v.status)}</span></td>
          <td>{v.status === 'approved' ? <button className="btn ghost sm" onClick={() => ask(`Suspend ${v.reg}`, (reason) => post(`/admin/vehicles/${v.id}/status`, { status: 'suspended', reason }).then(load))}>Suspend</button>
               : <button className="btn sage sm" onClick={() => ask(`Approve ${v.reg}`, (reason) => post(`/admin/vehicles/${v.id}/status`, { status: 'approved', reason }).then(load))}>Approve</button>}</td></tr>)}</tbody>
      </table></div>
      {reasonUi}
    </>
  )
}

/* ================================================================== E. Cities + pricing */
export function Cities() {
  const toast = useToast()
  const [cities, setCities] = useState([])
  const [sel, setSel] = useState(null)
  const [adding, setAdding] = useState(false)
  const [ask, reasonUi] = useReasonPrompt()
  const load = () => get('/admin/cities').then((c) => { setCities(c); setSel((s) => s ? c.find((x) => x.id === s.id) : c[0]) })
  useEffect(() => { load() }, [])
  const setStatus = (c, status) => ask(`${status === 'active' ? 'Activate' : titleCase(status)} ${c.name}`, (reason) =>
    post(`/admin/cities/${c.id}/status`, { status, reason }).then(() => { toast(`${c.name} is now ${titleCase(status).toLowerCase()}`); load() }).catch(err(toast)))
  const tone = { active: 'good', paused: 'bad', pending_approval: 'warn', draft: '' }
  return (
    <>
      <PageHead title="Cities" sub="New cities start as drafts. Only the Super Admin can make a city live, and only once a vehicle type is enabled and priced.">
        <button className="btn" onClick={() => setAdding(true)}>Add city</button>
      </PageHead>
      <div className="cities-grid">
        <div className="panel" style={{ padding: 10 }}>
          {cities.map((c) => (
            <button key={c.id} className={`city-row ${sel?.id === c.id ? 'on' : ''}`} onClick={() => setSel(c)}>
              <span><strong>{c.name}</strong><span className="tiny muted" style={{ display: 'block' }}>{c.state} · {titleCase(c.tier)}</span></span>
              <span className={`chip ${tone[c.status]}`}>{titleCase(c.status)}</span>
            </button>))}
        </div>
        {sel && (
          <div className="stack lg">
            <div className="panel stack">
              <div className="row between wrap">
                <div><h2>{sel.name}</h2><p className="small muted">{sel.rides_30d} rides in 30 days · {titleCase(sel.tier)} pricing tier · open {sel.operating_hours.open}–{sel.operating_hours.close}</p></div>
                <div className="row">
                  {sel.status !== 'active' && <button className="btn" onClick={() => setStatus(sel, 'active')}>Activate city</button>}
                  {sel.status === 'active' && <button className="btn ghost" onClick={() => setStatus(sel, 'paused')}>Pause city</button>}
                  {sel.status === 'draft' && <button className="btn ghost" onClick={() => setStatus(sel, 'pending_approval')}>Request approval</button>}
                </div>
              </div>
              <div style={{ height: 220 }}><CityMap center={{ lat: sel.center[0], lng: sel.center[1] }} height={220} label={`${sel.name} service area`}
                markers={[...Array(14)].map((_, i) => ({ lat: sel.center[0] + Math.sin(i * 2.3) * 0.02, lng: sel.center[1] + Math.cos(i * 1.7) * 0.025, busy: i % 3 === 0, title: 'Driver' }))} /></div>
              <div className="row wrap">{sel.zones.map((z) => <span key={z.id} className="chip">{z.name} · {z.kind}</span>)}</div>
            </div>
            <div className="panel stack">
              <h3>Vehicle types in {sel.name}</h3>
              <div className="grid-4">{sel.vehicles.map((v) => (
                <div key={v.category_id} className="tile stack" style={{ opacity: v.globally_active ? 1 : 0.5 }}>
                  <Vehicle type={v.code} width={90} />
                  <div className="row between"><strong className="small">{v.name}</strong>
                    <Switch checked={v.active} label={`${v.name} in ${sel.name}`} disabled={!v.globally_active}
                            onChange={(a) => post(`/admin/cities/${sel.id}/vehicles/${v.category_id}`, { active: a }).then(load)} /></div>
                  {!v.globally_active && <span className="tiny muted">Discontinued platform-wide</span>}
                </div>))}</div>
            </div>
            <FareEditor city={sel} />
          </div>
        )}
      </div>
      {adding && <AddCity onClose={() => setAdding(false)} onDone={load} />}
      {reasonUi}
      <style>{`.cities-grid { display: grid; grid-template-columns: 300px 1fr; gap: 20px; align-items: start; }
        .city-row { width: 100%; display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 12px; border: 0; border-radius: 12px; background: none; cursor: pointer; text-align: left; }
        .city-row:hover { background: var(--cream-soft); } .city-row.on { background: var(--cream); }
        @media (max-width: 900px) { .cities-grid { grid-template-columns: 1fr; } }`}</style>
    </>
  )
}

function AddCity({ onClose, onDone }) {
  const toast = useToast()
  const [f, setF] = useState({ name: '', state: '', tier: 'tier_2', center_lat: '', center_lng: '' })
  return (
    <Modal title="Add a city" onClose={onClose}>
      <form className="stack" onSubmit={async (e) => { e.preventDefault(); try { await post('/admin/cities', { ...f, center_lat: Number(f.center_lat), center_lng: Number(f.center_lng) }); toast(`${f.name} added as a draft`); onDone(); onClose() } catch (er) { toast(er.detail || er.message, 'bad') } }}>
        <div className="grid-2"><Field label="City"><input className="input" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="State"><input className="input" required value={f.state} onChange={(e) => setF({ ...f, state: e.target.value })} /></Field></div>
        <Field label="Pricing tier"><select className="input" value={f.tier} onChange={(e) => setF({ ...f, tier: e.target.value })}><option value="metro">Metro</option><option value="tier_2">Tier-2</option><option value="other">Other</option></select></Field>
        <div className="grid-2"><Field label="Centre latitude"><input className="input" required inputMode="decimal" value={f.center_lat} onChange={(e) => setF({ ...f, center_lat: e.target.value })} /></Field>
          <Field label="Centre longitude"><input className="input" required inputMode="decimal" value={f.center_lng} onChange={(e) => setF({ ...f, center_lng: e.target.value })} /></Field></div>
        <p className="tiny muted">The city is created as a draft with all vehicle types off. Default fares for the tier are applied and can be edited.</p>
        <button className="btn">Add city</button>
      </form>
    </Modal>
  )
}

const FARE_FIELDS = [['base_fare', 'Base fare ₹'], ['per_km', 'Per km ₹'], ['per_min', 'Per minute ₹'], ['per_wait_min', 'Waiting per min ₹'], ['free_waiting_min', 'Free waiting (min)'], ['minimum_fare', 'Minimum fare ₹'], ['max_peak_multiplier', 'Max peak ×']]
function FareEditor({ city }) {
  const toast = useToast()
  const [rows, setRows] = useState([])
  const [edit, setEdit] = useState(null)
  const load = useCallback(() => get(`/admin/cities/${city.id}/fares`).then(setRows), [city.id])
  useEffect(() => { load() }, [load])
  return (
    <div className="panel">
      <div className="row between" style={{ marginBottom: 12 }}><h3>Fares in {city.name}</h3><span className="small muted">Each save creates a new version. Booked rides keep the fare version they were quoted with.</span></div>
      <div className="table-wrap"><table className="table">
        <thead><tr><th>Vehicle</th>{FARE_FIELDS.map(([, l]) => <th key={l}>{l}</th>)}<th>Peak windows</th><th /></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.category_id}><td><strong>{r.name}</strong><div className="tiny muted">v{r.rule?.version}</div></td>
          {FARE_FIELDS.map(([k]) => <td key={k}>{r.rule ? Number(r.rule[k]) : '—'}</td>)}
          <td className="tiny" style={{ whiteSpace: 'nowrap' }}>{(r.rule?.peak_windows || []).length ? r.rule.peak_windows.map((w) => <div key={w.start}>{w.start}–{w.end} ×{w.multiplier}</div>) : 'None'}</td>
          <td><button className="btn ghost sm" onClick={() => setEdit({ ...r, rule: { ...r.rule } })}>Edit</button></td></tr>)}</tbody>
      </table></div>
      {edit && (
        <Modal title={`${edit.name} fares in ${city.name}`} onClose={() => setEdit(null)}>
          <form className="stack" onSubmit={async (e) => { e.preventDefault()
            try { const body = Object.fromEntries(FARE_FIELDS.map(([k]) => [k, Number(edit.rule[k])])); body.peak_windows = edit.rule.peak_windows || []; body.tax_rate = Number(edit.rule.tax_rate || 0)
              await put(`/admin/cities/${city.id}/fares/${edit.category_id}`, body); toast('Fares updated'); setEdit(null); load() } catch (er) { toast(er.detail || er.message, 'bad') } }}>
            <div className="grid-2">{FARE_FIELDS.map(([k, l]) => <Field key={k} label={l}><input className="input" type="number" step="0.01" min="0" value={edit.rule[k]} onChange={(e) => setEdit({ ...edit, rule: { ...edit.rule, [k]: e.target.value } })} /></Field>)}</div>
            <Field label="Peak windows" hint='Format: 08:00-11:00 x1.25, one per line (weekdays)'>
              <textarea className="input" rows={3} value={(edit.rule.peak_windows || []).map((w) => `${w.start}-${w.end} x${w.multiplier}`).join('\n')}
                onChange={(e) => setEdit({ ...edit, rule: { ...edit.rule, peak_windows: e.target.value.split('\n').map((l) => l.match(/(\d\d:\d\d)\s*-\s*(\d\d:\d\d)\s*x\s*([\d.]+)/)).filter(Boolean).map(([, start, end, multiplier]) => ({ start, end, multiplier, weekdays: [0, 1, 2, 3, 4] })) } })} />
            </Field>
            <button className="btn">Save as new version</button>
          </form>
        </Modal>)}
    </div>
  )
}

/* ================================================================== F. Finance */
export function Finance() {
  const toast = useToast()
  const [comm, setComm] = useState(null)
  const [slabs, setSlabs] = useState([])
  const [settle, setSettle] = useState([])
  const [day, setDay] = useState(new Date(Date.now() - 864e5).toISOString().slice(0, 10))
  const [rec, setRec] = useState(null)
  const [ask, reasonUi] = useReasonPrompt()
  const load = () => { get('/admin/finance/commission').then((c) => { setComm(c); setSlabs(c.slabs) }); get('/admin/finance/settlements').then(setSettle) }
  useEffect(load, [])
  useEffect(() => { get(`/admin/finance/reconciliation?day=${day}`).then(setRec) }, [day])
  const preview = useMemo(() => [200, 500, 1000, 2500].map((f) => {
    let rate = Number(slabs[slabs.length - 1]?.rate || 0)
    for (const s of slabs) { if (s.upper === null || s.upper === '') { rate = Number(s.rate); break } if (s.upper_inclusive !== false ? f <= Number(s.upper) : f < Number(s.upper)) { rate = Number(s.rate); break } }
    return { f, rate, c: Math.round(f * rate * 100) / 100 }
  }), [slabs])
  if (!comm) return <Loader type="car" label="Loading finance" />
  const totals = settle.reduce((a, s) => ({ paid: a.paid + (s.status === 'paid' ? s.net : 0), failed: a.failed + (s.status === 'failed' ? 1 : 0), hold: a.hold + (s.status === 'on_hold' ? 1 : 0) }), { paid: 0, failed: 0, hold: 0 })
  return (
    <>
      <PageHead title="Finance" sub="Commission, next-day settlements, payouts and reconciliation. Payouts are marked paid only when the bank confirms." />
      <div className="grid-2">
        <div className="panel stack">
          <h3>Commission slabs</h3>
          <p className="small muted">The slab is picked by the final ride fare, and the whole fare is charged at that rate. Tolls, parking and taxes are never commissioned.</p>
          {slabs.map((s, i) => (
            <div key={i} className="row">
              <span className="small" style={{ width: 120 }}>{i === 0 ? 'Up to' : s.upper === null ? 'Everything above' : 'Up to'}</span>
              {s.upper !== null ? <input className="input" style={{ width: 110 }} type="number" value={s.upper} aria-label="Upper bound"
                onChange={(e) => setSlabs(slabs.map((x, j) => j === i ? { ...x, upper: e.target.value } : x))} /> : <span style={{ width: 110 }} className="small muted">no limit</span>}
              {s.upper !== null && <select className="input" style={{ width: 130 }} value={s.upper_inclusive === false ? 'lt' : 'le'} aria-label="Boundary"
                onChange={(e) => setSlabs(slabs.map((x, j) => j === i ? { ...x, upper_inclusive: e.target.value === 'le' } : x))}><option value="le">including</option><option value="lt">below</option></select>}
              <input className="input" style={{ width: 90 }} type="number" step="0.5" min="0" max="50" value={Math.round(Number(s.rate) * 1000) / 10} aria-label="Rate percent"
                onChange={(e) => setSlabs(slabs.map((x, j) => j === i ? { ...x, rate: String(Number(e.target.value) / 100) } : x))} /> <span>%</span>
            </div>))}
          <div className="grid-4">{preview.map((p) => <div key={p.f} className="tile small"><div className="muted">₹{num(p.f)} ride</div><strong>{rupees(p.c, true)}</strong><div className="tiny muted">{Math.round(p.rate * 100)}% · driver {rupees(p.f - p.c)}</div></div>)}</div>
          <button className="btn" onClick={() => ask('Update commission slabs', (reason) => put('/admin/finance/commission', { slabs, commission_tax_rate: 0, reason }).then(() => { toast('Commission updated'); load() }).catch(err(toast)))}>Save commission</button>
        </div>
        <div className="panel stack">
          <div className="row between"><h3>Daily reconciliation</h3><input type="date" className="input" style={{ width: 170 }} value={day} onChange={(e) => setDay(e.target.value)} aria-label="Day" /></div>
          {rec && (<>
            <div className="grid-2">
              <div className="tile small"><strong>Cash rides · {rec.cash.rides}</strong><div>Collected by drivers {rupees(rec.cash.collected_by_drivers)}</div><div>Commission receivable {rupees(rec.cash.commission_receivable)}</div></div>
              <div className="tile small"><strong>Online rides · {rec.online.rides}</strong><div>Collected {rupees(rec.online.collected)}</div><div>Payable to drivers {rupees(rec.online.driver_payable)}</div></div>
            </div>
            {rec.issues.length === 0 ? <span className="chip good">Rides, payments and ledger agree</span> :
              rec.issues.map((i) => <div key={i.ride} className="row between small"><span>{i.ride}</span><span className="chip warn">{i.issue}</span></div>)}
          </>)}
          <div className="grid-3" style={{ marginTop: 8 }}>
            <div className="tile"><div className="tiny muted">Paid yesterday</div><div className="num">{rupees(totals.paid)}</div></div>
            <div className="tile"><div className="tiny muted">Failed payouts</div><div className="num" style={{ color: 'var(--bad)' }}>{totals.failed}</div></div>
            <div className="tile"><div className="tiny muted">On hold</div><div className="num">{totals.hold}</div></div>
          </div>
        </div>
      </div>
      <div className="panel" style={{ marginTop: 20 }}>
        <div className="row between" style={{ marginBottom: 12 }}><h3>Settlements</h3>
          <button className="btn ghost sm" onClick={() => download(`/admin/reports/settlements.csv?start=${day}&end=${day}`, `settlements-${day}.csv`, [['Driver', 'Online', 'Cash commission', 'Net', 'Status'], ...settle.map((s) => [s.driver, s.online, s.cash_commission, s.net, s.status])])}>Export CSV</button></div>
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Driver</th><th>Online earnings</th><th>Cash commission</th><th>Net payout</th><th>Status</th><th>Bank / reason</th><th /></tr></thead>
          <tbody>{settle.map((s) => <tr key={s.id}><td>{s.driver}</td><td>{rupees(s.online)}</td><td>{rupees(s.cash_commission)}</td><td className="num">{rupees(s.net)}</td>
            <td><span className={`chip ${s.status === 'paid' ? 'good' : s.status === 'failed' ? 'bad' : 'warn'}`}>{titleCase(s.status)}</span></td>
            <td className="small">{s.payout?.utr || s.payout?.failure || s.note}</td>
            <td>{s.payout?.status === 'failed' && <button className="btn sm" onClick={() => post(`/admin/finance/payouts/${s.payout.id}/retry`).then(() => { toast('Payout retry queued'); load() }).catch(err(toast))}>Retry</button>}</td></tr>)}</tbody>
        </table></div>
      </div>
      {reasonUi}
    </>
  )
}

/* ================================================================== G. Complaints */
export function Complaints() {
  const toast = useToast()
  const [list, setList] = useState(null)
  const [filter, setFilter] = useState('open')
  const [sel, setSel] = useState(null)
  const [ask, reasonUi] = useReasonPrompt()
  const load = useCallback(() => get('/admin/complaints').then((l) => { setList(l); setSel((s) => s && l.find((x) => x.id === s.id)) }), [])
  useEffect(() => { load() }, [load])
  if (!list) return <Loader label="Loading complaints" />
  const shown = list.filter((c) => filter === 'all' ? true : filter === 'safety' ? c.priority === 'P1' : filter === 'open' ? !['resolved', 'rejected'].includes(c.status) : ['resolved', 'rejected'].includes(c.status))
    .sort((a, b) => a.priority.localeCompare(b.priority) || new Date(a.sla_due_at) - new Date(b.sla_due_at))
  const update = (body) => post(`/admin/complaints/${sel.id}/update`, body).then(() => { toast('Complaint updated'); load() }).catch(err(toast))
  return (
    <>
      <PageHead title="Complaints" sub="Safety issues (P1) are always at the top and must be answered within an hour.">
        <div className="row" role="tablist">{[['open', 'Open'], ['safety', 'Safety'], ['closed', 'Closed'], ['all', 'All']].map(([k, l]) => <button key={k} role="tab" aria-selected={filter === k} className={`btn sm ${filter === k ? '' : 'ghost'}`} onClick={() => setFilter(k)}>{l}</button>)}</div>
      </PageHead>
      <div className="cmp-grid">
        <div className="stack">{shown.map((c) => (
          <button key={c.id} className={`panel cmp ${sel?.id === c.id ? 'on' : ''}`} onClick={() => setSel(c)}>
            <div className="row between"><span className={`chip ${c.priority === 'P1' ? 'bad' : c.priority === 'P2' ? 'warn' : ''}`}>{c.priority}</span>{c.overdue && <span className="chip bad">Overdue</span>}<span className="tiny muted">{dateTime(c.created_at)}</span></div>
            <strong style={{ display: 'block', marginTop: 6 }}>{titleCase(c.category)}</strong>
            <p className="small muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.description}</p>
          </button>))}
          {shown.length === 0 && <Empty title="Nothing here">No complaints match this filter.</Empty>}
        </div>
        {sel ? (
          <div className="panel stack" style={{ position: 'sticky', top: 20, alignSelf: 'start' }}>
            <div className="row between"><h2>{sel.ticket}</h2><span className="chip">{titleCase(sel.status)}</span></div>
            <p>{sel.description}</p>
            <div className="tile small stack" style={{ gap: 4 }}><div>Raised by <strong>{sel.raised_by}</strong></div>{sel.against && <div>Against <strong>{sel.against}</strong></div>}<div>Respond by {dateTime(sel.sla_due_at)}</div></div>
            <div className="stack" style={{ gap: 6 }}>{sel.actions.map((a, i) => <div key={i} className="small" style={{ borderLeft: '3px solid var(--sage)', paddingLeft: 10 }}><strong>{titleCase(a.kind)}</strong>{a.internal && <span className="tiny muted"> (internal)</span>} · {a.body}</div>)}</div>
            <div className="row wrap">
              <button className="btn ghost sm" onClick={() => update({ kind: 'assign', body: 'Assigned to me' })}>Assign to me</button>
              <button className="btn ghost sm" onClick={() => ask('Add an internal note', (body) => update({ kind: 'note', body }))}>Add note</button>
              <button className="btn ghost sm" onClick={() => ask('Ask the customer for evidence', (body) => update({ kind: 'request_evidence', body }))}>Request evidence</button>
            </div>
            <hr className="divider" />
            <ResolveForm complaint={sel} onSubmit={update} />
            {sel.against_user_id && (<>
              <hr className="divider" />
              <div className="row wrap"><span className="small muted">Account actions on {sel.against}:</span>
                {[['warn', 'Warn'], ['restrict', 'Restrict'], ['suspend', 'Suspend']].map(([a, l]) => <button key={a} className={`btn sm ${a === 'suspend' ? 'danger' : 'ghost'}`}
                  onClick={() => ask(`${l} ${sel.against}`, (reason, days) => post(`/admin/users/${sel.against_user_id}/action`, { action: a, reason, days, complaint_id: sel.id }).then(() => toast(`${l} applied`)), a === 'warn' ? null : 'days')}>{l}</button>)}</div>
            </>)}
          </div>
        ) : <Empty title="Choose a complaint">Select a ticket to investigate, add notes, act on the account and resolve it.</Empty>}
      </div>
      {reasonUi}
      <style>{`.cmp-grid { display: grid; grid-template-columns: minmax(280px, 1fr) 1.3fr; gap: 20px; }
        .cmp { text-align: left; border: 2px solid transparent; cursor: pointer; width: 100%; padding: 16px; } .cmp.on { border-color: var(--accent); }
        @media (max-width: 900px) { .cmp-grid { grid-template-columns: 1fr; } }`}</style>
    </>
  )
}

function ResolveForm({ complaint, onSubmit }) {
  const [body, setBody] = useState('')
  const [upheld, setUpheld] = useState(true)
  const [severity, setSeverity] = useState('minor')
  const safety = ['unsafe_driving', 'harassment_safety'].includes(complaint.category)
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); onSubmit({ kind: 'resolve', body, upheld, severity: safety && upheld ? severity : null }) }}>
      <Field label="Resolution message to the customer"><textarea className="input" rows={3} required value={body} onChange={(e) => setBody(e.target.value)} /></Field>
      <div className="row wrap">
        <label className="row small"><input type="checkbox" checked={upheld} onChange={(e) => setUpheld(e.target.checked)} /> Complaint upheld</label>
        {safety && upheld && <select className="input" style={{ width: 'auto' }} value={severity} onChange={(e) => setSeverity(e.target.value)} aria-label="Severity">
          <option value="minor">Minor</option><option value="major">Major</option><option value="critical">Critical</option></select>}
      </div>
      {safety && upheld && <p className="tiny muted">Upheld safety complaints lower the driver’s ranking for 90 days.</p>}
      <button className="btn">Resolve and notify</button>
    </form>
  )
}

/* ================================================================== H. Configuration */
export function Settings() {
  const toast = useToast()
  const [cfg, setCfg] = useState(null)
  const [coupons, setCoupons] = useState([])
  const [admins, setAdmins] = useState(null)
  const [newCoupon, setNewCoupon] = useState(null)
  const [ask, reasonUi] = useReasonPrompt()
  const load = () => { get('/admin/config').then(setCfg); get('/admin/coupons').then(setCoupons); get('/admin/admins').then(setAdmins) }
  useEffect(load, [])
  if (!cfg) return <Loader label="Loading configuration" />
  const pol = cfg.cancellation_policy
  const setPol = (k, v) => setCfg({ ...cfg, cancellation_policy: { ...pol, [k]: v } })
  return (
    <>
      <PageHead title="Configuration" sub="Policies, promotions and admin roles. Every change needs a reason and is written to the audit log." />
      <div className="grid-2">
        <div className="panel stack">
          <h3>Cancellation policy</h3>
          <p className="small muted">Both rider and driver can cancel free within the window, counted from when the ride was booked. It can be made longer, never shorter than 15 minutes.</p>
          <div className="grid-2">
            {[['free_window_min', 'Free window (minutes)'], ['customer_fee_after_window', 'Rider fee after window ₹'], ['customer_fee_if_driver_arrived', 'Rider fee if driver arrived ₹'],
              ['driver_fee_after_window', 'Driver fee after window ₹'], ['abuse_threshold', 'Cancellations before cooldown (24 h)'], ['cooldown_minutes', 'Booking cooldown (minutes)']].map(([k, l]) => (
              <Field key={k} label={l}><input className="input" type="number" min={k === 'free_window_min' ? 15 : 0} value={pol[k]} onChange={(e) => setPol(k, e.target.value)} /></Field>))}
          </div>
          <label className="row small"><Switch checked={!!pol.charge_after_threshold} onChange={(v) => setPol('charge_after_threshold', v)} label="Charge repeat cancellers" /> Charge a fee for repeat cancellations even inside the free window</label>
          <button className="btn" onClick={() => ask('Update cancellation policy', (reason) => put('/admin/config/cancellation_policy', { value: pol, reason }).then(() => toast('Policy updated')).catch(err(toast)))}>Save policy</button>
        </div>
        <div className="stack lg">
          <div className="panel stack">
            <div className="row between"><h3>Promotions</h3><button className="btn sm" onClick={() => setNewCoupon({ code: '', description: '', kind: 'flat', value: 50, max_discount: 50, min_fare: 0, per_user_limit: 1, valid_days: 30 })}>New coupon</button></div>
            {coupons.map((c) => <div key={c.code} className="row between small"><span><strong>{c.code}</strong> · {c.description}</span><span className={`chip ${c.active ? 'good' : ''}`}>until {date(c.valid_to)}</span></div>)}
          </div>
          <div className="panel stack">
            <h3>Referral & safety numbers</h3>
            <div className="small">Referrer reward ₹{cfg.referral.referrer_reward} · new rider ₹{cfg.referral.referee_reward}</div>
            <div className="small">SOS: police {cfg.sos.police} · women helpline {cfg.sos.women_helpline} · ops desk {cfg.sos.ops_desk}</div>
            <div className="small">Dispatch radius {cfg.dispatch.radius_km} km · offer timeout {cfg.dispatch.offer_timeout_sec} s · settlement run {cfg.settlement.run_at_ist} IST</div>
          </div>
        </div>
      </div>
      {admins && (
        <div className="panel" style={{ marginTop: 20 }}>
          <h3 style={{ marginBottom: 12 }}>Admin roles and permissions</h3>
          <div className="table-wrap"><table className="table"><thead><tr><th>Admin</th><th>Role</th><th>Can</th></tr></thead>
            <tbody>{admins.admins.map((a) => <tr key={a.id}><td><strong>{a.name}</strong><div className="tiny muted">{a.email}</div></td><td>{titleCase(a.admin_role)}</td>
              <td className="tiny">{admins.roles[a.admin_role].map((p) => titleCase(p.replace(':', ' '))).join(', ')}</td></tr>)}</tbody></table></div>
        </div>)}
      {newCoupon && (
        <Modal title="New coupon" onClose={() => setNewCoupon(null)}>
          <form className="stack" onSubmit={async (e) => { e.preventDefault()
            const from = new Date(), to = new Date(Date.now() + newCoupon.valid_days * 864e5)
            try { await post('/admin/coupons', { ...newCoupon, code: newCoupon.code.toUpperCase(), value: Number(newCoupon.value), max_discount: Number(newCoupon.max_discount), min_fare: Number(newCoupon.min_fare),
              per_user_limit: Number(newCoupon.per_user_limit), valid_from: from.toISOString(), valid_to: to.toISOString(), valid_days: undefined }); toast('Coupon created'); setNewCoupon(null); load() } catch (er) { toast(er.detail || er.message, 'bad') } }}>
            <div className="grid-2">
              <Field label="Code"><input className="input" required pattern="[A-Za-z0-9]{4,20}" value={newCoupon.code} onChange={(e) => setNewCoupon({ ...newCoupon, code: e.target.value })} /></Field>
              <Field label="Type"><select className="input" value={newCoupon.kind} onChange={(e) => setNewCoupon({ ...newCoupon, kind: e.target.value })}><option value="flat">Flat ₹</option><option value="percent">Percent</option></select></Field>
              <Field label="Value"><input className="input" type="number" min="1" value={newCoupon.value} onChange={(e) => setNewCoupon({ ...newCoupon, value: e.target.value })} /></Field>
              <Field label="Max discount ₹"><input className="input" type="number" min="1" value={newCoupon.max_discount} onChange={(e) => setNewCoupon({ ...newCoupon, max_discount: e.target.value })} /></Field>
              <Field label="Minimum fare ₹"><input className="input" type="number" min="0" value={newCoupon.min_fare} onChange={(e) => setNewCoupon({ ...newCoupon, min_fare: e.target.value })} /></Field>
              <Field label="Valid for (days)"><input className="input" type="number" min="1" value={newCoupon.valid_days} onChange={(e) => setNewCoupon({ ...newCoupon, valid_days: e.target.value })} /></Field>
            </div>
            <Field label="Description shown to riders"><input className="input" required value={newCoupon.description} onChange={(e) => setNewCoupon({ ...newCoupon, description: e.target.value })} /></Field>
            <p className="tiny muted">Discounts are funded by VAYORA. Drivers are paid on the full fare.</p>
            <button className="btn">Create coupon</button>
          </form>
        </Modal>)}
      {reasonUi}
    </>
  )
}

/* ================================================================== Audit log + reports */
export function Audit() {
  const [rows, setRows] = useState([])
  const [range, setRange] = useState({ start: new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10), end: new Date().toISOString().slice(0, 10) })
  useEffect(() => { get('/admin/audit').then(setRows) }, [])
  const report = async (kind) => {
    const rides = kind === 'rides' ? await get('/admin/rides') : []
    download(`/admin/reports/${kind}.csv?start=${range.start}&end=${range.end}`, `vayora-${kind}-${range.start}-${range.end}.csv`,
      kind === 'rides' ? [['Code', 'City', 'Vehicle', 'Status', 'Payment', 'Total'], ...rides.map((r) => [r.code, r.city, r.category, r.status, r.payment_method, r.final?.total])] : [['Report'], [`${kind} report is generated by the server in live mode`]])
  }
  return (
    <>
      <PageHead title="Audit log & reports" sub="Every admin change, who made it, why, and what it changed. The log cannot be edited or deleted." />
      <div className="panel stack" style={{ marginBottom: 20 }}>
        <div className="row wrap between"><h3>Download reports</h3>
          <div className="row"><input type="date" className="input" value={range.start} onChange={(e) => setRange({ ...range, start: e.target.value })} aria-label="From" />
            <input type="date" className="input" value={range.end} onChange={(e) => setRange({ ...range, end: e.target.value })} aria-label="To" /></div></div>
        <div className="row wrap">{['rides', 'cancellations', 'complaints', 'settlements', 'drivers'].map((k) => <button key={k} className="btn ghost sm" onClick={() => report(k)}>{titleCase(k)} (CSV)</button>)}</div>
      </div>
      <div className="panel table-wrap">
        {rows.length === 0 ? <p className="muted small">No admin actions yet in this session. Try approving a driver or changing a fare, then come back.</p> : (
          <table className="table"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Change</th><th>Reason</th></tr></thead>
            <tbody>{rows.map((a) => <tr key={a.id}><td className="small">{dateTime(a.at)}</td><td>{titleCase(a.actor_role)}</td><td><span className="chip">{a.action}</span></td><td className="small">{a.entity} #{a.entity_id}</td>
              <td className="tiny" style={{ maxWidth: 320 }}>{a.before && <div className="muted">Before: {JSON.stringify(a.before)}</div>}{a.after && <div>After: {JSON.stringify(a.after)}</div>}</td><td className="small">{a.reason}</td></tr>)}</tbody></table>)}
      </div>
    </>
  )
}
