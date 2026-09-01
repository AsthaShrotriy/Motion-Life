/*
 * Print every group under a figure with its bounding box, so limb JOINTS can be read off
 * measured geometry instead of guessed. The other half of tools/rig-figure.py.
 *
 *   SVG=/path/to/art.svg node tools/measure-parts.js '#Girl_Reaching'
 *   SVG=/path/to/art.svg node tools/measure-parts.js            # whole document
 *
 * Boxes come from getBBox() in a real browser, which is the ONLY way to get them for path
 * data — they are in the SVG's own user space, the same space data-pivot is written in.
 *
 * Reading joints off the boxes: a hip is the top edge of a leg box, at its horizontal
 * centre; a shoulder is the top-left or top-right corner of the torso box; the neck is the
 * torso box's top centre. Cross-check the SIDE against the x ranges rather than trusting the
 * ids — art exported from Illustrator often names parts by where they sit on screen.
 *
 * Needs puppeteer-core (see tests/ for the NODE_PATH the other harnesses use) and Chrome.
 */
const puppeteer = require('puppeteer-core');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SVG = process.env.SVG;
const ROOT = process.argv[2] || null;

if (!SVG) { console.error('set SVG=/path/to/art.svg'); process.exit(2); }

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--allow-file-access-from-files'],
  });
  const page = await browser.newPage();
  await page.goto('file://' + SVG, { waitUntil: 'load' });

  const out = await page.evaluate((rootSel) => {
    const svg = document.querySelector('svg');
    const root = rootSel ? document.querySelector(rootSel) : svg;
    if (!root) return { err: 'no element matches ' + rootSel };
    const bb = el => {
      try {
        const b = el.getBBox();
        return [+b.x.toFixed(1), +b.y.toFixed(1), +b.width.toFixed(1), +b.height.toFixed(1)];
      } catch (_) { return null; }
    };
    const rows = [];
    const walk = (el, depth) => {
      for (const c of el.children) {
        if (!(c instanceof SVGGraphicsElement)) continue;
        if (c.tagName !== 'g') continue;
        rows.push({ depth, id: c.id || '', name: c.getAttribute('data-name') || '',
                    bb: bb(c), xf: c.getAttribute('transform') || '' });
        if (depth < 3) walk(c, depth + 1);
      }
    };
    walk(root, 0);
    return { viewBox: svg.getAttribute('viewBox'), root: bb(root), rows };
  }, ROOT);

  if (out.err) { console.error(out.err); await browser.close(); process.exit(1); }

  console.log('viewBox:', out.viewBox);
  console.log((ROOT || 'document') + ' bbox [x y w h]:', out.root);
  console.log('\ndepth  id                name            [x  y  w  h]                transform');
  for (const r of out.rows) {
    console.log('  ' + r.depth + '    ' + (r.id || '(anon)').padEnd(18) +
      (r.name || '').padEnd(16) + String(r.bb).padEnd(28) + (r.xf ? r.xf.slice(0, 28) : '-'));
  }
  console.log('\nA transform on a group shifts the space its own data-pivot is read in —');
  console.log('check that column before trusting a pivot taken straight off these boxes.');
  await browser.close();
})();
