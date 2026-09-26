import { ArrowRight } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const STAGES = [
  {
    name: "1 · Edge ingest",
    where: "on every sensor",
    key: "per sensor",
    what: "tshark/libpcap dissects 802.11 + 802.1X headers on the sensor and emits compact header events (~60 bytes instead of full frames). Raw pcap stays in a ring buffer on the sensor, pulled only on demand.",
    tech: "Rust or Go agent, protobuf, mTLS",
  },
  {
    name: "2 · Event bus",
    where: "site cluster",
    key: "partition = transmitter MAC",
    what: "All sensors publish to one topic per site. Partitioning by transmitter MAC puts every copy of the same frame (heard by several sensors) into the same partition - fusion needs no cross-node traffic.",
    tech: "Kafka / Redpanda",
  },
  {
    name: "3 · Fusion",
    where: "stream workers",
    key: "per TA, 10 ms window",
    what: "Clock alignment from shared beacons (continuously re-estimated), de-duplication into one air event with RSSI per sensor → location estimate. Exactly the code that runs in this prototype, just windowed.",
    tech: "Flink or Python (Bytewax/Faust) workers",
  },
  {
    name: "4 · Sequence detectors",
    where: "stateful stream jobs",
    key: "per client / BSSID / channel",
    what: "Per-client state machines (auth → assoc → EAP → 4-way → connected), AP beacon watchdogs confirmed by ≥2 sensors, channel load windows, security rules. State is small per key, so it shards linearly.",
    tech: "Flink keyed state, RocksDB",
  },
  {
    name: "5 · Store & serve",
    where: "central",
    key: "time-partitioned",
    what: "Events and findings in a columnar time-series store for drill-down and trends; findings + device inventory in Postgres; dashboard and API as today.",
    tech: "ClickHouse / TimescaleDB, Postgres, FastAPI, Next.js",
  },
  {
    name: "6 · Alert & act",
    where: "central",
    key: "per area / device class",
    what: "Routing by device class and location: torque tool on line 3 fails its handshake → line lead's phone within seconds; canteen congestion → IT ticket. AI explanation attached. Deduplicated per root cause, not per frame.",
    tech: "Alertmanager, Teams/SMS, ServiceNow",
  },
];

// measured on the Tesla captures (8 sensors, 30 min) on one laptop worker
const NUMBERS = [
  {
    k: "One process",
    v: "≥ 12k frames/s",
    d: "full pipeline on the server, measured before de-dup was skipped for one-sensor-per-channel layouts",
    tag: "measured",
  },
  {
    k: "Per sensor",
    v: "78 frames/s",
    d: "Tesla's capture: 82 % beacons, 0.24 % data. A busy factory channel: 1,000–5,000 frames/s",
    tag: "measured",
  },
  {
    k: "Busy sensors per process",
    v: "≈ 6–12",
    d: "at 1,000–2,000 frames/s per sensor. Beacon summaries do not help here: the load is data and ACK headers",
    tag: "derived",
  },
  {
    k: "2,000-sensor site",
    v: "≈ 170–330 cores",
    d: "keyed by transmitter MAC. Next factor: counters per client on the sensor instead of every header",
    tag: "derived",
  },
];

const KEYS = [
  { k: "sensor", d: "ingest, clock alignment" },
  { k: "transmitter MAC", d: "fusion, de-duplication" },
  { k: "client / AP / channel", d: "detectors, incidents" },
];

