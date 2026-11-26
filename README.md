# VAYORA — Indian Mobility Platform

<p align="center">
  <strong>One platform. Three portals. Smarter mobility across India.</strong>
</p>

<p align="center">
  <a href="https://vayora-web.onrender.com">🌐 Live Website</a> ·
  <a href="https://vayora-aflo.onrender.com/docs">⚙️ API Documentation</a> ·
  <a href="https://github.com/Deepthi-M03/VAYORA">💻 GitHub Repository</a>
</p>

VAYORA is an Indian ride-hailing platform designed to connect riders and drivers through a unified mobility ecosystem. It supports bikes, autos, cars and interstate tourist vehicles through three dedicated portals: **Rider, Driver and Super Admin**.

The backend and business logic are built with Python and FastAPI. The frontend uses React with plain JavaScript and Vite.

## 🚀 Live Deployment

| Component | Link |
|---|---|
| VAYORA Web Application | https://vayora-web.onrender.com |
| Backend API | https://vayora-aflo.onrender.com |
| API Documentation | https://vayora-aflo.onrender.com/docs |
| Source Code | https://github.com/Deepthi-M03/VAYORA |

**Deployment stack:** Render · PostgreSQL · Redis

The frontend and backend are deployed separately, with PostgreSQL and Redis configured as supporting services.

> Note: The live deployment is an initial hosted version. Complete production readiness depends on end-to-end testing, production credentials and the remaining third-party integrations. Render free services may sleep after inactivity.

## 🏗️ Project Architecture

```text
vayora/
├── backend/                 Python · FastAPI · SQLAlchemy · Alembic · Celery
│   ├── app/engines/         Pure business rules (fare, commission, settlement,
│   │                       cancellation, ranking, quotes, geo)
│   ├── app/models/          PostgreSQL schema (users, cities, fares, rides,
│   │                       ledgers, payouts, complaints, audit…)
│   ├── app/api/routes/      auth · customer · driver · admin · payments · ai · ws
│   ├── app/services/        ride lifecycle, ledger, Razorpay, telephony,
│   │                       Gemini, FCM, maps, realtime
│   ├── app/workers/         Celery: T+1 settlement, payouts, ranking,
│   │                       scheduled rides, expiries
│   └── tests/               pytest tests for business engines
│
├── frontend/                React (JavaScript) + Vite
│   ├── src/lib/router.jsx   Reusable vehicle page-transition system
│   ├── src/motion/          Original vehicle illustrations + hero road scene
│   ├── src/pages/           customer/ · driver/ · admin/
│   ├── src/assistant/       Vaya: AI chat + voice booking
│   └── src/api/             API client + in-browser demo backend
│
└── docker-compose.yml       PostgreSQL, Redis, API, Celery worker + beat
```

## 🛠️ Technology Stack

| Layer | Technologies |
|---|---|
| Frontend | React, JavaScript, Vite, CSS |
| Backend | Python, FastAPI |
| Database | PostgreSQL, SQLAlchemy |
| Migrations | Alembic |
| Background jobs | Celery |
| Realtime | WebSockets, Redis |
| Payments | Razorpay / RazorpayX integration |
| AI assistant | Google Gemini integration |
| Maps | Google Maps integration with fallback routing |
| Deployment | Render |
| Version control | Git, GitHub |

## ▶️ Run Locally

### Frontend only — Demo Mode

No backend or database is required.

```bash
cd frontend
npm install
npm run dev
```

Leave `VITE_API_URL` empty to use the in-browser demo backend.

Demo logins are available on the sign-in screen for Rider, Driver and Super Admin.

### Full Stack

1. Configure the backend environment:

```bash
cp backend/.env.example backend/.env
```

Set secure values for `JWT_SECRET` and `QUOTE_SECRET` in your environment file.

2. Start PostgreSQL and Redis:

```bash
docker compose up -d db redis
```

3. Install backend dependencies:

```bash
cd backend
pip install -r requirements.txt
```

4. Apply database migrations:

```bash
alembic upgrade head
```

5. Seed development data:

```bash
python -m app.seed
```

The development seed includes 12 cities (8 live), fare configurations, demo accounts and coupons.

6. Start the API:

```bash
uvicorn app.main:app --reload
```

API documentation:

```text
http://localhost:8000/docs
```

7. Start the Celery worker:

```bash
celery -A app.workers.celery_app worker -B -l info
```

8. Start the frontend in another terminal:

```bash
cd frontend
cp .env.example .env
npm install
npm run dev
```

Development seed accounts are for local testing only. Never use development credentials in production.

## 🧠 Business Rules

