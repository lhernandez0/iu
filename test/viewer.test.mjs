/**
 * The viewer's subtitle parsing.
 *
 * Pure functions, so these run hermetically with nothing installed, no browser,
 * no network, no fixtures on disk. That matters because this is where the
 * correctness risk is concentrated: the wiring either works or throws, but a
 * parser can be wrong in a way that produces a complete, plausible transcript of
 * the wrong thing.
 *
 * The case that justifies the whole file is the ENCODING one. A Chinese `.srt` is
 * very often GBK, and decoded as UTF-8 it does not fail, it yields U+FFFD that
 * parses cleanly into garbage. Everything looks like it worked. So the encoding
 * checks are written as "must NOT silently produce replacement characters" rather
 * than "must produce text", because producing text was never the hard part.
 *
 * Run: node test/reader.test.mjs
 */

import {
  parseSubtitles,
  detectFormat,
  parseTimestamp,
  decodeSubtitles,
  languageFromFileName,
} from '../src/viewer/subtitles.js';

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

/** @param {string} text */
const utf8 = (text) => new TextEncoder().encode(text);

section('timestamps parse in every separator the formats use');

{
  // SRT uses a comma, WebVTT a dot, and both turn up in the other's files.
  check('SRT comma form', parseTimestamp('00:02:17,440'), 137.44);
  check('WebVTT dot form', parseTimestamp('00:02:17.440'), 137.44);
  check('hours are optional', parseTimestamp('02:17.440'), 137.44);

  // The digit-count trap: `.5` is half a second, not five milliseconds. Padding
  // rather than truncating is what gets this right, and getting it wrong shifts a
  // cue by 495ms, small enough to look like a timing bug in the video.
  check('one fractional digit is tenths', parseTimestamp('00:00:01.5'), 1.5);
  check('two fractional digits are hundredths', parseTimestamp('00:00:01.05'), 1.05);
  check('three are milliseconds', parseTimestamp('00:00:01.005'), 1.005);

  check('over an hour', parseTimestamp('01:02:03.000'), 3723);
  check('rubbish is NaN rather than 0', Number.isNaN(parseTimestamp('not a time')), true);
}

section('format detection reads the body, not the extension');

{
  check('WEBVTT header', detectFormat('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi'), 'vtt');
  check('a VTT header with trailing text', detectFormat('WEBVTT - This file was edited'), 'vtt');
  check('ASS by its Script Info block', detectFormat('[Script Info]\nTitle: x'), 'ass');
  check('ASS by its Styles block alone', detectFormat('[V4+ Styles]\nFormat: Name'), 'ass');
  check('SRT by its arrow', detectFormat('1\n00:00:01,000 --> 00:00:02,000\nHi'), 'srt');
  check('a BOM does not confuse it', detectFormat('\uFEFFWEBVTT\n'), 'vtt');
  check('something else entirely', detectFormat('hello world'), null);
}

section('SRT');

{
  const srt = [
    '1',
    '00:00:01,000 --> 00:00:03,500',
    'Senator, we are making',
    'our final approach.',
    '',
    '2',
    '00:00:04,000 --> 00:00:06,000',
    'Very good, Lieutenant.',
    '',
  ].join('\n');

  const { segments, format, error } = parseSubtitles(utf8(srt));

  check('the format is recognised', format, 'srt');
  check('no error', error, null);
  check('both cues come through', segments.length, 2);
  check('the first cue starts at 1s', segments[0].start, 1);
  check('and lasts 2.5s', segments[0].duration, 2.5);
  // The multi-line body is the case a naive per-line parse gets wrong: it would
  // emit two cues, the second with no timing.
  check('a two-line cue stays one cue', segments[0].text, 'Senator, we are making\nour final approach.');
  check('the second cue is second', segments[1].text, 'Very good, Lieutenant.');
}

{
  // CRLF is the common real-world case, and a stray `\r` ends up inside the text
  // of a parser that splits on `\n` only.
  const crlf = '1\r\n00:00:01,000 --> 00:00:02,000\r\nHello\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nWorld\r\n';
  const { segments } = parseSubtitles(utf8(crlf));

  check('CRLF files parse', segments.length, 2);
  check('and carry no carriage return into the text', segments[0].text, 'Hello');
}

{
  // Cues out of order in the file. The panel's `findActiveIndex` walks backwards
  // from the end and would return the wrong line for every cue if this were left
  // as-is, so the parser sorts rather than trusting the file.
  const shuffled = '1\n00:00:10,000 --> 00:00:11,000\nSecond\n\n2\n00:00:01,000 --> 00:00:02,000\nFirst\n';
  const { segments } = parseSubtitles(utf8(shuffled));

  check('out-of-order cues are sorted', segments.map((s) => s.text), ['First', 'Second']);
}

section('WebVTT');

