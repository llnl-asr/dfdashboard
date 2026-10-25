#!/usr/bin/env bash
# One finished run tree for the browser tests, then the server on E2E_PORT.
# Works from a source checkout with .venv and from CI where the tools are on PATH.
set -euo pipefail

ROOT="${E2E_ROOT:-/tmp/dfdashboard-e2e}"
PORT="${E2E_PORT:-5099}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"

if [ -x "$REPO/.venv/bin/python" ]; then
  PY="$REPO/.venv/bin/python"
  SERVE="$REPO/.venv/bin/dfdashboard-serve"
else
  PY="$(command -v python3)"
  SERVE="$(command -v dfdashboard-serve || true)"
fi

rm -rf "$ROOT"
mkdir -p "$ROOT"

# Finished runs with a compact set and a _SUCCESS marker, so the run bar shows
# done runs and the cards have data on first paint. Deterministic and quick.
"$PY" "$REPO/scripts/stream_demo.py" \
  --root "$ROOT" \
  --runs 2 \
  --files 2 \
  --total 40 \
  --batch 40 \
  --interval 0.01 \
  --run-gap 0.05 \
  --event-gap-ms 40 \
  --split >/dev/null 2>&1 || true

if [ -z "$SERVE" ]; then
  echo "dfdashboard-serve not found on PATH" >&2
  exit 1
fi

# Serve the checkout's freshly built bundle, not the one baked into the package
# at install time, so the tests drive the code in the working tree.
exec "$SERVE" \
  --watch "$ROOT" \
  --web-dist "$REPO/web/dist" \
  --host 127.0.0.1 \
  --port "$PORT" \
  --index-dir "$ROOT/.index" \
  --watch-interval 0.5
