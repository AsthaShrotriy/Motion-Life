/*
 * boy_limbs.js — does the new limb applicator do what it claims on real artwork?
 *
 * Everything earlier in this series measured why the boy could NOT be articulated: the one
 * extracted swatch is class="cloth" so a limb got the cloth applicator and tore (worst 113%
 * segment-length change), and the character rig needs <polygon points> the file doesn't have.
 * _applyLimbs is the answer to both. This checks it against the claims in its own comments:
 *
 *   1. it RUNS  — _applyLimbs is called, _applyCloth / _applyCharacter are not
 *   2. RIGID    — rotation must not deform: per-limb segment-length change is ~0%
 *   3. PIVOTED  — each limb turns about its own declared data-pivot, and rides its parent's
 *                 rotation on top (the flat-rig gap is measured separately by boy_limb_gap.js)
 *   4. BOUNDED  — no rotation past LIMB_DEG_MAX, no NaN anywhere
 *   5. HONEST   — arm-l has no usable frames in the shipped walk (left side occluded), so
 *                 it must hold its drawn pose exactly, not be mirrored from arm-r
 *   6. MOVING   — the limbs that DO have signal move a visible amount on screen
 *   7. RESET    — stopping restores the artwork's own transform
 *
 * Run: NODE_PATH=/Volumes/workplace/SNEAKS/motion-swatch-poc/tests/node_modules \
 *      node tests/boy_limbs.js   (puppeteer-core is installed in the sibling POC, not here)
 */
const puppeteer = require('puppeteer-core');
const fs = require('fs');

