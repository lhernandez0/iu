/**
 * Derive the committed synthetic corpus from a local real capture.
 *
 *   node tools/derive-synthetic.mjs [videoId]
 *
 * Reads `test/fixtures/<id>/normalised/` and writes `test/synthetic/<name>/`.
 * The input is LOCAL and gitignored; the output is committed. That split is the
 * point: the real capture tells us what YouTube's shapes actually are, and the
 * committed corpus is our own invented content wearing those shapes.
 *
 * Why invented content: the capture is a real video's transcript. Committing it
 * would redistribute someone's work, and it would make every test depend on one
 * specific video. Invented text has no such problem.
 *
 * Why the shapes are real: this is the entire lesson of a long session. Every
 * fixture in the suite was written by hand from an idea of what YouTube sends, so
 * the tests could only ever confirm the idea. Thirteen bugs were reported from use
 * and not one was found by the suite. A synthetic fixture is only worth having if
 * its shape came from somewhere real.
 *
 * So the DIMENSIONS are measured, not chosen:
 *
 *   cue count      403, the real 393, plus margin, so a scroll-into-view test
 *                  has somewhere to scroll
 *   durations      0.27s to 4.72s, median 1.77s
 *   gaps           0.00s to 31.71s, because the real track has a 31s silence in
 *                  it and a fixture that tiles its cues perfectly would never
 *                  exercise the paused-in-a-gap path at all
 *   timings        3 decimal places, starting at 37.933s, the real track does not
 *                  start at zero, and code that assumes it does is wrong
 *   track kinds    null, because on this video BOTH tracks report null even though
 *                  `caps=asr` is in their URLs. A fixture claiming `kind: 'asr'`
 *                  would be describing something YouTube did not send
 *   region codes   `zh-Hans`, not `zh`
 *
 * The text is written to contain the shapes that matter and are otherwise hard to
 * get: Latin mixed into Chinese, punctuation, digits, a long line, an empty-ish
 * line, and a burst of short cues.
 */

import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(ROOT, 'test', 'fixtures');
const SYNTHETIC = join(ROOT, 'test', 'synthetic');

/**
 * The title every synthetic fixture carries.
 *
 * One constant, because two files hold a title, `video.json` and
 * `player-response.json`, and they disagreed: the response held the REAL video's
 * title while `video.json` said this. A corpus whose files contradict each other
 * about whether it is synthetic is worse than either answer on its own, and the
 * real title is someone else's words in a committed file.
 */
const SYNTHETIC_TITLE = 'Synthetic fixture derived from a real capture';

/** Measured from the real capture; see the header. */
const SHAPE = {
  cueCount: 403,
  minDuration: 0.27,
  maxDuration: 4.72,
  medianDuration: 1.77,
  longGapSeconds: 31.71,
  startOffsetSeconds: 37.933,
  decimalPlaces: 3,
};

/**
 * Chinese lines for the synthetic track.
 *
 * Deliberately ordinary speech, invented, covering the character classes the
 * segmenter and the highlighter have to cope with: multi-character compounds,
 * single characters, mixed Latin, digits, punctuation, and a repeated word so the
 * "same text, same tokens" carry-over path is exercised.
 */
const CHINESE_LINES = [
  '大家早安',
  '今天我要带大家一起去看看',
  '这家店开了三十年了',
  '老板说，每天早上六点就开始准备',
  '我们先点了一份肠粉',
  '味道真的很不错',
  '价格也很便宜，只要十二块钱',
  '接着我们又去了隔壁那家',
  '排队的人特别多',
  '等了大概二十分钟才轮到我们',
  '朋友推荐我尝尝他们的招牌菜',
  '看起来就很有食欲',
  '第一口下去，感觉非常惊喜',
  '口感层次很丰富',
  '我们还点了两杯冻柠茶',
  '一杯八块，算是正常价位',
  '下午去了附近的公园散步',
  '天气很好，阳光也不刺眼',
  '很多人在那边跑步和遛狗',
  '我们找了个长椅坐下来休息',
  '顺便聊聊最近的工作',
  '他说下个月打算换一份新工作',
  '我祝他一切顺利',
  '晚上回家的路上还在想今天吃的那些东西',
  '下次一定要带家里人再来一次',
  '谢谢大家看到这里',
  '记得点赞和订阅',
  '我们下期再见',
  '今天先到这里',
  '这条街其实还有很多小店值得逛',
  '时间不太够，只能留到下次',
  '路上遇到一个卖水果的摊子',
  '芒果看起来特别新鲜',
  '买了两斤，一共十五块',
  '老板娘还多送了我们一个橘子',
  '这种人情味在大城市里不太常见',
  '地铁站出口旁边新开了一家面包店',
  '橱窗里的可颂烤得金黄',
  '忍不住进去买了一个',
  '外皮酥脆，里面很软',
  '配上一杯美式刚刚好',
  '周末的早晨就应该这样过',
  '你们那边的早餐一般吃什么',
  '欢迎在评论区告诉我',
  '我会挑几条回复',
  '这家店其实是我小时候常来的',
  '老板还记得我的名字',
  '感觉时间过得真快',
  '一转眼已经这么多年了',
];

