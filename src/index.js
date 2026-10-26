import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import log from './util/logger.js';
import { ConfigStore } from './config/store.js';
import { StateStore } from './core/state.js';
import { WhatsAppBot, sweepUploadLeftovers, loadBaileys } from './core/bot.js';
import { JobQueue } from './core/queue.js';
import { stageWaits } from './media/stages.js';
import { PluginManager } from './core/plugin-manager.js';
import { createServer, startServer } from './web/server.js';
import { sweepWorkDir, liveWorkDirs, isSafeToDeleteIn } from './media/work-files.js';
import { YtDlpUpdater } from './media/yt-dlp-install.js';
import { noteDiskFull } from './media/disk-space.js';
import { FileLogger } from './util/filelog.js';
import { LockScheduler } from './core/lockdown.js';
import { AlertWatcher } from './core/alerts.js';
import { SpamGuard, spamConfig } from './core/spam-guard.js';
import { ContentCheckHealth } from './core/content-check-health.js';
import { runAdminCommand, backupOriginalDescriptions, auditAdminCommand, answerFor } from './core/admin-commands.js';
import { FailoverSupervisor } from './core/failover.js';
import { SpareLinker } from './core/spare-linker.js';
import { sessionDirFor, activeAccount } from './core/accounts.js';
import { DailyDigest } from './core/daily-digest.js';
import { ActivityBackup } from './core/activity-backup.js';
import { MessageIndex } from './core/message-index.js';
import { MemberActivity } from './core/member-activity.js';
import { LibraryNews } from './core/library-news.js';
import { DiscussionAnswers, runAgent, loadKnowledge, groupDescription, buildTopicPrompt, parseTopic } from './core/discussion-answers.js';
import { createDiscussionTools } from './core/discussion-tools.js';
import { DriveLinks } from './core/drive-links.js';
import { DriveLinksJob } from './core/drive-links-job.js';
import { nextTicket } from './core/issue-tickets.js';
import { createProvider } from './plugins/movie-requests/library.js';
import { chatWithTools, askOpenAiCompatible, PROVIDERS, MODEL_PREFERENCES } from './core/ai-providers.js';
import { newsSettings } from './core/library-news.js';
import { DiscordWatch, NAMESPACE as DISCORD_NS } from './core/discord-watch.js';
import { RequestPause, NAMESPACE as REQUEST_PAUSE_NS, QUEUE_NAMESPACE as QUEUE_PAUSE_NS } from './core/request-pause.js';
import { WantedRecheck } from './core/wanted-recheck.js';
import { ArrivalReruns } from './core/wanted-arrival.js';

const logger = log.scope('main');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');

/**
 * MASTER_KEY encrypts secrets in config.json. Generated once, kept in .env.
 *
 * The file is the authority, not the environment. Reading it directly means
 * that if dotenv ever fails to load (different working directory, a stray
 * .env elsewhere), we still use the key that actually encrypted the stored
 * data rather than silently generating a fresh one and leaving every saved
 * secret undecryptable.
 */
