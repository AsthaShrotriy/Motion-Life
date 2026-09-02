"""VLM Router — Steps 1 and 9 of docs/BUILD_PLAN.md.

Step 1: given a clip, return EVERY distinct motion in it with a class, bbox and
confidence (Contract A). This is the perception step that retires filename /
layer-name guessing.

Step 9: given frames of the ANIMATED ARTWORK (and optionally the source clip), score
the result and say which dials to move (Contract C). Same model, same forced-tool-call
plumbing, opposite direction: /decompose looks at a video and proposes motion, /judge
looks at motion and proposes corrections.

Step 10: given the ARTWORK and its layer bboxes, say what each layer depicts and which
class of motion it would take. That is what lets an extracted swatch be auto-applied to
the right object without a regex over layer names (Contract D).

  POST /decompose    raw video bytes in the body
     -> { version, clip:{w,h,fps,frames_sampled}, static, motions:[
            { id, label, class, bbox:[x,y,w,h] (0-1), confidence, backend, applicator, notes } ] }
  POST /label        JSON { image: b64|dataURL of the artwork,
                            layers: [ {id, name, bbox:[x,y,w,h] (0-1)} ] }
     -> { version, kind:"layer_labels", art, confidence_of, labels:[
            { id, label, motion_class ("" = should not move), applicator, deforms, confidence, notes } ] }
  POST /judge        JSON { session, class, applicator, label (what the motion IS),
                            element (what it is applied TO), params:{...},
                            frames:[b64|dataURL, ...], reference:[b64, ...] (optional) }
     -> { verdict:{ verdict, score, score_of, axes, deltas, critique, observations },
          params, next_params, iteration, max_iterations, continue, reason, best, history }
     -> { stopped:true, reason } once the loop policy says stop
  POST /judge/reset  JSON { session }   start a fresh tune run
  GET  /             health, plus the judge's live limits

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
import os, sys, json, math, base64, tempfile
from http.server import BaseHTTPRequestHandler, HTTPServer

import cv2
import numpy as np
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


# ══ Step 9: the judge ═══════════════════════════════════════════════════════
# Same plumbing as /decompose — sample, force a tool call, normalize through
# contracts — but the frames come from the CLIENT (rendered artwork), not a file.
#
# The loop policy lives here rather than in the browser, so the cap and the deltas
# cannot be talked around by whatever calls it: the server owns the history, applies
# the deltas itself, and hands back the next params plus its own stop/continue
# decision. A caller that invents a fresh session id does get a fresh budget — this
# is a cost guard against a runaway loop, not a security boundary, and there is no
# durable state to protect.
JUDGE_MAX_FRAMES = int(os.environ.get("JUDGE_FRAMES", "8"))
JUDGE_SESSIONS = {}          # session id -> [verdict, ...]
JUDGE_SESSION_CAP = 64       # bound the dict; oldest sessions are evicted

JUDGE_TOOL = {
    "name": "report_verdict",
    "description": "Report how well the rendered motion matches its intent, and what to change.",
    "input_schema": {
        "type": "object",
        "properties": {
            "verdict": {
                "type": "string", "enum": list(contracts.JUDGE_VERDICTS),
                "description": ("'good' = ship it; 'tune' = right kind of motion, wrong "
                                "settings; 'wrong_class' = this is the wrong KIND of motion "
                                "for what the source shows and no dial can fix it."),
            },
            "score": {"type": "number", "description": "0-1 overall quality of the match."},
            "axes": {
                "type": "object", "description": "0-1 sub-scores; explain the deltas you ask for.",
                "properties": {a: {"type": "number"} for a in contracts.JUDGE_AXES},
            },
            "deltas": {
                "type": "object",
                "description": ("Signed ADJUSTMENTS to add to the current params — not new "
                                "values. Omit a param you would not change. Only include a "
                                "param whose matching axis you scored low."),
                "properties": {k: {"type": "number"} for k in contracts.PARAM_KEYS},
            },
            "critique": {"type": "string",
                         "description": "One or two sentences, shown to the user verbatim."},
            "observations": {"type": "array", "items": {"type": "string"},
                             "description": "What you actually saw in the frames, one phrase each."},
        },
        "required": ["verdict", "score", "critique"],
    },
}


def _dial_text():
    """The dials, their ranges and this round's step limit — generated from contracts so
    the prompt can never drift from what normalize_judgement will actually accept."""
    meaning = {
        "frequency": "oscillations per second; higher = faster, busier motion",
        "amplitude": "how far things move; 0 is completely still",
        "direction": "heading in degrees — 0 is rightwards (+x), 90 is UPWARDS on screen",
        "turbulence": "how irregular/noisy the motion is vs. a clean sine",
        "damping": "how much the motion dies away from its anchor",
        "phaseSpread": "how out-of-step neighbouring parts are; 0 moves as one rigid block",
        "driftX": "steady sideways travel, + is right",
        "driftY": "steady vertical travel, + is down",
    }
    out = []
    for k in contracts.PARAM_KEYS:
        lo, hi = contracts.PARAM_RANGES[k]
        out.append(f"  - {k}: {meaning[k]}. range {lo}..{hi}, "
                   f"this round you may adjust it by at most +/-{contracts.PARAM_DELTA_MAX[k]}")
    return "\n".join(out)


def judge_prompt(cls, applicator, params, label, has_ref, element=""):
    """`label` is what the motion is meant to BE; `element` is what it was applied TO.

    Keeping them apart matters more than it looks. Sending the layer name as the intent
    told the model "intended motion: title", and it dutifully judged the clip as a title
    reveal — a fair verdict on the wrong question. The motion's own name is the intent;
    the element name only narrows down which thing in the frame to watch.
    """
    spec = contracts.MOTION_CLASSES.get(cls, {})
    # a hand-authored preset carries no extracted class. Say that, rather than printing
    # class '' and leaving the model to guess what the empty string meant.
    intent = (f"Intended motion: {label or cls or 'unnamed'}"
              + (f" — class '{cls}'" if cls else "")
              + (f" ({spec.get('desc')})" if spec.get("desc") else "")
              + ("" if cls else " — no motion class was recorded for it, so infer the"
                                " intent from its name and the applicator")
              + f", rendered by the '{applicator}' applicator.\n"
              + (f"It is applied to the illustration element named '{element}'.\n" if element else "")
              + "\n")
    return (
        (("The FIRST group of frames is the SOURCE VIDEO. The SECOND group is an "
          "animated illustration that is supposed to reproduce that motion. Judge how "
          "well the illustration's motion matches the source.\n\n") if has_ref else
         ("These frames are sampled in order from an animated illustration. Judge whether "
          "the motion reads convincingly as what it is meant to be — you have no source "
          "video to compare against, so judge plausibility, not fidelity.\n\n")) +
        intent +
        f"Current parameter values:\n{json.dumps(params, indent=2)}\n\n"
        f"The dials you may adjust:\n{_dial_text()}\n\n"
        "Rules:\n"
        "- Judge the MOTION across the frames, not the artwork's drawing quality, colours "
        "or composition. Ugly art moving correctly scores well.\n"
        "- Other elements in the frame may be moving too. Judge ONLY the element described "
        "above; ignore everything else.\n"
        "- Frames are stills. If you cannot see motion between them, say so and score low — "
        "do not assume motion you cannot observe.\n"
        "- deltas are ADDITIVE offsets to the values above. To halve a frequency of 1.4, "
        "ask for -0.5 (the cap), not 0.7.\n"
        "- Only ask for a delta you can justify from a low axis score. No delta is a valid "
        "answer when the verdict is 'good'.\n"
        "- Use 'wrong_class' only when the KIND of motion is wrong (a flag rendered as a "
        "drifting flock), not when it is merely mistuned. It stops the tuning loop.\n"
        "Call report_verdict."
    )


def _sniff_media(buf):
    """The media type according to the BYTES, or None if it isn't one the API takes.

    Deliberately not the type the caller declared: a canvas.toDataURL() can hand over
    JPEG bytes under an image/png header, and the API rejects that mismatch with a 400
    rather than just reading the file. The magic number is the only claim worth trusting.
    """
    if buf[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if buf[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if buf[:4] == b"GIF8":
        return "image/gif"
    if buf[:4] == b"RIFF" and buf[8:12] == b"WEBP":
        return "image/webp"
    return None


def _decode_frames(items, cap=JUDGE_MAX_FRAMES):
    """Client frames -> [(media_type, b64)]. Accepts bare base64 or a data: URL, and
    re-encodes anything too wide, or in a format the API can't read, to a capped JPEG."""
    out, notes = [], []
    if len(items) > cap:
        step = (len(items) - 1) / (cap - 1) if cap > 1 else 0
        items = [items[round(i * step)] for i in range(cap)]
        notes.append(f"sampled {cap} of the frames sent")
    for it in items:
        if not isinstance(it, str) or not it.strip():
            continue
        b64 = it.strip()
        if b64.startswith("data:"):
            b64 = b64.partition(",")[2]        # the header is ignored; see _sniff_media
        try:
            buf = base64.b64decode(b64, validate=True)
        except Exception:
            notes.append("skipped a frame that was not valid base64")
            continue
        media = _sniff_media(buf)
        try:
            img = cv2.imdecode(np.frombuffer(buf, np.uint8), cv2.IMREAD_COLOR)
        except Exception:
            img = None
        # re-encode when it costs too many tokens as-is, or when the API can't read it
        if img is not None and (media is None or img.shape[1] > MAX_W):
            if img.shape[1] > MAX_W:
                scale = MAX_W / img.shape[1]
                img = cv2.resize(img, (MAX_W, int(img.shape[0] * scale)))
            ok, enc = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 82])
            if ok:
                media, b64 = "image/jpeg", base64.b64encode(enc.tobytes()).decode()
        if media is None:
            notes.append("skipped a frame in an image format that could not be read")
            continue
        out.append((media, b64))
    return out, notes


