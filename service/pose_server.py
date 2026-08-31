"""Tiny pose-extraction HTTP endpoint (stdlib only, no framework).

POST /extract              raw video bytes in the body
  ?kind=pose  (default)  -> MediaPipe Pose (BlazePose). Response shape is FROZEN for the
                            app: { joints, fps, engine, detected, total, gait,
                            frames:[[ [x,y,c] x13 ] | null ] }.

                            `fps` is the rate the frames were actually SAMPLED at, which
                            is not always 15, and it is a FLOAT. It used to be hardcoded
                            to 15 while the sampler decimates by `round(src_fps / 15)` —
                            an integer step, so only a source at ~30fps (step 2) lands on
                            15 exactly. Measured: a 24fps clip decimates to 11.988 and was
                            labelled 15, and the animator plays a swatch at its stated
                            fps, so it ran 25% fast. walk-man.mp4 is one of those clips
                            (23.976fps), so this was wrong for the app's own fixture.

                            `gait` is a MEASUREMENT of whether these frames contain a walk
                            cycle a limb rig can follow — see _gait_coherence. A clip
                            filmed head-on has no recoverable 2D stride, and the rig cannot
                            tell that apart from a real one, so it is reported rather than
                            left to look like a broken animator. Keys: score, walkable,
                            period, foot_gap, periodicity, ankle_visibility, and a `note`
                            present only when walkable is false.
  ?kind=pose&fmt=b       -> the same but as a Contract-B skeleton swatch (adds
                            viewpoint + gap-filled frames + confidence).
  ?kind=hands            -> MediaPipe Hands (0..2 hands x 21 landmarks) skeleton swatch.
  ?kind=face             -> MediaPipe FaceMesh (468 landmarks) skeleton swatch.
  ?fmt=swatch            -> (Step 7) any of the above nested in the UNIFIED Contract-B
                            swatch, so a skeleton validates against the same
                            contracts.validate_swatch() as a texture or a path.
GET /  health -> {ok, engine, kinds:[...]}

Hands/face landmarks have NO usable visibility, so they emit [x,y,z] (z = relative
depth); pose keeps [x,y,visibility]. Contract-B shapes live in service/contracts.py.

Run with the MediaPipe venv (Python <=3.12):
  /tmp/ms-test/mpvenv/bin/python service/pose_server.py    # serves on :8770
"""
import json, tempfile, os, sys, statistics
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs
from collections import Counter
import cv2
import numpy as np
import mediapipe as mp

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import contracts

PORT = int(os.environ.get("POSE_PORT", "8770"))
MAX_FRAMES = 160          # cap so an uploaded clip stays snappy
CHUNK = 1 << 20           # stream the upload instead of buffering it all in RAM
GAP_K = 5                 # interpolate detection gaps up to this many frames (~0.33s @15fps)
MP = mp.solutions.pose
MP_HANDS = mp.solutions.hands
MP_FACE = mp.solutions.face_mesh
IDX = {"nose":0,"l_sho":11,"r_sho":12,"l_elb":13,"r_elb":14,"l_wri":15,"r_wri":16,
       "l_hip":23,"r_hip":24,"l_knee":25,"r_knee":26,"l_ank":27,"r_ank":28}
NAMES = list(IDX.keys())

def extract(path):
    raw, eff_fps = _sample_frames(path)
    seq = []
    with MP.Pose(model_complexity=1, min_detection_confidence=0.5,
                 min_tracking_confidence=0.5) as pose:
        for fr in raw:
            res = pose.process(cv2.cvtColor(fr, cv2.COLOR_BGR2RGB))
            if not res.pose_landmarks:
                seq.append(None); continue
            lm = res.pose_landmarks.landmark
            pts = {n:(lm[i].x, lm[i].y, lm[i].visibility) for n,i in IDX.items()}
            xs=[p[0] for p in pts.values()]; ys=[p[1] for p in pts.values()]
            x0,y0=min(xs),min(ys); bw=max(1e-3,max(xs)-x0); bh=max(1e-3,max(ys)-y0)
            seq.append([[round((pts[n][0]-x0)/bw,4), round((pts[n][1]-y0)/bh,4),
                         round(float(pts[n][2]),3)] for n in NAMES])
    good = [s for s in seq if s]
    return {"joints":NAMES,"fps":eff_fps,"engine":"mediapipe_blazepose",
            "detected":len(good),"total":len(seq),"gait":_gait_coherence(seq),
            "frames":seq}


