"""Step 6 — Backend E: text -> motion. The gate, and the format bridge.

`docs/BUILD_PLAN.md` Step 6's done-when is «"a person waves" -> a usable skeletal swatch
drives a rigged character». That is **not met in this repo**, and this module does not
pretend otherwise: MoMask's checkpoints are not vendored and CLIP is not installed, so
`available()` reports the specific missing thing and the registered engine falls back
(`service/extractors.py`). What IS shipped and measured here:

  available()           a real probe — importlib.find_spec + os.path.isfile over the
                        vendored clone, its four .tar checkpoints and the RVQ's meta/.
                        Dependency-free, so importing this module can never break
                        server import or startup (the registry's honesty rule).
  momask22_to_pose13()  the pure converter: MoMask's (T, 22, 3) SMPL-ordered metres,
                        Y-UP with the ground on XZ, into Contract B's 13 joints as
                        [x, y, vis] normalised 0..1 against each frame's own joint
                        bbox, Y DOWN. No numpy, so it runs in every interpreter.
  swatch_from_joints()  that payload wrapped as a unified Contract-B swatch, with every
                        fabrication the conversion performs recorded in `warnings`.
  load_npy()            a MoMask sample .npy (exactly what its gen_t2m.py saves) -> a
                        swatch. **This is the path that works today**: generate the
                        motion wherever the weights already live, drop the .npy in, and
                        the existing rig animates it — no weights needed in this repo.
  generate()            the text -> joints path, transcribed from the vendored
                        gen_t2m.py. Gated on available(), and it HAS NEVER RUN here
                        (no checkpoints, no CLIP). Said out loud rather than implied.

What this module will not do: hand-author a wave, a walk, or any other cycle and hand it
back as generated motion. A missing model reports itself missing. The whole point of
Step 6 is a *generator*; a hardcoded joint table dressed up as one would make the
registry lie, which is the one thing the extractor registry exists to prevent.
"""
import os
import importlib.util

_HERE = os.path.dirname(os.path.abspath(__file__))

# The vendored clone is EricGuo5513/momask-codes (MoMask, CVPR 2024) at commit 94a6636 —
# NOT GuyTevet/motion-diffusion-model, which is what the registry row used to advertise.
# It stays untracked in git (it is upstream source, not ours); MOMASK_REPO lets it live
# anywhere without editing this file.
MOMASK_REPO = os.environ.get("MOMASK_REPO", os.path.join(_HERE, "momask-codes"))

# HumanML3D ("t2m") is the released English-prompt model; "kit" is the other published
# option and needs its own download, so it is a parameter and not a constant.
DATASET = os.environ.get("MOMASK_DATASET", "t2m")

# The released HumanML3D model names, from the vendored README + options/base_option.py.
# They are the directory names under checkpoints/<dataset>/, and prepare/download_models.sh
# is what creates them.
VQ_NAME = "rvq_nq6_dc512_nc512_noshare_qdp0.2"
T2M_NAME = "t2m_nlayer8_nhead6_ld384_ff1024_cdp0.1_rvq6ns"
RES_NAME = "tres_nlayer8_ld384_ff1024_rvq6ns_cdp0.2_sw"

# MoMask samples at 20 fps (gen_t2m.py plots its own output with fps=20, and HumanML3D is
# a 20 fps dataset). Contract B carries fps per swatch, so this is reported and NOT
# resampled to the pose service's 15 — a retime here would be an invented measurement.
GEN_FPS = 20

# Every file the generation path opens, with what it is, so a missing one names itself.
# (path relative to MOMASK_REPO, human name)
CKPT_FILES = [
    (f"checkpoints/{DATASET}/{VQ_NAME}/model/net_best_fid.tar", "RVQ tokenizer weights"),
    (f"checkpoints/{DATASET}/{T2M_NAME}/model/latest.tar", "masked transformer weights"),
    (f"checkpoints/{DATASET}/{RES_NAME}/model/net_best_fid.tar", "residual transformer weights"),
    (f"checkpoints/{DATASET}/length_estimator/model/finest.tar", "length estimator weights"),
    (f"checkpoints/{DATASET}/{VQ_NAME}/meta/mean.npy", "RVQ feature mean"),
    (f"checkpoints/{DATASET}/{VQ_NAME}/meta/std.npy", "RVQ feature std"),
]

