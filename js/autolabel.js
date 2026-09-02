/*
 * autolabel.js — Step 10: ask the VLM what the ARTWORK contains, then put each
 * extracted swatch on the object it belongs to.
 *
 * This is the half of the chain the router could not reach before. /decompose looks at
 * the CLIP and says "a flag waves here, smoke rises there". Nothing looked at the
 * DRAWING, so deciding which layer the cloth swatch belonged on came down to a regex
 * over layer names (`/flag|banner|cloth/`) — a claim about a string an illustrator typed,
 * not about the picture. /label closes that: the router is shown the illustration plus
 * one crop per layer and returns Contract D (service/contracts.py), and the match is made
 * on CLASS, never on names.
 *
 * Three things are deliberate.
 *
 * ON DEMAND, AND HONEST WHEN ABSENT. Labelling is one paid vision call. It runs when the
 * user presses the button, or once per multi-motion upload. If the router is down there
 * are no labels, and auto-apply says so and applies NOTHING — it does not fall back to
 * name matching, because a wrong auto-apply is worse than no auto-apply.
 *
 * ONE-TO-ONE, NOT BEST-EFFORT. matchSwatchesToLayers is a mirror of
 * contracts.match_swatches_to_layers, and tests/step10-orchestration.js runs the SAME
 * fixtures through both so the two cannot drift. Sharing one swatch between two layers
 * would render two objects moving in lockstep, which is a claim the source clip never made.
 *
 * NO SYNTHETIC SELECTION. Applying to a layer goes through a real click on a drawable
 * inside it, so the region that gets created is exactly the one a user's click would
 * create (SelectionManager._bestUnitFor decides, not this file).
 */

(() => {
'use strict';

/* Which layer a swatch belongs on. Pure; mirrors contracts.match_swatches_to_layers.
   Greedy one-to-one on class only, best-confidence layer first. Returns
   { pairs: [[swatchIndex, layerId]], unmatched: [swatchIndex] }. */
const LABEL_CONF_MIN = 0.35;         // == vlm_router CONF_MIN: same bar for both contracts

function matchSwatchesToLayers(swatches, labels, confMin = LABEL_CONF_MIN) {
  const cands = (labels || [])
    .filter(l => l && l.motion_class && (l.confidence || 0) >= confMin)
    .slice()
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
  const used = new Set(), pairs = [], unmatched = [];
  (swatches || []).forEach((sw, si) => {
    const cls = (sw && sw.class) || '';
    const hit = cands.find(l => l.motion_class === cls && !used.has(l.id));
    if (!hit) unmatched.push(si);
    else { used.add(hit.id); pairs.push([si, hit.id]); }
  });
  return { pairs, unmatched };
}

/* ── the artwork side (needs a DOM) ──────────────────────────────────────── */

/* A layer's box in viewBox coordinates, normalized 0-1.
   Computed through getScreenCTM rather than getBBox alone: a layer group can carry its
   own transform (and the animator's), and a bbox in the element's own user space would
   name the wrong part of the rasterized image — which would crop the wrong object and
   label it confidently. */
function normBox(el, svg) {
  const vb = (svg.viewBox && svg.viewBox.baseVal && svg.viewBox.baseVal.width)
    ? svg.viewBox.baseVal
    : { x: 0, y: 0, width: svg.clientWidth || 1, height: svg.clientHeight || 1 };
  let bb;
  try { bb = el.getBBox(); } catch { return null; }
  if (!bb || !bb.width || !bb.height) return null;
  let pts = [[bb.x, bb.y], [bb.x + bb.width, bb.y], [bb.x, bb.y + bb.height],
             [bb.x + bb.width, bb.y + bb.height]];
  try {
    const root = svg.getScreenCTM(), own = el.getScreenCTM();
    if (root && own) {
      const m = root.inverse().multiply(own);
      pts = pts.map(([x, y]) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f]);
    }
  } catch { /* detached node: fall back to the untransformed bbox */ }
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const x0 = (Math.min(...xs) - vb.x) / vb.width, x1 = (Math.max(...xs) - vb.x) / vb.width;
  const y0 = (Math.min(...ys) - vb.y) / vb.height, y1 = (Math.max(...ys) - vb.y) / vb.height;
  const cl = v => Math.max(0, Math.min(1, v));
  return [+cl(x0).toFixed(4), +cl(y0).toFixed(4),
          +cl(x1 - x0).toFixed(4), +cl(y1 - y0).toFixed(4)];
}

/* The layers worth labelling, and why each one is worth it.
   `groupsOf` is main.js's layerGroups (the .ms-wrap-transparent tree walk), passed in so
   there is one definition of what a layer is. A group covering nearly the whole canvas is
   dropped: it is the artwork's root wrapper, and labelling it "illustration" and animating
   it would move everything at once. */
function collectLayers(svg, groupsOf, opts = {}) {
  const maxCover = opts.maxCoverage != null ? opts.maxCoverage : 0.9;
  const cap = opts.cap != null ? opts.cap : 12;      // == the router's LABEL_MAX_LAYERS
  const out = [], skipped = [];
  const walk = (parent, depth) => {
    for (const g of groupsOf(parent)) {
      const bbox = normBox(g, svg);
      const kids = groupsOf(g);
      if (!bbox) { skipped.push('(no bbox)'); continue; }
      const cover = bbox[2] * bbox[3];
      if (cover > maxCover && kids.length && depth < 3) { walk(g, depth + 1); continue; }
      if (cover > maxCover) { skipped.push(nameOf(g) + ' (covers the canvas)'); continue; }
      out.push({ id: 'L' + (out.length + 1), name: nameOf(g), bbox, el: g });
    }
  };
  walk(svg, 0);
  return { layers: out.slice(0, cap), skipped,
           dropped: Math.max(0, out.length - cap) };
}

// Illustrator encodes non-alphanumerics as _xHH_; the router is told the decoded name
// AND told to treat it as a hint only.
function nameOf(el) {
  const raw = el.getAttribute('data-name') || el.id || '';
  return raw.replace(/_x([0-9A-Fa-f]{2,6})_/g, (m, h) => {
    try { return String.fromCodePoint(parseInt(h, 16)); } catch (e) { return m; }
  }) || '<group>';
}

/* The artwork as a JPEG data URL, at the size the router wants anyway (512 wide).
   The animator is paused first: a snapshot taken mid-animation shows the flag already
   bent, and the crops would then be boxes around a deformed shape. */
async function snapshot(svg, animator, width = 512) {
  if (!window.svgToImage) throw new Error('svgToImage unavailable (js/videoexport.js did not load)');
  const wasPlaying = animator && animator.playing;
  if (animator) animator.pause();
  try {
    const img = await window.svgToImage(svg);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = Math.max(1, Math.round(width * img.height / img.width));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';        // flatten alpha: a transparent JPEG reads as noise
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.85);
  } finally {
    if (wasPlaying && animator) animator.play();
  }
}