def judge(body):
    """One judge pass. Returns (response, warnings). Never raises on bad input."""
    cls = str(body.get("class") or "")
    applicator = str(body.get("applicator") or contracts.MOTION_CLASSES.get(cls, {}).get("applicator") or "")
    # the caller's params verbatim: apply_deltas only touches PARAM_KEYS, so renderer
    # flags that ride along (leafFall, seed…) survive into next_params unchanged
    params = body.get("params") if isinstance(body.get("params"), dict) else {}
    label = str(body.get("label") or "")        # the motion's name — the intent
    element = str(body.get("element") or "")    # the layer it was applied to
    session = str(body.get("session") or "default")

    history = JUDGE_SESSIONS.get(session, [])
    go, reason = contracts.judge_should_continue(history)
    if not go:
        return {"stopped": True, "reason": reason, "iteration": len(history),
                "best": contracts.judge_best(history),
                "history": [{"score": h["score"], "verdict": h["verdict"]} for h in history]}, \
               [f"refused: {reason}"]

    frames, notes = _decode_frames(body.get("frames") or [])
    if len(frames) < 2:
        return {"error": "need at least 2 rendered frames to judge motion"}, notes
    ref, refnotes = _decode_frames(body.get("reference") or [])
    notes += refnotes
    score_of = "match_to_reference" if len(ref) >= 2 else "class_plausibility"

    content = [{"type": "text", "text": judge_prompt(cls, applicator, params, label, len(ref) >= 2, element)}]
    for tag, group in (("SOURCE", ref), ("RENDER", frames)):
        if not group:
            continue
        for i, (media, b64) in enumerate(group):
            content.append({"type": "text", "text": f"{tag} frame {i + 1}/{len(group)}:"})
            content.append({"type": "image",
                            "source": {"type": "base64", "media_type": media, "data": b64}})

    msg = _client().messages.create(
        model=MODEL, max_tokens=1024, tools=[JUDGE_TOOL],
        tool_choice={"type": "tool", "name": "report_verdict"},
        messages=[{"role": "user", "content": content}],
    )
    raw = next((b.input for b in msg.content if b.type == "tool_use"), None)
    if raw is None:
        return {"error": "VLM did not return a structured verdict"}, notes

    verdict, warnings = contracts.normalize_judgement(raw, score_of, len(frames))
    ok, errs = contracts.validate_judgement(verdict)
    if not ok:
        # a 'tune' with no usable delta lands here; report it rather than loop on nothing
        return {"error": "verdict did not validate", "detail": errs, "verdict": verdict}, \
               notes + warnings

    # The server, not the caller, applies the deltas and decides whether to go again.
    next_params, clamp_notes = contracts.apply_deltas(params, verdict["deltas"])
    history = history + [verdict]
    if len(JUDGE_SESSIONS) >= JUDGE_SESSION_CAP and session not in JUDGE_SESSIONS:
        JUDGE_SESSIONS.pop(next(iter(JUDGE_SESSIONS)), None)
    JUDGE_SESSIONS[session] = history
    go, reason = contracts.judge_should_continue(history)
    return {"verdict": verdict, "params": params, "next_params": next_params,
            "iteration": len(history), "max_iterations": contracts.JUDGE_MAX_ITERS,
            "continue": go, "reason": reason, "best": contracts.judge_best(history),
            "score_of": score_of,
            "history": [{"score": h["score"], "verdict": h["verdict"]} for h in history],
            "stopped": False}, notes + warnings + clamp_notes


