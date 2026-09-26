"use client";

import { memo } from "react";
import type { LineId } from "@/lib/floorplan";

/*
 * Vector drawing of the assembly hall in a 1376 x 768 coordinate space; AP and device
 * positions in lib/floorplan.ts use the same space.
 *
 * Everything that moves is a pure function of the replay time t (seconds into the capture):
 * cars advance one pitch per takt, so playing, scrubbing and any replay speed look right
 * without extra state. Lines run as a serpentine: line 1 left to right, line 2 right to
 * left, line 3 left to right into the exit.
 *
 * Backend hook: pass `stops` (e.g. while a line-stopping finding is active) and the
 * affected line stands still for that time; the cars' positions stay consistent when
 * scrubbing because the stop time is simply subtracted from t.
 */

export const TAKT_S = 60; // one car per minute leaves the line (Tesla, challenge briefing)
const PITCH = 220; // distance between two cars on a line, px

export type { LineId };
export type LineStop = { line: LineId; from: number; to: number };

type LineSpec = {
  id: LineId;
  y: number;
  x0: number;
  x1: number;
  dir: 1 | -1;
  phase: number; // x of one car at t = 0
  kind: "body" | "final";
};

const LINES: LineSpec[] = [
  { id: "L1", y: 155, x0: 40, x1: 1335, dir: 1, phase: 265, kind: "body" },
  { id: "L2", y: 385, x0: 40, x1: 1335, dir: -1, phase: 270, kind: "body" },
  { id: "L3", y: 627, x0: 40, x1: 1285, dir: 1, phase: 480, kind: "final" },
];

const mod = (a: number, n: number) => ((a % n) + n) % n;

// Seconds the line actually ran up to t (stop intervals are taken out)
export function runTime(t: number, stops: LineStop[], line: LineId) {
  let s = t;
  for (const st of stops)
    if (st.line === line) s -= Math.max(0, Math.min(t, st.to) - st.from);
  return s;
}

function isStopped(t: number, stops: LineStop[], line: LineId) {
  return stops.some((s) => s.line === line && s.from <= t && t < s.to);
}

const C = {
  frame: "#353b42",
  floor: "#9aa0a5",
  floorDark: "#8b9196",
  lane: "#a4aaaf",
  yellow: "#d8b23a",
  belt: "#3a3f45",
  roller: "#50575e",
  rail: "#c3c8cd",
  hanger: "#d23a2f",
  hangerHi: "#ee5a4b",
  bench: "#4b5157",
  benchTop: "#5d646b",
  box: "#c9cdd1",
  boxSide: "#b0b5ba",
  label: "#1d2227",
  shelf: "#5a6168",
  glass: "#7fa89a",
};

export function HallScene({ t, stops = [] }: { t: number; stops?: LineStop[] }) {
  return (
    <g>
      <StaticHall />
      {LINES.map((l) => (
        <MovingLine key={l.id} line={l} run={runTime(t, stops, l.id)} stopped={isStopped(t, stops, l.id)} />
      ))}
      <Tugger y={270} dir={-1} t={t} phase={900} />
      <Tugger y={503} dir={1} t={t} phase={300} />
    </g>
  );
}

// ---------------------------------------------------------------- moving parts

function MovingLine({ line, run, stopped }: { line: LineSpec; run: number; stopped: boolean }) {
  const shift = (run / TAKT_S) * PITCH * line.dir;
  const span = line.x1 - line.x0 + 2 * 90;
  const slots = Math.ceil(span / PITCH);
  const wrap = slots * PITCH;
  const start = line.x0 - 90;
  const clip = `clip-${line.id}`;
  const cars = Array.from({ length: slots }, (_, k) => {
    const x = start + mod(line.phase - start + k * PITCH + shift, wrap);
    return { k, x };
  });
  const beltY = line.kind === "final" ? line.y - 29 : line.y - 19;
  const beltH = line.kind === "final" ? 58 : 38;
  return (
    <g>
      <defs>
        <clipPath id={clip}>
          <rect x={line.x0} y={line.y - 70} width={line.x1 - line.x0} height={140} />
        </clipPath>
        <pattern
          id={`belt-${line.id}`}
          width={line.kind === "final" ? 14 : 9}
          height="10"
          patternUnits="userSpaceOnUse"
          patternTransform={`translate(${mod(shift, line.kind === "final" ? 14 : 9)} 0)`}
        >
          <rect width="14" height="10" fill={line.kind === "final" ? "#7b8187" : C.belt} />
          <rect width={line.kind === "final" ? 11 : 4} height="10" fill={line.kind === "final" ? "#8c9298" : C.roller} />
        </pattern>
      </defs>
      <rect x={line.x0} y={beltY} width={(line.kind === "final" ? 1235 : line.x1) - line.x0} height={beltH} fill={`url(#belt-${line.id})`} />
      {stopped && (
        <rect x={line.x0} y={beltY} width={line.x1 - line.x0} height={beltH} fill="#ef4444" opacity="0.25" />
      )}
      {line.kind === "body" && (
        <g stroke={C.rail} strokeWidth="3">
          <line x1="150" y1={line.y - 30} x2={line.x1} y2={line.y - 30} />
          <line x1="150" y1={line.y + 30} x2={line.x1} y2={line.y + 30} />
        </g>
      )}
      <g clipPath={`url(#${clip})`}>
        {cars.map(({ k, x }) => (
          <Car key={k} x={x} y={line.y} dir={line.dir} kind={line.kind} variant={k} />
        ))}
      </g>
    </g>
  );
}

