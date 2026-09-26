"""Streaming mode (prototype): the incident detectors as incremental, partitioned stream jobs.

The batch pipeline reads a whole capture, then decides. This module feeds the frames in capture
time order, in windows of 5 s, through detectors that keep a small state per key. After each
window the detectors report state changes, and a reducer turns them into alerts. For each alert
it records the time to alert: the capture time at which the stream raised the alert minus the
capture time of the first evidence frame.

Layout, as it would run on a message bus:

    sensor (edge)         clock alignment per sensor (beacon TSF, causal)
      -> partition        route every frame by its station key (see route_keys)
      -> Partition.step   per-key state: client, deauth target, sensor lateness baseline
      -> Reducer          per-site incidents: "63 clients fail 802.1X" is a count over keys

Every state lives under one key, so a partition never needs the state of another partition.
The reducer receives only state changes (a few per window), not frames.

Detectors (same rules as the batch detectors in incidents.py and detect.py):
  radius_outage     802.1X stops after EAP-Request/Identity on >= 2 clients
  deauth_campaign   deauth / disassoc to one station with a machine-regular period; all series of a
                    site are one campaign, and kicks with the campaign's reason to its targets belong to it
  stuck_scanning    a device probes for >= 300 s, or gives up after >= 3 APs answered; one incident per
                    network (the SSID of its own probes, else the network of its vendor block)
  device_vanished   a joined device signs off itself and stays silent for 300 s
  deauth_by_ap      the AP kicks a client with reasons that are not a normal leave
  controller_stall  beacons >= 10 ms late on >= 3 sensors in the same second; pauses < 30 s apart
                    are one incident
  association_wave  >= 10 devices join one after another
  signoff_wave      >= 5 devices sign off themselves (normal-leave reason) within 10 s

Not in the stream (batch only, see BATCH_ONLY): weak_security and sensor_clock. They are checks of
the configuration (RSN element of the beacons) and of the sensor fleet (clock fit over the whole
capture), not events with a time to alert.

CLI:
  python -m app.airframe.stream <captures-folder> [--cache DIR] [--batch] [--json FILE]
"""

from __future__ import annotations

import argparse
import bisect
import hashlib
import json
import pickle
import sys
import tempfile
import time
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd

from app.airframe.ingest import SUBTYPE

WINDOW_S = 5.0
KINDS = sorted(set(SUBTYPE.values()) | {"other"})
KC = {k: i for i, k in enumerate(KINDS)}
BEACON, ACK = KC["beacon"], KC["ack"]
PROBE_REQ, PROBE_RESP = KC["probe_req"], KC["probe_resp"]
DEAUTH, DISASSOC = KC["deauth"], KC["disassoc"]
AUTH, ASSOC_REQ, REASSOC_REQ = KC["auth"], KC["assoc_req"], KC["reassoc_req"]
ASSOC_RESP, REASSOC_RESP = KC["assoc_resp"], KC["reassoc_resp"]
MGMT = np.array(
    [DEAUTH, DISASSOC, AUTH, ASSOC_REQ, REASSOC_REQ, ASSOC_RESP, REASSOC_RESP]
)
NORMAL_LEAVE = {3, 8, 36}

# detector thresholds (the batch detectors use the same values)
RADIUS_MIN_CLIENTS = 2
CAMPAIGN_MIN_FRAMES = 4
CAMPAIGN_MAX_SPREAD = 0.02
# a kick series with < 4 frames waits this long before it counts as a kick
KICK_DECIDE_S = 60.0
# after a campaign series turns irregular, wait this long before it counts as kicks
KICK_HOLD_S = 180.0
SCAN_MIN_FRAMES = 20
SCAN_MIN_SPAN_S = 300.0
SCAN_GIVE_UP_S = 60.0
SCAN_MIN_RESPONDERS = 3
VANISH_SILENCE_S = (
    300.0  # batch: min(300, max(30, capture/4)), = 300 s for captures >= 20 min
)
VANISH_TAIL_S = 5.0
STALL_LATE_S = 0.010
STALL_MIN_SENSORS = 3
STALL_BASELINE_WINDOWS = 12  # 60 s rolling baseline of each sensor's beacon delay
STALL_MERGE_S = (
    30.0  # batch controller_stall(merge_s): pauses closer than this are one incident
)
WAVE_MIN_CLIENTS = 10
SIGNOFF_WINDOW_S = 10.0
SIGNOFF_MIN_CLIENTS = 5
DEDUP_S = 0.01
# batch findings the stream does not produce (configuration and sensor-fleet checks, no time to alert)
BATCH_ONLY = {"weak_security", "sensor_clock"}

COLS = (
    "t", "sensor", "kind", "key", "ta", "ra", "bssid", "seq", "retry",
    "reason", "status", "eap_code", "eap_type", "d", "frame", "ssid",
)  # fmt: skip
MAC_COLS = ("key", "ta", "ra", "bssid")


# ---------------------------------------------------------------- frame table


@dataclass
class Table:
    """Columnar frame table in stream order. MACs and sensors are integer codes."""

    cols: dict[str, np.ndarray]
    macs: np.ndarray  # code -> MAC string
    sensors: list[str]
    bc: int  # code of ff:ff:ff:ff:ff:ff, -2 when absent
    t0_epoch: float
    alignment: str
    window: float = WINDOW_S
    ssids: list[str] = field(default_factory=list)  # code -> SSID
    oui: np.ndarray | None = None  # MAC code -> vendor block (OUI) code

    def __post_init__(self) -> None:
        if self.oui is None:
            self.oui = oui_codes(self.macs)

    @property
    def n(self) -> int:
        return len(self.cols["t"])

    @property
    def duration(self) -> float:
        return float(self.cols["t"][-1]) if self.n else 0.0

    def save(self, path: Path) -> None:
        meta = {
            "macs": self.macs.tolist(), "sensors": self.sensors, "bc": self.bc,
            "t0_epoch": self.t0_epoch, "alignment": self.alignment, "window": self.window,
            "ssids": self.ssids,
        }  # fmt: skip
        np.savez(path, meta=np.array(json.dumps(meta)), **self.cols)

    @classmethod
    def load(cls, path: Path) -> Table:
        z = np.load(path)
        meta = json.loads(str(z["meta"]))
        return cls(
            cols={c: z[c] for c in COLS},
            macs=np.array(meta["macs"], dtype=object),
            sensors=meta["sensors"],
            bc=meta["bc"],
            t0_epoch=meta["t0_epoch"],
            alignment=meta["alignment"],
            window=meta["window"],
            ssids=meta.get("ssids", []),
        )