/**
 * English for the Chinese track, **one line per Chinese line, in the same order**.
 *
 * This is a translation, not decoration: entry `n` here says what
 * `CHINESE_LINES[n]` says. That is what a bilingual transcript IS, and the preview
 * could not show whether alignment worked while the second line was unrelated
 * prose, which is what it was before this was rewritten. The three `one two three`,
 * `this is a long line` and `x` entries are gone with it: they were there to make
 * the layout wrap, and they broke the sense at every third cue. Layout stress
 * belongs in a line that still means something, and several below are deliberately
 * long or short for exactly that reason.
 *
 * The two lists are the SAME LENGTH on purpose. `padLines` no longer has to hide a
 * mismatch, so a line added here without one there is a one-for-one edit that
 * cannot silently shift every pair after it.
 */
const ENGLISH_LINES = [
  'Good morning everyone',
  'Today I am taking you all to have a look',
  'This shop has been open for thirty years',
  'The owner says they start preparing at six every morning',
  'We ordered a rice roll first',
  'It really tasted good',
  'Cheap too, only twelve yuan',
  'Then we went to the one next door',
  'The queue was especially long',
  'We waited about twenty minutes for our turn',
  'A friend recommended I try their signature dish',
  'It looked appetising straight away',
  'The first bite was a real surprise',
  'The texture had a lot of layers',
  'We also ordered two iced lemon teas',
  'Eight yuan a cup, a normal price',
  'In the afternoon we walked in the nearby park',
  'The weather was good and the sun was not harsh',
  'Lots of people were running and walking dogs there',
  'We found a bench and sat down to rest',
  'And talked about work for a while',
  'He says he plans to change jobs next month',
  'I wished him all the best',
  'On the way home I was still thinking about what we ate today',
  'Next time I must bring the family again',
  'Thanks everyone for watching this far',
  'Remember to like and subscribe',
  'See you next time',
  'That is all for today',
  'This street actually has many more small shops worth a look',
  'Not enough time, we can only leave it for next time',
  'On the way we passed a fruit stall',
  'The mangoes looked especially fresh',
  'Bought two jin, fifteen yuan in total',
  'The owner even gave us an extra orange',
  // The real English track carries 161 `&amp;` entities, genuine ampersands YouTube
  // escapes in XML and leaves bare in JSON3, and a corpus with none of them cannot
  // exercise the decoding path at all. Kept INSIDE a line that still translates the
  // Chinese one beside it, rather than as the standalone padding cue it used to be.
  'You do not see that warmth & friendliness much in a big city',
  'A new bakery opened next to the subway exit',
  'The croissants in the window were baked golden',
  'Could not resist going in to buy one',
  'Crisp on the outside, very soft inside',
  'Just right with a cup of americano',
  'A weekend morning should be spent like this',
  'What do you usually eat for breakfast where you are',
  'Welcome to tell me in the comments',
  'I will pick a few replies',
  'This shop is one I used to come to as a child',
  'The owner still remembers my name',
  'It feels like time really flies',
  'In a blink it has been so many years',
];

/** Deterministic pseudo-random, so re-deriving produces an identical file. */
function makeRandom(seed) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

/** @param {number} value @returns {number} */
function round(value) {
  return Number(value.toFixed(SHAPE.decimalPlaces));
}

