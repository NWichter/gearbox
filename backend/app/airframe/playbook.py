"""Who acts, what to do, how urgent - the supervisor's view of every finding.

Two questions decide the instruction (from the team's fault catalogue):
1. How many are affected? One device -> the device (the supervisor can act: restart, swap,
   battery). Many devices on one AP -> the AP (IT). Many devices on many APs -> the network
   behind them or an attack (IT / security, immediately). Nothing to swap in those cases.
2. Which network? A device on the tools network can stop the line (red); office network only
   (laptops, phones) is annoying but the line runs (yellow); security incidents are purple.
"""

from __future__ import annotations

import os
import re

from app.airframe.ingest import SUBTYPE

# networks whose devices keep the line running; configurable per site
CRITICAL_SSID = re.compile(
    os.environ.get("CRITICAL_SSID_PATTERN", r"TOOL|IOT|\bOT\b|PROD|PLC|AGV"), re.I
)

SECURITY_TYPES = {"deauth_flood", "rogue_ap", "weak_security"}

# type -> (who, supervisor action, IT action)
PLAYBOOK: dict[str, tuple[str, str, str]] = {
    "eap_failure": (
        "you",
        "Restart the device. If it fails again, use a spare device and give this device to IT (certificate or credentials).",
        "Look for this identity in the RADIUS log. Renew the certificate.",
    ),
    "radius_outage": (
        "it",
        "Do not replace devices. This does not help. IT knows about the problem: the login server does not answer.",
        "Make the RADIUS server reachable from the WLAN controller again, and check its certificates.",
    ),
    "handshake_failure": (
        "you",
        "Restart the device. If it fails again, use a spare device and give this device to IT.",
        "Check the key settings, the driver and the firmware of the device.",
    ),
    "assoc_rejected": (
        "you",
        "If possible, move a few metres away from the other devices. IT knows about the problem (the AP is full).",
        "Add capacity, or move clients to other APs.",
    ),
    "stuck_scanning": (
        "it",
        "Do not replace the device. This does not help. Its access point is off and the device does not try "
        "a different access point. IT knows about the problem.",
        "Switch the missing radio or SSID on again. Then remove the binding to one AP, so that the devices can "
        "connect to the next AP.",
    ),
    "deauth_by_ap": (
        "you",
        "Let the device connect again. If this occurs again, use a spare device. IT knows about the problem (AP setting).",
        "Check the client policies of the AP and the reason codes.",
    ),
    "deauth_campaign": (
        "it",
        "Do not replace devices. This does not help. IT knows about the problem: the controller disconnects "
        "devices on a fixed timer.",
        "Find and stop the controller job or the client policy that sends the disconnect frames. 802.11w does "
        "not help, because the APs send these frames themselves (the sequence counter and the signal agree with "
        "the AP).",
    ),
    "deauth_flood": (
        "security",
        "Do not touch equipment. The security team has the alert.",
        "If the finding says that the frames are forged, find the transmitter with the closest sensor and "
        "enable 802.11w. If the AP sent the frames itself, check the policies of the AP.",
    ),
    "ping_pong_roaming": (
        "report",
        "Does it always occur at the same position? Report the position. IT must adjust the APs there.",
        "Adjust the roaming thresholds or 802.11k/v/r. Adjust the AP transmit power.",
    ),
    "excessive_roaming": (
        "report",
        "Report the position where it occurs.",
        "Adjust the roaming thresholds. Check where the cells overlap.",
    ),
    "ap_silent": (
        "it",
        "IT knows about the problem. Monitor the stations near this AP.",
        "Check the power supply (PoE) and the uplink of the AP. Look in the controller logs for a restart.",
    ),
    "sensor_blind_spot": (
        "it",
        "No action on the line.",
        "Check the position or the antenna of the sensor.",
    ),
    "congestion": (
        "it",
        "Write down when it occurs (for example: each time robot X operates). IT knows about the problem.",
        "Make a new channel plan, use band steering or add an AP.",
    ),
    "rogue_ap": (
        "security",
        "Do not touch equipment. The security team has the alert.",
        "Find the rogue transmitter and remove it.",
    ),
    "transient_network": (
        "none",
        "No action.",
        "Make sure that this network is expected.",
    ),
    "association_wave": (
        "none",
        "No action if it was a planned restart.",
        "Make sure that the restart was planned.",
    ),
    "controller_stall": (
        "it",
        "No action on the line. IT knows about the problem (early warning).",
        "Check the CPU load and the logs of the controller. Plan a firmware update.",
    ),
    "device_vanished": (
        "you",
        "Find the device. Possibly a person switched it off. Check the battery or the power supply. If the "
        "device stays silent, replace it.",
        "Check the device inventory and the charging stations.",
    ),
    "rf_interference": (
        "report",
        "A source that is not Wi-Fi disturbs the radio near this sensor. A new device does not help. "
        "Tell IT which equipment operated there at that time (welding, a new machine, a microwave oven, a radio link) and where.",
        "Do a spectrum scan around the sensor on this channel at that time. Look for energy that is not 802.11: "
        "radar on DFS channels, video links, point-to-point links, arc welding, drives. Move critical APs to a "
        "different channel until the source is removed or shielded.",
    ),
    "sensor_clock": (
        "it",
        "No action on the line.",
        "Repair the time synchronisation (NTP or PTP) on the sensors in the list. Set an alarm for a sensor "
        "clock that drifts more than 5 ppm.",
    ),
    "signoff_wave": (
        "none",
        "No action if it was a planned restart.",
        "Make sure that the restart, the update or the failover was planned.",
    ),
    "weak_security": (
        "security",
        "No action on the line. The security team knows about the problem.",
        "Change the network to WPA3-SAE, or to 802.1X with credentials for each device. Make 802.11w mandatory.",
    ),
    "recurring_pattern": (
        "report",
        "This occurs again at the same time on different days. Write down what happens at that time "
        "(a break, a shift change, a machine cycle). Tell IT.",
        "Compare the time slot with the shift plans and the machine and server schedules. The cause follows a timetable.",
    ),
}

