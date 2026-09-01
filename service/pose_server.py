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
import json, math, tempfile, os, sys, statistics
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

# ── admitting a stride that is along the CAMERA AXIS (see _gait_coherence) ────────────────
# Scoring depth with the image plane's own rule does not work. Measured depth score on the
# calibration set: head-on walk 0.537 but DANCE 0.565 — the non-walk scores HIGHER, so no
# threshold on that number can admit the walk and reject the dance. What separates them is the
# thing walking actually IS: the two legs alternate. Measured on the depth thigh tracks:
#
#   clip                      L/R corr   band power L/R   period L/R   gap    verdict
#   brisk walk   HEAD-ON walk   -0.76      73% / 81%      1.29 / 1.29  0.340  ADMIT
#   dance        NOT a walk     +0.15      15% / 20%      1.33 / 0.97  0.666  reject
#   firefly-flap NOT a walk     +0.70      61% / 65%      0.67 / 2.00  0.047  reject
#   walk-grid    waist-up       +0.93      14% /  7%      1.90 / 1.90  0.060  reject
#
# The head-on walk is the only clip that clears all of them, and the two that discriminate do
# so with room to spare: antiphase -0.76 against a next-best of +0.15, band 73% against 65%.
#
# The DEPTH AMPLITUDE is deliberately not one of the discriminators — note that dance has
# twice the depth gap of the real walk. It is only a floor, and it reuses GAIT_GAP_MIN rather
# than introducing a tuned constant, which is defensible now that depth is scaled into the
# same units as the image plane (see _depth_scale). Worth knowing: the head-on walk clears
# that floor by 13% (0.340 against 0.30), so a head-on walk with a shorter stride than this
# one would fail it. It fails CLOSED — back to the picture plane plus the existing "no walk
# cycle" warning — which is the safe direction, but it is a real limit and not a wide margin.
# The two clips whose stride the picture plane already carries (walk-man-side, walk-man) never
# reach this test at all; it is only asked when the picture plane came up empty.
GAIT_DEPTH_ANTIPHASE_MAX = -0.5   # legs must ALTERNATE, not swing together
GAIT_DEPTH_BAND_MIN = 0.5         # ...cyclically, in the 0.5-1.5Hz band a gait lives in
GAIT_DEPTH_AGREE_MIN = 0.8        # ...at ONE cadence both legs share
# The gait band itself, in Hz. A human walk cycles a leg roughly once a second; 0.5-1.5Hz
# spans a slow amble to a brisk walk and excludes both drift (below) and detector noise
# (above). Measured peak periods for the three real walks all land inside it: 1.29s, 1.70s,
# 1.29s.
GAIT_BAND_HZ = (0.5, 1.5)


# Depth scale to fall back on when MediaPipe returns no world landmarks for a clip. Measured
# zk over four clips: 0.541, 0.471, 0.502, 0.476 — a property of the encoding, not of the
# framing, so a median of them is a measurement rather than a guess. Still per-clip wherever
# the world landmarks exist, since this is the one number the depth swing scales with.
DEPTH_SCALE_FALLBACK = 0.50


