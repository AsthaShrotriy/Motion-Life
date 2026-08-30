/*
 * retarget_cost.js — what rest retargeting costs a figure, and a guard on the shipped default.
 *
 * Rotation here is RIGID: no skinning, no deformation. A drawn limb's silhouette was authored to
 * meet the torso at exactly one angle, so a large rest offset does not "re-pose" the limb, it
 * detaches it. LIMB_RETARGET_DEFAULT = 'all' shipped for one build and the reference boy came
 * apart — head off the neck, both arms folded across the chest with nothing at the shoulder.
 * This test exists so that cannot ship again unnoticed.
 *
 * Reports, per limb: the one-off offset 'all' would apply (after the mirror and the ancestor
 * subtraction), and how far that moves the limb's ink centroid — 2*r*sin(off/2) about the pivot,
 * which is exact and needs no frame chosen, so the swing is not mixed in.
 *
 * FAILS if any limb the DEFAULT mode actually retargets takes an offset past MAX_SAFE_DEG.
 *
 * Run: NODE_PATH=/Volumes/workplace/SNEAKS/motion-swatch-poc/tests/node_modules \
 *      node tests/retarget_cost.js
 * Optional: MS_SVG, MS_SWATCH, MS_RETARGET=off|legs|all to cost a mode other than the default.
 */
const puppeteer = require('puppeteer-core');

const SVG = process.env.MS_SVG || '/Volumes/workplace/SNEAKS/Motion-Life/assets/scenes/boy-limbs.svg';
const SWATCH = process.env.MS_SWATCH || 'assets/motion/walk-man-extracted.json';
const RETARGET = process.env.MS_RETARGET || '';    // '' = whatever the app ships as the default
/* Past roughly a right angle the limb points somewhere the artist never drew a joint for. The
 * boy's legs take +39.5deg and -20deg and hold; his arms take +144.9deg and -120.9deg and do
 * not. 90 sits between them with room on both sides rather than being fitted to them. */
const MAX_SAFE_DEG = 90;

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 1000 });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  await page.goto('http://localhost:8000/index.html', { waitUntil: 'networkidle0' });

  const id = await page.evaluate(async (u) => {
    const sw = await (await fetch(u)).json();
    // a raw capture ({joints,frames}) is wrapped the way js/upload.js wraps one
    const m = sw.pose ? sw : { id: 'probe-' + u, name: u, color: '#7cc4ff',
      params: { frequency: 1, amplitude: 0.5, direction: 0, turbulence: 0, damping: 0, phaseSpread: 0 },
      pose: { joints: sw.joints, fps: sw.fps || 15, frames: sw.frames.filter(Boolean) } };
    window.__ms.library.add(m);
    return m.id;
  }, SWATCH);

  await (await page.$('#art-input')).uploadFile(SVG);
  await new Promise(r => setTimeout(r, 1400));
  const pt = await page.evaluate(() => {
    const svg = document.querySelector('#artwork-container svg');
    const el = svg.querySelector('[data-limb="torso"]') || svg.querySelector('[data-limb]');
    const b = el.getBBox();
    const p = svg.createSVGPoint(); p.x = b.x + b.width / 2; p.y = b.y + b.height / 2;
    const q = p.matrixTransform(svg.getScreenCTM());
    return { x: q.x, y: q.y };
  });
  await page.mouse.click(pt.x, pt.y);
  await new Promise(r => setTimeout(r, 250));

  const out = await page.evaluate(({ mid, retarget }) => {
    const { sel, animator } = window.__ms;
    const a = sel.getActive();
    if (!a) return { error: 'nothing selected' };
    a.motionId = mid; a.intensity = 1; a.speed = 1;
    if (retarget) a.limbRetarget = retarget;
    animator.pause();
    animator._applyAll(0);                       // builds the rig, and with it the offsets
    const L = a._limb;
    if (!L) return { error: 'no limb rig was built — is the figure tagged with data-limb?' };
    const m = a.wrap.getScreenCTM();
    const scale = Math.hypot(m.a, m.b);
    const rows = L.offsets.map((o) => {
      const g = L.limbs.find(x => x.role === o.role);
      const el = a.wrap.querySelector(`[data-limb="${o.role}"]`);
      let sx = 0, sy = 0, n = 0;
      for (const p of el.querySelectorAll('path,polygon,rect,circle,ellipse')) {
        let Lp = 0;
        try { Lp = p.getTotalLength ? p.getTotalLength() : 0; } catch (e) { Lp = 0; }
        if (!(Lp > 0)) continue;
        for (let k = 0; k <= 64; k++) {
          const q = p.getPointAtLength(Lp * k / 64);
          sx += q.x; sy += q.y; n++;
        }
      }
      const r = n ? Math.hypot(sx / n - g.px, sy / n - g.py) : 0;
      return { role: o.role, deg: o.deg, applied: !!g.retarget,
               r: r * scale, move: 2 * r * Math.abs(Math.sin(o.deg * Math.PI / 360)) * scale };
    });
    const hl = document.querySelector('#artwork-container svg #ms-highlights');
    if (hl) hl.remove();
    return { mode: L.mode, mirror: L.mirror, rows,
             unretargeted: L.limbs.filter(g => !L.offsets.some(o => o.role === g.role))
               .map(g => g.role) };
  }, { mid: id, retarget: RETARGET });

  if (out.error) { console.log('ERROR:', out.error); await browser.close(); process.exit(1); }

  console.log(`rest mode in force: ${out.mode}   capture mirrored: ${out.mirror}\n`);
  console.log('  limb     offset      pivot->ink   ink travels   retargeted here?');
  for (const r of out.rows) {
    console.log('  ' + r.role.padEnd(7)
      + ((r.deg > 0 ? '+' : '') + r.deg.toFixed(1) + '°').padStart(9)
      + (Math.round(r.r) + 'px').padStart(13)
      + (Math.round(r.move) + 'px').padStart(14)
      + '   ' + (r.applied ? 'yes' : 'no')
      + (Math.abs(r.deg) > MAX_SAFE_DEG ? '   <- past ' + MAX_SAFE_DEG + '°, would tear' : ''));
  }
  if (out.unretargeted.length) {
    console.log('\n  no usable bone, so never retargeted in any mode: '
      + out.unretargeted.join(', '));
  }

  const bad = out.rows.filter(r => r.applied && Math.abs(r.deg) > MAX_SAFE_DEG);
  if (bad.length) {
    console.log(`\nFAIL  mode '${out.mode}' retargets ${bad.length} limb(s) past ${MAX_SAFE_DEG}°: `
      + bad.map(r => `${r.role} ${r.deg.toFixed(1)}°`).join(', ')
      + '\n      A rigid rotation that large pulls the limb off its joint — there is no skinning.');
  } else {
    console.log(`\nPASS  every limb '${out.mode}' retargets stays inside ${MAX_SAFE_DEG}°`);
  }
  console.log('page errors:', errs.length ? errs.slice(0, 5) : 'none');
  await browser.close();
  process.exit(bad.length ? 1 : 0);
})();
