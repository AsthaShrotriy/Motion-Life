# Motion Swatch POC — Complete Implementation Specification

> This document is a self-contained build spec. Another engineer or model should be able to reproduce the app **identically** from this file alone. It describes the concept, architecture, every module's responsibilities and exact algorithms, the two hard bugs that were fixed and why the fixes work, the data model, the full user flows, and a verification harness.

---

## 1. What this is

**Motion Swatch** is a browser-only proof-of-concept for an Adobe-Sneaks-style idea: *capture motion from the real world (or pick a preset), then paint that motion onto individual objects in a piece of static artwork.*

The demo shows a scenic poster (sky, sun, clouds, mountains, waterfall, river, trees, hut, flag, title). The user:
1. Picks a **motion** from a library on the left (or uploads a video and the app extracts its motion).
2. **Selects an object** in the artwork — by *clicking* it (SVG artwork) or *drawing a rectangle* around it (raster images).
3. The motion is applied to just that object. Multiple objects can each carry a different motion.
4. Hitting **Play** animates every assigned object simultaneously and independently.

There is **no backend, no build step, no dependencies**. It is plain HTML + CSS + vanilla JS using Canvas 2D and inline SVG. Serve the folder over any static HTTP server.

### Key product principles (do not violate)
- **A motion is parametric, not a baked recording.** It is six numbers (see §5). The same motion applies to any object at any size. This is the core differentiator vs. a video clip.
- **Selection binds to a concrete DOM node**, never to a geometric guess. The animator transforms exactly the node the user picked.
- **SVG is the first-class artwork format** (clickable elements, infinite resolution). Raster (PNG/JPEG) is supported via a fallback clone-and-transform path.

---

## 2. File tree

```
motion-swatch-poc/
├── index.html          # DOM skeleton + script load order
├── css/
│   └── style.css       # all styling (3-column dark UI)
└── js/
    ├── flow.js         # Lucas–Kanade optical flow (used by capture.js)
    ├── distill.js      # flow tensor → 6 motion parameters
    ├── motions.js      # MotionLibrary class + 6 presets
    ├── scenery.js      # builds the default inline SVG poster
    ├── regions.js      # SelectionManager: click-select (SVG) + rect-draw (raster)
    ├── animate.js      # Animator: per-object parametric displacement each frame
    ├── extractviz.js   # single-motion "extraction moment" modal
    ├── multipick.js    # multi-motion picker modal (regions ≥ 2)
    ├── capture.js      # MotionCapture: uploaded video → new motion via flow+distill
    └── main.js         # app controller: wires UI, library, selection, animator
```

**Script load order matters** (no modules/bundler; everything attaches to `window`). Load in exactly this order:
`flow.js → distill.js → motions.js → scenery.js → poster.js → regions.js → animate.js → export.js → videoexport.js → extractviz.js → multipick.js → capture.js → main.js`.

Each file exposes its class/functions on `window` (e.g. `window.SelectionManager`, `window.distillSwatch`).

---

## 3. Architecture at a glance

```
                    ┌──────────────────────────────────────────┐
                    │                main.js                    │
                    │  (controller: owns instances, wires UI)   │
                    └───┬───────────┬────────────┬──────────────┘
                        │           │            │
          ┌─────────────▼──┐  ┌─────▼──────┐  ┌──▼───────────────┐
          │ MotionLibrary  │  │ Selection  │  │   Animator       │
          │ (motions.js)   │  │ Manager    │  │  (animate.js)    │
          │ presets + add  │  │(regions.js)│  │ requestAnimation │
          └────────────────┘  └─────┬──────┘  │ Frame loop       │
                        ▲            │         └──┬───────────────┘
                        │            │            │ reads selections + their
             ┌──────────┴──┐   ┌─────▼─────┐      │ motionId, writes transforms
             │MotionCapture│   │ scenery.js│      │
             │ (capture.js)│   │ builds SVG│      ▼
             │ flow+distill│   └───────────┘   SVG <g> transform attr
             └──────┬──────┘                   OR raster clone CSS transform
                    │
          ┌─────────▼─────────┐
          │ flow.js + distill │
          │ (video → params)  │
          └───────────────────┘
```

Data flows one direction: `main.js` owns the three core objects, wires DOM events to them, and the `Animator` reads the `SelectionManager`'s list every frame and writes transforms.

---

## 4. The two critical bugs that were fixed (READ THIS — the design exists to avoid them)

The first version of this POC had two bugs that made it appear completely broken. The current architecture is shaped specifically to prevent them. **If you re-implement, do not regress these.**

### Bug 1 — SVG objects were not clickable
**Symptom:** clicking a cloud did nothing; you could only draw rectangles.
**Cause:** a full-size `<canvas id="selection-overlay">` sat on top of the artwork with `pointer-events: auto` permanently on. It intercepted every click before it could reach the SVG underneath. Verified via `document.elementFromPoint(cloudX, cloudY)` returning `"selection-overlay"`.
**Fix:** the overlay's `pointer-events` is toggled by mode:
- **SVG mode:** `overlay.style.pointerEvents = 'none'` → clicks pass through to the SVG, which has a delegated `click` listener that selects the nearest `.ms-wrap` ancestor via `element.closest('.ms-wrap')`.
- **Raster mode:** `overlay.style.pointerEvents = 'auto'` (+ class `drawing`) → the overlay captures mouse events for rectangle drawing (you cannot click "into" a flat bitmap).

### Bug 2 — motion did not apply to a region
**Symptom:** assigning a motion to a drawn box moved nothing, or moved the whole scene.
**Two compounding causes:**
1. **Center-in-box matching.** The old code matched a drawn rectangle to SVG groups by testing whether the *group's bounding-box center* fell inside the rectangle. But scene groups like `clouds` (540px wide) or `river`/`mountains` (full 800px) have their center at scene-center, so a box drawn around one object almost never contained the group center → no match → nothing animated. Even on a match, it moved the entire group (all clouds), not the one picked.
2. **CSS transform vs. SVG transform attribute conflict.** SVG groups in the scene already carry a positioning attribute like `transform="translate(380,45)"`. Setting a **CSS** `transform` (via `element.style.transform`) on such an element **replaces** the attribute-based positioning, teleporting the element. Verified: a cloud jumped **-360px** on screen.

