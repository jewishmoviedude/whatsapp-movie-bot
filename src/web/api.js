import express from 'express';
import fs from 'node:fs';
import log from '../util/logger.js';
import {
  MASK, patchProblem, holdGroupClears, previewPatch, addedFilmGroupClashes, postsGroupEmptied, isWholeSettingsForm,
  sweepingChange, changesFingerprint,
} from '../config/store.js';
import { randomToken } from '../util/crypto.js';
import { verifyEmail, sendTestEmail, PRESETS } from '../util/mailer.js';
import {
  needsSetup, setupSuperAdmin, authenticate, requireAuth, requireSuperAdmin,
  migrateIfNeeded, listAdmins, addAdmin, removeAdmin, resetPassword, findAdmin, mustChangePassword,
  isRateLimited, recordFailure, clearFailures, isSuperAdmin, setAdminTimeout,
} from './auth.js';
import { DEFAULT_IDLE_MINUTES, effectiveIdleMinutes, ownIdleMinutes, parseIdleMinutes } from './idle.js';
import { verifyPassword } from '../util/crypto.js';
import { checkTools, fmtBytes, encoderStatus } from '../media/ffmpeg.js';
import { MODEL_PREFERENCES } from '../core/ai-providers.js';
import { listTickets, setTicketStatus } from '../core/tickets.js';
import { aggregateMembers, memberDetail, assignedMember, formatPhone, phoneOut, phonesInText } from '../core/members.js';
import { parseTvRequest } from '../plugins/tv-requests/parse.js';
import { parseMediaUrl, urlToRequestText } from '../util/media-url.js';
import { describeConfigChange, describeValue, changedPaths, describeChange } from '../util/diff.js';
import { scanLibrary, formatCatalogue } from '../core/catalogue.js';
import { parseJellyfinUrl } from '../core/jellyfin-url.js';
import { linkForDisplay } from '../media/public-link.js';
import { ytDlpPaths, fmtLength } from '../media/yt-dlp.js';
import { readStamp as readYtDlpStamp } from '../media/yt-dlp-install.js';
import { describeCookies, saveCookies, removeCookies } from '../media/yt-dlp-cookies.js';
import { filterAudit, categoryCounts, auditCategories, summariseAdmin } from '../core/audit-filter.js';
import {
  listWanted, listResolvedWanted, allWanted, resetWanted, findWanted, resolveWanted, reopenWanted, addWantedNote,
  deleteWantedNote,
} from '../core/wanted.js';
import { WantedRecheck, describeFound, describeNotFilm, lookUpWanted } from '../core/wanted-recheck.js';
import { ArrivalReruns } from '../core/wanted-arrival.js';
import { listMisses, missCounts, resetMisses, formatMisses, MISS_REASONS } from '../core/library-misses.js';
import {
  listOverrides, addOverride, removeOverride, describeOverride, overrideLabel, isOverridden, tvOverrideFor, BYPASS_NOTE,
  mayCoverFilms,
} from '../core/rating-overrides.js';
import { describeLink, libraryMatches } from '../plugins/tv-requests/override-check.js';
import { buildDigest } from '../core/daily-digest.js';
import { libraryPager, libraryItemById, tvItemRefusal } from '../plugins/movie-requests/library.js';
import path from 'node:path';
import { SECRET_PATHS, mergeDefaults } from '../config/schema.js';
import { betaConfig, betaConflicts, addedConflicts, normalizeBetaPatch, describeFeatures, testersGuide, mainGroupRoles, MODES as BETA_MODES } from '../core/beta.js';
import { summarisePickLists, narrowDownText, oneTitle, requestPrefix } from '../plugins/movie-requests/pick-list.js';
import { severalFilms, oneFilmReply } from '../plugins/movie-requests/several-films.js';
import { asksWhichOne, stepZero, lookupHeldFilm } from '../plugins/movie-requests/step-zero.js';
import { listAccounts, addAccount, removeAccount, switchAccount, updateAccount } from '../core/accounts.js';
import { testLibrary } from '../plugins/movie-requests/library.js';
import {
  authenticateByPassword, quickConnectEnabled, quickConnectInitiate,
  quickConnectPoll, verifyToken,
} from '../plugins/movie-requests/jellyfin-auth.js';
import { lookupMovie, isTooBroad } from '../plugins/movie-requests/omdb.js';
import { isTheatricalOnly, isBlockedRating, isUnrated } from '../plugins/movie-requests/theatrical.js';
import { aiCanClear, notClearedWhy } from '../plugins/movie-requests/content-check.js';
import { ratingGate, fileGate, contentGate } from '../plugins/movie-requests/film-gate.js';
import { describeFailure } from '../core/content-check-health.js';
import { providerLabel, scrubFailure, configuredKeys, anyAiKey } from '../core/ai-providers.js';
import { mountAiRoutes } from './ai-routes.js';
import { mountKeyTestRoutes } from './key-test-routes.js';
import { mountHourlyCheckRoutes, hourlyCheckDiagnostics } from './hourly-checks-routes.js';
import { mountDiscordRoutes } from './discord-routes.js';
import { lockdownCityProblem, lockdownMinutesProblem, lockdownSettingsProblem, windowSummary } from '../core/lockdown.js';
import { findInLibrary, closestNote } from '../plugins/movie-requests/library.js';
import { typedYearOf } from '../util/fuzzy.js';
import { readAutoUpdate, runningCommit, processStartedAt } from '../core/auto-update-status.js';
import { askedAgain } from '../core/hourly-policy.js';
import { ticketLabel } from '../core/issue-tickets.js';

const logger = log.scope('api');

// Taken when the process loads, not per request: a pull made while it runs
// changes HEAD on disk, not the code in memory.
const RUNNING_COMMIT = runningCommit();
const STARTED_AT = processStartedAt();

