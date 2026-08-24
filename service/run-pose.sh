#!/bin/bash
# Start the MotionLife character-motion (pose) service.
# Creates a dedicated MediaPipe venv on first run (MediaPipe needs Python <=3.12,
# so this is separate from the main service/venv which is 3.13), then serves the
# pose endpoint on http://127.0.0.1:8770 (POST /extract with video bytes).
set -e
cd "$(dirname "$0")/.."          # repo root
VENV="mpvenv"

# pick a Python <= 3.12 (mediapipe has no 3.13 wheel)
PY=""
for cand in python3.12 python3.11 python3.10 python3.9 python3; do
  if command -v "$cand" >/dev/null 2>&1; then
    ver=$("$cand" -c 'import sys;print(f"{sys.version_info.major}.{sys.version_info.minor}")')
    major=${ver%%.*}; minor=${ver##*.}
    if [ "$major" = "3" ] && [ "$minor" -le 12 ]; then PY="$cand"; break; fi
  fi
done
if [ -z "$PY" ]; then
  echo "ERROR: need Python 3.9–3.12 for MediaPipe (found none). Install one and retry." >&2
  exit 1
fi

if [ ! -d "$VENV" ]; then
  echo "Creating pose venv ($PY) …"
  "$PY" -m venv "$VENV"
  "$VENV/bin/pip" install --upgrade pip
  "$VENV/bin/pip" install -r service/requirements-pose.txt
fi

echo "Pose service starting on http://127.0.0.1:8770  (POST /extract)"
exec "$VENV/bin/python" service/pose_server.py
