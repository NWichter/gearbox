# Forensic scripts

Scripts the team used to read Tesla's captures by hand and to hunt for easter eggs. They are not part of the Gearbox pipeline. Results: [`docs/12-easter-eggs.md`](../../docs/12-easter-eggs.md) and the detection notes in [`docs/04-data.md`](../../docs/04-data.md).

## Get the captures

The pcaps are in `data/tesla/` as Git LFS objects. A normal clone skips them (see `.lfsconfig`), so deployments do not use LFS bandwidth. Fetch them once:

```bash
git lfs pull --include "data/tesla/*" --exclude ""
cd data/tesla && sha256sum -c SHA256SUMS
```

## Run

tshark only exists in the backend image, so run the scripts there with the captures mounted at `/data`:

```bash
docker build -f backend/Dockerfile -t gearbox-api .
docker run --rm -v "$PWD/data/tesla:/data" -v "$PWD/tools/forensics:/w" --entrypoint python gearbox-api /w/stats.py
```

| Script | What it does |
| --- | --- |
| `load.py`, `ev.py` | Load the tshark fields of all sensors into one DataFrame (shared by the others) |
| `stats.py`, `topo.py` | Frame counts per type and sensor, AP radios, BSSIDs, SSIDs, channels |
| `time.py`, `tl.py`, `timeline.txt` | Clock offsets and drift from the beacon TSF, event timeline |
| `beacon.py`, `b2.py`–`b4.py` | Beacon gaps and lateness (controller stalls) |
| `eapol.py` | 802.1X / EAP and 4-way handshake sequences (RADIUS outage) |
| `deauth.py` | Deauth and disassoc campaigns, periods, reason codes |
| `probe.py`, `pr.py`, `pr2.py` | Probe requests and responses (devices that cannot find their network) |
| `roam.py`, `rate.py`, `rf.py` | Roaming, data rates, signal and noise |
| `strs.py`, `w.py`, `cli.py` | Raw string scan and per-client helpers |
| `easter_eggs/field_sweep.py` | Distinct and rare values of 49 fields over every frame (`python field_sweep.py <pcap> <out.json>`) |
| `easter_eggs/codex_pcap_parser.py` | Codex's independent pcap parser (stdlib only, run it in `data/tesla/`) |
| `easter_eggs/codex_prompt.txt` | The prompt we gave Codex for its independent hunt |
