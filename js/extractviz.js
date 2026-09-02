/*
 * extractviz.js — the "extraction moment" overlay.
 *
 * After the analysis service returns, showExtraction() plays the uploaded
 * clip in a modal with the 144 real RAFT trajectories drawn as glowing
 * streaklines over it (windowed to the current playback time), then sweeps
 * the streaks toward the top-left (where the swatch card lands in the
 * library) while the extracted numbers count up. Total ~6s, skippable.
 *
 * showExtraction(videoUrl, trajectories, params, color) -> Promise<void>
 *   trajectories: [track][frame][x,y] normalized 0..1 (service format)
 */

(() => {
'use strict';

const DURATION_PLAY = 3.6;    // seconds of streakline playback
const DURATION_SWEEP = 1.5;   // seconds of collapse sweep
const WINDOW = 14;            // trail length in trajectory frames

function ease(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }

window.showExtraction = function showExtraction(videoUrl, trajectories, params, color) {
  return new Promise((resolve) => {
    if (!trajectories || !trajectories.length) { resolve(); return; }

    // ---------- modal scaffold ----------
    const modal = document.createElement('div');
    modal.className = 'extract-modal';
    modal.innerHTML = `
      <div class="extract-stage">
        <video muted playsinline></video>
        <canvas></canvas>
        <div class="extract-readout"></div>
        <button class="extract-skip">Skip ▸</button>
      </div>`;
    document.body.appendChild(modal);

    const video = modal.querySelector('video');
    const canvas = modal.querySelector('canvas');
    const readout = modal.querySelector('.extract-readout');
    const ctx = canvas.getContext('2d');
    video.src = videoUrl;

    const T = trajectories[0].length;
    let raf = null, done = false;
    let phase = 'play', phaseStart = 0;

    function finish() {
      if (done) return;
      done = true;
      if (raf) cancelAnimationFrame(raf);
      video.pause();
      modal.classList.add('closing');
      setTimeout(() => { modal.remove(); resolve(); }, 280);
    }
    modal.querySelector('.extract-skip').onclick = finish;

    // ---------- the counting readout ----------
    const ROWS = [
      ['frequency', params.frequency, ' Hz'],
      ['direction', params.direction, '°'],
      ['amplitude', params.amplitude, ''],
      ['turbulence', params.turbulence, ''],
      ['drift ↓', params.driftY ?? 0, ''],
    ];
    readout.innerHTML = ROWS.map(([k]) =>
      `<div class="xr-row"><span class="xr-k">${k}</span><span class="xr-v">0</span></div>`).join('');
    const valEls = [...readout.querySelectorAll('.xr-v')];

    function updateReadout(p) {
      ROWS.forEach(([k, target, unit], i) => {
        const v = target * Math.min(1, p);
        valEls[i].textContent = (Math.abs(target) >= 10 ? v.toFixed(0) : v.toFixed(2)) + unit;
      });
    }

    // ---------- render loop ----------
    function draw(now) {
      if (done) return;
      raf = requestAnimationFrame(draw);
      if (!phaseStart) phaseStart = now;
      const el = (now - phaseStart) / 1000;

      const W = canvas.width = canvas.clientWidth * 2;
      const H = canvas.height = canvas.clientHeight * 2;
      ctx.clearRect(0, 0, W, H);

      const dur = video.duration || 4;
      const frameF = Math.min(T - 1, (video.currentTime / dur) * (T - 1));

      let sweep = 0, alpha = 1;
      if (phase === 'play' && el >= DURATION_PLAY) { phase = 'sweep'; phaseStart = now; }
      if (phase === 'sweep') {
        sweep = ease(Math.min(1, el / DURATION_SWEEP));
        alpha = 1 - sweep * 0.85;
        if (el >= DURATION_SWEEP + 0.35) { finish(); return; }
      }
      updateReadout(phase === 'sweep' ? 1 : el / DURATION_PLAY);

      ctx.lineCap = 'round';
      for (let i = 0; i < trajectories.length; i++) {
        const track = trajectories[i];
        const f1 = Math.floor(frameF);
        const f0 = Math.max(0, f1 - WINDOW);
        // energy filter: skip almost-static tracks so the motion silhouette pops
        const dx = track[f1][0] - track[f0][0], dy = track[f1][1] - track[f0][1];
        const energy = Math.hypot(dx, dy);
        if (energy < 0.0015) continue;

        for (let f = f0; f < f1; f++) {
          const t0 = track[f], t1 = track[f + 1];
          const seg = (f - f0) / WINDOW;
          let x0 = t0[0] * W, y0 = t0[1] * H, x1 = t1[0] * W, y1 = t1[1] * H;
          if (sweep) {           // collapse toward top-left (library direction)
            x0 -= x0 * sweep; y0 -= y0 * sweep * 0.9;
            x1 -= x1 * sweep; y1 -= y1 * sweep * 0.9;
          }
          ctx.strokeStyle = color;
          ctx.globalAlpha = alpha * seg * Math.min(1, energy * 260);
          ctx.lineWidth = 2 + seg * 3;
          ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
        }
        // head dot
        if (!sweep) {
          ctx.globalAlpha = Math.min(1, energy * 300);
          ctx.fillStyle = '#fff';
          ctx.beginPath();
          ctx.arc(track[f1][0] * W, track[f1][1] * H, 2.5, 0, 7);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    }

    video.addEventListener('loadeddata', () => {
      video.currentTime = 0;
      video.play().catch(() => {});
      raf = requestAnimationFrame(draw);
    });
    video.addEventListener('error', finish);
    setTimeout(() => { if (!done && video.readyState < 2) finish(); }, 2500);
  });
};

})();