# ══ Step 10: label the artwork's layers ═════════════════════════════════════
# The other half of auto-apply. /decompose says what moves in the CLIP; this says what
# each object in the ARTWORK is, so an extracted swatch can be matched to the thing it
# belongs on without a regex over layer names.
#
# HOW THE MODEL IS TOLD WHICH LAYER IS WHICH: it gets the whole artwork once for
# context, then one CROP per layer, each announced by id. The alternative — the full
# image plus a list of normalized bboxes as text — asks the model to do coordinate
# geometry on a picture, and a mislabelled layer here animates the wrong object. A crop
# cannot be misread. It costs one small image per layer, which is why LABEL_MAX_LAYERS
# is capped and the cap is reported rather than silently truncating.
LABEL_MAX_LAYERS = int(os.environ.get("LABEL_MAX_LAYERS", "12"))
LABEL_CROP_W = 256               # crops are for identification, not inspection
LABEL_CROP_MARGIN = 0.04         # a little context around the bbox, in image fractions

LABEL_TOOL = {
    "name": "report_layers",
    "description": "Say what each numbered layer of the illustration depicts, and whether it could move.",
    "input_schema": {
        "type": "object",
        "properties": {
            "labels": {
                "type": "array",
                "description": "One entry per layer id you were shown. Do not invent ids.",
                "items": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "string", "description": "the layer id exactly as given"},
                        "label": {"type": "string",
                                  "description": "what it depicts, 1-3 words, e.g. 'flag', 'smoke', 'flying birds'"},
                        "motion_class": {
                            "type": "string",
                            "enum": [""] + list(contracts.MOTION_CLASSES.keys()),
                            "description": ("the class of motion this object would take IF it moved. "
                                            "Use \"\" (empty) for anything that should stay still — "
                                            "background, ground, sky, buildings, text, a signature."),
                        },
                        "confidence": {"type": "number",
                                       "description": "0-1, how sure you are of the label and class"},
                        "notes": {"type": "string", "description": "one phrase of reasoning"},
                    },
                    "required": ["id", "label", "motion_class", "confidence"],
                },
            },
        },
        "required": ["labels"],
    },
}


