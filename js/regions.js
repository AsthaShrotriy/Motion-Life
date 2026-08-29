/*
 * regions.js — SelectionManager.
 *
 * Two selection modes:
 *   SVG mode    → CLICK an element to select it. We wrap every selectable
 *                 unit in a <g class="ms-wrap"> so the animator has a clean
 *                 transform target (setting a CSS transform directly on a
 *                 group that already has a transform="" attribute conflicts;
 *                 an empty wrapper does not).
 *   Raster mode → DRAW a rectangle (can't click into a flat bitmap). The
 *                 region's pixels are cloned into a floating layer that the
 *                 animator transforms.
 *
 * A selection = {
 *   id, name, color, kind:'svg'|'rect',
 *   wrap        (svg mode: the <g class="ms-wrap"> we animate),
 *   center      (svg mode: [cx,cy] in viewBox units, for rotation origin),
 *   floatEl     (raster mode: the floating clone we animate),
 *   bounds      (raster mode: {x,y,w,h} in displayed px),
 *   motionId, speed, intensity
 * }
 */

const REGION_COLORS = ['#6e5cff', '#ff5c8a', '#3ddc84', '#ffd93d', '#4cc9ff', '#ff8a4c', '#b84cff', '#5cffd6'];
const SVGNS = 'http://www.w3.org/2000/svg';

/* (Step 10) SURVIVING HARDCODING, GATED AND LABELLED.
 *
 * `waveMode` decides whether a region's geometry is bent (a flag has to ripple) or the
 * region is moved as a rigid whole. This regex is a guess from the layer NAME — a claim
 * about a string an illustrator typed, not about the artwork — so it is now the LAST
 * resort, and every selection records which evidence decided it. Strongest first, which
 * is the order the writers actually run in (js/main.js applyMotionToActive, then
 * runAutoLabel, and deformDefault below for a region with no motion yet):
 *
 *   preset_leaffall  the autumn-fall PRESET is rigid by construction (js/motions.js)
 *   artwork_rigid    the artwork itself marks the object data-motion-mode="rigid"
 *   motion_field     a captured motion with a real trajectory field arrived — a MEASURED
 *                    displacement per point, so it outranks a still-image reading
 *   vlm:<class>      the VLM looked at the layer (Contract D, js/autolabel.js)
 *   name_hint        this regex matched                                      <- a guess
 *   default          nothing matched; rigid
 *
 * `motion_field` above `vlm:<class>` is deliberate and is enforced in two places:
 * applyMotionToActive writes it after MotionAutoLabel.apply has written the label, and
 * runAutoLabel refuses to overwrite it when labels arrive later. The label still decides
 * WHICH object the swatch lands on and what the region is called — only the deform mode
 * defers to the measurement.
 *
 * It is kept rather than deleted because it is the only answer available with the router
 * offline, and a flag that does not ripple is a worse failure than an honest guess. It is
 * never consulted when a label exists: MotionAutoLabel.apply overwrites both fields.
 */
const CLOTH_NAME_HINT = /flag|banner|cloth|pennant|curtain|sail/i;

function deformDefault(wrap, name) {
  const store = window.__mlLayerLabels;      // set by main.js after a /label pass
  const lab = (wrap && store && store.byEl) ? findLabel(store.byEl, wrap) : null;
  if (lab) {
    // the VLM read the picture; the file's layer name is the thing it was told to
    // distrust, so its label wins for the display name too.
    return { name: lab.label || name, waveMode: lab.deforms === 'mesh',
             waveModeFrom: `vlm:${lab.motion_class || 'static'}`, layerLabel: lab };
  }
  if (CLOTH_NAME_HINT.test(name)) return { waveMode: true, waveModeFrom: 'name_hint' };
  return { waveMode: false, waveModeFrom: 'default' };
}

// a label is attached to a LAYER GROUP; the selection wraps some descendant of it, so
// match either direction rather than requiring the exact same node.
function findLabel(byEl, wrap) {
  for (const [el, lab] of byEl) {
    if (el === wrap || el.contains(wrap) || wrap.contains(el)) return lab;
  }
  return null;
}

