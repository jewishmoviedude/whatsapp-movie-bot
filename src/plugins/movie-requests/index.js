import fs from 'node:fs';
import path from 'node:path';
import { lookupMovie, isTooBroad, listPlots, OMDB_RETRY_SPAN_MS } from './omdb.js';
import { isTheatricalOnly, isBlockedRating } from './theatrical.js';
import { findInLibrary, researchLibrary, tvItemRefusal, closestNote } from './library.js';
import { asksWhichOne, pickTerms, stepZero, lookupHeldFilm } from './step-zero.js';
import { convertForWhatsApp, fmtBytes, conversionClock } from '../../media/ffmpeg.js';
import { segmentsReady } from '../../media/segmented.js';
import { downloadToFile, safeFilename, fmtDuration } from '../../media/download.js';
import { extractYear, whyOtherFilm, typedYearOf, sameTitleWords, yearsApart } from '../../util/fuzzy.js';
import fsSync from 'node:fs';
import { dirname as pathDir, join as pathJoin } from 'node:path';
import { fileURLToPath as _f } from 'node:url';
import { stageSems, sizeSems, STAGE_PRIORITY, waitReason } from '../../media/stages.js';
import { rulesReplyFor } from './rules.js';
import { checkMessage, violationNotice } from './enforcement.js';
import { applyGroupTag } from '../../core/group-tag.js';
import { recordWanted, resolveWanted, wantedKey, BOT } from '../../core/wanted.js';
import { recordMiss, resolveMiss } from '../../core/library-misses.js';
import { isOverridden, describeOverride } from '../../core/rating-overrides.js';
import { identifyTitle } from './gemini.js';
import { aiCanClear, notClearedWhy } from './content-check.js';
import {
  ratingGate, fileGate, contentGate, contentGateAsks, verifyFileRating, isRequestedFilm,
} from './film-gate.js';
import { providerLabel, CHAIN_LIMITS } from '../../core/ai-providers.js';
import { findSeries } from '../tv-requests/jellyfin-tv.js';
import { parseTvRequest } from '../tv-requests/parse.js';
import { bestMatch, cleanRequestText } from '../../util/fuzzy.js';
import { tvShapeOf } from './tv-shape.js';
import { reactionKind, positionEmoji } from '../../media/reaction-class.js';
import { showPlace } from '../../media/place-reaction.js';
import { stageReaction } from '../../media/stage-reaction.js';
import {
  holdTvRecovery, isTransient, RetryBook, MAX_RETRIES, watchCancelledWhileWaiting, finishedOutput,
} from '../../media/resume.js';
import {
  reserveRoom, waitForRoom, jobNeed, isDiskFull, noteDiskFull, keepRoom, forgetKept,
} from '../../media/disk-space.js';
import {
  isSafeToDeleteIn, openWork, workKey, holdWork, releaseWork, adoptWork, verifyIdentity, probeDownload, itemIdOf, statOf,
} from '../../media/work-files.js';
import { panelRequester, requestMemberKey, formatPhone, phoneOut } from '../../core/members.js';
import { heldMessage } from '../../core/request-pause.js';
import { MemberCooldown, COOLDOWN_LIMITS, cooldownKeys, sweepCooldownKeys, insideCooldown, releaseClock } from '../../core/request-cooldown.js';
import { checkLinkUrl, linkError, linkForDisplay, linkId, inspectLink, makeLinkFetch } from '../../media/public-link.js';
import { inspectPage, downloadPage, isVideoPageHost, ytDlpPaths, fmtLength, SCRATCH as YTDLP_SCRATCH } from '../../media/yt-dlp.js';
import { withCookieCopy } from '../../media/yt-dlp-cookies.js';
import {
  isBetaGroup, resolveRoute, safeRoute, isEnabled,
  readBetaTest, featureGroup, testRequestText, runningTestsLine, isTestRoute, testCodeOf, suggestPrefix, testCodeFor,
} from '../../core/beta.js';
import {
  EDIT_WINDOW_MS, MAX_INVALID_REACTIONS, REOPEN_MIN_MS, CLOSE_RETRY_MS, MAX_CLOSE_ATTEMPTS,
  VERSION_REFUSALS, pickListSettings, requestPrefix, listableVersions, formatPickList, formatPicked,
  formatPickFailed, formatExpired, formatReplaced, needYearNote, parsePick, answersList, sameSender,
  narrowDownText, oneTitle, offeredLabels, plainText, keycapNumber, listMessageIds,
} from './pick-list.js';
import { severalFilms, oneFilmNote, oneFilmReply, oneFilmDetail } from './several-films.js';
import { isStamKey, STAM_CODE } from '../../core/stam-test.js';

/**
 * How a member's answer to a list reads in a log line: the words they typed,
 * or the number they reacted with (a pick by reaction carries no text).
 */
function pickSaid(msg) {
  return msg?.reaction ? `reacted ${msg.reaction.emoji}` : `"${msg?.text ?? ''}"`;
}

/**
 * A hand-queued job's meta: who the queue panel shows it as. The assigned
 * member (panelRequester) and their number, as a request from a group has.
 */
function whoMeta(who) {
  return {
    requester: who.requester, requesterNumber: phoneOut(who.requesterNumberDisplay ?? who.requesterNumber ?? null),
    // No message behind it to react on, whoever it is for (clearWaitingPrompt).
    ...(who.assignedBy ? { assigned: true } : {}),
  };
}
/** " for <member>" on a hand-queued job's log line, when it was assigned. */
function assignedNote(who) {
  return who.assignedBy ? ` for ${who.requester}${who.requesterNumberDisplay ? ` ${phoneOut(who.requesterNumberDisplay)}` : ''} (by ${who.assignedBy})` : '';
}

// The file re-check's rules live in film-gate.js with the other gates; they
// are exported from here too, where the Barefoot fix first put them.

/** History statuses that refuse the title itself; see finish(). */
const REFUSALS = new Set([
  'blocked-rating', 'not-yet-theatrical', 'not-in-library', 'not-found', 'is-a-series', 'need-year', 'one-at-a-time',
]);

export { isOtherFilm, isRequestedFilm } from './film-gate.js';
export { tvShapeOf } from './tv-shape.js';

/**
 * Can this process actually open that file?
 *
 * Existence is not enough - a mount can be present but unreadable by the
 * service user - so the readability check goes with it. Same test
 * findInLibrary applies; kept here so the two paths cannot drift apart again.
 */
