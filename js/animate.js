/*
 * animate.js — per-selection displacement engine.
 *
 * For each selection with a motion assigned, compute a parametric
 * displacement (dx, dy, rotation) each frame and apply it:
 *   - SVG selection   → set the wrapper <g>'s transform ATTRIBUTE
 *                       (verified: setting CSS transform on a group that
 *                        already has a transform="" attr conflicts; the
 *                        empty wrapper's attribute does not).
 *   - Raster selection → set the floating clone's CSS transform.
 */

/*
 * ---- Step 8: class → applicator ----
 * Which applicator can drive a swatch is decided ONCE, server-side, by
 * contracts.swatch_applicator(kind, class) and stamped into the swatch as
 * `applicator` — so the taxonomy lives in exactly one file and the two axes
 * (what the motion IS vs. what shape of data the swatch CARRIES) stay resolved
 * together. This table is only the fallback for a motion that carries a router
 * `class` but no swatch, and it must mirror MOTION_CLASSES in contracts.py.
 */
const APPLICATOR_BY_CLASS = {
  articulated: 'skeletal',
  cloth: 'wave',
  fluid: 'flow_field',
  flock: 'flock_drift',
  rigid_path: 'path_travel',
  oscillation: 'oscillate',
};

class Animator {
  constructor(selectionManager, motionLibrary) {
    this.sel = selectionManager;
    this.motions = motionLibrary;
    this.playing = false;
    this.t0 = performance.now() / 1000;
    this._raf = null;
    this.previewWrap = null;   // set while a motion-preset drag is previewing on this wrap
  }

  play() { this.playing = true; this.t0 = performance.now() / 1000; this._tick(); }
  pause() { this.playing = false; if (this._raf) cancelAnimationFrame(this._raf); this._reset(); }
  toggle() { this.playing ? this.pause() : this.play(); return this.playing; }

  _tick() {
    if (!this.playing) return;
    this._raf = requestAnimationFrame(() => this._tick());
    const t = performance.now() / 1000 - this.t0;
    this._applyAll(t);
    this.sel.syncHighlights();
  }

  _applyAll(t) {
    for (const s of this.sel.selections) {
      if (!s.motionId) continue;
      if (this.previewWrap && s.wrap === this.previewWrap) continue;   // a drag preview owns this wrap's transform right now
      const motion = this.motions.getById(s.motionId);
      if (!motion) continue;

      // One selection's special-case animator throwing (bad/unexpected
      // geometry, a missing child element, etc.) used to kill this whole
      // per-frame loop silently — every OTHER animating object on the canvas
      // would freeze too, forever, with no visible error. Isolate failures
      // per-object instead.
      try {
        this._applyOne(s, motion, t);
      } catch (err) {
        console.error(`Motion "${motion.name}" on "${s.name}" failed to animate:`, err);
        s.motionId = null;   // stop retrying every frame; object goes static, not the whole scene
      }
    }
  }

  _applyOne(s, motion, t) {
    const speed = s.speed || 1, intensity = s.intensity || 1;
    const rt = t * speed;
    const seed = s.kind === 'svg'
      ? (s.center[0] * 0.01 + s.center[1] * 0.03)
      : (s.bounds.x * 0.01 + s.bounds.y * 0.03);

    // ---- character / skeletal motion: a pose-sequence swatch drives a rig ----
    if (s.kind === 'svg' && this._poseFor(motion) &&
        s.wrap.querySelector('[data-motion-mode="character"], [data-role="body"]')) {
      this._applyCharacter(s, motion, rt, intensity);
      return;
    }

    // Keep dense canopy artwork intact; only sway its selectable overlay.
    if (s.kind === 'svg' && s.wrap.querySelector('[data-motion-role="tree-canopy"]')) {
      this._applyTreeLeaves(s, motion, rt, intensity);
      return;
    }

    // ---- REAL extracted travel path (Step 5) — beats the curated behaviours ----
    // motion.path exists ONLY when the service actually tracked one object across
    // the clip (?path=1 -> yolo_bytetrack -> objpath.build_path). Measured motion is
    // the point of this tool, so it takes precedence over the name-keyed curation
    // below, which stays as the fallback for presets and untracked clips.
    if (s.kind === 'svg' && this._pathFor(motion)) {
      this._applyPathTravel(s, motion, rt, intensity);
      return;
    }

    // ---- (Step 8) CLASS-KEYED APPLICATION ----
    // The applicator is chosen by what the motion IS, never by what the layer is
    // CALLED: rename "Birds" to "Layer 7" and a flock swatch still drifts it as a
    // flock; drop a cloth swatch on that same group and it ripples instead.
    // _applicatorFor returns '' only for a motion nothing classified (the built-in
    // presets, and the in-browser Lucas-Kanade fallback) — and only then do the
    // name-keyed curated behaviours below get a turn.
    const app = this._applicatorFor(motion);
    if (s.kind === 'svg' && app && this._applyByClass(s, motion, app, rt, intensity)) return;

    // ---- realistic falling leaves: each child leaf falls independently ----
    if (s.kind === 'svg' && motion.params && motion.params.leafFall) {
      this._applyLeafFall(s, motion, rt, intensity);
      return;
    }

    // ---- curated scenery behaviours, keyed on the object's NAME ----
    // FALLBACK ONLY (Step 8): these run for the built-in presets, which carry no
    // class and no captured field, so there is nothing real to prefer over them.
    // A classified swatch never reaches here — real extracted motion always wins,
    // even when the curated version would look nicer.
    if (s.kind === 'svg' && !app) {
      if (/\bbirds?\b/i.test(s.name)) { this._applyBirds(s, motion, rt, intensity); return; }
      if (/\bclouds?\b/i.test(s.name)) { this._applyClouds(s, motion, rt, intensity); return; }
      if (/\briver|ripples?\b/i.test(s.name)) { this._applyRiver(s, motion, rt, intensity); return; }
      if (/\bboat|rowboat|canoe|ferry|ship\b/i.test(s.name)) {
        this._applyBoat(s, motion, rt, intensity); return;
      }
    }

    // ---- per-glyph text animation: letters ride the motion individually ----
    if (s.kind === 'svg' && s.wrap.querySelector('text')) {
      if (s._text === undefined) s._text = buildTextData(s.wrap);
      if (s._text) {
        if (s._field === undefined || s._fieldMotion !== motion.id) {
          s._field = buildTrajField(motion) || null;
          s._fieldMotion = motion.id;
        }
        for (const it of s._text.items) {
          it.el.setAttribute('transform',
            glyphTransform(s._text, it, s._field, motion.params, rt, intensity));
        }
        s.wrap.setAttribute('transform', '');
        return;
      }
    }

    // ---- wave (cloth) mode: deform the geometry itself ----
    // Same applicator the `cloth` class dispatches to. Reached when the artwork is
    // deformable but the motion carries no class (a preset, or a pre-Step-7 swatch).
    if (s.kind === 'svg' && s.waveMode && this._applyCloth(s, motion, rt, intensity)) return;

    const { dx, dy, rot } = computeMotion(motion.params, seed, rt, intensity);

    if (s.kind === 'svg') {
      // rotate around the element's own center for a natural sway
      const [cx, cy] = s.center;
      s.wrap.setAttribute('transform',
        `translate(${dx.toFixed(2)} ${dy.toFixed(2)}) rotate(${rot.toFixed(3)} ${cx.toFixed(1)} ${cy.toFixed(1)})`);
    } else if (s.floatEl) {
      // raster: dx/dy are in viewBox(=displayed px) units; convert to displayed px
      const rect = this.sel.overlay.getBoundingClientRect();
      const pxX = dx * rect.width / this.sel.overlay.width;
      const pxY = dy * rect.height / this.sel.overlay.height;
      s.floatEl.style.transform =
        `translate(${pxX.toFixed(2)}px, ${pxY.toFixed(2)}px) rotate(${rot.toFixed(3)}deg)`;
      s.floatEl.style.transformOrigin = 'center center';
    }
  }

