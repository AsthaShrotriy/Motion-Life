"""MotionLife shared contracts (Step 0 of docs/BUILD_PLAN.md).

Three hand-offs frozen here so every backend plugs into stable shapes:
  A  decomposition  — what the VLM Router returns (this file's focus for Step 1)
  B  swatch         — the unified motion swatch every extractor distills into
  C  judge          — the VLM judge's verdict on applied motion

Rules: add fields, never rename (version bump if a shape must break). stdlib-only
so any venv (incl. the py3.9 pose server) can import it.
"""
import math

SCHEMA_VERSION = 1

# ── Motion taxonomy ────────────────────────────────────────────────────────
# Six classes. Each maps to one backend (extractor) and one applicator. Adding a
# motion type = adding a row here + its extractor/applicator — router never changes.
MOTION_CLASSES = {
    "articulated": {
        "desc": "a body with limbs — human, animal, hand or face — that moves its parts",
        "examples": "a person walking, a duck waddling, a waving hand, a talking face",
        "backend": "pose_mediapipe",     # service/pose_server.py (:8770)
        "applicator": "skeletal",         # rig / puppet
    },
    "cloth": {
        "desc": "a soft sheet rippling while anchored — flag, banner, hair, sail, cloth",
        "examples": "a flag fluttering on a pole, hair blowing, a hanging banner",
        "backend": "flow_raft",           # service/server.py (:8765)
        "applicator": "wave",
    },
    "fluid": {
        "desc": "a continuous flowing medium — water, smoke, fire, steam, ripples",
        "examples": "a waterfall, rising smoke, a campfire, river ripples",
        "backend": "flow_raft",
        "applicator": "flow_field",
    },
    "flock": {
        "desc": "many small similar things drifting together — birds, leaves, a crowd, particles",
        "examples": "a flock of birds, falling leaves, a school of fish",
        "backend": "flow_raft",
        "applicator": "flock_drift",
    },
    "rigid_path": {
        "desc": "ONE discrete solid object travelling across the scene as a whole",
        "examples": "a boat drifting, a car passing, a ball rolling, a single plane",
        "backend": "track_bytetrack",     # planned (Step 5)
        "applicator": "path_travel",
    },
    "oscillation": {
        "desc": "something swaying, bobbing or rocking in place without travelling",
        "examples": "a tree swaying, a hanging sign, a buoy bobbing, a pendulum",
        "backend": "parametric",
        "applicator": "oscillate",
    },
}


# Region-preprocess encodings (Step 2). The mask payload is OPAQUE to this module —
# encode/decode lives in preprocess.py so contracts.py stays stdlib-only (the py3.9
# pose venv imports it and must not pull numpy/cv2).
MASK_ENCODINGS = ("rle", "png_b64", "polygon")
CAMERA_MODELS = ("none", "affine", "homography")


def backend_for(motion_class):
    """Route a class -> its extractor backend id (None if unknown)."""
    return (MOTION_CLASSES.get(motion_class) or {}).get("backend")


def applicator_for(motion_class):
    return (MOTION_CLASSES.get(motion_class) or {}).get("applicator")


# Every applicator the taxonomy names, derived from the table so the two can't drift.
APPLICATORS = tuple(dict.fromkeys(r["applicator"] for r in MOTION_CLASSES.values()))

# What each applicator READS (Step 8). An applicator can only run on a swatch whose
# `kind` supplies its payload — a rig needs joints, path_travel needs points, the field
# applicators need a flow field. This table is why routing takes (kind, class) and not
# class alone, and it is what validate_swatch() checks the two against.
APPLICATOR_NEEDS = {
    "skeletal": "skeleton",       # pose payload: named joints per frame
    "wave": "texture",            # flow field, applied as coherent cloth deformation
    "flow_field": "texture",      # flow field, applied as laminar surface flow
    "flock_drift": "texture",     # flow field, applied per child element
    "path_travel": "path",        # travel path: [frame, dx, dy] offsets
    "oscillate": "texture",       # params only — the in-place whole-object default
}


# ── Contract A: decomposition (VLM Router output) ──────────────────────────
def empty_decomposition(clip=None):
    return {"version": SCHEMA_VERSION, "clip": clip or {}, "static": True, "motions": []}


def _enum(v, allowed, default):
    v = str(v).lower() if v is not None else ""
    return v if v in allowed else default


def _count_bucket(v):
    """Bucket a count into 'one'|'many' — handles numerics (2, '5') and synonyms."""
    try:
        return "many" if float(v) > 1 else "one"
    except (TypeError, ValueError):
        s = str(v).lower().strip()
        return "many" if s in ("many", "few", "several", "multiple", "group", "flock", "crowd") else "one"


def normalize_decomposition(raw, clip=None, has_text_prompt=False):
    """Coerce a raw VLM result into a valid Contract-A object.

    Drops motions with an unknown class, clamps bbox/confidence to sane ranges,
    fills the routed backend/applicator from the registry, and assigns stable ids.
    Returns (contract, warnings[]).
    """
    warnings = []
    motions_out = []
    for i, m in enumerate(raw.get("motions", []) if isinstance(raw, dict) else []):
        if not isinstance(m, dict):
            warnings.append(f"motion #{i} not an object; skipped")
            continue
        cls = str(m.get("class", "")).strip().lower()
        if cls not in MOTION_CLASSES:
            warnings.append(f"motion #{i} unknown class {cls!r}; skipped")
            continue
        bbox = m.get("bbox") or [0, 0, 1, 1]
        try:
            x, y, w, h = (float(v) for v in bbox[:4])
        except (TypeError, ValueError):
            warnings.append(f"motion #{i} bad bbox {bbox!r}; defaulted to full frame")
            x, y, w, h = 0.0, 0.0, 1.0, 1.0
        x = _clamp01(x); y = _clamp01(y)
        w = _clamp01(w) or 1.0; h = _clamp01(h) or 1.0
        if x + w > 1: w = 1 - x
        if y + h > 1: h = 1 - y
        conf = m.get("confidence", 0.5)
        try:
            conf = _clamp01(float(conf))
        except (TypeError, ValueError):
            conf = 0.5
        motions_out.append({
            "id": f"m{len(motions_out) + 1}",
            "label": str(m.get("label", cls))[:80],
            "class": cls,
            "bbox": [round(x, 4), round(y, 4), round(w, 4), round(h, 4)],
            "confidence": round(conf, 3),
            "backend": backend_for(cls),
            "applicator": applicator_for(cls),
            # sub-attributes that steer extractors.resolve_best() to the right model
            "subject_type": _enum(m.get("subject_type"), ("human", "animal", "object"), "object"),
            "count": _count_bucket(m.get("count")),
            "has_text_prompt": bool(has_text_prompt),
            "notes": str(m.get("notes", ""))[:240],
        })
    return {
        "version": SCHEMA_VERSION,
        "clip": clip or {},
        "static": len(motions_out) == 0,
        "motions": motions_out,
    }, warnings


