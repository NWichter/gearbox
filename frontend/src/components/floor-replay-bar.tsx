"use client";

import { useMemo } from "react";
import { Pause, Play, RotateCcw, SkipBack, SkipForward } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  SPEEDS,
  useReplayKeys,
  useReplayTrack,
  type Replay,
} from "@/components/replay";
import type { Acks } from "@/lib/acks";
import {
  fmtClock,
  fmtMmss as mmss,
  SEVERITY_COLOR,
  type Result,
} from "@/lib/api";
import { cn } from "@/lib/utils";

// Stacked per-5-s activity: devices kicked off, (re)joining, searching for a network
const SERIES = [
  { key: "deauth", label: "kicked off", color: "#f97316" },
  { key: "auth", label: "joining", color: "#34d399" },
  { key: "probe", label: "searching", color: "#7dd3fc" },
] as const;

// Floor-view variant of the dashboard's ReplayBar (same replay state, keys and dragging):
// stacked coloured activity bars and finding markers that dim once acknowledged
export function FloorReplayBar({
  replay,
  result,
  acks,
}: {
  replay: Replay;
  result: Result;
  acks: Acks;
}) {
  const { t, playing, speed, end, seek, toggle, setSpeed } = replay;
  const { track, hover, handlers } = useReplayTrack(replay);
  useReplayKeys(replay);
  const startEpoch = result.summary.start_epoch;

  // square-root scale so the rare kicks stay visible next to thousands of searches
  const bars = useMemo(() => {
    const rows = result.timeline.map((d) => ({
      t: d.t,
      v: SERIES.map((s) => d[s.key]),
    }));
    const max = Math.max(1, ...rows.map((r) => r.v.reduce((a, b) => a + b, 0)));
    const k = 90 / Math.sqrt(max);
    return rows.map((r) => {
      const total = r.v.reduce((a, b) => a + b, 0);
      const h = Math.sqrt(total) * k;
      let y = 100;
      return {
        t: r.t,
        parts: r.v.map((v, i) => {
          const ph = total ? (v / total) * h : 0;
          y -= ph;
          return { y, h: ph, color: SERIES[i].color };
        }),
      };
    });
  }, [result.timeline]);

  const pct = (v: number) => `${(Math.min(Math.max(v, 0), end) / end) * 100}%`;
  const markers = result.findings.filter((f) => f.severity !== "info");

  return (
    <div data-replay className="space-y-2">
      <div className="flex items-center gap-1.5">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon"
                variant="outline"
                onClick={toggle}
                aria-label={playing ? "Pause" : "Play"}
              >
                {playing ? <Pause /> : t >= end ? <RotateCcw /> : <Play />}
              </Button>
            }
          />
          <TooltipContent>
            {playing ? "Pause" : "Play the capture"} (space)
          </TooltipContent>
        </Tooltip>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={() => seek(t - 60)}
          aria-label="Back one minute"
        >
          <SkipBack />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={() => seek(t + 60)}
          aria-label="Forward one minute"
        >
          <SkipForward />
        </Button>

        <div className="ml-1 font-mono text-sm whitespace-nowrap tabular-nums">
          <span className="text-foreground font-semibold">{mmss(t)}</span>
          <span className="text-muted-foreground"> / {mmss(end)}</span>
          {startEpoch != null && (
            <span className="text-muted-foreground ml-2 hidden text-xs sm:inline">
              {fmtClock(startEpoch, t)} UTC
            </span>
          )}
        </div>

        <div className="text-muted-foreground ml-auto hidden items-center gap-2.5 text-[10.5px] xl:flex">
          {SERIES.map((s) => (
            <span key={s.key} className="flex items-center gap-1">
              <span
                className="size-2 rounded-[2px]"
                style={{ background: s.color }}
              />
              {s.label}
            </span>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-0.5 xl:ml-3">
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSpeed(s)}
              aria-pressed={speed === s}
              title={
                s === 1
                  ? "Real time"
                  : `The ${mmss(end)} capture plays in ${mmss(end / s)}`
              }
              className={cn(
                "rounded-md px-1.5 py-0.5 font-mono text-xs tabular-nums transition-colors",
                speed === s
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:text-foreground hover:bg-white/10",
              )}
            >
              {s}×
            </button>
          ))}
        </div>
      </div>

      {/* track: click or drag anywhere, also while playing */}
      <div
        ref={track}
        role="slider"
        tabIndex={0}
        aria-label="Replay position"
        aria-valuemin={0}
        aria-valuemax={Math.round(end)}
        aria-valuenow={Math.round(t)}
        aria-valuetext={`${mmss(t)} of ${mmss(end)}`}
        className="relative h-11 cursor-pointer touch-none overflow-hidden rounded-[8px] bg-black/35 ring-1 ring-white/10 select-none"
        {...handlers}
      >
        <svg
          className="absolute inset-0 h-full w-full"
          viewBox={`0 0 ${end} 100`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {bars.map((b) => (
            <g key={b.t} opacity={b.t <= t ? 0.95 : 0.3}>
              {b.parts.map((p, i) =>
                p.h > 0 ? (
                  <rect
                    key={i}
                    x={b.t}
                    width={4.4}
                    y={p.y}
                    height={p.h}
                    fill={p.color}
                  />
                ) : null,
              )}
            </g>
          ))}
        </svg>
        {/* finding start markers; acknowledged ones fade, fixed ones nearly vanish */}
        {markers.map((f) => {
          const a = acks[f.id];
          return (
            <span
              key={f.id}
              className="pointer-events-none absolute top-0 h-2.5 w-[3px] rounded-b-[1px]"
              style={{
                left: pct(f.t_start),
                background: SEVERITY_COLOR[f.severity],
                opacity:
                  a?.state === "done"
                    ? 0.15
                    : a
                      ? 0.35
                      : f.t_start <= t
                        ? 1
                        : 0.55,
              }}
            />
          );
        })}
        {hover != null && (
          <div
            className="pointer-events-none absolute inset-y-0 w-px bg-white/30"
            style={{ left: pct(hover) }}
          >
            <span className="absolute top-1 left-1.5 rounded bg-zinc-900/90 px-1 py-px font-mono text-[10px] whitespace-nowrap">
              {mmss(hover)}
            </span>
          </div>
        )}
        {/* playhead */}
        <div
          className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-white"
          style={{ left: pct(t) }}
        >
          <span className="absolute top-0 left-1/2 size-2 -translate-x-1/2 rounded-full bg-white" />
        </div>
      </div>
    </div>
  );
}
