"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check } from "lucide-react";
import { SeverityDot } from "@/components/severity";
import { ActionChip } from "@/components/action";
import { findingsForMac, findingsForRadio } from "@/components/site-map";
import { HallScene, type LineStop } from "@/components/hall-scene";
import type { Ack, AckState, Acks } from "@/lib/acks";
import {
  SEVERITY_COLOR,
  worstSeverity,
  type Finding,
  type Result,
} from "@/lib/api";
import { byPriority, type Anchor, type Placed } from "@/lib/floor-findings";
import {
  deviceLabel,
  FLOOR,
  placeInWords,
  type FloorAp,
  type FloorDevice,
} from "@/lib/floorplan";
import { cn } from "@/lib/utils";

const KIND_COLOR: Record<FloorDevice["kind"], string> = {
  tool: "#f59e0b",
  laptop: "#60a5fa",
  phone: "#a78bfa",
};
const KIND_LABEL: Record<FloorDevice["kind"], string> = {
  tool: "Tool",
  laptop: "Laptop",
  phone: "Phone",
};

const MAX_OPEN = 3; // callouts open at the same time (a hovered one comes on top)
const CARD_W = 256;
const CARD_H = 150; // upper bound used for placement; cards clamp their text

type Hover =
  | { kind: "ap"; ap: FloorAp; rect: DOMRect }
  | { kind: "device"; device: FloorDevice; rect: DOMRect };

type Rect = { x: number; y: number; w: number; h: number };
type Geom = { w: number; h: number; avoid: Rect[] };

const overlap = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