def _depth_scale(img_seq, wld_seq):
    """How much to multiply image-space z by to put it in the same units as image y.

    MediaPipe documents z as "roughly the same scale as x". Roughly is not enough to build an
    angle on: x is a fraction of frame WIDTH and y a fraction of frame HEIGHT, so the obvious
    correction is to scale z by the aspect ratio the way x is scaled. Measured, that is wrong
    by a factor of ~3.5.

    So it is calibrated instead, against the one output that has real units:
    pose_world_landmarks, which are metres. For each bone, metres-per-image-unit is measured
    along y and along z; their ratio is what z must be multiplied by. The median over eight
    bones is taken so a single noisy joint cannot set the scale.

    Validated on three walks — calibrated image z against the metric thigh swing:

        brisk walk (head-on)   29.5deg vs 30.0deg   (aspect instead: 82.6deg)
        walk-man-side          30.1deg vs 28.7deg   (aspect instead: 96.3deg)
        walk-man (behind)      33.4deg vs 29.2deg   (aspect instead: 75.3deg)

    and the factor itself came out 0.541 / 0.471 / 0.502 / 0.476 on those clips plus dance —
    stable, which is what makes a fallback constant defensible when world landmarks are
    missing.
    """
    pairs = [("l_hip", "l_knee"), ("r_hip", "r_knee"), ("l_knee", "l_ank"),
             ("r_knee", "r_ank"), ("l_sho", "l_elb"), ("r_sho", "r_elb"),
             ("l_sho", "l_hip"), ("r_sho", "r_hip")]
    both = [(i, w) for i, w in zip(img_seq, wld_seq) if i and w]
    if not both:
        return DEPTH_SCALE_FALLBACK
    ratios = []
    for a, b in pairs:
        iy = statistics.median([abs(i[b][1] - i[a][1]) for i, _ in both])
        iz = statistics.median([abs(i[b][3] - i[a][3]) for i, _ in both])
        if iy < 1e-4 or iz < 1e-4:
            continue                      # bone is edge-on in one axis: no scale to read
        wy = statistics.median([abs(w[b][1] - w[a][1]) for _, w in both])
        wz = statistics.median([abs(w[b][2] - w[a][2]) for _, w in both])
        per_y = wy / iy
        if per_y > 1e-6:
            ratios.append((wz / iz) / per_y)
    return statistics.median(ratios) if ratios else DEPTH_SCALE_FALLBACK


def _thigh_track_deg(frames, jn, hip, knee, ax):
    """Unwrapped, de-trended thigh angle in the (ax, y) plane, in degrees.

    Unwrapping matters: a bone whose angle straddles +/-180 makes raw atan2 output jump a
    full turn, and a peak-to-peak taken over that measures the branch cut rather than the
    limb — it reported 140deg of "swing" on an arm that moved 6.5deg. De-trending removes a
    one-way drift so a track is not credited with range it never repeats; the mean is kept
    because nothing downstream should shift.
    """
    out = []
    for f in frames:
        p, q = f[jn[hip]], f[jn[knee]]
        a = math.degrees(math.atan2(q[ax] - p[ax], q[1] - p[1]))
        out.append(a if not out else out[-1] + ((a - out[-1] + 180) % 360) - 180)
    t = np.asarray(out, dtype=float)
    return t - np.linspace(t[0], t[-1], len(t)) + t.mean()


def _band_power(track, fps):
    """(fraction of power in the gait band, period of the strongest band bin in seconds).

    A periodogram rather than an autocorrelation peak. Autocorrelation cannot answer this:
    smoothing or any smooth signal drives r at short lag toward 1, so the largest-r lag is
    always ~2 frames no matter what the signal is — a test I wrote and had to throw away.
    """
    n = len(track)
    if n < 8:
        return 0.0, 0.0
    P = np.abs(np.fft.rfft((track - track.mean()) * np.hanning(n))) ** 2
    k = np.arange(len(P))
    per = np.where(k > 0, n / np.maximum(k, 1), np.inf)      # bin period, in frames
    lo, hi = GAIT_BAND_HZ
    sel = (per >= fps / hi) & (per <= fps / lo) & (k > 0)
    total = P[k > 0].sum()
    if not sel.any() or total <= 0:
        return 0.0, 0.0
    peak = int(k[sel][np.argmax(P[sel])])
    return float(P[sel].sum() / total), (float(n / peak / fps) if peak else 0.0)


