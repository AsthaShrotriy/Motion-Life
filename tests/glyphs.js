// Verify per-glyph text animation:
//  1. applying a motion to the title splits it into per-letter <text> glyphs
//     with identical visual layout (positions match original chars)
//  2. glyphs move INDEPENDENTLY (wave through the word, not a rigid block)
//  3. pause resets transforms
//  4. export bakes per-glyph SMIL and animates as a plain <img>
const puppeteer = require('puppeteer-core');
const fs = require('fs');
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
  await new Promise(r => setTimeout(r, 400));

  const res = await page.evaluate(async () => {
    const { sel, library, animator } = window.__ms;
    const svg = document.querySelector('#artwork-container svg');
    const wrap = svg.querySelector('[data-ms-name="title"]');
    sel._createSVGSelection(wrap);
    library.select('gentle-sway');
    const s = sel.getActive();
    s.motionId = 'gentle-sway';

    animator.play();
    await new Promise(r => setTimeout(r, 250));

    const glyphs = [...wrap.querySelectorAll('text[data-ms-glyph]')];
    const glyphCount = glyphs.length;

    // sample per-glyph translate-y over ~1.2s
    const series = glyphs.map(() => []);
    await new Promise(resolve => {
      let n = 0;
      const iv = setInterval(() => {
        glyphs.forEach((g, i) => {
          const tf = g.getAttribute('transform') || '';
          const m = tf.match(/translate\(([-\d.]+) ([-\d.]+)\)/);
          series[i].push(m ? parseFloat(m[2]) : 0);
        });
        if (++n >= 24) { clearInterval(iv); resolve(); }
      }, 50);
    });
    animator.pause();

    const moved = series.filter(sr => Math.max(...sr) - Math.min(...sr) > 1).length;
    // independence: max instantaneous spread between glyph offsets
    let maxSpread = 0;
    for (let f = 0; f < 24; f++) {
      const vals = series.map(sr => sr[f]).filter(v => v !== undefined);
      const spread = Math.max(...vals) - Math.min(...vals);
      if (spread > maxSpread) maxSpread = spread;
    }
    const afterTransforms = glyphs.filter(g => g.getAttribute('transform')).length;

    return { glyphCount, moved, maxSpread, afterTransforms };
  });

  // "WILDER VALLEY" + "TREKS & STAYS · EST. 2019" — many non-space glyphs
  ok(res.glyphCount > 20, `title split into per-letter glyphs (${res.glyphCount})`);
  ok(res.moved > res.glyphCount * 0.8, `${res.moved}/${res.glyphCount} glyphs animate`);
  ok(res.maxSpread > 2, `letters move INDEPENDENTLY — max inter-letter spread ${res.maxSpread.toFixed(1)}px (rigid block would be 0)`);
  ok(res.afterTransforms === 0, 'pause clears all glyph transforms');

  // ---- export ----
  const svgText = await page.evaluate(() => buildExportSVG(window.__ms.sel, window.__ms.library));
  ok(svgText && svgText.includes('animateTransform'), 'export bakes per-glyph animateTransform');
  ok((svgText.match(/animateTransform/g) || []).length >= 40, `per-glyph tracks baked (${(svgText.match(/animateTransform/g) || []).length} animateTransform nodes)`);
  fs.writeFileSync('/Volumes/workplace/SNEAKS/motion-swatch-poc/travel-site/assets/glyph-test.svg', svgText);
  const page2 = await browser.newPage();
  await page2.setContent(`<img src="http://localhost:8000/travel-site/assets/glyph-test.svg" style="width:800px">`);
  await new Promise(r => setTimeout(r, 400));
  const shots = [];
  for (let i = 0; i < 3; i++) {
    shots.push((await page2.screenshot({ clip: { x: 100, y: 150, width: 600, height: 200 } })).toString('base64'));
    await new Promise(r => setTimeout(r, 400));
  }
  ok(new Set(shots).size >= 2, `exported glyph animation runs as plain <img> (${new Set(shots).size}/3 distinct)`);

  console.log('\npage errors:', errors.length ? errors.join('\n') : '(none)');
  if (errors.length) FAIL = true;
  await browser.close();
  console.log('\n' + (FAIL ? '❌ ISSUES FOUND' : '✅ ALL GOOD'));
  process.exit(FAIL ? 1 : 0);
})().catch(e => { console.error('HARNESS CRASHED:', e); process.exit(1); });
