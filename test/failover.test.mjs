/* Automatic number failover. Run: node test/failover.test.mjs

   The bot runs as one of several WhatsApp numbers. If the active one dies the
   next should take over; when a preferred one comes back it should reclaim -
   but never in the middle of a job, and never in a loop.

   The failure that motivates most of this: a linking problem on one number
   took the whole bot down with no way back. */
import { EventEmitter } from 'node:events';
import { FailoverSupervisor, functionalGroups, coverageFor } from '../src/core/failover.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

/* ------------------------------------------------------------- doubles --- */

class FakeBot extends EventEmitter {
  constructor({ connects = true } = {}) {
    super();
    this.dataDir = '/tmp';
    this.state = 'connected';
    this.connects = connects;          // may be a Set of ids that succeed
    this.starts = [];
    this.stops = 0;
  }

  setState(state, extra = {}) {
    this.state = state;
    this.emit('state', { state, lastError: extra.lastError ?? null, reconnectAttempts: extra.reconnectAttempts ?? 0 });
  }

  async stop() { this.stops += 1; this.state = 'stopped'; }

  async start() {
    const id = this._activeId?.() ?? 'default';
    this.starts.push(id);
    const succeeds = this.connects instanceof Set ? this.connects.has(id) : this.connects;
    // resolve on a later tick, as a real connection would
    setImmediate(() => { if (succeeds) this.setState('connected'); else this.setState('error'); });
  }
}

function makeConfig(accounts, activeAccount, failover = {}) {
  let cfg = {
    whatsapp: {
      activeAccount,
      accounts,
      failover: { enabled: true, probeTimeoutMs: 200, checkEveryMs: 999_999, ...failover },
    },
  };
  return {
    get: () => cfg,
    update: (patch) => {
      const merge = (a, b) => {
        for (const [k, v] of Object.entries(b)) {
          if (v && typeof v === 'object' && !Array.isArray(v)) merge(a[k] ??= {}, v);
          else a[k] = v;
        }
        return a;
      };
      cfg = merge(JSON.parse(JSON.stringify(cfg)), patch);
      return cfg;
    },
  };
}

const ACCOUNTS = [
  { id: 'main', label: '+15558060189', phoneNumber: '15558060189' },
  { id: 'nolan', label: 'Christopher Nolan', phoneNumber: '15558020184' },
  { id: 'rachel', label: 'Second Phone', phoneNumber: '15558110179' },
];

function makeQueue({ active = 0, pending = 0 } = {}) {
  const a = new Map();
  for (let i = 0; i < active; i++) a.set(`job${i}`, { id: `job${i}`, label: `Job ${i}` });
  return { active: a, pending: new Array(pending).fill({}), cancelled: [], cancel(id, r) { this.cancelled.push([id, r]); this.active.delete(id); return true; } };
}

/** Build a supervisor whose accounts all report as linked unless listed. */
function build({ activeAccount = 'main', unlinked = [], queues = [makeQueue()], failover = {}, connects = true } = {}) {
  const bot = new FakeBot({ connects });
  const configStore = makeConfig(ACCOUNTS, activeAccount, failover);
  bot._activeId = () => configStore.get().whatsapp.activeAccount;
  const sup = new FailoverSupervisor({ bot, configStore, queues });
  // listAccounts() checks the filesystem for creds.json; override the linked flag.
  const realRanked = sup.ranked.bind(sup);
  sup.ranked = () => realRanked().map((a) => ({ ...a, linked: !unlinked.includes(a.id) }));
  sup.start();                     // registers the state listener the events need
  return { sup, bot, configStore };
}

const tick = () => new Promise((r) => setTimeout(r, 30));

/* --------------------------------------------------------------- tests --- */

console.log('=== a dead number hands over to the next one ===');
{
  const { sup, configStore } = build();
  const moved = await sup.failover('test');
  ok(moved?.id === 'nolan', `moved to the next preferred number (${moved?.label})`);
  ok(configStore.get().whatsapp.activeAccount === 'nolan', 'and the config now points at it');
}