def route_keys(ta, ra, bssid, bc: int) -> np.ndarray:
    """The station key of each frame: the client side of a client <-> AP exchange.

    Frames from the AP (TA = BSSID) belong to their receiver, frames to the AP to their sender.
    Beacons (to broadcast) belong to the AP. A frame without a TA (ACK, CTS) belongs to its
    receiver. So one client's whole exchange (auth, association, 802.1X, deauth, probes, ACKs)
    lands in one partition, which a plain transmitter key cannot give: the AP sends half of it.
    """
    key = ta.copy()
    has_b = bssid >= 0
    from_ap = has_b & (ta == bssid)
    to_ap = has_b & (ra == bssid) & ~from_ap
    ra_ok = (ra >= 0) & (ra != bc)
    key = np.where(from_ap & ra_ok, ra, key)
    key = np.where(to_ap, ta, key)
    return np.where(key < 0, ra, key)


def oui_codes(macs: np.ndarray) -> np.ndarray:
    """MAC code -> code of its vendor block (the first 3 bytes)."""
    return pd.factorize(pd.Series([str(m)[:8] for m in macs], dtype=object))[0].astype(
        np.int32
    )


def _codes(s: pd.Series, cats: pd.Index) -> np.ndarray:
    return pd.Categorical(s, categories=cats).codes.astype(np.int32)


def _int(s: pd.Series, dtype=np.int32) -> np.ndarray:
    return s.fillna(-1).to_numpy().astype(dtype)


