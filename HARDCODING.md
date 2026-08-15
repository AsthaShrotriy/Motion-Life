# What's real vs. hardcoded in Motion Swatch

This POC was built to **demo reliably in front of an audience**. That goal means
some parts run genuine algorithms and some are curated so a specific clip always
lands right. This file is the honest, complete accounting — nothing here is hidden
in the code.

**Short version:** the *motion math is real* end to end. The *hardcoding is about
"which region of a clip to look at" and "what to call it"* — plus one preprocessed
artwork file. On a fresh, unknown clip the app still works automatically; the
hardcoding just guarantees the curated demo clips segment perfectly.

---

## 1. Real (not hardcoded)

- **Optical-flow extraction.** RAFT (`raft_small`) computes a genuine dense flow
  field from whatever video you upload. This is real deep-learning inference, not a
  lookup.
- **Distillation to 8 parameters.** `distill()` measures frequency, amplitude,
  direction, turbulence, damping, phase-spread, and drift from the actual flow
  field. Real math on real pixels.
- **12×12 trajectory grid.** The 144 point-tracks are sampled from the real flow —
  when you apply a captured motion in Cloth mode, the object is deformed by the
  *actual measured displacement field* of the source video.
- **The animation engine** (`animate.js`) — wave deformation, trajectory-field
  replay, per-glyph text motion, the **deform-in-place** fix (subtracting per-frame
  mean displacement so flowing objects ripple without sliding away) — all real,
  general code that works on any object.
- **Object selection / the layer contract** (`regions.js`) — general; works on any
  SVG or raster.
- **The 8 built-in presets** — hand-authored parameter sets (like font weights).
  Not "hardcoded results," just designed defaults.

---

## 2. Hardcoded / curated

### a) `DEMO_PROFILES` — per-filename region layouts (`service/server.py`)

The single biggest piece of curation. If an uploaded file's **name** contains a
known substring (`cherry`, `silk`, `flag`, `wheat`, `ink`, `ocean`, `two_flags`,
`bosphorus`, …), the service uses a **hand-tuned region layout** instead of the
automatic segmenter:

- It still runs the **real** RAFT extraction and distillation on those regions.
- What's curated is **which cells of the 12×12 grid form each region, and the
  region's name** (e.g. "California Flag" vs "US Flag", "Seagull Flight" +
  "Flag Flutter").

**Why:** beautiful 4K stock footage rarely auto-segments into clean 3–4 regions at
demo resolution. The curated layout guarantees the demo clips split correctly and
get human-readable names. Rename the file (remove the keyword) and it falls back to
the fully automatic path.

### b) The Adobe train-window scene (`assets/scenes/train-window-adobe.svg`)

The user's Adobe Stock illustration was exported from Illustrator with **all layer
names flattened** — only two named groups survived (`View`, `Train`). To make
individual objects (hair, house, chimney smoke, both trees, coffee steam) clickable,
a **one-time preprocessing script** identified each object by geometry + color and
wrapped it into a named `<g class="layer" data-name="…">`. That processed file is
what's committed.

- The wrapping is **curated per-object** (which shapes belong to "hair").
- The rendering is byte-for-byte identical to the original; only structure changed.
- Once wrapped, selection and animation are fully general.

> Note: the "Train Window" scene tab was **removed** from the UI at the user's
> request. The processed file remains in `assets/scenes/` and can still be loaded via
> **Upload artwork**.

### c) Automatic-segmenter tuning constants (`service/server.py`)

`ANALYSIS_WIDTH`, `MIN_CELLS`, `REGION_KEEP_FRAC`, `ABS_FLOOR`, `PEAK_FRAC`,
`DRIFT_DOM`, `STATIC_PERSISTENCE_CUTOFF`, etc. are **tuned thresholds**, not
hardcoded outputs. They shape how the automatic path clusters motion. Reasonable but
hand-picked against the test clips.

### d) Cloth-mode heuristics (`animate.js` / `regions.js`)

Wave/cloth mode auto-enables for objects whose name matches
`/flag|banner|cloth|pennant|curtain|sail/i` and for captured motions. A naming
convenience, not a result.

---

## 3. Honest limitations (not worked around)

- **RAFT genuinely cannot see very thin motion** (e.g. light rain) at demo
  resolution — those clips extract near-zero amplitude, and we do **not** fake a
  region. Honesty over region count.
- **Smooth slow-motion water** reads as static texture to RAFT (amplitude ≈ 0) and
  is dropped rather than invented.
- The **backward-parallax "scenery moves as the train moves"** effect is not yet
  built — it needs deliberate bulk drift, which the deform-in-place fix intentionally
  suppresses for rippling objects.

---

## Bottom line for a demo

If someone asks *"is this real or hardcoded?"*, the honest answer is:

> "The motion extraction and animation are real — it runs RAFT optical flow on your
> video and applies the measured field. What's curated is *which part of certain demo
> clips to focus on and what to name the motions*, plus one artwork file whose layers
> we pre-labeled because Illustrator stripped the names. Rename a demo clip or upload
> a new one and it runs fully automatically."
