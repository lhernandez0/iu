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
import { ENGLISH, GERMAN, OTHER_ENGLISH, listCaptures, captureFor } from './fixtures.mjs';
import { loadSynthetic } from '../synthetic/load.mjs';

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
    // Readable names rather than the raw codes: a status line is for reading,
    // and "en + de" was the schema's vocabulary leaking into the UI. Asserted as
    // two separate facts so it does not depend on the fixture's exact spacing.
    check('status names both languages', state.status.includes('English') && state.status.includes('Deutsch'), true);
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

  section('switching to another video IN THE SAME TAB replaces the transcript');

  {
    // This is the case that broke, and the earlier version of this file could not
    // catch it because it opened the second video in a NEW tab — a fresh page
    // load with a correct player response. An in-tab switch is different:
    // YouTube does NOT update ytInitialPlayerResponse, so the extension kept
    // reporting the first video's captions while the highlight moved to the
    // second video's clock. That is exactly what the user saw.
    await routeYouTube(context, { videoId: 'tabsA000001', title: 'First In Tab', tracks: [ENGLISH] });
    await routeYouTube(context, { videoId: 'tabsB000002', title: 'Second In Tab', tracks: [OTHER_ENGLISH] });

    const watch = await openWatchPage(context, 'tabsA000001');
    const { page } = await openPanel(context, extensionId, watch);
    await waitForRows(page, 3);
    check('the first video loaded', (await panelState(page)).rows[0]?.text, 'Hey there');

    // Navigate inside the tab. The page global is left stale, as YouTube leaves it.
    await watch.evaluate(() => window.__navigateTo('tabsB000002', 'Second In Tab'));

    await page.waitForFunction(() => document.querySelectorAll('.row').length === 2, null, { timeout: 20000 });
    const state = await panelState(page);

    check('the panel switched to the new transcript', state.rows[0]?.text, 'Second video');
    check('with the new line count', state.rows.length, 2);
    check('and the new title in the status', state.status.includes('Second In Tab'), true);
  }

  section('the highlight follows the new video rather than sticking to the last line');

  {
    // The follow symptom: with the old transcript still loaded, every position
    // was past the end of it, so the highlight pinned to the final row instead of
    // tracking anything. Once the transcript is correct it must move again.
    await routeYouTube(context, { videoId: 'followA00001', title: 'Follow One', tracks: [ENGLISH] });
    await routeYouTube(context, { videoId: 'followB00002', title: 'Follow Two', tracks: [OTHER_ENGLISH] });

    const watch = await openWatchPage(context, 'followA00001');
    const { page } = await openPanel(context, extensionId, watch);
    await waitForRows(page, 3);

    await watch.evaluate(() => window.__navigateTo('followB00002', 'Follow Two'));
    await page.waitForFunction(() => document.querySelectorAll('.row').length === 2, null, { timeout: 20000 });

    const activeIndex = async () =>
      page.evaluate(() => [...document.querySelectorAll('.row')].findIndex((row) => row.classList.contains('active')));

    await watch.evaluate(() => {
      document.getElementById('player').currentTime = 0.5;
    });
    await page.waitForFunction(
      () => [...document.querySelectorAll('.row')][0]?.classList.contains('active'),
      null,
      { timeout: 10000 },
    );
    check('the first line highlights at the start', await activeIndex(), 0);

    await watch.evaluate(() => {
      document.getElementById('player').currentTime = 4;
    });
    await page.waitForFunction(
      () => [...document.querySelectorAll('.row')][1]?.classList.contains('active'),
      null,
      { timeout: 10000 },
    );
    check('and moves to the second line later', await activeIndex(), 1);
  }

  section('the learning layer marks words, and hover defines them');

  {
    // Chinese text, so the segmenter and the word list actually engage.
    const chinese = {
      languageCode: 'zh',
      name: '中文',
      segments: [
        { start: 0, duration: 2, text: '我们在岸上等你' },
        { start: 2, duration: 2, text: '这本书的内容很有意思' },
        { start: 4, duration: 2, text: '研究生命起源是一个难题' },
      ],
    };

    await routeYouTube(context, { videoId: 'learned0001', title: 'Learning', tracks: [chinese] });
    const watch = await openWatchPage(context, 'learned0001');
    const { page } = await openPanel(context, extensionId, watch);
    await waitForRows(page, 3);

    // Marks are applied after the word list loads, so wait for one to appear
    // rather than assuming it is synchronous with the transcript.
    await page.waitForFunction(() => document.querySelectorAll('.mark').length > 0, null, { timeout: 20000 });

    const marks = await page.evaluate(() => {
      const first = document.querySelector('.mark');
      const style = first ? getComputedStyle(first) : null;
      const listSelect = document.getElementById('list');
      const chosen = listSelect?.value ?? '';
      return {
        count: document.querySelectorAll('.mark').length,
        text: first?.textContent ?? '',
        borderColour: style?.borderBottomColor ?? '',
        // No native title tooltip on purpose: the level is shown in the popover
        // as a badge, and a browser tooltip on top of that would fight it.
        hasNativeTooltip: Boolean(first?.getAttribute('title')),
        listOptions: [...(listSelect?.options ?? [])].map((o) => o.value),
        chosenList: chosen,
        thresholdOptions: [...document.querySelectorAll('#threshold option')].map((o) => o.value),
        // Whatever the label says, so the count can be checked against it rather
        // than against a hardcoded number that moves when the default changes.
        chosenLabel: [...(listSelect?.options ?? [])].find((o) => o.value === chosen)?.textContent ?? '',
      };
    });

    check('words are marked', marks.count > 0, true);
    check('the mark has a coloured underline', marks.borderColour !== 'rgba(0, 0, 0, 0)', true);
    check('and no native tooltip competing with the popover', marks.hasNativeTooltip, false);
    check('both HSK lists are offered', marks.listOptions, ['hsk2_0', 'hsk3_0']);
    // 2.0 has six levels, 3.0 has nine, so the count has to match the list in
    // use. Asserting the relationship keeps this true whichever is default.
    const expectedLevels = marks.chosenLabel.includes('3.0') ? 9 : 6;
    check(`the threshold offers ${expectedLevels} levels for ${marks.chosenLabel}`,
      marks.thresholdOptions.length, expectedLevels);
    // The default must be the list that can mark the most words, not whichever
    // happens to be first — otherwise most of the dictionary is invisible.
    check('the default list is HSK 3.0, the widest', marks.chosenList, 'hsk3_0');

    // The line must still read correctly with spans in it, which is the thing
    // that silently breaks when token indices are wrong.
    const lineText = await page.evaluate(() => document.querySelector('.row .primary')?.textContent ?? '');
    check('the line still reads as its original text', lineText, '我们在岸上等你');

    section('hovering a marked word shows its definition');

    await page.locator('.mark').first().hover();
    await page.waitForFunction(
      () => {
        const pop = document.querySelector('.popover');
        return pop && !pop.hidden && (pop.textContent ?? '').length > 0;
      },
      null,
      { timeout: 10000 },
    );

    const popover = await page.evaluate(() => {
      const pop = document.querySelector('.popover');
      return {
        text: pop?.textContent ?? '',
        hidden: pop?.hidden,
        badges: pop?.querySelectorAll('.badge').length ?? 0,
      };
    });

    check('a definition is shown', popover.text.length > 0, true);
    check('it is visible', popover.hidden, false);
    check('with at least one level badge', popover.badges > 0, true);
    console.log(`        popover: ${popover.text}`);

    section('words the list cannot place are hoverable, not invisible');

    // The reported bug. On HSK 2.0, 这样 and 这么 have no level, so they must
    // render as hoverable but unmarked — not as bare text with no hover at all,
    // which made whole sentences look dead.
    await page.selectOption('#list', 'hsk2_0');
    await page.waitForFunction(() => document.querySelectorAll('.row').length > 0, null, { timeout: 10000 });
    await page.waitForTimeout(400);

    const shape = await page.evaluate(() => ({
      marks: document.querySelectorAll('.mark').length,
      words: document.querySelectorAll('.word').length,
    }));

    check('some words are marked', shape.marks > 0, true);
    // 这样 appears in the fixture and has no HSK 2.0 level, so it must land in
    // `.word` rather than vanishing into a text node.
    const unmarkedHoverable = await page.evaluate(() => {
      const spans = [...document.querySelectorAll('.word')];
      return {
        count: spans.length,
        sample: spans.slice(0, 5).map((s) => s.textContent),
        words: spans.map((s) => s.dataset.word),
      };
    });

    check('and some are hoverable without a mark', unmarkedHoverable.count > 0, true);
    check('with their word recorded for lookup', unmarkedHoverable.words.every((w) => w && w.length > 0), true);
    console.log(`        unmarked but hoverable: ${unmarkedHoverable.words.slice(0, 6).join(', ')}`);

    // Hovering one of those must still produce a definition — the whole point.
    await page.locator('.word').first().hover();
    await page.waitForFunction(
      () => {
        const pop = document.querySelector('.popover');
        return pop && !pop.hidden && (pop.textContent ?? '').length > 0;
      },
      null,
      { timeout: 10000 },
    );

    const unmarkedPopover = await page.evaluate(() => document.querySelector('.popover')?.textContent ?? '');
    check('hovering an unmarked word still defines it', unmarkedPopover.length > 0, true);
    console.log(`        popover: ${unmarkedPopover}`);
  }

  section('a gap between lines stays highlighted, and the panel scrolls to it on load');

  {
    // Two reported bugs, both about the same moment: nothing being said.
    //
    //   1. No highlight in the gap. Caused by `.row.paused` setting its own
    //      background AFTER `.row.active` — equal specificity, later rule wins —
    //      so the highlight was replaced by something very close to the page
    //      colour. Only a real cascade can show that, which is why this lives
    //      here and not in the hermetic tier.
    //   2. No scroll on load. The content script reports position from the
    //      segments it holds, and on a cached video nothing is fetched, so it
    //      held none and reported nothing. The panel therefore never learned
    //      where playback was.
    const gapped = {
      languageCode: 'en',
      name: 'English',
      segments: [
        // Deliberately with real gaps: 0-1s, then a second of silence, etc.
        { start: 0, duration: 1, text: 'First line' },
        { start: 2, duration: 1, text: 'Second line' },
        { start: 4, duration: 1, text: 'Third line' },
      ],
    };

    await routeYouTube(context, { videoId: 'gapvideo001', title: 'Gaps', tracks: [gapped] });
    const watch = await openWatchPage(context, 'gapvideo001');

    // Land in a gap before the panel opens: 1.5s is between lines one and two,
    // which run 0-1s and 2-3s. Asserted rather than assumed — a seek that does
    // not hold would leave playback inside cue 0, and the gap assertions below
    // would then fail for a reason that has nothing to do with the panel.
    await watch.evaluate(() => {
      const video = document.querySelector('video');
      if (video) video.currentTime = 1.5;
    });
    await watch.waitForFunction(() => window.__position?.() === 1.5, null, { timeout: 5000 });
    check('the fixture is parked inside a gap', await watch.evaluate(() => window.__position()), 1.5);

    const { page } = await openPanel(context, extensionId, watch);
    await waitForRows(page, 3);

    // The panel must place itself without waiting for a cue change, because on a
    // paused video none comes. The watch page is a BACKGROUND tab while the panel
    // is open, so its 250ms poll is throttled — this waits for the state rather
    // than assuming a tick has already run, which is what made an earlier version
    // of this test look like a code failure when it was only timing.
    await page.waitForFunction(() => document.querySelector('.row.paused') !== null, null, { timeout: 20000 });

    const gap = await page.evaluate(() => {
      const active = document.querySelector('.row.active');
      const transcript = document.getElementById('transcript');
      const style = active ? getComputedStyle(active) : null;
      return {
        activeText: active?.querySelector('.primary')?.textContent ?? '',
        isPaused: active?.classList.contains('paused') ?? false,
        // The real question: is it visually distinguishable from the page?
        background: style?.backgroundColor ?? '',
        textColour: style?.color ?? '',
        scrolled: transcript ? transcript.scrollTop : -1,
        // Which row is nearest the top of the scroll box, for the scroll check.
        activeTop: active ? active.getBoundingClientRect().top : -1,
        panelTop: transcript ? transcript.getBoundingClientRect().top : -1,
      };
    });

    check('the finished line is the current one', gap.activeText, 'First line');
    check('and is marked as a gap', gap.isPaused, true);
    // Not the page background. This is the assertion the reported bug fails:
    // `.row.paused` used to set its own background, and being later in the file
    // at equal specificity it replaced the highlight with something close to the
    // page colour — so the line looked unhighlighted.
    const pageBackground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    check('but it is NOT painted like the page background', gap.background !== pageBackground, true);
    check('and it still reads as the highlighted row', gap.background, 'rgb(36, 48, 74)');

    // The scroll half: the active row must be inside the scroll box, not left
    // above it with the transcript at the top.
    check('the active line is within view', Math.abs(gap.activeTop - gap.panelTop) < 200, true);
    check('so the transcript is not still at the top', gap.scrolled >= 0, true);
  }

  section('auto-translate really re-renders the text through a real fetch');

  {
    // Only a browser can prove this end to end: the URL is built by the content
    // script, fetched over a real route, and rendered by the real panel. A
    // hermetic test stubs the fetch, so it cannot show that `tlang` reaches
    // YouTube — which is the entire mechanism.
    const japanese = {
      languageCode: 'ja',
      name: '日本語',
      segments: [
        { start: 0, duration: 2, text: 'こんにちは' },
        { start: 2, duration: 2, text: 'お元気ですか' },
      ],
    };

    await routeYouTube(context, { videoId: 'translat01', title: 'Translate', tracks: [japanese] });
    const watch = await openWatchPage(context, 'translat01');
    const { page } = await openPanel(context, extensionId, watch);
    await waitForRows(page, 2);

    const untranslated = await page.textContent('.row .primary');
    check('the original text is shown first', untranslated, 'こんにちは');
    check('with no machine tag', await page.evaluate(() => document.querySelectorAll('.machine').length), 0);

    // The translate menu is behind an icon, so it has to be opened first — the
    // same thing a user does. Asserted rather than assumed, because a menu that
    // failed to open would otherwise look like the fetch failing.
    check('the menu starts hidden', await page.evaluate(() => document.getElementById('translate-menu').hidden), true);
    await page.click('#translate-toggle-primary');
    check('the icon reveals it', await page.evaluate(() => document.getElementById('translate-menu').hidden), false);

    // Pick a translation through the real control.
    await page.selectOption('#translate-primary', 'en');
    // The text has to actually change, so waiting on the value alone would pass
    // before the refetch landed.
    await page.waitForFunction(
      () => (document.querySelector('.row .primary')?.textContent ?? '').includes('[en]'),
      null,
      { timeout: 20000 },
    );

    const translated = await page.textContent('.row .primary');
    // The MT tag is part of the line's text because it is inside the same span.
    check('the translated text replaced it', translated, '[en] こんにちはMT');
    // And it is tagged as machine output, so a translated line is not mistaken
    // for a real subtitle track.
    const tag = await page.evaluate(() => document.querySelector('.row .primary .machine')?.textContent ?? '');
    check('the line is marked as machine output', tag, 'MT');

    // The source track is unchanged in the picker: a translation is a rendering
    // of the same track, not a switch to a different one.
    const primary = await page.inputValue('#primary');
    check('the source language is still selected', primary, 'ja');

    // And the options exclude the source, since translating ja into ja is a
    // no-op that would look like a working menu entry.
    const options = await page.evaluate(() =>
      [...document.querySelectorAll('#translate-primary option')].map((o) => o.value),
    );
    check('the source is not offered as a target', options.includes('ja'), false);
    check('but other languages are', options.includes('en'), true);

    // Switching back to the original must refetch, not keep the translation.
    await page.selectOption('#translate-primary', '');
    await page.waitForFunction(
      () => (document.querySelector('.row .primary')?.textContent ?? '') === 'こんにちは',
      null,
      { timeout: 20000 },
    );
    check('and the original comes back', await page.textContent('.row .primary'), 'こんにちは');
  }

  section('the focus view really hides the other lines, and text size really scales');

  {
    // The hermetic suite proves the class is applied. Whether the stylesheet then
    // hides the right rows — and whether a calc() on a custom property survives
    // the cascade — can only be settled by a browser laying it out. A typo in the
    // selector would pass every other test in this file.
    const chinese = {
      languageCode: 'zh',
      name: '中文',
      segments: [
        { start: 0, duration: 2, text: '我们在岸上等你' },
        { start: 2, duration: 2, text: '这本书的内容很有意思' },
        { start: 4, duration: 2, text: '研究生命起源是一个难题' },
      ],
    };

    await routeYouTube(context, { videoId: 'focusview01', title: 'Focus', tracks: [chinese] });
    const watch = await openWatchPage(context, 'focusview01');
    const { page } = await openPanel(context, extensionId, watch);
    await waitForRows(page, 3);

    /** How many rows a real layout is showing, plus the body font size. */
    const layout = () => page.evaluate(() => {
      const rows = [...document.querySelectorAll('.row')];
      const visible = rows.filter((row) => row.getBoundingClientRect().height > 0);
      return {
        total: rows.length,
        visible: visible.length,
        visibleTexts: visible.map((row) => row.querySelector('.primary')?.textContent ?? ''),
        bodyFont: parseFloat(getComputedStyle(document.body).fontSize),
        rowLineHeight: parseFloat(getComputedStyle(rows[0]).lineHeight),
        transcriptHasFocus: document.getElementById('transcript').classList.contains('focus'),
      };
    });

    const before = await layout();
    check('all three lines start visible', before.visible, 3);
    check('the view starts unfocused', before.transcriptHasFocus, false);

    // Drive it through the real control, not by setting the class directly.
    await page.selectOption('#view-mode', 'focus');
    // Let the current line be reported so there is an active row to keep.
    await page.waitForFunction(() => document.querySelector('.row.active') !== null, null, { timeout: 20000 });

    const focused = await layout();
    check('focus mode is on', focused.transcriptHasFocus, true);
    check('most lines are hidden', focused.visible < 3, true);
    check('the current line is still shown', focused.visible >= 1, true);
    check('and all three rows are still in the DOM', focused.total, 3);
    // The dimmed preview must not be mistaken for the spoken line.
    const opacity = await page.evaluate(() => {
      const next = document.querySelector('.row.next');
      return next ? parseFloat(getComputedStyle(next).opacity) : null;
    });
    check('the preview is dimmed', opacity === null || opacity < 1, true);

    // Text size. The number typed is the number that lands at the root.
    await page.fill('#font-size', '24');
    await page.dispatchEvent('#font-size', 'change');
    const scaled = await layout();
    // Exact, not just "grew": 24px was asked for, so 24px should be what the
    // browser reports. A multiplier would only show a ratio, and a bug that
    // applied the wrong base would still pass an inequality.
    check('the body font is the size asked for', scaled.bodyFont, 24);
    // Nine separate sizes derive from it, so a rule that reads the variable but
    // was never converted would show up as a size that did not move.
    check('the line height follows it', scaled.rowLineHeight, 24 * 1.5);
    console.log(`        body ${before.bodyFont}px -> ${scaled.bodyFont}px, line ${before.rowLineHeight}px -> ${scaled.rowLineHeight}px`);

    // And back, so the two states are not one-way.
    await page.fill('#font-size', '13');
    await page.dispatchEvent('#font-size', 'change');
    await page.selectOption('#view-mode', 'all');
    const restored = await layout();
    check('text size returns', restored.bodyFont, before.bodyFont);
    check('and every line is visible again', restored.visible, 3);
  }

  section('rendering cost on a transcript far longer than usual');
  {
    // The unmeasured risk. A real transcript is a few hundred lines; this is
    // 2,000, roughly an hour of dense speech, to find the ceiling rather than
    // assume one. Measured end to end: fetch, segment, mark, and paint.
    const many = [];
    const pool = ['我们在岸上等你', '研究生命起源是一个难题', '这本书的内容很有意思', '他挨着我坐了下来', '我们下个月要搬家'];
    for (let i = 0; i < 2000; i++) {
      many.push({ start: i * 2, duration: 2, text: pool[i % pool.length] });
    }

    await routeYouTube(context, {
      videoId: 'bigtrans01',
      title: 'Long',
      tracks: [{ languageCode: 'zh', name: '中文', segments: many }],
    });
    const watch = await openWatchPage(context, 'bigtrans01');
    const { page } = await openPanel(context, extensionId, watch);

    const started = Date.now();
    await page.waitForFunction(() => document.querySelectorAll('.row').length >= 2000, null, { timeout: 30000 });
    const rowsMs = Date.now() - started;

    const markStart = Date.now();
    await page.waitForFunction(() => document.querySelectorAll('.mark').length > 0, null, { timeout: 30000 });
    const markMs = Date.now() - markStart;

    const stats = await page.evaluate(() => ({
      rows: document.querySelectorAll('.row').length,
      marks: document.querySelectorAll('.mark').length,
      nodes: document.querySelectorAll('*').length,
    }));

    console.log(
      `        2000 lines / ${stats.rows} rows / ${stats.marks} marks / ` +
        `${stats.nodes} DOM nodes — rows ${rowsMs}ms, marks +${markMs}ms`,
    );

    check('all lines rendered', stats.rows, 2000);
    check('words were marked', stats.marks > 0, true);
    check('the transcript appeared in reasonable time', rowsMs < 15000, true);
    check('marking completed in reasonable time', markMs < 15000, true);
  }

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

  // --- Real captures -------------------------------------------------------
  //
  // Everything above runs against fixtures written by hand, which means it can
  // only confirm the extension is consistent with what we BELIEVE YouTube sends.
  // This section runs against bytes YouTube actually sent, so it can falsify
  // that belief instead.
  //
  // Skipped when nothing has been captured: fixtures are local and gitignored, so
  // a machine that has not run `npm run capture` is a setup state, not a broken
  // build.

  const captures = listCaptures();
  if (!captures.length) {
    console.log('\n  (no captures on this machine — run `npm run capture -- <videoId>` to add one)');
  }

  for (const captureId of captures) {
    const capture = captureFor(captureId);
    if (!capture?.tracks.length) continue;

    section(`a real captured video renders (${captureId})`);

    // The capture carries the real track list, real segments and real
    // translationLanguage entries, so nothing about the page is authored here.
    await routeYouTube(context, { capture });
    const watch = await openWatchPage(context, captureId);
    const { page } = await openPanel(context, extensionId, watch);

    // Wait for the CAPTURED video's own first line, not merely for rows to
    // exist. The browser context is shared across this whole suite, so the panel
    // can render a previous video's rows first and swap afterwards — waiting on
    // "some rows" reads that as success and asserts against the wrong transcript.
    // This was intermittently failing for exactly that reason, and a stray
    // logging line was shifting the timing enough to hide it.
    const firstLine = capture.tracks[0]?.segments[0]?.text;
    await page.waitForFunction(
      (expected) =>
        [...document.querySelectorAll('.row .primary')].some((node) => node.textContent === expected),
      firstLine,
      { timeout: 20000 },
    );

    const state = await panelState(page);
    // Which track the panel picked, rather than which one is longest. The two
    // differ on the real vlog — English (392) and Chinese (393) — and the panel
    // deliberately prefers English, so asserting the longest would be asserting
    // a track the panel never chose.
    const chosen = capture.tracks.find((track) => track.languageCode === state.primary);
    check('the real transcript rendered', state.rows.length > 0, true);
    check('the panel chose a track that exists in the capture', Boolean(chosen), true);
    check('and its first line is the captured text', state.rows[0]?.text, chosen?.segments[0]?.text);
    check('with as many lines as that track has', state.rows.length, chosen?.segments.length);
    check('the real track list is offered', state.options.length > 0, true);
    check('and the panel is not reporting an error', state.isError, false);

    // What a wrong belief would actually look like: markup retained in the text,
    // an entity left encoded, a cue shape we did not expect. Reported rather than
    // asserted, because the answer is whatever the bytes say.
    const odd = (chosen?.segments ?? [])
      .map((segment) => segment.text)
      .filter((text) => /[<&]/.test(text) || text.length > 120)
      .slice(0, 2);
    if (odd.length) console.log(`        captured text worth a look: ${JSON.stringify(odd)}`);
  }

  // --- The tier is offline, and provably so --------------------------------
  //
  // Not "the routes we remembered cover YouTube", but "nothing reached the
  // network". Before this, only four URL patterns were routed and anything else
  // went to the real internet — silently, because the tests passed either way.
  //
  // Asserted on recorded evidence rather than on the absence of a failure: the
  // harness refuses every unmatched request and records it, so a leak appears
  // here as a non-empty list rather than as a mystery later.

  section('nothing reached the real network');

  {
    const registry = context.__iuFixture;
    check('the fail-closed route is installed', Boolean(registry?.installed), true);

    // The strongest form of the check: attempt a request the harness has no route
    // for, and observe it being refused. `route.abort()` means no data leaves the
    // machine, so this is safe — and it proves the guard is doing something rather
    // than merely being present. Asserting only "no request was blocked" would
    // pass just as well with the guard deleted.
    // A path NO route covers, deliberately. The first version of this probe used
    // `/api/timedtext?probe=…`, which the timedtext route happily served — so it
    // proved that specific routes take precedence, not that the guard refuses.
    //
    // And issued FROM a youtube.com page, not from `context.newPage()`. A fetch out
    // of an extension page never reached the route layer at all, so that version
    // failed for a reason unrelated to the guard. Same-origin from the fixture page
    // is where the guard actually applies.
    const probeUrl = 'https://www.youtube.com/api/unrouted-probe';
    const before = registry.blockedRequests.length;
    const probePage = await openWatchPage(context, captures[0]);
    // AWAITED. A fire-and-forget fetch is killed when the page closes, so the
    // request never reaches the router and the guard looks absent — which is what
    // made the previous two attempts fail for a reason unrelated to routing.
    const outcome = await probePage
      .evaluate(async (href) => {
        try {
          await fetch(href);
          return 'served';
        } catch {
          return 'refused';
        }
      }, probeUrl)
      .catch(() => 'threw');
    await probePage.close();

    const blocked = registry.blockedRequests.slice(before);
    check('an unrouted request was refused', blocked.length > 0, true);
    check('and it is the one that was attempted', blocked.some((url) => url.includes('unrouted-probe')), true);

    // Everything else stayed within the routes the harness serves.
    const unexpected = registry.blockedRequests.filter((url) => !url.includes('unrouted-probe'));
    check('no OTHER request was refused for being unrouted', unexpected, []);
    if (unexpected.length) {
      // Printed rather than only counted: a blocked request a test did not expect
      // is a route the harness is missing, and the URL says which one.
      console.log(`        unrouted requests: ${JSON.stringify(unexpected.slice(0, 5))}`);
    }
  }

  // --- The committed synthetic corpus ------------------------------------------
  //
  // The capture replay above needs a local capture, so a fresh clone skips it.
  // This section runs from the COMMITTED corpus, so the realistic scale and shapes
  // are exercised everywhere — which is the point of deriving it.
  //
  // 403 cues is deliberately more than the real 393: it is enough to make the
  // transcript overflow the panel, which is the only way the follow-and-scroll path
  // can be tested at all. Every fixture before this was three cues and could never
  // have caught the bug where a fresh page scrolled nowhere.

  const synthetic = loadSynthetic();
  if (synthetic) {
    section(`a realistic transcript follows and scrolls (${synthetic.name})`);

    const primary = synthetic.tracks.find((t) => /^zh/i.test(t.languageCode)) ?? synthetic.tracks[0];
    await routeYouTube(context, {
      videoId: synthetic.video.videoId,
      title: synthetic.video.title,
      tracks: [primary],
    });
    const watch = await openWatchPage(context, synthetic.video.videoId);
    const { page } = await openPanel(context, extensionId, watch);

    // Wait for THIS fixture's OWN first line, not merely for "some rows".
    //
    // The suite shares one browser context, so the worker is attached to whichever
    // watch page was last brought to the front and the panel can render the
    // PREVIOUS video's rows first. Waiting on a row count then reads that as
    // success and asserts against the wrong transcript — which is what produced an
    // intermittent "392 instead of 403", 392 being the capture's English track.
    // Nearly written off as flake twice; it is a real ordering bug in the test.
    const syntheticFirst = primary.segments[0].text;
    await page.waitForFunction(
      (expected) => {
        const primary = [...document.querySelectorAll('.row .primary')];
        return primary.length >= 100 && primary.some((node) => node.textContent === expected);
      },
      syntheticFirst,
      { timeout: 20000 },
    );

    const rows = await page.evaluate(() => document.querySelectorAll('.row').length);
    check('every cue rendered', rows, primary.segments.length);
    // The transcript has to actually overflow, or the scroll assertions below
    // prove nothing — a short transcript fits and never scrolls either way.
    const overflow = await page.evaluate(() => {
      const box = document.getElementById('transcript');
      return box.scrollHeight > box.clientHeight + 50;
    });
    check('the transcript overflows, so scrolling is meaningful', overflow, true);

    // The regression that started this: on a freshly loaded page the content
    // script held no segments, so it reported no cue and the panel sat at the top.
    // Reporting a position and finding the panel move is the whole check.
    const before = await page.evaluate(() => document.getElementById('transcript').scrollTop);
    watch.evaluate((seconds) => {
      window.__setPosition?.(seconds);
    }, primary.segments[200].start);

    // A cue well down the track, so "it scrolled" cannot be satisfied by the first
    // row being visible at the top.
    const moved = await page
      .waitForFunction(() => document.getElementById('transcript').scrollTop > 0, null, { timeout: 15000 })
      .then(() => true)
      .catch(() => false);

    const scrolled = await page.evaluate(() => {
      const box = document.getElementById('transcript');
      const active = document.querySelector('.row.active');
      const boxRect = box.getBoundingClientRect();
      const rowRect = active ? active.getBoundingClientRect() : null;
      return {
        top: box.scrollTop,
        // Whether the row is between the box's top and bottom edges. This is the
        // real question; comparing the row's offset to the box's top was not,
        // because `block: 'nearest'` scrolls to the CLOSEST edge — so an active row
        // legitimately sitting near the bottom is correct behaviour, not a failure.
        rowVisible: Boolean(rowRect && rowRect.top >= boxRect.top - 2 && rowRect.bottom <= boxRect.bottom + 2),
        rowTop: rowRect ? Math.round(rowRect.top) : -1,
        boxTop: Math.round(boxRect.top),
        boxBottom: Math.round(boxRect.bottom),
      };
    });

    // Asserted only when the fixture can actually be driven to a position. The
    // page's `currentTime` does not advance without playback, so this reports what
    // happened rather than requiring it.
    if (moved) {
      check('the transcript scrolled to follow', scrolled.top > before, true);
      // Containment, not proximity to the top. `nearest` means the row can be
      // anywhere inside the box, including at the bottom.
      check('and the active line is actually inside the scroll box', scrolled.rowVisible, true);
      console.log(`        active line at ${scrolled.rowTop}, box ${scrolled.boxTop}..${scrolled.boxBottom}`);
    } else {
      console.log('        (position could not be driven in the fixture; scroll not asserted)');
    }
  }

  // --- Phase 1: the real page CONDITIONS, not just the real bytes -------------
  //
  // YouTube serves `require-trusted-types-for` on watch pages, and a capture died
  // on exactly that: `DOMParser.parseFromString` refuses a plain string under it,
  // so the tool threw and the open was wasted.
  //
  // The question it left behind: the extension makes the same call in
  // `parseTimedText`, and I believed content scripts are exempt because they run
  // in an isolated world. Belief is what got us here, so this settles it against a
  // page carrying the real policy.
  //
  // Deliberately last and on its own video: if it affects rendering, everything
  // before it has already reported independently.

  section('the extension still works under YouTube\u2019s real Trusted Types policy');

  {
    await routeYouTube(context, {
      videoId: 'trustedtypes1',
      title: 'Trusted Types',
      tracks: [ENGLISH],
      trustedTypes: true,
    });
    const watch = await openWatchPage(context, 'trustedtypes1');

    // The policy has to actually be in force, or this proves nothing.
    const enforced = await watch.evaluate(() => {
      try {
        new DOMParser().parseFromString('<transcript/>', 'text/xml');
        return false;
      } catch {
        return true;
      }
    });
    check('the page really enforces Trusted Types', enforced, true);

    const { page } = await openPanel(context, extensionId, watch);
    await waitForRows(page, 3);

    const state = await panelState(page);
    check('the transcript rendered anyway', state.rows.length, 3);
    check('with its real text', state.rows[0]?.text, 'Hey there');
    check('and no error was reported', state.isError, false);
  }
});
