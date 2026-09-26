#!/usr/bin/env bash
# Checks to run before every push (a push to main deploys).
#
#   tools/check.sh           ruff + fast tests (host, about 5 s)
#   tools/check.sh --tesla   also the Tesla regression in the backend test image (about 6 min)
#
# The Tesla regression needs the 8 real pcaps. It looks in $TESLA_CAPTURES, then data/tesla
# (after `git lfs pull`), then internal/briefing/captures.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/backend"

echo "== ruff"
uv run ruff check app tests tools ../tools/bench_scale.py
echo "== fast tests"
uv run pytest -q

if [[ "${1:-}" == "--tesla" ]]; then
  caps="${TESLA_CAPTURES:-}"
  for c in "$caps" "$ROOT/data/tesla" "$ROOT/internal/briefing/captures"; do
    if [[ -n "$c" && -f "$c/sensor01.pcap" ]] && [[ "$(head -c 4 "$c/sensor01.pcap" | od -An -tx1 | tr -d ' \n')" =~ ^(d4c3b2a1|a1b2c3d4|0a0d0d0a)$ ]]; then
      caps="$c"
      break
    fi
    caps=""
  done
  if [[ -z "$caps" ]]; then
    echo "!! no real Tesla pcaps found (Git LFS pointers?). Set TESLA_CAPTURES." >&2
    exit 1
  fi
  echo "== Tesla regression (captures: $caps)"
  cd "$ROOT"
  docker build -q -f backend/Dockerfile --target test -t gearbox-api-test . >/dev/null
  # Git Bash on Windows rewrites /caps unless MSYS_NO_PATHCONV is set
  MSYS_NO_PATHCONV=1 docker run --rm -e TESLA_CAPTURES=/caps -v "$caps:/caps:ro" gearbox-api-test \
    python -m pytest -q -p no:cacheprovider -m tesla -rs
fi
echo "== all checks passed"
