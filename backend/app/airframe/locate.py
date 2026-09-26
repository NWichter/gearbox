"""Relative positions of sensors, access points and devices from signal strength.

No floor plan is given, so positions are estimated, not measured:
- Signal strength falls with distance (log-distance model): d = 10 ** ((P0 - rssi) / (10 * n)).
- Devices search on every channel, so several sensors hear the same device. Each (device, sensor)
  pair gives an estimated distance; the sensors that hear a device loudly are close to it and to
  each other. That ties the eight sensors together even though each sensor sits on its own channel.
- Only devices heard by at least two sensors are placed. One sensor gives a distance, not a
  position: the device could be anywhere on a circle around it, and an edge that cannot pin anything
  down only adds noise to the layout. Such devices are left out of the result entirely.
- An access point is heard by the one sensor on its channel, so it is placed at its estimated
  distance from that sensor, pulled toward the devices it serves.
- The layout is the 2D arrangement whose distances best match all estimates (stress minimisation).

The result is a relative map (units ~ metres under the model): good for "which devices and APs are
near which sensor" and for clustering incidents in space, not for pinpointing a desk.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

P0 = -38.0  # dBm at 1 m (typical 5 GHz client/AP)
N_EXP = 3.0  # path-loss exponent for a hall with metal
MIN_SENSORS = 2  # sensors that must hear a device before it gets a position


def rssi_to_m(rssi: float) -> float:
    return float(10 ** ((P0 - rssi) / (10 * N_EXP)))


def _stress_layout(
    n: int, edges: list[tuple[int, int, float, float]], seed: int = 7, iters: int = 400
) -> np.ndarray:
    """Gradient descent on weighted stress sum w * (|xi - xj| - d)^2."""
    rng = np.random.default_rng(seed)
    x = rng.normal(0, 30, size=(n, 2))
    if not edges:
        return x
    ei = np.array([e[0] for e in edges])
    ej = np.array([e[1] for e in edges])
    d = np.array([e[2] for e in edges])
    w = np.array([e[3] for e in edges])
    lr = 0.05
    for step in range(iters):
        diff = x[ei] - x[ej]
        dist = np.linalg.norm(diff, axis=1) + 1e-9
        g = (w * (dist - d) / dist)[:, None] * diff
        grad = np.zeros_like(x)
        np.add.at(grad, ei, g)
        np.add.at(grad, ej, -g)
        x -= lr * grad / max(1.0, float(np.abs(grad).max()) / 5)
        if step == iters // 2:
            lr *= 0.5
    return x - x.mean(axis=0)


def layout(raw: pd.DataFrame, aps: pd.DataFrame, ap_set: set[str]) -> dict:
    r = raw[raw["rssi"].notna() & raw["ta"].notna()]
    sensors = sorted(raw["sensor"].unique())
    # device -> sensor: median signal of the device's own frames (probe requests and uplink)
    dev = r[~r["ta"].isin(ap_set) & (r["ta"] != "ff:ff:ff:ff:ff:ff")]
    dev = dev[dev["ta"].str.len() == 17]
    dev_sig = (
        dev.groupby(["ta", "sensor"])["rssi"].agg(["median", "size"]).reset_index()
    )
    dev_sig = dev_sig[dev_sig["size"] >= 2]
    # a position needs at least two distances; single-sensor devices stay out of the layout
    n_sensors = dev_sig.groupby("ta")["sensor"].transform("nunique")
    dev_sig = dev_sig[n_sensors >= MIN_SENSORS]
    # AP -> sensor: median beacon signal
    ap_sig = (
        r[r["ta"].isin(ap_set) & (r["kind"] == "beacon")]
        .groupby(["ta", "sensor"])["rssi"]
        .median()
        .reset_index()
    )

    devices = sorted(dev_sig["ta"].unique())
    ap_list = sorted(ap_sig["ta"].unique())
    idx = {f"s:{s}": i for i, s in enumerate(sensors)}
    for m in devices:
        idx[f"d:{m}"] = len(idx)
    for b in ap_list:
        idx[f"a:{b}"] = len(idx)

    edges: list[tuple[int, int, float, float]] = []
    for row in dev_sig.itertuples():
        # louder = more reliable distance estimate
        edges.append(
            (
                idx[f"d:{row.ta}"],
                idx[f"s:{row.sensor}"],
                rssi_to_m(row.median),
                1.0 + (row.median + 95) / 20,
            )
        )
    for row in ap_sig.itertuples():
        edges.append(
            (
                idx[f"a:{row.ta}"],
                idx[f"s:{row.sensor}"],
                rssi_to_m(row.rssi),
                2.0,
            )
        )
    # keep the devices of one AP near their AP (association = they can hear each other)
    assoc = raw[
        raw["kind"].isin(["assoc_resp", "reassoc_resp"]) & raw["ta"].isin(ap_set)
    ]
    for ap_b, m in assoc[["ta", "ra"]].drop_duplicates().itertuples(index=False):
        if f"d:{m}" in idx and f"a:{ap_b}" in idx:
            edges.append((idx[f"d:{m}"], idx[f"a:{ap_b}"], 15.0, 0.3))
    # the networks (BSSIDs) of one radio are the same box on the ceiling
    # grouped only when the prefix matches, they share a channel and each carries a different SSID
    ssid = dict(zip(aps["bssid"], aps["ssid"]))
    ch = dict(zip(aps["bssid"], aps["channel"])) if "channel" in aps else {}
    groups: dict[tuple, list[str]] = {}
    for b in ap_list:
        groups.setdefault((b[:14], ch.get(b)), []).append(b)
    by_radio: dict[str, list[str]] = {}
    for (prefix, _), bs in groups.items():
        names = [ssid.get(b) for b in bs]
        if len(bs) > 1 and len(set(names)) == len(names):
            by_radio[prefix if prefix not in by_radio else bs[0]] = bs
        else:
            for b in bs:
                by_radio[b] = [b]
    for bs in by_radio.values():
        for b in bs[1:]:
            edges.append((idx[f"a:{bs[0]}"], idx[f"a:{b}"], 0.5, 5.0))
    # weak repulsion between sensors so unconnected ones do not collapse onto each other
    for i in range(len(sensors)):
        for j in range(i + 1, len(sensors)):
            edges.append((i, j, 60.0, 0.05))

    x = _stress_layout(len(idx), edges)
    pos = {
        k: (round(float(x[i, 0]), 1), round(float(x[i, 1]), 1)) for k, i in idx.items()
    }
    heard_by = dev_sig.groupby("ta")["sensor"].agg(lambda s: sorted(s))
    # median dBm per sensor: the loudest sensor is the robust location statement ("near S5")
    dev_rssi: dict[str, dict[str, float]] = {}
    for row in dev_sig.itertuples():
        dev_rssi.setdefault(row.ta, {})[row.sensor] = round(float(row.median), 1)
    ap_rssi: dict[str, dict[str, float]] = {}
    for row in ap_sig.itertuples():
        ap_rssi.setdefault(row.ta, {})[row.sensor] = round(float(row.rssi), 1)
    ch_of = raw.groupby("sensor")["channel"].agg(
        lambda c: int(c.mode().iat[0]) if c.notna().any() else None
    )
    # vendor numbering scheme (00:0b:86:NN:00:xx): name radios "AP NN"; otherwise the BSSID tail
    numbered = len({bs[0].split(":")[3] for bs in by_radio.values()}) == len(by_radio)

    def label(b: str) -> str:
        return f"AP {b.split(':')[3]}" if numbered else f"AP {b[-5:]}"

    return {
        "model": {"p0_dbm": P0, "path_loss_exponent": N_EXP, "unit": "m (estimated)"},
        "sensors": [
            {
                "id": s,
                "channel": ch_of.get(s),
                "x": pos[f"s:{s}"][0],
                "y": pos[f"s:{s}"][1],
            }
            for s in sensors
        ],
        # one entry per physical radio; its networks listed (e.g. TESLA-CORP and TESLA-TOOLS)
        "aps": [
            {
                "radio": radio,
                "label": label(bs[0]),
                "bssids": bs,
                "ssids": sorted({ssid.get(b) for b in bs if ssid.get(b)}),
                "x": pos[f"a:{bs[0]}"][0],
                "y": pos[f"a:{bs[0]}"][1],
                "rssi": ap_rssi.get(bs[0], {}),
            }
            for radio, bs in sorted(by_radio.items())
        ],
        "devices": [
            {
                "mac": m,
                "x": pos[f"d:{m}"][0],
                "y": pos[f"d:{m}"][1],
                "sensors": heard_by.get(m, []),
                "rssi": dev_rssi.get(m, {}),
            }
            for m in devices
        ],
    }