  // deterministic pseudo-random in [0,1) from a leaf index + channel
  _leafRnd(i, k) { const x = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453; return x - Math.floor(x); }

  /*
   * (Step 8) Which applicator drives this motion — '' when nothing classified it.
   *
   * The swatch's own `applicator` is preferred because the service already resolved
   * (kind, class) there: a rigid_path clip emits a `path` swatch AND a `texture` one,
   * and only the first can drive path_travel. Swatches are ordered primary-first, so
   * the first one that was actually classified wins.
   *
   * A swatch with an EMPTY class is skipped deliberately. contracts.swatch_applicator
   * still fills in a payload-appropriate default for it ('oscillate' for a texture),
   * but that is a shape fallback, not a classification — treating it as one would
   * silently retire the presets' curated behaviour on the strength of a guess.
   */
  _applicatorFor(motion) {
    for (const sw of (motion.swatches || [])) {
      if (sw && sw.class && sw.applicator) return sw.applicator;
    }
    return APPLICATOR_BY_CLASS[motion.class] || '';
  }

  /*
   * The class the applicator above was chosen from — same swatch-first precedence, so
   * the two can never disagree about which motion this is. js/judge.js (Step 9) sends
   * it to the judge, which needs to be told what it is supposed to be looking at.
   */
  _classOf(motion) {
    for (const sw of (motion.swatches || [])) {
      if (sw && sw.class && sw.applicator) return sw.class;
    }
    return motion.class || '';
  }

  /*
   * The captured pose sequence, from wherever it lives. `motion.pose` is the frozen
   * shape the library has always stored; a Step-7 skeleton swatch nests the same
   * {joints, fps, frames} under `.pose`, so a swatch-only motion drives the rig too
   * (buildTrajField() reads a texture swatch the same way).
   */
  _poseFor(motion) {
    if (motion.pose && motion.pose.frames && motion.pose.frames.length) return motion.pose;
    for (const sw of (motion.swatches || [])) {
      if (sw && sw.kind === 'skeleton' && sw.pose && sw.pose.frames && sw.pose.frames.length) {
        return sw.pose;
      }
    }
    return null;
  }

  /* Same for the travel path: `motion.path` or a Step-7 `path` swatch's `.path`. A path
     needs at least two points to be a path at all, which is also the check that keeps an
     untracked rigid_path clip out of path_travel. */
  _pathFor(motion) {
    const ok = p => p && p.points && p.points.length > 1 ? p : null;
    if (ok(motion.path)) return motion.path;
    for (const sw of (motion.swatches || [])) {
      if (sw && sw.kind === 'path' && ok(sw.path)) return sw.path;
    }
    return null;
  }

  /*
   * Run the applicator the class asked for. Returns false when it CANNOT run on this
   * artwork — a flock needs several children, cloth needs deformable geometry — and
   * the caller then falls through rather than pretending the motion was applied.
   */
  _applyByClass(s, motion, app, t, intensity) {
    switch (app) {
      case 'skeletal':
        // the rig check runs earlier in _applyAll (it needs the pose payload too);
        // reaching here means this artwork has no rig for the joints to drive
        return false;
      case 'wave':
        return this._applyCloth(s, motion, t, intensity);
      case 'flow_field':
        return this._applyFluid(s, motion, t, intensity);
      case 'flock_drift':
        return this._applyFlock(s, motion, t, intensity);
      case 'path_travel':
        // a motion WITH points was already handled above; a rigid_path swatch whose
        // tracker found nothing has no travel to apply, so let the default sway run
        return false;
      case 'oscillate':
      default:
        return false;    // the parametric tail of _applyAll IS the oscillate applicator
    }
  }

  /* Captured trajectory field for this motion, cached per selection. */
  _fieldFor(s, motion) {
    if (s._field === undefined || s._fieldMotion !== motion.id) {
      s._field = buildTrajField(motion) || null;
      s._fieldMotion = motion.id;
    }
    return s._field;
  }

  /*
   * cloth → `wave`. A soft sheet rippling while anchored at one edge.
   *
   * Driven by the REAL captured field through the rigid MLS mesh warp
   * (motionfields.js): the field is read at a coarse lattice and every path point is
   * mapped by a smooth blend of those control displacements, so the deformation is
   * continuous and neighbouring geometry cannot separate.
   *
   * That is what let the `/flag|banner|pennant|ensign|standard/` regex go. It existed
   * because the old per-point fieldD() displaced each sample INDEPENDENTLY, mangling
   * clean stripes (measured on flag.mp4: 27% median local shape distortion, 153% worst
   * case), so flag-like names had to opt out of real motion and use a synthetic sine.
   * The warp cuts that ~3x (9% median, 68% worst), which is what makes captured motion
   * usable on a flag — no name needed, and no synthetic stand-in. It is a reduction,
   * not an elimination: see the measurements above buildMeshWarp.
   *
   * anchor 'x0' pins the leading edge and ramps displacement across the width (the
   * pole end holds, the free edge whips), matching the synthetic wave's ramp so the
   * two agree on where a sheet is held. The synthetic sine remains for motions with
   * no field at all — the presets.
   */
  /* True when the selection is a multi-fill garment that must deform as one coherent
     sheet (skirt/dress), false for a flag-like cloth with a few big paths + an emblem.
     Opt in explicitly with data-cloth="coherent" on the group; otherwise inferred from
     path count (a garment is dozens of stacked fills; a flag is a handful). */
  _clothCoherent(s) {
    const w = s.wrap;
    if (!w || !w.querySelectorAll) return false;
    if ((w.getAttribute && w.getAttribute('data-cloth') === 'coherent') ||
        w.querySelector('[data-cloth="coherent"]')) return true;
    return w.querySelectorAll('path').length > 14;
  }