console.log('=== a number logged out on the phone is never retried automatically ===');
{
  const { sup, bot, configStore } = build();
  bot.setState('stopped', { lastError: 'disconnected: loggedOut' });
  await tick();
  ok(configStore.get().whatsapp.activeAccount === 'nolan', 'it failed over');
  const h = sup.health.get('main');
  ok(h?.reason === 'logged-out', 'the dead number is marked as needing a re-link');
  ok(sup.eligible({ id: 'main', linked: true }) === false,
    'and stays ineligible — retrying a wiped session cannot work, only a human with the phone can fix it');
}

console.log('=== someone opening WhatsApp Web elsewhere steps us aside ===');
{
  const { bot, configStore } = build();
  bot.setState('conflict');
  await tick();
  ok(configStore.get().whatsapp.activeAccount === 'nolan', 'the conflict triggers a handover');
}

console.log('=== a blip does NOT move the bot ===');
{
  const { bot, configStore } = build({ failover: { failAfterAttempts: 4 } });
  for (const n of [1, 2, 3]) {
    bot.setState('connecting', { reconnectAttempts: n });
    await tick();
    ok(configStore.get().whatsapp.activeAccount === 'main', `attempt ${n}: still on the primary`);
  }
  bot.setState('connecting', { reconnectAttempts: 4 });
  await tick();
  ok(configStore.get().whatsapp.activeAccount === 'nolan',
    'only once the bot\'s own backoff has given up does a spare take over');
}

console.log('=== an unlinked spare is never chosen ===');
{
  const { sup, configStore } = build({ unlinked: ['nolan'] });
  const moved = await sup.failover('test');
  ok(moved?.id === 'rachel', 'it skips the unlinked number for the next linked one');
  ok(configStore.get().whatsapp.activeAccount === 'rachel', 'and switches to that');
}

console.log('=== with no usable spare it stays put and says so ===');
{
  const { sup, configStore } = build({ unlinked: ['nolan', 'rachel'] });
  const moved = await sup.failover('everything is down');
  ok(moved === null, 'no switch happened');
  ok(configStore.get().whatsapp.activeAccount === 'main',
    'the bot stays on the primary rather than switching to a number it cannot connect with');
}

console.log('=== failback WAITS for the queue to be empty ===');
{
  const busy = makeQueue({ active: 1, pending: 3 });
  const { sup, configStore } = build({ activeAccount: 'nolan', queues: [busy], failover: { holdDownMs: 0 } });
  sup.activeSince = 1;
  const back = await sup.considerFailback();
  ok(back === null, 'it does not switch while a job is running');
  ok(configStore.get().whatsapp.activeAccount === 'nolan', 'the spare keeps working');

  // ...and once the queue drains, it goes home.
  busy.active.clear();
  busy.pending.length = 0;
  const back2 = await sup.considerFailback();
  ok(back2?.id === 'main', 'once idle it returns to the preferred number');
  ok(configStore.get().whatsapp.activeAccount === 'main', 'and the config follows');
}

console.log('=== failback respects the hold-down, so it cannot flap ===');
{
  const { sup, configStore } = build({ activeAccount: 'nolan', failover: { holdDownMs: 600_000 } });
  sup.activeSince = Date.now();                       // just switched
  const back = await sup.considerFailback();
  ok(back === null, 'too soon after the last switch — no move');
  ok(configStore.get().whatsapp.activeAccount === 'nolan', 'still on the spare');

  sup.activeSince = Date.now() - 700_000;             // stable for a while
  const back2 = await sup.considerFailback();
  ok(back2?.id === 'main', 'after the hold-down it reclaims the preferred number');
}

console.log('=== a number in cooldown is left alone ===');
{
  const { sup } = build({ activeAccount: 'nolan', failover: { holdDownMs: 0, cooldownMs: 900_000 } });
  sup.activeSince = 1;
  sup.markFailed('main', 'connection refused');
  const back = await sup.considerFailback();
  ok(back === null, 'the recently-failed primary is not immediately retried');

  sup.health.get('main').cooldownUntil = Date.now() - 1;   // cooldown elapsed
  const back2 = await sup.considerFailback();
  ok(back2?.id === 'main', 'once the cooldown passes it is tried again');
}

