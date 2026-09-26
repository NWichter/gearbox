"""Infrastructure incidents.

These detectors look across clients and APs at once. A problem that hits many devices in the same
way has one root cause, so it becomes ONE incident listing everyone affected, instead of one alarm
per client.
"""

from __future__ import annotations

from collections import Counter

import numpy as np
import pandas as pd

from app.airframe.detect import (
    BROADCAST,
    NORMAL_LEAVE,
    REASONS,
    Finding,
    _ev_label,
    _evidence,
    ap_origin,
    device_class,
    origin_text,
)


def fmt_s(s: float) -> str:
    return f"{int(s // 60)}:{s % 60:04.1f}"


def _client_of_row(ta, ra, ap_set):
    if ta in ap_set and ra not in ap_set:
        return ra
    if ra in ap_set and ta not in ap_set:
        return ta
    return None


def radius_outage(
    ev: pd.DataFrame, ap_set: set[str], aps: pd.DataFrame
) -> tuple[list[Finding], set[str]]:
    """802.1X never gets past EAP-Request/Identity: the AP re-asks and finally deauths (reason 23).

    Per client that looks like a login failure; across many APs at once it is the authentication
    backend (RADIUS) not answering.
    """
    e = ev[
        ev["eap_code"].notna() | ((ev["kind"] == "deauth") & (ev["reason"] == 23))
    ].copy()
    if e.empty:
        return [], set()
    e["client"] = [_client_of_row(ta, ra, ap_set) for ta, ra in zip(e["ta"], e["ra"])]
    e = e[e["client"].notna()]
    affected, rows = [], []
    for client, g in e.groupby("client"):
        req_id = g[(g["eap_code"] == 1) & (g["eap_type"] == 1)]
        method = g[
            g["eap_code"].isin([1, 2]) & g["eap_type"].notna() & (g["eap_type"] != 1)
        ]
        success = g[g["eap_code"] == 3]
        d23 = g[(g["kind"] == "deauth") & (g["reason"] == 23)]
        if (
            len(req_id) >= 2
            and len(method) == 0
            and len(success) == 0
            and len(d23) >= 1
        ):
            affected.append(client)
            v, cls = device_class(client)
            rows.append(
                {
                    "client": client,
                    "vendor": v,
                    "device_class": cls,
                    "bssid": g["bssid"].dropna().iat[-1]
                    if g["bssid"].notna().any()
                    else None,
                    "identity_requests": len(req_id),
                    "responses": int((g["eap_code"] == 2).sum()),
                    "reason23": len(d23),
                    "first": float(g["t"].min()),
                }
            )
    if len(affected) < 2:
        return [], set()
    r = pd.DataFrame(rows)
    bssids = sorted(set(r["bssid"].dropna()))
    sel = aps["bssid"].isin(bssids)
    ssids = sorted(set(aps.loc[sel, "ssid"].dropna()))
    channels = sorted(int(c) for c in aps.loc[sel, "channel"].dropna().unique())
    succ_total = int((ev["eap_code"] == 3).sum())
    g_all = e[e["client"].isin(affected)]
    f = Finding(
        type="radius_outage",
        severity="critical" if len(bssids) >= 3 else "high",
        title=f"Devices cannot log in to {', '.join(ssids) or 'the enterprise network'}. The login server does not answer ({len(affected)} devices, {len(bssids)} APs)",
        detail=(
            f"On {', '.join(ssids) or 'the enterprise SSID'}, each login stops immediately after the AP asks for the identity. "
            f"The sensors saw {int(r['identity_requests'].sum())} EAP-Request/Identity frames and {int(r['responses'].sum())} "
            f"responses from the clients. They saw no EAP method exchange and {succ_total} EAP-Success frames in the full capture. "
            "The AP asks again. Then it disconnects the client with reason 23 (802.1X authentication failed). "
            f"This occurred {int(r['reason23'].sum())} times. The same pattern occurs on {len(bssids)} APs on channels "
            f"{', '.join(map(str, channels))} at the same time. Thus the cause is not the clients and not the radio. "
            "The authentication server (RADIUS) or the network path to it is down."
        ),
        t_start=float(g_all["t"].min()),
        t_end=float(g_all["t"].max()),
        count=len(affected),
        sensors=sorted({s for ss in g_all["sensors"] for s in ss}),
        recommendation=(
            "From the WLAN controller, check that the RADIUS server answers and that its certificates are valid. "
            "Until IT repairs this, devices on the enterprise SSID cannot log in. "
            f"Send one ticket to the identity team, not {len(affected)} tickets for single devices."
        ),
        evidence=_evidence(g_all.sort_values("t"), _ev_label, 14),
    )
    f.affected = rows
    return [f], set(affected)


