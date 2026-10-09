/**
 * Reading-layout mock: romanization and script conversion, on the real panel.
 *
 * A throwaway design page — it demonstrates four layouts for showing readings
 * (拼音 / Rōmaji) and one toggle for 繁 ↔ 简, so a decision can be made by looking
 * at pixels rather than at ASCII.
 *
 * ## What is real and what is mocked
 *
 * Real: the panel's own stylesheet, the real `.row` / `.lines` / `.primary` /
 * `.secondary` / `.mark` / `.word` markup, and `renderTokens` imported from
 * `src/sidepanel/marks.js` — so a marked word here is marked by the shipped code
 * path, including its level colour ramp.
 *
 * Mocked: the tokens themselves. Producing real ones needs the worker, the
 * dictionary and a word list, which is the whole extension. The shapes are real;
 * the levels are chosen to show the ramp, not measured.
 *
 * Nothing here ships and nothing imports it.
 *
 * Run: npm run ui  →  http://127.0.0.1:8099/tools/ui/reading.html
 */

import { renderTokens } from '/src/common/marks.js';
// The real conversion, not a copy. The mock had its own and the two would have drifted:
// the real one needed a syllable table and backtracking to be correct, which a
// nine-line version here would have silently got wrong while looking fine.
import { pinyinToNumbers } from '/src/learn/wordlist.js';

/**
 * The real `renderTokens` draws a span ONLY for a token with `defined: true` —
 * anything else becomes a bare text node with no mark and no colour. That was a
 * real defect in the first version of this page: every token rendered as plain
 * text, so no level colours appeared at all while the readings looked correct,
 * and the one thing the mock exists to show was missing.
 *
 * A token is "defined" when it has a reading, which is also the rule the real
 * worker uses: a word the dictionary cannot look up has nothing to annotate.
 *
 * @param {Array<{text: string, reading?: string, level?: number|null}>} tokens
 */
function annotate(tokens) {
  return tokens.map((token) => ({ ...token, defined: Boolean(token.reading) }));
}

// --- The content ------------------------------------------------------------
//
// Three cues per language, which is enough to judge a layout. Each token carries
// its reading; `level: null` means the list does not place it, which the panel
// styles as a plain hoverable word rather than a mark.

const CHINESE = [
  {
    start: 12,
    gloss: 'She finally understood what her mother meant.',
    tokens: [
      { text: '她', reading: 'tā', level: 1 },
      { text: '终于', reading: 'zhōngyú', level: 3 },
      { text: '明白', reading: 'míngbai', level: 3 },
      { text: '了', reading: 'le', level: 1 },
      { text: '妈妈', reading: 'māma', level: 1 },
      { text: '的', reading: 'de', level: 1 },
      { text: '意思', reading: 'yìsi', level: 2 },
    ],
    traditional: '她終於明白了媽媽的意思',
  },
  {
    start: 15,
    gloss: 'He shook his head and said nothing.',
    tokens: [
      { text: '他', reading: 'tā', level: 1 },
      { text: '摇摇头', reading: 'yáoyao tóu', level: null },
      { text: '没', reading: 'méi', level: 2 },
      { text: '说什么', reading: 'shuō shénme', level: null },
      { text: '。', reading: '', level: null },
    ],
    traditional: '他搖搖頭，沒說什麼。',
  },
  {
    start: 18,
    gloss: 'That city is far bigger than Beijing.',
    tokens: [
      { text: '那个', reading: 'nàge', level: 2 },
      { text: '城市', reading: 'chéngshì', level: 4 },
      { text: '比', reading: 'bǐ', level: 2 },
      { text: '北京', reading: 'Běijīng', level: 3 },
      { text: '大', reading: 'dà', level: 1 },
      { text: '得多', reading: 'de duō', level: null },
      { text: '。', reading: '', level: null },
    ],
    traditional: '那個城市比北京大得多。',
  },
];

const JAPANESE = [
  {
    start: 3,
    gloss: "I'm studying Japanese.",
    tokens: [
      { text: '私', reading: 'watashi', level: 5 },
      { text: 'は', reading: 'wa', level: 5 },
      { text: '日本語', reading: 'nihongo', level: 5 },
      { text: 'を', reading: 'o', level: 5 },
      { text: '勉強', reading: 'benkyō', level: 4 },
      { text: 'します', reading: 'shimasu', level: 5 },
      { text: '。', reading: '', level: null },
    ],
    traditional: null,
  },
  {
    start: 6,
    gloss: 'It is very difficult.',
    tokens: [
      { text: 'とても', reading: 'totemo', level: 5 },
      { text: '難しい', reading: 'muzukashii', level: 4 },
      { text: 'です', reading: 'desu', level: 5 },
      { text: '。', reading: '', level: null },
    ],
    traditional: null,
  },
  {
    start: 9,
    gloss: 'Nice weather today, is it not.',
    tokens: [
      { text: '今日', reading: 'kyō', level: 4 },
      { text: 'は', reading: 'wa', level: 5 },
      { text: 'いい', reading: 'ii', level: 5 },
      { text: '天気', reading: 'tenki', level: 4 },
      { text: 'です', reading: 'desu', level: 5 },
      { text: 'ね', reading: 'ne', level: 5 },
      { text: '。', reading: '', level: null },
    ],
    traditional: null,
  },
];

