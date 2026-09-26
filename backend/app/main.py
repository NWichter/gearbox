import hashlib
import logging
import shutil
import threading
import uuid
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import JSONResponse, PlainTextResponse
from pydantic import BaseModel
from sqlalchemy import delete, select, text

from app import library, uploads
from app.airframe import chat as chatbot
from app.airframe import report as shift_report
from app.airframe.explain import explain
from app.airframe.pipeline import client_ladder
from app.config import settings
from app.db import Base, ChatLog, Dataset, Explanation, FindingAck, SessionLocal, engine
from app.worker import AnalysisRunner, dataset_dir, events_path, load_events

log = logging.getLogger("airframe")
# dataset id -> events for the sequence view (one dataset at a time)
events_cache: dict = {}
events_lock = threading.Lock()
explain_locks: dict[tuple[str, str], threading.Lock] = {}
explain_locks_guard = threading.Lock()


def _analysis_done(ds_id: str) -> None:
    with events_lock:
        events_cache.pop(ds_id, None)


runner = AnalysisRunner(on_done=_analysis_done)

# retired built-in dataset; removed from existing databases at startup
RETIRED_IDS = ("demo-synthetic",)


def drop_retired_datasets() -> None:
    """Idempotent: delete retired datasets, their cached explanations, chat logs and upload folders."""
    with SessionLocal() as s:
        s.execute(delete(Explanation).where(Explanation.dataset_id.in_(RETIRED_IDS)))
        s.execute(delete(ChatLog).where(ChatLog.dataset_id.in_(RETIRED_IDS)))
        s.execute(delete(FindingAck).where(FindingAck.dataset_id.in_(RETIRED_IDS)))
        s.execute(delete(Dataset).where(Dataset.id.in_(RETIRED_IDS)))
        s.commit()
    root = Path(settings.upload_dir).resolve()
    for ds_id in RETIRED_IDS:
        folder = (root / ds_id).resolve()
        if folder.parent == root and folder.is_dir():
            shutil.rmtree(folder, ignore_errors=True)


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(engine)
    try:
        drop_retired_datasets()
    except Exception:  # cleanup must never block startup
        log.exception("retired dataset cleanup failed")
    runner.start()
    try:
        rec = runner.recover()
        if rec["failed"] or rec["requeued"]:
            log.warning("interrupted analyses: %s", rec)
    except Exception:  # recovery must never block startup
        log.exception("recovery of interrupted analyses failed")
    # hash the uploads once in the background so the first /library call is fast
    threading.Thread(target=_library_entries, daemon=True).start()
    yield
    runner.stop()


app = FastAPI(title="Airframe API", lifespan=lifespan)


@app.get("/health")
def health():
    """Liveness: the process runs and answers. No database call, so it stays fast during analyses."""
    return {"status": "ok", "analysis": runner.state()}


@app.get("/ready")
def ready():
    """Readiness: the database answers. 503 when it does not."""
    try:
        with SessionLocal() as s:
            s.execute(text("select 1"))
    except Exception as e:
        return JSONResponse(
            status_code=503,
            content={"status": "unavailable", "database": e.__class__.__name__},
        )
    return {"status": "ok", "database": "ok"}


@app.get("/datasets")
def list_datasets():
    with SessionLocal() as s:
        rows = s.scalars(select(Dataset).order_by(Dataset.created_at.desc())).all()
        return [
            {
                "id": d.id,
                "kind": "capture",
                "name": d.name,
                "status": d.status,
                "error": d.error,
                "summary": d.summary,
                "created_at": d.created_at,
            }
            for d in rows
        ]


def _library_entries() -> list[dict]:
    with SessionLocal() as s:
        rows = s.scalars(select(Dataset)).all()
        datasets = [
            {"id": d.id, "name": d.name, "status": d.status, "created_at": d.created_at}
            for d in rows
        ]
    return library.entries(datasets)


@app.get("/library")
def list_library():
    """Datasets from the repo's data/ folder, each matched to its analysed upload."""
    return _library_entries()


def _writable() -> None:
    if settings.read_only:
        raise HTTPException(403, "read-only demo: uploads and re-analysis are switched off")


