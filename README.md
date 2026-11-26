# VAYORA: Indian mobility platform

Book bikes, autos, cars and interstate tourist vehicles. One platform with three portals: **Rider**, **Driver** and **Super Admin**.
The backend and all business logic are Python (FastAPI). The frontend is React written in plain JavaScript (no TypeScript).

```
vayora/
├── backend/                 Python · FastAPI · SQLAlchemy · Alembic · Celery
│   ├── app/engines/         Pure business rules (fare, commission, settlement, cancellation, ranking, quotes, geo)
│   ├── app/models/          PostgreSQL schema (users, cities, fares, rides, ledgers, payouts, complaints, audit…)
│   ├── app/api/routes/      auth · customer · driver · admin · payments · ai · ws
│   ├── app/services/        rides lifecycle, ledger, Razorpay, telephony (masked calls), Gemini, FCM, maps, realtime
│   ├── app/workers/         Celery: T+1 settlement, payouts, ranking, scheduled rides, expiries
│   └── tests/               pytest for every engine (30 tests)
├── frontend/                React (JS) + Vite
│   ├── src/lib/router.jsx   Vehicle page-transition system (one reusable component)
│   ├── src/motion/          Original vehicle illustrations + hero road scene
│   ├── src/pages/           customer/ · driver/ · admin/
│   ├── src/assistant/       Vaya: AI chat + voice booking
│   └── src/api/             API client (live) + in-browser demo backend
└── docker-compose.yml       Postgres, Redis, API, Celery worker+beat
```

## Run it

**Frontend only (demo mode, no server needed)**
```bash
cd frontend && npm install && npm run dev        # leave VITE_API_URL empty
```
Demo logins are on the sign-in screen: Rider, Driver, Super Admin.

**Full stack**
```bash
cp backend/.env.example backend/.env             # set JWT_SECRET and QUOTE_SECRET
docker compose up -d db redis
cd backend && pip install -r requirements.txt
alembic upgrade head
python -m app.seed                               # 12 cities (8 live), fares, demo accounts, coupons
uvicorn app.main:app --reload                    # API docs at http://localhost:8000/docs
celery -A app.workers.celery_app worker -B -l info
cd ../frontend && cp .env.example .env && npm install && npm run dev
```
Development seed accounts are available for local testing.
Never use development credentials in production.

Tests: `cd backend && pytest -q`

## Business rules as implemented

| Requirement | Where | Behaviour |
|---|---|---|
| Fare by time + distance, city tier | `engines/fare.py` | base + ₹/km + ₹/min + waiting (after free minutes) + peak multiplier (capped), minimum fare, tolls/parking. Per city × vehicle, versioned. Metro / Tier-2 / Other defaults. |
| Estimate vs final | `services/rides.py` | Customer sees a range before booking; final uses actual km/min. The browser never sends a fare: it gets an HMAC-signed quote (`engines/quote.py`) and the server recomputes the fare. |
| Commission 10 / 15 / 20 % | `engines/commission.py` | ≤ ₹300 → 10 %, > ₹300 and < ₹700 → 15 %, ≥ ₹700 → 20 % on the whole fare. ₹200→₹20, ₹500→₹75, ₹1,000→₹200. Editable in Admin → Finance (validated). |
| Taxes, refunds, extras | same | Tolls/parking are 100 % the driver's. Taxes are remitted, not split. Coupons are company-funded (driver paid on full fare). Refunds reverse commission proportionally. Optional GST on commission. |
| Next-day payout after commission & cash | `engines/settlement.py`, `workers/tasks.py` | Immutable driver ledger: online ride = +earnings, cash ride = −commission. At 00:30 IST each driver's unsettled entries are netted. Net > 0 → RazorpayX payout; net ≤ 0 → dues carry forward. Unique keys stop double deductions. A payout is marked successful **only** from a verified Razorpay webhook (UTR stored). Failures retry the same payout. |
| Driver ranking from feedback | `engines/ranking.py` | 0–100 score: verified ratings 40 %, completion 20 %, acceptance 15 %, late cancels 10 %, safety 15 %. One rating per ride, from that ride's rider, within 7 days, on completed trips only. Repeat raters are dampened (1/n), there is a Bayesian prior, and flagged accounts are excluded. Drivers see every factor and tips. |
| Free cancellation 15 min, both sides | `engines/cancellation.py` | Measured from the server's booking timestamp. After 15 min, admin-set fees apply (driver compensated). Repeat cancellers get a cooldown + fraud flag, and admins can optionally charge them. The window can't be set below 15 min. Everything is stored: timestamps, initiator, reason, policy, fee, refund status. |
| Complaints, suspend driver/vehicle | `routes/admin.py` | 10 categories. Safety = P1 with a 1 h SLA. Notes, evidence requests, warn / restrict / suspend / deactivate / restore / appeal, vehicle suspension. Every action is audited. |
| Masked calls | `services/telephony.py` | Virtual number per ride (Exotel adapter + mock; provider is swappable). Phone numbers are never in any API response. Call metadata only; recording is off by default. |
| Vehicle types can be discontinued | Admin → Vehicles / Cities | Global switch and per-city switch. Riders only see a type when both are on and it is priced. |
| Admin-only city activation | Admin → Cities | New cities are drafts. Only `super_admin` (`cities:activate`) can activate, and only once a priced vehicle type is enabled. |

