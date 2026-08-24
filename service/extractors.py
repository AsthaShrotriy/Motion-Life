"""Pluggable motion-extractor registry (Step 4 of docs/BUILD_PLAN.md).

One dispatch table so each motion class can route to the best available model — and
adding a model = adding one Engine, without touching the server or the swatch schema.

Three capability slots (an Engine provides exactly one):
  FLOW        frames[T,H,W,3] in [0,1]  -> ndarray[T-1, 2, H, W]  px/frame   (RAFT-style dense flow)
  TRAJECTORY  frames[T,H,W,3] in [0,1]  -> list[144] of [x,y], ONE point per input frame,
              gy-major/gx-inner (matches grid_trajectories); coords are ÷W,H so they MAY
              fall outside 0..1 when a tracked point leaves the frame.
  PREPROC     (frames, fps)             -> frames  same shape/[0,1]          (e.g. motion magnify)

RULES that keep the server backward-compatible:
  * probe() is DEPENDENCY-FREE (importlib.find_spec + os.path only) — no heavy imports,
    so a missing/broken backend can never break server import or startup.
  * heavy imports + model loads happen ONLY inside factory(), lazily, cached on first use.
  * resolve(name, kind) falls back to the kind's `default` engine when a requested engine is
    unknown/unavailable. FLOW and PREPROC have defaults (raft_small, evm); TRAJECTORY has NO
    default, so resolve returns (None, reason) — the caller (server /analyze) must handle None
    (it does: it falls back to the RAFT-integrated grid).
"""
import os
import importlib.util
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

FLOW, TRAJECTORY, PREPROC = "flow", "trajectory", "preproc"
# Step 5+ kinds: skeletal bodies, single-object travel paths, and Step-2 helpers.
SKELETON, OBJECT_PATH = "skeleton", "object_path"
SEGMENT, DEPTH, CAMERA, TEXT2MOTION = "segment", "depth", "camera", "text2motion"
GRID = 12


def _has(mod: str) -> bool:
    try:
        return importlib.util.find_spec(mod) is not None
    except (ImportError, ValueError):
        return False


@dataclass
class Engine:
    name: str
    kind: str                                  # FLOW | TRAJECTORY | PREPROC
    describe: str
    probe: Callable[[], tuple]                 # () -> (available: bool, reason: str)  — cheap
    factory: Callable[[], Any]                 # () -> impl callable                   — lazy, heavy
    default: bool = False
    _impl: Any = field(default=None, repr=False)

    def load(self):
        if self._impl is None:
            self._impl = self.factory()
        return self._impl


REGISTRY = {}


def register(e: Engine):
    REGISTRY[e.name] = e


def available_engines() -> list:
    """Cheap capability report (calls probe() only) — powers GET /engines."""
    out = []
    for e in REGISTRY.values():
        try:
            ok, why = e.probe()
        except Exception as ex:               # a broken probe must never crash the report
            ok, why = False, f"probe error: {ex}"
        out.append({"name": e.name, "kind": e.kind, "available": bool(ok),
                    "reason": why, "default": e.default, "describe": e.describe})
    return out


def resolve(name: Optional[str], kind: str):
    """(engine, fallback_reason). Unknown/unavailable -> the kind's default engine."""
    default = next((e for e in REGISTRY.values() if e.kind == kind and e.default), None)
    if not name:
        return default, None
    e = REGISTRY.get(name)
    if e is None or e.kind != kind:
        return default, f"{name!r} is not a registered {kind} engine"
    try:
        ok, why = e.probe()
    except Exception as ex:
        ok, why = False, str(ex)
    return (e, None) if ok else (default, f"{name} unavailable ({why})")


# ── FLOW: torchvision RAFT (core, cached, no downloads) ─────────────────────
def _torchvision_flow(which):
    def build():
        import numpy as np, torch
        from torchvision.models.optical_flow import (
            raft_small, raft_large, Raft_Small_Weights, Raft_Large_Weights)
        dev = "mps" if torch.backends.mps.is_available() else "cpu"
        model = (raft_large(weights=Raft_Large_Weights.DEFAULT) if which == "raft_large"
                 else raft_small(weights=Raft_Small_Weights.DEFAULT)).eval().to(dev)

        def flow_fn(frames):
            t = torch.from_numpy(frames).permute(0, 3, 1, 2) * 2 - 1   # [-1,1] (torchvision)
            flows = []
            with torch.no_grad():
                for a, b in zip(t[:-1], t[1:]):
                    fl = model(a.unsqueeze(0).to(dev), b.unsqueeze(0).to(dev))[-1]
                    flows.append(fl[0].cpu().numpy())
            return np.stack(flows)
        return flow_fn
    return build


