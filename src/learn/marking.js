/**
 * Turning segmented tokens into renderable marks.
 *
 * **Extracted from the service worker because the reader needs the same rules.**
 * The worker marks the panel's transcript; the reader marks its own captions. Both
 * must agree about what a mark IS — which words are definable, what a level means,
 * when a reading is attached — or the two surfaces would show different annotations
 * for the same line, which is the kind of divergence nobody would notice until a
 * learner compared them.
 *
 * Pure functions over a dictionary, so they run anywhere. Nothing here touches
 * `chrome.*`, the DOM, or settings storage.
 */

import { lookup, levelOf, readingOf, traditionalOf } from './wordlist.js';

/**
 * Whether a word list can grade a language at all.
 *
 * **Shared by the worker and the reader.** The worker uses it to decide whether to
 * mark at all (and to explain why when it cannot); the reader uses it to pick a list
 * that matches the subtitle track it loaded. Two copies of this would mean the panel
 * and the captions disagreed about which words are markable, which is the drift the
 * shared marking module exists to prevent.
 *
 * The comparison is on the LANGUAGE subtag, with the script subtag considered only
 * when both sides state one. A list that says `zh` covers `zh-Hans` and `zh-Hant`,
 * which is correct because the data holds both forms and `canonical` resolves
 * between them.
 *
 * @param {object|undefined|null} list
 * @param {string|null|undefined} languageCode
 * @returns {boolean}
 */
export function listCoversLanguage(list, languageCode) {
  if (!list?.language || !languageCode) return false;

  const [langA, ...restA] = String(list.language).split('-');
  const [langB, ...restB] = String(languageCode).split('-');

  // Different languages: no coverage, whatever the scripts say.
  if (langA.toLowerCase() !== langB.toLowerCase()) return false;

  // A script subtag is four letters; a region is two or three digits.
  const scriptA = restA.find((part) => part.length === 4);
  const scriptB = restB.find((part) => part.length === 4);

  // The list is vague about the script, so it covers any script — true here because
  // the index holds both forms.
  if (!scriptA) return true;
  // The list states a script and the text does not: unknown, so try rather than
  // refuse a line that may well be markable.
  if (!scriptB) return true;

  return scriptA.toLowerCase() === scriptB.toLowerCase();
}

/**
 * The list to grade a language against, from those available.
 *
 * **The BROADEST list for the language**, not the first one in the index. The index
 * happens to lead with HSK 2.0, which places 4,993 words; HSK 3.0 places 10,969. So
 * "first" would leave 56% of the dictionary unmarked for a reader with no list
 * picker — and the symptom is a transcript that looks barely marked rather than a
 * visibly wrong choice, which is the worst way for it to be wrong.
 *
 * `levelled` is the count the index carries for exactly this: how many words the list
 * places. Comparing it makes the choice a measurement rather than an assumption about
 * ordering.
 *
 * A reader grades against ONE list because it has no list picker (that is a
 * panel-side setting); the panel honours whichever list the learner chose, which is
 * why this takes a language rather than a chosen id.
 *
 * @param {object[]|undefined|null} lists
 * @param {string|null|undefined} languageCode
 * @returns {object|null}
 */
export function listForLanguage(lists, languageCode) {
  if (!Array.isArray(lists) || !lists.length) return null;
  const covering = lists.filter((list) => listCoversLanguage(list, languageCode));
  if (!covering.length) return lists[0];
  return covering.reduce((best, list) =>
    (list.levelled ?? 0) > (best.levelled ?? 0) ? list : best,
  );
}

/**
 * Turn tokens into renderable pieces: text, whether we can define it, a level when
 * the selected list places it at or beyond the threshold, and the reading.
 *
 * `defined` is separate from `level` on purpose, and the distinction is the whole
 * point of keeping the dictionary independent of the graded lists. A word can be
 * perfectly ordinary, absent from the list being used, and still be a word the
 * learner wants defined — 这样 has no HSK 2.0 level but is HSK 3.0 level 2, so on
 * HSK 2.0 it is "definition yes, colour no", not invisible.
 *
 * Conflating the two is what made whole sentences look unmarked.
 *
 * The reading is attached HERE rather than looked up at render time, for the same
 * reason the level is: a second lookup path would be a second place for `canonical`
 * to be forgotten. It is computed only when a reading will be shown, because it is a
 * lookup per token and a transcript is hundreds of them.
 *
 * @param {Array<{text: string, known: boolean}>} tokens
 * @param {object} dictionary
 * @param {object|undefined} list
 * @param {number} threshold
 * @param {boolean} [withReading] Attach `reading` and `traditional`.
 * @returns {Array<{text: string, defined: boolean, level: number|null,
 *   reading?: string|null, traditional?: string|null}>}
 */
export function markLine(tokens, dictionary, list, threshold, withReading = false) {
  return tokens.map((token) => {
    // Only words we hold a definition for are worth making interactive. An unknown
    // token has nothing to show, so it stays plain text.
    const defined = token.known && Boolean(lookup(dictionary, token.text));

    if (!defined || !list) {
      return {
        text: token.text,
        defined,
        level: null,
        ...annotations(defined, withReading, dictionary, token.text),
      };
    }

    const level = levelOf(dictionary, list.id, token.text);
    const marked = level !== null && level >= threshold;
    return {
      text: token.text,
      defined,
      level: marked ? level : null,
      ...annotations(defined, withReading, dictionary, token.text),
    };
  });
}

/**
 * The extra fields a token carries when readings are being shown.
 *
 * Empty when `withReading` is false, so the payload is byte-identical to what it was
 * before readings existed when the setting is off — which means nobody who has not
 * asked for this pays for it.
 *
 * @param {boolean} defined
 * @param {boolean} withReading
 * @param {object} dictionary
 * @param {string} text
 */
export function annotations(defined, withReading, dictionary, text) {
  if (!withReading || !defined) return {};
  return {
    reading: readingOf(dictionary, text),
    // The other script's form, used by the script-conversion display. Kept
    // alongside the reading because both come from the same entry and looking it up
    // twice would be a second lookup for no reason.
    traditional: traditionalOf(dictionary, text),
  };
}
