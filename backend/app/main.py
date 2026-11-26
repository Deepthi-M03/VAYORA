"""VAYORA API. Run: uvicorn app.main:app --reload   ·   Docs: /docs (Swagger) and /redoc."""
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.routes import admin, ai, auth, customer, driver, payments, ws
from app.core.config import get_settings
from app.services.realtime import hub

settings = get_settings()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await hub.start(settings.REDIS_URL)
    yield


app = FastAPI(title="VAYORA Mobility API", version="1.0.0", lifespan=lifespan,
              description="Ride-hailing platform for India: customers, drivers and super admin.")
app.add_middleware(CORSMiddleware, allow_origins=settings.cors_list, allow_credentials=True,
                   allow_methods=["*"], allow_headers=["*"])


@app.middleware("http")
async def security_headers(request: Request, call_next):
    resp = await call_next(request)
    resp.headers.update({"X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
                         "Referrer-Policy": "strict-origin-when-cross-origin",
                         "Permissions-Policy": "geolocation=(self), microphone=(self)"})
    return resp


@app.exception_handler(ValueError)
async def value_error(_r: Request, exc: ValueError):
    return JSONResponse(status_code=422, content={"detail": str(exc)})


for r in (auth.router, customer.router, driver.router, admin.router, ai.router, payments.router):
    app.include_router(r, prefix="/api")
app.include_router(ws.router)


@app.get("/api/health")
def health():
    return {"ok": True, "service": settings.APP_NAME}
