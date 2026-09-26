import {
  fmtClock,
  fmtMmss,
  framesFilter,
  TYPE_LABEL,
  utc,
  type Finding,
  type Result,
} from "@/lib/api";

// Helpers of the IT view (/it): who owns a finding, where the connection broke,
// which radios and BSSIDs are involved, and a copy-ready ticket text.

// ------------------------------------------------------------------ teams

export type Team =
  | "wireless"
  | "identity"
  | "security"
  | "floor"
  | "monitoring"
  | "none";

export const TEAMS: Record<Team, { label: string; help: string }> = {
  wireless: {
    label: "Wireless network",
    help: "Access points, SSIDs and the WLAN controller.",
  },
  identity: {
    label: "Identity · 802.1X / RADIUS",
    help: "The login server behind the APs and its certificates.",
  },
  security: {
    label: "Security",
    help: "Configuration or traffic that can be an attack.",
  },
  floor: {
    label: "Line · device owner",
    help: "The supervisor fixes it on the line. IT sees it for the inventory.",
  },
  monitoring: {
    label: "Monitoring · sensors",
    help: "The Gearbox sensors themselves: time sync and coverage.",
  },
  none: {
    label: "No action",
    help: "Context only. Confirm that it was planned.",
  },
};

export const TEAM_ORDER: Team[] = [
  "wireless",
  "identity",
  "security",
  "floor",
  "monitoring",
  "none",
];

// Teams that IT has to work on (the line owner and "no action" are only informed)
export const IT_TEAMS = new Set<Team>([
  "wireless",
  "identity",
  "security",
  "monitoring",
]);

const IDENTITY_TYPES = new Set(["radius_outage", "eap_failure"]);
const MONITORING_TYPES = new Set(["sensor_clock", "sensor_blind_spot"]);
const SECURITY_TYPES = new Set(["weak_security", "deauth_flood", "rogue_ap"]);

export function teamOf(f: Finding): Team {
  const who = f.action?.who;
  if (who === "security") return "security";
  if (who === "you") return "floor";
  if (who === "none") return "none";
  if (IDENTITY_TYPES.has(f.type)) return "identity";
  if (MONITORING_TYPES.has(f.type)) return "monitoring";
  if (!who && SECURITY_TYPES.has(f.type)) return "security";
  if (!who && f.severity === "info") return "none";
  return "wireless";
}

// ------------------------------------------------------------------ connection steps

export const STEPS = [
  { n: 1, label: "Find", sub: "beacon · probe" },
  { n: 2, label: "Join", sub: "authentication · association" },
  { n: 3, label: "Log in", sub: "802.1X / EAP" },
  { n: 4, label: "Keys", sub: "4-way handshake" },
  { n: 5, label: "Talk", sub: "data · kicked · gone" },
] as const;

const STEP_OF: Record<string, number> = {
  ap_silent: 1,
  stuck_scanning: 2,
  assoc_rejected: 2,
  radius_outage: 3,
  eap_failure: 3,
  handshake_failure: 4,
  deauth_campaign: 5,
  deauth_by_ap: 5,
  deauth_flood: 5,
  device_vanished: 5,
  ping_pong_roaming: 5,
  excessive_roaming: 5,
};

// The connection step at which the devices of a finding fail; null = site-wide finding
export function stepOf(f: Finding): number | null {
  return STEP_OF[f.type] ?? null;
}

// ------------------------------------------------------------------ devices and BSSIDs

const MAC = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i;

export function devicesOf(f: Finding): Set<string> {
  const out = new Set<string>();
  if (f.client) out.add(f.client.toLowerCase());
  for (const a of f.affected ?? [])
    if (typeof a.client === "string" && MAC.test(a.client))
      out.add(a.client.toLowerCase());
  return out;
}

export type MissingBssid = {
  bssid: string;
  ssid: string | null;
  channel: number | null;
  // "00:0b:86:0d:00:xx (whole radio silent)": no BSSID of the radio is on the air
  wholeRadio: boolean;
};

