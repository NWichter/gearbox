"""Stage 3 - detectors.

Failures on the air rarely show up as one bad frame; they show up as a
sequence that does not complete. Every client runs through a small state
machine (auth -> assoc -> 802.1X/EAP -> 4-way handshake -> connected) and
every break becomes a finding. AP-, channel- and security-level detectors
work on the fused events and use the multi-sensor view to tell "the AP went
silent" apart from "one sensor lost it".

Each detector is keyed (client / BSSID / channel), so it can run as a
partitioned stream job at scale.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import asdict, dataclass, field

import numpy as np
import pandas as pd

from app.airframe.ingest import vendor

BROADCAST = "ff:ff:ff:ff:ff:ff"

REASONS = {
    1: "unspecified",
    2: "previous authentication no longer valid",
    3: "station is leaving (deauth)",
    4: "disassociated due to inactivity",
    5: "AP is unable to handle all associated stations",
    6: "class 2 frame from non-authenticated station",
    7: "class 3 frame from non-associated station",
    8: "station is leaving the BSS",
    9: "station not authenticated",
    10: "power capability unacceptable",
    11: "supported channels unacceptable",
    13: "invalid information element",
    14: "MIC failure",
    15: "4-way handshake timeout",
    16: "group key handshake timeout",
    17: "IE in 4-way handshake differs",
    18: "invalid group cipher",
    19: "invalid pairwise cipher",
    20: "invalid AKMP",
    23: "IEEE 802.1X authentication failed",
    24: "cipher suite rejected (security policy)",
    32: "unspecified QoS reason",
    33: "QoS AP lacks sufficient bandwidth",
    34: "excessive frames not acknowledged (poor channel conditions)",
    35: "transmitting outside TXOP limits",
    36: "requested by peer (leaving)",
    39: "timeout",
    45: "peer not reachable",
}
NORMAL_LEAVE = {3, 8, 36}

STATUS = {
    0: "success",
    1: "unspecified failure",
    10: "cannot support all requested capabilities",
    11: "reassociation denied (no association exists)",
    12: "association denied (reason outside scope)",
    13: "authentication algorithm not supported",
    14: "authentication transaction sequence out of order",
    15: "challenge failure",
    16: "authentication timeout",
    17: "AP unable to handle additional stations",
    18: "basic rates not supported",
    30: "association rejected temporarily, try again later",
    31: "robust management frame policy violation",
    37: "request declined",
    40: "invalid information element",
    41: "invalid group cipher",
    42: "invalid pairwise cipher",
    43: "invalid AKMP",
    53: "invalid PMKID",
    82: "rejected with suggested BSS transition",
}

INDUSTRIAL = (
    "atlas",
    "desoutter",
    "bosch",
    "rexroth",
    "siemens",
    "kuka",
    "zebra",
    "honeywell",
    "datalogic",
    "stanley",
    "apex",
    "ingersoll",
    "fanuc",
    "abb",
    "phoenix",
    "moxa",
    "hilscher",
    "cognex",
    "keyence",
    "sick",
    "pepperl",
    "espressif",
    "texas instr",
    "silicon lab",
    "murata",
    "u-blox",
    "laird",
    "digi",
    "symbol",
    "intermec",
    "b&r",
    "beckhoff",
    "wago",
    "festo",
    "turck",
    "balluff",
    "lxe",
    "psion",
)
PERSONAL = (
    "apple",
    "samsung",
    "google",
    "xiaomi",
    "huawei",
    "oneplus",
    "oppo",
    "vivo",
    "motorola",
    "sony",
    "intel",
    "microsoft",
    "dell",
    "hewlett",
    "hp inc",
    "lenovo",
    "realtek",
    "liteon",
    "azurewave",
    "hon hai",
    "cloud network",
    "murata manufacturing",
)

SEV_ORDER = {"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4}


def device_class(mac: str) -> tuple[str, str]:
    v = vendor(mac)
    lv = v.lower()
    if v == "locally administered":
        return v, "personal (randomized MAC)"
    if any(k in lv for k in INDUSTRIAL):
        return v, "industrial"
    if any(k in lv for k in PERSONAL):
        return v, "personal"
    return v, "unknown"


@dataclass
class Finding:
    type: str
    severity: str
    title: str
    detail: str
    t_start: float
    t_end: float
    client: str | None = None
    bssid: str | None = None
    channel: int | None = None
    sensors: list[str] = field(default_factory=list)
    count: int = 1
    recommendation: str = ""
    evidence: list[dict] = field(default_factory=list)
    device_class: str | None = None
    vendor: str | None = None
    closest_sensor: str | None = None
    affected: list[dict] = field(default_factory=list)  # incidents: every client/AP involved
    missing_bssids: list[str] = field(default_factory=list)
    occurrences: list[dict] = field(default_factory=list)  # recurring patterns: one row per day it happened
    wireshark_filter: str | None = None  # preset by a detector; otherwise built in playbook.annotate
    origin: dict | None = None  # deauth/disassoc: sequence-counter and RSSI check of who really sent them


def _bump(sev: str, cls: str | None) -> str:
    """Industrial devices (tools, scanners, PLC gateways) keep the line moving - raise one level."""
    if cls == "industrial" and sev in ("high", "medium", "low"):
        return {"high": "critical", "medium": "high", "low": "medium"}[sev]
    return sev


def _evidence(rows: pd.DataFrame, label: str, limit: int = 12) -> list[dict]:
    out = []
    for _, r in rows.head(limit).iterrows():
        out.append(
            {
                "t": round(float(r["t"]), 4),
                "what": label if isinstance(label, str) else label(r),
                "kind": r["kind"],
                "frames": r["refs"],
            }
        )
    return out


def _ev_label(r) -> str:
    k = r["kind"]
    if k in ("deauth", "disassoc"):
        return f"{k} reason {int(r['reason']) if pd.notna(r['reason']) else '?'} ({REASONS.get(int(r['reason']) if pd.notna(r['reason']) else -1, 'unknown')}) from {r['ta']}"
    if k in ("auth", "assoc_resp", "reassoc_resp") and pd.notna(r["status"]):
        return (
            f"{k} status {int(r['status'])} ({STATUS.get(int(r['status']), 'unknown')})"
        )
    if pd.notna(r.get("eap_code")):
        return {
            1: "EAP Request",
            2: "EAP Response",
            3: "EAP Success",
            4: "EAP Failure",
        }.get(int(r["eap_code"]), "EAP")
    if pd.notna(r.get("msg")):
        return f"EAPOL-Key M{int(r['msg'])}"
    return k


# ---------------------------------------------------------------- who really sent a frame

# management frames whose sequence number comes from the AP's own software counter; beacons are
# left out on purpose: many APs build them in hardware with a separate counter (Tesla's: always 0)
_COUNTER_KINDS = ["probe_resp", "assoc_resp", "reassoc_resp", "auth", "action", "deauth", "disassoc"]


def ap_origin(rows: pd.DataFrame, ev: pd.DataFrame) -> dict | None:
    """Did the AP itself send these frames, or someone using its address?

    A spoofer does not know the AP's internal sequence counter and does not sit where the AP sits.
    So each frame is compared with (1) the previous counter frame of the same transmitter - a
    real frame continues the counter within a few steps - and (2) the RSSI of the AP's beacons.
    """
    rows = rows[rows["seq"].notna() & rows["ta"].notna()]
    if rows.empty:
        return None
    tas = set(rows["ta"])
    ref = ev[ev["kind"].isin(_COUNTER_KINDS) & ev["ta"].isin(tas) & ev["seq"].notna()]
    ref = ref[~ref["event"].isin(set(rows["event"]))][["t", "ta", "seq"]].sort_values("t")
    near = pd.merge_asof(
        rows.sort_values("t")[["t", "ta", "seq", "best_rssi"]],
        ref.rename(columns={"seq": "prev_seq"}),
        on="t",
        by="ta",
        direction="backward",
        tolerance=60.0,
    )
    near = near[near["prev_seq"].notna()]
    if near.empty:
        return None
    gap = (near["seq"] - near["prev_seq"]) % 4096
    beacon_rssi = ev[(ev["kind"] == "beacon") & ev["ta"].isin(tas)].groupby("ta")["best_rssi"].median()
    delta = (near["best_rssi"] - near["ta"].map(beacon_rssi)).dropna()
    fit = float(((gap >= 1) & (gap <= 16)).mean())
    out = {
        "frames": int(len(near)),
        "seq_fit": round(fit, 3),
        "seq_gap_median": float(gap.median()),
        "rssi_delta_db": round(float(delta.mean()), 2) if len(delta) else None,
        "rssi_delta_sd": round(float(delta.std()), 2) if len(delta) > 1 else None,
    }
    same_place = out["rssi_delta_db"] is None or abs(out["rssi_delta_db"]) <= 3
    out["sent_by_ap"] = fit >= 0.8 and same_place
    return out


def origin_text(o: dict | None) -> str:
    if not o:
        return ""
    rssi = (
        f", signal {o['rssi_delta_db']:+.1f} ± {o['rssi_delta_sd'] or 0:.1f} dB from the AP's own beacons"
        if o["rssi_delta_db"] is not None
        else ""
    )
    head = (
        "Sent by the AP itself, not forged: "
        if o["sent_by_ap"]
        else "Probably forged (not the AP's own counter or position): "
    )
    return (
        f"{head}{o['seq_fit'] * 100:.0f} % of {o['frames']} frames continue the AP's own sequence counter "
        f"(median step {o['seq_gap_median']:.0f}){rssi}."
    )


# ---------------------------------------------------------------- topology


def topology(ev: pd.DataFrame) -> tuple[pd.DataFrame, set[str]]:
    b = ev[ev["kind"].isin(["beacon", "probe_resp"]) & ev["ta"].notna()]
    aps = (
        b.groupby("ta")
        .agg(
            ssid=(
                "ssid",
                lambda s: s.dropna().mode().iat[0] if s.notna().any() else None,
            ),
            channel=(
                "channel",
                lambda s: s.dropna().mode().iat[0] if s.notna().any() else None,
            ),
            beacons=("kind", lambda s: int((s == "beacon").sum())),
            first=("t", "min"),
            last=("t", "max"),
            cu_mean=("cu", "mean"),
            cu_max=("cu", "max"),
            akm=(
                "akm",
                lambda s: s.dropna().mode().iat[0] if s.notna().any() else None,
            ),
            best_sensor=("best_sensor", lambda s: s.mode().iat[0]),
            mfpc=("mfpc", "max"),
            mfpr=("mfpr", "max"),
        )
        .reset_index()
        .rename(columns={"ta": "bssid"})
    )
    return aps, set(aps["bssid"])


# ---------------------------------------------------------------- client state machine

CLIENT_KINDS = {
    "action",
    "auth",
    "assoc_req",
    "assoc_resp",
    "reassoc_req",
    "reassoc_resp",
    "deauth",
    "disassoc",
    "qos_data",
    "data",
}


def client_sequences(
    ev: pd.DataFrame, ap_set: set[str], exclude_events: set[int] | None = None
) -> tuple[list[Finding], pd.DataFrame]:
    exclude_events = exclude_events or set()
    t_max = float(ev["t"].max()) if len(ev) else 0.0
    m = ev[ev["kind"].isin(CLIENT_KINDS)].copy()
    m = m[(m["kind"] != "qos_data") & (m["kind"] != "data") | m["eapol_type"].notna()]

    def client_of(r) -> str | None:
        ta, ra = r["ta"], r["ra"]
        if ta in ap_set and ra not in ap_set and ra != BROADCAST:
            return ra
        if ra in ap_set and ta not in ap_set:
            return ta
        if ta not in ap_set and ra != BROADCAST:
            return ta
        return None

    m["client"] = m.apply(client_of, axis=1)
    m = m[m["client"].notna() & (m["client"] != BROADCAST)]
    findings: list[Finding] = []
    rows = []

    for client, g in m.groupby("client", sort=False):
        g = g.sort_values("t")
        v, cls = device_class(client)
        eap_fail = g[g["eap_code"] == 4]
        eap_ok = g[g["eap_code"] == 3]
        deauth_ap = g[
            g["kind"].isin(["deauth", "disassoc"])
            & g["ta"].isin(ap_set)
            # reason 23 belongs to the 802.1X/RADIUS incident, periodic kicks to the campaign incident
            & ~g["reason"].isin(NORMAL_LEAVE | {23})
            & ~g["event"].isin(exclude_events)
        ]
        rejected = g[
            g["kind"].isin(["assoc_resp", "reassoc_resp"])
            & g["status"].notna()
            & (g["status"] != 0)
        ]
        auth_rej = g[(g["kind"] == "auth") & g["status"].notna() & (g["status"] != 0)]
        m1 = g[g["msg"] == 1]
        m4 = g[g["msg"] == 4]
        roams = g[g["kind"] == "reassoc_req"]
        bssids = g["bssid"].dropna()
        last_bssid = bssids.iat[-1] if len(bssids) else None
        closest = g["best_sensor"].mode().iat[0] if len(g) else None
        sensors = sorted({s for ss in g["sensors"] for s in ss})

        def F(**kw) -> Finding:
            f = Finding(
                client=client,
                vendor=v,
                device_class=cls,
                closest_sensor=closest,
                sensors=sensors,
                **kw,
            )
            f.severity = _bump(f.severity, cls)
            return f

        # 802.1X / EAP failures
        if len(eap_fail):
            n = len(eap_fail)
            findings.append(
                F(
                    type="eap_failure",
                    severity="high" if n >= 3 else "medium",
                    title=f"802.1X authentication fails ({n}x)"
                    + (". The device tries again and again" if n >= 3 else ""),
                    detail=f"EAP-Failure {n} times, EAP-Success {len(eap_ok)} times. The client tries again and does not get access to the network. Typical causes: an expired or incorrect certificate, incorrect credentials, or a RADIUS server that does not answer.",
                    t_start=float(eap_fail["t"].min()),
                    t_end=float(eap_fail["t"].max()),
                    count=n,
                    bssid=last_bssid,
                    recommendation="Look for this MAC address or identity in the RADIUS log. Then check the client certificate and its expiry date.",
                    evidence=_evidence(
                        g[(g["eap_code"] == 4) | g["kind"].isin(["deauth"])], _ev_label
                    ),
                )
            )

        # 4-way handshake incomplete. Sensors often hear only one side of the link, so a missing M2/M4 is
        # not a failure: M3 proves the AP received M2. A handshake counts as failed only if no M3/M4 follows
        # within 5 s, or M3 is resent (M4 never arrived), or a reason-15 deauth follows. Handshakes cut off by
        # the start or end of the capture are ignored.
        m3 = g[g["msg"] == 3]
        if len(m1):
            failed = []
            for t1 in m1["t"]:
                if t1 < 10 or t1 > t_max - 5:
                    continue
                later = (m3["t"] > t1) & (m3["t"] < t1 + 5)
                # M3, M4 or any follow-up management traffic (e.g. Block Ack setup) = the link went on
                follow = g[(g["t"] > t1) & (g["t"] < t1 + 5) & (g["kind"] == "action")]
                done = later.any() or ((m4["t"] > t1) & (m4["t"] < t1 + 5)).any() or len(follow) > 0
                resent_m3 = later.sum() >= 3
                kicked = ((g["kind"] == "deauth") & (g["reason"] == 15) & (g["t"] > t1) & (g["t"] < t1 + 10)).any()
                if not done or resent_m3 or kicked:
                    failed.append(t1)
            attempts = []
            for t in failed:
                if not attempts or t - attempts[-1][-1] > 2.5:
                    attempts.append([t])
                else:
                    attempts[-1].append(t)
            if attempts:
                hs = g[g["msg"].notna() | ((g["kind"] == "deauth") & (g["reason"] == 15))]
                n = len(attempts)
                reason15 = int(((g["kind"] == "deauth") & (g["reason"] == 15)).sum())
                findings.append(F(
                    type="handshake_failure", severity="high",
                    title=f"4-way handshake does not complete ({n} attempt{'s' if n > 1 else ''})",
                    detail=f"M1 sent {len(m1)}x, M3 {len(m3)}x, M4 {len(m4)}x. The key exchange stops before the end."
                    + (f" The AP stops with deauth reason 15 (4-way handshake timeout) {reason15}x." if reason15 else "")
                    + " Typical causes: an incorrect PSK or PMK, a firmware bug on the client, or bad radio conditions (lost frames).",
                    t_start=float(attempts[0][0]), t_end=float(attempts[-1][-1]), count=n, bssid=last_bssid,
                    recommendation="Compare with other clients on this AP. If only this device fails, check its firmware, its driver and its key settings.",
                    evidence=_evidence(hs, _ev_label),
                ))

        # AP kicks the client
        if len(deauth_ap):
            reasons = Counter(int(x) for x in deauth_ap["reason"].dropna())
            top = ", ".join(
                f"{REASONS.get(k, f'reason {k}')} ({k}) x{c}"
                for k, c in reasons.most_common(3)
            )
            sev = (
                "high"
                if len(deauth_ap) >= 3 or any(k in (34, 5, 15, 23, 14) for k in reasons)
                else "medium"
            )
            if not (
                reasons.keys() <= {15, 23}
            ):  # already covered by handshake/EAP findings
                findings.append(
                    F(
                        type="deauth_by_ap",
                        severity=sev,
                        title=f"The AP disconnected this device {len(deauth_ap)} times",
                        detail=f"Deauth or disassoc frames from the AP: {top}.",
                        t_start=float(deauth_ap["t"].min()),
                        t_end=float(deauth_ap["t"].max()),
                        count=len(deauth_ap),
                        bssid=last_bssid,
                        recommendation="Reason 34 or 5: radio or capacity problems on the AP. Reason 4: a power-save or idle timeout. Reason 2, 6 or 7: the AP and the client do not agree on the connection state after roaming.",
                        evidence=_evidence(deauth_ap, _ev_label),
                    )
                )

        # rejected associations
        if len(rejected) or len(auth_rej):
            rr = pd.concat([rejected, auth_rej])
            codes = Counter(int(x) for x in rr["status"].dropna())
            findings.append(
                F(
                    type="assoc_rejected",
                    severity="medium",
                    title=f"The AP refused the association or authentication ({len(rr)}x)",
                    detail="Status codes: "
                    + ", ".join(
                        f"{STATUS.get(k, k)} ({k}) x{c}" for k, c in codes.most_common()
                    ),
                    t_start=float(rr["t"].min()),
                    t_end=float(rr["t"].max()),
                    count=len(rr),
                    bssid=last_bssid,
                    recommendation="Status 17: the AP is full. Add capacity or move clients to other APs. Status 30 or 82: the AP sends the client to a different AP.",
                    evidence=_evidence(rr, _ev_label),
                )
            )

        # roaming behaviour
        if len(roams) >= 4:
            ts = roams["t"].to_numpy()
            targets = roams["ra"].tolist()
            best = 0
            j = 0
            for i in range(len(ts)):
                while ts[i] - ts[j] > 60:
                    j += 1
                best = max(best, i - j + 1)
            distinct = len(set(targets))
            if best >= 4:
                findings.append(
                    F(
                        type="ping_pong_roaming"
                        if distinct <= 2
                        else "excessive_roaming",
                        severity="medium",
                        title=f"{'Ping-pong' if distinct <= 2 else 'Too much'} roaming: {best} roams within 60 s",
                        detail=f"{len(roams)} reassociations across {distinct} APs. Each roam is a short outage. Between two APs, this usually means two cells that overlap with a similar signal, and no roaming hysteresis.",
                        t_start=float(ts[0]),
                        t_end=float(ts[-1]),
                        count=len(roams),
                        bssid=last_bssid,
                        recommendation="Adjust the roaming thresholds or enable 802.11k/v/r. Alternatively, adjust the AP transmit power so that one AP is clearly the strongest.",
                        evidence=_evidence(roams, lambda r: f"reassoc -> {r['ra']}"),
                    )
                )

        rows.append(
            {
                "client": client,
                "vendor": v,
                "device_class": cls,
                "events": len(g),
                "bssid": last_bssid,
                "roams": len(roams),
                "eap_failures": len(eap_fail),
                "deauths": int(g["kind"].isin(["deauth", "disassoc"]).sum()),
                "first": float(g["t"].min()),
                "last": float(g["t"].max()),
                "closest_sensor": closest,
                "best_rssi": float(g["best_rssi"].max())
                if g["best_rssi"].notna().any()
                else None,
            }
        )
    return findings, pd.DataFrame(rows)


# ---------------------------------------------------------------- AP health


def beacon_gaps(
    ev: pd.DataFrame, raw: pd.DataFrame, aps: pd.DataFrame, clients_df: pd.DataFrame
) -> tuple[list[Finding], list[Finding]]:
    findings, sensor_findings = [], []
    b = ev[ev["kind"] == "beacon"]
    rb = raw[raw["kind"] == "beacon"]
    sensor_alive = raw.groupby("sensor")["t"].apply(lambda s: np.sort(s.to_numpy()))
    for bssid, g in b.groupby("ta"):
        t = np.sort(g["t"].to_numpy())
        if len(t) < 20:
            continue
        interval = float(np.median(np.diff(t)))
        thr = max(1.0, 10 * interval)
        d = np.diff(t)
        for i in np.where(d > thr)[0]:
            a, z = float(t[i]), float(t[i + 1])
            # which sensors normally hear this AP and were alive during the gap?
            hearers = rb[rb["ta"] == bssid]["sensor"].value_counts()
            hearers = hearers[hearers >= 0.3 * hearers.max()].index.tolist()
            alive = [
                s
                for s in hearers
                if ((sensor_alive[s] > a + 0.2) & (sensor_alive[s] < z - 0.2)).any()
            ]
            reassoc = ev[
                (ev["kind"] == "reassoc_req")
                & (ev["current_ap"] == bssid)
                & (ev["t"] >= a)
                & (ev["t"] <= z + 10)
            ]
            ssid = aps.loc[aps.bssid == bssid, "ssid"]
            name = f"{bssid} ({ssid.iat[0]})" if len(ssid) and ssid.iat[0] else bssid
            sev = "critical" if len(reassoc) >= 3 else "high"
            findings.append(
                Finding(
                    type="ap_silent",
                    severity=sev,
                    title=f"AP {name} was silent for {z - a:.1f} s",
                    detail=f"No beacons for {z - a:.1f} s (normal interval {interval * 1000:.0f} ms). {len(alive)} sensor(s) captured other traffic at that time ({', '.join(alive) or 'none'}). Thus the cause is the AP, not a sensor. "
                    + (
                        f"{reassoc['ta'].nunique()} client(s) moved from this AP to a different AP."
                        if len(reassoc)
                        else ""
                    ),
                    t_start=a,
                    t_end=z,
                    bssid=bssid,
                    channel=int(g["channel"].dropna().iat[0])
                    if g["channel"].notna().any()
                    else None,
                    sensors=alive,
                    count=int(reassoc["ta"].nunique()),
                    recommendation="Check the power supply (PoE) and the uplink of the AP. Look in the controller logs for a restart or a radio reset at this time.",
                    evidence=_evidence(
                        g[(g["t"] >= a - 0.5) & (g["t"] <= z + 0.5)], "beacon"
                    )
                    + _evidence(
                        reassoc,
                        lambda r: f"client {r['ta']} reassociates away from this AP",
                    ),
                )
            )
    # per-sensor gaps that the fused view does not have -> sensor/coverage issue
    for (sensor, bssid), g in rb.groupby(["sensor", "ta"]):
        t = np.sort(g["t"].to_numpy())
        if len(t) < 50:
            continue
        interval = float(np.median(np.diff(t)))
        fused = np.sort(b[b["ta"] == bssid]["t"].to_numpy())
        for i in np.where(np.diff(t) > max(2.0, 20 * interval))[0]:
            a, z = t[i], t[i + 1]
            others = ((fused > a + 0.5) & (fused < z - 0.5)).sum()
            if others > 5:
                sensor_findings.append(
                    Finding(
                        type="sensor_blind_spot",
                        severity="info",
                        title=f"{sensor} did not hear {bssid} for {z - a:.1f} s. Other sensors heard it",
                        detail="Only this sensor did not receive the beacons. The cause is coverage or the sensor, not an AP outage. The comparison between sensors shows this difference.",
                        t_start=float(a),
                        t_end=float(z),
                        bssid=bssid,
                        sensors=[sensor],
                        recommendation="Check the position and the antenna of the sensor, and its channel-hopping schedule.",
                    )
                )
    return findings, sensor_findings


# ---------------------------------------------------------------- channel load


# beacons, probe responses and control frames go out at a fixed basic rate: they say nothing about the link
FIXED_RATE_KINDS = {"beacon", "probe_resp", "ack", "cts", "rts", "block_ack", "block_ack_req", "ps_poll"}


def window_stats(raw: pd.DataFrame, window: float = 5.0) -> pd.DataFrame:
    """Per (sensor, channel, window): load, retries and the radiotap RF view (noise, signal, SNR, rate).

    Shared by the channel timeline, the congestion detector and the RF interference detector.
    """
    cols = ["sensor", "channel", "t", "kind", "retry", "rssi", "noise", "rate"]
    r = raw.loc[raw["channel"].notna(), [c for c in cols if c in raw]].copy()
    for c in ("noise", "rate"):
        if c not in r:
            r[c] = np.nan
    r["w"] = (r["t"] // window).astype(int)
    r["is_retry"] = (r["retry"] == 1).astype(int)
    r["is_rts"] = (r["kind"] == "rts").astype(int)
    r["is_cts"] = (r["kind"] == "cts").astype(int)
    r["snr"] = r["rssi"] - r["noise"]
    r["link_rate"] = r["rate"].where(~r["kind"].isin(FIXED_RATE_KINDS))
    return (
        r.groupby(["sensor", "channel", "w"])
        .agg(
            frames=("kind", "size"),
            retries=("is_retry", "sum"),
            rts=("is_rts", "sum"),
            cts=("is_cts", "sum"),
            noise_dbm=("noise", "median"),
            noise_n=("noise", "count"),
            signal_dbm=("rssi", "median"),
            snr_db=("snr", "median"),
            rate_mbps=("link_rate", "median"),
        )
        .reset_index()
    )


def congestion(
    raw: pd.DataFrame,
    ev: pd.DataFrame,
    aps: pd.DataFrame,
    window: float = 5.0,
    stats: pd.DataFrame | None = None,
) -> tuple[list[Finding], list[dict]]:
    per = window_stats(raw, window) if stats is None else stats
    # the loudest sensor per channel/window is our best view of that channel
    per = per.sort_values("frames", ascending=False).drop_duplicates(["channel", "w"])
    bcu = ev[(ev["kind"] == "beacon") & ev["cu"].notna()].copy()
    bcu["w"] = (bcu["t"] // window).astype(int)
    cu = bcu.groupby(["channel", "w"])["cu"].max().rename("cu_max").reset_index()
    per = per.merge(cu, on=["channel", "w"], how="left")
    per["retry_ratio"] = per["retries"] / per["frames"].clip(lower=1)
    per["cu_pct"] = per["cu_max"] / 255 * 100
    per["hot"] = (per["cu_pct"] >= 80) | (
        (per["retry_ratio"] >= 0.25) & (per["frames"] >= 50)
    )

    findings = []
    for ch, g in per.sort_values("w").groupby("channel"):
        hot = g[g["hot"]]
        if len(hot) < 2:
            continue
        # contiguous runs of hot windows
        runs, cur = [], [hot.iloc[0]]
        for _, row in hot.iloc[1:].iterrows():
            if row["w"] - cur[-1]["w"] <= 2:
                cur.append(row)
            else:
                runs.append(cur)
                cur = [row]
        runs.append(cur)
        for run in runs:
            if len(run) < 2:
                continue
            rd = pd.DataFrame(run)
            a, z = float(rd["w"].min() * window), float((rd["w"].max() + 1) * window)
            hot_aps = (
                bcu[
                    (bcu["channel"] == ch)
                    & (bcu["t"] >= a)
                    & (bcu["t"] <= z)
                    & (bcu["cu"] >= 0.8 * 255)
                ]["ta"]
                .unique()
                .tolist()
            )
            names = [
                f"{x} ({aps.loc[aps.bssid == x, 'ssid'].iat[0]})"
                for x in hot_aps
                if (aps.bssid == x).any()
            ]
            findings.append(
                Finding(
                    type="congestion",
                    severity="high"
                    if rd["cu_pct"].max() >= 90 or rd["retry_ratio"].max() >= 0.35
                    else "medium",
                    title=f"Channel {int(ch)} was congested for {z - a:.0f} s",
                    detail=f"Peak channel utilization {rd['cu_pct'].max():.0f} % (QBSS load), retry ratio up to {rd['retry_ratio'].max() * 100:.0f} %, {int(rd['rts'].sum())} RTS / {int(rd['cts'].sum())} CTS, up to {int(rd['frames'].max() / window)} frames/s."
                    + (f" Busiest AP(s): {', '.join(names)}." if names else ""),
                    t_start=a,
                    t_end=z,
                    channel=int(ch),
                    bssid=hot_aps[0] if hot_aps else None,
                    sensors=sorted(set(rd["sensor"])),
                    count=len(rd),
                    recommendation="Move clients to 5 or 6 GHz (band steering). Add an AP or make the cells smaller. Look for interference that is not Wi-Fi. Critical tools must not use the same channel as a canteen or a break room.",
                )
            )
    timeline = per[
        ["channel", "w", "frames", "retry_ratio", "cu_pct", "rts", "sensor",
         "noise_dbm", "signal_dbm", "snr_db", "rate_mbps"]
    ].sort_values(["w", "channel"])
    timeline["t"] = timeline["w"] * window
    return findings, timeline.drop(columns="w").replace({np.nan: None}).to_dict(
        "records"
    )


# ---------------------------------------------------------------- security


def security(ev: pd.DataFrame, aps: pd.DataFrame, ap_set: set[str]) -> list[Finding]:
    findings = []
    # deauth / disassoc floods
    d = ev[ev["kind"].isin(["deauth", "disassoc"])].copy()
    if len(d):
        d["sec"] = d["t"].astype(int)
        for ta, g in d.groupby("ta"):
            per_sec = g.groupby("sec").size()
            if per_sec.max() < 5:
                continue
            burst = g[g["sec"].isin(per_sec[per_sec >= 3].index)]
            bcast = int((burst["ra"] == BROADCAST).sum())
            # spoofing check: the AP's own counter frames and beacon RSSI (not beacon seq - often a hardware counter)
            origin = ap_origin(burst, ev)
            spoofed = bool(origin) and not origin["sent_by_ap"]
            reasons = Counter(int(x) for x in burst["reason"].dropna())
            findings.append(
                Finding(
                    type="deauth_flood",
                    severity="critical" if spoofed else "high",
                    title=f"Deauthentication flood from {ta}: {len(burst)} frames, peak {int(per_sec.max())}/s",
                    detail=f"{bcast} broadcast deauth frames (these disconnect all clients). Reasons: {', '.join(f'{REASONS.get(k, k)} ({k})' for k in reasons)}. "
                    + origin_text(origin)
                    + (
                        " Transmitter is a known AP BSSID."
                        if ta in ap_set
                        else " Transmitter is not a known AP."
                    ),
                    t_start=float(burst["t"].min()),
                    t_end=float(burst["t"].max()),
                    bssid=ta,
                    count=len(burst),
                    sensors=sorted({s for ss in burst["sensors"] for s in ss}),
                    closest_sensor=burst["best_sensor"].mode().iat[0],
                    recommendation=(
                        "The frames are forged. Enable 802.11w (Protected Management Frames). Then the clients "
                        "ignore forged deauth frames. Find the transmitter with the closest sensor and the signal "
                        "strength (RSSI)."
                        if spoofed
                        else "The AP sends these frames itself. Thus 802.11w does not help. Find the controller "
                        "policy or the job that disconnects the clients."
                    ),
                    evidence=_evidence(burst, _ev_label),
                )
            )

    # evil twin: same SSID, odd BSSID
    for ssid, g in aps[aps["ssid"].notna()].groupby("ssid"):
        if len(g) < 3:
            continue
        ouis = Counter(b[:8] for b in g["bssid"])
        main_oui, _ = ouis.most_common(1)[0]
        main_akm = g["akm"].mode().iat[0] if g["akm"].notna().any() else None
        for _, ap in g.iterrows():
            odd_oui = ap["bssid"][:8] != main_oui
            odd_sec = main_akm is not None and ap["akm"] != main_akm
            local = int(ap["bssid"][1], 16) & 0x2
            if odd_oui and (local or odd_sec or ouis[ap["bssid"][:8]] == 1):
                findings.append(
                    Finding(
                        type="rogue_ap",
                        severity="critical",
                        title=f"Possible evil twin: {ap['bssid']} advertises '{ssid}'",
                        detail=f"The other {len(g) - 1} APs of '{ssid}' use vendor prefix {main_oui}. This AP uses {ap['bssid'][:8]} ({vendor(ap['bssid'])})"
                        + (", and its security settings are different" if odd_sec else "")
                        + f". Seen on channel {int(ap['channel']) if pd.notna(ap['channel']) else '?'} from {ap['first']:.0f} s to {ap['last']:.0f} s, closest sensor {ap['best_sensor']}.",
                        t_start=float(ap["first"]),
                        t_end=float(ap["last"]),
                        bssid=ap["bssid"],
                        channel=int(ap["channel"]) if pd.notna(ap["channel"]) else None,
                        closest_sensor=ap["best_sensor"],
                        recommendation="Compare with the AP inventory. If the AP is unknown, find it (closest sensor, RSSI) and remove it. Enable rogue-AP containment in the controller.",
                        evidence=_evidence(
                            ev[(ev["kind"] == "beacon") & (ev["ta"] == ap["bssid"])],
                            "beacon",
                            5,
                        ),
                    )
                )

    # short-lived / unusual networks (easter eggs live here)
    main = aps.sort_values("beacons", ascending=False)["ssid"].dropna()
    main_ssids = set(main.head(3))
    for _, ap in aps.iterrows():
        dur = ap["last"] - ap["first"]
        if ap["ssid"] not in main_ssids and (dur < 10 or ap["beacons"] < 50):
            findings.append(
                Finding(
                    type="transient_network",
                    severity="info",
                    title=f"Short-lived network '{ap['ssid'] or '<hidden>'}' ({ap['bssid']})",
                    detail=f"This network sent beacons for only {dur:.1f} s ({int(ap['beacons'])} beacons) on channel {int(ap['channel']) if pd.notna(ap['channel']) else '?'}. It can be a test AP, a hotspot or a hidden message.",
                    t_start=float(ap["first"]),
                    t_end=float(ap["last"]),
                    bssid=ap["bssid"],
                    closest_sensor=ap["best_sensor"],
                    recommendation="Make sure that this network is expected.",
                )
            )
    return findings


# ---------------------------------------------------------------- sensors


def sensor_views(
    raw: pd.DataFrame, ev: pd.DataFrame, offsets: dict[str, float]
) -> dict:
    sensors = sorted(raw["sensor"].unique())
    heard = {s: set() for s in sensors}
    for eid, ss in zip(ev["event"], ev["sensors"]):
        for s in ss:
            heard[s].add(eid)
    keyed_total = len(ev[ev["n_sensors"].notna()])
    overlap = []
    for a in sensors:
        row = []
        for b in sensors:
            inter = len(heard[a] & heard[b])
            union = len(heard[a] | heard[b]) or 1
            row.append(round(inter / union, 3))
        overlap.append(row)
    stats = []
    for s in sensors:
        r = raw[raw["sensor"] == s]
        stats.append(
            {
                "sensor": s,
                "frames": int(len(r)),
                "channels": sorted(int(c) for c in r["channel"].dropna().unique()),
                "clock_offset_ms": round(offsets.get(s, 0.0) * 1000, 1),
                "events_heard": len(heard[s]),
                "share_of_all_events": round(len(heard[s]) / max(1, keyed_total), 3),
                "unique_events": int(sum(1 for ss in ev["sensors"] if ss == [s])),
                "t_first": float(r["t"].min()),
                "t_last": float(r["t"].max()),
            }
        )
    return {"sensors": sensors, "overlap": overlap, "stats": stats}


def rank(findings: list[Finding]) -> list[dict]:
    out = [asdict(f) for f in findings]
    out.sort(key=lambda f: (SEV_ORDER[f["severity"]], f["t_start"]))
    for i, f in enumerate(out, 1):
        f["id"] = i
    return out