export default function Architecture() {
  return (
    <div className="max-w-6xl space-y-5">
      <div className="space-y-1 border-b pb-3">
        <h1 className="text-base font-semibold">Scale design</h1>
        <p className="text-muted-foreground max-w-3xl text-xs leading-relaxed">
          The prototype runs as keyed stages: ingest per sensor, fusion per
          transmitter MAC, detection per client / AP / channel. The keys and
          the state per key carry over from today&apos;s batch run to a
          partitioned stream. The detectors do not carry over unchanged: today
          they read the whole capture (end-of-capture checks, medians over
          everything); as stream jobs they need time windows, watermarks for
          late frames (sensor clocks are up to 1.2 s off) and state that
          expires. Incidents that span many APs run as one small global stage
          on per-key summaries.
        </p>
      </div>

      <section className="bg-card rounded-md border">
        <div className="border-b px-3 py-2 text-[13px] font-semibold">
          Partition keys
        </div>
        <ol className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center">
          {KEYS.map((k, i) => (
            <li key={k.k} className="flex items-center gap-2">
              {i > 0 && (
                <ArrowRight className="text-muted-foreground hidden size-3.5 sm:block" />
              )}
              <span className="font-mono text-xs">{k.k}</span>
              <span className="text-muted-foreground text-xs">({k.d})</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="space-y-1.5">
        <div className="bg-border grid grid-cols-2 gap-px overflow-hidden rounded-md border lg:grid-cols-4">
          {NUMBERS.map((n) => (
            <div key={n.k} className="bg-card space-y-0.5 px-3 py-2">
              <div className="text-muted-foreground flex items-center justify-between gap-2 text-xs">
                {n.k}
                <span className="font-mono text-[10px]">{n.tag}</span>
              </div>
              <div className="text-xl font-semibold tabular-nums">{n.v}</div>
              <div className="text-muted-foreground text-[11px] leading-snug">
                {n.d}
              </div>
            </div>
          ))}
        </div>
        <p className="text-muted-foreground text-[11px]">
          Measured: the prototype on Tesla&apos;s 8 captures (30 minutes, ≈ 1.1
          M frames) on one laptop. Derived: the same rate divided across
          sensors, with beacons summarised on the sensor instead of sent one by
          one.
        </p>
      </section>

      <section className="bg-card overflow-hidden rounded-md border">
        <div className="flex items-baseline justify-between gap-4 border-b px-3 py-2">
          <h2 className="text-[13px] font-semibold">Pipeline</h2>
          <span className="text-muted-foreground hidden text-xs sm:block">
            6 keyed stages, each shards independently
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-xs">
            <thead className="text-muted-foreground border-b">
              <tr>
                <th className="w-8 px-3 py-1.5 font-medium">#</th>
                <th className="px-3 py-1.5 font-medium">Stage</th>
                <th className="px-3 py-1.5 font-medium">Runs</th>
                <th className="px-3 py-1.5 font-medium">Key</th>
                <th className="px-3 py-1.5 font-medium">What it does</th>
                <th className="px-3 py-1.5 font-medium">Tech</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {STAGES.map((s) => {
                const [num, name] = s.name.split(" · ");
                return (
                  <tr key={s.name} className="align-top">
                    <td className="text-muted-foreground px-3 py-2 font-mono">
                      {num}
                    </td>
                    <td className="px-3 py-2 font-medium whitespace-nowrap">
                      {name}
                    </td>
                    <td className="text-muted-foreground px-3 py-2 whitespace-nowrap">
                      {s.where}
                    </td>
                    <td className="px-3 py-2 font-mono whitespace-nowrap">
                      {s.key}
                    </td>
                    <td className="text-foreground/85 px-3 py-2 leading-relaxed">
                      {s.what}
                    </td>
                    <td className="text-muted-foreground px-3 py-2">
                      {s.tech}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid gap-3 lg:grid-cols-2">
        <PointsCard
          title="Sensor lifecycle"
          description="Thousands of sensors are managed as a fleet."
          points={[
            [
              "Registry",
              "every sensor has an identity (certificate), location, channel plan and firmware version in one inventory.",
            ],
            [
              "Zero-touch onboarding",
              "sensor boots, enrols via mTLS, pulls its config (channels, area, filters) as code from Git.",
            ],
            [
              "Signed OTA updates in waves",
              "canary (1 %) → one hall → site → all sites, automatic rollback if heartbeat, event rate or clock sync degrade.",
            ],
            [
              "Self-monitoring",
              'the same fusion that finds bad APs finds bad sensors - a sensor that stops hearing what its neighbours hear is flagged (see "sensor blind spot" findings).',
            ],
          ]}
        />
        <PointsCard
          title="Design choices"
          description="What keeps the path to production short."
          points={[
            [
              "Edge first",
              "headers only, aggregated on the sensor → 10-100x less backhaul, no payload leaves the sensor (privacy, works council).",
            ],
            [
              "Key by transmitter",
              "duplicates from overlapping sensors (same channel) meet in one partition - fusion is local, horizontally scalable. With one sensor per channel there are no duplicates and fusion only aligns the clocks.",
            ],
            [
              "Findings, not frames",
              "alerts are per root cause (AP down, handshake broken) and per device class: 3 alerts for the line lead instead of 30,000 frames.",
            ],
            [
              "Same keys batch and stream",
              "the partitioning and the per-key state carry over; each detector becomes a windowed stream job with a watermark.",
            ],
          ]}
        />
      </div>
    </div>
  );
}

function PointsCard({
  title,
  description,
  points,
}: {
  title: string;
  description: string;
  points: [string, string][];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="space-y-2 text-xs">
          {points.map(([k, v]) => (
            <div key={k}>
              <dt className="text-foreground font-medium">{k}</dt>
              <dd className="text-muted-foreground leading-relaxed">{v}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}
