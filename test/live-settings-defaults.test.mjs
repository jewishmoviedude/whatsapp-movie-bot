/* The operator's live settings are the defaults, and what they switch on
   waits quietly on a new install. Run: node test/live-settings-defaults.test.mjs

   The operator (2026-10-12): "I just updated most of the settings, please set
   these in the repo coding as default". So the panel's live values became
   DEFAULT_CONFIG: the fast encode, debug logging, a 180-day theatrical
   window, the AI checks and every provider, the three beta features On,
   email with error alerts and a midnight summary, TV with its prefix, direct
   links, the lockdown and failover. What is the install's own - groups, keys,
   accounts, numbers, the rules text and its "yourmom" command - and the two
   kept on purpose (the 15-minute idle sign-out and markOnline off) were not.

   Switched on by default, each of those parts is on in every new install
   before anyone has set it up, and each has to be harmless there. Before
   this, on a new install: the daily summary was due every minute, failed for
   want of an address and said so twice a minute; the first Motzei Shabbos
   would have opened every admin-only group, nothing being always-locked;
   every outage on the only number logged an error and emailed "DOWN - no
   spare number available"; the third rated film raised the nudity-check
   alert for a check with no key; and every start warned that direct links,
   with no group, had no key. Each case below pins the quiet version, and
   that a config saved with the old values keeps them.

   Then, before it shipped:
   - media.deleteAfterSend stayed on. The live config.json held false, but
     not by the operator's choice: a broken panel save wrote it, with other
     settings, at 21:00:29 UTC on 2026-10-12, and every film before then had
     logged "cleaned up … of working files".
   - A review found five more, each pinned below. With an account saved that
     cannot send, the midnight summary was due all day and tried, and failed,
     once a minute: about 1,440 failed SMTP logins a day. The lockdown's hold
     stopped the Shabbos lock on every install with nothing always-locked,
     including one that had switched it on itself, with groups that are all
     normally open, before it was the default: on 2026-10-16's candle-lighting
     the code before this locked the groups and this did not. An install that
     had never saved the Beta tab - beta.features: {} - had all three features
     switched On in every group by the upgrade, where every other changed
     default kept the install's saved value; the operator runs a second bot
     from this repo. (The panel's two, the fresh-install checklist with only
     a fallback AI key and the "leave this off" hint, are in
     fresh-install-checklist and ai-key-test-panel.) */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import log from '../src/util/logger.js';
import { DEFAULT_CONFIG, mergeDefaults, getPath, setPath } from '../src/config/schema.js';
import { ConfigStore } from '../src/config/store.js';
import { emailReady } from '../src/util/mailer.js';
import { AlertWatcher } from '../src/core/alerts.js';
import { DailyDigest } from '../src/core/daily-digest.js';
import { LockScheduler, lockWindow, scheduleHeld } from '../src/core/lockdown.js';
import { FailoverSupervisor } from '../src/core/failover.js';
import { sessionDirFor } from '../src/core/accounts.js';
import { FEATURES, featureMode, isEnabled, isBetaGroup } from '../src/core/beta.js';
import { anyAiKey } from '../src/core/ai-providers.js';
import { aiCanClear } from '../src/plugins/movie-requests/content-check.js';
import { identifyTitle } from '../src/plugins/movie-requests/gemini.js';
import directLinks from '../src/plugins/direct-links/index.js';
import tvPlugin from '../src/plugins/tv-requests/index.js';
import express from 'express';
import { createApiRouter } from '../src/web/api.js';
import { JobQueue } from '../src/core/queue.js';
import { hashPassword } from '../src/util/crypto.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

// Every line, debug included, so "nothing louder than debug" can be checked.
log.level = 10;
const lines = [];
log.on('line', (e) => lines.push(e));
const loud = (from = 0) => lines.slice(from).filter((e) => e.level === 'warn' || e.level === 'error');
const fresh = () => structuredClone(DEFAULT_CONFIG);
const store = (cfg) => ({ get: () => cfg });

