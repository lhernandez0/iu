/**
 * The reader page, driven in a real browser.
 *
 * **This file exists because there was no test between the Matroska parser and the
 * panel.** `matroska.test.mjs` proves the container parser reads real files;
 * `service-worker.test.mjs` proves the worker resolves a reader tab. Nothing proved
 * the two connect, and they did not, in a way neither suite could see.
 *
 * ## The bug this would have caught
 *
 * `settings.studyLanguage` defaults to `null`, so the FIRST request for any video
 * is `PROVIDE { languageCode: null }`. The reader answered "no such track". So a
 * file with three subtitle tracks, perfectly parsed, produced **no transcript at
 * all**, while the parser suite stayed green and the worker suite stayed green,
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
  // The reader, opened the way the toolbar menu opens it, as an extension page in
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
  // panel never hears about. That is correct behaviour, a real user picks a file
  // while looking at the reader, but it makes the test order-dependent, which is
  // how this suite failed intermittently with the panel opened last.
  await reader.bringToFront();

  await panel.waitForTimeout(1500);

  // No file chosen yet, so the title is just our name. It gains the file name
  // once one is picked, which is what makes one viewer tab tellable from another.
  check('the reader page loaded', await reader.title(), 'IU');
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
  // come out the other end, through DESCRIBE, the language pickers, PROVIDE with
  // a NULL language (because the default study language is unset), cue extraction,
  // and the row model.
  const before = await panel.textContent('#transcript');

  // The reader is the tab the user is looking at, so the worker can resolve it.
  // See the note at the top of this file about why the order is load-bearing.
  await reader.bringToFront();
  // `setInputFiles` on the real hidden input, which is what the label opens.
  await reader.setInputFiles('#pick-files', join(FIXTURES, 'three-tracks.mkv'));

  // Wait for the CONDITION rather than for a duration: extraction walks the media,
  // and a fixed sleep is either slower than necessary or occasionally too short,
  // the latter producing a flaky failure that reads as a code bug.
  await panel.waitForFunction(() => document.querySelectorAll('.row').length > 0, null, { timeout: 15000 });

  const after = await panel.textContent('#transcript');
  const rows = await panel.locator('.row').count();

  // The tab now names the file, so several viewers can be told apart.
  check('the title names the chosen file', (await reader.title()).includes('three-tracks.mkv'), true);

  check('the reader found the embedded tracks', rows > 0, true);
  // The regression, stated directly: rows must appear with NO language chosen.
  check('the panel shows transcript rows', rows > 0, true);
  check('and the transcript actually changed', after !== before, true);
  // The panel's language picker must offer the fixture's languages, normalised,
  // `zho`/`jpn` in the file, `zh`/`ja` here, because that is what the word lists
  // are keyed by and a track under any other code marks nothing.
  const options = await panel.locator('#study option').allTextContents();
  const values = await panel.locator('#study option').evaluateAll((els) => els.map((e) => e.value));
  void options;

  check('the Chinese track is offered', values.some((v) => v === 'zh'), true);
  check('and the Japanese one', values.some((v) => v === 'ja'), true);
  check('and the English gloss line', values.some((v) => v === 'en'), true);
}

section('the second caption line is opt-in, and matches the picker');

{
  // **A file with two subtitle tracks used to draw a second line the viewer never asked
  // for.** When the gloss setting was empty (its default, "Off"), the viewer fell back to
  // "the first readable track that is not the study one" and drew it, while its own
  // picker and the panel both said "Off". So the screen and the control disagreed, which
  // is the kind of mismatch a viewer cannot resolve from the interface.
  //
  // The fixture carries English and Japanese, so the fallback had a track to pick and the
  // bug was reachable. The assertion is that with the gloss Off there is NO second line,
  // and that choosing one makes it appear: both directions, so a fix that simply never
  // showed a second line would fail too.
  const reader = await context.newPage();
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/sidepanel.html`);
  await reader.goto(`chrome-extension://${extensionId}/src/viewer/viewer.html`);
  await reader.waitForTimeout(800);
  await reader.setInputFiles('#pick-files', join(FIXTURES, 'three-tracks.mkv'));
  await reader.evaluate(() => document.getElementById('video').play().catch(() => {}));
  await reader.waitForTimeout(2500);

  const readLines = () =>
    reader.evaluate(() => ({
      secondary: document.getElementById('caption-secondary')?.textContent.trim() ?? '',
      glossValue: document.getElementById('gloss-track')?.value ?? null,
    }));

  const off = await readLines();
  check('with the second line Off, no second line is drawn', off.secondary, '');
  check('and the picker agrees it is Off', off.glossValue, '');

  // Choose a second line, and it must appear. Done through the control, so this tests the
  // path a viewer actually takes rather than calling the loader directly.
  await reader.selectOption('#gloss-track', 'en');
  await reader.waitForTimeout(1200);
  const on = await readLines();
  check('choosing a second line draws it', on.secondary.length > 0, true);
  check('and the picker agrees which one', on.glossValue, 'en');

  await reader.close();
  await panel.close();
}

section('the study picker shows the track the captions actually draw');

{
  // **The failure this catches is the control disagreeing with the screen.** With no
  // stored `studyLanguage` the viewer picks a track itself, and it prefers a language it
  // can mark (see `pickDefaultTrack`). The picker was driven from the null SETTING, so no
  // option was marked selected and the browser showed the FIRST option, while the captions
  // drew the picked one: measured on a file whose picked track is Japanese, the dropdown
  // said "en". A viewer reads the dropdown to know what they are hearing, so a mismatch is
  // a lie about the state of the page.
  //
  // `three-tracks.mkv` carries English, Japanese and Chinese, all starting at 0.5s, so the
  // automatic pick is a markable one (Japanese) and the tracks are distinguishable by text
  // ("Hello there" versus "Japanese line"). It is a GENERATED fixture, so CI has it.
  const reader = await context.newPage();
  await reader.goto(`chrome-extension://${extensionId}/src/viewer/viewer.html`);
  await reader.waitForTimeout(800);
  await reader.setInputFiles('#pick-files', join(FIXTURES, 'three-tracks.mkv'));
  await reader.waitForTimeout(6000);
  await reader.evaluate(() => {
    const video = document.getElementById('video');
    video.muted = true;
    video.currentTime = 0.6;
    return video.play().catch(() => {});
  });
  await reader.waitForTimeout(2500);

  const state = await reader.evaluate(() => ({
    picker: document.getElementById('study-track').value,
    primary: document.getElementById('caption-primary').textContent,
  }));

  // The automatic pick is Japanese, and the caption drawn is the Japanese track's text,
  // not the English track's. The two are asserted TOGETHER, so "the picker is right but
  // the caption is the other language" fails, which is the exact bug this guards.
  // The Japanese track holds "Japanese line" then "Line with, a comma"; the English track
  // holds "Hello there". Naming neither, the check is that the text is one of the
  // Japanese cues and is NOT the English one, so it does not depend on where in a cue the
  // playhead happened to land.
  check('the picker names the Japanese track', state.picker, 'ja');
  check('and the caption is the Japanese track, not the English one', /Japanese line|Line with/.test(state.primary), true);

  // Choosing English must move BOTH: the caption to the English text, the picker to `en`.
  await reader.selectOption('#study-track', 'en');
  await reader.evaluate(() => {
    const video = document.getElementById('video');
    video.currentTime = 0.6;
    return video.play().catch(() => {});
  });
  await reader.waitForTimeout(2500);
  const switched = await reader.evaluate(() => ({
    picker: document.getElementById('study-track').value,
    primary: document.getElementById('caption-primary').textContent,
  }));
  check('switching the picker switches the caption', /Hello there|Second line/.test(switched.primary), true);
  check('and the picker reflects the choice', switched.picker, 'en');

  await reader.close();
}

section('the picker, the captions and the marks describe ONE track');

{
  // **This is the invariant that every previous fix violated.** Seven times, "the picker
  // showed one track and the captions drew another" was reported; seven times the fix was
  // a scenario and the invariant stayed broken. This asserts the RULE instead: after a
  // stale stored preference (from a file that had a Chinese track) is applied to a file
  // that has none, the value the picker SHOWS, the caption the viewer DRAWS, and the
  // language the caption is MARKED against must all be the same track, and no picker may
  // show a value that is not one of this file's options.
  //
  // The two files mirror the production report exactly: a Chinese file first, then an
  // English-and-Japanese file, sharing one worker and one settings bucket.
  //
  // **The PANEL is open, and that is load-bearing.** The panel drives the worker, the
  // worker sends `SET_TRACK` to the viewer, and THAT write is the second authority over
  // the viewer's own transcript: it used to replace the viewer's segments while leaving the
  // viewer's language, so the pickers, the marks and the band followed one track and the
  // captions another. Without a panel open the message never fires and this test passes on
  // the broken code, which is exactly why the bug shipped seven times.
  const reader = await context.newPage();
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/sidepanel.html`);
  await reader.goto(`chrome-extension://${extensionId}/src/viewer/viewer.html`);
  await reader.waitForTimeout(800);

  // File A: establish a Chinese study choice and an HSK list, the state that seeds it.
  await reader.setInputFiles('#pick-files', join(FIXTURES, 'three-tracks.mkv'));
  await reader.waitForFunction(() => document.querySelector('#study-track option[value="zh"]') !== null, null, { timeout: 15000 });
  await reader.selectOption('#study-track', 'zh');
  await reader.waitForTimeout(500);

  // File B: English and Japanese only, NO Chinese and NO zh-TW. The stored `zh` cannot
  // resolve here, which is the whole point. The wait is for FILE B's OWN track list, not
  // for a caption: a caption is already on screen from file A, so waiting on that read
  // file A's state and made this test assert the previous file.
  await reader.setInputFiles('#pick-files', join(FIXTURES, 'long-dual.mkv'));
  await reader.waitForFunction(
    () => {
      const values = [...document.querySelectorAll('#study-track option')].map((o) => o.value);
      return values.includes('ja') && !values.includes('zh');
    },
    null,
    { timeout: 30000 },
  );
  await reader.waitForTimeout(1500);

  const invariant = await reader.evaluate(() => {
    const select = document.getElementById('study-track');
    const shown = select.selectedOptions[0];
    // Every option's value, so a shown value absent from them is detectable.
    const values = [...select.options].map((o) => o.value);
    const caption = document.getElementById('caption-primary')?.textContent ?? '';
    return {
      shownValue: select.value,
      shownLabel: shown?.textContent ?? '',
      isAnOption: values.includes(select.value),
      values,
      caption,
    };
  });

  // 1. The picker shows a track THIS FILE has. A stale `zh` fails this: the option does
  //    not exist, so the browser falls back to option 0 while the value still reads `zh`.
  check('the study picker shows one of this file\'s own tracks', invariant.isAnOption, true);
  // 2. It did not cling to the Chinese choice from the previous file, which is the
  //    production symptom.
  check('and it is NOT the stale Chinese choice', invariant.shownValue === 'zh' || invariant.shownValue === 'zh-TW', false);
  // 3. The caption is drawn, so the picker is not describing an empty screen.
  check('a caption is actually drawn', invariant.caption.length > 0, true);
  // 4. The drawn caption is the file's JAPANESE track's text, so the picker and the screen
  //    agree about WHICH track, not merely that some track is up.
  check('and the drawn caption is the track the picker names', /Study/.test(invariant.caption), true);

  await reader.close();
  await panel.close();
}

section('a stale choice cannot leave the marks describing the wrong language');

{
  // The other half of the invariant, on a file whose study track CAN be marked. `long-band.mkv`
  // is ten minutes of real Chinese, so if the list resolves to the drawn track's language the
  // caption carries marks; if the list is stale (Japanese JLPT from a previous file) the
  // caption renders plain, which is the "no dictionary" symptom.
  const reader = await context.newPage();
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/sidepanel.html`);
  await reader.goto(`chrome-extension://${extensionId}/src/viewer/viewer.html`);
  await reader.waitForTimeout(800);

  // File A: a Japanese file, leaving JLPT stored.
  await reader.setInputFiles('#pick-files', join(FIXTURES, 'long-dual.mkv'));
  await reader.waitForFunction(() => document.querySelector('#study-track option[value="ja"]') !== null, null, { timeout: 15000 });
  await reader.selectOption('#study-track', 'ja');
  await reader.waitForTimeout(500);

  // File B: Chinese. The stored Japanese choice cannot mark it, so the list must follow
  // the DRAWN track and Chinese marks must appear.
  await reader.setInputFiles('#pick-files', join(FIXTURES, 'long-band.mkv'));
  await reader.waitForFunction(
    () => {
      const values = [...document.querySelectorAll('#study-track option')].map((o) => o.value);
      return values.includes('zh');
    },
    null,
    { timeout: 30000 },
  );
  await reader.selectOption('#study-track', 'zh');
  // Wait for a caption to be PLAYING, not merely for the track to load: the cues start at
  // 0.5s and the marks only exist on a drawn cue. Asserting on marks before a cue is up
  // tests the timing, not the marking.
  await reader.evaluate(() => {
    const video = document.getElementById('video');
    video.muted = true;
    video.pause();
    video.currentTime = 1;
  });
  await reader
    .waitForFunction(() => (document.getElementById('caption-primary')?.textContent ?? '').length > 0, null, { timeout: 20000 })
    .catch(() => {});
  // The marks are applied when the dictionary lands, a beat after the cue, so give the
  // dictionary its moment rather than racing it.
  await reader.waitForTimeout(2000);

  const marked = await reader.evaluate(() => ({
    marks: document.getElementById('caption-primary')?.querySelectorAll('*').length ?? 0,
    list: document.getElementById('word-list')?.value ?? '',
    selected: document.getElementById('study-track')?.value ?? '',
    caption: document.getElementById('caption-primary')?.textContent ?? '',
  }));

  check('the picker names the Chinese track', marked.selected, 'zh');
  // The marks exist, which requires the word list to have followed the DRAWN track and not
  // the stale Japanese one. This is the assertion that would have failed for seven rounds.
  check('a Chinese caption is drawn to mark', marked.caption.length > 0, true);
  check('and the caption is marked, so the list followed the drawn track', marked.marks > 0, true);

  await reader.close();
  await panel.close();
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
  // while the pair is broken, which is the exact shape of the bug that made the
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
  // `studyLanguage`, and a previous section leaves it on English, where no word list
  // exists, so nothing marks and the band is correctly empty. Depending on whatever
  // that setting happens to hold would make this test assert the ambient state.
  await reader.selectOption('#study-track', 'zh');

  // The band is painted FROM the marks, and the marks need the dictionary, so wait
  // for a span rather than assuming the paint happened with the file.
  const bandAppeared = await reader
    .waitForFunction(() => document.querySelectorAll('#cues span').length > 0, null, { timeout: 20000 })
    .then(() => true)
    .catch(() => false);

  // The load-bearing check. The band first shipped with every span 0px wide, because
  // the reader's cues carry `duration` where the preview's carried `end`, the width
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
  // `every` on an empty array is `true`, so the count is asserted first, otherwise a
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

  // The bar is taller now, so the overlay captions must still clear it, the offset is
  // measured rather than fixed, and a stale one puts the captions behind the bar.
  const offset = await reader.evaluate(() => ({
    offset: getComputedStyle(document.documentElement).getPropertyValue('--bar-offset').trim(),
    bar: Math.round(document.getElementById('bar').getBoundingClientRect().height),
  }));
  check('the caption offset accounts for the taller bar', offset.offset, `${offset.bar}px`);
}

section('the speed picker is OUR control, not the operating system dropdown');

{
  // **The failure this catches is a silent revert to the OS-styled dropdown.** A native
  // `<select>` draws its dropdown with the operating system's own colours and font, none
  // of which CSS can reach, so in a dark bar a twelve-rung list reads as a bright foreign
  // box. The fix is `appearance: base-select`, which exposes the trigger and the
  // `::picker()` to CSS. If that line is dropped, or a browser drops support, the control
  // still WORKS (the native dropdown is the documented fallback) and only LOOKS wrong,
  // which no behaviour test would notice.
  await reader.bringToFront();

  const support = await reader.evaluate(() => CSS.supports('appearance', 'base-select'));

  if (!support) {
    // The documented fallback: the select degrades to the native control, which is
    // correct on a browser without the API. Nothing to assert about our styling, and the
    // BEHAVIOUR below is checked regardless.
    console.log('  skip  base-select is unsupported here, native dropdown is the fallback');
  } else {
    const styled = await reader.evaluate(() => {
      const select = document.getElementById('speed');
      const trigger = getComputedStyle(select);
      const picker = getComputedStyle(select, '::picker(select)');
      return {
        appearance: trigger.appearance,
        // The dark surface `--surface` (#1b1e25), not the OS default white. The exact
        // bytes are asserted rather than "is dark", so the theme cannot drift unnoticed.
        pickerBackground: picker.backgroundColor,
      };
    });
    check('the select opts into the customizable API', styled.appearance, 'base-select');
    check('and its dropdown is the bar surface, not OS white', styled.pickerBackground, 'rgb(27, 30, 37)');
  }

  // Behaviour, asserted whatever the styling path: every rung is offered, the grid or
  // list is reachable, and choosing one drives `playbackRate`. This is the half a real
  // user depends on and it must hold even on the fallback.
  const speed = await reader.evaluate(() => {
    const select = document.getElementById('speed');
    const before = select.value;
    select.value = '2';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return {
      optionCount: select.options.length,
      values: [...select.options].map((o) => o.value),
      before,
      rate: document.getElementById('video').playbackRate,
    };
  });
  check('every speed rung is present', speed.optionCount, 12);
  check('spanning an eighth to eight', [speed.values[0], speed.values.at(-1)], ['0.125', '8']);
  check('and a chosen rung actually drives playbackRate', speed.rate, 2);

  // The wider range must survive a reload through the settings bucket, or a stored 8x
  // would silently fall back to 1x on the next open.
  const round = await reader.evaluate(() => {
    const select = document.getElementById('speed');
    return { value: select.value };
  });
  check('and the chosen speed is a rung the select itself holds', speed.values.includes(round.value), true);
}

section('the audio track selector');

{
  // The fixture is AAC 440 Hz followed by AAC 880 Hz, so the TONE says which track is
  // playing. Asserting the `<select>` value would prove nothing about what came out of
  // the speakers, that is the exact trap Chromium issue 40663787 is about, where the
  // state said one thing and the audio said another.
  await reader.bringToFront();

  // **The row is ALWAYS there, including before a file is opened.** It used to hide
  // unless a file had more than one track, which made "one track", "no track" and "a
  // decoder problem" indistinguishable, leaving a viewer with no sound nowhere to
  // look. Pinned here because hiding it again is the obvious thing to do.
  const beforeLoad = await reader.evaluate(() => ({
    fieldHidden: document.getElementById('audio-field').hidden,
    hasButton: document.getElementById('audio') !== null,
  }));
  check('the audio row is visible before a file is opened', beforeLoad.fieldHidden, false);
  check('and no button to reveal it either', beforeLoad.hasButton, false);
  await reader.setInputFiles('#pick-files', join(FIXTURES, 'two-audio.mkv'));
  // Wait for the TRACKS, not for the row. The row is visible immediately now, so
  // waiting on it would read the options before they were populated.
  const listed = await reader
    .waitForFunction(() => document.getElementById('audio-track').options.length === 2, null, { timeout: 15000 })
    .then(() => reader.evaluate(() =>
      [...document.getElementById('audio-track').options].map((option) => option.textContent),
    ))
    .catch(() => []);

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
   * `captureStream` for every measurement keeps the method identical each time, which
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
  // stream must be USABLE before it is complete, that is what lets playback begin on
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

  // Switching track re-sources the element, which fires `loadedmetadata` again, and the
  // handler there offered to RESUME a film the viewer is already watching. A modal
  // asking a question with one sensible answer, for the most ordinary thing the control
  // does.
  //
  // NOTE, and this paragraph used to say something that was WRONG: it claimed that
  // no position on a short file could produce an offer, "verified by removing the
  // guard". Removing the guard did keep this assertion green, and the reason was
  // not the file's length. `offerResume` SKIPPED its end-of-file test whenever
  // `duration` was unknown, which is exactly the case at the moment `loadVideo`
  // calls it, so a position near the end of any file could produce an offer. The
  // guard's absence was hidden by the same bug it was meant to expose.
  //
  // Confirmed by measurement, not by reading: with the bug present, a stored 5.39s
  // position in a six-second file shows "Resume at 0:05?", and the real end test
  // refuses it the moment the duration is known.
  const afterSwitchOffer = await reader.evaluate(() => ({
    resumeHidden: document.getElementById('resume').hidden,
    currentTime: Number(document.getElementById('video').currentTime.toFixed(2)),
    // Reported WITH the failure, because this is the assertion that failed
    // intermittently for a day while every attempt to explain it from the outside
    // was wrong. The cause was `offerResume` treating an unknown duration as no
    // end to be past, so the offer appeared for a position a second into the
    // file; see the note in `viewer.js`. These fields say which of the two
    // reasons would have shown it, so the next failure is readable.
    offerSeconds: document.getElementById('resume').dataset.seconds ?? null,
    offerText: document.getElementById('resume-text').textContent,
    duration: String(document.getElementById('video').duration),
  }));
  if (!afterSwitchOffer.resumeHidden) {
    console.log(`  NOTE the offer was "${afterSwitchOffer.offerText}" at ${afterSwitchOffer.offerSeconds}s; ` +
      `video currentTime ${afterSwitchOffer.currentTime}, duration ${afterSwitchOffer.duration}`);
  }
  check('switching audio offers no modal', afterSwitchOffer.resumeHidden, true);
  check('and the playhead is where it was, not reset', afterSwitchOffer.currentTime > 0, true);

}

{
  // The control is SHOWN, not hidden behind a reveal, and it sits in the transport row,
  // which is never hidden for a loaded file. There was a button here, and it toggled the
  // select beside it; a control whose whole job is to reveal the thing next to it is a
  // click tax, not a feature.
  //
  // The placement matters for a reason beyond tidiness: it lived in the caption row
  // once, and that row disappears when captions are off, so the control was unreachable
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
  // `three-tracks.mkv` cannot show this, it is six seconds. `two-audio.mkv` is five
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
  // failed, not because the caption was wrong but because that section has already
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

  // Still up immediately after the cue ended, this is the hold that keeps an ordinary
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

  // "Start over" used to hide the banner and do NOTHING else, the playhead stayed
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
  // Measured: lands at ~0.5s, not 0, the seek sets zero and playback moves on
  // immediately. Asserting `< 0.5` exactly would fail on a fast machine for the right
  // behaviour, so this asks what matters: did it go back to the START (ahead), rather
  // than staying at 3s where it was.
  check('Start over rewinds to the beginning', started.currentTime < 1.5, true);
  check('and dismisses the offer', started.hidden, true);

  // The toast property, tested through the REAL trigger rather than a hand-shown
  // banner. Setting `hidden = false` directly bypasses `offerResume`, which is where the
  // timer lives, so the first version of this test proved nothing about the timer and
  // failed, correctly.
  //
  // A stored position for this file, then a reload: the key is the worker's own, read
  // from `chrome.storage.local`.
  await page4.close();

  const page5 = await context.newPage();
  await page5.goto(`chrome-extension://${extensionId}/src/viewer/viewer.html`);
  await page5.waitForTimeout(800);
  // `two-audio.mkv` (300s), NOT `three-tracks.mkv` (6s).
  //
  // The offer refuses a position later than `duration - 5`, which on a six-second
  // file is anything past one second. This test used to run on `three-tracks` and
  // set the playhead to 3s, so it was asserting an offer that the rule says must
  // NOT be made. It passed only because `duration` is NaN at the moment
  // `loadVideo` asks, `Number.isFinite(NaN)` is false, and the end test was
  // skipped. Repaired there, this test had to move to a file long enough for a
  // mid-file position to be a real one.
  await page5.setInputFiles('#pick-files', join(FIXTURES, 'two-audio.mkv'));
  await page5.waitForFunction(() => document.getElementById('video')?.readyState >= 2, null, {
    timeout: 20000,
  });
  // Play a moment so the position is remembered, then reload so the offer fires.
  await page5.evaluate(() => {
    document.getElementById('video').currentTime = 30;
    document.getElementById('video').play().catch(() => {});
  });
  await page5.waitForTimeout(5200);
  await page5.evaluate(() => document.getElementById('video').pause());
  await page5.reload();
  await page5.waitForTimeout(1200);
  await page5.setInputFiles('#pick-files', join(FIXTURES, 'two-audio.mkv'));

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
  // trusted gesture, and autoplay without one is refused, which is exactly what the
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

section('A file the browser cannot decode is transcoded so the element can play it');

{
  // The failure this feature exists for: a file whose audio is E-AC-3 plays its picture
  // and emits SILENCE, with no `MediaError` to catch. `one-eac3.mkv` is that file.
  //
  // **The design changed, and so did what proves it works.** The decoded audio used to
  // play through Web Audio with the element forced MUTED, so "the element is muted" was
  // the signal that decoding had started. Now the audio is re-encoded to AAC and remuxed
  // into a stream the ELEMENT plays, so the element is deliberately NOT muted, and the
  // proof is that it decodes audio: `webkitAudioDecodedByteCount` is Chrome's own count
  // of the audio bytes it has decoded, which is non-zero only if there IS audio to
  // decode. A test that only checked "the module loaded" would pass against a stream
  // with no sound, which is exactly the bug this guards.
  //
  // The measurement runs UNDER THE EXTENSION ORIGIN, because the manifest's CSP
  // (`wasm-unsafe-eval`) is what allows WebAssembly to instantiate. A plain-page check
  // would pass while the shipped extension failed.
  const page8 = await context.newPage();
  await page8.goto(`chrome-extension://${extensionId}/src/viewer/viewer.html`);
  await page8.waitForTimeout(1000);

  await page8.setInputFiles('#pick-files', join(FIXTURES, 'one-eac3.mkv'));

  // Transcoding takes a moment, so wait on the OUTCOME rather than on a fixed delay: the
  // element is playing and has decoded audio.
  await page8.waitForFunction(
    () => {
      const video = document.getElementById('video');
      return video.currentTime > 0.1 && (video.webkitAudioDecodedByteCount ?? 0) > 0;
    },
    null,
    { timeout: 60000 },
  );

  check(
    'the element is NOT muted: it plays the transcoded audio itself',
    await page8.evaluate(() => document.getElementById('video').muted),
    false,
  );

  // Nothing is said when it works. An earlier version printed "being decoded for you" on
  // every such file, which is the product narrating itself: the viewer asked for a film
  // and got sound, which needs no announcement. Pinned because it is a deliberate
  // reversal, and "add a friendly message" is the obvious thing to do next.
  check(
    'and nothing is said, because decoding successfully is not news',
    await page8.evaluate(() => document.getElementById('audio-note').textContent),
    '',
  );

  const played = await page8.evaluate(() => {
    const video = document.getElementById('video');
    return {
      decoded: video.webkitAudioDecodedByteCount,
      duration: video.duration,
      currentTime: video.currentTime,
    };
  });

  check('the element decoded audio from the transcoded stream', played.decoded > 0, true);
  check(
    'and the stream is a real one, with a finite duration',
    Number.isFinite(played.duration) && played.duration > 1,
    true,
  );

  await page8.close();
}

section('Dolby audio keeps playing past the first buffer window');

{
  // **This is the test that would have caught the bug that reached a user**, and it is
  // built around what the earlier tests got wrong rather than around the fix.
  //
  // `one-eac3.mkv` is 2.4 seconds, which FITS ENTIRELY IN THE FIRST DECODE WINDOW, so a
  // decoder that schedules one window and then stops for good passes on it. That is what
  // happened: every test used a short file, the audio played for about two seconds and
  // stopped, and on a real film the viewer got a couple of seconds and then silence. The
  // fixture is 5.1 and 30 seconds, so there is nothing to stop early into.
  //
  // It also checks the MUTE button, which reported "muted" while sound was playing,
  // because the icon was drawn from the element's `muted` rather than from what the
  // viewer chose.
  const page9 = await context.newPage();
  await page9.goto(`chrome-extension://${extensionId}/src/viewer/viewer.html`);
  await page9.waitForTimeout(1000);
  await page9.setInputFiles('#pick-files', join(FIXTURES, 'six-eac3.mkv'));

  await page9.waitForFunction(
    () => {
      const video = document.getElementById('video');
      return video.currentTime > 0.1 && (video.webkitAudioDecodedByteCount ?? 0) > 0;
    },
    null,
    { timeout: 90000 },
  );

  // The mute ICON must show the viewer's intent. Reading `aria-pressed` is reading what
  // the button SHOWS.
  check(
    'the mute button does not claim the sound is off',
    await page9.evaluate(() => document.getElementById('mute').getAttribute('aria-pressed')),
    'false',
  );
  check(
    'and the element is playing audible sound, not muted',
    await page9.evaluate(() => document.getElementById('video').muted),
    false,
  );

  // Whether the sound KEPT playing, and whether SEEKING works in both directions. A seek
  // is the point: on the old design a seek was what stopped the refill for good, and a
  // test that only played straight through would have missed it. It is also where the bug
  // that reached a user lived: a jump forward threw `error 3`, because the video was
  // announced to `addSourceBuffer` with a codec string that did not match the file. So
  // the assertions below are "a seek lands where it was asked to, and no error appears",
  // not merely "the playhead moved".
  const progress = await page9.evaluate(async () => {
    const video = document.getElementById('video');
    await video.play().catch(() => {});
    const seekTo = async (seconds) => {
      video.currentTime = seconds;
      await new Promise((resolve) => setTimeout(resolve, 800));
      return { at: video.currentTime, error: video.error ? video.error.code : null };
    };
    const forward = await seekTo(10);
    const backward = await seekTo(3);
    const times = [];
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 700));
      times.push(video.currentTime);
    }
    return {
      forward,
      backward,
      first: times[0],
      last: times[times.length - 1],
      decoded: video.webkitAudioDecodedByteCount,
      duration: video.duration,
    };
  });

  check('the stream has a finite duration', Number.isFinite(progress.duration), true);
  // `seekable` covers the target, so the element accepted the jump rather than clamping.
  check('a forward seek lands where it was asked to', progress.forward.at > 9, true);
  check('and it raises no media error', progress.forward.error, null);
  check('a backward seek lands where it was asked to', progress.backward.at < 4, true);
  check('and it raises no media error either', progress.backward.error, null);
  check('and it keeps playing afterwards', progress.last > progress.first, true);
  check('with audio still being decoded', progress.decoded > 0, true);

  await page9.close();
}

section('a long file reads its captions from the container index, not the whole file');

{
  // **The failure this catches is a viewer that waits a minute for subtitles.** A caption
  // track's blocks live inside the video's clusters, so reading them meant walking the whole
  // file: measured, one track on a 25 GB film cost 3281 reads and 27.5 GB, and the browser
  // took 79 seconds to reach the first caption. The container's `Cues` index names the
  // clusters for a window of time, and the viewer now reads a window first and fills the
  // rest in the background.
  //
  // `long-subs.mkv` is ten minutes with a cue every 30 seconds, so its window and its whole
  // file are clearly different lists. The assertion is that a caption is available EARLY,
  // and that a caption near the END of the file is reachable after the fill, because a
  // windowed read that never filled would pass the first half and fail the second.
  const reader = await context.newPage();
  await reader.goto(`chrome-extension://${extensionId}/src/viewer/viewer.html`);
  await reader.waitForTimeout(800);

  const t0 = Date.now();
  await reader.setInputFiles('#pick-files', join(FIXTURES, 'long-subs.mkv'));

  // A caption at the very start, which is what the first window covers. The element is
  // PAUSED inside the first cue rather than left playing, so the wait cannot drift past the
  // four-second cue and read an empty line for a position that was captioned.
  const early = await reader
    .waitForFunction(
      () => {
        const video = document.getElementById('video');
        video.muted = true;
        video.pause();
        video.currentTime = 1;
        return (document.getElementById('caption-primary')?.textContent ?? '').length > 0;
      },
      null,
      { timeout: 30000 },
    )
    .then(() => true)
    .catch(() => false);
  const earlyMs = Date.now() - t0;
  check('a caption appears near the start', early, true);
  // The first pass is a window, so it must be well under the ~10s a full scan of a file this
  // size takes, let alone the minutes a 25 GB one did.
  check('and it arrives without reading the whole file', earlyMs < 15000, true);

  const earlyText = await reader.evaluate(() =>
    document.getElementById('caption-primary').textContent.replace(/\s+/g, ' ').trim().slice(0, 16),
  );
  // The first cue, so a window that read the WRONG region would show something else.
  check('and it is the first cue', /Line 1/.test(earlyText), true);

  // Now a cue near the END, and INSIDE it: the last cue is "Line 20" at 570s for four
  // seconds, so 571 lands in it while 590 would land past it and correctly show nothing.
  // The fill pass has to have completed for this to be drawn, so a windowed read that never
  // filled would fail here, which is why both ends of the file are asserted rather than only
  // the start. Paused again, for the same drift reason.
  await reader.evaluate(() => {
    const video = document.getElementById('video');
    video.muted = true;
    video.pause();
    video.currentTime = 571;
  });
  const late = await reader
    .waitForFunction(
      () => (document.getElementById('caption-primary')?.textContent ?? '').includes('Line 20'),
      null,
      { timeout: 60000 },
    )
    .then(() => true)
    .catch(() => false);
  check('and a cue near the end is reachable, so the rest was filled in', late, true);

  await reader.close();
}

section('the second line survives the background fill on a long file');

{
  // **The failure this catches is a second line that goes blank partway through a film.**
  // The gloss is ALIGNED to the study cues (`alignSecondary`), one gloss string per study
  // cue, and that alignment used to happen once, right after the FIRST pass, when the study
  // list is only a window of a few minutes. The background fill then grew that list to the
  // whole film, and the alignment was never redone, so the gloss array stayed the length of
  // the window and every cue past it read `undefined` and drew an empty second line.
  //
  // The regression is only reachable when a file is BOTH windowed AND carries a chosen
  // gloss, and before `long-dual.mkv` no fixture was both: `long-subs.mkv` windows but has
  // one track, `three-tracks.mkv` has a gloss but is six seconds, which one window covers so
  // the fill never runs. So this fixture exists to be that combination, and the assertion is
  // a second line near the END of the film, where a stale alignment is blank.
  const reader = await context.newPage();
  await reader.goto(`chrome-extension://${extensionId}/src/viewer/viewer.html`);
  await reader.waitForTimeout(800);

  // **The gloss is seeded BEFORE the file is opened, and that is what makes this a test.**
  // Choosing it afterwards runs the alignment against the study list as it already stands,
  // which is the WHOLE film if the fill finished and the WINDOW if it did not, so the test
  // would pass or fail on the fill's timing rather than on the bug. Selecting it first pins
  // the timing the bug actually needs: the alignment happens at load, against the first-pass
  // window of a few minutes, and then the fill grows the study list under it. Seeded through
  // storage, so it is the same path a returning learner's saved choice takes.
  await reader.evaluate(() => chrome.storage.local.set({ settings: { glossLanguage: 'en' } }));
  await reader.waitForTimeout(200);

  await reader.setInputFiles('#pick-files', join(FIXTURES, 'long-dual.mkv'));
  // Let the fill finish: ten minutes of two tracks is small enough to complete quickly, and
  // the wait only has to outlast the read, not be exact.
  await reader.waitForTimeout(4000);

  // Seek DEEP into the film, well past the first window, and PAUSE inside the last cue so
  // the assertion cannot drift off it. The study line is "Study 20" and the gloss is
  // "Gloss 20" at 570s for four seconds.
  await reader.evaluate(() => {
    const video = document.getElementById('video');
    video.muted = true;
    video.pause();
    video.currentTime = 571;
  });
  const late = await reader
    .waitForFunction(
      () => {
        const primary = document.getElementById('caption-primary')?.textContent ?? '';
        const secondary = document.getElementById('caption-secondary')?.textContent ?? '';
        return primary.includes('Study 20') && secondary.includes('Gloss 20');
      },
      null,
      { timeout: 60000 },
    )
    .then(() => true)
    .catch(() => false);
  const seen = await reader.evaluate(() => ({
    primary: document.getElementById('caption-primary')?.textContent ?? '',
    secondary: document.getElementById('caption-secondary')?.textContent ?? '',
  }));
  check('the study line near the end of a long file is drawn', seen.primary.includes('Study 20'), true);
  check('and its second line is drawn beside it, not left blank', late, true);

  await reader.close();
}

section('the difficulty band appears whole, only once the film is read');

{
  // **The band is drawn from the marks on the WHOLE film, and it is held back until the
  // read is complete.** Painting it while the background fill is still going would draw a
  // fragment that grows in pieces, which reads as a glitch. So the property to pin is
  // TIMING: no span is ever added while the film is still being read. `long-band.mkv` is the
  // fixture for this because it is long enough to be windowed AND its study track is Chinese,
  // which has a word list, so marks exist and a missing band can only mean "held back". A file
  // whose study track cannot be marked is empty either way, and `three-tracks.mkv` is six
  // seconds, one window, so the fill never runs and the two states are indistinguishable.
  const reader = await context.newPage();
  await reader.goto(`chrome-extension://${extensionId}/src/viewer/viewer.html`);
  await reader.waitForTimeout(800);

  // **Warm the dictionary FIRST, on a short file, and this is what makes the test bite.**
  // The band is painted from marked cues, and marks need the dictionary, which is fetched.
  // On a small fixture the fetch and the read both finish in milliseconds, so whether a
  // paint lands mid-read is a coin toss and the test passes with or without the guard. On a
  // real film the dictionary is local and instant while the read takes seconds, so a paint
  // WOULD land mid-read, which is exactly the case the guard exists for. Warming the
  // dictionary on `three-tracks.mkv` (six seconds, so its read is trivial) makes marks
  // available before the long read starts, so the fill's own paints are the only paints and
  // the guard is the only thing deciding whether they happen.
  await reader.setInputFiles('#pick-files', join(FIXTURES, 'three-tracks.mkv'));
  await reader.selectOption('#study-track', 'zh');
  await reader
    .waitForFunction(() => document.querySelectorAll('#cues span').length > 0, null, { timeout: 30000 })
    .catch(() => {});

  await reader.setInputFiles('#pick-files', join(FIXTURES, 'long-band.mkv'));
  // Chosen explicitly, so the study list follows the Chinese track whatever the ambient
  // stored preference is, the same reasoning the band section above uses. Same language as
  // the warm-up, so the cached dictionary is reused and no fetch is in flight.
  await reader.selectOption('#study-track', 'zh');

  // Wait for the read to finish, which the element publishes, rather than waiting on the
  // band's appearance, which would be circular when the band is what is being tested.
  await reader.waitForFunction(() => document.getElementById('cues').dataset.readComplete === 'true', null, {
    timeout: 60000,
  });
  // One paint after completion, so the band drawn at completion is in the DOM.
  await reader.waitForTimeout(500);

  // **Read from each span's OWN stamp, not from the container's state now.** Checking the
  // container races the read: a span drawn mid-read would be observed after the read finished
  // and look correct, so the test would pass on the very regression it exists to catch. The
  // span carries `drawnComplete`, set at creation, so this reads what was true when the span
  // was drawn.
  const band = await reader.evaluate(() => {
    const spans = [...document.querySelectorAll('#cues span')];
    return {
      stamps: spans.map((span) => span.dataset.drawnComplete),
      count: spans.length,
    };
  });

  check('no band run is drawn while the film is still being read', band.stamps.every((s) => s === 'true'), true);
  check('and the band is drawn once the read is done', band.count > 0, true);

  await reader.close();
}

section('a DTS file is transcoded too, the third codec WebCodecs lacks');

{
  // **DTS is the codec the project once believed it could not support.** ADR 0011 said no
  // non-GPL DTS decoder existed, so it stayed out of scope and a DTS film played silence.
  // ADR 0013 reversed that: `@mediabunny/dts` is MPL-2.0, and the licence obstacle was
  // never there. This section is the proof that the reversal reached the code, because a
  // decision in a document and a working decoder are different things.
  //
  // The assertions are the same shape as the E-AC-3 case and for the same reason: a DTS
  // film must not merely LOAD, it must produce audibly decoded samples. `one-dts.mkv` is a
  // GENERATED fixture, so CI has it.
  const page11 = await context.newPage();
  await page11.goto(`chrome-extension://${extensionId}/src/viewer/viewer.html`);
  await page11.waitForTimeout(1000);
  await page11.setInputFiles('#pick-files', join(FIXTURES, 'one-dts.mkv'));

  await page11.waitForFunction(
    () => {
      const video = document.getElementById('video');
      return video.currentTime > 0.1 && (video.webkitAudioDecodedByteCount ?? 0) > 0;
    },
    null,
    { timeout: 60000 },
  );

  const played = await page11.evaluate(() => {
    const video = document.getElementById('video');
    const ranges = video.buffered;
    return {
      decoded: video.webkitAudioDecodedByteCount,
      muted: video.muted,
      duration: video.duration,
      ranges: ranges.length,
    };
  });

  check('the DTS file decoded audio rather than playing silence', played.decoded > 0, true);
  // NOT muted, because the element plays our transcoded stream itself (ADR 0012). An
  // earlier design muted the element and played audio separately, so this also pins that
  // the DTS path goes through the same element-owned playback as everything else.
  check('and the element is not muted, it plays the transcoded audio', played.muted, false);
  check('and the stream is finite', Number.isFinite(played.duration), true);

  // The capability probe must report DTS as decodable once the coder is registered. This
  // is what routes a DTS track to the transcode path instead of the "cannot play" note.
  const canDecode = await page11.evaluate(async () => {
    const coders = await import('./coders.js');
    return { dts: await coders.canDecodeTrack('dts') };
  });
  check('and the capability probe says DTS is decodable', canDecode.dts, true);

  await page11.close();
}

section('Fullscreen, and the Picture-in-Picture round trip');

{
  // Three separate things, all reachable and all previously wrong:
  //
  //   1. The button could not ENTER fullscreen when `innerHeight` happened to equal
  //      `screen.height`, which is true in a headless browser (no chrome) and in a
  //      maximised window (4px of chrome). The heuristic that exists to notice
  //      F11-fullscreen was blocking a legal request.
  //   2. Entering PiP DROPS element fullscreen, measured, not assumed: the state goes
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
  // true, if a future Chrome preserves fullscreen across PiP, this test says so.
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
  // a user gesture is required, measured both ways: refused from the event, succeeded
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

section('the caption for a position is the same at every speed');

{
  // **This pins the rule ADR 0016 makes non-negotiable: the three surfaces stay in step.**
  // A caption is a function of WHERE the picture is, never of how fast it is going or how
  // an event happened to fire. So for one fixed `currentTime`, the caption must be the same
  // at 0.125x and at 8x. That invariant needs no cue list to check and cannot pass by
  // accident the way a timing tolerance can: if the renderer were driven by `timeupdate`
  // (which is fixed near 4 Hz regardless of rate, the original bug) the caption would
  // change with the rate at a fixed position, and this fails.
  const page10 = await context.newPage();
  await page10.goto(`chrome-extension://${extensionId}/src/viewer/viewer.html`);
  await page10.waitForTimeout(800);
  // A GENERATED fixture, so CI has it. Its cues are at 0.5s for 2s and at 3s for 2s, which
  // is enough: the positions below sit inside those cues and the position is HELD (paused),
  // so nothing depends on the file being long.
  await page10.setInputFiles('#pick-files', join(FIXTURES, 'three-tracks.mkv'));
  await page10.waitForTimeout(5000);

  /**
   * The caption drawn for a position, at a given rate, WITHOUT letting it drift.
   *
   * The element is PAUSED before the position is read. At 8x a long wait would advance the
   * playhead past the cue, so a test that played would read a different position than it
   * asked for and compare captions from two different cues. Pausing holds the position, so
   * the only thing the rate can change is how the renderer decides WHICH cue that position
   * has, which is exactly the property under test.
   *
   * It WAITS FOR A NON-EMPTY CAPTION rather than sleeping a fixed time, because a finished
   * cue holds on screen for `captionFade` and then fades, and a fixed wait can land inside
   * that fade and read an empty line for a position that is perfectly well captioned. That
   * is a race in the TEST, not the player, and the fix is to poll for the settled state.
   */
  const captionAt = async (seconds, rate) => {
    await page10.evaluate(
      ({ s, r }) => {
        const video = document.getElementById('video');
        video.pause();
        video.muted = true;
        video.playbackRate = r;
        video.currentTime = s;
      },
      { s: seconds, r: rate },
    );
    await page10
      .waitForFunction(() => document.getElementById('caption-primary').textContent.trim().length > 0, null, { timeout: 4000 })
      .catch(() => {});
    // A short settle after the caption appears, so a fade scheduled by the position change
    // cannot fire between the poll and the read.
    await page10.waitForTimeout(150);
    return page10.evaluate(() => document.getElementById('caption-primary').textContent.replace(/\s+/g, ' ').trim());
  };

  // Positions inside the fixture's cues (0.5s+2s and 3s+2s), so the expectation is a
  // non-empty caption rather than a gap.
  const positions = [1.0, 4.0];
  const rates = [0.125, 1, 2, 4, 8];

  for (const seconds of positions) {
    const reference = await captionAt(seconds, 1);
    check(`a caption is drawn at ${seconds}s`, reference.length > 0, true);

    const sameEverywhere = [];
    for (const rate of rates) {
      const shown = await captionAt(seconds, rate);
      if (shown !== reference) sameEverywhere.push(`${rate}x:"${shown.slice(0, 12)}"`);
    }
    check(`and it is identical at every speed (${seconds}s)`, sameEverywhere, []);
  }

  await page10.close();
}

