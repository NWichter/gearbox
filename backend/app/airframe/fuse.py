"""Stage 2 - multi-sensor fusion.

1. Clock alignment. Preferred: beacon TSF. When the APs' TSF follows a shared
   time base (controller-synchronised, e.g. Unix microseconds), each sensor's
   offset AND drift is a linear fit of (capture time - TSF) over time - this
   works even when every sensor sits on a different channel. Fallback: the same
   (BSSID, seq) beacon heard by two sensors gives their pairwise offset.
2. De-duplication: frames with the same transmitter, sequence number and type
   within a few milliseconds (after alignment) are one event on the air. The
   event keeps the list of sensors that heard it and the RSSI per sensor -
   that is the "where did it happen" signal. When every sensor listens on its
   own channel (Tesla's layout: one sensor per channel), no frame can be heard
   twice, so de-dup is skipped - it removed 4 of 1.12 M frames and cost half of
   the run time.

Keyed by transmitter MAC, so at scale it partitions cleanly (e.g. Kafka key = TA).
"""

from __future__ import annotations

from collections import deque

import numpy as np
import pandas as pd

DEDUP_WINDOW_S = 0.01


def clock_offsets(df: pd.DataFrame) -> dict[str, float]:
    b = df[(df["kind"] == "beacon") & df["seq"].notna() & df["ta"].notna()][
        ["sensor", "ta", "seq", "ts"]
    ]
    sensors = list(df["sensor"].unique())
    if len(sensors) < 2 or b.empty:
        return {s: 0.0 for s in sensors}
    counts = b["sensor"].value_counts()
    ref = counts.index[0]
    # pairwise offsets from shared beacons
    first = b.drop_duplicates(["sensor", "ta", "seq", "ts"])
    pair: dict[tuple[str, str], float] = {}
    for s1 in sensors:
        for s2 in sensors:
            if s1 >= s2:
                continue
            m = first[first.sensor == s1].merge(
                first[first.sensor == s2], on=["ta", "seq"], suffixes=("_1", "_2")
            )
            m = m[(m.ts_2 - m.ts_1).abs() < 60]  # seq wraps after 4096 frames
            if len(m) >= 5:
                d = float(np.median(m.ts_2 - m.ts_1))
                pair[(s1, s2)] = d
                pair[(s2, s1)] = -d
    # breadth-first walk from the reference sensor
    off = {ref: 0.0}
    q = deque([ref])
    while q:
        s = q.popleft()
        for (a, c), d in pair.items():
            if a == s and c not in off:
                off[c] = off[s] + d
                q.append(c)
    for s in sensors:
        off.setdefault(s, 0.0)
    return off


