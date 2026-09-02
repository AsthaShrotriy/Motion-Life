const puppeteer = require('puppeteer-core');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto('http://localhost:8000/travel-site/', { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 500));
  await page.screenshot({ path: '/tmp/ms-test/travel-top.png' });
  await page.evaluate(() => document.getElementById('treks').scrollIntoView());
  await new Promise(r => setTimeout(r, 500));
  await page.screenshot({ path: '/tmp/ms-test/travel-mid.png' });
  await page.evaluate(() => document.getElementById('stay').scrollIntoView());
  await new Promise(r => setTimeout(r, 500));
  await page.screenshot({ path: '/tmp/ms-test/travel-stay.png' });
  await browser.close();
  console.log('done');
})();
