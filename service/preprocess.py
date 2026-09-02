"""MotionLife Step 2 — region preprocessing (camera motion + object mask).

Given a clip + one Contract-A motion bbox, produce a region_preprocess contract:
  * camera : per-frame transform (reference frame0 -> frame i) + is_static + residual_px,
             so a consumer can SUBTRACT global camera motion (fixes "scenery scrolls
             with the camera") before extracting object motion.
  * mask   : a clean object mask (RLE) gated to actually-moving pixels inside the bbox,
             so downstream extraction "runs only inside the masked object".
  * depth  : optional (want_depth=True) — Depth Anything V2 via service/depth.py.

Camera + motion gating are pure OpenCV + numpy, so this module imports and runs with no
torch and no downloads (routervenv, py3.9, CPU). Two upgrades are used WHEN IMPORTABLE
and fall back silently otherwise, with the mask's `method`/`engine` naming whichever ran:
  * SAM 2 (service/sam2_seg.py) replaces GrabCut as the segmentation term;
  * Depth Anything V2 (service/depth.py) fills the depth field.

Algorithm (all real cv2): ORB+RANSAC affine per frame pair, estimated from BACKGROUND
features only (outside the seed bbox), falling back to identity/static when there
aren't enough reliable background features; Farneback dense flow minus the
camera-induced flow = residual (true object) motion; SAM 2 (or GrabCut) ∩ motion-gate ∩
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
SEG_FLOOR = float(os.environ.get("PREP_SEG_FLOOR", "0.01"))  # finished mask must cover this
#   fraction of the seed box, else the other segmentation engine is tried (see _build_mask)
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


def _finish_mask(seg_mask, motion_energy, box, hw):
    """seg ∩ motion-gate ∩ bbox, then morphology + largest connected component.

    Shared by the SAM 2 and GrabCut paths so the two can't diverge: the motion gate is
    what makes the mask select actually-MOVING pixels (Step 2's done-when), and the box
    intersect keeps the router's seed authoritative. Returns uint8 {0,255}.
    """
    h, w = hw
    x, y, bw, bh = box
    roi = motion_energy[y:y + bh, x:x + bw]
    thr = max(MOTION_FLOOR, float(np.percentile(roi, MOTION_PCT)) if roi.size else MOTION_FLOOR)
    motion = (motion_energy > thr).astype(np.uint8) * 255
    box_mask = np.zeros((h, w), np.uint8)
    box_mask[y:y + bh, x:x + bw] = 255
    final = cv2.bitwise_and(cv2.bitwise_and(seg_mask, motion), box_mask)
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    final = cv2.morphologyEx(final, cv2.MORPH_OPEN, k)
    final = cv2.morphologyEx(final, cv2.MORPH_CLOSE, k)
    return _largest_cc(final)


def _seg_grabcut(frame, box):
    """GrabCut foreground for a seed box. Returns (uint8 {0,255}, ok).

    ok=False means GrabCut couldn't run at all on this rect and the mask is the plain
    rectangle, so the caller must not advertise it as a segmentation.

    GrabCut needs a rect strictly inside the frame with SOME background outside it. If
    the seed bbox fills (or nearly fills) the frame, inset a margin so background samples
    exist; if that leaves nothing usable, hand back the rectangle.

    Caveat measured on this box (OpenCV 5.0): grabCut is NOT deterministic on an
    ill-conditioned rect — the identical call on the same array returned 458, 458, then
    10 foreground px. It is stable on well-conditioned object boxes (11705/11704/11705).
    That instability is one reason SAM 2 is preferred when available.
    """
    h, w = frame.shape[:2]
    x, y, bw, bh = box
    m = max(2, int(round(0.03 * min(w, h))))
    rx, ry = max(0, x), max(0, y)
    rw = min(bw, w - rx - 1)
    rh = min(bh, h - ry - 1)
    if rx <= m and rw >= w - 2 * m:            # spans full width -> inset
        rx += m; rw -= 2 * m
    if ry <= m and rh >= h - 2 * m:            # spans full height -> inset
        ry += m; rh -= 2 * m
    out = np.zeros((h, w), np.uint8)
    if rw >= 2 and rh >= 2 and rx + rw < w and ry + rh < h:
        gc = np.zeros((h, w), np.uint8)
        try:
            cv2.grabCut(frame, gc, (rx, ry, rw, rh), np.zeros((1, 65), np.float64),
                        np.zeros((1, 65), np.float64), 5, cv2.GC_INIT_WITH_RECT)
            return np.where((gc == cv2.GC_FGD) | (gc == cv2.GC_PR_FGD), 255, 0).astype(np.uint8), True
        except cv2.error:
            pass
    out[y:y + bh, x:x + bw] = 255
    return out, False


def _build_mask(frame, box, motion_energy, warnings=None):
    """segment(bbox) ∩ motion-gate ∩ bbox, cleaned. Returns (uint8 {0,255}, method).

    SAM 2 (service/sam2_seg.py) is the preferred segmentation term; GrabCut is the
    fallback AND the rescue when SAM 2's finished mask lands below SEG_FLOOR of the seed
    box. Whichever survives, the larger finished mask wins, so a bad seed box can't leave
    the pipeline with a near-empty mask. Methods: "sam2+motion", "grabcut+motion", or
    "bbox_motion_fallback" (a motion-gated rectangle, surfaced as a warning by the caller
    so a rectangle is never advertised as a segmented object mask).

    Why SAM 2 is preferred, measured on 4 clips with YOLO/hand seed boxes as
    finished-mask fraction of the seed box (SAM 2 vs GrabCut):
        flag 0.221/0.221 · walk-man 0.124/0.074 · boat 0.174/0.192 · smoke 0.196/0.164
    A wash on flag, clearly better on walk-man and smoke, slightly worse on boat — but
    SAM 2 never degenerated to 0 while GrabCut did on ill-conditioned boxes, and GrabCut
    is non-deterministic there (see _seg_grabcut). Mask quality is dominated by SEED BOX
    quality, not by the engine: the same clip with a box cutting the flag in half drops
    SAM 2 to 58 px, which is exactly what the SEG_FLOOR rescue below catches.

    Deliberately ONE representative frame per engine. Unioning K frames scores higher
    (flag 0.246, walk-man 0.207) but provably leaks background for a TRANSLATING object —
    the union of a walking man at 3 frames includes the pavement he crossed — and a
    majority vote instead collapses GrabCut to 0 on walk-man and boat.
    """
    h, w = frame.shape[:2]
    x, y, bw, bh = box
    floor_px = max(16, int(SEG_FLOOR * bw * bh))
    cands = []                                     # (finished mask, method, px)

    try:
        import sam2_seg                            # optional: torch-free venvs skip this
        ok, why = sam2_seg.available()
        if ok:
            sam_mask, score = sam2_seg.box_mask(frame, (x, y, bw, bh))
            fin = _finish_mask(sam_mask, motion_energy, box, (h, w))
            cands.append((fin, "sam2+motion", int((fin > 0).sum())))
        elif warnings is not None and "pip install" not in why:
            warnings.append(f"SAM 2 unavailable ({why}); used GrabCut")
    except Exception as ex:
        if warnings is not None:
            warnings.append(f"SAM 2 failed ({type(ex).__name__}: {ex}); used GrabCut")

    if cands and cands[0][2] >= floor_px:
        return cands[0][0], cands[0][1]            # SAM 2 mask is usable — done

    gc_mask, gc_ok = _seg_grabcut(frame, box)
    fin = _finish_mask(gc_mask, motion_energy, box, (h, w))
    cands.append((fin, "grabcut+motion" if gc_ok else "bbox_motion_fallback",
                  int((fin > 0).sum())))
    best = max(cands, key=lambda c: c[2])
    if len(cands) > 1 and warnings is not None:
        warnings.append(
            f"SAM 2's mask covered only {cands[0][2]} px of the seed box "
            f"(<{floor_px}); used {best[1].split('+')[0]} instead")
    return best[0], best[1]


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
def preprocess(path, bbox_norm, motion_id="", cls="", want_depth=False):
    """Returns (region_preprocess_contract, warnings, viz).

    viz = {"frame": rep_bgr, "mask": uint8, "box": (x,y,bw,bh)} for the CLI overlay
    (the server ignores it).

    want_depth: fill contract["depth"] via Depth Anything V2 (service/depth.py). OFF by
    default because it pulls in torch+transformers and costs a ~0.5-5s cold start, which
    the OpenCV-only default (routervenv, py3.9) must not depend on. When it's requested
    but unavailable the contract keeps depth=None and gains a warning — never a fake zero.
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
    mask, mask_method = _build_mask(rep, (x, y, bw, bh), motion_energy, warnings)
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

    # engine string names what ACTUALLY ran, so a consumer can tell a SAM 2 mask from a
    # GrabCut one without parsing method strings
    depth_obj = None
    engine = ENGINE.replace("farneback", "sam2+farneback") if mask_method == "sam2+motion" else ENGINE
    if want_depth:
        try:
            import depth as DEPTH                      # lazy: torch/transformers only here
            ok, why = DEPTH.available()
            if not ok:
                warnings.append(f"depth requested but unavailable: {why}")
            else:
                depth_obj = DEPTH.depth_summary(frames, mask > 0)
                engine = f"{engine}+{DEPTH.ENGINE}"   # append, so a sam2+ prefix survives
        except Exception as ex:
            warnings.append(f"depth failed ({type(ex).__name__}: {ex}); mask/camera unaffected")

    raw = {
        "motion_id": motion_id, "class": cls, "seed_bbox": bx,
        "mask": mask_obj, "camera": camera, "depth": depth_obj,
        "engine": engine, "warnings": warnings,
    }
    contract, warns = contracts.normalize_region_preprocess(raw, clip)
    return contract, warns, {"frame": rep, "mask": mask, "box": (x, y, bw, bh)}
