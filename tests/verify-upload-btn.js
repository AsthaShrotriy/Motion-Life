// Verify the travel site's "Upload new image" button swaps in the animated
// export and it animates immediately.
const puppeteer = require('puppeteer-core');
const path = require('path');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
let FAIL = false;
const ok = (c, m) => { console.log((c ? '✅ ' : '❌ FAIL: ') + m); if (!c) FAIL = true; };
(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.goto('http://localhost:8000/travel-site/', { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 300));

  const btnVisible = await page.evaluate(() => {
    const b = document.getElementById('btn-hero-upload');
    const r = b.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && b.textContent.includes('Upload new image');
  });
  ok(btnVisible, '"Upload new image" button is visible on the hero');

  const beforeSrc = await page.evaluate(() => document.getElementById('hero-img').src);

  // click the button and feed it the animated export via the file chooser
  const [chooser] = await Promise.all([
    page.waitForFileChooser(),
    page.click('#btn-hero-upload'),
  ]);
  await chooser.accept(['/Volumes/workplace/SNEAKS/motion-swatch-poc/travel-site/assets/hero-animated.svg']);
  await new Promise(r => setTimeout(r, 500));

  const afterSrc = await page.evaluate(() => document.getElementById('hero-img').src);
  ok(afterSrc !== beforeSrc && afterSrc.startsWith('blob:'), `hero src swapped to uploaded file (${afterSrc.slice(0, 30)}…)`);

  // prove the swapped-in hero ANIMATES
  const shots = [];
  for (let i = 0; i < 3; i++) {
    shots.push((await page.screenshot({ clip: { x: 130, y: 90, width: 600, height: 400 } })).toString('base64'));
    await new Promise(r => setTimeout(r, 450));
  }
  ok(new Set(shots).size >= 2, `uploaded hero animates in place (${new Set(shots).size}/3 distinct frames)`);
  ok(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join('; ') : ''));

  await page.screenshot({ path: '/tmp/ms-test/upload-btn.png' });
  await browser.close();
  console.log(FAIL ? '❌ ISSUES' : '✅ ALL GOOD');
  process.exit(FAIL ? 1 : 0);
})();
