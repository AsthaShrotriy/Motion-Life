/*
 * boy_walkman.js — the end-to-end run: the walk extracted from assets/videos/walk-man.mp4,
 * applied to the rigged boy (assets/scenes/boy-limbs.svg, tagged from the user's
 * boy_grouped.svg). Nothing here is authored — the angles come from the video.
 *
 * Renders a frame sequence so the result can be watched, and reports what each limb actually
 * did, so a subtle result can be told apart from a broken one.
 *
 * Run: NODE_PATH=/Volumes/workplace/SNEAKS/motion-swatch-poc/tests/node_modules \
 *      node tests/boy_walkman.js            (puppeteer-core lives in the sibling POC)
 * Optional: MS_INTENSITY=2 to scale the measured swing (see the note printed at the end).
 */
const puppeteer = require('puppeteer-core');

const SVG = process.env.MS_SVG || '/Volumes/workplace/SNEAKS/Motion-Life/assets/scenes/boy-limbs.svg';
const SWATCH = 'assets/motion/walk-man-extracted.json';
const INTENSITY = parseFloat(process.env.MS_INTENSITY || '1');
const NFRAMES = parseInt(process.env.MS_FRAMES || '60', 10);

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 1000, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  await page.goto('http://localhost:8000/index.html', { waitUntil: 'networkidle0' });

  const meta = await page.evaluate(async (url) => {
    const sw = await (await fetch(url)).json();
    window.__ms.library.add(sw);
    return { id: sw.id, name: sw.name, frames: sw.pose.frames.length, fps: sw.pose.fps,
             detected: sw.pose.detected, total: sw.pose.total, desc: sw.desc };
  }, SWATCH);
  console.log('swatch:', meta.name, `(${meta.detected}/${meta.total} frames detected, ${meta.fps} fps)`);
  console.log('  ' + meta.desc);

  await (await page.$('#art-input')).uploadFile(SVG);
  await new Promise(r => setTimeout(r, 1400));

  // select the figure through a real click, the way a user would
  const pt = await page.evaluate(() => {
    const svg = document.querySelector('#artwork-container svg');
    const b = svg.querySelector('#Rest_of_Body').getBBox();
    const p = svg.createSVGPoint(); p.x = b.x + b.width / 2; p.y = b.y + b.height / 2;
    const q = p.matrixTransform(svg.getScreenCTM());
    return { x: q.x, y: q.y };
  });
  await page.mouse.click(pt.x, pt.y);
  await new Promise(r => setTimeout(r, 250));

  const report = await page.evaluate(({ id, intensity, n }) => {
    const { sel, animator } = window.__ms;
    const a = sel.getActive();
    if (!a) return { error: 'nothing selected' };
    a.motionId = id; a.intensity = intensity; a.speed = 1;
    const els = [...a.wrap.querySelectorAll('[data-limb]')];
    const per = new Map(els.map(e => [e.dataset.limb, { degs: [], tip0: null, tip: 0 }]));
    const tipOf = (el) => {
      const b = el.getBBox(), m = el.getScreenCTM();
      const x = b.x + b.width / 2, y = b.y + b.height;
      return { x: x * m.a + y * m.c + m.e, y: x * m.b + y * m.d + m.f };
    };
    animator.pause();
    for (const e of els) per.get(e.dataset.limb).tip0 = tipOf(e);
    const dur = 155 / 15;
    for (let f = 0; f < n; f++) {
      animator._applyAll(f * dur / n);
      for (const e of els) {
        const g = per.get(e.dataset.limb);
        const all = [...(e.getAttribute('transform') || '').matchAll(/rotate\(([-\d.]+)/g)];
        if (all.length) g.degs.push(+all[all.length - 1][1]);
        const t = tipOf(e);
        g.tip = Math.max(g.tip, Math.hypot(t.x - g.tip0.x, t.y - g.tip0.y));
      }
    }
    animator.pause();
    const hl = document.querySelector('#artwork-container svg #ms-highlights');
    if (hl) hl.remove();
    return {
      unit: a.wrap.getAttribute('data-ms-name'),
      limbs: els.map(e => {
        const g = per.get(e.dataset.limb);
        return { limb: e.dataset.limb,
                 min: +Math.min(...g.degs).toFixed(1), max: +Math.max(...g.degs).toFixed(1),
                 swing: +(Math.max(...g.degs) - Math.min(...g.degs)).toFixed(1),
                 tipPx: +g.tip.toFixed(1) };
      }),
    };
  }, { id: meta.id, intensity: INTENSITY, n: NFRAMES });

  if (report.error) { console.log('ERROR:', report.error); await browser.close(); return; }
  console.log(`\ndriving "${report.unit}" at intensity ${INTENSITY}:`);
  console.log('  limb      own rotation           swing    tip travel');
  for (const l of report.limbs) {
    console.log('  ' + l.limb.padEnd(9) + ' ' +
      `${String(l.min).padStart(7)} .. ${String(l.max).padEnd(7)}` + '  ' +
      String(l.swing + '°').padStart(7) + '  ' + String(l.tipPx + 'px').padStart(10));
  }

  // render the sequence
  const el = await page.$('#artwork-container');
  const dur = 155 / 15;
  for (let f = 0; f < NFRAMES; f++) {
    await page.evaluate((t) => { window.__ms.animator.pause(); window.__ms.animator._applyAll(t); },
      f * dur / NFRAMES);
    await el.screenshot({ path: `/tmp/walk/f${String(f).padStart(3, '0')}.png` });
  }
  console.log(`\nrendered ${NFRAMES} frames to /tmp/walk/`);
  console.log('page errors:', errs.length ? errs.slice(0, 5) : 'none');
  await browser.close();
})();