**Fix (both):**
- **No geometric matching.** Every selectable unit is wrapped at attach-time in a fresh empty `<g class="ms-wrap">`. The selection stores a **direct reference** to that wrapper. The animator sets the wrapper's SVG `transform` **attribute** (`wrap.setAttribute('transform', ...)`), not a CSS transform. Because the wrapper starts with no transform of its own, there is no conflict; the inner element keeps its original attribute-based position and the wrapper adds motion on top.
- Verified in real Chrome: `wrap.setAttribute('transform','translate(20,10)')` moved the element by exactly `{dx:20, dy:10}`, and updating the attribute tracked continuously — while the CSS approach on the same element produced `{dx:-360}`.

> **Takeaway rule:** to animate an SVG element that may already have a transform, wrap it in an empty `<g>` and animate the wrapper's transform *attribute*. To animate a raster region, animate a floating DOM clone's CSS transform (raster clones are plain `<div>`s with no attribute conflict, so CSS transform is fine there).

---

## 5. The motion data model

A **motion** is a plain object:

```js
{
  id: 'waterfall-flow',          // unique string
  name: 'Waterfall Flow',        // display name
  desc: 'Fast downward stream…', // one-line description shown on the card
  color: '#4cc9ff',              // accent color for the card + preview bars
  params: {
    frequency,    // Hz — oscillations per second of the dominant motion
    amplitude,    // 0..1 — how far it moves (scaled to pixels in the animator)
    direction,    // degrees 0..180 — axis of oscillation (0 = horizontal →, 90 = vertical ↑)
    turbulence,   // 0..1 — how much chaotic curl-noise jitter is added
    damping,      // 0..1 — 0 = steady oscillation, 1 = gusty/decaying envelope
    phaseSpread   // 0..1 — phase offset spread (used as a per-object phase seed factor)
  }
}
```

### The 6 presets (exact values — reproduce verbatim)

| id | name | freq | amp | dir | turb | damp | phaseSpread | color |
|---|---|---|---|---|---|---|---|---|
| `waterfall-flow` | Waterfall Flow | 2.8 | 0.6 | 90 | 0.55 | 0.1 | 0.7 | `#4cc9ff` |
| `cloud-drift` | Cloud Drift | 0.35 | 0.9 | 0 | 0.03 | 0.0 | 0.1 | `#b8b8cc` |
| `flag-flutter` | Flag Flutter | 3.5 | 0.4 | 10 | 0.35 | 0.2 | 0.85 | `#ff5c5c` |
| `gentle-sway` | Gentle Sway | 0.4 | 0.45 | 0 | 0.08 | 0.12 | 0.5 | `#3ddc84` |
| `water-ripple` | Water Ripple | 1.0 | 0.2 | 0 | 0.25 | 0.15 | 0.9 | `#3a7abf` |
| `sun-pulse` | Sun Pulse | 0.6 | 0.4 | 90 | 0.0 | 0.0 | 0.0 | `#ffd93d` |
| `falling-leaves` | Falling Leaves | 0.5 | 0.3 | 0 | 0.25 | 0.3 | 0.8 | `#e8a33d` |
| `rising-smoke` | Rising Smoke | 0.3 | 0.25 | 0 | 0.3 | 0.2 | 0.6 | `#c9c4d4` |

The last two also carry drift: `falling-leaves` has `driftX:0, driftY:0.5`; `rising-smoke` has `driftX:0.05, driftY:-0.55`. `driftX/driftY` (−1..1) are optional on any motion — extracted by the service from steady directional travel and rendered by the animator as a slow travel-and-ease-back loop (`DRIFT_PX=26` units over a `DRIFT_PERIOD=10`s sawtooth: ramp out 85% of the period, ease back 15%). Preview sprites: 🍂 and 💨.

> **Tuning note (important, learned from testing):** `cloud-drift` was originally `frequency:0.08, amplitude:0.25` which produced only ~1.9px of travel over 2 seconds — it looked frozen and read as "broken." A preset must produce **≥ ~3px of visible on-screen travel within ~2s** or users think it failed. `sun-pulse` was similarly bumped. When adding presets, verify visible travel (see §11 visibility test).

A **selection/region** is:

```js
{
  id, name, color,
  kind: 'svg' | 'rect',
  // svg mode:
  wrap,        // the <g class="ms-wrap"> DOM node we animate (transform attribute)
  center,      // [cx, cy] in viewBox units — rotation origin
  // raster mode:
  floatEl,     // the floating <div> clone we animate (CSS transform)
  bounds,      // {x, y, w, h} in overlay/displayed-pixel units
  // both:
  motionId,    // id of assigned motion, or null
  speed,       // playback speed multiplier, default 1.0
  intensity    // displacement multiplier, default 1.0
}
```

---

## 6. Module specifications

### 6.1 `flow.js` — optical flow (Lucas–Kanade)
Purpose: given successive video frames, produce a sparse motion field. Only used when the user uploads a video (via `capture.js`).

Constants: `FLOW_W=160, FLOW_H=120` (downscale target), `GRID_X=16, GRID_Y=12` (192 sample points), `WIN=3` (7×7 window), `MIN_EIG=40` (texture threshold), `MAX_V=6` (flow clamp).

