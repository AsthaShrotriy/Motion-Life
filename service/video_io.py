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


def _crop_geom(H: int, W: int, bbox_str: str):
    """Crop geometry for a normalized "x,y,w,h" bbox against an [H,W] frame.

    Returns (x0, y0, x1, y1, nw, nh) — the source rect plus the upscaled output size —
    or None if the region is degenerate. Factored out of _crop_frames so an object mask
    can be put through the EXACT same arithmetic (see align_mask); computing the two
    independently is how a mask silently drifts off the frames it is supposed to select.
    """
    try:
        bx = [float(v) for v in bbox_str.split(",")][:4]
    except (ValueError, AttributeError):
        return None
    x0 = min(max(0, int(round(bx[0] * W))), W - 1)
    y0 = min(max(0, int(round(bx[1] * H))), H - 1)
    x1 = min(W, x0 + int(round(bx[2] * W)))
    y1 = min(H, y0 + int(round(bx[3] * H)))
    if x1 - x0 < 8 or y1 - y0 < 8:
        return None
    ch, cw = y1 - y0, x1 - x0
    MIN = 128
    s = max(1.0, MIN / ch, MIN / cw)                       # upscale so min side >= 128
    nh = max(MIN, int(round(ch * s)) // 8 * 8)             # snap to /8, floor 128
    nw = max(MIN, int(round(cw * s)) // 8 * 8)
    return x0, y0, x1, y1, nw, nh


def _crop_frames(frames: np.ndarray, bbox_str: str):
    """Crop [T,H,W,3] to a normalized [x,y,w,h] region and UPSCALE so both sides are
    >=128px (RAFT needs feature maps >=16 after its /8 downsample). Localizes extraction
    to one VLM-detected motion; the flow pattern (dir/freq) is scale-invariant so upscaling
    a small region is fine. Returns None if the region is degenerate."""
    T, H, W, _ = frames.shape
    g = _crop_geom(H, W, bbox_str)
    if g is None:
        return None
    x0, y0, x1, y1, nw, nh = g
    crop = frames[:, y0:y1, x0:x1, :]
    return np.stack([cv2.resize(crop[i], (nw, nh), interpolation=cv2.INTER_LINEAR)
                     for i in range(T)]).astype(np.float32)


def align_mask(mask_u8: np.ndarray, src_hw, bbox_str: str = None, out_hw=None):
    """Put an object mask through the same geometry as the frames it selects.

    mask_u8: uint8/bool [h,w] from preprocess.py, computed on the FULL frame at that
        module's own analysis width (it doesn't snap height to /8, so e.g. 480x270 vs
        video_io's 480x272 — a raw hand-off to distill() would misalign by 960 pixels).
    src_hw: (H, W) of the analyze frames BEFORE any crop — the mask is resampled here
        first so the crop rect indexes the same pixel space.
    bbox_str: same bbox passed to _crop_frames; when given the mask is cropped with
        _crop_geom, so mask ∩ crop compose instead of competing.
    out_hw: (H, W) of the flow array; the final resize lands exactly on it.

    Both pipelines preserve aspect ratio, so a full-frame resize IS the correct
    normalized-coordinate map. NEAREST only — interpolating a mask leaks background
    pixels in at fractional weight, which is exactly what the mask exists to prevent.
    Returns bool [H,W].
    """
    m = np.asarray(mask_u8)
    if m.dtype != np.uint8:
        m = m.astype(np.uint8)
    if m.shape[:2] != tuple(src_hw):
        m = cv2.resize(m, (src_hw[1], src_hw[0]), interpolation=cv2.INTER_NEAREST)
    if bbox_str:
        g = _crop_geom(src_hw[0], src_hw[1], bbox_str)
        if g is not None:
            m = m[g[1]:g[3], g[0]:g[2]]
    if out_hw is not None and m.shape[:2] != tuple(out_hw):
        m = cv2.resize(m, (out_hw[1], out_hw[0]), interpolation=cv2.INTER_NEAREST)
    return m > 0
