"use client";

import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { fmtT, type AffectedDevice } from "@/lib/api";
import { cn } from "@/lib/utils";

const FIXED = ["client", "vendor", "device_class", "bssid", "ap"];
const LABEL: Record<string, string> = {
  client: "Device",
  vendor: "Vendor",
  device_class: "Class",
  bssid: "AP",
  ap: "AP",
  period_s: "Period",
  first: "First seen",
  start: "Start",
  end: "End",
  closest_sensor: "Closest sensor",
  identity_requests: "ID requests",
  reason23: "Reason 23",
};
const TIME_KEYS = new Set(["first", "start", "end", "last"]);
const MAC = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i;

function label(k: string) {
  return (
    LABEL[k] ?? k.replaceAll("_", " ").replace(/^\w/, (c) => c.toUpperCase())
  );
}

function cell(k: string, v: unknown) {
  if (v == null || v === "") return <span className="opacity-40">-</span>;
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "number") {
    if (TIME_KEYS.has(k)) return <span className="font-mono">{fmtT(v)}</span>;
    if (k.endsWith("_s")) return `${Number.isInteger(v) ? v : v.toFixed(1)} s`;
    return Number.isInteger(v) ? v.toLocaleString("en") : v.toFixed(2);
  }
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "object") return JSON.stringify(v);
  const s = String(v);
  return MAC.test(s) ? <span className="font-mono">{s}</span> : s;
}

export function AffectedTable({ rows }: { rows: AffectedDevice[] }) {
  const keys = new Set<string>();
  rows.forEach((r) => Object.keys(r).forEach((k) => keys.add(k)));
  const apKey = keys.has("bssid") ? "bssid" : keys.has("ap") ? "ap" : null;
  const cols = [
    ...["client", "vendor", "device_class"].filter((k) => keys.has(k)),
    ...(apKey ? [apKey] : []),
    ...[...keys].filter((k) => !FIXED.includes(k)),
  ];
  return (
    <div className="overflow-hidden rounded-lg border">
      <Table containerClassName="scrollbar-thin max-h-80 overflow-y-auto">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {cols.map((k) => (
              <TableHead
                key={k}
                className="bg-card text-muted-foreground sticky top-0 z-10 h-8 text-[11px] font-medium first:pl-3 last:pr-3"
              >
                {label(k)}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r, i) => (
            <TableRow key={i}>
              {cols.map((k) => (
                <TableCell
                  key={k}
                  className={cn(
                    "py-1.5 text-xs first:pl-3 last:pr-3",
                    k === "vendor" && "max-w-40 truncate",
                  )}
                >
                  {k === "device_class" && typeof r[k] === "string" ? (
                    <Badge
                      variant="outline"
                      className={cn(
                        r[k] === "industrial" &&
                          "text-foreground border-zinc-400 dark:border-red-500/30 dark:text-red-300",
                      )}
                    >
                      {String(r[k])}
                    </Badge>
                  ) : (
                    cell(k, r[k])
                  )}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
