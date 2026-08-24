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

class Animator {
  constructor(selectionManager, motionLibrary) {
    this.sel = selectionManager;
    this.motions = motionLibrary;
    this.playing = false;
    this.t0 = performance.now() / 1000;
    this._raf = null;
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
      const motion = this.motions.getById(s.motionId);
      if (!motion) continue;

      const speed = s.speed || 1, intensity = s.intensity || 1;
      const rt = t * speed;
      const seed = s.kind === 'svg'
        ? (s.center[0] * 0.01 + s.center[1] * 0.03)
        : (s.bounds.x * 0.01 + s.bounds.y * 0.03);

      // ---- character / skeletal motion: a pose-sequence swatch drives a rig ----
      if (s.kind === 'svg' && motion.pose && motion.pose.frames &&
          s.wrap.querySelector('[data-motion-mode="character"], [data-role="body"]')) {
        this._applyCharacter(s, motion, rt, intensity);
        continue;
      }

      // Keep dense canopy artwork intact; only sway its selectable overlay.
      if (s.kind === 'svg' && s.wrap.querySelector('[data-motion-role="tree-canopy"]')) {
        this._applyTreeLeaves(s, motion, rt, intensity);
        continue;
      }

      // ---- realistic falling leaves: each child leaf falls independently ----
      if (s.kind === 'svg' && motion.params && motion.params.leafFall) {
        this._applyLeafFall(s, motion, rt, intensity);
        continue;
      }

      // ---- hardcoded scenery behaviors, keyed on the object's name ----
      // (demo curation: whatever swatch is dropped on the "birds" / "clouds"
      //  group, it animates the way a viewer expects that object to move.)
      if (s.kind === 'svg' && /\bbirds?\b/i.test(s.name)) {
        this._applyBirds(s, motion, rt, intensity);
        continue;
      }
      if (s.kind === 'svg' && /\bclouds?\b/i.test(s.name)) {
        this._applyClouds(s, motion, rt, intensity);
        continue;
      }
      if (s.kind === 'svg' && /\briver|ripples?\b/i.test(s.name)) {
        this._applyRiver(s, motion, rt, intensity);
        continue;
      }
      if (s.kind === 'svg' && /\bboat|rowboat|canoe|ferry|ship\b/i.test(s.name)) {
        this._applyBoat(s, motion, rt, intensity);
        continue;
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
          continue;
        }
      }

