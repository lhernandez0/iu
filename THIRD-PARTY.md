# Third-party notices

Attribution for everything this project uses from elsewhere, and the licence each is
used under. This file is the notice and ships in the extension package.

**Provenance, verification and rebuild instructions are NOT here.** The exact
revisions, content hashes and recipes that let you reproduce every bundled file are in
[`THIRD-PARTY-NOTES.md`](THIRD-PARTY-NOTES.md), which also ships. This file is what you
skim to learn what is included and under what terms; that one is what you read to
check it.

The extension's own code is MIT; see [`LICENSE`](LICENSE). **None of the dictionaries
are covered by it.** All three are share-alike derivative works and must stay that
way; they cannot be relicensed.

## Components

| Component | Version / revision | Licence | Used for | Ships |
| --- | --- | --- | --- | --- |
| CC-CEDICT | via `TeaPearce/chinese-english-dictionary` | CC BY-SA 4.0 | Chinese definitions, pinyin, forms | yes |
| HSK 3.0 word list (Chinese MOE) | word list `hsk31-words-pleco.txt` | CC BY-SA 4.0 | HSK levels in the Chinese dictionary | yes |
| JMdict (EDRDG, Jim Breen) | via `scriptin/jmdict-simplified` | CC BY-SA 4.0 | Japanese definitions and readings | yes |
| open-anki-jlpt-decks | `jamsinclair/open-anki-jlpt-decks` | MIT | JLPT levels in the Japanese dictionary | yes |
| 한국어 학습용 어휘 목록 (NIKL) | National Institute of Korean Language, 2003 | KOGL Type 1 | NIKL grades in the Korean dictionary | yes |
| Open Yonsei Korean Vocabulary | `Amulopapa67/open-yonsei-korean-vocabulary` | CC BY-SA 3.0 | Korean definitions, readings, course levels | yes |
| mediabunny | 1.61.3 | MPL-2.0 | Containers and the conversion pipeline | yes |
| @mediabunny/ac3 | 1.61.4 | MPL-2.0 | AC-3 / E-AC-3 decode and encode | yes |
| @mediabunny/dts | 1.61.4 | MPL-2.0 | DTS decode and encode | yes |
| @mediabunny/aac-encoder | 1.61.4 | MPL-2.0 | AAC encoding where WebCodecs cannot | yes |
| *Princess Iron Fan* (1941 film) | Internet Archive item `princess_iron_fan` | Public domain | The GitHub Pages demo clip and subtitles | yes |
| matroska-test-files (IETF CELLAR) | downloaded by `npm run conformance:fetch` | CC BY 3.0 / CC BY 2.5 | Matroska conformance tests | no |
| Development dependencies | see the table below | Apache-2.0, MIT, MPL-2.0 | Tests, preview, build tooling | no |

## Bundled dictionaries

Each dictionary is a **derived** work assembled from the sources listed for it. It
declares its own licence in the field `meta.licence`, derived by the build from its
`meta.sources`. The changes made to each are stated, because every share-alike
licence here, CC BY-SA and KOGL, requires an indication of changes.

### `src/learn/data/chinese.json`, the Chinese dictionary

