#!/usr/bin/env python3
"""clip_stride.py — is a clip's walk actually EXTRACTABLE as in-plane leg crossing?

The limb rig rotates a thigh about the hip in the image plane. A walk only reads as a walk
if the two thighs swing in ANTIPHASE and swing far enough that the legs pass each other on
screen. A 2D pose capture of someone walking AWAY from the camera has neither: the legs pass
in DEPTH, and the projected fore-aft swing collapses to almost nothing. That is a property of
the CLIP, not of the applicator, so measure it before blaming the code.

Reports, per clip:
  antiphase corr   thigh-l vs thigh-r delta-from-rest. -1 = perfect alternation, +1 = both
                   legs swinging together (nothing to see), 0 = no relationship.
  in-plane swing   peak-to-peak of each thigh's projected angle. This is the amplitude the
                   rig gets to work with; a side-on walk gives 60-80deg, a receding one ~25.
  knee-x flips     how often l_knee crosses to the other side of r_knee IN THE SOURCE. This
                   is crossing, measured directly. A side-on walk flips twice per stride.
  ankle-x flips    the same at the ANKLE, which is where a receding walk still crosses: on
                   walk-man.mp4 the knees flip twice and the ankles six times. Reading only
                   the knee is how "this clip has no crossing" was once concluded wrongly.
  ankle-y flips    the vertical stride, which survives projection even when crossing doesn't.
  hip-x median     which side the subject's anatomical left hip sits on. Its SIGN is the
                   capture's facing, which _applyLimbs compares with the artwork's.
  scale drift      shoulder span max/min. >1.3 means the subject is walking toward or away
                   from the camera, i.e. the stride is going into depth.

Usage:
  python3 tests/clip_stride.py assets/motion/walk-man-extracted.json [more.json ...]
  # to make a fresh one first (pose service on :8770):
  curl -s -X POST --data-binary @assets/videos/dance.mp4 \
       "http://127.0.0.1:8770/extract?kind=pose&fmt=b" > /tmp/dance.json
"""
import json
import math
import sys

VIS = 0.5        # LIMB_VIS_OK in js/animate.js
FORE = 0.6       # LIMB_FORESHORTEN


def load(path):
    d = json.load(open(path))
    p = d.get("pose") or d
    return p["joints"], p["frames"], p.get("fps", 15)