def deauth_campaigns(ev: pd.DataFrame, ap_set: set[str] | None = None) -> tuple[list[Finding], set[int]]:
    """Deauth/disassoc sent to the same station with a machine-regular period, across re-associations.

    All phases (deauth, disassoc) become ONE incident: the same job walks through its target list.
    The frames are checked for their origin (AP's own sequence counter and RSSI), because "attack"
    and "controller job" need opposite fixes.
    """
    ap_set = ap_set or set()
    # reason 23 (802.1X failed) is the RADIUS incident's own retry rhythm, not a kick campaign
    d = ev[ev["kind"].isin(["deauth", "disassoc"]) & (ev["ra"] != BROADCAST) & (ev["reason"] != 23)]
    targets: list[dict] = []
    used: set[int] = set()
    phases = []
    for kind, dk in d.groupby("kind"):
        mine = []
        for target, g in dk.groupby("ra"):
            if len(g) < 4:
                continue
            t = np.sort(g["t"].to_numpy())
            iv = np.diff(t)
            med = float(np.median(iv))
            if med < 1:
                continue
            spread = float(np.percentile(iv, 90) - np.percentile(iv, 10)) / med
            if spread > 0.02:
                continue
            reasons = Counter(int(x) for x in g["reason"].dropna())
            v, cls = device_class(target)
            mine.append(
                {
                    "client": target,
                    "vendor": v,
                    "device_class": cls,
                    "ap": g["ta"].mode().iat[0],
                    "kind": kind,
                    "frames": len(g),
                    "period_s": round(med, 3),
                    "start": float(t[0]),
                    "reason": reasons.most_common(1)[0][0] if reasons else None,
                }
            )
            used.update(int(x) for x in g["event"])
        if mine:
            tg = pd.DataFrame(mine).sort_values("start")
            phases.append(
                {
                    "kind": kind,
                    "targets": len(tg),
                    "period": (float(tg["period_s"].min()), float(tg["period_s"].max())),
                    "start": float(tg["start"].min()),
                    "step": float(np.median(np.diff(tg["start"]))) if len(tg) > 1 else 0.0,
                }
            )
            targets += mine
    if not targets:
        return [], used
    tg = pd.DataFrame(targets).sort_values("start")
    # frames from the same AP to a campaign target with the campaign's reason belong to the campaign,
    # even off-rhythm (e.g. a deauth 5 ms before each disassoc) - otherwise they reappear per device
    reason_of = dict(zip(tg["client"], tg["reason"]))
    ap_of = dict(zip(tg["client"], tg["ap"]))
    extra = d[
        d["ra"].isin(set(tg["client"]))
        & (d["ta"] == d["ra"].map(ap_of))
        & (d["reason"] == d["ra"].map(reason_of))
        & ~d["event"].isin(used)
    ]
    used.update(int(x) for x in extra["event"])
    g_all = d[d["event"].isin(used)]
    reason = Counter(tg["reason"].dropna()).most_common(1)[0][0] if tg["reason"].notna().any() else None
    origin = ap_origin(g_all, ev)
    by_ap = origin is not None and origin["sent_by_ap"]
    joined = set(ev.loc[ev["kind"].isin(["assoc_resp", "reassoc_resp"]) & (ev["status"].fillna(0) == 0), "ra"])
    skipped = skipped_in_order(list(tg["client"]), ev, ap_set)
    never = [m for m in skipped if m not in joined]
    phase_txt = ". ".join(
        f"{p['kind'].capitalize()} to {p['targets']} devices every {p['period'][0]:.0f}-{p['period'][1]:.0f} s from "
        f"{fmt_s(p['start'])}, a new target about every {p['step']:.0f} s"
        for p in sorted(phases, key=lambda p: p["start"])
    )
    who = (
        "The AP sends them itself - a controller job or client policy, not an attacker."
        if by_ap
        else "The frames do not match the AP's own counter - likely forged by another transmitter."
    )
    f = Finding(
        type="deauth_campaign",
        severity="critical",
        title=(
            f"{len(tg)} devices kicked off Wi-Fi on a fixed timer by "
            + ("their own APs (controller job)" if by_ap else "a transmitter posing as the APs")
        ),
        detail=(
            f"{len(tg)} stations on {tg['ap'].nunique()} APs get kicked (reason {reason}: "
            f"{REASONS.get(reason, 'unknown')}) with a machine-regular period that ignores re-associations. "
            f"{len(phases)} phase(s): {phase_txt}. The targets are worked through in address order. "
            + (
                f"Skipped: {', '.join(never)} - exactly the devices that never joined, which only the controller "
                "knows. "
                if never and len(never) == len(skipped)
                else (f"Skipped in the order: {', '.join(skipped)}. " if skipped else "")
            )
            + origin_text(origin)
            + f" {who}"
            + (f" {len(extra)} off-rhythm frames to the same targets are counted here too." if len(extra) else "")
        ),
        t_start=float(g_all["t"].min()),
        t_end=float(g_all["t"].max()),
        count=len(tg),
        sensors=sorted({s for ss in g_all["sensors"] for s in ss}),
        recommendation=(
            "Find the controller job or policy that kicks these clients (client-kick script, idle or blacklist "
            "timer, load balancing) and stop it. 802.11w does not help: the AP itself sends these frames."
            if by_ap
            else "Enable 802.11w (Protected Management Frames). Then the clients ignore forged kicks. Find the "
            "transmitter with the sensor that receives it with the strongest signal."
        ),
        evidence=_evidence(g_all.sort_values("t"), _ev_label, 14),
    )
    f.affected = tg.to_dict("records")
    f.origin = origin
    return [f], used