      // ---- wave (cloth) mode: deform the geometry itself ----
      if (s.kind === 'svg' && s.waveMode) {
        if (!s._wave) s._wave = buildWaveData(s.wrap);
        if (s._wave) {
          const width = Math.max(1, s._wave.maxX - s._wave.minX);
          // captured motion with trajectories → replay the REAL motion field
          if (s._field === undefined) s._field = buildTrajField(motion) || null;
          if (s._field && s._fieldMotion !== motion.id) {
            s._field = buildTrajField(motion) || null;
            s._fieldMotion = motion.id;
          }
          // A FLAG must flutter as one coherent sheet anchored at the pole. The
          // raw captured trajectory field is chaotic and, replayed independently
          // on clean geometric stripes, tears them apart. So for flag-like
          // objects we always use the coherent synthetic pole-anchored wave —
          // still DRIVEN by the captured motion's params (freq/amplitude from
          // the real video), just applied as a smooth traveling wave.
          const coherent = /flag|banner|pennant|ensign|standard/i.test(s.name);
          if (s._field && !coherent) {
            const height = Math.max(1, s._wave.maxY - s._wave.minY);
            for (const pd of s._wave.paths) {
              if (pd.detail) {
                // fine detail (chakra/emblem): ride the cloth, keep crisp geometry
                detailRide(pd, s._wave.minX, s._wave.minY, width, height, s._field, rt, intensity);
              } else {
                pd.el.setAttribute('d', fieldD(pd, s._wave.minX, s._wave.minY,
                  width, height, s._field, rt, intensity));
              }
            }
          } else {
            // preset → synthetic traveling sine
            const p = motion.params;
            const A = WAVE_AMP_PX * (0.35 + p.amplitude) * intensity;
            const k = 2 * Math.PI * WAVE_CYCLES * (0.5 + p.phaseSpread) / width;
            const phase = 2 * Math.PI * p.frequency * rt;
            const turb = p.turbulence * 4 * intensity;
            const height = Math.max(1, s._wave.maxY - s._wave.minY);
            for (const pd of s._wave.paths) {
              if (pd.detail) {
                // ride the synthetic wave at the detail's x, keeping crisp geometry
                const ramp = Math.pow((pd.cx - s._wave.minX) / width, 1.15);
                const arg = phase - k * (pd.cx - s._wave.minX);
                const dyv = A * ramp * Math.sin(arg) + turb * ramp * _noise(pd.cx * 0.11 + phase * 1.3);
                const dxv = A * 0.22 * ramp * Math.cos(arg);
                pd.el.setAttribute('transform', `translate(${dxv.toFixed(2)} ${dyv.toFixed(2)})`);
              } else {
                pd.el.setAttribute('d', waveD(pd, s._wave.minX, width, A, k, phase, turb));
              }
            }
          }
          s.wrap.setAttribute('transform', '');
          continue;
        }
      }

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
  }

  // deterministic pseudo-random in [0,1) from a leaf index + channel
  _leafRnd(i, k) { const x = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453; return x - Math.floor(x); }

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
      s._river = buildWaveData(wrap);       // sampled pristine geometry per <path>
    }
    if (!s._river) { wrap.setAttribute('transform', ''); return; }
    const rv = s._river;
    const width = Math.max(1, rv.maxX - rv.minX);
    const height = Math.max(1, rv.maxY - rv.minY);
    const p = motion.params || {};
    // laminar tuning: long wavelength (few gentle crests across the width),
    // slow drift, shallow amplitude. Scale mildly by the preset's amplitude so
    // the Intensity slider still has a natural effect, but keep it calm.
    const A = 3.4 * (0.6 + (p.amplitude || 0.2)) * intensity;   // vertical swell (units)
    const k = 2 * Math.PI * 1.15 / width;                       // ~1 crest across the river
    const f = 0.28 * (0.6 + (p.frequency || 1.0) * 0.5);        // slow downstream speed
    const phase = 2 * Math.PI * f * t;
    const flow = 5.0 * intensity;                               // along-stream crest slide
    for (const pd of rv.paths) {
      let d = '';
      for (let i = 0; i < pd.pts.length; i++) {
        const [x0, y0] = pd.pts[i];
        // per-scanline phase offset → the surface flows downstream, not in lockstep
        const yPhase = (y0 - rv.minY) / height * Math.PI * 1.3;
        const arg = k * (x0 - rv.minX) - phase + yPhase;
        // primary swell + a small, slower second harmonic for organic surface
        const dy = A * Math.sin(arg) + A * 0.35 * Math.sin(arg * 0.5 + phase * 0.6);
        // gentle downstream shear so crests glide along the current
        const dx = flow * Math.cos(arg) * 0.5;
        d += (i ? 'L' : 'M') + (x0 + dx).toFixed(2) + ',' + (y0 + dy).toFixed(2);
      }
      pd.el.setAttribute('d', pd.closed ? d + 'Z' : d);
    }
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
      const frames = motion.pose.frames.filter(Boolean);
      const jn = {}; motion.pose.joints.forEach((n, i) => jn[n] = i);
      // mean hip / nose Y to centre the vertical bob
      let sh = 0, sn = 0;
      for (const f of frames) { sh += (f[jn.l_hip][1] + f[jn.r_hip][1]) / 2; sn += f[jn.nose][1]; }
      let bb; try { bb = wrap.getBBox(); } catch (_) { bb = { x: 0, y: 0, width: 1, height: 1 }; }
      s._char = {
        frames, jn, fps: motion.pose.fps || 15,
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
    for (const s of this.sel.selections) {
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
      if (s.kind === 'svg' && s.wrap) {
        s.wrap.setAttribute('transform', '');
        // restore pristine geometry for wave-deformed paths, and clear any
        // per-path transform used to ride detail elements (e.g. flag chakra)
        for (const el of s.wrap.querySelectorAll('path[data-ms-d0]')) {
          el.setAttribute('d', el.getAttribute('data-ms-d0'));
          el.removeAttribute('transform');
        }
        s._wave = null;
        s._river = null;
        s._boat = null;
        s._field = undefined;
        s._fieldMotion = null;
        // reset per-glyph transforms (glyph split itself is kept — harmless)
        if (s._text) {
          for (const it of s._text.items) it.el.removeAttribute('transform');
          s._text = undefined;
        }
      } else if (s.floatEl) s.floatEl.style.transform = '';
    }
    this.sel.syncHighlights();
  }
}

window.Animator = Animator;