def label_prompt(layers):
    listing = "\n".join(f"  - {l['id']}: the illustration calls it {l.get('name') or '(unnamed)'!r}"
                        for l in layers)
    return (
        "The first image is a complete illustration. The images after it are CROPS of it, "
        "one per layer, each announced by its layer id.\n\n"
        "For every layer id, say what it depicts and which class of motion it would take "
        "if it were animated:\n\n" + _taxonomy_text() + "\n\n"
        f"The layers, with the name the illustration file gave them:\n{listing}\n\n"
        "Rules:\n"
        "- The file's own layer name is a HINT ONLY and is often wrong or meaningless "
        "(\"Layer 3\", \"path2847\", or a name left over from a different drawing). Judge from "
        "the crop. Where the picture and the name disagree, trust the picture.\n"
        "- Most layers should NOT move. Set motion_class to \"\" for background, sky, ground, "
        "buildings, text, borders — anything that would look wrong animated. An empty class is "
        "the expected answer, not a failure.\n"
        "- Only give a class when the object plausibly moves BY ITSELF in the real world.\n"
        "- A crop may be mostly empty if the layer is thin or scattered; label what is there.\n"
        "- confidence is how sure you are of the label AND the class together.\n"
        "- Return exactly one entry per id listed above, using the id verbatim.\n"
        "Call report_layers."
    )


