/**
 * Video providers.
 *
 * A provider is everything this codebase knows about ONE video site: how to
 * recognise its pages, and which scripts to inject to read a transcript from
 * them. Nothing else in the code should name a site, the service worker talks
 * about "the video in the active tab" and asks here who can read it.
 *
 * This mirrors `src/engines/engine.js`, and the parallel is deliberate: an
 * engine is what turns *speech* into text, a provider is what turns a *page*
 * into captions. Both are seams kept in one folder so the rest of the code does
 * not grow a second copy of the same knowledge.
 *
 * Why the content scripts are not the seam themselves: they are injected as
 * classic scripts and cannot `import`, so each is necessarily site-specific.
 * The seam is the *decision*, which script, for which URL, and that lives
 * here, in a module the worker can import.
 *
 * Adding a site:
 *   1. Add an entry below.
 *   2. Add its `matches` and `host_permissions` to manifest.json so the
 *      declarative path works on a fresh load (injection is the fallback for
 *      tabs that were already open).
 *   3. That is the whole change. The worker, the panel, the cache, the row
 *      model, the alignment and the learning layer are all site-agnostic and
 *      need no edit.
 *
 * @typedef {Object} Provider
 * @property {string} id             Stable key, lowercase. Used in messages and logs.
 * @property {string} name           Human name, for user-facing text.
 * @property {RegExp} url            Matches a document this provider can read.
 * @property {string[]} bridgeFiles  MAIN-world scripts to inject, in order.
 * @property {string[]} contentFiles ISOLATED-world scripts to inject, in order.
 */

/** @type {Provider[]} */
const PROVIDERS = [
  {
    id: 'youtube',
    name: 'YouTube',
    // Any youtube.com document. The path is not checked: the player response is
    // reachable from /watch, /shorts and an embed equally, and the content
    // script reads whatever is on the page rather than constructing a URL.
    //
    // Anchored on the host, not the whole string: `[^/]*youtube\.com` would
    // happily match `notyoutube.com`, which means claiming a tab we cannot read
    // and reporting captions that never arrive. The label boundary matters.
    url: /^https:\/\/(?:[a-z0-9-]+\.)*youtube\.com(:\d+)?(?:\/|$)/i,
    bridgeFiles: ['src/content/page-bridge.js'],
    contentFiles: ['src/content/youtube-content.js'],
  },
];

/**
 * The provider that can read `url`, or null.
 *
 * Null is a normal answer, not an error: most tabs are not videos.
 *
 * @param {string|null|undefined} url
 * @returns {Provider|null}
 */
export function providerFor(url) {
  if (!url) return null;
  return PROVIDERS.find((provider) => provider.url.test(url)) ?? null;
}

/** @returns {string[]} Every provider id, in registration order. */
export function listProviderIds() {
  return PROVIDERS.map((provider) => provider.id);
}

/**
 * The provider names, joined for a sentence: "YouTube", "YouTube or Bilibili",
 * "YouTube, Bilibili or Netflix".
 *
 * Exists so that user-facing text can say which sites are supported without
 * hardcoding one. With the single provider registered today it returns exactly
 * "YouTube", so the messages read as they always did.
 *
 * @returns {string}
 */
export function providerNames() {
  const names = PROVIDERS.map((provider) => provider.name);
  if (names.length <= 1) return names[0] ?? 'video';
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}
