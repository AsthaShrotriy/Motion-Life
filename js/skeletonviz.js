/*
 * skeletonviz.js — show the EXTRACTED character motion as an animated stick figure.
 *
 * The MediaPipe capture returns a bbox-normalized skeleton (13 joints/frame). This
 * plays the source clip next to the extracted stick figure so you can SEE that the
 * character motion is real (the skeleton walks like the video) before it drives the rig.
 * Coords are relative to the person's bbox (global position was normalized away), so
 * the skeleton is drawn in its own box beside the video rather than overlaid on it.
 *
 * window.showSkeleton(videoUrl, pose, color) -> Promise<void>
 *   pose = { joints:[names], fps, frames:[ [[x,y,c] x13] | null ... ] }
 */
(() => {
'use strict';

// Bones by joint NAME (robust to index order) — mirrors contracts.POSE_EDGES.
const BONES = [
  ['nose', 'l_sho'], ['nose', 'r_sho'], ['l_sho', 'r_sho'],
  ['l_sho', 'l_elb'], ['l_elb', 'l_wri'], ['r_sho', 'r_elb'], ['r_elb', 'r_wri'],
  ['l_sho', 'l_hip'], ['r_sho', 'r_hip'], ['l_hip', 'r_hip'],
  ['l_hip', 'l_knee'], ['l_knee', 'l_ank'], ['r_hip', 'r_knee'], ['r_knee', 'r_ank'],
];

// Shared skeleton renderer — used by the preview modal AND the library swatch (main.js).
// Draws ONE bbox-normalized frame ([[x,y,c]xN]) into a W×H canvas box.
window.drawSkeletonFrame = function (ctx, frame, joints, W, H, opts) {
  opts = opts || {};
  const pad = opts.pad != null ? opts.pad : 8;
  const idx = {}; joints.forEach((n, i) => { idx[n] = i; });
  const P = (name) => {
    const p = frame[idx[name]];
    return p ? [pad + p[0] * (W - 2 * pad), pad + p[1] * (H - 2 * pad)] : null;
  };
  ctx.lineCap = 'round';
  ctx.strokeStyle = opts.color || '#34d399';
  ctx.lineWidth = opts.lineWidth != null ? opts.lineWidth : 3;
  for (const [a, b] of BONES) {
    const pa = P(a), pb = P(b);
    if (pa && pb) { ctx.beginPath(); ctx.moveTo(pa[0], pa[1]); ctx.lineTo(pb[0], pb[1]); ctx.stroke(); }
  }
  ctx.fillStyle = opts.jointColor || '#ffd23f';
  const jr = opts.jointR != null ? opts.jointR : 3;
  for (const nm of joints) { const p = P(nm); if (p) { ctx.beginPath(); ctx.arc(p[0], p[1], jr, 0, 7); ctx.fill(); } }
};

window.showSkeleton = function showSkeleton(videoUrl, pose, color = '#34d399') {
  return new Promise((resolve) => {
    const frames = ((pose && pose.frames) || []).filter(Boolean);
    if (!frames.length || !pose.joints) { resolve(); return; }
    const fps = pose.fps || 15, n = frames.length;

    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;' +
      'justify-content:center;background:rgba(6,10,16,.74);backdrop-filter:blur(3px)';
    modal.innerHTML =
      '<div style="background:#0f1620;border:1px solid #24303f;border-radius:14px;padding:16px;' +
      'box-shadow:0 20px 60px rgba(0,0,0,.5);max-width:92vw">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">' +
          '<div style="color:#dfe8f2;font:600 14px system-ui,-apple-system,sans-serif">' +
            'Extracted motion → stick figure ' +
            '<span style="color:#7d8da8;font-weight:400">· MediaPipe · ' + pose.joints.length +
            ' joints · ' + n + ' frames</span></div>' +
          '<button class="sk-skip" style="background:#1d2735;color:#cfe;border:1px solid #2c3a4c;' +
            'border-radius:8px;padding:6px 12px;cursor:pointer;font:500 12px system-ui">Close ▸</button>' +
        '</div>' +
        '<div style="display:flex;gap:14px;align-items:stretch">' +
          '<div style="position:relative">' +
            '<video muted playsinline loop style="width:300px;height:300px;object-fit:cover;' +
              'border-radius:10px;background:#000;display:block"></video>' +
            '<div style="position:absolute;left:8px;bottom:8px;color:#cfe;font:500 11px system-ui;' +
              'background:rgba(0,0,0,.5);padding:2px 8px;border-radius:6px">source video</div>' +
          '</div>' +
          '<div style="position:relative">' +
            '<canvas width="600" height="600" style="width:300px;height:300px;border-radius:10px;' +
              'background:#0a1017;border:1px solid #22303f;display:block"></canvas>' +
            '<div style="position:absolute;left:8px;bottom:8px;color:#9fe6c8;font:500 11px system-ui;' +
              'background:rgba(0,0,0,.5);padding:2px 8px;border-radius:6px">extracted skeleton</div>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);

    const video = modal.querySelector('video');
    const canvas = modal.querySelector('canvas');
    const ctx = canvas.getContext('2d');
    video.src = videoUrl;
    video.play().catch(() => {});

    let raf = null, done = false;
    function finish() {
      if (done) return;
      done = true;
      if (raf) cancelAnimationFrame(raf);
      try { video.pause(); } catch (_) {}
      modal.remove();
      resolve();
    }
    modal.querySelector('.sk-skip').onclick = finish;
    modal.onclick = (e) => { if (e.target === modal) finish(); };

    const W = canvas.width, H = canvas.height;
    function drawFrame(f) {
      ctx.clearRect(0, 0, W, H);
      window.drawSkeletonFrame(ctx, f, pose.joints, W, H, { pad: 70, color, lineWidth: 6, jointR: 7 });
    }
    function loop() {
      if (done) return;
      raf = requestAnimationFrame(loop);
      const fi = Math.floor((video.currentTime || 0) * fps) % n;
      drawFrame(frames[fi]);
    }
    raf = requestAnimationFrame(loop);
    setTimeout(finish, 9000);   // auto-close so it never lingers
  });
};

})();
