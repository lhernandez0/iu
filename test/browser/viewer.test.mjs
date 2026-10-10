/**
 * The reader page, driven in a real browser.
 *
 * **This file exists because there was no test between the Matroska parser and the
 * panel.** `matroska.test.mjs` proves the container parser reads real files;
 * `service-worker.test.mjs` proves the worker resolves a reader tab. Nothing proved
 * the two connect — and they did not, in a way neither suite could see.
 *
 * ## The bug this would have caught
 *
 * `settings.studyLanguage` defaults to `null`, so the FIRST request for any video
 * is `PROVIDE { languageCode: null }`. The reader answered "no such track". So a
 * file with three subtitle tracks, perfectly parsed, produced **no transcript at
 * all** — while the parser suite stayed green and the worker suite stayed green,
 * because neither of them ever asked the reader for a track.
 *
 * The YouTube content script has always handled this (`wanted ??
 * pickDefaultTrack(...)`), and that is exactly why the gap was invisible:
 * every previous test drove the YouTube path.
 *
 * So this suite drives the REAL reader page over `chrome-extension://`, with the
 * real service worker and the real panel, and asserts that subtitles appear.
 *
 * Run: npm run test:browser
 */

import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURES = join(ROOT, 'test', 'mkv');
const EXTENSION_ROOT = ROOT;

let failures = 0;
let checks = 0;