function readableHere(p) {
  if (!p) return false;
  try {
    fs.accessSync(p, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Is this actually a TV series the server already has?
 *
 * Asked in a movie group, "outer banks" resolves to an obscure 2012 film that
 * the server does not have, while the series everyone means is sitting in the
 * TV library. Reporting "not in the library" is true of the film and useless
 * to the person asking.
 */
async function seriesInLibrary(text, ctx, diagnostics = [], show = null) {
  const jf = ctx.config.library?.jellyfin ?? {};
  const base = String(jf.baseUrl ?? '').replace(/\/+$/, '');
  const token = jf.accessToken || jf.apiKey;
  if (!base || !token) {
    diagnostics.push('the "is it a series?" check was skipped: Jellyfin is not configured');
    return null;
  }

  // Deliberately NOT gated on tvRequests.enabled any more.
  //
  // It used to be, and that made the answer depend on the wrong thing. The
  // question here is "does the server have this as a series?", which is about
  // the LIBRARY. Whether the TV plugin is switched on decides whether we can
  // send it, not whether it exists - and with the plugin off (the default) the
  // check returned null in silence, so a show sitting in Jellyfin was reported
  // to the requester as not being in the library at all.
  // `show` is the show a request that names a season asks for (tvShapeOf):
  // "2 broke girls season 2" searched whole matched nothing in 8,527 series.
  const found = await findSeries(show || cleanRequestText(String(text)) || String(text).trim(), {
    base, token, userId: jf.userId, bestMatch,
    onDiagnostic: (m) => { diagnostics.push(m); ctx.log.warn(`series check: ${m}`); },
  });
  return found?.id ? found : null;
}

/** The beta.js feature that words the answer to a film asked for twice. */
const DUPLICATE_FEATURE = 'movie-duplicate-notice';

/**
 * How long a member's next film request waits for one of theirs still being
 * looked up (src/core/request-cooldown.js, rule 2): the longest that lookup
 * can take. The AI check's whole chain is CHAIN_LIMITS.totalMs (45 s), the
 * library search's own ceiling is library.searchTimeoutMs (180 s by
 * default), and a minute more covers OMDb and the rest. The longest film
 * lookup in the logs of 2026-09-29 to 10-01 took 41 s, so this bites only on
 * a lookup that has hung; giving up sooner would let the next request run
 * beside it, and both could queue (found in review, 2026-10-01, on the TV
 * side, where a minute was shorter than a real lookup).
 *
 * Since 2026-10-12 an OMDb call that meets a failure of the moment waits
 * and tries again, for up to OMDB_RETRY_SPAN_MS (omdb.js; "First daughter
 * 2004" got ⚠️ for an outage of under 90 seconds), so the wait allows for
 * that too. Only one call in a lookup waits between tries while OMDb is
 * down: once one has used up its tries, the rest try once. (A try that
 * hangs is given the rest of its call's span, no longer: that is the hung
 * lookup above, shorter than fetch's own five minutes.)
 */
const FILM_LOOKUP_WAIT_MS = CHAIN_LIMITS.totalMs + 180_000 + 60_000 + OMDB_RETRY_SPAN_MS;

/** Where a film request's file goes: the main posts group, or one beta group. */
function destinationOf(route) {
  return route?.beta ? `beta:${route.postsGroup ?? ''}` : 'main';
}

/**
 * Who judged a film, for its History row, whichever way it went: a fallback
 * provider clears a rated film only where the operator ticked it, and "which
 * model said this was clean?" is the first question after a film goes out
 * that should not have.
 */
function contentCheckRecord(verdict, call = null) {
  return {
    provider: verdict.provider ?? 'gemini',
    by: providerLabel(verdict.provider),
    model: verdict.model ?? null,
    nudity: verdict.nudity,
    confidence: verdict.confidence,
    basis: verdict.basis || null,
    ...(call?.note ? { note: call.note } : {}),
  };
}

/**
 * The same film, whoever asked for it: by IMDb id when both have one, and
 * otherwise - a film queued from a Jellyfin link has none - by title and year.
 */
/** A file's size, or null when it is not there. */
function fileSize(p) {
  try { return fs.statSync(p).size; } catch { return null; }
}

function sameFilm(a, b) {
  if (!a || !b) return false;
  if (a.imdbId && b.imdbId) return a.imdbId === b.imdbId;
  const norm = (t) => String(t ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return !!norm(a.title) && norm(a.title) === norm(b.title) && String(a.year ?? '') === String(b.year ?? '');
}

/**
 * Guard against ever deleting the library's own copy.
 *
 * When Jellyfin's storage is mounted here, the source file IS the user's
 * original. We only ever remove files inside our own work directory, and
 * never anything under a configured library root - nor the work directory
 * itself, nor a directory holding a library root (media/work-files.js).
 */
export function isSafeToDelete(target, ctx) {
  return isSafeToDeleteIn(target, {
    workDir: ctx?.config?.media?.workDir, roots: ctx?.config?.library?.local?.roots ?? [],
  });
}

/*
 * A film's work: its files, in a directory named from its job's key, with a
 * manifest saying how far it got (media/work-files.js). The key is the
 * journal's jobKey - the request's message and the film - which a restart
 * keeps, so a resumed film finds what it had done. The Parent Trap
 * (2026-09-29) was downloaded, 2.62 GB, and 23 minutes into its encode when
 * the bot restarted; it was downloaded again from the first byte, twice.
 */
function filmWork(ctx, jobKey, label = null) {
  const workDir = ctx.config?.media?.workDir;
  if (!workDir || !jobKey) return null;
  return openWork({
    workDir, key: workKey.movie(jobKey), kind: 'movie', label, isSafe: (p) => isSafeToDelete(p, ctx), keptKey: jobKey,
  });
}

/**
 * Starts that may try to put a journalled film back in the queue, each dying
 * before it has, before the film is given up (see _recoverFilms).
 */
export const MAX_RECOVERIES = 3;

/** A journal entry without the count of the starts that tried to put it back. */
function settled(p) {
  const { recoveries, ...rest } = p ?? {};
  return rest;
}

/**
 * A film's name as the pipeline says it: "Plandemic (2020)", or just the
 * title when nobody gave a year - a public link queued from the panel may
 * have none, and "(null)" is not a year.
 */
function filmLabel(movie) {
  return `${movie?.title ?? '?'}${movie?.year ? ` (${movie.year})` : ''}`;
}

/**
 * The "library copy" of a public link, as deliver() takes one. Its id is a
 * hash of the URL, not the URL: the work manifest records it, and the query
 * can be a token. `publicLink` is what makes deliver() fetch it through the
 * checked fetch (_linkFetch).
 */
function publicHit(link) {
  let host = '?';
  try { host = new URL(link.url).host; } catch { /* checked when queued */ }
  return {
    id: linkId(link.url), provider: link.via === 'yt-dlp' ? `${link.site ?? host} via yt-dlp` : `a public link (${host})`,
    access: 'download', publicLink: true,
    container: link.container ?? 'mp4', size: link.size ?? null,
    downloadUrl: link.url, downloadHeaders: {}, sameTitled: [],
    // A page yt-dlp reads the video out of (media/yt-dlp.js), not a file.
    ...(link.via === 'yt-dlp' ? { ytdlp: { site: link.site ?? null, id: link.videoId ?? null, extractor: link.extractor ?? null } } : {}),
  };
}

/** A library copy as verifyIdentity compares it with what a job's work recorded. */
function copyNow(copy) {
  const local = copy?.access === 'local';
  return {
    provider: copy?.provider ?? null, id: itemIdOf(copy), access: local ? 'local' : 'download',
    librarySize: copy?.size ?? null, localPath: local ? copy.localPath : null,
  };
}

/**
 * Movie request plugin.
 *
 * Metadata checks (rating, theatrical window) run immediately so the blocking
 * reactions land right away. Only the heavy part - fetch, convert, upload -
 * goes through the shared serial queue, one film at a time.
 */
// Stage concurrency now lives in media/stages.js so the TV pipeline shares the
// SAME limits - otherwise a movie and an episode would each start an ffmpeg.

export default {
  name: 'movie-requests',
  description: 'Watches request groups, vets titles by rating and release window, then posts the file.',
  configKey: 'movieRequests',

  async setup(ctx) {
    ctx.log.info('movie-requests ready');
    // Cooldown clocks from before 2026-10-01 and answers long out of the
    // window are never read again (request-cooldown.js).
    try {
      const cleared = sweepCooldownKeys(ctx.store);
      if (cleared) ctx.log.info(`cleared ${cleared} cooldown entr${cleared === 1 ? 'y' : 'ies'} that can no longer apply`);
    } catch (err) { ctx.log.warn(`could not clear old cooldown entries: ${err.message}`); }
    // Seed the rules text from the bundled default the first time.
    if (!ctx.config.movieRequests.rules) {
      try {
        const dir = pathDir(_f(import.meta.url));
        const def = fsSync.readFileSync(pathJoin(dir, 'default-rules.txt'), 'utf8').trim();
        if (def) ctx.configStore.update({ movieRequests: { rules: def } });
        ctx.log.info('seeded group rules from default-rules.txt');
      } catch (err) { ctx.log.warn(`could not seed rules: ${err.message}`); }
    }

    // Live queue-position reactions: each waiting request's message gets a
    // number reaction (1..N) that the bot updates in place as it advances.
    //
    // At most one pass a tick, however many events the tick had. A job that
    // starts the moment it is queued - a film retried at the front of the
    // line after its send was lost - fires 'added' and then 'updated' in one
    // breath: every waiting request one place back, then forward again. Each
    // pass asked for their numbers, paced and counted against the outbound
    // budget, only for them to be withdrawn at their turn. The TV side does
    // the same (_positionsSoon), where any film that started as soon as it
    // was queued did this to every TV request waiting.
    this._reactors = new Map();               // jobId -> { msg, lastEmoji }
    if (!this._queueHooked) {
      this._queueHooked = true;
      const onQ = () => {
        if (this._positionsTimer) return;
        this._positionsTimer = setImmediate(() => {
          this._positionsTimer = null;
          try { this._updatePositions(ctx); } catch (err) { ctx.log.warn(`queue positions: ${err.message}`); }
        });
      };
      ctx.queue.on('added', onQ);
      ctx.queue.on('updated', onQ);
      ctx.queue.on('state', onQ);
    }
    // A job cancelled or skipped before it started never runs, so deliver()
    // never takes it out of the journal (see _cancelledWhileWaiting).
    this._unwatchCancels?.();
    this._unwatchCancels = watchCancelledWhileWaiting(ctx.queue, (e) => this._cancelledWhileWaiting(ctx, e));
    // The work directory is swept at start by src/index.js, before any
    // plugin loads, sparing the work of every job either journal holds
    // (media/work-files.js sweepWorkDir): recovery resumes each from there.
    sizeSems(ctx.config);

    // The queue lives in memory, so a restart would otherwise silently drop
    // anything waiting. Pending jobs are journalled to disk and replayed -
    // but only once WhatsApp is up, or the job would spend several minutes
    // downloading and converting before failing at the send.
    //
    // Open "which one?" lists are journalled the same way (there were five
    // restarts on 2026-09-22 alone), and recovered after the jobs: a list that
    // ran out while the bot was down gets its final reaction, and one still
    // running is re-armed with the time it has left. Not awaited: the overdue
    // ones are paced a few seconds apart, and plugin loading must not wait
    // on that.
    //
    // TV recovery waits until the films are back in the queue (see
    // holdTvRecovery), so the hold is released however recovery ends.
    //
    // What there is to recover is decided now, not at the connect: a job
    // journalled by THIS process in between - queued from the panel, or a
    // request whose first run failed "not connected" and booked its own
    // retry - is in the queue or on its way back, and replaying it as the
    // last process's leftover queued it a second time.
    const leftover = new Set((ctx.store.get('pending', []) ?? []).map((p) => p.jobKey));
    // The queue is told now what will come back, before either plugin puts
    // anything back (see _expectBack).
    this._expectBack(ctx, leftover);
    const releaseTv = holdTvRecovery(ctx.queue);
    this._releaseTv = releaseTv;
    if (ctx.bot.isConnected()) {
      try { await this.recoverPending(ctx, { leftover }); } finally { releaseTv(); }
      this.reconcileHistory(ctx);
      this.recoverPickLists(ctx).catch((e) => ctx.log.error(`pick-list recovery failed: ${e.message}`));
    } else {
      const onState = (st) => {
        if (st.state !== 'connected') return;
        ctx.bot.off('state', onState);
        this.recoverPending(ctx, { leftover })
          .finally(releaseTv)
          .then(() => this.reconcileHistory(ctx))
          .then(() => this.recoverPickLists(ctx))
          .catch((e) => ctx.log.error(`recovery failed: ${e.message}`));
      };
      ctx.bot.on('state', onState);
      this._onState = onState;
      this._ctx = ctx;
    }
  },

  async onConfigChange(config) {
    sizeSems(config);
  },

  /**
   * Post a live text update to the notifications group. Tags the requester
   * with an @mention only when they are a member of that group; otherwise the
   * message goes out untagged. `step` gates it against the notify.steps config.
   *
   * A request from a beta group is reported in THAT group instead, and never
   * in the main notifications group: the main group is where real members
   * follow real requests, and a tester's "Inception - converting" does not
   * belong there. The beta group gets its play-by-play even when the main one
   * is switched off, because watching every step is what the test is for; the
   * per-step switches still apply, so it reads the way production would.
   *
   * The stored route is re-checked against today's config on every call
   * (safeRoute): once the beta group has itself become a main group, a test
   * has nothing more to say there.
   */
  async _notify(ctx, step, text, record, { tagGroup = null } = {}) {
    const n = ctx.config.movieRequests.notify ?? {};
    const route = safeRoute(ctx.config, record?.route);
    const target = route ? route.notifyGroup : n.group;
    if (!target) {
      if (route) ctx.log.debug(`🔔 notify [${step}] (beta) withheld - the beta group is now a main group: ${text}`);
      return;
    }
    if (step && n.steps && n.steps[step] === false) return;
    if (!ctx.bot.isConnected()) return;

    let body = text;
    let mentions = null;
    let tagged = false;
    let groupMentions = null;

    const reqDigits = String(record?.requesterNumber ?? '').replace(/[^0-9]/g, '');
    const muted = (n.noTag ?? []).some((x) => String(x).replace(/[^0-9]/g, '') === reqDigits);
    if (!muted && n.tagRequester !== false && (record?.requesterNumber || record?.requesterJid)) {
      const info = ctx.bot.groupMemberInfo(target, {
        jid: record.requesterJid,
        number: record.requesterNumber,
      });
      if (info.isMember && info.mentionJid) {
        body = `@${info.mentionText} ${body}`;
        mentions = [info.mentionJid];
        tagged = true;
      }
    }
    // Tag the posts group itself so people can tap straight through to it.
    // Done last so it survives the requester-mention rewrite above. A beta
    // request only ever links to its own destination, whatever the caller
    // passed - checked here because every notification comes through here.
    const tag = route ? (tagGroup ? route.postsGroup : null) : tagGroup;
    ({ body, groupMentions } = applyGroupTag(ctx.bot, {
      body, notifyGroup: target, tagGroup: tag, enabled: n.tagPostsGroup !== false,
    }));

    try {
      await ctx.bot.sendText(target, body, { mentions, groupMentions });
      ctx.log.info(`🔔 notify [${step}]${route ? ' (beta)' : ''} ${tagged ? `tagged ${phoneOut(record.requesterNumber)}` : 'no tag'}` +
        `${groupMentions ? ' +group' : ''}: ${text}`);
    } catch (err) {
      ctx.log.warn(`notify (${step}) failed: ${err.message}`);
    }
  },

  /** Emoji for a 1-based queue position. */
  _positionEmoji(cfg, pos) {
    return positionEmoji(cfg.reactions, pos);
  },

  /** Shared with the TV pipeline - see src/media/reaction-class.js */
  _reactionKind(cfg, emoji) {
    return reactionKind(cfg?.reactions, emoji);
  },

  /**
   * Re-react each waiting request with its current place in line, updating
   * only when the number actually changed (to avoid needless reaction spam),
   * and forget each one as it leaves the line.
   *
   * How a number is sent - 'low', recorded only once it has really gone, one
   * at a time per request, and dropped at its turn with the pacer if it is out
   * of date by then - is src/media/place-reaction.js, shared with TV.
   */
  _updatePositions(ctx) {
    if (!this._reactors || !this._reactors.size) return;
    const cfg = ctx.config.movieRequests;
    const snap = ctx.queue.snapshot?.();
    if (!snap) return;

    // Each film's place is the queue's own (`place`): the order things will
    // really start, which is what _nextEligibleIndex follows. With strict
    // movie priority on, every waiting film starts before any TV, so that is
    // its place among the films, as it always was. With it off, TV requests
    // that arrived first really do start first - and counting among the
    // films only, a film and the TV request ahead of it both showed 1️⃣ (the
    // TV side numbers by `place`).
    const moviePending = snap.pending.filter((e) => (e.kind ?? 'movie') !== 'tv');
    const waiting = new Set(moviePending.map((e) => e.id));
    const running = new Set((snap.active ?? []).map((e) => e.id));
    for (const [id, r] of [...this._reactors]) {
      if (waiting.has(id)) continue;
      // Started, finished or cancelled. Once it has started, the stage
      // reactions own the message, so a number still waiting with the pacer
      // is withdrawn at its turn rather than landing on the ⬇️.
      r.gone = true;
      this._reactors.delete(id);
      this._handOn(ctx, r.resent, running.has(id));
    }
    // Front of the line first, so the pacer gets to the nearest ones soonest.
    moviePending.forEach((entry, i) => {
      const r = this._reactors.get(entry.id);
      if (!r) return;
      const place = this._positionEmoji(cfg, entry.place ?? i + 1);
      const at = (x) => (safeRoute(ctx.config, x.route)?.originIsMain ? null : place);   // see onMessage
      if (r.msg) showPlace(ctx.bot, r, at(r));
      // The member's own request, sent again while it waits, shows the same
      // number (_resentFilm). After a restart it comes back from the
      // journal with the number it last showed, so a start sends it nothing
      // while its place is unchanged (_resendPlace).
      if (r.resent === undefined) r.resent = this._resendPlace(ctx, entry.meta?.jobKey);
      if (r.resent) showPlace(ctx.bot, r.resent, at(r.resent));
    });
  },

  /**
   * The place record (place-reaction.js) for the latest message that sent a
   * journalled film's request again, from its own member (_resentFilm), or
   * null. One message, not every one: each is a reaction on every move of
   * the line, and a loop over them would be one more loop of reactions that
   * nothing paces (CLAUDE.md rule 1). An earlier one keeps the number it
   * showed, and gets the film's outcome with the rest (_tellFollowers).
   *
   * It comes back showing the number journalled as landed on it
   * (_resendShown), so a restart sends it nothing while its place has not
   * moved. Restored as showing nothing, every start sent each such message
   * its number again beside the film's own: four films waiting, each sent
   * again once, were eight reactions at every start where they had been
   * four, and a crash loop repeats them (found in review, 2026-10-11).
   */
  _resendPlace(ctx, jobKey) {
    if (!jobKey) return null;
    const entry = (ctx.store.get('pending', []) ?? []).find((p) => p.jobKey === jobKey);
    const f = [...(entry?.followers ?? [])].reverse().find((x) => x?.resend && x.msgKey);
    if (!f) return null;
    return {
      msg: { id: f.msgId, key: f.msgKey, chatJid: f.chatJid },
      lastEmoji: f.shown ?? null,
      route: f.route ?? null,
      onShown: this._resendShown(ctx, jobKey, f.msgId),
    };
  },

  /**
   * Note on the journalled follower `msgId` of film `jobKey` the number that
   * has landed on it (place-reaction.js onShown), for _resendPlace after a
   * restart. Written on the follower in place: the journal entry and the
   * film's in-memory record share its followers (_addFollowers).
   */
  _resendShown(ctx, jobKey, msgId) {
    return (emoji) => {
      try {
        const pending = ctx.store.get('pending', []) ?? [];
        const entry = pending.find((p) => p.jobKey === jobKey);
        const f = (entry?.followers ?? []).find((x) => x?.resend && x.msgId === msgId);
        if (!f || f.shown === emoji) return;
        f.shown = emoji;
        ctx.store.set('pending', pending);
      } catch (err) { ctx.log?.debug?.(`could not journal the place shown on ${msgId}: ${err.message}`); }
    };
  },

  /**
   * A film has left the line, and the message that followed its place
   * (_resentFilm) is moved on: to ⬇️ when it has started - left alone, the
   * number would say "next" through the whole download, encode and send -
   * and to nothing when it was cancelled or finished, whose outcome
   * _tellFollowers gives it. As the TV side moves a duplicate's message on
   * (tv-requests _updatePositions). The outcome is 'critical' and this is
   * not, so an outcome that came quickly would be sent first and the ⬇️
   * would then sit on the finished request: it is withdrawn at its turn
   * once _tellFollowers has spoken.
   *
   * Whether or not its number ever landed. Such a message shows the 🎬 it
   * was given first (_resentFilm) or a number, both out of date once the
   * film runs. Moved on only once a number had landed, a message whose
   * number the budget shed - 'low', the first thing it drops - or withdrew
   * at its turn because the film had just started, stayed on 🔍 to the end
   * (found in review, 2026-10-11).
   */
  _handOn(ctx, f, started) {
    if (!f) return;
    f.gone = true;
    const R = ctx.config.movieRequests?.reactions ?? {};
    if (!started || !R.downloading) return;
    if (safeRoute(ctx.config, f.route)?.originIsMain) return;
    const handoffs = (this._handoffs ??= new Map());
    handoffs.set(f.msg.id, f);
    Promise.resolve(ctx.bot.react(f.msg, R.downloading, {
      kind: this._reactionKind(ctx.config.movieRequests, R.downloading), unless: () => !!f.ended,
    }))
      .catch(() => {})
      .finally(() => { if (handoffs.get(f.msg.id) === f) handoffs.delete(f.msg.id); });
  },

  async teardown() {
    if (this._onState && this._ctx) {
      this._ctx.bot.off('state', this._onState);
      this._onState = null;
    }
    this._releaseTv?.();
    this._unwatchCancels?.();
    this._unwatchCancels = null;
    if (this._positionsTimer) clearImmediate(this._positionsTimer);
    this._positionsTimer = null;
    // The lists themselves are journalled; only their timers die with us.
    for (const t of this._pickTimers?.values() ?? []) clearTimeout(t);
    this._pickTimers?.clear();
    // So are the jobs waiting on a retry: the next start replays them.
    this._retries?.clear();
  },

  /**
   * Re-enqueue jobs that were still outstanding when the process last
   * stopped. The library match is looked up again rather than restored from
   * disk: it is cheap, and it avoids replaying a stale download URL or an
   * access token that has since been rotated.
   *
   * `leftover` is the set of jobKeys the last process left, noted at setup
   * (see there); without it, everything journalled now is recovered.
   */
  async recoverPending(ctx, { leftover = null } = {}) {
    const all = ctx.store.get('pending', []) ?? [];
    const pending = leftover ? all.filter((p) => leftover.has(p.jobKey)) : all;
    // What the queue was told to expect back (_expectBack) and is neither
    // back nor waiting for a retry once recovery ends will not come back from
    // here: its kept slot and its place go. Each way out of the journal lets
    // go of its own (_journalRemove, _park); this is for whatever else ends
    // recovery, an entry gone from the journal since setup among them.
    const letGo = () => {
      for (const key of leftover ?? pending.map((p) => p.jobKey)) {
        if (!this._retries?.isWaiting(key)) ctx.queue?.forgetExpected?.(key);
      }
    };
    if (!pending.length) { letGo(); return; }

    ctx.log.warn(`recovering ${pending.length} job(s) interrupted by a restart`);
    // Their work is held while recovery runs, as well as journalled: a film
    // that leaves the journal on its way to being resumed again (a failed
    // re-queue, put back as a retry) is never swept in between.
    const workDir = ctx.config.media?.workDir ?? null;
    const keys = pending.map((p) => workKey.movie(p.jobKey));
    holdWork(keys);
    try {
      await this._recoverFilms(ctx, all, pending, workDir);
    } finally {
      for (const k of keys) releaseWork(k);
      this._recovering = null;
      letGo();
    }
  },

  /**
   * Tell the queue what the last process left (queue.expectBack), before
   * anything is put back: each film's member, when it was asked for, and
   * whether it had started (_startOf). From then its place in the fair order
   * counts, and a film that had started has its slot kept until it is back.
   *
   * Put back one at a time, the films used to be ranked by what was back
   * when each came: TV goes back after the films (holdTvRecovery), and in
   * review of the Thor change (2026-10-11) Ethan's waiting film, ranked
   * before his running season was back, came back as his first and started
   * in the free slot. The TV plugin does the same for its seasons.
   */
  _expectBack(ctx, leftover) {
    if (typeof ctx.queue?.expectBack !== 'function') return;
    const list = [];
    for (const p of ctx.store.get('pending', []) ?? []) {
      if (leftover && !leftover.has(p.jobKey)) continue;
      let started = false;
      try { started = this._startOf(ctx, p) != null; } catch (err) {
        ctx.log?.warn?.(`could not tell whether "${p.movie?.title}" had started: ${err.message}`);
      }
      list.push({ key: p.jobKey, meta: p.meta ?? null, at: Number(p.at) || null, started, label: filmLabel(p.movie ?? {}) });
    }
    try { ctx.queue.expectBack(list); } catch (err) { ctx.log?.warn?.(`could not tell the queue what comes back: ${err.message}`); }
  },

  /**
   * When a journalled film had first started, or null if it had not.
   *
   * Its journal entry says (_journalStarted), and a version that records
   * starts writes 0 on every entry until then (_journalAdd). Only an entry
   * journalled before starts were recorded has nothing to say, and its work
   * on disk answers instead - only a run makes any - from when that was
   * begun. Never work begun before the film was asked for: that came from
   * another request, a parked one this one took the place of
   * (_supersedeParked). Read for every entry, the work had a request that
   * never started come back running in review of the Thor change
   * (2026-10-11): Heat, holding a parked request's work from 13:00, took the
   * one slot ahead of the film that really had been running.
   */
  _startOf(ctx, p) {
    const at = Number(p?.startedAt);
    if (at > 0) return at;
    if (p?.startedAt != null) return null;
    const w = filmWork(ctx, p?.jobKey, p?.movie?.title);
    if (!w?.has()) return null;
    const made = Number(w.manifest.createdAt) || 0;
    const asked = Number(p.at) || 0;
    if (made && asked && made < asked) return null;
    return made || asked || 1;
  },

  async _recoverFilms(ctx, all, pending, workDir) {
    // Nothing leaves the journal until it is dealt with. It used to be
    // cleared first, and each film put back only as it was resumed - one at
    // a time, each after a library lookup and a rating check over the
    // network. A restart in between (The Parent Trap's second restart,
    // 2026-09-29, came 11 seconds after the first) left every film not yet
    // put back in no journal at all: the next start's sweep deleted their
    // downloads and pieces, nothing resumed them, and nobody was told.
    //
    // What the clearing was for is kept this way: each film is stamped with
    // the starts that have tried to put it back, on the disk before anything
    // is awaited, and the stamp goes once one has (_resume). A film that no
    // start has managed to put back MAX_RECOVERIES times - its recovery is
    // what stops the process - is given up, and says so.
    for (const p of pending) p.recoveries = (Number(p.recoveries) || 0) + 1;
    ctx.store.set('pending', all);
    ctx.store.flush?.();
    const R = ctx.config.movieRequests?.reactions ?? {};
    for (const p of pending.filter((q) => q.recoveries > MAX_RECOVERIES)) {
      const why = `the bot stopped ${p.recoveries - 1} times while putting it back in the queue after a restart`;
      ctx.log.error(`giving up on "${p.movie?.title}": ${why}`);
      const followers = this._takeFollowers(ctx, p.jobKey, p);
      this._journalRemove(ctx, p.jobKey);
      if (p.record?.id) this.upsertHistory(ctx, { ...p.record, status: 'failed', detail: why });
      await this._reactFor(ctx, p)(R.failed);
      this._tellFollowers(ctx, followers, { status: 'failed', why, emoji: R.failed });
    }
    pending = pending.filter((q) => q.recoveries <= MAX_RECOVERIES);
    const journalled = new Set(ctx.store.get('pending', []) ?? []);
    const since = all.filter((p) => !pending.includes(p) && journalled.has(p));

    // A finished file kept by a version before job directories: named from
    // the time and the queue's job id, nothing ties it to the library file
    // it came from, and the start-up sweep has cleared it anyway.
    for (const p of pending) {
      if (!p.ready) continue;
      ctx.log.warn(`the finished file kept for "${p.movie?.title}" was made before this version and cannot be tied `
        + 'to a library file; making it again');
      delete p.ready;
    }

    // A film a beta group queued before tests stopped downloading is not
    // resumed: resuming it would download, convert and send a test in front
    // of real requests, which is what the operator's rule is there to stop
    // (2026-09-29, beta.js). Its row says why, and its message gets ❌.
    const tests = pending.filter((p) => isTestRoute(p.record?.route));
    for (let i = 0; i < tests.length; i += 1) {
      const p = tests[i];
      const why = 'a beta test queued before tests stopped downloading — not resumed; ask again with its code to test it';
      ctx.log.warn(`not resuming "${p.movie?.title}" - ${why}`);
      // Out of the journal, with whatever work it had: recovery no longer
      // clears the journal before it looks at a film (_recoverFilms).
      const followers = this._takeFollowers(ctx, p.jobKey, p);
      this._journalRemove(ctx, p.jobKey);
      if (p.record?.id) this.upsertHistory(ctx, { ...p.record, status: 'cancelled', detail: why, finishedAt: Date.now() });
      const emoji = ctx.config.movieRequests?.reactions?.cancelled;
      this._tellFollowers(ctx, followers, { status: 'cancelled', why, emoji });
      // One reaction per job, in a loop: paced like any bulk work (CLAUDE.md rule 1).
      if (i > 0) await ctx.bot._bulkPace?.();
      await this._reactFor(ctx, p)(emoji);
    }
    const real = pending.filter((p) => !tests.includes(p));

    // A film journalled twice for one destination is resumed once: for the
    // earliest request, or not at all when a request made since this start
    // has it already. The live journal held two "Minority Report" jobs on
    // 2026-09-28, from requests made before the duplicate check, and a
    // restart would have run both - two 4.75 GB downloads side by side, and
    // the film posted twice.
    const unique = [];
    for (const p of real) {
      const twin = [...since, ...unique].find((q) => destinationOf(q.record?.route) === destinationOf(p.record?.route)
        && sameFilm(q.movie, p.movie));
      if (!twin) { unique.push(p); continue; }
      ctx.log.warn(`"${p.movie?.title}" is journalled by an earlier request as well - not resuming it twice`);
      // Its work is not thrown away when the one resumed has none: it is the
      // same film, as far as it got. Otherwise it goes. The one resumed
      // checks it against the library before building on it, as its own.
      if (unique.includes(twin) && workDir) {
        const how = adoptWork({
          workDir, fromKey: workKey.movie(p.jobKey), toKey: workKey.movie(twin.jobKey),
          isSafe: (f) => isSafeToDelete(f, ctx), keptKey: p.jobKey,
        });
        if (how === 'adopted') ctx.log.info(`"${twin.movie?.title}" takes over the work the other request had done`);
      } else this._dropWork(ctx, p.jobKey);
      // Its requester, and any that followed it, hear how the one resumed ends.
      this._addFollowers(ctx, twin, this._asFollowers(p));
      // One request now, the earlier one's, so it is not counted twice
      // against its member in the fair order.
      ctx.queue?.forgetExpected?.(p.jobKey, { ran: false });
      // Out of the journal: its work is dealt with above.
      this._journalRemove(ctx, p.jobKey, { keepWork: true });
      if (p.record?.id) {
        this.upsertHistory(ctx, {
          ...p.record, status: 'duplicate',
          detail: 'already in the queue from an earlier request — not resumed twice after a restart',
        });
      }
    }

    // A film that had started before the restart is still running, and goes
    // back in as running (queue.add `startedBefore`): ahead of every film
    // waiting, whatever its rank in the fair order, never held behind the
    // TV, and with no place number. Put back as one more waiting request,
    // Thor: The Dark World - started at 14:54 UTC on 2026-10-11, downloaded
    // by 14:56 - came back at 15:22 as its member's second request, held
    // behind the TV and ranked behind every first request, while Ocean's
    // Eleven, queued at 15:18, started in the free slot.
    //
    // Its journal entry says when it started (deliver, _journalStarted), or
    // for an entry journalled before that was recorded, its work (_startOf).
    // That answer is written on the entry, which goes back in the journal as
    // it is put back, so a restart in the middle of this one reads the same.
    //
    // Those go back in first, in the order they had started, so each takes
    // a free slot before anything waiting can; then the rest, in the order
    // they were journalled (a stable sort). The fair order ranks those by
    // when each was asked for, as it ranked them before (queue.expectBack).
    // The room the work of each holds is kept for it meanwhile, as for a
    // retry's (disk-space.js keepRoom), so work asked for since does not take
    // what it still has to write.
    const media = ctx.config.media;
    const began = new Map();
    for (const p of unique) {
      const at = this._startOf(ctx, p);
      if (at != null) began.set(p.jobKey, at);
      p.startedAt = at ?? 0;
      const w = filmWork(ctx, p.jobKey, p.movie?.title);
      if (!w?.has()) continue;
      const it = w.manifest.item;
      const made = finishedOutput(w)?.size ?? null;
      const need = jobNeed({
        workDir, kind: 'movie', sourceBytes: it.total ?? it.librarySize ?? null, download: it.access !== 'local',
        maxOutputBytes: media.maxOutputBytes, segmented: media.segmentedEncode !== false,
      });
      keepRoom(p.jobKey, { dir: workDir, jobDir: w.dir, peak: need.peak, made, label: p.movie?.title });
    }
    const startOf = (p) => began.get(p.jobKey) ?? Infinity;
    unique.sort((a, b) => (startOf(a) === startOf(b) ? 0 : startOf(a) - startOf(b)));
    const started = unique.filter((p) => began.has(p.jobKey)).length;
    if (started) {
      ctx.log.info(`${started} of them had started before the restart - running again ahead of the ${unique.length - started} waiting`);
    }

    // On their way back in: a request for one of them meanwhile is a
    // duplicate (_filmWaiting), which the journal says already.
    this._recovering = unique;
    for (const p of unique) {
      try {
        await this._resume(ctx, p, { startedBefore: began.get(p.jobKey) ?? null });
      } catch (err) {
        // Jellyfin or OMDb away for a minute as the bot starts is not the
        // film's fault. It used to be dropped for good here - its kept file
        // deleted, its row "lost" and no reaction on the member's message:
        // "Film Number C" lost to one "fetch failed" in review scenario
        // f-recovery. It stays in the journal, its work and all, and is tried
        // again in this process once WhatsApp is connected, as a failed retry
        // is (_retryNow) - or, with no attempts left, at the next start.
        if (isTransient(err)) {
          this._journalAdd(ctx, settled(p));
          // A film that had started comes back from its retry as it would
          // have from here: running, ahead of the waiting line, in the slot
          // the queue keeps for it until then (queue.expectBack). One that
          // had not, as the retry it always was.
          if (began.has(p.jobKey)) (this._interrupted ??= new Map()).set(p.jobKey, began.get(p.jobKey));
          const attempt = this._retryLater(ctx, p.jobKey, err);
          if (attempt) {
            ctx.log.warn(`could not resume "${p.movie?.title}" yet (${err.message}) - trying again `
              + `(attempt ${attempt} of ${MAX_RETRIES})`);
          } else {
            ctx.log.warn(`could not resume "${p.movie?.title}" yet (${err.message}) - left for the next start`);
            this._park(ctx, p.jobKey);
          }
          // Where it is, never 🔄: a member read the 🔄 a restart put on
          // Iron Man 3 (2026-10-11) as "send it again", and was given 🤥 for
          // doing so (media/stage-reaction.js). Out of the queue until it is
          // tried again, so the stage its work has reached, or 🎬.
          await this._reactFor(ctx, p)(this._whereNow(ctx, p));
          continue;
        }
        // Anything else is final: out of the journal, as abandon() in
        // _resume takes a film out, with its work, its History row and its
        // requester told.
        ctx.log.error(`could not resume "${p.movie?.title}": ${err.message}`);
        const why = `could not be resumed after a restart: ${err.message}`;
        const followers = this._takeFollowers(ctx, p.jobKey, p);
        this._journalRemove(ctx, p.jobKey);
        if (p.record?.id) this.upsertHistory(ctx, { ...p.record, status: 'failed', detail: why });
        await this._reactFor(ctx, p)(R.failed);
        this._tellFollowers(ctx, followers, { status: 'failed', why, emoji: R.failed });
      } finally {
        releaseWork(workKey.movie(p.jobKey));
      }
    }
  },

  /**
   * Put one journalled job back in the queue: after a restart, from
   * recoverPending, or in this process after a transient failure, from
   * _retryNow - `retry` is then the attempt number. Both go through here so
   * a retried job is rebuilt exactly as a resumed one is. Returns whether it
   * was queued.
   *
   * `startedBefore` is when a film resumed after a restart had started
   * before it (_recoverFilms): it goes back in as running (queue.add), with
   * no place in the waiting line and no number - from a retry too, when the
   * first try to put it back failed (_retryNow).
   */
  async _resume(ctx, p, { retry = 0, startedBefore = null } = {}) {
    // A job that cannot go back in leaves the journal, with its row closed.
    const abandon = (why) => {
      this._retries?.forget(p.jobKey);
      const followers = this._takeFollowers(ctx, p.jobKey, p);
      this._journalRemove(ctx, p.jobKey);
      if (p.record?.id) this.upsertHistory(ctx, { ...p.record, status: 'failed', detail: why });
      this._tellFollowers(ctx, followers, { status: 'failed', why, emoji: ctx.config.movieRequests?.reactions?.failed });
    };

    // Posted before the restart, and stopped before it could say so: it
    // needs nothing from the library - which may have moved on meanwhile, and
    // whose answer used to decide whether the film was made and posted again
    // - and is finished as posted.
    let posted = false;
    try { posted = this._postedBefore(ctx, p.jobKey, p.record); } catch { /* its run decides (BETA_WITHHELD) */ }
    if (posted) {
      await this._finishPosted(ctx, p);
      return false;
    }

    // A public link an admin queued goes back in as it was queued: from its
    // link, not looked for in a library it never came from, and with no
    // rating check, which it never had (queuePublicLink). deliver() asks the
    // link whether its file is still the one the kept download began.
    if (p.publicLink?.url) return this._resumePublicLink(ctx, p, { retry, startedBefore });

    let otherFilm = null;
    const hit = await findInLibrary(p.movie.title, p.movie.year, ctx.config.library, {
      alsoTry: [p.record?.request].filter(Boolean),
      onOtherFilm: (o) => { otherFilm = o; },
      imdbId: p.movie?.imdbId ?? null,
    });
    if (!hit) {
      ctx.log.warn(`cannot resume "${p.movie.title}" - no longer in the library${otherFilm ? ` (${closestNote(otherFilm)})` : ''}`);
      abandon('no longer in the library');
      return false;
    }
    const msg = { id: p.msgId, key: p.msgKey, chatJid: p.chatJid };
    const react = this._reactFor(ctx, p);

    // Re-verify the rating against the file we would actually resend, in
    // case the original job was vetted on a different film than the
    // library returns (the misspelled-title bypass).
    const rc = await verifyFileRating(hit, p.movie, ctx.config.movieRequests,
      { omdbKey: ctx.config.omdb.apiKey, log: ctx.log });
    // A film on the bypass list is sent past a file its rating blocks, with
    // no AI check (fileGate, then contentGate). The same file is not refused
    // after a restart for that rating - so long as the list still covers it,
    // and it is the same film.
    const listed = rc.blocked && !rc.mismatch && isOverridden(ctx.store, rc.movie, hit);
    // Nor a film the AI check cleared when it was asked for: it has been
    // cleared, and "A retry or a restart puts back what was queued, without
    // asking again" (docs/operations.md). Once the check could send an R film
    // no entry covers, such a film whose library copy carries another year
    // (The Last Samurai, held as 2006) was queued, and then dropped "rated R
    // (library file)" at every restart and every retry - reproduced in review
    // of that change (2026-09-29), before it shipped. Only the film that was
    // cleared, though: a copy now identified as another film of that title
    // was never asked about.
    const cleared = rc.blocked && !rc.mismatch && !!p.record?.aiCleared && sameFilm(rc.movie, p.movie);
    if (rc.blocked && !listed && !cleared) {
      ctx.log.warn(`not resuming "${p.movie.title}" - library file is rated ${rc.rated}`);
      await react(ctx.config.movieRequests.reactions.rated);
      abandon(`rated ${rc.rated} (library file)`);
      return false;
    }
    const resumeMovie = rc.movie ?? p.movie;
    // The journalled record carries the route a beta request was given
    // when it arrived, and it is kept as it is. Re-deciding it from today's
    // config would turn a beta job into a main one if its group had been
    // taken off the beta list while the bot was down - and post a test
    // request to the real posts group.
    const record = { ...p.record, status: 'queued', title: resumeMovie.title, year: resumeMovie.year, rated: resumeMovie.rated };

    // The requester is told their old message is being picked back up -
    // after it is queued, below. What it had done before the restart is in
    // its work (see recoverPending), which deliver() builds on.

    // Journalled as resumed, which replaces its entry rather than adding a
    // second (see _journalAdd) - and without the stamp of the starts that
    // tried to put it back (_recoverFilms): this one has.
    this._journalAdd(ctx, { ...settled(p), resumedAt: Date.now() });

    // Past the queue limit: this job was accepted before, and the limit is a
    // brake on new requests, not on work already promised. At 01:36 UTC on
    // 2026-09-28 recovered TV episodes had filled the queue, and "Doctor
    // Strange" and "Ready Player One" were refused with "Queue is full (104
    // waiting)".
    let queued;
    try {
      queued = ctx.queue.add({
        // Started before the restart: running again, ahead of the waiting
        // line (see _recoverFilms) - a retry of putting it back as well
        // (_retryNow). Otherwise a retry goes first of all, ahead of a
        // running season's remaining episodes too (see queue.add).
        ...(startedBefore ? { startedBefore } : retry ? { retry: 'failed' } : {}),
        // The place the restart left it (_expectBack).
        rankKey: p.jobKey,
        label: `${resumeMovie.title} (${resumeMovie.year})`,
        meta: {
          ...p.meta,
          jobKey: p.jobKey,
          resumed: true,
          ...(retry ? { retry } : {}),
          // A job journalled before 2026-10-01 holds the number as
          // "+1 (555) 807-0190"; it comes back as +15558070190 (phoneOut).
          requesterNumber: phoneOut(p.meta?.requesterNumber
            ?? p.record?.requesterNumberDisplay ?? p.record?.requesterNumber ?? null),
        },
        run: (job) => this.deliver({
          msg, movie: resumeMovie, hit, ctx, job, record, react, jobKey: p.jobKey,
        }),
      }, { overLimit: true });
    } catch (err) {
      // Not queued, so not journalled either. The films refused that night
      // had been re-journalled first, and the next start (06:43) replayed all
      // three - a Doctor Strange and two Ready Player Ones nobody could see
      // waiting, which an admin cancelled by hand. Its work is the caller's
      // to keep or drop: recovery puts a job back after a transient failure.
      this._journalRemove(ctx, p.jobKey, { keepWork: true });
      throw err;
    }
    this._interrupted?.delete(p.jobKey);
    // A retry goes back where it was, at the front: it was running when the
    // connection went, ahead of everything still waiting - and it may have a
    // finished film on disk that is only waiting to be sent. One that had
    // started before a restart is running already (see above).
    if (retry && !startedBefore) ctx.queue.moveTop?.(queued);
    // A film resumed after a restart gets its place in line, as a request
    // that has just arrived does. Only new requests were ever tracked, so
    // after every restart the whole line sat on 🔄 with no number until each
    // one started. Not a retry: it was running when it failed, its message
    // shows its stage for that, and it goes back in at the front. Not a film that
    // had started before the restart: it is running, not in the line, and
    // Thor: The Dark World's 1️⃣ on 2026-10-11 put a place number back on a
    // film downloaded half an hour before. Not a job queued from the panel
    // either, which has no message to put a number on.
    else if (p.msgKey && !startedBefore) {
      this._reactors?.set(queued, { msg, lastEmoji: null, route: record.route ?? null });
      this._updatePositions(ctx);
    }
    // Its old message shows where it is now, rather than a stale reaction -
    // by its place in line when it is waiting for one: the number says as
    // much, and a second reaction as well, replaced by the number seconds
    // later, doubled what every start sent (4 films, 8 reactions; 30, 60),
    // and a crash loop repeats it at each start. Otherwise by the stage it is
    // at (_whereNow): Iron Man 3, downloaded before the 15:22 restart on
    // 2026-10-11, was given 🔄 here, which its member took for "send it
    // again" - and was answered 🤥 when he did. One reaction for one, as the
    // 🔄 was, and deliver() does not send the same stage again (_reactFor).
    // A retry is showing its stage already, from the failure.
    if (!retry) {
      const numbered = !!p.msgKey && !!this._reactors?.has(queued)
        && !safeRoute(ctx.config, record.route)?.originIsMain
        && (ctx.queue.snapshot?.().pending ?? []).some((e) => e.id === queued);
      if (!numbered) await react(this._whereNow(ctx, p, { queued }));
    }
    ctx.log.info((retry
      ? `retrying "${p.movie.title}" (attempt ${retry} of ${MAX_RETRIES})`
      : `resumed "${p.movie.title}"${record.route?.beta ? ' (beta request)' : ''}`)
        + (startedBefore ? ` - it had started at ${new Date(startedBefore).toISOString().slice(11, 16)} UTC, `
          + 'so it runs again ahead of the waiting line' : ''));
    return true;
  },

  /**
   * _resume for a public link (queuePublicLink): the same journal and queue
   * steps, with the hit rebuilt from the journalled link. A panel job has no
   * message, so nothing is reacted to. The link is not asked about here:
   * deliver() does, before it goes on from a kept download (verifyIdentity),
   * and a link that is gone then fails the job with the reason in History.
   */
  _resumePublicLink(ctx, p, { retry = 0, startedBefore = null } = {}) {
    const movie = p.movie;
    const record = { ...p.record, status: 'queued' };
    this._journalAdd(ctx, { ...settled(p), resumedAt: Date.now() });
    let queued;
    try {
      queued = ctx.queue.add({
        ...(startedBefore ? { startedBefore } : retry ? { retry: 'failed' } : {}),
        rankKey: p.jobKey,
        label: filmLabel(movie),
        meta: {
          ...p.meta, jobKey: p.jobKey, resumed: true, ...(retry ? { retry } : {}),
          ...(p.meta?.requesterNumber ? { requesterNumber: phoneOut(p.meta.requesterNumber) } : {}),
        },
        run: (job) => this.deliver({
          msg: { id: p.msgId, key: null, chatJid: p.chatJid },
          movie, hit: publicHit(p.publicLink), ctx, job, record, react: async () => {}, jobKey: p.jobKey,
        }),
      }, { overLimit: true });
    } catch (err) {
      // As in _resume: not queued, so not journalled either.
      this._journalRemove(ctx, p.jobKey, { keepWork: true });
      throw err;
    }
    this._interrupted?.delete(p.jobKey);
    if (retry && !startedBefore) ctx.queue.moveTop?.(queued);
    ctx.log.info(retry
      ? `retrying "${filmLabel(movie)}" from its public link (attempt ${retry} of ${MAX_RETRIES})`
      : `resumed "${filmLabel(movie)}" from its public link (${p.publicLink.shown ?? linkForDisplay(p.publicLink.url)})`);
    return true;
  },

  /**
   * A hand-queued job assigned to a member is announced to them the way a
   * request of their own is (onMessage: "added to the queue"), so the member
   * learns it is theirs: _notify tags them when they are in the notifications
   * group. One not assigned stays silent, as a hand-queued job always was.
   */
  _announceAssigned(ctx, record, label) {
    if (!record?.assignedBy) return;
    this._notify(ctx, 'queued', `\ud83c\udfac ${label} \u2014 added to the queue`, record);
  },

  /**
   * The react() for a journalled job's message. A job queued from the panel
   * has no WhatsApp message behind it: its msgKey is null and msgId a
   * placeholder ("manual-1790263529080"). requeue() and queueLibraryItem()
   * give such a job a no-op react; a resumed one reacted on every stage,
   * with a null key (see bot.react).
   *
   * The same emoji twice running is skipped, as the TV side's react() skips
   * it (tv-requests _sameTwiceSkipped): a film picked back up after a restart
   * is told the stage it is at (_resume, _whereNow) - ⚙️ for Iron Man 3,
   * downloaded before the 15:22 restart on 2026-10-11 - and its run, given
   * this same react(), then reaches that stage and would say it again. Noted
   * as shown only once bot.react has said it went: a reaction the budget
   * shed is not believed shown, which is the trap the TV side fell into.
   */
  _reactFor(ctx, p) {
    if (!p?.msgKey) return async () => {};
    const msg = { id: p.msgId, key: p.msgKey, chatJid: p.chatJid };
    let shown = null;
    let asking = null;
    return async (emoji) => {
      if (!emoji || emoji === shown || emoji === asking) return;
      if (safeRoute(ctx.config, p.record?.route)?.originIsMain) return;   // see onMessage
      const kind = this._reactionKind(ctx.config.movieRequests, emoji);
      asking = emoji;
      try {
        const sent = await ctx.bot.react(msg, emoji, { kind });
        if (sent !== false) shown = emoji;
      } catch { /* the message may be long gone */ } finally {
        if (asking === emoji) asking = null;
      }
    };
  },

  /**
   * The reaction that says where a journalled film is now, for its message:
   * the stage it is at while it runs - the queue's live view of job `queued`,
   * or of the job running it - else the stage its kept work has reached, else
   * 🎬 (media/stage-reaction.js). Never 🔄, which asks the member for nothing
   * they can do and was read as "send it again" (Iron Man 3, 2026-10-11).
   * Never a place number either: a film waiting for its turn shows that
   * through _updatePositions, which keeps it current.
   */
  _whereNow(ctx, p, { queued = null } = {}) {
    const R = ctx.config.movieRequests?.reactions ?? {};
    let view = null;
    try {
      view = (ctx.queue?.snapshot?.().active ?? [])
        .find((v) => (queued != null && v.id === queued) || (!!p?.jobKey && v.meta?.jobKey === p.jobKey)) ?? null;
    } catch { /* a queue that cannot answer: the work says it */ }
    let work = null;
    try { work = filmWork(ctx, p?.jobKey, p?.movie?.title); } catch { /* none to read */ }
    return stageReaction(R, { view, work, running: !!view });
  },

  /**
   * Try a transiently failed job again in this process, once WhatsApp is
   * connected, instead of leaving it for the next start - which is all that
   * used to happen. "Spaceballs" lost its upload to a dropped connection at
   * 18:56 UTC on 2026-09-28, the bot had reconnected three minutes earlier,
   * and the requester sat on 🔄 until someone restarted the service.
   *
   * The journal entry stays where it is while the retry waits, so a restart
   * meanwhile still replays the job - once, since the timer dies with the
   * process. Returns the attempt booked, or 0 once MAX_RETRIES are spent.
   * `until` is what else the attempt waits for - room on the disk, after a
   * full one (see deliver).
   */
  _retryLater(ctx, jobKey, err, { until = null } = {}) {
    this._retries ??= new RetryBook({ log: ctx.log });
    // On the queue's panel while it waits, where Cancel can reach it (see
    // RetryBook `show`).
    const p = (ctx.store.get('pending', []) ?? []).find((e) => e.jobKey === jobKey);
    const show = typeof ctx.queue?.holdRetry === 'function' ? {
      queue: ctx.queue,
      label: p?.movie ? `${p.movie.title}${p.movie.year ? ` (${p.movie.year})` : ''}` : 'a film',
      kind: 'movie',
      meta: {
        requester: p?.record?.requester ?? p?.meta?.requester ?? null,
        requesterNumber: phoneOut(p?.meta?.requesterNumber ?? p?.record?.requesterNumberDisplay ?? null),
        // Still this member's while it waits (queue.hasOthers).
        ...(p?.meta?.memberKey ? { memberKey: p.meta.memberKey } : {}),
        ...(p?.record?.route?.beta ? { beta: true } : {}),
      },
      cancel: (state) => this._cancelBookedRetry(ctx, jobKey, state),
    } : null;
    return this._retries.schedule(jobKey, {
      bot: ctx.bot, err, until, show,
      run: (attempt) => this._retryNow(ctx, jobKey, attempt),
    });
  },

  /**
   * A film waiting for its retry, cancelled or skipped from the panel.
   *
   * It is in no queue while it waits, so the queue's own cancel has nothing
   * to stop and no run() hears of it. What cancelling it means is done here:
   * the retry is forgotten, the film leaves the journal (or the next start
   * would bring it back), its kept work goes, History says so, and the
   * requester, who was shown where it had got to, sees ❌ - as for a film
   * cancelled while it runs.
   */
  _cancelBookedRetry(ctx, jobKey, state = 'cancelled') {
    const skipped = state === 'skipped';
    const p = (ctx.store.get('pending', []) ?? []).find((e) => e.jobKey === jobKey);
    this._retries?.forget(jobKey);
    const followers = this._takeFollowers(ctx, jobKey);
    this._journalRemove(ctx, jobKey);
    if (!p) return;
    const patch = { status: skipped ? 'skipped' : 'cancelled', detail: `${skipped ? 'skipped' : 'cancelled'} by admin while waiting to retry` };
    if (!skipped) this._freeMemberHour(ctx, p.record);
    const hist = ctx.store.get('history', []) ?? [];
    const row = hist.find((h) => h.id === p.record?.id);
    if (row) { Object.assign(row, patch); ctx.store.set('history', hist); }
    else if (p.record?.id) this.upsertHistory(ctx, { ...p.record, ...patch });
    const R = ctx.config.movieRequests.reactions;
    this._reactFor(ctx, p)(skipped ? (R.skipped ?? R.failed) : (R.cancelled ?? R.failed));
    this._tellFollowers(ctx, followers, { status: patch.status, emoji: skipped ? (R.skipped ?? R.failed) : (R.cancelled ?? R.failed) });
    ctx.log.warn(`${skipped ? '⏭ SKIPPED' : '❌ CANCELLED'} ${p.movie?.title} while it waited to be retried`);
  },

  async _retryNow(ctx, jobKey, attempt) {
    // Read back from the journal, which is the job's only record while it
    // waits: a job that has left it since has nothing to come back as.
    const p = (ctx.store.get('pending', []) ?? []).find((e) => e.jobKey === jobKey);
    if (!p) {
      ctx.log.info(`not retrying ${jobKey}: it is no longer journalled`);
      this._retries?.forget(jobKey);
      return;
    }
    // Something else has put it back already. A second copy is a second post.
    const queued = [...(ctx.queue.pending ?? []), ...(ctx.queue.active?.values?.() ?? [])]
      .some((e) => e?.meta?.jobKey === jobKey);
    if (queued) {
      ctx.log.info(`not retrying "${p.movie?.title}": it is in the queue already`);
      this._retries?.forget(jobKey);
      return;
    }
    try {
      // A film that had started before a restart, and whose putting back
      // failed then, comes back running (_recoverFilms).
      await this._resume(ctx, p, { retry: attempt, startedBefore: this._interrupted?.get(jobKey) ?? null });
    } catch (err) {
      // The re-lookup can fail the way the job did - Jellyfin gone for a
      // minute - and that counts as another attempt, not a new budget.
      const next = isTransient(err) ? this._retryLater(ctx, jobKey, err) : 0;
      ctx.log.warn(`could not retry "${p.movie?.title}": ${err.message}`
        + (next ? ` - trying again (attempt ${next} of ${MAX_RETRIES})` : ' - left for the next start'));
      // Out of attempts in this process: parked, its work kept for the next
      // start (see _park).
      if (!next) this._park(ctx, jobKey);
    }
  },

  /**
   * A film whose attempts in this process are spent waits for the next start
   * - its journal entry stays - and keeps what it has done: its download, its
   * pieces, its finished file. They used to be deleted here, as room no job
   * in this process would give back, and the next start began again from
   * step 1 - a start the hourly check itself brings about for a film left
   * this way ("journalled to retry on the next start"). With Jellyfin coming
   * up after the bot, four failed checks in its first four minutes deleted a
   * complete 2.62 GB download of The Parent Trap and its finished pieces.
   *
   * Its room is not held for it (keepRoom): nothing in this process will run
   * it, and new work must not wait on it in the queue. It is kept whatever
   * the disk has free - it used to be reset when the disk was nearly full,
   * or given up for a new job that did not fit, and the operator, after a
   * restart had deleted three fully converted films (2026-09-30): "files
   * should remain in their folders until fully sent on whatsapp". A new job
   * that does not fit beside it waits for it instead (disk-space.js
   * DISK_HELD).
   */
  _park(ctx, jobKey) {
    if (!jobKey) return;
    (this._parked ??= new Set()).add(jobKey);
    forgetKept(jobKey);
    // Nor is a slot kept for it if it had been running before a restart, for
    // the same reason (queue.expectBack).
    this._interrupted?.delete(jobKey);
    ctx.queue?.forgetExpected?.(jobKey);
  },

  /**
   * Was this film posted to where it goes before the process stopped? Read
   * from its work (manifest.sent) and from its journal entry (`sent`, noted
   * as it is posted), so that neither a reset work directory nor a lost one
   * can make it post the film a second time. Throws when a beta request has
   * nowhere isolated left to go (_postsGroupFor).
   */
  _postedBefore(ctx, jobKey, record, work = null) {
    const dest = this._postsGroupFor(ctx, record);
    const entry = jobKey ? (ctx.store.get('pending', []) ?? []).find((e) => e.jobKey === jobKey) : null;
    const w = work ?? (jobKey ? filmWork(ctx, jobKey) : null);
    return [...(w?.manifest?.sent?.to ?? []), ...(entry?.sent?.to ?? [])].includes(dest);
  },

  /**
   * A film found at recovery to have been posted before the restart
   * (_postedBefore): finished as posted, as its run would have finished it -
   * History, ✅ for its requester and those who followed it, out of the
   * journal - with nothing looked up, made or sent.
   */
  async _finishPosted(ctx, p) {
    const R = ctx.config.movieRequests?.reactions ?? {};
    ctx.log.info(`"${p.movie?.title}" was already posted to its group before the restart - not posting it twice`);
    this._retries?.forget(p.jobKey);
    if (p.record?.id) {
      this.upsertHistory(ctx, { ...p.record, status: 'sent', detail: 'posted before a restart', finishedAt: Date.now() });
    }
    await this._reactFor(ctx, p)(R.done);
    this._tellFollowers(ctx, this._takeFollowers(ctx, p.jobKey, p), { status: 'sent', emoji: R.done });
    this._journalDone(ctx, p.jobKey);
  },

  /**
   * A finished job leaves the journal - on the disk, synced - before its
   * work goes. The work holds the record that the film was posted
   * (manifest.sent), and it used to be deleted first, with the journal's
   * removal still waiting on a debounced, unsynced save: a kill, an
   * out-of-memory kill or a power cut in that half second left the job
   * journalled with nothing to say it had been posted, and the next start
   * downloaded, converted and posted it to the group again. If the journal
   * cannot be written, the work stays (the hourly sweep clears it once no
   * journal holds it). `work` is the run's own open handle; `drop` false
   * leaves the work for the operator who keeps local copies.
   */
  _journalDone(ctx, jobKey, { work = null, drop = true } = {}) {
    this._journalRemove(ctx, jobKey, { keepWork: true });
    const saved = ctx.store.flush?.() !== false;
    if (!drop) return 0;
    if (!saved) {
      ctx.log.warn(`keeping the work of ${jobKey} until the journal can be saved: it says the film was posted`);
      return 0;
    }
    if (work) return work.drop();
    this._dropWork(ctx, jobKey);
    return 0;
  },

  /**
   * An admin cancelled this request: the member's hour is free again, if the
   * request is the one that started it (request-cooldown.js releaseClock).
   * The operator, 2026-10-23: "cancelled request should free the member's hour".
   */
  _freeMemberHour(ctx, record) {
    if (!record?.requesterJid) return;
    const what = record.title ? `${record.title}${record.year ? ` (${record.year})` : ''}` : null;
    const keys = cooldownKeys(record.requesterJid, { beta: !!record.beta });
    if (releaseClock(ctx.store, keys, what)) {
      ctx.log.info(`${record.requester ?? 'the member'}'s hour is free again - the cancelled "${what}" no longer holds it`);
    }
  },

  /**
   * A job cancelled, skipped or cleared from the queue before it started.
   *
   * It never runs, so deliver() - which takes a cancelled job out of the
   * journal - never hears of it, and the next start used to queue it again.
   * A cancelled job must never come back, and a retried one waits in the
   * queue like any other.
   *
   * The requester sees ❌ (⏭️ for a skip), as the group rules promise ("❌
   * An admin cancelled it") and as a TV request cleared the same way does.
   * The message used to keep its place number for ever, so a film cleared
   * with Clear waiting still read "3️⃣" - in line - while the TV request
   * beside it read ❌. One reaction per request cleared: the Clear waiting
   * button asks first, and says how many (docs/whatsapp-ban-risk.md §4c).
   */
  _cancelledWhileWaiting(ctx, entry) {
    const jobKey = entry?.meta?.jobKey;
    if (!jobKey) return;
    try {
      const p = (ctx.store.get('pending', []) ?? []).find((e) => e.jobKey === jobKey);
      if (!p) return;
      this._retries?.forget(jobKey);
      const followers = this._takeFollowers(ctx, jobKey);
      this._journalRemove(ctx, jobKey);
      const skipped = entry.state === 'skipped';
      // Its requester, and those who followed it, see it will not come.
      const R = ctx.config.movieRequests?.reactions ?? {};
      const emoji = skipped ? (R.skipped ?? R.failed) : (R.cancelled ?? R.failed);
      this._reactFor(ctx, p)(emoji);
      this._tellFollowers(ctx, followers, { status: skipped ? 'skipped' : 'cancelled', emoji });
      const patch = { status: skipped ? 'skipped' : 'cancelled', detail: `${skipped ? 'skipped' : 'cancelled'} by admin before it started` };
      if (!skipped) this._freeMemberHour(ctx, p.record);
      const hist = ctx.store.get('history', []) ?? [];
      const row = hist.find((h) => h.id === p.record?.id);
      if (row) { Object.assign(row, patch); ctx.store.set('history', hist); }
      else if (p.record?.id) this.upsertHistory(ctx, { ...p.record, ...patch });
      ctx.log.info(`${skipped ? '⏭ SKIPPED' : '❌ CANCELLED'} ${p.movie?.title} before it started - out of the journal`);
    } catch (err) {
      ctx.log.warn(`could not tidy up after cancelling "${entry.label}": ${err.message}`);
    }
  },

  /**
   * Re-run a request from the control panel (e.g. a "Re-run" button on a
   * history row, or the manual add box). No WhatsApp message backs this, so
   * reactions are no-ops; the file still goes to the posts group as usual.
   *
   * Always the MAIN posts group: panel work has no origin group, so it cannot
   * be beta traffic. That is why History offers no Re-run on a beta row and
   * the bulk re-run skips them - either would have sent a test request to the
   * real posts group. A beta request is re-run by asking again in the beta
   * group.
   */
  async requeue(text, ctx, { requester = 'manual (admin)', overLimit = false, member = null } = {}) {
    const cfg = ctx.config.movieRequests;
    if (!cfg.postsGroup) throw new Error('No posts group configured');
    // A Re-run of a row refused for asking for several films ("rocky 1 2 3 4
    // 5 and 6", 2026-10-11) would hand OMDb the whole phrase and queue
    // whichever one film it settled on. Said instead, so the admin asks for
    // each film on its own as the member was told to.
    const several = severalFilms(text);
    if (several) {
      throw Object.assign(new Error(`"${text}" asks for ${several.count ? `${several.count} films` : 'a whole series'} - `
        + `one film per request: ${several.requests.map((r) => `"${r}"`).join(', then ')}`), { code: 'SEVERAL_FILMS' });
    }

    let found = await lookupMovie(text, { apiKey: ctx.config.omdb.apiKey });
    if (!found) {
      const corrected = await researchLibrary(text, ctx.config.library);
      if (corrected) {
        found = await lookupMovie(`${corrected.title}${corrected.year ? ` ${corrected.year}` : ''}`,
          { apiKey: ctx.config.omdb.apiKey });
      }
    }
    // Coded so the panel knows these two - and only these - mean "not a film we
    // can find", the one case where trying the title as a TV show makes sense.
    if (!found) throw Object.assign(new Error(`No match for "${text}"`), { code: 'NO_MATCH' });
    let movie = found.movie;

    // The same gates as a request from a group (film-gate.js): a film on the
    // bypass list is re-run with no AI check - the operator's "Send it, no AI
    // check" (2026-09-29) - and one its rating blocks only if the AI check
    // clears it, where the operator allows that. A panel Re-run, the bulk
    // re-run and the hourly check's requeue of a listed film were refused
    // here on its rating alone until that day.
    const g = ctx.config.gemini;
    const letter = ratingGate(ctx.store, movie, cfg, { gemini: g, ai: ctx.config.ai });
    if (letter.refused) throw new Error(`${movie.title} is rated ${movie.rated} (blocked)`);
    if (letter.override && letter.blocked) {
      ctx.log.warn(`re-running "${movie.title}" (rated ${movie.rated}) — ${describeOverride(letter.override)}`);
    }

    // A Re-run is judged as the request was: a library film whose title is
    // not the one asked for, from a year more than one away, is not a hit
    // (findInLibrary; Barefoot Gen for "Barefoot 2014", 2026-09-29), and
    // neither is a copy far from a year typed in the text, whatever its title
    // (Dune 2021 for "Dune 1984"). The error names it, so the panel says why
    // rather than only "not there".
    const typedYear = typedYearOf(text, movie);
    let otherFilm = null;
    const hit = await findInLibrary(movie.title, movie.year, ctx.config.library, {
      alsoTry: [text],          // what was actually typed, not just OMDb's title
      onOtherFilm: (o) => { otherFilm = o; },
      typedYear,
      typed: text,
      imdbId: movie.imdbId ?? null,
    });
    if (!hit) {
      // A film its rating blocks was refused before the library was asked,
      // and still is when nothing is there to send.
      if (letter.deferred) throw new Error(`${movie.title} is rated ${movie.rated} (blocked)`);
      // `otherFilm` and `typedYear` ride along for the panel, which asks the
      // TV section about a film it cannot find - but not about a year-stamped
      // film whose near-namesake was just refused (see /requeue in api.js).
      throw Object.assign(new Error(`${movie.title}${movie.year ? ` (${movie.year})` : ''} is not in the library`
        + `${otherFilm ? ` — ${closestNote(otherFilm)}` : ''}`),
      // The year as written, not typedYearOf's: api.js keeps a year-stamped
      // miss away from TV on it, as the group path's step 4 does with
      // extractYear. A typo'd year ("Barefoot 2016" for the 2014 film) has no
      // typedYearOf, and the Re-run asked TV again - Barefoot Contessa.
      { code: 'NOT_IN_LIBRARY', otherFilm, typedYear: extractYear(text) });
    }

    // The file's own rating, as a request judges it (fileGate): a file its
    // rating blocks goes on only when an entry covers the film it is, or the
    // AI check may yet clear it. A file far from a year typed in the text is
    // another film, as findInLibrary judged the library's copies (typedYear).
    const canClear = aiCanClear(g, ctx.config.ai);
    const file = await fileGate({
      store: ctx.store, movie, hit, cfg, override: letter.override, aiMayClear: canClear,
      omdbKey: ctx.config.omdb.apiKey, log: ctx.log, typedYear,
    });
    const { rc } = file;
    if (file.refused === 'blocked-rating') throw new Error(`${hit.title} (${hit.year}) is rated ${rc.rated} (blocked)`);
    if (file.refused === 'wrong-film') {
      throw new Error(`The server's file for "${movie.title}" is actually `
        + `"${rc.found?.title}" (${rc.found?.year}) — refusing to send a different film.`);
    }
    // A file identified as another film (another year's Scarface) is judged
    // on its own: on the entry that covers it, if any, and on its own rating
    // - never on the entry or the letter grade of the film asked for, which,
    // in review of 2026-09-29, sent an R film nobody listed with no check
    // (see fileGate).
    const swapped = file.movie !== movie;
    if (swapped) movie = file.movie;
    const settle = () => this._panelGate(ctx, {
      movie, hit, override: file.override, ratedBlocked: !swapped && letter.blocked ? true : null,
      source: 'panel re-run',
    });
    // With no provider to ask, the last gate is settled first: a film its
    // rating blocks is refused on its rating, as step 2 once refused it, not
    // as a duplicate or for a full queue.
    let gate = canClear ? null : await settle();

    // Nothing is queued twice for the main posts group, from here any more
    // than from a request group (see onMessage): a panel Re-run, the bulk
    // re-run - which takes every "queued" and "interrupted" row as well -
    // and the hourly check's requeue all come through here, and none of them
    // asked. The check re-ran a resumed Minority Report that reconcileHistory
    // had wrongly marked "lost", and the film was queued twice.
    this._refuseIfWaiting(ctx, movie);

    // Before anything is written. The job used to be journalled and put in
    // History as "queued" first, and only then refused by queue.add as full:
    // a History row for a film that never ran, and a journal entry the next
    // restart would have queued after all.
    if (!overLimit && ctx.queue.hasRoom?.(1) === false) throw ctx.queue.fullError();

    // The AI check awaits a provider, so what it waits for is asked again
    // after it - the duplicate and the room - with nothing awaited from there
    // to the journal entry. Asked first as well, so a duplicate or a full
    // queue spends no check.
    if (!gate) {
      gate = await settle();
      if (gate.checked) {
        this._refuseIfWaiting(ctx, movie);
        if (!overLimit && ctx.queue.hasRoom?.(1) === false) throw ctx.queue.fullError();
      }
    }
    const who = panelRequester(requester, member);
    const record = {
      id: `manual-${Date.now()}`, at: Date.now(), ...who,
      groupJid: cfg.postsGroup, request: text,
      status: 'queued', title: movie.title, year: movie.year, rated: movie.rated,
      ...gate.record,
    };
    const noReact = async () => {};
    const jobKey = `${record.id}:${movie.imdbId ?? movie.title}`;
    const followers = this._supersedeParked(ctx, movie, null, jobKey);
    this._journalAdd(ctx, {
      jobKey, msgId: record.id, msgKey: null, chatJid: cfg.postsGroup,
      movie: { title: movie.title, year: movie.year, imdbId: movie.imdbId, rated: movie.rated },
      meta: { ...whoMeta(who), group: cfg.postsGroup, imdbId: movie.imdbId }, record, at: Date.now(),
      ...(followers.length ? { followers } : {}),
    });
    this.upsertHistory(ctx, record);
    ctx.queue.add({
      label: `${movie.title} (${movie.year})`,
      meta: { ...whoMeta(who), group: cfg.postsGroup, imdbId: movie.imdbId, jobKey },
      run: (job) => this.deliver({
        msg: { id: record.id, key: null, chatJid: cfg.postsGroup },
        movie, hit, ctx, job, record, react: noReact, jobKey,
      }),
    }, { overLimit });
    ctx.log.info(`manually queued "${movie.title}" (${movie.year})${assignedNote(who)}`);
    this._announceAssigned(ctx, record, `${movie.title} (${movie.year})`);
    return { title: movie.title, year: movie.year };
  },

  /**
   * The last gate for a film the panel queues - by link (queueLibraryItem) or
   * re-run by title (requeue) - through contentGate, as for a request from a
   * group: on the bypass list it is queued with no AI check; its rating lets
   * it through and nothing is asked; its rating blocks it and the AI check
   * does not clear it, or cannot be asked, and this throws with the reason,
   * so nothing is queued. Resolves to { checked, record }: whether a provider
   * was asked, and the fields its History row keeps.
   *
   * @param opts.refusal  the words for a refusal, given why the AI check did
   *                      not clear it (null when it was not asked); a Re-run's
   *                      "... is rated R (blocked)" otherwise
   */
  async _panelGate(ctx, { movie, hit = null, override = null, ratedBlocked = null, source, refusal = null }) {
    const title = hit?.title ?? movie.title;
    const year = hit?.year ?? movie.year;
    const rated = movie.rated || 'unrated';
    const gate = await contentGate({
      store: ctx.store, movie, hit, override, ratedBlocked, cfg: ctx.config.movieRequests,
      gemini: ctx.config.gemini, ai: ctx.config.ai,
      onResult: (r) => {
        ctx.contentHealth?.record({ ...r, title, year, source })
          .catch((err) => ctx.log.warn(`content check health: ${err.message}`));
      },
    });
    const { call, verdict, failed } = gate;
    if (gate.bypass) ctx.log.warn(`queueing "${title}" (rated ${rated}) from the panel — ${call.reason}`);
    if (gate.checked) {
      ctx.log.info(`AI check "${title}" (${source}): `
        + `${verdict ? `nudity=${verdict.nudity} (${verdict.confidence}) by ${providerLabel(verdict.provider)}`
          : failed ? `did not run (${failed.reason})` : 'no answer'} -> ${call.blocked ? 'not cleared' : 'cleared'}`);
    }
    if (call.blocked) {
      const why = gate.checked ? `the AI check did not clear it (${notClearedWhy({ verdict, call, failure: failed })})` : null;
      ctx.log.info(`not queueing "${title}" (rated ${rated}): ${why ?? call.reason}`);
      throw new Error(refusal ? refusal(why) : `${movie.title} is rated ${rated} (blocked)${why ? ` — ${why}` : ''}`);
    }
    return {
      checked: gate.checked,
      record: {
        ...(gate.bypass ? { override: call.reason } : {}),
        // What a restart or a retry goes by (_resume): see onMessage 4c.
        ...(gate.checked && !call.blocked ? { aiCleared: call.reason } : {}),
        ...(verdict ? { contentCheck: contentCheckRecord(verdict, call) } : {}),
        ...(failed ? { contentCheckSkipped: failed.reason } : {}),
        ...(failed?.summary ? { contentCheckSkippedWhy: failed.summary } : {}),
      },
    };
  },

  /**
   * Queue a library item the admin identified by URL.
   *
   * No title matching at all: the item id came from a human looking at the
   * film in Jellyfin, so there is nothing to guess. This is the escape hatch
   * for the case where the matcher is wrong and reports a film missing when
   * the server has it.
   *
   * The rating gate still applies. Bypassing the matcher is not a reason to
   * bypass what may be sent - if anything an admin pasting a link is MORE
   * likely to have skipped looking at the rating. So do the bypass list and
   * the AI check, as for a request (_panelGate).
   */
  async queueLibraryItem(item, ctx, { requester = 'panel', member = null } = {}) {
    const cfg = ctx.config.movieRequests;
    if (!cfg.postsGroup) throw new Error('No posts group configured');
    if (!item?.id) throw new Error('no library item');
    // A show is the TV plugin's, judged on the TV rules (tvItemRefusal). The
    // panel's route refuses one first; this is for any other caller.
    const tv = tvItemRefusal(item);
    if (tv) throw new Error(tv);

    // Queue link's rule is stricter than a request's in one way: an item with
    // no rating in Jellyfin counts as blocked whatever blockUnrated says -
    // Jellyfin leaves OfficialRating empty on plenty of files, and unrated is
    // the case nobody has checked. Otherwise it is a request's: the bypass
    // list sends a listed item with no AI check, whatever its rating, and the
    // AI check may clear one its rating blocks. The refusal names the list,
    // so a queue that "should have been blocked" is traceable to a decision
    // rather than to a bug.
    const unrated = !String(item.rated ?? '').trim();
    const ratedBlocked = unrated || isBlockedRating(item.rated, cfg.blockedRatings ?? []);
    const movie = { title: item.title, year: item.year, rated: item.rated, imdbId: null };
    // As for a re-run (requeue): not twice for the main posts group - asked
    // before the AI check, so a duplicate spends none, and again after it.
    this._refuseIfWaiting(ctx, movie);
    const gate = await this._panelGate(ctx, {
      movie, hit: { id: item.id, title: item.title, year: item.year }, ratedBlocked, source: 'panel link',
      refusal: (why) => (unrated
        ? `"${item.title}" has no rating set in Jellyfin, so the bot will not send it${why ? `, and ${why}` : ''}. `
          + 'Set an official rating on the item and try again, or add it under Settings → Rated-R override.'
        : `"${item.title}" is rated ${item.rated} — that is on the blocked list${why ? `, and ${why}` : ''}. `
          + 'Add it under Settings → Rated-R override if it should be sent anyway.'),
    });
    if (gate.checked) this._refuseIfWaiting(ctx, movie);
    const hit = {
      title: item.title, year: item.year, id: item.id,
      localPath: item.localPath,
      // Jellyfin reporting a Path is not evidence that the path exists HERE.
      // It is the path on the media server, and this box only shares it when
      // the same storage happens to be mounted. It was on the old machine and
      // is not on this one, so every queue-from-a-link went straight to
      // "using library file in place: /mnt/stor01/..." and died in ffprobe
      // 80ms later with "No such file or directory" - the escape hatch failing
      // in exactly the situation you reach for it.
      //
      // findInLibrary has always checked this. This path never did.
      access: readableHere(item.localPath) ? 'local' : 'download',
      // downloadHeaders, not headers: the downloader reads copy.downloadHeaders,
      // so a link-queued film went to Jellyfin with no X-Emby-Token and came
      // back "download failed: HTTP 401 Unauthorized" - Glass Onion, 15:27 on
      // 2026-09-23, 0.14s after it started. `provider` is what the start line
      // names, which is why it read "download START ... from undefined".
      provider: 'jellyfin',
      downloadUrl: item.downloadUrl, downloadHeaders: item.headers, sameTitled: [],
    };
    if (item.localPath && hit.access === 'download') {
      ctx.log.info(`"${item.localPath}" is not readable on this server - downloading instead`);
    }

    const who = panelRequester(requester, member);
    const record = {
      id: `panel-${Date.now()}`, at: Date.now(), ...who,
      groupJid: cfg.postsGroup, request: `jellyfin:${item.id}`,
      status: 'queued', title: movie.title, year: movie.year, rated: movie.rated,
      ...gate.record,
    };
    const noReact = async () => {};
    const jobKey = `${record.id}:${item.id}`;
    const followers = this._supersedeParked(ctx, movie, null, jobKey);
    this._journalAdd(ctx, {
      jobKey, msgId: record.id, msgKey: null, chatJid: cfg.postsGroup,
      movie, meta: { ...whoMeta(who), group: cfg.postsGroup }, record, at: Date.now(),
      ...(followers.length ? { followers } : {}),
    });
    this.upsertHistory(ctx, record);
    ctx.queue.add({
      label: `${movie.title}${movie.year ? ` (${movie.year})` : ''}`,
      meta: { ...whoMeta(who), group: cfg.postsGroup, jobKey },
      run: (job) => this.deliver({
        msg: { id: record.id, key: null, chatJid: cfg.postsGroup },
        movie, hit, ctx, job, record, react: noReact, jobKey,
      }),
    });
    ctx.log.info(`queued "${movie.title}" from a Jellyfin link (item ${item.id})${assignedNote(who)}`);
    this._announceAssigned(ctx, record, filmLabel(movie));
    return { title: movie.title, year: movie.year };
  },

  /**
   * Queue a film from a public download link an admin pasted on the panel,
   * with the title and year it is to be posted under. No Jellyfin at all.
   *
   * The operator (2026-09-30): "For a movie like plandemic being that it's
   * free there's a public download link for it, so there should be a box on
   * the panel where an admin can manually enter any public mp4 download link
   * and it'll queue and process, why should it need to be jellyfin if it's
   * public anyway".
   *
   * No rating gate and no AI check. "The AI content check only ever helps a
   * request through" (CLAUDE.md) - it may clear a title, never deny one - and
   * there is no rating here for it to help past: an admin queueing a link by
   * hand, and naming the film, is the operator's approval of it, as an entry
   * on the bypass list is (operator, 2026-09-29).
   *
   * What it does check is the link (media/public-link.js): http(s) only,
   * public addresses only on every hop, a size cap, and that it is a video.
   * The full URL - its query can be a token - is kept only in the journal
   * entry on this box; History, the log and the panel get host and path.
   *
   * A link to a video page - YouTube's, on 2026-10-11, "the world of harry
   * potter part 3" for Dan Smith, refused as "a web page (text/html)" -
   * goes through yt-dlp instead (_inspectPublicLink, media/yt-dlp.js), and
   * from there down the same convert-and-post pipeline. Such a link may come
   * without a title: the page's own is used.
   */
  async queuePublicLink({ url, title, year = null } = {}, ctx, { requester = 'panel', member = null } = {}) {
    const cfg = ctx.config.movieRequests;
    if (!cfg.postsGroup) throw new Error('No posts group configured');
    const u = checkLinkUrl(url);
    let name = String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
    // A file link is named before anything is fetched, as it always was; a
    // video page's title can come from the page.
    if (!name && !isVideoPageHost(u)) throw linkError('Give the film its title: it is the name the file is posted under.');
    let y = null;
    if (year != null && String(year).trim() !== '') {
      y = Number(String(year).trim());
      if (!Number.isInteger(y) || y < 1880 || y > 2100) throw linkError('The year should be four digits, like 2020 - or leave it empty.');
    }
    const shown = linkForDisplay(u);

    // Not twice: the same film for the main posts group, or the same link -
    // or, for a video page, the same video under another link (a youtu.be
    // link, or the same watch link with a different si=). Asked before the
    // link is fetched from, and again after, since that takes a moment in
    // which the same click can arrive twice.
    const refuseTwins = (movie, videoKey = null) => {
      if (movie?.title) this._refuseIfWaiting(ctx, movie);
      const twin = (ctx.store.get('pending', []) ?? [])
        .find((p) => p.publicLink?.url === u.href || (videoKey && p.publicLink?.videoKey === videoKey));
      if (twin) {
        throw Object.assign(new Error(`That ${videoKey && twin.publicLink?.url !== u.href ? 'video' : 'link'} is already in the queue, `
          + `as ${twin.movie?.title ?? 'another film'}${twin.movie?.year ? ` (${twin.movie.year})` : ''} - not queued twice`), { code: 'DUPLICATE' });
      }
    };
    refuseTwins(name ? { title: name, year: y } : null);

    const src = await this._inspectPublicLink(u, ctx);
    if (!name) name = src.title ?? '';
    if (!name) throw linkError('Give the film its title: the page does not say what it is called.');
    const movie = { title: name, year: y, rated: null, imdbId: null };
    const videoKey = src.kind === 'page' && src.id ? `${src.extractor}:${src.id}` : null;
    refuseTwins(movie, videoKey);

    const link = src.kind === 'page'
      ? {
        url: u.href, shown, size: src.expectedBytes ?? null, container: null,
        via: 'yt-dlp', site: src.site, videoId: src.id, extractor: src.extractor, videoKey, duration: src.duration,
      }
      : { url: u.href, shown, size: src.size ?? null, container: src.container };
    const label = filmLabel(movie);
    const who = panelRequester(requester, member);
    const record = {
      id: `panel-${Date.now()}`, at: Date.now(), ...who,
      groupJid: cfg.postsGroup, request: `link: ${shown}`, publicLink: shown,
      ...(link.via ? { publicLinkVia: `${link.site} via yt-dlp` } : {}),
      status: 'queued', title: movie.title, year: movie.year, rated: null,
    };
    const jobKey = `${record.id}:${linkId(u.href)}`;
    const followers = this._supersedeParked(ctx, movie, null, jobKey);
    this._journalAdd(ctx, {
      jobKey, msgId: record.id, msgKey: null, chatJid: cfg.postsGroup,
      movie, meta: { ...whoMeta(who), group: cfg.postsGroup }, record, at: Date.now(), publicLink: link,
      ...(followers.length ? { followers } : {}),
    });
    this.upsertHistory(ctx, record);
    const noReact = async () => {};
    ctx.queue.add({
      label,
      meta: { ...whoMeta(who), group: cfg.postsGroup, jobKey },
      run: (job) => this.deliver({
        msg: { id: record.id, key: null, chatJid: cfg.postsGroup },
        movie, hit: publicHit(link), ctx, job, record, react: noReact, jobKey,
      }),
    });
    const about = [shown, link.via ? fmtLength(link.duration) : null, link.size ? `${link.via ? 'about ' : ''}${fmtBytes(link.size)}` : null]
      .filter(Boolean).join(', ');
    ctx.log.info(`queued "${label}" from ${link.via ? `${link.site} via yt-dlp` : 'a public link'} (${about})${assignedNote(who)}`);
    this._announceAssigned(ctx, record, label);
    return {
      title: movie.title, year: movie.year, size: link.size, link: shown,
      ...(link.via ? { via: 'yt-dlp', site: link.site, duration: link.duration, length: fmtLength(link.duration) } : {}),
    };
  },

  /**
   * What a pasted link is, before anything is queued: the panel's check as
   * the admin pastes it (POST /queue/public-link/inspect), and queueing's own.
   *
   *   { kind: 'file', size, container }                 a video file, as before
   *   { kind: 'page', site, title, duration, expectedBytes, id, extractor }
   *                                                     a page yt-dlp reads the video out of
   *
   * A link to YouTube, Vimeo or Dailymotion goes to yt-dlp at once. Any other
   * is asked for as a file first, exactly as it always was, and goes to
   * yt-dlp only when it answers with a web page; when yt-dlp knows no video
   * there either, or is not installed, the answer is the file check's, with
   * why yt-dlp could not help.
   */
  async _inspectPublicLink(u, ctx) {
    const media = ctx.config.media ?? {};
    const viaYtDlp = async (pageErr = null) => {
      let info;
      try {
        info = await this._ytdlpInspect(u, ctx);
      } catch (err) {
        if (pageErr && (err.code === 'YTDLP_UNSUPPORTED' || err.code === 'YTDLP_MISSING')) {
          throw Object.assign(linkError(`${pageErr.message} ${err.code === 'YTDLP_MISSING'
            ? 'yt-dlp, which reads the video out of pages like YouTube\'s, is not installed on this box (node tools/routines.mjs --fix).'
            : 'yt-dlp has no extractor for that site either, so the page cannot be read for a video.'}`, pageErr.code), { page: true });
        }
        throw err;
      }
      if (media.maxDownloadBytes > 0 && info.expectedBytes > media.maxDownloadBytes) {
        throw linkError(`The video at ${u.host} is about ${fmtBytes(info.expectedBytes)}, over the ${fmtBytes(media.maxDownloadBytes)} `
          + 'a link may be (media.maxDownloadBytes).', 'LINK_TOO_BIG');
      }
      return { kind: 'page', ...info };
    };
    if (isVideoPageHost(u)) return viaYtDlp();
    let info;
    try {
      info = await inspectLink(u.href, {
        fetchImpl: this._linkFetch(ctx), maxBytes: media.maxDownloadBytes, sniffDir: media.workDir || null,
        ffprobePath: media.ffprobePath ?? 'ffprobe', isSafe: (p) => isSafeToDelete(p, ctx),
      });
    } catch (err) {
      if (err.code === 'NOT_VIDEO' && err.page) return viaYtDlp(err);
      throw err;
    }
    return { kind: 'file', size: info.total ?? null, container: info.container, contentType: info.contentType };
  },

  /**
   * The panel's look at a link as it is pasted: what it is, and the title a
   * page gives, to fill in the name. Nothing is queued or kept.
   */
  async inspectPublicLink({ url } = {}, ctx) {
    const u = checkLinkUrl(url);
    const src = await this._inspectPublicLink(u, ctx);
    const shown = linkForDisplay(u);
    if (src.kind === 'file') return { kind: 'file', link: shown, size: src.size, container: src.container };
    return {
      kind: 'page', link: shown, via: 'yt-dlp', site: src.site, title: src.title, duration: src.duration,
      length: fmtLength(src.duration), size: src.expectedBytes, height: src.height,
    };
  },

  /**
   * The fetch a public link's download goes through: every hop checked, the
   * size capped (media/public-link.js). `ctx.linkNet` is the tests' seam, for
   * a clip served from 127.0.0.1 under a made-up public name; the bot never
   * sets it.
   */
  _linkFetch(ctx) {
    return makeLinkFetch({ maxBytes: ctx.config.media?.maxDownloadBytes ?? null, ...(ctx.linkNet ?? {}) });
  },

  /**
   * How this box runs yt-dlp (media/yt-dlp.js): its paths, the data directory
   * the cookies are kept in, and the address check's seams. `ctx.ytdlp` is
   * the tests' seam - a fake yt-dlp, a data directory of their own - and
   * `ctx.linkNet` the same network seam the file links use; the bot sets
   * neither.
   */
  _ytdlpOpts(ctx) {
    const seam = ctx.ytdlp ?? {};
    const paths = ytDlpPaths();
    return {
      bin: seam.bin ?? paths.bin,
      deno: seam.deno ?? paths.deno,
      dataDir: 'dataDir' in seam ? seam.dataDir : (ctx.configStore?.dataDir ?? null),
      nodeVersion: seam.nodeVersion,
      inspectTimeoutMs: seam.inspectTimeoutMs,
      downloadTimeoutMs: seam.downloadTimeoutMs,
      lookup: ctx.linkNet?.lookup,
      allow: ctx.linkNet?.allow,
    };
  },

  async _ytdlpInspect(u, ctx) {
    const o = this._ytdlpOpts(ctx);
    return withCookieCopy(o.dataDir, (cookieFile) => inspectPage(u.href, { ...o, cookieFile, timeoutMs: o.inspectTimeoutMs }));
  },

  /**
   * deliver()'s download, for a page: yt-dlp into the scratch folder the
   * manifest names (media/work-files.js keeps it through tidy(), and yt-dlp's
   * --continue goes on from the streams in it after a restart), then the
   * merged file moved out of it and recorded as the job's source, complete:
   * from there a restart converts it without running yt-dlp again.
   */
  async _ytdlpFetch(ctx, { copy, work, job }) {
    const o = this._ytdlpOpts(ctx);
    const m = work.manifest;
    if (!(m.item?.ytdlp && m.source?.scratch === YTDLP_SCRATCH && m.source?.state === 'partial')) {
      work.record({
        item: {
          provider: copy.provider ?? null, id: itemIdOf(copy), access: 'download', librarySize: copy.size ?? null,
          total: null, lastModified: null, etag: null, local: null, ytdlp: copy.ytdlp,
        },
        source: { name: null, state: 'partial', bytes: null, scratch: YTDLP_SCRATCH },
      });
    }
    work.vouch();
    const got = await withCookieCopy(o.dataDir, (cookieFile) => downloadPage(copy.downloadUrl, {
      ...o, cookieFile, dir: work.path(YTDLP_SCRATCH), timeoutMs: o.downloadTimeoutMs,
      maxBytes: ctx.config.media?.maxDownloadBytes ?? null, expectedBytes: copy.size ?? null, signal: job.signal,
      // Download occupies the first 40% of the overall bar, as a file's does.
      onProgress: (pct, info) => job.progress({ ...info, stage: 'download' }, pct == null ? null : Math.floor(pct * 0.4)),
    }));
    const name = `source${path.extname(got.path).toLowerCase() || '.mp4'}`;
    const dest = work.path(name);
    fs.renameSync(got.path, dest);
    work.record({ source: { name, state: 'complete', bytes: got.size } });
    // The scratch folder - the streams merged into it - is no longer named, and goes.
    work.tidy();
    return { path: dest, size: got.size, from: 0 };
  },

  /**
   * Mark history rows still showing 'queued'/'checking' but no longer backed
   * by a journal entry as 'lost' - otherwise a job dropped in an earlier crash
   * shows QUEUED for ever. Run once on start, after recovery re-journals.
   *
   * Matched on the row's id, which the journal entry carries as its record's
   * id (and msgId). It used to rebuild the jobKey from the row as
   * `${id}:${imdbId ?? title}`, but a History row never carries the imdbId
   * while the jobKey is built from it - so every film resumed after a
   * restart, queued and journalled, was marked "lost". The hourly check then
   * called it re-runnable ("was lost to a restart") and its requeue queued
   * the film a second time.
   */
  reconcileHistory(ctx) {
    const live = new Set((ctx.store.get('pending', []) ?? []).flatMap((p) => [p.record?.id, p.msgId]).filter(Boolean));
    const hist = ctx.store.get('history', []) ?? [];
    let fixed = 0;
    for (const r of hist) {
      if ((r.status === 'queued' || r.status === 'checking' || r.status === 'working')
          && !live.has(r.id)) {
        r.status = 'lost';
        r.detail = 'interrupted before it finished';
        fixed += 1;
      }
    }
    if (fixed) { ctx.store.set('history', hist); ctx.log.info(`reconciled ${fixed} stale history row(s)`); }
  },

  /**
   * Store/refresh a history entry by id (a snapshot, not a live reference),
   * so a request appears once and updates in place as it progresses rather
   * than duplicating on every status change.
   */
  upsertHistory(ctx, record) {
    const hist = ctx.store.get('history', []) ?? [];
    const snap = JSON.parse(JSON.stringify(record));
    // A record resumed from a journal written before 2026-10-01 still says
    // "+1 (555) 807-0190"; the row is written as +15558070190.
    if (snap.requesterNumberDisplay) snap.requesterNumberDisplay = phoneOut(snap.requesterNumberDisplay);
    const i = hist.findIndex((h) => h.id === record.id);
    if (i >= 0) hist[i] = snap; else hist.unshift(snap);
    if (hist.length > 200) hist.length = 200;
    ctx.store.set('history', hist);
  },

  /**
   * Journal a job so a restart can pick it back up.
   *
   * One entry per job: writing a job that is already journalled replaces its
   * entry. A retried job is re-journalled while its entry is still there, and
   * a second copy would be replayed by the next start as a second run.
   */
  _journalAdd(ctx, entry) {
    const all = ctx.store.get('pending', []) ?? [];
    // When it first started stays with it (_journalStarted), whatever
    // writes the entry again: a restart's recovery reads it from there.
    const was = all.find((p) => p.jobKey === entry.jobKey);
    if (Number(was?.startedAt) > 0 && !(Number(entry.startedAt) > 0)) entry = { ...entry, startedAt: was.startedAt };
    // And 0 until then, so that recovery knows this version wrote it and
    // that it has not started, whatever work it holds - work taken over from
    // a parked request (_supersedeParked) is not a start (_startOf). Only an
    // entry an older version journalled is left without it.
    else if (entry.startedAt == null && (!was || was.startedAt != null)) entry = { ...entry, startedAt: 0 };
    const pending = all.filter((p) => p.jobKey !== entry.jobKey);
    pending.push(entry);
    ctx.store.set('pending', pending);
    this._parked?.delete(entry.jobKey);
  },

  /**
   * A job leaves the journal: its work goes with it, since nothing will
   * resume from it now (cancelled, abandoned, handed to a newer request, or
   * finished). `keepWork` is for a caller that deals with the work itself -
   * deliver(), which holds it open.
   */
  _journalRemove(ctx, jobKey, { keepWork = false } = {}) {
    const pending = ctx.store.get('pending', []).filter((p) => p.jobKey !== jobKey);
    ctx.store.set('pending', pending);
    this._parked?.delete(jobKey);
    // Not coming back after a restart either, if the queue still expected it
    // (queue.expectBack): no slot is kept for it any longer.
    this._interrupted?.delete(jobKey);
    ctx.queue?.forgetExpected?.(jobKey);
    if (!keepWork) this._dropWork(ctx, jobKey);
  },

  /**
   * The journalled job for this film and destination that is waiting or in
   * progress, or null - the duplicate check in _runRequest.
   *
   * The journal holds every film accepted and not yet finished with: in the
   * queue, running, waiting on a retry, or left by the last process and not
   * resumed yet - and, while recovery runs, the ones on their way back in
   * (_recovering). The exception is a film whose retries in this process are
   * spent (_parked): nothing will run it before the next start, so asking
   * again queues it (see _supersedeParked).
   */
  _filmWaiting(ctx, movie, route) {
    const want = destinationOf(route);
    const jobs = [...(ctx.store.get('pending', []) ?? []), ...(this._recovering ?? [])];
    return jobs.find((p) => !this._parked?.has(p.jobKey)
      && destinationOf(p.record?.route) === want && sameFilm(p.movie, movie)) ?? null;
  },

  /**
   * Refuse to queue from the panel or the box a film already waiting or in
   * progress for the main posts group (_filmWaiting), with a reason a person
   * can read. Coded DUPLICATE, so a caller can tell it from a failure.
   */
  _refuseIfWaiting(ctx, movie) {
    const twin = this._filmWaiting(ctx, movie, null);
    if (!twin) return;
    const who = twin.record?.requester ? `, asked for by ${phoneOut(twin.record.requester)}` : '';
    throw Object.assign(
      new Error(`${movie.title}${movie.year ? ` (${movie.year})` : ''} is already in the queue${who} - not queued twice`),
      { code: 'DUPLICATE' },
    );
  },

  /**
   * A film asked for again after its retries in this process ran out, and
   * queued again: the old job leaves the journal, or the next start would
   * run it as well and post the film a second time. Its requester is served
   * by the new one, which goes to the same place: the old request and any
   * that followed it are returned, to follow the new job (_followersOf).
   *
   * What the old job had done (_park) goes to the new one, `toKey`, as a
   * twin's does at recovery: the same film for the same place, as far as it
   * got, which the new job checks against the library before building on.
   */
  _supersedeParked(ctx, movie, route, toKey = null) {
    const handed = [];
    if (!this._parked?.size) return handed;
    const want = destinationOf(route);
    const workDir = ctx.config.media?.workDir;
    for (const p of ctx.store.get('pending', []) ?? []) {
      if (!this._parked.has(p.jobKey) || destinationOf(p.record?.route) !== want || !sameFilm(p.movie, movie)) continue;
      handed.push(...this._asFollowers(p));
      let adopted = false;
      if (toKey && workDir) {
        adopted = adoptWork({
          workDir, fromKey: workKey.movie(p.jobKey), toKey: workKey.movie(toKey),
          isSafe: (f) => isSafeToDelete(f, ctx), keptKey: p.jobKey,
        }) === 'adopted';
        if (adopted) ctx.log.info(`"${p.movie?.title}": the new request takes over the work the old one had done`);
      }
      this._journalRemove(ctx, p.jobKey, { keepWork: adopted });
      if (p.record?.id) {
        this.upsertHistory(ctx, { ...p.record, status: 'duplicate', detail: 'asked for again after its retries ran out — the newer request takes it' });
      }
      ctx.log.info(`"${p.movie?.title}" was waiting for the next start - the new request for it takes its place`);
    }
    return handed;
  },

  /*
   * Followers: requests answered as duplicates of a journalled job
   * (_duplicateFilm), which are told how that job ends.
   *
   * A duplicate was answered 🎬 - "added to the queue" - and a "duplicate"
   * History row, and nothing remembered its message: when the film was
   * posted, failed or was cancelled, only the first requester's message
   * changed. Aaron's second and third "minority report" and another
   * member's stayed on 🎬 while the first went to ✅ (review scenario
   * m-triple-mr), and when the only copy failed, the duplicate still read
   * "duplicate" - which the hourly check does not look at, so nobody learnt
   * that a member was told "in the queue" and got nothing. Each follower is
   * written on the job's journal entry, so it outlives a restart, and at the
   * end gets the job's final reaction and its History row the job's outcome.
   */

  /** A journalled job's own request, and those that followed it, as followers of another. */
  _asFollowers(p) {
    const own = p?.msgId && p.record?.id ? [{
      msgId: p.msgId, msgKey: p.msgKey ?? null, chatJid: p.chatJid ?? null,
      historyId: p.record.id, requester: p.record.requester ?? null, route: p.record.route ?? null,
    }] : [];
    return [...own, ...(p?.followers ?? [])];
  },

  /** Add followers to a job: its journal entry, or the entry itself while recovery holds it. */
  _addFollowers(ctx, twin, followers) {
    if (!twin || !followers.length) return;
    twin.followers = [...(twin.followers ?? []), ...followers];
    this._journalUpdate(ctx, twin.jobKey, { followers: twin.followers });
  },

  /** Take a job's followers off it, from the journal - or from `p` once it has left it. */
  _takeFollowers(ctx, jobKey, p = null) {
    const entry = (ctx.store.get('pending', []) ?? []).find((e) => e.jobKey === jobKey);
    const followers = entry?.followers ?? p?.followers ?? [];
    if (entry?.followers) this._journalUpdate(ctx, jobKey, { followers: null });
    if (p) delete p.followers;
    return followers;
  },

  /**
   * Tell followers how the job they followed ended: the same final reaction
   * as its requester, and their History rows the same outcome, said as
   * theirs through the earlier request.
   */
  _tellFollowers(ctx, followers, { status, emoji, why = null }) {
    if (!followers?.length) return;
    const detail = status === 'sent'
      ? 'posted, with an earlier request for it'
      : `${status === 'failed' ? 'failed' : status}, with an earlier request for it${why ? ` — ${why}` : ''}`;
    // A member's own request sent again (_resentFilm) stays "resent": it was
    // never a request of its own, so its row is not counted as a second film
    // posted, or failed, and only says how the first one ended.
    const ended = status === 'sent' ? 'posted' : status === 'failed' ? 'failed' : status;
    const resentDetail = `${ended}, with their first request for it${why && status !== 'sent' ? ` — ${why}` : ''}`;
    const hist = ctx.store.get('history', []) ?? [];
    let changed = false;
    for (const f of followers) {
      const row = hist.find((h) => h.id === f.historyId);
      if (row) {
        Object.assign(row, f.resend ? { detail: resentDetail, finishedAt: Date.now() } : { status, detail, finishedAt: Date.now() });
        changed = true;
      }
      // Its ⬇️ from the place it followed, if still with the pacer, is out of date now (_handOn).
      const handoff = this._handoffs?.get(f.msgId);
      if (handoff) handoff.ended = true;
      if (emoji) this._reactFor(ctx, { msgId: f.msgId, msgKey: f.msgKey, chatJid: f.chatJid, record: { route: f.route } })(emoji);
    }
    if (changed) ctx.store.set('history', hist);
    ctx.log.info(`told ${followers.length} request(s) that followed it: ${status}`);
  },

  /**
   * Write on a journalled job when it first started, once: a restart's
   * recovery puts a film that had started back in as running, ahead of
   * everything waiting (_recoverFilms). A film waiting for the download slot
   * has nothing on disk yet to say it had started - Thor: The Dark World
   * waited a minute for it on 2026-10-11 - so its work cannot be the only
   * sign. A retry in this process keeps the first start.
   */
  _journalStarted(ctx, jobKey) {
    if (!jobKey) return;
    try {
      const entry = (ctx.store.get('pending', []) ?? []).find((p) => p.jobKey === jobKey);
      if (entry && !(Number(entry.startedAt) > 0)) this._journalUpdate(ctx, jobKey, { startedAt: Date.now() });
    } catch (err) { ctx.log?.warn?.(`could not journal that "${jobKey}" started: ${err.message}`); }
  },

  /** Merge `patch` into a journalled job; a null value removes that field. */
  _journalUpdate(ctx, jobKey, patch) {
    const pending = ctx.store.get('pending', []) ?? [];
    const entry = pending.find((p) => p.jobKey === jobKey);
    if (!entry) return;
    for (const [k, v] of Object.entries(patch)) {
      if (v == null) delete entry[k]; else entry[k] = v;
    }
    ctx.store.set('pending', pending);
  },

  /**
   * Delete a job's work - its directory, through the delete guard - when
   * nothing will resume from it. Never under a run that has it open: that
   * run deals with its own (see deliver).
   */
  _dropWork(ctx, jobKey) {
    if (!jobKey) return;
    forgetKept(jobKey);
    try {
      const freed = filmWork(ctx, jobKey)?.drop();
      if (freed) ctx.log?.debug?.(`removed the work of ${jobKey} (${fmtBytes(freed)})`);
    } catch (err) { ctx.log?.warn?.(`could not remove the work of ${jobKey}: ${err.message}`); }
  },

  async onMessage(msg, ctx) {
    const cfg = ctx.config.movieRequests;

    // `#rules` / `#rules-<name>`, asked IN A GROUP. A group with an assigned
    // set gets that set on a bare `#rules`.
    //
    // Never in a private message. rulesReplyFor returns null for a DM, and
    // that is not an oversight to tidy up: replying to unsolicited PMs is one
    // of the clearest spam signals there is, and it got this number flagged.
    //
    // This runs before the request-group check, so it already answers in any
    // group - a beta group included - and the reply goes to the group asking.
    // Nothing about it needed to change for beta testing.
    if (!msg.fromMe && msg.text) {
      const reply = rulesReplyFor(cfg, msg);
      if (reply) {
        try {
          await ctx.bot.sendText(msg.chatJid, reply.text, { quoted: msg });
          ctx.log.info(`sent rules (${reply.command}) in ${msg.chatJid}`);
          // The PM-tidying that used to live here is gone with the PM route:
          // rules are only answered in groups now, and a group chat is never
          // deleted. Keeping the branch would have been unreachable code
          // guarding against a case that can no longer happen.
        } catch (err) { ctx.log.warn(`could not send rules: ${err.message}`); }
        return;
      }
    }

    if (msg.fromMe || !msg.isGroup) return;

    const beta = isBetaGroup(ctx.config, msg.chatJid);
    if (!beta && !cfg.requestGroups?.includes(msg.chatJid)) return;

    // An answer to a "which one?" list (see pick-list.js). Looked at before
    // moderation and the cooldown on purpose: the answer is a bare digit,
    // which moderation would delete as chatter, and the cooldown would refuse
    // it whenever the member's clock or the flood backstop is running - both
    // for doing exactly what the bot asked. The same holds for a number that
    // answers someone else's open list, which is ignored rather than
    // moderated (_claimPick).
    // With no list journalled this is one store read and changes nothing.
    //
    // In a beta group too, before the test code is asked for: a bare number
    // answering a test's open list is the rest of a test already started.
    //
    // While requests are paused (request-pause.js) a pick in a main group is
    // held like any request: claimed now, so it is first-pick-wins and the
    // list does not run out under it, and run when requests resume. A wrong
    // number, or a number that is not this member's to give, is answered as
    // ever: it runs nothing.
    //
    // A member's reaction reaches here too (bot.js, msg.reaction), and a
    // keycap number on their own open list is a pick exactly as the typed
    // number is (the operator, 2026-10-01: "for beta001 users should be able
    // to react with a number emoji instead of replying"). Every other
    // reaction - another emoji, another member's, one on any other message -
    // is nothing to this plugin: not a request, not chatter to moderate, not
    // a beta message to answer, and never reacted back to.
    const claim = this._claimPick(msg, ctx);
    if (claim) {
      if (!beta && claim.index != null && ctx.requestPause?.isPaused()) return this._holdPick(claim, msg, ctx);
      return this._answerPick(claim, msg, ctx);
    }
    if (msg.reaction) {
      ctx.log.debug?.(`ignoring a reaction ${msg.reaction.emoji} from ${formatPhone(msg.senderNumber) ?? msg.senderJid} `
        + `on ${msg.reaction.targetId ?? '?'} in ${msg.chatJid}: not a pick from an open list of theirs`);
      return;
    }

    // A beta group takes movie AND TV tests, and only tests: a message counts
    // there only when it starts with the code of a feature being tested
    // ("$beta004 #request minority report 2002" - readBetaTest). The operator,
    // 2026-09-29: "if someone requests a regular movie like captain Phillips
    // it should be ignored because it's not the beta". Each message is
    // claimed by exactly one plugin: TV takes the TV tests, and this one the
    // film tests and every answer that is not a request.
    let test = null;
    if (beta) {
      test = readBetaTest(ctx.config, msg.text);
      if (test.outcome === 'tv') return;
      if (test.outcome !== 'movie') return this._answerNotATest(test, msg, ctx);
      // From here the message is the request after the code, as a member
      // would type it in a main group; its key is the tester's message's. A
      // $stamtest is judged as a main group would judge it (featureGroup).
      msg = { ...msg, text: testRequestText(test, cfg), ...(test.stam ? { stam: true } : {}) };
      // "$beta004 2": a tester who puts the code on everything, the number
      // answering their list included.
      const coded = this._claimPick(msg, ctx);
      if (coded) return this._answerPick(coded, msg, ctx);
    }

    // Rule enforcement: the request groups are requests-only, so anything that
    // isn't a properly formatted request gets removed for everyone (the same
    // thing an admin would do by hand). Admins are exempt by default.
    //
    // It runs in beta groups too, deliberately: moderation is group-facing
    // behaviour like any other and is worth trialling where a mistake deletes
    // a tester's message rather than a member's. Nothing it does can reach
    // outside the group the message was posted in.
    try {
      const isAdmin = ctx.bot.isGroupAdmin(msg.chatJid, { jid: msg.senderJid, number: msg.senderNumber });
      const bad = checkMessage(msg, cfg, { isAdmin });
      if (bad) {
        await ctx.bot.deleteMessage(msg);
        ctx.log.info(`🧹 deleted a message in ${msg.chatJid} from ${formatPhone(msg.senderNumber) ?? msg.senderJid}: ${bad.reason} (${bad.detail})`);
        if (cfg.enforcement?.warnByDm && msg.senderJid) {
          try {
            const dm = await ctx.bot.sendText(msg.senderJid, violationNotice(bad, cfg, msg));
            // Keep the bot's chat list clean without destroying the exchange:
            // archive rather than delete, so the notice is still there if the
            // person replies or an admin needs to check what was sent.
            if (cfg.enforcement?.archiveAfterDm !== false) {
              try {
                await ctx.bot.archiveChat(msg.senderJid, dm ? { key: dm.key, messageTimestamp: dm.messageTimestamp } : null);
                ctx.log.debug(`archived the PM to ${msg.senderJid}`);
              } catch (err) { ctx.log.debug(`could not archive the PM: ${err.message}`); }
            }
          } catch (err) { ctx.log.debug(`could not DM the rule notice: ${err.message}`); }
        }
        return;
      }
    } catch (err) {
      ctx.log.warn(`enforcement failed (message left in place): ${err.message}`);
    }

    if (!msg.text) return;
    let text = msg.text.trim();
    if (cfg.requirePrefix) {
      const p = (cfg.prefix ?? '').trim();
      if (!p || !text.toLowerCase().startsWith(p.toLowerCase())) return;
      text = text.slice(p.length).trim();
    }
    if (!text || text.length < 2 || text.length > 200) return;

    // Per-user cooldown keeps ONE person from filling the queue. Keyed by
    // sender, deliberately: ten different people requesting at the same moment
    // must all get through - that is a busy group working normally, not abuse.
    // Its clock starts only when a request queues a film (_cooldownGate).
    const gate = await this._cooldownGate(msg, ctx, { beta, what: text });
    if (!gate.go) return;

    // Requests paused from the panel (src/core/request-pause.js): ⏸️, held,
    // and run in order when they resume. Only here, where the message is a
    // request that would run: chatter was moderated above as ever, and a
    // request inside the cooldown was answered 🚫 above, as live. Held, it
    // is not being looked up, so the member's next request does not wait for
    // it; it meets the cooldown again when it runs (replayHeld). A beta
    // group is never paused - the pause is for while something is being
    // tested there.
    if (!beta && ctx.requestPause?.isPaused()) {
      gate.lookup?.drop();
      await ctx.requestPause.hold(ctx, msg, { plugin: this.name, text, emoji: cfg.reactions?.paused });
      return;
    }

    return this._runCounted(msg, text, ctx, { beta, test: test?.code ?? null, insideCooldown: gate.insideCooldown }, gate.lookup);
  },

  /** The section's cooldown: the clock, the backstop and the requests in flight (src/core/request-cooldown.js). */
  _cool() {
    this._cooldown ??= new MemberCooldown({
      section: 'films', limits: { ...COOLDOWN_LIMITS, inFlightWaitMs: FILM_LOOKUP_WAIT_MS },
    });
    return this._cooldown;
  },

  /**
   * Is the member held to the cooldown at all? Not when the section's
   * cooldown is 0, and never a group admin, as always.
   */
  _throttled(ctx, msg) {
    const cooldown = (ctx.config.movieRequests?.cooldownSecondsPerUser ?? 0) * 1000;
    if (!(cooldown > 0)) return 0;
    const isStaff = ctx.bot.isGroupAdmin?.(msg.chatJid, { jid: msg.senderJid, number: msg.senderNumber }) ?? false;
    return isStaff ? 0 : cooldown;
  },

  /**
   * The cooldown, for a request about to run - as it arrives, or as a held
   * one is run on resume, "as if it had just arrived" (request-pause.js).
   *
   * Its clock starts only when one of the member's requests queues a film,
   * the operator's rule after Ben Lewis's three 🚫 of 2026-10-01: his
   * "shaft 2019" was refused as rated R, and the hour's clock it had started
   * refused everything he asked for next. "cooldown is only if the members
   * first request actually puts an item in queue, otherwise why we cooling
   * him down???" (src/core/request-cooldown.js has the whole rule). So:
   * wait for any request of theirs still being looked up, since it may yet
   * queue; then 🚫 if their clock is running (unless nobody else is waiting
   * and the option says so, _cooldownWaived), or if the flood backstop has
   * tripped, which nothing waives.
   *
   * Resolves to { go: false } once a refusal has been answered, or to
   * { go: true, lookup, insideCooldown } where `lookup` (null when the member
   * is not held to the cooldown) is settled with what the request came to
   * (_runCounted), and `insideCooldown` is the running clock it was let
   * through inside of, if it was: the film it queues is an extra in the
   * fair order (src/core/queue.js), the operator's rule of 2026-10-12.
   */
  async _cooldownGate(msg, ctx, { beta = false, what = null } = {}) {
    const cfg = ctx.config.movieRequests;
    const cooldown = this._throttled(ctx, msg);
    if (!cooldown) return { go: true, lookup: null, insideCooldown: null };
    const keys = cooldownKeys(msg.senderJid, { beta });
    const cool = this._cool();
    // Judged once nothing of theirs is in flight, and synchronously: a second
    // request let in before this one is registered would not wait for it.
    const turn = await cool.turn(keys, {
      what: what ?? msg.text, log: ctx.log, who: msg.senderJid,
      judge: () => {
        // One moment for the refusal and for whether the request is inside
        // the cooldown, so the two can never disagree.
        const now = Date.now();
        // A request that would be held (onMessage, below) counts the
        // member's requests held already: each is an answer on resume.
        const pending = !beta && ctx.requestPause?.isPaused?.()
          ? (ctx.requestPause.heldFrom?.(this.name, msg.senderJid) ?? 0) : 0;
        const no = cool.refusal(ctx.store, keys, { cooldownMs: cooldown, pending, now });
        if (no?.why === 'clock' && this._cooldownWaived(ctx, cfg, msg, beta)) {
          ctx.log.info(`letting ${msg.senderJid} through the cooldown: nobody else is waiting (cooldownOnlyWhenOthersWait)`);
          return { go: true, insideCooldown: insideCooldown(ctx.store, keys, { cooldownMs: cooldown, now }) };
        }
        return no ? { go: false, no } : { go: true, insideCooldown: null };
      },
    });
    if (!turn.go) {
      await this._tooSoon(ctx, msg, turn.no);
      return { go: false };
    }
    return { go: true, lookup: turn.lookup, insideCooldown: turn.insideCooldown ?? null };
  },

  /**
   * A request refused by the cooldown: 🚫, and the reply where replies on
   * blocking are on. The log line starts "ignoring <sender>: cooling down",
   * which the hourly check's scan matches (incident-scan.js), whichever of
   * the two refused it.
   */
  async _tooSoon(ctx, msg, no) {
    const cfg = ctx.config.movieRequests;
    const wait = Math.max(1, Math.ceil(no.leftMs / 1000));
    ctx.log.info(`ignoring ${msg.senderJid}: cooling down (${wait}s left) - `
      + (no.why === 'flood'
        ? `${no.count} requests answered without queueing in the last ${Math.round(this._cool().limits.floodWindowMs / 60_000)} min`
          + `${no.held ? ` and ${no.held} held while requests are paused` : ''} (the flood backstop)`
        : `their request "${no.clock?.what ?? '?'}" was queued ${Math.round((Date.now() - no.clock.at) / 1000)}s ago`));
    // Dropping this silently is what made the bot look broken: the
    // requester saw no reaction at all and assumed it had missed them.
    // Say so instead.
    // 'critical': being told you are going too fast is the whole point of the
    // throttle. Silence here is precisely what made this look broken before.
    try { await ctx.bot.react(msg, cfg.reactions.tooFast ?? '🚫', { kind: 'critical' }); }
    catch { /* best effort */ }
    if (cfg.replyOnBlock) {
      try {
        await ctx.bot.sendText(msg.chatJid,
          `🚫 Request denied — too many at once. Please wait ${wait}s and send it again. `
          + 'One request at a time, so everyone gets a turn.', { quoted: msg });
      } catch (err) { ctx.log.warn(`could not reply: ${err.message}`); }
    }
  },

  /**
   * Run a request that has passed the cooldown, and settle what it came to
   * for the member's cooldown: a film queued starts their clock; any other
   * answer counts towards the flood backstop - the bot's own failures too
   * ('error': a lookup that failed, a full queue, no posts group), each a
   * reaction and often a notifications line (request-cooldown.js says why).
   * Not one that never got as far as an answer: it threw, whatever its
   * record said by then - a film whose queueing threw after its row was
   * marked 'queued' was counted against the member (found in review,
   * 2026-10-01) - or it ended still 'checking'.
   */
  async _runCounted(msg, text, ctx, opts, lookup) {
    let record = null;
    let out;
    let threw = true;
    try {
      out = await this._runRequest(msg, text, ctx, { ...opts, onRecord: (r) => { record = r; } });
      threw = false;
    } finally {
      const status = record?.status ?? 'checking';
      lookup?.settle(ctx.store, {
        queued: !threw && out?.queued === true,
        // Nor the member's own request sent again while it waits: it is the
        // request they made, not another answer to hold against them
        // (_resentFilm; Iron Man 3, 2026-10-11). Only the first time: sent
        // again and again, each one is still a reaction on the number, and
        // the backstop is what caps them (`again`).
        counts: !threw && status !== 'checking' && (status !== 'resent' || out?.again === true),
        what: record?.title ? `${record.title}${record.year ? ` (${record.year})` : ''}` : text,
        log: ctx.log,
        who: msg.senderJid,
      });
    }
    return out;
  },

  /**
   * A request held while requests were paused, run now that they are not
   * (request-pause.js replay): exactly where onMessage would have run it,
   * "as if it had just arrived". So it meets the cooldown again: it met it
   * when it was held, but a request of the member's held before it may have
   * queued a film since, on resume, and the clock starts only then (the
   * operator's rule of 2026-10-01, _cooldownGate). Refused, it gets 🚫 in
   * place of its ⏸️. A pick runs as the pick it was, on its list's original
   * request, and as a pick meets no cooldown.
   *
   * Its History row is dated now, when it is run, as any request's `at` is;
   * when the member sent it is `requestedAt`, from the message, as ever. It
   * used to be dated back to when it was held, and a row written after the
   * daily digest had read that hour was then in no digest at all (found in
   * review, 2026-10-01).
   */
  async replayHeld(item, ctx) {
    const msg = heldMessage(item.msg);
    if (item.kind === 'pick') {
      const list = this._pickJournal(ctx).find((l) => l.id === item.listId);
      // The ⏸️ was on the number the member sent; the pick's reactions go on
      // their request, as for any pick, so it is taken off the number. A
      // pick made by reacting had its ⏸️ on the request (hold), and that is
      // dealt with below.
      if (!item.msg?.reaction) {
        try { await ctx.bot.react(msg, '', { kind: 'normal' }); }
        catch (err) { ctx.log.debug(`could not take ⏸️ off the held pick: ${err.message}`); }
      }
      // Gone, or no longer waiting for this pick: said by the pause, with ⚠️
      // on the number, in the log and the audit log.
      if (!list || list.state !== 'picked' || list.pickedIndex !== item.index) {
        throw new Error(`its list is ${list ? list.state : 'gone'}, so there is no pick to run`);
      }
      // A pick made by reacting: its ⏸️ is on the request, and a pick runs
      // without a 🔍 of its own (its request was already showing one when
      // the list went out), so ⏸️ would stay through the whole lookup. Put
      // back what the request showed before it was held.
      if (item.msg?.reaction) {
        const emoji = ctx.config.movieRequests.reactions?.researching;
        try { if (emoji) await ctx.bot.react(list.msg, emoji, { kind: this._reactionKind(ctx.config.movieRequests, emoji) }); }
        catch (err) { ctx.log.debug(`could not take ⏸️ off the request of a held reaction pick: ${err.message}`); }
      }
      return this._runPick(ctx, list, item.index, item.form ?? 'digit');
    }
    const gate = await this._cooldownGate(msg, ctx, { beta: false, what: item.text });
    if (!gate.go) return;
    return this._runCounted(msg, item.text, ctx, { beta: false, test: null, insideCooldown: gate.insideCooldown }, gate.lookup);
  },

  /**
   * A member's request run again because its film has arrived on the server
   * - the wanted recheck found it there (src/core/wanted-arrival.js), or an
   * admin pressed "Re-run requests". The operator, 2026-10-11: when a
   * request comes back not in the library they ask the host for the film,
   * and "once its available" it should go in the queue, with the member's
   * message reacted to. Noah Fields's "my suicide 2009" of 2026-09-14 was
   * on the server from 2026-10-09 and nobody was told.
   *
   * Run where onMessage runs a request, as replayHeld runs a held one: on
   * the member's ORIGINAL message, rebuilt from its History row (`item.msg`,
   * slimMessage's shape), so every reaction lands on what they sent, and
   * through every gate a request meets - the rating, the AI check, the
   * duplicate check, the queue - with the route it had. Not moderation: the
   * message was judged when it arrived. Not the cooldown either: the bot owed
   * them this answer, so it neither waits for their clock nor starts it.
   *
   * `item` is { msg, text, typed, rerun: { trigger, by, was } }: `text` the
   * row's `request` (what was looked up, as the panel's Re-run sends it) and
   * `typed` what the member typed when that differs. Resolves to what the
   * request came to: { status, detail, queued, title, year }.
   */
  async rerunArrived(item, ctx) {
    const msg = heldMessage(item.msg);
    let record = null;
    const out = await this._runRequest(msg, item.text, ctx, {
      beta: false, test: null, typed: item.typed ?? null, rerun: item.rerun ?? {}, onRecord: (r) => { record = r; },
    });
    return {
      status: record?.status ?? 'checking', detail: record?.detail ?? null, queued: out?.queued === true,
      title: record?.title ?? null, year: record?.year ?? null,
    };
  },

  /**
   * A member's request whose film arrived on the server and has been POSTED
   * since, with another request for it (wanted-arrival.js, postedSince):
   * answered as a request that followed one is answered once that one is
   * posted (_tellFollowers) - the done reaction on their own message, and
   * their History row 'sent', saying with whose request - and nothing is
   * queued. Re-run through rerunArrived it would have been queued and posted
   * to the same posts group a second time, nobody having asked again: review
   * found it (2026-10-11) with Hannah's "a snapshot of forever 2022" sent at
   * 10:00 and Mia's older request re-run after it. _runRequest's twin
   * check sees only what is waiting, never what has gone out.
   *
   * `item` is rerunArrived's, with `posted`: { id, requester, at } of the
   * request it went out with. Resolves to { status: 'sent', detail, queued:
   * false, posted: true }.
   */
  async answerArrivedPosted(item, ctx) {
    const msg = heldMessage(item.msg);
    const cfg = ctx.config.movieRequests;
    const rows = ctx.store.get('history', []) ?? [];
    const row = rows.find((h) => h.id === msg.id) ?? {};
    const other = item.posted ?? {};
    const whose = String(other.requester ?? '').trim();
    const detail = `posted since it arrived on the server, with ${whose ? `${phoneOut(whose)}'s` : 'another'} request for it`;
    const rerun = item.rerun ?? {};
    const record = {
      ...row, id: msg.id, status: 'sent', detail, finishedAt: Date.now(),
      rerun: {
        why: 'it arrived on the server', at: Date.now(), trigger: rerun.trigger ?? null, by: rerun.by ?? null,
        ...(rerun.was ? { was: rerun.was } : {}), postedWith: other.id ?? null,
      },
    };
    this.upsertHistory(ctx, record);
    const emoji = cfg.reactions.done;
    try { await ctx.bot.react(msg, emoji, { kind: this._reactionKind(cfg, emoji) }); }
    catch (err) { ctx.log.warn(`could not react: ${err.message}`); }
    ctx.log.info(`re-run of "${row.typed ?? row.request ?? msg.text}": ${row.title ?? 'the film'} was ${detail} - `
      + 'not posted again, and the member\'s message is marked done');
    return { status: 'sent', detail, queued: false, posted: true, title: row.title ?? null, year: row.year ?? null };
  },

  /**
   * A pick claimed while requests are paused: logged as _answerPick logs it,
   * then held. A pick made by reacting cannot carry a ⏸️ (a reaction is
   * never reacted to), so its ⏸️ goes on the request its list answers, kept
   * with it as `reactOn` - where the ⚠️ goes too if it cannot be run on
   * resume (request-pause.js).
   */
  async _holdPick(claim, msg, ctx) {
    const { list, index, form } = claim;
    const item = list.items[index];
    ctx.log.info(`🔢 ${formatPhone(msg.senderNumber) ?? msg.senderJid} picked ${index + 1} (${pickSaid(msg)}, ${form}) from `
      + `${offeredLabels(list.items).join('/')} for "${list.request}" -> ${item.title} (${item.year}) - held: requests are paused`);
    await this._pickUnquestion(ctx, list);
    await ctx.requestPause.hold(ctx, msg, {
      plugin: this.name, kind: 'pick', text: msg.reaction ? `reacted ${msg.reaction.emoji}` : msg.text,
      emoji: ctx.config.movieRequests.reactions?.paused,
      extra: { listId: list.id, index, form, ...(msg.reaction && list.msg ? { reactOn: list.msg } : {}) },
    });
  },

  /**
   * A $stamtest has been given its one answer (plugin-manager.js). A list
   * the test opened was never posted - it is in that answer - so the answer
   * is what a tester sees and reacts to, and a keycap on it picks from the
   * list like a reaction on a posted one (the operator's "react with a number
   * emoji instead of replying", 2026-10-01). The list is the one journalled
   * under the tester's message, with a made-up key (stam-test.js).
   */
  onStamAnswered(msg, sent, ctx) {
    const id = sent?.key?.id;
    if (!id || !msg?.id) return;
    const list = this._pickJournal(ctx).find((l) => l.id === msg.id && isStamKey(l.listKey));
    if (!list || listMessageIds(list).includes(id)) return;
    this._pickUpdate(ctx, list.id, { listIds: [...(list.listIds ?? []), id] });
    ctx.log.debug?.(`pick list for "${list.request}" ($stamtest) can be answered by reacting to its answer ${id}`);
  },

  /**
   * May a request inside its cooldown go through, because nobody else is
   * waiting? Only with the option on (cooldownOnlyWhenOthersWait, the
   * operator's "if queue is completely empty then obviously theres no issue
   * with someone doing multiple requests", 2026-09-30), and only when no
   * other member has anything waiting or running in the queue - films and TV
   * share it - the member's own requests aside (queue.hasOthers).
   *
   * It also used to ask that the request that started the member's clock had
   * queued a film (queue.queuedSince): the clock then started at every
   * request, and without that a member alone in an idle queue - the usual
   * state - was let through every time, ten bare titles drawing ten lists
   * (found in review, 2026-09-30). Since 2026-10-01 the clock starts only
   * when a request queues (_cooldownGate), so a running clock always means
   * exactly that, and what limits the requests that queue nothing is the
   * flood backstop, which this never waives.
   *
   * Never for a beta test, which keeps a clock of its own. A queue that
   * cannot answer counts as busy, so the cooldown holds.
   */
  _cooldownWaived(ctx, cfg, msg, beta) {
    if (beta || !cfg.cooldownOnlyWhenOthersWait) return false;
    const q = ctx.queue;
    if (typeof q?.hasOthers !== 'function') return false;
    return !q.hasOthers(requestMemberKey(msg));
  },

  /**
   * A message in a beta group that is not a film test: said once, by this
   * plugin, however the TV plugin reads it.
   *
   * No code: nothing at all - no reaction, no reply, no History row, no
   * cooldown - and one log line, as the operator asked. A code that is not
   * being tested gets ❓ and the codes that are, so a tester is not left
   * guessing; a request of the other kind than the code's feature, one
   * quoted line saying which kind it tests.
   */
  async _answerNotATest(test, msg, ctx) {
    const who = formatPhone(msg.senderNumber) ?? msg.senderJid;
    if (test.outcome === 'ignore') {
      ctx.log.info(`beta: ignoring a message from ${who} in ${msg.chatJid} - it has no test code ($betaNNN)`);
      // Said nowhere in the group, so the transcript is the one place the
      // hourly check can see that it was ignored rather than missed.
      ctx.bot.transcript?.note?.(msg.chatJid, { ref: msg.id, note: 'ignored: no test code' });
      return;
    }
    const say = async (text) => {
      try { await ctx.bot.sendText(msg.chatJid, text, { quoted: msg }); }
      catch (err) { ctx.log.warn(`could not reply to a beta message: ${err.message}`); }
    };
    if (test.outcome === 'unknown') {
      const why = { retired: 'has finished', off: 'is not being tested right now', unknown: 'is not a test' }[test.why]
        ?? 'is not a test';
      ctx.log.info(`beta: ${who} used ${test.typed}, which ${why} - ❓ and the tests running now`);
      const emoji = ctx.config.movieRequests.reactions.notFound ?? '❓';
      try { await ctx.bot.react(msg, emoji, { kind: this._reactionKind(ctx.config.movieRequests, emoji) }); }
      catch (err) { ctx.log.warn(`could not react: ${err.message}`); }
      // A finished test's code is still in the testers' guides pasted into
      // the group - beta001's pick list above all, which left beta for every
      // group on 2026-10-11. What it tested is now tried the way the main
      // groups answer it, so the tester is told how.
      const stam = test.why === 'retired'
        ? ` To see how the main groups answer a request now, start it with $${STAM_CODE}.` : '';
      await say(`❓ ${test.typed} ${why}.${stam} ${runningTestsLine(ctx.config)}`);
      return;
    }
    if (test.outcome === 'several') {
      ctx.log.info(`beta: ${who} sent ${test.count} tests in one message - asked to send them one at a time`);
      const emoji = ctx.config.movieRequests.reactions.notFound ?? '❓';
      try { await ctx.bot.react(msg, emoji, { kind: this._reactionKind(ctx.config.movieRequests, emoji) }); }
      catch (err) { ctx.log.warn(`could not react: ${err.message}`); }
      await say(`❓ That's ${test.count} tests in one message. Send each $beta line as a message of its own, and each gets its own answer.`);
      return;
    }
    const kind = test.feature?.scope === 'tv' ? 'TV' : 'movies';
    const ask = test.feature?.scope === 'tv' ? 'ask for a show and its season' : 'ask for a film';
    if (test.outcome === 'tv-off') {
      ctx.log.info(`beta: ${who} tried $${test.code}, a TV test, with TV requests switched off`);
      await say(`$${test.code} tests TV, and TV requests are switched off.`);
      return;
    }
    ctx.log.info(`beta: ${who} asked for the other kind under $${test.code}, which tests ${kind} - told so`);
    await say(`$${test.code} tests ${kind} — ${ask}.`);
  },

  /**
   * One request, from identifying the film to queueing it.
   *
   * `text` is what gets looked up. For an ordinary request it is what the
   * member typed. For a pick from a "which one?" list it is the chosen
   * version's "<Title> <Year>", run against the ORIGINAL request message -
   * so every reaction lands on the request the member is watching, not on
   * their digit - with the route that request was given when it arrived.
   *
   * The record's `request` is always the text that was looked up, and what
   * the member typed, when that differs, is kept beside it as `typed`. The
   * panel's Re-run and the bulk re-run feed `request` straight back into
   * requeue(), and a picked row that kept the bare "Venom" there was re-run
   * as whichever Venom OMDb returns first - the 2018 one, for a member who
   * had picked 2011 (found in review, 2026-09-22).
   *
   * `rerun` marks a request run again because its film has arrived on the
   * server (rerunArrived): its row says so, its notifications line says so,
   * and an answer that the film is still missing goes on no list again.
   *
   * `insideCooldown` is the member's running clock the request was let
   * through inside of (_cooldownGate, and a pick's, _runPickNow): the film
   * it queues goes into the queue and the journal marked with it, an extra
   * in the fair order (src/core/queue.js).
   */
  async _runRequest(msg, text, ctx, {
    beta = false, test = null, pick = null, route: pickRoute = null, typed = null, at = null, onRecord = null,
    rerun = null, insideCooldown: cooled = null,
  } = {}) {
    const cfg = ctx.config.movieRequests;
    const record = {
      id: msg.id,
      at: at ?? Date.now(),                  // when the bot received/processed it
      requestedAt: msg.timestamp || null,    // when the user actually sent it
      requester: msg.pushName ?? msg.senderJid,
      requesterJid: msg.senderJid,
      requesterNumber: msg.senderNumber ?? null,
      // From the digits: a pick list answered after a restart replays the
      // message it journalled, whose display may be the old "+1 (…)" form.
      requesterNumberDisplay: formatPhone(msg.senderNumber) ?? phoneOut(msg.senderNumberDisplay ?? null),
      groupJid: msg.chatJid,
      request: text,
      status: 'checking',
      title: null,
      year: null,
      rated: null,
      detail: null,
    };
    // Decided now and carried on the record - which is what the journal
    // stores - so delivery, notifications and a post-restart resume all use
    // the destination this request was given when it arrived. `beta: true` is
    // also what marks the row in History. A main request gets neither field,
    // so its record is exactly what it always was.
    //
    // A pick re-uses the route its list was given, not a new one: the list
    // may have been answered after the beta settings changed, or after a
    // restart, and the request is still the one that arrived back then.
    //
    // A beta route makes the request a test (isTestRoute), and carries the
    // code it was asked under, for its answer and its History row.
    const fresh = beta ? resolveRoute(ctx.config, msg.chatJid) : null;
    const route = pick ? pickRoute : (fresh ? { ...fresh, ...(test ? { test } : {}) } : null);
    const testing = isTestRoute(route);
    if (route) {
      record.beta = true;
      record.route = route;
    }
    if (testing) record.test = testCodeOf(route);
    if (typed && typed !== text) record.typed = typed;
    if (pick) {
      record.pickList = pick;
      // Written now, not when the request settles. A restart while the pick
      // is being looked up (up to the library timeout) otherwise left the row
      // at 'pick-list' for good, counted as an open list in the digest, with
      // nothing to say the member had answered it. As 'checking' it is marked
      // 'lost' by reconcileHistory, and recoverPickLists runs it again.
      this.upsertHistory(ctx, record);
    }
    // Run again because the film arrived (src/core/wanted-arrival.js). The
    // row keeps the message's id, so it is the member's request answered
    // anew, not a second request, and keeps what it was answered first.
    if (rerun) {
      record.rerun = {
        why: 'it arrived on the server', at: Date.now(), trigger: rerun.trigger ?? null, by: rerun.by ?? null,
        ...(rerun.was ? { was: rerun.was } : {}),
      };
    }
    onRecord?.(record);

    const react = async (emoji) => {
      if (!emoji) return;
      // A beta request whose group has since become a main group reacts no
      // more there - the reactions from deliver() can come hours later.
      if (safeRoute(ctx.config, record.route)?.originIsMain) return;
      const kind = this._reactionKind(cfg, emoji);
      try { await ctx.bot.react(msg, emoji, { kind }); }
      catch (err) { ctx.log.warn(`could not react: ${err.message}`); }
    };

    const label = () => record.title
      ? `${record.title}${record.year ? ` (${record.year})` : ''}`
      : `"${record.request}"`;

    // What a re-run's notifications lines add, so the admins reading the
    // group can tell a member's old request answered anew from a new one.
    const rerunSays = rerun ? ' (re-run: it arrived on the server)' : '';

    // `note` replaces the standard notifications-group line, for an answer
    // that knows more than its status does (which years we actually hold).
    // `notify: false` sends none, for an answer already given as a quoted
    // reply in the request group (the "add a word or the year" reply).
    const finish = (status, detail, emoji, { note = null, notify = true } = {}) => {
      record.status = status;
      record.detail = detail;
      this.upsertHistory(ctx, record);
      if (!notify) return react(emoji);
      // A refusal is its reaction alone: no line in the notifications group,
      // which is for what is actually downloaded and sent (the operator,
      // 2026-10-21: "if something gets denied it gets denied simple reaction
      // is enough"; the reactions already tell 📬 not on the server from ❓
      // not a film at all). `notifyRefusals` brings the lines back, and
      // `announceRated` the rating one with its reply. A failure (⚠️) still
      // says so: that one is the bot's, not the request's.
      if (REFUSALS.has(status) && cfg.notifyRefusals !== true) return react(emoji);
      if (status === 'blocked-rating' && cfg.announceRated !== true) return react(emoji);
      const notes = {
        'blocked-rating': `\u26d4 ${label()} \u2014 rated ${record.rated}, can't be posted`,
        'not-yet-theatrical': `\ud83c\udfaa ${label()} \u2014 still in theaters, not on the server yet`,
        'not-in-library': `\ud83d\udcec ${label()} \u2014 not in the library`,
        'not-found': `\u2753 ${label()} \u2014 couldn't find that title`,
        // Only the "too vague for OMDb" bounce uses this line now; the one for
        // a title the server holds several of lists the years (needYearNote).
        // The old "(e.g. Dune 2021)" example named a different film entirely.
        // A test's resend needs its code, or the beta group ignores it.
        'need-year': `\ud83d\udcc5 ${label()} \u2014 too many films by that name; send it again with the year`
          + `${testing && record.test ? ` (start it with $${record.test})` : ''}`,
      };
      const line = note ?? notes[status];
      if (line) this._notify(ctx, 'blocked', `${line}${rerunSays}`, record);
      return react(emoji);
    };

    const maybeReply = async (body) => {
      if (!cfg.replyOnBlock) return;
      try { await ctx.bot.sendText(msg.chatJid, body, { quoted: msg }); }
      catch (err) { ctx.log.warn(`could not reply: ${err.message}`); }
    };
    // "X is rated R." in the request group: off unless announceRated is on
    // (the operator, 2026-10-21: "Turn off the bot responding in the group
    // when something is rated R I believe the reaction is good enough").
    const ratedReply = (body) => (cfg.announceRated === true ? maybeReply(body) : null);

    /* -------- 0a. Several films in one request? One at a time -------- */
    // "the equalizer 1 & 2" and "the extraction 1 & 2" (Matt Fisher) and
    // "rocky 1 2 3 4 5 and 6" (JJ) were each answered 📅 "too many matches -
    // needs a year" when OMDb found the words too broad. The operator,
    // 2026-10-11: "these dont need year, they should get denied because they
    // didnt ask for 1 movie at a time". So the request is refused here, before
    // the library's list and before OMDb, at no lookup cost: ☝️, a History
    // row of its own, and a notifications line saying to send each film in a
    // message of its own (several-films.js). Decided before the 🔍 too, so
    // the answer is one reaction, not two. A beta test or a $stamtest is
    // refused the same way, as a main group would refuse it, with its code on
    // the lines it suggests. Nothing here touches the wanted list or the
    // not-in-library list: the films were never looked up. A pick is a title
    // and year the library offered, never several films.
    const several = pick ? null : severalFilms(text);
    if (several) {
      // A test made now always carries its code on its route (route.test).
      const prefix = suggestPrefix(route, requestPrefix(cfg));
      const emoji = cfg.reactions.oneAtATime ?? '☝️';
      ctx.log.info(`"${text}" asks for ${several.count ? `${several.count} films` : 'a whole series'} in one request `
        + `(${several.how}) - refused: one film per request${testing ? ' (a test)' : ''}`);
      await maybeReply(oneFilmReply(several, prefix));
      return finish('one-at-a-time', oneFilmDetail(several), emoji, { note: oneFilmNote(text, several, prefix, emoji) });
    }

    // Let the requester know we're on it before the (sometimes slow) lookup.
    // A pick runs on a request that is already showing it: sending the same
    // reaction again would spend a message on no change at all.
    if (!pick) await react(cfg.reactions.researching);

    /* ------- 0. Several films on the server? Offer them ------- */
    // Asked BEFORE the metadata lookup and the content check, so a question
    // costs no OMDb or Gemini quota: the library alone knows what we hold and
    // how each film is rated. "Several" is every film whose title starts with
    // the words typed - the remakes of one title and the franchise around it
    // (see pick-list.js). Only for a request with no year - one with a year
    // has already answered the question - and only while the operator wants
    // the question asked at all (requireYearWhenAmbiguous).
    //
    // In every group, with no beta flag. It was the beta feature beta001,
    // and on 2026-10-10 a config.json with `beta.features: {}` had it Off
    // although the operator had taken it out of beta: Heat, Insomnia and
    // Venom were each asked "which year?" at 4a below instead (pick-list.js).
    // A $stamtest, and a test of any other feature in a beta group, gets it
    // too, as a main group would.
    //
    // `libraryYear` marks a request whose year came from Jellyfin rather than
    // from the member, as a pick's does.
    let libraryYear = !!pick;
    // What the member typed, and the row as it was, when step 0 went ahead
    // with one film under the library's title: OMDb may not know that title
    // (lookupHeldFilm below).
    let onlyAsTyped = null;
    if (!pick && asksWhichOne(cfg, text)) {
      const offer = await this._offerPickList(msg, text, ctx, { record, route, finish, maybeReply });
      if (offer?.answered) return;
      // Exactly one film could be sent - the rest are refused anyway, or it
      // is the only one starting with those words: there is nothing to ask,
      // so the request goes ahead for that one, by title and year. On
      // 2026-09-22 "harry potter" otherwise became whatever OMDb ranked
      // first; this asks for the film the server actually holds. It is
      // beta001's rule, which the operator approved for every group, and
      // went there with the list (2026-10-11).
      if (offer?.only) {
        ctx.log.info(`pick list: only ${offer.only.title} (${offer.only.year}) could be sent - going ahead with it`);
        onlyAsTyped = { text, request: record.request, typed: record.typed };
        text = `${offer.only.title} ${offer.only.year}`;
        record.typed = record.request;
        record.request = text;
        libraryYear = true;
      }
    }

    /* ---------------- 1. Identify the film ---------------- */
    // A request that already HAS a year is never asked for one: "ocean's 11
    // (2001)" was, on 2026-09-22 06:34, because OMDb found the title too broad
    // even with the year. lookupMovie now searches within that year itself;
    // if that fails too, the request goes on below to the library (and to
    // Gemini, when it is on) exactly like a title OMDb does not know, and
    // ends in "not found" rather than in a question already answered.
    //
    // An OMDb outage throws here only once its tries are used up (omdb.js,
    // since "First daughter 2004" got ⚠️ on 2026-10-12 for an outage of
    // under 90 seconds), with the last try's error as it always read:
    // "OMDb HTTP 525", the ⚠️ below and History's detail unchanged.
    let found;
    try {
      found = await lookupMovie(text, { apiKey: ctx.config.omdb.apiKey });
    } catch (err) {
      // "Too many results" is not a failure on our side - the request was too
      // vague ("oceans 11" matches a dozen titles). Ask for a year instead of
      // showing the generic something-went-wrong reaction. With a year it
      // falls through to the library instead (see above).
      if (isTooBroad(err) && !extractYear(text)) {
        ctx.log.info(`"${text}" is too vague for OMDb - asking for a year`);
        return finish('need-year', 'too many matches - needs a year', cfg.reactions.needYear);
      } else if (!isTooBroad(err)) {
        ctx.log.error(`OMDb lookup failed for "${text}": ${err.message}`);
        return finish('error', `metadata lookup failed: ${err.message}`, cfg.reactions.failed);
      }
    }

    // A pick names a version the library has, in the library's year. When
    // OMDb files that film a year either side, the exact-year lookup finds
    // nothing, and the member would get ❓ for something the bot has just
    // offered them. The exact title in the neighbouring year is the same film.
    // The same holds for the one film step 0 went ahead with, which now
    // happens for every bare title that only one film on the server starts
    // with, not just for a remake - and that one, when OMDb knows the
    // library's title in no neighbouring year, is looked up by the words the
    // member typed, as it was before step 0 went ahead (lookupHeldFilm: the
    // library may name the film its own way). The panel's dry run takes the
    // same steps.
    if (!found && libraryYear) {
      const what = pick ? 'the pick' : 'the only match';
      const again = await lookupHeldFilm(text, {
        apiKey: ctx.config.omdb.apiKey,
        asTyped: onlyAsTyped?.text ?? null,
        onError: (how, err) => ctx.log.warn(how === 'near-year'
          ? `near-year lookup for ${what} "${text}" failed: ${err.message}`
          : `lookup of "${onlyAsTyped?.text}", as typed, failed: ${err.message}`),
      });
      found = again?.found ?? null;
      if (again?.how === 'near-year') {
        ctx.log.info(`${pick ? 'pick' : 'only match'} "${text}": OMDb has it as ${found.movie.title} (${found.movie.year}) - `
          + 'the library\'s year is one off; going ahead with that');
      } else if (again?.how === 'as-typed') {
        ctx.log.info(`only match "${text}": OMDb does not know the library's title - looked up as typed, `
          + `"${onlyAsTyped.text}": ${found.movie.title} (${found.movie.year})`);
        text = onlyAsTyped.text;
        record.request = onlyAsTyped.request;
        if (onlyAsTyped.typed === undefined) delete record.typed;
        else record.typed = onlyAsTyped.typed;
        libraryYear = false;
      }
    }

    // Nothing from the metadata provider. Rather than answering "not found"
    // to what is usually just a misspelling, search the library itself: it
    // is a bounded set of titles this requester could actually be sent, and
    // it corrects spellings that OMDb and TMDB simply cannot.
    if (!found) {
      ctx.log.info(`"${text}" not resolved directly - researching the library`);
      let corrected = null;
      try {
        corrected = await researchLibrary(text, ctx.config.library);
      } catch (err) {
        ctx.log.warn(`library research failed: ${err.message}`);
      }

      if (corrected) {
        // Re-run the metadata lookup against the corrected spelling so the
        // rating check still has real data to work from.
        try {
          found = await lookupMovie(
            `${corrected.title}${corrected.year ? ` ${corrected.year}` : ''}`,
            { apiKey: ctx.config.omdb.apiKey },
          );
        } catch (err) {
          ctx.log.warn(`re-lookup of "${corrected.title}" failed: ${err.message}`);
        }
        if (found) {
          ctx.log.info(`research: "${text}" -> "${corrected.title}"`);
          record.corrected = corrected.title;
        }
      }
    }

    // Last resort: ask Gemini what film this describes. OMDb matches titles
    // literally, so a paraphrase, a description or a foreign title gets
    // nowhere. Whatever it names is fed straight back through OMDb - the
    // rating must come from the metadata provider, never from a model. When
    // Gemini's quota is gone the fallback providers are asked instead; the
    // same rule makes that safe, since none of them can supply a rating either.
    if (!found && ctx.config.gemini?.enabled) {
      const guess = await identifyTitle(text, ctx.config.gemini, {
        ai: ctx.config.ai,
        onResult: (r) => ctx.contentHealth?.noteProviders?.(r.attempts),
      });
      const minConfidence = Number(ctx.config.gemini.minConfidence ?? 0.6);
      if (guess && guess.confidence >= minConfidence) {
        try {
          found = await lookupMovie(
            `${guess.title}${guess.year ? ` ${guess.year}` : ''}`,
            { apiKey: ctx.config.omdb.apiKey },
          );
        } catch (err) {
          ctx.log.warn(`re-lookup of Gemini's "${guess.title}" failed: ${err.message}`);
        }
        if (found) {
          ctx.log.info(`gemini: "${text}" -> "${guess.title}" (confidence ${guess.confidence}`
            + `${guess.provider && guess.provider !== 'gemini' ? `, answered by ${providerLabel(guess.provider)}` : ''})`);
          record.corrected = guess.title;
          if (guess.provider) record.identifiedBy = guess.provider;
        } else {
          ctx.log.info(`gemini suggested "${guess.title}" but OMDb does not know it`);
        }
      } else if (guess) {
        ctx.log.info(`gemini was unsure about "${text}" (${guess.confidence}) - not using it`);
      }
    }

    // Shared by the two places a film request turns out to be a series.
    const answerAsSeries = async (asSeries) => {
      ctx.log.info(`"${text}" is a TV series on the server (${asSeries.name}) - pointing at the TV group`);
      // A beta group takes TV requests itself (when TV is on), so the useful
      // advice there is to name a season, not to go to another group. In a
      // test, under the code of a TV test: the example is copied as it is,
      // and a message with no code is ignored there, or with this film
      // test's code told it is the wrong kind.
      const tvCode = testing ? testCodeFor(ctx.config, 'tv', record.test) : null;
      await maybeReply(route && ctx.config.tvRequests?.enabled
        ? testing && !tvCode
          ? `*${asSeries.name}* is a TV series, not a film, and no TV test is running.`
          : `*${asSeries.name}* is a TV series, not a film — ask for a season, `
            + `e.g. "${tvCode ? `$${tvCode} ` : ''}${asSeries.name} season 1".`
        : `*${asSeries.name}* is a TV series, not a film — `
          + 'ask for it in the TV requests group instead.');
      return finish('is-a-series', `TV series "${asSeries.name}"`, cfg.reactions.notFound);
    };

    if (!found) {
      // "smiling friends S01" names a show, not a film: OMDb has no film by
      // that name, and this branch answered "not recognised" (❓) while the
      // series sat in the library (hourly check 20261011T060001Z). Ask the
      // series check, with the season marker taken off, before giving up.
      const showName = parseTvRequest(text).show || text;
      const diag = [];
      const asSeries = await seriesInLibrary(showName, ctx, diag).catch((err) => {
        ctx.log.warn(`series check failed for "${text}": ${err.message}`);
        return null;
      });
      if (asSeries) return answerAsSeries(asSeries);
      ctx.log.info(`no match for "${text}" even after researching the library`);
      return finish('not-found', 'no matching film', cfg.reactions.notFound);
    }

    let movie = found.movie;
    record.title = movie.title;
    record.year = movie.year;
    record.rated = movie.rated;
    // The film's IMDb id on its row, so a request refused for a film the
    // server later gets is matched to its wanted entry by id, not by a title
    // the library may spell otherwise (src/core/wanted-arrival.js).
    if (movie.imdbId) record.imdbId = movie.imdbId;
    ctx.log.info(
      `request "${text}" -> ${movie.title} (${movie.year}), rated ${movie.rated ?? 'unknown'} ` +
      `[from ${record.requester}${record.requesterNumberDisplay ? ` ${record.requesterNumberDisplay}` : ''}]`,
    );

    /* ---------------- 2. Rating gate ---------------- */
    // A film on the bypass list is sent whatever its rating, with no AI check
    // - the operator's "Send it, no AI check" (2026-09-29, rating-overrides.js).
    // A film its letter blocks and no entry covers is refused here, unless
    // something that needs the library's answer could still send it: an
    // entry added by Jellyfin link, which matches the library's item alone,
    // or the AI check, asked about the film the library holds (ratingGate).
    // The panel's dry run asks the same ratingGate(), so it cannot tell the
    // operator otherwise.
    const letter = ratingGate(ctx.store, movie, cfg, { gemini: ctx.config.gemini, ai: ctx.config.ai });
    const ratingOverride = letter.override;
    const refuseOnLetter = async () => {
      ctx.log.info(`blocked: ${movie.title} is rated ${movie.rated}`);
      await ratedReply(`${movie.title} (${movie.year}) is rated ${movie.rated}.`);
      return finish('blocked-rating', `rated ${movie.rated}`, cfg.reactions.rated);
    };
    if (ratingOverride && letter.blocked) {
      ctx.log.info(`${movie.title} is rated ${movie.rated}, but ${describeOverride(ratingOverride)}`
        + ' - on the bypass list, so it is sent without the AI check');
    } else if (letter.refused) {
      return refuseOnLetter();
    } else if (letter.deferred) {
      ctx.log.info(`${movie.title} is rated ${movie.rated} - decided once the library has answered`
        + ' (a bypass-list entry may cover its copy there, or the AI check may clear it)');
    }

    /* ---------------- 3. Do we actually have it? ---------------- */
    // The library is checked before the release window on purpose. Whether a
    // film is still in cinemas is not a policy question - it is simply the
    // usual reason a title has not reached the server yet. So if we happen to
    // have it, it goes out regardless.
    let hit;
    // The film the library holds under a similar title that findInLibrary
    // refused as another film, for the not-in-library record below.
    let otherFilm = null;
    // The year the member typed, when it is this film's (typedYearOf). The
    // pick list's own requests carry the library's year for the copy picked,
    // and are held to it the same way.
    const askedYear = typedYearOf(text, movie);
    try {
      // Also search for what the person actually typed: OMDb's canonical
      // title and the library's often disagree.
      //
      // A library film is a hit only when it can be the film asked for: a
      // title that is not identical, from a year more than one away, is not
      // (findInLibrary, differentFilm). "#request Barefoot 2014" on
      // 2026-09-29 was answered with Barefoot Gen (1983), posted, and queued
      // again when Mia asked a second time. The operator: "she clearly said
      // 2014 in her message though so shouldve returned not in library and
      // shown on my not in library list". So it now falls through to step 4,
      // like any other film the server does not have.
      //
      // So is a copy of the very title asked for, when the member typed a
      // year and the copy is more than one away from it. "Dune 1984" was sent
      // Dune (2021), the only Dune on the server; the operator: "Not in
      // library" - the typed year makes it a different film even though the
      // title is identical. With several copies held (Venom 1981, 2005, 2011,
      // 2018) the typed year's is the one chosen. A bare title has no typed
      // year: several copies are the pick list's or step 4a's question, and
      // one copy is sent, as before.
      hit = await findInLibrary(movie.title, movie.year, ctx.config.library, {
        alsoTry: [text, record.request].filter(Boolean),
        onOtherFilm: (o) => { otherFilm = o; },
        typedYear: askedYear,
        // What the member typed, which alone earns a copy of the identical
        // title from far off OMDb's year: "dune" is answered with the one
        // Dune held, but "fast and furios 6", which OMDb took for Fast and
        // Furious (1939), was sent Fast & Furious (2009) on 2026-10-11 at
        // 11:21 UTC (whyOtherFilm).
        typed: text,
        // A copy the library names otherwise but which carries this IMDb id
        // is the film asked for (Harry Potter and the Philosopher's Stone,
        // tt0241527, listed as wanted from 2026-10-06 as "...Sorcerer's Stone").
        imdbId: movie.imdbId ?? null,
        // Password auth renews its own token if Jellyfin invalidates it;
        // persist the new one so the next request does not re-authenticate.
        onTokenRefreshed: (auth) => ctx.configStore.update({
          library: { jellyfin: {
            accessToken: auth.accessToken,
            userId: auth.userId ?? '',
            userName: auth.userName ?? '',
          } },
        }),
      });
    } catch (err) {
      ctx.log.error(`library lookup failed: ${err.message}`);
      return finish('error', `library error: ${err.message}`, cfg.reactions.failed);
    }

    /* ---------------- 4. Not here - say why ---------------- */
    // The whole "the server does not have this film" answer, in one place, so
    // every way of reaching it records it the same way. `closest` is the film
    // the library does hold under a similar title, when there is one.
    //
    // It is reached from here, when the library holds nothing that can be the
    // film, and from 4b, when the file it did return turns out by its own
    // metadata to be another film. 4b used to answer that with ❓ and "We
    // couldn't find X on the server. The closest file is Y" and record
    // nothing, so the refusal never reached the not-in-library list, the
    // wanted list or the daily mail. That was the answer Mia's "Barefoot
    // 2014" got on 2026-09-29 once b91afc8 stopped Barefoot Gen (1983) going
    // out, and the operator's verdict was "she clearly said 2014 in her
    // message though so shouldve returned not in library and shown on my not
    // in library list".
    //
    // `refused` is the library's copy when 4b found it to be another film. It
    // is remembered on the wanted entry, so the list's recheck - which looks
    // titles up as step 4 does, and runs no file check - never resolves the
    // film with that copy (wanted.js, rejectCopy).
    const notInLibrary = async (closest, { refused = null } = {}) => {
      // A request that asks for a season of a show is not a film the server
      // lacks, whatever OMDb filed under those words (tvShapeOf: the 2 Broke
      // Girls PaleyFest extra, 2026-09-14). It is asked about as a series,
      // under the show's name, and never goes on the wanted list.
      const tvShape = tvShapeOf(text, movie);
      // Only now is the release window worth checking: it distinguishes
      // "still in cinemas, ask again later" from "we just do not have it".
      // Not for a season of a show, which is never in cinemas.
      let theatrical = { theatricalOnly: false, reason: '', source: 'skipped', confidence: 0 };
      try {
        if (!tvShape) theatrical = await isTheatricalOnly(movie, cfg);
      } catch (err) {
        ctx.log.warn(`theatrical check failed: ${err.message}`);
      }

      if (theatrical.theatricalOnly) {
        ctx.log.info(`not in library, still theatrical: ${movie.title} (${theatrical.reason})`);
        await maybeReply(`${movie.title} (${movie.year}) is still in theaters, so it is not on the server yet.`);
        // Worth tracking too, but kept apart in the email: nobody can add this
        // one yet, so it is a "watch for the release" item, not a to-do. Not
        // for a test: the wanted list is what members asked for. Nor for a
        // re-run (wanted-arrival.js): its entry is already there, resolved,
        // and its outcome is kept on it with the re-run's.
        if (!testing && !rerun) recordWanted(ctx.store, movie, { requester: record.requester, reason: 'not-yet-theatrical', request: text, refused });
        return finish('not-yet-theatrical', theatrical.reason, cfg.reactions.theaters);
      }

      // The year the member typed, if they typed one. OMDb's year is not it:
      // a bare "barefoot" is judged against the film OMDb resolved it to
      // (Barefoot, 2014), but only a year the member wrote says which film
      // they meant, whatever the library or the TV section holds.
      const typedYear = extractYear(text);

      // Before saying "not in the library", check whether it is a TV SERIES
      // sitting right there. "outer banks" resolves to an obscure 2012 film
      // that genuinely is not on the server, while the well-known series is -
      // so the answer was technically true and completely unhelpful.
      // Collected whether or not the check succeeds, so a miss records why the
      // escape hatch did not save it. It was previously `.catch(() => null)`
      // with no logging on any path, so a 401, a timeout or a DNS failure here
      // was indistinguishable from "definitely not a series" - and both came
      // out as "not in the library".
      const seriesDiag = [];
      if (tvShape) seriesDiag.push(`asked as a show ("${tvShape.show}"): ${tvShape.why}`);
      let asSeries = await seriesInLibrary(text, ctx, seriesDiag, tvShape?.show).catch((err) => {
        seriesDiag.push(`the "is it a series?" check failed: ${err.message}`);
        ctx.log.warn(`series check failed for "${text}": ${err.message}`);
        return null;
      });
      // A typed year holds for a series just as it does for a film. The
      // series search drops the year and forgives a subtitle left off, so
      // "Star Trek 2009", once findInLibrary had rightly refused Into Darkness
      // and Beyond, found Star Trek: The Next Generation (1987) and was told
      // "is a TV series, not a film" - kept off the not-in-library list for
      // every franchise with a series starting with the same words (Batman,
      // Spider-Man, Transformers...), and for "Barefoot 2014" too as soon as
      // the TV library held a Barefoot Contessa. A series whose title is the
      // one typed ("Outer Banks 2020") is still pointed at the TV group.
      // The rule the film search uses (whyOtherFilm), so an identical title
      // counts too: "Fargo 1996" with only the Fargo series (2014) on the
      // server was told "is a TV series" and never reached the not-in-library
      // list, the operator's Dune 1984 verdict ("the typed year makes it a
      // different film even though the title is identical") skipped here.
      // Not for a request that names a season: a year beside a season is
      // the season's, and the show began years before it.
      if (asSeries && typedYear && !tvShape && whyOtherFilm(
        { title: cleanRequestText(text), year: movie?.year ?? typedYear },
        { title: asSeries.name, year: asSeries.year },
        { typedYear },
      )) {
        const why = `series "${asSeries.name}" (${asSeries.year}) is not the ${typedYear} film asked for`;
        seriesDiag.push(why);
        ctx.log.info(`"${text}": ${why}`);
        asSeries = null;
      }
      if (asSeries) {
        return answerAsSeries(asSeries);
      }

      // The film the library does hold under a similar title, when there is
      // one, goes first on the record: it is the answer to "but it's right
      // there", which is what anyone reading the list will ask.
      const near = closest ? closestNote(closest) : null;
      ctx.log.info(`not in library: ${movie.title}${near ? ` (${near})` : ''}`
        + `${testing ? ' (a test - not added to the wanted list)' : ''}`);
      // A member who typed no year never said which film they meant, so the
      // one the server holds is worth naming: "cars" is Cars (2006) to OMDb,
      // and a server with only Cars 3 used to answer it with "The closest
      // file is Cars 3 - ask for that by name". A year typed, as Mia's was,
      // has already answered that question, and gets 📬 alone.
      if (closest && !typedYear) {
        await maybeReply(`📬 *${movie.title}*${movie.year ? ` (${movie.year})` : ''} isn't on the server — `
          + `we do have "${closest.title}"${closest.year ? ` (${closest.year})` : ''}; `
          + 'ask for it by name if that\'s the one.');
      }
      // A test is answered 📬 like any request, and adds nothing to the
      // operator's lists: they are what members asked for, and a tester
      // trying the refusal on purpose is not a film anybody wants.
      if (testing) return finish('not-in-library', near ? `not in library — ${near}` : 'not in library', cfg.reactions.notInLibrary);
      // A re-run because the film arrived, which this lookup still does not
      // find: its wanted entry is there already, resolved by the copy the
      // bot did find, and opening it again here would have the next recheck
      // resolve it and the next re-run open it, in turn. What came of it is
      // kept on the entry and in the hourly report (wanted-arrival.js).
      if (rerun) {
        ctx.log.warn(`re-run of "${text}": ${movie.title}${movie.year ? ` (${movie.year})` : ''} was said to be on the server, `
          + 'but the request\'s own lookup did not find it - the member still needs telling');
        return finish('not-in-library', near ? `not in library — ${near}` : 'not in library', cfg.reactions.notInLibrary);
      }
      // A real film the server does not have is the one thing an admin can
      // actually act on, so keep it rather than letting it end at a reaction.
      // What the member typed goes with it, so the wanted list's recheck
      // (src/core/wanted-recheck.js) searches with their words as well as
      // OMDb's, as this request did. A season of a show is not a film to go
      // and find: it stays off the list (tvShapeOf).
      if (tvShape) {
        ctx.log.info(`"${text}" asks for ${tvShape.show}, a show (${tvShape.why}), and the TV library does not have it`
          + ` - not put on the wanted films (OMDb's answer was ${movie.title}${movie.year ? ` (${movie.year})` : ''})`);
      } else {
        recordWanted(ctx.store, movie, { requester: record.requester, reason: 'not-in-library', request: text, refused });
      }
      // And separately, as a fault: this is a request that cleared every other
      // gate and died at the library lookup alone. Note what was TYPED as well
      // as what it resolved to - when the two disagree, that disagreement is
      // usually the bug.
      recordMiss(ctx.store, {
        kind: 'movie',
        reason: 'not-in-library',
        request: text,
        title: movie.title,
        year: movie.year ?? null,
        requester: record.requester,
        groupJid: msg?.chatJid ?? null,
        searched: [movie.title, text, record.request].filter(Boolean),
        diagnostics: [...(near ? [near] : []), ...seriesDiag],
        detail: movie.imdbId ? `resolved to ${movie.imdbId}` : null,
      });
      return finish('not-in-library', near ? `not in library — ${near}` : 'not in library', cfg.reactions.notInLibrary);
    };
    if (!hit) {
      // A film its rating blocks was refused before the library was asked,
      // with no word about cinemas or the wanted list, and it still is:
      // nothing is there that an entry or the AI check could send.
      if (letter.deferred) return refuseOnLetter();
      return notInLibrary(otherFilm);
    }

    ctx.log.info(`library hit: ${hit.title} (${hit.year}) via ${hit.access}`);
    // The film as requested, before 4b can swap in the file's own metadata:
    // it is what the wanted list and the not-in-library list know it by.
    const requested = movie;

    // The wanted list and the not-in-library list are answered for the film
    // that arrived, and only once it is known which film the file is: after
    // 4b, or at 4a for the copy the library matched, which 4b has not looked
    // at. These two used to run as soon as the library returned anything,
    // before 4b had looked at the file: on 2026-09-29 Barefoot Gen, returned
    // for "Barefoot 2014", took Barefoot off the wanted list and marked its
    // earlier miss answered, and any file 4b refused - as another film, or on
    // its own rating - did the same. That hid the one row that said the
    // server does not have the film.
    //
    // And only when the file IS that film. 4b can settle on another film that
    // shares its title - Dune (2021) for "Dune 1984", which is sent - and then
    // the film asked for is still not on the server: clearing it took Dune
    // (1984) off the wanted list and marked its miss "turned up later". The
    // film actually sent is what has arrived, so it is that one's entries
    // that are answered.
    // A test leaves the operator's lists as they are, either way (see
    // notInLibrary).
    const answerArrived = (sent) => {
      if (testing) return;
      const isRequested = isRequestedFilm(requested, sent, hit);
      const arrived = isRequested ? requested : (sent !== requested ? sent : null);
      if (!isRequested) {
        ctx.log.info(`sending ${hit.title} (${hit.year}) for ${requested.title} (${requested.year}), which is still `
          + 'not on the server - its wanted entry and not-in-library row stay open');
      }
      if (!arrived) return;
      // It has arrived - resolved on the wanted list by the bot, so the daily
      // mail stops asking for something that is already there. Resolved, not
      // dropped: an admin looking at the Wanted card sees who settled it and
      // how, with any notes on it, rather than a line that vanished (the
      // operator, 2026-10-11: "mark as resolved so other admins ... know").
      const by = `${BOT} (found on the server as "${hit.title}" when it was asked for again)`;
      const as = { id: hit.id ?? null, title: hit.title ?? null, year: hit.year ?? null, imdbId: hit.imdbId ?? null };
      if (resolveWanted(ctx.store, wantedKey(arrived), { by, auto: true, as })) {
        ctx.log.info(`"${arrived.title}" is on the server now - marked resolved on the wanted list`);
      }
      // The miss stays on the list, marked answered. A title that was refused
      // and later found is the most useful row there is: either somebody added
      // it, or the bot was wrong the first time - and only keeping the row lets
      // anyone tell those apart afterwards.
      if (resolveMiss(ctx.store, { kind: 'movie', title: arrived.title, year: arrived.year ?? null })) {
        ctx.log.info(`"${arrived.title}" was previously reported not in the library - that miss is now answered`);
      }
    };

    /* ------------- 4a. More than one copy? Ask which year ------------- */
    // Deliberately checked here rather than against OMDb. Plenty of obscure
    // films share a title with a famous one - OMDb lists an "Inception"
    // from 2014 - and prompting for a year because of a film nobody has is
    // just noise. It only matters when the server genuinely holds several.
    //
    // Asked before the library file is looked up again (4b) and before the
    // AI check (4c), as the panel's dry run asks it. It came after them,
    // and on 2026-09-29 the check began to be asked about R films no entry
    // covers; review of that change found that a "#request scarface" with
    // the 1932 and 1983 films on the server would spend a check, one of
    // Gemini's twenty a day, on a request that then ended in "which year?" -
    // and that a rated copy was refused before the member could name a year
    // that might be sent. The operator's rule is that the check is asked
    // only when its answer can change the outcome.
    const requestedYear = extractYear(text);
    const copies = hit.sameTitled ?? [];
    if (cfg.requireYearWhenAmbiguous && !requestedYear && copies.length > 1) {
      const years = copies.map((c) => c.year).filter(Boolean).join(', ');
      // The notifications-group line lists only the years that could
      // actually be sent, each vetted on the library's rating as a pick list
      // would be (the bypass list and the AI check included): offering a year
      // that then comes back ⛔ is a second dead end.
      const offer = listableVersions(copies, cfg, {
        store: ctx.store, aiClears: aiCanClear(ctx.config.gemini, ctx.config.ai),
      }).map((c) => c.year);
      ctx.log.info(`"${movie.title}" is held in ${copies.length} versions (${years}) - asking for a year`
        + `${offer.length !== copies.length ? ` (sendable: ${offer.join(', ') || 'none'})` : ''}`);
      // Step 0 offers these copies as a list, in every group since the list
      // left beta (2026-10-11: Heat, Insomnia and Venom got this question
      // because a config had lost the list's mode). What still arrives here
      // is what step 0 could not list: its library search failed or timed
      // out, the library is not Jellyfin, no copy can be sent on the
      // library's rating, or the words typed are not the start of the
      // library's title and only OMDb matched them to it. The reply in the
      // request group (replyOnBlock) is the one a list that cannot be shown
      // gives for remakes (askForYear), word for word.
      await maybeReply(`There is more than one "${movie.title}" on the server (${years}). Which year?`);
      answerArrived(movie);
      return finish('need-year', `${copies.length} copies: ${years}`, cfg.reactions.needYear,
        { note: needYearNote(movie.title, offer, suggestPrefix(route, requestPrefix(cfg))) });
    }

    /* --------- 4b. Verify the rating against the ACTUAL file --------- */
    // A file its rating blocks is refused unless an entry covers the film it
    // is, which is then sent at 4c like any listed film, or the AI check may
    // yet clear it there (fileGate). The panel's dry run takes the same step.
    //
    // A file identified as another film than the one asked for - another
    // year's film of the same title - is judged on its own from here: on the
    // entry that covers IT, if any, and on its own rating. Neither the entry
    // nor the letter grade step 2 found for the film asked for is carried
    // past it (`swapped`). Carried, an entry for "Scarface 1932" sent the R
    // 1983 film the server held, with no check at all (reproduced in review,
    // 2026-09-29, before it shipped).
    let fileOverride = null;
    let swapped = false;
    {
      const file = await fileGate({
        store: ctx.store, movie, hit, cfg, override: ratingOverride,
        aiMayClear: aiCanClear(ctx.config.gemini, ctx.config.ai), omdbKey: ctx.config.omdb.apiKey, log: ctx.log,
        typedYear: askedYear,
      });
      const { rc } = file;
      if (file.refused === 'blocked-rating') {
        ctx.log.info(`blocked on re-check: library file "${hit.title}" (${hit.year}) is rated ${rc.rated}`);
        await ratedReply(`${hit.title} (${hit.year}) is rated ${rc.rated}.`);
        return finish('blocked-rating', `rated ${rc.rated} (library file)`, cfg.reactions.rated);
      }
      fileOverride = file.override;
      if (rc.rechecked && file.override) {
        ctx.log.info(`library file "${hit.title}" (${hit.year}) is rated ${rc.rated}, and ${describeOverride(fileOverride)}`
          + ' covers it - on the bypass list, so it is sent without the AI check');
      }
      if (file.refused === 'wrong-film') {
        // The file on the server is a different film. Sending it would post
        // something nobody asked for, under the requested film's name, with a
        // "posted!" tag to the requester. So the film asked for is not on the
        // server, and it is answered and recorded exactly as step 4 answers
        // one (see notInLibrary), naming the file as the closest film.
        ctx.log.warn(`library file for "${movie.title}" is actually `
          + `"${rc.found?.title}" (${rc.found?.year}) - refusing to send it`);
        return notInLibrary(rc.found?.title ? { title: rc.found.title, year: rc.found.year ?? null, reason: rc.why } : null, {
          refused: { id: hit.id ?? null, title: hit.title ?? null, year: hit.year ?? null, imdbId: hit.imdbId ?? null },
        });
      }
      if (file.movie !== movie) {
        swapped = true;
        movie = file.movie;
        record.title = movie.title; record.year = movie.year; record.rated = movie.rated;
        if (movie.imdbId) record.imdbId = movie.imdbId;
      }
    }
    answerArrived(movie);

    // Already waiting? Answered before the AI check as well as after it
    // (step 6), as a panel Re-run is: a second "#request Kill Me Three
    // Times" while the first waited spent a second check, and with Gemini
    // overloaded it ended ⛔ "rated R" while the first request's job went on
    // to post the film (reproduced in review, 2026-09-29).
    //
    // A test is judged against the REAL queue: nothing a test asks for is
    // ever queued, so "asked for twice" (beta004) can only be tried with a
    // film that is genuinely waiting.
    const waitingFor = testing ? null : route;
    const early = this._filmWaiting(ctx, movie, waitingFor);
    if (early) return this._duplicateFilm(ctx, { msg, record, movie, route, react, twin: early });

    /* --------- 4c. The bypass list, and what the AI check can clear -- */
    //
    // The letter grade answers the wrong question. It conflates violence,
    // language and sex, and says nothing at all about a film no board
    // classified - which is how "Kill Me Three Times" was blocked for an R
    // earned on violence. So a film its rating blocks may be asked about, and
    // about the film that will ACTUALLY be sent: the library's title, not the
    // metadata record, which has more than once turned out to be a different
    // film. The answer only ever helps it through - the operator's "No, AI
    // only helps" (2026-09-29): a film its rating lets through is sent and
    // nothing is asked, and "nudity", an unsure answer or none leave a rated
    // film refused on its rating, never on the AI's say.
    //
    // The bypass list is looked for again with the LIBRARY's title and id, so
    // an entry added by Jellyfin link applies to a request that arrived as
    // free text. A listed film is sent with no AI check: "Send it, no AI
    // check". contentGate() is the same step the panel's dry run takes, so
    // the two cannot disagree about a listed title again (film-gate.js).
    let bypassReason = null;
    {
      const g = ctx.config.gemini ?? {};
      const gateOpts = {
        store: ctx.store, movie, hit, override: fileOverride,
        // The letter grade at step 2 still counts when the file's own rating
        // does not block it: a refusal deferred there is settled here - for
        // the film asked for. A film swapped for another goes by its own.
        ratedBlocked: !swapped && letter.blocked ? true : null,
        cfg, gemini: g, ai: ctx.config.ai,
      };
      // A full queue refuses the film whatever the check says, so a check is
      // not spent on it. A film the check will not be asked about keeps the
      // answer it always had (a rated one is refused on its rating). A test
      // takes no place in the queue, so a full one does not stop it.
      if (!testing && contentGateAsks(gateOpts) && ctx.queue.hasRoom?.(1) === false) {
        ctx.log.warn(`queue is full, rejecting request for "${movie.title}" before asking the AI check`);
        return finish('error', 'queue full', cfg.reactions.failed);
      }
      const gate = await contentGate({
        ...gateOpts,
        // A check that could not run leaves the rating to decide, which is
        // safe but silent. Every attempt is counted so that a check which
        // keeps failing - all morning on 2026-09-22 - raises the alarm
        // instead of leaving one warn line per film that nobody reads.
        onResult: (r) => {
          ctx.contentHealth?.record({
            ...r, title: hit.title ?? movie.title, year: hit.year ?? movie.year, source: 'request',
          }).catch((err) => ctx.log.warn(`content check health: ${err.message}`));
        },
      });
      const { verdict, failed, call } = gate;

      if (gate.bypass) {
        // Put on the film's History row once it is queued (step 6), as the
        // answer to "why did an R go out?" - and only then: a row that ends
        // "which year?", a duplicate or "queue full" sent nothing, and said
        // "sent: on the bypass list" all the same (reproduced in review,
        // 2026-09-29).
        bypassReason = call.reason;
        ctx.log.info(`${hit.title ?? movie.title} (rated ${movie.rated || 'unrated'}): ${call.reason}`);
      }
      if (gate.checked) {
        // On the film's own record as well, so its history row says the check
        // could not clear it and why, long after the log has rotated.
        if (failed) record.contentCheckSkipped = failed.reason;
        if (failed?.summary) record.contentCheckSkippedWhy = failed.summary;
        if (verdict) record.contentCheck = contentCheckRecord(verdict, call);
        // Journalled with the job, so a restart or a retry puts a film the
        // check cleared back in the queue without asking again (_resume).
        if (!call.blocked) record.aiCleared = call.reason;
        ctx.log.info(`AI check "${hit.title ?? movie.title}" (rated ${movie.rated || 'unrated'}): `
          + `${verdict ? `nudity=${verdict.nudity} (${verdict.confidence}) by ${providerLabel(verdict.provider)}`
            : failed ? `did not run (${failed.reason})` : 'no answer'} `
          + `-> ${call.blocked ? 'not cleared, blocked on its rating' : 'cleared'} (${call.reason}${call.note ? `; ${call.note}` : ''})`);
      }
      if (call.blocked) {
        // Refused on its rating, whatever the AI check said - the words a
        // rated film has always had. The row says what the check made of it.
        const why = gate.checked ? ` — the AI check did not clear it (${notClearedWhy({ verdict, call, failure: failed })})` : '';
        if (!gate.checked) ctx.log.info(`blocked: ${movie.title} is rated ${movie.rated || 'unrated'}`);
        await ratedReply(`${movie.title} (${movie.year}) is rated ${movie.rated || 'unrated'}.`);
        return finish('blocked-rating', `rated ${movie.rated || 'unrated'}${why}`, cfg.reactions.rated);
      }
    }

    /* ---------------- 6. Queue the heavy work ---------------- */
    const postsGroup = route ? route.postsGroup : cfg.postsGroup;
    if (!postsGroup) {
      ctx.log.error('no posts group configured - nowhere to send the file');
      return finish('error', 'posts group not set', cfg.reactions.failed);
    }

    // Nothing is queued twice for the same destination. "minority report
    // 2002" was asked for at 18:38, 20:27 and 21:09 UTC on 2026-09-28 by the
    // same member while the first copy was still being made; every one was
    // queued, two ran side by side - two 4.75 GB downloads on a disk that
    // filled that evening - and the film was posted twice. A film already
    // waiting or in progress is answered as a queued one is, and History
    // says it was a duplicate.
    //
    // From this check to the journal entry below nothing may be awaited: the
    // journal is what the check reads, so a second request answered in
    // between would find nothing and be queued as well.
    const twin = this._filmWaiting(ctx, movie, waitingFor);
    if (twin) return this._duplicateFilm(ctx, { msg, record, movie, route, react, twin });
    // Where a real request is queued, a test says it passed, and stops: "as
    // soon as bot can confirm it will download it should basically be like
    // "test passed" and not actually queue a download of the file
    // interrupting actual requests" (the operator, 2026-09-29).
    if (testing) return this._testPassed(ctx, { msg, record, movie, hit, react, bypassReason });
    const jobKey = `${msg.id}:${movie.imdbId ?? movie.title}`;
    const followers = this._supersedeParked(ctx, movie, route, jobKey);

    // Said on the film's History row, so whoever reads the panel knows what
    // was sent and why. On 2026-10-11 at 11:21 UTC jake's "fast and furios
    // 6" was sent Fast & Furious (2009), the film OMDb's guess shared a title
    // with, and nothing on the row said either that it was not the film the
    // request resolved to or that he had been sent that same film on
    // 2026-10-09 at 03:42 UTC, for "fast and furios 2009" - though his own
    // row of that day was right there in History. A film he asks for again
    // is still sent: he may have lost it, and the row is where an admin sees
    // that it went twice. Nothing new is said in a group: a line there would
    // be group-facing text, which goes through the beta group first.
    const before = this._sentBefore(ctx, record, movie);
    if (before) {
      record.sentBefore = {
        id: before.id ?? null,
        at: before.finishedAt ?? before.at ?? null,
        request: before.typed ?? before.request ?? null,
      };
      ctx.log.info(`${movie.title} (${movie.year}) was sent to ${record.requester} before`
        + `${record.sentBefore.at ? `, at ${new Date(record.sentBefore.at).toISOString()}` : ''}`
        + `${record.sentBefore.request ? `, for "${record.sentBefore.request}"` : ''} - sending it again, noted on its History row`);
    }
    if (!isRequestedFilm(requested, movie, hit)) {
      record.sentFor = {
        title: requested.title ?? null, year: requested.year ?? null,
        file: { title: hit.title ?? null, year: hit.year ?? null },
      };
    }

    if (bypassReason) record.override = bypassReason;
    record.status = 'queued';
    record.enqueuedAt = Date.now();
    this.upsertHistory(ctx, record);

    // Asked for inside the member's cooldown (_cooldownGate): an extra in the
    // fair order whatever else they have in the queue, the operator's rule of
    // 2026-10-12 (src/core/queue.js). On the job and in its journal entry's
    // meta, which a restart puts back on the job and tells expectBack.
    const cooledMeta = cooled ? { insideCooldown: cooled } : {};
    this._journalAdd(ctx, {
      jobKey,
      msgId: msg.id,
      msgKey: msg.key,
      chatJid: msg.chatJid,
      movie: { title: movie.title, year: movie.year, imdbId: movie.imdbId, rated: movie.rated },
      meta: {
        requester: record.requester,
        requesterNumber: phoneOut(record.requesterNumberDisplay ?? record.requesterNumber ?? null),
        group: msg.chatJid,
        imdbId: movie.imdbId,
        // Whose request it is, for the fair order (src/core/queue.js), kept
        // in the journal so a restart puts it back as theirs (_resume).
        memberKey: requestMemberKey(msg),
        ...cooledMeta,
        ...(route ? { beta: true } : {}),
      },
      record,
      at: Date.now(),
      ...(followers.length ? { followers } : {}),
    });
    await react(cfg.reactions.added);
    this._notify(ctx, 'queued', `\ud83c\udfac ${movie.title} (${movie.year}) \u2014 added to the queue${rerunSays}`, record);

    try {
      const jobId = ctx.queue.add({
        label: `${movie.title} (${movie.year})`,
        meta: {
          requester: record.requester,
          requesterNumber: phoneOut(record.requesterNumberDisplay ?? record.requesterNumber ?? null),
          group: msg.chatJid,
          imdbId: movie.imdbId,
          jobKey,
          memberKey: requestMemberKey(msg),
          ...cooledMeta,
          ...(route ? { beta: true } : {}),
        },
        run: (job) => this.deliver({ msg, movie, hit, ctx, job, record, react, jobKey }),
      });
      if (cooled && ctx.queue?.fairShare) {
        ctx.log.info(`${movie.title} (${movie.year}) was asked for inside ${record.requester}'s cooldown, `
          + `${fmtDuration(Math.round(cooled.gapMs / 1000))} after their "${cooled.what ?? '?'}" was queued - `
          + 'an extra in the fair order');
      }
      // Track this message so its queue-position number updates in place.
      this._reactors.set(jobId, { msg, lastEmoji: null, route: record.route ?? null });
      this._updatePositions(ctx);
    } catch (err) {
      this._journalRemove(ctx, jobKey);
      if (err.code === 'QUEUE_FULL') {
        ctx.log.warn('queue is full, rejecting request');
        // Nothing was sent, so History must not say it was (see 4c).
        delete record.override;
        return finish('error', 'queue full', cfg.reactions.failed);
      }
      throw err;
    }
    // The one way out of here that put a film in the queue, and the only one
    // that starts the member's cooldown (_runCounted, _runPickNow). Every
    // other ending resolves to nothing.
    return { queued: true };
  },

  /**
   * The newest History row of an earlier request by the same member - the
   * same number, or the same JID when WhatsApp gave no number - that was
   * sent `movie`, or null. A test in a beta group sends nothing and does not
   * count.
   *
   * History is the record the operator reads, and it keeps the last 200
   * requests (upsertHistory), so a film sent before that is not found: the
   * note is a help to whoever reads the row, not a guarantee.
   */
  _sentBefore(ctx, record, movie) {
    if (!movie?.title) return null;
    const digits = (v) => String(v ?? '').replace(/[^0-9]/g, '');
    const number = digits(record.requesterNumber ?? record.requesterNumberDisplay);
    const theirs = (h) => (number
      ? digits(h.requesterNumber ?? h.requesterNumberDisplay) === number
      : !!record.requesterJid && h.requesterJid === record.requesterJid);
    return (ctx.store.get('history', []) ?? []).find((h) => h && h.id !== record.id
      && h.status === 'sent' && !h.beta && theirs(h)
      && sameTitleWords(h.title, movie.title) && !yearsApart(h.year, movie.year)) ?? null;
  },

  /**
   * The answer to a film asked for while it is already waiting or in
   * progress for the same destination (_filmWaiting): what the TV side
   * answers a season asked for twice - the requester's 🤥 (reactions.duplicate), a line in the
   * notifications group, and a "duplicate" row in History - and nothing is
   * queued.
   *
   * The line is new text in a group, so its wording is staged through the
   * beta group (DUPLICATE_FEATURE). Off, it is the "added to the queue" line
   * an accepted film gets, which is what this request was told before; the
   * film is not queued a second time either way - that is the fix.
   */
  _duplicateFilm(ctx, { msg, record, movie, route, react, twin = null }) {
    const cfg = ctx.config.movieRequests;
    // The member's own request, sent again while it waits: not a duplicate
    // (_resentFilm). Not a test (beta004), whose twin is always a real
    // request it is tried against.
    const own = !isTestRoute(route) ? this._ownRequest(twin, msg) : null;
    if (own) return this._resentFilm(ctx, { msg, record, movie, route, react, twin, own });
    record.status = 'duplicate';
    record.detail = 'already in the queue — waiting from an earlier request';
    this.upsertHistory(ctx, record);
    // Told how the earlier request ends, as its own requester is (_tellFollowers).
    // Not a test (beta004), whose twin is a real request: the test is over
    // once it has been answered, and a real job's outcome - "posted", on a
    // row in the beta group - is not the test's to report.
    if (!isTestRoute(route)) {
      this._addFollowers(ctx, twin, [{
        msgId: msg.id, msgKey: msg.key ?? null, chatJid: msg.chatJid,
        historyId: record.id, requester: record.requester ?? null, route: record.route ?? null,
      }]);
    }
    ctx.log.info(`🎬 ${movie.title} (${movie.year}) is already in the queue${route ? ' (beta)' : ''} - not queueing it again`);
    const said = isEnabled(ctx.config, DUPLICATE_FEATURE, featureGroup(msg))
      ? 'already in the queue, not added again'
      : 'added to the queue';
    // The duplicate's own emoji leads the reworded line, as it marks the
    // request; the "added to the queue" wording keeps the 🎬 it always had.
    const lead = said === 'added to the queue' ? '\ud83c\udfac' : (cfg.reactions.duplicate || '\ud83c\udfac');
    this._notify(ctx, 'queued', `${lead} ${movie.title} (${movie.year}) \u2014 ${said}`, record);
    return react(cfg.reactions.duplicate || cfg.reactions.added);
  },

  /**
   * Is the journalled film `twin` this member's own request - did they ask
   * for it, by their number (memberKey) or their sender? Answers
   * { historyId }, the row of their request, or null.
   *
   * Only the member who asked for it. Somebody who asked for it after them
   * was given 🤥 and follows it (_duplicateFilm), and their asking once more
   * is still a different member asking for a film queued for the group,
   * which is what 🤥 is for. Taking such a follower for its owner gave Diane's
   * second ask a place number where her first got 🤥, and left it out of the
   * hourly check's repeat-request findings (found in review, 2026-10-11).
   */
  _ownRequest(twin, msg) {
    if (!twin || !msg) return null;
    const mine = requestMemberKey(msg);
    const theirs = twin.meta?.memberKey ?? null;
    if ((mine && theirs === mine) || (!!msg.senderJid && twin.record?.requesterJid === msg.senderJid)) {
      return { historyId: twin.record?.id ?? twin.msgId ?? null };
    }
    return null;
  },

  /**
   * A member sending their own request again while it waits or is in
   * progress for them: no 🤥, which is for somebody asking for a film
   * already queued for the group. Their new message shows where the request
   * is now - its place in line while it waits, kept current as the line
   * moves (_updatePositions), or the stage it is at (_whereNow) - and follows
   * it to its end as a duplicate does (_tellFollowers: ✅ once posted).
   *
   * THE INCIDENT, 2026-10-11 (media/stage-reaction.js). Ethan Adams's
   * "Iron Man 3 2013" was picked back up after the 15:22 restart and shown
   * 🔄, which he took for "send it again". He did, at 15:49, and was answered
   * 🤥, and History called his second message a duplicate - which the hourly
   * check would then have reported as a member asking twice. The operator:
   * "Bot asked Ethan to redo the iron man request and then reacted with 🤥
   * when he did".
   *
   * So nothing here is held against them. Its row is 'resent', pointing at
   * the first (`resendOf`): not a duplicate, never counted as a request of
   * its own by the hourly check's repeat-request findings (incident-scan.js
   * requestChains), and never re-run; and it does not count towards their
   * cooldown's flood backstop (_runCounted). The notifications group is told
   * what a duplicate's line tells it, under 🎬 rather than 🤥. Nothing is
   * queued.
   *
   * The first time, that is. Sent again and again (`again`: an earlier
   * message of theirs already follows it), each one is still a reaction on
   * the number, so from the second on it counts towards the backstop, which
   * caps them as it capped the duplicates they used to be, and the
   * notifications group, told once, is not told again. Left uncounted, with
   * a 'critical' line each, eight resends were eight lines and no 🚫 where
   * the backstop had stopped them at five (found in review, 2026-10-11).
   * Resolves to { queued: false, again } for _runCounted.
   */
  async _resentFilm(ctx, { msg, record, movie, route, react, twin, own }) {
    const cfg = ctx.config.movieRequests;
    const again = (twin.followers ?? []).some((f) => f?.resend && f.msgId !== msg.id);
    record.status = 'resent';
    record.detail = 'sent again by the member while their request was still in the queue — the same request, not a second one';
    if (own?.historyId && own.historyId !== record.id) record.resendOf = own.historyId;
    this.upsertHistory(ctx, record);
    this._addFollowers(ctx, twin, [{
      msgId: msg.id, msgKey: msg.key ?? null, chatJid: msg.chatJid,
      historyId: record.id, requester: record.requester ?? null, route: record.route ?? null, resend: true,
    }]);
    ctx.log.info(`🎬 ${movie.title} (${movie.year}) was asked for ${again ? 'once more' : 'again'} by the member it is queued for`
      + `${route ? ' (beta)' : ''} - showing them where it is, not queueing it again`);
    if (!again) {
      const said = isEnabled(ctx.config, DUPLICATE_FEATURE, featureGroup(msg))
        ? 'already in the queue, not added again'
        : 'added to the queue';
      this._notify(ctx, 'queued', `${cfg.reactions?.added || '🎬'} ${movie.title} (${movie.year}) — ${said}`, record);
    }
    const waitingNow = () => {
      try { return (ctx.queue?.snapshot?.().pending ?? []).find((v) => v.meta?.jobKey === twin.jobKey) ?? null; }
      catch { return null; }                 // a queue that cannot answer: the stage, below
    };
    // Waiting for its turn: 🎬 first, as a fresh request is given before its
    // number, and then the message follows its place, as the film's own
    // message does - the latest one only (_resendPlace). The number is 'low',
    // the first thing the budget sheds, and is withdrawn at its turn if the
    // film has started by then: with the number alone, a message sent again
    // was left on 🔍, "looking it up", to the end (found in review,
    // 2026-10-11), which asks for yet another resend.
    let shown = null;
    if (msg.key && waitingNow()) {
      shown = cfg.reactions.added;
      await react(shown);
      const waiting = waitingNow();
      if (waiting) {
        this._reactors ??= new Map();
        let r = this._reactors.get(waiting.id);
        if (!r) this._reactors.set(waiting.id, (r = { msg: null, lastEmoji: null, route: null }));
        if (r.resent) r.resent.gone = true;
        r.resent = { msg, lastEmoji: null, route: record.route ?? null, onShown: this._resendShown(ctx, twin.jobKey, msg.id) };
        this._updatePositions(ctx);
        return { queued: false, again };
      }
    }
    // Started meanwhile, or running already: the stage it is at.
    const where = this._whereNow(ctx, twin);
    if (where !== shown) await react(where);
    return { queued: false, again };
  },

  /**
   * A test that got as far as the queue: every check a real request meets
   * has passed, so it is answered ✅ and "Test passed", and nothing is
   * downloaded, queued or journalled - the operator's rule (2026-09-29, see
   * beta.js). History keeps it as 'test-passed', a beta row: the digest and
   * the activity record count it apart from members' requests, and the
   * hourly check's history findings skip it (incident-scan.js), as they skip
   * every beta row, a test's refusals included.
   */
  async _testPassed(ctx, { msg, record, movie, hit, react, bypassReason = null }) {
    const cfg = ctx.config.movieRequests;
    const code = record.test ?? testCodeOf(record.route);
    const size = hit?.size ? `, ${fmtBytes(hit.size)} on the server` : '';
    // Why a film its rating would block goes out, as on a queued row.
    if (bypassReason) record.override = bypassReason;
    record.status = 'test-passed';
    record.detail = `test${code ? ` ${code}` : ''}: would send ${movie.title} (${movie.year})${size} — nothing was downloaded`;
    record.finishedAt = Date.now();
    this.upsertHistory(ctx, record);
    ctx.log.info(`🧪 test passed${code ? ` (${code})` : ''}: would send ${movie.title} (${movie.year})`
      + ` from ${hit?.title ?? '?'} (${hit?.year ?? '?'})${size} - nothing downloaded or queued`);
    ctx.bot.transcript?.note?.(msg.chatJid, {
      ref: msg.id, note: `test passed: ${movie.title} (${movie.year})`, event: 'test-passed',
      film: { title: movie.title, year: movie.year ?? null }, file: hit ? { title: hit.title ?? null, year: hit.year ?? null } : null,
    });
    await react(cfg.reactions.done);
    // In paragraphs, as the operator asked of the testing group's replies on
    // 2026-09-30 ("message needs to be neater paragraphed").
    try {
      await ctx.bot.sendText(msg.chatJid,
        `✅ *Test passed*${code ? ` ($${code})` : ''}\n\nThe bot would send *${plainText(movie.title)}* (${movie.year})${hit?.size ? `, ${fmtBytes(hit.size)}` : ''}.\n`
          + 'Nothing was downloaded.',
        { quoted: msg });
    } catch (err) { ctx.log.warn(`could not say the test passed: ${err.message}`); }
  },

  /**
   * Where this job's file goes, decided as it is sent.
   *
   * A main request reads the live posts group, as it always has, so moving
   * the posts group still moves the jobs already waiting for it. A beta
   * request keeps the destination it was given on arrival - re-checked against
   * today's config, because in the hours a job can wait that destination may
   * have become a main group (safeRoute). When nowhere isolated is left this
   * throws, and deliver() fails the job with the reason in History rather
   * than post a test to real members.
   */
  _postsGroupFor(ctx, record) {
    const route = safeRoute(ctx.config, record?.route);
    if (!route) return ctx.config.movieRequests.postsGroup;
    if (!route.postsGroup) {
      throw Object.assign(new Error(route.withheld), { code: 'BETA_WITHHELD' });
    }
    return route.postsGroup;
  },

  /** Fetch -> convert -> send. Runs inside the serial queue. */
  async deliver({ msg, movie, hit, ctx, job, record, react, jobKey }) {
    const cfg = ctx.config.movieRequests;
    const isBeta = !!record?.route?.beta;
    const mediaCfg = ctx.config.media;
    const workDir = mediaCfg.workDir;
    fs.mkdirSync(workDir, { recursive: true });

    const outName = safeFilename(movie.title, movie.year, '.mp4');
    // "Plandemic (2020)", or the title alone for a public link queued with no year.
    const film = filmLabel(movie);
    // The film's work, found again by its job's key after a restart (see
    // filmWork). A job with no key - none is queued that way - gets one of
    // its own that nothing keeps.
    const work = filmWork(ctx, jobKey ?? `job:${job.id}`, movie.title);
    if (!work) throw new Error('no work directory is set (media.workDir)');
    // From here it is running, and a restart puts it back as running.
    this._journalStarted(ctx, jobKey);
    let sourcePath = null;
    let downloaded = null;
    let conv = null;
    let alreadySent = false;
    let busyElsewhere = false;
    let room = null;                          // this job's hold on the disk (media/disk-space.js)
    let fetched = 0;                          // bytes this attempt downloaded
    let resumedFrom = 0;                      // where a download kept from before went on from
    const shape = { segmented: mediaCfg.segmentedEncode !== false };

    try {
      try {
        work.lock();
      } catch (err) {
        busyElsewhere = err.code === 'WORK_BUSY';
        throw err;
      }
      if (!ctx.bot.isConnected()) {
        // Fail fast rather than spending minutes on a transfer we cannot
        // deliver. The journal keeps the job for the next start-up.
        throw new Error('WhatsApp is not connected');
      }
      // A beta test with nowhere isolated left to go fails now, not after an
      // hour of download and encode. The upload re-checks: that is the moment
      // that counts.
      if (isBeta) this._postsGroupFor(ctx, record);
      const jobStarted = Date.now();
      let downloadSec = 0;
      let convertSec = 0;
      job.progress({ stage: 'start', text: 'preparing' }, 0);

      /* --- what it had done already --- */
      // A download or an encode that was cut off before it was recorded is
      // nothing to build on, and takes room: it goes.
      work.tidy();
      // Posted already, and the process stopped before it could say so. Read
      // before anything else: whether a post went out does not depend on the
      // library, and asking the library first used to decide it - a film
      // posted just before a restart whose check then failed (the library
      // mounted after the bot started, a rescan that gave the item a new id)
      // had its work reset, and was made and posted to the group again.
      alreadySent = this._postedBefore(ctx, jobKey, record, work);
      const copies = [hit, ...(hit.alternates ?? [])];
      let resumed = null;                     // the library copy its work came from
      if (!alreadySent && work.has()) {
        const it = work.manifest.item;
        const copy = copies.find((c) => itemIdOf(c) != null && itemIdOf(c) === String(it.id)) ?? null;
        const local = copy?.access === 'local';
        // A download is checked once per process: a retry in this one builds
        // on what this one made or checked, as it always did. After a
        // restart the library is asked - and a library that does not answer
        // is a transient failure, which waits with the files
        // (media/work-files.js). A file read in place is looked at every
        // time, a retry's too: one stat, no network, and it can be replaced
        // under the same name at any moment (media/segmented.js sourceGuard).
        // A page yt-dlp downloaded from (media/yt-dlp.js) is the same page:
        // its work is found by a hash of the very link, and a video page has
        // no length or date to ask about the way a file has. Asked anyway,
        // as a file, it never says how long it is, and every yt-dlp download
        // finished before a restart would be thrown away and fetched again.
        const verdict = !copy
          ? { ok: false, why: 'the library no longer lists the copy it came from' }
          : copy.ytdlp ? (it.ytdlp ? { ok: true } : { ok: false, why: 'it was not downloaded through yt-dlp' })
          : !local && !copy.downloadUrl ? { ok: false, why: 'the library can neither read nor download the copy it came from' }
            : work.vouched() && !local ? { ok: true } : await verifyIdentity(work.manifest, copyNow(copy), {
              probe: () => probeDownload(copy.downloadUrl, {
                headers: copy.downloadHeaders, signal: job.signal,
                // A public link is asked through the checked fetch, as it is downloaded.
                fetchImpl: copy.publicLink ? this._linkFetch(ctx) : null,
              }),
            });
        if (verdict.ok) {
          resumed = copy;
          work.vouch();
        } else {
          ctx.log.warn(`"${movie.title}": the library's file changed since it was ${it.access === 'local' ? 'read' : 'downloaded'} `
            + `(${verdict.why}) - ${it.access === 'local' ? 'converting it again' : 'fetching it again'}`);
          work.reset(verdict.why);
        }
      }
      // A film read in place goes on from the copy its work was made from,
      // never from whichever copy the library lists first now: pieces made
      // from one file and finished from another are two films spliced. When
      // that copy cannot be read here, and the film is to be read in place
      // all the same, its work is started again.
      if (resumed) {
        const readable = resumed.access === 'local' && readableHere(resumed.localPath);
        if ((resumed.access === 'local' && !readable) || (resumed !== hit && hit.access === 'local' && !readable)) {
          ctx.log.warn(`"${movie.title}": the copy its work came from cannot be read here - converting it again from the library's`);
          work.reset('the copy it came from cannot be read here');
          resumed = null;
        }
      }
      const inPlace = resumed ? (resumed.access === 'local' ? resumed : null) : (hit.access === 'local' ? hit : null);
      conv = alreadySent ? null : finishedOutput(work);
      if (!alreadySent && !conv && work.manifest.output) {
        ctx.log.warn(`the finished file kept for "${movie.title}" is gone or has changed - fetching and converting again`);
        work.record({ output: null });
      }
      if (alreadySent) {
        ctx.log.info(`"${movie.title}" was already posted to its group before the restart - not posting it twice`);
      } else if (conv) {
        ctx.log.info(`reusing ${outName} (${fmtBytes(conv.size)}), finished before the send was lost - `
          + 'sending it without fetching or converting again');
        // All it has left to write is the upload's copy - which a download
        // started meanwhile must not take (see _holdRoom).
        room = await this._holdRoom(ctx, { job, record, movie, workDir, mediaCfg, made: conv.size, jobKey, jobDir: work.dir });
      }

      /* --- get the bytes --- */
      const had = work.manifest.source;
      // Every piece of a segmented encode made before the restart: they are
      // only to be joined, and the source is not read again - an older build
      // deleted it once they were made (media/segmented.js).
      const joinOnly = !alreadySent && !conv && mediaCfg.segmentedEncode !== false && await segmentsReady(work, mediaCfg);
      if (alreadySent || conv) {
        // Made already; nothing to fetch.
      } else if (joinOnly) {
        ctx.log.info(`⚙ ${movie.title}: all its pieces were converted before the restart - joining them`);
      } else if (inPlace) {
        sourcePath = inPlace.localPath;
        if (!work.has()) {
          // What the library file is now, so that a restart can tell whether
          // what it converted is still that file (verifyIdentity).
          work.record({
            item: {
              provider: inPlace.provider ?? hit.provider ?? null, id: itemIdOf(inPlace), access: 'local', librarySize: inPlace.size ?? null,
              total: null, lastModified: null, etag: null, local: statOf(inPlace.localPath),
            },
          });
          work.vouch();
        }
        ctx.log.info(`using library file in place: ${sourcePath}`);
        await react(cfg.reactions.downloading);
        this._notify(ctx, 'downloading', `\u2b07\ufe0f ${film} \u2014 reading from the library`, record);
        job.progress({ stage: 'download', text: 'reading straight from the library — no transfer needed' }, 40);
      } else if (had?.state === 'complete' && fileSize(work.path(had.name)) === had.bytes) {
        // Downloaded whole before the restart, and still the library's file.
        downloaded = work.path(had.name);
        sourcePath = downloaded;
        ctx.log.info(`⬇ ${movie.title}: its ${fmtBytes(had.bytes)} download finished before the restart - `
          + 'converting it without fetching it again');
      } else {
        const ext = hit.container ? `.${hit.container}` : path.extname(hit.localPath ?? '') || '.mkv';

        // Only one download runs at a time (bandwidth), but another job may be
        // converting or uploading meanwhile. Wait for the slot, showing why.
        if (stageSems.download.free === 0) {
          job.progress({ stage: 'wait', text: waitReason(stageSems.download, 'download') }, 2);
        }
        await stageSems.download.acquire(STAGE_PRIORITY.movie, `${film}`, { key: job.id });
        let dlStart = Date.now();
        try {
          if (job.isCancelled()) throw Object.assign(new Error('cancelled'), { code: 'CANCELLED' });
          // Room for all of it - the download, the converted file and its
          // upload copy - before a byte is written, waiting (with the slot)
          // for the jobs ahead to free some when there is not enough. What
          // its work holds already is counted as its own.
          room = await this._holdRoom(ctx, {
            job, record, movie, workDir, mediaCfg, sourceBytes: hit.size, download: true, jobKey, jobDir: work.dir,
          });
          dlStart = Date.now();
          await react(cfg.reactions.downloading);
          this._notify(ctx, 'downloading', `\u2b07\ufe0f ${film} \u2014 downloading`, record);
          const partial = work.partPath && work.manifest.source?.state === 'partial' ? fileSize(work.partPath) : null;
          ctx.log.info(`⬇ download START  ${movie.title}${hit.size ? ` — ${fmtBytes(hit.size)}` : ''} from ${hit.provider}`
            + `${partial ? ` - going on from the ${fmtBytes(partial)} it had before` : ''}`);
          // A library can list the same film twice, and one entry's file may be
          // gone from disk - that download 404s while a working copy sits right
          // there. Try each copy in turn rather than failing the request. The
          // copy its work came from goes first, whatever the library lists
          // first now: that is the one it can go on with.
          const dlCopies = [hit, ...(hit.alternates ?? []).filter((a) => a.downloadUrl)];
          const order = resumed && dlCopies.includes(resumed) ? [resumed, ...dlCopies.filter((c) => c !== resumed)] : dlCopies;
          let dlErr = null;
          for (let ci = 0; ci < order.length; ci++) {
            const copy = order[ci];
            // Another copy's work is nothing this one can go on with.
            if (work.has() && String(work.manifest.item.id) !== itemIdOf(copy)) work.reset('another copy of the film');
            const name = work.manifest.source?.name ?? `source${ext}`;
            const dest = work.path(name);
            // A download this copy's work began goes on from the byte it
            // reached - as long as the library's file is still the one it
            // began (If-Range: downloadToFile).
            const had = work.manifest;
            const goOn = had.source?.state === 'partial' && had.item
              ? { total: had.item.total, lastModified: had.item.lastModified, etag: had.item.etag } : null;
            try {
              if (ci > 0) {
                ctx.log.warn(`retrying with another copy of ${movie.title} (${ci + 1}/${order.length})` +
                  `${copy.localPath ? ` — ${copy.localPath}` : ''}`);
              }
              // A video page goes through yt-dlp, into the same work directory
              // and down the same road from here (_ytdlpFetch).
              const got = copy.ytdlp ? await this._ytdlpFetch(ctx, { copy, work, job }) : await downloadToFile(copy.downloadUrl, dest, {
                headers: copy.downloadHeaders,
                signal: job.signal,
                resume: goOn,
                // A public link: public addresses only on every hop, and the
                // size capped while it streams (media/public-link.js).
                fetchImpl: copy.publicLink ? this._linkFetch(ctx) : null,
                // Which library file this is, recorded before a byte of it is
                // written: what a restart checks before going on with it.
                onResponse: ({ total, lastModified, etag }) => {
                  work.record({
                    item: {
                      provider: copy.provider ?? hit.provider ?? null, id: itemIdOf(copy), access: 'download',
                      librarySize: copy.size ?? null, total, lastModified, etag, local: null,
                    },
                    source: { name, state: 'partial', bytes: total },
                  });
                  work.vouch();
                },
                // Download occupies the first 40% of the overall bar.
                onProgress: (pct, info) => job.progress(
                  { ...info, stage: 'download' },
                  pct == null ? null : Math.floor(pct * 0.4),
                ),
              });
              // yt-dlp names its file for the streams it merged (mp4 or mkv).
              downloaded = got?.path ?? dest;
              // What this attempt fetched: a download that went on from a
              // partial kept from before fetched only the rest.
              resumedFrom = got?.from ?? 0;
              fetched = Math.max(0, (got?.size ?? 0) - resumedFrom);
              dlErr = null;
              break;
            } catch (err) {
              dlErr = err;
              // A cancellation is not a broken copy - stop immediately.
              if (err.code === 'CANCELLED' || job.isCancelled()) throw err;
              // Only a missing/gone file is worth trying another copy for;
              // a network failure would fail identically on every copy.
              if (!/HTTP 4(0[34]|10)/.test(err.message ?? '')) throw err;
              ctx.log.warn(`copy ${ci + 1} of ${movie.title} is missing on the server: ${err.message}`);
              work.reset(`copy ${ci + 1} is missing on the server`);
            }
          }
          if (dlErr) throw dlErr;
        } finally {
          stageSems.download.release(`${film}`);
        }
        sourcePath = downloaded;
        downloadSec = Math.round((Date.now() - dlStart) / 1000);

        // A bare ENOENT here says nothing about WHY: the download reported
        // success, so either it never wrote, or something removed the file
        // underneath us. Report which, with what is actually in the directory,
        // rather than leaving a stat trace to interpret later.
        if (!fs.existsSync(downloaded)) {
          let siblings = [];
          try { siblings = fs.readdirSync(work.dir).slice(0, 10); } catch { /* unreadable */ }
          const err = new Error(
            `the download reported success but ${path.basename(downloaded)} is not on disk `
            + `(its work dir holds ${siblings.length ? siblings.join(', ') : 'nothing'})`);
          err.code = 'SOURCE_VANISHED';
          throw err;
        }
        const dlBytes = fs.statSync(downloaded).size;
        if (dlBytes === 0) {
          const err = new Error(`the download produced an empty file (${path.basename(downloaded)})`);
          err.code = 'SOURCE_VANISHED';
          throw err;
        }
        // Whole: a restart from here converts it without fetching it again.
        work.record({ source: { name: path.basename(downloaded), state: 'complete', bytes: dlBytes } });
        // The rate is of what this attempt fetched. Taken over the whole
        // file, a download that went on from 2.3 of its 2.62 GB showed some
        // 87 MB/s for what was about 11.
        const rate = downloadSec > 0 && fetched > 0 ? `${fmtBytes(fetched / downloadSec)}/s` : null;
        ctx.log.info(resumedFrom > 0
          ? `⬇ download DONE   ${movie.title} — ${fmtBytes(dlBytes)}, the last ${fmtBytes(fetched)} of it in `
            + `${fmtDuration(downloadSec)}${rate ? ` (${rate})` : ''}`
          : `⬇ download DONE   ${movie.title} — ${fmtBytes(dlBytes)} in ${fmtDuration(downloadSec)}${rate ? ` (${rate} avg)` : ''}`);
      }

      if (job.isCancelled()) throw Object.assign(new Error('cancelled'), { code: 'CANCELLED' });

      /* --- make it sendable --- */
      if (!conv && !alreadySent) {
        // A film read in place has downloaded nothing, but its converted file
        // and upload copy still need room - and so does one whose download
        // was done before a restart. Asked before the convert slot is taken:
        // jobs holding room may be waiting for that slot, and they are what
        // frees it.
        room ??= await this._holdRoom(ctx, {
          job, record, movie, workDir, mediaCfg, jobKey, jobDir: work.dir,
          sourceBytes: downloaded ? fileSize(downloaded) : 0, download: !!downloaded,
        });
        if (stageSems.convert.free === 0) {
          job.progress({ stage: 'wait', text: 'waiting to convert — another file is encoding' }, 40);
        }
        await stageSems.convert.acquire(STAGE_PRIORITY.movie, null, { key: job.id });
        const convStarted = Date.now();
        const clock = conversionClock();
        try {
          if (job.isCancelled()) throw Object.assign(new Error('cancelled'), { code: 'CANCELLED' });
          job.progress({ stage: 'convert', text: 'inspecting the file' }, 40);
          await react(cfg.reactions.converting);
          this._notify(ctx, 'converting', `\u2699\ufe0f ${film} \u2014 converting`, record);
          ctx.log.info(`⚙ convert  START  ${movie.title} — target under ${fmtBytes(mediaCfg.maxOutputBytes)}`);
          conv = await convertForWhatsApp(sourcePath, work.outPath, mediaCfg, {
            signal: job.signal,
            work,
            // Conversion occupies 40-90% of the bar. The time left is of
            // what is left (ffmpeg.js conversionClock): a film resumed from
            // its eighth piece of ten has two to make, not a fifth of one.
            onProgress: (pct, detail, extra) => {
              const { elapsed, eta } = clock(pct, extra);
              job.progress({
                stage: 'convert',
                text: `${detail}${eta != null ? ` · ${fmtDuration(eta)} left` : ''}`,
                etaSec: eta,
                elapsedSec: elapsed,
              }, 40 + Math.floor(pct * 0.5));
            },
          });
        } finally {
          stageSems.convert.release();
        }
        convertSec = Math.round((Date.now() - convStarted) / 1000);
        // Made: a restart from here sends it as it is.
        work.record({ output: { name: path.basename(conv.outPath), size: conv.size, action: conv.action, segmented: !!conv.segmented } });
        ctx.log.info(
          `⚙ convert  DONE   ${movie.title} — ${conv.action}${conv.encoder ? ` (${conv.encoder})` : ''}` +
          `${conv.gpuFallback ? ` after a GPU ${conv.gpuFallback.reason}` : ''}, ${fmtBytes(conv.size)} ` +
          `in ${fmtDuration(convertSec)}` +
          `${conv.info?.size ? ` (from ${fmtBytes(conv.info.size)})` : ''}`,
        );
        // The download stays, with everything else in the job's directory,
        // until WhatsApp has taken the film. It used to be deleted here, the
        // moment the file was made; the operator, 2026-09-30, after a restart
        // had deleted three fully converted films (La La Land's upload was
        // running, and it started again from the download): "in the future
        // files should remain in their folders until fully sent on whatsapp
        // to avoid this". The directory goes once it is posted (_journalDone).
        room?.made(conv.size);
      }

      if (job.isCancelled()) throw Object.assign(new Error('cancelled'), { code: 'CANCELLED' });

      /* --- send it --- */
      let postsGroup;
      let uploadSec = 0;
      if (alreadySent) {
        postsGroup = this._postsGroupFor(ctx, record);
      } else {
        // Baileys gives no upload callback, so report elapsed time against the
        // known size rather than leaving the panel frozen at 92% for minutes.
        if (stageSems.upload.free === 0) {
          job.progress({ stage: 'wait', text: 'waiting to send — another upload is in progress' }, 92);
        }
        await stageSems.upload.acquire(STAGE_PRIORITY.movie, null, { key: job.id });
        try { postsGroup = this._postsGroupFor(ctx, record); }
        catch (err) { stageSems.upload.release(); throw err; }
        const upStarted = Date.now();
        const postsName = ctx.bot.groups().find((g) => g.jid === postsGroup)?.subject ?? postsGroup;
        await react(cfg.reactions.sending);
        this._notify(ctx, 'sending', `\u2b06\ufe0f ${film} \u2014 sending to the group`, record);
        ctx.log.info(
          `⬆ upload   START  ${outName} — ${fmtBytes(conv.size)} as a document to "${postsName}"`,
        );
        const upTicker = setInterval(() => {
          const elapsed = Math.round((Date.now() - upStarted) / 1000);
          job.progress({
            stage: 'upload',
            text: `uploading ${fmtBytes(conv.size)} to WhatsApp · ${fmtDuration(elapsed)} elapsed`,
            elapsedSec: elapsed,
            totalBytes: conv.size,
          }, 92);
        }, 2000);
        upTicker.unref?.();

        try {
          await ctx.bot.sendDocument(postsGroup, conv.outPath, {
            fileName: outName,
            mimetype: 'video/mp4',
          });
        } finally {
          clearInterval(upTicker);
          stageSems.upload.release();
        }
        // Posted: a restart from here on must not post it a second time. Said
        // in its work and on its journal entry, either of which is enough
        // (_postedBefore).
        const sent = { to: [...(work.manifest.sent?.to ?? []), postsGroup], at: Date.now() };
        work.record({ sent });
        if (jobKey) this._journalUpdate(ctx, jobKey, { sent });
        uploadSec = Math.round((Date.now() - upStarted) / 1000);
        ctx.log.info(
          `⬆ upload   DONE   ${outName} — ${fmtBytes(conv.size)} delivered to "${postsName}" ` +
          `in ${fmtDuration(uploadSec)}` +
          `${uploadSec > 0 ? ` (${fmtBytes(conv.size / uploadSec)}/s)` : ''}`,
        );
      }
      // What was sent: this attempt's file, or the one posted before a restart.
      const made = conv ?? { size: work.manifest.output?.size ?? 0, action: work.manifest.output?.action ?? 'sent' };

      job.progress({ stage: 'done', text: `sent ${outName} (${fmtBytes(made.size)})` }, 100);
      const totalSec = Math.round((Date.now() - jobStarted) / 1000);

      // A transfer record, kept separately from the request history so the
      // Transfers view can show real throughput figures after the fact. Not
      // for a film posted before a restart: its transfer is not this one's.
      if (!alreadySent) {
        ctx.store.push('transfers', {
          at: Date.now(),
          title: movie.title,
          year: movie.year,
          file: outName,
          bytes: made.size,
          sourceBytes: hit.size ?? null,
          action: made.action,
          access: hit.access,
          downloadSec,
          convertSec,
          uploadSec,
          totalSec,
          // Of the bytes this attempt fetched, not the whole file's.
          avgBytesPerSec: downloadSec > 0 && fetched > 0 ? Math.round(fetched / downloadSec) : null,
          ...(resumedFrom > 0 ? { resumedFromBytes: resumedFrom } : {}),
          requester: record.requester,
          requesterNumber: phoneOut(record.requesterNumberDisplay ?? record.requesterNumber ?? null),
          ...(isBeta ? { beta: true } : {}),
        }, 60);
      }
      record.status = 'sent';
      record.detail = `${made.action}, ${fmtBytes(made.size)}`;
      record.startedAt = jobStarted;
      record.finishedAt = Date.now();
      record.timings = {
        queueWaitSec: record.enqueuedAt ? Math.max(0, Math.round((jobStarted - record.enqueuedAt) / 1000)) : null,
        downloadSec, convertSec, uploadSec, totalSec,
        action: made.action,
        endToEndSec: record.requestedAt ? Math.round((Date.now() - record.requestedAt) / 1000) : null,
        receiveLatencySec: record.requestedAt ? Math.max(0, Math.round((record.at - record.requestedAt) / 1000)) : null,
      };
      this.upsertHistory(ctx, record);
      ctx.log.info(`✅ COMPLETE ${movie.title} — ${fmtBytes(made.size)} in ${fmtDuration(totalSec)} total`);
      await react(cfg.reactions.done);
      this._notify(ctx, 'done', `\u2705 ${film} \u2014 posted! Check {group}`, record,
        { tagGroup: postsGroup });

      this._retries?.forget(jobKey);
      this._tellFollowers(ctx, this._takeFollowers(ctx, jobKey), { status: 'sent', emoji: cfg.reactions.done });
      // Out of the journal, on the disk, and then its work goes (_journalDone)
      // - freeing the disk at once, a feature film being gigabytes. Only the
      // job's own directory goes, through the guard: never the library
      // original, which a film read in place may share an inode with. An
      // operator who keeps local copies keeps it (the hourly sweep clears it
      // six hours on).
      const freed = this._journalDone(ctx, jobKey, { work, drop: !!mediaCfg.deleteAfterSend });
      if (freed) ctx.log.info(`cleaned up ${fmtBytes(freed)} of working files`);
      return { file: outName, size: made.size, action: made.action };
    } catch (err) {
      if (busyElsewhere) {
        // The same film for the same request is running in this process
        // already. Two runs would write the same files and post it twice;
        // this one stops, and leaves the journal and History to the other.
        ctx.log.warn(`not running "${movie.title}" twice: ${err.message}`);
        return { skipped: true };
      }
      // Transient failures keep their journal entry and are tried again in
      // this process once WhatsApp is back (_retryLater), up to MAX_RETRIES
      // times; after that the entry waits for the next start, which is all
      // that used to happen. Anything else is terminal - drop it, or a
      // permanently broken job would be replayed on every restart forever.
      // The strings that count as transient are in media/resume.js.
      //
      // A job the failover took off a dying connection ('interrupted', see
      // failover.js _requeueInterrupted) is transient too: that is a lost
      // socket, not an admin. An admin's cancel is final whatever error it
      // surfaced as - an upload cannot be aborted, so a job cancelled mid-send
      // can still fail with "Connection Closed", and a retry would bring back
      // a film an admin took out.
      const interrupted = job.cancelReason?.() === 'interrupted';
      const cancelled = !interrupted && (err.code === 'CANCELLED' || !!job.isCancelled?.());
      // A full disk is not the film's fault either, and it passes: the jobs
      // ahead finish and free their files. "Charlie and the Chocolate
      // Factory" (ffmpeg exited 228), "The Parent Trap" (ENOSPC) and
      // "Minority Report" (an upload copy cut short) were failed for good on
      // 2026-09-28 20:34-21:07 UTC; they wait for room now, and try again.
      const diskFull = !cancelled && isDiskFull(err);
      // DISK_WAIT and DISK_HELD are our own refusals while other work, kept
      // until it is sent, holds the room: the disk has not filled (see
      // disk-space.js notEnoughRoom).
      if (diskFull && err.code !== 'DISK_WAIT' && err.code !== 'DISK_HELD') noteDiskFull();
      // Not started for want of room that other films' work holds: the
      // operator hears of it (an error line, which the hourly check reports
      // as the disk filling up - incident-scan.js DISK_FULL), since only a
      // send or a person frees that room now that nothing is deleted for it.
      if (err.code === 'DISK_HELD') ctx.log.error(`${movie.title}: ${err.message}`);
      const transient = interrupted || isTransient(err) || diskFull;
      if (transient && !cancelled) {
        // What it has done is kept - the download as far as it got, the
        // pieces of an encode, the finished film - so the retry, or the next
        // start, goes on from there instead of downloading and encoding it
        // all over again (media/work-files.js). Whatever the disk has free:
        // it used to be reset when the disk was nearly full, and nothing is
        // deleted before the film is sent now (see where it is made, above). It
        // goes after a success, a cancel, or a failure for good.
        room?.release();
        const made = conv && fs.existsSync(conv.outPath) ? conv : null;
        const keptWork = work.owned && work.has();
        const need = (o = {}) => jobNeed({
          workDir, kind: 'movie', sourceBytes: hit.size, download: hit.access !== 'local',
          maxOutputBytes: mediaCfg.maxOutputBytes, made: keptWork && made ? made.size : null, ...shape, ...o,
        });
        // After a full disk, the attempt waits until the whole of it fits -
        // or only what it still has to write, when its work is kept - or
        // until nothing running is left to free more; then it runs, and a
        // film that still cannot fit is refused with the numbers
        // (disk-space.js).
        //
        // A film with nothing kept waits, too, for the work other retries
        // kept to finish (waitOnKept), and for any other work on the disk to
        // be sent (waitOnHeld): they free their room then. One with work of
        // its own waits only on the running jobs, so two retries can never
        // wait on each other (disk-space.js `kept`).
        const until = diskFull
          ? (signal) => waitForRoom({
            dir: workDir, key: jobKey, label: movie.title, signal, log: ctx.log, unref: true,
            waitOnKept: !keptWork, waitOnHeld: !keptWork, keptKey: jobKey, jobDir: work.dir,
            need: need({ onDisk: work.bytes() }),
          })
          : null;
        const attempt = this._retryLater(ctx, jobKey, err, { until });
        if (attempt && keptWork) {
          // Room that comes back once the retry has finished with it, which a
          // job asked for meanwhile must not be refused for (disk-space.js).
          keepRoom(jobKey, { dir: workDir, jobDir: work.dir, peak: need().peak, made: made ? made.size : null, label: movie.title });
        } else if (!attempt) {
          // Waiting for the next start, which goes on from its work: parked,
          // with no room held for it here (_park).
          this._park(ctx, jobKey);
        }
        if (attempt) {
          // The line's shape is what the hourly check reads (incident-scan.js
          // TRANSIENT): "retrying once WhatsApp is connected" tells it this
          // process is bringing the film back, and a restart would only
          // throw away the jobs whose files are about to free the room.
          ctx.log.warn(`"${movie.title}" failed transiently (${err.message}) - retrying once WhatsApp is connected `
            + `${diskFull ? 'and there is room on the disk ' : ''}`
            + `(attempt ${attempt} of ${MAX_RETRIES})`
            + `${keptWork && made ? `, sending the finished ${fmtBytes(made.size)} file as it is`
              : keptWork ? ', going on from what it had done' : ''}`);
          record.detail = diskFull
            ? `waiting for disk space — ${err.message} (attempt ${attempt} of ${MAX_RETRIES})`
            : `${err.message} — retrying (attempt ${attempt} of ${MAX_RETRIES})`;
        } else {
          // The line's shape is the hourly check's too (incident-scan.js
          // TRANSIENT): a restart for it is what it asks for.
          ctx.log.warn(`"${movie.title}" failed transiently (${err.message}) - retried ${MAX_RETRIES} times in this `
            + `process; will retry on next start${keptWork ? ', going on from what it had done' : ''}`);
          record.detail = `${err.message} — retried ${MAX_RETRIES} times; will retry on the next start`;
        }
        record.status = 'interrupted';
        this.upsertHistory(ctx, record);
        // Distinct from the failure emoji: this one is coming back. It shows
        // the stage its kept work has reached - where the retry goes on from,
        // and mostly what the message shows already, which _reactFor does
        // not send again - or 🎬 with nothing done. It was 🔄, which asks
        // the member for nothing and was read as "send it again" (Iron Man 3,
        // 2026-10-11, media/stage-reaction.js).
        await react(stageReaction(cfg.reactions, { work }));
        throw err;
      }

      this._retries?.forget(jobKey);
      const followers = this._takeFollowers(ctx, jobKey);
      // Finished with: nothing will resume from its work.
      this._journalRemove(ctx, jobKey, { keepWork: true });
      if (work.owned) work.drop();
      if (cancelled) {
        const skipped = job.cancelReason?.() === 'skipped';
        record.status = skipped ? 'skipped' : 'cancelled';
        record.detail = skipped ? 'skipped by admin' : 'cancelled';
        this.upsertHistory(ctx, record);
        if (skipped) {
          // Let the requester know it was set aside on purpose, not lost.
          await react(cfg.reactions.skipped ?? cfg.reactions.failed);
          this._tellFollowers(ctx, followers, { status: 'skipped', emoji: cfg.reactions.skipped ?? cfg.reactions.failed });
          ctx.log.warn(`⏭ SKIPPED ${movie.title} — moving to the next job`);
          this._notify(ctx, 'blocked', `${cfg.reactions.skipped ?? '⏭️'} ${film} — set aside by an admin`, record);
        } else {
          // A cancelled job used to leave the requester's message stuck on
          // whatever reaction it had (⬇️/⚙️) forever. Mark it clearly instead.
          await react(cfg.reactions.cancelled ?? cfg.reactions.failed);
          this._tellFollowers(ctx, followers, { status: 'cancelled', emoji: cfg.reactions.cancelled ?? cfg.reactions.failed });
          this._freeMemberHour(ctx, record);
          ctx.log.warn(`❌ CANCELLED ${movie.title} — cancelled by an admin`);
          this._notify(ctx, 'blocked', `${cfg.reactions.cancelled ?? '❌'} ${film} — cancelled by an admin`, record);
        }
        return;
      }
      record.status = 'failed';
      record.detail = err.message;
      this.upsertHistory(ctx, record);
      ctx.log.error(`delivery failed for ${movie.title}: ${err.message}`);
      await react(cfg.reactions.failed);
      this._tellFollowers(ctx, followers, { status: 'failed', why: err.message, emoji: cfg.reactions.failed });
      throw err;
    } finally {
      room?.release();
      work.release();
    }
  },

  /**
   * Hold room on the disk for this film before it writes anything, waiting
   * for the jobs ahead to free some when there is not enough
   * (media/disk-space.js reserveRoom). While it waits, the queue's panel
   * shows why, and so does its History row. A film that cannot fit even with
   * nothing else running is refused with the numbers. What its work holds
   * already (`jobDir`) is its own, and counted as done.
   */
  async _holdRoom(ctx, {
    job, record, movie, workDir, mediaCfg, sourceBytes = 0, download = false, made = null, jobKey = null, jobDir = null,
  }) {
    let waited = false;
    const room = await reserveRoom({
      key: job.id, keptKey: jobKey, label: movie.title, workDir, kind: 'movie', sourceBytes, download, made,
      maxOutputBytes: mediaCfg.maxOutputBytes, jobDir, signal: job.signal, log: ctx.log,
      segmented: mediaCfg.segmentedEncode !== false,
      onWait: (r) => {
        const text = `waiting for disk space — it needs ${fmtBytes(r.need)}, ${fmtBytes(Math.max(0, r.available))} is free`;
        job.progress({ stage: 'wait', text }, made != null ? 92 : download ? 2 : 40);
        record.detail = text;
        this.upsertHistory(ctx, record);
        waited = true;
      },
    });
    if (waited) {
      record.detail = null;
      this.upsertHistory(ctx, record);
    }
    return room;
  },

  /* ================= "Which one?" lists (pick-list.js; beta001 until 2026-10-11) ================= */

  /**
   * Put OMDb's shortened plot on each film of a list about to be posted. A
   * film OMDb has nothing for, or that it was too slow to answer about, is
   * listed without one; nothing here can stop the list being sent.
   */
  async _attachPlots(ctx, items) {
    try {
      const plots = await listPlots(items, { apiKey: ctx.config.omdb?.apiKey });
      plots.forEach((p, i) => { if (p) items[i].plot = p; });
      const got = plots.filter(Boolean).length;
      if (got < items.length) {
        ctx.log.info(`pick list: a plot for ${got} of ${items.length} film(s); OMDb had none, or was too slow, for the rest`);
      }
    } catch (err) {
      ctx.log.warn(`pick list: listed without plots - ${err.message}`);
    }
  },
  //
  // The pure parts - what is listable, how a list reads, what counts as an
  // answer - are in pick-list.js. What lives here is the state: the journal
  // of lists (the store's `pickLists`, which survives a restart), their
  // timers, and the hand-off of a pick to the ordinary pipeline.
  //
  // The journal, not memory, is the record of what is open. Every message
  // that could answer a list is checked against it, and a claim is made in
  // one synchronous read-modify-write, so two digits arriving together
  // (messages are dispatched without waiting for the previous one) cannot
  // both win.
  //
  // A list moves through these states, each one journalled:
  //   open      waiting for its owner's number; its expiry timer is armed
  //   picked    a number was taken and the request is running
  //   answered  the request settled; kept until the list would have expired,
  //             only so that the owner's stray extra numbers are swallowed
  //   expiring  ran out; History says so, the final reaction is still owed
  // A pick the bot turns down goes from 'picked' back to 'open' while there
  // is time and another version left (_pickReopen). Everything but
  // 'answered' is kept until it is dealt with, because those are exactly the
  // states a restart has to finish - and there were five on 2026-09-22.

  _pickJournal(ctx) {
    const v = ctx.store.get('pickLists', []);
    return Array.isArray(v) ? v : [];
  },

  _pickSave(ctx, lists) {
    const now = Date.now();
    ctx.store.set('pickLists', lists.filter((l) => l.state !== 'answered' || l.expiresAt > now));
  },

  /** Merge `patch` into one journal entry. The updated entry, or null when it is gone. */
  _pickUpdate(ctx, id, patch) {
    let updated = null;
    const lists = this._pickJournal(ctx).map((l) => {
      if (l.id !== id) return l;
      updated = { ...l, ...patch };
      return updated;
    });
    if (updated) this._pickSave(ctx, lists);
    return updated;
  },

  _pickRemove(ctx, id) {
    this._pickSave(ctx, this._pickJournal(ctx).filter((l) => l.id !== id));
  },

  /**
   * One timer per list. It always calls _expirePickList, which runs out an
   * open list and retries the final reaction of an expiring one - so the
   * same timer serves both, and a list can never have two.
   */
  _pickArm(ctx, list, delayMs = list.expiresAt - Date.now()) {
    this._pickTimers ??= new Map();
    this._pickDisarm(list.id);
    const t = setTimeout(() => {
      this._pickTimers.delete(list.id);
      this._expirePickList(ctx, list.id)
        .catch((err) => ctx.log.warn(`pick list expiry failed: ${err.message}`));
    }, Math.max(0, delayMs));
    t.unref?.();
    this._pickTimers.set(list.id, t);
  },

  _pickDisarm(id) {
    const t = this._pickTimers?.get(id);
    if (t) { clearTimeout(t); this._pickTimers.delete(id); }
  },

  /**
   * Where a new list may be posted: the group the request came from, or
   * nowhere.
   *
   * A main request's list goes back where it was asked, in every group:
   * the list is no longer a beta flag (see step 0 of _runRequest). A test's
   * goes only where its route still says it may speak, asked again right
   * before sending, because the library search before it can take a minute
   * and the operator can make the beta group a main one in that time - and
   * a test is never posted in a main group (safeRoute).
   */
  _pickTarget(ctx, chatJid, route) {
    if (route?.beta) return safeRoute(ctx.config, route)?.notifyGroup === chatJid ? chatJid : null;
    return chatJid;
  },

  /**
   * May a list still act - take a pick, swallow a number, react, edit itself?
   *
   * Always, unless it was a test's and the group it was asked in has since
   * become a main group: it then says nothing more there, every message is
   * handled as if it were not open, and an expiry is recorded in History
   * without a word in the group. Decided from the route the list was given,
   * like everything else about a request after intake.
   *
   * There was a kill switch here as well - the beta feature's mode, read
   * live, so that Off stopped lists already in the journal. The list left
   * beta on 2026-10-11, and a list journalled under any mode is answered as
   * it was promised.
   */
  _pickLive(ctx, list) {
    if (list.route?.beta) return !safeRoute(ctx.config, list.route)?.originIsMain;
    return true;
  },

  /** A list's History row as it ends without a pick. */
  _pickClosedRecord(list, { outcome, status, detail }) {
    return {
      ...list.record,
      status,
      detail,
      pickList: { ...list.record.pickList, outcome, closedAt: Date.now() },
    };
  },

  /**
   * Called for a request with no year, while the year question is asked at
   * all (requireYearWhenAmbiguous). Searches the library once and decides
   * (the rules are decidePickList's):
   *
   *   2..maxOptions sendable films    -> post the list                  { answered }
   *   more than that                  -> "add a word or the year", as a
   *                                      quoted reply where the list
   *                                      would have gone                { answered }
   *   the group is full of open lists, or the list could not be sent
   *                                   -> "add a year", now              { answered }
   *   one sendable film to go ahead with                                { only }
   *   anything else                   -> null: carry on exactly as before
   */
  async _offerPickList(msg, text, ctx, { record, route, finish, maybeReply }) {
    const cfg = ctx.config.movieRequests;
    const settings = pickListSettings(cfg);
    // The search and the decision are step-zero.js's, which the panel's dry
    // run calls too, so the Test tab answers as a request does.
    let zero;
    try {
      zero = await stepZero(text, ctx.config, {
        store: ctx.store,
        onTokenRefreshed: (auth) => ctx.configStore.update({
          library: { jellyfin: {
            accessToken: auth.accessToken,
            userId: auth.userId ?? '',
            userName: auth.userName ?? '',
          } },
        }),
      });
    } catch (err) {
      ctx.log.warn(`pick list: could not search the library for "${pickTerms(text).searchTerm}" (${err.message}) - carrying on without one`);
      return null;
    }
    // Not Jellyfin: nothing reports the ratings a list is vetted on.
    if (!zero) return null;
    const { decision, query } = zero;
    if (zero.widened) ctx.log.info(`pick list: nothing starts with "${zero.typed}"; asking about "${zero.searchTerm}" instead`);
    const { items, versions } = decision;
    // Set when only the films called exactly that are listed, although more
    // titles start with the words; the list says so, and so does the edit
    // when a refused pick reopens it.
    const moreStartWith = decision.moreStartWith ?? 0;
    const held = (oneTitle(versions) ? versions.map((v) => v.year ?? '?')
      : versions.map((v) => `${v.title} (${v.year ?? '?'})`)).join(', ');
    const labels = offeredLabels(items);
    // Logged whatever the outcome. The Harry Potter request that started the
    // franchise lists left no line at all here, because "no versions" was a
    // silent return, and the log could not say what step 0 had seen.
    ctx.log.info(`pick list: "${query}" matches ${versions.length} film(s) on the server`
      + `${versions.length ? ` (${held})` : ''}; sendable: ${labels.join(', ') || 'none'} -> ${decision.kind}, ${decision.why}`);
    // The same, in a beta group's transcript: a list that came back empty,
    // or with nothing sendable, is invisible in the group - the request just
    // goes on - and is exactly what the hourly check looks for there
    // ("john wick", 2026-09-30: four films held, none listed).
    ctx.bot.transcript?.note?.(msg.chatJid, {
      ref: msg.id, note: `pick list: ${decision.kind}, ${decision.why}`, event: 'pick-decision',
      query, decision: decision.kind, why: decision.why, held: versions.length, heldTitles: held || null, sendable: labels.length,
    });
    // Nothing we could send: the request is answered exactly as it always
    // was, which is the refusal it would get anyway.
    if (decision.kind === 'none') return null;
    if (decision.kind === 'only') return { only: decision.item };

    const same = oneTitle(items);
    const years = items.map((v) => v.year);
    // What History and the journal call the list: the one title of a set of
    // remakes, as before, or for a franchise the words the member typed.
    const title = same ? items[items.length - 1].title : query;
    // In a test, every line the bot suggests sending carries the test's code,
    // or the beta group would ignore the tester for doing as they were told.
    const prefix = suggestPrefix(route, requestPrefix(cfg));
    const narrowText = (atLeast = false) => narrowDownText(query, items, { prefix, atLeast });

    // For when a list cannot be shown. Remakes of one title get exactly the
    // answer they always got; a franchise is not a question of which year
    // ("There is more than one "harry potter" ... Which year?"), so it gets
    // the "add a word or the year" words instead, in the same places.
    const askForYear = async (why) => {
      ctx.log.info(`pick list: ${why} - asking for a year instead`);
      if (same) {
        await maybeReply(`There is more than one "${title}" on the server (${years.join(', ')}). Which year?`);
        await finish('need-year', `${versions.length} copies: ${held} - ${why}`, cfg.reactions.needYear,
          { note: needYearNote(title, years, prefix) });
      } else {
        const body = narrowText();
        await maybeReply(body);
        await finish('need-year', `${items.length} films start with "${query}" - ${why}`, cfg.reactions.needYear,
          { note: `📅 ${body}` });
      }
      return { answered: true };
    };

    if (decision.kind === 'narrow') return this._narrowDown(msg, ctx, {
      record, route, finish, askForYear, title, why: decision.why, body: narrowText(decision.atLeast),
      count: items.length, atLeast: !!decision.atLeast,
    });

    const sender = { jid: msg.senderJid, number: msg.senderNumber ?? null };
    const now = Date.now();
    const busy = this._pickJournal(ctx).filter((l) => l.state === 'open' && l.expiresAt > now
      && l.chatJid === msg.chatJid && !sameSender(l.sender, sender)).length;
    if (busy >= settings.maxOpenPerGroup) return askForYear(`${busy} lists are already open in this group`);

    const where = this._pickTarget(ctx, msg.chatJid, route);
    if (!where) {
      ctx.log.warn(`pick list: not shown for "${query}" - ${msg.chatJid} has become a main group since this test `
        + 'was asked there, and a test is never posted in one');
      return null;
    }

    // A line of plot goes next to each film, from OMDb, as the operator
    // chose for beta001. Asked for only now, when the list is certain to be
    // posted, so every path that ends in a question or a refusal still spends
    // no OMDb quota. The plots go on the items, which are journalled with the
    // list, so the edits after a refused pick and a restart keep them.
    await this._attachPlots(ctx, items);

    // 'critical': the member is waiting for this answer to their request.
    let sent = null;
    try {
      sent = await ctx.bot.sendText(where,
        formatPickList(items, { minutes: settings.expiryMinutes, moreStartWith, test: isTestRoute(route), query }),
        { quoted: msg, kind: 'critical' });
    } catch (err) {
      ctx.log.warn(`pick list: could not send it: ${err.message}`);
    }
    if (!sent?.key?.id) return askForYear('the list could not be sent');

    const shownAt = Date.now();
    const expiresAt = shownAt + settings.expiryMinutes * 60_000;
    record.title = title;
    record.status = 'pick-list';
    record.detail = `asked which one: ${labels.join(', ')}`;
    record.pickList = {
      shownAt, expiresAt, offered: years, held: versions.length, invalid: 0, units: 1, outcome: null,
      ...(same ? {} : { titles: items.map((v) => v.title) }),
      ...(moreStartWith ? { moreStartWith } : {}),
    };
    const list = {
      id: msg.id,
      state: 'open',
      chatJid: msg.chatJid,
      listJid: where,
      listKey: JSON.parse(JSON.stringify(sent.key)),
      sender,
      // Enough of the request to run it again after a restart: its key is
      // what the reactions are sent against.
      msg: {
        id: msg.id, key: msg.key, chatJid: msg.chatJid, isGroup: true, fromMe: false,
        senderJid: msg.senderJid, senderNumber: msg.senderNumber ?? null,
        senderNumberDisplay: msg.senderNumberDisplay ?? null, pushName: msg.pushName ?? null,
        timestamp: msg.timestamp ?? null, messageType: msg.messageType ?? null, text: msg.text ?? '',
      },
      request: record.request,
      title,
      // The words the list's header quotes, kept so the edit after a refused
      // pick still shows them.
      query,
      items,
      // Kept so the edit after a refused pick still says other titles start
      // with the words; the list is rebuilt from this entry, not from the
      // search, which is long gone by then.
      ...(moreStartWith ? { moreStartWith } : {}),
      refused: [],
      shownAt,
      expiresAt,
      route: route ?? null,
      at: record.at,
      record: JSON.parse(JSON.stringify(record)),
    };

    // One open list per member: a newer bare-title request replaces theirs.
    // The replaced lists' History rows are written BEFORE the journal lets
    // go of them - once it has, those rows are the only record of how they
    // ended, and a restart in between would leave them showing an open list
    // for good.
    const lists = this._pickJournal(ctx);
    const replaced = lists.filter((l) => l.state === 'open' && sameSender(l.sender, sender)).map((old) => {
      this._pickDisarm(old.id);
      const rec = this._pickClosedRecord(old, {
        outcome: 'replaced', status: 'pick-replaced', detail: 'replaced by a newer request from the same member',
      });
      this.upsertHistory(ctx, rec);
      return { ...old, record: rec };
    });
    const gone = new Set(replaced.map((l) => l.id));
    this._pickSave(ctx, [...lists.filter((l) => !gone.has(l.id)), list]);
    this.upsertHistory(ctx, record);
    this._pickArm(ctx, list);
    ctx.log.info(`🔢 pick list shown for "${record.request}" in ${where}: `
      + `${labels.map((l, i) => `${i + 1}=${l}`).join(' ')} (held: ${held}); `
      + `expires in ${settings.expiryMinutes} min [1 message]`);

    for (let i = 0; i < replaced.length; i += 1) {
      // An edit per replaced list, in a loop, so it is paced like any other
      // bulk work (CLAUDE.md rule 1). A member normally has one open list,
      // but anyone the cooldown does not apply to can open several at once.
      if (i > 0) await ctx.bot._bulkPace?.();
      await this._closePickList(ctx, replaced[i], { edit: formatReplaced() });
    }
    return { answered: true };
  },

  /**
   * More films start with a bare title than a list can offer. One quoted
   * reply goes where the list would have gone, naming the count and an
   * example that narrows it ('22 films start with "batman" — add a word or
   * the year, e.g. #request Batman Begins'), and the request gets 📅.
   *
   * No OMDb call is made, and none is wanted: "batman" alone would be
   * resolved to whichever Batman OMDb ranks first, which is how "harry
   * potter" became the Deathly Hallows on 2026-09-22. The answer is given in
   * the request group rather than as the notifications-group line - that
   * line is what about half of the requesters never saw (see the top of
   * pick-list.js) - so the notifications group gets nothing this time.
   *
   * It queues nothing, so it does not start the member's cooldown (the
   * operator's rule of 2026-10-01, _cooldownGate): the follow-up the reply
   * asks for runs. It does count towards the flood backstop, as every answer
   * that queues nothing does - the reply costs the group a message, and
   * without a limit one member could make the bot post as often as they
   * liked (src/core/request-cooldown.js).
   */
  async _narrowDown(msg, ctx, { record, route, finish, askForYear, title, why, body, count, atLeast }) {
    const cfg = ctx.config.movieRequests;
    const where = this._pickTarget(ctx, msg.chatJid, route);
    if (!where) {
      ctx.log.warn(`pick list: no "add a word" reply for "${record.request}" - ${msg.chatJid} has become a main group `
        + 'since this test was asked there, and a test is never posted in one');
      return null;
    }
    // 'critical', like the list: the member is waiting for this answer.
    let sent = null;
    try {
      sent = await ctx.bot.sendText(where, body, { quoted: msg, kind: 'critical' });
    } catch (err) {
      ctx.log.warn(`pick list: could not send the "add a word" reply: ${err.message}`);
    }
    if (!sent) return askForYear('the "add a word" reply could not be sent');
    record.title = title;
    record.pickNarrow = { at: Date.now(), matches: count, ...(atLeast ? { atLeast: true } : {}), units: 1 };
    ctx.log.info(`🔢 "${record.request}": ${why} - asked in ${where} for another word or the year [1 message]`);
    await finish('need-year', `asked for another word or the year: ${why}`, cfg.reactions.needYear, { notify: false });
    return { answered: true };
  },

  /**
   * What, if anything, does this message mean to a list in its group?
   * Returns null when it has nothing to do with one - the message is then
   * handled exactly as it would be with no list open. Otherwise:
   *
   *   { list, index, form }   the owner's pick, already claimed
   *   { invalid: list }       the owner's number that is not on the list, or
   *                           one the bot has already turned down
   *   { ignore, list }        a number that must not be acted on, and must
   *                           not be moderated either: the owner's after
   *                           their pick was taken ('answered'), or someone
   *                           else answering a list that is not theirs
   *                           ('not-theirs')
   *
   * Only lists that are still live count (_pickLive), so once the beta
   * group a test's list was posted in has become a main one, every message
   * there is handled as it would be with no list open - including the
   * numbers swallowed here.
   *
   * A member's reaction (msg.reaction, from bot.js) is read as the number
   * its keycap stands for (keycapNumber), and only against the list it was
   * put on - a reaction is on one message, and that message must be one of a
   * list's own (listMessageIds). From there it is the typed number exactly:
   * first pick wins, a number not on the list or already turned down is
   * { invalid }, someone else's is { ignore }. Its form is 'reaction', which
   * the log and the History row keep. Any other emoji, or a reaction on any
   * other message, is null.
   */
  _claimPick(msg, ctx) {
    const lists = this._pickJournal(ctx);
    if (!lists.length) return null;
    let here = lists.filter((l) => l.chatJid === msg.chatJid && this._pickLive(ctx, l));
    if (!here.length) return null;
    let text = String(msg.text ?? '').trim();
    if (msg.reaction) {
      const n = keycapNumber(msg.reaction.emoji);
      const on = msg.reaction.targetId;
      if (n == null || !on) return null;
      here = here.filter((l) => listMessageIds(l).includes(on));
      if (!here.length) return null;
      text = String(n);
    }
    const now = Date.now();
    const prefix = requestPrefix(ctx.config.movieRequests);
    const sender = { jid: msg.senderJid, number: msg.senderNumber ?? null };
    const mine = here.filter((l) => sameSender(l.sender, sender));

    const open = mine.find((l) => l.state === 'open' && l.expiresAt > now);
    if (open) {
      const p = parsePick(text, open, prefix);
      if (!p) return null;
      if (p.invalid) return { invalid: open };
      if (open.refused?.includes(p.index)) return { invalid: open, refusedIndex: p.index };
      const form = msg.reaction ? 'reaction' : p.form;
      const claimed = { ...open, state: 'picked', pickedAt: now, pickedIndex: p.index, pickForm: form };
      this._pickSave(ctx, lists.map((l) => (l === open ? claimed : l)));
      this._pickDisarm(open.id);
      return { list: claimed, index: p.index, form };
    }

    // First pick wins. A second number from the same member - a double tap,
    // a changed mind, bare or as "#request 3" - is not a new request, and it
    // is not chatter either: the list asked for it.
    //
    // A pick held by the request pause stays 'picked' for as long as the
    // pause lasts, which can be well past the list's ten minutes: its owner
    // sending the number again then is still answering it. Without this the
    // number fell through to moderation and was deleted, or as "#request 2"
    // was held as a new request for a film called "2" (found in review,
    // 2026-10-01).
    const answered = mine.find((l) => (l.state === 'picked' || l.state === 'answered')
      && (l.expiresAt > now || (l.state === 'picked' && !!ctx.requestPause?.holds?.(this.name, l.id))));
    if (answered && answersList(text, answered, prefix)) return { ignore: 'answered', list: answered };

    // Someone else's list. Their number is not an answer to anything of
    // theirs, and it is left alone rather than deleted: a member who saw a
    // numbered list and answered it has done what the bot appeared to ask,
    // and the group rules count a deletion towards the two strikes.
    const theirs = here.find((l) => l.state === 'open' && l.expiresAt > now
      && !sameSender(l.sender, sender) && answersList(text, l, prefix));
    if (theirs) return { ignore: 'not-theirs', list: theirs };
    return null;
  },

  /** Act on a claim from _claimPick. */
  async _answerPick(claim, msg, ctx) {
    const who = formatPhone(msg.senderNumber) ?? msg.senderJid;
    if (claim.ignore) {
      const line = claim.ignore === 'answered'
        ? `ignoring ${pickSaid(msg)} from ${who}: their list for "${claim.list.request}" was already answered`
        : `ignoring ${pickSaid(msg)} from ${who}: it answers another member's list ("${claim.list.request}"), not theirs`;
      // Another member's reaction on a list is nobody's business but theirs:
      // people react to messages for all sorts of reasons, and a line for
      // each in the main log would bury the requests.
      if (msg.reaction && claim.ignore === 'not-theirs') ctx.log.debug?.(line);
      else ctx.log.info(line);
      return;
    }
    if (claim.invalid) return this._pickInvalid(claim.invalid, msg, ctx, claim.refusedIndex ?? null);

    const { list, index, form } = claim;
    const item = list.items[index];
    ctx.log.info(`🔢 ${who} picked ${index + 1} (${pickSaid(msg)}, ${form}) from `
      + `${offeredLabels(list.items).join('/')} for "${list.request}" -> ${item.title} (${item.year}), `
      + `${Math.round((list.pickedAt - list.shownAt) / 1000)}s after the list`);
    await this._pickUnquestion(ctx, list);
    return this._runPick(ctx, list, index, form);
  },

  /**
   * Run a pick through the ordinary pipeline, as if "#request <Title> <Year>"
   * had been sent - metadata with the year, rating gate, content check,
   * library, queue - but on the ORIGINAL request, so its reactions are where
   * the member is looking and the digit itself gets none.
   */
  async _runPick(ctx, list, index, form, { resumed = false } = {}) {
    // Which picks are being run now, so a restart's recovery does not run
    // one a second time while a held pick replayed at the same connect is
    // still being looked up (_resumePick).
    this._picksRunning ??= new Set();
    if (this._picksRunning.has(list.id)) return;
    this._picksRunning.add(list.id);
    try {
      await this._runPickNow(ctx, list, index, form, { resumed });
    } finally {
      this._picksRunning.delete(list.id);
    }
  },

  async _runPickNow(ctx, list, index, form, { resumed = false } = {}) {
    const item = list.items[index];
    const pick = {
      ...list.record.pickList,
      outcome: 'picked', picked: index + 1, pickedYear: item.year,
      pickMs: (list.pickedAt ?? Date.now()) - list.shownAt, form,
      ...(resumed ? { resumed: true } : {}),
    };
    let record = null;
    let out;
    // A pick is the answer to a question, not a new request, so it meets no
    // cooldown (onMessage takes it before the gate). But it is a lookup like
    // any other, which the member's next request waits for, and a pick that
    // queues its film starts their clock, as a request that queues one does
    // (_cooldownGate).
    const cooldownMs = list.msg ? this._throttled(ctx, list.msg) : 0;
    const keys = cooldownMs ? cooldownKeys(list.msg.senderJid, { beta: !!list.route?.beta }) : null;
    const lookup = keys ? this._cool().begin(keys, `${item.title} ${item.year}`) : null;
    // And the film it queues is the member's request all the same: inside
    // their cooldown as the pick is run, it is an extra in the fair order,
    // as a request let through inside it is (_cooldownGate). Their list's
    // request queued nothing, so the clock is the one it was asked inside.
    const cooled = keys ? insideCooldown(ctx.store, keys, { cooldownMs }) : null;
    try {
      out = await this._runRequest(list.msg, `${item.title} ${item.year}`, ctx, {
        pick, route: list.route ?? null, typed: list.request, at: list.at,
        onRecord: (r) => { record = r; }, insideCooldown: cooled,
      });
    } finally {
      // Not counted towards the flood backstop when it queues nothing: a
      // list is short and its own, and a refused pick reopens it for another
      // number, which the bot asked for.
      lookup?.settle(ctx.store, {
        queued: out?.queued === true, counts: false,
        what: record?.title ? `${record.title}${record.year ? ` (${record.year})` : ''}` : `${item.title} (${item.year})`,
        log: ctx.log, who: list.msg?.senderJid,
      });
      await this._settlePick(ctx, list, index, record);
    }
  },

  /**
   * After the pipeline has answered a pick: settle the list, and edit it to
   * match. Every edit is 'low' and allowed to fail - the reactions on the
   * request carry the real news.
   */
  async _settlePick(ctx, list, index, record) {
    const item = list.items[index];
    const n = index + 1;
    const status = record?.status ?? 'error';

    // A test's pick that passed is answered like one that was queued, and
    // its list says so rather than "on its way".
    if (['queued', 'working', 'sent', 'test-passed'].includes(status)) {
      this._pickUpdate(ctx, list.id, { state: 'answered' });
      // Built from what was QUEUED, not from the list: the pipeline may have
      // settled on another copy (see formatPicked).
      if (await this._pickEdit(ctx, list, formatPicked(n, item, { title: record.title, year: record.year },
        { test: status === 'test-passed' }))) {
        record.pickList.units += 1;
        this.upsertHistory(ctx, record);
      }
      ctx.log.info(`pick list for "${list.request}" picked ${n} -> ${status} ${record.title} (${record.year}) `
        + `[${record.pickList.units} message(s) for the list in all, ${record.pickList.invalid ?? 0} wrong number(s)]`);
      return;
    }

    const reopened = this._pickReopen(ctx, list, index, record);
    if (reopened) {
      if (reopened.edit && await this._pickEdit(ctx, list, reopened.edit)) this._pickBump(ctx, list.id, { units: 1 });
      return;
    }

    // Done with, without anything queued. The edit says so, without a ✔.
    this._pickUpdate(ctx, list.id, { state: 'answered' });
    if (record?.pickList && await this._pickEdit(ctx, list, formatPickFailed(n, item, status))) {
      record.pickList.units += 1;
      this.upsertHistory(ctx, record);
    }
    ctx.log.info(`pick list for "${list.request}" picked ${n} -> ${status}, not reopened `
      + `[${record?.pickList?.units ?? '?'} message(s) for the list in all]`);
  },

  /**
   * A pick the bot turned down, with time and another version left: the
   * list is its owner's again, minus that version.
   *
   * The list is built on the library's rating and the request is gated on
   * OMDb's, and the two can disagree (in review: Carrie 1976, PG in Jellyfin
   * and R in OMDb). The pick is then refused, rightly - but the list used to
   * be marked answered with a ✔ against the refused film, and the member's
   * next number was swallowed in silence until it expired. Now the refused
   * line is struck through and any other number still works. A failure that
   * is about the moment rather than the version (OMDb down) strikes nothing
   * out, so the same number can be tried again.
   *
   * Null when the list stays closed: switched off, too little time left, a
   * newer list from the same member, or nothing left on it to pick.
   */
  _pickReopen(ctx, list, index, record) {
    const status = record?.status ?? 'error';
    const now = Date.now();
    if (!this._pickLive(ctx, list) || list.expiresAt - now < REOPEN_MIN_MS) return null;
    const lists = this._pickJournal(ctx);
    const cur = lists.find((l) => l.id === list.id);
    if (cur?.state !== 'picked') return null;
    if (lists.some((l) => l.id !== list.id && l.state === 'open' && sameSender(l.sender, list.sender))) return null;

    const item = list.items[index];
    const versionRefused = VERSION_REFUSALS.has(status);
    const refused = [...new Set([...(cur.refused ?? []), ...(versionRefused ? [index] : [])])].sort((a, b) => a - b);
    if (refused.length >= list.items.length) return null;

    const refusals = [...(cur.record.pickList.refusals ?? []),
      { n: index + 1, year: item.year, status, detail: record?.detail ?? null }];
    const rec = {
      ...cur.record,
      status: 'pick-list',
      detail: `asked which one: ${offeredLabels(list.items).join(', ')}; `
        + `${refusals.map((r) => `${r.n} (${r.year}) ${r.status}`).join(', ')}`,
      pickList: { ...cur.record.pickList, outcome: null, refusals },
    };
    const entry = { ...cur, state: 'open', refused, record: rec, pickedAt: null, pickedIndex: null, pickForm: null };
    this._pickSave(ctx, lists.map((l) => (l.id === list.id ? entry : l)));
    this.upsertHistory(ctx, rec);
    this._pickArm(ctx, entry);

    // A film offered because the AI check might clear it was always going to
    // be refused on its rating when the check did not: that is expected, not
    // a disagreement worth a warning.
    if (status === 'blocked-rating' && item.via === 'ai') {
      ctx.log.info(`pick list: ${item.title} (${item.year}), rated ${item.rated ?? '?'}, was offered for the AI check `
        + `to clear, and it did not: struck through, the list stays open (${record?.detail ?? 'blocked'})`);
    } else if (status === 'blocked-rating') {
      ctx.log.warn(`pick list: ${item.title} (${item.year}) was offered as ${item.rated ?? 'unrated'} on the `
        + `library's rating, but the request was refused as ${record?.rated ?? 'blocked'} - they disagree`);
    }
    const left = entry.expiresAt - now;
    ctx.log.info(`pick list for "${list.request}" reopened: ${index + 1} (${item.year}) ended ${status}; `
      + `${list.items.length - refused.length} version(s) left, ${Math.round(left / 1000)}s to go`);
    return {
      entry,
      edit: versionRefused
        ? formatPickList(list.items, {
          minutes: Math.floor(left / 60_000), refused,
          moreStartWith: list.moreStartWith ?? 0, test: isTestRoute(list.route), query: list.query ?? '',
        })
        : null,
    };
  },

  /**
   * Add to a list's counters. They live on the journalled record, so they
   * reach History with whatever closes the list. The History row itself is
   * refreshed only while the list is still open: once a pick has handed the
   * row to the pipeline, writing the list's snapshot back would hide the
   * request's real progress.
   */
  _pickBump(ctx, id, counts) {
    const cur = this._pickJournal(ctx).find((l) => l.id === id);
    if (!cur) return;
    const pickList = { ...cur.record.pickList };
    for (const [k, v] of Object.entries(counts)) pickList[k] = (pickList[k] ?? 0) + v;
    const record = { ...cur.record, pickList };
    this._pickUpdate(ctx, id, { record });
    if (cur.state === 'open') this.upsertHistory(ctx, record);
  },

  /**
   * The owner's number that is not on the list, or is a version already
   * turned down. The list stays open, and the number gets a ❓ - or, given
   * by reacting, the list message it was put on does (_listMessage).
   */
  async _pickInvalid(list, msg, ctx, refusedIndex = null) {
    const cfg = ctx.config.movieRequests;
    this._pickBump(ctx, list.id, { invalid: 1 });
    const invalid = this._pickJournal(ctx).find((l) => l.id === list.id)?.record.pickList.invalid ?? 1;
    ctx.log.info(`❓ ${formatPhone(msg.senderNumber) ?? msg.senderJid} answered the list for "${list.request}" with ${pickSaid(msg)} `
      + `- ${refusedIndex != null ? `${refusedIndex + 1} was already turned down` : `not one of 1-${list.items.length}`}`
      + '; the list stays open'
      + `${invalid > MAX_INVALID_REACTIONS ? ' (no reaction: too many wrong numbers already)' : ''}`);
    if (invalid > MAX_INVALID_REACTIONS) return;
    const emoji = cfg.reactions.notFound ?? '❓';
    // A wrong number given by reacting has no message of its own to carry
    // the ❓ - a reaction cannot be reacted to, and the bot never tries - so
    // it goes on the list message the member reacted on, beside their
    // number, and comes off when a pick is taken (_pickUnquestion). It went
    // on their request at first, where every group's legend says ❓ means
    // "Couldn't match that title - check the spelling", replacing the 🔍 of
    // a list still waiting for them, and where the hourly beta scan read it
    // as a test code that was not taken (found in review, 2026-10-01).
    const on = msg.reaction ? this._listMessage(list, msg.reaction.targetId) : msg;
    try {
      if (await ctx.bot.react(on, emoji, { kind: this._reactionKind(cfg, emoji) })) {
        this._pickBump(ctx, list.id, { units: 1 });
        if (msg.reaction) this._pickUpdate(ctx, list.id, { questioned: on.id });
      }
    } catch (err) {
      ctx.log.warn(`could not react to a wrong pick: ${err.message}`);
    }
  },

  /**
   * One of a list's own messages, to react on: the bot's message in the
   * group the list went to - the list itself, or a $stamtest's answer.
   */
  _listMessage(list, id) {
    const jid = list.listJid ?? list.chatJid;
    const key = list.listKey?.id === id ? { remoteJid: jid, ...list.listKey } : { remoteJid: jid, id, fromMe: true };
    return { id, chatJid: jid, key, isGroup: true, fromMe: true };
  },

  /**
   * Take the ❓ for a wrong reacted number off the list, now that a pick
   * has been taken from it: left there, it sat beside the member's right
   * number on a list edited to "✔ 2 · …". 'normal': shed, it is a stray ❓.
   */
  async _pickUnquestion(ctx, list) {
    const id = list?.questioned;
    if (!id) return;
    this._pickUpdate(ctx, list.id, { questioned: null });
    const on = this._listMessage(list, id);
    try { await ctx.bot.react(on, '', { kind: 'normal' }); }
    catch (err) { ctx.log.debug(`could not take ❓ off the list for "${list.request}": ${err.message}`); }
  },

  /** Rewrite the list message. Low priority; false when it did not go. */
  async _pickEdit(ctx, list, text) {
    if (!list.listKey?.id || typeof ctx.bot.editText !== 'function') return false;
    if (!this._pickLive(ctx, list)) return false;
    if (Date.now() - list.shownAt > EDIT_WINDOW_MS) {
      ctx.log.debug(`pick list for "${list.request}" is too old to edit - leaving it as it is`);
      return false;
    }
    try {
      return !!(await ctx.bot.editText(list.listJid, list.listKey, text, { kind: 'low' }));
    } catch (err) {
      ctx.log.warn(`could not edit the pick list for "${list.request}": ${err.message}`);
      return false;
    }
  },

  /**
   * Send a closed list's final reaction and edit, and record what they cost.
   * `list.record` is already its closing History row, written by the caller
   * before anything was sent.
   *
   * False when the reaction could not be sent (WhatsApp down, a send error):
   * the caller keeps the list as 'expiring' and tries again. A reaction the
   * budget chose to drop is not retried - that is the budget working.
   */
  async _closePickList(ctx, list, { reaction = null, edit = null } = {}) {
    const record = { ...list.record, pickList: { ...list.record.pickList } };
    if (reaction && this._pickLive(ctx, list)) {
      try {
        if (!ctx.bot.isConnected()) throw new Error('WhatsApp is not connected');
        // 'normal': the list said when it would end, so nobody is left
        // waiting on this, but it is the request's last word and worth more
        // than a queue position.
        if (await ctx.bot.react(list.msg, reaction, { kind: 'normal' })) record.pickList.units += 1;
      } catch (err) {
        ctx.log.warn(`could not send the final reaction for the list "${list.request}": ${err.message}`);
        return false;
      }
    }
    if (edit && await this._pickEdit(ctx, list, edit)) record.pickList.units += 1;
    this.upsertHistory(ctx, record);
    ctx.log.info(`pick list for "${list.request}" ${record.pickList.outcome} [${record.pickList.units} message(s) in all, `
      + `${record.pickList.invalid ?? 0} wrong number(s)]`);
    return true;
  },

  /**
   * A list nobody answered in time - or one whose final reaction is still
   * owed (state 'expiring'). False if it was answered or replaced first.
   *
   * History is written first, and the list stays in the journal until its
   * reaction has gone. The other way round, a restart while the reaction
   * waited in the pacer lost both: the journal no longer had the list, and
   * its row said 'pick-list' for good, counted as open in the digest.
   */
  async _expirePickList(ctx, id, { restart = false } = {}) {
    const lists = this._pickJournal(ctx);
    const list = lists.find((l) => l.id === id && (l.state === 'open' || l.state === 'expiring'));
    if (!list) return false;
    this._pickDisarm(id);
    const cfg = ctx.config.movieRequests;

    let entry = list;
    if (list.state === 'open') {
      const offered = offeredLabels(list.items).join(', ');
      const minutes = Math.round((list.expiresAt - list.shownAt) / 60_000);
      ctx.log.info(`⌛ pick list for "${list.request}" ran out unanswered${restart ? ' while the bot was down' : ''} `
        + `(offered ${offered})`);
      const record = this._pickClosedRecord(list, {
        outcome: 'expired', status: 'pick-expired', detail: `no pick within ${minutes} min (offered ${offered})`,
      });
      this.upsertHistory(ctx, record);
      entry = { ...list, state: 'expiring', record, attempts: 0 };
    } else {
      ctx.log.info(`sending the final reaction for the expired list "${list.request}" again `
        + `(attempt ${(list.attempts ?? 0) + 1} of ${MAX_CLOSE_ATTEMPTS})`);
    }
    entry = { ...entry, attempts: (entry.attempts ?? 0) + 1 };
    this._pickSave(ctx, lists.map((l) => (l.id === id ? entry : l)));

    const done = await this._closePickList(ctx, entry, {
      reaction: cfg.reactions.needYear,
      edit: formatExpired(list.items, {
        prefix: suggestPrefix(list.route, requestPrefix(cfg)), refused: list.refused ?? [],
      }),
    });
    if (done) {
      this._pickRemove(ctx, id);
    } else if (entry.attempts >= MAX_CLOSE_ATTEMPTS) {
      ctx.log.warn(`giving up on the final reaction for the list "${list.request}" after ${entry.attempts} attempts `
        + '- History already says it expired');
      this._pickRemove(ctx, id);
    } else {
      this._pickArm(ctx, entry, CLOSE_RETRY_MS * entry.attempts);
    }
    return true;
  },

  /**
   * A pick a restart interrupted (state 'picked'): run it again, once.
   *
   * Nothing is run twice. A pick that reached the queue is in the job
   * journal, which recoverPending has already replayed; one that reached an
   * answer has that answer in History. Only a pick that was still being
   * looked up - its row 'checking', or 'lost' once reconcileHistory has seen
   * it - is run again, and one that was already resumed once is given up,
   * as recoverPending gives up a job rather than replay it on every boot.
   */
  async _resumePick(ctx, list) {
    const cfg = ctx.config.movieRequests;
    // Looked at again now: the overdue lists before it are paced seconds
    // apart, and in that time a held pick replayed at the same connect may
    // have been taken up, or settled (request-pause.js).
    const current = this._pickJournal(ctx).find((l) => l.id === list.id);
    if (current?.state !== 'picked' || this._picksRunning?.has(list.id) || ctx.requestPause?.holds?.(this.name, list.id)) return;
    const index = list.pickedIndex;
    const item = list.items?.[index];
    const queued = (ctx.store.get('pending', []) ?? []).some((p) => p.msgId === list.id);
    const row = (ctx.store.get('history', []) ?? []).find((r) => r.id === list.id);
    const unfinished = !row || ['checking', 'lost', 'pick-list'].includes(row.status);
    if (!item || queued || !unfinished) {
      this._pickUpdate(ctx, list.id, { state: 'answered' });
      ctx.log.info(`the pick for "${list.request}" had ${queued ? 'been queued' : `ended ${row?.status ?? 'somehow'}`} `
        + 'before the restart - nothing to resume');
      return;
    }
    if ((list.resumes ?? 0) >= 1) {
      this._pickUpdate(ctx, list.id, { state: 'answered' });
      ctx.log.warn(`not resuming the pick of ${index + 1} for "${list.request}" again - it was interrupted twice`);
      this.upsertHistory(ctx, {
        ...(row ?? list.record), status: 'lost', detail: 'the pick was interrupted twice by a restart',
      });
      if (!safeRoute(ctx.config, list.route)?.originIsMain) {
        const emoji = cfg.reactions.failed;
        try { if (emoji) await ctx.bot.react(list.msg, emoji, { kind: this._reactionKind(cfg, emoji) }); }
        catch (err) { ctx.log.warn(`could not react to a lost pick: ${err.message}`); }
      }
      return;
    }
    const entry = this._pickUpdate(ctx, list.id, { resumes: 1 }) ?? list;
    ctx.log.info(`resuming the pick of ${index + 1} (${item.title} ${item.year}) for "${list.request}" `
      + '- a restart interrupted it');
    await this._runPick(ctx, entry, index, list.pickForm ?? 'digit', { resumed: true });
  },

  /**
   * After a restart: re-arm the lists still running, close the ones that ran
   * out while the bot was down, send the final reactions still owed, and
   * finish the picks that were interrupted.
   */
  async recoverPickLists(ctx) {
    const lists = this._pickJournal(ctx);
    if (!lists.length) return;
    const now = Date.now();
    const live = lists.filter((l) => l.state === 'open' && l.expiresAt > now);
    const due = lists.filter((l) => l.state === 'open' && l.expiresAt <= now);
    const owed = lists.filter((l) => l.state === 'expiring');
    // A pick held while requests are paused is run by the pause, when they
    // resume - not here (request-pause.js).
    const inflight = lists.filter((l) => l.state === 'picked' && !ctx.requestPause?.holds?.(this.name, l.id));
    for (const l of live) this._pickArm(ctx, l);
    if (!live.length && !due.length && !owed.length && !inflight.length) return;
    ctx.log.info(`pick lists after a restart: ${live.length} still open and re-armed, `
      + `${due.length} ran out while the bot was down, ${owed.length} still owed a final reaction, `
      + `${inflight.length} picked but not finished`);
    // Each of these reacts, edits or runs a request, in a loop, so they are
    // paced like any other bulk work (CLAUDE.md rule 1). The quick ones go
    // first: a resumed pick can take as long as a library search.
    const work = [
      ...due.map((l) => () => this._expirePickList(ctx, l.id, { restart: true })),
      ...owed.map((l) => () => this._expirePickList(ctx, l.id, { restart: true })),
      ...inflight.map((l) => () => this._resumePick(ctx, l)),
    ];
    for (let i = 0; i < work.length; i += 1) {
      if (i > 0) await ctx.bot._bulkPace?.();
      try {
        await work[i]();
      } catch (err) {
        ctx.log.error(`pick-list recovery step failed: ${err.message}`);
      }
    }
  },
};