{
  const vtt = [
    'WEBVTT',
    '',
    'NOTE this is a comment block',
    'that spans two lines',
    '',
    '1',
    '00:00:01.000 --> 00:00:03.000 position:50% align:middle',
    '<v Speaker>Hello <c.yellow>world</c></v>',
    '',
    '00:00:04.000 --> 00:00:06.000',
    'Plain cue',
    '',
  ].join('\n');

  const { segments, format } = parseSubtitles(utf8(vtt));

  check('the format is recognised', format, 'vtt');
  check('the NOTE block is not a cue', segments.length, 2);
  // Cue settings after the end timestamp must not become part of the time, and
  // inline markup must not reach the text, angle brackets would break the word
  // segmenter on every affected line.
  check('cue settings are stripped from the timing', segments[0].duration, 2);
  check('inline tags are removed but the words stay', segments[0].text, 'Hello world');
  check('a cue with no tags is untouched', segments[1].text, 'Plain cue');
}

{
  // The bare-timestamp form inside cue text: `<00:00:15.000>` marks when the rest
  // becomes visible. It is markup, not a word.
  const { segments } = parseSubtitles(utf8('WEBVTT\n\n00:00:01.000 --> 00:00:05.000\nHello<00:00:02.000> world\n'));
  check('a bare cue timestamp is stripped', segments[0].text, 'Hello world');
}

section('ASS / SSA');

{
  const ass = [
    '[Script Info]',
    'Title: Example',
    'ScriptType: v4.00+',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize',
    'Style: Default,Arial,20',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:02:40.65,0:02:41.79,Default,Cher,0000,0000,0000,,The records of his delta waves?',
    'Dialogue: 0,0:02:42.42,0:02:44.15,Default,Other,0000,0000,0000,,Still nothing.',
    '',
  ].join('\n');

  const { segments, format } = parseSubtitles(utf8(ass));

  check('the format is recognised', format, 'ass');
  check('both dialogue lines are cues', segments.length, 2);
  // `0:02:40.65` is 2 minutes 40.65 seconds. The hour field is ONE digit in ASS,
  // and reading it with the SRT/WebVTT parser would give 2 seconds and 40.65,
  // a factor-of-60 error on every single line.
  check('ASS centiseconds are not milliseconds', segments[0].start, 160.65);
  check('and the duration follows', Math.round(segments[0].duration * 100) / 100, 1.14);
  check('the text field is read', segments[0].text, 'The records of his delta waves?');
}

{
  // The reason `Text` cannot be found by a fixed comma index: it is last, and it
  // legitimately contains commas. Splitting naively truncates every line at the
  // first one, which produces plausible-looking but wrong text.
  const ass = [
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Wait, what did you say?',
    '',
  ].join('\n');

  const { segments } = parseSubtitles(utf8(ass));
  check('commas inside the text survive', segments[0].text, 'Wait, what did you say?');
}

{
  // Override tags of every kind that appears in real files. None of these are
  // words, and any left in would be marked and looked up as vocabulary.
  const ass = [
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\pos(320,240)}{\\an8}Positioned',
    'Dialogue: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,{\\k50}Ka{\\k30}ra{\\k20}oke',
    'Dialogue: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,Line one\\NLine two',
    'Dialogue: 0,0:00:07.00,0:00:08.00,Default,,0,0,0,,{\\p1}m 0 0 l 100 0 100 100 0 100{\\p0}',
    '',
  ].join('\n');

  const { segments } = parseSubtitles(utf8(ass));

  check('positioning and alignment tags are stripped', segments[0].text, 'Positioned');
  check('karaoke tags are stripped', segments[1].text, 'Karaoke');
  check('a hard break becomes a newline', segments[2].text, 'Line one\nLine two');
  // A drawing block is vector commands. Letting it through puts coordinates in
  // the transcript as if they were words.
  check('a drawing block produces no cue at all', segments.length, 3);
}

{
  // `Comment:` lines are annotations and never displayed. Showing them would put
  // the translator's notes in the learner's transcript.
  const ass = [
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Comment: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,a translator note',
    'Dialogue: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,real subtitle',
    '',
  ].join('\n');

  const { segments } = parseSubtitles(utf8(ass));
  check('Comment lines are skipped', segments.length, 1);
  check('and the dialogue survives', segments[0].text, 'real subtitle');
}

section('the encoding trap, a wrong guess must be loud, not silent');

{
  // THE case this file exists for. These bytes are GBK for "你好，世界", the
  // kind of text a Chinese learner's subtitle files are full of. Decoded as
  // UTF-8 they do not throw: they become replacement characters, which parse
  // into a transcript of U+FFFD that looks like a successfully loaded file.
  const gbkBytes = new Uint8Array([0xc4, 0xe3, 0xba, 0xc3, 0xa3, 0xac, 0xca, 0xc0, 0xbd, 0xe7]);

  const { text, encoding, error } = decodeSubtitles(gbkBytes);

  check('GBK is detected rather than assumed', encoding, 'gbk');
  check('no error', error, null);
  // If this says "utf-8" and the text is replacement characters, the guard is
  // broken and the failure will only ever be visible to a user.
  check('and the text is the real characters', text, '你好，世界');
  check('with no replacement characters', text.includes('\uFFFD'), false);
}

