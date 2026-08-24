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
const PREPROCESS_SERVICE_URL = 'http://127.0.0.1:8872'; // Step 2: mask + camera motion

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

  /* Preprocess (Step 2): given a clip + one Contract-A motion (with a bbox), get a
     clean object mask + camera motion so downstream extraction runs only inside the
     masked object. `motion` is a Contract-A entry { id, class, bbox:[x,y,w,h] }.
     Returns a region_preprocess contract, or null if the service isn't running
     (caller then falls back to the raw router bbox as a rectangular mask). */
  async preprocessRegion(file, motion) {
    const b = (motion && motion.bbox) || [0, 0, 1, 1];
    const qs = `motion_id=${encodeURIComponent(motion && motion.id || '')}` +
               `&class=${encodeURIComponent(motion && motion.class || '')}` +
               `&bbox=${b.map(v => (+v).toFixed(4)).join(',')}`;
    try {
      const resp = await fetch(`${PREPROCESS_SERVICE_URL}/preprocess?${qs}`,
                               { method: 'POST', body: file });
      const j = await resp.json();
      if (j.error) throw new Error(j.error);
      return j;
    } catch (e) {
      console.warn('[preprocess] region preprocess unavailable:', e.message);
      return null;
    }
  }

  /* Character / skeletal motion: POST the clip to the MediaPipe pose service,
     which returns a captured pose sequence (joints + per-frame keypoints).
     Returns {joints, fps, frames, detected, total} or null if unavailable. */
  async captureCharacter(file, kind = 'pose') {
    // kind: 'pose' (default, byte-compatible response the rig consumes) | 'hands' | 'face'.
    // hands/face return a Contract-B skeleton swatch (subject!=='pose') and must NOT be
    // routed to the body rig (_applyCharacter) — see js/animate.js.
    const qs = kind && kind !== 'pose' ? `?kind=${encodeURIComponent(kind)}` : '';
    try {
      const resp = await fetch(POSE_SERVICE_URL + '/extract' + qs, { method: 'POST', body: file });
      const j = await resp.json();
      if (j.error) throw new Error(j.error);
      return j;
    } catch (e) {
      console.warn('[pose] captureCharacter unavailable:', e.message);
      return null;   // matches decomposeMotion/preprocessRegion; caller guards on !pose
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
        const url = SERVICE_URL + '/analyze' + (qs.length ? '?' + qs.join('&') : '');
        const resp = await fetch(url, { method: 'POST', body: form });
        const j = await resp.json();
        if (j.ok) {
          const via = j.engine + (j.tracker && j.tracker !== 'raft-grid' ? ' + ' + j.tracker : '');
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
