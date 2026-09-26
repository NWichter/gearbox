"""Regression test on Tesla's 8 captures: the full pipeline must still find exactly the 11 known findings.

Needs tshark and the real pcaps (not Git LFS pointers), so it runs in the backend image:
  tools/check.sh --tesla
Marked "tesla": the default pytest run skips it. Run it with: pytest -m tesla
"""

from __future__ import annotations

import shutil
import time
import uuid
from collections import Counter

import pytest
from conftest import tesla_captures

pytestmark = pytest.mark.tesla

CAPTURES = tesla_captures()
if CAPTURES is None:
    pytest.skip(
        "Tesla pcaps not found (Git LFS pointers or missing). Set TESLA_CAPTURES.",
        allow_module_level=True,
    )
if shutil.which("tshark") is None:
    pytest.skip(
        "tshark is not installed. Run the test in the backend image.",
        allow_module_level=True,
    )


@pytest.fixture(scope="module")
def run():
    from app.airframe.ingest import find_captures, read_all
    from app.airframe.pipeline import analyze_frames

    paths = find_captures(CAPTURES)
    t0 = time.perf_counter()
    raw = read_all(paths)
    result, _ = analyze_frames(raw, [p.name for p in paths], t0)
    return result, raw


@pytest.fixture(scope="module")
def findings(run):
    return run[0]["findings"]


def one(findings, typ, **match):
    got = [
        f
        for f in findings
        if f["type"] == typ and all(f.get(k) == v for k, v in match.items())
    ]
    assert len(got) == 1, (
        typ,
        match,
        [f["title"] for f in findings if f["type"] == typ],
    )
    return got[0]


def test_counts(run):
    s = run[0]["summary"]
    assert s["sensors"] == 8
    assert s["frames"] == 1_118_853
    assert s["radios_on_air"] == 29
    assert s["radios_expected"] == 30
    assert s["networks"] == 53
    assert (s["devices_total"], s["devices_connected"], s["devices_heard"]) == (
        99,
        87,
        60,
    )


def test_eleven_findings_of_the_expected_types(findings):
    assert len(findings) == 11
    assert Counter(f["type"] for f in findings) == {
        "radius_outage": 1,
        "stuck_scanning": 2,
        "deauth_campaign": 1,
        "weak_security": 1,
        "device_vanished": 1,
        "sensor_clock": 1,
        "controller_stall": 1,
        "signoff_wave": 1,
        "association_wave": 2,
    }


def test_radius_outage(findings):
    f = one(findings, "radius_outage")
    assert (
        f["title"]
        == "Devices cannot log in to TESLA-CORP. The login server does not answer (63 devices, 26 APs)"
    )
    assert len(f["affected"]) == 63
    assert f["severity"] == "critical"


def test_devices_cannot_connect_per_network(findings):
    by_net = {
        f["affected"][0]["network"]: f for f in findings if f["type"] == "stuck_scanning"
    }
    assert sorted(by_net) == ["TESLA-CORP", "TESLA-TOOLS"]
    corp, tools = by_net["TESLA-CORP"], by_net["TESLA-TOOLS"]
    assert (
        corp["title"]
        == "9 devices on TESLA-CORP cannot connect: their access point is off and they do not use another one"
    )
    assert (
        tools["title"]
        == "3 devices on TESLA-TOOLS cannot connect: their access point is off and they do not use another one"
    )
    assert (len(corp["affected"]), len(tools["affected"])) == (9, 3)
    assert tools["action"]["urgency"] == "red"
    assert any("TESLA-TOOLS" in m for m in tools["missing_bssids"])
    assert "0 of 87 connected devices used a second AP" in corp["detail"]


def test_kick_campaign_is_one_controller_job(findings):
    f = one(findings, "deauth_campaign")
    assert len(f["affected"]) == 18
    assert Counter(a["kind"] for a in f["affected"]) == {"deauth": 11, "disassoc": 7}
    assert (
        f["title"]
        == "18 devices kicked off Wi-Fi on a fixed timer by their own APs (controller job)"
    )
    o = f["origin"]
    assert o["sent_by_ap"] and o["frames"] == 1477 and o["seq_fit"] == 1.0
    # the devices the job skipped are exactly the ones that never joined
    assert "3c:58:c2:00:00:03, 3c:58:c2:00:00:0d, 3c:58:c2:00:00:10, 3c:58:c2:00:00:11" in f["detail"]
    assert "802.11w does not help" in f["action"]["it"]


def test_no_separate_ap_kick_finding(findings):
    """The 7 kicks to 3c:58:c2:00:00:12 carry the campaign's reason: they are part of the campaign."""
    assert not [f for f in findings if f["type"] == "deauth_by_ap"]
    assert "7 off-rhythm frames" in one(findings, "deauth_campaign")["detail"]


def test_weak_security(findings):
    f = one(findings, "weak_security")
    assert f["title"] == "TESLA-TOOLS uses one shared password and no management-frame protection"
    assert f["count"] == 27
    assert f["action"]["urgency"] == "purple"


