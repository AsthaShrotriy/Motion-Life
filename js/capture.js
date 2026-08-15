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

const SERVICE_URL = 'http://127.0.0.1:8765';

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

  async captureFromFile(file) {
    // ---- preferred: deep-flow analysis service ----
    const svc = await this.serviceAvailable();
    if (svc) {
      try {
        if (this.onProgress) this.onProgress(-1, `Analyzing with ${svc.engine}…`);
        const form = new FormData();
        form.append('file', file, file.name);
        const resp = await fetch(SERVICE_URL + '/analyze', { method: 'POST', body: form });
        const j = await resp.json();
        if (j.ok) {
          const motion = {
            id: 'uploaded-' + Date.now(),
            name: file.name.replace(/\.[^.]+$/, ''),
            desc: `Captured via ${j.engine} (${j.frames_analyzed} frames)`,
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
