/* The two bot commands the hourly check uses: `health` and `requeue`.
   Run: node test/bot-cmd-health-requeue.test.mjs

   The hourly check runs from cron, outside the bot, and talks to it only
   through data/bot-cmd.json. `health` is how it tells a slow encode from a
   stuck one (the log says when a job started, not when it last moved) and
   confirms a restart came back on the right commit. `requeue` lets it re-run
   a request that failed because of a bug it has just fixed - once, so the
   member gets their film without asking again. That is the one command here
   that queues work, so what it refuses matters most: a beta test (a re-run
   from the box has no origin group and would go to the MAIN posts group, the
   reason the panel offers no Re-run on a beta row), a second attempt, a
   request the member already asked for again, a TV season that partly
   posted (re-running it would post those episodes twice). */
import { runAdminCommand, auditAdminCommand, rerunRefusal } from '../src/core/admin-commands.js';
import { StateStore } from '../src/core/state.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'botcmd-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
const NOW = Date.now();

const bot = {
  status: () => ({ state: 'connected', lastError: 'closed by +1 (212) 555-0186', reconnectAttempts: 0, nextReconnectAt: null, linking: false, me: { id: '12125550186@s.whatsapp.net' } }),
};
const queue = {
  active: new Map([[1, { label: 'Newsies (1992)', kind: 'movie', startedAt: NOW - 30 * 60_000, progress: { at: NOW - 5000, stage: 'convert', pct: 40 } }]]),
  pending: [{}, {}],
  paused: false,
};

console.log('=== health ===');
{
  const r = await runAdminCommand({ op: 'health' }, { bot, dataDir: tmp, queue, linkQueue: { active: new Map(), pending: [] } });
  ok(r.ok && r.connection.state === 'connected', 'says how WhatsApp is');
  ok(r.queues.media.running[0].progressAt === NOW - 5000 && r.queues.media.running[0].stage === 'convert', 'and when each running job last moved - what tells a long encode from a stuck one');
  ok(r.queues.media.waiting === 2 && r.safeToRestart === false, 'with the queue\'s size, like queue-status');
  ok(typeof r.pid === 'number' && typeof r.startedAt === 'number', 'and which process answered, since when');
  ok(!JSON.stringify(r).includes('555-0186') && !JSON.stringify(r).includes('12125550186'), 'with no phone number - not even the bot\'s own');
  const store = new StateStore(path.join(tmp, 'h.json'));
  auditAdminCommand(store, { op: 'health' }, r);
  ok((store.namespace('audit').get('events', []) ?? []).length === 0, 'a read, so it leaves the audit log alone');
}

console.log('=== health: a job waiting in line for a stage slot says so ===');
{
  // A job in line for the encoder reports no progress until the slot frees -
  // on 2026-09-24 Inception waited 53 minutes behind two encodes - and a TV
  // episode in that line still reads "download". Without its place in the
  // line the hourly check took it for stuck and restarted the bot, throwing
  // away the encode it was waiting for.
  const { stageSems, stageWaits } = await import('../src/media/stages.js');
  await stageSems.convert.acquire(1, null, { key: 'encoding-now' });
  const waitingJob = stageSems.convert.acquire(0, null, { key: 'job-2' });
  const q = {
    active: new Map([
      ['encoding-now', { id: 'encoding-now', label: 'Minority Report (2002)', startedAt: NOW - 3600_000, progress: { at: NOW - 2000, stage: 'convert' } }],
      ['job-2', { id: 'job-2', label: 'Loki S01E02', kind: 'tv', startedAt: NOW - 3600_000, progress: { at: NOW - 3000_000, stage: 'download' } }],
    ]),
    pending: [],
    stageWaits,
  };
  const r = await runAdminCommand({ op: 'health' }, { bot, dataDir: tmp, queue: q, linkQueue: { active: new Map(), pending: [] } });
  const [enc, ep] = r.queues.media.running;
  ok(ep.waitingFor?.stage === 'convert' && ep.waitingFor.position === 1, `the episode is in line for the encoder (${JSON.stringify(ep.waitingFor)})`);
  ok(!enc.waitingFor, 'the job holding the slot is not');
  stageSems.convert.release();
  await waitingJob;
  stageSems.convert.release();
}

