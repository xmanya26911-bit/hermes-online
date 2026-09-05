#!/usr/bin/env bash
# Render entrypoint: bootstrap Hermes home, then serve the edge on $PORT (0.0.0.0).
set -euo pipefail

export HERMES_HOME="${HERMES_HOME:-/data/.hermes}"
export HERMES_WORKSPACE="${HERMES_WORKSPACE:-/data/workspace}"
export HERMES_PORT="${HERMES_PORT:-12719}"
# Render injects $PORT; default 8000 for local `bash backend/start.sh`.
export PORT="${PORT:-8000}"

mkdir -p "$HERMES_HOME" "$HERMES_WORKSPACE"

python backend/bootstrap.py

exec python -m uvicorn backend.proxy:app \
  --host 0.0.0.0 \
  --port "$PORT" \
  --proxy-headers \
  --timeout-keep-alive 75