Also included: RBAC (super / ops / finance / support), an append-only audit log, WebSocket live tracking, OTP-to-start, SOS (safety desk + emergency contacts), in-app chat, scheduled rides, coupons, referrals, favourite drivers, receipts, CSV statements and reports, 6 languages, Gemini assistants for each role (the key stays on the server), and voice booking via the Web Speech API.

## Signature animation
`src/lib/router.jsx`: every navigation drives a vehicle (bike / auto / car / tourist, matching the rider's choice or the section) across a road that appears at the bottom of the screen. The new page is revealed behind it, so the vehicle pulls the page in. It runs on the compositor (Web Animations API + `clip-path`). The incoming page isn't remounted afterwards. `prefers-reduced-motion` gets a short fade instead. The brief asked for GSAP, but the native Web Animations API does the same job without a dependency. GSAP can be added to `VehicleTransition` if you want its timeline tools.

## Colours
`frontend/src/styles/tokens.css`: sage `#A5A79B`, cream `#E8D2B5`, burgundy `#650907`. To swap the burgundy everywhere, change `--accent` (and `--accent-hover`).

## Integrations: what's live vs. what needs keys
Each one has a working development fallback when its key is blank:
- **Razorpay** (payments, refunds, RazorpayX payouts, webhooks). Without keys there is a dev order/payout path (never used in `ENV=production`).
- **Exotel** masked calling. Uses the `mock` provider otherwise.
- **Gemini**. Falls back to rule-based answers.
- **Google Sign-In** (`VITE_GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_ID`), **Google Distance Matrix / Places** (`GOOGLE_MAPS_API_KEY`). Without them, haversine routing and built-in landmarks are used.
- **FCM** push (`FCM_CREDENTIALS_FILE`).
- **Maps:** the UI draws its own vector city map (`components/CityMap.jsx`), which projects real coordinates. To use Google Maps or Mapbox tiles, replace that component and keep its props.

## Before production
- Run `alembic upgrade head` to apply the existing database migrations.
- Production hardening: KMS for bank-account encryption (currently Fernet derived from `JWT_SECRET`), Redis-backed rate limits (currently in-process), object storage + signed URLs for KYC files, and a Redis lease for the virtual-number pool.
- SOS currently logs the emergency-contact alert. Connect an SMS gateway in `workers/tasks.py → alert_emergency_contacts`.
- RazorpayX fund-account validation (penny drop) is stubbed in `verify_bank_account`.