Class `FlowTracker`:
- `constructor()` builds an offscreen 160×120 canvas (`willReadFrequently:true`) and a grid of 192 point coords at cell centers.
- `reset()` clears `this.prev`.
- `grayFrame(source)` draws `source` into the offscreen canvas, reads pixels, returns a `Float32Array` of luminance (`0.299R + 0.587G + 0.114B`).
- `step(source)` → returns `null` on the first frame (stores it as `prev`). Otherwise, for each grid point, accumulates the structure tensor over the window:
  - `Ix = (prev[i+1]-prev[i-1])*0.5`, `Iy = (prev[i+W]-prev[i-W])*0.5`, `It = cur[i]-prev[i]`.
  - Sums `sxx=ΣIx², sxy=ΣIxIy, syy=ΣIy², sxt=ΣIxIt, syt=ΣIyIt`.
  - Reject if the smaller eigenvalue `(tr/2 - sqrt(tr²/4 - det)) < MIN_EIG` or `det==0` → `{valid:false, vx:0, vy:0}`.
  - Else solve `vx=(-syy·sxt + sxy·syt)/det`, `vy=(sxy·sxt - sxx·syt)/det`, clamp to ±`MAX_V`.
  - Returns array of `{x, y, vx, vy, valid}` (192 entries). Updates `this.prev = cur`.

Exposes `window.FlowTracker` and `window.FLOW_DIMS = {FLOW_W, FLOW_H, GRID_X, GRID_Y}`.

### 6.2 `distill.js` — flow tensor → 6 parameters
Function `distillSwatch(frames, fps)` where `frames` is an array (length T) of per-frame flow arrays. Returns `null` if `T < 16`, else `{frequency, amplitude, direction, turbulence, damping, phaseSpread}`.

Algorithm:
1. **Global signal:** per frame, average `vx,vy` over valid points → `gvx[t], gvy[t]`. Subtract the mean (remove DC drift) so we analyze oscillation.
2. **Dominant axis (direction):** compute covariance `cxx,cxy,cyy` of `(gvx,gvy)` over time; take the major eigenvector. Convert to degrees with `atan2(-ay, ax)` (flip y because screen-y grows downward), fold into `[0,180)`.
3. **Project** the global signal onto that axis → 1-D `proj[t]`.
4. **Frequency:** DFT of `proj` for bins `1..T/2` (plain O(T²) DFT is fine for T≈128). Peak bin → Hz via `binHz = fps/T`. Refine with parabolic interpolation on log-magnitude of the 3 bins around the peak. Clamp to `[0.05, 8]`.
5. **Amplitude:** RMS of `(gvx,gvy)` normalized by `1.5` (empirical), clamped `0..1`.
6. **Turbulence:** `0.5*spectralFlatness + 0.5*spatialDisorder`.
   - *spectralFlatness* = geometric-mean/arithmetic-mean of the power spectrum (1 = white noise, 0 = pure tone).
   - *spatialDisorder* = average over frames of `1 - R`, where `R` is the magnitude-weighted resultant length of per-point flow directions (1 = all aligned, 0 = chaotic).
7. **Damping:** `1 - |autocorr(proj, lag=round(fps/freq))|`. Sustained oscillation keeps autocorrelation high → low damping.
8. **phaseSpread:** for each grid point, compute its DFT phase at the dominant bin (projected on the axis); take circular variance across points (`1 - resultantLength`). Whole-scene-in-unison → low; traveling wave → high.

All helpers are file-local (`_mean, _clamp, _r3, _dft, _spectralFlatness, _spatialDisorder, _autocorrDecay, _phaseSpread`). Exposes `window.distillSwatch`.

### 6.3 `motions.js` — library
`MOTION_PRESETS` array (values in §5 table). Class `MotionLibrary`:
- `this.motions = [...MOTION_PRESETS]`, `this.selectedId = null`.
- `getAll()`, `getById(id)`, `add(motion)`, `select(id)`, `getSelected()`.
Exposes `window.MotionLibrary`, `window.MOTION_PRESETS`.

### 6.4 `scenery.js` — default artwork
`createScenerySVG()` returns an `<svg viewBox="0 0 800 500">` DOM node (width/height 100%) — a dusk lake-valley poster. Structure:
- Non-selectable backdrops are id-only groups/elements: `<g id="sky">` (gradient + stars), `<g id="ground">`. **No `.layer` class** so they cannot be selected/animated.
- Every selectable object is `<g class="layer" data-name="…">` — 21 units: `sun`, `cloud 1/2/3`, `birds`, `mountains`, `cliffs`, `waterfall`, `mist`, `river`, `boat`, `hut`, `smoke`, `flag`, `tree 1/2/3`, `leaves`, `reeds left/right`, `title`.
- **Objects are chosen so every motion type has a natural target:** smoke → Rising Smoke (upward drift), leaves → Falling Leaves (downward drift), boat → Water Ripple, birds/clouds → drift, mist → turbulence, reeds/trees → Gentle Sway, waterfall → Waterfall Flow, sun → Sun Pulse, flag → Flag Flutter.
- `<defs>` holds gradients `sky-grad` (night-to-sunset vertical), `sun-glow` (radial), `water-grad`, `fall-grad`. Helper functions build repeated markup (pine trees, reeds, leaves, birds, waterfall streams, stars).
- The clouds are **separate** `.layer` groups each pre-positioned with `transform="translate(x,y)"` — this is exactly why the wrapper approach (§4) is required.
- Note: the `leaves` group is spatially scattered, so its selection bbox is wide — acceptable, but don't "fix" it by merging leaves into a tight cluster; scattered leaves + drift reads better.

Exact SVG content is in the source file; reproduce shapes faithfully but the **contract that matters** is: selectable = `.layer[data-name]`, backdrops = id-only, viewBox is `0 0 800 500`.

Exposes `window.createScenerySVG`.

### 6.5 `regions.js` — SelectionManager (the heart of selection)
Constants: `REGION_COLORS` (8 hex colors, cycled per new selection), `SVGNS = 'http://www.w3.org/2000/svg'`.

