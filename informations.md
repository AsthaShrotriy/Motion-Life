# Motion Swatch — Informations

Everything implemented in this POC, the models and technology used, and the reasoning behind every major choice. Companion docs: `prompt.md` (rebuild-from-scratch spec), `IMPLEMENTATION.md` (deep module-level spec), `DEMO_SCRIPT.md` (video script).

---

## 1. What the product is

**Capture → Extract → Apply.** Film ~5 seconds of real-world motion on a phone (flag, waves, leaves, flame). Motion Swatch extracts the motion into a reusable "**motion swatch**" and lets you paint it onto any object in an SVG artwork with two clicks. Results export as (a) a self-contained animated SVG that runs anywhere an image loads — zero JavaScript — and (b) a 1080×1920 vertical video for social.

The differentiator vs. prompt-based animation (e.g. Illustrator's generative animate): **provenance**. You don't describe motion in words; you take it from reality. "The flag on the website moves with the wind I filmed this morning" is a claim no prompt can make.

---

## 2. What we implemented (feature inventory)

### The tool (`motion-swatch-poc/`)
- **Motion capture** from uploaded video: deep-optical-flow analysis service (preferred) with a silent in-browser fallback analyzer.
- **Motion swatch representation**: 8 scalar parameters (frequency Hz, amplitude, direction, turbulence, damping, phaseSpread, driftX, driftY) **plus a 12×12 grid of real point trajectories** (144 tracks) — the raw motion field.
- **The extraction moment**: a skippable ~5s modal after each capture — the clip plays with the 144 trajectories drawn as glowing streaklines, which sweep and collapse into the library while the extracted numbers count up. Makes the extraction visible instead of "a file uploaded and a card appeared."
- **Click-to-select on any SVG**: built-in artworks and arbitrary uploaded SVGs (Figma/Illustrator/Canva export styles all handled — three-tier wrapping + click-time drill-down/lazy wrapping). Raster images (PNG/JPEG) use rectangle-select with floating-clone animation.
- **Motion application, four modes** (auto-chosen):
  - *Rigid*: translate + rotate + drift loop via a shared parametric formula.
  - *Cloth wave* (presets on flags/banners): 1D traveling sine deforming actual path geometry, pinned at the pole edge.
  - **Trajectory-field replay** (captures — the realism core): the object's geometry replays the captured 12×12 motion field; every path point follows its corresponding region of the source video (bilinear in space, ping-pong looped in time, active-region detection so a flag filmed against sky maps onto the flag region only). Local stretch/compression — the wrinkle/foreshortening look — emerges automatically, and it is content-agnostic: water churns like the real water, smoke curls like the real smoke.
  - *Per-glyph text*: text splits into per-letter elements (kerning preserved via character metrics); each letter rides the motion at its own phase/position with lean — a wave travels through the word instead of the block shaking.
- **Motion library UI**: Pantone-style "particle swatch" chips — a 5×5 dot lattice with trails animating under each motion. Preset chips run the real formula; capture chips replay 25 of the 144 real trajectories, so a captured flag chip visibly shows the flag's region whipping.
- **Multi-motion picker**: when a single uploaded clip contains more than one distinct motion (e.g. a flag *and* a fountain in the same shot), the service segments the RAFT flow into per-region motions (see § Multi-motion segmentation below) and a picker modal appears — the video loops with each region's trajectories drawn in its own color plus a dashed bounding box + label, each card carries a checkbox, an editable name (prefilled with a smart suggestion — "Fast vertical", "Falling", "Flutter"…), and a compact param summary; click a card to solo-preview just that region's streaklines. Save adds the checked ones as separate library motions. If the clip only has one motion the picker is skipped and the existing extraction moment plays.
- **Per-object controls**: speed (0.1–3×), intensity (0–2×), cloth-mode toggle, rename, remove/delete.
- **Exports**: animated SVG (CSS keyframes for rigid; SMIL `d`-morph for cloth/field; nested translate/rotate `animateTransform` pairs for glyphs; seamless loop treatment for all three) and MediaRecorder video (mp4/webm, vertical reel framing with blurred fill).
- **Two built-in artworks**: minimal Poster (flag + title — demo Act 1) and golden-hour lake Scenery (12 objects — demo Act 2).
- **Test suite** (~10 suites, headless Chrome via puppeteer-core): click-to-select incl. 3 uploaded-SVG flavors + the user's real Illustrator poster, motion-truly-animates, preset visibility (≥3px/2s), extraction ground-truth (0.8Hz capture → 0.80Hz applied, correct axis), export-runs-as-`<img>`, upload path, service e2e, cloth wave, glyphs, trajectory field.

### Demo websites
- **`travel-site/`** — "Wilder Valley" trekking company: editorial design, real Unsplash photography, stats band, trek cards, gallery, CTA sections. The hero is the tool's Scenery SVG; an "Upload new image" button + drag-drop swaps in the animated export live — the "ship it" beat.
- **`comic/`** — "Wilder Comics": a comic-book reader with a cover that opens (3D page animation) into a two-page spread, 2 panels per page. Each of the 4 panels (*The Night the Wind Came*: still village → wind arrives → lake rises → candle remembers) is an SVG following the tool's layer contract, individually replaceable via hover-⟳ or drag-drop. The story beats intentionally map to capturable motions (flag, leaves, water+rain, flame+smoke).

### The analysis service (`service/`)
- FastAPI on 127.0.0.1:8765; `GET /health`, `POST /analyze`.
- Dense optical flow → parameter distillation → trajectory integration (details below).
- Ground-truth benchmark suite (5 synthetic clips with known motion; 12/12 checks).
- Multi-motion segmentation: `/analyze` also returns a `regions[]` field — 0 entries for static clips, 1 entry for coherent single-motion clips, N entries for clips with N spatially/temporally distinct motions.

---

## 3. Models & tech used — and WHY

### RAFT (raft_small, torchvision pretrained) — the motion extraction model
- **What it is:** *RAFT: Recurrent All-Pairs Field Transforms for Optical Flow*, Teed & Deng, Princeton — **ECCV 2020 Best Paper** (arXiv:2003.12039). Builds an all-pairs correlation volume between two frames, then a conv-GRU iteratively refines a dense flow field (12 iterations).
- **The exact implementation:** `torchvision.models.optical_flow.raft_small`, checkpoint `C_T_V2` (~1M params, 3.8MB), trained on FlyingChairs+FlyingThings3D, auto-downloaded from download.pytorch.org.
- **Why this one:**
  - **License:** BSD-3-Clause (torchvision) — commercially safe. Compare: CoTracker3 (Meta, best-in-class point tracking) is CC-BY-NC — a hard blocker.
  - **Zero-friction:** ships inside torchvision, no repo vendoring, no custom CUDA ops → runs on Apple-Silicon **MPS** out of the box (~18ms/frame-pair @320×240; ~60ms @480p).
  - **Accuracy:** 0.07–0.36px error on known-shift synthetic frames.
  - **small > large, verified:** our benchmark showed raft_small scores **12/12** ground-truth checks vs raft_large's 11/12 — raft_large's stronger smoothness prior blurs traveling-wave phase structure (hurts phaseSpread) at 4× the compute. Bigger was measurably not better for this task.
- **What we evaluated and rejected** (all verified against live repos/licenses):
  - *CoTracker3* (Meta point tracking): technically ideal, CC-BY-NC license — rejected.
  - *SEA-RAFT* (BSD-3): better accuracy, needs repo vendoring — noted as upgrade path.
  - *TPSMM / FOMM* (image animation): MIT, but all checkpoints are faces/bodies/cartoon — no cloth/water domain; raster-only output kills SVG export.
  - *MRAA* (Snap): explicit no-license — unusable. *DaGAN, LIA*: CC-BY-NC — unusable.
  - *Flow-conditioned video diffusion* (MOFA-Video, Go-with-the-Flow, Wan-Fun, DragAnything, Motion-I2V): conceptually perfect (several consume trajectories directly) but CUDA-only research stacks; DragAnything & Motion-I2V have **no license at all**; the one Mac-supported option (LTX-Video) lacks trajectory conditioning. Kept on the roadmap as a "cloud rendering tier".
  - *Generative Image Dynamics* (Google, CVPR 2024 Best Paper — the closest published relative of the whole idea): no code/weights released; it also re-animates the same photo rather than transferring motion to arbitrary artwork — that gap IS this product's novelty.
  - *AnimatedDrawings* (Meta, MIT): does NOT extract motion from video — it replays canned BVH mocap on rigged humanoid sketches; solves the opposite problem.
- **MediaPipe Pose** was integrated for a dance-to-characters act (33-landmark skeleton tracking, joint-angle retargeting onto rigged SVG characters), fully working, then **removed** when the demo pivoted to the comic-book finale — pose replay is a different pipeline that sidelines the optical-flow hero. The comic multiplies the core loop instead.

### Lucas–Kanade (browser fallback analyzer)
- Classical sparse optical flow (Lucas & Kanade, IJCAI 1981; texture test from Shi–Tomasi, CVPR 1994). 16×12 grid, 7×7 windows, pure JS. **Why:** the demo must never hard-depend on the Python service; the fallback keeps capture working (lower fidelity, no trajectories) with the same parameter contract.

### The distillation algorithm (flow → swatch) — original work
Not from any single paper; composed from standard signal processing: covariance eigenvector (dominant axis), rFFT + parabolic peak interpolation (frequency), spectral flatness + magnitude-weighted circular variance (turbulence), autocorrelation decay (damping), per-pixel energy-weighted phase variance (phaseSpread), mean-flow DC component (drift). Three calibrated guards came from measured RAFT failure modes:
1. **Noise floor (0.55 px/frame):** RAFT hallucinates 0.3–0.9px/frame on static video.
2. **Pattern-persistence static gate:** RAFT's noise sticks to texture edges (frame-to-frame magnitude-map correlation ≈1.0) while real motion travels (≤0.7 on every moving clip tested) — this cleanly separates "nothing is moving" from "something is moving," which raw magnitudes cannot.
3. **Per-pixel (not per-cell) phase analysis:** cell averaging cancels opposite phases and destroys the traveling-wave signal.

Every constant was validated against a 5-clip synthetic ground-truth benchmark (known frequency/direction/turbulence/phase behavior) and two real videos (waving flag: 0.62Hz, direction 32°, turbulence 0.63; falling leaves: driftY +0.26 ✓ downward).

### Multi-motion segmentation (flow → N regions) — original work

The whole-frame distill above collapses a clip into one swatch. If the clip has two motions the average is neither. `segment_regions()` clusters the 12×12 flow grid into regions of coherent motion so we return N swatches to name.

**The case that drove the design:** rain (falling) and smoke (rising) *overlap in space* and differ only in **direction**. A purely spatial clustering (connected components on an energy mask) can never split them — they're one connected blob. And a *fixed* px energy floor is wrong too: cell energy ranges from ~0.17 px/frame (rain/smoke) to ~8 px/frame (bold synthetic blocks) across clips, so a single threshold either rejects subtle real motion or admits noise. The algorithm therefore clusters by **motion signature** and gates **relative to each clip**:

1. **Static-scene kill.** Global magnitude persistence (`_persistence`) — cross-frame correlation of magnitude maps. RAFT's static-scene noise is anchored to texture edges (persistence ≈ 1.0); real motion travels (≤ 0.7). If persistence ≥ 0.85 → return `[]`.
2. **Per-cell features** (`_seg_features`): mean magnitude ("energy"), mean flow ("drift_x/y"), oscillation strength (std of drift-removed flow), and oscillation axis (2×2 covariance closed form, undirected).
3. **Video-relative active floor.** A cell is active if `energy ≥ max(0.30 · peak, 0.05)`. Relative-to-peak adapts to each clip's motion scale — this is what lets the rain+smoke clip (peak 0.167) survive at all.
4. **Per-cell signature bucketing.** Drift-dominated cells (`|drift| ≥ 0.6 · osc` and `|drift| > 0.02`) bucket by **8-way drift octant** — rain (down) and smoke (up) land in opposite octants. Oscillation-dominated cells bucket by **4-way undirected axis** — horizontal sway vs vertical bounce separate. This signature-first step is the core: it can split motions that overlap spatially.
5. **Merge circular-adjacent signature bins** (`_merge_circular_bins`, union-find) so a motion straddling an octant boundary (44° vs 46°) isn't split.
6. **Spatial split within each signature** (`_cc8`, 8-connected components) — two blocks swaying identically in different corners become two regions.
7. **Co-location merge.** A drift group + oscillation group occupying the same cells are one physical object doing two things (a flag both flutters and blows). Merge only when the smaller bbox overlaps the larger by ≥ 55 %.
8. **Filter & rank.** Drop regions < 4 cells or < 8 % of active cells; rank by total energy; cap at 8.
9. **Per-region distill** on flows cropped to the region bbox with non-region pixels zeroed — so drift/coverage scale to the region, not the frame. The noise floor passed to distill is **adaptive** (`min(0.55, max(0.12, peak·0.6))`): atmospheric motion (rain/smoke) has residual flow ~0.08 px/frame, well under distill's default 0.55 floor, which would otherwise register amplitude 0.
10. **Per-region trajectories.** In-region cells integrate their flow; out-of-region cells stay frozen, so frontend field-replay confines the motion to the region.
11. **Suggested name** from distilled params *plus the raw cell-drift sign* — for low-amplitude atmospheric motion (amplitude < 0.08) the drift sign names it (dy < 0 → "Rising", dy > 0 → "Falling", else "Drifting"/"Drifting mist"); otherwise strong-drift → Falling/Rising/Drifting, high freq + turb → Flutter, low freq + low turb → Slow horizontal/vertical, generic → Wave/Sway.

Calibration (all pass): `rain_smoke` → 2 regions ✓ (was **0** under the old fixed-floor spatial design — the reported bug), `multi2` (0.8Hz horiz + 2.5Hz vert) → 2 ✓, `multi3` → 2 ✓, `sway_only` → 1 ✓, `static` → 0 ✓, `flag_real` → 1, `leaves_real` → 1.

**Honest limit surfaced by the rain clip:** at 480px/720px/960px, RAFT cannot see thin fast rain streaks against a busy forest — the downward rain never registers as coherent flow. What it reliably sees is the rising smoke/steam and mist, which it splits into regions. So on that clip you get atmospheric-motion regions to name, not a literal "rain" vs "smoke" split. The frontend triggers the picker only when `regions.length ≥ 2`, keeping the single-motion "wow" extraction moment intact.

### Frontend stack — vanilla JS + SVG + Canvas 2D, no frameworks
**Why:** the product's killer feature is the **zero-dependency animated SVG export** — animation baked as CSS keyframes/SMIL inside the image file itself, verified working as a plain `<img>` (even where all scripts are stripped, e.g. GitHub READMEs). A framework buys nothing for a canvas/SVG tool and complicates the story. Key techniques:
- Wrap-and-animate-the-attribute pattern (see "hard lessons" below).
- `getPointAtLength` path sampling for geometry deformation; `getStartPositionOfChar` for glyph splitting.
- SMIL for anything CSS can't animate in `<img>` (path `d`, per-glyph nested `animateTransform`).
- MediaRecorder + `canvas.captureStream` for video export (no ffmpeg client-side).

### Service stack — FastAPI + PyTorch/MPS + OpenCV
**Why:** smallest possible sidecar exposing two endpoints; OpenCV for robust video decode (with fps sanity guards — real phone videos lie about fps); MPS because the target machine is Apple Silicon. Client treats the service as optional (800ms health probe, silent fallback).

---

## 4. Hard lessons encoded in the design (do not relearn these)

1. **The overlay-eats-clicks bug:** a selection overlay canvas with `pointer-events:auto` makes every SVG element unclickable. Overlay must be `none` in SVG mode.
2. **CSS transform replaces SVG attribute positioning:** styling `transform` on an element with a `transform="translate(…)"` attribute teleports it (measured −360px). Always wrap in an empty `<g>` and animate the wrapper's attribute.
3. **Geometric guessing loses to direct references:** matching drawn regions to SVG groups by bbox-center containment fails on full-canvas groups. Selections must hold the actual DOM node.
4. **Real-world SVG exports are hostile:** Illustrator "Minimal IDs" strips all names; Figma nests everything in one clip-path group; layer containers cover 100% of the canvas. Hence 3-tier wrapping + click-time drill-down + lazy wrapping. (Fix at the source: Illustrator → Export As SVG → **Object IDs: Layer Names**.)
5. **Averaged parameters aren't realism:** 8 scalars produce plausible-but-generic motion. Realism came from *replaying the raw trajectory field* — data we were already extracting and discarding.
6. **Rigid text reads as broken:** per-glyph phase offsets are mandatory; and purely-horizontal motions need an explicit traveling vertical wave through the letters or they stay in lockstep.
7. **Subtle presets read as broken:** every preset needs ≥3px visible travel in ~2s (the original Cloud Drift at 0.08Hz moved 1.9px and looked frozen).
8. **Browser video decode:** OpenCV's default `mp4v` fourcc doesn't play in Chrome — test fixtures must be H.264.
9. **Loops need seam treatment:** snap sine frequency to whole cycles; ping-pong trajectory replay; crossfade noise over the final 12% — or the export visibly pops.
10. **Verify in a real browser, always:** every claim in this project is backed by a puppeteer test that clicks real pixels and screenshots real frames. The two worst bugs shipped precisely when this rule was skipped.

---

## 5. Current limits (honest)

- Trajectory field is 12×12 — regional realism, not per-pixel wrinkles (denser server grid + 2.5D fold shading are the researched next steps).
- Ping-pong looping makes strongly one-directional captures (a river) read as back-and-forth; drift covers some of it.
- Raster (photo) regions animate as rectangular floating clones with hard edges — SVG artwork demos far better.
- Sound is out of scope; browser video export is real-time (8s export takes 8s).
- Multi-motion segmentation groups by *dominant axis + frequency*, so two objects moving with similar signatures (two flags on the same wind) will merge into one region — a feature, not a bug, but worth knowing. Motions that overlap in space (a rippling water surface where a fish also swims) are not separated.
