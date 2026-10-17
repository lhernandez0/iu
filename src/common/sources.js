/**
 * The third-party works this extension displays, and the rights they are used under.
 *
 * **A module, not a constant inside a screen, for two reasons.** The side panel's
 * licences view and the video viewer's shortcut panel both show dictionary-derived
 * words, so both render this list and it must be one list rather than two copies. And
 * a hermetic test has to read it without a DOM: importing `sidepanel.js` would drag in
 * every element lookup in that file.
 *
 * **One entry per third-party work, NOT per dictionary.** A dictionary can rest on
 * several works under different licences, so one row per language would under-report
 * Japanese (JMdict plus an MIT JLPT deck) and Korean (a KOGL Type 1 word list plus a
 * CC BY-SA vocabulary). The Korean case is why this matters legally and not only in
 * tidiness: KOGL Type 1 and CC BY-SA 3.0 are distinct obligations met on the same row.
 *
 * `name` and `licence` are byte-identical to `meta.sources[].name` and
 * `meta.sources[].licence` in `src/learn/data/*.json`. `test/licence.test.mjs` reads
 * both and fails if a dictionary names a source this list does not, so a fourth
 * dictionary cannot ship unattributed. The data file is the source of truth and this
 * is its projection into the UI, which is the direction that cannot drift, because
 * the test compares them.
 *
 * **No URLs.** The deeds and source links live in `THIRD-PARTY.md`, which ships in the
 * package, because `test/manifest.test.mjs` fails the build on any absolute host other
 * than `youtube.com` in a `.js` file under `src/`. That guard is what keeps this
 * extension unable to start talking to a second host, so the screens name the sources
 * and the shipped document carries the links. Deliberate, not an omission.
 *
 * `changes` records the modification each licence requires us to state. CC BY-SA asks
 * for an indication of changes and KOGL Type 1 asks that a derivative be marked as
 * one; omitting it leaves an otherwise correct attribution incomplete.
 *
 * @type {ReadonlyArray<{name: string, short: string, licence: string, changes: string}>}
 */
export const SOURCES = Object.freeze([
  {
    name: 'CC-CEDICT via TeaPearce/chinese-english-dictionary',
    short: 'CC-CEDICT',
    licence: 'CC BY-SA 4.0',
    changes: 'Reformatted and subset.',
  },
  {
    name: 'JMdict (EDRDG, Jim Breen) via scriptin/jmdict-simplified',
    short: 'JMdict (EDRDG)',
    licence: 'CC BY-SA 4.0',
    changes: 'Reformatted and subset to the common entries.',
  },
  {
    name: 'open-anki-jlpt-decks (Jamie Sinclair)',
    short: 'JLPT decks',
    licence: 'MIT',
    changes: 'JLPT levels only.',
  },
  {
    name: 'NIKL 한국어 학습용 어휘 목록 (National Institute of Korean Language), via julienshim/combined_korean_vocabulary_list',
    short: 'NIKL vocabulary',
    licence: 'KOGL Type 1',
    changes: 'NIKL levels only.',
  },
  {
    name: 'Open Yonsei Korean Vocabulary (Amulopapa67), a community companion to the six-volume Yonsei course, not affiliated with Yonsei University',
    short: 'Yonsei vocabulary',
    licence: 'CC BY-SA 3.0',
    changes: 'Definitions, readings and course levels only.',
  },
]);
