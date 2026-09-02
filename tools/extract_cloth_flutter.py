#!/usr/bin/env python3
"""Extract a travelling-wave cloth swatch from a video of real cloth.

This is the tool that produced assets/motion/flutter-flag-autumn.json. It is here
so the swatch is REPRODUCIBLE — the numbers in that file's `measured` block are
printed by this script, not typed in by hand.

What it measures, and why each one matters to the deformer:

  centreline per frame   The cloth's transverse deflection sampled at N stations
                         along its free length. This IS the swatch — the deformer
                         plays it back, so the folds are the video's folds.
  wavelengths_across     How many folds are visible at once. The synthetic preset
                         in js/motionfields.js hardcodes WAVE_CYCLES = 2.6; the real
                         flag measures 0.45, i.e. the preset draws 5.8x too many.
  amp_ramp_exponent      How deflection grows from the anchored end to the free
                         end. Fitted, not assumed (the preset hardcodes 1.15).
  dominant_hz + share    The peak frequency AND how little of the power it holds.
                         A low share is the point: real cloth is broadband, which
                         is why it reads better than any single sine.
  loop_wrap_seam         |frame[-1] - frame[0]| against the median frame-to-frame
                         step. Below ~1 step the clip loops without a visible pop,
                         so the swatch can be used untrimmed.

Extraction is by SILHOUETTE COLUMN, not optical flow: the cloth is colour-keyed
inside a ROI, then for each column x we keep the LARGEST CONTIGUOUS RUN of mask
pixels and take its centroid. The contiguity step is load-bearing on the autumn
reference clip — the fallen leaves are the same red as the flag, and a naive
per-column mean of all red pixels tracks the leaves instead of the cloth.

Deflection is stored in units of the cloth's own free LENGTH (anchor->tip), not
pixels and not the cloth's width. That makes the swatch dimensionless: the same
relative sweep transfers onto a ribbon of any size in any artwork.

Usage:
  python3 tools/extract_cloth_flutter.py VIDEO --roi X0 X1 Y0 Y1 -o OUT.json \
      [--frames 96] [--stations 25] [--key red] [--id ID] [--name NAME]

  --roi is required and is in source-video pixels: crop it to the cloth only.
  Run without --roi to get a frame dump you can eyeball for the numbers.
"""
import argparse, json, os, subprocess, sys, tempfile, warnings

import numpy as np


# ── source frames ─────────────────────────────────────────────────────────────
def probe(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
         "stream=width,height,r_frame_rate", "-of", "json", path],
        capture_output=True, text=True, check=True).stdout
    s = json.loads(out)["streams"][0]
    num, den = s["r_frame_rate"].split("/")
    return int(s["width"]), int(s["height"]), float(num) / float(den)


def frames(path, w, h, fps, n):
    """Decode n frames as uint8 RGB at `fps`, via one ffmpeg pipe."""
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-vf", f"fps={fps}",
         "-frames:v", str(n), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        capture_output=True, check=True).stdout
    got = len(raw) // (w * h * 3)
    return np.frombuffer(raw[: got * w * h * 3], np.uint8).reshape(got, h, w, 3)


# ── colour keys ───────────────────────────────────────────────────────────────
# Thresholds are on CHANNEL DIFFERENCES, not absolute values, so the key survives
# the exposure swings of an outdoor clip.
KEYS = {
    "red":   lambda R, G, B: (R > 80) & (R - G > 45) & (R - B > 35),
    "green": lambda R, G, B: (G > 80) & (G - R > 40) & (G - B > 30),
    "blue":  lambda R, G, B: (B > 80) & (B - R > 40) & (B - G > 30),
    "dark":  lambda R, G, B: (R < 70) & (G < 70) & (B < 70),
}


def longest_run(col):
    """Start/stop of the longest contiguous True run in a 1-D bool array."""
    idx = np.flatnonzero(col)
    if idx.size == 0:
        return None
    breaks = np.flatnonzero(np.diff(idx) > 1)
    starts = np.concatenate(([0], breaks + 1))
    stops = np.concatenate((breaks + 1, [idx.size]))
    k = np.argmax(stops - starts)
    return idx[starts[k]], idx[stops[k] - 1] + 1