def skipped_in_order(targets: list[str], ev: pd.DataFrame, ap_set: set[str]) -> list[str]:
    """Devices with an address between the targets (same vendor block) that the campaign left out."""
    try:
        nums = {m[:-2]: [] for m in targets}
        for m in targets:
            nums[m[:-2]].append(int(m[-2:], 16))
    except ValueError:
        return []
    seen = set(ev["ra"].dropna()) | set(ev["ta"].dropna())
    out = []
    for prefix, ns in nums.items():
        for n in range(min(ns), max(ns) + 1):
            m = f"{prefix}{n:02x}"
            if n not in ns and m in seen and m not in ap_set:
                out.append(m)
    return out


def stuck_scanning(
    ev: pd.DataFrame,
    aps: pd.DataFrame,
    ap_set: set[str],
    min_probes: int = 20,
    min_span: float = 300,
) -> list[Finding]:
    """Devices that scan, get answers from the APs of their network and still never join.

    On a site where no device ever changes AP, that means: the device is bound to one AP (BSSID
    pinning or static config) and exactly that AP is off the air. One finding per network, so a
    tools-network device is not mixed with office devices.
    """
    # a searching device is visible directly (its probe requests) or only indirectly: when the sensor
    # cannot hear the device's uplink, the APs' probe responses addressed to it still prove it is there
    p = ev[ev["kind"] == "probe_req"][["ta", "t", "channel", "best_sensor", "ssid"]].rename(columns={"ta": "mac"})
    pr = ev[ev["kind"] == "probe_resp"][["ra", "ta", "t", "channel", "best_sensor"]].rename(columns={"ra": "mac"})
    trace = pd.concat([p.assign(direct=1), pr.drop(columns="ta").assign(direct=0)])
    t_end = float(ev["t"].max())
    joined = set(ev.loc[ev["kind"].isin(["auth", "assoc_req", "reassoc_req"]), "ta"]) | set(
        ev.loc[ev["kind"].isin(["assoc_resp", "reassoc_resp", "auth"]), "ra"]
    )
    responders = pr.groupby("mac")["ta"].nunique()
    ssid_of_ap = dict(zip(aps["bssid"], aps["ssid"]))
    on_air = {x for x in aps["ssid"].dropna()}
    net_of_oui = network_by_vendor_block(ev, ap_set, ssid_of_ap)
    directed = p[p["ssid"].notna() & (p["ssid"] != "")].groupby("mac")["ssid"].agg(lambda x: x.mode().iat[0])
    rows = []
    for mac, g in trace.groupby("mac"):
        if mac in joined or mac in ap_set or mac == BROADCAST or len(g) < min_probes:
            continue
        # searching for minutes, or one scan answered by several APs and then giving up for good
        # (a healthy device authenticates within seconds of its scan)
        n_resp = int(responders.get(mac, 0))
        long_search = float(g["t"].max() - g["t"].min()) >= min_span
        gave_up = n_resp >= 3 and t_end - float(g["t"].max()) >= 60
        if not (long_search or gave_up):
            continue
        v, cls = device_class(mac)
        rows.append({
            "client": mac, "vendor": v, "device_class": cls,
            "network": directed.get(mac) or net_of_oui.get(mac[:8]),
            "network_source": "own probe requests" if mac in directed.index else "devices of the same maker",
            "probes": int(g["direct"].sum()), "ap_replies": int((g["direct"] == 0).sum()),
            "answering_aps": n_resp,
            "channels": sorted(int(c) for c in g["channel"].dropna().unique()),
            "closest_sensor": g["best_sensor"].mode().iat[0], "first": float(g["t"].min()),
        })
    if not rows:
        return []
    missing = missing_bssids(aps)
    roam = roaming_summary(ev, ap_set)
    out = []
    r_all = pd.DataFrame(rows)
    for net, r in r_all.groupby(r_all["network"].fillna("unknown network"), sort=False):
        rs = r.to_dict("records")
        mine = [m for m in missing if f"({net}," in m or "whole radio" in m]
        macs = list(r["client"])[:6]
        ev_rows = ev[((ev["kind"] == "probe_req") & ev["ta"].isin(macs)) | ((ev["kind"] == "probe_resp") & ev["ra"].isin(macs))]
        ev_rows = ev_rows.sort_values("t").groupby(ev_rows["ta"].where(ev_rows["kind"] == "probe_req", ev_rows["ra"])).head(2)
        industrial = int((r["device_class"] == "industrial").sum())
        n_net = int((aps["ssid"] == net).sum())
        f = Finding(
            type="stuck_scanning",
            severity="critical" if industrial or len(r) >= 5 else "high",
            title=f"{len(r)} device{'s' if len(r) > 1 else ''} on {net} cannot connect: {'their' if len(r) > 1 else 'its'} "
            "access point is off and they do not use another one",
            detail=(
                f"{len(r)} devices scan and get answers from {int(r['answering_aps'].min())}-{int(r['answering_aps'].max())} APs, "
                + (f"{net} itself is on the air on {n_net} other APs, " if net in on_air else "")
                + "yet they never start an authentication. "
                + (
                    f"No device on this site ever changes AP ({roam['multi_ap']} of {roam['clients']} connected devices "
                    f"used a second AP, {roam['reassoc']} reassociations): each device is bound to one AP. "
                    if roam["clients"]
                    else ""
                )
                + (f"Not on the air: {', '.join(mine[:8])}. " if mine else "")
                + "So one AP off means these devices stay offline - there is no fallback."
            ),
            t_start=float(r["first"].min()),
            t_end=t_end,
            count=len(r),
            recommendation=(
                "Switch the listed radios / SSIDs back on at the controller. Then remove the single-AP binding "
                "(BSSID pinning, static AP list) so a device can move to the next AP of its network."
            ),
            evidence=_evidence(ev_rows.sort_values("t"), lambda x: f"{x['kind'].replace('_', ' ')} {x['ta']} -> {x['ra']}", 12),
        )
        f.affected = rs
        f.missing_bssids = mine
        out.append(f)
    return out