class SelectionManager {
  constructor(overlay, artworkContainer) {
    this.overlay = overlay;
    this.ctx = overlay.getContext('2d');
    this.container = artworkContainer;
    this.selections = [];
    this.activeIdx = -1;
    this.mode = 'svg';           // 'svg' | 'raster'
    this.tool = 'rect';          // raster only

    this.drawing = false;
    this.startX = 0; this.startY = 0;

    this.onCreated = null;
    this.onSelected = null;
    this.onHoverChange = null;   // (wrap|null) — fires on hover AND drag-over
    this.onDropOnWrap = null;    // (wrap|null, event) — a motion preset was dropped

    this._svgClickHandler = null;
    this._svgMoveHandler = null;
    this._svgLeaveHandler = null;
    this._svgDragOverHandler = null;
    this._svgDropHandler = null;
    this.hoveredWrap = null;
    this.highlightsHidden = false;   // hide selection outlines during playback
    this._initRasterEvents();
  }

  // hide/show all selection outlines (used while animation is playing)
  setHighlightsHidden(v) {
    this.highlightsHidden = v;
    if (this.mode === 'svg') this._renderSVGHighlights(); else this.redraw();
  }

  // ---- called by main whenever artwork changes ----
  attachSVG(svg) {
    this.mode = 'svg';
    this._clearAll();
    this.overlay.style.pointerEvents = 'none';   // let clicks reach the SVG
    this._wrapSelectableUnits(svg);
    // one delegated click handler on the svg
    if (this._svgClickHandler) svg.removeEventListener('click', this._svgClickHandler);
    this._svgClickHandler = (e) => {
      const wrap = this.resolveWrapForTarget(e.target);
      if (!wrap) { this.deselect(); return; }
      const existing = this.selections.findIndex(s => s.wrap === wrap);
      if (existing >= 0) { this.selectByIndex(existing); return; }
      this._createSVGSelection(wrap);
    };
    svg.addEventListener('click', this._svgClickHandler);

    // hover: highlight whatever selectable unit is under the cursor, live
    if (this._svgMoveHandler) svg.removeEventListener('mousemove', this._svgMoveHandler);
    if (this._svgLeaveHandler) svg.removeEventListener('mouseleave', this._svgLeaveHandler);
    this._svgMoveHandler = (e) => {
      const wrap = this.resolveWrapForTarget(e.target);
      if (wrap === this.hoveredWrap) return;
      this.hoveredWrap = wrap;
      this._renderSVGHighlights();
      if (this.onHoverChange) this.onHoverChange(wrap);
    };
    this._svgLeaveHandler = () => {
      if (!this.hoveredWrap) return;
      this.hoveredWrap = null;
      this._renderSVGHighlights();
      if (this.onHoverChange) this.onHoverChange(null);
    };
    svg.addEventListener('mousemove', this._svgMoveHandler);
    svg.addEventListener('mouseleave', this._svgLeaveHandler);

    // motion-preset drag-and-drop: dragover must preventDefault() for the
    // browser to allow a drop; otherwise this is the same hover hit-test.
    if (this._svgDragOverHandler) svg.removeEventListener('dragover', this._svgDragOverHandler);
    if (this._svgDropHandler) svg.removeEventListener('drop', this._svgDropHandler);
    this._svgDragOverHandler = (e) => { e.preventDefault(); this._svgMoveHandler(e); };
    this._svgDropHandler = (e) => {
      e.preventDefault();
      const wrap = this.resolveWrapForTarget(e.target);
      this.hoveredWrap = null;
      if (this.onDropOnWrap) this.onDropOnWrap(wrap, e);
    };
    svg.addEventListener('dragover', this._svgDragOverHandler);
    svg.addEventListener('dragleave', this._svgLeaveHandler);
    svg.addEventListener('drop', this._svgDropHandler);
    this._svg = svg;
  }

