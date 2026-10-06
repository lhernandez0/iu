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

import { existsSync } from 'node:fs';

/** @returns {string|null} */
export function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    `${process.env.HOME}/.cache/ms-playwright/chromium-1224/chrome-linux64/chrome`,
    `${process.env.HOME}/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome`,
    `${process.env.HOME}/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome`,
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ];
  return candidates.find((path) => path && existsSync(path)) ?? null;
}
