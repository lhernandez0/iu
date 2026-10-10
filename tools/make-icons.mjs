/**
 * Regenerate the extension icons from `icons/icon.svg`.
 *
 * Run with `npm run icons`. The PNGs are committed, so this is only needed when
 * the SVG changes, but it must exist, or the icons would be four opaque binaries
 * nobody can edit.
 *
 * Why a browser rather than an image library: rasterising is the one thing this
 * would otherwise need a dependency for, and the project already requires
 * Playwright's Chromium for the browser test tier. Using it here adds nothing to
 * install and keeps the project's "no build step, no dependencies" promise,
 * `npm test` still runs with nothing installed, because this script is not part
 * of it.
 *
 * Why not an SVG-only icon: Manifest V3 does not accept SVG for `action` icons.
 * PNGs are required, so something has to rasterise, and it should be a committed
 * script rather than a manual step nobody can repeat.
 *
 * @example
 *   npm run icons
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { findChrome } from './lib/chrome.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SVG = join(ROOT, 'icons', 'icon.svg');

/** The sizes Chrome asks for, and what each is used for. */
const SIZES = [
  { size: 16, used: 'toolbar' },
  { size: 32, used: 'Windows taskbar, app menus' },
  { size: 48, used: 'extensions page' },
  { size: 128, used: 'install dialog, Web Store listing' },
];

const svg = readFileSync(SVG, 'utf8');

// The SVG declares its own viewBox and is square. Reading it rather than
// assuming 16 keeps this script correct if the artwork is ever redrawn larger,
// a hardcoded "16" would silently stretch every icon.
const viewBox = /viewBox="([\d.\s-]+)"/.exec(svg)?.[1]?.trim().split(/\s+/).map(Number);
if (!viewBox || viewBox.length !== 4) {
  console.error('icons/icon.svg has no usable viewBox; cannot rasterise it.');
  process.exit(1);
}
const [,, boxWidth, boxHeight] = viewBox;
if (boxWidth !== boxHeight) {
  console.error(`icons/icon.svg is not square (${boxWidth}x${boxHeight}); Chrome icons must be.`);
  process.exit(1);
}

const executablePath = findChrome();
if (!executablePath) {
  console.error('No Chromium found to rasterise with. Set CHROME_PATH.');
  process.exit(1);
}

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

console.log(`\nRendering icons from icons/icon.svg (${boxWidth}x${boxHeight})\n`);

for (const { size, used } of SIZES) {
  const page = await browser.newPage({
    // The device scale factor is left at 1 and the viewport set to the exact
    // pixel size, so one CSS pixel is one output pixel. Setting a scale factor
    // instead would produce a 2x image and a file four times the size for no
    // visible gain at these dimensions.
    viewport: { width: size, height: size },
  });

  // A transparent page with the SVG stretched to fill it. `omitBackground` keeps
  // the area outside the rounded tile transparent rather than white, which
  // matters on a dark toolbar.
  await page.setContent(
    `<!doctype html><html><head><style>
       html,body{margin:0;padding:0;background:transparent}
       svg{display:block;width:${size}px;height:${size}px}
     </style></head><body>${svg}</body></html>`,
    { waitUntil: 'load' },
  );

  const buffer = await page.screenshot({ omitBackground: true, type: 'png' });
  await page.close();

  const file = join(ROOT, 'icons', `icon-${size}.png`);
  writeFileSync(file, buffer);
  console.log(`  icon-${size}.png  ${String(buffer.length).padStart(6)} bytes  (${used})`);
}

await browser.close();

// Read back what was written. A rasterised icon that came out blank is the
// failure this check exists for: it is invisible in a directory listing, and it
// would only show up as an empty toolbar button.
console.log('\nVerifying the files are real images:');
let failed = 0;
for (const { size } of SIZES) {
  const file = join(ROOT, 'icons', `icon-${size}.png`);
  if (!existsSync(file)) {
    console.log(`  FAIL  icon-${size}.png missing`);
    failed++;
    continue;
  }
  const bytes = readFileSync(file);
  // PNG signature, then the IHDR chunk's width and height as big-endian u32.
  const isPng = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const ok = isPng && width === size && height === size;
  if (!ok) failed++;
  console.log(`  ${ok ? 'pass' : 'FAIL'}  icon-${size}.png is a ${width}x${height} PNG`);
}

console.log(
  failed
    ? `\n  ${failed} icon(s) are wrong, the toolbar would show a blank or stretched mark.\n`
    : '\n  icons are ready. manifest.json declares them; run `npm test` to check that.\n',
);
process.exit(failed ? 1 : 0);