// Top view of the hall with APs and devices on top, coloured by what goes wrong at the replay
// position. Findings are drawn by reach (lib/floor-findings): device and local problems get a
// callout at their spot, site-wide ones only a thin ring (their text is in the page banner).
export function FloorMap({
  result,
  aps,
  devices,
  active,
  placed,
  acks,
  t,
  stops,
  focus,
  flash,
  onPick,
  onAck,
}: {
  result: Result;
  aps: FloorAp[];
  devices: FloorDevice[];
  active: Finding[];
  placed: Placed[];
  acks: Acks;
  t: number;
  stops?: LineStop[];
  focus: number | null; // finding highlighted from the line-risk rail
  flash: Set<number>; // new critical findings, shown open for a moment
  onPick: (f: Finding) => void;
  onAck: (id: number, state: AckState | null) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [geom, setGeom] = useState<Geom | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const [peek, setPeek] = useState<string | null>(null); // callout opened by hovering its dot
  const peekTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  // screen size plus the floating panels callouts must not cover ([data-floor-avoid])
  useEffect(() => {
    const el = box.current;
    const root = el?.parentElement;
    if (!el || !root) return;
    const panels = [
      ...root.querySelectorAll<HTMLElement>("[data-floor-avoid]"),
    ];
    const measure = () => {
      const r = el.getBoundingClientRect();
      setGeom({
        w: r.width,
        h: r.height,
        avoid: panels
          .map((p) => p.getBoundingClientRect())
          .filter((p) => p.width > 0 && p.height > 0)
          .map((p) => ({
            x: p.left - r.left,
            y: p.top - r.top,
            w: p.width,
            h: p.height,
          })),
      });
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    panels.forEach((p) => ro.observe(p));
    return () => ro.disconnect();
  }, []);

  const onAir = useMemo(
    () => new Set(result.aps.map((a) => a.bssid.toLowerCase())),
    [result.aps],
  );
  const known = useMemo(
    () => new Set(result.clients.map((c) => c.client.toLowerCase())),
    [result.clients],
  );

  const quiet = (f: Finding) => acks[f.id] != null; // acknowledged: no pulse
  const byId = useMemo(
    () => new Map(placed.map((p) => [p.finding.id, p])),
    [placed],
  );

  // per AP: local findings (callout / halo), site-wide ones (thin ring only)
  const apState = useMemo(
    () =>
      aps.map((ap) => {
        const local = placed.filter(
          (p) => p.reach !== "site" && p.aps.includes(ap.num),
        );
        const site = placed.filter(
          (p) => p.reach === "site" && p.aps.includes(ap.num),
        );
        const anchored = local.filter((p) =>
          p.anchors.some(
            (a) => a.kind === "ap" && a.id === ap.num && a.primary,
          ),
        );
        return {
          ap,
          localSev: worstSeverity(
            local.filter((p) => p.reach === "local").map((p) => p.finding),
          ),
          haloSev: worstSeverity(anchored.map((p) => p.finding)),
          pulse: anchored.some((p) => !quiet(p.finding)),
          siteSev: worstSeverity(site.map((p) => p.finding)),
          corp: onAir.has(ap.corp),
          tools: onAir.has(ap.tools),
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [aps, placed, onAir, acks],
  );

  const devState = useMemo(
    () =>
      devices.map((d) => {
        const own = placed.filter(
          (p) => p.reach !== "site" && p.devices.includes(d.mac),
        );
        return {
          d,
          sev: worstSeverity(own.map((p) => p.finding)),
          seen: known.has(d.mac),
        };
      }),
    [devices, placed, known],
  );

  const focused = focus != null ? (byId.get(focus) ?? null) : null;

  // ------------------------------------------------------------ callouts (screen space)
  const s = geom ? Math.max(geom.w / FLOOR.width, geom.h / FLOOR.height) : 1;
  const ox = geom ? (geom.w - FLOOR.width * s) / 2 : 0;
  const oy = geom ? (geom.h - FLOOR.height * s) / 2 : 0;
  const scr = (x: number, y: number) => ({ x: ox + x * s, y: oy + y * s });

  const layout = useMemo(() => {
    if (!geom) return { open: [], dots: [] };
    const anchors = placed.flatMap((p) => p.anchors);
    const rank = (a: Anchor) =>
      a.finding.id === focus ? 0 : flash.has(a.finding.id) ? 1 : 2;
    const primaries = anchors
      .filter((a) => a.primary)
      .sort((a, b) => rank(a) - rank(b) || byPriority(a.finding, b.finding));
    const want = primaries.slice(0, MAX_OPEN);
    const peeked = anchors.find((a) => a.key === peek);
    if (peeked && !want.includes(peeked)) want.push(peeked);

    const taken: Rect[] = [];
    const pad = (r: Rect, p: number) => ({
      x: r.x - p,
      y: r.y - p,
      w: r.w + 2 * p,
      h: r.h + 2 * p,
    });
    const blocked = geom.avoid.map((r) => pad(r, 8));
    const apBoxes = aps.map((ap) => ({
      x: ox + (ap.x - 24) * s,
      y: oy + (ap.y - 28) * s,
      w: 48 * s,
      h: 66 * s,
    }));
    const open: { a: Anchor; card: Rect; p: { x: number; y: number } }[] = [];
    for (const a of want) {
      const p = { x: ox + a.x * s, y: oy + a.y * s };
      const cands: Rect[] = [];
      for (const g of [34, 70, 120, 200, 320]) {
        const gy = g * 0.8;
        cands.push(
          { x: p.x + g, y: p.y - CARD_H / 2, w: CARD_W, h: CARD_H },
          { x: p.x - g - CARD_W, y: p.y - CARD_H / 2, w: CARD_W, h: CARD_H },
          { x: p.x + g * 0.6, y: p.y - gy - CARD_H, w: CARD_W, h: CARD_H },
          {
            x: p.x - g * 0.6 - CARD_W,
            y: p.y - gy - CARD_H,
            w: CARD_W,
            h: CARD_H,
          },
          { x: p.x + g * 0.6, y: p.y + gy, w: CARD_W, h: CARD_H },
          { x: p.x - g * 0.6 - CARD_W, y: p.y + gy, w: CARD_W, h: CARD_H },
          { x: p.x - CARD_W / 2, y: p.y - g - CARD_H, w: CARD_W, h: CARD_H },
          { x: p.x - CARD_W / 2, y: p.y + g + 8, w: CARD_W, h: CARD_H },
        );
      }
      // hard: off screen, panels, other callouts; soft: covering an access point
      let best: Rect | null = null;
      let bestHard = Infinity;
      let bestCost = Infinity;
      for (const c of cands) {
        const inside =
          c.x >= 8 &&
          c.y >= 8 &&
          c.x + c.w <= geom.w - 8 &&
          c.y + c.h <= geom.h - 8;
        const hard =
          (inside ? 0 : 1e7) +
          [...blocked, ...taken].reduce((acc, r) => acc + overlap(c, r), 0);
        const cost =
          hard * 1000 + apBoxes.reduce((acc, r) => acc + overlap(c, r), 0);
        if (cost < bestCost) {
          bestCost = cost;
          bestHard = hard;
          best = c;
          if (cost === 0) break;
        }
      }
      // no free spot: the callout stays a dot, unless the user asked for it
      if (!best || (bestHard > 0 && a.key !== peek && a.finding.id !== focus))
        continue;
      taken.push(pad(best, 6));
      open.push({ a, card: best, p });
    }
    const openKeys = new Set(open.map((o) => o.a.key));
    const dots = anchors.filter((a) => !openKeys.has(a.key));
    return { open, dots };
  }, [geom, placed, focus, flash, peek, ox, oy, s, aps]);

  const keepPeek = () => clearTimeout(peekTimer.current);
  const endPeek = () => {
    clearTimeout(peekTimer.current);
    peekTimer.current = setTimeout(() => setPeek(null), 250);
  };

  const show = (h: Hover) => setHover(h);
  const hide = () => setHover(null);

  return (
    <div ref={box} className="absolute inset-0" onPointerLeave={hide}>
      <svg
        viewBox={`0 0 ${FLOOR.width} ${FLOOR.height}`}
        preserveAspectRatio="xMidYMid slice"
        className="absolute inset-0 h-full w-full select-none"
        role="img"
        aria-label="Top view of the assembly hall with access points and devices"
      >
        <defs>
          <filter id="fm-shadow" x="-50%" y="-50%" width="200%" height="200%">
            <feDropShadow
              dx="0"
              dy="2"
              stdDeviation="2.2"
              floodColor="#000"
              floodOpacity="0.45"
            />
          </filter>
          <radialGradient id="fm-cell">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.10" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* the hall itself; cars and tugger trains move with the replay time */}
        <HallScene t={t} stops={stops} />
        {/* slight dim so the overlay reads on the hall */}
        <rect
          width={FLOOR.width}
          height={FLOOR.height}
          fill="#0b0f14"
          opacity="0.12"
        />

        {/* coverage under everything else: halo only where a local problem is pinned,
            thin rings for the other APs of a local problem and for site-wide problems */}
        {apState.map(
          ({ ap, haloSev, localSev, siteSev, corp, tools, pulse }) => {
            const off = !corp && !tools;
            return (
              <g
                key={`halo-${ap.num}`}
                transform={`translate(${ap.x} ${ap.y})`}
              >
                {haloSev ? (
                  <>
                    <circle
                      r="46"
                      fill={SEVERITY_COLOR[haloSev]}
                      opacity="0.2"
                    />
                    {pulse && (
                      <circle
                        r="20"
                        fill="none"
                        stroke={SEVERITY_COLOR[haloSev]}
                        strokeWidth="2"
                      >
                        <animate
                          attributeName="r"
                          from="20"
                          to="62"
                          dur="2.2s"
                          repeatCount="indefinite"
                        />
                        <animate
                          attributeName="opacity"
                          from="0.8"
                          to="0"
                          dur="2.2s"
                          repeatCount="indefinite"
                        />
                      </circle>
                    )}
                  </>
                ) : localSev ? (
                  <circle
                    r="30"
                    fill="none"
                    stroke={SEVERITY_COLOR[localSev]}
                    strokeWidth="2"
                    opacity="0.8"
                  />
                ) : off ? (
                  <circle
                    r="54"
                    fill="none"
                    stroke="#ef4444"
                    strokeOpacity="0.5"
                    strokeDasharray="6 6"
                  />
                ) : (
                  <circle r="70" fill="url(#fm-cell)" />
                )}
                {siteSev && !haloSev && (
                  <circle
                    r="25"
                    fill="none"
                    stroke={SEVERITY_COLOR[siteSev]}
                    strokeWidth="1.2"
                    opacity="0.6"
                  />
                )}
              </g>
            );
          },
        )}

        {/* devices */}
        {devState.map(({ d, sev, seen }) => {
          const c = KIND_COLOR[d.kind];
          const ring = sev ? SEVERITY_COLOR[sev] : "#ffffff";
          const common = {
            fill: seen ? c : "transparent",
            stroke: seen ? ring : "#f87171",
            strokeWidth: sev ? 3 : 1.6,
            strokeDasharray: seen ? undefined : "3 2",
          };
          return (
            <g
              key={d.mac}
              transform={`translate(${d.x} ${d.y})`}
              filter="url(#fm-shadow)"
              className="cursor-pointer"
              opacity={seen || sev ? 1 : 0.85}
              onPointerEnter={(e) =>
                show({
                  kind: "device",
                  device: d,
                  rect: e.currentTarget.getBoundingClientRect(),
                })
              }
            >
              {sev && <circle r="14" fill={ring} opacity="0.25" />}
              {d.kind === "tool" ? (
                <rect x="-7" y="-7" width="14" height="14" rx="3" {...common} />
              ) : d.kind === "laptop" ? (
                <rect
                  x="-9"
                  y="-6"
                  width="18"
                  height="12"
                  rx="2.5"
                  {...common}
                />
              ) : (
                <rect x="-5" y="-8" width="10" height="16" rx="3" {...common} />
              )}
            </g>
          );
        })}

        {/* access points on top */}
        {apState.map(({ ap, localSev, corp, tools }) => {
          const off = !corp && !tools;
          const stroke = localSev
            ? SEVERITY_COLOR[localSev]
            : off
              ? "#ef4444"
              : "#e4e4e7";
          return (
            <g
              key={ap.num}
              transform={`translate(${ap.x} ${ap.y})`}
              className="cursor-pointer"
              onPointerEnter={(e) =>
                show({
                  kind: "ap",
                  ap,
                  rect: e.currentTarget.getBoundingClientRect(),
                })
              }
            >
              <g filter="url(#fm-shadow)">
                <rect
                  x="-16"
                  y="-16"
                  width="32"
                  height="32"
                  rx="9"
                  fill={off ? "#27272a" : "#f4f4f5"}
                  stroke={stroke}
                  strokeWidth={localSev || off ? 3 : 1.5}
                  strokeDasharray={off ? "5 3" : undefined}
                />
                {/* wifi glyph */}
                <g
                  fill="none"
                  stroke={off ? "#71717a" : "#18181b"}
                  strokeWidth="2"
                  strokeLinecap="round"
                >
                  <path d="M-8,-1 a11,11 0 0 1 16,0" />
                  <path d="M-4.5,3 a6,6 0 0 1 9,0" />
                </g>
                <circle cy="7" r="1.8" fill={off ? "#71717a" : "#18181b"} />
                {/* which networks this AP puts on the air: tools / corp */}
                <circle
                  cx="-6"
                  cy="-21.5"
                  r="3.4"
                  fill={tools ? "#f59e0b" : "#18181b"}
                  stroke={tools ? "none" : "#f87171"}
                  strokeWidth="1.3"
                />
                <circle
                  cx="6"
                  cy="-21.5"
                  r="3.4"
                  fill={corp ? "#60a5fa" : "#18181b"}
                  stroke={corp ? "none" : "#f87171"}
                  strokeWidth="1.3"
                />
              </g>
              <g transform="translate(0 28)">
                <rect
                  x="-22"
                  y="-9"
                  width="44"
                  height="17"
                  rx="8.5"
                  fill="#09090b"
                  opacity="0.82"
                />
                <text
                  y="3.5"
                  textAnchor="middle"
                  className="font-mono"
                  fontSize="10.5"
                  fontWeight="600"
                  fill={
                    localSev
                      ? SEVERITY_COLOR[localSev]
                      : off
                        ? "#f87171"
                        : "#fafafa"
                  }
                >
                  AP {ap.num}
                </text>
              </g>
            </g>
          );
        })}

        {/* 5.2: what a line-risk entry touches, highlighted for a moment */}
        {focused && (
          <g pointerEvents="none">
            {[
              ...aps
                .filter((a) => focused.aps.includes(a.num))
                .map((a) => ({ k: a.num, x: a.x, y: a.y, r: 26 })),
              ...devices
                .filter((d) => focused.devices.includes(d.mac))
                .map((d) => ({ k: d.mac, x: d.x, y: d.y, r: 14 })),
            ].map((m) => (
              <circle
                key={`focus-${m.k}`}
                cx={m.x}
                cy={m.y}
                r={m.r}
                fill="none"
                stroke="#ffffff"
                strokeWidth="3"
              >
                <animate
                  attributeName="r"
                  values={`${m.r};${m.r * 1.6};${m.r}`}
                  dur="1s"
                  repeatCount="indefinite"
                />
                <animate
                  attributeName="opacity"
                  values="1;0.35;1"
                  dur="1s"
                  repeatCount="indefinite"
                />
              </circle>
            ))}
          </g>
        )}
      </svg>

      {/* leader lines from each open callout to its spot */}
      {geom && (
        <svg
          className="pointer-events-none absolute inset-0 h-full w-full"
          aria-hidden="true"
        >
          {layout.open.map(({ a, card, p }) => {
            const cx = Math.min(Math.max(p.x, card.x), card.x + card.w);
            const cy = Math.min(Math.max(p.y, card.y), card.y + card.h);
            const c = SEVERITY_COLOR[a.finding.severity];
            return (
              <g key={`lead-${a.key}`}>
                <line
                  x1={p.x}
                  y1={p.y}
                  x2={cx}
                  y2={cy}
                  stroke={c}
                  strokeWidth="1.5"
                  strokeOpacity="0.9"
                />
                <circle
                  cx={p.x}
                  cy={p.y}
                  r="4"
                  fill={c}
                  stroke="#09090b"
                  strokeWidth="1.5"
                />
              </g>
            );
          })}
        </svg>
      )}

      {/* folded callouts: a pulsing dot that opens on hover */}
      {geom &&
        layout.dots.map((a) => {
          const p = scr(a.x, a.y);
          const d = (a.kind === "ap" ? 17 : 10) * s;
          const c = SEVERITY_COLOR[a.finding.severity];
          return (
            <button
              key={`dot-${a.key}`}
              type="button"
              aria-label={`${a.finding.title} - show details`}
              className="absolute z-[1] flex size-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center"
              style={{ left: p.x + d, top: p.y - d }}
              onPointerEnter={() => {
                keepPeek();
                setPeek(a.key);
              }}
              onPointerLeave={endPeek}
              onFocus={() => setPeek(a.key)}
              onClick={() => onPick(a.finding)}
            >
              {!quiet(a.finding) && (
                <span
                  className="absolute size-3 animate-ping rounded-full opacity-60"
                  style={{ background: c }}
                />
              )}
              <span
                className="relative size-2.5 rounded-full ring-2 ring-zinc-950"
                style={{ background: c }}
              />
            </button>
          );
        })}

      {/* open callouts */}
      {layout.open.map(({ a, card }) => (
        <Callout
          key={`card-${a.key}`}
          anchor={a}
          ack={acks[a.finding.id]}
          where={
            a.kind === "ap"
              ? (() => {
                  const ap = aps.find((x) => x.num === a.id);
                  return ap
                    ? `AP ${ap.num} · ${placeInWords(ap.cell)}`
                    : `AP ${a.id}`;
                })()
              : (() => {
                  const d = devices.find((x) => x.mac === a.id);
                  return d
                    ? `${deviceLabel(d)} · ${placeInWords(d.cell)}`
                    : a.id;
                })()
          }
          highlight={a.finding.id === focus || flash.has(a.finding.id)}
          style={{ left: card.x, top: card.y, width: card.w }}
          onPick={onPick}
          onAck={onAck}
          onEnter={a.key === peek ? keepPeek : undefined}
          onLeave={a.key === peek ? endPeek : undefined}
        />
      ))}

      {hover && (
        <HoverCard
          hover={hover}
          result={result}
          active={active}
          t={t}
          seen={hover.kind === "device" ? known.has(hover.device.mac) : true}
          corp={hover.kind === "ap" ? onAir.has(hover.ap.corp) : false}
          tools={hover.kind === "ap" ? onAir.has(hover.ap.tools) : false}
          onPick={onPick}
          onClose={hide}
        />
      )}
    </div>
  );
}

// Small glass card pinned to one AP or device
function Callout({
  anchor,
  ack,
  where,
  highlight,
  style,
  onPick,
  onAck,
  onEnter,
  onLeave,
}: {
  anchor: Anchor;
  ack: Ack | undefined;
  where: string;
  highlight: boolean;
  style: React.CSSProperties;
  onPick: (f: Finding) => void;
  onAck: (id: number, state: AckState | null) => void;
  onEnter?: () => void;
  onLeave?: () => void;
}) {
  const f = anchor.finding;
  return (
    <div
      className={cn(
        "animate-in fade-in-0 zoom-in-95 absolute z-[2] rounded-[12px] bg-zinc-950/85 p-2.5 text-xs shadow-2xl ring-1 backdrop-blur-xl duration-200",
        highlight ? "ring-white/60" : "ring-white/10",
      )}
      style={style}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
    >
      <div className="text-muted-foreground truncate font-mono text-[10.5px]">
        {where}
      </div>
      <button
        type="button"
        onClick={() => onPick(f)}
        className="mt-1 flex w-full items-start gap-1.5 text-left hover:underline"
      >
        <SeverityDot severity={f.severity} className="mt-[5px]" />
        <span className="line-clamp-2 text-[12.5px] leading-snug font-medium">
          {f.title}
        </span>
      </button>
      {anchor.note && (
        <div className="mt-1 truncate text-[11px] text-red-300">
          {anchor.note}
        </div>
      )}
      {f.action?.supervisor && (
        <p className="text-muted-foreground mt-1 line-clamp-2 text-[11px] leading-snug">
          {f.action.supervisor}
        </p>
      )}
      <div className="mt-2 flex items-center justify-between gap-2">
        <ActionChip finding={f} />
        <AckButton ack={ack} onAck={(state) => onAck(f.id, state)} />
      </div>
    </div>
  );
}

// Acknowledge -> Mark as fixed -> Reopen; shared by callouts, banner and the line-risk rail
export function AckButton({
  ack,
  onAck,
  size = "sm",
}: {
  ack: Ack | undefined;
  onAck: (state: AckState | null) => void;
  size?: "sm" | "xs";
}) {
  const pad = size === "xs" ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs";
  if (!ack)
    return (
      <button
        type="button"
        onClick={() => onAck("ack")}
        className={cn(
          "shrink-0 rounded-md bg-white font-semibold text-zinc-950 hover:bg-zinc-200",
          pad,
        )}
      >
        Acknowledge
      </button>
    );
  if (ack.state === "ack")
    return (
      <button
        type="button"
        onClick={() => onAck("done")}
        className={cn(
          "flex shrink-0 items-center gap-1 rounded-md bg-emerald-500 font-semibold text-zinc-950 hover:bg-emerald-400",
          pad,
        )}
      >
        <Check className="size-3.5" /> Mark as fixed
      </button>
    );
  return null;
}

function HoverCard({
  hover,
  result,
  active,
  t,
  seen,
  corp,
  tools,
  onPick,
  onClose,
}: {
  hover: Hover;
  result: Result;
  active: Finding[];
  t: number;
  seen: boolean;
  corp: boolean;
  tools: boolean;
  onPick: (f: Finding) => void;
  onClose: () => void;
}) {
  const r = hover.rect;
  const left = Math.min(
    Math.max(r.left + r.width / 2, 170),
    window.innerWidth - 170,
  );
  const below = r.top < window.innerHeight / 2;
  const style = below
    ? { left, top: r.bottom + 10 }
    : { left, bottom: window.innerHeight - r.top + 10 };

  let head: React.ReactNode;
  let findings: Finding[];
  if (hover.kind === "ap") {
    const ap = hover.ap;
    findings = findingsForRadio(active, [ap.corp, ap.tools]);
    const info = (b: string) =>
      result.aps.find((a) => a.bssid.toLowerCase() === b);
    const c = info(ap.corp);
    const tl = info(ap.tools);
    const channel = c?.channel ?? tl?.channel ?? ap.channel;
    const sensor = c?.best_sensor ?? tl?.best_sensor;
    const cu = Math.max(c?.cu_max ?? -1, tl?.cu_max ?? -1);
    // retry share on this channel in the time bin at the playhead
    const bin =
      channel == null
        ? undefined
        : result.channel_timeline
            .filter((d) => d.channel === channel && d.t <= t)
            .at(-1);
    head = (
      <>
        <div className="flex items-baseline justify-between gap-3">
          <span className="font-heading font-semibold">
            Access point {ap.num}
          </span>
          <span className="text-muted-foreground text-[11px]">
            {placeInWords(ap.cell)}
          </span>
        </div>
        <div className="text-muted-foreground mt-1 font-mono text-[11px]">
          ch {channel ?? "?"}
          {sensor && ` · heard best by ${sensor}`}
        </div>
        <div className="mt-2 space-y-1 text-[11px]">
          <NetRow
            on={tools}
            label="TESLA-TOOLS"
            color="#f59e0b"
            clients={tl?.clients}
          />
          <NetRow
            on={corp}
            label="TESLA-CORP"
            color="#60a5fa"
            clients={c?.clients}
          />
        </div>
        {(cu >= 0 || bin) && (
          <div className="text-muted-foreground mt-1.5 flex gap-3 text-[11px]">
            {cu >= 0 && <span>channel busy max {Math.round(cu)} %</span>}
            {bin && (
              <span>retries now {Math.round(bin.retry_ratio * 100)} %</span>
            )}
          </div>
        )}
      </>
    );
  } else {
    const d = hover.device;
    findings = findingsForMac(active, d.mac);
    head = (
      <>
        <div className="flex items-baseline justify-between gap-3">
          <span className="font-heading font-semibold">
            <span style={{ color: KIND_COLOR[d.kind] }}>●</span>{" "}
            {deviceLabel(d)}
          </span>
          <span className="text-muted-foreground text-[11px]">
            {KIND_LABEL[d.kind]}
          </span>
        </div>
        <div className="text-muted-foreground mt-1 font-mono text-[11px]">
          {d.mac} · {d.network} · AP {d.ap}
        </div>
        {!seen && (
          <div className="mt-1.5 text-[11px] text-red-300">
            Never connected in this capture
          </div>
        )}
      </>
    );
  }

  return (
    <div
      className="fixed z-[60] w-[320px] -translate-x-1/2 rounded-[12px] bg-zinc-950/90 p-3 text-sm shadow-2xl ring-1 ring-white/10 backdrop-blur-xl"
      style={style}
      onPointerLeave={onClose}
    >
      {head}
      <div className="mt-2.5 border-t border-white/10 pt-2">
        {findings.length === 0 ? (
          <p className="text-muted-foreground text-xs">
            Nothing going wrong here right now.
          </p>
        ) : (
          <ul className="space-y-1">
            {findings.slice(0, 4).map((f) => (
              <li key={f.id}>
                <button
                  type="button"
                  onClick={() => onPick(f)}
                  className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs hover:bg-white/5"
                >
                  <SeverityDot severity={f.severity} />
                  <span className="min-w-0 flex-1 truncate">{f.title}</span>
                  <ActionChip finding={f} compact />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function NetRow({
  on,
  label,
  color,
  clients,
}: {
  on: boolean;
  label: string;
  color: string;
  clients?: number;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span
        className="inline-flex items-center gap-1.5"
        style={
          on ? undefined : { color: "#fca5a5", textDecoration: "line-through" }
        }
      >
        <span
          className="size-1.5 rounded-full"
          style={{ background: on ? color : "#f87171" }}
        />
        {label}
      </span>
      <span className={on ? "text-muted-foreground" : "text-red-300"}>
        {on
          ? `on the air · ${clients ?? 0} device${clients === 1 ? "" : "s"}`
          : "not on the air"}
      </span>
    </div>
  );
}
