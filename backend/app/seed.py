"""Seed reference data + demo accounts.  python -m app.seed

Demo logins (change in production):
  Super admin  admin@vayora.in      / Vayora@Admin2026
  Customer     rider@vayora.in      / Vayora@Rider1
  Driver       driver1@vayora.in    / Vayora@Driver1   (approved, Chennai, auto)
"""
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

from sqlalchemy import select

from app.core.database import SessionLocal
from app.core.security import hash_password
from app.engines.fare import DEFAULT_RULES
from app.models import (City, CityVehicle, Coupon, DriverDocument, DriverProfile, FareRuleRow, User, Vehicle, VehicleCategory)
from app.services import config_store

CITIES = [  # name, state, tier, lat, lng, active-at-seed
    ("Chennai", "Tamil Nadu", "metro", 13.0827, 80.2707, True),
    ("Coimbatore", "Tamil Nadu", "tier_2", 11.0168, 76.9558, True),
    ("Bengaluru", "Karnataka", "metro", 12.9716, 77.5946, True),
    ("Hyderabad", "Telangana", "metro", 17.3850, 78.4867, True),
    ("Kochi", "Kerala", "tier_2", 9.9312, 76.2673, True),
    ("Thiruvananthapuram", "Kerala", "tier_2", 8.5241, 76.9366, False),
    ("Mumbai", "Maharashtra", "metro", 19.0760, 72.8777, True),
    ("Pune", "Maharashtra", "tier_2", 18.5204, 73.8567, True),
    ("Delhi", "Delhi", "metro", 28.6139, 77.2090, True),
    ("Kolkata", "West Bengal", "metro", 22.5726, 88.3639, False),
    ("Ahmedabad", "Gujarat", "metro", 23.0225, 72.5714, False),
    ("Jaipur", "Rajasthan", "tier_2", 26.9124, 75.7873, False),
]
CATEGORIES = [
    ("bike", "Bike", 1, "Beat traffic on two wheels", False, 1),
    ("auto", "Auto", 3, "Everyday auto-rickshaw rides", False, 2),
    ("car", "Car", 4, "Comfortable AC sedans and hatchbacks", False, 3),
    ("tourist", "Tourist", 7, "SUVs and tempo travellers for outstation and interstate trips", True, 4),
]
PEAK = [{"start": "08:00", "end": "11:00", "multiplier": "1.25", "weekdays": [0, 1, 2, 3, 4]},
        {"start": "17:30", "end": "21:00", "multiplier": "1.3", "weekdays": [0, 1, 2, 3, 4]}]


def box(lat, lng, d=0.35):
    return [[lat - d, lng - d], [lat - d, lng + d], [lat + d, lng + d], [lat + d, lng - d]]


def run():
    db = SessionLocal()
    if db.scalar(select(VehicleCategory)):
        print("Already seeded")
        return
    cats = {}
    for code, name, seats, desc, inter, order in CATEGORIES:
        cats[code] = VehicleCategory(code=code, name=name, seats=seats, description=desc, is_interstate=inter, sort_order=order)
        db.add(cats[code])
    admin = User(role="admin", admin_role="super_admin", full_name="Platform Owner", email="admin@vayora.in",
                 phone="+919000000001", password_hash=hash_password("Vayora@Admin2026"))
    db.add(admin)
    db.flush()
    cities = {}
    for name, state, tier, lat, lng, live in CITIES:
        c = City(name=name, state=state, tier=tier, center_lat=lat, center_lng=lng, boundary=box(lat, lng),
                 status="active" if live else "draft", activated_by=admin.id if live else None)
        db.add(c)
        db.flush()
        cities[name] = c
        for code, cat in cats.items():
            db.add(CityVehicle(city_id=c.id, category_id=cat.id, active=live and not (code == "bike" and name == "Delhi")))
            r = DEFAULT_RULES[tier][code]
            db.add(FareRuleRow(city_id=c.id, category_id=cat.id, version=1, is_current=True, created_by=admin.id,
                               peak_windows=PEAK if code != "tourist" else [], **{k: Decimal(v) for k, v in r.items()}))
    for key, val in config_store.DEFAULTS.items():
        config_store.put(db, key, val, admin.id)

    rider = User(role="customer", full_name="Ananya Raman", email="rider@vayora.in", phone="+919000000002",
                 password_hash=hash_password("Vayora@Rider1"), referral_code="ANANYA", home_city_id=cities["Chennai"].id)
    db.add(rider)
    chennai = cities["Chennai"]
    for i, (nm, code, reg, make, model, colour, dl, dn) in enumerate([
        ("Murugan Selvam", "auto", "TN09AB1234", "Bajaj", "RE Compact", "Yellow-Green", 0.004, 0.006),
        ("Karthik Iyer", "car", "TN10CD5678", "Maruti", "Dzire", "Pearl White", -0.006, 0.003),
        ("Farhan Ali", "bike", "TN07EF9012", "Honda", "Shine", "Black", 0.002, -0.005),
        ("Rajesh Kumar", "tourist", "TN01GH3456", "Toyota", "Innova Crysta", "Silver", -0.01, -0.008)], start=1):
        u = User(role="driver", full_name=nm, email=f"driver{i}@vayora.in", phone=f"+91900000010{i}",
                 password_hash=hash_password(f"Vayora@Driver{i}"))
        db.add(u)
        db.flush()
        d = DriverProfile(user_id=u.id, city_id=chennai.id, onboarding_status="approved", licence_number=f"TN0920200000{i:03d}",
                          licence_expiry=date(2031, 1, 1), bank_account_last4=f"10{i:02d}", bank_ifsc="HDFC0001234",
                          bank_holder_name=nm, bank_verified=True, razorpay_fund_account_id=f"fa_dev_{i}",
                          last_lat=chennai.center_lat + dl, last_lng=chennai.center_lng + dn, rank_score=Decimal(80 + i * 3), rank_tier="Gold")
        db.add(d)
        db.flush()
        v = Vehicle(driver_id=d.id, category_id=cats[code].id, registration_number=reg, make=make, model=model, colour=colour,
                    year=2023, seats=cats[code].seats, insurance_expiry=date(2027, 12, 31), status="approved",
                    permit_type="AITP" if code == "tourist" else None)
        db.add(v)
        db.flush()
        d.active_vehicle_id = v.id
        for t in ("photo", "licence", "aadhaar", "rc", "insurance", "vehicle_photo", "bank_proof"):
            db.add(DriverDocument(driver_id=d.id, doc_type=t, file_key=f"seed/{t}.pdf", status="verified", reviewer_id=admin.id))
    now = datetime.now(timezone.utc)
    db.add_all([
        Coupon(code="WELCOME50", description="₹50 off your first ride", kind="flat", value=Decimal(50), max_discount=Decimal(50),
               min_fare=Decimal(100), per_user_limit=1, valid_from=now, valid_to=now + timedelta(days=365)),
        Coupon(code="AUTO20", description="20% off autos, up to ₹40", kind="percent", value=Decimal(20), max_discount=Decimal(40),
               category_code="auto", per_user_limit=5, valid_from=now, valid_to=now + timedelta(days=90)),
    ])
    db.commit()
    print("Seeded: 12 cities (8 live), 4 vehicle types, fares, admin, rider, 4 drivers, 2 coupons")


if __name__ == "__main__":
    run()