def all_runs(col, minlen=3):
    """Every contiguous True run in a column, as (start, stop) pairs."""
    idx = np.flatnonzero(col)
    if idx.size == 0:
        return []
    breaks = np.flatnonzero(np.diff(idx) > 1)
    starts = np.concatenate(([0], breaks + 1))
    stops = np.concatenate((breaks + 1, [idx.size]))
    return [(idx[a], idx[b - 1] + 1) for a, b in zip(starts, stops)
            if idx[b - 1] + 1 - idx[a] >= minlen]


RUN_FRAC = 0.2          # a candidate run must be this fraction of its column's largest
STEP_FRAC = 0.25        # ...and within this fraction of the ROI height of its neighbour


def track_columns(mask, seed):
    """Centreline for one frame, choosing runs by CONTINUITY -> (mids, heights).

    Taking the largest run per column independently is what breaks when the cloth folds
    over itself: the silhouette splits into lobes and the largest one is a different
    lobe in adjacent columns, so the centreline jumps half a cloth-width. Measured on
    the reference clip that produced adjacent-station steps of 0.68 of the cloth's
    length — 96px on a 141px scarf — and it affected 52 of 96 frames.

    A sheet of cloth is continuous, so the centreline is tracked outward from the
    cloth's widest column (the most reliable place to start) and at each step takes the
    run whose centroid is NEAREST the previous column's, not the biggest. A column with
    no candidate within STEP_FRAC of the ROI height is left NaN rather than guessed.
    """
    h, n = mask.shape
    mids = np.full(n, np.nan)
    heights = np.full(n, np.nan)
    runs = [all_runs(mask[:, c]) for c in range(n)]
    if not runs[seed]:
        return mids, heights
    a, b = max(runs[seed], key=lambda r: r[1] - r[0])
    mids[seed] = (a + b - 1) / 2.0
    heights[seed] = b - a
    max_step = STEP_FRAC * h
    for direction in (1, -1):
        prev = mids[seed]
        c = seed + direction
        while 0 <= c < n:
            cand = runs[c]
            if cand:
                big = max(r[1] - r[0] for r in cand)
                cand = [r for r in cand if r[1] - r[0] >= max(3, RUN_FRAC * big)]
            if cand:
                a, b = min(cand, key=lambda r: abs((r[0] + r[1] - 1) / 2.0 - prev))
                m = (a + b - 1) / 2.0
                if abs(m - prev) <= max_step:
                    mids[c] = m
                    heights[c] = b - a
                    prev = m
            c += direction
    return mids, heights


def scan(fs, roi, key, seed=None):
    """All frames -> (mids, heights), each frames x ROI-width, NaN where no cloth.

    Full column resolution: the cloth's own extent is found from this, not assumed.
    With `seed` given, each frame's centreline is tracked for continuity from that
    column (see track_columns); without it, each column independently takes its largest
    run — which is the pass used to FIND the seed.
    """
    x0, x1, y0, y1 = roi
    n = x1 - x0
    mids = np.full((len(fs), n), np.nan)
    heights = np.full((len(fs), n), np.nan)
    for i, fr in enumerate(fs):
        sub = fr[y0:y1, x0:x1].astype(np.int16)
        mask = key(sub[:, :, 0], sub[:, :, 1], sub[:, :, 2])
        if seed is not None:
            mids[i], heights[i] = track_columns(mask, seed)
            continue
        for c in range(n):
            run = longest_run(mask[:, c])
            if run is None:
                continue
            a, b = run
            mids[i, c] = (a + b - 1) / 2.0
            heights[i, c] = b - a
    return mids, heights


def widest_column(heights):
    """The column with the largest median chord — where the cloth is most reliably seen."""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        med = np.nan_to_num(np.nanmedian(heights, axis=0))
    return int(np.argmax(med))


MODES = 4               # cantilever modes kept; see fit_modes