const BODY_PAINT = ["#eef0f2", "#e6e9ec", "#2f5fd0", "#eef0f2", "#e6e9ec", "#2f5fd0", "#eef0f2", "#e6e9ec"];
const FINAL_PAINT = ["#e9ecef", "#c9ced3", "#8e959c", "#233a78", "#eef0f2", "#1f2328", "#d9dde1", "#b8bdc2"];

// Model Y-ish car seen from above, nose pointing +x before rotation
function Car({ x, y, dir, kind, variant }: { x: number; y: number; dir: 1 | -1; kind: "body" | "final"; variant: number }) {
  const paint = (kind === "body" ? BODY_PAINT : FINAL_PAINT)[variant % 8];
  const foil = kind === "body" && paint !== "#2f5fd0";
  return (
    <g transform={`translate(${x} ${y}) rotate(${dir === 1 ? 0 : 180}) scale(0.88)`}>
      <g filter="url(#hs-shadow)">
        {/* wheels peeking out */}
        <g fill="#1b1e21">
          <rect x="30" y="-35" width="20" height="7" rx="2" />
          <rect x="30" y="28" width="20" height="7" rx="2" />
          <rect x="-50" y="-35" width="20" height="7" rx="2" />
          <rect x="-50" y="28" width="20" height="7" rx="2" />
        </g>
        <path
          d="M-66,-24 Q-68,-31 -58,-32 L48,-32 Q64,-30 68,-14 L68,14 Q64,30 48,32 L-58,32 Q-68,31 -66,24 Z"
          fill={paint}
          stroke="#00000033"
          strokeWidth="1"
        />
        {foil && (
          <g fill="#2f5fd0" opacity="0.9">
            <rect x="-36" y="-32" width="54" height="6" rx="1.5" />
            <rect x="-36" y="26" width="54" height="6" rx="1.5" />
          </g>
        )}
        {/* body shading, glass roof, windscreen, rear window */}
        <path d="M-58,-32 L48,-32 Q64,-30 68,-14 L68,-6 L-66,-6 L-66,-24 Q-68,-31 -58,-32 Z" fill="#ffffff" opacity="0.12" />
        <rect x="-34" y="-18" width="44" height="36" rx="8" fill="#2c353e" />
        <rect x="-30" y="-15" width="18" height="8" rx="3" fill="#ffffff" opacity="0.14" />
        <path d="M13,-21 L28,-17 L28,17 L13,21 Z" fill="#3a4550" />
        <path d="M-50,-17 L-40,-19 L-40,19 L-50,17 Z" fill="#3a4550" />
        <path d="M-66,-10 L-66,10" stroke="#00000030" strokeWidth="2" />
        {/* mirrors */}
        <rect x="16" y="-37" width="7" height="5" rx="1.5" fill={paint} stroke="#00000033" />
        <rect x="16" y="32" width="7" height="5" rx="1.5" fill={paint} stroke="#00000033" />
      </g>
      {kind === "body" && (
        <g stroke={C.hanger} strokeWidth="6" strokeLinecap="round" fill="none">
          <path d="M-46,-44 L-46,44" />
          <path d="M30,-44 L30,44" />
          <path d="M-58,-44 L42,-44" stroke={C.hangerHi} strokeWidth="5" />
          <path d="M-58,44 L42,44" stroke={C.hangerHi} strokeWidth="5" />
        </g>
      )}
    </g>
  );
}

// Tugger train in a material aisle: tractor plus three carts
function Tugger({ y, dir, t, phase }: { y: number; dir: 1 | -1; t: number; phase: number }) {
  const lenAisle = 1295 + 240;
  const x = 40 - 120 + mod(phase + dir * t * 6, lenAisle);
  return (
    <g clipPath="url(#hs-hall)">
      <g transform={`translate(${x} ${y}) scale(${dir} 1)`} filter="url(#hs-shadow)">
        <rect x="0" y="-9" width="26" height="18" rx="4" fill="#2b3035" />
        <circle cx="10" cy="0" r="5" fill="#f0b429" />
        {[0, 1, 2].map((i) => (
          <g key={i} transform={`translate(${-34 - i * 34} 0)`}>
            <line x1="26" y1="0" x2="34" y2="0" stroke="#2b3035" strokeWidth="2" />
            <rect x="0" y="-10" width="28" height="20" rx="2" fill="#c7ccd1" stroke="#9aa0a6" />
            <rect x="4" y="-6" width="9" height="12" fill="#b98a4e" />
            <rect x="15" y="-6" width="9" height="12" fill="#6f8fb8" />
          </g>
        ))}
      </g>
    </g>
  );
}

