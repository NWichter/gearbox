export type Severity = "critical" | "high" | "medium" | "low" | "info";

export type FrameRef = { sensor: string; frame: number; rssi: number | null };

export type Evidence = {
  t: number;
  what: string;
  kind: string;
  frames: FrameRef[] | null;
};

export type Finding = {
  id: number;
  type: string;
  severity: Severity;
  title: string;
  detail: string;
  t_start: number;
  t_end: number;
  client: string | null;
  bssid: string | null;
  channel: number | null;
  sensors: string[];
  count: number;
  recommendation: string;
  evidence: Evidence[];
  device_class: string | null;
  vendor: string | null;
  closest_sensor: string | null;
  // incidents list every device involved; keys beyond the named ones vary per finding type
  affected?: AffectedDevice[];
  missing_bssids?: string[];
  // supervisor-first playbook (added by the backend; absent in older analyses)
  scope?: string;
  networks?: string[];
  action?: FindingAction;
  confidence?: { level: "high" | "medium" | "low"; reasons: string[] };
  // Wireshark (4.x) display filters (newer backends only)
  wireshark_filter?: string;
  // sensor -> "frame.number in {...}": exactly the evidence frames in that sensor's pcap
  wireshark_frames?: Record<string, string>;
  // missing networks only: this filter must match no frame in any pcap
  wireshark_filter_absent?: string;
  // recurring patterns: one row per day the pattern happened
  occurrences?: Occurrence[];
};

export type Occurrence = { day: string; from: string; to: string; what: string };

// A period in which the noise floor of one sensor/channel sits clearly above its own baseline
export type RfAnomaly = {
  sensor: string;
  channel: number;
  t_start: number;
  t_end: number;
  noise_dbm: number;
  baseline_dbm: number;
  rise_db: number;
  peak_rise_db: number;
  finding?: boolean;
};

export type ActionWho = "you" | "it" | "security" | "report" | "none";
export type Urgency = "red" | "yellow" | "purple" | "grey";

export type FindingAction = {
  who: ActionWho;
  label: string;
  supervisor: string;
  it: string;
  urgency: Urgency;
};

export type AffectedDevice = {
  client?: string;
  vendor?: string;
  device_class?: string;
  bssid?: string | null;
  ap?: string | null;
  [key: string]: unknown;
};

export type Summary = {
  files: string[];
  sensors: number;
  frames: number;
  events: number;
  dedup_ratio: number;
  dedup?: string | null;
  duration_s: number;
  start_epoch: number | null;
  aps: number;
  radios_on_air?: number;
  radios_expected?: number;
  networks?: number;
  devices_total?: number;
  devices_connected?: number;
  devices_heard?: number;
  scale?: {
    frames_per_sensor_s: number;
    pipeline_fps: number;
    sensors_per_worker: number;
    sensors_per_worker_edge_filtered: number;
    sensors_per_worker_at_1000_fps?: number;
    sensors_per_worker_at_2000_fps?: number;
    beacon_share: number;
    replay_speedup: number;
  };
  clients: number;
  findings: number;
  by_severity: Partial<Record<Severity, number>>;
  timing_s: { ingest: number; fuse: number; detect: number };
  frames_per_s: number;
};

export type AP = {
  bssid: string;
  ssid: string | null;
  channel: number | null;
  beacons: number;
  cu_mean: number | null;
  cu_max: number | null;
  clients: number;
  vendor: string;
  findings: number;
  best_sensor: string;
};

export type Client = {
  client: string;
  vendor: string;
  device_class: string;
  events: number;
  bssid: string | null;
  roams: number;
  eap_failures: number;
  deauths: number;
  closest_sensor: string | null;
  best_rssi: number | null;
  findings?: number;
};

export type SensorStat = {
  sensor: string;
  frames: number;
  channels: number[];
  clock_offset_ms: number;
  events_heard: number;
  share_of_all_events: number;
  unique_events: number;
};

export type Result = {
  summary: Summary;
  findings: Finding[];
  aps: AP[];
  clients: Client[];
  sensors: {
    sensors: string[];
    overlap: number[][];
    stats: SensorStat[];
    alignment?: string | null;
    drift_ppm?: Record<string, number>;
  };
  timeline: {
    t: number;
    deauth: number;
    auth: number;
    eap_failure: number;
    handshake: number;
    probe: number;
    retry: number;
  }[];
  channel_timeline: {
    t: number;
    channel: number;
    frames: number;
    retry_ratio: number;
    cu_pct: number | null;
    rts: number;
    // RF values of the loudest sensor on the channel (newer backends only)
    sensor?: string;
    noise_dbm?: number | null;
    signal_dbm?: number | null;
    snr_db?: number | null;
    rate_mbps?: number | null;
  }[];
  // raised-noise periods per sensor/channel, also the ones without a finding (newer backends only)
  rf_anomalies?: RfAnomaly[];
  // estimated relative positions from signal strength (absent in older analyses)
  layout?: SiteLayout;
};

