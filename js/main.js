/*
 * main.js — app controller.
 */

(() => {
'use strict';

const $ = id => document.getElementById(id);
const statusEl = $('status');
function status(msg, flash) {
  statusEl.textContent = msg;
  statusEl.classList.toggle('flash', !!flash);
  if (flash) setTimeout(() => statusEl.classList.remove('flash'), 2200);
}

const artContainer = $('artwork-container');
const overlay = $('selection-overlay');
// the ORIGINAL uploaded artwork (before wraps/motion), kept so the Preview popup can show
// the input beside the animated MotionLife result. { type:'svg'|'img', content } or null.
let originalArtwork = null;

// ---- overlay always matches the 800x500 viewBox basis ----
function syncOverlay() {
  const rect = artContainer.getBoundingClientRect();
  overlay.width = 800; overlay.height = 500;
  overlay.style.width = rect.width + 'px';
  overlay.style.height = rect.height + 'px';
}

// Size the artwork stage to the loaded image's OWN aspect ratio, scaled to fit inside the
// canvas area. The canvas then takes the image's shape and (with #artwork-container's
// overflow:hidden) shows nothing beyond it. Dims are stashed so a window resize re-fits.
function fitArtwork(w, h) {
  if (!(w > 0 && h > 0)) return;
  artContainer.dataset.artW = w; artContainer.dataset.artH = h;
  const wrap = artContainer.parentElement;               // #canvas-wrap
  const cs = getComputedStyle(wrap);
  const availW = wrap.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const availH = wrap.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  if (availW <= 0 || availH <= 0) return;
  const scale = Math.min(availW / w, availH / h);        // contain: whole image visible
  artContainer.style.aspectRatio = 'auto';
  artContainer.style.maxWidth = 'none';
  artContainer.style.maxHeight = 'none';
  artContainer.style.width = Math.round(w * scale) + 'px';
  artContainer.style.height = Math.round(h * scale) + 'px';
}
function refitArtwork() {
  const w = +artContainer.dataset.artW, h = +artContainer.dataset.artH;
  if (w && h) fitArtwork(w, h);
}
// clear inline sizing so the container falls back to its CSS default (8/5 stage)
function resetArtworkSize() {
  artContainer.style.width = artContainer.style.height = '';
  artContainer.style.aspectRatio = artContainer.style.maxWidth = artContainer.style.maxHeight = '';
  delete artContainer.dataset.artW; delete artContainer.dataset.artH;
}

// =========================================================================
//  Motion library
// =========================================================================
const library = new MotionLibrary();
const motionListEl = $('motion-list');

// ===========================================================================
//  Motion tiles: "Particle Swatch" — a Pantone-style chip of moving dots.
//  Presets: a 5x5 dot lattice driven by the REAL motion formula.
//  Captured motions: the dots replay 25 of the 144 real trajectories,
//  so the chip literally shows the recorded motion's spatial structure.
// ===========================================================================
const CHIP = 72, GRID_N = 5;
const chipTiles = [];   // [{canvas, ctx, motion, dots, tracks}]

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function buildChipState(m) {
  // character motion: the swatch IS the extracted stick figure (animated)
  if (m.pose && m.pose.joints && m.pose.frames && m.pose.frames.length) {
    // gait rides along so the chip's stick figure reads the same stride axis the scene does
    // (see LIMB_DEPTH_ROLES) — otherwise the chip and the artwork disagree about the legs.
    return { pose: { joints: m.pose.joints, fps: m.pose.fps || 15,
                     frames: m.pose.frames.filter(Boolean), gait: m.pose.gait || null } };
  }
  if (m.trajectories && m.trajectories.length >= 25) {
    // subsample the 12x12 grid to 5x5, store drift-removed relative tracks
    const G = Math.round(Math.sqrt(m.trajectories.length));   // 12
    const rel = m.trajectories.map(tr => {
      const x0 = tr[0][0], y0 = tr[0][1];
      return tr.map(p => [p[0] - x0, p[1] - y0]);
    });
    // Lay the 5x5 lattice over the cells that actually MOVED, not over the whole frame.
    // A field can be mostly frozen on purpose — the object mask (Step 2) pins background
    // cells, and segmented regions pin out-of-region cells — so a fixed frame-wide lattice
    // could sample 25 stationary cells and show a dead chip for a motion that is fine.
    // activeCellWindow is shared with buildTrajField (js/motionfields.js) so the chip and
    // the animation can never disagree about where the motion is.
    const [a0, a1, b0, b1] = activeCellWindow(rel, G);
    const idx = [];
    for (let gy = 0; gy < GRID_N; gy++)
      for (let gx = 0; gx < GRID_N; gx++)
        idx.push((b0 + Math.round(gy * (b1 - b0) / (GRID_N - 1))) * G
               + (a0 + Math.round(gx * (a1 - a0) / (GRID_N - 1))));
    return { tracks: idx.map(i => rel[i]) };
  }
  return { tracks: null };
}

// Clicking a motion preset only ever applies to whatever object is already
// active — motion is a property OF an object, never a global "armed" state
// that silently reattaches to the next thing you happen to select or create
// (that used to make one object's motion change whenever you picked a new
// preset while browsing, and made new selections inherit a stale motion).
function selectMotion(id) {
  const active = sel.getActive();
  if (!active) {
    status('Select an object first, or drag this preset onto one.', true);
    return;
  }
  library.select(id);
  const applied = applyMotionToActive();
  const m = library.getById(id);
  renderMotionList();
  status(applied ? `Applied "${m.name}" to "${applied}".`
                 : `Motion "${m.name}" selected — now click an object to apply it.`, true);
}

// The preset-chip ring always reflects the ACTIVE OBJECT's own motion, never
// a leftover "last thing you clicked" — so switching objects (or deselecting)
// must resync it every time, rather than leaving stale chip state on screen.
function syncArmedMotionToSelection() {
  const active = sel.getActive();
  library.select(active ? active.motionId : null);
  renderMotionList();
}

// (Step 7) One line per swatch, read from the UNIFIED Contract-B core — so a texture, a
// skeleton and a path describe themselves in exactly the same terms in the library instead
// of each backend inventing its own wording. Only the core is read here (kind, class,
// engine, frames, fps, confidence + what that confidence MEANS); the kind-specific payload
// is the applicator's business. Motions without swatches (presets, the in-browser
// Lucas–Kanade fallback) keep their own `desc` — an empty list is honest, not a gap to fill.
function swatchSummary(m) {
  const sws = Array.isArray(m.swatches) ? m.swatches : [];
  if (!sws.length) return m.desc || m.name;
  return sws.map(s =>
    `${s.kind} · ${s.class || 'unclassified'} · ${s.engine} · ${s.frames} frames @ ${s.fps}fps · `
    + `confidence ${Math.round(s.confidence * 100)}% (${s.confidence_of})`
    + (s.warnings && s.warnings.length ? `\n    ⚠ ${s.warnings.join('\n    ⚠ ')}` : '')
  ).join('\n');
}

function makeChip(m, container) {
  const tile = document.createElement('div');
  tile.className = 'motion-chip' + (library.selectedId === m.id ? ' active' : '');
  const canvas = document.createElement('canvas');
  canvas.width = CHIP * 2; canvas.height = CHIP * 2;   // retina
  const label = document.createElement('div');
  label.className = 'chip-name';
  label.textContent = m.name;
  tile.appendChild(canvas);
  tile.appendChild(label);
  tile.title = `${m.name}\n${swatchSummary(m)}`;
  tile.onclick = () => selectMotion(m.id);
  tile.draggable = true;
  tile.ondragstart = (e) => {
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('text/plain', m.id);
    startMotionDrag(m.id);
  };
  tile.ondragend = () => endMotionDrag();
  container.appendChild(tile);
  chipTiles.push({ canvas, ctx: canvas.getContext('2d'), motion: m, ...buildChipState(m) });
}

function renderMotionList() {
  chipTiles.length = 0;
  motionListEl.innerHTML = '';

  // Motion Presets: built-in motions only
  for (const m of library.getAll().filter(m => !m.fromUpload)) makeChip(m, motionListEl);

  // Extracted motions no longer get their own panel — they live in each video's
  // dropdown, built inside renderVideoList() (which also appends their swatch
  // chips to chipTiles, so it must run after the reset above).
  renderVideoList();
}

function chipLoop() {
  requestAnimationFrame(chipLoop);
  const t = performance.now() / 1000;
  for (const tile of chipTiles) {
    const { canvas, ctx, motion, tracks, pose } = tile;
    if (!canvas.isConnected) continue;
    const S = canvas.width;
    const [r, g, b] = hexToRgb(motion.color || '#7c6cff');

    // ---- character swatch: the extracted stick figure, looping ----
    if (pose && window.drawSkeletonFrame) {
      ctx.fillStyle = '#151515'; ctx.fillRect(0, 0, S, S);
      const n = pose.frames.length;
      const fi = Math.floor(t * pose.fps) % n;
      window.drawSkeletonFrame(ctx, pose.frames[fi], pose.joints, S, S,
        { pad: S * 0.17, color: motion.color || '#34d399', lineWidth: Math.max(2, S * 0.02), jointR: Math.max(2, S * 0.02) });
      continue;
    }

    // motion-blur fade instead of clear → dots drag trails
    ctx.fillStyle = 'rgba(24,24,24,0.28)';
    ctx.fillRect(0, 0, S, S);

    const cell = S / (GRID_N + 1);
    ctx.fillStyle = `rgba(${r},${g},${b},0.16)`;
    for (let gy = 0; gy < GRID_N; gy++)          // faint rest lattice
      for (let gx = 0; gx < GRID_N; gx++)
        ctx.fillRect((gx + 1) * cell - 1, (gy + 1) * cell - 1, 2, 2);

    ctx.fillStyle = `rgb(${r},${g},${b})`;
    for (let gy = 0; gy < GRID_N; gy++) {
      for (let gx = 0; gx < GRID_N; gx++) {
        const hx = (gx + 1) * cell, hy = (gy + 1) * cell;
        let px, py;
        if (tracks) {
          // captured: replay real trajectory (ping-pong loop, drift stays visible)
          const tr = tracks[gy * GRID_N + gx];
          const n = tr.length;
          const f = (t * 12) % (2 * n);
          const i = f < n ? Math.floor(f) : (2 * n - 1 - Math.floor(f));
          px = hx + tr[i][0] * S * 1.1;
          py = hy + tr[i][1] * S * 1.1;
        } else {
          // preset: the actual animator formula, per-dot spatial seed
          const seed = (gx * 17 + gy * 31) * 0.02;
          const d = computeMotion(motion.params, seed, t, 1);
          px = hx + d.dx * 0.75;
          py = hy + d.dy * 0.75;
        }
        ctx.beginPath();
        ctx.arc(px, py, 2.6, 0, 7);
        ctx.fill();
      }
    }
  }
}
chipLoop();

// =========================================================================
//  Selection manager
// =========================================================================
const sel = new SelectionManager(overlay, artContainer);

sel.onCreated = (s, idx) => { renderChips(); showInspector(s); syncArmedMotionToSelection(); refreshHighlightsSoon(); };
sel.onSelected = (s, idx) => { renderChips(); if (s) showInspector(s); else hideInspector(); syncArmedMotionToSelection(); };

function applyMotionToActive(targetSel) {
  const s = targetSel || sel.getActive();
  const m = library.getSelected();
  if (s && m) {
    s.motionId = m.id;
    const modeEl = s.kind === 'svg' && s.wrap
      ? s.wrap.querySelector('[data-motion-mode]')
      : null;
    const motionMode = modeEl ? modeEl.getAttribute('data-motion-mode') : 'auto';
    // captured motions carry a real trajectory field — geometry deformation
    // unless the artwork marks the selected object as structurally rigid.
    // (Step 10) waveModeFrom records WHICH evidence decided the deform mode, so a
    // layer-name regex is never presented as if the artwork had been looked at.
    // See CLOTH_NAME_HINT in js/regions.js for the full precedence.
    if (motionMode === 'rigid') {
      s.waveMode = false;
      s.waveModeFrom = 'artwork_rigid';
    } else if (s.kind === 'svg' && m.trajectories && m.trajectories.length && !(m.params && m.params.leafFall)) {
      s.waveMode = true;
      s.waveModeFrom = 'motion_field';
    }
    if (m.params && m.params.leafFall) { s.waveMode = false; s.waveModeFrom = 'preset_leaffall'; }
    // switching motions invalidates deformation caches
    if (s.wrap) {
      for (const el of s.wrap.querySelectorAll('path[data-ms-d0]')) el.setAttribute('d', el.getAttribute('data-ms-d0'));
    }
    if (s._leaves) { for (const lf of s._leaves) { lf.el.removeAttribute('transform'); lf.el.style.opacity = ''; } s._leaves = null; }
    s._wave = null; s._field = undefined; s._fieldMotion = null; s._text = undefined;
    s._char = null; s._charMotion = null;
    // Step 8 applicators cache per-motion state (mesh lattice, per-member flock room)
    s._mesh = null; s._meshMotion = null; s._meshAnchor = null;
    s._flock = null; s._flockMotion = null;
    showInspector(s);
    if (sel.mode === 'svg') sel._renderSVGHighlights(); else sel.redraw();
    // Applying a motion always starts playback — no manual play needed.
    if (!animator.playing) animator.play();
    if (typeof syncPlayButton === 'function') syncPlayButton();
    return s.name;
  }
  return null;
}

// =========================================================================
//  Drag a motion preset onto an object: live-preview while hovering, revert
//  the moment the cursor leaves it, commit for real only on drop.
// =========================================================================
let dragMotionId = null;   // the preset id currently being dragged, or null
let previewWrap = null;    // the .ms-wrap currently showing the live preview
let previewRaf = null;
const previewT0 = () => performance.now() / 1000;
let previewStart = 0;

function startMotionDrag(motionId) {
  dragMotionId = motionId;
}

function previewMotionOn(wrap, motionId) {
  stopPreview();
  const motion = library.getById(motionId);
  if (!wrap || !motion || !motion.params) return;
  previewWrap = wrap;
  animator.previewWrap = wrap;   // tell the real animator to leave this wrap alone
  previewStart = previewT0();
  const bb = wrap.getBBox();
  const cx = bb.x + bb.width / 2, cy = bb.y + bb.height / 2;
  const seed = (cx * 0.01 + cy * 0.03) % 1;
  const tick = () => {
    if (previewWrap !== wrap) return;   // superseded or stopped
    const t = (previewT0() - previewStart);
    const { dx, dy, rot } = computeMotion(motion.params, seed, t, 1);
    wrap.setAttribute('transform', `translate(${dx.toFixed(2)} ${dy.toFixed(2)}) rotate(${rot.toFixed(3)} ${cx.toFixed(1)} ${cy.toFixed(1)})`);
    previewRaf = requestAnimationFrame(tick);
  };
  tick();
}

function stopPreview() {
  if (previewRaf) cancelAnimationFrame(previewRaf);
  previewRaf = null;
  if (previewWrap) previewWrap.setAttribute('transform', '');
  previewWrap = null;
  animator.previewWrap = null;
}

function endMotionDrag() {
  stopPreview();
  dragMotionId = null;
}

sel.onHoverChange = (wrap) => {
  if (!dragMotionId) return;   // only preview during an active preset drag
  if (wrap === previewWrap) return;
  if (!wrap) { stopPreview(); return; }
  previewMotionOn(wrap, dragMotionId);
};

sel.onDropOnWrap = (wrap) => {
  if (!dragMotionId || !wrap) { endMotionDrag(); return; }
  const motionId = dragMotionId;
  stopPreview();
  dragMotionId = null;
  const existingIdx = sel.selections.findIndex(s => s.wrap === wrap);
  if (existingIdx >= 0) sel.selectByIndex(existingIdx);
  else sel._createSVGSelection(wrap);
  library.select(motionId);
  applyMotionToActive();
  syncArmedMotionToSelection();
  const m = library.getById(motionId);
  status(`Applied "${m.name}" to "${wrap.getAttribute('data-ms-name') || 'object'}".`, true);
};

// =========================================================================
//  Artwork loading + scene tabs (Poster / Scenery)
// =========================================================================
let currentScene = 'poster';

// file-based scenes: fetched from disk and loaded through the same SVG path as
// an uploaded artwork (so the .layer[data-name] contract makes objects selectable)
const FILE_SCENES = {
  // `train` has no scene tab (it was removed from the UI); the entry stays so
  // loadScene('train') still works from the console. The file moved to
  // assets/Artwork/ and this path had been left pointing at the old location,
  // where it 404'd into "Could not load that scene."
  train: 'assets/Artwork/train-window-adobe.svg',
  character: 'assets/scenes/character-bear.svg',
  // Scene3 with the girl limb-rigged (tools/rig-figure.py). Like `train` this has no scene
  // tab — reach it with loadScene('girl') from the console, or just upload the file. Without
  // the rig a pose swatch cannot articulate her: she has no data-limb, so the animator falls
  // through every pose gate to the generic texture path and the whole figure wobbles ~4px in
  // place instead of walking.
  girl: 'assets/scenes/girl-scene3.svg',
  // The station platform, with the suitcase and the hat limb-rigged — two independent
  // figures in one artwork, so each takes its own motion swatch. Same reason as `girl`:
  // without data-limb a pose swatch cannot articulate them and the whole figure wobbles
  // in place. Pivots were measured off the path geometry, not eyeballed (see the file).
  station: 'assets/scenes/scene2-station.svg',
  // The SAME station artwork exactly as the artist saved it: named layers ("Left Hand",
  // "Right Leg", …) and NOT ONE data-limb or data-pivot in the file. It is here as the
  // fixture for js/autorig.js — load it and the rig has to appear from the names alone.
  // Keeping both copies is the point: `station` proves hand-authored tags still win,
  // `stationLabels` proves nothing has to be hand-authored. Driven by
  // assets/videos/dance-arms-overhead.mp4 the two agree to within 0.1deg on all four
  // limbs (113.4 / 91.9 / 18.0 / 19.4), at the same 3.90s = n/fps period.
  stationLabels: 'assets/scenes/scene2-labels-only.svg',
};

async function loadScene(name) {
  currentScene = name;
  animator.pause();
  syncPlayButton();

  for (const b of document.querySelectorAll('.scene-tab'))
    b.classList.toggle('active', b.dataset.scene === name);

  if (FILE_SCENES[name]) {
    status('Loading scene…');
    try {
      const text = await fetch(FILE_SCENES[name]).then(r => r.text());
      loadUploadedSVG(text);
    } catch (e) {
      status('Could not load that scene.');
    }
    return;
  }

  artContainer.innerHTML = '';
  const svg = name === 'poster' ? createPosterSVG() : createScenerySVG();
  artContainer.appendChild(svg);
  resetArtworkSize();
  syncOverlay();
  sel.attachSVG(svg);
  setModeUI('svg');
  renderChips(); hideInspector(); showLayers();

  status(name === 'poster' ? 'Poster loaded — click the flag or the title, then pick a motion.'
       : 'Scenery loaded — click any object, then pick a motion.');
}

for (const b of document.querySelectorAll('.scene-tab'))
  b.onclick = () => loadScene(b.dataset.scene);

function loadDefaultScenery() { loadScene('scenery'); }

// A blank canvas — no default artwork. Upload art to begin.
function loadBlank() {
  currentScene = null;
  animator.pause();
  syncPlayButton();

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 800 500');
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  svg.style.width = '100%';
  svg.style.height = '100%';
  svg.innerHTML = `<rect id="ml-canvas-bg" width="800" height="500" fill="#ffffff"/>`;

  artContainer.innerHTML = '';
  artContainer.appendChild(svg);
  resetArtworkSize();
  syncOverlay();
  sel.attachSVG(svg);
  setModeUI('svg');
  renderChips(); hideInspector(); showLayers();

  status('Blank canvas — upload artwork to begin.');
}

function loadUploadedSVG(text) {
  originalArtwork = { type: 'svg', content: text };
  artContainer.innerHTML = text;
  const svg = artContainer.querySelector('svg');
  if (!svg) { status('That SVG could not be parsed.'); return; }
  svg.style.width = '100%'; svg.style.height = '100%';
  if (!svg.getAttribute('viewBox')) {
    const w = svg.getAttribute('width') || 800, h = svg.getAttribute('height') || 500;
    svg.setAttribute('viewBox', `0 0 ${parseFloat(w)} ${parseFloat(h)}`);
  }
  const vb = svg.viewBox && svg.viewBox.baseVal;
  fitArtwork(vb && vb.width ? vb.width : 800, vb && vb.height ? vb.height : 500);
  /* Read the artist's OWN layer names into a limb rig, before regions.js attaches — its rig
     detection gates on [data-limb], so a rig tagged after attach is invisible to it and the
     figure gets drilled into limb-by-limb with no torso to hinge against.
     This is why naming a layer "Left Hand" is now enough: previously those names were read by
     nothing, the scene loaded unrigged, and a pose swatch could only be handed to a
     whole-figure applicator that moves the entire drawing as one block. */
  let rig = null;
  try { rig = window.autoRigFromLayerNames && window.autoRigFromLayerNames(svg); } catch (_) {}

  syncOverlay();
  sel.attachSVG(svg);
  setModeUI('svg');
  renderChips(); hideInspector(); showLayers();
  const n = svg.querySelectorAll('.ms-wrap').length;
  const rigNote = rig && rig.tagged.length
    ? ` Rigged ${rig.tagged.length} limb(s) on ${rig.figures} figure(s) from your layer names `
      + `(${[...new Set(rig.tagged.map(t => t.role))].sort().join(', ')}).`
    : '';
  status(`SVG loaded — ${n} selectable element(s). Click one to select, then pick a motion.`
         + rigNote, true);
}

function loadRasterImage(dataUrl) {
  originalArtwork = { type: 'img', content: dataUrl };
  artContainer.innerHTML = `<img src="${dataUrl}" draggable="false">`;
  const img = artContainer.querySelector('img');
  if (img) {
    const applyFit = () => { fitArtwork(img.naturalWidth, img.naturalHeight); syncOverlay(); };
    if (img.complete && img.naturalWidth) applyFit(); else img.onload = applyFit;
  }
  syncOverlay();
  sel.attachRaster();
  setModeUI('raster');
  renderChips(); hideInspector(); showLayers();
  status('Image loaded. Draw a rectangle around an object, name it, then pick a motion.', true);
}

function setModeUI(mode) {
  $('tool-controls').style.display = mode === 'raster' ? 'flex' : 'none';
  $('mode-hint').textContent = mode === 'svg'
    ? 'SVG mode — click objects to select'
    : 'Image mode — draw rectangles to select';
}

// =========================================================================
//  Region chips
// =========================================================================
function renderChips() {
  const el = $('region-chips');
  el.innerHTML = '';
  sel.selections.forEach((s, i) => {
    const chip = document.createElement('span');
    chip.className = 'region-chip' + (i === sel.activeIdx ? ' active' : '');
    chip.innerHTML = `<span class="dot" style="background:${s.color}"></span>${s.name}${s.motionId ? ' ✓' : ''}`;
    chip.onclick = () => sel.selectByIndex(i);
    el.appendChild(chip);
  });
}

// =========================================================================
//  Inspector
// =========================================================================
function showInspector(s) {
  $('inspector-section').hidden = false;
  $('inspector-content').hidden = false;
  $('insp-name').value = s.name;
  $('insp-speed').value = s.speed; $('insp-speed-val').textContent = s.speed.toFixed(1) + 'x';
  $('insp-intensity').value = s.intensity; $('insp-intensity-val').textContent = Math.round(s.intensity * 100) + '%';
  const badge = $('insp-motion-name');
  if (s.motionId) {
    const m = library.getById(s.motionId);
    badge.textContent = m ? m.name : 'Unknown';
    badge.classList.add('assigned');
  } else { badge.textContent = 'None — select a motion'; badge.classList.remove('assigned'); }
  // Speed / Intensity / Remove motion / Delete region only make sense once a motion is
  // applied — hide them until then, so an object with no motion just shows its name and
  // the "select a motion" prompt.
  const hasMotion = !!s.motionId;
  $('insp-speed').closest('.insp-row').hidden = !hasMotion;
  $('insp-intensity').closest('.insp-row').hidden = !hasMotion;
  $('btn-remove-motion').closest('.insp-actions').hidden = !hasMotion;
  showRetarget(s);
  showRoute(s);
  markLayerActive(s.wrap);
  showJudge(s);
}

/* Limb-retarget mode control — shown only for artwork with data-limb rig parts, and only
   when builder copy is on (?diag=1). It is a tuning control with a technical explanation
   attached, so it stays out of a viewer's way; hiding the row does NOT change behaviour,
   because the mode falls back to s.limbRetarget / data-retarget / LIMB_RETARGET_DEFAULT
   exactly as before whether or not the select is on screen. */
function showRetarget(s) {
  const row = $('insp-retarget-row');
  const limbs = s.wrap.querySelectorAll('[data-limb]').length;
  const diag = !!(window.__msShowDiag && window.__msShowDiag());
  row.hidden = !limbs || !diag;
  if (!limbs || !diag) return;
  $('insp-retarget').value = s.limbRetarget || s.wrap.dataset.retarget || LIMB_RETARGET_DEFAULT;
  let cost = '';
  const offs = s._limb && s._limb.offsets;
  if (offs && offs.length) {
    const worst = offs.reduce((a, b) => Math.abs(b.deg) > Math.abs(a.deg) ? b : a);
    cost = ' · whole figure would turn ' + worst.role + ' by '
      + (worst.deg > 0 ? '+' : '') + worst.deg.toFixed(0) + '°'
      + (Math.abs(worst.deg) >= 60 ? ', which will pull that limb off its joint' : '');
  }
  $('insp-retarget-hint').textContent = limbs + (limbs === 1 ? ' rigged limb' : ' rigged limbs')
    + ' · matching the capture moves the drawn stance; keeping it as drawn preserves the pose'
    + ' but also preserves any splay the motion is too small to close.' + cost;
}

/* Travel-route controls — a route is AUTHORED (hand-drawn), not measured motion. */
function showRoute(s) {
  const val = $('insp-route-val'), row = $('insp-route-dur-row');
  const drawing = sel.routing && sel.routing.sel === s;
  if (drawing) {
    val.textContent = `drawing — ${sel.routing.pts.length} pts, double-click to finish`;
  } else if (s.route) {
    val.textContent = `authored, ${s.route.pts.length} pts`;
  } else {
    val.textContent = 'none';
  }
  row.hidden = !s.route;
  if (s.route) {
    $('insp-route-dur').value = s.route.duration;
    $('insp-route-dur-val').textContent = s.route.duration.toFixed(1) + 's';
  }
  $('btn-draw-route').textContent = drawing ? 'Finish route' : (s.route ? 'Redraw route' : 'Draw route');
  $('btn-clear-route').disabled = !s.route;

  const loopBtn = $('btn-loop-route'), hint = $('insp-route-hint');
  const looping = !!(s.route && s.route.loop);
  loopBtn.disabled = !s.route;
  loopBtn.textContent = looping ? 'Looping' : 'Loop travel';
  loopBtn.classList.toggle('on', looping);
  /* Say whether the loop is seamless instead of leaving the user to wonder why it jumps.
     An open route has to cut back to its first point at the end of every lap — that is not
     a bug to hide, it is what looping a path that finishes elsewhere means. */
  if (looping) {
    const gap = routeSeamGap(s.route);
    hint.textContent = gap <= 2
      ? 'Seamless loop — the route ends where it starts.'
      : `Each lap cuts back ${Math.round(gap)} units to the first point. `
        + 'Draw the route back to where it started for a seamless loop.';
    hint.hidden = false;
  } else {
    hint.hidden = true;
    hint.textContent = '';
  }
}

/* How far a route's last point is from its first, in viewBox units — i.e. how big the jump
   is when it wraps. Zero on a closed route. */
function routeSeamGap(route) {
  const p = route.pts;
  if (!p || p.length < 2) return 0;
  const a = p[0], b = p[p.length - 1];
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}
function hideInspector() { $('inspector-section').hidden = true; $('inspector-content').hidden = true; markLayerActive(null); showJudge(null); }

// Layers panel appears once artwork is present (poster / scenery / upload)
// and lists the artwork's groups/layers as a collapsible tree.
const layerRowByWrap = new Map();   // ms-wrap element -> its layer row

// (Step 10) the last /label pass over the loaded artwork, or null. Declared here rather
// than beside its button so showLayers() — which runs at boot — can clear it without
// depending on declaration order.
let layerLabelling = null;

function showLayers() {
  const section = $('layers-section');
  if (!section) return;
  // (Step 10) new artwork invalidates every label — they were about the OLD picture, and
  // a stale label would auto-apply a swatch to whatever now sits in that layer slot.
  layerLabelling = null;
  window.__mlLayerLabels = null;
  const out = $('autolabel-out'); if (out) out.innerHTML = '';
  const svg = artContainer.querySelector('svg');
  if (!svg) { section.hidden = true; return; }   // raster: no groups to show
  section.hidden = false;
  renderLayers(svg);
}

// Illustrator encodes non-alphanumerics as _xHH_ (e.g. _x3C_leaf_x3E_ -> <leaf>)
function decodeLayerName(s) {
  return (s || '').replace(/_x([0-9A-Fa-f]{2,6})_/g, (m, h) => {
    try { return String.fromCodePoint(parseInt(h, 16)); } catch (e) { return m; }
  });
}

const EYE_ICON = '<svg viewBox="0 0 16 16" width="13" height="13"><path fill="currentColor" d="M8 3.5C4.4 3.5 1.7 6 1 8c.7 2 3.4 4.5 7 4.5s6.3-2.5 7-4.5c-.7-2-3.4-4.5-7-4.5zm0 7.3A2.8 2.8 0 118 5.2a2.8 2.8 0 010 5.6zm0-1.4a1.4 1.4 0 100-2.8 1.4 1.4 0 000 2.8z"/></svg>';

// groups to show, treating the app's internal .ms-wrap as transparent
function layerGroups(parent) {
  if (parent.getAttribute && parent.getAttribute('data-layer-panel') === 'flat') return [];
  const out = [];
  for (const c of parent.children) {
    if (c.tagName.toLowerCase() !== 'g') continue;
    if (c.classList.contains('ms-wrap')) out.push(...layerGroups(c));
    else out.push(c);
  }
  return out;
}

function buildLayerNode(el, depth) {
  const node = document.createElement('div');
  node.className = 'layer-node';
  const row = document.createElement('div');
  row.className = 'layer-row';
  row.style.paddingLeft = (6 + depth * 14) + 'px';

  const kids = layerGroups(el);
  const caret = document.createElement('span');
  caret.className = 'layer-caret';
  caret.textContent = kids.length ? '▸' : '';   // groups start collapsed

  const eye = document.createElement('span');
  eye.className = 'layer-eye';
  eye.innerHTML = EYE_ICON;

  const label = document.createElement('span');
  label.className = 'layer-name';
  label.textContent = decodeLayerName(el.getAttribute('data-name') || el.id) || '<Group>';

  row.append(caret, eye, label);
  // (Step 10) what the VLM said this layer IS, beside what the file called it. Both are
  // shown: the point of the feature is that they often disagree, and hiding the file's
  // name would make an auto-apply impossible to sanity-check.
  const lab = layerLabelling && layerLabelling.byEl.get(el);
  if (lab) {
    const badge = document.createElement('span');
    badge.className = 'layer-class' + (lab.motion_class ? '' : ' static');
    badge.textContent = lab.motion_class ? `${lab.label} · ${lab.motion_class}` : `${lab.label} · static`;
    badge.title = `VLM: ${lab.label} — ${lab.motion_class || 'should not move'} `
                + `(${Math.round(lab.confidence * 100)}%, ${lab.deforms})`
                + (lab.notes ? `\n${lab.notes}` : '');
    row.appendChild(badge);
  }
  node.appendChild(row);

  const wrap = el.closest('.ms-wrap');
  if (wrap && el.parentElement === wrap) layerRowByWrap.set(wrap, row);

  let childBox = null;
  if (kids.length) {
    childBox = document.createElement('div');
    childBox.className = 'layer-children';
    childBox.style.display = 'none';   // collapsed by default; caret expands it
    for (const g of kids) childBox.appendChild(buildLayerNode(g, depth + 1));
    node.appendChild(childBox);
    caret.onclick = (e) => {
      e.stopPropagation();
      const open = childBox.style.display !== 'none';
      childBox.style.display = open ? 'none' : '';
      caret.textContent = open ? '▸' : '▾';
    };
  }

  eye.onclick = (e) => {
    e.stopPropagation();
    const hidden = el.style.display === 'none';
    el.style.display = hidden ? '' : 'none';
    eye.classList.toggle('off', !hidden);
  };

  if (wrap) {
    row.onclick = () => {
      const t = wrap.querySelector('path,rect,polygon,text,circle,ellipse') || wrap;
      t.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    };
  } else if (el.tagName && el.tagName.toLowerCase() === 'g'
             && (el.getAttribute('data-name') || el.id) && sel._isDrawable(el)) {
    /* A NAMED container group (e.g. "Bird-1") whose leaf parts got wrapped individually.
       The auto-wrapper skipped it (it prefers leaf-named parts, right for Illustrator
       "Layer_1 > objects" but wrong when the container IS the object). Let the panel pick
       the whole group as one region so you can apply a flock / wings motion to the bird. */
    row.classList.add('group-selectable');
    row.title = 'Select this whole group as one region';
    row.onclick = () => { sel.selectGroup(el); };
  } else {
    /* Truly not selectable (an unnamed <Group> with no drawable identity) — say so instead
       of swallowing the click in silence. */
    row.classList.add('inert');
    row.title = 'Not a selectable object: this group has no name and no rig, so the app '
              + 'wrapped its children instead. Click one of those.';
  }
  return node;
}

function renderLayers(svg) {
  const list = $('layers-list');
  if (!list) return;
  layerRowByWrap.clear();
  list.innerHTML = '';
  const roots = layerGroups(svg);
  if (!roots.length) { list.innerHTML = '<div class="layers-empty">No groups in this artwork.</div>'; return; }
  for (const g of roots) list.appendChild(buildLayerNode(g, 0));
}

function markLayerActive(wrap) {
  for (const r of layerRowByWrap.values()) r.classList.remove('active');
  const row = wrap && layerRowByWrap.get(wrap);
  if (row) row.classList.add('active');
}

$('insp-name').addEventListener('change', () => { const s = sel.getActive(); if (s) { s.name = $('insp-name').value; renderChips(); if (sel.mode === 'svg') sel._renderSVGHighlights(); else sel.redraw(); } });
$('insp-speed').addEventListener('input', () => { const s = sel.getActive(); if (s) { s.speed = parseFloat($('insp-speed').value); $('insp-speed-val').textContent = s.speed.toFixed(1) + 'x'; } });
$('insp-intensity').addEventListener('input', () => { const s = sel.getActive(); if (s) { s.intensity = parseFloat($('insp-intensity').value); $('insp-intensity-val').textContent = Math.round(s.intensity * 100) + '%'; } });

// ---- limb retarget mode ----
$('insp-retarget').addEventListener('change', () => {
  const s = sel.getActive();
  if (!s) return;
  s.limbRetarget = $('insp-retarget').value;   // _applyLimbs rebuilds its rig on the next frame
});

// ---- travel route (authored) ----
$('btn-draw-route').addEventListener('click', () => {
  const s = sel.getActive();
  if (!s) return;
  if (sel.routing) {
    const ok = sel.endRoute(true);
    status(ok ? `Route saved on "${s.name}" — it's traveling now.`
              : 'Route needs at least one destination point.', ok);
  } else if (sel.beginRoute()) {
    status(`Click across the canvas to lay out where "${s.name}" travels. ` +
           'Double-click to finish, Esc to cancel.');
  }
  showRoute(s);
});
/* Loop the authored travel, and start it over from the first point right now.
   Re-arming matters: without it a route already parked at its destination would sit there
   for a whole duration before the first lap came round, so the click would look ignored.
   Bumping `rev` is the existing re-arm mechanism (_applyRoute resets _routeT0 when the rev
   it recorded no longer matches), and rev is only ever compared for inequality, so counting
   up is safe and — unlike Date.now() — cannot collide with two clicks in the same ms. */
$('btn-loop-route').addEventListener('click', () => {
  const s = sel.getActive();
  if (!s || !s.route) return;
  s.route.loop = !s.route.loop;
  s.route.rev = (s.route.rev || 0) + 1;
  s._routeTbl = null;
  if (!animator.playing) animator.play();
  syncPlayButton();
  status(s.route.loop
    ? `"${s.name}" is travelling its route on a loop (${s.route.duration.toFixed(1)}s a lap).`
    : `"${s.name}" travels its route once, then holds at the end.`);
  showRoute(s);
});
$('btn-clear-route').addEventListener('click', () => {
  const s = sel.getActive();
  if (!s) return;
  sel.clearRoute(s);
  status(`Travel route removed from "${s.name}".`);
  showRoute(s);
});
$('insp-route-dur').addEventListener('input', () => {
  const s = sel.getActive();
  if (!s || !s.route) return;
  s.route.duration = parseFloat($('insp-route-dur').value);
  $('insp-route-dur-val').textContent = s.route.duration.toFixed(1) + 's';
});
// Esc abandons a route in progress; the previously saved one (if any) is left alone
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !sel.routing) return;
  const s = sel.routing.sel;
  sel.endRoute(false);
  status('Route cancelled.');
  showRoute(s);
});
sel.onRouteChange = () => { const s = sel.getActive(); if (s) showRoute(s); };
// a committed travel route is enough to animate on its own — start playback so the
// object travels immediately, even with no preset motion applied.
sel.onRouteCommitted = () => {
  if (!animator.playing) animator.play();
  if (typeof syncPlayButton === 'function') syncPlayButton();
};