/** Level count for the ramp. The real panel takes it from the active list. */
const LEVEL_COUNT = 6;

// --- Tone style -------------------------------------------------------------
//
// A display choice, and the reason it is a setting rather than a formatting
// detail: tone marks are nicer to look at and harder to search for, numbers are
// the reverse. Neither is wrong.

/** The tone-mark form is the input, since that is how the dictionary stores it. */


// --- State ------------------------------------------------------------------

const state = {
  layout: 'above',
  tones: 'marks',
  script: false,
  lang: 'zh',
};

const els = {
  narrow: document.getElementById('rp-transcript-narrow'),
  wide: document.getElementById('rp-transcript-wide'),
  statusNarrow: document.getElementById('rp-status-narrow'),
  statusWide: document.getElementById('rp-status-wide'),
  note: document.getElementById('rp-note'),
  script: document.getElementById('rp-script'),
};

const NOTES = {
  above: 'Readings sit above each word, ruby style. Every glyph keeps its place, so the line reads as one unit — but the row is taller and the gloss is pushed down.',
  below: 'Readings on their own line under the text. Cheaper to build, and it reads as a conversion rather than as annotation: the eye has to travel between the two.',
  marked: 'Readings only on marked words — the ones above your level. The row height is unchanged, and the annotation lands exactly where the marks already are.',
  popover: 'Nothing in the row. Readings stay on hover, which is where they already are. Zero cost, and nothing is shown unless asked for.',
};

// --- Rendering --------------------------------------------------------------

/**
 * One row, in the panel's own markup.
 *
 * Cloned from `buildRow` in `sidepanel.js` rather than invented, because the
 * point of this page is to see the layout in the real thing — a bespoke markup
 * would be styled by the real stylesheet into something that does not exist.
 *
 * @param {object} row
 * @param {HTMLElement} container The transcript this row belongs to, so the
 *   active state is scoped to one column rather than shared between them.
 */
function buildRow(row, container) {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = 'row';
  element.title = 'Jump to this line';

  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = `${Math.floor(row.start / 60)}:${String(row.start % 60).padStart(2, '0')}`;
  element.append(time);

  const lines = document.createElement('span');
  lines.className = 'lines';

  const study = document.createElement('span');
  study.className = 'primary';

  const tokens = state.script && row.traditional
    ? row.tokens.map((t) => ({ ...t, text: convertOne(t.text), reading: t.reading }))
    : row.tokens;

  if (state.layout === 'above') {
    // Ruby: each word becomes a stack of reading then glyphs, so the glyphs keep
    // their horizontal position and only the row grows taller.
    const fragment = document.createDocumentFragment();
    for (const token of tokens) {
      const stack = document.createElement('span');
      stack.className = 'rp-ruby';
      const rt = document.createElement('span');
      rt.className = 'rp-rt';
      rt.textContent = formatReading(token.reading);
      const rb = document.createElement('span');
      rb.className = 'rp-rb';
      rb.append(renderTokens(annotate([token]), LEVEL_COUNT));
      stack.append(rt, rb);
      fragment.append(stack);
    }
    study.append(fragment);
  } else if (state.layout === 'marked') {
    const fragment = document.createDocumentFragment();
    for (const token of tokens) {
      const marked = token.level !== null && token.level >= 3;
      if (!marked) {
        fragment.append(renderTokens(annotate([token]), LEVEL_COUNT));
        continue;
      }
      const stack = document.createElement('span');
      stack.className = 'rp-ruby';
      const rt = document.createElement('span');
      rt.className = 'rp-rt';
      rt.textContent = formatReading(token.reading);
      const rb = document.createElement('span');
      rb.className = 'rp-rb';
      rb.append(renderTokens(annotate([token]), LEVEL_COUNT));
      stack.append(rt, rb);
      fragment.append(stack);
    }
    study.append(fragment);
  } else {
    study.append(renderTokens(annotate(tokens), LEVEL_COUNT));
  }

  lines.append(study);

  if (state.layout === 'below') {
    const reading = document.createElement('span');
    reading.className = 'rp-below';
    reading.textContent = tokens.map((t) => formatReading(t.reading)).join(' ');
    lines.append(reading);
  }

  if (row.gloss) {
    const gloss = document.createElement('span');
    gloss.className = 'secondary';
    gloss.textContent = row.gloss;
    lines.append(gloss);
  }

  element.append(lines);
  element.addEventListener('click', () => {
    // Scoped to the container, so clicking in the narrow column does not also
    // highlight the same row in the wide one — they are separate views of the
    // same content and sharing a highlight between them would be confusing.
    for (const other of container.querySelectorAll('.row')) other.classList.remove('active');
    element.classList.add('active');
  });
  return element;
}

