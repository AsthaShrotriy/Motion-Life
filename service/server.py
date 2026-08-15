"""Motion Swatch analysis service.

POST /analyze  (multipart file: video)
  → runs torchvision's pretrained RAFT optical-flow model over the clip
    and distills the dense flow into the app's motion parameters
    (frequency, amplitude, direction, turbulence, damping, phaseSpread,
    swingPx, driftX, driftY), plus a coarse grid of point trajectories and
    per-motion region segmentation.

GET /health → {"ok": true, "engine": "raft_small", "device": "mps"}

Run:  venv/bin/uvicorn server:app --host 127.0.0.1 --port 8765
"""
import math
import tempfile
from pathlib import Path

import os

import cv2
import numpy as np
import torch
import torch.nn.functional as F
from fastapi import FastAPI, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from torchvision.models.optical_flow import (
    Raft_Large_Weights, Raft_Small_Weights, raft_large, raft_small,
)

# ---------------------------------------------------------------- model init
DEVICE = "mps" if torch.backends.mps.is_available() else "cpu"
# Default chosen by service/benchmark.py ground-truth suite: raft_small @
# 480px/20fps/8s scores 12/12 checks in ~12s; raft_large scores 11/12 (its
# stronger smoothness prior blurs traveling-wave phase, hurting phaseSpread)
# at 4x the compute. Bigger is not better end-to-end here.
ENGINE = os.environ.get("MS_ENGINE", "raft_small")   # raft_small | raft_large
if ENGINE == "raft_large":
    MODEL = raft_large(weights=Raft_Large_Weights.DEFAULT).eval().to(DEVICE)
else:
    ENGINE = "raft_small"
    MODEL = raft_small(weights=Raft_Small_Weights.DEFAULT).eval().to(DEVICE)

# Analysis config — values chosen by service/benchmark.py ground-truth runs.
ANALYSIS_WIDTH = int(os.environ.get("MS_WIDTH", "480"))   # downscale width
# 480px is the stable default: single-motion clips extract as one clean region
# (the scenery demo applies one captured motion per object). 720px resolves
# more sub-motions on complex clips (an aerial intersection → 6 regions) but
# over-splits simple clips; set MS_WIDTH=720 only when you specifically want
# aggressive multi-region extraction from one busy clip.
MAX_SECONDS = float(os.environ.get("MS_SECONDS", "8"))    # max clip length analyzed
TARGET_FPS = float(os.environ.get("MS_FPS", "20"))        # flow-pair sample rate
GRID = 12                     # trajectories returned on a GRID x GRID grid

app = FastAPI(title="motion-swatch-service")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],       # localhost demo service
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------- video io
def read_frames(path: str, width: int = None):
    """Return (frames float32 [T,H,W,3] in [0,1], effective_fps).

    width overrides ANALYSIS_WIDTH for this call (used by the adaptive hi-res
    retry) without mutating the module default.
    """
    nw = int(width) if width is not None else ANALYSIS_WIDTH
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
            nh = int(round(h * nw / w / 8) * 8) or 8
            frame = cv2.resize(frame, (nw, nh), interpolation=cv2.INTER_AREA)
            frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            frames.append(frame.astype(np.float32) / 255.0)
        i += 1
    cap.release()
    return np.stack(frames) if frames else None, eff_fps


BATCH = int(os.environ.get("MS_BATCH", "8"))   # frame-pairs per RAFT forward pass
# Forward-backward consistency: RAFT gives no confidence, so flow at occluded /
# disoccluded pixels (object edges, things passing behind others) is garbage
# that injects spurious motion into the distill statistics. We run flow both
# ways and, where fwd + warp(bwd) disagrees, replace that vector with the
# per-frame median (a robust "background" value). Doubles RAFT compute —
# affordable now that pairs are batched.
#
# DEFAULT OFF, and here is the honest reason: the median FILL is destructive to
# phase — it substitutes a single coherent vector where the truth is "unknown".
# On clean footage that has no real occlusion (e.g. the synthetic benchmark
# clips: rigid blocks, traveling waves on plain backgrounds) it therefore only
# erodes signal — a traveling wave's per-pixel phase diversity collapses,
# tanking phaseSpread — for no benefit, since there is nothing to fix. Its
# payoff is on REAL occlusion-heavy footage (a flag folding over itself, birds
# crossing) which the benchmark does not contain and we have no fixture to tune
# against. So it ships as an opt-in (MS_FB=1) with a conservative threshold
# that only trips on egregious disagreement. The correct default-on design is
# to EXCLUDE occluded pixels from the stats (a mask threaded through distill)
# rather than fill them — deferred as a larger change.
FB_CHECK = os.environ.get("MS_FB", "0") == "1"
FB_ALPHA = 0.01      # relative tolerance (Sundaram et al. occlusion test)
FB_BETA = float(os.environ.get("MS_FB_BETA", "6.0"))   # absolute floor (px²)


def _fb_clean(fwd: torch.Tensor, bwd: torch.Tensor, base: torch.Tensor,
              H: int, W: int) -> torch.Tensor:
    """Null occluded vectors in fwd [B,2,H,W] using backward-flow consistency.

    A pixel p in frame a maps to p + fwd(p) in frame b; the backward flow there
    should be ≈ −fwd(p). Where |fwd + warp(bwd)|² exceeds the standard
    occlusion threshold, replace fwd(p) with the per-image median flow.
    """
    B = fwd.shape[0]
    tgt = base.unsqueeze(0) + fwd                       # [B,2,H,W] coords in b
    gx = 2.0 * tgt[:, 0] / max(W - 1, 1) - 1.0
    gy = 2.0 * tgt[:, 1] / max(H - 1, 1) - 1.0
    grid = torch.stack([gx, gy], dim=-1)                # [B,H,W,2]
    bwd_at = F.grid_sample(bwd, grid, align_corners=True,
                           padding_mode="border")       # [B,2,H,W]
    e2 = ((fwd + bwd_at) ** 2).sum(1)                    # [B,H,W]
    lim = FB_ALPHA * ((fwd ** 2).sum(1) + (bwd_at ** 2).sum(1)) + FB_BETA
    occluded = (e2 > lim).unsqueeze(1)                   # [B,1,H,W]
    med = fwd.reshape(B, 2, -1).median(dim=2).values.reshape(B, 2, 1, 1)
    return torch.where(occluded, med, fwd)


