/**
 * Browser integration tests — OFFLINE.
 *
 * These run the real extension in real Chromium against a fixture YouTube
 * served from `context.route`. There is no network access: the browser is
 * launched, a page is loaded, and every request is answered locally. Nothing
 * accounts here, no URLs are visited, and the results do not depend on what
 * YouTube is serving today.
 *
 * Opt-in on purpose. These are exempt from `npm test` because launching
 * Chromium takes seconds and would make the default loop slow enough that it
 * stops being run.
 *
 *   npm run test:browser
 */

import { routeYouTube, openWatchPage, openPanel, waitForRows, panelState, pagePosition } from './harness.mjs';
import { runBrowserSuite } from './runner.mjs';
import { ENGLISH, GERMAN, OTHER_ENGLISH } from './fixtures.mjs';

await runBrowserSuite(async ({ context, extensionId, close }, report) => {
  const { check, section } = report;

  // --- 1. The pipeline works at all ----------------------------------------

  section('real extension: a YouTube video with captions loads into the panel');

  {
    const { captionRequests } = await routeYouTube(context, { tracks: [ENGLISH, GERMAN] });
    const watch = await openWatchPage(context);
    const { page, errors } = await openPanel(context, extensionId, watch);
    await waitForRows(page, 3);

    const status = await page.textContent('#status');
    const state = await panelState(page);

    check('status reports the fixture video', status.includes('Fixture Video'), true);
    check('status reports the line count', status.includes('3 lines'), true);
    check('three rows rendered', state.rows.length, 3);
    check('first row text', state.rows[0]?.text, 'Hey there');
    check('first row timestamp', state.rows[0]?.time, '0:00');
    check('last row timestamp', state.rows[2]?.time, '0:04');
    check('the panel genuinely fetched a caption track', captionRequests.length > 0, true);
    check('it asked for JSON3', captionRequests[0]?.includes('fmt=json3'), true);
    check('no console errors', errors, []);
  }

  // --- 2. On-demand injection into an already-open tab ---------------------

  section('the worker injects into a tab that was already open');

  {
    // The page is loaded BEFORE the panel exists, so no panel was there to
    // trigger injection. This is the case that used to require a manual reload.
    const { captionRequests } = await routeYouTube(context, { videoId: 'alreadyopen1', tracks: [ENGLISH] });
    const watch = await openWatchPage(context, 'alreadyopen1');
    await new Promise((resolve) => setTimeout(resolve, 300));

    const { page } = await openPanel(context, extensionId, watch);
    await waitForRows(page, 3);

    const status = await page.textContent('#status');
    check('it resolved without a reload', status.includes('3 lines'), true);
    check('and fetched captions', captionRequests.length > 0, true);
  }

  // --- 3. Click to seek ----------------------------------------------------

  section('clicking a line seeks the real page video');

  {
    await routeYouTube(context, { videoId: 'seekvideo1', tracks: [ENGLISH] });
    const watch = await openWatchPage(context, 'seekvideo1');
    const { page } = await openPanel(context, extensionId, watch);
    await waitForRows(page, 3);

    check('video starts at zero', await pagePosition(watch), 0);

    // Third row is "welcome back" at 4s. The wait has to run in the WATCH page's
    // context: `__position` belongs to that document, not the panel's.
    await page.locator('.row').nth(2).click();
    await watch.waitForFunction(() => window.__position?.() === 4, null, { timeout: 5000 });

    check('the page video moved to the cue', await pagePosition(watch), 4);

    const state = await panelState(page);
    check('and the clicked row is highlighted', state.rows[2]?.active, true);
  }

  // --- 4. Two languages ---------------------------------------------------

  section('a second language renders under the first, aligned');

  {
    await routeYouTube(context, { videoId: 'dualvideo1', tracks: [ENGLISH, GERMAN] });
    const watch = await openWatchPage(context, 'dualvideo1');
    const { page } = await openPanel(context, extensionId, watch);
    await waitForRows(page, 3);

    let state = await panelState(page);
    check('before selecting, one language only', state.rows[0]?.secondary, '');
    check('and both tracks are offered', state.secondaryOptions.includes('de'), true);

    await page.selectOption('#secondary', 'de');
    await page.waitForFunction(
      () => document.querySelector('.row .secondary')?.textContent?.length > 0,
      null,
      { timeout: 10000 },
    );

    state = await panelState(page);
    check('still one row per primary cue', state.rows.length, 3);
    check('first pair', state.rows[0]?.secondary, 'Hallo');
    check('second pair', state.rows[1]?.secondary, 'wie geht es dir');
    check('third pair', state.rows[2]?.secondary, 'willkommen zurueck');
    check('status names both languages', state.status.includes('en + de'), true);
  }

  // --- 5. Caching across tab switches -------------------------------------

  section('switching away and back does not refetch');

  {
    const { captionRequests } = await routeYouTube(context, { videoId: 'cached1', tracks: [ENGLISH] });
    const watch = await openWatchPage(context, 'cached1');
    const { page } = await openPanel(context, extensionId, watch);
    await waitForRows(page, 3);

    const afterFirst = captionRequests.length;
    check('it fetched once', afterFirst > 0, true);

    // Move to a different tab, then come back.
    const other = await context.newPage();
    await other.goto('about:blank');
    await other.bringToFront();
    await page.bringToFront();
    await watch.bringToFront();
    await new Promise((resolve) => setTimeout(resolve, 800));

    check('no additional fetch after switching back', captionRequests.length, afterFirst);

    const state = await panelState(page);
    check('and the transcript is still shown', state.rows.length, 3);
  }

  // --- 6. Degraded cases --------------------------------------------------

  section('a video with no captions says so, and still names the video');

  {
    await routeYouTube(context, { videoId: 'nocaps1', title: 'No Captions Here', tracks: [] });
    const watch = await openWatchPage(context, 'nocaps1');
    const { page } = await openPanel(context, extensionId, watch);

    // Nothing should ever render here, so wait for the error instead of rows.
    await page.waitForFunction(() => document.getElementById('status')?.classList.contains('error'), null, {
      timeout: 20000,
    });
    const state = await panelState(page);
    const status = state.status;

    check('an error is shown', state.isError, true);
    check('the message names the problem', status.includes('no captions'), true);
    check('no rows', state.rows.length, 0);
  }

  section('looking at a non-YouTube tab keeps the last transcript, and does not crash');

  {
    // Deliberate behaviour, and the assertion reflects it: a non-YouTube tab is
    // IGNORED rather than clearing the panel, so glancing at another tab and
    // coming back does not lose your place. What must not happen is a crash or
    // an emptied panel.
    //
    // A known good video is loaded first so this block does not depend on what
    // earlier blocks happened to leave loaded — sections share one browser.
    await routeYouTube(context, { videoId: 'keepme1', tracks: [ENGLISH] });
    const watch = await openWatchPage(context, 'keepme1');
    const { page, errors } = await openPanel(context, extensionId, watch);
    await waitForRows(page, 3);

    const other = await context.newPage();
    await other.goto('about:blank').catch(() => {});
    await other.bringToFront();
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const state = await panelState(page);
    check('it did not crash', errors.filter((e) => e.includes('pageerror')), []);
    check('the last transcript is still on screen', state.rows.length, 3);
    check('and still shows the video it came from', state.status.includes('Fixture Video'), true);

    // Coming back to the video tab keeps it too.
    await watch.bringToFront();
    await new Promise((resolve) => setTimeout(resolve, 800));
    check('and survives coming back', (await panelState(page)).rows.length, 3);
  }

  // --- 7. XML parsing -----------------------------------------------------

  section('an XML caption body is parsed just as well as JSON3');

  {
    await routeYouTube(context, { videoId: 'xmlvideo1', tracks: [ENGLISH], captionFormat: 'xml' });
    const watch = await openWatchPage(context, 'xmlvideo1');
    const { page } = await openPanel(context, extensionId, watch);
    await waitForRows(page, 3);

    const state = await panelState(page);
    check('three rows from XML', state.rows.length, 3);
    check('text read', state.rows[0]?.text, 'Hey there');
    check('timing read', state.rows[2]?.time, '0:04');
  }

  // --- 8. A second video --------------------------------------------------

  section('a different video gets its own transcript');

  {
    await routeYouTube(context, { videoId: 'firstvideo1', title: 'First', tracks: [ENGLISH] });
    await routeYouTube(context, { videoId: 'secondvideo1', title: 'Second', tracks: [OTHER_ENGLISH] });

    await openWatchPage(context, 'firstvideo1');
    const first = context.pages().at(-1);
    const { page } = await openPanel(context, extensionId, first);
    await waitForRows(page, 3);
    check('first video loaded', (await panelState(page)).rows[0]?.text, 'Hey there');

    const second = await openWatchPage(context, 'secondvideo1');
    await second.bringToFront();
    await page.waitForFunction(
      () => document.getElementById('status')?.textContent?.includes('Second'),
      null,
      { timeout: 10000 },
    );

    const state = await panelState(page);
    check('the panel followed to the new video', state.rows[0]?.text, 'Second video');
    check('with its own line count', state.rows.length, 2);
  }
});
