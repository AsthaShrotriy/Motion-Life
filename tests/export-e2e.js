// E2E for the animated-SVG export:
//  1. select objects + assign motions in the real app, call buildExportSVG
//  2. sanity-check the produced markup (style, keyframes, no highlights)
//  3. load the export on a BARE page as <img> (scripts impossible in <img>)
//     and prove pixels change over time => CSS animation runs standalone
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
  await page.evaluate(() => window.__ms.loadScene('scenery'));
  await new Promise(r => setTimeout(r, 400));

  const svgText = await page.evaluate(() => {
    const { sel, library } = window.__ms;
    const svg = document.querySelector('#artwork-container svg');
    const pick = (name, motion) => {
      const w = svg.querySelector(`[data-ms-name="${name}"]`);
      sel._createSVGSelection(w);
      sel.getActive().motionId = motion;
    };
    pick('cloud 1', 'cloud-drift');
    pick('mist', 'rising-smoke');
    pick('boat', 'water-ripple');
    return buildExportSVG(sel, library);
  });

  ok(!!svgText && svgText.startsWith('<svg'), 'export produces an <svg> document');
  ok(svgText.includes('<style>') || svgText.includes('<style '), 'export embeds a <style> block');
  ok((svgText.match(/@keyframes/g) || []).length === 3, `3 @keyframes blocks for 3 animated objects (got ${(svgText.match(/@keyframes/g) || []).length})`);
  ok(!svgText.includes('ms-highlights'), 'selection highlights stripped from export');
  ok(!svgText.includes('<script'), 'no scripts in export');
  fs.writeFileSync('/Volumes/workplace/SNEAKS/motion-swatch-poc/demo-export.svg', svgText);

  // bare page, export used as a plain <img> — the strictest embedding
  const bare = `<!DOCTYPE html><html><body style="margin:0"><img id="poster" src="demo-export.svg" style="width:800px"></body></html>`;
  fs.writeFileSync('/Volumes/workplace/SNEAKS/motion-swatch-poc/demo-embed.html', bare);

  const page2 = await browser.newPage();
  await page2.setViewport({ width: 900, height: 600 });
  await page2.goto('http://localhost:8000/demo-embed.html', { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 300));
  const shots = [];
  for (let i = 0; i < 3; i++) {
    shots.push(await page2.screenshot({ clip: { x: 300, y: 100, width: 300, height: 300 } }));
    await new Promise(r => setTimeout(r, 400));
  }
  const distinct = new Set(shots.map(b => b.toString('base64'))).size;
  ok(distinct >= 2, `exported SVG animates as a plain <img> with no JS (${distinct}/3 distinct screenshots)`);

  console.log('\npage errors:', errors.length ? errors.join('\n') : '(none)');
  if (errors.length) FAIL = true;
  await browser.close();
  console.log('\n' + (FAIL ? '❌ ISSUES FOUND' : '✅ ALL GOOD'));
  process.exit(FAIL ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