def fit_modes(D, u, K=MODES, iters=6):
    """Reconstruct each frame's centreline in the bandwidth the motion actually occupies.

    Two things this fixes at once, both measured rather than assumed:

    BANDWIDTH. The cloth shows only ~0.45 wavelengths along its whole length, so the
    true centreline is very smooth and station-to-station jaggedness cannot be signal.
    Feeding that jaggedness to the deformer is what tears the artwork: the deformer
    interpolates linearly between stations, so a step of 0.08 of the cloth's length
    across one station spacing shears a 6px segment by 11px.

    FOLD AMBIGUITY. Where the cloth folds, its silhouette does not determine its
    centreline at all, and track_columns can only reduce those errors, not remove them.
    The fit is therefore iteratively reweighted (Cauchy weights on the residual), which
    lets the 76% of stations that agree outvote the folded ones instead of being
    averaged with them.

    The basis is sin(pi(k-1/2)u), k=1..K — the cantilever modes: each vanishes at u=0,
    so the anchored end is held EXACTLY (measured anchor travel there is 0.0016 of the
    cloth's length, i.e. pinned) instead of being allowed to drift by the fit. K=4 has
    2 wavelengths of capacity against the 0.45 measured, keeps 90% of the tip's travel
    and the full 1.75Hz spectrum, and bounds the worst local stretch.
    """
    B = np.stack([np.sin(np.pi * (k - 0.5) * u) for k in range(1, K + 1)], axis=1)
    out = np.empty_like(D)
    for i, row in enumerate(D):
        wts = np.ones(len(u))
        for _ in range(iters):
            rw = np.sqrt(wts)
            coef, *_ = np.linalg.lstsq(B * rw[:, None], row * rw, rcond=None)
            r = row - B @ coef
            s = 1.4826 * np.median(np.abs(r - np.median(r))) + 1e-9
            wts = 1.0 / (1.0 + (r / (2.0 * s)) ** 2)
        out[i] = B @ coef
    return out


COV_MIN = 0.85          # a column must find cloth in this fraction of frames
CHORD_MIN = 0.35        # ...and be at least this thick relative to the widest column


def cloth_extent(mids, heights):
    """Largest contiguous column span that is really CLOTH -> (c0, c1, chord).

    Two rejections, both needed on the autumn reference clip:
      coverage  drops columns the cloth only occasionally reaches — past the fly
                end the key is firing on fallen leaves, which have no cloth in
                most frames.
      chord     drops columns far thinner than the cloth's widest. This is what
                removes the POLE: measured on the reference clip the pole's
                columns are 5-38px tall against the flag's 158px, and their
                near-zero deflection would otherwise be read as "the anchor",
                putting u=0 on the mast instead of the hoist.
    """
    cov = (~np.isnan(mids)).mean(axis=0)
    with warnings.catch_warnings():          # all-NaN columns are expected background
        warnings.simplefilter("ignore", RuntimeWarning)
        med = np.nanmedian(heights, axis=0)
    med = np.nan_to_num(med)
    keep = (cov >= COV_MIN) & (med >= CHORD_MIN * med.max())
    idx = np.flatnonzero(keep)
    if idx.size < 4:
        return None
    breaks = np.flatnonzero(np.diff(idx) > 1)
    starts = np.concatenate(([0], breaks + 1))
    stops = np.concatenate((breaks + 1, [idx.size]))
    k = np.argmax(stops - starts)
    c0, c1 = int(idx[starts[k]]), int(idx[stops[k] - 1])
    c0, c1 = trim_edges(mids, c0, c1)
    return c0, c1, float(np.median(med[c0:c1 + 1]))


EDGE_K = 10             # columns inward used as the local reference
EDGE_F = 3.0            # edge travel this many times the local median is not cloth


def trim_edges(mids, c0, c1):
    """Drop edge columns whose CENTROID is not on the cloth.

    Neither of cloth_extent's tests catches the column right at the hoist: there
    the run is tall enough and present in every frame, but the pole slices it, so
    the "largest run" flips between the cloth and a fragment and the centroid
    jumps half a cloth-width. Measured on the reference clip, column 31 has a
    chord of 144px against the flag's 158 (so no chord ratio can reject it) yet
    travels 19.4px where its neighbour two columns in travels 0.26px.

    The test is that travel varies SMOOTHLY along real cloth: walk in from each
    edge and drop a column whose travel exceeds EDGE_F x the median of the next
    EDGE_K columns inward. This is deliberately not a global threshold on travel
    — at the fly end travel climbs steeply but smoothly, and that IS the signal.
    """
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        rms = np.nan_to_num(np.nanstd(mids, axis=0))
    while c1 - c0 > 20 and rms[c0] > EDGE_F * max(np.median(rms[c0 + 1:c0 + 1 + EDGE_K]), 0.05):
        c0 += 1
    while c1 - c0 > 20 and rms[c1] > EDGE_F * max(np.median(rms[c1 - EDGE_K:c1]), 0.05):
        c1 -= 1
    return c0, c1


