# Third-party provenance and verification

The companion to [`THIRD-PARTY.md`](THIRD-PARTY.md). That file states **what** is
included and under what licence; this one records **where each byte came from, how the
claim was checked, and how to rebuild it.** It ships in the extension package.

Nothing here is required by a licence's wording. It is here because this project's
position is that attribution you cannot verify is attribution on trust, and a pinned
revision plus a content hash is what lets a reader check for themselves. If the
revision and the hash ever disagree, **trust the hash**, a commit can be rewritten, a
hash cannot.

## `src/learn/data/chinese.json`

### Rebuilding

```
node tools/build-wordlist.mjs <parsed_hsk_enriched.json>
```

The input is **not committed** and is not fetched by the script; it is pinned to an
exact revision so a clean checkout can reproduce the file byte-for-byte.

| | |
| --- | --- |
| Repository | `TeaPearce/chinese-english-dictionary` |
| Commit | `a9aea223269eb9820590e5bca783eb299c317439` (2026-08-27) |
| Blob | `7562130dea9284b99c86c9e8a5b8fe0a2cc003a1` |
| SHA-256 | `e49bf4a732790bda359376a10ad59a6d4874be3b0dab66f1add907c0fedf3c10` |
| Path | `data/parsed_hsk_enriched.json` (5,092,448 bytes) |

**Verified 2026-10-06:** fetching that exact revision and rebuilding reproduces the
committed `chinese.json` exactly, the same 11,470 words, identical levels, **zero
differing entries**.

The blob hash is recorded as well as the commit, because a commit can be rewritten or
force-pushed while a blob hash cannot. The 5 MB input is deliberately not vendored:
duplicating someone else's data to make a build self-contained is worse than naming
the exact revision it came from, and the vendored copy would carry the same CC BY-SA
obligation anyway.

### HSK levels: why the filename says "Pleco"