def network_by_vendor_block(ev: pd.DataFrame, ap_set: set[str], ssid_of_ap: dict) -> dict[str, str]:
    """The network most connected devices of each vendor block (OUI) use - a hint for silent devices."""
    j = ev[ev["kind"].isin(["assoc_resp", "reassoc_resp"]) & (ev["status"].fillna(0) == 0)]
    j = j[~j["ra"].isin(ap_set)]
    nets = j.assign(oui=j["ra"].str[:8], net=j["ta"].map(ssid_of_ap)).dropna(subset=["net"])
    return nets.groupby("oui")["net"].agg(lambda x: x.mode().iat[0]).to_dict()


def roaming_summary(ev: pd.DataFrame, ap_set: set[str]) -> dict:
    j = ev[ev["kind"].isin(["assoc_resp", "reassoc_resp"]) & (ev["status"].fillna(0) == 0) & ~ev["ra"].isin(ap_set)]
    per = j.groupby("ra")["ta"].nunique()
    return {
        "clients": int(len(per)),
        "multi_ap": int((per > 1).sum()),
        "reassoc": int((ev["kind"] == "reassoc_req").sum()),
    }


def missing_bssids(aps: pd.DataFrame) -> list[str]:
    """Radios (same MAC except last byte) that beacon one SSID but not the other, and gaps in radio numbering."""
    a = aps.dropna(subset=["ssid"]).copy()
    if a.empty:
        return []
    a["radio"] = a["bssid"].str[:14]
    a["slot"] = a["bssid"].str[-2:]
    counts = a["ssid"].value_counts()
    main = [s for s in counts.index if counts[s] >= 3]
    slot_of = {s: a.loc[a["ssid"] == s, "slot"].mode().iat[0] for s in main}
    out = []
    for radio, g in a.groupby("radio"):
        have = set(g["ssid"])
        ch = int(g["channel"].iat[0]) if pd.notna(g["channel"].iat[0]) else "?"
        for ssid in main:
            if ssid not in have:
                out.append(f"{radio}:{slot_of[ssid]} ({ssid}, ch {ch})")
    try:
        nums = sorted({int(r.split(":")[3], 16) for r in a["radio"]})
        prefix = a["radio"].iat[0][:9]
        out += [
            f"{prefix}{n:02x}:00:xx (whole radio silent)"
            for n in range(nums[0], nums[-1] + 1)
            if n not in nums
        ]
    except (ValueError, IndexError):
        pass
    return out