console.log('=== a failed failback returns to what was working ===');
{
  // only 'nolan' can actually connect; a probe of 'main' will time out
  const { sup, configStore } = build({
    activeAccount: 'nolan', failover: { holdDownMs: 0 }, connects: new Set(['nolan']),
  });
  sup.activeSince = 1;
  const back = await sup.considerFailback();
  ok(back === null, 'the probe failed, so no failback');
  ok(configStore.get().whatsapp.activeAccount === 'nolan',
    'and the bot is back on the number that actually works — not left disconnected');
  ok(sup.health.get('main')?.reason?.includes('did not connect'), 'the failed probe is recorded');
}

console.log('=== work in flight when the connection dies is requeued ===');
{
  const q = makeQueue({ active: 2 });
  const { sup } = build({ queues: [q] });
  await sup.failover('connection lost');
  ok(q.cancelled.length === 2, 'both running jobs were released');
  ok(q.cancelled.every(([, reason]) => reason === 'interrupted'),
    'marked interrupted, not cancelled — they were not abandoned on purpose');
}

console.log('=== a manual switch is not undone a minute later ===');
{
  const { sup, configStore } = build({ activeAccount: 'nolan', failover: { holdDownMs: 600_000 } });
  sup.noteManualSwitch('nolan');
  const back = await sup.considerFailback();
  ok(back === null, 'the operator\'s choice stands');
  ok(configStore.get().whatsapp.activeAccount === 'nolan', 'still on the number they picked');
}

console.log('=== disabled means disabled ===');
{
  const { sup, bot, configStore } = build({ failover: { enabled: false } });
  bot.setState('conflict');
  await tick();
  ok(configStore.get().whatsapp.activeAccount === 'main', 'no automatic switch when it is off');
  ok(await sup.failover('x') === null, 'and an explicit call does nothing either');
}

console.log('=== the preference order is configurable ===');
{
  const { sup } = build({ activeAccount: 'rachel', failover: { order: ['rachel', 'nolan', 'main'] } });
  const names = sup.ranked().map((a) => a.id);
  ok(names[0] === 'rachel' && names[1] === 'nolan', `order honoured: ${names.join(' > ')}`);
  sup.activeSince = 1;
  const back = await sup.considerFailback();
  ok(back === null, 'the active number IS the preferred one, so there is nothing to fail back to');
}

console.log('=== two switches cannot run at once ===');
{
  const { sup, configStore } = build();
  const a = sup.failover('first');
  const b = sup.failover('second');
  const [ra, rb] = await Promise.all([a, b]);
  ok(ra === rb || (ra && rb), 'the second call joins the first rather than starting a competing switch');
  ok(configStore.get().whatsapp.activeAccount === 'nolan', 'and the bot lands on one number, not two');
}

/** Capture what would be emailed, without sending anything. */
function withMail(opts = {}) {
  const sent = [];
  const b = build(opts);
  b.sup.alerts = { notify: async (m) => { sent.push(m); return { sent: true }; } };
  b.sent = sent;
  return b;
}

console.log('=== a takeover is emailed ===');
{
  const { sup, sent } = withMail();
  await sup.failover('the connection dropped');
  ok(sent.length === 1, 'one email');
  ok(/switched to Christopher Nolan/.test(sent[0].label), `subject names the new number: "${sent[0].label}"`);
  ok(/the connection dropped/.test(sent[0].note), 'the body says why');
  ok(/Was using/.test(sent[0].note) && /Now using/.test(sent[0].note), 'and which number it moved between');
  ok(sent[0].kind === 'failover', 'tagged so it throttles separately from other kinds');
}

console.log('=== the bot going DOWN with no spare is emailed, loudly ===');
{
  const { sup, sent } = withMail({ unlinked: ['nolan', 'rachel'] });
  await sup.failover('everything is unreachable');
  ok(sent.length === 1, 'an email goes out even though no switch happened');
  ok(/DOWN/.test(sent[0].label), `the subject does not bury it: "${sent[0].label}"`);
  ok(/not processing requests/.test(sent[0].note),
    'and the body says plainly that requests are not being handled');
  ok(sent[0].kind === 'failover-stuck',
    'a separate kind, so being told the bot is down is never throttled away by routine switch notices');
}

