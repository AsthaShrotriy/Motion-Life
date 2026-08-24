/* motionfields.js — pure motion-field helpers used by the Animator (animate.js):
   parametric motion (computeMotion), curl-noise, RAFT trajectory-field replay,
   text-glyph fields, and cloth/wave deformation. No DOM/class state; loaded BEFORE
   animate.js so its class can reference these via the shared global scope. */
const AMP_PX = 16;     // svg viewBox units at amplitude 1
const TURB_PX = 11;
const DRIFT_PX = 26;   // bounded travel range for steady drift (driftX/driftY)
const DRIFT_PERIOD = 10; // seconds per drift loop

function _hash(n) { const s = Math.sin(n) * 43758.5453; return s - Math.floor(s); }
function _noise(x) { const i = Math.floor(x), f = x - i; const u = f * f * (3 - 2 * f); return _hash(i) * (1 - u) + _hash(i + 1) * u; }
function _curl(x, y, t) {
  const s = 0.015;
  return {
    x: (_noise(x * s + t * 1.7 + 5.2) - 0.5) * 2 + (_noise(x * s * 3 + t * 3.1 + y * s * 2) - 0.5),
    y: (_noise(y * s + t * 1.9 + 91.7) - 0.5) * 2 + (_noise(y * s * 3 + t * 2.7 + x * s * 2) - 0.5),
  };
}
function _env(t, damping, seed) {
  if (damping <= 0.02) return 1;
  const rate = 0.6 + damping * 1.8;
  const n = _noise(t * rate + seed * 37.7);
  return (1 - damping) + damping * Math.pow(n, 1 + damping * 4) * 2.2;
}

/*
 * Pure displacement function — shared by the Animator and the motion-card
 * previews so a preview shows exactly what the motion will do to an object.
 * Returns {dx, dy, rot} where dx/dy are in viewBox units and rot is degrees.
 */
function computeMotion(params, seed, t, intensity = 1) {
  const p = params;
  const th = p.direction * Math.PI / 180;
  const dir = { x: Math.cos(th), y: -Math.sin(th) };
  const env = _env(t, p.damping, seed);
  const osc = Math.sin(2 * Math.PI * p.frequency * t + seed * p.phaseSpread * 3.0);
  const turb = _curl(seed * 40, seed * 70, t + seed);
  const A = p.amplitude * AMP_PX * intensity * env;
  // steady drift (falling leaves, flowing water): captured as driftX/driftY.
  // A poster object can't leave the frame, so drift becomes a slow sawtooth
  // loop — travels DRIFT_PX in the drift direction, eases back, repeats.
  let ddx = 0, ddy = 0;
  const dxv = p.driftX || 0, dyv = p.driftY || 0;
  if (dxv || dyv) {
    const phase = (t % DRIFT_PERIOD) / DRIFT_PERIOD;          // 0..1
    const loop = phase < 0.85 ? phase / 0.85 : (1 - phase) / 0.15; // ramp out, ease back
    ddx = dxv * DRIFT_PX * loop * intensity;
    ddy = dyv * DRIFT_PX * loop * intensity;
  }
  return {
    dx: A * osc * dir.x + p.turbulence * TURB_PX * turb.x * env * intensity + ddx,
    dy: A * osc * dir.y + p.turbulence * TURB_PX * turb.y * env * intensity + ddy,
    rot: (0.06 * p.amplitude * intensity * env
        * Math.cos(2 * Math.PI * p.frequency * t)) * (180 / Math.PI),
  };
}

/*
 * ---- Trajectory-field replay ----
 * Captured motions carry a 12x12 grid of REAL point trajectories from the
 * source video (normalized coords). Instead of a synthetic sine, we can
 * replay that field: each sampled path point bilinearly samples the
 * displacement of the corresponding region of the SOURCE VIDEO at time t.
 * The flag's free edge whips like the real free edge; water churns like the
 * real water; local stretching/compression (foreshortening) emerges because
 * neighboring points genuinely converge/diverge like they did on camera.
 *
 * buildTrajField(motion) → sampler(u, v, t) -> {dx, dy} in unit-square units
 */