// "00:0b:86:03:00:00 (TESLA-CORP, ch 40)" -> parts; null if the text has another form
export function parseMissing(s: string): MissingBssid | null {
  const m = /^((?:[0-9a-f]{2}|xx)(?::(?:[0-9a-f]{2}|xx)){5})\s*(?:\((.*)\))?$/i.exec(
    s.trim(),
  );
  if (!m) return null;
  const info = m[2] ?? "";
  const ch = /\bch\s*(\d+)/i.exec(info);
  const whole = /whole radio/i.test(info) || /:xx$/i.test(m[1]);
  const ssid = whole ? null : info.split(",")[0]?.trim() || null;
  return {
    bssid: m[1].toLowerCase(),
    ssid,
    channel: ch ? Number(ch[1]) : null,
    wholeRadio: whole,
  };
}

export function missingOf(f: Finding): MissingBssid[] {
  return (f.missing_bssids ?? [])
    .map(parseMissing)
    .filter((m): m is MissingBssid => m != null);
}

// BSSIDs a finding points at. A per-SSID finding (weak security) is not tied to single radios.
export function bssidsOf(f: Finding): Set<string> {
  const out = new Set<string>();
  if (f.type === "weak_security") return out;
  if (f.bssid && MAC.test(f.bssid)) out.add(f.bssid.toLowerCase());
  for (const a of f.affected ?? [])
    for (const v of [a.bssid, a.ap])
      if (typeof v === "string" && MAC.test(v)) out.add(v.toLowerCase());
  for (const m of missingOf(f)) out.add(m.bssid);
  return out;
}

// ------------------------------------------------------------------ AP radios

export type RadioBssid = {
  bssid: string;
  ssid: string | null;
  channel: number | null;
  onAir: boolean;
  akm?: string | null;
  mfpc?: number | null;
  mfpr?: number | null;
  clients?: number;
};

export type Radio = {
  radio: string;
  label: string;
  channel: number | null;
  silent: boolean;
  bssids: RadioBssid[];
  findings: number[];
};

type ApSecurity = {
  akm?: string | number | null;
  mfpc?: number | null;
  mfpr?: number | null;
};

const radioKey = (bssid: string) => bssid.toLowerCase().slice(0, 14);

// Every AP radio of the site: the ones on the air (layout / AP list) plus the ones that
// findings report as silent. Each BSSID carries its SSID, channel and security settings.
export function buildRadios(result: Result): Radio[] {
  const layoutAps = result.layout?.aps ?? [];
  const labelOf = new Map<string, string>();
  for (const a of layoutAps) labelOf.set(a.radio.toLowerCase(), a.label);
  // "AP 0d" for a silent radio when the layout labels follow the fourth octet
  const octetLabels =
    layoutAps.length > 0 &&
    layoutAps.every((a) => a.label === `AP ${a.radio.split(":")[3]}`);
  const nameOf = (radio: string) =>
    labelOf.get(radio) ??
    (octetLabels ? `AP ${radio.split(":")[3]}` : radio);

  const radios = new Map<string, Radio>();
  const get = (radio: string) => {
    let r = radios.get(radio);
    if (!r) {
      r = {
        radio,
        label: nameOf(radio),
        channel: null,
        silent: false,
        bssids: [],
        findings: [],
      };
      radios.set(radio, r);
    }
    return r;
  };

  for (const ap of result.aps) {
    const r = get(radioKey(ap.bssid));
    const sec = ap as typeof ap & ApSecurity;
    r.bssids.push({
      bssid: ap.bssid.toLowerCase(),
      ssid: ap.ssid,
      channel: ap.channel,
      onAir: true,
      akm: sec.akm != null ? String(sec.akm) : null,
      mfpc: sec.mfpc ?? null,
      mfpr: sec.mfpr ?? null,
      clients: ap.clients,
    });
    if (r.channel == null && ap.channel != null) r.channel = ap.channel;
  }

  for (const f of result.findings) {
    for (const m of missingOf(f)) {
      const r = get(radioKey(m.bssid));
      if (m.wholeRadio) {
        r.silent = true;
        continue;
      }
      if (!r.bssids.some((b) => b.bssid === m.bssid))
        r.bssids.push({
          bssid: m.bssid,
          ssid: m.ssid,
          channel: m.channel,
          onAir: false,
        });
      if (r.channel == null) r.channel = m.channel;
    }
  }

  for (const f of result.findings)
    for (const b of bssidsOf(f)) {
      const r = radios.get(radioKey(b));
      if (r && !r.findings.includes(f.id)) r.findings.push(f.id);
    }

  for (const r of radios.values()) {
    r.bssids.sort((a, b) => (a.ssid ?? "").localeCompare(b.ssid ?? ""));
    if (!r.silent && r.bssids.length && r.bssids.every((b) => !b.onAir))
      r.silent = true;
  }
  return [...radios.values()].sort((a, b) => a.radio.localeCompare(b.radio));
}

