"""Replay benchmark: the streaming detectors on N copies of Tesla's 8 sensors, split over W workers.

This is a REPLAY benchmark, not new data. Every copy is the same 30-minute Tesla capture. Copy c
gets its own sensor ids and its own MAC space (every MAC code + c x number of MACs), so each copy
is an independent "site" with 8 sensors and the keys of two copies never collide. All copies play
at the same capture time: N copies = 8 x N sensors that transmit at the same moment.

Stages and what each number measures:
  ingest   tshark reads the pcaps once. Not part of this benchmark (see app.airframe.stream CLI).
  consume  each worker cuts its partition out of the window: it makes the N copies of the window
           and keeps the rows whose station key hashes to it. This stands in for a consumer that
           reads its partition from a message bus (for example a Kafka topic keyed by station).
  detect   Partition.step: dedup, per-key state, detector rules. This is the stream job.
  reduce   one process merges the state changes of all workers into incidents per site.

Workers are separate OS processes (fork). Each worker processes all windows of its partition as
fast as it can. Window latency = time of the slowest worker for that window (consume + detect)
plus the reduce time of that window.

Usage (inside the backend image, from the repo root):
  python tools/bench_scale.py <captures-folder> [--copies 1 5 25 125] [--workers 1 2 4 8]
                              [--cache DIR] [--out FILE.json] [--md FILE.md]
"""

from __future__ import annotations

import argparse
import json
import multiprocessing as mp
import os
import platform
import sys
import tempfile
import time
from collections import Counter
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from app.airframe.stream import (  # noqa: E402
    Partition,
    Reducer,
    Table,
    load_raw,
    prepare,
    rss_mb,
    window_bounds,
)

MAC_COLS = ("key", "ta", "ra", "bssid")
GOLDEN = np.uint64(0x9E3779B97F4A7C15)

_T: Table | None = None  # set in the parent before fork, shared copy-on-write


def part_of(keys: np.ndarray, workers: int) -> np.ndarray:
    """Stable hash partition of integer station keys (Fibonacci hashing)."""
    h = (keys.astype(np.uint64) * GOLDEN) >> np.uint64(32)
    return (h % np.uint64(workers)).astype(np.int64)


def make_window(
    t: Table, lo: int, hi: int, copies: int, workers: int, w: int
) -> dict[str, np.ndarray]:
    """Rows of window [lo, hi) for all copies whose station key belongs to worker w."""
    c = t.cols
    n_mac, n_sens = len(t.macs), len(t.sensors)
    base_key = c["key"][lo:hi].astype(np.int64)
    valid = (base_key >= 0) & (base_key != t.bc)
    shift = (np.arange(copies, dtype=np.int64) * n_mac)[:, None]
    keys = np.where(valid[None, :], base_key[None, :] + shift, base_key[None, :])
    keys = np.where(keys < 0, 0, keys)
    cc, jj = np.nonzero(part_of(keys, workers) == w)
    rows = lo + jj
    out = {k: v[rows] for k, v in c.items() if k not in MAC_COLS and k != "sensor"}
    out["sensor"] = c["sensor"][rows] + (cc * n_sens).astype(np.int32)
    off = cc.astype(np.int64) * n_mac
    for k in MAC_COLS:
        v = c[k][rows].astype(np.int64)
        out[k] = np.where((v >= 0) & (v != t.bc), v + off, v)
    return out


def worker(args: tuple) -> dict:
    copies, workers, w, barrier = args
    t = _T
    bounds = window_bounds(t.cols["t"], t.window)
    t_max = t.duration
    part = Partition(t.bc)
    signals, lat_consume, lat_detect = [], [], []
    frames = 0
    barrier.wait()
    start = time.monotonic()
    for lo, hi, end in bounds:
        now = min(end, t_max)
        a = time.perf_counter()
        win = make_window(t, lo, hi, copies, workers, w)
        b = time.perf_counter()
        signals.append(part.step(win, now))
        z = time.perf_counter()
        frames += len(win["t"])
        lat_consume.append(b - a)
        lat_detect.append(z - b)
    signals.append(part.finish(t_max))
    stop = time.monotonic()
    return {
        "w": w,
        "frames": frames,
        "start": start,
        "stop": stop,
        "consume": lat_consume,
        "detect": lat_detect,
        "signals": signals,
        "rss_mb": rss_mb(),
        "keys": len(part.radius)
        + len(part.trace)
        + len(part.series)
        + len(part.assoc_ok),
    }


