import { useState } from 'react'
import { Link, useRouter } from '../lib/router.jsx'
import { Brand } from '../components/Layouts.jsx'
import { Field, useToast } from '../components/ui.jsx'
import { Vehicle } from '../motion/vehicles.jsx'
import { DEMO, post, setTokens } from '../api/client.js'
import { homeFor, useSession } from '../lib/session.jsx'

function Frame({ title, sub, children, vehicle = 'car' }) {
  return (
    <div className="auth-wrap">
      <div className="auth-art" aria-hidden="true">
        <Brand light />
        <div>
          <p style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--t-3xl)', lineHeight: 1.05, maxWidth: 380, fontWeight: 700 }}>
            Your ride, your fare and your privacy, all visible before you go.
          </p>
        </div>
        <div className="auth-road"><Vehicle type={vehicle} moving width={180} className="auth-veh" /></div>
      </div>
      <div className="auth-form">
        <div style={{ width: 'min(420px, 100%)' }} className="stack lg">
          <div><h1 style={{ fontSize: 'var(--t-3xl)' }}>{title}</h1>{sub && <p className="muted" style={{ marginTop: 8 }}>{sub}</p>}</div>
          {children}
        </div>
      </div>
      <style>{`
        .auth-wrap { display: grid; grid-template-columns: 1fr 1fr; min-height: 100vh; }
        .auth-art { background: var(--accent); color: var(--cream); padding: 32px; display: flex; flex-direction: column; justify-content: space-between; overflow: hidden; }
        .auth-road { position: relative; height: 90px; border-bottom: 10px solid #2E2A25; margin: 0 -32px; }
        .auth-veh { position: absolute; bottom: -2px; animation: autodrive 7s linear infinite; }
        @keyframes autodrive { from { transform: translateX(-200px) } to { transform: translateX(110vw) } }
        .auth-form { display: grid; place-items: center; padding: 32px 20px; background: var(--paper); }
        @media (max-width: 800px) { .auth-wrap { grid-template-columns: 1fr; } .auth-art { min-height: 220px; } }
      `}</style>
    </div>
  )
}

export function Login() {
  const { setUser } = useSession()
  const { navigate, query } = useRouter()
  const [f, setF] = useState({ identifier: '', password: '' })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setError('')
    try {
      const r = await post('/auth/login', f)
      setTokens(r.access_token, r.refresh_token); setUser(r.user)
      navigate(query.next && r.user.role === 'customer' ? query.next : homeFor(r.user), { vehicle: r.user.role === 'driver' ? 'auto' : 'car' })
    } catch (err) { setError(err.detail || err.message) } finally { setBusy(false) }
  }
  const demo = (identifier, password) => setF({ identifier, password })
  return (
    <Frame title="Welcome back" sub="Sign in with your email or mobile number.">
      <form onSubmit={submit} className="stack">
        <Field label="Email or mobile"><input className="input" autoComplete="username" required value={f.identifier} onChange={(e) => setF({ ...f, identifier: e.target.value })} /></Field>
        <Field label="Password"><input className="input" type="password" autoComplete="current-password" required value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
        {error && <p className="error-text" role="alert">{error}</p>}
        <button className="btn block" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        <GoogleButton />
        <div className="row between small"><Link to="/forgot">Forgot password?</Link><Link to="/register">Create an account</Link></div>
      </form>
      {DEMO && (
        <div className="tile small stack" style={{ gap: 8 }}>
          <strong>Try a demo account</strong>
          <div className="row wrap">
            <button className="btn sage sm" onClick={() => demo('rider@vayora.in', 'Vayora@Rider1')}>Rider</button>
            <button className="btn sage sm" onClick={() => demo('driver1@vayora.in', 'Vayora@Driver1')}>Driver</button>
            <button className="btn sage sm" onClick={() => demo('admin@vayora.in', 'Vayora@Admin2026')}>Super Admin</button>
          </div>
        </div>
      )}
    </Frame>
  )
}

function GoogleButton() {
  const toast = useToast()
  const { setUser } = useSession()
  const { navigate } = useRouter()
  const clientId = import.meta.env?.VITE_GOOGLE_CLIENT_ID
  const start = () => {
    if (!clientId) return toast('Google sign-in needs VITE_GOOGLE_CLIENT_ID (see README).')
    const init = () => {
      window.google.accounts.id.initialize({ client_id: clientId, callback: async ({ credential }) => {
        try {
          const r = await post('/auth/google', { id_token: credential })
          setTokens(r.access_token, r.refresh_token); setUser(r.user); navigate(homeFor(r.user))
        } catch (e) {
          if (e.status === 428) {   // new Google user: we still need an Indian mobile number for masked calls
            const phone = window.prompt('Enter your mobile number (+91…) to finish signing up')
            if (phone) { const r = await post('/auth/google', { id_token: credential, phone }); setTokens(r.access_token, r.refresh_token); setUser(r.user); navigate(homeFor(r.user)) }
          } else toast(e.detail || e.message, 'bad')
        }
      } })
      window.google.accounts.id.prompt()
    }
    if (window.google?.accounts?.id) return init()
    const sc = Object.assign(document.createElement('script'), { src: 'https://accounts.google.com/gsi/client', async: true, onload: init })
    document.head.appendChild(sc)
  }
  return (
    <button type="button" className="btn ghost block" onClick={start}>
      <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#4285F4" d="M45 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h11.8c-.5 2.7-2 5-4.4 6.6v5.5h7.1C42.7 36.8 45 31.2 45 24.5z" /><path fill="#34A853" d="M24 46c5.9 0 10.9-2 14.5-5.3l-7.1-5.5c-2 1.3-4.5 2.1-7.4 2.1-5.7 0-10.6-3.9-12.3-9.1H4.4v5.7C8 41.1 15.4 46 24 46z" /><path fill="#FBBC05" d="M11.7 28.2c-.4-1.3-.7-2.7-.7-4.2s.3-2.9.7-4.2v-5.7H4.4C2.9 17.1 2 20.4 2 24s.9 6.9 2.4 9.9l7.3-5.7z" /><path fill="#EA4335" d="M24 10.7c3.2 0 6.1 1.1 8.4 3.3l6.3-6.3C34.9 4.1 29.9 2 24 2 15.4 2 8 6.9 4.4 14.1l7.3 5.7c1.7-5.2 6.6-9.1 12.3-9.1z" /></svg>
      Continue with Google
    </button>
  )
}