  /*
   * Resolve the selectable .ms-wrap for an arbitrary event target — shared
   * by click, hover, and drag-over hit-testing so all three agree on what
   * "the object under the cursor" means.
   */
  resolveWrapForTarget(target) {
    const svg = this._svg;
    if (!svg) return null;
    let wrap = target.closest ? target.closest('.ms-wrap') : null;
    // Exported posters often put EVERYTHING in one layer group — wrapping
    // that gives a single selection covering the whole artwork, which reads
    // as "selection is broken". If the hit wrap covers most of the canvas,
    // drill down to the actual target unit instead.
    if (wrap && this._coverage(wrap, svg) > 0.7 && target !== wrap) {
      const unit = this._bestUnitFor(target, wrap, svg);
      if (unit && this._coverage(unit, svg) < 0.7) wrap = this._wrapOne(unit);
    }
    // LAZY FALLBACK: pre-wrapping can miss elements in arbitrary uploaded
    // SVGs (odd nesting, no ids). Wrap the target unit on the fly.
    if (!wrap && target !== svg && this._isDrawable(target)) {
      const unit = this._bestUnitFor(target, svg, svg);
      if (unit) wrap = this._wrapOne(unit);
    }
    return wrap;
  }

  attachRaster() {
    this.mode = 'raster';
    this._clearAll();
    this.overlay.style.pointerEvents = 'auto';
    this.overlay.classList.add('drawing');
    this._svg = null;
  }

  _clearAll() {
    // remove any floating raster clones
    for (const s of this.selections) if (s.floatEl) s.floatEl.remove();
    this.selections = [];
    this.activeIdx = -1;
    this.redraw();
  }

  // ---- wrap each selectable unit so we have a stable animate target ----
  _wrapSelectableUnits(svg) {
    let units = [...svg.querySelectorAll('.layer[data-name]')];
    if (units.length === 0) {
      // uploaded SVG: prefer LEAF-named elements — ids with no named
      // descendants. This skips editor layer containers (Illustrator's
      // Layer_1 etc.) and lands on the semantic objects inside them.
      const named = [...svg.querySelectorAll('[id]')].filter(el => this._isDrawable(el));
      units = named.filter(el => !el.querySelector('[id]'));
      if (units.length === 0) units = named;
      if (units.length === 0) {
        // no ids anywhere (common Illustrator export): the SVG's top-level
        // drawable children ARE the semantic clusters — wrap those. If the
        // root has one giant wrapper group, descend into it first.
        let root = svg;
        let kids = [...root.children].filter(el => this._isDrawable(el));
        while (kids.length === 1 && kids[0].tagName.toLowerCase() === 'g') {
          root = kids[0];
          kids = [...root.children].filter(el => this._isDrawable(el));
        }
        units = kids;
      }
    }
    let n = 0;
    for (const el of units) {
      if (el.closest('.ms-wrap')) continue;         // already wrapped/nested
      const name = el.getAttribute('data-name') || el.id || ('element ' + (++n));
      const wrap = document.createElementNS(SVGNS, 'g');
      wrap.setAttribute('class', 'ms-wrap');
      wrap.setAttribute('data-ms-name', name);
      el.parentNode.insertBefore(wrap, el);
      wrap.appendChild(el);
    }
  }

  _isDrawable(el) {
    const t = el.tagName ? el.tagName.toLowerCase() : '';
    return ['g', 'path', 'rect', 'circle', 'ellipse', 'polygon', 'polyline', 'line', 'image', 'text', 'use', 'tspan'].includes(t);
  }

  /* fraction of the SVG canvas an element's bbox covers (0..1) */
  _coverage(el, svg) {
    try {
      const bb = el.getBBox();
      const vb = svg.viewBox.baseVal;
      const area = (vb.width || 800) * (vb.height || 500);
      return area ? (bb.width * bb.height) / area : 1;
    } catch { return 1; }
  }

  /*
   * Pick the best selectable unit for a clicked element: walk UP from the
   * target toward `stop`, preferring the outermost ancestor group that still
   * covers < 50% of the canvas (a semantic cluster like "banner"), falling
   * back to the clicked element itself.
   */
  _bestUnitFor(target, stop, svg) {
    let el = target.tagName && target.tagName.toLowerCase() === 'tspan' ? target.parentNode : target;
    if (!this._isDrawable(el)) return null;
    let best = el;
    let cur = el.parentNode;
    while (cur && cur !== stop && cur !== svg && cur.tagName) {
      if (cur.tagName.toLowerCase() === 'g' && !cur.classList.contains('ms-wrap')) {
        if (this._coverage(cur, svg) < 0.5) best = cur;
        else break;
      }
      cur = cur.parentNode;
    }
    return best;
  }

