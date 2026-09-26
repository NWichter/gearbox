"use client";

import { useCallback, useEffect, useState } from "react";
import {
  api,
  DATASET_KEY,
  pickDataset,
  type DatasetInfo,
  type LibraryEntry,
  type Result,
} from "@/lib/api";

// library: only datasets whose captures are a folder under the repo's data/ (the /final page)
async function loadDatasets(library: boolean) {
  if (!library) return { list: await api.datasets(), lib: [] };
  const [all, lib] = await Promise.all([api.datasets(), api.library()]);
  const ids = new Set(lib.map((e) => e.dataset_id));
  return { list: all.filter((d) => ids.has(d.id)), lib };
}

// Dataset list, the selected dataset and its result. Polls while the analysis runs.
// The selection is shared with the chat widget, the shop floor and the report (local storage).
export function useDataset({ library = false }: { library?: boolean } = {}) {
  const [datasets, setDatasets] = useState<DatasetInfo[]>([]);
  const [folders, setFolders] = useState<LibraryEntry[]>([]);
  const [dsId, setDsIdState] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [status, setStatus] = useState<string>("loading");

  const applyList = useCallback((list: DatasetInfo[]) => {
    setDatasets(list);
    setDsIdState((cur) => {
      if (cur) return cur;
      let stored: string | null = null;
      try {
        stored = localStorage.getItem(DATASET_KEY);
      } catch {
        // storage blocked: use the list order
      }
      return pickDataset(list, stored);
    });
    return list;
  }, []);

  const reload = useCallback(
    () =>
      loadDatasets(library).then(({ list, lib }) => {
        setFolders(lib);
        return applyList(list);
      }),
    [library, applyList],
  );

  useEffect(() => {
    reload()
      .then((list) => {
        if (!list.length) setStatus("empty");
      })
      .catch(() => setStatus("api offline"));
  }, [reload]);

  useEffect(() => {
    if (!dsId) return;
    try {
      localStorage.setItem(DATASET_KEY, dsId);
    } catch {
      // storage blocked: the other pages use the list order
    }
  }, [dsId]);

  useEffect(() => {
    if (!dsId) return;
    let stop = false;
    const poll = async () => {
      const d = await api.dataset(dsId);
      if (stop) return;
      setStatus(d.status === "failed" ? `failed: ${d.error}` : d.status);
      if (d.status === "done" && d.result) setResult(d.result);
      else {
        setResult(null);
        if (d.status !== "failed") setTimeout(poll, 2000);
      }
    };
    poll().catch((e) => setStatus(String(e)));
    return () => {
      stop = true;
    };
  }, [dsId]);

  const setDsId = useCallback((id: string) => {
    setResult(null);
    setStatus("loading");
    setDsIdState(id);
  }, []);

  const current = datasets.find((d) => d.id === dsId);
  return {
    datasets,
    folders,
    dsId,
    setDsId,
    result,
    status,
    reload,
    current,
  };
}