The levels come from a word list upstream names `hsk31-words-pleco.txt`. Despite the
name, **Pleco is the OCR tool, not the author.** The list is the official HSK 3.0 word
list published by the Chinese Ministry of Education (MOE), whose text was extracted
from the official PDF and OCR'd with [Pleco OCR](https://www.pleco.com/). The same MOE
source is mirrored and re-typed under **MIT** by
[`elkmovie/hsk30`](https://github.com/elkmovie/hsk30), whose README states it was
*"Extracted from the official PDF and OCR'ed using Pleco OCR"*, so the filename is
describing the extraction method, not claiming authorship.

So the levels are a government-published exam standard, and no proprietary Pleco work
is in the file. We carry **no** MIT obligation from `elkmovie/hsk30`, because we do
not consume that repository: the levels reached us through TeaPearce's CC BY-SA 4.0
redistribution, and that is the licence honoured on the derived file.

## `src/learn/data/japanese.json`

### Rebuilding

```
node tools/build-wordlist.mjs --ja <jmdict.json> --jlpt <dir>
```

Pinned to an exact revision, like the Chinese source:

| | |
| --- | --- |
| Repository | `scriptin/jmdict-simplified` |
| Release | `3.6.2+20261005200550` |
| Asset | `jmdict-eng-common-3.6.2+20261005200550.json.zip` |
| SHA-256 | `956cb65b95d12d2b81fa550716d53163dbd3c70ca171a9c7dce97d7238c9d87a` |
| Inner file | `jmdict-eng-common-3.6.2.json` (22,644 entries) |
| Levels | `jamsinclair/open-anki-jlpt-decks` @ `1ad66734417aca9dbcca6b2d5ee440cb13ab3ba0`, `src/n1.csv … n5.csv` |

**Verified 2026-10-06** by downloading that asset, confirming its size and SHA-256, and
building from it. A first draft of these notes quoted the **full** `jmdict-eng` asset's
hash while naming the `common` file, which the download check caught, which is why the
hash is recorded from the actual download rather than copied from documentation.

The JLPT CSVs need care the revision pin does not cover: the `expression` column uses
`;` for multi-form words (`足; 脚`) and `～` for counters (`～円`). Treating a cell as
one literal key silently loses about 10% of levels, so the build splits on `;` and
strips `～`, whitespace and parentheticals.

**Known gap, a limitation of the build rather than a bug:** words absent from JMdict
`common` have no definition and therefore no level, measured at about 6% of JLPT rows.
Consuming the full 11.5 MB `jmdict-eng` variant would close it at eight times the size.

### The EDRDG conditions, and how each is met

EDRDG's licence statement grants CC BY-SA 4.0 **with additional clauses of its own**,
so they are obligations this project satisfies independently of CC BY-SA.

| EDRDG clause | How it is met |
| --- | --- |
| **§4 Regular updating**: a documented procedure to keep the data current, and "failure to keep the versions up-to-date is a violation of the licence" | Each build records the exact upstream release here and in the data file's `meta` (`tag`, `release`). `npm run wordlists:fetch` is the procedure: it pins and verifies a revision rather than taking "latest". A packaged extension has no server to update monthly, so the defensible reading is a documented, reproducible procedure plus a recorded version, which is what exists. |
| **§3.b.ii/iii Documentation and links travel with the software** | This file and `THIRD-PARTY.md` are committed and ship in the package (`SHIPPED` in the `Makefile`), so the documentation and the licence references travel with the extension rather than living only on a website. |
| **§3 Attribution in documentation and publicity material** | `THIRD-PARTY.md`, `README.md`, and the Web Store listing. |
| **§6 "Users must NOT claim copyright over that material"** | Nothing here claims copyright over the dictionary data. `LICENSE` excludes the bundled dictionaries, and the data names its source. |

## `src/learn/data/korean.json`

### Rebuilding

```
node tools/build-wordlist.mjs --ko <results.tsv> --ko-yonsei <dir>
```

| | |
| --- | --- |
| NIKL level list | `julienshim/combined_korean_vocabulary_list`, `results.tsv`, 7,497 rows |
| SHA-256 | `bb5789e46d818842ed6cc15c7946805ad1aed9fd1d0912d884cc48a8556b9a3c` |
| Definitions and course levels | `Amulopapa67/open-yonsei-korean-vocabulary` @ `v0.1.0`, `vol-01.json … vol-06.json` |

### How the NIKL levels reached us

Through `julienshim/combined_korean_vocabulary_list`, whose `results.tsv` merges the
NIKL and TOPIK lists. That repository is **MIT for its code only** and says so: it does
not host the source lists, and all rights remain with their publishers. So the MIT
licence does **not** cover the level data we consume, and we do not claim it does.

The NIKL page for 한국어 학습용 어휘 목록 ends:

> 공공저작물 자유이용허락 표시 기준(공공누리, KOGL) 제1 유형 조건에 따라
> 저작물의 출처를 구체적으로 표시한 후 이용할 수 있습니다.

That is **KOGL Type 1** (공공누리 제1유형), verified against the official KOGL
certificate. It grants attribution, **derivative works, and commercial use**: the
least restrictive of the KOGL types, so the obligation is the attribution
`THIRD-PARTY.md` provides.

### Why TOPIK is deliberately excluded

The level list carries a `topik_level` column and the build does not read it. This is
a licence decision, not an oversight. TOPIK's terms of use (`이용약관`, Article 15,
저작권) state that copyright in all site content belongs to TOPIK, that unauthorised
reproduction or distribution may be punished under copyright law, and that using the
content to profit **or to enjoy a corresponding benefit** requires TOPIK's permission.
Its operator, the National Institute for International Education (NIIED), limits free
use to personal, academic and research purposes. A distributed extension that ships
the vocabulary is outside that grant, so the column is ignored and no TOPIK list is
offered. If someone revisits this file, this is the reason the column is unused.

### The aggregator's column-swap history

The aggregator's README documents a history of **swapped `nikl_level`/`topik_level`
columns**, fixed upstream by tagging entries with their source. The build reads the
NIKL level only, so a future swap that put letter grades in the wrong column would be
read as an absent grade and skipped, rather than mis-levelling a word.

Two columns are deliberately unused. `explanation` is a collocation hint in Korean
rather than a definition (`~에 가다` for 가게, "to go to a shop") and is empty on 18% of
rows, so used as a meaning it would read as a non-answer. `rank` is a frequency number,
absent for TOPIK-only words, and is a different axis from the level the ramp, the
threshold and the badge all read.

### Why the course volume is a level

Measured against both NIKL and TOPIK, the mean difficulty of a volume rises at **every
one** of the six volumes, so the course ordering is a real difficulty ordering. It is
not a restatement of NIKL: rank correlation is about 0.71 and the middle volumes
overlap heavily, so it carries information the graded list does not. It is also the
only Korean list whose words all carry a definition, since it is the source of them.

**Known gap:** about half of Korean words carry a definition. Words known only to NIKL
ship without one, because NIKL grades a word but does not gloss it. Those words still
mark, and the popover says it has no definition yet, rather than the word vanishing.

### Why two Korean lists