def orient(D, u):
    """Put u=0 on the ANCHORED end. Returns (D, flipped).

    Which end is pinned is a property of the footage, not something to assume.
    The anchored end is the quieter one: compare travel over the outer 15% of
    each end and flip if the far end moves less.
    """
    m = max(2, int(round(0.15 * D.shape[1])))
    a, b = D[:, :m].std(), D[:, -m:].std()
    return (D[:, ::-1].copy(), True) if b < a else (D, False)


def interp_nans(D):
    """Fill NaNs per station along TIME. Returns (filled, count)."""
    D = D.copy()
    n = 0
    for j in range(D.shape[1]):
        col = D[:, j]
        bad = np.isnan(col)
        if bad.all():
            col[:] = 0.0
            n += bad.sum()
            continue
        if bad.any():
            t = np.arange(len(col))
            col[bad] = np.interp(t[bad], t[~bad], col[~bad])
            n += int(bad.sum())
    return D, n


# ── measurements ──────────────────────────────────────────────────────────────
def measure(D, u, fps):
    """Everything that goes in the swatch's `measured` block. D: frames x stations."""
    nf = D.shape[0]
    rms = D.std(axis=0)                              # per station

    # Amplitude ramp: rms(u) ~ u^p, fitted in log-log over the stations that move.
    ok = (u > 0.05) & (rms > rms.max() * 0.05)
    ramp = (float(np.polyfit(np.log(u[ok]), np.log(rms[ok]), 1)[0])
            if ok.sum() >= 3 else float("nan"))

    # Spectrum of the tip (the station with the most travel).
    tip = D[:, int(np.argmax(rms))]
    spec = np.abs(np.fft.rfft(tip - tip.mean()))
    freqs = np.fft.rfftfreq(nf, 1.0 / fps)
    kdom = int(np.argmax(spec[1:])) + 1
    power = spec ** 2
    dom_hz = float(freqs[kdom])
    share = float(power[kdom] / power[1:].sum())
    k2 = min(2 * kdom, len(spec) - 1)
    h2 = float(spec[k2] / max(spec[kdom], 1e-9))

    # Spatial wavelength + travel direction, from the phase of each station at the
    # dominant frequency. A wave TRAVELLING outward has phase falling with u; the
    # slope in cycles across the whole cloth is the wavelength count.
    ph = np.angle(np.fft.rfft(D - D.mean(axis=0), axis=0)[kdom])
    phu = np.unwrap(ph)
    slope, _ = np.polyfit(u, phu, 1)
    resid = float(np.std(phu - np.polyval([slope, _], u)))
    return {
        "dominant_hz": round(dom_hz, 3),
        "spectral_share_of_dominant": round(share, 3),
        "wavelengths_across": round(abs(slope) / (2 * np.pi), 3),
        "travel": "anchor->tip" if slope < 0 else "tip->anchor",
        "phase_linearity_resid_rad": round(resid, 3),
        "amp_ramp_exponent": round(ramp, 3),
        "second_harmonic_ratio": round(h2, 3),
        "rms": round(float(D.std()), 5),
        "peak": round(float(np.abs(D).max()), 5),
        "rms_at_anchor": round(float(rms[0]), 5),
        "rms_at_tip": round(float(rms[-1]), 5),
    }


