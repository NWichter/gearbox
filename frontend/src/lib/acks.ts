"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, fmtClock, type AckMap, type AckState } from "@/lib/api";

// Shift-lead acknowledgement per finding. The backend keeps them per dataset so every screen on
// the floor converges (poll every 10 s). `at` is wall-clock time from the server; `t` is the
// replay position when the click happened in this browser (lets a fixed line resume where it
// stopped). If the backend has no ack endpoints (older deployment) everything falls back to
// this browser's localStorage.
export type { AckState };
export type Ack = { state: AckState; at: string; t?: number };
export type Acks = Record<number, Ack>;

const POLL_MS = 10_000;
const localKey = (dsId: string) => `gearbox.acks.${dsId}`;
const timesKey = (dsId: string) => `gearbox.ack-times.${dsId}`;

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage blocked: state lives for this page view only
  }
}

function fromServer(map: AckMap, times: Record<number, number>): Acks {
  const out: Acks = {};
  for (const [id, a] of Object.entries(map)) {
    if (!a || (a.state !== "ack" && a.state !== "done")) continue;
    const n = Number(id);
    out[n] = { state: a.state, at: a.at, t: times[n] };
  }
  return out;
}

// "12:31:07": capture clock when the replay time is known, else the wall clock (UTC)
export function ackClock(a: Ack, startEpoch: number | null | undefined) {
  if (a.t != null && startEpoch != null) return fmtClock(startEpoch, a.t);
  const d = new Date(a.at);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(11, 19);
}

export function useAcks(dsId: string) {
  // local copy first so a reload shows the last state at once; the server then takes over
  const [acks, setAcks] = useState<Acks>(() => read<Acks>(localKey(dsId), {}));
  const [mode, setMode] = useState<"pending" | "server" | "local">("pending");
  const modeRef = useRef(mode);
  const acksRef = useRef(acks);
  // bumps on every local change; a poll that started before it is stale
  const rev = useRef(0);

  useEffect(() => {
    modeRef.current = mode;
    acksRef.current = acks;
    write(localKey(dsId), acks);
  }, [acks, mode, dsId]);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const started = rev.current;
      try {
        const map = await api.acks(dsId);
        if (stop) return;
        if (started === rev.current)
          setAcks(fromServer(map, read(timesKey(dsId), {})));
        setMode("server");
        timer = setTimeout(poll, POLL_MS);
      } catch {
        // no ack endpoints on this backend: stay in this browser
        if (!stop && modeRef.current !== "server") setMode("local");
        else if (!stop) timer = setTimeout(poll, POLL_MS);
      }
    };
    poll();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [dsId]);

  const set = useCallback(
    async (id: number, state: AckState | null, t: number) => {
      rev.current += 1;
      const times = read<Record<number, number>>(timesKey(dsId), {});
      if (state) times[id] = t;
      else delete times[id];
      write(timesKey(dsId), times);

      const next = { ...acksRef.current };
      if (state) next[id] = { state, at: new Date().toISOString(), t };
      else delete next[id];
      acksRef.current = next;
      setAcks(next); // optimistic

      if (modeRef.current === "local") return;
      try {
        const map = await api.ack(dsId, id, state);
        rev.current += 1;
        setAcks(fromServer(map, times));
        setMode("server");
      } catch {
        setMode("local");
      }
    },
    [dsId],
  );

  const reset = useCallback(async () => {
    const ids = Object.keys(acksRef.current).map(Number);
    rev.current += 1;
    write(timesKey(dsId), {});
    acksRef.current = {};
    setAcks({});
    if (modeRef.current === "local") return;
    try {
      await Promise.all(ids.map((id) => api.ack(dsId, id, null)));
    } catch {
      setMode("local");
    }
  }, [dsId]);

  return { acks, set, reset, shared: mode === "server" };
}
