// Rehearse the demo ending: export the fully-animated poster, install it as
// the travel site's hero, verify it animates on the actual site page.
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
let FAIL = false;
const ok = (c, m) => { console.log((c ? '✅ ' : '❌ FAIL: ') + m); if (!c) FAIL = true; };
(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  await page.goto('http://localhost:8000', { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 400));
  const svgText = await page.evaluate(() => {
    const { sel, library } = window.__ms;
    const svg = document.querySelector('#artwork-container svg');
    const pick = (n, m) => { const w = svg.querySelector(`[data-ms-name="${n}"]`); if (w) { sel._createSVGSelection(w); sel.getActive().motionId = m; } };
    pick('waterfall', 'waterfall-flow'); pick('cloud 1', 'cloud-drift'); pick('cloud 2', 'cloud-drift'); pick('cloud 3', 'cloud-drift');
    pick('tree 1', 'gentle-sway'); pick('tree 2', 'gentle-sway'); pick('tree 3', 'gentle-sway');
    pick('reeds left', 'gentle-sway'); pick('reeds right', 'gentle-sway');
    pick('flag', 'flag-flutter'); pick('smoke', 'rising-smoke'); pick('mist', 'gentle-sway');
    pick('river', 'water-ripple'); pick('sun', 'sun-pulse'); pick('boat', 'water-ripple'); pick('leaves', 'falling-leaves');
    return buildExportSVG(sel, library);
  });
  ok(!!svgText, 'animated export built (' + (svgText||'').length + ' bytes)');
  fs.writeFileSync('/Volumes/workplace/SNEAKS/motion-swatch-poc/travel-site/assets/hero-animated.svg', svgText);

  // install as the live hero (demo does this by renaming; we test the real file swap)
  fs.copyFileSync('/Volumes/workplace/SNEAKS/motion-swatch-poc/travel-site/assets/hero.svg', '/Volumes/workplace/SNEAKS/motion-swatch-poc/travel-site/assets/hero-static.svg');
  fs.copyFileSync('/Volumes/workplace/SNEAKS/motion-swatch-poc/travel-site/assets/hero-animated.svg', '/Volumes/workplace/SNEAKS/motion-swatch-poc/travel-site/assets/hero.svg');

  const site = await browser.newPage();
  await site.setViewport({ width: 1280, height: 900 });
  const errs = [];
  site.on('pageerror', e => errs.push(e.message));
  await site.goto('http://localhost:8000/travel-site/', { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 400));
  const shots = [];
  for (let i = 0; i < 3; i++) {
    shots.push((await site.screenshot({ clip: { x: 100, y: 80, width: 600, height: 400 } })).toString('base64'));
    await new Promise(r => setTimeout(r, 450));
  }
  ok(new Set(shots).size >= 2, `hero animates on the travel site (${new Set(shots).size}/3 distinct frames)`);
  ok(errs.length === 0, 'no page errors on travel site');
  await site.screenshot({ path: '/tmp/ms-test/travel-site.png', fullPage: false });

  // restore the static hero so the demo starts from the "before" state
  fs.copyFileSync('/Volumes/workplace/SNEAKS/motion-swatch-poc/travel-site/assets/hero-static.svg', '/Volumes/workplace/SNEAKS/motion-swatch-poc/travel-site/assets/hero.svg');
  console.log('(hero restored to static for the demo start)');
  await browser.close();
  console.log(FAIL ? '❌ ISSUES' : '✅ ALL GOOD');
  process.exit(FAIL ? 1 : 0);
})();
