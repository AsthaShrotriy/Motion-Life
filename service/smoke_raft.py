"""Smoke test: torchvision pretrained RAFT on this machine.

Generates a synthetic frame pair with KNOWN motion (+6px x, +2px y),
runs raft_small and raft_large, checks accuracy and speed on CPU and MPS.
"""
import time

import numpy as np
import torch
from torchvision.models.optical_flow import (
    Raft_Large_Weights,
    Raft_Small_Weights,
    raft_large,
    raft_small,
)

H, W = 240, 320
TRUE_DX, TRUE_DY = 6.0, 2.0

# textured random image, shifted by a known offset
rng = np.random.default_rng(7)
base = rng.uniform(0, 1, (H + 40, W + 40, 3)).astype(np.float32)
# smooth it a bit so it's image-like
k = 7
kernel = np.ones(k) / k
for axis in (0, 1):
    base = np.apply_along_axis(lambda m: np.convolve(m, kernel, mode="same"), axis, base)

f1 = base[20 : 20 + H, 20 : 20 + W]
f2 = base[20 - int(TRUE_DY) : 20 - int(TRUE_DY) + H, 20 - int(TRUE_DX) : 20 - int(TRUE_DX) + W]

def to_batch(img):
    t = torch.from_numpy(np.ascontiguousarray(img, dtype=np.float32)).permute(2, 0, 1).unsqueeze(0)
    return t * 2 - 1  # [-1, 1] as RAFT expects

img1, img2 = to_batch(f1), to_batch(f2)

for name, ctor, weights in [
    ("raft_small", raft_small, Raft_Small_Weights.DEFAULT),
    ("raft_large", raft_large, Raft_Large_Weights.DEFAULT),
]:
    model = ctor(weights=weights).eval()
    n_params = sum(p.numel() for p in model.parameters()) / 1e6
    for device in ["cpu", "mps"]:
        if device == "mps" and not torch.backends.mps.is_available():
            continue
        try:
            m = model.to(device)
            a, b = img1.to(device), img2.to(device)
            with torch.no_grad():
                m(a, b)  # warmup
                t0 = time.time()
                flows = m(a, b)
                dt = time.time() - t0
            flow = flows[-1][0].cpu().numpy()  # (2, H, W)
            mean_dx, mean_dy = float(flow[0].mean()), float(flow[1].mean())
            err = abs(mean_dx - TRUE_DX) + abs(mean_dy - TRUE_DY)
            print(
                f"{name:11s} {device:4s} {n_params:5.1f}M params | "
                f"{dt*1000:7.0f} ms/pair @ {W}x{H} | "
                f"flow=({mean_dx:+.2f},{mean_dy:+.2f}) true=({TRUE_DX:+.1f},{TRUE_DY:+.1f}) "
                f"err={err:.2f}px {'OK' if err < 1.0 else 'BAD'}"
            )
        except Exception as e:  # noqa: BLE001
            print(f"{name:11s} {device:4s} FAILED: {type(e).__name__}: {e}")