# Third-party modules the generation path imports. `clip` is OpenAI CLIP (the text
# encoder MaskTransformer conditions on) and is a git install, not a PyPI one, which is
# why it is the first thing missing on a fresh machine.
NEED_MODULES = [
    ("torch", "pip install torch"),
    ("numpy", "pip install numpy"),
    ("clip", "pip install 'git+https://github.com/openai/CLIP.git'"),
    ("einops", "pip install einops"),
    ("tqdm", "pip install tqdm"),
]

SETUP_HINT = ("clone EricGuo5513/momask-codes into service/momask-codes (or set "
              "MOMASK_REPO), run its prepare/download_models.sh, and pip install "
              "'git+https://github.com/openai/CLIP.git'")


def _has(mod):
    try:
        return importlib.util.find_spec(mod) is not None
    except (ImportError, ValueError):
        return False


def missing_checkpoints():
    """The CKPT_FILES that are not on disk, as (relative path, human name). Public
    because the probe's one-line reason cannot carry six paths and a caller setting the
    engine up wants the list."""
    return [(rel, what) for rel, what in CKPT_FILES
            if not os.path.isfile(os.path.join(MOMASK_REPO, rel))]


def available():
    """(bool, reason) — the registry probe. MEASURES, in this order: the clone, the
    importable modules, then the weights. The order is deliberate: reporting "weights
    missing" to someone who has not cloned the repo sends them to a 2 GB download they
    cannot use yet. Only find_spec + os.path.isfile, so this is cheap and safe to call
    on every GET /engines.

    The reason names ONE specific missing thing, not a generic "not set up" — a probe
    that cannot say what is missing is indistinguishable from a probe that never looked.
    """
    if not os.path.isdir(MOMASK_REPO):
        return False, f"clone EricGuo5513/momask-codes into {MOMASK_REPO} (or set MOMASK_REPO)"
    if not os.path.isfile(os.path.join(MOMASK_REPO, "gen_t2m.py")):
        return False, f"{MOMASK_REPO} exists but has no gen_t2m.py — wrong directory?"
    for mod, how in NEED_MODULES:
        if not _has(mod):
            return False, f"momask needs the {mod!r} module: {how}"
    missing = missing_checkpoints()
    if missing:
        rel, what = missing[0]
        return False, (f"missing {what} ({rel}); run {MOMASK_REPO}/prepare/download_models.sh "
                       f"[{len(missing)} of {len(CKPT_FILES)} files missing]")
    return True, f"momask-codes + {DATASET} checkpoints present"


# ── The converter: MoMask's SMPL-22 -> Contract B's 13 joints ────────────────
#
# Contract B's pose payload (service/contracts.py POSE_JOINTS) is the 13 joints the
# character rig reads by NAME, in this order:
#   nose l_sho r_sho l_elb r_elb l_wri r_wri l_hip r_hip l_knee r_knee l_ank r_ank
#
# MoMask emits HumanML3D's 22-joint SMPL skeleton, whose order is fixed by
# utils/paramUtil.py's t2m_kinematic_chain:
#   0 pelvis      1 l_hip       2 r_hip       3 spine1     4 l_knee     5 r_knee
#   6 spine2      7 l_ankle     8 r_ankle     9 spine3    10 l_foot    11 r_foot
#  12 neck       13 l_collar   14 r_collar   15 head      16 l_shoulder 17 r_shoulder
#  18 l_elbow    19 r_elbow    20 l_wrist    21 r_wrist
#
# NOSE IS A SUBSTITUTION, NOT A MAPPING. SMPL-22 has no nose; index 15 is the head
# joint, which sits higher and further back than a nose. The rig uses nose-vs-hip
# height for its head bob (js/animate.js reads jn.nose), so leaving it out would break
# the rig — but it is a fabricated landmark and every swatch says so in `warnings`.
SMPL22_TO_POSE13 = [
    (15, "nose", "SMPL head — SUBSTITUTION, SMPL-22 has no nose"),
    (16, "l_sho", "SMPL l_shoulder"),
    (17, "r_sho", "SMPL r_shoulder"),
    (18, "l_elb", "SMPL l_elbow"),
    (19, "r_elb", "SMPL r_elbow"),
    (20, "l_wri", "SMPL l_wrist"),
    (21, "r_wri", "SMPL r_wrist"),
    (1, "l_hip", "SMPL l_hip"),
    (2, "r_hip", "SMPL r_hip"),
    (4, "l_knee", "SMPL l_knee"),
    (5, "r_knee", "SMPL r_knee"),
    (7, "l_ank", "SMPL l_ankle"),
    (8, "r_ank", "SMPL r_ankle"),
]