/** [path, the default before 2026-10-12, the operator's live value and the default now] */
const CHANGED = [
  ['media.encodeProfile', 'balanced', 'fast'],
  ['media.preset', 'veryfast', 'ultrafast'],
  ['logging.level', 'info', 'debug'],
  ['movieRequests.theatrical.windowDays', 90, 180],
  ['gemini.enabled', false, true],
  ['gemini.contentCheck', false, true],
  ['gemini.allowCleanRatedFilms', false, true],
  ['ai.groq.enabled', false, true],
  ['ai.groq.canClearRated', false, true],
  ['ai.cerebras.enabled', false, true],
  ['ai.cerebras.canClearRated', false, true],
  ['ai.mistral.enabled', false, true],
  ['ai.openrouter.enabled', false, true],
  ['ai.openrouter.canClearRated', false, true],
  ['beta.features.tv-rating-notice', undefined, 'on'],
  ['beta.features.movie-duplicate-notice', undefined, 'on'],
  ['beta.features.tv-duplicate-notice', undefined, 'on'],
  ['email.enabled', false, true],
  ['email.onError', false, true],
  ['email.dailySummary', false, true],
  ['email.dailySummaryHour', 8, 0],
  ['email.onContentCheck', true, false],
  ['tvRequests.enabled', false, true],
  ['tvRequests.requirePrefix', false, true],
  ['directLinks.enabled', false, true],
  ['lockdown.enabled', false, true],
  ['whatsapp.failover.enabled', false, true],
];
// beta.features keys hold dashes, which getPath splits only on dots.
const at = (cfg, p) => (p.startsWith('beta.features.') ? cfg.beta?.features?.[p.slice(14)] : getPath(cfg, p));

console.log('=== the operator\'s live settings are the defaults ===');
{
  const off = CHANGED.filter(([p, , now]) => at(DEFAULT_CONFIG, p) !== now);
  ok(!off.length, `every one of the ${CHANGED.length} is the operator's value${off.length ? ` - not: ${off.map(([p]) => p).join(', ')}` : ''}`);
  ok(DEFAULT_CONFIG.ai.mistral.canClearRated === false && DEFAULT_CONFIG.ai.gemini.canClearRated === true,
    'Mistral clears nothing and Gemini may, as on the live box');
  ok(Object.keys(DEFAULT_CONFIG.beta.features).sort().join() === FEATURES.map((f) => f.key).sort().join(),
    'the beta defaults name exactly the features in the registry, no retired key');
}

console.log('=== what is the install\'s own, or kept on purpose, is not ===');
{
  const d = DEFAULT_CONFIG;
  ok(d.web.idleTimeoutMinutes === 15, 'the idle sign-out stays 15 minutes: never signing out is not a default to hand a new install');
  ok(d.whatsapp.markOnline === false, 'markOnline stays off (docs/whatsapp-ban-risk.md)');
  // The live false was written by a broken panel save at 21:00:29 UTC on
  // 2026-10-12, not chosen: every film before it was cleaned up after sending.
  ok(d.media.deleteAfterSend === true,
    'deleteAfterSend stays on: the live config\'s false was a broken save\'s, not the operator\'s setting');
  ok(d.movieRequests.rulesCommand === '#rules' && d.movieRequests.rules === '', 'the rules command and text are the install\'s own');
  ok(!d.movieRequests.requestGroups.length && !d.movieRequests.postsGroup && !d.tvRequests.requestGroups.length
    && !d.tvRequests.postsGroups.length && !d.directLinks.groups.length && !d.beta.groups.length
    && !d.lockdown.alwaysLocked.length && !d.libraryNews.groups.length && !d.libraryNews.senders.length,
  'no group of any kind');
  ok(!d.whatsapp.accounts.length && !d.whatsapp.phoneNumber && !d.whatsapp.failover.order.length, 'no number, no failover order');
  ok(!d.email.user && !d.email.to && !d.email.appPassword && !d.gemini.apiKey && !d.ai.groq.apiKey && !d.omdb.apiKey
    && !d.library.jellyfin.baseUrl && !d.discord.token && !d.discord.watch.guilds.length && d.discord.watch.channelPattern === '^ticket-',
  'no account, key, server or Discord watch');
  ok(!d.bannedNumbers.length && d.media.workDir === '', 'no banned numbers, and the work directory is found at first start');
}

