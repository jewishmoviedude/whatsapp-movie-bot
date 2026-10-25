/* A wanted film the recheck finds on the server is re-run for the members who were told "not in the library".
   Run: node test/wanted-arrival.test.mjs

   The operator, 2026-10-11: when a request comes back not in the library
   they ask the Jellyfin host for the film, and once it is available the bot
   is to put it in the queue and react on the member's message. Agreed the
   same day: what says it is available is the bot's own library - the wanted
   recheck (every 30 minutes) finding the film - and nothing depends on
   Discord. The first cut started a re-run from the host's request bot's
   post, read by the Discord reader; a film the recheck found without one
   was only marked resolved. Two real cases that day:
   - "My Suicide" (2009), Noah Fields's "my suicide 2009" of 2026-09-14: on
     the server from 03:17 UTC on 2026-10-09, marked resolved by the wanted
     recheck at 08:57 on 2026-10-11; nothing queued for him.
   - "A Snapshot of Forever", Mia's "a snapshot of forever 2025" of
     2026-10-08: on the server from 03:14 UTC on 2026-10-11, and refused by
     the 12:40 recheck because OMDb has it as 2025 and the server as 2022 -
     one IMDb id, tt14074586.

   Pinned here, with the History rows and wanted entries as the live state
   holds them (names and dates real, numbers and ids made up), the real
   wanted recheck and movie-request pipeline, a stubbed OMDb, Jellyfin and
   WhatsApp, and every scenario starting from a run of the recheck and the
   pass src/index.js runs after it:
   - Snapshot: found by the recheck despite the three-year gap because the
     IMDb id is the same, resolved, and Mia's request re-run AS HER
     REQUEST - queued, every reaction on her original message's key, its
     History row marked a re-run ("it arrived on the server"), an audit row,
     a notifications line saying so, and the cooldown neither asked nor
     started - with no Discord account, channel or post anywhere;
   - a copy carrying a DIFFERENT IMDb id is still refused, and so is one
     with no id from years away, and a 1990 "Total Recall", rated R, tagged
     with the 2012 film's id (the id outweighs the year only a few years
     off);
   - once only: another recheck, a restart, a restart between the find and
     the pass, the film found again after a Reopen - nothing is re-run
     twice (the ledger, by History row id);
   - pacing: _bulkPace before every re-run, one at a time, a burst of
     several films included; held while WhatsApp is down, requests are
     paused or the lockdown is on, and finished after the next recheck;
   - the rating gate still refuses an R film for a main group, on the
     original message, and the member is left to tell;
   - a film already waiting in the queue is not queued twice, and one
     posted since with another member's request is not posted again;
   - wanted.rerunOnArrival off: nothing is re-run;
   - entries resolved before the first pass are recorded as handled and
     never re-run by themselves; "Re-run requests" (POST
     /api/wanted/:key/rerun) re-runs one by hand: signed in only, audited,
     by the same rules, finished at the next pass when it stops part-way;
   - the hourly report says per film who was re-run and who to tell; a
     member the recheck's find could not re-run because their request had
     left History, or whose re-run the bot was stopped in the middle of, is
     to be told by hand (not "found when a member asked for it again"), and
     "Re-run requests" is named only while there is a request to re-run;
   - the Discord reader is not part of it: its file is main's, and nothing
     of the feature reads it. */
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import moviePlugin from '../src/plugins/movie-requests/index.js';
import { findInLibrary, forgetProviderFilterSupport, yearRuleYields } from '../src/plugins/movie-requests/library.js';
import { ArrivalReruns, rerunCandidates, messageFor, LEDGER_KEY } from '../src/core/wanted-arrival.js';
import { notTheFilm, WantedRecheck } from '../src/core/wanted-recheck.js';
import { ARRIVALS_BEGAN_KEY, reopenWanted, resolveWanted } from '../src/core/wanted.js';
import { createApiRouter } from '../src/web/api.js';
import { JobQueue } from '../src/core/queue.js';
import { scan } from '../src/core/incident-scan.js';
import { DEFAULT_CONFIG, mergeDefaults } from '../src/config/schema.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const settle = (ms = 10) => new Promise((r) => setTimeout(r, ms));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wanted-arrival-'));
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));
const REPO = fileURLToPath(new URL('..', import.meta.url));
const source = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
/** A file's code without its comments, for what it does rather than what it says. */
const codeOf = (rel) => source(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const NOW = Date.parse('2026-10-11T15:00:00Z');
const T = (iso) => Date.parse(iso);

/* ------------------------------ the people ------------------------------ */

const MOVIES = '120363000000000001@g.us';
const POSTS = '120363000000000002@g.us';
const NOTIFY = '120363000000000003@g.us';
const MIA = { jid: '100000000000001@lid', number: '15550000001', name: 'Mia ' };
const NOACH = { jid: '100000000000002@lid', number: '15550000002', name: 'Noah Fields' };
const AIDEN = { jid: '100000000000003@lid', number: '15550000003', name: 'Alex Walker' };
const CHANA = { jid: '100000000000004@lid', number: '15550000004', name: '❤️Hannah' };
const DAN = { jid: '100000000000005@lid', number: '15550000005', name: 'Dan Smith' };

/* ------------------------------ the library ------------------------------ */

let seq = 0;
const film = (Name, ProductionYear, Imdb, OfficialRating = null) => {
  seq += 1;
  return {
    Id: String(seq).padStart(32, '0'), Name, ProductionYear, OfficialRating, Type: 'Movie',
    ProviderIds: Imdb ? { Imdb, Tmdb: String(880000 + seq) } : {},
    MediaSources: [{ Path: `/nowhere/${Name}.mkv`, Size: 1_500_000_000, Container: 'mp4' }],
  };
};
// What the live server holds (checked read-only on 2026-10-11).
const SNAPSHOT_2022 = film('A Snapshot of Forever', 2022, 'tt14074586');
const SUICIDE_2009 = film('My Suicide', 2009, 'tt0492896', 'Not Rated');
const DUNE_2021 = film('Dune', 2021, 'tt1160419', 'PG-13');
const HEAT_1995 = film('Heat', 1995, 'tt0113277', 'R');
// Not the film: another IMDb id, and no id at all.
const SNAPSHOT_OTHER_ID = film('A Snapshot of Forever', 2022, 'tt99999999');
const SNAPSHOT_NO_ID = film('A Snapshot of Forever', 2022, null);
// Nor the 1990 film, rated R, tagged with the 2012 remake's id: one id, but
// 22 years off (SAME_ID_MAX_YEAR_GAP; found in review, 2026-10-11).
const RECALL_MISTAGGED = film('Total Recall', 1990, 'tt1386703', 'R');
// Another copy of a film already found, as when the host re-imports it.
const SNAPSHOT_REIMPORT = film('A Snapshot of Forever', 2022, 'tt14074586');
const DUNE_REIMPORT = film('Dune', 2021, 'tt1160419', 'PG-13');

let LIB = [];
const OMDB = [
  { Title: 'A Snapshot of Forever', Year: '2025', Rated: 'N/A', imdbID: 'tt14074586', Type: 'movie', Released: '20 Aug 2025', DVD: 'N/A', Response: 'True' },
  { Title: 'My Suicide', Year: '2009', Rated: 'Not Rated', imdbID: 'tt0492896', Type: 'movie', Released: '01 Jan 2009', DVD: 'N/A', Response: 'True' },
  { Title: 'Dune: Part One', Year: '2021', Rated: 'PG-13', imdbID: 'tt1160419', Type: 'movie', Released: '22 Oct 2021', DVD: 'N/A', Response: 'True' },
  { Title: 'Heat', Year: '1995', Rated: 'R', imdbID: 'tt0113277', Type: 'movie', Released: '15 Dec 1995', DVD: 'N/A', Response: 'True' },
  { Title: 'Total Recall', Year: '2012', Rated: 'PG-13', imdbID: 'tt1386703', Type: 'movie', Released: '03 Aug 2012', DVD: 'N/A', Response: 'True' },
  { Title: 'Total Recall', Year: '1990', Rated: 'R', imdbID: 'tt0100802', Type: 'movie', Released: '01 Jun 1990', DVD: 'N/A', Response: 'True' },
];
const norm = (s) => String(s ?? '').toLowerCase().replace(/\b(19|20)\d{2}\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
  if (u.hostname === 'www.omdbapi.com') {
    const p = u.searchParams;
    const miss = json({ Response: 'False', Error: 'Movie not found!' });
    if (p.get('i')) return json(OMDB.find((m) => m.imdbID === p.get('i')) ?? { Response: 'False', Error: 'Incorrect IMDb ID.' });
    if (p.get('t')) {
      const y = p.get('y');
      const hit = OMDB.find((m) => norm(m.Title) === norm(p.get('t')) && (!y || m.Year === y));
      return hit ? json(hit) : miss;
    }
    const hits = OMDB.filter((m) => norm(m.Title).includes(norm(p.get('s'))));
    return hits.length ? json({ Response: 'True', Search: hits }) : miss;
  }
  if (u.hostname === 'jf.test') {
    if (u.pathname !== '/Items') return json({ Items: [], SearchHints: [], TotalRecordCount: 0 });
    const p = u.searchParams;
    if (p.get('IncludeItemTypes') === 'Series') return json({ Items: [], TotalRecordCount: 0 });
    const any = p.get('AnyProviderIdEquals');
    let items = [];
    if (any) items = LIB;                                   // ignored, as the live 10.11.10 ignores it
    else if (p.get('searchTerm')) items = LIB.filter((i) => norm(i.Name).includes(norm(p.get('searchTerm'))));
    return json({ Items: items.slice(0, Number(p.get('Limit') ?? 1000)), TotalRecordCount: items.length });
  }
  return new Response('{}', { status: 404 });
};

/* ------------------------------ the rows ------------------------------ */

const historyRow = (who, id, request, iso, { status = 'not-in-library', title, year, rated = null, detail = 'not in library', group = MOVIES } = {}) => ({
  id, at: T(iso) + 400, requestedAt: T(iso), requester: who.name, requesterJid: who.jid, requesterNumber: who.number,
  requesterNumberDisplay: `+${who.number}`, groupJid: group, request, status, title, year, rated, detail,
});
const MIA_ROW = () => historyRow(MIA, '3A2821BE96D12C38067D', 'a snapshot of forever 2025', '2026-10-08T06:05:46Z',
  { title: 'A Snapshot of Forever', year: 2025 });
const NOACH_ROW = () => historyRow(NOACH, '3A77D363952E7C6CE2FD', 'my suicide 2009', '2026-09-14T14:25:44Z',
  { status: 'not-yet-theatrical', title: 'My Suicide', year: 2009, rated: 'Not Rated', detail: 'TMDB shows a theatrical release but no home release yet' });
const AIDEN_ROW = () => historyRow(AIDEN, 'AC947C1284406F50CFB21041E107578E', 'dune: part one (2021)', '2026-09-11T18:18:01Z',
  { title: 'Dune: Part One', year: 2021, rated: 'PG-13' });
const CHANA_ROW = () => historyRow(CHANA, '3AC0000000000000C4A1', 'a snapshot of forever', '2026-10-09T12:00:00Z',
  { title: 'A Snapshot of Forever', year: 2025 });
const DAN_HEAT_ROW = () => historyRow(DAN, '3AD0000000000000D0E1', 'heat 1995', '2026-10-10T20:00:00Z',
  { title: 'Heat', year: 1995, rated: 'R' });

const entry = (title, year, imdbId, extra = {}) => ({
  key: imdbId, title, year, imdbId, rated: null, reason: 'not-in-library', count: 1,
  firstAt: NOW - 3 * DAY, lastAt: NOW - 3 * DAY, requesters: [], requests: [], ...extra,
});
const SNAPSHOT_ENTRY = () => entry('A Snapshot of Forever', 2025, 'tt14074586',
  { requesters: ['Mia '], requests: ['a snapshot of forever 2025'], firstAt: T('2026-10-08T06:06:21Z'), lastAt: T('2026-10-08T06:06:21Z') });
const SUICIDE_OPEN = () => entry('My Suicide', 2009, 'tt0492896', { reason: 'not-yet-theatrical', requesters: ['Noah Fields'], requests: ['my suicide 2009'] });
// Resolved by the recheck at 08:57 on 2026-10-11, before re-runs began.
const SUICIDE_RESOLVED = () => entry('My Suicide', 2009, 'tt0492896', {
  reason: 'not-yet-theatrical', rated: 'Not Rated', requesters: ['Noah Fields'], firstAt: T('2026-09-14T14:25:48Z'),
  resolved: { by: 'the bot (found on the server as "My Suicide")', at: T('2026-10-11T08:56:47Z'), auto: true,
    as: { id: SUICIDE_2009.Id, title: 'My Suicide', year: 2009, imdbId: 'tt0492896' } },
});
const DUNE_OPEN = () => entry('Dune: Part One', 2021, 'tt1160419', { rated: 'PG-13', requesters: ['Alex Walker'], requests: ['dune: part one (2021)'] });
const DUNE_RESOLVED = () => entry('Dune: Part One', 2021, 'tt1160419', {
  rated: 'PG-13', requesters: ['Alex Walker'], requests: ['dune: part one (2021)'], firstAt: T('2026-09-11T18:18:32Z'),
  resolved: { by: 'the bot (found on the server as "Dune")', at: T('2026-10-11T08:57:06Z'), auto: true,
    as: { id: DUNE_2021.Id, title: 'Dune', year: 2021, imdbId: 'tt1160419' } },
});
const HEAT_ENTRY = () => entry('Heat', 1995, 'tt0113277', { rated: 'R', requesters: ['Dan Smith'], requests: ['heat 1995'] });

/* ------------------------------ the harness ------------------------------ */

function memStore(data = {}) {
  return {
    data,
    get: (k, d = null) => (k in data ? data[k] : d),
    set: (k, v) => { data[k] = v; return v; },
    push: (k, v, cap = 200) => { (data[k] ??= []).unshift(v); if (data[k].length > cap) data[k].length = cap; },
    flush: () => true,
  };
}

/**
 * One bot: the state store, a fake WhatsApp that records every action in
 * order, a queue that keeps what it is given, the real movie plugin, and the
 * wanted recheck and the arrival re-runs as src/index.js wires them: re-runs
 * begun at start, before the recheck's first run (unless `begin` is false),
 * and a pass after every run of the recheck. `h.tick()` is one run of the
 * recheck and the pass after it, done; `h.restart()` is the bot started
 * again on the same state.
 */
function harness({ wanted = [], history = [], pending = [], library = [SNAPSHOT_2022, SUICIDE_2009, DUNE_2021, HEAT_1995],
  rerunOnArrival = true, msgIndex = [], begin = true } = {}) {
  LIB = library;
  forgetProviderFilterSupport();
  const spaces = new Map();
  const stateStore = { namespace: (n) => { if (!spaces.has(n)) spaces.set(n, memStore()); return spaces.get(n); } };
  const movies = stateStore.namespace('movie-requests');
  movies.set('wanted', wanted);
  movies.set('history', history);
  movies.set('pending', pending);
  stateStore.namespace('msg-index').set('entries', msgIndex);

  const cfg = mergeDefaults({
    movieRequests: {
      requestGroups: [MOVIES], postsGroup: POSTS, notify: { group: NOTIFY }, requirePrefix: true, prefix: '#request',
      cooldownSecondsPerUser: 3600, replyOnBlock: false, blockedRatings: ['R', 'NC-17', 'X', 'TV-MA'],
    },
    wanted: { rerunOnArrival },
    web: { adminPasswordHash: 'x', users: [{ username: 'mommy', role: 'superadmin', passwordHash: 'x' }] },
  }, DEFAULT_CONFIG);
  cfg.omdb.apiKey = 'test-key';
  cfg.gemini = { ...cfg.gemini, enabled: false };
  cfg.library = mergeDefaults({ provider: 'jellyfin', jellyfin: { baseUrl: 'http://jf.test', authMethod: 'apikey', apiKey: 'KEY', userId: 'U1' } }, DEFAULT_CONFIG.library);
  Object.assign(cfg.media, { workDir: TMP });
  const configStore = { get: () => cfg, update(p) { if (p.wanted) Object.assign(cfg.wanted, p.wanted); }, redacted: () => ({}), onChange() {} };

  const ops = [];
  const bot = {
    ops, paced: 0, connected: true,
    isConnected() { return this.connected; },
    react: async (msg, emoji) => { ops.push({ op: 'react', id: msg?.key?.id ?? null, key: msg?.key ?? null, emoji }); return true; },
    sendText: async (jid, text) => { ops.push({ op: 'text', jid, text }); return { key: { id: `B${ops.length}`, remoteJid: jid } }; },
    editText: async () => true, deleteMessage: async () => {}, archiveChat: async () => {}, isGroupAdmin: () => false,
    groupMemberInfo: () => ({ isMember: false, mentionJid: null, mentionText: null }),
    groups: () => [], groupCache: new Map(), sameCommunity: () => false, groupMentionToken: (jid) => `@${jid.split('@')[0]}`,
    async _bulkPace() { this.paced += 1; ops.push({ op: 'pace' }); },
    on() {}, off() {}, state: 'connected',
  };
  const jobs = [];
  const queue = {
    maxLength: 50, pending: [], paused: false,
    add: (j) => { jobs.push(j); return `job-${jobs.length}`; }, snapshot: () => ({ pending: [], active: [] }), hasRoom: () => true,
  };
  const logs = [];
  const lg = (lvl) => (m) => logs.push(`${lvl} ${m}`);
  const log = { info: lg('info'), warn: lg('warn'), error: lg('error'), debug() {} };
  const ctx = { config: cfg, store: movies, bot, queue, linkQueue: queue, log, configStore, requestPause: null };
  moviePlugin._reactors = new Map();
  // Every run of the real pipeline, counted, and how many at once.
  const runs = { count: 0, inFlight: 0, max: 0 };
  const plugin = Object.create(moviePlugin);
  plugin.rerunArrived = async function counted(item, c) {
    runs.count += 1; runs.inFlight += 1; runs.max = Math.max(runs.max, runs.inFlight);
    try { return await moviePlugin.rerunArrived.call(moviePlugin, item, c); } finally { runs.inFlight -= 1; }
  };
  const pluginManager = { plugins: new Map([['movie-requests', { plugin, ctx }]]), notifyConfigChange: async () => {} };
  const requestPause = { paused: false, isPaused() { return this.paused; } };
  const lockdown = { locked: false };

  const h = {
    stateStore, spaces, movies, cfg, configStore, bot, ops, jobs, queue, logs, ctx, pluginManager, requestPause, lockdown, runs,
    passes: [],
    audit: () => stateStore.namespace('audit').get('events', []) ?? [],
    row: (id) => (movies.get('history', []) ?? []).find((r) => r.id === id),
    want: (key) => (movies.get('wanted', []) ?? []).find((w) => w.key === key),
    reactionsOn: (id) => ops.filter((o) => o.op === 'react' && o.id === id),
  };
  /** The bot's start, as src/index.js does it: re-runs begun, then the recheck, whose every run is followed by a pass. */
  h.start = ({ withBegin = true, withPass = true } = {}) => {
    h.arrivals = new ArrivalReruns({
      configStore, stateStore, bot, pluginManager, requestPause, isLocked: () => lockdown.locked, now: () => NOW, log,
    });
    if (withBegin) h.arrivals.begin();
    h.recheck = new WantedRecheck({
      configStore, stateStore, log, paceMs: 0, now: () => NOW,
      onRun: withPass ? () => { h.passes.push(h.arrivals.process('after the wanted recheck')); } : null,
    });
  };
  h.restart = (opts) => h.start(opts);
  /** One run of the recheck and the pass after it, both done. */
  h.tick = async (why = 'every 30 minutes') => {
    const found = await h.recheck.run(why);
    await settle(1);
    const out = await (h.passes.at(-1) ?? null);
    await h.arrivals._chain;
    return { found, out };
  };
  h.start({ withBegin: begin });
  return h;
}

/* ============================== Snapshot ============================== */

console.log('=== A Snapshot of Forever: the recheck finds it despite the year gap, and Mia\'s request is re-run as hers ===');
let snap;
{
  ok(yearRuleYields('year', 'tt14074586', 'tt14074586') && !yearRuleYields('year', 'tt14074586', 'tt99999999')
    && !yearRuleYields('year', 'tt14074586', null) && !yearRuleYields('film', 'tt14074586', 'tt14074586'),
  'the year rule gives way to the same IMDb id, and only to it, and only on the year');
  ok(yearRuleYields('year', 'tt14074586', 'tt14074586', { wantYear: 2025, gotYear: 2022 })
    && !yearRuleYields('year', 'tt1386703', 'tt1386703', { wantYear: 2012, gotYear: 1990 }),
  'three years apart it gives way (Snapshot); 22 apart it does not (a 1990 Total Recall tagged with the 2012 id)');
  ok(notTheFilm({ year: 2025, imdbId: 'tt14074586' }, { title: 'A Snapshot of Forever', year: 2022, imdbId: 'tt14074586' }) === null,
    'the recheck takes the 2022 copy with its id as the 2025 film');
  const realHit = await (async () => { LIB = [SNAPSHOT_2022]; forgetProviderFilterSupport();
    return findInLibrary('A Snapshot of Forever', 2025, harness().cfg.library, { alsoTry: ['a snapshot of forever 2025'], imdbId: 'tt14074586', typedYear: 2025 }); })();
  ok(realHit?.year === 2022 && realHit.imdbId === 'tt14074586', `findInLibrary finds it, typed year 2025 and all (${realHit?.title} ${realHit?.year})`);

  const h = harness({ wanted: [SNAPSHOT_ENTRY(), SUICIDE_RESOLVED()], history: [MIA_ROW(), NOACH_ROW()] });
  snap = h;
  const { found, out } = await h.tick();
  ok(found.found.length === 1 && found.found[0].key === 'tt14074586', 'the 30-minute recheck finds Snapshot on the server');
  const w = h.want('tt14074586');
  ok(w.resolved?.auto && w.resolved.as?.year === 2022 && /found on the server as "A Snapshot of Forever"/.test(w.resolved.by),
    `resolved by the bot with the 2022 copy (${w.resolved?.by})`);
  ok(w.arrival?.at === w.resolved.at && w.arrival.as?.year === 2022 && w.arrival.settled?.outcome === 're-run',
    `the find is kept on it as its arrival, settled by the pass after the recheck (${JSON.stringify(w.arrival?.settled)})`);
  ok(out?.reran?.length === 1 && out.settled.some((s) => s.key === 'tt14074586' && s.outcome === 're-run'), 'and that pass says what it did');

  const row = h.row(MIA_ROW().id);
  ok(row?.status === 'queued' && h.jobs.length === 1 && /A Snapshot of Forever/.test(h.jobs[0].label), `Mia's request is queued (${row?.status}, ${h.jobs.length} job)`);
  ok(row.rerun?.why === 'it arrived on the server' && row.rerun.trigger === 'arrival' && row.rerun.was?.status === 'not-in-library',
    `its History row is the re-run, saying why and what it was first (${JSON.stringify(row.rerun)})`);
  ok(row.requestedAt === MIA_ROW().requestedAt && row.requester === 'Mia ' && row.groupJid === MOVIES, 'still her request: when she sent it, who, where');
  ok(row.imdbId === 'tt14074586', 'and the row now carries the film\'s IMDb id');
  const reacts = h.reactionsOn(MIA_ROW().id);
  ok(reacts.length >= 2 && reacts.every((r) => r.key?.remoteJid === MOVIES && r.key.participant === MIA.jid && r.key.fromMe === false),
    'every reaction lands on her original message\'s key: her group, her message id, her participant id');
  ok(reacts.map((r) => r.emoji).join('') === `${h.cfg.movieRequests.reactions.researching}${h.cfg.movieRequests.reactions.added}`,
    `🔍 then 🎬 there (${reacts.map((r) => r.emoji).join(' ')})`);
  ok(h.ops.filter((o) => o.op === 'react').every((r) => r.id === MIA_ROW().id), 'and on no other message');
  ok(h.ops.some((o) => o.op === 'text' && o.jid === NOTIFY && /A Snapshot of Forever \(2025\) — added to the queue \(re-run: it arrived on the server\)/.test(o.text)),
    'the notifications group is told it is a re-run');
  ok(h.bot.paced === 1 && h.ops.findIndex((o) => o.op === 'pace') < h.ops.findIndex((o) => o.op === 'react'), 'paced with _bulkPace before it acted (rule 1)');
  ok(h.movies.get(LEDGER_KEY)?.[MIA_ROW().id]?.outcome === 'queued', 'the ledger says it was re-run, and how it went');
  ok(h.audit().some((e) => /re-ran Mia \+15550000001's request "a snapshot of forever 2025" - A Snapshot of Forever \(2025\) arrived on the server/.test(e.action)
    && e.detail === 'queued (the wanted recheck found it on the server)' && e.role === 'system'), 'an audit row says so');
  ok(w.reruns?.length === 1 && w.reruns[0].requester === 'Mia ' && w.reruns[0].outcome === 'queued' && w.reruns[0].ran
    && w.reruns[0].trigger === 'arrival', 'and the entry keeps what came of it');
  ok(!Object.keys(h.movies.data).some((k) => k.startsWith('cooldown:')), 'the cooldown is neither asked nor started: the bot owed her this');
  ok(h.logs.some((l) => /re-ran Mia .* arrived on the server: queued/.test(l)), 'and the log says it');

  const suicide = h.want('tt0492896');
  ok(suicide.arrival?.settled?.outcome === 'left for an admin' && !h.reactionsOn(NOACH_ROW().id).length,
    'My Suicide, resolved before re-runs began, is left for an admin: Noah is not re-run on deploy');
  ok(!(h.movies.get('library-misses') ?? []).length && h.movies.get('wanted').length === 2, 'nothing new on the wanted or not-in-library lists');
}

// The agreed design (2026-10-11): the trigger is the bot's own library, and
// nothing depends on Discord. The harness has no Discord account, token,
// channel or post: the re-run above came from the recheck alone.
console.log('=== a recheck find re-runs with no Discord configured at all ===');
{
  ok(!snap.cfg.discord?.token && !snap.cfg.discord?.watch?.channels?.length, 'no Discord account is connected, and no channel watched');
  ok(!snap.spaces.has('discord-reader'), 'the re-run never looked at the Discord reader\'s state');
  ok(!fs.readdirSync(TMP).some((f) => /discord/i.test(f)), 'nor at any file of it');
  ok(!('arrivalChannel' in DEFAULT_CONFIG.wanted), 'and the settings have no Discord channel for it: wanted.arrivalChannel is gone');
  for (const rel of ['src/core/wanted-arrival.js', 'src/core/wanted-recheck.js', 'src/core/wanted.js']) {
    ok(!/discord/i.test(codeOf(rel)), `${rel} has no Discord in its code`);
  }
  const index = codeOf('src/index.js');
  const reader = index.slice(index.indexOf('new DiscordWatch({'), index.indexOf('discordWatch.start()'));
  ok(reader && !/onRun|arriv/i.test(reader), 'src/index.js hands the Discord reader nothing of the re-runs');
  ok(/new WantedRecheck\(\{[^}]*onRun: \(\) => arrivalPass\('after the wanted recheck'\)/.test(index), 'the pass runs after each run of the recheck');
  ok(index.indexOf('arrivals.begin()') > 0 && index.indexOf('arrivals.begin()') < index.indexOf('wantedRecheck.start()'),
    'and re-runs are begun at start, before the recheck can resolve anything');
}

console.log('=== the Discord reader is untouched by this feature ===');
{
  // `git diff main...HEAD`: what a branch changed since it left main, the
  // working tree aside. A branch that changes the re-runs changes nothing in
  // the reader; one that does not (a fix to the reader, later) is not this
  // feature's to judge, nor is main itself. A clone without main (a
  // sandbox, a shallow checkout) cannot say, and says so.
  const git = (...args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const branchChanged = (file) => git('diff', 'main...HEAD', '--', file);
  let diff = null;
  let ours = false;
  try {
    git('rev-parse', '--verify', '--quiet', 'main^{commit}');
    ours = !!(branchChanged('src/core/wanted-arrival.js') || branchChanged('test/wanted-arrival.test.mjs'));
    diff = branchChanged('src/core/discord-watch.js');
  } catch { diff = null; }
  if (diff === null) console.log('  skip no main branch here to compare the Discord reader with');
  else if (!ours) console.log('  skip this branch does not change the arrival re-runs');
  else ok(diff === '', `git diff main...HEAD -- src/core/discord-watch.js is empty${diff ? `:\n${diff.slice(0, 400)}` : ''}`);
  const watch = source('src/core/discord-watch.js');
  ok(!/wanted|arrival|rerun|onRun/i.test(watch), 'and nothing in the reader knows of the wanted list or of re-runs');
  ok(!/discord-watch|discord-reader/.test(source('src/core/wanted-arrival.js')), 'nor does the re-run module import it');
}

/* ============================== before the first pass ============================== */

// The operator chooses which of the films resolved before this feature ran
// to re-run (the eight of the morning of 2026-10-11): "before" is recorded
// at the first pass, not worked out from times.
console.log('=== entries resolved before the first pass are recorded as handled, and not re-run ===');
{
  const h = harness({ wanted: [SUICIDE_RESOLVED(), DUNE_RESOLVED()], history: [NOACH_ROW(), AIDEN_ROW()] });
  const began = h.movies.get(ARRIVALS_BEGAN_KEY);
  ok(began?.at === NOW && began.handled === 2, `re-runs begin at start, with both resolved films recorded as handled (${JSON.stringify(began)})`);
  for (const key of ['tt0492896', 'tt1160419']) {
    const a = h.want(key).arrival;
    ok(a?.settled?.outcome === 'left for an admin' && /before arrival re-runs began - "Re-run requests" on its Wanted card/.test(a.settled.detail ?? '')
      && a.at === h.want(key).resolved.at, `${h.want(key).title}: left for an admin, and said why`);
  }
  ok(h.logs.some((l) => /^info arrival re-runs begin on this box: 2 films resolved on the wanted list before now are left for an admin/.test(l)),
    'the log says it once');
  await h.tick();
  ok(!h.runs.count && !h.bot.paced && !h.ops.length, 'the recheck and its pass re-run neither of them');
  h.restart();
  await h.tick('after start');
  ok(!h.runs.count && h.movies.get(ARRIVALS_BEGAN_KEY)?.handled === 2 && h.logs.filter((l) => /arrival re-runs begin/.test(l)).length === 1,
    'nor after a restart, which begins nothing again');

  // A recheck that runs before any pass has begun them begins them itself,
  // before it resolves anything: what it finds is its own, never "before".
  const r = harness({ wanted: [SNAPSHOT_ENTRY(), DUNE_RESOLVED()], history: [MIA_ROW(), AIDEN_ROW()], begin: false });
  ok(r.movies.get(ARRIVALS_BEGAN_KEY) === null, 'not begun yet');
  await r.tick();
  ok(r.movies.get(ARRIVALS_BEGAN_KEY)?.handled === 1 && r.want('tt1160419').arrival?.settled?.outcome === 'left for an admin',
    'the recheck\'s first find begins them: Dune, resolved before, is handled');
  ok(r.want('tt14074586').arrival?.settled?.outcome === 're-run' && r.row(MIA_ROW().id)?.status === 'queued'
    && r.row(AIDEN_ROW().id)?.status === 'not-in-library', 'and Snapshot, which it found, is re-run - Aiden is not');

  // A film resolved before, reopened by an admin and found again later, is
  // an arrival of its own: the line is drawn at the resolution.
  reopenWanted(h.movies, 'tt1160419', { by: 'mommy' });
  LIB = [DUNE_REIMPORT];
  forgetProviderFilterSupport();
  await h.tick();
  ok(h.want('tt1160419').resolved?.as?.id === DUNE_REIMPORT.Id && h.want('tt1160419').arrival?.settled?.outcome === 're-run'
    && h.row(AIDEN_ROW().id)?.status === 'queued', 'Dune, reopened and found again as another copy, is re-run for Aiden');
  // And a film an admin marks resolved has no find of the recheck behind it.
  const a = harness({ wanted: [SNAPSHOT_ENTRY()], history: [MIA_ROW()] });
  resolveWanted(a.movies, 'tt14074586', { by: 'mommy', at: NOW });
  await a.tick();
  ok(!a.runs.count && !a.want('tt14074586').arrival, 'a film an admin marks resolved is not re-run by itself');
}

/* ============================== once only ============================== */

console.log('=== once only: across rechecks, restarts and a second find ===');
{
  const h = snap;
  await h.tick();
  ok(h.jobs.length === 1 && h.bot.paced === 1, 'another recheck re-runs nothing');
  h.restart();
  await h.tick('after start');
  ok(h.jobs.length === 1 && h.bot.paced === 1, 'nor a restart');
  // Reopened by an admin, and found again as another copy (the host re-imported it).
  reopenWanted(h.movies, 'tt14074586', { by: 'mommy' });
  LIB = [SNAPSHOT_REIMPORT];
  forgetProviderFilterSupport();
  await h.tick();
  ok(h.want('tt14074586').resolved?.as?.id === SNAPSHOT_REIMPORT.Id && h.want('tt14074586').arrival?.settled?.outcome === 're-run',
    'found again: a new arrival, settled');
  ok(h.jobs.length === 1 && h.bot.paced === 1 && h.reactionsOn(MIA_ROW().id).length === 2, 'and Mia is not re-run twice: the ledger has her row');
  const still = rerunCandidates([{ ...MIA_ROW() }], SNAPSHOT_ENTRY(), { ledger: { [MIA_ROW().id]: { at: NOW, key: 'tt14074586' } }, now: NOW });
  ok(!still.run.length && !still.skip.length, 'a row in the ledger is never a candidate again, whatever its status');

  // The bot restarting between the recheck's find and the pass after it.
  const c = harness({ wanted: [SNAPSHOT_ENTRY()], history: [MIA_ROW()] });
  c.restart({ withPass: false });
  await c.tick();
  ok(c.want('tt14074586').resolved && c.want('tt14074586').arrival && !c.want('tt14074586').arrival.settled && !c.runs.count,
    'found, and the bot stops before its pass: the arrival is kept on the entry');
  c.restart();
  await c.tick('after start');
  ok(c.runs.count === 1 && c.row(MIA_ROW().id)?.status === 'queued', 'the first pass after the restart re-runs her');
  await c.tick();
  c.restart();
  await c.tick('after start');
  ok(c.runs.count === 1 && c.bot.paced === 1, 'once');
}

/* ============================== not the film ============================== */

console.log('=== a copy with another IMDb id, or none and years away, is still refused ===');
for (const [what, copy] of [['another IMDb id', SNAPSHOT_OTHER_ID], ['no IMDb id, three years off the year typed', SNAPSHOT_NO_ID]]) {
  const h = harness({ wanted: [SNAPSHOT_ENTRY()], history: [MIA_ROW()], library: [copy] });
  await h.tick();
  const w = h.want('tt14074586');
  ok(!w.resolved && !w.arrival, `${what}: it stays open, and nothing has arrived`);
  ok(!h.jobs.length && !h.ops.some((o) => o.op === 'react') && h.bot.paced === 0, `${what}: nothing is re-run, nothing said`);
}
{
  ok(notTheFilm({ year: 2025, imdbId: 'tt14074586' }, { title: 'A Snapshot of Forever', year: 2022, imdbId: 'tt99999999' }) === 'it is tt99999999, not tt14074586',
    'the recheck refuses a copy carrying another id');
  ok(notTheFilm({ year: 2025, imdbId: 'tt14074586' }, { title: 'A Snapshot of Forever', year: 2022 }) === 'it is from 2022, not 2025',
    'and one with no id three years off');
  // Found in review (2026-10-11): the first cut took any copy carrying the
  // id as the film, whatever its year, and skipped the file's rating check.
  const recall = entry('Total Recall', 2012, 'tt1386703', { rated: 'PG-13', requesters: ['Dan Smith'], requests: ['total recall 2012'] });
  const recallRow = historyRow(DAN, '3AD00000000000007E11', 'total recall 2012', '2026-10-10T20:00:00Z', { title: 'Total Recall', year: 2012, rated: 'PG-13' });
  const tr = harness({ wanted: [recall], history: [recallRow], library: [RECALL_MISTAGGED] });
  await tr.tick();
  ok(!tr.want('tt1386703').resolved && !tr.want('tt1386703').arrival,
    'a 1990 copy, rated R, carrying the 2012 film\'s id does not resolve the 2012 film');
  ok(!tr.jobs.length && !tr.ops.some((o) => o.op === 'react') && tr.bot.paced === 0 && tr.row(recallRow.id)?.status === 'not-in-library',
    'and Dan\'s request is not re-run into it');
}

/* ============================== named otherwise ============================== */

// The library names a film as its own catalogue does ("Dune"), the wanted
// list as OMDb does ("Dune: Part One"); the recheck looks it up as a
// request would, by IMDb id too. And a lookup that fails is tried again by
// the next recheck, half an hour on.
console.log('=== a film the library names otherwise is found by its IMDb id, and a failed lookup tried again ===');
{
  const h = harness({ wanted: [DUNE_OPEN()], history: [AIDEN_ROW()], library: [] });
  await h.tick();
  ok(!h.want('tt1160419').resolved && !h.runs.count, 'not on the server yet: nothing');
  LIB = [DUNE_2021];
  forgetProviderFilterSupport();
  await h.tick();
  const w = h.want('tt1160419');
  ok(w.resolved?.auto && w.resolved.as?.title === 'Dune' && w.arrival?.settled?.outcome === 're-run', 'the next recheck finds it as "Dune"');
  ok(h.row(AIDEN_ROW().id)?.status === 'queued' && h.jobs.length === 1 && h.reactionsOn(AIDEN_ROW().id).every((x) => x.key?.participant === AIDEN.jid),
    `and Aiden's request is re-run and queued, on his message (${h.row(AIDEN_ROW().id)?.status})`);

  const sw = entry('Star Wars: Episode IV - A New Hope', 1977, 'tt0076759', { rated: 'PG', requesters: ['🦇'], requests: ['star wars episode iv 1977'] });
  const SW_1977 = film('Star Wars', 1977, 'tt0076759', 'PG');
  const bat = historyRow({ jid: '100000000000006@lid', number: '15550000006', name: '🦇' }, 'AC48A317776E660A3DDE17CF96DECAFD',
    'star wars episode iv 1977', '2026-09-14T14:02:53Z', { title: 'Star Wars: Episode IV - A New Hope', year: 1977, rated: 'PG' });
  const s = harness({ wanted: [sw], history: [bat], library: [SW_1977] });
  const realFind = s.recheck.find;
  s.recheck.find = async () => { throw new Error('Jellyfin HTTP 503'); };
  await s.tick();
  ok(!s.want('tt0076759').resolved && !s.runs.count && s.logs.some((l) => /looking up .*Star Wars.* failed - it stays on the list: Jellyfin HTTP 503/.test(l)),
    'Jellyfin fails the lookup: it stays open, said, and nothing is re-run');
  s.recheck.find = realFind;
  await s.tick();
  ok(s.want('tt0076759').resolved?.auto && s.runs.count === 1 && s.row(bat.id)?.rerun?.why === 'it arrived on the server',
    `the next recheck finds it by its IMDb id, and 🦇's request is re-run (${s.row(bat.id)?.status})`);
}

/* ============================== pacing ============================== */

console.log('=== one at a time, each after _bulkPace, a burst included ===');
{
  const snapshot = SNAPSHOT_ENTRY();
  snapshot.requesters.push('❤️Hannah');
  const h = harness({
    wanted: [snapshot, SUICIDE_OPEN()], history: [MIA_ROW(), CHANA_ROW(), NOACH_ROW()], library: [SNAPSHOT_2022, SUICIDE_2009],
  });
  const { found } = await h.tick();
  ok(found.found.length === 2, 'one recheck finds two films');
  ok(h.runs.count === 3 && h.bot.paced === 3, `three requests re-run, three paces (${h.runs.count} run, ${h.bot.paced} paced)`);
  ok(h.runs.max === 1, 'never two at once');
  const firsts = [MIA_ROW().id, CHANA_ROW().id, NOACH_ROW().id].map((id) => h.ops.findIndex((o) => o.op === 'react' && o.id === id));
  const paces = h.ops.map((o, i) => (o.op === 'pace' ? i : -1)).filter((i) => i >= 0);
  ok(firsts.every((f, i) => f > paces[i] && (i === 0 || f > firsts[i - 1])), 'each request\'s first reaction comes after its own pace, in turn');
  ok(h.jobs.length === 2, `Snapshot is queued once and My Suicide once (${h.jobs.map((j) => j.label).join(', ')})`);
  ok(h.row(CHANA_ROW().id)?.status === 'duplicate', 'the second member asking for Snapshot is told it is already waiting, not queued twice');
  const order = [MIA_ROW().id, CHANA_ROW().id].map((id) => h.ops.findIndex((o) => o.op === 'react' && o.id === id));
  ok(order[0] < order[1], 'the member who asked first goes first');

  const cand = rerunCandidates([CHANA_ROW(), { ...CHANA_ROW(), id: 'OLDER', requestedAt: T('2026-10-08T12:00:00Z'), at: T('2026-10-08T12:00:00Z') }],
    SNAPSHOT_ENTRY(), { now: NOW });
  ok(cand.run.length === 1 && cand.run[0].id === CHANA_ROW().id && cand.skip[0]?.why === 'their later request for it is the one re-run',
    'a member who asked twice is re-run once, on the later message');
}

console.log('=== held while WhatsApp is down, requests are paused or the lockdown is on ===');
{
  const stop = harness({ wanted: [SNAPSHOT_ENTRY()], history: [MIA_ROW(), CHANA_ROW()] });
  stop.bot._bulkPace = async function pace() { this.paced += 1; if (this.paced === 2) this.connected = false; };
  await stop.tick();
  ok(stop.runs.count === 1 && !stop.want('tt14074586').arrival.settled, 'WhatsApp gone in the pace: the next is not handed over, and the arrival stays open');
  const left = stop.want('tt14074586').reruns.find((x) => x.rowId === CHANA_ROW().id);
  ok(left?.outcome === 'waiting' && !left.ran && /^stopped: WhatsApp is not connected - re-run at the next pass$/.test(left.why ?? ''),
    `the member it did not reach is recorded as waiting, and why (${left?.why})`);
  await stop.tick();
  ok(stop.runs.count === 1, 'the next recheck, WhatsApp still down: nothing');
  stop.bot.connected = true;
  await stop.tick();
  ok(stop.runs.count === 2 && stop.want('tt14074586').arrival.settled?.outcome === 're-run', 'reconnected: the pass after the next recheck runs her, once');
  const chanaRuns = stop.want('tt14074586').reruns.filter((x) => x.rowId === CHANA_ROW().id);
  ok(chanaRuns.length === 1 && chanaRuns[0].ran && chanaRuns[0].outcome === 'duplicate',
    `her waiting record gives way to what the re-run came to (${chanaRuns.map((x) => x.outcome).join(', ')})`);

  for (const [what, hold, release] of [
    ['WhatsApp is down', (h) => { h.bot.connected = false; }, (h) => { h.bot.connected = true; }],
    ['requests are paused', (h) => { h.requestPause.paused = true; }, (h) => { h.requestPause.paused = false; }],
    ['the lockdown is on', (h) => { h.lockdown.locked = true; }, (h) => { h.lockdown.locked = false; }],
  ]) {
    const h = harness({ wanted: [SNAPSHOT_ENTRY()], history: [MIA_ROW()] });
    hold(h);
    const { out } = await h.tick();
    ok(!h.runs.count && !h.ops.length && h.want('tt14074586').resolved && !h.want('tt14074586').arrival.settled && out?.waiting?.length === 1,
      `${what}: found and resolved, but nobody re-run or reacted to`);
    ok(h.logs.some((l) => /arrival: A Snapshot of Forever \(2025\) is on the server; its requests are re-run after the next recheck - /.test(l)),
      `${what}: and the log says it waits`);
    release(h);
    await h.tick();
    ok(h.runs.count === 1 && h.row(MIA_ROW().id)?.status === 'queued', `${what}: once that is over, the next recheck's pass re-runs her`);
  }
}

/* ============================== the gates ============================== */

console.log('=== the rating gate still refuses an R film for a main group ===');
{
  const h = harness({ wanted: [HEAT_ENTRY()], history: [DAN_HEAT_ROW()] });
  await h.tick();
  const row = h.row(DAN_HEAT_ROW().id);
  ok(h.want('tt0113277').resolved?.auto, 'the recheck finds Heat on the server');
  ok(row?.status === 'blocked-rating' && !h.jobs.length, `refused on its rating, nothing queued (${row?.status})`);
  ok(h.reactionsOn(DAN_HEAT_ROW().id).map((r) => r.emoji).includes(h.cfg.movieRequests.reactions.rated), '⛔ on Dan\'s own message');
  ok(h.want('tt0113277').reruns?.[0]?.outcome === 'blocked-rating', 'and the entry says so, for the report');
  const report = scan({ now: NOW + 5 * MIN, config: h.cfg, names: {}, unit: { ActiveState: 'active', NRestarts: '0' },
    state: { 'movie-requests': h.movies.data, 'tv-requests': {}, 'msg-index': { entries: [] }, audit: { events: [] } },
    memory: { v: 1, lastScanAt: NOW - HOUR, seen: {}, configCheckedAt: NOW }, tickets: [] });
  const found = report.notices.find((f) => f.kind === 'wanted-found');
  ok(found && /tell Dan Smith/.test(found.title) && found.items[0].toTell.some((t) => /refused by its rating/.test(t)),
    `the hourly report says he still needs telling, and why (${found?.items?.[0]?.toTell})`);
}

console.log('=== a film already waiting in the queue is not queued twice ===');
{
  const waiting = {
    jobKey: 'EARLIER:tt14074586', msgId: 'EARLIER', msgKey: null, chatJid: MOVIES,
    movie: { title: 'A Snapshot of Forever', year: 2025, imdbId: 'tt14074586', rated: null },
    meta: { requester: 'someone', group: MOVIES }, record: { id: 'EARLIER', status: 'queued' }, at: NOW - HOUR,
  };
  const h = harness({ wanted: [SNAPSHOT_ENTRY()], history: [MIA_ROW()], pending: [waiting] });
  await h.tick();
  ok(h.row(MIA_ROW().id)?.status === 'duplicate' && !h.jobs.length, 'answered as a duplicate, and nothing is queued');
  ok(h.reactionsOn(MIA_ROW().id).some((r) => r.emoji === h.cfg.movieRequests.reactions.duplicate), 'with the duplicate reaction on her message');
}

// Found in review (2026-10-11): only a requester's OWN later row stopped a
// re-run, and the pipeline's twin check sees only what is waiting. With
// Hannah's "a snapshot of forever 2022" sent to the posts group at 10:00,
// Mia's older "not in the library" was queued and posted there again.
console.log('=== a film posted since it arrived, with another member\'s request, is not posted again ===');
{
  const chanaSent = {
    ...historyRow(CHANA, '3AC0000000000000C4A9', 'a snapshot of forever 2022', '2026-10-11T10:00:00Z',
      { status: 'sent', title: 'A Snapshot of Forever', year: 2025, detail: 'copy, 1.40 GB' }),
    imdbId: 'tt14074586', finishedAt: T('2026-10-11T10:41:00Z'),
  };
  const h = harness({ wanted: [SNAPSHOT_ENTRY()], history: [chanaSent, MIA_ROW()] });
  await h.tick();
  ok(h.want('tt14074586').resolved?.auto && !h.jobs.length && h.runs.count === 0, 'the recheck finds it, and nothing is queued: the pipeline is not run for her');
  const row = h.row(MIA_ROW().id);
  ok(row?.status === 'sent' && /^posted since it arrived on the server, with ❤️Hannah's request for it$/.test(row.detail ?? '')
    && row.rerun?.why === 'it arrived on the server' && row.rerun.postedWith === chanaSent.id && row.rerun.was?.status === 'not-in-library',
  `her History row says it went out with Hannah's request, as a re-run (${row?.status}: ${row?.detail})`);
  const reacts = h.reactionsOn(MIA_ROW().id);
  ok(reacts.length === 1 && reacts[0].emoji === h.cfg.movieRequests.reactions.done && reacts[0].key?.participant === MIA.jid
    && reacts[0].key.remoteJid === MOVIES, `her own message is marked done, as a request that followed one is (${reacts.map((r) => r.emoji).join(' ')})`);
  ok(h.bot.paced === 1 && h.ops.findIndex((o) => o.op === 'pace') < h.ops.findIndex((o) => o.op === 'react'), 'paced with _bulkPace first (rule 1)');
  ok(!h.ops.some((o) => o.op === 'text'), 'and nothing is posted, to the posts group or any other');
  const w = h.want('tt14074586');
  ok(w.reruns?.[0]?.outcome === 'already-posted' && w.reruns[0].ran && h.movies.get(LEDGER_KEY)?.[MIA_ROW().id]?.outcome === 'already-posted',
    'the entry and the ledger keep it as already posted');
  ok(h.audit().some((e) => /re-ran Mia .*"a snapshot of forever 2025"/.test(e.action) && /^already-posted: posted since it arrived/.test(e.detail)),
    'an audit row says so');
  const report = scan({ now: NOW + 5 * MIN, config: h.cfg, names: {}, unit: { ActiveState: 'active', NRestarts: '0' },
    state: { 'movie-requests': h.movies.data, 'tv-requests': {}, 'msg-index': { entries: [] }, audit: { events: [] } },
    memory: { v: 1, lastScanAt: NOW - HOUR, seen: {}, configCheckedAt: NOW }, tickets: [] });
  const item = report.notices.find((f) => f.kind === 'wanted-found')?.items?.[0];
  ok(item?.queued?.includes('Mia (already-posted)') && !item.toTell.length, `the hourly report has nobody left to tell (${JSON.stringify(item?.toTell)})`);
  await h.tick();
  ok(h.bot.paced === 1 && h.reactionsOn(MIA_ROW().id).length === 1, 'and it is answered once only');

  const before = rerunCandidates([{ ...chanaSent, at: T('2026-10-07T10:00:00Z'), finishedAt: T('2026-10-07T10:40:00Z') }, MIA_ROW()],
    SNAPSHOT_ENTRY(), { now: NOW });
  ok(before.run.length === 1 && !before.posted.length, 'a copy sent before she asked is no answer to her: she is re-run');
  const test = rerunCandidates([{ ...chanaSent, route: { beta: true, postsGroup: 'beta-posts@g.us' }, test: 'beta004' }, MIA_ROW()],
    SNAPSHOT_ENTRY(), { now: NOW });
  ok(test.run.length === 1 && !test.posted.length, 'nor is a beta test\'s, which went to no main posts group');
}

console.log('=== a re-run that throws: ⚠️ on the member\'s message, a log line, a record ===');
{
  const h = harness({ wanted: [SNAPSHOT_ENTRY()], history: [MIA_ROW()] });
  h.pluginManager.plugins.get('movie-requests').plugin.rerunArrived = async () => { throw new Error('the library timed out'); };
  await h.tick();
  ok(h.reactionsOn(MIA_ROW().id).some((r) => r.emoji === h.cfg.movieRequests.reactions.failed && r.key?.participant === MIA.jid),
    'the failure reaction lands on her message');
  ok(h.movies.get(LEDGER_KEY)?.[MIA_ROW().id]?.outcome === 'error' && h.logs.some((l) => /^error re-run of Mia .* failed: the library timed out/.test(l)),
    'the ledger and the log say so - and it is not tried again by itself');
  ok(h.want('tt14074586').reruns?.[0]?.outcome === 'error' && h.audit().some((e) => /^error: the library timed out/.test(e.detail)),
    'the entry and the audit log keep it, for the report');
  await h.tick();
  ok(h.reactionsOn(MIA_ROW().id).length === 1, 'and the next recheck does not try it again');
}

console.log('=== wanted.rerunOnArrival off: nothing is re-run ===');
{
  const h = harness({ wanted: [SNAPSHOT_ENTRY()], history: [MIA_ROW()], rerunOnArrival: false });
  await h.tick();
  ok(h.want('tt14074586').resolved?.auto && !h.runs.count && !h.ops.length && h.want('tt14074586').arrival?.settled?.outcome === 'switched off',
    'switched off: found and resolved, no re-run, no reaction, and it says why');
  h.cfg.wanted.rerunOnArrival = true;
  await h.tick();
  ok(!h.runs.count, 'switched on again later, the find it settled is not re-run by itself');
  ok(DEFAULT_CONFIG.wanted.rerunOnArrival === true, 'it is on by default');
}

/* ============================== by hand ============================== */

console.log('=== "Re-run requests": POST /api/wanted/:key/rerun ===');
{
  const h = harness({
    wanted: [SNAPSHOT_ENTRY(), DUNE_RESOLVED(), SUICIDE_RESOLVED()],
    history: [MIA_ROW(), AIDEN_ROW(), NOACH_ROW()],
  });
  let signedIn = true;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (signedIn) req.session = { user: { username: 'mommy', role: 'superadmin' } }; next(); });
  const queue = new JobQueue({ concurrency: 1 });
  queue.pause();
  app.use('/api', createApiRouter({
    configStore: h.configStore, bot: h.bot, queue, linkQueue: queue, pluginManager: h.pluginManager, stateStore: h.stateStore,
    fileLogger: { tail: () => [] }, alerts: {}, lockScheduler: {}, requestPause: h.requestPause, arrivals: h.arrivals,
  }));
  const server = await new Promise((r) => { const sv = app.listen(0, () => r(sv)); });
  const call = (method, p, body = null) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const rq = http.request({ host: '127.0.0.1', port: server.address().port, method, path: p,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }));
    });
    rq.on('error', reject);
    if (data) rq.write(data);
    rq.end();
  });
  const drain = () => h.arrivals._chain;

  signedIn = false;
  ok((await call('POST', '/api/wanted/tt1160419/rerun')).status === 401 && !h.runs.count, 'not signed in: 401, nothing re-run');
  signedIn = true;
  ok((await call('POST', '/api/wanted/tt14074586/rerun')).status === 409, 'an open entry: 409 - the film is not on the server as far as the bot knows');
  h.bot.connected = false;
  const down = await call('POST', '/api/wanted/tt1160419/rerun');
  ok(down.status === 409 && /WhatsApp is not connected/.test(down.body?.error ?? ''), `WhatsApp down: 409, said (${down.body?.error})`);
  h.bot.connected = true;

  const r = await call('POST', '/api/wanted/tt1160419/rerun');
  ok(r.status === 200 && r.body.run.length === 1 && r.body.run[0].requester === 'Alex Walker', `Dune, left for an admin: Aiden's request will be re-run (${JSON.stringify(r.body?.run)})`);
  await drain();
  const row = h.row(AIDEN_ROW().id);
  ok(row?.status === 'queued' && row.rerun?.trigger === 'manual' && row.rerun.by === 'mommy', `it is re-run through the pipeline, by mommy (${row?.status})`);
  ok(h.reactionsOn(AIDEN_ROW().id).length >= 2 && h.reactionsOn(AIDEN_ROW().id).every((x) => x.key?.participant === AIDEN.jid), 'reacting on his own message');
  ok(h.bot.paced === 1, 'paced like any re-run');
  ok(h.audit().some((e) => e.user === 'mommy' && /^asked to re-run the requests for "Dune: Part One \(2021\)" by hand: 1 member\(s\), each audited as it runs/.test(e.action)),
    'the click is audited under the admin\'s name, as asked for - each re-run is audited as it runs');
  ok(!h.want('tt1160419').rerunPending, 'and once every request has been handed over, nothing is left pending');
  ok(h.audit().some((e) => e.user === 'mommy' && e.role === 'admin' && /re-ran Alex Walker .*'s request "dune: part one \(2021\)"/.test(e.action)), 'and the re-run itself');
  const twice = await call('POST', '/api/wanted/tt1160419/rerun');
  await drain();
  ok(twice.status === 200 && twice.body.run.length === 0 && h.runs.count === 1, 'pressed again: nothing to re-run - never twice');
  ok(h.audit().some((e) => /there was none to re-run/.test(e.action)), 'and that is audited too');

  const noach = await call('POST', '/api/wanted/tt0492896/rerun');
  await drain();
  ok(noach.status === 200 && h.row(NOACH_ROW().id)?.status === 'queued', 'My Suicide, left for an admin, is re-run for Noah when one asks');

  const st = await call('POST', '/api/wanted/settings', { rerunOnArrival: false });
  ok(st.status === 200 && h.cfg.wanted.rerunOnArrival === false && st.body.settings.rerunOnArrival === false, 'the card\'s switch saves the setting');
  ok(h.audit().some((e) => /switched off re-running requests/.test(e.action)), 'audited');
  ok((await call('POST', '/api/wanted/settings', { rerunOnArrival: 'yes' })).status === 400, 'and takes only true or false');
  const got = await call('GET', '/api/wanted');
  ok(got.body.settings?.rerunOnArrival === false && !('arrivalChannel' in got.body.settings), 'GET /wanted shows it for the card, and no Discord channel');
  server.close();
}

// Found in review (2026-10-11): an admin's "Re-run requests" for Dune that
// WhatsApp interrupted re-ran Aiden and dropped Hannah for good - nothing
// revisits a manual re-run - while the log said "the rest go at the next
// pass", the audit said both had been re-run, and the hourly report said
// she had no request left in History.
console.log('=== an admin\'s re-run stopped part-way is finished at the next pass, and said truly ===');
{
  const dune = DUNE_RESOLVED();
  dune.requesters.push('❤️Hannah');
  const chanaDune = historyRow(CHANA, '3AC00000000000000D21', 'dune 2021', '2026-09-20T10:00:00Z', { title: 'Dune: Part One', year: 2021, rated: 'PG-13' });
  const h = harness({ wanted: [dune], history: [AIDEN_ROW(), chanaDune] });
  h.bot._bulkPace = async function pace() { this.paced += 1; this.ops.push({ op: 'pace' }); if (this.paced === 2) this.connected = false; };
  const r = await h.arrivals.rerun('tt1160419', { by: 'mommy' });
  ok(r.stopped && h.runs.count === 1 && h.row(AIDEN_ROW().id)?.status === 'queued' && h.row(chanaDune.id)?.status === 'not-in-library',
    'WhatsApp drops in the second pace: Aiden is re-run, Hannah not yet');
  ok(h.want('tt1160419').rerunPending?.by === 'mommy', 'the admin\'s re-run stays pending on the entry');
  const rec = h.want('tt1160419').reruns.find((x) => x.rowId === chanaDune.id);
  ok(rec?.outcome === 'waiting' && rec.by === 'mommy' && /^stopped: WhatsApp is not connected - re-run at the next pass$/.test(rec.why ?? ''),
    `her request is recorded as waiting, and why (${rec?.why})`);
  ok(h.audit().some((e) => e.user === 'mommy' && e.role === 'admin'
    && /^stopped re-running the requests for Dune: Part One \(2021\) - WhatsApp is not connected$/.test(e.action)
    && /^1 left for the next pass: ❤️Hannah/.test(e.detail)), `the stop is audited, naming her (${h.audit().map((e) => e.action).join(' | ')})`);
  ok(h.logs.some((l) => /re-runs for Dune: Part One \(2021\): stopped - WhatsApp is not connected; ❤️Hannah .* waits for the next pass/.test(l)),
    'and the log says it truly');
  const report = (at) => scan({ now: at, config: h.cfg, names: {}, unit: { ActiveState: 'active', NRestarts: '0' },
    state: { 'movie-requests': h.movies.data, 'tv-requests': {}, 'msg-index': { entries: [] }, audit: { events: [] } },
    memory: { v: 1, lastScanAt: NOW - HOUR, seen: {}, configCheckedAt: NOW }, tickets: [] }).notices.find((f) => f.kind === 'wanted-found');
  const mid = report(NOW + MIN)?.items?.[0];
  ok(mid?.waiting?.some((s) => /^❤️Hannah \(stopped: WhatsApp is not connected/.test(s)) && !mid.toTell.some((s) => /Hannah/.test(s)),
    `the hourly report has her waiting for the next pass, not "no request left in History" (${JSON.stringify(mid?.toTell)})`);

  await h.tick();
  ok(h.runs.count === 1, 'the pass after a recheck while WhatsApp is still down runs nothing');
  h.bot.connected = true;
  await h.tick();
  ok(h.runs.count === 2 && h.row(chanaDune.id)?.status === 'duplicate' && h.jobs.length === 1,
    `the next pass re-runs Hannah, as the pipeline answers her: Aiden's Dune is waiting (${h.row(chanaDune.id)?.status})`);
  ok(h.reactionsOn(chanaDune.id).length && h.reactionsOn(chanaDune.id).every((x) => x.key?.participant === CHANA.jid), 'on her own message');
  ok(!h.want('tt1160419').rerunPending, 'and nothing is left pending');
  const chana = h.want('tt1160419').reruns.filter((x) => x.rowId === chanaDune.id);
  ok(chana.length === 1 && chana[0].ran && chana[0].trigger === 'manual' && chana[0].by === 'mommy', 'her record is the re-run, the admin\'s');
  await h.tick();
  ok(h.runs.count === 2, 'and never twice');
  const after = report(NOW + 2 * MIN)?.items?.[0];
  ok(after?.queued?.some((s) => /Hannah/.test(s)) && !after.waiting.length && !after.toTell.length, 'the report has her on her way');

  // A member named on the entry whose request nothing has re-run yet is
  // "not re-run yet", not "no request left in History".
  const pend = harness({ wanted: [{ ...DUNE_RESOLVED(), requesters: ['Alex Walker', '❤️Hannah'],
    reruns: [{ at: NOW - MIN, rowId: AIDEN_ROW().id, requester: 'Alex Walker', ran: true, outcome: 'queued', trigger: 'manual', by: 'mommy' }] }],
  history: [AIDEN_ROW(), chanaDune] });
  const told = scan({ now: NOW, config: pend.cfg, names: {}, unit: { ActiveState: 'active', NRestarts: '0' },
    state: { 'movie-requests': pend.movies.data, 'tv-requests': {}, 'msg-index': { entries: [] }, audit: { events: [] } },
    memory: { v: 1, lastScanAt: NOW - HOUR, seen: {}, configCheckedAt: NOW }, tickets: [] }).notices.find((f) => f.kind === 'wanted-found');
  ok(told?.items?.[0]?.toTell?.some((s) => /^❤️Hannah \(not re-run yet - resolved before the bot re-ran arrivals by itself/.test(s)),
    `${JSON.stringify(told?.items?.[0]?.toTell)}`);

  // Reopened meanwhile: the admin who reopened it says the server lacks it.
  const re = harness({ wanted: [{ ...DUNE_RESOLVED(), resolved: null, rerunPending: { by: 'mommy', at: NOW - HOUR } }], history: [AIDEN_ROW()], library: [] });
  await re.tick();
  ok(!re.runs.count && !re.want('tt1160419').rerunPending && re.logs.some((l) => /re-run is dropped - the film was reopened/.test(l)),
    'a pending re-run of an entry reopened meanwhile is dropped, and said');
  // And an arrival whose find was undone before its pass ran is re-run for nobody.
  const undone = harness({ wanted: [SNAPSHOT_ENTRY()], history: [MIA_ROW()] });
  undone.bot.connected = false;
  await undone.tick();
  reopenWanted(undone.movies, 'tt14074586', { by: 'mommy' });
  undone.bot.connected = true;
  LIB = [];
  await undone.tick();
  ok(!undone.runs.count && undone.want('tt14074586').arrival?.settled?.outcome === 'reopened'
    && undone.logs.some((l) => /A Snapshot of Forever \(2025\) was opened again before its requests were re-run/.test(l)),
  'a find an admin reopened before its pass is settled as reopened, and nobody is re-run');
}

/* ============================== the message ============================== */

console.log('=== the original message, rebuilt ===');
{
  const m = messageFor(MIA_ROW(), { indexed: { i: MIA_ROW().id, g: MOVIES, p: '199999999999999@lid', t: 1, y: 'extendedTextMessage' }, prefix: '#request' });
  ok(m.key.participant === '199999999999999@lid' && m.messageType === 'extendedTextMessage', 'the msg-index\'s participant and type, while it has the message');
  const n = messageFor(MIA_ROW(), { prefix: '#request' });
  ok(n.key.participant === MIA.jid && n.key.id === MIA_ROW().id && n.key.remoteJid === MOVIES && n.text === '#request a snapshot of forever 2025',
    'else the row\'s own: the same key the member\'s message had');
  const old = rerunCandidates([{ ...MIA_ROW(), requestedAt: NOW - 61 * DAY, at: NOW - 61 * DAY }], SNAPSHOT_ENTRY(), { now: NOW });
  ok(!old.run.length && /more than 60 days/.test(old.skip[0]?.why ?? ''), 'a request over 60 days old is not re-run');
  const sent = rerunCandidates([MIA_ROW(), { ...MIA_ROW(), id: 'panel-1', request: `jellyfin:${SNAPSHOT_2022.Id}`, status: 'sent', title: 'A Snapshot of Forever',
    year: 2022, at: NOW - HOUR }], { ...SNAPSHOT_ENTRY(), resolved: { auto: true, at: NOW - 2 * HOUR, as: { id: SNAPSHOT_2022.Id, title: 'A Snapshot of Forever', year: 2022 } } }, { now: NOW });
  ok(!sent.run.length && sent.skip.some((x) => x.why === 'had it queued or sent since'), 'a member sent it from the panel since is skipped (X2, Ethan Adams)');
}

/* ============================== the report ============================== */

console.log('=== the hourly report: who was re-run, and who to tell ===');
{
  const snapshot = { ...SNAPSHOT_ENTRY(), resolved: { by: 'the bot (found on the server as "A Snapshot of Forever")', at: NOW - 20 * MIN, auto: true,
    as: { title: 'A Snapshot of Forever', year: 2022 } },
  arrival: { at: NOW - 20 * MIN, settled: { at: NOW - 19 * MIN, outcome: 're-run' } },
  reruns: [{ at: NOW - 19 * MIN, rowId: 'M1', requester: 'Mia ', ran: true, outcome: 'queued', trigger: 'arrival' }] };
  // Resolved by the recheck the morning re-runs began, before they did.
  const guardians = { ...entry('Guardians of the Galaxy: Vol. 2', 2017, 'tt3896198'), requesters: ['Sol Stone'],
    resolved: { by: 'the bot (found on the server as "Guardians of the Galaxy Vol. 2")', at: NOW - 15 * MIN, auto: true, as: { title: 'Guardians of the Galaxy Vol. 2', year: 2017 } },
    arrival: { at: NOW - 15 * MIN, settled: { at: NOW - 10 * MIN, outcome: 'left for an admin' } }, reruns: [] };
  // Found by a member's new request, not by the recheck.
  const x2 = { ...entry('X2: X-Men United', 2003, 'tt0290334'), requesters: ['Ethan Adams'],
    resolved: { by: 'the bot (found on the server as "X2" when it was asked for again)', at: NOW - 5 * MIN, auto: true, as: { title: 'X2', year: 2003 } } };
  // Resolved days ago, before re-runs began: their beginning is no news of it.
  const wicked = { ...entry('Wicked', 2024, 'tt1262426'), requesters: ['Dan Smith'],
    resolved: { by: 'the bot (found on the server as "Wicked")', at: NOW - 3 * DAY, auto: true, as: { title: 'Wicked', year: 2024 } },
    arrival: { at: NOW - 3 * DAY, settled: { at: NOW - 10 * MIN, outcome: 'left for an admin' } } };
  // Resolved before re-runs began too, by a member whose request has since
  // left History: the card's button has nothing of theirs to re-run.
  const paddington = { ...entry('Paddington 2', 2017, 'tt4468740'), requesters: ['Alex Walker'],
    resolved: { by: 'the bot (found on the server as "Paddington 2")', at: NOW - 15 * MIN, auto: true, as: { title: 'Paddington 2', year: 2017 } },
    arrival: { at: NOW - 15 * MIN, settled: { at: NOW - 10 * MIN, outcome: 'left for an admin' } }, reruns: [] };
  // Found by the recheck five hours ago, its pass held (WhatsApp down) until
  // ten minutes ago, when it found no request left in History to re-run.
  const alabama = { ...entry('Stars Fell on Alabama', 2021, 'tt11000001'), requesters: ['Dan Smith'],
    resolved: { by: 'the bot (found on the server as "Stars Fell on Alabama")', at: NOW - 5 * HOUR, auto: true, as: { title: 'Stars Fell on Alabama', year: 2021 } },
    arrival: { at: NOW - 5 * HOUR, settled: { at: NOW - 10 * MIN, outcome: 're-run', detail: '0 re-run, 0 not' } }, reruns: [] };
  const history = [
    historyRow({ ...AIDEN, name: 'Sol Stone' }, '3AE0000000000000E001', 'guardians of the galaxy 2', '2026-09-20T18:00:00Z',
      { title: 'Guardians of the Galaxy: Vol. 2', year: 2017 }),
    historyRow({ ...DAN, name: 'Ethan Adams' }, '3AE0000000000000E002', 'x2', '2026-10-01T18:00:00Z', { title: 'X2: X-Men United', year: 2003 }),
  ];
  const cfg = mergeDefaults({}, DEFAULT_CONFIG);
  const r = scan({ now: NOW, config: cfg, names: {}, unit: { ActiveState: 'active', NRestarts: '0' },
    state: { 'movie-requests': { wanted: [snapshot, guardians, x2, wicked, paddington, alabama], history, pending: [] },
      'tv-requests': {}, 'msg-index': { entries: [] }, audit: { events: [] } },
    memory: { v: 1, lastScanAt: NOW - HOUR, seen: {}, configCheckedAt: NOW }, tickets: [] });
  const n = r.notices.find((f) => f.kind === 'wanted-found');
  const told = (title) => n?.items?.find((i) => i.title.startsWith(title))?.toTell ?? [];
  ok(/A Snapshot of Forever \(2025\) \(queued for Mia\)/.test(n?.title ?? ''), `Snapshot: queued for Mia (${n?.title})`);
  ok(/Guardians of the Galaxy: Vol\. 2 \(2017\) \(tell Sol Stone\)/.test(n?.title ?? ''), 'Guardians: Sol Stone still to tell');
  ok(n.evidence.some((l) => /Guardians.*still to tell: Sol Stone \(not re-run yet - resolved before the bot re-ran arrivals by itself - "Re-run requests" on its Wanted card re-runs it\)/.test(l)),
    'with why: resolved before re-runs began, and her request still in History, so the card\'s Re-run requests is how');
  ok(n.evidence.some((l) => /X2: X-Men United.*still to tell: Ethan Adams \(not re-run yet - found when a member asked for it again, not by the wanted recheck, so not re-run by itself - "Re-run requests" on its Wanted card/.test(l)),
    'and a film a new request found: not the recheck\'s find, so the card\'s Re-run requests too');
  ok(/^Alex Walker \(resolved before the bot re-ran arrivals by itself, and no request of theirs for it is left in History \(it keeps the last 200\), so there is no message to react to - tell them by hand\)$/
    .test(told('Paddington 2')[0] ?? '') && !/Re-run requests/.test(told('Paddington 2')[0] ?? ''),
  `resolved before re-runs began with no request of theirs left in History: tell them by hand, not the button, which would find none (${told('Paddington 2')[0]})`);
  ok(/^Dan Smith \(found by the wanted recheck, which re-ran what History still had - no request of theirs for it is left in History/.test(told('Stars Fell on Alabama')[0] ?? ''),
    `a find whose pass was held for hours is news when the pass settles it, and says what it came to (${told('Stars Fell on Alabama')[0]})`);
  ok(n.evidence.some((l) => /A Snapshot of Forever.*re-run and on its way to Mia \(queued\) - nobody left to tell/.test(l)), 'and nobody left to tell for Snapshot');
  ok(!n.items.some((i) => /Wicked/.test(i.title)), 'a film resolved days ago is not news because re-runs began today');
  ok(!/Discord|request bot|announced/i.test(JSON.stringify(n)), 'and the notice says nothing of Discord posts');
}

/* ======================= the report, for what History lacks ======================= */

// Found in review, 2026-10-11: a film the recheck found and re-ran, whose
// requester had no row left in History - it keeps 200, about 30 days on the
// live box, while re-runs reach back 60 - was reported as "found when a
// member asked for it again, not by the wanted recheck", and the operator
// sent to "Re-run requests", which would find no row either. So was a
// member whose re-run the bot was stopped in the middle of handing over.
const reportOf = (h) => scan({ now: NOW, config: h.cfg, names: {}, unit: { ActiveState: 'active', NRestarts: '0' },
  state: { 'movie-requests': h.movies.data, 'tv-requests': {}, 'msg-index': { entries: [] }, audit: { events: [] } },
  memory: { v: 1, lastScanAt: NOW - HOUR, seen: {}, configCheckedAt: NOW }, tickets: [] }).notices.find((f) => f.kind === 'wanted-found');

console.log('=== a recheck find whose requester\'s request has aged out of History: the report says to tell her by hand ===');
{
  const h = harness({ wanted: [SNAPSHOT_ENTRY()], history: [] });
  await h.tick();
  const w = h.want('tt14074586');
  ok(w.resolved?.auto && w.arrival?.settled?.outcome === 're-run' && !h.runs.count && !h.ops.some((o) => o.op === 'react'),
    'the recheck finds Snapshot and its pass settles it, with no request of Mia\'s in History to re-run or react to');
  ok(h.logs.some((l) => /re-runs for A Snapshot of Forever \(2025\): no request answered "not in the library" for it to re-run/.test(l)), 'and the log says so');
  const tell = reportOf(h)?.items?.[0]?.toTell ?? [];
  ok(tell.length === 1 && /^Mia \(found by the wanted recheck, which re-ran what History still had - no request of theirs for it is left in History \(it keeps the last 200\), so there is no message to react to - tell them by hand\)$/.test(tell[0]),
    `the report says the recheck found it, and that she is to be told by hand (${tell[0]})`);
  ok(!tell.some((s) => /asked for it again|not by the wanted recheck|Re-run requests/.test(s)),
    'not that a member\'s request found it, and not the card\'s button, which has nothing of hers to re-run');
}

console.log('=== a re-run the bot was stopped in the middle of: never run twice, and the report says to check it ===');
{
  // She asked twice; her later request is the one re-run, and the earlier
  // one is recorded as skipped for it - "re-run already" after the restart.
  const earlier = { ...MIA_ROW(), id: '3A2821BE96D12C38067C', request: 'a snapshot of forever',
    requestedAt: T('2026-10-07T06:00:00Z'), at: T('2026-10-07T06:00:00Z') + 400 };
  const h = harness({ wanted: [SNAPSHOT_ENTRY()], history: [MIA_ROW(), earlier] });
  const p = h.pluginManager.plugins.get('movie-requests').plugin;
  const counted = p.rerunArrived;
  // The bot dies while handing her request over: the call never returns.
  p.rerunArrived = () => new Promise(() => {});
  await h.recheck.run('every 30 minutes');
  await settle(5);
  ok(h.movies.get(LEDGER_KEY)?.[MIA_ROW().id]?.outcome === 'started' && !h.want('tt14074586').arrival?.settled,
    'the ledger has her re-run begun, with no outcome, and the find unsettled');
  p.rerunArrived = counted;
  h.restart();
  await h.tick('after start');
  ok(!h.runs.count && h.want('tt14074586').arrival?.settled?.outcome === 're-run', 'after the restart her request is not handed over again, and the find is settled');
  ok(h.want('tt14074586').reruns?.some((x) => x.rowId === earlier.id && !x.ran && /re-run already/.test(x.why ?? '')),
    'her earlier request is recorded as skipped: re-run already');
  const tell = reportOf(h)?.items?.[0]?.toTell ?? [];
  ok(tell.length === 1 && /^Mia \(its re-run began 2026-10-11 15:00Z and has no outcome - unless it is being handed over right now, the bot stopped part-way, and it never re-runs a request twice: see whether History has it queued, and tell them by hand if not\)$/.test(tell[0]),
    `the report says her re-run began and never finished, and what to do (${tell[0]})`);
  ok(!tell.some((s) => /asked for it again|not by the wanted recheck/.test(s)), 'not that a member\'s request found it');
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