{
  // The same trap through the full pipeline: a GBK SRT file must produce real
  // cue text, not replacement characters that parse cleanly.
  const gbk = new Uint8Array([
    // "1\n00:00:01,000 --> 00:00:02,000\n" in ASCII, then GBK "你好"
    0x31, 0x0a, 0x30, 0x30, 0x3a, 0x30, 0x30, 0x3a, 0x30, 0x31, 0x2c, 0x30, 0x30, 0x30, 0x20, 0x2d, 0x2d, 0x3e,
    0x20, 0x30, 0x30, 0x3a, 0x30, 0x30, 0x3a, 0x30, 0x32, 0x2c, 0x30, 0x30, 0x30, 0x0a, 0xc4, 0xe3, 0xba, 0xc3,
    0x0a,
  ]);

  const { segments, encoding, error } = parseSubtitles(gbk, 'film.zh.srt');

  check('a GBK SRT still parses', segments.length, 1);
  check('and reports the real encoding', encoding, 'gbk');
  check('the cue text is not mojibake', segments[0].text, '你好');
  check('and there is no error', error, null);
}

{
  // A UTF-8 BOM is not text. Left in, it becomes the first character of the first
  // cue and can suppress a word mark or break a dictionary lookup on line one.
  const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n')]);
  const { segments, encoding } = parseSubtitles(withBom);

  check('a UTF-8 BOM is consumed', encoding, 'utf-8');
  check('and does not leak into the text', segments[0].text, 'Hello');
}

section('failures are reported rather than returned as an empty transcript');

{
  // Each of these must be distinguishable. An empty transcript with no error is
  // indistinguishable from a video with no captions, which is the failure shape
  // the whole codebase designs against.
  const unknown = parseSubtitles(utf8('this is just a text file'), 'notes.txt');
  check('an unrecognised format names the problem', typeof unknown.error, 'string');
  check('and yields no segments', unknown.segments.length, 0);
  check('and reports no format', unknown.format, null);

  const empty = parseSubtitles(utf8('WEBVTT\n\nNOTE nothing here\n'), 'empty.vtt');
  check('a valid format with no cues is its own error', empty.error, 'that file has no subtitle cues in it');
  check('but still reports the format it found', empty.format, 'vtt');
}

section('language comes from the filename, and never by guessing');

{
  // A sidecar file has no language metadata, so the filename is all there is.
  check('a BCP-47 tag', languageFromFileName('film.zh-Hans.srt'), 'zh-Hans');
  check('a bare two-letter code', languageFromFileName('film.zh.srt'), 'zh');
  check('the ISO 639-2 form', languageFromFileName('film.zho.srt'), 'zho');
  check('Japanese', languageFromFileName('episode.ja.ass'), 'ja');
  check('an English gloss track', languageFromFileName('film.en.vtt'), 'en');

  // The reason it walks from the END: a release year is not a language, and
  // neither is the title. `film.2024.zh.srt` must read the language.
  check('a year is not mistaken for a language', languageFromFileName('film.2024.zh.srt'), 'zh');
  check('and a title is not either', languageFromFileName('Spirited.Away.ja.srt'), 'ja');

  // The important negative. `und` is undetermined, and the panel explains it.
  // Guessing English here would mark a Japanese film with the HSK list and look
  // like a bug in the marking rather than in the guess.
  check('nothing recognisable is undetermined, not English', languageFromFileName('film.srt'), 'und');
  check('a release tag is not a language', languageFromFileName('film.1080p.x264.srt'), 'und');
  check('and a bare word is not either', languageFromFileName('subtitles.srt'), 'und');
}

section('every supported format survives a round trip through the viewer path');

{
  // The three formats must agree about the same content, because the panel only
  // ever sees the parsed result and must not be able to tell them apart.
  const cases = {
    srt: '1\n00:00:01,000 --> 00:00:03,000\nHello there\n',
    vtt: 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello there\n',
    ass: '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Hello there\n',
  };

  const results = Object.entries(cases).map(([name, body]) => {
    const { segments } = parseSubtitles(utf8(body), `film.${name}`);
    return { name, start: segments[0]?.start, duration: segments[0]?.duration, text: segments[0]?.text };
  });

  check('all three agree on the start', results.map((r) => r.start), [1, 1, 1]);
  check('all three agree on the duration', results.map((r) => r.duration), [2, 2, 2]);
  check('all three agree on the text', results.map((r) => r.text), ['Hello there', 'Hello there', 'Hello there']);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exitCode = 1;