function buildTrajField(motion) {
  const tracks = motion.trajectories;
  if (!tracks || tracks.length < 4) return null;
  const G = Math.round(Math.sqrt(tracks.length));          // 12
  if (G * G !== tracks.length) return null;
  const T = tracks[0].length;
  if (T < 4) return null;
  const fps = motion.trajFps || 15;

  // displacement-from-start per track
  const disp = tracks.map(tr => {
    const x0 = tr[0][0], y0 = tr[0][1];
    return tr.map(p => [p[0] - x0, p[1] - y0]);
  });

  // DEFORM-IN-PLACE: a flowing river / rippling silk has a strong bulk drift —
  // every point travels the same way, so replaying it raw would slide the
  // WHOLE object off its bed and leave the region empty. Subtract the
  // per-frame mean displacement so only the *relative* motion remains: the
  // surface ripples and flows in place, the shape stays where it belongs.
  for (let fi = 0; fi < T; fi++) {
    let mx = 0, my = 0;
    for (let c = 0; c < disp.length; c++) { mx += disp[c][fi][0]; my += disp[c][fi][1]; }
    mx /= disp.length; my /= disp.length;
    for (let c = 0; c < disp.length; c++) { disp[c][fi][0] -= mx; disp[c][fi][1] -= my; }
  }

  // ACTIVE REGION: the moving object usually fills only part of the video
  // frame (a flag against sky, waves in the lower half). Find the grid cells
  // with real motion and map the target object onto that window only —
  // otherwise parts of the artwork would sample static background and freeze.
  const energy = disp.map(tr => {
    let e = 0;
    for (const p of tr) { const m = Math.hypot(p[0], p[1]); if (m > e) e = m; }
    return e;
  });
  const eMax = Math.max(...energy);
  if (eMax < 0.002) return null;                           // nothing moved
  const thresh = Math.max(0.004, eMax * 0.25);
  let x0g = G - 1, x1g = 0, y0g = G - 1, y1g = 0;
  for (let gy = 0; gy < G; gy++)
    for (let gx = 0; gx < G; gx++)
      if (energy[gy * G + gx] >= thresh) {
        if (gx < x0g) x0g = gx; if (gx > x1g) x1g = gx;
        if (gy < y0g) y0g = gy; if (gy > y1g) y1g = gy;
      }
  x0g = Math.max(0, x0g - 1); x1g = Math.min(G - 1, x1g + 1);
  y0g = Math.max(0, y0g - 1); y1g = Math.min(G - 1, y1g + 1);
  const spanX = Math.max(1, x1g - x0g), spanY = Math.max(1, y1g - y0g);
  // active window size in frame units — displacements are normalized by this
  // so motion is proportional to the OBJECT, not the video frame
  const aW = Math.max(0.08, spanX / (G - 1));
  const aH = Math.max(0.08, spanY / (G - 1));

  // ping-pong the loop to avoid the end-snap
  const frameAt = (t) => {
    const f = (t * fps) % (2 * (T - 1));
    return f <= T - 1 ? f : 2 * (T - 1) - f;
  };
  const CAP = 0.55;    // max object-relative displacement

  const sample = function sample(u, v, t) {
    const f = frameAt(t);
    const f0 = Math.floor(f), f1 = Math.min(T - 1, f0 + 1), fw = f - f0;
    const gx = Math.min(G - 1.001, Math.max(0, (x0g + u * spanX)));
    const gy = Math.min(G - 1.001, Math.max(0, (y0g + v * spanY)));
    const xi = Math.floor(gx), yi = Math.floor(gy);
    const xw = gx - xi, yw = gy - yi;
    let dx = 0, dy = 0;
    for (const [ox, oy, w] of [[0, 0, (1 - xw) * (1 - yw)], [1, 0, xw * (1 - yw)],
                               [0, 1, (1 - xw) * yw], [1, 1, xw * yw]]) {
      const tr = disp[Math.min(G - 1, yi + oy) * G + Math.min(G - 1, xi + ox)];
      const a = tr[f0], b = tr[f1];
      dx += w * (a[0] * (1 - fw) + b[0] * fw);
      dy += w * (a[1] * (1 - fw) + b[1] * fw);
    }
    // object-relative units, capped
    return {
      dx: Math.max(-CAP, Math.min(CAP, dx / aW)),
      dy: Math.max(-CAP, Math.min(CAP, dy / aH)),
    };
  };
  sample.period = 2 * (T - 1) / fps;   // seconds per seamless ping-pong loop
  return sample;
}

/* One frame of trajectory-field deformation for a sampled path. */
function fieldD(pd, minX, minY, w, h, field, t, intensity) {
  let d = '';
  for (let i = 0; i < pd.pts.length; i++) {
    const [x0, y0] = pd.pts[i];
    const u = (x0 - minX) / w, v = (y0 - minY) / h;
    const s = field(u, v, t);
    const x = x0 + s.dx * w * 0.5 * intensity;
    const y = y0 + s.dy * h * 0.5 * intensity;
    d += (i ? 'L' : 'M') + x.toFixed(2) + ',' + y.toFixed(2);
  }
  return pd.closed ? d + 'Z' : d;
}