def run_case(t: Table, copies: int, workers: int) -> dict:
    ctx = mp.get_context("fork")
    barrier = ctx.Manager().Barrier(workers)
    with ctx.Pool(workers) as pool:
        res = pool.map(worker, [(copies, workers, w, barrier) for w in range(workers)])
    wall = max(r["stop"] for r in res) - min(r["start"] for r in res)
    frames = sum(r["frames"] for r in res)

    # reduce: window by window, as the reducer would get the state changes
    red = Reducer(len(t.macs), len(t.sensors), t.oui)
    bounds = window_bounds(t.cols["t"], t.window)
    t_max = t.duration
    reduce_s = []
    for k in range(len(bounds) + 1):
        now = t_max if k == len(bounds) else min(bounds[k][2], t_max)
        sig = [s for r in res for s in r["signals"][k]]
        a = time.perf_counter()
        red.feed(now, sig)
        reduce_s.append(time.perf_counter() - a)
    alerts = [a for a in red.finish() if a.active]
    per_type = Counter(a.type for a in alerts)

    per_window = (
        np.array(
            [
                max(r["consume"][k] + r["detect"][k] for r in res) + reduce_s[k]
                for k in range(len(bounds))
            ]
        )
        * 1000
    )
    detect_s = [sum(r["detect"]) for r in res]
    busy_s = [sum(r["detect"]) + sum(r["consume"]) for r in res]
    return {
        "copies": copies,
        "sensors": copies * len(t.sensors),
        "workers": workers,
        "frames": frames,
        "wall_s": round(wall, 2),
        # the slowest worker's detect time: the wall time when a bus hands each worker only its partition
        "detect_wall_s": round(max(detect_s), 2),
        "frames_per_s": round(frames / wall),
        "detect_frames_per_s_per_worker": round(
            float(np.mean([r["frames"] / max(d, 1e-9) for r, d in zip(res, detect_s)]))
        ),
        "busy_share_detect": round(sum(detect_s) / max(sum(busy_s), 1e-9), 2),
        "partition_balance": round(
            max(r["frames"] for r in res) / max(1, frames / workers), 3
        ),
        "window_ms": {
            "p50": round(float(np.percentile(per_window, 50)), 1),
            "p95": round(float(np.percentile(per_window, 95)), 1),
            "max": round(float(per_window.max()), 1),
        },
        "reduce_ms_total": round(sum(reduce_s) * 1000, 1),
        "realtime_factor": round(t_max / wall, 1),
        "worker_peak_rss_mb": max((r["rss_mb"] or 0) for r in res),
        "incidents": dict(per_type),
        "incidents_total": len(alerts),
    }


def markdown(rows: list[dict], meta: dict) -> str:
    out = [
        f"Replay benchmark on {meta['machine']}, {meta['cpus']} CPUs visible, Python {meta['python']}.",
        (
            f"Base: {meta['base_frames']:,} frames, {meta['base_sensors']} sensors, {meta['capture_s']:.0f} s of capture. "
            "Stage measured: consume + detect (+ reduce). Ingest (tshark) is not included."
        ),
        "",
        (
            "| Sensors (copies) | Workers | Frames | Wall s | Frames/s | Detect frames/s per worker | Speed-up | "
            "Speed-up detect only | × real time | Window p50 / p95 / max ms | Incidents | Same per copy |"
        ),
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    base, base_d = {}, {}
    for r in rows:
        base.setdefault(r["copies"], r["wall_s"])
        base_d.setdefault(r["copies"], r["detect_wall_s"])
        speed = base[r["copies"]] / r["wall_s"]
        speed_d = base_d[r["copies"]] / r["detect_wall_s"]
        w = r["window_ms"]
        out.append(
            f"| {r['sensors']} ({r['copies']}) | {r['workers']} | {r['frames']:,} | {r['wall_s']} | "
            f"{r['frames_per_s']:,} | {r['detect_frames_per_s_per_worker']:,} | {speed:.2f}× | {speed_d:.2f}× | "
            f"{r['realtime_factor']} | {w['p50']} / {w['p95']} / {w['max']} | {r['incidents_total']} | "
            f"{'yes' if r['same_per_copy'] else 'NO'} |"
        )
    return "\n".join(out)


def main() -> None:
    global _T
    ap = argparse.ArgumentParser(
        description="Replay benchmark of the streaming detectors"
    )
    ap.add_argument("folder", type=Path)
    ap.add_argument("--copies", type=int, nargs="+", default=[1, 5, 25, 125])
    ap.add_argument("--workers", type=int, nargs="+", default=[1, 2, 4, 8])
    ap.add_argument(
        "--cache", type=Path, default=Path(tempfile.gettempdir()) / "airframe-cache"
    )
    ap.add_argument("--out", type=Path)
    ap.add_argument("--md", type=Path)
    a = ap.parse_args()

    raw, files, t_ingest, cached = load_raw(a.folder, a.cache)
    _T = prepare(raw)
    del raw
    t = _T
    meta = {
        "machine": f"{platform.machine()} {platform.processor() or platform.system()}",
        "cpus": os.cpu_count(),
        "python": platform.python_version(),
        "base_frames": t.n,
        "base_sensors": len(t.sensors),
        "capture_s": t.duration,
        "files": files,
        "ingest_s": round(t_ingest, 1),
        "ingest_cached": cached,
    }
    print(json.dumps(meta))
    rows = []
    ref: dict | None = None
    for copies in a.copies:
        for workers in a.workers:
            r = run_case(t, copies, workers)
            if copies == 1 and ref is None:
                ref = r["incidents"]
            r["same_per_copy"] = (
                ref is not None
                and all(r["incidents"].get(k, 0) == v * copies for k, v in ref.items())
                and sum(r["incidents"].values()) == sum(ref.values()) * copies
            )
            rows.append(r)
            print(
                f"N={copies:>3} ({r['sensors']:>4} sensors) W={workers}: {r['frames']:>11,} frames in {r['wall_s']:>7.2f} s "
                f"= {r['frames_per_s']:>10,} frames/s, {r['realtime_factor']:>6}x real time, window p95 {r['window_ms']['p95']} ms, "
                f"incidents {r['incidents_total']} (same per copy: {r['same_per_copy']}), balance {r['partition_balance']}, "
                f"worker RSS {r['worker_peak_rss_mb']} MB",
                flush=True,
            )
    md = markdown(rows, meta)
    print()
    print(md)
    if a.out:
        a.out.write_text(
            json.dumps({"meta": meta, "rows": rows}, indent=2), encoding="utf-8"
        )
    if a.md:
        a.md.write_text(md + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