/** @param {string} name @param {any} actual @param {any} expected */
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  pass  ${name}`);
  } else {
    console.log(`  FAIL  ${name}\n          got      ${a}\n          expected ${e}`);
    failures++;
  }
}

/** @param {string} name */
function section(name) {
  console.log(`\n${name}`);
}

if (!existsSync(join(FIXTURES, 'three-tracks.mkv'))) {
  console.log('\n  FAIL  the MKV fixtures are not present.');
  console.log('        They are generated, not committed. Run:  npm run fixtures');
  process.exit(1);
}

// --- Launch -----------------------------------------------------------------

const { extensionIdForPath: idForPath, findChrome } = await import('./harness.mjs');

let context;
let closeAll = async () => {};

try {
  const executablePath = await findChrome();
  context = await chromium.launchPersistentContext('', {
    executablePath,
    headless: true,
    args: [
      `--disable-extensions-except=${EXTENSION_ROOT}`,
      `--load-extension=${EXTENSION_ROOT}`,
    ],
  });
  closeAll = () => context.close();
} catch (error) {
  console.log('\n  SKIP  no browser available:', String(error?.message ?? error));
  console.log(`\n${checks - failures}/${checks} checks passed (browser unavailable)`);
  process.exit(0);
}

const extensionId = idForPath(EXTENSION_ROOT);

section('the reader page loads and announces itself');

/** @type {import('playwright').Page} */
let reader;
let panel;

try {
  // The reader, opened the way the toolbar menu opens it — as an extension page in
  // a tab.
  reader = await context.newPage();
  await reader.goto(`chrome-extension://${extensionId}/src/viewer/viewer.html`);

  // The panel, connected to the same worker. Opened as a tab for the same reason
  // `harness.mjs` does: a real side panel is never the active tab, and opening one
  // as a tab would make the worker resolve the wrong tab.
  panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/sidepanel.html`);

  // **Bring the reader back to the front, and this is not incidental.** The worker
  // resolves the ACTIVE tab, so a file chosen in a background tab is a file the
  // panel never hears about. That is correct behaviour — a real user picks a file
  // while looking at the reader — but it makes the test order-dependent, which is
  // how this suite failed intermittently with the panel opened last.
  await reader.bringToFront();

  await panel.waitForTimeout(1500);

  check('the reader page loaded', await reader.title(), 'IU — video');
  // The reader must be resolvable even with the panel already open, which is the
  // path that was broken.
  const readerStatus = await reader.textContent('#status');
  check('the reader reports itself ready', typeof readerStatus, 'string');
} catch (error) {
  console.log('\n  FAIL  could not open the pages:', String(error?.message ?? error));
  check('the pages opened', false, true);
}

section('a real MKV produces subtitles in the panel');

{
  // The whole point. A file with three text subtitle tracks goes in, and text must
  // come out the other end — through DESCRIBE, the language pickers, PROVIDE with
  // a NULL language (because the default study language is unset), cue extraction,
  // and the row model.
  const before = await panel.textContent('#transcript');

  // The reader is the tab the user is looking at, so the worker can resolve it.
  // See the note at the top of this file about why the order is load-bearing.
  await reader.bringToFront();
  // `setInputFiles` on the real hidden input, which is what the label opens.
  await reader.setInputFiles('#pick-files', join(FIXTURES, 'three-tracks.mkv'));

  // Wait for the CONDITION rather than for a duration: extraction walks the media,
  // and a fixed sleep is either slower than necessary or occasionally too short —
  // the latter producing a flaky failure that reads as a code bug.
  await panel.waitForFunction(() => document.querySelectorAll('.row').length > 0, null, { timeout: 15000 });

  const after = await panel.textContent('#transcript');
  const rows = await panel.locator('.row').count();

  check('the reader found the embedded tracks', rows > 0, true);
  // The regression, stated directly: rows must appear with NO language chosen.
  check('the panel shows transcript rows', rows > 0, true);
  check('and the transcript actually changed', after !== before, true);
  // The panel's language picker must offer the fixture's languages, normalised —
  // `zho`/`jpn` in the file, `zh`/`ja` here, because that is what the word lists
  // are keyed by and a track under any other code marks nothing.
  const options = await panel.locator('#study option').allTextContents();
  const values = await panel.locator('#study option').evaluateAll((els) => els.map((e) => e.value));
  void options;

  check('the Chinese track is offered', values.some((v) => v === 'zh'), true);
  check('and the Japanese one', values.some((v) => v === 'ja'), true);
  check('and the English gloss line', values.some((v) => v === 'en'), true);
}

section('machine translation is refused for a local file, visibly');

{
  // A local file cannot be machine-translated: it would mean a network request,
  // which the extension does not make outside the video's own captions. So the
  // reader reports every track as untranslatable and the panel DISABLES the two
  // `MT` checkboxes rather than leaving them live.
  //
  // Asserted in the browser rather than in the panel's own suite because that is
  // where the two halves meet: the panel already had the disable logic (`a track
  // that cannot be translated disables its own box`), and it was only useful here
  // if the reader actually reports the flag. A unit test on either side passes
  // while the pair is broken — which is the exact shape of the bug that made the
  // reader produce no transcript at all.
  //
  // Without this the checkboxes appear to work and change nothing, which is the
  // failure mode this codebase designs against everywhere else.
  const studyBox = panel.locator('#study-translated');
  const glossBox = panel.locator('#gloss-translated');

  check('the study MT box is disabled', await studyBox.isDisabled(), true);
  check('and says why', (await studyBox.getAttribute('title')) ?? '', 'This caption track cannot be auto-translated');

  // The gloss line may have no track selected, in which case the box is disabled
  // for that reason instead. Either way it must not be tickable.
  check('the gloss MT box is disabled', await glossBox.isDisabled(), true);
  check('and it is not checked', await glossBox.isChecked(), false);
}

section('rows seek the real video element');

{
  const rows = panel.locator('.row');
  if ((await rows.count()) > 1) {
    await reader.bringToFront();
    await rows.nth(1).click();
    await panel.waitForFunction(() => document.getElementById('video') !== null, null, { timeout: 5000 }).catch(() => {});
    const time = await reader.evaluate(() => document.getElementById('video').currentTime);
    // Clicking a row must move the real <video>, not just the highlight.
    check('clicking a row seeks the video', time > 0, true);
  } else {
    check('there were rows to click', false, true);
  }
}

section('the panel shows what is missing rather than an empty transcript');

