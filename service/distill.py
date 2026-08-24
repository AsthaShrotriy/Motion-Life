"""Distill dense flow into the 6 motion params + a GRIDxGRID trajectory grid."""
import math
import numpy as np
from config import GRID


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

    proj = gvx * ax + gvy * ay

    # dominant frequency via rFFT with parabolic refinement
    spec = np.abs(np.fft.rfft(proj))
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
    resid = flows - drift_px.reshape(1, 2, 1, 1)
    mag_map = np.sqrt(resid[:, 0] ** 2 + resid[:, 1] ** 2)   # [T, H, W]
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
    else:
        amplitude = 0.0

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

    # damping: autocorrelation at one dominant-period lag
    lag = max(2, min(T - 4, round(fps / freq)))
    den = float((proj**2).sum())
    r = abs(float((proj[:-lag] * proj[lag:]).sum()) / den) if den > 1e-9 else 0.5
    damping = _clamp01(1 - r)

    # phase spread: energy-weighted circular variance of PER-PIXEL phase at
    # the dominant bin. Cell-averaging blends opposite-phase pixels within a
    # cell (cancellation) and RAFT's smoothness prior bleeds flow into the
    # background, so we go per-pixel: single-bin DFT via dot product with
    # exp(-2πikt/T), weight each pixel by its spectral energy at that bin.
    pix_proj = flows[:, 0] * ax + flows[:, 1] * ay           # [T, H, W]
    kk = max(k, 1)
    basis = np.exp(-2j * np.pi * kk * np.arange(T) / T).astype(np.complex64)
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

    return {
        "frequency": round(freq, 3),
        "amplitude": round(amplitude, 3),
        "direction": round(direction),
        "turbulence": round(turbulence, 3),
        "damping": round(damping, 3),
        "phaseSpread": round(phase_spread, 3),
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
