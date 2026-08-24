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

    this._svgClickHandler = null;
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
      let wrap = e.target.closest('.ms-wrap');
      // Exported posters often put EVERYTHING in one layer group — wrapping
      // that gives a single selection covering the whole artwork, which reads
      // as "selection is broken". If the hit wrap covers most of the canvas,
      // drill down to the actual clicked unit instead.
      if (wrap && this._coverage(wrap, svg) > 0.7 && e.target !== wrap) {
        const unit = this._bestUnitFor(e.target, wrap, svg);
        if (unit && this._coverage(unit, svg) < 0.7) wrap = this._wrapOne(unit);
      }
      // LAZY FALLBACK: pre-wrapping can miss elements in arbitrary uploaded
      // SVGs (odd nesting, no ids). Wrap the clicked unit on the fly.
      if (!wrap && e.target !== svg && this._isDrawable(e.target)) {
        const unit = this._bestUnitFor(e.target, svg, svg);
        if (unit) wrap = this._wrapOne(unit);
      }
      if (!wrap) return;
      const existing = this.selections.findIndex(s => s.wrap === wrap);
      if (existing >= 0) { this.selectByIndex(existing); return; }
      this._createSVGSelection(wrap);
    };
    svg.addEventListener('click', this._svgClickHandler);
    this._svg = svg;
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
      // cloth-like names default to wave (geometry) deformation
      waveMode: /flag|banner|cloth|pennant|curtain|sail/i.test(name),
    };
    this.selections.push(sel);
    this.activeIdx = this.selections.length - 1;
    this._renderSVGHighlights();
    if (this.onCreated) this.onCreated(sel, this.activeIdx);
  }

  // dashed highlight rects drawn INSIDE the svg so they move with animation
  _renderSVGHighlights() {
    if (!this._svg) return;
    // remove old highlight layer
    let hl = this._svg.querySelector('#ms-highlights');
    if (hl) hl.remove();
    if (this.highlightsHidden) return;   // no outlines while playing
    hl = document.createElementNS(SVGNS, 'g');
    hl.setAttribute('id', 'ms-highlights');
    hl.setAttribute('pointer-events', 'none');
    this._svg.appendChild(hl);

    this.selections.forEach((s, i) => {
      if (s.kind !== 'svg') return;
      const bb = s.wrap.getBBox();
      const rect = document.createElementNS(SVGNS, 'rect');
      rect.setAttribute('x', bb.x - 4); rect.setAttribute('y', bb.y - 4);
      rect.setAttribute('width', bb.width + 8); rect.setAttribute('height', bb.height + 8);
      rect.setAttribute('fill', 'none');
      rect.setAttribute('stroke', s.color);
      rect.setAttribute('stroke-width', i === this.activeIdx ? 2.5 : 1.5);
      rect.setAttribute('stroke-dasharray', i === this.activeIdx ? '8 4' : '4 4');
      rect.setAttribute('opacity', i === this.activeIdx ? 1 : 0.55);
      // move the highlight along with its target wrap
      const tr = s.wrap.getAttribute('transform');
      if (tr) rect.setAttribute('transform', tr);
      hl.appendChild(rect);

      const label = document.createElementNS(SVGNS, 'text');
      label.setAttribute('x', bb.x); label.setAttribute('y', bb.y - 8);
      label.setAttribute('fill', s.color);
      label.setAttribute('font-size', '12');
      label.setAttribute('font-family', 'sans-serif');
      label.setAttribute('opacity', i === this.activeIdx ? 1 : 0.7);
      if (tr) label.setAttribute('transform', tr);
      label.textContent = s.name + (s.motionId ? ' ✓' : '');
      hl.appendChild(label);
    });
  }

  // keep highlight rects glued to moving wraps (called each animation frame)
  syncHighlights() {
    if (this.mode !== 'svg' || !this._svg) return;
    const hl = this._svg.querySelector('#ms-highlights');
    if (!hl) return;
    const kids = hl.children;
    let k = 0;
    for (let i = 0; i < this.selections.length; i++) {
      const s = this.selections[i];
      if (s.kind !== 'svg') continue;
      const tr = s.wrap.getAttribute('transform') || '';
      if (kids[k]) kids[k].setAttribute('transform', tr);       // rect
      if (kids[k + 1]) kids[k + 1].setAttribute('transform', tr); // label
      k += 2;
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