def _clamp01(v):
    return 0.0 if v < 0 else 1.0 if v > 1 else v


# ── Contract: region_preprocess (Step 2 — mask + camera + optional depth) ───
# Produced by the preprocess service (:8772) for ONE Contract-A motion. Turns a
# rough seed bbox into a clean object mask, plus per-frame camera motion so the
# consumer can subtract it. The mask.data payload stays opaque here (see
# preprocess.encode_mask_rle / decode_mask_rle).
def empty_region_preprocess(clip=None, motion_id="", cls="", seed_bbox=None):
    return {
        "version": SCHEMA_VERSION,
        "kind": "region_preprocess",
        "clip": clip or {},
        "motion_id": motion_id,
        "class": cls,
        "seed_bbox": _clamp_bbox(seed_bbox or [0, 0, 1, 1]),
        "mask": None,
        "camera": {"is_static": True, "model": "none", "reference": "frame0",
                   "per_frame": [], "residual_px": 0.0},
        "depth": None,
        "engine": "",
        "warnings": [],
    }


def normalize_region_preprocess(raw, clip=None):
    """Validate/clamp a raw region_preprocess dict into the frozen shape.

    Only clamps seed_bbox and sanity-checks the (opaque) mask + camera metadata —
    it never touches mask.data pixel content. Returns (contract, warnings).
    """
    warnings = []
    if not isinstance(raw, dict):
        return empty_region_preprocess(clip), ["raw preprocess result was not an object"]

    out = empty_region_preprocess(clip, str(raw.get("motion_id", "")),
                                  str(raw.get("class", "")), raw.get("seed_bbox"))

    mask = raw.get("mask")
    if isinstance(mask, dict):
        enc = str(mask.get("encoding", "")).lower()
        if enc not in MASK_ENCODINGS:
            warnings.append(f"unknown mask encoding {enc!r}; mask dropped")
        elif not isinstance(mask.get("w"), int) or not isinstance(mask.get("h"), int):
            warnings.append("mask missing integer w/h; mask dropped")
        else:
            out["mask"] = {
                "encoding": enc,
                "w": int(mask["w"]), "h": int(mask["h"]),
                "data": mask.get("data"),               # opaque
                "bbox": _clamp_bbox(mask.get("bbox") or out["seed_bbox"]),
                "coverage": _clamp01(_as_float(mask.get("coverage"), 0.0)),
                "method": str(mask.get("method", "")),   # e.g. grabcut+motion / *_fallback
            }

    cam = raw.get("camera")
    if isinstance(cam, dict):
        model = str(cam.get("model", "none")).lower()
        if model not in CAMERA_MODELS:
            warnings.append(f"unknown camera model {model!r}; treated as none")
            model = "none"
        out["camera"] = {
            "is_static": bool(cam.get("is_static", True)),
            "model": model,
            "reference": str(cam.get("reference", "frame0")),
            "per_frame": cam.get("per_frame") if isinstance(cam.get("per_frame"), list) else [],
            "residual_px": round(_as_float(cam.get("residual_px"), 0.0), 3),
        }

    if raw.get("depth") is not None:
        out["depth"] = raw["depth"]
    out["engine"] = str(raw.get("engine", ""))
    if isinstance(raw.get("warnings"), list):
        warnings = list(raw["warnings"]) + warnings
    out["warnings"] = warnings
    return out, warnings


def _clamp_bbox(b):
    try:
        vals = [float(v) for v in list(b)[:4]]
    except (TypeError, ValueError):
        return [0.0, 0.0, 1.0, 1.0]
    if len(vals) < 4 or not all(math.isfinite(v) for v in vals):   # reject NaN/inf
        return [0.0, 0.0, 1.0, 1.0]
    x, y, w, h = vals
    x = _clamp01(x); y = _clamp01(y)
    w = _clamp01(w) or 1.0; h = _clamp01(h) or 1.0
    if x + w > 1: w = 1 - x
    if y + h > 1: h = 1 - y
    return [round(x, 4), round(y, 4), round(w, 4), round(h, 4)]


def _as_float(v, default):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


# ── Contract B: skeleton swatch (Step 3 — articulated bodies) ───────────────
# One shape for pose / hands / face skeletons. The pose form is a strict SUPERSET
# of today's :8770 /extract response (it adds schema_version/kind/subject/edges/
# viewpoint/confidence but keeps joints/fps/frames/detected/total byte-identical), so
# the existing character rig keeps working. Frame payloads differ per subject:
#   pose : [ [x,y,c] x 13 ]            (c = visibility)
#   hands: [ {label,score,pts:[[x,y,z] x 21]} ]  (0..2 hands; NO per-point visibility)
#   face : [ [x,y,z] x 468 ]          (NO per-point visibility)
SUBJECTS = ("pose", "hands", "face")
VIEWPOINTS = ("front", "side", "unknown")

POSE_JOINTS = ["nose", "l_sho", "r_sho", "l_elb", "r_elb", "l_wri", "r_wri",
               "l_hip", "r_hip", "l_knee", "r_knee", "l_ank", "r_ank"]
POSE_EDGES = [[0, 1], [0, 2], [1, 2], [1, 3], [3, 5], [2, 4], [4, 6],
              [1, 7], [2, 8], [7, 8], [7, 9], [9, 11], [8, 10], [10, 12]]

HAND_JOINTS = ["wrist",
               "thumb_cmc", "thumb_mcp", "thumb_ip", "thumb_tip",
               "index_mcp", "index_pip", "index_dip", "index_tip",
               "middle_mcp", "middle_pip", "middle_dip", "middle_tip",
               "ring_mcp", "ring_pip", "ring_dip", "ring_tip",
               "pinky_mcp", "pinky_pip", "pinky_dip", "pinky_tip"]
HAND_EDGES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8],
              [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16],
              [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]]

SUBJECT_JOINTS = {"pose": POSE_JOINTS, "hands": HAND_JOINTS, "face": []}
SUBJECT_EDGES = {"pose": POSE_EDGES, "hands": HAND_EDGES, "face": []}


# What the single `confidence` scalar MEANS per subject — it is NOT comparable across
# subjects, so we label it rather than pretend one 0..1 quality applies to all.
CONFIDENCE_OF = {"pose": "mean_visibility", "hands": "handedness_score",
                 "face": "detection_ratio"}

