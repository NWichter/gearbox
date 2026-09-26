"""Dataset library: every folder under DATA_DIR with a SHA256SUMS file is one dataset.

The captures are Git LFS objects that clones and deployments skip, so only SHA256SUMS ships with
the image. A folder is matched to an analysed dataset by the content hashes of its captures:
uploads are gzip-compressed (lossless), so the hash of the decompressed bytes equals the original.
"""

import gzip
import hashlib
import json
import logging
import threading
from pathlib import Path

from app.airframe.ingest import find_captures
from app.config import settings

log = logging.getLogger("airframe")
_lock = threading.Lock()
CACHE_NAME = ".content-sha256.json"  # upload root, outside every dataset folder


def read_sums(folder: Path) -> dict[str, str]:
    """`sha256sum` output (`<hash>  <name>` or `<hash> *<name>`) -> {name: hash}."""
    sums = {}
    for line in (folder / "SHA256SUMS").read_text().splitlines():
        parts = line.strip().split(maxsplit=1)
        if len(parts) == 2:
            sums[parts[1].lstrip("*")] = parts[0].lower()
    return sums


def folders() -> list[tuple[str, dict[str, str]]]:
    root = Path(settings.data_dir)
    if not root.is_dir():
        return []
    return [
        (d.name, read_sums(d))
        for d in sorted(root.iterdir())
        if d.is_dir() and (d / "SHA256SUMS").is_file()
    ]


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with (gzip.open if path.name.endswith(".gz") else open)(path, "rb") as f:
        while chunk := f.read(1 << 20):
            h.update(chunk)
    return h.hexdigest()


def content_hashes(upload_root: Path, ds_ids: list[str]) -> dict[str, frozenset[str]]:
    """Capture hashes per uploaded dataset. Uploads never change, so results are cached on disk."""
    cache_file = upload_root / CACHE_NAME
    with _lock:
        try:
            cache = json.loads(cache_file.read_text())
        except (OSError, ValueError):
            cache = {}
        changed = False
        for ds_id in ds_ids:
            folder = upload_root / ds_id
            if ds_id in cache or not folder.is_dir():
                continue
            try:
                cache[ds_id] = sorted(_sha256(p) for p in find_captures(folder))
                changed = True
            except (OSError, EOFError, gzip.BadGzipFile):
                log.exception("cannot hash dataset %s", ds_id)
        if changed:
            try:
                cache_file.write_text(json.dumps(cache))
            except OSError:
                log.exception("cannot write %s", cache_file)
    return {k: frozenset(v) for k, v in cache.items() if k in ds_ids}


def entries(datasets: list[dict]) -> list[dict]:
    """One entry per library folder with the newest matching dataset (done ones first)."""
    datasets = sorted(
        datasets, key=lambda d: (d["status"] != "done", -d["created_at"].timestamp())
    )
    hashes = content_hashes(Path(settings.upload_dir), [d["id"] for d in datasets])
    out = []
    for name, sums in folders():
        want = frozenset(sums.values())
        match = next((d for d in datasets if want and hashes.get(d["id"]) == want), None)
        out.append(
            {
                "folder": name,
                "files": sorted(sums),
                "dataset_id": match["id"] if match else None,
                "name": match["name"] if match else name,
                "status": match["status"] if match else "missing",
            }
        )
    return out
