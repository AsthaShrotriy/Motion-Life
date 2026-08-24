"""MotionLife Step 2 — region preprocessing (camera motion + object mask).

Given a clip + one Contract-A motion bbox, produce a region_preprocess contract:
  * camera : per-frame transform (reference frame0 -> frame i) + is_static + residual_px,
             so a consumer can SUBTRACT global camera motion (fixes "scenery scrolls
             with the camera") before extracting object motion.
  * mask   : a clean object mask (RLE) gated to actually-moving pixels inside the bbox,
             so downstream extraction "runs only inside the masked object".
  * depth  : optional — SAM 2 (better mask) and Depth Anything V2 (depth) are gated
             upgrades behind checkpoints; the download-free default here is OpenCV only.

Pure OpenCV + numpy, no torch, no model downloads. Runs CPU-only (routervenv, py3.9).
Algorithm (all real cv2): ORB+RANSAC affine per frame pair, estimated from BACKGROUND
features only (outside the seed bbox), falling back to identity/static when there
aren't enough reliable background features; Farneback dense flow minus the
camera-induced flow = residual (true object) motion; GrabCut(bbox) ∩ motion-gate ∩
bbox, cleaned by morphology + largest connected component.
"""
import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import contracts

WORK_W = int(os.environ.get("PREP_WIDTH", "480"))          # analysis width (matches RAFT)
MAX_FRAMES = int(os.environ.get("PREP_FRAMES", "48"))      # sampled evenly across the clip
STATIC_PX = float(os.environ.get("PREP_STATIC_PX", "3.0")) # median corner drift below this
#   (~0.6% of the 480px analysis width, i.e. the feature-match noise floor) -> static cam
MOTION_PCT = float(os.environ.get("PREP_MOTION_PCT", "70"))    # motion percentile inside bbox
MOTION_FLOOR = float(os.environ.get("PREP_MOTION_FLOOR", "0.6"))  # px/frame min (RAFT-noise floor)
DRIFT_CAP = float(os.environ.get("PREP_DRIFT_CAP", "0.25"))  # reject pair if corner drift > this*width
ENGINE = "farneback+affine"


# ── frame IO ────────────────────────────────────────────────────────────────
def read_frames(path):
    cap = cv2.VideoCapture(path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    W0 = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    H0 = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    frames = []
    if total > 0:
        idxs = sorted(set(round(i * (total - 1) / max(1, MAX_FRAMES - 1)) for i in range(MAX_FRAMES)))
        for i in idxs:
            cap.set(cv2.CAP_PROP_POS_FRAMES, i)
            ok, fr = cap.read()
            if ok:
                frames.append(fr)
    else:
        while len(frames) < MAX_FRAMES:
            ok, fr = cap.read()
            if not ok:
                break
            frames.append(fr)
    cap.release()
    scaled = []
    for fr in frames:
        if fr.shape[1] > WORK_W:
            s = WORK_W / fr.shape[1]
            fr = cv2.resize(fr, (WORK_W, int(round(fr.shape[0] * s))))
        scaled.append(fr)
    clip = {"width": W0, "height": H0, "fps": round(float(fps), 2),
            "frames_used": len(scaled), "count_unknown": total <= 0,
            "work_w": scaled[0].shape[1] if scaled else 0,
            "work_h": scaled[0].shape[0] if scaled else 0}
    return scaled, clip


# ── camera motion (ORB background features -> RANSAC affine, else static) ────
def _matches(ref_g, cur_g, orb, bf, det_mask=None, ratio=0.75, min_m=20):
    # det_mask restricts feature detection to the BACKGROUND (outside the object
    # bbox) so the moving object can't hijack the camera estimate.
    k1, d1 = orb.detectAndCompute(ref_g, det_mask)
    k2, d2 = orb.detectAndCompute(cur_g, det_mask)
    if d1 is None or d2 is None or len(k1) < min_m or len(k2) < min_m:
        return None, None
    knn = bf.knnMatch(d1, d2, k=2)
    good = [p[0] for p in knn if len(p) == 2 and p[0].distance < ratio * p[1].distance]
    if len(good) < min_m:
        return None, None
    src = np.float32([k1[m.queryIdx].pt for m in good]).reshape(-1, 1, 2)
    dst = np.float32([k2[m.trainIdx].pt for m in good]).reshape(-1, 1, 2)
    return src, dst


def _pair_transform(ref_g, cur_g, orb, bf, det_mask=None):
    """3x3 matrix mapping ref->cur from BACKGROUND features, plus a model label.

    Uses estimateAffinePartial2D (4-DOF translation+rotation+uniform-scale) — the
    standard video-stabilization model that, unlike a full homography, cannot
    projectively blow up on near-collinear/low-texture features (poles, rigging).
    A pair whose corner drift is implausibly large is rejected as a bad fit.
    Returns identity + "none" when there's no reliable background motion (so a
    feature-rich moving subject like a flag can't hijack the estimate -> static).
    """
    src, dst = _matches(ref_g, cur_g, orb, bf, det_mask)
    if src is not None:
        M, inl = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC, ransacReprojThreshold=3.0)
        # need enough absolute inliers, not just a ratio — a few collinear features
        # (a pole, rigging) give an unstable fit that reads as phantom camera motion.
        if M is not None and inl is not None and inl.sum() >= 20 and inl.sum() >= 0.5 * len(inl):
            H = np.vstack([M, [0, 0, 1]]).astype(np.float64)
            if _corner_drift(H, ref_g.shape) < DRIFT_CAP * ref_g.shape[1]:
                return H, "affine"
    return np.eye(3), "none"      # no reliable background motion -> treat as static