export type SiteLayout = {
  model: { p0_dbm: number; path_loss_exponent: number; unit: string };
  sensors: { id: string; channel: number | null; x: number; y: number }[];
  aps: {
    radio: string;
    label: string;
    bssids: string[];
    ssids: string[];
    x: number;
    y: number;
    // median beacon dBm per sensor (absent in older analyses)
    rssi?: Record<string, number>;
  }[];
  devices: {
    mac: string;
    x: number;
    y: number;
    sensors: string[];
    // median dBm per sensor that heard the device (absent in older analyses)
    rssi?: Record<string, number>;
  }[];
};

export type DatasetInfo = {
  id: string;
  kind?: string;
  name: string;
  status: "queued" | "running" | "done" | "failed";
  error: string | null;
  summary: Summary | null;
  created_at: string;
};

// One folder under the repo's data/ with the analysed dataset it matches (by capture hashes)
export type LibraryEntry = {
  folder: string;
  files: string[];
  dataset_id: string | null;
  name: string;
  status: DatasetInfo["status"] | "missing";
};

export type LadderEvent = {
  t: number;
  kind: string;
  from: string;
  to: string;
  bssid: string | null;
  label: string;
  sensors: string[];
  best_rssi: number | null;
  refs: FrameRef[];
};

export type AckState = "ack" | "done";
// finding id -> state and wall-clock time (ISO) of the last change
export type AckMap = Record<string, { state: AckState; at: string }>;

