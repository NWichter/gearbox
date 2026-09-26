"use client";

import {
  useCallback,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  FlaskConical,
  Pause,
  Play,
  RotateCcw,
  SkipBack,
  SkipForward,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  ActionChip,
  URGENCY,
  UrgencyDot,
  urgencyOf,
} from "@/components/action";
import { FindingDetails, FindingSheet } from "@/components/finding-sheet";
import { RadioGrid } from "@/components/it-console";
import {
  SPEEDS,
  useReplayKeys,
  useReplayTrack,
  type Replay,
} from "@/components/replay";
import {
  captureEnd,
  fmtClock,
  fmtMmss as mmss,
  isActiveAt,
  SEVERITY_RANK,
  stateAt,
  utc,
  type Finding,
  type FindingState,
  type Result,
  type Urgency,
} from "@/lib/api";
import {
  buildChannelModel,
  channelStates,
  type ChannelModel,
  type ChannelState,
  type Health,
} from "@/lib/channel-health";
import { buildRadios } from "@/lib/it-view";
import { cn } from "@/lib/utils";

// ------------------------------------------------------------------ helpers

const DESKTOP = "(min-width: 1024px)";
function subscribeDesktop(cb: () => void) {
  const m = window.matchMedia(DESKTOP);
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
}
function useIsDesktop() {
  return useSyncExternalStore(
    subscribeDesktop,
    () => window.matchMedia(DESKTOP).matches,
    () => true,
  );
}

// Most important first: urgency (tools network first), then severity, then the newest start
function byPriority(a: Finding, b: Finding) {
  return (
    URGENCY[urgencyOf(a)].rank - URGENCY[urgencyOf(b)].rank ||
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    b.t_start - a.t_start
  );
}

const STATE_RANK: Record<FindingState, number> = {
  active: 0,
  over: 1,
  pending: 2,
};

// Wall clock at capture time t, or m:ss when the capture has no epoch
function clockOf(startEpoch: number | null, t: number) {
  const c = fmtClock(startEpoch, t);
  return c ? `${c} UTC` : mmss(t);
}

function stateText(f: Finding, t: number, startEpoch: number | null) {
  const s = stateAt(f, t);
  if (s === "pending") return `Starts at ${clockOf(startEpoch, f.t_start)}`;
  if (s === "over") return `Stopped at ${clockOf(startEpoch, f.t_end)}`;
  return `Active since ${clockOf(startEpoch, f.t_start)}`;
}

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

// ------------------------------------------------------------------ board

// The whole board follows the replay time of `replay` (owned by the page).
// `simulation={false}`: the page shows the replay controls elsewhere (/final top bar).
export function Board({
  result,
  dsId,
  name,
  replay,
  simulation = true,
  pickerHint = "at the top right",
}: {
  result: Result;
  dsId: string;
  name?: string;
  replay: Replay;
  simulation?: boolean;
  pickerHint?: string;
}) {
  const end = captureEnd(result);
  const t = replay.t;
  const startEpoch = result.summary.start_epoch;
  const isDesktop = useIsDesktop();
  const model = useMemo(() => buildChannelModel(result), [result]);
  const radios = useMemo(() => buildRadios(result), [result]);

  // Board renders only in the browser (after the fetch), so window is available here
  const [selectedId, setSelectedId] = useState<number | null>(() => {
    // deep link: /?f=3 opens finding 3
    const linked = Number(new URLSearchParams(window.location.search).get("f"));
    if (linked && result.findings.some((f) => f.id === linked)) return linked;
    const active = result.findings.filter((f) => isActiveAt(f, end));
    return (
      [...active].sort(byPriority)[0]?.id ?? result.findings[0]?.id ?? null
    );
  });
  const [sheet, setSheet] = useState<Finding | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);

  const select = useCallback(
    (f: Finding, scroll = false) => {
      setSelectedId(f.id);
      if (!isDesktop) setSheet(f);
      else if (scroll)
        boardRef.current?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
    },
    [isDesktop],
  );

  const selected = result.findings.find((f) => f.id === selectedId) ?? null;

  return (
    <div className="space-y-10 sm:space-y-12">
      <StatusHeadline
        result={result}
        t={t}
        name={name}
        pickerHint={pickerHint}
      />
      {simulation && (
        <SimulationPanel replay={replay} result={result} model={model} />
      )}
      <Warnings
        result={result}
        t={t}
        onPick={(f) => select(f, true)}
        selectedId={selectedId}
      />
      <div ref={boardRef} className="scroll-mt-[calc(var(--chrome-h,3.5rem)+1.5rem)]">
        <FindingsBoard
          result={result}
          t={t}
          selected={selected}
          onPick={(f) => select(f)}
          dsId={dsId}
        />
      </div>
      <RadioGrid
        result={result}
        radios={radios}
        onPick={(id) => {
          const f = result.findings.find((x) => x.id === id);
          if (f) select(f, true);
        }}
      />
      <FindingSheet
        dsId={dsId}
        finding={sheet}
        startEpoch={startEpoch}
        onClose={() => setSheet(null)}
      />
    </div>
  );
}

