/*
 * multiextract.js — the live extraction overlay.
 *
 * Opens the instant a clip is uploaded and stays up until extraction finishes,
 * so the wait itself shows the work. The clip plays underneath; a status pill
 * reports the current phase (VLM read → route → extract N/M); and each motion's
 * trajectory field is drawn over the clip THE MOMENT it is extracted — so on a
 * multi-motion clip you watch the fields pop in one after another (extraction is
 * sequential), each in its own color with a dashed bbox and an engine tag
 * (RAFT / SEA-RAFT / CoTracker). When extraction completes the fields sweep
 * toward the library and the overlay closes. Skippable.
 *
 * Every backend returns trajectories in the SAME shape — [track][frame][x,y]
 * normalized 0..1 — so nothing here branches on the engine; it just labels it.
 *
 *   const reveal = startExtractionReveal(videoUrl);   // opens immediately
 *   reveal.setStatus('Extracting 1/2…');              // update the pill
 *   reveal.addMotion({ trajectories, color, name, engine, bbox });  // draw a field
 *   reveal.finish();   // sweep + close (fast fade if no fields were added)
 *   await reveal.promise;
 *
 * bbox is the VLM router's [x, y, w, h] normalized rect, or omitted.
 * Legacy one-shot form kept for callers/tests: showMultiExtraction(url, motions).
 */

