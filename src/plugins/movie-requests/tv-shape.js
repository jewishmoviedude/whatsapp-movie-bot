/**
 * Whether a film request is really asking for a TV show.
 *
 * Its own module so the wanted list's recheck (src/core/wanted-recheck.js) can
 * judge an entry by the rule the request path records it by, without loading
 * the whole movie plugin.
 */
import { parseTvRequest, stripTrailingYear } from '../tv-requests/parse.js';
import { cleanRequestText, normalizeTitle } from '../../util/fuzzy.js';

/**
 * Is this film request really asking for a show? `{ show, season, why }`, or
 * null for a film.
 *
 * On 2026-09-14 Gary asked the movie group for "2 broke girls season 2".
 * OMDb's title lookup (type=movie) answered with a 29-minute extra it files
 * as a movie, "2 Broke Girls: Season 2 - 2 Broke Girls at PaleyFest 2013"
 * (tt8259160). The library had no such film, the "is it a series?" check
 * searched Jellyfin for the whole of "2 broke girls season 2" and missed 2
 * Broke Girls, which the TV library holds, and so a DVD extra went on the
 * wanted list as a film somebody wanted, where it still was on 2026-10-11.
 *
 * A request that names a season - the TV plugin's own explicit markers
 * (parseTvRequest: "season 2", "S02", "S02E05", "2x05"), never a bare number
 * or "episode 4" alone, which film titles use - asks for a show, unless those
 * words are the film's own title: "open season 2" is Open Season 2 (2008).
 * A record OMDb files as a series or an episode is a show too; every lookup
 * asks for type=movie, so that is only a backstop.
 */
export function tvShapeOf(text, movie = null) {
  const parsed = parseTvRequest(String(text ?? ''));
  const show = stripTrailingYear(parsed.show).show;
  const type = String(movie?.type ?? '').toLowerCase();
  if (type === 'series' || type === 'episode') {
    return { show: show || cleanRequestText(String(text ?? '')), season: parsed.season ?? null, why: `OMDb files it as ${type === 'episode' ? 'an episode' : 'a series'}` };
  }
  if (parsed.season == null || !show) return null;
  // "ocean's 11" reads to the TV parser as season 11 of "ocean'": an "s"
  // after an apostrophe is a possessive, and the number is the film's.
  if (/['’]$/.test(show)) return null;
  const typed = [cleanRequestText(text), cleanRequestText(text, { keepMediaWords: true })].map(normalizeTitle);
  if (movie?.title && typed.includes(normalizeTitle(movie.title))) return null;
  return { show, season: parsed.season, why: `it names season ${parsed.season}` };
}
