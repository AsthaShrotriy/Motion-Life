# Panel Q&A — Motion Swatch

Every question a review panel is likely to ask about the current state, with honest, speakable answers. Organized by theme. Where an answer has a number in it, that number is measured, not estimated.

---

## A. The core idea / positioning

**Q1. What's actually new here? Animation tools exist.**
A: The input modality. Every existing tool makes you *describe* motion — keyframes, easing curves, or a text prompt. We capture it from reality: film 5 seconds of real wind, and that exact motion — its frequency, its direction, its chaos, its spatial structure — transfers onto artwork. The provenance is the product: "this website's flag moves with the wind I filmed this morning" is a claim neither After Effects nor a text prompt can make.

**Q2. How is this different from Adobe's generative animate / Illustrator prompt-to-animation?**
A: Adobe's flow is prompt → canned plausible animation. Ours is capture → measured real motion. They're complementary, not competing: prompts give you *generic* motion fast; we give you *specific, real* motion fast. Also our output is a parametric representation (numbers + trajectories), not baked frames — so it's editable after capture, blendable, and exportable as a 130KB self-contained SVG instead of a video file.

**Q3. Google published "Generative Image Dynamics" (CVPR 2024 Best Paper) — isn't this that?**
A: GID is the closest published relative and the honest answer is: same insight (scene motion as oscillation representations), different product. GID re-animates *the same photo* it analyzed, needs a trained neural renderer, and released no code or weights. We transfer motion to *arbitrary different artwork*, run entirely locally, and ship a deployable file. That transfer gap is exactly our novelty; if GID's weights ever release, it becomes a rendering upgrade for us, not a competitor.

**Q4. Who is the user?**
A: Designers who ship static art and can't justify a motion designer: freelancers doing brand sites on locked-down CMSs (our travel-site demo — the export works where JavaScript is banned), social/marketing designers making animated versions of posters, illustrators and webcomic authors (our comic demo), streamers, indie game devs. The common thread: people who can point a phone at motion but can't operate After Effects.

---

## B. Model choices — "why this, why not that"

**Q5. Why RAFT? It's from 2020 — there are newer flow models.**
A: Three reasons, all verified: (1) License — torchvision's RAFT is BSD-3; most newer alternatives are non-commercial or unlicensed. (2) Deployment — it ships *inside* torchvision: pip install, 4MB checkpoint, runs on Apple-Silicon MPS at ~60ms per frame pair at 480p. No vendored research repo. (3) Sufficient accuracy — 0.07–0.36px error on known-shift tests; our bottleneck is the distillation representation, not flow accuracy. SEA-RAFT (BSD-3, better accuracy) is the identified upgrade path if flow quality ever becomes the limit.

**Q6. Why raft_small instead of raft_large? Isn't bigger better?**
A: We benchmarked both against five synthetic clips with mathematically known motion. raft_small scored 12/12 checks; raft_large scored 11/12 — its stronger smoothness prior blurs the phase structure of traveling waves, which damages our phaseSpread parameter — at 4× the compute. Bigger was measurably worse end-to-end for this task. raft_large remains one env-var away (`MS_ENGINE=raft_large`).