def _corner_drift(H, shape):
    h, w = shape[:2]
    c = np.float32([[0, 0], [w, 0], [w, h], [0, h]]).reshape(-1, 1, 2)
    d = cv2.perspectiveTransform(c, H.astype(np.float32)) - c
    return float(np.mean(np.linalg.norm(d, axis=2)))


def _residual_flow(prev_g, cur_g, H_pair, static):
    """Farneback flow with the camera-induced flow subtracted (unless static)."""
    flow = cv2.calcOpticalFlowFarneback(prev_g, cur_g, None, 0.5, 3, 21, 3, 7, 1.5, 0)
    if static:
        return flow
    h, w = prev_g.shape
    xs, ys = np.meshgrid(np.arange(w), np.arange(h))
    grid = np.stack([xs.ravel(), ys.ravel()], 1).astype(np.float32).reshape(-1, 1, 2)
    cam = cv2.perspectiveTransform(grid, H_pair.astype(np.float32)).reshape(h, w, 2) \
        - np.stack([xs, ys], -1).astype(np.float32)
    return flow - cam


# ── mask building ────────────────────────────────────────────────────────────
def _largest_cc(mask):
    n, lbl, stats, _ = cv2.connectedComponentsWithStats((mask > 0).astype(np.uint8), 8)
    if n <= 1:
        return mask
    areas = stats[1:, cv2.CC_STAT_AREA]
    if len(areas) == 0:
        return mask
    big = 1 + int(np.argmax(areas))
    return np.where(lbl == big, 255, 0).astype(np.uint8)


