"""API on SQLite: health, readiness, uploads, the analysis runner, acknowledgements, explain, chat."""

import time
import uuid

import pandas as pd
import pytest
from conftest import finding
from fastapi.testclient import TestClient
from sqlalchemy import select

from app import main, worker
from app.db import Dataset, FindingAck, SessionLocal

PCAP_HEADER = bytes.fromhex("d4c3b2a1020004000000000000000000ffff00007f000000")


@pytest.fixture(scope="module")
def client(db):
    with TestClient(main.app) as c:
        yield c


def add_dataset(status="done", result=None) -> str:
    ds_id = uuid.uuid4().hex[:12]
    worker.dataset_dir(ds_id).mkdir(parents=True, exist_ok=True)
    with SessionLocal() as s:
        s.add(
            Dataset(
                id=ds_id,
                name="test",
                status=status,
                result=result,
                summary=(result or {}).get("summary"),
            )
        )
        s.commit()
    return ds_id


def small_result() -> dict:
    fs = [finding(id=1), finding(id=2, type="radius_outage", client=None)]
    return {
        "summary": {
            "sensors": 2,
            "aps": 1,
            "clients": 1,
            "duration_s": 60,
            "findings": 2,
        },
        "findings": fs,
    }


def status_of(ds_id: str) -> Dataset:
    with SessionLocal() as s:
        return s.get(Dataset, ds_id)


def test_health_and_ready(client):
    t0 = time.perf_counter()
    r = client.get("/health")
    assert r.status_code == 200 and r.json()["status"] == "ok"
    assert time.perf_counter() - t0 < 1.0
    r = client.get("/ready")
    assert r.status_code == 200 and r.json() == {"status": "ok", "database": "ok"}


def test_ready_reports_database_down(client, monkeypatch):
    def broken():
        raise ConnectionError("db down")

    monkeypatch.setattr(main, "SessionLocal", broken)
    r = client.get("/ready")
    assert r.status_code == 503
    assert r.json()["status"] == "unavailable"
    # liveness does not depend on the database
    assert client.get("/health").status_code == 200


def test_upload_rejects_non_capture(client):
    root = worker.dataset_dir("x").parent
    root.mkdir(parents=True, exist_ok=True)
    before = set(root.iterdir())
    r = client.post(
        "/datasets", files=[("files", ("sensor01.pcap", b"<html>not a pcap</html>"))]
    )
    assert r.status_code == 415
    assert "not a pcap or pcapng capture" in r.json()["detail"]
    assert (
        set(worker.dataset_dir("x").parent.iterdir()) == before
    )  # no folder left behind


def test_upload_rejects_too_many_files(client, monkeypatch):
    monkeypatch.setattr(main.settings, "max_upload_files", 1)
    files = [("files", (f"s{i}.pcap", PCAP_HEADER)) for i in range(2)]
    assert client.post("/datasets", files=files).status_code == 413


def test_upload_runs_analysis_in_a_child_process(client):
    """A valid but empty capture: the child process runs the pipeline and the dataset ends as failed.

    Without tshark (a developer machine) the error names tshark, with tshark it says "no 802.11 frames".
    Both prove the full path: upload -> queue -> child process -> status in the database.
    """
    r = client.post(
        "/datasets",
        files=[("files", ("sensor01.pcap", PCAP_HEADER))],
        data={"name": "empty"},
    )
    assert r.status_code == 200
    ds_id = r.json()["id"]
    assert r.json()["status"] == "queued"
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        ds = status_of(ds_id)
        if ds.status in ("done", "failed"):
            break
        assert client.get("/health").status_code == 200
        time.sleep(0.2)
    assert ds.status == "failed"
    assert "tshark" in ds.error or "no 802.11 frames" in ds.error


def test_reanalyze_is_refused_while_active(client):
    ds_id = add_dataset(status="running")
    r = client.post(f"/datasets/{ds_id}/reanalyze")
    assert r.status_code == 409
    assert status_of(ds_id).status == "running"


def test_runner_guards_duplicates_and_recovers(db):
    r = worker.AnalysisRunner()  # not started: jobs stay in the queue
    a = add_dataset(status="done")
    assert r.enqueue(a) is True
    assert r.enqueue(a) is False
    assert status_of(a).status == "queued"
    b, c = add_dataset(status="running"), add_dataset(status="queued")
    rec = r.recover()
    assert b in rec["failed"] and c in rec["requeued"]
    assert status_of(b).status == "failed"
    assert "server restarted" in status_of(b).error
    assert r.busy(c)


