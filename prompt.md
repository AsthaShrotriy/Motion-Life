# PROMPT: Build "Motion Swatch" — a motion capture→extract→apply creative tool, plus two demo websites

You are building a complete, working proof-of-concept called **Motion Swatch**. Follow this spec exactly — every constant, formula, and design decision here was validated against ground-truth tests. Where this document says "MUST" or gives a number, do not improvise.

## The product in one paragraph

A designer films 5 seconds of real-world motion on their phone (a waving flag, water waves, falling leaves, candle flame). Motion Swatch extracts that motion — via a deep optical-flow model — into a reusable "motion swatch": 8 scalar parameters PLUS a 12×12 grid of real point trajectories. The designer then clicks any object in an SVG artwork and applies the swatch: the object moves with the *captured* motion (not a canned preset). The result exports as (a) a self-contained animated SVG that works as a plain `<img>` with zero JavaScript, and (b) a vertical 1080×1920 video for social media. Two demo websites consume the exports: a travel site whose hero illustration comes alive, and a comic-book site whose panels come alive.

## Deliverables (three folders)

```
motion-swatch-poc/     # the tool: web app + Python analysis service + tests
travel-site/           # demo website 1 (can live inside motion-swatch-poc/)
comic/                 # demo website 2
```

Everything browser-side is **vanilla JS + Canvas 2D + inline SVG. No frameworks, no bundler, no npm dependencies.** Scripts attach to `window` and load in a fixed order. Serve with any static server (`python3 -m http.server 8000`). The Python service is optional at runtime (the app falls back to an in-browser analyzer) but required for full quality.

---

# PART 1 — The analysis service (Python, FastAPI)

`service/server.py`, run via `uvicorn server:app --host 127.0.0.1 --port 8765`. Deps: `torch, torchvision, numpy, opencv-python-headless, fastapi, uvicorn, python-multipart`.

## Model choice (do not substitute without reason)

Use **torchvision's built-in pretrained RAFT** (`torchvision.models.optical_flow.raft_small`, `Raft_Small_Weights.DEFAULT`). Rationale you should preserve: BSD-3 license (safe), 4MB checkpoint auto-downloads, runs on Apple-Silicon MPS out of the box (`DEVICE = "mps" if torch.backends.mps.is_available() else "cpu"`), and — verified by benchmark — **raft_small beats raft_large end-to-end for this task** (raft_large's stronger smoothness prior blurs traveling-wave phase structure, hurting the phaseSpread parameter, at 4× the compute). Allow `MS_ENGINE=raft_large` as an env override.

Analysis config (benchmark-chosen): downscale frames to **width 480** (height rounded to a multiple of 8 — RAFT requires dims divisible by 8), subsample to **20 fps**, analyze at most **8 seconds**. RAFT input scaling: frames as float in [0,1] → `tensor*2-1`. Run the model on consecutive frame pairs; keep only the final refinement iteration. Result: dense flow `[T-1, 2, H, W]` in px/frame.

## Endpoints

`GET /health` → `{ok, engine, device}`. CORS: allow all (localhost demo).

`POST /analyze` (multipart `file`) → decode with OpenCV (guard bogus fps: if not 1–240, assume 30) → RAFT flow series → distill → segment → respond:
```json
{ "ok": true, "engine": "raft_small@mps", "fps": 20.0, "frames_analyzed": 120,
  "params": { "frequency":…, "amplitude":…, "direction":…, "turbulence":…,
              "damping":…, "phaseSpread":…, "driftX":…, "driftY":… },
  "trajectories": [ …144 tracks, each a list of [x,y] normalized 0..1 per frame… ],
  "regions": [
    { "params": {…same 8 fields…}, "trajectories": […144 tracks, non-region cells frozen…],
      "bbox": {"x0":0.0, "y0":0.25, "x1":0.42, "y1":0.75},
      "cells": 19, "suggested_name": "Wave", "color": "#ff8a4c" }, … ] }
```
Trajectories: partition the frame into a 12×12 grid of cells, average the flow per cell per frame, and **integrate** those cell velocities from each cell center → 144 point tracks. These tracks are the soul of the product — the client replays them. `regions[]` is the per-motion segmentation — see § Multi-motion segmentation below.

## Multi-motion segmentation (flow → N regions)