def _build_mask(frame, box, motion_energy):
    """GrabCut(bbox) ∩ motion-gate ∩ bbox, cleaned. Returns (uint8 {0,255}, method).

    method is "grabcut+motion" normally, or "bbox_motion_fallback" when GrabCut
    couldn't run (full-frame/degenerate bbox) so the mask is only motion-gated inside
    the box — the caller surfaces this as a warning so a rectangle is never advertised
    as a segmented object mask.
    """
    h, w = frame.shape[:2]
    x, y, bw, bh = box
    # GrabCut needs a rect strictly inside the frame with SOME background outside it.
    # If the seed bbox fills (or nearly fills) the frame, inset a margin so background
    # samples exist; if that leaves nothing usable, fall back to the motion-gated box.
    m = max(2, int(round(0.03 * min(w, h))))
    rx, ry = max(0, x), max(0, y)
    rw = min(bw, w - rx - 1)
    rh = min(bh, h - ry - 1)
    if rx <= m and rw >= w - 2 * m:            # spans full width -> inset
        rx += m; rw -= 2 * m
    if ry <= m and rh >= h - 2 * m:            # spans full height -> inset
        ry += m; rh -= 2 * m
    gc_ok = rw >= 2 and rh >= 2 and rx + rw < w and ry + rh < h
    method = "grabcut+motion"
    gc_mask = np.zeros((h, w), np.uint8)
    if gc_ok:
        gc = np.zeros((h, w), np.uint8)
        bgd = np.zeros((1, 65), np.float64)
        fgd = np.zeros((1, 65), np.float64)
        try:
            cv2.grabCut(frame, gc, (rx, ry, rw, rh), bgd, fgd, 5, cv2.GC_INIT_WITH_RECT)
            gc_mask = np.where((gc == cv2.GC_FGD) | (gc == cv2.GC_PR_FGD), 255, 0).astype(np.uint8)
        except cv2.error:
            gc_ok = False
    if not gc_ok:
        method = "bbox_motion_fallback"
        gc_mask[y:y + bh, x:x + bw] = 255
    roi = motion_energy[y:y + bh, x:x + bw]
    thr = max(MOTION_FLOOR, float(np.percentile(roi, MOTION_PCT)) if roi.size else MOTION_FLOOR)
    motion = (motion_energy > thr).astype(np.uint8) * 255
    box_mask = np.zeros((h, w), np.uint8)
    box_mask[y:y + bh, x:x + bw] = 255
    final = cv2.bitwise_and(cv2.bitwise_and(gc_mask, motion), box_mask)
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    final = cv2.morphologyEx(final, cv2.MORPH_OPEN, k)
    final = cv2.morphologyEx(final, cv2.MORPH_CLOSE, k)
    return _largest_cc(final), method


# ── mask RLE codec (row-major, background-first: first run is a count of 0s) ──
def encode_mask_rle(mask_bool):
    flat = np.asarray(mask_bool, dtype=np.uint8).ravel(order="C")
    if flat.size == 0:
        return [0]
    idx = np.flatnonzero(np.diff(flat)) + 1
    bounds = np.concatenate(([0], idx, [flat.size]))
    runs = np.diff(bounds).astype(int).tolist()
    return ([0] + runs) if flat[0] == 1 else runs   # ensure the first run is a 0-run


def decode_mask_rle(data, w, h):
    arr = np.zeros(w * h, np.uint8)
    pos, val = 0, 0
    for run in data:
        if val:
            arr[pos:pos + run] = 1
        pos += run
        val ^= 1
    return arr[:w * h].reshape(h, w)


def _mask_bbox_norm(mask, w, h):
    ys, xs = np.where(mask > 0)
    if xs.size == 0:
        return [0.0, 0.0, 1.0, 1.0]
    x0, x1, y0, y1 = int(xs.min()), int(xs.max()), int(ys.min()), int(ys.max())
    return [round(x0 / w, 4), round(y0 / h, 4), round((x1 - x0 + 1) / w, 4), round((y1 - y0 + 1) / h, 4)]


def overlay(frame, mask, box):
    """Alpha-blend the mask red + draw the seed bbox green (for the done-when PNG)."""
    out = frame.copy()
    m = mask > 0
    out[m] = (0.5 * out[m].astype(np.float32) + 0.5 * np.array([0, 0, 255], np.float32)).astype(np.uint8)
    x, y, bw, bh = box
    cv2.rectangle(out, (x, y), (x + bw, y + bh), (0, 255, 0), 2)
    return out