def tsf_alignment(df: pd.DataFrame) -> dict[str, tuple[float, float]] | None:
    """Per-sensor (offset_s, drift) from beacon TSF, or None if TSF is not a shared epoch clock."""
    b = df[(df["kind"] == "beacon") & df["tsf"].notna()][["sensor", "ts", "tsf"]]
    if b.empty:
        return None
    d = b["ts"] - b["tsf"] / 1e6
    if (d.abs() > 86400).mean() > 0.2:  # TSF is per-AP uptime, not a shared clock
        return None
    b = b.assign(d=d)
    t0 = float(b["ts"].min())
    out = {}
    for sensor, g in b.groupby("sensor"):
        # beacons are sent on time, late arrivals only add delay -> fit the lower envelope per 10 s bucket
        env = g.assign(bucket=((g["ts"] - t0) // 10)).groupby("bucket").agg(x=("ts", "median"), y=("d", "min"))
        if len(env) < 3:
            out[sensor] = (float(g["d"].median()), 0.0)
            continue
        slope, icpt = np.polyfit(env["x"] - t0, env["y"], 1)
        out[sensor] = (float(icpt), float(slope))
    out["_t0"] = (t0, 0.0)
    return out


def fuse(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame, dict[str, float]]:
    """Returns (fused events, aligned raw frames, clock offsets per sensor)."""
    df = df.copy()
    tsf = tsf_alignment(df)
    if tsf:
        t0 = tsf.pop("_t0")[0]
        icpt = df["sensor"].map({k: v[0] for k, v in tsf.items()}).fillna(0.0)
        slope = df["sensor"].map({k: v[1] for k, v in tsf.items()}).fillna(0.0)
        df["t"] = df["ts"] - (icpt + slope * (df["ts"] - t0))
        off = {k: v[0] for k, v in tsf.items()}
        df.attrs["drift_ppm"] = {k: round(v[1] * 1e6, 1) for k, v in tsf.items()}
        df.attrs["alignment"] = "beacon TSF (offset + drift)"
        # beacon lateness = arrival after the TSF-predicted time (controller / air delay)
        isb = (df["kind"] == "beacon") & df["tsf"].notna()
        df["late_ms"] = np.where(isb, (df["t"] - df["tsf"] / 1e6) * 1000, np.nan)
    else:
        off = clock_offsets(df)
        df["t"] = df["ts"] - df["sensor"].map(off)
        df.attrs["alignment"] = "shared beacons (offset only)"
        df["late_ms"] = np.nan
    t0 = df["t"].min()
    df["t"] = df["t"] - t0

    if disjoint_channels(df):
        ev = one_event_per_frame(df)
        ev.attrs["t0_epoch"] = float(t0)
        ev.attrs["dedup"] = "skipped: every sensor listens on its own channel, no frame can be heard twice"
        df.attrs.setdefault("drift_ppm", {})
        return ev, df, off

    # frames that can be matched across sensors need a transmitter and a sequence number
    keyed = df["ta"].notna() & df["seq"].notna()
    k = df[keyed].sort_values(["ta", "seq", "kind", "retry", "t"], kind="stable")
    same = (
        (k["ta"] == k["ta"].shift())
        & (k["seq"] == k["seq"].shift())
        & (k["kind"] == k["kind"].shift())
        & (k["retry"].fillna(0) == k["retry"].shift().fillna(0))
        & ((k["t"] - k["t"].shift()) < DEDUP_WINDOW_S)
    )
    k = k.assign(event=(~same).cumsum())
    rest = df[~keyed].copy()
    rest["event"] = np.arange(len(rest)) + (k["event"].max() if len(k) else 0) + 1
    all_ = pd.concat([k, rest])

    first_cols = [
        "t",
        "kind",
        "channel",
        "retry",
        "ta",
        "ra",
        "sa",
        "da",
        "bssid",
        "seq",
        "reason",
        "status",
        "auth_seq",
        "current_ap",
        "ssid",
        "cu",
        "scount",
        "akm",
        "mfpc",
        "mfpr",
        "eapol_type",
        "eap_code",
        "eap_type",
        "msg",
        "noise",  # radiotap noise floor and PHY rate as the loudest sensor saw them
        "rate",
    ]
    all_ = all_.sort_values(["event", "rssi"], ascending=[True, False])
    ev = all_.groupby("event", sort=False)[first_cols].first()
    sensors = all_.groupby("event", sort=False).agg(
        best_sensor=("sensor", "first"),
        best_rssi=("rssi", "max"),
        n_sensors=("sensor", "nunique"),
    )
    all_["ref"] = [
        {"sensor": s, "frame": int(f), "rssi": None if r != r else int(r)}
        for s, f, r in zip(all_["sensor"], all_["frame"], all_["rssi"])
    ]
    refs = all_.groupby("event", sort=False)["ref"].agg(list).rename("refs")
    sensors["sensors"] = [sorted(set(x)) for x in all_.groupby("event", sort=False)["sensor"].agg(list)]
    ev = ev.join(sensors).join(refs).sort_values("t").reset_index()
    ev.attrs["t0_epoch"] = float(t0)
    ev.attrs["dedup"] = "same transmitter, sequence number and type within 10 ms"
    df.attrs.setdefault("drift_ppm", {})
    return ev, df, off


def disjoint_channels(df: pd.DataFrame) -> bool:
    """True when no two sensors share a channel: then no frame is heard twice and de-dup is pure cost."""
    seen: set = set()
    for _, ch in df.groupby("sensor")["channel"]:
        mine = set(ch.dropna().unique())
        if not mine or mine & seen:
            return False
        seen |= mine
    return df["sensor"].nunique() > 1


def one_event_per_frame(df: pd.DataFrame) -> pd.DataFrame:
    """The de-dup result without the de-dup: every frame is its own event, heard by its own sensor."""
    ev = df.sort_values("t", kind="stable").reset_index(drop=True)
    ev.insert(0, "event", np.arange(1, len(ev) + 1))
    ev["best_sensor"] = ev["sensor"]
    ev["best_rssi"] = ev["rssi"]
    ev["n_sensors"] = 1
    ev["sensors"] = [[s] for s in ev["sensor"]]
    ev["refs"] = [
        [{"sensor": s, "frame": int(f), "rssi": None if r != r else int(r)}]
        for s, f, r in zip(ev["sensor"], ev["frame"], ev["rssi"])
    ]
    return ev
