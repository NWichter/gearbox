"""Test set-up: SQLite instead of Postgres, a temporary upload folder, no LLM key.

The environment is set before any app module is imported, because app.config reads it at import.
"""

from __future__ import annotations

import os
import shutil
import sys
import tempfile
from pathlib import Path

import pytest

TMP = Path(tempfile.mkdtemp(prefix="airframe-tests-"))
os.environ["DATABASE_URL"] = f"sqlite:///{(TMP / 'test.db').as_posix()}"
os.environ["UPLOAD_DIR"] = str(TMP / "uploads")
os.environ["OPENROUTER_API_KEY"] = ""
os.environ["LLM_API_KEY"] = ""
os.environ["ADMIN_TOKEN"] = "test-admin"

BACKEND = Path(__file__).resolve().parents[1]
REPO = BACKEND.parent
sys.path.insert(0, str(BACKEND))
sys.path.insert(0, str(BACKEND / "tools"))

PCAP_MAGIC = {
    bytes.fromhex(x)
    for x in ("d4c3b2a1", "a1b2c3d4", "4d3cb2a1", "a1b23c4d", "0a0d0d0a")
}


def tesla_captures() -> Path | None:
    """The folder with the 8 real Tesla pcaps, or None (Git LFS pointers do not count)."""
    candidates = [
        os.environ.get("TESLA_CAPTURES"),
        REPO / "data" / "tesla",
        REPO / "internal" / "briefing" / "captures",
    ]
    for c in candidates:
        if not c:
            continue
        folder = Path(c)
        pcaps = sorted(folder.glob("sensor0*.pcap*"))
        if len(pcaps) == 8 and all(p.open("rb").read(4) in PCAP_MAGIC for p in pcaps):
            return folder
    return None


@pytest.fixture(scope="session", autouse=True)
def _cleanup():
    yield
    from app.db import engine

    engine.dispose()
    shutil.rmtree(TMP, ignore_errors=True)


@pytest.fixture(scope="session")
def db():
    from app.db import Base, engine

    Base.metadata.create_all(engine)
    return engine


def finding(**kw) -> dict:
    """A finding dict as the pipeline produces it, with the given fields replaced."""
    f = {
        "id": 1,
        "type": "eap_failure",
        "severity": "high",
        "title": "802.1X authentication fails (3x)",
        "detail": "EAP-Failure 3 times.",
        "t_start": 10.0,
        "t_end": 20.0,
        "client": "3c:58:c2:00:00:01",
        "bssid": "00:0b:86:01:00:00",
        "channel": None,
        "sensors": ["sensor01", "sensor02"],
        "count": 3,
        "recommendation": "Check the RADIUS log.",
        "evidence": [
            {
                "t": 10.0,
                "what": "EAP Failure",
                "kind": "qos_data",
                "frames": [{"sensor": "sensor01", "frame": 5, "rssi": -70}],
            },
            {
                "t": 12.0,
                "what": "EAP Failure",
                "kind": "qos_data",
                "frames": [{"sensor": "sensor01", "frame": 9, "rssi": -71}],
            },
            {
                "t": 14.0,
                "what": "deauth",
                "kind": "deauth",
                "frames": [{"sensor": "sensor02", "frame": 3, "rssi": -80}],
            },
        ],
        "device_class": "unknown",
        "vendor": "unknown",
        "closest_sensor": "sensor01",
        "affected": [],
        "missing_bssids": [],
        "occurrences": [],
        "wireshark_filter": None,
    }
    f.update(kw)
    return f