SMPL22_JOINTS = 22
# The nine SMPL joints Contract B's pose has no slot for: pelvis, the three spine
# joints, both feet, the neck and both collars. Named in the warnings so a reader knows
# the drop was a decision and not an indexing accident.
DROPPED_SMPL = [0, 3, 6, 9, 10, 11, 12, 13, 14]

# Generated motion is not observed, so there is no visibility to measure. 1.0 says
# "the generator fully determined this joint", which is true; the swatch's
# confidence_of ("generation_only") is what stops it being read as a measurement.
GEN_VIS = 1.0

# pose_server.py's own floor when a pose collapses to a line/point, copied so a
# degenerate generated frame divides exactly the way a degenerate captured one does.
_BBOX_FLOOR = 1e-3


def conversion_warnings():
    """The structural facts about this conversion, as swatch warnings. They are NOT
    conditional on the input: every converted swatch fabricates a nose, invents no
    visibility, and throws the root travel away, so every converted swatch says so."""
    return [
        "nose is SMPL-22 joint 15 (head): SMPL has no nose, so this joint is a "
        "SUBSTITUTION and not a measurement",
        "vis is 1.0 on every joint: generated motion is not observed, so visibility is "
        "not measured here (see confidence_of)",
        "root travel is discarded — each frame is normalised to its own joint bbox, "
        "which is what pose_server.py does, so the rig animates in place",
        "9 of MoMask's 22 joints have no Contract-B slot and are dropped: "
        + ", ".join(str(i) for i in DROPPED_SMPL)
        + " (pelvis, spine1-3, both feet, neck, both collars)",
    ]


def momask22_to_pose13(joints, fps=GEN_FPS, engine="momask"):
    """(T, 22, 3) SMPL-ordered joint positions -> a Contract-B pose payload.

    `joints` is anything indexable as joints[t][j][axis] — a numpy array from
    np.load(), or nested lists. Deliberately numpy-free so this runs in the py3.9
    router venv and the system interpreter as well as the torch venv.

    IN : metres, Y UP, ground plane XZ, world origin at the start (MoMask /
         recover_from_ric convention).
    OUT: [[x, y, vis] x 13] per frame, x/y in 0..1 against THAT FRAME's joint bbox,
         Y DOWN — byte-compatible with pose_server.py's /extract frames, because the
         rig was built against that shape and a second normalisation convention would
         make a generated swatch and a captured one mean different things.

    The projection is orthographic front-on: screen x = SMPL x, screen y = -SMPL y.
    Z (depth) is dropped rather than projected, because a perspective divide needs a
    camera distance nobody measured.

    Returns (pose_payload, warnings).
    """
    warnings = list(conversion_warnings())
    frames = []
    bad = 0
    try:
        T = len(joints)
    except TypeError:
        return _empty_pose(fps, engine), ["joints was not a sequence of frames"]
    for t in range(T):
        fr = joints[t]
        try:
            if len(fr) < SMPL22_JOINTS:
                bad += 1
                frames.append(None)          # a short frame is a GAP, never a guess
                continue
            pts = [(float(fr[s][0]), -float(fr[s][1])) for s, _n, _w in SMPL22_TO_POSE13]
        except (TypeError, IndexError, ValueError):
            bad += 1
            frames.append(None)
            continue
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        x0, y0 = min(xs), min(ys)
        bw = max(_BBOX_FLOOR, max(xs) - x0)
        bh = max(_BBOX_FLOOR, max(ys) - y0)
        frames.append([[round((x - x0) / bw, 4), round((y - y0) / bh, 4), GEN_VIS]
                       for x, y in pts])
    if bad:
        warnings.append(f"{bad} of {T} frames were not 22x3 and became gaps (null), "
                        "not interpolated poses")
    if not any(frames):
        warnings.append("no frame converted: nothing in this input was a 22-joint pose")

    import contracts                          # stdlib-only, safe to import lazily here
    pose = contracts.empty_skeleton_swatch("pose", engine)
    pose["fps"] = int(fps) or GEN_FPS
    pose["frames"] = frames
    pose["total"] = len(frames)
    pose["detected"] = sum(1 for f in frames if f)
    pose["flags"] = ["ok" if f else "gap" for f in frames]
    # Front-on orthographic projection of a front-facing generator: 'front' is the
    # viewpoint the numbers actually describe, not a guess about the content.
    pose["viewpoint"] = "front"
    # There is no observation, so there is no confidence. 0.0 with the meaning spelled
    # out beats a plausible 0.9 that no measurement backs.
    pose["confidence"] = 0.0
    pose["confidence_of"] = contracts.GENERATED_CONFIDENCE
    return pose, warnings


