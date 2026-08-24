"""Shared analysis config for the Motion Swatch service (single source of truth)."""
import os
import torch

DEVICE = "mps" if torch.backends.mps.is_available() else "cpu"
ANALYSIS_WIDTH = int(os.environ.get("MS_WIDTH", "480"))   # downscale width for RAFT
MAX_SECONDS = float(os.environ.get("MS_SECONDS", "8"))    # max clip length analyzed
TARGET_FPS = float(os.environ.get("MS_FPS", "20"))        # flow-pair sample rate
GRID = 12                                                 # GRIDxGRID trajectory grid