# ── main ─────────────────────────────────────────────────────────────────────
def preprocess(path, bbox_norm, motion_id="", cls=""):
    """Returns (region_preprocess_contract, warnings, viz).

    viz = {"frame": rep_bgr, "mask": uint8, "box": (x,y,bw,bh)} for the CLI overlay
    (the server ignores it).
    """
    frames, clip = read_frames(path)
    if len(frames) < 2:
        c = contracts.empty_region_preprocess(clip, motion_id, cls, bbox_norm)
        c["engine"] = ENGINE
        c["warnings"] = ["fewer than 2 usable frames"]
        return c, c["warnings"], None

    h, w = frames[0].shape[:2]
    grays = [cv2.cvtColor(f, cv2.COLOR_BGR2GRAY) for f in frames]
    bx = contracts._clamp_bbox(bbox_norm)
    x = int(round(bx[0] * w)); y = int(round(bx[1] * h))
    bw = max(2, min(int(round(bx[2] * w)), w - x))
    bh = max(2, min(int(round(bx[3] * h)), h - y))

    # background-only detection mask: 255 everywhere EXCEPT a padded seed bbox, so the
    # moving object can't hijack the camera estimate.
    bg_mask = np.full((h, w), 255, np.uint8)
    px, py = int(0.06 * w), int(0.06 * h)
    bg_mask[max(0, y - py):min(h, y + bh + py), max(0, x - px):min(w, x + bw + px)] = 0

    orb = cv2.ORB_create(nfeatures=2000)
    bf = cv2.BFMatcher(cv2.NORM_HAMMING)
    warnings = []

    # Pass 1 (cheap): per-pair background transform + corner drift.
    pair_H, pair_models, drifts = [], [], []
    for i in range(1, len(grays)):
        Hp, model = _pair_transform(grays[i - 1], grays[i], orb, bf, bg_mask)
        pair_H.append(Hp)
        pair_models.append(model)
        drifts.append(_corner_drift(Hp, (h, w)))

    pairs = len(grays) - 1
    # Decide staticness from the MEDIAN drift of pairs that actually produced a
    # background transform — NOT the pairs that failed feature detection (those
    # return identity, and counting their 0-drift would falsely drag a moving camera
    # toward "static"). A pair with detected-but-still features is a real 0-drift vote.
    real_drifts = [d for d, mdl in zip(drifts, pair_models) if mdl != "none"]
    none_pairs = sum(1 for mdl in pair_models if mdl == "none")
    med_drift = float(np.median(real_drifts)) if real_drifts else 0.0
    is_static = med_drift < STATIC_PX
    if none_pairs:
        warnings.append(f"camera: {none_pairs}/{pairs} frame-pair(s) lacked reliable "
                        "background features")
    if not real_drifts:
        warnings.append("no frame-pair yielded a background transform; assuming static camera")
        is_static = True

    # Pass 2: dense flow; subtract camera only if the camera is globally moving.
    motion_energy = np.zeros((h, w), np.float32)
    per_frame = [[1.0, 0, 0, 0, 1.0, 0, 0, 0, 1.0]]   # frame0 = identity (ref -> frame0)
    cum = np.eye(3)
    for i in range(1, len(grays)):
        Hp = pair_H[i - 1]
        rflow = _residual_flow(grays[i - 1], grays[i], Hp, is_static)
        motion_energy = np.maximum(motion_energy, np.linalg.norm(rflow, axis=2))
        cum = Hp @ cum                                # cumulative reference(0) -> frame i
        per_frame.append([round(float(v), 6) for v in cum.flatten().tolist()])

    model_label = "affine" if "affine" in pair_models else "none"
    camera = {
        "is_static": is_static,
        "model": "none" if is_static else model_label,
        "reference": "frame0",
        "per_frame": [] if is_static else per_frame,
        "residual_px": round(med_drift, 3),
    }

    rep = frames[len(frames) // 2]
    mask, mask_method = _build_mask(rep, (x, y, bw, bh), motion_energy)
    if mask_method == "bbox_motion_fallback":
        warnings.append("GrabCut unavailable for this bbox (near full-frame/degenerate); "
                        "mask is motion-gated bounding box only, not a segmented object")
    if int((mask > 0).sum()) == 0:
        warnings.append("no moving pixels found inside the seed bbox; using full seed bbox")
        mask = np.zeros((h, w), np.uint8)
        mask[y:y + bh, x:x + bw] = 255
        mask_method = "bbox_empty_fallback"

    if clip.get("count_unknown") and len(frames) >= MAX_FRAMES:
        warnings.append(f"clip frame count unknown; analyzed only the first {len(frames)} frames")

    mask_obj = {
        "encoding": "rle", "w": w, "h": h,
        "data": encode_mask_rle(mask > 0),
        "bbox": _mask_bbox_norm(mask, w, h),
        "coverage": round(float((mask > 0).sum()) / (w * h), 4),
        "method": mask_method,
    }

    raw = {
        "motion_id": motion_id, "class": cls, "seed_bbox": bx,
        "mask": mask_obj, "camera": camera, "depth": None,
        "engine": ENGINE, "warnings": warnings,
    }
    contract, warns = contracts.normalize_region_preprocess(raw, clip)
    return contract, warns, {"frame": rep, "mask": mask, "box": (x, y, bw, bh)}
