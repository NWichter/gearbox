"""Plain-language explanation of a finding for the person on the floor.

Uses any OpenAI-compatible chat endpoint (OpenRouter by default, OpenCode Zen works
the same way). Provider and model are configuration, so models can be compared
without code changes (see tools/eval_llm.py).

When no key is set, or the LLM call fails or times out, explain() returns a fixed text built
from the finding's own fields (source "fallback"). The caller always gets a usable text.
"""

from __future__ import annotations

import json
import logging
import time

import httpx

from app.config import settings

log = logging.getLogger("airframe.llm")

SYSTEM = """You are a senior wireless engineer in a car factory. A monitoring system reads
header-only 802.11 and 802.1X captures from several sensors. The system found the problem that
the finding below describes.

Write an explanation for a shift lead. The shift lead is not a Wi-Fi expert. Write in English.
Use 150 words or fewer. Give these four parts in this order:
1. What happens. Use one sentence and plain words.
2. Why it is important for production: a line stop, work steps without a record, or safety.
3. The most probable root cause. Refer to the evidence: reason codes, status codes, breaks in a
   sequence, sensors.
4. The next action, and the person who does it.

Use short paragraphs. Do not use headings. Do not guess past the evidence."""

FALLBACK_NOTE = (
    "This text comes from the built-in playbook. The AI summary is not available now."
)


def build_messages(finding: dict, context: dict) -> list[dict]:
    payload = {k: v for k, v in finding.items() if k != "evidence"}
    payload["evidence"] = [
        {k: e[k] for k in ("t", "what", "kind")}
        | {"sensors": [f["sensor"] for f in e.get("frames") or []]}
        for e in finding.get("evidence", [])[:10]
    ]
    return [
        {"role": "system", "content": SYSTEM},
        {
            "role": "user",
            "content": json.dumps(
                {"finding": payload, "site_context": context}, default=str
            ),
        },
    ]


def timeout(read_s: float | None = None) -> httpx.Timeout:
    """5 s to connect, LLM_TIMEOUT_S (default 45 s) to read the answer."""
    return httpx.Timeout(read_s or settings.llm_timeout_s, connect=5.0)


def complete(
    messages: list[dict],
    model: str,
    api_key: str,
    base_url: str,
    max_tokens: int = 1500,
    timeout_s: float | None = None,
) -> dict:
    """One chat completion. Returns text, usage and latency."""
    t0 = time.perf_counter()
    r = httpx.post(
        f"{base_url.rstrip('/')}/chat/completions",
        headers={"Authorization": f"Bearer {api_key}", "X-Title": "Airframe"},
        json={"model": model, "messages": messages, "max_tokens": max_tokens},
        timeout=timeout(timeout_s),
    )
    r.raise_for_status()
    data = r.json()
    choice = data["choices"][0]
    return {
        "text": (choice["message"].get("content") or "").strip(),
        "finish_reason": choice.get("finish_reason"),
        "usage": data.get("usage", {}),
        "latency_s": round(time.perf_counter() - t0, 2),
        "model": data.get("model", model),
    }


def explain(finding: dict, context: dict) -> tuple[str, str]:
    """Returns (text, source). source is "llm" or "fallback"."""
    if not settings.llm_key:
        return fallback(finding), "fallback"
    try:
        res = complete(
            build_messages(finding, context),
            settings.llm_model,
            settings.llm_key,
            settings.llm_base_url,
        )
    except (httpx.HTTPError, KeyError, IndexError, TypeError, ValueError) as e:
        # network error, timeout, HTTP error status, or an answer in an unexpected format
        log.warning("LLM explanation failed: %s: %s", e.__class__.__name__, e)
        return fallback(finding), "fallback"
    if not res["text"]:
        return fallback(finding), "fallback"
    return res["text"], "llm"


def _sentence(s: str) -> str:
    s = (s or "").strip()
    return s if not s or s[-1] in ".!?" else s + "."


def fallback(f: dict) -> str:
    """A fixed plain-language text from the finding's own fields: what, who, what to do, details."""
    a = f.get("action") or {}
    parts = [f"What happens: {_sentence(f.get('title', 'A problem on the Wi-Fi'))}"]
    if a.get("label"):
        parts.append(f"Who acts: {_sentence(a['label'])}")
    if a.get("supervisor"):
        parts.append(f"What you do: {_sentence(a['supervisor'])}")
    if a.get("it"):
        parts.append(f"What IT does: {_sentence(a['it'])}")
    elif f.get("recommendation"):
        parts.append(f"Next step: {_sentence(f['recommendation'])}")
    if f.get("detail"):
        parts.append(f"Details: {_sentence(f['detail'])}")
    parts.append(FALLBACK_NOTE)
    return "\n\n".join(parts)
