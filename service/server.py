"""Motion Swatch analysis service — thin FastAPI layer.

Wiring only: decode (video_io) -> flow (flow/extractors) -> distill -> segment,
exposed via /analyze /health /engines /route. Heavy logic lives in the modules.

Run:  venv/bin/uvicorn server:app --host 127.0.0.1 --port 8765
"""
import sys
import tempfile
from pathlib import Path

from fastapi import FastAPI, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware


def _log(msg):
    print(msg, file=sys.stderr, flush=True)   # flush so it shows live in the service log


from config import DEVICE
from video_io import read_frames, _crop_frames
from flow import ENGINE, raft_flow_series
from distill import distill, grid_trajectories
from segment import segment_regions
import extractors                # pluggable extractor registry (Step 4)
_log("[engines] registered: " + ", ".join(f"{n}:{e.kind}" for n, e in extractors.REGISTRY.items()))

app = FastAPI(title="motion-swatch-service")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],       # localhost demo service
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------- routes
@app.get("/health")
def health():
    return {"ok": True, "engine": f"{ENGINE} (torchvision pretrained)", "device": DEVICE}


@app.get("/engines")
def engines():
    """Which extractor backends are installed on this machine, and why gated ones aren't."""
    return {"engines": extractors.available_engines(), "device": DEVICE}


@app.get("/route")
def route(cls: str, subject_type: str = None, count: str = None, has_text_prompt: bool = False):
    """Best AVAILABLE extractor for a motion class + sub-attributes (resolve_best).
    The app calls this after the VLM classifies a clip, then invokes /analyze?engine=/tracker=
    (FLOW/TRAJECTORY) accordingly. Single source of truth for routing + live availability."""
    e, reason = extractors.resolve_best(
        cls, {"subject_type": subject_type, "count": count, "has_text_prompt": has_text_prompt})
    ok = False
    if e:
        try:
            ok = bool(e.probe()[0])
        except Exception:
            ok = False
    _log(f"[route] {cls}/{subject_type}/{count} -> {e.name if e else None} "
         f"({e.kind if e else '-'}, avail={ok}) · {reason}")
    return {"engine": e.name if e else None, "kind": e.kind if e else None,
            "available": ok, "reason": reason}


@app.post("/analyze")
async def analyze(file: UploadFile = File(...),
                  engine: str = None, tracker: str = None, preproc: str = None, bbox: str = None):
    # Optional query params select pluggable backends (Step 4). With NO params the
    # response is byte-identical to the pre-Step-4 default (raft_small + RAFT grid).
    suffix = Path(file.filename or "clip.mp4").suffix or ".mp4"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=True) as tmp:
        tmp.write(await file.read())
        tmp.flush()
        frames, fps = read_frames(tmp.name)

    if frames is None or len(frames) < 13:
        return {"ok": False, "error": "could not decode enough frames (need ≥ 13)"}

    notes = []

    # crop to one detected motion's region (multi-motion extraction) — default: full frame
    if bbox:
        cropped = _crop_frames(frames, bbox)
        if cropped is None or len(cropped) < 13:
            notes.append(f"bbox {bbox} too small; used full frame")
        else:
            frames = cropped

    # (0) optional preproc (e.g. EVM motion magnification) — default: frames unchanged.
    # A failed magnification surfaces a note (never a silent no-op) per the honesty rule.
    if preproc:
        pe, pwhy = extractors.resolve(preproc, extractors.PREPROC)
        if pwhy:
            notes.append(pwhy)
        if pe:
            try:
                frames = pe.load()(frames, fps)
            except Exception as ex:
                notes.append(f"{preproc} preproc failed, used raw frames: {ex}")

    # (1) FLOW engine — default (no param, or resolves to raft_small) uses the server's
    #     own raft_flow_series so the default path stays byte-identical.
    fe, fwhy = extractors.resolve(engine, extractors.FLOW)
    if fwhy:
        notes.append(fwhy)
    if engine and fe and fe.name != "raft_small":
        try:
            flows = fe.load()(frames)
            used_engine = fe.name
        except Exception as ex:                       # any load/weights failure -> graceful fallback
            flows = raft_flow_series(frames)
            used_engine = ENGINE
            notes.append(f"{fe.name} failed, used {ENGINE}: {ex}")
    else:
        flows = raft_flow_series(frames)
        used_engine = ENGINE

    params = distill(flows, fps)
    if params is None:
        return {"ok": False, "error": "not enough motion data"}

    # (2) TRAJECTORY engine — default uses the RAFT-integrated grid
    if tracker:
        te, twhy = extractors.resolve(tracker, extractors.TRAJECTORY)
        if twhy:
            notes.append(twhy)
        if te and te.kind == extractors.TRAJECTORY and not twhy:
            try:
                trajectories = te.load()(frames)
                used_tracker = te.name
            except Exception as ex:                   # graceful fallback to the RAFT grid
                trajectories = grid_trajectories(flows)
                used_tracker = "raft-grid"
                notes.append(f"{te.name} failed, used raft-grid: {ex}")
        else:
            trajectories = grid_trajectories(flows)
            used_tracker = "raft-grid"
    else:
        trajectories = grid_trajectories(flows)
        used_tracker = "raft-grid"

    regions = segment_regions(flows, fps, filename=file.filename or "")

    resp = {
        "ok": True,
        "engine": f"{used_engine}@{DEVICE}",
        "fps": round(fps, 2),
        "frames_analyzed": int(len(frames)),
        "params": params,
        "trajectories": trajectories,
        "regions": regions,
    }
    # additive fields ONLY when a param was used — keeps the no-query response byte-identical
    if engine or tracker or preproc or bbox:
        resp["tracker"] = used_tracker
        if notes:
            resp["notes"] = notes
    _log(f"[analyze] FLOW={used_engine} TRAJ={used_tracker} preproc={preproc or '-'} "
         f"bbox={bbox or '-'} frames={len(frames)} regions={len(regions)}"
         + (f" | NOTES: {'; '.join(notes)}" if notes else ""))
    return resp
