/**
 * Queue a film straight from a Jellyfin URL.
 *
 * The library search is fuzzy and sometimes wrong - OMDb canonicalises a title
 * the library spells differently, and the film is reported missing when it is
 * right there. Rather than making an admin fight the matcher, this takes the
 * URL of the item itself: the id is unambiguous, so there is nothing left to
 * guess.
 *
 * Any Jellyfin URL carrying an item id works - the Download link, a stream
 * link, or the /web/#/details?id= address from the browser.
 */

/** Pull the item id out of whatever Jellyfin URL was pasted. */
export function parseJellyfinUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;

  // A bare 32-char hex id is fine too - it is what the URLs all contain.
  if (/^[0-9a-f]{32}$/i.test(raw)) return { id: raw.toLowerCase(), base: null };

  let url;
  try { url = new URL(raw); } catch { return null; }

  // /Items/<id>/Download, /Videos/<id>/stream, /Items/<id>/...
  const path = url.pathname.match(/\/(?:Items|Videos)\/([0-9a-f]{32})\b/i);
  // /web/#/details?id=<id>  - the hash is not part of searchParams
  const hash = url.hash.match(/[?&]id=([0-9a-f]{32})\b/i);
  const query = url.searchParams.get('id');

  const id = path?.[1] ?? hash?.[1] ?? (/^[0-9a-f]{32}$/i.test(query ?? '') ? query : null);
  if (!id) return null;

  return { id: id.toLowerCase(), base: `${url.protocol}//${url.host}` };
}

/**
 * A pasted URL usually carries an api_key. It must never be stored or logged -
 * the bot has its own credentials, and a key in the request history or the
 * debug log is a key that leaks.
 */
export function stripSecrets(input) {
  const raw = String(input ?? '');
  return raw.replace(/([?&])(api_key|apikey|X-Emby-Token)=[^&\s]*/gi, '$1$2=***');
}
