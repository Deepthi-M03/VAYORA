"""WebSocket hub. Channels: user:<id>, ride:<id>, drivers:<city_id>:<category>, admin:live.

Single-process in-memory fan-out, with Redis pub/sub bridging so several API workers can share
channels in production (``REDIS_URL``). If Redis is unavailable, it degrades to local-only.
"""
from __future__ import annotations

import asyncio
import json
import logging
from collections import defaultdict

from fastapi import WebSocket

log = logging.getLogger("vayora.realtime")


class Hub:
    def __init__(self):
        self.channels: dict[str, set[WebSocket]] = defaultdict(set)
        self.redis = None

    async def start(self, redis_url: str):
        self.loop = asyncio.get_running_loop()
        try:
            import redis.asyncio as aioredis
            self.redis = aioredis.from_url(redis_url)
            await self.redis.ping()
            asyncio.create_task(self._listen())
        except Exception as exc:  # noqa: BLE001
            log.warning("Realtime running without Redis (%s)", exc)
            self.redis = None

    async def _listen(self):
        ps = self.redis.pubsub()
        await ps.psubscribe("vy:*")
        async for msg in ps.listen():
            if msg.get("type") == "pmessage":
                await self._local(msg["channel"].decode()[3:], msg["data"].decode())

    async def join(self, channel: str, ws: WebSocket):
        self.channels[channel].add(ws)

    def leave(self, ws: WebSocket):
        for subs in self.channels.values():
            subs.discard(ws)

    async def _local(self, channel: str, text: str):
        dead = []
        for ws in list(self.channels.get(channel, ())):
            try:
                await ws.send_text(text)
            except Exception:  # noqa: BLE001
                dead.append(ws)
        for ws in dead:
            self.leave(ws)

    async def publish(self, channel: str, event: str, data: dict):
        text = json.dumps({"event": event, "channel": channel, "data": data}, default=str)
        if self.redis:
            await self.redis.publish(f"vy:{channel}", text)
        else:
            await self._local(channel, text)


hub = Hub()


def publish_sync(channel: str, event: str, data: dict):
    """Fire-and-forget from sync route handlers (which FastAPI runs in a worker thread)."""
    loop = getattr(hub, "loop", None)
    if loop is not None and not loop.is_closed():
        asyncio.run_coroutine_threadsafe(hub.publish(channel, event, data), loop)
        return
    # Outside the API process (Celery worker): publish straight to Redis so API workers fan it out.
    try:
        import redis
        from app.core.config import get_settings
        redis.from_url(get_settings().REDIS_URL).publish(
            f"vy:{channel}", json.dumps({"event": event, "channel": channel, "data": data}, default=str))
    except Exception as exc:  # noqa: BLE001
        log.debug("realtime publish skipped: %s", exc)
