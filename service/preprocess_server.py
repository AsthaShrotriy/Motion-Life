"""Preprocess service — Step 2 of docs/BUILD_PLAN.md.

Turns one Contract-A motion (a rough bbox) into a clean object mask + camera motion.

  POST /preprocess?motion_id=m1&class=cloth&bbox=0.1,0.2,0.3,0.4
     raw video bytes in the body (bbox = normalized x,y,w,h, matching Contract A)
     -> region_preprocess JSON (see service/contracts.py)
  GET  /   health

Stdlib HTTP server (cv2+numpy only, no torch, no downloads). Mirrors pose_server.py
(:8770) and vlm_router.py (:8771). Run with the router venv:
  routervenv/bin/python service/preprocess_server.py    # :8772
"""
import os
import sys
import math
import json
import tempfile
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import preprocess as P

PORT = int(os.environ.get("PREPROCESS_PORT", "8772"))
CHUNK = 1 << 20   # stream the upload 1MB at a time (don't buffer a 700MB clip in RAM)


def _parse_bbox(s):
    try:
        parts = [float(v) for v in s.split(",")]
    except (ValueError, AttributeError):
        return None
    if len(parts) >= 4 and all(math.isfinite(v) for v in parts[:4]):
        return parts[:4]
    return None


class H(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code); self._cors()
        self.send_header("Content-Type", "application/json"); self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.end_headers()

    def do_GET(self):
        self._json(200, {"ok": True, "service": "preprocess", "engine": P.ENGINE, "port": PORT})

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path != "/preprocess":
            self._json(404, {"error": "POST /preprocess?motion_id=&class=&bbox=x,y,w,h"}); return
        q = parse_qs(parsed.query)
        motion_id = (q.get("motion_id", [""])[0])
        cls = (q.get("class", [""])[0])
        bbox = _parse_bbox(q.get("bbox", ["0,0,1,1"])[0]) or [0, 0, 1, 1]
        # ?depth=1 adds Depth Anything V2 facts (needs torch+transformers in THIS venv;
        # routervenv is OpenCV-only, so the contract just carries a warning there)
        want_depth = q.get("depth", ["0"])[0] not in ("", "0", "false")
        n = int(self.headers.get("Content-Length", "0"))
        tf = tempfile.NamedTemporaryFile(suffix=".mp4", delete=False)
        remaining = n
        while remaining > 0:                       # stream to disk in chunks
            chunk = self.rfile.read(min(CHUNK, remaining))
            if not chunk:
                break
            tf.write(chunk); remaining -= len(chunk)
        tf.close()
        try:
            print(f"[preprocess] {n//1024} KB clip, motion={motion_id} class={cls} bbox={bbox}",
                  file=sys.stderr)
            contract, warnings, _ = P.preprocess(tf.name, bbox, motion_id, cls,
                                                 want_depth=want_depth)
            cam = contract["camera"]
            cov = (contract["mask"] or {}).get("coverage")
            dep = contract.get("depth") or {}
            print(f"[preprocess] static_cam={cam['is_static']} residual={cam['residual_px']}px "
                  f"coverage={cov}"
                  + (f" depth_rank={dep.get('rank')}" if dep else ""), file=sys.stderr)
            self._json(200, contract)
        except Exception as e:
            print(f"[preprocess] error: {e}", file=sys.stderr)
            self._json(500, {"error": str(e)})
        finally:
            os.unlink(tf.name)

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    print(f"preprocess_server on http://127.0.0.1:{PORT}  (POST /preprocess with video bytes)",
          file=sys.stderr)
    HTTPServer(("127.0.0.1", PORT), H).serve_forever()