def raft_flow_series(frames: np.ndarray) -> np.ndarray:
    """Dense flow for each consecutive pair. Returns [T-1, 2, H, W] (px/frame).

    Pairs are pushed through RAFT in batches of MS_BATCH rather than one at a
    time — same result, materially faster on MPS/CUDA (one kernel launch per
    batch instead of per pair). When MS_FB is on, occluded vectors are cleaned
    via forward-backward consistency (see _fb_clean).
    """
    t = torch.from_numpy(frames).permute(0, 3, 1, 2) * 2 - 1  # [T,3,H,W] in [-1,1]
    a_all, b_all = t[:-1], t[1:]
    _, _, H, W = a_all.shape
    base = None
    if FB_CHECK:
        yy, xx = torch.meshgrid(
            torch.arange(H, dtype=torch.float32),
            torch.arange(W, dtype=torch.float32), indexing="ij")
        base = torch.stack([xx, yy], dim=0).to(DEVICE)        # [2,H,W] pixel coords
    out = []
    with torch.no_grad():
        for i in range(0, len(a_all), BATCH):
            a = a_all[i:i + BATCH].to(DEVICE)
            b = b_all[i:i + BATCH].to(DEVICE)
            fwd = MODEL(a, b)[-1]                              # [B,2,H,W]
            if FB_CHECK:
                bwd = MODEL(b, a)[-1]                          # [B,2,H,W]
                fwd = _fb_clean(fwd, bwd, base, H, W)
            out.append(fwd.cpu().numpy())
    return np.concatenate(out, axis=0)


# ---------------------------------------------------------------- distill
def _clamp01(v):
    return float(max(0.0, min(1.0, v)))


