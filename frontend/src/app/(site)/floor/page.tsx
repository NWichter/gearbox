"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, TriangleAlert } from "lucide-react";
import { Logo } from "@/components/logo";
import { ActionChip } from "@/components/action";
import { AckButton, FloorMap } from "@/components/floor-map";
import { FloorReplayBar } from "@/components/floor-replay-bar";
import { FindingSheet } from "@/components/finding-sheet";
import { useReplay } from "@/components/replay";
import { SeverityDot } from "@/components/severity";
import { LineRiskRail } from "@/components/line-risk-rail";
import { useAcks, type AckState } from "@/lib/acks";
import {
  api,
  DATASET_KEY,
  pickDataset,
  SEVERITY_RANK,
  type Finding,
  type Result,
} from "@/lib/api";
import { byPriority, lineStops, placeFinding } from "@/lib/floor-findings";
import { FLOOR_APS, placeAps, placeDevices } from "@/lib/floorplan";
import { urgencyOf } from "@/components/action";
import { cn } from "@/lib/utils";

const FOCUS_MS = 2200; // how long a line-risk click highlights the spot on the map
const FLASH_MS = 5000; // how long a new critical finding stays open on the map
const ORDER_KEY = "gearbox.floor.ap-order";

export default function FloorPage() {
  const [dsId, setDsId] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [status, setStatus] = useState("loading");

  // The app is light; the shop floor keeps its dark glass look. The wrapper class covers the
  // first paint, the class on <html> covers portals (sheet, tooltips, toasts, chat).
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("dark");
    return () => root.classList.remove("dark");
  }, []);

  useEffect(() => {
    api
      .datasets()
      .then((list) => {
        let stored: string | null = null;
        try {
          stored = localStorage.getItem(DATASET_KEY);
        } catch {
          // storage blocked: fall back to the list order
        }
        // same rule as the dashboard, preferring the dataset it showed last
        const id = pickDataset(list, stored);
        if (!id) setStatus("no dataset yet");
        setDsId(id);
      })
      .catch(() => setStatus("API offline"));
  }, []);

  useEffect(() => {
    if (!dsId) return;
    let stop = false;
    const poll = async () => {
      const d = await api.dataset(dsId);
      if (stop) return;
      // a re-analysis keeps the previous result: show it and pick up the new one when done
      if (d.result) setResult(d.result);
      if (d.status !== "done") {
        setStatus(
          d.status === "failed" ? `failed: ${d.error}` : `analysis ${d.status}`,
        );
        if (d.status !== "failed") setTimeout(poll, d.result ? 10000 : 2000);
      }
    };
    poll().catch((e) => setStatus(String(e)));
    return () => {
      stop = true;
    };
  }, [dsId]);

  return (
    <div className="dark text-foreground fixed inset-0 z-50 overflow-hidden bg-[#2b3035]">
      {/* the page is the viewport: no scrollbar from the root layout underneath */}
      <style>{"html,body{overflow:hidden}"}</style>
      {result && dsId ? (
        <Floor key={dsId} result={result} dsId={dsId} />
      ) : (
        <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
          <span className="animate-pulse">{status}…</span>
        </div>
      )}
    </div>
  );
}