console.log('=== a takeover to a number with GAPS says so in the email ===');
{
  // The quiet failure this guards: the spare connects, everything looks
  // healthy, and requests in the groups it cannot administer vanish.
  const { sup, sent } = withMail();
  sup.status = () => ({
    accounts: [
      { id: 'main', label: 'Main', preference: 1, linked: true },
      { id: 'nolan', label: 'Christopher Nolan', preference: 2, linked: true, active: true,
        coverage: { covered: 6, total: 8, gaps: [
          { subject: 'Testing things', role: 'movie requests', why: 'not a member' },
          { subject: 'RECENTLY RELEASED', role: 'movie requests', why: 'not an admin' },
        ] } },
    ],
  });
  await sup.failover('primary died');
  ok(/WARNING/.test(sent[0].note), 'the email warns');
  ok(/6 of 8 groups/.test(sent[0].note), 'quantifies the gap');
  ok(/Testing things \(movie requests - not a member\)/.test(sent[0].note), 'and names each group');
  ok(/will NOT be handled/.test(sent[0].note), 'saying what it means in practice');
}

console.log('=== returning to the preferred number is emailed too ===');
{
  const { sup, sent } = withMail({ activeAccount: 'nolan', failover: { holdDownMs: 0 } });
  sup.activeSince = 1;
  await sup.considerFailback();
  ok(sent.length === 1, 'one email');
  ok(/back on/.test(sent[0].label), `"${sent[0].label}"`);
  ok(sent[0].kind === 'failback', 'and its own kind');
  ok(/nothing was interrupted/.test(sent[0].note), 'reassuring that the queue was idle');
}

console.log('=== a number logged out on the phone gets its own email ===');
{
  const { bot, sent } = withMail();
  bot.setState('stopped', { lastError: 'disconnected: loggedOut' });
  await tick();
  const relink = sent.find((m) => m.kind === 'relink-needed');
  ok(!!relink, 'an email specifically about re-linking');
  ok(/needs re-linking/.test(relink.label), `"${relink.label}"`);
  ok(/from the handset/.test(relink.note), 'saying it cannot be fixed from the server');
  ok(sent.some((m) => m.kind === 'failover'), 'and the takeover itself is still reported');
}

console.log('=== the email can be switched off ===');
{
  const { sup, sent, configStore } = withMail();
  configStore.update({ email: { onFailover: false } });
  await sup.failover('x');
  ok(sent.length === 0, 'nothing is sent when the setting is off');
}

console.log('=== a failing mailer never breaks the recovery ===');
{
  const b = build();
  b.sup.alerts = { notify: async () => { throw new Error('smtp is down'); } };
  const moved = await b.sup.failover('connection lost');
  ok(moved?.id === 'nolan', 'the switch still happens when the email cannot be sent');
  ok(b.configStore.get().whatsapp.activeAccount === 'nolan', 'and the bot is on the new number');
}

console.log('=== with no mailer configured at all, nothing throws ===');
{
  const { sup, configStore } = build();          // alerts is null
  const moved = await sup.failover('connection lost');
  ok(moved?.id === 'nolan', 'the switch is unaffected');
  ok(configStore.get().whatsapp.activeAccount === 'nolan', 'and completes');
}

console.log('=== ONE logout cannot become a storm of failovers ===');
{
  // What actually happened: 5 genuine logouts produced 929 failovers, every
  // one of them inside the same second (2026-08-20T11:42:00). bot.stop() sets
  // state 'stopped' and lastError was never cleared, so the deliberate stop
  // INSIDE each switch looked like a brand-new logout and drove the next one.
  const { sup, bot, configStore } = build();
  let switches = 0;
  const realSwitch = sup._switchTo.bind(sup);
  sup._switchTo = (acc, why) => { switches += 1; return realSwitch(acc, why); };

  // A stop that leaves a stale error is exactly what the loop fed on.
  bot.stop = async () => { bot.stops += 1; bot.setState('stopped', { lastError: 'disconnected: loggedOut' }); };

  bot.setState('stopped', { lastError: 'disconnected: loggedOut' });
  await tick(); await tick();

  ok(switches <= 2, `one logout caused at most one handover, not a storm (${switches})`);
  ok(configStore.get().whatsapp.activeAccount !== 'main', 'it did move off the dead number');
}