  /* Elegant, curated SKIRT sway. Applying a captured flag/flutter field to a skirt looks
     wrong — a flag whips from a side pole, a skirt pivots from the WAIST with the hem
     swinging. This ignores the captured field and drives a smooth waist-pinned pendulum:
     every point is displaced by a continuous function of its position, so coincident points
     move identically and the fabric can never tear into gaps. Speed/Intensity still apply
     (t is already scaled by Speed; intensity scales the swing). Opt in with data-cloth="skirt". */
  _applySkirt(s, motion, t, intensity) {
    // Cache the path elements + their pristine geometry + the group box ONCE. We warp the
    // paths' own coordinates (warpPathD) rather than resampling to polylines, so béziers
    // stay smooth and stacked shapes that share edges can never split into slivers.
    if (!s._skirt || s._skirtMotion !== motion.id) {
      const els = [...s.wrap.querySelectorAll('path')].filter(el => {
        let d0 = el.getAttribute('data-ms-d0');
        if (!d0) { d0 = el.getAttribute('d'); if (!d0) return false; el.setAttribute('data-ms-d0', d0); }
        else el.setAttribute('d', d0);
        return true;
      });
      let bb; try { bb = s.wrap.getBBox(); } catch (_) { bb = { x: 0, y: 0, width: 1, height: 1 }; }
      s._skirt = { els: els.map(el => ({ el, d0: el.getAttribute('data-ms-d0') })),
                   minY: bb.y, H: Math.max(1, bb.height), W: Math.max(1, bb.width) };
      s._skirtMotion = motion.id;
    }
    const c = s._skirt;
    const p = motion.params || {};
    const f = 0.42 + 0.20 * Math.min(1, Math.max(0, p.frequency || 0.5));   // calm, skirt-like
    const w = 2 * Math.PI * f;
    const A = c.W * 0.17 * intensity;                                        // hem swing amplitude
    const s1 = Math.sin(w * t), lift = A * 0.16 * (1 - Math.cos(w * t)) * 0.5;
    // continuous displacement of a point by its VERTICAL position: waist (top) pinned,
    // swing grows toward the hem. A pure function of (x,y) -> shared points move together.
    const disp = (x, y) => {
      const v = Math.max(0, Math.min(1, (y - c.minY) / c.H));
      const taper = Math.pow(v, 1.4);
      const dx = A * taper * (s1 + 0.22 * Math.sin(1.7 * w * t - v * 3.0));
      const dy = lift * (v * v);
      return [x + dx, y + dy];
    };
    for (const o of c.els) o.el.setAttribute('d', warpPathD(o.d0, disp));
    s.wrap.setAttribute('transform', '');
    return true;
  }

  /* Cache every <path> in the selection + its pristine geometry (data-ms-d0) and the group
     box, ONCE per (motion, mode). Shared by the coordinate-warp deformers below. Rebuilt
     when the key changes; geometry is restored on reset via the same data-ms-d0. */
  _deformCache(s, key) {
    if (!s._warp || s._warp.key !== key) {
      const els = [];
      for (const el of s.wrap.querySelectorAll('path')) {
        let d0 = el.getAttribute('data-ms-d0');
        if (!d0) { d0 = el.getAttribute('d'); if (!d0) continue; el.setAttribute('data-ms-d0', d0); }
        else el.setAttribute('d', d0);
        els.push({ el, d0 });
      }
      let bb; try { bb = s.wrap.getBBox(); } catch (_) { bb = { x: 0, y: 0, width: 1, height: 1 }; }
      s._warp = { key, els, box: {
        minX: bb.x, minY: bb.y, maxX: bb.x + bb.width, maxY: bb.y + bb.height,
        width: Math.max(1, bb.width), height: Math.max(1, bb.height) } };
    }
    return s._warp;
  }

  /* Warp every cached path's OWN coordinates (anchors + bézier control points) through a
     continuous displacement `disp(x,y)->[x2,y2]`. Because disp is a pure function of
     position, béziers stay smooth and any point shared by two paths maps identically —
     so stacked, curved artwork deforms without faceting or tearing into gaps. */
  _deformApply(s, disp) {
    for (const o of s._warp.els) o.el.setAttribute('d', warpPathD(o.d0, disp));
    s.wrap.setAttribute('transform', '');
  }

  _applyCloth(s, motion, t, intensity) {
    // a skirt/dress rigged for the curated waist-pinned sway takes that path instead
    if (s.wrap.querySelector && s.wrap.querySelector('[data-cloth="skirt"]')) {
      return this._applySkirt(s, motion, t, intensity);
    }
    const c = this._deformCache(s, motion.id + ':cloth');
    if (!c.els.length) return false;                 // nothing deformable
    const box = c.box, width = box.width;
    const field = this._fieldFor(s, motion);

    if (field) {
      // ONE shared MLS warp, anchored at the left edge (a flag pinned to its pole),
      // applied to every path's own coordinates — curves + shared edges preserved.
      if (!s._mesh || s._meshMotion !== motion.id || s._meshAnchor !== 'x0') {
        s._mesh = buildMeshWarp(field, box, { anchor: 'x0' });
        s._meshMotion = motion.id;
        s._meshAnchor = 'x0';
      }
      if (s._mesh) {
        const warp = s._mesh;
        this._deformApply(s, (x, y) => { const q = warp(x, y, t, intensity); return [q.x, q.y]; });
        return true;
      }
    }

    // no captured field (preset) → synthetic traveling sine (same math as waveD)
    const p = motion.params;
    const A = WAVE_AMP_PX * (0.35 + p.amplitude) * intensity;
    const k = 2 * Math.PI * WAVE_CYCLES * (0.5 + p.phaseSpread) / width;
    const phase = 2 * Math.PI * p.frequency * t;
    const turb = p.turbulence * 4 * intensity;
    this._deformApply(s, (x, y) => {
      const ramp = Math.pow((x - box.minX) / width, 1.15);
      const arg = phase - k * (x - box.minX);
      const dy = A * ramp * Math.sin(arg) + A * 0.32 * ramp * Math.sin(arg * 2.0 + 1.3)
               + turb * ramp * _noise(x * 0.11 + phase * 1.3);
      const dx = A * 0.22 * ramp * Math.cos(arg);
      return [x + dx, y + dy];
    });
    return true;
  }

  /*
   * fluid → `flow_field`. A continuous medium: water, smoke, steam, fire.
   *
   * Same mesh warp as cloth but anchor 'none' — a river surface is pinned to nothing,
   * so the whole lattice is free and the sheet flows rather than whipping from an
   * edge. With no captured field it falls back to _applyRiver's synthetic laminar
   * wave, which is what the Water Ripple preset has always used.
   */
  _applyFluid(s, motion, t, intensity) {
    const field = this._fieldFor(s, motion);
    if (!field) {
      // no captured field → synthetic laminar wave (river). Non-path art has no outline
      // to flow; return false so the default sway runs, exactly as before.
      if (!s.wrap.querySelector('path')) return false;
      this._applyRiver(s, motion, t, intensity);
      return true;
    }
    const c = this._deformCache(s, motion.id + ':fluid');
    if (!c.els.length) return false;
    // same mesh warp as cloth but anchor 'none' — a fluid surface is pinned to nothing.
    if (!s._mesh || s._meshMotion !== motion.id || s._meshAnchor !== 'none') {
      s._mesh = buildMeshWarp(field, c.box, { anchor: 'none' });
      s._meshMotion = motion.id;
      s._meshAnchor = 'none';
    }
    if (!s._mesh) return false;
    const warp = s._mesh;
    this._deformApply(s, (x, y) => { const q = warp(x, y, t, intensity); return [q.x, q.y]; });
    return true;
  }

