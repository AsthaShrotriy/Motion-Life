// E2E: browser app uses the RAFT analysis service for uploaded motion videos.
//  1. health check reachable from the page
//  2. uploading the ground-truth 0.8Hz sway video via the REAL MotionCapture path
//     routes through the service (engine says raft) and returns accurate params
//  3. fallback: with service URL broken, capture still works via in-browser LK
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
let FAIL = false;
const ok = (c, m) => { console.log((c ? '✅ ' : '❌ FAIL: ') + m); if (!c) FAIL = true; };

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://localhost:8000', { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 400));

  // ship the ground-truth video into the page as a File
  const videoB64 = fs.readFileSync('/tmp/ms-test/sway_gt_h264.mp4').toString('base64');

  const result = await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const file = new File([bytes], 'sway_gt.mp4', { type: 'video/mp4' });
    const capture = new MotionCapture();
    const health = await capture.serviceAvailable();
    const motion = await capture.captureFromFile(file);
    return {
      health,
      engine: motion ? motion.engine : null,
      params: motion ? motion.params : null,
      hasTrajectories: motion ? Array.isArray(motion.trajectories) && motion.trajectories.length > 0 : false,
      hasVideoUrl: motion ? !!motion.videoUrl : false,
    };
  }, videoB64);

  ok(!!result.health, `service health reachable from page (${JSON.stringify(result.health)})`);
  ok(result.engine && result.engine.startsWith('raft_'), `capture routed through RAFT service (any raft engine) (engine="${result.engine}")`);
  if (result.params) {
    const f = result.params.frequency;
    ok(Math.abs(f - 0.8) < 0.15, `RAFT-extracted frequency ${f}Hz ≈ ground truth 0.8Hz`);
    ok(result.params.direction <= 10 || result.params.direction >= 170, `direction ${result.params.direction}° ≈ horizontal`);
    ok(result.params.phaseSpread < 0.2, `phaseSpread ${result.params.phaseSpread} ≈ 0 (rigid block moves in unison)`);
  } else { ok(false, 'no params returned'); }
  ok(result.hasTrajectories, 'dense trajectories included (144 grid tracks)');
  ok(result.hasVideoUrl, 'videoUrl kept for the card thumbnail');

  // ---- fallback test: break the service URL, must fall back to browser LK ----
  const fallback = await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const file = new File([bytes], 'sway_gt.mp4', { type: 'video/mp4' });
    const capture = new MotionCapture();
    capture.serviceAvailable = async () => null;   // simulate service down
    const motion = await capture.captureFromFile(file);
    return motion ? { engine: motion.engine, freq: motion.params.frequency } : null;
  }, videoB64);
  ok(!!fallback && fallback.engine === 'browser-lk', `service down → falls back to in-browser LK (engine="${fallback && fallback.engine}")`);
  if (fallback) ok(Math.abs(fallback.freq - 0.8) < 0.3, `fallback frequency ${fallback.freq}Hz still plausible`);

  console.log('\npage errors:', errors.length ? errors.join('\n') : '(none)');
  if (errors.length) FAIL = true;
  await browser.close();
  console.log('\n' + (FAIL ? '❌ ISSUES FOUND' : '✅ ALL GOOD'));
  process.exit(FAIL ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
