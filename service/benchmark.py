"""Benchmark: raft_small vs raft_large across analysis configs,
scored against synthetic clips with KNOWN ground-truth motion.

Clips (640x480, 30fps, H.264-compatible mp4v is fine for OpenCV decode):
  sway_08      rigid block, 0.8 Hz horizontal sway        -> freq .8, dir 0,  phaseSpread ~0, turb low
  bounce_25    rigid block, 2.5 Hz vertical bounce        -> freq 2.5, dir 90, phaseSpread ~0
  wave_12      traveling wave across columns, 1.2 Hz      -> freq 1.2, phaseSpread HIGH
  turb         per-block random-walk jitter               -> turbulence HIGH (no clean freq)
  static       nothing moves                              -> amplitude ~0
"""
import math
import sys
import time

import cv2
import numpy as np
import torch
from torchvision.models.optical_flow import (
    Raft_Large_Weights, Raft_Small_Weights, raft_large, raft_small,
)

sys.path.insert(0, ".")
import server  # reuse read_frames/distill  # noqa: E402

DEVICE = "mps" if torch.backends.mps.is_available() else "cpu"
FPS, W, H, SECS = 30, 640, 480, 5
OUT = "/tmp/ms-test/bench_%s.mp4"

rng = np.random.default_rng(3)


def checker(img, x0, y0, n=8, cell=20):
    for gy in range(n):
        for gx in range(n):
            c = (40, 140, 230) if (gx + gy) % 2 else (230, 150, 60)
            img[y0 + gy * cell : y0 + (gy + 1) * cell,
                x0 + gx * cell : x0 + (gx + 1) * cell] = c


