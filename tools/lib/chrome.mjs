/**
 * Locate a Chromium that can load extensions.
 *
 * Shared by the capture tool and the browser test harness, and deliberately not
 * owned by either: capture is the only thing that touches the network, so it
 * must not depend on test scaffolding — and the tests must not depend on the
 * capture tool.
 *
 * The bundled Playwright headless shell cannot load extensions, which is why a
 * full browser is needed. Several paths are tried because this may run in WSL,
 * where the browser was installed by the editor's tooling rather than by
 * `playwright install`.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every Playwright Chromium build on this machine, newest first.
 *
 * **Discovered rather than listed.** The paths used to be three hardcoded build
 * numbers, which is correct on exactly the machine where they were written: the
 * build number changes with every Playwright release, and `playwright install`
 * in CI — or on any other contributor's machine — produces a different one. The
 * failure was silent in the worst way, because a browser that cannot be found
 * makes the whole tier SKIP and report green.
 *
 * @returns {string[]}
 */
function playwrightChromiums() {
  const root = join(process.env.HOME ?? '', '.cache', 'ms-playwright');
  if (!existsSync(root)) return [];

  try {
    return readdirSync(root)
      // `chromium-1224`, `chromium_headless_shell-1224`, `firefox-1520` and so on.
      // Only the `chromium-` prefix is a full browser: the bundled headless shell
      // cannot load extensions, so it is deliberately excluded rather than
      // discovered and rejected later.
      .filter((entry) => /^chromium-\d+$/.test(entry))
      // Newest build first, so a machine with several gets the current one.
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
      .map((entry) => {
        const base = join(root, entry);
        // The layout differs by platform: `chrome-linux64` on Linux, and a nested
        // `.app` on macOS.
        for (const rel of ['chrome-linux64/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
          const full = join(base, rel);
          if (existsSync(full)) return full;
        }
        return null;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** @returns {string|null} */
export function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    ...playwrightChromiums(),
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  return candidates.find((path) => path && existsSync(path)) ?? null;
}
