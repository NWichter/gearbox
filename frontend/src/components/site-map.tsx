"use client";

import { useMemo, useState } from "react";
import {
  SEVERITY_COLOR,
  worstFinding,
  type Finding,
  type Result,
  type Severity,
} from "@/lib/api";
import { cn } from "@/lib/utils";

const PAD = 6; // metres around the outermost point
// indoor signal strength varies by about this much for the same distance (walls, metal, people)
const SHADOW_DB = 6;

type View = "zones" | "layout";

// Findings that touch a device: the finding's own client or one of its affected devices
export function findingsForMac(findings: Finding[], mac: string) {
  const m = mac.toLowerCase();
  return findings.filter(
    (f) =>
      f.client?.toLowerCase() === m ||
      f.affected?.some(
        (a) => typeof a.client === "string" && a.client.toLowerCase() === m,
      ),
  );
}

// A missing-BSSID entry names one network ("00:0b:86:03:00:00 (TESLA-CORP, ch 40)") or a whole
// radio ("00:0b:86:0d:00:xx (whole radio silent)")
function missingMatches(entry: string, bssid: string) {
  const m = entry.toLowerCase();
  if (m.includes(bssid)) return true;
  const mac = m.split(/\s/)[0];
  return mac.endsWith("xx") && bssid.startsWith(mac.slice(0, -2));
}

// Findings that touch an AP radio: one of its BSSIDs, a device on it, or a missing BSSID
export function findingsForRadio(findings: Finding[], bssids: string[]) {
  const set = new Set(bssids.map((b) => b.toLowerCase()));
  return findings.filter(
    (f) =>
      (f.bssid && set.has(f.bssid.toLowerCase())) ||
      f.missing_bssids?.some((m) =>
        [...set].some((b) => missingMatches(m, b)),
      ) ||
      f.affected?.some(
        (a) =>
          (typeof a.bssid === "string" && set.has(a.bssid.toLowerCase())) ||
          (typeof a.ap === "string" && set.has(a.ap.toLowerCase())),
      ),
  );
}

const worst = (fs: Finding[]) => worstFinding(fs, true);

type Hover = { x: number; y: number; lines: string[] } | null;

// Loudest sensor = the location statement that survives walls and calibration errors
function loudest(
  rssi: Record<string, number> | undefined,
  heard: string[],
  p: { x: number; y: number },
  sensors: { id: string; x: number; y: number }[],
): { sensor: string; rssi: number | null } | null {
  const entries = Object.entries(rssi ?? {});
  if (entries.length) {
    const [id, r] = entries.reduce((a, b) => (b[1] > a[1] ? b : a));
    return { sensor: id, rssi: r };
  }
  // older analyses: nearest hearing sensor on the map
  const pool = sensors.filter((s) => !heard.length || heard.includes(s.id));
  if (!pool.length) return null;
  const s = pool.reduce((a, b) =>
    Math.hypot(b.x - p.x, b.y - p.y) < Math.hypot(a.x - p.x, a.y - p.y) ? b : a,
  );
  return { sensor: s.id, rssi: null };
}

// Ring between the distances for rssi +/- SHADOW_DB: where the transmitter may really be
function ringPath(cx: number, cy: number, r0: number, r1: number) {
  const c = (r: number) =>
    `M ${cx - r} ${cy} a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0 Z`;
  return `${c(r1)} ${c(r0)}`;
}

const short = (id: string) => `S${id.replace(/\D/g, "").replace(/^0/, "")}`;

