"""Gemini-backed assistants for customers, drivers and admins.

The key stays on the server. Each request is grounded with facts the server looks up for that
user (their active ride, fares for their city, policy text, or admin KPIs), so the model
explains real numbers instead of inventing them. For bookings the model returns a structured
intent that the app shows as a confirm card. The assistant never books or cancels by itself.
"""
from __future__ import annotations

import json
import logging
import re

import requests

from app.core.config import get_settings

log = logging.getLogger("vayora.ai")

PERSONAS = {
    "customer": (
        "You are Vaya, VAYORA's ride assistant in India. Be warm, brief (max 4 sentences) and exact with rupee amounts. "
        "Only use facts in CONTEXT. Policy: cancellations are free for both rider and driver within 15 minutes of booking. "
        "If the user wants a ride, reply with a JSON block ```intent {\"action\":\"book\",\"pickup\":\"...\",\"drop\":\"...\",\"category\":\"bike|auto|car|tourist\",\"when\":\"now|ISO time\"}``` "
        "after your sentence. For complaints, collect what happened and output ```intent {\"action\":\"complaint\",\"category\":\"...\",\"summary\":\"...\"}```. "
        "Reply in the user's language (English, Tamil, Hindi, Malayalam, Kannada, Telugu supported)."
    ),
    "driver": (
        "You are VAYORA's driver co-pilot. Explain earnings, commission slabs (10% up to ₹300, 15% above ₹300 and below ₹700, "
        "20% from ₹700), next-day settlements, cash commission dues and ranking factors using CONTEXT numbers only. "
        "Keep it short and practical. Never give turn-by-turn directions unless CONTEXT contains route data."
    ),
    "admin": (
        "You are VAYORA's operations analyst. Summarise the KPIs in CONTEXT, point out anomalies (cancellation spikes, "
        "payout failures, safety complaints) and suggest concrete actions. Use bullet points and ₹ amounts."
    ),
}

INTENT_RE = re.compile(r"```intent\s*(\{.*?\})\s*```", re.S)


def _fallback(role: str, message: str, context: dict) -> str:
    m = message.lower()
    if role == "customer":
        if any(w in m for w in ("cancel", "refund")):
            return "You can cancel free of charge within 15 minutes of booking. After that a small fee may apply, shown before you confirm."
        if "fare" in m or "price" in m or "cost" in m:
            return "Fares are base fare + per-km + per-minute, with peak pricing in busy hours. You see an estimate range before booking; the final fare uses the actual distance and time."
        if "status" in m or "where" in m:
            ride = context.get("active_ride")
            return f"Your ride {ride['code']} is {ride['status'].replace('_', ' ')}." if ride else "You have no active ride right now."
        if any(w in m for w in ("book", "ride", "go to", "take me")):
            return "Sure, where should I pick you up and where are you going? ```intent {\"action\":\"book\",\"pickup\":\"current location\",\"drop\":\"\",\"category\":\"auto\",\"when\":\"now\"}```"
        return "I can book rides, explain fares, track your trip, or help with a complaint. What do you need?"
    if role == "driver":
        e = context.get("earnings", {})
        return f"Today you earned ₹{e.get('today', '0')}. Online earnings settle to your bank the next day after commission; cash-ride commission is netted from that payout."
    return "AI insights need GEMINI_API_KEY. KPIs: " + json.dumps(context.get("kpis", {}))[:600]


def chat(role: str, message: str, history: list[dict], context: dict, language: str = "en") -> dict:
    s = get_settings()
    if not s.GEMINI_API_KEY:
        text = _fallback(role, message, context)
    else:
        contents = [{"role": "user" if h["role"] == "user" else "model", "parts": [{"text": h["text"][:2000]}]}
                    for h in history[-10:]]
        contents.append({"role": "user", "parts": [{"text": f"CONTEXT:\n{json.dumps(context, default=str)[:6000]}\n\nUSER ({language}): {message[:1500]}"}]})
        try:
            r = requests.post(
                f"https://generativelanguage.googleapis.com/v1beta/models/{s.GEMINI_MODEL}:generateContent",
                headers={"x-goog-api-key": s.GEMINI_API_KEY}, timeout=25,
                json={"systemInstruction": {"parts": [{"text": PERSONAS[role]}]}, "contents": contents,
                      "generationConfig": {"temperature": 0.4, "maxOutputTokens": 600},
                      "safetySettings": [{"category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_MEDIUM_AND_ABOVE"}]})
            r.raise_for_status()
            text = r.json()["candidates"][0]["content"]["parts"][0]["text"]
        except Exception as exc:  # noqa: BLE001
            log.warning("Gemini call failed: %s", exc)
            text = _fallback(role, message, context)

    intent = None
    if (m := INTENT_RE.search(text)):
        try:
            intent = json.loads(m.group(1))
        except json.JSONDecodeError:
            intent = None
        text = INTENT_RE.sub("", text).strip()
    return {"reply": text, "intent": intent}
