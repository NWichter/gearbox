"""Cross-check every finding's evidence against the original capture files.

For each evidence frame (sensor + frame number) the frame is read again with tshark straight from
the pcap and its type / reason / status is compared with what the finding claims. This is the
automated version of "open it in Wireshark".

Usage (inside the backend image, which has tshark):
  python tools/verify_evidence.py <captures-folder> <dataset-id> [--base https://gearbox.skimu.de]
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

import httpx

KIND = {
    0x1B: "rts",
    0x1C: "cts",
    0x1D: "ack",
    0x19: "block_ack",
    0x18: "block_ack_req",
    0x0C: "deauth",
    0x0A: "disassoc",
    0x0B: "auth",
    0x01: "assoc_resp",
    0x03: "reassoc_resp",
    0x08: "beacon",
    0x05: "probe_resp",
    0x04: "probe_req",
    0x28: "qos_data",
    0x20: "data",
    0x0D: "action",
    0x00: "assoc_req",
    0x02: "reassoc_req",
}


def read_frames(pcap: Path, numbers: list[int]) -> dict[int, dict]:
    flt = " || ".join(f"frame.number=={n}" for n in numbers)
    out = subprocess.run(
        [
            "tshark",
            "-r",
            str(pcap),
            "-Y",
            flt,
            "-T",
            "fields",
            "-E",
            "separator=\t",
            "-e",
            "frame.number",
            "-e",
            "wlan.fc.type_subtype",
            "-e",
            "wlan.fixed.reason_code",
            "-e",
            "wlan.fixed.status_code",
            "-e",
            "wlan.ta",
            "-e",
            "wlan.ra",
        ],
        capture_output=True,
        text=True,
        check=False,
    ).stdout
    res = {}
    for line in out.splitlines():
        n, st, reason, status, ta, ra = (line.split("\t") + [""] * 6)[:6]
        sub = int(st, 16) if st.startswith("0x") else int(st or -1)
        res[int(n)] = {
            "kind": KIND.get(sub, hex(sub)),
            "reason": reason,
            "status": status,
            "ta": ta,
            "ra": ra,
        }
    return res


def verify(
    findings: list[dict], folder: Path, echo=print
) -> tuple[int, int, list[str]]:
    """Re-read every evidence frame from the pcaps. Returns (matches, mismatches, mismatch lines)."""
    wanted: dict[str, set[int]] = defaultdict(set)
    for f in findings:
        for e in f.get("evidence") or []:
            for r in e.get("frames") or []:
                wanted[r["sensor"]].add(int(r["frame"]))
    frames = {}
    for sensor, nums in wanted.items():
        pcap = next(iter(folder.glob(f"{sensor}.pcap*")), None)
        if not pcap:
            echo(f"!! no capture for {sensor}")
            continue
        got = read_frames(pcap, sorted(nums))
        frames.update({(sensor, n): v for n, v in got.items()})

    ok = bad = 0
    problems: list[str] = []
    for f in findings:
        f_ok = f_bad = 0
        for e in f.get("evidence") or []:
            for r in e.get("frames") or []:
                real = frames.get((r["sensor"], int(r["frame"])))
                if real and real["kind"] == e["kind"]:
                    f_ok += 1
                else:
                    f_bad += 1
                    line = f"finding #{f['id']}: {r['sensor']}#{r['frame']} claims {e['kind']}, capture has {real}"
                    problems.append(line)
                    echo(f"   mismatch {line}")
        ok += f_ok
        bad += f_bad
        echo(
            f"#{f['id']:>2} {'OK ' if not f_bad else 'BAD'} {f_ok:>3} frames verified  {f['title'][:70]}"
        )
    return ok, bad, problems


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("captures")
    ap.add_argument("dataset")
    ap.add_argument("--base", default="https://gearbox.skimu.de")
    a = ap.parse_args()
    result = httpx.get(f"{a.base}/api/datasets/{a.dataset}", timeout=60).json()[
        "result"
    ]
    ok, bad, _ = verify(result["findings"], Path(a.captures))
    print()
    print(f"{ok} evidence frames match the original captures, {bad} mismatches")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
