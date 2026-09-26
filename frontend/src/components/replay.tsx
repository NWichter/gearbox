"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play, RotateCcw, SkipBack, SkipForward } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { SeverityDot } from "@/components/severity";
import { ActionChip } from "@/components/action";
import {
  fmtClock,
  fmtMmss as mmss,
  SEVERITY_COLOR,
  SEVERITY_RANK,
  type Finding,
  type Result,
} from "@/lib/api";
import { cn } from "@/lib/utils";

// Replay speeds: 1x is real time, 60x plays the 30-minute capture in 30 s
export const SPEEDS = [1, 5, 10, 30, 60, 120] as const;
const WINDOW = 60; // "last minute" counters

export type Replay = {
  t: number;
  playing: boolean;
  speed: number;
  end: number;
  seek: (t: number) => void;
  toggle: () => void;
  pause: () => void;
  setSpeed: (s: number) => void;
  setDragging: (d: boolean) => void;
};

// Playhead that advances in real time x speed; seeking works while playing.
// `initial` is the start position (the dashboard opens at the end state).
export function useReplay(end: number, initial = 0): Replay {
  const [t, setT] = useState(initial);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(30);
  const dragging = useRef(false);
  const tRef = useRef(initial);
  useEffect(() => {
    tRef.current = t;
  }, [t]);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      if (!dragging.current) {
        const next = tRef.current + dt * speed;
        tRef.current = Math.min(next, end);
        setT(tRef.current);
        if (next >= end) {
          setPlaying(false);
          return;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, end]);

  const seek = useCallback(
    (v: number) => {
      tRef.current = Math.min(Math.max(v, 0), end);
      setT(tRef.current);
    },
    [end],
  );
  const toggle = useCallback(() => {
    setPlaying((p) => {
      // pressing play at the end starts over
      if (!p && tRef.current >= end) {
        tRef.current = 0;
        setT(0);
      }
      return !p;
    });
  }, [end]);
  const pause = useCallback(() => setPlaying(false), []);
  const setDragging = useCallback((d: boolean) => {
    dragging.current = d;
  }, []);

  return {
    t,
    playing,
    speed,
    end,
    seek,
    toggle,
    pause,
    setSpeed,
    setDragging,
  };
}

// Keyboard inside a [data-replay] element: space = play/pause, arrows = +-10 s (+-60 s with shift)
export function useReplayKeys({ t, seek, toggle }: Replay) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, [contenteditable=true]")) return;
      if (e.code === "Space" && el.closest("[data-replay]")) {
        e.preventDefault();
        toggle();
      } else if (e.key === "ArrowRight" && el.closest("[data-replay]")) {
        e.preventDefault();
        seek(t + (e.shiftKey ? 60 : 10));
      } else if (e.key === "ArrowLeft" && el.closest("[data-replay]")) {
        e.preventDefault();
        seek(t - (e.shiftKey ? 60 : 10));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [t, seek, toggle]);
}

// Click-or-drag track (also while playing): returns the ref, pointer handlers and the hover time
export function useReplayTrack({ end, seek, setDragging }: Replay) {
  const track = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const at = (clientX: number) => {
    const r = track.current?.getBoundingClientRect();
    if (!r) return 0;
    return ((clientX - r.left) / r.width) * end;
  };
  const handlers = {
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      setDragging(true);
      seek(at(e.clientX));
    },
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
      const v = at(e.clientX);
      setHover(v >= 0 && v <= end ? v : null);
      if (e.currentTarget.hasPointerCapture(e.pointerId)) seek(v);
    },
    onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => {
      e.currentTarget.releasePointerCapture(e.pointerId);
      setDragging(false);
    },
    onPointerCancel: () => setDragging(false),
    onPointerLeave: () => setHover(null),
  };
  return { track, hover, handlers };
}

