"""Website assistant: answers questions about Airframe, the docs and the current analysis."""

from __future__ import annotations

import logging
from pathlib import Path

import httpx

from app.airframe.explain import complete
from app.config import settings

log = logging.getLogger("airframe.llm")

DOCS_DIRS = [Path(__file__).resolve().parents[3] / "docs", Path("/app/docs")]

SYSTEM = """You are the assistant on the Gearbox website. Gearbox is a hackathon prototype for
the Tesla challenge "Airframe". It reads header-only 802.11 captures from several sensors, finds
problems (findings and incidents) and shows them on a dashboard.

Answer questions about these subjects: the website, how to use it, what the findings mean, the
method and the architecture.
Rules:
1. Use only the context below.
2. If the context does not contain the answer, say this in one sentence. Then name the page
   where the user can look: Dashboard, Scale design or Docs.
3. Always answer in English. Do this also when the question is in a different language.
4. Use 120 words or fewer. Give facts. Do not use marketing words.
5. When you refer to a page, give its name."""

NOT_CONFIGURED = (
    "The assistant is not available: no LLM key is set. "
    "The Docs page explains the challenge, the method and how to read the dashboard."
)
UNAVAILABLE = (
    "The assistant is not available now ({reason}). Try again in a minute. "
    "The Docs page explains the challenge, the method and how to read the dashboard."
)


def _docs_text(limit: int = 60_000) -> str:
    for d in DOCS_DIRS:
        if d.exists():
            parts = []
            for f in sorted(d.glob("*.md")):
                if f.name.startswith("07-todo"):
                    continue
                parts.append(f"### {f.name}\n{f.read_text(encoding='utf-8')}")
            return "\n\n".join(parts)[:limit]
    return ""


def _dataset_text(result: dict | None) -> str:
    if not result:
        return "No analysis selected."
    s = result["summary"]
    lines = [
        f"Current dataset: {s['sensors']} sensors, {s['frames']} frames, {s['duration_s']} s, "
        f"{s['aps']} APs, {s['clients']} clients, {s['findings']} findings."
    ]
    for f in result["findings"][:25]:
        lines.append(
            f"- #{f['id']} [{f['severity']}] {f['title']} (t={f['t_start']:.0f}-{f['t_end']:.0f} s)"
        )
    return "\n".join(lines)


def answer(
    question: str, history: list[dict], page: str | None, result: dict | None
) -> tuple[str, bool]:
    if not settings.llm_key:
        return NOT_CONFIGURED, False
    context = f"# Website docs\n{_docs_text()}\n\n# Analysis on screen\n{_dataset_text(result)}\n\nUser is on page: {page or '/'}"
    messages = [{"role": "system", "content": SYSTEM + "\n\n" + context}]
    for h in history[-6:]:
        if h.get("role") in ("user", "assistant") and h.get("content"):
            messages.append({"role": h["role"], "content": str(h["content"])[:2000]})
    messages.append({"role": "user", "content": question[:2000]})
    try:
        res = complete(
            messages,
            settings.llm_model,
            settings.llm_key,
            settings.llm_base_url,
            max_tokens=700,
        )
    except httpx.TimeoutException:
        log.warning("chat LLM call timed out")
        return UNAVAILABLE.format(reason="the AI service did not answer in time"), False
    except (httpx.HTTPError, KeyError, IndexError, TypeError, ValueError) as e:
        log.warning("chat LLM call failed: %s: %s", e.__class__.__name__, e)
        return UNAVAILABLE.format(reason=f"error {e.__class__.__name__}"), False
    return res["text"] or "I have no answer to this question.", bool(res["text"])
