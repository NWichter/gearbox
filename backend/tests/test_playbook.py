"""Playbook: who acts, urgency, scope, confidence and the Wireshark filters of a finding."""

from conftest import finding

from app.airframe import playbook

SSIDS = {"00:0b:86:01:00:00": "TESLA-CORP", "00:0b:86:06:00:01": "TESLA-TOOLS"}


def annotated(**kw) -> dict:
    f = finding(**kw)
    playbook.annotate([f], SSIDS, t0_epoch=1_000_000.0)
    return f


def test_every_type_has_a_complete_playbook_entry():
    for typ, (who, sup, it) in playbook.PLAYBOOK.items():
        assert who in playbook.WHO_LABEL, typ
        assert sup and it, typ
        # STE style: no semicolons in the texts for the supervisor and IT
        assert ";" not in sup and ";" not in it, typ


def test_corp_network_device_is_yellow_and_yours():
    f = annotated()
    assert f["action"]["who"] == "you"
    assert f["action"]["urgency"] == "yellow"
    assert f["networks"] == ["TESLA-CORP"]
    assert f["scope"] == "one device"


def test_tools_network_is_red_and_raises_severity():
    f = annotated(bssid="00:0b:86:06:00:01", severity="high")
    assert f["action"]["urgency"] == "red"
    assert f["severity"] == "critical"


def test_security_types_are_purple():
    f = annotated(type="deauth_flood", client=None, bssid="aa:bb:cc:dd:ee:ff")
    assert f["action"]["urgency"] == "purple"
    assert f["action"]["who"] == "security"


def test_scope_many_devices_many_aps():
    aff = [{"client": f"c{i}", "bssid": f"b{i % 3}"} for i in range(6)]
    assert playbook.scope({"affected": aff}) == "many devices, many APs"
    one_ap = [{"client": "a", "bssid": "x"}, {"client": "b", "bssid": "x"}]
    assert playbook.scope({"affected": one_ap}) == "many devices, one AP"
    assert playbook.scope({"client": "a"}) == "one device"


def test_confidence_levels():
    assert annotated()["confidence"]["level"] == "high"  # 2 sensors, 3 evidence frames
    low = annotated(sensors=[], evidence=[])
    assert low["confidence"]["level"] == "low"


def test_wireshark_filter_per_client():
    f = annotated()
    assert (
        f["wireshark_filter"]
        == "wlan.addr == 3c:58:c2:00:00:01 && (eap.code == 4 || wlan.fc.type_subtype == 0x000c)"
    )


def test_wireshark_filter_campaign_lists_targets_and_reason():
    aff = [
        {"client": "3c:58:c2:00:00:01", "reason": 2, "ap": "00:0b:86:01:00:00"},
        {"client": "3c:58:c2:00:00:02", "reason": 2, "ap": "00:0b:86:02:00:00"},
    ]
    ev = [{"t": 1.0, "what": "x", "kind": "deauth", "frames": []}]
    f = annotated(
        type="deauth_campaign", client=None, bssid=None, affected=aff, evidence=ev
    )
    assert f["wireshark_filter"] == (
        "wlan.fc.type_subtype == 0x000c && wlan.ra in {3c:58:c2:00:00:01, 3c:58:c2:00:00:02} "
        "&& wlan.fixed.reason_code == 2"
    )


def test_wireshark_filter_timed_types_get_a_time_window():
    f = annotated(
        type="controller_stall", client=None, bssid=None, t_start=235.5, t_end=236.5
    )
    assert f["wireshark_filter"] == (
        "wlan.fc.type_subtype == 0x0008 && frame.time_epoch >= 1000232.500 && frame.time_epoch <= 1000239.500"
    )


def test_wireshark_frames_per_sensor():
    f = annotated()
    assert f["wireshark_frames"] == {
        "sensor01": "frame.number in {5, 9}",
        "sensor02": "frame.number == 3",
    }


def test_absent_filter_for_missing_networks():
    f = annotated(
        type="stuck_scanning",
        client=None,
        bssid=None,
        missing_bssids=[
            "00:0b:86:06:00:01 (TESLA-TOOLS, ch 149)",
            "00:0b:86:10:00:xx (whole radio silent)",
        ],
    )
    assert (
        f["wireshark_filter_absent"]
        == "wlan.bssid == 00:0b:86:06:00:01 || wlan.bssid[0:4] == 00:0b:86:10"
    )
    # a missing network on the tools SSID makes the finding line-critical
    assert f["action"]["urgency"] == "red"
