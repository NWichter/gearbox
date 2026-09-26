"use client";

import { Hand, MapPin, MinusCircle, Phone, Siren } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ActionWho, Finding, Urgency } from "@/lib/api";
import { cn } from "@/lib/utils";

// Owner of a finding (who acts), shown as a small outlined tag
export const WHO_CHIP: Record<
  ActionWho,
  { text: string; icon: typeof Hand; className: string }
> = {
  you: {
    text: "Supervisor",
    icon: Hand,
    className: "text-foreground dark:text-foreground/85",
  },
  it: { text: "IT", icon: Phone, className: "text-muted-foreground" },
  security: {
    text: "Security",
    icon: Siren,
    className:
      "text-violet-700 border-violet-300 dark:text-purple-300 dark:border-purple-500/30",
  },
  report: {
    text: "Report location",
    icon: MapPin,
    className: "text-muted-foreground",
  },
  none: {
    text: "No action",
    icon: MinusCircle,
    className: "text-muted-foreground",
  },
};

// Urgency = which network the finding hits. Red (Tesla red) is only for the tools network.
export const URGENCY: Record<
  Urgency,
  { stripe: string; color: string; dot: string; label: string; rank: number }
> = {
  red: {
    stripe: "bg-tesla dark:bg-red-500",
    color: "#ef4444",
    dot: "#e31937",
    label: "Tools network: can stop the line",
    rank: 0,
  },
  purple: {
    stripe: "bg-violet-500 dark:bg-purple-500",
    color: "#a855f7",
    dot: "#7c5cc4",
    label: "Security incident",
    rank: 1,
  },
  yellow: {
    stripe: "bg-warn dark:bg-amber-400",
    color: "#fbbf24",
    dot: "#d98a00",
    label: "Office network only",
    rank: 2,
  },
  grey: {
    stripe: "bg-zinc-300 dark:bg-zinc-600",
    color: "#52525b",
    dot: "#a1a1aa",
    label: "Information",
    rank: 3,
  },
};

// Findings from older analyses have no action block: fall back to severity
export function urgencyOf(f: Finding): Urgency {
  if (f.action?.urgency) return f.action.urgency;
  if (f.severity === "critical") return "red";
  if (f.severity === "high") return "yellow";
  return "grey";
}

export function UrgencyDot({
  finding,
  className,
}: {
  finding: Finding;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block size-2 shrink-0 rounded-full", className)}
      style={{ background: URGENCY[urgencyOf(finding)].dot }}
    />
  );
}

// Distinct devices hit by findings on the tools network (torque tools, robots)
export function toolsDevices(findings: Finding[]) {
  const set = new Set<string>();
  for (const f of findings) {
    const onTools =
      f.action?.urgency === "red" ||
      (f.networks ?? []).some((n) => /TOOL/i.test(n));
    if (!onTools) continue;
    if (f.client) set.add(f.client.toLowerCase());
    for (const a of f.affected ?? [])
      if (typeof a.client === "string") set.add(a.client.toLowerCase());
  }
  return set.size;
}

export function UrgencyStripe({ finding }: { finding: Finding }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "absolute inset-y-0 left-0 w-[3px]",
        URGENCY[urgencyOf(finding)].stripe,
      )}
    />
  );
}

export function ActionChip({
  finding,
  className,
  compact = false,
}: {
  finding: Finding;
  className?: string;
  compact?: boolean;
}) {
  const a = finding.action;
  if (!a) return null;
  const c = WHO_CHIP[a.who] ?? WHO_CHIP.none;
  const Icon = c.icon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "inline-flex h-[18px] shrink-0 items-center gap-1 rounded-sm border px-1.5 text-[11px] whitespace-nowrap",
              c.className,
              className,
            )}
          />
        }
      >
        <Icon className="size-3" />
        {!compact && c.text}
      </TooltipTrigger>
      <TooltipContent>{a.label}</TooltipContent>
    </Tooltip>
  );
}

export function ScopeLine({
  finding,
  className,
}: {
  finding: Finding;
  className?: string;
}) {
  const parts = [
    finding.scope,
    finding.networks?.length ? finding.networks.join(", ") : null,
  ].filter(Boolean);
  if (!parts.length) return null;
  return (
    <span className={cn("text-muted-foreground text-xs", className)}>
      {parts.join(" · ")}
    </span>
  );
}

export function UrgencyLegend({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs",
        className,
      )}
    >
      {(["red", "yellow", "purple"] as Urgency[]).map((u) => (
        <span key={u} className="inline-flex items-center gap-1.5">
          <span className={cn("h-3 w-[3px]", URGENCY[u].stripe)} />
          {URGENCY[u].label}
        </span>
      ))}
    </div>
  );
}
