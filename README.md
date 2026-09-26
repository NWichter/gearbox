<p align="center">
  <img src="frontend/src/app/icon.svg" width="72" alt="Gearbox logo" />
</p>

<h1 align="center">Gearbox</h1>

<p align="center">
  <b>Every Wi-Fi device is a gear. Keep the machine running.</b><br/>
  Multi-sensor 802.11 monitoring that turns a million header-only frames into a few actionable incidents.<br/>
  Built at <i>Business meets Tech 2026</i> for the Tesla "Airframe" challenge.
</p>

<p align="center">
  <a href="https://gearbox.skimu.de">Live demo</a> ·
  <a href="https://gearbox.skimu.de/architecture">Scale design</a>
</p>

---

## The problem

At a Gigafactory a car leaves the line every minute (≈ 50,000 €). Torque tools, scanners and robots
are on Wi-Fi; a torque tool that drops off cannot confirm its screws, and the car stops.
Tesla records the air with a fleet of sensors, but only **headers** (802.11 management/control and
802.1X/EAP). In 30 minutes that is over a million frames, and **failures hide as breaks in a
sequence, not as one obvious frame**. Nobody can read that in time.

## What Gearbox does

- **Reads every sensor's capture** and follows each client through the connection sequence:
  probe → auth → association → 802.1X/EAP → 4-way handshake → connected.
- **Every break becomes a finding** with a cause: EAP failure loops, handshakes that never
  complete, clients kicked by the AP (reason codes), rejected associations, ping-pong roaming.