console.log('=== a config saved with the old values keeps them; a new install gets the new ===');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-defaults-'));
  try {
    const saved = { media: { workDir: path.join(dir, 'media') } };
    for (const [p, before] of CHANGED) {
      if (before === undefined) continue;
      const keys = p.split('.');
      let o = saved;
      for (const k of keys.slice(0, -1)) o = (o[k] ??= {});
      o[keys.at(-1)] = before;
    }
    // A beta mode the panel saved Off, as it saves every mode it shows.
    saved.beta = { features: { 'tv-rating-notice': 'off', 'movie-duplicate-notice': 'off', 'tv-duplicate-notice': 'off' } };
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(saved));
    const old = new ConfigStore({ dataDir: dir, masterKey: 'k'.repeat(64) }).load();
    const moved = CHANGED.filter(([p, before]) => (before === undefined ? at(old, p) !== 'off' : at(old, p) !== before));
    ok(!moved.length, `every saved value stays the operator's${moved.length ? ` - overridden: ${moved.map(([p]) => p).join(', ')}` : ''}`);

    // A new install: no config.json until its first start writes one.
    fs.rmSync(path.join(dir, 'config.json'));
    const none = new ConfigStore({ dataDir: dir, masterKey: 'k'.repeat(64) }).load();
    const notNew = CHANGED.filter(([p, , now]) => at(none, p) !== now);
    ok(!notNew.length, `a new install gets every new default, the three beta features On included${notNew.length ? ` - not: ${notNew.map(([p]) => p).join(', ')}` : ''}`);
    const again = new ConfigStore({ dataDir: dir, masterKey: 'k'.repeat(64) }).load();
    const lost = CHANGED.filter(([p, , now]) => at(again, p) !== now);
    ok(!lost.length && JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).beta.features['tv-rating-notice'] === 'on',
      `and its first start writes them, so its next start is not taken for an upgrade${lost.length ? ` - lost: ${lost.map(([p]) => p).join(', ')}` : ''}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

console.log('=== an upgrade from before 2026-10-12 changes nothing: features it never switched on stay Off ===');
{
  // Review finding: every changed default but one kept an existing install's
  // saved value. beta.features is a map the panel writes only when the Beta
  // tab is saved, so an install that never saved it holds {}, and the new
  // 'on' defaults filled it: the upgrade switched three features on in every
  // group, the main ones included. The operator runs a second bot from this
  // repo, on another number and machine.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-defaults-up-'));
  const file = path.join(dir, 'config.json');
  const load = () => new ConfigStore({ dataDir: dir, masterKey: 'k'.repeat(64) }).load();
  try {
    // The config.json the code before this wrote: every default as it was
    // then, which is what each of its starts saved.
    const before = structuredClone(DEFAULT_CONFIG);
    for (const [p, was] of CHANGED) if (!p.startsWith('beta.features.')) setPath(before, p, was);
    before.beta.features = {};
    delete before.lockdown.alwaysLockedReviewed;
    before.media.workDir = path.join(dir, 'media');
    before.web.sessionSecret = 's'.repeat(64);
    fs.writeFileSync(file, JSON.stringify(before));

    const mark = lines.length;
    const up = load();
    const moved = CHANGED.filter(([p, was]) => (was === undefined ? featureMode(up, p.slice(14)) !== 'off' : at(up, p) !== was));
    ok(!moved.length, `every setting the defaults changed keeps what it had, the three features Off included${moved.length ? ` - changed: ${moved.map(([p]) => p).join(', ')}` : ''}`);
    ok(FEATURES.every((f) => !isEnabled(up, f.key, 'req@g.us')), 'so the upgrade switches no feature on in a main group');
    const said = lines.slice(mark).filter((e) => /kept what this install chose/.test(e.msg));
    ok(said.length === 1 && said[0].level === 'info' && FEATURES.every((f) => said[0].msg.includes(f.key)),
      `said once, at info, naming each: "${said[0]?.msg ?? ''}"`);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8')).beta.features;
    ok(FEATURES.every((f) => onDisk[f.key] === 'off'), 'and written to config.json, so the Beta tab shows them Off');
    const again = lines.length;
    const next = load();
    ok(FEATURES.every((f) => featureMode(next, f.key) === 'off') && !lines.slice(again).some((e) => /kept what this install chose/.test(e.msg)),
      'the next start finds nothing to keep, and they are still Off');

    // A mode the file names was chosen, whatever it is: the operator's own
    // box, which saved all three On, keeps them On.
    fs.writeFileSync(file, JSON.stringify({ ...before, beta: { ...before.beta, features: { 'tv-rating-notice': 'on', 'movie-duplicate-notice': 'beta' } } }));
    const named = load();
    ok(featureMode(named, 'tv-rating-notice') === 'on' && featureMode(named, 'movie-duplicate-notice') === 'beta'
      && featureMode(named, 'tv-duplicate-notice') === 'off', 'a mode the file names stands, On included; the one it does not is Off');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

console.log('=== beta: on a new install the three features are On everywhere, with no beta group ===');
{
  const cfg = mergeDefaults({ movieRequests: { requestGroups: ['req@g.us'] } });
  ok(FEATURES.every((f) => featureMode(cfg, f.key) === 'on' && isEnabled(cfg, f.key, 'req@g.us')),
    'each is On in a main group');
  ok(!isBetaGroup(cfg, 'req@g.us') && !isBetaGroup(cfg, 'any@g.us'), 'and no group is a beta group');
}

console.log('=== email: on with no account tries nothing and says nothing ===');
{
  const cfg = fresh();
  ok(cfg.email.enabled === true && emailReady(cfg.email) === false, 'on by default, and not ready without an account');
  ok(emailReady({ ...cfg.email, user: 'me@gmail.com', appPassword: 'pw' }) === true, 'ready once an address and an app password are saved');
  ok(emailReady({ ...cfg.email, provider: 'custom', user: 'me@x.org', appPassword: 'pw' }) === false
    && emailReady({ ...cfg.email, provider: 'custom', host: 'smtp.x.org', user: 'me@x.org', appPassword: 'pw' }) === true,
  'custom SMTP needs its host as well');

  const mark = lines.length;
  const alerts = new AlertWatcher({ configStore: store(cfg), fileLogger: { today: () => 'LOG' } });
  let delivered = 0;
  alerts._deliver = async () => { delivered += 1; };
  const r = await alerts.notify({ kind: 'failover-stuck', label: 'DOWN', note: 'x' });
  ok(r.sent === false && r.why === 'email is not set up' && delivered === 0, `an event email is not tried ("${r.why}")`);
  alerts.onError({ level: 'error', scope: 'x', msg: 'boom', ts: new Date().toISOString() });
  ok(alerts.lastSent === 0 && alerts.suppressed.length === 0, 'nor is an error alert');

  const asked = [];
  const digestState = (() => { const d = {}; return { namespace: () => ({ get: (k, v) => d[k] ?? v, set: (k, v) => { d[k] = v; }, push() {} }) }; })();
  const digest = new DailyDigest({ configStore: store(cfg), stateStore: digestState, alerts: { notify: async (m) => { asked.push(m); return { sent: false, why: 'email is not set up' }; } } });
  let due = 0;
  for (let h = 0; h < 24; h++) if (await digest.tick(new Date(2026, 9, 13, h, 1).getTime())) due += 1;
  ok(due === 0 && asked.length === 0, 'the midnight summary is never due, so nothing is built or tried all day');
  ok(loud(mark).length === 0, `and nothing louder than info was logged${loud(mark).length ? `: ${loud(mark)[0].msg}` : ''}`);

  cfg.email.user = 'me@gmail.com'; cfg.email.appPassword = 'pw';
  await digest.tick(new Date(2026, 9, 13, 0, 5).getTime());
  ok(asked.length === 1 && asked[0].kind === 'daily-digest', 'set up, the summary goes at midnight, the new default hour');
}

console.log('=== email: an account that cannot send is tried every half hour, not every minute ===');
{
  // Review finding: emailReady asks only that an address and a password are
  // saved, not that they work. A normal Gmail password where an app password
  // belongs, or a box whose SMTP port is blocked, and the summary - due all
  // day from midnight - was tried on every minute's check: reproduced as one
  // error and two warn lines a minute, about 1,440 failed logins a day.
  const cfg = fresh();
  Object.assign(cfg.email, { user: 'me@gmail.com', appPassword: 'my-normal-password' });
  const alerts = new AlertWatcher({ configStore: store(cfg), fileLogger: { today: () => 'LOG' } });
  let tries = 0;
  let accepted = false;
  alerts._deliver = async () => {
    tries += 1;
    if (!accepted) throw new Error('Invalid login: 535-5.7.8 Username and Password not accepted');
  };
  const d = {};
  const stateStore = { namespace: () => ({ get: (k, v) => d[k] ?? v, set: (k, v) => { d[k] = v; }, push() {} }) };
  const digest = new DailyDigest({ configStore: store(cfg), stateStore, alerts });
  const minute = (m) => new Date(2026, 9, 13, 0, 1 + m).getTime();
  const mark = lines.length;
  for (let m = 0; m < 30; m++) await digest.tick(minute(m));
  ok(tries === 1, `thirty minutes of checks from midnight try the account once, not on every one (${tries})`);
  const warned = loud(mark).filter((e) => e.scope === 'digest');
  ok(warned.length === 1 && /will retry in 30 minutes, or as soon as the email settings change/.test(warned[0].msg),
    `and say so once: "${warned[0]?.msg ?? ''}"`);
  await digest.tick(minute(30));
  ok(tries === 2, 'half an hour on it is tried again, so the summary still goes the same day');
  cfg.email.appPassword = 'abcd efgh ijkl mnop';
  accepted = true;
  ok(await digest.tick(minute(31)) === true && tries === 3, 'an app password saved meanwhile is tried at the next check, and it goes');
  await digest.tick(minute(32));
  ok(tries === 3, 'and once sent, not again that day');
}

console.log('=== the lockdown: on a new install, nothing is locked until the always-locked list is looked at ===');
{
  const cfg = fresh().lockdown;
  ok(cfg.enabled === true && scheduleHeld(cfg) === 'no-always-locked', 'on by default, and held: nothing is always-locked');
  // A time inside a window: an hour after the next candle-lighting.
  const win = lockWindow(new Date('2026-10-14T12:00:00Z'), cfg);
  const inside = new Date(win.lockAt.getTime() + 3600_000);
  let state = { locked: false, source: null, overriddenWindowKey: null };
  const acts = [];
  const sch = new LockScheduler({
    getConfig: () => cfg, getState: () => state, persist: (s) => { state = s; },
    applyLock: async (src) => { acts.push(`lock:${src}`); state = { ...state, locked: true, source: src }; },
    applyUnlock: async (src) => { acts.push(`unlock:${src}`); state = { ...state, locked: false, source: src }; },
  });
  const mark = lines.length;
  for (let i = 0; i < 30; i++) await sch.tick(new Date(inside.getTime() + i * 60_000));
  ok(acts.length === 0 && !state.locked, 'thirty ticks inside the window lock nothing, so havdalah opens nothing');
  const said = lines.slice(mark).filter((e) => /not locking the groups/.test(e.msg));
  ok(said.length === 1 && said[0].level === 'info', `said once a window, at info, not every minute (${said.length})`);
  ok(sch.status(inside).held === 'no-always-locked', 'and the panel is told why (status().held)');

  cfg.alwaysLocked = ['posts@g.us'];
  await sch.tick(inside);
  ok(acts.join() === 'lock:schedule', 'with a group always-locked, the schedule locks as it always did');
  cfg.alwaysLocked = [];
  await sch.tick(new Date(win.unlockAt.getTime() + 3600_000));
  ok(acts.join() === 'lock:schedule,unlock:schedule', 'and a lock the schedule made is still undone at havdalah');
  ok(scheduleHeld({ ...cfg, enabled: false }) === null, 'off, nothing is held: there is nothing to hold');
  ok(scheduleHeld({ ...cfg, alwaysLockedReviewed: true }) === null,
    'nor once somebody has saved the list empty: none of their groups is admins-only for good');
}

console.log('=== the lockdown: an install that switched it on itself still locks, nothing always-locked ===');
{
  // Review finding: the hold first stopped the schedule on every install
  // with nothing always-locked. One that had ticked the lockdown on before it
  // was the default, its groups all normally open, was no longer locked over
  // Shabbos: for the 2026-10-16 candle-lighting window the code before this
  // locked the groups and the hold did not, and only ticking a group - which
  // then stays shut for good - brought it back.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-defaults-ld-'));
  const file = path.join(dir, 'config.json');
  const load = () => new ConfigStore({ dataDir: dir, masterKey: 'k'.repeat(64) }).load();
  try {
    const { alwaysLockedReviewed, ...lockdownBefore } = DEFAULT_CONFIG.lockdown;
    fs.writeFileSync(file, JSON.stringify({ media: { workDir: path.join(dir, 'media') },
      lockdown: { ...lockdownBefore, enabled: true, alwaysLocked: [] } }));
    const cfg = load().lockdown;
    ok(cfg.alwaysLockedReviewed === true && scheduleHeld(cfg) === null, 'its config.json counts as looked at: not held');
    ok(JSON.parse(fs.readFileSync(file, 'utf8')).lockdown.alwaysLockedReviewed === true, 'and says so in the file from then on');

    const win = lockWindow(new Date('2026-10-16T12:00:00Z'), cfg);
    ok(win.lockAt.toISOString().startsWith('2026-10-16T21:'), `the window is Friday 2026-10-16's (${win.lockAt.toISOString()})`);
    let state = { locked: false, source: null, overriddenWindowKey: null };
    const acts = [];
    const sch = new LockScheduler({
      getConfig: () => cfg, getState: () => state, persist: (s) => { state = s; },
      applyLock: async (src) => { acts.push(`lock:${src}`); state = { ...state, locked: true, source: src }; },
      applyUnlock: async (src) => { acts.push(`unlock:${src}`); state = { ...state, locked: false, source: src }; },
    });
    await sch.tick(new Date(win.lockAt.getTime() + 60_000));
    ok(acts.join() === 'lock:schedule' && state.locked, 'a minute after candle-lighting it locks the groups, as before');
    await sch.tick(new Date(win.unlockAt.getTime() + 60_000));
    ok(acts.join() === 'lock:schedule,unlock:schedule', 'and opens them at havdalah');

    // One saved off is off, and has chosen nothing about the list: switched
    // on later, it is switched on with the card, whose Save says so (below).
    fs.writeFileSync(file, JSON.stringify({ media: { workDir: path.join(dir, 'media') }, lockdown: { ...lockdownBefore, enabled: false } }));
    const off = load().lockdown;
    ok(off.enabled === false && off.alwaysLockedReviewed === false, 'one saved off stays off, its list not counted as looked at');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