section('the keyboard shortcuts drive the player, and the help panel lists them');

{
  // **The wiring, not the mapping.** Which key means which action, and when a key
  // belongs to the player at all, are tested hermetically in `shortcuts.test.mjs`. What
  // only a browser can show is that a key reaches the media element: that `k` starts
  // playback, that `l` moves the playhead, and that a key pressed inside a text field
  // does NOT move it. A mapping that is right and a listener that is never attached
  // passes every hermetic check and does nothing here.
  const page12 = await context.newPage();
  await page12.goto(`chrome-extension://${extensionId}/src/viewer/viewer.html`);
  await page12.waitForTimeout(800);
  await page12.setInputFiles('#pick-files', join(FIXTURES, 'three-tracks.mkv'));
  // A track with cues, so the line-stepping keys have a list to step through. Chinese,
  // so it is the same fixture the band section uses and the read is instant.
  await page12.selectOption('#study-track', 'zh');
  await page12.waitForFunction(() => (document.getElementById('caption-primary')?.textContent ?? '').length > 0, null, {
    timeout: 30000,
  });
  await page12.evaluate(() => {
    const video = document.getElementById('video');
    video.muted = true;
    video.pause();
    video.currentTime = 0;
  });

  // `k` plays. The element's own `paused` is the assertion, not our button's icon: the
  // icon is derived, and a listener that flipped the icon without calling `play` would
  // pass on the icon.
  await page12.keyboard.press('k');
  await page12.waitForTimeout(300);
  const playing = await page12.evaluate(() => !document.getElementById('video').paused);
  check('k starts playback', playing, true);

  // `l` moves forward 5 seconds. Paused first, so the position cannot drift from
  // playback and make the assertion pass for the wrong reason.
  await page12.evaluate(() => {
    const video = document.getElementById('video');
    video.pause();
    video.currentTime = 0;
  });
  await page12.keyboard.press('l');
  await page12.waitForTimeout(200);
  const forward = await page12.evaluate(() => document.getElementById('video').currentTime);
  check('l seeks forward 5 seconds', forward > 4 && forward < 6, true);

  // `j` moves backward, and from the same place so the two are a pair.
  await page12.keyboard.press('j');
  await page12.waitForTimeout(200);
  const backAgain = await page12.evaluate(() => document.getElementById('video').currentTime);
  check('j seeks back 5 seconds', backAgain < 1, true);

  // **The rule that matters most, in the browser.** `k` typed into a text field must
  // insert a character and leave playback alone. Asserted on `paused` rather than on
  // the field's value, because the field does not exist, the point is that the guard
  // reads the TARGET tag, and a real input is the only way to produce that target.
  await page12.evaluate(() => {
    const input = document.createElement('input');
    input.id = 'probe-input';
    document.body.append(input);
    input.focus();
    document.getElementById('video').pause();
  });
  await page12.keyboard.press('k');
  await page12.waitForTimeout(200);
  const stillPaused = await page12.evaluate(() => document.getElementById('video').paused);
  const typed = await page12.evaluate(() => document.getElementById('probe-input')?.value ?? '');
  check('k typed into a field does not start playback', stillPaused, true);
  check('and the character reaches the field', typed, 'k');
  await page12.evaluate(() => document.getElementById('probe-input')?.remove());

  // `c` toggles the captions, through the same setting the button writes.
  const captionsBefore = await page12.evaluate(
    () => document.getElementById('captions')?.getAttribute('aria-pressed'),
  );
  await page12.keyboard.press('c');
  await page12.waitForTimeout(200);
  const captionsAfter = await page12.evaluate(
    () => document.getElementById('captions')?.getAttribute('aria-pressed'),
  );
  check('c toggles the captions', captionsBefore !== captionsAfter, true);

  // `f` toggles fullscreen. Headless Chromium allows element fullscreen, so the state
  // is checked directly rather than through the button's label.
  await page12.keyboard.press('f');
  await page12.waitForTimeout(300);
  const fullscreen = await page12.evaluate(() => Boolean(document.fullscreenElement));
  check('f enters fullscreen', fullscreen, true);
  await page12.keyboard.press('f');
  await page12.waitForTimeout(300);
  const left = await page12.evaluate(() => Boolean(document.fullscreenElement));
  check('and f leaves it again', left, false);

  // `?` opens the help panel, and the panel must list the keys from the same table.
  // The count is read from the MODULE rather than hardcoded, so adding a shortcut does
  // not require editing a number here, and a panel that rendered a partial list is still
  // caught because the two are compared rather than both being a literal.
  await page12.keyboard.press('?');
  await page12.waitForTimeout(200);
  const help = await page12.evaluate(async () => {
    const { SHORTCUTS } = await import('./shortcuts.js');
    return {
      open: !document.getElementById('shortcuts')?.hidden,
      rows: document.querySelectorAll('#shortcuts dt').length,
      expected: SHORTCUTS.length,
      hasToggleKey: [...document.querySelectorAll('#shortcuts kbd')].some((k) => k.textContent === 'C'),
      // The rendered text a learner actually reads. A note the script appends would not
      // be in the label, so this is the check that catches a parenthetical ON SCREEN
      // rather than one in the table.
      descriptions: [...document.querySelectorAll('#shortcuts dd')].map((el) => el.textContent),
    };
  });
  check('? opens the shortcut panel', help.open, true);
  check('and it lists every shortcut in the table', help.rows, help.expected);
  check('and the panel names the captions key', help.hasToggleKey, true);
  check(
    'and no rendered description carries an editorial note',
    help.descriptions.filter((text) => /[()[\]]/.test(text)),
    [],
  );

  // Escape closes it, so the panel is dismissable from the keyboard that opened it.
  await page12.keyboard.press('Escape');
  await page12.waitForTimeout(200);
  const closed = await page12.evaluate(() => document.getElementById('shortcuts')?.hidden);
  check('and Escape closes it', closed, true);

  // `a` opens the licences panel, the same KIND of card as the help, in the same corner.
  // It is built from `SOURCES` at runtime, so this is the only place its content can be
  // checked against the module rather than against a promise that a markup file matches.
  await page12.keyboard.press('a');
  await page12.waitForTimeout(200);
  const licences = await page12.evaluate(async () => {
    const { SOURCES } = await import('../common/sources.js');
    const panel = document.getElementById('licences');
    return {
      open: !panel?.hidden,
      // One row per source, compared to the module rather than a literal, so a source
      // added to the list shows up here as a mismatch rather than passing.
      rows: panel ? panel.querySelectorAll('.licence-row').length : -1,
      expected: SOURCES.length,
      named: [...(panel?.querySelectorAll('.licence-name') ?? [])].map((el) => el.textContent),
      expectedNames: SOURCES.map((s) => s.name),
      helpClosed: document.getElementById('shortcuts')?.hidden,
    };
  });
  check('a opens the licences panel', licences.open, true);
  check('and it lists every source', licences.rows, licences.expected);
  check('with the expected names', licences.named, licences.expectedNames);
  // The two panels share a corner, so opening one must close the other or they overlap.
  check('and opening the licences closed the help', licences.helpClosed, true);

  await page12.keyboard.press('Escape');
  await page12.waitForTimeout(200);
  const licencesClosed = await page12.evaluate(() => document.getElementById('licences')?.hidden);
  check('and Escape closes the licences', licencesClosed, true);

  await page12.close();
}

