"use client";

import { useMemo } from "react";
import {
  Database,
  Pause,
  Play,
  RotateCcw,
  SkipBack,
  SkipForward,
} from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { URGENCY, urgencyOf } from "@/components/action";
import { Segment } from "@/components/dashboard";
import {
  SPEEDS,
  useReplayKeys,
  useReplayTrack,
  type Replay,
} from "@/components/replay";
import {
  fmtClock,
  fmtMmss as mmss,
  type LibraryEntry,
  type Result,
} from "@/lib/api";
import { buildChannelModel, channelStates } from "@/lib/channel-health";
import { cn } from "@/lib/utils";

// Thin replay bar for /final: sits above the site header and looks like part of the browser
// toolbar. Same functions as the dashboard's simulation panel, in one row.
export function ReplayTopBar({
  folders,
  value,
  onChange,
  replay,
  result,
  status,
}: {
  folders: LibraryEntry[];
  value: string | null;
  onChange: (id: string) => void;
  replay?: Replay;
  result?: Result;
  status?: string;
}) {
  return (
    <div
      data-replay
      aria-label="Replay the capture"
      className="bg-browser flex h-11 items-center gap-2 px-2 text-zinc-300 sm:gap-3 sm:px-4"
    >
      <LibraryPicker folders={folders} value={value} onChange={onChange} />
      <span className="h-4 w-px shrink-0 bg-white/10" />
      {replay && result ? (
        <Controls replay={replay} result={result} />
      ) : (
        <span className="truncate text-[11px] text-zinc-500">
          {status === "loading" ? "Loading…" : "No analysis to replay"}
        </span>
      )}
    </div>
  );
}

const IDLE: Record<LibraryEntry["status"], string> = {
  done: "",
  running: "analysis runs",
  queued: "queued",
  failed: "analysis failed",
  missing: "not analysed yet",
};

