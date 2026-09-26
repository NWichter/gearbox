"use client";

import { Loader2, ServerCrash, Upload } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { UploadDialog } from "@/components/upload-dialog";
import type { DatasetInfo } from "@/lib/api";
import { cn } from "@/lib/utils";

export function shorten(s: string, n = 44) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

const STATUS_DOT: Record<DatasetInfo["status"], string> = {
  done: "bg-ok",
  running: "bg-warn",
  queued: "bg-zinc-400",
  failed: "bg-tesla",
};

// Small "current dataset" control (like the site picker of a network controller) plus upload
export function DatasetPicker({
  datasets,
  value,
  onChange,
  onUploaded,
  className,
}: {
  datasets: DatasetInfo[];
  value: string | null;
  onChange: (id: string) => void;
  onUploaded: (id: string) => void;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 items-end gap-1", className)}>
      <div className="min-w-0">
        <div className="text-muted-foreground px-2 text-[10px] font-medium tracking-[0.08em] uppercase">
          Current dataset
        </div>
        <Select
          value={value}
          onValueChange={(v) => v && onChange(v as string)}
          items={datasets.map((d) => ({
            value: d.id,
            label: shorten(d.name, 36),
          }))}
        >
          <SelectTrigger
            size="sm"
            className="hover:bg-muted h-7! w-full max-w-64 min-w-0 border-transparent bg-transparent px-2 text-xs shadow-none"
            aria-label="Dataset"
          >
            <SelectValue placeholder="Select a dataset" />
          </SelectTrigger>
          <SelectContent
            align="end"
            alignItemWithTrigger={false}
            className="min-w-72"
          >
            {datasets.map((d) => (
              <SelectItem key={d.id} value={d.id}>
                <span
                  className={cn("size-1.5 rounded-full", STATUS_DOT[d.status])}
                />
                {shorten(d.name, 36)}
                {d.status !== "done" && (
                  <span className="text-muted-foreground font-mono text-xs">
                    {d.status}
                  </span>
                )}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <UploadDialog compact onUploaded={onUploaded} />
    </div>
  );
}

export function PendingState({
  status,
  name,
}: {
  status: string;
  name?: string;
}) {
  if (status === "loading") return <PageSkeleton />;
  if (status === "running" || status === "queued")
    return (
      <div className="space-y-4">
        <div className="bg-card flex items-center gap-3 rounded-md border px-3 py-2.5">
          <Loader2 className="text-warn size-4 animate-spin" />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium">
              {status === "queued"
                ? "The analysis waits in the queue"
                : "The analysis runs"}
            </div>
            <div className="text-muted-foreground truncate text-xs">
              {name ? shorten(name, 60) : "Dataset"} · read each sensor, merge
              the sensors, find the problems. This page updates automatically.
            </div>
          </div>
        </div>
        <PageSkeleton />
      </div>
    );
  const empty = status === "empty";
  return (
    <div className="flex items-start gap-3 rounded-md border border-dashed px-4 py-6">
      {empty ? (
        <Upload className="text-muted-foreground mt-0.5 size-4" />
      ) : (
        <ServerCrash className="text-tesla mt-0.5 size-4" />
      )}
      <div className="space-y-0.5">
        <div className="text-[13px] font-medium">
          {empty ? "No captures" : "The dataset is not available"}
        </div>
        <p className="text-muted-foreground text-xs">
          {empty
            ? "Upload one pcap for each sensor to start an analysis."
            : status === "api offline"
              ? "Gearbox cannot connect to the analysis API."
              : status}
        </p>
      </div>
    </div>
  );
}

export function PageSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading">
      <Skeleton className="mx-auto h-8 w-80 max-w-full" />
      <Skeleton className="mx-auto h-40 w-full max-w-3xl rounded-xl" />
      <div className="grid gap-3 sm:grid-cols-3">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-24 rounded-md" />
        ))}
      </div>
      <div className="divide-y rounded-md border">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="flex items-center gap-3 px-3 py-2.5">
            <Skeleton className="h-4 w-14" />
            <Skeleton className="h-4 flex-1" />
            <Skeleton className="h-4 w-12" />
          </div>
        ))}
      </div>
    </div>
  );
}