# (Step 6) A GENERATED skeleton has no observation behind it, so none of the meanings
# above apply: there is no visibility to average and no detection to count. It gets its
# own label rather than borrowing "mean_visibility", which would read as a measurement.
# Deliberately NOT a fourth entry in CONFIDENCE_OF — that table is per SUBJECT (a
# generated pose is still subject "pose"), and adding a fake subject to carry a
# provenance fact would corrupt SUBJECT_JOINTS/SUBJECT_EDGES lookups.
GENERATED_CONFIDENCE = "generation_only"

# Every meaning `confidence_of` may carry on a skeleton payload.
CONFIDENCE_MEANINGS = tuple(CONFIDENCE_OF.values()) + (GENERATED_CONFIDENCE,)


def empty_skeleton_swatch(subject, engine=""):
    subject = subject if subject in SUBJECTS else "pose"
    return {
        "schema_version": SCHEMA_VERSION,
        "kind": "skeleton",
        "subject": subject,
        "engine": engine,
        "joints": list(SUBJECT_JOINTS[subject]),
        "edges": [list(e) for e in SUBJECT_EDGES[subject]],
        "fps": 15,
        "viewpoint": "unknown",
        "detected": 0,          # frames with a REAL detection (never counts interpolated)
        "total": 0,
        "interpolated": 0,      # frames synthesised by short-gap interpolation
        "confidence": 0.0,
        "confidence_of": CONFIDENCE_OF[subject],   # meaning of `confidence` for this subject
        "flags": [],            # per-frame provenance: 'ok' | 'interp' | 'gap'
        "frames": [],
    }


def normalize_skeleton_swatch(raw):
    """Validate/clamp a raw skeleton swatch into the frozen shape. Frame payloads
    are kept as-is (numeric); only scalars/enums are validated. Returns (contract, warnings).

    This is the SKELETON payload. Step 7's unified swatch (see below) nests it under
    `pose` rather than replacing it, so :8770's `?fmt=b` response stays valid as-is."""
    warnings = []
    if not isinstance(raw, dict):
        return empty_skeleton_swatch("pose"), ["raw skeleton swatch was not an object"]
    subject = str(raw.get("subject", "pose"))
    if subject not in SUBJECTS:
        warnings.append(f"unknown subject {subject!r}; defaulted to pose")
        subject = "pose"
    out = empty_skeleton_swatch(subject, str(raw.get("engine", "")))
    if isinstance(raw.get("joints"), list) and raw["joints"]:
        out["joints"] = [str(j) for j in raw["joints"]]
    if isinstance(raw.get("edges"), list):
        out["edges"] = raw["edges"]
    vp = str(raw.get("viewpoint", "unknown"))
    if vp not in VIEWPOINTS:
        warnings.append(f"unknown viewpoint {vp!r}; defaulted to unknown")
        vp = "unknown"
    out["viewpoint"] = vp
    out["fps"] = int(_as_float(raw.get("fps"), 15)) or 15
    out["confidence"] = round(_clamp01(_as_float(raw.get("confidence"), 0.0)), 3)
    if raw.get("confidence_of") in CONFIDENCE_MEANINGS:
        out["confidence_of"] = raw["confidence_of"]
    frames = raw.get("frames") if isinstance(raw.get("frames"), list) else []
    out["frames"] = frames
    if isinstance(raw.get("flags"), list):
        out["flags"] = raw["flags"]
    out["total"] = int(_as_float(raw.get("total"), len(frames)))
    out["detected"] = int(_as_float(raw.get("detected"),
                                    sum(1 for f in frames if f)))
    out["interpolated"] = int(_as_float(raw.get("interpolated"),
                                         sum(1 for fl in out["flags"] if fl == "interp")))
    return out, warnings


# ── Contract B: the UNIFIED motion swatch (Step 7) ──────────────────────────
# Every backend's output collapses into this one shape. The common core is always
# present; exactly one payload field carries the kind-specific data:
#
#   texture   params + tracks   flow field (cloth / fluid / flock / oscillation)
#   skeleton  pose             a skeleton swatch (see normalize_skeleton_swatch)
#   path      path             one object's travel path (see service/objpath.py)
#
# An applicator reads the core plus only the payload its kind owns, so adding a
# backend never changes this shape — the whole point of Step 0's registry.
#
# `class` and `kind` are NOT the same axis, and routing branches on both — see
# swatch_applicator() below. One clip can yield two swatches with the SAME class and
# different kinds: a rigid_path boat gives a `path` swatch (where the boat goes) AND a
# `texture` swatch (its internal motion, from the flow field). Routing on class alone would
# send that texture swatch to the path_travel applicator, which has no path to follow.
# class = what the motion IS; kind = what shape of data this swatch carries.
SWATCH_KINDS = ("texture", "skeleton", "path")

# What the single `confidence` scalar MEANS per kind. As with skeletons, one 0..1
# number does NOT mean the same thing across kinds, so it is labelled rather than
# silently compared. Skeletons keep their own subject-specific label.
SWATCH_CONFIDENCE_OF = {
    "texture": "gated_motion_amplitude",   # distill's amplitude: static-gated, coverage-weighted
    "skeleton": "",                        # taken from the nested pose payload
    "path": "tracked_fraction",            # fraction of the clip the object was tracked for
}


def swatch_applicator(kind, cls):
    """Which applicator can actually DRIVE this swatch — a function of (kind, class).

    `class` is what the motion IS; `kind` is what shape of data this swatch carries, and
    an applicator can only run on the shape it reads (APPLICATOR_NEEDS). So kind decides
    what is POSSIBLE and class only picks among the applicators that read that kind.

    The case this exists for: one rigid_path clip emits two swatches. The `path` one
    carries the travel, the `texture` one the object's internal motion. `rigid_path` ->
    path_travel is right for the first and wrong for the second — that texture swatch has
    no path — so the texture falls back to the applicator that always reads a flow field.
    Same for an `articulated` texture swatch: no joints, so it cannot drive a rig.
    """
    if kind not in SWATCH_KINDS:
        return ""
    app = applicator_for(cls) or ""
    if APPLICATOR_NEEDS.get(app) == kind:
        return app
    # unclassified, or the class's applicator reads a payload this swatch doesn't carry
    return {"skeleton": "skeletal", "path": "path_travel", "texture": "oscillate"}[kind]

# The 6 renderer dials + the 2 drift terms distill() emits. Frozen: the applicator
# reads these names directly (js/animate.js), so they may be added to, never renamed.
PARAM_KEYS = ("frequency", "amplitude", "direction", "turbulence", "damping",
              "phaseSpread", "driftX", "driftY")

