/* Vaya, the AI + voice assistant. Text goes to /api/ai/chat (Gemini on the server, key never in the
   browser). Voice uses the browser's speech recognition and speech synthesis where supported. */
import { useContext, useEffect, useRef, useState } from 'react'
import { post } from '../api/client.js'
import { LangCtx, SPEECH_LOCALE } from '../lib/i18n.js'
import { useRouter } from '../lib/router.jsx'
import { setChosenVehicle } from '../lib/session.jsx'
import { Vehicle } from '../motion/vehicles.jsx'

const SUGGEST = {
  customer: ['Book an auto to Marina Beach', 'How is my fare calculated?', 'What if I cancel?', 'I left my bag in the car'],
  driver: ['When will I get paid?', 'How is commission calculated?', 'How can I improve my ranking?'],
  admin: ['Summarise this week', 'Which city has the most cancellations?', 'Any payout problems?'],
}

export default function Assistant({ role = 'customer' }) {
  const [open, setOpen] = useState(false)
  const [msgs, setMsgs] = useState([{ role: 'model', text: role === 'customer' ? 'Hi, I’m Vaya. I can book a ride, explain a fare or help with a problem. Type or tap the mic.' : role === 'driver' ? 'Hi! Ask me about earnings, payouts or your ranking.' : 'Ask me about bookings, revenue, cancellations or payouts.' }])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [listening, setListening] = useState(false)
  const [speak, setSpeak] = useState(false)
  const { lang } = useContext(LangCtx)
  const { navigate } = useRouter()
  const recRef = useRef(null)
  const endRef = useRef(null)
  const SR = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition)
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }) }, [msgs, open])

  const say = (t) => {
    if (!speak || !window.speechSynthesis) return
    const u = new SpeechSynthesisUtterance(t.replace(/[•*]/g, ''))
    u.lang = SPEECH_LOCALE[lang] || 'en-IN'
    window.speechSynthesis.cancel(); window.speechSynthesis.speak(u)
  }
  const send = async (message) => {
    if (!message.trim() || busy) return
    const history = msgs.map((m) => ({ role: m.role, text: m.text }))
    setMsgs((m) => [...m, { role: 'user', text: message }]); setText(''); setBusy(true)
    try {
      const r = await post('/ai/chat', { message, history, language: lang })
      setMsgs((m) => [...m, { role: 'model', text: r.reply, intent: r.intent }]); say(r.reply)
    } catch (e) { setMsgs((m) => [...m, { role: 'model', text: e.detail || 'I couldn’t reach the assistant. Try again in a moment.' }]) }
    finally { setBusy(false) }
  }
  const listen = () => {
    if (!SR) return
    if (listening) { recRef.current?.stop(); return }
    const rec = new SR()
    rec.lang = SPEECH_LOCALE[lang] || 'en-IN'; rec.interimResults = true
    rec.onresult = (e) => { const t = [...e.results].map((r) => r[0].transcript).join(''); setText(t); if (e.results[e.results.length - 1].isFinal) { send(t); setSpeak(true) } }
    rec.onend = () => setListening(false); rec.onerror = () => setListening(false)
    recRef.current = rec; rec.start(); setListening(true)
  }
  const actOn = (intent) => {
    if (intent.action === 'book') {
      setChosenVehicle(intent.category || 'auto')
      navigate(`/book?drop=${encodeURIComponent(intent.drop || '')}&category=${intent.category || 'auto'}`, { vehicle: intent.category || 'auto' })
      setOpen(false)
    } else if (intent.action === 'complaint') {
      navigate(`/support?category=${intent.category}&summary=${encodeURIComponent(intent.summary || '')}`); setOpen(false)
    }
  }

  return (
    <>
      <button className="vaya-fab" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={open ? 'Close assistant' : 'Open assistant'}>
        {open ? '✕' : <><span className="vaya-orb" />Ask Vaya</>}
      </button>
      {open && (
        <section className="vaya glass" aria-label="VAYORA assistant">
          <header className="row between">
            <div className="row"><span className="vaya-orb big" /><div><strong>Vaya</strong><div className="tiny muted">AI assistant{SR ? ' · voice on' : ''}</div></div></div>
            <label className="row tiny"><input type="checkbox" checked={speak} onChange={(e) => setSpeak(e.target.checked)} /> Read replies aloud</label>
          </header>
          <div className="vaya-log" aria-live="polite">
            {msgs.map((m, i) => (
              <div key={i} className={`vaya-msg ${m.role}`}>
                <div style={{ whiteSpace: 'pre-line' }}>{m.text}</div>
                {m.intent?.action === 'book' && (
                  <div className="tile small stack" style={{ marginTop: 8, gap: 6 }}>
                    <div className="row"><Vehicle type={m.intent.category || 'auto'} width={60} /><div><strong>{(m.intent.category || 'auto').replace(/^\w/, (c) => c.toUpperCase())}</strong> to {m.intent.drop || 'your destination'}<div className="tiny muted">From {m.intent.pickup || 'your location'} · {m.intent.when === 'now' ? 'now' : m.intent.when}</div></div></div>
                    <button className="btn sm" onClick={() => actOn(m.intent)}>Check fare and book</button>
                  </div>)}
                {m.intent?.action === 'complaint' && <button className="btn sm" style={{ marginTop: 8 }} onClick={() => actOn(m.intent)}>Review and send complaint</button>}
              </div>))}
            {busy && <div className="vaya-msg model"><span className="typing"><i /><i /><i /></span></div>}
            <div ref={endRef} />
          </div>
          {msgs.length < 3 && <div className="row wrap" style={{ gap: 6 }}>{SUGGEST[role].map((s) => <button key={s} className="chip" style={{ border: 0, cursor: 'pointer' }} onClick={() => send(s)}>{s}</button>)}</div>}
          <form className="row" onSubmit={(e) => { e.preventDefault(); send(text) }}>
            {SR && <button type="button" className={`icon-btn mic ${listening ? 'on' : ''}`} onClick={listen} aria-label={listening ? 'Stop listening' : 'Speak'} aria-pressed={listening}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg></button>}
            <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder={listening ? 'Listening…' : 'Message Vaya'} aria-label="Message" maxLength={1500} />
            <button className="btn" disabled={busy}>Send</button>
          </form>
        </section>
      )}
      <style>{`
        .vaya-fab { position: fixed; right: 22px; bottom: 22px; z-index: 300; display: inline-flex; align-items: center; gap: 10px; padding: 12px 18px 12px 12px; border-radius: 99px; border: 0;
          background: var(--ink); color: var(--cream); font-weight: 600; cursor: pointer; box-shadow: var(--shadow-2); min-width: 48px; min-height: 48px; justify-content: center; }
        .vaya-orb { width: 24px; height: 24px; border-radius: 50%; background: radial-gradient(circle at 35% 35%, var(--cream), var(--accent) 70%); animation: breathe 3s ease-in-out infinite; }
        .vaya-orb.big { width: 34px; height: 34px; }
        @keyframes breathe { 50% { transform: scale(1.12) } }
        .vaya { position: fixed; right: 22px; bottom: 84px; z-index: 300; width: min(400px, calc(100vw - 32px)); height: min(600px, calc(100vh - 120px)); padding: 16px;
          display: grid; grid-template-rows: auto 1fr auto auto; gap: 12px; background: rgba(247,241,232,.92); animation: rise .35s var(--ease-out); }
        .vaya-log { overflow: auto; display: grid; gap: 10px; align-content: start; }
        .vaya-msg { max-width: 88%; padding: 10px 14px; border-radius: 16px; font-size: var(--t-sm); background: #fff; }
        .vaya-msg.user { margin-left: auto; background: var(--accent); color: var(--accent-ink); }
        .mic.on { background: var(--accent); color: var(--cream); animation: breathe 1s infinite; }
        .typing i { display: inline-block; width: 6px; height: 6px; margin: 0 2px; border-radius: 50%; background: var(--sage-deep); animation: blink 1s infinite; }
        .typing i:nth-child(2) { animation-delay: .2s } .typing i:nth-child(3) { animation-delay: .4s }
        @keyframes blink { 50% { opacity: .2 } }
      `}</style>
    </>
  )
}
