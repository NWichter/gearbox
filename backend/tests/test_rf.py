"""RF detector on small in-memory frame tables (not a dataset: a few thousand rows built in the test)."""

import numpy as np
import pandas as pd

from app.airframe import detect, rf

AP = "00:0b:86:01:00:00"
CLIENTS = ["3c:58:c2:00:00:01", "3c:58:c2:00:00:02", "3c:58:c2:00:00:03"]


def frames(
    noise_event: bool, load_event: bool = False, seconds: int = 600
) -> pd.DataFrame:
    """One sensor on channel 36: an AP and 3 clients, 20 frames/s. Optionally 40 s of raised noise."""
    rng = np.random.default_rng(7)
    step = 0.05
    t = np.arange(0, seconds, step)
    ta = np.array(([AP] + CLIENTS) * (len(t) // 4 + 1))[: len(t)]
    noise = rng.choice([-97.0, -96.0, -95.0], size=len(t))
    retry = (rng.random(len(t)) < 0.05).astype(float)
    rate = np.full(len(t), 54.0)
    hot = (t >= 300) & (t < 340)
    if noise_event:
        noise[hot] = -84.0
        retry[hot] = (rng.random(hot.sum()) < 0.5).astype(float)
        rate[hot] = 12.0
    df = pd.DataFrame(
        {
            "sensor": "sensor01",
            "channel": 36.0,
            "t": t,
            "kind": "qos_data",
            "retry": retry,
            "rssi": -70.0,
            "noise": noise,
            "rate": rate,
            "ta": ta,
            "bssid": AP,
            "cu": np.nan,
            "frame": np.arange(1, len(t) + 1),
        }
    )
    if (
        load_event
    ):  # the same period with three times the frames: Wi-Fi load explains the retries
        extra = df[hot].copy()
        df = pd.concat(
            [df, extra, extra.assign(t=extra["t"] + 0.01)], ignore_index=True
        ).sort_values("t")
    return df.reset_index(drop=True)


def run(df: pd.DataFrame):
    stats = detect.window_stats(df, 5.0)
    return rf.interference(df, stats, {AP}, {AP: "TESLA-CORP"}, 5.0)


def test_flat_noise_gives_nothing():
    findings, anomalies = run(frames(noise_event=False))
    assert findings == []
    assert anomalies == []


def test_noise_rise_with_suffering_transmitters_is_interference():
    findings, anomalies = run(frames(noise_event=True))
    assert len(anomalies) == 1
    assert len(findings) == 1
    f = findings[0]
    assert f.type == "rf_interference"
    assert f.channel == 36
    assert 295 <= f.t_start <= 300 and 340 <= f.t_end <= 345
    assert f.count == 4  # the AP and the 3 clients suffer
    assert f.wireshark_filter.startswith(
        "wlan_radio.channel == 36 && wlan_radio.noise_dbm >= "
    )
    assert f.title.startswith(
        "A source that is not Wi-Fi disturbs channel 36 near sensor01"
    )
    assert ";" not in f.detail and ";" not in f.recommendation


def test_noise_rise_explained_by_load_is_not_a_finding():
    findings, anomalies = run(frames(noise_event=True, load_event=True))
    assert len(anomalies) == 1
    assert anomalies[0]["explained_by_load"] is True
    assert findings == []


def test_recurring_needs_two_days():
    # a single 30-minute capture never gives a recurring pattern
    assert rf.recurring([], [], t0_epoch=1789561451.5, duration_s=1800) == []
