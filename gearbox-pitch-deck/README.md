# Gearbox pitch deck (slides in the app's style)

A third pitch build next to the film (`airframe-pitch-film/`, `airframe-pitch-full/`): 21 slides in
the look of the Gearbox app (Inter + JetBrains Mono, the app's accent colours and header) on the
cover's black background, so the slides continue the film's dark look; only the live demo stays light, opened by a cover slide with the cold open of the pitch film. It follows the team's hand-drawn storyboard (tool on the line → Wi-Fi lost → line stops →
sensor → five connection steps → 30 access points → merge the sensors → the logic → demo →
priorities → reliability). Slide 15 embeds the **live server** (`https://bmt26.skimu.de/final`, the
presentation dashboard) in the page.

## Two versions

| File | Slides | Use |
| --- | --- | --- |
| `pitch-deck.html` | cover + 20 | full deck (Q&A, reading, sending) · https://bmt26.skimu.de/pitch-deck.html |
| `pitch-deck-5min.html` | cover + 12 | **the 5-minute pitch** · https://bmt26.skimu.de/pitch-deck-5min.html |
| `pitch-deck-5min-film.html` | cover + 2 film slides + 10 | the 5-minute pitch with the 3D film act as the problem part (self-contained, see below) |

The 5-minute version keeps every technical core slide: line stops → €50,000/min → "we need to know
why" → five connection steps (sensor) → the step shows the cause → merge 8 sensors on one clock →
the logic (three questions, 4 real cases, radio and attacker ruled out) → pipeline sum-up → live
demo → 16 fault classes → what makes each link reliable → close. Cut: running line, "still
stands", sensor scene, 30 APs, device web, device types, priorities (the demo shows them),
"every link has to hold". Speaker notes (N) carry target times: about 4:25, 35 s buffer. Both files
are self-contained; a change to the full deck is not copied into the 5-minute deck automatically.

## 5-minute deck with the film act (`pitch-deck-5min-film.html`)

The 5-minute deck, but the problem part (slides 2–4) is a 3D film (canvas, runs in the cover iframe):

| Slide | Film scene | What happens |
| --- | --- | --- |
| cover | `cover` | the hall at night, the line runs, title "by Gearbox" |
| 2 | `station` | one click: the camera flies into the hall (access points, devices, sensors, messages fade in, no text), lands at station 14. Screws 1–3 are confirmed, T-03 says "leaving · 12:36:32", screw 4 gets no reply, the line stops: "No Wi-Fi, no confirmed screw. The line stops." Holds until the next click. |
| 3 | `impact` | pull-back, the jam runs up the line, the ticker lands on €885,000.00 at 17:42, "Nobody was alerted." |
| 4 → | – | the deck's slides from "We must know when a connection breaks, and why." on (the film stays blurred behind that slide) |

Speaker notes are shifted by +22 s: about 4:47, 13 s buffer. The film numbers come from
`airframe-pitch-film/source/airframe-film-data.json`.

The file is self-contained (film and data inlined). Its build sources (`film-source/build.py`,
`film-source/film-act.template.html`) were removed on 26 Sep; to rebuild, restore them with
`git checkout 4a26ede -- gearbox-pitch-deck/film-source`. A change to `pitch-deck-5min.html` is not
copied into the film version automatically.

## Scripts

Online, formatted: https://bmt26.skimu.de/docs/15-pitch-script-5min and
https://bmt26.skimu.de/docs/16-pitch-script-full (copies in `docs/`; after an edit here, copy
the file there again and push).

- [`SCRIPT-5MIN.md`](SCRIPT-5MIN.md) – spoken text for `pitch-deck-5min.html`, with clicks and target times (~4:25), a "if you run late" table and all numbers on one line.
- [`SCRIPT-FULL.md`](SCRIPT-FULL.md) – spoken text for `pitch-deck.html` (~9:30), plus short answers to likely questions.

## Start

Online: **https://bmt26.skimu.de/pitch-deck.html** (a copy in `frontend/public/`; after a change,
copy `pitch-deck.html` there again and push).
Link previews (WhatsApp etc.) use the Open Graph tags in the `<head>` and the image
`frontend/public/pitch-deck-preview.jpg` (1200×630, the cover), served at
https://bmt26.skimu.de/pitch-deck-preview.jpg.

**`pitch-deck.html` is the whole presentation in one file** (cover animation, slides, icons, notes).
Send only this file. It needs internet for the fonts (system fonts otherwise) and for the live demo.