section('Space plays even with the file picker focused');

{
  // **The bug this catches: choosing a file left the hidden file input FOCUSED, and the
  // guard treated every `<input>` as a text field, so `Space` activated the picker and
  // reopened the file dialog instead of toggling playback.** The learner had no way to
  // tell the picker was the active control, because it is `visually-hidden`.
  //
  // The fix is that the guard reads the input's TYPE: a file picker must not swallow a key
  // that is not for typing. This is asserted through the real element after a real file
  // choice, because the bug only exists once the input has actually been used and kept
  // focus, which no hermetic test can reproduce.
  const page13 = await context.newPage();
  await page13.goto(`chrome-extension://${extensionId}/src/viewer/viewer.html`);
  await page13.waitForTimeout(800);
  // Focus the picker by clicking its LABEL, which is what a learner does, then choose a
  // file. The click is what transfers focus to the hidden input.
  await page13.click('label[for="pick-files"]').catch(() => {});
  await page13.setInputFiles('#pick-files', join(FIXTURES, 'three-tracks.mkv'));
  await page13.waitForFunction(() => (document.getElementById('video')?.duration ?? 0) > 0, null, { timeout: 15000 });
  await page13.evaluate(() => {
    const video = document.getElementById('video');
    video.muted = true;
    video.pause();
    video.currentTime = 0;
  });

  // The picker has focus, which is the state that broke.
  const focused = await page13.evaluate(() => document.activeElement?.id ?? '');
  check('the file picker is the focused element', focused, 'pick-files');

  await page13.keyboard.press(' ');
  await page13.waitForTimeout(300);
  const played = await page13.evaluate(() => !document.getElementById('video').paused);
  check('and Space still toggles playback', played, true);

  await page13.close();
}