  /* wrap a single element in an .ms-wrap on demand; reuse if already wrapped */
  _wrapOne(el) {
    if (el.closest('.ms-wrap')) {
      const w = el.closest('.ms-wrap');
      // if the existing wrap is the huge layer wrap, still make a tighter one
      if (w.contains(el) && w !== el && this._svg && this._coverage(w, this._svg) > 0.7) {
        const wrap = document.createElementNS(SVGNS, 'g');
        wrap.setAttribute('class', 'ms-wrap');
        wrap.setAttribute('data-ms-name', el.id || el.getAttribute('data-name')
          || (el.tagName.toLowerCase() === 'text' ? 'text' : 'element') + ' ' + (this._svg.querySelectorAll('.ms-wrap').length + 1));
        el.parentNode.insertBefore(wrap, el);
        wrap.appendChild(el);
        return wrap;
      }
      return w;
    }
    const wrap = document.createElementNS(SVGNS, 'g');
    wrap.setAttribute('class', 'ms-wrap');
    const n = this._svg ? this._svg.querySelectorAll('.ms-wrap').length + 1 : 1;
    wrap.setAttribute('data-ms-name', el.id || el.getAttribute('data-name')
      || (el.tagName.toLowerCase() === 'text' ? 'text' : 'element') + ' ' + n);
    el.parentNode.insertBefore(wrap, el);
    wrap.appendChild(el);
    return wrap;
  }

  // ---- SVG selection ----
  _createSVGSelection(wrap) {
    const name = wrap.getAttribute('data-ms-name') || 'element';
    // bbox in the wrap's own coordinate space (wrap has no transform yet)
    const bb = wrap.getBBox();
    const sel = {
      id: 'sel-' + Date.now() + '-' + Math.round(bb.x),
      name,
      color: REGION_COLORS[this.selections.length % REGION_COLORS.length],
      kind: 'svg',
      wrap,
      center: [bb.x + bb.width / 2, bb.y + bb.height / 2],
      motionId: null, speed: 1.0, intensity: 1.0,
      ...deformDefault(wrap, name),
    };
    this.selections.push(sel);
    this.activeIdx = this.selections.length - 1;
    this._renderSVGHighlights();
    if (this.onCreated) this.onCreated(sel, this.activeIdx);
  }