@app.post("/datasets")
def upload_dataset(files: list[UploadFile] = File(...), name: str = Form("")):
    """Upload one capture per sensor (pcap or pcapng, gzip allowed) and queue the analysis."""
    _writable()
    if len(files) > settings.max_upload_files:
        raise HTTPException(
            413, f"Too many files: {len(files)}. The limit is {settings.max_upload_files}."
        )
    ds_id = uuid.uuid4().hex[:12]
    folder = dataset_dir(ds_id)
    folder.mkdir(parents=True, exist_ok=True)
    per_file = settings.max_upload_file_mb * uploads.MB
    left = settings.max_upload_total_mb * uploads.MB
    names: set[str] = set()
    try:
        for f in files:
            safe = uploads.safe_name(f.filename)
            if safe in names:
                raise uploads.UploadError(400, f"{safe}: two files have the same name.")
            names.add(safe)
            if left <= 0:
                raise uploads.UploadError(
                    413, f"The upload is larger than {settings.max_upload_total_mb} MB in total."
                )
            left -= uploads.save_capture(f.file, folder / safe, min(per_file, left))
    except uploads.UploadError as e:
        uploads.remove_folder(folder)
        raise HTTPException(e.status, str(e)) from e
    except Exception:
        uploads.remove_folder(folder)
        raise
    label = name or ", ".join(f.filename or "?" for f in files)
    with SessionLocal() as s:
        s.add(Dataset(id=ds_id, name=label[:200], status="queued"))
        s.commit()
    runner.enqueue(ds_id, claim=False)
    return {"id": ds_id, "status": "queued"}


def _get(ds_id: str) -> Dataset:
    with SessionLocal() as s:
        ds = s.get(Dataset, ds_id)
    if ds is None:
        raise HTTPException(404, "dataset not found")
    return ds


@app.get("/datasets/{ds_id}")
def get_dataset(ds_id: str):
    ds = _get(ds_id)
    return {
        "id": ds.id,
        "kind": "capture",
        "name": ds.name,
        "status": ds.status,
        "error": ds.error,
        "result": ds.result,
    }


@app.post("/datasets/{ds_id}/reanalyze")
def reanalyze(ds_id: str):
    _writable()
    _get(ds_id)
    if not runner.enqueue(ds_id):
        raise HTTPException(409, "An analysis of this dataset is already queued or running.")
    return {"status": "queued"}


def _events(ds_id: str):
    with events_lock:
        ev = events_cache.get(ds_id)
    if ev is not None:
        return ev
    ev = load_events(events_path(ds_id))
    if ev is not None:
        with events_lock:
            events_cache.clear()
            events_cache[ds_id] = ev
    return ev


@app.get("/datasets/{ds_id}/clients/{mac}")
def client_sequence(ds_id: str, mac: str):
    ds = _get(ds_id)
    if ds.status != "done":
        raise HTTPException(409, "The analysis is not finished.")
    ev = _events(ds_id)
    if ev is None:
        # analysed before the events file existed: rebuild it in the analysis process, not here
        runner.enqueue_events(ds_id)
        raise HTTPException(
            503,
            "The sequence view is being prepared (about 2 minutes). Try again then.",
            headers={"Retry-After": "120"},
        )
    return {"client": mac, "events": client_ladder(ev, mac.lower())}


@app.post("/datasets/{ds_id}/findings/{fid}/explain")
def explain_finding(ds_id: str, fid: int):
    ds = _get(ds_id)
    if not ds.result:
        raise HTTPException(409, "analysis not finished")
    f = next((x for x in ds.result["findings"] if x["id"] == fid), None)
    if f is None:
        raise HTTPException(404, "finding not found")
    model = settings.llm_model
    fkey = hashlib.sha1(
        f"{f['type']}|{f.get('client')}|{f.get('bssid')}|{f['t_start']:.1f}|{f['title']}".encode()
    ).hexdigest()[:16]
    with explain_locks_guard:
        lock = explain_locks.setdefault((ds_id, fkey), threading.Lock())
    # single-flight: concurrent clicks wait for the first call instead of paying twice
    with lock:
        with SessionLocal() as s:
            cached = s.get(Explanation, (ds_id, fkey, model))
            if cached:
                return {"text": cached.text, "ai": True, "source": "llm", "model": model, "cached": True}
        keys = ("sensors", "aps", "clients", "duration_s")
        ctx = {k: ds.result["summary"].get(k) for k in keys}
        text_, source = explain(f, ctx)
        ok = source == "llm"
        if ok:  # only LLM answers are cached; after a fallback the next click tries the LLM again
            with SessionLocal() as s:
                s.merge(Explanation(dataset_id=ds_id, finding_key=fkey, model=model, text=text_))
                s.commit()
        return {
            "text": text_,
            "ai": ok,
            "source": source,
            "model": model if ok else None,
            "cached": False,
        }


