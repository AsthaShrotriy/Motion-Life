// Generate the STATIC hero (before-state) from the app's own scenery code.
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto('http://localhost:8000', { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 300));
  const svgText = await page.evaluate(() => {
    const svg = document.querySelector('#artwork-container svg').cloneNode(true);
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const hl = svg.querySelector('#ms-highlights'); if (hl) hl.remove();
    svg.querySelectorAll('.ms-wrap').forEach(w => w.removeAttribute('transform'));
    return new XMLSerializer().serializeToString(svg);
  });
  fs.writeFileSync('/Volumes/workplace/SNEAKS/motion-swatch-poc/travel-site/assets/hero.svg', svgText);
  console.log('static hero written,', svgText.length, 'bytes');
  await browser.close();
})();