register(Engine("raft_small", FLOW, "torchvision RAFT-small (default, 12/12 on benchmark)",
                probe=lambda: (True, "torchvision cached") if _has("torchvision") else (False, "torchvision missing"),
                factory=_torchvision_flow("raft_small"), default=True))
register(Engine("raft_large", FLOW, "torchvision RAFT-large (sharper; scored 11/12 — not better end-to-end)",
                probe=lambda: (True, "torchvision cached") if _has("torchvision") else (False, "torchvision missing"),
                factory=_torchvision_flow("raft_large")))


# ── FLOW: SEA-RAFT (gated — vendored clone + weights) ───────────────────────
SEARAFT_REPO = os.environ.get("SEARAFT_REPO", os.path.join(os.path.dirname(__file__), "SEA-RAFT"))


def _searaft_probe():
    if not os.path.isdir(os.path.join(SEARAFT_REPO, "core")):
        return (False, "clone princeton-vl/SEA-RAFT into service/SEA-RAFT (or set SEARAFT_REPO)")
    for dep in ("einops", "scipy"):
        if not _has(dep):
            return (False, f"pip install {dep}")
    if not (_has("safetensors") or _has("huggingface_hub")):
        return (False, "pip install huggingface_hub safetensors (or provide a local .pth)")
    return (True, "vendored")


def _searaft_build():
    import sys, json, argparse, numpy as np, torch
    sys.path.append(os.path.join(SEARAFT_REPO, "core"))
    from raft import RAFT                                    # noqa: E402
    dev = "mps" if torch.backends.mps.is_available() else "cpu"
    # config MUST match the checkpoint architecture — README pairs spring-M.json with the
    # Tartan-C-T-TSKH-spring540x960-M weights (a mismatch silently loads wrong weights/errors).
    cfg_path = os.environ.get("SEARAFT_CFG", os.path.join(SEARAFT_REPO, "config/eval/spring-M.json"))
    args = argparse.Namespace(**json.load(open(cfg_path)))
    args.scale = 0                                           # disable test-time rescale (generic drop-in)
    hf = os.environ.get("SEARAFT_HF", "MemorySlices/Tartan-C-T-TSKH-spring540x960-M")
    model = RAFT.from_pretrained(hf, args=args).to(dev).eval()

    def flow_fn(frames):
        t = torch.from_numpy(frames).permute(0, 3, 1, 2) * 255.0   # SEA-RAFT wants 0-255
        flows = []
        with torch.no_grad():
            for a, b in zip(t[:-1], t[1:]):
                out = model(a.unsqueeze(0).to(dev), b.unsqueeze(0).to(dev),
                            iters=args.iters, test_mode=True)
                flows.append(out["flow"][-1][0].cpu().numpy())
        return np.stack(flows)
    return flow_fn


register(Engine("searaft", FLOW, "SEA-RAFT (sharper flow at motion boundaries; heavier)",
                probe=_searaft_probe, factory=_searaft_build))


# ── TRAJECTORY: CoTracker3 (gated on cached weights; verified on this machine) ──
def _cotracker_probe():
    ckpt = os.path.expanduser("~/.cache/torch/hub/checkpoints/scaled_offline.pth")
    hub = os.path.expanduser("~/.cache/torch/hub/facebookresearch_co-tracker_main")
    if os.path.exists(ckpt) and os.path.isdir(hub):
        return (True, "cotracker3 weights + hub repo cached")
    return (False, "cache miss — first run downloads ~97MB via torch.hub (needs network)")


def _cotracker_build():
    import numpy as np, torch
    os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    dev = "mps" if torch.backends.mps.is_available() else "cpu"
    model = torch.hub.load("facebookresearch/co-tracker", "cotracker3_offline").to(dev).eval()

    def traj_fn(frames):
        T, H, W, _ = frames.shape
        vid = torch.from_numpy(frames).permute(0, 3, 1, 2)[None].to(dev) * 255.0  # [1,T,3,H,W] 0-255
        q = [[0.0, (gx + 0.5) / GRID * W, (gy + 0.5) / GRID * H]                  # (t,x,y), gy-major
             for gy in range(GRID) for gx in range(GRID)]
        queries = torch.tensor(q, dtype=torch.float32, device=dev)[None]          # [1,144,3]
        with torch.no_grad():
            tracks, _vis = model(vid, queries=queries)                            # tracks [1,T,144,2] px
        tr = tracks[0].cpu().numpy()
        return [[[round(float(tr[t, n, 0] / W), 4), round(float(tr[t, n, 1] / H), 4)]
                 for t in range(tr.shape[0])] for n in range(GRID * GRID)]
    return traj_fn