def _layer_bbox(b):
    """Normalized [x,y,w,h] clamped into the frame, or None if it is not a real box.

    Unlike contracts._clamp_bbox this NEVER widens: a missing, malformed, NaN or zero-area
    box means "we do not know where this layer is", and the honest response is to leave the
    layer unlabelled rather than to crop something else and call it that layer.
    """
    try:
        vals = [float(v) for v in list(b)[:4]]
    except (TypeError, ValueError):
        return None
    if len(vals) < 4 or not all(math.isfinite(v) for v in vals):
        return None
    x, y, w, h = vals
    x = min(max(x, 0.0), 1.0); y = min(max(y, 0.0), 1.0)
    w = min(w, 1.0 - x); h = min(h, 1.0 - y)
    if w <= 0 or h <= 0:
        return None
    return [round(x, 4), round(y, 4), round(w, 4), round(h, 4)]


def _crop(img, bbox):
    """Normalized [x,y,w,h] -> a JPEG-b64 crop with a little margin, or None if degenerate."""
    H_, W_ = img.shape[:2]
    x, y, w, h = bbox
    # The margin is CONTEXT, not content, so it must not rescue an empty box. Without this
    # a zero-area layer still cropped (margin alone is ~38x25px at 480x320) and the model
    # confidently labelled a patch of background — an answer that would then be treated as
    # a label the model had earned by looking. A layer thinner than one pixel in either
    # direction has nothing in it to look at; it goes unlabelled and is reported as such.
    if w * W_ < 1 or h * H_ < 1:
        return None
    mx, my = LABEL_CROP_MARGIN * W_, LABEL_CROP_MARGIN * H_
    x0 = max(0, int(x * W_ - mx)); y0 = max(0, int(y * H_ - my))
    x1 = min(W_, int((x + w) * W_ + mx)); y1 = min(H_, int((y + h) * H_ + my))
    if x1 - x0 < 4 or y1 - y0 < 4:
        return None
    sub = img[y0:y1, x0:x1]
    if sub.shape[1] > LABEL_CROP_W:
        scale = LABEL_CROP_W / sub.shape[1]
        sub = cv2.resize(sub, (LABEL_CROP_W, max(1, int(sub.shape[0] * scale))))
    ok, enc = cv2.imencode(".jpg", sub, [cv2.IMWRITE_JPEG_QUALITY, 82])
    return base64.b64encode(enc.tobytes()).decode() if ok else None


