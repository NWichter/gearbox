"use client";

import { RadioTower, Users } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { findingsForRadio } from "@/components/site-map";
import {
  SEVERITY_COLOR,
  SEVERITY_RANK,
  worstSeverity as worst,
  type AP,
  type Finding,
  type Result,
  type Severity,
} from "@/lib/api";
import { cn } from "@/lib/utils";

// Every finding that touches an AP: its own BSSID, an affected device's AP, or a missing BSSID
export function findingsForAp(findings: Finding[], bssid: string) {
  return findingsForRadio(findings, [bssid]);
}

export function AirMap({
  result,
  onSelectAp,
}: {
  result: Result;
  onSelectAp: (ap: AP, related: Finding[]) => void;
}) {
  const stats = result.sensors.stats;
  const covered = new Set(stats.flatMap((s) => s.channels));
  const tiles = stats.map((s) => ({
    key: s.sensor,
    title: s.sensor,
    channels: s.channels,
    aps: result.aps.filter(
      (a) => a.channel != null && s.channels.includes(a.channel),
    ),
  }));
  const orphan = result.aps.filter(
    (a) => a.channel == null || !covered.has(a.channel),
  );
  if (orphan.length)
    tiles.push({
      key: "__none",
      title: "No sensor on this channel",
      channels: [],
      aps: orphan,
    });

  return (
    <div className="space-y-4">
      <div className="text-muted-foreground flex flex-wrap items-center justify-between gap-3 text-xs">
        <p>
          One tile for each sensor and its channel. The entries are the APs
          that the sensor recorded. Click an AP to open its most important
          finding.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          {(["critical", "high", "medium", "low"] as Severity[]).map((s) => (
            <span key={s} className="flex items-center gap-1.5 capitalize">
              <span
                className="size-2 rounded-[2px]"
                style={{ background: SEVERITY_COLOR[s] }}
              />
              {s}
            </span>
          ))}
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-[2px] bg-zinc-300 dark:bg-zinc-600" />
            no finding
          </span>
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {tiles.map((t) => {
          const apInfo = t.aps.map((a) => {
            const related = findingsForAp(result.findings, a.bssid);
            return { a, related, sev: worst(related) };
          });
          apInfo.sort(
            (x, y) =>
              (x.sev ? SEVERITY_RANK[x.sev] : 9) -
                (y.sev ? SEVERITY_RANK[y.sev] : 9) || y.a.clients - x.a.clients,
          );
          const tileSev = worst(apInfo.flatMap((x) => x.related));
          return (
            <div
              key={t.key}
              className={cn(
                "bg-card relative flex flex-col gap-2 overflow-hidden rounded-md border p-3",
                tileSev === "critical" && "border-l-2 border-l-zinc-900 dark:border-l-red-500",
                tileSev === "high" && "border-l-2 border-l-zinc-400 dark:border-l-orange-500",
                t.key === "__none" && "border-dashed",
              )}
            >
              <div className="relative flex items-center gap-2">
                <RadioTower className="text-muted-foreground size-3.5" />
                <span className="font-mono text-xs font-semibold">{t.title}</span>
                {t.channels.length > 0 && (
                  <span className="text-muted-foreground ml-auto font-mono text-[11px]">
                    ch {t.channels.join(", ")}
                  </span>
                )}
              </div>
              {apInfo.length === 0 ? (
                <p className="text-muted-foreground text-xs">
                  The sensor recorded no AP beacons on this channel.
                </p>
              ) : (
                <div className="relative flex flex-col">
                  {apInfo.map(({ a, related, sev }) => (
                    <Tooltip key={a.bssid}>
                      <TooltipTrigger
                        render={
                          <button
                            onClick={() => onSelectAp(a, related)}
                            className={cn(
                              "hover:bg-muted -mx-1 flex items-center gap-1.5 rounded-sm px-1 py-0.5 text-left text-[11px] dark:hover:bg-white/[0.05]",
                              !sev && "text-muted-foreground",
                            )}
                          />
                        }
                      >
                        <span
                          className={cn(
                            "size-2 shrink-0 rounded-[2px]",
                            !sev && "bg-zinc-300 dark:bg-zinc-600",
                          )}
                          style={
                            sev ? { background: SEVERITY_COLOR[sev] } : undefined
                          }
                        />
                        <span className="min-w-0 flex-1 truncate">
                          {a.ssid || "hidden"}
                        </span>
                        <span className="text-muted-foreground font-mono text-[10px]">
                          {a.bssid.slice(-5)}
                        </span>
                        <span className="text-muted-foreground flex items-center gap-0.5 tabular-nums">
                          <Users className="size-3" />
                          {a.clients}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent className="flex-col items-start gap-0.5">
                        <span className="font-mono">{a.bssid}</span>
                        <span className="opacity-70">
                          {a.ssid ?? "hidden SSID"} · ch {a.channel ?? "?"} ·{" "}
                          {a.clients} devices ·{" "}
                          {related.length
                            ? `${related.length} finding(s)`
                            : "no findings"}
                        </span>
                      </TooltipContent>
                    </Tooltip>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