def association_wave(ev: pd.DataFrame, window: float = 60, min_clients: int = 10) -> list[Finding]:
    """Waves of many devices (re)associating one after another (first association per device)."""
    a = ev[ev["kind"].isin(["assoc_resp", "reassoc_resp"]) & (ev["status"].fillna(0) == 0)]
    if a.empty:
        return []
    first = a.sort_values("t").drop_duplicates("ra")
    ts = first["t"].to_numpy()
    # split into waves wherever two consecutive joins are further apart than 3x the typical spacing
    gaps = np.diff(ts)
    if len(gaps) == 0:
        return []
    cut = max(5.0, 3 * float(np.median(gaps)))
    bounds = [0] + [i + 1 for i, g in enumerate(gaps) if g > cut] + [len(ts)]
    out = []
    for lo, hi in zip(bounds[:-1], bounds[1:]):
        w = first.iloc[lo:hi]
        n = len(w)
        if n < min_clients:
            continue
        iv = np.diff(w["t"].to_numpy())
        regular = len(iv) > 3 and float(np.std(iv) / max(1e-9, np.mean(iv))) < 0.05
        vendors = Counter(device_class(m)[0] for m in w["ra"])
        who = ", ".join(f"{v} x{c}" for v, c in vendors.most_common(3))
        out.append(Finding(
            type="association_wave",
            severity="info",
            title=f"{n} devices joined within {w['t'].max() - w['t'].min():.0f} s" + (f", one every {np.mean(iv):.1f} s" if regular else ""),
            detail=(
                f"{n} devices ({who}) associate one after the other, starting at {fmt_s(float(w['t'].min()))}."
                + (" The interval is constant. This looks like a script (a planned restart or provisioning)." if regular else "")
            ),
            t_start=float(w["t"].min()), t_end=float(w["t"].max()), count=n,
            recommendation="Make sure that this was planned. If it was not planned, the devices lost the network before the wave.",
        ))
    return out