| Requirement | Implementation | Behaviour |
|---|---|---|
| Dynamic fares | `engines/fare.py` | Fare based on distance, time, waiting, peak multiplier, minimum fare, tolls, parking and city tier. |
| Fare estimation | `services/rides.py` | Estimated fare range before booking; server recomputes the final fare. |
| Signed ride quotes | `engines/quote.py` | HMAC-signed quotes prevent the browser from controlling ride fares. |
| Company commission | `engines/commission.py` | Up to ₹300: 10%; above ₹300 and below ₹700: 15%; ₹700 and above: 20%. |
| Driver settlement | `engines/settlement.py` | Online earnings and cash-ride commission are tracked through an immutable ledger for T+1 settlement. |
| Driver ranking | `engines/ranking.py` | Driver score considers verified ratings, completion, acceptance, cancellations and safety. |
| Cancellation policy | `engines/cancellation.py` | Free cancellation within 15 minutes for both rider and driver. |
| Complaints | `routes/admin.py` | Complaint handling, safety escalation, driver and vehicle restrictions, suspension and appeals. |
| Masked calling | `services/telephony.py` | Ride-specific virtual-number integration architecture. |
| Vehicle management | Admin portal | Global and city-level vehicle-type activation and discontinuation. |
| City management | Admin portal | Super Admin controls city activation and availability. |

### Commission Examples

| Ride Fare | Commission Rate | Company Commission |
|---:|---:|---:|
| ₹200 | 10% | ₹20 |
| ₹500 | 15% | ₹75 |
| ₹1,000 | 20% | ₹200 |

Commission is calculated on the whole fare according to the applicable slab.

## ✨ Platform Features

### Rider Portal
- Bike, auto, car and interstate tourist vehicle booking.
- Fare estimates and ride tracking.
- Scheduled rides.
- Coupons and referrals.
- Favourite drivers.
- In-app chat and receipts.
- SOS and emergency contact support.
- Multilingual experience.
- Vaya AI assistant and voice booking.

### Driver Portal
- Driver onboarding and vehicle registration.
- Online/offline availability.
- Location updates and ride offers.
- OTP-based ride start.
- Earnings, ledger and payout information.
- Driver feedback and ranking.
- Ride history and statements.
- Safety and complaint handling.

### Super Admin Portal
- City activation and configuration.
- Vehicle category management.
- Fare and commission configuration.
- Driver and vehicle approval.
- Complaint management and safety actions.
- Finance, settlement and payout monitoring.
- Role-based access control.
- Audit logs and reporting.

## 🎬 Signature Vehicle Transition

VAYORA uses an original vehicle-based page transition system implemented in `frontend/src/lib/router.jsx`.

Every navigation can trigger a vehicle animation based on the selected ride category or portal:

- Bike
- Auto
- Car
- Tourist vehicle

The vehicle travels along a road at the bottom of the screen, revealing the next page behind it.

The transition uses the native Web Animations API and CSS `clip-path`, avoiding an additional animation dependency. The incoming page is not remounted after the transition. Users with `prefers-reduced-motion` enabled receive a short fade instead.

## 🎨 Design System

Defined in `frontend/src/styles/tokens.css`.

| Colour | Hex |
|---|---|
| Sage | `#A5A79B` |
| Cream | `#E8D2B5` |
| Burgundy | `#650907` |

The burgundy accent can be changed globally using `--accent` and `--accent-hover`.

## 🔌 Integrations

The application includes integration adapters and development fallbacks.

| Integration | Purpose | Production requirement |
|---|---|---|
| Razorpay | Payments and refunds | Live API credentials and webhook configuration |
| RazorpayX | Driver payouts | Live payout credentials and verification |
| Exotel | Masked calling | Provider credentials and virtual-number setup |
| Google Gemini | AI assistants | Gemini API key |
| Google Sign-In | Authentication | Client ID configuration |
| Google Maps | Distance and Places | Google Maps API key |
| Firebase FCM | Push notifications | Firebase service credentials |

When credentials are absent, certain integrations use development fallbacks. These fallbacks must not be treated as production integrations.

The application also supports a vector-based city map using real coordinates. Google Maps or Mapbox tiles can be introduced by replacing `components/CityMap.jsx` while retaining its component interface.

## 🧪 Testing

Run backend tests:

```bash
cd backend
pytest -q
```

The backend includes pytest coverage for its business-rule engines.

## 🔐 Production Readiness

Before operating VAYORA as a real commercial ride-hailing service, complete the following:

- Verify production database migrations and schema.
- Configure and test live payment and payout credentials.
- Complete RazorpayX fund-account validation.
- Configure production telephony for masked calling.
- Configure SMS and emergency-contact alerts.
- Move KYC documents to secure object storage with signed URLs.
- Use KMS-backed encryption for sensitive banking information.
- Implement Redis-backed rate limiting.
- Add Redis leases for virtual-number allocation.
- Perform security, access-control and API testing.
- Test complete rider-to-driver ride workflows.
- Verify payout reconciliation and webhook handling.
- Configure production monitoring, backups and recovery.

Some integration paths currently use development fallbacks or stubs. A successful deployment does not by itself mean all real-world ride, payment, safety and payout workflows are production-ready.

---

**VAYORA — Moving India, one ride at a time.**
