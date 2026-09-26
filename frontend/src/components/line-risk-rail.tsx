"use client";

import { RotateCcw, TriangleAlert, X } from "lucide-react";
import { ActionChip, toolsDevices, urgencyOf } from "@/components/action";
import { AckButton } from "@/components/floor-map";
import { ackClock, type AckState, type Acks } from "@/lib/acks";
import { fmtClock, fmtMmss, type Finding, type Result } from "@/lib/api";
import { cn } from "@/lib/utils";

// Right-hand rail: the problems that can stop the line, in the order they appeared, each to
// acknowledge and then mark as fixed. Below 1024 px it is a drawer (`open` / `onClose`).
export function LineRiskRail({
  result,
  t,
  acks,
  shared,
  open,
  onClose,
  onAck,
  onReset,
  onPick,
  onFocus,
}: {
  result: Result;
  t: number;
  acks: Acks;
  shared: boolean; // acks come from the server (every screen sees them)
  open: boolean;
  onClose: () => void;
  onAck: (id: number, state: AckState | null) => void;
  onReset: () => void;
  onPick: (f: Finding) => void;
  onFocus: (f: Finding) => void;
}) {
  const start = result.summary.start_epoch;
  // only what has happened by the playhead: a live system cannot know the future
  const items = result.findings
    .filter((f) => urgencyOf(f) === "red" && f.t_start <= t)
    .sort((a, b) => a.t_start - b.t_start);
  const pending = items.filter((f) => acks[f.id]?.state !== "done");
  const later = result.findings.filter(
    (f) => urgencyOf(f) === "red" && f.t_start > t,
  ).length;
  const bad = pending.length > 0;

  return (
    <aside
      data-floor-avoid
      aria-label="Line risk"
      className={cn(
        "absolute top-4 right-4 bottom-24 z-10 w-[340px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-[16px] bg-zinc-950/75 shadow-2xl ring-1 ring-white/10 backdrop-blur-xl lg:flex",
        open ? "flex" : "hidden",
      )}
    >
      <header
        className={cn(
          "border-b border-white/10 px-4 pt-4 pb-3",
          bad
            ? "bg-linear-to-br from-red-500/20 to-transparent"
            : "bg-linear-to-br from-emerald-500/15 to-transparent",
        )}
      >
        <div className="flex items-center justify-between">
          <div
            className={cn(
              "text-[11px] font-semibold tracking-wider",
              bad ? "text-red-300" : "text-emerald-300",
            )}
          >
            LINE RISK
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-muted-foreground hover:text-foreground lg:hidden"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="mt-1 flex items-end justify-between gap-3">
          <div className="font-heading text-lg leading-tight font-semibold">
            {bad ? (
              <>
                {pending.length} {pending.length === 1 ? "problem" : "problems"}{" "}
                can stop the line
              </>
            ) : (
              "Line is safe"
            )}
          </div>
          {bad && <TriangleAlert className="size-6 shrink-0 text-red-400" />}
        </div>
        <div className="text-muted-foreground mt-1 text-xs">
          {toolsDevices(pending)} tools-network devices affected · ~50,000 € per
          minute of stop
        </div>
      </header>

      <ol className="scrollbar-thin relative flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {items.length === 0 && (
          <li className="text-muted-foreground text-sm">
            No line-stopping problem so far in this shift.
          </li>
        )}
        {items.length > 0 && (
          <span
            aria-hidden="true"
            className="absolute top-6 bottom-6 left-[1.45rem] w-px bg-white/10"
          />
        )}
        {items.map((f) => {
          const a = acks[f.id];
          const live = f.t_end + 5 >= t;
          return (
            <li key={f.id} className="relative pl-6">
              <span
                aria-hidden="true"
                className={cn(
                  "absolute top-1.5 left-0 flex size-3 items-center justify-center rounded-full ring-4 ring-zinc-950",
                  a?.state === "done"
                    ? "bg-emerald-500"
                    : a?.state === "ack"
                      ? "bg-amber-400"
                      : "bg-red-500",
                )}
              >
                {!a && live && (
                  <span className="absolute size-3 animate-ping rounded-full bg-red-500 opacity-60" />
                )}
              </span>
              {/* a click on the card shows the spot on the map; the title opens the details */}
              <div
                role="button"
                tabIndex={0}
                title="Show on the map"
                onClick={() => onFocus(f)}
                onKeyDown={(e) => {
                  if (
                    e.target === e.currentTarget &&
                    (e.key === "Enter" || e.key === " ")
                  ) {
                    e.preventDefault();
                    onFocus(f);
                  }
                }}
                className={cn(
                  "cursor-pointer rounded-[12px] p-3 ring-1 transition-colors",
                  a?.state === "done"
                    ? "bg-white/[0.02] opacity-60 ring-white/5"
                    : a?.state === "ack"
                      ? "bg-amber-400/[0.06] ring-amber-400/25 hover:ring-amber-400/45"
                      : "bg-red-500/[0.08] ring-red-500/30 hover:ring-red-500/55",
                )}
              >
                <div className="text-muted-foreground flex items-center justify-between font-mono text-[11px] tabular-nums">
                  <span>
                    {fmtMmss(f.t_start)}
                    {start != null && ` · ${fmtClock(start, f.t_start)}`}
                  </span>
                  <span>
                    {live ? "on the air now" : "no longer visible on the air"}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onPick(f);
                  }}
                  className={cn(
                    "mt-1 line-clamp-2 text-left text-sm font-medium hover:underline",
                    a?.state === "done" && "line-through",
                  )}
                >
                  {f.title}
                </button>
                {f.action?.supervisor && a?.state !== "done" && (
                  <p className="text-muted-foreground mt-1.5 line-clamp-3 text-xs">
                    {f.action.supervisor}
                  </p>
                )}
                <div
                  className="mt-2.5 flex items-center justify-between gap-2"
                  onClick={(e) => e.stopPropagation()}
                >
                  <ActionChip finding={f} />
                  <AckButton ack={a} onAck={(state) => onAck(f.id, state)} />
                  {a?.state === "done" && (
                    <button
                      type="button"
                      onClick={() => onAck(f.id, null)}
                      className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-[11px]"
                    >
                      <RotateCcw className="size-3" /> Reopen
                    </button>
                  )}
                </div>
                {a && (
                  <div className="text-muted-foreground mt-2 text-[11px]">
                    {a.state === "ack" ? "Acknowledged" : "Fixed"} at{" "}
                    {ackClock(a, start)}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      <footer className="text-muted-foreground flex items-center justify-between gap-2 border-t border-white/10 px-4 py-2.5 text-[11px]">
        <span>
          {later > 0
            ? `${later} more later in this capture`
            : "Replay to the end to see all"}
          {!shared &&
            Object.keys(acks).length > 0 &&
            " · saved in this browser"}
        </span>
        {Object.keys(acks).length > 0 && (
          <button
            type="button"
            onClick={onReset}
            className="hover:text-foreground shrink-0"
          >
            Reset acknowledgements
          </button>
        )}
      </footer>
    </aside>
  );
}