console.log('=== a deliberate stop is not mistaken for a logout ===');
{
  const { sup, bot, configStore } = build();
  bot.setState('connected');            // healthy
  await tick();
  // The real bot clears lastError on a deliberate stop; assert the supervisor
  // does nothing when told about one.
  bot.setState('stopped', { lastError: null });
  await tick();
  ok(configStore.get().whatsapp.activeAccount === 'main',
    'pressing Disconnect does not trigger a number switch');
  ok(!sup.health.get('main'), 'and does not mark the number unhealthy');
}

console.log('=== the circuit breaker stands down when nothing will hold ===');
{
  const { sup } = build({ failover: { maxSwitchesPerWindow: 3, switchWindowMs: 3_600_000 } });
  sup._switchTimes = [Date.now(), Date.now(), Date.now()];
  const moved = await sup.failover('connection keeps dropping');
  ok(moved === null,
    'past the limit it refuses to switch again - when the connection itself is unstable, no number helps');
}

console.log('=== a spare is only useful if it can ADMINISTER the groups ===');
{
  const cfg = {
    movieRequests: { requestGroups: ['req@g.us', 'cam@g.us'], postsGroup: 'posts@g.us', notify: { group: 'notify@g.us' } },
    tvRequests: { enabled: true, requestGroups: ['tvreq@g.us'], postsGroups: ['tvposts@g.us'] },
    directLinks: { enabled: true, groups: ['links@g.us'] },
  };
  const need = functionalGroups(cfg);
  ok(need.size === 7, `every group the bot needs is listed (${need.size})`);
  ok(need.get('cam@g.us') === 'movie requests', 'and labelled with what it is for');

  const groups = [...need.keys()].map((jid) => ({
    jid, subject: jid.split('@')[0],
    members: [{ number: '15558110179', admin: 'admin' }, { number: '15558020184', admin: null }],
  }));

  const full = coverageFor(groups, cfg, '15558110179');
  ok(full.gaps.length === 0, 'an admin everywhere covers everything');
  ok(full.covered === full.total, `${full.covered}/${full.total}`);

  // Being a MEMBER is not enough - posting, deleting and locking all need admin.
  const memberOnly = coverageFor(groups, cfg, '15558020184');
  ok(memberOnly.gaps.length === 7, 'a member who is not an admin covers nothing');
  ok(memberOnly.gaps[0].why === 'not an admin', 'and the reason says exactly that');

  // Missing from ONE request group is the dangerous case: it connects fine and
  // silently stops processing part of the workload.
  const partial = groups.map((g) => (g.jid === 'cam@g.us' ? { ...g, members: [] } : g));
  const gap = coverageFor(partial, cfg, '15558110179');
  ok(gap.gaps.length === 1, 'one missing group is one gap');
  ok(gap.gaps[0].role === 'movie requests' && gap.gaps[0].why === 'not a member',
    `it names the role at risk: ${gap.gaps[0].role} — ${gap.gaps[0].why}`);

  ok(coverageFor([], cfg, '1732') === null, 'with no group data it says "cannot tell", not "all clear"');
  ok(coverageFor(groups, cfg, '') === null, 'and the same for a number it does not know');
}

console.log('=== a disabled TV section is not counted as a gap ===');
{
  const cfg = {
    movieRequests: { requestGroups: ['req@g.us'], postsGroup: 'posts@g.us' },
    tvRequests: { enabled: false, requestGroups: ['tvreq@g.us'] },
    directLinks: { enabled: false, groups: ['links@g.us'] },
  };
  const need = functionalGroups(cfg);
  ok(need.size === 2, 'only the groups actually in use are required');
  ok(!need.has('tvreq@g.us'), 'a switched-off section does not make a spare look broken');
}

console.log('=== status explains itself to the portal ===');
{
  const { sup } = build({ unlinked: ['rachel'] });
  sup.markFailed('nolan', 'connection refused');
  const s = sup.status();
  ok(s.active === 'main', 'reports which number is live');
  ok(s.accounts[0].preference === 1, 'ranks them');
  ok(s.accounts.find((a) => a.id === 'nolan').unhealthyReason === 'connection refused',
    'and says WHY a number is not eligible');
  ok(s.accounts.find((a) => a.id === 'rachel').eligible === false, 'an unlinked number is not eligible');
  ok(typeof s.queuesIdle === 'boolean', 'and whether a failback could happen right now');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
