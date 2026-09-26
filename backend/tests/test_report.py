"""Shift report: order, counts and the Markdown text."""

from conftest import finding

from app.airframe import playbook, report


def result(findings: list[dict]) -> dict:
    playbook.annotate(
        findings,
        {"00:0b:86:06:00:01": "TESLA-TOOLS", "00:0b:86:01:00:00": "TESLA-CORP"},
    )
    return {
        "summary": {
            "start_epoch": 1789561451.5,
            "duration_s": 1800,
            "sensors": 8,
            "radios_on_air": 29,
            "radios_expected": 30,
            "devices_total": 99,
            "frames": 1118853,
        },
        "findings": findings,
    }


def test_line_risk_first_and_counts():
    fs = [
        finding(id=1, bssid="00:0b:86:01:00:00", t_start=5.0),
        finding(
            id=2, bssid="00:0b:86:06:00:01", t_start=50.0, client="b8:27:eb:00:00:03"
        ),
        finding(
            id=3,
            type="association_wave",
            severity="info",
            client=None,
            bssid=None,
            title="13 devices joined within 28 s",
        ),
    ]
    r = report.build(result(fs), "Tesla")
    assert r["headline"] == "1 problem can stop the line"
    assert [i["id"] for i in r["line_risk"]] == [2]
    assert r["counts"]["line_risk"] == 1
    assert r["counts"]["yours"] == 2
    assert [i["id"] for i in r["info"]] == [3]
    assert r["window"] == "16 Sep 2026, 12:24–12:54 UTC"
    assert r["line_risk"][0]["since"] == "12:25 UTC"


def test_markdown_sections_and_no_semicolons():
    fs = [
        finding(id=1, bssid="00:0b:86:06:00:01"),
        finding(id=2, type="radius_outage", client=None, severity="critical"),
    ]
    md = report.markdown(report.build(result(fs), "Tesla"))
    assert md.startswith("# Gearbox shift report")
    assert "## Can stop the line (tools network)" in md
    assert "## For IT" in md
    assert (
        "Monitored: 8 sensors, 29 access points (30 planned), 99 devices, 1,118,853 frames."
        in md
    )
    prose = "\n".join(line for line in md.splitlines() if not line.startswith("- **"))
    assert ";" not in prose


def test_empty_result():
    r = report.build(result([]), "empty")
    assert r["headline"] == "The sensors found no problems on the air"
    assert r["counts"]["devices_affected"] == 0
