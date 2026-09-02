/*
 * distill.js — flow tensor → swatch parameters (carried from v1).
 */

function distillSwatch(frames, fps) {
  const T = frames.length;
  if (T < 16) return null;

  const gvx = new Float64Array(T);
  const gvy = new Float64Array(T);
  for (let t = 0; t < T; t++) {
    let sx = 0, sy = 0, n = 0;
    for (const p of frames[t]) { if (p.valid) { sx += p.vx; sy += p.vy; n++; } }
    gvx[t] = n ? sx / n : 0;
    gvy[t] = n ? sy / n : 0;
  }
  const mx = _mean(gvx), my = _mean(gvy);
  for (let t = 0; t < T; t++) { gvx[t] -= mx; gvy[t] -= my; }

  let cxx = 0, cxy = 0, cyy = 0;
  for (let t = 0; t < T; t++) { cxx += gvx[t] ** 2; cxy += gvx[t] * gvy[t]; cyy += gvy[t] ** 2; }
  const disc = Math.sqrt(Math.max(0, (cxx - cyy) ** 2 / 4 + cxy ** 2));
  const l1 = (cxx + cyy) / 2 + disc;
  let ax, ay;
  if (Math.abs(cxy) > 1e-9) { ax = l1 - cyy; ay = cxy; }
  else if (cxx >= cyy) { ax = 1; ay = 0; } else { ax = 0; ay = 1; }
  const alen = Math.hypot(ax, ay) || 1; ax /= alen; ay /= alen;
  let direction = Math.atan2(-ay, ax) * 180 / Math.PI;
  if (direction < 0) direction += 180;
  if (direction >= 180) direction -= 180;

  const proj = new Float64Array(T);
  for (let t = 0; t < T; t++) proj[t] = gvx[t] * ax + gvy[t] * ay;

  const { spectrum, peakBin } = _dft(proj);
  const binHz = fps / T;
  let freqHz = peakBin * binHz;
  if (peakBin > 1 && peakBin < spectrum.length - 1) {
    const a = Math.log(spectrum[peakBin - 1] + 1e-12);
    const b = Math.log(spectrum[peakBin] + 1e-12);
    const c = Math.log(spectrum[peakBin + 1] + 1e-12);
    const d = 0.5 * (a - c) / (a - 2 * b + c || 1e-12);
    if (Math.abs(d) < 1) freqHz = (peakBin + d) * binHz;
  }
  freqHz = Math.max(0.05, Math.min(8, freqHz));

  let rms = 0;
  for (let t = 0; t < T; t++) rms += gvx[t] ** 2 + gvy[t] ** 2;
  rms = Math.sqrt(rms / T);
  const amplitude = _clamp(rms / 1.5);

  const flatness = _spectralFlatness(spectrum);
  const disorder = _spatialDisorder(frames);
  const turbulence = _clamp(0.5 * flatness + 0.5 * disorder);

  const damping = _autocorrDecay(proj, fps, freqHz);
  const phaseSpread = _phaseSpread(frames, ax, ay, peakBin);

  return {
    frequency: _r3(freqHz), amplitude: _r3(amplitude), direction: Math.round(direction),
    turbulence: _r3(turbulence), damping: _r3(damping), phaseSpread: _r3(phaseSpread),
  };
}

function _mean(a) { let s = 0; for (const v of a) s += v; return s / a.length; }
function _clamp(v) { return Math.max(0, Math.min(1, v)); }
function _r3(v) { return Math.round(v * 1000) / 1000; }

function _dft(signal) {
  const T = signal.length, half = T >> 1;
  const spectrum = new Float64Array(half + 1);
  let peakBin = 1, peakMag = -1;
  for (let k = 1; k <= half; k++) {
    let re = 0, im = 0;
    for (let t = 0; t < T; t++) { const ph = -2 * Math.PI * k * t / T; re += signal[t] * Math.cos(ph); im += signal[t] * Math.sin(ph); }
    spectrum[k] = Math.hypot(re, im);
    if (spectrum[k] > peakMag) { peakMag = spectrum[k]; peakBin = k; }
  }
  return { spectrum, peakBin };
}

function _spectralFlatness(spectrum) {
  let logSum = 0, sum = 0, n = 0;
  for (let k = 1; k < spectrum.length; k++) { const p = spectrum[k] ** 2 + 1e-12; logSum += Math.log(p); sum += p; n++; }
  return n ? _clamp(Math.exp(logSum / n) / (sum / n)) : 0;
}

function _spatialDisorder(frames) {
  let acc = 0, cnt = 0;
  for (const frame of frames) {
    let cx = 0, cy = 0, wsum = 0;
    for (const p of frame) { if (!p.valid) continue; const m = Math.hypot(p.vx, p.vy); if (m < 0.05) continue; cx += p.vx / m * m; cy += p.vy / m * m; wsum += m; }
    if (wsum < 0.3) continue;
    acc += 1 - Math.hypot(cx, cy) / wsum; cnt++;
  }
  return cnt ? acc / cnt : 0;
}

function _autocorrDecay(signal, fps, freqHz) {
  const T = signal.length;
  const lag = Math.max(2, Math.min(T - 4, Math.round(fps / freqHz)));
  let num = 0, den = 0;
  for (let t = 0; t < T - lag; t++) num += signal[t] * signal[t + lag];
  for (let t = 0; t < T; t++) den += signal[t] * signal[t];
  return den < 1e-9 ? 0.5 : _clamp(1 - Math.abs(num / den));
}

function _phaseSpread(frames, ax, ay, k) {
  const T = frames.length, N = frames[0].length;
  let cx = 0, cy = 0, n = 0;
  for (let i = 0; i < N; i++) {
    let re = 0, im = 0, energy = 0;
    for (let t = 0; t < T; t++) { const p = frames[t][i]; const s = p.valid ? p.vx * ax + p.vy * ay : 0; const ph = -2 * Math.PI * k * t / T; re += s * Math.cos(ph); im += s * Math.sin(ph); energy += s * s; }
    if (energy / T < 0.005) continue;
    const mag = Math.hypot(re, im) || 1; cx += re / mag; cy += im / mag; n++;
  }
  return n < 4 ? 0.3 : _clamp(1 - Math.hypot(cx, cy) / n);
}

window.distillSwatch = distillSwatch;