Class `SelectionManager(overlay, artworkContainer)`:
- State: `selections=[]`, `activeIdx=-1`, `mode='svg'|'raster'`, `tool='rect'`, drawing state, callbacks `onCreated`, `onSelected`.
- `attachSVG(svg)`:
  - set `mode='svg'`, clear previous, **`overlay.style.pointerEvents = 'none'`** (Bug 1 fix).
  - `_wrapSelectableUnits(svg)`: for each `.layer[data-name]` (or, for uploaded SVGs with no `.layer`, each `[id]` drawable, else top-level drawable children), wrap it in a `<g class="ms-wrap" data-ms-name="…">` inserted before it, then move the element inside. Skip elements already inside an `.ms-wrap`.
  - install a single delegated `click` listener on the svg: `e.target.closest('.ms-wrap')` → if already a selection, reselect it; else `_createSVGSelection(wrap)`.
- `attachRaster()`: set `mode='raster'`, clear, **`overlay.style.pointerEvents='auto'`**, add `drawing` class.
- `_createSVGSelection(wrap)`: compute `wrap.getBBox()` for `center`, push a `kind:'svg'` selection holding the `wrap` reference, set active, redraw highlights, fire `onCreated`.
- `_renderSVGHighlights()`: (re)draw dashed selection rectangles + name labels **inside the SVG** in a `<g id="ms-highlights" pointer-events="none">` so they travel with animation. Each highlight copies its target wrap's current `transform` so it stays glued.
- `syncHighlights()`: called every animation frame — copies each wrap's live `transform` onto its highlight rect+label so the dashed box follows the moving object.
- Raster tool: `mousedown/move/up` on the overlay draw a rubber-band rectangle (canvas 2D, dashed). On mouseup with a box ≥12px, `prompt()` for a name, then `_createRasterSelection(name, bounds)`.
- `_createRasterSelection`: build a floating `<div>` positioned as % of the container, `overflow:hidden`, containing an inner `<div>` with the artwork image as `background-image` offset/scaled so the visible slice matches the selected region. Append to container. Store `kind:'rect'` selection with `floatEl` + `bounds`.
- `selectByIndex`, `getActive`, `deleteActive` (removes floatEl / resets wrap transform), `resize`, `redraw` (raster highlights on the canvas overlay; svg highlights are in-SVG).

Exposes `window.SelectionManager`, `window.REGION_COLORS`.

### 6.6 `animate.js` — Animator (the displacement math)
Constants: `AMP_PX=16` (viewBox units at amplitude 1), `TURB_PX=11`.
File-local noise helpers: `_hash`, `_noise` (value noise), `_curl(x,y,t)` (two decorrelated noise channels → pseudo-curl vector), `_env(t, damping, seed)` (damping envelope: ~1 when damping≈0; gusty `pow(noise, 1+damping*4)` when high).

Class `Animator(selectionManager, motionLibrary)`:
- `play()` sets `t0 = now`, starts RAF loop. `pause()` cancels RAF and `_reset()`s all transforms. `toggle()`.
- `_tick()`: each frame compute `t = now - t0`, call `_applyAll(t)`, then `sel.syncHighlights()`.
- `_applyAll(t)`: for each selection with a `motionId`:
  - `rt = t * speed`; `seed` derived from the object's center (svg) or bounds (raster) so different objects are out of phase.
  - Compute:
    - `dir = {cos(θ), -sin(θ)}` where θ = direction in radians.
    - `env = _env(rt, damping, seed)`.
    - `osc = sin(2π·freq·rt + seed·phaseSpread·3.0)`.
    - `turb = _curl(seed·40, seed·70, rt+seed)`.
    - `A = amplitude · AMP_PX · intensity · env`.
    - `dx = A·osc·dir.x + turbulence·TURB_PX·turb.x·env·intensity`.
    - `dy = A·osc·dir.y + turbulence·TURB_PX·turb.y·env·intensity`.
    - `rot = (0.06·amplitude·intensity·env·cos(2π·freq·rt)) · (180/π)` degrees.
  - **SVG:** `wrap.setAttribute('transform', 'translate(dx dy) rotate(rot cx cy)')` — rotate around the object's own center `[cx,cy]`. (Attribute, not CSS — Bug 2 fix.)
  - **Raster:** convert `dx,dy` from viewBox units to displayed px using the overlay's client rect ratio, then `floatEl.style.transform = 'translate(pxX, pxY) rotate(rot deg)'`, `transformOrigin: center center`.
- `_reset()`: clear every wrap's transform attribute / floatEl CSS transform, then `syncHighlights()`.

Exposes `window.Animator`.

### 6.6d Multi-motion picker (`multipick.js`) — the pick-and-name UI

Runs BEFORE the extraction moment, only when `regions.length ≥ 2`. Function signature: `showMultiPick(videoUrl, regions, {engine, framesAnalyzed, fps}) → Promise<Motion[]>`.

Layout: modal with a header (title + region count + engine info + ✕), a two-column body (left: 16:10 stage containing looping `<video>` + trajectory canvas; right: scrollable card stack), and a footer (hint text + Cancel + Save). Card contents per region: a checkbox (defaults on, `accent-color` = region color), an editable name input (prefilled with `region.suggested_name`), and a compact params row (`freq Hz · dir° · amp · turb`, plus optional `drift↓`/`drift→` chips when the drift magnitude > 0.15). Click a card body (not the input/checkbox) to *solo* — only that region's streaklines draw.

Draw loop (per-region, per rAF): for each visible region, iterate its 144 trajectories; window a 14-frame trail from `(t / video.duration) * (T-1)`; skip near-static tracks (`Δ < 0.0015` in normalized coords); stroke segments in the region color with alpha ∝ segment position × per-track energy. Then draw the dashed bounding box + a rounded label chip anchored to the box's top-left (clamped inside the frame). Solo state overrides selection — if any card is soloed, only its trajectories/box draws.

Save collects the checked regions, builds one `Motion` each (`id: 'uploaded-<ts>-<idx>'`, `name: user text || suggested_name`, `params`, `trajectories`, `trajFps`, `videoUrl` shared with siblings, `bbox`, `color`, `engine`, `fromUpload: true`), closes the modal, resolves the promise with the list. Cancel/✕ resolves with `[]` and `main.js` revokes the shared `videoUrl`.

