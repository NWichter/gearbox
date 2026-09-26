"use client";

import { useMemo, useRef, useState } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { SeverityDot } from "@/components/severity";
import { ActionChip, URGENCY, urgencyOf } from "@/components/action";
import {
  fmtClock,
  fmtT,
  SEVERITY_COLOR,
  SEVERITY_RANK,
  TYPE_LABEL,
  type Finding,
} from "@/lib/api";
import { cn } from "@/lib/utils";

const STEPS = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];

function mmss(s: number) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s - m * 60)).padStart(2, "0")}`;
}

export function affectedCount(f: Finding) {
  return f.affected?.length ?? 0;
}

// Gantt / swimlane view: one lane per finding, bar from t_start to t_end
export function IncidentTimeline({
  findings,
  duration,
  startEpoch,
  onPick,
  playhead,
  onSeek,
}: {
  findings: Finding[];
  duration: number;
  startEpoch: number | null;
  onPick: (f: Finding) => void;
  // replay position in seconds; the part after it is dimmed
  playhead?: number;
  onSeek?: (t: number) => void;
}) {
  const lanes = useMemo(
    () =>
      [...findings].sort(
        (a, b) =>
          SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
          a.t_start - b.t_start,
      ),
    [findings],
  );
  const end = Math.max(duration, ...findings.map((f) => f.t_end), 1);
  const step = STEPS.find((s) => end / s <= 7) ?? 3600;
  const ticks: number[] = [];
  for (let t = 0; t <= end; t += step) ticks.push(t);

  const track = useRef<HTMLDivElement>(null);
  const [scrub, setScrub] = useState<number | null>(null);

  const pct = (t: number) => `${(Math.min(Math.max(t, 0), end) / end) * 100}%`;

  if (!lanes.length)
    return (
      <div className="text-muted-foreground rounded-sm border border-dashed px-3 py-4 text-xs">
        The capture has no incidents.
      </div>
    );

  return (
    <div className="space-y-2">
      <div
        className="relative"
        onMouseMove={(e) => {
          const r = track.current?.getBoundingClientRect();
          if (!r) return;
          const x = (e.clientX - r.left) / r.width;
          setScrub(x >= 0 && x <= 1 ? x * end : null);
        }}
        onMouseLeave={() => setScrub(null)}
      >
        {/* axis */}
        <div className="grid grid-cols-1 gap-x-4 pl-3 sm:grid-cols-[minmax(0,17rem)_1fr]">
          <div className="text-muted-foreground hidden self-end pb-1 text-[11px] sm:block">
            Incident
          </div>
          <div
            ref={track}
            className={cn("relative h-9 border-b", onSeek && "cursor-pointer")}
            onClick={(e) => {
              if (!onSeek) return;
              const r = e.currentTarget.getBoundingClientRect();
              onSeek(((e.clientX - r.left) / r.width) * end);
            }}
          >
            {ticks.map((t) => (
              <div
                key={t}
                className={cn(
                  "text-muted-foreground absolute bottom-1 text-center font-mono text-[10px] leading-tight whitespace-nowrap",
                  t === 0
                    ? "text-left"
                    : t / end > 0.94
                      ? "-translate-x-full text-right"
                      : "-translate-x-1/2",
                )}
                style={{ left: pct(t) }}
              >
                {mmss(t)}
                {startEpoch != null && (
                  <div className="hidden opacity-60 md:block">
                    {fmtClock(startEpoch, t)}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* lanes */}
        <div className="divide-y divide-zinc-100 dark:divide-white/5">
          {lanes.map((f) => {
            const n = affectedCount(f);
            const color = SEVERITY_COLOR[f.severity];
            return (
              <div
                key={f.id}
                className="group relative grid grid-cols-1 items-center gap-x-4 gap-y-1 py-1 pl-3 sm:grid-cols-[minmax(0,17rem)_1fr]"
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute top-1 bottom-1 left-0 w-[3px]",
                    URGENCY[urgencyOf(f)].stripe,
                  )}
                />
                <button
                  onClick={() => onPick(f)}
                  className="flex min-w-0 items-center gap-2 text-left text-xs"
                >
                  <SeverityDot severity={f.severity} />
                  <span className="group-hover:text-foreground text-foreground/85 min-w-0 flex-1 truncate">
                    {f.title}
                  </span>
                  {n > 0 && (
                    <span className="text-muted-foreground shrink-0 font-mono text-[10px] tabular-nums">
                      {n} dev
                    </span>
                  )}
                  <ActionChip finding={f} compact />
                </button>
                <div className="relative h-5 bg-zinc-50 dark:bg-white/[0.02]">
                  {ticks.map((t) => (
                    <div
                      key={t}
                      className="absolute inset-y-0 w-px bg-zinc-200/70 dark:bg-white/[0.04]"
                      style={{ left: pct(t) }}
                    />
                  ))}
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          onClick={() => onPick(f)}
                          aria-label={`Open ${f.title}`}
                          className="absolute top-1 bottom-1 min-w-1.5 rounded-[1px] opacity-85 hover:opacity-100"
                          style={{
                            left: pct(f.t_start),
                            width: `max(6px, calc(${pct(f.t_end)} - ${pct(f.t_start)}))`,
                            background: color,
                          }}
                        />
                      }
                    />
                    <TooltipContent className="flex-col items-start gap-0.5">
                      <span className="font-medium">{f.title}</span>
                      <span className="opacity-70">
                        {TYPE_LABEL[f.type] ?? f.type} · {fmtT(f.t_start)} -{" "}
                        {fmtT(f.t_end)}
                        {startEpoch != null &&
                          ` (${fmtClock(startEpoch, f.t_start)} UTC)`}
                        {n > 0 && ` · ${n} devices`}
                      </span>
                      {f.action && (
                        <span className="font-medium">{f.action.label}</span>
                      )}
                      {(f.scope || f.networks?.length) && (
                        <span className="opacity-70">
                          {[f.scope, f.networks?.join(", ")]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      )}
                    </TooltipContent>
                  </Tooltip>
                </div>
              </div>
            );
          })}
        </div>

        {/* replay playhead: future dimmed */}
        {playhead != null && (
          <div className="pointer-events-none absolute inset-y-0 right-0 left-0 grid grid-cols-1 gap-x-4 pl-3 sm:grid-cols-[minmax(0,17rem)_1fr]">
            <div className="hidden sm:block" />
            <div className="relative">
              <div
                className="bg-background/60 absolute inset-y-0 right-0"
                style={{ left: pct(playhead) }}
              />
              <div
                className="bg-foreground absolute inset-y-0 w-px"
                style={{ left: pct(playhead) }}
              />
            </div>
          </div>
        )}

        {/* scrub line */}
        {scrub != null && (
          <div className="pointer-events-none absolute inset-y-0 right-0 left-0 grid grid-cols-1 gap-x-4 pl-3 sm:grid-cols-[minmax(0,17rem)_1fr]">
            <div className="hidden sm:block" />
            <div className="relative">
              <div
                className="bg-foreground/40 absolute inset-y-0 w-px"
                style={{ left: pct(scrub) }}
              >
                <span className="bg-foreground text-background absolute -top-1 left-1 rounded px-1 py-px font-mono text-[10px] whitespace-nowrap">
                  {fmtT(scrub)}
                  {startEpoch != null && ` · ${fmtClock(startEpoch, scrub)}`}
                </span>
              </div>
            </div>
          </div>
        )}
      </div>
      <p
        className={cn(
          "text-muted-foreground text-xs",
          startEpoch == null && "hidden",
        )}
      >
        Axis: capture time (m:ss) and wall clock in UTC.
      </p>
    </div>
  );
}
