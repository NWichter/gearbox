#!/usr/bin/env bash
# Extract Tesla's capture archive into internal/briefing/captures/ (git-ignored).
# Only the *.pcap files are kept; macOS metadata (__MACOSX/, .DS_Store) is dropped.
# The pcaps themselves are NOT modified. SHA-256 checksums are written next to them
# so every later step can be verified against the original files.
#
# Usage: tools/prepare_captures.sh [path/to/hackaton_airframe.zip]
set -euo pipefail

ZIP="${1:-$HOME/Downloads/hackaton_airframe.zip}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/internal/briefing/captures"

mkdir -p "$OUT"
unzip -o -j -q "$ZIP" 'hackaton_airframe/*.pcap' -d "$OUT"
(cd "$OUT" && sha256sum *.pcap > SHA256SUMS)
echo "Extracted to $OUT:"
cat "$OUT/SHA256SUMS"
