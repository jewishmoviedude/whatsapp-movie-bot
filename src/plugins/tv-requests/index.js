import path from 'node:path';
import { panelRequester, requestMemberKey, formatPhone, phoneOut } from '../../core/members.js';
import { heldMessage } from '../../core/request-pause.js';
import { MemberCooldown, COOLDOWN_LIMITS, cooldownKeys, sweepCooldownKeys, insideCooldown } from '../../core/request-cooldown.js';
import fs from 'node:fs';
import {
  parseTvRequest, describeRequest, isSingleEpisode, pad, rangeCode, listCode, seasonList, seasonSpans, runsOf, numbersOfRuns, codeLeftIn,
} from './parse.js';
import { episodeFileName, episodeLabel, episodeOrder } from './naming.js';
import { resolveEpisodes, episodeDownloadUrl } from './jellyfin-tv.js';
import {
  trimPlan, episodeCodes as trimCodes, trimReply, trimFollowerReply, trimmedRow,
} from './trim-queued.js';
import { nextAsk, nextNotice, partsOf, numbersOf } from './next-part.js';
import { tvEpisodes } from '../../core/hourly-policy.js';
import { convertForWhatsApp, fmtBytes, conversionClock } from '../../media/ffmpeg.js';
import { segmentsReady } from '../../media/segmented.js';
import { downloadToFile, fmtDuration } from '../../media/download.js';
import { stageSems, STAGE_PRIORITY } from '../../media/stages.js';
import { postsTargets, broadcastFile, noGroupPosted } from '../../media/broadcast.js';
import { bestMatch, cleanRequestText, extractYear, stripSeriesDescriptor } from '../../util/fuzzy.js';
import { plainText } from '../movie-requests/pick-list.js';
import { recordMiss } from '../../core/library-misses.js';
import { checkMessage, violationNotice } from '../movie-requests/enforcement.js';
import { applyGroupTag } from '../../core/group-tag.js';
import { reactionKind } from '../../media/reaction-class.js';
import { positionEmoji } from '../../media/reaction-class.js';
import { showPlace } from '../../media/place-reaction.js';
import { stageReaction } from '../../media/stage-reaction.js';
import {
  isBetaGroup, resolveRoute, safeRoute, isEnabled, readBetaTest, featureGroup, testRequestText, isTestRoute, testCodeOf, suggestPrefix,
} from '../../core/beta.js';
import {
  afterMovieRecovery, isTransient, RetryBook, MAX_RETRIES, finishedOutput,
} from '../../media/resume.js';
import {
  reserveRoom, waitForRoom, jobNeed, isDiskFull, noteDiskFull, keepRoom, forgetKept,
} from '../../media/disk-space.js';
import {
  isSafeToDeleteIn, openWork, workKey, adoptWork, verifyIdentity, probeDownload,
} from '../../media/work-files.js';
import { describeWithheld, withheldFrom, ratingNoticeOn, numbersInCodes } from './withheld.js';
import { screenRated, describeScreen, LIMITS as AI_CHECK_LIMITS } from './override-check.js';
import { shareMessage } from './shared-message.js';
import {
  capCut, cutDetail, cutLimit, cutReply, partAfter,
} from './cap-cut.js';

// New wording for a request whose episodes are waiting already (beta.js).
const TV_DUPLICATE = 'tv-duplicate-notice';

/**
 * The delete guard for an episode's files (CLAUDE.md rule 5): inside the
 * work directory, and never under a library root. The TV side deleted with
 * no guard at all - its downloads, its converted files and the file a retry
 * kept - which was safe only as long as every path it built was right.
 */
function tvSafe(ctx) {
  return (p) => isSafeToDeleteIn(p, { workDir: ctx.config.media?.workDir, roots: ctx.config.library?.local?.roots ?? [] });
}

/*
 * An episode's work, in a directory named from its request and episode
 * (media/work-files.js), which a restart finds again: One Piece season 17,
 * 118 episodes of about 250 MB each, is resumed an episode at a time, and an
 * episode cut off mid-download or mid-encode used to start again from its
 * first byte - as The Parent Trap did, twice, on 2026-09-29.
 */
function episodeWork(ctx, reqKey, epId, label = null, { jobId = null } = {}) {
  const workDir = ctx.config?.media?.workDir;
  if (!workDir) return null;
  const key = reqKey ? workKey.tv(reqKey, epId) : `tv:job:${jobId}`;
  return openWork({ workDir, key, kind: 'tv', label, isSafe: tvSafe(ctx), keptKey: reqKey ? `${reqKey}:${epId}` : null });
}

/** A file's size, or null when it is not there. */
function fileSize(p) {
  try { return fs.statSync(p).size; } catch { return null; }
}

/**
 * How a request can end that the flood backstop does not count against the
 * member (src/core/request-cooldown.js): a "which season?" pass spent on
 * another show, which was refused 🚫 for the cooldown already, and a 🚫 is
 * never counted. Every other ending that queued nothing counts, the bot's
 * own failures included - the lookup failed, Jellyfin is not set up, the
 * queue is full - since each is still a ⚠️ on the number, and a full queue a
 * notifications line. They used to be left out, and with the clock no longer
 * started by them nothing limited them: ten "The Boys season 1" into a full
 * queue drew ten notifications lines and twenty Jellyfin calls, where the
 * kept clock had allowed one (found in review, 2026-10-01). A message asking
 * for several seasons that queued none ends 'answered' whatever the reason,
 * and so counts the same as one season refused for the same reason.
 *
 * Nor the member's own request sent again while it waits ('resent',
 * _resentTv): it is the request they made, not another answer to hold
 * against them. Iron Man 3, 2026-10-11 (movie-requests _resentFilm): shown
 * 🔄 after a restart, its member sent it again and was answered 🤥. Only the
 * first time: sent again once more ('resent-again') it counts, so the
 * backstop still caps a member sending the same request over and over, as
 * it capped the duplicates those were (found in review, 2026-10-11).
 */
const NOT_COUNTED = new Set(['cooldown', 'resent']);

/**
 * How long a member's next TV request waits for one of theirs still being
 * looked up (src/core/request-cooldown.js, rule 2): the AI checks alone may
 * take LIMITS.budgetMs (five minutes) for one message, and a minute more
 * covers the library around them. It was a minute, and "vinland saga season
 * 1" took 72 s on 2026-10-01 (ten AI checks through Gemini 503s): a second
 * request sent in that time would have been let go at 60 s with no clock yet
 * written, and both would have queued (found in review the same day). A
 * request that queues episodes also lets its waiters go the moment it does
 * (_runSeason, onQueued), not when its last season has been looked up.
 */
const TV_LOOKUP_WAIT_MS = AI_CHECK_LIMITS.budgetMs + 60_000;

/**
 * The reason a beta test failed, for its History row.
 *
 * A main row keeps its counts-only detail, exactly as before. A beta row is a
 * test result, and when it failed because its destination had become a main
 * group (safeRoute) the play-by-play that would have said so is withheld too -
 * so without this the reason would be nowhere but the log.
 */
function betaWhy(route, failed, why) {
  return route?.beta && failed && why ? ` — ${why}` : '';
}

/**
 * How a request is named after its show: "season 2", or for a run of episodes
 * its codes, "S01E01–E05" - the span the server holds, not every number
 * typed. Lines and History used to say "season 1" for "S01E01-E05", which
 * reads as the whole season. A list is named by the episodes of it the
 * server holds, "S01E04–E07, E09" (listCode).
 */
function scopeOf(found, parsed) {
  const list = parsed?.episodeList;
  if (list?.length) {
    const held = list.filter((n) => !(found.missing ?? []).includes(n));
    return listCode(found.season, held.length ? held : list);
  }
  const r = parsed?.episodeRange;
  if (!r) return `season ${found.season}`;
  const nums = (found.episodes ?? []).map((e) => e.episode).filter((n) => Number.isFinite(n));
  return nums.length
    ? rangeCode(found.season, Math.min(...nums), Math.max(...nums))
    : rangeCode(found.season, r.from, r.to);
}

/**
 * How a request is named once it is queued, after its show, as { scope,
 * count }: "<show> <scope> — <count>" in the "added" line, the journal and
 * the finished notice, "<show> <scope>" in the queue (and in the journal of
 * one queued from the panel, which never had a count), "<scope> — <count>"
 * on the History row. A request that queued everything it asked for keeps
 * the name it always had, "S05E04–E10" and "7 episode(s)" (scopeOf). One
 * that queued part of it is named by the episodes that went in, and what
 * they are part of: "S05E08–E09" and "2 of E04–E10", or "2 of season 5".
 *
 * Aiden's "Outer Banks S05E04-E10" (2026-10-11) looked up all seven
 * episodes; they are TV-MA, and the AI check cleared E08 and E09 alone, so
 * those two were queued. The "added" line, the queue, History, the journal
 * and, the next day, after a restart had resumed it from the journal, "✅ …
 * all 2 episodes posted!" all named it "Outer Banks S05E04–E10 — 2
 * episode(s)" - the span asked for, beside a count of what was queued - and
 * the operator read it as E04 and E10: "if it's a dash it's 4 through 10,
 * comma then it'll only be those 2, comprendo?" (2026-10-12). So the
 * episodes are written the way he reads codes, a dash for every episode
 * between its ends and a comma for a gap ("S05E04, E10"), and the span asked
 * for comes after "of", where it can only be what they were taken from,
 * never the episodes coming: the member still recognises the request, and
 * sees it is part of it.
 *
 * Part of it: an episode that was looked up and is not in `list` - withheld
 * on its rating, waiting already from another request, past
 * maxEpisodesPerRequest - and, in a run of episodes, a number between its
 * ends the library does not have. A season holds what the library holds, so
 * only the first kind cuts one. An episode with no number cannot be written
 * as a code, and then the name is the one it always was.
 */
function queuedName(found, parsed, list, scope = scopeOf(found, parsed)) {
  const n = list?.length ?? 0;
  const whole = { scope, count: `${n} episode(s)` };
  const sent = episodeNumbers(list);
  if (!sent?.length) return whole;
  const got = new Set(sent);
  const lost = episodeNumbers(found?.episodes, { skipUnnumbered: true }).some((x) => !got.has(x));
  const gap = !!parsed?.episodeRange && sent.at(-1) - sent[0] + 1 !== sent.length;
  if (!lost && !gap) return whole;
  return partName(found.season, sent, n, scope);
}

/**
 * queuedName for part of a request: the episodes it holds by their codes,
 * and "N of" what was asked for - the scope, its season's code left off a
 * run of episodes ("2 of E04–E10"). A request trimmed to the episode limit
 * after it was queued is named so too (trimQueued): "Arrow S01E01–E10 — 10
 * of season 1", as one the limit cut as it was made.
 */
function partName(season, numbers, n, asked) {
  return { scope: episodeCodes(season, numbers), count: `${n} of ${String(asked).replace(/^S\d+(?=E)/, '')}` };
}

/**
 * A journalled request's name taken apart (queuedName): `title` without its
 * count ("Arrow season 1", "Outer Banks S05E08–E09"), as the queue shows it,
 * and `asked`, what its member asked for after the show - "season 1", or
 * "S05E04–E10" from a name's "2 of E04–E10" - or null when the name says
 * neither (one episode, or one an older version wrote some other way).
 */
function nameParts(label, show, season) {
  const text = String(label ?? '');
  const m = /^(.*) — \d+ (?:episode\(s\)|of (.+))$/.exec(text);
  const title = m ? m[1] : text;
  let asked = null;
  if (m?.[2]) asked = /^E\d/.test(m[2]) && season != null ? `S${pad(season)}${m[2]}` : m[2];
  else if (show && title.startsWith(`${show} `)) asked = title.slice(show.length + 1);
  // One queued from the panel is journalled with no count (requeue).
  return { title, asked, counted: !!m };
}

/**
 * The episode numbers `eps` hold, sorted, each once; a double-episode file
 * holds every number it spans. Null when one has no number, unless those are
 * to be skipped.
 */
function episodeNumbers(eps, { skipUnnumbered = false } = {}) {
  const out = new Set();
  for (const e of eps ?? []) {
    const from = e?.episode == null ? NaN : Number(e.episode);
    if (!Number.isFinite(from)) {
      if (skipUnnumbered) continue;
      return null;
    }
    const to = Number(e.episodeEnd) > from ? Number(e.episodeEnd) : from;
    for (let k = from; k <= to && k - from < 1000; k++) out.add(k);
  }
  return [...out].sort((a, b) => a - b);
}

/** "S05E04–E07, E09": episode numbers as codes, a run with a dash and a gap with a comma. */
function episodeCodes(season, nums) {
  const runs = [];
  for (const k of nums) {
    if (runs.length && k === runs.at(-1)[1] + 1) runs.at(-1)[1] = k;
    else runs.push([k, k]);
  }
  return runs.map(([from, to], i) => rangeCode(i ? null : season, from, to)).join(', ');
}

/**
 * "1 failed, 2 skipped": the clauses after "N of M posted" in a request's
 * notifications line and History row. An admin's skip is counted with the
 * cancels (the notifier's `cancelled`), and named apart from them: "3
 * cancelled" for a season an admin set aside read as an admin cancelling it.
 */
function countsProse({ failed = 0, cancelled = 0, skipped = 0 }) {
  return [
    ...(failed ? [`${failed} failed`] : []),
    ...(cancelled - skipped > 0 ? [`${cancelled - skipped} cancelled`] : []),
    ...(skipped ? [`${skipped} skipped`] : []),
  ];
}

/** Where a request's episodes are posted: the main TV posts groups, or one beta group. */
function destinationOf(route) {
  return route?.beta ? `beta:${route.postsGroup ?? ''}` : 'main';
}

/**
 * The episodes the rating filter left out, on the end of every History detail
 * a request writes - queued, finished, and finished after a restart - so the
 * row never claims a whole season when part of it was withheld. Given the
 * row's `withheld` field (describeWithheld's `detail`), which is journalled
 * with the request, so a resumed season keeps it too. Empty when nothing was.
 */
function withheldSuffix(withheld) {
  return withheld ? ` · ${withheld}` : '';
}

/**
 * The same for a finished row: the episodes withheld on rating, then what
 * the bypass list and the AI check did (the row's `override` field,
 * describeScreen's `detail`), then a list's episodes the server does not
 * have, each journalled with the request for the same reason.
 */
function rowSuffix(row) {
  return withheldSuffix(row?.withheld) + withheldSuffix(row?.override) + withheldSuffix(row?.absent);
}

/**
 * What the episode limit left out of a request, on its finished row: the
 * `cut` its notifier holds (cap-cut.js cutDetail) - the one it was queued
 * with, or the one trimQueued gave it since, which the row's `baseRow`
 * cannot know. A request with neither reads as it always did.
 */
function cutSuffix(notifier) {
  return withheldSuffix(cutDetail(notifier?.cut));
}

/**
 * The episodes of a list the server does not have, for a History row's
 * `absent` field - "1 not on the server: E30" - or null when it has them all.
 * Kept on the row like `withheld`, so the row says why S01E30 never came
 * whether the request is queued, finished, or finished after a restart.
 */
function absentDetail(found) {
  const missing = found?.missing ?? [];
  return missing.length ? `${missing.length} not on the server: ${listCode(null, missing)}` : null;
}

/**
 * TV request plugin.
 *
 * A request names a show and a season, one episode, a run of episodes
 * ("S01E01-E05") or a list of them ("S01E06, E09"). A message naming
 * several seasons is one request per season (_runSeasons), sharing the
 * message's reaction (shared-message.js).
 * Jellyfin has no single file for a season, so the season is enumerated and
 * EACH episode becomes its own queue job - which is what lets a movie
 * overtake the remaining episodes mid-season.
 *
 * The jobs of one request share a queue group (its reqKey), and the queue
 * counts, orders, shows and cancels the group as ONE item: a season is one
 * place in line, not fifty (see src/core/queue.js). The requester's message
 * shows that place as a number reaction until the first episode starts
 * (_updatePositions).
 *
 * Episodes are queued in broadcast order and, because the queue runs one job at
 * a time, they are posted one by one in that order.
 */