1. Open `pitch-deck.html` in Chrome.
2. **F** = full screen. Click, →, Space or Page Down (clicker) = next; ←, Page Up = back.
3. Slide 15 shows the live `/final` dashboard full screen. Above it is only a slim bar with
   **‹ Back**, **Reload** and **Next ›**. Keys typed inside the dashboard stay there: **move the
   mouse off the page** (or click **Next ›**) and the clicker works again.

| Key | Action |
| --- | --- |
| Click/tap right half, →, Space, Page Down | next step / next slide |
| Click/tap left half, ←, Page Up, right click | back |
| Swipe left / right (phone) | next / back |
| F | full screen |
| N | speaker notes (bottom drawer) |
| D | jump to the demo |
| digits + Enter | jump to a slide (e.g. `15` Enter) |
| B or . | black screen |
| Home / End | first / last slide |
| Click a section in the header | jump to its first slide (Problem 2, Idea 6, Challenge 10, Solution 13, Demo 15, Priorities 16, Reliability 19) |

`pitch-deck.html?app=http://localhost:3000` points the demo at a local app instead.

## Slides

| # | Storyboard | On screen |
| --- | --- | --- |
| 1 | cover (before the pitch) | the film's cold open: stopped factory (no EUR counter), "Tackling the Factory Wi-Fi Reliability Problem – by Gearbox" |
| 2 | car on the conveyor, screw check | running line, tool T-03 reports every screw |
| 3 | Wi-Fi lost, line stops | same scene, link cut, screw 4 waits |
| 4 | extra slide: cost | EUR counter since the stop, €50,000 per minute (`SCENARIO`) |
| 5 | extra slide: slide 2 again | still stopped, counter in the corner, "nobody knows why" |
| 6 | we need to detect it | statement |
| 7 | sensor | same scene with the sensor listening |
| 8 | levels of communication | five steps; tool T-01 finds its network, then nothing (2 clicks) |
| 9 | which step broke | four real causes by step: AP off, login server, controller kicks, tool switched off (4 clicks) |
| 10 | not one system, 30 | the 30 access points of the capture, each with its two networks |
| 11 | cross connections | devices hear many APs; each stays on one; one AP off (2 clicks) |
| 12 | merge the sensor records | 8 sensor clocks → one clock → one story per device (2 clicks) |
| 13 | the logic (added for the jury) | three questions per break: which step never comes, how far it spreads, who sent the last frame → cause; 4 real cases; why not radio, why not an attacker (4 clicks) |
| 14 | sum it up | sensors → Gearbox (fuse, follow, find, group, route) → 11 incidents |
| 15 | software demo | live server (`/final`) in the page |
| 16 | different error pictures | 27 tools, 37 phones, 35 laptops and their faults |
| 17 | tools first | findings ranked by line risk with owner (like the app's rail) |
| 18 | all error pictures (optional) | 16 fault classes: 7 found, 9 checked and clean |
| 19 | every component must hold | sensor → records → Gearbox ← server; one link breaks (1 click) |
| 20 | methods per component | tshark, clock check, heartbeat, Kafka, mTLS, evidence re-check, Postgres, Docker, Git (TODAY vs AT SCALE) |
| 21 | our solution | closing line, running scene |

## Cover

The cover (slide 1) is the cold open of the pitch film (`airframe-pitch-film/pitch-film-v1-backup.html`):
the stopped factory and the `SCENARIO` tag (the EUR counter is hidden), cut down to this one scene, started
at once, and titled "Tackling the Factory Wi-Fi Reliability Problem – by Gearbox" (place, date and clock removed).
It is inlined as one string (`COVER_HTML`) and shown through an iframe `srcdoc` only while the cover
is on screen; clicks and keys stay with the deck.

## Numbers

All numbers come from the live API (`/api/datasets/ff1d9f54dee9`, 11 findings, 26 Sep 2026) and
sit as constants at the top of the `<script>` block (`RADIOS`, `RAIL`, `CHECKS`) or in the slide
text. Device types come from the MAC vendor (Raspberry Pi = tool, Apple = phone, Intel = laptop).
"77 of 77 evidence frames" is the result of `airframe-pitch-film/pitch-v3/source/check_evidence.py`.
If a re-analysis changes the findings, update those places by hand. Brand marks on slide 18 are
path data from Simple Icons (CC0), inlined so the deck needs no extra requests.