// ------------------------------------------------------------------ status

function StatusHeadline({
  result,
  t,
  name,
  pickerHint,
}: {
  result: Result;
  t: number;
  name?: string;
  pickerHint: string;
}) {
  const active = result.findings.filter((f) => isActiveAt(f, t));
  const red = active.filter((f) => urgencyOf(f) === "red").length;
  const it = active.filter((f) => urgencyOf(f) === "yellow").length;
  const sec = active.filter((f) => urgencyOf(f) === "purple").length;
  const s = result.summary;
  const others = [
    it
      ? plural(
          it,
          "problem on the office network",
          "problems on the office network",
        )
      : null,
    sec ? plural(sec, "security incident", "security incidents") : null,
  ].filter(Boolean);

  const facts: { text: string; help: string }[] = [
    {
      text: name ?? "Dataset",
      help: `The captures that Gearbox analysed. You can select a different dataset ${pickerHint}.`,
    },
    ...(s.start_epoch != null
      ? [
          {
            text: `${utc(s.start_epoch).slice(0, 16)} - ${utc(s.start_epoch + s.duration_s).slice(11, 16)} UTC`,
            help: `Capture window in UTC. The capture is ${mmss(s.duration_s)} long.`,
          },
        ]
      : []),
    {
      text: plural(s.sensors, "sensor", "sensors"),
      help: "Monitor-mode sensors. Each sensor records one channel into its own pcap file.",
    },
    {
      text: `${s.radios_on_air ?? s.aps} AP radios`,
      help:
        s.radios_expected != null
          ? `Physical AP radios on the air. The radio numbers show ${s.radios_expected} planned radios. The radios send ${s.networks ?? s.aps} networks (BSSIDs).`
          : "Access points (BSSIDs) on the air.",
    },
    {
      text: `${s.devices_total ?? s.clients} devices`,
      help:
        s.devices_connected != null
          ? `Different device addresses. ${s.devices_connected} connected to an AP. The sensors recorded frames from ${s.devices_heard} of them.`
          : "Different device addresses.",
    },
  ];

  return (
    <section className="space-y-3 pt-8 text-center sm:pt-2">
      <Tooltip>
        <TooltipTrigger
          render={
            <h1 className="mx-auto max-w-3xl cursor-help text-[26px] leading-tight font-light tracking-tight sm:text-[32px]" />
          }
        >
          {red > 0 ? (
            <>
              {plural(red, "problem", "problems")} can{" "}
              <span className="text-tesla font-normal">stop the line</span>
            </>
          ) : (
            <>
              The line is <span className="text-ok font-normal">running</span>
            </>
          )}
        </TooltipTrigger>
        <TooltipContent className="max-w-sm">
          State at the replay time. A problem can stop the line when it hits the
          tools network (TESLA-TOOLS): a torque tool without Wi-Fi cannot
          confirm its screws.
        </TooltipContent>
      </Tooltip>
      <p className="text-muted-foreground text-sm">
        {others.length
          ? `Also active: ${others.join(" and ")}.`
          : red
            ? "No other active problems."
            : "No problem is active on the tools network."}
      </p>
      <div className="text-muted-foreground flex flex-wrap items-center justify-center gap-x-3 gap-y-1 pt-1 text-xs sm:gap-x-2">
        {facts.map((f, i) => (
          <span key={i} className="inline-flex items-center gap-2">
            {i > 0 && <span className="hidden opacity-40 sm:inline">·</span>}
            <Tooltip>
              <TooltipTrigger
                render={<span className="hover:text-foreground cursor-help" />}
              >
                {f.text}
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">{f.help}</TooltipContent>
            </Tooltip>
          </span>
        ))}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ simulation

export const HEALTH: Record<Health, { color: string; label: string }> = {
  ok: { color: "var(--ok)", label: "Normal" },
  warn: { color: "var(--warn)", label: "Degraded" },
  stop: { color: "var(--tesla)", label: "Can stop the line" },
};

function SimulationPanel({
  replay,
  result,
  model,
}: {
  replay: Replay;
  result: Result;
  model: ChannelModel;
}) {
  const { t, playing, speed, end, seek, toggle, pause, setSpeed } = replay;
  useReplayKeys(replay);
  const startEpoch = result.summary.start_epoch;
  const atEnd = t >= end - 0.05;
  const states = channelStates(model, result.findings, t);

  return (
    <section
      data-replay
      aria-label="Simulation: replay the capture"
      className="bg-panel mx-auto max-w-3xl rounded-2xl border px-4 py-4 sm:px-6 sm:py-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="text-muted-foreground inline-flex cursor-help items-center gap-1.5 text-[10.5px] font-medium tracking-[0.12em] uppercase" />
            }
          >
            <FlaskConical className="size-3.5" />
            Simulation · replay the capture
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            The recorded capture plays again. The whole dashboard shows the
            state at the replay time. The data does not change.
          </TooltipContent>
        </Tooltip>
        {atEnd ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="text-muted-foreground inline-flex h-6 cursor-help items-center gap-1.5 px-2 text-[11px]" />
              }
            >
              <span className="bg-ok size-1.5 rounded-full" />
              Live end state
            </TooltipTrigger>
            <TooltipContent>
              The dashboard shows the state at the end of the capture.
            </TooltipContent>
          </Tooltip>
        ) : (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              pause();
              seek(end);
            }}
          >
            <SkipForward /> Live end state
          </Button>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon"
                  className="rounded-full"
                  onClick={toggle}
                  aria-label={playing ? "Pause" : "Play"}
                />
              }
            >
              {playing ? <Pause /> : atEnd ? <RotateCcw /> : <Play />}
            </TooltipTrigger>
            <TooltipContent>
              {playing
                ? "Pause (space)"
                : atEnd
                  ? "Play the capture from 0:00 (space)"
                  : "Play (space)"}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  onClick={() => seek(t - 60)}
                  aria-label="Back 1 minute"
                />
              }
            >
              <SkipBack />
            </TooltipTrigger>
            <TooltipContent>Back 1 min (shift + left arrow)</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  onClick={() => seek(t + 60)}
                  aria-label="Forward 1 minute"
                />
              }
            >
              <SkipForward />
            </TooltipTrigger>
            <TooltipContent>Forward 1 min (shift + right arrow)</TooltipContent>
          </Tooltip>
        </div>
        <Tooltip>
          <TooltipTrigger
            render={
              <div className="cursor-help font-mono text-sm tabular-nums" />
            }
          >
            <span className="text-foreground font-semibold">{mmss(t)}</span>
            <span className="text-muted-foreground"> / {mmss(end)}</span>
            {startEpoch != null && (
              <span className="text-muted-foreground ml-2 text-xs">
                {fmtClock(startEpoch, t)} UTC
              </span>
            )}
          </TooltipTrigger>
          <TooltipContent>
            Replay time since the start of the capture, and the wall clock in
            UTC.
          </TooltipContent>
        </Tooltip>
        <div
          className="ml-auto flex items-center gap-0.5"
          role="group"
          aria-label="Replay speed"
        >
          {SPEEDS.map((s) => (
            <Tooltip key={s}>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={() => setSpeed(s)}
                    aria-pressed={speed === s}
                    className={cn(
                      "rounded-full px-2 py-0.5 font-mono text-[11px] tabular-nums transition-colors",
                      speed === s
                        ? "bg-foreground text-background"
                        : "text-muted-foreground hover:bg-background hover:text-foreground",
                    )}
                  />
                }
              >
                {s}×
              </TooltipTrigger>
              <TooltipContent>
                {s === 1
                  ? "Real time"
                  : `The ${mmss(end)} capture plays in ${mmss(end / s)}`}
              </TooltipContent>
            </Tooltip>
          ))}
        </div>
      </div>

      <Track replay={replay} result={result} />
      <ChannelStrip states={states} groups={model.groups} />
    </section>
  );
}