def _empty_pose(fps, engine):
    import contracts
    p = contracts.empty_skeleton_swatch("pose", engine)
    p["fps"] = int(fps) or GEN_FPS
    p["confidence_of"] = contracts.GENERATED_CONFIDENCE
    p["viewpoint"] = "front"
    return p


def swatch_from_joints(joints, prompt="", fps=GEN_FPS, engine="momask"):
    """(T, 22, 3) -> a unified Contract-B swatch that validate_swatch() accepts.

    The prompt travels in `warnings` and not in a `label` field, because Contract B has
    no prompt slot and inventing one here would fork the schema. It is provenance: the
    one input a text2motion swatch had.
    """
    import contracts
    pose, warn = momask22_to_pose13(joints, fps=fps, engine=engine)
    if prompt:
        warn.insert(0, f"generated from the text prompt {prompt!r} — no video was observed")
    return contracts.skeleton_swatch(pose, cls="articulated", engine=engine, warnings=warn)


def load_npy(path, prompt="", engine="momask_npy"):
    """A MoMask sample .npy -> a Contract-B swatch.

    gen_t2m.py saves exactly this: np.save(..., joint) where joint is
    recover_from_ric(..., 22).numpy(), shape (T, 22, 3). So a machine that already has
    the weights can produce a file here, and this repo consumes it with no weights, no
    CLIP and no torch — numpy alone. That is the whole of Step 6 that works today, and
    it is a real generated motion rather than a hand-written one.

    Raises ValueError (with the shape it actually got) rather than converting something
    that is not a 22-joint sequence.
    """
    import numpy as np
    arr = np.load(path)
    if arr.ndim != 3 or arr.shape[1] != SMPL22_JOINTS or arr.shape[2] < 2:
        raise ValueError(f"{path}: expected (T, 22, 3) MoMask joints, got {arr.shape}")
    return swatch_from_joints(arr, prompt=prompt, engine=engine)


