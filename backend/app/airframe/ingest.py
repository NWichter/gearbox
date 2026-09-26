"""Stage 1 - ingest: one capture per sensor -> normalized frame table.

Stateless and independent per file: at scale this stage runs on the sensor
itself or as one worker per sensor partition.
"""

from __future__ import annotations

import io
import shutil
import subprocess
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from pathlib import Path

import pandas as pd

FIELDS = {
    "frame.number": "frame",
    "frame.time_epoch": "ts",
    "wlan_radio.channel": "channel",
    "wlan_radio.frequency": "freq",
    "wlan_radio.signal_dbm": "rssi",
    # radiotap: noise floor the sensor measured for this frame, and the PHY rate it was sent at
    "wlan_radio.noise_dbm": "noise",
    "wlan_radio.data_rate": "rate",
    "wlan.fc.type_subtype": "subtype",
    "wlan.fixed.timestamp": "tsf",
    "wlan.fc.retry": "retry",
    "wlan.fc.ds": "ds",
    "wlan.ta": "ta",
    "wlan.ra": "ra",
    "wlan.sa": "sa",
    "wlan.da": "da",
    "wlan.bssid": "bssid",
    "wlan.seq": "seq",
    "wlan.fixed.reason_code": "reason",
    "wlan.fixed.status_code": "status",
    "wlan.fixed.auth_seq": "auth_seq",
    "wlan.fixed.current_ap": "current_ap",
    "wlan.ssid": "ssid",
    "wlan.qbss.cu": "cu",
    "wlan.qbss.scount": "scount",
    "wlan.rsn.akms.type": "akm",
    # 802.11w: does the network protect management frames (capable / required)?
    "wlan.rsn.capabilities.mfpc": "mfpc",
    "wlan.rsn.capabilities.mfpr": "mfpr",
    "eapol.type": "eapol_type",
    "eap.code": "eap_code",
    "eap.type": "eap_type",
    "wlan_rsna_eapol.keydes.key_info.key_ack": "k_ack",
    "wlan_rsna_eapol.keydes.key_info.key_mic": "k_mic",
    "wlan_rsna_eapol.keydes.key_info.install": "k_install",
    "wlan_rsna_eapol.keydes.key_info.secure": "k_secure",
    "wlan_rsna_eapol.keydes.msgnr": "msgnr",
}

NUMERIC = [
    "frame",
    "ts",
    "channel",
    "freq",
    "rssi",
    "noise",
    "rate",
    "subtype",
    "tsf",
    "retry",
    "ds",
    "seq",
    "reason",
    "status",
    "auth_seq",
    "cu",
    "scount",
    "mfpc",
    "mfpr",
    "eapol_type",
    "eap_code",
    "eap_type",
    "k_ack",
    "k_mic",
    "k_install",
    "k_secure",
    "msgnr",
]

# 802.11 type_subtype (tshark encoding)
SUBTYPE = {
    0x00: "assoc_req",
    0x01: "assoc_resp",
    0x02: "reassoc_req",
    0x03: "reassoc_resp",
    0x04: "probe_req",
    0x05: "probe_resp",
    0x08: "beacon",
    0x0A: "disassoc",
    0x0B: "auth",
    0x0C: "deauth",
    0x0D: "action",
    0x1B: "rts",
    0x1C: "cts",
    0x1D: "ack",
    0x19: "block_ack",
    0x18: "block_ack_req",
    0x1A: "ps_poll",
    0x28: "qos_data",
    0x20: "data",
    0x24: "null",
    0x2C: "qos_null",
}

CAPTURE_EXT = {".pcap", ".pcapng", ".cap", ".pcap.gz", ".pcapng.gz"}


def tshark_bin() -> str:
    b = shutil.which("tshark")
    if not b:
        raise RuntimeError(
            "tshark not found - install Wireshark or run inside the container"
        )
    return b


def _num(v):
    v = _first(v)
    if not isinstance(v, str):
        return None
    if v in ("True", "False"):
        return 1 if v == "True" else 0
    try:
        return int(v, 16) if v.startswith("0x") else float(v)
    except ValueError:
        return None


def _ssid(v):
    """tshark 4.x prints SSIDs as hex in field output; decode when possible."""
    if not isinstance(v, str) or not v:
        return None
    v = _first(v)
    # some tshark builds print an empty (wildcard) SSID element as "<MISSING>" instead of ""
    if v == "<MISSING>":
        return None
    if len(v) % 2 == 0 and all(c in "0123456789abcdefABCDEF" for c in v):
        try:
            return bytes.fromhex(v).decode("utf-8")
        except (ValueError, UnicodeDecodeError):
            return v
    return v


