"use client";

import { Board } from "@/components/dashboard";
import { PendingState } from "@/components/dataset-state";
import { useReplay } from "@/components/replay";
import { ReplayTopBar } from "@/components/replay-top-bar";
import { SiteFooter, SiteHeader } from "@/components/site-chrome";
import { captureEnd, type LibraryEntry, type Result } from "@/lib/api";
import { useDataset } from "@/lib/use-dataset";

// Presentation build of the dashboard: no tabs, and the replay sits in a thin bar above the
// header that looks like part of the browser. Datasets come only from the repo's data/ folder.
export default function FinalDashboard() {
  const { folders, dsId, setDsId, result, status, current } = useDataset({
    library: true,
  });
  const picker = { folders, value: dsId, onChange: setDsId };

  if (result && dsId)
    return (
      <FinalBoard
        key={dsId}
        picker={picker}
        result={result}
        dsId={dsId}
        name={current?.name}
      />
    );
  return (
    <Frame bar={<ReplayTopBar {...picker} status={status} />}>
      <div className="pt-10">
        {status === "empty" ? (
          <EmptyLibrary folders={folders} />
        ) : (
          <PendingState status={status} name={current?.name} />
        )}
      </div>
    </Frame>
  );
}

type Picker = {
  folders: LibraryEntry[];
  value: string | null;
  onChange: (id: string) => void;
};

// the page opens at the end state; play starts the replay at 0:00
function FinalBoard({
  picker,
  result,
  dsId,
  name,
}: {
  picker: Picker;
  result: Result;
  dsId: string;
  name?: string;
}) {
  const end = captureEnd(result);
  const replay = useReplay(end, end);
  return (
    <Frame bar={<ReplayTopBar {...picker} replay={replay} result={result} />}>
      <Board
        result={result}
        dsId={dsId}
        name={name}
        replay={replay}
        simulation={false}
        pickerHint="in the dark bar at the very top"
      />
    </Frame>
  );
}

// replay bar (h-11) + header (h-14) stay on top; --chrome-h moves the sticky detail panel below them
function Frame({
  bar,
  children,
}: {
  bar: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      className="flex flex-1 flex-col"
      style={{ "--chrome-h": "6.25rem" } as React.CSSProperties}
    >
      <div className="sticky top-0 z-40">
        {bar}
        <SiteHeader nav={false} sticky={false} home="/final" />
      </div>
      <main className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-6 sm:px-8 sm:py-8">
        {children}
      </main>
      <SiteFooter />
    </div>
  );
}

function EmptyLibrary({ folders }: { folders: LibraryEntry[] }) {
  return (
    <div className="rounded-md border border-dashed px-4 py-6">
      <div className="text-[13px] font-medium">No analysed dataset</div>
      <p className="text-muted-foreground mt-0.5 text-xs">
        {folders.length
          ? `The folders under data/ (${folders.map((f) => f.folder).join(", ")}) have no analysis yet. Upload one with tools/upload_captures.sh data/<folder>.`
          : "There is no dataset folder with a SHA256SUMS file under data/."}
      </p>
    </div>
  );
}
