"""Scoped validation: raft_small only (raft_large weights aren't cached here).
Runs benchmark.py's single-motion suite + multi-motion suite against server.distill/
segment_regions, printing per-check PASS/FAIL and a total. Used to prove math
changes don't regress the ground-truth score."""
import sys
import numpy as np
sys.path.insert(0, ".")
import server
import benchmark as B

DEVICE = server.DEVICE
model = server.MODEL  # raft_small, already loaded by server import


def flow_series(frames):
    return server.raft_flow_series(frames)


def run_single():
    clips = B.make_clips()
    configs = [
        ("320px/15fps/5s", 320, 15.0, 5.0),
        ("480px/15fps/5s", 480, 15.0, 5.0),
        ("480px/20fps/8s", 480, 20.0, 8.0),
    ]
    grand_pass = grand_total = 0
    for cfg_name, width, tfps, maxs in configs:
        server.ANALYSIS_WIDTH, server.TARGET_FPS, server.MAX_SECONDS = width, tfps, maxs
        total = passed = 0
        lines = []
        for cname, truth in clips.items():
            frames, fps = server.read_frames(B.OUT % cname)
            flows = server.raft_flow_series(frames)
            params = server.distill(flows, fps)
            for desc, okk in B.score(params, truth):
                total += 1
                passed += okk
                lines.append(f"    {'PASS' if okk else 'FAIL'} {cname:9s} {desc}")
        grand_pass += passed
        grand_total += total
        print(f"\n== raft_small @ {cfg_name}: {passed}/{total} ==")
        for ln in lines:
            print(ln)
    print(f"\n### SINGLE-MOTION TOTAL: {grand_pass}/{grand_total} ###")
    return grand_pass, grand_total


def run_multi():
    B.make_multi_clips()
    fails = B.run_multimotion()
    return fails


if __name__ == "__main__":
    p, t = run_single()
    f = run_multi()
    print(f"\n=== SUMMARY: single {p}/{t}, multi failures={f} ===")
