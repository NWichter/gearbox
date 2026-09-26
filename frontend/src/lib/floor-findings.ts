// Where a finding belongs on the shop-floor plan: one device, a few APs, or the whole site.
// Pure functions over the repo's finding-to-AP / finding-to-device rules (components/site-map).
import { urgencyOf } from "@/components/action";
import { findingsForMac, findingsForRadio } from "@/components/site-map";
import { SEVERITY_RANK, type Finding } from "@/lib/api";
import {
  lineOfCell,
  type FloorAp,
  type FloorDevice,
  type LineId,
} from "@/lib/floorplan";

// more APs than this and a finding is drawn as site-wide (banner + thin rings, no halos)
export const LOCAL_MAX_APS = 6;

export type Reach = "device" | "local" | "site";

// A callout position: the finding pinned to one AP or device. `primary` is the one callout that
// may open on its own; the others stay a pulsing dot until hovered.
export type Anchor = {
  key: string;
  finding: Finding;
  kind: "ap" | "device";
  id: string; // AP num or device MAC
  x: number;
  y: number;
  primary: boolean;
  note?: string; // what is wrong at exactly this spot
};

export type Placed = {
  finding: Finding;
  reach: Reach;
  aps: string[]; // AP nums
  devices: string[]; // device MACs on the plan
  anchors: Anchor[];
};

export const onTools = (f: Finding) =>
  (f.networks ?? []).some((n) => /TOOL/i.test(n));

// Severity first, then tools-network findings, then the older one
export function byPriority(a: Finding, b: Finding) {
  return (
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    Number(onTools(b)) - Number(onTools(a)) ||
    a.t_start - b.t_start
  );
}

// "00:0b:86:03:00:00 (TESLA-CORP, ch 40)" -> TESLA-CORP; "00:0b:86:0d:00:xx (whole radio silent)"
function missingOnAp(f: Finding, ap: FloorAp): string | null {
  for (const m of f.missing_bssids ?? []) {
    const mac = m.split(/\s/)[0].toLowerCase();
    if (mac.endsWith("xx") && ap.corp.startsWith(mac.slice(0, -2)))
      return "AP silent: no network on the air";
    if (mac === ap.corp || mac === ap.tools)
      return `${m.match(/\(([^,)]+)/)?.[1] ?? "a network"} not on the air`;
  }
  return null;
}

function reachOf(f: Finding, aps: number): Reach {
  const scope = (f.scope ?? "").toLowerCase();
  if (scope === "site" || scope.includes("many aps") || aps > LOCAL_MAX_APS)
    return "site";
  if (f.client || (f.affected?.length ?? 0) === 1) return "device";
  return "local";
}

export function placeFinding(
  f: Finding,
  aps: FloorAp[],
  devices: FloorDevice[],
): Placed {
  const hitAps = aps.filter(
    (a) => findingsForRadio([f], [a.corp, a.tools]).length > 0,
  );
  const hitDevs = devices.filter((d) => findingsForMac([f], d.mac).length > 0);
  let reach = reachOf(f, hitAps.length);
  const anchors: Anchor[] = [];
  const at = (
    kind: Anchor["kind"],
    id: string,
    x: number,
    y: number,
    primary: boolean,
    note?: string,
  ) =>
    anchors.push({
      key: `${f.id}:${kind}:${id}`,
      finding: f,
      kind,
      id,
      x,
      y,
      primary,
      note,
    });

  if (reach === "device") {
    const d = hitDevs[0];
    const ap = hitAps[0];
    if (d) at("device", d.mac, d.x, d.y, true);
    else if (ap) at("ap", ap.num, ap.x, ap.y, true);
  } else if (reach === "local") {
    const notes = hitAps.map((a) => ({ a, note: missingOnAp(f, a) }));
    const missing = notes.filter((n) => n.note);
    if (missing.length) {
      // every AP that lacks a network gets its own callout; the worst one may open by itself
      const rank = (n: string | null) =>
        n?.startsWith("AP silent") ? 0 : n && /TOOL/i.test(n) ? 1 : 2;
      missing.sort((p, q) => rank(p.note) - rank(q.note));
      missing.forEach(({ a, note }, i) =>
        at("ap", a.num, a.x, a.y, i === 0, note ?? undefined),
      );
    } else if (hitAps.length) {
      // callout at the AP with the most affected devices, the others only get a ring
      const count = (a: FloorAp) =>
        hitDevs.filter((d) => d.ap === a.num).length;
      const worst = [...hitAps].sort((p, q) => count(q) - count(p))[0];
      at("ap", worst.num, worst.x, worst.y, true);
    }
  }
  // nothing to pin it to on the plan: tell it in the banner instead
  if (reach !== "site" && anchors.length === 0) reach = "site";

  return {
    finding: f,
    reach,
    aps: hitAps.map((a) => a.num),
    devices: hitDevs.map((d) => d.mac),
    anchors,
  };
}

export type AckLike = { state: "ack" | "done"; t?: number };

// 5.4: an open line-stopping finding (red, on TESLA-TOOLS) halts the lines of its APs from its
// start until it is marked as fixed (replay time of the fix, when known) or it ends
export function lineStops(
  findings: Finding[],
  aps: FloorAp[],
  devices: FloorDevice[],
  acks: Record<number, AckLike | undefined>,
): { line: LineId; from: number; to: number }[] {
  const stops: { line: LineId; from: number; to: number }[] = [];
  for (const f of findings) {
    if (urgencyOf(f) !== "red" || !onTools(f)) continue;
    const a = acks[f.id];
    let to = f.t_end;
    if (a?.state === "done") {
      if (a.t == null) continue; // fixed elsewhere, no replay time: treat as never stopping
      to = Math.min(to, a.t);
    }
    if (to <= f.t_start) continue;
    const p = placeFinding(f, aps, devices);
    const cells = aps.filter((x) => p.aps.includes(x.num)).map((x) => x.cell);
    for (const line of new Set(cells.map(lineOfCell)))
      stops.push({ line, from: f.t_start, to });
  }
  return stops;
}