function ensureMasterKey() {
  const envPath = path.join(ROOT, '.env');

  let existing = '';
  if (fs.existsSync(envPath)) existing = fs.readFileSync(envPath, 'utf8');

  const onDisk = existing.match(/^MASTER_KEY=(.+)$/m)?.[1]?.trim();
  if (onDisk) {
    if (process.env.MASTER_KEY && process.env.MASTER_KEY !== onDisk) {
      logger.warn('MASTER_KEY in the environment differs from .env - using .env, which is what encrypted your settings');
    }
    process.env.MASTER_KEY = onDisk;
    return onDisk;
  }

  // Nothing on disk. Adopt an environment-supplied key if there is one
  // (useful for container deployments), otherwise mint a fresh one.
  const key = process.env.MASTER_KEY || crypto.randomBytes(32).toString('hex');
  fs.appendFileSync(envPath, (existing && !existing.endsWith('\n') ? '\n' : '') + `MASTER_KEY=${key}\n`, { mode: 0o600 });
  try { fs.chmodSync(envPath, 0o600); } catch {}
  logger.warn(`wrote MASTER_KEY to ${envPath} - back this file up, it decrypts your saved settings`);

  process.env.MASTER_KEY = key;
  return key;
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const masterKey = ensureMasterKey();

  const configStore = new ConfigStore({ dataDir: DATA_DIR, masterKey });
  const config = configStore.load();
  log.level = { debug: 10, info: 20, warn: 30, error: 40 }[config.logging.level] ?? 20;

  logger.info('----------------------------------------------------------');
  logger.info(' WhatsApp Bot Platform');
  logger.info(`  data dir : ${DATA_DIR}`);
  logger.info(`  work dir : ${config.media.workDir}`);
  logger.info('----------------------------------------------------------');

  // Persistent debug log. Attached before anything else so startup problems
  // are captured too.
  const fileLogger = new FileLogger({
    dir: path.join(DATA_DIR, 'logs'),
    retentionDays: config.logging.retentionDays,
    maxBytes: config.logging.maxFileBytes,
  });
  log.setSink(fileLogger);
  logger.info(`debug log -> ${path.join(DATA_DIR, 'logs')}`);

  const alerts = new AlertWatcher({ configStore, fileLogger });
  alerts.attach();

  const stateStore = new StateStore(path.join(DATA_DIR, 'state.json'));
  const bot = new WhatsAppBot({ configStore, dataDir: DATA_DIR });
  const queue = new JobQueue({
    concurrency: config.media.concurrency,
    maxLength: config.movieRequests.maxQueueLength,
    strictMoviePriority: config.queue?.strictMoviePriority !== false,
    // The fair order, and how long a member's extra film waits behind the TV
    // (the film cooldown): src/core/queue.js, the class comment.
    fairShare: config.queue?.fairShare === true,
    extraFilmHoldMs: (config.movieRequests?.cooldownSecondsPerUser ?? 0) * 1000,
  });
  // So the panel can show, and change, which running job gets the encoder
  // (or the download or upload slot) next.
  queue.setStageWaits(stageWaits);
  // Link lookups are seconds of API calls, not gigabytes of transfer, so they
  // get their own queue: a "#request-movie" must not wait behind a film that
  // is midway through a 20-minute encode. Serial, so a burst of requests paces
  // itself against Jellyfin rather than arriving all at once.
  const linkQueue = new JobQueue({ concurrency: 1, maxLength: 200 });
  // Counts nudity-check failures. A failed check falls back to the rating,
  // which is safe but silent - on 2026-09-22 it failed all morning and nobody
  // was told - so this is what notices and emails.
  const contentHealth = new ContentCheckHealth({ alerts, configStore, stateStore });
  // Requests paused from the panel, and the queue's own Pause, both kept
  // across a restart (src/core/request-pause.js). Put back on the queue now,
  // before any plugin loads and its recovery puts the last process's jobs
  // back in the queue, and so before any message is handled: a restart made
  // with the pause on (tools/pause-requests.mjs) has no moment in which a
  // request runs.
  const requestPause = new RequestPause({
    store: stateStore.namespace(REQUEST_PAUSE_NS), queueStore: stateStore.namespace(QUEUE_PAUSE_NS),
    queue, bot, audit: stateStore.namespace('audit'), getConfig: () => configStore.get(),
  });
  requestPause.restore();
  const pluginManager = new PluginManager({ bot, configStore, queue, linkQueue, stateStore, requestPause, contentHealth });
  requestPause.attach(pluginManager);

  // Remember recent group message keys so a ban can also wipe what they posted
  // (WhatsApp only allows delete-for-everyone for about two days).
  bot.messageIndex = new MessageIndex({ store: stateStore.namespace('msg-index') });
  // Per-member activity counts powering the Members roster.
  bot.memberActivity = new MemberActivity({ store: stateStore.namespace('member-activity') });
  // What the library's keepers say in the discussions group (library-news.js).
  bot.libraryNews = new LibraryNews({
    dataDir: DATA_DIR, configStore,
    groupName: (jid) => bot.groupCache.get(jid)?.subject ?? null,
    // "#group01" -> the group named "01 ...", for a member's #issue report.
    groupByNumber: (n) => {
      for (const [jid, g] of bot.groupCache) {
        const lead = /^\s*0*(\d{1,2})\b/.exec(g?.subject ?? '');
        if (lead && Number(lead[1]) === n) return { jid, name: g.subject };
      }
      return null;
    },
  });

  // A member flooding a group locks it, with one message saying so, until a
  // person reopens it (src/core/spam-guard.js; the operator, 2026-10-21).
  const spamStore = stateStore.namespace('spam-guard');
  bot.spamGuard = new SpamGuard({
    store: spamStore,
    getConfig: () => configStore.get(),
    isAdmin: (jid, senderJid, senderNumber) => bot.isGroupAdmin(jid, { jid: senderJid, number: senderNumber }),
    groupName: (jid) => bot.groupCache.get(jid)?.subject ?? null,
    lock: async (jid, inc) => {
      const who = inc.senders.map((s) => `+${s.sender} (${s.count})`).join(', ');
      logger.warn(`🚨 spam in "${inc.group}": ${inc.why} - locking it. Senders: ${who}`);
      await bot.setGroupLocked(jid, true);
      try {
        await bot.sendText(jid, spamConfig(configStore.get()).notice, { kind: 'critical' });
      } catch (err) { logger.warn(`spam lock notice in "${inc.group}" not sent: ${err.message}`); }
      stateStore.namespace('audit').push('events', {
        ts: Date.now(), user: 'spam-guard', role: 'system',
        action: `locked "${inc.group}" for spam: ${inc.why}; senders ${who}. An admin reopens it.`,
      }, 2000);
      alerts.notify({
        kind: 'spam-lock', throttleMinutes: 0, attachLog: false,
        label: `Spam: "${inc.group}" locked`,
        note: [`The bot locked "${inc.group}" (admins-only) because of spam: ${inc.why}.`, '',
          `Senders in the last minute: ${who}.`, '',
          'Nothing was deleted and nobody was removed. The group stays locked, through havdalah too,',
          'until an admin opens it in WhatsApp or from the panel.'].join('\n'),
      }).catch(() => {});
    },
  });
  bot.on('group-opened', ({ jid, by }) => {
    bot.spamGuard.release(jid, by ? `+${bot.numberFromJid(by) ?? by} (in WhatsApp)` : 'an admin in WhatsApp');
  });

  // Questions in the discussions group: answered when the bot can, else put to
  // the admins (src/core/discussion-answers.js). Off until enabled in settings.
  let knowledge = null;
  // What the agent can look at and do: the library, the request records, and a
  // ticket for the admins (src/core/discussion-tools.js).
  const notifyAdmins = async (text) => {
    const notify = configStore.get().movieRequests?.notify?.group;
    if (!notify) { logger.warn(`no notifications group is set - not posted: ${text.slice(0, 120)}`); return; }
    await bot.sendText(notify, text);
  };
  const tools = createDiscussionTools({
    stateStore, getConfig: () => configStore.get(), createProvider,
    nextTicket: () => nextTicket(DATA_DIR), notify: notifyAdmins,
  });
  bot.discussionAnswers = new DiscussionAnswers({
    getConfig: () => configStore.get(),
    isDiscussion: (jid) => newsSettings(configStore.get()).groups.has(jid)
      || (configStore.get().discussionAnswers?.groups ?? []).includes(jid),
    isChatGroup: (jid) => newsSettings(configStore.get()).groups.has(jid),
    // A reply to one of the bot's messages, or an @-mention of it, is for the bot.
    isAddressed: (msg) => (!!msg.replyTo?.senderJid && bot.isSelf(msg.replyTo.senderJid))
      || (msg.mentionedJids ?? []).some((j) => bot.isSelf(j)),
    // An admin of the group, or a library keeper (Head Admin): answered only when
    // they reply to the bot or @-mention it.
    isAdmin: (msg) => bot.isGroupAdmin(msg.chatJid, { jid: msg.senderJid, number: msg.senderNumber })
      || newsSettings(configStore.get()).senders.has(String(msg.senderNumber ?? '').replace(/\D/g, '')),
    // Is a member's remark on topic? One plain question to the model; a failure
    // or a doubt is "no reminder" (discussion-answers.js _topicCheck).
    topic: async ({ text, replyText }) => {
      const c = configStore.get();
      const key = c.ai?.ollama?.apiKey;
      const model = c.ai?.ollama?.model || MODEL_PREFERENCES.ollama[0];
      if (!key || !model) return { ok: false };
      const r = await askOpenAiCompatible(PROVIDERS.ollama, { key, model, prompt: buildTopicPrompt({ text, replyText }) });
      return r.ok ? { ok: true, onTopic: parseTopic(r.text) } : { ok: false };
    },
    agent: async ({ question, msg, admin }) => {
      const c = configStore.get();
      const key = c.ai?.ollama?.apiKey;
      // Blank means Automatic: the first model Ollama's free credits cover.
      const model = c.ai?.ollama?.model || MODEL_PREFERENCES.ollama[0];
      if (!key || !model) return { ok: false, why: 'no Ollama key or model chosen' };
      knowledge ??= loadKnowledge(path.join(__dirname, '..', 'content'));
      // Outside the discussions group (05), the group's own description is its context.
      const subject = bot.groupCache.get(msg.chatJid)?.subject ?? null;
      const group = newsSettings(c).groups.has(msg.chatJid) ? null
        : { name: subject ?? 'this group', description: groupDescription(path.join(__dirname, '..', 'content'), subject) };
      return runAgent({
        question, knowledge, admin, group,
        chat: ({ messages, tools: specs }) => chatWithTools(PROVIDERS.ollama, { key, model, messages, tools: specs }),
        runTool: tools.forMessage({
          group: msg.chatJid,
          who: msg.pushName ?? msg.senderNumberDisplay ?? 'a member',
          where: bot.groupCache.get(msg.chatJid)?.subject ?? null,
          question: question.slice(0, 200),
        }),
      });
    },
    store: stateStore.namespace('discussion-answers'),
    say: (jid, text, msg) => bot.sendText(jid, text, { quoted: msg }),
    escalate: async (msg, question, why) => {
      const notify = configStore.get().movieRequests?.notify?.group;
      if (!notify) { logger.warn(`a question for the admins has nowhere to go: no notifications group is set ("${question.slice(0, 80)}")`); return; }
      const who = msg.pushName ?? msg.senderNumberDisplay ?? 'a member';
      const where = bot.groupCache.get(msg.chatJid)?.subject ?? msg.chatJid;
      await bot.sendText(notify, `❓ Question for the admins in "${where}" from ${who}: "${question.slice(0, 400)}" (${why})`);
    },
  });

  // The Google Drive Links group's archive: every Drive link posted there is kept,
  // and the document built from it is posted nightly (src/core/drive-links.js).
  bot.driveLinks = new DriveLinks({
    store: stateStore.namespace('drive-links'), getConfig: () => configStore.get(),
  });

  // Route every inbound message through the plugins.
  bot.on('message', (msg) => {
    try { bot.driveLinks.observe(msg); } catch (err) { logger.warn(`drive links: ${err.message}`); }
    try { bot.discussionAnswers.observe(msg); } catch (err) { logger.warn(`discussion answers: ${err.message}`); }
    try { bot.spamGuard.observe(msg); } catch (err) { logger.warn(`spam-guard: ${err.message}`); }
    try { bot.messageIndex.record(msg); } catch (err) { logger.debug(`msg-index: ${err.message}`); }
    try { bot.memberActivity.record(msg); } catch (err) { logger.debug(`member-activity: ${err.message}`); }
    try { bot.libraryNews.record(msg); } catch (err) { logger.debug(`library-news: ${err.message}`); }
    pluginManager.dispatchMessage(msg).catch((err) => logger.error(`dispatch: ${err.message}`));
  });

  // Persist the group admin activity feed (joins/leaves/removals/promotions).
  const activity = stateStore.namespace('group-activity');
  bot.on('group-event', (ev) => {
    activity.push('events', ev, 500);
    const who = ev.actorNumber ? `+${ev.actorNumber}` : (ev.actor ?? 'someone');
    const tgt = ev.targets?.map((t) => t.number ? `+${t.number}` : t.jid).filter(Boolean).join(', ');
    logger.info(`👥 ${ev.groupName}: ${ev.action}${tgt ? ` ${tgt}` : ''}${ev.actor ? ` (by ${who})` : ''}`);
    // Someone joined the Drive Links group: the document goes to them there.
    if (ev.action === 'add') {
      try { bot.driveLinksJob?.onJoin(ev.groupJid, (ev.targets ?? []).map((t) => t.jid).filter(Boolean)); } catch (err) { logger.warn(`drive links join: ${err.message}`); }
    }
  });

  // The work directory, swept before any plugin loads - and so whether or not
  // the movie plugin is on, which used to be the one that did it. What the
  // last process left there for a job either journal still holds is kept:
  // recovery resumes each from where it stopped - the download from the
  // byte it reached, the encode from its last finished piece, a finished
  // film sent as it is. The Parent Trap (2026-09-29), 2.62 GB downloaded and
  // 23 minutes into its encode, was downloaded again from the first byte,
  // twice, because this sweep deleted all of it. Everything else goes.
  const journals = () => ({
    movie: stateStore.namespace('movie-requests').get('pending', []) ?? [],
    tv: stateStore.namespace('tv-requests').get('pending', []) ?? [],
  });
  const isSafeWork = (p) => {
    const c = configStore.get();
    return isSafeToDeleteIn(p, { workDir: c.media.workDir, roots: c.library?.local?.roots ?? [] });
  };
  sweepWorkDir(config.media.workDir, { all: true, live: liveWorkDirs(journals()), isSafe: isSafeWork, log: logger });

  // Load whatever plugins are enabled in config.
  for (const name of config.plugins.enabled) {
    const entry = path.join(__dirname, 'plugins', name, 'index.js');
    if (!fs.existsSync(entry)) {
      logger.error(`plugin "${name}" not found at ${entry}`);
      continue;
    }
    try {
      await pluginManager.load(name, await import(`file://${entry}`));
    } catch (err) {
      logger.error(`could not load plugin "${name}": ${err.message}`);
    }
  }

  // Web control panel first, so a misconfigured bot is still fixable in the UI.
  // Shabbos lockdown scheduler: locks/unlocks all groups on the weekly window.
  const lockState = stateStore.namespace('lockdown');
  const lockScheduler = new LockScheduler({
    getConfig: () => configStore.get().lockdown,
    getState: () => lockState.get('state', { locked: false, source: null, overriddenWindowKey: null }),
    persist: (st) => lockState.set('state', st),
    // Both return the per-group results so the portal can report exactly what
    // happened - "5/9" alone reads as failure when four were deliberate skips.
    applyLock: async (source) => {
      logger.warn(`🔒 locking all groups (${source})`);
      const results = await bot.setAllGroupsLocked(true);
      const sum = results.summary ?? { changed: results.filter((r) => r.ok).length, skipped: 0, failed: 0 };
      lockState.set('state', { ...lockState.get('state', {}), locked: true, source, at: Date.now() });
      stateStore.namespace('audit').push('events', {
        ts: Date.now(), user: `lockdown:${source}`, role: 'system',
        action: `locked ${sum.changed} groups${sum.failed ? `, ${sum.failed} failed` : ''}`,
      }, 2000);
      return results;
    },
    applyUnlock: async (source, overriddenWindowKey = null) => {
      logger.warn(`🔓 unlocking all groups (${source})`);
      const results = await bot.setAllGroupsLocked(false);
      const sum = results.summary ?? { changed: results.filter((r) => r.ok).length, skipped: 0, failed: 0 };
      const prev = lockState.get('state', {});
      lockState.set('state', { ...prev, locked: false, source, overriddenWindowKey: overriddenWindowKey ?? prev.overriddenWindowKey ?? null, at: Date.now() });
      stateStore.namespace('audit').push('events', {
        ts: Date.now(), user: `lockdown:${source}`, role: 'system',
        action: `unlocked ${sum.changed} groups${(sum.alwaysLocked ?? sum.skipped) ? `, ${sum.alwaysLocked ?? sum.skipped} always-locked` : ''}`
          + `${sum.private ? `, ${sum.private} private ($) left alone` : ''}${sum.failed ? `, ${sum.failed} failed` : ''}`,
      }, 2000);
      return results;
    },
  });

  // The Google Drive Links document: nightly at 00:00 New York time, and to
  // members who join; nothing while the groups are locked (drive-links-job.js).
  bot.driveLinksJob = new DriveLinksJob({
    drive: bot.driveLinks, bot, store: stateStore.namespace('drive-links-job'),
    isLocked: () => !!lockState.get('state', {})?.locked,
  });
  bot.driveLinksJob.start();

  // Keeps the bot on the best available number: fails over when the active one
  // dies, and returns to a preferred one only once the queues are idle.
  const failover = new FailoverSupervisor({
    bot, configStore, queues: [queue, linkQueue], stateStore, alerts,
  });
  failover.start();

  // Links a spare number in the background, on a socket of its own, so the bot
  // never has to leave the number it is serving on to link another. Wired to
  // both sides: failover will not switch to a number being linked, and the bot
  // cancels a link for any number it is about to connect as.
  const spareLinker = new SpareLinker({ bot, configStore, failover, loadBaileys });
  failover.linker = spareLinker;
  bot.spareLinker = spareLinker;

  // The once-a-day email. dailySummary has been a setting with nothing behind
  // it; this is what makes the switch do something.
  const digest = new DailyDigest({ configStore, stateStore, alerts, queue });
  digest.start();

  // The permanent record. Runtime state under data/ is capped and rotated, so
  // without this the history of a dispute expires before anyone looks for it.
  const activityBackup = new ActivityBackup({ configStore, stateStore, dataDir: DATA_DIR, alerts });
  activityBackup.start();

  // A film the wanted recheck finds on the server is re-run for every member
  // who was told "not in the library" for it (src/core/wanted-arrival.js;
  // agreed with the operator, 2026-10-11). It has no timer of its own: a pass
  // runs after each run of the recheck - one at a time, each paced, never
  // while WhatsApp is down, requests are paused or the groups are locked.
  const arrivals = new ArrivalReruns({
    configStore, stateStore, bot, pluginManager, requestPause,
    isLocked: () => !!lockState.get('state', {})?.locked,
  });
  // Before the recheck can resolve anything: a film already resolved on the
  // wanted list was resolved before re-runs began on this box, and is left
  // to "Re-run requests" on its card, never re-run by itself. A no-op on
  // every start after the first.
  arrivals.begin();
  const arrivalPass = (why) => { arrivals.process(why).catch(() => {}); };

  // The wanted list, looked up in the library a few minutes after start and
  // every 30 minutes, so a film that is on the server leaves it without
  // anyone having to ask for it again (src/core/wanted-recheck.js), and the
  // members who asked are re-run. The panel's POST /api/wanted/recheck runs
  // the same instance, so the two never overlap.
  const wantedRecheck = new WantedRecheck({ configStore, stateStore, onRun: () => arrivalPass('after the wanted recheck') });
  wantedRecheck.start();

  // The operator's support tickets with the Jellyfin host, read from their
  // own Discord account, read-only, every 30 minutes, for the hourly check
  // (src/core/discord-watch.js). Does nothing until a token is connected in
  // Settings -> Connection -> Discord (read-only).
  const discordWatch = new DiscordWatch({
    dataDir: DATA_DIR, configStore, store: stateStore.namespace(DISCORD_NS), audit: stateStore.namespace('audit'),
  });
  discordWatch.start();

  // yt-dlp, which "Queue a public link" reads YouTube pages with, updated
  // once a day from here and never under one of its own downloads: YouTube
  // breaks an old yt-dlp within weeks (src/media/yt-dlp-install.js; the
  // `yt-dlp-update` routine). Installing it is the `yt-dlp` routine's.
  const ytDlpUpdater = new YtDlpUpdater();
  ytDlpUpdater.start();

  const app = createServer({ configStore, bot, queue, linkQueue, pluginManager, stateStore, fileLogger, alerts, lockScheduler, failover, spareLinker, requestPause, wantedRecheck, discordWatch, arrivals, contentHealth });
  await startServer(app, configStore);
  bot.on('state', (st) => {
    if (st.state !== 'connected') return;
    lockScheduler.start();
    // Requests held by a pause that has since been lifted - in the file a
    // restart left, or a replay WhatsApp dropped part-way - run now, in the
    // order they came. It does nothing while requests are paused, and the
    // replay paces itself, which also lets the plugins' own recovery put the
    // journalled jobs back in the queue first.
    if (!requestPause.isPaused() && requestPause.heldCount()) {
      requestPause.replay().catch((err) => logger.error(`held requests: ${err.message}`));
    }
    // Preserve original group descriptions the first time we see them, so a
    // later bulk rewrite never destroys the pre-edit text. Delay a little so
    // the first group refresh (which populates descriptions) has landed.
    setTimeout(() => {
      try {
        const r = backupOriginalDescriptions(bot, DATA_DIR);
        if (r.newlyBackedUp) logger.info(`backed up ${r.newlyBackedUp} original group description(s)`);
      } catch (err) { logger.warn(`description backup failed: ${err.message}`); }
    }, 10_000);
  });

  // --- local admin command channel -----------------------------------------
  // An operator on the box drops data/bot-cmd.json ({ op, ... }); we run it and
  // write data/bot-cmd.result.json. Local files only, whitelisted ops only.
  // One command at a time (cmdBusy): a `requeue` can wait out OMDb's retries
  // for up to two minutes (omdb.js), and the next command waits with it, so
  // each answer names the command it is to (answerFor).
  const CMD_FILE = path.join(DATA_DIR, 'bot-cmd.json');
  const CMD_RESULT = path.join(DATA_DIR, 'bot-cmd.result.json');
  let cmdBusy = false;
  const cmdPoll = setInterval(async () => {
    if (cmdBusy || !fs.existsSync(CMD_FILE)) return;
    cmdBusy = true;
    let cmd = null;
    try {
      cmd = JSON.parse(fs.readFileSync(CMD_FILE, 'utf8'));
      try { fs.unlinkSync(CMD_FILE); } catch {}
      const result = await runAdminCommand(cmd, { bot, dataDir: DATA_DIR, stateStore, configStore, queue, linkQueue, pluginManager, requestPause });
      fs.writeFileSync(CMD_RESULT, JSON.stringify(answerFor(cmd, result), null, 2));
      logger.info(`admin-cmd ${cmd.op}: ok`);
      auditAdminCommand(stateStore, cmd, result);
    } catch (err) {
      try { fs.writeFileSync(CMD_RESULT, JSON.stringify(answerFor(cmd, { ok: false, error: err.message }), null, 2)); } catch {}
      logger.error(`admin-cmd ${cmd?.op ?? '(unparsed)'}: ${err.message}`);
      auditAdminCommand(stateStore, cmd, null, err);
    } finally { cmdBusy = false; }
  }, 3000);
  cmdPoll.unref();

  // Re-apply settings that changed in the UI without a restart.
  configStore.onChange((cfg) => {
    queue.concurrency = cfg.media.concurrency;
    queue.maxLength = cfg.movieRequests.maxQueueLength;
    const strict = cfg.queue?.strictMoviePriority !== false;
    if (strict !== queue.strictMoviePriority) {
      queue.strictMoviePriority = strict;
      // It reorders the waiting line, so the panel and every place-in-line
      // reaction are told now rather than at the next queue event.
      queue.emit('state', queue.snapshot());
    }
    // Tells the panel and the place-in-line reactions itself when it changes.
    queue.setFairShare({
      fairShare: cfg.queue?.fairShare === true,
      extraFilmHoldMs: (cfg.movieRequests?.cooldownSecondsPerUser ?? 0) * 1000,
    });
    log.level = { debug: 10, info: 20, warn: 30, error: 40 }[cfg.logging.level] ?? 20;
  });

  // Auto-connect only if a session already exists; a fresh install waits for
  // the operator to press Link in the UI.
  // The ACTIVE account's directory, not the default one. Hardcoding
  // data/session meant that after a restart on any other number the bot
  // looked at the wrong folder, decided it had never been linked, and sat
  // offline - even with a perfectly good session for the number in use.
  // Exactly what happened here: default was wiped by a logout while
  // christopher-nolan, fully linked, was the account actually selected.
  // Resolved exactly as bot.start() resolves it, so this check looks in the
  // folder the bot will actually use. `activeAccount ?? 'default'` only worked
  // by accident: a new install's activeAccount is '', which sessionDirFor()
  // happens to read as data/session. That is wrong as soon as the first
  // account is not 'default'.
  const sessionDir = sessionDirFor(DATA_DIR, activeAccount(configStore.get(), DATA_DIR).id);
  const hasSession = fs.existsSync(sessionDir) && fs.readdirSync(sessionDir).length > 0;
  if (hasSession) {
    logger.info('existing session found, connecting');
    bot.start().catch((err) => logger.error(`auto-connect failed: ${err.message}`));
  } else {
    logger.info('no session yet - open the control panel and link your number');
  }

  // Periodic housekeeping of abandoned work files: anything no journal holds
  // that has not changed for six hours, which is also how long a finished
  // film stays when the operator keeps local copies (media.deleteAfterSend
  // off). A journalled job's work is kept however old it is. Baileys'
  // encrypted upload copies live in the temp directory instead, and only a
  // process that died mid-send leaves one: they are cleared once, now (see
  // sweepUploadLeftovers).
  sweepUploadLeftovers(os.tmpdir());
  const sweeper = setInterval(() => sweepWorkDir(config.media.workDir, {
    olderThanMs: 6 * 3600_000, live: liveWorkDirs(journals()), isSafe: isSafeWork, log: logger,
  }), 3600_000);
  sweeper.unref();

  const shutdown = async (signal) => {
    logger.info(`${signal} received, shutting down`);
    clearInterval(sweeper);
    wantedRecheck.stop();
    discordWatch.stop();
    ytDlpUpdater.stop();
    queue.close();              // the fair order's hold timer
    try { await pluginManager.unloadAll(); } catch {}
    try { await spareLinker.cancelAll(); } catch {}
    try { await bot.stop(); } catch {}
    stateStore.flush();
    fileLogger.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (err) => {
    logger.error(`unhandled rejection: ${err?.message ?? err}`, { stack: err?.stack });
  });
  process.on('uncaughtException', (err) => {
    logger.error(`uncaught exception: ${err?.message ?? err}`, { stack: err?.stack });
    // Baileys' write of an upload's encrypted copy has no error handler, so
    // a full disk under an upload lands here (20:34:47 UTC on 2026-09-28,
    // "Minority Report") and nowhere near the upload, which goes on with the
    // cut-short copy. Noted, so the upload's eventual failure is known for
    // what it is (bot.js sendDocument) and waited out rather than final.
    if (err?.code === 'ENOSPC') noteDiskFull();
  });
}

main().catch((err) => {
  console.error('fatal startup error:', err);
  process.exit(1);
});