WHO_LABEL = {
    "you": "You can repair this",
    "it": "IT repairs this. IT knows about the problem",
    "security": "Security incident. The security team has the alert",
    "report": "Report the position",
    "none": "No action",
}


def scope(f: dict) -> str:
    if f.get("type") in ("sensor_clock", "weak_security"):  # the sensor fleet / a whole network, not devices
        return "site"
    aff = f.get("affected") or []
    aps = {
        a.get("bssid") or a.get("ap") for a in aff if (a.get("bssid") or a.get("ap"))
    }
    n = len(aff) or (1 if f.get("client") else 0)
    if n <= 1:
        return (
            "one device"
            if f.get("client") or n == 1
            else ("one AP" if f.get("bssid") else "site")
        )
    if not aps:
        return "many devices"
    if len(aps) == 1:
        return "many devices, one AP"
    return "many devices, many APs"


def network_of(f: dict, ssid_by_bssid: dict[str, str]) -> set[str]:
    bssids = {f.get("bssid")} | {
        a.get("bssid") or a.get("ap") for a in (f.get("affected") or [])
    }
    return {ssid_by_bssid[b] for b in bssids if b and b in ssid_by_bssid}


def confidence(f: dict) -> dict:
    """How sure are we, and why - based on what the sensors actually saw."""
    sensors = len(f.get("sensors") or [])
    evidence = sum(len(e.get("frames") or []) for e in (f.get("evidence") or []))
    devices = sum(1 for a in f.get("affected") or [] if a.get("client")) or (1 if f.get("client") else 0)
    reasons = []
    if sensors >= 2:
        # one sensor per channel: this is the same pattern on several channels, not the same frame heard twice
        reasons.append(f"same pattern on {sensors} sensors at once")
    elif sensors == 1:
        reasons.append("only one sensor saw it")
    if evidence:
        reasons.append(f"{evidence} evidence frames. You can check them again in the pcaps")
    if devices >= 3:
        reasons.append(f"same pattern on {devices} devices")
    if f["type"] == "stuck_scanning":
        reasons.append("no authentication attempt although the APs answer the scans")
    if f["type"] == "deauth_campaign" and f.get("origin"):
        o = f["origin"]
        reasons.append(f"{o['seq_fit'] * 100:.0f} % of frames continue the AP's own sequence counter")
    if f["type"] in ("association_wave", "transient_network"):
        level = "medium"
    elif (sensors >= 2 or devices >= 3) and evidence >= 3:
        level = "high"
    elif evidence >= 1:
        level = "medium"
    else:
        level = "low"
    return {"level": level, "reasons": reasons}


