/**
 * Browser integration tests — LIVE. Hits the real youtube.com.
 *
 * Do not expect to run this often, or ever by accident. It is gated behind an
 * environment variable so it cannot be triggered by any default command:
 *
 *   npm run test:browser:live
 *
 * What it is for: the offline tier proves the extension works against a page
 * whose shape we wrote down, which means it cannot notice YouTube changing
 * that shape. This is the only test that reads the real page, so it is the only
 * one that can catch the player response moving, the caption track list being
 * reshaped, or the cookie-authenticated caption fetch being refused.
 *
 * Expect it to be unreliable by nature. Headless Chromium on a datacenter IP
 * is often served a consent wall or a bot check instead of a video page, and
 * YouTube's markup changes without notice. A failure here is a signal to look,
 * not a broken build. It reports what it actually saw so the output is worth
 * reading even when it fails.
 */

import { openWatchPage, openPanel, waitForStatus, panelState } from './harness.mjs';
import { runBrowserSuite } from './runner.mjs';

/**
 * A stable public video that has captions. Override with IU_LIVE_VIDEO
 * if it ever stops working.
 */
const VIDEO_ID = process.env.IU_LIVE_VIDEO ?? 'dQw4w9WgXcQ';

// Nothing is routed here: the whole point is the real site.
await runBrowserSuite(async ({ context, extensionId }, report) => {
  const { check, section } = report;

  console.log(`\n  using real youtube.com, video ${VIDEO_ID}`);

  section('the real YouTube page exposes a video the extension can find');

  const watch = await openWatchPage(context, VIDEO_ID);
  // Give the site time to boot its own scripts, which is what sets the player
  // response the bridge reads.
  await watch.waitForTimeout(4000);

  // Report what actually came down, so a failure here is diagnosable rather
  // than just a red mark.
  const pageProbe = await watch.evaluate(() => ({
    title: document.title,
    hasPlayerResponse: Boolean(window.ytInitialPlayerResponse),
    videoId: window.ytInitialPlayerResponse?.videoDetails?.videoId ?? null,
    trackCount:
      window.ytInitialPlayerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks?.length ?? 0,
    hasVideo: Boolean(document.querySelector('video')),
    bodyLooksLikeConsent: /consent|before you continue|not a bot/i.test(document.body?.innerText?.slice(0, 500) ?? ''),
  }));

  console.log(`  page: ${pageProbe.title}`);
  console.log(`  player response present: ${pageProbe.hasPlayerResponse}`);
  console.log(`  caption tracks found: ${pageProbe.trackCount}`);

  if (pageProbe.bodyLooksLikeConsent) {
    console.log('\n  The page is a consent or bot-check screen, not a video. Nothing to assert.');
    console.log('  This is common for headless Chrome and does not indicate a bug.');
    return;
  }

  check('a player response was served', pageProbe.hasPlayerResponse, true);
  check('with the requested video', pageProbe.videoId, VIDEO_ID);
  check('and a <video> element', pageProbe.hasVideo, true);

  if (pageProbe.trackCount === 0) {
    console.log('\n  No caption tracks on this video. Try IU_LIVE_VIDEO=<another id>.');
    return;
  }

  section('the extension reads that page for real');

  const { page, errors } = await openPanel(context, extensionId, watch);
  const status = await waitForStatus(page, 30000);
  const state = await panelState(page);

  console.log(`  panel status: ${status}`);

  check('the panel resolved the real video', status.includes(pageProbe.title.slice(0, 12)), true);
  check('it found the caption tracks', state.options.length > 0, true);
  check('and rendered transcript lines', state.rows.length > 0, true);

  // The one thing the offline tier cannot check: that YouTube still serves a
  // same-origin caption fetch to a real session, rather than requiring the
  // INNERTUBE fallback.
  check('no caption error was reported', state.isError, false);
  check('no console errors', errors.filter((e) => e.includes('pageerror')), []);

  if (state.rows.length > 0) {
    section('seeking works against the real player');

    await page.locator('.row').nth(1).click();
    await page.waitForTimeout(1500);
    const moved = await watch.evaluate(() => document.querySelector('video')?.currentTime ?? 0);
    check('the real video seeked forward', moved > 0, true);
    console.log(`  video currentTime after seeking to line 2: ${moved.toFixed(2)}s`);
  }
});
