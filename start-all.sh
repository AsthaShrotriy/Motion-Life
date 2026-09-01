#!/bin/bash
# Start every MotionLife service + the web app, in the background, with logs.
#   sh start-all.sh          # start everything (creates any missing venvs first)
#   sh start-all.sh stop     # stop everything
#   sh start-all.sh status   # what's up / down
#
# First run creates the Python venvs it needs (service/venv, routervenv, mpvenv)
# and installs their requirements; later runs find them and skip straight to launch.
# Credentials: put your key in .env first (see setkey.sh / .env.example).
# Logs land in ./logs/*.log  — tail them with:  tail -f logs/*.log
cd "$(dirname "$0")"
mkdir -p logs

# These MUST match the URLs the browser fetches (js/capture.js, js/judge.js): RAFT :8865,
# pose :8870, router :8871. The services' own defaults are 87xx, so the three the browser
# talks to are moved with their env vars below. Get this wrong and there is no error to see:
# capture.js swallows a failed router call, so upload silently drops to the manual RAFT
# heuristic and a walking clip stops reaching MediaPipe. Preprocess stays on :8772 — it is
# only ever called from a shell or a test, never from the page.
PORTS="8000 8865 8870 8871 8772"

status() {
  for p in $PORTS; do
    r=$(curl -s -m 2 "http://127.0.0.1:$p/health" 2>/dev/null || curl -s -m 2 "http://127.0.0.1:$p/" 2>/dev/null)
    if [ -n "$r" ]; then printf "  :%-5s UP\n" "$p"; else printf "  :%-5s DOWN\n" "$p"; fi
  done
}

stop() {
  echo "Stopping…"
  pkill -f "server:app" 2>/dev/null
  pkill -f "pose_server.py" 2>/dev/null
  pkill -f "vlm_router.py" 2>/dev/null
  pkill -f "preprocess_server.py" 2>/dev/null
  pkill -f "http.server 8000" 2>/dev/null
  sleep 2; echo "Stopped."; status; exit 0
}

case "$1" in
  stop) stop ;;
  status) echo "MotionLife services:"; status; exit 0 ;;
esac

# ---- venv bootstrap: create + install on first run, reuse afterward ----------
# ensure_venv <venv-dir> <requirements-file> <python-interpreter>
ensure_venv() {
  venv="$1"; req="$2"; py="$3"
  if [ -d "$venv" ]; then return 0; fi          # already there -> skip, just launch
  echo "  · $venv missing — creating it (first run; installs may take a few min)…"
  "$py" -m venv "$venv" || { echo "    ✗ could not create $venv with $py"; return 1; }
  "$venv/bin/pip" install --upgrade pip           >>logs/setup.log 2>&1
  "$venv/bin/pip" install -r "$req"               >>logs/setup.log 2>&1 \
    || { echo "    ✗ pip install failed for $venv (see logs/setup.log)"; return 1; }
  echo "    ✓ $venv ready"
}

# Find a Python <=3.12 for MediaPipe (no 3.13 wheel). Handles pyenv, whose shims
# hide python3.12 from `command -v`, by also scanning ~/.pyenv/versions/*/bin.
pick_py312() {
  for cand in python3.12 python3.11 python3.10 python3.9; do
    p=$(command -v "$cand" 2>/dev/null) && [ -n "$p" ] && { echo "$p"; return 0; }
  done
  for bin in "$HOME"/.pyenv/versions/*/bin; do
    for cand in python3.12 python3.11 python3.10 python3.9; do
      [ -x "$bin/$cand" ] && { echo "$bin/$cand"; return 0; }
    done
  done
  if command -v python3 >/dev/null 2>&1; then     # last resort: default python3 if <=3.12
    v=$(python3 -c 'import sys;print("%d.%d"%sys.version_info[:2])' 2>/dev/null)
    case "$v" in 3.9|3.10|3.11|3.12) command -v python3; return 0 ;; esac
  fi
  return 1
}

[ -f .env ] || echo "⚠️  no .env — the VLM router (:8871) will 500. Run: sh setkey.sh"

echo "Starting MotionLife…"

# 1. web app (static) — no venv needed
pgrep -f "http.server 8000" >/dev/null || \
  (python3 -m http.server 8000 >logs/web.log 2>&1 &) && echo "  :8000 web app"

# 2. RAFT flow + engine registry (torch, py3.13 ok)
ensure_venv service/venv service/requirements.txt python3
pgrep -f "server:app" >/dev/null || \
  { [ -x service/venv/bin/uvicorn ] && \
    (service/venv/bin/uvicorn --app-dir service server:app --host 127.0.0.1 --port 8865 \
       >logs/raft.log 2>&1 &) && echo "  :8865 RAFT + registry"; }

# 3. VLM router (needs .env key) — routervenv shared with preprocess
ensure_venv routervenv service/requirements-router.txt python3
pgrep -f "vlm_router.py" >/dev/null || \
  { [ -x routervenv/bin/python ] && \
    (ROUTER_PORT=8871 routervenv/bin/python service/vlm_router.py >logs/router.log 2>&1 &) && echo "  :8871 VLM router"; }

# 4. Preprocess (mask + camera) — reuses routervenv (created above)
pgrep -f "preprocess_server.py" >/dev/null || \
  { [ -x routervenv/bin/python ] && \
    (routervenv/bin/python service/preprocess_server.py >logs/prep.log 2>&1 &) && echo "  :8772 preprocess"; }

# 5. MediaPipe pose/hands/face — needs its own py<=3.12 venv (./mpvenv)
if pgrep -f "pose_server.py" >/dev/null; then
  echo "  :8870 pose (already running)"
else
  if [ ! -d mpvenv ]; then
    PY312=$(pick_py312)
    if [ -n "$PY312" ]; then
      echo "  · using $PY312 for MediaPipe (needs Python 3.9–3.12)"
      ensure_venv mpvenv service/requirements-pose.txt "$PY312"
    else
      echo "  :8870 SKIPPED — no Python 3.9–3.12 found for MediaPipe. Install one, then rerun."
    fi
  fi
  [ -x mpvenv/bin/python ] && \
    (POSE_PORT=8870 mpvenv/bin/python service/pose_server.py >logs/pose.log 2>&1 &) && echo "  :8870 MediaPipe pose"
fi

echo "Waiting for services to come up…"; sleep 10
echo "Status:"; status
echo
echo "App:  http://localhost:8000     Logs:  tail -f logs/*.log"