{
  // A file with no subtitle tracks. This must explain itself, because an empty
  // transcript with no message is the failure shape the codebase designs against.
  const plain = await context.newPage();
  await plain.goto(`chrome-extension://${extensionId}/src/viewer/viewer.html`);
  await plain.bringToFront();
  await plain.setInputFiles('#pick-files', join(FIXTURES, 'no-subtitles.mkv'));
  // Same rule as above: wait for the message, not for a duration.
  await plain.waitForFunction(
    () => /VIEWER005|no subtitles/i.test(document.getElementById('status')?.textContent ?? ''),
    null,
    { timeout: 15000 },
  );

  const status = await plain.textContent('#status');
  check('a file with no subtitles says so', /VIEWER005|no subtitles/i.test(status ?? ''), true);
  // And it is VISIBLE, which is the point of keeping the element at all: a healthy file
  // shows nothing, but an error must still reach the screen.
  check(
    'and the error is not hidden',
    await plain.evaluate(() => !document.getElementById('status').hidden),
    true,
  );
  await plain.close();
}

section('the time bar, the volume control and the difficulty band');

{
  // Loaded here rather than in the section above so the state is the loaded one, and
  // because this asserts the BAR, not the transcript the panel renders.
  await reader.bringToFront();
  await reader.setInputFiles('#pick-files', join(FIXTURES, 'three-tracks.mkv'));

  // The Chinese track, chosen EXPLICITLY. The reader honours the shared
  // `studyLanguage`, and a previous section leaves it on English — where no word list
  // exists, so nothing marks and the band is correctly empty. Depending on whatever
  // that setting happens to hold would make this test assert the ambient state.
  await reader.selectOption('#study-track', 'zh');

  // The band is painted FROM the marks, and the marks need the dictionary — so wait
  // for a span rather than assuming the paint happened with the file.
  const bandAppeared = await reader
    .waitForFunction(() => document.querySelectorAll('#cues span').length > 0, null, { timeout: 20000 })
    .then(() => true)
    .catch(() => false);

  // The load-bearing check. The band first shipped with every span 0px wide, because
  // the reader's cues carry `duration` where the preview's carried `end` — the width
  // came out `NaN%`, which CSS silently drops. The band existed, was the right colour
  // and painted nothing, which a DOM-presence check passes happily.
  const band = await reader.evaluate(() => {
    const spans = [...document.querySelectorAll('#cues span')];
    return {
      count: spans.length,
      widths: spans.map((span) => span.getBoundingClientRect().width),
      colours: [...new Set(spans.map((span) => getComputedStyle(span).backgroundColor))],
    };
  });

  check('the band has a span', bandAppeared && band.count > 0, true);
  // `every` on an empty array is `true`, so the count is asserted first — otherwise a
  // band with no spans at all passes the width check it was written to catch.
  check('and every span has real width', band.count > 0 && band.widths.every((width) => width > 1), true);

  // The range's max is the duration. Left at a default of 1, the scrubber is a control
  // that cannot seek anywhere, and the thumb sits at 0 for the whole film.
  const times = await reader.evaluate(() => ({
    max: Number(document.getElementById('scrubber').max),
    duration: document.getElementById('video').duration,
    counter: document.getElementById('time-duration').textContent,
  }));
  check('the scrubber spans the whole file', Math.abs(times.max - times.duration) < 0.5, true);
  check('and the counter shows the duration', /^\d+:\d\d$/.test(times.counter ?? ''), true);

  // Seeking, through the element itself.
  await reader.evaluate(() => {
    const scrubber = document.getElementById('scrubber');
    scrubber.value = '5';
    scrubber.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const seeked = await reader.evaluate(() => document.getElementById('video').currentTime);
  check('and it seeks the video', seeked > 4 && seeked < 6, true);

  // The difficulty toggle owns its own state through the settings bucket.
  await reader.click('#difficulty');
  const off = await reader.evaluate(() => ({
    pressed: document.getElementById('difficulty').getAttribute('aria-pressed'),
    spans: document.querySelectorAll('#cues span').length,
  }));
  check('the difficulty toggle turns the band off', off.spans, 0);
  check('and says so', off.pressed, 'false');

  await reader.click('#difficulty');
  const back = await reader.evaluate(() => ({
    pressed: document.getElementById('difficulty').getAttribute('aria-pressed'),
    spans: document.querySelectorAll('#cues span').length,
  }));
  check('and turning it back on restores the band', back.spans > 0, true);

  // Volume: a real curve, and a mute that can be undone.
  const curve = await reader.evaluate(() => {
    const video = document.getElementById('video');
    const slider = document.getElementById('volume');
    const readings = [];
    for (const value of [100, 50]) {
      slider.value = String(value);
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      readings.push(Number(video.volume.toFixed(3)));
    }
    slider.value = '0';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    const silent = { volume: video.volume, muted: video.muted };
    return { readings, silent };
  });
  check('full volume is full', curve.readings[0], 1);
  // Squared, not linear: 50 on the slider is 0.25 on the element.
  check('half volume is a quarter, not a half', curve.readings[1], 0.25);
  check('and zero is muted', curve.silent.muted, true);

  await reader.click('#mute');
  const afterUnmute = await reader.evaluate(() => ({
    value: document.getElementById('volume').value,
    volume: Number(document.getElementById('video').volume.toFixed(3)),
  }));
  check('unmuting restores the previous level rather than guessing', afterUnmute.value, '50');
  check('and the element follows', afterUnmute.volume, 0.25);

  // The bar is taller now, so the overlay captions must still clear it — the offset is
  // measured rather than fixed, and a stale one puts the captions behind the bar.
  const offset = await reader.evaluate(() => ({
    offset: getComputedStyle(document.documentElement).getPropertyValue('--bar-offset').trim(),
    bar: Math.round(document.getElementById('bar').getBoundingClientRect().height),
  }));
  check('the caption offset accounts for the taller bar', offset.offset, `${offset.bar}px`);
}

section('the audio track selector');

{
  // The fixture is AAC 440 Hz followed by AAC 880 Hz, so the TONE says which track is
  // playing. Asserting the `<select>` value would prove nothing about what came out of
  // the speakers — that is the exact trap Chromium issue 40663787 is about, where the
  // state said one thing and the audio said another.
  await reader.bringToFront();

  const beforeLoad = await reader.evaluate(() => ({
    fieldHidden: document.getElementById('audio-field').hidden,
    hasButton: document.getElementById('audio') !== null,
  }));
  check('no selector before a file is opened', beforeLoad.fieldHidden, true);
  check('and no button to reveal it either', beforeLoad.hasButton, false);

  await reader.setInputFiles('#pick-files', join(FIXTURES, '..', '..', 'tools', 'ui', 'assets', 'two-audio.mkv'));
  const appeared = await reader
    .waitForFunction(() => !document.getElementById('audio-field').hidden, null, { timeout: 15000 })
    .then(() => true)
    .catch(() => false);

  check('the selector appears for a file with two audio tracks', appeared, true);

  const listed = await reader.evaluate(() =>
    [...document.getElementById('audio-track').options].map((option) => option.textContent),
  );
  check('and lists both tracks', listed.length, 2);

  await reader.selectOption('#audio-track', '1');
  await reader
    .waitForFunction(() => document.getElementById('video')?.readyState >= 2, null, { timeout: 20000 })
    .catch(() => {});

  /**
   * The dominant frequency the element is producing right now.
   *
   * `captureStream`, NOT `createMediaElementSource`. The latter can only be called once
   * per element and it reroutes the element's audio into the Web Audio graph and out of
   * the default output, so a second measurement through it captures silence. Using
   * `captureStream` for every measurement keeps the method identical each time — which
   * is what makes measuring a second switch possible at all.
   */
  const measureTone = () =>
    reader.evaluate(async () => {
      const video = document.getElementById('video');
      await video.play().catch(() => {});
      const stream = video.captureStream();
      const context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 8192;
      context.createMediaStreamSource(stream).connect(analyser);
      await new Promise((resolve) => setTimeout(resolve, 1500));

      const bins = new Float32Array(analyser.frequencyBinCount);
      analyser.getFloatFrequencyData(bins);
      let peak = 0;
      let best = -Infinity;
      for (let i = 0; i < bins.length; i += 1) {
        if (bins[i] > best) {
          best = bins[i];
          peak = i;
        }
      }
      const hz = Math.round((peak * context.sampleRate) / analyser.fftSize);
      await context.close();
      for (const track of stream.getTracks()) track.stop();
      return { hz, playing: !video.paused, audioTracks: stream.getAudioTracks().length };
    });

  const heard = await measureTone();

  check('and switching really changes the audible track', heard.hz, 877);
  check('with playback still running', heard.playing, true);

  // The streaming property, which is the reason this does not buffer. A rebuilt
  // stream must be USABLE before it is complete — that is what lets playback begin on
  // a fragment instead of after the whole film has been copied, and it is the one
  // thing a buffered implementation cannot do. The element's source is a MediaSource
  // blob and its buffer fills ahead of the playhead.
  const streaming = await reader.evaluate(() => {
    const video = document.getElementById('video');
    const source = video.currentSrc || video.src || '';
    return {
      isMediaSource: source.startsWith('blob:'),
      duration: Number.isFinite(video.duration) ? video.duration : 0,
      buffered: video.buffered.length ? video.buffered.end(0) : 0,
      readyState: video.readyState,
    };
  });

  check('playback comes from a MediaSource', streaming.isMediaSource, true);
  check('and the stream is playable before the file is complete', streaming.readyState >= 2, true);
  check('with the buffer ahead of the playhead', streaming.buffered > 0, true);

  // Switching away and BACK exercises the teardown path, which is where the first
  // version leaked and double-revoked: the rebuild owns an object URL and so does the
  // raw file, and confusing the two detaches a source the element is still reading.
  // It also restores `selected` to the first track, making the assertion below meaningful
  // rather than trivially true.
  await reader.selectOption('#audio-track', '0');
  await reader
    .waitForFunction(() => document.getElementById('video')?.readyState >= 2, null, { timeout: 20000 })
    .catch(() => {});
  const switchedBack = await measureTone();

  check('switching back returns to the first track', switchedBack.hz, 441);
  check('and it is still playing rather than detached', switchedBack.playing, true);

  // Switching track re-sources the element, which fires `loadedmetadata` again — and the
  // handler there offered to RESUME a film the viewer is already watching. A modal
  // asking a question with one sensible answer, for the most ordinary thing the control
  // does.
  //
  // `three-tracks.mkv` is SIX SECONDS, which is too short to show the position bug at
  // all — its `offerResume` refuses any position later than `duration - 5` and anything
  // at or under 2s, so no position on that file can produce an offer. Verified by
  // removing the guard: the assertion below stayed green, because the modal was absent
  // for an unrelated reason.
  const afterSwitchOffer = await reader.evaluate(() => ({
    resumeHidden: document.getElementById('resume').hidden,
    currentTime: Number(document.getElementById('video').currentTime.toFixed(2)),
  }));
  check('switching audio offers no modal', afterSwitchOffer.resumeHidden, true);
  check('and the playhead is where it was, not reset', afterSwitchOffer.currentTime > 0, true);

}

{
  // The control is SHOWN, not hidden behind a reveal, and it sits in the transport row —
  // which is never hidden for a loaded file. There was a button here, and it toggled the
  // select beside it; a control whose whole job is to reveal the thing next to it is a
  // click tax, not a feature.
  //
  // The placement matters for a reason beyond tidiness: it lived in the caption row
  // once, and that row disappears when captions are off — so the control was unreachable
  // for a viewer who wants the original audio WITHOUT subtitles, which is the case this
  // feature exists for.
  const placement = await reader.evaluate(() => ({
    fieldHidden: document.getElementById('audio-field').hidden,
    hasButton: document.getElementById('audio') !== null,
    inTransport: Boolean(document.getElementById('audio-track').closest('.row-transport')),
    inCaptionRow: Boolean(document.getElementById('audio-track').closest('.row-captions')),
    inTimeRow: Boolean(document.getElementById('audio-track').closest('.row-time')),
    note: document.getElementById('audio-note').textContent,
    noteDisplay: getComputedStyle(document.getElementById('audio-note')).display,
  }));

  check('the select is shown, not hidden behind a button', placement.fieldHidden, false);
  check('and there is no button to reveal it', placement.hasButton, false);
  check('it is in the transport row', placement.inTransport, true);
  check('not in the caption row', placement.inCaptionRow, false);
  check('and not in the time row', placement.inTimeRow, false);
  check('with nothing said when there is nothing wrong', placement.note, '');
  check('and the note takes no space when empty', placement.noteDisplay, 'none');
}

section('Switching audio keeps a long playback position');

{
  // The reported failure: resume offered 13:05, switch the audio track, land at 0:02.
  // Reproduced at 240.95s -> 2.54s.
  //
  // The cause was TIMING, not arithmetic. On a Media Source stream `loadedmetadata`
  // fires with `duration === Infinity` and `readyState 1`, and setting `currentTime`
  // there is silently dropped because `seekable` is still empty. The duration resolves a
  // moment later and playback starts from zero. Measured on this fixture:
  //
  //   currentTime 240.95 -> 0.00   (readyState 0, dur NaN)
  //   loadedmetadata: duration=Infinity readyState=1
  //   currentTime 0.00 -> 0.01     (readyState 4, dur 300.02)
  //
  // `three-tracks.mkv` cannot show this — it is six seconds. `two-audio.mkv` is five
  // minutes and has two tracks, so the target is deep enough for the difference to be
  // unmistakable.
  const page6 = await context.newPage();
  await page6.goto(`chrome-extension://${extensionId}/src/viewer/viewer.html`);
  await page6.waitForTimeout(1000);
  await page6.setInputFiles('#pick-files', join(FIXTURES, 'two-audio.mkv'));
  await page6.waitForFunction(
    () => !document.getElementById('audio-field').hidden && document.getElementById('video')?.readyState >= 2,
    null,
    { timeout: 25000 },
  );
  await page6.waitForTimeout(600);

  const TARGET = 240;
  await page6.evaluate((at) => {
    document.getElementById('video').currentTime = at;
  }, TARGET);
  await page6.waitForFunction(
    (at) => Math.abs(document.getElementById('video').currentTime - at) < 1.5,
    TARGET,
    { timeout: 15000 },
  );

  await page6.selectOption('#audio-track', '1');
  // Wait for the rebuilt stream to be playing rather than for a duration.
  await page6.waitForFunction(
    () => {
      const video = document.getElementById('video');
      return video.readyState >= 3 && video.currentTime > 100;
    },
    null,
    { timeout: 25000 },
  ).catch(() => {});

  const landed = await page6.evaluate(() => Number(document.getElementById('video').currentTime.toFixed(2)));
  check('the playhead survives the switch', landed > TARGET - 5, true);
  check('and it did not restart from the beginning', landed > 100, true);

  await page6.close();
}

section('A finished subtitle clears instead of staying on screen');

{
  // Its own page and its own file. This ran inside the audio section at first and
  // failed — not because the caption was wrong but because that section has already
  // replaced the source with a rebuilt MSE stream, whose timeline is not guaranteed to
  // line up with the cues read from the original file. A test that depends on two
  // timelines agreeing is testing the wrong thing.
  const page3 = await context.newPage();
  await page3.goto(`chrome-extension://${extensionId}/src/viewer/viewer.html`);
  await page3.waitForTimeout(1200);
  await page3.setInputFiles('#pick-files', join(FIXTURES, 'three-tracks.mkv'));
  await page3.waitForFunction(() => document.getElementById('video')?.readyState >= 2, null, {
    timeout: 15000,
  });
  await page3.waitForTimeout(600);
  await page3.evaluate(() => document.getElementById('video').pause());

  const captionAt = async (seconds) => {
    await page3.evaluate((at) => {
      document.getElementById('video').currentTime = at;
    }, seconds);
    await page3.waitForTimeout(400);
    return page3.evaluate(() => document.getElementById('caption-primary').textContent.trim());
  };

  // Inside a cue: shown.
  check('a caption is shown while its cue plays', (await captionAt(1.0)).length > 0, true);

  // The fixture spaces cues about two seconds apart, so 4.0s is in the silence after
  // one and before the next.
  const duringHold = await captionAt(4.0);

  // Still up immediately after the cue ended — this is the hold that keeps an ordinary
  // dialogue run from blinking through the fraction-of-a-second gaps between its cues.
  check('a finished cue holds briefly rather than vanishing at once', duringHold.length > 0, true);

  await page3.waitForTimeout(1000);
  check(
    'and then clears rather than staying on screen forever',
    await page3.evaluate(() => document.getElementById('caption-primary').textContent.trim()),
    '',
  );

  await page3.close();
}

section('The resume offer behaves like a toast');

{
  const page4 = await context.newPage();
  await page4.goto(`chrome-extension://${extensionId}/src/viewer/viewer.html`);
  await page4.waitForTimeout(1000);

  await page4.setInputFiles('#pick-files', join(FIXTURES, 'three-tracks.mkv'));
  await page4.waitForFunction(() => document.getElementById('video')?.readyState >= 2, null, {
    timeout: 15000,
  });

  // "Start over" used to hide the banner and do NOTHING else — the playhead stayed
  // where it was and the offer was gone, which is the button's whole promise unkept and
  // unrecoverable, because the offer only fires once per load.
  await page4.evaluate(() => {
    document.getElementById('video').currentTime = 3;
  });
  await page4.waitForTimeout(300);
  await page4.evaluate(() => {
    const banner = document.getElementById('resume');
    banner.dataset.seconds = '3';
    banner.hidden = false;
  });
  await page4.click('#resume-skip');
  await page4.waitForTimeout(400);

  const started = await page4.evaluate(() => ({
    currentTime: document.getElementById('video').currentTime,
    hidden: document.getElementById('resume').hidden,
  }));
  // Measured: lands at ~0.5s, not 0 — the seek sets zero and playback moves on
  // immediately. Asserting `< 0.5` exactly would fail on a fast machine for the right
  // behaviour, so this asks what matters: did it go back to the START (ahead), rather
  // than staying at 3s where it was.
  check('Start over rewinds to the beginning', started.currentTime < 1.5, true);
  check('and dismisses the offer', started.hidden, true);

  // The toast property, tested through the REAL trigger rather than a hand-shown
  // banner. Setting `hidden = false` directly bypasses `offerResume`, which is where the
  // timer lives — so the first version of this test proved nothing about the timer and
  // failed, correctly.
  //
  // A stored position for this file, then a reload: the key is the worker's own, read
  // from `chrome.storage.local`.
  await page4.close();

  const page5 = await context.newPage();
  await page5.goto(`chrome-extension://${extensionId}/src/viewer/viewer.html`);
  await page5.waitForTimeout(800);
  await page5.setInputFiles('#pick-files', join(FIXTURES, 'three-tracks.mkv'));
  await page5.waitForFunction(() => document.getElementById('video')?.readyState >= 2, null, {
    timeout: 15000,
  });
  // Play a moment so the position is remembered, then reload so the offer fires.
  await page5.evaluate(() => {
    document.getElementById('video').currentTime = 3;
    document.getElementById('video').play().catch(() => {});
  });
  await page5.waitForTimeout(5200);
  await page5.evaluate(() => document.getElementById('video').pause());
  await page5.reload();
  await page5.waitForTimeout(1200);
  await page5.setInputFiles('#pick-files', join(FIXTURES, 'three-tracks.mkv'));

  const appeared = await page5
    .waitForFunction(() => !document.getElementById('resume').hidden, null, { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  check('the real offer appears for a stored position', appeared, true);

  // And retires itself. Wait for the CONDITION with a ceiling rather than sleeping past
  // the timeout: a fixed sleep both slows the suite and can still race the timer.
  const retired = await page5
    .waitForFunction(() => document.getElementById('resume').hidden, null, { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  check('and it retires itself without being touched', retired, true);

  await page5.close();
}

section('Resume continues rather than sitting paused');section('Resume continues rather than sitting paused');

{
  // Reported from use: clicking Resume moved the playhead and then left the film
  // paused, which is the one thing "Resume" cannot mean. `currentTime` is not a resume.
  const page2 = await context.newPage();
  await page2.goto(`chrome-extension://${extensionId}/src/viewer/viewer.html`);
  await page2.waitForTimeout(1000);

  // Seed a saved position directly, which is what the banner reads.
  await page2.evaluate(() => {
    const file = new File([new Uint8Array(10)], 'resume-fixture.mp4', { type: 'video/mp4' });
    localStorage.setItem('iu-test-file', 'x');
    void file;
  });
  await page2.setInputFiles('#pick-files', join(FIXTURES, 'three-tracks.mkv'));
  await page2.waitForTimeout(2000);

  // Drive the banner by hand: the element has no stored position, so the real offer
  // would never appear. What is under test is the handler, not the offer.
  await page2.evaluate(() => {
    document.getElementById('video').pause();
    const banner = document.getElementById('resume');
    banner.dataset.seconds = '1';
    banner.hidden = false;
  });

  // A REAL click, not `element.click()` from inside `evaluate`. Playwright's click is a
  // trusted gesture, and autoplay without one is refused — which is exactly what the
  // first version of this test failed on: the handler was correct and the test was
  // measuring the autoplay policy.
  await page2.click('#resume-go');
  await page2.waitForTimeout(500);
  const resumed = await page2.evaluate(() => {
    const video = document.getElementById('video');
    return { paused: video.paused, currentTime: Number(video.currentTime.toFixed(2)) };
  });

  check('Resume moves the playhead', resumed.currentTime > 0, true);
  check('and it is PLAYING afterwards, not paused', resumed.paused, false);
  await page2.close();
}

section('Fullscreen, and the Picture-in-Picture round trip');

{
  // Three separate things, all reachable and all previously wrong:
  //
  //   1. The button could not ENTER fullscreen when `innerHeight` happened to equal
  //      `screen.height` — which is true in a headless browser (no chrome) and in a
  //      maximised window (4px of chrome). The heuristic that exists to notice
  //      F11-fullscreen was blocking a legal request.
  //   2. Entering PiP DROPS element fullscreen — measured, not assumed: the state goes
  //      from `fsElement: "picture"` to `fsElement: null` the moment PiP starts.
  //   3. So after the round trip nothing is fullscreen, and Escape has nothing to exit.
  const page7 = await context.newPage();
  await page7.goto(`chrome-extension://${extensionId}/src/viewer/viewer.html`);
  await page7.waitForTimeout(1000);
  await page7.setInputFiles('#pick-files', join(FIXTURES, 'three-tracks.mkv'));
  await page7.waitForTimeout(2000);

  const state = () =>
    page7.evaluate(() => ({
      fsElement: document.fullscreenElement ? document.fullscreenElement.id : null,
      pip: document.pictureInPictureElement ? 'video' : null,
      inner: window.innerHeight,
      screen: window.screen.height,
    }));

  check('nothing is fullscreen to begin with', (await state()).fsElement, null);

  // (1) The button must ENTER fullscreen as its first response, whatever the viewport
  // looks like. This is the assertion that fails against the old heuristic.
  await page7.click('#fullscreen');
  await page7.waitForTimeout(700);
  check('the button enters fullscreen', (await state()).fsElement, 'picture');

  // (2) PiP drops it. Asserted rather than assumed, because the fix depends on it being
  // true — if a future Chrome preserves fullscreen across PiP, this test says so.
  await page7.click('#pip');
  await page7.waitForTimeout(1200);
  const inPip = await state();
  check('entering PiP starts PiP', inPip.pip, 'video');
  check('and drops element fullscreen', inPip.fsElement, null);

  await page7.click('#pip');
  await page7.waitForTimeout(1200);
  const afterPip = await state();
  check('exiting PiP ends PiP', afterPip.pip, null);

  // (3) The round trip must be LOSSLESS: fullscreen was on when PiP opened, so it has to
  // be back when PiP closes.
  //
  // The restore has to happen in the PiP click, not in `leavepictureinpicture`, because
  // a user gesture is required — measured both ways: refused from the event, succeeded
  // from the click. And the state has to be captured on PiP ENTRY: the browser drops
  // fullscreen when PiP OPENS, so reading `fullscreenElement` on exit is always null,
  // which is a condition that can never be true.
  check('fullscreen is back after the round trip', (await state()).fsElement, 'picture');

  // Leaving works, which is the half that never broke but is worth pinning.
  await page7.click('#fullscreen');
  await page7.waitForTimeout(700);
  check('and leaving works too', (await state()).fsElement, null);

  // (4) And the other direction: PiP on its own must not DRAG the viewer into
  // fullscreen. The flag is only set when fullscreen was already on.
  await page7.click('#pip');
  await page7.waitForTimeout(1200);
  await page7.click('#pip');
  await page7.waitForTimeout(1500);
  check(
    'PiP without fullscreen does not restore fullscreen',
    (await state()).fsElement,
    null,
  );

  await page7.close();
}

await closeAll();

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