CSS: `.multipick-modal` mirrors `.extract-modal` (fixed inset 0, dark backdrop, 220ms close animation). `.mp-card` has a colored left border via `--region-color` custom property, an `.unselected` state (0.4 opacity), a `.soloed` state (highlight ring).

### 6.7 `capture.js` — MotionCapture (video upload → motion)

**Two-tier design.** The preferred path is a local deep-learning analysis service (`service/server.py`, see §6.9) running **torchvision's pretrained RAFT optical-flow model**; the in-browser Lucas–Kanade path is the fallback when the service isn't running. Same output contract either way.

Class `MotionCapture`:
- `SERVICE_URL = 'http://127.0.0.1:8765'`.
- `async serviceAvailable()`: `GET /health` with an 800ms `AbortController` timeout; returns the health JSON or `null`.
- `async captureFromFile(file)`: if the service is up, `POST /analyze` with the file as multipart form data. On `{ok:true}` build the motion from `j.params`, keep `j.trajectories` (144 grid point-tracks, reserved for future richer transfer), set `engine: j.engine` (e.g. `"raft_small@mps"`), and `videoUrl: URL.createObjectURL(file)` for the card thumbnail. On service failure or unreachability, fall through to `captureLocally(file)` (the original in-browser path, `engine: 'browser-lk'`).
- `async captureLocally(file)`:
  - Create an object URL, load into a hidden `<video>` (`muted`, `playsInline`), wait for `loadeddata`, seek to 0, `play()`.
  - `reset()` the tracker. Sample at 30fps up to `min(4s, duration)` via `setInterval(1000/30)`: each tick call `flow.step(video)`, push non-null results, report progress. Stop when the video ends or the frame budget is hit.
  - If `< 16` frames collected → revoke the object URL and resolve `null`. Else `distillSwatch(frames, 30)`; if params, build a motion `{id:'uploaded-'+Date.now(), name:file-name-without-ext, desc:'Captured from uploaded video', color:'#ff8a4c', params, fromUpload:true, videoUrl:url}`, fire `onComplete`, resolve it.
- **On success the object URL is intentionally NOT revoked** — `videoUrl` keeps it alive so the library card can show the actual clip as a looping thumbnail. Only revoke on failure paths.

Exposes `window.MotionCapture`.

### 6.6b Cloth/wave mode (`animate.js` + `regions.js` + `export.js`)

Rigid transforms slide an object; cloth must ripple *through* its geometry. Wave mode deforms the actual path data each frame:

- **Selection flag:** `selection.waveMode` (boolean). Defaults to `true` when the object's name matches `/flag|banner|cloth|pennant|curtain|sail/i` (set in `_createSVGSelection`); manually toggleable via the inspector's "Cloth mode" checkbox (`#insp-wave`, SVG selections only).
- **Sampling** (`buildWaveData(wrap)`): every `<path>` in the selection is sampled into `WAVE_SAMPLES=48` points via `getPointAtLength`. The pristine `d` is stored on the element as `data-ms-d0` (idempotent — re-entry restores from it first). Closed paths (trailing `Z`) stay closed.
- **Per-frame displacement** (`waveD`): traveling wave `dy = A·ramp(x)·sin(2πf·t − k·(x−xmin)) + turb·ramp·noise`, plus a small `dx = 0.22·A·ramp·cos(...)` shear. `ramp(x) = ((x−xmin)/width)^1.15` anchors the pole edge (≈0 movement) and frees the tip — verified: tip moves >30× the root. `k = 2π·WAVE_CYCLES·(0.5+phaseSpread)/width` with `WAVE_CYCLES=1.5`; `A = WAVE_AMP_PX·(0.35+amplitude)·intensity` with `WAVE_AMP_PX=9`.
- In wave mode the wrap gets **no** rigid transform (`transform=""`); `_reset()`/pause restores every `path[data-ms-d0]` to pristine geometry and clears the `_wave` cache. Toggling the mode also restores + clears cache.
- **Export:** CSS cannot animate `d` inside an `<img>`, so wave selections are baked as **SMIL** — `<animate attributeName="d" values="..." dur="..." repeatCount="indefinite">` with 24 steps whose phase spans exactly 2π (geometrically perfect loop; the turbulence term is phase-driven so it loops too). Rigid selections still use CSS keyframes; the two coexist in one export. Verified animating as a plain `<img>`.

### 6.6c Trajectory-field replay (`animate.js`) — the realism engine for captures

Captured motions carry a 12×12 grid of **real point trajectories** from the source video (`motion.trajectories`, normalized coords, at `motion.trajFps`). For any capture applied to an SVG object, wave mode auto-enables and the geometry replays that field instead of a synthetic sine:

- `buildTrajField(motion)` → `sample(u, v, t) -> {dx, dy}`:
  - **Active-region detection:** per-track max displacement → cells above `max(0.004, 25% of peak)` define the moving window (±1 cell padding). The target object maps onto *that window only* — a flag filmed against sky doesn't freeze the artwork's edges with static background tracks.
  - Displacements are start-relative, **normalized by the active window size** (so motion scales to the object, not the video frame), capped at ±0.55 object-relative, bilinearly interpolated in space and linearly in time.
  - **Ping-pong looping** (forward then backward) → seamless, no end-snap; `sample.period = 2·(T−1)/fps` seconds.
