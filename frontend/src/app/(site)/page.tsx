"use client";

import { Board } from "@/components/dashboard";
import { DashboardSwitch } from "@/components/dashboard-switch";
import { DatasetPicker, PendingState } from "@/components/dataset-state";
import { useReplay } from "@/components/replay";
import { captureEnd, type Result } from "@/lib/api";
import { useDataset } from "@/lib/use-dataset";

export default function Dashboard() {
  const { datasets, dsId, setDsId, result, status, reload, current } =
    useDataset();
  return (
    <div className="relative">
      <DashboardSwitch className="mb-4" />
      <DatasetPicker
        className="mb-4 justify-end sm:absolute sm:top-0 sm:right-0 sm:mb-0"
        datasets={datasets}
        value={dsId}
        onChange={setDsId}
        onUploaded={async (id) => {
          await reload();
          setDsId(id);
        }}
      />
      {result && dsId ? (
        <SiteBoard
          key={dsId}
          result={result}
          dsId={dsId}
          name={current?.name}
        />
      ) : (
        <div className="pt-10">
          <PendingState status={status} name={current?.name} />
        </div>
      )}
    </div>
  );
}

// the dashboard opens at the end state; play starts the simulation at 0:00
function SiteBoard(props: { result: Result; dsId: string; name?: string }) {
  const end = captureEnd(props.result);
  const replay = useReplay(end, end);
  return <Board {...props} replay={replay} />;
}
