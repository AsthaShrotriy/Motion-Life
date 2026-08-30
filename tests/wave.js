// Verify cloth/wave mode:
//  1. flag defaults to waveMode
//  2. playing deforms the path geometry (d changes) while the wrap does NOT translate
//  3. different sample points move by different amounts (wave, not rigid shift)
//  4. pause restores pristine geometry
//  5. export bakes SMIL <animate attributeName="d"> and it runs as a plain <img>
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
  await page.evaluate(() => window.__ms.loadScene('scenery'));
  await new Promise(r => setTimeout(r, 400));

  const res = await page.evaluate(async () => {
    const { sel, library, animator } = window.__ms;
    const svg = document.querySelector('#artwork-container svg');
    const wrap = svg.querySelector('[data-ms-name="flag"]');
    sel._createSVGSelection(wrap);
    const s = sel.getActive();
    const defaultWave = !!s.waveMode;
    s.motionId = 'flag-flutter';
    const cloth = wrap.querySelector('path');
    const d0 = cloth.getAttribute('d');

    animator.play();
    await new Promise(r => setTimeout(r, 300));
    const dMid = cloth.getAttribute('d');
    const wrapTransform = wrap.getAttribute('transform') || '';

    // Root (at the pole) vs tip, as displacement FROM REST at the worst phase of a whole
    // loop. Comparing two live frames 250ms apart instead measured velocity at whatever
    // phase the clock happened to land on, which says nothing about how far each end
    // travels — a tip caught at its turning point reads as motionless.
    animator.pause();
    const len = cloth.getTotalLength();
    const at = (f) => cloth.getPointAtLength(len * f);
    const rest = [at(0.02), at(0.45)];
    let rootMove = 0, tipMove = 0;
    for (let i = 0; i < 32; i++) {
      animator._applyAll(i * 4 / 32);
      const a = at(0.02), b = at(0.45);
      rootMove = Math.max(rootMove, Math.hypot(a.x - rest[0].x, a.y - rest[0].y));
      tipMove = Math.max(tipMove, Math.hypot(b.x - rest[1].x, b.y - rest[1].y));
    }
    animator.pause();          // sampling left the last frame applied; reset before the check below

    const dAfter = cloth.getAttribute('d');

    return { defaultWave, geomChanged: d0 !== dMid, wrapTransform, rootMove, tipMove, restored: dAfter === d0 };
  });

  ok(res.defaultWave, 'flag defaults to cloth/wave mode');
  ok(res.geomChanged, 'path geometry (d attribute) deforms while playing');
  ok(!res.wrapTransform, `wrap has NO rigid transform in wave mode (got "${res.wrapTransform}")`);
  ok(res.tipMove > res.rootMove * 2, `tip travels more than the pole edge (tip ${res.tipMove.toFixed(2)}px vs root ${res.rootMove.toFixed(2)}px, worst phase of the loop) — a wave, not a shift`);
  ok(res.restored, 'pause restores pristine geometry');

  // ---- export path ----
  const svgText = await page.evaluate(() => {
    const { sel, library } = window.__ms;
    return buildExportSVG(sel, library);
  });
  ok(svgText.includes('<animate') && svgText.includes('attributeName="d"'), 'export bakes SMIL d-morph animation');
  fs.writeFileSync('/Volumes/workplace/SNEAKS/motion-swatch-poc/travel-site/assets/wave-test.svg', svgText);

  const page2 = await browser.newPage();
  await page2.setViewport({ width: 900, height: 600 });
  await page2.setContent(`<img src="http://localhost:8000/travel-site/assets/wave-test.svg" style="width:800px">`);
  await new Promise(r => setTimeout(r, 400));
  const shots = [];
  for (let i = 0; i < 3; i++) {
    shots.push((await page2.screenshot({ clip: { x: 180, y: 180, width: 260, height: 160 } })).toString('base64'));
    await new Promise(r => setTimeout(r, 300));
  }
  ok(new Set(shots).size >= 2, `exported wave animates as plain <img> (${new Set(shots).size}/3 distinct frames)`);

  console.log('\npage errors:', errors.length ? errors.join('\n') : '(none)');
  if (errors.length) FAIL = true;
  await browser.close();
  console.log('\n' + (FAIL ? '❌ ISSUES FOUND' : '✅ ALL GOOD'));
  process.exit(FAIL ? 1 : 0);
})().catch(e => { console.error('HARNESS CRASHED:', e); process.exit(1); });
