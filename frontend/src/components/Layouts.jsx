import { useContext, useEffect, useState } from 'react'
import { Link, useRouter } from '../lib/router.jsx'
import { LANGS, LangCtx, useT } from '../lib/i18n.js'
import { useSession } from '../lib/session.jsx'
import { get } from '../api/client.js'
import Assistant from '../assistant/Assistant.jsx'

export function Brand({ light }) {
  return (
    <Link to="/" className="brand" style={{ color: light ? 'var(--cream)' : 'var(--ink)' }} aria-label="VAYORA home">
      <span className="brand-mark" style={light ? { background: 'var(--cream)' } : undefined}><svg width="20" height="20" viewBox="0 0 24 24"><path d="M4 5l8 15 8-15" stroke={light ? 'var(--accent)' : 'var(--cream)'} strokeWidth="3.4" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg></span>
      VAYORA
    </Link>
  )
}

function DemoBanner() {
  const { demo } = useSession()
  if (!demo) return null
  return <div style={{ background: 'var(--ink)', color: 'var(--cream)', fontSize: 'var(--t-xs)', textAlign: 'center', padding: '6px 12px' }}>
    Demo mode: the app is running on sample data in your browser. Connect the Python API to go live.
  </div>
}

export function CustomerLayout({ children }) {
  const t = useT()
  const { user, logout } = useSession()
  const { lang, setLang } = useContext(LangCtx)
  const { navigate } = useRouter()
  const [unread, setUnread] = useState(0)
  useEffect(() => { get('/notifications').then((n) => setUnread(n.filter((x) => !x.read).length)).catch(() => {}) }, [])
  return (
    <div style={{ minHeight: '100vh', background: 'var(--sage-mist)' }}>
      <DemoBanner />
      <header className="topbar">
        <Brand />
        <nav aria-label="Rider">
          <Link to="/book">{t('book')}</Link>
          <Link to="/rides">{t('rides')}</Link>
          <Link to="/offers">{t('offers')}</Link>
          <Link to="/support">{t('support')}</Link>
        </nav>
        <div className="row">
          <select className="input" style={{ width: 'auto', padding: '7px 10px' }} value={lang} onChange={(e) => setLang(e.target.value)} aria-label="Language">
            {Object.entries(LANGS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <Link to="/profile" className="btn ghost sm" aria-label={`Profile${unread ? `, ${unread} unread notifications` : ''}`}>
            {user?.name?.split(' ')[0]}{unread > 0 && <span className="chip accent" style={{ padding: '0 7px' }}>{unread}</span>}
          </Link>
          <button className="btn ghost sm" onClick={() => { logout(); navigate('/') }}>{t('signout')}</button>
        </div>
      </header>
      <main className="main" style={{ maxWidth: 1360, margin: '0 auto' }}>{children}</main>
      <Assistant role="customer" />
    </div>
  )
}

function RailLayout({ items, children, role, footer }) {
  const { user, logout } = useSession()
  const { navigate } = useRouter()
  return (
    <>
      <DemoBanner />
      <div className="shell">
        <aside className="rail" aria-label="Sections">
          <div className="brand"><Brand light /></div>
          {items.map(([to, label, vehicle]) => <Link key={to} to={to} vehicle={vehicle}>{label}</Link>)}
          <div className="foot">
            {footer}
            <div style={{ marginTop: 10 }}>{user?.name}</div>
            <button className="btn ghost sm" style={{ color: 'var(--cream)', marginTop: 8, boxShadow: 'inset 0 0 0 1px rgba(232,210,181,.3)' }}
                    onClick={() => { logout(); navigate('/') }}>Sign out</button>
          </div>
        </aside>
        <main className="main">{children}</main>
      </div>
      <Assistant role={role} />
    </>
  )
}

export function DriverLayout({ children }) {
  return <RailLayout role="driver" items={[['/driver', 'Drive'], ['/driver/earnings', 'Earnings'], ['/driver/performance', 'Ranking'], ['/driver/onboarding', 'Documents'], ['/driver/rides', 'Trip history']]}>{children}</RailLayout>
}

export function AdminLayout({ children }) {
  return (
    <RailLayout role="admin" footer={<span className="chip" style={{ background: 'rgba(232,210,181,.12)', color: 'var(--cream)' }}>Super Admin</span>}
      items={[['/admin', 'Overview', 'car'], ['/admin/drivers', 'Drivers', 'auto'], ['/admin/customers', 'Customers', 'bike'], ['/admin/fleet', 'Vehicles', 'auto'],
              ['/admin/cities', 'Cities', 'tourist'], ['/admin/finance', 'Finance', 'car'], ['/admin/complaints', 'Complaints', 'bike'],
              ['/admin/settings', 'Configuration', 'car'], ['/admin/audit', 'Audit & reports', 'tourist']]}>
      {children}
    </RailLayout>
  )
}

export function PageHead({ title, sub, children }) {
  return (
    <div className="page-head">
      <div><h1>{title}</h1>{sub && <p className="muted" style={{ marginTop: 6, maxWidth: 620 }}>{sub}</p>}</div>
      {children && <div className="row wrap">{children}</div>}
    </div>
  )
}
