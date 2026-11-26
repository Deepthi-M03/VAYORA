import { useEffect, useState } from 'react'
import { Link, useRouter } from '../lib/router.jsx'
import { Brand } from '../components/Layouts.jsx'
import { useReveal } from '../components/ui.jsx'
import RoadScene from '../motion/RoadScene.jsx'
import { Vehicle } from '../motion/vehicles.jsx'
import { homeFor, setChosenVehicle, useSession } from '../lib/session.jsx'
import { get } from '../api/client.js'

const LINEUP = [
  { type: 'bike', name: 'Bike', seats: '1 rider', line: 'Fastest through traffic. Helmet provided.', from: 40 },
  { type: 'auto', name: 'Auto', seats: 'Up to 3', line: 'The everyday ride, metered fairly.', from: 60 },
  { type: 'car', name: 'Car', seats: 'Up to 4', line: 'AC sedans and hatchbacks for the city.', from: 120 },
  { type: 'tourist', name: 'Tourist', seats: 'Up to 7', line: 'Outstation and interstate trips with tourist permits.', from: 2500 },
]

export default function Landing() {
  useReveal()
  const { user } = useSession()
  const { navigate } = useRouter()
  const [sel, setSel] = useState('auto')
  const [cities, setCities] = useState([])
  useEffect(() => { get('/cities').then(setCities).catch(() => {}) }, [])
  const go = (to, vehicle = sel) => { setChosenVehicle(vehicle); navigate(user ? to : '/login?next=' + encodeURIComponent(to), { vehicle }) }
  const [w, setW] = useState(window.innerWidth)
  useEffect(() => { const f = () => setW(window.innerWidth); addEventListener('resize', f); return () => removeEventListener('resize', f) }, [])

  return (
    <div style={{ background: 'var(--sage-mist)' }}>
      {/* ------------------------------------------------ hero */}
      <section style={{ background: 'var(--accent)', color: 'var(--cream)', position: 'relative', overflow: 'hidden' }}>
        <header className="row between" style={{ padding: '20px clamp(18px, 4vw, 56px)' }}>
          <Brand light />
          <nav className="row" aria-label="Main">
            <a href="#drive" className="hide-sm" style={{ color: 'var(--cream)', textDecoration: 'none', opacity: .85 }}>Drive with us</a>
            <a href="/" onClick={(e) => { e.preventDefault(); document.getElementById("cities")?.scrollIntoView({ behavior: "smooth" }) }} className="hide-sm" style={{ color: 'var(--cream)', textDecoration: 'none', opacity: .85, marginLeft: 18 }}>Cities</a>
            {user ? <Link to={homeFor(user)} className="btn cream sm">Open app</Link>
                  : <><Link to="/login" className="btn sm" style={{ background: 'transparent', boxShadow: 'inset 0 0 0 1.5px rgba(232,210,181,.5)' }}>Sign in</Link>
                     <Link to="/register" className="btn cream sm">Create account</Link></>}
          </nav>
        </header>
        <div className="hero-grid">
          <div style={{ alignSelf: 'center', paddingBottom: 40 }}>
            <h1 className="hero-title">Go anywhere.<br />Know the fare first.</h1>
            <p style={{ fontSize: 'var(--t-lg)', maxWidth: 520, marginTop: 22, opacity: .9, lineHeight: 1.5 }}>
              Bikes, autos, cars and outstation tourist vehicles across India. Free cancellation for 15 minutes, and your phone number is never shared with the driver.
            </p>
            <div className="hero-book glass">
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                {LINEUP.map((v) => (
                  <button key={v.type} onClick={() => setSel(v.type)} aria-pressed={sel === v.type} className="veh-pill">
                    <Vehicle type={v.type} width={v.type === 'tourist' ? 54 : 44} /> {v.name}
                  </button>
                ))}
              </div>
              <button className="btn lg block" onClick={() => go('/book')}>Book {sel === "auto" ? "an" : "a"} {LINEUP.find((x) => x.type === sel).name.toLowerCase()} ride</button>
            </div>
          </div>
          <div className="hero-road"><RoadScene size={Math.min(600, Math.max(320, w * 0.42))} /></div>
        </div>
      </section>

      {/* ------------------------------------------------ lineup */}
      <section className="section">
        <div className="section-head" data-reveal>
          <h2>Pick what fits the trip</h2>
          <p className="muted">You only see vehicle types running in your city right now. Prices shown are minimum fares in metro cities.</p>
        </div>
        <div className="lineup" data-reveal>
          {LINEUP.map((v) => (
            <button key={v.type} className="lineup-card" onClick={() => go('/book', v.type)}>
              <div className="lineup-art"><Vehicle type={v.type} width={v.type === 'tourist' ? 200 : 160} /></div>
              <div className="row between"><h3>{v.name}</h3><span className="muted small">{v.seats}</span></div>
              <p className="muted small" style={{ minHeight: 42 }}>{v.line}</p>
              <div className="num" style={{ fontSize: 'var(--t-lg)', color: 'var(--accent)' }}>from ₹{v.from.toLocaleString('en-IN')}</div>
            </button>
          ))}
        </div>
      </section>

      {/* ------------------------------------------------ fare transparency */}
      <section className="section split">
        <div data-reveal>
          <h2>How your fare is worked out</h2>
          <p className="muted" style={{ marginTop: 12, maxWidth: 480 }}>
            Every city sets its own rates for each vehicle. You see a fare range before you book. The final fare uses the distance and time actually travelled, and the receipt shows both.
          </p>
        </div>
        <div className="panel receipt" data-reveal>
          <div className="row between"><strong>Car · Chennai · 9.4 km · 27 min</strong><span className="chip">Example</span></div>
          <hr className="divider" />
          {[['Base fare', 60], ['Distance · 9.4 km × ₹18', 169.2], ['Time · 27 min × ₹2', 54], ['Waiting after 3 free minutes', 4]].map(([l, a]) => (
            <div key={l} className="row between small"><span>{l}</span><span>₹{a.toFixed(2)}</span></div>
          ))}
          <div className="row between small muted"><span>Peak hours (8–11 am, 5:30–9 pm weekdays)</span><span>×1.25 when it applies</span></div>
          <hr className="divider" />
          <div className="row between"><span>Estimate shown before booking</span><span className="num">₹283 – ₹291</span></div>
          <div className="row between"><strong>Final fare</strong><span className="num" style={{ fontSize: 'var(--t-xl)', color: 'var(--accent)' }}>₹287</span></div>
        </div>
      </section>

      {/* ------------------------------------------------ safety */}
      <section className="section safety" data-reveal>
        <h2 style={{ maxWidth: 640 }}>Safe by design, not by checkbox</h2>
        <div className="grid-4" style={{ marginTop: 28 }}>
          {[['Private calls', 'Calls between you and the driver go through a temporary VAYORA number. Neither of you sees the other’s phone number.'],
            ['Trip OTP', 'The ride only starts when you tell the driver your 4-digit code, so you always get into the right vehicle.'],
            ['SOS in one tap', 'Alerts our safety desk and your emergency contacts with your live location and the trip details.'],
            ['Verified drivers', 'Licence, ID, registration, insurance and bank account are checked by our team before a driver goes online.']].map(([h, b]) => (
            <div key={h} className="tile" style={{ background: 'rgba(247,241,232,.7)' }}><h3>{h}</h3><p className="small muted" style={{ marginTop: 8 }}>{b}</p></div>
          ))}
        </div>
      </section>

      {/* ------------------------------------------------ drivers */}
      <section id="drive" className="section split" style={{ alignItems: 'center' }}>
        <div data-reveal>
          <h2>Drive with VAYORA and get paid the next morning</h2>
          <p className="muted" style={{ marginTop: 12, maxWidth: 520 }}>
            Earnings from online payments reach your bank the next day. Commission on cash rides is deducted from that payout, never twice. Your ranking is built only from verified ratings and your own record, and you can see exactly what moves it.
          </p>
          <div className="row" style={{ marginTop: 22 }}>
            <Link to="/register?role=driver" vehicle="auto" className="btn">Register as a driver</Link>
          </div>
        </div>
        <div className="panel" data-reveal>
          <h3 style={{ marginBottom: 12 }}>Commission you keep track of</h3>
          <table className="table">
            <thead><tr><th>Ride fare</th><th>VAYORA</th><th>Example</th></tr></thead>
            <tbody>
              <tr><td>Up to ₹300</td><td>10%</td><td>₹200 ride: you keep ₹180</td></tr>
              <tr><td>Above ₹300, below ₹700</td><td>15%</td><td>₹500 ride: you keep ₹425</td></tr>
              <tr><td>₹700 and above</td><td>20%</td><td>₹1,000 ride: you keep ₹800</td></tr>
            </tbody>
          </table>
          <p className="tiny muted" style={{ marginTop: 10 }}>Tolls and parking are paid to you in full. Coupon discounts are paid by VAYORA, not by you.</p>
        </div>
      </section>

      {/* ------------------------------------------------ cities */}
      <section id="cities" className="section" data-reveal>
        <h2>Where we run today</h2>
        <div className="row wrap" style={{ marginTop: 20, gap: 10 }}>
          {cities.map((c) => <span key={c.id} className="city-chip"><span className="dot" style={{ color: 'var(--good)' }} /> {c.name}</span>)}
          {['Thiruvananthapuram', 'Kolkata', 'Ahmedabad', 'Jaipur'].filter((n) => !cities.some((c) => c.name === n)).map((n) => <span key={n} className="city-chip muted">{n} · soon</span>)}
        </div>
      </section>

      <footer style={{ background: 'var(--ink)', color: 'var(--cream)', padding: '40px clamp(18px, 4vw, 56px)' }}>
        <div className="row between wrap">
          <Brand light />
          <span className="small" style={{ opacity: .7 }}>© {new Date().getFullYear()} VAYORA Mobility. Safety desk: 24×7 in-app SOS.</span>
        </div>
      </footer>

      <style>{`
        .hero-grid { display: grid; grid-template-columns: 1.05fr 1fr; gap: 24px; padding: 20px clamp(18px, 4vw, 56px) 0; min-height: min(760px, 88vh); }
        .hero-title { font-size: var(--t-5xl); font-weight: 800; letter-spacing: -0.035em; line-height: .95; font-stretch: 85%; }
        .hero-road { display: flex; align-items: end; justify-content: end; }
        .hero-book { margin-top: 30px; padding: 14px; display: grid; gap: 12px; max-width: 520px; background: rgba(247,241,232,.12); border-color: rgba(232,210,181,.25); }
        .veh-pill { display: inline-flex; align-items: center; gap: 6px; padding: 4px 12px 4px 6px; border-radius: 99px; border: 0; cursor: pointer;
          background: rgba(232,210,181,.14); color: var(--cream); font-weight: 600; transition: background .2s; }
        .veh-pill[aria-pressed="true"] { background: var(--cream); color: var(--accent); }
        .section { padding: clamp(56px, 8vw, 110px) clamp(18px, 4vw, 56px); max-width: 1320px; margin: 0 auto; }
        .section-head { display: flex; justify-content: space-between; align-items: end; gap: 24px; flex-wrap: wrap; margin-bottom: 30px; }
        .section-head p { max-width: 420px; }
        .section h2 { font-size: var(--t-3xl); }
        .split { display: grid; grid-template-columns: 1fr 1fr; gap: clamp(24px, 5vw, 80px); }
        .lineup { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; }
        .lineup-card { text-align: left; border: 0; cursor: pointer; background: var(--paper); border-radius: var(--r-lg); padding: 18px; display: grid; gap: 8px;
          transition: transform .3s var(--ease-out), box-shadow .3s; }
        .lineup-card:hover { transform: translateY(-4px); box-shadow: var(--shadow-2); }
        .lineup-card:hover .lineup-art > div { animation: nudge .9s var(--ease-out); }
        @keyframes nudge { 40% { transform: translateX(14px) } }
        .lineup-art { height: 120px; display: grid; place-items: end center; background: linear-gradient(180deg, transparent 78%, #3a3630 78%, #3a3630 88%, transparent 88%); border-radius: 14px; }
        .receipt { display: grid; gap: 10px; }
        .safety { background: var(--sage); border-radius: var(--r-lg); max-width: 1260px; }
        .city-chip { display: inline-flex; align-items: center; gap: 8px; padding: 10px 16px; background: var(--paper); border-radius: 99px; font-weight: 600; }
        @media (max-width: 900px) { .hero-grid, .split { grid-template-columns: 1fr; } .lineup { grid-template-columns: 1fr 1fr; } .hero-road { justify-content: center; } .hide-sm { display: none; } }
      `}</style>
    </div>
  )
}
