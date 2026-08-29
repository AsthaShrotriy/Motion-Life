/*
 * videoexport.js — record the animated artwork to a video file (for Reels).
 *
 * Renders the live SVG to an offscreen canvas each frame while the animator
 * plays, captures the canvas stream with MediaRecorder, and downloads a
 * .webm (or .mp4 where the browser supports it). Two aspect modes:
 *   'landscape' — the artwork as-is (1600x1000)
 *   'reel'      — 1080x1920 vertical: artwork centered, blurred fill above
 *                 and below (the Instagram-ready framing)
 *
 * exportVideo(sel, animator, { seconds, mode, onProgress }) -> Promise<Blob>
 */

(() => {
'use strict';

function pickMime() {
  const candidates = [
    'video/mp4;codecs=avc1',           // Safari/Chrome 126+ mp4 recording
    'video/webm;codecs=vp9',
    'video/webm',
  ];
  for (const m of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

async function svgToImage(svgNode) {
  const xml = new XMLSerializer().serializeToString(svgNode);
  const blob = new Blob([xml], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 100);
  }
}

// Shared with js/judge.js (Step 9), which needs the same "serialize the LIVE svg,
// transforms and all" primitive to grab frames for the judge. Exported rather than
// copied so there is one definition of what a captured frame is.
window.svgToImage = svgToImage;

window.exportVideo = async function exportVideo(sel, animator, opts = {}) {
  const seconds = opts.seconds || 8;
  const mode = opts.mode || 'reel';
  const onProgress = opts.onProgress || (() => {});
  const svg = sel._svg;
  if (!svg) throw new Error('no SVG artwork loaded');

  const mime = pickMime();
  if (!mime) throw new Error('MediaRecorder not supported in this browser');

  const canvas = document.createElement('canvas');
  if (mode === 'reel') { canvas.width = 1080; canvas.height = 1920; }
  else { canvas.width = 1600; canvas.height = 1000; }
  const ctx = canvas.getContext('2d');

  const stream = canvas.captureStream(30);
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
  const chunks = [];
  rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };

  const wasPlaying = animator.playing;
  if (!wasPlaying) animator.play();

  const t0 = performance.now();
  let stopped = false;

  rec.start(200);

  // frame pump: serialize the LIVE svg (with current transforms/deformations)
  // and paint it. ~20fps serialize cost is fine for a 5-10s export.
  async function pump() {
    if (stopped) return;
    const elapsed = (performance.now() - t0) / 1000;
    if (elapsed >= seconds) {
      stopped = true;
      rec.stop();
      return;
    }
    onProgress(elapsed / seconds);
    try {
      const img = await svgToImage(svg);
      const W = canvas.width, H = canvas.height;
      if (mode === 'reel') {
        // blurred cover fill
        ctx.filter = 'blur(40px)';
        const s = Math.max(W / img.width, H / img.height) * 1.15;
        ctx.drawImage(img, (W - img.width * s) / 2, (H - img.height * s) / 2, img.width * s, img.height * s);
        ctx.filter = 'none';
        ctx.fillStyle = 'rgba(10,10,20,0.25)';
        ctx.fillRect(0, 0, W, H);
        // sharp centered artwork
        const s2 = W / img.width;
        const h2 = img.height * s2;
        ctx.drawImage(img, 0, (H - h2) / 2, W, h2);
      } else {
        ctx.fillStyle = '#0d0d14';
        ctx.fillRect(0, 0, W, H);
        const s = Math.min(W / img.width, H / img.height);
        ctx.drawImage(img, (W - img.width * s) / 2, (H - img.height * s) / 2, img.width * s, img.height * s);
      }
    } catch { /* skip a frame on serialize hiccup */ }
    requestAnimationFrame(pump);
  }
  pump();

  const blob = await new Promise((resolve) => {
    rec.onstop = () => resolve(new Blob(chunks, { type: mime.split(';')[0] }));
  });
  if (!wasPlaying) animator.pause();
  onProgress(1);
  return blob;
};

})();
