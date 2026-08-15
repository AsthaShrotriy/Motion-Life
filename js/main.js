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

// ---- overlay always matches the 800x500 viewBox basis ----
function syncOverlay() {
  const rect = artContainer.getBoundingClientRect();
  overlay.width = 800; overlay.height = 500;
  overlay.style.width = rect.width + 'px';
  overlay.style.height = rect.height + 'px';
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
  if (m.trajectories && m.trajectories.length >= 25) {
    // subsample the 12x12 grid to 5x5, store drift-removed relative tracks
    const G = Math.round(Math.sqrt(m.trajectories.length));   // 12
    const idx = [];
    for (let gy = 0; gy < GRID_N; gy++)
      for (let gx = 0; gx < GRID_N; gx++)
        idx.push(Math.min(G - 1, Math.round(gy * (G - 1) / (GRID_N - 1))) * G
               + Math.min(G - 1, Math.round(gx * (G - 1) / (GRID_N - 1))));
    const tracks = idx.map(i => {
      const tr = m.trajectories[i];
      const x0 = tr[0][0], y0 = tr[0][1];
      return tr.map(p => [p[0] - x0, p[1] - y0]);
    });
    return { tracks };
  }
  return { tracks: null };
}

// select + apply a motion, keeping presets / extracted swatches / videos in sync
function selectMotion(id) {
  library.select(id);
  renderMotionList();
  const applied = applyMotionToActive();
  const m = library.getById(id);
  status(applied ? `Applied "${m.name}" to "${applied}".`
                 : `Motion "${m.name}" selected — now click an object to apply it.`, true);
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
  tile.title = m.desc || m.name;
  tile.onclick = () => selectMotion(m.id);
  container.appendChild(tile);
  chipTiles.push({ canvas, ctx: canvas.getContext('2d'), motion: m, ...buildChipState(m) });
}

function renderMotionList() {
  chipTiles.length = 0;
  motionListEl.innerHTML = '';
  const extractedEl = $('extracted-list');
  if (extractedEl) extractedEl.innerHTML = '';

  // Motion Presets: built-in motions only
  for (const m of library.getAll().filter(m => !m.fromUpload)) makeChip(m, motionListEl);

  // Extracted Motion: one per video, in the same order as the Videos list
  const extractedSection = $('extracted-section');
  if (extractedSection) extractedSection.hidden = uploadedVideos.length === 0;
  if (extractedEl) {
    const shown = new Set();
    for (const v of uploadedVideos) {
      const m = v.motionId && library.getById(v.motionId);
      if (m) { makeChip(m, extractedEl); shown.add(m.id); }
    }
    // any captured motion not tied to a video (e.g. multi-pick) still shows
    for (const m of library.getAll().filter(m => m.fromUpload && !shown.has(m.id)))
      makeChip(m, extractedEl);
  }

  renderVideoList();
}

