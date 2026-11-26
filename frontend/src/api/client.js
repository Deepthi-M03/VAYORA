/* API client. Live mode talks to FastAPI (VITE_API_URL); demo mode uses the in-browser mock.
   Realtime: WebSocket in live mode, in-memory events in demo mode, same subscribe() API. */
import * as mock from './mock.js'

const BASE = import.meta.env?.VITE_API_URL || ''
export const DEMO = !BASE || new URLSearchParams(location.search).has('demo')

const store = {
  get(k) { try { return localStorage.getItem(k) } catch { return null } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v) } catch { /* private mode */ } },
}
let access = DEMO ? null : store.get('vy_access')
let refresh = DEMO ? null : store.get('vy_refresh')

export function setTokens(a, r) { access = a; refresh = r; if (!DEMO) { store.set('vy_access', a); store.set('vy_refresh', r) } }
export function clearTokens() { setTokens(null, null); if (DEMO) mock.demoLogout() }
export const hasSession = () => (DEMO ? !!mock.demoSession() : !!access)

async function raw(method, path, body, isForm) {
  const headers = {}
  if (access) headers.Authorization = `Bearer ${access}`
  if (body && !isForm) headers['Content-Type'] = 'application/json'
  return fetch(BASE + path, { method, headers, body: body ? (isForm ? body : JSON.stringify(body)) : undefined })
}

export async function api(method, path, body, { form = false } = {}) {
  if (DEMO) {
    const payload = form ? Object.fromEntries(body.entries()) : body
    return mock.handle(method, path, payload)
  }
  let res = await raw(method, path, body, form)
  if (res.status === 401 && refresh) {
    const rr = await fetch(BASE + '/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: refresh }) })
    if (rr.ok) { const t = await rr.json(); setTokens(t.access_token, t.refresh_token); res = await raw(method, path, body, form) }
    else clearTokens()
  }
  const ct = res.headers.get('content-type') || ''
  const data = ct.includes('json') ? await res.json() : await res.text()
  if (!res.ok) {
    const detail = typeof data === 'object' ? (Array.isArray(data.detail) ? data.detail.map((d) => d.msg).join('; ') : data.detail) : data
    throw Object.assign(new Error(detail || res.statusText), { status: res.status, detail })
  }
  return data
}
export const get = (p) => api('GET', p)
export const post = (p, b) => api('POST', p, b ?? {})
export const put = (p, b) => api('PUT', p, b)
export const patch = (p, b) => api('PATCH', p, b)
export const del = (p) => api('DELETE', p)

export async function download(path, filename, demoRows) {
  let blob
  if (DEMO) blob = new Blob([demoRows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n')], { type: 'text/csv' })
  else {
    const res = await raw('GET', path)
    if (!res.ok) throw new Error('Download failed')
    blob = await res.blob()
  }
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: filename })
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 2000)
}

/* ------------------------------------------------------------------ realtime */
let ws, wsReady, handlers = new Map(), pendingSubs = []
function ensureSocket() {
  if (DEMO || ws || !access) return
  const url = (import.meta.env?.VITE_WS_URL || location.origin.replace(/^http/, 'ws')) + `/ws?token=${encodeURIComponent(access)}`
  ws = new WebSocket(url)
  wsReady = new Promise((r) => (ws.onopen = r))
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    ;(handlers.get(m.channel) || []).forEach((fn) => fn(m))
  }
  ws.onclose = () => { ws = null; setTimeout(() => { if (handlers.size) { ensureSocket(); pendingSubs.forEach((s) => sendSub(s)) } }, 2500) }
}
async function sendSub(rideId) { await wsReady; ws?.send(JSON.stringify({ op: 'subscribe_ride', ride_id: rideId })) }

export function subscribe(channel, fn) {
  if (DEMO) return mock.subscribe(channel, fn)
  ensureSocket()
  if (!handlers.has(channel)) handlers.set(channel, new Set())
  handlers.get(channel).add(fn)
  if (channel.startsWith('ride:')) { const id = channel.slice(5); pendingSubs.push(id); sendSub(id) }
  return () => handlers.get(channel)?.delete(fn)
}
