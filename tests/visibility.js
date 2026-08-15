// Every preset must produce >= 3px of visible on-screen travel in ~2s when
// applied to a scene object (catches "frozen-looking" presets). Rebuilt after
// /tmp cleanup; targets the "Amber Jetty" scene (uses cloud 1 as the probe).
const puppeteer = require('puppeteer-core');
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

  const results = await page.evaluate(async () => {
    const { sel, library, animator } = window.__ms;
    const svg = document.querySelector('#artwork-container svg');
    const out = {};
    for (const m of library.getAll()) {
      sel._clearAll();
      const wrap = svg.querySelector('[data-name="cloud 1"]').closest('.ms-wrap');
      sel._createSVGSelection(wrap);
      sel.getActive().motionId = m.id;
      animator.play();
      let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
      await new Promise(res => {
        let n = 0;
        const iv = setInterval(() => {
          const bb = wrap.getBoundingClientRect();
          minX = Math.min(minX, bb.x); maxX = Math.max(maxX, bb.x);
          minY = Math.min(minY, bb.y); maxY = Math.max(maxY, bb.y);
          if (++n >= 40) { clearInterval(iv); res(); }
        }, 50);
      });
      animator.pause();
      out[m.id] = Math.hypot(maxX - minX, maxY - minY);
    }
    return out;
  });

  for (const [id, travel] of Object.entries(results)) {
    ok(travel >= 3, `${id}: ${travel.toFixed(1)}px travel over ~2s`);
  }
  ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
  await browser.close();
  console.log('\n' + (FAIL ? '❌ ISSUES FOUND' : '✅ ALL GOOD'));
  process.exit(FAIL ? 1 : 0);
})().catch(e => { console.error('HARNESS CRASHED:', e); process.exit(1); });