export function createApiRouter({ configStore, bot, queue, linkQueue = null, pluginManager, stateStore, fileLogger, alerts, lockScheduler, failover = null, contentHealth = null, spareLinker = null, requestPause = null, wantedRecheck = null, discordWatch = null, arrivals = null }) {
  const router = express.Router();
  const guard = requireAuth(configStore);
  const superGuard = requireSuperAdmin(configStore);
  migrateIfNeeded(configStore);

  // Audit trail: every successful mutating request is recorded with the acting
  // admin, so each action is attributable. Sensitive body fields are dropped.
  const auditStore = stateStore.namespace('audit');

  /**
   * Record one action against the admin who took it.
   *
   * Marks the response as already audited so the catch-all below does not add
   * a second, contentless row for the same action - the log used to carry both
   * "unlocked all groups (manual)" and "POST /lockdown/unlock" for one click.
   */
  function audit(req, action, detail, res = null) {
    if (res) res.locals.audited = true;
    auditStore.push('events', {
      ts: Date.now(),
      user: req.session?.user?.username ?? '?',
      role: req.session?.user?.role ?? '?',
      ip: req.ip,
      action,
      detail: detail ?? `${req.method} ${req.path}`,
    }, 2000);
  }
  /**
   * The context that makes a queue action reconstructable later: who asked for
   * it, what state it was in when the admin acted, and for TV which episode.
   */
  function describeJob(job) {
    if (!job) return 'the job was already gone';
    const bits = [];
    if (job.kind && job.kind !== 'movie') bits.push(job.kind);
    if (job.state) bits.push(job.state);
    const who = phoneOut(job.meta?.requester ?? job.meta?.requesterNumber);
    if (who) bits.push(`requested by ${who}`);
    if (job.meta?.position) bits.push(`episode ${job.meta.position}`);
    // A whole TV request, which the queue moves and cancels as one.
    if (job.jobs?.total) {
      const { total, done = 0 } = job.jobs;
      bits.push(`${total} episode${total === 1 ? '' : 's'}${done ? `, ${done} done` : ''}`);
    }
    return bits.length ? bits.join(' · ') : null;
  }

  /** A readable list for the audit detail column - a full queue is 50 titles. */
  function nameList(labels, max = 10) {
    if (!labels.length) return null;
    const shown = labels.slice(0, max).join(' · ');
    return labels.length > max ? `${shown} … and ${labels.length - max} more` : shown;
  }

  /** Name a manual requeue by the title it resolved to, not the raw input. */
  function auditRequeue(req, res, result, typed, member = null) {
    const name = result?.title
      ? `${result.title}${result.year ? ` (${result.year})` : ''}${result.season ? ` S${result.season}` : ''}`
      : typed;
    const detail = result?.episodes > 1 ? `${result.episodes} episode(s)` : null;
    audit(req, `queued "${name}" by hand${forWhom(member)}`, detail ?? (name === typed ? null : `typed: ${typed}`), res);
  }

  router.use((req, res, next) => {
    if (['POST', 'PUT', 'DELETE'].includes(req.method) && req.session?.user
        && !req.path.startsWith('/auth/')) {
      // Backstop only. A route that describes its own action sets
      // res.locals.audited and is skipped here.
      res.on('finish', () => {
        if (res.statusCode < 400 && !res.locals.audited) audit(req, `${req.method} ${req.path}`);
      });
    }
    next();
  });

  /* ----------------------------- auth ----------------------------- */

  router.get('/auth/status', (req, res) => {
    res.json({
      setupRequired: needsSetup(configStore),
      authed: !!req.session?.user,
      // The account list, not the session's copy, says whether a password
      // still has to be changed: a reset can come after the sign-in.
      user: req.session?.user
        ? { ...req.session.user, mustChangePassword: mustChangePassword(configStore, req.session.user.username) }
        : null,
    });
  });

  router.post('/auth/setup', (req, res) => {
    if (!needsSetup(configStore)) return res.status(409).json({ error: 'already-configured' });
    try {
      setupSuperAdmin(configStore, req.body?.password);
      req.session.user = { username: 'superadmin', role: 'superadmin' };
      audit(req, 'setup super-admin', null, res);
      res.json({ ok: true, user: req.session.user });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/auth/login', (req, res) => {
    if (isRateLimited(req)) return res.status(429).json({ error: 'Too many attempts. Wait 15 minutes.' });
    const user = authenticate(configStore, req.body?.username, req.body?.password);
    if (user) {
      clearFailures(req);
      req.session.user = user;
      audit(req, 'login', null, res);
      return res.json({ ok: true, user });
    }
    recordFailure(req);
    res.status(401).json({ error: 'Wrong username or password' });
  });

  router.post('/auth/logout', (req, res) => {
    audit(req, 'logout', null, res);
    req.session.destroy(() => res.json({ ok: true }));
  });

  /* ---------------------- admin account management ---------------- */

  /** The global sign-out default, which any admin without their own follows. */
  const defaultIdle = () => configStore.get().web?.idleTimeoutMinutes ?? DEFAULT_IDLE_MINUTES;
  const minutesText = (m) => (m === 0 ? 'never' : `${m} min`);
  const describeIdle = (m) => (m === null ? `the default (${minutesText(defaultIdle())})` : minutesText(m));

  router.get('/admins', guard, (req, res) => {
    const web = configStore.get().web;
    res.json({
      admins: listAdmins(configStore),
      me: req.session.user,
      defaultIdleMinutes: defaultIdle(),
      // What the idle guard will apply to whoever is asking, so My account can
      // say it without re-implementing the lookup in the browser.
      myIdle: {
        minutes: effectiveIdleMinutes(web, req.session.user?.username),
        own: ownIdleMinutes(web, req.session.user?.username),
      },
    });
  });

  /**
   * Set how long one admin may stay signed in while idle: {minutes: n} for a
   * value of their own (0 = never), {minutes: null} for the global default.
   *
   * Super-admin only, and a refusal is audited rather than answered quietly
   * like the other super-admin routes: this is the one setting a plain admin
   * has a reason to try to change for themselves, and the owner wants to know
   * if someone did. setAdminTimeout() checks the role again on its own.
   */
  router.put('/admins/:username/timeout', guard, (req, res) => {
    const target = req.params.username;
    if (!isSuperAdmin(configStore, req.session.user)) {
      logger.warn(`refused: "${req.session.user?.username}" tried to set the sign-out timeout for "${target}"`);
      audit(req, `refused: set the sign-out timeout for "${target}"`,
        `asked for ${JSON.stringify(req.body?.minutes ?? null)} · super-admin only`, res);
      return res.status(403).json({ ok: false, error: 'Only the super-admin can set sign-out timeouts.' });
    }
    try {
      const { username, before, after } = setAdminTimeout(configStore, req.session.user, target, req.body?.minutes);
      audit(req, `set the sign-out timeout for "${username}" to ${describeIdle(after)}`,
        `was ${describeIdle(before)}`, res);
      res.json({ ok: true, admins: listAdmins(configStore), defaultIdleMinutes: defaultIdle() });
    } catch (err) {
      logger.warn(`sign-out timeout for "${target}" not changed: ${err.message}`);
      if (err.status === 403) audit(req, `refused: set the sign-out timeout for "${target}"`, err.message, res);
      res.status(err.status ?? 400).json({ ok: false, error: err.message });
    }
  });

  router.post('/admins', guard, superGuard, (req, res) => {
    try {
      addAdmin(configStore, req.body?.username, req.body?.password, req.body?.role || 'admin');
      audit(req, `add admin "${req.body?.username}" (${req.body?.role || 'admin'})`, null, res);
      res.json({ ok: true, admins: listAdmins(configStore) });
    } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
  });

  router.delete('/admins/:username', guard, superGuard, (req, res) => {
    try {
      removeAdmin(configStore, req.params.username);
      // Removing someone is meant to end their access, but requireAuth only
      // asks whether a session HAS a user. A removed admin's open tab kept
      // plain-admin rights for as long as they kept clicking - and, if the
      // default sign-out timeout was 0, for good. Found reviewing per-admin
      // timeouts; the password reset above already did this cleanup.
      let ended = 0;
      try { ended = req.sessionStore?.destroyUser?.(req.params.username) ?? 0; } catch (err) {
        logger.warn(`removed "${req.params.username}" but could not end their sessions: ${err.message}`);
      }
      audit(req, `remove admin "${req.params.username}"`,
        ended ? `signed out ${ended} session(s)` : 'they had no session open', res);
      res.json({ ok: true, admins: listAdmins(configStore), endedSessions: ended });
    } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
  });

  router.post('/admins/:username/reset', guard, superGuard, (req, res) => {
    try {
      // A password a super-admin chose for someone else is temporary: its
      // holder picks their own at the next sign-in. Resetting your own account
      // here is the same as changing it, so it is not.
      const own = req.params.username.trim().toLowerCase() === String(req.session.user?.username ?? '').toLowerCase();
      resetPassword(configStore, req.params.username, req.body?.password, { temporary: !own });
      // A reset that leaves the old sessions alive locks nobody out - the point
      // of resetting someone's password is usually that they should not still
      // be in. Their own session goes too; they sign in with the new password.
      let ended = 0;
      try { ended = req.sessionStore?.destroyUser?.(req.params.username) ?? 0; } catch { /* best effort */ }
      audit(req, `reset password for "${req.params.username}"`,
        ended ? `signed out ${ended} session(s)` : 'they had no session open', res);
      res.json({ ok: true, endedSessions: ended });
    } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
  });

  /**
   * Change your own password. Available to every admin, not just super-admins:
   * an account whose holder cannot rotate its own credentials is one nobody
   * can secure after a leak.
   */
  router.post('/auth/password', guard, (req, res) => {
    const { current, next } = req.body ?? {};
    const me = findAdmin(configStore, req.session.user.username);
    if (!me || !verifyPassword(current, me.passwordHash)) {
      return res.status(401).json({ error: 'Current password is wrong' });
    }
    if (typeof next === 'string' && next === current) {
      return res.status(400).json({ error: 'The new password is the same as the current one' });
    }
    try {
      resetPassword(configStore, me.username, next);

      // Anyone else signed in as this account is signed out. Changing a
      // password because you think someone else has it should actually END
      // their access; leaving their cookie working makes the change cosmetic.
      let endedElsewhere = 0;
      try {
        endedElsewhere = req.sessionStore?.destroyUser?.(me.username, { keepSid: req.sessionID }) ?? 0;
      } catch { /* never fail the change over the cleanup */ }

      audit(req, 'changed own password',
        endedElsewhere ? `signed out ${endedElsewhere} other session(s)` : 'no other sessions were open', res);
      res.json({ ok: true, endedElsewhere });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  /* ------------------------------ audit --------------------------- */

  /**
   * An audit entry as the panel shows it. Entries written before 2026-10-01
   * name a requester as "+1 (555) 810-0180"; they are shown as +15558100180,
   * the form every number has taken since (the operator: "EVERYWHERE ON THE
   * BOT NUMBERS SHOULD BE FORMATTED +COUNTRYAREANUMBER"). The log itself is a
   * record and is left as it was written.
   */
  const auditShown = (e) => (e && typeof e === 'object'
    ? { ...e, action: phonesInText(e.action), detail: phonesInText(e.detail) }
    : e);
  /**
   * The audit log, filterable. The portal asks for one admin's activity, or
   * one kind of action - scrolling a flat stream of every mutating request to
   * find "who reset a password" was the only option before.
   *
   * Returns a bare array when nothing is filtered, so anything still expecting
   * the old shape keeps working.
   */
  router.get('/audit', guard, (req, res) => {
    const events = auditStore.get('events', []);
    const { user, category, q, limit, offset } = req.query;
    if (!user && !category && !q && !limit && !offset) return res.json(events.map(auditShown));

    const page = filterAudit(events, {
      user, category, q,
      limit: Math.min(1000, Number(limit) || 200),
      offset: Number(offset) || 0,
    });
    res.json({
      ...page,
      events: page.events.map(auditShown),
      counts: categoryCounts(events, { user }),
      categories: auditCategories(),
    });
  });

  /** One admin's activity, with a summary of what they mostly do. */
  router.get('/admins/:username/audit', guard, (req, res) => {
    const events = auditStore.get('events', []);
    const name = req.params.username;
    const page = filterAudit(events, {
      user: name,
      category: req.query.category,
      q: req.query.q,
      limit: Math.min(1000, Number(req.query.limit) || 200),
    });
    res.json({
      username: name,
      ...page,
      events: page.events.map(auditShown),
      summary: summariseAdmin(events, name),
      counts: categoryCounts(events, { user: name }),
      categories: auditCategories(),
    });
  });
  router.delete('/audit', guard, superGuard, (req, res) => {
    audit(req, 'cleared the audit log', null, res);
    auditStore.set('events', auditStore.get('events', []).slice(0, 1));
    res.json({ ok: true });
  });

  /* ---------------------------- config ---------------------------- */

  router.get('/config', guard, (req, res) => {
    res.json(configStore.redacted());
  });

  /**
   * Turn a settings save away whole, with a reason, a log line and an audit row.
   *
   * Whole, not with the offending field stripped and the rest saved. The two
   * fields this route already strips (the legacy password hash, an empty group
   * list) are things the form sends by accident; this is for things the admin
   * saving is not allowed to do, which elsewhere in this file is superGuard's
   * job - and superGuard refuses the whole request. A partial save would also
   * answer with an error the panel shows as "not saved", while the server had
   * in fact saved most of it. The panel leaves the field out for anyone who
   * may not change it, so an ordinary save never lands here.
   */
  const describeChanges = (changes) => changes.map(describeChange);

  function refuseSettings(req, res, status, message, detail, { changes = null, body = {} } = {}) {
    // A refused save names everything it would have changed, so the row says
    // what was kept from happening and the page that sent it can be found.
    const would = changes ? ` It would have changed ${changes.length} setting${changes.length === 1 ? '' : 's'} — ${changes.join('; ')}.` : '';
    logger.warn(`refused a settings save by "${req.session.user?.username}": ${detail} - ${message}${would}`);
    audit(req, `refused: ${detail}`, `${message} Nothing was saved.${would}`, res);
    res.status(status).json({ error: `${message} Nothing was saved.`, ...body });
  }

  router.put('/config', guard, async (req, res) => {
    try {
      const patch = req.body ?? {};
      const current = configStore.get();

      // First, because every check below reads patch.web as an object and
      // skips it otherwise: {"web": []} or {"__proto__": ...} walked straight
      // past them, and past the audit log too. See patchProblem for what each
      // one did. The store skips unsafe keys on its own as well; this is what
      // turns the attempt into a refusal someone can see.
      const problem = patchProblem(current, patch);
      if (problem) {
        return refuseSettings(req, res, 400, `That is not a settings save the panel would send: ${problem}.`,
          'a malformed settings save');
      }

      // Which city each end of the Shabbos lockdown is measured in. An unknown
      // one would be read as the default, so a typo would quietly become a
      // window nobody chose - refuse it, with the two that exist.
      const cityProblem = lockdownCityProblem(patch.lockdown);
      if (cityProblem) {
        return refuseSettings(req, res, 400, `${cityProblem}.`, 'set an unknown lockdown city');
      }
      // And the minutes: an emptied box used to be stored as 0, and a havdalah
      // of 0 is no havdalah at all to hebcal - see lockdownMinutesProblem.
      const minutesProblem = lockdownMinutesProblem(patch.lockdown);
      if (minutesProblem) {
        return refuseSettings(req, res, 400, `${minutesProblem}.`, 'set invalid lockdown minutes');
      }
      // The lockdown card always sends its always-locked list, and its Save is
      // somebody choosing that list - an empty one included, which says no
      // group here is admins-only for good. On a new install the schedule
      // waits for that, or for a ticked group (scheduleHeld in lockdown.js).
      if (patch.lockdown && typeof patch.lockdown === 'object' && Object.hasOwn(patch.lockdown, 'alwaysLocked')) {
        patch.lockdown.alwaysLockedReviewed = true;
      }

      // The password hash is managed through /auth/password only.
      if (patch.web) delete patch.web.adminPasswordHash;
      const web = patch.web && typeof patch.web === 'object' ? patch.web : null;
      const isSuper = isSuperAdmin(configStore, req.session.user);

      // Accounts, per-admin sign-out timeouts included, are changed through
      // /admins only. A settings save that carries web.admins replaces the list
      // wholesale: from a plain admin that is promoting themselves or giving
      // their own account a timeout of 0, and from anyone it is a list
      // without password hashes (the browser never has them) - every account
      // locked out at once.
      if (web && Object.hasOwn(web, 'admins')) {
        return isSuper
          ? refuseSettings(req, res, 400, 'Admin accounts are changed in the Admins tab, not through settings.',
            'change admin accounts through settings')
          : refuseSettings(req, res, 403, 'Only the super-admin can change admin accounts.',
            'change admin accounts through settings');
      }

      // The Discord connection is the operator's own account (discord-routes.js):
      // its token is the whole account, and what it reads is theirs to choose.
      // Its card is the only way in - super-admin only, the token checked with
      // Discord first, every change audited - so a settings save carrying any
      // of it is refused, as the admin accounts above are.
      if (Object.hasOwn(patch, 'discord')) {
        return isSuper
          ? refuseSettings(req, res, 400, 'The Discord connection is changed on its own card (Settings → Connection → Discord), not through settings.',
            'change the Discord connection through settings')
          : refuseSettings(req, res, 403, 'Only the super-admin can change the Discord connection.',
            'change the Discord connection through settings');
      }

      // The global sign-out timeout is the super-admin's to set, 0 above all.
      // Resaving the value that is already there is not a change, so an older
      // copy of the panel that still sends it does not break a plain admin's
      // save of everything else.
      if (web && Object.hasOwn(web, 'idleTimeoutMinutes')) {
        const was = current.web?.idleTimeoutMinutes ?? DEFAULT_IDLE_MINUTES;
        const want = web.idleTimeoutMinutes;
        if (want !== was) {
          if (!isSuper) {
            return refuseSettings(req, res, 403, 'Only the super-admin can change the sign-out timeout.',
              `change the sign-out timeout from ${was} to ${JSON.stringify(want)} min`);
          }
          parseIdleMinutes(want);            // throws the reason; answered as a 400 below
        }
      }

      // A form sent before its group pickers were drawn, or from a card whose
      // saved group the connected number is not in, used to empty the stored
      // groups - see holdGroupClears. A group setting is emptied only when the
      // save names it in ?clearGroups=, which the panel does when somebody
      // chose "none" over a saved group. ?allowEmptyGroups=1 is how an older
      // panel says so for the request groups, and is still honoured. Before
      // the beta checks below, so they judge the config that will be saved.
      const confirmed = String(req.query.clearGroups ?? '').split(',').map((p) => p.trim()).filter(Boolean);
      if (req.query.allowEmptyGroups === '1') confirmed.push('movieRequests.requestGroups');
      const held = holdGroupClears(current, patch, confirmed);
      // A beta group or beta posts group that is also a main group would let a
      // test reach real members, so that save is refused outright with the
      // reason - from either side. Checked against the config as it WOULD be
      // after this save. A refusal is the safety event this whole feature
      // exists for, so it is logged and audited, not just returned.
      const refuseBeta = (message, what) => {
        logger.warn(`refused a settings save by "${req.session?.user?.username ?? '?'}": ${what} - ${message}`);
        audit(req, `refused: ${what}`, `${message} Nothing was saved.`, res);
        return res.status(400).json({ error: `${message} Nothing was saved.` });
      };
      const groupName = (jid) => bot.groups?.().find((g) => g.jid === jid)?.subject ?? jid;
      if (patch.beta !== undefined) {
        try {
          patch.beta = normalizeBetaPatch(patch.beta, undefined, { current });
        } catch (err) {
          return refuseBeta(err.message, 'a malformed beta testing save');
        }
        const clash = betaConflicts(mergeDefaults(patch, current))[0];
        if (clash) {
          return refuseBeta(`"${groupName(clash.jid)}" is already the ${clash.role}, so it cannot also be the ${clash.as} — `
            + 'beta testing must stay in groups the main service does not use.', `make a main group the ${clash.as}`);
        }
      } else {
        const clash = addedConflicts(current, mergeDefaults(patch, current))[0];
        if (clash) {
          const is = clash.as === 'beta group' ? 'a beta group' : 'the beta posts group';
          return refuseBeta(`"${groupName(clash.jid)}" is ${is}, so it cannot also be the ${clash.role} — `
            + 'take it off Settings → Beta 🧪 first.', `make ${is} the ${clash.role}`);
        }
      }
      // The numbers never to tag and the banned numbers are kept as their
      // digits, which is what everything matches them on, however they were
      // pasted - "+15558100180" or "+1 (555) 810-0180". The panel strips
      // them before saving; a save from anywhere else need not have.
      const digitsList = (list) => [...new Set(list.map((x) => String(x ?? '').replace(/[^0-9]/g, '')).filter(Boolean))];
      if (Array.isArray(patch.movieRequests?.notify?.noTag)) {
        patch.movieRequests.notify.noTag = digitsList(patch.movieRequests.notify.noTag);
      }
      if (Array.isArray(patch.bannedNumbers)) patch.bannedNumbers = digitsList(patch.bannedNumbers);

      // Judged on what the save would leave, before it is made: see
      // filmGroupClashes and the saves of 2026-10-12 in src/config/store.js.
      // The two group checks are never confirmed past - no film request group
      // can sensibly be a posts group, the TV request group or the
      // notifications group, nor a film plugin take requests with nowhere to
      // post - so they are refused outright, as a beta clash is.
      const next = previewPatch(current, patch);
      const changes = changedPaths(current, next, SECRET_PATHS);
      const clashes = addedFilmGroupClashes(current, next);
      if (clashes.length) {
        // Every one named, so the person saving sees the whole of it at once.
        const named = clashes.map((c) => `"${groupName(c.jid)}" is ${c.as}`);
        const list = named.length === 1 ? named[0] : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`;
        const roles = [...new Set(clashes.map((c) => c.as))];
        return refuseSettings(req, res, 400, `${list}, so ${['it cannot', 'neither can'][clashes.length - 1] ?? 'none of them can'} also be a `
          + 'film request group - the film plugin would answer every message posted there.',
        `make ${roles.length === 1 ? roles[0] : roles.join(', ')} a film request group`,
        { changes: describeChanges(changes) });
      }
      if (postsGroupEmptied(current, next)) {
        return refuseSettings(req, res, 400, 'The film request groups would have no posts group: every film found would '
          + 'be found for nobody. Pick a posts group in the same save, or untick the request groups.',
        'leave the film request groups without a posts group', { changes: describeChanges(changes) });
      }
      // A page still running the panel from before 2026-10-12 sends every box
      // on the Settings tab with every save, and writes back whatever it
      // still shows over changes made since it loaded - the 22:10 save. It
      // cannot say which boxes were edited, so nothing of it is saved; a
      // reload gives it the panel that sends only those (isWholeSettingsForm).
      // One that would change nothing is let through: it harms nothing, and
      // the answer brings that page back in step with the server.
      if (isWholeSettingsForm(patch) && req.query.edited !== '1' && changes.length) {
        return refuseSettings(req, res, 409, 'This page was loaded before Save settings changed on 2026-10-12: it sends '
          + 'every box on the Settings tab, including any changed elsewhere since it loaded, and would put them back. '
          + 'Reload the page and make the change again.',
        'a settings save of the whole form, from a page loaded before 2026-10-12',
        { changes: describeChanges(changes) });
      }
      // Many settings across sections at once is made only when the sender
      // confirms exactly that list - see sweepingChange. The panel asks with
      // the list in front of the person saving; a page from before it could
      // ask (the 22:10 save came from one) is told to reload.
      const sweep = sweepingChange(changes);
      const fingerprint = sweep ? changesFingerprint(changes) : null;
      if (sweep && req.query.confirm !== fingerprint) {
        const listed = describeChanges(changes);
        return refuseSettings(req, res, 409,
          `This save would change ${changes.length} settings across ${sweep.sections.length} section${sweep.sections.length === 1 ? '' : 's'} `
          + `(${sweep.sections.join(', ')}) at once. A page left open since those settings last changed sends exactly that, `
          + 'and saving it would put back everything it still shows: reload the page and make the change again.',
          `a settings save changing ${changes.length} settings in ${sweep.sections.length} sections at once`,
          { changes: listed, body: { confirm: fingerprint, changes: listed } });
      }
      const before = JSON.parse(JSON.stringify(current));
      const updated = configStore.update(patch);
      await pluginManager.notifyConfigChange(updated);
      // Recorded once the rest has been saved, so the row never claims a save
      // that a refusal above then turned away. Worded to land in the audit
      // log's Settings bucket, not Groups.
      if (held.length) {
        const what = held.map((h) => `${h.path} (${describeValue(h.was)})`).join('; ');
        const it = held.length === 1 ? 'it was' : 'they were';
        logger.warn(`kept ${what}: a settings save by "${req.session?.user?.username ?? '?'}" would have `
          + 'emptied it without saying it meant to - the rest of the save was applied');
        audit(req, `settings save kept ${held.length} setting${held.length === 1 ? '' : 's'} it would have emptied`,
          `${what} — the save did not say ${it} emptied on purpose, so ${it} kept. The rest of the save was applied.`, res);
      }
      // "PUT /config" alone told you an admin changed something but never what.
      // Secret values are reported as "changed" and never written out.
      const summary = describeConfigChange(before, updated, SECRET_PATHS);
      if (summary) audit(req, 'changed settings', summary, res);
      else res.locals.audited = true;          // an unmodified save is not an event
      logger.info(`configuration updated${summary ? ` — ${summary}` : ' (no effective change)'}`);
      res.json(configStore.redacted());
    } catch (err) {
      logger.warn(`settings save by "${req.session.user?.username}" failed: ${err.message}`);
      res.status(400).json({ error: err.message });
    }
  });

  /**
   * The beta-testing card: the feature registry, the saved beta settings, and
   * which groups the main service already uses (so the card can refuse to
   * offer them). The registry lives in code, not config, so the panel has no
   * other way to learn it. Saving goes through PUT /config like everything
   * else.
   */
  router.get('/beta', guard, (req, res) => {
    const cfg = configStore.get();
    res.json({
      features: describeFeatures(cfg),
      modes: BETA_MODES,
      beta: betaConfig(cfg),
      mainGroups: Object.fromEntries(mainGroupRoles(cfg)),
      conflicts: betaConflicts(cfg),
      // How the "which one?" list is doing, over the requests History still
      // holds: shown, picked, expired, wrong numbers, median time to pick.
      pickList: summarisePickLists(stateStore.namespace('movie-requests').get('history', []) ?? []),
    });
  });

  /**
   * The testers' guide as a text file to download and share in a beta group:
   * every feature on Beta, or ?code=beta003 for one. See testersGuide().
   */
  router.get('/beta/guide', guard, (req, res) => {
    const code = typeof req.query.code === 'string' && /^beta\d{3}$/.test(req.query.code) ? req.query.code : null;
    if (req.query.code != null && !code) return res.status(400).json({ error: 'that is not a beta number' });
    const g = testersGuide(configStore.get(), { code });
    if (!g.ok) return res.status(404).json({ error: g.error });
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${g.filename}"`);
    res.send(g.text);
  });

  /* --------------------------- whatsapp --------------------------- */

  /** The link-request queue, kept separate from the media one. */
  router.get('/queue/links', guard, (req, res) => {
    if (!linkQueue) return res.json({ pending: [], active: [], history: [], separate: false });
    res.json({ ...linkQueue.snapshot(), separate: true });
  });
  router.delete('/queue/links/:id', guard, (req, res) => {
    const job = linkQueue?.describe?.(req.params.id) ?? null;
    const ok = linkQueue?.cancel(req.params.id) ?? false;
    if (ok) audit(req, `cancelled link request "${job?.label ?? req.params.id}"`, describeJob(job), res);
    res.status(ok ? 200 : 404).json({ ok });
  });

  /* ------- numbers: several accounts, each with its own session -------- */

  router.get('/wa/accounts', guard, (req, res) => {
    res.json({
      accounts: listAccounts(configStore.get(), bot.dataDir),
      connected: bot.isConnected(),
      state: bot.status().state,
      // Background links of spare numbers, per account id. Also pushed over
      // /events as 'spares' whenever one changes.
      linking: spareLinker?.snapshot() ?? {},
    });
  });

  /**
   * Link (or re-link) a spare number in the background, without switching the
   * bot off the number it is running on. The operator asked for exactly this:
   * linking a failover number used to mean switching the live bot onto it.
   * The QR or pairing code arrives over /events as 'spares'.
   */
  router.post('/wa/accounts/:id/link', guard, async (req, res) => {
    if (!spareLinker) return res.status(501).json({ ok: false, error: 'background linking is not available' });
    if (switchInFlight || failover?.switching) {
      return res.status(409).json({ ok: false, error: 'a number switch is in progress — try again once it has finished' });
    }
    const method = req.body?.method === 'pairing' ? 'pairing' : req.body?.method === 'qr' ? 'qr' : undefined;
    const r = await spareLinker.start(req.params.id, { method });
    if (!r.ok) return res.status(r.busy ? 409 : 400).json(r);
    const acc = listAccounts(configStore.get(), bot.dataDir).find((a) => a.id === req.params.id);
    audit(req, `${acc?.linked ? 're-linking' : 'linking'} WhatsApp number "${acc?.label ?? req.params.id}" in the background`,
      method ?? null, res);
    res.json({ ok: true, linking: spareLinker.snapshot() });
  });

  router.delete('/wa/accounts/:id/link', guard, async (req, res) => {
    const stopped = await (spareLinker?.cancel(req.params.id, 'cancelled by an operator') ?? false);
    if (stopped) audit(req, `cancelled linking WhatsApp number "${req.params.id}"`, null, res);
    res.json({ ok: true, stopped, linking: spareLinker?.snapshot() ?? {} });
  });

  router.post('/wa/accounts', guard, (req, res) => {
    try {
      const { id, patch } = addAccount(configStore.get(), {
        label: req.body?.label, phoneNumber: req.body?.phoneNumber,
      });
      configStore.update(patch);
      audit(req, `added WhatsApp number "${req.body?.label ?? id}"`, null, res);
      res.json({ ok: true, id, accounts: listAccounts(configStore.get(), bot.dataDir) });
    } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
  });

  /** Rename a number or correct its digits. Never touches the saved session. */
  router.put('/wa/accounts/:id', guard, (req, res) => {
    try {
      const { target, patch } = updateAccount(configStore.get(), req.params.id, {
        label: req.body?.label,
        phoneNumber: req.body?.phoneNumber,
      });
      configStore.update(patch);
      audit(req, `edited WhatsApp number "${target.label}"`,
        target.phoneNumber ? `+${target.phoneNumber}` : 'no number', res);
      res.json({ ok: true, accounts: listAccounts(configStore.get(), bot.dataDir) });
    } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
  });

  router.delete('/wa/accounts/:id', guard, async (req, res) => {
    try {
      const { patch } = removeAccount(configStore.get(), req.params.id);
      // A number being removed must not go on showing a code for itself.
      await spareLinker?.cancel(req.params.id, 'the number was removed');
      configStore.update(patch);
      audit(req, `removed WhatsApp number "${req.params.id}"`, null, res);
      // The saved session is deliberately left on disk: removing an account
      // from the list should not destroy credentials that still work.
      res.json({ ok: true, accounts: listAccounts(configStore.get(), bot.dataDir) });
    } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
  });

  /** What failover thinks of each number, and why. */
  router.get('/wa/failover', guard, (req, res) => {
    if (!failover) return res.json({ enabled: false, available: false });
    res.json({ available: true, ...failover.status() });
  });

  /**
   * Change the preference order and timings. Kept separate from PUT /config so
   * reordering numbers is one small, auditable action rather than a whole
   * settings save.
   */
  router.put('/wa/failover', guard, async (req, res) => {
    try {
      const b = req.body ?? {};
      const patch = { whatsapp: { failover: {} } };
      const f = patch.whatsapp.failover;

      if (typeof b.enabled === 'boolean') f.enabled = b.enabled;
      if (Array.isArray(b.order)) {
        // Only ids that actually exist, deduplicated, so a stale page cannot
        // write an order referring to a number that has since been removed.
        const known = new Set(listAccounts(configStore.get(), bot.dataDir).map((a) => a.id));
        f.order = [...new Set(b.order.filter((id) => known.has(id)))];
      }
      for (const k of ['failAfterAttempts', 'holdDownMs', 'cooldownMs', 'probeTimeoutMs']) {
        if (b[k] !== undefined && Number.isFinite(Number(b[k]))) f[k] = Math.max(0, Number(b[k]));
      }
      // Only TURNING it on is checked. It is on by default (2026-10-12), and
      // on with one number it stands aside (failover.js, _hasSpare), so a
      // Save that only keeps it on - new timings, say - is not refused.
      if (f.enabled === true && configStore.get().whatsapp?.failover?.enabled !== true) {
        // Turning it on with nothing to fail over TO is a false sense of safety.
        // "Not the one in use" is listAccounts()' own active flag. Comparing
        // against `activeAccount ?? 'default'` let a new install (activeAccount
        // '', not missing) count the number in use as its own spare, so failover
        // could be switched on with nowhere to go.
        const spares = listAccounts(configStore.get(), bot.dataDir)
          .filter((a) => !a.active && a.linked);
        if (!spares.length) {
          return res.status(400).json({
            ok: false,
            error: 'No linked spare to fail over to. Link at least one other number first — failover would have nowhere to go.',
          });
        }
      }
      configStore.update(patch);
      const now = configStore.get().whatsapp.failover;
      audit(req, b.order ? 'changed the failover order' : 'changed failover settings',
        `${now.enabled ? 'on' : 'off'} — ${(now.order ?? []).join(' > ') || 'config order'}`, res);
      res.json({ ok: true, ...(failover ? failover.status() : { enabled: now.enabled }) });
    } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
  });

  /** Switch which number the bot runs as. Disconnects, then reconnects on it. */
  // A second admin pressing Switch while the first one's switch is still in
  // flight - or while an automatic failover is running - would interleave two
  // stop/start cycles and leave the config naming one number while the socket
  // connects as another. One lock covers manual and automatic switching alike.
  let switchInFlight = false;

  router.post('/wa/accounts/:id/activate', guard, async (req, res) => {
    if (switchInFlight || failover?.switching) {
      return res.status(409).json({ ok: false, error: 'a number switch is already in progress — wait for it to finish' });
    }
    // The bot would connect on a session the background linker is still
    // writing. Its own start would cancel the link anyway; refusing here says
    // why instead of silently throwing the operator's link away.
    if (spareLinker?.isLinking(req.params.id)) {
      return res.status(409).json({ ok: false, error: 'that number is being linked — finish or cancel the link first' });
    }
    switchInFlight = true;
    try {
      const { target, patch } = switchAccount(configStore.get(), req.params.id);
      try { await bot.stop(); } catch { /* already down */ }
      configStore.update(patch);
      audit(req, `switched WhatsApp to "${target.label}"`, null, res);
      failover?.noteManualSwitch(req.params.id);
      // Only auto-connect when that number has been linked before; otherwise
      // leave it stopped so the operator can link it deliberately.
      const accounts = listAccounts(configStore.get(), bot.dataDir);
      const now = accounts.find((a) => a.id === req.params.id);
      if (now?.linked) {
        bot.start().catch((err) => logger.error(`switch: could not connect: ${err.message}`));
      }
      res.json({ ok: true, accounts, linked: !!now?.linked });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    } finally { switchInFlight = false; }
  });

  router.get('/wa/status', guard, (req, res) => {
    res.json(bot.status());
  });

  router.post('/wa/start', guard, async (req, res) => {
    try {
      // Pressing Connect is a deliberate act, not the next tick of an outage.
      // The counter is otherwise only cleared by a SUCCESSFUL connection, so a
      // bot that had been failing for a while met the operator's button
      // already deep in the backoff - and the first close after that put the
      // next attempt, and any QR with it, up to fifteen minutes away.
      bot.reconnectAttempts = 0;
      bot.nextReconnectAt = null;
      // Somebody has come back with the phone, so start counting codes again
      // from zero rather than inheriting an abandoned attempt's tally.
      bot._linkAttempts = 0;
      bot.start().catch((err) => logger.error(`start failed: ${err.message}`));
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/wa/stop', guard, async (req, res) => {
    await bot.stop();
    res.json({ ok: true });
  });

  router.post('/wa/logout', guard, async (req, res) => {
    await bot.logout({ wipe: true });
    res.json({ ok: true });
  });

  // WhatsApp throttles groupFetchAllParticipating() aggressively, so a forced
  // fetch soon after a successful one is guaranteed to be rejected. Below this
  // age, Refresh simply reports the cached list instead of making a call that
  // can only fail.
  const GROUP_REFRESH_COOLDOWN_MS = 120_000;

  router.get('/wa/groups', guard, async (req, res) => {
    const age = bot.groupCacheAge();
    const wantRefresh = req.query.refresh === '1' && bot.isConnected();

    try {
      if (wantRefresh && age >= GROUP_REFRESH_COOLDOWN_MS) {
        await bot.refreshGroups({ force: true });
        return res.json({ groups: bot.groups(), refreshed: true, ageMs: 0 });
      }
      // Either no refresh was asked for, or the list is too fresh to be
      // worth re-fetching. Both are successes, not errors.
      res.json({
        groups: bot.groups(),
        refreshed: false,
        ageMs: bot.groupCacheAge(),
        note: wantRefresh ? 'already up to date' : undefined,
      });
    } catch (err) {
      const rateLimited = /rate.?overlimit|429|too many/i.test(err.message ?? '');
      const cached = bot.groups();

      if (rateLimited) {
        logger.info(`group refresh rate-limited by WhatsApp; serving ${cached.length} cached group(s)`);
      } else {
        logger.warn(`group refresh failed: ${err.message}`);
      }

      // Having a cached list means nothing is actually broken - say so
      // rather than raising an alarm the operator cannot act on.
      if (cached.length) {
        return res.json({
          groups: cached,
          refreshed: false,
          ageMs: bot.groupCacheAge(),
          note: rateLimited
            ? 'WhatsApp declined another lookup just now — showing the list from a moment ago'
            : `could not refresh (${err.message}) — showing the last known list`,
        });
      }

      res.status(rateLimited ? 429 : 500).json({
        error: rateLimited
          ? 'WhatsApp is rate-limiting the group list. The bot keeps retrying in the background — try again shortly.'
          : err.message,
        groups: [],
      });
    }
  });

  /* -------------------------- lockdown ---------------------------- */

  router.get('/lockdown/status', guard, (req, res) => {
    res.json(lockScheduler ? lockScheduler.status() : { enabled: false });
  });
  /**
   * The next window for the lockdown settings on screen, before they are
   * saved. Choosing the cities is choosing when the groups reopen - with
   * Jerusalem havdalah that is late Saturday morning in New York - so the
   * card shows the real times for a choice before it takes effect, not after.
   * Computes only; nothing is stored or changed.
   */
  router.get('/lockdown/preview', guard, (req, res) => {
    const q = req.query ?? {};
    const patch = {};
    for (const k of ['candleCity', 'havdalahCity']) if (q[k] !== undefined) patch[k] = q[k];
    // The minutes go through the same check as a save, and are refused rather
    // than skipped: this route used to ignore an empty or negative box and
    // preview the SAVED minutes, so "If saved: 18:30" sat over a Save that
    // would have stored 0. What the preview shows is now what Save would do,
    // including refusing it.
    for (const k of ['candleMinutes', 'havdalahMinutes']) {
      if (q[k] === undefined) continue;
      const raw = String(q[k]).trim();
      const n = Number(raw);
      patch[k] = raw === '' ? null : Number.isFinite(n) ? n : raw;
    }
    const problem = lockdownSettingsProblem(patch);
    if (problem) return res.status(400).json({ error: `${problem}.` });
    if (q.yomTov !== undefined) patch.yomTov = !['false', '0', ''].includes(String(q.yomTov));
    res.json(windowSummary(new Date(), { ...(configStore.get().lockdown ?? {}), ...patch }));
  });
  /**
   * A pass takes ~1.2s per group, so the portal must not let a second click
   * start a competing run - that is how six overlapping passes once reported
   * six different counts.
   */
  const lockdownRoute = (locked) => async (req, res) => {
    if (bot.lockdownBusy) {
      return res.status(409).json({ ok: false, busy: true, error: 'a lock/unlock pass is already running — give it a moment' });
    }
    try {
      const results = locked ? await lockScheduler.manualLock() : await lockScheduler.manualUnlock();
      const summary = results?.summary ?? null;
      audit(req, `${locked ? 'locked' : 'unlocked'} all groups (manual)` +
        (summary ? ` — ${summary.changed} changed, ${summary.skipped} skipped, ${summary.failed} failed` : ''),
        null, res);
      res.json({
        ok: true,
        summary,
        failures: (results ?? []).filter((r) => r.error).map((r) => ({ subject: r.subject, error: r.error })),
        skipped: (results ?? []).filter((r) => r.skipped).map((r) => r.subject),
        ...lockScheduler.status(),
      });
    } catch (err) { res.status(400).json({ ok: false, error: friendlyGroupError(err) }); }
  };
  router.post('/lockdown/lock', guard, lockdownRoute(true));
  router.post('/lockdown/unlock', guard, lockdownRoute(false));

  /**
   * Read every group's real admins-only setting and diff it against the
   * always-locked list.
   *
   * Deliberately does NOT write anything. The list decides which groups the
   * schedule refuses to open at havdalah, so getting it wrong in either
   * direction is expensive - a group wrongly added stays shut for good, one
   * wrongly removed gets opened on Shabbos. The admin sees the diff and
   * applies it with the normal Save.
   */
  router.post('/lockdown/sync-always', guard, async (req, res) => {
    if (bot.lockdownBusy) {
      return res.status(409).json({ ok: false, busy: true, error: 'a lock/unlock pass is already running — give it a moment' });
    }
    if (!bot.isConnected()) {
      return res.status(400).json({ ok: false, error: 'WhatsApp is not connected' });
    }
    try {
      const scanned = await bot.syncAlwaysLocked();
      const current = new Set(configStore.get().lockdown?.alwaysLocked ?? []);
      const readable = scanned.filter((g) => !g.error);

      const add = readable.filter((g) => g.locked && !current.has(g.jid));
      const remove = readable.filter((g) => !g.locked && current.has(g.jid));
      // A group that could not be read is reported rather than silently
      // treated as unlocked, which would propose removing it.
      const unreadable = scanned.filter((g) => g.error);

      audit(req, `synced the always-locked list from WhatsApp`,
        `${readable.length} group(s) read, ${add.length} to add, ${remove.length} to remove`, res);

      res.json({
        ok: true,
        scanned: scanned.length,
        read: readable.length,
        lockedNow: readable.filter((g) => g.locked).length,
        add: add.map((g) => ({ jid: g.jid, subject: g.subject })),
        remove: remove.map((g) => ({ jid: g.jid, subject: g.subject })),
        // The jid, not just the name: the portal has to leave these boxes
        // exactly as they are, and matching them up by label text breaks on
        // the first group whose name is a prefix of another's.
        unreadable: unreadable.map((g) => ({ jid: g.jid, subject: g.subject, error: g.error })),
        // The list as it WOULD be, ready to save.
        proposed: readable.filter((g) => g.locked).map((g) => g.jid),
      });
    } catch (err) { res.status(400).json({ ok: false, error: friendlyGroupError(err) }); }
  });

  /* ------------------------ cross-group members ------------------- */

  /** The combined roster: every member of every group, deduplicated. */
  router.get('/members', guard, (req, res) => {
    try {
      const activity = bot.memberActivity?.all() ?? {};
      const list = aggregateMembers(bot.groupsWithMembers(), activity);
      res.json({
        members: list,
        groupCount: bot.groups().length,
        trackingSince: Object.values(activity).reduce(
          (min, e) => (e.firstSeen && (!min || e.firstSeen < min) ? e.firstSeen : min), null),
      });
    } catch (err) {
      res.status(bot.isConnected() ? 400 : 503).json({ error: err.message });
    }
  });

  /** One member: their groups, where they're admin, activity and join history. */
  router.get('/members/:key/detail', guard, (req, res) => {
    try {
      const activity = bot.memberActivity?.all() ?? {};
      const list = aggregateMembers(bot.groupsWithMembers(), activity);
      const member = list.find((m) => m.key === req.params.key);
      if (!member) return res.status(404).json({ error: 'member not found' });
      const events = stateStore.namespace('group-activity').get('events', []) ?? [];
      const detail = memberDetail({ member, events, activity });
      // Decorate per-group activity with the group's name for display.
      const names = Object.fromEntries(bot.groups().map((g) => [g.jid, g.subject]));
      detail.perGroup = Object.fromEntries(Object.entries(detail.perGroup)
        .map(([jid, v]) => [jid, { ...v, subject: names[jid] ?? jid }]));
      detail.banned = (configStore.get().bannedNumbers ?? [])
        .some((n) => String(n).replace(/[^0-9]/g, '') === member.number);
      detail.noTag = (configStore.get().movieRequests?.notify?.noTag ?? [])
        .some((n) => String(n).replace(/[^0-9]/g, '') === member.number);
      res.json(detail);
    } catch (err) {
      res.status(bot.isConnected() ? 400 : 503).json({ error: err.message });
    }
  });

  router.post('/members/ban-all', guard, async (req, res) => {
    const num = String(req.body?.number ?? '').replace(/[^0-9]/g, '');
    if (!num) return res.status(400).json({ error: 'no number' });
    try {
      const results = await bot.banFromAllGroups(num);
      const wiped = results.wiped ?? { deleted: 0, failed: 0 };
      // add to the local banned list
      const banned = new Set((configStore.get().bannedNumbers ?? []).map((x) => String(x).replace(/[^0-9]/g, '')));
      banned.add(num);
      configStore.update({ bannedNumbers: [...banned] });
      audit(req, `banned +${num} from all groups (${results.length} affected` +
        `${wiped.deleted ? `, ${wiped.deleted} message(s) deleted` : ''})`, null, res);
      res.json({ ok: true, results, wiped });
    } catch (err) { res.status(400).json({ ok: false, error: friendlyGroupError(err) }); }
  });

  /** action: add | promote | demote across selected groups */
  router.post('/members/across', guard, async (req, res) => {
    const num = String(req.body?.number ?? '').replace(/[^0-9]/g, '');
    const jids = Array.isArray(req.body?.groupJids) ? req.body.groupJids : [];
    const action = req.body?.action;
    if (!num || !jids.length) return res.status(400).json({ error: 'number and groupJids required' });
    if (!['add', 'promote', 'demote'].includes(action)) return res.status(400).json({ error: 'bad action' });
    try {
      const results = await bot.participantAcrossGroups(num, jids, action);
      audit(req, `${action} +${num} across ${jids.length} group(s)`, null, res);
      res.json({ ok: true, results });
    } catch (err) { res.status(400).json({ ok: false, error: friendlyGroupError(err) }); }
  });

  router.get('/banned', guard, (req, res) => {
    res.json(configStore.get().bannedNumbers ?? []);
  });
  router.delete('/banned/:number', guard, (req, res) => {
    const num = String(req.params.number).replace(/[^0-9]/g, '');
    configStore.update({ bannedNumbers: (configStore.get().bannedNumbers ?? []).filter((x) => String(x).replace(/[^0-9]/g, '') !== num) });
    audit(req, `removed +${num} from the banned list`, null, res);
    res.json({ ok: true });
  });

  /* ------------------------- group admin -------------------------- */

  /** The Tickets tab: every ticket opened, member #issues and the agent's (src/core/tickets.js). */
  router.get('/tickets', guard, (req, res) => {
    const list = listTickets({ dataDir: bot.dataDir, stateStore });
    res.json({ tickets: list, open: list.filter((t) => t.status === 'open').length });
  });

  /** Resolve or reopen a ticket, with a note. */
  router.post('/tickets/:n/status', guard, (req, res) => {
    const status = req.body?.status === 'open' ? 'open' : 'resolved';
    const by = req.session?.user?.username ?? null;
    const done = setTicketStatus({ dataDir: bot.dataDir, stateStore }, req.params.n, { status, by, note: req.body?.note ?? null });
    if (!done) return res.status(404).json({ ok: false, error: 'no ticket has that number' });
    audit(req, `${status === 'resolved' ? 'resolved' : 'reopened'} ticket #${ticketLabel(req.params.n)}`, req.body?.note ? String(req.body.note).slice(0, 200) : null, res);
    res.json({ ok: true, ...done });
  });

  /**
   * The dashboard's Ollama card: whether the discussions group's agent is
   * working, and what it has done in the last day (src/core/discussion-answers.js).
   * The key itself is never sent, only whether one is saved.
   */
  router.get('/discussion-answers/status', guard, (req, res) => {
    const c = configStore.get();
    const da = c.discussionAnswers ?? {};
    const ollama = c.ai?.ollama ?? {};
    const keySaved = !!ollama.apiKey;
    const snap = bot.discussionAnswers?.snapshot({ enabled: da.enabled === true, keySaved }) ?? { state: 'off', recent: [] };
    res.json({
      ...snap,
      enabled: da.enabled === true,
      keySaved,
      model: ollama.model || MODEL_PREFERENCES.ollama[0] || '',
      modelIsAutomatic: !ollama.model,
      maxPerHour: da.maxPerHour ?? 20,
      groups: (c.libraryNews?.groups ?? []).map((jid) => ({ jid, name: bot.groupCache?.get(jid)?.subject ?? jid })),
      recent: snap.recent.map((e) => ({ ...e, question: e.question ?? '', answer: e.answer ?? null })),
    });
  });

  router.get('/groups/:jid/details', guard, async (req, res) => {
    try {
      res.json(await bot.groupDetails(req.params.jid));
    } catch (err) {
      res.status(bot.isConnected() ? 400 : 503).json({ error: err.message });
    }
  });

  /** Lock/unlock one group (admins-only posting). */
  router.post('/groups/:jid/lock', guard, async (req, res) => {
    const locked = !!req.body?.locked;
    try {
      await bot.setGroupLocked(req.params.jid, locked);
      // Opened by an admin from the panel: a spam lock on it is lifted.
      if (!locked) bot.spamGuard?.release(req.params.jid, `${req.session?.user?.username ?? "an admin"} (panel)`);
      const subject = bot.groupCache.get(req.params.jid)?.subject ?? req.params.jid;
      audit(req, `${locked ? 'locked' : 'unlocked'} "${subject}"`, null, res);
      res.json({ ok: true, locked });
    } catch (err) {
      res.status(400).json({ ok: false, error: friendlyGroupError(err) });
    }
  });

  router.put('/groups/:jid/description', guard, async (req, res) => {
    try {
      await bot.setGroupDescription(req.params.jid, String(req.body?.description ?? ''));
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ ok: false, error: friendlyGroupError(err) });
    }
  });

  router.put('/groups/:jid/subject', guard, async (req, res) => {
    try {
      await bot.setGroupSubject(req.params.jid, String(req.body?.subject ?? ''));
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ ok: false, error: friendlyGroupError(err) });
    }
  });

  /** action: add | remove | promote | demote ; numbers: [] */
  router.post('/groups/:jid/participants', guard, async (req, res) => {
    const { action, numbers } = req.body ?? {};
    if (!Array.isArray(numbers) || !numbers.length) {
      return res.status(400).json({ error: 'no numbers given' });
    }
    try {
      const results = await bot.modifyParticipants(req.params.jid, numbers, action);
      res.json({ ok: true, results });
    } catch (err) {
      res.status(400).json({ ok: false, error: friendlyGroupError(err) });
    }
  });

  router.get('/group-activity', guard, (req, res) => {
    res.json(stateStore.namespace('group-activity').get('events', []));
  });

  router.delete('/group-activity', guard, (req, res) => {
    stateStore.namespace('group-activity').set('events', []);
    res.json({ ok: true });
  });

  function friendlyGroupError(err) {
    const m = err.message ?? String(err);
    if (/not-authorized|forbidden|403/i.test(m)) {
      return 'The bot must be an admin of that group to do this.';
    }
    if (/not connected/i.test(m)) return 'WhatsApp is not connected.';
    return m;
  }

  /* ----------------------------- queue ---------------------------- */

  router.get('/queue', guard, (req, res) => res.json(queue.snapshot()));

  // Every queue mutation is named in the audit log. The title has to be read
  // BEFORE the mutation - a cancel removes the entry, and all that survives is
  // an opaque id, which is what made the old "DELETE /queue/478b53eb4285" rows
  // impossible to interpret after the fact.
  // Kept across a restart now (request-pause.js pauseQueue): it lived in
  // memory only, and a restart quietly undid it.
  router.post('/queue/pause', guard, (req, res) => {
    if (requestPause) requestPause.pauseQueue(req.session?.user?.username ?? null);
    else queue.pause();
    audit(req, `paused the queue (${queue.pendingLabels().length} waiting)`, null, res);
    res.json({ ok: true });
  });
  router.post('/queue/resume', guard, (req, res) => {
    if (requestPause) requestPause.resumeQueue(req.session?.user?.username ?? null);
    else queue.resume();
    audit(req, `resumed the queue (${queue.pendingLabels().length} waiting)`, null, res);
    res.json({ ok: true });
  });

  // Requests paused (src/core/request-pause.js), the operator's request of
  // 2026-10-01: every request from a request group gets ⏸️ and waits, the
  // queue stops starting new jobs, and on resume the held requests run, in
  // the order they came. Beta tests, direct links and this panel go on.
  router.get('/requests/pause', guard, (req, res) => {
    if (!requestPause) return res.status(503).json({ error: 'Pausing requests is not available here.' });
    res.json(requestPause.snapshot());
  });
  router.post('/requests/pause', guard, (req, res) => {
    if (!requestPause) return res.status(503).json({ error: 'Pausing requests is not available here.' });
    const r = requestPause.pause(req.session?.user?.username ?? null);
    audit(req, r.already ? 'paused requests (they already were)'
      : `paused requests${r.pausedQueue ? ' and the queue' : ' (the queue was already paused)'}`,
    `${queue.pendingLabels().length} waiting in the queue, ${queue.active?.size ?? 0} running (they finish)`, res);
    res.json({ ok: true, already: !!r.already, ...requestPause.snapshot() });
  });
  router.post('/requests/resume', guard, (req, res) => {
    if (!requestPause) return res.status(503).json({ error: 'Pausing requests is not available here.' });
    const held = requestPause.heldCount();
    const r = requestPause.resume(req.session?.user?.username ?? null);
    r.replay?.catch?.((err) => logger.error(`held requests: ${err.message}`));
    audit(req, r.already ? 'resumed requests (they were not paused)'
      : `resumed requests${r.resumedQueue ? ' and the queue' : ''}`,
    held ? `running the ${held} held request(s), in the order they came` : 'none were held', res);
    res.json({ ok: true, already: !!r.already, ran: held, ...requestPause.snapshot() });
  });
  router.post('/queue/clear', guard, (req, res) => {
    const labels = queue.pendingLabels();
    const n = queue.clearPending();
    audit(req, `cleared ${n} waiting job(s)`, nameList(labels) ?? 'the queue was already empty', res);
    res.json({ ok: true, cleared: n });
  });
  router.delete('/queue/:id', guard, (req, res) => {
    const job = queue.describe(req.params.id);
    const ok = queue.cancel(req.params.id);
    if (ok) audit(req, `cancelled "${job?.label ?? req.params.id}"`, describeJob(job), res);
    res.status(ok ? 200 : 404).json({ ok });
  });

  // Skip = abandon the current job so the queue advances. Distinct from
  // cancel so the requester is told it was skipped, not silently dropped.
  // The panel names the job in hand - a film, or one episode of a season -
  // so the audit row names that episode, not the whole season.
  router.post('/queue/:id/skip', guard, (req, res) => {
    const job = queue.describe(req.params.id);
    const ok = queue.skip(req.params.id);
    if (ok) audit(req, `skipped "${job?.label ?? req.params.id}"`, describeJob(job), res);
    res.status(ok ? 200 : 404).json({ ok });
  });

  router.post('/queue/:id/move', guard, (req, res) => {
    const dir = req.body?.dir;
    const job = queue.describe(req.params.id);
    // A RUNNING job can be waiting too - downloaded, and in line for the one
    // encoder - and moving it means moving it up that line. It cannot be moved
    // down: that is moving the one behind it up.
    if (queue.isRunning(req.params.id)) {
      const before = queue.stageLine(req.params.id);
      const ok = dir !== 'down' && queue.moveRunning(req.params.id, dir === 'top' ? 'top' : 'up');
      if (ok) {
        const slot = { download: 'download', convert: 'convert', upload: 'send' }[before?.stage] ?? before?.stage;
        audit(req, `moved "${job?.label ?? req.params.id}" ${dir === 'top' ? 'to next' : 'up'} in line to ${slot}`,
          describeJob(job), res);
      }
      return res.status(ok ? 200 : 409).json(ok ? { ok }
        : { ok, error: before ? 'It is already next in line' : 'It is not waiting for a slot - it is already running' });
    }
    const ok = dir === 'top' ? queue.moveTop(req.params.id)
             : queue.move(req.params.id, dir === 'down' ? 'down' : 'up');
    if (ok) {
      const where = dir === 'top' ? 'to the front' : dir === 'down' ? 'later' : 'sooner';
      audit(req, `moved "${job?.label ?? req.params.id}" ${where}`, describeJob(job), res);
    }
    res.status(ok ? 200 : 404).json({ ok });
  });

  /* ----------------------------- wanted --------------------------- */

  const wantedStore = () => stateStore.namespace('movie-requests');
  // A requester with no WhatsApp name is listed by their jid; shown as +digits.
  const shownWanted = (w) => (Array.isArray(w?.requesters) ? { ...w, requesters: w.requesters.map(phoneOut) } : w);

  /**
   * Films people asked for that the server does not have (`wanted`), and the
   * ones marked resolved in the last 30 days, the newest first (`resolved`),
   * which the card shows apart, under the open list.
   */
  router.get('/wanted', guard, (req, res) => {
    res.json({
      wanted: listWanted(wantedStore()).map(shownWanted),
      resolved: listResolvedWanted(wantedStore()).map(shownWanted),
      settings: wantedSettings(),
    });
  });

  /** What the Wanted card shows of `wanted` in the settings (schema.js). */
  const wantedSettings = () => {
    const w = configStore.get()?.wanted ?? {};
    return { rerunOnArrival: w.rerunOnArrival !== false };
  };

  /**
   * The card's switch: re-run the requests for a film once it arrives
   * (wanted.rerunOnArrival, src/core/wanted-arrival.js), or only mark it
   * resolved. Audited under the admin's name, as every switch is.
   */
  router.post('/wanted/settings', guard, (req, res) => {
    const on = req.body?.rerunOnArrival;
    if (typeof on !== 'boolean') return res.status(400).json({ ok: false, error: 'rerunOnArrival must be true or false' });
    configStore.update({ wanted: { rerunOnArrival: on } });
    audit(req, on ? 'switched on re-running requests when a wanted film arrives'
      : 'switched off re-running requests when a wanted film arrives (it is only marked resolved)', null, res);
    res.json({ ok: true, settings: wantedSettings() });
  });

  // Resolved entries and notes go with the rest: "Clear the list" is a fresh start.
  router.delete('/wanted', guard, (req, res) => {
    resetWanted(stateStore.namespace('movie-requests'));
    audit(req, 'cleared the wanted list', null, res);
    res.json({ ok: true });
  });

  /**
   * Look every open film on the wanted list up in the library now, and mark
   * the ones it has resolved by the bot (src/core/wanted-recheck.js) - what
   * the bot does by itself every 30 minutes, and what the card's Refresh asks
   * for first. The bot's own instance, so a click during a timed run waits
   * for that run rather than starting a second; one made here (a router
   * without one, as in tests) is never started.
   */
  const recheck = wantedRecheck ?? new WantedRecheck({ configStore, stateStore });
  router.post('/wanted/recheck', guard, async (req, res) => {
    const r = await recheck.run('on demand');
    if (r.error || r.skipped) {
      audit(req, 'rechecked the wanted list - it could not run', r.error ?? r.skipped, res);
      return res.status(r.skipped ? 409 : 500).json({ ok: false, error: r.error ?? r.skipped });
    }
    audit(req, `rechecked the wanted list: ${r.found.length} of ${r.checked} on the server now`
      + `${r.notFilms.length ? `, ${r.notFilms.length} asked for a show` : ''}`,
    nameList([...r.found.map(describeFound), ...r.notFilms.map(describeNotFilm)], 20)
      ?? (r.errors.length ? `${r.errors.length} lookup(s) failed` : 'nothing had arrived'), res);
    // Requesters shown as GET /wanted shows them: a jid as +digits.
    const shown = (list) => list.map((f) => ({ ...f, requesters: (f.requesters ?? []).map(phoneOut) }));
    res.json({
      ok: true, checked: r.checked, found: shown(r.found), notFilms: shown(r.notFilms), errors: r.errors,
      wanted: listWanted(wantedStore()).length,
    });
  });

  /*
   * Mark resolved, reopen, and notes, on one entry. The operator, 2026-10-11,
   * at the Wanted card: "give me a mark as resolved so other admins and you
   * know as well as a box to add notes for you to review on the hour". Each
   * is audited under the admin's name. Other admins' open panels hear of it
   * through wantedEvents, which server.js pushes as the 'wanted' event (the
   * panel is push-only). The hourly check reads every new note, and every
   * entry an admin resolved, from state.json (incident-scan.js,
   * wantedFindings). `:key` is the entry's key, URL-encoded: an IMDb id, or
   * "title|year" for a film OMDb gave none.
   */
  const wantedLabel = (w) => `"${w.title}${w.year ? ` (${w.year})` : ''}"`;
  const wantedDetail = (w) => [
    w.imdbId,
    `asked for ${w.count ?? 1} time${(w.count ?? 1) === 1 ? '' : 's'}`,
    (w.requesters ?? []).length ? `by ${w.requesters.slice(0, 5).map(phoneOut).join(', ')}` : null,
  ].filter(Boolean).join(' · ');
  /** The entry `:key` names, or a 404 said and null. */
  const wantedEntry = (req, res) => {
    const w = findWanted(wantedStore(), req.params.key);
    if (!w) res.status(404).json({ ok: false, error: 'That film is not on the wanted list any more - it may have been cleared' });
    return w;
  };

  router.post('/wanted/:key/resolve', guard, (req, res) => {
    const w = wantedEntry(req, res);
    if (!w) return;
    if (w.resolved) return res.status(409).json({ ok: false, error: `It was resolved already, by ${w.resolved.by}` });
    const done = resolveWanted(wantedStore(), w.key, { by: req.session.user.username });
    if (!done) return res.status(500).json({ ok: false, error: 'It could not be marked resolved' });
    audit(req, `marked ${wantedLabel(done)} resolved on the wanted list`, wantedDetail(done), res);
    res.json({ ok: true, entry: shownWanted(done) });
  });

  router.post('/wanted/:key/reopen', guard, (req, res) => {
    const w = wantedEntry(req, res);
    if (!w) return;
    if (!w.resolved) return res.status(409).json({ ok: false, error: 'It is not resolved - it is on the open list' });
    const was = w.resolved;
    // An admin's Reopen of what the bot resolved rules out the copy it found,
    // or the next recheck - the card's own Refresh among them - resolves it
    // again with that copy (wanted.js, reopenWanted).
    const done = reopenWanted(wantedStore(), w.key, { by: req.session.user.username });
    audit(req, `reopened ${wantedLabel(done)} on the wanted list`, `it had been resolved by ${was.by}`
      + `${was.auto && was.as?.title ? `; the bot will not resolve it with the library's "${was.as.title}" again` : ''}`, res);
    res.json({ ok: true, entry: shownWanted(done) });
  });

  /*
   * "Re-run requests" on a resolved film: every request answered "not in
   * the library" for it is run again as that request, on the member's own
   * message, by the rules an arrival is re-run by (src/core/wanted-arrival.js)
   * - 60 days, once per member, never twice, paced. For a film resolved
   * before arrivals were re-run by themselves (eight on the morning of
   * 2026-10-11, My Suicide and Guardians of the Galaxy Vol. 2 among them):
   * the operator chooses which, so nothing re-runs them on deploy; and for
   * one a member's request or an admin resolved, which only the wanted
   * recheck's find re-runs by itself. Answers
   * with what will be re-run and what will not, and why; the re-runs go on
   * after the answer, one paced message at a time, each with an audit row,
   * and the card hears of each through the 'wanted' push.
   */
  const arrivalRuns = arrivals ?? new ArrivalReruns({ configStore, stateStore, bot, pluginManager, requestPause });
  router.post('/wanted/:key/rerun', guard, async (req, res) => {
    const w = wantedEntry(req, res);
    if (!w) return;
    if (!w.resolved) {
      return res.status(409).json({ ok: false, error: 'It is not resolved: as far as the bot knows it is not on the server yet, '
        + 'and a re-run would only answer "not in the library" again' });
    }
    const busy = arrivalRuns.cannotRunNow();
    if (busy) return res.status(409).json({ ok: false, error: `Not now: ${busy}` });
    // An admin's resolution says nothing about the server, so the bot looks
    // first; one the bot resolved carries the copy it found.
    if (!(w.resolved.auto && w.resolved.as)) {
      let seen = {};
      try {
        seen = await lookUpWanted(wantedStore(), w, { libraryCfg: configStore.get().library });
      } catch (err) {
        return res.status(502).json({ ok: false, error: `The library lookup failed: ${err.message}` });
      }
      if (!seen.hit) {
        return res.status(409).json({ ok: false, error: `The bot does not find ${wantedLabel(w)} on the server`
          + `${seen.why ? ` (${seen.why})` : ''}, so a re-run would only answer "not in the library" again` });
      }
    }
    const plan = arrivalRuns.plan(w.key);
    const shown = (r) => phoneOut(r.requesterNumberDisplay ?? r.requesterNumber) ?? (String(r.requester ?? '').trim() || '?');
    // A member whose film was posted since, with another request, is
    // answered with the done reaction rather than re-run (postedSince); the
    // card counts them among those it will answer.
    const run = [
      ...plan.run.map((r) => ({ requester: String(r.requester ?? '').trim() || null, number: shown(r), request: r.typed ?? r.request })),
      ...(plan.posted ?? []).map((p) => ({
        requester: String(p.row.requester ?? '').trim() || null, number: shown(p.row), request: p.row.typed ?? p.row.request,
        posted: true, note: `posted since, with ${String(p.sent.requester ?? '').trim() || 'another member'}'s request - marked done, not posted again`,
      })),
    ];
    const skipped = plan.skip.map((s) => ({ requester: String(s.row.requester ?? '').trim() || null, number: shown(s.row), why: s.why }));
    const skipNote = skipped.length ? `not re-run: ${skipped.map((s) => `${s.requester ?? s.number} (${s.why})`).join('; ')}` : null;
    if (!run.length) {
      audit(req, `asked to re-run the requests for ${wantedLabel(w)} - there was none to re-run`, skipNote ?? 'no request for it in History', res);
      return res.json({ ok: true, run, skipped });
    }
    arrivalRuns.rerun(w.key, { by: req.session.user.username });
    // Asked for, not done: the re-runs go on after this answer, one paced
    // message at a time, and each is audited as it runs - or, if the batch
    // stops part-way, the stop is, naming who is left for the next pass. The
    // first cut wrote "re-ran ... 2 member(s)" here before any had run, and
    // so it stood when only one did (found in review, 2026-10-11).
    audit(req, `asked to re-run the requests for ${wantedLabel(w)} by hand: ${run.length} member(s), each audited as it runs`,
      [nameList(run.map((r) => `${r.requester ?? r.number} "${r.request}"${r.posted ? ' (posted since)' : ''}`), 20), skipNote]
        .filter(Boolean).join(' · '), res);
    res.json({ ok: true, run, skipped });
  });

  router.post('/wanted/:key/notes', guard, (req, res) => {
    const w = wantedEntry(req, res);
    if (!w) return;
    const r = addWantedNote(wantedStore(), w.key, { by: req.session.user.username, text: req.body?.text });
    if (r.error) return res.status(r.status ?? 400).json({ ok: false, error: r.error });
    audit(req, `added a note to ${wantedLabel(w)} on the wanted list`, r.note.text.slice(0, 500), res);
    res.json({ ok: true, note: r.note, entry: shownWanted(r.entry) });
  });

  router.delete('/wanted/:key/notes/:noteId', guard, (req, res) => {
    const w = wantedEntry(req, res);
    if (!w) return;
    const r = deleteWantedNote(wantedStore(), w.key, req.params.noteId, {
      by: req.session.user.username, superAdmin: isSuperAdmin(configStore, req.session.user),
    });
    if (r.error) return res.status(r.status ?? 400).json({ ok: false, error: r.error });
    audit(req, `deleted ${r.note.by === req.session.user.username ? 'their' : `${r.note.by}'s`} note on ${wantedLabel(w)} `
      + 'on the wanted list', r.note.text.slice(0, 500), res);
    res.json({ ok: true, entry: shownWanted(r.entry) });
  });

  /* ------------------------- rating overrides --------------------- */

  /**
   * Titles an admin has cleared of their rating - films and TV, one list, the
   * bypass list (src/core/rating-overrides.js). Deliberately audited like a
   * moderation action rather than a settings save: an entry sends what it
   * covers with no AI check - the operator's "Send it, no AI check"
   * (2026-09-29) - and "who allowed this one" is the question that gets
   * asked afterwards.
   */
  const overrideStore = () => stateStore.namespace('movie-requests');

  /** Where Jellyfin is, and whether it holds the films as well as the shows. */
  const jellyfinWhere = () => {
    const lib = configStore.get().library ?? {};
    const jf = lib.jellyfin ?? {};
    return {
      base: String(jf.baseUrl ?? '').replace(/\/+$/, ''),
      token: jf.accessToken || jf.apiKey,
      userId: jf.userId,
      films: (lib.provider ?? 'jellyfin') === 'jellyfin',
    };
  };

  /**
   * What the entries match in the library right now, for the list - as
   * information only. Bounded, so a slow library never holds up an add: past
   * the limit the answer is "not checked", and the list says so.
   */
  const matchesFor = (entries, ms = 20_000) => Promise.race([
    libraryMatches(entries, jellyfinWhere()),
    new Promise((resolve) => { setTimeout(() => resolve({ checked: false, reason: 'the library took too long to list' }), ms).unref?.(); }),
  ]).catch((err) => ({ checked: false, reason: err.message }));

  router.get('/rating-overrides', guard, (req, res) => {
    res.json({ overrides: listOverrides(overrideStore()) });
  });

  router.get('/rating-overrides/matches', guard, async (req, res) => {
    res.json(await matchesFor(listOverrides(overrideStore())));
  });

  router.post('/rating-overrides', guard, async (req, res) => {
    try {
      const input = String(req.body?.input ?? '');
      // A title is saved as typed: it covers the film or show of exactly
      // that name, with case, spaces and punctuation ignored ("Exact title
      // only", the operator, 2026-09-29) - the owner's "full metal alchemist"
      // was refused, or saved to match nothing, by the list before spaces
      // were ignored. A link is looked up only to say what it is. What either
      // matches in the library is sent back to show, since that is what the
      // entry now sends.
      const resolved = await describeLink(input, jellyfinWhere());
      const entry = addOverride(overrideStore(), input, {
        resolved,
        // The name, not the session object: stored whole, it read "added by
        // [object Object]" in the list and the log.
        addedBy: req.session?.user?.username ?? null,
        note: String(req.body?.note ?? '').slice(0, 200),
      });
      audit(req, `rating override added: ${overrideLabel(entry)}`, entry.note || null, res);
      logger.warn(`rating override added by ${req.session?.user?.username ?? '?'}: ${describeOverride(entry)}`);
      const found = await matchesFor([entry], 10_000);
      res.json({
        ok: true, entry,
        matches: found.checked ? { films: found.films, ...(found.matches[entry.key] ?? { count: 0, items: [] }) } : null,
        ...(found.checked ? {} : { matchesUnknown: found.reason }),
      });
    } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
  });

  router.delete('/rating-overrides/:key', guard, (req, res) => {
    const key = decodeURIComponent(req.params.key);
    const entry = listOverrides(overrideStore()).find((e) => e.key === key);
    const gone = removeOverride(overrideStore(), key);
    if (gone) audit(req, `rating override removed: ${entry ? overrideLabel(entry) : key}`, null, res);
    res.status(gone ? 200 : 404).json({ ok: gone });
  });

  /* -------------------------- library misses ---------------------- */

  /**
   * Everything refused for one reason only: it was not found in the library.
   *
   * Read from BOTH plugin namespaces and merged, because the movie and TV
   * plugins keep separate stores - the same reason the History tab merges
   * them. Kept apart from the audit log proper, which is a record of what
   * ADMINS did in the portal; this is a record of what the bot got asked and
   * could not answer.
   */
  const missStores = () => [
    stateStore.namespace('movie-requests'),
    stateStore.namespace('tv-requests'),
  ];

  router.get('/library-misses', guard, (req, res) => {
    const opts = {
      kind: req.query.kind ?? null,
      reason: req.query.reason ?? null,
      q: req.query.q ?? null,
      includeResolved: req.query.resolved !== '0',
    };
    const misses = missStores()
      .flatMap((s) => listMisses(s, opts))
      .sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0))
      // A TV requester with no WhatsApp name was kept as the number in the
      // old "+1 (…)" form; shown as +digits.
      .map((m) => (Array.isArray(m?.requesters) ? { ...m, requesters: [...new Set(m.requesters.map(phoneOut))] } : m));

    // Counts are over EVERYTHING, not the filtered set, so the filter buttons
    // do not renumber themselves as you click them - the same rule the audit
    // category tabs follow.
    const counts = missStores().reduce((acc, s) => {
      const c = missCounts(s);
      for (const [k, v] of Object.entries(c)) acc[k] = (acc[k] ?? 0) + v;
      return acc;
    }, {});

    res.json({ misses, counts, reasons: MISS_REASONS });
  });

  router.delete('/library-misses', guard, (req, res) => {
    for (const s of missStores()) resetMisses(s);
    audit(req, 'cleared the not-in-library list', null, res);
    res.json({ ok: true });
  });

  /** Send the daily digest right now, without waiting for the hour. */
  router.post('/digest/send', guard, async (req, res) => {
    try {
      const movies = stateStore.namespace('movie-requests');
      const tv = stateStore.namespace('tv-requests');
      const body = buildDigest({
        // As the daily one: the open entries listed, the resolved counted
        // since the last daily summary went.
        wanted: allWanted(movies),
        lastSummaryAt: stateStore.namespace('digest').get('lastSentAt', null),
        misses: [...listMisses(movies), ...listMisses(tv)].sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0)),
        history: movies.get('history', []),
        // Requests, not jobs: a season waiting is one, as on the Queue card.
        queue: queue.requestCounts?.() ?? { active: queue.active?.size ?? 0, waiting: queue.pending?.length ?? 0 },
      });
      const r = await alerts.notify({
        kind: 'daily-digest-manual', label: 'daily summary (sent by hand)',
        note: body, throttleMinutes: 0,
      });
      if (!r?.sent) return res.status(400).json({ ok: false, error: r?.why ?? 'could not send' });
      audit(req, 'sent the daily summary by hand', null, res);
      res.json({ ok: true });
    } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
  });

  /* --------------------------- catalogue -------------------------- */

  /**
   * Everything on the server this bot is allowed to send. Refreshed by hand -
   * a full library walk is far too heavy to run on every page load, and the
   * answer only changes when the library does.
   */
  router.get('/catalogue', guard, (req, res) => {
    const st = stateStore.namespace('catalogue');
    res.json({
      at: st.get('at', null),
      clean: st.get('clean', []),
      scanned: st.get('scanned', 0),
      total: st.get('total', null),
      skipped: st.get('skipped', { blocked: 0, unrated: 0 }),
      // The last rebuild that was NOT published, and why.
      lastIncomplete: st.get('lastIncomplete', null),
      running: !!catalogueRun,
      progress: catalogueRun?.progress ?? null,
      startedAt: catalogueRun?.startedAt ?? null,
    });
  });

  let catalogueRun = null;

  /** Where the published list lives; outside data/, because it is titles only and committed. */
  const catalogueDir = () => path.join(process.cwd(), 'library');

  /** How many titles the list now being replaced carried, from the panel state or the committed file. */
  function publishedCount() {
    const inState = stateStore.namespace('catalogue').get('clean', null);
    if (Array.isArray(inState)) return inState.length;
    try {
      const file = JSON.parse(fs.readFileSync(path.join(catalogueDir(), 'clean-titles.json'), 'utf8'));
      return Number.isFinite(file.count) ? file.count : (file.titles?.length ?? 0);
    } catch { return 0; }
  }

  /**
   * Publish a finished walk, or refuse to, and record which.
   *
   * Refused: a walk that read fewer (or more) films than the server holds, one
   * whose size the server would not report, and - unless the admin confirmed -
   * one whose list is much shorter than the one it would replace. A library
   * that is briefly empty or unreachable (an unmounted drive, the bot's account
   * losing access) reads as a complete walk of nothing, and would otherwise wipe
   * the published list.
   */
  function finishCatalogue(result, { req, allowShrink, cfg }) {
    const st = stateStore.namespace('catalogue');
    const refuse = (reason, extra = {}) => {
      st.set('lastIncomplete', { at: result.at, scanned: result.scanned, total: result.total, reason, ...extra });
      logger.warn(`catalogue rebuild not published - ${reason}`);
      // After the 202: there is no response left to mark, and the start of the
      // rebuild was already audited against it, so nothing is logged twice.
      audit(req, 'catalogue rebuild NOT published', reason, null);
    };

    if (result.complete === false) {
      return refuse(`read ${result.scanned} of ${result.total ?? '?'} films (${result.stopped})`);
    }
    if (result.complete !== true) {
      return refuse(`the server did not report how many films it holds, so a short walk could not be told from a full one (${result.scanned} read)`);
    }
    const before = publishedCount();
    if (!allowShrink && before > 0 && result.clean.length < before * 0.9) {
      return refuse(`the new list has ${result.clean.length} titles, the published one ${before}`, { shrink: true, before, after: result.clean.length });
    }

    st.set('at', result.at);
    st.set('clean', result.clean);
    st.set('scanned', result.scanned);
    st.set('total', result.total);
    st.set('skipped', result.skipped);
    st.set('lastIncomplete', null);

    try {
      const dir = catalogueDir();
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'clean-titles.md'), formatCatalogue(result, {
        blocked: cfg.movieRequests?.blockedRatings ?? [],
        blockUnrated: cfg.movieRequests?.blockUnrated === true,
      }));
      // Coverage goes in the JSON too: the truncated 2026-09-09 file said only
      // "count", and the gap had to be reverse-engineered from it.
      fs.writeFileSync(path.join(dir, 'clean-titles.json'), JSON.stringify({
        at: result.at, count: result.clean.length, scanned: result.scanned, total: result.total,
        complete: result.complete, titles: result.clean,
      }, null, 2));
    } catch (err) { logger.warn(`could not write the catalogue file: ${err.message}`); }

    audit(req, 'rebuilt the clean-title catalogue',
      `${result.clean.length} clean of ${result.scanned} read (the server holds ${result.total})`, null);
  }

  /**
   * Start a rebuild. Answers at once and walks in the background: a full walk
   * is ~110 requests with a pause between each, well over a minute, and a
   * panel reached through a tunnel drops a request held open that long. The
   * panel follows `running` / `progress` on GET /catalogue.
   */
  router.post('/catalogue/refresh', guard, (req, res) => {
    if (catalogueRun) {
      return res.status(409).json({ ok: false, error: 'a scan is already running' });
    }
    const cfg = configStore.get();
    let pager;
    try { pager = libraryPager(cfg.library, {}); } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    const allowShrink = req.body?.allowShrink === true || req.query?.allowShrink === '1';
    const run = { startedAt: Date.now(), progress: { scanned: 0, total: null, clean: 0, windows: 0 } };
    catalogueRun = run;
    run.done = scanLibrary(pager, {
      blocked: cfg.movieRequests?.blockedRatings ?? [],
      isUnrated,
      ...(Number.isFinite(cfg.library?.catalogueDelayMs) ? { delayMs: Math.max(0, cfg.library.catalogueDelayMs) } : {}),
      onProgress: (p) => {
        run.progress = p;
        logger.info(`catalogue: ${p.scanned}/${p.total ?? '?'} read, ${p.clean} clean, window ${p.windows}`);
      },
    })
      .then((result) => finishCatalogue(result, { req, allowShrink, cfg }))
      .catch((err) => {
        const st = stateStore.namespace('catalogue');
        const reason = `the walk failed after ${err.progress?.scanned ?? '?'} films: ${err.message}`;
        st.set('lastIncomplete', { at: Date.now(), scanned: err.progress?.scanned ?? null, total: err.progress?.total ?? null, reason });
        logger.warn(`catalogue rebuild not published - ${reason}`);
        audit(req, 'catalogue rebuild FAILED', reason, null);
      })
      .finally(() => { if (catalogueRun === run) catalogueRun = null; });

    audit(req, 'started a clean-title catalogue rebuild', allowShrink ? 'publishing even if shorter' : null, res);
    res.status(202).json({ ok: true, started: true });
  });


  /* ---------------------------- history --------------------------- */

  /**
   * A History row with its requester's number as +<digits>. Rows written
   * before 2026-10-01 hold "+1 (555) 807-0190", which the operator could not
   * paste into the Members tab; they are left as stored and shown this way.
   * A requester with no WhatsApp name was kept as a number or a jid, and is
   * shown the same way.
   */
  const historyShown = (r) => {
    const shown = phoneOut(r.requesterNumberDisplay ?? null) ?? formatPhone(r.requesterNumber);
    return {
      ...r,
      ...(r.requester != null ? { requester: phoneOut(r.requester) } : {}),
      ...(shown ? { requesterNumberDisplay: shown } : {}),
    };
  };

  /**
   * Movies and TV keep their own state namespaces, so the History tab merges
   * them - it previously showed only movies, and a TV request left no trace.
   */
  router.get('/history', guard, (req, res) => {
    const movies = stateStore.namespace('movie-requests').get('history', []) ?? [];
    const tv = (stateStore.namespace('tv-requests').get('history', []) ?? [])
      .map((r) => ({ ...r, kind: r.kind ?? 'tv' }));
    const all = [...movies.map((r) => ({ ...r, kind: r.kind ?? 'movie' })), ...tv]
      .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
      .slice(0, 500)
      .map(historyShown);
    res.json(all);
  });

  /** Re-queue every history row that never finished (queued/lost), deduped
   *  by title+year, skipping blocked/not-found/already-sent rows. */
  /** Mute/unmute a number from being @-tagged in the notifications group. */
  router.post('/notify/no-tag', guard, (req, res) => {
    const num = String(req.body?.number ?? '').replace(/[^0-9]/g, '');
    if (!num) return res.status(400).json({ error: 'no number' });
    const cur = new Set((configStore.get().movieRequests.notify?.noTag ?? [])
      .map((x) => String(x).replace(/[^0-9]/g, '')).filter(Boolean));
    if (req.body?.muted) cur.add(num); else cur.delete(num);
    configStore.update({ movieRequests: { notify: { noTag: [...cur] } } });
    audit(req, `${req.body?.muted ? 'muted' : 'unmuted'} notify tag for +${num}`, null, res);
    res.json({ ok: true, noTag: [...cur] });
  });

  router.post('/requeue-all', guard, async (req, res) => {
    const plugin = pluginManager.plugins.get('movie-requests')?.plugin;
    const ctx = pluginManager.plugins.get('movie-requests')?.ctx;
    if (!plugin?.requeue) return res.status(503).json({ error: 'plugin not loaded' });

    const hist = stateStore.namespace('movie-requests').get('history', []) ?? [];
    const seen = new Set();
    const todo = [];
    const sentSince = [];
    let betaSkipped = 0;
    for (const r of hist) {
      if (!['queued', 'lost', 'interrupted', 'failed', 'error'].includes(r.status)) continue;
      // A failed beta request is a test result, not a member waiting for a
      // film. Re-running it from here would queue it as panel work - which
      // goes to the MAIN posts group - so it is left for the tester to ask
      // again in the beta group.
      if (r.beta) { betaSkipped += 1; continue; }
      // Asked for again since and sent, or on its way: a re-run would post
      // it a second time (Minority Report and Charlie, 2026-09-28, each
      // failed and then sent - the same test the hourly check applies).
      const again = askedAgain('movie', r, hist);
      if (again) { sentSince.push(`${r.title ?? r.request}: ${again.status === 'sent' ? 'sent' : again.status} since`); continue; }
      const key = `${(r.title ?? r.request ?? '').toLowerCase()}|${r.year ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      todo.push(r.request ?? r.title);
    }

    const queued = [];
    const skipped = [...sentSince];
    for (const text of todo) {
      try {
        const r = await plugin.requeue(text, ctx, { requester: 'bulk re-run (admin)' });
        queued.push(`${r.title} (${r.year})`);
      } catch (err) {
        skipped.push(`${text}: ${err.message}`);
      }
    }
    // Beta rows are counted on their own. Folded into `skipped` as one entry,
    // three of them read as "skipped 1 (blocked / not found / not in library)" -
    // the wrong number and the wrong reason.
    audit(req, `bulk re-ran ${queued.length} request(s)`,
      (queued.length ? queued.join(' · ') : 'nothing eligible')
      + (skipped.length ? ` — ${skipped.length} skipped` : '')
      + (betaSkipped ? ` — ${betaSkipped} beta test(s) left for the beta group` : ''), res);
    res.json({ ok: true, queued, skipped, betaSkipped });
  });

  /**
   * What the bot would do with a library item, for the Test tab's link check.
   *
   * This used to decide from the letter grade alone, against the film list
   * whatever the item was, and to call every unrated item unsendable - so a
   * title on the override list read as refused, an episode was judged on the
   * film ratings, and an unrated film was "not sent" on an install that
   * sends unrated films (blockUnrated off). The operator added three titles
   * to the list on 2026-09-29 and was told by the panel that the bot would
   * block them. So it asks what the request paths ask: the TV list and the
   * series' rating for a show, the bypass-list entry that covers the item
   * (isOverridden for a film, tvOverrideFor for TV, as the plugins match),
   * and whether the AI check could clear one its rating blocks.
   *
   * Resolves to { verdict, wouldSend, why, override }: verdict 'send' - its
   * rating allows it, or it is on the bypass list and is sent with no AI
   * check, the operator's "Send it, no AI check" (2026-09-29) - 'blocked', or
   * 'check': its rating blocks it and the AI check could clear it, which no
   * lookup can know in advance.
   *
   * For a show, what it says is what a TV request would do. Queue link does
   * not take a show at all (tvItemRefusal), and `why` says so, so an amber
   * 'check' or a green 'send' is never read as a promise it breaks.
   */
  async function linkVerdict(item, cfg) {
    const tv = !!tvItemRefusal(item);
    const section = (tv ? cfg.tvRequests : cfg.movieRequests) ?? {};
    const list = section.blockedRatings ?? [];
    const own = String(item.rated ?? '').trim();
    const ownBlocked = isBlockedRating(own, list, { blockUnrated: section.blockUnrated === true });
    const tvNote = tv ? ' Queue link on the Dashboard does not queue TV: ask for it by name in the TV group,'
      + ' or re-run it by title from the queue box.' : '';

    // An episode or a season is withheld on its series' rating as well as its
    // own (blockingRating in tv-requests/override-check.js), so the series is
    // looked up for its rating, and for the name and year its entry matches.
    let series = null;
    if (item.type === 'Series') {
      series = { id: item.id, name: item.title, year: item.year, rated: own };
    } else if (tv) {
      // A series that cannot be read is not an unrated one. Read as "no
      // rating", a TV-14 pilot of a TV-MA show came back 'send', painted
      // green, when Jellyfin answered 503 for the series - an episode the TV
      // plugin withholds on the series' rating - and the failure left no
      // trace (review of 2026-09-29).
      let s = null;
      let err = null;
      if (item.seriesId) {
        try { s = await libraryItemById(item.seriesId, cfg.library); } catch (e) { err = e; }
      }
      if (!s) {
        const cause = !item.seriesId ? 'Jellyfin did not say which series it belongs to'
          : err ? err.message : "the bot's Jellyfin account cannot see the series";
        logger.warn(`link check: could not read the series of ${item.type.toLowerCase()} ${item.id}`
          + ` (series ${item.seriesId ?? 'unknown'}): ${cause}`);
        return {
          verdict: 'blocked', wouldSend: false, override: null,
          why: `Could not read the series' rating (${cause}), so this cannot be judged: a TV request judges`
            + ` a ${item.type.toLowerCase()} on its series' rating as well as its own.${tvNote}`,
        };
      }
      series = {
        id: item.seriesId, name: s.title ?? item.seriesName, year: s.year ?? null,
        rated: String(s.rated ?? '').trim(),
      };
    }
    const seriesBlocked = item.type !== 'Series' && !!series?.rated && isBlockedRating(series.rated, list);
    const blocked = ownBlocked || seriesBlocked;

    const store = overrideStore();
    const entryFor = () => (!tv
      ? isOverridden(store, { title: item.title, year: item.year, jellyfinId: item.id })
      : tvOverrideFor(store, series, item.type === 'Series' ? { seriesId: item.id } : {
        id: item.type === 'Episode' ? item.id : null,
        seasonId: item.type === 'Season' ? item.id : item.seasonId,
        seriesId: item.seriesId,
        season: item.season,
        episode: item.episode,
        series: item.seriesName,
      }));
    const canClear = aiCanClear(cfg.gemini, cfg.ai);
    const unratedFilm = !tv && !own;
    // queueLibraryItem counts an item with no rating as blocked, whatever
    // blockUnrated says; a request by name is judged on OMDb's rating
    // instead. The bypass list sends a listed one all the same.
    const queueNote = unratedFilm && !entryFor()
      ? (canClear
        ? ' Queue link on the Dashboard counts an item with no rating as blocked: it queues it only if the AI check clears it.'
        : ' Queue link on the Dashboard refuses an item with no rating: set one in Jellyfin to queue it from there.')
      : '';
    const season = tv && item.type !== 'Episode'
      ? ' Episodes rated higher than the series are decided one by one when a season is asked for.' : '';

    if (!blocked) {
      const why = own ? `Rated ${own}, which is allowed.`
        : series?.rated && item.type !== 'Series'
          ? `The series is rated ${series.rated}, which is allowed; this ${item.type.toLowerCase()} has no rating of its own.`
          : tv ? 'No rating set in Jellyfin; TV with no rating is not blocked.'
            : 'No rating set in Jellyfin, and unrated films are not blocked.';
      return { verdict: 'send', wouldSend: true, override: null, why: `${why}${season}${queueNote}${tvNote}` };
    }

    const refusal = seriesBlocked && !ownBlocked
      ? `The series is rated ${series.rated}, which is on the blocked list.`
      : own ? `Rated ${own}, which is on the blocked list.` : 'No rating set in Jellyfin, and unrated films are blocked.';
    const entry = entryFor();
    if (entry) {
      // Sent with no AI check, as every request path sends it (contentGate,
      // and the TV plugin's screenRated).
      const named = describeOverride(entry);
      return {
        verdict: 'send', wouldSend: true, override: named,
        why: `${refusal} It is on the bypass list (${named}), so it is sent without the AI check.${season}${tvNote}`,
      };
    }
    if (canClear) {
      return {
        verdict: 'check', wouldSend: false, override: null,
        why: `${refusal} It is sent only if the AI check finds no nudity in it.${season}${queueNote}${tvNote}`,
      };
    }
    return { verdict: 'blocked', wouldSend: false, override: null, why: `${refusal}${season}${queueNote}${tvNote}` };
  }

  /**
   * Queue something by hand. The box takes movies AND TV: a request naming a
   * season or episode ("Rick and Morty season 4") goes to the TV pipeline,
   * anything else is treated as a movie - and if the movie lookup finds
   * nothing, TV is tried as a fallback before giving up, since a bare show
   * name is indistinguishable from a film title.
   */
  /**
   * Queue a film from a Jellyfin URL, skipping the title match entirely.
   *
   * The matcher is fuzzy and sometimes wrong - OMDb canonicalises "f1" to
   * "F1: The Movie" while the library holds it as "F1", and the film comes
   * back "not in library" when it is right there. Pasting the item's URL
   * removes the guessing: the id is exact.
   */
  /**
   * The member a hand-queued job is assigned to (members.js assignedMember),
   * from the roster key the panel's picker sends, or null when none was
   * picked. Throws, with the words the panel shows, when the key is no longer
   * on the roster.
   */
  const memberFor = (req) => {
    const key = String(req.body?.member ?? '').trim();
    if (!key) return null;
    return assignedMember(aggregateMembers(bot.groupsWithMembers(), bot.memberActivity?.all() ?? {}), key);
  };
  /** " for <name>" in an audit row, when the job was assigned. */
  const forWhom = (member) => (member ? ` for ${member.name}${member.display && member.display !== member.name ? ` ${member.display}` : ''}` : '');

  /** Look a Jellyfin link up and report what it is. Queues nothing. */
  router.post('/test/jellyfin-url', guard, async (req, res) => {
    const parsed = parseJellyfinUrl(req.body?.url);
    if (!parsed) {
      return res.status(400).json({
        ok: false,
        error: "That doesn't look like a Jellyfin item link. Paste a Download or stream URL, "
          + 'the /web/#/details?id=… address, or just the item id.',
      });
    }
    try {
      const item = await libraryItemById(parsed.id, configStore.get().library);
      if (!item) return res.status(404).json({ ok: false, error: `Nothing on the server has the id ${parsed.id}.` });

      const rated = String(item.rated ?? '').trim();
      res.json({
        ok: true,
        id: item.id, title: item.title, year: item.year, rated: rated || null,
        type: item.type, onDisk: !!item.localPath,
        ...(await linkVerdict(item, configStore.get())),
      });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.post('/queue/from-url', guard, async (req, res) => {
    const parsed = parseJellyfinUrl(req.body?.url);
    if (!parsed) {
      return res.status(400).json({
        ok: false,
        error: "That doesn't look like a Jellyfin item link. Paste a Download or stream URL, "
          + 'the /web/#/details?id=… address, or just the item id.',
      });
    }
    try {
      const item = await libraryItemById(parsed.id, configStore.get().library);
      if (!item) return res.status(404).json({ ok: false, error: `Nothing on the server has the id ${parsed.id}.` });
      // Queue link is film-shaped; a show goes through the TV plugin's rules
      // (tvItemRefusal), which the link check describes.
      const tv = tvItemRefusal(item);
      if (tv) return res.status(400).json({ ok: false, error: tv });

      const movie = pluginManager.plugins.get("movie-requests");
      if (!movie?.plugin?.queueLibraryItem) {
        return res.status(503).json({ ok: false, error: 'movie-requests plugin not loaded' });
      }
      const member = memberFor(req);
      const r = await movie.plugin.queueLibraryItem(item, movie.ctx, {
        requester: `panel (${req.session.user.username})`, member,
      });
      // The pasted URL usually carries an api_key; never store or log it.
      audit(req, `queued "${item.title}" from a Jellyfin link${forWhom(member)}`,
        `item ${parsed.id}${item.year ? ` · ${item.year}` : ''}${item.rated ? ` · ${item.rated}` : ''}`, res);
      res.json({ ok: true, ...r, title: item.title, year: item.year, rated: item.rated });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  /**
   * Queue a film from a public download link (media/public-link.js), with
   * the title and year it is posted under. The operator (2026-09-30): "why
   * should it need to be jellyfin if it's public anyway". The plugin checks
   * the link - public addresses on every hop, a video, under the size cap -
   * before queueing, and a refusal comes back as the panel's error line.
   *
   * The link's query string can be a token: the audit row, like History and
   * the log, keeps the host and path only (linkForDisplay), and the error
   * messages name the host alone.
   */
  router.post('/queue/public-link', guard, async (req, res) => {
    const movie = pluginManager.plugins.get('movie-requests');
    if (!movie?.plugin?.queuePublicLink) {
      return res.status(503).json({ ok: false, error: 'movie-requests plugin not loaded' });
    }
    const shown = linkForDisplay(String(req.body?.url ?? '').trim());
    try {
      const member = memberFor(req);
      const r = await movie.plugin.queuePublicLink({
        url: req.body?.url, title: req.body?.title, year: req.body?.year,
      }, movie.ctx, { requester: `panel (${req.session.user.username})`, member });
      audit(req, `queued "${r.title}${r.year ? ` (${r.year})` : ''}" from ${r.via ? `${r.site} via yt-dlp` : 'a public link'}${forWhom(member)}`,
        `${r.link}${r.duration ? ` · ${fmtLength(r.duration)}` : ''}${r.size ? ` · ${r.via ? 'about ' : ''}${fmtBytes(r.size)}` : ''}`, res);
      res.json({ ok: true, ...r });
    } catch (err) {
      // The reply, a log line, and a durable record (CLAUDE.md): a refused
      // link - a private address among them - is in the audit log too.
      logger.warn(`public link ${shown}: not queued - ${err.message}`);
      audit(req, 'public link not queued', `${shown} · ${err.message}`, res);
      res.status(err.code === 'DUPLICATE' ? 409 : 400).json({ ok: false, error: err.message, code: err.code ?? null });
    }
  });

  /**
   * The card's look at a link as it is pasted, before Queue: a file (its
   * size), or a page yt-dlp reads the video out of (its site, title and
   * length, to fill in the name: "from YouTube via yt-dlp - 1 h 32 min").
   * Nothing is queued, and nothing is audited: it changes nothing. A refusal
   * is the same sentence queueing would give.
   */
  router.post('/queue/public-link/inspect', guard, async (req, res) => {
    const movie = pluginManager.plugins.get('movie-requests');
    if (!movie?.plugin?.inspectPublicLink) {
      return res.status(503).json({ ok: false, error: 'movie-requests plugin not loaded' });
    }
    // Nothing changes: not a row of its own in the audit log (the backstop
    // below would write "POST /queue/public-link/inspect" for every paste).
    res.locals.audited = true;
    try {
      const r = await movie.plugin.inspectPublicLink({ url: req.body?.url }, movie.ctx);
      res.json({ ok: true, ...r });
    } catch (err) {
      logger.info(`public link ${linkForDisplay(String(req.body?.url ?? '').trim())}: looked at - ${err.message}`);
      res.status(400).json({ ok: false, error: err.message, code: err.code ?? null });
    }
  });

  /**
   * yt-dlp on this box, and the cookies it signs in with (media/yt-dlp-cookies.js),
   * for Settings -> Library & files -> File handling. The cookies themselves
   * are never sent back by this or any route: only whether they are set,
   * when and by whom they were uploaded, how many there are, whether
   * youtube.com is among them, and when they expire.
   */
  router.get('/yt-dlp', guard, (req, res) => {
    const paths = ytDlpPaths();
    const stamp = readYtDlpStamp(paths.stamp);
    res.json({
      installed: fs.existsSync(paths.bin),
      deno: fs.existsSync(paths.deno),
      version: stamp?.version ?? null,
      lastCheck: stamp?.at ? { at: Date.parse(stamp.at) || null, ok: !!stamp.ok, error: stamp.ok ? null : (stamp.error ?? null) } : null,
      cookies: describeCookies(configStore.dataDir),
    });
  });

  router.put('/yt-dlp/cookies', guard, (req, res) => {
    const by = req.session.user.username;
    try {
      const d = saveCookies(configStore.dataDir, req.body?.text, { by });
      audit(req, 'uploaded cookies for yt-dlp',
        `${d.count} cookie(s) · youtube.com ${d.youtube ? 'present' : 'absent'}${d.signedIn ? ', signed in' : ''}`
        + `${d.expires ? ` · expire ${new Date(d.expires).toISOString().slice(0, 10)}` : ''}`, res);
      logger.info(`cookies for yt-dlp uploaded by ${by}: ${d.count} cookie(s), youtube.com ${d.youtube ? 'present' : 'absent'}`);
      res.json({ ok: true, cookies: d });
    } catch (err) {
      // Refused uploads are recorded too, without a byte of what was sent.
      audit(req, 'cookies for yt-dlp not saved', err.message, res);
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.delete('/yt-dlp/cookies', guard, (req, res) => {
    const had = removeCookies(configStore.dataDir);
    audit(req, had ? 'removed the cookies for yt-dlp' : 'removed the cookies for yt-dlp (there were none)', null, res);
    if (had) logger.info(`cookies for yt-dlp removed by ${req.session.user.username}`);
    res.json({ ok: true, cookies: describeCookies(configStore.dataDir) });
  });

  router.post('/requeue', guard, async (req, res) => {
    const text = String(req.body?.text ?? '').trim();
    if (!text) return res.status(400).json({ error: 'no title given' });

    const movie = pluginManager.plugins.get('movie-requests');
    const tv = pluginManager.plugins.get('tv-requests');
    const tvEnabled = !!configStore.get().tvRequests?.enabled && !!tv?.plugin?.requeue;

    // A pasted TMDB/Trakt link carries the title in its slug and the season in
    // its path; use that rather than sending a URL to OMDb, which matches
    // nothing. IMDb links carry only an id, which OMDb can resolve by imdbId.
    const link = parseMediaUrl(text);
    let query = text;
    if (link) {
      const rewritten = urlToRequestText(text);
      if (rewritten) {
        query = rewritten;
        logger.info(`queue: resolved ${link.source} link -> "${query}"`);
      } else if (link.imdbId) {
        query = link.imdbId;                 // OMDb accepts an imdb id directly
        logger.info(`queue: resolved imdb link -> ${query}`);
      } else {
        return res.status(400).json({ ok: false, error: `Could not read a title from that ${link.source} link` });
      }
    }

    const parsed = parseTvRequest(query);
    // A list of episodes with no season ("Fullmetal alchemist E14, E16") is
    // TV too: it has neither a season nor one episode, and would be looked
    // up as a film. So is a run of them with no season, which is what a
    // list with no gap comes back as: "The Office episode 3 and 4" and
    // "Fullmetal alchemist E14, E15", one episode each to the box before
    // lists were read, went to the film lookup first once they were runs,
    // and a film of the same name would have been queued instead
    // (Fullmetal Alchemist, 2017; found in review, 2026-10-12). History's
    // Re-run comes this way too.
    const looksLikeTv = link?.kind === 'tv'
      ? (link.season != null || link.episode != null)
      : (parsed.season != null || parsed.episode != null || !!parsed.episodeList || !!parsed.episodeRange);

    // An admin queueing one title by hand is not what maxQueueLength is for -
    // that brakes what the request groups can pile up - so it goes in past
    // the limit, and the answer says so. The bulk re-run still obeys it.
    let member;
    try { member = memberFor(req); } catch (err) { return res.status(400).json({ ok: false, error: err.message }); }
    const tryTv = async () => tv.plugin.requeue(query, tv.ctx, { requester: 'manual (admin)', overLimit: true, member });
    const tryMovie = async () => movie.plugin.requeue(query, movie.ctx, { requester: 'manual (admin)', overLimit: true, member });
    const waiting = () => queue.requestCounts?.().waiting ?? queue.pending.length;
    // 0 is no limit (queue.js _waitLimit), so nothing is ever past it.
    const past = () => (queue.maxLength > 0 && waiting() > queue.maxLength ? { overLimit: true, limit: queue.maxLength } : {});

    try {
      if (looksLikeTv) {
        if (!tvEnabled) {
          return res.status(400).json({ ok: false, error: 'That looks like a TV request, but the TV section is off (Settings -> TV section).' });
        }
        const r = await tryTv();
        auditRequeue(req, res, r, text, member);
        return res.json({ ok: true, ...r, ...past() });
      }
      if (!movie?.plugin?.requeue) return res.status(503).json({ error: 'movie-requests plugin not loaded' });
      try {
        const r = await tryMovie();
        auditRequeue(req, res, r, text, member);
        return res.json({ ok: true, ...r, ...past() });
      } catch (movieErr) {
        // Only "not a film we can find" is worth asking TV about: a bare show
        // name reads like a film title. A film that was found and refused - a
        // blocked rating, a mismatched file - or a full queue is the answer.
        // Asking TV anyway turned "Queue is full" for Ready Player One into
        // "Queue is full (50 waiting) · TV: No show matching", which read as
        // the bot taking a film for a show.
        //
        // Nor is a film asked for with a year whose near-namesake in the
        // library was refused as another film: "Star Trek 2009", with Into
        // Darkness and Beyond on the server, went on to TV and came back
        // "... · TV: Which season of Star Trek: The Next Generation?" (review
        // of the Barefoot 2014 fix, 2026-09-29). A group request answers it
        // "not in the library", and so does this.
        const yearStampedFilm = movieErr.code === 'NOT_IN_LIBRARY' && !!movieErr.otherFilm && !!movieErr.typedYear;
        if (!tvEnabled || !['NO_MATCH', 'NOT_IN_LIBRARY'].includes(movieErr.code) || yearStampedFilm) throw movieErr;
        try {
          const r = await tryTv();
          auditRequeue(req, res, r, text, member);
          return res.json({ ok: true, ...r, ...past() });
        } catch (tvErr) {
          // Report BOTH, so "no match" does not hide the real TV reason.
          throw new Error(`${movieErr.message} · TV: ${tvErr.message}`);
        }
      }
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.get('/transfers', guard, (req, res) => {
    // Stored with the number as it was shown when the film went out: the old
    // "+1 (…)" form before 2026-10-01. Shown as +digits.
    const rows = stateStore.namespace('movie-requests').get('transfers', []) ?? [];
    res.json(rows.map((t) => (t && typeof t === 'object'
      ? { ...t, requester: phoneOut(t.requester), requesterNumber: phoneOut(t.requesterNumber) }
      : t)));
  });

  router.delete('/transfers', guard, (req, res) => {
    stateStore.namespace('movie-requests').set('transfers', []);
    res.json({ ok: true });
  });

  router.delete('/history', guard, (req, res) => {
    stateStore.namespace('movie-requests').set('history', []);
    res.json({ ok: true });
  });

  /* ----------------------------- logs ----------------------------- */

  router.get('/logs', guard, (req, res) => {
    res.json(log.recent(Number(req.query.n) || 200));
  });

  /* ----------------------------- debug log ------------------------ */

  /** Rotated log files on disk, newest first. */
  router.get('/logs/files', guard, (req, res) => {
    try {
      res.json(fileLogger.list());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /** Read one log file back into the viewer. */
  router.get('/logs/file/:name', guard, (req, res) => {
    try {
      res.type('text/plain').send(fileLogger.read(req.params.name));
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  /** Download a log file. */
  router.get('/logs/download/:name', guard, (req, res) => {
    try {
      const body = fileLogger.read(req.params.name, { maxBytes: 64 * 1024 * 1024 });
      res.setHeader('Content-Disposition', `attachment; filename="${req.params.name.replace(/\.gz$/, '')}"`);
      res.type('text/plain').send(body);
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  /* ------------------------------- email -------------------------- */

  router.get('/email/presets', guard, (req, res) => {
    res.json(Object.fromEntries(Object.entries(PRESETS).map(([k, v]) => [k, v ?? {}])));
  });

  /** Check the SMTP credentials without sending anything. */
  router.post('/email/verify', guard, async (req, res) => {
    const cfg = mergeEmailBody(req.body);
    res.json(await verifyEmail(cfg));
  });

  /** Send a test message. */
  router.post('/email/test', guard, async (req, res) => {
    const cfg = mergeEmailBody(req.body);
    res.json(await sendTestEmail(cfg));
  });

  /** Email the current debug log on demand. */
  router.post('/email/send-log', guard, async (req, res) => {
    try {
      const r = await alerts.sendNow({
        label: req.body?.label || 'debug log',
        note: req.body?.note || '',
      });
      res.json({ ok: true, messageId: r.messageId });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  /**
   * Let the settings form test credentials it has not saved yet, while
   * still falling back to the stored app password when the field is masked.
   */
  function mergeEmailBody(body) {
    const stored = configStore.get().email;
    const out = { ...stored, ...(body ?? {}) };
    if (!out.appPassword || out.appPassword === MASK) out.appPassword = stored.appPassword;
    return out;
  }

  /* --------------------------- diagnostics ------------------------ */

  router.get('/diagnostics', guard, async (req, res) => {
    const cfg = configStore.get();
    const tools = await checkTools(cfg.media);
    let disk = null;
    try {
      const st = fs.statfsSync(cfg.media.workDir);
      disk = {
        free: st.bavail * st.bsize,
        total: st.blocks * st.bsize,
        freeHuman: fmtBytes(st.bavail * st.bsize),
      };
    } catch { /* statfs is not critical */ }

    res.json({
      node: process.version,
      uptimeSec: Math.floor(process.uptime()),
      memory: {
        rssHuman: fmtBytes(process.memoryUsage().rss),
      },
      ffmpeg: tools,
      encoder: encoderStatus(cfg.media),
      disk,
      workDir: cfg.media.workDir,
      maxOutput: fmtBytes(cfg.media.maxOutputBytes),
      plugins: pluginManager.list(),
      whatsapp: bot.status(),
      logs: {
        dir: fileLogger.dir,
        files: fileLogger.list().length,
        totalBytes: fileLogger.list().reduce((n, f) => n + f.size, 0),
      },
      email: {
        enabled: !!configStore.get().email.enabled,
        configured: !!configStore.get().email.appPassword,
        onError: !!configStore.get().email.onError,
      },
      code: { commit: RUNNING_COMMIT },
      autoUpdate: readAutoUpdate(configStore.dataDir, { startedAt: STARTED_AT }),
      hourlyCheck: hourlyCheckDiagnostics(configStore),
    });
  });

  /**
   * Outbound connectivity check. This network runs a TLS-intercepting filter,
   * so the most common failure by far is an untrusted certificate rather than
   * a wrong API key - this names that explicitly instead of leaving a cryptic
   * "unable to get local issuer certificate" in the logs.
   */
  router.get('/test/connectivity', guard, async (req, res) => {
    const targets = [
      { name: 'OMDb',     url: 'https://www.omdbapi.com/?s=test', required: true },
      { name: 'TMDB',     url: 'https://api.themoviedb.org/3/configuration', required: false },
      { name: 'WhatsApp', url: 'https://web.whatsapp.com/', required: true },
    ];

    const results = await Promise.all(targets.map(async (t) => {
      const started = Date.now();
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 12_000);
        // A 401/404 still proves the TLS handshake and routing worked.
        const r = await fetch(t.url, { signal: ctrl.signal, redirect: 'manual' });
        clearTimeout(timer);
        return { ...t, ok: true, status: r.status, ms: Date.now() - started };
      } catch (err) {
        const msg = err.cause?.message ?? err.message ?? String(err);
        const isCert = /certificate|self-signed|SELF_SIGNED|UNABLE_TO_GET_ISSUER|unable to verify/i.test(msg);
        return {
          ...t,
          ok: false,
          ms: Date.now() - started,
          error: msg,
          certProblem: isCert,
          hint: isCert
            ? 'A TLS-intercepting filter is on this network. Put its root CA in the certs/ folder and restart - see certs/README.txt.'
            : undefined,
        };
      }
    }));

    const certBundle = process.env.NODE_EXTRA_CA_CERTS ?? null;
    res.json({
      results,
      extraCaLoaded: certBundle,
      anyCertProblem: results.some((r) => r.certProblem),
    });
  });

  // The fallback AI providers card: its own routes, so that saving it is one
  // auditable action and the keys never travel in the main settings form.
  mountAiRoutes(router, { configStore, guard, audit, contentHealth, pluginManager });

  // Test key for OMDb, TMDB and the Jellyfin share key. It replaced a bare
  // POST /test/omdb that had no rate limit, no audit line naming the key and
  // no scrubbing of what OMDb said back; see key-test-routes.js.
  mountKeyTestRoutes(router, { configStore, guard, audit });

  // The hourly check's runs and reports, for the Logs tab (hourly-checks-routes.js).
  mountHourlyCheckRoutes(router, { configStore, guard });

  // The operator's Discord account, read-only, for their support tickets
  // with the Jellyfin host (discord-routes.js): super-admin only to change.
  mountDiscordRoutes(router, { configStore, stateStore, guard, audit, discord: discordWatch });

  /* --------------------------- jellyfin auth ---------------------------- */

  // Quick Connect secrets are short-lived and single-use, so they live in
  // memory rather than being written to disk.
  const quickConnectSessions = new Map();

  /** Stable per-install device id, so Jellyfin shows one session, not dozens. */
  function ensureDeviceId() {
    const cfg = configStore.get();
    if (!cfg.library.jellyfin.deviceId) {
      configStore.update({ library: { jellyfin: { deviceId: `wabot-${randomToken(6)}` } } });
    }
    return configStore.get().library.jellyfin.deviceId;
  }

  function saveJellyfinAuth(auth) {
    configStore.update({
      library: {
        jellyfin: {
          accessToken: auth.accessToken,
          userId: auth.userId ?? '',
          userName: auth.userName ?? '',
        },
      },
    });
  }

  router.get('/jellyfin/status', guard, async (req, res) => {
    const jf = configStore.get().library.jellyfin;
    const out = {
      authMethod: jf.authMethod,
      linked: false,
      userName: jf.userName || null,
      quickConnectAvailable: false,
    };
    if (jf.baseUrl) {
      out.quickConnectAvailable = await quickConnectEnabled(jf.baseUrl);
    }
    const token = jf.authMethod === 'apikey' ? jf.apiKey : jf.accessToken;
    if (jf.baseUrl && token) {
      try {
        const me = await verifyToken(jf.baseUrl, token, { deviceId: jf.deviceId });
        out.linked = true;
        out.userName = me.userName ?? out.userName;
      } catch { out.linked = false; }
    }
    res.json(out);
  });

  /** Link with username + password. Stores only the resulting token. */
  router.post('/jellyfin/link/password', guard, async (req, res) => {
    const jf = configStore.get().library.jellyfin;
    const baseUrl = req.body?.baseUrl || jf.baseUrl;
    const username = req.body?.username || jf.username;
    const password = (req.body?.password && req.body.password !== MASK)
      ? req.body.password
      : jf.password;

    try {
      const auth = await authenticateByPassword(baseUrl, username, password, {
        deviceId: ensureDeviceId(),
      });
      saveJellyfinAuth(auth);
      res.json({ ok: true, userName: auth.userName, userId: auth.userId });
    } catch (err) {
      const msg = err.status === 401
        ? 'Jellyfin rejected that username or password'
        : err.message;
      res.status(400).json({ ok: false, error: msg });
    }
  });

  /** Begin Quick Connect - returns the code to type into Jellyfin. */
  router.post('/jellyfin/quickconnect/start', guard, async (req, res) => {
    const jf = configStore.get().library.jellyfin;
    const baseUrl = req.body?.baseUrl || jf.baseUrl;
    try {
      const deviceId = ensureDeviceId();
      const { secret, code } = await quickConnectInitiate(baseUrl, { deviceId });
      const id = randomToken(8);
      quickConnectSessions.set(id, { secret, baseUrl, deviceId, at: Date.now() });
      // Quick Connect codes expire server-side; drop ours after 5 minutes.
      setTimeout(() => quickConnectSessions.delete(id), 300_000).unref?.();
      res.json({ ok: true, id, code });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  /** Poll until the operator approves the code in a Jellyfin client. */
  router.get('/jellyfin/quickconnect/poll', guard, async (req, res) => {
    const session = quickConnectSessions.get(req.query.id);
    if (!session) {
      return res.status(404).json({ ok: false, error: 'That Quick Connect request expired. Start again.' });
    }
    try {
      const r = await quickConnectPoll(session.baseUrl, session.secret, { deviceId: session.deviceId });
      if (!r.authenticated) return res.json({ ok: true, authenticated: false });
      quickConnectSessions.delete(req.query.id);
      saveJellyfinAuth(r);
      res.json({ ok: true, authenticated: true, userName: r.userName });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.post('/jellyfin/unlink', guard, (req, res) => {
    configStore.update({ library: { jellyfin: { accessToken: '', userId: '', userName: '' } } });
    res.json({ ok: true });
  });

  router.post('/test/library', guard, async (req, res) => {
    res.json(await testLibrary(configStore.get().library, { onTokenRefreshed: saveJellyfinAuth }));
  });

  /**
   * Dry-run a request exactly as the bot would evaluate it, without touching
   * WhatsApp. This is the fastest way to sanity-check settings.
   */
  router.post('/test/request', guard, async (req, res) => {
    const text = String(req.body?.text ?? '').trim();
    if (!text) return res.status(400).json({ error: 'no text' });
    const cfg = configStore.get();
    const steps = [];

    // Step 0a of a request: several films in one message are refused before
    // anything is looked up (the operator's one-film-per-request rule,
    // 2026-10-11). Without it the dry run would hand OMDb "rocky 1 2 3 4 5
    // and 6" and report whatever one film came back.
    const several = severalFilms(text);
    if (several) {
      steps.push({
        step: 'one film', ok: false,
        detail: `${several.count ? `${several.count} films` : 'a whole series'} in one request — refused. ${oneFilmReply(several, '')}`,
        reaction: cfg.movieRequests.reactions.oneAtATime,
      });
      return res.json({ steps, verdict: 'one-at-a-time' });
    }

    try {
      // Step 0 of a request, before OMDb is asked anything: the films on the
      // server whose titles start with the words typed (step-zero.js, the
      // request's own code). The dry run had only the year question of a
      // request's step 4a, and once the list left beta (2026-10-11) it said
      // "Ambiguous — needs a year" for Heat and Venom, which members were
      // shown the list for, and for the one Frozen that is not R, which a
      // request sent.
      //
      // `asked` is what the rest of the dry run looks up: what was typed, or
      // the one film step 0 goes ahead with, by its library title and year.
      let asked = text;
      let onlyAsTyped = null;
      if (asksWhichOne(cfg.movieRequests, text)) {
        let zero = null;
        try {
          zero = await stepZero(text, cfg, { store: overrideStore(), onTokenRefreshed: saveJellyfinAuth });
        } catch (err) {
          steps.push({
            step: 'which one', ok: true,
            detail: `the library could not be searched for a list (${err.message}) — a request carries on without one`,
          });
        }
        const d = zero?.decision;
        const films = (items) => items.map((v) => `${v.title} (${v.year})`).join(', ');
        if (d?.kind === 'list') {
          const more = d.moreStartWith ? ` (${d.moreStartWith} more start with it; the list says so)` : '';
          steps.push({
            step: 'which one', ok: false,
            detail: `${d.items.length} films on the server ${oneTitle(d.items) ? `are called "${d.items[0].title}"` : `start with "${zero.query}"`}`
              + ` and can be sent — the requester is answered with a numbered list to pick from: ${films(d.items)}${more}`,
          });
          return res.json({
            steps, verdict: 'pick-list', reason: `${d.items.length} to pick from`,
            offered: d.items.map((v) => ({ title: v.title, year: v.year })),
          });
        }
        if (d?.kind === 'narrow') {
          steps.push({
            step: 'which one', ok: false,
            detail: narrowDownText(zero.query, d.items, { prefix: requestPrefix(cfg.movieRequests), atLeast: !!d.atLeast }),
            reaction: cfg.movieRequests.reactions.needYear,
          });
          return res.json({ steps, verdict: 'narrow' });
        }
        if (d?.kind === 'only') {
          steps.push({
            step: 'which one', ok: true,
            detail: `${d.item.title} (${d.item.year}) is the one film on the server ${d.versions.length > 1 ? 'of these that can be sent' : `that starts with "${zero.query}"`}`
              + ' — a request goes ahead with it, by title and year',
          });
          onlyAsTyped = text;
          asked = `${d.item.title} ${d.item.year}`;
        }
      }

      let found = null;
      try {
        found = await lookupMovie(asked, { apiKey: cfg.omdb.apiKey });
      } catch (err) {
        // A request takes "too many results" for a title with a year as
        // nothing found, and goes on (its step 1); the one film step 0 goes
        // ahead with is always looked up with its year.
        if (!(onlyAsTyped && isTooBroad(err))) throw err;
      }
      // As a request does for that one film: its library title a year
      // either side, then the words typed (lookupHeldFilm).
      if (!found && onlyAsTyped) {
        const again = await lookupHeldFilm(asked, { apiKey: cfg.omdb.apiKey, asTyped: onlyAsTyped });
        found = again?.found ?? null;
        if (again?.how === 'as-typed') {
          steps.push({
            step: 'which one', ok: true,
            detail: `OMDb does not know "${asked}", the library's title — looked up as typed, "${onlyAsTyped}", as a request is`,
          });
          asked = onlyAsTyped;
        }
      }
      if (!found) {
        steps.push({ step: 'lookup', ok: false, detail: 'no matching film', reaction: cfg.movieRequests.reactions.notFound });
        return res.json({ steps, verdict: 'not-found' });
      }
      const m = found.movie;
      steps.push({
        step: 'lookup', ok: true,
        detail: `${m.title} (${m.year})  •  rated ${m.rated ?? 'unknown'}  •  match ${(found.confidence * 100).toFixed(0)}%`,
        poster: m.poster,
      });

      // The live gate's own rating step (film-gate.js), not a copy of it. The
      // copy this replaced knew nothing of the override list: on 2026-09-29
      // the operator put The Last Samurai on it, dry-ran it, and was told
      // "Blocked: rating" by a panel whose real request would have sent it.
      // A dry run that refuses what a request would send is as wrong as one
      // that passes what a request would refuse.
      const mr = cfg.movieRequests;
      const letter = ratingGate(overrideStore(), m, mr, { gemini: cfg.gemini, ai: cfg.ai });
      const canClear = aiCanClear(cfg.gemini, cfg.ai);
      const unrated = isUnrated(m.rated);
      const unratedBlocked = unrated && mr.blockUnrated === true;
      // What could still send a film its letter blocks, once the library
      // has answered (ratingGate's `deferred`).
      const later = [
        ...(mayCoverFilms(overrideStore()) ? ["a bypass-list entry covers the library's copy"] : []),
        ...(canClear ? ['the AI check clears it'] : []),
      ].join(', or ');
      steps.push({
        step: 'rating', ok: !letter.refused,
        detail: letter.refused
          ? `rated ${m.rated} - blocked`
          : letter.blocked && letter.override
            ? `rated ${m.rated} — on the bypass list (${describeOverride(letter.override)}), so it is sent without the AI check`
            : letter.deferred
              ? `rated ${m.rated} — blocked unless ${later}, which a request settles after the library lookup`
              : unratedBlocked
                // A request judges this after the library lookup (contentGate),
                // so the dry run does too.
                ? 'not rated, and unrated films are blocked — a request settles that at the content step, after the library lookup'
                : `rated ${m.rated ?? 'unknown'} - allowed` + (unrated ? ' (nothing has classified this film)' : ''),
        reaction: letter.refused ? mr.reactions.rated : null,
      });
      if (letter.refused) return res.json({ steps, verdict: 'blocked-rating' });

      // Same order as the live pipeline: library first, release window only
      // as an explanation for a miss. The same search, too: what was typed as
      // well as OMDb's title, and a similar title from a year more than one
      // away refused as another film - the Test tab reported "would send"
      // for "Barefoot 2014" while the library held only Barefoot Gen (1983),
      // which is what the real request posted on 2026-09-29. And a copy of
      // the very title, far from the year typed, refused as the wrong year:
      // Dune (2021) is not "Dune 1984".
      let otherFilm = null;
      const hit = await findInLibrary(m.title, m.year, cfg.library, {
        alsoTry: [asked],
        onOtherFilm: (o) => { otherFilm = o; },
        typedYear: typedYearOf(asked, m),
        // And the same title far from OMDb's year only for the words typed
        // as that title (Fast & Furious 2009 for "fast and furios 6").
        typed: asked,
        imdbId: m.imdbId ?? null,
      });
      steps.push({
        step: 'library', ok: !!hit,
        detail: hit
          ? `found: ${hit.title} (${hit.year})  •  ${hit.access === 'local' ? 'readable on this server' : 'will download'}${hit.size ? `  •  ${fmtBytes(hit.size)}` : ''}`
          : `not in your library${otherFilm ? ` — ${closestNote(otherFilm)}` : ''}`,
      });

      if (!hit && letter.deferred) {
        // A request refuses it on its rating here, as it would have before
        // the library was asked: nothing is there to send.
        steps.push({ step: 'rating', ok: false, detail: `rated ${m.rated} - blocked`, reaction: mr.reactions.rated });
        return res.json({ steps, verdict: 'blocked-rating' });
      }
      // Why the server does not have it, as a request's step 4 answers
      // (notInLibrary there): reached with no hit, and from the file step
      // below when the file turns out to be another film. `closest` is the
      // film the library holds under a similar title, if any.
      const notInLibrary = async (closest) => {
        const th = await isTheatricalOnly(m, cfg.movieRequests);
        steps.push({
          step: 'why', ok: false,
          detail: th.theatricalOnly
            ? `still in theaters — ${th.reason} (via ${th.source})`
            : `not in the library, and it has had a home release (${th.reason})`,
          reaction: th.theatricalOnly
            ? cfg.movieRequests.reactions.theaters
            : cfg.movieRequests.reactions.notInLibrary,
        });
        if (th.theatricalOnly) return res.json({ steps, verdict: 'not-yet-theatrical' });
        return res.json({
          steps, verdict: 'not-in-library', ...(closest ? { reason: `not in library — ${closestNote(closest)}` } : {}),
        });
      };
      if (!hit) return notInLibrary(otherFilm);

      const copies = hit.sameTitled ?? [];
      // A request's step 4a: what step 0 could not list (its search failed,
      // or only OMDb matched the words typed to the library's title).
      if (cfg.movieRequests.requireYearWhenAmbiguous && !/\b(19|20)\d{2}\b/.test(asked) && copies.length > 1) {
        const years = copies.map((c) => c.year).filter(Boolean).join(', ');
        steps.push({
          step: 'year', ok: false,
          detail: `the server holds ${copies.length} versions (${years}) — the requester must say which`,
          reaction: cfg.movieRequests.reactions.needYear,
        });
        return res.json({ steps, verdict: 'need-year' });
      }

      // The library's own file, when it does not look like the film that was
      // vetted: step 4b of a request (fileGate). The dry run had no such
      // step, so a listed film whose Jellyfin copy carried another year (The
      // Last Samurai as 2006) read "would send" here while a request refused
      // it "rated R (library file)" - and the opposite of what the request
      // does is what the dry run is there to rule out.
      const file = await fileGate({
        store: overrideStore(), movie: m, hit, cfg: mr, override: letter.override, aiMayClear: canClear,
        omdbKey: cfg.omdb.apiKey, log: logger, typedYear: typedYearOf(asked, m),
      });
      const { rc } = file;
      const heldAs = `the server's file, ${hit.title}${hit.year ? ` (${hit.year})` : ''}`;
      if (file.refused === 'blocked-rating') {
        steps.push({ step: 'library file', ok: false, detail: `${heldAs}, is rated ${rc.rated} - blocked`, reaction: mr.reactions.rated });
        return res.json({ steps, verdict: 'blocked-rating', reason: `rated ${rc.rated} (library file)` });
      }
      if (file.refused === 'wrong-film') {
        // A request answers this "not in the library", naming the file as the
        // closest film (the Barefoot fix, 2026-09-29), and so does the dry run.
        steps.push({
          step: 'library file', ok: false,
          detail: `${heldAs}, is "${rc.found?.title}"${rc.found?.year ? ` (${rc.found.year})` : ''}, which isn't the same film`,
        });
        return notInLibrary(rc.found?.title ? { title: rc.found.title, year: rc.found.year ?? null, reason: rc.why } : null);
      }
      if (rc.rechecked) {
        steps.push({
          step: 'library file', ok: true,
          detail: `${heldAs}, looked up again: ${file.movie.title} (${file.movie.year}), rated ${file.movie.rated ?? 'unknown'}`
            + (file.override ? ` — on the bypass list (${describeOverride(file.override)}), so it is sent without the AI check` : ''),
        });
      }
      // The film that is really sent, from here on, as in a request.
      const vetted = file.movie;

      // The last step, against the LIBRARY's film, exactly as the live
      // pipeline takes it (contentGate): the bypass list looked for again
      // with the library's title and id, an unrated film judged as
      // blockUnrated says, and the AI check asked only when its answer could
      // send a film its rating blocks - it never refuses one, the operator's
      // "No, AI only helps" (2026-09-29).
      let bypass = false;
      {
        // A file identified as another film is judged on its own entry and
        // its own rating, never the film asked for's (fileGate): carried
        // over, an entry for "Scarface 1932" sent the R 1983 film.
        const gate = await contentGate({
          store: overrideStore(), movie: vetted, hit, override: file.override,
          ratedBlocked: vetted === m && letter.blocked ? true : null, cfg: mr, gemini: cfg.gemini, ai: cfg.ai,
          // Counted like a real request: a dry run is usually how someone
          // checks a fix to the model or key, and its success should clear the
          // "degraded" warning just as its failure is more evidence for it.
          onResult: (r) => {
            contentHealth?.record({ ...r, title: hit.title ?? m.title, year: hit.year ?? m.year, source: 'dry run' })
              .catch((err) => logger.warn(`content check health: ${err.message}`));
          },
        });
        const { call, verdict } = gate;
        bypass = gate.bypass;
        // Scrubbed as it is kept: the headline below quotes what the
        // provider said back, and goes to the browser.
        const failed = gate.failed ? scrubFailure(gate.failed, configuredKeys(cfg)) : null;
        const didNotRun = failed ? ` (the check did not run: ${describeFailure(failed).headline})` : '';
        const rated = vetted.rated || 'unrated';
        if (gate.bypass) {
          steps.push({ step: 'content', ok: true, detail: `${BYPASS_NOTE} (${describeOverride(gate.override)})` });
        } else if (gate.checked) {
          steps.push({
            step: 'content', ok: !call.blocked,
            // Which provider answered, because a fallback clears a rated film
            // only where the operator ticked it, and the dry run is where an
            // operator checks that.
            detail: (verdict && verdict.nudity !== null
              ? `${verdict.nudity ? 'contains nudity' : 'no nudity'}`
                + ` (confidence ${verdict.confidence})${verdict.basis ? ` — ${verdict.basis}` : ''}`
                + ` — answered by ${providerLabel(verdict.provider)}${verdict.model ? ` (${verdict.model})` : ''}`
              // Say WHY it could not, or "could not determine" reads like
              // the model not knowing the film when it never got asked.
              : `could not determine${didNotRun}`)
              + (call.blocked
                ? `. Not cleared (${notClearedWhy({ verdict, call, failure: failed })}), so rated ${rated} is blocked`
                : `. Cleared: rated ${rated}, but no nudity`),
            reaction: call.blocked ? mr.reactions.rated : null,
          });
        } else if (call.blocked) {
          const g = cfg.gemini ?? {};
          const off = !(g.enabled && g.contentCheck) ? 'the content check is switched off'
            : g.allowCleanRatedFilms !== true ? 'rated films are not cleared by the AI check (Also send rated films and episodes with no nudity is off)'
              // On by default with no key anywhere: AI is not set up (aiCanClear).
              : !anyAiKey({ gemini: g, ai: cfg.ai ?? {} }) ? 'no AI provider has an API key yet'
                : 'no AI provider allowed to clear rated films is switched on';
          steps.push({
            step: 'content', ok: false,
            detail: `${off}, so the rating decides: ${isUnrated(vetted.rated) ? 'unrated films are blocked' : `rated ${vetted.rated} is blocked`}`,
            reaction: mr.reactions.rated,
          });
        }
        if (call.blocked) {
          // The words a request's History row would use.
          return res.json({
            steps,
            verdict: 'blocked-rating',
            reason: `rated ${rated}${gate.checked ? ` — the AI check did not clear it (${notClearedWhy({ verdict, call, failure: failed })})` : ''}`,
          });
        }
      }

      if (hit.size && hit.size > cfg.media.maxOutputBytes) {
        steps.push({
          step: 'size', ok: true,
          detail: `${fmtBytes(hit.size)} is over the ${fmtBytes(cfg.media.maxOutputBytes)} limit - will be re-encoded (this takes time)`,
        });
      }

      res.json({ steps, verdict: 'would-send', ...(bypass ? { reason: BYPASS_NOTE } : {}) });
    } catch (err) {
      steps.push({ step: 'error', ok: false, detail: err.message });
      res.status(200).json({ steps, verdict: 'error' });
    }
  });

  return router;
}
