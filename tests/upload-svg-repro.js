// Reproduce: uploaded poster SVGs where clicking selects nothing.
// Tests several realistic export structures (Illustrator/Figma/Canva-style).
const puppeteer = require('puppeteer-core');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const CASES = {
  // Figma-style: one big wrapping <g>, elements WITHOUT ids
  figma: `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500" fill="none">
    <g clip-path="url(#c0)">
      <rect width="800" height="500" fill="#123"/>
      <g><path d="M100,100 L300,100 L300,200 L100,200 Z" fill="#e55"/></g>
      <g><circle cx="500" cy="250" r="60" fill="#5e5"/></g>
      <text x="400" y="450" fill="#fff" font-size="40">POSTER</text>
    </g>
    <defs><clipPath id="c0"><rect width="800" height="500"/></clipPath></defs>
  </svg>`,
  // Illustrator-style: nested layer groups with ids, style block
  illustrator: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 500">
    <defs><style>.cls-1{fill:#264d31;}.cls-2{fill:#e55a3a;}</style></defs>
    <g id="Layer_2"><g id="background"><rect width="800" height="500" fill="#1a2a4a"/></g></g>
    <g id="Layer_1">
      <g id="tree"><path class="cls-1" d="M200,400 L240,300 L280,400 Z"/></g>
      <g id="banner"><path class="cls-2" d="M400,100 C450,90 500,110 550,100 L550,140 C500,150 450,130 400,140 Z"/></g>
      <text id="headline" x="400" y="460" font-size="36" fill="#fff" text-anchor="middle">SUMMER FEST</text>
    </g>
  </svg>`,
  // Canva-ish: deeply nested, transforms on groups, no ids anywhere
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
    const r = await page.evaluate((text) => {
      const container = document.getElementById('artwork-container');
      const { sel } = window.__ms;
      container.innerHTML = text;
      const svg = container.querySelector('svg');
      svg.style.width = '100%'; svg.style.height = '100%';
      if (!svg.getAttribute('viewBox')) {
        const w = svg.getAttribute('width') || 800, h = svg.getAttribute('height') || 500;
        svg.setAttribute('viewBox', `0 0 ${parseFloat(w)} ${parseFloat(h)}`);
      }
      sel.attachSVG(svg);
      const wraps = [...svg.querySelectorAll('.ms-wrap')].map(w => w.getAttribute('data-ms-name'));
      // try clicking the middle of each drawable leaf
      const clickable = [];
      for (const el of svg.querySelectorAll('path, circle, ellipse, rect, text')) {
        const bb = el.getBoundingClientRect();
        if (!bb.width) continue;
        const target = document.elementFromPoint(bb.x + bb.width / 2, bb.y + bb.height / 2);
        const inWrap = target && !!target.closest && !!target.closest('.ms-wrap');
        clickable.push({ tag: el.tagName, inWrap });
      }
      return { wraps, clickable };
    }, svgText);
    console.log(`=== ${name} ===`);
    console.log('wraps:', JSON.stringify(r.wraps));
    console.log('clickable:', JSON.stringify(r.clickable));
  }
  console.log('errors:', errors.join('; ') || '(none)');
  await browser.close();
})();