def _gait_coherence(frames, fps=15.0):
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
    there is simply no swing in the PICTURE PLANE to extract. The rig cannot notice this: a
    track of jitter is still a track. So it is reported here rather than left to look like a
    broken animator.

    An earlier version of this docstring also claimed "its own z does not rescue one
    either". That was asserted, not measured, and it is false — z was never even in this
    pipeline to test, since extract() puts `visibility` in the third slot and threw depth
    away. Measured on brisk-walk.mp4 (head-on, 62 frames at 11.993fps), the SAME gap taken
    along z instead of x:

        gap swing   x 0.014   z 0.559      (39x)
        thigh swing x  3.5deg z 52.1deg    (15x)

    and the depth version is a gait signal rather than noise: a periodogram of the depth
    thigh track puts 73-82% of its power in the 0.5-1.5Hz stride band and only 3-4% above
    3Hz, peaking at a 1.29s period that every leg bone agrees on. So the depth gap is
    measured here too, and `stride_axis` says which axis actually carries the stride.

    Depth is a FALLBACK, not an upgrade. On the side-on clip the picture plane is plainly
    better — 84-85% stride-band power against 46-74% for depth — so it wins whenever it has
    a cycle at all, and the depth path only opens when it does not. Depth is also reported
    for the LEGS only: measured on the same head-on clip, the right upper arm in the depth
    plane gives 140deg of range at 10% high-frequency power (against 6.5deg and 14% in the
    picture plane), because a raised arm is near-degenerate in depth. Arm swing projects
    laterally from any viewpoint — which is why the arms measure the same ~15deg head-on and
    side-on — so there was never anything for depth to recover there.

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
           "walkable": score >= GAIT_WALKABLE_MIN, "stride_axis": "image"}

    # ── is the stride along the CAMERA AXIS instead? ──────────────────────────────────────
    # Only asked when the picture plane came up empty. The picture plane is the better signal
    # wherever it exists (84-85% stride-band power against 46-74% for depth on the side-on
    # clip), so it is never overridden — this is a fallback, not a preference.
    if len(good[0][0]) >= 4 and not out["walkable"]:
        dgap = np.array([f[jn["l_ank"]][3] - f[jn["r_ank"]][3] for f in good], dtype=float)
        dswing = float(np.ptp(dgap))
        tl = _thigh_track_deg(good, jn, "l_hip", "l_knee", 3)
        tr = _thigh_track_deg(good, jn, "r_hip", "r_knee", 3)
        anti = (float(np.corrcoef(tl, tr)[0, 1])
                if tl.std() > 1e-9 and tr.std() > 1e-9 else 0.0)
        bl, pl = _band_power(tl, fps)
        br, pr = _band_power(tr, fps)
        agree = 1 - abs(pl - pr) / max(pl, pr, 1e-9)
        out.update({"depth_gap": round(dswing, 3), "depth_antiphase": round(anti, 2),
                    "depth_band": [round(bl, 2), round(br, 2)],
                    "depth_period": [round(pl, 2), round(pr, 2)],
                    "depth_agreement": round(agree, 2)})
        # All four are necessary. The feet have to actually part in depth; the legs have to
        # ALTERNATE (the one thing that makes a walk a walk, and what rejects the dance that
        # otherwise outscored this walk); the motion has to be cyclic in the gait band; and
        # both legs have to report the same cadence. The ankles also still have to have been
        # SEEN — depth is inferred from the same landmarks, so feet out of shot are no more
        # recoverable in z than in x.
        if (dswing >= GAIT_GAP_MIN and anti <= GAIT_DEPTH_ANTIPHASE_MAX
                and min(bl, br) >= GAIT_DEPTH_BAND_MIN and agree >= GAIT_DEPTH_AGREE_MIN
                and ank_vis >= GAIT_ANKLE_VIS_MIN):
            out["stride_axis"] = "depth"
            out["score"] = round(min(1.0, dswing / GAIT_GAP_MIN) * abs(anti), 3)
            out["period"] = int(round((pl + pr) / 2 * fps)) if pl and pr else 0
            out["walkable"] = True
            out["note"] = ("the stride is along the CAMERA AXIS, not across the picture: the "
                           "feet part %.2f sideways but %.2f in depth, the legs alternate "
                           "(correlation %.2f) and both agree on a %.2fs cycle. Driving the "
                           "LEGS from the depth channel — real extracted motion, though "
                           "MediaPipe estimates depth less precisely than position, so this "
                           "stride is coarser than the same walk filmed from the SIDE."
                           % (swing, dswing, anti, (pl + pr) / 2))
            return out
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


