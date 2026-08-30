/*
 * boy_ui_walk.js — the SAME thing a user does by hand, driven through the real UI:
 *   Upload artwork (#art-input) -> click the boy -> + Capture motion from video (#motion-input)
 *   with assets/videos/walk-man.mp4 -> the swatch lands in the library and drives the figure.
 *
 * boy_walkman.js proves the APPLICATOR by injecting the pre-extracted swatch. This proves the
 * PIPELINE: that a fresh upload reaches _applyLimbs, that upload.js routes a limb-rigged figure
 * to MediaPipe rather than calling it an unrigged puppet, and that the extraction the UI gets
 * (fmt=swatch -> extract_pose_b -> _normalize_clip) matches the committed swatch.
 *
 * Needs: python3 -m http.server 8000 (here) and ./service/run-pose.sh (:8770).
 * The VLM router (:8771) is optional — with it down, upload.js falls back to the selection
 * heuristic, which is why the boy must be SELECTED FIRST. That fallback is exercised here.
 *
 * Run: NODE_PATH=/Volumes/workplace/SNEAKS/motion-swatch-poc/tests/node_modules \
 *      node tests/boy_ui_walk.js
 */
const puppeteer = require('puppeteer-core');

const SVG = process.env.MS_SVG || '/Volumes/workplace/SNEAKS/Motion-Life/assets/scenes/boy-limbs.svg';
const VIDEO = process.env.MS_VIDEO || '/Volumes/workplace/SNEAKS/Motion-Life/assets/videos/walk-man.mp4';
const REF = 'assets/motion/walk-man-extracted.json';   // what the committed swatch says

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  // The router is down in this run, so upload.js may show its footgun confirm(). A user
  // would click OK; do the same rather than hanging the run.
  page.on('dialog', async d => { console.log('dialog:', d.message().split('\n')[0]); await d.accept(); });
  await page.goto('http://localhost:8000/index.html', { waitUntil: 'networkidle0' });

  await page.evaluate(() => {
    const a = window.__ms.animator;
    window.__calls = {};
    for (const m of ['_applyLimbs', '_applyCharacter', '_applyCloth', '_applyWings']) {
      const orig = a[m].bind(a);
      a[m] = (...args) => { window.__calls[m] = (window.__calls[m] || 0) + 1; return orig(...args); };
    }
  });

  // ---- step 1: Upload artwork ----
  await (await page.$('#art-input')).uploadFile(SVG);
  await new Promise(r => setTimeout(r, 1400));

  // ---- step 2: click the boy (a real click through the real hit-test) ----
  const pt = await page.evaluate(() => {
    const svg = document.querySelector('#artwork-container svg');
    const b = svg.querySelector('#Rest_of_Body').getBBox();
    const p = svg.createSVGPoint(); p.x = b.x + b.width / 2; p.y = b.y + b.height / 2;
    const q = p.matrixTransform(svg.getScreenCTM());
    return { x: q.x, y: q.y };
  });
  await page.mouse.click(pt.x, pt.y);
  await new Promise(r => setTimeout(r, 300));
  const selected = await page.evaluate(() => {
    const a = window.__ms.sel.getActive();
    return a ? { name: a.wrap.getAttribute('data-ms-name'),
                 limbs: [...a.wrap.querySelectorAll('[data-limb]')].map(e => e.dataset.limb) } : null;
  });
  console.log('selected:', JSON.stringify(selected));
  if (!selected) { console.log('FAIL: click selected nothing'); await browser.close(); return; }

  // ---- step 3: + Capture motion from video ----
  console.log('uploading', VIDEO, '— MediaPipe on a 12.9s clip takes a while…');
  const t0 = Date.now();
  await (await page.$('#motion-input')).uploadFile(VIDEO);
  // poll the status line the user watches
  let status = '', lastShown = '';
  for (let i = 0; i < 240; i++) {                       // up to 4 min
    await new Promise(r => setTimeout(r, 1000));
    status = await page.evaluate(() => (document.getElementById('upload-status') || {}).textContent || '');
    if (status !== lastShown) { console.log(`  [${((Date.now() - t0) / 1000).toFixed(0)}s] ${status}`); lastShown = status; }
    if (/Added |driving |unreachable|No person|error/i.test(status)) break;
  }

  // ---- what did the upload actually produce, and does it drive the limbs? ----
  const res = await page.evaluate(async (refUrl) => {
    const { sel, animator, library } = window.__ms;
    const a = sel.getActive();
    const R = { status: (document.getElementById('upload-status') || {}).textContent || '' };
    const mine = library.motions.filter(m => m.fromUpload);
    R.uploaded = mine.map(m => ({
      id: m.id, name: m.name, desc: m.desc, engine: m.engine, character: !!m.character,
      joints: m.pose && m.pose.joints && m.pose.joints.length,
      frames: m.pose && m.pose.frames && m.pose.frames.length, fps: m.pose && m.pose.fps,
    }));
    if (!mine.length) { R.error = 'nothing was added to the library'; return R; }
    const m = mine[mine.length - 1];
    R.activeMotionId = a && a.motionId;
    R.autoApplied = !!(a && a.motionId === m.id);

    // compare the FRESH upload against the committed swatch, frame by frame
    try {
      const ref = await (await fetch(refUrl)).json();
      const A = ref.pose.frames, B = m.pose.frames;
      R.cmp = { refFrames: A.length, newFrames: B.length, refJoints: ref.pose.joints.length,
                sameJointOrder: JSON.stringify(ref.pose.joints) === JSON.stringify(m.pose.joints) };
      if (R.cmp.sameJointOrder) {
        let worst = 0, sum = 0, n = 0;
        for (let f = 0; f < Math.min(A.length, B.length); f++)
          for (let j = 0; j < A[f].length; j++) {
            const d = Math.hypot(A[f][j][0] - B[f][j][0], A[f][j][1] - B[f][j][1]);
            worst = Math.max(worst, d); sum += d; n++;
          }
        R.cmp.worstJointDelta = +worst.toFixed(6);
        R.cmp.meanJointDelta = +(sum / n).toFixed(6);
      }
    } catch (e) { R.cmp = { error: e.message }; }

    // now measure what the limbs do, driven by the FRESH swatch only
    if (!a) { R.error = 'selection lost'; return R; }
    a.motionId = m.id; a.intensity = 1; a.speed = 1;
    const els = [...a.wrap.querySelectorAll('[data-limb]')];
    const per = new Map(els.map(e => [e.dataset.limb, { degs: [], tip0: null, tip: 0 }]));
    const tipOf = (el) => {
      const b = el.getBBox(), mm = el.getScreenCTM();
      const x = b.x + b.width / 2, y = b.y + b.height;
      return { x: x * mm.a + y * mm.c + mm.e, y: x * mm.b + y * mm.d + mm.f };
    };
    animator.pause();
    for (const e of els) per.get(e.dataset.limb).tip0 = tipOf(e);
    window.__calls = {};
    const dur = m.pose.frames.length / (m.pose.fps || 15);
    for (let f = 0; f < 60; f++) {
      animator._applyAll(f * dur / 60);
      for (const e of els) {
        const g = per.get(e.dataset.limb);
        const all = [...(e.getAttribute('transform') || '').matchAll(/rotate\(([-\d.]+)/g)];
        if (all.length) g.degs.push(+all[all.length - 1][1]);
        const t = tipOf(e);
        g.tip = Math.max(g.tip, Math.hypot(t.x - g.tip0.x, t.y - g.tip0.y));
      }
    }
    animator.pause();
    R.calls = { ...window.__calls };
    R.limbs = els.map(e => {
      const g = per.get(e.dataset.limb);
      return { limb: e.dataset.limb,
               min: +Math.min(...g.degs).toFixed(1), max: +Math.max(...g.degs).toFixed(1),
               swing: +(Math.max(...g.degs) - Math.min(...g.degs)).toFixed(1),
               tipPx: +g.tip.toFixed(1) };
    });
    return R;
  }, REF);

  console.log('\nfinal status line:', JSON.stringify(res.status));
  console.log('library got:', JSON.stringify(res.uploaded, null, 1));
  if (res.error) { console.log('FAIL:', res.error); await browser.close(); return; }
  console.log('auto-applied to the selection without a second click:', res.autoApplied,
              `(active motionId = ${res.activeMotionId})`);
  console.log('fresh upload vs committed swatch:', JSON.stringify(res.cmp));
  console.log('applicator calls:', JSON.stringify(res.calls));
  console.log('\nper limb, driven by the FRESH upload at intensity 1:');
  console.log('  limb      own rotation           swing    tip travel');
  for (const l of res.limbs) {
    console.log('  ' + l.limb.padEnd(9) + ' ' +
      `${String(l.min).padStart(7)} .. ${String(l.max).padEnd(7)}` + '  ' +
      String(l.swing + '°').padStart(7) + '  ' + String(l.tipPx + 'px').padStart(10));
  }
  console.log('\npage errors:', errs.length ? errs.slice(0, 6) : 'none');
  await browser.close();
})();
