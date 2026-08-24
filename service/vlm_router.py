"""VLM Router — Step 1 of docs/BUILD_PLAN.md.

Given a clip, return EVERY distinct motion in it with a class, bbox and confidence
(Contract A). This is the perception step that retires filename / layer-name guessing.

  POST /decompose   raw video bytes in the body
     -> { version, clip:{w,h,fps,frames_sampled}, static, motions:[
            { id, label, class, bbox:[x,y,w,h] (0-1), confidence, backend, applicator, notes } ] }
  GET  /            health

How it works: sample N evenly-spaced frames, downscale, and hand them to Claude
(vision) with a fixed rubric + the 6-class taxonomy from contracts.py. Claude is
forced to call one tool (report_motions) so the output is strict JSON, which we then
validate/normalize through contracts.normalize_decomposition.

Two ways to reach Claude (auto-detected):
  * Amazon Bedrock (default when CLAUDE_CODE_USE_BEDROCK=1 or ROUTER_USE_BEDROCK=1) —
    uses the standard AWS credential chain, no API key needed:
      routervenv/bin/python service/vlm_router.py    # :8771
  * Direct Anthropic API:
      ANTHROPIC_API_KEY=sk-... ROUTER_USE_BEDROCK=0 routervenv/bin/python service/vlm_router.py
"""
import os, sys, json, base64, tempfile
from http.server import BaseHTTPRequestHandler, HTTPServer

import cv2
import anthropic

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import contracts