// Thin draggable track with a tick at the start of each finding (urgency colour)
function Track({ replay, result }: { replay: Replay; result: Result }) {
  const { t, end } = replay;
  const { track, hover, handlers } = useReplayTrack(replay);
  const pct = (v: number) => `${(Math.min(Math.max(v, 0), end) / end) * 100}%`;
  const marks = result.findings.filter((f) => urgencyOf(f) !== "grey");
  const redSpans = result.findings.filter((f) => urgencyOf(f) === "red");
  return (
    <div className="mt-4">
      <div
        ref={track}
        role="slider"
        tabIndex={0}
        aria-label="Replay position"
        aria-valuemin={0}
        aria-valuemax={Math.round(end)}
        aria-valuenow={Math.round(t)}
        aria-valuetext={`${mmss(t)} of ${mmss(end)}`}
        className="relative h-7 cursor-pointer touch-none select-none"
        {...handlers}
      >
        <div className="bg-border absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full" />
        {/* periods in which a tools-network problem is active: thin line under the track */}
        {redSpans.map((f) => (
          <div
            key={`r${f.id}`}
            className="bg-tesla/70 absolute top-[calc(50%+5px)] h-px"
            style={{
              left: pct(f.t_start),
              width: `calc(${pct(f.t_end)} - ${pct(f.t_start)})`,
            }}
          />
        ))}
        <div
          className="bg-foreground absolute top-1/2 left-0 h-1 -translate-y-1/2 rounded-full"
          style={{ width: pct(t) }}
        />
        {marks.map((f) => (
          <span
            key={f.id}
            className="pointer-events-none absolute top-0 h-2 w-0.5 -translate-x-1/2 rounded-full"
            style={{
              left: pct(f.t_start),
              background: URGENCY[urgencyOf(f)].dot,
              opacity: f.t_start <= t ? 1 : 0.45,
            }}
          />
        ))}
        {hover != null && (
          <span
            className="bg-foreground text-background pointer-events-none absolute -top-5 -translate-x-1/2 rounded px-1 py-px font-mono text-[10px] whitespace-nowrap"
            style={{ left: pct(hover) }}
          >
            {mmss(hover)}
          </span>
        )}
        <span
          className="bg-background border-foreground pointer-events-none absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 shadow-sm"
          style={{ left: pct(t) }}
        />
      </div>
      <div className="text-muted-foreground mt-0.5 flex justify-between font-mono text-[10px]">
        <span>0:00</span>
        <span className="hidden sm:inline">
          Ticks: start of a finding · red line: tools network hit
        </span>
        <span>{mmss(end)}</span>
      </div>
    </div>
  );
}

