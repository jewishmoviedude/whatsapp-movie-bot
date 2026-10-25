import { parseLinkCommand } from './parse.js';
import { movieMessage, seasonMessages, streamUrl, isRestricted, DEFAULT_RESTRICTED } from './format.js';
import { resolveEpisodes } from '../tv-requests/jellyfin-tv.js';
import { listCode, rangeCode } from '../tv-requests/parse.js';
import { findInLibrary, closestNote } from '../movie-requests/library.js';
import { lookupMovie } from '../movie-requests/omdb.js';
import { bestMatch, typedYearOf } from '../../util/fuzzy.js';
import { formatPhone } from '../../core/members.js';

/**
 * Direct-links plugin.
 *
 * A separate group for people who want the URL rather than the file. Because
 * nothing is delivered here, the rating gate does not apply - but restricted
 * titles carry a disclaimer, since a link posted in a group reaches everyone
 * in it.
 *
 * A season answers in ONE message however many episodes it has.
 */
export default {
  name: 'direct-links',
  description: 'Replies with Jellyfin URLs in the direct-links group.',
  configKey: 'directLinks',

  async setup(ctx) {
    const cfg = ctx.config.directLinks ?? {};
    if (!cfg.enabled) { ctx.log.info('direct-links loaded but disabled'); return; }
    // A missing key matters only where links are asked for. It is on by
    // default (2026-10-12), and a new install has neither a group nor a key:
    // the warning came at every start for links nobody could ask for.
    if (!this._apiKey(ctx) && (cfg.groups ?? []).length) {
      ctx.log.warn('direct-links is on but has no API key - links would not play. Set one in the portal.');
    }
    ctx.log.info(`direct-links ready (${(cfg.groups ?? []).length} group(s))`);
  },

  /**
   * The key embedded in every link. A DEDICATED key is strongly preferred: it
   * is published to a group, and can then be revoked in Jellyfin without
   * disturbing the bot's own access.
   */
  _apiKey(ctx) {
    const cfg = ctx.config.directLinks ?? {};
    if (cfg.apiKey) return cfg.apiKey;
    if (!cfg.allowBotKeyFallback) return null;
    const jf = ctx.config.library?.jellyfin ?? {};
    return jf.apiKey || jf.accessToken || null;
  },

  _base(ctx) {
    const cfg = ctx.config.directLinks ?? {};
    const jf = ctx.config.library?.jellyfin ?? {};
    return String(cfg.publicBaseUrl || jf.baseUrl || '').replace(/\/+$/, '');
  },

  async onMessage(msg, ctx) {
    const cfg = ctx.config.directLinks;
    if (!cfg?.enabled) return;
    if (msg.fromMe || !msg.isGroup || !msg.text) return;
    if (!cfg.groups?.includes(msg.chatJid)) return;

    const parsed = parseLinkCommand(msg.text, cfg);
    if (!parsed) return;

    const reply = (text) => ctx.bot.sendText(msg.chatJid, text, { quoted: msg })
      .catch((err) => ctx.log.warn(`direct-links reply failed: ${err.message}`));

    if (parsed.empty) {
      return reply(`Say what you're after, e.g.\n*${cfg.movieCommand || '#request-movie'} The Truman Show 1998*\n*${cfg.tvCommand || '#request-tv'} The Boys S01*`);
    }

    const base = this._base(ctx);
    const apiKey = this._apiKey(ctx);
    if (!base || !apiKey) {
      ctx.log.error('direct-links: no base URL or API key configured');
      return reply('Direct links are not set up yet — an admin needs to add the Jellyfin address and a share key.');
    }

    const restricted = cfg.restrictedRatings ?? DEFAULT_RESTRICTED;
    const q = ctx.linkQueue ?? ctx.queue;
    // Queued rather than run inline: several people asking at once would
    // otherwise fire simultaneous Jellyfin and OMDb lookups, and their replies
    // could interleave. This queue is separate from the media one, so a link
    // request never waits behind a download or an encode.
    q.add({
      kind: 'link',
      label: `${parsed.kind === 'movie' ? '🔗' : '📺'} ${parsed.query}`.slice(0, 60),
      meta: { kind: 'link', request: parsed.query, requester: formatPhone(msg.senderNumber) ?? msg.senderNumberDisplay ?? null },
      run: async (job) => {
        try {
          if (job.isCancelled()) return;
          if (parsed.kind === 'movie') return await this._movie({ parsed, ctx, reply, base, apiKey, restricted, cfg });
          return await this._tv({ parsed, ctx, reply, base, apiKey, restricted, cfg });
        } catch (err) {
          ctx.log.error(`direct-links failed for "${parsed.query}": ${err.message}`);
          await reply(`Couldn't look that up just now — ${err.message}`);
        }
      },
    });
  },

  async _movie({ parsed, ctx, reply, base, apiKey, restricted, cfg }) {
    // Resolve the real title first so "truman show" finds the right film, but
    // never block on rating here - this group only gets a link.
    let title = parsed.title;
    let year = parsed.year;
    let rating = null;
    let resolved = null;
    try {
      // One try, never waited on (`retry: false`, omdb.js): this runs in the
      // link queue, one lookup at a time, so a lookup waiting out an OMDb
      // outage would hold every link asked for after it - for a title and a
      // rating the link goes out without anyway.
      const found = await lookupMovie(parsed.query, { apiKey: ctx.config.omdb?.apiKey, retry: false });
      if (found?.movie) { resolved = found.movie; title = found.movie.title; year = found.movie.year; rating = found.movie.rated; }
    } catch { /* metadata is a nicety here, not a requirement */ }

    // Judged as a film request is: a similar title from a year more than one
    // away is another film, not a link to send for this one (findInLibrary;
    // Barefoot Gen for "Barefoot 2014", 2026-09-29), and so is the same title
    // far from a year typed (Dune 2021 for "Dune 1984"). The reply is
    // unchanged; the log says what the library does hold.
    let otherFilm = null;
    const hit = await findInLibrary(title, year, ctx.config.library, {
      onOtherFilm: (o) => { otherFilm = o; },
      // Only against a film OMDb resolved. Without one, `year` is the number
      // parsed out of the query itself, which typedYearOf would always agree
      // with: "1917" asked for while OMDb was down refused 1917 (2019) as
      // two years from "1917".
      typedYear: resolved ? typedYearOf(parsed.query, resolved) : null,
      // A copy of the same title far from OMDb's year only for words typed
      // as that title: a bare "dune" still gets the Dune held, and "fast and
      // furios 6" no link to Fast & Furious (2009) (whyOtherFilm). Only
      // against a film OMDb resolved, as above: without one there is no
      // year of OMDb's to be far from.
      typed: resolved ? parsed.query : null,
      imdbId: resolved?.imdbId ?? null,
    });
    if (!hit) {
      ctx.log.info(`direct-links: "${parsed.query}" not in the library${otherFilm ? ` (${closestNote(otherFilm)})` : ''}`);
      return reply(`📬 *${title}${year ? ` (${year})` : ''}* isn't on the server.`);
    }

    const url = streamUrl(hit.id, { base, apiKey, linkType: cfg.linkType });
    ctx.log.info(`direct-links: sent a movie link for ${hit.title}${isRestricted(rating, restricted) ? ' (restricted — disclaimer added)' : ''}`);
    return reply(movieMessage({
      title: hit.title ?? title, year: hit.year ?? year, rating, url,
      restricted, disclaimer: cfg.disclaimer,
    }));
  },

  async _tv({ parsed, ctx, reply, base, apiKey, restricted, cfg }) {
    const jf = ctx.config.library?.jellyfin ?? {};
    const opts = {
      base: String(jf.baseUrl ?? '').replace(/\/+$/, ''),
      token: jf.accessToken || jf.apiKey,
      userId: jf.userId,
      bestMatch,
    };
    const found = await resolveEpisodes(
      {
        show: parsed.title, season: parsed.season, episode: parsed.episode,
        episodeRange: parsed.episodeRange ?? null, episodeList: parsed.episodeList ?? null,
      },
      opts,
    );

    if (found.error === 'not-found') return reply(`📬 *${parsed.title}* isn't on the server.`);
    // A list or a run the season has none of is named by its codes, as the
    // TV group names it (_notInLibrary): "#request-tv The Office S01E20,
    // E30" was answered "That episode of *The Office* isn't on the server",
    // one episode, for two (found in review, 2026-10-12).
    const many = parsed.episodeList?.length ? listCode(found.season, parsed.episodeList)
      : parsed.episodeRange ? rangeCode(found.season, parsed.episodeRange.from, parsed.episodeRange.to) : null;
    if (found.error === 'no-such-episode' && many) return reply(`📬 ${many} of *${found.series.name}* aren't on the server.`);
    if (found.error === 'no-such-episode') return reply(`📬 That episode of *${found.series.name}* isn't on the server.`);
    if (found.error === 'empty-season') return reply(`📬 *${found.series.name}* season ${found.season} has no episodes on the server.`);
    if (found.error === 'need-season') {
      const list = (found.seasons ?? []).join(', ');
      return reply(`📺 Which season of *${found.series.name}*?${list ? `\nAvailable: ${list}` : ''}\n\ne.g. *${cfg.tvCommand || '#request-tv'} ${found.series.name} S${String(found.seasons?.[0] ?? 1).padStart(2, '0')}*`);
    }

    const episodes = found.episodes.map((e) => ({
      season: e.season, episode: e.episode, title: e.title,
      url: streamUrl(e.id, { base, apiKey, linkType: cfg.linkType }),
    }));
    // The series rating covers the season; an individual episode may carry its
    // own, so take the strictest thing we saw.
    const rating = found.episodes.find((e) => isRestricted(e.rating, restricted))?.rating
      ?? found.series?.rating ?? null;

    const msgs = seasonMessages({
      series: found.series.name, season: found.season, episodes, rating,
      restricted, disclaimer: cfg.disclaimer,
    });
    ctx.log.info(`direct-links: sent ${episodes.length} link(s) for ${found.series.name} S${found.season} in ${msgs.length} message(s)`);
    for (const m of msgs) await reply(m);
    // The episodes of a list ("S01E06, E30") the season does not have. Each
    // was named, so each is answered, as in the TV group: left out of the
    // links without a word, E30 would read as forgotten (2026-10-12).
    const missing = found.missing ?? [];
    if (missing.length) {
      ctx.log.info(`direct-links: ${found.series.name} has no ${listCode(found.season, missing)}`);
      await reply(`📬 ${listCode(found.season, missing)} of *${found.series.name}* `
        + `${missing.length > 1 ? "aren't" : "isn't"} on the server.`);
    }
    // What the request named that its list could not take - another
    // season's episode, a run typed backwards - as the TV group says it
    // (tv-requests _answerUnread): left out of the links without a word, it
    // read as forgotten (found in review, 2026-10-12).
    const unread = parsed.unread ?? [];
    if (unread.length) {
      const codes = unread.join(', ');
      const many = unread.length > 1 || codes.includes('–');
      ctx.log.info(`direct-links: ${found.series.name}: ${codes} not read with the rest of the request`);
      await reply(`⚠️ No link for ${codes} of *${found.series.name}*: one request is one season, its episodes in order. `
        + `Please ask for ${many ? 'them on their' : 'it on its'} own.`);
    }
  },
};