export function Register() {
  const { setUser } = useSession()
  const { navigate, query } = useRouter()
  const [f, setF] = useState({ full_name: '', email: '', phone: '+91', password: '', role: query.role === 'driver' ? 'driver' : 'customer', referral_code: '' })
  const [error, setError] = useState('')
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value })
  const submit = async (e) => {
    e.preventDefault(); setError('')
    if (!/^\+91[6-9]\d{9}$/.test(f.phone)) return setError('Enter a 10-digit Indian mobile number after +91.')
    if (f.password.length < 8) return setError('Use at least 8 characters for your password.')
    try {
      const r = await post('/auth/register', { ...f, referral_code: f.referral_code || null })
      setTokens(r.access_token, r.refresh_token); setUser(r.user)
      navigate(r.user.role === 'driver' ? '/driver/onboarding' : '/book', { vehicle: r.user.role === 'driver' ? 'auto' : 'car' })
    } catch (err) { setError(err.detail || err.message) }
  }
  return (
    <Frame title={f.role === 'driver' ? 'Start driving' : 'Create your account'} vehicle={f.role === 'driver' ? 'auto' : 'car'}
           sub={f.role === 'driver' ? 'After sign-up, upload your documents. Our team verifies them before you go online.' : 'Book your first ride in under a minute.'}>
      <div className="row" role="radiogroup" aria-label="Account type">
        {[['customer', 'I want to ride'], ['driver', 'I want to drive']].map(([v, l]) => (
          <button key={v} type="button" role="radio" aria-checked={f.role === v} className={`btn sm ${f.role === v ? '' : 'ghost'}`} onClick={() => setF({ ...f, role: v })}>{l}</button>
        ))}
      </div>
      <form onSubmit={submit} className="stack">
        <Field label="Full name"><input className="input" required autoComplete="name" value={f.full_name} onChange={set('full_name')} /></Field>
        <div className="grid-2">
          <Field label="Email"><input className="input" type="email" required autoComplete="email" value={f.email} onChange={set('email')} /></Field>
          <Field label="Mobile"><input className="input" required inputMode="tel" autoComplete="tel" value={f.phone} onChange={set('phone')} /></Field>
        </div>
        <Field label="Password" hint="At least 8 characters."><input className="input" type="password" required autoComplete="new-password" value={f.password} onChange={set('password')} /></Field>
        {f.role === 'customer' && <Field label="Referral code (optional)"><input className="input" value={f.referral_code} onChange={set('referral_code')} /></Field>}
        {error && <p className="error-text" role="alert">{error}</p>}
        <button className="btn block">Create account</button>
        <p className="small muted">Already have an account? <Link to="/login">Sign in</Link></p>
      </form>
    </Frame>
  )
}

export function Forgot() {
  const [email, setEmail] = useState('')
  const [msg, setMsg] = useState('')
  return (
    <Frame title="Reset your password" sub="We’ll email you a link that works for 30 minutes.">
      <form className="stack" onSubmit={async (e) => { e.preventDefault(); const r = await post('/auth/forgot', { email }); setMsg(r.message) }}>
        <Field label="Email"><input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <button className="btn block">Send reset link</button>
        {msg && <p className="tile small" role="status">{msg}</p>}
        <Link to="/login" className="small">Back to sign in</Link>
      </form>
    </Frame>
  )
}

export function Reset() {
  const { query, navigate } = useRouter()
  const [pw, setPw] = useState('')
  const [error, setError] = useState('')
  return (
    <Frame title="Choose a new password">
      <form className="stack" onSubmit={async (e) => { e.preventDefault()
        try { await post('/auth/reset', { token: query.token, password: pw }); navigate('/login') } catch (er) { setError(er.detail || er.message) } }}>
        <Field label="New password" hint="At least 8 characters. You’ll be signed out everywhere else."><input className="input" type="password" minLength={8} required value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
        {error && <p className="error-text" role="alert">{error}</p>}
        <button className="btn block">Save password</button>
      </form>
    </Frame>
  )
}
