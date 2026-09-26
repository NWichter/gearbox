"use client";

import { memo } from "react";

import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { Finding, Result, RfAnomaly } from "@/lib/api";
import { fmtT, SEVERITY_COLOR } from "@/lib/api";

// Problem series in warm colours, healthy traffic in cool ones
const SERIES = [
  { key: "deauth", label: "Deauth / disassoc", color: "#ef4444" },
  { key: "eap_failure", label: "EAP failures", color: "#f97316" },
  { key: "auth", label: "Auth / (re)assoc", color: "#7d9bc1" },
  { key: "handshake", label: "4-way handshake", color: "#9a8fb8" },
  { key: "retry", label: "Retried frames", color: "#c9a44a" },
];

const CH_COLORS = [
  "#6f9fd8",
  "#d9884a",
  "#5fae8a",
  "#b07cc6",
  "#c9a44a",
  "#d06a6a",
  "#8e97c9",
  "#4fa3a0",
];

const AXIS = {
  stroke: "transparent",
  tick: { fill: "var(--muted-foreground)", fontSize: 11 },
  tickLine: false,
};

const GRID = {
  strokeDasharray: "0",
  stroke: "var(--border)",
  vertical: false,
};

const tooltipStyle = {
  contentStyle: {
    background: "var(--popover)",
    border: "1px solid var(--border)",
    borderRadius: 3,
    boxShadow: "none",
    fontSize: 11,
    padding: "6px 8px",
  },
  labelStyle: { color: "var(--muted-foreground)", marginBottom: 4 },
  itemStyle: { padding: 0 },
  cursor: { stroke: "var(--ring)", strokeDasharray: "3 3" },
  labelFormatter: (v: unknown) => fmtT(Number(v)),
};

const LEGEND = {
  iconType: "square" as const,
  iconSize: 8,
  wrapperStyle: { fontSize: 11, paddingTop: 6 },
};

// Replay playhead line; clicking the chart moves the replay there
function playheadLine(playhead?: number) {
  return playhead == null ? null : (
    <ReferenceLine
      x={playhead}
      stroke="var(--foreground)"
      strokeWidth={1}
      ifOverflow="hidden"
    />
  );
}

type SeekState = { activeLabel?: string | number } | null;
function seekHandler(onSeek?: (t: number) => void) {
  return onSeek
    ? (st: SeekState) => {
        const v = Number(st?.activeLabel);
        if (Number.isFinite(v)) onSeek(v);
      }
    : undefined;
}

// memo: the replay re-renders the page every frame, the charts only when the playhead bucket moves
export const EventTimeline = memo(function EventTimeline({
  data,
  findings,
  onPick,
  playhead,
  onSeek,
}: {
  data: Result["timeline"];
  findings: Finding[];
  onPick?: (f: Finding) => void;
  playhead?: number;
  onSeek?: (t: number) => void;
}) {
  const marks = findings.filter(
    (f) => f.severity === "critical" || f.severity === "high",
  );
  return (
    <ResponsiveContainer width="100%" height={260}>
      <AreaChart
        data={data}
        margin={{ left: -16, right: 8, top: 10 }}
        onClick={seekHandler(onSeek)}
      >
        <CartesianGrid {...GRID} />
        <XAxis
          dataKey="t"
          tickFormatter={fmtT}
          {...AXIS}
          type="number"
          domain={["dataMin", "dataMax"]}
          minTickGap={24}
        />
        <YAxis {...AXIS} allowDecimals={false} />
        <Tooltip {...tooltipStyle} />
        <Legend {...LEGEND} />
        {marks.map((f) => (
          <ReferenceArea
            key={f.id}
            x1={f.t_start}
            x2={Math.max(f.t_end, f.t_start + 2)}
            fill={SEVERITY_COLOR[f.severity]}
            fillOpacity={0.05}
            stroke={SEVERITY_COLOR[f.severity]}
            strokeOpacity={0.25}
            onClick={() => onPick?.(f)}
            style={{ cursor: "pointer" }}
          />
        ))}
        {SERIES.map((s) => (
          <Area
            key={s.key}
            dataKey={s.key}
            name={s.label}
            stackId="1"
            stroke={s.color}
            strokeWidth={1.25}
            fill={s.color}
            fillOpacity={0.18}
            type="linear"
          />
        ))}
        {playheadLine(playhead)}
      </AreaChart>
    </ResponsiveContainer>
  );
});