  /*
   * flock → `flock_drift`. Many similar things drifting together: birds, leaves,
   * fish, a crowd. Each CHILD element moves on its own so the group spreads and
   * desynchronizes instead of sliding as one rigid block.
   *
   * Everything directional comes from the captured params — `direction` sets the
   * common heading (degrees, screen y-down as in computeMotion), `driftX/driftY` add
   * the measured steady travel, `frequency` the wobble rate, `turbulence` how much
   * each member wanders off the common heading. Nothing here knows what a bird is;
   * _applyBirds keeps the wingbeat curation for the presets.
   *
   * Travel is bounded per member by ITS OWN on-canvas room and eased out-and-back
   * ((1-cos)/2 never changes sign), so a member drifts along the heading and returns
   * without any of them leaving the artwork or reversing into the flock.
   */
  _applyFlock(s, motion, t, intensity) {
    const wrap = s.wrap;
    const p = motion.params || {};
    if (!s._flock || s._flockMotion !== motion.id) {
      const kids = [...wrap.querySelectorAll('path')];
      if (kids.length < 2) return false;            // one path is not a flock
      const svg = wrap.ownerSVGElement;
      const vb = (svg && svg.viewBox && svg.viewBox.baseVal) || null;
      const vbW = (vb && vb.width) || 1121.71, vbH = (vb && vb.height) || 1121.73;
      const MARGIN = 8, REACH = 55;                 // desired travel, room-clamped below
      // common heading from the captured direction, plus the measured steady drift
      const th = (p.direction || 0) * Math.PI / 180;
      let hx = Math.cos(th), hy = -Math.sin(th);   // math y-up -> screen y-down
      const dxv = p.driftX || 0, dyv = p.driftY || 0;
      if (dxv || dyv) {
        const dl = Math.hypot(dxv, dyv);
        /* `direction` is an unsigned dominant-AXIS angle, not a heading: distill.py does
           `% 180.0`, so a flock falling (270) and one rising (90) both arrive as 90. The
           drift is the only signed evidence there is — driftY is +down, the same screen
           space hy is in — so resolve the axis against it BEFORE averaging. Averaging first
           destroys the heading whenever the two disagree: measured on the pre-fix code, a
           falling flock (dir 90, driftY +0.9) cancelled to (0,0) and then normalized float
           noise from cos(90°) into a pure +x heading, drifting 52.08px SIDEWAYS, and a
           leftward flock (dir 0, driftX -0.9) cancelled exactly and froze at 0.00px. */
        if (hx * dxv + hy * dyv < 0) { hx = -hx; hy = -hy; }
        hx = (hx + dxv / dl) / 2; hy = (hy + dyv / dl) / 2;
        const hl = Math.hypot(hx, hy) || 1;
        hx /= hl; hy /= hl;
      }
      s._flock = kids.map((el, i) => {
        const b = el.getBBox();
        // room in the direction THIS member is heading (both axes must allow it)
        const roomX = hx >= 0 ? Math.max(0, vbW - (b.x + b.width) - MARGIN)
                              : Math.max(0, b.x - MARGIN);
        const roomY = hy >= 0 ? Math.max(0, vbH - (b.y + b.height) - MARGIN)
                              : Math.max(0, b.y - MARGIN);
        const reach = Math.min(REACH,
          Math.abs(hx) > 1e-3 ? roomX / Math.abs(hx) : Infinity,
          Math.abs(hy) > 1e-3 ? roomY / Math.abs(hy) : Infinity);
        return {
          el, hx, hy,
          reach: reach * (0.7 + this._leafRnd(i, 4) * 0.3),   // per-member variety
          driftF: 0.05 + this._leafRnd(i, 7) * 0.05,
          driftPh: this._leafRnd(i, 8) * Math.PI * 2,
          wobF: 0.15 + this._leafRnd(i, 6) * 0.18,
          wobPh: this._leafRnd(i, 0) * Math.PI * 2,
          wobDir: this._leafRnd(i, 9) * Math.PI * 2,
        };
      });
      s._flockMotion = motion.id;
    }
    const wob = (p.turbulence || 0) * TURB_PX * intensity;
    const freq = 0.5 + (p.frequency || 1) * 0.5;
    for (const fd of s._flock) {
      const ramp = (1 - Math.cos(2 * Math.PI * fd.driftF * freq * t + fd.driftPh)) / 2;
      // hard cap at the member's room: the Intensity slider goes to 2x, and the
      // room-fit alone would let it push members off the canvas
      const travel = Math.min(fd.reach, fd.reach * intensity * ramp);
      // wander perpendicular AND along, at the member's own phase, so the flock
      // loosens as it drifts instead of holding formation
      const w = wob * Math.sin(2 * Math.PI * fd.wobF * freq * t + fd.wobPh);
      const dx = fd.hx * travel + Math.cos(fd.wobDir) * w;
      const dy = fd.hy * travel + Math.sin(fd.wobDir) * w;
      fd.el.setAttribute('transform', `translate(${dx.toFixed(2)} ${dy.toFixed(2)})`);
    }
    wrap.setAttribute('transform', '');
    return true;
  }

  /*
   * Tree canopy: preserve the detailed silhouettes and sway the overlay around
   * a low pivot. The static source beneath it restores any area the wind opens.
   */
  _applyTreeLeaves(s, motion, t, intensity) {
    const wrap = s.wrap;
    const canopy = wrap.querySelector('[data-motion-role="tree-canopy"]');
    if (!canopy) return;
    if (!s._treeLeaves || s._treeLeaves.el !== canopy) {
      const b = canopy.getBBox();
      s._treeLeaves = {
        el: canopy,
        px: b.x + b.width * 0.78,
        py: b.y + b.height * 0.97,
      };
    }
    const p = motion.params || {};
    const frequency = Number.isFinite(p.frequency) ? p.frequency : 0.4;
    const amplitude = Number.isFinite(p.amplitude) ? p.amplitude : 0.45;
    const phase = 2 * Math.PI * Math.max(0.12, Math.min(0.65, frequency)) * t;
    const primary = Math.sin(phase);
    const harmonic = Math.sin(phase * 2);
    const reach = 2.5 + Math.max(0, Math.min(1, amplitude)) * 4;
    const dx = reach * intensity * (primary + harmonic * 0.16);
    const dy = 0.55 * intensity * harmonic;
    const angle = 0.42 * intensity * (primary + harmonic * 0.1);
    const { px, py } = s._treeLeaves;
    canopy.setAttribute('transform',
      `translate(${dx.toFixed(2)} ${dy.toFixed(2)}) ` +
      `rotate(${angle.toFixed(3)} ${px.toFixed(1)} ${py.toFixed(1)})`);
    wrap.setAttribute('transform', '');
  }