$('btn-remove-motion').onclick = () => {
  const s = sel.getActive();
  if (!s) return;
  s.motionId = null;
  animator._resetOne(s);   // undo whichever special-case animator was driving it, fully
  showInspector(s);
  renderChips();
  if (sel.mode === 'svg') sel._renderSVGHighlights(); else sel.redraw();
  syncArmedMotionToSelection();
  status('Motion removed.');
};
$('btn-delete-region').onclick = () => { sel.deleteActive(); renderChips(); const a = sel.getActive(); if (a) showInspector(a); else hideInspector(); syncArmedMotionToSelection(); status('Region deleted.'); };

// =========================================================================
//  Tools
// =========================================================================
$('btn-tool-rect').onclick = () => { sel.setTool('rect'); $('btn-tool-rect').classList.add('active'); };

// Individual selection: off by default. When on, clicking an already-selected group
// again explodes it into one selection per child (each green) — see SelectionManager.
const chkIndividual = $('chk-individual');
if (chkIndividual) chkIndividual.onchange = () => sel.setIndividualMode(chkIndividual.checked);

// =========================================================================
//  Animator + play
// =========================================================================
const animator = new Animator(sel, library);

// Header Play/Pause button. The app also auto-plays whenever a motion is
// applied (see applyMotionToActive); this button is a manual global toggle and
// a live indicator of play state. syncPlayButton() keeps its label in sync with
// whatever the animator is doing, however playback was started.
function syncPlayButton() {
  const btn = $('btn-play');
  if (!btn) return;
  btn.textContent = animator.playing ? '⏸ Pause' : '▶ Play';
  btn.classList.toggle('playing', animator.playing);
}
if ($('btn-play')) {
  $('btn-play').onclick = () => {
    if (!animator.playing && !sel.selections.some(s => s.motionId)) {
      status('Assign a motion to at least one object first.');
      return;
    }
    const playing = animator.toggle();
    sel.setHighlightsHidden(playing);   // outlines only in pause state
    syncPlayButton();
    status(playing ? 'Playing.' : 'Paused.');
  };
}