  // dashed highlight rect drawn INSIDE the svg so it moves with animation.
  // Only the ACTIVE selection and the currently HOVERED unit get a highlight —
  // not every selection ever made — so the canvas doesn't stay cluttered.
  _renderSVGHighlights() {
    if (!this._svg) return;
    // remove old highlight layer
    let hl = this._svg.querySelector('#ms-highlights');
    if (hl) hl.remove();
    // highlightsHidden only suppresses the persistent ACTIVE-selection outline
    // during playback so it doesn't clutter a moving object — hover feedback
    // should still work regardless, since it's a deliberate momentary action.
    if (this.highlightsHidden && !this.hoveredWrap) return;
    hl = document.createElementNS(SVGNS, 'g');
    hl.setAttribute('id', 'ms-highlights');
    hl.setAttribute('pointer-events', 'none');
    this._svg.appendChild(hl);

    const hatchTags = new Set(['path', 'rect', 'circle', 'ellipse', 'polygon', 'polyline', 'text', 'tspan']);

    const drawOutline = (wrap, color, { active, label: labelText, forWrap }) => {
      const bb = wrap.getBBox();
      const tr = wrap.getAttribute('transform');

      // diagonal zig-zag hatch pattern, unique per highlighted object.
      // Each zig-zag line is drawn twice — a wider white halo underneath,
      // then the region's own color on top — so it stays legible no matter
      // what color the artwork underneath happens to be (a yellow or white
      // region color would otherwise vanish against similarly-toned art).
      const patternId = 'ms-zigzag-' + forWrap;
      let pattern = hl.querySelector('#' + patternId);
      if (pattern) pattern.remove();
      pattern = document.createElementNS(SVGNS, 'pattern');
      pattern.setAttribute('id', patternId);
      pattern.setAttribute('patternUnits', 'userSpaceOnUse');
      const step = active ? 10 : 8;
      pattern.setAttribute('width', step);
      pattern.setAttribute('height', step);
      pattern.setAttribute('patternTransform', 'rotate(45)');
      const zigD = `M0,${step / 4} L${step / 2},0 L${step},${step / 4} M0,${step * 3 / 4} L${step / 2},${step / 2} L${step},${step * 3 / 4}`;
      const zigHalo = document.createElementNS(SVGNS, 'path');
      zigHalo.setAttribute('d', zigD);
      zigHalo.setAttribute('fill', 'none');
      zigHalo.setAttribute('stroke', '#ffffff');
      zigHalo.setAttribute('stroke-width', active ? 3.5 : 3);
      zigHalo.setAttribute('opacity', active ? 0.85 : 0.65);
      pattern.appendChild(zigHalo);
      const zig = document.createElementNS(SVGNS, 'path');
      zig.setAttribute('d', zigD);
      zig.setAttribute('fill', 'none');
      zig.setAttribute('stroke', color);
      zig.setAttribute('stroke-width', active ? 1.75 : 1.25);
      zig.setAttribute('opacity', active ? 1 : 0.8);
      pattern.appendChild(zig);
      hl.appendChild(pattern);

      // hatch fill clipped to the object's own silhouette — clone the real
      // shape(s) and paint them with the pattern directly (not a bbox rect),
      // so the highlight hugs the exact outline instead of a bounding box.
      // Inline style beats any CSS class the uploaded SVG defines its fill
      // with (e.g. Illustrator exports use <style>.cls-1{fill:...}</style>),
      // which a plain `fill` attribute would lose to.
      const hatch = wrap.cloneNode(true);
      hatch.removeAttribute('id');
      hatch.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
      hatch.setAttribute('data-ms-hatch-for', forWrap);
      const hatchShape = (el) => {
        el.removeAttribute('class');
        el.removeAttribute('stroke');
        el.style.fill = `url(#${patternId})`;
      };
      if (hatchTags.has(hatch.tagName.toLowerCase())) hatchShape(hatch);
      hatch.querySelectorAll('*').forEach(el => {
        if (hatchTags.has(el.tagName.toLowerCase())) hatchShape(el);
      });
      hatch.querySelectorAll('image').forEach(img => {
        const rect = document.createElementNS(SVGNS, 'rect');
        rect.setAttribute('x', img.getAttribute('x') || 0);
        rect.setAttribute('y', img.getAttribute('y') || 0);
        rect.setAttribute('width', img.getAttribute('width') || 0);
        rect.setAttribute('height', img.getAttribute('height') || 0);
        hatchShape(rect);
        img.replaceWith(rect);
      });
      if (tr) hatch.setAttribute('transform', tr);
      hl.appendChild(hatch);

      // thin outline tracing the exact silhouette on top, for definition —
      // a wider white halo copy first, then the region's color on top
      const makeOutline = (haloPass) => {
        const el = wrap.cloneNode(true);
        el.removeAttribute('id');
        el.querySelectorAll('[id]').forEach(n => n.removeAttribute('id'));
        if (!haloPass) el.setAttribute('data-ms-outline-for', forWrap);
        const shape = (n) => {
          n.removeAttribute('class');
          n.style.fill = 'none';
          n.style.stroke = haloPass ? '#ffffff' : color;
          n.style.strokeOpacity = haloPass ? (active ? 0.85 : 0.65) : (active ? 1 : 0.85);
          n.style.strokeWidth = haloPass ? (active ? 3.5 : 3) : (active ? 1.5 : 1.1);
        };
        shape(el);
        el.querySelectorAll('*').forEach(shape);
        if (tr) el.setAttribute('transform', tr);
        return el;
      };
      hl.appendChild(makeOutline(true));
      hl.appendChild(makeOutline(false));

      if (labelText) {
        const label = document.createElementNS(SVGNS, 'text');
        label.setAttribute('x', bb.x); label.setAttribute('y', bb.y - 8);
        label.setAttribute('fill', color);
        label.setAttribute('font-size', '12');
        label.setAttribute('font-family', 'sans-serif');
        label.setAttribute('data-ms-label-for', forWrap);
        label.style.paintOrder = 'stroke';
        label.style.stroke = '#ffffff';
        label.style.strokeWidth = '3px';
        label.style.strokeLinejoin = 'round';
        if (tr) label.setAttribute('transform', tr);
        label.textContent = labelText;
        hl.appendChild(label);
      }
    };

    const active = this.getActive();
    if (active && active.kind === 'svg' && !this.highlightsHidden) {
      drawOutline(active.wrap, active.color, {
        active: true,
        label: active.name + (active.motionId ? ' ✓' : ''),
        forWrap: 'active',
      });
    }

    if (this.hoveredWrap && this.hoveredWrap !== (active && active.wrap)) {
      const existing = this.selections.find(s => s.wrap === this.hoveredWrap);
      const color = existing ? existing.color : '#2b2b3d';
      drawOutline(this.hoveredWrap, color, {
        active: false,
        label: existing ? existing.name + (existing.motionId ? ' ✓' : '') : (this.hoveredWrap.getAttribute('data-ms-name') || ''),
        forWrap: 'hover',
      });
    }
  }