/** A loaded plugin with a history, and a requeue() that records what it was given. */
function plugins(history, { throws = null } = {}) {
  const store = new StateStore(path.join(tmp, `s-${Math.random()}.json`));
  const ns = store.namespace('movie-requests');
  ns.set('history', history);
  const tvNs = store.namespace('tv-requests');
  tvNs.set('history', history.filter((r) => r.kind === 'tv'));
  const calls = [];
  const plugin = (name) => ({
    plugin: {
      async requeue(text, ctx, opts) {
        calls.push({ name, text, opts });
        if (throws) throw new Error(throws);
        return name === 'tv-requests' ? { kind: 'tv', series: 'Gravity Falls', season: 1, queued: 20 } : { title: 'Thor: Love and Thunder', year: 2022 };
      },
    },
    ctx: { store: name === 'tv-requests' ? tvNs : ns },
  });
  return { store, calls, pluginManager: { plugins: new Map([['movie-requests', plugin('movie-requests')], ['tv-requests', plugin('tv-requests')]]) } };
}

const row = (o) => ({ id: 'R1', at: NOW - 3600_000, status: 'failed', title: 'Thor: Love and Thunder', year: 2022, request: 'Thor love and thunder', requester: 'Shia', detail: 'ENOSPC: no space left on device, write', ...o });

console.log('=== requeue: a failed request, once ===');
{
  const p = plugins([row({})]);
  const run = () => runAdminCommand({ op: 'requeue', plugin: 'movie', id: 'R1', by: 'hourly check 20260928T180000Z' }, { bot, dataDir: tmp, stateStore: p.store, pluginManager: p.pluginManager });
  const r = await run();
  ok(r.ok && r.queued === 'Thor: Love and Thunder (2022)', `queued: ${r.queued}`);
  ok(p.calls[0].text === 'Thor love and thunder', 'with what the member asked for - the panel\'s Re-run feeds the same field back');
  ok(/Shia/.test(p.calls[0].opts.requester) && /hourly check/.test(p.calls[0].opts.requester), 'credited to the member, marked as the hourly check\'s re-run');
  let second = null;
  try { await run(); } catch (err) { second = err.message; }
  ok(/already re-run once/.test(second ?? '') && p.calls.length === 1, 'the second attempt is refused: that is for a person to decide');
  auditAdminCommand(p.store, { op: 'requeue', plugin: 'movie', id: 'R1', by: 'hourly check' }, r);
  const ev = p.store.namespace('audit').get('events', [])[0];
  ok(/re-ran "Thor: Love and Thunder \(2022\)" for Shia/.test(ev?.action ?? '') && /had failed/.test(ev?.detail ?? ''), `audited: "${ev?.action}" - ${ev?.detail}`);
}

console.log('=== requeue: a refused re-run does not use up the one attempt ===');
{
  const p = plugins([row({})], { throws: 'Queue is full (104 waiting)' });
  let err = null;
  try { await runAdminCommand({ op: 'requeue', plugin: 'movie', id: 'R1' }, { bot, dataDir: tmp, stateStore: p.store, pluginManager: p.pluginManager }); } catch (e) { err = e.message; }
  ok(/Queue is full/.test(err ?? ''), 'the plugin\'s refusal comes back as the answer');
  ok(Object.keys(p.store.namespace('hourly-checks').get('requeued', {}) ?? {}).length === 0, 'and nothing is recorded, so it can be tried when there is room');
}