def params_from(m):
    """The 8 renderer dials (contracts.PARAM_KEYS), DERIVED from the measurements.

    Every library motion carries these — js/main.js draws the swatch chip with
    computeMotion(motion.params, ...) and the synthetic wave branch reads them if the
    centreline ever fails to build — so they must be present and they must not be
    invented. Each mapping below is a measured quantity, not a taste call:

      frequency    the dominant flutter rate, in Hz.
      amplitude    tip travel, as 2x its RMS in length units (RMS rather than peak so
                   one gust does not set the dial).
      direction    0 by construction. Deflection is PERPENDICULAR TO THE CLOTH'S OWN
                   axis, which the deformer fits per artwork, so there is no global
                   direction to report and reporting one would be a fiction.
      turbulence   the share of power NOT at the dominant peak. Real cloth is
                   broadband; this says how much of it a single sine would miss.
      damping      anchor RMS over tip RMS — how firmly the anchored end is held.
                   0 is perfectly pinned.
      phaseSpread  wavelengths visible along the cloth at once, clamped to the dial.
      driftX/Y     0 by construction: each station is stored about its own mean, so
                   the swatch carries no net translation.
    """
    clip01 = lambda v: max(0.0, min(1.0, float(v)))
    tip = max(m["rms_at_tip"], 1e-9)
    return {
        "frequency": round(m["dominant_hz"], 3),
        "amplitude": round(clip01(2 * m["rms_at_tip"]), 3),
        "direction": 0,
        "turbulence": round(clip01(1 - m["spectral_share_of_dominant"]), 3),
        "damping": round(clip01(m["rms_at_anchor"] / tip), 4),
        "phaseSpread": round(clip01(m["wavelengths_across"]), 3),
        "driftX": 0, "driftY": 0,
    }


