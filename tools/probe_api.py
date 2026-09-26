"""Measure how fast the API answers /health while it analyses a dataset.

Uploads the capture files of a folder to a running API, then calls GET /health every 0.25 s until the
analysis is done or failed, and prints latency statistics. A /health call that takes longer than 30 s
counts as a timeout (a reverse proxy shows "Gateway Timeout" much earlier).

Usage:
  python tools/probe_api.py <captures-folder> [--base http://127.0.0.1:8000]
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import httpx


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("folder", type=Path)
    ap.add_argument("--base", default="http://127.0.0.1:8000")
    a = ap.parse_args()
    files = sorted(
        p
        for p in a.folder.iterdir()
        if p.name.endswith((".pcap", ".pcapng", ".pcap.gz"))
    )
    handles = [("files", (p.name, p.open("rb"))) for p in files]
    r = httpx.post(
        f"{a.base}/datasets", files=handles, data={"name": "probe"}, timeout=600
    )
    r.raise_for_status()
    ds_id = r.json()["id"]
    lat, timeouts, status = [], 0, "queued"
    t_start = time.monotonic()
    while status not in ("done", "failed"):
        t0 = time.perf_counter()
        try:
            httpx.get(f"{a.base}/health", timeout=30).raise_for_status()
            lat.append(time.perf_counter() - t0)
        except httpx.TimeoutException:
            timeouts += 1
        try:
            status = httpx.get(f"{a.base}/datasets/{ds_id}", timeout=60).json()[
                "status"
            ]
        except httpx.TimeoutException:
            pass
        time.sleep(0.25)
    lat.sort()
    ms = [x * 1000 for x in lat]
    out = {
        "status": status,
        "analysis_s": round(time.monotonic() - t_start, 1),
        "health_calls": len(lat),
        "timeouts_30s": timeouts,
        "median_ms": round(ms[len(ms) // 2], 1) if ms else None,
        "p99_ms": round(ms[int(0.99 * (len(ms) - 1))], 1) if ms else None,
        "max_ms": round(ms[-1], 1) if ms else None,
        "over_1s": sum(1 for x in lat if x > 1),
    }
    print(json.dumps(out))


if __name__ == "__main__":
    main()
