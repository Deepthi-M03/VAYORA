from celery import Celery
from celery.schedules import crontab

from app.core.config import get_settings

celery = Celery("vayora", broker=get_settings().REDIS_URL, backend=get_settings().REDIS_URL, include=["app.workers.tasks"])
celery.conf.update(timezone="Asia/Kolkata", enable_utc=True, task_acks_late=True, worker_prefetch_multiplier=1)
celery.conf.beat_schedule = {
    "daily-settlement": {"task": "app.workers.tasks.run_daily_settlement", "schedule": crontab(hour=0, minute=30)},
    "nightly-ranking": {"task": "app.workers.tasks.recompute_all_ranks", "schedule": crontab(hour=3, minute=0)},
    "scheduled-rides": {"task": "app.workers.tasks.dispatch_scheduled_rides", "schedule": 60.0},
    "expire-searching": {"task": "app.workers.tasks.expire_searching_rides", "schedule": 30.0},
    "close-call-bridges": {"task": "app.workers.tasks.close_expired_call_sessions", "schedule": 300.0},
    "document-expiry": {"task": "app.workers.tasks.check_document_expiry", "schedule": crontab(hour=6, minute=0)},
}
