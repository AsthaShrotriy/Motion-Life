/*
 * judge.js — Step 9: show the animated result back to the VLM, then act on what it says.
 *
 * The loop is: render -> grab frames -> ask the judge -> apply its deltas -> render again.
 * Two things about it are deliberate.
 *
 * ON DEMAND ONLY. Every pass is a paid vision call over 8-16 images. Nothing here runs
 * unless the user presses the button, and one press buys at most JUDGE_MAX_ITERS passes
 * (the server enforces that, not this file — see service/vlm_router.py).
 *
 * THE SERVER OWNS THE POLICY. This file does not decide when to stop, does not compute
 * the next params, and does not clamp anything. It sends frames, receives `next_params`
 * and a `continue` flag, and obeys. That is on purpose: the caps that stop one confident
 * wrong verdict from wrecking a motion are worth nothing if the caller can route around
 * them, and a browser is the easiest thing in the world to route around.
 *
 * Frames are sampled by calling animator._applyAll(t) at chosen times rather than by
 * recording playback. The animation is a pure function of t, so this gives exactly one
 * cycle, evenly spaced, reproducibly — where a real-time capture would give whatever
 * 8 moments the event loop happened to allow.
 */

(() => {
'use strict';

const ROUTER = 'http://127.0.0.1:8871';
const N_FRAMES = 8;
const FRAME_W = 512;        // matches the router's MAX_W, so it never re-encodes ours

/* How long one cycle of this motion lasts, in animator seconds.
 *
 * A parametric motion repeats at 1/frequency. A captured pose or path instead repeats
 * over the length of the clip it came from, and its `frequency` says nothing about it —
 * sampling a 4-second walk at 1/1.4s would show the same third of a stride every time. */
function cycleSeconds(motion, speed) {
  const swatches = motion.swatches || [];
  const pose = (motion.pose && motion.pose.frames) ? motion.pose
    : (swatches.find(s => s && s.kind === 'skeleton' && s.pose) || {}).pose;
  if (pose && pose.frames && pose.frames.length) {
    return pose.frames.length / (pose.fps || 15) / (speed || 1);
  }
  const path = motion.path || (swatches.find(s => s && s.kind === 'path' && s.path) || {}).path;
  if (path && path.points && path.points.length > 1) {
    return path.points.length / (path.fps || 30) / (speed || 1);
  }
  const f = (motion.params || {}).frequency;
  const period = (f && f > 0.05) ? 1 / f : 2;
  return Math.min(4, Math.max(0.4, period)) / (speed || 1);
}

/* Sample the LIVE artwork at n evenly spaced phases of one cycle.
 *
 * The end of the cycle is excluded: at t = span the motion is back where it started, so
 * including it would spend a frame on a duplicate of frame 1 and make a correct loop
 * look like a stutter. */
async function grabFrames(sel, animator, motion, n = N_FRAMES) {
  const svg = sel._svg;
  if (!svg) throw new Error('no SVG artwork loaded — the judge needs a vector scene to sample');
  if (!window.svgToImage) throw new Error('svgToImage unavailable (js/videoexport.js did not load)');

  const active = sel.getActive();
  const span = cycleSeconds(motion, active && active.speed);
  const wasPlaying = animator.playing;
  animator.pause();                     // stop rAF from overwriting a transform mid-serialize

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const frames = [];
  try {
    for (let i = 0; i < n; i++) {
      animator._applyAll(i * span / n);
      const img = await window.svgToImage(svg);
      if (!canvas.width) {
        canvas.width = FRAME_W;
        canvas.height = Math.max(1, Math.round(FRAME_W * img.height / img.width));
      }
      ctx.fillStyle = '#ffffff';         // flatten alpha: a transparent JPEG reads as noise
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      frames.push(canvas.toDataURL('image/jpeg', 0.85));
    }
  } finally {
    animator.pause();                   // resets transforms
    if (wasPlaying) animator.play();
  }
  return frames;
}

/* Frames from the SOURCE clip, so the judge can compare instead of guessing.
 * Returns [] when there is no clip linked to this motion — the router then labels its
 * score `class_plausibility` rather than pretending it checked a match. */
async function referenceFrames(url, n = N_FRAMES) {
  if (!url) return [];
  const v = document.createElement('video');
  v.src = url; v.muted = true; v.playsInline = true; v.preload = 'auto';
  try {
    await new Promise((res, rej) => {
      v.onloadeddata = res;
      v.onerror = () => rej(new Error('source clip could not be decoded'));
      setTimeout(() => rej(new Error('source clip timed out')), 8000);
    });
    const dur = v.duration;
    if (!isFinite(dur) || dur <= 0) return [];
    const canvas = document.createElement('canvas');
    canvas.width = FRAME_W;
    canvas.height = Math.max(1, Math.round(FRAME_W * v.videoHeight / v.videoWidth));
    const ctx = canvas.getContext('2d');
    const out = [];
    for (let i = 0; i < n; i++) {
      v.currentTime = i * dur / n;
      await new Promise(res => { v.onseeked = res; setTimeout(res, 1500); });
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
      out.push(canvas.toDataURL('image/jpeg', 0.85));
    }
    return out;
  } catch {
    return [];                          // a missing reference degrades the score's meaning,
  } finally {                           // not the run — the router says which it gave you
    v.src = '';
  }
}

async function post(path, body) {
  const r = await fetch(ROUTER + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({ error: `router returned ${r.status}` }));
  if (!r.ok && !j.stopped) throw new Error(j.error || `router returned ${r.status}`);
  return j;
}

/*
 * One tune run. Returns { history, iterations, reverted, reason, verdict }.
 *
 * `onStep(state)` fires after every pass so the caller can redraw mid-run — a run can
 * take half a minute and silence looks like a hang.
 */
async function tune({ sel, animator, motion, sourceUrl, onStep, onStatus }) {
  const say = onStatus || (() => {});
  const active = sel.getActive();
  const session = `${motion.id}:${(active && active.name) || 'layer'}`;
  // the motion's name is the INTENT; the layer name only says which thing to watch.
  // Sending the layer name as the intent had the judge grading "title" as a title reveal.
  const label = motion.name || '';
  const element = (active && active.name) || '';

  await post('/judge/reset', { session });          // a press buys a fresh budget
  const original = { ...(motion.params || {}) };
  const applied = [];                                // applied[i] produced history[i]
  const history = [];
  let reverted = false, reason = '', last = null;

  say('Sampling the source clip…');
  const reference = await referenceFrames(sourceUrl);

  for (let pass = 0; ; pass++) {
    say(`Rendering frames (pass ${pass + 1})…`);
    const frames = await grabFrames(sel, animator, motion);
    applied.push({ ...(motion.params || {}) });

    say(`Asking the judge (pass ${pass + 1})…`);
    const r = await post('/judge', {
      session, label, element, reference,
      // asked of the animator, not read off the motion: a swatch's class outranks the
      // motion's, and _classOf/_applicatorFor are the single definition of that rule
      class: animator._classOf(motion),
      applicator: animator._applicatorFor(motion),
      params: motion.params || {},
      frames,
    });
    last = r;
    if (r.stopped) { reason = r.reason; applied.pop(); break; }
    if (r.error) throw new Error(r.error);

    history.push(r.verdict);
    reason = r.reason;
    if (onStep) onStep({ history, reason, verdict: r.verdict, next: r.next_params,
                         iteration: r.iteration, max: r.max_iterations, going: r.continue });
    if (!r.continue) break;

    motion.params = r.next_params;                   // read live by the renderer next frame
  }

  // The loop stops when a pass FAILS to improve, so the state it stops in is the one that
  // did not help. Put the best-scoring params back rather than leaving the newest.
  const best = last && typeof last.best === 'number' ? last.best : history.length - 1;
  if (best >= 0 && applied[best]) {
    reverted = JSON.stringify(motion.params) !== JSON.stringify(applied[best]);
    motion.params = applied[best];
  } else if (!history.length) {
    motion.params = original;
  }
  return { history, iterations: history.length, reverted, reason,
           verdict: history[best] || null, params: motion.params, original,
           scoreOf: last && last.score_of };
}

/* ── the panel ──────────────────────────────────────────────────────────────
 * The critique is the point of the feature, so it is shown verbatim rather than
 * summarised into a number. The score label matters too: "vs. source clip" and
 * "plausibility only" are different claims and the user should see which they got. */
const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function render(el, state) {
  if (!el) return;
  if (state.busy) {
    el.innerHTML = `<div class="judge-busy">${esc(state.busy)}</div>`;
    return;
  }
  if (state.error) {
    el.innerHTML = `<div class="judge-err">${esc(state.error)}</div>`;
    return;
  }
  const v = state.verdict;
  if (!v) {
    el.innerHTML = `<div class="judge-err">${esc(state.reason || 'No verdict.')}</div>`;
    return;
  }
  const pct = Math.round(v.score * 100);
  const band = v.score >= 0.8 ? 'good' : v.score >= 0.5 ? 'mid' : 'bad';
  const axes = Object.entries(v.axes || {});
  const deltas = Object.entries(v.deltas || {});
  el.innerHTML = `
    <div class="judge-score ${band}">
      <strong>${pct}%</strong>
      <span>${esc(v.verdict)}</span>
      <em>${state.scoreOf === 'match_to_reference' ? 'vs. source clip'
                                                   : 'plausibility only (no source clip)'}</em>
    </div>
    <p class="judge-critique">${esc(v.critique)}</p>
    ${axes.length ? `<div class="judge-axes">${axes.map(([k, s]) => `
      <div class="judge-axis"><span>${esc(k)}</span>
        <i style="width:${Math.round(s * 100)}%"></i><b>${Math.round(s * 100)}%</b></div>`)
      .join('')}</div>` : ''}
    ${v.observations && v.observations.length ? `<ul class="judge-obs">${
      v.observations.map(o => `<li>${esc(o)}</li>`).join('')}</ul>` : ''}
    <div class="judge-meta">
      ${state.iterations} pass${state.iterations === 1 ? '' : 'es'} —
      ${esc(state.reason)}${state.reverted ? ' (kept the best pass, not the last)' : ''}
    </div>
    ${deltas.length ? `<div class="judge-meta">last suggested: ${
      deltas.map(([k, d]) => `${esc(k)} ${d > 0 ? '+' : ''}${d}`).join(', ')}</div>` : ''}`;
}

window.MotionJudge = { tune, grabFrames, referenceFrames, cycleSeconds, render };

})();