def distill(flows: np.ndarray, fps: float, noise_floor: float = 0.55,
            mask: np.ndarray = None) -> dict:
    """Dense-flow port of the browser's distillSwatch (see js/distill.js).

    flows: [T, 2, H, W] px/frame.
    noise_floor: px/frame below which residual flow is treated as RAFT noise.
        Default 0.55 is calibrated on benchmark.py's static clip for whole-frame
        analysis. segment_regions() passes a lower value for atmospheric motion
        (rain, smoke, mist) whose real residual flow is ~0.08 px/frame — well
        below the default floor — so it would otherwise register amplitude 0.
    mask: optional boolean [H, W]. When given, ALL whole-frame statistics
        (drift mean, moving fraction, magnitude persistence, spatial disorder)
        are computed over the masked pixels only. segment_regions() passes a
        region's true (non-rectangular) pixel mask here — WITHOUT this, a
        sparse/diagonal region's zeroed bbox pixels read as static texture,
        inflating persistence and crushing the region's amplitude to ~0 purely
        as a function of its shape. Default None = whole frame (byte-identical
        to the pre-mask behaviour for every existing caller).
    """
    T, _, H, W = flows.shape
    if T < 12:
        return None

    # pixel selector: mask flattens [H,W]→[Npix] over real pixels only; when no
    # mask is given, all pixels participate (identical to the original code).
    if mask is not None:
        sel = mask.reshape(-1).astype(bool)
        if int(sel.sum()) < 4:
            return None
    else:
        sel = None

    def _region(px):
        """[..., H, W] → [..., Npix] over the mask (or flattened whole frame)."""
        flat = px.reshape(px.shape[:-2] + (H * W,))
        return flat[..., sel] if sel is not None else flat

    # global per-frame mean flow; keep the DC component as DRIFT (constant
    # travel: falling leaves, flowing water) before removing it so the
    # oscillation analysis below sees only the periodic part
    g_raw = _region(flows).mean(axis=2)      # [T, 2] mean over region pixels
    drift_px = g_raw.mean(axis=0)            # mean flow = steady drift
    # normalize: 0.5% of frame width per frame is a fast drift → ±1
    drift_x = float(np.clip(drift_px[0] / (0.005 * W), -1, 1))
    drift_y = float(np.clip(drift_px[1] / (0.005 * W), -1, 1))
    g = g_raw - g_raw.mean(axis=0, keepdims=True)
    gvx, gvy = g[:, 0], g[:, 1]

    # dominant axis via covariance eigenvector
    cov = np.cov(np.stack([gvx, gvy]))
    evals, evecs = np.linalg.eigh(cov)
    ax, ay = evecs[:, int(np.argmax(evals))]
    direction = math.degrees(math.atan2(-ay, ax)) % 180.0

    proj = gvx * ax + gvy * ay   # global-mean projection (kept for sign/fallback)

    # --- dominant oscillation signal via SVD (replaces the spatial mean) ---
    # The spatial mean cancels anti-phase motion and buries the dominant
    # oscillation in incoherent noise, giving a soft, leaky spectral peak. The
    # leading temporal singular vector of the per-pixel drift-removed flow is a
    # far cleaner 1-D signal. Computed via the small T×T Gram matrix (cheap)
    # over a capped pixel subsample rather than a full [T, 2·Npix] SVD.
    resid = flows - drift_px.reshape(1, 2, 1, 1)   # remove steady drift
    _vx, _vy = _region(resid[:, 0]), _region(resid[:, 1])      # [T, Npix]
    _X = np.concatenate([_vx, _vy], axis=1).astype(np.float64)  # [T, 2·Npix]
    _X -= _X.mean(axis=0, keepdims=True)                        # per-pixel DC out
    if _X.shape[1] > 4096:                                      # cap Gram cost
        _cols = np.linspace(0, _X.shape[1] - 1, 4096).astype(int)
        _X = _X[:, _cols]
    _G = _X @ _X.T                                              # [T, T]
    if float(np.trace(_G)) > 1e-12:
        s = np.linalg.eigh(_G)[1][:, -1]                       # dominant temporal mode
        if float(np.dot(s, proj)) < 0:                         # fix SVD sign ambiguity
            s = -s
    else:
        s = proj.copy()

    # dominant frequency via Hann-windowed rFFT with parabolic refinement.
    # The window suppresses spectral leakage that otherwise widened the peak
    # and biased both frequency and (below) the per-pixel phase estimate.
    win = np.hanning(T)
    spec = np.abs(np.fft.rfft((s - s.mean()) * win))
    spec[0] = 0.0
    k = int(np.argmax(spec))
    freq = k * fps / T
    if 1 <= k < len(spec) - 1:
        la, lb, lc = (math.log(spec[k - 1] + 1e-12),
                      math.log(spec[k] + 1e-12),
                      math.log(spec[k + 1] + 1e-12))
        denom = la - 2 * lb + lc
        if abs(denom) > 1e-12:
            d = 0.5 * (la - lc) / denom
            if abs(d) < 1:
                freq = (k + d) * fps / T
    freq = float(min(8.0, max(0.05, freq)))

    # amplitude of the OSCILLATING part = how strongly the MOVING pixels move.
    # Whole-frame averaging dilutes sparse movers (a flag on sky, scattered
    # leaves); global-mean flow additionally cancels incoherent motion. So:
    # mean magnitude over pixels above RAFT's static-scene noise floor
    # (~0.2-0.4 px/frame, calibrated on benchmark.py's static clip), scaled
    # by a soft coverage factor so pure-noise frames stay near zero.
    NOISE_FLOOR = noise_floor
    mag_map = np.sqrt(resid[:, 0] ** 2 + resid[:, 1] ** 2)   # [T, H, W] (resid from above)
    mag_reg = _region(mag_map)                               # [T, Npix] (region only)
    moving = mag_reg > NOISE_FLOOR
    frac = float(moving.mean())
    # RAFT hallucinates 0.3-0.9 px/frame even on static scenes, but that
    # noise is ANCHORED to texture edges: the spatial magnitude pattern is
    # ~identical frame to frame (Pearson corr ≈ 1.0), while real motion
    # travels through space (measured ≤ 0.7 on every moving benchmark clip
    # and both real videos). Gate amplitude by 1 - persistence. Computed over
    # region pixels only — otherwise the zeroed non-region pixels of a sparse
    # crop read as static texture and falsely inflate persistence.
    a = mag_reg[:-1]
    b = mag_reg[1:]
    am = a - a.mean(axis=1, keepdims=True)
    bm = b - b.mean(axis=1, keepdims=True)
    corr = (am * bm).sum(axis=1) / (np.sqrt((am**2).sum(axis=1) * (bm**2).sum(axis=1)) + 1e-9)
    persistence = float(corr.mean())
    static_gate = _clamp01((0.92 - persistence) / 0.12)   # 1 below 0.80, 0 above 0.92
    if frac > 0.003:
        strength = float((mag_reg[moving] - NOISE_FLOOR).mean())
        coverage = min(1.0, frac / 0.03)          # full weight at ≥3% of pixels
        amplitude = _clamp01(strength / (0.006 * W) * coverage * static_gate)
        # physical peak displacement (source px) of the dominant oscillation:
        # velocity amplitude ÷ angular frequency (ω = 2π·freq/fps in px/frame).
        # Distinguishes a slow-large sway from a fast-small flutter, which the
        # velocity-based `amplitude` above conflates. Informational: renderers
        # keep using `amplitude`; this is a truer intensity cue when needed.
        swing_px = float(strength) * fps / (2 * math.pi * max(freq, 1e-6))
    else:
        amplitude = 0.0
        swing_px = 0.0

    # turbulence: spectral flatness x spatial disorder
    p = spec[1:] ** 2 + 1e-12
    flatness = float(np.exp(np.log(p).mean()) / p.mean())
    mag = np.sqrt(flows[:, 0] ** 2 + flows[:, 1] ** 2) + 1e-9   # [T, H, W]
    ux, uy = flows[:, 0] / mag, flows[:, 1] / mag
    # region-only weighted resultant (spatial disorder of flow directions)
    mag_r = _region(mag)                    # [T, Npix]
    ux_r, uy_r = _region(ux), _region(uy)
    npix = mag_r.shape[1]
    wsum = mag_r.sum(axis=1)
    rx = (ux_r * mag_r).sum(axis=1) / wsum
    ry = (uy_r * mag_r).sum(axis=1) / wsum
    moving = wsum / npix > 0.02             # frames with real motion
    disorder = float((1 - np.sqrt(rx**2 + ry**2))[moving].mean()) if moving.any() else 0.0
    # 1.4x stretch: RAFT (esp. raft_large) produces spatially smooth flow, which
    # compresses the disorder statistic; calibrated on benchmark.py clips
    turbulence = _clamp01((0.5 * flatness + 0.5 * disorder) * 1.4)

    # damping: decay of the oscillation ENVELOPE over the clip. A single-lag
    # autocorrelation (the old estimate) is noisy; instead fit an exponential
    # to the Hilbert analytic-signal envelope of the dominant mode `s`. A flat
    # envelope → 0 (steady oscillation), a decaying one → →1. Falls back to the
    # one-lag autocorrelation if the envelope fit is degenerate.
    def _envelope_damping(sig):
        n = len(sig)
        S = np.fft.fft(sig - sig.mean())
        hfilt = np.zeros(n)                       # analytic-signal Hilbert filter
        hfilt[0] = 1.0
        if n % 2 == 0:
            hfilt[n // 2] = 1.0
            hfilt[1:n // 2] = 2.0
        else:
            hfilt[1:(n + 1) // 2] = 2.0
        env = np.abs(np.fft.ifft(S * hfilt))
        m = max(2, n // 10)                       # trim edge ringing
        env = env[m:n - m]
        good = env > 1e-9
        if len(env) < 4 or good.sum() < 4:
            return None
        t = np.arange(len(env))[good]
        slope = float(np.polyfit(t, np.log(env[good]), 1)[0])   # log-decay / frame
        period = fps / max(freq, 1e-6)
        return _clamp01(1.0 - math.exp(min(0.0, slope) * period))

    damping = _envelope_damping(s)
    if damping is None:
        lag = max(2, min(T - 4, round(fps / freq)))
        den = float((s**2).sum())
        r = abs(float((s[:-lag] * s[lag:]).sum()) / den) if den > 1e-9 else 0.5
        damping = _clamp01(1 - r)

    # phase spread: energy-weighted circular variance of PER-PIXEL phase at
    # the dominant bin. Cell-averaging blends opposite-phase pixels within a
    # cell (cancellation) and RAFT's smoothness prior bleeds flow into the
    # background, so we go per-pixel: single-bin DFT via dot product with
    # exp(-2πikt/T), weight each pixel by its spectral energy at that bin.
    pix_proj = flows[:, 0] * ax + flows[:, 1] * ay           # [T, H, W]
    kk = max(k, 1)
    # Hann-windowed single-bin DFT — same leakage suppression as the frequency
    # estimate, so a traveling wave's opposite-phase pixels don't bleed into
    # one another's bin and flatten the measured phase spread.
    basis = (win * np.exp(-2j * np.pi * kk * np.arange(T) / T)).astype(np.complex64)
    ft = np.tensordot(basis, pix_proj.astype(np.float32), axes=(0, 0))  # [H, W] complex
    ft_flat = ft.reshape(-1)
    ft_reg = ft_flat[sel] if sel is not None else ft_flat    # region pixels only
    w = (np.abs(ft_reg) ** 2).astype(np.float64)
    if float(w.sum()) > 1e-9:
        unit = ft_reg / (np.abs(ft_reg) + 1e-12)
        resultant = np.abs((unit * w).sum()) / w.sum()
        phase_spread = _clamp01(1 - float(resultant))
    else:
        phase_spread = 0.3

    # a near-static clip yields noise-driven turbulence/phase estimates, and
    # turbulence displacement is not amplitude-gated in the renderer — gate
    # them here so "no motion in" ⇒ "no motion out"
    gate = min(1.0, amplitude / 0.10)
    turbulence *= gate
    phase_spread *= gate
    swing_px *= gate         # a near-static clip has no real swing either

    return {
        "frequency": round(freq, 3),
        "amplitude": round(amplitude, 3),
        "direction": round(direction),
        "turbulence": round(turbulence, 3),
        "damping": round(damping, 3),
        "phaseSpread": round(phase_spread, 3),
        # physical peak swing of the dominant oscillation, in source pixels
        # (velocity amplitude ÷ angular frequency). Not consumed by the current
        # renderers — an informational, resolution-relative intensity cue.
        "swingPx": round(swing_px, 2),
        # steady directional travel (−1..1 of a fast drift), e.g. falling
        # leaves ≈ (0, +0.x); oscillation-only clips ≈ (0, 0)
        "driftX": round(drift_x, 3),
        "driftY": round(drift_y, 3),
    }


def grid_trajectories(flows: np.ndarray) -> list:
    """Integrate mean cell flow into GRID x GRID point tracks (normalized coords)."""
    T, _, H, W = flows.shape
    ch, cw = H // GRID, W // GRID
    cells = flows[:, :, : ch * GRID, : cw * GRID].reshape(T, 2, GRID, ch, GRID, cw).mean(axis=(3, 5))
    tracks = []
    for gy in range(GRID):
        for gx in range(GRID):
            x = (gx + 0.5) / GRID
            y = (gy + 0.5) / GRID
            pts, px, py = [[round(x, 4), round(y, 4)]], x, y
            for t in range(T):
                px += float(cells[t, 0, gy, gx]) / W
                py += float(cells[t, 1, gy, gx]) / H
                pts.append([round(px, 4), round(py, 4)])
            tracks.append(pts)
    return tracks


# ---------------------------------------------------------------- multi-motion segmentation
#
# When one clip contains several distinct motions (rain falling AND smoke
# rising, a flag flapping AND leaves drifting), the whole-frame distill above
# averages them into one noisy swatch. Segmentation groups the 12x12 grid into
# regions of coherent motion, then runs distill() per region so we return N
# separate swatches to name.
#
# The hard case that drove this design: rain (falling) and smoke (rising)
# overlap in space and differ only in DIRECTION. A purely spatial clustering
# (connected components on an energy mask) can never separate them — they'd be
# one connected blob. So we cluster by MOTION SIGNATURE first:
#   1. Static-scene kill: global magnitude-persistence >= cutoff -> no motion.
#   2. Video-RELATIVE active floor: energy >= PEAK_FRAC * peak. A fixed px
#      floor is wrong — cell energy ranges ~0.17 px/frame (rain/smoke) to
#      ~8 px/frame (bold synthetic) across clips; a fixed threshold either
#      rejects subtle real motion or admits noise. Relative-to-peak adapts.
#   3. Per-cell signature: drift-dominated cells bucket by 8-way drift octant
#      (rain=down, smoke=up land in opposite octants); oscillation-dominated
#      cells bucket by 4-way undirected axis (horizontal sway vs vertical
#      bounce). This is what lets overlapping opposite motions split.
#   4. Merge circular-adjacent signature bins (a drift at 44° and 46° are the
#      same motion straddling an octant boundary).
#   5. Split each signature group by SPATIAL connected-components — two blocks
#      swaying identically but in different corners are two regions.
#   6. Co-location merge: a drift group + oscillation group occupying the SAME
#      cells are one physical object doing two things (a flag both flutters
#      and blows). Merge only when bbox overlap is high.
#   7. Size/fraction filter, rank by energy, cap at MAX_REGIONS.
#   8. Per region: crop flows to the region bbox, zero non-region pixels,
#      distill(); build trajectories with out-of-region cells frozen.

# Filter by an ABSOLUTE cell count, not a fraction of active cells: a small
# real motion (a 4-cell flag) must not be punished for coexisting with a huge
# one (a full-frame waterfall) that inflates the active-cell count. Calibrated
# by grid-search over 9 clips (see benchmark.py multi / the sweep harness).
MIN_CELLS = 4                  # regions smaller than this are noise
MAX_REGIONS = 8                # cap what /analyze returns
REGION_KEEP_FRAC = 0.25        # keep the top region + any region with >= this
                               # fraction of the top region's total energy;
                               # drops weak signature-split fragments so the
                               # picker shows real motions, not noise slivers
# Active floor = min(ABS_FLOOR, PEAK_FRAC * peak).
#   - ABS_FLOOR (~RAFT's static-texture noise level) is the normal gate: it
#     admits any cell meaningfully above background, so a subtle motion (a
#     flag) isn't lost next to a 60x-louder one (a waterfall). A pure
#     fraction-of-peak fails there — 0.30*20px = 6px would reject the flag.
#   - PEAK_FRAC * peak only takes over when the WHOLE clip is fainter than
#     ABS_FLOOR (rain/smoke, peak 0.17): the floor drops to keep subtle
#     motion, and the static-persistence gate blocks genuinely-static clips.
ABS_FLOOR = 0.30               # absolute active floor (px/frame)
PEAK_FRAC = 0.30               # fraction-of-peak floor for sub-ABS_FLOOR clips
ABS_MIN = 0.05                 # if the peak cell energy is below this, the
                               # whole clip is effectively motionless — nothing
                               # moved enough for RAFT to register above noise
DRIFT_DOM = 0.8                # a cell is drift-dominated (bucket by octant)
                               # if |mean flow| >= DRIFT_DOM * oscillation std
DRIFT_MIN = 0.02               # ...and its drift magnitude exceeds this
# Static-scene gate: RAFT's per-pixel noise sticks to texture edges, so
# frame-to-frame magnitude correlation is ~1.0 on static clips and <=0.7 on
# every real motion clip we've measured. See distill() for the pixel-level
# version of this test.
STATIC_PERSISTENCE_CUTOFF = 0.85


def _seg_features(flows: np.ndarray) -> dict:
    """Per-cell motion features on the 12x12 grid.

    Returns arrays shaped [GRID, GRID]:
      energy    — mean flow magnitude over time (motion strength)
      drift_x/y — mean flow over time (steady directional travel)
      osc       — std of the drift-removed flow (oscillation strength)
      osc_axis  — principal axis of oscillation, radians mod pi (undirected)
    """
    T, _, H, W = flows.shape
    ch, cw = H // GRID, W // GRID
    cells = flows[:, :, : ch * GRID, : cw * GRID].reshape(
        T, 2, GRID, ch, GRID, cw).mean(axis=(3, 5))       # [T, 2, GRID, GRID]
    energy = np.sqrt(cells[:, 0] ** 2 + cells[:, 1] ** 2).mean(axis=0)
    drift_x = cells[:, 0].mean(axis=0)
    drift_y = cells[:, 1].mean(axis=0)
    ox = cells[:, 0] - drift_x[None]
    oy = cells[:, 1] - drift_y[None]
    osc = np.sqrt((ox ** 2 + oy ** 2).mean(axis=0))
    # oscillation axis via 2x2 covariance closed form (undirected, mod pi)
    cxx = (ox ** 2).mean(axis=0)
    cyy = (oy ** 2).mean(axis=0)
    cxy = (ox * oy).mean(axis=0)
    osc_axis = 0.5 * np.arctan2(2 * cxy, cxx - cyy)
    # per-cell dominant oscillation frequency BIN (Hann-windowed rFFT of each
    # cell's flow projected onto its own oscillation axis). Returned as a bin
    # index; segment_regions() converts to Hz via k*fps/T. This lets the
    # signature split two motions on the SAME axis that beat at different rates
    # (a fast flag vs a slow banner) — the old axis-only signature merged them.
    ac, as_ = np.cos(osc_axis), np.sin(osc_axis)
    proj = ox * ac[None] + oy * as_[None]                 # [T, GRID, GRID]
    win = np.hanning(T)
    spec = np.abs(np.fft.rfft(proj * win[:, None, None], axis=0))  # [F,GRID,GRID]
    spec[0] = 0.0
    osc_freq_bin = spec.argmax(axis=0).astype(np.int64)   # [GRID, GRID]
    return {"energy": energy, "drift_x": drift_x, "drift_y": drift_y,
            "osc": osc, "osc_axis": osc_axis, "osc_freq_bin": osc_freq_bin}


def _persistence(flows: np.ndarray) -> float:
    """Mean frame-to-frame correlation of the flow magnitude map.

    ~1.0 on static clips (RAFT noise anchored to texture edges), <=0.7 on real
    motion (which travels through space). Used to reject static scenes.
    """
    mag = np.sqrt(flows[:, 0] ** 2 + flows[:, 1] ** 2)
    a = mag[:-1].reshape(len(mag) - 1, -1)
    b = mag[1:].reshape(len(mag) - 1, -1)
    am = a - a.mean(axis=1, keepdims=True)
    bm = b - b.mean(axis=1, keepdims=True)
    corr = (am * bm).sum(axis=1) / (
        np.sqrt((am ** 2).sum(axis=1) * (bm ** 2).sum(axis=1)) + 1e-9)
    return float(corr.mean())


def _merge_circular_bins(items: list, nbins: int) -> list:
    """Union groups sitting in circular-adjacent bins, WITHOUT letting a chain
    of adjacencies collapse bins that are far apart on the ring.

    items: list of (bin_index, [cells]). Returns list of merged [cells] lists.
    A motion straddling a bucket boundary (44° vs 46°) shouldn't split — but a
    transitive chain (0-1-2) must NOT merge perpendicular oscillation axes
    (bin 0 = horizontal, bin 2 = vertical in the 4-ring) into one region just
    because a diagonal bridge bin (1) is populated. So a union is allowed only
    while the resulting group stays within a bounded angular SPAN:
      - 4-bin osc ring: span ≤ 1 step (adjacent axes only; blocks 0↔2 chains)
      - 8-bin drift ring: span ≤ 2 steps (±45° of drift direction)
    """
    max_span = 1 if nbins == 4 else 2

    binmap = {}
    for b, cells in items:
        binmap.setdefault(b, []).extend(cells)
    present = sorted(binmap)
    if not present:
        return []

    # group id per bin; each group tracks the set of bins it covers
    group_of = {b: i for i, b in enumerate(present)}
    covers = {i: {b} for i, b in enumerate(present)}

    def circular_span(bins):
        """Smallest arc (in steps) covering all bins on the ring."""
        s = sorted(bins)
        if len(s) == 1:
            return 0
        gaps = [(s[(i + 1) % len(s)] - s[i]) % nbins for i in range(len(s))]
        return nbins - max(gaps)   # total minus the largest empty arc

    for b in present:
        for nb in ((b + 1) % nbins, (b - 1) % nbins):
            if nb not in binmap:
                continue
            ga, gb = group_of[b], group_of[nb]
            if ga == gb:
                continue
            merged = covers[ga] | covers[gb]
            if circular_span(merged) <= max_span:
                # fold gb into ga
                for x in covers[gb]:
                    group_of[x] = ga
                covers[ga] = merged
                del covers[gb]

    out = {}
    for b, cells in binmap.items():
        out.setdefault(group_of[b], []).extend(cells)
    return list(out.values())


def _cc8(cellset: list) -> list:
    """8-connected components of a set of (gy, gx) cells."""
    S = set(cellset)
    seen = set()
    out = []
    for s in cellset:
        if s in seen:
            continue
        stack = [s]
        comp = []
        while stack:
            y, x = stack.pop()
            if (y, x) in seen or (y, x) not in S:
                continue
            seen.add((y, x))
            comp.append((y, x))
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    if dy or dx:
                        stack.append((y + dy, x + dx))
        out.append(comp)
    return out


def _region_bbox(mask: np.ndarray) -> dict:
    ys, xs = np.where(mask)
    return {
        "x0": float(xs.min()) / GRID,
        "y0": float(ys.min()) / GRID,
        "x1": float(xs.max() + 1) / GRID,
        "y1": float(ys.max() + 1) / GRID,
    }


def _region_trajectories(flows: np.ndarray, cell_mask: np.ndarray) -> list:
    """Trajectories for a single region: cells inside the mask move via their
    own flow; cells outside the mask are frozen at their start position (so
    frontend field-replay stays confined to the region).
    """
    T, _, H, W = flows.shape
    ch, cw = H // GRID, W // GRID
    cells = flows[:, :, : ch * GRID, : cw * GRID].reshape(
        T, 2, GRID, ch, GRID, cw).mean(axis=(3, 5))
    tracks = []
    for gy in range(GRID):
        for gx in range(GRID):
            x = (gx + 0.5) / GRID
            y = (gy + 0.5) / GRID
            pts = [[round(x, 4), round(y, 4)]]
            if cell_mask[gy, gx]:
                px, py = x, y
                for t in range(T):
                    px += float(cells[t, 0, gy, gx]) / W
                    py += float(cells[t, 1, gy, gx]) / H
                    pts.append([round(px, 4), round(py, 4)])
            else:
                for _ in range(T):
                    pts.append([round(x, 4), round(y, 4)])
            tracks.append(pts)
    return tracks


# stable palette used to color regions in the picker UI. Order mirrors what
# the frontend cycles through so the first uploaded region always lands on
# the same color regardless of scan order.
REGION_COLORS = [
    "#ff8a4c", "#4cc9ff", "#3ddc84", "#ffd93d",
    "#c86bff", "#ff5c9a", "#7c6cff", "#f28b3a",
]


def _direction_name(deg: float) -> str:
    """Short human-friendly label for a dominant axis (0..180 degrees)."""
    # 0/180 == horizontal, 90 == vertical
    if deg < 22.5 or deg >= 157.5:
        return "horizontal"
    if 67.5 <= deg < 112.5:
        return "vertical"
    if 22.5 <= deg < 67.5:
        return "diagonal ↘"
    return "diagonal ↗"


def _suggest_name(params: dict, idx: int, drift_cell=None, kind: str = "osc") -> str:
    """Best-guess label based on the extracted parameters. The user renames
    freely in the picker; this is just a starting point.

    kind: the region's dominant motion type as decided by segmentation —
        "drift" (steady directional travel: waterfall, falling leaves, rising
        smoke) or "osc" (back-and-forth: a flag, a swaying branch). This is the
        single most important input: it prevents naming a downward-streaming
        waterfall "Flutter" (an oscillation word) or a fluttering flag "Wave"
        when it is really oscillating. Naming honours the kind first, then
        refines with the numeric params.
    drift_cell: (mean_dx, mean_dy) px/frame from the raw cell features — its
        SIGN is the reliable up/down/left/right cue, especially for
        low-amplitude atmospheric motion where distilled driftX/Y is muted.
    """
    f = params.get("frequency", 0)
    a = params.get("amplitude", 0)
    turb = params.get("turbulence", 0)
    cdx, cdy = drift_cell if drift_cell is not None else (params.get("driftX", 0),
                                                          params.get("driftY", 0))

    # ---- DRIFT-dominated: steady travel. Name by direction of travel. ----
    if kind == "drift":
        # screen-y grows downward: cdy>0 falls, cdy<0 rises
        if abs(cdy) >= abs(cdx):
            base = "Falling" if cdy > 0 else "Rising"
        else:
            base = "Drifting"
        # a fast, turbulent downward stream is a waterfall/cascade
        if base == "Falling" and turb > 0.35 and f > 1.5:
            return "Streaming"
        return base

    # ---- OSCILLATION-dominated: back-and-forth. Name by rhythm/character. ----
    axis = _direction_name(params.get("direction", 0))
    if a < 0.06:
        # barely-moving oscillation — usually atmospheric shimmer
        return "Shimmer"
    if turb > 0.45:
        return "Flutter"            # fast, chaotic back-and-forth (a flag)
    if f >= 2.0:
        return "Flutter" if turb > 0.25 else ("Fast " + axis)
    if f < 0.6:
        return "Sway"               # slow oscillation (a branch, a hanging sign)
    return "Ripple" if turb > 0.2 else ("Wave" if axis == "horizontal" else "Sway")


def segment_regions(flows: np.ndarray, fps: float) -> list:
    """Return a list of {params, trajectories, bbox, cells, suggested_name,
    color} — one entry per distinct motion region. Empty list if the scene is
    static; single-entry if only one coherent motion survives; multi-entry
    when the clip has several distinct motions (including overlapping ones
    that differ by direction, like rain vs smoke).

    Every clip runs the same general automatic segmenter — there is no
    filename-based curation.
    """
    T, _, H, W = flows.shape

    # ---- static-scene kill ----
    if _persistence(flows) >= STATIC_PERSISTENCE_CUTOFF:
        return []

    feats = _seg_features(flows)
    energy = feats["energy"]
    peak = float(energy.max())
    if peak < ABS_MIN:
        return []

    # active mask: absolute floor for normal clips (so a subtle motion beside a
    # much louder one still registers), dropping to a fraction-of-peak only for
    # clips fainter than the absolute floor. See ABS_FLOOR / PEAK_FRAC above.
    floor = max(min(ABS_FLOOR, PEAK_FRAC * peak), ABS_MIN)
    active = energy >= floor
    n_active = int(active.sum())
    if n_active < MIN_CELLS:
        return []

    # ---- per-cell signature bucketing ----
    # drift-dominated cells -> 8-way octant; oscillation-dominated -> (freq
    # band, 4-way axis). The frequency band is the new dimension: two motions
    # sharing an axis but beating at different rates (a fast flag over a slow
    # banner) now land in different buckets instead of merging.
    drift_bins = {}   # octant -> [cells]
    osc_bins = {}     # (freq_band, axis4) -> [cells]
    for gy in range(GRID):
        for gx in range(GRID):
            if not active[gy, gx]:
                continue
            dm = math.hypot(feats["drift_x"][gy, gx], feats["drift_y"][gy, gx])
            om = float(feats["osc"][gy, gx])
            if dm >= DRIFT_DOM * om and dm > DRIFT_MIN:
                ang = math.degrees(math.atan2(feats["drift_y"][gy, gx],
                                              feats["drift_x"][gy, gx]))
                octant = int(round(ang / 45.0)) % 8
                drift_bins.setdefault(octant, []).append((gy, gx))
            else:
                axis4 = int(round(math.degrees(feats["osc_axis"][gy, gx]) % 180
                                  / 45.0)) % 4
                fhz = float(feats["osc_freq_bin"][gy, gx]) * fps / T
                fband = 0 if fhz < 1.2 else (1 if fhz < 3.0 else 2)
                osc_bins.setdefault((fband, axis4), []).append((gy, gx))

    # merge circular-adjacent signature bins, then split each group spatially.
    # Carry each group's KIND ("drift" = steady travel like a waterfall/leaves;
    # "osc" = back-and-forth like a flag/sway) through the split so naming can
    # pick a kinematically-honest label (a downward-streaming region must not
    # be called "Flutter", an oscillating flag must not be called "Wave" when
    # it's really fluttering).
    regions_cells = []   # list of (kind, [cells])
    for grp in _merge_circular_bins(list(drift_bins.items()), 8):
        for comp in _cc8(grp):
            regions_cells.append(("drift", comp))
    # oscillation: within each frequency band, merge circular-adjacent axes;
    # across bands, never merge (same axis + different rate = distinct motions).
    osc_by_band = {}
    for (fband, axis4), cells in osc_bins.items():
        osc_by_band.setdefault(fband, []).append((axis4, cells))
    for items in osc_by_band.values():
        for grp in _merge_circular_bins(items, 4):
            for comp in _cc8(grp):
                regions_cells.append(("osc", comp))

    # Note: no co-location bbox merge. Signature clustering already separates
    # distinct motions; merging by bbox overlap collapsed a flag and an
    # adjacent waterfall into one region (their bounding boxes overlap even
    # though the motions are distinct). A same-object-two-motions case (a flag
    # that both flutters and blows) tends to land in one signature bin anyway.

    # size filter (absolute cell count — see MIN_CELLS note above), rank by energy
    def group_energy(item):
        return float(sum(energy[gy, gx] for gy, gx in item[1]))

    candidates = [it for it in regions_cells if len(it[1]) >= MIN_CELLS]
    candidates.sort(key=group_energy, reverse=True)
    # Keep only STRONG regions: the top mover unconditionally, plus any region
    # with at least REGION_KEEP_FRAC of the top region's energy. Signature
    # clustering can over-split one physical motion into a dominant region plus
    # a few weak fragments (e.g. a flag → one big region + noise slivers); this
    # relative-energy cut keeps the picker to the motions that actually matter
    # instead of showing 5 cards where 3 are noise. Calibrated across 9 clips.
    if candidates:
        top_energy = group_energy(candidates[0])
        candidates = [candidates[0]] + [
            it for it in candidates[1:]
            if group_energy(it) >= REGION_KEEP_FRAC * top_energy]
    candidates = candidates[:MAX_REGIONS]

    regions = []
    for idx, (kind, cells_list) in enumerate(candidates):
        r = _build_region(flows, fps, feats, energy, cells_list, idx, kind=kind)
        if r is not None:
            regions.append(r)
    return regions


def _build_region(flows, fps, feats, energy, cells_list, idx, kind="osc"):
    """Run the REAL distill + trajectory extraction over one region (a list of
    (gy, gx) cells) and return the region dict.
    """
    T, _, H, W = flows.shape
    ch, cw = H // GRID, W // GRID
    cell_mask = np.zeros((GRID, GRID), dtype=bool)
    for gy, gx in cells_list:
        cell_mask[gy, gx] = True
    if not cell_mask.any():
        return None

    # pixel mask: block-expand the cell mask, trimmed to the sampled area
    pixel_mask = np.zeros((H, W), dtype=bool)
    for gy in range(GRID):
        for gx in range(GRID):
            if cell_mask[gy, gx]:
                pixel_mask[gy * ch : (gy + 1) * ch,
                           gx * cw : (gx + 1) * cw] = True
    pixel_mask = pixel_mask[: ch * GRID, : cw * GRID]

    # Crop flows to the region's bounding-cell rectangle + pass the region's
    # TRUE pixel mask so distill's statistics are over region pixels only
    # (avoids the shape-dependent amplitude suppression a zeroed crop caused).
    ys, xs = np.where(cell_mask)
    gy0, gy1 = int(ys.min()), int(ys.max()) + 1
    gx0, gx1 = int(xs.min()), int(xs.max()) + 1
    crop = flows[:, :, gy0 * ch : gy1 * ch, gx0 * cw : gx1 * cw]
    sub_mask = pixel_mask[gy0 * ch : gy1 * ch, gx0 * cw : gx1 * cw]
    region_peak = float(energy[cell_mask].max())
    region_floor = float(min(0.55, max(0.12, region_peak * 0.6)))
    params = distill(crop, fps, noise_floor=region_floor, mask=sub_mask)
    if params is None:
        return None

    region_dx = float(feats["drift_x"][cell_mask].mean())
    region_dy = float(feats["drift_y"][cell_mask].mean())
    tracks = _region_trajectories(flows, cell_mask)
    return {
        "params": params,
        "trajectories": tracks,
        "bbox": _region_bbox(cell_mask),
        "cells": int(cell_mask.sum()),
        "suggested_name": _suggest_name(params, idx, (region_dx, region_dy), kind),
        "color": REGION_COLORS[idx % len(REGION_COLORS)],
    }


# ---------------------------------------------------------------- routes
@app.get("/health")
def health():
    return {"ok": True, "engine": f"{ENGINE} (torchvision pretrained)", "device": DEVICE}


# Adaptive hi-res retry: RAFT under-resolves faint/thin motion at the default
# width, so a real-but-subtle clip (light foliage, gentle ripple) can distill
# to near-zero amplitude and get dropped. When that happens AND there's room to
# go higher, re-analyze once at RETRY_WIDTH and keep whichever result actually
# found more motion. Only triggers on faint clips, so the common case pays
# nothing.
RETRY_WIDTH = int(os.environ.get("MS_RETRY_WIDTH", "720"))
RETRY_AMP = float(os.environ.get("MS_RETRY_AMP", "0.08"))


@app.post("/analyze")
async def analyze(file: UploadFile = File(...)):
    suffix = Path(file.filename or "clip.mp4").suffix or ".mp4"
    tmp = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
    try:
        tmp.write(await file.read())
        tmp.flush()
        tmp.close()

        frames, fps = read_frames(tmp.name)
        if frames is None or len(frames) < 13:
            return {"ok": False,
                    "error": "could not decode enough frames (need ≥ 13)"}
        flows = raft_flow_series(frames)
        params = distill(flows, fps)
        if params is None:
            return {"ok": False, "error": "not enough motion data"}

        # adaptive hi-res retry for faint clips (see RETRY_* above)
        used_width = ANALYSIS_WIDTH
        if params["amplitude"] < RETRY_AMP and ANALYSIS_WIDTH < RETRY_WIDTH:
            f2, fps2 = read_frames(tmp.name, width=RETRY_WIDTH)
            if f2 is not None and len(f2) >= 13:
                fl2 = raft_flow_series(f2)
                p2 = distill(fl2, fps2)
                if p2 is not None and p2["amplitude"] > params["amplitude"]:
                    frames, fps, flows, params = f2, fps2, fl2, p2
                    used_width = RETRY_WIDTH

        regions = segment_regions(flows, fps)

        return {
            "ok": True,
            "engine": f"{ENGINE}@{DEVICE}",
            "fps": round(fps, 2),
            "frames_analyzed": int(len(frames)),
            "analysis_width": used_width,       # 720 if the hi-res retry won
            # whole-frame swatch — kept for backward compatibility, single-motion
            # clips, and the fallback path when picker is skipped
            "params": params,
            "trajectories": grid_trajectories(flows),
            # per-motion segmentation — empty if RAFT can't find a moving cell,
            # single-entry if all motion is one coherent region, multi-entry if
            # the clip has several distinct motions. Frontend picks the picker
            # UI when len(regions) >= 2.
            "regions": regions,
        }
    finally:
        try:
            os.remove(tmp.name)
        except OSError:
            pass