- `fieldD(pd, minX, minY, w, h, field, t, intensity)` renders one frame: each sampled path point maps its (u,v) inside the object bbox to the field and displaces by `0.5·w/h·intensity`.
- Because neighboring points follow *different* real tracks, local stretch/compression — the wrinkle/foreshortening look — emerges automatically, and the same mechanism works for ANY captured motion (water churn, smoke curl), not just flags.
- Wiring (`_applyAll`): wave mode + trajectories → field replay; wave mode + preset → traveling sine (unchanged); cache `s._field` keyed by `s._fieldMotion`, invalidated on motion switch/pause/reset. `applyMotionToActive()` (main.js) auto-sets `waveMode = true` when the applied motion has trajectories.
- **Export:** field mode bakes to SMIL `d`-morph over one full ping-pong period (24–60 steps, inherently seamless). Verified animating as a plain `<img>`.
- Verified end-to-end (tests/trajfield.js): 0.8Hz *horizontal* ground-truth capture produces horizontal geometry oscillation at 0.80Hz measured — axis and frequency of the applied motion match the capture, which a fixed vertical sine could never do.

### 6.7b `export.js` — bake the scene into a self-contained animated .svg

`buildExportSVG(sel, motions)` — the "use it on a real website" step. The live app drives motion from JS; a website can't run that, so we bake: clone the scene SVG, strip `#ms-highlights` and any live wrap transforms, and for every animated selection sample `computeMotion()` over one loop period into CSS `@keyframes` embedded in a `<style>` element inside the SVG. Result: one `.svg` file that animates anywhere — including as a plain `<img src>`, where scripts are disabled but CSS animation still runs (this is the property to test).

Seamless-loop details (all three matter or the loop visibly pops):
- Wraps are tagged `data-ms-export="msx{i}"` before cloning so CSS selectors survive the clone; tags are removed from the live DOM after.
- **Sine seam:** frequency is snapped to a whole number of cycles per loop: `cycles = max(1, round(freq · D · speed))`.
- **Drift seam:** if the motion has drift, loop duration `D = DRIFT_PERIOD / speed` (exactly one sawtooth); otherwise `D = 8s`.
- **Noise seam:** turbulence/envelope noise doesn't loop, so the final 12% of samples cross-fade toward the values at `t − span`.
- ~15 keyframe samples/second (clamped 60–200 steps), `animation: … linear infinite`, `transform-box: fill-box; transform-origin: 50% 50%`.
- Keyframes bake `speed`/`intensity` at export time. UI: header button `#btn-export-svg` (SVG mode only), downloads `motion-swatch-poster.svg`.
- Verify: load the export as `<img>` on a bare HTML page, take 3 screenshots 400ms apart → they must differ (animation running), plus markup checks (has `<style>`, N `@keyframes`, no `ms-highlights`, no `<script`).

### 6.8 `service/` — RAFT analysis sidecar (Python, optional but preferred)

```
service/
├── server.py         # FastAPI app
├── requirements.txt  # torch, torchvision, numpy, opencv-python-headless, fastapi, uvicorn, python-multipart
├── run.sh            # creates venv on first run, starts uvicorn on 127.0.0.1:8765
└── smoke_raft.py     # ground-truth accuracy/speed check for RAFT on this machine
```

**Model choice and why** (verified against live repos/licenses in July 2026):
- **torchvision RAFT (`raft_small`)** — BSD-3-Clause, ships *inside* torchvision (no extra repo), 4MB checkpoint auto-downloads from `download.pytorch.org`, runs on Apple Silicon **MPS** out of the box (measured: ~18ms/pair at 320×240, ~60ms at 480p; err < 0.4px on known-shift synthetic frames). This is the engine used.
- Alternatives considered and rejected for now: **CoTracker3** (best-in-class point tracking but **CC-BY-NC** — non-commercial license blocker), **SEA-RAFT** (BSD-3, better accuracy, but needs repo vendoring — good upgrade path), **SAM2** (Apache-2.0, not a flow model — future click-to-segment raster selection), **FOMM/TPS/LIA/MRAA** (synthesize pixels rather than exporting motion; mostly stale or NC/no-license), **AnimatedDrawings** (MIT but solves the opposite problem: applies pre-made BVH mocap to humanoid sketches; does NOT extract motion from video), **in-browser neural flow** (no production ONNX/WebGPU port of RAFT-class models exists; OpenCV.js PyrLK is the only credible in-browser option — which is what the fallback JS already approximates).

**`server.py` spec:**
- Init: `DEVICE = 'mps' if available else 'cpu'`; `MODEL = raft_small(weights=Raft_Small_Weights.DEFAULT).eval().to(DEVICE)`. CORS `allow_origins=['*']` (localhost demo).
- Constants: `ANALYSIS_WIDTH=320` (downscale, height rounded to /8 as RAFT requires), `MAX_SECONDS=5`, `TARGET_FPS=15` (subsample source fps), `GRID=12`.
- `GET /health` → `{ok, engine, device}`.
- `POST /analyze` (multipart `file`) → decode via OpenCV (`read_frames`: fps-guarded subsampling, resize, RGB, float [0,1]) → `raft_flow_series`: run RAFT per consecutive pair, keep final iteration, giving dense flow `[T-1, 2, H, W]` in px/frame → `distill(flows, fps)`: a numpy port of `js/distill.js` operating on **dense** flow (global mean flow per frame, covariance eigenvector direction, rFFT peak + parabolic refinement for frequency, RMS/(0.005·W) amplitude, spectral-flatness × spatial-disorder turbulence — disorder computed per-pixel and averaged only over frames with real motion, damping via one-period-lag autocorrelation, phaseSpread via circular variance of per-cell FFT phase at the peak bin over a 12×12 cell grid, masked to cells with energy) → response `{ok, engine:'raft_small@mps', fps, frames_analyzed, params, trajectories}` where `trajectories` are 144 integrated grid point-tracks in normalized coords.
- Failure paths return `{ok:false, error}` — the client falls back to in-browser analysis.
- **Multi-motion segmentation** (`segment_regions`): on the same dense flow tensor, per-cell energy + covariance-derived direction + rFFT-derived freq bin on the 12×12 grid → global static-scene kill (magnitude-persistence ≥ 0.85 → return `[]`) → active mask with dual-floor gating (`energy ≥ 0.4 AND energy ≥ 0.35·peak`) → 1-cell dilate → 4-connected components (pure numpy flood-fill) → union-find merge of neighboring components with matching direction (< 20°, energy-weighted 2θ circular mean) + freq (< 25%) → size filter (≥ 5 cells) → per-region distill on pixel-mask-zeroed flows → per-region trajectories (in-region cells advance; out-of-region cells frozen at their start). Response gains a `regions[]` field: `[{params, trajectories, bbox:{x0,y0,x1,y1}, cells, suggested_name, color}]`. Empty on static, single-entry on single-motion, N-entry on multi-motion. Old callers reading top-level `params`/`trajectories` remain unaffected.