**Q7. Why not CoTracker (Meta's point tracker)? It outputs exactly your trajectories.**
A: It was the best technical fit in our research — and it's CC-BY-NC licensed. Non-commercial. Hard blocker for anything product-bound. The Apache-licensed alternatives in that family (TAPIR/LocoTrack) are the roadmap candidates if we want longer, occlusion-robust tracks.

**Q8. Why not video diffusion (MOFA-Video, DragAnything, Wan-Fun)? Those produce genuinely realistic motion.**
A: Three hard walls, all verified: licensing (DragAnything and Motion-I2V have *no license file at all*; others have custom terms), hardware (every trajectory-conditioned option is CUDA-only research code — nothing runs on the target Mac), and output form (they emit raster video, which kills our zero-JS SVG export — the feature the travel/comic demos are built on). Diffusion is on the roadmap as an optional *cloud rendering tier*, not the core.

**Q9. Why did you write the distillation yourself instead of using a model?**
A: Because no model outputs "reusable motion parameters" — that representation is the product idea itself. The distill is composed of standard, defensible signal processing (FFT with parabolic peak refinement, covariance eigenvectors, spectral flatness, circular phase variance, autocorrelation) — each piece is textbook; the composition into a transferable "swatch" is ours. It's also fully inspectable and debuggable, which a learned encoder wouldn't be — that's how we found and fixed three RAFT-specific failure modes with calibrated guards.

**Q10. You used MediaPipe for pose at some point — where did it go?**
A: We built a dance-to-characters pipeline (MediaPipe Pose, 33 landmarks, joint-angle retargeting onto rigged SVG characters) and it worked. We removed it deliberately: it's a *different* extraction pipeline that sidelines the optical-flow story, and the comic finale demonstrates the core loop better. Good example of scope discipline; it can return as a v2 feature.

**Q11. Why is there an in-browser fallback analyzer? Isn't that redundant?**
A: Demo resilience. If the Python service is down, capture still works via a JS Lucas–Kanade implementation with the same parameter contract — lower fidelity, no trajectories, but the flow never dead-ends. Both engines agreed within 1% on our ground-truth clip (0.771 vs 0.776 Hz), which also served as a cross-validation of the pipeline.

---

## C. Extraction quality — "how do you know it works?"

**Q12. How do you verify the extraction is accurate and not just plausible?**
A: Ground truth. We synthesize clips where the answer is mathematically known — a block swaying at exactly 0.8Hz, a wave traveling at 1.2Hz, pure noise, a static scene — and score the extracted parameters: 12/12 checks. On real footage: a metronome-style test extracts 0.8Hz within 3%; a real flag video yields direction 32° matching its visible diagonal ripple; a falling-leaves video yields driftY +0.26 (downward) with near-zero horizontal drift. And end-to-end: the *applied* motion oscillates at the captured frequency on the captured axis — measured in the browser, not eyeballed.

**Q13. What happens with a static video or camera shake?**
A: Static: RAFT hallucinates 0.3–0.9px/frame of noise, which naively reads as motion. We gate it two ways — a calibrated noise floor and a "pattern persistence" test (RAFT's noise sticks to texture edges frame-to-frame, correlation ≈1.0; real motion travels, ≤0.7) — so static clips correctly emit amplitude 0.00 and suppressed turbulence/phase. Camera shake: not yet compensated; it blends into the capture. Roadmap: subtract the global/background motion component (the data to do it — the trajectory grid — already exists).

**Q14. Multiple things moving in one video?**
A: Shipped. If a clip contains multiple distinct motions the service segments them: per-cell features on the 12×12 flow grid → active mask (absolute + peak-relative floors) → connected components → union-find merge on similar-adjacent direction+frequency → per-region distill on masked flows → static-scene kill via magnitude-persistence. The frontend detects `regions.length ≥ 2`, opens a picker modal (video looping with color-coded streaklines per region, dashed labeled bounding boxes, one card per region with checkbox + editable name + params), and the user picks *and names* the motions they want. Each becomes its own library swatch. Benchmarks: two-region synthetic clip → 2 regions ✓, three-region synthetic clip → 2 regions ✓ (subtle third folds — an acceptable failure), single-motion clip → 1 region ✓ (picker skipped, existing extraction moment plays), static clip → 0 regions ✓. Real videos each yield 1 region because they contain 1 motion — segmentation doesn't force splits where there aren't any. Failure mode: motions that overlap in space (a fish under a rippling surface) can't be separated by 2D flow — SAM2 click-to-segment is still on the roadmap for that case.

**Q15. Why only 8 seconds / 480p / 20fps analysis?**
A: Benchmark-chosen sweet spot: 12/12 accuracy at ~12s analysis time on the target machine. Higher settings measurably didn't improve parameter accuracy on our test set; they just cost time. All three are env-var tunable.

---

## D. Application quality — "why does it look real / not real?"

**Q16. Rigid transforms look fake. How do you get realistic motion?**
A: Three layers, applied automatically: (1) For captures, we replay the **raw 12×12 trajectory field** — every part of the object follows the corresponding part of the source video, so local stretch/compression (the wrinkle/foreshortening look) emerges from the data instead of being simulated. (2) Cloth-wave mode deforms actual path geometry with a pole-pinned traveling wave for flags/banners. (3) Text splits into per-glyph elements riding the motion at individual phases. The key architectural point: realism came from *using data we already had* — we were extracting 144 trajectories and discarding them.

**Q17. Why not a physics/cloth simulation?**
A: It was the top-scored option in our research (2.5D position-based cloth, ~300 lines, foreshortening and fold shading emerge from 3D→2D projection) and it's the next build. We did trajectory replay first because it's motion-*faithful* — a simulation looks like generic cloth in wind; the field replay looks like *your* wind. The ideal end state is both: field replay for fidelity, 2.5D projection for dimensionality/shading.

**Q18. The flag doesn't wrinkle like the real video. Why claim realism?**
A: Fair — at 12×12 field resolution you get regional realism (the free edge whips, the pole side holds, parts converge/diverge), not per-pixel creasing. Two known upgrades: denser trajectory grid from the service (the dense flow is already computed; 24×24 is a config change) and normal-based fold shading from the 2.5D work. We chose to ship verified regional realism over unverified per-pixel claims.

**Q19. What about photos, not vector art?**
A: Supported but second-class: rectangle-select creates a floating clone that moves rigidly — visible hard edges on busy backgrounds. The researched fix is a WebGL mesh warp driven by the same trajectory grid (verified feasible, ~2–4 days). SVG is deliberately first-class because the export story (self-contained animated file) only exists for vector.

**Q20. Uploaded SVGs from real tools are messy. Does selection actually work?**
A: Yes — tested against three hostile export styles (Figma no-ids/clip-path, Illustrator named-layer containers, Canva anonymous nesting) plus a real Illustrator poster a user supplied (252 paths, zero ids). Three-tier wrapping (layer contract → leaf ids → top-level groups) plus click-time drill-down and lazy wrapping. Every clicked object selects as a tight unit; the failure mode of selecting a whole-canvas layer group is specifically guarded (>70% coverage triggers drill-down).

---

## E. Architecture — "why built this way?"

**Q21. Why vanilla JS? No React, no build system?**
A: The product's differentiating output is a **zero-dependency animated SVG** — the demo sites prove it runs where JavaScript is banned. A framework adds nothing to a canvas/SVG rendering loop and would muddy that story. The entire client is ~2,500 lines across 12 files with explicit load order; it's the fastest thing to audit in a review.

**Q22. Why a local Python service instead of doing everything in-browser or in the cloud?**
A: In-browser: no production-grade neural flow exists for the browser (verified — no usable ONNX/WebGPU RAFT ports; OpenCV.js LK is the ceiling, which is our fallback). Cloud: adds latency, cost, and privacy questions for a POC whose pitch includes "runs on my laptop." The local FastAPI sidecar is 300 lines, optional at runtime, and the client degrades gracefully without it.

**Q23. Why export SVG at all? Everyone ships video.**
A: The SVG export is the business story: one 60–130KB file, infinite resolution, loops forever, works as a plain `<img>` in CMSs, READMEs, and email clients that strip all scripts — verified by loading exports in script-less contexts and screenshotting frame differences. Video export exists too (MediaRecorder, 1080×1920 reel mode) for social. Two artifacts, two channels.

**Q24. How is this tested? POCs usually aren't.**
A: ~10 automated suites driving real headless Chrome: real synthetic-video uploads through the actual UI, real mouse events on real pixels, screenshot-diff proofs that exports animate standalone, and a service-side ground-truth benchmark. Rule adopted after being burned twice: no claim without a browser-level test. The two worst bugs of the project (overlay eating clicks; CSS-vs-SVG transform conflict) shipped exactly when this rule was skipped, and both now have regression tests.

---

## F. Limitations — ask them before they do

**Q25. What's the weakest part right now?**
A: Three, in order: (1) per-pixel realism — 12×12 regional fidelity, no fold shading yet; (2) one-directional captures — the ping-pong loop makes a flowing river read as back-and-forth (drift parameters cover some of it); (3) raster-image support is a rigid clone, not a warp. All three have researched, effort-estimated fixes (denser grid + 2.5D shading ~3–5 days; directional loop handling ~1–2 days; WebGL mesh warp ~2–4 days).

**Q26. Does it scale? What about 100 objects, big artworks?**
A: The animator is O(objects × sampled points) per frame — the 12-object scenery with cloth + field + glyphs runs at 60fps on the target machine, and chips add ~250 draws/frame. Untested beyond ~30 animated objects; the known future bottleneck is per-frame SVG serialization in video export (already real-time-bound, ~20fps serialize).

**Q27. Privacy / data handling?**
A: Everything is local — video never leaves the machine (localhost service), no telemetry, no accounts. The only network calls are the pretrained checkpoint download (once, from download.pytorch.org) and Unsplash images for the demo site at build time.

**Q28. Licensing of the whole stack?**
A: Clean by construction: PyTorch/torchvision BSD-3, RAFT weights via torchvision, FastAPI/uvicorn MIT, OpenCV Apache-2.0, all frontend code original, demo photos Unsplash-licensed. Every rejected model was rejected *first* on license (documented in informations.md) — nothing NC or unlicensed is in the build.

---

## G. Improvements — "what would you do next?"

**Q29. Next two weeks?**
A: In order of demo impact: (1) denser trajectory grid + 2.5D fold shading — closes most of the realism gap; (2) SAM2 click-to-segment to handle *overlapping* motions (the 2D-flow segmentation we already ship handles spatially-separated ones — see Q14); (3) directional-loop handling for flowing captures; (4) WebGL mesh warp for photos.

**Q30. Six months / product vision?**
A: (1) Swatch ecosystem — swatches are 8 numbers + a field; they're saveable, shareable, blendable JSON. A motion library ("Pantone for movement") with brand motion-identities in style guides. (2) Live data binding — parameters are numbers, so bind amplitude to a weather API: the site's trees sway harder when it's actually windy at the destination. Impossible for baked video by construction. (3) Cloud rendering tier — the same captured field conditioning a video-diffusion model for photoreal output, as an optional upgrade over the local path. (4) Plugin form — the capture/apply loop inside Figma or Illustrator rather than a standalone tool.

**Q31. What would you build differently if starting over?**
A: Two things. First, trajectory-field replay from day one — we spent time on the 8-scalar representation before realizing the raw field we were discarding was the realism. Second, browser-level tests from the first hour; the two silent-killer UI bugs cost more time than any model decision. What I'd keep exactly: choosing measurement over model-shopping — the benchmark suite is what let us confidently pick a small model over a large one and defend every constant in the pipeline.

**Q32. What's the riskiest assumption in the whole project?**
A: That regional motion fidelity is enough to trigger the "it's real" response for a general audience — we've validated it on ourselves and tests, not users. Second riskiest: that designers will film motion rather than browse presets. Both are exactly what a user study with the two demo sites should answer, and both demos were built to make that study cheap.
