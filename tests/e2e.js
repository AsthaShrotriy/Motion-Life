// Core E2E: click-to-select, motion application, pause reset, uploaded-SVG
// clickability. Rebuilt after /tmp cleanup ate the original; targets the
// "Amber Jetty" scene (flag + tree 1 maple + leaves).
const puppeteer = require('puppeteer-core');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const assert = (cond, msg) => { if (!cond) { console.log('❌ FAIL: ' + msg); FAILED = true; } else { console.log('✅ ' + msg); } };
let FAILED = false;

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--window-size=1400,900'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('[console.error] ' + m.text()); });

  await page.goto('http://localhost:8000', { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 500));

  // TEST 1: real mouse click on the flag selects it
  const clickTest = await page.evaluate(() => {
    const svg = document.querySelector('#artwork-container svg');
    const flag = svg.querySelector('[data-name="flag"]');
    const r = flag.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const target = document.elementFromPoint(cx, cy);
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: cx, clientY: cy }));
    const sel = window.__ms.sel;
    return { count: sel.selections.length, name: sel.getActive() ? sel.getActive().name : null };
  });
  assert(clickTest.count === 1, `clicking the flag creates 1 selection (got ${clickTest.count})`);
  assert(clickTest.name === 'flag', `selected object is "flag" (got "${clickTest.name}")`);

  // TEST 2: apply motion -> the object animates.
  // Poster scene: flag (cloth-wave) + title (rigid).
  const anim = await page.evaluate(async () => {
    const { sel, library, animator } = window.__ms;
    library.select('flag-flutter');
    sel.getActive().motionId = 'flag-flutter';
    const cloth = sel.getActive().wrap.querySelector('path');

    const svg = document.querySelector('#artwork-container svg');
    const treeWrap = svg.querySelector('[data-ms-name="title"]');
    sel._createSVGSelection(treeWrap);
    sel.getActive().motionId = 'gentle-sway';

    animator.play();
    await new Promise(r => setTimeout(r, 200));   // let glyph split happen
    const glyph = treeWrap.querySelector('text[data-ms-glyph]');
    const dSamples = [], tSamples = [];
    await new Promise(res => { let n = 0; const iv = setInterval(() => {
      dSamples.push(cloth.getAttribute('d'));
      tSamples.push((glyph && glyph.getAttribute('transform')) || '');
      if (++n >= 5) { clearInterval(iv); res(); } }, 120); });
    animator.pause();
    return {
      dDistinct: new Set(dSamples).size,
      tDistinct: new Set(tSamples.filter(Boolean)).size,
      flagAfter: cloth.getAttribute('d') === cloth.getAttribute('data-ms-d0'),
      treeAfter: (glyph && glyph.getAttribute('transform')) || '',
    };
  });
  assert(anim.dDistinct >= 2, `flag cloth geometry morphs over time (${anim.dDistinct} distinct)`);
  assert(anim.tDistinct >= 2, `title glyphs animate over time (${anim.tDistinct} distinct)`);
  assert(anim.flagAfter, 'pause restores flag geometry');
  assert(!anim.treeAfter, `pause resets glyph transform (got "${anim.treeAfter}")`);

  // TEST 3: poster has 2 wrapped objects; scenery tab has 12
  const wrapCount = await page.evaluate(() =>
    document.querySelectorAll('#artwork-container svg .ms-wrap').length);
  assert(wrapCount === 2, `poster: 2 selectable objects wrapped (got ${wrapCount})`);
  const sceneryCount = await page.evaluate(async () => {
    window.__ms.loadScene('scenery');
    return document.querySelectorAll('#artwork-container svg .ms-wrap').length;
  });
  assert(sceneryCount === 12, `scenery: 12 selectable objects wrapped (got ${sceneryCount})`);

  // TEST 4: uploaded SVG elements are clickable
  const upload = await page.evaluate(() => {
    const container = document.getElementById('artwork-container');
    const { sel } = window.__ms;
    container.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
      <rect id="box-a" x="10" y="10" width="60" height="60" fill="red"/>
      <circle id="ball-b" cx="150" cy="150" r="30" fill="blue"/></svg>`;
    const svg = container.querySelector('svg');
    svg.style.width = '100%'; svg.style.height = '100%';
    sel.attachSVG(svg);
    const wraps = svg.querySelectorAll('.ms-wrap').length;
    svg.querySelector('#ball-b').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return { wraps, name: sel.getActive() ? sel.getActive().name : null };
  });
  assert(upload.wraps === 2, `uploaded SVG wraps 2 elements (got ${upload.wraps})`);
  assert(upload.name === 'ball-b', `clicking uploaded element selects "ball-b" (got "${upload.name}")`);

  console.log('\npage errors:', errors.length ? errors.join('\n') : '(none)');
  if (errors.length) FAILED = true;
  await browser.close();
  console.log('\n' + (FAILED ? '❌❌❌ SOME TESTS FAILED' : '✅✅✅ ALL TESTS PASSED'));
  process.exit(FAILED ? 1 : 0);
})().catch(e => { console.error('HARNESS CRASHED:', e); process.exit(1); });
