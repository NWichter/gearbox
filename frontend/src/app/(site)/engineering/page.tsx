"use client";

import { useState } from "react";
import { Cpu, Info } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ChannelChart, EventTimeline, RfChart } from "@/components/charts";
import { DatasetPicker, PendingState } from "@/components/dataset-state";
import { FindingSheet } from "@/components/finding-sheet";
import { toolsDevices, urgencyOf } from "@/components/action";
import { IncidentTimeline } from "@/components/incident-timeline";
import {
  ReplayBar,
  ReplayNow,
  useReplay,
  type Replay,
} from "@/components/replay";
import { SiteMap } from "@/components/site-map";
import { AirMap } from "@/components/air-map";
import {
  captureEnd,
  fmtMmss as mmss,
  SEVERITY_RANK,
  utc,
  type Finding,
  type Result,
} from "@/lib/api";
import { useDataset } from "@/lib/use-dataset";
import { cn } from "@/lib/utils";

type Tab = "timeline" | "rf" | "airmap" | "sensors" | "network";

// Engineering view: everything the wireless engineer needs beyond the findings
export default function Engineering() {
  const { datasets, dsId, setDsId, result, status, reload, current } =
    useDataset();
  const [picked, setPicked] = useState<Finding | null>(null);
  const [tab, setTab] = useState<Tab>("timeline");

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 border-b pb-4 md:flex-row md:items-end md:justify-between">
        <div className="min-w-0 space-y-1">
          <h1 className="text-xl font-light tracking-tight">
            Engineering view
          </h1>
          {result ? (
            <MetaLine result={result} name={current?.name} />
          ) : (
            <div className="text-muted-foreground font-mono text-xs">
              {status === "loading" ? "loading…" : status}
            </div>
          )}
        </div>
        <DatasetPicker
          datasets={datasets}
          value={dsId}
          onChange={(id) => {
            setPicked(null);
            setDsId(id);
          }}
          onUploaded={async (id) => {
            await reload();
            setDsId(id);
          }}
        />
      </div>

      {!result && <PendingState status={status} name={current?.name} />}

      {result && dsId && (
        <>
          <StatStrip result={result} />
          <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
            <div className="scrollbar-thin -mx-4 overflow-x-auto border-b px-4 sm:mx-0 sm:px-0">
              <TabsList variant="line" className="h-9! gap-1">
                <TabsTrigger value="timeline" className="px-2 text-[13px]">
                  Incident timeline
                </TabsTrigger>
                <TabsTrigger value="rf" className="px-2 text-[13px]">
                  RF health
                </TabsTrigger>
                <TabsTrigger value="airmap" className="px-2 text-[13px]">
                  Channel map
                </TabsTrigger>
                <TabsTrigger value="sensors" className="px-2 text-[13px]">
                  Sensor fusion
                  <CountPill n={result.sensors.sensors.length} />
                </TabsTrigger>
                <TabsTrigger value="network" className="px-2 text-[13px]">
                  Devices and APs
                </TabsTrigger>
              </TabsList>
            </div>

            {/* timeline and RF health share one replay */}
            <ReplayTabs
              key={dsId}
              result={result}
              onPick={setPicked}
              tab={tab}
            />

            <TabsContent value="airmap" className="space-y-3 pt-4">
              <Card>
                <CardHeader>
                  <CardTitle>
                    Site map (estimate from signal strength)
                  </CardTitle>
                  <CardDescription>
                    Relative positions of sensors, AP radios and devices.
                    Coloured symbols have a finding. Click a symbol to open the
                    finding.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <SiteMap result={result} onPick={setPicked} />
                </CardContent>
              </Card>
              <AirMap
                result={result}
                onSelectAp={(_, related) => {
                  // several findings on one AP: open the most important one
                  const f = [...related].sort(
                    (a, b) =>
                      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
                  )[0];
                  if (f) setPicked(f);
                }}
              />
            </TabsContent>

            <TabsContent value="sensors" className="pt-4">
              <Sensors result={result} />
            </TabsContent>

            <TabsContent value="network" className="pt-4">
              <Network result={result} />
            </TabsContent>
          </Tabs>

          <FindingSheet
            dsId={dsId}
            finding={picked}
            startEpoch={result.summary.start_epoch}
            onClose={() => setPicked(null)}
          />
        </>
      )}
    </div>
  );
}

function channelCount(result: Result) {
  return new Set(result.sensors.stats.flatMap((s) => s.channels)).size;
}

function hasCu(result: Result) {
  return result.channel_timeline.some((d) => d.cu_pct != null);
}

