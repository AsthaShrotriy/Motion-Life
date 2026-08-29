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
/* Per-track peak displacement, and the largest of them.
   `rel` is displacement-from-start per track: [track][frame][dx, dy]. */
function trackEnergy(rel) {
  const per = rel.map(tr => {
    let e = 0;
    for (const p of tr) { const m = Math.hypot(p[0], p[1]); if (m > e) e = m; }
    return e;
  });
  return { per, max: per.length ? Math.max(...per) : 0 };
}

/* [x0, x1, y0, y1] grid-cell window holding the tracks that actually moved, with one
   cell of margin so the moving band is shown with its edge rather than cropped to it.

   Two callers need this and must agree: the field replay below (which maps the target
   object onto the window so no part of the artwork samples static background) and the
   swatch chip in main.js (which subsamples 5x5 for the preview). They matter more now
   than they used to — a field can be mostly frozen ON PURPOSE, because the Step 2
   object mask and segment.py's regions both pin out-of-object cells to their start
   point, so a frame-wide lattice can legitimately sample 25 stationary cells.

   Falls back to the whole grid when nothing crosses the threshold, so a static field
   still yields a valid (if motionless) window instead of an inverted one. */
function activeCellWindow(rel, G) {
  const { per, max } = trackEnergy(rel);
  if (!(max > 0.002)) return [0, G - 1, 0, G - 1];
  const thresh = Math.max(0.004, max * 0.25);
  let x0 = G - 1, x1 = 0, y0 = G - 1, y1 = 0;
  for (let gy = 0; gy < G; gy++)
    for (let gx = 0; gx < G; gx++)
      if (per[gy * G + gx] >= thresh) {
        if (gx < x0) x0 = gx; if (gx > x1) x1 = gx;
        if (gy < y0) y0 = gy; if (gy > y1) y1 = gy;
      }
  if (x1 < x0 || y1 < y0) return [0, G - 1, 0, G - 1];
  return [Math.max(0, x0 - 1), Math.min(G - 1, x1 + 1),
          Math.max(0, y0 - 1), Math.min(G - 1, y1 + 1)];
}