register(Engine("cotracker3", TRAJECTORY, "CoTracker3 — long-range point tracks (survives occlusion/large motion)",
                probe=_cotracker_probe, factory=_cotracker_build, default=False))


# ── PREPROC: Eulerian video magnification (pure numpy+cv2, no downloads) ─────
def _evm_build():
    import numpy as np, cv2

    def pre_fn(frames, fps, alpha=None, low=None, high=None):
        # Exceptions propagate to the caller (server /analyze), which surfaces a note
        # and uses raw frames — so a failed magnification is never a silent no-op.
        a = float(os.environ.get("MS_EVM_ALPHA", "12")) if alpha is None else alpha
        lo = float(os.environ.get("MS_EVM_LOW", "0.4")) if low is None else low
        hi = float(os.environ.get("MS_EVM_HIGH", "3.0")) if high is None else high
        T, H, W, _ = frames.shape
        if T < 6:
            return frames                                                          # too short to band-pass
        small = np.stack([cv2.pyrDown(cv2.pyrDown(f)) for f in frames])            # temporal @ 1/4 res
        fft = np.fft.rfft(small, axis=0)
        freqs = np.fft.rfftfreq(T, d=1.0 / max(1e-3, fps))
        fft[~((freqs >= lo) & (freqs <= hi))] = 0
        band = np.fft.irfft(fft, n=T, axis=0) * a                                  # amplified residual
        out = np.empty_like(frames)
        for i in range(T):
            up = band[i]
            for _ in range(2):
                up = cv2.pyrUp(up)
            up = cv2.resize(up, (W, H))
            out[i] = np.clip(frames[i] + up, 0, 1)
        return out.astype(np.float32)
    return pre_fn


register(Engine("evm", PREPROC, "Eulerian magnification — amplify tiny/subtle motion (rain, breathing, slow water)",
                probe=lambda: (True, "numpy+cv2") if _has("cv2") else (False, "opencv missing"),
                factory=_evm_build, default=True))


# ── OBJECT_PATH: YOLO + ByteTrack (RUN-HERE-REAL — closes the rigid_path gap) ──
def _yolo_build():
    import os, numpy as np, torch
    os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
    from ultralytics import YOLO
    dev = "mps" if torch.backends.mps.is_available() else "cpu"
    model = YOLO(os.environ.get("YOLO_WEIGHTS", "yolov8n.pt"))

    def path_fn(frames):
        """frames[T,H,W,3] in [0,1] RGB -> the longest track's centroid path
        [[t, cx, cy, w, h, label] ...] (normalized) for a path_travel applicator."""
        paths = {}
        for t in range(len(frames)):
            bgr = np.ascontiguousarray((frames[t][:, :, ::-1] * 255).astype(np.uint8))  # RGB->BGR uint8
            r = model.track(bgr, tracker="bytetrack.yaml", persist=(t > 0), verbose=False,
                            device=dev, conf=float(os.environ.get("YOLO_CONF", "0.25")))[0]  # t==0 resets tracker
            b = r.boxes
            if b is None or b.id is None:
                continue
            for (cx, cy, w, h), i, c in zip(b.xywhn.cpu().numpy(), b.id.cpu().numpy().astype(int),
                                            b.cls.cpu().numpy().astype(int)):
                paths.setdefault(int(i), []).append(
                    [t, round(float(cx), 4), round(float(cy), 4), round(float(w), 4),
                     round(float(h), 4), model.names[c]])
        if not paths:
            return []
        return max(paths.values(), key=len)          # longest track = the traveling object
    return path_fn


register(Engine("yolo_bytetrack", OBJECT_PATH,
                "YOLO + ByteTrack — detect+track one object into a travel path (boat/car/…)",
                probe=lambda: (True, "ultralytics+torch (yolov8n.pt auto-downloads once)")
                              if (_has("ultralytics") and _has("torch")) else (False, "pip install ultralytics"),
                factory=_yolo_build))


