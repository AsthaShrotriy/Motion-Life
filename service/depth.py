"""Depth Anything V2 (Small) — monocular relative depth. Step 2's optional depth helper.

Real engine, not a stub: `transformers` pipeline("depth-estimation") on the
apache-2.0 Small checkpoint. Base/Large are cc-by-nc-4.0, so we stay on Small.

Two things that bite, both verified on this machine:
  * the pipeline REJECTS raw numpy arrays — cv2 BGR must be wrapped as a PIL RGB image;
  * output is INVERSE relative depth: LARGER = CLOSER. After min-max normalizing,
    1.0 is the nearest pixel in that frame. Values are per-frame relative — there is
    no metric scale and no cross-frame comparability.

Measured on this box (MPS, walk-man.mp4): 71-74 ms/frame at 720p, 28 ms/frame at
640x360; CPU 209 ms/frame. Batching does not help (the pipeline iterates internally),
so there is no batch_size knob. Cold start ~5s online, ~0.5s with HF_HUB_OFFLINE=1.

Import is safe without the weights: nothing loads until depth_maps/depth_summary runs.
"""
import os

import numpy as np

MODEL_ID = os.environ.get("MS_DEPTH_MODEL", "depth-anything/Depth-Anything-V2-Small-hf")
MAX_SIDE = int(os.environ.get("MS_DEPTH_MAX_SIDE", "640"))   # 28ms/frame vs 73ms at 720p
ENGINE = "depth_anything_v2_small"

_PIPE = None


def available():
    """(ok, reason) — dependency-only probe: never downloads, never loads the model."""
    try:
        import torch                          # noqa: F401
        import transformers                   # noqa: F401
        from PIL import Image                 # noqa: F401
    except ImportError as ex:
        return False, f"pip install transformers (missing: {ex.name})"
    cached = _weights_cached()
    return True, (f"transformers + {MODEL_ID} (cached)" if cached else
                  f"transformers ready; {MODEL_ID} weights (~95MB) download on first use")


def _weights_cached():
    """True when the HF cache already holds the checkpoint (so no download on first call)."""
    root = os.environ.get("HF_HOME") or os.path.expanduser("~/.cache/huggingface")
    d = os.path.join(root, "hub", "models--" + MODEL_ID.replace("/", "--"))
    if not os.path.isdir(d):
        d = os.path.join(root, "models--" + MODEL_ID.replace("/", "--"))
    return os.path.isdir(d)


def _get_pipe():
    global _PIPE
    if _PIPE is None:
        import torch
        from transformers import pipeline
        dev = "mps" if torch.backends.mps.is_available() else "cpu"
        _PIPE = pipeline("depth-estimation", model=MODEL_ID, device=dev)
    return _PIPE


def depth_maps(frames_bgr, max_side=None):
    """frames_bgr: iterable of HxWx3 uint8 BGR (cv2 order).

    Returns a list of float32 [H,W] arrays in [0,1] at the INPUT frame's size,
    where 1.0 = nearest. Frames are downscaled to max_side for inference and the
    result is resampled back, so the caller can index it against its own pixels.
    """
    import cv2
    from PIL import Image
    pipe = _get_pipe()
    lim = max_side or MAX_SIDE
    out = []
    for f in frames_bgr:
        h, w = f.shape[:2]
        s = min(1.0, lim / max(h, w))
        small = cv2.resize(f, (int(round(w * s)), int(round(h * s))),
                           interpolation=cv2.INTER_AREA) if s < 1.0 else f
        img = Image.fromarray(cv2.cvtColor(small, cv2.COLOR_BGR2RGB))   # PIL required
        d = np.asarray(pipe(img)["predicted_depth"].squeeze().float().cpu(), dtype=np.float32)
        lo, hi = float(d.min()), float(d.max())
        d = (d - lo) / (hi - lo) if hi > lo else np.zeros_like(d)       # 1.0 = nearest
        if d.shape != (h, w):
            d = cv2.resize(d, (w, h), interpolation=cv2.INTER_LINEAR)
        out.append(d)
    return out


def depth_summary(frames_bgr, mask_bool=None, samples=3):
    """Compact depth facts for the region_preprocess contract — NOT a depth map.

    Full per-frame maps would be megabytes of JSON for no consumer. What a renderer
    can actually use is where the object sits in the scene's depth range, so we
    return scalars: `object` (mean normalized depth inside the mask), `scene`
    (frame mean), `rank` (the object's percentile within the frame — layer order /
    parallax gain) and `spread` (depth variation across the object).

    mask_bool: [H,W] bool selecting the object, in the SAME pixel space as the frames.
    Returns None when there are no frames; raises on a genuine model failure so the
    caller can record a warning rather than publish a silent zero.
    """
    frames = list(frames_bgr)
    if not frames:
        return None
    idx = np.unique(np.linspace(0, len(frames) - 1, min(samples, len(frames))).round().astype(int))
    maps = depth_maps([frames[i] for i in idx])
    objs, scenes, ranks, spreads = [], [], [], []
    for d in maps:
        scenes.append(float(d.mean()))
        if mask_bool is not None and mask_bool.shape == d.shape and mask_bool.any():
            v = d[mask_bool]
            objs.append(float(v.mean()))
            spreads.append(float(v.std()))
            ranks.append(float((d < v.mean()).mean()))   # fraction of the frame that is farther
    return {
        "engine": ENGINE,
        "polarity": "inverse_relative",          # larger = closer; per-frame, no metric scale
        "scene": round(float(np.mean(scenes)), 4),
        "object": round(float(np.mean(objs)), 4) if objs else None,
        "rank": round(float(np.mean(ranks)), 4) if ranks else None,
        "spread": round(float(np.mean(spreads)), 4) if spreads else None,
        "frames": int(len(maps)),
    }