def controller_stall(
    raw: pd.DataFrame, min_sensors: int = 3, thr_ms: float = 10, pulse_gap_s: float = 2.0, merge_s: float = 30.0
) -> list[Finding]:
    """Beacons arriving late on several channels at the same moment -> the APs' shared controller/firmware stalled.

    Late beacons are clustered in time (not cut at whole seconds, which can split one pause in two), and
    pulses less than `merge_s` apart become one incident with several pulses.
    """
    if "late_ms" not in raw:
        return []
    b = raw[(raw["kind"] == "beacon") & raw["late_ms"].notna()].copy()
    if b.empty:
        return []
    b["late"] = b["late_ms"] - b.groupby("sensor")["late_ms"].transform("median")
    hot = b[b["late"] > thr_ms].sort_values("t").copy()
    if hot.empty:
        return []
    hot["pulse"] = (hot["t"].diff() > pulse_gap_s).cumsum()
    pulses = hot.groupby("pulse").agg(
        a=("t", "min"), z=("t", "max"), sensors=("sensor", "nunique"),
        beacons=("sensor", "size"), peak=("late", "max"),
    )
    pulses = pulses[pulses["sensors"] >= min_sensors].sort_values("a")
    if pulses.empty:
        return []
    pulses["incident"] = (pulses["a"].diff() > merge_s).cumsum()
    out = []
    for _, grp in pulses.groupby("incident"):
        rows = hot[hot["pulse"].isin(grp.index)]
        n = len(grp)
        starts = [fmt_s(float(x)) for x in grp["a"]]
        when = starts[0] if n == 1 else ", ".join(starts[:-1]) + " and " + starts[-1]
        chans = int(grp["sensors"].max())
        span = float(grp["z"].max() - grp["a"].min())
        out.append(
            Finding(
                type="controller_stall",
                severity="medium",
                title=(
                    "All access points paused at once"
                    + (f" ({n} times within {span:.0f} s)" if n > 1 else "")
                    + f": beacons up to {grp['peak'].max():.0f} ms late on {chans} channels"
                ),
                detail=(
                    f"At {when}: {int(grp['beacons'].sum())} beacons from {rows['ta'].nunique()} APs on up to {chans} different "
                    f"channels arrive late at the same moment (up to {grp['peak'].max():.0f} ms after their own timestamp). "
                    "Different channels cannot share a radio problem, so the common controller or AP firmware paused - "
                    "a warning sign before outages."
                ),
                t_start=float(grp["a"].min()) - 0.5,
                t_end=float(grp["z"].max()) + 0.5,
                count=int(grp["beacons"].sum()),
                sensors=sorted(rows["sensor"].unique()),
                evidence=[
                    {"t": round(float(x["t"]), 4), "what": f"beacon from {x['ta']} {x['late']:.0f} ms late", "kind": "beacon",
                     "frames": [{"sensor": x["sensor"], "frame": int(x["frame"]), "rssi": None}]}
                    for _, x in rows.sort_values("late", ascending=False).drop_duplicates("sensor").iterrows()
                ],
                recommendation="Check the CPU load and the logs of the controller at this time. If this occurs again, plan a firmware update or a restart during a break.",
            )
        )
    return out