**Ground-truth validation (reproduce):** generate a 4s H.264 clip of a checkered block swaying horizontally at 0.8 Hz (OpenCV `VideoWriter`), POST it: expect `frequency ≈ 0.78`, `direction ≈ 0°`, `phaseSpread ≈ 0` (rigid body), turbulence low. The browser fallback on the same clip returns ≈ 0.78 Hz too — the two tiers agree.

> Note: browsers can't always decode `mp4v`-fourcc files; test fixtures must be H.264 (`ffmpeg -c:v libx264 -pix_fmt yuv420p`).

### 6.9 `main.js` — controller
Owns `library = new MotionLibrary()`, `sel = new SelectionManager(overlay, artContainer)`, `animator = new Animator(sel, library)`, `capture = new MotionCapture()`.

Responsibilities:
- `syncOverlay()`: set overlay canvas to 800×500 (viewBox basis) and CSS-size it to the container's client rect so 1 canvas unit == 1 viewBox unit.
- **Motion list rendering** (`renderMotionList`): one `.motion-card` per motion. Thumbnail rules:
  - **Uploaded motion** (`m.videoUrl` set): a real `<video class="thumb">` of the uploaded clip — `muted`, `loop`, `autoplay`, `playsInline` (64×48, `object-fit: cover`). `capture.js` keeps the object URL alive on the motion (`videoUrl`) instead of revoking it, precisely for this.
  - **Preset**: a 64×48 `<canvas class="thumb">` showing a themed emoji sprite (map `PREVIEW_SPRITES`: waterfall-flow → 💧, cloud-drift → ☁️, flag-flutter → 🚩, gentle-sway → 🌿, water-ripple → 🌊, sun-pulse → ☀️) plus a faint direction-axis line. One shared `requestAnimationFrame` loop (`previewLoop`) drives all preset canvases; each frame it calls the **same** `computeMotion(params, seed=0.7, t)` used by the Animator (exported from `animate.js`) and translates/rotates the sprite by `dx*0.55, dy*0.55, rot` — so a preview is literally the motion the object will get. Do NOT render abstract bars/waveforms; users read them as broken.
  - Clicking a card `library.select(id)`, re-renders, then `applyMotionToActive()`.
- `applyMotionToActive()`: if there's an active selection and a selected motion, set `selection.motionId` and refresh inspector + highlights. Returns the region name or null.
- **Artwork loading:**
  - `loadDefaultScenery()`: clear container, append `createScenerySVG()`, `syncOverlay()`, `sel.attachSVG(svg)`, `setModeUI('svg')`.
  - `loadUploadedSVG(text)`: inject SVG markup, ensure it has a `viewBox`, `sel.attachSVG`, report N selectable elements.
  - `loadRasterImage(dataUrl)`: set container to an `<img>`, `sel.attachRaster()`, `setModeUI('raster')`.
  - `setModeUI(mode)`: show/hide `#tool-controls`, update `#mode-hint` text.
- **Region chips** (`renderChips`): pill per selection; click → `sel.selectByIndex`.
- **Inspector** (`showInspector/hideInspector`): name input, assigned-motion badge, speed + intensity sliders (write back to the active selection live), Remove-motion, Delete-region buttons.
- **Play button:** guard "assign a motion to at least one object first"; else `animator.toggle()` and swap label ▶/⏸.
- **Upload motion video:** file input → `capture.captureFromFile`, progress into `#upload-status`, on success `library.add` + `renderMotionList`.
- **Upload artwork:** if `.svg`/`image/svg+xml` → `readAsText` → `loadUploadedSVG`; else `readAsDataURL` → `loadRasterImage`.
- Boot: `renderMotionList(); loadDefaultScenery();`.
- **Test hook:** `window.__ms = { sel, library, animator }` so a headless harness can drive it.

Callbacks wired: `sel.onCreated = (s)=>{renderChips(); showInspector(s); applyMotionToActive(); …}`, `sel.onSelected = (s)=>{renderChips(); showInspector(s);}`.

---

## 7. index.html (DOM contract)

Layout, with the **exact element ids** other modules depend on:

- `<header>`: `#btn-play`, `#btn-upload-art` + hidden `#art-input`.
- `<main>` is a 3-column CSS grid:
  - `#library-panel`: `#motion-list`, `#btn-upload-motion` + hidden `#motion-input`, `#upload-status`.
  - `#canvas-section`: `#canvas-wrap` containing `#artwork-container` (holds the SVG or `<img>`) and `#selection-overlay` (canvas, absolutely positioned on top). Toolbar: `#mode-hint`, `#tool-controls` (hidden in svg mode) with `#btn-tool-rect`, and `#region-chips`.
  - `#inspector-panel`: `#inspector-empty` and `#inspector-content` (hidden) with `#insp-name`, `#insp-motion-name`, `#insp-speed` (+`#insp-speed-val`), `#insp-intensity` (+`#insp-intensity-val`), `#btn-remove-motion`, `#btn-delete-region`.
- `<footer>`: `#status`.
- `<link rel="icon" href="data:,">` to suppress the favicon 404.
- Scripts loaded in the order given in §2.

---

## 8. css/style.css (visual contract)