def _normalize_clip(raws, aspect=1.0, out=None):
    """raws -> [[x,y,vis(,z)]x13] per frame in 0..1, via ONE affine transform per clip.

    `out`, when a dict is passed, receives the ROOT TRACK: out["root"] is one [dx,dy] per
    frame (None where undetected) giving the anchor's own movement, mean-centred, in the
    SAME units as the returned frames. See the note on `cen` below for why it exists.

    A 4th slot carries relative DEPTH when the caller supplied it (see extract_pose_b).
    It is appended rather than inserted so every consumer that reads [0],[1],[2] is
    untouched — the shipped swatches on disk stay valid and 3-wide.

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
    depth = any(pts and len(next(iter(pts.values()))) >= 4 for pts in raws)
    if aspect != 1.0:
        # x takes the aspect correction; z does NOT. z arrives already scaled into y's units
        # by the caller (see _depth_scale) — a measured factor, because "z is roughly the
        # same scale as x" is documented as approximate and is not accurate enough to build
        # an angle on. Applying `aspect` to z as well made the head-on thigh swing 82.6deg
        # against a metric ground truth of 30.0deg.
        raws = [None if not pts else
                {n: (p[0] * aspect, p[1], p[2]) + ((p[3],) if depth else ())
                 for n, p in pts.items()}
                for pts in raws]
    scale, anchors = _clip_scale_and_anchors(raws)
    cen = []
    for pts, a in zip(raws, anchors):
        if not pts or a is None:
            cen.append(None); continue
        # z is NOT anchored. The anchor removes the subject's travel across the frame, and
        # MediaPipe's z is already hip-relative, so there is nothing to remove; a per-frame
        # offset would not change a bone angle anyway, which only reads differences within
        # one frame. It is scaled, though — a depth angle has to be in the same units as
        # the vertical it is taken against.
        cen.append([((pts[n][0] - a[0]) / scale, (pts[n][1] - a[1]) / scale, pts[n][2])
                   + ((pts[n][3] / scale,) if depth else ())
                    for n in NAMES])
    xs = [p[0] for f in cen if f for p in f]
    ys = [p[1] for f in cen if f for p in f]
    if not xs:
        return [None] * len(raws)
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    ext = max(1e-6, x1 - x0, y1 - y0)            # ONE constant for the whole clip
    padx = (ext - (x1 - x0)) / 2                 # centre the shorter axis in the box
    pady = (ext - (y1 - y0)) / 2
    # ── the anchor's own movement, kept instead of thrown away ────────────────────────────
    # Anchoring at the hip is what stops the arms rescaling the torso, but it also subtracts
    # every bit of the subject's TRANSLATION — the sway, the bob, the hop. That is not a
    # rounding loss: measured on the dance clip, the hip centre travels 49.9% of a torso
    # sideways and 15.6% vertically, and after anchoring both come back as a range of
    # 0.0000. The limb angles are all that survive, which is why a figure driven by this
    # bobs on the spot however hard it swings its arms.
    #
    # Tilt and squash need no rescue — they are DIFFERENCES within one frame (shoulder to
    # shoulder, shoulder to hip), so the anchor cannot touch them. Translation is the only
    # channel the normalization destroys, so translation is the only one shipped back.
    #
    # Mean-centred, not first-frame-centred: a clip that starts mid-sway would otherwise
    # begin with a constant offset and the whole figure would sit off its mark.
    if out is not None:
        pres = [(a, f) for a, f in zip(anchors, cen) if a is not None and f is not None]
        if pres:
            mx = statistics.fmean([a[0] for a, _ in pres])
            my = statistics.fmean([a[1] for a, _ in pres])
            out["root"] = [None if a is None else
                           [round((a[0] - mx) / scale / ext, 4),
                            round((a[1] - my) / scale / ext, 4)]
                           for a in anchors]
        else:
            out["root"] = [None] * len(raws)
    return [None if f is None else
            [[round((p[0] - x0 + padx) / ext, 4), round((p[1] - y0 + pady) / ext, 4),
              round(float(p[2]), 3)] + ([round(p[3] / ext, 4)] if depth else [])
             for p in f]
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
    raws, wlds = [], []
    with MP.Pose(model_complexity=1, min_detection_confidence=0.5,
                 min_tracking_confidence=0.5) as pose:
        for fr in sampled:
            res = pose.process(cv2.cvtColor(fr, cv2.COLOR_BGR2RGB))
            if not res.pose_landmarks:
                raws.append(None); wlds.append(None); continue
            lm = res.pose_landmarks.landmark
            # z is kept as a FOURTH value, not in place of anything. A head-on walk puts its
            # whole stride on this axis (measured: 39x the sideways foot gap) and the third
            # slot is already visibility, which nothing else can supply — see _gait_coherence.
            raws.append({n: (lm[i].x, lm[i].y, lm[i].visibility, lm[i].z)
                         for n, i in IDX.items()})
            # World landmarks are metres. Kept only to calibrate the depth scale, not stored:
            # they are hip-centred and lose the framing every other consumer needs.
            wl = res.pose_world_landmarks
            wlds.append({n: (wl.landmark[i].x, wl.landmark[i].y, wl.landmark[i].z)
                         for n, i in IDX.items()} if wl else None)
    # Put z into y's units BEFORE normalizing, so everything downstream sees one coherent
    # space and no consumer has to know about the correction. See _depth_scale.
    zk = _depth_scale(raws, wlds)
    raws = [None if not pts else
            {n: (p[0], p[1], p[2], p[3] * zk) for n, p in pts.items()} for pts in raws]
    # Normalize over the WHOLE clip, not frame by frame — see _normalize_clip.
    # `norm` collects the root track the anchoring would otherwise discard.
    norm = {}
    frames = _normalize_clip(raws, aspect, out=norm)
    detected = sum(1 for f in frames if f)
    vis = [tri[2] for f in frames if f for tri in f]
    conf = sum(vis) / len(vis) if vis else 0.0
    # Stride is however wide _normalize_clip made the tuples, so gap-filling interpolates z
    # along with everything else rather than dropping it or shearing the flat vector.
    w = len(frames[next(i for i, f in enumerate(frames) if f)][0]) if detected else 3
    flat = [None if f is None else [v for tri in f for v in tri] for f in frames]
    filled, flags = fill_gaps(flat)
    frames_b = [None if f is None else
                [[round(f[k], 4), round(f[k + 1], 4), round(f[k + 2], 3)]
                 + ([round(f[k + 3], 4)] if w >= 4 else [])
                 for k in range(0, len(f), w)] for f in filled]
    sw = contracts.empty_skeleton_swatch("pose", "mediapipe_blazepose")
    sw["frames"] = frames_b; sw["total"] = len(frames); sw["detected"] = detected
    sw["flags"] = flags; sw["interpolated"] = sum(1 for fl in flags if fl == "interp")
    sw["viewpoint"] = _viewpoint(raws); sw["confidence"] = round(conf, 3)
    # The rate the frames were actually sampled at — see _sample_frames. The swatch default
    # is 15, which is right only for a ~30fps source.
    sw["fps"] = eff_fps
    # Gait scored on the gap-filled frames, i.e. the ones a rig would actually play.
    # fps matters here: the gait band is in Hz, so scoring a 12fps clip as if it were 15
    # would look for the cycle in the wrong bins.
    sw["gait"] = _gait_coherence(frames_b, eff_fps)
    # The subject's TRANSLATION, alongside the joint angles rather than baked into them.
    # A consumer that ignores this key animates exactly as it did before, so every swatch
    # already on disk stays valid; one that reads it gets the sway and the bob back.
    # Gap-filled the same way the frames are, so a dropped detection does not leave a hole
    # the renderer has to guess across — carried forward from the last seen root, since a
    # missing frame means the detector lost the subject, not that the subject teleported.
    root = norm.get("root") or [None] * len(frames)
    last = [0.0, 0.0]
    filled_root = []
    for r in root:
        if r is not None:
            last = r
        filled_root.append(list(last))
    sw["root"] = filled_root
    # What the root actually carries, so a caller can decide whether it is worth driving
    # anything with instead of measuring the track itself. In torso-scale units, i.e. 0.5
    # means the hips travelled half a torso length.
    if any(r is not None for r in root):
        rx = [r[0] for r in filled_root]
        ry = [r[1] for r in filled_root]
        sw["root_travel"] = {"x": round(max(rx) - min(rx), 4),
                             "y": round(max(ry) - min(ry), 4)}
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
