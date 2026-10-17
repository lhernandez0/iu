/**
 * The ONE resolution of "which track, which list" for a file.
 *
 * **This module exists to end a class of bug, not one instance of it.** Seven times
 * now, the controls and the drawn captions have disagreed, and each time the cause was
 * the same shape: `segments`, `activeTrackLanguage`, and the word list were three
 * separate variables, written by three separate code paths, and every consumer
 * composed its answer from a different subset. `the picker said one track, the
 * captions showed another, the band was empty, the dictionary was missing` are four
 * leaks from that one hole.
 *
 * The worker already got this right for its side: it separates CHOSEN from EFFECTIVE
 * (`effectiveListId`, `markableLanguage`, and the choose-vs-select split) and says so
 * in its own comments. The viewer never adopted that model. So the model is lifted out
 * of the worker into a PURE function here, and both surfaces call it. One rule, one
 * implementation, two callers, so they cannot drift.
 *
 * ## The two rules everything else follows from
 *
 * 1. **A stored language code is a WISH, matched against this file, never displayed.**
 *    `zh-TW` is a valid code, and persists, and may name no track in the file you just
 *    opened. A stale code and a live one are indistinguishable as strings, so the code
 *    is only ever an INPUT to this function; what the function returns is a TRACK, and
 *    the track is what the UI shows. That is why the picker cannot show a value the
 *    captions are not drawing: they read the same returned object.
 *
 * 2. **Resolution returns TRACK IDENTITIES, not codes.** `studyTrack !== glossTrack` is
 *    then true identity, two tracks that share a language code are distinguishable,
 *    and "the same track twice" is impossible to express by accident.
 *
 * Pure: no DOM, no `chrome.*`, no storage. Everything it reads is passed in, so every
 * rule below is testable without a browser and the same call gives the same answer on
 * both surfaces.
 */

import { listCoversLanguage, listForLanguage } from '../learn/marking.js';

/** The language subtag, lowercased, so `zh-Hant` and `zh` compare on `zh`. */
function baseLanguage(code) {
  return String(code ?? '').split('-')[0].toLowerCase();
}

/** The languages this extension has a word list for, and therefore can mark. */
const MARKABLE_BASE = new Set(['zh', 'ja']);

/**
 * A stable identity for a track.
 *
 * **The identity is NOT the language code.** A film can carry two `en` tracks (a full
 * one and a signs-only one), and a language code is not unique across files either, so
 * a code cannot be the key. The caller's own stable field is used when it has one
 * (`trackId`), else a combination that is unique within a file: the container track
 * number for an embedded track, or the source and index for a sidecar.
 *
 * @param {object} track
 * @param {number} [index] Position, used when the track carries no number of its own.
 * @returns {string}
 */
export function trackIdFor(track, index = 0) {
  if (track?.trackId) return String(track.trackId);
  if (track?.trackNumber != null) return `emb:${track.trackNumber}`;
  if (track?.source === 'file') return `file:${index}`;
  return `emb:${track?.languageCode ?? 'und'}`;
}

/**
 * Whether a track can be drawn as text at all.
 *
 * An image track (Blu-ray PGS) is a picture of a subtitle, and this project does not
 * OCR. A track whose read failed is excluded too: it exists in the list but has
 * nothing to show, and pairing the study line with it would draw an empty caption.
 *
 * @param {object} track
 * @returns {boolean}
 */
function isReadableText(track) {
  return track?.kind !== 'image' && !(track?.segments === null && track?.error);
}

/**
 * The track to draw when the learner has not named one.
 *
 * The order is deliberate and unchanged from the viewer's previous behaviour: a
 * language this extension can MARK first, because marking is the point, then any
 * readable text track so a French film still opens with French subtitles, then
 * nothing.
 *
 * @param {object[]} tracks
 * @returns {object|null}
 */
function pickDefaultTrack(tracks) {
  const usable = tracks.filter(isReadableText);
  if (!usable.length) return null;
  return usable.find((track) => MARKABLE_BASE.has(baseLanguage(track.languageCode))) ?? usable[0];
}