/** @param {string} reading */
function formatReading(reading) {
  if (!reading) return '';
  // Only Chinese pinyin has tones to convert; Rōmaji passes through.
  return state.lang === 'zh' && state.tones === 'numbers' ? pinyinToNumbers(reading) : reading;
}

/**
 * A one-character traditional to simplified conversion, for the toggle.
 *
 * **The mock is not the implementation, and this makes that obvious.** A real
 * conversion needs OpenCC or an equivalent: it is many-to-one (髮 and 發 both
 * become 发), and the boundary between characters is not the only problem —
 * vocabulary differs too, so 軟體 converts to 软体, the right characters for a
 * word mainlanders do not use. This table is here to show what the TOGGLE looks
 * like, not to demonstrate the conversion.
 */
const T2S = {
  終: '终', 於: '于', 媽: '妈', 的: '的', 意: '意', 思: '思', 她: '她',
  搖: '摇', 頭: '头', 沒: '没', 說: '说', 什: '什', 麼: '么', 他: '他',
  那: '那', 個: '个', 城: '城', 市: '市', 比: '比', 北: '北', 京: '京',
  大: '大', 得: '得', 多: '多', 來: '来',
};

/** @param {string} chunk */
function convertOne(chunk) {
  return [...chunk].map((char) => T2S[char] ?? char).join('');
}

/** @param {HTMLElement} target @param {Array} rows */
function renderInto(target, rows) {
  target.textContent = '';
  for (const row of rows) target.append(buildRow(row, target));
  // A row is a button, so the first one takes focus on a fresh render and the
  // page looks like it selected something. Harmless here and worth knowing.
}

function render() {
  const rows = state.lang === 'zh' ? CHINESE : JAPANESE;
  renderInto(els.narrow, rows);
  renderInto(els.wide, rows);

  const label = state.lang === 'zh' ? '拼音' : 'Rōmaji';
  const scriptLabel = state.script ? '简体' : '繁體';
  els.note.textContent = `${NOTES[state.layout]}  ·  Reading shown: ${label}  ·  Script: ${scriptLabel}`;
  els.statusNarrow.textContent = `${rows.length} lines · ${state.lang === 'zh' ? 'Chinese' : 'Japanese'} · preview`;
  els.statusWide.textContent = els.statusNarrow.textContent;
}

// --- Controls ---------------------------------------------------------------

for (const chip of document.querySelectorAll('[data-layout]')) {
  chip.addEventListener('click', () => {
    state.layout = chip.dataset.layout;
    for (const other of document.querySelectorAll('[data-layout]')) {
      other.setAttribute('aria-pressed', String(other === chip));
    }
    render();
  });
}

for (const chip of document.querySelectorAll('[data-tones]')) {
  chip.addEventListener('click', () => {
    state.tones = chip.dataset.tones;
    for (const other of document.querySelectorAll('[data-tones]')) {
      other.setAttribute('aria-pressed', String(other === chip));
    }
    render();
  });
}

for (const chip of document.querySelectorAll('[data-lang]')) {
  chip.addEventListener('click', () => {
    state.lang = chip.dataset.lang;
    for (const other of document.querySelectorAll('[data-lang]')) {
      other.setAttribute('aria-pressed', String(other === chip));
    }
    // Tone numbers are a Chinese thing; the buttons stay but do nothing useful
    // for Japanese, which is itself worth seeing.
    render();
  });
}

els.script.addEventListener('click', () => {
  state.script = !state.script;
  els.script.setAttribute('aria-pressed', String(state.script));
  render();
});

// --- Text size ---------------------------------------------------------------
//
// The panel derives everything from `--font-size` on the root:
// `--text-scale: calc(var(--font-size) / 13px)` yields a plain number, and every
// size in `sidepanel.css` is `calc(Npx * var(--text-scale))`. Setting the same
// variable here means the readings scale exactly as they will in the panel.
//
// This was a real defect first time round: the input showed 14, the content
// rendered at 13, and the one control that decides whether a reading is legible
// did nothing at all.
const sizeInput = document.getElementById('rp-size');

/** @param {number} pixels */
function applyTextSize(pixels) {
  document.documentElement.style.setProperty('--font-size', `${pixels}px`);
}

sizeInput.addEventListener('input', () => {
  const value = Number(sizeInput.value);
  // Ignored while the field is empty or nonsense, rather than snapping to
  // something — the same rule the panel uses, so a half-typed "1" does not
  // briefly render the panel at 1px.
  if (!sizeInput.value.trim() || !Number.isFinite(value) || value < 10 || value > 32) return;
  applyTextSize(value);
});

applyTextSize(Number(sizeInput.value));

render();
