/**
 * How wide is the caption row, and what is taking the space?
 *
 * Ad-hoc probe. Prints, asserts nothing.
 *
 *   node test/browser/probe-row-widths.mjs
 *
 * The report is "the bar spills onto a third line". Which line, and by how much, is
 * the only way to choose a compaction that fixes it rather than moving the spill
 * somewhere else. Measures each child's width so the answer names a culprit instead of
 * a guess.
 */

import { launchExtension } from './harness.mjs';

const { context, extensionId, close } = await launchExtension();
const page = await context.newPage();

await page.goto(`chrome-extension://${extensionId}/src/reader/reader.html`);
await page.waitForTimeout(1200);
await page.setInputFiles('#pick-files', 'test/mkv/three-tracks.mkv');
await page.waitForTimeout(2500);

const WIDTHS = [1440, 1280, 1100, 1024, 900, 800, 700];

console.log('viewport | row heights (time/transport/captions) | wrapped rows');
for (const width of WIDTHS) {
  await page.setViewportSize({ width, height: 800 });
  await page.waitForTimeout(150);
  const report = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.bar .row')];
    return rows.map((row) => {
      const children = [...row.children].filter((child) => !child.hidden);
      return {
        className: row.className.replace('row ', ''),
        height: Math.round(row.getBoundingClientRect().height),
        wrapped: row.getBoundingClientRect().height > 40,
        content: Math.round(children.reduce((sum, child) => sum + child.getBoundingClientRect().width, 0)),
        width: Math.round(row.getBoundingClientRect().width),
        // The widest children, so the caller names the culprit rather than guessing.
        widest: children
          .map((child) => ({
            name: child.id || child.className || child.tagName.toLowerCase(),
            w: Math.round(child.getBoundingClientRect().width),
          }))
          .sort((a, b) => b.w - a.w)
          .slice(0, 3),
      };
    });
  });
  const heights = report.map((entry) => entry.height).join('/');
  const wrapped = report.filter((entry) => entry.wrapped).map((entry) => entry.className).join(',') || 'none';
  console.log(`${String(width).padStart(8)} | ${heights.padEnd(12)} | ${wrapped}`);
  if (width === 1024) {
    const dump = await page.evaluate(() => {
      const out = {};
      for (const row of document.querySelectorAll('.bar .row')) {
        out[row.className.replace('row ', '')] = [...row.children].filter((c) => !c.hidden).map((child) => ({
          name: child.id || child.className.split(' ')[0] || child.tagName.toLowerCase(),
          w: Math.round(child.getBoundingClientRect().width),
          text: (child.textContent || '').trim().slice(0, 12),
        }));
      }
      return out;
    });
    for (const [rowName, kids] of Object.entries(dump)) {
      const total = kids.reduce((sum, k) => sum + k.w, 0);
      console.log(`         ${rowName}: total ${total}px, ${kids.length} children`);
      console.log('           ' + kids.map((k) => `${k.name}=${k.w}${k.text ? `(${k.text})` : ''}`).join(' '));
    }
  }
}

await close();
