import log from '../../util/logger.js';

const logger = log.scope('theatrical');
const DAY = 86_400_000;

/**
 * "Is it in theaters only?"
 *
 * There is no field anywhere that says this - it is the *absence* of a home
 * release. So we answer it in order of reliability:
 *
 *   1. TMDB release_dates (optional, free key)  - authoritative. TMDB records
 *      release types per country: 3=Theatrical, 4=Digital, 5=Physical.
 *      A digital/physical date in the past means it has left theatrical-only.
 *   2. OMDb's DVD field                          - decent, but frequently stale
 *      or "N/A" for recent films, so it can only ever prove the negative.
 *   3. Release-age heuristic                     - if it came out within
 *      `windowDays`, assume it is still theatrical.
 *
 * Returns { theatricalOnly: boolean, reason: string, source: string, confidence }.
 */
export async function isTheatricalOnly(movie, cfg, { signal } = {}) {
  const t = cfg.theatrical ?? {};
  if (!t.enabled) {
    return { theatricalOnly: false, reason: 'theatrical check disabled', source: 'config', confidence: 1 };
  }

  const now = Date.now();

  // Not out yet at all - treat as unavailable, same outcome as theatrical-only.
  if (movie.released && movie.released.getTime() > now) {
    return {
      theatricalOnly: true,
      reason: `not released yet (${movie.released.toISOString().slice(0, 10)})`,
      source: 'omdb',
      confidence: 0.95,
    };
  }

  // 1. TMDB - the only source that actually answers this directly.
  if (t.tmdbApiKey) {
    try {
      const verdict = await checkTmdb(movie, t.tmdbApiKey, signal, t.windowDays ?? 180);
      if (verdict) return verdict;
    } catch (err) {
      logger.warn(`TMDB check failed, falling back: ${err.message}`);
    }
  }

  // 2. OMDb home-release date.
  if (t.useHomeReleaseDate && movie.dvd) {
    if (movie.dvd.getTime() <= now) {
      return {
        theatricalOnly: false,
        reason: `home release ${movie.dvd.toISOString().slice(0, 10)}`,
        source: 'omdb-dvd',
        confidence: 0.9,
      };
    }
    return {
      theatricalOnly: true,
      reason: `home release not until ${movie.dvd.toISOString().slice(0, 10)}`,
      source: 'omdb-dvd',
      confidence: 0.9,
    };
  }

  // 3. Age heuristic.
  if (movie.released) {
    const ageDays = (now - movie.released.getTime()) / DAY;
    // 180 days unless set, the default since 2026-10-12 (schema.js).
    const windowDays = t.windowDays ?? 180;
    if (ageDays < windowDays) {
      return {
        theatricalOnly: true,
        reason: `released ${Math.round(ageDays)} days ago, inside the ${windowDays}-day theatrical window`,
        source: 'heuristic',
        confidence: 0.6,
      };
    }
    return {
      theatricalOnly: false,
      reason: `released ${Math.round(ageDays)} days ago, past the theatrical window`,
      source: 'heuristic',
      confidence: 0.7,
    };
  }

  // Nothing to go on. Fail open so an unknown date does not silently block
  // an old catalogue title.
  return { theatricalOnly: false, reason: 'no release date available', source: 'none', confidence: 0.3 };
}

export async function checkTmdb(movie, apiKey, signal, windowDays = 180) {
  if (!movie.imdbId) return null;

  const findUrl = new URL(`https://api.themoviedb.org/3/find/${movie.imdbId}`);
  findUrl.searchParams.set('api_key', apiKey);
  findUrl.searchParams.set('external_source', 'imdb_id');

  const findRes = await fetch(findUrl, { signal });
  if (!findRes.ok) throw new Error(`TMDB find HTTP ${findRes.status}`);
  const found = await findRes.json();
  const tmdbId = found.movie_results?.[0]?.id;
  if (!tmdbId) return null;

  const relUrl = new URL(`https://api.themoviedb.org/3/movie/${tmdbId}/release_dates`);
  relUrl.searchParams.set('api_key', apiKey);
  const relRes = await fetch(relUrl, { signal });
  if (!relRes.ok) throw new Error(`TMDB release_dates HTTP ${relRes.status}`);
  const rel = await relRes.json();

  const us = rel.results?.find((r) => r.iso_3166_1 === 'US') ?? rel.results?.[0];
  if (!us) return null;

  const now = Date.now();
  // type 4 = Digital, 5 = Physical, 6 = TV
  const homeRelease = us.release_dates
    .filter((d) => [4, 5, 6].includes(d.type))
    .map((d) => Date.parse(d.release_date))
    .filter((t) => !Number.isNaN(t) && t <= now)
    .sort((a, b) => a - b)[0];

  if (homeRelease) {
    return {
      theatricalOnly: false,
      reason: `TMDB digital/physical release ${new Date(homeRelease).toISOString().slice(0, 10)}`,
      source: 'tmdb',
      confidence: 0.97,
    };
  }

  const theatrical = us.release_dates
    .filter((d) => [2, 3].includes(d.type))
    .map((d) => Date.parse(d.release_date))
    .filter((t) => !Number.isNaN(t))
    .sort((a, b) => a - b)[0];

  // TMDB lacking a US digital/physical date says nothing about an old film:
  // The Cutting Edge 3 (2008, a TV movie) was answered "still in theaters"
  // on 2026-10-19 because of it. Past the window, fall through to the other
  // checks, which call an old film available.
  if (theatrical && theatrical <= now && (now - theatrical) / DAY < windowDays) {
    return {
      theatricalOnly: true,
      reason: `TMDB shows a theatrical release but no home release yet`,
      source: 'tmdb',
      confidence: 0.95,
    };
  }

  return null;
}

/** Is this rating on the blocklist? Handles OMDb's inconsistent spellings. */
/**
 * The strings OMDb and Jellyfin use when nobody has classified a film.
 * These are NOT a clean bill of health - an unrated file is one no board has
 * looked at, and treating that as safe is how Nymphomaniac: Vol. I went out
 * as "Not Rated" while Kill Me Three Times was blocked for being R.
 */
const UNRATED = ['NOT RATED', 'UNRATED', 'NR', 'N/A', 'NONE', 'NO RATING', 'UNKNOWN'];

export function isUnrated(rated) {
  const norm = String(rated ?? '').trim().toUpperCase().replace(/^RATED\s+/, '');
  return !norm || UNRATED.includes(norm);
}

/**
 * @param blockUnrated when true, a film nobody has classified is treated as
 *   blocked rather than allowed. Off by default so existing installs do not
 *   change behaviour without being asked.
 */
export function isBlockedRating(rated, blockedList, { blockUnrated = false } = {}) {
  if (isUnrated(rated)) return !!blockUnrated;
  const norm = String(rated).trim().toUpperCase().replace(/^RATED\s+/, '');
  return blockedList.some((b) => String(b).trim().toUpperCase() === norm);
}