function Floor({ result, dsId }: { result: Result; dsId: string }) {
  const end = Math.max(
    result.summary.duration_s,
    ...result.findings.map((f) => f.t_end),
    1,
  );
  const replay = useReplay(end);
  const t = replay.t;
  const [picked, setPicked] = useState<Finding | null>(null);
  const [railOpen, setRailOpen] = useState(false);
  const [focus, setFocus] = useState<number | null>(null);
  const [flash, setFlash] = useState<Set<number>>(new Set());
  // numbered order by default (AP 01-06 in the top row); "measured" is one click in the legend
  const [byNumber, setByNumber] = useState(() => {
    try {
      return localStorage.getItem(ORDER_KEY) !== "measured";
    } catch {
      return true;
    }
  });

  // deep link to a moment: /floor?t=420 opens the replay at 7:00
  const { seek } = replay;
  useEffect(() => {
    const v = Number(new URLSearchParams(window.location.search).get("t"));
    if (v > 0) seek(v);
  }, [seek]);

  const { acks, set: setAck, reset: resetAcks, shared } = useAcks(dsId);
  const onAck = useCallback(
    (id: number, state: AckState | null) => setAck(id, state, replay.t),
    [setAck, replay.t],
  );

  // 5.7: AP order from the signal-strength estimate when there is one
  const hasLayout = !!result.layout?.aps.length;
  const aps = useMemo(
    () => (byNumber || !hasLayout ? FLOOR_APS : placeAps(result.layout)),
    [byNumber, hasLayout, result.layout],
  );
  const devices = useMemo(() => placeDevices(aps), [aps]);

  // same rule as the dashboard's "happening now": started, and not over for more than 5 s;
  // findings the shift lead marked as fixed leave the map
  const active = result.findings
    .filter(
      (f) => f.t_start <= t && f.t_end + 5 >= t && acks[f.id]?.state !== "done",
    )
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  const activeKey = active.map((f) => f.id).join(",");
  const placed = useMemo(
    () => active.map((f) => placeFinding(f, aps, devices)),
    // active is rebuilt every frame; its ids are what matters
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeKey, aps, devices],
  );
  const siteWide = placed
    .filter((p) => p.reach === "site" && p.finding.severity !== "info")
    .map((p) => p.finding)
    .sort(byPriority);

  const stops = useMemo(
    () => lineStops(result.findings, aps, devices, acks),
    [result.findings, aps, devices, acks],
  );

  // a critical finding that just started opens its callout for a moment
  const [seenKey, setSeenKey] = useState(activeKey);
  if (seenKey !== activeKey) {
    setSeenKey(activeKey);
    const before = new Set(seenKey.split(","));
    const fresh = active.filter(
      (f) =>
        !before.has(String(f.id)) &&
        f.severity === "critical" &&
        t - f.t_start < 30,
    );
    if (fresh.length) setFlash(new Set(fresh.map((f) => f.id)));
  }
  useEffect(() => {
    if (!flash.size) return;
    const id = setTimeout(() => setFlash(new Set()), FLASH_MS);
    return () => clearTimeout(id);
  }, [flash]);

  const onFocus = useCallback((f: Finding) => {
    setFocus(f.id);
    setRailOpen(false);
    setTimeout(() => setFocus((cur) => (cur === f.id ? null : cur)), FOCUS_MS);
  }, []);

  const redOpen = result.findings.filter(
    (f) =>
      urgencyOf(f) === "red" && f.t_start <= t && acks[f.id]?.state !== "done",
  ).length;

  return (
    <>
      <FloorMap
        result={result}
        aps={aps}
        devices={devices}
        active={active}
        placed={placed}
        acks={acks}
        t={t}
        stops={stops}
        focus={focus}
        flash={flash}
        onPick={setPicked}
        onAck={onAck}
      />

      {/* top-left: product and way back */}
      <div
        data-floor-avoid
        className="absolute top-4 left-4 z-10 flex items-center gap-2"
      >
        <div className="flex items-center gap-3 rounded-[12px] bg-zinc-950/75 px-3 py-2 shadow-xl ring-1 ring-white/10 backdrop-blur-xl">
          <Logo />
          <span className="text-muted-foreground hidden border-l border-white/10 pl-3 text-xs 2xl:inline">
            Shop floor
          </span>
        </div>
        <Link
          href="/"
          className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 rounded-[12px] bg-zinc-950/75 px-3 py-2.5 text-xs shadow-xl ring-1 ring-white/10 backdrop-blur-xl transition-colors"
        >
          <ArrowLeft className="size-3.5" /> Analysis
        </Link>
      </div>

      {/* below 1024 px the line-risk rail is a drawer */}
      <button
        type="button"
        onClick={() => setRailOpen(true)}
        className={cn(
          "absolute top-4 right-4 z-10 flex items-center gap-1.5 rounded-[12px] bg-zinc-950/75 px-3 py-2.5 text-xs font-semibold shadow-xl ring-1 backdrop-blur-xl lg:hidden",
          redOpen
            ? "text-red-300 ring-red-500/40"
            : "text-emerald-300 ring-white/10",
          railOpen && "hidden",
        )}
      >
        <TriangleAlert className="size-3.5" /> Line risk · {redOpen}
      </button>

      {/* top-centre: the replay timeline, site-wide problems right under it */}
      <div
        data-floor-avoid
        className="absolute top-[4.25rem] left-1/2 z-10 w-[calc(100vw-32px)] max-w-[760px] -translate-x-1/2 space-y-2 lg:top-4 lg:left-[max(calc((100vw_-_356px)/2_-_var(--tw)/2),264px)] lg:w-(--tw) lg:translate-x-0 lg:[--tw:min(760px,calc(100vw_-_644px))]"
      >
        <div className="rounded-[16px] bg-zinc-950/75 p-3 shadow-2xl ring-1 ring-white/10 backdrop-blur-xl">
          <FloorReplayBar replay={replay} result={result} acks={acks} />
          <div className="mt-2 flex items-center gap-2 text-xs">
            {active.length === 0 ? (
              <span className="text-muted-foreground">
                All quiet at this moment.
              </span>
            ) : (
              <>
                <span className="text-muted-foreground shrink-0">
                  {active.length} active:
                </span>
                <div className="flex min-w-0 gap-1.5 overflow-hidden">
                  {active.slice(0, 3).map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => setPicked(f)}
                      className="flex min-w-0 items-center gap-1.5 rounded-full bg-white/5 px-2 py-0.5 hover:bg-white/10"
                    >
                      <SeverityDot severity={f.severity} />
                      <span className="max-w-[16rem] truncate">{f.title}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        {siteWide.length > 0 && (
          <SiteBanner
            findings={siteWide}
            acks={acks}
            onAck={onAck}
            onPick={setPicked}
          />
        )}
      </div>

      <LineRiskRail
        result={result}
        t={t}
        acks={acks}
        shared={shared}
        open={railOpen}
        onClose={() => setRailOpen(false)}
        onAck={onAck}
        onReset={resetAcks}
        onPick={setPicked}
        onFocus={onFocus}
      />

      <Legend
        order={hasLayout ? (byNumber ? "number" : "measured") : null}
        onOrder={(o) => {
          setByNumber(o === "number");
          try {
            localStorage.setItem(ORDER_KEY, o);
          } catch {
            // storage blocked: the choice lasts for this page view
          }
        }}
      />

      <FindingSheet
        dsId={dsId}
        finding={picked}
        onClose={() => setPicked(null)}
      />
    </>
  );
}

// 5.1: problems across the whole hall are told here, not painted over every AP
function SiteBanner({
  findings,
  acks,
  onAck,
  onPick,
}: {
  findings: Finding[];
  acks: ReturnType<typeof useAcks>["acks"];
  onAck: (id: number, state: AckState | null) => void;
  onPick: (f: Finding) => void;
}) {
  const shown = findings.slice(0, 3);
  return (
    <div className="divide-y divide-white/10 rounded-[14px] bg-zinc-950/75 px-3 py-1 text-xs shadow-2xl ring-1 ring-white/10 backdrop-blur-xl">
      {shown.map((f, i) => (
        <div key={f.id} className="py-1">
          <div className="flex items-center gap-2">
            <span className="shrink-0 text-[10.5px] font-semibold tracking-wider text-zinc-400 uppercase">
              Site-wide
            </span>
            <SeverityDot severity={f.severity} />
            <button
              type="button"
              onClick={() => onPick(f)}
              className="min-w-0 flex-1 truncate text-left font-medium hover:underline"
            >
              {f.title}
            </button>
            <ActionChip finding={f} />
            <AckButton
              ack={acks[f.id]}
              size="xs"
              onAck={(state) => onAck(f.id, state)}
            />
          </div>
          {i === 0 && f.action?.supervisor && (
            <p className="text-muted-foreground truncate pl-[4.9rem] text-[11px]">
              {f.action.supervisor}
            </p>
          )}
        </div>
      ))}
      {findings.length > shown.length && (
        <div className="text-muted-foreground py-1 text-[11px]">
          + {findings.length - shown.length} more site-wide
        </div>
      )}
    </div>
  );
}

function Legend({
  order,
  onOrder,
}: {
  order: "measured" | "number" | null;
  onOrder: (o: "measured" | "number") => void;
}) {
  const item = "flex items-center gap-1.5";
  return (
    <div
      data-floor-avoid
      className="text-muted-foreground absolute bottom-4 left-4 z-10 flex max-w-[calc(100vw-140px)] flex-wrap items-center gap-x-4 gap-y-1.5 rounded-[12px] bg-zinc-950/75 px-3 py-2 text-[11px] shadow-xl ring-1 ring-white/10 backdrop-blur-xl"
    >
      <span className={item}>
        <span className="size-3 rounded-[4px] bg-zinc-100" /> Access point
      </span>
      <span className={item}>
        <span className="size-2.5 rounded-[3px] bg-amber-500" /> Tool
      </span>
      <span className={item}>
        <span className="h-2 w-3 rounded-[2px] bg-blue-400" /> Laptop
      </span>
      <span className={item}>
        <span className="h-3 w-2 rounded-[2px] bg-violet-400" /> Phone
      </span>
      <span className={item}>
        <span className="size-2.5 rounded-[3px] border border-dashed border-red-400" />{" "}
        Never connected
      </span>
      <span className={item}>
        <span className="size-2.5 rounded-full bg-red-500 shadow-[0_0_8px_#ef4444]" />{" "}
        Problem right now
      </span>
      {order && (
        <button
          type="button"
          onClick={() => onOrder(order === "measured" ? "number" : "measured")}
          title="Measured: APs that are neighbours on the air (signal strength) sit next to each other. By number: AP 01-06 in the top row."
          className="hover:text-foreground border-l border-white/10 pl-3"
        >
          AP order:{" "}
          <span className="text-foreground">
            {order === "measured" ? "measured" : "by number"}
          </span>
        </button>
      )}
    </div>
  );
}
