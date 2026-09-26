"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ClipboardCopy, Download, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, DATASET_KEY } from "@/lib/api";

type Item = {
  id: number;
  title: string;
  severity: string;
  urgency: "red" | "yellow" | "purple" | "grey";
  who: string;
  who_label: string;
  do: string;
  it: string;
  since: string;
  until: string;
  affected: number;
  networks: string[];
  scope: string | null;
  confidence: string | null;
};

type Report = {
  dataset: string;
  window: string | null;
  headline: string;
  counts: {
    line_risk: number;
    yours: number;
    it: number;
    security: number;
    devices_affected: number;
  };
  coverage: {
    sensors: number;
    access_points: number;
    access_points_planned: number | null;
    devices: number;
    frames: number;
  };
  line_risk: Item[];
  yours: Item[];
  it: Item[];
  security: Item[];
  info: Item[];
};

const STRIPE: Record<string, string> = {
  red: "border-l-tesla",
  purple: "border-l-purple-500",
  yellow: "border-l-warn",
  grey: "border-l-zinc-300",
};

function pickDataset(): string | null {
  try {
    const q = new URLSearchParams(window.location.search).get("d");
    return q || localStorage.getItem(DATASET_KEY);
  } catch {
    return null;
  }
}

export default function ShiftReport() {
  const [id, setId] = useState<string | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const load = async () => {
      let ds = pickDataset();
      if (!ds) {
        const list = await api.datasets();
        ds = list.find((d) => d.status === "done")?.id ?? null;
      }
      if (!ds) throw new Error("No dataset has an analysis.");
      setId(ds);
      const r = await fetch(`/api/datasets/${ds}/report`);
      if (!r.ok) throw new Error(`The report is not available (${r.status}).`);
      setReport(await r.json());
    };
    load().catch((e) => setError(String(e.message ?? e)));
  }, []);

  async function markdown() {
    return fetch(`/api/datasets/${id}/report.md`).then((r) => r.text());
  }

  async function copy() {
    const text = await markdown();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("The browser blocked the copy. Use Markdown download.");
    }
  }

  async function download() {
    const blob = new Blob([await markdown()], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "gearbox-shift-report.md";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  if (error)
    return <p className="text-muted-foreground py-8 text-sm">{error}</p>;
  if (!report)
    return (
      <p className="text-muted-foreground py-8 text-sm">Loading report…</p>
    );

  const c = report.coverage;
  return (
    <div className="report mx-auto max-w-4xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4 print:hidden">
        <div className="text-muted-foreground text-xs">
          Shift report · line supervisor
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={copy}>
            <ClipboardCopy /> {copied ? "Copied" : "Copy for Teams / mail"}
          </Button>
          <Button size="sm" variant="outline" onClick={download}>
            <Download /> Markdown
          </Button>
          <Button size="sm" variant="outline" onClick={() => window.print()}>
            <Printer /> Print / PDF
          </Button>
        </div>
      </div>

      <header className="space-y-2 border-b pb-4">
        <p className="text-muted-foreground text-xs">Gearbox · shift report</p>
        <h1 className="text-xl font-semibold">
          {report.headline}
        </h1>
        <p className="text-muted-foreground font-mono text-xs">
          {report.window ? `${report.window} · ` : ""}
          {c.sensors} sensors watched {c.access_points} access points
          {c.access_points_planned
            ? ` (${c.access_points_planned} planned)`
            : ""}{" "}
          and {c.devices} devices · {c.frames.toLocaleString("en")} frames
        </p>
        <div className="bg-border grid grid-cols-2 gap-px overflow-hidden rounded-md border sm:grid-cols-4">
          <Stat
            n={report.counts.line_risk}
            label="can stop the line"
            tone="text-tesla"
          />
          <Stat
            n={report.counts.yours}
            label="for you"
            tone=""
          />
          <Stat
            n={report.counts.it}
            label="handed to IT"
            tone=""
          />
          <Stat
            n={report.counts.security}
            label="security"
            tone=""
          />
        </div>
      </header>

      <Section
        title="Can stop the line: tools network"
        items={report.line_risk}
        field="do"
        empty="No finding on the tools network. The line continues."
      />
      <Section
        title="Your actions"
        items={report.yours.filter(
          (i) => !report.line_risk.includes(i) && i.urgency !== "red",
        )}
        field="do"
      />
      <Section title="Security" items={report.security} field="do" />
      <Section
        title="Handed to IT"
        items={report.it.filter((i) => i.urgency !== "red")}
        field="it"
      />

      {report.info.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">For information</h2>
          <ul className="text-muted-foreground list-disc pl-5 text-sm">
            {report.info.map((i) => (
              <li key={i.id}>{i.title}</li>
            ))}
          </ul>
        </section>
      )}

      <footer className="text-muted-foreground border-t pt-4 text-xs">
        Generated by Gearbox from header-only Wi-Fi captures of {report.dataset}
        . Every item has frame-level evidence in the{" "}
        <Link href="/" className="underline print:no-underline">
          dashboard
        </Link>
        .
      </footer>
    </div>
  );
}

function Stat({ n, label, tone }: { n: number; label: string; tone: string }) {
  return (
    <div className="bg-card px-3 py-2">
      <div className={`text-xl font-semibold tabular-nums ${tone}`}>
        {n}
      </div>
      <div className="text-muted-foreground text-xs">{label}</div>
    </div>
  );
}

function Section({
  title,
  items,
  field,
  empty,
}: {
  title: string;
  items: Item[];
  field: "do" | "it";
  empty?: string;
}) {
  if (!items.length && !empty) return null;
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold">{title}</h2>
      {!items.length && (
        <p className="text-muted-foreground text-sm">{empty}</p>
      )}
      <ol className="divide-y rounded-md border">
        {items.map((i) => (
          <li
            key={i.id}
            className={`border-l-[3px] px-3 py-2 break-inside-avoid ${STRIPE[i.urgency] ?? ""}`}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <h3 className="text-[13px] font-medium">{i.title}</h3>
              <span className="text-muted-foreground font-mono text-xs whitespace-nowrap">
                since {i.since}
              </span>
            </div>
            <p className="text-muted-foreground mt-0.5 text-xs">
              {i.affected
                ? `${i.affected} device${i.affected === 1 ? "" : "s"}`
                : "all access points"}
              {i.networks.length ? ` · ${i.networks.join(", ")}` : ""} ·{" "}
              {i.who_label}
              {i.confidence ? ` · confidence ${i.confidence}` : ""}
            </p>
            <p className="mt-1 text-[13px] leading-relaxed">
              <span className="font-semibold">
                {field === "do" ? "Do now: " : "IT: "}
              </span>
              {i[field]}
            </p>
          </li>
        ))}
      </ol>
    </section>
  );
}