# Bloat control (Step 7's "dense tracks are big"): a 12x12 grid over a 200-frame clip is
# ~500KB of JSON. Cap the sampled frames the way pose caps at 160 and drop a decimal — a
# swatch is a motion SUMMARY, not a lossless recording. The stride is recorded and `fps` is
# divided by it, so playback timing is preserved exactly.
#
# Measured on birds.mp4 (144 tracks x 192 samples, 492 KB), error = the largest distance
# between a dropped raw sample and the line joining the two kept samples that bracket it:
#     cap 192 (stride 1, rounding only)  437 KB  89%   0.34 px on a 480px frame
#     cap 120 (stride 2)                 219 KB  44%   2.11 px          <- chosen
#     cap  60 (stride 4)                 110 KB  22%   5.56 px
#     cap  24 (stride 8)                  55 KB  11%  10.29 px
# 120 halves the payload for 0.4% of a frame; 60 would halve it again but 1.2% starts to
# show as a visible cut corner on a fast track, so this is where it stops.
TRACK_FRAME_CAP = 120
TRACK_COORD_DP = 3         # 3dp of a normalized coord ≈ 0.5px on a 480px analysis frame


def empty_swatch(kind="texture", cls="", engine=""):
    kind = kind if kind in SWATCH_KINDS else "texture"
    cls = cls if cls in MOTION_CLASSES else ""
    return {
        "schema_version": SCHEMA_VERSION,
        "kind": kind,
        "class": cls,
        # (Step 8) which applicator this swatch can drive. Carried IN the swatch so the
        # taxonomy stays in this one file — the renderer maps applicator -> method and
        # never has to know the class list, so adding a class stays a one-file change.
        "applicator": swatch_applicator(kind, cls),
        "engine": engine,
        "fps": 15.0,
        "frames": 0,                 # frames this swatch spans (after any stride)
        "confidence": 0.0,
        "confidence_of": SWATCH_CONFIDENCE_OF.get(kind, ""),
        "params": None,              # texture: the 8 distilled dials
        "bulk": None,                # texture: the steady travel params keeps in driftX/Y
        "tracks": None,              # texture: [[ [x,y], ... ] x N] normalized point tracks
        "track_stride": 1,           # frames skipped when sampling `tracks`
        "pose": None,                # skeleton: a normalized skeleton swatch
        "path": None,                # path: an objpath travel contract
        "warnings": [],
    }


def texture_swatch(params, tracks, fps, cls="", engine="", warnings=None):
    """Build a texture swatch from distill()'s params + grid_trajectories()'s tracks.

    Downsamples/rounds `tracks` per TRACK_FRAME_CAP (and divides fps by the stride
    so the motion plays at its real speed). `bulk` restates driftX/driftY as the
    steady travel component — distill already separates it out, so this is a
    relabelling, not a second estimate.
    """
    sw = empty_swatch("texture", cls, engine)
    p = params if isinstance(params, dict) else {}
    sw["params"] = {k: _as_float(p.get(k), 0.0) for k in PARAM_KEYS}
    sw["bulk"] = {"dx": sw["params"]["driftX"], "dy": sw["params"]["driftY"],
                  "units": "+/-1 = 0.5% of frame width per frame (distill's drift scale)"}
    kept, stride = _thin_tracks(tracks)
    sw["tracks"] = kept
    sw["track_stride"] = stride
    sw["frames"] = len(kept[0]) if kept else 0
    sw["fps"] = round(_as_float(fps, 15.0) / stride, 3)
    # a texture swatch is only as trustworthy as the motion distill actually found
    sw["confidence"] = round(_clamp01(sw["params"]["amplitude"]), 3)
    if warnings:
        sw["warnings"] = [str(w) for w in warnings]
    return sw