def loop_quality(D):
    step = float(np.median(np.abs(np.diff(D, axis=0)).mean(axis=1)))
    seam = float(np.abs(D[-1] - D[0]).mean())
    return {"loop_wrap_seam": round(seam, 5),
            "median_frame_step": round(step, 5),
            "seam_in_frame_steps": round(seam / max(step, 1e-9), 2)}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("video")
    ap.add_argument("--roi", nargs=4, type=int, metavar=("X0", "X1", "Y0", "Y1"),
                    help="cloth bounding box in source pixels (required to extract)")
    ap.add_argument("-o", "--out", help="output swatch JSON")
    ap.add_argument("--frames", type=int, default=96)
    ap.add_argument("--stations", type=int, default=25)
    ap.add_argument("--fps", type=float, default=24.0)
    ap.add_argument("--key", choices=sorted(KEYS), default="red")
    ap.add_argument("--modes", type=int, default=MODES,
                    help=f"cantilever modes kept in the spatial fit (default {MODES})")
    ap.add_argument("--id", default="flutter-extracted")
    ap.add_argument("--name", default="Flag Flutter (extracted)")
    ap.add_argument("--dump", metavar="DIR", help="write ROI frames as PNG to eyeball the key")
    a = ap.parse_args(argv)

    w, h, src_fps = probe(a.video)
    print(f"source {w}x{h} @ {src_fps:.3f} fps")
    if not a.roi:
        d = a.dump or tempfile.mkdtemp(prefix="cloth-")
        os.makedirs(d, exist_ok=True)
        subprocess.run(["ffmpeg", "-v", "error", "-i", a.video, "-vf", "fps=2",
                        "-frames:v", "8", os.path.join(d, "f%02d.png")], check=True)
        print(f"no --roi given; wrote reference frames to {d}\n"
              f"crop the cloth in an image viewer, then re-run with "
              f"--roi X0 X1 Y0 Y1")
        return 0

    x0, x1, y0, y1 = a.roi
    fs = frames(a.video, w, h, a.fps, a.frames)
    print(f"decoded {len(fs)} frames at {a.fps} fps, roi {x1-x0}x{y1-y0}")

    # Pass 1 finds where the cloth is widest; pass 2 tracks each frame's centreline
    # outward from there so a folded silhouette cannot swap lobes between columns.
    probe_mids, probe_heights = scan(fs, (x0, x1, y0, y1), KEYS[a.key])
    seed = widest_column(probe_heights)
    print(f"seed column {seed} (widest chord) — tracking centreline for continuity")
    mids, heights = scan(fs, (x0, x1, y0, y1), KEYS[a.key], seed=seed)
    ext = cloth_extent(mids, heights)
    if ext is None:
        print(f"ERROR: the '{a.key}' key found no cloth in that ROI. "
              f"Re-run with --dump to check the crop and the key colour.",
              file=sys.stderr)
        return 1
    c0, c1, chord = ext
    length_px = float(c1 - c0)
    print(f"cloth spans ROI columns {c0}..{c1} (length {length_px:.0f}px, "
          f"chord {chord:.0f}px); trimmed {(x1-x0) - (c1-c0+1)} of {x1-x0} columns "
          f"as pole/background")

    cols = np.linspace(c0, c1, a.stations).round().astype(int)
    D, filled = interp_nans(mids[:, cols])
    pct = 100.0 * filled / D.size
    print(f"interpolated {filled}/{D.size} samples ({pct:.2f}%)")

    # Deflection about each station's own mean: the swatch is the FLUTTER, not the
    # cloth's rest droop (the artwork already draws its own rest shape).
    D -= D.mean(axis=0)
    D, flipped = orient(D, None)
    print(f"anchored end is the {'FAR' if flipped else 'NEAR'} end of the ROI"
          f"{' (stations reversed so u=0 is the anchor)' if flipped else ''}")
    u = np.linspace(0.0, 1.0, a.stations)

    Dfit = fit_modes(D, u, a.modes)
    resid = np.abs(D - Dfit)
    print(f"fitted {a.modes} cantilever modes: median residual {np.median(resid):.4f}px, "
          f"{100.0 * (resid < 0.02 * length_px).mean():.0f}% of stations within 2% of "
          f"the cloth's length of the fit, tip travel kept "
          f"{100.0 * Dfit[:, -1].std() / max(D[:, -1].std(), 1e-9):.0f}%")
    D = Dfit

    m = measure(D, u, a.fps)
    m.update(loop_quality(D / length_px))
    m["interpolated_samples_pct"] = round(pct, 2)
    print("measured: " + "  ".join(f"{k}={v}" for k, v in m.items()))
    if m["seam_in_frame_steps"] > 1.5:
        print(f"NOTE: wrap seam is {m['seam_in_frame_steps']}x a frame step — this "
              f"clip will pop when looped. Trim --frames to a whole number of "
              f"flutter cycles (~{a.fps / max(m['dominant_hz'], 1e-6):.0f} frames each).")

    Dl = D / length_px            # <- length-normalised: dimensionless transfer
    m["rms"] = round(float(Dl.std()), 5)
    m["peak"] = round(float(np.abs(Dl).max()), 5)
    m["rms_at_anchor"] = round(float(Dl[:, 0].std()), 5)
    m["rms_at_tip"] = round(float(Dl[:, -1].std()), 5)

    params = params_from(m)       # after the length normalisation above, not before
    print("params: " + "  ".join(f"{k}={v}" for k, v in params.items()))

    sw = {
        "id": a.id, "name": a.name, "fromUpload": True, "color": "#e2603c",
        "class": "cloth", "kind": "video", "params": params,
        "desc": (f"Real cloth flutter measured from video — {m['dominant_hz']} Hz, "
                 f"{m['wavelengths_across']} wavelengths across, travelling {m['travel']}"),
        "source": {"video": a.video, "roi_xyxy": [x0, x1, y0, y1], "fps": a.fps,
                   "cloth_columns": [c0, c1], "anchor_end": "far" if flipped else "near",
                   "frames": len(fs),
                   "engine": "silhouette column centroid (largest contiguous run per column)",
                   "tool": "tools/extract_cloth_flutter.py"},
        # Deliberately NOT under `swatches`: a centreline is not one of
        # contracts.SWATCH_KINDS ("texture", "skeleton", "path"), and stamping it
        # with one of those kinds would make it fail validate_swatch or lie about
        # carrying a flow field. It rides at the top level next to `pose`/`path`,
        # which js/animate.js already reads that way (_poseFor / _pathFor). The
        # motion's class="cloth" is what routes it to the wave applicator.
        "centreline": {
            "engine": "silhouette_column_centroid", "fps": a.fps, "anchor": "u0",
            "units": "transverse deflection in units of the cloth's free length (anchor->tip)",
            "normalised_by": {"chord_height_px": round(chord, 1),
                              "length_px": round(length_px, 1)},
            "modes": a.modes,
            "measured": m,
            "u": [round(float(v), 4) for v in u],
            "frames": [[round(float(v), 5) for v in row] for row in Dl],
        },
    }
    if a.out:
        with open(a.out, "w") as f:
            json.dump(sw, f)
        print(f"wrote {a.out}  ({len(json.dumps(sw))} bytes, "
              f"{len(Dl)} frames x {a.stations} stations)")
    else:
        print("(no -o given; swatch not written)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