// Relative site map: sensors, AP radios and devices placed by signal strength (not a floor plan)
export function SiteMap({
  result,
  onPick,
  playhead,
}: {
  result: Result;
  onPick: (f: Finding) => void;
  // when set, only findings active at this moment colour the map
  playhead?: number;
}) {
  const layout = result.layout;
  const [hover, setHover] = useState<Hover>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [view, setView] = useState<View>("zones");
  const [hot, setHot] = useState<string | null>(null);

  const findings = useMemo(
    () =>
      playhead == null
        ? result.findings
        : result.findings.filter(
            (f) => f.t_start <= playhead && f.t_end + 5 >= playhead,
          ),
    [result.findings, playhead],
  );

  const box = useMemo(() => {
    if (!layout) return null;
    const pts = [...layout.sensors, ...layout.aps, ...layout.devices];
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const x0 = Math.min(...xs) - PAD;
    const y0 = Math.min(...ys) - PAD;
    return {
      x0,
      y0,
      w: Math.max(...xs) + PAD - x0,
      h: Math.max(...ys) + PAD - y0,
    };
  }, [layout]);

  if (!layout || !box)
    return (
      <div className="text-muted-foreground rounded-sm border border-dashed px-3 py-4 text-xs">
        No position estimate for this analysis yet - re-analyse the dataset.
      </div>
    );

  const k = box.w / 100; // symbol size scales with the map
  const zones = view === "zones";
  const devs = layout.devices.map((d) => {
    const f = worst(findingsForMac(findings, d.mac));
    return { ...d, f, zone: loudest(d.rssi, d.sensors, d, layout.sensors) };
  });
  const aps = layout.aps.map((a) => ({
    ...a,
    f: worst(findingsForRadio(findings, a.bssids)),
    zone: loudest(a.rssi, [], a, layout.sensors),
  }));
  const color = (s: Severity | undefined) =>
    s ? SEVERITY_COLOR[s] : "#71717a";
  const sensorAt = (id: string) => layout.sensors.find((s) => s.id === id);
  const toM = (rssi: number) =>
    10 **
    ((layout.model.p0_dbm - rssi) / (10 * layout.model.path_loss_exponent));
  // uncertainty ring around the loudest sensor of the hovered device / AP
  const ring = (() => {
    const p =
      devs.find((d) => d.mac === hot) ?? aps.find((a) => a.radio === hot);
    const s = p?.zone ? sensorAt(p.zone.sensor) : undefined;
    if (!p?.zone || !s) return null;
    if (p.zone.rssi != null)
      return {
        s,
        r0: toM(p.zone.rssi + SHADOW_DB),
        r1: toM(p.zone.rssi - SHADOW_DB),
      };
    const d = Math.hypot(p.x - s.x, p.y - s.y);
    const f = 10 ** (SHADOW_DB / (10 * layout.model.path_loss_exponent));
    return { s, r0: d / f, r1: d * f };
  })();
  const ties = [
    ...devs.map((d) => ({ id: d.mac, p: d, dash: false })),
    ...aps.map((a) => ({ id: a.radio, p: a, dash: true })),
  ];
  const zoneRows = layout.sensors.map((s) => {
    const ds = devs.filter((d) => d.zone?.sensor === s.id);
    const as = aps.filter((a) => a.zone?.sensor === s.id);
    const bad = [...ds, ...as].flatMap((x) => (x.f ? [x.f] : []));
    return { s, ds, as, bad, f: worst(bad) };
  });
  const dim = (id: string, sensors?: string[]) =>
    focus != null && focus !== id && !(sensors ?? []).includes(focus);

  const tip = (e: React.MouseEvent, lines: string[]) => {
    const r = (
      e.currentTarget.closest("svg") as SVGSVGElement
    ).getBoundingClientRect();
    setHover({ x: e.clientX - r.left, y: e.clientY - r.top, lines });
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <div className="bg-muted inline-flex rounded-sm p-0.5">
          {(
            [
              ["zones", "Zones (what the air can tell)"],
              ["layout", "Estimated layout"],
            ] as [View, string][]
          ).map(([v, label]) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={cn(
                "rounded-sm px-2.5 py-1 transition-colors",
                view === v
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="text-muted-foreground">
          {zones
            ? "Same map, careful reading: the sensor near each device, and the uncertainty of the rest."
            : "Best-fit positions from signal strength (metres under a textbook model)."}
        </span>
      </div>
      <div className="relative overflow-hidden rounded-sm border bg-zinc-50 dark:bg-black/20">
        <svg
          viewBox={`${box.x0} ${box.y0} ${box.w} ${box.h}`}
          className="aspect-[4/3] max-h-[560px] w-full sm:aspect-[21/9]"
          onMouseLeave={() => setHover(null)}
          role="img"
          aria-label="Estimated relative positions of sensors, access points and devices"
        >
          {/* 10 m grid - estimated layout only; the zone view makes no metric claim */}
          {!zones &&
            Array.from({ length: Math.ceil(box.w / 10) + 1 }, (_, i) => {
              const x = Math.floor(box.x0 / 10) * 10 + i * 10;
              return (
                <line
                  key={`gx${i}`}
                  x1={x}
                  x2={x}
                  y1={box.y0}
                  y2={box.y0 + box.h}
                  className="stroke-black/[0.06] dark:stroke-white/[0.04]"
                  strokeWidth={k * 0.15}
                />
              );
            })}
          {!zones &&
            Array.from({ length: Math.ceil(box.h / 10) + 1 }, (_, i) => {
              const y = Math.floor(box.y0 / 10) * 10 + i * 10;
              return (
                <line
                  key={`gy${i}`}
                  y1={y}
                  y2={y}
                  x1={box.x0}
                  x2={box.x0 + box.w}
                  className="stroke-black/[0.06] dark:stroke-white/[0.04]"
                  strokeWidth={k * 0.15}
                />
              );
            })}

          {/* zone view: every device and AP tied to its loudest sensor (its zone) */}
          {zones &&
            ties.map(({ id, p, dash }) => {
              const s = p.zone ? sensorAt(p.zone.sensor) : undefined;
              if (!s) return null;
              const off = focus != null && focus !== s.id;
              return (
                <line
                  key={`z${id}`}
                  x1={s.x}
                  y1={s.y}
                  x2={p.x}
                  y2={p.y}
                  stroke={p.f ? color(p.f.severity) : "var(--foreground)"}
                  strokeOpacity={off ? 0.04 : p.f ? 0.45 : 0.12}
                  strokeWidth={k * 0.2}
                  strokeDasharray={dash ? `${k * 0.6} ${k * 0.5}` : undefined}
                />
              );
            })}
          {zones && ring && (
            <path
              d={ringPath(ring.s.x, ring.s.y, ring.r0, ring.r1)}
              pointerEvents="none"
              fillRule="evenodd"
              fill="rgba(56,189,248,0.10)"
              stroke="rgba(56,189,248,0.45)"
              strokeWidth={k * 0.15}
              strokeDasharray={`${k * 0.8} ${k * 0.6}`}
            />
          )}

          {/* links: which sensors heard a device (only for the focused sensor) */}
          {focus &&
            devs
              .filter((d) => d.sensors.includes(focus))
              .map((d) => {
                const s = layout.sensors.find((x) => x.id === focus)!;
                return (
                  <line
                    key={`l${d.mac}`}
                    x1={s.x}
                    y1={s.y}
                    x2={d.x}
                    y2={d.y}
                    stroke="var(--foreground)"
                    strokeOpacity={0.2}
                    strokeWidth={k * 0.2}
                  />
                );
              })}

          {/* devices */}
          {devs.map((d) => {
            // one sensor = a distance but no direction: hollow in the zone view
            const lone = zones && d.sensors.length <= 1;
            return (
              <circle
                key={d.mac}
                cx={d.x}
                cy={d.y}
                r={k * (d.f ? 0.9 : 0.6)}
                fill={lone ? "transparent" : color(d.f?.severity)}
                stroke={lone ? color(d.f?.severity) : undefined}
                strokeWidth={lone ? k * 0.3 : undefined}
                opacity={dim("", d.sensors) ? 0.12 : d.f ? 0.95 : 0.55}
                className={cn(d.f && "cursor-pointer")}
                onClick={() => d.f && onPick(d.f)}
                onMouseEnter={() => setHot(d.mac)}
                onMouseLeave={() => setHot(null)}
                onMouseMove={(e) =>
                  tip(
                    e,
                    zones
                      ? [
                          `Device ${d.mac}`,
                          d.zone
                            ? `near ${short(d.zone.sensor)} (loudest${d.zone.rssi != null ? `, ${d.zone.rssi} dBm` : ""})`
                            : "zone unknown",
                          d.sensors.length <= 1
                            ? "heard by one sensor: distance only, direction unknown"
                            : `heard by ${d.sensors.length} sensors: rough position`,
                          `blue ring: where it may really be (±${SHADOW_DB} dB)`,
                          d.f ? d.f.title : "no problem found",
                        ]
                      : [
                          `Device ${d.mac}`,
                          `heard by ${d.sensors.join(", ")}`,
                          d.f ? d.f.title : "no problem found",
                        ],
                  )
                }
              />
            );
          })}

          {/* AP radios */}
          {aps.map((a) => (
            <g
              key={a.radio}
              className={cn(a.f && "cursor-pointer")}
              opacity={focus ? 0.35 : 1}
              onClick={() => a.f && onPick(a.f)}
              onMouseEnter={() => setHot(a.radio)}
              onMouseLeave={() => setHot(null)}
              onMouseMove={(e) =>
                tip(e, [
                  `${a.label} (one radio)`,
                  `networks: ${a.ssids.join(" + ")}`,
                  ...(zones
                    ? [
                        a.zone
                          ? `near ${short(a.zone.sensor)}`
                          : "zone unknown",
                        "only the sensor on its channel hears it: rough position",
                      ]
                    : []),
                  a.f ? a.f.title : "no problem found",
                ])
              }
            >
              <path
                d={`M ${a.x} ${a.y - k * 1.6} L ${a.x + k * 1.4} ${a.y + k * 1.0} L ${a.x - k * 1.4} ${a.y + k * 1.0} Z`}
                fill={a.f ? color(a.f.severity) : "#a1a1aa"}
                fillOpacity={a.f ? 0.9 : 0.55}
                stroke="var(--background)"
                strokeWidth={k * 0.15}
              />
              <text
                x={a.x}
                y={a.y + k * 3.2}
                textAnchor="middle"
                fontSize={k * 1.7}
                fill="var(--muted-foreground)"
              >
                {a.label.replace("AP ", "")}
              </text>
            </g>
          ))}

          {/* sensors */}
          {layout.sensors.map((s) => (
            <g
              key={s.id}
              className="cursor-pointer"
              onClick={() => setFocus((f) => (f === s.id ? null : s.id))}
              onMouseMove={(e) =>
                tip(e, [
                  `${s.id} · channel ${s.channel ?? "?"}`,
                  `hears ${devs.filter((d) => d.sensors.includes(s.id)).length} devices`,
                  "click: show which devices it hears",
                ])
              }
            >
              <rect
                x={s.x - k * 1.6}
                y={s.y - k * 1.6}
                width={k * 3.2}
                height={k * 3.2}
                rx={k * 0.2}
                fill={focus === s.id ? "var(--calm)" : "var(--foreground)"}
                stroke="var(--background)"
                strokeWidth={k * 0.35}
              />
              <text
                x={s.x}
                y={s.y - k * 2.4}
                textAnchor="middle"
                fontSize={k * 2}
                fontWeight={600}
                fill="var(--foreground)"
              >
                S{s.id.replace(/\D/g, "").replace(/^0/, "")}
              </text>
            </g>
          ))}
        </svg>

        {hover && (
          <div
            className="bg-popover text-popover-foreground pointer-events-none absolute z-10 max-w-72 rounded-md border px-2.5 py-1.5 text-xs shadow-lg"
            style={{ left: hover.x + 12, top: hover.y + 12 }}
          >
            <div className="font-medium">{hover.lines[0]}</div>
            {hover.lines.slice(1).map((l) => (
              <div key={l} className="text-muted-foreground">
                {l}
              </div>
            ))}
          </div>
        )}
        <div className="text-muted-foreground absolute right-3 bottom-2 font-mono text-[10px]">
          {zones
            ? "not to scale · rotation and mirror arbitrary"
            : "grid 10 m (estimated)"}
        </div>
      </div>

      <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <span className="flex items-center gap-1.5">
          <span className="bg-foreground size-2.5 rounded-[1px]" /> Sensor (click
          to show what it hears)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-0 border-x-[5px] border-b-[9px] border-x-transparent border-b-zinc-400" />{" "}
          Access point radio (one box, all its networks)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-zinc-500" /> Device
        </span>
        {zones && (
          <>
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-full border-2 border-zinc-500" />{" "}
              Heard by one sensor (direction unknown)
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-px w-4 bg-zinc-400" /> Tie to loudest sensor
              (its zone)
            </span>
            <span className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-full border border-dashed border-sky-400 bg-sky-400/10" />{" "}
              Hover: where it may really be
            </span>
          </>
        )}
        {(["critical", "high", "medium"] as Severity[]).map((s) => (
          <span key={s} className="flex items-center gap-1.5">
            <span
              className="size-2 rounded-full"
              style={{ background: SEVERITY_COLOR[s] }}
            />{" "}
            {s}
          </span>
        ))}
      </div>
      {zones && (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {zoneRows.map((z) => (
            <div
              key={z.s.id}
              role="button"
              tabIndex={0}
              onClick={() => setFocus((f) => (f === z.s.id ? null : z.s.id))}
              onKeyDown={(e) =>
                e.key === "Enter" &&
                setFocus((f) => (f === z.s.id ? null : z.s.id))
              }
              className={cn(
                "cursor-pointer rounded-sm border p-2.5 text-xs transition-colors",
                focus === z.s.id ? "border-foreground" : "hover:bg-muted/50",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">
                  Near {short(z.s.id)} · ch {z.s.channel ?? "?"}
                </span>
                {z.f && (
                  <span
                    className="size-2 shrink-0 rounded-full"
                    style={{ background: color(z.f.severity) }}
                  />
                )}
              </div>
              <div className="text-muted-foreground mt-0.5">
                {z.ds.length} devices · {z.as.length} AP radios
                {z.bad.length > 0 && ` · ${z.bad.length} with a problem`}
              </div>
              {z.f && (
                <button
                  type="button"
                  className="mt-1 line-clamp-2 text-left underline-offset-2 hover:underline"
                  onClick={(e) => {
                    e.stopPropagation();
                    onPick(z.f!);
                  }}
                >
                  {z.f.title}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {zones ? (
        <p className="text-muted-foreground text-xs leading-relaxed">
          What the air can tell without a floor plan: the{" "}
          <strong>loudest sensor</strong> is a robust &quot;near here&quot; -
          walls and metal change how loud a signal is, but rarely which sensor
          hears it best. Distances are not robust: indoors the same distance
          varies by about ±{SHADOW_DB} dB, so a device the model puts at 30 m
          may be anywhere from about 19 to 48 m away (hover it to see the ring).
          Devices heard by one sensor have a distance but no direction, and
          access points are heard only by the sensor on their own channel. The
          map&apos;s rotation and mirror image are arbitrary. With the mounting
          positions of sensors and APs (the site&apos;s asset list) each zone
          becomes a real place: &quot;AP 09, station 5&quot;.
        </p>
      ) : (
        <p className="text-muted-foreground text-xs leading-relaxed">
          Relative positions, not a floor plan. Log-distance model,{" "}
          {layout.model.p0_dbm} dBm at 1 m, exponent{" "}
          {layout.model.path_loss_exponent}. Devices scan on every channel, so
          several sensors hear the same device; that links the single-channel
          sensors. Known sensor positions on a floor plan would give absolute
          coordinates.
        </p>
      )}
    </div>
  );
}