/*
 * ---- Per-glyph text animation ----
 * A <text> block moved rigidly reads as "the poster is shaking". Real
 * text-wearing-motion means each LETTER rides the motion at its own phase.
 * buildTextData splits every <text> in the selection into absolutely
 * positioned per-glyph <text> elements (visually identical — positions come
 * from getStartPositionOfChar, so kerning/letter-spacing/anchor are baked),
 * then the animator transforms each glyph independently: captured motions
 * sample the trajectory field at the glyph's (u,v); presets get a per-letter
 * phase offset. Letters also lean along the local wave slope.
 */
function buildTextData(wrap) {
  if (!wrap.getAttribute('data-ms-textsplit')) {
    const texts = [...wrap.querySelectorAll('text')];
    if (!texts.length) return null;
    for (const t of texts) {
      const content = t.textContent;
      const glyphs = [];
      for (let i = 0; i < content.length; i++) {
        const ch = content[i];
        if (!ch.trim()) continue;
        let pos, ext;
        try { pos = t.getStartPositionOfChar(i); ext = t.getExtentOfChar(i); }
        catch { continue; }
        const g = t.cloneNode(false);
        g.removeAttribute('text-anchor');
        g.removeAttribute('letter-spacing');
        g.setAttribute('x', pos.x.toFixed(2));
        g.setAttribute('y', pos.y.toFixed(2));
        g.setAttribute('data-ms-glyph', '1');
        g.setAttribute('data-ms-cx', (ext.x + ext.width / 2).toFixed(2));
        g.setAttribute('data-ms-cy', (ext.y + ext.height / 2).toFixed(2));
        g.textContent = ch;
        glyphs.push(g);
      }
      if (glyphs.length) {
        for (const g of glyphs) t.parentNode.insertBefore(g, t);
        t.remove();
      }
    }
    wrap.setAttribute('data-ms-textsplit', '1');
  }
  const els = [...wrap.querySelectorAll('text[data-ms-glyph]')];
  if (!els.length) return null;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const items = els.map(el => {
    const cx = parseFloat(el.getAttribute('data-ms-cx'));
    const cy = parseFloat(el.getAttribute('data-ms-cy'));
    if (cx < minX) minX = cx;
    if (cx > maxX) maxX = cx;
    if (cy < minY) minY = cy;
    if (cy > maxY) maxY = cy;
    return { el, cx, cy };
  });
  return { items, minX, maxX, minY, maxY };
}

/*
 * One glyph's transform under a motion at time t.
 *   field mode: sample the captured trajectory field at the glyph's (u,v),
 *               lean along the local slope (difference to the neighbor sample)
 *   preset mode: computeMotion with a per-letter phase seed (u across the line)
 */
function glyphTransform(td, it, field, params, t, intensity) {
  const tw = Math.max(1, td.maxX - td.minX);
  const th = Math.max(8, td.maxY - td.minY);
  const u = (it.cx - td.minX) / tw, v = (it.cy - td.minY) / th;
  let dx, dy, rot;
  if (field) {
    const c = field(u, v, t);
    dx = c.dx * tw * 0.5 * intensity;
    dy = c.dy * Math.max(th, tw * 0.2) * 0.5 * intensity;
    const cR = field(Math.min(1, u + 0.08), v, t);
    rot = (cR.dy - c.dy) * 60 * intensity;             // lean along wave slope
  } else {
    // per-letter phase: u spans 0..1 across the line; scale by phaseSpread so
    // high-spread motions (flutter/wave) travel visibly through the word
    const d = computeMotion(params, u * 2.2, t, intensity);
    dx = d.dx; dy = d.dy; rot = d.rot;
    // add an explicit vertical wave component riding through the letters —
    // pure-horizontal motions otherwise leave letters in near-lockstep
    const wavePhase = 2 * Math.PI * params.frequency * t - u * Math.PI * 2 * (0.5 + params.phaseSpread);
    const waveAmp = 4 * params.amplitude * intensity * (0.3 + params.phaseSpread);
    dy += waveAmp * Math.sin(wavePhase);
    rot += waveAmp * 0.55 * Math.cos(wavePhase);
  }
  return `translate(${dx.toFixed(2)} ${dy.toFixed(2)}) rotate(${rot.toFixed(2)} ${it.cx} ${it.cy})`;
}

