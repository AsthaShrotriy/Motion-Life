// Test the user's actual poster file end-to-end through the real upload UI.
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
  await new Promise(r => setTimeout(r, 300));

  // upload through the real "Upload artwork" button
  const [chooser] = await Promise.all([
    page.waitForFileChooser(),
    page.click('#btn-upload-art'),
  ]);
  await chooser.accept([process.env.POSTER || '/Users/prajjwas/Downloads/motionSwatch/poster (1).svg']);
  await new Promise(r => setTimeout(r, 800));

  const r = await page.evaluate(async () => {
    const { sel, library, animator } = window.__ms;
    const svg = document.querySelector('#artwork-container svg');
    if (!svg) return { error: 'no svg' };
    const wraps = [...svg.querySelectorAll('.ms-wrap')];
    const vb = svg.viewBox.baseVal;

    // click the CENTER of each wrap's bbox (real user clicks)
    const clicks = [];
    for (const w of wraps.slice(0, 10)) {
      const bb = w.getBoundingClientRect();
      if (!bb.width) continue;
      const cx = bb.x + bb.width / 2, cy = bb.y + bb.height / 2;
      const target = document.elementFromPoint(cx, cy);
      if (!target || target.tagName === 'CANVAS') { clicks.push({ hit: false }); continue; }
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: cx, clientY: cy }));
      const s = sel.getActive();
      let coverage = 1;
      if (s && s.wrap) {
        const b = s.wrap.getBBox();
        coverage = (b.width * b.height) / (vb.width * vb.height);
      }
      clicks.push({ hit: !!s, name: s && s.name, coverage: +coverage.toFixed(2) });
    }

    // apply a motion to the last selection and confirm animation
    let animates = false;
    if (sel.getActive()) {
      library.select('gentle-sway');
      sel.getActive().motionId = 'gentle-sway';
      animator.play();
      const wrap = sel.getActive().wrap;
      // wave/cloth mode morphs geometry (d) with empty wrap transform;
      // rigid mode sets the wrap transform — accept either
      const snap = () => (wrap.getAttribute('transform') || '') + '|' +
        [...wrap.querySelectorAll('path')].slice(0, 3).map(p => p.getAttribute('d')).join('');
      const s0 = snap();
      await new Promise(r2 => setTimeout(r2, 350));
      const s1 = snap();
      animates = s0 !== s1;
      animator.pause();
    }
    return { wrapCount: wraps.length, clicks, animates };
  });

  console.log('wraps:', r.wrapCount, '| clicks:', JSON.stringify(r.clicks));
  ok(r.wrapCount >= 5 && r.wrapCount <= 40, `sensible number of selectable units (${r.wrapCount})`);
  const hits = (r.clicks || []).filter(c => c.hit);
  ok(hits.length >= Math.max(1, (r.clicks || []).length - 2), `clicking selects objects (${hits.length}/${(r.clicks || []).length})`);
  // clicks that land on the poster's background legitimately select the
  // full-bleed background rect; require most hits to be tight units
  const tight = hits.filter(c => c.coverage < 0.7);
  ok(tight.length >= hits.length * 0.6, `most selections are tight units (${tight.length}/${hits.length}; coverages: ${hits.map(c => c.coverage).join(', ')})`);
  ok(r.animates, 'applied motion animates the selection');
  console.log('page errors:', errors.join('; ') || '(none)');
  if (errors.length) FAIL = true;

  await page.screenshot({ path: '/tmp/ms-test/user-poster.png' });
  await browser.close();
  console.log(FAIL ? '❌ ISSUES' : '✅ ALL GOOD');
  process.exit(FAIL ? 1 : 0);
})().catch(e => { console.error('CRASHED:', e); process.exit(1); });
