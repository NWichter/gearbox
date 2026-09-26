"""Upload checks: file type by magic number, size limits, safe file names.

A file is accepted when its first bytes are a pcap or pcapng header, directly or inside gzip.
The name must end with a capture extension, because the pipeline selects files by extension.
"""

from __future__ import annotations

import gzip
import re
import shutil
import zlib
from pathlib import Path
from typing import BinaryIO

from app.airframe.ingest import CAPTURE_EXT

MB = 1024 * 1024
CHUNK = MB

PCAP_MAGIC = {
    bytes.fromhex("d4c3b2a1"),  # little endian, microseconds
    bytes.fromhex("a1b2c3d4"),  # big endian, microseconds
    bytes.fromhex("4d3cb2a1"),  # little endian, nanoseconds
    bytes.fromhex("a1b23c4d"),  # big endian, nanoseconds
}
PCAPNG_MAGIC = bytes.fromhex("0a0d0d0a")
GZIP_MAGIC = bytes.fromhex("1f8b")


class UploadError(ValueError):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


def safe_name(filename: str | None) -> str:
    name = Path(filename or "capture.pcap").name
    return re.sub(r"[^A-Za-z0-9._-]", "_", name)[:120] or "capture.pcap"


def has_capture_ext(name: str) -> bool:
    return any(name.lower().endswith(e) for e in CAPTURE_EXT)


def capture_format(head: bytes) -> str | None:
    """'pcap', 'pcapng', 'pcap.gz', 'pcapng.gz' or None, from the first bytes of a file."""
    if head[:4] in PCAP_MAGIC:
        return "pcap"
    if head[:4] == PCAPNG_MAGIC:
        return "pcapng"
    if head[:2] == GZIP_MAGIC:
        try:
            inner = zlib.decompressobj(16 + zlib.MAX_WBITS).decompress(head, 64)
        except zlib.error:
            return None
        if inner[:4] in PCAP_MAGIC:
            return "pcap.gz"
        if inner[:4] == PCAPNG_MAGIC:
            return "pcapng.gz"
    return None


def save_capture(src: BinaryIO, dest: Path, max_bytes: int) -> int:
    """Copy one upload to dest after the magic-number check. Returns the byte count.

    Raises UploadError (and removes dest) when the file is not a capture or is too large.
    """
    name = dest.name
    if not has_capture_ext(name):
        raise UploadError(
            415,
            f"{name}: the file name must end with one of {', '.join(sorted(CAPTURE_EXT))}.",
        )
    head = src.read(64 * 1024)
    if not head:
        raise UploadError(400, f"{name}: the file is empty.")
    fmt = capture_format(head)
    if fmt is None:
        raise UploadError(
            415,
            f"{name}: this is not a pcap or pcapng capture (the first bytes do not match). Upload the sensor capture file.",
        )
    size = 0
    try:
        with open(dest, "wb") as out:
            chunk = head
            while chunk:
                size += len(chunk)
                if size > max_bytes:
                    raise UploadError(
                        413, f"{name}: the file is larger than {max_bytes // MB} MB."
                    )
                out.write(chunk)
                chunk = src.read(CHUNK)
    except BaseException:
        dest.unlink(missing_ok=True)
        raise
    if fmt.endswith(".gz"):
        check_gzip(dest)
    return size


def check_gzip(path: Path) -> None:
    """A truncated .gz file makes tshark stop in the middle. Read it once to the end."""
    try:
        with gzip.open(path, "rb") as f:
            while f.read(CHUNK):
                pass
    except (OSError, EOFError, zlib.error) as e:
        path.unlink(missing_ok=True)
        raise UploadError(
            400,
            f"{path.name}: the gzip file is damaged or incomplete ({e.__class__.__name__}).",
        ) from e


def remove_folder(folder: Path) -> None:
    shutil.rmtree(folder, ignore_errors=True)