  /*
   * Realistic falling leaves: instead of moving the whole group rigidly, each
   * child leaf falls down a vertical corridor at its own speed, swaying and
   * tumbling, and wraps back to the top (fading in/out to hide the reset).
   * Reads as a continuous stream of leaves drifting to the ground.
   */
  _applyLeafFall(s, motion, t, intensity) {
    const wrap = s.wrap;
    if (!s._leaves || s._leavesMotion !== motion.id) {
      const kids = [...wrap.querySelectorAll('path')];
      const svg = wrap.ownerSVGElement;
      const H = (svg && svg.viewBox && svg.viewBox.baseVal && svg.viewBox.baseVal.height) || 1377;
      s._corridor = { topY: H * 0.14, groundY: H * 0.80 };   // spawn line → ground line
      s._leaves = kids.map((el, i) => {
        const b = el.getBBox();
        return {
          el, cx: b.x + b.width / 2, cy: b.y + b.height / 2,
          vy: 60 + this._leafRnd(i, 1) * 95,               // fall speed (units/s)
          swayA: 12 + this._leafRnd(i, 2) * 30,            // horizontal sway amplitude
          swayF: 0.35 + this._leafRnd(i, 3) * 0.7,         // sway frequency (Hz)
          phase: this._leafRnd(i, 4) * Math.PI * 2,
          rot0: this._leafRnd(i, 5) * 360,
          rotV: (this._leafRnd(i, 6) - 0.5) * 170,         // tumble (deg/s)
        };
      });
      s._leavesMotion = motion.id;
    }
    const { topY, groundY } = s._corridor;
    const Hc = Math.max(1, groundY - topY);
    const spd = intensity;
    for (const lf of s._leaves) {
      const start = lf.cy - topY;
      const ph = (((start + lf.vy * t * spd) % Hc) + Hc) % Hc;   // 0..Hc, wraps
      const dy = (topY + ph) - lf.cy;
      const dx = lf.swayA * spd * Math.sin(lf.swayF * 2 * Math.PI * t + lf.phase);
      const ang = lf.rot0 + lf.rotV * t;
      const fin = Math.min(1, ph / (Hc * 0.07));                 // fade in near top
      const fout = Math.min(1, (Hc - ph) / (Hc * 0.14));         // fade out near ground
      lf.el.setAttribute('transform',
        `translate(${dx.toFixed(2)} ${dy.toFixed(2)}) rotate(${ang.toFixed(1)} ${lf.cx.toFixed(1)} ${lf.cy.toFixed(1)})`);
      lf.el.style.opacity = Math.max(0, Math.min(fin, fout)).toFixed(3);
    }
    wrap.setAttribute('transform', '');
  }

  /*
   * Birds: each child path is one bird, with a subtle WING FLAP — a small
   * vertical squash/stretch about the bird's own center (wings sweep up/down)
   * at a natural ~2-3 Hz, each bird on its own phase so the flock isn't in
   * lockstep.
   *
   * Travel: the flock is split into two groups by which half of the sky each
   * bird sits in. LEFT-half birds drift gently LEFT, RIGHT-half birds drift
   * gently RIGHT — so the flock fans outward instead of streaming off one edge.
   * The drift is a small, slow sine and each bird is clamped to its own
   * on-canvas room, so no bird ever leaves the artwork. Wing flap is untouched.
   */
  _applyBirds(s, motion, t, intensity) {
    const wrap = s.wrap;
    if (!s._birds || s._birdsMotion !== motion.id) {
      const kids = [...wrap.querySelectorAll('path')];
      const svg = wrap.ownerSVGElement;
      const vb = (svg && svg.viewBox && svg.viewBox.baseVal) || { width: 1121.71, height: 1121.73 };
      const vbW = vb.width, mid = vbW / 2, MARGIN = 8;
      const DRIFT = 55;   // max desired horizontal drift (viewBox units), room-clamped below
      s._birds = kids.map((el, i) => {
        const b = el.getBBox();
        // group by sky half: left-half → drift left (-1), right-half → right (+1)
        const goRight = (b.x + b.width / 2) >= mid;
        const roomLeft  = Math.max(0, b.x - MARGIN);
        const roomRight = Math.max(0, vbW - (b.x + b.width) - MARGIN);
        // amplitude bounded by the room on the side this bird moves toward
        const amp = Math.min(DRIFT, goRight ? roomRight : roomLeft);
        return {
          el, cx: b.x + b.width / 2, cy: b.y + b.height / 2,
          dir: goRight ? 1 : -1,
          amp: amp * (0.7 + this._leafRnd(i, 4) * 0.3),    // slight per-bird variety
          driftF: 0.05 + this._leafRnd(i, 7) * 0.05,       // slow drift (0.05–0.10 Hz)
          driftPh: this._leafRnd(i, 8) * Math.PI * 2,
          flapF: 2.1 + this._leafRnd(i, 1) * 1.3,          // 2.1–3.4 Hz wingbeat
          phase: this._leafRnd(i, 2) * Math.PI * 2,        // desync the flock
          flapAmp: 0.16 + this._leafRnd(i, 3) * 0.10,      // per-bird flap depth
          bobA: 4 + this._leafRnd(i, 5) * 6,               // gentle vertical waver
          bobF: 0.15 + this._leafRnd(i, 6) * 0.18,
          bobPh: this._leafRnd(i, 0) * Math.PI * 2,
        };
      });
      s._birdsMotion = motion.id;
    }
    const spd = intensity;
    for (const bd of s._birds) {
      // gentle bounded drift outward (left group left, right group right).
      // (1 - cos)/2 ramps 0→1→0 so it eases out and back without a hard turn,
      // and the sign never crosses zero → the bird only ever moves outward.
      const ramp = (1 - Math.cos(2 * Math.PI * bd.driftF * t + bd.driftPh)) / 2;
      const dx = bd.dir * bd.amp * spd * ramp;
      const dy = bd.bobA * spd * Math.sin(2 * Math.PI * bd.bobF * t + bd.bobPh);
      // wing flap: vertical scale oscillates about the bird's center (unchanged)
      const flap = 1 - bd.flapAmp * spd * (0.5 + 0.5 * Math.sin(2 * Math.PI * bd.flapF * t + bd.phase));
      const sy = Math.max(0.6, flap);
      bd.el.setAttribute('transform',
        `translate(${dx.toFixed(2)} ${dy.toFixed(2)}) ` +
        `translate(${bd.cx.toFixed(1)} ${bd.cy.toFixed(1)}) scale(1 ${sy.toFixed(3)}) ` +
        `translate(${(-bd.cx).toFixed(1)} ${(-bd.cy).toFixed(1)})`);
    }
    wrap.setAttribute('transform', '');
  }