// ---------------------------------------------------------------- static hall (memoised)

const Bench = ({ x, y, w = 80, h = 22 }: { x: number; y: number; w?: number; h?: number }) => (
  <g filter="url(#hs-shadow)">
    <rect x={x} y={y} width={w} height={h} rx="2" fill={C.bench} />
    <rect x={x + 4} y={y + 4} width={w * 0.3} height={h - 8} rx="1.5" fill={C.benchTop} />
    <rect x={x + w * 0.4} y={y + 5} width={w * 0.22} height={h - 10} rx="1.5" fill="#6d747b" />
    <rect x={x + w * 0.68} y={y + 4} width={w * 0.26} height={h - 8} rx="1.5" fill={C.benchTop} />
  </g>
);

const Post = ({ x, y, label }: { x: number; y: number; label?: string }) => (
  <g>
    <g filter="url(#hs-shadow)">
      <rect x={x} y={y} width="20" height="20" rx="2" fill={C.box} />
      <path d={`M${x + 20},${y} l5,4 v20 l-5,-4 Z`} fill={C.boxSide} />
    </g>
    {label && (
      <text x={x + 28} y={y + 18} fontSize="11" fontWeight="600" fill={C.label}>
        {label}
      </text>
    )}
  </g>
);

const Shelf = ({ x, y, w, h }: { x: number; y: number; w: number; h: number }) => (
  <g>
    <rect x={x} y={y} width={w} height={h} fill="#4a5057" stroke="#2f3439" />
    {Array.from({ length: Math.max(1, Math.floor(w / 14)) }, (_, i) => (
      <rect key={i} x={x + 3 + i * 14} y={y + 3} width="10" height={h - 6} fill="#737a81" />
    ))}
  </g>
);

const Worker = ({ x, y }: { x: number; y: number }) => (
  <g filter="url(#hs-shadow)">
    <ellipse cx={x} cy={y} rx="10" ry="6" fill="#1d2024" />
    <circle cx={x} cy={y} r="4.5" fill="#2c3136" />
  </g>
);

