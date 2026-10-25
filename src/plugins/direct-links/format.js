/**
 * Building the reply for the direct-links group.
 *
 * This group gets URLs rather than files, so the rating gate does not apply -
 * nothing is being delivered. Restricted titles still carry a disclaimer,
 * because a link posted in a group reaches whoever is in it.
 *
 * A season's links go in ONE message: fifteen episodes must not become fifteen
 * messages. Pure and side-effect free.
 */
import { pad } from '../tv-requests/parse.js';

/** Ratings that get a warning line above the links. */
export const DEFAULT_RESTRICTED = ['R', 'NC-17', 'X', 'TV-MA', 'MA', '18'];

export function isRestricted(rating, restricted = DEFAULT_RESTRICTED) {
  const r = String(rating ?? '').toUpperCase().trim();
  if (!r) return false;
  return restricted.map((x) => String(x).toUpperCase()).includes(r);
}

/**
 * A playable URL for one library item.
 *
 * NOTE: the key is embedded in the link, which is what makes it work without a
 * Jellyfin login - and also what makes it worth using a dedicated, revocable
 * key rather than the bot's own.
 */
export function streamUrl(itemId, { base, apiKey, linkType = 'stream' } = {}) {
  const root = String(base ?? '').replace(/\/+$/, '');
  if (!root || !itemId) return null;
  // 'stream' plays in a browser or VLC without saving first, which is what
  // most people want on a phone; 'download' saves the file. Both are the
  // original file - `static=true` means no transcoding.
  const u = linkType === 'download'
    ? new URL(`${root}/Items/${itemId}/Download`)
    : new URL(`${root}/Videos/${itemId}/stream`);
  if (linkType !== 'download') u.searchParams.set('static', 'true');
  if (apiKey) u.searchParams.set('api_key', apiKey);
  return u.toString();
}

/** WhatsApp starts to struggle well before this; split rather than be dropped. */
const MAX_MESSAGE = 3500;

/**
 * One movie -> one message.
 * @returns string
 */
export function movieMessage({ title, year, rating, url, restricted = DEFAULT_RESTRICTED, disclaimer }) {
  const head = `🎬 *${title}${year ? ` (${year})` : ''}*`;
  const lines = [head];
  if (isRestricted(rating, restricted)) lines.push('', disclaimerLine(rating, disclaimer));
  lines.push('', url);
  return lines.join('\n');
}

/** The warning shown above restricted links. */
export function disclaimerLine(rating, disclaimer) {
  const text = String(disclaimer ?? '').trim()
    || 'Not suitable for all audiences. Please use your own discretion — this link is shared for adults who have chosen to receive unfiltered content.';
  return `⚠️ *Rated ${String(rating).toUpperCase()}* — ${text}`;
}

/**
 * A whole season -> ONE message with every episode link.
 *
 * Only split when a message would be too long to send, and say so, rather than
 * silently truncating the list.
 * @returns string[]  usually a single message
 */
export function seasonMessages({
  series, season, episodes, rating, restricted = DEFAULT_RESTRICTED, disclaimer,
}) {
  const header = `📺 *${series}* — Season ${pad(season)}  ·  ${episodes.length} episode${episodes.length === 1 ? '' : 's'}`;
  const warn = isRestricted(rating, restricted) ? disclaimerLine(rating, disclaimer) : null;

  const blocks = episodes.map((e) => {
    const code = `S${pad(e.season ?? season)}E${pad(e.episode)}`;
    const name = String(e.title ?? '').trim();
    return `*${code}*${name ? ` ${name}` : ''}\n${e.url}`;
  });

  const out = [];
  let current = [header, ...(warn ? ['', warn] : []), ''];
  let size = current.join('\n').length;

  for (const b of blocks) {
    if (size + b.length + 2 > MAX_MESSAGE && current.length > 2) {
      out.push(current.join('\n').trim());
      current = [`📺 *${series}* — Season ${pad(season)} (continued)`, ''];
      size = current.join('\n').length;
    }
    current.push(b, '');
    size += b.length + 2;
  }
  out.push(current.join('\n').trim());

  // Number the parts only when there really is more than one.
  if (out.length > 1) {
    return out.map((m, i) => `${m}\n\n_(${i + 1} of ${out.length})_`);
  }
  return out;
}