const FILE = process.env.MS_SVG || '/tmp/boy_v3_limbs.svg';

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await page.goto('http://localhost:8000/index.html', { waitUntil: 'networkidle0' });

  // walk-pose.json is a RAW capture ({joints,fps,frames}) with no id, so it is not a
  // swatch — wrap it the way js/upload.js does. This is the shipped MediaPipe capture,
  // not anything hand-authored.
  await page.evaluate(async () => {
    const p = await (await fetch('assets/motion/walk-pose.json')).json();
    window.__ms.library.add({
      id: 'char-walk-shipped', name: 'Walk (pre-captured)', color: '#7cc4ff',
      desc: 'MediaPipe walk shipped in assets/motion/walk-pose.json',
      params: { frequency: 1, amplitude: 0.5, direction: 0, turbulence: 0, damping: 0, phaseSpread: 0 },
      pose: { joints: p.joints, fps: p.fps || 15, frames: p.frames.filter(Boolean) },
    });
  });
  // count which applicator runs
  await page.evaluate(() => {
    const a = window.__ms.animator;
    window.__calls = {};
    for (const m of ['_applyLimbs', '_applyCharacter', '_applyCloth', '_applyWings']) {
      const orig = a[m].bind(a);
      a[m] = (...args) => { window.__calls[m] = (window.__calls[m] || 0) + 1; return orig(...args); };
    }
  });
  await (await page.$('#art-input')).uploadFile(FILE);
  await new Promise(r => setTimeout(r, 1200));

  const units = await page.evaluate(() =>
    [...document.querySelectorAll('#artwork-container svg .ms-wrap')]
      .filter(w => !w.closest('#ms-highlights'))
      .map(w => ({ name: w.getAttribute('data-ms-name'),
                   limbs: [...w.querySelectorAll('[data-limb]')].map(e => e.dataset.limb) })));
  console.log('selectable units:', JSON.stringify(units));

  // select the figure with a real click through the real hit-test
  const pt = await page.evaluate(() => {
    const svg = document.querySelector('#artwork-container svg');
    const b = svg.querySelector('#Rest_of_Body').getBBox();
    const p = svg.createSVGPoint(); p.x = b.x + b.width / 2; p.y = b.y + b.height / 2;
    const q = p.matrixTransform(svg.getScreenCTM());
    return { x: q.x, y: q.y };
  });
  await page.mouse.click(pt.x, pt.y);
  await new Promise(r => setTimeout(r, 200));

  const res = await page.evaluate(() => {
    const { sel, animator } = window.__ms;
    const svg = document.querySelector('#artwork-container svg');
    const a = sel.getActive();
    const R = { active: a && a.wrap.getAttribute('data-ms-name'),
                limbsInSelection: a ? [...a.wrap.querySelectorAll('[data-limb]')].map(e => e.dataset.limb) : [] };
    if (!a) { R.error = 'nothing selected'; return R; }

    const els = [...a.wrap.querySelectorAll('[data-limb]')];
    const neutralTf = new Map(els.map(e => [e.dataset.limb, e.getAttribute('transform')]));

    // A limb's own shape, sampled in ITS OWN user space so an ancestor transform cannot
    // show up as deformation — and its pivot mapped through getScreenCTM, which DOES see
    // the transform, so we can tell movement from deformation apart.
    const shapeOf = (el) => [...el.querySelectorAll('path')].slice(0, 8).map(p => {
      const L = p.getTotalLength(); const o = [];
      for (let i = 0; i < 6; i++) { const q = p.getPointAtLength(L * i / 5); o.push(q.x, q.y); }
      return o;
    });
    const screenOf = (el, vx, vy) => {
      const m = el.getScreenCTM();
      return { x: vx * m.a + vy * m.c + m.e, y: vx * m.b + vy * m.d + m.f };
    };
    const tipOf = (el) => {                       // a far point, to see the swing
      const b = el.getBBox();
      return screenOf(el, b.x + b.width / 2, b.y + b.height);
    };

    a.motionId = 'char-walk-shipped'; a.intensity = 1; a.speed = 1;
    window.__calls = {};
    animator.pause();

    const per = new Map(els.map(e => [e.dataset.limb, {
      rest: shapeOf(e), pivot: (e.dataset.pivot || '').split(/\s+/).map(Number),
      distort: [], pivotDrift: 0, tipMove: 0, degs: new Set(), tfs: new Set(),
      restPivotScreen: null, restTip: tipOf(e), nan: false,
    }]));
    for (const e of els) {
      const g = per.get(e.dataset.limb);
      g.restPivotScreen = screenOf(e, g.pivot[0], g.pivot[1]);
    }

    const FRAMES = 60;
    for (let f = 0; f < FRAMES; f++) {
      animator._applyAll(f * (132 / 15) / FRAMES);   // one full pass of the 132-frame clip
      for (const e of els) {
        const g = per.get(e.dataset.limb);
        const tf = e.getAttribute('transform') || '';
        g.tfs.add(tf);
        if (/NaN|Infinity/.test(tf)) g.nan = true;
        // The transform is a CHAIN — ancestors first, the limb's own rotation LAST. Read
        // the last one, or every limb reports its torso's angle instead of its own.
        const all = [...tf.matchAll(/rotate\(([-\d.]+)/g)];
        if (all.length) g.degs.add(+all[all.length - 1][1]);
        // The joint is NOT fixed in screen space any more, and must not be: the torso
        // carries it. That it lands exactly where the parent put it is what
        // boy_limb_gap.js measures (0px). Here it is only reported, to show the ride.
        const ps = screenOf(e, g.pivot[0], g.pivot[1]);
        g.pivotDrift = Math.max(g.pivotDrift,
          Math.hypot(ps.x - g.restPivotScreen.x, ps.y - g.restPivotScreen.y));
        const tp = tipOf(e);
        g.tipMove = Math.max(g.tipMove, Math.hypot(tp.x - g.restTip.x, tp.y - g.restTip.y));
        // shape, in the limb's own space: rotation must leave it untouched
        const now = shapeOf(e);
        for (let pi = 0; pi < g.rest.length; pi++) {
          for (let k = 0; k + 3 < g.rest[pi].length; k += 2) {
            const r = Math.hypot(g.rest[pi][k + 2] - g.rest[pi][k], g.rest[pi][k + 3] - g.rest[pi][k + 1]);
            const n = Math.hypot(now[pi][k + 2] - now[pi][k], now[pi][k + 3] - now[pi][k + 1]);
            if (!isFinite(n)) g.nan = true;
            if (r > 0.5) g.distort.push(Math.abs(n - r) / r);
          }
        }
      }
    }
    animator.pause();
    R.calls = { ...window.__calls };
    R.wrapTransformAfter = a.wrap.getAttribute('transform');

    R.limbs = els.map(e => {
      const g = per.get(e.dataset.limb);
      g.distort.sort((x, y) => x - y);
      const ds = [...g.degs];
      return {
        limb: e.dataset.limb, pivot: g.pivot,
        distinctAngles: g.degs.size,
        degMin: ds.length ? +Math.min(...ds).toFixed(2) : null,
        degMax: ds.length ? +Math.max(...ds).toFixed(2) : null,
        worstDistortPct: g.distort.length ? +(100 * g.distort[g.distort.length - 1]).toFixed(3) : null,
        pivotDriftPx: +g.pivotDrift.toFixed(3),
        tipMovePx: +g.tipMove.toFixed(1),
        nan: g.nan,
      };
    });

    // ---- reset must put back the artwork's own transform ----
    animator.stop ? animator.stop() : animator._resetOne(a);
    R.afterReset = els.map(e => ({ limb: e.dataset.limb,
      tf: e.getAttribute('transform'), wasNeutral: e.getAttribute('transform') === neutralTf.get(e.dataset.limb) }));
    return R;
  });

  console.log('\nactive unit:', res.active, ' limbs in it:', JSON.stringify(res.limbsInSelection));
  if (res.error) { console.log('ERROR', res.error); await browser.close(); return; }
  console.log('applicator calls:', JSON.stringify(res.calls));
  console.log('wrap transform after (must be empty — limbs carry the motion):',
    JSON.stringify(res.wrapTransformAfter));
  console.log('\nper limb over one full pass of the 132-frame capture:');
  console.log('  limb      pivot         angles  OWN deg range      worst distort   joint ride  tip move');
  for (const l of res.limbs) {
    console.log('  ' + String(l.limb).padEnd(9) + ' ' +
      String(l.pivot.join(',')).padEnd(13) + ' ' +
      String(l.distinctAngles).padStart(6) + '  ' +
      `${String(l.degMin).padStart(7)} .. ${String(l.degMax).padEnd(7)}` + '   ' +
      String(l.worstDistortPct + '%').padStart(12) + '  ' +
      String(l.pivotDriftPx + 'px').padStart(10) + '  ' +
      String(l.tipMovePx + 'px').padStart(8) + (l.nan ? '  NaN!' : ''));
  }
  console.log('\nafter reset:', JSON.stringify(res.afterReset));
  console.log('\npage errors:', errs.length ? errs.slice(0, 6) : 'none');

  // ---- a few real frames, so the limbs can be seen to stay attached ----
  await page.evaluate(() => {
    const { sel, animator } = window.__ms;
    const a = sel.getActive();
    a.motionId = 'char-walk-shipped'; a.intensity = 1; a.speed = 1;
    // Drop the selection overlay only. #ms-highlights holds a STATIC clone of the wrap at
    // rest, so leaving it in doubles the figure in the render and hides the articulation.
    const hl = document.querySelector('#artwork-container svg #ms-highlights');
    if (hl) hl.remove();
  });
  for (const [i, tt] of [0, 2.2, 4.4, 6.6].entries()) {
    await page.evaluate((t) => { window.__ms.animator.pause(); window.__ms.animator._applyAll(t); }, tt);
    const el = await page.$('#artwork-container');
    await el.screenshot({ path: `/tmp/boy_limb_f${i}.png` });
  }
  console.log('frames: /tmp/boy_limb_f0.png .. f3.png');
  await browser.close();
})();
