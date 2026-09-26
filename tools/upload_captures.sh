#!/usr/bin/env bash
# Upload a set of captures to a running Airframe instance as one dataset.
# Files are gzip-compressed (lossless, ~5x smaller) into a temp dir before upload;
# tshark reads .pcap.gz natively, so the server analyses exactly the original bytes.
#
# Usage: tools/upload_captures.sh <folder-with-pcaps> [dataset name] [base url]
set -euo pipefail

SRC="${1:?folder with .pcap files}"
NAME="${2:-$(basename "$SRC")}"
BASE="${3:-https://gearbox.skimu.de}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

args=()
for f in "$SRC"/*.pcap "$SRC"/*.pcapng; do
  [ -f "$f" ] || continue
  gzip -c -6 "$f" > "$TMP/$(basename "$f").gz"
  args+=(-F "files=@$TMP/$(basename "$f").gz")
done
[ ${#args[@]} -gt 0 ] || { echo "no captures in $SRC"; exit 1; }

du -ch "$TMP"/*.gz | tail -1
curl -fS --progress-bar "${args[@]}" -F "name=$NAME" "$BASE/api/datasets"
echo
