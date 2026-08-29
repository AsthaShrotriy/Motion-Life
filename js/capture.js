/*
 * capture.js — handles video upload → motion extraction.
 *
 * Preferred path: POST the video to the local analysis service
 * (service/server.py — torchvision RAFT deep optical flow on MPS/CPU),
 * which returns the 6 motion params + dense point trajectories.
 *
 * Fallback path (service not running): in-browser Lucas–Kanade
 * (FlowTracker + distillSwatch), same parameter contract.
 */

const SERVICE_URL = 'http://127.0.0.1:8865';
const POSE_SERVICE_URL = 'http://127.0.0.1:8870';   // MediaPipe character-pose service
const ROUTER_SERVICE_URL = 'http://127.0.0.1:8871'; // VLM Router (motion decomposition)
// :8872 (preprocess) is deliberately NOT called from the browser — see preprocessRegion's
// removal note below the router methods.

class MotionCapture {
  constructor() {
    this.flow = new FlowTracker();
    this.onProgress = null;
    this.onComplete = null;
  }

  async serviceAvailable() {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 800);
      const r = await fetch(SERVICE_URL + '/health', { signal: ctrl.signal });
      clearTimeout(timer);
      const j = await r.json();
      return j.ok ? j : null;
    } catch { return null; }
  }

  /* VLM Router (Step 1): POST the clip to the router, which asks Claude vision to
     decompose it into distinct motions. Returns Contract-A JSON
     { static, motions:[{ id, label, class, bbox, confidence, backend, applicator }] }
     or null if the router isn't running. Used to auto-classify/route a clip instead
     of guessing from filenames or layer names. */
  async decomposeMotion(file) {
    try {
      const resp = await fetch(ROUTER_SERVICE_URL + '/decompose', { method: 'POST', body: file });
      const j = await resp.json();
      if (j.error) throw new Error(j.error);
      return j;
    } catch (e) {
      console.warn('[router] decompose unavailable:', e.message);
      return null;
    }
  }

  /* VLM Router (Step 10): POST the ARTWORK plus its layer bboxes; the router shows
     Claude the whole illustration and one crop per layer and returns Contract D
     { labels:[{ id, label, motion_class ("" = should not move), applicator, deforms,
                 confidence, notes }] }.
     This is the other half of auto-apply: /decompose says what moved in the clip,
     /label says what each object in the drawing IS, so a swatch can be matched to the
     thing it belongs on without a regex over layer names. Returns null when the router
     is down — the caller then keeps the file's own names and says the labels are
     missing, rather than falling back to guessing. */
  async labelLayers(imageDataUrl, layers) {
    try {
      const resp = await fetch(ROUTER_SERVICE_URL + '/label', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: imageDataUrl, layers }),
      });
      const j = await resp.json();
      if (j.error) throw new Error(j.error);
      return j;
    } catch (e) {
      console.warn('[router] label unavailable:', e.message);
      return null;
    }
  }

  /* Preprocess (Step 2) is NOT fetched from the browser, and deliberately so.
     :8772 (service/preprocess_server.py) runs under routervenv, which has no torch —
     so it can only reach the GrabCut mask path. /analyze?preprocess=1 on :8765 runs
     the same preprocess.py IN-PROCESS under service/venv, where SAM 2 is importable,
     and returns the mask provenance inline. Calling :8772 from here would have quietly
     downgraded the mask to get the same answer over an extra HTTP hop.
     :8772 remains the surface for the FULL region_preprocess contract — the RLE mask
     pixels and the per-frame camera transform, neither of which /analyze returns
     because nothing in the renderer consumes them. Use it from a shell or from
     tests/step2-preprocess.py, not from here. */

  /* Character / skeletal motion: POST the clip to the MediaPipe pose service,
     which returns a captured pose sequence (joints + per-frame keypoints).
     Returns {joints, fps, frames, detected, total} or null if unavailable. */
  async captureCharacter(file, kind = 'pose', fmt = 'legacy') {
    // kind: 'pose' (default, byte-compatible response the rig consumes) | 'hands' | 'face'.
    // hands/face return a Contract-B skeleton swatch (subject!=='pose') and must NOT be
    // routed to the body rig (_applyCharacter) — see js/animate.js.
    // fmt: 'legacy' (the frozen {joints,fps,frames,detected,total}) or 'swatch' (Step 7's
    // unified swatch, with those same fields nested under .pose). Verified identical on
    // walk-man.mp4 — fmt=swatch only differs by gap-filling frames the detector missed.
    const q = [];
    if (kind && kind !== 'pose') q.push('kind=' + encodeURIComponent(kind));
    if (fmt && fmt !== 'legacy') q.push('fmt=' + encodeURIComponent(fmt));
    const qs = q.length ? '?' + q.join('&') : '';
    try {
      const resp = await fetch(POSE_SERVICE_URL + '/extract' + qs, { method: 'POST', body: file });
      const j = await resp.json();
      if (j.error) throw new Error(j.error);
      return j;
    } catch (e) {
      console.warn('[pose] captureCharacter unavailable:', e.message);
      return null;   // matches decomposeMotion; caller guards on !pose
    }
  }

  /* Ask the service which extractor to use for a VLM-detected motion class.
     Returns {engine, kind, available, reason} or null if the service is down. */
  async route(cls, attrs = {}) {
    try {
      const p = new URLSearchParams({ cls });
      if (attrs.subject_type) p.set('subject_type', attrs.subject_type);
      if (attrs.count) p.set('count', attrs.count);
      const r = await fetch(SERVICE_URL + '/route?' + p.toString());
      return await r.json();
    } catch { return null; }
  }

  async captureFromFile(file, opts = {}) {
    // opts.engine (FLOW) / opts.tracker (TRAJECTORY) / opts.preproc select a pluggable
    // backend; omitted -> the raft_small default (byte-identical to before).
    const svc = await this.serviceAvailable();
    if (svc) {
      try {
        if (this.onProgress) this.onProgress(-1, `Analyzing with ${opts.engine || opts.tracker || svc.engine}…`);
        const form = new FormData();
        form.append('file', file, file.name);
        const qs = [];
        if (opts.engine) qs.push('engine=' + encodeURIComponent(opts.engine));
        if (opts.tracker) qs.push('tracker=' + encodeURIComponent(opts.tracker));
        if (opts.preproc) qs.push('preproc=' + encodeURIComponent(opts.preproc));
        if (opts.bbox) qs.push('bbox=' + opts.bbox.map(v => (+v).toFixed(4)).join(','));
        if (opts.preprocess) qs.push('preprocess=1');   // Step 2: object mask + camera
        // (Step 2) relative depth over the mask (Depth Anything V2, 3 sampled frames).
        // Only meaningful alongside preprocess=1 — the service says so rather than
        // silently ignoring it. Costs ~30ms/frame once the 95MB checkpoint is cached;
        // when it isn't, the contract comes back with depth:null and a warning.
        if (opts.depth) qs.push('depth=1');
        if (opts.path) qs.push('path=1');               // Step 5: object travel path
        // (Step 7) always ask for the unified Contract-B swatches — the library reads
        // its metadata from them, so a texture, a skeleton and a path all describe
        // themselves the same way. `cls` is the VLM's class, carried into the swatch so
        // Step 8 can route on it instead of on the layer name.
        qs.push('swatch=1');
        if (opts.cls) qs.push('cls=' + encodeURIComponent(opts.cls));
        const url = SERVICE_URL + '/analyze' + (qs.length ? '?' + qs.join('&') : '');
        const resp = await fetch(url, { method: 'POST', body: form });
        const j = await resp.json();
        if (j.ok) {
          // the mask claim is spelled out with the numbers that back it: how much of the
          // region the mask covered, and how many of the 144 field cells were actually
          // allowed to track. `cells_tracked: null` means the field was NOT gated, so
          // the string says "coverage only" rather than implying the field was masked.
          const pp = j.preprocess;
          const via = j.engine + (j.tracker && j.tracker !== 'raft-grid' ? ' + ' + j.tracker : '')
            + (pp && pp.masked
                 ? ` + masked ${Math.round(pp.mask_coverage * 100)}% (${pp.mask_method}`
                   + (pp.cells_tracked != null
                        ? `, ${pp.cells_tracked}/${pp.cells_total} cells tracked)`
                        : ', field ungated)')
                 : '')
            // depth `rank` = fraction of the frame that is FARTHER than the object, so
            // 0.9 means "almost everything is behind it". Reported, not yet consumed by
            // the renderer — see docs/BUILD_PLAN.md Step 2.
            + (pp && pp.depth && pp.depth.rank != null ? ` + depth rank ${pp.depth.rank}` : '')
            + (j.path ? ` + ${j.path.label} path` : '');
          const motion = {
            id: 'uploaded-' + Date.now(),
            name: file.name.replace(/\.[^.]+$/, ''),
            desc: `Captured via ${via} (${j.frames_analyzed} frames)`,
            color: '#ff8a4c',
            params: j.params,
            fromUpload: true,
            engine: j.engine,
            trajectories: j.trajectories,     // 12x12 real motion field
            trajFps: j.fps,                   // sample rate of the field
            videoUrl: URL.createObjectURL(file),
            // per-region segmentation from segment_regions() — empty for
            // single-motion clips, ≥1 entry when the service found
            // spatially/temporally distinct motions. main.js uses this to
            // decide between the picker (≥2 regions) and the existing
            // single-motion extraction flow.
            regions: Array.isArray(j.regions) ? j.regions : [],
            framesAnalyzed: j.frames_analyzed,
            // (Step 5) travel path of ONE tracked object, when ?path=1 found a usable
            // track: {label, points:[[frame,dx,dy]…] normalized offsets from its start,
            // travel:{…}, confidence}. Present => animate.js follows it instead of a
            // name-keyed curated behaviour. Absent whenever nothing was tracked.
            path: j.path || null,
            // (Step 2) the mask + camera provenance for this capture: {masked,
            // mask_coverage, mask_method, cells_tracked, cells_total, camera, depth}.
            // Kept on the motion so the inspector can show WHY the numbers look the way
            // they do, and so nothing has to re-derive it from the `desc` string.
            preprocess: j.preprocess || null,
            // (Step 7) the SAME numbers as unified Contract-B swatches: one per backend
            // that ran, primary first (a path swatch before the texture swatch that
            // carries the object's internal motion). `params`/`trajectories`/`path` above
            // are the raw shapes the renderer still reads — a deliberate duplication that
            // Step 8 removes once the applicator branches on swatch.class + swatch.kind.
            swatches: Array.isArray(j.swatches) ? j.swatches : [],
          };
          if (this.onComplete) this.onComplete(motion);
          return motion;
        }
        // service answered but couldn't analyze → fall through to local
        console.warn('service analyze failed:', j.error);
      } catch (e) {
        console.warn('service unreachable mid-request, falling back:', e.message);
      }
    }
    // ---- fallback: in-browser Lucas–Kanade ----
    return this.captureLocally(file);
  }

  async captureLocally(file) {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.src = url;
    video.muted = true;
    video.playsInline = true;

    await new Promise((resolve, reject) => {
      video.onloadeddata = resolve;
      video.onerror = () => reject(new Error('Cannot load video'));
    });

    video.currentTime = 0;
    await new Promise(r => { video.onseeked = r; });
    await video.play();

    this.flow.reset();
    const frames = [];
    const fps = 30;
    const duration = Math.min(4, video.duration || 4);
    const totalFrames = Math.floor(duration * fps);

    return new Promise((resolve) => {
      let frameCount = 0;
      const interval = setInterval(() => {
        if (video.paused || video.ended || frameCount >= totalFrames) {
          clearInterval(interval);
          video.pause();

          if (frames.length < 16) {
            URL.revokeObjectURL(url);
            resolve(null);
            return;
          }

          const params = distillSwatch(frames, fps);
          if (!params) { URL.revokeObjectURL(url); resolve(null); return; }

          const motion = {
            id: 'uploaded-' + Date.now(),
            name: file.name.replace(/\.[^.]+$/, ''),
            desc: 'Captured in-browser (Lucas–Kanade)',
            color: '#ff8a4c',
            params,
            fromUpload: true,
            engine: 'browser-lk',
            // keep the object URL alive: the library card shows the real
            // clip as a looping thumbnail
            videoUrl: url,
            // no Contract-B swatch: the builders live in service/contracts.py (one source
            // of truth), and this fallback runs precisely when that service is down.
            // Empty, not faked — the library falls back to `desc` for these.
            swatches: [],
          };
          if (this.onComplete) this.onComplete(motion);
          resolve(motion);
          return;
        }

        const result = this.flow.step(video);
        if (result) frames.push(result);
        frameCount++;
        if (this.onProgress) this.onProgress(frameCount / totalFrames);
      }, 1000 / fps);
    });
  }
}

window.MotionCapture = MotionCapture;
