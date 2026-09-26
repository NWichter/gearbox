"""Runs analyses in a separate OS process, one at a time.

The pipeline is CPU-bound pandas code. In a thread of the API process it holds the GIL for
minutes, so the API cannot answer other requests (the site showed "Gateway Timeout"). Each
analysis therefore runs in its own spawned process. The API process only queues jobs, waits for
the child and handles a crash or a timeout.

Status of a dataset: queued -> running -> done | failed.
- One dataset is never queued twice: the claim is a conditional UPDATE in the database.
- A child that crashes or runs past ANALYSIS_TIMEOUT_S is stopped, and the dataset is marked failed.
- At start-up, "running" rows from an interrupted process are marked failed, and "queued" rows are
  queued again (they never started, so they cannot be the cause of the crash).
"""

from __future__ import annotations

import logging
import multiprocessing as mp
import pickle
import queue
import threading
import time
from pathlib import Path

import pandas as pd
from sqlalchemy import delete, select, update

from app.config import settings
from app.db import Dataset, FindingAck, SessionLocal

log = logging.getLogger("airframe.worker")

ACTIVE = ("queued", "running")
EVENTS_FILE = (
    "_events.pkl"  # client sequences for the sequence view, written by every analysis
)
LADDER_SKIP = ("ack", "beacon")
LADDER_COLS = [
    "t",
    "kind",
    "ta",
    "ra",
    "bssid",
    "reason",
    "status",
    "eap_code",
    "msg",
    "sensors",
    "best_rssi",
    "refs",
]


def dataset_dir(ds_id: str) -> Path:
    return Path(settings.upload_dir) / ds_id


def events_path(ds_id: str) -> Path:
    return dataset_dir(ds_id) / EVENTS_FILE


def save_events(ev: pd.DataFrame, path: Path) -> None:
    """Keep only what the sequence view needs (no ACKs, no beacons): about 1/8 of all events."""
    small = ev.loc[
        ~ev["kind"].isin(LADDER_SKIP), [c for c in LADDER_COLS if c in ev]
    ].reset_index(drop=True)
    tmp = path.with_suffix(".tmp")
    small.to_pickle(tmp)
    tmp.replace(path)


def load_events(path: Path) -> pd.DataFrame | None:
    try:
        return pd.read_pickle(path)
    except (OSError, EOFError, pickle.UnpicklingError, ValueError):
        return None


def _set_failed(ds_id: str, message: str) -> None:
    with SessionLocal() as s:
        ds = s.get(Dataset, ds_id)
        if ds is not None:
            ds.status, ds.error = "failed", message[:2000]
            s.commit()


def run_job(ds_id: str, mode: str = "full") -> None:
    """Entry point of the child process.

    mode "full": analyse the dataset and store the result.
    mode "events": rebuild only the events file for the sequence view (no status change).
    """
    logging.basicConfig(level=logging.INFO)
    if mode == "events":
        from app.airframe.fuse import fuse
        from app.airframe.ingest import find_captures, read_all

        ev, _, _ = fuse(read_all(find_captures(dataset_dir(ds_id))))
        save_events(ev, events_path(ds_id))
        return

    from app.airframe.pipeline import analyze  # heavy imports only in the child

    with SessionLocal() as s:
        ds = s.get(Dataset, ds_id)
        if ds is None:
            return
        ds.status, ds.error = "running", None
        s.commit()
    try:
        result, ev = analyze(dataset_dir(ds_id))
        try:
            save_events(ev, events_path(ds_id))
        except OSError:  # the sequence view is optional; the result is not
            log.exception("could not write the events file of %s", ds_id)
        with SessionLocal() as s:
            ds = s.get(Dataset, ds_id)
            ds.status, ds.error, ds.summary, ds.result = (
                "done",
                None,
                result["summary"],
                result,
            )
            # finding ids are renumbered by every analysis, so old acks would point at other findings
            s.execute(delete(FindingAck).where(FindingAck.dataset_id == ds_id))
            s.commit()
    except Exception as e:  # surface pipeline errors in the UI
        log.exception("analysis of %s failed", ds_id)
        _set_failed(ds_id, f"{e.__class__.__name__}: {e}")