def _acks(s, ds_id: str) -> dict:
    rows = s.scalars(select(FindingAck).where(FindingAck.dataset_id == ds_id)).all()
    # SQLite drops the zone; timestamps are always written in UTC
    return {str(r.finding_id): {"state": r.state, "at": (r.at if r.at.tzinfo else r.at.replace(tzinfo=UTC)).isoformat()} for r in rows}


@app.get("/datasets/{ds_id}/acks")
def get_acks(ds_id: str):
    _get(ds_id)
    with SessionLocal() as s:
        return _acks(s, ds_id)


class AckIn(BaseModel):
    state: Literal["ack", "done"] | None = None


@app.post("/datasets/{ds_id}/findings/{fid}/ack")
def ack_finding(ds_id: str, fid: int, body: AckIn):
    """Set ("ack" = seen, "done" = fixed) or clear (null) a finding's state; returns all acks of the dataset."""
    ds = _get(ds_id)
    if not ds.result or not any(x["id"] == fid for x in ds.result["findings"]):
        raise HTTPException(404, "finding not found")
    with SessionLocal() as s:
        if body.state is None:
            s.execute(delete(FindingAck).where(FindingAck.dataset_id == ds_id, FindingAck.finding_id == fid))
        else:
            s.merge(FindingAck(dataset_id=ds_id, finding_id=fid, state=body.state, at=datetime.now(UTC)))
        s.commit()
        return _acks(s, ds_id)


class ChatIn(BaseModel):
    question: str
    session: str
    page: str | None = None
    dataset_id: str | None = None
    history: list[dict] = []


@app.post("/chat")
def chat(body: ChatIn):
    result = None
    if body.dataset_id:
        with SessionLocal() as s:
            ds = s.get(Dataset, body.dataset_id)
            result = ds.result if ds else None
    text_, ok = chatbot.answer(body.question, body.history, body.page, result)
    log_id = uuid.uuid4().hex[:16]
    with SessionLocal() as s:
        s.add(ChatLog(
            id=log_id, session=body.session[:60], page=(body.page or "")[:200], dataset_id=body.dataset_id,
            question=body.question[:4000], answer=text_, model=settings.llm_model if ok else None, ok=ok,
        ))
        s.commit()
    return {"id": log_id, "answer": text_, "ok": ok}


class FeedbackIn(BaseModel):
    helpful: bool


@app.post("/chat/{log_id}/feedback")
def chat_feedback(log_id: str, body: FeedbackIn):
    with SessionLocal() as s:
        row = s.get(ChatLog, log_id)
        if row is None:
            raise HTTPException(404, "not found")
        row.helpful = body.helpful
        s.commit()
    return {"ok": True}


@app.get("/chat/log")
def chat_log(limit: int = 200, x_admin_token: str | None = Header(default=None)):
    """Questions and answers for improving the site. Protected by ADMIN_TOKEN."""
    if not settings.admin_token or x_admin_token != settings.admin_token:
        raise HTTPException(403, "admin token required")
    with SessionLocal() as s:
        rows = s.scalars(select(ChatLog).order_by(ChatLog.created_at.desc()).limit(limit)).all()
        return [
            {"id": r.id, "at": r.created_at, "session": r.session, "page": r.page, "question": r.question,
             "answer": r.answer, "ok": r.ok, "helpful": r.helpful, "model": r.model}
            for r in rows
        ]


@app.get("/datasets/{ds_id}/report")
def get_report(ds_id: str):
    ds = _get(ds_id)
    if not ds.result:
        raise HTTPException(409, "analysis not finished")
    return shift_report.build(ds.result, ds.name)


@app.get("/datasets/{ds_id}/report.md", response_class=PlainTextResponse)
def get_report_md(ds_id: str):
    ds = _get(ds_id)
    if not ds.result:
        raise HTTPException(409, "analysis not finished")
    return shift_report.markdown(shift_report.build(ds.result, ds.name))
