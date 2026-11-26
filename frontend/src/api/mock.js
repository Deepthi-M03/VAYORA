/* Demo backend: an in-browser stand-in for the FastAPI server with the same routes and response
   shapes, so the whole product can be explored without a server. A simulated driver accepts,
   drives to you, and completes the trip. State lives in memory for the session. */
import { CANCEL_POLICY, DEFAULT_SLABS, TIER_RULES, calculateFare, decideCancel, ruleFrom, split } from './engines.js'
import { PLACES, along, haversineKm, makeRoute, routeLengthKm, seeded } from '../lib/geo.js'

const rnd = seeded(42.4242)
const pick = (a) => a[Math.floor(rnd() * a.length)]
const now = () => new Date()
const iso = (d) => new Date(d).toISOString()
const code = (p = 'VY', n = 6) => p + [...Array(n)].map(() => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('')
const err = (status, detail) => Object.assign(new Error(detail), { status, detail })
const listeners = new Map()
export function subscribe(channel, fn) {
  if (!listeners.has(channel)) listeners.set(channel, new Set())
  listeners.get(channel).add(fn)
  return () => listeners.get(channel)?.delete(fn)
}
const emit = (channel, event, data) => listeners.get(channel)?.forEach((fn) => fn({ event, data }))

/* ------------------------------------------------------------------ seed */
const CATS = [
  { id: 1, code: 'bike', name: 'Bike', seats: 1, description: 'Beat traffic on two wheels', is_interstate: false, globally_active: true },
  { id: 2, code: 'auto', name: 'Auto', seats: 3, description: 'Everyday auto-rickshaw rides', is_interstate: false, globally_active: true },
  { id: 3, code: 'car', name: 'Car', seats: 4, description: 'Comfortable AC sedans and hatchbacks', is_interstate: false, globally_active: true },
  { id: 4, code: 'tourist', name: 'Tourist', seats: 7, description: 'SUVs and tempo travellers for outstation and interstate trips', is_interstate: true, globally_active: true },
]
const CITY_SEED = [
  ['Chennai', 'Tamil Nadu', 'metro', 13.0827, 80.2707, 'active'], ['Coimbatore', 'Tamil Nadu', 'tier_2', 11.0168, 76.9558, 'active'],
  ['Bengaluru', 'Karnataka', 'metro', 12.9716, 77.5946, 'active'], ['Hyderabad', 'Telangana', 'metro', 17.385, 78.4867, 'active'],
  ['Kochi', 'Kerala', 'tier_2', 9.9312, 76.2673, 'active'], ['Thiruvananthapuram', 'Kerala', 'tier_2', 8.5241, 76.9366, 'pending_approval'],
  ['Mumbai', 'Maharashtra', 'metro', 19.076, 72.8777, 'active'], ['Pune', 'Maharashtra', 'tier_2', 18.5204, 73.8567, 'active'],
  ['Delhi', 'Delhi', 'metro', 28.6139, 77.209, 'active'], ['Kolkata', 'West Bengal', 'metro', 22.5726, 88.3639, 'draft'],
  ['Ahmedabad', 'Gujarat', 'metro', 23.0225, 72.5714, 'draft'], ['Jaipur', 'Rajasthan', 'tier_2', 26.9124, 75.7873, 'paused'],
]
const FIRST = ['Arjun', 'Priya', 'Karthik', 'Divya', 'Rahul', 'Sneha', 'Vikram', 'Lakshmi', 'Imran', 'Meera', 'Suresh', 'Ayesha', 'Naveen', 'Kavya', 'Joseph', 'Fathima', 'Harish', 'Deepa', 'Manoj', 'Revathi']
const LAST = ['Raman', 'Iyer', 'Nair', 'Reddy', 'Sharma', 'Khan', 'Menon', 'Patel', 'Das', 'Pillai', 'Gupta', 'Rao']

const db = (() => {
  const cities = CITY_SEED.map(([name, state, tier, lat, lng, status], i) => ({
    id: i + 1, name, state, tier, status, center: [lat, lng], operating_hours: { open: '00:00', close: '23:59' }, restrictions: {},
    zones: [{ id: i * 10 + 1, name: `${name} core`, kind: 'service', active: true }, { id: i * 10 + 2, name: 'Airport', kind: 'airport', active: true }],
    vehicles: Object.fromEntries(CATS.map((c) => [c.id, status !== 'draft' && !(name === 'Delhi' && c.code === 'bike')])),
    fares: Object.fromEntries(CATS.map((c) => [c.id, { ...ruleFrom(TIER_RULES[tier][c.code], c.code === 'tourist' ? [] : undefined), version: 1 }])),
  }))
  const users = [
    { id: 1, role: 'admin', admin_role: 'super_admin', name: 'Platform Owner', email: 'admin@vayora.in', phone: '+919000000001', status: 'active' },
    { id: 2, role: 'customer', name: 'Ananya Raman', email: 'rider@vayora.in', phone: '+919000000002', status: 'active', referral_code: 'ANANYA', language: 'en', outstanding_dues: '0' },
  ]
  const drivers = []
  const vehicleSeed = [['auto', 'TN09AB1234', 'Bajaj', 'RE Compact', 'Yellow-Green'], ['car', 'TN10CD5678', 'Maruti', 'Dzire', 'Pearl White'],
                       ['bike', 'TN07EF9012', 'Honda', 'Shine', 'Black'], ['tourist', 'TN01GH3456', 'Toyota', 'Innova Crysta', 'Silver']]
  const named = ['Murugan Selvam', 'Karthik Iyer', 'Farhan Ali', 'Rajesh Kumar']
  for (let i = 0; i < 46; i++) {
    const uid = 100 + i
    const city = i < 4 ? cities[0] : pick(cities.filter((c) => c.status === 'active'))
    const cat = i < 4 ? vehicleSeed[i][0] : pick(['bike', 'auto', 'auto', 'car', 'car', 'tourist'])
    const name = i < 4 ? named[i] : `${pick(FIRST)} ${pick(LAST)}`
    const onboarding = i >= 43 ? 'submitted' : 'approved'
    users.push({ id: uid, role: 'driver', name, email: `driver${i + 1}@vayora.in`, phone: `+9190000${String(1000 + i)}`, status: i === 20 ? 'suspended' : 'active' })
    const score = Math.round((62 + rnd() * 34) * 10) / 10
    drivers.push({
      id: i + 1, user_id: uid, city_id: city.id, onboarding_status: onboarding, is_online: i < 4 ? i !== 0 : rnd() > 0.45,
      lat: city.center[0] + (rnd() - 0.5) * 0.06, lng: city.center[1] + (rnd() - 0.5) * 0.06, rank_score: score,
      rank_tier: score >= 90 ? 'Platinum' : score >= 80 ? 'Gold' : score >= 65 ? 'Silver' : 'Bronze',
      offered: 400 + Math.floor(rnd() * 600), accepted: 0, completed: 0, late_cancel: Math.floor(rnd() * 6), bank_verified: true, wallet: 0,
      vehicle: { id: i + 1, category: cat, reg: i < 4 ? vehicleSeed[i][1] : `${pick(['TN', 'KA', 'MH', 'DL', 'TS', 'KL'])}${10 + Math.floor(rnd() * 80)}${pick(['AB', 'CK', 'MZ', 'QP'])}${1000 + Math.floor(rnd() * 8999)}`,
                 make: i < 4 ? vehicleSeed[i][2] : pick(['Bajaj', 'TVS', 'Maruti', 'Hyundai', 'Toyota']), model: i < 4 ? vehicleSeed[i][3] : pick(['RE', 'King', 'WagonR', 'Aura', 'Innova']),
                 colour: i < 4 ? vehicleSeed[i][4] : pick(['White', 'Silver', 'Black', 'Blue']), status: onboarding === 'approved' ? (i === 21 ? 'suspended' : 'approved') : 'pending',
                 insurance_expiry: i === 22 ? '2026-10-31' : '2027-12-31' },
      documents: ['photo', 'licence', 'aadhaar', 'rc', 'insurance', 'vehicle_photo', 'bank_proof'].map((t, k) => ({ id: i * 10 + k, type: t, status: onboarding === 'approved' ? 'verified' : 'pending' })),
    })
    drivers[i].accepted = Math.floor(drivers[i].offered * (0.78 + rnd() * 0.2))
    drivers[i].completed = Math.floor(drivers[i].accepted * (0.9 + rnd() * 0.09))
  }
  for (let i = 0; i < 64; i++) users.push({ id: 300 + i, role: 'customer', name: `${pick(FIRST)} ${pick(LAST)}`, email: `rider${i}@example.in`,
    phone: `+9198${String(10000000 + Math.floor(rnd() * 89999999))}`, status: i === 7 ? 'restricted' : 'active', fraud_flag: i === 12 })

  // historical rides across 30 days for analytics
  const rides = []
  const today = new Date(); today.setHours(0, 0, 0, 0)
  for (let i = 0; i < 900; i++) {
    const city = pick(cities.filter((c) => c.status === 'active'))
    const cat = pick(CATS.slice(0, 3).concat(CATS.slice(0, 3), CATS))
    const km = cat.code === 'tourist' ? 60 + rnd() * 260 : 1.5 + rnd() * 16
    const minutes = Math.round(km / (cat.code === 'tourist' ? 45 : 20) * 60)
    let created = new Date(+today - Math.floor(rnd() * 30) * 864e5 + (7 + rnd() * 15) * 36e5)
    if (+created > Date.now() - 36e5) created = new Date(+created - 864e5)
    const f = calculateFare(city.fares[cat.id], { km: Math.round(km * 10) / 10, minutes, at: created })
    const cancelled = rnd() < 0.09
    const d = pick(drivers.filter((x) => x.city_id === city.id && x.onboarding_status === 'approved' && x.vehicle.category === cat.code)) || pick(drivers.filter((x) => x.vehicle.category === cat.code)) || drivers[0]
    const s = split(f.ride_fare)
    rides.push({ id: 5000 + i, code: code(), status: cancelled ? 'cancelled' : 'completed', city_id: city.id, category: cat.code, customer_id: pick(users.filter((u) => u.role === 'customer' && u.id !== 2)).id,
                 driver_id: d.id, created_at: iso(created), completed_at: cancelled ? null : iso(+created + minutes * 6e4), payment_method: rnd() > 0.45 ? 'online' : 'cash',
                 ride_fare: cancelled ? null : f.ride_fare, final_total: cancelled ? null : f.total, commission: cancelled ? null : s.company_commission,
                 commission_rate: s.commission_rate, driver_earnings: cancelled ? null : s.driver_earnings, est_low: f.total, est_high: Math.round(f.total * 1.12), km: Math.round(km * 10) / 10, minutes,
                 breakdown: f, ...(() => { const pl = PLACES[city.name] || PLACES.Chennai, a = Math.floor(rnd() * pl.length); return { pickup: pl[a], drop: pl[(a + 1 + Math.floor(rnd() * (pl.length - 1))) % pl.length] } })(), discount: 0 })
  }
  // the demo rider's own history (Chennai)
  const ch = PLACES.Chennai
  ;[[0, 1, 'auto', 3], [2, 6, 'car', 6], [5, 9, 'bike', 9], [4, 8, 'car', 13], [10, 11, 'tourist', 20]].forEach(([a, b, cat, daysAgo], k) => {
    const A = { lat: ch[a][1], lng: ch[a][2] }, B = { lat: ch[b][1], lng: ch[b][2] }
    const km = Math.round(routeLengthKm(makeRoute(A, B)) * 1.1 * 10) / 10
    const minutes = Math.round(km / (cat === 'tourist' ? 45 : 20) * 60)
    const created = new Date(Date.now() - daysAgo * 864e5)
    const catObj = CATS.find((c) => c.code === cat)
    const f = calculateFare(cities[0].fares[catObj.id], { km, minutes, at: created })
    const s = split(f.ride_fare)
    rides.push({ id: 9000 + k, code: code(), status: 'completed', city_id: 1, category: cat, customer_id: 2, driver_id: [1, 2, 3, 2, 4][k],
                 created_at: iso(created), completed_at: iso(+created + minutes * 6e4), payment_method: k % 2 ? 'cash' : 'online',
                 ride_fare: f.ride_fare, final_total: f.total, commission: s.company_commission, commission_rate: s.commission_rate, driver_earnings: s.driver_earnings,
                 est_low: f.total, est_high: Math.round(f.total * 1.1), km, minutes, breakdown: f, pickup: ch[a], drop: ch[b], discount: 0, rated: k > 0 })
  })
  const complaintCats = ['driver_behaviour', 'unsafe_driving', 'vehicle_condition', 'payment_dispute', 'wrong_fare', 'trip_issue', 'harassment_safety', 'lost_item', 'customer_behaviour', 'other']
  const complaints = [...Array(16)].map((_, i) => {
    const cat = complaintCats[i % complaintCats.length]
    const prio = ['unsafe_driving', 'harassment_safety'].includes(cat) ? 'P1' : ['payment_dispute', 'wrong_fare', 'lost_item'].includes(cat) ? 'P2' : 'P3'
    const created = new Date(Date.now() - i * 5.3 * 36e5)
    const d = drivers[(i * 7) % 40]
    return { id: i + 1, ticket: code('TK', 6), category: cat, priority: prio, status: i < 9 ? 'open' : i < 12 ? 'investigating' : 'resolved',
             description: { unsafe_driving: 'Driver was speeding on the OMR flyover and using his phone.', harassment_safety: 'Driver made inappropriate comments during the trip. I felt unsafe.',
                            lost_item: 'Left a black laptop bag in the back seat.', wrong_fare: 'Charged ₹120 more than the estimate for the same route.',
                            payment_dispute: 'UPI payment debited twice for one ride.', vehicle_condition: 'AC not working and seat torn.' }[cat] || 'Driver took a much longer route than needed.',
             ride_id: rides[i].id, raised_by: users.find((u) => u.id === 300 + i)?.name || 'Rider', against: users.find((u) => u.id === d.user_id).name, against_user_id: d.user_id,
             created_at: iso(created), sla_due_at: iso(+created + ({ P1: 1, P2: 24, P3: 72 }[prio]) * 36e5), actions: [] }
  })
  return {
    cities, users, drivers, rides, complaints, cats: CATS, slabs: DEFAULT_SLABS, policy: { ...CANCEL_POLICY },
    coupons: [{ id: 1, code: 'WELCOME50', description: '₹50 off your first ride', kind: 'flat', value: '50', max_discount: '50', min_fare: '100', active: true, valid_to: iso(Date.now() + 3e10) },
              { id: 2, code: 'AUTO20', description: '20% off autos, up to ₹40', kind: 'percent', value: '20', max_discount: '40', min_fare: '0', category_code: 'auto', active: true, valid_to: iso(Date.now() + 7e9) }],
    addresses: [{ id: 1, label: 'Home', address: 'Besant Nagar Beach', lat: 13.0003, lng: 80.2717 }, { id: 2, label: 'Work', address: 'Tidel Park, Taramani', lat: 12.9893, lng: 80.2483 }],
    contacts: [{ id: 1, name: 'Ravi Raman', phone: '+919840000000', relation: 'Father' }],
    notifications: [{ id: 1, title: 'Welcome to VAYORA', body: 'Use WELCOME50 for ₹50 off your first ride.', kind: 'promo', read: false, at: iso(Date.now() - 864e5) }],
    messages: {}, cancellations: [], audit: [], myComplaints: [], settlementsFailed: new Set([3]),
    config: { referral: { referrer_reward: '75', referee_reward: '50' }, sos: { police: '112', women_helpline: '181', ops_desk: '+91-44-0000-0000' },
              dispatch: { radius_km: 5, offer_timeout_sec: 20, max_offers: 6 }, settlement: { min_payout: '1.00', run_at_ist: '00:30' } },
  }
})()

const userById = (id) => db.users.find((u) => u.id === id)
const driverByUser = (uid) => db.drivers.find((d) => d.user_id === uid)
const cityById = (id) => db.cities.find((c) => c.id === id)
const catByCode = (c) => db.cats.find((x) => x.code === c)
const activeCats = (city) => city.status !== 'active' ? [] : db.cats.filter((c) => c.globally_active && city.vehicles[c.id])

function audit(actor, action, entity, entity_id, before, after, reason) {
  db.audit.unshift({ id: db.audit.length + 1, at: iso(now()), actor_id: actor.id, actor_role: actor.admin_role || actor.role, action, entity, entity_id: String(entity_id), before, after, reason, ip: '127.0.0.1' })
}

function rideOut(r, viewer) {
  const city = cityById(r.city_id)
  const d = db.drivers.find((x) => x.id === r.driver_id)
  const cat = catByCode(r.category)
  const out = {
    id: r.id, code: r.code, status: r.status, category: r.category, category_name: cat.name, city: city.name,
    pickup: r.pickupPt || { address: r.pickup[0], lat: r.pickup[1], lng: r.pickup[2] },
    drop: r.dropPt || { address: r.drop[0], lat: r.drop[1], lng: r.drop[2] },
    created_at: r.created_at, scheduled_for: r.scheduled_for || null,
    estimate: { low: r.est_low, high: r.est_high, distance_km: r.km, duration_min: r.minutes, breakdown: r.est_breakdown || r.breakdown, is_estimate: true },
    final: r.status === 'completed' ? { total: r.final_total, discount: r.discount, breakdown: r.breakdown, is_estimate: false } : null,
    payment_method: r.payment_method, payment_status: r.payment_status || (r.status === 'completed' ? 'paid' : 'pending'),
    timeline: r.timeline || {}, sos: !!r.sos, route: r.route, rated: !!r.rated,
  }
  if (d && ['assigned', 'arrived', 'in_progress', 'completed'].includes(r.status)) {
    out.driver = { id: d.id, name: userById(d.user_id).name, rating: (4.5 + (d.rank_score - 60) / 90).toFixed(2), tier: d.rank_tier, lat: d.lat, lng: d.lng,
                   vehicle: { reg: d.vehicle.reg, make: d.vehicle.make, model: d.vehicle.model, colour: d.vehicle.colour } }
    if (r.status !== 'completed') out.masked_number = r.masked || '+91 80 4718 2290'
  }
  if (viewer?.id === r.customer_id) out.otp = ['assigned', 'arrived'].includes(r.status) ? r.otp : null
  if (viewer?.role !== 'customer') {
    out.customer = { id: r.customer_id, name: userById(r.customer_id)?.name }
    if (r.ride_fare != null) out.earning = { ride_fare: r.ride_fare, commission_rate: r.commission_rate, commission: r.commission, driver_earnings: r.driver_earnings }
  }
  return out
}

/* ------------------------------------------------------------------ simulation */
const sims = new Map()
function simulateCustomerRide(r) {
  const city = cityById(r.city_id)
  const pickup = r.pickupPt, drop = r.dropPt
  const d = db.drivers.find((x) => x.city_id === city.id && x.vehicle.category === r.category && x.onboarding_status === 'approved' && x.user_id !== 100)
           || db.drivers.find((x) => x.vehicle.category === r.category) || db.drivers[1]
  const start = { lat: pickup.lat + 0.008, lng: pickup.lng - 0.009 }
  const approach = makeRoute(start, pickup, 24)
  const timers = []
  const at = (ms, fn) => timers.push(setTimeout(fn, ms))
  const set = (status, extra = {}) => { Object.assign(r, { status }, extra); emit(`ride:${r.id}`, 'ride.status', { ride_id: r.id, status }) }
  at(3200, () => {
    if (r.status !== 'searching') return
    d.lat = start.lat; d.lng = start.lng
    r.driver_id = d.id; r.masked = '+91 80 4718 22' + String(10 + Math.floor(Math.random() * 89))
    r.timeline = { ...r.timeline, assigned: iso(now()) }
    set('assigned')
    let t = 0
    const iv = setInterval(() => {
      if (r.status !== 'assigned') return clearInterval(iv)
      t += 1 / 14
      const p = along(approach, t); d.lat = p.lat; d.lng = p.lng
      emit(`ride:${r.id}`, 'driver.location', p)
      if (t >= 1) { clearInterval(iv); r.timeline.arrived = iso(now()); set('arrived') }
    }, 1000)
    timers.push(iv)
  })
  sims.set(r.id, { timers, d, drop })
}
function simulateTrip(r) {
  const s = sims.get(r.id)
  const d = s?.d || db.drivers.find((x) => x.id === r.driver_id)
  const route = r.route
  let t = 0
  const iv = setInterval(() => {
    if (r.status !== 'in_progress') return clearInterval(iv)
    t += 1 / 18
    const p = along(route, t); d.lat = p.lat; d.lng = p.lng
    emit(`ride:${r.id}`, 'driver.location', p)
    if (t >= 1) { clearInterval(iv); completeRide(r, { km: r.km * (0.96 + Math.random() * 0.1), tolls: 0 }) }
  }, 1000)
}
function completeRide(r, { km, tolls = 0, parking = 0 }) {
  const city = cityById(r.city_id), cat = catByCode(r.category)
  const minutes = Math.max(1, Math.round(r.minutes * (0.95 + Math.random() * 0.2)))
  const f = calculateFare(city.fares[cat.id], { km: Math.round(km * 10) / 10, minutes, at: new Date(r.timeline.started || now()), waiting: r.waiting || 0, tolls, parking })
  let discount = 0
  if (r.coupon) { const c = r.coupon; discount = Math.min(c.kind === 'flat' ? Number(c.value) : f.ride_fare * Number(c.value) / 100, Number(c.max_discount)) }
  const s = split(f.ride_fare, { tolls, parking, discount, slabs: db.slabs })
  Object.assign(r, { status: 'completed', ride_fare: f.ride_fare, final_total: f.total, breakdown: f, discount, commission: s.company_commission,
                     commission_rate: s.commission_rate, driver_earnings: s.driver_earnings, completed_at: iso(now()), payment_status: r.payment_method === 'cash' ? 'paid' : 'pending' })
  r.timeline.completed = r.completed_at
  emit(`ride:${r.id}`, 'ride.status', { ride_id: r.id, status: 'completed' })
}

if (typeof window !== 'undefined') window.addEventListener('vy-demo-start', (e) => {
  const r = db.rides.find((x) => x.id === e.detail)
  if (!r || r.status !== 'arrived') return
  r.status = 'in_progress'; r.timeline.started = iso(now()); r.waiting = 2
  emit(`ride:${r.id}`, 'ride.status', { ride_id: r.id, status: r.status })
  simulateTrip(r)
})

/* driver demo: offer a ride shortly after going online */
let offerTimer = null
function scheduleOffer(driver) {
  clearTimeout(offerTimer)
  offerTimer = setTimeout(() => {
    if (!driver.is_online || db.rides.some((r) => r.driver_id === driver.id && ['assigned', 'arrived', 'in_progress'].includes(r.status))) return
    const ch = PLACES.Chennai
    const a = ch[Math.floor(Math.random() * 10)], b = ch[(ch.indexOf(a) + 3) % 10]
    const A = { address: a[0], lat: a[1], lng: a[2] }, B = { address: b[0], lat: b[1], lng: b[2] }
    const route = makeRoute(A, B)
    const km = Math.round(routeLengthKm(route) * 1.12 * 10) / 10, minutes = Math.round(km / 20 * 60)
    const f = calculateFare(db.cities[0].fares[catByCode(driver.vehicle.category).id], { km, minutes })
    const r = { id: 20000 + Math.floor(Math.random() * 9999), code: code(), status: 'searching', city_id: 1, category: driver.vehicle.category, customer_id: 305,
                created_at: iso(now()), payment_method: Math.random() > 0.5 ? 'cash' : 'online', km, minutes, est_low: f.total, est_high: Math.round(f.total * 1.12),
                est_breakdown: f, pickupPt: A, dropPt: B, route, otp: '4821', timeline: {} }
    db.rides.push(r)
    driver.offered++
    const s = split((f.total + r.est_high) / 2, { slabs: db.slabs })
    emit(`user:${driver.user_id}`, 'ride.offer', { ride_id: r.id, code: r.code, pickup: A.address, drop: B.address, distance_km: km, est_earning: s.driver_earnings,
                                                    payment_method: r.payment_method, expires_in: 20, pickup_distance_km: (0.6 + Math.random()).toFixed(1), category: r.category })
  }, 4000)
}

/* ------------------------------------------------------------------ AI fallback (mirrors backend persona rules) */
function aiReply(user, message) {
  const m = message.toLowerCase()
  if (user.role === 'customer') {
    const active = db.rides.find((r) => r.customer_id === user.id && ['searching', 'assigned', 'arrived', 'in_progress'].includes(r.status))
    if (/cancel|refund|ரத்து|रद्द/.test(m)) return { reply: 'Cancelling is free for both you and the driver within 15 minutes of booking. After that, a ₹30 fee applies (₹50 if the driver has already arrived). You always see the fee before you confirm.' }
    if (/fare|price|cost|how much|கட்டணம்|किराया/.test(m)) return { reply: 'Your fare is base fare + per-km + per-minute, with a peak multiplier on weekday rush hours. Before booking you see an estimate range; the final fare uses the actual distance, time, waiting, tolls and parking. For a car in Chennai that is ₹60 base, ₹18/km and ₹2/min.' }
    if (/where|status|driver|எங்கே|कहाँ/.test(m)) return { reply: active ? `Your ride ${active.code} is ${active.status.replace('_', ' ')}.` : 'You have no active ride right now. Want me to book one?' }
    if (/lost|left|bag|phone|complain|rude|unsafe/.test(m)) return { reply: "I'm sorry about that. I've drafted a complaint for our support team. Check it and send it.", intent: { action: 'complaint', category: /lost|left|bag|phone/.test(m) ? 'lost_item' : /unsafe|speed/.test(m) ? 'unsafe_driving' : 'driver_behaviour', summary: message } }
    const to = message.match(/\b(?:to|till|for)\s+([a-z .,'-]{3,40})/i)?.[1]?.trim()
    const veh = /bike|two.?wheeler/.test(m) ? 'bike' : /auto|rickshaw/.test(m) ? 'auto' : /tourist|outstation|interstate|innova|tempo/.test(m) ? 'tourist' : /car|cab|sedan/.test(m) ? 'car' : null
    if (/book|ride|take me|go to|cab|auto|bike|போ|जाना/.test(m)) return { reply: to ? `Sure. I can book ${veh ? (veh === 'auto' ? 'an auto' : 'a ' + veh) : 'a ride'} to ${to}. Check the details and confirm.` : 'Sure. Where are you going?',
      intent: { action: 'book', pickup: 'current location', drop: to || '', category: veh || 'auto', when: 'now' } }
    return { reply: 'I can book rides, explain fares, track your trip, or help with a complaint. What do you need?' }
  }
  if (user.role === 'driver') {
    return { reply: /rank|score|rating/.test(m)
      ? 'Your score combines verified ratings (40%), completion (20%), acceptance (15%), late cancellations (10%) and safety (15%). Accepting more requests while online is the quickest way up this week.'
      : 'Online-ride earnings settle to your bank the next morning after commission (10% up to ₹300, 15% between ₹300 and ₹700, 20% from ₹700). Commission on cash rides is deducted from that same payout.' }
  }
  return { reply: '• Bookings are steady week on week; Chennai and Bengaluru lead revenue.\n• Cancellations sit near 9%, mostly inside the free 15-minute window.\n• 1 payout failed (bank account closed). Ask the driver to update their bank details.\n• 3 safety complaints are open. Review the P1 queue first.' }
}

/* ------------------------------------------------------------------ routes */
const routes = []
const on = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn })
let session = null   // { user }
const me = (u) => ({ id: u.id, role: u.role, admin_role: u.admin_role || null, name: u.name, email: u.email, phone: u.phone, language: u.language || 'en',
                     status: u.status, referral_code: u.referral_code, outstanding_dues: u.outstanding_dues || '0', driver_id: driverByUser(u.id)?.id || null })
const need = (role) => { if (!session) throw err(401, 'Not signed in'); if (role && session.user.role !== role) throw err(403, 'Not allowed for this account type'); return session.user }

// auth
on('POST', '/auth/login', (b) => {
  const id = (b.identifier || '').toLowerCase()
  const u = db.users.find((x) => x.email === id || x.phone === b.identifier)
  const ok = u && ((u.id === 1 && b.password === 'Vayora@Admin2026') || (u.id === 2 && b.password === 'Vayora@Rider1') || (u.role === 'driver' && b.password?.startsWith('Vayora@Driver')))
  if (!ok) throw err(401, 'Incorrect email/phone or password')
  if (u.status === 'suspended') throw err(403, 'Account suspended. Contact support to appeal.')
  session = { user: u }
  return { access_token: 'demo', refresh_token: 'demo', user: me(u) }
})
on('POST', '/auth/register', (b) => {
  if (db.users.some((u) => u.email === b.email?.toLowerCase() || u.phone === b.phone)) throw err(409, 'An account with this email or phone already exists')
  const u = { id: 1000 + db.users.length, role: b.role || 'customer', name: b.full_name, email: b.email.toLowerCase(), phone: b.phone, status: 'active', referral_code: code('', 6) }
  db.users.push(u)
  if (u.role === 'driver') db.drivers.push({ id: db.drivers.length + 1, user_id: u.id, city_id: null, onboarding_status: 'incomplete', is_online: false, lat: 13.08, lng: 80.27,
    rank_score: 0, rank_tier: 'New', offered: 0, accepted: 0, completed: 0, late_cancel: 0, bank_verified: false, documents: [], vehicle: null })
  session = { user: u }
  return { access_token: 'demo', refresh_token: 'demo', user: me(u) }
})
on('POST', '/auth/forgot', () => ({ ok: true, message: 'If the email exists, a reset link has been sent.' }))
on('GET', '/auth/me', () => me(need()))
on('PATCH', '/auth/me', (b) => { const u = need(); if (b.full_name) u.name = b.full_name; if (b.language) u.language = b.language; return me(u) })
on('GET', '/auth/addresses', () => (need(), db.addresses))
on('POST', '/auth/addresses', (b) => (need(), db.addresses.push({ id: Date.now(), ...b }), { ok: true }))
on('DELETE', '/auth/addresses/:id', (_, p) => (db.addresses = db.addresses.filter((a) => String(a.id) !== p.id), { ok: true }))
on('GET', '/auth/contacts', () => (need(), db.contacts))
on('POST', '/auth/contacts', (b) => { need(); if (!/^\+91[6-9]\d{9}$/.test(b.phone)) throw err(422, 'Enter a valid Indian mobile number starting +91'); db.contacts.push({ id: Date.now(), ...b }); return { ok: true } })
on('DELETE', '/auth/contacts/:id', (_, p) => (db.contacts = db.contacts.filter((a) => String(a.id) !== p.id), { ok: true }))

// customer
on('GET', '/cities', () => db.cities.filter((c) => c.status === 'active').map((c) => ({ id: c.id, name: c.name, state: c.state, tier: c.tier, center: c.center,
  vehicles: activeCats(c).map((v) => ({ code: v.code, name: v.name, seats: v.seats, description: v.description })) })))
on('GET', '/places', (_, __, q) => {
  const list = PLACES[q.city] || PLACES.Chennai
  const s = (q.q || '').toLowerCase()
  return list.filter((p) => p[0].toLowerCase().includes(s)).slice(0, 7).map(([address, lat, lng]) => ({ address, lat, lng }))
})
on('POST', '/rides/quote', (b) => {
  const u = need('customer')
  const P = { lat: b.pickup_lat, lng: b.pickup_lng }, D = { lat: b.drop_lat, lng: b.drop_lng }
  const city = db.cities.filter((c) => c.status === 'active').sort((x, y) => haversineKm(P, { lat: x.center[0], lng: x.center[1] }) - haversineKm(P, { lat: y.center[0], lng: y.center[1] }))[0]
  if (haversineKm(P, { lat: city.center[0], lng: city.center[1] }) > 60) throw err(422, 'VAYORA is not yet available at this pickup location')
  const route = makeRoute(P, D)
  const km = Math.round(routeLengthKm(route) * 1.12 * 100) / 100
  const at = b.scheduled_for ? new Date(b.scheduled_for) : now()
  const options = activeCats(city).filter((c) => c.is_interstate || km <= 80).map((c) => {
    const minutes = Math.max(1, Math.round(km / ({ bike: 24, auto: 20, car: 22, tourist: 45 })[c.code] * 60))
    const f = calculateFare(city.fares[c.id], { km, minutes, at })
    const hi = calculateFare(city.fares[c.id], { km, minutes: Math.round(minutes * 1.15), at })
    const near = db.drivers.filter((d) => d.city_id === city.id && d.is_online && d.vehicle?.category === c.code)
    return { category: c.code, name: c.name, seats: c.seats, eta_pickup_min: near.length ? 2 + Math.floor(Math.random() * 6) : null, distance_km: km, duration_min: minutes,
             route_source: 'estimate', estimate_low: f.total, estimate_high: Math.max(f.total, hi.total), breakdown: f, peak: f.peak_multiplier > 1,
             quote_token: btoa(JSON.stringify({ uid: u.id, city: city.id, cat: c.code, km, minutes, lo: f.total, hi: hi.total, P, D, exp: Date.now() + 6e5 })) }
  })
  return { city: { id: city.id, name: city.name, tier: city.tier }, options, route, note: 'Estimated fare. Final fare is based on actual distance, time, waiting, tolls and parking.' }
})
on('POST', '/rides', (b) => {
  const u = need('customer')
  if (db.rides.some((r) => r.customer_id === u.id && ['searching', 'assigned', 'arrived', 'in_progress'].includes(r.status))) throw err(409, 'You already have an active ride')
  if (u.cooldown && new Date(u.cooldown) > now()) throw err(429, 'Too many recent cancellations. You can book again shortly.')
  const q = JSON.parse(atob(b.quote_token))
  if (q.exp < Date.now()) throw err(422, 'Quote expired, please refresh the fare')
  let coupon = null
  if (b.coupon_code) {
    coupon = db.coupons.find((c) => c.code === b.coupon_code.toUpperCase() && c.active)
    if (!coupon) throw err(422, 'Coupon is invalid or expired')
    if (coupon.category_code && coupon.category_code !== q.cat) throw err(422, 'Coupon not valid for this vehicle')
  }
  const city = cityById(q.city)
  const f = calculateFare(city.fares[catByCode(q.cat).id], { km: q.km, minutes: q.minutes })
  const r = { id: 10000 + db.rides.length, code: code(), status: b.scheduled_for ? 'scheduled' : 'searching', city_id: q.city, category: q.cat, customer_id: u.id,
              created_at: iso(now()), scheduled_for: b.scheduled_for || null, payment_method: b.payment_method, km: q.km, minutes: q.minutes, est_low: q.lo, est_high: Math.max(q.lo, q.hi),
              est_breakdown: f, pickupPt: { address: b.pickup_address, ...q.P }, dropPt: { address: b.drop_address, ...q.D }, route: makeRoute(q.P, q.D),
              otp: String(1000 + Math.floor(Math.random() * 9000)), timeline: {}, coupon }
  db.rides.push(r)
  if (!b.scheduled_for) simulateCustomerRide(r)
  return rideOut(r, u)
})
on('GET', '/rides', () => {
  const u = need()
  const mine = u.role === 'customer' ? db.rides.filter((r) => r.customer_id === u.id) : db.rides.filter((r) => r.driver_id === driverByUser(u.id)?.id && r.status === 'completed').slice(-30)
  return mine.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).map((r) => rideOut(r, u))
})
const findRide = (id) => db.rides.find((r) => String(r.id) === String(id)) || (() => { throw err(404, 'Ride not found') })()
on('GET', '/rides/:id', (_, p) => rideOut(findRide(p.id), need()))
on('GET', '/rides/:id/receipt', (_, p) => {
  const r = findRide(p.id)
  return { receipt_no: `VYR-${r.code}`, issued_at: r.completed_at, ride: rideOut(r, need()), company: { name: 'VAYORA Mobility Pvt. Ltd.', gstin: 'To be configured', support: 'support@vayora.in' } }
})
on('GET', '/rides/:id/cancel-preview', (_, p) => {
  const r = findRide(p.id), u = need()
  const m = (now() - new Date(r.created_at)) / 6e4
  const free = m <= db.policy.free_window_min
  return { free, minutes_left_free: Math.max(0, Math.round((db.policy.free_window_min - m) * 10) / 10),
           fee_if_cancelled: free ? 0 : u.role === 'customer' ? (r.status === 'arrived' ? db.policy.customer_fee_if_driver_arrived : db.policy.customer_fee_after_window) : db.policy.driver_fee_after_window }
})
on('POST', '/rides/:id/cancel', (b, p) => {
  const u = need(), r = findRide(p.id)
  if (['completed', 'cancelled', 'in_progress'].includes(r.status)) throw err(409, `Ride is ${r.status} and cannot be cancelled`)
  const initiator = u.role === 'customer' ? 'customer' : u.role === 'driver' ? 'driver' : 'admin'
  const recent = db.cancellations.filter((c) => c.user === u.id && now() - new Date(c.at) < 864e5).length
  const dcs = decideCancel({ initiator, createdAt: r.created_at, driverArrived: r.status === 'arrived', recent, policy: db.policy })
  db.cancellations.push({ user: u.id, at: iso(now()), ride: r.id, ...dcs, reason: b.reason })
  sims.get(r.id)?.timers.forEach((t) => { clearTimeout(t); clearInterval(t) })
  if (dcs.cooldown_until) u.cooldown = dcs.cooldown_until
  if (dcs.fee && dcs.fee_payer === 'customer') u.outstanding_dues = String(Number(u.outstanding_dues || 0) + dcs.fee)
  if (initiator === 'driver') { const d = driverByUser(u.id); if (!dcs.within_free_window) d.late_cancel++; r.driver_id = null; r.status = 'searching' }
  else r.status = 'cancelled'
  emit(`ride:${r.id}`, 'ride.status', { ride_id: r.id, status: r.status })
  return { ride: rideOut(r, u), cancellation: dcs }
})
on('POST', '/rides/:id/rate', (b, p) => { const r = findRide(p.id); if (r.rated) throw err(409, 'You have already rated this ride'); r.rated = true; r.rating = b; return { ok: true } })
on('POST', '/rides/:id/sos', (_, p) => {
  const r = findRide(p.id); r.sos = true
  const t = code('SOS', 5)
  db.complaints.unshift({ id: db.complaints.length + 100, ticket: t, category: 'harassment_safety', priority: 'P1', status: 'open', description: 'SOS triggered from app', ride_id: r.id,
                          raised_by: need().name, against: rideOut(r).driver?.name, created_at: iso(now()), sla_due_at: iso(+now() + 3e5), actions: [] })
  return { ok: true, ticket: t, helplines: db.config.sos, message: 'Our safety team has been alerted and your emergency contacts are being notified with your live location.' }
})
on('GET', '/rides/:id/messages', (_, p) => (db.messages[p.id] || []).map((m) => ({ ...m, mine: m.sender === need().id })))
on('POST', '/rides/:id/messages', (b, p) => {
  const u = need()
  const list = (db.messages[p.id] ||= [])
  const msg = { id: Date.now(), sender: u.id, body: b.body, at: iso(now()) }
  list.push(msg)
  emit(`ride:${p.id}`, 'chat', msg)
  if (u.role === 'customer') setTimeout(() => {
    const reply = { id: Date.now() + 1, sender: -1, body: /where|late|eta/i.test(b.body) ? 'Two signals away, reaching in 3 minutes.' : 'Okay, noted 👍', at: iso(now()) }
    list.push(reply); emit(`ride:${p.id}`, 'chat', reply)
  }, 2200)
  return { ok: true }
})
on('POST', '/rides/:id/call', (_, p) => { const r = findRide(p.id); return { status: 'connecting', virtual_number: r.masked || '+91 80 4718 2290', message: 'You will receive a call from this number shortly. Your number stays private.' } })
on('POST', '/complaints', (b) => {
  const u = need()
  const safety = ['unsafe_driving', 'harassment_safety'].includes(b.category)
  const prio = safety ? 'P1' : ['payment_dispute', 'wrong_fare', 'lost_item'].includes(b.category) ? 'P2' : 'P3'
  const c = { ticket: code('TK', 6), category: b.category, status: 'open', priority: prio, created_at: iso(now()), description: b.description, updates: [] }
  db.myComplaints.unshift(c)
  db.complaints.unshift({ id: db.complaints.length + 200, ...c, ride_id: b.ride_id, raised_by: u.name, against: null, sla_due_at: iso(+now() + ({ P1: 1, P2: 24, P3: 72 }[prio]) * 36e5), actions: [] })
  return { ticket: c.ticket, priority: prio, sla_hours: { P1: 1, P2: 24, P3: 72 }[prio] }
})
on('GET', '/complaints', () => db.myComplaints)
on('GET', '/coupons', () => db.coupons.filter((c) => c.active))
on('GET', '/referral', () => ({ code: need().referral_code, invited: 4, rewarded: 2, reward_each: db.config.referral.referrer_reward, friend_gets: db.config.referral.referee_reward }))
on('GET', '/favourites', () => db.drivers.slice(1, 3).map((d) => ({ driver_id: d.id, name: userById(d.user_id).name, tier: d.rank_tier, online: d.is_online })))
on('GET', '/notifications', () => db.notifications)
on('POST', '/notifications/read-all', () => (db.notifications.forEach((n) => (n.read = true)), { ok: true }))

// payments (demo: always succeeds, mirrors server-verified capture)
on('POST', '/payments/rides/:id/order', (_, p) => { const r = findRide(p.id); return { order_id: code('order_', 10), amount_paise: Math.round((r.final_total - r.discount) * 100), currency: 'INR', key_id: '', dev_mode: true } })
on('POST', '/payments/verify', (b) => { const r = db.rides.find((x) => String(x.id) === String(b.ride_id)); if (r) r.payment_status = 'paid'; return { ok: true } })

// driver
const meDriver = () => { const u = need('driver'); return [u, driverByUser(u.id)] }
on('GET', '/driver/onboarding', () => {
  const [, d] = meDriver()
  const docs = Object.fromEntries(d.documents.map((x) => [x.type, { status: x.status }]))
  return { status: d.onboarding_status, city_id: d.city_id, bank: { last4: d.bank_verified ? '1001' : null, verified: d.bank_verified }, documents: docs,
           missing: ['photo', 'licence', 'aadhaar', 'rc', 'insurance', 'vehicle_photo', 'bank_proof'].filter((t) => !docs[t]),
           vehicles: d.vehicle ? [{ id: d.vehicle.id, reg: d.vehicle.reg, category: d.vehicle.category, status: d.vehicle.status }] : [] }
})
on('POST', '/driver/onboarding/documents', (b) => { const [, d] = meDriver(); d.documents = d.documents.filter((x) => x.type !== b.doc_type).concat({ id: Date.now(), type: b.doc_type, status: 'pending' }); return { ok: true } })
on('PUT', '/driver/onboarding/bank', () => { const [, d] = meDriver(); d.bank_verified = true; return { ok: true, message: 'Bank details saved. Verification usually takes a few minutes.' } })
on('POST', '/driver/onboarding/vehicle', (b) => { const [, d] = meDriver(); d.vehicle = { id: Date.now(), category: b.category, reg: b.registration_number, make: b.make, model: b.model, colour: b.colour, status: 'pending' }; return { id: d.vehicle.id } })
on('POST', '/driver/onboarding/submit', () => { const [, d] = meDriver(); if (d.documents.length < 7 || !d.vehicle) throw err(422, 'Upload all 7 documents and add your vehicle first'); d.onboarding_status = 'submitted'; return { ok: true } })
on('POST', '/driver/status', (b) => {
  const [, d] = meDriver()
  if (b.online && d.onboarding_status !== 'approved') throw err(403, 'Your profile is awaiting approval')
  if (b.online && !catByCode(d.vehicle.category).globally_active) throw err(403, `${catByCode(d.vehicle.category).name} rides are currently paused on VAYORA`)
  d.is_online = b.online
  if (b.online) scheduleOffer(d); else clearTimeout(offerTimer)
  return { online: d.is_online }
})
on('GET', '/driver/current', () => { const [u, d] = meDriver(); const r = db.rides.find((x) => x.driver_id === d.id && ['assigned', 'arrived', 'in_progress'].includes(x.status)); return r ? rideOut(r, u) : null })
on('POST', '/driver/rides/:id/accept', (_, p) => {
  const [u, d] = meDriver(), r = findRide(p.id)
  if (r.status !== 'searching') throw err(409, 'Ride already taken or cancelled')
  r.driver_id = d.id; r.status = 'assigned'; r.timeline.assigned = iso(now()); d.accepted++
  return rideOut(r, u)
})
on('POST', '/driver/rides/:id/reject', () => { const [, d] = meDriver(); scheduleOffer(d); return { ok: true } })
on('POST', '/driver/rides/:id/arrived', (_, p) => { const [u] = meDriver(), r = findRide(p.id); r.status = 'arrived'; r.timeline.arrived = iso(now()); return rideOut(r, u) })
on('POST', '/driver/rides/:id/start', (b, p) => {
  const [u] = meDriver(), r = findRide(p.id)
  if (b.otp !== r.otp) throw err(422, 'Incorrect OTP')
  r.status = 'in_progress'; r.timeline.started = iso(now()); r.waiting = 2
  return rideOut(r, u)
})
on('POST', '/driver/rides/:id/complete', (b, p) => { const [u, d] = meDriver(), r = findRide(p.id); completeRide(r, { km: r.km, tolls: Number(b.tolls || 0), parking: Number(b.parking || 0) }); d.completed++; d.lat = r.dropPt.lat; d.lng = r.dropPt.lng; if (d.is_online) scheduleOffer(d); return rideOut(r, u) })

function earnedBetween(did, s, e) {
  const rs = db.rides.filter((r) => r.driver_id === did && r.status === 'completed' && new Date(r.completed_at) >= s && new Date(r.completed_at) < e)
  const sum = (k) => Math.round(rs.reduce((a, r) => a + Number(r[k] || 0), 0) * 100) / 100
  return { rides: rs.length, gross_fare: sum('ride_fare'), commission: sum('commission'), earnings: sum('driver_earnings'),
           cash_collected: Math.round(rs.filter((r) => r.payment_method === 'cash').reduce((a, r) => a + r.final_total, 0)) }
}
on('GET', '/driver/earnings', () => {
  const [, d] = meDriver()
  const t = new Date(); t.setHours(0, 0, 0, 0)
  const week = new Date(+t - ((t.getDay() + 6) % 7) * 864e5), month = new Date(t.getFullYear(), t.getMonth(), 1), end = new Date(+now() + 1000)
  const daily = [...Array(14)].map((_, i) => { const s = new Date(+t - (13 - i) * 864e5); return { date: s.toISOString().slice(0, 10), ...earnedBetween(d.id, s, new Date(+s + 864e5)) } })
  const todays = db.rides.filter((r) => r.driver_id === d.id && r.status === 'completed' && new Date(r.completed_at) >= t)
  const pending = todays.reduce((a, r) => a + (r.payment_method === 'online' ? r.driver_earnings : -r.commission), 0)
  return { today: earnedBetween(d.id, t, end), week: earnedBetween(d.id, week, end), month: earnedBetween(d.id, month, end),
           lifetime_paid_out: 148250, pending_settlement: Math.round(pending * 100) / 100, cash_commission_due: Math.max(0, -Math.round(pending * 100) / 100), daily,
           policy: 'Online earnings are paid to your verified bank account the next day after commission. Commission on cash rides is netted against that payout.' }
})
on('GET', '/driver/ledger', () => {
  const [, d] = meDriver()
  return db.rides.filter((r) => r.driver_id === d.id && r.status === 'completed').sort((a, b) => new Date(b.completed_at) - new Date(a.completed_at)).slice(0, 40).map((r, i) => ({
    id: i + 1, type: r.payment_method === 'online' ? 'ride_earning_online' : 'ride_commission_cash', amount: r.payment_method === 'online' ? r.driver_earnings : -r.commission,
    memo: r.payment_method === 'online' ? `Ride ${r.code}: fare ₹${r.ride_fare} − commission ₹${r.commission}` : `Ride ${r.code}: cash ₹${r.final_total} collected, commission payable`,
    at: r.completed_at, settled: new Date(r.completed_at) < new Date(new Date().setHours(0, 0, 0, 0)) }))
})
on('GET', '/driver/settlements', () => {
  const [, d] = meDriver()
  return [...Array(10)].map((_, i) => {
    const day = new Date(Date.now() - (i + 1) * 864e5)
    const e = earnedBetween(d.id, new Date(day.setHours(0, 0, 0, 0)), new Date(+day + 864e5))
    const online = Math.round(e.earnings * 0.6), cash = -Math.round(e.commission * 0.4)
    const net = online + cash
    const failed = i === 3
    return { date: day.toISOString().slice(0, 10), online, cash_commission: cash, other: 0, net, status: net <= 1 ? 'carried_forward' : failed ? 'failed' : 'paid',
             note: net <= 1 ? 'Cash commission carried forward' : 'Payout scheduled', payout: net > 1 ? { status: failed ? 'failed' : 'success', utr: failed ? null : 'HDFCN' + (52600000 + i * 311), failure: failed ? 'Beneficiary bank timeout. Retrying automatically.' : null } : null }
  })
})
on('GET', '/driver/performance', () => {
  const [, d] = meDriver()
  const acc = d.accepted / d.offered, comp = d.completed / d.accepted, canc = 1 - d.late_cancel / d.accepted
  const rating = 4.82
  const f = { rating: (rating - 1) / 4, completion: comp, acceptance: acc, cancellation: canc, safety: 1 }
  const W = { rating: 40, completion: 20, acceptance: 15, cancellation: 10, safety: 15 }
  const factors = Object.fromEntries(Object.keys(W).map((k) => [k, { value: (f[k] * 100).toFixed(1), weight: W[k], points: (f[k] * W[k]).toFixed(1) }]))
  const score = Object.values(factors).reduce((a, x) => a + Number(x.points), 0).toFixed(1)
  const tips = []
  if (acc < 0.9) tips.push('Accept more requests while online: your acceptance is below 90%.')
  if (d.late_cancel > 2) tips.push('Cancelling after the free 15-minute window lowers your rank.')
  tips.push('Riders who left 5 stars most often mentioned punctuality and a clean vehicle.')
  return { score, tier: score >= 90 ? 'Platinum' : score >= 80 ? 'Gold' : 'Silver', city_rank: 7, city_total: 412,
           snapshot: { rating: { bayesian: rating, verified_count: 1284 }, factors, tips },
           counts: { offered: d.offered, accepted: d.accepted, completed: d.completed, late_cancellations: d.late_cancel },
           feedback: [[5, ['Punctual', 'Clean vehicle'], 'Very polite, smooth ride.'], [5, ['Safe driving'], null], [4, ['Knew the route'], 'AC could be cooler.'],
                      [5, ['Friendly'], 'Helped with luggage.'], [3, [], 'Took a longer route.'], [5, ['Punctual'], null]].map(([stars, tags, comment], i) => ({ stars, tags, comment, at: iso(Date.now() - i * 9e7) })) }
})

// admin
const admin = () => need('admin')
on('GET', '/admin/overview', (_, __, q) => {
  admin()
  const days = Number(q.days || 30), since = Date.now() - days * 864e5
  const rs = db.rides.filter((r) => new Date(r.created_at) >= since)
  const done = rs.filter((r) => r.status === 'completed')
  const sum = (arr, k) => Math.round(arr.reduce((a, r) => a + Number(r[k] || 0), 0))
  const byCity = {}, byVeh = {}, daily = {}
  rs.forEach((r) => {
    const c = cityById(r.city_id).name
    byCity[c] ||= { city: c, rides: 0, gbv: 0, cancelled: 0 }; byCity[c].rides++; byCity[c].gbv += r.final_total || 0; if (r.status === 'cancelled') byCity[c].cancelled++
    const v = catByCode(r.category).name
    byVeh[v] ||= { vehicle: v, rides: 0, gbv: 0 }; byVeh[v].rides++; byVeh[v].gbv += r.final_total || 0
    const dk = r.created_at.slice(0, 10)
    daily[dk] ||= { date: dk, rides: 0, commission: 0 }; daily[dk].rides++; daily[dk].commission += r.commission || 0
  })
  return { range_days: days, kpis: {
    total_bookings: rs.length, completed: done.length, cancelled: rs.length - done.length,
    live_rides: db.rides.filter((r) => ['assigned', 'arrived', 'in_progress'].includes(r.status)).length + 37,
    active_drivers: db.drivers.filter((d) => d.is_online).length, approved_drivers: db.drivers.filter((d) => d.onboarding_status === 'approved').length,
    pending_driver_approvals: db.drivers.filter((d) => d.onboarding_status === 'submitted').length, registered_customers: db.users.filter((u) => u.role === 'customer').length,
    gross_bookings_value: sum(done, 'final_total'), company_commission: sum(done, 'commission'), driver_earnings: sum(done, 'driver_earnings'), promotions_cost: 4350,
    pending_settlements: 86420, payout_failures: 2, open_complaints: db.complaints.filter((c) => c.status !== 'resolved').length,
    open_safety: db.complaints.filter((c) => c.priority === 'P1' && c.status !== 'resolved').length },
    by_city: Object.values(byCity).sort((a, b) => b.gbv - a.gbv).map((x) => ({ ...x, gbv: Math.round(x.gbv) })),
    by_vehicle: Object.values(byVeh).map((x) => ({ ...x, gbv: Math.round(x.gbv) })),
    daily: Object.values(daily).sort((a, b) => a.date.localeCompare(b.date)).map((x) => ({ ...x, commission: Math.round(x.commission) })) }
})
on('GET', '/admin/rides', (_, __, q) => { const u = admin(); return db.rides.filter((r) => !q.status || r.status === q.status).filter((r) => !q.q || r.code.includes(q.q.toUpperCase())).slice(-60).reverse().map((r) => rideOut(r, u)) })
on('GET', '/admin/users', (_, __, q) => {
  admin()
  const s = (q.q || '').toLowerCase()
  return db.users.filter((u) => u.role === (q.role || 'customer')).filter((u) => !s || u.name.toLowerCase().includes(s) || u.email.includes(s) || u.phone.includes(s)).map((u) => {
    const d = driverByUser(u.id)
    return { id: u.id, name: u.name, email: u.email, phone: u.phone, status: u.status, fraud_flag: !!u.fraud_flag, joined: iso(Date.now() - (u.id % 90) * 864e5),
             rides: db.rides.filter((r) => r.customer_id === u.id).length,
             driver: d && { id: d.id, onboarding: d.onboarding_status, tier: d.rank_tier, score: d.rank_score, online: d.is_online, city: cityById(d.city_id)?.name, vehicle: d.vehicle } }
  })
})
on('POST', '/admin/users/:id/action', (b, p) => {
  const a = admin(), u = userById(Number(p.id))
  const map = { restrict: 'restricted', suspend: 'suspended', deactivate: 'deactivated', restore: 'active', appeal_upheld: 'active' }
  const before = { status: u.status }
  if (map[b.action]) u.status = map[b.action]
  const d = driverByUser(u.id); if (d && ['suspend', 'deactivate'].includes(b.action)) d.is_online = false
  audit(a, `user.${b.action}`, 'user', u.id, before, { status: u.status }, b.reason)
  return { ok: true, status: u.status }
})
on('GET', '/admin/drivers/pending', () => (admin(), db.drivers.filter((d) => d.onboarding_status === 'submitted').map((d) => ({
  driver_id: d.id, name: userById(d.user_id).name, city: cityById(d.city_id)?.name, licence: 'TN0920230012345', submitted_at: iso(Date.now() - d.id * 3e6), bank_verified: true,
  documents: d.documents, vehicles: [{ id: d.vehicle.id, reg: d.vehicle.reg, category: d.vehicle.category, status: d.vehicle.status, insurance_expiry: d.vehicle.insurance_expiry }] }))))
on('POST', '/admin/documents/:id/review', (b, p) => {
  const a = admin()
  for (const d of db.drivers) for (const doc of d.documents) if (String(doc.id) === p.id) { audit(a, `document.${b.status}`, 'driver_document', doc.id, { status: doc.status }, { status: b.status }, b.note); doc.status = b.status }
  return { ok: true }
})
on('POST', '/admin/drivers/:id/decision', (b, p) => {
  const a = admin(), d = db.drivers.find((x) => String(x.id) === p.id)
  if (b.approve && d.documents.some((x) => x.status !== 'verified')) throw err(422, `Verify all documents first: ${d.documents.filter((x) => x.status !== 'verified').map((x) => x.type).join(', ')}`)
  const before = { onboarding_status: d.onboarding_status }
  d.onboarding_status = b.approve ? 'approved' : 'rejected'
  if (b.approve) d.vehicle.status = 'approved'
  audit(a, b.approve ? 'driver.approve' : 'driver.reject', 'driver', d.id, before, { onboarding_status: d.onboarding_status }, b.reason)
  return { ok: true }
})
on('GET', '/admin/vehicles', () => (admin(), db.drivers.filter((d) => d.vehicle).map((d) => ({ id: d.vehicle.id, reg: d.vehicle.reg, category: d.vehicle.category, make: d.vehicle.make, model: d.vehicle.model,
  driver: userById(d.user_id).name, status: d.vehicle.status, insurance_expiry: d.vehicle.insurance_expiry, insurance_expired: new Date(d.vehicle.insurance_expiry) < now() }))))
on('POST', '/admin/vehicles/:id/status', (b, p) => {
  const a = admin(), d = db.drivers.find((x) => String(x.vehicle?.id) === p.id)
  audit(a, `vehicle.${b.status}`, 'vehicle', p.id, { status: d.vehicle.status }, { status: b.status }, b.reason)
  d.vehicle.status = b.status; if (b.status !== 'approved') d.is_online = false
  return { ok: true }
})
on('GET', '/admin/categories', () => (admin(), db.cats))
on('POST', '/admin/categories/:id/toggle', (b, p) => {
  const a = admin(), c = db.cats.find((x) => String(x.id) === p.id)
  audit(a, 'category.toggle', 'vehicle_category', c.id, { globally_active: c.globally_active }, { globally_active: b.active }, b.reason)
  c.globally_active = b.active
  if (!b.active) db.drivers.filter((d) => d.vehicle?.category === c.code).forEach((d) => (d.is_online = false))
  return { ok: true }
})
on('GET', '/admin/cities', () => (admin(), db.cities.map((c) => ({ id: c.id, name: c.name, state: c.state, tier: c.tier, status: c.status, center: c.center, operating_hours: c.operating_hours,
  restrictions: c.restrictions, zones: c.zones, vehicles: db.cats.map((k) => ({ category_id: k.id, code: k.code, name: k.name, active: !!c.vehicles[k.id], globally_active: k.globally_active, priced: true })),
  rides_30d: db.rides.filter((r) => r.city_id === c.id).length }))))
on('POST', '/admin/cities', (b) => {
  const a = admin()
  if (db.cities.some((c) => c.name.toLowerCase() === b.name.toLowerCase())) throw err(409, 'City already exists')
  const c = { id: db.cities.length + 1, name: b.name, state: b.state, tier: b.tier, status: 'draft', center: [Number(b.center_lat), Number(b.center_lng)], operating_hours: { open: '00:00', close: '23:59' },
              restrictions: {}, zones: [], vehicles: Object.fromEntries(db.cats.map((k) => [k.id, false])),
              fares: Object.fromEntries(db.cats.map((k) => [k.id, { ...ruleFrom(TIER_RULES[b.tier][k.code], k.code === 'tourist' ? [] : undefined), version: 1 }])) }
  db.cities.push(c)
  audit(a, 'city.create', 'city', c.id, null, { name: c.name, tier: c.tier })
  return { id: c.id, status: c.status }
})
on('POST', '/admin/cities/:id/status', (b, p) => {
  const a = admin(), c = cityById(Number(p.id))
  if (b.status === 'active' && a.admin_role !== 'super_admin') throw err(403, 'Only the Super Admin can activate a city')
  if (b.status === 'active' && !Object.values(c.vehicles).some(Boolean)) throw err(422, 'Enable and price at least one vehicle type before activating')
  audit(a, `city.${b.status}`, 'city', c.id, { status: c.status }, { status: b.status }, b.reason)
  c.status = b.status
  return { ok: true }
})
on('POST', '/admin/cities/:id/vehicles/:cat', (b, p) => { const a = admin(), c = cityById(Number(p.id)); audit(a, 'city.vehicle_toggle', 'city_vehicle', `${p.id}:${p.cat}`, { active: c.vehicles[p.cat] }, { active: b.active }); c.vehicles[p.cat] = b.active; return { ok: true } })
on('GET', '/admin/cities/:id/fares', (_, p) => { admin(); const c = cityById(Number(p.id)); return db.cats.map((k) => ({ category_id: k.id, code: k.code, name: k.name, rule: c.fares[k.id] })) })
on('PUT', '/admin/cities/:id/fares/:cat', (b, p) => {
  const a = admin(), c = cityById(Number(p.id)), old = c.fares[p.cat]
  const next = { ...old, ...Object.fromEntries(Object.entries(b).map(([k, v]) => [k, k === 'peak_windows' ? v : Number(v)])), version: old.version + 1 }
  c.fares[p.cat] = next
  audit(a, 'fare.update', 'fare_rule', `${p.id}:${p.cat}`, { base_fare: old.base_fare, per_km: old.per_km, per_min: old.per_min, minimum_fare: old.minimum_fare, version: old.version },
        { base_fare: next.base_fare, per_km: next.per_km, per_min: next.per_min, minimum_fare: next.minimum_fare, version: next.version })
  return { version: next.version }
})
on('GET', '/admin/finance/commission', () => (admin(), { slabs: db.slabs, commission_tax_rate: '0',
  examples: Object.fromEntries([200, 500, 1000].map((x) => [x, split(x, { slabs: db.slabs })])) }))
on('PUT', '/admin/finance/commission', (b) => {
  const a = admin()
  const s = b.slabs
  if (!s.length || (s[s.length - 1].upper !== null && s[s.length - 1].upper !== '')) throw err(422, 'last slab must be open-ended (upper = null)')
  for (let i = 1; i < s.length - 1; i++) if (Number(s[i].upper) <= Number(s[i - 1].upper)) throw err(422, 'slab upper bounds must be strictly increasing')
  if (s.some((x) => Number(x.rate) < 0 || Number(x.rate) > 0.5)) throw err(422, 'commission rate must be between 0% and 50%')
  audit(a, 'commission.update', 'setting', 'commission_slabs', { slabs: db.slabs }, { slabs: s }, b.reason)
  db.slabs = s
  return { ok: true }
})
on('GET', '/admin/finance/settlements', () => {
  admin()
  const y = new Date(Date.now() - 864e5).toISOString().slice(0, 10)
  return db.drivers.filter((d) => d.onboarding_status === 'approved').slice(0, 24).map((d, i) => {
    const online = Math.round(600 + rnd() * 2400), cash = -Math.round(rnd() * 380), net = online + cash
    const failed = db.settlementsFailed.has(i)
    return { id: i + 1, driver: userById(d.user_id).name, driver_id: d.id, date: y, online, cash_commission: cash, other: 0, net, status: failed ? 'failed' : i === 9 ? 'on_hold' : 'paid',
             note: i === 9 ? 'Bank account not verified; payout on hold' : 'Payout scheduled',
             payout: i === 9 ? null : { id: i + 1, status: failed ? 'failed' : 'success', attempts: failed ? 2 : 1, utr: failed ? null : 'ICICN' + (81700000 + i * 97), failure: failed ? 'Beneficiary account closed' : null } }
  })
})
on('POST', '/admin/finance/payouts/:id/retry', (_, p) => { const a = admin(); db.settlementsFailed.delete(Number(p.id) - 1); audit(a, 'payout.retry', 'payout', p.id, { status: 'failed' }, { status: 'processing' }); return { ok: true } })
on('GET', '/admin/finance/reconciliation', (_, __, q) => {
  admin()
  const done = db.rides.filter((r) => r.status === 'completed' && r.completed_at?.slice(0, 10) === q.day)
  const cash = done.filter((r) => r.payment_method === 'cash'), online = done.filter((r) => r.payment_method === 'online')
  const s = (a, k) => Math.round(a.reduce((x, r) => x + Number(r[k] || 0), 0))
  return { date: q.day, completed_rides: done.length, cash: { rides: cash.length, collected_by_drivers: s(cash, 'final_total'), commission_receivable: s(cash, 'commission') },
           online: { rides: online.length, collected: s(online, 'final_total'), driver_payable: s(online, 'driver_earnings') },
           issues: done.length ? [{ ride: done[0].code, issue: 'captured payment not posted to driver ledger' }] : [] }
})
on('POST', '/admin/finance/adjustments', (b) => { const a = admin(); audit(a, 'ledger.adjust', 'driver', b.driver_id, null, { amount: b.amount }, b.reason); return { ok: true } })
on('GET', '/admin/complaints', () => (admin(), db.complaints.map((c) => ({ ...c, overdue: new Date(c.sla_due_at) < now() && c.status !== 'resolved' }))))
on('POST', '/admin/complaints/:id/update', (b, p) => {
  const a = admin(), c = db.complaints.find((x) => String(x.id) === p.id)
  if (['unsafe_driving', 'harassment_safety'].includes(c.category) && b.kind === 'resolve' && b.upheld && !b.severity) throw err(422, 'Set a severity for upheld safety complaints')
  const before = { status: c.status }
  c.status = { assign: 'investigating', request_evidence: 'awaiting_evidence', resolve: 'resolved', reject: 'rejected', appeal: 'appealed' }[b.kind] || c.status
  if (b.kind === 'resolve') Object.assign(c, { upheld: b.upheld, severity: b.severity, resolution: b.body })
  c.actions = [...c.actions, { kind: b.kind, body: b.body, internal: b.kind === 'note', at: iso(now()), by: a.name }]
  audit(a, `complaint.${b.kind}`, 'complaint', c.id, before, { status: c.status })
  return { ok: true, status: c.status }
})
on('GET', '/admin/config', () => (admin(), { cancellation_policy: db.policy, ...db.config, commission_slabs: db.slabs }))
on('PUT', '/admin/config/:key', (b, p) => {
  const a = admin()
  if (p.key === 'cancellation_policy') {
    const merged = { ...db.policy, ...b.value }
    if (Number(merged.free_window_min) < 15) throw err(422, 'The free cancellation window cannot be shorter than 15 minutes (platform promise)')
    audit(a, 'config.update', 'setting', p.key, { value: db.policy }, { value: merged }, b.reason)
    db.policy = Object.fromEntries(Object.entries(merged).map(([k, v]) => [k, typeof v === 'string' && !isNaN(v) ? Number(v) : v]))
  } else { audit(a, 'config.update', 'setting', p.key, { value: db.config[p.key] }, { value: b.value }, b.reason); db.config[p.key] = b.value }
  return { ok: true }
})
on('GET', '/admin/coupons', () => (admin(), db.coupons))
on('POST', '/admin/coupons', (b) => { const a = admin(); const c = { id: db.coupons.length + 1, active: true, ...b }; db.coupons.unshift(c); audit(a, 'coupon.create', 'coupon', c.id, null, { code: c.code }); return { id: c.id } })
on('GET', '/admin/admins', () => (admin(), { roles: {
  super_admin: ['admins:manage', 'audit:view', 'cities:activate', 'cities:manage', 'complaints:manage', 'config:manage', 'customers:manage', 'dashboard:view', 'documents:verify', 'drivers:manage', 'finance:manage', 'finance:view', 'pricing:manage', 'vehicles:manage'],
  ops_admin: ['audit:view', 'cities:manage', 'complaints:manage', 'customers:manage', 'dashboard:view', 'documents:verify', 'drivers:manage', 'vehicles:manage'],
  finance_admin: ['audit:view', 'dashboard:view', 'finance:manage', 'finance:view', 'pricing:manage'], support_agent: ['complaints:manage', 'customers:manage', 'dashboard:view'] },
  admins: [{ id: 1, name: 'Platform Owner', email: 'admin@vayora.in', admin_role: 'super_admin', status: 'active' }, { id: 7, name: 'Kavitha Ops', email: 'ops@vayora.in', admin_role: 'ops_admin', status: 'active' },
           { id: 8, name: 'Sanjay Finance', email: 'finance@vayora.in', admin_role: 'finance_admin', status: 'active' }] }))
on('GET', '/admin/audit', () => (admin(), db.audit))
on('POST', '/ai/chat', (b) => aiReply(need(), b.message))

export async function handle(method, url, body) {
  const [path, qs] = url.split('?')
  const query = Object.fromEntries(new URLSearchParams(qs || ''))
  await new Promise((r) => setTimeout(r, 160 + Math.random() * 220))   // feel like a network
  for (const r of routes) {
    if (r.method !== method) continue
    const m = path.match(r.re)
    if (m) { try { return structuredClone(r.fn(body || {}, m.groups || {}, query)) } catch (e) { if (e.status === 404) console.warn('demo 404', method, path); throw e } }
  }
  throw err(404, `Demo route not implemented: ${method} ${path}`)
}
export const demoLogout = () => { session = null }
export const demoSession = () => session && me(session.user)
