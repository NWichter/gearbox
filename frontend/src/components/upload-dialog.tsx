"use client";

import { useRef, useState } from "react";
import { FileUp, Loader2, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

const ACCEPT = [".pcap", ".pcapng", ".cap", ".gz"];

function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function UploadDialog({
  onUploaded,
  compact = false,
}: {
  onUploaded: (id: string) => void;
  // icon-only trigger for tight headers
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  function add(list: FileList | null) {
    const picked = Array.from(list ?? []).filter((f) =>
      ACCEPT.some((ext) => f.name.toLowerCase().endsWith(ext)),
    );
    setFiles((cur) => {
      const names = new Set(cur.map((f) => f.name));
      return [...cur, ...picked.filter((f) => !names.has(f.name))];
    });
    setErr(null);
  }

  async function upload() {
    setBusy(true);
    setErr(null);
    try {
      const { id } = await api.upload(
        files,
        files
          .map((f) => f.name)
          .join(", ")
          .slice(0, 190),
      );
      toast.success("Captures uploaded", {
        description: `${files.length} file(s) wait for the analysis.`,
      });
      setFiles([]);
      setOpen(false);
      onUploaded(id);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  const total = files.reduce((n, f) => n + f.size, 0);

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
      {compact ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <DialogTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Upload captures"
                  />
                }
              />
            }
          >
            <Upload />
          </TooltipTrigger>
          <TooltipContent>
            Upload captures (one pcap for each sensor)
          </TooltipContent>
        </Tooltip>
      ) : (
        <DialogTrigger render={<Button variant="outline" />}>
          <Upload /> Upload captures
        </DialogTrigger>
      )}
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Upload captures</DialogTitle>
          <DialogDescription>
            Upload one pcap for each sensor. Gearbox reads only the 802.11 and
            802.1X headers. The analysis starts automatically after the upload.
          </DialogDescription>
        </DialogHeader>

        <button
          type="button"
          onClick={() => input.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            add(e.dataTransfer.files);
          }}
          className={cn(
            "group flex w-full flex-col items-center justify-center gap-1.5 rounded-sm border border-dashed px-4 py-6 text-center transition-colors",
            drag
              ? "border-foreground/50 bg-muted/60"
              : "border-input hover:border-foreground/30 hover:bg-muted/40",
          )}
        >
          <FileUp className="text-muted-foreground group-hover:text-foreground size-5 transition-colors" />
          <span className="text-[13px] font-medium">
            Drop capture files here or{" "}
            <span className="underline underline-offset-2">select files</span>
          </span>
          <span className="text-muted-foreground text-xs">
            {ACCEPT.join(" · ")}. Maximum 2 GB in total.
          </span>
        </button>
        <input
          ref={input}
          type="file"
          multiple
          accept={ACCEPT.join(",")}
          className="hidden"
          onChange={(e) => {
            add(e.target.files);
            e.target.value = "";
          }}
        />

        {files.length > 0 && (
          <ul className="scrollbar-thin max-h-44 divide-y overflow-y-auto rounded-lg border">
            {files.map((f) => (
              <li
                key={f.name}
                className="flex items-center gap-3 px-3 py-2 text-xs"
              >
                <span className="min-w-0 flex-1 truncate font-mono">
                  {f.name}
                </span>
                <span className="text-muted-foreground tabular-nums">
                  {fmtBytes(f.size)}
                </span>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Remove ${f.name}`}
                  disabled={busy}
                  onClick={() =>
                    setFiles((cur) => cur.filter((x) => x.name !== f.name))
                  }
                >
                  <X />
                </Button>
              </li>
            ))}
          </ul>
        )}

        {err && (
          <p className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-700 ring-1 ring-red-500/30 dark:text-red-300">
            {err}
          </p>
        )}

        <DialogFooter className="items-center sm:justify-between">
          <span className="text-muted-foreground text-xs">
            {files.length
              ? `${files.length} file(s) · ${fmtBytes(total)}`
              : "No files selected"}
          </span>
          <Button onClick={upload} disabled={!files.length || busy}>
            {busy ? <Loader2 className="animate-spin" /> : <Upload />}
            {busy ? "Uploading…" : "Analyse captures"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