// Only folders under the repo's data/ can be picked; a folder without an analysis is disabled
function LibraryPicker({
  folders,
  value,
  onChange,
}: {
  folders: LibraryEntry[];
  value: string | null;
  onChange: (id: string) => void;
}) {
  return (
    <Select
      value={value}
      onValueChange={(v) => v && onChange(v as string)}
      items={folders
        .filter((f) => f.dataset_id)
        .map((f) => ({ value: f.dataset_id, label: f.folder }))}
    >
      <SelectTrigger
        size="sm"
        aria-label="Dataset: a folder under data/"
        title="Dataset: a folder under data/ in the repository"
        className="h-7! max-w-44 min-w-0 shrink-0 gap-1.5 border-transparent bg-transparent px-2 font-mono text-[11px] text-zinc-300 shadow-none hover:bg-white/10 hover:text-white focus-visible:border-transparent focus-visible:ring-white/20 [&_svg]:size-3.5! [&_svg]:text-zinc-500!"
      >
        <Database />
        <SelectValue placeholder="data/ …" />
      </SelectTrigger>
      <SelectContent
        align="start"
        alignItemWithTrigger={false}
        className="min-w-64"
      >
        {folders.length === 0 && (
          <div className="text-muted-foreground px-2 py-1.5 text-xs">
            No dataset folder under data/
          </div>
        )}
        {folders.map((f) => (
          <SelectItem
            key={f.folder}
            value={f.dataset_id ?? `missing:${f.folder}`}
            disabled={!f.dataset_id || f.status !== "done"}
          >
            <span className="font-mono text-xs">data/{f.folder}</span>
            <span className="text-muted-foreground truncate text-xs">
              {IDLE[f.status] ||
                `${f.files.length} sensor${f.files.length === 1 ? "" : "s"}`}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function Controls({ replay, result }: { replay: Replay; result: Result }) {
  const { t, playing, speed, end, seek, toggle, pause, setSpeed } = replay;
  useReplayKeys(replay);
  const startEpoch = result.summary.start_epoch;
  const atEnd = t >= end - 0.05;
  const model = useMemo(() => buildChannelModel(result), [result]);
  const states = channelStates(model, result.findings, t);
  const byCh = new Map(states.map((s) => [s.channel, s]));
  const nextSpeed =
    SPEEDS[(SPEEDS.indexOf(speed as (typeof SPEEDS)[number]) + 1) % SPEEDS.length];

  return (
    <>
      <div className="flex shrink-0 items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={toggle}
                aria-label={playing ? "Pause" : "Play"}
                className="flex size-7 items-center justify-center rounded-full bg-zinc-100 text-zinc-900 transition-colors hover:bg-white [&_svg]:size-3.5"
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
        <BarIcon label="Back 1 minute" onClick={() => seek(t - 60)}>
          <SkipBack />
        </BarIcon>
        <BarIcon label="Forward 1 minute" onClick={() => seek(t + 60)}>
          <SkipForward />
        </BarIcon>
      </div>

      <Tooltip>
        <TooltipTrigger
          render={
            <span className="shrink-0 cursor-help font-mono text-[11px] whitespace-nowrap tabular-nums" />
          }
        >
          <span className="text-zinc-100">{mmss(t)}</span>
          <span className="text-zinc-500"> / {mmss(end)}</span>
          {startEpoch != null && (
            <span className="ml-2 hidden text-zinc-500 md:inline">
              {fmtClock(startEpoch, t)} UTC
            </span>
          )}
        </TooltipTrigger>
        <TooltipContent>
          Replay time since the start of the capture, and the wall clock in
          UTC. The whole page shows the state at this time.
        </TooltipContent>
      </Tooltip>

      <Track replay={replay} result={result} />

      <div
        className="hidden shrink-0 items-center gap-1.5 md:flex"
        aria-label="Channel health at replay time"
      >
        {model.groups.map((g) => (
          <div key={g[0]} className="flex gap-px">
            {g.map((ch) => {
              const s = byCh.get(ch);
              return s ? (
                <Segment key={ch} s={s} className="h-1.5 w-2.5" />
              ) : null;
            })}
          </div>
        ))}
      </div>

      <div
        className="hidden shrink-0 items-center gap-0.5 lg:flex"
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
                    "rounded-full px-1.5 py-0.5 font-mono text-[10.5px] tabular-nums transition-colors",
                    speed === s
                      ? "bg-zinc-100 text-zinc-900"
                      : "text-zinc-500 hover:bg-white/10 hover:text-zinc-100",
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
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={() => setSpeed(nextSpeed)}
              aria-label={`Replay speed ${speed}×`}
              className="shrink-0 rounded-full px-1.5 py-0.5 font-mono text-[10.5px] text-zinc-400 tabular-nums hover:bg-white/10 hover:text-zinc-100 lg:hidden"
            />
          }
        >
          {speed}×
        </TooltipTrigger>
        <TooltipContent>Replay speed. Click for {nextSpeed}×.</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              disabled={atEnd}
              onClick={() => {
                pause();
                seek(end);
              }}
              className="hidden shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] text-zinc-400 transition-colors enabled:hover:bg-white/10 enabled:hover:text-zinc-100 disabled:cursor-default sm:inline-flex"
            />
          }
        >
          {atEnd ? (
            <span className="bg-ok size-1.5 rounded-full" />
          ) : (
            <SkipForward className="size-3" />
          )}
          Live
        </TooltipTrigger>
        <TooltipContent>
          {atEnd
            ? "The page shows the state at the end of the capture."
            : "Jump to the state at the end of the capture."}
        </TooltipContent>
      </Tooltip>
    </>
  );
}

function BarIcon({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={onClick}
            aria-label={label}
            className="hidden size-7 items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-white/10 hover:text-zinc-100 sm:flex [&_svg]:size-3.5"
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label} (shift + arrow)</TooltipContent>
    </Tooltip>
  );
}

// Draggable track: ticks at the start of each finding (urgency colour), red line while a
// tools-network problem is active
function Track({ replay, result }: { replay: Replay; result: Result }) {
  const { t, end } = replay;
  const { track, hover, handlers } = useReplayTrack(replay);
  const pct = (v: number) => `${(Math.min(Math.max(v, 0), end) / end) * 100}%`;
  const marks = result.findings.filter((f) => urgencyOf(f) !== "grey");
  const redSpans = result.findings.filter((f) => urgencyOf(f) === "red");
  return (
    <div
      ref={track}
      role="slider"
      tabIndex={0}
      aria-label="Replay position"
      aria-valuemin={0}
      aria-valuemax={Math.round(end)}
      aria-valuenow={Math.round(t)}
      aria-valuetext={`${mmss(t)} of ${mmss(end)}`}
      className="relative h-full min-w-16 flex-1 cursor-pointer touch-none outline-none select-none"
      {...handlers}
    >
      <div className="absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-white/15" />
      {redSpans.map((f) => (
        <div
          key={`r${f.id}`}
          className="bg-tesla absolute top-[calc(50%+4px)] h-px"
          style={{
            left: pct(f.t_start),
            width: `calc(${pct(f.t_end)} - ${pct(f.t_start)})`,
          }}
        />
      ))}
      <div
        className="absolute top-1/2 left-0 h-[3px] -translate-y-1/2 rounded-full bg-zinc-200"
        style={{ width: pct(t) }}
      />
      {marks.map((f) => (
        <span
          key={f.id}
          className="pointer-events-none absolute top-[calc(50%-10px)] h-1.5 w-0.5 -translate-x-1/2 rounded-full"
          style={{
            left: pct(f.t_start),
            background: URGENCY[urgencyOf(f)].dot,
            opacity: f.t_start <= t ? 1 : 0.5,
          }}
        />
      ))}
      {hover != null && (
        <span
          className="pointer-events-none absolute bottom-0.5 -translate-x-1/2 rounded bg-zinc-100 px-1 font-mono text-[9.5px] leading-tight whitespace-nowrap text-zinc-900"
          style={{ left: pct(hover) }}
        >
          {mmss(hover)}
        </span>
      )}
      <span
        className="pointer-events-none absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow"
        style={{ left: pct(t) }}
      />
    </div>
  );
}
