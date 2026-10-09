import { chromium } from 'playwright';
import { findChrome } from '../../tools/lib/chrome.mjs';

const b = await chromium.launch({ executablePath: findChrome(), headless: true, args: ['--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
p.on('pageerror', (e) => errors.push(e.message));

const read = () =>
  p.evaluate(() => {
    const el = document.getElementById('pp-filename');
    return { text: el.textContent, title: el.title.slice(0, 70) };
  });

for (const src of ['', '?src=/tools/ui/assets/two-audio.mkv']) {
  await p.goto(`http://127.0.0.1:8099/tools/ui/player.html${src}`, { waitUntil: 'load' });
  await p.waitForTimeout(1200);
  console.log((src || '(default)').padEnd(40), JSON.stringify(await read()));
}
console.log('errors:', errors.length ? errors : 'none');
await b.close();
