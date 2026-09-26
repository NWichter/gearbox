"""RF layer: non-Wi-Fi interference and recurring time-of-day patterns.

Wi-Fi problems caused by Wi-Fi (too many clients, a busy channel) show up as load: more frames,
higher QBSS channel utilisation. Something that is NOT Wi-Fi (radar, a video link, arc welding,
frequency converters, a microwave oven on 2.4 GHz) shows up differently: the noise floor the sensor
measures between frames rises, and every transmitter on that channel suffers at once (more retries,
lower PHY rate), while the Wi-Fi load does not explain it.

Recurrence looks across days: the same problem in the same wall-clock slot on several days has a
scheduled cause (lunch break, shift change, a machine cycle). It needs a capture or a streaming
history that spans at least two calendar days and stays silent otherwise.
"""

from __future__ import annotations

import math
import os
from datetime import datetime, time, timedelta, timezone

import pandas as pd

from app.airframe.detect import FIXED_RATE_KINDS, Finding, device_class
from app.airframe.incidents import fmt_s

NOISE_RISE_DB = (
    6.0  # noise floor this far above the channel's own baseline counts as raised
)
BASELINE_S = 7200  # rolling-median baseline span; a disturbance shorter than half of it stays visible
MIN_NOISE_SAMPLES = 20  # frames per window needed for a stable median noise value
MIN_FRAMES_PER_TX = (
    5  # frames a transmitter needs inside and outside the noisy period to be judged
)
RETRY_RISE = 0.10  # +10 percentage points retry ratio = this transmitter suffers
RATE_DROP = 0.7  # PHY rate below 70 % of its own normal = this transmitter suffers
LOAD_RISE = 1.5  # 50 % more frames than normal -> Wi-Fi load could explain the retries
CU_RISE_PCT = 20  # QBSS utilisation +20 points -> Wi-Fi load could explain the retries


def _band(ch: int) -> str:
    return "2.4 GHz" if ch <= 14 else ("6 GHz" if ch > 177 else "5 GHz")


def _suspects(ch: int) -> str:
    if ch <= 14:
        return "a microwave oven, Bluetooth / Zigbee devices, a video sender or arc welding"
    if 52 <= ch <= 144:
        return "weather or military radar (this is a DFS channel), a 5 GHz video or point-to-point link, arc welding or a faulty drive / frequency converter"
    return "a 5 GHz video or point-to-point link, arc welding, a faulty drive / frequency converter or other broadband electrical noise"


def noise_anomalies(stats: pd.DataFrame, window: float = 5.0) -> list[dict]:
    """Runs of windows where one sensor's noise floor on a channel sits >= 6 dB above its own baseline.

    Per sensor, not per channel: a local source raises the noise only at the sensors near it, so the
    sensor that sees it is also the location hint. The baseline is a centred rolling median of the
    per-window median noise (robust to the +-1 dB jitter of single frames); on captures shorter than
    the baseline span it is simply the median of the whole capture.
    """
    if "noise_dbm" not in stats or stats["noise_dbm"].isna().all():
        return []
    s = stats[stats["noise_n"] >= MIN_NOISE_SAMPLES]
    span = max(3, int(BASELINE_S / window))
    out = []
    for (sensor, ch), g in s.groupby(["sensor", "channel"]):
        g = g.set_index("w").sort_index()
        if len(g) < 6:
            continue
        full = g["noise_dbm"].reindex(range(int(g.index.min()), int(g.index.max()) + 1))
        base = full.rolling(span, center=True, min_periods=6).median().reindex(g.index)
        base = base.fillna(float(g["noise_dbm"].median()))
        rise = g["noise_dbm"] - base
        hot = rise.index[rise >= NOISE_RISE_DB].to_list()
        # contiguous runs (one quiet window in between is tolerated), at least two windows = 10 s
        runs: list[list[int]] = []
        for w in hot:
            if runs and w - runs[-1][-1] <= 2:
                runs[-1].append(w)
            else:
                runs.append([w])
        for run in runs:
            if len(run) < 2:
                continue
            ws = pd.Index(run)
            out.append(
                {
                    "sensor": sensor,
                    "channel": int(ch),
                    "w0": run[0],
                    "w1": run[-1],
                    "t_start": run[0] * window,
                    "t_end": (run[-1] + 1) * window,
                    "noise_dbm": float(g.loc[ws, "noise_dbm"].median()),
                    "baseline_dbm": float(base.loc[ws].median()),
                    "rise_db": float(rise.loc[ws].median()),
                    "peak_rise_db": float(rise.loc[ws].max()),
                }
            )
    return out


