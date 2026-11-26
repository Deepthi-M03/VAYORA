const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 })
const inr2 = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 })
export const rupees = (v, paise = false) => {
  if (v === null || v === undefined || v === '') return '—'
  const n = Number(v)
  return (paise ? inr2 : inr).format(Math.abs(n) < (paise ? 0.005 : 0.5) ? 0 : n)
}
export const plural = (n, word) => `${n} ${word}${Number(n) === 1 ? '' : 's'}`
export const num = (v) => new Intl.NumberFormat('en-IN').format(Number(v || 0))
export const pct = (v) => `${Math.round(Number(v) * 100)}%`
export const time = (d) => d ? new Date(d).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }) : ''
export const date = (d) => d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : ''
export const dateTime = (d) => d ? `${date(d)}, ${time(d)}` : ''
export const titleCase = (s = '') => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
export const statusLabel = {
  scheduled: 'Scheduled', searching: 'Finding your driver', assigned: 'Driver on the way', arrived: 'Driver has arrived',
  in_progress: 'On trip', completed: 'Completed', cancelled: 'Cancelled', no_driver: 'No driver found',
}
export const statusTone = { completed: 'good', cancelled: 'bad', no_driver: 'bad', in_progress: 'accent', searching: 'warn' }
