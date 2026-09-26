"""Streaming detectors on small in-memory frame tables built in the test."""

import numpy as np
import pandas as pd

from app.airframe import stream

AP1, AP2 = "00:0b:86:01:00:00", "00:0b:86:02:00:00"
BC = "ff:ff:ff:ff:ff:ff"


def row(ts, kind, ta, ra, bssid, sensor="sensor01", **kw) -> dict:
    return {
        "ts": 1_000_000.0 + ts, "kind": kind, "ta": ta, "ra": ra, "bssid": bssid, "sensor": sensor,
        "tsf": np.nan, "seq": kw.get("seq", np.nan), "retry": 0.0, "reason": kw.get("reason", np.nan),
        "status": kw.get("status", np.nan), "eap_code": kw.get("eap_code", np.nan),
        "eap_type": kw.get("eap_type", np.nan), "frame": kw.get("frame", 1),
    }  # fmt: skip


def beacons(seconds: float, sensor="sensor01", ap=AP1) -> list[dict]:
    return [
        row(t, "beacon", ap, BC, ap, sensor, seq=i % 4096)
        | {"tsf": (1_000_000.0 + t - 0.002) * 1e6}
        for i, t in enumerate(np.arange(0, seconds, 0.1))
    ]


def alerts(rows: list[dict]) -> list[dict]:
    raw = pd.DataFrame(rows).sort_values("ts").reset_index(drop=True)
    raw["frame"] = np.arange(1, len(raw) + 1)
    t = stream.prepare(raw)
    res = stream.run(t)
    return [stream.describe(a, t) for a in res["alerts"]]


def test_route_keys_put_a_client_exchange_in_one_partition():
    ta = np.array([1, 2, 1, -1, 1])  # 1 = AP, 2 = client, 9 = broadcast
    ra = np.array([2, 1, 9, 2, 9])
    bssid = np.array([1, 1, 1, -1, 1])
    assert stream.route_keys(ta, ra, bssid, bc=9).tolist() == [2, 2, 1, 2, 1]


def test_regular_matches_numpy_percentiles():
    ts = [0, 15, 30, 45.2, 60, 75, 90.1, 105]
    iv = np.diff(ts)
    spread = (np.percentile(iv, 90) - np.percentile(iv, 10)) / np.median(iv)
    assert stream._regular(ts) == (bool(spread <= 0.02), float(np.median(iv)))
    assert stream._regular([0, 10, 20, 30, 40])[0] is True
    assert stream._regular([0, 10, 20])[0] is False  # < 4 frames


def test_periodic_with_gaps():
    assert stream._periodic_with_gaps(
        [0, 56, 84, 112]
    )  # one lost frame of a 28-s timer
    assert not stream._periodic_with_gaps([0, 10, 27, 31])


def test_deauth_campaign_time_to_alert():
    rows = beacons(120)
    client = "3c:58:c2:00:00:01"
    rows += [
        row(10 + 15 * i, "deauth", AP1, client, AP1, seq=100 + i, reason=2)
        for i in range(6)
    ]
    got = [a for a in alerts(rows) if a["type"] == "deauth_campaign"]
    assert len(got) == 1
    a = got[0]
    assert a["affected"] == 1
    # the 4th frame at t=55 s proves the period, the window closes at 60 s
    assert abs(a["evidence_t"] - 10) < 0.1
    assert abs(a["alert_t"] - 60) < 0.1
    assert abs(a["time_to_alert_s"] - 50) < 0.2


def test_retransmission_does_not_break_a_campaign():
    rows = beacons(120)
    client = "3c:58:c2:00:00:01"
    rows += [
        row(10 + 15 * i, "disassoc", AP1, client, AP1, seq=200 + i, reason=2)
        for i in range(6)
    ]
    rows.append(
        row(55.001, "disassoc", AP1, client, AP1, seq=203, reason=2)
    )  # same frame again
    got = [a for a in alerts(rows) if a["type"] == "deauth_campaign"]
    assert len(got) == 1 and abs(got[0]["alert_t"] - 60) < 0.1


def test_radius_outage_needs_two_clients():
    rows = beacons(60)
    for n, c in enumerate(["3c:58:c2:00:00:01", "3c:58:c2:00:00:02"]):
        base = 5 + 10 * n
        rows += [
            row(base, "qos_data", AP1, c, AP1, eap_code=1, eap_type=1),
            row(base + 1, "qos_data", AP1, c, AP1, eap_code=1, eap_type=1),
            row(base + 2, "deauth", AP1, c, AP1, reason=23),
        ]
    got = [a for a in alerts(rows) if a["type"] == "radius_outage"]
    assert len(got) == 1
    assert got[0]["affected"] == 2
    assert (
        got[0]["alert_t"] == 20.0
    )  # the second client qualifies at t=17, its window closes at 20 s


def test_one_failing_client_is_no_radius_incident():
    rows = beacons(60)
    c = "3c:58:c2:00:00:01"
    rows += [
        row(5, "qos_data", AP1, c, AP1, eap_code=1, eap_type=1),
        row(6, "qos_data", AP1, c, AP1, eap_code=1, eap_type=1),
        row(7, "deauth", AP1, c, AP1, reason=23),
    ]
    assert not [a for a in alerts(rows) if a["type"] == "radius_outage"]


def test_partition_state_is_small():
    rows = beacons(60)
    raw = pd.DataFrame(rows)
    res = stream.run(stream.prepare(raw))
    assert res["state_kb"] < 50
    assert res["frames"] == len(rows)