class AnalysisRunner:
    """A queue of dataset ids and one dispatcher thread that starts one child process per job."""

    def __init__(self, timeout_s: float | None = None, on_done=None) -> None:
        self.timeout_s = timeout_s or settings.analysis_timeout_s
        self.on_done = (
            on_done  # called with the dataset id after every job (cache invalidation)
        )
        self._q: queue.Queue[tuple[str, str] | None] = queue.Queue()
        self._inflight: set[str] = set()
        self._lock = threading.Lock()
        self._current: str | None = None
        self._thread: threading.Thread | None = None
        self._ctx = mp.get_context(
            "spawn"
        )  # a fresh interpreter: no forked DB connections or threads

    # ------------------------------------------------------------ public API
    def start(self) -> None:
        if self._thread is None or not self._thread.is_alive():
            self._thread = threading.Thread(
                target=self._loop, name="analysis-dispatcher", daemon=True
            )
            self._thread.start()

    def stop(self) -> None:
        self._q.put(None)

    def enqueue(self, ds_id: str, claim: bool = True) -> bool:
        """Queue an analysis. Returns False when this dataset is already queued or running.

        claim=True sets the status to "queued" only if no analysis is active for the dataset (a
        conditional UPDATE, so two API processes cannot start the same dataset twice either).
        claim=False is for rows that the caller already wrote as "queued".
        """
        with self._lock:
            if ds_id in self._inflight:
                return False
            if claim:
                with SessionLocal() as s:
                    n = s.execute(
                        update(Dataset)
                        .where(Dataset.id == ds_id, Dataset.status.not_in(ACTIVE))
                        .values(status="queued", error=None)
                    ).rowcount
                    s.commit()
                if n != 1:
                    return False
            self._inflight.add(ds_id)
        self._q.put((ds_id, "full"))
        return True

    def enqueue_events(self, ds_id: str) -> bool:
        """Rebuild the events file of a finished dataset (for data analysed before the file existed)."""
        with self._lock:
            if ds_id in self._inflight:
                return False
            self._inflight.add(ds_id)
        self._q.put((ds_id, "events"))
        return True

    def busy(self, ds_id: str) -> bool:
        with self._lock:
            return ds_id in self._inflight

    def state(self) -> dict:
        return {"running": self._current, "queued": max(0, self._q.qsize())}

    def recover(self) -> dict:
        """After a restart: fail interrupted runs, queue again what never started."""
        with SessionLocal() as s:
            running = s.scalars(
                select(Dataset.id).where(Dataset.status == "running")
            ).all()
            queued = s.scalars(
                select(Dataset.id).where(Dataset.status == "queued")
            ).all()
        for ds_id in running:
            _set_failed(
                ds_id,
                "The analysis stopped because the server restarted. Start it again with POST /datasets/{id}/reanalyze.",
            )
        for ds_id in queued:
            self.enqueue(ds_id, claim=False)
        return {"failed": list(running), "requeued": list(queued)}

    # ------------------------------------------------------------ dispatcher
    def _loop(self) -> None:
        while True:
            item = self._q.get()
            if item is None:
                return
            ds_id, mode = item
            self._current = ds_id
            try:
                self._run_one(ds_id, mode)
            except Exception as e:  # the dispatcher must survive any single job
                log.exception("dispatcher error for %s", ds_id)
                if mode == "full":  # never leave a dataset in "queued" or "running"
                    try:
                        _set_failed(
                            ds_id,
                            f"The analysis could not start ({e.__class__.__name__}).",
                        )
                    except Exception:
                        log.exception("could not mark %s as failed", ds_id)
            finally:
                self._current = None
                with self._lock:
                    self._inflight.discard(ds_id)
                if self.on_done:
                    try:
                        self.on_done(ds_id)
                    except Exception:
                        log.exception("on_done callback failed")

    def _run_one(self, ds_id: str, mode: str = "full") -> None:
        t0 = time.monotonic()
        p = self._ctx.Process(
            target=run_job, args=(ds_id, mode), name=f"analysis-{ds_id}", daemon=True
        )
        p.start()
        p.join(self.timeout_s)
        if p.is_alive():
            p.terminate()
            p.join(10)
            if p.is_alive():
                p.kill()
                p.join()
            if mode == "full":
                _set_failed(
                    ds_id,
                    f"The analysis took longer than {self.timeout_s:.0f} s and was stopped.",
                )
            log.error(
                "analysis of %s timed out after %.0f s", ds_id, time.monotonic() - t0
            )
            return
        if p.exitcode != 0 and mode == "full":
            # the child died without writing a status (out of memory, segfault in a C library)
            with SessionLocal() as s:
                ds = s.get(Dataset, ds_id)
                status = ds.status if ds else None
            if status in ACTIVE:
                _set_failed(
                    ds_id,
                    f"The analysis process stopped unexpectedly (exit code {p.exitcode}).",
                )
        log.info(
            "%s job for %s finished in %.1f s (exit code %s)",
            mode,
            ds_id,
            time.monotonic() - t0,
            p.exitcode,
        )
