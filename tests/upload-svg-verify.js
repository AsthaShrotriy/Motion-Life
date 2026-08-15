// Verify uploaded poster SVGs are click-selectable with SENSIBLE units:
// clicking a small object must NOT select a whole-canvas layer group.
const puppeteer = require('puppeteer-core');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
let FAIL = false;
const ok = (c, m) => { console.log((c ? '✅ ' : '❌ FAIL: ') + m); if (!c) FAIL = true; };

const CASES = {
  figma: `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500" fill="none">
    <g clip-path="url(#c0)">
      <rect width="800" height="500" fill="#123"/>
      <g><path d="M100,100 L300,100 L300,200 L100,200 Z" fill="#e55"/></g>
      <g><circle cx="500" cy="250" r="60" fill="#5e5"/></g>
      <text x="400" y="450" fill="#fff" font-size="40">POSTER</text>
    </g>
    <defs><clipPath id="c0"><rect width="800" height="500"/></clipPath></defs>
  </svg>`,
  illustrator: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 500">
    <defs><style>.cls-1{fill:#264d31;}.cls-2{fill:#e55a3a;}</style></defs>
    <g id="Layer_2"><g id="background"><rect width="800" height="500" fill="#1a2a4a"/></g></g>
    <g id="Layer_1">
      <g id="tree"><path class="cls-1" d="M200,400 L240,300 L280,400 Z"/></g>
      <g id="banner"><path class="cls-2" d="M400,100 C450,90 500,110 550,100 L550,140 C500,150 450,130 400,140 Z"/></g>
      <text id="headline" x="400" y="460" font-size="36" fill="#fff" text-anchor="middle">SUMMER FEST</text>
    </g>
  </svg>`,
  canva: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 500">
    <g transform="translate(0,0)">
      <g transform="matrix(1,0,0,1,0,0)"><rect width="800" height="500" fill="#0d1b2a"/></g>
      <g transform="translate(100,80)"><g><path d="M0,0 L120,0 L120,80 L0,80 Z" fill="#ffb703"/></g></g>
      <g transform="translate(400,200)"><g><ellipse cx="0" cy="0" rx="90" ry="50" fill="#8ecae6"/></g></g>
    </g>
  </svg>`,
};

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://localhost:8000', { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 300));

  for (const [name, svgText] of Object.entries(CASES)) {
    const r = await page.evaluate(async (text) => {
      const container = document.getElementById('artwork-container');
      const { sel, library, animator } = window.__ms;
      container.innerHTML = text;
      const svg = container.querySelector('svg');
      svg.style.width = '100%'; svg.style.height = '100%';
      if (!svg.getAttribute('viewBox')) {
        const w = svg.getAttribute('width') || 800, h = svg.getAttribute('height') || 500;
        svg.setAttribute('viewBox', `0 0 ${parseFloat(w)} ${parseFloat(h)}`);
      }
      sel.attachSVG(svg);

      // REAL CLICKS on small drawables (skip full-bleed backgrounds)
      const results = [];
      const vb = svg.viewBox.baseVal;
      for (const el of svg.querySelectorAll('path, circle, ellipse, text')) {
        const bb = el.getBoundingClientRect();
        if (!bb.width) continue;
        const cx = bb.x + bb.width / 2, cy = bb.y + bb.height / 2;
        const target = document.elementFromPoint(cx, cy);
        if (!target) { results.push({ tag: el.tagName, selected: false }); continue; }
        const before = sel.selections.length;
        target.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: cx, clientY: cy }));
        const s = sel.getActive();
        let coverage = 1;
        if (s && s.wrap) {
          const b = s.wrap.getBBox();
          coverage = (b.width * b.height) / ((vb.width || 800) * (vb.height || 500));
        }
        results.push({
          tag: el.tagName,
          selected: sel.selections.length > before || !!s,
          name: s ? s.name : null,
          coverage: +coverage.toFixed(2),
        });
      }
      // can a motion actually be applied + animate?
      let animates = false;
      if (sel.getActive()) {
        library.select('gentle-sway');
        sel.getActive().motionId = 'gentle-sway';
        animator.play();
        const wrap = sel.getActive().wrap;
        const t0 = wrap.getAttribute('transform') || wrap.innerHTML.length;
        await new Promise(r2 => setTimeout(r2, 300));
        const t1 = wrap.getAttribute('transform') || wrap.innerHTML.length;
        animates = t0 !== t1;
        animator.pause();
      }
      return { results, animates };
    }, svgText);

    const allSelected = r.results.every(x => x.selected);
    const sensible = r.results.filter(x => x.coverage < 0.7).length;
    ok(allSelected, `${name}: every clicked object selects something (${JSON.stringify(r.results.map(x => x.name))})`);
    ok(sensible >= r.results.length - 1, `${name}: selections are tight units, not whole-canvas layers (${r.results.map(x => x.coverage).join(', ')})`);
    ok(r.animates, `${name}: applied motion animates the selection`);
  }

  console.log('\npage errors:', errors.length ? errors.join('\n') : '(none)');
  if (errors.length) FAIL = true;
  await browser.close();
  console.log('\n' + (FAIL ? '❌ ISSUES FOUND' : '✅ ALL GOOD'));
  process.exit(FAIL ? 1 : 0);
})().catch(e => { console.error('HARNESS CRASHED:', e); process.exit(1); });