**Licence: CC BY-SA 4.0.** A derived work of [CC-CEDICT](https://www.mdbg.net/chinese/dictionary?page=cc-cedict)
(the community dictionary continued from the CEDICT project begun by Paul Denisowski
in 1997) as compiled and standardised by `TeaPearce/chinese-english-dictionary`,
**© 2026 Tim Pearce**, plus the official HSK 3.0 word list of the Chinese Ministry of
Education (MOE) for the levels. Licence deed:
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/); full licence:
[legalcode](https://creativecommons.org/licenses/by-sa/4.0/legalcode).

Changes: entries merged by simplified character; HSK levels taken from the MOE list;
reshaped into keyed objects with abbreviated field names, levels *absent* rather than
null for unlevelled words. The derived file is committed, so the result is available.

### `src/learn/data/japanese.json`, the Japanese dictionary

**Licence: CC BY-SA 4.0.** A derived work of **JMdict**, the work of the Electronic
Dictionary Research and Development Group (**EDRDG**, project begun by Jim Breen,
1991), consumed through the `scriptin/jmdict-simplified` JSON conversion, which
inherits the same licence; we credit EDRDG as the origin, not the converter. The JLPT
levels come from `open-anki-jlpt-decks`. Licence:
[EDRDG General Dictionary Licence Statement](https://www.edrdg.org/edrdg/licence.html),
which grants [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) with
conditions of its own; see [`THIRD-PARTY-NOTES.md`](THIRD-PARTY-NOTES.md) for how each
EDRDG clause is met.

Changes: one entry per written form; readings taken from the common form; rare-kanji
forms dropped; reshaped into the same keyed-object form as the Chinese dictionary;
homograph collisions resolved first-wins.

### `src/learn/data/korean.json`, the Korean dictionary

**Licence: CC BY-SA 3.0.** A derived work of 한국어 학습용 어휘 목록, published by the
**National Institute of Korean Language** (2003) for the NIKL grades, under **KOGL
Type 1** (공공누리 제1유형), and of **Open Yonsei Korean Vocabulary** for the English
definitions, readings and course levels. Licence deed:
[CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/); full licence:
[legalcode](https://creativecommons.org/licenses/by-sa/3.0/legalcode). 3.0 rather than
4.0 because the definitions layer is 3.0 and share-alike takes the lower version when
both appear.

Open Yonsei Korean Vocabulary is an independently maintained community project, **not
affiliated with, sponsored by or endorsed by Yonsei University**; the name identifies
the textbook series it indexes. KOGL Type 1 likewise forbids implying that the public
body endorses this project, so nothing here is described as endorsed by NIKL or the
Ministry of Culture, Sports and Tourism.

Changes: homograph senses merged, keyed on the word without its trailing sense number,
placed at the easiest grade; NIKL grades stored as an ascending `1..3`; the course
level taken from the first volume a word appears in; reshaped into the shared
keyed-object form; NIKL words with no definition emitted with an empty meaning rather
than dropped. The derived file is committed.

## `src/vendor/mediabunny.js`, MPL-2.0, and this attribution is required

The one third-party **code** file that ships inside the extension. It is a tree-shaken
bundle of four MPL-2.0 packages: `mediabunny`, `@mediabunny/ac3`, `@mediabunny/dts`,
`@mediabunny/aac-encoder`.

**Copyright (c) 2026-present, Vanilagy and contributors.** Mozilla Public License,
v. 2.0. The full licence is [https://mozilla.org/MPL/2.0/](https://mozilla.org/MPL/2.0/).
The package's own source-file headers are preserved inside the bundle, so a copy of
this notice travels with the source it covers. The covered files are unmodified;
MPL-2.0 is file-level copyleft and imposes nothing on the surrounding project.

## Test fixtures and conformance media

`test/synthetic/` is committed and is **our own invented text**; it contains no
third-party text. `test/fixtures/` holds real captures and is gitignored, never
committed. `test/mkv/*.mkv` is generated locally by `npm run fixtures` and holds no
third-party media.

`test/conformance/` holds the IETF CELLAR Matroska test files, downloaded by `npm run
conformance:fetch`. **Not committed, not packaged, not part of the extension.** They
contain real film samples under **CC BY**, which obliges attribution even though the
files are not distributed here:

| Source | Licence | Required attribution |
| --- | --- | --- |
| Big Buck Bunny (test1, test4, test6) | CC BY 3.0 | `(c) copyright 2008, Blender Foundation / www.bigbuckbunny.org` |
| Elephants Dream (test2, test3, test5, test7, test8) | CC BY 2.5 | `(c) copyright 2006, Blender Foundation / Netherlands Media Art Institute / www.elephantsdream.org` |

## `tools/pages/media/`, public domain

The GitHub Pages demo ships a five-minute clip and three subtitle tracks, the one
piece of committed third-party **media**.

*Princess Iron Fan* (鐵扇公主, 1941), the first Chinese animated feature, directed by
Wan Laiming and Wan Guchan, from the Internet Archive item
[`princess_iron_fan`](https://archive.org/details/princess_iron_fan), where it is
marked **public domain**. Public domain requires no attribution; it is given because
the source and recipe are what let anyone verify the bytes. The recipe is in
[`THIRD-PARTY-NOTES.md`](THIRD-PARTY-NOTES.md).

## Development dependencies

**Not shipped**, listed so the obligations are on the record. The release package
contains one third-party file, the vendored bundle above, and nothing else.

| Package | Licence | Used for |
| --- | --- | --- |
| `playwright` | Apache-2.0 | Browser test tier and icon rasterising |
| `vite` | MIT | The side-panel design preview only |
| `esbuild` | MIT | Bundles `src/vendor/mediabunny.js`; not shipped |
| `koroman` | MIT | Generates and verifies the Korean reading table; not shipped |
| `wanakana` | MIT | Generates and verifies the Japanese reading table; not shipped |
| `lightningcss`, `lightningcss-linux-x64-gnu` | MPL-2.0 | Pulled in transitively by Vite |

The two MPL-2.0 development packages are unmodified and never bundled, so they impose
nothing here.

## Full licence texts

CC BY-SA and MPL-2.0 are referenced by the links above rather than reproduced: each
licence's own condition is that the licence be **identified by URI**, which a link
satisfies, and the MPL text also travels with the vendored source. MIT asks for its
text to be **included**, so it is reproduced here in full.

### MIT (open-anki-jlpt-decks)

```text
MIT License

Copyright (c) 2020 Jamie Sinclair

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
