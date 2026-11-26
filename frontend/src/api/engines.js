/* JavaScript mirror of backend/app/engines (fare, commission, cancellation) used ONLY by demo mode.
   In live mode every amount comes from the Python server; the browser never calculates a fare. */
const r2 = (n) => Math.round(n * 100) / 100
const r0 = (n) => Math.round(n)

export const TIER_RULES = {
  metro:  { bike: [25, 8, 1.0, 40, 1], auto: [35, 14, 1.5, 60, 1.5], car: [60, 18, 2.0, 120, 2], tourist: [500, 22, 1.0, 2500, 3] },
  tier_2: { bike: [20, 7, 0.8, 35, 1], auto: [30, 12, 1.2, 50, 1], car: [50, 15, 1.6, 100, 1.5], tourist: [450, 19, 0.8, 2200, 2.5] },
  other:  { bike: [18, 6, 0.6, 30, 1], auto: [25, 11, 1.0, 45, 1], car: [45, 14, 1.4, 90, 1.5], tourist: [400, 18, 0.7, 2000, 2] },
}
export const PEAK = [{ start: '08:00', end: '11:00', multiplier: 1.25, weekdays: [1, 2, 3, 4, 5] },
                     { start: '17:30', end: '21:00', multiplier: 1.3, weekdays: [1, 2, 3, 4, 5] }]

export const ruleFrom = ([base_fare, per_km, per_min, minimum_fare, per_wait_min], peak = PEAK) =>
  ({ base_fare, per_km, per_min, minimum_fare, per_wait_min, free_waiting_min: 3, max_peak_multiplier: 2, tax_rate: 0, peak_windows: peak })

const mins = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m }
export function peakMultiplier(rule, at) {
  const t = at.getHours() * 60 + at.getMinutes(), d = at.getDay()
  let m = 1
  for (const w of rule.peak_windows || []) {
    if (w.weekdays && !w.weekdays.includes(d)) continue
    const s = mins(w.start), e = mins(w.end)
    if (s <= e ? t >= s && t < e : t >= s || t < e) m = Math.max(m, Number(w.multiplier))
  }
  return Math.min(m, rule.max_peak_multiplier)
}

export function calculateFare(rule, { km, minutes, at = new Date(), waiting = 0, tolls = 0, parking = 0 }) {
  const base = r2(rule.base_fare), dist = r2(rule.per_km * km), time = r2(rule.per_min * minutes)
  const wait = r2(rule.per_wait_min * Math.max(0, waiting - rule.free_waiting_min))
  const metered = base + dist + time
  const mult = peakMultiplier(rule, at)
  const peak = r2(metered * (mult - 1))
  const subtotal = metered + wait + peak
  const minAdj = r2(Math.max(0, rule.minimum_fare - subtotal))
  const ride_fare = r0(subtotal + minAdj)
  const total = r2(ride_fare + tolls + parking)
  const lines = [{ label: 'Base fare', amount: base }, { label: `Distance · ${km} km × ₹${rule.per_km}`, amount: dist },
                 { label: `Time · ${minutes} min × ₹${rule.per_min}`, amount: time }]
  if (wait) lines.push({ label: 'Waiting', amount: wait })
  if (peak) lines.push({ label: `Peak hours ×${mult}`, amount: peak })
  if (minAdj) lines.push({ label: 'Minimum fare adjustment', amount: minAdj })
  if (tolls) lines.push({ label: 'Tolls', amount: tolls })
  if (parking) lines.push({ label: 'Parking', amount: parking })
  return { ride_fare, total, peak_multiplier: mult, lines, tolls, parking }
}

export const DEFAULT_SLABS = [{ upper: '300', rate: '0.10', upper_inclusive: true },
                              { upper: '700', rate: '0.15', upper_inclusive: false },
                              { upper: null, rate: '0.20' }]

export function rateFor(fare, slabs = DEFAULT_SLABS) {
  for (const s of slabs) {
    if (s.upper === null || s.upper === '') return Number(s.rate)
    const u = Number(s.upper)
    if (s.upper_inclusive !== false ? fare <= u : fare < u) return Number(s.rate)
  }
  return Number(slabs[slabs.length - 1].rate)
}

export function split(ride_fare, { tolls = 0, parking = 0, discount = 0, slabs } = {}) {
  const rate = rateFor(ride_fare, slabs)
  const commission = r2(ride_fare * rate)
  const pass = r2(tolls + parking)
  return { ride_fare, commission_rate: rate, company_commission: commission, pass_through: pass, discount,
           driver_earnings: r2(ride_fare - commission + pass), customer_paid: r2(ride_fare + pass - discount), company_net: r2(commission - discount) }
}

export const CANCEL_POLICY = { free_window_min: 15, customer_fee_after_window: 30, customer_fee_if_driver_arrived: 50,
                               driver_fee_after_window: 25, abuse_threshold: 3, abuse_window_hours: 24, cooldown_minutes: 60, charge_after_threshold: false }

export function decideCancel({ initiator, createdAt, at = new Date(), driverArrived, recent, policy = CANCEL_POLICY }) {
  const elapsed = (at - new Date(createdAt)) / 60000
  const inWindow = elapsed <= policy.free_window_min
  const abusive = recent + 1 > policy.abuse_threshold
  let fee = 0, payer = null
  if (!inWindow) {
    fee = initiator === 'customer' ? (driverArrived ? policy.customer_fee_if_driver_arrived : policy.customer_fee_after_window) : policy.driver_fee_after_window
    payer = initiator
  }
  return { initiator, minutes_since_booking: r2(elapsed), within_free_window: inWindow, fee, fee_payer: payer, abuse_flag: abusive,
           policy_applied: `2026.1:${inWindow ? 'free<= 15m' : 'after 15m'}`, cooldown_until: abusive ? new Date(+at + policy.cooldown_minutes * 60000).toISOString() : null }
}