- **Uses several sensor views**: aligns sensor clocks via the APs' beacon timestamps (offset and
  drift, works even when every sensor sits on a different channel) and **reports sensor clocks that
  are off or drift** (NTP/PTP broken). Merges duplicates where sensors share a channel; with one
  sensor per channel (Tesla's layout) no frame is heard twice, so de-dup is skipped and sensors
  confirm each other through the same pattern on several channels at once. Tells an AP outage (all
  sensors lose it) from a sensor blind spot (one sensor loses it), locates devices by RSSI.
- **Groups symptoms into incidents with one root cause**: an authentication backend (RADIUS) that
  never answers; one kick campaign (deauth + disassoc phases) on a machine-regular timer, with an
  **origin check** – do the frames continue the AP's own sequence counter and match its beacon
  signal (controller job) or not (forged, attack)?; devices that stay offline because their one AP
  is missing and they never use another (split per network, so tools are not mixed with laptops);
  controller stalls seen on all channels at once (pulses merged); sign-off and join waves.
- **Watches the air itself**: channel congestion, deauth floods with the same origin check,
  evil-twin APs, short-lived networks (easter eggs live there), and the security posture per
  network (shared password without 802.11w).
- **Prioritises by what keeps the line moving**: industrial devices first, phones last.
- **Shows proof**: every finding links to the exact frames (sensor + frame number) – verifiable in Wireshark.
- **Dashboard (`/`) shows only what a person must act on:** a status sentence ("2 problems can
  stop the line"), the most important warnings, and the findings with their details side by side
  (what to do now, for IT, confidence, evidence frames, **Copy Wireshark filter**), and at the
  bottom the **access point grid** from `/it` (on / off the air per network, security, findings per
  access point; selecting one opens its finding). A separate
  **simulation panel** replays the capture and drives the whole page, with a channel strip that
  colours the 8 channels by health at the replay time. Light layout with a "Challenge by Tesla"
  badge; Gearbox is not a Tesla product.
- **Dashboard target design (`/target`)**: a static mockup of the next dashboard (cause board, connection
  ladder "where devices stop", "what we checked" matrix for 17 fault classes, channel strip, schematic hall,
  detail pane with evidence frames and a Wireshark filter), with real numbers from Tesla's capture. A switch
  at the top of `/`, `/it` and `/target` selects the current dashboard, the IT view or the target; the old
  dashboard stays as it is. Source: `frontend/public/mockups/gearbox-dashboard-target.html` (also opens on its own).
- **IT view (`/it`)**: an alternative live dashboard for the IT teams, on the same data and in the same
  look, built to be shown in about one minute of the pitch. Top: how many root causes need a fix and
  for which team, then **from frames to causes** (1,118,853 frame headers → 1 clock for 8 sensors →
  99 devices followed → 11 findings, 9 of 16 fault classes ruled out → 8 need a fix; analysed in
  51 s), key figures (devices affected, networks off the air, access points 29/30, shared-key
  networks) and **where the connections break** (devices per step: find, join, log in, keys, talk,
  plus site-wide findings). Then an incident queue by owner with Acknowledge / Mark as fixed (shared
  with `/floor`); per incident **how Gearbox decides the cause** in three questions from the pitch
  (which step is missing, how far it spreads, who sent the last frame → cause and owner, e.g. "the
  access point itself: 100 % of 1,477 frames continue its own sequence counter → controller job, not
  an attacker"), the root cause, numbered fix steps, the networks off the air, the affected devices,
  the evidence frames, the Wireshark filters and **Copy ticket** (plain text for the service desk).
  Below: a timeline, all access points with their networks, AKM (802.1X / PSK) and 802.11w state, the
  sensor clocks (offset, drift, "fix time sync" above 5 ppm) and the 16 checked fault classes.
  Deep link: `/it?f=4` (demo path: top → `#4` kick campaign → `#3` tools → timeline).
- **Presentation build (`/final`)**: the same dashboard without page tabs. The simulation panel is
  replaced by a thin black replay bar above the header (the height of the header, in the colour of
  the browser toolbar): dataset, play / ±1 min, replay time, time track with finding ticks, channel
  health, speed and "Live". The dataset list shows only the folders under [`data/`](data) (see
  [Data](#data)); everything from "Most important warnings" down is the same as on `/`.
- **Engineering view (`/engineering`)** for the wireless engineer: incident timeline, event and
  channel charts, **RF health** (noise dBm, SNR dB, data rate per channel), channel map, site map,
  sensor fusion, devices and APs.
- **Replays the shift** like a video: play the 30 minutes at 1× to 120×, drag the time track (also
  while it plays) and see which incidents are active at that moment, the last minute of traffic and a
  playhead moving through the incident lanes and charts.
- **Draws a site map from signal strength** (no floor plan needed): sensors, access-point radios
  (each radio once, with all its networks) and devices placed by a log-distance model and stress
  layout ([`locate.py`](backend/app/airframe/locate.py)); coloured by findings, and in the replay it
  shows where the trouble is at that moment. Estimated relative positions, not coordinates.
  The default **zone view** reads the same map honestly: every device and AP is tied to its
  loudest sensor (robust "near S5"), only devices heard by two or more sensors are placed (one
  sensor gives a distance but no direction), hovering shows the ±6 dB uncertainty ring, no metre grid, and a zone list per sensor
  names the worst finding there. The **estimated layout** view keeps the metric best fit.
- **Shows the shop floor** (`/floor`): a full-screen top view of a schematic assembly hall driven by
  the replay – one car per minute of capture, lines stand still while a tools-network problem is
  open. Problems sit where they happen (callout at the device or AP, site-wide ones as a banner); the
  line-risk rail lets the shift lead acknowledge each line-stopping problem and mark it as fixed,
  stored per dataset on the server so every screen shows the same state (`/floor?t=800` jumps to 13:20).
- **Writes a shift report** (`/report`): one page for the supervisor – what can stop the line, what
  to do, what IT already has; copy for Teams/mail, Markdown or print/PDF.
- **Explains** a finding for the shift lead in plain words (LLM, on click, cached).
- **Answers questions** about the site in a chat assistant (bottom right, always in English); questions and answers
  are logged (with thumbs up/down) to improve the site.

## Architecture

```text
 sensor01.pcap ─┐
 sensor02.pcap ─┤  1 INGEST            2 FUSE                  3 DETECT                      4 SERVE
      …         ├─► tshark fields ────► clock alignment ──────► per-client state machines ───► FastAPI + Postgres
 sensor08.pcap ─┘  (per sensor)        de-dup, RSSI/sensor     AP / channel / security        Next.js dashboard
                                       (keyed by transmitter)  (keyed by client/AP/channel)   LLM explanations
```

Every stage is keyed (sensor, transmitter MAC, client/AP/channel), so the partitioning carries over
from today's batch run to a partitioned stream (Kafka keyed by MAC, stateful stream jobs). The batch
detectors read the whole capture; as stream jobs they need time windows, watermarks for late frames
and expiring state. The streaming prototype ([`stream.py`](backend/app/airframe/stream.py)) does this
in 5-s windows and finds the same incidents as the batch run on Tesla's data. Capacity is counted
per frame, not per sensor: Tesla's capture has 78 frames/s per sensor, a busy factory channel
1,000–5,000 (measured, see the [scale design](https://gearbox.skimu.de/architecture)).
Details: [`/architecture`](https://gearbox.skimu.de/architecture).

| Stage                                | Code                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------ |
| Ingest                               | [`backend/app/airframe/ingest.py`](backend/app/airframe/ingest.py)       |
| Fuse                                 | [`backend/app/airframe/fuse.py`](backend/app/airframe/fuse.py)           |
| Detect (per client / AP / channel)   | [`backend/app/airframe/detect.py`](backend/app/airframe/detect.py)       |
| Incidents (cross-client root causes) | [`backend/app/airframe/incidents.py`](backend/app/airframe/incidents.py) |
| Site map (positions from RSSI)       | [`backend/app/airframe/locate.py`](backend/app/airframe/locate.py)       |
| Chat assistant                       | [`backend/app/airframe/chat.py`](backend/app/airframe/chat.py)           |
| Orchestrate / CLI                    | [`backend/app/airframe/pipeline.py`](backend/app/airframe/pipeline.py)   |
| LLM explanation                      | [`backend/app/airframe/explain.py`](backend/app/airframe/explain.py)     |
| API                                  | [`backend/app/main.py`](backend/app/main.py)                             |
| Dashboard                            | [`frontend/src/app`](frontend/src/app)                                   |

## Results so far

| Dataset                  | Sensors                   | Frames | Findings        | Injected faults              |
| ------------------------ | ------------------------- | ------ | --------------- | ---------------------------- |
| Tesla captures (private) | 8 (one per 5 GHz channel) | 1.12 M | 11 (4 critical) | revealed by Tesla at the end |

Throughput on Tesla's captures: ≈ 9–11 k frames/s end to end in one process (details in the [scale design page](https://gearbox.skimu.de/architecture)).
Every evidence frame of every finding is re-checked against the original pcaps with `backend/tools/verify_evidence.py`: 77/77 match on Tesla's captures.

## Data

Tesla's captures are **not** part of this repository (they belong to Tesla). Put the eight pcaps into
`data/tesla/` to run the pipeline or the tests locally.

**Dataset library.** Every folder under `data/` with a `SHA256SUMS` file is one dataset, and
`/final` offers exactly these folders (`GET /api/library`). Only the `SHA256SUMS` files go into the
API image; the server matches a folder to an analysed upload by the SHA-256 of the capture content
(gzip uploads are hashed decompressed). To add a dataset: put its pcaps into `data/<name>/`
(they stay out of git), write `SHA256SUMS` (`cd data/<name> && sha256sum *.pcap >
SHA256SUMS`), and upload it once with `tools/upload_captures.sh data/<name> "<Name>"`. Until
the upload is analysed the folder shows up disabled ("not analysed yet").

The scripts we used to read the captures by hand and to hunt for easter eggs are in
[`tools/forensics/`](tools/forensics). Every step that touches data is scripted and
documented in the scripts below:

```bash
tools/prepare_captures.sh ~/Downloads/hackaton_airframe.zip   # extract pcaps only + SHA256SUMS
tools/upload_captures.sh data/tesla "Tesla"     # gzip (lossless) + upload as a dataset
```

## Run locally

Requirements: Docker, [uv](https://docs.astral.sh/uv/), [bun](https://bun.sh). tshark is only
needed for ingest and ships in the backend image.

```bash
cp .env.example .env                                   # fill in what you need
docker compose -f docker-compose.dev.yml up -d         # Postgres 18 on localhost:5433
cd backend && uv sync && uv run fastapi dev app/main.py
cd frontend && bun install && bun dev                  # http://localhost:3000
```

Analyse a folder from the command line (inside the backend image, which has tshark):

```bash
docker build -f backend/Dockerfile -t airframe-api .
docker run --rm -v "$PWD/data/tesla:/data" --entrypoint python airframe-api -m app.airframe.pipeline /data
```

## Checks and benchmarks

```bash
tools/check.sh            # ruff + 68 fast tests
tools/check.sh --tesla    # + regression on Tesla's captures in Docker (11 findings, 77/77 evidence frames)
python -m app.airframe.stream data/tesla     # streaming mode: time to alert per incident (run in backend/)
python tools/bench_scale.py                  # replay benchmark: 8 → 1,000 virtual sensors, 1–8 workers
```

The API runs the analysis in its own process, so it stays responsive (`/health` p99 50 ms during an
analysis). `GET /health` = process up, `GET /ready` = database reachable; Docker healthchecks use them.
If the LLM fails or no key is set, the explanation falls back to a fixed text (`source: "fallback"`).
Measured numbers: the [scale design page](https://gearbox.skimu.de/architecture).

## Configuration

| Variable                             | Purpose                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------ |
| `DATABASE_URL`                       | Postgres connection (dev default: `localhost:5433`)                      |
| `UPLOAD_DIR`                         | where uploaded captures are stored (image: `/data/uploads`, a volume)    |
| `DATA_DIR`                           | dataset library, one folder with `SHA256SUMS` per dataset (dev: `../data`, image: `/app/library`) |
| `LLM_BASE_URL`                       | OpenAI-compatible endpoint, default OpenRouter                           |
| `LLM_MODEL`                          | default `anthropic/claude-sonnet-5`                                      |
| `LLM_API_KEY` / `OPENROUTER_API_KEY` | key for the LLM endpoint (never commit it)                               |
| `ADMIN_TOKEN`                        | protects `GET /api/chat/log` (header `X-Admin-Token`)                    |
| `SITE_PASSWORD`                      | optional basic auth for the whole site (user `airframe`); unset = public |
| `READ_ONLY`                          | `true` switches off upload and re-analysis (pitch day: nobody can block the single worker) |

## Deploy

Push to `main` → Coolify builds `docker-compose.yml` (web + api) and serves
<https://gearbox.skimu.de>. The frontend proxies `/api/*` to the backend, so there is a single domain.


## Pitch

Two variants, both self-contained HTML files that open by double-click:

- [`gearbox-pitch-deck/pitch-deck-5min-film.html`](gearbox-pitch-deck/pitch-deck-5min-film.html) – **the pitch**: one self-contained HTML file, a 5-minute deck whose problem part is a 3D film act; click through it yourself (→ / Space / click, F = full screen, N = speaker notes). Online: <https://gearbox.skimu.de/pitch-deck-5min-film.html>. Edit the file directly (no build step).

## License

Evaluation licence for the Business meets Tech 2026 hackathon only; any further use needs a
separate agreement. See [`LICENSE`](LICENSE).

## Rules we follow

Header-only analysis. No transmitting on the air. No payload or layer-3 inspection.