(() => {
'use strict';

const DURATION_SWEEP = 1.5;   // seconds of collapse sweep on finish
const WINDOW = 14;            // trail length in trajectory frames
const REVEAL = 0.5;           // seconds a motion takes to fade in when added
const HOLD = 1.6;             // seconds the finished fields hold before sweeping

function ease(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

window.startExtractionReveal = function startExtractionReveal(videoUrl, opts = {}) {
  const motions = [];
  let raf = null, done = false, finishing = false, finishAt = 0, phase = 'live', sweepStart = 0;

  // ---------- modal scaffold (reuses the single-motion .extract-* chrome) ----------
  const modal = document.createElement('div');
  modal.className = 'extract-modal mx-modal';
  modal.innerHTML = `
    <div class="mx-shell">
      <button class="extract-skip">Skip ▸</button>
      <div class="mx-body">
        <div class="extract-stage">
          <video muted playsinline loop></video>
          <canvas></canvas>
          <div class="mx-status"><span class="mx-spin"></span><span class="mx-status-text">Reading the clip…</span></div>
        </div>
        <div class="mx-swatches"><div class="mx-swatches-title">Analyzing…</div></div>
      </div>
    </div>`;
  document.body.appendChild(modal);

  const video = modal.querySelector('video');
  const canvas = modal.querySelector('canvas');
  const swatchesEl = modal.querySelector('.mx-swatches');
  const swatchesTitle = modal.querySelector('.mx-swatches-title');
  const statusEl = modal.querySelector('.mx-status');
  const statusText = modal.querySelector('.mx-status-text');
  const ctx = canvas.getContext('2d');
  video.src = videoUrl;

  let resolveDone;
  const promise = new Promise(r => { resolveDone = r; });

  function close() {
    if (done) return;
    done = true;
    if (raf) cancelAnimationFrame(raf);
    // release the decoder but NOT the object URL — the caller owns it (it's the same
    // clip the Videos list keeps showing as a thumbnail).
    try { video.pause(); video.removeAttribute('src'); video.load(); } catch (_) {}
    modal.classList.add('closing');
    setTimeout(() => { modal.remove(); resolveDone(); }, 280);
  }

  // Add a freshly-extracted motion. It starts drawing right away (fading in), and
  // gets a legend chip. `addedAt` drives the per-motion fade so late arrivals ease in.
  function addMotion(m) {
    if (done || !m) return;
    const rec = Object.assign({}, m, { addedAt: performance.now() });
    // one swatch card on the right: an animated mini-canvas of this motion's field
    // (the same looping preview the library chip shows) + a name/engine caption.
    const card = document.createElement('div');
    card.className = 'mx-swatch';
    card.style.borderColor = m.color || '#7c6cff';
    const cv = document.createElement('canvas');
    cv.width = 320; cv.height = 200;   // retina backing store for a 16:10 card
    const cap = document.createElement('div');
    cap.className = 'mx-swatch-cap';
    cap.innerHTML = esc(m.name || ('Motion ' + (motions.length + 1))) +
      (m.engine ? `<span class="eng">${esc(m.engine)}</span>` : '');
    card.appendChild(cv); card.appendChild(cap);
    swatchesEl.appendChild(card);
    rec._sw = cv.getContext('2d');
    motions.push(rec);
    swatchesTitle.textContent = `${motions.length} extracted`;
  }

  function setStatus(text) { if (statusText && text != null) statusText.textContent = text; }

  // Mark the overlay "done" WITHOUT sweeping/closing — the fields keep looping and the
  // swatches stay up. Used by preview mode, where the user closes when they're finished.
  function markComplete(text) {
    if (statusEl) statusEl.classList.add('mx-status-done');
    setStatus(text || 'Extraction complete');
  }

  // Extraction is done. If any fields were drawn, hold briefly then sweep them toward
  // the library and close; if none (a character clip, or a total fallback), fade out fast.
  function finish() {
    if (finishing || done) return;
    finishing = true;
    if (statusEl) statusEl.classList.add('mx-status-done');
    if (!motions.length) { close(); return; }
    setStatus('Extraction complete');
    finishAt = performance.now();
  }

  const skipBtn = modal.querySelector('.extract-skip');
  if (opts.closeLabel) skipBtn.textContent = opts.closeLabel;
  skipBtn.onclick = close;
  // preview mode: clicking the dark backdrop (outside the stage) also closes
  if (opts.backdropClose) modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

  // ---------- render loop ----------
  function draw(now) {
    if (done) return;
    raf = requestAnimationFrame(draw);

    const W = canvas.width = canvas.clientWidth * 2;
    const H = canvas.height = canvas.clientHeight * 2;
    ctx.clearRect(0, 0, W, H);

    const dur = video.duration || 4;

    let sweep = 0, gAlpha = 1;
    if (finishing && phase === 'live' && (now - finishAt) / 1000 >= HOLD) {
      phase = 'sweep'; sweepStart = now;
    }
    if (phase === 'sweep') {
      sweep = ease(Math.min(1, (now - sweepStart) / 1000 / DURATION_SWEEP));
      gAlpha = 1 - sweep * 0.85;
      if ((now - sweepStart) / 1000 >= DURATION_SWEEP + 0.35) { close(); return; }
    }

    ctx.lineCap = 'round';
    for (const m of motions) {
      const ra = Math.max(0, Math.min(1, (now - m.addedAt) / 1000 / REVEAL));  // fade-in
      if (ra <= 0) continue;

      // CHARACTER motion: draw the extracted skeleton over the person (within its bbox) — the
      // body-motion equivalent of the trajectory streaklines for a texture/flow motion.
      if (m.pose && m.pose.frames && m.pose.frames.length && window.drawSkeletonFrame) {
        if (sweep) continue;
        const fr = m.pose.frames, n = fr.length;
        const clock = (video.currentTime && dur ? video.currentTime : now / 1000);
        const fi = Math.floor(clock * (m.pose.fps || 15)) % n;
        const bb = (Array.isArray(m.bbox) && m.bbox.length === 4) ? m.bbox : [0, 0, 1, 1];
        const [bx, by, bw, bh] = bb;
        ctx.save();
        ctx.globalAlpha = ra;
        ctx.translate(bx * W, by * H);
        if (fr[fi]) window.drawSkeletonFrame(ctx, fr[fi], m.pose.joints, bw * W, bh * H,
          { pad: 0, color: m.color || '#34d399', lineWidth: Math.max(3, W * 0.004), jointR: Math.max(3, W * 0.004) });
        ctx.restore();
        continue;
      }

      const tracks = m.trajectories;
      if (!tracks || !tracks.length || !tracks[0]) continue;

      const localT = tracks[0].length;
      const frameF = Math.min(localT - 1, (video.currentTime / dur) * (localT - 1));
      const f1 = Math.floor(frameF), f0 = Math.max(0, f1 - WINDOW);
      const color = m.color || '#7c6cff';
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';

      for (let i = 0; i < tracks.length; i++) {
        const track = tracks[i];
        if (!track || !track[f1] || !track[f0]) continue;
        // energy filter: near-static cells stay dark so the moving silhouette pops
        const dx = track[f1][0] - track[f0][0], dy = track[f1][1] - track[f0][1];
        const energy = Math.hypot(dx, dy);
        if (energy < 0.0015) continue;

        for (let f = f0; f < f1; f++) {
          const t0 = track[f], t1 = track[f + 1];
          if (!t0 || !t1) continue;
          const seg = (f - f0) / WINDOW;
          let x0 = t0[0] * W, y0 = t0[1] * H, x1 = t1[0] * W, y1 = t1[1] * H;
          if (sweep) {           // collapse toward top-left (the library direction)
            x0 -= x0 * sweep; y0 -= y0 * sweep * 0.9;
            x1 -= x1 * sweep; y1 -= y1 * sweep * 0.9;
          }
          // Bright, thick streaklines with a CHEAP glow: a wide faint pass under a bright
          // thin core (both stroke the same path). No shadowBlur — that tanks the frame rate
          // and makes the video (and these trails) stutter.
          const a = gAlpha * ra * Math.min(1, 0.25 + seg) * Math.min(1, energy * 340);
          ctx.strokeStyle = color;
          ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
          ctx.globalAlpha = a * 0.28; ctx.lineWidth = 3 + seg * 6;   ctx.stroke();  // glow
          ctx.globalAlpha = a;        ctx.lineWidth = 1.2 + seg * 2.6; ctx.stroke();  // core
        }
        if (!sweep) {                          // head: bright white core over a soft coloured halo
          const hx = track[f1][0] * W, hy = track[f1][1] * H;
          const ha = ra * Math.min(1, energy * 360);
          ctx.fillStyle = color; ctx.globalAlpha = ha * 0.4;
          ctx.beginPath(); ctx.arc(hx, hy, 4.5, 0, 7); ctx.fill();
          ctx.fillStyle = '#fff'; ctx.globalAlpha = ha;
          ctx.beginPath(); ctx.arc(hx, hy, 2, 0, 7); ctx.fill();
        }
      }

      // dashed bbox marks WHERE this motion is; its name + engine live on the
      // matching swatch card to the right, so no on-canvas label is needed.
      if (!sweep && Array.isArray(m.bbox) && m.bbox.length === 4) {
        const [bx, by, bw, bh] = m.bbox;
        ctx.globalAlpha = 0.7 * ra;
        ctx.strokeStyle = color; ctx.lineWidth = 2;
        ctx.setLineDash([6, 5]);
        ctx.strokeRect(bx * W, by * H, bw * W, bh * H);
        ctx.setLineDash([]);
      }
    }
    ctx.globalAlpha = 1;

    // ---- right-side swatches: each field looping in its own mini canvas ----
    // Positions are re-normalized into the motion's own bbox so a corner motion
    // still fills its swatch. Ping-pong loop + motion-blur trails, like the library chip.
    const swClock = now / 1000;
    for (const m of motions) {
      const sctx = m._sw;
      if (!sctx) continue;
      const cw = sctx.canvas.width, ch = sctx.canvas.height, pad = Math.min(cw, ch) * 0.14;
      // CHARACTER motion: the swatch is the extracted skeleton looping (clean redraw, no trails)
      if (m.pose && m.pose.frames && m.pose.frames.length && window.drawSkeletonFrame) {
        sctx.fillStyle = 'rgba(12, 14, 22, 0.95)';
        sctx.fillRect(0, 0, cw, ch);
        const fr = m.pose.frames, n = fr.length;
        const fi = Math.floor(swClock * (m.pose.fps || 15)) % n;
        if (fr[fi]) window.drawSkeletonFrame(sctx, fr[fi], m.pose.joints, cw, ch,
          { pad: pad, color: m.color || '#34d399', lineWidth: Math.max(2, cw * 0.014), jointR: Math.max(2, cw * 0.012) });
        continue;
      }
      const tracks = m.trajectories;
      sctx.fillStyle = 'rgba(12, 14, 22, 0.34)';   // translucent wipe → dot trails
      sctx.fillRect(0, 0, cw, ch);
      if (!tracks || !tracks.length || !tracks[0]) continue;
      const localT = tracks[0].length;
      const ff = (swClock * 12) % (2 * localT);
      const fi = ff < localT ? Math.floor(ff) : (2 * localT - 1 - Math.floor(ff));
      const bb = (Array.isArray(m.bbox) && m.bbox.length === 4) ? m.bbox : [0, 0, 1, 1];
      const bx = bb[0], by = bb[1], bw = bb[2] || 1, bh = bb[3] || 1;
      // letterbox the (square-normalized) field into a centered square so a landscape
      // card doesn't stretch it
      const size = Math.min(cw, ch) - 2 * pad;
      const ox = (cw - size) / 2, oy = (ch - size) / 2;
      sctx.fillStyle = m.color || '#7c6cff';
      for (const track of tracks) {
        const p = track[fi];
        if (!p) continue;
        let nx = (p[0] - bx) / bw, ny = (p[1] - by) / bh;
        nx = Math.max(0, Math.min(1, nx)); ny = Math.max(0, Math.min(1, ny));
        sctx.beginPath();
        sctx.arc(ox + nx * size, oy + ny * size, 2.4, 0, 7);
        sctx.fill();
      }
    }
  }

  function startLoop() { if (!raf && !done) raf = requestAnimationFrame(draw); }
  video.addEventListener('loadeddata', () => {
    video.currentTime = 0; video.play().catch(() => {}); startLoop();
  });
  video.addEventListener('error', startLoop);
  // run the loop even if the clip is slow/undecodable, so the status pill still shows
  setTimeout(startLoop, 800);

  return { addMotion, setStatus, finish, markComplete, close, promise, get count() { return motions.length; } };
};

// Preview an already-extracted clip: open the overlay in its completed state (fields
// looping over the clip, swatches on the right, no spinner) and leave it open until the
// user closes it. Called by the Videos list's preview (eye) button.
window.previewExtraction = function previewExtraction(videoUrl, motions) {
  const list = motions || [];
  const reveal = window.startExtractionReveal(videoUrl, { closeLabel: 'Close ▸', backdropClose: true });
  list.forEach(m => reveal.addMotion(m));
  const drawable = list.filter(
    m => m && Array.isArray(m.trajectories) && m.trajectories.length && m.trajectories[0]).length;
  reveal.markComplete(drawable ? `Preview — ${drawable} motion${drawable > 1 ? 's' : ''}` : 'Preview');
  return reveal.promise;
};

// Legacy one-shot: open, draw all motions, auto-finish after a beat. Kept so older
// callers / tests keep working; the live path above drives real uploads now.
window.showMultiExtraction = function showMultiExtraction(videoUrl, motions) {
  const list = (motions || []).filter(
    m => m && Array.isArray(m.trajectories) && m.trajectories.length && m.trajectories[0]);
  const reveal = window.startExtractionReveal(videoUrl);
  list.forEach(m => reveal.addMotion(m));
  setTimeout(() => reveal.finish(), 300 + list.length * 450 + 2500);
  return reveal.promise;
};

})();
