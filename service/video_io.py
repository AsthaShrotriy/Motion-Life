"""Video decode/downscale + bbox crop for localized (per-motion) extraction."""
import cv2
import numpy as np
from config import ANALYSIS_WIDTH, MAX_SECONDS, TARGET_FPS


# ---------------------------------------------------------------- video io
def read_frames(path: str):
    """Return (frames float32 [T,H,W,3] in [0,1], effective_fps)."""
    cap = cv2.VideoCapture(path)
    src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    if not (1.0 <= src_fps <= 240.0):
        src_fps = 30.0
    step = max(1, round(src_fps / TARGET_FPS))
    eff_fps = src_fps / step
    max_frames = int(MAX_SECONDS * eff_fps)

    frames, i = [], 0
    while len(frames) < max_frames:
        ok, frame = cap.read()
        if not ok:
            break
        if i % step == 0:
            h, w = frame.shape[:2]
            # RAFT needs dims divisible by 8
            nw = ANALYSIS_WIDTH
            nh = int(round(h * nw / w / 8) * 8) or 8
            frame = cv2.resize(frame, (nw, nh), interpolation=cv2.INTER_AREA)
            frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            frames.append(frame.astype(np.float32) / 255.0)
        i += 1
    cap.release()
    return np.stack(frames) if frames else None, eff_fps


def _crop_frames(frames: np.ndarray, bbox_str: str):
    """Crop [T,H,W,3] to a normalized [x,y,w,h] region and UPSCALE so both sides are
    >=128px (RAFT needs feature maps >=16 after its /8 downsample). Localizes extraction
    to one VLM-detected motion; the flow pattern (dir/freq) is scale-invariant so upscaling
    a small region is fine. Returns None if the region is degenerate."""
    try:
        bx = [float(v) for v in bbox_str.split(",")][:4]
    except (ValueError, AttributeError):
        return None
    T, H, W, _ = frames.shape
    x0 = min(max(0, int(round(bx[0] * W))), W - 1)
    y0 = min(max(0, int(round(bx[1] * H))), H - 1)
    x1 = min(W, x0 + int(round(bx[2] * W)))
    y1 = min(H, y0 + int(round(bx[3] * H)))
    if x1 - x0 < 8 or y1 - y0 < 8:
        return None
    crop = frames[:, y0:y1, x0:x1, :]
    ch, cw = crop.shape[1], crop.shape[2]
    MIN = 128
    s = max(1.0, MIN / ch, MIN / cw)                       # upscale so min side >= 128
    nh = max(MIN, int(round(ch * s)) // 8 * 8)             # snap to /8, floor 128
    nw = max(MIN, int(round(cw * s)) // 8 * 8)
    return np.stack([cv2.resize(crop[i], (nw, nh), interpolation=cv2.INTER_LINEAR)
                     for i in range(T)]).astype(np.float32)