def _thin_tracks(tracks, cap=TRACK_FRAME_CAP, dp=TRACK_COORD_DP):
    """[[ [x,y], ... ] x N] -> (thinned tracks, stride). Even stride so timing stays linear."""
    if not isinstance(tracks, list) or not tracks:
        return [], 1
    n = max(len(t) for t in tracks if isinstance(t, list)) if tracks else 0
    stride = max(1, -(-n // cap)) if n else 1          # ceil(n / cap)
    out = []
    for tr in tracks:
        if not isinstance(tr, list):
            continue
        out.append([[round(_as_float(pt[0], 0.0), dp), round(_as_float(pt[1], 0.0), dp)]
                    for pt in tr[::stride] if isinstance(pt, (list, tuple)) and len(pt) >= 2])
    return out, stride


def path_swatch(path, cls="rigid_path", engine="", warnings=None):
    """Wrap an objpath.build_path() contract as a unified swatch."""
    sw = empty_swatch("path", cls, engine)
    p = path if isinstance(path, dict) else {}
    sw["path"] = p
    sw["fps"] = round(_as_float(p.get("fps"), 15.0), 3)
    sw["frames"] = int(_as_float(p.get("frames"), len(p.get("points") or [])))
    # objpath's confidence is None when the caller didn't pass a clip length
    sw["confidence"] = round(_clamp01(_as_float(p.get("confidence"), 0.0)), 3)
    if p.get("confidence") is None:
        sw["confidence_of"] = "unknown (clip length not supplied to build_path)"
    if warnings:
        sw["warnings"] = [str(w) for w in warnings]
    return sw


def skeleton_swatch(skel, cls="articulated", engine="", warnings=None):
    """Wrap a normalize_skeleton_swatch() payload as a unified swatch."""
    sw = empty_swatch("skeleton", cls, engine or str((skel or {}).get("engine", "")))
    norm, warn = normalize_skeleton_swatch(skel)
    sw["pose"] = norm
    sw["fps"] = round(_as_float(norm.get("fps"), 15.0), 3)
    sw["frames"] = int(_as_float(norm.get("total"), len(norm.get("frames") or [])))
    sw["confidence"] = round(_clamp01(_as_float(norm.get("confidence"), 0.0)), 3)
    # a skeleton's confidence means whatever its subject says it means
    sw["confidence_of"] = str(norm.get("confidence_of", "")) or "unknown"
    sw["warnings"] = [str(w) for w in (list(warnings or []) + list(warn))]
    return sw


def normalize_swatch(raw):
    """Coerce any raw dict into a valid unified swatch. TOLERANT — clamps and fills
    rather than rejecting; use validate_swatch() when you need a hard yes/no.
    Returns (contract, warnings)."""
    warnings = []
    if not isinstance(raw, dict):
        return empty_swatch(), ["raw swatch was not an object"]
    kind = str(raw.get("kind", "")).lower()
    if kind not in SWATCH_KINDS:
        warnings.append(f"unknown swatch kind {kind!r}; defaulted to texture")
        kind = "texture"
    cls = str(raw.get("class", ""))
    if cls and cls not in MOTION_CLASSES:
        warnings.append(f"unknown motion class {cls!r}; dropped")
        cls = ""
    out = empty_swatch(kind, cls, str(raw.get("engine", "")))
    out["fps"] = round(_as_float(raw.get("fps"), 15.0), 3) or 15.0
    out["frames"] = int(_as_float(raw.get("frames"), 0))
    out["confidence"] = round(_clamp01(_as_float(raw.get("confidence"), 0.0)), 3)
    out["confidence_of"] = str(raw.get("confidence_of", "")) or SWATCH_CONFIDENCE_OF[kind]
    if isinstance(raw.get("warnings"), list):
        out["warnings"] = [str(w) for w in raw["warnings"]]
    # an applicator that reads a payload this kind doesn't carry is dropped, not honoured:
    # obeying it would send the swatch to a method that has nothing to read (Step 8)
    ra = str(raw.get("applicator", ""))
    if ra and APPLICATOR_NEEDS.get(ra) != kind:
        warnings.append(f"applicator {ra!r} reads a {APPLICATOR_NEEDS.get(ra)!r} payload "
                        f"but this is a {kind} swatch; routed to {out['applicator']!r}")
    elif ra:
        out["applicator"] = ra

    if kind == "texture":
        p = raw.get("params") if isinstance(raw.get("params"), dict) else {}
        missing = [k for k in PARAM_KEYS if k not in p]
        if missing:
            warnings.append(f"texture swatch missing params {missing}; defaulted to 0")
        out["params"] = {k: _as_float(p.get(k), 0.0) for k in PARAM_KEYS}
        b = raw.get("bulk") if isinstance(raw.get("bulk"), dict) else {}
        out["bulk"] = {"dx": _as_float(b.get("dx"), out["params"]["driftX"]),
                       "dy": _as_float(b.get("dy"), out["params"]["driftY"]),
                       "units": str(b.get("units", "")) or
                                "+/-1 = 0.5% of frame width per frame (distill's drift scale)"}
        out["tracks"] = raw.get("tracks") if isinstance(raw.get("tracks"), list) else []
        out["track_stride"] = max(1, int(_as_float(raw.get("track_stride"), 1)))
    elif kind == "skeleton":
        out["pose"], w = normalize_skeleton_swatch(raw.get("pose"))
        warnings.extend(w)
        # a skeleton's confidence means whatever its SUBJECT says it means, so the
        # kind-level default is empty and the nested payload supplies the label
        if not str(raw.get("confidence_of", "")):
            out["confidence_of"] = str(out["pose"].get("confidence_of", "")) or "unknown"
    else:
        out["path"] = raw.get("path") if isinstance(raw.get("path"), dict) else {}
    out["warnings"] = out["warnings"] + [w for w in warnings if w not in out["warnings"]]
    return out, warnings


def validate_swatch(sw):
    """STRICT check that `sw` is a usable unified swatch. Returns (ok, errors[]).

    This is the executable form of Step 7's done-when: a texture, a skeleton and a
    path swatch must all pass this one function. Unlike normalize_swatch it fixes
    nothing — an applicator can trust anything that passes.
    """
    e = []
    if not isinstance(sw, dict):
        return False, ["not an object"]
    if sw.get("schema_version") != SCHEMA_VERSION:
        e.append(f"schema_version must be {SCHEMA_VERSION}, got {sw.get('schema_version')!r}")
    kind = sw.get("kind")
    if kind not in SWATCH_KINDS:
        return False, e + [f"kind must be one of {SWATCH_KINDS}, got {kind!r}"]
    if sw.get("class") not in MOTION_CLASSES and sw.get("class") != "":
        e.append(f"class {sw.get('class')!r} is not a known motion class")
    # (Step 8) the applicator must be able to READ this swatch. Checked here, at the
    # contract boundary, so the class/kind mix-up can never reach the renderer.
    app = sw.get("applicator")
    if app not in APPLICATORS:
        e.append(f"applicator must be one of {APPLICATORS}, got {app!r}")
    elif APPLICATOR_NEEDS.get(app) != kind:
        e.append(f"applicator {app!r} reads a {APPLICATOR_NEEDS.get(app)!r} payload "
                 f"but this is a {kind!r} swatch")
    if not isinstance(sw.get("engine"), str):
        e.append("engine must be a string (name the extractor that produced this)")
    fps = sw.get("fps")
    if not isinstance(fps, (int, float)) or not (0 < fps <= 240):
        e.append(f"fps must be in (0, 240], got {fps!r}")
    frames = sw.get("frames")
    if not isinstance(frames, int) or frames < 0:
        e.append(f"frames must be a non-negative int, got {frames!r}")
    conf = sw.get("confidence")
    if not isinstance(conf, (int, float)) or not (0 <= conf <= 1):
        e.append(f"confidence must be in [0,1], got {conf!r}")
    if not sw.get("confidence_of"):
        e.append("confidence_of must say what `confidence` measures for this kind")
    if not isinstance(sw.get("warnings"), list):
        e.append("warnings must be a list (empty is fine)")

    # exactly ONE payload for the kind, and nothing from another kind
    payloads = {"texture": ("params", "tracks"), "skeleton": ("pose",), "path": ("path",)}
    for other, keys in payloads.items():
        if other == kind:
            continue
        for k in keys:
            if sw.get(k) not in (None, [], {}):
                e.append(f"{kind} swatch must not carry the {other} payload field {k!r}")

    if kind == "texture":
        p = sw.get("params")
        if not isinstance(p, dict):
            e.append("texture swatch needs a params object")
        else:
            for k in PARAM_KEYS:
                if not isinstance(p.get(k), (int, float)):
                    e.append(f"params.{k} must be numeric, got {p.get(k)!r}")
        b = sw.get("bulk")
        if not isinstance(b, dict) or not all(isinstance(b.get(k), (int, float)) for k in ("dx", "dy")):
            e.append("texture swatch needs bulk {dx, dy} (the steady travel component)")
        tr = sw.get("tracks")
        if not isinstance(tr, list) or not tr:
            e.append("texture swatch needs a non-empty tracks list")
        else:
            bad = next((i for i, t in enumerate(tr)
                        if not isinstance(t, list) or not t
                        or not all(isinstance(pt, list) and len(pt) == 2
                                   and all(isinstance(v, (int, float)) for v in pt) for pt in t)), None)
            if bad is not None:
                e.append(f"tracks[{bad}] is not a list of [x,y] pairs")
            elif len({len(t) for t in tr}) != 1:
                e.append("every track must have the same length (one point per sampled frame)")
            elif len(tr[0]) != frames:
                e.append(f"frames says {frames} but tracks carry {len(tr[0])} points")
        if not isinstance(sw.get("track_stride"), int) or sw["track_stride"] < 1:
            e.append("track_stride must be an int >= 1")
    elif kind == "skeleton":
        p = sw.get("pose")
        if not isinstance(p, dict):
            e.append("skeleton swatch needs a pose payload")
        else:
            if p.get("kind") != "skeleton":
                e.append("pose payload must be a skeleton swatch (kind == 'skeleton')")
            if p.get("subject") not in SUBJECTS:
                e.append(f"pose.subject must be one of {SUBJECTS}, got {p.get('subject')!r}")
            if not isinstance(p.get("frames"), list) or not p["frames"]:
                e.append("pose payload needs a non-empty frames list")
            if p.get("subject") != "face" and not p.get("joints"):
                e.append("pose payload needs named joints so an applicator can retarget")
    else:
        p = sw.get("path")
        if not isinstance(p, dict):
            e.append("path swatch needs a path payload")
        else:
            pts = p.get("points")
            if not isinstance(pts, list) or len(pts) < 2:
                e.append("path payload needs >= 2 points ([frame, dx, dy])")
            elif not all(isinstance(q, list) and len(q) == 3
                         and all(isinstance(v, (int, float)) for v in q) for q in pts):
                e.append("every path point must be [frame, dx, dy], all numeric")
            elif len(pts) != frames:
                e.append(f"frames says {frames} but path carries {len(pts)} points")
            if not isinstance(p.get("travel"), dict):
                e.append("path payload needs a travel summary")
            if not p.get("label"):
                e.append("path payload needs the tracked object's label")
    return not e, e


# ── Contract C: judge verdict (Step 9 — VLM judge + auto-tune loop) ─────────
#
# The judge watches a FRAME SEQUENCE of the animated artwork — optionally beside the
# source clip — and answers the two questions a loop can act on: how good is it
# (`score`), and what would make it better (`deltas` on the renderer's own dials).
#
# Three decisions worth stating, because each one is a trap avoided:
#
# 1. `score_of` names what the number measures, the same way a swatch's
#    `confidence_of` does. A bare 0.62 is not information: 0.62 against the source
#    clip and 0.62 for "does this look like cloth at all" are different claims, and
#    only the first is available when there IS a reference clip.
#
# 2. Deltas are signed OFFSETS in each param's own units, never multipliers. The
#    single most common correction on a bad motion is "nothing is moving, raise the
#    amplitude" — and amplitude 0.0 times any multiplier is still 0.0. A multiplier
#    cannot escape a dead param; an offset can.
#
# 3. `wrong_class` is a first-class verdict, not a low score. No amount of dial
#    tuning turns a flock drift into cloth: if the applicator itself is wrong the
#    honest answer is "re-route this", and the loop must stop rather than burn its
#    remaining iterations nudging params that were never the problem.
JUDGE_VERDICTS = ("good", "tune", "wrong_class")

# What `score` measures. With the source clip in the prompt the judge can compare;
# without it, the most it can honestly say is whether the motion reads as its class.
JUDGE_SCORE_OF = ("match_to_reference", "class_plausibility")

# Named sub-scores. They exist to make the critique auditable: a `deltas` entry for
# `frequency` should be explained by a low `speed` axis, and a delta with no matching
# weak axis is a guess. Optional — a judge that only returns the overall score is valid.
JUDGE_AXES = ("speed", "amplitude", "direction", "character")

# Absolute bounds a param may hold. All but `frequency` are exactly what distill.py
# already clamps to (_clamp01 for the six 0..1 dials, +/-1 for the drift pair), so the
# judge cannot push a dial somewhere the extractor would never produce. `frequency` is
# the exception: distill computes it as k*fps/T with NO upper bound, so 6.0 Hz is a
# renderer sanity limit chosen here — at 60 fps that is a 10-frame cycle, which already
# reads as a buzz rather than motion. The presets top out at 3.5.
PARAM_RANGES = {
    "frequency":   (0.0, 6.0),
    "amplitude":   (0.0, 1.0),
    "direction":   (0.0, 360.0),
    "turbulence":  (0.0, 1.0),
    "damping":     (0.0, 1.0),
    "phaseSpread": (0.0, 1.0),
    "driftX":      (-1.0, 1.0),
    "driftY":      (-1.0, 1.0),
}

# `direction` wraps: 350 + 20 is 10, not 360, and the shorter way from 350 to 10 is
# +20 rather than -340. Clamping it like a linear dial would pin motion at due east.
PARAM_CIRCULAR = ("direction",)

# The largest step one iteration may take, ~20% of each param's range. Three iterations
# can therefore move a dial at most ~60% of its range — enough to fix a wrong setting,
# not enough for a single confident-but-wrong verdict to run away with the motion. This
# is the "clamp delta magnitude" half of the plan's anti-oscillation rule.
PARAM_DELTA_MAX = {
    "frequency": 0.5, "amplitude": 0.2, "direction": 45.0, "turbulence": 0.2,
    "damping": 0.15, "phaseSpread": 0.2, "driftX": 0.2, "driftY": 0.2,
}

# Loop policy, here rather than in the caller so the service and the tests agree.
JUDGE_MAX_ITERS = 3        # the plan's cap: <= 3 judge calls per tune run
JUDGE_GOOD = 0.8           # at or above this, stop and keep it — it is good enough
JUDGE_MIN_GAIN = 0.03      # a re-judge must beat the previous score by this to continue


def empty_judgement(score_of="class_plausibility"):
    return {
        "schema_version": SCHEMA_VERSION,
        "verdict": "tune",
        "score": 0.0,
        "score_of": _enum(score_of, JUDGE_SCORE_OF, "class_plausibility"),
        "axes": {},              # optional named sub-scores, JUDGE_AXES
        "deltas": {},            # param name -> signed offset, clamped to PARAM_DELTA_MAX
        "critique": "",          # one or two sentences, shown in the UI verbatim
        "observations": [],      # what the judge actually saw, one phrase each
        "frames_judged": 0,
        "warnings": [],
    }


def normalize_judgement(raw, score_of="class_plausibility", frames_judged=0):
    """Coerce a raw VLM verdict into a valid Contract-C object. Returns (contract, warnings).

    TOLERANT in the same sense as normalize_swatch: clamps and drops rather than
    rejecting, and records every correction in `warnings` so a caller can see that the
    judge overreached. Anything it drops is something the loop must not act on — an
    unknown param name is a hallucinated dial, and applying it would write a key
    js/animate.js never reads.
    """
    warnings = []
    j = empty_judgement(score_of)
    j["frames_judged"] = max(0, int(_as_float(frames_judged, 0)))
    if not isinstance(raw, dict):
        return j, ["raw judgement was not an object"]

    v = str(raw.get("verdict", "")).lower()
    if v not in JUDGE_VERDICTS:
        if v:
            warnings.append(f"unknown verdict {v!r}; defaulted to 'tune'")
        v = "tune"
    j["verdict"] = v
    j["score"] = round(_clamp01(_as_float(raw.get("score"), 0.0)), 3)

    axes = raw.get("axes")
    if isinstance(axes, dict):
        for k, val in axes.items():
            if k in JUDGE_AXES:
                j["axes"][k] = round(_clamp01(_as_float(val, 0.0)), 3)
            else:
                warnings.append(f"dropped unknown axis {k!r}")

    deltas = raw.get("deltas")
    if isinstance(deltas, dict):
        for k, val in deltas.items():
            if k not in PARAM_KEYS:
                warnings.append(f"dropped delta for unknown param {k!r}")
                continue
            d = _as_float(val, 0.0)
            cap = PARAM_DELTA_MAX[k]
            if abs(d) > cap:
                warnings.append(f"clamped {k} delta {d:+.3f} to {cap:+.3f} (per-iteration cap)")
                d = cap if d > 0 else -cap
            if d:
                j["deltas"][k] = round(d, 4)

    j["critique"] = str(raw.get("critique", "") or "")
    obs = raw.get("observations")
    if isinstance(obs, list):
        j["observations"] = [str(o) for o in obs if str(o).strip()]

    # A 'tune' verdict with nothing to tune cannot drive an iteration. Say so rather
    # than let the loop spin on an empty delta set.
    if j["verdict"] == "tune" and not j["deltas"]:
        warnings.append("verdict is 'tune' but no usable deltas were returned")
    if j["verdict"] == "good" and j["deltas"]:
        warnings.append("verdict is 'good'; ignoring the deltas that came with it")
        j["deltas"] = {}

    j["warnings"] = warnings
    return j, warnings


def validate_judgement(j):
    """STRICT check that `j` is a usable verdict. Returns (ok, errors[]).

    The executable form of "the loop can act on this": a caller that passes this can
    apply `deltas` through apply_deltas() without re-checking anything.
    """
    e = []
    if not isinstance(j, dict):
        return False, ["not an object"]
    if j.get("schema_version") != SCHEMA_VERSION:
        e.append(f"schema_version must be {SCHEMA_VERSION}, got {j.get('schema_version')!r}")
    if j.get("verdict") not in JUDGE_VERDICTS:
        e.append(f"verdict must be one of {JUDGE_VERDICTS}, got {j.get('verdict')!r}")
    s = j.get("score")
    if not isinstance(s, (int, float)) or not (0 <= s <= 1):
        e.append(f"score must be in [0,1], got {s!r}")
    if j.get("score_of") not in JUDGE_SCORE_OF:
        e.append(f"score_of must say what the score measures, one of {JUDGE_SCORE_OF}")
    axes = j.get("axes")
    if not isinstance(axes, dict):
        e.append("axes must be an object (empty is fine)")
    else:
        for k, v in axes.items():
            if k not in JUDGE_AXES:
                e.append(f"axes.{k} is not a known axis")
            elif not isinstance(v, (int, float)) or not (0 <= v <= 1):
                e.append(f"axes.{k} must be in [0,1], got {v!r}")
    d = j.get("deltas")
    if not isinstance(d, dict):
        e.append("deltas must be an object (empty is fine)")
    else:
        for k, v in d.items():
            if k not in PARAM_KEYS:
                e.append(f"deltas.{k} is not a renderer param")
            elif not isinstance(v, (int, float)):
                e.append(f"deltas.{k} must be numeric, got {v!r}")
            elif abs(v) > PARAM_DELTA_MAX[k] + 1e-9:
                e.append(f"deltas.{k} exceeds the per-iteration cap {PARAM_DELTA_MAX[k]}")
    if not isinstance(j.get("critique"), str):
        e.append("critique must be a string (it is shown to the user verbatim)")
    if not isinstance(j.get("observations"), list):
        e.append("observations must be a list (empty is fine)")
    if not isinstance(j.get("frames_judged"), int) or j["frames_judged"] < 0:
        e.append("frames_judged must be a non-negative int")
    if not isinstance(j.get("warnings"), list):
        e.append("warnings must be a list (empty is fine)")
    # a verdict of 'tune' that carries no delta is not actionable
    if j.get("verdict") == "tune" and isinstance(d, dict) and not d:
        e.append("verdict 'tune' needs at least one delta to be actionable")
    return not e, e


def apply_deltas(params, deltas):
    """params + deltas, clamped to PARAM_RANGES. Returns (new_params, notes[]).

    Pure: `params` is not mutated. Only PARAM_KEYS are touched, so a params dict
    carrying extra renderer flags (`leafFall`, say) survives intact. `direction` wraps
    instead of clamping — see PARAM_CIRCULAR.
    """
    notes = []
    out = dict(params or {})
    for k, d in (deltas or {}).items():
        if k not in PARAM_KEYS:
            notes.append(f"ignored delta for unknown param {k!r}")
            continue
        lo, hi = PARAM_RANGES[k]
        cur = _as_float(out.get(k), 0.0)
        val = cur + _as_float(d, 0.0)
        if k in PARAM_CIRCULAR:
            val = val % hi
        elif val < lo or val > hi:
            notes.append(f"{k} {val:.3f} clamped into [{lo}, {hi}]")
            val = max(lo, min(hi, val))
        out[k] = round(val, 4)
    return out, notes


def judge_should_continue(history):
    """Loop control. `history` is the verdicts so far, oldest first. Returns (go, reason).

    Both of the plan's failure modes are stopped here rather than trusted to the caller:
    the iteration cap, and "require monotonic score improvement or stop". The reason
    string is meant to be shown — a loop that quietly stops looks like a loop that broke.
    """
    h = [j for j in (history or []) if isinstance(j, dict)]
    if not h:
        return True, "no verdict yet"
    last = h[-1]
    if last.get("verdict") == "wrong_class":
        return False, "the applicator is wrong for this motion — tuning dials cannot fix that"
    if _as_float(last.get("score"), 0.0) >= JUDGE_GOOD:
        return False, f"score {last.get('score')} reached the bar ({JUDGE_GOOD})"
    if last.get("verdict") == "good":
        return False, "the judge is satisfied"
    if len(h) >= JUDGE_MAX_ITERS:
        return False, f"iteration cap ({JUDGE_MAX_ITERS}) reached"
    if not last.get("deltas"):
        return False, "no actionable deltas were returned"
    if len(h) >= 2:
        gain = _as_float(last.get("score"), 0.0) - _as_float(h[-2].get("score"), 0.0)
        if gain < JUDGE_MIN_GAIN:
            return False, (f"score moved {gain:+.3f}, below the {JUDGE_MIN_GAIN} needed "
                           f"to justify another pass")
    return True, "score is still improving"


def judge_best(history):
    """Index of the highest-scoring verdict, or -1 if there are none.

    The loop must leave the BEST iteration applied, not the last one: it stops as soon
    as a pass fails to improve, so the final state is by definition the one that did
    not help. Ties keep the earlier (cheaper) iteration.
    """
    h = [j for j in (history or []) if isinstance(j, dict)]
    if not h:
        return -1
    best, score = 0, _as_float(h[0].get("score"), 0.0)
    for i, j in enumerate(h[1:], start=1):
        s = _as_float(j.get("score"), 0.0)
        if s > score:
            best, score = i, s
    return best


# ── Contract D: layer labels (Step 10 — what is IN the artwork) ─────────────
#
# Contract A answers "what moves in this clip". This answers the other half of
# auto-apply: "what is each object in the drawing", so an extracted swatch can be
# matched to the thing it belongs on. It is what retires layer-name guessing — a
# regex on `/flag|banner|cloth/` is a claim about a *filename*, not about the artwork.
#
# Three decisions, each one a trap avoided:
#
# 1. The field is `motion_class`, NOT `class`. It uses Contract A's vocabulary but it
#    is a WEAKER claim: Contract A observed motion across frames, this one predicts
#    what a STILL drawing would plausibly do if it moved. Naming both `class` would
#    let a prediction be compared against an observation as if they were the same
#    evidence. `confidence_of` says so in the payload too.
#
# 2. `motion_class` may be "" and that is not an error. Most layers in an
#    illustration — background, ground, sky, a signature — should not move at all.
#    Forcing a choice from six classes would make the model label the sky as `fluid`,
#    and auto-apply would then animate it. An empty class means "leave this alone".
#
# 3. `deforms` is DERIVED here from the class, never asked. A model that answered
#    class=cloth + deforms=rigid would be self-contradictory and the caller would
#    have to break the tie anyway; deriving it means the tie cannot arise.
LAYER_DEFORMS = ("mesh", "rigid")

# Which classes need the geometry itself bent (a flag has to ripple; a bird has to
# stay a bird and be moved). This is the honest replacement for the browser's
# `waveMode` name regex — same decision, made from what the artwork depicts.
MESH_CLASSES = ("cloth", "fluid")

LAYER_CONFIDENCE_OF = "depicts_this_class"   # not "moves this way" — see note 1


def deforms_for(motion_class):
    """'mesh' if this class needs the path geometry bent, else 'rigid'."""
    return "mesh" if motion_class in MESH_CLASSES else "rigid"


def empty_layer_labels(art=None):
    return {"version": SCHEMA_VERSION, "kind": "layer_labels", "art": art or {},
            "confidence_of": LAYER_CONFIDENCE_OF, "labels": [], "warnings": []}


def normalize_layer_labels(raw, ids, art=None):
    """Coerce a raw VLM layer-labelling into Contract D. Returns (contract, warnings).

    `ids` is the caller's layer ids. Two rules make the result safe to act on:
      * a label for an id the caller did NOT send is dropped — the model cannot invent
        a layer to animate, and an id typo would otherwise silently target nothing;
      * an id the model skipped simply gets no entry. The caller keeps its own name and
        its own default; absence is reported, not filled in with a guess.
    """
    warnings = []
    known = list(dict.fromkeys(str(i) for i in (ids or [])))
    known_set = set(known)
    out, seen = [], set()
    for i, lab in enumerate(raw.get("labels", []) if isinstance(raw, dict) else []):
        if not isinstance(lab, dict):
            warnings.append(f"label #{i} not an object; skipped")
            continue
        lid = str(lab.get("id", ""))
        if lid not in known_set:
            warnings.append(f"label #{i} names unknown layer {lid!r}; skipped")
            continue
        if lid in seen:
            warnings.append(f"layer {lid!r} labelled twice; kept the first")
            continue
        seen.add(lid)
        cls = str(lab.get("motion_class", "") or "").strip().lower()
        if cls in ("none", "static", "null"):
            cls = ""                       # the model spelling "nothing moves" as a word
        if cls and cls not in MOTION_CLASSES:
            warnings.append(f"layer {lid!r} unknown motion_class {cls!r}; "
                            "treated as 'should not move'")
            cls = ""
        conf = _clamp01(_as_float(lab.get("confidence", 0.5), 0.5))
        out.append({
            "id": lid,
            "label": str(lab.get("label", ""))[:80],
            "motion_class": cls,
            "applicator": applicator_for(cls) or "",
            "deforms": deforms_for(cls),
            "confidence": round(conf, 3),
            "notes": str(lab.get("notes", ""))[:240],
        })
    missing = [i for i in known if i not in seen]
    if missing:
        warnings.append(f"{len(missing)} layer(s) came back unlabelled: "
                        + ", ".join(missing[:8]) + ("…" if len(missing) > 8 else ""))
    res = empty_layer_labels(art)
    res["labels"] = out
    res["warnings"] = warnings
    return res, warnings


def match_swatches_to_layers(swatches, labels, conf_min=0.35):
    """Pair each swatch with the labelled layer it belongs on. Returns (pairs, unmatched).

    `pairs` is [(swatch_index, layer_id)]; `unmatched` is the swatch indices with nowhere
    to go. Lives here, not in the browser, because it is the rule the whole step rests on
    and it has to be testable without a DOM.

    The rule is a one-to-one greedy match on CLASS ONLY, best-confidence first:
      * class equality is the entire criterion. Matching on names would reintroduce
        exactly the guessing this step removes.
      * one layer takes at most one swatch, and one swatch lands on at most one layer.
        Two flags and one cloth swatch means one flag animates; the other is reported as
        having no swatch rather than sharing one, because a shared swatch would look
        like two objects moving in lockstep, which is a lie about the source clip.
      * a layer below `conf_min` is not a candidate at all. A 0.2-confidence guess that
        the sky is fluid is not evidence enough to animate the sky.
      * a swatch with no class matches nothing. It is unmatched, not defaulted.
    """
    cands = sorted(
        (l for l in (labels or [])
         if isinstance(l, dict) and l.get("motion_class") and l.get("confidence", 0) >= conf_min),
        key=lambda l: -_as_float(l.get("confidence"), 0.0))
    used, pairs, unmatched = set(), [], []
    for si, sw in enumerate(swatches or []):
        cls = str((sw or {}).get("class", "") or "")
        hit = next((l for l in cands if l["motion_class"] == cls and l["id"] not in used), None)
        if hit is None:
            unmatched.append(si)
        else:
            used.add(hit["id"])
            pairs.append((si, hit["id"]))
    return pairs, unmatched