/* ── the whole pass ──────────────────────────────────────────────────────── */

/* Label the artwork. Returns { labels, byId, byEl, layers, art, warnings } or
   { error } — never throws for a router that is simply not running. */
async function label({ svg, animator, capture, groupsOf, onStatus }) {
  const say = onStatus || (() => {});
  const { layers, skipped, dropped } = collectLayers(svg, groupsOf);
  if (!layers.length) return { error: 'no labellable layers in this artwork', labels: [] };
  say(`Rendering the artwork for ${layers.length} layer${layers.length === 1 ? '' : 's'}…`);
  const image = await snapshot(svg, animator);
  say('Asking the VLM what each layer is…');
  const res = await capture.labelLayers(image,
    layers.map(l => ({ id: l.id, name: l.name, bbox: l.bbox })));
  if (!res) return { error: 'VLM router unreachable (start service/vlm_router.py on :8871)',
                     labels: [] };
  const byId = new Map(), byEl = new Map();
  for (const lab of res.labels || []) {
    const src = layers.find(l => l.id === lab.id);
    if (!src) continue;               // normalize_layer_labels already dropped these
    byId.set(lab.id, lab); byEl.set(src.el, lab);
    lab.el = src.el;
  }
  const warnings = (res.warnings || []).slice();
  if (dropped) warnings.push(`${dropped} further layer(s) were not sent (cap ${layers.length})`);
  if (skipped.length) warnings.push('not labellable: ' + skipped.slice(0, 4).join(', '));
  return { labels: res.labels || [], byId, byEl, layers, art: res.art || {}, warnings };
}

/* Put each motion on the layer its class says it belongs to.
   Returns { applied:[{motionId, layerId, layerLabel, region}], skipped:[{motionId, why}] }.
   Applies through a real click, so the region created is the one a user would get. */
async function apply({ motions, labelling, sel, library, animator, applyMotionToActive }) {
  const applied = [], skipped = [];
  if (!labelling || !labelling.labels || !labelling.labels.length) {
    for (const m of motions) skipped.push({ motionId: m.id, why: 'no layer labels' });
    return { applied, skipped };
  }
  // the swatch's class outranks the motion's; _classOf is the single definition of that
  const classed = motions.map(m => ({ m, class: animator._classOf(m) || '' }));
  const { pairs, unmatched } = matchSwatchesToLayers(classed, labelling.labels);
  for (const si of unmatched) {
    const c = classed[si];
    skipped.push({ motionId: c.m.id,
                   why: c.class ? `no free layer labelled ${c.class}` : 'motion has no class' });
  }
  for (const [si, layerId] of pairs) {
    const lab = labelling.byId.get(layerId);
    const el = lab && lab.el;
    if (!el) { skipped.push({ motionId: classed[si].m.id, why: 'layer went away' }); continue; }
    const region = selectLayer(el, sel);
    if (!region) { skipped.push({ motionId: classed[si].m.id, why: 'layer is not selectable' }); continue; }
    // the VLM's own reading of the artwork replaces the layer-name regex for BOTH the
    // display name and the deform mode. waveModeFrom records which decided it.
    if (lab.label) region.name = lab.label;
    region.waveMode = lab.deforms === 'mesh';
    region.waveModeFrom = `vlm:${lab.motion_class}`;
    region.layerLabel = lab;
    library.select(classed[si].m.id);
    applyMotionToActive();
    applied.push({ motionId: classed[si].m.id, layerId, layerLabel: lab.label, region });
  }
  return { applied, skipped };
}

/* Select a layer the way a user would: reuse an existing region over it, else click a
   drawable inside it and let SelectionManager decide the unit. */
function selectLayer(el, sel) {
  const existing = (sel.selections || []).findIndex(
    s => s.wrap && (s.wrap === el || s.wrap.contains(el) || el.contains(s.wrap)));
  if (existing >= 0) { sel.selectByIndex(existing); return sel.selections[existing]; }
  const target = el.querySelector('path,rect,polygon,polyline,circle,ellipse,text,image') || el;
  const before = (sel.selections || []).length;
  target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  if ((sel.selections || []).length > before) return sel.getActive();
  return sel.getActive() || null;    // a click that reused a region still gives an active one
}

window.MotionAutoLabel = { matchSwatchesToLayers, collectLayers, normBox, snapshot,
                           label, apply, selectLayer, LABEL_CONF_MIN };

})();