const AKM: Record<string, string> = {
  "1": "802.1X",
  "2": "PSK",
  "3": "FT-802.1X",
  "4": "FT-PSK",
  "5": "802.1X-SHA256",
  "6": "PSK-SHA256",
  "8": "SAE",
  "12": "802.1X-192",
  "18": "OWE",
};

export function akmLabel(akm: string | null | undefined) {
  if (akm == null || akm === "") return null;
  return akm
    .split(/[,\s]+/)
    .map((a) => AKM[a] ?? `AKM ${a}`)
    .join(" / ");
}

// Management frame protection (802.11w) from the RSN capabilities
export function mfpLabel(b: RadioBssid): { text: string; weak: boolean } | null {
  if (b.mfpr == null && b.mfpc == null) return null;
  if (b.mfpr) return { text: "11w required", weak: false };
  if (b.mfpc) return { text: "11w optional", weak: false };
  return { text: "no 11w", weak: true };
}

// ------------------------------------------------------------------ checks

// The fault classes Gearbox checks (same list as the pitch), with the finding types behind each
export const CHECKS: { label: string; types: string[] }[] = [
  { label: "Login server (RADIUS)", types: ["radius_outage", "eap_failure"] },
  { label: "Home AP off, no fallback", types: ["stuck_scanning", "ap_silent"] },
  { label: "Controller disconnects", types: ["deauth_campaign", "deauth_by_ap"] },
  { label: "Device off", types: ["device_vanished"] },
  { label: "Controller stall", types: ["controller_stall"] },
  { label: "Sensor clock drift", types: ["sensor_clock"] },
  { label: "Security configuration", types: ["weak_security"] },
  { label: "Handshake break", types: ["handshake_failure"] },
  { label: "Association rejected", types: ["assoc_rejected"] },
  { label: "Roaming ping-pong", types: ["ping_pong_roaming", "excessive_roaming"] },
  { label: "Sensor blind spot", types: ["sensor_blind_spot"] },
  { label: "Congestion", types: ["congestion"] },
  { label: "Non-Wi-Fi interference", types: ["rf_interference"] },
  { label: "Deauth flood / spoofing", types: ["deauth_flood"] },
  { label: "Evil twin", types: ["rogue_ap"] },
  { label: "Short-lived network", types: ["transient_network"] },
];

// ------------------------------------------------------------------ evidence and proof

export function evidenceFrames(f: Finding) {
  return f.evidence.reduce((n, e) => n + (e.frames?.length ?? 0), 0);
}

type Origin = {
  frames?: number;
  seq_fit?: number;
  sent_by_ap?: boolean;
  rssi_delta_db?: number;
  rssi_delta_sd?: number;
};