  /*
   * Clouds: in the reference clip, clouds drift slowly and STEADILY in one
   * direction (wind) — they don't bob, pulse, or reverse. So each cloud gets a
   * gentle, uniform horizontal glide (all the same wind direction, slightly
   * different speeds), with a very slow, very shallow sine so the loop is
   * seamless without the drift ever reading as back-and-forth. No vertical bob,
   * no scale "breathing" (both looked unnatural). Amplitude is small and each
   * cloud is bounded to its own on-canvas room so none can wander off.
   */
  _applyClouds(s, motion, t, intensity) {
    const wrap = s.wrap;
    const CLOUD_SAMPLES = 64;
    if (!s._clouds || s._cloudsMotion !== motion.id) {
      const kids = [...wrap.querySelectorAll('path')];
      const svg = wrap.ownerSVGElement;
      const vbW = (svg && svg.viewBox && svg.viewBox.baseVal && svg.viewBox.baseVal.width) || 1121.71;
      const MARGIN = 8;
      s._clouds = kids.map((el, i) => {
        // remember pristine geometry so we can restore/rebuild each frame
        let d0 = el.getAttribute('data-ms-d0');
        if (!d0) { d0 = el.getAttribute('d'); el.setAttribute('data-ms-d0', d0); }
        else el.setAttribute('d', d0);
        const b = el.getBBox();
        // sample the cloud outline into points so we can gently billow the edge
        let pts = null;
        const len = el.getTotalLength ? el.getTotalLength() : 0;
        if (len) {
          pts = [];
          for (let k = 0; k <= CLOUD_SAMPLES; k++) {
            const pt = el.getPointAtLength(len * k / CLOUD_SAMPLES);
            pts.push([pt.x, pt.y]);
          }
        }
        const roomLeft  = Math.max(0, b.x - MARGIN);
        const roomRight = Math.max(0, vbW - (b.x + b.width) - MARGIN);
        const amp = Math.min(34, roomLeft, roomRight);
        return {
          el, pts, closed: /z\s*$/i.test(d0),
          cx: b.x + b.width / 2, cy: b.y + b.height / 2,
          w: Math.max(1, b.width), h: Math.max(1, b.height),
          amp: amp * (0.7 + this._leafRnd(i, 5) * 0.3),    // drift amplitude, per-cloud
          driftF: 0.010 + this._leafRnd(i, 1) * 0.010,     // extremely slow drift
          driftPh: this._leafRnd(i, 2) * Math.PI * 2,
          billowPh: this._leafRnd(i, 3) * Math.PI * 2,     // desync the billow
        };
      });
      s._cloudsMotion = motion.id;
    }
    // BILLOW: slow, shallow deformation of the outline so the cloud softly
    // morphs as it drifts (like the reference clip) instead of moving rigidly.
    const BILLOW = 2.4 * intensity;     // max edge displacement (viewBox units) — subtle
    const bf = 0.06;                    // billow frequency (very slow)
    for (const cd of s._clouds) {
      // steady wind drift (unchanged)
      const dx = cd.amp * intensity * Math.sin(2 * Math.PI * cd.driftF * t + cd.driftPh);
      if (cd.pts) {
        const ph = 2 * Math.PI * bf * t + cd.billowPh;
        let d = '';
        for (let k = 0; k < cd.pts.length; k++) {
          const [x0, y0] = cd.pts[k];
          // position-dependent phase so different parts of the outline swell at
          // different times → the silhouette breathes organically, not uniformly
          const u = (x0 - cd.cx) / cd.w, v = (y0 - cd.cy) / cd.h;
          const sx = BILLOW * Math.sin(ph + u * 4.0 + v * 2.3);
          // tops billow up a touch more than the flat base
          const sy = BILLOW * 0.7 * Math.cos(ph * 0.9 + v * 3.1 + u * 1.7);
          d += (k ? 'L' : 'M') + (x0 + sx).toFixed(2) + ',' + (y0 + sy).toFixed(2);
        }
        cd.el.setAttribute('d', cd.closed ? d + 'Z' : d);
      }
      cd.el.setAttribute('transform', `translate(${dx.toFixed(2)} 0)`);
    }
    wrap.setAttribute('transform', '');
  }

  /*
   * River ripples: the Water Ripple preset has no captured trajectory field, so
   * by default it would just rigidly shake the whole ripple group. Instead we
   * DEFORM the ripple geometry with a smooth LAMINAR traveling wave — glassy
   * downstream flow rather than choppy chop:
   *
   *   dy(x,y,t) = A · sin(k·x − 2πf·t + φ(y)) + small second harmonic
   *   dx(...)   = a gentle along-stream shear so ripple crests slide downstream
   *
   * Long wavelength + low amplitude + zero turbulence = laminar. A slow phase
   * offset per scanline (φ(y)) makes the sheet flow, not oscillate in lockstep.
   * The deformation is applied to the SAME sampled-path machinery cloth uses
   * (buildWaveData), but with a flow-tuned displacement instead of a flag whip.
   */
  _applyRiver(s, motion, t, intensity) {
    const wrap = s.wrap;
    if (!s._river) {
      // cache the path elements + pristine geometry + box (coordinate-warp, tear-free)
      const els = [];
      for (const el of wrap.querySelectorAll('path')) {
        let d0 = el.getAttribute('data-ms-d0');
        if (!d0) { d0 = el.getAttribute('d'); if (!d0) continue; el.setAttribute('data-ms-d0', d0); }
        else el.setAttribute('d', d0);
        els.push({ el, d0 });
      }
      let bb; try { bb = wrap.getBBox(); } catch (_) { bb = null; }
      s._river = { els, box: bb ? { minX: bb.x, minY: bb.y,
        width: Math.max(1, bb.width), height: Math.max(1, bb.height) } : null };
    }
    const rv = s._river;
    // Art built from non-<path> shapes (rect/polygon/ellipse) has no outline to deform —
    // fall back to a gentle rigid sway instead of silently doing nothing.
    if (!rv.els.length || !rv.box) {
      const { dx, dy, rot } = computeMotion(motion.params, s.center[0] * 0.01 + s.center[1] * 0.03, t, intensity);
      const [cx, cy] = s.center;
      wrap.setAttribute('transform', `translate(${dx.toFixed(2)} ${dy.toFixed(2)}) rotate(${rot.toFixed(3)} ${cx.toFixed(1)} ${cy.toFixed(1)})`);
      return;
    }
    const box = rv.box, width = box.width, height = box.height;
    const p = motion.params || {};
    // laminar tuning: long wavelength, slow drift, shallow amplitude (kept verbatim).
    const A = 3.4 * (0.6 + (p.amplitude || 0.2)) * intensity;   // vertical swell (units)
    const k = 2 * Math.PI * 1.15 / width;                       // ~1 crest across the river
    const f = 0.28 * (0.6 + (p.frequency || 1.0) * 0.5);        // slow downstream speed
    const phase = 2 * Math.PI * f * t;
    const flow = 5.0 * intensity;                               // along-stream crest slide
    // continuous laminar displacement — a pure function of (x,y), so shared points align.
    const disp = (x, y) => {
      const yPhase = (y - box.minY) / height * Math.PI * 1.3;   // downstream, not lockstep
      const arg = k * (x - box.minX) - phase + yPhase;
      const dy = A * Math.sin(arg) + A * 0.35 * Math.sin(arg * 0.5 + phase * 0.6);
      const dx = flow * Math.cos(arg) * 0.5;
      return [x + dx, y + dy];
    };
    for (const o of rv.els) o.el.setAttribute('d', warpPathD(o.d0, disp));
    wrap.setAttribute('transform', '');
  }

  /*
   * Boat: a rigid hull shouldn't ripple like water — but it should FLOAT on the
   * ripples. Replicate the water-ripple rhythm as a gentle rigid BOB (rise/fall)
   * plus a slow ROCK (tilt about the waterline), like the moored boat in the
   * reference night clip. The bob/rock share the river's slow frequency and low
   * amplitude, so the boat reads as riding the same ripples the surface shows.
   * A small phase offset between bob and rock keeps it from looking mechanical.
   */
  _applyBoat(s, motion, t, intensity) {
    const wrap = s.wrap;
    if (!s._boat) {
      const b = wrap.getBBox();
      s._boat = {
        // pivot at the waterline: horizontal center, near the bottom of the hull
        px: b.x + b.width / 2,
        py: b.y + b.height * 0.82,
      };
    }
    const p = motion.params || {};
    // match the river's laminar cadence so boat + water feel coupled
    const f = 0.28 * (0.6 + (p.frequency || 1.0) * 0.5);   // same base as _applyRiver
    const amp = (0.6 + (p.amplitude || 0.2));
    const bob = 7.0 * amp * intensity * Math.sin(2 * Math.PI * f * t);          // vertical rise/fall
    const rock = 1.4 * amp * intensity * Math.sin(2 * Math.PI * f * 0.85 * t + 0.7); // tilt (deg)
    const bp = s._boat;
    wrap.setAttribute('transform',
      `translate(0 ${bob.toFixed(2)}) rotate(${rock.toFixed(3)} ${bp.px.toFixed(1)} ${bp.py.toFixed(1)})`);
  }

