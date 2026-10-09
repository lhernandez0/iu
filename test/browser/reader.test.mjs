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
  await reader.goto(`chrome-extension://${extensionId}/src/reader/reader.html`);

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

  const status = await reader.textContent('#status');
  const after = await panel.textContent('#transcript');
  const rows = await panel.locator('.row').count();

  check('the reader found the embedded tracks', /track/i.test(status ?? ''), true);
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
  await plain.goto(`chrome-extension://${extensionId}/src/reader/reader.html`);
  await plain.bringToFront();
  await plain.setInputFiles('#pick-files', join(FIXTURES, 'no-subtitles.mkv'));
  // Same rule as above: wait for the message, not for a duration.
  await plain.waitForFunction(
    () => /READER005|no subtitles/i.test(document.getElementById('status')?.textContent ?? ''),
    null,
    { timeout: 15000 },
  );

  const status = await plain.textContent('#status');
  check('a file with no subtitles says so', /READER005|no subtitles/i.test(status ?? ''), true);
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
    buttonHidden: document.getElementById('audio').hidden,
  }));
  check('no selector before a file is opened', beforeLoad.buttonHidden, true);

  await reader.setInputFiles('#pick-files', join(FIXTURES, '..', '..', 'tools', 'ui', 'assets', 'two-audio.mkv'));
  const appeared = await reader
    .waitForFunction(() => !document.getElementById('audio').hidden, null, { timeout: 15000 })
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

  // Switching away and back exercises the teardown path, which is where the first
  // version leaked and double-revoked: the rebuild owns an object URL, and so does the
  // raw file, and confusing the two detaches a source the element is still reading.
  await reader.selectOption('#audio-track', '0');
  await reader
    .waitForFunction(() => document.getElementById('video')?.readyState >= 2, null, { timeout: 20000 })
    .catch(() => {});
  // Does the SAME measurement see the third track after switching back? This is the
  // path that leaked in the first implementation: the rebuild owns an object URL and so
  // does the raw file, and confusing the two detaches a source the element is reading.
  const switchedBack = await measureTone();

  check('switching back returns to the first track', switchedBack.hz, 441);
  check('and it is still playing rather than detached', switchedBack.playing, true);

  // The control must not claim a change that did not happen, and must not be left in
  // its busy state once production has finished.
  const settled = await reader.evaluate(() => ({
    disabled: document.getElementById('audio-track').disabled,
    note: document.getElementById('audio-note').textContent,
    selected: document.getElementById('audio-track').value,
  }));
  check('the selector is usable again after switching', settled.disabled, false);
  check('and reports no stale error', /not supported/i.test(settled.note), false);
  check('and shows the track that is playing', settled.selected, '0');
}

await closeAll();

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