// Proof of who sent the kick frames (deauth campaign): AP sequence counter and signal level
export function originProof(f: Finding): string | null {
  const o = (f as Finding & { origin?: Origin | null }).origin;
  if (!o || o.frames == null || o.seq_fit == null) return null;
  const pct = Math.round(o.seq_fit * 100);
  const n = o.frames.toLocaleString("en");
  const sig =
    o.rssi_delta_db != null
      ? `, signal ${o.rssi_delta_db >= 0 ? "+" : ""}${o.rssi_delta_db.toFixed(1)} ± ${(o.rssi_delta_sd ?? 0).toFixed(1)} dB from the AP's own beacons`
      : "";
  return o.sent_by_ap
    ? `Sent by the AP itself: ${pct} % of ${n} frames continue the AP's own sequence counter${sig}.`
    : `${pct} % of ${n} frames fit the AP's sequence counter${sig}. The sender is not the AP.`;
}

const words = (s: string) =>
  new Set(s.toLowerCase().match(/[a-z0-9.]{4,}/g) ?? []);

// ------------------------------------------------------------------ diagnosis

// Sensors behind a finding: the listed ones, else the ones its evidence frames come from
export function sensorsOf(f: Finding): string[] {
  if (f.sensors.length) return f.sensors;
  const out = new Set<string>();
  for (const e of f.evidence) for (const r of e.frames ?? []) out.add(r.sensor);
  return [...out].sort();
}

export type Answer = { q: string; a: string; sub?: string };

const num = (text: string, re: RegExp) => {
  const m = re.exec(text);
  return m ? Number(m[1].replace(/,/g, "")) : null;
};
const fmt = (n: number) => n.toLocaleString("en");