// One factual line under the title: capture window and coverage
function MetaLine({ result, name }: { result: Result; name?: string }) {
  const s = result.summary;
  const parts = [
    name ?? null,
    s.start_epoch != null
      ? `${utc(s.start_epoch)} - ${utc(s.start_epoch + s.duration_s).slice(11)} UTC`
      : null,
    `${mmss(s.duration_s)} recorded`,
    `${s.sensors} sensors`,
    `${channelCount(result)} channels`,
    `${s.radios_on_air ?? s.aps} AP radios`,
    `${s.devices_total ?? s.clients} devices`,
  ].filter(Boolean);
  return (
    <div className="text-muted-foreground flex flex-wrap gap-x-3 text-xs sm:gap-x-2">
      {parts.map((p, i) => (
        <span key={i} className="whitespace-nowrap">
          {i > 0 && <span className="mr-2 hidden opacity-40 sm:inline">·</span>}
          {p}
        </span>
      ))}
    </div>
  );
}

function CountPill({ n }: { n: number | string }) {
  return (
    <span className="bg-muted text-muted-foreground rounded-sm px-1 py-px font-mono text-[10px] tabular-nums">
      {n}
    </span>
  );
}

// Stat row; each cell explains itself on hover
function StatStrip({ result }: { result: Result }) {
  const s = result.summary;
  const urgent = result.findings.filter((f) => urgencyOf(f) === "red").length;
  const items: {
    label: string;
    value: string | number;
    hint: string;
    help: string;
    tone?: string;
  }[] = [
    {
      label: "Line risk",
      value: urgent,
      hint: `${toolsDevices(result.findings)} devices on the tools network`,
      help: "Findings on the tools network (torque tools, robots). These findings can stop the line.",
      tone: urgent ? "text-tesla" : "text-ok",
    },
    {
      label: "Findings",
      value: s.findings,
      hint: `${s.by_severity.critical ?? 0} critical · ${s.by_severity.high ?? 0} high`,
      help: "Problems grouped by root cause. Tools and robots come first.",
    },
    {
      label: "Sensors",
      value: s.sensors,
      hint: `${s.files.length} capture files`,
      help: "Monitor-mode sensors, one capture file each. Here every sensor listens on its own channel, so no frame is heard twice: sensors confirm each other through the same pattern on several channels at once (controller stall, login server down).",
    },
    {
      label: "Frames",
      value: s.frames.toLocaleString("en"),
      hint: `${s.duration_s.toFixed(0)} s recorded`,
      help: "802.11 frames from all sensors. Gearbox reads the headers only, not the payload.",
    },
    {
      label: "Devices",
      value: s.devices_total ?? s.clients,
      hint:
        s.devices_connected != null
          ? `${s.devices_connected} connected · ${s.devices_heard} heard`
          : `${s.clients} clients`,
      help: "Different device addresses. Connected: the device got an association. Heard: a sensor recorded at least one frame from the device. The sensors see many devices only through the replies of the APs.",
    },
    {
      label: "AP radios",
      value: s.radios_on_air ?? s.aps,
      hint:
        s.radios_on_air != null
          ? `${s.radios_expected} planned · ${s.networks} BSSIDs`
          : `${s.aps} BSSIDs`,
      help: "Physical AP radios on the air. One radio sends several networks. Planned: the gaps in the radio numbers. BSSIDs: different network addresses.",
    },
    {
      label: "Throughput",
      value: `${(s.frames_per_s / 1000).toFixed(1)}k/s`,
      hint:
        s.scale?.sensors_per_worker_at_1000_fps != null
          ? `≈ ${s.scale.sensors_per_worker_at_1000_fps} busy sensors / process`
          : `ingest ${s.timing_s.ingest}s · fuse ${s.timing_s.fuse}s · detect ${s.timing_s.detect}s`,
      help: "Frames analysed per second, from start to end, in one process. Busy sensors: a factory channel carries about 1,000 frames/s (Tesla's capture: 78/s, mostly beacons), so capacity is counted per frame, not per sensor.",
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-5 border-b pb-5 sm:grid-cols-4 lg:grid-cols-7">
      {items.map((k) => (
        <div key={k.label} className="min-w-0">
          <div className="text-muted-foreground flex items-center gap-1 text-[10.5px] font-medium tracking-[0.08em] uppercase">
            <span className="truncate">{k.label}</span>
            <Tooltip>
              <TooltipTrigger
                className="hover:text-foreground shrink-0 rounded-sm transition-colors"
                aria-label={`About ${k.label}`}
              >
                <Info className="size-3" />
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">{k.help}</TooltipContent>
            </Tooltip>
          </div>
          <div
            className={cn(
              "truncate text-2xl leading-8 font-light tabular-nums",
              k.tone ?? "text-calm",
            )}
          >
            {k.value}
          </div>
          <div
            className="text-muted-foreground truncate text-[11px]"
            title={k.hint}
          >
            {k.hint}
          </div>
        </div>
      ))}
    </div>
  );
}

// Timeline and RF health follow one replay; the other tabs do not need it
function ReplayTabs({
  result,
  onPick,
  tab,
}: {
  result: Result;
  onPick: (f: Finding) => void;
  tab: Tab;
}) {
  const replay = useReplay(captureEnd(result));
  if (tab !== "timeline" && tab !== "rf") return null;
  return (
    <>
      <TabsContent value="timeline" className="space-y-3 pt-4">
        <TimelineReplay result={result} onPick={onPick} replay={replay} />
      </TabsContent>
      <TabsContent value="rf" className="space-y-3 pt-4">
        <RfHealth result={result} replay={replay} />
      </TabsContent>
    </>
  );
}

function ReplayCard({ replay, result }: { replay: Replay; result: Result }) {
  return (
    <Card className="bg-panel sticky top-16 z-20">
      <CardHeader>
        <CardTitle>Replay</CardTitle>
        <CardDescription>
          The capture plays again at the speed that you select. Drag the track
          to go to a different time.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ReplayBar
          replay={replay}
          result={result}
          startEpoch={result.summary.start_epoch}
        />
      </CardContent>
    </Card>
  );
}

function RfHealth({ result, replay }: { result: Result; replay: Replay }) {
  const chartT = Math.floor(replay.t / 5) * 5;
  const hasRf = result.channel_timeline.some((d) => d.noise_dbm != null);
  const anomalies = result.rf_anomalies ?? [];
  const charts: {
    metric: "noise_dbm" | "snr_db" | "rate_mbps";
    title: string;
    text: string;
  }[] = [
    {
      metric: "noise_dbm",
      title: "Noise floor per channel (dBm)",
      text: "Median noise from the radiotap header of the loudest sensor on each channel. Higher is worse. Amber band: the noise floor of a sensor is 6 dB or more above its baseline.",
    },
    {
      metric: "snr_db",
      title: "Signal-to-noise ratio per channel (dB)",
      text: "Median signal minus noise for the frames on each channel. Lower is worse. Below 20 dB, data rates go down.",
    },
    {
      metric: "rate_mbps",
      title: "Data rate per channel (Mbit/s)",
      text: "Median data rate of the frames with a variable rate. Beacons and other fixed-rate frames are not included. A drop shows retries or bad radio conditions.",
    },
  ];
  return (
    <>
      <ReplayCard replay={replay} result={result} />
      {!hasRf ? (
        <div className="text-muted-foreground rounded-md border border-dashed px-4 py-6 text-sm">
          This analysis has no RF values (noise, SNR, data rate). Run the
          analysis again with the current backend to get them.
        </div>
      ) : (
        <>
          {anomalies.length > 0 && (
            <p className="text-muted-foreground text-xs">
              {anomalies.length} periods with a raised noise floor.{" "}
              {anomalies.filter((a) => a.finding).length} of them became a
              finding.
            </p>
          )}
          <div className="grid gap-3 xl:grid-cols-2">
            {charts.map((c) => (
              <Card
                key={c.metric}
                className={cn(c.metric === "noise_dbm" && "xl:col-span-2")}
              >
                <CardHeader>
                  <CardTitle>{c.title}</CardTitle>
                  <CardDescription>{c.text}</CardDescription>
                </CardHeader>
                <CardContent>
                  <RfChart
                    data={result.channel_timeline}
                    metric={c.metric}
                    anomalies={anomalies}
                    playhead={chartT}
                    onSeek={replay.seek}
                  />
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Retry ratio per channel</CardTitle>
          <CardDescription>
            Share of frames with the retry flag. The loudest sensor on each
            channel gives the value.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ChannelChart
            data={result.channel_timeline}
            metric="retry_ratio"
            playhead={chartT}
            onSeek={replay.seek}
          />
        </CardContent>
      </Card>
    </>
  );
}

// Replay of the capture: the playhead drives the transport bar, "active at playhead" and the incident lanes
function TimelineReplay({
  result,
  onPick,
  replay,
}: {
  result: Result;
  onPick: (f: Finding) => void;
  replay: Replay;
}) {
  const startEpoch = result.summary.start_epoch;
  // charts follow the playhead in 5-s steps (their data resolution) to stay cheap
  const chartT = Math.floor(replay.t / 5) * 5;
  return (
    <>
      <ReplayCard replay={replay} result={result} />
      <Card>
        <CardContent>
          <ReplayNow replay={replay} result={result} onPick={onPick} />
        </CardContent>
      </Card>
      {result.layout && (
        <Card>
          <CardHeader>
            <CardTitle>Site map at the playhead</CardTitle>
            <CardDescription>
              Estimated positions from signal strength. Only incidents that are
              active at the playhead have a colour.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <SiteMap result={result} onPick={onPick} playhead={chartT} />
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Incident timeline</CardTitle>
          <CardDescription>
            One lane for each finding, sorted by severity. A bar shows the time
            in which the sensors recorded the problem. Click a bar to see the
            evidence. Click the axis to go to that time.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <IncidentTimeline
            findings={result.findings}
            duration={result.summary.duration_s}
            startEpoch={startEpoch}
            onPick={onPick}
            playhead={replay.t}
            onSeek={replay.seek}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Management and security events over time</CardTitle>
          <CardDescription>
            Events from all sensors, without duplicates. Shaded bands: critical
            and high findings (click to open). Vertical line: playhead.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <EventTimeline
            data={result.timeline}
            findings={result.findings}
            onPick={onPick}
            playhead={chartT}
            onSeek={replay.seek}
          />
        </CardContent>
      </Card>
      {hasCu(result) && (
        <Card>
          <CardHeader>
            <CardTitle>Channel utilization (QBSS load)</CardTitle>
            <CardDescription>
              The APs report this value in their beacons.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ChannelChart
              data={result.channel_timeline}
              metric="cu_pct"
              playhead={chartT}
              onSeek={replay.seek}
            />
          </CardContent>
        </Card>
      )}
    </>
  );
}

function Sensors({ result }: { result: Result }) {
  const { sensors, overlap, stats } = result.sensors;
  const drift = result.sensors.drift_ppm ?? {};
  const hasDrift = Object.keys(drift).length > 0;
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Sensor overlap (Jaccard)</CardTitle>
          <CardDescription>
            {overlap.every((row, i) => row.every((v, k) => i === k || v === 0))
              ? "No overlap: every sensor listens on its own channel, so no frame is heard twice (de-duplication is skipped). Sensors confirm each other through the same pattern on several channels at once, not through the same frame."
              : "Share of events that both sensors recorded. High overlap: the same area and channel. Gearbox uses it to confirm AP outages and to find transmitters."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="scrollbar-thin overflow-x-auto pb-1">
            <div
              className="inline-grid gap-px"
              style={{
                gridTemplateColumns: `72px repeat(${sensors.length}, minmax(40px, 1fr))`,
              }}
            >
              <div />
              {sensors.map((s) => (
                <div
                  key={s}
                  className="text-muted-foreground truncate pb-1 text-center font-mono text-[11px]"
                >
                  {s.replace("sensor", "s")}
                </div>
              ))}
              {sensors.map((a, i) => (
                <div key={a} className="contents">
                  <div className="text-muted-foreground truncate pr-1 font-mono text-[11px] leading-[30px]">
                    {a}
                  </div>
                  {overlap[i].map((v, k) => (
                    <div
                      key={k}
                      className={cn(
                        "flex h-[30px] items-center justify-center font-mono text-[11px] tabular-nums",
                        v > 0.5
                          ? "font-semibold text-white"
                          : "text-foreground/80",
                      )}
                      style={{
                        background: `rgba(62,106,225,${0.04 + v * 0.8})`,
                      }}
                      title={`${a} ↔ ${sensors[k]}: ${Math.round(v * 100)} %`}
                    >
                      {Math.round(v * 100)}%
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Sensor views</CardTitle>
          <CardDescription>
            Gearbox aligned the sensor clocks before it merged the sensors
            {result.sensors.alignment
              ? ` (method: ${result.sensors.alignment}).`
              : " (method: shared beacons)."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <Th>Sensor</Th>
                <Th className="text-right">Frames</Th>
                <Th>Channels</Th>
                <Th className="text-right">Clock offset</Th>
                {hasDrift && <Th className="text-right">Drift</Th>}
                <Th className="text-right">Heard</Th>
                <Th className="text-right">Only here</Th>
              </TableRow>
            </TableHeader>
            <TableBody>
              {stats.map((s) => (
                <TableRow key={s.sensor}>
                  <TableCell className="font-medium">
                    <span className="font-mono text-xs">{s.sensor}</span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {s.frames.toLocaleString("en")}
                  </TableCell>
                  <TableCell className="text-xs">
                    {s.channels.join(", ")}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">
                    {s.clock_offset_ms} ms
                  </TableCell>
                  {hasDrift && (
                    <TableCell className="text-right font-mono text-xs tabular-nums">
                      {drift[s.sensor] != null
                        ? `${drift[s.sensor] > 0 ? "+" : ""}${drift[s.sensor]} ppm`
                        : "-"}
                    </TableCell>
                  )}
                  <TableCell className="text-right tabular-nums">
                    {Math.round(s.share_of_all_events * 100)}%
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {s.unique_events.toLocaleString("en")}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function Th({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <TableHead
      className={cn(
        "text-muted-foreground bg-card sticky top-0 z-10 h-8 text-xs font-medium",
        className,
      )}
    >
      {children}
    </TableHead>
  );
}

function FindingCount({ n }: { n?: number }) {
  if (!n) return <span className="text-muted-foreground/50">-</span>;
  return (
    <span className="text-warn font-mono text-xs font-medium tabular-nums">
      {n}
    </span>
  );
}

function Network({ result }: { result: Result }) {
  const clients = [...result.clients].sort(
    (a, b) =>
      (b.findings ?? 0) - (a.findings ?? 0) ||
      (a.device_class === "industrial" ? -1 : 1),
  );
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Card className="pb-0">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Access points <CountPill n={result.aps.length} />
          </CardTitle>
          <CardDescription>
            Load: the highest channel utilization that the AP reported.
          </CardDescription>
        </CardHeader>
        <Table containerClassName="scrollbar-thin max-h-[480px] overflow-y-auto border-t">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <Th className="pl-4">BSSID</Th>
              <Th>SSID</Th>
              <Th className="text-right">Ch</Th>
              <Th>Load</Th>
              <Th className="text-right">Devices</Th>
              <Th className="pr-4 text-right">Findings</Th>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.aps.map((a) => {
              const load =
                a.cu_max != null ? Math.round((a.cu_max / 255) * 100) : null;
              return (
                <TableRow key={a.bssid}>
                  <TableCell className="pl-4 font-mono text-xs">
                    {a.bssid}
                  </TableCell>
                  <TableCell className="max-w-40 truncate text-xs">
                    {a.ssid ?? (
                      <span className="text-muted-foreground italic">
                        hidden
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {a.channel ?? "-"}
                  </TableCell>
                  <TableCell>
                    {load != null ? (
                      <span className="flex items-center gap-2">
                        <span className="bg-muted h-1.5 w-12 overflow-hidden">
                          <span
                            className={cn(
                              "block h-full",
                              load > 70
                                ? "bg-tesla"
                                : load > 40
                                  ? "bg-warn"
                                  : "bg-zinc-400",
                            )}
                            style={{ width: `${load}%` }}
                          />
                        </span>
                        <span className="text-xs tabular-nums">{load}%</span>
                      </span>
                    ) : (
                      <span className="text-muted-foreground/50">-</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {a.clients}
                  </TableCell>
                  <TableCell className="pr-4 text-right">
                    <FindingCount n={a.findings} />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Card>
      <Card className="pb-0">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Devices <CountPill n={result.clients.length} />
          </CardTitle>
          <CardDescription>
            Device class from the vendor prefix. Industrial tools come first.
          </CardDescription>
        </CardHeader>
        <Table containerClassName="scrollbar-thin max-h-[480px] overflow-y-auto border-t">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <Th className="pl-4">MAC</Th>
              <Th>Vendor</Th>
              <Th>Class</Th>
              <Th className="text-right">Roams</Th>
              <Th className="pr-4 text-right">Findings</Th>
            </TableRow>
          </TableHeader>
          <TableBody>
            {clients.map((c) => (
              <TableRow key={c.client}>
                <TableCell className="pl-4 font-mono text-xs">
                  {c.client}
                </TableCell>
                <TableCell className="max-w-32 truncate text-xs">
                  {c.vendor}
                </TableCell>
                <TableCell>
                  <span
                    className={cn(
                      "inline-flex items-center gap-1 text-xs",
                      c.device_class === "industrial"
                        ? "text-foreground"
                        : "text-muted-foreground",
                    )}
                  >
                    {c.device_class === "industrial" && (
                      <Cpu className="size-3" />
                    )}
                    {c.device_class}
                  </span>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {c.roams}
                </TableCell>
                <TableCell className="pr-4 text-right">
                  <FindingCount n={c.findings} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
