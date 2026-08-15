// Verify trajectory-field replay: a captured motion's 144 real tracks drive
// the object's geometry (not a synthetic sine).
//  1. upload GT sway video (0.8Hz horizontal, block in center of frame)
//  2. apply to the poster flag -> waveMode auto-on, field replay active
//  3. geometry morphs; motion axis is HORIZONTAL (matches capture; the old
//     sine was vertical-only — this distinguishes real replay from sine)
//  4. oscillation period ≈ captured 0.8Hz
//  5. SVG export bakes the field as SMIL and animates as <img>
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
let FAIL = false;
const ok = (c, m) => { console.log((c ? '✅ ' : '❌ FAIL: ') + m); if (!c) FAIL = true; };

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://localhost:8000', { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 400));

  // upload GT video through the real UI path
  const [chooser] = await Promise.all([
    page.waitForFileChooser(),
    page.click('#btn-upload-motion'),
  ]);
  await chooser.accept(['/tmp/ms-test/sway_gt_h264.mp4']);

  // wait for capture to finish (skip the extraction modal when it appears)
  const captured = await page.evaluate(async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 40000) {
      const skip = document.querySelector('.extract-skip');
      if (skip) skip.click();
      const m = window.__ms.library.getAll().find(x => x.fromUpload);
      if (m) return { id: m.id, hasTraj: !!(m.trajectories && m.trajectories.length === 144), fps: m.trajFps };
      await new Promise(r => setTimeout(r, 300));
    }
    return null;
  });
  ok(!!captured, 'captured motion created from upload');
  ok(captured && captured.hasTraj, `motion carries 144 trajectories (fps=${captured && captured.fps})`);

  // apply to the poster flag
  const res = await page.evaluate(async (motionId) => {
    const { sel, library, animator } = window.__ms;
    const svg = document.querySelector('#artwork-container svg');
    const wrap = svg.querySelector('[data-ms-name="flag"]');
    sel._createSVGSelection(wrap);
    library.select(motionId);
    const s = sel.getActive();
    s.motionId = motionId;
    s.waveMode = true;
    const cloth = wrap.querySelector('path');
    const d0 = cloth.getAttribute('d');

    animator.play();
    // sample a mid-cloth point's position over ~2.5s at 20Hz
    const xs = [], ys = [];
    await new Promise(resolve => {
      let n = 0;
      const iv = setInterval(() => {
        const len = cloth.getTotalLength();
        const p = cloth.getPointAtLength(len * 0.4);
        xs.push(p.x); ys.push(p.y);
        if (++n >= 50) { clearInterval(iv); resolve(); }
      }, 50);
    });
    animator.pause();
    const dAfter = cloth.getAttribute('d');

    const range = a => Math.max(...a) - Math.min(...a);
    // zero crossings of the x signal → dominant frequency estimate
    const xm = xs.reduce((s2, v) => s2 + v, 0) / xs.length;
    let crossings = 0;
    for (let i = 1; i < xs.length; i++)
      if ((xs[i - 1] - xm) * (xs[i] - xm) < 0) crossings++;
    const freq = crossings / 2 / 2.5;    // crossings per second / 2

    return {
      geomChanged: d0 !== dAfter || range(xs) > 0.5,
      xTravel: range(xs), yTravel: range(ys),
      freq,
      restored: dAfter === d0,
    };
  }, captured.id);

  ok(res.xTravel > 2, `geometry moves (x travel ${res.xTravel.toFixed(1)}px)`);
  ok(res.xTravel > res.yTravel * 1.5, `motion is HORIZONTAL like the capture (x ${res.xTravel.toFixed(1)}px vs y ${res.yTravel.toFixed(1)}px) — real field, not the vertical sine`);
  ok(Math.abs(res.freq - 0.8) < 0.35, `oscillation ≈ captured 0.8Hz (measured ${res.freq.toFixed(2)}Hz)`);
  ok(res.restored, 'pause restores pristine geometry');

  // ---- export path: field baked as SMIL ----
  const svgText = await page.evaluate(() => buildExportSVG(window.__ms.sel, window.__ms.library));
  ok(svgText && svgText.includes('attributeName="d"'), 'export bakes trajectory field as SMIL d-morph');
  fs.writeFileSync('/Volumes/workplace/SNEAKS/motion-swatch-poc/travel-site/assets/field-test.svg', svgText);
  const page2 = await browser.newPage();
  await page2.setContent(`<img src="http://localhost:8000/travel-site/assets/field-test.svg" style="width:800px">`);
  await new Promise(r => setTimeout(r, 400));
  const shots = [];
  for (let i = 0; i < 3; i++) {
    shots.push((await page2.screenshot({ clip: { x: 150, y: 60, width: 400, height: 200 } })).toString('base64'));
    await new Promise(r => setTimeout(r, 400));
  }
  ok(new Set(shots).size >= 2, `exported field animates as plain <img> (${new Set(shots).size}/3 distinct)`);

  console.log('\npage errors:', errors.length ? errors.join('\n') : '(none)');
  if (errors.length) FAIL = true;
  await browser.close();
  console.log('\n' + (FAIL ? '❌ ISSUES FOUND' : '✅ ALL GOOD'));
  process.exit(FAIL ? 1 : 0);
})().catch(e => { console.error('HARNESS CRASHED:', e); process.exit(1); });