def test_device_signed_off(findings):
    f = one(findings, "device_vanished", client="b8:27:eb:00:00:03")
    assert f["title"] == "A device disconnected itself and did not return"
    assert "reason 3" in f["detail"]


def test_sensor_clocks(findings):
    f = one(findings, "sensor_clock")
    assert f["title"] == "7 of 8 sensor clocks are off (up to -1.22 s) and drift (up to -25 ppm)"
    assert f["scope"] == "site"


def test_controller_stall(findings):
    f = one(findings, "controller_stall")
    assert round(f["t_start"] + 0.5) == 236
    assert f["count"] == 135
    assert f["title"].startswith("All access points paused at once (2 times within 14 s)")


def test_signoff_wave(findings):
    f = one(findings, "signoff_wave")
    assert f["title"] == "15 devices signed off within 5 s"


def test_join_waves(findings):
    waves = sorted(
        (f for f in findings if f["type"] == "association_wave"),
        key=lambda f: f["t_start"],
    )
    assert [f["count"] for f in waves] == [13, 66]
    assert waves[0]["title"] == "13 devices joined within 28 s"


def test_texts_follow_ste_no_semicolons(findings):
    for f in findings:
        for k in ("title", "detail", "recommendation"):
            assert ";" not in (f.get(k) or ""), (f["type"], k)
        assert ";" not in f["action"]["supervisor"] and ";" not in f["action"]["it"]


def test_every_evidence_frame_is_in_the_pcaps(findings):
    from verify_evidence import verify

    ok, bad, problems = verify(findings, CAPTURES, echo=lambda *_: None)
    assert bad == 0, problems[:5]
    assert ok == 77


def test_stream_finds_the_same_incidents(run):
    """The streaming prototype on the same frames: same incidents and affected counts.

    weak_security and sensor_clock are batch-only checks (stream.BATCH_ONLY): configuration and
    sensor-fleet findings without a time to alert.
    """
    from app.airframe import stream

    result, raw = run
    table = stream.prepare(raw)
    res = stream.run(table)
    alerts = [stream.describe(a, table) for a in res["alerts"]]
    rows = stream.compare([a for a in alerts if a["active_at_end"]], result["findings"])
    assert sorted(r["type"] for r in rows if r["batch_only"]) == sorted(stream.BATCH_ONLY)
    rows = [r for r in rows if not r["batch_only"]]
    missing = [
        r for r in rows if r["stream_affected"] is None or r["batch_affected"] is None
    ]
    assert not missing, missing
    for r in rows:
        if (
            r["type"] == "controller_stall"
        ):  # rolling 60-s baseline vs whole-capture median: +-2 beacons
            assert abs(r["stream_affected"] - r["batch_affected"]) <= 2, r
        else:
            assert r["same"], r
    assert not [a for a in alerts if not a["active_at_end"]], (
        "no retracted (false) alerts"
    )


def test_analysis_in_child_process_keeps_api_responsive(run, tmp_path_factory):
    """Run a real analysis through the API runner and measure /health while it runs."""
    from fastapi.testclient import TestClient

    from app import main, worker
    from app.db import Dataset, SessionLocal

    with TestClient(main.app) as client:
        ds_id = uuid.uuid4().hex[:12]
        folder = worker.dataset_dir(ds_id)
        folder.mkdir(parents=True)
        for p in sorted(CAPTURES.glob("sensor0*.pcap*")):
            (folder / p.name).symlink_to(p.resolve())
        with SessionLocal() as s:
            s.add(Dataset(id=ds_id, name="tesla", status="done"))
            s.commit()
        assert client.post(f"/datasets/{ds_id}/reanalyze").status_code == 200
        assert (
            client.post(f"/datasets/{ds_id}/reanalyze").status_code == 409
        )  # no second run
        lat = []
        deadline = time.monotonic() + 900
        while time.monotonic() < deadline:
            t0 = time.perf_counter()
            assert client.get("/health").status_code == 200
            lat.append(time.perf_counter() - t0)
            status = client.get(f"/datasets/{ds_id}").json()["status"]
            if status in ("done", "failed"):
                break
            time.sleep(0.25)
        assert status == "done"
        lat.sort()
        p99 = lat[int(0.99 * (len(lat) - 1))]
        print(
            f"/health during the analysis: {len(lat)} calls, median {lat[len(lat) // 2] * 1000:.1f} ms, p99 {p99 * 1000:.1f} ms, max {lat[-1] * 1000:.1f} ms"
        )
        assert p99 < 0.5 and lat[-1] < 2.0
        body = client.get(f"/datasets/{ds_id}").json()
        assert body["result"]["summary"]["findings"] == 11
        seq = client.get(f"/datasets/{ds_id}/clients/b8:27:eb:00:00:03")
        assert seq.status_code == 200 and len(seq.json()["events"]) > 0
