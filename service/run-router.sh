#!/bin/bash
# Start the MotionLife VLM Router (Step 1). Samples frames from an uploaded clip and
# asks Claude vision to decompose it into distinct motions (Contract A) on :8771.
# First run creates ./routervenv and installs the Anthropic SDK + OpenCV.
set -e
cd "$(dirname "$0")/.."          # repo root
VENV="routervenv"

# Load credentials from .env if present (copy .env.example -> .env and fill in the key).
if [ -f .env ]; then set -a; . ./.env; set +a; fi

if [ ! -d "$VENV" ]; then
  echo "Creating router venv …"
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install --upgrade pip
  "$VENV/bin/pip" install -r service/requirements-router.txt
fi

echo "VLM Router starting on http://127.0.0.1:8771  (POST /decompose)"
exec "$VENV/bin/python" service/vlm_router.py