function chipLoop() {
  requestAnimationFrame(chipLoop);
  const t = performance.now() / 1000;
  for (const tile of chipTiles) {
    const { canvas, ctx, motion, tracks } = tile;
    if (!canvas.isConnected) continue;
    const S = canvas.width;
    const [r, g, b] = hexToRgb(motion.color || '#7c6cff');

    // motion-blur fade instead of clear → dots drag trails
    ctx.fillStyle = 'rgba(26,27,42,0.28)';
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

sel.onCreated = (s, idx) => { renderChips(); showInspector(s); applyMotionToActive(); refreshHighlightsSoon(); };
sel.onSelected = (s, idx) => { renderChips(); showInspector(s); };

function applyMotionToActive() {
  const s = sel.getActive();
  const m = library.getSelected();
  if (s && m) {
    s.motionId = m.id;
    const modeEl = s.kind === 'svg' && s.wrap
      ? s.wrap.querySelector('[data-motion-mode]')
      : null;
    const motionMode = modeEl ? modeEl.getAttribute('data-motion-mode') : 'auto';
    // captured motions carry a real trajectory field — geometry deformation
    // unless the artwork marks the selected object as structurally rigid.
    if (motionMode === 'rigid') {
      s.waveMode = false;
    } else if (s.kind === 'svg' && m.trajectories && m.trajectories.length) {
      s.waveMode = true;
    }
    // switching motions invalidates deformation caches
    if (s.wrap) {
      for (const el of s.wrap.querySelectorAll('path[data-ms-d0]')) el.setAttribute('d', el.getAttribute('data-ms-d0'));
    }
    s._wave = null; s._field = undefined; s._fieldMotion = null; s._text = undefined;
    showInspector(s);
    if (sel.mode === 'svg') sel._renderSVGHighlights(); else sel.redraw();
    return s.name;
  }
  return null;
}

// =========================================================================
//  Artwork loading + scene tabs (Poster / Scenery)
// =========================================================================
let currentScene = 'poster';

// file-based scenes: fetched from disk and loaded through the same SVG path as
// an uploaded artwork (so the .layer[data-name] contract makes objects selectable)
const FILE_SCENES = {
  train: 'assets/scenes/train-window-adobe.svg',
};

async function loadScene(name) {
  currentScene = name;
  animator.pause();
  $('btn-play').textContent = '▶ Play';
  $('btn-play').classList.remove('playing');

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

// blank white artboard — the default canvas; the user uploads their own artwork
const SVGNS = 'http://www.w3.org/2000/svg';
function loadBlank() {
  animator.pause();
  $('btn-play').textContent = '▶ Play';
  $('btn-play').classList.remove('playing');
  artContainer.innerHTML = '';
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', '0 0 800 500');
  svg.style.width = '100%'; svg.style.height = '100%';
  const bg = document.createElementNS(SVGNS, 'rect');
  bg.setAttribute('x', 0); bg.setAttribute('y', 0);
  bg.setAttribute('width', 800); bg.setAttribute('height', 500);
  bg.setAttribute('fill', '#ffffff');
  svg.appendChild(bg);
  artContainer.appendChild(svg);
  syncOverlay();
  setModeUI('svg');
  renderChips(); hideInspector(); showLayers();
  status('Blank artboard — upload artwork to begin.');
}

function loadUploadedSVG(text) {
  animator.pause();
  artContainer.innerHTML = text;
  const svg = artContainer.querySelector('svg');
  if (!svg) { status('That SVG could not be parsed.'); return; }
  svg.style.width = '100%'; svg.style.height = '100%';
  if (!svg.getAttribute('viewBox')) {
    const w = svg.getAttribute('width') || 800, h = svg.getAttribute('height') || 500;
    svg.setAttribute('viewBox', `0 0 ${parseFloat(w)} ${parseFloat(h)}`);
  }
  syncOverlay();
  sel.attachSVG(svg);
  setModeUI('svg');
  renderChips(); hideInspector(); showLayers();
  const n = svg.querySelectorAll('.ms-wrap').length;
  status(`SVG loaded — ${n} selectable element(s). Click one to select, then pick a motion.`, true);
}

function loadRasterImage(dataUrl) {
  animator.pause();
  artContainer.innerHTML = `<img src="${dataUrl}" draggable="false">`;
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
  markLayerActive(s.wrap);
}
function hideInspector() { $('inspector-section').hidden = true; $('inspector-content').hidden = true; markLayerActive(null); }

// Layers panel appears once artwork is present (poster / scenery / upload)
// and lists the artwork's groups/layers as a collapsible tree.
const layerRowByWrap = new Map();   // ms-wrap element -> its layer row

function showLayers() {
  const section = $('layers-section');
  if (!section) return;
  const svg = artContainer.querySelector('svg');
  // hide when there's no artwork with groups (raster, or the blank artboard)
  if (!svg || layerGroups(svg).length === 0) { section.hidden = true; return; }
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
  caret.textContent = kids.length ? '▾' : '';

  const eye = document.createElement('span');
  eye.className = 'layer-eye';
  eye.innerHTML = EYE_ICON;

  const label = document.createElement('span');
  label.className = 'layer-name';
  label.textContent = decodeLayerName(el.getAttribute('data-name') || el.id) || '<Group>';

  row.append(caret, eye, label);
  node.appendChild(row);

  const wrap = el.closest('.ms-wrap');
  if (wrap && el.parentElement === wrap) layerRowByWrap.set(wrap, row);

  let childBox = null;
  if (kids.length) {
    childBox = document.createElement('div');
    childBox.className = 'layer-children';
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

  row.onclick = () => {
    if (wrap) {
      const t = wrap.querySelector('path,rect,polygon,text,circle,ellipse') || wrap;
      t.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }
  };
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
$('btn-remove-motion').onclick = () => {
  const s = sel.getActive();
  if (!s) return;
  s.motionId = null;
  if (s.wrap) s.wrap.setAttribute('transform', '');
  if (s.floatEl) s.floatEl.style.transform = '';
  showInspector(s);
  renderChips();
  if (sel.mode === 'svg') sel._renderSVGHighlights(); else sel.redraw();
  status('Motion removed.');
};
$('btn-delete-region').onclick = () => { sel.deleteActive(); renderChips(); const a = sel.getActive(); if (a) showInspector(a); else hideInspector(); status('Region deleted.'); };

// =========================================================================
//  Tools
// =========================================================================
$('btn-tool-rect').onclick = () => { sel.setTool('rect'); $('btn-tool-rect').classList.add('active'); };

// =========================================================================
//  Animator + play
// =========================================================================
const animator = new Animator(sel, library);
// single source of truth: the button always reflects the animator's real state
function syncPlayButton() {
  const p = animator.playing;
  const b = $('btn-play');
  if (!b) return;
  b.textContent = p ? '⏸ Pause' : '▶ Play';
  b.classList.toggle('playing', p);
}
animator.onchange = syncPlayButton;

$('btn-play').onclick = () => {
  // block only STARTING with nothing animated; pausing must always work
  if (!animator.playing && !sel.selections.some(s => s.motionId)) {
    status('Assign a motion to at least one object first.');
    return;
  }
  animator.toggle();
  sel.setHighlightsHidden(false);   // keep selection outlines visible in play AND pause
  status(animator.playing ? 'Playing.' : 'Paused.');
};

// =========================================================================
//  Video export (reusable — driven by the Preview panel's Download button)
// =========================================================================
async function runExport(btnEl) {
  if (!sel.selections.some(s => s.motionId)) { status('Nothing is animated yet.'); return; }
  const label = btnEl ? btnEl.textContent : '';
  if (btnEl) btnEl.disabled = true;
  const wasPlaying = animator.playing;
  if (!wasPlaying) animator.play();
  try {
    const blob = await exportVideo(sel, animator, {
      seconds: 8, mode: 'flat',
      onProgress: p => { if (btnEl) btnEl.textContent = p < 1 ? `Recording… ${Math.round(p * 100)}%` : label; },
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'motionlife.' + (blob.type.includes('mp4') ? 'mp4' : 'webm');
    a.click(); URL.revokeObjectURL(a.href);
    status('Video downloaded — matches the artwork size.', true);
  } catch (err) {
    status('Video export failed: ' + err.message);
  }
  if (!wasPlaying) animator.pause();
  if (btnEl) { btnEl.textContent = label; btnEl.disabled = false; }
}

// =========================================================================
//  Preview panel — Original | MotionLife (live) | Source Motion  + Download
// =========================================================================
let previewHome = null;
function closePreview() {
  const modal = $('preview-modal');
  animator.pause();
  if (previewHome) { previewHome.parent.insertBefore(artContainer, previewHome.next); previewHome = null; }
  sel.setHighlightsHidden(false);
  if (sel.mode === 'svg') sel._renderSVGHighlights();
  syncOverlay();
  if (modal) modal.hidden = true;
  $('preview-static').innerHTML = '';
  $('preview-videos').innerHTML = '';
  $('btn-play').textContent = '▶ Play'; $('btn-play').classList.remove('playing');
}
function openPreview() {
  const svg = artContainer.querySelector('svg');
  if (!svg) { status('Load artwork first.'); return; }
  const modal = $('preview-modal');
  if (!modal) return;

  animator.pause();   // freeze so the "Original" side has no motion baked in

  // Original: a pristine, static clone (outlines stripped)
  const staticBox = $('preview-static'); staticBox.innerHTML = '';
  const clone = svg.cloneNode(true);
  const chl = clone.querySelector('#ms-highlights'); if (chl) chl.remove();
  clone.style.width = '100%'; clone.style.height = '100%';
  staticBox.appendChild(clone);

  // MotionLife: move the REAL artwork into the live slot so the animator drives it
  sel.setHighlightsHidden(true);          // clean preview, no selection outlines
  previewHome = { parent: artContainer.parentNode, next: artContainer.nextSibling };
  $('preview-live').appendChild(artContainer);

  // Motion videos used: clips whose motion is actually applied on canvas
  const usedIds = new Set(sel.selections.filter(s => s.motionId).map(s => s.motionId));
  const vids = uploadedVideos.filter(v => v.motionId && usedIds.has(v.motionId));
  const list = vids.length ? vids : uploadedVideos;
  const vbox = $('preview-videos'); vbox.innerHTML = '';
  if (!list.length) {
    vbox.innerHTML = '<div class="preview-empty">No source video — a built-in preset motion is applied.</div>';
  } else {
    list.forEach(v => {
      const c = document.createElement('div'); c.className = 'preview-video';
      const vid = document.createElement('video');
      vid.src = v.url; vid.muted = true; vid.loop = true; vid.autoplay = true;
      vid.playsInline = true; vid.setAttribute('playsinline', '');
      const nm = document.createElement('div'); nm.className = 'preview-video-name'; nm.textContent = v.name;
      c.append(vid, nm); vbox.appendChild(c); vid.play().catch(() => {});
    });
  }

  modal.hidden = false;
  animator.play();
  $('btn-play').textContent = '⏸ Pause'; $('btn-play').classList.add('playing');
}
const btnPreview = $('btn-preview');
if (btnPreview) btnPreview.onclick = openPreview;
const btnPreviewClose = $('preview-close');
if (btnPreviewClose) btnPreviewClose.onclick = closePreview;
const btnPreviewDownload = $('preview-download');
if (btnPreviewDownload) btnPreviewDownload.onclick = () => runExport(btnPreviewDownload);
{
  const modal = $('preview-modal');
  if (modal) modal.addEventListener('click', e => { if (e.target === modal) closePreview(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && modal && !modal.hidden) closePreview();
  });
}

function refreshHighlightsSoon() { if (sel.mode === 'svg') requestAnimationFrame(() => sel._renderSVGHighlights()); }

// =========================================================================
//  Upload motion video
// =========================================================================
const capture = new MotionCapture();
$('btn-upload-motion').onclick = () => $('motion-input').click();

// ---- Videos section: thumbnails of uploaded clips (same UI as motion chips) ----
const uploadedVideos = [];
function addVideoThumb(url, name) {
  const rec = { url, name, motionId: null };
  uploadedVideos.push(rec);
  renderVideoList();
  return rec;
}
function renderVideoList() {
  const el = $('video-list');
  el.innerHTML = '';
  $('videos-section').classList.toggle('has-videos', uploadedVideos.length > 0);
  uploadedVideos.forEach(v => {
    const chip = document.createElement('div');
    const linked = v.motionId && v.motionId === library.selectedId;
    chip.className = 'motion-chip video-chip' + (linked ? ' active' : '');
    const vid = document.createElement('video');
    vid.src = v.url; vid.muted = true; vid.loop = true; vid.autoplay = true;
    vid.playsInline = true; vid.setAttribute('playsinline', '');
    chip.appendChild(vid);
    const nm = document.createElement('div');
    nm.className = 'chip-name'; nm.textContent = v.name; nm.title = v.name;
    chip.appendChild(nm);
    // click a video → apply its extracted motion (and its swatch highlights)
    if (v.motionId) chip.onclick = () => selectMotion(v.motionId);
    el.appendChild(chip);
    vid.play().catch(() => {});
  });
}

$('motion-input').onchange = async (e) => {
  const file = e.target.files[0]; if (!file) return;

  // show the clip in the Videos section
  const videoUrl = URL.createObjectURL(file);
  const videoRec = addVideoThumb(videoUrl, file.name.replace(/\.[^.]+$/, ''));

  $('upload-status').textContent = 'Analyzing motion…';
  capture.onProgress = (p, msg) => {
    $('upload-status').textContent = msg || `Analyzing… ${Math.round(p * 100)}%`;
  };
  try {
    const motion = await capture.captureFromFile(file);
    if (motion) {
      // MULTI-MOTION BRANCH: if the service segmented ≥2 distinct motions,
      // show the picker so the user names and chooses which to save. Each
      // chosen region becomes its own Motion in the library (the whole-frame
      // `motion` variable is discarded — its trajectories/params are the
      // blended average, not what the user wants).
      if (motion.regions && motion.regions.length >= 2 && window.showMultiPick) {
        $('upload-status').textContent =
          `${motion.regions.length} motions detected — pick and name them.`;
        const picked = await showMultiPick(motion.videoUrl, motion.regions, {
          engine: motion.engine,
          framesAnalyzed: motion.framesAnalyzed,
          fps: motion.trajFps,
        });
        if (!picked.length) {
          // user cancelled or unchecked everything — release the shared
          // object URL and bail without adding anything
          URL.revokeObjectURL(motion.videoUrl);
          $('upload-status').textContent = 'No motions saved.';
        } else {
          for (const m of picked) library.add(m);
          videoRec.motionId = picked[0].id;   // link the clip to its first motion
          renderMotionList();
          const names = picked.map(m => `"${m.name}"`).join(', ');
          $('upload-status').textContent =
            `Added ${picked.length} motion${picked.length > 1 ? 's' : ''}.`;
          status(`Added ${picked.length} motion${picked.length > 1 ? 's' : ''} — ${names}. Click one, then apply to an object.`, true);
        }
      } else {
        // SINGLE-MOTION PATH (unchanged): the "wow" extraction moment only
        // plays when there's really just one motion to celebrate.
        if (motion.trajectories && motion.videoUrl && window.showExtraction) {
          await showExtraction(motion.videoUrl, motion.trajectories, motion.params, motion.color);
        }
        library.add(motion); videoRec.motionId = motion.id; renderMotionList();
        $('upload-status').textContent = `Added "${motion.name}"`;
        status(`Motion "${motion.name}" captured from video — click it, then apply to an object.`, true);
      }
    } else {
      $('upload-status').textContent = 'Could not extract motion (need more movement / a longer clip).';
    }
  } catch (err) {
    $('upload-status').textContent = 'Video error: ' + err.message;
  }
  e.target.value = '';
};

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
//  Boot
// =========================================================================
window.addEventListener('resize', syncOverlay);

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

renderMotionList();
loadBlank();

// expose for automated testing
window.__ms = { sel, library, animator, loadScene, loadUploadedSVG, loadRasterImage };

})();
