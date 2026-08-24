"""RAFT optical-flow backbone (default engine) — dense flow per frame pair."""
import os
import numpy as np
import torch
from torchvision.models.optical_flow import (
    Raft_Large_Weights, Raft_Small_Weights, raft_large, raft_small,
)
from config import DEVICE

# raft_small scores 12/12 on benchmark.py; raft_large 11/12 at 4x compute (bigger != better here).
ENGINE = os.environ.get("MS_ENGINE", "raft_small")   # raft_small | raft_large
if ENGINE == "raft_large":
    MODEL = raft_large(weights=Raft_Large_Weights.DEFAULT).eval().to(DEVICE)
else:
    ENGINE = "raft_small"
    MODEL = raft_small(weights=Raft_Small_Weights.DEFAULT).eval().to(DEVICE)


def raft_flow_series(frames: np.ndarray) -> np.ndarray:
    """Dense flow for each consecutive pair. Returns [T-1, 2, H, W] (px/frame)."""
    t = torch.from_numpy(frames).permute(0, 3, 1, 2) * 2 - 1  # [T,3,H,W] in [-1,1]
    flows = []
    with torch.no_grad():
        for a, b in zip(t[:-1], t[1:]):
            fl = MODEL(a.unsqueeze(0).to(DEVICE), b.unsqueeze(0).to(DEVICE))[-1]
            flows.append(fl[0].cpu().numpy())
    return np.stack(flows)