def interference(
    raw: pd.DataFrame,
    stats: pd.DataFrame,
    ap_set: set[str],
    ssid_by_bssid: dict[str, str] | None = None,
    window: float = 5.0,
) -> tuple[list[Finding], list[dict]]:
    """Non-Wi-Fi interference: noise up AND many transmitters suffer AND Wi-Fi load does not explain it.

    Returns (findings, all noise anomalies); the anomalies feed the recurrence check even when they
    did not become a finding.
    """
    anomalies = noise_anomalies(stats, window)
    ssid_by_bssid = ssid_by_bssid or {}
    findings: list[Finding] = []
    for a in anomalies:
        a["finding"] = False
        ch_stats = stats[
            (stats["sensor"] == a["sensor"]) & (stats["channel"] == a["channel"])
        ]
        noisy_w = {
            w
            for b in anomalies
            if (b["sensor"], b["channel"]) == (a["sensor"], a["channel"])
            for w in range(b["w0"], b["w1"] + 1)
        }
        run_w = set(range(a["w0"], a["w1"] + 1))
        during_s = ch_stats[ch_stats["w"].isin(run_w)]
        quiet_s = ch_stats[~ch_stats["w"].isin(noisy_w)]
        if quiet_s.empty:
            continue
        # Wi-Fi load: more frames or higher QBSS utilisation would explain retries by themselves
        load_ratio = float(
            during_s["frames"].median() / max(1.0, quiet_s["frames"].median())
        )
        r = raw[(raw["sensor"] == a["sensor"]) & (raw["channel"] == a["channel"])]
        w_of = (r["t"] // window).astype(int)
        cu = r.loc[(r["kind"] == "beacon") & r["cu"].notna()]
        cu_rise = 0.0
        if len(cu):
            cu_w = w_of[cu.index]
            cu_during, cu_quiet = (
                cu.loc[cu_w.isin(run_w), "cu"],
                cu.loc[~cu_w.isin(noisy_w), "cu"],
            )
            if len(cu_during) and len(cu_quiet):
                cu_rise = float((cu_during.median() - cu_quiet.median()) / 255 * 100)
        a["load_ratio"] = round(load_ratio, 2)
        a["cu_rise_pct"] = round(cu_rise, 1)
        a["explained_by_load"] = load_ratio >= LOAD_RISE or cu_rise >= CU_RISE_PCT

        # per transmitter: its own retry ratio and PHY rate inside vs. outside the noisy period
        u = r[r["ta"].notna() & (r["kind"] != "beacon")]
        during = w_of[u.index].isin(run_w)
        quiet = ~w_of[u.index].isin(noisy_w)
        rows = []
        for ta, g in u.groupby("ta"):
            gd, gq = g[during[g.index]], g[quiet[g.index]]
            if len(gd) < MIN_FRAMES_PER_TX or len(gq) < MIN_FRAMES_PER_TX:
                continue
            rd, rq = float((gd["retry"] == 1).mean()), float((gq["retry"] == 1).mean())
            ld = gd.loc[~gd["kind"].isin(FIXED_RATE_KINDS), "rate"].median()
            lq = gq.loc[~gq["kind"].isin(FIXED_RATE_KINDS), "rate"].median()
            slow = pd.notna(ld) and pd.notna(lq) and lq > 0 and ld <= RATE_DROP * lq
            is_ap = ta in ap_set
            bssid = (
                ta
                if is_ap
                else (
                    g["bssid"].dropna().mode().iat[0]
                    if g["bssid"].notna().any()
                    else None
                )
            )
            rows.append(
                {
                    "client": None if is_ap else ta,
                    "transmitter": "AP" if is_ap else "device",
                    "vendor": device_class(ta)[0],
                    "bssid": bssid,
                    "ssid": ssid_by_bssid.get(bssid),
                    "frames_during": len(gd),
                    "retry_normal_pct": round(rq * 100, 1),
                    "retry_during_pct": round(rd * 100, 1),
                    "rate_normal_mbps": None if pd.isna(lq) else float(lq),
                    "rate_during_mbps": None if pd.isna(ld) else float(ld),
                    "_hit": (rd - rq >= RETRY_RISE) or slow,
                }
            )
        hits = [x for x in rows if x.pop("_hit")]
        a["transmitters_judged"] = len(rows)
        a["transmitters_suffering"] = len(hits)
        many = len(hits) >= 2 and len(hits) >= 0.5 * len(rows)
        if not many or a["explained_by_load"]:
            continue
        a["finding"] = True

        ud, uq = u[during], u[quiet]
        retry_d, retry_q = (
            float((ud["retry"] == 1).mean()),
            float((uq["retry"] == 1).mean()),
        )
        rate_d = ud.loc[~ud["kind"].isin(FIXED_RATE_KINDS), "rate"].median()
        rate_q = uq.loc[~uq["kind"].isin(FIXED_RATE_KINDS), "rate"].median()
        rate_txt = (
            f", median PHY rate {rate_q:.0f} -> {rate_d:.0f} Mbit/s"
            if pd.notna(rate_d) and pd.notna(rate_q) and rate_d < rate_q
            else ""
        )
        snr_d = during_s["snr_db"].median()
        snr_q = quiet_s["snr_db"].median()
        ch = a["channel"]
        # evidence: the loudest-noise frames of the period, shown in time order
        thr = a["baseline_dbm"] + NOISE_RISE_DB
        ev_rows = r[w_of.isin(run_w) & (r["noise"] >= thr)]
        ev_rows = (
            ev_rows.sort_values(["noise", "retry"], ascending=False)
            .head(12)
            .sort_values("t")
        )
        evidence = [
            {
                "t": round(float(x["t"]), 4),
                "what": (
                    f"{x['kind'].replace('_', ' ')} from {x['ta'] if isinstance(x['ta'], str) else '?'}: noise {x['noise']:.0f} dBm "
                    f"(+{x['noise'] - a['baseline_dbm']:.0f} dB), signal {x['rssi']:.0f} dBm, "
                    f"SNR {x['rssi'] - x['noise']:.0f} dB"
                    + (f", {x['rate']:g} Mbit/s" if pd.notna(x["rate"]) else "")
                    + (", retry" if x["retry"] == 1 else "")
                ),
                "kind": x["kind"],
                "frames": [
                    {
                        "sensor": a["sensor"],
                        "frame": int(x["frame"]),
                        "rssi": None if pd.isna(x["rssi"]) else int(x["rssi"]),
                    }
                ],
            }
            for _, x in ev_rows.iterrows()
        ]
        rise = a["rise_db"]
        f = Finding(
            type="rf_interference",
            severity="high"
            if rise >= 10 or len(hits) >= 0.75 * len(rows)
            else "medium",
            title=(
                f"A source that is not Wi-Fi disturbs channel {ch} near {a['sensor']} "
                f"(noise +{rise:.0f} dB"
                + (
                    f", retries +{(retry_d - retry_q) * 100:.0f} points)"
                    if retry_d - retry_q >= 0.01
                    else (
                        f", rate {rate_q:.0f} -> {rate_d:.0f} Mbit/s)"
                        if rate_txt
                        else ")"
                    )
                )
            ),
            detail=(
                f"From {fmt_s(a['t_start'])} to {fmt_s(a['t_end'])}, the noise floor that {a['sensor']} measures on channel "
                f"{ch} ({_band(ch)}) increases from {a['baseline_dbm']:.0f} to {a['noise_dbm']:.0f} dBm "
                f"(peak +{a['peak_rise_db']:.0f} dB). The SNR decreases from {snr_q:.0f} to {snr_d:.0f} dB. "
                f"{len(hits)} of {len(rows)} transmitters on the channel have problems at the same time: retry ratio "
                f"{retry_q * 100:.0f} % -> {retry_d * 100:.0f} %{rate_txt}. The Wi-Fi load does not explain this "
                f"({load_ratio:.1f}x the normal frame count"
                + (
                    f", QBSS utilisation {cu_rise:+.0f} points"
                    if len(cu)
                    else ", no QBSS load element"
                )
                + f"). Energy that is not Wi-Fi is on the channel. Examples: {_suspects(ch)}."
            ),
            t_start=float(a["t_start"]),
            t_end=float(a["t_end"]),
            channel=ch,
            sensors=[a["sensor"]],
            closest_sensor=a["sensor"],
            count=len(hits),
            recommendation=(
                f"Examine the area around {a['sensor']} with a spectrum analyser on channel {ch} at this time of day. "
                "Look for energy that is not 802.11, and find out which equipment was switched on. "
                "Until the source is removed or shielded, move the APs of critical devices to a different channel."
            ),
            evidence=evidence,
        )
        f.affected = hits
        f.wireshark_filter = (
            f"wlan_radio.channel == {ch} && wlan_radio.noise_dbm >= {math.ceil(thr)}"
        )
        findings.append(f)
    return findings, anomalies


# ---------------------------------------------------------------- recurrence

SLOT_MIN = 30  # wall-clock slot size
MAX_ITEM_S = 4 * 3600  # longer problems are states, not time-of-day events
LABEL = {
    "rf_noise": "Raised noise floor",
    "rf_interference": "Non-Wi-Fi interference",
    "congestion": "Channel congestion",
    "ap_silent": "AP is silent",
    "controller_stall": "All APs pause at the same time",
    "deauth_flood": "Deauthentication flood",
    "deauth_campaign": "Devices disconnected from Wi-Fi",
    "association_wave": "Join wave",
}


def _tz(name: str | None):
    name = name or os.environ.get("SITE_TIMEZONE", "UTC")
    try:
        from zoneinfo import ZoneInfo

        return ZoneInfo(name)
    except Exception:  # unknown zone or no tz database: fall back to UTC
        return timezone.utc


def recurring(
    findings: list[dict],
    anomalies: list[dict],
    t0_epoch: float | None,
    duration_s: float,
    tz_name: str | None = None,
    slot_min: int = SLOT_MIN,
    min_days: int = 2,
) -> list[Finding]:
    """Problems that come back in the same wall-clock slot on several days ("every day 12:00-12:30").

    Buckets every finding and every raised-noise period by time of day in the site's time zone
    (SITE_TIMEZONE, default UTC) and flags slots hit on >= min_days different days. Only active when
    the data spans >= 2 calendar days, so a single short capture never produces one. In streaming
    mode the same function runs over the rolling history of findings and noise periods.
    """
    if t0_epoch is None:
        return []
    tz = _tz(tz_name)

    def at(t: float) -> datetime:
        return datetime.fromtimestamp(t0_epoch + t, tz)

    n_days = (at(duration_s).date() - at(0).date()).days + 1
    if n_days < 2:
        return []

    # key = (type, where kind, where, sensor): the same problem at the same place
    items = []
    for f in findings:
        if f["type"] in ("rf_interference", "recurring_pattern"):
            continue  # RF periods come in through the anomalies, with their sensor
        where = next(
            ((k, f[k]) for k in ("channel", "bssid", "client") if f.get(k) is not None),
            (None, None),
        )
        items.append(
            (
                (f["type"], *where, None),
                f["t_start"],
                f["t_end"],
                f.get("severity"),
                f.get("title"),
                f.get("evidence") or [],
            )
        )
    for a in anomalies:
        typ = "rf_interference" if a.get("finding") else "rf_noise"
        items.append(
            (
                (typ, "channel", a["channel"], a["sensor"]),
                a["t_start"],
                a["t_end"],
                None,
                f"noise {a['noise_dbm']:.0f} dBm (+{a['rise_db']:.0f} dB)",
                [],
            )
        )

    by_key: dict[tuple, list] = {}
    for it in items:
        if it[2] - it[1] <= MAX_ITEM_S:
            by_key.setdefault(it[0], []).append(it)

    out = []
    for key, occ_all in by_key.items():
        per_slot: dict[int, set] = {}
        for _, a, z, *_ in occ_all:
            t, end = at(a), at(max(a, z - 1e-6))
            t = t.replace(
                minute=t.minute - t.minute % slot_min, second=0, microsecond=0
            )
            while t <= end:
                per_slot.setdefault((t.hour * 60 + t.minute) // slot_min, set()).add(
                    t.date()
                )
                t += timedelta(minutes=slot_min)
        flagged = sorted(sl for sl, days in per_slot.items() if len(days) >= min_days)
        if (
            not flagged or len(flagged) > 24 * 60 // slot_min // 2
        ):  # all day long = not a time-of-day pattern
            continue
        groups: list[list[int]] = []
        for sl in flagged:
            if groups and sl == groups[-1][-1] + 1:
                groups[-1].append(sl)
            else:
                groups.append([sl])
        typ, where_kind, where, sensor = key
        label = LABEL.get(typ, typ.replace("_", " ").capitalize())
        place = (
            f" on channel {where}" + (f" near {sensor}" if sensor else "")
            if where_kind == "channel"
            else (f" ({where})" if where else "")
        )
        for g in groups:
            lo, hi = g[0] * slot_min, (g[-1] + 1) * slot_min
            span = f"{lo // 60:02d}:{lo % 60:02d}-{hi // 60 % 24:02d}:{hi % 60:02d}"

            def in_span(t: float) -> bool:
                d = at(t)
                return lo <= d.hour * 60 + d.minute < hi

            occ = [
                o for o in occ_all if in_span(o[1]) or in_span(max(o[1], o[2] - 1e-6))
            ]
            days = sorted({at(o[1]).date() for o in occ})
            if len(days) < min_days:
                continue
            # days on which the data covered this slot at all
            first, last = at(0), at(duration_s)
            covered = sum(
                1
                for k in range(n_days)
                if (
                    d := datetime.combine(
                        first.date() + timedelta(days=k), time(lo // 60, lo % 60), tz
                    )
                )
                < last
                and d + timedelta(minutes=hi - lo) > first
            )
            covered = max(covered, len(days))
            every = (
                "every day"
                if len(days) == covered
                else f"on {len(days)} of {covered} days"
            )
            sev = {o[3] for o in occ}
            f = Finding(
                type="recurring_pattern",
                severity="high"
                if sev & {"critical", "high"} or typ == "rf_interference"
                else "medium",
                title=f"{label}{place} occurs again {every} {span}",
                detail=(
                    f"{label}{place} occurred in the same time slot {span} ({getattr(tz, 'key', 'UTC')}) on "
                    f"{len(days)} of {covered} days ({', '.join(d.isoformat() for d in days)}). A cause that follows "
                    "a timetable is a scheduled event: a break, a shift change, a machine cycle or a job on a server. "
                    "It is not random radio behaviour."
                ),
                t_start=float(min(o[1] for o in occ)),
                t_end=float(max(o[2] for o in occ)),
                channel=int(where) if where_kind == "channel" else None,
                bssid=where if where_kind == "bssid" else None,
                client=where if where_kind == "client" else None,
                sensors=[sensor] if sensor else [],
                closest_sensor=sensor,
                count=len(days),
                recommendation=(
                    f"Compare {span} with the shift plans, the break times and the machine or server schedules. "
                    "The equipment that operates at that time on these days is the most probable cause."
                ),
                evidence=[e for o in occ[:8] for e in o[5][:1]],
            )
            f.occurrences = [
                {
                    "day": at(o[1]).date().isoformat(),
                    "from": at(o[1]).strftime("%H:%M:%S"),
                    "to": at(o[2]).strftime("%H:%M:%S"),
                    "what": o[4],
                }
                for o in occ
            ]
            out.append(f)
    return out