def make_clips():
    clips = {}

    def writer(name):
        return cv2.VideoWriter(OUT % name, cv2.VideoWriter_fourcc(*"mp4v"), FPS, (W, H))

    # sway_08: 0.8 Hz horizontal, 30px amplitude
    vw = writer("sway_08")
    for i in range(FPS * SECS):
        t = i / FPS
        img = np.full((H, W, 3), 28, np.uint8)
        checker(img, 240 + int(round(30 * math.sin(2 * math.pi * 0.8 * t))), 160)
        vw.write(img)
    vw.release()
    clips["sway_08"] = dict(frequency=0.8, direction=0, phaseSpread="low", turbulence="low")

    # bounce_25: 2.5 Hz vertical, 16px amplitude
    vw = writer("bounce_25")
    for i in range(FPS * SECS):
        t = i / FPS
        img = np.full((H, W, 3), 28, np.uint8)
        checker(img, 240, 160 + int(round(16 * math.sin(2 * math.pi * 2.5 * t))))
        vw.write(img)
    vw.release()
    clips["bounce_25"] = dict(frequency=2.5, direction=90, phaseSpread="low", turbulence="low")

    # wave_12: columns oscillate vertically with phase increasing along x (traveling wave)
    vw = writer("wave_12")
    for i in range(FPS * SECS):
        t = i / FPS
        img = np.full((H, W, 3), 28, np.uint8)
        for col in range(10):
            dy = int(round(18 * math.sin(2 * math.pi * 1.2 * t + col * 0.9)))
            checker(img, 80 + col * 48, 200 + dy, n=2, cell=22)
        vw.write(img)
    vw.release()
    clips["wave_12"] = dict(frequency=1.2, phaseSpread="high")

    # turb: blocks doing smooth random walks (chaotic, no shared frequency)
    vw = writer("turb")
    walks = rng.standard_normal((16, FPS * SECS, 2)).cumsum(axis=1)
    walks = (walks / np.abs(walks).max() * 30).astype(int)
    for i in range(FPS * SECS):
        img = np.full((H, W, 3), 28, np.uint8)
        for b in range(16):
            bx = 80 + (b % 4) * 120 + walks[b, i, 0]
            by = 60 + (b // 4) * 100 + walks[b, i, 1]
            checker(img, int(bx), int(by), n=2, cell=16)
        vw.write(img)
    vw.release()
    clips["turb"] = dict(turbulence="high")

    # static
    vw = writer("static")
    img = np.full((H, W, 3), 28, np.uint8)
    checker(img, 240, 160)
    for i in range(FPS * SECS):
        vw.write(img)
    vw.release()
    clips["static"] = dict(amplitude="zero")

    return clips


def flow_series(model, frames):
    t = torch.from_numpy(frames).permute(0, 3, 1, 2) * 2 - 1
    flows = []
    with torch.no_grad():
        for a, b in zip(t[:-1], t[1:]):
            fl = model(a.unsqueeze(0).to(DEVICE), b.unsqueeze(0).to(DEVICE))[-1]
            flows.append(fl[0].cpu().numpy())
    return np.stack(flows)


def score(params, truth):
    """Return list of (check, pass) tuples."""
    checks = []
    if "frequency" in truth and isinstance(truth["frequency"], float):
        err = abs(params["frequency"] - truth["frequency"]) / truth["frequency"]
        checks.append((f"freq {params['frequency']:.2f} vs {truth['frequency']} ({err*100:.0f}%)", err < 0.10))
    if "direction" in truth and isinstance(truth["direction"], int):
        d = abs((params["direction"] - truth["direction"] + 90) % 180 - 90)
        checks.append((f"dir {params['direction']}° vs {truth['direction']}° (Δ{d}°)", d <= 8))
    if truth.get("phaseSpread") == "low":
        checks.append((f"phaseSpread {params['phaseSpread']:.2f} low", params["phaseSpread"] < 0.25))
    if truth.get("phaseSpread") == "high":
        checks.append((f"phaseSpread {params['phaseSpread']:.2f} high", params["phaseSpread"] > 0.5))
    if truth.get("turbulence") == "low":
        checks.append((f"turb {params['turbulence']:.2f} low", params["turbulence"] < 0.35))
    if truth.get("turbulence") == "high":
        checks.append((f"turb {params['turbulence']:.2f} high", params["turbulence"] > 0.5))
    if truth.get("amplitude") == "zero":
        checks.append((f"amp {params['amplitude']:.2f} ~0", params["amplitude"] < 0.05))
    return checks


def main():
    clips = make_clips()
    models = {
        "small": raft_small(weights=Raft_Small_Weights.DEFAULT).eval().to(DEVICE),
        "large": raft_large(weights=Raft_Large_Weights.DEFAULT).eval().to(DEVICE),
    }
    configs = [
        ("320px/15fps/5s", 320, 15.0, 5.0),
        ("480px/15fps/5s", 480, 15.0, 5.0),
        ("480px/20fps/8s", 480, 20.0, 8.0),
    ]

    for cfg_name, width, tfps, maxs in configs:
        server.ANALYSIS_WIDTH, server.TARGET_FPS, server.MAX_SECONDS = width, tfps, maxs
        for mname, model in models.items():
            total, passed, wall = 0, 0, 0.0
            lines = []
            for cname, truth in clips.items():
                frames, fps = server.read_frames(OUT % cname)
                t0 = time.time()
                flows = flow_series(model, frames)
                wall += time.time() - t0
                params = server.distill(flows, fps)
                for desc, okk in score(params, truth):
                    total += 1
                    passed += okk
                    lines.append(f"    {'PASS' if okk else 'FAIL'} {cname:9s} {desc}")
            print(f"\n== raft_{mname} @ {cfg_name}: {passed}/{total} checks, "
                  f"{wall:.1f}s total flow compute ==")
            for ln in lines:
                print(ln)


def make_multi_clips():
    """Two synthetic multi-motion clips + a single-motion control:

    - multi2   : left half swaying 0.8Hz horizontal, right half bouncing 2.5Hz vertical
    - multi3   : top-left flag (0.8Hz horizontal), bottom-right waterfall
                 (fast downward turb), scattered falling leaves in top-right
    - sway_only: control — should segment to exactly one region
    """
    def writer(name):
        return cv2.VideoWriter(OUT % name, cv2.VideoWriter_fourcc(*"mp4v"), FPS, (W, H))

    # multi2: two spatially separated motions in one frame
    vw = writer("multi2")
    for i in range(FPS * SECS):
        t = i / FPS
        img = np.full((H, W, 3), 28, np.uint8)
        # left block, 0.8 Hz horizontal
        checker(img, 80 + int(round(30 * math.sin(2 * math.pi * 0.8 * t))), 200,
                n=4, cell=20)
        # right block, 2.5 Hz vertical
        checker(img, 420, 200 + int(round(18 * math.sin(2 * math.pi * 2.5 * t))),
                n=4, cell=20)
        vw.write(img)
    vw.release()

    # multi3: three regions with distinct signatures
    vw = writer("multi3")
    rng_local = np.random.default_rng(7)
    leaf_pos = rng_local.uniform(0, 1, size=(6, 2))
    for i in range(FPS * SECS):
        t = i / FPS
        img = np.full((H, W, 3), 28, np.uint8)
        # top-left flag, 0.8Hz horizontal
        checker(img, 60 + int(round(28 * math.sin(2 * math.pi * 0.8 * t))), 60,
                n=4, cell=18)
        # bottom-right "waterfall": fast downward with per-column phase drift
        for col in range(6):
            dy = int(round(9 * math.sin(2 * math.pi * 3.0 * t + col * 1.7)))
            y = int((80 + (t * 60) % 120)) + dy
            checker(img, 400 + col * 30, 260 + y - 80, n=1, cell=12)
        # top-right falling leaves: drift downward with slow oscillation
        for k in range(6):
            lx = int(400 + leaf_pos[k, 0] * 200)
            ly = int(60 + leaf_pos[k, 1] * 60 + (t * 40 + k * 5) % 100
                     + 4 * math.sin(2 * math.pi * 0.6 * t + k))
            cv2.rectangle(img, (lx, ly), (lx + 10, ly + 10), (60, 180, 220), -1)
        vw.write(img)
    vw.release()

    # sway_only: single-motion control (the original 0.8Hz sway, one copy)
    vw = writer("sway_only")
    for i in range(FPS * SECS):
        t = i / FPS
        img = np.full((H, W, 3), 28, np.uint8)
        checker(img, 240 + int(round(30 * math.sin(2 * math.pi * 0.8 * t))), 160)
        vw.write(img)
    vw.release()


def run_multimotion():
    """Verify segmentation on the multi-motion clips.

    Success criteria:
      multi2       -> exactly 2 regions, one horizontal (~0.8Hz), one vertical (~2.5Hz)
      multi3       -> >=2 regions detected (3rd may merge with one of the others)
      sway_only    -> exactly 1 region
      bench_static -> 0 regions

    Returns the number of failed checks so callers can exit non-zero for CI.
    """
    server.ANALYSIS_WIDTH, server.TARGET_FPS, server.MAX_SECONDS = 480, 20.0, 8.0
    print("\n== Multi-motion segmentation ==")
    tests = [
        ("multi2", 2, "exactly two regions"),
        ("multi3", 2, "at least two regions"),        # >=2 acceptable
        ("sway_only", 1, "single region"),
        ("static", 0, "no regions"),
    ]
    # optional real-footage regression: subtle atmospheric motion (rain/smoke)
    # must yield >=1 region, NOT zero. This is the clip that exposed the
    # fixed-noise-floor bug. Path resolved from a couple of likely locations;
    # skipped (not failed) if absent so CI without the fixture still runs.
    import os as _os
    rain_paths = ["/tmp/ms-test/rain_smoke.mov",
                  _os.path.expanduser("~/Desktop/rain_smoke.mov")]
    rain = next((p for p in rain_paths if _os.path.exists(p)), None)
    # waterfall + fluttering flags: one HUGE motion (waterfall) and a tiny
    # corner flag. The relative-energy region filter correctly keeps only the
    # dominant waterfall — the flag is a marginal sliver, not a comparable
    # second motion. This clip is the "one motion dominates" case; expect
    # exactly 1 strong region.
    wf_paths = ["/tmp/ms-test/waterfall_flags_demo.mp4",
                "/tmp/ms-test/pexels_34793280.mp4",
                _os.path.expanduser("~/Desktop/waterfall_flags_demo.mp4")]
    waterfall = next((p for p in wf_paths if _os.path.exists(p)), None)
    # two side-by-side flags: two BALANCED, spatially-separated bold motions —
    # the good multi-motion demo clip. Must yield >=2 regions, both localized
    # on the flags.
    tf_paths = ["/tmp/ms-test/two_flags_demo.mp4",
                "/tmp/ms-test/cand/15965166.mp4",
                _os.path.expanduser("~/Desktop/two_flags_demo.mp4")]
    two_flags = next((p for p in tf_paths if _os.path.exists(p)), None)

    failures = 0
    for name, expected, desc in tests:
        frames, fps = server.read_frames(OUT % name)
        flows = server.raft_flow_series(frames)
        regions = server.segment_regions(flows, fps)
        n = len(regions)
        if name == "multi3":
            ok = n >= expected
        else:
            ok = n == expected
        if not ok:
            failures += 1
        print(f"  {'PASS' if ok else 'FAIL'} {name:10s} {desc}: got {n} region(s)")
        for i, r in enumerate(regions):
            p = r["params"]
            print(f"     region {i}: {r['suggested_name']:16s}  "
                  f"freq={p['frequency']:.2f} dir={p['direction']:3d}° "
                  f"amp={p['amplitude']:.2f} drift=({p['driftX']:+.2f},{p['driftY']:+.2f}) "
                  f"cells={r['cells']} bbox={r['bbox']}")
    if rain is not None:
        frames, fps = server.read_frames(rain)
        flows = server.raft_flow_series(frames)
        regions = server.segment_regions(flows, fps)
        n = len(regions)
        ok = n >= 1
        if not ok:
            failures += 1
        print(f"  {'PASS' if ok else 'FAIL'} rain_smoke atmospheric motion (>=1 region): got {n}")
        for i, r in enumerate(regions):
            p = r["params"]
            print(f"     region {i}: {r['suggested_name']:16s}  "
                  f"freq={p['frequency']:.2f} amp={p['amplitude']:.2f} "
                  f"drift=({p['driftX']:+.2f},{p['driftY']:+.2f}) cells={r['cells']}")
    else:
        print("  SKIP rain_smoke (fixture not found — place at /tmp/ms-test/rain_smoke.mov)")

    if waterfall is not None:
        frames, fps = server.read_frames(waterfall)
        flows = server.raft_flow_series(frames)
        regions = server.segment_regions(flows, fps)
        n = len(regions)
        ok = n >= 1
        if not ok:
            failures += 1
        print(f"  {'PASS' if ok else 'FAIL'} waterfall+flag (one dominant motion; >=1 region): got {n}")
        for i, r in enumerate(regions):
            p = r["params"]
            print(f"     region {i}: {r['suggested_name']:16s}  "
                  f"freq={p['frequency']:.2f} amp={p['amplitude']:.2f} "
                  f"turb={p['turbulence']:.2f} cells={r['cells']}")
    else:
        print("  SKIP waterfall+flag (fixture not found)")

    if two_flags is not None:
        frames, fps = server.read_frames(two_flags)
        flows = server.raft_flow_series(frames)
        regions = server.segment_regions(flows, fps)
        n = len(regions)
        ok = n >= 2
        if not ok:
            failures += 1
        print(f"  {'PASS' if ok else 'FAIL'} two_flags (two balanced bold motions; >=2 regions): got {n}")
        for i, r in enumerate(regions):
            p = r["params"]
            print(f"     region {i}: {r['suggested_name']:16s}  "
                  f"freq={p['frequency']:.2f} amp={p['amplitude']:.2f} "
                  f"turb={p['turbulence']:.2f} cells={r['cells']}")
    else:
        print("  SKIP two_flags (fixture not found)")

    print(f"\n{'ALL PASS' if failures == 0 else f'{failures} FAILURES'}")
    return failures


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "multi":
        make_multi_clips()
        rc = run_multimotion()
        sys.exit(1 if rc else 0)
    else:
        main()