console.log('=== requeue: a request still journalled is not re-run ===');
{
  // A resumed film's row read "lost" while it sat queued and journalled
  // (review scenario a-lost-rerun), and the scanner calls "lost" re-runnable:
  // the requeue queued Minority Report a second time.
  const lost = row({ id: 'AC8347C9', status: 'lost', title: 'Minority Report', year: 2002, request: 'minority report 2002', detail: 'interrupted before it finished' });
  const film = { title: 'Minority Report', year: 2002, imdbId: 'tt0181689' };
  const own = [{ jobKey: 'AC8347C9:tt0181689', msgId: 'AC8347C9', movie: film, record: { id: 'AC8347C9' } }];
  ok(/still in the queue/.test(rerunRefusal({ plugin: 'movie', row: lost, history: [lost], now: NOW, journal: own }) ?? ''),
    'its own journal entry refuses it');
  const other = [{ jobKey: 'OTHER:tt0181689', msgId: 'OTHER', movie: film, record: { id: 'OTHER' } }];
  ok(/still in the queue/.test(rerunRefusal({ plugin: 'movie', row: lost, history: [lost], now: NOW, journal: other }) ?? ''),
    'and so does another request journalled for the same film');
  const beta = [{ jobKey: 'B:tt0181689', msgId: 'B', movie: film, record: { id: 'B', route: { beta: true } } }];
  ok(rerunRefusal({ plugin: 'movie', row: lost, history: [lost], now: NOW, journal: beta }) === null,
    'a beta test of the same film goes elsewhere, and does not');
  const season = row({ id: 'T1', kind: 'tv', status: 'failed', title: 'Loki', season: 1, request: 'loki season 1' });
  ok(/still in the queue/.test(rerunRefusal({ plugin: 'tv', row: season, history: [season], now: NOW,
    journal: [{ reqKey: 'tv-X', baseRow: { id: 'X', title: 'Loki', season: 1 }, episodes: [{}] }] }) ?? ''),
  'a TV season journalled by a request refuses a re-run of the same season');

  const p = plugins([lost]);
  p.pluginManager.plugins.get('movie-requests').ctx.store.set('pending', own);
  let err = null;
  try { await runAdminCommand({ op: 'requeue', plugin: 'movie', id: 'AC8347C9' }, { bot, dataDir: tmp, stateStore: p.store, pluginManager: p.pluginManager }); } catch (e) { err = e.message; }
  ok(/not re-run: it is still in the queue/.test(err ?? '') && p.calls.length === 0, `the bot command reads the journal and refuses (${err})`);
}

console.log('=== requeue: what is refused ===');
{
  const refuse = (plugin, r, history = [r], ledger = {}) => rerunRefusal({ plugin, row: r, history, ledger, now: NOW });
  ok(/beta group/.test(refuse('movie', row({ beta: true }))), 'a beta test: it would go to the main posts group');
  ok(/not re-run from here/.test(refuse('movie', row({ status: 'sent' }))), 'a request that was sent');
  ok(/not re-run from here/.test(refuse('movie', row({ status: 'interrupted' }))), 'an interrupted one: it retries by itself at the next start');
  ok(/not re-run from here/.test(refuse('movie', row({ status: 'blocked-rating' }))), 'a rating block: that is policy, not a failure');
  ok(/not re-run from here/.test(refuse('tv', row({ kind: 'tv', status: 'partial' }))), 'a partly posted season: the posted episodes would go out twice');
  ok(/posts group/.test(refuse('movie', row({ status: 'error', detail: 'posts group not set' }))), 'no posts group: a setting to fix first');
  ok(/week old/.test(refuse('movie', row({ at: NOW - 8 * 86_400_000 }))), 'more than a week old: ask the member');
  const newer = row({ id: 'R2', at: NOW - 60_000, status: 'queued' });
  ok(/asked for again since/.test(refuse('movie', row({}), [newer, row({})])), 'asked for again since, and that request is queued');
  ok(/already re-run/.test(refuse('movie', row({}), [row({})], { 'movie:R1': { at: NOW } })), 'already re-run');
  ok(refuse('movie', null) === 'no such request in the history', 'an id that is not in the history');
  ok(refuse('movie', row({ status: 'error', detail: 'queue full' })) === null, 'refused for a full queue: may be re-run once there is room');
  ok(refuse('tv', row({ kind: 'tv', status: 'failed', season: 1 })) === null, 'a TV request that posted nothing may be re-run');
}