/*
 * ---- Wave (cloth) deformation ----
 * Rigid transforms slide an object around; cloth needs the geometry itself
 * to ripple. Wave mode samples every <path> in the selection into WAVE_SAMPLES
 * points and, each frame, displaces each point with a traveling wave:
 *
 *   dy(x,t) = A · ramp(x) · sin(2πf·t − k·(x − xmin))
 *
 * ramp(x) grows 0→1 from the anchored edge (pole side) to the free tip, so
 * the cloth stays pinned at the pole and whips at the end — like a real flag.
 */
const WAVE_SAMPLES = 72;        // more samples so extra folds render smoothly
const WAVE_AMP_PX = 12;         // amplitude at amplitude=1, intensity=1
const WAVE_CYCLES = 2.6;        // wavelengths across the object's width (more folds = wavier)

function buildWaveData(wrap) {
  const paths = [];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  // group bbox first, so we can tell big "cloth" paths (stripes) from small
  // high-detail paths (a flag's Ashoka chakra, an emblem) that must NOT be
  // point-resampled — resampling 48 points destroys their fine geometry.
  let gb; try { gb = wrap.getBBox(); } catch { gb = null; }
  const gw = gb ? gb.width : 0, gh = gb ? gb.height : 0;
  const DETAIL_FRAC = 0.34;   // path smaller than this fraction of the group → ride rigidly
  const els = [...wrap.querySelectorAll('path')];
  for (const el of els) {
    // remember the pristine geometry (survives re-application / re-build)
    let d0 = el.getAttribute('data-ms-d0');
    if (!d0) { d0 = el.getAttribute('d'); el.setAttribute('data-ms-d0', d0); }
    else el.setAttribute('d', d0);
    const len = el.getTotalLength();
    if (!len) continue;
    let pb; try { pb = el.getBBox(); } catch { pb = null; }
    // detail path: small vs. the whole group in BOTH dimensions → keep its exact
    // geometry and just translate it to follow the cloth (crisp chakra/emblem)
    const isDetail = pb && gw && gh &&
      (pb.width < gw * DETAIL_FRAC && pb.height < gh * DETAIL_FRAC);
    if (isDetail) {
      const cx = pb.x + pb.width / 2, cy = pb.y + pb.height / 2;
      paths.push({ el, detail: true, cx, cy });
      if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
      continue;
    }
    const pts = [];
    for (let i = 0; i <= WAVE_SAMPLES; i++) {
      const pt = el.getPointAtLength(len * i / WAVE_SAMPLES);
      pts.push([pt.x, pt.y]);
      if (pt.x < minX) minX = pt.x;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y < minY) minY = pt.y;
      if (pt.y > maxY) maxY = pt.y;
    }
    paths.push({ el, pts, closed: /z\s*$/i.test(d0) });
  }
  return paths.length ? { paths, minX, maxX, minY, maxY } : null;
}

/* Translate a detail (non-resampled) path so it rides the cloth's displacement
 * at its center. Keeps the path's crisp original geometry intact. */
function detailRide(pd, minX, minY, w, h, field, t, intensity) {
  const u = (pd.cx - minX) / w, v = (pd.cy - minY) / h;
  const s = field(u, v, t);
  const dx = s.dx * w * 0.5 * intensity;
  const dy = s.dy * h * 0.5 * intensity;
  pd.el.setAttribute('transform', `translate(${dx.toFixed(2)} ${dy.toFixed(2)})`);
}

/* One frame of the wave: returns the new `d` string for a sampled path. */
function waveD(pd, minX, width, A, k, phase, turb) {
  let d = '';
  for (let i = 0; i < pd.pts.length; i++) {
    const [x0, y0] = pd.pts[i];
    const ramp = Math.pow((x0 - minX) / width, 1.15);
    const arg = phase - k * (x0 - minX);
    // primary traveling fold + a faster, shallower second harmonic so the flag
    // shows several overlapping ripples (wavier, like real wind-blown cloth)
    const dy = A * ramp * Math.sin(arg)
             + A * 0.32 * ramp * Math.sin(arg * 2.0 + 1.3)
             + turb * ramp * _noise(x0 * 0.11 + phase * 1.3);
    const dx = A * 0.22 * ramp * Math.cos(arg);
    d += (i ? 'L' : 'M') + (x0 + dx).toFixed(2) + ',' + (y0 + dy).toFixed(2);
  }
  return pd.closed ? d + 'Z' : d;
}

window.computeMotion = computeMotion;
