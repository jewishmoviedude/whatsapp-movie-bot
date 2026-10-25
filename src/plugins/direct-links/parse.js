/**
 * Commands for the direct-links group.
 *
 *   #request-movie The Truman Show 1998
 *   #request-tv The Boys S01
 *
 * Deliberately distinct from the file-delivery commands: someone in this group
 * is asking for a URL, and someone in a request group is asking for a file.
 * Pure and side-effect free.
 */
import { parseTvRequest } from '../tv-requests/parse.js';
import { extractYear } from '../../util/fuzzy.js';

/**
 * @returns null when the text is not one of these commands, otherwise
 *   { kind: 'movie'|'tv', query, title, year, season, episode }
 */
export function parseLinkCommand(text, cfg = {}) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;

  const movieCmd = (cfg.movieCommand || '#request-movie').toLowerCase();
  const tvCmd = (cfg.tvCommand || '#request-tv').toLowerCase();
  const lower = raw.toLowerCase();

  // Check the longer command first: "#request-movie" also starts with
  // "#request", so a shorter prefix would swallow it.
  const cmds = [{ kind: 'movie', cmd: movieCmd }, { kind: 'tv', cmd: tvCmd }]
    .sort((a, b) => b.cmd.length - a.cmd.length);

  for (const { kind, cmd } of cmds) {
    if (!cmd) continue;
    if (lower !== cmd && !lower.startsWith(`${cmd} `)) continue;
    const query = raw.slice(cmd.length).trim();
    if (!query) return { kind, query: '', empty: true };

    if (kind === 'movie') {
      const year = extractYear(query);
      const title = year ? query.replace(new RegExp(`\\b${year}\\b`), '').trim() : query;
      return { kind, query, title: title || query, year: year ?? null };
    }

    const tv = parseTvRequest(query);
    return {
      kind, query,
      title: tv.show || query,
      season: tv.season,
      episode: tv.episode,
      // "S01E01-E05": those episodes, not the whole season the range is in.
      episodeRange: tv.episodeRange ?? null,
      // "S01E06, E09": those two, not the whole season either.
      episodeList: tv.episodeList ?? null,
      // "S01E06, S02E01": what the list could not take, to be named.
      unread: tv.unread ?? null,
    };
  }
  return null;
}

/** True when a message is any direct-links command. */
export function isLinkCommand(text, cfg = {}) {
  return parseLinkCommand(text, cfg) != null;
}
