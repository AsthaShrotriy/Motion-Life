"""Preprocess a clip region from the CLI and write the mask overlay (verifies Step 2).

  routervenv/bin/python service/preprocess_cli.py assets/videos/flag.mp4 0,0,0.5,1 [cloth]

Prints the region_preprocess JSON and writes an alpha-blended mask+bbox overlay PNG
to /tmp/ms-<name>-overlay.png — the Step-2 done-when ("verify by overlay": the mask
should hug the moving object and exclude the background).
"""
import sys
import os
import json

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cv2
import preprocess as P


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("usage: preprocess_cli.py <video> <x,y,w,h normalized> [class]", file=sys.stderr)
        sys.exit(2)
    path = sys.argv[1]
    bbox = [float(v) for v in sys.argv[2].split(",")][:4]
    cls = sys.argv[3] if len(sys.argv) > 3 else ""
    contract, warnings, viz = P.preprocess(path, bbox, "m1", cls)

    # round-trip check: RLE decodes back to the same mask
    if contract.get("mask"):
        m = contract["mask"]
        dec = P.decode_mask_rle(m["data"], m["w"], m["h"])
        if viz is not None:
            same = bool((dec.astype(bool) == (viz["mask"] > 0)).all())
            print(f"[cli] RLE round-trip exact: {same}", file=sys.stderr)

    if viz is not None:
        out = P.overlay(viz["frame"], viz["mask"], viz["box"])
        name = os.path.splitext(os.path.basename(path))[0]
        dest = f"/tmp/ms-{name}-overlay.png"
        cv2.imwrite(dest, out)
        print(f"[cli] overlay written: {dest}", file=sys.stderr)

    # print contract without the big RLE array for readability
    slim = dict(contract)
    if slim.get("mask"):
        mm = dict(slim["mask"]); mm["data"] = f"<{len(slim['mask']['data'])} RLE runs>"
        slim["mask"] = mm
    if slim.get("camera") and slim["camera"].get("per_frame"):
        cam = dict(slim["camera"]); cam["per_frame"] = f"<{len(cam['per_frame'])} matrices>"
        slim["camera"] = cam
    print(json.dumps(slim, indent=2))
