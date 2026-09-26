"""Upload checks: magic numbers, extensions, size limits, damaged gzip."""

import gzip
import io

import pytest

from app import uploads

PCAP_HEADER = bytes.fromhex(
    "d4c3b2a1020004000000000000000000ffff00007f000000"
)  # radiotap link type 127
PCAPNG_HEADER = bytes.fromhex(
    "0a0d0d0a1c0000004d3c2b1a01000000ffffffffffffffff1c000000"
)


@pytest.mark.parametrize(
    "head, fmt",
    [
        (PCAP_HEADER, "pcap"),
        (bytes.fromhex("a1b2c3d4") + PCAP_HEADER[4:], "pcap"),
        (bytes.fromhex("4d3cb2a1") + PCAP_HEADER[4:], "pcap"),
        (PCAPNG_HEADER, "pcapng"),
        (gzip.compress(PCAP_HEADER), "pcap.gz"),
        (gzip.compress(PCAPNG_HEADER), "pcapng.gz"),
        (b"%PDF-1.7 not a capture", None),
        (gzip.compress(b"hello world"), None),
        (b"version https://git-lfs.github.com/spec/v1\n", None),
    ],
)
def test_capture_format(head, fmt):
    assert uploads.capture_format(head) == fmt


def test_save_valid_pcap(tmp_path):
    n = uploads.save_capture(
        io.BytesIO(PCAP_HEADER * 10), tmp_path / "sensor01.pcap", 10_000
    )
    assert n == len(PCAP_HEADER) * 10
    assert (tmp_path / "sensor01.pcap").read_bytes()[:4] == PCAP_HEADER[:4]


@pytest.mark.parametrize(
    "name, data, status",
    [
        ("notes.txt", PCAP_HEADER, 415),
        ("sensor01.pcap", b"", 400),
        ("sensor01.pcap", b"PK\x03\x04 a zip file", 415),
        ("sensor01.pcap", PCAP_HEADER * 100, 413),
        ("sensor01.pcap.gz", gzip.compress(PCAP_HEADER * 50)[:40], 400),
    ],
)
def test_save_rejects(tmp_path, name, data, status):
    with pytest.raises(uploads.UploadError) as e:
        uploads.save_capture(io.BytesIO(data), tmp_path / name, 1000)
    assert e.value.status == status
    assert name in str(e.value)
    assert not (tmp_path / name).exists()


def test_safe_name():
    assert uploads.safe_name("../../etc/passwd") == "passwd"
    assert uploads.safe_name("sensor 01 (copy).pcap") == "sensor_01__copy_.pcap"
    assert uploads.safe_name(None) == "capture.pcap"