  // keep the highlight glued to the moving wrap (called each animation frame)
  syncHighlights() {
    if (this.mode !== 'svg' || !this._svg) return;
    const hl = this._svg.querySelector('#ms-highlights');
    if (!hl) return;
    const active = this.getActive();
    if (active && active.kind === 'svg') {
      const tr = active.wrap.getAttribute('transform') || '';
      const hatch = hl.querySelector('[data-ms-hatch-for="active"]');
      const outline = hl.querySelector('[data-ms-outline-for="active"]');
      const label = hl.querySelector('[data-ms-label-for="active"]');
      if (hatch) hatch.setAttribute('transform', tr);
      if (outline) outline.setAttribute('transform', tr);
      if (label) label.setAttribute('transform', tr);
    }
  }

  // ---- Raster (rectangle) selection ----
  _initRasterEvents() {
    this.overlay.addEventListener('mousedown', e => this._onDown(e));
    this.overlay.addEventListener('mousemove', e => this._onMove(e));
    this.overlay.addEventListener('mouseup', e => this._onUp(e));
  }
  setTool(t) { this.tool = t; }

  _scale() {
    const rect = this.overlay.getBoundingClientRect();
    return { sx: this.overlay.width / rect.width, sy: this.overlay.height / rect.height, rect };
  }

  _onDown(e) {
    if (this.mode !== 'raster') return;
    const { sx, sy, rect } = this._scale();
    this.startX = (e.clientX - rect.left) * sx;
    this.startY = (e.clientY - rect.top) * sy;
    this.drawing = true;
  }
  _onMove(e) {
    if (!this.drawing) return;
    const { sx, sy, rect } = this._scale();
    const x = (e.clientX - rect.left) * sx, y = (e.clientY - rect.top) * sy;
    this.redraw();
    this.ctx.save();
    this.ctx.strokeStyle = '#6e5cff'; this.ctx.lineWidth = 2; this.ctx.setLineDash([6, 4]);
    this.ctx.strokeRect(this.startX, this.startY, x - this.startX, y - this.startY);
    this.ctx.restore();
  }
  _onUp(e) {
    if (!this.drawing) return;
    this.drawing = false;
    const { sx, sy, rect } = this._scale();
    const ex = (e.clientX - rect.left) * sx, ey = (e.clientY - rect.top) * sy;
    const x = Math.min(this.startX, ex), y = Math.min(this.startY, ey);
    const w = Math.abs(ex - this.startX), h = Math.abs(ey - this.startY);
    if (w < 12 || h < 12) { this.redraw(); return; }

    const name = prompt('Name this region:', 'Region ' + (this.selections.length + 1));
    if (!name) { this.redraw(); return; }
    this._createRasterSelection(name, { x, y, w, h });
  }