def _load_dotenv():
    """Load repo-root .env (gitignored) so secrets like ANTHROPIC_API_KEY or
    AWS_BEARER_TOKEN_BEDROCK can live in a file instead of the shell. Never overrides
    an already-set env var. stdlib-only (no python-dotenv dependency)."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env")
    try:
        with open(path) as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    except FileNotFoundError:
        pass


_load_dotenv()

PORT = int(os.environ.get("ROUTER_PORT", "8771"))
N_FRAMES = int(os.environ.get("ROUTER_FRAMES", "8"))
MAX_W = 512                       # downscale width sent to the VLM (cost/latency)
CONF_MIN = float(os.environ.get("ROUTER_CONF_MIN", "0.35"))  # drop hallucinated motions

# ── Backend selection: real Anthropic key wins, else Bedrock (default in this env) ──
def _real_key():
    """A usable ANTHROPIC_API_KEY (not the .env.example placeholder)."""
    k = os.environ.get("ANTHROPIC_API_KEY", "")
    return k if (k and "REPLACE" not in k and not k.endswith("...")) else ""


def _use_bedrock():
    v = os.environ.get("ROUTER_USE_BEDROCK")
    if v is not None:
        return v not in ("0", "false", "no", "")
    if os.environ.get("AWS_BEARER_TOKEN_BEDROCK"):
        return True                                         # Bedrock API key -> Bedrock
    if _real_key():
        return False                                        # explicit key -> direct API
    return os.environ.get("CLAUDE_CODE_USE_BEDROCK") == "1"  # else inherit the CC setting

USE_BEDROCK = _use_bedrock()
AWS_REGION = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "us-west-2"
# Bedrock model ids are region-scoped inference profiles; the direct API uses the plain id.
MODEL = os.environ.get("ROUTER_MODEL") or (
    "global.anthropic.claude-opus-4-8" if USE_BEDROCK else "claude-opus-4-8")


def _client():
    if USE_BEDROCK:
        return anthropic.AnthropicBedrock(aws_region=AWS_REGION)   # standard AWS cred chain
    return anthropic.Anthropic()                                  # reads ANTHROPIC_API_KEY


def _auth_ready():
    """True if the selected backend has usable credentials configured."""
    if USE_BEDROCK:
        if os.environ.get("AWS_BEARER_TOKEN_BEDROCK"):
            return True                 # Bedrock API key (bearer token)
        try:
            import botocore.session
            return botocore.session.get_session().get_credentials() is not None
        except Exception:
            return False
    return bool(_real_key())

TOOL = {
    "name": "report_motions",
    "description": "Report every distinct moving element observed across the frame sequence.",
    "input_schema": {
        "type": "object",
        "properties": {
            "static": {
                "type": "boolean",
                "description": "true if nothing in the clip actually moves across the frames.",
            },
            "motions": {
                "type": "array",
                "description": "One entry per DISTINCT moving element. Empty if static.",
                "items": {
                    "type": "object",
                    "properties": {
                        "label": {"type": "string", "description": "short human name, e.g. 'waving flag'"},
                        "class": {"type": "string", "enum": list(contracts.MOTION_CLASSES.keys())},
                        "subject_type": {"type": "string", "enum": ["human", "animal", "object"],
                                         "description": "a person/body part -> human; a live creature -> animal; anything else (vehicle, flag, water, smoke, leaves) -> object. Used to route to the best extractor."},
                        "count": {"type": "string", "enum": ["one", "many"],
                                  "description": "'one' = a single instance moves; 'many' = multiple similar instances move together (a flock, crowd, falling leaves)."},
                        "bbox": {
                            "type": "array",
                            "description": "[x,y,w,h] normalized 0-1, origin top-left, tight around the moving element",
                            "items": {"type": "number"}, "minItems": 4, "maxItems": 4,
                        },
                        "confidence": {"type": "number", "description": "0-1, how sure this element truly moves"},
                        "notes": {"type": "string", "description": "one phrase: direction / speed / character of the motion"},
                    },
                    "required": ["label", "class", "bbox", "confidence"],
                },
            },
        },
        "required": ["static", "motions"],
    },
}


def _taxonomy_text():
    lines = []
    for name, spec in contracts.MOTION_CLASSES.items():
        lines.append(f"  - {name}: {spec['desc']}. e.g. {spec['examples']}.")
    return "\n".join(lines)


PROMPT = (
    "These are frames sampled in order from one short video clip. Identify EVERY distinct "
    "element that is genuinely MOVING across the frames, and classify each into exactly one "
    "of these motion classes:\n\n" + _taxonomy_text() + "\n\n"
    "Rules:\n"
    "- One entry per distinct motion. If a flag AND smoke AND birds all move, that's three entries.\n"
    "- bbox must tightly bound the moving element, normalized 0-1 (x,y = top-left).\n"
    "- If two motions overlap (e.g. smoke over a flag), still list them separately.\n"
    "- Be honest: if a region only appears to move because the camera pans, or does not move at "
    "all, do NOT list it. If nothing moves, set static=true and return an empty list.\n"
    "- confidence reflects how sure you are the element truly moves (not how sure of the class).\n"
    "- Also set subject_type (human | animal | object) and count (one | many) for each motion — "
    "e.g. a single boat = object/one; a flock of birds = animal/many; one person walking = human/one. "
    "Base these on what you actually see.\n"
    "Call report_motions with your findings."
)


def sample_frames(path, n=N_FRAMES):
    cap = cv2.VideoCapture(path)
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    fps = cap.get(cv2.CAP_PROP_FPS) or 0
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    if total <= 0:                                # some containers don't report count
        frames = []
        while True:
            ok, fr = cap.read()
            if not ok:
                break
            frames.append(fr)
        cap.release()
        if not frames:
            return [], {"width": w, "height": h, "fps": round(fps, 2), "frames_sampled": 0}
        idxs = [round(i * (len(frames) - 1) / max(1, n - 1)) for i in range(n)]
        picked = [frames[i] for i in idxs]
    else:
        idxs = [round(i * (total - 1) / max(1, n - 1)) for i in range(n)]
        picked = []
        for i in idxs:
            cap.set(cv2.CAP_PROP_POS_FRAMES, i)
            ok, fr = cap.read()
            if ok:
                picked.append(fr)
        cap.release()
    jpegs = []
    for fr in picked:
        if fr.shape[1] > MAX_W:
            scale = MAX_W / fr.shape[1]
            fr = cv2.resize(fr, (MAX_W, int(fr.shape[0] * scale)))
        ok, buf = cv2.imencode(".jpg", fr, [cv2.IMWRITE_JPEG_QUALITY, 82])
        if ok:
            jpegs.append(base64.b64encode(buf.tobytes()).decode())
    return jpegs, {"width": w, "height": h, "fps": round(fps, 2), "frames_sampled": len(jpegs)}


def decompose(path):
    jpegs, clip = sample_frames(path)
    if not jpegs:
        return contracts.empty_decomposition(clip), ["no frames could be read from the clip"]

    client = _client()
    content = [{"type": "text", "text": PROMPT}]
    for i, b64 in enumerate(jpegs):
        content.append({"type": "text", "text": f"Frame {i + 1}/{len(jpegs)}:"})
        content.append({"type": "image",
                        "source": {"type": "base64", "media_type": "image/jpeg", "data": b64}})

    msg = client.messages.create(
        model=MODEL,
        max_tokens=1024,
        tools=[TOOL],
        tool_choice={"type": "tool", "name": "report_motions"},
        messages=[{"role": "user", "content": content}],
    )
    raw = next((b.input for b in msg.content if b.type == "tool_use"), None)
    if raw is None:
        return contracts.empty_decomposition(clip), ["VLM did not return structured motions"]

    contract, warnings = contracts.normalize_decomposition(raw, clip)
    # honesty gate: drop low-confidence motions rather than invent
    kept = [m for m in contract["motions"] if m["confidence"] >= CONF_MIN]
    dropped = len(contract["motions"]) - len(kept)
    if dropped:
        warnings.append(f"dropped {dropped} motion(s) below confidence {CONF_MIN}")
    contract["motions"] = kept
    contract["static"] = len(kept) == 0
    return contract, warnings


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
        self._json(200, {"ok": True, "service": "vlm_router", "model": MODEL,
                         "backend": "bedrock" if USE_BEDROCK else "anthropic",
                         "region": AWS_REGION if USE_BEDROCK else None,
                         "classes": list(contracts.MOTION_CLASSES.keys()),
                         "auth": _auth_ready()})

    def do_POST(self):
        if self.path != "/decompose":
            self._json(404, {"error": "POST /decompose"}); return
        if not _auth_ready():
            self._json(500, {"error": ("no AWS credentials for Bedrock" if USE_BEDROCK
                                       else "ANTHROPIC_API_KEY not set on the router service")}); return
        n = int(self.headers.get("Content-Length", "0"))
        data = self.rfile.read(n)
        tf = tempfile.NamedTemporaryFile(suffix=".mp4", delete=False)
        tf.write(data); tf.close()
        try:
            print(f"[router] decomposing {len(data)//1024} KB clip…", file=sys.stderr)
            contract, warnings = decompose(tf.name)
            for w in warnings:
                print(f"[router] warn: {w}", file=sys.stderr)
            print(f"[router] {len(contract['motions'])} motion(s): "
                  + ", ".join(f"{m['class']}({m['confidence']})" for m in contract["motions"]),
                  file=sys.stderr)
            if warnings:
                contract["warnings"] = warnings
            self._json(200, contract)
        except Exception as e:
            print(f"[router] error: {e}", file=sys.stderr)
            self._json(500, {"error": str(e)})
        finally:
            os.unlink(tf.name)

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    print(f"vlm_router on http://127.0.0.1:{PORT}  (POST /decompose with video bytes)", file=sys.stderr)
    print(f"  backend={'bedrock' if USE_BEDROCK else 'anthropic'} model={MODEL}"
          + (f" region={AWS_REGION}" if USE_BEDROCK else ""), file=sys.stderr)
    if not _auth_ready():
        print("  WARNING: no credentials for the selected backend — /decompose will 500.",
              file=sys.stderr)
    HTTPServer(("127.0.0.1", PORT), H).serve_forever()