/**
 * Repeat a line list up to `count`, so a cue index is a list index.
 *
 * **This replaces `lines[i % lines.length]` at each track, which is what let two
 * lists of DIFFERENT lengths drift apart.** With 49 Chinese lines and 50 English
 * ones, English line `i` and Chinese line `i` stopped corresponding after the first
 * pass, and every later cue paired unrelated sentences. Padding removes the modulo
 * from the per-cue path entirely: both lists are exactly `count` long, so index `i`
 * is the same position in both, by construction.
 *
 * Repeating rather than truncating keeps the whole list in the fixture, which is
 * what makes a scroll-to-the-end test meaningful.
 *
 * @param {string[]} lines
 * @param {number} count
 * @returns {string[]}
 */
function padLines(lines, count) {
  if (!lines.length) return Array.from({ length: count }, () => '');
  return Array.from({ length: count }, (_, i) => lines[i % lines.length]);
}

/**
 * Build one track's cues, in the measured shape.
 *
 * **The timing is generated WITH the track that leads, and copied for every other
 * track, so the two tracks line up cue for cue.** They used to be built
 * independently: separate seeds for the duration/gap walk, and a separate
 * `lines[i % lines.length]` lookup. Three things then put a Chinese line and an
 * English line on the same cue that said completely different things:
 *
 *   - the two line lists had different lengths (49 and 50), so the modulo drifted
 *     by one line per pass and every cue after the first pass was one line out;
 *   - each track walked its own random durations and gaps, so the cue TIMES
 *     differed too, and same-index cues were not even simultaneous;
 *   - the English list carried three deliberate padding lines (a run of number
 *     words, a very long line, and a one-character line) to exercise wrapping,
 *     which shifted everything after them by three.
 *
 * A bilingual transcript with a second line is the whole point of this viewer, and
 * a fixture where the translation does not translate anything is a fixture that
 * cannot show whether alignment works. So timing and index come from ONE track and
 * the others follow; alignment is now true by construction, not by luck.
 *
 * @param {string[]} lines
 * @param {number} count
 * @param {number} seed
 * @param {Array<{start: number, duration: number}>} [timing] Reuse these times instead
 *   of generating new ones, so a gloss track sits exactly where the study track does.
 * @returns {Array<{start: number, duration: number, text: string}>}
 */
function buildCues(lines, count, seed, timing = null) {
  const random = makeRandom(seed);
  const cues = [];
  let cursor = SHAPE.startOffsetSeconds;

  for (let i = 0; i < count; i++) {
    // A track that FOLLOWS another reuses its timing exactly, so the two are
    // simultaneous. A track that LEADS generates the measured spread.
    let start;
    let duration;
    if (timing) {
      const shared = timing[i % timing.length];
      start = shared.start;
      duration = shared.duration;
    } else {
      // Duration spread across the FULL measured range, not clustered near the
      // median. An earlier version weighted everything toward 1.5–2.8s, which
      // looked plausible and quietly meant the fixture never contained a cue as
      // short as the real 0.27s or as long as its 4.72s, so nothing that breaks on
      // very short or very long cues could have been caught. The range is the
      // finding; the shape has to cover it.
      //
      // Every fourth cue is deliberately an extreme, so the ends of the range are
      // present in a fixture of 403 rather than only in principle.
      const extreme = i % 4 === 0;
      const t = extreme ? (i % 8 === 0 ? 0 : 1) : random();
      duration = round(SHAPE.minDuration + t * (SHAPE.maxDuration - SHAPE.minDuration));
      start = round(cursor);

      // Mostly contiguous, which is what real captions are. The long gap is placed
      // once, in the middle, because a track with no gap never reaches the code
      // that holds the previous line and dims it.
      const gap = i === Math.floor(count / 2) ? SHAPE.longGapSeconds : round(random() * 0.8);
      cursor = round(cursor + duration + gap);
    }

    // `lines` is padded to `count` by the caller, so the index is the CUE index.
    // Wrapping with a modulo was what let a 49-line list and a 50-line list drift
    // apart; a padded list cannot.
    cues.push({ start, duration, text: lines[i] });
  }

  return cues;
}

/**
 * The player response a capture actually contains, reduced to the fields we read.
 *
 * Shape comes from the capture's own renderer keys, `audioTracks`,
 * `captionTracks`, `defaultAudioTrackIndex`, `translationLanguages`, because a
 * fixture missing `defaultAudioTrackIndex` describes a payload YouTube does not
 * send, and nothing would notice.
 *
 * The title is OURS, not the capture's. It used to be copied verbatim, which put a
 * real video's title, someone else's words, naming a specific trip, into a
 * committed file, while the sibling `video.json` said "Synthetic fixture derived
 * from a real capture". The corpus is our invented text wearing a real shape; the
 * title should follow the same rule as the cues.
 *
 * @param {object} capture Parsed normalised video + captions.
 * @returns {object}
 */