// The three questions that decide a cause (same logic as the pitch): which step never
// completes, how far the break spreads, and who sent the last frame
export function diagnosis(f: Finding, captureEnd: number): Answer[] {
  const step = stepOf(f);
  const devices = devicesOf(f).size;
  const aps = new Set([...bssidsOf(f)].map(radioKey)).size;
  const aff = f.affected ?? [];
  // channels the affected devices were seen on; else one channel per sensor that saw the finding
  const chans = new Set<number>();
  for (const x of aff)
    if (Array.isArray(x.channels))
      for (const c of x.channels) if (typeof c === "number") chans.add(c);
  const sensors = chans.size || sensorsOf(f).length;
  const d = f.detail;

  // 1 · which step
  let q1: Answer = {
    q: "Which step is missing?",
    a: step ? `${STEPS[step - 1].label} (step ${step})` : "None: site-wide",
    sub: step ? STEPS[step - 1].sub : "not tied to one device's connection",
  };
  if (f.type === "stuck_scanning") {
    const answering = Math.max(0, ...aff.map((x) => Number(x.answering_aps) || 0));
    q1 = {
      q: q1.q,
      a: "Join never starts",
      sub: answering
        ? `they scan and get answers from up to ${answering} APs`
        : "they scan, but never authenticate",
    };
  } else if (f.type === "radius_outage") {
    const ok = num(d, /(\d[\d,]*) EAP-Success/);
    q1 = {
      q: q1.q,
      a: "Log in stops after the identity",
      sub: ok != null ? `${fmt(ok)} successful logins in the capture` : undefined,
    };
  } else if (f.type === "deauth_campaign") {
    const p = aff.map((x) => Number(x.period_s)).filter((x) => x > 0);
    q1 = {
      q: q1.q,
      a: "Talk, then disconnected",
      sub: p.length
        ? `again and again, every ${Math.round(Math.min(...p))}–${Math.round(Math.max(...p))} s`
        : "again and again",
    };
  } else if (f.type === "device_vanished") {
    q1 = {
      q: q1.q,
      a: "Talk stops",
      sub: `then no frame for ${Math.round((captureEnd - f.t_start) / 60)} min`,
    };
  }

  // 2 · how far
  const parts = [
    devices ? `${fmt(devices)} ${devices === 1 ? "device" : "devices"}` : null,
    aps ? `${aps} ${aps === 1 ? "access point" : "access points"}` : null,
    sensors ? `${sensors} ${sensors === 1 ? "channel" : "channels"}` : null,
  ].filter(Boolean);
  let sub2: string | undefined;
  if (f.type === "stuck_scanning") {
    const other = num(d, /on the air on (\d+) other APs/);
    sub2 = other
      ? `only devices of silent APs; the network is on the air on ${other} other APs`
      : "only devices of silent APs";
  } else if (devices === 1) sub2 = "one device: its access point and the devices near it keep working";
  else if (sensors >= 3)
    sub2 = `${sensors} channels at the same time: not a radio problem`;
  const q2: Answer = {
    q: "How far does it spread?",
    a: parts.length ? parts.join(" · ") : f.scope ?? "site",
    sub: sub2,
  };

  // 3 · who sent the last frame
  let q3: Answer;
  const first = f.evidence[0]?.what;
  if (f.type === "deauth_campaign") {
    const o = (f as Finding & { origin?: { frames?: number; seq_fit?: number; sent_by_ap?: boolean } }).origin;
    q3 = {
      q: "Who sent the last frame?",
      a: o?.sent_by_ap ? "The access point itself" : "Not the access point",
      sub:
        o?.frames != null && o.seq_fit != null
          ? `${Math.round(o.seq_fit * 100)} % of ${fmt(o.frames)} frames continue its own sequence counter`
          : undefined,
    };
  } else if (f.type === "device_vanished") {
    q3 = {
      q: "Who sent the last frame?",
      a: "The device itself: “I am leaving”",
      sub: first ?? undefined,
    };
  } else if (f.type === "radius_outage") {
    const asks = num(d, /(\d[\d,]*) EAP-Request\/Identity/);
    q3 = {
      q: "Who sent the last frame?",
      a: "The AP asks. Nothing behind it answers.",
      sub: asks ? `${fmt(asks)} identity requests, no login method follows` : undefined,
    };
  } else if (f.type === "stuck_scanning") {
    const replies = aff.reduce((n, x) => n + (Number(x.ap_replies) || 0), 0);
    q3 = {
      q: "Who sent the last frame?",
      a: "Other APs answer. Their own AP sends nothing.",
      sub: replies ? `${fmt(replies)} probe responses to these devices` : undefined,
    };
  } else if (f.type === "controller_stall") {
    q3 = {
      q: "Who sent the last frame?",
      a: "All APs at once, late",
      sub: "beacons on different channels delayed in the same moment: the common controller",
    };
  } else if (f.type === "sensor_clock") {
    q3 = {
      q: "Who sent the last frame?",
      a: "The APs' beacon timestamps",
      sub: "compared per sensor: the sensor clocks differ, not the APs",
    };
  } else if (f.type === "weak_security") {
    q3 = {
      q: "Who sent the last frame?",
      a: "The APs' own beacons",
      sub: "they announce one shared key (PSK) and no 802.11w",
    };
  } else {
    q3 = {
      q: "Who sent the last frame?",
      a: first ?? "see the evidence frames",
    };
  }
  return [q1, q2, q3];
}

// The conclusion of the three questions in plain words (falls back to the type label)
const CAUSE: Record<string, string> = {
  radius_outage: "Login server (RADIUS) or the path to it does not answer",
  eap_failure: "802.1X login fails",
  stuck_scanning: "Access point off, and the devices do not use another one",
  ap_silent: "Access point off",
  deauth_campaign: "Controller job or client policy, not an attacker",
  device_vanished: "Device switched off or restarted",
  controller_stall: "Common controller or AP firmware paused",
  sensor_clock: "Sensor time sync (NTP / PTP) does not work",
  weak_security: "Shared key without management-frame protection",
};

export function causeText(f: Finding) {
  return CAUSE[f.type] ?? TYPE_LABEL[f.type] ?? f.type;
}