const StaticHall = memo(function StaticHall() {
  const stationsX = [345, 565, 785, 1005, 1225];
  return (
    <g>
      <defs>
        <filter id="hs-shadow" x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow dx="1.5" dy="2.5" stdDeviation="1.6" floodColor="#000" floodOpacity="0.35" />
        </filter>
        <clipPath id="hs-hall">
          <rect x="40" y="47" width="1295" height="683" />
        </clipPath>
        <linearGradient id="hs-floor" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#a1a7ac" />
          <stop offset="1" stopColor="#959ba0" />
        </linearGradient>
      </defs>

      <rect width="1376" height="768" fill={C.frame} />
      <rect x="40" y="47" width="1295" height="683" fill="url(#hs-floor)" />

      {/* wall shelving */}
      {[70, 200, 330, 445, 560, 660].map((y) => (
        <Shelf key={`l${y}`} x={44} y={y} w={24} h={46} />
      ))}
      {[70, 200, 330, 445, 560, 660].map((y) => (
        <Shelf key={`r${y}`} x={1307} y={y} w={24} h={46} />
      ))}
      {[120, 180, 1060, 1120, 1180, 1240].map((x) => (
        <Shelf key={`t${x}`} x={x} y={50} w={52} h={16} />
      ))}
      {[120, 200, 400, 700, 950, 1180].map((x) => (
        <Shelf key={`b${x}`} x={x} y={710} w={60} h={16} />
      ))}

      {/* line 1: work zone above and below */}
      {[215, 435, 650, 870, 1090].map((x) => (
        <Bench key={`a${x}`} x={x} y={196} w={84} h={22} />
      ))}
      {stationsX.map((x, i) => (
        <Post key={`pa${x}`} x={x} y={228} label={`A${i + 1}`} />
      ))}
      {[340, 600, 820, 1040].map((x) => (
        <Post key={`pt${x}`} x={x} y={52} />
      ))}
      {[300, 520, 760, 980].map((x) => (
        <Bench key={`at${x}`} x={x} y={80} w={56} h={18} />
      ))}

      {/* aisle 1 */}
      <rect x="40" y="256" width="1295" height="40" fill={C.lane} />
      <line x1="40" y1="256" x2="1335" y2="256" stroke={C.yellow} strokeWidth="3" />
      <line x1="40" y1="296" x2="1335" y2="296" stroke={C.yellow} strokeWidth="3" />
      <text x="688" y="280" textAnchor="middle" fontSize="12" fill={C.label}>
        Material aisle
      </text>
      <path d="M130,276 h-18 m6,-5 l-6,5 l6,5" stroke={C.label} strokeWidth="1.6" fill="none" />
      <path d="M1285,276 h18 m-6,-5 l6,5 l-6,5" stroke={C.label} strokeWidth="1.6" fill="none" />

      {/* line 2 */}
      <line x1="592" y1="297" x2="592" y2="368" stroke={C.yellow} strokeWidth="2.5" />
      <line x1="796" y1="297" x2="796" y2="368" stroke={C.yellow} strokeWidth="2.5" />
      {[270, 440, 960].map((x) => (
        <Bench key={`b2t${x}`} x={x} y={302} w={64} h={18} />
      ))}
      {stationsX.map((x, i) => (
        <Post key={`pb${x}`} x={x} y={300} label={`B${i + 1}`} />
      ))}
      {[200, 450, 880, 1040].map((x) => (
        <Bench key={`b2b${x}`} x={x} y={455} w={70} h={18} />
      ))}
      {/* battery pack and chassis on the buffer */}
      <g filter="url(#hs-shadow)">
        <rect x="642" y="445" width="62" height="36" rx="10" fill="#c6cace" stroke="#8f959b" />
        <rect x="720" y="448" width="66" height="32" rx="3" fill="#e4e6e8" stroke="#8f959b" />
        <circle cx="735" cy="456" r="5" fill="#2a2e33" />
        <circle cx="771" cy="456" r="5" fill="#2a2e33" />
        <circle cx="735" cy="472" r="5" fill="#2a2e33" />
        <circle cx="771" cy="472" r="5" fill="#2a2e33" />
      </g>

      {/* aisle 2 */}
      <rect x="40" y="487" width="1295" height="40" fill={C.lane} />
      <line x1="40" y1="487" x2="1335" y2="487" stroke={C.yellow} strokeWidth="3" />
      <line x1="40" y1="527" x2="1335" y2="527" stroke={C.yellow} strokeWidth="3" />
      <text x="688" y="511" textAnchor="middle" fontSize="12" fill={C.label}>
        Material aisle
      </text>
      <path d="M130,507 h-18 m6,-5 l-6,5 l6,5" stroke={C.label} strokeWidth="1.6" fill="none" />
      <path d="M1285,507 h18 m-6,-5 l6,5 l-6,5" stroke={C.label} strokeWidth="1.6" fill="none" />

      {/* line 3: platform, parts racks with glass, exit */}
      <rect x="200" y="580" width="1035" height="92" fill="#b3b8bd" />
      {[380, 600, 820, 1040].map((x) => (
        <g key={`g${x}`} filter="url(#hs-shadow)">
          <rect x={x + 20} y="538" width="64" height="20" rx="2" fill={C.shelf} />
          <rect x={x + 26} y="542" width="52" height="12" rx="1" fill={C.glass} opacity="0.85" />
        </g>
      ))}
      {stationsX.map((x, i) => (
        <Post key={`pc${x}`} x={x} y={536} label={`C${i + 1}`} />
      ))}
      {[130, 420, 640, 900, 1110].map((x) => (
        <Bench key={`c3${x}`} x={x} y={688} w={70} h={18} />
      ))}
      <rect x="1238" y="582" width="48" height="88" fill="none" stroke="#f4f4f5" strokeWidth="2" strokeDasharray="7 5" />

      {/* line labels */}
      <g fill={C.label}>
        <text x="88" y="84" fontSize="12.5" fontWeight="700">TOP LINE</text>
        <text x="88" y="100" fontSize="11">Line 1 · Interior</text>
        <text x="72" y="318" fontSize="12.5" fontWeight="700">MIDDLE LINE</text>
        <text x="72" y="334" fontSize="11">Line 2 · Battery &amp; chassis</text>
        <text x="88" y="552" fontSize="12.5" fontWeight="700">BOTTOM LINE</text>
        <text x="88" y="568" fontSize="11">Line 3 · Final assembly</text>
      </g>

      {/* people at the stations */}
      {[[268, 205], [490, 208], [712, 206], [935, 212], [540, 232], [262, 430], [480, 432], [705, 330], [930, 432], [1150, 432], [483, 588], [708, 668], [940, 590], [1162, 668]].map(([x, y]) => (
        <Worker key={`w${x}-${y}`} x={x} y={y} />
      ))}

      <text x="40" y="752" fontSize="10.5" fill="#9ca3af">
        Schematic design concept · not a real floor plan
      </text>
    </g>
  );
});