def test_run_job_stores_result_clears_acks_and_writes_events(db, monkeypatch):
    ds_id = add_dataset(status="queued", result=small_result())
    with SessionLocal() as s:
        s.add(
            FindingAck(
                dataset_id=ds_id,
                finding_id=1,
                state="ack",
                at=pd.Timestamp.now(tz="UTC").to_pydatetime(),
            )
        )
        s.commit()
    ev = pd.DataFrame(
        {
            "t": [1.0, 2.0],
            "kind": ["auth", "beacon"],
            "ta": ["3c:58:c2:00:00:01", "00:0b:86:01:00:00"],
            "ra": ["00:0b:86:01:00:00", "ff:ff:ff:ff:ff:ff"],
            "bssid": ["00:0b:86:01:00:00"] * 2,
            "reason": [None, None],
            "status": [0.0, None],
            "eap_code": [None, None],
            "msg": [None, None],
            "sensors": [["sensor01"], ["sensor01"]],
            "best_rssi": [-70.0, -60.0],
            "refs": [[{"sensor": "sensor01", "frame": 1, "rssi": -70}], []],
        }
    )
    import app.airframe.pipeline as pipeline

    monkeypatch.setattr(pipeline, "analyze", lambda folder: (small_result(), ev))
    worker.run_job(ds_id)
    ds = status_of(ds_id)
    assert ds.status == "done" and ds.error is None
    with SessionLocal() as s:
        assert (
            s.scalars(select(FindingAck).where(FindingAck.dataset_id == ds_id)).all()
            == []
        )
    saved = worker.load_events(worker.events_path(ds_id))
    assert list(saved["kind"]) == ["auth"]  # beacons are not kept for the sequence view


def test_run_job_failure_is_stored(db, monkeypatch):
    ds_id = add_dataset(status="queued")
    import app.airframe.pipeline as pipeline

    def boom(folder):
        raise ValueError("broken capture")

    monkeypatch.setattr(pipeline, "analyze", boom)
    worker.run_job(ds_id)
    ds = status_of(ds_id)
    assert ds.status == "failed" and ds.error == "ValueError: broken capture"


def test_acks(client):
    ds_id = add_dataset(result=small_result())
    assert client.get(f"/datasets/{ds_id}/acks").json() == {}
    r = client.post(f"/datasets/{ds_id}/findings/1/ack", json={"state": "ack"})
    assert r.status_code == 200 and r.json()["1"]["state"] == "ack"
    r = client.post(f"/datasets/{ds_id}/findings/1/ack", json={"state": "done"})
    assert r.json()["1"]["state"] == "done"
    assert r.json()["1"]["at"].endswith("+00:00")
    r = client.post(f"/datasets/{ds_id}/findings/1/ack", json={"state": None})
    assert r.json() == {}
    assert (
        client.post(
            f"/datasets/{ds_id}/findings/99/ack", json={"state": "ack"}
        ).status_code
        == 404
    )
    assert (
        client.post(
            f"/datasets/{ds_id}/findings/1/ack", json={"state": "maybe"}
        ).status_code
        == 422
    )


def test_explain_without_llm_gives_fallback(client):
    ds_id = add_dataset(result=small_result())
    r = client.post(f"/datasets/{ds_id}/findings/1/explain")
    assert r.status_code == 200
    body = r.json()
    assert body["source"] == "fallback" and body["ai"] is False
    assert body["text"].startswith("What happens:")


def test_sequence_view_without_events_file_is_503(client, monkeypatch):
    ds_id = add_dataset(result=small_result())
    queued = []
    monkeypatch.setattr(
        main.runner, "enqueue_events", lambda i: queued.append(i) or True
    )
    r = client.get(f"/datasets/{ds_id}/clients/3c:58:c2:00:00:01")
    assert r.status_code == 503
    assert r.headers["retry-after"] == "120"
    assert queued == [ds_id]


def test_chat_without_llm(client):
    r = client.post("/chat", json={"question": "Wie geht das?", "session": "s1"})
    assert r.status_code == 200
    assert r.json()["ok"] is False
    assert "not available" in r.json()["answer"]