Dark theme via CSS variables (`--bg:#0d0d12, --panel:#16161e, --surface:#1e1e28, --text:#e8e8ee, --muted:#8888a0, --accent:#6e5cff, --accent-2:#ff5c8a, --good:#3ddc84`). Key rules:
- `main { display:grid; grid-template-columns: 220px 1fr 240px; }` (collapses to 1 column under 900px).
- `#canvas-wrap { position:relative; display:flex; align-items:center; justify-content:center; background:#0a0a0e; }`.
- `#artwork-container { position:relative; width:800px; height:500px; }` and its `svg`/`img` fill 100%.
- `#selection-overlay { position:absolute; top:0; left:0; width:100%; height:100%; pointer-events:none; z-index:10; }` and `.drawing { pointer-events:auto; cursor:crosshair; }`.
- `.motion-card` (flex row, hover/active accent border), `.region-chip` (pill), `.motion-badge.assigned` (accent). `#status.flash { color: var(--good); }`.

---

## 9. Complete user flows

**A. Apply a preset to an SVG object**
1. App boots → `loadDefaultScenery()` shows the poster; overlay `pointer-events:none`.
2. User clicks a cloud → delegated listener finds `.ms-wrap` → `_createSVGSelection` → dashed highlight + chip + inspector.
3. User clicks "Cloud Drift" card → `library.select` → `applyMotionToActive()` sets `motionId`.
4. User clicks **Play** → Animator RAF loop writes the wrap's transform attribute each frame; the cloud glides; the dashed box follows via `syncHighlights`.

**B. Multiple objects** — repeat select→assign for waterfall (Waterfall Flow), flag (Flag Flutter), trees (Gentle Sway); Play animates all at once, each phase-offset by its seed.

**C. Upload a motion video** — click "+ Upload motion video" → pick a clip → `MotionCapture` samples 4s, runs flow+distill → new orange card appears → apply it to any object like a preset.

**D. Upload artwork** — SVG: elements become clickable (wrapped by id/`.layer`). Raster (PNG/JPEG): mode switches to rectangle-draw; drawn regions become floating clones animated via CSS transform.

**E. Tune** — Speed (0.1–3×) and Intensity (0–2×) sliders in the inspector scale `rt` and displacement live. Remove-motion resets the object; Delete-region removes it.

---

## 10. Known limitations / out of scope (documented honestly)
- **Rigid transform only.** Objects translate/rotate as a whole; there is no mesh warp, so a waterfall "flows" by sliding, not by internal fluid deformation. A production version would displace along a per-pixel field.
- **6 global scalars** are a lossy summary of real motion; the demo captures rhythm/axis/character, not the exact waveform.
- **Raster selection is a rectangle**, and its floating clone shows a hard rectangular edge (no matting/segmentation).
- **No video export.** Everything is live in the browser. (A real product could render frames via canvas capture + `MediaRecorder`, or server-side render individual SVG-path animations to mp4 with ffmpeg.)
- **.AI (Illustrator) files** are not parsed in-browser; the path would be server-side conversion to SVG (e.g. `inkscape --export-type=svg`) before this same logic runs.
- Optical flow is coarse (16×12 grid, single-scale Lucas–Kanade); large/fast motion beyond ±6px/frame at analysis scale is clamped.

---

## 11. Verification harness (how correctness was proven — reproduce it)

The app was tested by driving **real Chrome headless** with `puppeteer-core` (installed from the public npm registry against a local `python3 -m http.server 8000`). Reproduce these exact checks:

**Setup:** `npm install puppeteer-core@23`; launch with `executablePath` pointing at the system Chrome, `headless:'new'`, `--no-sandbox`. Expose `window.__ms = {sel, library, animator}` in `main.js`.

**Test 1 — click-to-select (Bug 1):** locate `[data-name="cloud 2"]`, dispatch a real `MouseEvent('click')` at its on-screen center. Assert exactly **1** selection is created and its name is `"cloud 2"` (proves clicking, not rectangle-drawing).

**Test 2 — motion animates (Bug 2):** `library.select('cloud-drift')`, set the active selection's `motionId`, `animator.play()`, sample `wrap.getAttribute('transform')` 5× at 120ms. Assert ≥3 non-empty samples and **≥2 distinct values** (proves it actually moves over time).

**Test 3 — pause resets:** after `animator.pause()`, assert the wrap's transform attribute is empty.

**Test 4 — uploaded SVG is clickable:** inject `<svg viewBox="0 0 200 200"><rect id="box-a".../><circle id="ball-b".../></svg>`, `sel.attachSVG(svg)`, assert **2** `.ms-wrap` wrappers created; dispatch a click on `#ball-b`, assert active selection name is `"ball-b"`.

**Test 5 — visibility of every preset:** apply each preset to one cloud, play ~2s, measure the wrap's `getBoundingClientRect()` min/max. Assert total on-screen travel **≥ 3px** for every preset (this is the check that caught the frozen `cloud-drift`).

**Test 6 — raster mode:** load a data-URI image, `sel.attachRaster()`, `_createRasterSelection('test-obj', {x:320,y:170,w:160,h:160})`, assert the floating clone exists in the DOM; assign `flag-flutter`, play, sample `floatEl.style.transform` 5×, assert ≥2 distinct values.

**Pass bar:** all assertions green **and zero `pageerror` / `console.error`** events during every run. Also capture a screenshot mid-animation (select clouds/waterfall/flag/trees, assign motions, `play()`, wait 700ms, `page.screenshot`) and eyeball that selected objects are displaced from their dashed boxes.

---

## 12. Run instructions

```bash
# 1. web app (required)
cd motion-swatch-poc
python3 -m http.server 8000
# open http://localhost:8000

# 2. RAFT analysis service (optional — upload quality upgrade)
./service/run.sh          # first run: creates venv, installs torch etc., downloads 4MB checkpoint
```
The web app needs no install or build. The service is optional: with it running, uploaded videos are analyzed by a real deep optical-flow model (RAFT on Apple-Silicon MPS); without it, the app silently falls back to the in-browser Lucas–Kanade analyzer.
```
```
