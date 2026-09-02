#!/bin/bash
# Start the MotionLife preprocess service (Step 2) on :8772.
# Reuses ./routervenv (already has opencv-python + numpy) — no torch, no downloads.
# Falls back to creating ./routervenv if it doesn't exist yet.
set -e
cd "$(dirname "$0")/.."          # repo root
VENV="routervenv"

if [ ! -d "$VENV" ]; then
  echo "Creating venv for preprocess (opencv + numpy) …"
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install --upgrade pip
  "$VENV/bin/pip" install -r service/requirements-preprocess.txt
fi

echo "Preprocess service starting on http://127.0.0.1:8772  (POST /preprocess)"
exec "$VENV/bin/python" service/preprocess_server.py
