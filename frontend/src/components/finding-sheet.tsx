"use client";

import { memo, useEffect, useState } from "react";
import {
  Check,
  Clock,
  Copy,
  Cpu,
  Info,
  Loader2,
  MapPin,
  Phone,
  RadioTower,
  Text,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { SeverityBadge } from "@/components/severity";
import { ActionChip, URGENCY, UrgencyStripe } from "@/components/action";
import { Separator } from "@/components/ui/separator";
import { AffectedTable } from "@/components/affected-table";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  api,
  evidenceHint,
  fmtClock,
  fmtT,
  framesFilter,
  seenBy,
  TYPE_LABEL,
  type Finding,
  type LadderEvent,
} from "@/lib/api";
import { cn } from "@/lib/utils";

// Side sheet with the finding details (shop floor, engineering view, phone-width dashboard)
export function FindingSheet({
  dsId,
  finding,
  onClose,
  startEpoch,
}: {
  dsId: string;
  finding: Finding | null;
  onClose: () => void;
  startEpoch?: number | null;
}) {
  return (
    <Sheet open={!!finding} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full gap-0 overflow-y-auto data-[side=right]:sm:max-w-2xl">
        {finding && (
          <FindingDetails
            dsId={dsId}
            finding={finding}
            startEpoch={startEpoch}
            variant="sheet"
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

// The full details of one finding. "sheet" uses the sheet's title slots, "pane" renders inline.
// memo: the dashboard re-renders every replay frame, the details only when the finding changes
export const FindingDetails = memo(function FindingDetails({
  dsId,
  finding: f,
  startEpoch,
  variant = "pane",
}: {
  dsId: string;
  finding: Finding;
  startEpoch?: number | null;
  variant?: "sheet" | "pane";
}) {
  // State is tagged with the finding / client it belongs to, so switching
  // findings never shows stale data and no reset inside an effect is needed
  const [expl, setExpl] = useState<{ id: number; text: string } | null>(null);
  const [explaining, setExplaining] = useState(false);
  const [ladderState, setLadderState] = useState<{
    key: string;
    events: LadderEvent[];
  } | null>(null);

  const ladderKey = f.client ? `${dsId}/${f.client}` : null;
  const explanation = expl && expl.id === f.id ? expl.text : null;
  const ladder =
    ladderState && ladderState.key === ladderKey ? ladderState.events : null;

  useEffect(() => {
    if (!ladderKey || !f.client) return;
    api
      .client(dsId, f.client)
      .then((r) => setLadderState({ key: ladderKey, events: r.events }))
      .catch(() => setLadderState({ key: ladderKey, events: [] }));
  }, [dsId, f.client, ladderKey]);

  async function explain() {
    const id = f.id;
    setExplaining(true);
    try {
      setExpl({ id, text: (await api.explain(dsId, id)).text });
    } catch (e) {
      setExpl({ id, text: `The summary is not available: ${e}` });
    } finally {
      setExplaining(false);
    }
  }

  const sheet = variant === "sheet";
  const Title = sheet ? SheetTitle : "h2";
  const Desc = sheet ? SheetDescription : "div";
  const clock = (t: number) => fmtClock(startEpoch, t);

  return (
    <>
      <HeaderBox sheet={sheet}>
        <div className="flex flex-wrap items-center gap-2">
          <SeverityBadge severity={f.severity} />
          <Badge variant="outline">{TYPE_LABEL[f.type] ?? f.type}</Badge>
          {f.device_class && (
            <Badge
              variant="outline"
              className={
                f.device_class === "industrial"
                  ? "text-foreground"
                  : "text-muted-foreground"
              }
            >
              {f.device_class === "industrial" && <Cpu />}
              {f.device_class}
            </Badge>
          )}
          <span className="text-muted-foreground ml-auto font-mono text-xs">
            #{f.id}
          </span>
        </div>
        <Title className="text-base leading-snug font-semibold">
          {f.title}
        </Title>
        <Desc className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="inline-flex cursor-help items-center gap-1" />
              }
            >
              <Clock className="size-3.5" />
              <span className="font-mono">
                {fmtT(f.t_start)} - {fmtT(f.t_end)}
              </span>
              {clock(f.t_start) && (
                <span className="font-mono">
                  ({clock(f.t_start)} - {clock(f.t_end)} UTC)
                </span>
              )}
            </TooltipTrigger>
            <TooltipContent>
              First and last frame of this finding. Capture time (m:ss) and wall
              clock in UTC.
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="inline-flex cursor-help items-center gap-1" />
              }
            >
              <RadioTower className="size-3.5" />
              {seenBy(f.sensors.length)}
            </TooltipTrigger>
            <TooltipContent>
              Number of sensors that recorded frames of this finding.
            </TooltipContent>
          </Tooltip>
          {f.closest_sensor && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="inline-flex cursor-help items-center gap-1" />
                }
              >
                <MapPin className="size-3.5" />
                closest: {f.closest_sensor}
              </TooltipTrigger>
              <TooltipContent>
                The sensor that received the strongest signal. The problem is
                near this sensor.
              </TooltipContent>
            </Tooltip>
          )}
        </Desc>
      </HeaderBox>

      <div className={cn("space-y-6 text-[13px]", sheet ? "p-4" : "pt-5 pb-2")}>
        {f.action && (
          <section className="bg-card relative space-y-2 overflow-hidden rounded-md border py-3 pr-3 pl-4">
            <UrgencyStripe finding={f} />
            <div className="flex flex-wrap items-center gap-2">
              <SectionTitle>What to do now</SectionTitle>
              <ActionChip finding={f} />
            </div>
            <p className="text-sm leading-snug font-medium">
              {f.action.supervisor}
            </p>
            <p className="text-muted-foreground text-xs">
              {URGENCY[f.action.urgency]?.label}
              {f.scope && ` · ${f.scope}`}
              {f.networks?.length ? ` · ${f.networks.join(", ")}` : ""}
            </p>
          </section>
        )}
        {f.action?.it && (
          <section className="space-y-1 border-l-2 py-1 pl-3">
            <SectionTitle className="flex items-center gap-1.5">
              <Phone className="text-muted-foreground size-3.5" /> For IT
            </SectionTitle>
            <p className="leading-relaxed">{f.action.it}</p>
          </section>
        )}

        {f.confidence && (
          <section className="space-y-1">
            <SectionTitle className="flex items-center gap-2">
              Confidence
              <span
                className={cn(
                  "font-mono text-xs font-normal",
                  f.confidence.level === "high"
                    ? "text-ok dark:text-emerald-300"
                    : f.confidence.level === "medium"
                      ? "text-warn dark:text-amber-300"
                      : "text-muted-foreground",
                )}
              >
                {f.confidence.level}
              </span>
              <Hint>
                How sure Gearbox is about this finding. The reasons show the
                data that supports it.
              </Hint>
            </SectionTitle>
            <ul className="text-muted-foreground list-disc space-y-0.5 pl-5 text-xs">
              {f.confidence.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </section>
        )}

        {f.action && (
          <div className="flex items-center gap-3 pt-1">
            <span className="text-muted-foreground text-xs">Details</span>
            <Separator className="flex-1" />
          </div>
        )}

        <dl className="bg-border grid grid-cols-1 gap-px overflow-hidden rounded-md border sm:grid-cols-2 sm:[&>*:last-child:nth-child(odd)]:col-span-2">
          {f.client && (
            <Fact label="Device">
              <span className="font-mono">{f.client}</span>
              {f.vendor && (
                <span className="text-muted-foreground block truncate text-xs">
                  {f.vendor}
                </span>
              )}
            </Fact>
          )}
          {f.bssid && (
            <Fact label="AP (BSSID)">
              <span className="font-mono">{f.bssid}</span>
            </Fact>
          )}
          {f.channel && <Fact label="Channel">{f.channel}</Fact>}
          <Fact label="Sensors">
            <span className="font-mono text-xs">
              {f.sensors.join(", ") || "-"}
            </span>
          </Fact>
        </dl>

        <section className="space-y-1.5">
          <SectionTitle>What the sensors recorded</SectionTitle>
          <p className="text-muted-foreground leading-relaxed">{f.detail}</p>
        </section>
        <section className="space-y-1 border-l-2 py-1 pl-3">
          <SectionTitle>
            {f.action ? "Technical recommendation" : "Recommended action"}
          </SectionTitle>
          <p className="leading-relaxed">{f.recommendation}</p>
        </section>

        <section className="rounded-md border p-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <SectionTitle>Plain-language summary</SectionTitle>
              <p className="text-muted-foreground text-xs">
                For the shift lead. An LLM writes it when you click Generate.
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={explain}
              disabled={explaining}
            >
              {explaining ? <Loader2 className="animate-spin" /> : <Text />}
              {explaining ? "Generating…" : "Generate"}
            </Button>
          </div>
          {explaining && !explanation && (
            <div className="mt-3 space-y-2">
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-11/12" />
              <Skeleton className="h-3 w-2/3" />
            </div>
          )}
          {explanation && (
            <p className="mt-3 leading-relaxed whitespace-pre-line">
              {explanation}
            </p>
          )}
        </section>

        <Wireshark finding={f} />

        {f.occurrences && f.occurrences.length > 0 && (
          <section className="space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-x-2">
              <SectionTitle>Occurrences</SectionTitle>
              <span className="text-muted-foreground text-xs">
                One row for each day with this pattern
              </span>
            </div>
            <div className="divide-y rounded-md border text-xs">
              {f.occurrences.map((o, i) => (
                <div
                  key={i}
                  className="flex flex-wrap gap-x-3 gap-y-0.5 px-2.5 py-1.5"
                >
                  <span className="font-mono">{o.day}</span>
                  <span className="text-muted-foreground font-mono">
                    {o.from} - {o.to}
                  </span>
                  <span className="min-w-0 flex-1">{o.what}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        {f.affected && f.affected.length > 0 && (
          <section className="space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-x-2">
              <SectionTitle>Affected devices</SectionTitle>
              <span className="text-muted-foreground text-xs">
                {f.affected.length}{" "}
                {f.affected.length === 1 ? "device" : "devices"}, one root cause
              </span>
            </div>
            {evidenceHint(f) && (
              <p className="text-muted-foreground text-xs">{evidenceHint(f)}</p>
            )}
            <AffectedTable rows={f.affected} />
          </section>
        )}

        {f.missing_bssids && f.missing_bssids.length > 0 && (
          <section className="space-y-2">
            <SectionTitle>Expected on the air, but silent</SectionTitle>
            <ul className="flex flex-wrap gap-1.5">
              {f.missing_bssids.map((b) => (
                <li
                  key={b}
                  className={cn(
                    "rounded-sm border px-1.5 py-0.5 font-mono text-xs dark:text-red-300",
                    /TOOL/i.test(b)
                      ? "border-tesla/40 text-tesla"
                      : "text-foreground",
                  )}
                >
                  {b}
                </li>
              ))}
            </ul>
          </section>
        )}

        {f.evidence.length > 0 && (
          <section className="space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-x-2">
              <SectionTitle>Evidence</SectionTitle>
              <span className="text-muted-foreground text-xs">
                sensor#frame. You can find each frame in Wireshark.
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
                    {(e.frames ?? [])
                      .map((r) => `${r.sensor}#${r.frame}`)
                      .join(" ")}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        {f.client && (
          <section className="space-y-2">
            <SectionTitle>Connection sequence of this device</SectionTitle>
            {!ladder && (
              <div className="space-y-1.5 rounded-md border p-3">
                {Array.from({ length: 6 }, (_, i) => (
                  <Skeleton key={i} className="h-4 w-full" />
                ))}
              </div>
            )}
            {ladder && <Ladder events={ladder} client={f.client} />}
          </section>
        )}
      </div>
    </>
  );
});

function HeaderBox({
  sheet,
  children,
}: {
  sheet: boolean;
  children: React.ReactNode;
}) {
  if (sheet)
    return (
      <SheetHeader className="gap-2 border-b p-4 pr-12">{children}</SheetHeader>
    );
  return <div className="flex flex-col gap-2 border-b pb-4">{children}</div>;
}

// Copy-ready Wireshark display filters: all frames, exact evidence frames per sensor, proof of absence
export function Wireshark({ finding: f }: { finding: Finding }) {
  const frames = framesFilter(f);
  const perSensor = Object.entries(frames);
  if (!f.wireshark_filter && !perSensor.length && !f.wireshark_filter_absent)
    return null;
  return (
    <section className="space-y-3">
      <div className="space-y-0.5">
        <SectionTitle className="flex items-center gap-2">
          Check in Wireshark
          <Hint>
            Paste a filter into the display filter bar of Wireshark 4, or use it
            with tshark -Y.
          </Hint>
        </SectionTitle>
        <p className="text-muted-foreground text-xs">
          Copy a display filter. Then open the sensor pcap in Wireshark.
        </p>
      </div>
      {f.wireshark_filter && (
        <FilterRow
          label="All frames of this finding"
          hint="This filter works in the pcap of each sensor."
          filter={f.wireshark_filter}
        />
      )}
      {perSensor.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-baseline justify-between gap-x-2">
            <span className="text-xs font-medium">Evidence frames</span>
            <span className="text-muted-foreground text-[11px]">
              Frame numbers are different in each pcap. Use the filter of the
              file that you open.
            </span>
          </div>
          {perSensor.map(([sensor, filter]) => (
            <FilterRow
              key={sensor}
              label={sensor}
              filter={filter}
              mono
              hint={`Only in the pcap of ${sensor}.`}
            />
          ))}
        </div>
      )}
      {f.wireshark_filter_absent && (
        <FilterRow
          label="Missing networks: should match nothing"
          hint="Use this filter in each pcap. If it shows a frame, the network is on the air."
          filter={f.wireshark_filter_absent}
        />
      )}
    </section>
  );
}

function FilterRow({
  label,
  filter,
  hint,
  mono = false,
}: {
  label: string;
  filter: string;
  hint?: string;
  mono?: boolean;
}) {
  const [done, setDone] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(filter);
      setDone(true);
      toast.success("Filter copied", { description: label });
      setTimeout(() => setDone(false), 1500);
    } catch {
      toast.error("The browser blocked the clipboard. Select the text.");
    }
  }
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span
          className={cn("text-xs", mono ? "font-mono" : "font-medium")}
          title={hint}
        >
          {label}
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="xs"
                variant="outline"
                onClick={copy}
                aria-label={`Copy Wireshark filter: ${label}`}
              />
            }
          >
            {done ? <Check /> : <Copy />}
            {done ? "Copied" : "Copy Wireshark filter"}
          </TooltipTrigger>
          <TooltipContent>{hint ?? "Copy the display filter."}</TooltipContent>
        </Tooltip>
      </div>
      <code className="bg-muted text-foreground/90 block max-h-24 overflow-y-auto rounded-sm px-2 py-1.5 font-mono text-[11px] leading-relaxed break-all select-all">
        {filter}
      </code>
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        className="text-muted-foreground hover:text-foreground rounded-sm font-normal"
        aria-label="More information"
      >
        <Info className="size-3.5" />
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{children}</TooltipContent>
    </Tooltip>
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

function Fact({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-card min-w-0 px-3 py-1.5">
      <dt className="text-muted-foreground text-[11px]">{label}</dt>
      <dd className="mt-0.5 truncate">{children}</dd>
    </div>
  );
}

function tone(e: LadderEvent) {
  if (
    /Failure|reason (?!3\b|8\b)|status [1-9]/.test(e.label) ||
    e.kind === "deauth" ||
    e.kind === "disassoc"
  )
    return "text-red-600 dark:text-red-400";
  if (/Success|M4/.test(e.label))
    return "text-emerald-700 dark:text-emerald-400";
  if (e.kind === "reassoc_req") return "text-sky-700 dark:text-sky-400";
  return "";
}

function Ladder({ events, client }: { events: LadderEvent[]; client: string }) {
  const shown = events
    .filter((e) => e.kind !== "probe_req" && e.kind !== "probe_resp")
    .slice(0, 200);
  if (!shown.length)
    return (
      <p className="text-muted-foreground rounded-md border px-3 py-3 text-xs">
        The sensors recorded no connection events for this device.
      </p>
    );
  return (
    <div className="overflow-hidden rounded-md border">
      <div className="scrollbar-thin max-h-96 overflow-auto font-mono text-xs">
        <div className="min-w-[520px]">
          <div className="bg-card text-muted-foreground sticky top-0 z-10 grid grid-cols-[60px_1fr_24px_1fr_96px] gap-2 border-b px-3 py-1.5 font-sans text-[11px]">
            <span>Time</span>
            <span className="text-right">Device</span>
            <span />
            <span>AP</span>
            <span className="text-right">Heard</span>
          </div>
          {shown.map((e, i) => {
            const fromClient = e.from === client;
            return (
              <div
                key={i}
                className="hover:bg-muted/60 grid grid-cols-[60px_1fr_24px_1fr_96px] items-center gap-2 border-b border-zinc-100 px-3 py-1 dark:border-white/5 dark:hover:bg-white/[0.03]"
              >
                <span className="text-muted-foreground">{fmtT(e.t)}</span>
                <span
                  className={`truncate text-right ${fromClient ? tone(e) : "text-muted-foreground"}`}
                >
                  {fromClient ? e.label : ""}
                </span>
                <span className="text-muted-foreground text-center">
                  {fromClient ? "→" : "←"}
                </span>
                <span
                  className={`truncate ${!fromClient ? tone(e) : "text-muted-foreground"}`}
                >
                  {!fromClient ? e.label : ""}
                </span>
                <span className="text-muted-foreground truncate text-right">
                  {e.sensors.length}× · {e.best_rssi ?? "?"} dBm
                </span>
              </div>
            );
          })}
        </div>
      </div>
      <div className="text-muted-foreground bg-muted/30 border-t px-3 py-1.5 text-xs">
        Left: device · right: AP · {shown.length} events
      </div>
    </div>
  );
}