  /*
   * Travel path (Step 5): follow a path REALLY extracted from the clip.
   * motion.path.points are [frame, dx, dy] offsets from the tracked object's own
   * start, normalized to the video frame — so one path fits artwork of any size.
   *
   * Two things have to be reconciled with the artwork:
   *   ROOM — the filmed object may cross 60% of its frame while the artwork's copy
   *     has 8% of the canvas to its right. Offsets get ONE uniform scale (the
   *     tightest of the four directions) so the path keeps its SHAPE: a diagonal
   *     drift must not flatten into a vertical one because the horizontal room ran
   *     out. The per-frame result is then hard-clamped to the room as well, because
   *     the Intensity slider goes to 2x and would otherwise push it off canvas.
   *   LOOPING — the clip ends wherever the object happened to get to. Snapping back
   *     to the start reads as a teleport, and easing back would be motion that is
   *     not in the video, so the path PING-PONGS: every position shown is a real
   *     extracted sample; only the return leg's time order is reversed.
   *
   * The path supplies TRAVEL. motion.params (distilled from the flow field inside
   * the object's own mask) supplies a residual bob ACROSS the course, so a boat
   * still rides its water while it crosses the scene. SVG only — a raster
   * selection has no viewBox to measure its room in.
   */
  _applyPathTravel(s, motion, t, intensity) {
    const wrap = s.wrap;
    const P = this._pathFor(motion);
    if (!P) return false;
    if (!s._path || s._pathMotion !== motion.id) {
      const svg = wrap.ownerSVGElement;
      const vb = (svg && svg.viewBox && svg.viewBox.baseVal) || { width: 1121.71, height: 1121.73 };
      const MARGIN = 8;
      let b; try { b = wrap.getBBox(); } catch (_) { b = { x: 0, y: 0, width: 1, height: 1 }; }
      const room = {
        left:  Math.max(0, b.x - MARGIN),
        right: Math.max(0, vb.width - (b.x + b.width) - MARGIN),
        up:    Math.max(0, b.y - MARGIN),
        down:  Math.max(0, vb.height - (b.y + b.height) - MARGIN),
      };
      // what the path WANTS in each direction, in viewBox units at 1:1 (frame ≙ canvas)
      let wR = 0, wL = 0, wD = 0, wU = 0;
      for (const pt of P.points) {
        wR = Math.max(wR, pt[1] * vb.width);   wL = Math.max(wL, -pt[1] * vb.width);
        wD = Math.max(wD, pt[2] * vb.height);  wU = Math.max(wU, -pt[2] * vb.height);
      }
      let k = 1;   // never >1: the video's own excursion is the natural size
      const fit = (want, have) => { if (want > 1e-3) k = Math.min(k, have / want); };
      fit(wR, room.right); fit(wL, room.left); fit(wD, room.down); fit(wU, room.up);
      const tv = P.travel || {};
      const netLen = Math.hypot(tv.dx || 0, tv.dy || 0) || 1;
      s._path = {
        pts: P.points, span: P.points.length - 1, room,
        sx: k * vb.width, sy: k * vb.height,       // normalized offset -> viewBox units
        fps: Math.max(1, P.fps || 30),
        // unit normal to the NET course: the residual bob rides across the path
        // instead of fighting it or faking extra travel along it
        nx: -(tv.dy || 0) / netLen, ny: (tv.dx || 0) / netLen,
      };
      if (k < 0.999) {
        console.log(`[MotionLife] "${s.name}": ${P.label} travel path scaled to `
          + `${(k * 100).toFixed(0)}% — that is all the room the artwork has for it.`);
      }
      s._pathMotion = motion.id;
    }
    const pd = s._path, span = pd.span;
    // ping-pong through the samples, interpolating between the two neighbours so
    // playback stays smooth at screen refresh rates (samples are at video fps)
    const u = (t * pd.fps) % (2 * span);
    const pos = u <= span ? u : 2 * span - u;
    const i = Math.min(span - 1, Math.floor(pos)), f = pos - i;
    const a = pd.pts[i], c = pd.pts[i + 1];
    let dx = (a[1] + (c[1] - a[1]) * f) * pd.sx * intensity;
    let dy = (a[2] + (c[2] - a[2]) * f) * pd.sy * intensity;
    // residual motion the flow field measured inside the object's mask
    const p = motion.params || {};
    const bob = 4.0 * (0.4 + (p.amplitude || 0.2)) * intensity
              * Math.sin(2 * Math.PI * 0.28 * (0.6 + (p.frequency || 1) * 0.5) * t);
    dx += pd.nx * bob; dy += pd.ny * bob;
    // hard bound: on canvas at every intensity, path scale and bob combined
    dx = Math.max(-pd.room.left, Math.min(pd.room.right, dx));
    dy = Math.max(-pd.room.up, Math.min(pd.room.down, dy));
    wrap.setAttribute('transform', `translate(${dx.toFixed(2)} ${dy.toFixed(2)})`);
  }

