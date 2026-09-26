"use client";

import {
  useCallback,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import Link from "next/link";
import {
  Check,
  CheckCheck,
  CircleDashed,
  Clipboard,
  Clock,
  ExternalLink,
  MapPin,
  RadioTower,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { URGENCY, UrgencyDot, UrgencyStripe, urgencyOf } from "@/components/action";
import { AffectedTable } from "@/components/affected-table";
import { DashboardSwitch } from "@/components/dashboard-switch";
import { DatasetPicker, PendingState } from "@/components/dataset-state";
import { Wireshark } from "@/components/finding-sheet";
import { IncidentTimeline } from "@/components/incident-timeline";
import { SeverityBadge } from "@/components/severity";
import { useAcks, type Ack, type AckState } from "@/lib/acks";
import {
  captureEnd,
  fmtClock,
  fmtMmss,
  fmtT,
  seenBy,
  SEVERITY_RANK,
  TYPE_LABEL,
  utc,
  type Finding,
  type Result,
} from "@/lib/api";
import {
  akmLabel,
  buildRadios,
  CHECKS,
  devicesOf,
  evidenceFrames,
  fixSteps,
  IT_TEAMS,
  mfpLabel,
  missingOf,
  originProof,
  causeText,
  diagnosis,
  sensorsOf,
  STEPS,
  stepOf,
  teamOf,
  TEAM_ORDER,
  TEAMS,
  ticketText,
  windowText,
  type Radio,
} from "@/lib/it-view";
import { useDataset } from "@/lib/use-dataset";
import { cn } from "@/lib/utils";

// ------------------------------------------------------------------ page

export function ItConsolePage() {
  const { datasets, dsId, setDsId, result, status, reload, current } =
    useDataset();
  return (
    <div className="relative">
      <DashboardSwitch className="mb-4" />
      <DatasetPicker
        className="mb-4 justify-end sm:absolute sm:top-0 sm:right-0 sm:mb-0"
        datasets={datasets}
        value={dsId}
        onChange={setDsId}
        onUploaded={async (id) => {
          await reload();
          setDsId(id);
        }}
      />
      {result && dsId ? (
        <ItConsole
          key={dsId}
          result={result}
          dsId={dsId}
          name={current?.name}
        />
      ) : (
        <div className="pt-10">
          <PendingState status={status} name={current?.name} />
        </div>
      )}
    </div>
  );
}

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

// Same order as the main dashboard: tools network first, then severity, then the newest start
function byPriority(a: Finding, b: Finding) {
  return (
    URGENCY[urgencyOf(a)].rank - URGENCY[urgencyOf(b)].rank ||
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    b.t_start - a.t_start
  );
}

function plural(n: number, one: string, many: string) {
  return `${n.toLocaleString("en")} ${n === 1 ? one : many}`;
}

function clockOf(startEpoch: number | null, t: number) {
  const c = fmtClock(startEpoch, t);
  return c ? `${c} UTC` : fmtMmss(t);
}

type Status = "open" | AckState;
const statusOf = (acks: Record<number, Ack>, f: Finding): Status =>
  acks[f.id]?.state ?? "open";

const STATUS: Record<Status, { label: string; className: string }> = {
  open: { label: "Open", className: "text-foreground border-border" },
  ack: {
    label: "Acknowledged",
    className: "text-calm border-calm/30 bg-calm/5",
  },
  done: { label: "Fixed", className: "text-ok border-ok/30 bg-ok/5" },
};

function StatusPill({ status }: { status: Status }) {
  const s = STATUS[status];
  return (
    <span
      className={cn(
        "inline-flex h-[18px] shrink-0 items-center gap-1 rounded-sm border px-1.5 text-[11px] whitespace-nowrap",
        s.className,
      )}
    >
      {status === "done" ? (
        <CheckCheck className="size-3" />
      ) : status === "ack" ? (
        <Check className="size-3" />
      ) : (
        <CircleDashed className="size-3" />
      )}
      {s.label}
    </span>
  );
}

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

function Eyebrow({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "text-muted-foreground text-[10.5px] font-medium tracking-[0.08em] uppercase",
        className,
      )}
    >
      {children}
    </div>
  );
}

// ------------------------------------------------------------------ console

