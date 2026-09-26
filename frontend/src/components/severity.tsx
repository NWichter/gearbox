"use client";

import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  SEVERITIES,
  SEVERITY_COLOR,
  SEVERITY_HINT,
  SEVERITY_STYLE,
  type Severity,
} from "@/lib/api";
import { cn } from "@/lib/utils";

export function SeverityDot({
  severity,
  className,
}: {
  severity: Severity;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block size-2 shrink-0 rounded-[2px]", className)}
      style={{ background: SEVERITY_COLOR[severity] }}
    />
  );
}

export function SeverityBadge({
  severity,
  className,
  withTooltip = true,
}: {
  severity: Severity;
  className?: string;
  withTooltip?: boolean;
}) {
  const badge = (
    <Badge
      className={cn(
        "h-[18px] gap-1.5 rounded-sm px-1.5 font-mono text-[10px] font-medium uppercase",
        SEVERITY_STYLE[severity],
        className,
      )}
    >
      {severity}
    </Badge>
  );
  if (!withTooltip) return badge;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>
        {badge}
      </TooltipTrigger>
      <TooltipContent>{SEVERITY_HINT[severity]}</TooltipContent>
    </Tooltip>
  );
}

// Stacked horizontal bar showing how findings split across severities
export function SeverityBar({
  counts,
  className,
}: {
  counts: Partial<Record<Severity, number>>;
  className?: string;
}) {
  const total = SEVERITIES.reduce((n, s) => n + (counts[s] ?? 0), 0);
  if (!total) return null;
  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex h-1.5 w-full overflow-hidden rounded-[1px] bg-muted dark:bg-white/5">
        {SEVERITIES.map((s) =>
          counts[s] ? (
            <div
              key={s}
              style={{
                width: `${((counts[s] ?? 0) / total) * 100}%`,
                background: SEVERITY_COLOR[s],
              }}
              className="h-full"
            />
          ) : null,
        )}
      </div>
      <div className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-1 text-xs">
        {SEVERITIES.map((s) => (
          <span key={s} className="inline-flex items-center gap-1.5">
            <SeverityDot severity={s} className="size-1.5" />
            <span className="capitalize">{s}</span>
            <span className="text-foreground font-medium tabular-nums">
              {counts[s] ?? 0}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}
