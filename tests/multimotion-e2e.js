/*
 * E2E: multi-motion picker flow.
 *
 * Uploads a synthetic 2-motion video through the real UI, waits for the
 * multipick modal to appear, renames the two regions, clicks Save, and
 * verifies:
 *   1. RAFT service returned regions[] with ≥2 entries
 *   2. multipick modal appeared with 2 cards
 *   3. renaming works (both cards saved with the new names)
 *   4. two new motions land in the library
 *   5. each new motion carries trajectories, params, and a bbox
 *   6. one of them applies to an SVG object and actually animates
 *
 * Also runs a regression check: uploading the single-motion sway_gt clip
 * must NOT show the picker (regions may be 0 or 1) — the old flow stays
 * intact.
 */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
let FAIL = false;
const ok = (c, m) => { console.log((c ? '✅ ' : '❌ FAIL: ') + m); if (!c) FAIL = true; };

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--window-size=1400,900', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });
  await page.goto('http://localhost:8000', { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 400));

  // ---- 0) never-regress bug #1: overlay must be pointer-events:none in SVG mode ----
  const overlayPE = await page.evaluate(() => {
    const o = document.getElementById('selection-overlay');
    return getComputedStyle(o).pointerEvents;
  });
  ok(overlayPE === 'none', `overlay pointer-events is "none" in SVG mode (got "${overlayPE}")`);

  // ---- 1) upload synthetic 2-motion clip via the real capture path ----
  const multi2 = fs.readFileSync('/tmp/ms-test/bench_multi2_h264.mp4').toString('base64');

  // Kick off the real upload handler and inspect the raw service response too.
  // We call the internal fetch so we can assert regions[] separately from the
  // UI flow (fewer dominoes if the picker breaks).
  const rawResp = await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const form = new FormData();
    form.append('file', new File([bytes], 'multi2.mp4', { type: 'video/mp4' }));
    const r = await fetch('http://127.0.0.1:8765/analyze', { method: 'POST', body: form });
    const j = await r.json();
    return { ok: j.ok, engine: j.engine, regionCount: (j.regions || []).length,
             regions: (j.regions || []).map(rg => ({
               name: rg.suggested_name, cells: rg.cells,
               freq: rg.params.frequency, dir: rg.params.direction, amp: rg.params.amplitude,
               bbox: rg.bbox,
             })) };
  }, multi2);
  ok(rawResp.ok, 'service /analyze returned ok');
  // ≥2 regions is the contract (exact count varies with codec/re-encode — the
  // H.264 fixture can surface a legitimate 3rd region the raw mp4v doesn't).
  ok(rawResp.regionCount >= 2, `service returned ≥2 regions (got ${rawResp.regionCount})`);
  console.log('  regions:', JSON.stringify(rawResp.regions, null, 2));

  // ---- 2) drive the real UI upload button, wait for picker ----
  const startCount = await page.evaluate(() => window.__ms.library.getAll().length);
  await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const file = new File([bytes], 'multi2.mp4', { type: 'video/mp4' });
    const input = document.getElementById('motion-input');
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, multi2);

  // wait for the multipick modal to appear (service takes ~5-15s on MPS)
  try {
    await page.waitForSelector('.multipick-modal', { timeout: 30000 });
    ok(true, 'multipick modal appeared');
  } catch {
    ok(false, 'multipick modal did NOT appear within 30s');
    console.log('page errors:', errors.join('\n'));
    await browser.close(); process.exit(1);
  }

  const cardCount = await page.$$eval('.mp-card', els => els.length);
  ok(cardCount >= 2, `picker shows ≥2 cards (got ${cardCount})`);

  const initialNames = await page.$$eval('.mp-card .mp-name', els => els.map(e => e.value));
  console.log('  suggested names:', initialNames);
  ok(initialNames.every(n => n && n.length > 0), 'each card has a non-empty suggested name');

  // ---- 3) rename every card, save ----
  const wantNames = initialNames.map((_, i) => `Motion ${String.fromCharCode(65 + i)}`);
  await page.$$eval('.mp-card .mp-name', (els, names) => {
    els.forEach((el, i) => {
      el.value = names[i];
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }, wantNames);
  await page.click('.mp-save');
  // wait for the 220ms close animation; waitForFunction is racey-machine-safe
  try {
    await page.waitForFunction(() => !document.querySelector('.multipick-modal'), { timeout: 5000 });
    ok(true, 'modal closed after Save');
  } catch {
    ok(false, 'modal did not close after Save within 5s');
  }

  // ---- 4) library grew by exactly the card count, with the supplied names ----
  const lib = await page.evaluate(() => window.__ms.library.getAll().map(m => ({
    name: m.name, hasTraj: !!(m.trajectories && m.trajectories.length),
    hasBbox: !!m.bbox, hasVideo: !!m.videoUrl, engine: m.engine,
    freq: m.params.frequency, dir: m.params.direction, amp: m.params.amplitude,
  })));
  ok(lib.length === startCount + cardCount,
     `library grew by ${cardCount} (was ${startCount}, now ${lib.length})`);
  const added = lib.slice(startCount);
  ok(added.every((m, i) => m.name === wantNames[i]),
     `all user-supplied names saved (got ${JSON.stringify(added.map(m => m.name))})`);
  ok(added.every(m => m.hasTraj && m.hasBbox && m.hasVideo),
     'all saved motions carry trajectories + bbox + videoUrl');
  ok(added.every(m => m.engine && m.engine.startsWith('raft')),
     'all saved motions record the RAFT engine string');

  // ---- 5) apply one to an SVG object and confirm it animates ----
  // Poster is boot scene: click the flag first (creates a selection), then
  // apply the last uploaded motion. Wave mode off → rigid transform is a
  // simple string to diff over time.
  const applied = await page.evaluate(async () => {
    const svg = document.querySelector('#artwork-container svg');
    const flag = svg.querySelector('[data-name="flag"]');
    const r = flag.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    document.elementFromPoint(cx, cy)
      .dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: cx, clientY: cy }));

    const { sel, library, animator } = window.__ms;
    const motions = library.getAll();
    const target = motions[motions.length - 1];
    if (!target || !sel.selections.length) return { ok: false, reason: 'click did not create selection' };
    const s = sel.getActive();
    s.motionId = target.id;
    s.waveMode = false;
    library.select(target.id);

    animator.play();
    await new Promise(r => setTimeout(r, 350));
    const t1 = s.wrap && s.wrap.getAttribute('transform');
    await new Promise(r => setTimeout(r, 350));
    const t2 = s.wrap && s.wrap.getAttribute('transform');
    animator.pause();
    return { ok: true, t1, t2, changed: t1 !== t2 };
  });
  if (applied.ok) {
    ok(applied.changed, `applied motion actually animates the wrap (t1="${applied.t1}", t2="${applied.t2}")`);
  } else {
    ok(false, `could not apply: ${applied.reason}`);
  }

  // ---- 6) REGRESSION: single-motion clip must NOT show the picker ----
  // sway_gt is 1 motion → the picker should stay closed and the old flow run.
  const singleMotionB64 = fs.readFileSync('/tmp/ms-test/sway_gt_h264.mp4').toString('base64');
  const beforeCount = await page.evaluate(() => window.__ms.library.getAll().length);
  await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const file = new File([bytes], 'sway_gt.mp4', { type: 'video/mp4' });
    const input = document.getElementById('motion-input');
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, singleMotionB64);

  // Wait for either the picker (fail) or the extraction modal (pass).
  // The service takes several seconds on MPS. Use tighter polling so a
  // brief flash of the picker (a regression) isn't missed.
  let sawPicker = false, sawExtract = false;
  const startWait = Date.now();
  while (Date.now() - startWait < 30000) {
    await new Promise(r => setTimeout(r, 80));
    const has = await page.evaluate(() => ({
      picker: !!document.querySelector('.multipick-modal'),
      extract: !!document.querySelector('.extract-modal'),
    }));
    if (has.picker) { sawPicker = true; break; }
    if (has.extract) { sawExtract = true; break; }
  }
  ok(!sawPicker, 'single-motion sway_gt clip did NOT trigger the picker');
  ok(sawExtract, 'single-motion sway_gt clip DID trigger the original extraction modal');
  // skip through the extraction modal so cleanup is clean
  await page.evaluate(() => {
    const s = document.querySelector('.extract-skip'); if (s) s.click();
  });
  try {
    await page.waitForFunction(() => !document.querySelector('.extract-modal'), { timeout: 3000 });
  } catch {}
  const finalCount = await page.evaluate(() => window.__ms.library.getAll().length);
  ok(finalCount === beforeCount + 1, `single-motion path still adds exactly one motion (${beforeCount}→${finalCount})`);

  // ---- 7) REGRESSION: cancelling the picker adds nothing ----
  const cancelStart = await page.evaluate(() => window.__ms.library.getAll().length);
  await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const file = new File([bytes], 'multi2c.mp4', { type: 'video/mp4' });
    const input = document.getElementById('motion-input');
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, multi2);
  try {
    await page.waitForSelector('.multipick-modal', { timeout: 30000 });
  } catch {
    ok(false, 'cancel path: picker did not reappear on second multi-motion upload');
  }
  await page.click('.mp-cancel');
  try {
    await page.waitForFunction(() => !document.querySelector('.multipick-modal'), { timeout: 5000 });
    ok(true, 'Cancel closes the modal');
  } catch {
    ok(false, 'Cancel did not close the modal within 5s');
  }
  const afterCancel = await page.evaluate(() => window.__ms.library.getAll().length);
  ok(afterCancel === cancelStart, `Cancel adds zero motions (${cancelStart}→${afterCancel})`);

  // ---- 8) REGRESSION: the real rain+smoke clip (the reported failure).
  // Subtle atmospheric motion (~0.08 px/frame residual) must NOT be rejected —
  // it must produce ≥2 nameable regions, each carrying real trajectory motion.
  const rainPath = '/tmp/ms-test/rain_smoke_h264.mp4';
  if (fs.existsSync(rainPath)) {
    const rainB64 = fs.readFileSync(rainPath).toString('base64');
    const rain = await page.evaluate(async (b64) => {
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const form = new FormData();
      form.append('file', new File([bytes], 'rain_smoke.mp4', { type: 'video/mp4' }));
      const r = await fetch('http://127.0.0.1:8765/analyze', { method: 'POST', body: form });
      const j = await r.json();
      const regs = j.regions || [];
      // measure max normalized trajectory displacement per region
      const disp = regs.map(rg => {
        let m = 0;
        for (const tr of rg.trajectories) {
          const [x0, y0] = tr[0];
          for (const [px, py] of tr) m = Math.max(m, Math.hypot(px - x0, py - y0));
        }
        return m;
      });
      return { count: regs.length, names: regs.map(rg => rg.suggested_name), disp };
    }, rainB64);
    ok(rain.count >= 2, `rain+smoke clip yields ≥2 regions (got ${rain.count}: ${JSON.stringify(rain.names)})`);
    ok(rain.disp.every(d => d > 0.005), `each rain/smoke region carries real trajectory motion (disp=${JSON.stringify(rain.disp.map(d => +d.toFixed(3)))})`);
  } else {
    console.log('⚠️  SKIP rain+smoke regression (fixture /tmp/ms-test/rain_smoke_h264.mp4 not found)');
  }

  console.log('\npage errors:', errors.length ? errors.join('\n') : '(none)');
  if (errors.length) FAIL = true;
  await browser.close();
  console.log('\n' + (FAIL ? '❌ ISSUES FOUND' : '✅ ALL GOOD'));
  process.exit(FAIL ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