export default {
  name: 'tv-requests',
  description: 'Watches TV request groups and posts whole seasons, one episode at a time.',
  configKey: 'tvRequests',

  async setup(ctx) {
    const cfg = ctx.config.tvRequests ?? {};
    ctx.log.info(cfg.enabled
      ? `tv-requests ready (${(cfg.requestGroups ?? []).length} request group(s), ${postsTargets(cfg).length} posts group(s))`
      : 'tv-requests loaded but disabled - enable it in the portal');
    // Cooldown clocks from before 2026-10-01 and answers long out of the
    // window are never read again (request-cooldown.js).
    try {
      const cleared = sweepCooldownKeys(ctx.store);
      if (cleared) ctx.log.info(`TV: cleared ${cleared} cooldown entr${cleared === 1 ? 'y' : 'ies'} that can no longer apply`);
    } catch (err) { ctx.log.warn(`TV: could not clear old cooldown entries: ${err.message}`); }

    // Live queue-position reactions, which the movie side has always had and
    // TV never did: a TV request sat on 🎬 from the moment it was queued until
    // its first episode started, however far back in line it was, while the
    // group rules promise "1️⃣2️⃣3️⃣…🔟 Your place in line (updates live)" for
    // both. Kept current on every queue change, in every TV request group - it
    // is the movie group's behaviour brought to TV, so it has no beta flag
    // (it had one, beta002, until the operator said it never needed one). A
    // request that could not get into the queue earlier is let in from here
    // too, once there is room.
    //
    // reqKey -> { msg, lastEmoji, route, also } (see place-reaction.js), where
    // `also` holds the messages of duplicate requests that follow it
    // (_followPlace), each with its own record of what it shows.
    this._reactors ??= new Map();
    if (!this._onQueue && ctx.queue?.on) {
      this._onQueue = () => {
        // Called from inside the queue's own emit: a throw here would land in
        // the queue, which emits 'updated' just before starting the next job.
        try { this._pump(ctx); } catch (err) { ctx.log.warn(`TV pump failed: ${err.message}`); }
        this._positionsSoon(ctx);
      };
      for (const ev of ['added', 'updated', 'state']) ctx.queue.on(ev, this._onQueue);
      this._queueOf = ctx.queue;
    }

    // Replay anything the last process was still holding - but only once
    // WhatsApp is up, or an episode would download and convert for minutes
    // before failing at the send. What the last process held is noted now:
    // a request queued from the panel before the first connect journals and
    // queues itself, and replaying it as a leftover queued every episode
    // twice.
    const leftover = new Set((ctx.store.get('pending', []) ?? []).map((r) => r.reqKey));
    const batches = new Set((ctx.store.get('seasonBatches', []) ?? []).map((n) => n.msgId));
    // The queue is told now what will come back, before either plugin puts
    // anything back - though the seasons go back after the films (_expectBack).
    this._expectBack(ctx, leftover);
    if (ctx.bot.isConnected()) {
      await this.recoverPending(ctx, { leftover, batches }).catch((e) => ctx.log.error(`TV recovery failed: ${e.message}`));
    } else {
      const onState = (st) => {
        if (st.state !== 'connected') return;
        ctx.bot.off('state', onState);
        this.recoverPending(ctx, { leftover, batches }).catch((e) => ctx.log.error(`TV recovery failed: ${e.message}`));
      };
      ctx.bot.on('state', onState);
      this._onState = onState;
      this._ctx = ctx;
    }
  },

  async teardown() {
    if (this._onState && this._ctx) {
      this._ctx.bot.off('state', this._onState);
      this._onState = null;
    }
    // Episodes waiting on a retry are still journalled; the next start
    // replays them.
    this._retries?.clear();
    this._retryBooked?.clear();
    if (this._onQueue && this._queueOf) {
      for (const ev of ['added', 'updated', 'state']) this._queueOf.off(ev, this._onQueue);
      this._onQueue = null;
      this._queueOf = null;
    }
    if (this._positionsTimer) clearImmediate(this._positionsTimer);
    this._positionsTimer = null;
    for (const r of this._reactors?.values() ?? []) {                 // nothing more may land
      r.gone = true;
      for (const f of r.also ?? []) f.gone = true;
    }
    this._reactors?.clear();
    this._notifiers?.clear();
  },

  /** Reactions fall back to the movie set so both sections look identical. */
  _react(ctx) {
    const tv = ctx.config.tvRequests?.reactions ?? {};
    const movie = ctx.config.movieRequests?.reactions ?? {};
    return { ...movie, ...tv };
  },

  async onMessage(msg, ctx) {
    const cfg = ctx.config.tvRequests;
    if (!cfg?.enabled) return;
    if (msg.fromMe || !msg.isGroup) return;
    // A member's reaction (bot.js hands them on since the operator asked for
    // picks by reaction, 2026-10-01) means something only to the movie
    // plugin's "which one?" lists. Here it is not a request, not chatter to
    // moderate, and never something to react back to.
    if (msg.reaction) return;

    // A beta group takes TV tests as well as film tests, and nothing else: a
    // message counts there only when it starts with the code of a feature
    // being tested (readBetaTest), which also says whether it is a TV test.
    // This plugin claims those, and the movie plugin everything else there -
    // the film tests, and the answers to a message that is not a test - so
    // no message is answered twice. The operator, 2026-09-29: "if someone
    // requests a regular movie like captain Phillips it should be ignored
    // because it's not the beta".
    const beta = isBetaGroup(ctx.config, msg.chatJid);
    if (!beta && !cfg.requestGroups?.includes(msg.chatJid)) return;
    let test = null;
    if (beta) {
      test = readBetaTest(ctx.config, msg.text);
      if (test.outcome !== 'tv') return;
      // The request after the code, as a member would type it in a TV group;
      // a $stamtest is judged as a main group would judge it (featureGroup).
      msg = { ...msg, text: testRequestText(test, cfg), ...(test.stam ? { stam: true } : {}) };
    }
    // Where this request's updates go, fixed now and journalled with it. Null
    // for a main request, which keeps following the live config. A beta one
    // is a test (isTestRoute), and carries its code; nothing of it is queued.
    const fresh = beta ? resolveRoute(ctx.config, msg.chatJid) : null;
    const route = fresh ? { ...fresh, test: test.code } : null;

    // Same auto-moderation as the movie request groups: these are requests-only
    // too, so chatting / media / wrongly-formatted messages are removed. The
    // enforcement settings are shared, but the PREFIX and rule command come
    // from the TV section so the advice we PM back is correct for this group.
    // It applies in a beta group for the same reason as on the movie side:
    // moderation is worth trialling where a mistake costs a tester's message.
    const enfCfg = {
      ...ctx.config.movieRequests,
      requirePrefix: cfg.requirePrefix,
      prefix: cfg.prefix,
      // A TV request legitimately contains numbers ("The Boys season 1"), and
      // the multi-title heuristic is tuned for film titles, so it is not
      // applied here - a wrongly deleted request is worse than a missed double.
      enforcement: { ...(ctx.config.movieRequests?.enforcement ?? {}), deleteMultiple: false },
    };
    try {
      const isAdmin = ctx.bot.isGroupAdmin(msg.chatJid, { jid: msg.senderJid, number: msg.senderNumber });
      const bad = checkMessage(msg, enfCfg, { isAdmin });
      if (bad) {
        await ctx.bot.deleteMessage(msg);
        ctx.log.info(`🧹 deleted a TV-group message from ${formatPhone(msg.senderNumber) ?? msg.senderJid}: ${bad.reason}`);
        if (enfCfg.enforcement?.warnByDm && msg.senderJid) {
          try {
            const dm = await ctx.bot.sendText(msg.senderJid, violationNotice(bad, enfCfg, msg));
            if (enfCfg.enforcement?.archiveAfterDm !== false) {
              try { await ctx.bot.archiveChat(msg.senderJid, dm ? { key: dm.key, messageTimestamp: dm.messageTimestamp } : null); }
              catch (err) { ctx.log.debug(`could not archive the PM: ${err.message}`); }
            }
          } catch (err) { ctx.log.debug(`could not DM the TV rule notice: ${err.message}`); }
        }
        return;
      }
    } catch (err) {
      ctx.log.warn(`TV enforcement failed (message left in place): ${err.message}`);
    }

    if (!msg.text) return;
    let text = msg.text.trim();
    if (cfg.requirePrefix) {
      const p = (cfg.prefix ?? '').trim();
      if (!p || !text.toLowerCase().startsWith(p.toLowerCase())) return;
      text = text.slice(p.length).trim();
    }
    if (!text || text.length < 2 || text.length > 200) return;

    // Per-user cooldown, as for films (movie-requests onMessage): it keeps one
    // member from filling the queue, and it is keyed by sender, so ten people
    // asking at once all get through. Its clock starts only when a request
    // queues episodes (_cooldownGate).
    const gate = await this._cooldownGate(msg, text, ctx, { beta });
    if (!gate.go) return;

    // Requests paused from the panel (src/core/request-pause.js): ⏸️, held,
    // and run in order when they resume. Here, where the message is a request
    // that would run: chatter was moderated above as ever, and a request
    // inside the cooldown was answered 🚫 above, as live. Held, it is not
    // being looked up, so the member's next request does not wait for it; it
    // meets the cooldown again when it runs (replayHeld) - unless it was let
    // through on a "which season?" pass, which is spent and goes with it. A
    // beta group is never paused: the pause is for while something is being
    // tested there.
    if (!beta && ctx.requestPause?.isPaused()) {
      gate.lookup?.drop();
      await ctx.requestPause.hold(ctx, msg, {
        plugin: this.name, text, emoji: this._react(ctx).paused, extra: { pass: gate.pass },
      });
      return;
    }

    return this._afterIntake(msg, text, ctx, { route, ...gate });
  },

  /**
   * A request held while requests were paused, run now that they are not
   * (request-pause.js replay): from where onMessage would have run it, "as
   * if it had just arrived". So it meets the cooldown again: a request of
   * the member's held before it may have queued episodes since, on resume,
   * and the clock starts only then (_cooldownGate); refused, it gets 🚫 in
   * place of its ⏸️. One let through on a "which season?" pass when it
   * arrived keeps it. Not with TV requests switched off since: that is what
   * an admin switching them off means, and the pause says so on the request
   * (⚠️), in the log and the audit log.
   */
  async replayHeld(item, ctx) {
    const cfg = ctx.config.tvRequests;
    if (!cfg?.enabled) throw new Error('TV requests have been switched off since it arrived');
    const msg = heldMessage(item.msg);
    const gate = await this._cooldownGate(msg, item.text, ctx, { beta: false, pass: item.pass ?? null });
    if (!gate.go) return;
    return this._afterIntake(msg, item.text, ctx, { route: null, ...gate });
  },

  /** The section's cooldown: the clock, the backstop and the requests in flight (src/core/request-cooldown.js). */
  _cool() {
    this._cooldown ??= new MemberCooldown({
      section: 'TV', limits: { ...COOLDOWN_LIMITS, inFlightWaitMs: TV_LOOKUP_WAIT_MS },
    });
    return this._cooldown;
  },

  /**
   * The cooldown, for a request about to run - as it arrives, or as a held
   * one is run on resume. As for films (movie-requests _cooldownGate, which
   * has the operator's rule of 2026-10-01 and Ben Lewis's incident): the
   * clock starts only when a request of the member's queues at least one
   * episode, so "which season?", not in the library, a rating refusal, a
   * duplicate or a test leaves it as it was. A request waits first for any
   * of theirs still being looked up, then meets 🚫 if their clock is running
   * (unless nobody else is waiting and the option says so) or the flood
   * backstop has tripped. Group admins are not held to any of it, as they are
   * not for films; beta requests keep keys of their own, so testing never
   * throttles somebody's real request.
   *
   * The one answer to "which season?" goes through whatever would refuse
   * it - the bot asked for it - once, naming a season, and is confirmed to
   * be the same show once it has been looked up (_passFits). `pass` is set
   * for a held request that was let through on one when it arrived.
   *
   * Resolves to { go: false } once a refusal has been answered, or to
   * { go: true, lookup, pass, cooldown, passKey, insideCooldown } for
   * _afterIntake. `insideCooldown` is the member's running clock the request
   * was let through inside of, if it was - nobody else waiting, or the
   * "which season?" pass: the seasons it queues are extras in the fair order
   * (src/core/queue.js), the operator's rule of 2026-10-12.
   */
  async _cooldownGate(msg, text, ctx, { beta = false, pass: preset = null } = {}) {
    const cfg = ctx.config.tvRequests;
    const cooldown = (cfg.cooldownSecondsPerUser ?? 0) * 1000;
    const isStaff = ctx.bot.isGroupAdmin?.(msg.chatJid, {
      jid: msg.senderJid, number: msg.senderNumber,
    }) ?? false;
    const passKey = beta ? `cooldown-pass:beta:${msg.senderJid}` : `cooldown-pass:${msg.senderJid}`;
    if (!(cooldown > 0) || isStaff) return { go: true, lookup: null, pass: preset, cooldown: 0, passKey, insideCooldown: null };
    const keys = cooldownKeys(msg.senderJid, { beta });
    const cool = this._cool();
    // Judged once nothing of theirs is in flight, and synchronously: a second
    // request let in before this one is registered would not wait for it.
    const turn = await cool.turn(keys, {
      what: text, log: ctx.log, who: msg.senderJid,
      judge: () => {
        // One moment for the refusal and for whether the request is inside
        // the cooldown, so the two can never disagree.
        const now = Date.now();
        const inside = insideCooldown(ctx.store, keys, { cooldownMs: cooldown, now });
        if (preset) return { go: true, pass: preset, insideCooldown: inside };
        // A request that would be held (onMessage) counts the member's TV
        // requests held already: each is an answer on resume.
        const pending = !beta && ctx.requestPause?.isPaused?.()
          ? (ctx.requestPause.heldFrom?.(this.name, msg.senderJid) ?? 0) : 0;
        const no = cool.refusal(ctx.store, keys, { cooldownMs: cooldown, pending, now });
        const held = ctx.store.get(passKey, null);
        let pass = null;
        if (no?.why === 'clock' && this._cooldownWaived(ctx, cfg, msg, beta)) {
          ctx.log.info(`TV: letting ${msg.senderJid} through the cooldown: nobody else is waiting (cooldownOnlyWhenOthersWait)`);
        } else if (no && held && held.until > Date.now() && parseTvRequest(text).season != null) {
          pass = { ...held, refuseUntil: Date.now() + no.leftMs, why: no.why };
          ctx.log.info(`TV: letting ${msg.senderJid} through the ${no.why === 'flood' ? 'flood backstop' : 'cooldown'} `
            + `with their one answer to "which season?" for ${held.name ?? 'the show'}`);
        } else if (no) {
          return { go: false, no };
        }
        // A pass is for ONE answer: spent by the member's next request let
        // through, whichever way. Left in place, it let a later season through
        // the cooldown once somebody else was waiting, which the option never
        // allows (found in review, 2026-09-30).
        if (held) this._forget(ctx, passKey);
        return { go: true, pass, insideCooldown: inside };
      },
    });
    if (!turn.go) {
      await this._tooSoon(ctx, msg, turn.no.leftMs, turn.no);
      return { go: false };
    }
    return { go: true, lookup: turn.lookup, pass: turn.pass, cooldown, passKey, insideCooldown: turn.insideCooldown ?? null };
  },

  /**
   * The request itself, once the cooldown has let it through, and what its
   * ending means for the member's cooldown (src/core/request-cooldown.js):
   * episodes queued start their clock; any other ending counts towards the
   * flood backstop, except the bot's own failures (NOT_COUNTED). `lookup` is
   * the request in flight, `pass` the "which season?" answer it was let
   * through on, `insideCooldown` the clock it was let through inside of.
   */
  async _afterIntake(msg, text, ctx, {
    route = null, pass = null, lookup = null, cooldown = 0, passKey = `cooldown-pass:${msg.senderJid}`,
    insideCooldown: cooled = null,
  } = {}) {
    let out = null;
    // The moment episodes go into the queue, the clock starts and the
    // member's next request is let go to meet it (TV_LOOKUP_WAIT_MS says why).
    const onQueued = lookup ? () => lookup.queued(ctx.store, { what: text, log: ctx.log, who: msg.senderJid }) : null;
    try {
      out = await this._runRequest(msg, text, ctx, { route, pass, onQueued, insideCooldown: cooled });
    } finally {
      lookup?.settle(ctx.store, {
        queued: out?.queued === true,
        counts: !!out && !NOT_COUNTED.has(out.outcome),
        what: text, log: ctx.log, who: msg.senderJid,
      });
    }
    // Asked "which season?", the member may answer once whatever would
    // refuse it: the reply asks them to. The question no longer starts their
    // clock, so this matters only where the clock of an earlier queued
    // request or the flood backstop is running - but there, refusing the
    // answer left them unable to give it. One answer, naming a season of the
    // same show, for as long as either could refuse it.
    if (lookup && out?.outcome === 'need-season' && (out.series || out.name)) {
      const lasts = Math.max(cooldown, this._cool().limits.floodWindowMs);
      ctx.store.set(passKey, { series: out.series ?? null, name: out.name ?? null, until: Date.now() + lasts });
    }
  },

  /**
   * May a request inside its cooldown go through, because nobody else is
   * waiting? As for films (movie-requests _cooldownWaived), with the TV
   * section's own option, tvRequests.cooldownOnlyWhenOthersWait: only when no
   * other member has anything waiting or running in the queue, films and TV
   * together, the member's own requests aside (queue.hasOthers).
   *
   * It also used to ask that the request that started the member's clock had
   * queued episodes (queue.queuedSince): the clock started at every request,
   * and without it (found in review, 2026-09-30, before it shipped) one
   * member sending "#request The Boys" ten times into an idle queue made the
   * bot send twenty messages. Since 2026-10-01 the clock starts only when a
   * request queues, so a running clock always means exactly that; what limits
   * the requests that queue nothing is the flood backstop, which this never
   * waives.
   *
   * Never for a beta test, which queues nothing; a queue that cannot answer
   * counts as busy.
   */
  _cooldownWaived(ctx, cfg, msg, beta) {
    if (beta || !cfg.cooldownOnlyWhenOthersWait) return false;
    const q = ctx.queue;
    if (typeof q?.hasOthers !== 'function') return false;
    return !q.hasOthers(requestMemberKey(msg));
  },

  /**
   * A request refused for the cooldown: 🚫, and the reply when replies on
   * blocking are on. This was the log line and nothing else. The live TV
   * group's cooldown is a quarter of an hour, and a member who asked again
   * inside it saw no reaction at all and could only think the bot had missed
   * them, which is what the film side's 🚫 was added for. 'critical', as
   * there: being told to slow down is the whole point of the throttle.
   */
  async _tooSoon(ctx, msg, leftMs, no = null) {
    const wait = Math.max(1, Math.ceil(leftMs / 1000));
    // "ignoring <sender>: cooling down" is what the hourly check's scan
    // matches (incident-scan.js), whichever of the two refused it.
    const why = no?.why === 'flood'
      ? ` - ${no.count} requests answered without queueing in the last ${Math.round(this._cool().limits.floodWindowMs / 60_000)} min`
        + `${no.held ? ` and ${no.held} held while requests are paused` : ''} (the flood backstop)`
      : no?.clock ? ` - their request "${no.clock.what ?? '?'}" was queued ${fmtDuration(Math.round((Date.now() - no.clock.at) / 1000))} ago` : '';
    ctx.log.info(`ignoring ${msg.senderJid}: cooling down (${fmtDuration(wait)} left)${why}`);
    const R = this._react(ctx);
    try { await ctx.bot.react(msg, R.tooFast ?? '🚫', { kind: 'critical' }); }
    catch { /* best effort */ }
    if (ctx.config.movieRequests?.replyOnBlock) {
      try {
        await ctx.bot.sendText(msg.chatJid,
          `🚫 Request denied — too many at once. Please wait ${fmtDuration(wait)} and send it again. `
          + 'One request at a time, so everyone gets a turn.', { quoted: msg });
      } catch (err) { ctx.log.warn(`could not reply: ${err.message}`); }
    }
  },

  /**
   * Is `series`, just looked up, the show a "which season?" pass was given
   * for? By id, or by name: a season held only in the show's other entry
   * (resolveEpisodes' twins) comes back under that entry's id.
   */
  _passFits(series, pass) {
    if (!series || !pass) return false;
    if (pass.series != null && String(series.id) === String(pass.series)) return true;
    const norm = (v) => String(v ?? '').trim().toLowerCase();
    return !!pass.name && norm(series.name) === norm(pass.name);
  },

  /** The pass was spent on another show: the cooldown's answer, after all. */
  async _passRefused(ctx, msg, pass) {
    ctx.log.info(`TV: ${msg.senderJid} answered "which season?" with another show - refused for the `
      + `${pass?.why === 'flood' ? 'flood backstop' : 'cooldown'}`);
    await this._tooSoon(ctx, msg, (pass?.refuseUntil ?? pass?.until ?? Date.now()) - Date.now());
    return { outcome: 'cooldown' };
  },

  /** Take a key out of the plugin's store (a test's stand-in may only set). */
  _forget(ctx, key) {
    if (typeof ctx.store.delete === 'function') ctx.store.delete(key);
    else ctx.store.set(key, null);
  },

  /**
   * One TV request, from reading it to the queue. Resolves to { outcome,
   * queued }: `queued` once its episodes are in the queue, or held for it
   * while a restart is recovered (_holdForRecovery), and `outcome` how it
   * ended - which is how _afterIntake knows whether to start the member's
   * clock (`queued`), whether the flood backstop counts it (NOT_COUNTED),
   * and whether to let them answer "which season?".
   *
   * A message asking for several seasons ("The Office seasons 1-3") is one
   * request per season (_runSeasons), and counts once against the cooldown.
   * `pass` is set when this request is the one answer to "which season?"
   * the cooldown lets through: it must turn out to be the same show.
   * `onQueued` is called as soon as any of its episodes are in the queue.
   * `insideCooldown` is the member's clock the cooldown let it through
   * inside of (_cooldownGate): each season it queues is an extra.
   */
  async _runRequest(msg, text, ctx, { route = null, pass = null, onQueued = null, insideCooldown = null } = {}) {
    const R = this._react(ctx);
    // Classified like the movie side. Without this every TV reaction was
    // `normal` and therefore shed at full utilisation - including "which
    // season?", whose absence deadlocks the request permanently, because the
    // bot then waits for an answer the requester was never asked for.
    //
    // A beta request whose group has since become a main group reacts no more
    // there: the reactions from deliverEpisode() can come hours later, and the
    // stored route is re-checked each time (safeRoute).
    //
    // The same reaction twice running is skipped: it changes nothing anyone
    // can see. A request is cancelled whole now, so its waiting episodes and
    // the one running would each have sent ❌. See sameTwiceSkipped.
    const react = this._sameTwiceSkipped((emoji) => {
      if (safeRoute(ctx.config, route)?.originIsMain) return Promise.resolve(false);
      return ctx.bot.react(msg, emoji, { kind: reactionKind(this._react(ctx), emoji) });
    });

    await react(R.researching);
    const parsed = parseTvRequest(text);
    // Nothing left for a show name: the request is not written as one
    // (_writtenWrong).
    if (!parsed.show) { await react(R.writtenWrong ?? R.notFound); return { outcome: 'unparsed' }; }
    // A season or episode code the parser could not read is left in the show
    // name ("so1eo1", "s1e", "8th season"): the request is written wrong, and
    // is answered ✍️ before anything is looked up - "the American so1eo1" was
    // matched to a show and queued (Hank, 2026-10-19), when the operator's rule
    // is that an improper request is told so.
    const leftover = R.writtenWrong ? codeLeftIn(parsed.show) : null;
    if (leftover) {
      ctx.log.info(`✍️ TV request written wrong: "${text}" - "${leftover}" is not a season or episode code the bot reads`);
      await react(R.writtenWrong);
      return { outcome: 'unparsed' };
    }
    // Strip the courtesy words before anything searches for them. The movie
    // path has always done this (omdb.js calls cleanRequestText); the TV path
    // never did, and it mattered far more here, because the show name goes
    // STRAIGHT to Jellyfin as a searchTerm and then to a 0.72 similarity
    // threshold. One trailing "please" scores "kitchen nightmares please"
    // against "Ramsay's Kitchen Nightmares" at 0.69 - a miss - where the bare
    // title scores 0.95.
    //
    // The year is put BACK afterwards. cleanRequestText strips four-digit years
    // along with the courtesy words, which quietly threw away the one thing
    // that can separate two shows sharing a name - and this path had just been
    // given a year tiebreaker, so stripping it here made that dead code.
    // "Crew girl 2026" was becoming "Crew girl" before anything could use the
    // 2026.
    //
    // A descriptor in brackets or after the name - "Rafa (TV series 2026)",
    // "Rafa the Netflix mini series" (Benji, 2026-10-21) - is dropped first: the
    // year used to be cut from inside the brackets and left "Rafa (TV series )",
    // which no title matches.
    const year = extractYear(parsed.show);
    const bare = stripSeriesDescriptor(parsed.show);
    let cleanedShow = cleanRequestText(bare) || bare || parsed.show;
    if (year && !extractYear(cleanedShow)) cleanedShow = `${cleanedShow} ${year}`;
    if (cleanedShow !== parsed.show) {
      ctx.log.debug(`TV: request noise stripped, "${parsed.show}" -> "${cleanedShow}"`);
      parsed.show = cleanedShow;
    }
    ctx.log.info(`📺 TV request: ${describeRequest(parsed)}`);

    const jf = ctx.config.library?.jellyfin ?? {};
    // Every step the lookup took, collected so a miss can say WHY rather than
    // just that it happened.
    const diagnostics = [];
    const opts = {
      base: String(jf.baseUrl ?? '').replace(/\/+$/, ''),
      token: jf.accessToken || jf.apiKey,
      userId: jf.userId,
      bestMatch,
      onDiagnostic: (m) => { diagnostics.push(m); ctx.log.warn(`TV lookup: ${m}`); },
    };
    if (!opts.base || !opts.token) {
      ctx.log.error('TV: Jellyfin is not configured');
      await react(R.failed);
      return { outcome: 'not-configured' };
    }

    if (parsed.seasons?.length > 1) return this._runSeasons(msg, text, parsed, ctx, { route, react, opts, diagnostics, pass, onQueued, insideCooldown });
    const out = await this._runSeason(msg, text, parsed, ctx, { route, react, opts, diagnostics, pass, onQueued, insideCooldown });
    // What the message named that its list could not take, once its member
    // has been told (_answerUnread), on the request's History row, whatever
    // became of the rest of it.
    if (parsed.unreadTold && (ctx.store.get('history', []) ?? []).some((h) => h?.id === msg.id)) {
      this._history(ctx, { id: msg.id, unread: parsed.unread.join(', ') });
    }
    return out;
  },

  /**
   * A message that asks for several seasons: each is its own request, as it
   * would be asked for alone - its own place in line, History row,
   * notifications and gates (rating, duplicate, queue room). "The Office S01
   * S02", "season 1 and 2" and "S01-S03" used to queue season 1 alone, and
   * "The Office seasons 1-3" nothing at all.
   *
   * What the message's one reaction shows across them is shared-message.js's
   * rule. The show is looked up once for all of them, and what could not be
   * added is answered together, in one reply and a line for each reason:
   * asked for "seasons 1-20" of a show with five, fifteen replies would be
   * noise.
   *
   * The message counts once against the cooldown, so it is held to limits
   * of its own: at most tvRequests.maxSeasonsPerRequest seasons are looked
   * at, and maxEpisodesPerRequest is for all of them together. Without them
   * (found in review, 2026-09-29), one message, "seasons 1-30", took thirty
   * places in a queue of fifty and sent thirty "added" lines, and with
   * maxEpisodesPerRequest at two still queued sixty episodes. The seasons
   * past either limit are named in the reply, to be asked for again.
   */
  async _runSeasons(msg, text, parsed, ctx, { route, react, opts, diagnostics, pass = null, onQueued = null, insideCooldown = null }) {
    const cfg = ctx.config.tvRequests ?? {};
    const R = this._react(ctx);
    let probe;
    try {
      probe = await resolveEpisodes({ show: parsed.show, season: null, episode: null }, opts);
    } catch (err) {
      ctx.log.error(`TV lookup failed for "${text}": ${err.message}`);
      await react(R.failed);
      return { outcome: 'error' };
    }
    if (pass && !this._passFits(probe.series, pass)) return this._passRefused(ctx, msg, pass);
    // No such show. A show found with nothing in any of its seasons comes
    // back 'not-found' too, and is answered below like any season it lacks.
    if (probe.error === 'not-found' && !probe.series) {
      await this._notInLibrary(ctx, { msg, text, parsed, found: probe, route, react, diagnostics });
      return { outcome: 'missing' };
    }
    const series = probe.series;
    const held = new Set(probe.seasons ?? []);
    const name = series?.name ?? parsed.show;

    const share = shareMessage({
      send: react,
      R: this._shareR(R),
      onHandover: (key) => this._placeOnHandover(ctx, key),
      onEnded: (key, ending) => this._journalSharedEnding(ctx, msg.id, ending),
    });
    const maxSeasons = Number(cfg.maxSeasonsPerRequest ?? 0);
    const maxEpisodes = Number(cfg.maxEpisodesPerRequest ?? 0);
    const batch = {
      share, missing: [], full: [], dups: [], failed: [], over: [], refused: [], said: new Set(), tests: [],
      // The seasons the member had asked for already and was waiting for:
      // their own request sent again, not a duplicate (_resentTv) - and of
      // those, the ones they had sent again before (`again`).
      resent: [],
      again: [],
      // What maxEpisodesPerRequest leaves the rest of the message, shared by
      // every season's _runSeason (which spends it).
      left: { episodes: maxEpisodes > 0 ? maxEpisodes : Infinity },
      // The seasons it cut part-way, { season, cut, ask }: named in the
      // message's one reply with the next part to ask for (_answerSeasons).
      cut: [],
      // The AI check's budget, for the message as a whole: at most
      // LIMITS.maxChecks and LIMITS.budgetMs, and no season asks again after
      // a check that could not run (override-check.js). Each season used to
      // start afresh, so "The Boys seasons 1-3" with Gemini out of quota made
      // one failing call per season, and three seasons could make 90 checks.
      ai: {},
    };
    let overWhy = null;
    // Written down before the first lookup, so a restart part-way through the
    // seasons still answers the ones never reached (_recoverSeasonBatches).
    const note = this._noteSeasonBatch(ctx, { msg, route, show: name, text, seasons: parsed.seasons });
    try {
      const first = parsed.seasons.find((s) => held.has(s));
      let looked = 0;
      let down = false;
      for (const season of parsed.seasons) {
        if (!held.has(season)) { batch.missing.push(season); continue; }
        if (maxSeasons > 0 && looked >= maxSeasons) { overWhy ??= 'seasons'; batch.over.push(season); continue; }
        if (batch.left.episodes <= 0) { overWhy ??= 'episodes'; batch.over.push(season); continue; }
        looked += 1;
        // The library could not be reached: the seasons after it would only
        // wait out the same timeout, one by one.
        if (down) { batch.failed.push(season); continue; }
        // Each season says something in the groups - its "added" line, a
        // duplicate's, a refusal - so the seasons are paced like any other
        // bulk work (CLAUDE.md rule 1), not answered in one burst.
        if (season !== first) await ctx.bot._bulkPace?.();
        const voice = share.voice();
        const out = await this._runSeason(msg, text, { ...parsed, season, seasons: undefined }, ctx, {
          route, react: voice.react, opts, diagnostics, onQueued, insideCooldown,
          batch: {
            ...batch, voice, knownSeries: series,
            // The first season looked up keeps the message's id for its row, as
            // a request on its own does: History, the hourly check and the
            // incident scan find a request's row by its message.
            rowId: season === first ? msg.id : `${msg.id}:s${season}`,
            // What a Re-run of the row queues: that season on its own, not all
            // of them again. The member's words are kept beside it as `typed`,
            // as the film side does.
            request: `${parsed.show} season ${season}`,
            typed: text,
          },
        });
        if (['queued', 'duplicate', 'resent', 'resent-again', 'test-passed'].includes(out?.outcome)) note.decided(season);
        if (out?.outcome === 'error') { batch.failed.push(season); down = true; }
      }

      await this._answerSeasons(ctx, { msg, text, parsed, route, react, diagnostics, series, held, name, batch, overWhy, maxSeasons, maxEpisodes });
    } finally {
      note.done();
    }

    // Nothing of it queued, but some of it already waiting: the message
    // follows the request that holds the first such season - its place in
    // line and its outcome - as a duplicate asked for on its own does. Not
    // when anything was queued: that season speaks for the message, and a
    // second request's number on it would fight it.
    //
    // When that request is the member's own, sent again (_resentTv), the
    // message got no 🤥 for it, and shows what their own message would:
    // 🎬 and its place, or the stage it is at (_showResend).
    if (!share.anyQueued() && batch.dups.length) {
      const holder = (ctx.store.get('pending', []) ?? []).find((r) => r.reqKey === batch.dups[0]);
      if (holder) {
        const own = batch.resent.includes(holder.reqKey);
        this._addTvFollowers(ctx, holder, [{
          msgId: msg.id, msgKey: msg.key ?? null, chatJid: msg.chatJid, historyId: null, route: route ?? null,
          ...(own ? { resend: true } : {}),
        }]);
        if (own) await this._showResend(ctx, { holder, msg, route, react });
        else this._followPlace(ctx, holder.reqKey, msg, route);
      }
    }
    const queued = share.anyQueued();
    // Every season it asked for was the member's own request, sent again:
    // nothing to hold against them the first time (NOT_COUNTED).
    const resent = !queued && batch.resent.length > 0 && batch.resent.length === parsed.seasons.length;
    const outcome = queued ? 'queued' : !resent ? 'answered' : batch.again.length ? 'resent-again' : 'resent';
    return { outcome, queued };
  },

  /** The outcomes shareMessage() ends a message on, from the reaction set. */
  _shareR(R) {
    return {
      failed: R.failed ?? '⚠️', done: R.done ?? '✅', cancelled: R.cancelled ?? '❌',
      skipped: R.skipped ?? '⏭️', rated: R.rated ?? '⛔', notInLibrary: R.notInLibrary ?? '📬',
    };
  },

  /**
   * What a message asking for several seasons is told about the seasons it
   * asked for and did not get: one line in the notifications group for each
   * reason, and one quoted reply to the member.
   *
   * Once one of its seasons is queued, that season speaks for the message
   * (shared-message.js), and a later season's ⛔ or ⚠️ never reached it. In a
   * review's harness (2026-09-29), "The Boys S01 S02" with season 2 refused
   * on its rating, or turned away by a full queue, showed 🔍 🎬 1️⃣, then ✅,
   * and at most a line in the notifications group said season 2 was not
   * coming. Now each season that was not added counts in how the
   * message ends (share.refused), so it never ends on ✅, and the reply names
   * it. The reply goes out whenever something was queued, since the reaction
   * cannot say it then; with nothing queued the message's own reaction does,
   * as for a request on its own, and the reply only where replies on
   * blocking are on. The seasons the server lacks are named in it always, as
   * they always were. A rating is named only where the rating notice is on
   * (tv-rating-notice, withheld.js); otherwise the season "can't be posted".
   */
  async _answerSeasons(ctx, { msg, text, parsed, route, react, diagnostics, series, held, name, batch, overWhy, maxSeasons, maxEpisodes }) {
    const R = this._react(ctx);
    const { share } = batch;
    const queued = share.anyQueued();
    // Seasons of a test that passed (_testPassedTv): nothing was queued, and
    // they are answered here, in the message's one reply, as queued seasons
    // would speak for it.
    const tested = batch.tests?.length ? batch.tests : null;
    const say = ratingNoticeOn(ctx.config, featureGroup(msg));
    const seasonsOf = (list) => `season${list.length > 1 ? 's' : ''} ${seasonSpans(list)}`;
    const Seasons = (list) => { const t = seasonsOf(list); return t[0].toUpperCase() + t.slice(1); };
    const were = (list) => (list.length > 1 ? "weren't" : "wasn't");
    const them = (list) => (list.length > 1 ? 'them' : 'it');
    const words = [];                                     // the reply, a line each
    const tellAll = queued || !!tested || !!ctx.config.movieRequests?.replyOnBlock;
    if (tested) words.push(this._testPassedWords(route, tested));
    // A season maxEpisodesPerRequest cut part-way - the message's share of
    // it ran out inside the season - says which of its episodes went in and
    // what to send for the next part, as a season asked for on its own does
    // (_runSeason). Its "added" line in the notifications group says it was
    // cut; this is the member's line, and it was nowhere before 2026-10-12
    // (cap-cut.js). Only a season that was queued, or a test's that would
    // have been, is cut, so it is always said. The words about its episodes
    // withheld on rating go after it, where those would have had a reply of
    // their own (`notes`, _runSeason), as a season asked for alone folds them
    // into its one reply: "Arrow seasons 1-2" with S01E05 TV-MA said nothing
    // of episode 5 in the request group once season 1 was cut (found in
    // review, 2026-10-12).
    for (const { season, cut, ask, notes = [] } of batch.cut ?? []) {
      words.push(cutReply(cut, { lead: `Season ${season}`, ask, lines: false }) + (notes.length ? ` ${notes.join(' ')}` : ''));
    }

    if (batch.missing.length) {
      const onServer = [...held].sort((a, b) => a - b);
      const detail = `"${name}" has no ${seasonsOf(batch.missing)}`;
      ctx.log.info(`📭 TV not in library: ${detail}${onServer.length ? ` (has season(s) ${onServer.join(', ')})` : ''}`);
      // One entry for the message, under its first missing season: the list
      // is a fault log, and "seasons 1-99" must not push out real misses. Not
      // for a test, which leaves the operator's lists alone (beta.js).
      if (!isTestRoute(route)) {
        recordMiss(ctx.store, {
          kind: 'tv', reason: 'empty-season', request: text, title: name, year: series?.year ?? null,
          season: Math.min(...batch.missing), episode: null,
          requester: msg.pushName ?? msg.senderNumberDisplay ?? null, groupJid: msg.chatJid,
          searched: [parsed.show, text].filter(Boolean), diagnostics, detail,
        });
      }
      if (!queued && !tested) await react(R.notInLibrary);
      if (onServer.length) {
        words.push(`📭 *${name}* — we don't have ${seasonsOf(batch.missing)}.`
          + `\nOn the server: season${onServer.length > 1 ? 's' : ''} ${onServer.join(', ')}.`);
      }
      this._notify(ctx, `📭 ${name} — ${detail}`, msg, { route, refusal: true });
    }
    if (batch.over.length) {
      const limit = overWhy === 'episodes'
        ? `one request is at most ${maxEpisodes} episode${maxEpisodes === 1 ? '' : 's'}`
        : `one request is at most ${maxSeasons} season${maxSeasons === 1 ? '' : 's'}`;
      ctx.log.info(`📺 ${name} ${seasonsOf(batch.over)} not added: ${limit}`);
      if (tellAll) words.push(`⚠️ ${Seasons(batch.over)} ${were(batch.over)} added — ${limit}. Ask for ${them(batch.over)} again later.`);
      this._notify(ctx, `⚠️ ${name} ${seasonsOf(batch.over)} ${were(batch.over)} added — ${limit}; `
        + `ask for ${them(batch.over)} again later.`, msg, { route });
    }
    if (batch.full.length) {
      if (tellAll) words.push(`⚠️ ${Seasons(batch.full)} ${were(batch.full)} added — the queue is full. Ask again once it clears.`);
      this._notify(ctx,
        `⚠️ ${name} ${seasonsOf(batch.full)} — the queue is full right now. `
        + `${batch.full.length > 1 ? "They weren't" : "It wasn't"} added; please ask again once it clears.`, msg, { route });
    }
    if (batch.failed.length) {
      if (tellAll) words.push(`⚠️ ${Seasons(batch.failed)} ${were(batch.failed)} added — the library couldn't be reached. Ask again later.`);
      this._notify(ctx,
        `⚠️ ${name} ${seasonsOf(batch.failed)} — the library couldn't be reached just now, so `
        + `${batch.failed.length > 1 ? "they weren't" : "it wasn't"} added. Please ask again later.`, msg, { route });
    }
    // Refused on rating with nothing queued, each season said what a request
    // on its own says (_refuseOnRating); only once something was queued is
    // there anything more to say.
    if (batch.refused.length && (queued || tested)) {
      const list = batch.refused.map((r) => r.season);
      const ratings = [...new Set(batch.refused.map((r) => r.rated).filter(Boolean))];
      words.push(say && ratings.length
        ? `⛔ ${Seasons(list)} — rated ${ratings.join(' and ')}, can't be posted.`
        : `⛔ ${Seasons(list)} can't be posted.`);
      // With the notice on, each refused season has said its own line.
      if (!say) this._notify(ctx, `⛔ ${name} ${seasonsOf(list)} — can't be posted`, msg, { route, step: 'blocked', refusal: true });
    }

    if (queued) {
      share.refused(
        batch.refused.length ? (R.rated ?? '⛔') : null,
        batch.missing.length ? (R.notInLibrary ?? '📬') : null,
        batch.over.length || batch.full.length || batch.failed.length ? (R.failed ?? '⚠️') : null,
      );
    }
    // A test ends on what a real message would once its seasons were done
    // (shared-message.js's order): ⚠️, ⛔ or 📬 for a season that could not
    // be added, and ✅ when every season asked for passed.
    if (tested) {
      await react(batch.over.length || batch.full.length || batch.failed.length ? (R.failed ?? '⚠️')
        : batch.refused.length ? (R.rated ?? '⛔')
          : batch.missing.length ? (R.notInLibrary ?? '📬')
            : (R.done ?? '✅'));
    }
    if (words.length) {
      try {
        // A test's answer is paragraphs (_testPassedWords), so the lines
        // about the other seasons follow it as a paragraph of their own.
        const body = tested && words.length > 1
          ? `${words[0]}\n\n${words.slice(1).join('\n')}` : words.join('\n');
        await ctx.bot.sendText(msg.chatJid, body, { quoted: msg });
      } catch (err) { ctx.log.warn(`could not say which seasons were not added: ${err.message}`); }
    }
  },

  /**
   * A note of the seasons of one message still to be decided, kept in the
   * store while _runSeasons works through them, and cleared when it has.
   *
   * The seasons are looked up one at a time, paced, so "Friends S1-S10" takes
   * the better part of a minute - and the hourly check restarts the bot into
   * its fixes. A restart twenty seconds in would leave seasons 1 to 4
   * journalled and 5 to 10 nowhere at all: no journal entry, no History row,
   * no reply, and the message, rebuilt from the journal, ending ✅ once season
   * 4 was done (found in review, 2026-09-29). A season comes off the note once it is
   * queued or found waiting already; one refused or turned away stays on it
   * until the message has been answered, since that answer comes last.
   */
  _noteSeasonBatch(ctx, { msg, route, show, text, seasons }) {
    const id = msg.id;
    const write = (fn) => {
      try { ctx.store.set('seasonBatches', fn(ctx.store.get('seasonBatches', []) ?? [])); }
      catch (err) { ctx.log.debug(`could not note the seasons being worked through: ${err.message}`); }
    };
    write((all) => [...all.filter((n) => n.msgId !== id), {
      msgId: id, msgKey: msg.key ?? null, chatJid: msg.chatJid, route: route ?? null,
      show, text, seasons: [...seasons], at: Date.now(),
      requester: msg.pushName ?? null, requesterJid: msg.senderJid ?? null,
      requesterNumber: msg.senderNumber ?? null, requesterNumberDisplay: msg.senderNumberDisplay ?? null,
    }]);
    return {
      decided: (season) => write((all) => all.map((n) => (n.msgId === id
        ? { ...n, seasons: (n.seasons ?? []).filter((x) => x !== season) } : n))),
      done: () => write((all) => all.filter((n) => n.msgId !== id)),
    };
  },

  /**
   * Answer the messages a restart caught part-way through their seasons
   * (_noteSeasonBatch): the seasons never decided are named in one reply in
   * the request group and a line in the notifications group, to be asked for
   * again, with a History row, and the message ends on ⚠️ - on the ending
   * journalled with its queued seasons, or at once when none was queued. A
   * season the journal holds for the message was queued just before the
   * restart, and is resumed as usual rather than named here.
   */
  async _recoverSeasonBatches(ctx, ids) {
    const all = ctx.store.get('seasonBatches', []) ?? [];
    const notes = all.filter((n) => ids.has(n.msgId));
    if (!notes.length) return;
    // Cleared before anything is said, so a note is answered once, not at
    // every start that fails part-way through answering it.
    ctx.store.set('seasonBatches', all.filter((n) => !ids.has(n.msgId)));
    const R = this._react(ctx);
    const failed = R.failed ?? '⚠️';
    let spoken = false;
    for (const note of notes) {
      const mine = (ctx.store.get('pending', []) ?? []).filter((r) => r?.shared?.id === note.msgId);
      const journalled = new Set(mine.map((r) => r.baseRow?.season).filter((n) => n != null));
      const lost = (note.seasons ?? []).filter((n) => !journalled.has(n));
      if (!lost.length) continue;
      const list = `season${lost.length > 1 ? 's' : ''} ${seasonSpans(lost)}`;
      ctx.log.warn(`📺 ${note.show} ${list} of "${note.text}" were never added - the bot restarted part-way through them`);
      this._history(ctx, {
        id: `${note.msgId}:restart`, kind: 'tv', at: Date.now(), requestedAt: note.at ?? Date.now(),
        requester: note.requester ?? null, requesterJid: note.requesterJid ?? null,
        requesterNumber: note.requesterNumber ?? null, requesterNumberDisplay: note.requesterNumberDisplay ?? null,
        groupJid: note.chatJid,
        // What a Re-run queues: the seasons lost, which requeue() reads.
        request: `${note.show} season${lost.length > 1 ? 's' : ''} ${lost.join(', ')}`,
        typed: note.text, title: note.show, season: lost[0], episodes: 0, status: 'failed',
        detail: `${list} not added — the bot restarted part-way through the request`,
        ...(note.route ? { beta: true } : {}),
      });
      if (mine.length) this._journalSharedEnding(ctx, note.msgId, failed);
      // Nothing more is said in a group a beta test has since become a main
      // one of (safeRoute, as everywhere a stored route is used).
      if (safeRoute(ctx.config, note.route)?.originIsMain) continue;
      // One message after another, paced like any bulk work (CLAUDE.md rule 1).
      if (spoken) await ctx.bot._bulkPace?.();
      spoken = true;
      const msg = { id: note.msgId, key: note.msgKey, chatJid: note.chatJid };
      if (!mine.length && note.msgKey) {
        try { await ctx.bot.react(msg, failed, { kind: reactionKind(R, failed) }); }
        catch (err) { ctx.log.debug(`could not mark the request: ${err.message}`); }
      }
      const were = lost.length > 1 ? "weren't" : "wasn't";
      const them = lost.length > 1 ? 'them' : 'it';
      try {
        await ctx.bot.sendText(note.chatJid,
          `⚠️ *${note.show}* — ${list} ${were} added: the bot restarted part-way through the request. `
          + `Please ask for ${them} again.`, { quoted: msg });
      } catch (err) { ctx.log.warn(`could not say which seasons a restart lost: ${err.message}`); }
      this._notify(ctx, `⚠️ ${note.show} ${list} — ${were} added: the bot restarted part-way through the request; `
        + `ask for ${them} again.`, msg, { route: note.route ?? null });
    }
  },

  /**
   * The three ways a TV request ends at "not in the library".
   *
   * These used to be three silent `return`s: same emoji, no reply, no log
   * line, no history row, nothing written anywhere. A requester saw 📬 and
   * an operator saw nothing at all, so a wrong answer here was invisible
   * until somebody happened to complain. Now each one says which of the
   * three it was, tells the requester what the server does have, and is
   * recorded where it can be read back.
   */
  async _notInLibrary(ctx, { msg, text, parsed, found, route, react, diagnostics }) {
    const R = this._react(ctx);
    // No show by that name, and the name still holds a code the parser could
    // not read: the request is written wrong, and is answered so (✍️), not
    // "not in the library" - which sent Jake Brown and Head Admin looking for
    // whether Georgie & Mandy's First Marriage S01E11-E20 existed, when he had
    // typed "SO1E11-E20" (2026-10-18). The operator, 2026-10-19: "when someone
    // makes an improper request bot should react with a new emoji for
    // "request not written properly"". Not a gap in the library, so it is not
    // put on the not-in-library list either.
    const wrong = found.error === 'not-found' ? codeLeftIn(parsed.show) : null;
    if (wrong && R.writtenWrong) {
      ctx.log.info(`✍️ TV request written wrong: "${text}" - "${wrong}" is not a season or episode code the bot reads, `
        + `and no show is called "${parsed.show}"`);
      await react(R.writtenWrong);
      return;
    }
    const seasons = (found.seasons ?? []).filter((s) => s != null);
    const shownName = found.series?.name ?? parsed.show;
    const range = parsed.episodeRange;
    const list = parsed.episodeList?.length ? parsed.episodeList : null;
    const asked = range ? rangeCode(found.season, range.from, range.to)
      : list ? listCode(found.season, list) : `S${pad(found.season)}E${pad(parsed.episode)}`;

    const detail = found.error === 'not-found'
      ? `no series matching "${parsed.show}"`
      : found.error === 'empty-season'
        ? `"${shownName}" has no season ${found.season}`
        : range
          ? `"${shownName}" S${pad(found.season)} has no episodes ${range.from}–${range.to}`
          : list
            ? `"${shownName}" S${pad(found.season)} has no episodes ${seasonSpans(list)}`
            : `"${shownName}" S${pad(found.season)} has no episode ${parsed.episode}`;

    ctx.log.info(`📭 TV not in library: ${detail}`
      + (seasons.length ? ` (has season(s) ${seasons.join(', ')})` : ''));

    // A test is answered 📬 like any request, and adds nothing to the
    // operator's not-in-library list (beta.js).
    if (!isTestRoute(route)) recordMiss(ctx.store, {
      kind: 'tv',
      reason: found.error === 'not-found' ? 'not-in-library' : found.error,
      request: text,
      title: shownName,
      year: found.series?.year ?? null,
      season: found.error === 'not-found' ? parsed.season : found.season,
      episode: parsed.episode,
      requester: msg.pushName ?? msg.senderNumberDisplay ?? null,
      groupJid: msg.chatJid,
      searched: [parsed.show, text].filter(Boolean),
      diagnostics,
      detail,
    });

    await react(R.notInLibrary);

    // A season or episode we simply do not have is worth saying out loud -
    // the requester can ask for one we do. A show we cannot find at all is
    // left to the reaction, as it always has been, because guessing at what
    // they meant in the group is noise.
    if (found.error !== 'not-found' && seasons.length) {
      try {
        await ctx.bot.sendText(msg.chatJid,
          `📭 *${shownName}* — we don't have `
          + (found.error === 'empty-season' ? `season ${found.season}.` : `${asked}.`)
          + `\nOn the server: season${seasons.length > 1 ? 's' : ''} ${seasons.join(', ')}.`,
          { quoted: msg });
      } catch (err) { ctx.log.debug(`could not say which seasons exist: ${err.message}`); }
    }
    this._notify(ctx, `📭 ${shownName} — ${detail}`, msg, { route, refusal: true });
  },

  /**
   * The episodes of a list ("The Boys S01E06, E30") the season does not
   * have, when it has the rest. Each was named, so each is answered, as a
   * list the season has none of is (_notInLibrary): a quoted reply, which
   * says what the season does have, and a line in the notifications group.
   * The rest of the list goes on as any request does. A range is still the
   * span the server holds, as it always was: "S01E01-E20" of a ten-episode
   * season is the rest of the season, not ten misses. Nothing goes on the
   * not-in-library list, which is for requests refused for not being found;
   * this one was not.
   */
  async _answerMissing(ctx, { msg, found, route }) {
    const name = found.series?.name ?? '';
    const { missing } = found;
    const held = found.episodesInSeason ?? [];
    const detail = `"${name}" S${pad(found.season)} has no episode${missing.length > 1 ? 's' : ''} ${seasonSpans(missing)}`;
    ctx.log.info(`📭 TV not in library: ${detail} - the rest of the list goes on`);
    try {
      await ctx.bot.sendText(msg.chatJid,
        `📭 *${name}* — we don't have ${listCode(found.season, missing)}.`
        + (held.length ? `\nSeason ${found.season} on the server: episode${held.length > 1 ? 's' : ''} ${seasonSpans(held)}.` : ''),
        { quoted: msg });
    } catch (err) { ctx.log.debug(`could not say which episodes are missing: ${err.message}`); }
    this._notify(ctx, `📭 ${name} — ${detail}`, msg, { route, refusal: true });
  },

  /**
   * The episodes a request named that its list could not take with the rest
   * (parse.js `unread`): another season's ("Outer Banks S05E06, S06E01" -
   * one request is one season), or the far end of a run typed backwards
   * ("S01E07-E04, E09"), and what followed it. They were left out without a
   * word (found in review, 2026-10-12), so the member never knew to ask
   * again. Answered as the episodes a season lacks are (_answerMissing), in
   * a quoted reply and a line in the notifications group, before anything
   * else is decided about the rest, which goes on as any request does. The
   * History row keeps them too (_runRequest).
   */
  async _answerUnread(ctx, { msg, found, parsed, route }) {
    const name = found.series?.name ?? parsed.show;
    const codes = parsed.unread.join(', ');
    const many = parsed.unread.length > 1 || codes.includes('–');
    const why = 'one request is one season, its episodes in order';
    ctx.log.info(`📺 ${name}: ${codes} of "${parsed.raw}" could not be read with the rest - the member is told to ask on its own`);
    try {
      await ctx.bot.sendText(msg.chatJid,
        `⚠️ *${name}* — ${codes} ${many ? "weren't" : "wasn't"} added: ${why}. `
        + `Please ask for ${many ? 'them on their' : 'it on its'} own.`,
        { quoted: msg });
    } catch (err) { ctx.log.debug(`could not say which episodes were not read: ${err.message}`); }
    this._notify(ctx, `⚠️ ${name} — ${codes} not added: ${why}`, msg, { route });
    parsed.unreadTold = true;
  },

  /**
   * One season (or one episode, or a run or a list of episodes) of a
   * request, from the library lookup to the queue. Resolves to { outcome,
   * queued }.
   *
   * `batch` is set when the message asked for several seasons (_runSeasons):
   * the History row's id and `request` are this season's, the message's
   * reaction is shared (`react` is this season's voice), and what would be
   * said once per message - the seasons the server lacks, a full queue, a
   * series refused on its rating - is gathered there instead of said here.
   */
  async _runSeason(msg, text, parsed, ctx, { route = null, react, opts, diagnostics, batch = null, pass = null, onQueued = null, insideCooldown = null }) {
    const cfg = ctx.config.tvRequests;
    const R = this._react(ctx);
    // What the History row says was asked for: the season on its own for one
    // of several (a Re-run queues that season only), with the member's words
    // beside it; otherwise what they typed, as always.
    const rowText = batch?.request ?? text;
    const rowId = () => batch?.rowId ?? msg.id ?? `tv-${Date.now()}`;
    const typed = batch ? { typed: batch.typed } : {};
    // A request from a beta group is a test: checked like any other, and never
    // queued (beta.js). What is waiting is read from the REAL queue for it,
    // since nothing a test asks for is ever there: "asked for twice"
    // (beta005) is tried with episodes that are genuinely waiting.
    const testing = isTestRoute(route);
    const waitingFor = testing ? null : route;

    let found;
    try {
      found = await resolveEpisodes(parsed, batch?.knownSeries ? { ...opts, knownSeries: batch.knownSeries } : opts);
    } catch (err) {
      ctx.log.error(`TV lookup failed for "${text}": ${err.message}`);
      await react(R.failed);
      return { outcome: 'error' };
    }
    if (pass && !this._passFits(found.series, pass)) return this._passRefused(ctx, msg, pass);

    if (found.error === 'empty-season' && batch) {
      batch.missing.push(parsed.season);
      return { outcome: 'missing' };
    }
    if (found.error === 'not-found' || found.error === 'no-such-episode' || found.error === 'empty-season') {
      await this._notInLibrary(ctx, { msg, text, parsed, found, route, react, diagnostics });
      return { outcome: 'missing' };
    }
    if (found.error === 'need-season') {
      // Never dump a whole series into the group - ask which season. The reply
      // goes into the REQUEST GROUP: sending it only to the notifications
      // group left the requester staring at a reaction they could not decode.
      await react(R.needSeason ?? R.needYear);
      const seasons = (found.seasons ?? []).join(', ');
      const name = found.series?.name ?? parsed.show;
      ctx.log.info(`TV: "${parsed.show}" needs a season (available: ${seasons || 'unknown'})`);
      // The example keeps what was asked for, with a season added. It was
      // always "<show> season 1", so "The Office episodes 3-6" was answered
      // with an example that, copied, queued all of season 1 - about 22
      // episodes for the 4 wanted, a place in line and the member's
      // cooldown spent on it (found in review, 2026-09-29).
      const first = found.seasons?.[0] ?? 1;
      const r = parsed.episodeRange;
      // A list keeps its episodes, "The Office S01E03, E05", so the example
      // asks for those two and not the run between them.
      const l = parsed.episodeList?.length ? parsed.episodeList : null;
      const example = r ? `${name} S${pad(first)}E${pad(r.from)}-E${pad(r.to)}`
        : l ? `${name} ${listCode(first, l)}`
          : parsed.episode != null ? `${name} S${pad(first)}E${pad(parsed.episode)}`
            : `${name} season ${first}`;
      // A test's example carries its code (suggestPrefix): copied without
      // one, the beta group would ignore it.
      const ask = `📺 *${name}* — which season?` +
        (seasons ? `\nAvailable: ${seasons}` : '') +
        `\n\nSend e.g. *${suggestPrefix(route, cfg.prefix ?? '#request')} ${example}*`;
      try { if (msg) await ctx.bot.sendText(msg.chatJid, ask, { quoted: msg }); }
      catch (err) { ctx.log.debug(`could not ask for the season: ${err.message}`); }
      this._notify(ctx, `📺 ${name} — asked which season`, msg, { route });
      // The show, so the member's answer can be let through the cooldown
      // once, and only for this show (_cooldownGate).
      return { outcome: 'need-season', series: found.series?.id ?? null, name: found.series?.name ?? null };
    }
    // The episodes of a list the season does not have, said before anything
    // else is decided about the rest (_answerMissing).
    if (found.missing?.length) await this._answerMissing(ctx, { msg, found, route });
    // And the episodes the message named that the list could not take (_answerUnread).
    if (parsed.unread?.length) await this._answerUnread(ctx, { msg, found, parsed, route });
    // "season 2", or the codes of a run or a list of episodes (scopeOf).
    const scope = scopeOf(found, parsed);

    // Rating gate, mirroring the movie rules.
    const blocked = (cfg.blockedRatings ?? []).map((r) => String(r).toUpperCase());
    // What the requester is told about this gate is group-facing text, so it
    // sits behind a beta flag (withheld.js), asked here with the chat the
    // request came from. History records what was withheld in every mode.
    const say = ratingNoticeOn(ctx.config, featureGroup(msg));
    const rating = String(found.series?.rating ?? '').toUpperCase();
    const seriesBlocked = !!rating && blocked.includes(rating);
    // What is waiting already for this destination (the duplicate check
    // below), read BEFORE the screening, so the AI check is only asked about
    // episodes this request would really queue: an episode an earlier
    // request holds in the queue was checked for that request, and is not
    // asked about, or queued, again.
    const waiting = this._waitingEpisodeIds(ctx, waitingFor);
    // The rating-blocked episodes (override-check.js): those the bypass list
    // covers are sent with no AI check, and the rest are put to the AI check
    // where it could clear them, and sent on a sure "no nudity" - the
    // operator's rule of 2026-09-29, "No, AI only helps". Null when there is
    // nothing to decide, and then everything below runs exactly as it did
    // before. Told how many episodes this request could queue at all, so it
    // does not spend checks on episodes that would be cut anyway: up to
    // maxEpisodesPerRequest when the queue has a place for the request (one
    // place, however many episodes), and none when it has not - the
    // queue-full answer below then goes out, not a rating refusal. The room
    // is measured again below, since the checks take seconds and the queue
    // can fill meanwhile.
    //
    // One of several seasons may queue only what the message has left of
    // maxEpisodesPerRequest (_runSeasons), which is for all of them.
    const cap = batch && Number.isFinite(batch.left?.episodes)
      ? batch.left.episodes
      : Number(cfg.maxEpisodesPerRequest ?? 0);
    // A test takes no place in the queue, so a full one limits nothing.
    const screen = await this._screenRated(ctx, {
      found, blocked, seriesRating: seriesBlocked ? rating : null, waiting,
      limit: () => (testing || this._hasRoom(ctx) ? (cap > 0 ? cap : Infinity) : 0),
      budget: batch?.ai ?? null,
    });
    let screened = describeScreen(screen, screen?.allowed ?? []);
    // A series its rating blocks, with nothing the list or the check sent,
    // is refused as the series it always was - with what the check made of
    // it on the History row.
    if (seriesBlocked && (!screen || (!screen.allowed.length && !screen.unreached.length))) {
      ctx.log.info(`TV: blocked ${found.series.name} — rated ${rating}${screened ? ` — ${screened.detail}` : ''}`);
      const show = `${found.series.name}${found.series.year ? ` (${found.series.year})` : ''}`;
      // Every season of a message asking for several is refused for the same
      // reason: said once, and recorded for each.
      const quiet = !!batch?.said.has('series-rated');
      batch?.said.add('series-rated');
      batch?.refused.push({ season: found.season, rated: rating });
      await this._refuseOnRating(ctx, {
        msg, text: rowText, found, route, react, say, quiet, rowId: rowId(), typed: batch?.typed,
        rated: rating,
        detail: `rated ${rating}${withheldSuffix(screened?.detail)}`,
        override: screened?.detail ?? null,
        line: `⛔ ${show} — rated ${rating}, can't be posted`,
        reply: `${show} is rated ${rating}.`,
      });
      return { outcome: 'refused' };
    }

    // An individual episode can carry a harder rating than its series, so
    // filter per-episode too rather than trusting the series rating alone.
    const tooStrong = screen ? screen.withheldOnRating : found.episodes.filter((e) => {
      const r = String(e.rating ?? '').toUpperCase();
      return r && blocked.includes(r);
    });
    // With a screen, `allowed` also holds the episodes the check would be
    // asked about that are waiting already: they are in the queue, so the
    // duplicate check below counts them as waiting, never as withheld and
    // never as new.
    const allowed = screen ? screen.allowed : found.episodes.filter((e) => !tooStrong.includes(e));
    const withheld = describeWithheld(withheldFrom(tooStrong, allowed));
    if (withheld) {
      ctx.log.info(`TV: withheld ${withheld.count} of ${found.episodes.length} episode(s) of `
        + `${found.series.name} ${scope} on rating — ${withheld.detail}`);
    }
    if (screened) {
      ctx.log.info(`TV: bypass list and AI check on ${found.series.name} ${scope} — ${screened.detail}`);
    }
    // Episodes the check never reached are not refused: they could not be
    // queued this time whatever it said, and the queue-full answer below
    // says so and asks again later.
    const unreached = screen?.unreached?.length ?? 0;
    if (!allowed.length && !unreached) {
      // Everything asked for is withheld - most often one episode asked for
      // on its own, as S01E14 was, twice, after the season had left it out.
      // Counted in episodes, not library items: two TV-MA files of S01E14 are
      // still "S01E14", not a season.
      const one = withheld.count === 1 && isSingleEpisode(parsed);
      const code = one ? `S${pad(tooStrong[0].season ?? found.season)}E${pad(tooStrong[0].episode)}` : null;
      const what = one ? `${found.series.name} ${code}` : `${found.series.name} ${scope}`;
      const rated = withheld.ratings.join(' and ');
      const which = withheld.clauses.replace(/^E/, 'e');
      batch?.refused.push({ season: found.season, rated });
      // What the AI check made of them goes on the row, not to the group:
      // they are refused on their rating, in the words they always had.
      await this._refuseOnRating(ctx, {
        msg, text: rowText, found, route, react, say, withheld, rated, rowId: rowId(), typed: batch?.typed,
        detail: (one ? `${code} rated ${rated}` : `${scope} — all ${withheld.detail}`)
          + withheldSuffix(screened?.detail),
        override: screened?.detail ?? null,
        line: `⛔ ${what} — ${one ? `rated ${rated}` : which}, can't be posted`,
        reply: one ? `${what} is rated ${rated}.` : `${what}: ${which}.`,
      });
      return { outcome: 'refused' };
    }

    // Nothing is queued twice for the same destination. "Loki season 1" was
    // queued at 15:31 UTC on 2026-09-28 and again, by the same member, at
    // 19:06 while its six episodes were still waiting; "the mentalist S03E05"
    // at 16:02 and again at 16:28. Both copies sat in the queue, so each of
    // those episodes would have been posted twice. A request that is waiting
    // already is answered as a queued one is - what it asked for is in the
    // queue - and one that overlaps queues only the episodes that are not.
    //
    // Read again here, after the AI checks awaited: another request
    // may have queued some of these episodes meanwhile. What is waiting NOW
    // decides, as it did when nothing awaited in between, plus one thing
    // from before the checks: an episode they skipped as waiting
    // (`screen.waiting`) stays out even if its request finished meanwhile -
    // it was never checked for this request. Nothing else from the first
    // read is kept: an episode the rating never blocked whose request was
    // cancelled or failed while the checks ran is queued here, not called
    // "already waiting" with nobody left to post it. From here to the adds
    // below nothing may await (test/tv-duplicate-request.test.mjs, "at once").
    const waitingNow = this._waitingEpisodeIds(ctx, waitingFor);
    for (const { ep } of screen?.waiting ?? []) waitingNow.add(String(ep.id));
    const fresh = allowed.filter((e) => !waitingNow.has(String(e.id)));
    const alreadyWaiting = allowed.length - fresh.length;
    const capped = (list) => { const l = [...list].sort(episodeOrder); return cap > 0 ? l.slice(0, cap) : l; };
    // What the notifications group is told about episodes that were waiting
    // already is new wording, staged through the beta group (TV_DUPLICATE).
    // Off, it is told what it was before the duplicate check: the line the
    // whole request would have got. Nothing is queued twice either way.
    const dupWords = isEnabled(ctx.config, TV_DUPLICATE, featureGroup(msg));
    const which = allowed.length ? (isSingleEpisode(parsed) ? episodeLabel(allowed[0]) : `${found.series.name} ${scope}`) : null;
    // Asking again for a season the rating filter cut is what the missing
    // episodes prompt (FMA's S01E14, asked twice after the season left it
    // out), so where the rating notice is on, the answer names them too -
    // and what the bypass list and the AI check did about them.
    const notes = [withheld?.sentence, ...(screened?.sentences ?? [])].filter(Boolean);
    const line = (lead) => (dupWords
      ? `${lead} ${which} — already in the queue, not added again`
        + `${notes.length && say ? `. ${notes.join(' ')}` : ''}`
      : this._queuedLine({ R, found, parsed, scope, list: capped(allowed), allowed, withheld, screened, say }).line);
    // The member's own request, sent again while it waits or is in progress
    // - every episode of it in one request of theirs, still to come or
    // posted already by it: not a duplicate, and nothing queued (_resentTv).
    // Decided before what is waiting is: a season part-way posted has let
    // its posted episodes go, and they would be queued - and posted - again
    // as a new request of theirs (found in review, 2026-10-11). Not a test,
    // whose holder is always a real request it is tried against.
    const mine = !testing && allowed.length && !unreached ? this._ownHolderOf(ctx, allowed, route, msg, waitingNow) : null;
    if (mine) {
      return this._resentTv(ctx, {
        msg, route, react, batch, holder: mine.holder, own: mine.own, which, found, typed, withheld, screened,
        row: { id: rowId(), request: rowText }, line: line(R.added || '🎬'),
      });
    }
    if (!fresh.length && allowed.length && !unreached) {
      ctx.log.info(`📺 ${which} is already in the queue - not queueing it again`);
      // 🤥 by default (reactions.duplicate, the operator's choice): not the 🎬
      // a fresh request gets, so the requester can see it was a repeat.
      await react(R.duplicate || R.added);
      this._notify(ctx, line(R.duplicate || R.added || '🎬'), msg, { route });
      const dupId = rowId();
      // Told how the request that holds these episodes ends, as its own
      // requester is (_tellTvFollowers), and journalled with it, so a restart
      // keeps that - and the place in line below. One season of several
      // follows for its History row only: which request the message's
      // reaction follows is decided once every season has been through here
      // (_runSeasons). Not a test, whose holder is a real request: the test
      // is over once it is answered, and a real request's outcome and place
      // in line are not the test's to show.
      if (!testing) {
        const holder = this._holderOf(ctx, allowed, route);
        this._addTvFollowers(ctx, holder, [{
          msgId: msg.id, msgKey: batch ? null : (msg.key ?? null), chatJid: msg.chatJid, historyId: dupId, route: route ?? null,
        }]);
        // And shown its place in line while that request waits, as its
        // requester is.
        if (batch) { if (holder?.reqKey) batch.dups.push(holder.reqKey); }
        else this._followPlace(ctx, holder?.reqKey, msg, route);
      }
      this._history(ctx, {
        id: dupId, kind: 'tv', at: Date.now(), requestedAt: msg.timestamp || Date.now(),
        requester: msg.pushName ?? null, requesterJid: msg.senderJid ?? null,
        requesterNumber: msg.senderNumber ?? null, requesterNumberDisplay: msg.senderNumberDisplay ?? null,
        groupJid: msg.chatJid, request: rowText, ...typed, title: found.series.name, year: found.series.year ?? null,
        season: found.season ?? null, episodes: 0, status: 'duplicate',
        detail: `already in the queue — ${allowed.length} episode(s) waiting from an earlier request`
          + withheldSuffix(withheld?.detail) + withheldSuffix(screened?.detail),
        ...(route ? { beta: true, ...(route.test ? { test: route.test } : {}) } : {}),
        ...(withheld ? { withheld: withheld.detail } : {}),
        ...(screened ? { override: screened.detail } : {}),
      });
      return { outcome: 'duplicate' };
    }
    if (alreadyWaiting) {
      ctx.log.info(`📺 ${alreadyWaiting} of ${allowed.length} episode(s) of ${found.series.name} ${scope} `
        + `are already in the queue - queueing the other ${fresh.length}`);
    }

    const queueing = capped(fresh);
    // What the bypass list and the AI check are said to have sent is what
    // goes into the queue. An episode the list covers past the episode cap
    // is not sent, and was named as sent all the same: FMA:B's E26 with the
    // cap at 20 (describeScreen, found in review, 2026-09-29).
    screened = describeScreen(screen, screen?.allowed ?? [], { queued: queueing });
    // What maxEpisodesPerRequest left out of it, and the message that asks
    // for the next part (cap-cut.js), or null when it left out nothing - and
    // then everything below reads exactly as before. A season cut part-way
    // used to queue its first episodes and say nothing of the rest: the
    // operator's "why is the flash converting 23 episodes if it's max 10 per
    // request?" (2026-10-12) put the limit back, and "Arrow s1" would then
    // have been 🎬 and silence for 13 of its 23 episodes.
    const cutOff = queueing.length ? this._capCutOf({
      cfg, found, parsed, route, queueing, fresh, unreached: screen?.unreached,
      waiting: [...allowed.filter((e) => waitingNow.has(String(e.id))), ...(screen?.waiting ?? []).map((w) => w.ep)],
    }) : null;
    // A part a cut request named, asked for as it was told: it fits under
    // the limit and is answered as any request that fits, but finishes
    // naming the part after it, or the last of the season would be asked
    // for by nothing (_partAfter).
    const following = !cutOff && !testing && queueing.length ? this._partAfter(ctx, { cfg, found, parsed, route }) : null;

    // The queue's ceiling counts REQUESTS, and this is one however many
    // episodes it holds, so it needs one free place and goes in whole. It
    // used to take a place per episode: a 23-episode season into 8 free
    // places kept 8 and dropped 15 without a word (six times in one night),
    // and even once that was caught, a big season still went in part-way
    // with "ask again for the rest" - while filling the line for everybody.
    // One of several seasons is told with the rest of them (_runSeasons).
    const refuseFull = async () => {
      ctx.log.warn(`📺 queue full - refused ${found.series.name} ${scope}`);
      await react(R.failed);
      if (batch) { batch.full.push(found.season); return; }
      this._notify(ctx,
        `⚠️ ${found.series.name} ${scope} — the queue is full right now. `
        + 'Nothing was added; please ask again once it clears.', msg, { route });
    };
    // Nothing to queue at all is the same answer: the AI checks found
    // no place for the request, so they asked about nothing (`unreached`
    // above), and a place that opened since cannot take episodes nobody
    // checked. Asked again, they are.
    if (!queueing.length) {
      await refuseFull();
      return { outcome: 'full' };
    }
    // Where a real request is queued, a test says it passed, and stops: "as
    // soon as bot can confirm it will download it should basically be like
    // "test passed" and not actually queue a download of the file
    // interrupting actual requests" (the operator, 2026-09-29). It takes no
    // place, so a full queue is no reason to stop it.
    if (testing) {
      if (batch?.left) batch.left.episodes -= queueing.length;
      return this._testPassedTv(ctx, {
        msg, route, react, found, parsed, scope, queueing, allowed, withheld, screened, say, R, batch,
        rowId: rowId(), rowText, typed, cutOff,
        also: dupWords && alreadyWaiting ? ` (${alreadyWaiting} more already waiting)` : '',
      });
    }
    if (!this._hasRoom(ctx)) {
      await refuseFull();
      return { outcome: 'full' };
    }

    // One of several seasons: from here it is queued, and may speak for the
    // message (shared-message.js). Its own request key, even in the same
    // millisecond as the season before it.
    const reqKey = batch ? `tv-${msg.id}-s${found.season}-${Date.now()}` : `tv-${msg.id}-${Date.now()}`;
    batch?.voice.join(reqKey);
    if (batch?.left) batch.left.episodes -= queueing.length;

    // Not awaited, so nothing can take the queue's last place between the
    // check above and the adds below - that race once cost the rest of a
    // season. It is still asked for before any episode can start, and the
    // pacer keeps arrival order between reactions of the same kind, so it
    // lands before an episode's ⬇️.
    //
    // The same goes for the duplicate check further up: from there to the
    // adds nothing may await, or a second request for the same season,
    // answered meanwhile, would find none of it waiting and queue it all
    // again (test/tv-duplicate-request.test.mjs, "at once").
    react(R.added);
    // Named by the episodes going into the queue, and what they are part of
    // when that is not all of it (queuedName): the journal keeps the name,
    // so the finished notice says it after a restart too.
    const named = queuedName(found, parsed, queueing, scope);
    const title = isSingleEpisode(parsed)
      ? episodeLabel(queueing[0])
      : `${found.series.name} ${named.scope}`;
    const what = isSingleEpisode(parsed) ? title : `${title} — ${named.count}`;
    ctx.log.info(`📺 queueing ${what}`);
    if (cutOff) ctx.log.info(`📺 ${found.series.name} ${scope}: ${cutDetail(cutOff.cut)}`);
    // Episodes of this request another one has in the queue already are not
    // queued twice (see the duplicate check above), and the line says so -
    // where the new wording is on. Off, it counts the whole request, as the
    // line did before (TV_DUPLICATE). What the rating filter withheld, and
    // what the bypass list and the AI check let through, follow tv-rating-notice
    // (`say`), each on its own flag as before. A request maxEpisodesPerRequest
    // cut says so: "10 of 23 episodes", and the limit.
    const told = this._queuedLine({
      R, found, parsed, scope, allowed, withheld, screened, say,
      list: dupWords || !alreadyWaiting ? queueing : capped(allowed),
      also: dupWords && alreadyWaiting ? ` (${alreadyWaiting} more already waiting)` : '',
      cut: cutOff?.cut ?? null,
    });
    this._notify(ctx, told.line, msg, { route });
    // In the request group too, but only where the owner has asked for
    // refusals in words (replyOnBlock, shared with the movie side, off by
    // default): a withheld episode is a refusal, and the request group is
    // the one place the requester is sure to read when the notifications
    // group is switched off. Not awaited, so nothing comes between the
    // checks above and the episodes going into the queue. Episodes the
    // bypass list or the AI check let through are no refusal, so they alone
    // do not reply.
    const withheldReply = !!(told.added && told.held && ctx.config.movieRequests?.replyOnBlock);
    if (cutOff && batch) {
      // One of several seasons: said in the message's one reply
      // (_answerSeasons), with its withheld episodes' words where those
      // would have had a reply of their own.
      batch.cut.push({ season: found.season, ...cutOff, notes: withheldReply ? told.notes : [] });
    } else if (cutOff) {
      // A request the limit cut is always answered in the request group: its
      // 🎬 says the request was taken, and nothing else would tell the member
      // that part of it was not, or what to send for the rest. One reply,
      // quoted to their message, which carries the withheld episodes' words
      // too where those would have had a reply of their own. Not awaited,
      // for the same reason as that one.
      const body = cutReply(cutOff.cut, { lead: `*${plainText(found.series.name)}* ${scope}`, ask: cutOff.ask })
        + (withheldReply ? `\n\n${told.notes.join(' ')}` : '');
      ctx.bot.sendText(msg.chatJid, body, { quoted: msg })
        .catch((err) => ctx.log.warn(`could not tell the member what the episode limit left out: ${err.message}`));
    } else if (withheldReply) {
      ctx.bot.sendText(msg.chatJid, `${told.added} ${told.notes.join(' ')}`, { quoted: msg })
        .catch((err) => ctx.log.warn(`could not reply about the withheld episodes: ${err.message}`));
    }

    // One history row for the whole request, so the History tab lists TV as
    // well as movies. A season is one request, not fifteen.
    const historyId = rowId();
    const baseRow = {
      id: historyId,
      kind: 'tv',
      at: Date.now(),
      requestedAt: msg.timestamp || Date.now(),
      requester: msg.pushName ?? null,
      requesterJid: msg.senderJid ?? null,
      requesterNumber: msg.senderNumber ?? null,
      requesterNumberDisplay: msg.senderNumberDisplay ?? null,
      groupJid: msg.chatJid,
      request: rowText,
      ...typed,
      title: found.series.name,
      year: found.series.year ?? null,
      season: found.season ?? null,
      episodes: queueing.length,
      status: 'queued',
      detail: (isSingleEpisode(parsed) ? episodeLabel(queueing[0]) : `${named.scope} — ${named.count}`)
        + withheldSuffix(cutDetail(cutOff?.cut)) + withheldSuffix(withheld?.detail) + withheldSuffix(screened?.detail),
      // Marks the row in History as a test, so it is never mistaken for (or
      // re-run as) a request from a main group.
      ...(route ? { beta: true } : {}),
      ...(withheld ? { withheld: withheld.detail } : {}),
      ...(screened ? { override: screened.detail } : {}),
      // What maxEpisodesPerRequest left out, for the hourly check's scan as
      // much as for an admin: a season sent in parts is not missing episodes,
      // nor its next part a member asking again (incident-scan.js).
      ...(cutOff ? { cut: cutOff.cut } : {}),
    };
    const absent = absentDetail(found);
    if (absent) Object.assign(baseRow, { absent, detail: baseRow.detail + withheldSuffix(absent) });
    this._history(ctx, baseRow);

    // What the finished request's notice tells its member to send next
    // (_makeRequestNotifier): by then the cooldown is long over, and the
    // reply that named it hours before has scrolled away. Journalled with
    // the request, so a restart keeps it (_resumeLeftover).
    const next = cutOff?.ask ? { send: cutOff.ask, last: !!cutOff.cut.next?.last } : following;
    if (following) ctx.log.info(`📺 ${found.series.name} ${scope} is a part an earlier request named - next: ${following.send}`);

    // One notifier for the WHOLE request: a season reports "downloading …
    // converting … posted", not that sequence once per episode.
    const share = batch?.share ?? null;
    const notifier = this._makeRequestNotifier(ctx, {
      label: what, total: queueing.length, msg, single: queueing.length === 1, route, reqKey, next, cut: cutOff?.cut ?? null,
      onFinish: ({ completed, failed, cancelled = 0, skipped = 0, why = null }) => {
        this._history(ctx, {
          ...baseRow,
          at: Date.now(),
          status: (failed === 0 && cancelled === 0) ? 'sent'
            : (completed === 0 ? (failed ? 'failed' : (cancelled === skipped ? 'skipped' : 'cancelled')) : 'partial'),
          detail: ((failed === 0 && cancelled === 0)
            ? `${completed} episode(s) posted`
            : [`${completed} of ${notifier.total} posted`,
               ...countsProse({ failed, cancelled, skipped })].join(', ') + betaWhy(route, failed, why))
            + cutSuffix(notifier) + rowSuffix(baseRow),
          // Trimmed to the episode limit since (trimQueued): what it held then.
          ...trimmedRow(notifier),
        });
        // The next of the message's seasons takes its reaction over.
        share?.concluded(reqKey, notifier.ending());
      },
    });

    // Journal BEFORE queueing: the queue is in memory, so anything not written
    // down here is gone if the process stops. One of several seasons says so,
    // so a restart shares the message between them again (_resumeLeftover).
    const shared = batch ? { shared: { id: msg.id, ended: [] } } : {};
    // Whose request it is, for the queue's fair order (src/core/queue.js):
    // journalled, so the request is still theirs after a restart (_groupOf).
    const memberKey = requestMemberKey(msg);
    // Asked for inside the member's cooldown (_cooldownGate): an extra in the
    // fair order whatever else they have in the queue, the operator's rule
    // of 2026-10-12 (src/core/queue.js) - journalled too, so a restart puts
    // it back as one (_groupOf, _expectBack).
    const cooled = insideCooldown ? { insideCooldown } : {};
    this._journalAdd(ctx, {
      reqKey,
      label: what,
      msgId: msg.id, msgKey: msg.key, chatJid: msg.chatJid,
      requester: msg.senderNumberDisplay ?? msg.senderNumber ?? null,
      requesterNumber: msg.senderNumber ?? null,
      memberKey,
      ...cooled,
      baseRow,
      episodes: queueing,
      ...(route ? { route } : {}),
      ...shared,
      ...(next ? { next } : {}),
    });

    const requester = msg.senderNumberDisplay ?? msg.senderNumber ?? null;
    if (insideCooldown && ctx.queue?.fairShare) {
      ctx.log.info(`📺 ${what} was asked for inside ${requester ?? msg.senderJid}'s cooldown, `
        + `${fmtDuration(Math.round(insideCooldown.gapMs / 1000))} after their "${insideCooldown.what ?? '?'}" was queued - `
        + 'an extra in the fair order');
    }
    const discard = this._discarder(ctx, { reqKey, label: what, notifier, react });

    // Held, journalled, while the requests from before a restart are put back
    // (_holdForRecovery), so it goes into the queue behind them.
    if (this._holdForRecovery(ctx, { reqKey, label: what, notifier, msg, react, discard, share })) {
      this._tellQueued(ctx, onQueued);
      return { outcome: 'queued', queued: true };
    }

    // One job per episode, queued in broadcast order, all in one queue group
    // so the queue counts, shows, moves and cancels them as one request.
    const accepted = [];
    for (const [i, ep] of queueing.entries()) {
      try {
        ctx.queue.add({
          kind: 'tv',                     // held behind every movie
          group: reqKey,
          groupLabel: title,
          groupMeta: {
            kind: 'tv', series: found.series.name, season: found.season,
            requester, requesterNumber: formatPhone(msg.senderNumber), memberKey, ...cooled,
            ...(route ? { beta: true } : {}),
          },
          label: episodeLabel(ep),
          meta: {
            kind: 'tv',
            series: ep.series,
            season: ep.season,
            episode: ep.episode,
            // Which item it is, not only its number: two episodes with no
            // number share one, and the trim takes off by item (trimQueued).
            epId: String(ep.id),
            requester,
            // +<digits>, as a film's is: the panel shows it beside the name.
            requesterNumber: formatPhone(msg.senderNumber),
            memberKey,
            position: `${i + 1}/${queueing.length}`,
            ...(route ? { beta: true } : {}),
          },
          run: (job) => this.deliverEpisode({
            ep, ctx, job, msg, react, notifier, reqKey, route,
            isLast: i === queueing.length - 1,
            index: i, total: queueing.length,
          }),
          onDiscard: discard(ep),
        });
        accepted.push(ep);
      } catch (err) {
        if (err.code !== 'QUEUE_FULL') throw err;
        // Only the first episode can be refused - the rest join a request the
        // queue has already counted - so this is all of it.
        break;
      }
    }

    if (!accepted.length) {
      // The check above leaves no gap for this, but a queue can be wired
      // differently; refuse it the same way rather than leave a "queued"
      // History row and a journal entry that would come back on restart.
      ctx.log.warn(`📺 queue full - nothing of ${what} was queued`);
      this._journalDrop(ctx, reqKey);
      this._history(ctx, { ...baseRow, at: Date.now(), status: 'failed', detail: 'the queue was full — nothing was added' });
      await react(R.failed);
      share?.concluded(reqKey, R.failed ?? '⚠️');
      this._notify(ctx,
        `⚠️ ${what} — the queue is full right now. Nothing was added; please ask again once it clears.`,
        msg, { route });
      return { outcome: 'full' };
    }
    if (accepted.length !== queueing.length) {
      // Keep the notifier's arithmetic honest, or it waits for an episode
      // that will never report and the request reads "queued" for ever.
      for (let k = accepted.length; k < queueing.length; k++) notifier?.episodeCancelled();
      // And correct the journal to what the queue actually took. Journalling
      // an episode that was never queued would resurrect it on the next
      // restart, silently re-adding work the requester was told was refused.
      this._journalAdd(ctx, {
        reqKey,
        label: what,
        msgId: msg.id, msgKey: msg.key, chatJid: msg.chatJid,
        requester: msg.senderNumberDisplay ?? msg.senderNumber ?? null,
        requesterNumber: msg.senderNumber ?? null,
        memberKey,
        ...cooled,
        baseRow,
        episodes: accepted,
        ...(route ? { route } : {}),
        ...shared,
        ...(next ? { next } : {}),
      });
    }

    // Its place in line, on the request itself, until the first episode
    // starts (_updatePositions) - for one of several seasons, while it is the
    // one speaking for the message.
    this._reactors?.set(reqKey, { msg, lastEmoji: null, route, also: [], share });
    this._updatePositions(ctx);
    this._tellQueued(ctx, onQueued);
    return { outcome: 'queued', queued: true };
  },

  /**
   * What maxEpisodesPerRequest left out of a request about to be queued,
   * and the message that asks for the next part, as { cut, ask } - or null
   * when it left out nothing (cap-cut.js).
   *
   * Left out by the limit: the episodes past it, of those this request would
   * queue (`fresh`: neither waiting already nor withheld on their rating),
   * and the rating-blocked ones the AI check was not asked about because
   * they were past it (`unreached`) - asked for again, they are checked.
   * What the next part is asked with carries the group's prefix only where
   * the group needs one (requirePrefix), and a test's code in front of it
   * (beta.js suggestPrefix): copied without them, it would be ignored. The
   * show is named as the library names it, as the "which season?" example
   * does. `panel` is the panel's queue box, which takes no prefix.
   *
   * `waiting` is what it asked for that is waiting already for another
   * request: no part takes one in, or the member, sending it once these are
   * posted, would queue those again (next-part.js). A list's parts take in
   * only the episodes it named.
   */
  _capCutOf({ cfg, found, parsed = null, route = null, queueing, fresh, waiting = [], unreached = null, panel = false }) {
    const limit = Number(cfg?.maxEpisodesPerRequest ?? 0);
    if (!(limit > 0) || !queueing?.length) return null;
    const going = new Set(queueing);
    const left = [...(fresh ?? []).filter((e) => !going.has(e)), ...(unreached ?? []).map((u) => u.ep).filter(Boolean)];
    const only = parsed?.episodeList?.length ? parsed.episodeList : null;
    const cut = capCut({ season: found.season, limit, queued: queueing, left, coming: waiting, only });
    if (!cut) return null;
    return { cut, ask: nextAsk(cut.next, { name: found.series.name, prefix: this._askPrefix(cfg, route, { panel }) }) };
  },

  /**
   * The prefix a message for the next part is written with: the request
   * group's where it needs one (requirePrefix), with a test's code in front
   * of it (beta.js suggestPrefix) - none for the panel's queue box.
   */
  _askPrefix(cfg, route = null, { panel = false } = {}) {
    return panel ? '' : suggestPrefix(route, cfg?.requirePrefix ? (cfg.prefix ?? '') : '');
  },

  /**
   * A run of episodes that is one of the parts a cut request named
   * (cap-cut.js `parts`, on its History row): the message for the part after
   * it, as { send, last } for the finished notice, or null - for any other
   * request, for the last part, and with no limit set.
   *
   * The part named as next fits under the limit, so nothing cuts it, and it
   * would end on "all 10 episodes posted" and nothing more: Arrow S01E11-E20,
   * sent as told, never named E21-E23, and asking for "season 1" again then
   * would queue episode 1 again. The latest row that named the part decides,
   * whoever asked for it: a member who saw the notice in the notifications
   * group and sent the part is told the rest as well. Not across the beta
   * line, whose parts go to another group.
   */
  _partAfter(ctx, { cfg, found, parsed, route = null }) {
    if (!(Number(cfg?.maxEpisodesPerRequest ?? 0) > 0) || !found?.series) return null;
    const range = parsed?.episodeRange ?? (parsed?.episode != null ? { from: parsed.episode, to: parsed.episode } : null);
    if (!range) return null;
    const title = String(found.series.name ?? '').toLowerCase();
    for (const row of ctx.store.get('history', []) ?? []) {
      if (!row?.cut?.parts || !!row.beta !== !!route) continue;
      if (String(row.title ?? '').toLowerCase() !== title || row.season !== found.season) continue;
      const after = partAfter(row.cut, range, found.season);
      if (!after) {
        // The last part, or not one of this row's: an older row may still name it.
        if ((row.cut.parts ?? []).some((p) => Number(p?.[0]) === range.from && Number(p?.[1]) === range.to)) return null;
        continue;
      }
      const send = nextAsk(after, { name: found.series.name, prefix: this._askPrefix(cfg, route) });
      return send ? { send, last: !!after.last } : null;
    }
    return null;
  },

  /**
   * Tell the member's cooldown that episodes are in the queue (_afterIntake's
   * onQueued). Never lets a fault there undo a request that was queued.
   */
  _tellQueued(ctx, onQueued) {
    if (!onQueued) return;
    try { onQueued(); }
    catch (err) { ctx.log.warn(`TV: could not start the member's cooldown: ${err.message}`); }
  },

  /**
   * Queue a TV request from the control panel (no WhatsApp message behind it),
   * so an admin can type "Rick and Morty season 4" into the queue box.
   * Returns what was queued, or throws with a reason a human can act on.
   */
  async requeue(text, ctx, { requester = 'manual (admin)', overLimit = false, aiBudget = null, member = null } = {}) {
    const cfg = ctx.config.tvRequests ?? {};
    if (!postsTargets(cfg).length) throw new Error('No TV posts group configured');

    const parsed = parseTvRequest(text);
    if (!parsed.show) throw new Error(`Could not read a show name from "${text}"`);
    // Several seasons typed into the panel are one request each, as they are
    // from a group (_runSeasons) - queued one after another, and answered
    // together: what went in, and why the rest did not.
    if (parsed.seasons?.length > 1) return this._requeueSeasons(parsed, ctx, { requester, overLimit, member });

    const jf = ctx.config.library?.jellyfin ?? {};
    const opts = {
      base: String(jf.baseUrl ?? '').replace(/\/+$/, ''),
      token: jf.accessToken || jf.apiKey,
      userId: jf.userId,
      bestMatch,
    };
    if (!opts.base || !opts.token) throw new Error('Jellyfin is not configured');

    const found = await resolveEpisodes(parsed, opts);
    if (found.error === 'not-found') throw new Error(`No show matching "${parsed.show}" in the library`);
    if (found.error === 'no-such-episode') {
      const r = parsed.episodeRange;
      const l = parsed.episodeList?.length ? parsed.episodeList : null;
      throw new Error(r || l
        ? `${found.series.name} has none of ${r ? rangeCode(found.season, r.from, r.to) : listCode(found.season, l)}`
        : `${found.series.name} has no S${String(found.season).padStart(2, '0')}E${String(parsed.episode).padStart(2, '0')}`);
    }
    if (found.error === 'empty-season') throw new Error(`${found.series.name} season ${found.season} has no episodes in the library`);
    if (found.error === 'need-season') {
      const list = (found.seasons ?? []).join(', ');
      throw new Error(`Which season of ${found.series.name}? Available: ${list || 'unknown'}`);
    }

    const scope = scopeOf(found, parsed);
    const blocked = (cfg.blockedRatings ?? []).map((r) => String(r).toUpperCase());
    const seriesRating = String(found.series?.rating ?? '').toUpperCase();
    const seriesBlocked = !!seriesRating && blocked.includes(seriesRating);
    // Nothing is queued twice for the main posts groups, from here any more
    // than from a request group (see onMessage): a panel Re-run and the
    // hourly check's requeue come through here. What is waiting already is
    // read before the AI checks, so they ask only about episodes this would
    // really queue - one waiting in the queue is not checked again - and
    // read once more after them, below.
    const waiting = this._waitingEpisodeIds(ctx, null);
    // The same bypass list and AI check as a request from a group, told the
    // cap below so it asks only about episodes that could be queued, and
    // asking nothing when the queue has no place for the request.
    const cap = Number(cfg.maxEpisodesPerRequest ?? 0);
    const screen = await this._screenRated(ctx, {
      found, blocked, seriesRating: seriesBlocked ? seriesRating : null, waiting,
      limit: () => (overLimit || this._hasRoom(ctx) ? (cap > 0 ? cap : Infinity) : 0),
      budget: aiBudget,
    });
    let screened = describeScreen(screen, screen?.allowed ?? []);
    // What the AI check made of what stays out, for the admin's refusal.
    const notCleared = screened?.notClearedCount ? ` — ${screened.detail}` : '';
    const unreached = screen?.unreached?.length ?? 0;
    if (seriesBlocked && (!screen || (!screen.allowed.length && !unreached))) {
      throw new Error(`${found.series.name} is rated ${seriesRating} (blocked)${notCleared}`);
    }
    const allowed = screen ? screen.allowed : found.episodes.filter((e) => {
      const r = String(e.rating ?? '').toUpperCase();
      return !(r && blocked.includes(r));
    });
    // Named the way the request groups are told (withheld.js), so an admin
    // re-running a member's request sees which episodes stay out and why.
    const withheld = describeWithheld(withheldFrom(
      screen ? screen.withheldOnRating : found.episodes.filter((e) => !allowed.includes(e)), allowed));
    if (!allowed.length && !unreached) {
      const only = isSingleEpisode(parsed) && withheld.count === 1 ? found.episodes[0] : null;
      throw new Error((only
        ? `${found.series.name} S${pad(only.season ?? found.season)}E${pad(only.episode)} is rated ${withheld.ratings.join(' and ')} (blocked)`
        : `Every episode of ${found.series.name} ${scope} is blocked on rating: ${withheld.clauses.replace(/^E/, 'e')}`)
        + notCleared);
    }

    // What is waiting now decides, as in onMessage: an episode another
    // request queued while the checks ran is left out, and one the checks
    // skipped as waiting stays out, unchecked; one whose request ended
    // meanwhile is queued. A request that is all waiting is refused.
    const waitingNow = this._waitingEpisodeIds(ctx, null);
    for (const { ep } of screen?.waiting ?? []) waitingNow.add(String(ep.id));
    const fresh = allowed.filter((e) => !waitingNow.has(String(e.id)));
    if (!fresh.length && allowed.length && !unreached) {
      throw Object.assign(new Error(`${isSingleEpisode(parsed) ? episodeLabel(allowed[0]) : `${found.series.name} ${scope}`}`
        + ' is already in the queue - not queued twice'), { code: 'DUPLICATE' });
    }

    const episodes = [...fresh].sort(episodeOrder);
    const queueing = cap > 0 ? episodes.slice(0, cap) : episodes;
    // Named as sent only if queued, as in _runSeason.
    screened = describeScreen(screen, screen?.allowed ?? [], { queued: queueing });
    // What the limit left out, as in _runSeason (cap-cut.js). A panel Re-run
    // or the hourly check's requeue of a member's season cut it as silently
    // as a request from a group did: the History row and the answer said
    // "10 episode(s)" of a season of 23. Both say so now, for the admin; no
    // member is told anything more from here, so the completion notice is
    // the one it always was.
    const cutOff = this._capCutOf({
      cfg, found, parsed, queueing, fresh: episodes, unreached: screen?.unreached, panel: true,
      waiting: [...allowed.filter((e) => waitingNow.has(String(e.id))), ...(screen?.waiting ?? []).map((w) => w.ep)],
    });
    const noop = () => Promise.resolve();

    // Named by the episodes going into the queue, as in _runSeason (queuedName).
    const named = queuedName(found, parsed, queueing, scope);
    const label = queueing.length === 1
      ? episodeLabel(queueing[0])
      : `${found.series.name} ${named.scope}`;

    // Room for the request - one place, however many episodes, since the
    // queue counts requests - checked before History or the journal is
    // written: queued one episode at a time, a queue that filled part-way left
    // half a season in and a History row claiming all of it.
    // Nothing to queue at all means the AI checks found the queue
    // full and asked about nothing (`unreached`): the same refusal.
    if (!queueing.length || (!overLimit && !this._hasRoom(ctx))) throw ctx.queue.fullError();

    // Queued from the portal still belongs in History - this path recorded
    // nothing, so anything an admin queued by hand left no trace at all.
    const historyId = `tv-manual-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const baseRow = {
      id: historyId,
      kind: 'tv',
      at: Date.now(),
      requestedAt: Date.now(),
      // The member an admin assigned it to, if any (panelRequester).
      ...panelRequester(requester, member),
      request: text,
      title: found.series.name,
      year: found.series.year ?? null,
      season: found.season ?? null,
      episodes: queueing.length,
      status: 'queued',
      detail: (queueing.length === 1 && !cutOff ? episodeLabel(queueing[0]) : `${named.scope} — ${named.count}`)
        + withheldSuffix(cutDetail(cutOff?.cut)) + withheldSuffix(withheld?.detail) + withheldSuffix(screened?.detail),
      ...(withheld ? { withheld: withheld.detail } : {}),
      ...(screened ? { override: screened.detail } : {}),
      ...(cutOff ? { cut: cutOff.cut } : {}),
    };
    const absent = absentDetail(found);
    if (absent) Object.assign(baseRow, { absent, detail: baseRow.detail + withheldSuffix(absent) });
    this._history(ctx, baseRow);

    const reqKey = `tv-manual-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const notifier = this._makeRequestNotifier(ctx, {
      label, total: queueing.length, msg: null, single: queueing.length === 1, reqKey, cut: cutOff?.cut ?? null,
      onFinish: ({ completed, failed, cancelled = 0, skipped = 0 }) => this._history(ctx, {
        ...baseRow,
        at: Date.now(),
        status: (failed === 0 && cancelled === 0) ? 'sent'
          : (completed === 0 ? (failed ? 'failed' : (cancelled === skipped ? 'skipped' : 'cancelled')) : 'partial'),
        detail: ((failed === 0 && cancelled === 0)
          ? `${completed} episode(s) posted`
          : [`${completed} of ${notifier.total} posted`, ...countsProse({ failed, cancelled, skipped })].join(', '))
          + cutSuffix(notifier) + rowSuffix(baseRow),
        // Trimmed to the episode limit since (trimQueued): what it held then.
        ...trimmedRow(notifier),
      }),
    });

    this._journalAdd(ctx, {
      reqKey, label, requester: baseRow.requester ?? null, baseRow, episodes: queueing,
    });

    // One queue group, like a request from the group: one item in the queue.
    // No message behind it, so no place-in-line reaction either. Held, like
    // one from a group, while the requests from before a restart are put
    // back (_holdForRecovery).
    const discard = this._discarder(ctx, { reqKey, label, notifier });
    const held = this._holdForRecovery(ctx, { reqKey, label, notifier, msg: null, react: noop, discard });
    if (!held) queueing.forEach((ep, i) => {
      ctx.queue.add({
        kind: 'tv',
        group: reqKey,
        groupLabel: label,
        groupMeta: { kind: 'tv', series: found.series.name, season: found.season, requester: baseRow.requester },
        label: episodeLabel(ep),
        meta: {
          kind: 'tv', series: ep.series, season: ep.season, episode: ep.episode, epId: String(ep.id),
          requester: baseRow.requester, ...(baseRow.assignedBy ? { assigned: true } : {}), position: `${i + 1}/${queueing.length}`,
        },
        onDiscard: discard(ep),
        // No inbound message, so reactions are no-ops; delivery is unchanged.
        run: (job) => this.deliverEpisode({
          ep, ctx, job, msg: null, react: noop, notifier, reqKey,
          isLast: i === queueing.length - 1, index: i, total: queueing.length,
        }),
      }, { overLimit });
    });

    ctx.log.info(`📺 manual queue: ${found.series.name} ${named.scope} — ${named.count}`
      + (baseRow.assignedBy ? ` for ${baseRow.requester} (by ${baseRow.assignedBy})` : '')
      + withheldSuffix(cutDetail(cutOff?.cut)) + rowSuffix(baseRow));
    const notes = [withheld?.sentence, ...(screened?.sentences ?? [])].filter(Boolean);
    return {
      kind: 'tv',
      series: found.series.name,
      season: found.season,
      // "Queued 2 episodes — Outer Banks S05E08–E09" on the panel: the
      // episodes queued, with the withheld note saying why not the rest.
      scope: named.scope,
      queued: queueing.length,
      episodes: queueing.map((e) => episodeLabel(e)),
      ...(notes.length
        ? { withheld: withheld?.count ?? 0, withheldNote: notes.join(' ') }
        : {}),
      // The episodes of a list the server does not have, said where the
      // panel says what did not go in.
      ...(found.missing?.length ? { notQueued: [`${listCode(found.season, found.missing)}: not on the server`] } : {}),
      // What the limit left out, and what to type into the queue box for
      // the next part (the panel's toast shows `cutNote`).
      ...(cutOff ? { cut: cutOff.cut, cutNote: cutDetail(cutOff.cut, { ask: cutOff.ask }) } : {}),
    };
  },

  /**
   * requeue() for several seasons: each season on its own, as though typed
   * alone, in order. Answers with what was queued across them, and throws
   * only when none of them could be - with every season's reason, and the
   * first one's code, so a full queue still reads as one. The seasons share
   * one AI check budget, as a message's do (_runSeasons).
   */
  async _requeueSeasons(parsed, ctx, opts) {
    const done = [];
    const refused = [];
    let firstErr = null;
    const aiBudget = {};
    for (const season of parsed.seasons) {
      try {
        done.push(await this.requeue(`${parsed.show} season ${season}`, ctx, { ...opts, aiBudget }));
      } catch (err) {
        firstErr ??= err;
        refused.push(`season ${season}: ${err.message}`);
      }
    }
    if (!done.length) throw Object.assign(new Error(refused.join(' · ')), firstErr?.code ? { code: firstErr.code } : {});
    const notes = done.filter((d) => d.withheldNote).map((d) => `season ${d.season}: ${d.withheldNote}`);
    const cuts = done.filter((d) => d.cutNote).map((d) => `season ${d.season}: ${d.cutNote}`);
    return {
      kind: 'tv',
      series: done[0].series,
      season: done[0].season,
      seasons: done.map((d) => d.season),
      scope: `season${done.length > 1 ? 's' : ''} ${seasonList(done.map((d) => d.season))}`,
      queued: done.reduce((n, d) => n + d.queued, 0),
      episodes: done.flatMap((d) => d.episodes),
      ...(refused.length ? { notQueued: refused } : {}),
      ...(notes.length
        ? { withheld: done.reduce((n, d) => n + (d.withheld ?? 0), 0), withheldNote: notes.join(' ') }
        : {}),
      ...(cuts.length ? { cutNote: cuts.join(' · ') } : {}),
    };
  },

  /**
   * One request = one set of updates.
   *
   * A season is many jobs, but a viewer wants "downloading… converting…
   * posted", not that sequence repeated for every episode. This tracks the
   * request as a whole: each stage announces the FIRST time any episode
   * reaches it, and the finish line is announced once every episode is done.
   * A single-episode request behaves exactly as before, because one episode
   * and one request are then the same thing.
   *
   * `ending()` is what the requester's message ends on once every episode has
   * reported (see there).
   *
   * `next` is set for a request maxEpisodesPerRequest cut, { send, last }:
   * the message to send for the next part, which the finished notice names
   * once something of it was posted (cap-cut.js nextNotice). The member was
   * told it when they asked, hours before, inside their cooldown; this is
   * when they can act on it. Nothing it posted, it asks for nothing more.
   * `cut` is the History row's (cap-cut.js), which its finished row says.
   * A trim since (trimQueued) gives it a new name, a new `cut` and a new
   * `next` at once (retitle), before the first episode is taken off: the
   * last to report may be one of those, and the notice goes out with it.
   */
  _makeRequestNotifier(ctx, {
    label, total, msg, single, onFinish = null, route = null, reqKey = null, counts = null, next = null, cut = null,
  }) {
    const stagesSent = new Set();
    // `counts` is what a request resumed after a restart had already done
    // (the journal's tally, see _journalEpisodeDone): `total` counts those
    // episodes too, so the request ends on all of it.
    let completed = counts?.completed ?? 0;
    let failed = counts?.failed ?? 0;
    let cancelled = counts?.cancelled ?? 0;
    let skipped = counts?.skipped ?? 0;            // of `cancelled`, the episodes an admin skipped
    let why = counts?.why ?? null;                 // the last failure's reason, for History
    const R = this._react(ctx);
    let finished = false;
    // Episodes taken off by trimQueued (episodeTrimmed), before a restart too.
    let trimmed = counts?.trimmed ?? 0;

    // The reaction the request's message ends on: ⚠️ when any episode failed,
    // ✅ when something was posted and nothing failed, and nothing new when
    // the request was cancelled, whose ❌ is already on the message. The
    // message used to end on whatever the last episode did, so a season whose
    // E03 failed for good closed on the ✅ of its last episode while History
    // said "partial". An admin skipping an episode is not the request failing
    // or being cancelled: it still ends on ✅ (⏭️ marked the skip), where the
    // notifications line's ❌ would have said the whole request was cancelled.
    // A request an admin set aside whole ends on ⏭️: it came back null, as a
    // cancel does, and a follower of it, or a message it shared with other
    // seasons, was then told ❌ "An admin cancelled it — it isn't coming"
    // (found in review, 2026-09-29).
    const ending = () => {
      if (failed) return R.failed ?? '⚠️';
      if (completed && cancelled === skipped) return R.done ?? '✅';
      if (!completed && cancelled && cancelled === skipped) return R.skipped ?? '⏭️';
      return null;
    };
    const allSkipped = () => !completed && !failed && cancelled > 0 && cancelled === skipped;

    // Every episode must report SOMETHING, or completed+failed+cancelled never
    // reaches the total and the request is left saying "queued" forever - which
    // is what happened to three real seasons.
    const conclude = () => {
      if (finished || completed + failed + cancelled < total) return;
      finished = true;
      done();
      const clean = failed === 0 && cancelled === 0;
      const emoji = clean ? (R.done ?? '✅')
        : (failed ? (R.failed ?? '⚠️') : (allSkipped() ? (R.skipped ?? '⏭️') : (R.cancelled ?? '❌')));
      // "2 of 3 posted, 1 failed" reads as a sentence; leading with the raw
      // counts does not.
      const extra = countsProse({ failed, cancelled, skipped });
      // Only point at the posts group when something actually landed there.
      // "0 of 3 posted - see the posts group" sends people to look at nothing.
      const posted = completed > 0;
      const note = clean
        ? (single ? 'posted! Check {group}' : `all ${total} episodes posted! Check {group}`)
        : `${completed} of ${total} posted, ${extra.join(', ')}${posted ? ' — see {group}' : ''}`;
      const then = posted ? nextNotice(next) : '';
      this._notify(ctx, `${emoji} ${label} — ${note}${then ? `\n${then}` : ''}`, msg,
        { tagGroup: posted ? this._tagTarget(ctx) : null, route });
      try { onFinish?.({ completed, failed, cancelled, skipped, why }); } catch { /* reporting only */ }
      // Followers end on what the request's own message ends on; they never
      // saw its ❌, so a cancelled request still sends them one.
      this._tellTvFollowers(ctx, reqKey, {
        status: clean ? 'sent' : (completed === 0 ? (failed ? 'failed' : (allSkipped() ? 'skipped' : 'cancelled')) : 'partial'),
        emoji: ending() ?? emoji, why,
      });
    };
    const done = () => { if (reqKey && this._notifiers?.get(reqKey) === api) this._notifiers.delete(reqKey); };

    const api = {
      /** The episodes the request holds: fewer once some are trimmed off (episodeTrimmed). */
      get total() { return total; },
      /** How many were trimmed off it. */
      get trimmed() { return trimmed; },
      /** What the episode limit left out of it (cap-cut.js), or null. */
      get cut() { return cut; },
      /** Named again, as trimQueued leaves it (see above). */
      retitle: (to = {}) => {
        if (to.label) label = to.label;
        if ('cut' in to) cut = to.cut ?? null;
        if ('next' in to) next = to.next ?? null;
      },
      /** Has every episode reported, so the request has concluded? */
      isFinished: () => finished,
      /** The reaction the request's message ends on, or null (see above). */
      ending,
      /** Announce a stage once for the whole request. */
      stage: (key, emoji, verb) => {
        if (stagesSent.has(key)) return;
        stagesSent.add(key);
        const suffix = single ? '' : ` (${total} episodes)`;
        this._notify(ctx, `${emoji} ${label} — ${verb}${suffix}`, msg, { route });
      },
      /** One episode finished; only the last one reports. */
      episodeDone: () => { completed++; conclude(); },
      /** One episode failed; the request still reports once at the end. */
      episodeFailed: (reason) => {
        failed++;
        why = reason ?? why;
        // A single-episode request should say what went wrong immediately.
        if (single) {
          finished = true;
          done();
          this._notify(ctx, `${R.failed ?? '⚠️'} ${label} — ${reason}`, msg, { route });
          try { onFinish?.({ completed, failed, cancelled, skipped, why }); } catch { /* reporting only */ }
          this._tellTvFollowers(ctx, reqKey, { status: 'failed', emoji: R.failed ?? '⚠️', why });
          return;
        }
        conclude();
      },
      /**
       * Cancelled or set aside - still an outcome, so the request can close.
       * `state` is the queue's: 'skipped' when an admin skipped this one
       * episode, which ending() does not count against the request.
       */
      episodeCancelled: (state = 'cancelled') => {
        cancelled++;
        if (state === 'skipped') skipped++;
        conclude();
      },
      /**
       * One episode taken off the request by trimQueued, an admin keeping
       * what was queued to the episode limit: not an ending of it at all.
       * The request is one episode smaller - its total; its name the trim
       * gave it first (retitle) - so it ends on ✅ once what it kept is
       * posted, "all 10 episodes posted", not on the ❌ a cancel would
       * leave, or ⚠️ or ⏭️. Its last episode to report can be this one, when
       * it had done more than the limit already.
       */
      episodeTrimmed: () => {
        total = Math.max(0, total - 1);
        trimmed++;
        conclude();
      },
    };
    // By its request, while it runs, for the trim to name it again
    // (_trimRequest): a request from a group keeps its notifier in its
    // jobs' closures alone, out of reach of a trim before its first episode
    // is taken off.
    if (reqKey) (this._notifiers ??= new Map()).set(reqKey, api);
    return api;
  },

  /**
   * Record a TV request in the shared history, so the History tab shows what
   * was asked for here too - it previously only ever listed movies.
   *
   * One row per REQUEST, keyed on the message, updated as the season
   * progresses. A season is one thing somebody asked for, not fifteen.
   */
  _history(ctx, row) {
    try {
      // Written to this plugin's OWN namespace; the API merges the movie and
      // TV histories for the History tab, which keeps the two stores separate.
      const hist = ctx.store.get('history', []) ?? [];
      // A note or a journal written before 2026-10-01 carries the number as
      // "+1 (555) 807-0190"; the row is written as +15558070190.
      if (row.requesterNumberDisplay) row = { ...row, requesterNumberDisplay: phoneOut(row.requesterNumberDisplay) };
      const i = hist.findIndex((h) => h.id === row.id);
      if (i >= 0) hist[i] = { ...hist[i], ...row };
      else hist.unshift(row);
      if (hist.length > 500) hist.length = 500;
      ctx.store.set('history', hist);
    } catch (err) { ctx.log.debug(`tv history write failed: ${err.message}`); }
  },

  /*
   * Followers: requests answered as duplicates of one journalled request,
   * told how it ends. As on the film side (movie-requests _tellFollowers): a
   * duplicate was answered 🎬 and a "duplicate" row, and nothing remembered
   * its message, so a failure or a cancel of the request that held its
   * episodes never reached it. Each follower is written on that request's
   * journal entry, so it outlives a restart, and kept here too, because an
   * episode cancelled while waiting for its retry leaves the journal before
   * its request hears the outcome. A follower gets the request's outcome as
   * a whole: one asking for an episode inside a season that partly posted
   * hears "partial", whether or not that episode was the one missing.
   */

  /**
   * A request's react(), skipping an emoji its message already shows or is
   * about to. `send(emoji)` resolves true once the reaction really went, and
   * false when the budget shed it or it was withheld.
   *
   * It used to note the emoji as shown before bot.react answered, and ignore
   * a false: a 🔄 the budget shed at a restart was believed shown, and the
   * 🔄 of the episode's own retry was then skipped as a repeat - the message
   * never showed it. src/media/place-reaction.js had the same trap with
   * place numbers ("recorded optimistically, a shed number was believed
   * shown and suppressed for good").
   */
  _sameTwiceSkipped(send) {
    let shown = null;                          // what the message shows, as far as we know
    let asking = null;                         // on its way, so a second ask folds into it
    const react = (emoji) => {
      if (!emoji || emoji === shown || emoji === asking) return Promise.resolve();
      asking = emoji;
      // Asked for now, not a tick later: the pacer keeps arrival order, and
      // onMessage relies on the 🎬 going in ahead of the place number.
      let pending;
      try { pending = Promise.resolve(send(emoji)); } catch (err) { pending = Promise.reject(err); }
      return pending
        .then((sent) => { if (sent !== false) shown = emoji; })
        .catch(() => { /* the message may be long gone */ })
        .finally(() => { if (asking === emoji) asking = null; });
    };
    // Something else has been put on the message - a place number, which
    // goes by its own path (place-reaction.js) - so what it shows is no longer
    // what was last sent here. Only a message shared by several seasons needs
    // this: its next season's number can land after a stage, and that
    // season's own ⬇️ was then skipped as the ⬇️ already showing.
    react.forget = () => { shown = null; };
    return react;
  },

  /**
   * The journalled request that holds most of `episodes` for `route`'s
   * destination - the one a duplicate follows - or null.
   */
  _holderOf(ctx, episodes, route) {
    const want = destinationOf(route);
    const ids = new Set(episodes.map((e) => String(e.id)));
    let best = null;
    let most = 0;
    for (const req of ctx.store.get('pending', []) ?? []) {
      if (destinationOf(req.route) !== want) continue;
      const n = (req.episodes ?? []).filter((e) => ids.has(String(e.id))).length;
      if (n > most) { best = req; most = n; }
    }
    return best;
  },

  /**
   * A member sending their own request again - the same episodes, all in
   * one request of theirs still waiting or in progress (_ownHolderOf): no
   * 🤥, which is for somebody asking for episodes already queued for the
   * group. As the film side answers it (movie-requests _resentFilm, which
   * has the incident: Iron Man 3, 2026-10-11, shown 🔄 after a restart, sent
   * again, and given 🤥). Their new message shows where the request is now -
   * 🎬 and its place in line while it waits, kept current with its
   * requester's, or the stage it is at (_showResend) - and follows it to its
   * end as a duplicate does (_tellTvFollowers). One of several seasons asked
   * for in one message leaves the reaction to _runSeasons, as a duplicate
   * does.
   *
   * Nothing is held against them: the row is 'resent', pointing at their
   * first (`resendOf`) - not a duplicate, never a request of its own to the
   * hourly check's repeat-request findings (incident-scan.js requestChains),
   * never re-run - and the outcome 'resent' is not counted towards the flood
   * backstop (NOT_COUNTED). The notifications group is told what a
   * duplicate's line tells it (`line`), under 🎬 rather than 🤥: asking again
   * for a season the rating filter cut is what its missing episodes prompt,
   * and that line names them (FMA's S01E14, 2026-09-28).
   *
   * The first time. Sent again once more (`again`), the outcome is
   * 'resent-again', which the backstop counts, and the notifications group,
   * told once, is not told again: uncounted, with a line each and each
   * message following the line, eight resends were eight lines and eight
   * reactions on every move of the line (found in review, 2026-10-11).
   */
  async _resentTv(ctx, { msg, route, react, batch, holder, own, which, found, typed, withheld, screened, row, line }) {
    const before = this._followers?.get(holder.reqKey) ?? holder.followers ?? [];
    const again = before.some((f) => f?.resend && f.msgId !== msg.id);
    ctx.log.info(`📺 ${which} was asked for ${again ? 'once more' : 'again'} by the member it is queued for - `
      + 'showing them where it is, not queueing it again');
    if (line && !again) this._notify(ctx, line, msg, { route });
    this._addTvFollowers(ctx, holder, [{
      msgId: msg.id, msgKey: batch ? null : (msg.key ?? null), chatJid: msg.chatJid, historyId: row.id, route: route ?? null,
      resend: true,
    }]);
    this._history(ctx, {
      id: row.id, kind: 'tv', at: Date.now(), requestedAt: msg.timestamp || Date.now(),
      requester: msg.pushName ?? null, requesterJid: msg.senderJid ?? null,
      requesterNumber: msg.senderNumber ?? null, requesterNumberDisplay: msg.senderNumberDisplay ?? null,
      groupJid: msg.chatJid, request: row.request, ...typed, title: found.series.name, year: found.series.year ?? null,
      season: found.season ?? null, episodes: 0, status: 'resent',
      detail: 'sent again by the member while their request was still in the queue — the same request, not a second one'
        + withheldSuffix(withheld?.detail) + withheldSuffix(screened?.detail),
      ...(own.historyId && own.historyId !== row.id ? { resendOf: own.historyId } : {}),
      ...(withheld ? { withheld: withheld.detail } : {}),
      ...(screened ? { override: screened.detail } : {}),
    });
    if (batch) {
      batch.dups.push(holder.reqKey);
      batch.resent.push(holder.reqKey);
      if (again) batch.again.push(holder.reqKey);
    } else {
      await this._showResend(ctx, { holder, msg, route, react });
    }
    return { outcome: again ? 'resent-again' : 'resent' };
  },

  /**
   * What a member's own request, sent again (_resentTv), shows on the new
   * message: while the request waits, 🎬 and then its place, kept current as
   * the line moves (_followPlace) - as their first message was given 🎬
   * before its number; otherwise the stage it is at (_whereNowTv).
   *
   * The 🎬 first because the number is 'low', the first thing the budget
   * sheds, and is withdrawn at its turn if the request has started by then:
   * with the number alone, a message sent again was left on 🔍, "looking it
   * up", to the end (found in review, 2026-10-11) - which asks for yet
   * another resend. It is one reaction for the 🤥 it had before 2026-10-11.
   */
  async _showResend(ctx, { holder, msg, route, react }) {
    const waiting = () => (ctx.queue?.snapshot?.().pending ?? []).some((it) => (it.group ?? it.id) === holder.reqKey);
    let shown = null;
    if (msg?.key && waiting()) {
      shown = this._react(ctx).added;
      await react(shown);
      if (this._followPlace(ctx, holder.reqKey, msg, route, { resend: true })) return;
    }
    // Started meanwhile, or running already.
    const where = this._whereNowTv(ctx, holder);
    if (where !== shown) await react(where);
  },

  _addTvFollowers(ctx, req, followers) {
    if (!req?.reqKey || !followers.length) return;
    this._followers ??= new Map();
    const list = [...(this._followers.get(req.reqKey) ?? req.followers ?? []), ...followers];
    this._followers.set(req.reqKey, list);
    req.followers = list;
    const pending = ctx.store.get('pending', []) ?? [];
    const entry = pending.find((r) => r.reqKey === req.reqKey);
    if (entry) { entry.followers = list; ctx.store.set('pending', pending); }
  },

  _tellTvFollowers(ctx, reqKey, { status, emoji, why = null }) {
    if (!reqKey) return;
    const list = this._followers?.get(reqKey)
      ?? (ctx.store.get('pending', []) ?? []).find((r) => r.reqKey === reqKey)?.followers ?? [];
    this._followers?.delete(reqKey);
    if (!list.length) return;
    const detail = status === 'sent'
      ? 'posted, with an earlier request for it'
      : `${status}, with an earlier request for it${why ? ` — ${why}` : ''}`;
    // A member's own request sent again (_resentTv) stays "resent": it was
    // never a request of its own, so its row is not counted as a second
    // season posted, or failed, and only says how the first one ended.
    const resentDetail = `${status === 'sent' ? 'posted' : status}, with their first request for it`
      + `${why && status !== 'sent' ? ` — ${why}` : ''}`;
    const kind = reactionKind(this._react(ctx), emoji);
    for (const f of list) {
      const handoff = this._handoffs?.get(f.msgId);
      if (handoff) handoff.ended = true;                   // see _updatePositions
      if (f.historyId) {
        this._history(ctx, f.resend
          ? { id: f.historyId, detail: resentDetail, at: Date.now() }
          : { id: f.historyId, status, detail, at: Date.now() });
      }
      if (!emoji || !f.msgKey || safeRoute(ctx.config, f.route)?.originIsMain) continue;   // see onMessage
      ctx.bot.react({ id: f.msgId, key: f.msgKey, chatJid: f.chatJid }, emoji, { kind }).catch?.(() => {});
    }
    ctx.log.info(`📺 told ${list.length} request(s) that followed it: ${status}`);
  },

  /**
   * A TV test that got as far as the queue: every check a real request meets
   * has passed, so nothing is queued, downloaded or journalled - the
   * operator's rule (2026-09-29, see beta.js). The member gets ✅ and a quoted
   * "Test passed" with what a real request would have been told: the
   * episodes it would queue, and what the feature under test says about them
   * (the withheld episodes, where tv-rating-notice is on; the ones already
   * waiting, where tv-duplicate-notice is). History keeps a 'test-passed'
   * beta row: the digest and the activity record count it apart from
   * members' requests, and the hourly check's history findings skip it
   * (incident-scan.js), as they skip every beta row. One season of several is answered with the rest of
   * the message (_answerSeasons), in one reply.
   *
   * A test maxEpisodesPerRequest cut (`cutOff`, _capCutOf) says what a real
   * request is told about it - which episodes went in, and the next part to
   * send, with the test's code - as a paragraph of the answer, and one of
   * several seasons in the message's one reply, as a real one is.
   */
  async _testPassedTv(ctx, {
    msg, route, react, found, parsed, scope, queueing, allowed, withheld, screened, say, R, batch = null,
    rowId, rowText, typed = {}, also = '', cutOff = null,
  }) {
    const code = testCodeOf(route);
    const single = isSingleEpisode(parsed);
    const what = single ? episodeLabel(queueing[0]) : `${queueing.length} episode(s) of ${found.series.name} ${scope}`;
    const told = this._queuedLine({ R, found, parsed, scope, list: queueing, allowed, withheld, screened, say });
    // `what` stays plain for History and the log; `words` is how the reply
    // says it, with the show's name in bold.
    const n = queueing.length;
    const words = single ? `*${plainText(what)}*`
      : `${n} episode${n === 1 ? '' : 's'} of *${plainText(found.series.name)}* ${scope}`;
    const pass = { what: `${what}${also}`, words: `${words}${also}`, notes: told.notes };
    if (cutOff && batch) batch.cut.push({ season: found.season, ...cutOff });
    else if (cutOff) pass.cut = cutReply(cutOff.cut, { lead: `*${plainText(found.series.name)}* ${scope}`, ask: cutOff.ask });
    this._history(ctx, {
      id: rowId, kind: 'tv', at: Date.now(), requestedAt: msg.timestamp || Date.now(),
      requester: msg.pushName ?? null, requesterJid: msg.senderJid ?? null,
      requesterNumber: msg.senderNumber ?? null, requesterNumberDisplay: msg.senderNumberDisplay ?? null,
      groupJid: msg.chatJid, request: rowText, ...typed,
      title: found.series.name, year: found.series.year ?? null, season: found.season ?? null,
      episodes: queueing.length, status: 'test-passed',
      detail: `test${code ? ` ${code}` : ''}: would queue ${pass.what} — nothing was downloaded`
        + withheldSuffix(withheld?.detail) + withheldSuffix(screened?.detail),
      beta: true, ...(code ? { test: code } : {}),
      ...(withheld ? { withheld: withheld.detail } : {}),
      ...(screened ? { override: screened.detail } : {}),
    });
    ctx.log.info(`🧪 TV test passed${code ? ` (${code})` : ''}: would queue ${pass.what} - nothing downloaded or queued`);
    // For the hourly check's reading of the test group (beta-scan.js): what
    // the test settled on, next to what the tester typed.
    ctx.bot.transcript?.note?.(msg.chatJid, {
      ref: msg.id, note: `test passed: ${pass.what}`, event: 'test-passed',
      show: { title: found.series.name, season: found.season ?? null },
    });
    if (batch) { batch.tests.push(pass); return { outcome: 'test-passed' }; }
    await react(R.done ?? '✅');
    try { await ctx.bot.sendText(msg.chatJid, this._testPassedWords(route, [pass]), { quoted: msg }); }
    catch (err) { ctx.log.warn(`could not say the test passed: ${err.message}`); }
    return { outcome: 'test-passed' };
  },

  /**
   * "✅ *Test passed* ($beta003)", then what the bot would queue, for one
   * season or several. In paragraphs, with anything withheld as a paragraph
   * of its own, as the operator asked of the testing group's replies on
   * 2026-09-30: "message needs to be neater paragraphed".
   */
  _testPassedWords(route, passes) {
    const code = testCodeOf(route);
    const notes = passes.flatMap((p) => p.notes ?? []);
    const cuts = passes.map((p) => p.cut).filter(Boolean);
    return `✅ *Test passed*${code ? ` ($${code})` : ''}\n\n`
      + `The bot would queue ${passes.map((p) => p.words ?? p.what).join(', ')}.\nNothing was downloaded.`
      + (notes.length ? `\n\n${notes.join(' ')}` : '')
      + cuts.map((c) => `\n\n${c}`).join('');
  },

  /**
   * A TV request the rating gate refused outright: the series is rated, or
   * every episode asked for is.
   *
   * This was a ⛔ and nothing else - no reply, no notification, no History
   * row - so "fullmetal alchemist brotherhood S01E14", asked twice on
   * 2026-09-28, left no trace a member or the owner could read. It now gets
   * what a film refused on rating gets (movie-requests' finish('blocked-rating')):
   * the ⛔, a quoted reply in the request group only when replyOnBlock is on,
   * the "⛔ … rated X, can't be posted" line wherever this request's updates go
   * (the movie side's `blocked` step switch applies to it here too), and a
   * 'blocked-rating' row in History. The row is written always; the reply and
   * the line only where the tv-rating-notice beta flag is on for the group
   * the request came from (`say`).
   *
   * `quiet` records it and reacts without saying it again: every season of a
   * message asking for several is refused alike when the show itself is
   * rated. `rowId` and `typed` are the row's id and the member's own words
   * for one season of several (_runSeason); `text` is then that season.
   */
  async _refuseOnRating(ctx, {
    msg, text, found, route, react, say = false, rated, detail, line, reply, withheld = null,
    status = 'blocked-rating', override = null, quiet = false, rowId = null, typed = null,
  }) {
    this._history(ctx, {
      id: rowId ?? msg.id ?? `tv-${Date.now()}`,
      kind: 'tv',
      at: Date.now(),
      requestedAt: msg.timestamp || Date.now(),
      requester: msg.pushName ?? null,
      requesterJid: msg.senderJid ?? null,
      requesterNumber: msg.senderNumber ?? null,
      requesterNumberDisplay: msg.senderNumberDisplay ?? null,
      groupJid: msg.chatJid,
      request: text,
      ...(typed ? { typed } : {}),
      title: found.series.name,
      year: found.series.year ?? null,
      season: found.season ?? null,
      episodes: 0,
      status,
      rated,
      detail,
      ...(route ? { beta: true, ...(route.test ? { test: route.test } : {}) } : {}),
      ...(withheld ? { withheld: withheld.detail } : {}),
      ...(override ? { override } : {}),
    });
    // The reply and the line are group text, behind the beta flag (`say`,
    // withheld.js). Off, the request gets the bare ⛔ it always did - and the
    // row above, which is the owner's.
    // Off unless movieRequests.announceRated is on: a rating refusal is the
    // ⛔ alone, with no reply and no notifications line (the operator,
    // 2026-10-21, "if something gets denied it gets denied simple reaction is
    // enough"). The History row above is written either way.
    if (ctx.config.movieRequests?.announceRated !== true) say = false;
    if (say && !quiet && ctx.config.movieRequests?.replyOnBlock) {
      try { await ctx.bot.sendText(msg.chatJid, reply, { quoted: msg }); }
      catch (err) { ctx.log.warn(`could not reply: ${err.message}`); }
    }
    if (say && !quiet) this._notify(ctx, line, msg, { route, step: 'blocked' });
    await react(this._react(ctx).rated);
  },

  /**
   * Decide the rating-blocked episodes: sent on the bypass list, or put to
   * the AI check where it could clear them (override-check.js). Null when
   * there is nothing to decide - or when the screening itself fails, so a
   * fault here leaves the episodes withheld on their rating, which is where
   * they were, rather than letting them out. `budget` is the AI check's
   * budget of the message this is one season of (_runSeasons), or null.
   */
  async _screenRated(ctx, { found, blocked, seriesRating, waiting = null, limit = Infinity, budget = null }) {
    const jf = ctx.config.library?.jellyfin ?? {};
    const g = ctx.config.gemini ?? {};
    try {
      return await screenRated({
        found, blocked, seriesRating, waiting, limit, budget,
        overrides: ctx.overrideStore ?? null,
        cache: ctx.store,
        gemini: g,
        ai: ctx.config.ai,
        minConfidence: Number(g.minContentConfidence ?? 0.7),
        jellyfin: {
          base: String(jf.baseUrl ?? '').replace(/\/+$/, ''),
          token: jf.accessToken || jf.apiKey,
          userId: jf.userId,
        },
        // Counted with the film checks, so a check that keeps failing on
        // episodes raises the same alarm (content-check-health.js).
        onResult: (r, { subject }) => ctx.contentHealth?.record({
          ...r, title: subject, year: found.series.year ?? null, source: 'tv episode',
        }).catch((err) => ctx.log.warn(`content check health: ${err.message}`)),
        log: ctx.log,
      });
    } catch (err) {
      ctx.log.warn(`TV bypass list and AI check failed for ${found.series?.name}: ${err.message} — the rating decides`);
      return null;
    }
  },

  /**
   * Post a line to the notifications group, if one is configured.
   *
   * `tagGroup` turns a "{group}" placeholder into a tappable mention of the TV
   * posts group, the same way the movie side links to the movie posts group -
   * "posted! Check @TV POSTS ONLY" beats naming a group with no way to reach it.
   *
   * A beta request (`route.beta`) is reported in the beta group it came from
   * and never in the main notifications group, for the same reason as on the
   * movie side: the main group is for real members' requests.
   *
   * `step` names the movie side's per-step switch (notify.steps) a line obeys.
   * Only the rating refusal passes one, so that switching off the movie
   * side's `blocked` lines silences the TV ones as well; every other TV line
   * is sent as it always was.
   */
  _notify(ctx, text, msg, { tagGroup = null, route = null, step = null, refusal = false } = {}) {
    const n = ctx.config.movieRequests?.notify ?? {};
    // A refused request is its reaction alone: the notifications group is for
    // what is actually downloaded and sent (the operator, 2026-10-21). The
    // movie side's notifyRefusals brings these lines back for both.
    if (refusal && ctx.config.movieRequests?.notifyRefusals !== true) return;
    // The stored route, re-checked against today's config: once the beta group
    // has itself become a main group, a test has nothing more to say there.
    const beta = safeRoute(ctx.config, route);
    const target = beta ? beta.notifyGroup : n.group;
    if (!target) {
      if (beta) ctx.log.debug(`tv notify (beta) withheld - the beta group is now a main group: ${text}`);
      return;
    }
    if (step && n.steps?.[step] === false) return;
    if (!ctx.bot.isConnected()) return;
    // Whatever group a caller asked to link to, a beta request links only to
    // where it was actually posted. Enforced here, the one place every TV
    // notification passes through, rather than trusted to each caller - a
    // "Check @TV POSTS ONLY" under a test would send testers into the real
    // posts group looking for something that was never there.
    const tag = beta ? (tagGroup ? beta.postsGroup : null) : tagGroup;
    const { body, groupMentions } = applyGroupTag(ctx.bot, {
      body: text, notifyGroup: target, tagGroup: tag, enabled: n.tagPostsGroup !== false,
    });
    ctx.bot.sendText(target, body, { groupMentions })
      .then(() => {
        if (groupMentions) ctx.log.info(`🔔 tv notify +group: ${text}`);
      })
      .catch((err) => ctx.log.debug(`tv notify failed: ${err.message}`));
  },

  /**
   * Which posts group to link to. TV can be configured with several; the first
   * is the one worth pointing at, and tagging all of them would be noise.
   * (A beta request's tag is swapped for its own destination in _notify.)
   */
  _tagTarget(ctx) {
    return postsTargets(ctx.config.tvRequests)[0] ?? null;
  },

  /** Download -> convert (if needed) -> send to every posts group. */
  /**
   * Journal a queued request so a restart can pick it back up.
   *
   * The queue lives in memory. Movies have been journalled for a while; TV was
   * not, and it cost 47 episodes in one restart - American Dad season 2,
   * The Summer I Turned Pretty season 2 and The Mentalist season 1 all vanished
   * with no trace and nothing told the people who asked for them.
   *
   * Journalled per REQUEST rather than per episode, because a season shares one
   * notifier and one history row; recovering episodes individually would report
   * "1 of 1 posted" twenty-three times.
   */
  _journalAdd(ctx, entry) {
    const all = ctx.store.get('pending', []) ?? [];
    // When it first started stays with it (_journalStarted): onMessage
    // writes the entry again once it knows what the queue took, and an
    // episode may have started in between.
    const was = all.find((r) => r.reqKey === entry.reqKey);
    if (Number(was?.startedAt) > 0 && !(Number(entry.startedAt) > 0)) entry = { ...entry, startedAt: was.startedAt };
    // And 0 until then, so recovery knows this version wrote it and that it
    // has not started, whatever work it holds (_startOf), as on the movie
    // side. Only an entry an older version journalled is left without it.
    else if (entry.startedAt == null && (!was || was.startedAt != null)) entry = { ...entry, startedAt: 0 };
    // The numbers of every episode it was queued with, as runs: the journal
    // lets an episode go once it ends, and a trim to the episode limit names
    // the request by what it still holds (trimQueued _trimWords). Not when
    // one has no number to name it by.
    if (!entry.numbers && Array.isArray(entry.episodes) && entry.episodes.every((e) => numbersOf(e).length)) {
      entry = { ...entry, numbers: runsOf(entry.episodes.flatMap(numbersOf)) };
    }
    const pending = all.filter((r) => r.reqKey !== entry.reqKey);
    pending.push(entry);
    ctx.store.set('pending', pending);
  },

  /**
   * Write on a journalled request when its first episode started, once: a
   * restart's recovery puts a season that had started back in as running,
   * ahead of every request waiting (_resumeLeftover, _pump), as the movie
   * side does a film (Thor: The Dark World, 2026-10-11). An episode waiting
   * for the download slot has nothing on disk yet to say so.
   */
  _journalStarted(ctx, reqKey) {
    if (!reqKey) return;
    try {
      const pending = ctx.store.get('pending', []) ?? [];
      const req = pending.find((r) => r.reqKey === reqKey);
      if (!req || Number(req.startedAt) > 0) return;
      req.startedAt = Date.now();
      ctx.store.set('pending', pending);
    } catch (err) { ctx.log?.warn?.(`TV: could not journal that ${reqKey} started: ${err.message}`); }
  },

  /**
   * When a journalled request's first episode had started, or null if none
   * had. Its journal entry says (_journalStarted), and a version that
   * records starts writes 0 on every entry until then (_journalAdd). Only an
   * entry journalled before starts were recorded has nothing to say: it had
   * started if an episode of it ended before the restart, or has work on
   * disk, which only a run makes. Read for every entry, work on disk brought
   * back as running a film that had only taken a parked request's work over,
   * in review of the Thor change (2026-10-11; the movie side's _startOf).
   */
  _startOf(ctx, req) {
    const at = Number(req?.startedAt);
    if (at > 0) return at;
    if (req?.startedAt != null) return null;
    let first = Infinity;
    for (const ep of req?.episodes ?? []) {
      const w = episodeWork(ctx, req.reqKey, ep.id, episodeLabel(ep));
      if (w?.has()) first = Math.min(first, Number(w.manifest.createdAt) || Infinity);
    }
    if (Number.isFinite(first)) return first;
    const t = req?.tally ?? {};
    return (t.completed || t.failed) ? (Number(req.baseRow?.at) || 1) : null;
  },

  /**
   * Tell the queue what the last process left (queue.expectBack), before
   * anything is put back: each request's member, when it was asked for, and
   * whether it had started (_startOf). The seasons go back after the films
   * (holdTvRecovery), and a film's place used to be decided before they were
   * back: in review of the Thor change (2026-10-11) Ethan's waiting film,
   * ranked before his running Loki season was back, came back as his first
   * request, passed Ari's first and started in the free slot. Told first,
   * the queue ranks it as his second, and keeps the season's slot until it
   * is back.
   */
  _expectBack(ctx, leftover) {
    if (typeof ctx.queue?.expectBack !== 'function') return;
    const list = [];
    for (const r of ctx.store.get('pending', []) ?? []) {
      if (leftover && !leftover.has(r.reqKey)) continue;
      let started = false;
      try { started = this._startOf(ctx, r) != null; } catch (err) {
        ctx.log?.warn?.(`TV: could not tell whether "${r.label}" had started: ${err.message}`);
      }
      list.push({
        key: r.reqKey,
        // As the request's group will carry it (_groupOf): its member, its
        // requester, which says whether it came from the panel, and whether
        // it was asked for inside the member's cooldown.
        meta: {
          memberKey: r.memberKey ?? null, requester: r.requester ?? null,
          ...(r.insideCooldown ? { insideCooldown: r.insideCooldown } : {}),
        },
        at: Number(r.baseRow?.at) || null,
        started,
        label: String(r.label ?? r.reqKey),
      });
    }
    try { ctx.queue.expectBack(list); } catch (err) { ctx.log?.warn?.(`TV: could not tell the queue what comes back: ${err.message}`); }
  },

  /**
   * `outcome` is how the episode ended - 'done', 'failed', 'cancelled' or
   * 'skipped' (and `why`, a failure's reason) - counted on the request's
   * `tally` as the episode leaves the journal. A restart resumes the rest of
   * the request with those counts (_resumeLeftover). Without them (found in
   * review, 2026-09-29), a ten-episode season whose E02 had failed for good,
   * restarted by the hourly check into a fix while E05 ran, came back as a
   * six-episode request with nothing failed: it ended on ✅, History said
   * "sent", its followers were told ✅, and nobody heard E02 was missing.
   *
   * The episode's work goes with it - nothing will resume from it now -
   * unless `keepWork`: deliverEpisode, which holds it open, deals with its
   * own.
   */
  _journalEpisodeDone(ctx, reqKey, epId, outcome = null, why = null, { keepWork = false } = {}) {
    if (!reqKey) return;
    if (!keepWork) this._dropEpisodeWork(ctx, reqKey, epId);
    const pending = ctx.store.get('pending', []);
    const req = pending.find((r) => r.reqKey === reqKey);
    if (!req) return;
    const had = (req.episodes ?? []).some((e) => String(e.id) === String(epId));
    if (had && outcome) {
      const t = (req.tally ??= { completed: 0, failed: 0, cancelled: 0, skipped: 0 });
      // Which ones it posted, too: its member sending the request again
      // while the rest is still to come is the same request (_ownHolderOf),
      // not a new one for the episodes posted already.
      if (outcome === 'done') { t.completed += 1; (req.posted ??= []).push(String(epId)); }
      else if (outcome === 'failed') { t.failed += 1; if (why) t.why = why; }
      // Taken off the request (trimQueued): no ending of it, and not part of
      // it any more, so a restart resumes the smaller request it is - its
      // total counts the other three (_resumeLeftover).
      else if (outcome === 'trimmed') t.trimmed = (t.trimmed ?? 0) + 1;
      else { t.cancelled += 1; if (outcome === 'skipped') t.skipped += 1; }
    }
    req.episodes = (req.episodes ?? []).filter((e) => String(e.id) !== String(epId));
    this._live?.get(reqKey)?.queued.delete(`${reqKey}:${epId}`);

    if (req.episodes.length) {
      ctx.store.set('pending', pending);
      // A finished episode has just freed a slot. If this request was too big
      // for the queue, that is how the rest of it gets in.
      try { this._pump(ctx); } catch (err) { ctx.log.warn(`TV pump failed: ${err.message}`); }
    } else {
      ctx.store.set('pending', pending.filter((r) => r.reqKey !== reqKey));
      this._live?.delete(reqKey);
    }
  },

  /** Forget a request that never made it into the queue at all, and any work of its episodes. */
  _journalDrop(ctx, reqKey) {
    const req = (ctx.store.get('pending', []) ?? []).find((r) => r.reqKey === reqKey);
    for (const e of req?.episodes ?? []) this._dropEpisodeWork(ctx, reqKey, e.id);
    ctx.store.set('pending', ctx.store.get('pending', []).filter((r) => r.reqKey !== reqKey));
    // Not coming back after a restart either (queue.expectBack).
    ctx.queue?.forgetExpected?.(reqKey);
  },

  /**
   * Delete an episode's work, through the delete guard, when nothing will
   * resume from it. Never under a run that has it open.
   */
  _dropEpisodeWork(ctx, reqKey, epId) {
    if (!reqKey || epId == null) return;
    forgetKept(`${reqKey}:${epId}`);
    try { episodeWork(ctx, reqKey, epId)?.drop(); } catch (err) {
      ctx.log?.warn?.(`could not remove the work of ${reqKey}:${epId}: ${err.message}`);
    }
  },

  /**
   * Is there room in the shared queue for one more request? A request is one
   * place however many episodes it has (src/core/queue.js). A queue without
   * hasRoom() is a test's stand-in, counted the old way. Requests held for a
   * restart's recovery (_holdForRecovery) take their places already.
   */
  _hasRoom(ctx) {
    const held = [...(this._live?.values() ?? [])].filter((l) => l.held && !l.queued.size).length;
    if (typeof ctx.queue.hasRoom === 'function') return ctx.queue.hasRoom(1 + held);
    // 0 is no limit, as in the queue itself (queue.js _waitLimit).
    const max = Number(ctx.queue.maxLength ?? 0);
    return (ctx.queue.pending?.length ?? 0) + held < (max > 0 ? max : Infinity);
  },

  /**
   * Hold a request that has just been accepted - journalled, its notifier
   * made - out of the queue while the requests from before a restart are
   * waiting to be put back (recoverPending), and answer true; answer false,
   * holding nothing, the rest of the time.
   *
   * TV recovery waits for the films to be re-resolved first, which takes
   * seconds and can take minutes, and it used to put the old requests at the
   * back of the queue when it ended: a TV request asked for in those seconds
   * had already gone in, so it was ahead of every request from before the
   * restart - and, with nothing else in the queue yet, could start straight
   * away. Held here, it is let in by the same _pump that puts the old ones
   * back, after them, in journal order, where its place number starts too.
   * Until then its episodes count as waiting (_waitingEpisodeIds), so a
   * duplicate of it is still caught.
   */
  _holdForRecovery(ctx, { reqKey, label, notifier, msg, react, discard, share = null }) {
    if (!this._awaitingRecovery) return false;
    (this._live ??= new Map()).set(reqKey, { notifier, msg, react, discard, share, queued: new Set(), held: true });
    ctx.log.info(`📺 ${label} waits for the requests from before the restart to go back in the queue first`);
    return true;
  },

  /**
   * What an episode does when the queue throws it away before it ever ran:
   * its request was cancelled, or the waiting list cleared.
   *
   * deliverEpisode never runs for it, so before this nothing reported it at
   * all: the notifier waited for an outcome that never came, leaving the
   * request "queued" in History for ever, and the journal kept the episode,
   * so the next restart queued the cancelled season all over again. The
   * requester gets one reaction and the log one line per request, not one
   * per episode.
   */
  _discarder(ctx, { reqKey, label, notifier, react = null }) {
    let told = false;
    return (ep) => (state) => {
      // Taken off by trimQueued (queue.trim): the request is smaller, not
      // cancelled, so no ❌ and no booked retry dropped. Its member is told
      // in words, once, by trimQueued; the message ends on the request's
      // outcome if this was the last of it to report.
      if (state === 'trimmed') {
        notifier?.episodeTrimmed?.();
        this._journalEpisodeDone(ctx, reqKey, ep.id, 'trimmed');
        this._reactEnding(ctx, notifier, react);
        return;
      }
      notifier?.episodeCancelled(state);
      this._journalEpisodeDone(ctx, reqKey, ep.id, state === 'skipped' ? 'skipped' : 'cancelled');
      if (!told) {
        told = true;
        if (state !== 'skipped') this._dropBookedRetries(ctx, reqKey, state);
        ctx.log.warn(`TV ${state} before it started: ${label}`);
        const R = this._react(ctx);
        react?.(state === 'skipped' ? R.skipped : R.cancelled);
      }
      // A skipped episode can be the last of its request to report: the
      // message still ends on the request's outcome, after the ⏭️.
      this._reactEnding(ctx, notifier, react);
    };
  },

  /**
   * Once `notifier`'s request has concluded, put what it ends on (⚠️ or ✅,
   * the notifier's ending()) on the requester's message. Called by whatever
   * reported the request's last episode: its send, or a skip or cancel.
   */
  _reactEnding(ctx, notifier, react) {
    if (typeof notifier?.isFinished !== 'function' || !notifier.isFinished()) return undefined;
    const end = typeof notifier.ending === 'function' ? notifier.ending() : this._react(ctx).done;
    return end ? react?.(end) : undefined;
  },

  /**
   * Show each waiting TV request its place in line, as a number reaction on
   * the message that asked for it, and keep it current as the line moves.
   *
   * The place is the queue's own - the order things will really start, in
   * which every waiting movie is ahead of TV while strict movie priority is
   * on - and a season is one place, as it is everywhere else. The number is
   * sent as the movie side sends its own (src/media/place-reaction.js): 'low',
   * recorded only once it has really gone, and dropped at its turn with the
   * pacer if it is out of date by then. Nothing is shown on a beta request
   * whose group has since become a main one.
   *
   * Once any episode starts, the stage reactions (⬇️ ⚙️ ⬆️ ✅) own the
   * message and the request is dropped from here, so it never gets a number
   * again - between two episodes included. An episode retried after a
   * transient failure (_retryEpisodeNow) is never given one either: its
   * message shows the stage it had reached, and the retry goes in at the
   * front.
   *
   * The requests that followed it as duplicates (`also`, see _followPlace)
   * show the same number, each checked against its own route. They get no
   * stage reactions of their own, so when the request starts, a follower
   * whose number had landed is moved on to ⬇️ - left alone, it would say
   * 1st for the whole season, until the outcome from _tellTvFollowers.
   *
   * One of several seasons asked for in one message shows its number only
   * while it is the season speaking for that message (shared-message.js);
   * the requests following it as duplicates show theirs regardless.
   *
   * Called at most once a tick from the queue's events (_positionsSoon).
   */
  _updatePositions(ctx) {
    if (!this._reactors?.size) return;
    const snap = ctx.queue?.snapshot?.();
    if (!snap) return;
    const R = this._react(ctx);
    const waiting = new Set((snap.pending ?? []).map((it) => it.group ?? it.id));
    const running = new Set((snap.active ?? []).map((it) => it.group ?? it.id));
    for (const [key, r] of [...this._reactors]) {
      if (waiting.has(key)) continue;
      r.gone = true;                          // started, finished or cancelled
      this._reactors.delete(key);
      for (const f of r.also ?? []) {
        f.gone = true;
        // Cancelled or finished instead, the followers hear the outcome. A
        // duplicate whose number never landed shows its 🤥, and keeps it; a
        // member's own request sent again shows its 🎬 or a number, both out
        // of date now, and is moved on either way (_showResend).
        if (!running.has(key) || (!f.lastEmoji && !f.resend) || !R.downloading) continue;
        if (safeRoute(ctx.config, f.route)?.originIsMain) continue;
        // The outcome is 'critical' and this is not, so the pacer would send
        // an outcome that came quickly - an episode failing at once - ahead
        // of it, and the ⬇️ would then sit on the finished request. It is
        // withdrawn at its turn once _tellTvFollowers has spoken.
        const handoffs = (this._handoffs ??= new Map());
        handoffs.set(f.msg.id, f);
        Promise.resolve(ctx.bot.react(f.msg, R.downloading, { kind: reactionKind(R, R.downloading), unless: () => !!f.ended }))
          .catch(() => {})
          .finally(() => { if (handoffs.get(f.msg.id) === f) handoffs.delete(f.msg.id); });
      }
    }
    // Front of the line first, so the pacer gets to the nearest ones soonest.
    (snap.pending ?? []).forEach((it, i) => {
      const r = this._reactors.get(it.group ?? it.id);
      if (!r) return;
      const place = positionEmoji(R, it.place ?? i + 1);
      // A beta request whose group has since become a main one shows nothing
      // more there (see onMessage), and each follower is checked on its own.
      const at = (x) => (safeRoute(ctx.config, x.route)?.originIsMain ? null : place);
      if (r.msg && (!r.share || r.share.owner() === (it.group ?? it.id))) showPlace(ctx.bot, r, at(r));
      for (const f of r.also ?? []) showPlace(ctx.bot, f, at(f));
    });
  },

  /**
   * _updatePositions once the current tick is over, however many queue
   * events it had. A film queued while the TV requests wait fired 'added' -
   * every TV place one further back - and, starting at once, 'updated' - back
   * where they were - in the same breath. Each pass asked for a number on
   * every waiting TV request, all paced and counted against the outbound
   * budget, and then withdrawn at their turn. One pass after both sees that
   * nothing moved and sends nothing.
   */
  _positionsSoon(ctx) {
    if (this._positionsTimer) return;
    this._positionsTimer = setImmediate(() => {
      this._positionsTimer = null;
      // Outside the queue's emit by now, but a throw would still be uncaught.
      try { this._updatePositions(ctx); } catch (err) { ctx.log.warn(`TV queue positions: ${err.message}`); }
    });
  },

  /**
   * One of a message's seasons has just come to speak for it (shared-message.js)
   * while it waits in the queue: show its place there. False when it is not
   * waiting - started already, or held for a restart's recovery - and the
   * caller then shows the stage it has reached instead.
   */
  _placeOnHandover(ctx, key) {
    const r = this._reactors?.get(key);
    if (!r?.msg) return false;
    const waiting = (ctx.queue?.snapshot?.().pending ?? []).some((it) => (it.group ?? it.id) === key);
    if (!waiting) return false;
    // The message shows the season before it now, not this one's number.
    r.lastEmoji = null;
    r.want = null;
    this._updatePositions(ctx);
    return true;
  },

  /**
   * How one of a message's seasons ended, written on the journal entries of
   * the seasons still to come, so after a restart the message still ends on
   * the outcome of all of them (_resumeLeftover): the finished season's own
   * entry is gone by then.
   */
  _journalSharedEnding(ctx, sharedId, ending) {
    try {
      const pending = ctx.store.get('pending', []) ?? [];
      let touched = false;
      for (const r of pending) {
        if (r?.shared?.id !== sharedId) continue;
        (r.shared.ended ??= []).push(ending ?? null);
        touched = true;
      }
      if (touched) ctx.store.set('pending', pending);
    } catch (err) { ctx.log.debug(`could not journal a season's ending: ${err.message}`); }
  },

  /**
   * Give a duplicate request its place in line: that of the request holding
   * its episodes, while that request waits.
   *
   * A duplicate was answered 🤥 and followed the earlier request
   * (_addTvFollowers), and its message then said nothing more until that
   * request's ✅, however far back in line the season was - while the
   * earlier requester watched their number count down. Only while the
   * earlier request is still waiting: once it has started, the follower is
   * told how it ends, as before. A request that follows one held for a
   * restart gets its number when that one is let into the queue (_pump), from
   * the journal, which is also what brings it back after a restart.
   *
   * A member's own request sent again (`resend`, _showResend) follows it the
   * same way, but only the latest such message: each one following is a
   * reaction on every move of the line, and a member sending it eight times
   * was eight reactions a move (found in review, 2026-10-11). An earlier one
   * keeps the number it showed, and hears the outcome with the rest
   * (_tellTvFollowers), as the movie side does (_resendPlace).
   */
  _followPlace(ctx, reqKey, msg, route, { resend = false } = {}) {
    if (!reqKey || !msg?.key) return false;
    const waiting = (ctx.queue?.snapshot?.().pending ?? []).some((it) => (it.group ?? it.id) === reqKey);
    if (!waiting) return false;
    this._reactors ??= new Map();
    let r = this._reactors.get(reqKey);
    // Queued from the panel, the request has no message and no number of its
    // own; its followers still get theirs.
    if (!r) this._reactors.set(reqKey, (r = { msg: null, lastEmoji: null, route: null, also: [] }));
    if (resend) {
      for (const f of r.also ?? []) if (f.resend) f.gone = true;
      r.also = (r.also ?? []).filter((f) => !f.resend);
    }
    (r.also ??= []).push({ msg, lastEmoji: null, route: route ?? null, ...(resend ? { resend: true } : {}) });
    this._updatePositions(ctx);
    return true;
  },

  /**
   * Place records for a journalled request's followers (see _followPlace):
   * every duplicate's, and of the member's own messages sent again only the
   * latest, as while the bot ran.
   */
  _followerPlaces(req) {
    const list = (req?.followers ?? []).filter((f) => f?.msgKey);
    const latest = [...list].reverse().find((f) => f.resend) ?? null;
    return list.filter((f) => !f.resend || f === latest)
      .map((f) => ({
        msg: { id: f.msgId, key: f.msgKey, chatJid: f.chatJid }, lastEmoji: null, route: f.route ?? null,
        ...(f.resend ? { resend: true } : {}),
      }));
  },

  /**
   * The reaction that says where a journalled request is now, for a message
   * that is not shown a place in line: the stage it is at while it runs -
   * the queue's live view of it - else the stage its kept work has reached,
   * for the first of its episodes still to be posted (the one that goes
   * first), else 🎬 (media/stage-reaction.js). Null when every episode left
   * was posted everywhere before a restart could say so: its run only marks
   * it done, and the ✅ that follows at once is all there is to show - a ⬆️
   * would be a step shown again. Never 🔄, which asks the member for nothing
   * they can do and was read as "send it again" (Iron Man 3, 2026-10-11).
   */
  _whereNowTv(ctx, req) {
    let view = null;
    try {
      view = (ctx.queue?.snapshot?.().active ?? []).find((it) => (it.group ?? it.id) === req?.reqKey) ?? null;
    } catch { /* a queue that cannot answer: the work says it */ }
    let targets = [];
    try { targets = this._targetsFor(ctx, req?.route ?? null); } catch { /* decided at the upload */ }
    const episodes = req?.episodes ?? [];
    let work = null;
    let left = !episodes.length;
    for (const ep of episodes) {
      let w = null;
      try { w = episodeWork(ctx, req.reqKey, ep.id, episodeLabel(ep)); } catch { /* none to read */ }
      // Posted to every group already, as deliverEpisode tells (alreadyAll).
      const posted = new Set([...(w?.manifest?.sent?.to ?? []), ...this._episodeSentTo(ctx, req.reqKey, ep.id)]);
      if (targets.length && targets.every((t) => posted.has(t))) continue;
      work = w;
      left = true;
      break;
    }
    if (!left) return null;
    return stageReaction(this._react(ctx), { view, work, running: !!view });
  },

  /**
   * Is the journalled request `holder` this member's own - did they ask for
   * it, by their number (memberKey) or their sender? Answers { historyId },
   * their request's row, or null.
   *
   * Only the member who asked for it. Somebody who asked for it after them
   * was given 🤥 and follows it (the duplicate check in _runSeason), and
   * their asking once more is still a different member asking for episodes
   * queued for the group, which is what 🤥 is for. Taking such a follower
   * for its owner gave Diane's second ask no 🤥 where her first had one
   * (found in review, 2026-10-11), as on the movie side (_ownRequest).
   */
  _ownTvRequest(ctx, holder, msg) {
    if (!holder || !msg) return null;
    const mine = requestMemberKey(msg);
    if ((mine && holder.memberKey === mine) || (!!msg.senderJid && holder.baseRow?.requesterJid === msg.senderJid)) {
      return { historyId: holder.baseRow?.id ?? holder.msgId ?? null };
    }
    return null;
  },

  /**
   * The member's own journalled request for `route`'s destination that every
   * one of `episodes` belongs to, still waiting or in progress: each episode
   * one it has still to post, or one it has posted already (`posted`, see
   * _journalEpisodeDone), and at least one still to come. Answers
   * { holder, own } for _resentTv, or null. `coming` is what the duplicate
   * check counts as waiting (_waitingEpisodeIds): an episode the journal
   * still lists but nothing will post - cancelled in the queue, its entry
   * not yet tidied - is not still to come, as the duplicate check says too.
   *
   * Posted episodes count because a season part-way through is the long
   * in-progress case, and they are no longer among its episodes: Ethan
   * sending "The Boys season 1" again with E1 posted and E2 running had E1
   * queued, and posted, a second time, as a new request of his that the
   * hourly check then counted as a second ask (found in review,
   * 2026-10-11). An episode asked for alone once it is posted is not in
   * progress for him any more, and is queued as asked.
   */
  _ownHolderOf(ctx, episodes, route, msg, coming) {
    if (!episodes?.length || !msg) return null;
    const want = destinationOf(route);
    const ids = episodes.map((e) => String(e.id));
    for (const req of ctx.store.get('pending', []) ?? []) {
      if (destinationOf(req.route) !== want) continue;
      const own = this._ownTvRequest(ctx, req, msg);
      if (!own) continue;
      const left = new Set((req.episodes ?? []).map((e) => String(e.id)).filter((id) => coming.has(id)));
      const posted = new Set((req.posted ?? []).map(String));
      if (ids.some((id) => left.has(id)) && ids.every((id) => left.has(id) || posted.has(id))) return { holder: req, own };
    }
    return null;
  },

  /**
   * The notifications group's "added to the queue" line for `list`, the
   * episodes it is to count. `added` is the part without the emoji and the
   * notes, which the reply in the request group repeats; `notes` what the
   * requester is told about the rating filter, and what the bypass list and
   * the AI check let through, in that order; `held` how many episodes those
   * notes say were kept out.
   *
   * Part of the request withheld on rating, or let through by the bypass
   * list or the AI check (and the notice on): the line says which part and
   * why. A bare "61 episode(s)" was read as the whole season, and three
   * missing episodes as a fault (see withheld.js). "N of M" only when the
   * rating filter is the one thing that cut the request, so
   * that M is what was added plus what is named as kept out. When
   * maxEpisodesPerRequest also cut it, or some of it was waiting already,
   * "20 of 64" beside three named episodes would leave the rest unexplained.
   * `also` is the duplicate check's " (N more already waiting)", which has a
   * flag of its own (TV_DUPLICATE) and goes just before the full stop.
   * `scope` names what was asked for after the show: "season 2", or a run
   * of episodes' codes (scopeOf).
   *
   * `cut` is set when maxEpisodesPerRequest cut the request (cap-cut.js):
   * the count is then "10 of 23 episodes", M being what it would have
   * queued with no limit, and the limit follows - "added to the queue; one
   * request is at most 10 episodes". "10 episode(s)" of a season of 23 was
   * read as the whole of it (2026-10-12). A rating note after it explains
   * the rest of the season's episodes, as above.
   */
  _queuedLine({
    R, found, parsed, list, allowed, withheld, screened = null, say, also = '', scope = `season ${found.season}`, cut = null,
  }) {
    const single = isSingleEpisode(parsed);
    // The plain line names the episodes in `list`, as the journal and the
    // finished notice will (queuedName): "S05E04–E10 — 2 episode(s)" was read
    // as E04 and E10. The line with notes keeps the span asked for, which its
    // "2 of 7 episodes" and the notes after it account for.
    const named = queuedName(found, parsed, list, scope);
    const capped = !single && !!cut;
    const title = single ? episodeLabel(list[0]) : `${found.series.name} ${named.scope}`;
    const what = single ? title : `${title} — ${named.count}`;
    const limit = capped ? `; ${cutLimit(cut)}` : '';
    const notes = [withheld?.sentence, ...(screened?.sentences ?? [])].filter(Boolean);
    const held = withheld?.count ?? 0;
    if (!notes.length || !say) {
      return { line: `${R.added ?? '🎬'} ${what} — added to the queue${also}${limit}`, added: null, notes: [], held };
    }
    const whole = list.length === allowed.length;
    const added = single
      ? `${what} — added to the queue${also}.`
      : `${found.series.name} ${scope} — `
        + (capped ? `${cut.count} of ${cut.of} episodes`
          : whole && held ? `${list.length} of ${list.length + held} episodes` : `${list.length} episode(s)`)
        + ` added to the queue${also}${limit}.`;
    return { line: `${R.added ?? '🎬'} ${added} ${notes.join(' ')}`, added, notes, held };
  },

  /**
   * How a journalled request is named as one item in the queue: its title
   * without the episode count ("Loki season 1", not "Loki season 1 — 6
   * episode(s)"), as onMessage names it. A request that queued part of what
   * it asked for is counted "— 2 of E04–E10" since 2026-10-12 (queuedName),
   * and comes back as "Outer Banks S05E08–E09"; one journalled before then
   * still ends in "episode(s)".
   */
  _groupOf(req, ep, extra = {}) {
    return {
      group: req.reqKey,
      groupLabel: String(req.label ?? '').replace(/ — \d+ (?:episode\(s\)|of .+)$/, '') || req.label,
      groupMeta: {
        kind: 'tv', series: ep.series, season: ep.season,
        // A journal written before 2026-10-01 holds the requester as
        // "+1 (555) 807-0190" and the number as bare digits; both are shown
        // as +15558070190 (phoneOut), as a new request's are.
        requester: phoneOut(req.requester ?? null), requesterNumber: phoneOut(req.requesterNumber ?? null),
        // The member the journal kept (onMessage): a request put back after
        // a restart keeps its rank in the fair order. None for one queued
        // from the panel, which the fair order never moves.
        ...(req.memberKey ? { memberKey: req.memberKey } : {}),
        // And an extra asked for inside their cooldown stays one (_runSeason).
        ...(req.insideCooldown ? { insideCooldown: req.insideCooldown } : {}),
        ...extra, ...(req.route?.beta ? { beta: true } : {}),
      },
    };
  },

  /**
   * Queue the journalled requests a restart left behind, and any the queue
   * had no room for yet.
   *
   * Each goes in whole, as one request, and only needs one free place: a
   * request is one item in the queue however many episodes it has. That is
   * what 122 episodes journalled against 50 places one night needed - fed
   * in piecemeal, a season took every place in the line on its own. What
   * does not fit waits here and is let in as places free up (setup() calls
   * this on every queue change).
   *
   * `overLimit` is for recovery, which puts every leftover request back at
   * once, past the limit (see recoverPending) - so after a restart nothing
   * accepted waits here at all. Nothing is let in while recovery is still
   * waiting for the films: the requests from before the restart, and those
   * held behind them (_holdForRecovery), go in together when it ends, in
   * journal order.
   *
   * The notifier's total is the WHOLE request, so it concludes exactly once.
   */
  _pump(ctx, { overLimit = false } = {}) {
    if (this._pumping || this._awaitingRecovery || !this._live?.size) return;
    // Adding a job fires the queue's events, which call back in here.
    this._pumping = true;
    let letIn = false;
    try {
      // The seasons that had started before a restart first, in the order
      // they had started, so each takes a free slot before anything waiting
      // can (_resumeLeftover); then the rest in journal order, which the fair
      // order ranks as it ranked them before.
      const startOf = (req) => this._live.get(req.reqKey)?.startedBefore ?? Infinity;
      const pending = [...(ctx.store.get('pending', []) ?? [])]
        .sort((a, b) => (startOf(a) === startOf(b) ? 0 : startOf(a) - startOf(b)));
      for (const req of pending) {
        const live = this._live.get(req.reqKey);
        if (!live) continue;                    // no live notifier - not ours to feed
        const episodes = req.episodes ?? [];
        const todo = episodes.filter((ep) => !live.queued.has(`${req.reqKey}:${ep.id}`));
        if (!todo.length) continue;             // already queued or running
        const fresh = !live.queued.size;
        if (fresh && !overLimit && !this._hasRoom(ctx)) continue;   // full; a later pump lets it in
        for (const ep of todo) {
          const i = episodes.indexOf(ep);
          const id = `${req.reqKey}:${ep.id}`;
          live.queued.add(id);
          try {
            // A request held for the restart's (_holdForRecovery) is new,
            // not one picked back up, and is not marked as resumed.
            const resumed = live.held ? {} : { resumed: true };
            ctx.queue.add({
              kind: 'tv',
              ...this._groupOf(req, ep, resumed),
              // Running since before the restart (_resumeLeftover).
              ...(live.startedBefore ? { startedBefore: live.startedBefore } : {}),
              // The place the restart left it, if it left it (_expectBack).
              rankKey: req.reqKey,
              label: episodeLabel(ep),
              meta: {
                kind: 'tv', series: ep.series, season: ep.season, episode: ep.episode, epId: String(ep.id),
                requester: phoneOut(req.requester ?? null), requesterNumber: phoneOut(req.requesterNumber ?? null),
                ...(req.memberKey ? { memberKey: req.memberKey } : {}),
                ...resumed, position: `${i + 1}/${episodes.length}`,
                ...(req.route?.beta ? { beta: true } : {}),
              },
              // The route journalled with the request, never one re-derived from
              // today's config - see recoverPending.
              run: (job) => this.deliverEpisode({
                ep, ctx, job, msg: live.msg, react: live.react, notifier: live.notifier,
                reqKey: req.reqKey, route: req.route ?? null,
                // What it had done before a restart is in its work, which
                // deliverEpisode goes on from (media/work-files.js).
                // The whole remainder goes in together now, so the last one
                // is known - a resumed season used to end without its ✅.
                isLast: i === episodes.length - 1, index: i, total: episodes.length,
              }),
              onDiscard: (live.discard ??= this._discarder(ctx, {
                reqKey: req.reqKey, label: req.label, notifier: live.notifier, react: live.react,
              }))(ep),
            }, { overLimit });
          } catch (err) {
            live.queued.delete(id);
            if (err.code !== 'QUEUE_FULL') throw err;
            break;
          }
        }
        // Its place in line, as a new request gets one (see onMessage), and
        // the same for the requests that followed it as duplicates, from the
        // journal - which is how they keep theirs after a restart. Not a
        // season that had started before the restart: it is running, not in
        // the line, and never gets a number again (see the queue's class
        // comment).
        if (fresh && live.queued.size) {
          letIn = true;
          const also = this._followerPlaces(req);
          if ((live.msg || also.length) && !live.startedBefore) {
            this._reactors ??= new Map();
            this._reactors.set(req.reqKey, {
              msg: live.msg ?? null, lastEmoji: null, route: req.route ?? null, also, share: live.share ?? null,
            });
          }
          // A request resumed after a restart (`redo`, set by _resumeLeftover)
          // shows where it is now: its number when it is waiting for one,
          // which says as much - a second reaction as well doubled what every
          // start sent, as on the movie side (_resume) - otherwise the stage
          // it is at (_whereNowTv). It was 🔄, which a member read as "send
          // it again" on 2026-10-11 (Iron Man 3, media/stage-reaction.js);
          // one reaction for one, and its episodes' own stages are not sent
          // twice (_sameTwiceSkipped).
          if (live.redo) {
            live.redo = false;
            const numbered = !!live.msg && !safeRoute(ctx.config, req.route)?.originIsMain
              && (ctx.queue.snapshot?.().pending ?? []).some((it) => (it.group ?? it.id) === req.reqKey);
            if (!numbered) live.react?.(this._whereNowTv(ctx, req));
          }
        }
      }
    } finally {
      this._pumping = false;
    }
    // The queue's own events came while the reactions above were not yet set up.
    if (letIn) this._updatePositions(ctx);
  },

  /**
   * Re-queue whatever was still outstanding when the process last stopped.
   *
   * Unlike movies this does NOT re-resolve against the library. A movie is
   * looked up again because its journal holds a title the user typed; here the
   * episodes were already resolved to Jellyfin item ids, and the download URL
   * is built from the CURRENT config at download time, so nothing stale is
   * being replayed.
   */
  async recoverPending(ctx, { leftover = null, batches = null } = {}) {
    // What the last process left behind: noted at setup, or else now, before
    // waiting below. A request that arrives meanwhile journals itself, and
    // must not be taken for one to resume - that would queue it twice. The
    // same for the messages it was still working through the seasons of
    // (_noteSeasonBatch).
    leftover ??= new Set((ctx.store.get('pending', []) ?? []).map((r) => r.reqKey));
    batches ??= new Set((ctx.store.get('seasonBatches', []) ?? []).map((n) => n.msgId));
    const cutShort = async () => {
      if (!batches.size) return;
      try { await this._recoverSeasonBatches(ctx, batches); }
      catch (err) { ctx.log.error(`TV: could not answer the seasons a restart cut short: ${err.message}`); }
    };
    if (!leftover.size) { await cutShort(); return; }

    // Until these are queued again, a member asking for the same episodes is
    // told they are waiting already (_waitingEpisodeIds): they are, just not
    // in the queue yet. And a new request is held until then, so it goes in
    // behind them (_holdForRecovery).
    this._awaitingRecovery = leftover;
    try {
      // Before they are resumed, so the ⚠️ a message cut short ends on is
      // journalled with its seasons first.
      await cutShort();
      await this._resumeLeftover(ctx, leftover);
    } finally {
      this._awaitingRecovery = null;
      // One pass over everything, in journal order, and past the queue limit:
      // these requests were accepted before the restart, or while it was being
      // recovered. Each goes in whole, as one request. Fed in only as places
      // freed, they could wait behind a queue the recovered films (which go
      // past the limit too) had filled. In the finally, so a recovery that
      // failed part-way still lets the held requests in.
      try { this._pump(ctx, { overLimit: true }); } catch (err) { ctx.log.error(`TV recovery could not queue: ${err.message}`); }
      // Whatever the queue was told to expect back (_expectBack) and is not
      // back now will not come back from here - a beta test, an episode
      // another request resumes, one that could not be resumed - so no slot
      // is kept for it any longer, nor its place.
      for (const key of leftover) ctx.queue?.forgetExpected?.(key);
    }
  },

  async _resumeLeftover(ctx, leftover) {
    // The films go back in first (see holdTvRecovery in media/resume.js).
    if (!(await afterMovieRecovery(ctx.queue))) {
      ctx.log.warn('📺 movie recovery is still running after 5 minutes - resuming TV anyway');
    }
    const all = ctx.store.get('pending', []) ?? [];
    const left = all.filter((r) => leftover.has(r.reqKey));

    // A request a beta group queued before tests stopped downloading is not
    // resumed: that would download and post a test in front of real requests,
    // which is what the operator's rule is there to stop (2026-09-29,
    // beta.js). Its row says why and its message gets ❌; it leaves the
    // journal with the rest of what is not resumed, below.
    const tests = left.filter((r) => isTestRoute(r.route));
    const R0 = this._react(ctx);
    const told = new Set();
    for (const r of tests) {
      const why = 'a beta test queued before tests stopped downloading — not resumed; ask again with its code to test it';
      ctx.log.warn(`📺 not resuming "${r.label}" - ${why}`);
      if (r.baseRow?.id) this._history(ctx, { ...r.baseRow, at: Date.now(), status: 'cancelled', detail: why });
      this._tellTvFollowers(ctx, r.reqKey, { status: 'cancelled', emoji: R0.cancelled ?? '❌', why });
      // Whatever it had made goes with it: nothing will resume from it.
      for (const e of r.episodes ?? []) this._dropEpisodeWork(ctx, r.reqKey, e.id);
      // One reaction per message - a message's seasons share it - paced like
      // any bulk work (CLAUDE.md rule 1).
      if (!r.msgKey || told.has(r.msgId) || safeRoute(ctx.config, r.route)?.originIsMain) continue;
      if (told.size) await ctx.bot._bulkPace?.();
      told.add(r.msgId);
      const emoji = R0.cancelled ?? '❌';
      try { await ctx.bot.react({ id: r.msgId, key: r.msgKey, chatJid: r.chatJid }, emoji, { kind: reactionKind(R0, emoji) }); }
      catch (err) { ctx.log.debug(`could not mark a beta test that was not resumed: ${err.message}`); }
    }
    const pending = left.filter((r) => !tests.includes(r));

    // An episode journalled by several requests for one destination is
    // resumed once: for the earliest of them, or not at all when a request
    // made since this start has it queued already. The duplicate check in
    // onMessage stops new copies, but not the ones journalled before it: on
    // 2026-09-28 the live journal held "Loki season 1" three times and "The
    // Mentalist S03E05" twice, and a restart would have posted each of those
    // episodes that many times. Same Jellyfin item, same destination.
    const taken = new Map();                     // destination + episode -> the request resuming it
    const keyOf = (r, e) => `${destinationOf(r.route)}\u0000${String(e.id)}`;
    for (const r of all) if (!leftover.has(r.reqKey)) for (const e of r.episodes ?? []) taken.set(keyOf(r, e), r);
    const unique = [];
    for (const r of pending) {
      const eps = [];
      const mine = [];
      for (const e of r.episodes ?? []) {
        if (taken.has(keyOf(r, e))) {
          // Its work goes to the request that resumes the episode, when that
          // one has none (the same episode, as far as it got); otherwise it
          // goes. Never to a request journalled since this start: that one
          // may be running it now.
          const holder = taken.get(keyOf(r, e));
          if (holder && leftover.has(holder.reqKey) && ctx.config.media?.workDir) {
            adoptWork({
              workDir: ctx.config.media.workDir, fromKey: workKey.tv(r.reqKey, e.id), toKey: workKey.tv(holder.reqKey, e.id),
              isSafe: tvSafe(ctx), keptKey: `${r.reqKey}:${e.id}`,
            });
          } else this._dropEpisodeWork(ctx, r.reqKey, e.id);
          continue;
        }
        mine.push(keyOf(r, e));
        eps.push(e);
      }
      const twice = (r.episodes ?? []).length - eps.length;
      // What is resumed is this very object, so a follower added to it below
      // is journalled with it.
      const kept = !twice ? r : eps.length ? { ...r, episodes: eps } : null;
      for (const k of mine) taken.set(k, kept);
      if (!twice) { unique.push(r); continue; }
      ctx.log.warn(`📺 "${r.label}": ${twice} of its ${(r.episodes ?? []).length} episode(s) are journalled by an `
        + `earlier request as well - ${eps.length ? `resuming the other ${eps.length}` : 'not resuming it twice'}`);
      if (kept) { unique.push(kept); continue; }
      // Its requester, and any that followed it, hear how the request that
      // resumes its episodes ends.
      const holder = taken.get(keyOf(r, r.episodes[0]));
      const own = r.msgId && r.baseRow?.id
        ? [{ msgId: r.msgId, msgKey: r.msgKey ?? null, chatJid: r.chatJid ?? null, historyId: r.baseRow.id, route: r.route ?? null }]
        : [];
      this._addTvFollowers(ctx, holder, [...own, ...(r.followers ?? [])]);
      if (r.baseRow?.id) {
        this._history(ctx, {
          ...r.baseRow, at: Date.now(), status: 'duplicate',
          detail: 'already in the queue from an earlier request — not resumed twice after a restart'
            + rowSuffix(r.baseRow),
        });
      }
    }

    // Keep only entries worth replaying, and write that back before queueing
    // anything: a malformed entry must not replay on every boot for ever.
    // Ahead of the requests journalled since this start, which is the order
    // _pump lets them into the queue in (_holdForRecovery).
    const live = unique.filter((r) => (r.episodes ?? []).length);
    // A finished episode kept by a version before job directories: named
    // at random, nothing ties it to the library file it came from, and the
    // start-up sweep has cleared it anyway.
    for (const r of live) {
      const old = (r.episodes ?? []).filter((e) => e.ready).length;
      if (!old) continue;
      ctx.log.warn(`📺 "${r.label}": ${old} finished episode file(s) were kept before this version and cannot be tied `
        + 'to a library file; making them again');
      r.episodes = r.episodes.map(({ ready, ...e }) => e);
    }
    // Whether each had started (_startOf), written back with it, so a
    // restart in the middle of this one reads the same answer.
    for (const r of live) r.startedAt = this._startOf(ctx, r) ?? 0;
    ctx.store.set('pending', [
      ...live.map((r) => ({ ...r, resumedAt: Date.now() })),
      ...all.filter((r) => !leftover.has(r.reqKey)),
    ]);

    this._live ??= new Map();
    const R = this._react(ctx);
    // The seasons of one message that asked for several share its reaction
    // again, as they did before the restart (shared-message.js), with how
    // the ones that finished before it ended. In journal order, which is the
    // order they were queued in and go back in.
    const shares = new Map();

    for (const req of live) {
      const episodes = req.episodes ?? [];
      try {
        const msg = req.msgId ? { id: req.msgId, key: req.msgKey, chatJid: req.chatJid } : null;
        // The same twice running is skipped - see onMessage.
        const toMessage = () => this._sameTwiceSkipped((emoji) => {
          if (safeRoute(ctx.config, req.route)?.originIsMain) return Promise.resolve(false);   // see onMessage
          return ctx.bot.react(msg, emoji, { kind: reactionKind(this._react(ctx), emoji) });
        });
        let react = msg ? toMessage() : async () => {};
        let share = null;
        if (msg && req.shared?.id) {
          const sharedId = req.shared.id;
          share = shares.get(sharedId);
          if (!share) {
            share = shareMessage({
              send: react,
              R: this._shareR(R),
              onHandover: (key) => this._placeOnHandover(ctx, key),
              onEnded: (key, ending) => this._journalSharedEnding(ctx, sharedId, ending),
              before: req.shared.ended ?? [],
            });
            shares.set(sharedId, share);
          }
          const voice = share.voice();
          voice.join(req.reqKey);
          react = voice.react;
        }

        // The requester is told their old message is being picked back up
        // once it is queued (_pump): by its place in line when it gets one.

        const baseRow = { ...(req.baseRow ?? {}), at: Date.now() };
        // What the request did before the restart (_journalEpisodeDone), so
        // it ends on all of it: an episode that failed then still ends the
        // season on ⚠️.
        const t = req.tally ?? {};
        const counts = {
          completed: t.completed ?? 0, failed: t.failed ?? 0, cancelled: t.cancelled ?? 0,
          skipped: t.skipped ?? 0, why: t.why ?? null,
          // Taken off it by trimQueued: in none of the above, nor its total.
          trimmed: t.trimmed ?? 0,
        };
        const total = episodes.length + counts.completed + counts.failed + counts.cancelled;
        // A beta request resumes to the beta destination it was journalled
        // with, even if its group has since left the beta list. Deciding again
        // from the current config would re-classify it as main and post a test
        // request to the real posts group.
        if (req.followers?.length) (this._followers ??= new Map()).set(req.reqKey, req.followers);
        // Episodes with work on disk from before the restart: room held for
        // what each has still to write, which comes back once it is posted
        // (disk-space.js keepRoom).
        const media = ctx.config.media ?? {};
        for (const ep of episodes) {
          const w = episodeWork(ctx, req.reqKey, ep.id, episodeLabel(ep));
          if (!w?.has()) continue;
          const need = jobNeed({
            workDir: media.workDir, kind: 'tv', sourceBytes: w.manifest.item.total ?? ep.size ?? null,
            maxOutputBytes: media.maxOutputBytes, segmented: media.segmentedEncode !== false,
          });
          keepRoom(`${req.reqKey}:${ep.id}`, {
            dir: media.workDir, jobDir: w.dir, peak: need.peak, made: finishedOutput(w)?.size ?? null, label: episodeLabel(ep),
          });
        }
        // A request maxEpisodesPerRequest cut still names its next part when
        // it ends (journalled as `next`, _runSeason). An entry journalled
        // before 2026-10-12 has none, and ends as it always did.
        const notifier = this._makeRequestNotifier(ctx, {
          label: req.label, total, msg, single: total === 1, route: req.route ?? null, reqKey: req.reqKey, counts,
          next: req.next?.send ? req.next : null,
          // What the limit left out of it, or what a trim since did (its
          // journalled row's `cut`, which trimQueued writes there too).
          cut: baseRow?.cut ?? null,
          onFinish: ({ completed, failed, cancelled = 0, skipped = 0, why = null }) => {
            this._live?.delete(req.reqKey);
            this._history(ctx, {
              ...baseRow,
              at: Date.now(),
              status: (failed === 0 && cancelled === 0) ? 'sent'
                : (completed === 0 ? (failed ? 'failed' : (cancelled === skipped ? 'skipped' : 'cancelled')) : 'partial'),
              detail: ((failed === 0 && cancelled === 0)
                ? `${completed} episode(s) posted (resumed)`
                : [`${completed} of ${notifier.total} posted after a restart`,
                   ...countsProse({ failed, cancelled, skipped })].join(', ') + betaWhy(req.route, failed, why))
                + cutSuffix(notifier) + rowSuffix(baseRow),
              // Trimmed to the episode limit, before the restart or since (trimQueued).
              ...trimmedRow(notifier),
            });
            share?.concluded(req.reqKey, notifier.ending());
          },
        });

        // A season that had started before the restart is still running: it
        // goes back in as running (queue.add `startedBefore`), ahead of every
        // request waiting, whatever its rank in the fair order, and with no
        // place number - as a film does (Thor: The Dark World, 2026-10-11,
        // see the movie side's _recoverFilms). Whether it had, and when, is
        // decided above (_startOf).
        const startedBefore = Number(req.startedAt) > 0 ? Number(req.startedAt) : null;

        this._live.set(req.reqKey, { notifier, msg, react, share, queued: new Set(), redo: true, startedBefore });
        ctx.log.warn(`📺 resuming "${req.label}" — ${episodes.length} episode(s) after a restart`
          + (total > episodes.length ? ` (${total - episodes.length} of its ${total} ended before it)` : '')
          + (startedBefore ? ' - it had started, so it runs again ahead of the waiting line' : ''));
      } catch (err) {
        ctx.log.error(`could not resume "${req.label}": ${err.message}`);
      }
    }

    // recoverPending puts them in the queue, with anything held behind them.
  },

  /**
   * Book another attempt at an episode that failed transiently, to run once
   * WhatsApp is connected (media/resume.js). The episode stays journalled
   * while it waits, so a restart meanwhile replays it. Returns the attempt
   * booked, or 0 once MAX_RETRIES are spent - the episode then fails as it
   * always did.
   */
  _retryEpisodeLater(ctx, args, err, { until = null } = {}) {
    this._retries ??= new RetryBook({ log: ctx.log });
    this._retryBooked ??= new Map();
    const key = `${args.reqKey}:${args.ep.id}`;
    // Still its member's while it waits (queue.hasOthers).
    const memberKey = (ctx.store.get('pending', []) ?? []).find((r) => r.reqKey === args.reqKey)?.memberKey ?? null;
    // On the queue's panel while it waits, where Cancel can reach it (see
    // RetryBook `show`). Cancel is the whole request, as it is on the
    // request's own row; Skip is this episode.
    const show = typeof ctx.queue?.holdRetry === 'function' ? {
      queue: ctx.queue,
      label: episodeLabel(args.ep),
      kind: 'tv',
      meta: {
        kind: 'tv', series: args.ep.series, season: args.ep.season, episode: args.ep.episode,
        ...(memberKey ? { memberKey } : {}),
        ...(args.route?.beta ? { beta: true } : {}),
      },
      cancel: (state) => {
        this._retryBooked?.delete(key);
        this._retryDiscarded(ctx, args, state);
        if (state !== 'skipped') ctx.queue.cancel?.(args.reqKey);
      },
    } : null;
    const attempt = this._retries.schedule(key, {
      bot: ctx.bot, err, until, show,
      run: (n) => {
        this._retryBooked?.delete(key);
        return this._retryEpisodeNow(ctx, args, n);
      },
    });
    // Held until it is back in the queue, where Cancel can see it: until
    // then it is in no queue at all (see _dropBookedRetries).
    if (attempt) this._retryBooked.set(key, args);
    return attempt;
  },

  _retryEpisodeNow(ctx, args, attempt) {
    const { ep, reqKey, notifier, route } = args;
    const key = `${reqKey}:${ep.id}`;
    const label = episodeLabel(ep);
    const req = (ctx.store.get('pending', []) ?? []).find((r) => r.reqKey === reqKey);
    if (!(req?.episodes ?? []).some((e) => String(e.id) === String(ep.id))) {
      // Nothing takes a waiting episode out of the journal in this process,
      // so this should not happen; if it does, the request still hears an
      // outcome, or it would wait on this episode for ever.
      ctx.log.info(`not retrying ${label}: it is no longer journalled`);
      this._retries?.forget(key);
      this._dropKept(ctx, args);
      notifier?.episodeCancelled();
      return;
    }
    try {
      // Back into its own request, which is one item in the queue however
      // many of its episodes are left: counted, shown, moved and cancelled
      // with the rest of it. `retry` tells the queue this is the same episode
      // again, not one more, and how its last attempt ended (see queue.add).
      // Past the queue limit, like recovery: the episode was accepted already.
      const queued = ctx.queue.add({
        kind: 'tv',
        ...this._groupOf(req, ep),
        retry: args.lost ?? 'failed',
        label,
        meta: {
          kind: 'tv', series: ep.series, season: ep.season, episode: ep.episode, epId: String(ep.id),
          requester: phoneOut(req.requester ?? null), requesterNumber: phoneOut(req.requesterNumber ?? null),
          ...(req.memberKey ? { memberKey: req.memberKey } : {}),
          retry: attempt, retryKey: key, position: `${args.index + 1}/${args.total}`,
          ...(route?.beta ? { beta: true } : {}),
        },
        // Its ✅ comes from the request's notifier, not its place in the
        // season (see deliverEpisode): it may land first or last.
        run: (job) => this.deliverEpisode({ ...args, ctx, job }),
        // Cancelled or cleared while it waits in the queue, it never runs,
        // so deliverEpisode cannot report it.
        onDiscard: (state) => this._retryDiscarded(ctx, args, state),
      }, { overLimit: true });
      // At the front, where it was when it failed (see the movie side's
      // _resume). A retry that rejoined its running request is there
      // already: the queue puts it with the running requests' episodes,
      // ahead of everything waiting.
      ctx.queue.moveTop?.(queued);
      ctx.log.info(`📺 retrying ${label} (attempt ${attempt} of ${MAX_RETRIES})`);
    } catch (err) {
      ctx.log.error(`could not retry ${label}: ${err.message}`);
      this._retries?.forget(key);
      this._journalEpisodeDone(ctx, reqKey, ep.id, 'failed', err.message);
      notifier?.episodeFailed(err.message);
    }
  },

  /**
   * Say on the request's History row that an episode of it is waiting for
   * disk space: the row reads "queued" until the whole request is done, and
   * otherwise nothing but the log would say why it has stopped. The row's
   * final outcome replaces this, as it replaces the rest of its detail.
   */
  _noteWaitingForDisk(ctx, reqKey, label, err, attempt) {
    try {
      const req = (ctx.store.get('pending', []) ?? []).find((r) => r.reqKey === reqKey);
      const id = req?.baseRow?.id;
      if (!id || !(ctx.store.get('history', []) ?? []).some((h) => h.id === id)) return;
      this._history(ctx, { id, detail: `${label} is waiting for disk space — ${err.message} (attempt ${attempt} of ${MAX_RETRIES})` });
    } catch (e) {
      ctx.log.debug(`could not note the wait for disk space: ${e.message}`);
    }
  },

  /** Delete the work an episode kept for its retry, if any, through the delete guard. */
  _dropKept(ctx, args) {
    if (args?.reqKey && args?.ep) this._dropEpisodeWork(ctx, args.reqKey, args.ep.id);
  },

  /**
   * A retried episode cancelled, skipped or cleared before it started: it
   * leaves the journal, so it cannot come back after a restart, and its
   * request is told, so a season still reports exactly once.
   */
  _retryDiscarded(ctx, args, state) {
    try {
      this._retries?.forget(`${args.reqKey}:${args.ep.id}`);
      this._journalEpisodeDone(ctx, args.reqKey, args.ep.id, state === 'skipped' ? 'skipped' : 'cancelled');
      ctx.log.warn(`TV ${state} before its retry started: ${episodeLabel(args.ep)}`);
      if (state !== 'skipped') this._dropBookedRetries(ctx, args.reqKey, state);
      // The message shows the stage it failed at, from the failure. The
      // request's react() skips an emoji already showing, so a cancel that
      // also reached the rest of the request still puts one ❌ on it.
      const R = this._react(ctx);
      args.react?.(state === 'skipped' ? R.skipped : R.cancelled);
      args.notifier?.episodeCancelled(state);
      this._reactEnding(ctx, args.notifier, args.react);
    } catch (err) {
      ctx.log.warn(`could not tidy up after cancelling ${episodeLabel(args.ep)}: ${err.message}`);
    }
  },

  /**
   * A request cancelled whole takes its booked retries with it.
   *
   * Cancel stops a request - every episode of it waiting and every one in
   * hand (queue.cancel). An episode whose retry is booked, waiting for its
   * delay or for WhatsApp to come back, is in neither place: it is in no
   * queue at all until the retry fires. Left alone, it fired after the
   * cancel and put that episode of the cancelled season back in the queue
   * on its own.
   */
  _dropBookedRetries(ctx, reqKey, state = 'cancelled') {
    for (const [key, args] of [...(this._retryBooked ?? [])]) {
      if (args.reqKey !== reqKey) continue;
      this._retryBooked.delete(key);
      this._retries?.forget(key);
      this._journalEpisodeDone(ctx, reqKey, args.ep.id, state === 'skipped' ? 'skipped' : 'cancelled');
      ctx.log.warn(`TV ${state} with its request, before its retry: ${episodeLabel(args.ep)}`);
      args.notifier?.episodeCancelled(state);
    }
  },

  /**
   * Episode ids already waiting or in progress for the destination `route`
   * posts to, whoever asked for them - the duplicate check in onMessage.
   *
   * The journal says which episodes each request holds and where they go.
   * An episode counts while the queue holds it, while a retry is booked for
   * it, while its request waits to be resumed after a restart, or while a
   * resumed request waits here for a place in the queue (_pump). The queue
   * holds jobs, one per episode, whatever request they are grouped into, so
   * an episode is matched on its own series, season and number.
   */
  _waitingEpisodeIds(ctx, route) {
    const want = destinationOf(route);
    const epKey = (e) => `${String(e.series ?? '').toLowerCase()}|${e.season}|${e.episode}`;
    const inQueue = new Set();
    for (const e of [...(ctx.queue.pending ?? []), ...(ctx.queue.active?.values?.() ?? [])]) {
      if (e?.kind !== 'tv' || !e.meta || !!e.meta.beta !== !!route?.beta) continue;
      inQueue.add(epKey(e.meta));
    }
    const ids = new Set();
    for (const req of ctx.store.get('pending', []) ?? []) {
      if (destinationOf(req.route) !== want) continue;
      const resuming = !!this._awaitingRecovery?.has(req.reqKey);
      const held = this._live?.get(req.reqKey);
      for (const ep of req.episodes ?? []) {
        const id = `${req.reqKey}:${ep.id}`;
        if (resuming || inQueue.has(epKey(ep)) || this._retries?.isWaiting(id)
            || (held && !held.queued.has(id))) {
          ids.add(String(ep.id));
        }
      }
    }
    return ids;
  },

  /**
   * Where an episode is posted, decided as it is sent.
   *
   * A main request goes to every TV posts group in the live config. A beta
   * request goes to its one beta destination and nowhere else - the one it
   * was journalled with, re-checked against today's config, because in the
   * hours an episode can wait that destination may have become a main group
   * (safeRoute). When nowhere isolated is left this throws, and the episode
   * fails with the reason rather than post a test to real members.
   */
  _targetsFor(ctx, route) {
    const beta = safeRoute(ctx.config, route);
    if (!beta) return postsTargets(ctx.config.tvRequests);
    if (!beta.postsGroup) throw Object.assign(new Error(beta.withheld), { code: 'BETA_WITHHELD' });
    return [beta.postsGroup];
  },

  async deliverEpisode({ ep, ctx, job, msg, react, isLast, index, total, notifier = null, route = null, reqKey = null }) {
    const cfg = ctx.config.tvRequests;
    const media = ctx.config.media;
    const R = this._react(ctx);
    const jf = ctx.config.library?.jellyfin ?? {};
    const label = episodeLabel(ep);
    const outName = episodeFileName(ep);

    const workDir = media.workDir;
    fs.mkdirSync(workDir, { recursive: true });
    const retryKey = reqKey ? `${reqKey}:${ep.id}` : null;
    // The episode's work, which a restart finds again (see episodeWork).
    const work = episodeWork(ctx, reqKey, ep.id, label, { jobId: job.id });
    if (!work) throw new Error('no work directory is set (media.workDir)');
    // From here its request is running, and a restart puts it back as running.
    this._journalStarted(ctx, reqKey);
    const started = Date.now();
    let conv = null;
    let downloaded = null;
    let retrying = false;
    let busyElsewhere = false;
    let ended = null;                         // how it ended, for the journal's tally (_journalEpisodeDone)
    let endedWhy = null;
    let room = null;                          // this episode's hold on the disk (media/disk-space.js)
    const shape = { segmented: media.segmentedEncode !== false };
    const download = () => episodeDownloadUrl(ep.id, {
      base: String(jf.baseUrl ?? '').replace(/\/+$/, ''),
      token: jf.accessToken || jf.apiKey,
    });
    const waiting = (pct) => (r) => job.progress({
      stage: 'wait',
      text: `waiting for disk space — it needs ${fmtBytes(r.need)}, ${fmtBytes(Math.max(0, r.available))} is free`,
    }, pct);

    const cancelled = () => {
      if (job.isCancelled()) throw Object.assign(new Error('cancelled'), { code: 'CANCELLED' });
    };

    try {
      try {
        work.lock();
      } catch (err) {
        busyElsewhere = err.code === 'WORK_BUSY';
        throw err;
      }
      // A beta test with nowhere isolated left to go fails now, before the
      // download. The upload re-checks: that is the moment that counts.
      if (route?.beta) this._targetsFor(ctx, route);

      /* ---------------- what it had done already ---------------- */
      // A download or an encode cut off before it was recorded goes.
      work.tidy();
      // Posted to every group already, and the process stopped before it
      // could say so: nothing is posted twice. Read before anything else, from
      // its work and its journal entry: whether a post went out does not
      // depend on the library, and asking the library first used to decide it
      // - an episode whose check then failed (its file gone, a 404) had its
      // work reset and was fetched, converted and posted again.
      const postedTo = new Set([...(work.manifest.sent?.to ?? []), ...this._episodeSentTo(ctx, reqKey, ep.id)]);
      let targetsNow = [];
      try { targetsNow = this._targetsFor(ctx, route); } catch { /* decided again at the upload */ }
      const alreadyAll = postedTo.size > 0 && targetsNow.length > 0 && targetsNow.every((t) => postedTo.has(t));
      if (!alreadyAll && work.has() && !work.vouched()) {
        // Still the library's file? Asked once per process: after a restart,
        // not before a retry in this one. Unanswered, it waits as a
        // transient failure, with its files (media/work-files.js).
        const verdict = await verifyIdentity(work.manifest, {
          provider: 'jellyfin', id: String(ep.id), access: 'download', librarySize: ep.size ?? null,
        }, {
          probe: () => {
            const d = download();
            return probeDownload(d.url, { headers: d.headers, signal: job.signal });
          },
        });
        if (verdict.ok) work.vouch();
        else {
          ctx.log.warn(`TV: the library's file for ${label} changed since it was downloaded (${verdict.why}) - fetching it again`);
          work.reset(verdict.why);
        }
      }
      let joinOnly = false;
      conv = alreadyAll ? null : finishedOutput(work);
      if (!alreadyAll && !conv && work.manifest.output) {
        ctx.log.warn(`the finished file kept for ${label} is gone or has changed - fetching and converting again`);
        work.record({ output: null });
      }
      if (alreadyAll) {
        ctx.log.info(`TV: ${label} was already posted to every group before the restart - not posting it twice`);
      } else if (conv) {
        ctx.log.info(`reusing ${outName} (${fmtBytes(conv.size)}), finished before the send was lost`);
        // All it has left to write is the upload's copy (see below).
        room = await reserveRoom({
          key: job.id, keptKey: retryKey, label, workDir, kind: 'tv', made: conv.size, maxOutputBytes: media.maxOutputBytes,
          jobDir: work.dir, signal: job.signal, log: ctx.log, onWait: waiting(92),
        });
      } else if (media.segmentedEncode !== false && await segmentsReady(work, media)) {
        // Every piece made before the restart: only the join is left, and it
        // needs no source (media/segmented.js).
        joinOnly = true;
        ctx.log.info(`TV: all of ${label}'s pieces were converted before the restart - joining them`);
        room = await reserveRoom({
          key: job.id, keptKey: retryKey, label, workDir, kind: 'tv', sourceBytes: 0, download: false,
          maxOutputBytes: media.maxOutputBytes, jobDir: work.dir, ...shape, signal: job.signal, log: ctx.log, onWait: waiting(40),
        });
      } else {
        const had = work.manifest.source;
        if (had?.state === 'complete' && fileSize(work.path(had.name)) === had.bytes) {
          downloaded = work.path(had.name);
          ctx.log.info(`TV: ${label} was downloaded before the restart (${fmtBytes(had.bytes)}) - converting it without fetching it again`);
          room = await reserveRoom({
            key: job.id, keptKey: retryKey, label, workDir, kind: 'tv', sourceBytes: had.bytes, download: true,
            maxOutputBytes: media.maxOutputBytes, jobDir: work.dir, ...shape, signal: job.signal, log: ctx.log, onWait: waiting(40),
          });
        }
      }

      /* ---------------- download ---------------- */
      //
      // An episode gives the download slot up the moment a movie wants it.
      // Priority alone only decides who gets the slot NEXT, so a movie still
      // sat behind a whole episode - which is not the priority that was asked
      // for. Yielding is cooperative: the episode aborts, releases, and queues
      // again behind the movie. It keeps its partial download and goes on
      // from it when its turn comes back: it used to delete it and start
      // again, which was cheap only while an episode was a few hundred
      // megabytes and nothing else ever interrupted one.
      let attempt = 0;
      while (!conv && !alreadyAll && !downloaded && !joinOnly) {
        attempt += 1;
        const yielded = new AbortController();
        await stageSems.download.acquire(STAGE_PRIORITY.tv, label, {
          onPreempt: () => yielded.abort(),
          key: job.id,
        });
        try {
          cancelled();
          // Room for all of it - the download, the converted file and its
          // upload copy - before a byte is written, waiting (with the slot)
          // for the jobs ahead to free some. A movie wanting the slot still
          // takes it meanwhile: the wait ends with the yield below. What its
          // work holds already is counted as its own.
          room ??= await reserveRoom({
            key: job.id, keptKey: retryKey, label, workDir, kind: 'tv', sourceBytes: ep.size, download: true,
            maxOutputBytes: media.maxOutputBytes, jobDir: work.dir, ...shape, log: ctx.log,
            signal: AbortSignal.any([job.signal, yielded.signal].filter(Boolean)),
            onWait: waiting(2),
          });
          await react(R.downloading);
          notifier?.stage('download', R.downloading ?? '⬇️', 'downloading');
          const had = work.manifest;
          const partial = work.partPath && had.source?.state === 'partial' ? fileSize(work.partPath) : null;
          ctx.log.info(`⬇ TV download START ${label}${ep.size ? ` — ${fmtBytes(ep.size)}` : ''}`
            + `${attempt > 1 ? ` (attempt ${attempt}, after giving way to a movie)` : ''}`
            + `${partial ? ` - going on from the ${fmtBytes(partial)} it had` : ''}`);
          const d = download();
          const name = had.source?.name ?? 'source.mkv';
          const dest = work.path(name);
          await downloadToFile(d.url, dest, {
            headers: d.headers,
            // From the byte it reached, if the library's file is still the
            // one it began (If-Range: downloadToFile).
            resume: had.source?.state === 'partial' && had.item
              ? { total: had.item.total, lastModified: had.item.lastModified, etag: had.item.etag } : null,
            // Either the job being cancelled or a movie wanting the slot stops
            // this download; only the reason differs.
            signal: AbortSignal.any([job.signal, yielded.signal].filter(Boolean)),
            // Which library file this is, recorded before a byte of it is
            // written: what a restart checks before going on with it.
            onResponse: ({ total: length, lastModified, etag }) => {
              work.record({
                item: {
                  provider: 'jellyfin', id: String(ep.id), access: 'download', librarySize: ep.size ?? null,
                  total: length, lastModified, etag, local: null,
                },
                source: { name, state: 'partial', bytes: length },
              });
              work.vouch();
            },
            onProgress: (pct, info) => job.progress({ ...info, stage: 'download' },
              pct == null ? null : Math.floor(pct * 0.4)),
          });
          downloaded = dest;
          // Whole: a restart from here converts it without fetching it again.
          work.record({ source: { name, state: 'complete', bytes: fileSize(dest) ?? 0 } });
          // Symmetric with the START above. Without it the log shows a download
          // beginning and never finishing, so "what is in flight right now?"
          // cannot be answered by reading it - which matters at restart time.
          ctx.log.info(`⬇ TV download DONE  ${label}${
            ep.size ? ` — ${fmtBytes(ep.size)}` : ''} in ${fmtDuration(Math.round((Date.now() - started) / 1000))}`);
          break;
        } catch (err) {
          // A real cancellation propagates. A yield does not: wait, then retry.
          if (!yielded.signal.aborted || job.isCancelled()) throw err;
          // It holds no room while it stands in line again: the movie it gave
          // way to may be waiting for exactly that room, with the slot.
          room?.release();
          room = null;
          ctx.log.info(`⏸ ${label} gave the download slot to a movie — will restart from where it stopped`);
          job.progress({ stage: 'wait', text: 'paused — a movie has priority' }, 2);
        } finally {
          stageSems.download.release(label);
        }
        // Give the movie a moment to take the slot before queueing again.
        await new Promise((r) => setTimeout(r, 1000));
      }

      /* ---------------- convert ---------------- */
      if (!conv && !alreadyAll) {
        cancelled();
        await stageSems.convert.acquire(STAGE_PRIORITY.tv, null, { key: job.id });
        const clock = conversionClock();
        try {
          cancelled();
          job.progress({ stage: 'convert', text: 'inspecting the file' }, 40);
          await react(R.converting);
          notifier?.stage('convert', R.converting ?? '⚙️', 'converting');
          conv = await convertForWhatsApp(downloaded, work.outPath, media, {
            signal: job.signal,
            work,
            // The time left is of what is left (ffmpeg.js conversionClock),
            // an episode resumed from its pieces included.
            onProgress: (pct, detail, extra) => {
              const { elapsed, eta } = clock(pct, extra);
              job.progress({
                stage: 'convert',
                text: `${detail}${eta != null ? ` · ${fmtDuration(eta)} left` : ''}`,
                etaSec: eta, elapsedSec: elapsed,
              }, 40 + Math.floor(pct * 0.5));
            },
          });
        } finally { stageSems.convert.release(); }
        // Made: a restart from here sends it as it is.
        work.record({ output: { name: path.basename(conv.outPath), size: conv.size, action: conv.action, segmented: !!conv.segmented } });
        if (conv.encoder) {
          ctx.log.info(
            `⚙ convert  DONE   ${label} — ${conv.action} (${conv.encoder})` +
            `${conv.gpuFallback ? ` after a GPU ${conv.gpuFallback.reason}` : ''}, ${fmtBytes(conv.size)}`,
          );
        }
        // The download stays until WhatsApp has taken the episode, as a
        // film's does (the operator, 2026-09-30: "files should remain in
        // their folders until fully sent on whatsapp"). The directory goes
        // once it is posted, below.
        room?.made(conv.size);
      }

      /* ---------------- send to every posts group ---------------- */
      cancelled();
      if (!route?.beta && !postsTargets(cfg).length) throw new Error('no TV posts group configured');

      let result;
      if (alreadyAll) {
        result = { sent: [...postedTo], failed: [] };
      } else {
        await stageSems.upload.acquire(STAGE_PRIORITY.tv, null, { key: job.id });
        try {
          cancelled();
          // Decided with the upload slot held, since waiting for it can take
          // hours - see _targetsFor.
          const targets = this._targetsFor(ctx, route);
          if (!targets.length) throw new Error('no TV posts group configured');
          // A group it was posted to before a restart is not posted to twice.
          const before = targets.filter((t) => postedTo.has(t));
          const todo = targets.filter((t) => !postedTo.has(t));
          if (before.length) {
            ctx.log.info(`TV: ${label} was posted to ${before.length} of its ${targets.length} group(s) before the restart - `
              + 'posting it to the rest');
          }
          if (todo.length) {
            await react(R.sending);
            notifier?.stage('send', R.sending ?? '⬆️', 'sending');
          }
          result = await broadcastFile(todo, async (jid) => {
            await ctx.bot.sendDocument(jid, conv.outPath, { fileName: outName, mimetype: 'video/mp4' });
            // Recorded group by group, the moment each is posted: in its work
            // and on its journal entry, either of which is enough.
            work.record({ sent: { to: [...(work.manifest.sent?.to ?? []), jid], at: Date.now() } });
            this._episodeSent(ctx, reqKey, ep.id, jid);
          }, {
            paceMs: ctx.config.whatsapp?.broadcastPacingMs ?? 8000,
            onEach: ({ index: i }) => job.progress(
              { stage: 'upload', text: `uploading to group ${before.length + i + 1}/${targets.length}` }, 92),
          });
          result = { sent: [...before, ...result.sent], failed: result.failed };
        } finally { stageSems.upload.release(); }
      }

      // Keeping the failures' code: a full disk at the upload is waited out
      // below, not failed for good (see noGroupPosted).
      if (!result.sent.length) throw noGroupPosted(result.failed, { isDiskFull });
      for (const f of result.failed) ctx.log.warn(`TV: could not post ${outName} to ${f.jid}: ${f.error}`);

      job.progress({ stage: 'done', text: `sent ${outName}` }, 100);
      const size = conv?.size ?? work.manifest.output?.size ?? 0;
      ctx.log.info(`✅ TV COMPLETE ${outName} — ${fmtBytes(size)} to ${result.sent.length} group(s) ` +
        `in ${fmtDuration(Math.round((Date.now() - started) / 1000))}`);
      ended = 'done';
      notifier?.episodeDone();
      this._retries?.forget(`${reqKey}:${ep.id}`);

      // Only mark the requester's message once the LAST episode lands,
      // otherwise a season would show ✅ after its first episode. "Last" is
      // the request's notifier's to say when there is one - every episode
      // accounted for - rather than this episode's place in the season: a
      // retried episode can land first, with the rest still waiting, or
      // after the one that was queued last. And it is marked with the
      // request's outcome, not this episode's: ⚠️ if an earlier one failed.
      if (typeof notifier?.isFinished === 'function') await this._reactEnding(ctx, notifier, react);
      else if (isLast) await react(R.done);
    } catch (err) {
      if (busyElsewhere) {
        // The same episode of the same request is running in this process
        // already: that run reports it, and deals with its journal entry.
        ctx.log.warn(`TV: not running ${label} twice: ${err.message}`);
        return;
      }
      // An admin's cancel is final whatever error it surfaced as. A job the
      // failover took off a dying connection ('interrupted') is not a cancel:
      // it is retried below, like a dropped connection.
      const interrupted = job.cancelReason?.() === 'interrupted';
      if (!interrupted && (err.code === 'CANCELLED' || job.isCancelled?.())) {
        const skipped = job.cancelReason?.() === 'skipped';
        ended = skipped ? 'skipped' : 'cancelled';
        await react(skipped ? R.skipped : R.cancelled);
        ctx.log.warn(`TV ${skipped ? 'skipped' : 'cancelled'}: ${label}`);
        this._retries?.forget(`${reqKey}:${ep.id}`);
        // Skip is this one episode; Cancel is the whole request, and that
        // includes an episode of it waiting on a retry (_dropBookedRetries).
        if (!skipped) this._dropBookedRetries(ctx, reqKey);
        // Report it: a cancelled episode that says nothing leaves the whole
        // request stuck on "queued" for ever. A skip that was its request's
        // last episode leaves the message on the request's outcome.
        notifier?.episodeCancelled(skipped ? 'skipped' : 'cancelled');
        await this._reactEnding(ctx, notifier, react);
        return;
      }
      // A dropped connection used to fail the episode for good: One Piece
      // S12E27 and S12E32, "could not post to any group: Connection Closed",
      // 06:42 and 06:50 UTC on 2026-09-28, each counted as failed in the
      // request's report. It is tried again once WhatsApp is back, like a
      // film. The request's notifier hears nothing until the episode's real
      // outcome, so a season still reports exactly once.
      //
      // So is a full disk, once there is room again (see the movie side's
      // deliver, and media/disk-space.js).
      const diskFull = !interrupted && isDiskFull(err);
      // DISK_WAIT and DISK_HELD are our own refusals while other work, kept
      // until it is sent, holds the room: the disk has not filled (see
      // disk-space.js notEnoughRoom).
      if (diskFull && err.code !== 'DISK_WAIT' && err.code !== 'DISK_HELD') noteDiskFull();
      // Not started for want of room other work holds: the operator hears
      // of it, as for a film (see the movie side's deliver).
      if (err.code === 'DISK_HELD') ctx.log.error(`TV: ${label}: ${err.message}`);
      if ((interrupted || isTransient(err) || diskFull) && reqKey) {
        // What it has done - the download as far as it got, the finished
        // episode - is kept for the retry, or the next start, to go on from
        // (media/work-files.js), whatever the disk has free: it used to be
        // reset when the disk was nearly full, and nothing is deleted before
        // the episode is sent now.
        room?.release();
        const made = conv && fs.existsSync(conv.outPath) ? conv : null;
        const keptWork = work.owned && work.has();
        const need = (o = {}) => jobNeed({
          workDir, kind: 'tv', sourceBytes: ep.size, maxOutputBytes: media.maxOutputBytes,
          made: keptWork && made ? made.size : null, ...shape, ...o,
        });
        const until = diskFull
          ? (signal) => waitForRoom({
            dir: workDir, key: retryKey, label, signal, log: ctx.log, unref: true,
            // Only with nothing kept of its own, as for a film (see there).
            waitOnKept: !keptWork, waitOnHeld: !keptWork, keptKey: retryKey, jobDir: work.dir,
            need: need({ onDisk: work.bytes() }),
          })
          : null;
        const attempt = this._retryEpisodeLater(ctx, {
          ep, msg, react, notifier, route, reqKey, index, total, isLast,
          // How the queue will record this attempt: a job the failover took
          // away ends cancelled, any other as failed (see queue.add's retry).
          lost: interrupted ? 'cancelled' : 'failed',
        }, err, { until });
        if (attempt) {
          retrying = true;
          // Room that comes back once the retry has finished with it (disk-space.js).
          if (keptWork) {
            keepRoom(retryKey, { dir: workDir, jobDir: work.dir, peak: need().peak, made: made ? made.size : null, label });
          }
          ctx.log.warn(`TV: ${label} failed transiently (${err.message}) - retrying once WhatsApp is connected `
            + `${diskFull ? 'and there is room on the disk ' : ''}(attempt ${attempt} of ${MAX_RETRIES})`);
          if (diskFull) this._noteWaitingForDisk(ctx, reqKey, label, err, attempt);
          // Distinct from the failure emoji, as for a film: this one is
          // coming back. It shows the stage the episode's kept work has
          // reached - where the retry goes on from, and mostly what the
          // message shows already, which react() does not send again - or
          // 🎬 with nothing done. It was 🔄, which asks the member for
          // nothing and was read as "send it again" (Iron Man 3,
          // 2026-10-11, media/stage-reaction.js).
          await react(stageReaction(R, { work }));
          throw err;
        }
        if (diskFull && keptWork) {
          // Out of attempts only for want of room that other jobs' kept work
          // holds: giving up would delete what it has done, which nothing is
          // deleted for now (the operator, 2026-09-30: "files should remain
          // in their folders until fully sent on whatsapp"). It stays
          // journalled, its work with it, for the next start - as a film
          // whose retries are spent is parked.
          retrying = true;
          ctx.log.warn(`TV: ${label} failed transiently (${err.message}) - retried ${MAX_RETRIES} times in this `
            + 'process; will retry on next start, going on from what it had done');
          await react(stageReaction(R, { work }));
          throw err;
        }
        ctx.log.warn(`TV: ${label} failed transiently again after ${MAX_RETRIES} retries - giving up on it`);
      }
      this._retries?.forget(`${reqKey}:${ep.id}`);
      ctx.log.error(`TV delivery failed for ${label}: ${err.message}`);
      ended = 'failed';
      endedWhy = err.message;
      await react(R.failed);
      notifier?.episodeFailed(err.message);
      throw err;
    } finally {
      // Reaching here at all means this episode is finished with - posted,
      // cancelled or failed - unless a retry is booked for it. That, like a
      // yield to a movie (which retries inside the loop above and never gets
      // here), keeps it journalled, so a restart before the retry runs still
      // replays it. An episode another run in this process has open is that
      // run's to finish.
      const finished = !retrying && !busyElsewhere;
      // Out of the journal, and that on the disk, before its work goes: the
      // work holds the record of the groups it was posted to, and deleted
      // while the journal's removal still waited on a debounced, unsynced
      // save, a kill in that half second posted the episode again at the
      // next start. If the journal cannot be written, the work stays (the
      // hourly sweep clears it once no journal holds it).
      let saved = false;
      if (finished) {
        this._journalEpisodeDone(ctx, reqKey, ep.id, ended, endedWhy, { keepWork: true });
        saved = ctx.store.flush?.() !== false;
      }
      room?.release();
      // Always free the disk: an episode is gigabytes and the box is small.
      // Its whole directory goes, through the delete guard - bar the work a
      // booked retry goes on from.
      if (finished && saved) work.drop();
      else if (finished) ctx.log.warn(`TV: keeping the work of ${label} until the journal can be saved`);
      work.release();
    }
  },

  /** The groups an episode's journal entry says it was posted to (_episodeSent). */
  _episodeSentTo(ctx, reqKey, epId) {
    if (!reqKey) return [];
    const req = (ctx.store.get('pending', []) ?? []).find((r) => r.reqKey === reqKey);
    const e = (req?.episodes ?? []).find((x) => String(x.id) === String(epId));
    return Array.isArray(e?.sentTo) ? e.sentTo : [];
  },

  /**
   * Note on an episode's journal entry that it was posted to `jid`: with the
   * work's own record (manifest.sent), what stops a restart posting it to
   * that group again, whatever became of the work.
   */
  _episodeSent(ctx, reqKey, epId, jid) {
    if (!reqKey) return;
    const pending = ctx.store.get('pending', []) ?? [];
    const req = pending.find((r) => r.reqKey === reqKey);
    if (!req?.episodes?.some((x) => String(x.id) === String(epId))) return;
    // A copy, not the entry changed in place: an episode's object can be
    // another request's as well (the same episode asked for twice), and the
    // mark is this request's alone.
    req.episodes = req.episodes.map((x) => (String(x.id) === String(epId)
      ? { ...x, sentTo: [...new Set([...(x.sentTo ?? []), jid])] } : x));
    ctx.store.set('pending', pending);
  },

  /**
   * Keep every queued TV request to at most `max` episodes, `max` being
   * tvRequests.maxEpisodesPerRequest unless given: the limit applies as a
   * request is made, and the operator wanted the ones queued before it set
   * (2026-10-12) kept to it too - trim-queued.js has their words and the
   * rules. With the limit 0 (none) and no `max`, there is nothing to keep
   * them to. The admin command 'trim-tv-requests' runs it.
   *
   * Without `apply` it is a dry run, and changes nothing: the answer is what
   * would be done, request by request - its member, what it keeps, what
   * would be taken off, and the exact words its member would be sent. With
   * it, the same is done and answered. Every request is decided and trimmed
   * in one pass with nothing awaited, so no episode starts or ends between
   * the two; only then are the members told, paced (CLAUDE.md rule 1). Run
   * again, it finds nothing over the limit and does nothing.
   *
   * A request in the queue is trimmed there (queue.trim), and each episode
   * taken off reaches its request as 'trimmed' (_discarder); one journalled
   * but not in the queue yet - waiting for the films after a restart
   * (recoverPending), or held behind the requests from before one
   * (_holdForRecovery) - is trimmed in the journal, which is what it goes in
   * from. Either way the episode leaves the journal, so no restart brings it
   * back. Its member, and each member following it as a duplicate
   * (_tellTvFollowers), gets one reply quoted to their own message. With
   * WhatsApp down nothing is trimmed unless `tell` is false: a trim nobody
   * could be told of leaves members waiting for episodes that are not
   * coming, and a second run, finding nothing over the limit, tells nobody.
   */
  async trimQueued(ctx, { max = null, apply = false, tell = true } = {}) {
    const cfg = ctx.config.tvRequests ?? {};
    const given = max != null && max !== '';
    const limit = given ? Number(max) : Number(cfg.maxEpisodesPerRequest ?? 0);
    if (given && !(Number.isInteger(limit) && limit > 0)) {
      throw new Error(`max must be a whole number of episodes, 1 or more - not ${JSON.stringify(max)}`);
    }
    if (!(limit > 0)) {
      throw new Error('tvRequests.maxEpisodesPerRequest is 0 (no limit), so there is no limit to keep the queued '
        + 'requests to - give "max", the most episodes one request may hold');
    }
    if (apply && tell && !ctx.bot?.isConnected?.()) {
      throw new Error('WhatsApp is not connected, so the members could not be told - nothing was trimmed; '
        + 'try again once it is, or with "tell": false');
    }
    // A request a restart left is not resumed until the films are (TV
    // recovery waits for them), and until then it has no notifier: trimmed
    // to nothing in the journal, it was dropped from it and never finished -
    // History "queued" for good, no ✅, no notice, its followers never told
    // (Lucifer season 6 on the live journal with "max": 4, found in review).
    // As mark-extras refuses while requests are still coming back.
    if (apply && this._awaitingRecovery?.size) {
      throw new Error(`${this._awaitingRecovery.size} TV request(s) left by the restart are still being put back into `
        + 'the queue - nothing was trimmed; run it again once they are');
    }
    const requests = [];
    const untouched = [];
    const replies = [];
    for (const req of [...(ctx.store.get('pending', []) ?? [])]) {
      const plan = this._trimPlanOf(ctx, req, limit);
      const words = this._trimWords(ctx, req, plan, limit);
      const { title } = words;
      if (!plan.off.length) { untouched.push(`${title} (${plan.holds} episode(s))`); continue; }
      const item = {
        request: title,
        member: [req.baseRow?.requester, phoneOut(req.requester ?? null)].filter((v, i, a) => v && a.indexOf(v) === i)
          .join(' ') || null,
        episodes: { before: plan.holds, after: plan.holds - plan.off.length },
        posted: plan.posted,
        ...(plan.failed ? { failed: plan.failed } : {}),
        inHand: trimCodes(plan.inHand) || null,
        kept: trimCodes(plan.keep) || null,
        takenOff: trimCodes(plan.off),
        // Of those, the ones its member was sent already by an earlier
        // request of theirs (_sentAlready).
        ...(plan.sent.length ? { sentAlready: trimCodes(plan.sent) } : {}),
        named: words.label,
        next: words.ask(req.route ?? null),
        reply: words.reply(req.route ?? null),
        told: null,
        followers: [],
      };
      const gone = [];
      for (const to of this._trimAudience(ctx, req)) {
        // A member following it whose every episode was taken off is no
        // longer waiting with it: told so, on their own words, and let go
        // (_trimRequest) rather than ended on its ✅.
        const lost = !to.owner && words.lost(to.asked);
        const said = to.owner ? item : { member: to.member, told: null, ...(lost ? { takenOff: true } : {}) };
        if (!to.owner) item.followers.push(said);
        if (lost) gone.push(to.follower);
        const text = to.owner ? item.reply : lost ? words.followerReply(to.route, to.asked) : words.reply(to.route, { owner: false });
        if (!to.owner) said.reply = text;
        if (to.cannot) said.told = `not told: ${to.cannot}`;
        else if (!apply) said.told = 'dry run: would be sent';
        else if (!tell) said.told = 'not told: "tell" is false';
        else replies.push({ to, text, said });
      }
      if (apply) this._trimRequest(ctx, req, plan, limit, words, gone);
      requests.push(item);
    }
    // Paced like every bulk send, the first at once (CLAUDE.md rule 1).
    for (const [i, r] of replies.entries()) {
      if (i) await ctx.bot._bulkPace?.();
      try {
        const sent = await ctx.bot.sendText(r.to.chatJid, r.text, { quoted: r.to.quoted });
        r.said.told = sent ? 'sent' : 'not sent: WhatsApp withheld it (a deleted message, or the outbound budget)';
      } catch (err) {
        ctx.log.warn(`TV: could not tell ${r.to.member ?? 'a member'} their request was trimmed: ${err.message}`);
        r.said.told = `not sent: ${err.message}`;
      }
    }
    if (apply) {
      ctx.log.info(`📺 trimmed ${requests.length} queued TV request(s) to at most ${limit} episodes`
        + `${requests.length ? `: ${requests.map((r) => `${r.request} (${r.takenOff} taken off)`).join(', ')}` : ''}`);
    }
    return {
      applied: !!apply, max: limit, trimmed: requests.length, requests, untouched,
      ...(apply ? {} : { note: 'a dry run - nothing was changed; send it again with "apply": true to do it' }),
    };
  },

  /**
   * Where a journalled request stands, for trimQueued: its episodes in hand
   * (running in the queue, or waiting for their retry, there or in the
   * RetryBook) and waiting (in the queue, `inQueue`, or not in it yet), what
   * it posted and failed (the journal's tally), and which of the waiting
   * ones it keeps under `limit` (trim-queued.js trimPlan). `holds` is every
   * episode it is made of, cancelled and skipped ones included, as its
   * notifier's total counts them.
   */
  _trimPlanOf(ctx, req, limit) {
    // Matched by item, as the queue's jobs carry it (`epId`): two episodes
    // with no number share a season and a number, and by those the plan kept
    // one while queue.trim took off both (found in review). A job without an
    // id - none this version queues - is matched by its number.
    const key = (m, id = m?.epId) => (id != null ? `id:${id}` : `${m?.season ?? ''}|${m?.episode ?? ''}`);
    const mine = (ep) => [key(ep, ep?.id), key(ep, null)];
    const running = new Set();
    const retried = new Set();
    const queued = new Set();
    for (const e of ctx.queue?.active?.values?.() ?? []) if (e.group === req.reqKey) running.add(key(e.meta));
    for (const e of ctx.queue?.pending ?? []) if (e.group === req.reqKey) (e.meta?.retry ? retried : queued).add(key(e.meta));
    const inHand = [];
    const waiting = [];
    const inQueue = new Set();
    for (const ep of req.episodes ?? []) {
      const id = `${req.reqKey}:${ep.id}`;
      const [byId, byNumber] = mine(ep);
      const has = (set) => set.has(byId) || set.has(byNumber);
      if (has(running) || has(retried) || this._retries?.isWaiting(id) || this._retryBooked?.has(id)) {
        inHand.push(ep);
        continue;
      }
      waiting.push(ep);
      if (has(queued)) inQueue.add(ep);
    }
    const t = req.tally ?? {};
    const posted = t.completed ?? 0;
    const failed = t.failed ?? 0;
    const { keep, off, past, sent } = trimPlan({
      done: posted + failed, inHand, waiting, max: limit, had: this._sentAlready(ctx, req),
    });
    const holds = posted + failed + (t.cancelled ?? 0) + (req.episodes ?? []).length;
    return { inHand, keep, off, past, sent, inQueue, posted, failed, holds };
  },

  /**
   * The episode numbers a journalled request's member was sent already by
   * an earlier request of theirs for the same season (trimPlan `had`): from
   * History, a row of theirs that ended 'sent', from a main group, about
   * episodes it names (hourly-policy.js tvEpisodes - a run, a list, one
   * episode, or what a cut row queued), less any it withheld on rating or
   * the server did not have. A whole season asked for is no use here - which
   * of its episodes it was is not on the row - and neither is a 'partial'
   * one, whose row does not say which of its episodes failed.
   *
   * Hunter x Hunter season 1, 148 episodes, was Ari's, and his "hunter x
   * hunter s1 e1-10" had been sent on 2026-10-08: kept to its first ten,
   * the season would have posted E1-E10 to him a second time (found in
   * review, 2026-10-12).
   */
  _sentAlready(ctx, req) {
    const out = new Set();
    const title = String(req.baseRow?.title ?? req.episodes?.[0]?.series ?? '').toLowerCase();
    const season = req.baseRow?.season ?? req.episodes?.[0]?.season ?? null;
    if (!title || season == null) return out;
    const me = req.memberKey
      ?? (req.requesterNumber ? requestMemberKey({ senderNumber: req.requesterNumber }) : null);
    if (!me) return out;
    for (const row of ctx.store.get('history', []) ?? []) {
      if (!row || row.status !== 'sent' || row.beta || row.id === req.baseRow?.id) continue;
      if (String(row.title ?? '').toLowerCase() !== title || (row.season ?? null) !== season) continue;
      if (requestMemberKey({ senderNumber: row.requesterNumber, senderJid: row.requesterJid }) !== me) continue;
      const eps = tvEpisodes(row);
      if (!eps) continue;
      const not = new Set([...numbersInCodes(row.withheld), ...numbersInCodes(row.absent)]);
      for (const n of eps) if (!not.has(n)) out.add(n);
    }
    return out;
  },

  /**
   * Everything a trim says about one request, and what it makes of it: what
   * its members are told (trim-queued.js), the message for its next part for
   * a route (next-part.js, as a request the limit cuts as it is made is told
   * it), and the name, the `cut` and the episode numbers it is left with.
   *
   * It is named as one the limit cut when it was made: "Arrow S01E01–E10 —
   * 10 of season 1" (queuedName), in the journal, the queue, History and its
   * finished notice, which names the next part as that one's does: "Arrow
   * season 1 — 10 episode(s)" after a trim read as the whole season, as "10
   * episode(s)" of a season of 23 had (cap-cut.js), and its notice named no
   * next part where a cut request's did. Only the numbers of every episode
   * it still holds say which those are (the journal's `numbers`,
   * _journalAdd): an entry an older version journalled that had posted some
   * already keeps that kind of name, and its `cut` counts what it holds by
   * what is left of it in the journal. One with nothing posted yet holds
   * every episode it lists.
   */
  _trimWords(ctx, req, plan, limit) {
    const cfg = ctx.config.tvRequests ?? {};
    const show = req.baseRow?.title ?? req.episodes?.[0]?.series ?? null;
    const season = req.baseRow?.season ?? req.episodes?.[0]?.season ?? null;
    const names = nameParts(req.label ?? req.reqKey, show, season);
    const { title } = names;
    const lead = show && names.asked ? `*${plainText(show)}* ${names.asked}` : `*${plainText(title)}*`;
    const only = parseTvRequest(String(req.baseRow?.request ?? '')).episodeList ?? null;
    const coming = [...plan.inHand, ...plan.keep];
    const parts = partsOf({ season, left: plan.past, coming: [...coming, ...plan.sent], max: limit, only: only?.length ? only : null });
    const last = parts.length === 1 && plan.past.every((e) => numbersOf(e).length);
    const ask = (route) => (parts.length && show ? nextAsk(parts[0], { name: show, prefix: this._askPrefix(cfg, route) }) : null);

    // What it holds once trimmed, by number, if every one is known.
    const offNumbers = new Set(plan.off.flatMap(numbersOf));
    const t = req.tally ?? {};
    const ended = (t.completed ?? 0) + (t.failed ?? 0) + (t.cancelled ?? 0);
    const was = req.numbers ? numbersOfRuns(req.numbers)
      : !ended && (req.episodes ?? []).every((e) => numbersOf(e).length) ? (req.episodes ?? []).flatMap(numbersOf) : null;
    const held = was ? [...new Set(was)].filter((n) => !offNumbers.has(n)).sort((a, b) => a - b) : null;
    const after = plan.holds - plan.off.length;
    const name = held?.length && show && names.asked ? partName(season, held, after, names.asked) : null;
    const label = name ? `${show} ${name.scope}${names.counted ? ` — ${name.count}` : ''}`
      : names.counted ? `${title} — ${after} episode(s)` : title;
    const pastRuns = runsOf(plan.past.flatMap(numbersOf));
    const queuedRuns = runsOf(held ?? coming.flatMap(numbersOf));
    const unnumbered = plan.past.filter((e) => !numbersOf(e).length).length;
    const count = held ? held.length : after;
    const cut = {
      limit,
      count,
      of: count + pastRuns.reduce((n, [a, b]) => n + b - a + 1, 0) + unnumbered,
      queued: queuedRuns,
      left: pastRuns,
      ...(unnumbered ? { unnumbered } : {}),
      next: parts.length ? { ...parts[0], last } : null,
      parts: parts.map((p) => [p.from, p.to]),
      trimmed: true,
      ...(plan.sent.length ? { sentAlready: runsOf(plan.sent.flatMap(numbersOf)) } : {}),
    };

    return {
      title, label, cut, held, after, ask, last,
      // History's and the queue's words for it: "S01E01–E10 — 10 of season 1".
      detailName: name ? `${name.scope} — ${name.count}` : `${names.asked ?? title} — ${after} episode(s)`,
      reply: (route, { owner = true } = {}) => trimReply({
        lead, max: limit, posted: plan.posted, failed: plan.failed,
        coming, off: plan.past, sent: plan.sent, ask: ask(route), last, owner,
      }),
      // A follower whose every episode it asked for was taken off (null: a
      // whole season, which never is).
      lost: (asked) => !!asked?.length && asked.every((n) => offNumbers.has(n)),
      followerReply: (route, asked) => {
        const mine = new Set(asked);
        const own = partsOf({ season, left: plan.off.filter((e) => numbersOf(e).some((n) => mine.has(n))), coming, max: limit, only: asked });
        const send = own.length && show ? nextAsk(own[0], { name: show, prefix: this._askPrefix(cfg, route) }) : null;
        return trimFollowerReply({
          lead: show ? `*${plainText(show)}* ${listCode(season, asked)}` : `*${plainText(title)}*`,
          max: limit, count: asked.length, ask: send, last: own.length === 1,
        });
      },
    };
  },

  /**
   * Who is told a request was trimmed: its member, on their request, and
   * each member following it as a duplicate (_tellTvFollowers), on theirs.
   * Not the member's own request sent again (`resend`): that is the same
   * member, told once. Each with the message it quotes - the request itself
   * while the bot holds it, else one built from the journal (heldMessage) -
   * or `cannot`, why nobody is told: a request queued from the panel, a
   * message its sender deleted (bot.js _noteRevoke), or a beta test whose
   * group has since become a main one (safeRoute, as for every reaction).
   */
  _trimAudience(ctx, req) {
    const history = ctx.store.get('history', []) ?? [];
    const out = [];
    const add = ({ owner, msgId, msgKey, chatJid, route, text, member, real = null }) => {
      const cannot = !msgId ? 'queued from the panel, with no message to answer'
        : !msgKey ? 'no message key was journalled to answer it by'
          : ctx.bot?.isRevoked?.(msgId) ? 'its message was deleted'
            : safeRoute(ctx.config, route)?.originIsMain ? 'a beta test whose group has since become a main group'
              : null;
      const quoted = real ?? heldMessage({ id: msgId, key: msgKey, chatJid, text: String(text ?? '') });
      out.push({ owner, member, route: route ?? null, chatJid: chatJid ?? msgKey?.remoteJid ?? null, quoted, cannot });
    };
    const real = [this._live?.get(req.reqKey)?.msg, this._reactors?.get(req.reqKey)?.msg]
      .find((m) => m?.raw && m.key?.id === req.msgId) ?? null;
    add({
      owner: true, msgId: req.msgId, msgKey: req.msgKey, chatJid: req.chatJid, route: req.route,
      text: req.baseRow?.typed ?? req.baseRow?.request, real,
    });
    const followers = this._followers?.get(req.reqKey) ?? req.followers ?? [];
    for (const f of followers) {
      if (!f || f.resend) continue;
      const row = history.find((h) => h.id === f.historyId);
      add({
        owner: false, msgId: f.msgId, msgKey: f.msgKey, chatJid: f.chatJid, route: f.route,
        text: row?.typed ?? row?.request, member: row?.requester ?? null,
      });
      // The episodes the follower asked for (null for a season), and which
      // follower it is, for one whose episodes were all taken off.
      Object.assign(out.at(-1), { asked: row ? tvEpisodes(row) : null, follower: f });
    }
    return out;
  },

  /**
   * Take a request's episodes in `plan.off` off (see trimQueued). What it is
   * now - its name, the `cut` the trim gave it and the next part its
   * finished notice names (_trimWords) - goes on its journal entry, its
   * History row and its notifier first, before any episode goes: a request
   * whose last episode goes here finishes now, and its finished row and
   * notice must say what it ended as. Its item in the queue is named so too.
   * `gone` are the members following it whose every episode was taken off:
   * let go, and their rows say so, so the request's ✅ is not theirs.
   */
  _trimRequest(ctx, req, plan, limit, words, gone = []) {
    const { after, label, cut, held } = words;
    const note = `${trimCodes(plan.off)} taken off the queue - one request is at most ${limit} episodes`;
    const trimmed = (was) => (was ? `${was}; ${note}` : note);
    const askNext = words.ask(req.route ?? null);
    const next = askNext ? { send: askNext, last: words.last } : null;
    const detail = (row) => `${words.detailName}${withheldSuffix(cutDetail(cut))}${rowSuffix(row)}`;
    const leaving = new Set(gone.map((f) => f?.msgId).filter(Boolean));
    const stay = (list) => (list ?? []).filter((f) => !leaving.has(f?.msgId));
    const pending = ctx.store.get('pending', []) ?? [];
    const entry = pending.find((r) => r.reqKey === req.reqKey);
    if (entry) {
      entry.label = label;
      if (entry.baseRow) {
        entry.baseRow = {
          ...entry.baseRow, episodes: after, detail: detail(entry.baseRow), trimmed: trimmed(entry.baseRow.trimmed), cut,
        };
      }
      if (next) entry.next = next;
      else delete entry.next;
      if (held) entry.numbers = runsOf(held);
      if (leaving.size && entry.followers) entry.followers = stay(entry.followers);
      ctx.store.set('pending', pending);
    }
    if (leaving.size && this._followers?.has(req.reqKey)) this._followers.set(req.reqKey, stay(this._followers.get(req.reqKey)));
    const id = req.baseRow?.id;
    const row = id ? (ctx.store.get('history', []) ?? []).find((h) => h.id === id) : null;
    if (row) this._history(ctx, { id, episodes: after, detail: detail(row), trimmed: trimmed(row.trimmed), cut });
    for (const f of gone) {
      const handoff = this._handoffs?.get(f?.msgId);
      if (handoff) handoff.ended = true;                   // see _updatePositions
      if (f?.historyId) {
        this._history(ctx, {
          id: f.historyId, status: 'trimmed', at: Date.now(),
          detail: `taken off the queue, with an earlier request for it — one request is at most ${limit} episodes`,
        });
      }
    }
    const live = this._live?.get(req.reqKey);
    const notifier = this._notifiers?.get(req.reqKey) ?? live?.notifier ?? null;
    notifier?.retitle?.({ label, cut, next });

    // In the queue: it takes them off, and each reaches the request's
    // notifier and the journal through its onDiscard (_discarder). A retry
    // waiting there is in hand, and never among them. By item, not number.
    const fromQueue = new Set(plan.off.filter((e) => plan.inQueue.has(e)).map((e) => String(e.id)));
    const numberKey = (m) => `${m?.season ?? ''}|${m?.episode ?? ''}`;
    const byNumber = new Set(plan.off.filter((e) => plan.inQueue.has(e)).map(numberKey));
    if (fromQueue.size) {
      ctx.queue.trim(req.reqKey, (job) => !!job.meta?.retry
        || (job.meta?.epId != null ? !fromQueue.has(String(job.meta.epId)) : !byNumber.has(numberKey(job.meta))));
    }
    // And each job left of it is "5/10", not "5/23": the panel's export
    // reads a finished request's size from it (csv-export.js). Its item in
    // the queue is named as the journal now names it (_groupOf).
    const groupLabel = String(label).replace(/ — \d+ (?:episode\(s\)|of .+)$/, '') || label;
    for (const e of [...(ctx.queue.pending ?? []), ...(ctx.queue.active?.values?.() ?? [])]) {
      if (e.group !== req.reqKey) continue;
      e.groupLabel = groupLabel;
      if (typeof e.meta?.position === 'string') e.meta.position = e.meta.position.replace(/\/\d+$/, `/${after}`);
    }
    const group = ctx.queue.groups?.get?.(req.reqKey);
    if (group) { group.label = groupLabel; ctx.queue.emit?.('state', ctx.queue.snapshot?.()); }
    // Not in the queue yet: out of the journal here, and its notifier told.
    // (A request a restart left, with no notifier until the films are back,
    // is never trimmed: see trimQueued.)
    const outside = plan.off.filter((e) => !plan.inQueue.has(e));
    for (const ep of outside) {
      notifier?.episodeTrimmed?.();
      this._journalEpisodeDone(ctx, req.reqKey, ep.id, 'trimmed');
    }
    if (outside.length) this._reactEnding(ctx, notifier, live?.react);
    ctx.log.info(`📺 trimmed "${words.title}" to ${after} episode(s), now "${label}": ${note}`
      + (gone.length ? `; ${gone.length} member(s) following it had every episode they asked for taken off` : ''));
  },
};