export const ChannelChart = memo(function ChannelChart({
  data,
  metric,
  playhead,
  onSeek,
}: {
  data: Result["channel_timeline"];
  metric: "cu_pct" | "retry_ratio";
  playhead?: number;
  onSeek?: (t: number) => void;
}) {
  const channels = [...new Set(data.map((d) => d.channel))].sort(
    (a, b) => a - b,
  );
  const byT = new Map<number, Record<string, number>>();
  for (const d of data) {
    const row = byT.get(d.t) ?? { t: d.t };
    const v = metric === "retry_ratio" ? d.retry_ratio * 100 : d.cu_pct;
    if (v !== null && v !== undefined) row[`ch${d.channel}`] = Math.round(v);
    byT.set(d.t, row);
  }
  const rows = [...byT.values()].sort((a, b) => a.t - b.t);
  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart
        data={rows}
        margin={{ left: -16, right: 8, top: 10 }}
        onClick={seekHandler(onSeek)}
      >
        <CartesianGrid {...GRID} />
        <XAxis
          dataKey="t"
          tickFormatter={fmtT}
          {...AXIS}
          type="number"
          domain={["dataMin", "dataMax"]}
          minTickGap={24}
        />
        <YAxis {...AXIS} unit="%" domain={[0, 100]} />
        <Tooltip {...tooltipStyle} />
        <Legend {...LEGEND} />
        {channels.map((c, i) => (
          <Line
            key={c}
            dataKey={`ch${c}`}
            name={`Ch ${c}`}
            stroke={CH_COLORS[i % CH_COLORS.length]}
            dot={false}
            activeDot={{ r: 3, strokeWidth: 0 }}
            strokeWidth={1.25}
            connectNulls
          />
        ))}
        {playheadLine(playhead)}
      </LineChart>
    </ResponsiveContainer>
  );
});

export type RfMetric = "noise_dbm" | "snr_db" | "rate_mbps";

const RF_UNIT: Record<RfMetric, string> = {
  noise_dbm: " dBm",
  snr_db: " dB",
  rate_mbps: " Mbit/s",
};

// Noise floor, SNR or data rate per channel over time (loudest sensor per channel).
// Shaded: periods in which the noise floor sits clearly above its own baseline.
export const RfChart = memo(function RfChart({
  data,
  metric,
  anomalies = [],
  playhead,
  onSeek,
}: {
  data: Result["channel_timeline"];
  metric: RfMetric;
  anomalies?: RfAnomaly[];
  playhead?: number;
  onSeek?: (t: number) => void;
}) {
  const channels = [...new Set(data.map((d) => d.channel))].sort(
    (a, b) => a - b,
  );
  const byT = new Map<number, Record<string, number>>();
  for (const d of data) {
    const row = byT.get(d.t) ?? { t: d.t };
    const v = d[metric];
    if (v != null) row[`ch${d.channel}`] = Math.round(v * 10) / 10;
    byT.set(d.t, row);
  }
  const rows = [...byT.values()].sort((a, b) => a.t - b.t);
  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart
        data={rows}
        margin={{ left: -8, right: 8, top: 10 }}
        onClick={seekHandler(onSeek)}
      >
        <CartesianGrid {...GRID} />
        <XAxis
          dataKey="t"
          tickFormatter={fmtT}
          {...AXIS}
          type="number"
          domain={["dataMin", "dataMax"]}
          minTickGap={24}
        />
        <YAxis
          {...AXIS}
          unit={metric === "rate_mbps" ? "" : RF_UNIT[metric].trim()}
          domain={["auto", "auto"]}
          width={52}
        />
        <Tooltip
          {...tooltipStyle}
          formatter={(v) => `${v}${RF_UNIT[metric]}`}
        />
        <Legend {...LEGEND} />
        {metric === "noise_dbm" &&
          anomalies.map((a, i) => (
            <ReferenceArea
              key={i}
              x1={a.t_start}
              x2={a.t_end}
              fill="var(--warn)"
              fillOpacity={0.12}
              stroke="var(--warn)"
              strokeOpacity={0.4}
            />
          ))}
        {channels.map((c, i) => (
          <Line
            key={c}
            dataKey={`ch${c}`}
            name={`Ch ${c}`}
            stroke={CH_COLORS[i % CH_COLORS.length]}
            dot={false}
            activeDot={{ r: 3, strokeWidth: 0 }}
            strokeWidth={1.25}
            connectNulls
            isAnimationActive={false}
          />
        ))}
        {playheadLine(playhead)}
      </LineChart>
    </ResponsiveContainer>
  );
});
