/*
 * boy_foot_cross.js — do the boy's FEET actually pass each other?
 *
 * This exists because an earlier measurement said they did and was wrong. It used each leg
 * group's bbox bottom-centre as "the tip"; a leg drawn on a diagonal has its foot at a bbox
 * CORNER, so that reading put the feet 5.3x closer together than they are and reported
 * crossing at intensity 2 that never happened.
 *
 * Here the foot is found once in the group's OWN user space (the sampled path point farthest
 * from the declared pivot) and transformed by the group's live CTM every frame, which is the
 * same point _applyLimbs' retarget uses. Reports the signed horizontal gap and its sign
 * flips, per rest-pose mode and per intensity, so "crosses" is a count and not an impression.
 *
 * Run: NODE_PATH=/Volumes/workplace/SNEAKS/motion-swatch-poc/tests/node_modules \
 *      node tests/boy_foot_cross.js
 * Optional: MS_MODES=off,all and MS_INTENS=1,3 to narrow or extend the sweep.
 */
const puppeteer = require('puppeteer-core');
const SVG = process.env.MS_SVG || '/Volumes/workplace/SNEAKS/Motion-Life/assets/scenes/boy-limbs.svg';
const SWATCH = process.env.MS_SWATCH || 'assets/motion/walk-man-extracted.json';
const MODES = (process.env.MS_MODES || 'off,legs,all').split(',');
const INTENS = (process.env.MS_INTENS || '1,1.5,2').split(',').map(Number);

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 1000, deviceScaleFactor: 1 });
  const errs = []; page.on('pageerror', e => errs.push(String(e)));
  await page.goto('http://localhost:8000/index.html', { waitUntil: 'networkidle0' });

  const id = await page.evaluate(async (url) => {
    const sw = await (await fetch(url)).json();
    window.__ms.library.add(sw);
    return sw.id;
  }, SWATCH);

  await (await page.$('#art-input')).uploadFile(SVG);
  await new Promise(r => setTimeout(r, 1400));
  const pt = await page.evaluate(() => {
    const svg = document.querySelector('#artwork-container svg');
    const b = svg.querySelector('[data-limb="torso"]').getBBox();
    const p = svg.createSVGPoint(); p.x = b.x + b.width / 2; p.y = b.y + b.height / 2;
    const q = p.matrixTransform(svg.getScreenCTM());
    return { x: q.x, y: q.y };
  });
  await page.mouse.click(pt.x, pt.y);
  await new Promise(r => setTimeout(r, 250));

  const out = await page.evaluate(({ id, modes, intens }) => {
    const { sel, animator } = window.__ms;
    const a = sel.getActive();
    if (!a) return { error: 'nothing selected' };
    const legs = ['leg-l', 'leg-r'].map(r => a.wrap.querySelector(`[data-limb="${r}"]`));
    if (!legs[0] || !legs[1]) return { error: 'no leg-l/leg-r in the rig' };

    // the drawn foot, in the group's own user space — see the header note
    const feet = legs.map((g) => {
      const pv = (g.getAttribute('data-pivot') || '').split(/\s+/).map(Number);
      let best = null, bd = -1;
      for (const el of g.querySelectorAll('path,polygon,rect,circle,ellipse')) {
        let n = 0; try { n = el.getTotalLength ? el.getTotalLength() : 0; } catch (e) { n = 0; }
        if (!(n > 0)) continue;
        for (let k = 0; k <= 128; k++) {
          const q = el.getPointAtLength(n * k / 128);
          const d = Math.hypot(q.x - pv[0], q.y - pv[1]);
          if (d > bd) { bd = d; best = { x: q.x, y: q.y }; }
        }
      }
      return best;
    });
    const live = (g, f) => { const m = g.getScreenCTM();
      return { x: f.x * m.a + f.y * m.c + m.e, y: f.x * m.b + f.y * m.d + m.f }; };

    const rows = [], N = 155, dur = N / 15;
    let mirror = null;
    a.motionId = id; a.speed = 1;
    for (const mode of modes) {
      for (const inten of intens) {
        a.limbRetarget = mode; a.intensity = inten;
        animator.pause();          // NB: this nulls s._limb, so read the rig AFTER a frame
        const gaps = [], degs = [[], []];
        for (let f = 0; f < N; f++) {
          animator._applyAll(f * dur / N);
          const A = live(legs[0], feet[0]), B = live(legs[1], feet[1]);
          gaps.push(A.x - B.x);
          legs.forEach((g, i) => {
            const m = [...(g.getAttribute('transform') || '').matchAll(/rotate\(([-\d.]+)/g)];
            if (m.length) degs[i].push(+m[m.length - 1][1]);
          });
        }
        if (mirror === null && a._limb) mirror = !!a._limb.mirror;
        let flips = 0;
        for (let i = 1; i < gaps.length; i++) if ((gaps[i] > 0) !== (gaps[i - 1] > 0)) flips++;
        rows.push({ mode, inten, flips,
          min: +Math.min(...gaps).toFixed(1), max: +Math.max(...gaps).toFixed(1),
          degL: [+Math.min(...degs[0]).toFixed(1), +Math.max(...degs[0]).toFixed(1)],
          degR: [+Math.min(...degs[1]).toFixed(1), +Math.max(...degs[1]).toFixed(1)] });
      }
    }
    animator.pause();
    return { rows, mirror, feet: feet.map(f => [+f.x.toFixed(1), +f.y.toFixed(1)]) };
  }, { id, modes: MODES, intens: INTENS });

  if (out.error) { console.log('ERROR:', out.error); await browser.close(); return; }
  console.log('drawn foot points (group user space):', JSON.stringify(out.feet));
  console.log('capture mirrored to the artwork\'s facing:', out.mirror, '\n');
  console.log('  left foot x MINUS right foot x, over 155 frames, screen px');
  console.log('  rest pose   int    gap min .. max      crosses      leg-l deg         leg-r deg');
  let last = null;
  for (const r of out.rows) {
    if (last && last !== r.mode) console.log('');
    last = r.mode;
    console.log('  ' + r.mode.padEnd(10) + ' x' + String(r.inten).padEnd(5)
      + String(r.min).padStart(8) + ' ..' + String(r.max).padStart(8) + '   '
      + (r.flips ? `YES (${r.flips})` : 'no').padEnd(11)
      + String(r.degL[0] + '..' + r.degL[1]).padEnd(17) + r.degR[0] + '..' + r.degR[1]);
  }
  // only when the sweep actually covered the pair being compared (MS_MODES can narrow it)
  const at = (mode) => out.rows.find(r => r.mode === mode && r.inten === 1);
  const off = at('off'), all = at('all');
  const say = (r) => r.flips ? `crosses ${r.flips}x` : 'never crosses';
  if (off && all) console.log(`\n  VERDICT  as drawn: ${say(off)}`
    + `   ·   matched to the capture: ${say(all)}`);
  console.log('page errors:', errs.length ? errs.slice(0, 3) : 'none');
  await browser.close();
})();