# ── shared helpers (used by the kind=pose&fmt=b / hands / face extractors) ────
def _sample_frames(path):
    """Decimate a clip toward ~15fps. Returns (frames, effective_fps).

    The step is an INTEGER (you cannot read half a frame), so the result only lands on 15
    exactly when the source is ~30fps. Every caller must stamp the effective rate it gets
    back rather than assuming 15 — the animator plays a pose swatch at its stated fps, so a
    wrong stamp is a wrong playback speed, silently and for the whole clip.
    """
    cap = cv2.VideoCapture(path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    step = max(1, round(fps / 15))
    raw, i = [], 0
    while len(raw) < MAX_FRAMES:
        ok, fr = cap.read()
        if not ok: break
        if i % step == 0: raw.append(fr)
        i += 1
    cap.release()
    return raw, round(fps / step, 3)


def _best_lag(v):
    """Strongest PERIODICITY of a signal, as (correlation, lag_in_frames).

    Autocorrelation asks how much the signal looks like itself shifted by L frames. A
    repeating motion peaks at its period; noise peaks nowhere in particular.

    The peak has to be a LOCAL MAXIMUM, not the largest value found. Autocorrelation starts
    at 1.0 by definition and decays away from lag 0, so for any smooth signal the largest
    value over a lag range is whatever the smallest lag in that range happens to be — that
    measures smoothness, not repetition. An earlier version of this took the maximum and
    duly reported a 3-frame "stride" at 0.89 for a man taking one step every 21 frames.
    """
    if len(v) < 8: return 0.0, 0
    sd = float(v.std())
    if sd < 1e-9: return 0.0, 0
    v = (v - v.mean()) / sd
    r = [float((v[:-L] * v[L:]).mean()) for L in range(1, len(v) // 2)]
    best, lag = 0.0, 0
    for i in range(1, len(r) - 1):
        if r[i] > r[i - 1] and r[i] >= r[i + 1] and r[i] > best:
            best, lag = r[i], i + 1        # r[i] is lag i+1
    return round(best, 3), lag


# How wide the feet must part, in the clip-normalized units _normalize_clip produces, before
# a stride counts as visible in the image at all. Measured foot-gap swing on seven clips:
# side-on runner 1.21, side-on walker 0.89, walk-man 0.43, dance 0.45, walk-grid 0.03,
# head-on walker 0.03. 0.30 sits below every clip where a stride is actually visible and
# well above the two where it is not.
GAIT_GAP_MIN = 0.30
# Score above which a limb rig has a real cycle to follow. Measured: 0.99 / 0.77 / 0.77 for
# the three real gaits, 0.43 / 0.02 / 0.00 for dance, head-on and the grid clip. 0.6 sits in
# that gap rather than next to either side of it.
GAIT_WALKABLE_MIN = 0.6
# Below this median visibility, MediaPipe is placing the ankles rather than seeing them, so a
# small foot gap says nothing about the walk. Measured: 0.09 and 0.26 on a clip framed from
# the waist up, against 0.82-0.99 on every clip with the feet in shot.
GAIT_ANKLE_VIS_MIN = 0.5


def _gait_coherence(frames):
    """Do these frames contain a WALK CYCLE a limb rig can follow? Measured, not assumed.

    Measured on ONE signal: the horizontal gap between the ankles, l_ank.x - r_ank.x.

    That gap is the stride as the IMAGE sees it, which is the only stride the rig can
    reproduce — it drives limb rotations from a 2D projection and has nothing else to read.
    The gap also does the work three separate heuristics used to do badly:

      * It is translation-free by construction. Both ankles carry the body's journey across
        the frame, so subtracting one from the other removes it exactly. No detrending, no
        polynomial fit, nothing to tune.
      * It is the antiphase test. Feet that alternate contribute to the difference twice
        over; feet that move together cancel. A head-on walk therefore reads as a small gap
        without any special case for head-on.
      * It is one signal, so "do the two ankles agree on a period" stops being a question.

    Two numbers come out of it: how far the feet part (is there a stride in the image at
    all) and how strongly that parting repeats (is it a cycle rather than drift). Measured
    through this code on seven clips, gap swing then periodicity then score:

        side-on walker  0.89  0.99  0.99      dance           0.45  0.43  0.43
        side-on runner  1.21  0.77  0.77      head-on walker  0.03  0.19  0.02
        walk-man        0.43  0.77  0.77      grid clip       0.03  0.00  0.00

    The head-on walker is the case that prompted this. His feet never part in the image —
    0.03 against 0.43 for the same walk seen from the side — because the stride happens
    along the camera axis. MediaPipe sees his joints perfectly well (mean visibility 0.99);
    there is simply no 2D swing to extract, and its own z does not rescue one either. The
    rig cannot notice this: a track of jitter is still a track. So it is reported here
    rather than left to look like a broken animator.

    A small gap has two possible causes, so ankle visibility is measured too: a clip framed
    from the waist up gives the same 0.03 gap as the head-on walk, but the fix is to get the
    feet in shot, not to move the camera round.

    Known limit: if the detector swaps left for right mid-clip the gap flips sign, which
    reads as a break in the cycle and lowers the score. That is a false negative, not a
    false positive — it under-claims, which is the safe direction for a warning.

    The gap is in the units of whatever normalization produced `frames`. The thresholds here
    were measured on _normalize_clip output (whole-clip scaling, which is what the app uses);
    the per-frame bbox scaling of the legacy extract() inflates the gap, so the score there
    is a looser bound. Verified to rank the same six clips in the same order on both paths.
    """
    good = [f for f in frames if f]
    if len(good) < 12:
        return {"score": 0.0, "period": 0, "foot_gap": 0.0, "periodicity": 0.0,
                "walkable": False,
                "note": "only %d detected frames — too few to look for a cycle" % len(good)}
    jn = {n: i for i, n in enumerate(NAMES)}
    gap = np.array([f[jn["l_ank"]][0] - f[jn["r_ank"]][0] for f in good], dtype=float)
    swing = float(np.ptp(gap))
    corr, lag = _best_lag(gap)
    # Whether the ankles were SEEN at all. Without this a clip framed from the waist up looks
    # identical to a head-on walk — both give a foot gap of 0.03 — and it would be told to
    # re-film from the side when the fix is to get the feet in frame.
    ank_vis = round(min(float(np.median([f[jn[s]][2] for f in good]))
                        for s in ("l_ank", "r_ank")), 2)
    # Both factors are necessary and neither substitutes for the other: a wide gap that never
    # repeats is not a cycle, and a strong cycle in a gap of nothing is measuring jitter.
    score = round(min(1.0, swing / GAIT_GAP_MIN) * max(0.0, corr), 3)
    out = {"score": score, "period": lag if score else 0,
           "foot_gap": round(swing, 3), "periodicity": corr, "ankle_visibility": ank_vis,
           "walkable": score >= GAIT_WALKABLE_MIN}
    if not out["walkable"]:
        # Say which measurement failed, and say the number. The failures have different causes
        # and different advice, and guessing at "film it from the side" for a clip that simply
        # is not a walk would be a diagnosis dressed up from nothing.
        if ank_vis < GAIT_ANKLE_VIS_MIN:
            why = ("the ankles are barely visible (median visibility %.2f) — the detector is "
                   "placing the feet, not seeing them" % ank_vis)
            hint = ("Nothing can be recovered about a stride from feet that are out of shot. "
                    "A FULL-BODY framing is what carries it.")
        elif swing < GAIT_GAP_MIN:
            why = ("the feet never part horizontally (gap swings %.2f, a visible stride needs "
                   "about %.2f) — the stride is not in the image to extract" % (swing,
                                                                               GAIT_GAP_MIN))
            hint = ("A walk filmed HEAD-ON or from BEHIND puts the stride along the camera "
                    "axis, where it barely projects into the picture. A view from the SIDE is "
                    "what carries it.")
        else:
            why = ("the feet part but not on a repeating cycle (periodicity %.2f) — this looks "
                   "like movement without a stride" % corr)
            hint = ("A limb rig follows an alternating stride. Free movement — dancing, "
                    "gesturing, shifting weight — gives it no cycle to lock onto.")
        out["note"] = ("no walk cycle recoverable from this clip (score %.2f): %s. %s "
                       "The rig will replay detection jitter instead of a walk."
                       % (score, why, hint))
    return out


def _bbox_norm_xyz(lms):
    """Normalize x,y to the landmark set's own bbox (like extract does for pose),
    keeping z. Hands/face have no visibility, so the 3rd value is z (relative depth)."""
    xs = [p.x for p in lms]; ys = [p.y for p in lms]
    x0, y0 = min(xs), min(ys)
    bw = max(1e-6, max(xs) - x0); bh = max(1e-6, max(ys) - y0)
    return [[round((p.x - x0) / bw, 4), round((p.y - y0) / bh, 4), round(float(p.z), 4)] for p in lms]


def fill_gaps(flat_seq, K=GAP_K):
    """Linearly interpolate None runs up to K frames; longer gaps / clip-edge gaps
    stay None (flagged 'gap'). flat_seq: list of equal-length float vectors or None.
    Returns (filled, flags[i] in {'ok','interp','gap'})."""
    n = len(flat_seq)
    out = list(flat_seq)
    flags = ['ok' if s is not None else 'gap' for s in flat_seq]
    i = 0
    while i < n:
        if flat_seq[i] is not None:
            i += 1; continue
        j = i
        while j < n and flat_seq[j] is None:
            j += 1
        gap = j - i
        left = flat_seq[i - 1] if i - 1 >= 0 else None
        right = flat_seq[j] if j < n else None
        if left is not None and right is not None and gap <= K:
            for k in range(gap):
                t = (k + 1) / (gap + 1)
                out[i + k] = [left[m] + t * (right[m] - left[m]) for m in range(len(left))]
                flags[i + k] = 'interp'
        i = j
    return out, flags


def _viewpoint(raws):
    """front | side | unknown via per-frame majority vote over pose landmarks."""
    labels = []
    for pts in raws:
        if not pts:
            continue
        ls, rs, lh, rh, no = pts["l_sho"], pts["r_sho"], pts["l_hip"], pts["r_hip"], pts["nose"]
        if max(ls[2], rs[2]) < 0.5:      # skip only if BOTH shoulders unreliable
            continue                     # (a side view has ONE low-vis shoulder — keep it)
        if max(lh[2], rh[2]) < 0.5:      # torso_h/R below depend on the hips — skip if
            continue                     # both hips are off-frame/extrapolated (garbage)
        shoulder_w = abs(ls[0] - rs[0])
        torso_h = max(1e-3, abs((ls[1] + rs[1]) / 2 - (lh[1] + rh[1]) / 2))
        R = shoulder_w / torso_h
        nose_off = abs(no[0] - (ls[0] + rs[0]) / 2) / max(shoulder_w, 1e-3)
        vis_asym = abs(ls[2] - rs[2])
        if R >= 0.45 and min(ls[2], rs[2]) >= 0.6 and nose_off <= 0.5:
            labels.append("front")
        elif R <= 0.25 or vis_asym >= 0.35 or nose_off >= 0.9:
            labels.append("side")
        else:
            labels.append("unknown")
    return Counter(labels).most_common(1)[0][0] if labels else "unknown"


VIS_OK = 0.5              # landmark visibility below this is not trusted as an anchor


def _clip_scale_and_anchors(raws):
    """Per-clip CONSTANT scale + per-frame limb-independent anchor.

    Why this exists: the byte-frozen extract() normalizes each frame by that
    frame's OWN landmark extent (see the bw/bh there). The wrists are the widest
    landmarks, so a subject flapping
    their arms nearly doubles the divisor and visibly shrinks the shoulders, hips
    and torso — measured on a boy-waving clip, the stored shoulder width swung
    123% while his real shoulder width varied only 17%, correlating -0.95 with arm
    span. Anchoring on the hip midpoint (which the arms cannot move) and dividing
    by ONE constant for the whole clip keeps inter-frame proportions rigid.

    Returns (scale, anchors) where anchors[i] is None for an undetected frame.
    """
    torsos, anchors = [], []
    for pts in raws:
        if not pts:
            anchors.append(None); continue
        ls, rs, lh, rh = pts["l_sho"], pts["r_sho"], pts["l_hip"], pts["r_hip"]
        hips_ok = max(lh[2], rh[2]) >= VIS_OK
        if hips_ok:
            anchors.append(((lh[0] + rh[0]) / 2, (lh[1] + rh[1]) / 2))
        else:                                    # hips unreliable this frame: fall back
            xs = [p[0] for p in pts.values()]    # to its bbox centre (still limb-affected,
            ys = [p[1] for p in pts.values()]    # but only shifts, never rescales)
            anchors.append(((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2))
        if hips_ok and max(ls[2], rs[2]) >= VIS_OK:
            torsos.append(abs((ls[1] + rs[1]) / 2 - (lh[1] + rh[1]) / 2))

    if torsos:
        return max(1e-3, statistics.median(torsos)), anchors
    # No trustworthy torso anywhere (heavy occlusion). Fall back to the clip-wide
    # GLOBAL bbox — still a single constant, so it cannot pulse either.
    allv = [p for pts in raws if pts for p in pts.values()]
    if not allv:
        return 1.0, anchors
    xs = [p[0] for p in allv]; ys = [p[1] for p in allv]
    return max(1e-3, max(max(xs) - min(xs), max(ys) - min(ys))), anchors


def _normalize_clip(raws, aspect=1.0):
    """raws -> [[x,y,vis]x13] per frame in 0..1, via ONE affine transform per clip.

    The scale is uniform on both axes (the old code used separate bw/bh, which
    squashed body proportions to fill the box) and the extent is measured once
    over every frame, so no single frame can rescale the others.

    `aspect` is the source clip's width/height. MediaPipe reports x as a fraction
    of frame WIDTH and y as a fraction of frame HEIGHT, so on a 16:9 clip a
    horizontal distance arrives 1.78x smaller than the same distance measured
    vertically. Scaling BOTH axes by one number (which is what stops the pulsing)
    inherits that squash — measured on the boy-flapping clip, shoulder span over
    body height came out 0.131 where a real human is 0.21-0.27, and 0.131 x 16/9
    = 0.233 lands back in range. Multiplying x by the aspect first puts both axes
    in square-pixel units, so the stored figure has the subject's real
    proportions. The uncorrected raws are still what _viewpoint() votes on: its
    R = shoulder_w/torso_h thresholds were calibrated in image-normalized space.
    """
    if aspect != 1.0:
        raws = [None if not pts else
                {n: (p[0] * aspect, p[1], p[2]) for n, p in pts.items()}
                for pts in raws]
    scale, anchors = _clip_scale_and_anchors(raws)
    cen = []
    for pts, a in zip(raws, anchors):
        if not pts or a is None:
            cen.append(None); continue
        cen.append([((pts[n][0] - a[0]) / scale, (pts[n][1] - a[1]) / scale, pts[n][2])
                    for n in NAMES])
    xs = [p[0] for f in cen if f for p in f]
    ys = [p[1] for f in cen if f for p in f]
    if not xs:
        return [None] * len(raws)
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    ext = max(1e-6, x1 - x0, y1 - y0)            # ONE constant for the whole clip
    padx = (ext - (x1 - x0)) / 2                 # centre the shorter axis in the box
    pady = (ext - (y1 - y0)) / 2
    return [None if f is None else
            [[round((p[0] - x0 + padx) / ext, 4), round((p[1] - y0 + pady) / ext, 4),
              round(float(p[2]), 3)] for p in f]
            for f in cen]


def _reshape3(filled):
    """flat vector -> [[x,y,z]x(len/3)] (or None)."""
    return [None if f is None else [[round(f[k], 4), round(f[k + 1], 4), round(f[k + 2], 4)]
                                    for k in range(0, len(f), 3)] for f in filled]


def extract_pose_b(path):
    """Pose as a Contract-B skeleton swatch: viewpoint + gap-filled frames + confidence."""
    sampled, eff_fps = _sample_frames(path)
    # Pixel aspect of the source, needed to undo MediaPipe's per-axis normalization.
    h0, w0 = (sampled[0].shape[:2] if sampled else (1, 1))
    aspect = (w0 / h0) if h0 else 1.0
    raws = []
    with MP.Pose(model_complexity=1, min_detection_confidence=0.5,
                 min_tracking_confidence=0.5) as pose:
        for fr in sampled:
            res = pose.process(cv2.cvtColor(fr, cv2.COLOR_BGR2RGB))
            if not res.pose_landmarks:
                raws.append(None); continue
            lm = res.pose_landmarks.landmark
            raws.append({n: (lm[i].x, lm[i].y, lm[i].visibility) for n, i in IDX.items()})
    # Normalize over the WHOLE clip, not frame by frame — see _normalize_clip.
    frames = _normalize_clip(raws, aspect)
    detected = sum(1 for f in frames if f)
    vis = [tri[2] for f in frames if f for tri in f]
    conf = sum(vis) / len(vis) if vis else 0.0
    flat = [None if f is None else [v for tri in f for v in tri] for f in frames]
    filled, flags = fill_gaps(flat)
    frames_b = [None if f is None else [[round(f[k], 4), round(f[k + 1], 4), round(f[k + 2], 3)]
                                        for k in range(0, len(f), 3)] for f in filled]
    sw = contracts.empty_skeleton_swatch("pose", "mediapipe_blazepose")
    sw["frames"] = frames_b; sw["total"] = len(frames); sw["detected"] = detected
    sw["flags"] = flags; sw["interpolated"] = sum(1 for fl in flags if fl == "interp")
    sw["viewpoint"] = _viewpoint(raws); sw["confidence"] = round(conf, 3)
    # The rate the frames were actually sampled at — see _sample_frames. The swatch default
    # is 15, which is right only for a ~30fps source.
    sw["fps"] = eff_fps
    # Gait scored on the gap-filled frames, i.e. the ones a rig would actually play.
    sw["gait"] = _gait_coherence(frames_b)
    return contracts.normalize_skeleton_swatch(sw)[0]


def extract_hands(path):
    seq = []
    sampled, eff_fps = _sample_frames(path)
    with MP_HANDS.Hands(static_image_mode=False, max_num_hands=2, model_complexity=1,
                        min_detection_confidence=0.5, min_tracking_confidence=0.5) as hands:
        for fr in sampled:
            res = hands.process(cv2.cvtColor(fr, cv2.COLOR_BGR2RGB))
            if not res.multi_hand_landmarks:
                seq.append(None); continue
            out = []
            handed = res.multi_handedness or []
            for k, lms in enumerate(res.multi_hand_landmarks):
                cl = handed[k].classification[0] if k < len(handed) else None
                out.append({"label": (cl.label.lower() if cl else "?"),
                            "score": round(float(cl.score), 3) if cl else 0.0,
                            "pts": _bbox_norm_xyz(lms.landmark)})
            seq.append(out)
    scores = [h["score"] for f in seq if f for h in f]
    sw = contracts.empty_skeleton_swatch("hands", "mediapipe_hands")
    sw["frames"] = seq; sw["total"] = len(seq); sw["detected"] = sum(1 for s in seq if s)
    sw["fps"] = eff_fps          # the rate actually sampled, not 15 — see _sample_frames
    sw["flags"] = ['ok' if s else 'gap' for s in seq]   # hands are not gap-interpolated
    sw["confidence"] = round(sum(scores) / len(scores), 3) if scores else 0.0
    return contracts.normalize_skeleton_swatch(sw)[0]


def extract_face(path):
    seq = []
    sampled, eff_fps = _sample_frames(path)
    with MP_FACE.FaceMesh(static_image_mode=False, max_num_faces=1, refine_landmarks=False,
                          min_detection_confidence=0.5, min_tracking_confidence=0.5) as face:
        for fr in sampled:
            res = face.process(cv2.cvtColor(fr, cv2.COLOR_BGR2RGB))
            seq.append(_bbox_norm_xyz(res.multi_face_landmarks[0].landmark)
                       if res.multi_face_landmarks else None)
    detected = sum(1 for s in seq if s)
    flat = [None if s is None else [v for p in s for v in p] for s in seq]
    filled, flags = fill_gaps(flat)
    sw = contracts.empty_skeleton_swatch("face", "mediapipe_facemesh")
    sw["frames"] = _reshape3(filled); sw["total"] = len(seq); sw["detected"] = detected
    sw["fps"] = eff_fps          # the rate actually sampled, not 15 — see _sample_frames
    sw["flags"] = flags; sw["interpolated"] = sum(1 for fl in flags if fl == "interp")
    # face has no per-point visibility; `confidence` here is detection COVERAGE, not
    # motion quality (labelled confidence_of='detection_ratio' in the swatch).
    sw["confidence"] = round(detected / max(1, len(seq)), 3)
    return contracts.normalize_skeleton_swatch(sw)[0]


class H(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin","*")
        self.send_header("Access-Control-Allow-Methods","POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers","Content-Type")
    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.end_headers()
    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code); self._cors()
        self.send_header("Content-Type","application/json"); self.end_headers()
        self.wfile.write(body)
    def do_GET(self):
        self._json(200, {"ok": True, "engine": "mediapipe_blazepose",
                         "kinds": ["pose", "hands", "face"]})
    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path != "/extract":
            self._json(404, {"error": "POST /extract?kind=pose|hands|face"}); return
        q = parse_qs(parsed.query)
        kind = q.get("kind", ["pose"])[0]
        fmt = q.get("fmt", ["legacy"])[0]
        n = int(self.headers.get("Content-Length", "0"))
        tf = tempfile.NamedTemporaryFile(suffix=".mp4", delete=False)
        remaining = n
        while remaining > 0:                       # stream to disk in chunks
            chunk = self.rfile.read(min(CHUNK, remaining))
            if not chunk: break
            tf.write(chunk); remaining -= len(chunk)
        tf.close()
        try:
            print(f"[pose] kind={kind} fmt={fmt} from {n//1024} KB clip…", file=sys.stderr)
            if kind == "pose" and fmt not in ("b", "swatch"):
                out = extract(tf.name)             # UNTOUCHED byte-frozen legacy path
            elif kind == "pose":
                out = extract_pose_b(tf.name)
            elif kind == "hands":
                out = extract_hands(tf.name)
            elif kind == "face":
                out = extract_face(tf.name)
            else:
                self._json(400, {"error": f"unknown kind {kind!r}"}); return
            print(f"[pose] detected {out['detected']}/{out['total']} frames"
                  + (f" viewpoint={out.get('viewpoint')}" if 'viewpoint' in out else ""),
                  file=sys.stderr)
            # (Step 7) fmt=swatch nests the skeleton payload in the UNIFIED Contract-B
            # swatch, so pose/hands/face validate against the same validate_swatch() as a
            # texture or a path swatch. fmt=legacy and fmt=b are untouched — the character
            # rig in js/ still reads fmt=legacy byte-for-byte.
            if fmt == "swatch" and out.get("kind") == "skeleton":
                # A clip with no recoverable walk cycle is a WARNING about this swatch, so it
                # travels in the field the UI already shows warnings from (the library chip
                # reads swatch.warnings) rather than needing its own channel. The swatch is
                # still built and still returned — the frames are real, they just are not a
                # gait, and whether to use them anyway is the caller's call.
                g = out.get("gait") or {}
                warn = [g["note"]] if g.get("note") and not g.get("walkable") else []
                out = contracts.skeleton_swatch(out, cls="articulated",
                                                engine=out.get("engine", ""), warnings=warn)
                ok, errs = contracts.validate_swatch(out)
                if not ok:      # our own bug — report it in the payload, don't hide it
                    out["warnings"] = out["warnings"] + [
                        "swatch failed validation: " + "; ".join(errs)]
                    print("[pose] SWATCH VALIDATION FAILED: " + "; ".join(errs),
                          file=sys.stderr)
            self._json(200, out)
        except Exception as e:
            print(f"[pose] error: {e}", file=sys.stderr)
            self._json(500, {"error": str(e)})
        finally:
            os.unlink(tf.name)
    def log_message(self, *a): pass

if __name__ == "__main__":
    print(f"pose_server on http://127.0.0.1:{PORT}  (POST /extract with video bytes)", file=sys.stderr)
    HTTPServer(("127.0.0.1", PORT), H).serve_forever()