// Recommendation sentences as steps, plus the sentences of the IT note that add something new
// (the two texts often say the same in other words)
export function fixSteps(f: Finding): string[] {
  const sentences = (s: string | undefined) =>
    (s ?? "")
      .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
      .map((x) => x.trim().replace(/\s+-\s+/g, " – "))
      .filter(Boolean);
  const steps = sentences(f.recommendation);
  const known = new Set(steps.flatMap((s) => [...words(s)]));
  // "802.11w does not help: ..." twice with different endings counts as a repeat
  const lead = (s: string) =>
    s.includes(":") ? s.split(":")[0].toLowerCase().trim() : null;
  const leads = new Set(steps.map(lead).filter(Boolean));
  for (const s of sentences(f.action?.it)) {
    const w = [...words(s)];
    const covered = w.filter((x) => known.has(x)).length;
    if (w.length && covered / w.length >= 0.5) continue;
    if (lead(s) && leads.has(lead(s))) continue;
    steps.push(s);
    w.forEach((x) => known.add(x));
  }
  return steps;
}

// ------------------------------------------------------------------ ticket

export function windowText(f: Finding, startEpoch: number | null) {
  const dur = fmtMmss(Math.max(0, f.t_end - f.t_start));
  if (startEpoch == null)
    return `${fmtMmss(f.t_start)} - ${fmtMmss(f.t_end)} capture time (${dur})`;
  return `${utc(startEpoch + f.t_start)} - ${fmtClock(startEpoch, f.t_end)} UTC (${dur})`;
}

// Plain-text ticket for the service desk: owner, window, scope, cause, fix, proof
export function ticketText(
  f: Finding,
  startEpoch: number | null,
  link: string,
): string {
  const lines: string[] = [];
  const devices = devicesOf(f).size;
  lines.push(`[Gearbox #${f.id}] ${f.title}`);
  lines.push("");
  lines.push(`Owner:      ${TEAMS[teamOf(f)].label}`);
  lines.push(
    `Priority:   ${f.severity}${f.action ? ` · ${f.action.label}` : ""}`,
  );
  lines.push(`Type:       ${TYPE_LABEL[f.type] ?? f.type}`);
  lines.push(`Window:     ${windowText(f, startEpoch)}`);
  const scope = [
    f.scope,
    f.networks?.length ? f.networks.join(", ") : null,
    devices ? `${devices} ${devices === 1 ? "device" : "devices"}` : null,
  ].filter(Boolean);
  if (scope.length) lines.push(`Scope:      ${scope.join(" · ")}`);
  if (f.sensors.length) lines.push(`Sensors:    ${f.sensors.join(", ")}`);
  if (f.confidence)
    lines.push(
      `Confidence: ${f.confidence.level}${f.confidence.reasons.length ? ` (${f.confidence.reasons.join("; ")})` : ""}`,
    );
  lines.push("", "Root cause", f.detail);
  const proof = originProof(f);
  if (proof) lines.push("", proof);
  const missing = missingOf(f);
  if (missing.length)
    lines.push(
      "",
      "Not on the air",
      ...(f.missing_bssids ?? []).map((m) => `- ${m}`),
    );
  const steps = fixSteps(f);
  if (steps.length)
    lines.push("", "Fix", ...steps.map((s, i) => `${i + 1}. ${s}`));
  if (f.evidence.length) {
    lines.push("", "Evidence (sensor#frame)");
    for (const e of f.evidence)
      lines.push(
        `- ${fmtMmss(e.t)}  ${e.what}  ${(e.frames ?? []).map((r) => `${r.sensor}#${r.frame}`).join(" ")}`,
      );
  }
  const frames = Object.entries(framesFilter(f));
  if (f.wireshark_filter || frames.length || f.wireshark_filter_absent) {
    lines.push("", "Wireshark display filters");
    if (f.wireshark_filter) lines.push(`All frames: ${f.wireshark_filter}`);
    for (const [s, flt] of frames) lines.push(`${s}: ${flt}`);
    if (f.wireshark_filter_absent)
      lines.push(`Must match nothing: ${f.wireshark_filter_absent}`);
  }
  lines.push("", `Open in Gearbox: ${link}`);
  return lines.join("\n");
}