async function j<T>(r: Response): Promise<T> {
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

export const api = {
  // only captures and uploads are shown; older backends may still list a generated test set
  datasets: () =>
    fetch("/api/datasets", { cache: "no-store" })
      .then(j<DatasetInfo[]>)
      .then((list) => list.filter((d) => d.kind !== "synthetic")),
  library: () =>
    fetch("/api/library", { cache: "no-store" }).then(j<LibraryEntry[]>),
  dataset: (id: string) =>
    fetch(`/api/datasets/${id}`, { cache: "no-store" }).then(
      j<DatasetInfo & { result: Result | null }>,
    ),
  client: (id: string, mac: string) =>
    fetch(`/api/datasets/${id}/clients/${mac}`).then(
      j<{ client: string; events: LadderEvent[] }>,
    ),
  explain: (id: string, fid: number) =>
    fetch(`/api/datasets/${id}/findings/${fid}/explain`, {
      method: "POST",
    }).then(j<{ text: string }>),
  chat: (body: {
    question: string;
    session: string;
    page: string;
    dataset_id: string | null;
    history: { role: "user" | "assistant"; content: string }[];
  }) =>
    fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(j<{ id: string; answer: string; ok: boolean }>),
  chatFeedback: (id: string, helpful: boolean) =>
    fetch(`/api/chat/${id}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ helpful }),
    }).then(j<{ ok: boolean }>),
  // shift-lead acknowledgements per finding, shared by every viewer (newer backends only)
  acks: (id: string) =>
    fetch(`/api/datasets/${id}/acks`, { cache: "no-store" }).then(j<AckMap>),
  ack: (id: string, fid: number, state: AckState | null) =>
    fetch(`/api/datasets/${id}/findings/${fid}/ack`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state }),
    }).then(j<AckMap>),
  upload: (files: File[], name: string) => {
    const fd = new FormData();
    files.forEach((f) => fd.append("files", f));
    fd.append("name", name);
    return fetch("/api/datasets", { method: "POST", body: fd }).then(
      j<{ id: string }>,
    );
  },
};

export const SEVERITIES: Severity[] = [
  "critical",
  "high",
  "medium",
  "low",
  "info",
];

// Badge style per severity. Light theme: greys only (colour is kept for urgency).
// Dark theme (shop floor): flat tint, coloured text.
export const SEVERITY_STYLE: Record<Severity, string> = {
  critical:
    "bg-foreground text-background dark:bg-red-500/15 dark:text-red-300",
  high: "bg-zinc-200 text-zinc-900 dark:bg-orange-500/15 dark:text-orange-300",
  medium:
    "bg-zinc-100 text-zinc-700 dark:bg-amber-500/12 dark:text-amber-300",
  low: "bg-zinc-100 text-zinc-500 dark:bg-blue-500/12 dark:text-blue-300",
  info: "border-border bg-transparent text-zinc-500 dark:border-transparent dark:bg-zinc-500/15 dark:text-zinc-400",
};

// Solid colour per severity for dots, bars and chart marks
export const SEVERITY_COLOR: Record<Severity, string> = {
  critical: "#ef4444",
  high: "#f97316",
  medium: "#f59e0b",
  low: "#60a5fa",
  info: "#71717a",
};

export const SEVERITY_HINT: Record<Severity, string> = {
  critical: "Large effect now. Many devices or a tool lose the connection.",
  high: "Production Wi-Fi is worse. Repair it during this shift.",
  medium: "Some devices have problems. Plan a repair.",
  low: "Small or local effect. Monitor it.",
  info: "Information only. No action is necessary.",
};

export const TYPE_LABEL: Record<string, string> = {
  eap_failure: "802.1X / EAP",
  handshake_failure: "4-way handshake",
  deauth_by_ap: "Kicked by AP",
  assoc_rejected: "Association",
  ping_pong_roaming: "Roaming",
  excessive_roaming: "Roaming",
  ap_silent: "AP outage",
  congestion: "Congestion",
  deauth_flood: "Security",
  rogue_ap: "Security",
  transient_network: "Odd network",
  sensor_blind_spot: "Sensor view",
  radius_outage: "802.1X backend",
  deauth_campaign: "Kick campaign",
  stuck_scanning: "Missing AP",
  association_wave: "Join wave",
  controller_stall: "Controller stall",
  device_vanished: "Device gone",
  rf_interference: "RF interference",
  recurring_pattern: "Recurring",
  sensor_clock: "Sensor clocks",
  signoff_wave: "Sign-off wave",
  weak_security: "Security",
};

export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

// Most severe finding of a list (first one wins on a tie); info findings can be skipped
export function worstFinding(
  fs: Finding[],
  skipInfo = false,
): Finding | null {
  let w: Finding | null = null;
  for (const f of fs)
    if (
      !(skipInfo && f.severity === "info") &&
      (!w || SEVERITY_RANK[f.severity] < SEVERITY_RANK[w.severity])
    )
      w = f;
  return w;
}

export function worstSeverity(fs: Finding[]): Severity | null {
  return worstFinding(fs)?.severity ?? null;
}

// Which dataset to open: the preferred one if it is finished, else the first finished, else any
export function pickDataset(
  list: DatasetInfo[],
  preferred?: string | null,
): string | null {
  const done = list.filter((d) => d.status === "done");
  return (
    (preferred ? done.find((d) => d.id === preferred)?.id : undefined) ??
    done[0]?.id ??
    list[0]?.id ??
    null
  );
}

// Local key shared between the dashboard and the chat widget
export const DATASET_KEY = "airframe.dataset";

export function fmtClock(startEpoch: number | null | undefined, t: number) {
  if (startEpoch == null) return null;
  return new Date((startEpoch + t) * 1000).toISOString().slice(11, 19);
}

// Whole seconds as m:ss (replay positions, durations)
export function fmtMmss(s: number) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s - m * 60)).padStart(2, "0")}`;
}

export function fmtT(s: number) {
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r.toFixed(1).padStart(4, "0")}`;
}

// A finding counts as active from its start until 5 s after its last frame
export const ACTIVE_GRACE_S = 5;
export function isActiveAt(f: Finding, t: number) {
  return f.t_start <= t && f.t_end + ACTIVE_GRACE_S >= t;
}
export type FindingState = "active" | "pending" | "over";
export function stateAt(f: Finding, t: number): FindingState {
  if (t < f.t_start) return "pending";
  return isActiveAt(f, t) ? "active" : "over";
}

// Capture end: the replay runs from 0 to here
export function captureEnd(result: Result) {
  return Math.max(
    result.summary.duration_s,
    ...result.findings.map((f) => f.t_end),
    1,
  );
}

// Wall clock (UTC) of an epoch in seconds, "YYYY-MM-DD HH:MM:SS"
export function utc(epoch: number) {
  return new Date(epoch * 1000).toISOString().slice(0, 19).replace("T", " ");
}

// Evidence frames per sensor as a Wireshark filter; the backend sends the same
// as wireshark_frames, older analyses do not
export function framesFilter(f: Finding): Record<string, string> {
  if (f.wireshark_frames && Object.keys(f.wireshark_frames).length)
    return f.wireshark_frames;
  const per = new Map<string, Set<number>>();
  for (const e of f.evidence)
    for (const r of e.frames ?? []) {
      const set = per.get(r.sensor) ?? new Set<number>();
      set.add(r.frame);
      per.set(r.sensor, set);
    }
  const out: Record<string, string> = {};
  for (const s of [...per.keys()].sort()) {
    const n = [...per.get(s)!].sort((a, b) => a - b);
    out[s] =
      n.length === 1
        ? `frame.number == ${n[0]}`
        : `frame.number in {${n.join(", ")}}`;
  }
  return out;
}

export function seenBy(n: number) {
  if (n <= 0) return "no sensor";
  if (n === 1) return "one sensor only";
  return `seen by ${n} sensors`;
}

// stuck_scanning devices are visible directly (own probe requests) or only
// indirectly (APs answering them); the hint makes that difference explicit
export function evidenceHint(f: Finding): string | null {
  if (f.type !== "stuck_scanning") return null;
  let direct = 0;
  let indirect = 0;
  for (const a of f.affected ?? []) {
    if (typeof a.probes === "number") direct += a.probes;
    if (typeof a.ap_replies === "number") indirect += a.ap_replies;
  }
  if (!direct && !indirect) return "Evidence: direct | indirect (AP replies)";
  return `Evidence: direct (${direct} probe requests) | indirect (${indirect} AP replies)`;
}
