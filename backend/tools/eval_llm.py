"""Compare LLM models on the same findings (spends tokens - run on purpose only).

Usage:
  uv run python tools/eval_llm.py <dataset-id> [--n 5] [--base https://gearbox.skimu.de]
         [--models anthropic/claude-opus-5.5,anthropic/claude-sonnet-5,anthropic/claude-haiku-4.5]

Reads LLM_API_KEY / OPENROUTER_API_KEY (and optional LLM_BASE_URL) from the environment or
the project .env. Writes a Markdown comparison to eval-llm-<dataset>.md in the current folder.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.airframe.explain import build_messages, complete  # noqa: E402
from app.config import settings  # noqa: E402

DEFAULT_MODELS = (
    "anthropic/claude-opus-5.5,anthropic/claude-sonnet-5,anthropic/claude-haiku-4.5"
)
PRICES = {  # USD per token (OpenRouter, 25 Sep 2026)
    "anthropic/claude-opus-5.5": (4e-6, 20e-6),
    "anthropic/claude-sonnet-5": (2e-6, 10e-6),
    "anthropic/claude-haiku-4.5": (1e-6, 5e-6),
}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("dataset")
    ap.add_argument("--n", type=int, default=5)
    ap.add_argument("--base", default="https://gearbox.skimu.de")
    ap.add_argument("--models", default=DEFAULT_MODELS)
    a = ap.parse_args()
    if not settings.llm_key:
        sys.exit("no LLM key configured (LLM_API_KEY / OPENROUTER_API_KEY)")

    ds = httpx.get(f"{a.base}/api/datasets/{a.dataset}", timeout=60).json()["result"]
    findings = [f for f in ds["findings"] if f["severity"] != "info"][: a.n]
    ctx = {k: ds["summary"][k] for k in ("sensors", "aps", "clients", "duration_s")}
    models = a.models.split(",")

    out = [f"# LLM comparison - dataset {a.dataset}\n"]
    totals = {m: {"cost": 0.0, "latency": 0.0} for m in models}
    for f in findings:
        out.append(f"\n## Finding {f['id']}: {f['title']}\n")
        msgs = build_messages(f, ctx)
        for m in models:
            try:
                r = complete(msgs, m, settings.llm_key, settings.llm_base_url)
            except httpx.HTTPError as e:
                out.append(f"\n### {m}\n\nERROR: {e}\n")
                continue
            u = r["usage"]
            pin, pout = PRICES.get(m, (0, 0))
            cost = (
                u.get("prompt_tokens", 0) * pin + u.get("completion_tokens", 0) * pout
            )
            totals[m]["cost"] += cost
            totals[m]["latency"] += r["latency_s"]
            out.append(
                f"\n### {m}\n\n_{r['latency_s']} s · {u.get('prompt_tokens')} in / {u.get('completion_tokens')} out · ${cost:.4f}_\n\n{r['text']}\n"
            )
    out.append("\n## Totals\n\n| Model | Cost | Avg latency |\n| --- | --- | --- |\n")
    for m, t in totals.items():
        out.append(
            f"| {m} | ${t['cost']:.4f} | {t['latency'] / max(1, len(findings)):.1f} s |\n"
        )
    path = Path(f"eval-llm-{a.dataset}.md")
    path.write_text("".join(out), encoding="utf-8")
    print(f"written {path}")


if __name__ == "__main__":
    main()