console.log('=== requeue: a TV request, and bad input ===');
{
  const p = plugins([row({ id: 'T1', kind: 'tv', status: 'failed', title: 'Gravity Falls', year: 2012, season: 1, request: 'gravity falls s1' })]);
  const r = await runAdminCommand({ op: 'requeue', plugin: 'tv', id: 'T1' }, { bot, dataDir: tmp, stateStore: p.store, pluginManager: p.pluginManager });
  ok(r.queued === 'Gravity Falls season 1 (20 episode(s))' && p.calls[0].name === 'tv-requests', `the TV plugin re-queues it: ${r.queued}`);
  for (const [cmd, re, what] of [
    [{ op: 'requeue', plugin: 'music', id: 'x' }, /plugin must be/, 'an unknown plugin'],
    [{ op: 'requeue', plugin: 'movie' }, /id required/, 'no id'],
  ]) {
    let err = null;
    try { await runAdminCommand(cmd, { bot, dataDir: tmp, stateStore: p.store, pluginManager: p.pluginManager }); } catch (e) { err = e.message; }
    ok(re.test(err ?? ''), `refused: ${what}`);
  }
  let err = null;
  try { await runAdminCommand({ op: 'requeue', plugin: 'movie', id: 'x' }, { bot, dataDir: tmp, stateStore: p.store }); } catch (e) { err = e.message; }
  ok(/not loaded/.test(err ?? ''), 'and with no plugins to hand, it says so');
}

console.log('=== queue: by its text, as the panel\'s queue box does ===');
{
  const p = plugins([]);
  const r = await runAdminCommand({ op: 'queue', plugin: 'tv', text: 'fullmetal alchemist brotherhood S01E14', by: 'owner via Claude' },
    { bot, dataDir: tmp, stateStore: p.store, pluginManager: p.pluginManager });
  ok(r.ok && p.calls.length === 1 && p.calls[0].name === 'tv-requests', 'goes to the TV plugin\'s requeue - every check the panel gets');
  ok(p.calls[0].text === 'fullmetal alchemist brotherhood S01E14' && /owner via Claude/.test(p.calls[0].opts.requester), 'with the text as typed, credited to who asked');
  auditAdminCommand(p.store, { op: 'queue', plugin: 'tv', text: 'fullmetal alchemist brotherhood S01E14', by: 'owner via Claude' }, r);
  const ev = p.store.namespace('audit').get('events', [])[0];
  ok(/queued "Gravity Falls season 1 \(20 episode\(s\)\)" from the box/.test(ev?.action ?? '') && /fullmetal alchemist brotherhood S01E14/.test(ev?.detail ?? ''),
    `audited as a change: "${ev?.action}" - ${ev?.detail}`);
  for (const [cmd, re, what] of [
    [{ op: 'queue', plugin: 'music', text: 'x' }, /plugin must be/, 'an unknown plugin'],
    [{ op: 'queue', plugin: 'tv', text: '   ' }, /text required/, 'no text'],
  ]) {
    let err = null;
    try { await runAdminCommand(cmd, { bot, dataDir: tmp, stateStore: p.store, pluginManager: p.pluginManager }); } catch (e) { err = e.message; }
    ok(re.test(err ?? ''), `refused: ${what}`);
  }
  const one = { plugins: new Map([['tv-requests', { plugin: { async requeue() {
    return { kind: 'tv', series: 'Fullmetal Alchemist: Brotherhood', season: 1, queued: 1, episodes: ['Fullmetal Alchemist Brotherhood S01E14'] };
  } }, ctx: {} }]]) };
  const r1 = await runAdminCommand({ op: 'queue', plugin: 'tv', text: 'fmab S01E14' }, { bot, dataDir: tmp, stateStore: p.store, pluginManager: one });
  ok(r1.queued === 'Fullmetal Alchemist Brotherhood S01E14', `one episode is named once, by its own label: "${r1.queued}"`);
  const q = plugins([], { throws: 'Fullmetal Alchemist: Brotherhood S01E14 is already in the queue - not queued twice' });
  let err = null;
  try { await runAdminCommand({ op: 'queue', plugin: 'tv', text: 'fmab S01E14' }, { bot, dataDir: tmp, stateStore: q.store, pluginManager: q.pluginManager }); } catch (e) { err = e.message; }
  ok(/already in the queue/.test(err ?? ''), 'and the plugin\'s refusal comes back as the answer');
}