def sensor_clocks(
    raw: pd.DataFrame, offsets: dict[str, float], max_offset_ms: float = 100, max_drift_ppm: float = 5
) -> list[Finding]:
    """Sensor clocks that are off or drift, measured against the APs' beacon timestamps (TSF).

    The pipeline corrects them, but the sensor fleet has a time-sync problem: at 25 ppm a sensor is
    2 s off per day, and events from different sensors no longer line up without the correction.
    """
    drift = raw.attrs.get("drift_ppm") or {}
    if not drift or not offsets:
        return []
    ref = min(drift, key=lambda k: abs(offsets.get(k, 0.0)))
    rows = []
    for s in sorted(drift):
        off_ms = (offsets.get(s, 0.0) - offsets.get(ref, 0.0)) * 1000
        if abs(off_ms) >= max_offset_ms or abs(drift[s]) >= max_drift_ppm:
            rows.append({
                "sensor": s, "offset_ms": round(off_ms, 1), "drift_ppm": drift[s],
                "per_day_s": round(abs(drift[s]) * 86400 / 1e6, 1),
            })
    if not rows:
        return []
    r = pd.DataFrame(rows)
    worst_off = r.loc[r["offset_ms"].abs().idxmax()]
    worst_drift = r.loc[r["drift_ppm"].abs().idxmax()]
    b = raw[(raw["kind"] == "beacon") & raw["sensor"].isin(r["sensor"])].sort_values("t").groupby("sensor").head(1)
    f = Finding(
        type="sensor_clock",
        severity="medium",
        title=(
            f"{len(r)} of {len(drift)} sensor clocks are off (up to {worst_off['offset_ms'] / 1000:+.2f} s) "
            f"and drift (up to {worst_drift['drift_ppm']:+.0f} ppm)"
        ),
        detail=(
            f"Measured against the APs' beacon timestamps, relative to {ref}: "
            + ", ".join(f"{x['sensor']} {x['offset_ms']:+.0f} ms / {x['drift_ppm']:+.1f} ppm" for x in rows)
            + f". At {abs(worst_drift['drift_ppm']):.0f} ppm a sensor is {worst_drift['per_day_s']} s off after one day. "
            "Gearbox corrects this before it compares sensors, but the sensors' own time sync (NTP/PTP) does not work - "
            "without the correction, events on different sensors would not line up."
        ),
        t_start=0.0,
        t_end=float(raw["t"].max()),
        count=len(r),
        sensors=list(r["sensor"]),
        recommendation="Check NTP or PTP on the sensors (the server is reachable, the service runs). Set an alarm for a sensor that drifts more than 5 ppm.",
        evidence=[
            {"t": round(float(x["t"]), 4), "what": f"first beacon on {x['sensor']} (clock reference)", "kind": "beacon",
             "frames": [{"sensor": x["sensor"], "frame": int(x["frame"]), "rssi": None}]}
            for _, x in b.iterrows()
        ],
    )
    f.affected = rows
    return [f]


def signoff_wave(ev: pd.DataFrame, ap_set: set[str], window: float = 10, min_clients: int = 5) -> list[Finding]:
    """Many devices signing off themselves within seconds (reason: station is leaving) - a planned restart or a failover."""
    d = ev[
        ev["kind"].isin(["deauth", "disassoc"])
        & ev["ta"].notna()
        & ~ev["ta"].isin(ap_set)
        & ev["reason"].isin(list(NORMAL_LEAVE))
    ].sort_values("t")
    if d.empty:
        return []
    first = d.drop_duplicates("ta")
    ts = first["t"].to_numpy()
    out = []
    i = 0
    while i < len(ts):
        j = int(np.searchsorted(ts, ts[i] + window, side="right"))
        if j - i < min_clients:
            i += 1
            continue
        w = first.iloc[i:j]
        vendors = Counter(device_class(m)[0] for m in w["ta"])
        sensors = sorted({s for ss in w["sensors"] for s in ss})
        out.append(Finding(
            type="signoff_wave",
            severity="info",
            title=f"{len(w)} devices signed off within {w['t'].max() - w['t'].min():.0f} s",
            detail=(
                f"{len(w)} devices ({', '.join(f'{v} x{c}' for v, c in vendors.most_common(3))}) send a deauth or disassoc "
                f"themselves (reason: station is leaving) between {fmt_s(float(w['t'].min()))} and "
                f"{fmt_s(float(w['t'].max()))}, heard on {len(sensors)} sensors. Devices leave on their own like this "
                "after a planned restart, a shift change or a failover."
            ),
            t_start=float(w["t"].min()),
            t_end=float(w["t"].max()),
            count=len(w),
            sensors=sensors,
            recommendation="Make sure that this was planned (a restart, an update, a failover). If it was not planned, find what occurred immediately before.",
            evidence=_evidence(w, _ev_label, 8),
        ))
        i = j
    return out


