# Third-party notices

What this project uses from elsewhere, under what licence, and what that obliges
us to do. Kept in the repository root and committed, because attribution that
exists only inside a data file is attribution nobody finds.

Two bundled dictionaries, both **CC BY-SA 4.0** derivative works. The licence on
this project's own code (MIT) does **not** cover them, and neither may be
relicensed.

| File | Words | Sources |
| --- | --- | --- |
| `src/learn/data/chinese.json` | 11,470 | CC-CEDICT + the official MOE HSK 3.0 word list |
| `src/learn/data/japanese.json` | 28,690 | JMdict (EDRDG) + the JLPT lists |

---

## `src/learn/data/chinese.json` — the Chinese dictionary

**Licence: CC BY-SA 4.0**

This is a **derived** work, not a copy. It is CC BY-SA 4.0 and **must remain
CC BY-SA 4.0**; it cannot be relicensed, and it is not covered by the licence on
this project's own code.

Derived through, in order:

| Source | What came from it | Licence |
| --- | --- | --- |
| [CC-CEDICT](https://www.mdbg.net/chinese/dictionary?page=cc-cedict) | Definitions, pinyin, traditional forms | CC BY-SA 4.0 |
| [TeaPearce/chinese-english-dictionary](https://github.com/TeaPearce/chinese-english-dictionary) | The merged and standardised form we consumed (`data/parsed_hsk_enriched.json`) | CC BY-SA 4.0 |
| HSK 3.0 word list (`data/hsk31-words-pleco.txt` upstream) | HSK levels override the CC-CEDICT-derived ones | Official MOE standard; see below |

**Attribution.** CC-CEDICT is a community dictionary, a continuation of the CEDICT
project begun by Paul Denisowski in 1997. The compilation we consume is
**© 2026 Tim Pearce** (*Chinese-English HSK Dictionary*), which is itself a CC BY-SA
4.0 work derived from CC-CEDICT. CC BY-SA 4.0 requires that we say where the data
came from, which is what this section is.

**Share-alike.** The licence also requires that improvements and additions be
shared under the same licence. The changes made here are:

- entries merged by simplified character (done upstream by the standardising step);
- HSK levels overridden from the HSK 3.0 list;
- reshaped into keyed objects with abbreviated field names, and with levels
  *absent* rather than null for unlevelled words.

Those changes are in the committed file, so the derived work is available. The
build is `tools/build-wordlist.mjs`; see the section below on its input.

**HSK levels — provenance resolved.** The levels come from a word list upstream
names `hsk31-words-pleco.txt`. Despite the filename, **Pleco is the OCR tool, not
the author.** The list is the *official HSK 3.0 word list* published by the Chinese
Ministry of Education (MOE); the file was extracted from the official MOE PDF and
OCR'd using [Pleco OCR](https://www.pleco.com/). The same MOE source is mirrored and
re-typed under **MIT** by [`elkmovie/hsk30`](https://github.com/elkmovie/hsk30),
whose README states: *"Extracted from the official PDF and OCR'ed using Pleco OCR"* —
so the "Pleco" attribution in the TeaPearce filename is describing the extraction
method, not a claim of authorship.

What this means for us:

- The levels are drawn from a **government-published exam standard**, and a
  freely-redistributable (MIT) transcription of the identical data exists. There is
  no proprietary Pleco work in this file.
- A word list — words paired with their exam level — is factual reference data and,
  independently, is published by the MOE for public use. Either way, the exposure
  flagged in the audit as *unverified* is now closed: the source is the official
  standard, not Pleco's authorship.
- We carry **no** MIT obligation from `elkmovie/hsk30` itself, because we do not
  consume that repository — the levels reached us via TeaPearce's CC BY-SA 4.0
  redistribution, and that is the licence we honour on the derived file.

### Rebuilding the dictionary

`node tools/build-wordlist.mjs <parsed_hsk_enriched.json>`

The input is **not committed** and is not fetched by the script. It is instead
**pinned to an exact revision**, so a clean checkout can reproduce the file
byte-for-byte:

| | |
| --- | --- |
| Repository | `TeaPearce/chinese-english-dictionary` |
| Commit | `a9aea223269eb9820590e5bca783eb299c317439` (2026-08-27) |
| Blob | `7562130dea9284b99c86c9e8a5b8fe0a2cc003a1` |
| SHA-256 | `e49bf4a732790bda359376a10ad59a6d4874be3b0dab66f1add907c0fedf3c10` |
| Path | `data/parsed_hsk_enriched.json` (5,092,448 bytes) |

**Verified 2026-10-06:** fetching that exact revision and rebuilding reproduces
the committed `chinese.json` exactly — the same 11,470 words, identical levels,
**zero differing entries**. So the pin is not a claim, it is a tested fact.

The blob hash is recorded *as well as* the commit, because a commit can be
rewritten or force-pushed while a blob hash cannot. If the commit URL and the hash
ever disagree, trust the hash.

The choice not to vendor the 5 MB input is deliberate: duplicating someone else's
data to make a build self-contained is worse than naming the exact revision it came
from, and the vendored copy would carry the same CC BY-SA obligation anyway.

---

## `src/learn/data/japanese.json` — the Japanese dictionary

**Licence: CC BY-SA 4.0**

Also a **derived** work, and also **must remain CC BY-SA 4.0**. Two sources, the
same shape as the Chinese one: a CC BY-SA dictionary for the words, and an MIT
list for the exam levels.

| Source | What came from it | Licence |
| --- | --- | --- |
| [JMdict](https://www.edrdg.org/jmdict/j_jmdict.html) (EDRDG, project begun by Jim Breen, 1991) | Definitions, kana readings, part of speech | CC BY-SA 4.0 |
| [scriptin/jmdict-simplified](https://github.com/scriptin/jmdict-simplified) | The JSON conversion we consume | CC BY-SA 4.0 (inherited from EDRDG) |
| [jamsinclair/open-anki-jlpt-decks](https://github.com/jamsinclair/open-anki-jlpt-decks) | JLPT level per word (N1–N5) | **MIT** |

**Attribution.** The dictionary data is the work of the **Electronic Dictionary
Research and Development Group (EDRDG)**, a project begun by Jim Breen. `jmdict-
simplified` is a derived distribution and carries the same licence: we credit EDRDG
as the origin, not the converter. The JLPT levels are from a separately-licensed
(MIT) list, whose original deck data the project's README credits to
`chyyran/jlpt-anki-decks` and tanos.co.uk.

**Share-alike.** The changes made here are:

- one entry per written form, so `足` and `脚` each resolve to the same reading;
- kana readings taken from the **common** form rather than the first listed, and
  rare-kanji-tagged forms (`rK`) dropped;
- reshaped into the same keyed-object form as the Chinese dictionary (`p` is the
  reading, `t` is unused and empty);
- homograph collisions resolved first-wins (156 expression keys appear in more than
  one JMdict entry).

Those changes are in the committed file, so the derived work is available.

**Known gaps, recorded because they are limitations of the build, not bugs:**

- **Words absent from JMdict `common`** have no definition and therefore no level.
  Measured at about 6% of JLPT rows; consuming the full 11.5 MB `jmdict-eng` variant
  instead would close it at eight times the size.

### Rebuilding the Japanese dictionary

`node tools/build-wordlist.mjs --ja <jmdict.json> --jlpt <dir>`

Pinned to an exact revision, like the Chinese source:

| | |
| --- | --- |
| Repository | `scriptin/jmdict-simplified` |
| Release | `3.6.2+20261005200550` |
| Asset | `jmdict-eng-common-3.6.2+20261005200550.json.zip` |
| SHA-256 | `956cb65b95d12d2b81fa550716d53163dbd3c70ca171a9c7dce97d7238c9d87a` |
| Inner file | `jmdict-eng-common-3.6.2.json` (22,644 entries) |
| Levels | `jamsinclair/open-anki-jlpt-decks` @ `1ad66734417aca9dbcca6b2d5ee440cb13ab3ba0`, `src/n1.csv … n5.csv` |

**Verified 2026-10-06** by downloading that asset, confirming its size and SHA-256,
and building from it. The asset hash is recorded rather than copied from
documentation — a first draft of the build notes quoted the **full** `jmdict-eng`
asset's hash while naming the `common` file, which the download check caught.

The JLPT CSVs need care that the pin does not cover: the `expression` column uses
`;` for multi-form words (`足; 脚`) and `～` for counters (`～円`). Treating a cell
as one literal key silently loses about 10% of levels, so the build splits on `;`
and strips `～`, whitespace and parentheticals.

## Development dependencies

Not shipped. The extension itself has **no runtime dependencies** — no bundled
libraries, no vendored code, no webfonts, no third-party images.

| Package | Licence | Note |
| --- | --- | --- |
| `playwright` | Apache-2.0 | Browser test tier and icon rasterising |
| `vite` | MIT | The side-panel design preview only |
| `lightningcss`, `lightningcss-linux-x64-gnu` | **MPL-2.0** | Pulled in transitively by Vite |

The two MPL-2.0 packages are the only non-permissive licences in the tree. MPL-2.0
is file-level copyleft: it obliges publishing changes to *its* files, and imposes
nothing on this project. It is not a concern here because they are development-only,
never bundled, and unmodified. Recorded so that the next person does not have to
rediscover it.

## Test fixtures

`test/synthetic/` is committed and is **our own invented text**, wearing shapes
measured from a real capture — real cue counts, timings, silences and renderer
keys, with our own sentences. It contains no third-party text.

`test/fixtures/` holds the real captures. It is **gitignored and never committed**:
a capture contains a signed caption URL and the real video's own title, neither of
which belongs in a repository.