# ---------------------------------------------------------------- Wireshark display filters

_SUBTYPE_CODE = {name: code for code, name in SUBTYPE.items()}
# problems bound to a moment get a time window; clocks of the sensors differ by up to ~1.2 s
_TIMED = {"ap_silent", "sensor_blind_spot", "congestion", "rf_interference", "association_wave", "controller_stall", "signoff_wave"}
_TIME_MARGIN_S = 3.0


def _subtypes(*kinds: str) -> str:
    codes = sorted({_SUBTYPE_CODE[k] for k in kinds if k in _SUBTYPE_CODE})
    return _one_or_set("wlan.fc.type_subtype", [f"0x{c:04x}" for c in codes])


def _one_or_set(field: str, values) -> str:
    vals = sorted({str(v) for v in values if v is not None and v == v})
    if not vals:
        return ""
    return f"{field} == {vals[0]}" if len(vals) == 1 else f"{field} in {{{', '.join(vals)}}}"


def _and(*parts: str) -> str:
    parts = [p for p in parts if p]
    return " && ".join(f"({p})" if "||" in p and len(parts) > 1 else p for p in parts)


def _base_filter(f: dict) -> str:
    t = f["type"]
    c, b, ch = f.get("client"), f.get("bssid"), f.get("channel")
    aff = f.get("affected") or []
    kinds = {e.get("kind") for e in f.get("evidence") or []}
    by_client = f"wlan.addr == {c}" if c else ""
    if t == "eap_failure":
        return _and(by_client, "eap.code == 4 || wlan.fc.type_subtype == 0x000c")
    if t == "handshake_failure":
        return _and(by_client, "eapol || wlan.fixed.reason_code == 15")
    if t == "deauth_by_ap":
        return _and(by_client, _subtypes("deauth", "disassoc"))
    if t == "assoc_rejected":
        return _and(by_client, _subtypes("auth", "assoc_resp", "reassoc_resp"), "wlan.fixed.status_code != 0")
    if t in ("ping_pong_roaming", "excessive_roaming"):
        return _and(by_client, _subtypes("reassoc_req", "reassoc_resp"))
    if t == "device_vanished":
        return by_client
    if t == "radius_outage":
        return "eap || (wlan.fc.type_subtype == 0x000c && wlan.fixed.reason_code == 23)"
    if t == "deauth_campaign":
        return _and(
            _subtypes(*(kinds & {"deauth", "disassoc"} or {"deauth", "disassoc"})),
            _one_or_set("wlan.ra", [a.get("client") for a in aff]),
            _one_or_set("wlan.fixed.reason_code", [int(a["reason"]) for a in aff if a.get("reason") is not None]),
        )
    if t == "deauth_flood":
        return _and(_subtypes("deauth", "disassoc"), f"wlan.ta == {b}" if b else "")
    if t == "stuck_scanning":
        macs = [a["client"] for a in aff if a.get("client")]
        if not macs:
            return _subtypes("probe_req")
        # devices heard directly (their probes) or only through the APs' replies to them
        return (
            f"({_and(_subtypes('probe_req'), _one_or_set('wlan.ta', macs))}) || "
            f"({_and(_subtypes('probe_resp'), _one_or_set('wlan.ra', macs))})"
        )
    if t in ("ap_silent", "sensor_blind_spot"):
        return _and(f"wlan.ta == {b}" if b else "", _subtypes("beacon"))
    if t == "congestion":
        return _and(f"wlan_radio.channel == {ch}" if ch else "", "wlan.fc.retry == 1 || " + _subtypes("rts", "cts"))
    if t in ("rogue_ap", "transient_network"):
        return f"wlan.bssid == {b}" if b else ""
    if t == "association_wave":
        return _and(_subtypes("assoc_resp", "reassoc_resp"), "wlan.fixed.status_code == 0")
    if t == "controller_stall":
        return _subtypes("beacon")
    if t == "sensor_clock":
        return _and(_subtypes("beacon"), "wlan.fixed.timestamp")
    if t == "signoff_wave":
        return _and(_subtypes("deauth", "disassoc"), "wlan.fixed.reason_code in {3, 8, 36}")
    if t == "weak_security":
        return _and(_subtypes("beacon"), "wlan.rsn.akms.type == 2", "wlan.rsn.capabilities.mfpc == 0")
    if ch:
        return f"wlan_radio.channel == {ch}"
    return f"wlan.bssid == {b}" if b else by_client