// =========================================================================
//  Download menu — pick a format (Animated SVG or MP4 video)
// =========================================================================
async function downloadAsVideo() {
  if (!sel.selections.some(s => s.motionId)) {
    status('Nothing is animated yet.'); return;
  }
  const btn = $('btn-download');
  btn.disabled = true;
  const wasPlaying = animator.playing;
  if (!wasPlaying) animator.play();
  try {
    const blob = await exportVideo(sel, animator, {
      seconds: 8, mode: 'flat',
      onProgress: p => { btn.textContent = p < 1 ? `Recording… ${Math.round(p * 100)}%` : 'Download ▾'; },
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'motionlife.' + (blob.type.includes('mp4') ? 'mp4' : 'webm');
    a.click(); URL.revokeObjectURL(a.href);
    status('Video exported — 1600×1000, matches the artwork size.', true);
  } catch (err) {
    status('Video export failed: ' + err.message);
  }
  if (!wasPlaying) animator.pause();
  btn.textContent = 'Download ▾';
  btn.disabled = false;
}

function downloadAsSvg() {
  if (sel.mode !== 'svg') { status('Animated SVG works with SVG artwork (the raster path has no vector scene to bake).'); return; }
  if (!sel.selections.some(s => s.motionId)) { status('Assign a motion to at least one object first.'); return; }
  const svgText = buildExportSVG(sel, library);
  if (!svgText) { status('Nothing to export.'); return; }
  const blob = new Blob([svgText], { type: 'image/svg+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'motionlife-poster.svg';
  a.click(); URL.revokeObjectURL(a.href);
  status('Exported! Drop the .svg into any website — <img src="motionlife-poster.svg"> — it animates by itself.', true);
}

(function initDownloadMenu() {
  const btn = $('btn-download');
  const menu = $('download-menu');
  const dropdown = $('download-dropdown');
  if (!btn || !menu || !dropdown) return;

  const close = () => { dropdown.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  const open  = () => { dropdown.hidden = false; btn.setAttribute('aria-expanded', 'true'); };

  btn.onclick = (e) => {
    e.stopPropagation();
    dropdown.hidden ? open() : close();
  };
  dropdown.querySelectorAll('.download-option').forEach(opt => {
    opt.onclick = () => {
      close();
      if (opt.dataset.format === 'svg') downloadAsSvg();
      else downloadAsVideo();
    };
  });
  // click-away and Escape both dismiss the menu
  document.addEventListener('click', (e) => { if (!menu.contains(e.target)) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
})();

function refreshHighlightsSoon() { if (sel.mode === 'svg') requestAnimationFrame(() => sel._renderSVGHighlights()); }

// =========================================================================
//  Upload motion video
// =========================================================================
const capture = new MotionCapture();
$('btn-upload-motion').onclick = () => $('motion-input').click();

// ---- Videos section: one horizontal row per uploaded clip -------------------
// Each row carries the clip and, in a collapsible dropdown, the motion swatch(es)
// extracted from it (a clip can yield several). Three actions: reveal the motions,
// preview (wired later), and delete (drops the clip AND its extracted motions).
const uploadedVideos = [];
const VR_ICON = {
  chevron: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
  eye: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>',
  trash: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6M14 11v6"/></svg>',
};
function addVideoThumb(url, name) {
  const rec = { url, name, motionIds: [] };
  uploadedVideos.push(rec);
  renderMotionList();   // full rebuild keeps chipTiles (preset + swatch) consistent
  return rec;
}
function renderVideoList() {
  const el = $('video-list');
  el.innerHTML = '';
  $('videos-section').classList.toggle('has-videos', uploadedVideos.length > 0);
  uploadedVideos.forEach(v => {
    const row = document.createElement('div');
    row.className = 'video-row';

    // ---- top bar: big preview (video + name below) on the left, stacked actions on the right ----
    const main = document.createElement('div');
    main.className = 'video-row-main';

    const preview = document.createElement('div');
    preview.className = 'video-preview';

    const vid = document.createElement('video');
    vid.className = 'video-thumb';
    vid.src = v.url; vid.muted = true; vid.loop = true; vid.autoplay = true;
    vid.playsInline = true; vid.setAttribute('playsinline', '');
    preview.appendChild(vid);

    const meta = document.createElement('div');
    meta.className = 'video-meta';
    const nm = document.createElement('div');
    nm.className = 'video-name'; nm.textContent = v.name; nm.title = v.name;
    const motions = (v.motionIds || []).map(id => library.getById(id)).filter(Boolean);
    const sub = document.createElement('div');
    sub.className = 'video-sub';
    sub.textContent = motions.length
      ? `${motions.length} motion${motions.length > 1 ? 's' : ''}` : 'extracting…';
    meta.append(nm, sub);
    preview.appendChild(meta);
    main.appendChild(preview);

    const actions = document.createElement('div');
    actions.className = 'video-actions';
    const btnDrop = document.createElement('button');
    btnDrop.className = 'vr-btn'; btnDrop.title = 'Show extracted motions';
    btnDrop.innerHTML = VR_ICON.chevron;
    const btnPrev = document.createElement('button');
    btnPrev.className = 'vr-btn'; btnPrev.title = 'Preview';
    btnPrev.innerHTML = VR_ICON.eye;
    const btnDel = document.createElement('button');
    btnDel.className = 'vr-btn danger'; btnDel.title = 'Delete video and its motions';
    btnDel.innerHTML = VR_ICON.trash;
    actions.append(btnDrop, btnPrev, btnDel);
    main.appendChild(actions);
    row.appendChild(main);

    // ---- dropdown body: the extracted motion swatches, hidden until opened ----
    const drawer = document.createElement('div');
    drawer.className = 'video-motions chip-grid';
    drawer.hidden = true;
    if (motions.length) motions.forEach(m => makeChip(m, drawer));
    else {
      const none = document.createElement('div');
      none.className = 'video-motions-empty';
      none.textContent = 'No motion extracted yet.';
      drawer.appendChild(none);
    }

    btnDrop.onclick = () => {
      const open = drawer.hidden;
      drawer.hidden = !open;
      btnDrop.classList.toggle('open', open);
    };
    btnPrev.onclick = () => {
      const ms = (v.motionIds || []).map(id => library.getById(id)).filter(Boolean);
      if (!ms.length) { status('No extracted motion to preview yet.'); return; }
      if (window.previewExtraction) {
        window.previewExtraction(v.url, ms.map(m => ({
          trajectories: m.trajectories, color: m.color,
          name: m.name, engine: m.engine, bbox: m.bbox,
        })));
      }
    };
    btnDel.onclick = () => deleteVideo(v);

    row.appendChild(drawer);
    el.appendChild(row);
    vid.play().catch(() => {});
  });
}

// Delete a clip and every motion extracted from it: detach those motions from any
// region using them, drop them from the library, then forget the clip.
function deleteVideo(rec) {
  const ids = rec.motionIds || [];
  for (const s of sel.selections) {
    if (ids.includes(s.motionId)) { s.motionId = null; animator._resetOne(s); }
  }
  for (const id of ids) library.remove(id);
  try { URL.revokeObjectURL(rec.url); } catch (_) {}
  const i = uploadedVideos.indexOf(rec);
  if (i >= 0) uploadedVideos.splice(i, 1);
  syncArmedMotionToSelection();   // resets library selection + re-renders lists
  renderChips();
  if (sel.mode === 'svg') sel._renderSVGHighlights(); else sel.redraw();
  const a = sel.getActive();
  if (a) showInspector(a); else hideInspector();
  status(ids.length
    ? `Deleted video and ${ids.length} motion${ids.length > 1 ? 's' : ''}.`
    : 'Deleted video.', true);
}
// (Step 10) synthFallTrajectories() used to live here: a hand-written sine-and-fall
// field that js/upload.js played over any clip whose FILENAME matched /leaf|autumn/,
// then saved as a motion called "Autumn Fall". It is gone, along with the filename
// branch that used it. A falling-leaves clip now goes through the same VLM route ->
// RAFT -> distill path as everything else, and what the user sees animated is what was
// measured. The hand-tuned leaf behaviour survives ONLY as a named preset in
// js/motions.js, where it is honestly labelled as one.
$('motion-input').onchange = (e) => window.handleMotionUpload(e);

// =========================================================================
//  Export animated SVG (self-contained: motion baked into CSS keyframes)
// =========================================================================
const btnExportSvg = $('btn-export-svg');
if (btnExportSvg) btnExportSvg.onclick = () => {
  if (sel.mode !== 'svg') { status('Export works with SVG artwork (the raster path has no vector scene to bake).'); return; }
  if (!sel.selections.some(s => s.motionId)) { status('Assign a motion to at least one object first.'); return; }
  const svgText = buildExportSVG(sel, library);
  if (!svgText) { status('Nothing to export.'); return; }
  const blob = new Blob([svgText], { type: 'image/svg+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'motionlife-poster.svg';
  a.click(); URL.revokeObjectURL(a.href);
  status('Exported! Drop the .svg into any website — <img src="motionlife-poster.svg"> — it animates by itself.', true);
};

// =========================================================================
//  Motion judge + auto-tune (Step 9) — on demand only, never automatic
// =========================================================================
const judgeOut = $('judge-out');
const btnJudge = $('btn-judge');
const btnJudgeRevert = $('btn-judge-revert');
let judgeUndo = null;         // { motionId, params } — the params from before the last run

function showJudge(s) {
  const section = $('judge-section');
  if (!section) return;
  // only offered where it can actually work: a vector scene with a motion assigned
  const ok = !!(s && s.motionId && sel.mode === 'svg');
  section.hidden = !ok;
  if (!ok && judgeOut) judgeOut.innerHTML = '';
}

if (btnJudge) btnJudge.onclick = async () => {
  const s = sel.getActive();
  const motion = s && s.motionId ? library.getById(s.motionId) : null;
  if (!motion) { status('Select an object with a motion assigned first.'); return; }

  btnJudge.disabled = true;
  const paint = st => window.MotionJudge.render(judgeOut, st);
  paint({ busy: 'Starting…' });
  const before = { ...(motion.params || {}) };
  try {
    const linked = uploadedVideos.find(v => (v.motionIds || []).includes(motion.id));
    const res = await window.MotionJudge.tune({
      sel, animator, motion,
      sourceUrl: linked ? linked.url : null,
      onStatus: msg => paint({ busy: msg }),
      onStep: st => paint({ ...st, iterations: st.iteration, scoreOf: null }),
    });
    paint(res);
    judgeUndo = { motionId: motion.id, params: before };
    if (btnJudgeRevert) btnJudgeRevert.hidden = false;
    const v = res.verdict;
    status(v ? `Judge: ${Math.round(v.score * 100)}% after ${res.iterations} pass`
              + `${res.iterations === 1 ? '' : 'es'} — ${res.reason}`
             : `Judge stopped: ${res.reason}`, !!v && v.score >= 0.8);
    renderMotionList();     // the chips draw from params, which may have moved
  } catch (e) {
    motion.params = before;                       // a failed run leaves nothing behind
    paint({ error: `${e.message}` });
    status(`Judge unavailable: ${e.message}. Is the router running on :8871?`);
  } finally {
    btnJudge.disabled = false;
  }
};

if (btnJudgeRevert) btnJudgeRevert.onclick = () => {
  if (!judgeUndo) return;
  const m = library.getById(judgeUndo.motionId);
  if (m) m.params = judgeUndo.params;
  judgeUndo = null;
  btnJudgeRevert.hidden = true;
  if (judgeOut) judgeOut.innerHTML = '';
  renderMotionList();
  status('Tuning undone — the motion is back to its extracted params.', true);
};

// =========================================================================
//  Auto-label the artwork's layers (Step 10) — one vision call, on demand
// =========================================================================
// The result is parked on window.__mlLayerLabels so js/regions.js can consult it when a
// NEW selection is created (a label beats the layer-name regex, see CLOTH_NAME_HINT) and
// js/upload.js can auto-apply against it. A global rather than a parameter because both
// of those run from outside this IIFE, on paths the user drives, not on a call chain.
const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function paintAutoLabel(state) {
  const el = $('autolabel-out');
  if (!el) return;
  if (state.busy) { el.innerHTML = `<div class="judge-busy">${esc(state.busy)}</div>`; return; }
  if (state.error) { el.innerHTML = `<div class="judge-err">${esc(state.error)}</div>`; return; }
  const labs = state.labels || [];
  const moving = labs.filter(l => l.motion_class);
  el.innerHTML = `
    <div class="judge-meta">${labs.length} layer${labs.length === 1 ? '' : 's'} labelled —
      ${moving.length} could move, ${labs.length - moving.length} left static.</div>
    ${labs.length ? `<ul class="judge-obs">${labs.map(l => `<li>${esc(l.label)} —
      <b>${esc(l.motion_class || 'static')}</b> ${Math.round(l.confidence * 100)}%
      ${l.motion_class ? `(${esc(l.deforms)})` : ''}</li>`).join('')}</ul>` : ''}
    ${(state.warnings || []).length
      ? `<div class="judge-meta">${state.warnings.map(esc).join(' · ')}</div>` : ''}`;
}

/* Run one labelling pass over the loaded SVG. Returns the labelling, or null.
   `groupsOf` is layerGroups — the same tree walk the Layers panel draws from, handed to
   autolabel.js so "what counts as a layer" has one definition. */
async function runAutoLabel() {
  const svg = artContainer.querySelector('svg');
  if (!svg) { paintAutoLabel({ error: 'auto-label needs a vector artwork (SVG).' }); return null; }
  const res = await window.MotionAutoLabel.label({
    svg, animator, capture, groupsOf: layerGroups,
    onStatus: msg => paintAutoLabel({ busy: msg }),
  });
  if (res.error) { paintAutoLabel(res); return null; }
  layerLabelling = res;
  window.__mlLayerLabels = res;
  // labels the VLM gave for layers the user has ALREADY selected: adopt them now rather
  // than only on the next click, so the panel and the regions agree immediately.
  for (const s of sel.selections || []) {
    if (!s.wrap) continue;
    const lab = [...res.byEl.entries()].find(([el]) =>
      el === s.wrap || el.contains(s.wrap) || s.wrap.contains(el));
    if (!lab) continue;
    s.layerLabel = lab[1];
    if (lab[1].label) s.name = lab[1].label;
    // waveMode is only overwritten when nothing stronger decided it: a captured motion
    // with a real trajectory field is direct evidence and outranks a still-image reading.
    if (s.waveModeFrom !== 'motion_field' && s.waveModeFrom !== 'artwork_rigid') {
      s.waveMode = lab[1].deforms === 'mesh';
      s.waveModeFrom = `vlm:${lab[1].motion_class || 'static'}`;
    }
  }
  paintAutoLabel(res);
  renderLayers(svg);
  renderChips();
  if (sel.mode === 'svg') sel._renderSVGHighlights();
  const a = sel.getActive(); if (a) showInspector(a);
  return res;
}

const btnAutoLabel = $('btn-autolabel');
if (btnAutoLabel) btnAutoLabel.onclick = async () => {
  btnAutoLabel.disabled = true;
  try {
    const res = await runAutoLabel();
    if (res) {
      const moving = res.labels.filter(l => l.motion_class).length;
      status(`Labelled ${res.labels.length} layers — ${moving} can take motion. `
             + 'Upload a clip and its swatches will land on the right objects.', true);
    }
  } catch (e) {
    paintAutoLabel({ error: e.message });
    status(`Auto-label failed: ${e.message}`);
  } finally {
    btnAutoLabel.disabled = false;
  }
};

/* Auto-apply, for js/upload.js: label the artwork if it has not been labelled yet, then
   put each motion on the layer its class matches. Returns {applied, skipped} — and
   applies NOTHING when there are no labels, rather than guessing from names. */
async function autoApplyMotions(motions) {
  const svg = artContainer.querySelector('svg');
  if (!svg) return { applied: [], skipped: [], reason: 'auto-apply needs a vector artwork (SVG).' };
  if (!motions.length) return { applied: [], skipped: [] };
  if (!layerLabelling) await runAutoLabel();
  // runAutoLabel already painted the reason into #autolabel-out; hand it to the caller too
  // so the upload status can say WHY nothing was applied instead of going quiet.
  if (!layerLabelling) {
    return { applied: [], skipped: motions.map(m => ({ motionId: m.id, why: 'no layer labels' })),
             reason: 'The artwork could not be labelled, so nothing was auto-applied —' };
  }
  const res = await window.MotionAutoLabel.apply({
    motions, labelling: layerLabelling, sel, library, animator, applyMotionToActive,
  });
  if (res.applied.length) {
    renderChips();
    if (sel.mode === 'svg') sel._renderSVGHighlights();
    const a = sel.getActive(); if (a) showInspector(a);
  }
  return res;
}

// =========================================================================
//  Upload artwork
// =========================================================================
$('btn-upload-art').onclick = () => $('art-input').click();
$('art-input').onchange = (e) => {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  const isSvg = file.type === 'image/svg+xml' || file.name.toLowerCase().endsWith('.svg');
  reader.onload = () => { isSvg ? loadUploadedSVG(reader.result) : loadRasterImage(reader.result); };
  isSvg ? reader.readAsText(file) : reader.readAsDataURL(file);
  e.target.value = '';
};

// =========================================================================
//  Preview popup — the input artwork beside the animated MotionLife result
// =========================================================================
(function addPreviewButton() {
  const headerRight = document.querySelector('.header-right');
  if (!headerRight || $('btn-preview')) return;
  const btn = document.createElement('button');
  btn.id = 'btn-preview';
  btn.className = 'subtle-btn';
  btn.textContent = 'Preview';
  headerRight.insertBefore(btn, headerRight.firstChild);   // first action on the top bar
  btn.onclick = openPreview;
})();

// Size the popup panel to the artwork's real aspect ratio so the two panes hug the
// images with no letterbox bars, and the images grow as large as the viewport allows.
function sizePreviewPanel(panel) {
  const w = +artContainer.dataset.artW, h = +artContainer.dataset.artH;
  const r = (w > 0 && h > 0) ? w / h : 8 / 5;          // artwork aspect (fallback 8:5)
  const bar = panel.querySelector('.preview-bar');
  const cap = panel.querySelector('figcaption');
  const barH = bar ? bar.offsetHeight : 50;
  const capH = (cap ? cap.offsetHeight : 16) + 8;      // caption + its gap to the frame
  const padV = 32, padH = 32, gap = 14;                // .preview-body padding + gap
  const availW = window.innerWidth * 0.96, availH = window.innerHeight * 0.94;
  // largest per-image height that fits both the height budget and the width budget
  // (two images of ratio r side by side share the width)
  const byH = availH - barH - capH - padV;
  const byW = (availW - padH - gap) / (2 * r);
  const imgH = Math.max(160, Math.min(byH, byW));
  panel.style.width  = Math.round(2 * imgH * r + gap + padH) + 'px';
  panel.style.height = Math.round(imgH + capH + padV + barH) + 'px';
}

let _previewOpen = false;
function openPreview() {
  if (_previewOpen) return;
  _previewOpen = true;

  const modal = document.createElement('div');
  modal.className = 'preview-modal';
  modal.innerHTML = `
    <div class="preview-panel">
      <div class="preview-bar">
        <span class="preview-title">Preview</span>
        <div class="preview-tabs">
          <span class="preview-tag">Input</span>
          <span class="preview-arrow">→</span>
          <span class="preview-tag live">MotionLife</span>
        </div>
        <button class="preview-close" aria-label="Close">✕</button>
      </div>
      <div class="preview-body">
        <figure class="preview-frame"><figcaption>Input</figcaption><div class="preview-input"></div></figure>
        <figure class="preview-frame"><figcaption>MotionLife</figcaption><div class="preview-live"></div></figure>
      </div>
    </div>`;
  document.body.appendChild(modal);
  const panel = modal.querySelector('.preview-panel');
  sizePreviewPanel(panel);

  // Input (static): the original uploaded artwork, before wraps/motion.
  const inputHost = modal.querySelector('.preview-input');
  if (originalArtwork && originalArtwork.type === 'svg') inputHost.innerHTML = originalArtwork.content;
  else if (originalArtwork && originalArtwork.type === 'img') inputHost.innerHTML = `<img src="${originalArtwork.content}" alt="input artwork">`;
  else inputHost.innerHTML = `<div class="preview-empty">Upload artwork to preview it here</div>`;

  // MotionLife (live, animated): move the real stage into the popup so it keeps playing.
  const liveHost = modal.querySelector('.preview-live');
  const prevHidden = sel.highlightsHidden;
  sel.setHighlightsHidden(true);                 // clean preview — no selection outlines
  if (!animator.playing) { animator.play(); if (typeof syncPlayButton === 'function') syncPlayButton(); }
  liveHost.appendChild(artContainer);
  refitArtwork();                                // fit the artwork to the popup frame

  // keep the panel and artwork fitted to the viewport as it changes size
  const onResize = () => { sizePreviewPanel(panel); refitArtwork(); };
  window.addEventListener('resize', onResize);

  const close = () => {
    $('canvas-wrap').insertBefore(artContainer, overlay);   // back home, before the overlay
    sel.setHighlightsHidden(prevHidden);
    refitArtwork(); syncOverlay();
    modal.remove();
    _previewOpen = false;
    window.removeEventListener('resize', onResize);
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  modal.querySelector('.preview-close').onclick = close;
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.addEventListener('keydown', onKey, true);
}

// =========================================================================
//  Boot
// =========================================================================
window.addEventListener('resize', () => { refitArtwork(); syncOverlay(); });

// ---- theme toggle (default dark; persisted) ----
const themeBtn = $('theme-toggle');
if (themeBtn) {
  const paintIcon = () => {
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    themeBtn.textContent = isLight ? '🌙' : '☀️';   // shows the theme you'd switch TO
  };
  paintIcon();
  themeBtn.onclick = () => {
    const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('ml-theme', next);
    paintIcon();
  };
}

// ---- right panel collapse ----
const rightCollapse = $('right-collapse');
if (rightCollapse) {
  rightCollapse.onclick = () => {
    const main = document.querySelector('main');
    const collapsed = main.classList.toggle('right-collapsed');
    rightCollapse.textContent = collapsed ? '‹' : '›';
    rightCollapse.title = collapsed ? 'Expand panel' : 'Collapse panel';
  };
}

// Escape clears the active selection, matching common design-tool convention
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') sel.deselect();
});

// Clicking the dark letterboxed area around the artwork (not the artwork
// itself) also deselects — it reads as "empty space" even though technically
// nothing is there to click.
const canvasWrap = $('canvas-wrap');
if (canvasWrap) {
  canvasWrap.addEventListener('click', (e) => {
    if (e.target === canvasWrap) sel.deselect();
  });
}

renderMotionList();
loadBlank();

// expose for automated testing
window.__ms = { sel, library, animator, loadScene, loadUploadedSVG, loadRasterImage };

// bridge: upload.js is a separate script and can't see these IIFE-local symbols,
// so hand them across explicitly (it destructures window.__mlUpload at call time).
window.__mlUpload = { $, status, capture, library, sel, renderMotionList,
  addVideoThumb, showInspector, applyMotionToActive, autoApplyMotions };

})();