def track(joints, frames, a, b):
    """Reproduce _applyLimbs' per-frame delta-from-rest for one bone."""
    jn = {n: i for i, n in enumerate(joints)}
    if a not in jn or b not in jn:
        return None, 0
    angs, lens = [], []
    for f in frames:
        A, B = f[jn[a]], f[jn[b]]
        if len(A) < 3 or len(B) < 3 or A[2] < VIS or B[2] < VIS:
            angs.append(None)
            lens.append(None)
            continue
        dx, dy = B[0] - A[0], B[1] - A[1]
        angs.append(math.atan2(dy, dx))
        lens.append(math.hypot(dx, dy))
    seen = sorted(v for v in lens if v is not None)
    med = seen[len(seen) // 2] if seen else 0
    ok = [L is not None and L >= FORE * med and angs[i] is not None
          for i, L in enumerate(lens)]
    if not any(ok):
        return None, 0
    sx = sum(math.cos(angs[i]) for i in range(len(angs)) if ok[i])
    sy = sum(math.sin(angs[i]) for i in range(len(angs)) if ok[i])
    rest = math.atan2(sy, sx)
    out, held = [], 0.0
    for i in range(len(angs)):
        if ok[i]:
            held = ((math.degrees(angs[i] - rest) + 180) % 360) - 180
        out.append(held)
    return out, sum(ok)


def corr(a, b):
    n = min(len(a), len(b))
    a, b = a[:n], b[:n]
    ma, mb = sum(a) / n, sum(b) / n
    va = sum((x - ma) ** 2 for x in a)
    vb = sum((y - mb) ** 2 for y in b)
    if va == 0 or vb == 0:
        return float("nan")
    return sum((a[i] - ma) * (b[i] - mb) for i in range(n)) / math.sqrt(va * vb)


def flips(vals):
    return sum(1 for i in range(1, len(vals)) if (vals[i] > 0) != (vals[i - 1] > 0))


def report(path):
    joints, frames, fps = load(path)
    jn = {n: i for i, n in enumerate(joints)}
    tl, nl = track(joints, frames, "l_hip", "l_knee")
    tr, nr = track(joints, frames, "r_hip", "r_knee")
    n = len(frames)
    print(f"\n{path}")
    print(f"  {n} frames @ {fps}fps ({n / fps:.1f}s), {len(joints)} joints")
    if tl is None or tr is None:
        print("  NO USABLE THIGH: "
              f"leg-l {nl}/{n} frames, leg-r {nr}/{n} — nothing for the rig to rotate")
        return
    swl, swr = max(tl) - min(tl), max(tr) - min(tr)
    c = corr(tl, tr)
    # the same correlation at the best time-shift: a real walk is antiphase, but a capture
    # can sit at any point in the cycle, so an unlagged corr near 0 is not proof of nothing.
    best = min(range(-n // 4, n // 4 + 1), key=lambda k: corr(tl, tr[k:] + tr[:k]))
    cbest = corr(tl, tr[best:] + tr[:best])
    # believed frames only, same gate the rig uses, so these counts match what it sees
    def gap(a, b, axis):
        if a not in jn or b not in jn:
            return []
        out = []
        for f in frames:
            A, B = f[jn[a]], f[jn[b]]
            if len(A) > 2 and len(B) > 2 and min(A[2], B[2]) >= VIS:
                out.append(A[axis] - B[axis])
        return out

    kdx = gap("l_knee", "r_knee", 0)
    adx = gap("l_ank", "r_ank", 0)
    ady = gap("l_ank", "r_ank", 1)
    hdx = gap("l_hip", "r_hip", 0)
    sho = [abs(f[jn["l_sho"]][0] - f[jn["r_sho"]][0]) for f in frames]
    drift = max(sho) / min(sho) if min(sho) > 0 else float("inf")
    print(f"  usable thighs    leg-l {nl}/{n}   leg-r {nr}/{n}")
    print(f"  in-plane swing   leg-l {swl:5.1f}deg   leg-r {swr:5.1f}deg")
    print(f"  antiphase corr   {c:+.3f}   (best lag {best:+d}f -> {cbest:+.3f})")
    print(f"  knee-x flips     {flips(kdx):3d}   span {min(kdx):+.3f}..{max(kdx):+.3f}"
          "   <- crossing, in the source")
    if adx:
        print(f"  ankle-x flips    {flips(adx):3d}   span {min(adx):+.3f}..{max(adx):+.3f}"
              "   <- crossing, at the foot")
    if ady:
        print(f"  ankle-y flips    {flips(ady):3d}   span {min(ady):+.3f}..{max(ady):+.3f}")
    if hdx:
        med = sorted(hdx)[len(hdx) // 2]
        print(f"  hip-x median     {med:+.3f}   <- subject's left hip is at "
              + ("LOWER" if med < 0 else "HIGHER") + " x (facing)")
    print(f"  scale drift      {drift:.2f}x shoulder span"
          + ("   <- walking into/out of depth" if drift > 1.3 else ""))
    verdict = []
    if cbest > -0.4:
        verdict.append("legs do not alternate")
    if max(swl, swr) < 35:
        verdict.append(f"swing too small ({max(swl, swr):.0f}deg; want 50+)")
    # judge crossing on the best evidence available, not on the knee alone — the knee is the
    # first joint to lose a receding stride to depth while the foot still swaps sides.
    cross = max(flips(kdx), flips(adx) if adx else 0)
    if cross < 4:
        verdict.append(f"legs barely cross in the source ({cross} flips)")
    print("  VERDICT          " + ("; ".join(verdict) if verdict
                                   else "good: alternating, wide, and crossing"))


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    for p in sys.argv[1:]:
        report(p)
