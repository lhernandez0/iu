# Third-party notices

What this project uses from elsewhere, under what licence, and what that obliges
us to do. Kept in the repository root and committed, because attribution that
exists only inside a data file is attribution nobody finds.

## `src/learn/data/chinese.json` — the bundled dictionary

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
project begun by Paul Denisowski in 1997. Its licence requires that we say where
the data came from, which is what this section is.

**Share-alike.** The licence also requires that improvements and additions be
shared under the same licence. The changes made here are:

- entries merged by simplified character (done upstream by the standardising step);
- HSK levels overridden from the HSK 3.1 list;
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

The input is **not committed** and is not fetched by the script: it comes from the
TeaPearce repository above. A clean checkout therefore cannot rebuild the file
without obtaining it separately. This is recorded rather than fixed, because
vendoring 11.5k entries of someone else's data to make a build self-contained is a
worse answer than naming the dependency.

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
