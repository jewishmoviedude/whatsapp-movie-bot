/**
 * Turn a pasted media URL into a request the bot can act on.
 *
 * Admins paste links rather than retyping titles, and a raw URL matches
 * nothing in OMDb or Jellyfin - it just answered "No match". TMDB and Trakt
 * URLs carry the title in the slug and the season/episode in the path, so no
 * API call is needed:
 *
 *   themoviedb.org/tv/60625-rick-and-morty/season/4  -> Rick and Morty, S4
 *   themoviedb.org/movie/693134-dune-part-two        -> Dune Part Two
 *
 * IMDb URLs carry only an id (tt2861424); those are returned with the id so
 * the caller can resolve them through OMDb, which looks up by imdbId.
 *
 * Pure and side-effect free.
 */

/** "60625-rick-and-morty" -> "Rick and Morty" */
function titleFromSlug(slug = '') {
  const words = String(slug)
    .replace(/^\d+-/, '')          // leading TMDB id
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!words) return '';
  // Slugs are lowercased. Title-case for readability, but leave the small
  // joining words alone so it reads like a real title ("Rick and Morty",
  // not "Rick And Morty"). Matching is case-insensitive either way.
  const small = new Set(['a', 'an', 'and', 'the', 'of', 'or', 'in', 'on', 'at', 'to', 'for', 'vs', 'de', 'la']);
  return words.split(' ')
    .map((w, i) => (i > 0 && small.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

/**
 * @returns null when the text is not a media URL, otherwise
 *   { kind: 'tv'|'movie', title, season, episode, tmdbId, imdbId, source }
 */
export function parseMediaUrl(text) {
  const raw = String(text ?? '').trim();
  if (!/^https?:\/\//i.test(raw)) return null;

  let u;
  try { u = new URL(raw); } catch { return null; }
  const host = u.hostname.replace(/^www\./i, '').toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean);

  /* ------------------------------- TMDB ------------------------------- */
  if (host === 'themoviedb.org' || host.endsWith('.themoviedb.org')) {
    const type = parts[0];                       // 'tv' | 'movie'
    const slug = parts[1] ?? '';
    if (!type || !slug) return null;
    const tmdbId = Number(String(slug).match(/^(\d+)/)?.[1] ?? NaN);
    const title = titleFromSlug(slug);

    if (type === 'tv') {
      const si = parts.indexOf('season');
      const ei = parts.indexOf('episode');
      const season = si >= 0 ? Number(parts[si + 1]) : null;
      const episode = ei >= 0 ? Number(parts[ei + 1]) : null;
      return {
        kind: 'tv', title,
        season: Number.isFinite(season) ? season : null,
        episode: Number.isFinite(episode) ? episode : null,
        tmdbId: Number.isFinite(tmdbId) ? tmdbId : null,
        imdbId: null, source: 'tmdb',
      };
    }
    if (type === 'movie') {
      return {
        kind: 'movie', title, season: null, episode: null,
        tmdbId: Number.isFinite(tmdbId) ? tmdbId : null, imdbId: null, source: 'tmdb',
      };
    }
    return null;
  }

  /* ------------------------------- IMDb ------------------------------- */
  if (host === 'imdb.com' || host.endsWith('.imdb.com')) {
    const id = parts.find((p) => /^tt\d+$/i.test(p));
    if (!id) return null;
    // Number(null) is 0, so test for the parameter before converting -
    // otherwise every IMDb link claimed to be "season 0" of a series.
    const rawSeason = u.searchParams.get('season');
    const season = rawSeason != null && rawSeason !== '' ? Number(rawSeason) : null;
    const hasSeason = season != null && Number.isFinite(season);
    return {
      // IMDb does not say in the URL whether it is a film or a series.
      kind: hasSeason ? 'tv' : null,
      title: '', season: hasSeason ? season : null, episode: null,
      tmdbId: null, imdbId: id.toLowerCase(), source: 'imdb',
    };
  }

  /* ------------------------------ Trakt ------------------------------- */
  if (host === 'trakt.tv') {
    const type = parts[0];                       // 'shows' | 'movies'
    const slug = parts[1] ?? '';
    if (!slug) return null;
    const title = titleFromSlug(slug);
    if (type === 'shows') {
      const si = parts.indexOf('seasons');
      const ei = parts.indexOf('episodes');
      const season = si >= 0 ? Number(parts[si + 1]) : null;
      const episode = ei >= 0 ? Number(parts[ei + 1]) : null;
      return {
        kind: 'tv', title,
        season: Number.isFinite(season) ? season : null,
        episode: Number.isFinite(episode) ? episode : null,
        tmdbId: null, imdbId: null, source: 'trakt',
      };
    }
    if (type === 'movies') {
      return { kind: 'movie', title, season: null, episode: null, tmdbId: null, imdbId: null, source: 'trakt' };
    }
  }

  return null;
}

/**
 * Rewrite a pasted URL into the plain text the request pipelines understand,
 * e.g. "Rick and Morty season 4". Returns null when there is nothing usable.
 */
export function urlToRequestText(text) {
  const p = parseMediaUrl(text);
  if (!p || !p.title) return null;
  if (p.kind === 'tv') {
    if (p.season != null && p.episode != null) {
      return `${p.title} S${String(p.season).padStart(2, '0')}E${String(p.episode).padStart(2, '0')}`;
    }
    if (p.season != null) return `${p.title} season ${p.season}`;
  }
  return p.title;
}
