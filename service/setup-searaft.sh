#!/bin/bash
# Enable the optional SEA-RAFT flow engine (heavier/slower than the default raft_small).
# Clones the repo into service/SEA-RAFT and installs its deps into the RAFT venv.
# The first  POST /analyze?engine=searaft  then downloads ~79MB weights from HuggingFace.
set -e
cd "$(dirname "$0")/.."
[ -d service/SEA-RAFT/core ] || git clone --depth 1 https://github.com/princeton-vl/SEA-RAFT.git service/SEA-RAFT
service/venv/bin/pip install -r service/requirements-searaft.txt
echo "SEA-RAFT ready — use POST /analyze?engine=searaft (config/eval/spring-M.json + Tartan-C-T-TSKH-spring540x960-M)."