function buildPlayerResponse(capture) {
  const buildName = (name) => ({ simpleText: name });

  return {
    videoDetails: {
      videoId: capture.videoId,
      title: SYNTHETIC_TITLE,
      isLiveContent: false,
    },
    captions: {
      playerCaptionsTracklistRenderer: {
        // Present in the real renderer. Empty here because we have no real audio
        // track data, but the KEY has to exist, its absence is a shape difference.
        audioTracks: [],
        defaultAudioTrackIndex: 0,
        captionTracks: capture.tracks.map((track) => ({
          baseUrl: `https://www.youtube.com/api/timedtext?v=${capture.videoId}&lang=${track.languageCode}&fmt=srv3`,
          name: buildName(track.name),
          vssId: track.kind === 'asr' ? `a.${track.languageCode}` : `.${track.languageCode}`,
          languageCode: track.languageCode,
          // null on this video, and that is the finding: both tracks are `caps=asr`
          // in their URLs yet neither reports `kind`. Sending 'asr' here would
          // describe something YouTube did not.
          kind: track.kind ?? undefined,
          isTranslatable: Boolean(track.isTranslatable),
          trackName: '',
        })),
        translationLanguages: capture.translationLanguages.map((language) => ({
          languageCode: language.languageCode,
          languageName: { runs: [{ text: language.name }] },
        })),
      },
    },
  };
}

// --- Run ---------------------------------------------------------------------

const requested = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const videoIds = requested.length
  ? requested
  : existsSync(FIXTURES)
    ? readdirSync(FIXTURES, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name)
    : [];

// A failed capture leaves `<id>.partial/` beside the good one. It is not a
// capture: it holds however much was fetched before the failure. Deriving a corpus
// from it would bake a truncated run into the committed fixtures, so it is left
// out of the automatic list, but it is reported, because its existence means a
// shot was spent and its bodies are worth looking at.
const partials = videoIds.filter((id) => id.endsWith('.partial'));
const complete = videoIds.filter((id) => !id.endsWith('.partial'));

if (!complete.length) {
  console.error('No captures found. Run `npm run capture` once, first.');
  console.error('This tool reads test/fixtures/ and writes test/synthetic/.');
  if (partials.length) {
    console.error(`\nOnly partial results are present: ${partials.join(', ')}.`);
    console.error('A partial is a failed run, not a capture, derive from a complete one.');
  }
  process.exit(1);
}

console.log(`\nDeriving synthetic fixtures, reads local captures, opens nothing\n`);
if (partials.length) {
  console.log(`  note: partial results present, not used: ${partials.join(', ')}`);
  console.log('        a partial is a failed run; inspect it, but do not derive from it.\n');
}