console.log('=== the panel: the lockdown card\'s Save is the look, and the AI card knows each default ===');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-defaults-api-'));
  const cs = new ConfigStore({ dataDir: dir, masterKey: 'k'.repeat(64) });
  cs.load();
  cs.update({ web: { admins: [{ username: 'mommy', role: 'superadmin', passwordHash: hashPassword('x-password-1') }] } });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { user: { username: 'mommy', role: 'superadmin' } }; next(); });
  const queue = new JobQueue({ concurrency: 1 });
  queue.pause();
  const spaces = new Map();
  const stateStore = { namespace: (n) => {
    if (!spaces.has(n)) spaces.set(n, {});
    const sp = spaces.get(n);
    return { get: (k, v) => sp[k] ?? v, set: (k, v) => { sp[k] = v; }, push: (k, v) => { (sp[k] ??= []).unshift(v); } };
  } };
  app.use('/api', createApiRouter({
    configStore: cs, bot: { groupCache: new Map(), groups: () => [], on: () => {}, state: 'connected' },
    queue, linkQueue: queue, pluginManager: { plugins: new Map(), notifyConfigChange: async () => {}, list: () => [] },
    stateStore, fileLogger: { tail: () => [] }, alerts: {}, lockScheduler: {},
  }));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const call = async (method, p, body) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${p}`, {
      method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  try {
    ok(scheduleHeld(cs.get().lockdown) === 'no-always-locked', 'a new install waits');
    const other = await call('PUT', '/api/config', { logging: { level: 'info' } });
    ok(other.status === 200 && scheduleHeld(cs.get().lockdown) === 'no-always-locked', 'and a Save of any other card does not change that');
    // What the lockdown card's Save sends (lock-save in app.js), nothing ticked.
    const saved = await call('PUT', '/api/config', { lockdown: { enabled: true, candleCity: 'new-york', havdalahCity: 'jerusalem',
      candleMinutes: 18, havdalahMinutes: 20, yomTov: true, alwaysLocked: [] } });
    ok(saved.status === 200 && cs.get().lockdown.alwaysLockedReviewed === true && scheduleHeld(cs.get().lockdown) === null,
      'saving the lockdown card as it is starts the schedule, every group locked and opened');

    // The "May clear rated films" hint is worded by each provider's default.
    const view = await call('GET', '/api/ai/providers');
    const want = { gemini: true, groq: true, cerebras: true, mistral: false, openrouter: true, ollama: false };
    ok(view.status === 200 && view.json.providers.length === 6 && view.json.providers.every((p) => p.clearsByDefault === want[p.id]),
      `the AI card is told which providers clear rated films by default (${view.json?.providers?.map((p) => `${p.id}:${p.clearsByDefault}`).join(', ')})`);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log('=== failover: on with one number stands aside ===');
{
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-defaults-fo-'));
  try {
    fs.mkdirSync(sessionDirFor(dataDir, 'default'), { recursive: true });
    fs.writeFileSync(path.join(sessionDirFor(dataDir, 'default'), 'creds.json'), '{}');
    const bot = Object.assign(new EventEmitter(), { dataDir, state: 'connected', start: async () => {}, stop: async () => {} });
    const cfg = fresh();
    const notified = [];
    const sup = new FailoverSupervisor({ bot, configStore: store(cfg), alerts: { notify: async (m) => { notified.push(m); return { sent: true }; } } });
    sup.start();
    const mark = lines.length;
    bot.emit('state', { state: 'connecting', reconnectAttempts: 12 });
    bot.emit('state', { state: 'stopped', lastError: 'disconnected: loggedOut' });
    ok(await sup.failover('the connection dropped') === null, 'nothing to move to');
    await new Promise((r) => setTimeout(r, 20));
    ok(sup.health.size === 0, 'the only number is not marked failed');
    ok(notified.length === 0, 'nothing is emailed: no "DOWN - no spare number available" about spares nobody set up');
    ok(loud(mark).length === 0, `and nothing is logged as a warning or an error${loud(mark).length ? `: ${loud(mark)[0].msg}` : ''}`);

    // A spare that is set up but not linked is a failover with nowhere to
    // go, and that is still said loudly.
    cfg.whatsapp.accounts = [{ id: 'default', label: 'Main', phoneNumber: '15550000001' }, { id: 'spare', label: 'Spare', phoneNumber: '15550000002' }];
    const before = lines.length;
    ok(await sup.failover('the connection dropped') === null, 'with an unlinked spare there is still nowhere to go');
    ok(loud(before).some((e) => e.level === 'error' && /no healthy spare/.test(e.msg)) && notified.some((m) => m.kind === 'failover-stuck'),
      'but now it is an error, and the "DOWN" email');
    sup.stop();
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
}

console.log('=== the AI checks: on with no key ask nothing ===');
{
  const cfg = fresh();
  ok(!anyAiKey({ gemini: cfg.gemini, ai: cfg.ai }), 'no key for any provider');
  ok(aiCanClear(cfg.gemini, cfg.ai) === false, 'so a rated film is not sent to the nudity check: it is refused on its rating, as with the check off');
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error('no network in tests'); };
  const mark = lines.length;
  try {
    ok(await identifyTitle('the one where the dream has a dream in it', cfg.gemini, { ai: cfg.ai }) === null && calls === 0,
      'and the film lookup asks nobody');
  } finally { globalThis.fetch = realFetch; }
  ok(loud(mark).length === 0 && lines.slice(mark).some((e) => e.level === 'debug' && /no AI provider has an API key/.test(e.msg)),
    'saying why at debug, not as a warning on every film OMDb cannot find');
  ok(aiCanClear({ ...cfg.gemini, apiKey: 'AIza-k' }, cfg.ai) === true
    && aiCanClear(cfg.gemini, { ...cfg.ai, groq: { ...cfg.ai.groq, apiKey: 'gsk-k' } }) === true,
  'a key on Gemini or on a provider that may clear one, and the check runs');
}

console.log('=== direct links and TV: on with no group answer nothing, and say nothing ===');
{
  const cfg = fresh();
  const said = [];
  const say = { info: (m) => said.push(['info', m]), warn: (m) => said.push(['warn', m]), error: (m) => said.push(['error', m]), debug() {} };
  await directLinks.setup({ config: cfg, log: say });
  ok(!said.some(([l]) => l === 'warn'), 'direct links start with no key and no group: no warning');
  said.length = 0;
  await directLinks.setup({ config: { ...cfg, directLinks: { ...cfg.directLinks, groups: ['links@g.us'] } }, log: say });
  ok(said.some(([l, m]) => l === 'warn' && /no API key/.test(m)), 'with a group and no key, the warning is still given');

  const done = [];
  const bot = new Proxy({}, { get: (_, k) => (k === 'isConnected' ? () => true : async (...a) => { done.push(k); return { key: { id: 'X' } }; }) });
  const ctx = { config: cfg, bot, queue: { add: (j) => { done.push('queued'); return j.label; } },
    store: { get: (k, d) => d, set() {} }, log: say };
  for (const [plugin, text] of [[directLinks, '#request-movie Heat 1995'], [tvPlugin, '#request The Office season 2']]) {
    await plugin.onMessage({ id: 'M1', text, chatJid: 'some@g.us', isGroup: true, fromMe: false, messageType: 'conversation',
      senderJid: 'u@lid', senderNumber: '15551112222' }, ctx);
  }
  ok(done.length === 0, `a request in any group is nobody's: nothing reacted, sent or queued${done.length ? ` (${done.join(', ')})` : ''}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