/**
 * Match a stored preference to a track in THIS file.
 *
 * **This is the heart of the fix.** The preference may be a language code or a track
 * id; either way it is only a WISH, and if nothing in the file matches it, the answer
 * is null, not the stale string. The caller then falls through to the default, and the
 * RESOLVED track is what everything downstream sees. The stored value is never
 * returned and never displayed, which is what makes "the picker shows a track that is
 * not on screen" impossible rather than merely fixed.
 *
 * A code that matches nothing can still match a track whose code it PREFIXES, so
 * `en` finds `en-US`; this is the one leniency that helps, and it is one-directional
 * (a bare list language covers a specific track, never the reverse).
 *
 * @param {object[]} tracks
 * @param {string|null|undefined} preference
 * @returns {object|null}
 */
function matchTrack(tracks, preference) {
  if (!preference) return null;
  const wanted = String(preference);
  const byId = tracks.find((track, i) => trackIdFor(track, i) === wanted);
  if (byId) return byId;
  const exact = tracks.find((track) => track.languageCode === wanted);
  if (exact) return exact;
  return tracks.find((track) => baseLanguage(track.languageCode) === baseLanguage(wanted)) ?? null;
}

/**
 * The list to grade a language against, from the effective list id or the language.
 *
 * Mirrors the worker's `effectiveListId`: a chosen list that does not cover the
 * language is NOT honoured, because grading English against HSK finds nothing and
 * renders plain captions with no explanation. When the choice cannot apply, the
 * BROADEST list for the language takes over, "first" would leave most of the
 * dictionary unmarked.
 *
 * @param {object[]} lists
 * @param {string|null} chosenListId
 * @param {string|null|undefined} languageCode
 * @returns {object|null}
 */
function resolveList(lists, chosenListId, languageCode) {
  const chosen = chosenListId ? lists.find((list) => list.id === chosenListId) : null;
  if (chosen && listCoversLanguage(chosen, languageCode)) return chosen;
  return listForLanguage(lists, languageCode);
}

/**
 * Resolve the whole decision for one file, once.
 *
 * @param {object} input
 * @param {object[]} input.tracks       This file's tracks, in offer order.
 * @param {{studyLanguage?: string|null, glossLanguage?: string|null, listId?: string|null}} input.preferences
 *   Stored wishes. Codes or ids; matched, never echoed.
 * @param {object[]} [input.lists]      Available word lists.
 * @returns {{
 *   studyTrack: object|null,
 *   glossTrack: object|null,
 *   listId: string|null,
 *   coverage: {studyMarkable: boolean, glossPresent: boolean, reason: string|null},
 * }}
 */
export function resolveMedia({ tracks, preferences = {}, lists = [] }) {
  const all = Array.isArray(tracks) ? tracks : [];

  // Rule 1: the wish is matched against THIS file. A wish that matches nothing is
  // treated as absent, so the default takes over and the stale code is dropped here,
  // where it cannot reach the UI.
  const namedStudy = matchTrack(all, preferences.studyLanguage);
  const studyTrack = namedStudy && isReadableText(namedStudy) ? namedStudy : pickDefaultTrack(all);

  // Rule 2: the gloss is resolved against the SAME list of tracks and then checked
  // for identity, so "the same track twice" cannot happen by accident (the previous
  // code compared two independently-resolved codes and silently blanked on a clash it
  // could not tell from an intentional one).
  const namedGloss = matchTrack(all, preferences.glossLanguage);
  const glossTrack = namedGloss && namedGloss !== studyTrack && isReadableText(namedGloss) ? namedGloss : null;

  // The list follows the STUDY track's language, which is the language the marks are
  // computed against, so the dictionary loaded and the levels applied come from the
  // same list. This is the worker's `effectiveListId` rule, in one place for both.
  const list = resolveList(lists, preferences.listId ?? null, studyTrack?.languageCode ?? null);
  const studyMarkable = Boolean(studyTrack) && listCoversLanguage(list, studyTrack.languageCode);

  return {
    studyTrack,
    glossTrack,
    listId: list?.id ?? null,
    coverage: {
      studyMarkable,
      glossPresent: Boolean(glossTrack),
      // The visible reason when nothing is marked (P6). Silent degradation is what let
      // "no dictionary" look like "plain subtitles" for seven rounds.
      reason: !studyTrack
        ? 'no-track'
        : !studyMarkable
          ? 'no-list-covers-language'
          : null,
    },
  };
}