Measured over the union (7,738 words) the two lists overlap by only about 25%: NIKL
contributes 1,019 words the other does not place, and Yonsei 1,913. Shipping both
recovers those 2,932 words, a materially different case from HSK 2.0 and 3.0, which
overlap by 64%.

## `src/vendor/mediabunny.js`

### Why it is committed rather than installed

The release ZIP is assembled from `src/` alone, so a file the extension loads at
runtime cannot come from `node_modules`. Committing generated code is a real cost and
the smaller one here: the alternative is a build step every contributor needs before
they can package anything.

### Why it is bundled as one file

The three coder packages import the bare specifier `"mediabunny"`, which a
`chrome-extension://` page cannot resolve, so all four are built into one file by
`node tools/build-vendor.mjs`.

### Why the codecs come from packages and not a compiled FFmpeg

An earlier revision shipped a **custom-compiled FFmpeg wasm build** to decode Dolby
audio. It was retired in favour of the published packages: those decode AC-3 and
E-AC-3 and encode AAC, they are 3.0 MB smaller raw and 1.4 MB smaller gzipped, and
they remove a C toolchain from the release path entirely. There is now **no build
product** in this project.

### Why `esbuild` is a dependency but not a shipped one

It exists only to produce the bundle above. Nothing in the extension imports it, and
`licence.test.mjs` asserts that `package.json` has no runtime `dependencies`, which
keeps a module from being resolved at runtime that the packaging step would silently
drop.

### Why the reading tables are generated

Two of the three scripts can be read without a dictionary entry, because they are
algorithmic, and the readings for text the dictionary does not hold come from a small
table produced at build time.

- **Korean.** `koroman` (MIT) implements the National Institute of Korean Language's
  Revised Romanization including the sound-change rules. A test asserts the generated
  table matches the library for **all 11,172 syllables**. A syllable table is exact
  for a lone syllable and wrong across a boundary (종로 is `jongno`, not `jongro`), so
  a dictionary entry always wins and the table is only the fallback.
- **Japanese.** `wanakana` (MIT) converts kana to romaji. A test asserts the result
  against the library across all 28,690 readings, with 12 documented differences
  pinned by name.
- **Chinese has no table, deliberately.** A hanzi's reading is lexical and
  context-dependent: 阿姨 is `āyí`, not `yí`, and 4,828 of 9,899 multi-character words
  fail naive concatenation, so a Chinese word with no entry genuinely has no reading.

Both libraries are development dependencies and are not shipped. The tables are
committed as `src/learn/readings.js`, about 7 KB, and a check regenerates it and fails
on any difference, so a hand-edited table cannot survive.

## `tools/pages/media/`

### The video is a stream copy, and that is why the provenance is exact

`demo.mp4` is **bit-identical to the archive's own video stream**. Nothing is
re-encoded: `-c copy` re-muxes the existing H.264 and AAC, so the file's content is the
archive's content, not a transcoded version needing its own description.

This also makes it the SMALLEST option, which is counterintuitive. Measured at the
source's 640x480: the stream copy is 31 MB, while a "near-lossless" re-encode is 74 MB
(x264 CRF 18), 58 MB (x265 CRF 22) or 48 MB (VP9 CRF 32). The source is already only
878 kbps, so a near-lossless re-encode preserves its existing artifacts and spends
MORE bits than the original encoder did.

### Rebuilding

`node tools/pages/fetch-media.mjs` reproduces all four files.

- The window is 8:00-13:00, chosen because that is where subtitle cue density peaks
  (38-39 cues in five minutes), so the demo shows marking on real dialogue.
- The subtitles come from the same item and are cut to the window and rebased to zero,
  since the originals cover the whole 73 minutes.
- The Chinese files are renamed to what the viewer reads: the language has to be the
  final dotted segment (`demo.zh-Hant.srt`), because `languageFromFileName` splits on
  `.` and `_` but not on hyphens, so `princess_iron_fan-zh-hant.srt` would resolve to
  the bare `zh` and collide with the simplified track.

`demo.mp4` rebuilds byte-identical. The subtitles are normalised on output, so a
rebuild may differ from the committed copy by a trailing newline; the content is the
same.

## Conformance suite

`test/conformance/` holds the IETF CELLAR Matroska test files, authored by the
mkvmerge and libmatroska maintainers to check a parser against files written by the
people who define the format. It found two real parser bugs on its first run: a
missing `TimecodeScale` read, and an absent `Language` element being treated as
unknown rather than as the specification's English default. Both are the kind of
mistake a single fixture generator cannot see.