function buildTrajField(motion) {
  // The raw field is preferred when it's here (it is strictly more samples), but a swatch
  // is a complete standalone source: `tracks` + its own `fps` (already divided by the
  // thinning stride) replay at the same speed, within the 2.11px-on-480px error measured
  // in contracts.py. So a motion carrying only a Contract-B swatch animates identically.
  let tracks = motion.trajectories, fps = motion.trajFps || 15;
  if (!tracks || !tracks.length) {
    const sw = (motion.swatches || []).find(s => s && s.kind === 'texture'
                                                 && s.tracks && s.tracks.length);
    if (sw) { tracks = sw.tracks; fps = sw.fps || fps; }
  }
  if (!tracks || tracks.length < 4) return null;
  const G = Math.round(Math.sqrt(tracks.length));          // 12
  if (G * G !== tracks.length) return null;
  const T = tracks[0].length;
  if (T < 4) return null;

  // displacement-from-start per track
  const disp = tracks.map(tr => {
    const x0 = tr[0][0], y0 = tr[0][1];
    return tr.map(p => [p[0] - x0, p[1] - y0]);
  });

  // FROZEN CELLS: the service deliberately pins a track to its start position when the
  // cell is outside the object — an object mask (Step 2) or a segmented region
  // (segment.py). Such a track is a statement that nothing was measured there, NOT a
  // measurement of zero, so it must stay out of every average below. Detected before
  // the mean subtraction, because subtracting a mean makes a frozen track look alive.
  const live = disp.map(tr => tr.some(p => p[0] !== 0 || p[1] !== 0));
  const nLive = live.reduce((n, l) => n + (l ? 1 : 0), 0);
  if (nLive < 4) return null;                              // not enough field left to replay

  // DEFORM-IN-PLACE: a flowing river / rippling silk has a strong bulk drift —
  // every point travels the same way, so replaying it raw would slide the
  // WHOLE object off its bed and leave the region empty. Subtract the
  // per-frame mean displacement so only the *relative* motion remains: the
  // surface ripples and flows in place, the shape stays where it belongs.
  // The mean is over LIVE tracks only. Dividing by all 144 instead under-subtracted the
  // drift by 144/nLive — on an 8-live-cell masked field that is 18x, enough to slide the
  // shape clean off its bed. Identical arithmetic when nothing is frozen.
  for (let fi = 0; fi < T; fi++) {
    let mx = 0, my = 0;
    for (let c = 0; c < disp.length; c++) {
      if (live[c]) { mx += disp[c][fi][0]; my += disp[c][fi][1]; }
    }
    mx /= nLive; my /= nLive;
    for (let c = 0; c < disp.length; c++) {
      if (live[c]) { disp[c][fi][0] -= mx; disp[c][fi][1] -= my; }
    }
  }

  // ACTIVE REGION: the moving object usually fills only part of the video
  // frame (a flag against sky, waves in the lower half). Find the grid cells
  // with real motion and map the target object onto that window only —
  // otherwise parts of the artwork would sample static background and freeze.
  if (trackEnergy(disp).max < 0.002) return null;          // nothing moved
  const [x0g, x1g, y0g, y1g] = activeCellWindow(disp, G);
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

/*
 * ---- Mesh warp: rigid Moving Least Squares (Step 8) ----
 * fieldD() below displaces every sampled point INDEPENDENTLY. The field is bilinear over a
 * 12x12 grid, so two neighbouring points that straddle a cell boundary can be pulled apart
 * by most of a cell — on clean geometric artwork (a flag's stripes) that shear reads as
 * TEARING, which is why cloth had to opt out of real motion and use a synthetic sine.
 *
 * Instead: sample the field at a COARSE lattice of control points and map every path point
 * with Moving Least Squares using RIGID transforms (Schaefer, McPhail & Warren 2006,
 * "Image Deformation Using Moving Least Squares", §rigid). Each point's displacement is a
 * smooth weighted blend of the control displacements, and each local map is as close to a
 * rotation + translation as the control positions allow.
 *
 * MEASURED, on the real flag.mp4 field (16 time samples, 4px patches, distortion =
 * how far a patch's corners land from the nearest pure rotation+translation of it,
 * as a % of the patch size — i.e. how much the shape was sheared rather than moved):
 *
 *              per-point fieldD          rigid MLS mesh warp
 *   median          27.3%                       9.4%
 *   p95             86.8%                      33.1%          <- 3x better
 *   max            153%                        67.5%
 *
 * fieldD's 153% means a patch's corners end up further from their rigid position than the
 * patch is WIDE — that is the stripe-mangling cloth had to opt out of. So this is a large
 * improvement, but note what it is NOT: "as-rigid-as-possible" is not rigid, and a coarse
 * lattice over a chaotic field still stretches a patch by tens of percent. The guarantee
 * the warp does give is continuity — it is a smooth function of position, so neighbouring
 * geometry stays neighbouring and cannot separate outright.
 *
 * It is still the real captured field driving it — the lattice is where the field is read,
 * not a replacement for it.
 *
 * anchor:'x0' pins the lattice's leading (minX) column and ramps displacement across the
 * width — cloth on a pole stays pinned (measured: pole edge 1.3px, free edge 24.3px) and
 * whips at the free edge. Same ramp exponent as the synthetic wave, so the two agree on
 * where a flag is held. 'none' leaves the whole lattice free (a river surface is not
 * pinned to anything).
 */
// Lattice density is a distortion/detail trade, and it costs NOTHING in motion: the
// free-edge whip measured 24.3px at every setting below, only the distortion moved.
//   3x3 -> p95 29.2%   4x3 -> 30.3%   5x4 -> 33.1%   6x5 -> 39.1%   12x12 -> 47.7%
// 5x4 keeps more of the field's real spatial structure (a flag has more than one fold
// across its width) for 4 points of p95 over the flattest option.
const MLS_LATTICE = [5, 4];      // control points across x, y — coarse on purpose
const MLS_ALPHA = 1.0;           // weight falloff: w = 1/|p-v|^(2*alpha)
const MLS_EPS = 1e-9;

function buildMeshWarp(field, box, opts) {
  if (typeof field !== 'function') return null;
  const o = opts || {};
  const NX = (o.lattice || MLS_LATTICE)[0], NY = (o.lattice || MLS_LATTICE)[1];
  const w = Math.max(1, box.maxX - box.minX), h = Math.max(1, box.maxY - box.minY);
  const anchor = o.anchor || 'none';
  const px = [], py = [], pu = [], pv = [], ramp = [];
  for (let j = 0; j < NY; j++) {
    for (let i = 0; i < NX; i++) {
      const u = NX > 1 ? i / (NX - 1) : 0.5, v = NY > 1 ? j / (NY - 1) : 0.5;
      px.push(box.minX + u * w); py.push(box.minY + v * h);
      pu.push(u); pv.push(v);
      ramp.push(anchor === 'x0' ? Math.pow(u, 1.15) : 1);
    }
  }
  const N = px.length;
  const qx = new Float64Array(N), qy = new Float64Array(N), ws = new Float64Array(N);
  let atT = NaN, atI = NaN;
  const place = (t, intensity) => {
    if (t === atT && intensity === atI) return;
    for (let i = 0; i < N; i++) {
      const s = field(pu[i], pv[i], t);
      qx[i] = px[i] + s.dx * w * 0.5 * intensity * ramp[i];
      qy[i] = py[i] + s.dy * h * 0.5 * intensity * ramp[i];
    }
    atT = t; atI = intensity;
  };

  /* (x,y,t,intensity) -> {x, y, rot} — rot is the local rotation in degrees, which a
     detail path can ride so an emblem turns with the cloth instead of only sliding. */
  const warp = function warp(x, y, t, intensity = 1) {
    place(t, intensity);
    let sw = 0, pcx = 0, pcy = 0, qcx = 0, qcy = 0;
    for (let i = 0; i < N; i++) {
      const ax = px[i] - x, ay = py[i] - y;
      const d2 = ax * ax + ay * ay;
      // MLS interpolates its control points exactly; at one the weight is infinite
      if (d2 < MLS_EPS) return { x: qx[i], y: qy[i], rot: 0 };
      const wi = 1 / Math.pow(d2, MLS_ALPHA);
      ws[i] = wi; sw += wi;
      pcx += wi * px[i]; pcy += wi * py[i];
      qcx += wi * qx[i]; qcy += wi * qy[i];
    }
    pcx /= sw; pcy /= sw; qcx /= sw; qcy /= sw;
    const vx = x - pcx, vy = y - pcy;
    // f_r(v) = |v-p*| * normalize( SUM q^_i * A_i ) + q*,  A_i = w_i * [[p^_i],[-p^_i|]] . [[v-p*],[-(v-p*)|]]^T
    // which reduces to the 2x2 rotation-scale [[a,b],[-b,a]] below (|  = perpendicular)
    let fx = 0, fy = 0;
    for (let i = 0; i < N; i++) {
      const ax = px[i] - pcx, ay = py[i] - pcy;
      const bx = qx[i] - qcx, by = qy[i] - qcy;
      const a = ws[i] * (ax * vx + ay * vy);
      const b = ws[i] * (ax * vy - ay * vx);
      fx += bx * a - by * b;
      fy += bx * b + by * a;
    }
    const fl = Math.hypot(fx, fy), vl = Math.hypot(vx, vy);
    if (fl < MLS_EPS || vl < MLS_EPS) return { x: qcx + vx, y: qcy + vy, rot: 0 };
    let rot = Math.atan2(fy, fx) - Math.atan2(vy, vx);
    while (rot > Math.PI) rot -= 2 * Math.PI;
    while (rot < -Math.PI) rot += 2 * Math.PI;
    const k = vl / fl;
    return { x: qcx + fx * k, y: qcy + fy * k, rot: rot * 180 / Math.PI };
  };
  warp.controls = N;
  warp.anchor = anchor;
  return warp;
}

/* One frame of MESH-WARPED deformation for a sampled path (the tear-free fieldD). */
function meshD(pd, warp, t, intensity) {
  let d = '';
  for (let i = 0; i < pd.pts.length; i++) {
    const p = warp(pd.pts[i][0], pd.pts[i][1], t, intensity);
    d += (i ? 'L' : 'M') + p.x.toFixed(2) + ',' + p.y.toFixed(2);
  }
  return pd.closed ? d + 'Z' : d;
}

/* Ride the mesh warp with crisp geometry: translate AND rotate a detail path by the
   warp's local rigid transform at its center (the "ride, don't deform" rule). */
function detailRideMesh(pd, warp, t, intensity) {
  const p = warp(pd.cx, pd.cy, t, intensity);
  pd.el.setAttribute('transform',
    `translate(${(p.x - pd.cx).toFixed(2)} ${(p.y - pd.cy).toFixed(2)}) `
    + `rotate(${p.rot.toFixed(2)} ${pd.cx.toFixed(1)} ${pd.cy.toFixed(1)})`);
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

function buildWaveData(wrap, opts) {
  const paths = [];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  // group bbox first, so we can tell big "cloth" paths (stripes) from small
  // high-detail paths (a flag's Ashoka chakra, an emblem) that must NOT be
  // point-resampled — resampling 48 points destroys their fine geometry.
  let gb; try { gb = wrap.getBBox(); } catch { gb = null; }
  const gw = gb ? gb.width : 0, gh = gb ? gb.height : 0;
  const DETAIL_FRAC = 0.34;   // path smaller than this fraction of the group → ride rigidly
  // sampleAll: coherent cloth (a multi-fill illustration skirt/dress). Every path is
  // point-sampled and deformed through the SAME warp, so stacked fills move together and
  // never separate into gaps. Detail-riding is for a FEW crisp emblems on a big cloth
  // (a flag + chakra); on 35 shading shapes it tears the garment apart.
  const sampleAll = !!(opts && opts.sampleAll);
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
    const isDetail = !sampleAll && pb && gw && gh &&
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

/*
 * ---- Coordinate-level path warp (tear-free deformation) ----
 * The polyline resampler above (getPointAtLength → 72 straight chords) flattens béziers
 * and samples each path independently, so curved, layered art loses fidelity and stacked
 * shapes' shared edges drift apart into slivers. warpPathD instead moves the path's OWN
 * coordinates — every anchor AND every bézier control point — through a continuous
 * displacement `disp(x, y) -> [x2, y2]`, and re-emits the same command structure. Curves
 * stay curves; a point shared by two paths maps identically, so nothing can tear.
 * Handles M/L/H/V/C/S/Q/T/A/Z (absolute + relative). Arc radii/flags pass through; only
 * the arc endpoint is warped (arcs are rare in this art).
 */
function warpPathD(d, disp) {
  const segs = d.match(/[MmLlHhVvCcSsQqTtAaZz][^MmLlHhVvCcSsQqTtAaZz]*/g);
  if (!segs) return d;
  let out = '', cx = 0, cy = 0, sx = 0, sy = 0;   // current point, subpath start
  const P = (x, y) => { const p = disp(x, y); return p[0].toFixed(2) + ',' + p[1].toFixed(2); };
  for (const seg of segs) {
    const cmd = seg[0], C = cmd.toUpperCase(), rel = cmd >= 'a' && cmd <= 'z';
    if (C === 'Z') { out += 'Z'; cx = sx; cy = sy; continue; }
    const nums = (seg.slice(1).match(/-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) || []).map(Number);
    let i = 0;
    if (C === 'M') {
      let first = true;
      while (i + 1 < nums.length) {
        const ax = rel ? cx + nums[i] : nums[i], ay = rel ? cy + nums[i + 1] : nums[i + 1];
        out += (first ? 'M' : 'L') + P(ax, ay); cx = ax; cy = ay;
        if (first) { sx = ax; sy = ay; first = false; }
        i += 2;
      }
    } else if (C === 'L') {
      while (i + 1 < nums.length) { const ax = rel ? cx + nums[i] : nums[i], ay = rel ? cy + nums[i + 1] : nums[i + 1]; out += 'L' + P(ax, ay); cx = ax; cy = ay; i += 2; }
    } else if (C === 'H') {
      while (i < nums.length) { const ax = rel ? cx + nums[i] : nums[i]; out += 'L' + P(ax, cy); cx = ax; i += 1; }
    } else if (C === 'V') {
      while (i < nums.length) { const ay = rel ? cy + nums[i] : nums[i]; out += 'L' + P(cx, ay); cy = ay; i += 1; }
    } else if (C === 'C') {
      while (i + 5 < nums.length) {
        const x1 = rel ? cx + nums[i] : nums[i], y1 = rel ? cy + nums[i + 1] : nums[i + 1];
        const x2 = rel ? cx + nums[i + 2] : nums[i + 2], y2 = rel ? cy + nums[i + 3] : nums[i + 3];
        const ex = rel ? cx + nums[i + 4] : nums[i + 4], ey = rel ? cy + nums[i + 5] : nums[i + 5];
        out += 'C' + P(x1, y1) + ' ' + P(x2, y2) + ' ' + P(ex, ey); cx = ex; cy = ey; i += 6;
      }
    } else if (C === 'S' || C === 'Q') {
      while (i + 3 < nums.length) {
        const x1 = rel ? cx + nums[i] : nums[i], y1 = rel ? cy + nums[i + 1] : nums[i + 1];
        const ex = rel ? cx + nums[i + 2] : nums[i + 2], ey = rel ? cy + nums[i + 3] : nums[i + 3];
        out += C + P(x1, y1) + ' ' + P(ex, ey); cx = ex; cy = ey; i += 4;
      }
    } else if (C === 'T') {
      while (i + 1 < nums.length) { const ex = rel ? cx + nums[i] : nums[i], ey = rel ? cy + nums[i + 1] : nums[i + 1]; out += 'T' + P(ex, ey); cx = ex; cy = ey; i += 2; }
    } else if (C === 'A') {
      while (i + 6 < nums.length) {
        const ex = rel ? cx + nums[i + 5] : nums[i + 5], ey = rel ? cy + nums[i + 6] : nums[i + 6];
        const p = disp(ex, ey);
        out += 'A' + nums[i] + ',' + nums[i + 1] + ' ' + nums[i + 2] + ' ' + nums[i + 3] + ' ' + nums[i + 4] + ' ' + p[0].toFixed(2) + ',' + p[1].toFixed(2);
        cx = ex; cy = ey; i += 7;
      }
    }
  }
  return out;
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
