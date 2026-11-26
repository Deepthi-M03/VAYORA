import { useEffect, useMemo, useState } from 'react'
import { RouterProvider, Stage, useRouter } from './lib/router.jsx'
import { LangCtx } from './lib/i18n.js'
import { SessionProvider, getChosenVehicle, homeFor, useSession } from './lib/session.jsx'
import { Loader, ToastProvider } from './components/ui.jsx'
import { AdminLayout, CustomerLayout, DriverLayout } from './components/Layouts.jsx'
import Landing from './pages/Landing.jsx'
import { Forgot, Login, Register, Reset } from './pages/Auth.jsx'
import Book from './pages/customer/Book.jsx'
import Ride from './pages/customer/Ride.jsx'
import { History, Offers, Profile, Support } from './pages/customer/Account.jsx'
import { Drive, Earnings, Onboarding, Performance } from './pages/driver/Driver.jsx'
import { Audit, Cities, Complaints, Customers, Drivers, Finance, Fleet, Overview, Settings } from './pages/admin/Admin.jsx'

const ROUTES = [
  { path: '/', page: Landing },
  { path: '/login', page: Login },
  { path: '/register', page: Register },
  { path: '/forgot', page: Forgot },
  { path: '/reset', page: Reset },
  { path: '/book', page: Book, role: 'customer', layout: CustomerLayout },
  { path: '/ride/:id', page: Ride, role: 'customer', layout: CustomerLayout },
  { path: '/rides', page: History, role: 'customer', layout: CustomerLayout },
  { path: '/offers', page: Offers, role: 'customer', layout: CustomerLayout },
  { path: '/support', page: Support, role: 'customer', layout: CustomerLayout },
  { path: '/profile', page: Profile, role: 'customer', layout: CustomerLayout },
  { path: '/driver', page: Drive, role: 'driver', layout: DriverLayout },
  { path: '/driver/earnings', page: Earnings, role: 'driver', layout: DriverLayout },
  { path: '/driver/performance', page: Performance, role: 'driver', layout: DriverLayout },
  { path: '/driver/onboarding', page: Onboarding, role: 'driver', layout: DriverLayout },
  { path: '/driver/rides', page: History, role: 'driver', layout: DriverLayout },
  { path: '/admin', page: Overview, role: 'admin', layout: AdminLayout },
  { path: '/admin/drivers', page: Drivers, role: 'admin', layout: AdminLayout },
  { path: '/admin/customers', page: Customers, role: 'admin', layout: AdminLayout },
  { path: '/admin/fleet', page: Fleet, role: 'admin', layout: AdminLayout },
  { path: '/admin/cities', page: Cities, role: 'admin', layout: AdminLayout },
  { path: '/admin/finance', page: Finance, role: 'admin', layout: AdminLayout },
  { path: '/admin/complaints', page: Complaints, role: 'admin', layout: AdminLayout },
  { path: '/admin/settings', page: Settings, role: 'admin', layout: AdminLayout },
  { path: '/admin/audit', page: Audit, role: 'admin', layout: AdminLayout },
  { path: '*', page: NotFound },
]

function NotFound() {
  const { navigate } = useRouter()
  return <div style={{ display: 'grid', placeItems: 'center', minHeight: '80vh', textAlign: 'center' }} className="stack">
    <Loader type="tourist" label="This road doesn’t go anywhere" /><button className="btn" onClick={() => navigate('/')}>Back to home</button></div>
}

function Guard({ route, children }) {
  const { user } = useSession()
  const { navigate, path } = useRouter()
  const blocked = route.role && (!user || user.role !== route.role)
  useEffect(() => {
    if (!blocked) return
    navigate(user ? homeFor(user) : `/login?next=${encodeURIComponent(path)}`, { replace: true })
  }, [blocked]) // eslint-disable-line react-hooks/exhaustive-deps
  return blocked ? null : children
}

function renderMatch(m) {
  const { route } = m
  const Page = route.page
  const page = <Guard route={route}><Page /></Guard>
  return route.layout ? <route.layout>{page}</route.layout> : page
}

function vehicleFor(m) {
  if (m.path.startsWith('/driver')) return 'auto'
  if (m.path.startsWith('/admin')) return 'car'
  return getChosenVehicle()
}

function Shell() {
  const { ready } = useSession()
  if (!ready) return <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}><Loader label="Starting VAYORA" /></div>
  return (
    <RouterProvider routes={ROUTES.map((r) => ({ ...r, path: r.path === '*' ? '.*' : r.path }))} defaultVehicle={vehicleFor}>
      {({ current, next, finish }) => <Stage current={current} next={next} finish={finish} render={renderMatch} />}
    </RouterProvider>
  )
}

export default function App() {
  const [lang, setLang] = useState(() => { try { return localStorage.getItem('vy_lang') || 'en' } catch { return 'en' } })
  const langValue = useMemo(() => ({ lang, setLang: (l) => { setLang(l); try { localStorage.setItem('vy_lang', l) } catch { /* ignore */ } } }), [lang])
  useEffect(() => { document.documentElement.lang = lang }, [lang])
  return (
    <LangCtx.Provider value={langValue}>
      <ToastProvider>
        <SessionProvider><Shell /></SessionProvider>
      </ToastProvider>
    </LangCtx.Provider>
  )
}