def prepare(raw: pd.DataFrame, window: float = WINDOW_S) -> Table:
    """Ingest output (one row per captured frame) -> stream-ordered, integer-coded table.

    Clock alignment is causal and per sensor, as a sensor could do it on its own: the offset is the
    lower envelope (minimum) of capture time minus beacon TSF over the last three 5-s windows. The
    batch fuse fits the same envelope over the whole capture. Without a shared TSF clock the
    capture times stay as they are.
    """
    r = raw
    ts = r["ts"].to_numpy(dtype=float)
    is_b = (r["kind"] == "beacon").to_numpy() & r["tsf"].notna().to_numpy()
    d = np.where(is_b, ts - r["tsf"].to_numpy(dtype=float) / 1e6, np.nan)
    sensors = sorted(r["sensor"].unique())
    sensor = _codes(r["sensor"], pd.Index(sensors))
    shared = np.isfinite(d).any() and (np.abs(d[np.isfinite(d)]) > 86400).mean() <= 0.2
    if shared:
        w_raw = ((ts - ts.min()) // window).astype(int)
        env = (
            pd.DataFrame({"s": sensor, "w": w_raw, "d": d})
            .dropna()
            .groupby(["s", "w"])["d"]
            .min()
            .unstack(0)
            .reindex(range(w_raw.max() + 1))
        )
        env = env.rolling(3, min_periods=1).min().ffill().bfill().fillna(0.0)
        off = env.to_numpy()[w_raw, np.searchsorted(env.columns.to_numpy(), sensor)]
        alignment = "beacon TSF, causal per-sensor envelope"
    else:
        off = np.zeros(len(r))
        d = np.full(len(r), np.nan)
        alignment = "none (no shared TSF clock)"
    t_abs = ts - off
    t0 = float(t_abs.min()) if len(t_abs) else 0.0
    t = t_abs - t0

    macs = pd.Index(
        pd.unique(pd.concat([r["ta"], r["ra"], r["bssid"]], ignore_index=True).dropna())
    )
    bc = int(macs.get_loc("ff:ff:ff:ff:ff:ff")) if "ff:ff:ff:ff:ff:ff" in macs else -2
    ta, ra, bssid = (_codes(r[c], macs) for c in ("ta", "ra", "bssid"))
    ssid_s = r["ssid"] if "ssid" in r else pd.Series(None, index=r.index, dtype=object)
    ssid_s = ssid_s.where(ssid_s.notna() & (ssid_s != ""))
    ssids = pd.Index(pd.unique(ssid_s.dropna()))
    cols = {
        "t": t,
        "sensor": sensor,
        "kind": r["kind"].map(KC).fillna(KC["other"]).to_numpy().astype(np.int16),
        "key": route_keys(ta, ra, bssid, bc).astype(np.int32),
        "ta": ta,
        "ra": ra,
        "bssid": bssid,
        "seq": _int(r["seq"]),
        "retry": _int(r["retry"], np.int8),
        "reason": _int(r["reason"], np.int16),
        "status": _int(r["status"], np.int16),
        "eap_code": _int(r["eap_code"], np.int16),
        "eap_type": _int(r["eap_type"], np.int16),
        "d": d,
        "frame": _int(r["frame"]),
        "ssid": _codes(ssid_s, ssids),
    }
    order = np.argsort(t, kind="stable")
    cols = {k: v[order] for k, v in cols.items()}
    return Table(
        cols,
        np.asarray(macs, dtype=object),
        sensors,
        bc,
        t0,
        alignment,
        window,
        [str(x) for x in ssids],
    )


# ---------------------------------------------------------------- per-partition state


def _pct(a: list[float], q: float) -> float:
    """Percentile of a sorted list, linear interpolation (numpy's default method)."""
    pos = (len(a) - 1) * q / 100
    lo = int(pos)
    hi = min(lo + 1, len(a) - 1)
    return a[lo] + (a[hi] - a[lo]) * (pos - lo)


def _regular(ts: list[float]) -> tuple[bool, float]:
    """Batch rule of deauth_campaigns: >= 4 frames, median interval >= 1 s, p90-p10 spread <= 2 %.

    Plain Python: the series are short, and numpy's per-call overhead is larger than the work.
    """
    if len(ts) < CAMPAIGN_MIN_FRAMES:
        return False, 0.0
    t = sorted(ts)
    iv = sorted(y - x for x, y in zip(t, t[1:]))
    med = _pct(iv, 50)
    if med < 1:
        return False, med
    spread = (_pct(iv, 90) - _pct(iv, 10)) / med
    return spread <= CAMPAIGN_MAX_SPREAD, med


def _periodic_with_gaps(ts: list[float]) -> bool:
    """Every interval is a whole multiple of the median interval (within 2 %): a timer with lost frames.

    Such a series becomes regular under the batch rule once enough frames arrive.
    """
    iv = np.diff(np.sort(np.asarray(ts)))
    med = float(np.median(iv))
    if med < 1:
        return False
    r = iv / med
    k = np.round(r)
    return bool(((k >= 1) & (np.abs(r - k) <= CAMPAIGN_MAX_SPREAD * k)).all())


class Partition:
    """Detector state for the keys of one partition. step() takes one window of frames."""

    def __init__(self, bc: int, dedup: bool = True) -> None:
        self.bc = bc
        self.dedup = dedup
        self.radius: dict[
            int, list
        ] = {}  # key -> [identity requests, method, success, reason 23, first t, bssid]
        self.radius_on: set[int] = set()
        self.series: dict[
            tuple[int, int], list[float]
        ] = {}  # (kind, target) -> deauth/disassoc times
        self.series_on: set[tuple[int, int]] = set()
        self.kicks: dict[
            int, dict[int, list]
        ] = {}  # client -> kind -> [(t, reason)] sent by the AP
        self.kick_on: set[int] = set()
        self.kick_pending: set[int] = set()
        self.kick_count: dict[int, int] = {}
        self.series_last: dict[tuple[int, int], tuple[int, float]] = {}  # (seq, t)
        self.series_ever: set[tuple[int, int]] = set()  # was a campaign at some time
        self.series_off_at: dict[tuple[int, int], float] = {}
        self.series_reasons: dict[
            tuple[int, int], Counter
        ] = {}  # reason codes of each series
        self.ap_ssid: dict[
            int, int
        ] = {}  # AP -> SSID code (first seen in a beacon or probe response)
        self.probe_ssid: dict[
            int, Counter
        ] = {}  # key -> SSIDs of its own directed probe requests
        self.stuck_dir: dict[
            int, int
        ] = {}  # stuck key -> directed SSID code last reported
        self.signed_off: set[int] = (
            set()
        )  # keys that signed off themselves with a normal-leave reason
        # keys whose state changed in the current window
        self._dirty_r: set[int] = set()
        self._dirty_s: set[tuple[int, int]] = set()
        self._dirty_k: set[int] = set()
        self._dirty_t: set[int] = set()
        self.trace: dict[
            int, list
        ] = {}  # key -> [frames, own probes, AP replies, first, last, responders]
        self.joined: set[int] = (
            set()
        )  # started an authentication or association at some time
        self.stuck_on: set[int] = set()
        self.stuck_cand: set[int] = set()
        self.assoc_ok: dict[int, float] = {}  # key -> first successful (re)association
        self._assoc_arr = np.empty(0, dtype=np.int64)
        self.last_seen: dict[int, float] = {}
        self.signoff: dict[
            int, tuple[float, int, int]
        ] = {}  # key -> (t, reason, frame index)
        self.vanished_on: set[int] = set()
        self.sensor_rows: dict[int, int] = {}  # sensor -> row of the delay ring buffer
        self.sensor_ring = np.full((0, STALL_BASELINE_WINDOWS), np.nan)
        self.sensor_pos = np.zeros(0, dtype=np.int64)
        self.frames = 0

    # ------------------------------------------------------------ one window
    def step(self, c: dict[str, np.ndarray], now: float) -> list[tuple]:
        sig: list[tuple] = []
        n = len(c["t"])
        self.frames += n
        if n:
            if self.dedup:
                c = self._dedup(c)
            self._beacons(c, sig)
            self._ap_ssids(c, sig)
            self._mgmt(c, sig)
            self._probes(c)
            self._last_seen(c)
        self._evaluate(now, sig)
        return sig

    def finish(self, now: float) -> list[tuple]:
        """End of stream: evaluate the time-based rules one last time, undecided kicks count."""
        sig: list[tuple] = []
        self._evaluate(now, sig, final=True)
        return sig

    # ------------------------------------------------------------ frame handlers
    def _dedup(self, c: dict) -> dict:
        """The same frame heard by two sensors: same TA, sequence number, type and retry bit within 10 ms."""
        idx = np.nonzero((c["ta"] >= 0) & (c["seq"] >= 0))[0]
        if len(idx) < 2:
            return c
        o = idx[
            np.lexsort(
                (
                    c["t"][idx],
                    c["retry"][idx],
                    c["kind"][idx],
                    c["seq"][idx],
                    c["ta"][idx],
                )
            )
        ]
        same = (
            (c["ta"][o[1:]] == c["ta"][o[:-1]])
            & (c["seq"][o[1:]] == c["seq"][o[:-1]])
            & (c["kind"][o[1:]] == c["kind"][o[:-1]])
            & (c["retry"][o[1:]] == c["retry"][o[:-1]])
            & (c["t"][o[1:]] - c["t"][o[:-1]] < DEDUP_S)
        )
        if not same.any():
            return c
        keep = np.ones(len(c["t"]), dtype=bool)
        keep[o[1:][same]] = False
        return {k: v[keep] for k, v in c.items()}

    def _sensor_row(self, sensor: int) -> int:
        row = self.sensor_rows.get(sensor)
        if row is None:
            row = self.sensor_rows[sensor] = len(self.sensor_rows)
            if row >= len(self.sensor_ring):
                grow = max(16, len(self.sensor_ring))
                self.sensor_ring = np.vstack(
                    [self.sensor_ring, np.full((grow, STALL_BASELINE_WINDOWS), np.nan)]
                )
                self.sensor_pos = np.concatenate(
                    [self.sensor_pos, np.zeros(grow, dtype=np.int64)]
                )
        return row

    def _beacons(self, c: dict, sig: list) -> None:
        """Beacon delay against each sensor's own 60-s median. Late on many sensors at once = controller stall."""
        m = (c["kind"] == BEACON) & np.isfinite(c["d"])
        if not m.any():
            return
        s, d, t = c["sensor"][m], c["d"][m], c["t"][m]
        # median delay per sensor in this window, all sensors at once
        uniq, inv = np.unique(s, return_inverse=True)
        order = np.lexsort((d, inv))
        counts = np.bincount(inv)
        starts = np.concatenate(([0], np.cumsum(counts)[:-1]))
        ds = d[order]
        med = (ds[starts + (counts - 1) // 2] + ds[starts + counts // 2]) / 2
        # rolling baseline: median of the last 12 window medians (ring buffer, one row per sensor)
        rows = np.array([self._sensor_row(x) for x in uniq.tolist()])
        self.sensor_ring[rows, self.sensor_pos[rows] % STALL_BASELINE_WINDOWS] = med
        self.sensor_pos[rows] += 1
        with np.errstate(all="ignore"):
            base = np.nanmedian(self.sensor_ring[rows], axis=1)
        late = d - base[inv]
        hot = late > STALL_LATE_S
        if not hot.any():
            return
        frame_idx = np.nonzero(m)[0][hot]
        df = pd.DataFrame(
            {
                "sensor": s[hot],
                "sec": np.round(t[hot]),
                "late": late[hot],
                "t": t[hot],
                "i": frame_idx,
            }
        )
        for (sensor, sec), g in df.groupby(["sensor", "sec"]):
            top = g.loc[g["late"].idxmax()]
            ev = (
                float(top["t"]),
                int(c["ta"][int(top["i"])]),
                int(c["frame"][int(top["i"])]),
                float(top["late"]),
            )
            sig.append(
                (
                    "late",
                    int(sensor),
                    float(sec),
                    len(g),
                    float(g["late"].max()),
                    float(g["t"].min()),
                    ev,
                )
            )

    def _ap_ssids(self, c: dict, sig: list) -> None:
        """The network name of each AP, from its beacons and probe responses. Reported once per AP."""
        m = (
            ((c["kind"] == BEACON) | (c["kind"] == PROBE_RESP))
            & (c["ssid"] >= 0)
            & (c["ta"] >= 0)
        )
        if not m.any():
            return
        pairs = np.unique(np.stack([c["ta"][m], c["ssid"][m]], axis=1), axis=0)
        for ta, ssid in pairs.tolist():
            if ta not in self.ap_ssid:
                self.ap_ssid[ta] = ssid
                sig.append(("ap_ssid", ta, ssid))

    def _mgmt(self, c: dict, sig: list) -> None:
        """Authentication, association, deauth/disassoc and 802.1X frames: few, handled one by one."""
        m = np.isin(c["kind"], MGMT) | (c["eap_code"] >= 0)
        if not m.any():
            return
        bc = self.bc
        cols = [
            c[k][m].tolist()
            for k in (
                "t",
                "kind",
                "key",
                "ta",
                "ra",
                "bssid",
                "reason",
                "status",
                "eap_code",
                "eap_type",
                "frame",
                "sensor",
                "seq",
            )
        ]
        for (
            t,
            kind,
            key,
            ta,
            ra,
            bssid,
            reason,
            status,
            eap,
            eap_type,
            frame,
            sensor,
            seq,
        ) in zip(*cols):
            if key < 0 or key == bc:
                continue
            is_deauth = kind == DEAUTH or kind == DISASSOC
            if eap >= 0 or (kind == DEAUTH and reason == 23):
                st = self.radius.get(key)
                if st is None:
                    st = self.radius[key] = [0, 0, 0, 0, t, -1]
                if eap == 1 and eap_type == 1:
                    st[0] += 1
                if eap in (1, 2) and eap_type >= 0 and eap_type != 1:
                    st[1] += 1
                if eap == 3:
                    st[2] += 1
                if kind == DEAUTH and reason == 23:
                    st[3] += 1
                if bssid >= 0:
                    st[5] = bssid
                self._dirty_r.add(key)
            if is_deauth:
                sk = (kind, ra)
                # a retransmission (same sequence number within 1 s) is the same frame again
                last_seq, last_t = self.series_last.get(sk, (-1, -9.0))
                resent = seq >= 0 and seq == last_seq and t - last_t < 1.0
                if ra >= 0 and ra != bc and reason != 23:
                    if not resent:
                        self.series.setdefault(sk, []).append(t)
                        self.series_last[sk] = (seq, t)
                        self.series_reasons.setdefault(sk, Counter())[reason] += 1
                        self._dirty_s.add(sk)
                    # the batch finding counts every kick frame, retransmissions too
                    if ta == bssid and ra == key and reason not in NORMAL_LEAVE:
                        self.kicks.setdefault(key, {}).setdefault(kind, []).append(
                            (t, reason, frame, sensor)
                        )
                        self._dirty_k.add(key)
                if ta == key:  # the device signs off itself
                    self.signoff[key] = (t, reason, frame, sensor)
                    if (
                        ta != bssid
                        and reason in NORMAL_LEAVE
                        and key not in self.signed_off
                    ):
                        self.signed_off.add(key)
                        sig.append(("signoff", key, t))
            if kind in (AUTH, ASSOC_REQ, REASSOC_REQ):
                self.joined.add(ta)
                self._dirty_t.add(key)
            if kind in (ASSOC_RESP, REASSOC_RESP, AUTH):
                self.joined.add(ra)
                self._dirty_t.add(key)
            if (
                kind in (ASSOC_RESP, REASSOC_RESP)
                and status in (-1, 0)
                and ra == key
                and ta >= 0
            ):
                sig.append(("assoc_ap", key, ta))
            if (
                kind in (ASSOC_RESP, REASSOC_RESP)
                and status in (-1, 0)
                and ra == key
                and key not in self.assoc_ok
            ):
                self.assoc_ok[key] = t
                self.last_seen[key] = t
                self._assoc_arr = np.sort(np.fromiter(self.assoc_ok, dtype=np.int64))
                sig.append(("join", key, t))

    def _probes(self, c: dict) -> None:
        """Search trace per device: its own probe requests and the APs' probe responses to it."""
        req, resp = c["kind"] == PROBE_REQ, c["kind"] == PROBE_RESP
        tr = req | resp
        if not tr.any():
            return
        k, t, direct = c["key"][tr], c["t"][tr], req[tr]
        uniq, inv = np.unique(k, return_inverse=True)
        cnt = np.bincount(inv)
        dcnt = np.bincount(inv, weights=direct)
        tmin = np.full(len(uniq), np.inf)
        tmax = np.full(len(uniq), -np.inf)
        np.minimum.at(tmin, inv, t)
        np.maximum.at(tmax, inv, t)
        for key, n, nd, a, z in zip(
            uniq.tolist(), cnt.tolist(), dcnt.tolist(), tmin.tolist(), tmax.tolist()
        ):
            if key < 0 or key == self.bc:
                continue
            st = self.trace.get(key)
            if st is None:
                st = self.trace[key] = [0, 0, 0, a, z, set()]
            st[0] += n
            st[1] += int(nd)
            st[2] += n - int(nd)
            st[4] = z
            self._dirty_t.add(key)
        named = req & (c["ssid"] >= 0)
        if named.any():
            pairs, cnt = np.unique(
                np.stack([c["key"][named], c["ssid"][named]], axis=1),
                axis=0,
                return_counts=True,
            )
            for (key, ssid), n in zip(pairs.tolist(), cnt.tolist()):
                self.probe_ssid.setdefault(key, Counter())[ssid] += n
        if resp.any():
            pairs = np.unique(np.stack([c["key"][resp], c["ta"][resp]], axis=1), axis=0)
            for key, ta in pairs.tolist():
                st = self.trace.get(key)
                if st is not None and ta >= 0:
                    st[5].add(ta)

    def _last_seen(self, c: dict) -> None:
        if not len(self._assoc_arr):
            return
        m = np.isin(c["key"], self._assoc_arr)
        if not m.any():
            return
        k, t = c["key"][m], c["t"][m]
        uniq, inv = np.unique(k, return_inverse=True)
        tmax = np.full(len(uniq), -np.inf)
        np.maximum.at(tmax, inv, t)
        for key, z in zip(uniq.tolist(), tmax.tolist()):
            if z > self.last_seen.get(key, -np.inf):
                self.last_seen[key] = z

    # ------------------------------------------------------------ decisions after each window
    def _kick_undecided(self, sk: tuple[int, int], ts: list[float], now: float) -> bool:
        """True while a kick series could still be a campaign. The batch rule sees only the end state.

        A retransmission (0 s interval) or one lost frame (2x the period) breaks the regularity
        of a campaign for a short time. The hold time stops an "AP kicks" alert in that gap.
        """
        off_at = self.series_off_at.get(sk)
        if off_at is not None and now - off_at < KICK_HOLD_S:
            return True
        if sk in self.series_ever:
            return False
        if len(ts) < CAMPAIGN_MIN_FRAMES:
            return now - ts[-1] < KICK_DECIDE_S
        return _periodic_with_gaps(ts)

    def _directed(self, key: int) -> int:
        """The SSID a device asks for most often in its own probe requests, -1 when it asks for none."""
        cnt = self.probe_ssid.get(key)
        return cnt.most_common(1)[0][0] if cnt else -1

    def _evaluate(self, now: float, sig: list, final: bool = False) -> None:
        # 802.1X stops after the identity request
        for key in self._dirty_r:
            q, method, ok, d23, first, bssid = self.radius[key]
            on = q >= 2 and method == 0 and ok == 0 and d23 >= 1
            if on != (key in self.radius_on):
                (self.radius_on.add if on else self.radius_on.discard)(key)
                sig.append(("radius", key, on, first, bssid, q))
        # machine-regular deauth / disassoc to one station
        for sk in self._dirty_s:
            ts = self.series[sk]
            on, period = _regular(ts)
            if on != (sk in self.series_on):
                (self.series_on.add if on else self.series_on.discard)(sk)
                if on:
                    self.series_ever.add(sk)
                else:
                    self.series_off_at[sk] = now
                sig.append(("campaign", sk[0], sk[1], on, ts[0], period, len(ts)))
            if sk[1] in self.kicks:  # a new campaign decision changes which kicks count
                self._dirty_k.add(sk[1])
        # the AP kicks a client (frames that are not part of a campaign)
        for key in self._dirty_k | self.kick_pending:
            counted, pending, reasons, first = 0, False, set(), None
            # batch rule: kicks to a campaign target with the campaign's reason belong to the campaign
            camp = {
                self.series_reasons[sk].most_common(1)[0][0]
                for sk in ((DEAUTH, key), (DISASSOC, key))
                if sk in self.series_on and self.series_reasons.get(sk)
            }
            for kind, rows in self.kicks.get(key, {}).items():
                sk = (kind, key)
                if sk in self.series_on:
                    continue
                rows = [r for r in rows if r[1] not in camp]
                if not rows:
                    continue
                ts = self.series.get(sk, [])
                if not final and self._kick_undecided(sk, ts, now):
                    pending = True  # could still be (or again be) a campaign
                    continue
                counted += len(rows)
                reasons |= {r for _, r, _, _ in rows if r >= 0}
                first = rows[0][0] if first is None else min(first, rows[0][0])
            (self.kick_pending.add if pending else self.kick_pending.discard)(key)
            # batch rule: reason 15 / 23 alone belong to the handshake and 802.1X findings
            on = counted > 0 and bool(reasons - {15, 23})
            if on != (key in self.kick_on) or (
                on and self.kick_count.get(key) != counted
            ):
                (self.kick_on.add if on else self.kick_on.discard)(key)
                self.kick_count[key] = counted
                sig.append(("kick", key, on, first, counted))
        # devices that search for a network and never join
        for key in self._dirty_t | self.stuck_cand:
            st = self.trace.get(key)
            if st is None:
                continue
            n, _, _, first, last, resp = st
            joined = key in self.joined
            long_search = last - first >= SCAN_MIN_SPAN_S
            gave_up = len(resp) >= SCAN_MIN_RESPONDERS and now - last >= SCAN_GIVE_UP_S
            on = not joined and n >= SCAN_MIN_FRAMES and (long_search or gave_up)
            cand = (
                not joined and n >= SCAN_MIN_FRAMES and len(resp) >= SCAN_MIN_RESPONDERS
            )
            (self.stuck_cand.add if cand else self.stuck_cand.discard)(key)
            if on != (key in self.stuck_on):
                (self.stuck_on.add if on else self.stuck_on.discard)(key)
                d = self._directed(key)
                self.stuck_dir[key] = d
                sig.append(("stuck", key, on, first, n, d))
        # a stuck device that names its network later: report the new network
        for key in self.stuck_on:
            d = self._directed(key)
            if d != self.stuck_dir.get(key):
                self.stuck_dir[key] = d
                n, _, _, first, _, _ = self.trace[key]
                sig.append(("stuck", key, True, first, n, d))
        # a joined device that signed off itself and stays silent
        for key, (t_off, reason, frame, sensor) in self.signoff.items():
            last = self.last_seen.get(key)
            on = (
                key in self.assoc_ok
                and last is not None
                and t_off >= last - VANISH_TAIL_S
                and now - last >= VANISH_SILENCE_S
            )
            if on != (key in self.vanished_on):
                (self.vanished_on.add if on else self.vanished_on.discard)(key)
                sig.append(("vanished", key, on, t_off, reason, last))
        self._dirty_r, self._dirty_s, self._dirty_k, self._dirty_t = (
            set(),
            set(),
            set(),
            set(),
        )


# ---------------------------------------------------------------- reducer: keys -> incidents


@dataclass
class Incident:
    type: str
    site: int
    sub: object = None  # campaign kind, device key, stall second, wave number
    alert_t: float | None = None
    evidence_t: float | None = None
    members: dict = field(default_factory=dict)  # key -> info, the current affected set
    count: int = 0
    active: bool = True
    note: str = ""


class Reducer:
    """Collects the partitions' state changes and raises one alert per incident and site."""

    def __init__(self, n_mac: int, n_sens: int, oui: np.ndarray | None = None) -> None:
        self.n_mac, self.n_sens = max(1, n_mac), max(1, n_sens)
        self.oui = oui
        self.inc: dict[tuple, Incident] = {}
        self.sets: dict[tuple, dict] = {}  # (type, site, sub) -> {key: info}
        self.stall: dict[tuple[int, float], dict] = {}
        self.stall_inc: dict[
            int, dict
        ] = {}  # site -> the current stall incident (pauses < 30 s apart)
        self.waves: dict[int, dict] = {}
        self.signoffs: dict[
            int, dict
        ] = {}  # site -> sign-off queue of the current window
        self.ap_ssid: dict[int, int] = {}  # AP -> SSID code
        self.oui_aps: dict[
            tuple[int, int], Counter
        ] = {}  # (site, vendor block) -> APs of successful joins
        self.stuck: dict[
            int, dict
        ] = {}  # site -> {stuck key: (first, n, directed SSID code)}
        self.stuck_nets: dict[
            int, set
        ] = {}  # site -> networks that had a stuck incident
        self.alerts: list[Incident] = []

    def site_of_key(self, key: int) -> int:
        return key // self.n_mac

    def _set(self, typ: str, site: int, sub, key: int, on: bool, info) -> dict:
        s = self.sets.setdefault((typ, site, sub), {})
        if on:
            s[key] = info
        else:
            s.pop(key, None)
        return s

    def _raise(
        self,
        typ: str,
        site: int,
        sub,
        now: float,
        members: dict,
        evidence_t: float,
        count: int,
    ) -> None:
        k = (typ, site, sub)
        inc = self.inc.get(k)
        if inc is None:
            inc = self.inc[k] = Incident(
                typ, site, sub, alert_t=now, evidence_t=evidence_t
            )
            self.alerts.append(inc)
        inc.members, inc.count, inc.active = dict(members), count, True

    def feed(self, now: float, signals: list[tuple]) -> None:
        joins: list[tuple[float, int]] = []
        signoffs: list[tuple[float, int]] = []
        stuck_sites: set[int] = set()
        for s in signals:
            kind = s[0]
            if kind == "radius":
                _, key, on, first, bssid, q = s
                site = self.site_of_key(key)
                m = self._set("radius_outage", site, None, key, on, (first, bssid))
                self._update_set(
                    "radius_outage", site, None, m, RADIUS_MIN_CLIENTS, now
                )
            elif kind == "campaign":
                # batch rule: all deauth and disassoc series of a site are one campaign
                _, k, target, on, first, period, n = s
                site = self.site_of_key(target)
                m = self._set(
                    "deauth_campaign", site, None, (k, target), on, (first, period, n)
                )
                self._update_set("deauth_campaign", site, None, m, 1, now)
            elif kind == "stuck":
                _, key, on, first, n, directed = s
                site = self.site_of_key(key)
                st = self.stuck.setdefault(site, {})
                if on:
                    st[key] = (first, n, directed)
                else:
                    st.pop(key, None)
                stuck_sites.add(site)
            elif kind == "ap_ssid":
                _, ap, ssid = s
                self.ap_ssid[ap] = ssid
                stuck_sites |= set(self.stuck)
            elif kind == "assoc_ap":
                _, key, ap = s
                site = self.site_of_key(key)
                self.oui_aps.setdefault((site, self._oui(key)), Counter())[ap] += 1
                if self.stuck.get(site):
                    stuck_sites.add(site)
            elif kind == "signoff":
                _, key, t = s
                signoffs.append((t, key))
            elif kind == "vanished":
                _, key, on, t_off, reason, last = s
                self._single("device_vanished", key, on, now, t_off, 1)
            elif kind == "kick":
                _, key, on, first, counted = s
                self._single("deauth_by_ap", key, on, now, first, counted)
            elif kind == "late":
                _, sensor, sec, n, peak, first, ev = s
                site = sensor // self.n_sens
                st = self.stall.setdefault(
                    (site, sec),
                    {
                        "sensors": set(),
                        "beacons": 0,
                        "peak": 0.0,
                        "first": first,
                        "ev": [],
                    },
                )
                st["sensors"].add(sensor)
                st["beacons"] += n
                st["peak"] = max(st["peak"], peak)
                st["first"] = min(st["first"], first)
                st["ev"].append((sensor,) + ev)
                if len(st["sensors"]) >= STALL_MIN_SENSORS:
                    # batch rule: pauses less than 30 s apart are one incident with several pulses
                    cur = self.stall_inc.get(site)
                    if cur is None or sec - cur["last"] > STALL_MERGE_S:
                        cur = self.stall_inc[site] = {
                            "sub": sec, "last": sec, "secs": {}, "sensors": set(), "first": st["first"],
                        }  # fmt: skip
                    cur["last"] = max(cur["last"], sec)
                    cur["secs"][sec] = st["beacons"]
                    cur["sensors"] |= st["sensors"]
                    cur["first"] = min(cur["first"], st["first"])
                    self._raise(
                        "controller_stall",
                        site,
                        cur["sub"],
                        now,
                        {x: None for x in cur["sensors"]},
                        cur["first"],
                        sum(cur["secs"].values()),
                    )
            elif kind == "join":
                _, key, t = s
                joins.append((t, key))
        for t, key in sorted(joins):
            self._join(self.site_of_key(key), key, t, now)
        for t, key in sorted(signoffs):
            self._signoff(self.site_of_key(key), key, t, now)
        for site in stuck_sites:
            self._stuck_update(site, now)
        for site in list(self.waves):
            w = self.waves[site]
            if w["cur"] and now - w["cur"][-1][0] > self._cut(w):
                self._close_wave(site)
        # forget stall seconds that closed long ago
        for k in [k for k in self.stall if k[1] < now - 10]:
            del self.stall[k]

    def _update_set(
        self, typ: str, site: int, sub, members: dict, need: int, now: float
    ) -> None:
        k = (typ, site, sub)
        if len(members) >= need:
            first = min(v[0] for v in members.values())
            if k not in self.inc:
                self._raise(typ, site, sub, now, members, first, len(members))
            else:
                inc = self.inc[k]
                inc.members, inc.count, inc.active = dict(members), len(members), True
        elif k in self.inc:
            inc = self.inc[k]
            inc.members, inc.count, inc.active = dict(members), len(members), False

    def _single(
        self, typ: str, key: int, on: bool, now: float, evidence_t: float, count: int
    ) -> None:
        k = (typ, self.site_of_key(key), key)
        if on:
            if k not in self.inc:
                self._raise(typ, k[1], key, now, {key: None}, evidence_t, count)
            else:
                inc = self.inc[k]
                inc.count, inc.active = count, True
        elif k in self.inc:
            self.inc[k].active = False

    # ------------------------------------------------------------ devices that cannot connect, per network
    def _oui(self, key: int) -> int:
        return int(self.oui[key % self.n_mac]) if self.oui is not None else -1

    def _network(self, site: int, key: int, directed: int) -> int:
        """Batch rule: the SSID of the device's own probes, else the network most devices of its vendor block join."""
        if directed >= 0:
            return directed
        aps = self.oui_aps.get((site, self._oui(key)))
        if not aps:
            return -1
        nets: Counter = Counter()
        for ap, n in aps.items():
            ssid = self.ap_ssid.get(ap, -1)
            if ssid >= 0:
                nets[ssid] += n
        return max(nets, key=lambda x: (nets[x], -x)) if nets else -1

    def _stuck_update(self, site: int, now: float) -> None:
        by_net: dict[int, dict] = {}
        for key, (first, n, directed) in self.stuck.get(site, {}).items():
            by_net.setdefault(self._network(site, key, directed), {})[key] = (first, n)
        nets = self.stuck_nets.setdefault(site, set())
        nets |= set(by_net)
        for net in nets:
            self._update_set("stuck_scanning", site, net, by_net.get(net, {}), 1, now)

    # ------------------------------------------------------------ sign-off waves
    def _signoff(self, site: int, key: int, t: float, now: float) -> None:
        """Batch rule: from the first open sign-off, >= 5 devices within 10 s are one wave, then start after it."""
        w = self.signoffs.setdefault(site, {"q": [], "n": 0})
        q = w["q"]
        while q and t - q[0][0] > SIGNOFF_WINDOW_S:
            if len(q) >= SIGNOFF_MIN_CLIENTS:
                w["n"] += 1  # the wave is complete, all its members leave the queue
                q.clear()
            else:
                q.pop(0)
        q.append((t, key))
        if len(q) >= SIGNOFF_MIN_CLIENTS:
            self._raise(
                "signoff_wave",
                site,
                w["n"],
                now,
                {k: None for _, k in q},
                q[0][0],
                len(q),
            )

    # ------------------------------------------------------------ join waves
    @staticmethod
    def _cut(w: dict) -> float:
        g = w["gaps"]
        return max(5.0, 3 * g[len(g) // 2]) if g else 5.0

    def _join(self, site: int, key: int, t: float, now: float) -> None:
        w = self.waves.setdefault(site, {"cur": [], "gaps": [], "last": None, "n": 0})
        if w["last"] is not None:
            gap = t - w["last"]
            if w["cur"] and gap > self._cut(w):
                self._close_wave(site)
            bisect.insort(w["gaps"], gap)
        w["last"] = t
        w["cur"].append((t, key))
        if len(w["cur"]) >= WAVE_MIN_CLIENTS:
            self._raise(
                "association_wave",
                site,
                w["n"],
                now,
                {k: None for _, k in w["cur"]},
                w["cur"][0][0],
                len(w["cur"]),
            )

    def _close_wave(self, site: int) -> None:
        w = self.waves[site]
        if len(w["cur"]) >= WAVE_MIN_CLIENTS:
            w["n"] += 1
        w["cur"] = []

    def finish(self) -> list[Incident]:
        for site in list(self.waves):
            self._close_wave(site)
        return self.alerts


# ---------------------------------------------------------------- runner


def window_bounds(t: np.ndarray, window: float) -> list[tuple[int, int, float]]:
    """(lo, hi, window end) for every window that holds frames, in order."""
    if not len(t):
        return []
    last = int(t[-1] // window)
    edges = np.searchsorted(t, np.arange(last + 2) * window, side="left")
    return [
        (int(edges[k]), int(edges[k + 1]), (k + 1) * window) for k in range(last + 1)
    ]


def rss_mb() -> float | None:
    """Peak resident memory of this process (Linux / macOS)."""
    try:
        import resource

        v = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return round(v / 1024 if sys.platform != "darwin" else v / 1024 / 1024, 1)
    except (ImportError, AttributeError):
        return None


def run(table: Table, dedup: bool = True) -> dict:
    """Replay one table through one partition and the reducer, window by window."""
    part = Partition(table.bc, dedup=dedup)
    red = Reducer(len(table.macs), len(table.sensors), table.oui)
    lat = []
    t_all = time.perf_counter()
    t_max = table.duration
    for lo, hi, end in window_bounds(table.cols["t"], table.window):
        t0 = time.perf_counter()
        now = min(end, t_max)
        c = {k: v[lo:hi] for k, v in table.cols.items()}
        red.feed(now, part.step(c, now))
        lat.append(time.perf_counter() - t0)
    red.feed(t_max, part.finish(t_max))
    alerts = red.finish()
    wall = time.perf_counter() - t_all
    state_bytes = len(pickle.dumps(part, protocol=pickle.HIGHEST_PROTOCOL))
    lat_ms = np.array(lat) * 1000 if lat else np.zeros(1)
    return {
        "alerts": alerts,
        "frames": table.n,
        "seconds": wall,
        "frames_per_s": table.n / max(wall, 1e-9),
        "windows": len(lat),
        "window_ms": {
            "p50": float(np.percentile(lat_ms, 50)),
            "p95": float(np.percentile(lat_ms, 95)),
            "max": float(lat_ms.max()),
        },
        "state_kb": round(state_bytes / 1024, 1),
        "keys": {
            "radius": len(part.radius),
            "series": len(part.series),
            "trace": len(part.trace),
            "joined": len(part.assoc_ok),
            "sensors": len(part.sensor_rows),
        },  # fmt: skip
    }


# ---------------------------------------------------------------- report and comparison


LABEL = {
    "radius_outage": "Login server does not answer (802.1X)",
    "deauth_campaign": "Kick campaign",
    "stuck_scanning": "Devices cannot find their network",
    "device_vanished": "Device disconnected itself, silent 5 min",
    "deauth_by_ap": "AP kicks one device",
    "controller_stall": "All APs pause at the same time",
    "association_wave": "Join wave",
    "signoff_wave": "Sign-off wave",
}


def describe(inc: Incident, table: Table) -> dict:
    macs, n_mac = table.macs, len(table.macs)

    def mac(k: int) -> str:
        return str(macs[k % n_mac])

    network = None
    if inc.type == "stuck_scanning":
        network = (
            table.ssids[inc.sub]
            if 0 <= inc.sub < len(table.ssids)
            else "unknown network"
        )
    out = {
        "type": inc.type,
        "label": LABEL[inc.type] + (f" ({network})" if network else ""),
        "site": inc.site,
        "affected": inc.count,
        "evidence_t": round(inc.evidence_t, 3),
        "alert_t": round(inc.alert_t, 3),
        "time_to_alert_s": round(inc.alert_t - inc.evidence_t, 1),
        "active_at_end": inc.active,
    }
    if inc.type == "radius_outage":
        out["aps"] = len({v[1] for v in inc.members.values() if v[1] >= 0})
    if inc.type in ("device_vanished", "deauth_by_ap"):
        out["client"] = mac(inc.sub)
    if inc.type == "controller_stall":
        out["second"] = inc.sub
        out["sensors"] = len(inc.members)
    if network:
        out["network"] = network
    return out


def _batch_key(f: dict) -> tuple:
    t = f["type"]
    if t == "stuck_scanning":
        return (
            t,
            next((a.get("network") for a in f.get("affected") or []), None)
            or "unknown network",
        )
    if t in ("device_vanished", "deauth_by_ap"):
        return (t, f.get("client"))
    if t == "controller_stall":
        return (t, round(f["t_start"] + 0.5))
    if t in ("association_wave", "signoff_wave"):
        return (t, round(f["t_start"]))
    return (t,)


def _stream_key(d: dict) -> tuple:
    t = d["type"]
    if t == "stuck_scanning":
        return (t, d["network"])
    if t in ("device_vanished", "deauth_by_ap"):
        return (t, d["client"])
    if t == "controller_stall":
        return (t, round(d["second"]))
    if t in ("association_wave", "signoff_wave"):
        return (t, round(d["evidence_t"]))
    return (t,)


def compare(
    stream: list[dict], batch_findings: list[dict], tol_s: float = 3.0
) -> list[dict]:
    """Pair every batch finding with a stream alert of the same type and key; report both counts."""
    rows, used = [], set()
    for f in batch_findings:
        bk = _batch_key(f)
        match = None
        for i, d in enumerate(stream):
            if i in used or d["type"] != f["type"]:
                continue
            sk = _stream_key(d)
            if sk == bk or (
                len(bk) == 2
                and isinstance(bk[1], (int, float))
                and abs(sk[1] - bk[1]) <= tol_s
            ):
                match = i
                break
        batch_n = len(f.get("affected") or []) or f.get("count", 1)
        if f["type"] in (
            "controller_stall",
            "association_wave",
            "deauth_by_ap",
            "signoff_wave",
        ):
            batch_n = f.get("count")
        row = {
            "type": f["type"],
            "batch_title": f["title"],
            "batch_affected": batch_n,
            "batch_t_start": round(f["t_start"], 1),
        }
        if match is not None:
            used.add(match)
            d = stream[match]
            row |= {
                "stream_affected": d["affected"],
                "time_to_alert_s": d["time_to_alert_s"],
                "same": d["affected"] == batch_n,
            }
        else:
            row |= {"stream_affected": None, "time_to_alert_s": None, "same": False}
        row["batch_only"] = f["type"] in BATCH_ONLY
        rows.append(row)
    for i, d in enumerate(stream):
        if i not in used:
            rows.append(
                {
                    "type": d["type"],
                    "batch_title": None,
                    "batch_affected": None,
                    "stream_affected": d["affected"],
                    "time_to_alert_s": d["time_to_alert_s"],
                    "same": False,
                    "batch_only": False,
                }
            )
    return rows


def load_raw(
    folder: Path, cache: Path | None
) -> tuple[pd.DataFrame, list[str], float, bool]:
    """Ingest with tshark, or read the frame table that an earlier run cached. Returns (raw, files, s, cached)."""
    from app.airframe.ingest import find_captures, read_all

    paths = find_captures(folder)
    if not paths:
        raise SystemExit(f"no capture files in {folder}")
    files = [p.name for p in paths]
    stamp = "-".join(f"{p.name}:{p.stat().st_size}" for p in paths)
    cache_file = None
    if cache is not None:
        cache.mkdir(parents=True, exist_ok=True)
        cache_file = cache / f"raw-{hashlib.sha1(stamp.encode()).hexdigest()[:12]}.pkl"
        if cache_file.exists():
            t0 = time.perf_counter()
            raw = pd.read_pickle(cache_file)
            return raw, files, time.perf_counter() - t0, True
    t0 = time.perf_counter()
    raw = read_all(paths)
    dt = time.perf_counter() - t0
    if cache_file is not None:
        raw.to_pickle(cache_file)
    return raw, files, dt, False


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("folder", type=Path)
    ap.add_argument("--cache", type=Path, default=Path(tempfile.gettempdir()) / "airframe-cache",
                    help="folder for the ingested frame table (reused by later runs)")  # fmt: skip
    ap.add_argument("--no-cache", action="store_true")
    ap.add_argument(
        "--batch", action="store_true", help="also run the batch pipeline and compare"
    )
    ap.add_argument("--json", type=Path, help="write the full report as JSON")
    a = ap.parse_args()

    raw, files, t_ingest, cached = load_raw(a.folder, None if a.no_cache else a.cache)
    t0 = time.perf_counter()
    table = prepare(raw)
    t_prep = time.perf_counter() - t0
    res = run(table)
    alerts = [describe(i, table) for i in res["alerts"]]
    alerts.sort(key=lambda d: d["alert_t"])

    print(
        f"frames {table.n:,} from {len(files)} files, {table.duration:.0f} s of capture, alignment: {table.alignment}"
    )
    print(
        f"ingest {'(cache read)' if cached else '(tshark)'} {t_ingest:.1f} s, prepare {t_prep:.1f} s"
    )
    print(
        f"stream stage: {res['frames_per_s']:,.0f} frames/s ({res['seconds']:.1f} s for {res['windows']} windows of {table.window:.0f} s), "
        f"window processing p50 {res['window_ms']['p50']:.1f} ms, p95 {res['window_ms']['p95']:.1f} ms, max {res['window_ms']['max']:.1f} ms"
    )
    print(
        f"detector state {res['state_kb']} KB, keys {res['keys']}, peak RSS {rss_mb()} MB (includes the frame table)"
    )
    print()
    print(
        f"{'alert at':>9} {'1st evidence':>12} {'time to alert':>13}  {'n':>4}  incident"
    )
    for d in alerts:
        extra = f" {d.get('client', '')}" if "client" in d else ""
        end = "" if d["active_at_end"] else "  (retracted later)"
        print(
            f"{d['alert_t']:9.1f} {d['evidence_t']:12.1f} {d['time_to_alert_s']:12.1f}s  {d['affected']:4}  {d['label']}{extra}{end}"
        )

    report = {
        "files": files,
        "frames": table.n,
        "capture_s": table.duration,
        "ingest_s": round(t_ingest, 2),
        "ingest_cached": cached,
        "prepare_s": round(t_prep, 2),
        "stream": {k: v for k, v in res.items() if k != "alerts"},
        "peak_rss_mb": rss_mb(),
        "alerts": alerts,
    }
    if a.batch:
        from app.airframe.pipeline import analyze_frames

        t0 = time.perf_counter()
        result, _ = analyze_frames(raw, files)
        report["batch_s"] = round(time.perf_counter() - t0, 1)
        rows = compare([d for d in alerts if d["active_at_end"]], result["findings"])
        report["comparison"] = rows
        print(f"\nbatch pipeline (fuse + detect) {report['batch_s']} s. Comparison:")
        print(f"{'type':18} {'batch':>6} {'stream':>6}  same  batch title")
        for r in rows:
            print(
                f"{r['type']:18} {str(r['batch_affected']):>6} {str(r['stream_affected']):>6}  {'yes ' if r['same'] else ('n/a ' if r['batch_only'] else 'NO  ')}  {r['batch_title'] or '(stream only)'}"
            )
    if a.json:
        a.json.write_text(json.dumps(report, indent=2, default=str), encoding="utf-8")


if __name__ == "__main__":
    main()