# ── The generation path ──────────────────────────────────────────────────────
# TRANSCRIBED FROM THE VENDORED gen_t2m.py AND NEVER EXECUTED IN THIS REPO. There are
# no checkpoints here and CLIP is not installed, so available() has never returned True
# and this function has never run past its gate. It is written out rather than left a
# stub so that installing the weights is the only thing standing between this repo and
# Step 6's done-when — but "never run" is a fact about it, and it is stated here instead
# of being discovered by whoever installs them.
def generate(prompt, motion_length=0, seed=10107, device="cpu",
             cond_scale=4.0, time_steps=18, temperature=1.0, topkr=0.9):
    """text -> (T, 22, 3) joint positions, via MoMask's masked + residual transformers.

    Raises RuntimeError with the probe's exact reason when the engine is not set up. It
    never returns a fallback motion: a caller that gets joints back from this function
    is holding real generator output, and one that gets an exception knows why.
    """
    ok, why = available()
    if not ok:
        raise RuntimeError(f"momask text2motion is not set up: {why}")

    import sys
    import numpy as np
    import torch
    if MOMASK_REPO not in sys.path:
        sys.path.insert(0, MOMASK_REPO)       # its modules import each other by bare name
    from models.mask_transformer.transformer import MaskTransformer, ResidualTransformer
    from models.vq.model import RVQVAE, LengthEstimator
    from utils.get_opt import get_opt
    from utils.motion_process import recover_from_ric
    from utils.fixseed import fixseed
    from torch.distributions.categorical import Categorical
    import torch.nn.functional as F

    fixseed(seed)
    dev = torch.device(device)
    ckpt_dir = os.path.join(MOMASK_REPO, "checkpoints")
    pj = os.path.join

    model_opt = get_opt(pj(ckpt_dir, DATASET, T2M_NAME, "opt.txt"), device=dev)
    vq_opt = get_opt(pj(ckpt_dir, DATASET, model_opt.vq_name, "opt.txt"), device=dev)
    res_opt = get_opt(pj(ckpt_dir, DATASET, RES_NAME, "opt.txt"), device=dev)
    vq_opt.dim_pose = 251 if DATASET == "kit" else 263

    vq_model = RVQVAE(vq_opt, vq_opt.dim_pose, vq_opt.nb_code, vq_opt.code_dim,
                      vq_opt.output_emb_width, vq_opt.down_t, vq_opt.stride_t,
                      vq_opt.width, vq_opt.depth, vq_opt.dilation_growth_rate,
                      vq_opt.vq_act, vq_opt.vq_norm)
    ck = torch.load(pj(ckpt_dir, DATASET, vq_opt.name, "model", "net_best_fid.tar"),
                    map_location="cpu")
    vq_model.load_state_dict(ck["vq_model" if "vq_model" in ck else "net"])

    t2m = MaskTransformer(code_dim=model_opt.code_dim, cond_mode="text",
                          latent_dim=model_opt.latent_dim, ff_size=model_opt.ff_size,
                          num_layers=model_opt.n_layers, num_heads=model_opt.n_heads,
                          dropout=model_opt.dropout, clip_dim=512,
                          cond_drop_prob=model_opt.cond_drop_prob,
                          clip_version="ViT-B/32", opt=model_opt)
    ck = torch.load(pj(ckpt_dir, DATASET, T2M_NAME, "model", "latest.tar"), map_location="cpu")
    t2m.load_state_dict(ck["t2m_transformer" if "t2m_transformer" in ck else "trans"],
                        strict=False)

    res_opt.num_quantizers, res_opt.num_tokens = vq_opt.num_quantizers, vq_opt.nb_code
    res = ResidualTransformer(code_dim=vq_opt.code_dim, cond_mode="text",
                              latent_dim=res_opt.latent_dim, ff_size=res_opt.ff_size,
                              num_layers=res_opt.n_layers, num_heads=res_opt.n_heads,
                              dropout=res_opt.dropout, clip_dim=512,
                              shared_codebook=vq_opt.shared_codebook,
                              cond_drop_prob=res_opt.cond_drop_prob,
                              share_weight=res_opt.share_weight,
                              clip_version="ViT-B/32", opt=res_opt)
    ck = torch.load(pj(ckpt_dir, DATASET, RES_NAME, "model", "net_best_fid.tar"),
                    map_location=dev)
    res.load_state_dict(ck["res_transformer"], strict=False)

    length_est = LengthEstimator(512, 50)
    ck = torch.load(pj(ckpt_dir, DATASET, "length_estimator", "model", "finest.tar"),
                    map_location=dev)
    length_est.load_state_dict(ck["estimator"])

    for m in (vq_model, t2m, res, length_est):
        m.eval().to(dev)

    mean = np.load(pj(ckpt_dir, DATASET, model_opt.vq_name, "meta", "mean.npy"))
    std = np.load(pj(ckpt_dir, DATASET, model_opt.vq_name, "meta", "std.npy"))

    captions = [str(prompt)]
    with torch.no_grad():
        if motion_length and motion_length > 0:
            token_lens = (torch.LongTensor([int(motion_length)]) // 4).to(dev).long()
        else:
            # No length asked for: MoMask's own estimator picks one from the text. A
            # constant here would be us choosing the duration, not the model.
            probs = F.softmax(length_est(t2m.encode_text(captions)), dim=-1)
            token_lens = Categorical(probs).sample()
        mids = t2m.generate(captions, token_lens, timesteps=time_steps,
                            cond_scale=cond_scale, temperature=temperature,
                            topk_filter_thres=topkr)
        mids = res.generate(mids, captions, token_lens, temperature=1, cond_scale=5)
        feats = vq_model.forward_decoder(mids).detach().cpu().numpy()
    data = feats * std + mean                                  # inv_transform
    n = int(token_lens[0]) * 4
    joints = recover_from_ric(torch.from_numpy(data[0][:n]).float(), SMPL22_JOINTS).numpy()
    return joints