# ── SKELETON: torchvision Keypoint R-CNN (multi-person, RUN-HERE — weights ~226MB on 1st use) ──
def _keypointrcnn_build():
    import numpy as np, torch
    from torchvision.models.detection import (keypointrcnn_resnet50_fpn,
                                              KeypointRCNN_ResNet50_FPN_Weights)
    dev = "mps" if torch.backends.mps.is_available() else "cpu"
    model = keypointrcnn_resnet50_fpn(weights=KeypointRCNN_ResNet50_FPN_Weights.DEFAULT).eval().to(dev)
    NAMES = ["nose", "l_sho", "r_sho", "l_elb", "r_elb", "l_wri", "r_wri",
             "l_hip", "r_hip", "l_knee", "r_knee", "l_ank", "r_ank"]
    COCO = {"nose": 0, "l_sho": 5, "r_sho": 6, "l_elb": 7, "r_elb": 8, "l_wri": 9, "r_wri": 10,
            "l_hip": 11, "r_hip": 12, "l_knee": 13, "r_knee": 14, "l_ank": 15, "r_ank": 16}

    def pose_fn(frames):
        seq = []
        with torch.no_grad():
            for f in frames:
                out = model([torch.from_numpy(f).permute(2, 0, 1).to(dev)])[0]  # f in [0,1]
                if len(out["keypoints"]) == 0:
                    seq.append(None); continue
                kp = out["keypoints"][0].cpu().numpy()          # [17,3] (x,y,vis≈1) px
                sc = 1.0 / (1.0 + np.exp(-out["keypoints_scores"][0].cpu().numpy()))  # real per-joint conf
                H, W = f.shape[:2]
                pts = {n: (kp[i][0] / W, kp[i][1] / H, float(sc[i])) for n, i in COCO.items()}
                xs = [p[0] for p in pts.values()]; ys = [p[1] for p in pts.values()]
                x0, y0 = min(xs), min(ys); bw = max(1e-3, max(xs) - x0); bh = max(1e-3, max(ys) - y0)
                seq.append([[round(float((pts[n][0] - x0) / bw), 4), round(float((pts[n][1] - y0) / bh), 4),
                             round(float(min(1.0, pts[n][2])), 3)] for n in NAMES])  # float() -> JSON-safe
        return {"joints": NAMES, "fps": 15, "engine": "keypointrcnn",
                "detected": sum(1 for s in seq if s), "total": len(seq), "frames": seq}
    return pose_fn


register(Engine("keypointrcnn", SKELETON, "torchvision Keypoint R-CNN — dominant-person 13-joint skeleton",
                probe=lambda: (True, "torchvision (weights ~226MB download on first use if not cached)")
                              if _has("torchvision") else (False, "torchvision missing"),
                factory=_keypointrcnn_build, default=True))


# ── SKELETON: MediaPipe pose/hands/face — lives on the :8770 service (Backend A) ──
def _reachable(url, timeout=0.4):
    try:
        import urllib.request
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return r.status == 200
    except Exception:
        return False


POSE_URL = os.environ.get("POSE_SERVICE_URL", "http://127.0.0.1:8770")
register(Engine("pose_mediapipe", SKELETON,
                "MediaPipe BlazePose/Hands/Face — served by pose_server.py (:8770)",
                probe=lambda: (True, "pose_server :8770 up") if _reachable(POSE_URL + "/")
                              else (False, "start pose_server.py (:8770) for MediaPipe pose/hands/face"),
                factory=lambda: (_ for _ in ()).throw(RuntimeError(
                    "pose_mediapipe runs on the :8770 service (POST /extract), not the :8765 registry"))))


# ── GATED research backends: registered + routed, but probe False until set up ──
def _gate(setup, *_mods, env=None):
    # Stub engines have no real factory yet — registered for routing awareness + setup
    # docs, but must NEVER report available (their _stub factory only raises). Honesty rule.
    return lambda: (False, setup)


def _stub(setup):
    return lambda: (_ for _ in ()).throw(RuntimeError(f"gated engine not set up: {setup}"))


for _n, _k, _desc, _need, _setup in [
    ("wham",         SKELETON,    "WHAM — 3D human + world-space travel",           ("wham",),        "clone yzhu.io/WHAM + weights (CUDA-leaning; heavy)"),
    ("mmpose_animal", SKELETON,   "MMPose/DeepLabCut — animal skeletons",           ("mmpose", "mmcv"), "pip install mmpose mmcv + an animal-pose checkpoint"),
    ("tapir",        TRAJECTORY,  "TAPIR/TAP-Net — point tracking (CoTracker alt)", ("tapnet",),      "clone google-deepmind/tapnet + weights"),
    ("objectron",    OBJECT_PATH, "MediaPipe Objectron — 3D box (shoe/chair/cup/camera only)", ("mediapipe",), "install mediapipe (py<=3.12); only 4 categories"),
    ("mdm",          TEXT2MOTION, "MDM/MotionGPT — text prompt -> skeleton (no video)", ("mdm",),     "clone GuyTevet/motion-diffusion-model + weights"),
    ("droid_slam",   CAMERA,      "DROID-SLAM — camera pose (vs OpenCV homography floor)", ("droid_slam",), "clone princeton-vl/DROID-SLAM (CUDA); floor = ORB affine"),
    ("sam2",         SEGMENT,     "SAM 2 — clean object mask (vs GrabCut floor)",   ("sam2",),        "pip install 'git+…/sam2' + checkpoint; floor = GrabCut+motion"),
    ("depth",        DEPTH,       "Depth Anything V2 — monocular depth",            ("transformers",), "pip install transformers + depth-anything weights"),
]:
    register(Engine(_n, _k, _desc, probe=_gate(_setup, *_need), factory=_stub(_setup)))