function fmtNum(v: number | null | undefined, digits = 0) {
  return v == null ? "-" : v.toFixed(digits);
}

// UniFi-like channel strip: one segment per channel, coloured by its health at the replay time
function ChannelStrip({
  states,
  groups,
}: {
  states: ChannelState[];
  groups: number[][];
}) {
  const byCh = new Map(states.map((s) => [s.channel, s]));
  const band = (g: number[]) =>
    g[0] <= 14
      ? "2.4 GHz"
      : g[0] < 100
        ? "5 GHz · UNII-1"
        : g[0] >= 149
          ? "5 GHz · UNII-3"
          : "5 GHz";
  return (
    <div className="mt-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b pb-1.5">
        <Tooltip>
          <TooltipTrigger
            render={<span className="cursor-help text-[12px] font-medium" />}
          >
            Channel health at replay time
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            One segment for each channel with a sensor. Red: a problem on the
            tools network is active on this channel. Amber: a different finding,
            or retries or noise clearly above the median of this channel.
          </TooltipContent>
        </Tooltip>
        <span className="text-muted-foreground flex flex-wrap gap-x-3 text-[11px]">
          {(Object.keys(HEALTH) as Health[]).map((h) => (
            <span key={h} className="inline-flex items-center gap-1.5">
              <span
                className="size-1.5 rounded-full"
                style={{ background: HEALTH[h].color }}
              />
              {HEALTH[h].label}
            </span>
          ))}
        </span>
      </div>
      <div className="mt-3 flex gap-3 sm:gap-5">
        {groups.map((g) => (
          <div key={g[0]} className="min-w-0" style={{ flex: g.length }}>
            <div className="text-muted-foreground mb-1 truncate text-[10px]">
              {band(g)}
            </div>
            <div className="flex gap-0.5">
              {g.map((ch) => {
                const s = byCh.get(ch);
                if (!s) return null;
                return <Segment key={ch} s={s} />;
              })}
            </div>
            <div className="flex gap-0.5">
              {g.map((ch) => (
                <span
                  key={ch}
                  className="text-muted-foreground flex-1 pt-1 text-center font-mono text-[10.5px] tabular-nums"
                >
                  {ch}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Segment({
  s,
  className = "h-2 flex-1",
}: {
  s: ChannelState;
  className?: string;
}) {
  const r = s.row;
  const lines: [string, string][] = [
    ["Noise", `${fmtNum(r?.noise_dbm)} dBm`],
    ["SNR", `${fmtNum(r?.snr_db)} dB`],
    ["Rate", `${fmtNum(r?.rate_mbps)} Mbit/s`],
    ["Retries", r ? `${Math.round(r.retry_ratio * 100)} %` : "-"],
    ["Frames", r ? `${r.frames.toLocaleString("en")} / 5 s` : "-"],
  ];
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={`Channel ${s.channel}: ${HEALTH[s.health].label}`}
            className={cn(
              "rounded-[1px] transition-colors duration-300 hover:opacity-80",
              className,
            )}
            style={{ background: HEALTH[s.health].color }}
          />
        }
      />
      <TooltipContent className="flex-col items-start gap-1 text-left">
        <span className="font-medium">
          Channel {s.channel}
          {s.sensor ? ` · ${s.sensor}` : ""} · {HEALTH[s.health].label}
        </span>
        <span className="grid grid-cols-[auto_auto] gap-x-3 font-mono text-[11px] opacity-85">
          {lines.map(([k, v]) => (
            <span key={k} className="contents">
              <span>{k}</span>
              <span className="text-right">{v}</span>
            </span>
          ))}
        </span>
        {r?.noise_dbm == null && (
          <span className="opacity-70">
            No RF values in this analysis. Run it again to get them.
          </span>
        )}
        {s.reasons.map((x) => (
          <span key={x} className="opacity-85">
            {x}
          </span>
        ))}
        {s.findings.slice(0, 3).map((f) => (
          <span key={f.id} className="opacity-85">
            · {f.title}
          </span>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}

// ------------------------------------------------------------------ warnings

function SectionLabel({
  title,
  help,
  right,
}: {
  title: string;
  help: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b pb-2">
      <Tooltip>
        <TooltipTrigger
          render={<h2 className="cursor-help text-[13px] font-medium" />}
        >
          {title}
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">{help}</TooltipContent>
      </Tooltip>
      {right && <div className="text-muted-foreground text-xs">{right}</div>}
    </div>
  );
}

const URGENCY_SHORT: Record<Urgency, string> = {
  red: "Can stop the line",
  purple: "Security",
  yellow: "Office network",
  grey: "Information",
};

function Warnings({
  result,
  t,
  onPick,
  selectedId,
}: {
  result: Result;
  t: number;
  onPick: (f: Finding) => void;
  selectedId: number | null;
}) {
  const startEpoch = result.summary.start_epoch;
  const active = result.findings
    .filter((f) => isActiveAt(f, t) && f.severity !== "info")
    .sort(byPriority);
  const top = active.slice(0, 3);
  return (
    <section>
      <SectionLabel
        title="Most important warnings"
        help="The three most important findings that are active at the replay time. Problems on the tools network come first."
        right={
          active.length > top.length
            ? `${top.length} of ${active.length} active`
            : `${plural(active.length, "active warning", "active warnings")}`
        }
      />
      {top.length === 0 ? (
        <p className="text-muted-foreground py-4 text-sm">
          No warning is active at this time.
        </p>
      ) : (
        <div className="grid gap-3 md:grid-cols-3">
          {top.map((f) => {
            const u = urgencyOf(f);
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => onPick(f)}
                className={cn(
                  "group hover:border-foreground/40 flex min-w-0 flex-col gap-2 rounded-md border p-4 text-left transition-colors",
                  selectedId === f.id && "border-foreground/60",
                )}
              >
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5 text-[10.5px] font-medium tracking-[0.08em] uppercase",
                    u === "red" ? "text-tesla" : "text-muted-foreground",
                  )}
                >
                  <UrgencyDot finding={f} />
                  {URGENCY_SHORT[u]}
                </span>
                <span className="line-clamp-2 text-[14px] leading-snug font-medium">
                  {f.title}
                </span>
                <span className="text-muted-foreground mt-auto flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                  <ActionChip finding={f} />
                  <Tooltip>
                    <TooltipTrigger
                      render={<span className="cursor-help font-mono" />}
                    >
                      since {clockOf(startEpoch, f.t_start)}
                    </TooltipTrigger>
                    <TooltipContent>
                      Active for {mmss(Math.max(0, t - f.t_start))} at the
                      replay time.
                    </TooltipContent>
                  </Tooltip>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ findings

const GROUPS: { key: Urgency; title: string; help: string }[] = [
  {
    key: "red",
    title: "Can stop the line",
    help: "Findings on the tools network (TESLA-TOOLS). Torque tools and robots need it. The supervisor acts first.",
  },
  {
    key: "purple",
    title: "Security",
    help: "Findings that can be an attack. The security team examines them.",
  },
  {
    key: "yellow",
    title: "IT · office network",
    help: "Findings on the office network (TESLA-CORP). IT repairs them. The line continues.",
  },
  {
    key: "grey",
    title: "Information",
    help: "Context and monitoring. No action is necessary.",
  },
];

function FindingsBoard({
  result,
  t,
  selected,
  onPick,
  dsId,
}: {
  result: Result;
  t: number;
  selected: Finding | null;
  onPick: (f: Finding) => void;
  dsId: string;
}) {
  const startEpoch = result.summary.start_epoch;
  const activeN = result.findings.filter((f) => isActiveAt(f, t)).length;
  return (
    <section>
      <SectionLabel
        title="Findings"
        help="Problems grouped by root cause. Select a finding to see what to do, the evidence and the Wireshark filters."
        right={`${plural(result.findings.length, "finding", "findings")} · ${activeN} active at replay time`}
      />
      <div className="grid gap-8 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)] xl:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
        <div className="space-y-6">
          {GROUPS.map((g) => {
            const list = result.findings
              .filter((f) => urgencyOf(f) === g.key)
              .sort(
                (a, b) =>
                  STATE_RANK[stateAt(a, t)] - STATE_RANK[stateAt(b, t)] ||
                  byPriority(a, b),
              );
            if (!list.length) return null;
            const n = list.filter((f) => isActiveAt(f, t)).length;
            return (
              <div key={g.key}>
                <div className="mb-1 flex items-baseline justify-between gap-2">
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <h3
                          className={cn(
                            "cursor-help text-[10.5px] font-medium tracking-[0.08em] uppercase",
                            g.key === "red" && n
                              ? "text-tesla"
                              : "text-muted-foreground",
                          )}
                        />
                      }
                    >
                      {g.title}
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                      {g.help}
                    </TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span className="text-muted-foreground cursor-help font-mono text-[11px] tabular-nums" />
                      }
                    >
                      {n}/{list.length}
                    </TooltipTrigger>
                    <TooltipContent>
                      {n} of {list.length} active at the replay time
                    </TooltipContent>
                  </Tooltip>
                </div>
                <ul className="divide-y border-y">
                  {list.map((f) => (
                    <FindingRow
                      key={f.id}
                      f={f}
                      t={t}
                      startEpoch={startEpoch}
                      selected={selected?.id === f.id}
                      onPick={onPick}
                    />
                  ))}
                </ul>
              </div>
            );
          })}
        </div>

        <div className="hidden lg:block">
          <div className="scrollbar-thin sticky top-[calc(var(--chrome-h,3.5rem)+1.5rem)] max-h-[calc(100dvh-var(--chrome-h,3.5rem)-2.5rem)] overflow-y-auto pr-1">
            {selected ? (
              <>
                <StateLine f={selected} t={t} startEpoch={startEpoch} />
                <FindingDetails
                  dsId={dsId}
                  finding={selected}
                  startEpoch={startEpoch}
                />
              </>
            ) : (
              <p className="text-muted-foreground py-10 text-center text-sm">
                Select a finding to see its details.
              </p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function StateLine({
  f,
  t,
  startEpoch,
}: {
  f: Finding;
  t: number;
  startEpoch: number | null;
}) {
  const s = stateAt(f, t);
  return (
    <div className="text-muted-foreground mb-3 flex items-center gap-2 text-xs">
      <StateMark f={f} state={s} />
      <span>
        Replay time {mmss(t)} · {stateText(f, t, startEpoch)}
      </span>
    </div>
  );
}

function StateMark({ f, state }: { f: Finding; state: FindingState }) {
  const color = URGENCY[urgencyOf(f)].dot;
  if (state === "pending")
    return (
      <span
        aria-hidden="true"
        className="size-2 shrink-0 rounded-full border"
        style={{ borderColor: color }}
      />
    );
  if (state === "over")
    return (
      <span
        aria-hidden="true"
        className="size-2 shrink-0 rounded-full bg-zinc-300"
      />
    );
  return (
    <span
      aria-hidden="true"
      className="relative flex size-2 shrink-0 items-center justify-center"
    >
      <span
        className="absolute size-2 animate-ping rounded-full opacity-40"
        style={{ background: color }}
      />
      <span
        className="relative size-2 rounded-full"
        style={{ background: color }}
      />
    </span>
  );
}

function FindingRow({
  f,
  t,
  startEpoch,
  selected,
  onPick,
}: {
  f: Finding;
  t: number;
  startEpoch: number | null;
  selected: boolean;
  onPick: (f: Finding) => void;
}) {
  const s = stateAt(f, t);
  return (
    <li>
      <button
        type="button"
        onClick={() => onPick(f)}
        aria-current={selected ? "true" : undefined}
        className={cn(
          "relative flex w-full items-start gap-3 py-3 pr-2 pl-3 text-left transition-colors",
          selected ? "bg-muted" : "hover:bg-muted/50",
          s === "pending" && !selected && "opacity-50",
        )}
      >
        {selected && (
          <span className="bg-foreground absolute inset-y-0 left-0 w-0.5" />
        )}
        <span className="mt-1.5">
          <StateMark f={f} state={s} />
        </span>
        <span className="min-w-0 flex-1 space-y-1">
          <span
            className={cn(
              "line-clamp-2 text-[13px] leading-snug",
              s === "active" ? "font-medium" : "text-foreground/80",
            )}
          >
            {f.title}
          </span>
          <span className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
            <ActionChip finding={f} />
            <span className="font-mono">
              {stateText(f, t, startEpoch)}
            </span>
          </span>
        </span>
      </button>
    </li>
  );
}
