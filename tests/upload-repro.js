// Reproduce the broken upload path end-to-end with a real video file.
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  const errors = [];
  page.on('pageerror', e => errors.push('[pageerror] ' + e.message));
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warn') errors.push('[' + m.type() + '] ' + m.text()); });
  await page.goto('http://localhost:8000', { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 400));

  // click the real upload button and feed the flag test video
  const [chooser] = await Promise.all([
    page.waitForFileChooser(),
    page.click('#btn-upload-motion'),
  ]);
  await chooser.accept(['/tmp/ms-test/sway_gt_h264.mp4']);

  // wait up to 30s for either the extraction modal, a new chip, or an error status
  const outcome = await page.evaluate(async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
      const modal = document.querySelector('.extract-modal');
      const chips = document.querySelectorAll('.motion-chip').length;
      const status = document.getElementById('status').textContent;
      const us = document.getElementById('upload-status').textContent;
      if (modal) {
        // let the modal run its course (skip after 1s to speed up)
        await new Promise(r => setTimeout(r, 1000));
        const skip = document.querySelector('.extract-skip');
        if (skip) skip.click();
      }
      if (chips > 8) return { ok: true, chips, status, us };
      if (/failed|error|could not/i.test(us)) return { ok: false, status, us };
      await new Promise(r => setTimeout(r, 400));
    }
    return { ok: false, timeout: true,
      status: document.getElementById('status').textContent,
      us: document.getElementById('upload-status').textContent };
  });
  console.log('OUTCOME:', JSON.stringify(outcome, null, 1));
  console.log('ERRORS:', errors.join('\n') || '(none)');
  await browser.close();
  process.exit(outcome.ok ? 0 : 1);
})();