// Transport bar: play/pause, skip, speed, and a draggable track with incident markers
export function ReplayBar({
  replay,
  result,
  startEpoch,
}: {
  replay: Replay;
  result: Result;
  startEpoch: number | null;
}) {
  const { t, playing, speed, end, seek, toggle, setSpeed } = replay;
  const { track, hover, handlers } = useReplayTrack(replay);
  useReplayKeys(replay);

  // activity sparkline: kicks + failed logins per 5-s window
  const spark = useMemo(() => {
    const rows = result.timeline.map((d) => ({
      t: d.t,
      v: d.deauth + d.eap_failure,
    }));
    const max = Math.max(1, ...rows.map((r) => r.v));
    return { rows, max };
  }, [result.timeline]);

  const pct = (v: number) => `${(Math.min(Math.max(v, 0), end) / end) * 100}%`;
  const markers = result.findings.filter((f) => f.severity !== "info");

  return (
    <div data-replay className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon"
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
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={() => seek(t - 60)}
                aria-label="Back one minute"
              >
                <SkipBack />
              </Button>
            }
          />
          <TooltipContent>Back 1 min (shift + left arrow)</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={() => seek(t + 60)}
                aria-label="Forward one minute"
              >
                <SkipForward />
              </Button>
            }
          />
          <TooltipContent>Forward 1 min (shift + right arrow)</TooltipContent>
        </Tooltip>

        <div className="ml-1 font-mono text-sm tabular-nums">
          <span className="text-foreground font-semibold">
            {mmss(t)}
          </span>
          <span className="text-muted-foreground"> / {mmss(end)}</span>
          {startEpoch != null && (
            <span className="text-muted-foreground ml-2 text-xs">
              {fmtClock(startEpoch, t)} UTC
            </span>
          )}
        </div>

        <div className="ml-auto flex items-center gap-1">
          <span className="text-muted-foreground mr-1 text-xs">Speed</span>
          {SPEEDS.map((s) => (
            <Tooltip key={s}>
              <TooltipTrigger
                render={
                  <button
                    onClick={() => setSpeed(s)}
                    aria-pressed={speed === s}
                    className={cn(
                      "rounded-sm px-1.5 py-0.5 font-mono text-xs tabular-nums transition-colors",
                      speed === s
                        ? "bg-foreground text-background"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    {s}×
                  </button>
                }
              />
              <TooltipContent>
                {s === 1
                  ? "Real time"
                  : `The ${mmss(end)} capture plays in ${mmss(end / s)}`}
              </TooltipContent>
            </Tooltip>
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
        className="group bg-muted/50 relative h-10 cursor-pointer touch-none rounded-sm border select-none dark:bg-black/20"
        {...handlers}
      >
        <svg
          className="absolute inset-0 h-full w-full"
          viewBox={`0 0 ${end} 100`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {spark.rows.map((r) =>
            r.v ? (
              <rect
                key={r.t}
                x={r.t}
                width={5}
                y={100 - (r.v / spark.max) * 70}
                height={(r.v / spark.max) * 70}
                className={
                  r.t <= t
                    ? "fill-zinc-500 dark:fill-zinc-400"
                    : "fill-zinc-300 dark:fill-zinc-600"
                }
                opacity={r.t <= t ? 0.7 : 0.6}
              />
            ) : null,
          )}
        </svg>
        {/* played part */}
        <div
          className="pointer-events-none absolute inset-y-0 left-0 bg-black/[0.03] dark:bg-white/[0.04]"
          style={{ width: pct(t) }}
        />
        {/* incident start markers */}
        {markers.map((f) => (
          <span
            key={f.id}
            className="pointer-events-none absolute top-0 h-2 w-0.5"
            style={{
              left: pct(f.t_start),
              background: SEVERITY_COLOR[f.severity],
              opacity: f.t_start <= t ? 1 : 0.45,
            }}
          />
        ))}
        {hover != null && (
          <div
            className="bg-foreground/25 pointer-events-none absolute inset-y-0 w-px"
            style={{ left: pct(hover) }}
          >
            <span className="bg-muted text-foreground absolute -top-6 -translate-x-1/2 rounded px-1 py-px font-mono text-[10px] whitespace-nowrap">
              {mmss(hover)}
            </span>
          </div>
        )}
        {/* playhead */}
        <div
          className="bg-foreground pointer-events-none absolute inset-y-[-3px] w-px"
          style={{ left: pct(t) }}
        >
          <span className="bg-foreground absolute -top-px left-1/2 size-1.5 -translate-x-1/2" />
        </div>
      </div>
      <p className="text-muted-foreground text-xs">
        Bars: deauth, disassoc and EAP failure frames per 5 s. Ticks: start of
        an incident, in the colour of its severity. Keys: space plays or
        pauses. The arrow keys move 10 s (with shift: 60 s).
      </p>
    </div>
  );
}

// What is going on at the playhead: incidents active now and the last minute of traffic
export function ReplayNow({
  replay,
  result,
  onPick,
}: {
  replay: Replay;
  result: Result;
  onPick: (f: Finding) => void;
}) {
  const { t } = replay;
  const active = result.findings
    .filter((f) => f.t_start <= t && f.t_end + 5 >= t)
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  const started = result.findings.filter((f) => f.t_start <= t).length;

  const last = result.timeline.filter((d) => d.t > t - WINDOW && d.t <= t);
  const sum = (k: "deauth" | "eap_failure" | "auth" | "probe" | "handshake") =>
    last.reduce((a, d) => a + d[k], 0);
  // a silent login server sends no EAP failure; then show key exchanges instead
  const hasEapFailures = result.timeline.some((d) => d.eap_failure > 0);

  const counters = [
    {
      label: "deauth / disassoc",
      help: "Deauth and disassoc frames. The AP or the device ended the connection.",
      n: sum("deauth"),
      tone: "text-orange-600 dark:text-orange-300",
    },
    hasEapFailures
      ? {
          label: "EAP failures",
          help: "EAP failure frames. The login server refused the login.",
          n: sum("eap_failure"),
          tone: "text-red-600 dark:text-red-300",
        }
      : {
          label: "4-way handshakes",
          help: "4-way handshake frames. This is the last step of a Wi-Fi login.",
          n: sum("handshake"),
          tone: "text-foreground",
        },
    {
      label: "auth / assoc",
      help: "Authentication and association frames. Devices connect or connect again.",
      n: sum("auth"),
      tone: "text-foreground",
    },
    {
      label: "probe requests",
      help: "Probe requests. Devices search for a network.",
      n: sum("probe"),
      tone: "text-foreground",
    },
  ];

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_minmax(0,22rem)]">
      <div className="space-y-2">
        <div className="flex items-baseline justify-between">
          <h3 className="text-sm font-semibold">
            Active at playhead{" "}
            <span className="text-muted-foreground font-normal">
              · {active.length} active · {started}/{result.findings.length}{" "}
              started
            </span>
          </h3>
        </div>
        {active.length === 0 ? (
          <p className="text-muted-foreground rounded-sm border border-dashed px-3 py-3 text-xs">
            No incident is active at this time.
          </p>
        ) : (
          <ul className="divide-y rounded-sm border">
            {active.map((f) => (
              <li key={f.id}>
                <button
                  onClick={() => onPick(f)}
                  className="hover:bg-muted/60 flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px] dark:hover:bg-white/[0.03]"
                >
                  <SeverityDot severity={f.severity} />
                  <span className="min-w-0 flex-1 truncate">{f.title}</span>
                  <span className="text-muted-foreground font-mono text-[11px] tabular-nums">
                    since {mmss(f.t_start)}
                  </span>
                  <ActionChip finding={f} compact />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="space-y-2">
        <h3 className="text-sm font-semibold">
          Last 60 s{" "}
          <span className="text-muted-foreground font-normal">
            · all sensors, de-duplicated
          </span>
        </h3>
        <div className="bg-border grid grid-cols-2 gap-px overflow-hidden rounded-sm border">
          {counters.map((c) => (
            <Tooltip key={c.label}>
              <TooltipTrigger
                render={
                  <div className="bg-card cursor-help px-2.5 py-1.5">
                    <div
                      className={cn(
                        "text-lg font-semibold tabular-nums",
                        c.n ? c.tone : "text-muted-foreground",
                      )}
                    >
                      {c.n.toLocaleString("en")}
                    </div>
                    <div className="text-muted-foreground text-[11px]">
                      {c.label}
                    </div>
                  </div>
                }
              />
              <TooltipContent>{c.help}</TooltipContent>
            </Tooltip>
          ))}
        </div>
      </div>
    </div>
  );
}
