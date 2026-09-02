"""Shared analysis config for the Motion Swatch service (single source of truth)."""
import os

# DEVICE is the only torch-dependent value here; GRID/ANALYSIS_WIDTH/TARGET_FPS are plain
# numbers that torch-free interpreters legitimately need (routervenv runs the preprocess
# service on py3.9 with no torch, and tests/step2-preprocess.py runs in both venvs). So the
# import is guarded rather than making every torch-free importer of this module fail.
# DEVICE is "" and not "cpu" when torch is missing: an empty device is visibly wrong if it
# ever reaches an engine label, where a plausible-looking "cpu" would read as a real answer.
try:
    import torch
    DEVICE = "mps" if torch.backends.mps.is_available() else "cpu"
except ImportError:
    DEVICE = ""
ANALYSIS_WIDTH = int(os.environ.get("MS_WIDTH", "480"))   # downscale width for RAFT
MAX_SECONDS = float(os.environ.get("MS_SECONDS", "8"))    # max clip length analyzed
TARGET_FPS = float(os.environ.get("MS_FPS", "20"))        # flow-pair sample rate
GRID = 12                                                 # GRIDxGRID trajectory grid
