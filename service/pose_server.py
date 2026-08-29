"""Tiny pose-extraction HTTP endpoint (stdlib only, no framework).

POST /extract              raw video bytes in the body
  ?kind=pose  (default)  -> MediaPipe Pose (BlazePose). Default response is BYTE-FROZEN
                            for the app: { joints, fps:15, engine, detected, total,
                            frames:[[ [x,y,c] x13 ] | null ] }.
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
import json, tempfile, os, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs
from collections import Counter
import cv2
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
    return {"joints":NAMES,"fps":15,"engine":"mediapipe_blazepose",
            "detected":len(good),"total":len(seq),"frames":seq}


# ── shared helpers (used by the kind=pose&fmt=b / hands / face extractors) ────
def _sample_frames(path):
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
    return raw


def _bbox_norm_xyz(lms):
    """Normalize x,y to the landmark set's own bbox (like extract does for pose),
    keeping z. Hands/face have no visibility, so the 3rd value is z (relative depth)."""
    xs = [p.x for p in lms]; ys = [p.y for p in lms]
    x0, y0 = min(xs), min(ys)
    bw = max(1e-6, max(xs) - x0); bh = max(1e-6, max(ys) - y0)
    return [[round((p.x - x0) / bw, 4), round((p.y - y0) / bh, 4), round(float(p.z), 4)] for p in lms]


def _pose_norm(lm):
    """Return (bbox-normalized [[x,y,vis]x13] matching extract(), raw {name:(x,y,vis)})."""
    pts = {n: (lm[i].x, lm[i].y, lm[i].visibility) for n, i in IDX.items()}
    xs = [p[0] for p in pts.values()]; ys = [p[1] for p in pts.values()]
    x0, y0 = min(xs), min(ys); bw = max(1e-3, max(xs) - x0); bh = max(1e-3, max(ys) - y0)
    frame = [[round((pts[n][0] - x0) / bw, 4), round((pts[n][1] - y0) / bh, 4),
              round(float(pts[n][2]), 3)] for n in NAMES]
    return frame, pts


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


def _reshape3(filled):
    """flat vector -> [[x,y,z]x(len/3)] (or None)."""
    return [None if f is None else [[round(f[k], 4), round(f[k + 1], 4), round(f[k + 2], 4)]
                                    for k in range(0, len(f), 3)] for f in filled]


def extract_pose_b(path):
    """Pose as a Contract-B skeleton swatch: viewpoint + gap-filled frames + confidence."""
    frames, raws = [], []
    with MP.Pose(model_complexity=1, min_detection_confidence=0.5,
                 min_tracking_confidence=0.5) as pose:
        for fr in _sample_frames(path):
            res = pose.process(cv2.cvtColor(fr, cv2.COLOR_BGR2RGB))
            if not res.pose_landmarks:
                frames.append(None); raws.append(None); continue
            fnorm, pts = _pose_norm(res.pose_landmarks.landmark)
            frames.append(fnorm); raws.append(pts)
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
    return contracts.normalize_skeleton_swatch(sw)[0]


def extract_hands(path):
    seq = []
    with MP_HANDS.Hands(static_image_mode=False, max_num_hands=2, model_complexity=1,
                        min_detection_confidence=0.5, min_tracking_confidence=0.5) as hands:
        for fr in _sample_frames(path):
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
    sw["flags"] = ['ok' if s else 'gap' for s in seq]   # hands are not gap-interpolated
    sw["confidence"] = round(sum(scores) / len(scores), 3) if scores else 0.0
    return contracts.normalize_skeleton_swatch(sw)[0]


def extract_face(path):
    seq = []
    with MP_FACE.FaceMesh(static_image_mode=False, max_num_faces=1, refine_landmarks=False,
                          min_detection_confidence=0.5, min_tracking_confidence=0.5) as face:
        for fr in _sample_frames(path):
            res = face.process(cv2.cvtColor(fr, cv2.COLOR_BGR2RGB))
            seq.append(_bbox_norm_xyz(res.multi_face_landmarks[0].landmark)
                       if res.multi_face_landmarks else None)
    detected = sum(1 for s in seq if s)
    flat = [None if s is None else [v for p in s for v in p] for s in seq]
    filled, flags = fill_gaps(flat)
    sw = contracts.empty_skeleton_swatch("face", "mediapipe_facemesh")
    sw["frames"] = _reshape3(filled); sw["total"] = len(seq); sw["detected"] = detected
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
                out = contracts.skeleton_swatch(out, cls="articulated",
                                                engine=out.get("engine", ""))
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
