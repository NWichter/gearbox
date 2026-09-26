"""Runs ingest -> fuse -> detect on a folder of captures and returns one JSON-able result."""

from __future__ import annotations

import time
from pathlib import Path

import numpy as np
import pandas as pd

from app.airframe import detect, incidents, locate, playbook, rf
from app.airframe.fuse import fuse
from app.airframe.ingest import find_captures, read_all

TIMELINE_WINDOW = 5.0


def _clean(o):
    if isinstance(o, dict):
        return {k: _clean(v) for k, v in o.items()}
    if isinstance(o, list):
        return [_clean(v) for v in o]
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating, float)):
        return None if np.isnan(o) else round(float(o), 4)
    if o is pd.NA or o is pd.NaT:
        return None
    return o


def event_timeline(ev: pd.DataFrame) -> list[dict]:
    e = ev.copy()
    e["w"] = (e["t"] // TIMELINE_WINDOW).astype(int)
    cats = {
        "deauth": e["kind"].isin(["deauth", "disassoc"]),
        "auth": e["kind"].isin(
            ["auth", "assoc_req", "reassoc_req", "assoc_resp", "reassoc_resp"]
        ),
        "eap_failure": e["eap_code"] == 4,
        "handshake": e["msg"].notna(),
        "probe": e["kind"] == "probe_req",
        "retry": e["retry"] == 1,
    }
    out = pd.DataFrame({"w": e["w"]})
    for k, m in cats.items():
        out[k] = m.astype(int)
    agg = out.groupby("w").sum().reset_index()
    agg["t"] = agg["w"] * TIMELINE_WINDOW
    return agg.drop(columns="w").to_dict("records")


def analyze(folder: Path) -> tuple[dict, pd.DataFrame]:
    """Batch analysis of a folder of captures. Returns (JSON-able result, fused events)."""
    t_start = time.perf_counter()
    paths = find_captures(folder)
    if not paths:
        raise ValueError(f"no capture files in {folder}")
    raw = read_all(paths)
    return analyze_frames(raw, [p.name for p in paths], t_start)


def analyze_frames(raw: pd.DataFrame, files: list[str], t_start: float | None = None) -> tuple[dict, pd.DataFrame]:
    """Stages 2 and 3 on an ingested frame table (stage 1 output). t_start includes ingest time when given."""
    t_ingest = time.perf_counter()
    t_start = t_ingest if t_start is None else t_start
    if raw.empty:
        raise ValueError("the captures contain no 802.11 frames")
    ev, raw, offsets = fuse(raw)
    t_fuse = time.perf_counter()

    aps, ap_set = detect.topology(ev)
    radius, _ = incidents.radius_outage(ev, ap_set, aps)
    campaigns, campaign_events = incidents.deauth_campaigns(ev, ap_set)
    infra = (
        radius
        + campaigns
        + incidents.stuck_scanning(ev, aps, ap_set)
        + incidents.association_wave(ev)
        + incidents.controller_stall(raw)
        + incidents.device_vanished(ev, ap_set)
        + incidents.signoff_wave(ev, ap_set)
        + incidents.sensor_clocks(raw, offsets)
        + incidents.security_posture(aps, ev)
    )
    client_findings, clients = detect.client_sequences(ev, ap_set, campaign_events)
    ap_findings, sensor_findings = detect.beacon_gaps(ev, raw, aps, clients)
    ssid_by_bssid = dict(zip(aps["bssid"], aps["ssid"]))
    stats = detect.window_stats(raw, TIMELINE_WINDOW)
    cong_findings, channel_timeline = detect.congestion(raw, ev, aps, TIMELINE_WINDOW, stats)
    rf_findings, rf_anomalies = rf.interference(raw, stats, ap_set, ssid_by_bssid, TIMELINE_WINDOW)
    sec_findings = detect.security(ev, aps, ap_set)
    findings = detect.rank(
        infra + client_findings + ap_findings + cong_findings + rf_findings + sec_findings + sensor_findings
    )
    # time-of-day recurrence across days; silent unless the data spans >= 2 calendar days
    duration = float(ev["t"].max()) if len(ev) else 0.0
    findings += detect.rank(rf.recurring(findings, rf_anomalies, ev.attrs.get("t0_epoch"), duration))
    playbook.annotate(findings, ssid_by_bssid, ev.attrs.get("t0_epoch"))
    findings.sort(key=lambda f: (detect.SEV_ORDER[f["severity"]], f["t_start"]))
    for i, f in enumerate(findings, 1):
        f["id"] = i
    t_detect = time.perf_counter()

    # per-AP client counts and findings
    if len(clients):
        per_ap = clients.groupby("bssid").size()
        aps["clients"] = aps["bssid"].map(per_ap).fillna(0).astype(int)
    else:
        aps["clients"] = 0
    aps["vendor"] = aps["bssid"].map(detect.vendor)
    aps["findings"] = (
        aps["bssid"].map(Counter_by(findings, "bssid")).fillna(0).astype(int)
    )
    if len(clients):
        clients["findings"] = (
            clients["client"].map(Counter_by(findings, "client")).fillna(0).astype(int)
        )

    sev = (
        pd.Series([f["severity"] for f in findings]).value_counts().to_dict()
        if findings
        else {}
    )
    result = {
        "summary": {
            "files": files,
            "sensors": int(raw["sensor"].nunique()),
            "frames": int(len(raw)),
            "events": int(len(ev)),
            "dedup_ratio": round(1 - len(ev) / max(1, len(raw)), 3),
            "dedup": ev.attrs.get("dedup"),
            "duration_s": round(duration, 1),
            "start_epoch": ev.attrs.get("t0_epoch"),
            "aps": int(len(aps)),
            **inventory(ev, aps, ap_set, clients),
            "clients": int(len(clients)),
            "findings": len(findings),
            "by_severity": sev,
            "timing_s": {
                "ingest": round(t_ingest - t_start, 2),
                "fuse": round(t_fuse - t_ingest, 2),
                "detect": round(t_detect - t_fuse, 2),
            },
            "frames_per_s": round(len(raw) / max(0.001, t_detect - t_start)),
            "scale": scale_numbers(raw, duration, t_ingest - t_start, t_fuse - t_ingest, t_detect - t_fuse),
        },
        "findings": findings,
        "aps": aps.replace({np.nan: None}).to_dict("records"),
        "clients": clients.replace({np.nan: None}).to_dict("records")
        if len(clients)
        else [],
        "sensors": detect.sensor_views(raw, ev, offsets) | {
            "alignment": raw.attrs.get("alignment"),
            "drift_ppm": raw.attrs.get("drift_ppm", {}),
        },
        "timeline": event_timeline(ev),
        "layout": locate.layout(raw, aps, ap_set),
        "channel_timeline": channel_timeline,
        # raised-noise periods per sensor/channel, also those that did not become a finding
        "rf_anomalies": rf_anomalies,
    }
    return _clean(result), ev


def inventory(ev: pd.DataFrame, aps: pd.DataFrame, ap_set: set[str], clients: pd.DataFrame) -> dict:
    """Separate counts: physical radios vs. networks (BSSIDs), device addresses vs. connected vs. heard."""
    radios = sorted({b[:14] for b in aps["bssid"]})
    expected = len(radios)
    try:  # sequential radio numbering (4th octet) reveals radios that never came on air
        nums = sorted({int(r.split(":")[3], 16) for r in radios})
        expected = max(expected, nums[-1] - nums[0] + 1)
    except (ValueError, IndexError):
        pass

    def unicast(m) -> bool:
        return isinstance(m, str) and len(m) == 17 and not int(m[1], 16) & 1

    addrs = {m for col in ("ta", "ra") for m in ev[col].dropna().unique() if unicast(m)} - ap_set
    heard = {m for m in ev["ta"].dropna().unique() if unicast(m)} - ap_set
    joined = set(ev.loc[ev["kind"].isin(["assoc_resp", "reassoc_resp"]) & (ev["status"].fillna(0) == 0), "ra"]) - ap_set
    return {
        "radios_on_air": len(radios),
        "radios_expected": expected,
        "networks": int(len(aps)),
        "devices_total": len(addrs),
        "devices_connected": len(joined),
        "devices_heard": len(heard),
    }


def scale_numbers(raw: pd.DataFrame, duration: float, t_ingest: float, t_fuse: float, t_detect: float) -> dict:
    """Measured numbers behind the scale design: how many sensors one worker keeps up with."""
    n = len(raw)
    sensors = max(1, int(raw["sensor"].nunique()))
    per_sensor_fps = n / sensors / max(1.0, duration)  # frames each sensor produces per second of air
    total = max(0.001, t_ingest + t_fuse + t_detect)
    beacon_share = float((raw["kind"] == "beacon").mean()) if n else 0.0
    return {
        "frames_per_sensor_s": round(per_sensor_fps, 1),
        "ingest_fps": round(n / max(0.001, t_ingest)),
        "fuse_fps": round(n / max(0.001, t_fuse)),
        "detect_fps": round(n / max(0.001, t_detect)),
        "pipeline_fps": round(n / total),
        # one worker, real time, raw frames
        "sensors_per_worker": int(n / total / max(0.001, per_sensor_fps)),
        # beacons can be summarised on the sensor (one heartbeat per AP per second) before shipping
        "beacon_share": round(beacon_share, 3),
        "sensors_per_worker_edge_filtered": int(n / total / max(0.001, per_sensor_fps * (1 - beacon_share) + 0.1)),
        "replay_speedup": round(duration / total, 1),
        # Tesla's capture is quiet (78 frames/s per sensor, 82 % beacons, 0.24 % data). A busy factory
        # channel carries 1,000-5,000 frames/s, mostly data and ACK headers, which beacon summaries do not
        # remove. So the honest capacity is per frame: sensors per process at a realistic frame rate.
        "sensors_per_worker_at_1000_fps": round(n / total / 1000, 1),
        "sensors_per_worker_at_2000_fps": round(n / total / 2000, 1),
    }


def Counter_by(findings: list[dict], key: str) -> dict:
    c: dict = {}
    for f in findings:
        k = f.get(key)
        if k:
            c[k] = c.get(k, 0) + 1
    return c


def client_ladder(ev: pd.DataFrame, mac: str, limit: int = 400) -> list[dict]:
    """All management/EAPOL events involving one client, for the sequence view."""
    m = (
        ev[((ev["ta"] == mac) | (ev["ra"] == mac)) & (ev["kind"] != "ack")]
        .sort_values("t")
        .head(limit)
    )
    out = []
    for _, r in m.iterrows():
        out.append(
            {
                "t": round(float(r["t"]), 4),
                "kind": r["kind"],
                "from": r["ta"],
                "to": r["ra"],
                "bssid": r["bssid"],
                "label": detect._ev_label(r),
                "sensors": r["sensors"],
                "best_rssi": None if pd.isna(r["best_rssi"]) else int(r["best_rssi"]),
                "refs": r["refs"],
            }
        )
    return out


if __name__ == "__main__":
    import json
    import sys

    res, _ = analyze(Path(sys.argv[1]))
    print(json.dumps(res["summary"], indent=2))
    for f in res["findings"]:
        print(f"[{f['severity']:8}] {f['t_start']:7.1f}s  {f['type']:18} {f['title']}")
