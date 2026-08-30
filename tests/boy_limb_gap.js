/*
 * boy_limb_gap.js — how far does an arm come off its shoulder?
 *
 * boy_limbs.js measured pivotDrift = 0px for every limb, which is the point: each limb
 * rotates about a FIXED point. But that also means the rig is FLAT, not hierarchical. The
 * torso rotates about the hips, which moves the shoulders — and an arm pivoting about a
 * shoulder point that never moves must separate from it.
 *
 * This measures that separation directly: take the arm's declared pivot, and follow where
 * the SAME viewBox point goes under the TORSO's transform. The distance between them is the
 * gap at the shoulder, in screen px, over the whole clip. Also reports the frame where it
 * is worst so it can be rendered and looked at.
 */
const puppeteer = require('puppeteer-core');
const FILE = process.env.MS_SVG || '/tmp/boy_v3_limbs.svg';

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  await page.goto('http://localhost:8000/index.html', { waitUntil: 'networkidle0' });
  await page.evaluate(async () => {
    const p = await (await fetch('assets/motion/walk-pose.json')).json();
    window.__ms.library.add({
      id: 'char-walk-shipped', name: 'Walk (pre-captured)', color: '#7cc4ff',
      params: { frequency: 1, amplitude: 0.5, direction: 0, turbulence: 0, damping: 0, phaseSpread: 0 },
      pose: { joints: p.joints, fps: p.fps || 15, frames: p.frames.filter(Boolean) },
    });
  });
  await (await page.$('#art-input')).uploadFile(FILE);
  await new Promise(r => setTimeout(r, 1200));
  const pt = await page.evaluate(() => {
    const svg = document.querySelector('#artwork-container svg');
    const b = svg.querySelector('#Rest_of_Body').getBBox();
    const p = svg.createSVGPoint(); p.x = b.x + b.width / 2; p.y = b.y + b.height / 2;
    const q = p.matrixTransform(svg.getScreenCTM());
    return { x: q.x, y: q.y };
  });
  await page.mouse.click(pt.x, pt.y);
  await new Promise(r => setTimeout(r, 200));

  const out = await page.evaluate(() => {
    const { sel, animator } = window.__ms;
    const svg = document.querySelector('#artwork-container svg');
    const a = sel.getActive();
    a.motionId = 'char-walk-shipped'; a.intensity = 1; a.speed = 1;
    const torso = a.wrap.querySelector('[data-limb="torso"]');
    const parts = [['arm-l', 740, 690], ['arm-r', 437, 690], ['head', 514, 655],
                   ['leg-l', 737, 1200], ['leg-r', 500, 1180]];
    const at = (el, vx, vy) => {
      const m = el.getScreenCTM();
      return { x: vx * m.a + vy * m.c + m.e, y: vx * m.b + vy * m.d + m.f };
    };
    const res = parts.map(([n, x, y]) => ({ limb: n, worst: 0, worstT: 0, x, y }));
    animator.pause();
    const N = 132;
    for (let f = 0; f < N; f++) {
      const t = f / 15;
      animator._applyAll(t);
      for (const r of res) {
        const el = a.wrap.querySelector(`[data-limb="${r.limb}"]`);
        const own = at(el, r.x, r.y);          // where the limb thinks its joint is
        const par = at(torso, r.x, r.y);       // where the torso actually carried it
        const d = Math.hypot(own.x - par.x, own.y - par.y);
        if (d > r.worst) { r.worst = d; r.worstT = t; }
      }
    }
    animator.pause();
    const hl = svg.querySelector('#ms-highlights'); if (hl) hl.remove();
    return res.map(r => ({ limb: r.limb, worstGapPx: +r.worst.toFixed(1), atT: +r.worstT.toFixed(2) }));
  });
  console.log('gap between each limb\'s fixed joint and where the torso carried that point:');
  for (const r of out) console.log('  ' + r.limb.padEnd(7) + String(r.worstGapPx + 'px').padStart(8) + '  at t=' + r.atT);

  const worst = out.reduce((a, b) => b.worstGapPx > a.worstGapPx ? b : a);
  await page.evaluate((t) => { window.__ms.animator.pause(); window.__ms.animator._applyAll(t); }, worst.atT);
  await (await page.$('#artwork-container')).screenshot({ path: '/tmp/boy_limb_worstgap.png' });
  console.log(`worst is ${worst.limb} at t=${worst.atT} -> /tmp/boy_limb_worstgap.png`);
  await browser.close();
})();
