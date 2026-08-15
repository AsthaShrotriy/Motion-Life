/*
 * multipick.js — the multi-motion picker.
 *
 * When the RAFT service segments an uploaded video into ≥2 motion regions
 * (see service/server.py :: segment_regions), this modal appears BEFORE the
 * existing extraction moment. The user sees the clip looping with each
 * region's trajectories drawn in its own color, plus a labeled bounding
 * box. Beside the video is one card per region — checkbox (default on),
 * suggested name (editable), param summary. Save keeps only the checked
 * ones and returns them as Motion objects; the caller adds each to the
 * library and runs the existing showExtraction() only if there's exactly
 * one, keeping the "wow" for single-motion uploads.
 *
 * showMultiPick(videoUrl, regions, {engine, framesAnalyzed}) -> Promise<Motion[]>
 *   regions: [{ params, trajectories, bbox, cells, suggested_name, color }]
 *   returns: user's chosen motions with unique ids and user-supplied names
 */

(() => {
'use strict';

const TRAIL = 14;                 // trail length in trajectory frames
const STROKE_MIN = 1.4;
const STROKE_MAX = 3.6;

window.showMultiPick = function showMultiPick(videoUrl, regions, meta = {}) {
  return new Promise((resolve) => {
    if (!regions || regions.length < 2) { resolve([]); return; }

    // ---------- scaffold ----------
    const modal = document.createElement('div');
    modal.className = 'multipick-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'mp-title');
    modal.innerHTML = `
      <div class="mp-panel" tabindex="-1">
        <div class="mp-header">
          <div>
            <div class="mp-title" id="mp-title">Multiple motions detected</div>
            <div class="mp-sub">${regions.length} regions found${meta.engine ? ' · ' + meta.engine : ''}${meta.framesAnalyzed ? ' · ' + meta.framesAnalyzed + ' frames' : ''}. Pick the ones to save.</div>
          </div>
          <button class="mp-close" aria-label="Cancel" title="Cancel">✕</button>
        </div>
        <div class="mp-body">
          <div class="mp-stage">
            <video muted playsinline loop></video>
            <canvas class="mp-viz"></canvas>
          </div>
          <div class="mp-cards" role="list"></div>
        </div>
        <div class="mp-actions">
          <div class="mp-hint" aria-live="polite">Click a card to preview just that motion. Uncheck ones you don't want. Press Esc to cancel.</div>
          <div class="mp-actions-right">
            <button class="mp-cancel">Cancel</button>
            <button class="mp-save">Save selected</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(modal);

    const video = modal.querySelector('video');
    const canvas = modal.querySelector('.mp-viz');
    const cardsEl = modal.querySelector('.mp-cards');
    const ctx = canvas.getContext('2d');
    video.src = videoUrl;

    // per-region UI state
    const state = regions.map((r, i) => ({
      region: r,
      selected: true,
      name: r.suggested_name || `Motion ${i + 1}`,
      idx: i,
      hovered: false,
      soloed: false,        // when a card is soloed only that region draws
    }));

    // ---------- build cards ----------
    for (const st of state) {
      const p = st.region.params;
      const card = document.createElement('div');
      card.className = 'mp-card';
      card.setAttribute('role', 'listitem');
      card.style.setProperty('--region-color', st.region.color);
      const cbId = `mp-cb-${st.idx}`;
      const nmId = `mp-nm-${st.idx}`;
      card.innerHTML = `
        <label class="mp-check" for="${cbId}" aria-label="Include this motion">
          <input type="checkbox" id="${cbId}" checked>
          <span class="mp-swatch"></span>
        </label>
        <div class="mp-fields">
          <input class="mp-name" id="${nmId}" type="text" value="${escapeAttr(st.name)}"
                 aria-label="Motion name">
          <div class="mp-params">
            <span>freq <b>${p.frequency.toFixed(2)}</b>Hz</span>
            <span>dir <b>${p.direction}°</b></span>
            <span>amp <b>${p.amplitude.toFixed(2)}</b></span>
            <span>turb <b>${p.turbulence.toFixed(2)}</b></span>
            ${Math.abs(p.driftY || 0) > 0.15 ? `<span>drift↓ <b>${(p.driftY).toFixed(2)}</b></span>` : ''}
            ${Math.abs(p.driftX || 0) > 0.15 ? `<span>drift→ <b>${(p.driftX).toFixed(2)}</b></span>` : ''}
          </div>
        </div>`;
      const cb = card.querySelector('input[type="checkbox"]');
      const label = card.querySelector('.mp-check');
      const nameInput = card.querySelector('.mp-name');
      cb.addEventListener('change', () => {
        st.selected = cb.checked;
        card.classList.toggle('unselected', !cb.checked);
        updateSaveEnabled();
      });
      nameInput.addEventListener('input', () => { st.name = nameInput.value; });
      // Click card body → solo preview. `.mp-check` label wraps the checkbox
      // and its .mp-swatch span; clicks inside the label (even on the span)
      // must NOT trigger solo, or unchecking flips solo and hides the preview.
      card.addEventListener('click', (e) => {
        if (label.contains(e.target) || e.target === nameInput) return;
        const wasSolo = st.soloed;
        for (const s of state) { s.soloed = false; s.card.classList.remove('soloed'); }
        st.soloed = !wasSolo;
        if (st.soloed) card.classList.add('soloed');
      });
      cardsEl.appendChild(card);
      st.card = card;
    }

    function updateSaveEnabled() {
      const any = state.some(s => s.selected);
      modal.querySelector('.mp-save').disabled = !any;
    }

    // ---------- draw loop ----------
    let raf = null, done = false;
    // preserve outer focus so it can be restored on close
    const prevActive = document.activeElement;
    function finish(pickedList) {
      if (done) return; done = true;
      if (raf) cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKey, true);
      video.pause();
      // release the video element's src/decoder BEFORE removal — object URL
      // gets revoked by the caller (main.js), but the media element itself
      // can keep the decoder alive across GC without this
      try { video.removeAttribute('src'); video.load(); } catch {}
      modal.classList.add('closing');
      setTimeout(() => {
        modal.remove();
        if (prevActive && prevActive.focus) { try { prevActive.focus(); } catch {} }
        resolve(pickedList);
      }, 220);
    }

    function onKey(e) {
      if (done) return;
      if (e.key === 'Escape') { e.preventDefault(); finish([]); }
      else if (e.key === 'Enter' && !(e.target && e.target.tagName === 'INPUT')) {
        // Enter outside the name input → Save if enabled
        if (state.some(s => s.selected)) {
          e.preventDefault();
          modal.querySelector('.mp-save').click();
        }
      }
    }
    document.addEventListener('keydown', onKey, true);

    function draw() {
      if (done) return;
      raf = requestAnimationFrame(draw);
      // Only reallocate the backing store when the CSS size actually changes;
      // writing canvas.width every frame resets context state and forces a
      // compositor flush on mobile.
      const wantW = canvas.clientWidth * 2, wantH = canvas.clientHeight * 2;
      if (canvas.width !== wantW) canvas.width = wantW;
      if (canvas.height !== wantH) canvas.height = wantH;
      const W = canvas.width, H = canvas.height;
      ctx.clearRect(0, 0, W, H);

      const dur = video.duration || 4;
      const t = video.currentTime;
      // trajectories may vary in length across regions if a future refactor
      // changes the shape; guard defensively
      const firstRegion = regions.find(r => r.trajectories && r.trajectories.length && r.trajectories[0]);
      if (!firstRegion) return;
      const T = firstRegion.trajectories[0].length;
      const frameF = Math.min(T - 1, (t / dur) * (T - 1));
      const anySoloed = state.some(s => s.soloed);

      ctx.lineCap = 'round';
      for (const st of state) {
        if (anySoloed && !st.soloed) continue;
        if (!anySoloed && !st.selected) continue;

        const color = st.region.color;
        const tracks = st.region.trajectories;
        if (!tracks || !tracks.length) continue;
        const localT = tracks[0].length;
        // clamp against this region's own T so shorter tracks don't index oob
        const f1 = Math.min(localT - 1, Math.floor(frameF));
        const f0 = Math.max(0, f1 - TRAIL);

        for (let i = 0; i < tracks.length; i++) {
          const track = tracks[i];
          // skip inactive cells (region_trajectories keeps them frozen at start,
          // so their energy is 0)
          const dx = track[f1][0] - track[f0][0];
          const dy = track[f1][1] - track[f0][1];
          const energy = Math.hypot(dx, dy);
          if (energy < 0.0015) continue;

          for (let f = f0; f < f1; f++) {
            const seg = (f - f0) / TRAIL;
            const t0 = track[f], t1 = track[f + 1];
            ctx.strokeStyle = color;
            ctx.globalAlpha = seg * Math.min(1, energy * 240);
            ctx.lineWidth = STROKE_MIN + seg * (STROKE_MAX - STROKE_MIN);
            ctx.beginPath();
            ctx.moveTo(t0[0] * W, t0[1] * H);
            ctx.lineTo(t1[0] * W, t1[1] * H);
            ctx.stroke();
          }
        }

        // bounding box + label
        const b = st.region.bbox;
        const x = b.x0 * W, y = b.y0 * H;
        const w = (b.x1 - b.x0) * W, h = (b.y1 - b.y0) * H;
        ctx.globalAlpha = 0.9;
        ctx.strokeStyle = color;
        ctx.setLineDash([6, 5]);
        ctx.lineWidth = 2;
        ctx.strokeRect(x, y, w, h);
        ctx.setLineDash([]);

        // label chip anchored to the box's top-left, kept inside the frame.
        // If there isn't room above the bbox, drop it inside on the top edge
        // (offset 4px down) so it doesn't overlap the dashed border.
        ctx.font = '600 22px system-ui, sans-serif';
        const label = st.name;
        const tw = ctx.measureText(label).width + 16;
        const th = 30;
        const lx = Math.min(W - tw - 4, Math.max(4, x));
        const preferredLy = y - th - 4;
        const ly = preferredLy >= 4 ? preferredLy : y + 4;
        ctx.globalAlpha = 0.92;
        ctx.fillStyle = 'rgba(10, 10, 18, 0.7)';
        roundRect(ctx, lx, ly, tw, th, 6);
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.fillStyle = '#fff';
        ctx.fillText(label, lx + 8, ly + 21);
      }
      ctx.globalAlpha = 1;
    }

    // ---------- wire buttons ----------
    modal.querySelector('.mp-close').onclick =
    modal.querySelector('.mp-cancel').onclick = () => finish([]);
    modal.querySelector('.mp-save').onclick = () => {
      const picked = state.filter(s => s.selected).map((s, i) => ({
        id: 'uploaded-' + Date.now() + '-' + s.idx,
        name: (s.name || '').trim() || (s.region.suggested_name || `Motion ${s.idx + 1}`),
        desc: `Region ${s.idx + 1}${meta.engine ? ' · ' + meta.engine : ''}`,
        color: s.region.color,
        params: s.region.params,
        fromUpload: true,
        engine: meta.engine || 'raft',
        trajectories: s.region.trajectories,
        trajFps: meta.fps,
        videoUrl,          // shared object URL; caller owns lifetime
        bbox: s.region.bbox,
      }));
      finish(picked);
    };

    // start playback + draw loop; focus the modal so keyboard nav starts inside
    video.addEventListener('loadeddata', () => {
      video.currentTime = 0;
      video.play().catch(() => {});
      raf = requestAnimationFrame(draw);
      const panel = modal.querySelector('.mp-panel');
      if (panel && panel.focus) { try { panel.focus(); } catch {} }
    });
    video.addEventListener('error', () => finish([]));
    // fallback: if video never loads, close in 6s (loose enough for slow blobs;
    // real network failure fires the error handler above)
    setTimeout(() => { if (!done && video.readyState < 2) finish([]); }, 6000);
  });
};

// Escape ", <, > AND & — the last one is critical: server-supplied
// suggested_names or user-typed values containing '&' were previously
// parsed as HTML entity starts and mangled in the input value.
function escapeAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

})();