function ItConsole({
  result,
  dsId,
  name,
}: {
  result: Result;
  dsId: string;
  name?: string;
}) {
  const startEpoch = result.summary.start_epoch;
  const end = captureEnd(result);
  const isDesktop = useIsDesktop();
  const { acks, set, shared } = useAcks(dsId);
  const radios = useMemo(() => buildRadios(result), [result]);
  const sorted = useMemo(
    () => [...result.findings].sort(byPriority),
    [result],
  );

  // ItConsole renders only in the browser (after the fetch), so window is available here
  const [selectedId, setSelectedId] = useState<number | null>(() => {
    const linked = Number(new URLSearchParams(window.location.search).get("f"));
    if (linked && result.findings.some((f) => f.id === linked)) return linked;
    return (
      sorted.find((f) => IT_TEAMS.has(teamOf(f)))?.id ?? sorted[0]?.id ?? null
    );
  });
  const [sheetOpen, setSheetOpen] = useState(false);
  const selected = result.findings.find((f) => f.id === selectedId) ?? null;

  const select = useCallback(
    (f: Finding, scroll = false) => {
      setSelectedId(f.id);
      const url = new URL(window.location.href);
      url.searchParams.set("f", String(f.id));
      window.history.replaceState(null, "", url);
      if (!isDesktop) setSheetOpen(true);
      else if (scroll)
        document
          .getElementById("it-queue")
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
    },
    [isDesktop],
  );

  const setStatus = useCallback(
    (f: Finding, state: AckState | null) => set(f.id, state, end),
    [set, end],
  );

  return (
    <div className="space-y-10 sm:space-y-12">
      <Headline result={result} acks={acks} name={name} />
      <div className="space-y-4">
        <Pipeline result={result} acks={acks} />
        <Kpis result={result} radios={radios} />
      </div>
      <StepBoard result={result} selectedId={selectedId} onPick={(f) => select(f, true)} />
      <div id="it-queue" className="scroll-mt-[calc(var(--chrome-h,3.5rem)+1.5rem)]">
        <Queue
          result={result}
          sorted={sorted}
          acks={acks}
          shared={shared}
          selected={selected}
          onPick={(f) => select(f)}
          detail={
            selected ? (
              <IncidentDetail
                f={selected}
                result={result}
                status={statusOf(acks, selected)}
                ack={acks[selected.id]}
                shared={shared}
                onStatus={setStatus}
              />
            ) : null
          }
        />
      </div>
      <section>
        <SectionLabel
          title="When it happened"
          help="One lane per finding, from its first to its last frame. Select a lane to open the finding."
          right={
            startEpoch != null
              ? `${utc(startEpoch).slice(0, 16)} - ${utc(startEpoch + result.summary.duration_s).slice(11, 16)} UTC`
              : fmtMmss(end)
          }
        />
        <IncidentTimeline
          findings={result.findings}
          duration={end}
          startEpoch={startEpoch}
          onPick={(f) => select(f, true)}
        />
      </section>
      <RadioGrid
        result={result}
        radios={radios}
        onPick={(id) => {
          const f = result.findings.find((x) => x.id === id);
          if (f) select(f, true);
        }}
      />
      <div className="grid gap-10 xl:grid-cols-2 xl:gap-8">
        <SensorTable result={result} />
        <CheckGrid result={result} onPick={(f) => select(f, true)} />
      </div>
      <Sheet open={sheetOpen && !isDesktop} onOpenChange={setSheetOpen}>
        <SheetContent className="w-full gap-0 overflow-y-auto p-4 data-[side=right]:sm:max-w-2xl">
          <SheetTitle className="sr-only">
            {selected ? selected.title : "Incident"}
          </SheetTitle>
          {selected && (
            <IncidentDetail
              f={selected}
              result={result}
              status={statusOf(acks, selected)}
              ack={acks[selected.id]}
              shared={shared}
              onStatus={setStatus}
            />
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

// ------------------------------------------------------------------ headline

// Findings someone has to fix (everything except "no action"), not marked as fixed
function openFindings(result: Result, acks: Record<number, Ack>) {
  return result.findings.filter(
    (f) => teamOf(f) !== "none" && statusOf(acks, f) !== "done",
  );
}

function Headline({
  result,
  acks,
  name,
}: {
  result: Result;
  acks: Record<number, Ack>;
  name?: string;
}) {
  const s = result.summary;
  const open = openFindings(result, acks);
  const red = open.filter((f) => urgencyOf(f) === "red").length;
  const perTeam = TEAM_ORDER.map(
    (t) => [t, open.filter((f) => teamOf(f) === t).length] as const,
  ).filter(([, n]) => n > 0);

  const facts = [
    name ?? "Dataset",
    s.start_epoch != null
      ? `${utc(s.start_epoch).slice(0, 16)} - ${utc(s.start_epoch + s.duration_s).slice(11, 16)} UTC`
      : null,
    plural(s.sensors, "sensor", "sensors"),
    s.radios_expected != null
      ? `${s.radios_on_air ?? s.aps} of ${s.radios_expected} access points on the air`
      : plural(s.aps, "access point", "access points"),
    `${s.networks ?? s.aps} networks (BSSIDs)`,
  ].filter(Boolean);

  return (
    <section className="space-y-3 pt-8 text-center sm:pt-2">
      <h1 className="mx-auto max-w-3xl text-[26px] leading-tight font-light tracking-tight sm:text-[32px]">
        {open.length > 0 ? (
          <>
            {plural(open.length, "root cause needs", "root causes need")} a{" "}
            <span className="font-normal">fix</span>
          </>
        ) : (
          <>
            Nothing left to <span className="text-ok font-normal">fix</span>
          </>
        )}
      </h1>
      <p className="text-muted-foreground text-sm">
        {red > 0 && (
          <>
            <span className="text-tesla">
              {red} on TESLA-TOOLS can stop the line.
            </span>{" "}
          </>
        )}
        {perTeam.length
          ? perTeam.map(([t, n]) => `${TEAMS[t].label} ${n}`).join(" · ")
          : "All findings are marked as fixed."}
      </p>
      <div className="text-muted-foreground flex flex-wrap items-center justify-center gap-x-2 gap-y-1 pt-1 text-xs">
        {facts.map((f, i) => (
          <span key={i} className="inline-flex items-center gap-2">
            {i > 0 && <span className="hidden opacity-40 sm:inline">·</span>}
            {f}
          </span>
        ))}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ pipeline

// From 1.1 million frame headers to a handful of root causes, with the numbers of this capture
function Pipeline({
  result,
  acks,
}: {
  result: Result;
  acks: Record<number, Ack>;
}) {
  const s = result.summary;
  const stats = result.sensors.stats ?? [];
  const drift = Object.values(result.sensors.drift_ppm ?? {});
  const maxOffS =
    Math.max(0, ...stats.map((x) => Math.abs(x.clock_offset_ms))) / 1000;
  const maxDrift = Math.max(0, ...drift.map((d) => Math.abs(d)));
  const channels = new Set(stats.flatMap((x) => x.channels)).size;
  const found = new Set(result.findings.map((f) => f.type));
  const clean = CHECKS.filter((c) => !c.types.some((t) => found.has(t))).length;
  const open = openFindings(result, acks);
  const red = open.filter((f) => urgencyOf(f) === "red").length;
  const frames = result.findings.reduce((n, f) => n + evidenceFrames(f), 0);
  const secs = s.timing_s
    ? s.timing_s.ingest + s.timing_s.fuse + s.timing_s.detect
    : null;

  const stages: {
    value: string;
    label: string;
    sub: string;
    help: string;
    tone?: "tesla";
  }[] = [
    {
      value: s.frames.toLocaleString("en"),
      label: "frame headers",
      sub: `${plural(s.sensors, "sensor", "sensors")} · ${plural(channels, "channel", "channels")} · ${fmtMmss(s.duration_s)} min`,
      help: "Every 802.11 / 802.1X header the sensors recorded. Gearbox reads headers only, no payload.",
    },
    {
      value: "1 clock",
      label: "sensors merged",
      sub:
        maxOffS > 0
          ? `offsets up to ${maxOffS.toFixed(1)} s and ${maxDrift.toFixed(0)} ppm drift corrected`
          : "sensor clocks aligned",
      help: "Each sensor clock is measured against the AP beacon timestamps and corrected. Only then can events on different channels be compared.",
    },
    {
      value: (s.devices_total ?? s.clients).toLocaleString("en"),
      label: "devices followed",
      sub: "each one through the 5 connection steps",
      help: "Every device address. Gearbox follows it through find, join, log in, keys and talk, and records the step that never completes.",
    },
    {
      value: `${result.findings.length}`,
      label: "findings",
      sub: `${CHECKS.length} fault classes checked · ${clean} ruled out`,
      help: "Findings with the same root cause are grouped into one incident with its evidence frames. The checks that found nothing rule causes out, for example an attacker or congestion.",
    },
    {
      value: `${open.length}`,
      label: open.length === 1 ? "needs a fix" : "need a fix",
      sub: red ? `${red} can stop the line` : "none can stop the line",
      help: "Findings that someone has to fix, each routed to the team that can fix it.",
      tone: red ? "tesla" : undefined,
    },
  ];

  return (
    <section aria-label="From frames to causes">
      <ol className="grid grid-cols-2 gap-px overflow-hidden rounded-md border bg-border sm:grid-cols-3 lg:grid-cols-5">
        {stages.map((st, i) => (
          <li key={st.label} className="bg-background relative">
            <Tooltip>
              <TooltipTrigger
                render={<div className="h-full cursor-help px-4 py-3.5" />}
              >
                <Eyebrow>
                  <span className="mr-1.5 font-mono">{i + 1}</span>
                  {st.label}
                </Eyebrow>
                <div
                  className={cn(
                    "mt-1 font-mono text-[26px] leading-none font-light tracking-tight tabular-nums",
                    st.tone === "tesla" && "text-tesla",
                  )}
                >
                  {st.value}
                </div>
                <div className="text-muted-foreground mt-1.5 text-[11px] leading-snug">
                  {st.sub}
                </div>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">{st.help}</TooltipContent>
            </Tooltip>
          </li>
        ))}
      </ol>
      <p className="text-muted-foreground mt-2 text-right text-[11px]">
        {secs != null && <>Analysed in {Math.round(secs)} s · </>}
        {frames.toLocaleString("en")} evidence frames, each one findable in the
        original pcaps with its Wireshark filter
      </p>
    </section>
  );
}

// ------------------------------------------------------------------ KPIs

function Kpis({ result, radios }: { result: Result; radios: Radio[] }) {
  const s = result.summary;
  const devices = new Set<string>();
  const tools = new Set<string>();
  for (const f of result.findings) {
    if (teamOf(f) === "none") continue;
    const onTools = (f.networks ?? []).some((n) => /TOOL/i.test(n));
    for (const d of devicesOf(f)) {
      devices.add(d);
      if (onTools) tools.add(d);
    }
  }
  const offBssids = radios.flatMap((r) => r.bssids.filter((b) => !b.onAir));
  const silent = radios.filter(
    (r) => r.silent && r.bssids.every((b) => !b.onAir),
  ).length;
  const offTools = offBssids.filter(
    (b) => b.ssid && /TOOL/i.test(b.ssid),
  ).length;
  const psk = result.aps.filter(
    (a) => (a as { akm?: string | number | null }).akm?.toString() === "2",
  ).length;

  const tiles: {
    label: string;
    value: string;
    sub: string;
    help: string;
    tone?: "tesla";
  }[] = [
    {
      label: "Devices affected",
      value: `${devices.size}`,
      sub: tools.size
        ? `${tools.size} of them on TESLA-TOOLS`
        : "none on TESLA-TOOLS",
      help: "Different device addresses in all findings that need a fix.",
      tone: tools.size ? "tesla" : undefined,
    },
    {
      label: "Networks off the air",
      value: `${offBssids.length + silent}`,
      sub:
        silent > 0
          ? `${plural(offBssids.length, "network", "networks")} + ${plural(silent, "whole access point", "whole access points")}`
          : `${offTools} of them TESLA-TOOLS`,
      help: "Networks (BSSIDs) that the numbering of the access points expects, but that send no beacon in the whole capture. A silent access point counts once.",
      tone: offBssids.length + silent ? "tesla" : undefined,
    },
    {
      label: "Access points",
      value:
        s.radios_expected != null
          ? `${s.radios_on_air ?? s.aps}/${s.radios_expected}`
          : `${s.aps}`,
      sub: `on the air · ${s.networks ?? s.aps} networks (BSSIDs)`,
      help: "Access points that send beacons, of the access points that their numbering shows. Each access point sends one BSSID per network.",
    },
    {
      label: "Shared-key networks",
      value: `${psk}`,
      sub: psk ? "WPA2-PSK without 802.11w" : "all use 802.1X or SAE",
      help: "Networks whose beacons announce one shared key (PSK). Without 802.11w anyone in range can forge disconnect frames.",
    },
  ];

  return (
    <section
      aria-label="Key figures"
      className="grid grid-cols-2 gap-px overflow-hidden rounded-md border bg-border lg:grid-cols-4"
    >
      {tiles.map((t) => (
        <Tooltip key={t.label}>
          <TooltipTrigger
            render={<div className="bg-background cursor-help px-4 py-3" />}
          >
            <Eyebrow>{t.label}</Eyebrow>
            <div
              className={cn(
                "mt-1 font-mono text-[22px] leading-none font-light tracking-tight tabular-nums",
                t.tone === "tesla" && "text-tesla",
              )}
            >
              {t.value}
            </div>
            <div className="text-muted-foreground mt-1.5 truncate text-[11px]">
              {t.sub}
            </div>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">{t.help}</TooltipContent>
        </Tooltip>
      ))}
    </section>
  );
}

// ------------------------------------------------------------------ connection steps

function StepBoard({
  result,
  selectedId,
  onPick,
}: {
  result: Result;
  selectedId: number | null;
  onPick: (f: Finding) => void;
}) {
  const relevant = result.findings.filter((f) => teamOf(f) !== "none");
  const columns = [
    ...STEPS.map((s) => ({
      key: String(s.n),
      n: s.n as number | null,
      label: s.label,
      sub: s.sub,
      findings: relevant.filter((f) => stepOf(f) === s.n).sort(byPriority),
    })),
    {
      key: "site",
      n: null,
      label: "Site-wide",
      sub: "controller · sensors · config",
      findings: relevant.filter((f) => stepOf(f) == null).sort(byPriority),
    },
  ];

  return (
    <section>
      <SectionLabel
        title="Where the connections break"
        help="A device connects in five steps. Gearbox follows each device and records the step that never completes. Site-wide findings are not tied to one step."
        right="Devices that fail at each step"
      />
      <ol className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-6 xl:gap-0">
        {columns.map((c, i) => {
          const devices = new Set<string>();
          for (const f of c.findings) for (const d of devicesOf(f)) devices.add(d);
          const worst = c.findings[0];
          const color = worst ? URGENCY[urgencyOf(worst)].dot : undefined;
          const last = i === columns.length - 1;
          return (
            <li
              key={c.key}
              className={cn(
                "flex min-w-0 flex-col rounded-md border p-3 xl:rounded-none xl:border-y xl:border-r-0 xl:border-l",
                i === 0 && "xl:rounded-l-md",
                last && "xl:rounded-r-md xl:border-r",
                c.n == null && "bg-panel",
              )}
            >
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "flex size-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold tabular-nums",
                    !worst && "text-muted-foreground",
                  )}
                  style={
                    worst
                      ? { borderColor: color, color, background: `${color}14` }
                      : undefined
                  }
                >
                  {c.n ?? "·"}
                </span>
                <div className="min-w-0">
                  <div className="text-[13px] leading-tight font-medium">
                    {c.label}
                  </div>
                  <div className="text-muted-foreground truncate text-[10.5px]">
                    {c.sub}
                  </div>
                </div>
              </div>
              <div className="mt-3 flex items-baseline gap-1.5">
                <span
                  className={cn(
                    "font-mono text-[22px] leading-none font-light tabular-nums",
                    !worst && "text-muted-foreground/60",
                  )}
                  style={worst && urgencyOf(worst) === "red" ? { color } : undefined}
                >
                  {c.n == null ? c.findings.length : devices.size}
                </span>
                <span className="text-muted-foreground text-[11px]">
                  {c.n == null
                    ? c.findings.length === 1
                      ? "finding"
                      : "findings"
                    : devices.size === 1
                      ? "device"
                      : "devices"}
                </span>
              </div>
              <ul className="mt-2 space-y-1">
                {c.findings.length === 0 && (
                  <li className="text-muted-foreground/70 flex items-center gap-1.5 text-[11px]">
                    <Check className="text-ok size-3" /> No break found
                  </li>
                )}
                {c.findings.map((f) => (
                  <li key={f.id}>
                    <button
                      type="button"
                      onClick={() => onPick(f)}
                      className={cn(
                        "hover:bg-muted flex w-full items-start gap-1.5 rounded-sm px-1 py-0.5 text-left text-[11.5px] leading-snug transition-colors",
                        selectedId === f.id && "bg-muted",
                      )}
                    >
                      <UrgencyDot finding={f} className="mt-1" />
                      <span className="line-clamp-2 min-w-0">
                        <span className="text-muted-foreground font-mono">
                          #{f.id}
                        </span>{" "}
                        {TYPE_LABEL[f.type] ?? f.type}
                        {devicesOf(f).size > 1 && (
                          <span className="text-muted-foreground">
                            {" "}
                            · {devicesOf(f).size}
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

// ------------------------------------------------------------------ queue

type Filter = "all" | "open" | "done";

function Queue({
  result,
  sorted,
  acks,
  shared,
  selected,
  onPick,
  detail,
}: {
  result: Result;
  sorted: Finding[];
  acks: Record<number, Ack>;
  shared: boolean;
  selected: Finding | null;
  onPick: (f: Finding) => void;
  detail: React.ReactNode;
}) {
  const startEpoch = result.summary.start_epoch;
  const [filter, setFilter] = useState<Filter>("all");
  const count = (f: Filter) =>
    sorted.filter((x) =>
      f === "all"
        ? true
        : f === "done"
          ? statusOf(acks, x) === "done"
          : statusOf(acks, x) !== "done",
    ).length;
  const visible = sorted.filter((x) =>
    filter === "all"
      ? true
      : filter === "done"
        ? statusOf(acks, x) === "done"
        : statusOf(acks, x) !== "done",
  );

  return (
    <section>
      <SectionLabel
        title="Incident queue by owner"
        help="Each finding is one root cause, routed to the team that can fix it. The status is shared with the shop floor view."
        right={
          <span className="inline-flex items-center gap-3">
            {!shared && <span>Status saved in this browser only</span>}
            <span
              role="tablist"
              aria-label="Filter incidents"
              className="bg-muted inline-flex h-7 items-center rounded-lg p-[3px] text-[11.5px]"
            >
              {(
                [
                  ["all", "All"],
                  ["open", "Open"],
                  ["done", "Fixed"],
                ] as [Filter, string][]
              ).map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  role="tab"
                  aria-selected={filter === k}
                  onClick={() => setFilter(k)}
                  className={cn(
                    "flex h-full items-center gap-1 rounded-md px-2.5 transition-colors",
                    filter === k
                      ? "bg-background text-foreground font-medium shadow-sm"
                      : "hover:text-foreground",
                  )}
                >
                  {label}
                  <span className="font-mono text-[10.5px] opacity-60 tabular-nums">
                    {count(k)}
                  </span>
                </button>
              ))}
            </span>
          </span>
        }
      />
      <div className="grid gap-8 lg:grid-cols-[minmax(0,400px)_minmax(0,1fr)] xl:grid-cols-[minmax(0,440px)_minmax(0,1fr)]">
        <div className="space-y-6">
          {visible.length === 0 && (
            <p className="text-muted-foreground rounded-md border border-dashed px-4 py-6 text-center text-sm">
              {filter === "done"
                ? "No incident is marked as fixed yet."
                : "No open incident."}
            </p>
          )}
          {TEAM_ORDER.map((team) => {
            const list = visible.filter((f) => teamOf(f) === team);
            if (!list.length) return null;
            const all = sorted.filter((f) => teamOf(f) === team);
            const open = all.filter((f) => statusOf(acks, f) !== "done").length;
            return (
              <div key={team}>
                <div className="mb-1 flex items-baseline justify-between gap-2">
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <h3
                          className={cn(
                            "cursor-help text-[10.5px] font-medium tracking-[0.08em] uppercase",
                            IT_TEAMS.has(team)
                              ? "text-foreground"
                              : "text-muted-foreground",
                          )}
                        />
                      }
                    >
                      {TEAMS[team].label}
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                      {TEAMS[team].help}
                    </TooltipContent>
                  </Tooltip>
                  <span className="text-muted-foreground font-mono text-[11px] tabular-nums">
                    {open} open / {all.length}
                  </span>
                </div>
                <ul className="divide-y border-y">
                  {list.map((f) => (
                    <QueueRow
                      key={f.id}
                      f={f}
                      startEpoch={startEpoch}
                      status={statusOf(acks, f)}
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
          {/* keyed: a newly selected incident starts at its top */}
          <div
            key={selected?.id ?? "none"}
            className="scrollbar-thin sticky top-[calc(var(--chrome-h,3.5rem)+1.5rem)] max-h-[calc(100dvh-var(--chrome-h,3.5rem)-2.5rem)] overflow-y-auto pr-1"
          >
            {detail ?? (
              <p className="text-muted-foreground py-10 text-center text-sm">
                Select an incident to see its details.
              </p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function QueueRow({
  f,
  startEpoch,
  status,
  selected,
  onPick,
}: {
  f: Finding;
  startEpoch: number | null;
  status: Status;
  selected: boolean;
  onPick: (f: Finding) => void;
}) {
  const step = stepOf(f);
  const devices = devicesOf(f).size;
  return (
    <li>
      <button
        type="button"
        onClick={() => onPick(f)}
        aria-current={selected ? "true" : undefined}
        className={cn(
          "relative flex w-full items-start gap-3 py-3 pr-2 pl-4 text-left transition-colors",
          selected ? "bg-muted" : "hover:bg-muted/50",
          status === "done" && !selected && "opacity-55",
        )}
      >
        <UrgencyStripe finding={f} />
        <span className="min-w-0 flex-1 space-y-1">
          <span className="line-clamp-2 text-[13px] leading-snug font-medium">
            <span className="text-muted-foreground mr-1.5 font-mono text-[11px] font-normal">
              #{f.id}
            </span>
            {f.title}
          </span>
          <span className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
            <span className="rounded-sm border px-1.5 leading-[16px]">
              {step ? `Step ${step} · ${STEPS[step - 1].label}` : "Site-wide"}
            </span>
            {devices > 0 && <span>{plural(devices, "device", "devices")}</span>}
            <span className="font-mono">since {clockOf(startEpoch, f.t_start)}</span>
          </span>
        </span>
        <StatusPill status={status} />
      </button>
    </li>
  );
}

// ------------------------------------------------------------------ incident detail

function IncidentDetail({
  f,
  result,
  status,
  ack,
  shared,
  onStatus,
}: {
  f: Finding;
  result: Result;
  status: Status;
  ack: Ack | undefined;
  shared: boolean;
  onStatus: (f: Finding, state: AckState | null) => void;
}) {
  const startEpoch = result.summary.start_epoch;
  const team = teamOf(f);
  const step = stepOf(f);
  const steps = fixSteps(f);
  const proof = originProof(f);
  const missing = missingOf(f);
  const apBy = useMemo(
    () => new Map(result.aps.map((a) => [a.bssid.toLowerCase(), a])),
    [result.aps],
  );
  const involved = useMemo(() => {
    const out = new Set<string>();
    if (f.type !== "weak_security" && f.bssid) out.add(f.bssid.toLowerCase());
    for (const a of f.affected ?? [])
      for (const v of [a.bssid, a.ap])
        if (typeof v === "string" && v.length === 17) out.add(v.toLowerCase());
    return [...out].sort();
  }, [f]);

  async function copyTicket() {
    const link = `${window.location.origin}/it?f=${f.id}`;
    try {
      await navigator.clipboard.writeText(ticketText(f, startEpoch, link));
      toast.success("Ticket copied", {
        description: `#${f.id} · paste it into the service desk`,
      });
    } catch {
      toast.error("The browser blocked the clipboard.");
    }
  }

  const ackTime = ack ? new Date(ack.at) : null;
  const ackText =
    ackTime && !Number.isNaN(ackTime.getTime())
      ? `${STATUS[ack!.state].label} ${ackTime.toISOString().slice(11, 16)} UTC`
      : null;

  return (
    <article className="space-y-6 text-[13px]">
      <header className="space-y-2 border-b pb-4">
        <div className="flex flex-wrap items-center gap-2">
          <SeverityBadge severity={f.severity} />
          <Badge variant="outline">{TYPE_LABEL[f.type] ?? f.type}</Badge>
          <Badge variant="outline" className="text-muted-foreground">
            {TEAMS[team].label}
          </Badge>
          <span className="text-muted-foreground ml-auto font-mono text-xs">
            #{f.id}
          </span>
        </div>
        <h2 className="text-base leading-snug font-semibold">{f.title}</h2>
        <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span className="inline-flex items-center gap-1">
            <Clock className="size-3.5" />
            <span className="font-mono">{windowText(f, startEpoch)}</span>
          </span>
          <span className="inline-flex items-center gap-1">
            <RadioTower className="size-3.5" />
            {seenBy(sensorsOf(f).length)}
          </span>
          {f.closest_sensor && (
            <span className="inline-flex items-center gap-1">
              <MapPin className="size-3.5" />
              closest: {f.closest_sensor}
            </span>
          )}
          {f.networks?.length ? (
            <span className="font-mono">{f.networks.join(", ")}</span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2 pt-2">
          <StatusPill status={status} />
          {ackText && (
            <span className="text-muted-foreground text-[11px]">{ackText}</span>
          )}
          <span className="ml-auto flex flex-wrap items-center gap-1.5">
            {status === "open" && (
              <Button size="xs" variant="outline" onClick={() => onStatus(f, "ack")}>
                <Check /> Acknowledge
              </Button>
            )}
            {status !== "done" && (
              <Button size="xs" variant="outline" onClick={() => onStatus(f, "done")}>
                <CheckCheck /> Mark as fixed
              </Button>
            )}
            {status !== "open" && (
              <Button size="xs" variant="ghost" onClick={() => onStatus(f, null)}>
                <RotateCcw /> Reopen
              </Button>
            )}
            <Tooltip>
              <TooltipTrigger
                render={<Button size="xs" onClick={copyTicket} />}
              >
                <Clipboard /> Copy ticket
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                Plain text with owner, window, scope, root cause, fix, evidence
                frames and Wireshark filters.
              </TooltipContent>
            </Tooltip>
          </span>
        </div>
        {!shared && (
          <p className="text-muted-foreground text-[11px]">
            This server does not share the status. It stays in this browser.
          </p>
        )}
      </header>

      <StepTrace f={f} step={step} />

      <Diagnosis f={f} end={captureEnd(result)} owner={TEAMS[team].label} />

      <section className="space-y-1.5">
        <SectionTitle>Root cause</SectionTitle>
        <p className="text-muted-foreground leading-relaxed">{f.detail}</p>
      </section>

      {proof && (
        <section className="bg-panel flex gap-2.5 rounded-md border px-3 py-2.5">
          <ShieldCheck className="text-ok mt-0.5 size-4 shrink-0" />
          <p className="leading-relaxed">{proof}</p>
        </section>
      )}

      {steps.length > 0 && (
        <section className="relative space-y-2 overflow-hidden rounded-md border py-3 pr-3 pl-4">
          <UrgencyStripe finding={f} />
          <SectionTitle>Fix</SectionTitle>
          <ol className="space-y-1.5">
            {steps.map((s, i) => (
              <li key={i} className="flex gap-2.5 leading-snug">
                <span className="bg-muted text-muted-foreground mt-px flex size-[18px] shrink-0 items-center justify-center rounded-full font-mono text-[10.5px] tabular-nums">
                  {i + 1}
                </span>
                <span>{s}</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {f.confidence && (
        <section className="space-y-1">
          <SectionTitle className="flex items-center gap-2">
            Why Gearbox is sure
            <span
              className={cn(
                "font-mono text-xs font-normal",
                f.confidence.level === "high"
                  ? "text-ok"
                  : f.confidence.level === "medium"
                    ? "text-warn"
                    : "text-muted-foreground",
              )}
            >
              confidence {f.confidence.level}
            </span>
          </SectionTitle>
          {f.confidence.reasons.length > 0 && (
            <ul className="text-muted-foreground list-disc space-y-0.5 pl-5 text-xs">
              {f.confidence.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
        </section>
      )}

      {(missing.length > 0 || involved.length > 0) && (
        <section className="space-y-2">
          <SectionTitle>Infrastructure</SectionTitle>
          {missing.length > 0 && (
            <div className="space-y-1">
              <div className="text-muted-foreground text-xs">
                Expected on the air, but no beacon in the capture
              </div>
              <ul className="flex flex-wrap gap-1.5">
                {missing.map((m) => (
                  <li
                    key={m.bssid}
                    className={cn(
                      "rounded-sm border px-1.5 py-0.5 font-mono text-xs",
                      m.ssid && /TOOL/i.test(m.ssid)
                        ? "border-tesla/40 text-tesla"
                        : "text-foreground",
                    )}
                  >
                    {m.bssid}
                    <span className="text-muted-foreground ml-1.5">
                      {m.wholeRadio
                        ? "whole access point"
                        : [m.ssid, m.channel ? `ch ${m.channel}` : null]
                            .filter(Boolean)
                            .join(" · ")}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {involved.length > 0 && (
            <div className="space-y-1">
              <div className="text-muted-foreground text-xs">
                {plural(involved.length, "BSSID", "BSSIDs")} involved
              </div>
              <ul className="flex flex-wrap gap-1.5">
                {involved.map((b) => {
                  const ap = apBy.get(b);
                  return (
                    <li
                      key={b}
                      className="rounded-sm border px-1.5 py-0.5 font-mono text-xs"
                    >
                      {b}
                      {ap && (
                        <span className="text-muted-foreground ml-1.5">
                          {[ap.ssid, ap.channel ? `ch ${ap.channel}` : null]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </section>
      )}

      {f.affected && f.affected.length > 0 && (
        <section className="space-y-2">
          <div className="flex flex-wrap items-baseline justify-between gap-x-2">
            <SectionTitle>Affected devices</SectionTitle>
            <span className="text-muted-foreground text-xs">
              {plural(f.affected.length, "row", "rows")}, one root cause
            </span>
          </div>
          <div className="scrollbar-thin max-h-72 overflow-auto rounded-md">
            <AffectedTable rows={f.affected} />
          </div>
        </section>
      )}

      {f.evidence.length > 0 && (
        <section className="space-y-2">
          <div className="flex flex-wrap items-baseline justify-between gap-x-2">
            <SectionTitle>Evidence</SectionTitle>
            <span className="text-muted-foreground text-xs">
              sensor#frame in the original pcaps
            </span>
          </div>
          <div className="divide-y rounded-md border font-mono text-xs">
            {f.evidence.map((e, i) => (
              <div
                key={i}
                className="flex flex-wrap gap-x-3 gap-y-0.5 px-2.5 py-1.5 sm:flex-nowrap"
              >
                <span className="text-muted-foreground w-14 shrink-0">
                  {fmtT(e.t)}
                </span>
                <span className="min-w-0 flex-1 font-sans">{e.what}</span>
                <span className="text-muted-foreground w-full break-all sm:w-auto sm:max-w-[40%] sm:text-right">
                  {(e.frames ?? []).map((r) => `${r.sensor}#${r.frame}`).join(" ")}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      <Wireshark finding={f} />

      <div className="text-muted-foreground flex justify-end border-t pt-3 text-xs">
        <Link
          href={`/?f=${f.id}`}
          className="hover:text-foreground inline-flex items-center gap-1 underline-offset-2 hover:underline"
        >
          Open in the main dashboard <ExternalLink className="size-3" />
        </Link>
      </div>
    </article>
  );
}

// Five connection steps of this finding: passed, broken, not reached
function StepTrace({ f, step }: { f: Finding; step: number | null }) {
  const color = URGENCY[urgencyOf(f)].dot;
  if (step == null)
    return (
      <div className="text-muted-foreground bg-panel rounded-md border px-3 py-2 text-xs">
        Site-wide finding. It is not tied to one connection step of a device.
      </div>
    );
  return (
    <div>
      <div className="text-muted-foreground mb-1.5 text-xs">
        Where the connection breaks
      </div>
      <ol className="grid grid-cols-5 gap-1">
        {STEPS.map((s) => {
          const passed = s.n < step;
          const broken = s.n === step;
          return (
            <li
              key={s.n}
              className={cn(
                "rounded-sm border px-2 py-1.5",
                passed && "border-ok/30 bg-ok/5",
                !passed && !broken && "opacity-50",
              )}
              style={
                broken
                  ? { borderColor: color, background: `${color}12` }
                  : undefined
              }
            >
              <div
                className={cn(
                  "flex items-center gap-1 text-[11.5px] font-medium",
                  passed && "text-ok",
                )}
                style={broken ? { color } : undefined}
              >
                <span className="font-mono text-[10.5px]">{s.n}</span>
                {s.label}
                <span className="ml-auto">
                  {passed ? "✓" : broken ? "✕" : ""}
                </span>
              </div>
              <div className="text-muted-foreground truncate text-[10px]">
                {s.sub}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// Three questions decide the cause: which step is missing, how far it spreads, who sent the
// last frame (the same logic the pitch shows for Tesla's four real cases)
function Diagnosis({
  f,
  end,
  owner,
}: {
  f: Finding;
  end: number;
  owner: string;
}) {
  const rows = diagnosis(f, end);
  const color = URGENCY[urgencyOf(f)].dot;
  return (
    <section className="overflow-hidden rounded-md border">
      <div className="bg-panel flex items-baseline justify-between gap-2 border-b px-3 py-1.5">
        <SectionTitle>How Gearbox decides the cause</SectionTitle>
        <span className="text-muted-foreground text-[11px]">
          three questions, answered from the frames
        </span>
      </div>
      <ol className="divide-y">
        {rows.map((r, i) => (
          <li
            key={r.q}
            className="grid gap-x-3 gap-y-0.5 px-3 py-2 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)]"
          >
            <span className="text-muted-foreground flex items-start gap-2 text-xs">
              <span className="bg-muted mt-px flex size-[18px] shrink-0 items-center justify-center rounded-full font-mono text-[10.5px]">
                {i + 1}
              </span>
              {r.q}
            </span>
            <span className="min-w-0">
              <span className="font-medium">{r.a}</span>
              {r.sub && (
                <span className="text-muted-foreground block text-xs">
                  {r.sub}
                </span>
              )}
            </span>
          </li>
        ))}
        <li
          className="grid gap-x-3 px-3 py-2 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)]"
          style={{ background: `${color}0f` }}
        >
          <span className="text-xs font-medium" style={{ color }}>
            → Cause
          </span>
          <span className="min-w-0">
            <span className="font-semibold" style={{ color }}>
              {causeText(f)}
            </span>
            <span className="text-muted-foreground"> · owner: {owner}</span>
          </span>
        </li>
      </ol>
    </section>
  );
}

function SectionTitle({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <h3 className={`text-[13px] font-semibold ${className}`}>{children}</h3>
  );
}

// ------------------------------------------------------------------ AP radios

export function RadioGrid({
  result,
  radios,
  onPick,
}: {
  result: Result;
  radios: Radio[];
  onPick: (findingId: number) => void;
}) {
  const s = result.summary;
  const onAir = radios.filter((r) => r.bssids.some((b) => b.onAir)).length;
  const offColor = (ssid: string | null) =>
    ssid && /TOOL/i.test(ssid) ? "var(--tesla)" : "var(--warn)";
  if (!radios.length) return null;
  return (
    <section>
      <SectionLabel
        title="Access points"
        help="Every access point with its networks (BSSIDs), the security its beacons announce, and the findings that point to it. Select an access point with a finding to open it."
        right={`${onAir} of ${s.radios_expected ?? radios.length} access points on the air · ${s.networks ?? s.aps} networks (BSSIDs)`}
      />
      <div className="text-muted-foreground mb-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
        <span className="inline-flex items-center gap-1.5">
          <span className="bg-ok size-1.5 rounded-full" /> On the air
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="bg-tesla size-1.5 rounded-full" /> Off the air ·
          TESLA-TOOLS
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="bg-warn size-1.5 rounded-full" /> Off the air · other
          network
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-[2px] border border-dashed border-zinc-400" />
          Access point silent
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
        {radios.map((r) => {
          const off = r.bssids.filter((b) => !b.onAir);
          const hit = r.findings.length > 0;
          const Tag = hit ? "button" : "div";
          return (
            <Tag
              key={r.radio}
              {...(hit
                ? { type: "button" as const, onClick: () => onPick(r.findings[0]) }
                : {})}
              className={cn(
                "flex min-w-0 flex-col rounded-md border p-2.5 text-left transition-colors",
                hit && "hover:border-foreground/40",
                r.silent && "bg-panel border-dashed",
              )}
              style={
                off.length && !r.silent
                  ? { borderColor: offColor(off[0].ssid) }
                  : undefined
              }
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[12.5px] font-medium">{r.label}</span>
                <span className="text-muted-foreground font-mono text-[10.5px]">
                  {r.channel ? `ch ${r.channel}` : "–"}
                </span>
              </div>
              <div className="text-muted-foreground truncate font-mono text-[10px]">
                {r.radio}:xx
              </div>
              <ul className="mt-2 space-y-1">
                {r.silent && r.bssids.every((b) => !b.onAir) && (
                  <li className="text-muted-foreground text-[11px] leading-snug">
                    No beacon from this access point in the whole capture
                  </li>
                )}
                {r.bssids.map((b) => {
                  const akm = akmLabel(b.akm);
                  const mfp = mfpLabel(b);
                  return (
                    <li key={b.bssid} className="flex min-w-0 items-center gap-1.5 text-[11px]">
                      <span
                        className="size-1.5 shrink-0 rounded-full"
                        style={{
                          background: b.onAir ? "var(--ok)" : offColor(b.ssid),
                        }}
                      />
                      <span
                        className={cn(
                          "min-w-0 flex-1 truncate",
                          !b.onAir && "line-through decoration-1 opacity-70",
                        )}
                        title={b.bssid}
                      >
                        {b.ssid || "(hidden)"}
                      </span>
                      {b.onAir ? (
                        <span
                          className={cn(
                            "shrink-0 font-mono text-[9.5px]",
                            mfp?.weak ? "text-violet-700" : "text-muted-foreground",
                          )}
                          title={[akm, mfp?.text].filter(Boolean).join(" · ")}
                        >
                          {[akm, mfp?.weak ? mfp.text : null]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      ) : (
                        <span
                          className="shrink-0 text-[10px] font-medium"
                          style={{ color: offColor(b.ssid) }}
                        >
                          off
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
              <div className="text-muted-foreground mt-auto flex flex-wrap gap-1 pt-2 font-mono text-[10px]">
                {hit
                  ? r.findings.map((id) => (
                      <span key={id} className="bg-muted rounded-sm px-1">
                        #{id}
                      </span>
                    ))
                  : r.bssids.some((b) => b.clients)
                    ? `${r.bssids.reduce((n, b) => n + (b.clients ?? 0), 0)} devices`
                    : null}
              </div>
            </Tag>
          );
        })}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ sensors

const DRIFT_LIMIT_PPM = 5;

function SensorTable({ result }: { result: Result }) {
  const stats = result.sensors.stats ?? [];
  const drift = result.sensors.drift_ppm ?? {};
  if (!stats.length) return null;
  const maxOff = Math.max(1, ...stats.map((s) => Math.abs(s.clock_offset_ms)));
  return (
    <section>
      <SectionLabel
        title="Sensors"
        help="Gearbox measures each sensor clock against the AP beacon timestamps and corrects it before it compares sensors. A drift above 5 ppm means the sensor's own time sync (NTP / PTP) does not work."
        right={result.sensors.alignment ? `aligned by ${result.sensors.alignment}` : undefined}
      />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-[12px]">
          <thead>
            <tr className="text-muted-foreground border-b text-left text-[11px]">
              <th className="py-1.5 pr-3 font-normal">Sensor</th>
              <th className="py-1.5 pr-3 font-normal">Ch</th>
              <th className="py-1.5 pr-3 text-right font-normal">Frames</th>
              <th className="w-[34%] py-1.5 pr-3 font-normal">Clock offset</th>
              <th className="py-1.5 pr-3 text-right font-normal">Drift</th>
              <th className="py-1.5 text-right font-normal">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {stats.map((s) => {
              const d = drift[s.sensor] ?? 0;
              const ref = s.clock_offset_ms === 0 && d === 0;
              const bad = Math.abs(d) > DRIFT_LIMIT_PPM;
              const w = (Math.abs(s.clock_offset_ms) / maxOff) * 50;
              return (
                <tr key={s.sensor}>
                  <td className="py-1.5 pr-3 font-mono">{s.sensor}</td>
                  <td className="text-muted-foreground py-1.5 pr-3 font-mono">
                    {s.channels.join(", ")}
                  </td>
                  <td className="py-1.5 pr-3 text-right font-mono tabular-nums">
                    {s.frames.toLocaleString("en")}
                  </td>
                  <td className="py-1.5 pr-3">
                    <div className="flex items-center gap-2">
                      <div className="bg-muted relative h-1.5 flex-1 rounded-full">
                        <span className="bg-foreground/25 absolute top-[-2px] left-1/2 h-2.5 w-px" />
                        <span
                          className={cn(
                            "absolute top-0 h-1.5 rounded-full",
                            bad ? "bg-warn" : "bg-zinc-400",
                          )}
                          style={
                            s.clock_offset_ms >= 0
                              ? { left: "50%", width: `${w}%` }
                              : { right: "50%", width: `${w}%` }
                          }
                        />
                      </div>
                      <span className="w-[76px] shrink-0 text-right font-mono whitespace-nowrap tabular-nums">
                        {s.clock_offset_ms > 0 ? "+" : ""}
                        {Math.round(s.clock_offset_ms).toLocaleString("en")} ms
                      </span>
                    </div>
                  </td>
                  <td className="py-1.5 pr-3 text-right font-mono tabular-nums">
                    {d > 0 ? "+" : ""}
                    {d.toFixed(0)} ppm
                  </td>
                  <td className="py-1.5 text-right">
                    {ref ? (
                      <span className="text-muted-foreground text-[11px]">reference</span>
                    ) : bad ? (
                      <Tooltip>
                        <TooltipTrigger
                          render={<span className="text-warn cursor-help text-[11px] font-medium" />}
                        >
                          Fix time sync
                        </TooltipTrigger>
                        <TooltipContent>
                          {((Math.abs(d) * 86400) / 1e6).toFixed(1)} s off per day
                          without the correction.
                        </TooltipContent>
                      </Tooltip>
                    ) : (
                      <span className="text-ok text-[11px]">OK</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ checks

function CheckGrid({
  result,
  onPick,
}: {
  result: Result;
  onPick: (f: Finding) => void;
}) {
  const rows = CHECKS.map((c) => ({
    ...c,
    found: result.findings
      .filter((f) => c.types.includes(f.type))
      .sort(byPriority),
  }));
  const found = rows.filter((r) => r.found.length).length;
  return (
    <section>
      <SectionLabel
        title="What Gearbox checked"
        help="Every fault class runs on every capture. Clean means: checked and not found. This rules out causes, for example an attacker or congestion."
        right={`${found} found · ${rows.length - found} clean`}
      />
      <ul className="grid grid-cols-1 gap-px overflow-hidden rounded-md border bg-border sm:grid-cols-2">
        {rows.map((r) => {
          const first = r.found[0];
          const inner = (
            <>
              <span
                className={cn(
                  "flex size-4 shrink-0 items-center justify-center rounded-full",
                  !first && "text-ok",
                )}
              >
                {first ? (
                  <UrgencyDot finding={first} className="size-2" />
                ) : (
                  <Check className="size-3.5" />
                )}
              </span>
              <span className={cn("min-w-0 flex-1 truncate", !first && "text-muted-foreground")}>
                {r.label}
              </span>
              <span className="text-muted-foreground shrink-0 font-mono text-[10.5px]">
                {first ? r.found.map((f) => `#${f.id}`).join(" ") : "clean"}
              </span>
            </>
          );
          return (
            <li key={r.label} className="bg-background">
              {first ? (
                <button
                  type="button"
                  onClick={() => onPick(first)}
                  className="hover:bg-muted/60 flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] font-medium transition-colors"
                >
                  {inner}
                </button>
              ) : (
                <div className="flex items-center gap-2 px-3 py-2 text-[12px]">
                  {inner}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