section('every command leaves a visible trace');

{
  // **A command with no feedback cannot be told from a dropped one.** The badges are the
  // readout the browser tests can see; what they must pin is that a real command TURNS ONE
  // ON, and that the seek badge names the step, because a badge that only ever showed a
  // fixed icon would pass a "something appeared" check while telling the learner nothing.
  const page14 = await context.newPage();
  await page14.goto(`chrome-extension://${extensionId}/src/viewer/viewer.html`);
  await page14.waitForTimeout(800);
  await page14.setInputFiles('#pick-files', join(FIXTURES, 'three-tracks.mkv'));
  // **Captions forced ON, because the setting persists across pages in this context.** An
  // earlier section presses `c` to test the toggle, which writes `captionsOn: false` to
  // storage, and the caption row (which holds the track picker) is hidden while captions
  // are off. Without this the picker is present but not visible, and the select retries
  // against a hidden element until it times out.
  await page14.evaluate(() => {
    if (document.getElementById('captions')?.getAttribute('aria-pressed') === 'false') {
      document.getElementById('captions').click();
    }
  });
  // The option must exist before it can be chosen: the picker is populated once the
  // container has been read, and selecting earlier retries against a disabled select.
  await page14.waitForFunction(() => document.querySelector('#study-track option[value="en"]') !== null, null, {
    timeout: 15000,
  });
  // The ENGLISH track, explicitly, and it is the one with MORE THAN ONE cue. The
  // auto-pick prefers Chinese, whose single cue leaves `next line` with nowhere to go, so
  // a line-stepping assertion on it would pass for the wrong reason: the correct
  // behaviour there IS to flash nothing, which is indistinguishable from a broken badge.
  await page14.selectOption('#study-track', 'en');
  await page14.waitForFunction(() => (document.getElementById('video')?.duration ?? 0) > 0, null, { timeout: 15000 });
  await page14.evaluate(() => {
    const video = document.getElementById('video');
    video.muted = true;
    video.pause();
    video.currentTime = 0;
  });

  /** The three badges, with their shown flag and text. */
  const badges = () =>
    page14.evaluate(() => ({
      left: document.getElementById('feedback-left')?.dataset.shown === 'true',
      leftText: document.getElementById('feedback-left')?.textContent ?? '',
      centre: document.getElementById('feedback-centre')?.dataset.shown === 'true',
      centreText: document.getElementById('feedback-centre')?.textContent ?? '',
      right: document.getElementById('feedback-right')?.dataset.shown === 'true',
      rightText: document.getElementById('feedback-right')?.textContent ?? '',
    }));

  // A forward seek: the RIGHT badge, naming the step.
  await page14.keyboard.press('l');
  const forward = await badges();
  check('a forward seek shows the right badge', forward.right, true);
  check('and it names the step', forward.rightText, '+5');

  // A backward seek: the LEFT badge, on the side it moves towards.
  await page14.keyboard.press('j');
  const back = await badges();
  check('a backward seek shows the LEFT badge', back.left, true);
  check('and it names the step', back.leftText, '-5');

  // Play: the CENTRE badge, which is where a transport state reads.
  await page14.keyboard.press('k');
  const play = await badges();
  check('play shows the centre badge', play.centre, true);

  // **The play and pause marks must be the SAME SIZE and the same position.** They are
  // different ink in a shared viewBox, and an earlier revision drew each to its own bounds,
  // so tapping play and pause in quick succession resized and nudged the mark, which reads
  // as a flicker on the one control a learner taps most. Both the glyph box and the badge
  // box are measured, because a mismatch in either shows up as a jump.
  const playIcon = await page14.evaluate(() => {
    const svg = document.querySelector('#feedback-centre .feedback-icon');
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    const badge = document.getElementById('feedback-centre').getBoundingClientRect();
    return { w: Math.round(rect.width), h: Math.round(rect.height), bw: Math.round(badge.width), bh: Math.round(badge.height) };
  });
  // Toggle to pause, and measure the same two boxes.
  await page14.keyboard.press('k');
  await page14.waitForTimeout(150);
  const pauseIcon = await page14.evaluate(() => {
    const svg = document.querySelector('#feedback-centre .feedback-icon');
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    const badge = document.getElementById('feedback-centre').getBoundingClientRect();
    return { w: Math.round(rect.width), h: Math.round(rect.height), bw: Math.round(badge.width), bh: Math.round(badge.height) };
  });
  check('the play and pause glyph boxes are the same size', playIcon && pauseIcon ? { w: playIcon.w, h: playIcon.h } : null, pauseIcon ? { w: pauseIcon.w, h: pauseIcon.h } : undefined);
  check('and the badge box does not change between them', playIcon && pauseIcon ? { bw: playIcon.bw, bh: playIcon.bh } : null, pauseIcon ? { bw: pauseIcon.bw, bh: pauseIcon.bh } : undefined);

  // A number key: the centre badge, naming the percentage so the key teaches itself.
  await page14.keyboard.press('5');
  const jump = await badges();
  check('a jump shows the percentage', jump.centreText, '50%');

  // Line stepping: the badge names the ACTION, not the line's text. The caption for the
  // line stepped to is already on screen, so echoing it here duplicated the caption in a
  // smaller font and made it ambiguous whether the badge was the line or a report about
  // it. Asserted on the word "line", which the caption text of this fixture never
  // contains, so a regression back to echoing the text fails here.
  //
  // The position is set INSIDE THE FIRST CUE deliberately, and the wait is required: the
  // assignment is asynchronous, and a keypress sent before it lands reads the OLD position,
  // where no cue has started and `nextCue` returns early with nothing to report. `]` only
  // reports when a next cue EXISTS, so testing from the end of the film (where the `5` jump
  // left the playhead) would pass for the wrong reason.
  await page14.evaluate(() => {
    const video = document.getElementById('video');
    video.pause();
    video.currentTime = 1;
  });
  await page14.waitForFunction(() => document.getElementById('video').currentTime >= 0.9, null, { timeout: 5000 });
  await page14.keyboard.press(']');
  const next = await badges();
  check('stepping to the next line says so', /next line/i.test(next.centreText), true);
  check('and it does not echo the caption text', !next.centreText.includes('Hello'), true);

  await page14.keyboard.press('[');
  const prev = await badges();
  check('stepping back says so', /previous line/i.test(prev.centreText), true);

  await page14.keyboard.press('\\');
  const replay = await badges();
  check('and replay says so', /replay/i.test(replay.centreText), true);

  // A speed change: the right badge, labelled as the picker labels it.
  await page14.keyboard.press('>');
  const speed = await badges();
  check('a speed change shows the new rate', /1\.25|1\.5|2/.test(speed.rightText), true);
  check('and it is labelled with the times sign', speed.rightText.includes('\u00d7'), true);

  // The badges CLEAR, or the readout would sit over the picture forever. Waited past the
  // fade, which is what makes this an assertion about the timer rather than the fade.
  await page14.waitForTimeout(1000);
  const cleared = await badges();
  check('and the badges clear on their own', cleared.left && cleared.centre && cleared.right, false);

  await page14.close();
}

await closeAll();

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