for (const videoId of complete) {
  const dir = join(FIXTURES, videoId, 'normalised');
  if (!existsSync(join(dir, 'video.json'))) {
    console.log(`  ${videoId}: no capture, skipping`);
    continue;
  }

  const video = JSON.parse(readFileSync(join(dir, 'video.json'), 'utf8'));
  const tracks = [];
  const formatsSeen = new Set();
  for (const track of video.trackList ?? []) {
    const suffix = track.kind === 'asr' ? '-asr' : '';
    const file = join(dir, `captions-${track.languageCode}${suffix}.json`);
    const stored = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
    const real = stored?.segments ?? [];
    if (stored?.shape) formatsSeen.add(stored.shape);
    tracks.push({
      ...track,
      // Kept as a fact about the real track, not used as fixture text.
      realSegmentCount: real.length,
      // What the body actually was, so the report can say whether a real XML body
      // has ever been seen rather than implying coverage it does not have.
      realShape: stored?.shape ?? null,
      // The real track's measured duration range, so a reviewer can confirm the
      // synthetic cues sit inside it.
      realDurationRange: real.length
        ? [Math.min(...real.map((s) => s.duration)), Math.max(...real.map((s) => s.duration))]
        : null,
    });
  }

  // The gap that must not be papered over. The normalised file records the shape
  // the body actually had; if every one is json3, the XML parser has still only
  // ever run against XML we built ourselves, and the report must say so.
  const sawRealXml = formatsSeen.has('xml');

  // When a real XML body IS present, read its structure from the captured bytes
  // rather than from an idea of what XML looks like. This is the whole point of
  // capturing: the shape in the report has to trace to a response, not to a guess.
  // The viewer reconstructs the raw filename from the normalised entry's own
  // fields (language, client, format), so nothing extra has to be captured.
  //
  // Per track, not just the first. The two tracks differ in a way that matters,
  // one carries entities and the other does not, and reporting only the first
  // would hide exactly the evidence that tells us what the parser must handle.
  const xmlShape = sawRealXml
    ? {
        rootTag: null,
        cueTag: null,
        attributes: null,
        tracks: {},
      }
    : null;
  if (sawRealXml) {
    for (const track of tracks) {
      const suffix = track.kind === 'asr' ? '-asr' : '';
      const storedJson = join(dir, `captions-${track.languageCode}${suffix}.json`);
      if (!existsSync(storedJson)) continue;
      const stored = JSON.parse(readFileSync(storedJson, 'utf8'));
      if (stored.shape !== 'xml') continue;
      const rawFile = join(FIXTURES, videoId, 'raw', `captions-${track.languageCode}-${stored.source}-${stored.format}.txt`);
      if (!existsSync(rawFile)) continue;
      const body = readFileSync(rawFile, 'utf8');
      const tags = [...body.matchAll(/<([a-zA-Z][\w-]*)/g)].map((m) => m[1]);
      const cueTag = tags.find((t) => t !== tags[0]) ?? null;
      const firstCue = cueTag ? body.match(new RegExp(`<${cueTag}\\s+([^>]*)>`)) : null;
      const attributes = firstCue ? [...firstCue[1].matchAll(/([\w-]+)="/g)].map((m) => m[1]) : [];
      xmlShape.rootTag ??= tags[0] ?? null;
      xmlShape.cueTag ??= cueTag;
      xmlShape.attributes ??= attributes;
      xmlShape.tracks[track.languageCode] = {
        rootTag: tags[0] ?? null,
        cueTag,
        attributes,
        cueCount: cueTag ? (body.match(new RegExp(`<${cueTag}[\\s>]`, 'g')) ?? []).length : 0,
        entityCount: (body.match(/&[a-zA-Z]+;|&#\d+;/g) ?? []).length,
        // Elements opening inside a cue's text, i.e. markup nested in the content.
        nestedElementCount: cueTag
          ? (body.match(new RegExp(`<${cueTag}\\b[^>]*>[^<]*<(?!/?${cueTag})`, 'g')) ?? []).length
          : 0,
      };
    }
  }

  // **One track leads, the rest follow its timing.** Chinese is the study track on
  // this capture, so it generates the measured durations and gaps, and every other
  // track reuses them cue for cue. That makes the two lines SIMULTANEOUS, which is
  // what a bilingual transcript is for; generating them independently produced
  // same-index cues whose times and meanings had nothing to do with each other.
  const leadLanguage = tracks.find((t) => /^zh/i.test(t.languageCode))?.languageCode
    ?? tracks[0]?.languageCode
    ?? '';
  const leadTiming = buildCues(padLines(CHINESE_LINES, SHAPE.cueCount), SHAPE.cueCount, 1001).map(
    ({ start, duration }) => ({ start, duration }),
  );

  const cuesFor = (languageCode) => {
    const lines = /^zh/i.test(languageCode) ? CHINESE_LINES : ENGLISH_LINES;
    const padded = padLines(lines, SHAPE.cueCount);
    // The lead track owns the timings; the rest reuse them.
    return languageCode === leadLanguage
      ? buildCues(padded, SHAPE.cueCount, 1001)
      : buildCues(padded, SHAPE.cueCount, 2002, leadTiming);
  };

  // **A video id of its OWN, and it names the output too.** Two reasons, and the
  // second is a leak guard.
  //
  // Reusing the real id meant the synthetic fixture and the local capture registered
  // the SAME video in the browser tier's route registry, so both sections fought over
  // one key and the panel could render either, which showed up as an intermittent "392
  // cues instead of 403" and very nearly got written off as flake.
  //
  // And the directory and the `derivedFrom` fields are COMMITTED, while the capture
  // they come from is gitignored. Naming either after the real id therefore puts a
  // real video's identifier into the repository, which is what `test/history.test.mjs`
  // exists to catch. This tool used to do exactly that, so deriving a corpus re-leaked
  // the id the last rewrite had removed. The real id is used only to READ the capture;
  // nothing written out of this tool may carry it.
  const fixtureId = `iuSynthetic${videoId.slice(-3)}`;

  const name = `capture-${fixtureId}`;
  const out = join(SYNTHETIC, name);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  for (const track of tracks) {
    const cues = cuesFor(track.languageCode);
    const file = `captions-${track.languageCode}${track.kind === 'asr' ? '-asr' : ''}.json`;
    await writeFile(
      join(out, file),
      `${JSON.stringify(
        {
          languageCode: track.languageCode,
          kind: track.kind,
          // Says plainly that the text is ours. A fixture whose provenance is
          // unclear is a fixture nobody can safely change.
          text: 'synthetic',
          derivedFrom: fixtureId,
          shape: { cueCount: SHAPE.cueCount, note: 'durations, gaps and offsets measured from the real capture' },
          segments: cues,
        },
        null,
        2,
      )}\n`,
    );
  }

  await writeFile(
    join(out, 'player-response.json'),
    `${JSON.stringify(buildPlayerResponse({ ...video, videoId: fixtureId, tracks }), null, 2)}\n`,
  );

  await writeFile(
    join(out, 'video.json'),
    `${JSON.stringify(
      {
        videoId: fixtureId,
        title: SYNTHETIC_TITLE,
        isLive: false,
        text: 'synthetic',
        derivedFrom: fixtureId,
        derivedAt: new Date().toISOString(),
        // The real values, kept because they ARE the shape: the language codes,
        // the track names, and all 156 translation languages. None of that is
        // content, it is the vocabulary YouTube used.
        trackList: tracks.map((t) => ({
          languageCode: t.languageCode,
          name: t.name,
          kind: t.kind,
          isTranslatable: t.isTranslatable,
          realSegmentCount: t.realSegmentCount,
          realDurationRange: t.realDurationRange,
        })),
        translationLanguages: video.translationLanguages,
      },
      null,
      2,
    )}\n`,
  );

  // The reviewable bridge. Every number here was measured, and this is the file a
  // reviewer reads to check that our invented fixtures have a real shape.
  await writeFile(
    join(out, 'shape-report.json'),
    `${JSON.stringify(
      {
        derivedFrom: fixtureId,
        derivedAt: new Date().toISOString(),
        note: 'Dimensions measured from the real capture; text invented. Compare against the local capture under test/fixtures/.',
        synthetic: SHAPE,
        measured: {
          trackList: video.trackList,
          translationLanguageCount: video.translationLanguages?.length ?? 0,
          // Whether a real (not self-built) XML caption body was ever captured.
          // False means the XML parser has only been exercised against XML derived
          // from JSON3, which is a real limitation and is recorded as one.
          realXmlBodySeen: sawRealXml,
          formatsSeen: [...formatsSeen],
          // Measured from the captured bytes when a real XML body exists, null
          // otherwise. Never synthesised: a shape report that invents the shape it
          // is meant to report on is worse than one that admits the gap.
          xml: xmlShape,
        },
      },
      null,
      2,
    )}\n`,
  );

  console.log(`  ${name}`);
  for (const track of tracks) {
    const range = track.realDurationRange ? `${track.realDurationRange[0]}–${track.realDurationRange[1]}s` : 'n/a';
    console.log(`    ${track.languageCode}: real had ${track.realSegmentCount} cues (${range}); wrote ${SHAPE.cueCount}`);
  }
  console.log(`    translation languages carried through: ${video.translationLanguages?.length ?? 0}`);
  if (!sawRealXml) {
    console.log('    note: no real XML caption body in this capture.');
    console.log('          the XML parser has still only seen XML we built from JSON3.');
  } else if (xmlShape) {
    const perTrack = Object.entries(xmlShape.tracks)
      .map(([lang, s]) => `${lang}: ${s.cueCount} cues, ${s.entityCount} entities`)
      .join('; ');
    console.log(`    real XML body: <${xmlShape.rootTag}>/<${xmlShape.cueTag}> attrs [${xmlShape.attributes.join(', ')}], ${perTrack}`);
  }
  console.log(`    wrote test/synthetic/${name}/`);
}

console.log('\nDone, synthetic fixtures are committed; the captures they came from are not.\n');
