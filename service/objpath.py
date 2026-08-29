"""MotionLife Step 5 — Backend C: one discrete object TRAVELLING across the scene.

Turns yolo_bytetrack's raw per-frame track (the longest ByteTrack track, already
normalized to [0,1] by the extractor) into a clean travel path the JS `path_travel`
applicator can follow:

  raw [[t, cx, cy, w, h, label], ...]  ->  {label, points: [[t, x, y], ...], travel: {...}}

Three things the raw track can't be used for directly, and what this does about them:
  * GAPS — the detector misses frames (occlusion, motion blur), so t is not contiguous.
    Linearly interpolated onto every frame in [t0, tN], so the applicator can index by
    frame without carrying its own resampler.
  * JITTER — box centroids wobble by a pixel or two even on a smoothly moving object,
    which reads as vibration when it drives artwork. Smoothed with a centred moving
    average that PINS the endpoints (a smoother that pulls the first/last point inward
    would shorten the travel, and travel distance is the whole point of this backend).
  * ABSOLUTE vs RELATIVE — artwork is a different size and the object starts somewhere
    else on the canvas, so `points` are offsets from the object's OWN start position,
    not video coordinates. The applicator scales them by the object's on-canvas room.

`travel.straightness` (0..1) lets the applicator choose its behaviour honestly: ~1.0 is a
straight drift it can apply as a plain translation; well below 1 means the object curved
or reversed and the full point list should be followed.

No detection and no track is a legitimate outcome — build_path returns (None, warnings)
and the caller reports that rather than inventing a path.
"""
MIN_POINTS = 6          # shorter than this is a detector blip, not a travel path
SMOOTH_WIN = 5          # frames; centred, endpoint-pinned
FILLS_FRAME = 0.6       # a tracked box wider/taller than this is the scene, not an object


def _interpolate(pts):
    """[[t,x,y,w,h]...] sparse -> one entry per integer frame in [t0, tN]."""
    out = []
    for i, p in enumerate(pts[:-1]):
        nxt = pts[i + 1]
        out.append(p)
        gap = int(nxt[0]) - int(p[0])
        for k in range(1, gap):                      # fill t+1 .. next-1
            f = k / gap
            out.append([int(p[0]) + k] + [p[j] + (nxt[j] - p[j]) * f for j in range(1, 5)])
    out.append(pts[-1])
    return out


def _smooth(vals, win=SMOOTH_WIN):
    """Centred moving average with pinned endpoints (see the module note on travel)."""
    n = len(vals)
    if n <= 2 or win < 3:
        return list(vals)
    half = win // 2
    out = []
    for i in range(n):
        # shrink the window near the edges instead of clamping, which would drag the
        # first/last samples toward the interior and eat real travel distance
        r = min(half, i, n - 1 - i)
        out.append(sum(vals[i - r:i + r + 1]) / (2 * r + 1) if r else vals[i])
    return out


def build_path(raw, fps, total_frames=None):
    """Clean travel path from a raw yolo_bytetrack track. Returns (contract, warnings).

    contract = {label, frames, fps, start: [x,y], size: [w,h],
                points: [[t, dx, dy], ...],          # offsets from start, normalized
                travel: {dx, dy, span_x, span_y, dist, straightness},
                confidence}
    """
    warnings = []
    if not raw:
        return None, ["no object was detected and tracked, so there is no travel path"]
    pts = sorted(([int(r[0])] + [float(v) for v in r[1:5]] for r in raw), key=lambda p: p[0])
    label = str(raw[0][5]) if len(raw[0]) > 5 else "object"
    if len(pts) < MIN_POINTS:
        return None, [f"tracked '{label}' for only {len(pts)} frame(s) "
                      f"(need {MIN_POINTS}); no usable travel path"]

    dense = _interpolate(pts)
    filled = len(dense) - len(pts)
    if filled:
        warnings.append(f"interpolated {filled} frame(s) the detector missed "
                        f"across the '{label}' track")

    xs = _smooth([p[1] for p in dense])
    ys = _smooth([p[2] for p in dense])
    x0, y0 = xs[0], ys[0]
    points = [[int(dense[i][0]), round(xs[i] - x0, 5), round(ys[i] - y0, 5)]
              for i in range(len(dense))]

    dx, dy = xs[-1] - x0, ys[-1] - y0
    dist = sum(((xs[i] - xs[i - 1]) ** 2 + (ys[i] - ys[i - 1]) ** 2) ** 0.5
               for i in range(1, len(xs)))
    net = (dx * dx + dy * dy) ** 0.5
    travel = {
        "dx": round(dx, 5), "dy": round(dy, 5),
        "span_x": round(max(xs) - min(xs), 5), "span_y": round(max(ys) - min(ys), 5),
        "dist": round(dist, 5),
        # 1.0 = straight line; low = curved, wandering, or it doubled back
        "straightness": round(net / dist, 4) if dist > 1e-6 else 0.0,
    }
    if net < 0.02:
        warnings.append(f"'{label}' moved {net:.3f} of the frame end-to-end — it is "
                        "hovering rather than travelling; oscillation may fit better")

    mw = sum(p[3] for p in dense) / len(dense)
    mh = sum(p[4] for p in dense) / len(dense)
    if max(mw, mh) > FILLS_FRAME:
        # measured on boat-night.mp4: a 0.92 x 0.18 box labelled "boat" at every threshold.
        # A box this wide is the scene, not a discrete object, so its centroid drift is not
        # travel — say so instead of handing back a path that will slide the whole artwork.
        warnings.append(f"the tracked '{label}' box covers {mw:.2f}x{mh:.2f} of the frame — "
                        "that is scene-sized, not a discrete object; treat this path as "
                        "unreliable (rigid_path may be the wrong class for this clip)")

    # confidence = how much of the analyzed clip this one object was actually tracked for
    conf = round(len(pts) / float(total_frames), 3) if total_frames else None
    if conf is not None and conf < 0.5:
        warnings.append(f"'{label}' was tracked for only {conf:.0%} of the clip; "
                        "the path may be a fragment of its full travel")

    return {
        "label": label,
        "frames": len(points),
        "fps": round(float(fps), 2),
        "start": [round(x0, 5), round(y0, 5)],
        "size": [round(sum(p[3] for p in dense) / len(dense), 5),
                 round(sum(p[4] for p in dense) / len(dense), 5)],
        "points": points,
        "travel": travel,
        "confidence": conf,
    }, warnings
