"""Shift report: one page for the supervisor. It shows what can stop the line, what to do and what IT does."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

URGENCY_ORDER = {"red": 0, "purple": 1, "yellow": 2, "grey": 3}
WHO_ORDER = {"you": 0, "security": 1, "it": 2, "report": 3, "none": 4}


def _clock(start_epoch: float | None, t: float) -> str:
    if not start_epoch:
        return f"{int(t // 60)}:{int(t % 60):02d}"
    return datetime.fromtimestamp(start_epoch + t, tz=timezone.utc).strftime(
        "%H:%M UTC"
    )


def _affected(f: dict) -> int:
    return len(f.get("affected") or []) or (1 if f.get("client") else 0)


def build(result: dict, name: str) -> dict:
    s = result["summary"]
    start = s.get("start_epoch")
    findings = [f for f in result["findings"] if f.get("action")]
    findings.sort(
        key=lambda f: (
            URGENCY_ORDER.get(f["action"]["urgency"], 9),
            WHO_ORDER.get(f["action"]["who"], 9),
            f["t_start"],
        )
    )

    def item(f: dict) -> dict:
        return {
            "id": f["id"],
            "title": f["title"],
            "severity": f["severity"],
            "urgency": f["action"]["urgency"],
            "who": f["action"]["who"],
            "who_label": f["action"]["label"],
            "do": f["action"]["supervisor"],
            "it": f["action"]["it"],
            "since": _clock(start, f["t_start"]),
            "until": _clock(start, f["t_end"]),
            "affected": _affected(f),
            "networks": f.get("networks") or [],
            "scope": f.get("scope"),
            "confidence": (f.get("confidence") or {}).get("level"),
        }

    items = [item(f) for f in findings if f["severity"] != "info"]
    info = [item(f) for f in findings if f["severity"] == "info"]
    line_risk = [i for i in items if i["urgency"] == "red"]
    yours = [i for i in items if i["who"] == "you"]
    it = [i for i in items if i["who"] in ("it", "report")]
    security = [i for i in items if i["who"] == "security"]
    window = None
    if start:
        a = datetime.fromtimestamp(start, tz=timezone.utc)
        b = a + timedelta(seconds=s.get("duration_s") or 0)
        window = f"{a:%d %b %Y, %H:%M}–{b:%H:%M} UTC"

    if line_risk:
        headline = f"{len(line_risk)} problem{'s' if len(line_risk) > 1 else ''} can stop the line"
    elif items:
        headline = "The line can continue. The problems are only on the office network"
    else:
        headline = "The sensors found no problems on the air"

    return {
        "dataset": name,
        "window": window,
        "headline": headline,
        "counts": {
            "line_risk": len(line_risk),
            "yours": len(yours),
            "it": len(it),
            "security": len(security),
            "devices_affected": sum(i["affected"] for i in items),
        },
        "coverage": {
            "sensors": s.get("sensors"),
            "access_points": s.get("radios_on_air") or s.get("aps"),
            "access_points_planned": s.get("radios_expected"),
            "devices": s.get("devices_total") or s.get("clients"),
            "frames": s.get("frames"),
        },
        "line_risk": line_risk,
        "yours": yours,
        "it": it,
        "security": security,
        "info": info,
    }


def markdown(r: dict) -> str:
    out = ["# Gearbox shift report", "", f"**{r['headline']}**", ""]
    if r["window"]:
        out.append(f"Shift window: {r['window']} · data: {r['dataset']}")
    c = r["coverage"]
    out += [
        f"Monitored: {c['sensors']} sensors, {c['access_points']} access points"
        + (
            f" ({c['access_points_planned']} planned)"
            if c.get("access_points_planned")
            else ""
        )
        + f", {c['devices']} devices, {c['frames']:,} frames.",
        "",
    ]

    def section(title: str, items: list[dict], field: str) -> None:
        if not items:
            return
        out.append(f"## {title}")
        out.append("")
        for i in items:
            nets = f" · {', '.join(i['networks'])}" if i["networks"] else ""
            out.append(
                f"- **{i['title']}** ({i['affected']} device{'s' if i['affected'] != 1 else ''}{nets}, since {i['since']})"
            )
            out.append(f"  - {i[field]}")
        out.append("")

    section("Can stop the line (tools network)", r["line_risk"], "do")
    section("Your actions", [i for i in r["yours"] if i not in r["line_risk"]], "do")
    section("Security", r["security"], "do")
    section("For IT", [i for i in r["it"] if i not in r["line_risk"]], "it")
    if r["info"]:
        out.append("## For information")
        out.append("")
        out += [f"- {i['title']}" for i in r["info"]]
        out.append("")
    out.append(
        "_Gearbox made this report from header-only Wi-Fi captures. The dashboard shows the evidence for each item._"
    )
    return "\n".join(out)