  /*
   * Character / skeletal motion. The swatch carries a captured pose sequence
   * (motion.pose = {joints, fps, frames}) from MediaPipe. Drive a rigged
   * character in the artwork: reposition its two legs (hip→knee→ankle) from the
   * captured joints, and bob/tilt the body + head. The rig is drawn in a local
   * frame centred on the body, so this math is position-independent.
   */
  _applyCharacter(s, motion, t, intensity) {
    const wrap = s.wrap;
    if (!s._char || s._charMotion !== motion.id) {
      const q = r => wrap.querySelector(`[data-role="${r}"]`);
      const rigEl = wrap.querySelector('[data-leg], [data-char-mode]');
      const pose = this._poseFor(motion);
      const frames = pose.frames.filter(Boolean);
      const jn = {}; pose.joints.forEach((n, i) => jn[n] = i);
      // mean hip / nose Y to centre the vertical bob
      let sh = 0, sn = 0;
      for (const f of frames) { sh += (f[jn.l_hip][1] + f[jn.r_hip][1]) / 2; sn += f[jn.nose][1]; }
      let bb; try { bb = wrap.getBBox(); } catch (_) { bb = { x: 0, y: 0, width: 1, height: 1 }; }
      s._char = {
        frames, jn, fps: pose.fps || 15,
        meanHipY: sh / frames.length, meanNoseY: sn / frames.length,
        leg: parseFloat(rigEl && rigEl.getAttribute('data-leg')) || 150,
        // whole-body puppet mode when the artwork can't be split into limbs
        puppet: (rigEl && rigEl.getAttribute('data-char-mode') === 'puppet'),
        pivotX: bb.x + bb.width / 2, pivotY: bb.y + bb.height,   // feet (bottom-centre)
        legFar: q('leg-far'), footFar: q('foot-far'),
        legNear: q('leg-near'), footNear: q('foot-near'),
        body: q('body'), head: q('head'),
      };
      // remember neutral geometry so pause/reset restores the standing pose
      const cc = s._char;
      cc.neutral = [cc.legFar, cc.legNear, cc.footFar, cc.footNear, cc.body, cc.head]
        .filter(Boolean).map(el => ({ el,
          points: el.getAttribute('points'), transform: el.getAttribute('transform'),
          cx: el.getAttribute('cx'), cy: el.getAttribute('cy') }));
      s._charMotion = motion.id;
    }
    const c = s._char, jn = c.jn, F = c.frames, n = F.length;
    if (!n) { return; }
    const fi = Math.floor((t * c.fps) % n);
    const f = F[fi];
    const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const hipC = mid(f[jn.l_hip], f[jn.r_hip]);
    const shoC = mid(f[jn.l_sho], f[jn.r_sho]);
    const nose = f[jn.nose];

    // ---- WHOLE-BODY PUPPET (flat art that can't be split into limbs) ----
    // Drive the whole figure with the captured gait: bounce (hips rise/fall),
    // weight-shift sway (toward the planted foot), a small lean, and a squash
    // on each footfall. Reads as a lively march/step-in-place.
    if (c.puppet || !c.body) {
      const bounce = -(hipC[1] - c.meanHipY) * 260 * intensity;              // up when hips rise
      const sway = (f[jn.r_ank][1] - f[jn.l_ank][1]) * 130 * intensity;      // toward planted foot
      const lean = sway * 0.06;                                             // lean into the step (deg)
      const down = Math.max(0, (hipC[1] - c.meanHipY)) * 6;                  // 0..~1 at footfall
      const sy = 1 - Math.min(0.06, down * 0.06) * intensity;
      const sx = 1 + Math.min(0.06, down * 0.06) * intensity;
      const px = c.pivotX, py = c.pivotY;
      wrap.setAttribute('transform',
        `translate(${sway.toFixed(2)} ${bounce.toFixed(2)}) ` +
        `rotate(${lean.toFixed(2)} ${px.toFixed(1)} ${py.toFixed(1)}) ` +
        `translate(${px.toFixed(1)} ${py.toFixed(1)}) scale(${sx.toFixed(4)} ${sy.toFixed(4)}) ` +
        `translate(${(-px).toFixed(1)} ${(-py).toFixed(1)})`);
      return;
    }

    const bob = (hipC[1] - c.meanHipY) * 150 * intensity;
    const tiltDeg = Math.atan2(shoC[1] - hipC[1], (shoC[0] - hipC[0]) || 1e-3) * 180 / Math.PI * 0.12 - 10.8;
    c.body.setAttribute('transform', `translate(0 ${bob.toFixed(2)}) rotate(${tiltDeg.toFixed(2)})`);
    if (c.head) {
      const hy = -64 + bob + (nose[1] - c.meanNoseY) * 60;
      c.head.setAttribute('transform', `translate(96 ${hy.toFixed(2)})`);
    }
    const LEG = c.leg * (0.5 + 0.6 * intensity), hipY = bob + 52;
    const leg = (hip, knee, ank, anchorX, line, foot) => {
      const h = f[jn[hip]], k = f[jn[knee]], a = f[jn[ank]];
      const hx = anchorX, hy = hipY;
      const kx = hx + (k[0] - h[0]) * LEG, ky = hy + (k[1] - h[1]) * LEG;
      const ax = hx + (a[0] - h[0]) * LEG, ay = hy + (a[1] - h[1]) * LEG;
      if (line) line.setAttribute('points', `${hx},${hy} ${kx.toFixed(1)},${ky.toFixed(1)} ${ax.toFixed(1)},${ay.toFixed(1)}`);
      if (foot) { foot.setAttribute('cx', (ax + 8).toFixed(1)); foot.setAttribute('cy', (ay + 2).toFixed(1)); }
    };
    leg('r_hip', 'r_knee', 'r_ank', -14, c.legFar, c.footFar);
    leg('l_hip', 'l_knee', 'l_ank', 14, c.legNear, c.footNear);
  }

  _reset() {
    for (const s of this.sel.selections) this._resetOne(s);
    this.sel.syncHighlights();
  }

  // Undo every special-case animator's mutations on ONE selection, restoring
  // it to its original static form — shared by pause() (resets everything)
  // and "Remove motion" (resets just the one object), so removing a motion
  // always fully reverts it regardless of which animation path it used.
  _resetOne(s) {
    if (s._treeLeaves) {
      s._treeLeaves.el.removeAttribute('transform');
      s._treeLeaves = null;
    }
    if (s._leaves) {
      for (const lf of s._leaves) { lf.el.removeAttribute('transform'); lf.el.style.opacity = ''; }
    }
    if (s._char) {
      for (const o of s._char.neutral || []) {
        if (o.points != null) o.el.setAttribute('points', o.points); else o.el.removeAttribute('points');
        if (o.transform != null) o.el.setAttribute('transform', o.transform); else o.el.removeAttribute('transform');
        if (o.cx != null) o.el.setAttribute('cx', o.cx);
        if (o.cy != null) o.el.setAttribute('cy', o.cy);
      }
      s._char = null; s._charMotion = null;
    }
    if (s._birds) { for (const bd of s._birds) { bd.el.removeAttribute('transform'); bd.el.style.opacity = ''; } s._birds = null; s._birdsMotion = null; }
    if (s._clouds) { for (const cd of s._clouds) cd.el.removeAttribute('transform'); s._clouds = null; s._cloudsMotion = null; }
    // Step 8 flock: room was measured from each member's bbox, so it must be
    // re-measured on the next play rather than reused after the artwork moved
    if (s._flock) { for (const fd of s._flock) fd.el.removeAttribute('transform'); s._flock = null; s._flockMotion = null; }
    if (s.kind === 'svg' && s.wrap) {
      s.wrap.setAttribute('transform', '');
      // restore pristine geometry for wave-deformed paths, and clear any
      // per-path transform used to ride detail elements (e.g. flag chakra)
      for (const el of s.wrap.querySelectorAll('path[data-ms-d0]')) {
        el.setAttribute('d', el.getAttribute('data-ms-d0'));
        el.removeAttribute('transform');
      }
      s._wave = null;
      s._warp = null;                            // coordinate-warp path cache (cloth/fluid)
      s._skirt = null; s._skirtMotion = null;   // curated skirt sway (coordinate warp)
      s._river = null;
      s._boat = null;
      s._path = null; s._pathMotion = null;     // Step 5 travel path (room is re-measured)
      s._field = undefined;
      s._fieldMotion = null;
      // Step 8 mesh warp: its lattice is anchored to the object's bbox, which the
      // restored geometry above has just changed back
      s._mesh = null; s._meshMotion = null; s._meshAnchor = null;
      // reset per-glyph transforms (glyph split itself is kept — harmless)
      if (s._text) {
        for (const it of s._text.items) it.el.removeAttribute('transform');
        s._text = undefined;
      }
    } else if (s.floatEl) s.floatEl.style.transform = '';
  }
}

window.Animator = Animator;