# ── Routing table: (class, subject_type, count, has_text_prompt) -> engine preference ──
# resolve_best walks the first matching rule's list L->R and returns the first AVAILABLE
# engine (probe passes), else the class floor. A rule matches when every key in `when`
# equals the given attr. Rules are most-specific-first.
ROUTING_TABLE = {
    "articulated": [
        ({"subject_type": "human", "has_text_prompt": True}, ["mdm", "wham", "pose_mediapipe", "keypointrcnn"]),
        ({"subject_type": "human", "count": "many"},         ["keypointrcnn", "pose_mediapipe"]),
        ({"subject_type": "human"},                          ["wham", "pose_mediapipe", "keypointrcnn"]),
        ({"subject_type": "animal", "has_text_prompt": True},["mdm", "mmpose_animal", "pose_mediapipe", "keypointrcnn"]),
        ({"subject_type": "animal"},                         ["mmpose_animal", "pose_mediapipe", "keypointrcnn"]),
        ({},                                                 ["pose_mediapipe", "keypointrcnn"]),
    ],
    "cloth":  [({}, ["searaft", "raft_large", "raft_small"])],
    "fluid":  [({}, ["searaft", "raft_small"])],
    "flock":  [({"count": "one"}, ["cotracker3", "tapir", "raft_small"]),
               ({}, ["tapir", "cotracker3", "searaft", "raft_small"])],
    "rigid_path": [({}, ["yolo_bytetrack", "objectron", "cotracker3", "tapir", "raft_small"])],
    "oscillation": [({"count": "many"}, ["tapir", "cotracker3", "raft_small"]),
                    ({}, ["cotracker3", "tapir", "raft_small"])],
}
_CLASS_FLOOR = {"articulated": "keypointrcnn", "cloth": "raft_small", "fluid": "raft_small",
                "flock": "raft_small", "rigid_path": "raft_small", "oscillation": "raft_small"}


def resolve_best(motion_class, attrs=None):
    """Pick the best AVAILABLE extractor for a motion class + sub-attributes
    (subject_type/count/has_text_prompt). Returns (engine, reason). Never None —
    falls back down the preference list to the class floor (a guaranteed engine)."""
    attrs = attrs or {}
    prefer = []
    for when, names in ROUTING_TABLE.get(motion_class, []):
        if all(attrs.get(k) == v for k, v in when.items()):
            prefer = names
            break
    tried = []
    for name in prefer:
        e = REGISTRY.get(name)
        if e is None:
            continue
        try:
            ok, why = e.probe()
        except Exception as ex:
            ok, why = False, str(ex)
        if ok:
            skipped = f" (skipped {', '.join(tried)})" if tried else ""
            return e, f"{motion_class}/{attrs} -> {name}{skipped}"
        tried.append(f"{name}: {why}")
    floor = REGISTRY.get(_CLASS_FLOOR.get(motion_class, "raft_small"))
    fnote = ""
    if floor:                                    # probe the floor too — don't claim usable blindly
        try:
            fok, fwhy = floor.probe()
        except Exception as ex:
            fok, fwhy = False, str(ex)
        if not fok:
            fnote = f" (FLOOR ALSO UNAVAILABLE: {fwhy})"
    return floor, (f"{motion_class}/{attrs}: none of [{', '.join(prefer)}] available "
                   f"({'; '.join(tried)}) -> floor {floor.name if floor else None}{fnote}")


# Startup self-check: every routed class must end in a catch-all {} rule and have a
# registered floor — so resolve_best can never fall off the end with no engine.
for _cls, _rules in ROUTING_TABLE.items():
    assert _rules and _rules[-1][0] == {}, f"routing: {_cls} needs a trailing {{}} catch-all rule"
    assert _CLASS_FLOOR.get(_cls) in REGISTRY, f"routing: {_cls} floor not registered"
