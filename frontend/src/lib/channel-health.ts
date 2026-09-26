import { urgencyOf } from "@/components/action";
import {
  isActiveAt,
  type Finding,
  type Result,
  type RfAnomaly,
  type Urgency,
} from "@/lib/api";

export type Health = "ok" | "warn" | "stop";
export type ChannelRow = Result["channel_timeline"][number];

export type ChannelState = {
  channel: number;
  health: Health;
  row: ChannelRow | null;
  sensor: string | null;
  // why the channel is not "ok"
  reasons: string[];
  findings: Finding[];
};

export type ChannelModel = {
  channels: number[];
  // channel groups without a gap (for example UNII-1 and UNII-3)
  groups: number[][];
  rows: Map<string, ChannelRow>;
  median: Map<number, { retry: number; noise: number | null }>;
  // finding id -> channel -> urgency on that channel
  touch: Map<number, Map<number, Urgency>>;
  sensorOf: Map<number, string>;
  anomalies: RfAnomaly[];
};

const WINDOW = 5; // seconds per channel_timeline row
const NOISE_RISE_DB = 6; // same threshold as the backend's noise detector
const SITE_SHARE = 0.75; // a finding on this share of the channels is site-wide

function median(v: number[]) {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const key = (ch: number, t: number) => `${ch}:${t}`;

// Channels a finding touches. Site-wide findings (most channels, only through affected
// devices) do not colour single channels: the status sentence and the warnings tell them.
function channelsOf(
  f: Finding,
  apChannel: Map<string, number>,
  sensorChannel: Map<string, number>,
  total: number,
): Map<number, Urgency> {
  const u = urgencyOf(f);
  const out = new Map<number, Urgency>();
  const put = (ch: number | null | undefined, v: Urgency) => {
    if (ch == null) return;
    const cur = out.get(ch);
    if (!cur || rank(v) < rank(cur)) out.set(ch, v);
  };
  if (f.channel) put(f.channel, u);
  if (f.bssid) put(apChannel.get(f.bssid.toLowerCase()), u);
  if (f.sensors.length === 1) put(sensorChannel.get(f.sensors[0]), u);
  // "00:0b:86:06:00:01 (TESLA-TOOLS, ch 149)": the network decides the colour
  for (const m of f.missing_bssids ?? []) {
    const ch = /ch (\d+)/.exec(m)?.[1];
    if (ch)
      put(Number(ch), /TOOL/i.test(m) ? "red" : u === "red" ? "yellow" : u);
  }
  const spread = new Set<number>();
  for (const a of f.affected ?? []) {
    for (const b of [a.bssid, a.ap])
      if (typeof b === "string") {
        const ch = apChannel.get(b.toLowerCase());
        if (ch != null) spread.add(ch);
      }
  }
  if (spread.size < Math.max(2, total * SITE_SHARE))
    for (const ch of spread) put(ch, u);
  return out;
}

const RANK: Record<Urgency, number> = { red: 0, purple: 1, yellow: 2, grey: 3 };
const rank = (u: Urgency) => RANK[u];

export function buildChannelModel(result: Result): ChannelModel {
  const sensorChannel = new Map<string, number>();
  const sensorOf = new Map<number, string>();
  for (const s of result.sensors.stats)
    for (const ch of s.channels) {
      sensorChannel.set(s.sensor, ch);
      sensorOf.set(ch, s.sensor);
    }
  const rows = new Map<string, ChannelRow>();
  const perCh = new Map<number, ChannelRow[]>();
  for (const r of result.channel_timeline) {
    const ch = Number(r.channel);
    rows.set(key(ch, r.t), r);
    const list = perCh.get(ch) ?? [];
    list.push(r);
    perCh.set(ch, list);
  }
  const channels = [
    ...new Set([...sensorOf.keys(), ...perCh.keys()].map(Number)),
  ].sort((a, b) => a - b);
  const groups: number[][] = [];
  for (const ch of channels) {
    const g = groups[groups.length - 1];
    // 5 GHz channels are 4 apart; a bigger gap starts a new band part
    if (g && ch - g[g.length - 1] <= 8) g.push(ch);
    else groups.push([ch]);
  }
  const med = new Map<number, { retry: number; noise: number | null }>();
  for (const [ch, list] of perCh)
    med.set(ch, {
      retry: median(list.map((r) => r.retry_ratio)) ?? 0,
      noise: median(
        list.flatMap((r) => (r.noise_dbm != null ? [r.noise_dbm] : [])),
      ),
    });
  const apChannel = new Map<string, number>();
  for (const a of result.aps)
    if (a.channel != null) apChannel.set(a.bssid.toLowerCase(), a.channel);
  const touch = new Map<number, Map<number, Urgency>>();
  for (const f of result.findings)
    touch.set(f.id, channelsOf(f, apChannel, sensorChannel, channels.length));
  return {
    channels,
    groups,
    rows,
    median: med,
    touch,
    sensorOf,
    anomalies: result.rf_anomalies ?? [],
  };
}

// Newest row at or before t (rows are 5-s windows; a window can be missing)
export function rowAt(model: ChannelModel, ch: number, t: number) {
  const b = Math.floor(t / WINDOW) * WINDOW;
  for (let k = 0; k <= 3; k++) {
    const r = model.rows.get(key(ch, b - k * WINDOW));
    if (r) return r;
  }
  return null;
}

export function channelStates(
  model: ChannelModel,
  findings: Finding[],
  t: number,
): ChannelState[] {
  const active = findings.filter((f) => isActiveAt(f, t));
  return model.channels.map((ch) => {
    const row = rowAt(model, ch, t);
    const m = model.median.get(ch);
    const reasons: string[] = [];
    let health: Health = "ok";
    const hit: Finding[] = [];
    for (const f of active) {
      const u = model.touch.get(f.id)?.get(ch);
      if (!u || u === "grey") continue;
      hit.push(f);
      if (u === "red") health = "stop";
      else if (health === "ok") health = "warn";
    }
    if (hit.some((f) => model.touch.get(f.id)?.get(ch) === "red"))
      reasons.push("A problem on the tools network is active here.");
    else if (hit.length)
      reasons.push("An active finding touches this channel.");
    if (row && m) {
      if (
        row.frames >= 50 &&
        row.retry_ratio >= Math.max(m.retry * 1.5, m.retry + 0.08)
      )
        reasons.push(
          `Retries ${Math.round(row.retry_ratio * 100)} % (median ${Math.round(m.retry * 100)} %).`,
        );
      if (
        row.noise_dbm != null &&
        m.noise != null &&
        row.noise_dbm >= m.noise + NOISE_RISE_DB
      )
        reasons.push(
          `Noise ${Math.round(row.noise_dbm)} dBm (median ${Math.round(m.noise)} dBm).`,
        );
    }
    if (
      model.anomalies.some(
        (a) => a.channel === ch && a.t_start <= t && a.t_end >= t,
      )
    )
      reasons.push("The noise floor is above its baseline.");
    if (health === "ok" && reasons.length) health = "warn";
    return {
      channel: ch,
      health,
      row,
      sensor: row?.sensor ?? model.sensorOf.get(ch) ?? null,
      reasons,
      findings: hit,
    };
  });
}