def _first(v):
    # tshark prints repeated fields comma-separated; keep the first one
    if isinstance(v, str) and "," in v:
        return v.split(",", 1)[0]
    return v


def read_capture(path: Path, sensor: str | None = None) -> pd.DataFrame:
    cmd = [
        tshark_bin(),
        "-r",
        str(path),
        "-n",
        "-T",
        "fields",
        "-E",
        "header=n",
        "-E",
        "separator=\t",
        "-E",
        "occurrence=f",
    ]
    for f in FIELDS:
        cmd += ["-e", f]
    res = subprocess.run(cmd, capture_output=True, text=True, errors="replace")
    if res.returncode != 0 and not res.stdout:
        raise RuntimeError(f"tshark {path.name}: {res.stderr.strip()[:300]}")
    if (
        not res.stdout.strip()
    ):  # a valid capture without frames: an empty table, not a parse error
        df = pd.DataFrame({c: pd.Series(dtype=object) for c in FIELDS.values()})
    else:
        df = _parse(res.stdout)
    return _normalise(df, path, sensor)


def _parse(text: str) -> pd.DataFrame:
    return pd.read_csv(
        io.StringIO(text),
        sep="\t",
        header=None,
        names=list(FIELDS.values()),
        dtype=str,
        quoting=3,
        na_filter=True,
        keep_default_na=False,
        na_values=[""],
    )


def _normalise(df: pd.DataFrame, path: Path, sensor: str | None) -> pd.DataFrame:
    for c in NUMERIC:
        try:  # fast path: plain decimal column (most of them, incl. noise and rate)
            df[c] = pd.to_numeric(df[c]).astype(float)
        except (ValueError, TypeError):  # hex, True/False or repeated values
            df[c] = df[c].map(_num)
    for c in ("ta", "ra", "sa", "da", "bssid", "current_ap"):
        df[c] = (
            df[c]
            .map(lambda v: _first(v).lower() if isinstance(v, str) else None)
            .astype(object)
        )
    df["ssid"] = df["ssid"].map(_ssid)
    df["kind"] = df["subtype"].map(SUBTYPE).fillna("other")
    df["msg"] = eapol_msg(df)
    df["sensor"] = sensor or sensor_name(path)
    df["file"] = path.name
    return df


def sensor_name(path: Path) -> str:
    name = path.name
    for ext in sorted(CAPTURE_EXT, key=len, reverse=True):
        if name.endswith(ext):
            return name[: -len(ext)]
    return path.stem


def eapol_msg(df: pd.DataFrame) -> pd.Series:
    """Derive the 4-way handshake message number from the key-info bits (more robust than msgnr)."""
    ack, mic, sec = df["k_ack"] == 1, df["k_mic"] == 1, df["k_secure"] == 1
    msg = pd.Series(pd.NA, index=df.index, dtype="Int64")
    has = df["k_ack"].notna()
    msg[has & ack & ~mic] = 1
    msg[has & ack & mic] = 3
    msg[has & ~ack & mic & ~sec] = 2
    msg[has & ~ack & mic & sec] = 4
    return msg


def find_captures(folder: Path) -> list[Path]:
    return sorted(
        p
        for p in folder.rglob("*")
        if p.is_file() and any(p.name.endswith(e) for e in CAPTURE_EXT)
    )


def read_all(paths: list[Path], workers: int = 8) -> pd.DataFrame:
    with ThreadPoolExecutor(max_workers=workers) as ex:
        frames = list(ex.map(read_capture, paths))
    df = pd.concat(frames, ignore_index=True)
    return df.sort_values("ts", kind="stable").reset_index(drop=True)


@lru_cache(maxsize=1)
def _manuf() -> dict[str, str]:
    out: dict[str, str] = {}
    for p in ("/usr/share/wireshark/manuf", "C:/Program Files/Wireshark/manuf"):
        try:
            for line in open(p, encoding="utf-8", errors="replace"):
                if line.startswith("#") or not line.strip():
                    continue
                parts = line.rstrip("\n").split("\t")
                if len(parts) >= 2 and len(parts[0]) == 8:
                    out[parts[0].lower()] = parts[-1] if len(parts) >= 3 else parts[1]
            break
        except OSError:
            continue
    return out


def vendor(mac: str | None) -> str:
    if not isinstance(mac, str) or len(mac) < 8:
        return "?"
    if int(mac[1], 16) & 0x2:
        return "locally administered"  # MAC randomization or spoofing
    return _manuf().get(mac[:8], "unknown")