console.log('=== queue-item: a library film by its Jellyfin id, as the panel\'s Queue link does ===');
{
  // Mr. 365 (2018), 2026-09-29: OMDb does not know it, so no request by
  // title could resolve it, and the operator asked for it to be queued from
  // its library link, which carried the server's api_key.
  const ID = '12567be3941b5fbaacda8bab1188db91';
  const calls = [];
  const store = new StateStore(path.join(tmp, 'queue-item.json'));
  const pm = { plugins: new Map([['movie-requests', { ctx: {}, plugin: {
    async queueLibraryItem(item, ctx, opts) { calls.push({ item, opts }); return { overrideNote: 'sent: on the bypass list' }; },
  } }]]) };
  const lookups = [];
  const lookupItem = async (id) => { lookups.push(id); return id === ID ? { id, title: 'Mr. 365', year: 2018, rated: null, type: 'Movie' } : null; };
  const link = `https://jf.example/Items/${ID}/Download?api_key=SECRET-KEY-123`;
  const r = await runAdminCommand({ op: 'queue-item', url: link, by: 'owner via Claude' },
    { bot, dataDir: tmp, stateStore: store, pluginManager: pm, lookupItem, configStore: { get: () => ({ library: {} }) } });
  ok(r.ok && r.queued === 'Mr. 365 (2018)' && lookups.join() === ID, `looked up by its id and queued: "${r.queued}"`);
  ok(calls.length === 1 && calls[0].item.id === ID && /owner via Claude/.test(calls[0].opts.requester),
    'through the movie plugin\'s queueLibraryItem, credited to who asked');
  auditAdminCommand(store, { op: 'queue-item', url: link, by: 'owner via Claude' }, r);
  const ev = store.namespace('audit').get('events', [])[0];
  ok(/queued "Mr\. 365 \(2018\)" from the box/.test(ev?.action ?? '') && ev.detail.includes(ID), `audited: "${ev?.action}" - ${ev?.detail}`);
  ok(!JSON.stringify(r).includes('SECRET-KEY-123') && !JSON.stringify(ev).includes('SECRET-KEY-123'),
    'the api_key in the pasted link is neither returned nor audited');

  for (const [cmd, re, what] of [
    [{ op: 'queue-item' }, /id required/, 'no id'],
    [{ op: 'queue-item', id: 'f'.repeat(32) }, /nothing on the server has the id/, 'an id the server does not hold'],
  ]) {
    let err = null;
    try { await runAdminCommand(cmd, { bot, dataDir: tmp, stateStore: store, pluginManager: pm, lookupItem, configStore: { get: () => ({ library: {} }) } }); } catch (e) { err = e.message; }
    ok(re.test(err ?? ''), `refused: ${what}`);
  }
  let err = null;
  const tvItem = async (id) => ({ id, title: 'Loki', type: 'Series' });
  try { await runAdminCommand({ op: 'queue-item', id: ID }, { bot, dataDir: tmp, stateStore: store, pluginManager: pm, lookupItem: tvItem, configStore: { get: () => ({ library: {} }) } }); } catch (e) { err = e.message; }
  ok(!!err && calls.length === 1, `a show is refused as the panel refuses it: "${err}"`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