  _createRasterSelection(name, bounds) {
    // clone the underlying image region into a floating, absolutely-positioned layer
    const img = this.container.querySelector('img');
    const cw = this.overlay.width, ch = this.overlay.height;      // = displayed px basis
    const floatEl = document.createElement('div');
    floatEl.style.position = 'absolute';
    floatEl.style.left = (bounds.x / cw * 100) + '%';
    floatEl.style.top = (bounds.y / ch * 100) + '%';
    floatEl.style.width = (bounds.w / cw * 100) + '%';
    floatEl.style.height = (bounds.h / ch * 100) + '%';
    floatEl.style.overflow = 'hidden';
    floatEl.style.pointerEvents = 'none';
    floatEl.style.zIndex = '5';
    if (img) {
      const inner = document.createElement('div');
      inner.style.position = 'absolute';
      inner.style.width = (cw / bounds.w * 100) + '%';
      inner.style.height = (ch / bounds.h * 100) + '%';
      inner.style.left = (-bounds.x / bounds.w * 100) + '%';
      inner.style.top = (-bounds.y / bounds.h * 100) + '%';
      inner.style.backgroundImage = `url(${img.src})`;
      inner.style.backgroundSize = '100% 100%';
      floatEl.appendChild(inner);
    }
    this.container.appendChild(floatEl);

    const sel = {
      id: 'sel-' + Date.now(),
      name,
      color: REGION_COLORS[this.selections.length % REGION_COLORS.length],
      kind: 'rect',
      floatEl, bounds,
      motionId: null, speed: 1.0, intensity: 1.0,
    };
    this.selections.push(sel);
    this.activeIdx = this.selections.length - 1;
    this.redraw();
    if (this.onCreated) this.onCreated(sel, this.activeIdx);
  }

  // ---- shared ----
  selectByIndex(idx) {
    this.activeIdx = idx;
    if (this.mode === 'svg') this._renderSVGHighlights(); else this.redraw();
    if (this.onSelected) this.onSelected(this.selections[idx], idx);
  }
  getActive() { return this.activeIdx >= 0 ? this.selections[this.activeIdx] : null; }

  // clear the active selection — clicking empty canvas or pressing Escape
  deselect() {
    if (this.activeIdx === -1) return;
    this.activeIdx = -1;
    if (this.mode === 'svg') this._renderSVGHighlights(); else this.redraw();
    if (this.onSelected) this.onSelected(null, -1);
  }

  deleteActive() {
    const s = this.getActive();
    if (!s) return;
    if (s.floatEl) s.floatEl.remove();
    if (s.wrap) s.wrap.setAttribute('transform', '');   // reset any motion
    this.selections.splice(this.activeIdx, 1);
    this.activeIdx = Math.min(this.activeIdx, this.selections.length - 1);
    if (this.mode === 'svg') this._renderSVGHighlights(); else this.redraw();
  }

  resize(w, h) { this.overlay.width = w; this.overlay.height = h; this.redraw(); }

  redraw() {
    // raster-mode highlights are on the canvas overlay
    const { width: W, height: H } = this.overlay;
    this.ctx.clearRect(0, 0, W, H);
    if (this.mode !== 'raster' || this.highlightsHidden) return;
    this.selections.forEach((s, i) => {
      if (s.kind !== 'rect') return;
      const b = s.bounds, active = i === this.activeIdx;
      this.ctx.save();
      this.ctx.strokeStyle = s.color;
      this.ctx.lineWidth = active ? 2.5 : 1.5;
      this.ctx.setLineDash(active ? [8, 4] : [4, 4]);
      this.ctx.globalAlpha = active ? 1 : 0.6;
      this.ctx.strokeRect(b.x, b.y, b.w, b.h);
      this.ctx.setLineDash([]);
      this.ctx.font = '11px sans-serif';
      this.ctx.fillStyle = s.color;
      this.ctx.fillText(s.name + (s.motionId ? ' ✓' : ''), b.x + 3, b.y - 4);
      this.ctx.restore();
    });
  }
}

window.SelectionManager = SelectionManager;
window.REGION_COLORS = REGION_COLORS;
