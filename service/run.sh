#!/bin/bash
# Start the Motion Swatch analysis service (RAFT deep optical flow).
# First run creates the venv and downloads the ~4MB raft_small checkpoint.
cd "$(dirname "$0")"
if [ ! -d venv ]; then
  python3 -m venv venv
  venv/bin/pip install --upgrade pip
  venv/bin/pip install -r requirements.txt
fi
exec venv/bin/uvicorn server:app --host 127.0.0.1 --port 8765
