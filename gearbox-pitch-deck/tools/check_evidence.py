"""Second parser without tshark: re-read every evidence frame of the live result from the pcaps.

The backend reads the captures with tshark. This script reads the same pcap files with the Python
standard library only (pcap record header -> radiotap length -> 802.11 frame control) and checks,
for every evidence frame of every finding (sensor + frame number), that the frame type matches the
finding and, for deauth / disassoc frames, that the reason code matches too.

Usage (from the repo root; the captures are private and git-ignored):
  python airframe-pitch-film/pitch-v3/source/check_evidence.py [internal/briefing/captures]
         [--base https://bmt26.skimu.de] [--dataset ff1d9f54dee9]

Writes {"checked", "matched", "parser"} into airframe-film-data.json -> live.evidence and exits 1
on any mismatch. The trust scene shows these two numbers.
"""

from __future__ import annotations

import argparse
import gzip
import json
import re
import struct
import sys
import urllib.request
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).parent
DATA = HERE / "airframe-film-data.json"
KIND = {
    0x00: "assoc_req", 0x01: "assoc_resp", 0x02: "reassoc_req", 0x03: "reassoc_resp",
    0x04: "probe_req", 0x05: "probe_resp", 0x08: "beacon", 0x0A: "disassoc", 0x0B: "auth",
    0x0C: "deauth", 0x0D: "action", 0x18: "block_ack_req", 0x19: "block_ack", 0x1B: "rts",
    0x1C: "cts", 0x1D: "ack", 0x20: "data", 0x28: "qos_data", 0x24: "null", 0x2C: "qos_null",
}


def read_frames(pcap: Path, wanted: set[int]) -> dict[int, dict]:
    """Frame number (1-based, as in Wireshark) -> {kind, reason} for the wanted frames."""
    opener = gzip.open if pcap.suffix == ".gz" else open
    out: dict[int, dict] = {}
    last = max(wanted)
    with opener(pcap, "rb") as fh:
        head = fh.read(24)
        magic = head[:4]
        endian = "<" if magic in (b"\xd4\xc3\xb2\xa1", b"\x4d\x3c\xb2\xa1") else ">"
        n = 0
        while n < last:
            rec = fh.read(16)
            if len(rec) < 16:
                break
            _, _, incl, _ = struct.unpack(endian + "IIII", rec)
            buf = fh.read(incl)
            n += 1
            if n not in wanted:
                continue
            rt_len = struct.unpack_from("<H", buf, 2)[0]  # radiotap is always little-endian
            fc = buf[rt_len]
            sub = ((fc >> 2) & 3) << 4 | (fc >> 4) & 0xF
            kind = KIND.get(sub, hex(sub))
            reason = None
            if kind in ("deauth", "disassoc") and len(buf) >= rt_len + 26:
                reason = struct.unpack_from("<H", buf, rt_len + 24)[0]
            out[n] = {"kind": kind, "reason": reason}
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("captures", nargs="?", default="internal/briefing/captures")
    ap.add_argument("--base", default="https://bmt26.skimu.de")
    ap.add_argument("--dataset", default="ff1d9f54dee9")
    a = ap.parse_args()
    with urllib.request.urlopen(f"{a.base}/api/datasets/{a.dataset}", timeout=30) as r:
        result = json.load(r)["result"]

    wanted: dict[str, set[int]] = defaultdict(set)
    for f in result["findings"]:
        for e in f.get("evidence") or []:
            for fr in e.get("frames") or []:
                wanted[fr["sensor"]].add(int(fr["frame"]))
    frames = {}
    for sensor, nums in sorted(wanted.items()):
        pcap = next(iter(sorted(Path(a.captures).glob(f"{sensor}.pcap*"))), None)
        if not pcap:
            sys.exit(f"no capture for {sensor} in {a.captures}")
        frames.update({(sensor, n): v for n, v in read_frames(pcap, nums).items()})

    ok = bad = 0
    for f in result["findings"]:
        for e in f.get("evidence") or []:
            m = re.search(r"reason (\d+)", e.get("what") or "")
            for fr in e.get("frames") or []:
                real = frames.get((fr["sensor"], int(fr["frame"])))
                good = bool(real) and real["kind"] == e["kind"]
                if good and m and real["reason"] is not None:
                    good = int(m.group(1)) == real["reason"]
                ok += good
                bad += not good
                if not good:
                    print(f"mismatch #{f['id']}: {fr['sensor']}#{fr['frame']} claims {e['kind']} {e.get('what')}, pcap has {real}")
    print(f"{ok} of {ok + bad} evidence frames match (stdlib parser, no tshark)")
    data = json.loads(DATA.read_text(encoding="utf-8"))
    data.setdefault("live", {})["evidence"] = {"checked": ok + bad, "matched": ok, "parser": "Python stdlib, no tshark"}
    DATA.write_text(json.dumps(data, separators=(", ", ": ")), encoding="utf-8")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