def security_posture(aps: pd.DataFrame, ev: pd.DataFrame) -> list[Finding]:
    """Networks that protect worst: one shared password (PSK) and no protection of management frames (802.11w)."""
    if "mfpc" not in aps or aps["ssid"].isna().all():
        return []
    out = []
    for ssid, g in aps[aps["ssid"].notna()].groupby("ssid"):
        akm = g["akm"].dropna().astype(float)
        psk = len(akm) > 0 and akm.isin([2, 6, 8]).mean() > 0.5
        mfpc = g["mfpc"].dropna()
        no_pmf = len(mfpc) > 0 and (mfpc == 0).mean() > 0.5
        if not (psk and no_pmf):
            continue
        # one beacon per AP (up to 6) as proof: the RSN element is in every beacon
        proof = ev[(ev["kind"] == "beacon") & ev["ta"].isin(set(g["bssid"]))].drop_duplicates("ta").head(6)
        out.append(Finding(
            type="weak_security",
            severity="medium",
            title=f"{ssid} uses one shared password and no management-frame protection",
            detail=(
                f"All {len(g)} APs of {ssid} announce WPA2-PSK (one key for every device) and do not support 802.11w "
                "(RSN capabilities: MFP capable = 0). Anyone with the key can decrypt every device's traffic, and "
                "anyone in range can forge deauth frames that knock the devices off."
            ),
            t_start=float(g["first"].min()),
            t_end=float(g["last"].max()),
            count=len(g),
            bssid=g["bssid"].iat[0],
            sensors=sorted({s for ss in proof["sensors"] for s in ss}),
            evidence=_evidence(proof, lambda x: f"beacon from {x['ta']}: WPA2-PSK, 802.11w not supported"),
            recommendation="Move the network to WPA3-SAE or 802.1X with per-device credentials and set 802.11w to required.",
        ))
    return out


def device_vanished(ev: pd.DataFrame, ap_set: set[str], min_silence: float | None = None) -> list[Finding]:
    """A device that was connected, signed off itself and stays silent until the end.

    Silence alone is not enough: most devices are only heard through their AP (the home-channel
    sensor never hears them), so a working, idle device looks exactly like a gone one. See
    docs/04-data.md, "Why 20 tools go quiet after joining".
    """
    joined = ev[ev["kind"].isin(["assoc_resp", "reassoc_resp"]) & (ev["status"].fillna(0) == 0)]
    t_end = float(ev["t"].max())
    # silent for the rest of the capture: 5 minutes, or a quarter of a short capture
    min_silence = min_silence or min(300.0, max(30.0, 0.25 * t_end))
    out = []
    for mac in set(joined["ra"]) - ap_set - {BROADCAST}:
        mine = ev[(ev["ta"] == mac) | (ev["ra"] == mac)]
        last = float(mine["t"].max())
        if t_end - last < min_silence:
            continue
        tail = mine[mine["t"] >= last - 5]
        left = tail[tail["kind"].isin(["deauth", "disassoc"]) & (tail["ta"] == mac)]
        # after joining, a healthy device sends mostly encrypted data the sensors do not keep, so
        # silence alone proves nothing: only a device that signs off itself and never returns counts
        if left.empty:
            continue
        v, cls = device_class(mac)
        f = Finding(
            type="device_vanished",
            severity="medium",
            title=("A tool" if cls == "industrial" else "A device") + " disconnected itself and did not return",
            detail=(
                f"{mac} ({v}) was connected, "
                + (f"signed off with reason {int(left['reason'].iat[0])} ({REASONS.get(int(left['reason'].iat[0]), 'unknown')}) " if len(left) and pd.notna(left['reason'].iat[0]) else "stopped sending ")
                + f"and stayed silent for the last {(t_end - last) / 60:.0f} minutes of the capture. "
                + (
                    "An orderly sign-off: the device was switched off or restarted (operator, OS, low-battery "
                    "shutdown) and did not come back."
                    if len(left) and left["reason"].iat[0] in NORMAL_LEAVE
                    else "Battery, power or a defect."
                )
            ),
            t_start=last, t_end=t_end, client=mac, vendor=v, device_class=cls,
            bssid=mine["bssid"].dropna().iat[-1] if mine["bssid"].notna().any() else None,
            sensors=sorted({s for ss in tail["sensors"] for s in ss}),
            recommendation="Ask who switched it off. Check the battery or the power supply. If the device stays silent, replace it.",
            evidence=_evidence(tail.sort_values("t"), _ev_label, 6),
        )
        out.append(f)
    return out