def label_layers(body):
    """One labelling pass. Returns (contract, warnings). Never raises on bad input."""
    notes = []
    raw_layers = body.get("layers") if isinstance(body.get("layers"), list) else []
    layers = []
    for i, l in enumerate(raw_layers):
        if not isinstance(l, dict) or not str(l.get("id", "")):
            notes.append(f"layer #{i} has no id; skipped")
            continue
        # NOT contracts._clamp_bbox: its zero-size fallback widens a degenerate box to the
        # rest of the frame, which is the right answer for a seed_bbox ("extract from the
        # whole frame") and exactly the wrong one here — a layer with no box would be shown
        # to the model as a slab of the artwork and come back confidently labelled. A layer
        # whose box is not a box is dropped, and its absence is reported.
        box = _layer_bbox(l.get("bbox"))
        if box is None:
            notes.append(f"layer {str(l['id'])!r} has no usable bbox; skipped")
            continue
        layers.append({"id": str(l["id"]), "name": str(l.get("name", ""))[:80], "bbox": box})
    if len(layers) > LABEL_MAX_LAYERS:
        notes.append(f"only the first {LABEL_MAX_LAYERS} of {len(layers)} layers were sent "
                     f"to the model; the rest are unlabelled")
        layers = layers[:LABEL_MAX_LAYERS]
    if not layers:
        return contracts.empty_layer_labels(), notes + ["no labellable layers were sent"]

    shot, shotnotes = _decode_frames([body.get("image") or ""], cap=1)
    notes += shotnotes
    if not shot:
        return contracts.empty_layer_labels(), notes + ["the artwork image could not be read"]
    media, b64 = shot[0]
    img = cv2.imdecode(np.frombuffer(base64.b64decode(b64), np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        return contracts.empty_layer_labels(), notes + ["the artwork image could not be decoded"]
    art = {"width": int(img.shape[1]), "height": int(img.shape[0]), "layers_sent": len(layers)}

    content = [{"type": "text", "text": label_prompt(layers)},
               {"type": "text", "text": "The whole illustration:"},
               {"type": "image", "source": {"type": "base64", "media_type": media, "data": b64}}]
    shown = []
    for l in layers:
        crop = _crop(img, l["bbox"])
        if crop is None:
            notes.append(f"layer {l['id']!r} bbox is too small to crop; not shown to the model")
            continue
        shown.append(l["id"])
        content.append({"type": "text", "text": f"Layer {l['id']}:"})
        content.append({"type": "image",
                        "source": {"type": "base64", "media_type": "image/jpeg", "data": crop}})
    if not shown:
        return contracts.empty_layer_labels(art), notes + ["no layer produced a usable crop"]

    msg = _client().messages.create(
        model=MODEL, max_tokens=2048, tools=[LABEL_TOOL],
        tool_choice={"type": "tool", "name": "report_layers"},
        messages=[{"role": "user", "content": content}],
    )
    raw = next((b.input for b in msg.content if b.type == "tool_use"), None)
    if raw is None:
        return contracts.empty_layer_labels(art), notes + ["VLM did not return structured labels"]

    # `shown` and not `layers`: an id whose crop was never sent must not come back
    # labelled, because whatever the model said about it, it did not look at it.
    contract, warnings = contracts.normalize_layer_labels(raw, shown, art)
    contract["warnings"] = notes + warnings
    return contract, notes + warnings


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

    def _body(self, n):
        """Read n bytes and parse as JSON, or None."""
        try:
            return json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return None

    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.end_headers()

    def do_GET(self):
        self._json(200, {"ok": True, "service": "vlm_router", "model": MODEL,
                         "backend": "bedrock" if USE_BEDROCK else "anthropic",
                         "region": AWS_REGION if USE_BEDROCK else None,
                         "classes": list(contracts.MOTION_CLASSES.keys()),
                         "endpoints": ["/decompose", "/label", "/judge", "/judge/reset"],
                         "label": {"max_layers": LABEL_MAX_LAYERS,
                                   "deforms": list(contracts.LAYER_DEFORMS),
                                   "mesh_classes": list(contracts.MESH_CLASSES)},
                         "judge": {"max_iterations": contracts.JUDGE_MAX_ITERS,
                                   "good_enough": contracts.JUDGE_GOOD,
                                   "min_gain": contracts.JUDGE_MIN_GAIN,
                                   "max_frames": JUDGE_MAX_FRAMES,
                                   "delta_caps": contracts.PARAM_DELTA_MAX,
                                   "sessions": len(JUDGE_SESSIONS)},
                         "auth": _auth_ready()})

    def do_POST(self):
        if self.path not in ("/decompose", "/label", "/judge", "/judge/reset"):
            self._json(404, {"error": "POST /decompose | /label | /judge | /judge/reset"}); return
        n = int(self.headers.get("Content-Length", "0"))

        if self.path == "/judge/reset":
            # start a fresh tune run for this session — the only way to clear a history
            body = self._body(n) or {}
            JUDGE_SESSIONS.pop(str(body.get("session") or "default"), None)
            self._json(200, {"ok": True, "session": body.get("session") or "default"}); return

        if not _auth_ready():
            self._json(500, {"error": ("no AWS credentials for Bedrock" if USE_BEDROCK
                                       else "ANTHROPIC_API_KEY not set on the router service")}); return

        if self.path == "/label":
            body = self._body(n)
            if body is None:
                self._json(400, {"error": "/label takes a JSON body"}); return
            try:
                nl = len(body.get("layers") or [])
                print(f"[router] labelling {nl} layer(s)…", file=sys.stderr)
                res, warnings = label_layers(body)
                for w in warnings:
                    print(f"[router] warn: {w}", file=sys.stderr)
                print("[router] " + ", ".join(
                    f"{l['id']}={l['label']!r}/{l['motion_class'] or 'static'}({l['confidence']})"
                    for l in res["labels"]) or "[router] no labels", file=sys.stderr)
                self._json(200, res)
            except Exception as e:
                print(f"[router] label error: {e}", file=sys.stderr)
                self._json(500, {"error": str(e)})
            return

        if self.path == "/judge":
            body = self._body(n)
            if body is None:
                self._json(400, {"error": "/judge takes a JSON body"}); return
            try:
                nf = len(body.get("frames") or [])
                print(f"[router] judging {body.get('class')}/{body.get('applicator')} "
                      f"over {nf} frame(s)…", file=sys.stderr)
                res, warnings = judge(body)
                for w in warnings:
                    print(f"[router] warn: {w}", file=sys.stderr)
                if "verdict" in res and not res.get("error"):
                    print(f"[router] {res['verdict']['verdict']} {res['verdict']['score']} "
                          f"-> {res['verdict']['deltas']} ({res['reason']})", file=sys.stderr)
                if warnings:
                    res["warnings"] = warnings
                self._json(400 if res.get("error") else 200, res)
            except Exception as e:
                print(f"[router] judge error: {e}", file=sys.stderr)
                self._json(500, {"error": str(e)})
            return

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
    print(f"vlm_router on http://127.0.0.1:{PORT}  (POST /decompose with video bytes, "
          f"POST /judge with rendered frames)", file=sys.stderr)
    print(f"  backend={'bedrock' if USE_BEDROCK else 'anthropic'} model={MODEL}"
          + (f" region={AWS_REGION}" if USE_BEDROCK else ""), file=sys.stderr)
    if not _auth_ready():
        print("  WARNING: no credentials for the selected backend — /decompose will 500.",
              file=sys.stderr)
    HTTPServer(("127.0.0.1", PORT), H).serve_forever()