Whole-frame distill collapses everything into one swatch, which averages badly if a clip has two motions. Segmentation groups the 12×12 grid into regions of coherent motion:

1. **Static-scene kill.** Compute per-pixel magnitude persistence across the whole clip (mean Pearson corr of consecutive magnitude maps). If `persistence ≥ 0.85` → return `[]`. This kills RAFT noise on truly static clips even when individual cells look energetic.
2. **Per-cell features** on the 12×12 grid: energy = mean magnitude over time; direction = angle of the covariance-eigenvector (closed form: `0.5·atan2(2·varxy, varx − vary)`) in degrees mod 180; freq_bin = argmax of the axis-projected rFFT.
3. **Two-stage active mask.** Cell is active iff `energy ≥ 0.4` (absolute — keeps real footage; the flag video's peak cell energy is ~0.73) AND `energy ≥ 0.35 × peak_cell_energy` (peak-relative — forces separation between distinct movers). Also require `peak ≥ 0.4` up front, or return `[]`.
4. **Dilate the mask by 1 cell** (4-connected), then **4-connected components** (custom flood-fill — no scipy dependency).
5. **Similar-adjacent merge** via union-find: iterate 4-edges; for each edge between different labels, merge if the *energy-weighted circular-mean directions* (compute on 2θ because the axis is undirected) differ by < 20° AND the *median freq-bins* differ by < 25% (relative). Fixes the "same flag splinters at tip vs pole" case.
6. **Discard components < 5 cells**, rank by summed energy, cap at 8 regions.
7. **Per-region distill.** For each surviving region, block-expand the cell mask to a pixel mask, zero the flows outside the mask, call `distill()` on the masked flow array. Amplitude coverage normalizes by frame size (not region size) — deliberate: a small strong region should read as strong motion, just less "coverage".
8. **Per-region trajectories.** In-region cells integrate normally; out-of-region cells stay at their start position (frontend field-replay then confines the deformation to the region).
9. **Suggested name** from the extracted params — heuristic: strong `driftY` → "Falling"/"Rising", strong `driftX` → "Drifting", `freq > 2 && turb > 0.35` → "Flutter", `freq < 0.6 && turb < 0.15` → "Slow horizontal/vertical", else axis-based "Wave"/"Sway".
10. **Region color** cycles through a fixed palette (`#ff8a4c #4cc9ff #3ddc84 #ffd93d #c86bff #ff5c9a #7c6cff #f28b3a`) so the picker UI is stable across runs.

Calibrate with a multi-motion benchmark (see `service/benchmark.py multi`): two synthetic 2-motion clips + one 3-motion clip + single-motion control + static control. Targets: `multi2` → exactly 2 regions with correct freq/direction/bbox, `sway_only` → 1 region, `static` → 0 regions.

## The distill algorithm (flow → 8 params) — every step matters

1. **Drift first:** `g_raw = flows.mean(axis=(2,3))` per frame; `drift_px = g_raw.mean(axis=0)`. `driftX/Y = clip(drift_px / (0.005*W), -1, 1)` (0.5% of frame width per frame = fast drift). Then remove the mean: `g = g_raw - mean` — all oscillation analysis uses the drift-removed signal. (This is what lets falling-leaves / flowing-water captures carry their steady travel.)
2. **Direction:** covariance matrix of (gvx, gvy) over time → major eigenvector → `degrees(atan2(-ay, ax)) % 180` (y flipped because screen-y grows down).
3. **Frequency:** project g onto the dominant axis → rFFT → zero the DC bin → peak bin → Hz = k·fps/T, refined with parabolic interpolation on log-magnitudes of the 3 bins around the peak (only if the offset < 1 bin). Clamp to [0.05, 8].
4. **Amplitude — three calibrated guards (all necessary, each fixes a measured failure):**
   - Per-pixel magnitude of drift-removed flow, NOT global-mean (global-mean cancels for spatially incoherent motion like leaves falling everywhere).
   - **Noise floor 0.55 px/frame**: RAFT hallucinates 0.3–0.9 px/frame even on static video. Only pixels above the floor count; average their (magnitude − floor).
   - **Static gate via pattern persistence:** RAFT's noise is anchored to texture edges — the spatial magnitude pattern correlates ≈1.0 frame-to-frame on static clips, while real motion travels (≤0.7 measured on every moving test clip). Compute mean Pearson correlation of consecutive magnitude maps → `static_gate = clamp01((0.92 − persistence)/0.12)`.
   - `amplitude = clamp01(strength/(0.006*W) · coverage · static_gate)` where `coverage = min(1, moving_fraction/0.03)`.
5. **Turbulence:** `(0.5·spectral_flatness + 0.5·spatial_disorder) × 1.4` clamped to 1. Spectral flatness = geometric/arithmetic mean of the power spectrum (DC excluded). Spatial disorder = mean over frames of `1 − R` where R is the magnitude-weighted resultant length of per-pixel flow directions; average only frames with real motion. The 1.4× compensates for RAFT's spatial smoothness compressing disorder.
6. **Damping:** `1 − |autocorrelation of the projected signal at lag = round(fps/freq)|`, clamped.
7. **phaseSpread:** per-PIXEL (not per-cell — cell averaging cancels opposite phases) single-bin DFT at the dominant bin via dot product with `exp(-2πikt/T)`; energy-weighted circular variance of the phases: `1 − |Σ(unit·energy)|/Σenergy`. High = traveling wave, low = rigid unison.
8. **Output gates:** `gate = min(1, amplitude/0.10)`; multiply turbulence and phaseSpread by gate (a near-static clip must not emit noise-driven parameters).

## Ground-truth validation (build this too: `service/benchmark.py`)

Generate 5 synthetic clips with OpenCV (checkered textures — flow needs texture): rigid block swaying 0.8Hz horizontally; block bouncing 2.5Hz vertically; a traveling wave at 1.2Hz across columns (expect phaseSpread HIGH); per-block random walks (expect turbulence HIGH, no clean frequency); fully static (expect amplitude ≈ 0). Score extracted params against known truth. **Target: 12/12 checks with raft_small @480px/20fps.** Note: browsers can't decode `mp4v` fourcc — test fixtures for browser tests must be re-encoded H.264 (`ffmpeg -c:v libx264 -pix_fmt yuv420p`).

---

# PART 2 — The web app

## Files & load order (all attach to `window`; order matters)

```
index.html
css/style.css
js/flow.js        # in-browser Lucas–Kanade fallback analyzer
js/distill.js     # in-browser port of the distill (sparse-grid variant)
js/motions.js     # MotionLibrary + 8 presets
js/scenery.js     # built-in artwork #2: lakeside scene, createScenerySVG()
js/poster.js      # built-in artwork #1: flag+title poster, createPosterSVG()
js/regions.js     # SelectionManager (click-to-select, wrapping, raster mode)
js/animate.js     # Animator + computeMotion + cloth wave + trajectory field + per-glyph text
js/export.js      # buildExportSVG (CSS keyframes / SMIL baking)
js/videoexport.js # exportVideo (MediaRecorder, 1080x1920 reel mode)
js/extractviz.js  # the "extraction moment" modal
js/multipick.js   # multi-motion picker modal (regions.length ≥ 2)
js/capture.js     # MotionCapture: service client + browser fallback
js/main.js        # controller: wires everything; exposes window.__ms = {sel, library, animator, loadScene} for tests
```

## ⚠️ THE TWO BUGS THAT WILL SILENTLY BREAK EVERYTHING (design around them)

1. **Overlay eats clicks.** A selection-overlay `<canvas>` sits above the artwork. If it has `pointer-events:auto` in SVG mode, no SVG element is ever clickable. Rule: overlay `pointer-events:none` in SVG mode (clicks go to the SVG, selection via one delegated click listener); `auto` + crosshair only in raster (rectangle-draw) mode.
2. **CSS transform vs SVG transform attribute.** Setting `el.style.transform` on an SVG element that already has a `transform="translate(…)"` **attribute** REPLACES the attribute positioning — objects teleport (measured −360px). Rule: wrap every selectable unit in a fresh empty `<g class="ms-wrap">` and animate the wrapper's **SVG transform attribute** (`setAttribute('transform', …)`). Never CSS transforms on SVG geometry. (Raster floating clones are HTML divs — CSS transform is fine there.)

## Selection (`regions.js`) — click-to-select with 3-tier wrapping

`SelectionManager.attachSVG(svg)` wraps selectable units at attach time, in priority order:
1. Elements with `class="layer"` + `data-name` (the contract for built-in artwork).
2. Else: elements with `id` that have no `id` descendants ("leaf-named" — skips Illustrator's `Layer_1` containers; units get their id as name).
3. Else (fully anonymous exports — common from Illustrator "Minimal IDs"): the SVG root's top-level drawable children, descending through single giant wrapper groups; names become "element N".

Plus two click-time fallbacks: if the clicked wrap covers >70% of the canvas (a layer container), drill down — walk up from the click target to the outermost group covering <50% and wrap that on the fly; if the click hits an unwrapped drawable, lazily wrap it. Selection objects: `{name, color, kind:'svg', wrap, center:[bbox cx,cy], motionId, speed:1, intensity:1, waveMode}`. `waveMode` defaults true when name matches `/flag|banner|cloth|pennant|curtain|sail/i`. Dashed highlight rects + name labels are drawn INSIDE the svg (`<g id="ms-highlights" pointer-events="none">`) and copy their target wrap's live transform every frame so they follow the motion. Raster images (PNG/JPEG upload) use rectangle-draw instead: the region's pixels are cloned into an absolutely-positioned floating div (background-image offset trick) which the animator moves with CSS transforms.

## The motion model (`animate.js`)

A motion = `{id, name, desc, color, params:{frequency, amplitude, direction, turbulence, damping, phaseSpread, driftX?, driftY?}, trajectories?, trajFps?, videoUrl?}`.

**8 presets (exact values):**
| id | freq | amp | dir | turb | damp | spread | drift | color |
|---|---|---|---|---|---|---|---|---|
| waterfall-flow | 2.8 | 0.6 | 90 | 0.55 | 0.1 | 0.7 | — | #4cc9ff |
| cloud-drift | 0.35 | 0.9 | 0 | 0.03 | 0 | 0.1 | — | #b8b8cc |
| flag-flutter | 3.5 | 0.4 | 10 | 0.35 | 0.2 | 0.85 | — | #ff5c5c |
| gentle-sway | 0.4 | 0.45 | 0 | 0.08 | 0.12 | 0.5 | — | #3ddc84 |
| water-ripple | 1.0 | 0.2 | 0 | 0.25 | 0.15 | 0.9 | — | #3a7abf |
| sun-pulse | 0.6 | 0.4 | 90 | 0 | 0 | 0 | — | #ffd93d |
| falling-leaves | 0.5 | 0.3 | 0 | 0.25 | 0.3 | 0.8 | dY 0.5 | #e8a33d |
| rising-smoke | 0.3 | 0.25 | 0 | 0.3 | 0.2 | 0.6 | dX .05 dY −.55 | #c9c4d4 |

(Calibration rule discovered by testing: every preset must produce ≥3px of visible on-screen travel within ~2s or users read it as broken.)

**Rigid formula** — `computeMotion(params, seed, t, intensity) -> {dx, dy, rot}` (shared by animator, previews, exports):
```
dir = {cos θ, −sin θ};  env = damping envelope (≈1 if damping≤0.02, else gusty:
      (1−damping) + damping · pow(valueNoise(t·(0.6+damping·1.8) + seed·37.7), 1+damping·4) · 2.2)
osc = sin(2π·freq·t + seed·phaseSpread·3.0);  turb = cheap 2-channel value-noise curl
A   = amplitude · 16 · intensity · env          (AMP_PX=16 viewBox units)
dx  = A·osc·dir.x + turbulence·11·turb.x·env·intensity   (TURB_PX=11)
dy  = A·osc·dir.y + turbulence·11·turb.y·env·intensity
rot = 0.06·amplitude·intensity·env·cos(2π·freq·t) · 180/π   (lean into motion)
drift: sawtooth loop — travels driftX/Y·26px over 10s (ramp 85%, ease back 15%)
```
Apply as `wrap.setAttribute('transform', 'translate(dx dy) rotate(rot cx cy)')` rotating about the object's own center.

**Cloth wave mode (presets):** sample every `<path>` in the selection into 48 points via `getPointAtLength` (store pristine `d` in `data-ms-d0`); per frame displace each point by a traveling wave `dy = A·ramp(x)·sin(2πf·t − k·(x−xmin)) + turb·ramp·noise`, `dx = 0.22·A·ramp·cos(…)`, where `ramp = ((x−xmin)/width)^1.15` pins the pole edge and frees the tip; `k = 2π·1.5·(0.5+phaseSpread)/width`, `A = 9·(0.35+amplitude)·intensity`. Rebuild the `d` string (M/L polyline, keep trailing Z for closed paths).

**Trajectory-field replay (captures — the realism core):** when a motion has `trajectories`, wave mode auto-enables and geometry replays the REAL field:
- `buildTrajField(motion)`: displacement-from-start per track; **active-region detection** — per-track max displacement, cells above `max(0.004, 25%·peak)` define the moving window (+1 cell padding); the target object maps onto that window only (a flag filmed against sky must not freeze the artwork with static-sky tracks). Displacements normalized by the active window size (motion scales to the OBJECT, not the video frame), capped at ±0.55, bilinear in space, linear in time, **ping-pong looped** (forward-then-backward; period `2·(T−1)/fps` — seamless, no end snap).
- Per frame each sampled path point maps its (u,v) in the object bbox → field sample → displace by `0.5·w/h·intensity`. Because neighboring points follow different real tracks, local stretch/compression (the wrinkle/foreshortening look) emerges automatically — and it works for ANY captured motion (water, smoke, leaves), no per-category code.

**Per-glyph text:** text moved rigidly reads as "the poster is shaking". When a selection contains `<text>`: split into per-letter `<text>` elements using `getStartPositionOfChar`/`getExtentOfChar` (kerning/anchor baked; skip whitespace) — visually identical. Animate each glyph independently: captures sample the trajectory field at the glyph's (u,v) + lean along local slope (rotation from field gradient, sample at u+0.08); presets get `computeMotion(params, u·2.2, …)` PLUS an explicit traveling wave `dy += 4·amplitude·intensity·(0.3+phaseSpread)·sin(2πf·t − u·2π·(0.5+phaseSpread))` and matching cos rotation (without this, horizontal motions leave letters in near-lockstep — measured). Verification: max instantaneous inter-letter spread must be >2px (rigid block = 0).

Pause/reset: restore every `path[data-ms-d0]`, remove glyph transforms, clear caches (`_wave`, `_field`, `_text`). Switching motions invalidates caches too.

## Motion library UI — "particle swatch" chips

NOT cards-with-video-thumbnails. Each motion = a Pantone-style square chip (72px, retina 2×) + name caption. Inside: a 5×5 lattice of dots in the motion's color over a faint rest-lattice, with motion-blur trails (fade with `rgba(bg,0.28)` fill instead of clearRect). **Presets:** dots driven by the real `computeMotion` with per-dot spatial seeds. **Captures:** dots replay 25 of the 144 real trajectories (subsample 12×12→5×5, start-relative, ping-pong) — a captured flag chip shows only flag-region dots whipping; provenance is visible in the UI itself. One shared rAF loop for all chips.

## The extraction moment (`extractviz.js`)

After a successful capture, play a ~5s skippable modal: the uploaded clip (dimmed) with the 144 trajectories drawn as glowing streaklines (windowed trails, alpha ∝ energy; skip near-static tracks), then a 1.5s sweep collapsing the streaks toward the library while a monospace readout counts the extracted numbers up (frequency… direction… amplitude… turbulence… drift). This is what makes "extraction" feel real instead of "a file uploaded and a preset appeared".

## Multi-motion picker (`multipick.js`)

Runs BEFORE the extraction moment, only when the service returns `regions.length ≥ 2`. Modal has two panes: on the left a looping `<video>` behind a canvas that draws each region's trajectories in its own color (per-region trail windowing, alpha ∝ energy) + a dashed labeled bounding box; on the right a scrollable stack of cards, one per region: a checkbox (default on), an editable name input (prefilled with `suggested_name`), and a compact params summary (`freq Hz · dir° · amp · turb · drift↓/→`). Clicking a card body (not the input) *solos* it — only that region's streaklines draw so you can preview it in isolation. Save disabled when everything is unchecked. Save returns the checked regions as a `Motion[]` (each with a unique id, user-supplied name, params, trajectories, trajFps, videoUrl shared with siblings, bbox, color) → `main.js` adds them all to the library. Cancel returns `[]` and the caller revokes the shared `videoUrl`.

The picker replaces the single-motion extraction moment for multi-motion clips — showing streaklines for one region then five more would take forever and dilute the "one big moment". Single-motion clips still get the full extraction sweep.

## Capture client (`capture.js`)

`serviceAvailable()`: GET /health with 800ms AbortController timeout. `captureFromFile(file)`: if service up → POST /analyze → motion object `{…, engine, trajectories, trajFps: j.fps, videoUrl: URL.createObjectURL(file), regions: j.regions || [], framesAnalyzed: j.frames_analyzed}` (keep the object URL — chips/extraction/picker use it). On any service failure → **silent fallback** to in-browser Lucas–Kanade (16×12 grid, 7×7 window, min-eigenvalue texture test, ±6px clamp, 4s @30fps → same distill math in JS; engine `browser-lk`, no trajectories, no regions).

## Exports

**Animated SVG** (`buildExportSVG`): clone the artwork; strip `#ms-highlights` and live transforms; per animated selection bake:
- Rigid → CSS `@keyframes` in a `<style>` inside the SVG (transform keyframes on `[data-ms-export=msxN]`, `transform-box:fill-box`). Loop seams: snap frequency to whole cycles/loop; drift loop = exactly one sawtooth; noise crossfaded over the final 12%.
- Cloth/field → **SMIL** `<animate attributeName="d" values="…">` (CSS cannot animate `d` inside `<img>`); field bakes over one ping-pong period (inherently seamless), sine over one cycle at 24–60 steps.
- Glyph text → the clone's inner markup is rebuilt from the live (split) wrap; each glyph gets **nested groups**: outer `<g>` + `animateTransform type="translate"`, inner `<g>` + `animateTransform type="rotate"` (SMIL allows one transform type per element).
The file must animate as a plain `<img src>` — that is the acceptance test.

**Video** (`exportVideo`): serialize the live SVG each frame → draw to canvas → `canvas.captureStream(30)` + MediaRecorder (prefer `video/mp4;codecs=avc1`, fall back `video/webm;codecs=vp9`). "reel" mode = 1080×1920: blurred cover-fill of the artwork behind, sharp artwork centered. Default 8s.

## Shell UI

Header: brand · scene tabs (**Poster** | **Scenery**) · Play/Pause · Export SVG · Export video · Upload artwork. Left panel: motion chip grid + "Capture motion from video" upload. Right panel: Region Inspector (name, assigned motion badge, Speed 0.1–3×, Intensity 0–2×, "Cloth mode" checkbox, remove/delete). Footer status line. Dark UI (bg #0d0d12, panels #16161e, accent #6e5cff). Artwork stage: 800×500 container; overlay canvas synced to the same basis.

**Built-in artwork #1 — Poster** (`poster.js`, boot scene): night-blue gradient, static pole (backdrop), one big coral pennant `data-name="flag"` (drawn as a wavy 4-curve cloth path), and `data-name="title"`: "WILDER VALLEY" 64px bold + "TREKS & STAYS · EST. 2019" subline. Two selectable objects only — Act 1 of the demo.
**Built-in artwork #2 — Scenery** (`scenery.js`): golden-hour autumn lake, 12 selectable objects: sun (low, glowing), cloud 1/2, birds, mountains (3 rim-lit bezier ridge planes — smooth curves, NOT zigzag triangles; atmospheric haze between planes), mist, river (sky-mirroring gradient + sun-glint path), boat (silhouette on the glint), flag (cloth on a jetty pole; pole static), tree 1 (autumn maple: trunk path + ~13 overlapping foliage circles in 5 rust/amber tones), tree 2 (backlit pine), leaves (6–9 scattered leaf paths near the maple). Backdrops (sky, ground/jetty, vignette) are id-only, non-selectable. Craft bar: one light source, rim light on sun-facing edges, graded vignette — must not look like flat clip-art.

---

# PART 3 — Travel website (`travel-site/`)

Warm-paper editorial site for "▲ WILDER VALLEY — Treks & Stays" (cream bg #faf7f2, burnt-orange accent #d96b2f, serif). Sections: sticky nav (Book a trek pill) → **hero** → stats band (48km trails · 4 rooms · 6 guides · 1,900m) → 3 trek cards with real photos + prices (₹2,400/3,900/4,600) + Book buttons → 3-photo gallery strip → "The lakeside hut" section over a moody photo w/ dark overlay + guest quote → closing CTA band → footer. Photos: download 7 landscape images from Unsplash at build time (waterfall, turquoise lake w/ boats, trekkers, dawn peaks, forest path, tent view, misty valley) into `assets/img/`.

**The hero is the demo mechanic:** `<img src="assets/hero.svg" id="hero-img">` — the static export of the tool's Scenery artwork, with headline copy overlaid ("Three days in the valley. A different pace of time."). Plus a frosted-glass "⬆ Upload new image" button (top-right of the hero) and drag-&-drop onto the hero: both swap `hero-img.src` to an object URL of the chosen file **live, no reload** (revoke the previous URL; flash the button green). Demo beat: export animated SVG from the tool → upload → the site's hero comes alive in place. Keep `assets/hero-static.svg` as the reset copy.

# PART 4 — Comic website (`comic/`)

Night-ink reading site for "✦ WILDER COMICS", issue: *The Night the Wind Came*. Palette: deep night #171528, aged paper #f3ead8, red accent #d9503e, Georgia serif.

- **Cover hero:** a 3:4 comic cover card (gradient dusk art + glowing moon + title block) that tilts on hover, next to the pitch copy: "Comics have been frozen for a hundred years. This one breathes." + "Open the book →" button.
- **The book:** clicking Open hides the cover and reveals a two-page spread (CSS grid: page | 10px spine gradient | page) with a 0.7s perspective `rotateY` opening animation, paper gradients toward the spine, folio page numbers. **Each page holds 2 panels** (4 total), each panel: black 2.5px comic border + offset shadow, an `<img>` of the panel SVG, a hover ⟳ button + hidden file input, and drag-&-drop — swapping shows a "✓ animated" tag that fades. Hint line below the book.
- **Panels** (each 400×300 SVG following the same `class="layer" data-name` contract so they open directly in Motion Swatch, with caption boxes in Georgia italic on cream): 1 "The village was still." (dusk, hut w/ lit window, flag on pole, tree, clouds) · 2 "Then the wind arrived." (bending trees, 6 flying leaves, grass tufts, heavy clouds) · 3 "The lake rose to meet it." (waves group, rowboat w/ sail, 8 slanted rain strokes, storm clouds) · 4 "By morning, only the candle remembered." (interior: window with dawn + mist + far hills, table, candle with flame + smoke as separate selectable layers).
- Below: a bookshelf of 4 fake spine cards (vertical writing-mode titles, hover-lift), an About quote ("We stopped asking illustrators to imagine motion. We started asking them to *go film it.*"), footer.

Story→motion mapping is deliberate: flag→flag capture, leaves→falling-leaves capture, waves+rain→water capture, flame+smoke→candle capture.

---

# PART 5 — Verification (non-negotiable)

Test in **real headless Chrome** (puppeteer-core driving the system Chrome; `--autoplay-policy=no-user-gesture-required` where video plays). Never claim something works without one of these passing:
1. **Click-to-select:** dispatch a real MouseEvent at an object's screen center → exactly one selection with the right name. Also with uploaded SVGs in three flavors: Figma-style (no ids, clip-path), Illustrator-style (named layer containers + `<style>`), Canva-style (anonymous nested transforms). Selections must be tight units (<70% canvas coverage), not layer containers.
2. **Motion truly animates:** sample the wrap transform / path `d` / glyph transforms 5× over 600ms → ≥2 distinct values; pause restores pristine state exactly.
3. **Preset visibility:** every preset ≥3px on-screen travel in 2s.
4. **Extraction accuracy:** synthesize an H.264 clip of a block swaying at exactly 0.8Hz horizontally → upload through the real UI → extracted frequency within ±0.15Hz, direction ≈0°, phaseSpread ≈0; **the applied motion must oscillate horizontally at ≈0.8Hz** (this proves field replay: a hardcoded vertical sine fails it).
5. **Exports run standalone:** load the exported SVG as a plain `<img>` on a bare page → 3 screenshots 400ms apart must differ. Same for the swapped-in travel hero and comic panels.
6. **Service ground truth:** benchmark suite 12/12 (Part 1).
7. Zero `pageerror`/`console.error` in every run.

Work incrementally, verify each stage before the next, and when a test fails, diagnose with a minimal probe (e.g. `document.elementFromPoint`, transform sampling) rather than guessing.