def wireshark_filter(f: dict, t0_epoch: float | None = None) -> str:
    """A tshark / Wireshark (4.x) display filter that shows the frames behind a finding in any sensor's pcap.

    Moment-bound problems get a frame.time_epoch window (with margin for the sensors' clock offsets).
    """
    t = f["type"]
    base = f.get("wireshark_filter") or _base_filter(f)
    if t in _TIMED and t0_epoch is not None:
        a, z = t0_epoch + f["t_start"] - _TIME_MARGIN_S, t0_epoch + f["t_end"] + _TIME_MARGIN_S
        base = _and(base, f"frame.time_epoch >= {a:.3f} && frame.time_epoch <= {z:.3f}")
    return base


def wireshark_absent_filter(f: dict) -> str | None:
    """Missing BSSIDs: a filter that must match NO frame in any pcap (proof that the network is off the air)."""
    exact, radios = [], []
    for m in f.get("missing_bssids") or []:
        mac = m.split(" ", 1)[0]
        if len(mac) == 17 and "x" not in mac:
            exact.append(mac)
        elif mac.endswith(":00:xx"):  # a whole radio: match every BSSID with its first four octets
            radios.append(f"wlan.bssid[0:4] == {mac[:11]}")
    parts = ([_one_or_set("wlan.bssid", exact)] if exact else []) + radios
    return " || ".join(parts) or None


def wireshark_frames(f: dict) -> dict[str, str]:
    """Exactly the evidence frames, per sensor pcap (frame numbers are per file)."""
    per: dict[str, set[int]] = {}
    for e in f.get("evidence") or []:
        for r in e.get("frames") or []:
            per.setdefault(r["sensor"], set()).add(int(r["frame"]))
    return {
        s: f"frame.number == {min(n)}" if len(n) == 1 else "frame.number in {" + ", ".join(map(str, sorted(n))) + "}"
        for s, n in sorted(per.items())
    }


def annotate(findings: list[dict], ssid_by_bssid: dict[str, str], t0_epoch: float | None = None) -> None:
    for f in findings:
        f["wireshark_filter"] = wireshark_filter(f, t0_epoch)
        f["wireshark_frames"] = wireshark_frames(f)
        absent = wireshark_absent_filter(f)
        if absent:
            f["wireshark_filter_absent"] = absent
        who, sup, it = PLAYBOOK.get(
            f["type"], ("it", "IT knows about the problem.", f.get("recommendation", ""))
        )
        # a kick campaign with forged frames is an attack, not a controller job
        if f["type"] == "deauth_campaign" and f.get("origin") and not f["origin"].get("sent_by_ap"):
            who, sup, it = PLAYBOOK["deauth_flood"]
        nets = network_of(f, ssid_by_bssid)
        # missing networks name their SSID, e.g. "00:0b:86:06:00:01 (TESLA-TOOLS, ch 149)"
        nets |= {m.split("(")[1].split(",")[0] for m in (f.get("missing_bssids") or []) if "(" in m and "," in m}
        on_tools = any(CRITICAL_SSID.search(n or "") for n in nets)
        if f["type"] in SECURITY_TYPES:
            urgency = "purple"
        elif on_tools or f.get("device_class") == "industrial":
            urgency = "red"
        elif f["severity"] in ("critical", "high"):
            urgency = "yellow"
        else:
            urgency = "grey"
        # a tools-network device that cannot work is line-critical
        if (
            on_tools
            and f["severity"] in ("high", "medium")
            and f["type"] not in ("association_wave", "transient_network")
        ):
            f["severity"] = "critical" if f["severity"] == "high" else "high"
        f["confidence"] = confidence(f)
        f["networks"] = sorted(nets)
        f["scope"] = scope(f)
        f["action"] = {
            "who": who,
            "label": WHO_LABEL[who],
            "supervisor": sup,
            "it": it,
            "urgency": urgency,
        }
