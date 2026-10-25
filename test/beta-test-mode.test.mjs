/* The beta group takes tests only: a request there needs a test code, and a test downloads nothing.
   Run: node test/beta-test-mode.test.mjs

   The operator, 2026-09-29, about the "Testing things" group:
     "For beta001 on the testing group if someone requests stam a movie it
     should be ignored as were trying to test something. I think we should
     make it that people on the group should need to prefix $beta001
     #request-movie harry potter if someone requests a regular movie like
     captain Phillips it should be ignored because it's not the beta"
   and
     "Also being that it's just testing as soon as bot can confirm it will
     download it should basically be like "test passed" and not actually
     queue a download of the file interrupting actual requests"

   Until then every request in the beta group was a full request: a tester's
   "#request harry potter" queued the Deathly Hallows (log 16:58:03 that
   day, cancelled by an admin), in the same queue as the members' films. The
   cases below pin the new rules through the real plugins, with OMDb and
   Jellyfin answered by a stubbed fetch and a WhatsApp that records every
   outbound action: a message without a code is ignored completely; a code
   nothing is tested under gets ❓ and the tests running; a request of the
   other kind than the code's feature is told so; a test runs every check and
   answers "✅ Test passed" where it would be queued, with nothing queued,
   journalled or downloaded; a refusal is answered as it always is, and adds
   nothing to the operator's wanted and not-in-library lists; the main
   groups are unchanged; and the digest does not count a test as a request.

   Found in review of that change, the same day, and pinned below:
   - A coded test without the group's prefix ("$BETA001 harry potter") was
     dropped by the prefix rule without a word, or, with "delete
     non-requests" on, deleted with a DM telling the tester to send it
     without the code - which the beta group then ignored.
   - Every line the bot suggests copying ("Send e.g. *#request Fullmetal
     Alchemist: Brotherhood season 1*", "add a word or the year, e.g.
     #request ...", "Send #request Venom 2018", the expired list's line)
     left the code out, so a tester who did as told was ignored.
   - "$beta001: harry potter" read "beta001:" as the code, and was told
     "❓ $beta001: is not a test. Running tests: $beta001, ...".
   - A test's list still said "Reply with a number (1-3) to download".
   - The hourly check still researched a test's 📬 "not in the library", or
     its row a restart turned 'lost', as a member's fault.

   On 2026-10-11 beta001, the "which one?" list these cases were first
   written around, left beta for every group, and its code was retired (see
   test/pick-list.test.mjs for why). The film tests below are asked under
   $beta004, the duplicate notice, and get the list as any request does now;
   "$beta001 ..." is answered ❓, pointed at $stamtest. */
import './fixtures/roomy-disk.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import moviePlugin from '../src/plugins/movie-requests/index.js';
import tvPlugin from '../src/plugins/tv-requests/index.js';
import { DEFAULT_CONFIG, mergeDefaults } from '../src/config/schema.js';
import {
  readBetaTest, runningTestsLine, testRequestText, testersGuide, suggestPrefix, testCodeFor, FEATURES,
} from '../src/core/beta.js';
import {
  formatPickList, formatExpired, needYearNote, narrowDownText, requestPrefix,
} from '../src/plugins/movie-requests/pick-list.js';
import { scan } from '../src/core/incident-scan.js';
import { buildDigest } from '../src/core/daily-digest.js';
import { summarise } from '../src/core/activity-backup.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const TESTING = '120363900000000013@g.us';        // "Testing things"
const MAIN_REQ = 'movie-requests@g.us';
const MAIN_POSTS = 'movie-posts@g.us';
const MAIN_NOTIFY = 'movie-notify@g.us';
const TV_REQ = 'tv-requests@g.us';
const TV_POSTS = 'tv-posts@g.us';
const MAIN = [MAIN_REQ, MAIN_POSTS, MAIN_NOTIFY, TV_REQ, TV_POSTS];

/* ============================ fixtures ============================ */

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
  .replace(/^(the|a|an)\s+/, '');
let fid = 0;
const film = (Name, ProductionYear, OfficialRating) => ({
  Id: `jf${++fid}`, Name, ProductionYear, OfficialRating, Type: 'Movie',
  MediaSources: [{ Path: `/nowhere/${Name}.mkv`, Size: 1_500_000_000, Container: 'mp4' }],
});
const LIBRARY = [
  film("Harry Potter and the Sorcerer's Stone", 2001, 'PG'),
  film('Harry Potter and the Chamber of Secrets', 2002, 'PG'),
  film('Harry Potter and the Prisoner of Azkaban', 2004, 'PG'),
  film('Captain Phillips', 2013, 'PG-13'),
  film('Heat', 1995, 'R'),
];
const OMDB = [
  ...LIBRARY.map((f, i) => ({ Title: f.Name, Year: String(f.ProductionYear), Rated: f.OfficialRating, imdbID: `tt${2000000 + i}` })),
  // Known to OMDb, not on the server: the not-in-library refusal.
  { Title: 'The Muppet Movie', Year: '1979', Rated: 'G', imdbID: 'tt0079588' },
].map((m) => ({ ...m, Type: 'movie', Released: 'N/A', DVD: 'N/A', Plot: 'A plot.', Response: 'True' }));

// Fullmetal Alchemist: Brotherhood season 1, where 14, 19 and 26 are TV-MA
// (the incident in test/tv-rating-withheld.test.mjs).
const FMA = 'Fullmetal Alchemist: Brotherhood';
const MA = new Set([14, 19, 26]);
const SERIES = [{ Id: 'SER1', Name: FMA, ProductionYear: 2009, OfficialRating: 'TV-14', RecursiveItemCount: 64, Type: 'Series' }];
const EPISODES = Array.from({ length: 64 }, (_, k) => ({
  Id: `E1-${k + 1}`, SeriesName: FMA, ParentIndexNumber: 1, IndexNumber: k + 1, Name: `Episode ${k + 1}`,
  OfficialRating: MA.has(k + 1) ? 'TV-MA' : 'TV-14', MediaSources: [{ Path: `/tv/fma/${k + 1}.mkv`, Size: 1000, Container: 'mkv' }],
}));

const netCalls = [];
const downloads = [];
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  netCalls.push(String(url));
  const json = (v) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
  const miss = () => json({ Response: 'False', Error: 'Movie not found!' });
  if (u.hostname === 'www.omdbapi.com') {
    const p = u.searchParams;
    const y = p.get('y') ? Number(p.get('y')) : null;
    if (p.get('i')) return json(OMDB.find((m) => m.imdbID === p.get('i')) ?? miss());
    if (p.get('t')) {
      const hit = OMDB.find((m) => norm(m.Title) === norm(p.get('t')) && (!y || Number(m.Year) === y));
      return hit ? json(hit) : miss();
    }
    if (p.get('s')) {
      const hits = OMDB.filter((m) => norm(m.Title).includes(norm(p.get('s'))) && (!y || Number(m.Year) === y));
      return hits.length ? json({ Response: 'True', Search: hits.map(({ Title, Year, imdbID, Type }) => ({ Title, Year, imdbID, Type })) }) : miss();
    }
    return miss();
  }
  if (u.hostname === 'jf.test') {
    if (u.pathname.includes('/Download')) { downloads.push(u.pathname); return new Response('bytes', { status: 200 }); }
    if (u.pathname.includes('/Seasons')) return json({ Items: [{ Id: 'S1', IndexNumber: 1, ChildCount: 64 }] });
    if (u.pathname.includes('/Episodes')) return json({ Items: EPISODES });
    const term = norm(u.searchParams.get('searchTerm') ?? '');
    const types = u.searchParams.get('IncludeItemTypes') ?? '';
    if (u.pathname.includes('/Search/Hints') || /Series/.test(types)) {
      return json({ Items: SERIES.filter((s) => !term || norm(s.Name).includes(term)), SearchHints: [] });
    }
    if (u.pathname === '/Items' || u.pathname.endsWith('/Items')) {
      if (!term) return json({ Items: [] });
      return json({ Items: LIBRARY.filter((f) => norm(f.Name).includes(term)) });
    }
    return json({ Items: [] });
  }
  return new Response('{}', { status: 404, statusText: 'not stubbed' });
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'beta-test-mode-'));
const WORK = path.join(TMP, 'work');
fs.mkdirSync(WORK);

const MODES_BEFORE = { 'tv-rating-notice': 'off', 'movie-duplicate-notice': 'off', 'tv-duplicate-notice': 'off' };

function config({ features = { 'tv-rating-notice': 'beta', 'movie-duplicate-notice': 'beta' }, enforce = false } = {}) {
  const c = mergeDefaults({
    movieRequests: {
      requestGroups: [MAIN_REQ], postsGroup: MAIN_POSTS, notify: { group: MAIN_NOTIFY },
      requirePrefix: true, prefix: '#request', cooldownSecondsPerUser: 0,
      ...(enforce ? { enforcement: { enabled: true, deleteNonRequests: true, warnByDm: true } } : {}),
    },
    tvRequests: {
      enabled: true, requestGroups: [TV_REQ], postsGroups: [TV_POSTS], cooldownSecondsPerUser: 0,
      requirePrefix: true, prefix: '#request', blockedRatings: ['TV-MA', 'R', 'NC-17', 'X'],
      // The whole of FMA:B season 1, as this was written against: the default
      // cap is 10 episodes a request since 2026-10-12 (request-rule-defaults).
      maxEpisodesPerRequest: 0,
    },
    // A feature this case does not name is Off, as every one was by default
    // until 2026-10-12 (live-settings-defaults), when the three became On.
    beta: { groups: [TESTING], postsGroup: '', features: { ...MODES_BEFORE, ...features } },
  }, DEFAULT_CONFIG);
  c.omdb.apiKey = 'test-key';
  c.library = mergeDefaults({
    provider: 'jellyfin',
    jellyfin: { baseUrl: 'http://jf.test', authMethod: 'apikey', apiKey: 'KEY', accessToken: 'TOK', userId: 'U1' },
  }, DEFAULT_CONFIG.library);
  Object.assign(c.media, { workDir: WORK, ffmpegPath: '/bin/false', deleteAfterSend: true });
  c.whatsapp.broadcastPacingMs = 0;
  return c;
}

function fakeStore(data = {}) {
  return {
    _data: data,
    get: (k, d = null) => (k in data ? data[k] : d),
    set: (k, v) => { data[k] = v; },
    push: (k, v, cap = 200) => { (data[k] ??= []).unshift(v); if (data[k].length > cap) data[k].length = cap; },
  };
}

function harness(cfg = config()) {
  const out = [];
  const jobs = [];
  const logs = [];
  let sent = 0;
  const bot = {
    isConnected: () => true,
    react: async (msg, emoji) => { out.push({ op: 'react', jid: msg.chatJid, on: msg.id, emoji }); return true; },
    sendText: async (jid, body, opts = {}) => {
      out.push({ op: 'text', jid, body, quoted: opts.quoted?.id ?? null });
      return { key: { remoteJid: jid, fromMe: true, id: `BOT${++sent}` } };
    },
    editText: async (jid, key, body) => { out.push({ op: 'edit', jid, body }); return true; },
    sendDocument: async (jid) => { out.push({ op: 'document', jid }); return {}; },
    deleteMessage: async (m) => { out.push({ op: 'delete', jid: m.chatJid }); },
    archiveChat: async () => {},
    isGroupAdmin: () => false,
    groupMemberInfo: () => ({ isMember: false }),
    groups: () => [],
    groupCache: new Map(),
    sameCommunity: () => false,
    groupMentionToken: (jid) => `@${jid.split('@')[0]}`,
    async _bulkPace() {},
    on() {}, off() {},
  };
  const log = (lvl) => (m) => logs.push(`${lvl} ${m}`);
  const queue = {
    maxLength: 50, pending: [], active: new Map(),
    add: (j) => { jobs.push(j); return `job-${jobs.length}`; },
    snapshot: () => ({ pending: [], active: [] }),
    on() {}, off() {},
  };
  // The two plugins keep separate stores, as they do in the bot.
  const movieStore = fakeStore();
  const tvStore = fakeStore();
  const base = { config: cfg, bot, queue, log: { info: log('info'), warn: log('warn'), error: log('error'), debug() {} }, configStore: { update() {} } };
  return {
    out, jobs, logs, movieStore, tvStore,
    movie: { ...base, store: movieStore },
    tv: { ...base, store: tvStore },
  };
}

let seq = 0;
const mkMsg = (text, chatJid = TESTING) => {
  const id = `M${++seq}`;
  return {
    id, key: { id, remoteJid: chatJid, participant: 'tester@lid', fromMe: false }, text, chatJid, isGroup: true, fromMe: false,
    messageType: 'conversation', senderJid: 'tester@lid', senderNumber: '15551112222',
    senderNumberDisplay: '+1 555 111 2222', pushName: 'Tester', timestamp: Date.now(),
  };
};
const settle = () => new Promise((r) => setTimeout(r, 20));
/** Both plugins see every message, as the plugin manager hands it to each. */
async function say(h, text, chat = TESTING) {
  const m = mkMsg(text, chat);
  await moviePlugin.onMessage(m, h.movie);
  await tvPlugin.onMessage(m, h.tv);
  await settle();
  return m;
}
const texts = (h) => h.out.filter((e) => e.op === 'text');
const history = (h) => [...(h.movieStore.get('history') ?? []), ...(h.tvStore.get('history') ?? [])];
// Nothing queued, journalled, or begun on the disk: a test makes no job
// directory (media/work-files.js) either.
const nothingQueued = (h) => h.jobs.length === 0 && !(h.movieStore.get('pending') ?? []).length
  && !(h.tvStore.get('pending') ?? []).length && !fs.readdirSync(WORK).length;
const listsUntouched = (h) => !(h.movieStore.get('wanted') ?? []).length && !(h.movieStore.get('library-misses') ?? []).length
  && !(h.tvStore.get('library-misses') ?? []).length;

moviePlugin._reactors = new Map();                    // normally created by setup()

/* ============================ reading a message ============================ */

console.log('=== which messages in the beta group are tests ===');
{
  const cfg = config();
  ok(readBetaTest(cfg, '#request captain phillips').outcome === 'ignore', 'no code: ignored');
  ok(readBetaTest(cfg, '$20 for the lot?').outcome === 'ignore', 'a dollar sign that is not "$beta" is chatter, ignored');
  const t = readBetaTest(cfg, '$BETA004 #request-movie harry potter');
  ok(t.outcome === 'movie' && t.code === 'beta004' && t.body === 'harry potter' && t.forced, 'the code in any case, and #request-movie');
  ok(testRequestText(t, cfg.movieRequests) === '#request harry potter', 'which stands for the group\'s own prefix');
  ok(readBetaTest(cfg, '$beta4 #request harry potter').code === 'beta004', '"$beta4" is beta004');
  ok(readBetaTest(cfg, '$beta003 #request-tv fullmetal alchemist brotherhood season 1').outcome === 'tv', 'a TV feature\'s code is TV');
  ok(readBetaTest(cfg, '$beta004 The Office S01').outcome === 'wrong-kind', 'a season under a movie code is the wrong kind');
  ok(readBetaTest(cfg, '$beta004 #request-tv Loki season 1').outcome === 'wrong-kind', 'and so is #request-tv');
  ok(readBetaTest(cfg, '$beta009 x').outcome === 'unknown' && readBetaTest(cfg, '$beta002 x').why === 'retired',
    'an unknown code and a retired one are not tests');
  // The "which one?" list left beta on 2026-10-11. A config.json that still
  // holds its old mode, as the live one may, does not bring the code back.
  const stale = config({ features: { 'movie-pick-list': 'on', 'movie-duplicate-notice': 'beta' } });
  ok(readBetaTest(stale, '$beta001 #request harry potter').why === 'retired' && readBetaTest(stale, '$BETA1 venom').why === 'retired',
    'beta001 is retired, whatever mode config.json still holds for it');
  ok(readBetaTest(cfg, '$beta005 Loki season 1').why === 'off', 'nor is the code of a feature that is Off');
  ok(runningTestsLine(cfg) === 'Running tests: $beta003, $beta004', `the running list: "${runningTestsLine(cfg)}"`);
  ok(runningTestsLine(stale) === 'Running tests: $beta004', 'and beta001 is never in it');
  ok(runningTestsLine(config({ features: {} })) === 'No tests are running right now.', 'and when nothing is');
}

/* ============================ the operator's cases ============================ */

console.log('=== a request in the beta group with no code is ignored completely ===');
{
  const h = harness();
  await say(h, '#request captain phillips');
  await say(h, 'captain phillips');
  await say(h, '#request fullmetal alchemist brotherhood season 1');
  ok(h.out.length === 0, `no reaction, no reply, nothing deleted (${h.out.length} outbound)`);
  ok(history(h).length === 0, 'no History row');
  ok(nothingQueued(h), 'nothing queued');
  ok(!Object.keys(h.movieStore._data).some((k) => k.startsWith('cooldown')) && !Object.keys(h.tvStore._data).some((k) => k.startsWith('cooldown')),
    'no cooldown started');
  ok(!netCalls.length, 'and nothing looked up');
  ok(h.logs.filter((l) => /beta: ignoring a message .* no test code/.test(l)).length === 3, 'one log line each');
}

console.log('=== "$beta004 #request-movie harry potter": the pick list every request gets, and a pick passes ===');
{
  const h = harness();
  const req = await say(h, '$beta004 #request-movie harry potter');
  const list = texts(h);
  ok(list.length === 1 && list[0].jid === TESTING && list[0].quoted === req.id && /^🔍 \*Search results for "harry potter"\*\n\n\*1\.\* Harry Potter and the Sorcerer's Stone \(2001\)/.test(list[0].body),
    `the list, quoted, in the beta group:\n${list[0]?.body}`);
  const mark = h.out.length;
  const pick = await say(h, '3');
  const after = h.out.slice(mark);
  ok(nothingQueued(h), 'the pick queues nothing');
  ok(after.some((e) => e.op === 'react' && e.on === req.id && e.emoji === '✅'), '✅ on the request');
  const passed = after.find((e) => e.op === 'text');
  ok(passed?.quoted === req.id && /^✅ \*Test passed\* \(\$beta004\)\n\nThe bot would send \*Harry Potter and the Prisoner of Azkaban\* \(2004\), 1\.40 GB\.\nNothing was downloaded\.$/.test(passed.body),
    `quoted "Test passed": "${passed?.body}"`);
  ok(after.find((e) => e.op === 'edit')?.body === '✔ 3 · Harry Potter and the Prisoner of Azkaban (2004) — test passed, nothing sent',
    'the list says the test passed, not "on its way"');
  ok(!after.some((e) => e.on === pick.id), 'the number itself gets nothing - it continues the test');
  const row = h.movieStore.get('history').find((r) => r.id === req.id);
  ok(row?.status === 'test-passed' && row.beta === true && row.test === 'beta004', 'History: test-passed, beta004');
  ok(!downloads.length && !h.out.some((e) => e.op === 'document'), 'nothing downloaded or sent');
}

console.log('=== "$beta004 #request captain phillips": one copy, test passed ===');
{
  const h = harness();
  const m = await say(h, '$beta004 #request captain phillips');
  ok(nothingQueued(h), 'nothing queued');
  ok(h.out.filter((e) => e.op === 'react').map((e) => e.emoji).join(' ') === '🔍 ✅', '🔍, then ✅');
  const t = texts(h);
  ok(t.length === 1 && t[0].quoted === m.id && t[0].body.startsWith('✅ *Test passed* ($beta004)\n\nThe bot would send *Captain Phillips* (2013)'),
    `one quoted reply: "${t[0]?.body}"`);
  ok(h.movieStore.get('history')[0]?.status === 'test-passed', 'History: test-passed');
}

console.log('=== a code nothing is tested under gets ❓ and the tests running ===');
{
  const h = harness();
  const calls = netCalls.length;
  const m = await say(h, '$beta009 #request captain phillips');
  ok(h.out.filter((e) => e.op === 'react').map((e) => `${e.on}:${e.emoji}`).join() === `${m.id}:❓`, 'one ❓, on the message');
  const t = texts(h);
  ok(t.length === 1 && t[0].quoted === m.id && t[0].body === '❓ $beta009 is not a test. Running tests: $beta003, $beta004',
    `one reply naming the tests running now: "${t[0]?.body}"`);
  await say(h, '$beta002 #request captain phillips');
  ok(texts(h).at(-1)?.body === '❓ $beta002 has finished. To see how the main groups answer a request now, start it with $stamtest. '
    + 'Running tests: $beta003, $beta004', `a retired code says it has finished, and how to try a request now: "${texts(h).at(-1)?.body}"`);
  // beta001 is in every testers' guide pasted into the group before
  // 2026-10-11. Its list is what every group does now, so $stamtest is how a
  // tester sees it.
  const old = await say(h, '$beta001 #request harry potter');
  ok(texts(h).at(-1)?.quoted === old.id && texts(h).at(-1)?.body === '❓ $beta001 has finished. To see how the main groups answer a '
    + 'request now, start it with $stamtest. Running tests: $beta003, $beta004', 'and so does beta001, the "which one?" list');
  ok(h.out.filter((e) => e.op === 'react' && e.on === old.id).map((e) => e.emoji).join() === '❓', 'with one ❓ on it, and no list');
  ok(history(h).length === 0 && nothingQueued(h) && netCalls.length === calls, 'nothing looked up, recorded or queued');
}

console.log('=== a request of the other kind than the code\'s feature is told so ===');
{
  const h = harness();
  const m = await say(h, '$beta004 The Office S01');
  const t = texts(h);
  ok(t.length === 1 && t[0].quoted === m.id && t[0].body === '$beta004 tests movies — ask for a film.', `one quoted line: "${t[0]?.body}"`);
  ok(h.out.length === 1 && history(h).length === 0 && nothingQueued(h), 'and nothing else');
  await say(h, '$beta003 #request-movie captain phillips');
  ok(texts(h).at(-1)?.body === '$beta003 tests TV — ask for a show and its season.', 'and the other way round');
}

console.log('=== "$beta003 #request-tv ...season 1": test passed, with the withheld episodes ===');
{
  const h = harness();
  const m = await say(h, '$beta003 #request-tv fullmetal alchemist brotherhood season 1');
  ok(nothingQueued(h), 'nothing queued or journalled');
  const t = texts(h);
  ok(t.length === 1 && t[0].jid === TESTING && t[0].quoted === m.id && t[0].body
    === `✅ *Test passed* ($beta003)\n\nThe bot would queue 61 episodes of *${FMA}* season 1.\nNothing was downloaded.\n\n`
    + "Episodes 14, 19 and 26 are rated TV-MA, which can't be posted, so they were left out.",
  `one quoted reply, with what beta003 says:\n${t[0]?.body}`);
  ok(h.out.filter((e) => e.op === 'react').at(-1)?.emoji === '✅', '✅ on the request');
  const row = h.tvStore.get('history')[0];
  ok(row?.status === 'test-passed' && row.beta === true && row.test === 'beta003' && row.episodes === 61,
    'History: test-passed, beta003, 61 episodes');
  ok(!h.out.some((e) => MAIN.includes(e.jid)), 'no main group heard any of it');
}

console.log('=== a refusal is answered as usual, and adds nothing to the operator\'s lists ===');
{
  const h = harness();
  await say(h, '$beta004 #request heat 1995');
  ok(h.out.some((e) => e.op === 'react' && e.emoji === '⛔'), 'a rated R film, not on the bypass list: ⛔');
  ok(h.movieStore.get('history')[0]?.status === 'blocked-rating', 'History: blocked-rating');
  await say(h, '$beta004 #request the muppet movie');
  ok(h.out.some((e) => e.op === 'react' && e.emoji === '📬'), 'a film the server does not have: 📬');
  ok(h.movieStore.get('history')[0]?.status === 'not-in-library' && h.movieStore.get('history')[0]?.beta === true,
    'History: not-in-library, a beta row');
  await say(h, '$beta003 #request-tv fullmetal alchemist brotherhood season 7');
  ok(listsUntouched(h), 'nothing on the wanted list or either not-in-library list');
  ok(nothingQueued(h) && !h.out.some((e) => MAIN.includes(e.jid)), 'nothing queued, nothing said in a main group');

  // The same refusal from a member is recorded, as it always was.
  const m = harness();
  await say(m, '#request the muppet movie', MAIN_REQ);
  ok((m.movieStore.get('wanted') ?? []).length === 1, 'while a member\'s "not in library" still goes on the wanted list');
}

console.log('=== the main groups are unchanged ===');
{
  const h = harness();
  await say(h, '#request captain phillips', MAIN_REQ);
  ok(h.jobs.length === 1 && h.jobs[0].label === 'Captain Phillips (2013)', 'a member\'s request is queued');
  ok(texts(h).some((e) => e.jid === MAIN_NOTIFY && /Captain Phillips \(2013\) — added to the queue/.test(e.body)),
    'and announced as it always was');
  const n = h.out.length;
  await say(h, '$beta004 #request captain phillips', MAIN_REQ);
  ok(h.jobs.length === 1 && h.out.length === n, `a code means nothing there: not a request under the prefix rule (${h.out.length - n} outbound)`);
  await say(h, '#request fullmetal alchemist brotherhood season 1', TV_REQ);
  ok(h.jobs.length === 1 + 61, 'a TV request is queued, 61 episodes');
  ok(!history(h).some((r) => r.beta), 'and no row is a beta row');
}

console.log('=== the digest and the activity record leave tests out of the figures ===');
{
  const h = harness();
  await say(h, '$beta004 #request captain phillips');
  await say(h, '$beta004 #request heat 1995');
  await say(h, '#request captain phillips', MAIN_REQ);
  const now = Date.now();
  const body = buildDigest({ now, history: history(h) });
  ok(/Requests handled : 1\b/.test(body), `only the member's request is counted (${body.match(/Requests handled : \d+/)?.[0]})`);
  ok(/Beta tests\s+: 2 \(not counted above\)/.test(body), 'the two tests get their own line');
  const md = summarise({
    day: '2026-09-29', movies: { history: h.movieStore.get('history'), wanted: [], 'library-misses': [] }, tv: { history: [] }, audit: [],
  });
  ok(/\| Beta tests \(not counted above\) \| 2 \|/.test(md) && /\| &nbsp;&nbsp;blocked \| 0 \|/.test(md),
    'the nightly activity record counts them apart too, so the test\'s ⛔ is not a blocked request');
}

console.log('=== the testers\' guide says to start with the code ===');
{
  const g = testersGuide(config());
  ok(g.ok && /Start every request with the code of the test/.test(g.text)
    && /for example \$beta003 #request Fullmetal Alchemist Brotherhood season 1\./.test(g.text)
    && /Try: \$beta004 #request minority report 2002/.test(g.text),
  'every request starts with the code, with an example');
  ok(!/beta001/.test(g.text), 'and beta001, which every group has now, is not in it');
  ok(/Test passed/.test(g.text) && /Nothing is downloaded or sent from this group/.test(g.text), 'and says a test is answered ✅ Test passed');
  ok(FEATURES.every((f) => /Test passed|🤥|⛔/.test(f.howTo)), 'every feature\'s how-to says what a tester sees now');
}

/* ============================ found in review ============================ */

console.log('=== punctuation stuck to the code is not part of it ===');
{
  const cfg = config();
  for (const said of ['$beta004: harry potter', '$beta004, harry potter', '$BETA004 - harry potter']) {
    const t = readBetaTest(cfg, said);
    ok(t.outcome === 'movie' && t.code === 'beta004' && t.body === 'harry potter', `"${said}" is a beta004 film test for "harry potter"`);
  }
  const h = harness();
  await say(h, '$beta004: #request captain phillips');
  ok(!h.out.some((e) => e.emoji === '❓') && texts(h).at(-1)?.body.startsWith('✅ *Test passed* ($beta004)'),
    `and is answered as one, not "❓ $beta004: is not a test": "${texts(h).at(-1)?.body}"`);
  ok(readBetaTest(cfg, '$beta004x harry potter').outcome === 'unknown' && readBetaTest(cfg, '$beta004x harry potter').typed === '$beta004x',
    'while "$beta004x" is still a code nothing is tested under, named as typed');
}

console.log('=== a coded test needs no prefix: the code says it is a request ===');
{
  const cfg = config({ enforce: true });
  ok(testRequestText(readBetaTest(cfg, '$BETA004 harry potter'), cfg.movieRequests) === '#request harry potter',
    'the group\'s prefix is put in front of "$BETA004 harry potter"');
  ok(testRequestText(readBetaTest(cfg, '$beta004 #REQUEST harry potter'), cfg.movieRequests) === '#REQUEST harry potter',
    'and not twice when the tester typed it');
  const h = harness(cfg);
  const m = await say(h, '$BETA004 harry potter');
  ok(!h.out.some((e) => e.op === 'delete') && !h.out.some((e) => e.jid === 'tester@lid'), 'with "delete non-requests" on, nothing is deleted and no DM sent');
  ok(texts(h).length === 1 && texts(h)[0].quoted === m.id && /^🔍 \*Search results for "harry potter"\*\n\n\*1\.\* Harry Potter/.test(texts(h)[0].body),
    `it gets the list:\n${texts(h)[0]?.body}`);
  const tv = await say(h, '$beta003 fullmetal alchemist brotherhood season 1');
  ok(texts(h).at(-1)?.quoted === tv.id && texts(h).at(-1).body.startsWith('✅ *Test passed* ($beta003)\n\nThe bot would queue 61 episodes'),
    `and a TV test with no prefix gets its answer: "${texts(h).at(-1)?.body.split('\n')[0]}"`);
  // An uncoded message is still moderated as it always was.
  const plain = harness(config({ enforce: true }));
  await say(plain, '#request captain phillips');
  ok(plain.out.length === 0, 'an uncoded request there is still ignored, not deleted');
}

console.log('=== a test\'s pick list does not say a number downloads anything ===');
{
  const items = [{ title: 'A', year: 2001 }, { title: 'B', year: 2002 }, { title: 'C', year: 2003 }];
  ok(formatPickList(items, { test: true }).endsWith('\n\nReply with a number (1–3), or react with it, to test it. Nothing is downloaded. This list expires in 10 minutes.'),
    'a test\'s footer says nothing is downloaded');
  ok(formatPickList(items).endsWith('\n\nReply with a number (1–3), or react with it, to get it. This list expires in 10 minutes.'), 'a main group\'s footer says a number gets the film');
  const h = harness();
  await say(h, '$beta004 #request harry potter');
  ok(/Reply with a number \(1–3\), or react with it, to test it\. Nothing is downloaded\./.test(texts(h)[0]?.body ?? ''), 'and the list the tester gets says so');
}

console.log('=== every line the bot suggests copying carries the test\'s code ===');
{
  const cfg = config();
  const p = requestPrefix(cfg.movieRequests);
  const test = { beta: true, notifyGroup: TESTING, test: 'beta004' };
  ok(suggestPrefix(test, p) === '$beta004 #request', 'a test\'s prefix is "$beta004 #request"');
  ok(suggestPrefix({ beta: true, test: 'stamtest' }, p) === '$stamtest #request', 'a $stamtest\'s is "$stamtest #request"');
  ok(suggestPrefix(null, p) === '#request', 'a main request\'s is the prefix alone');
  const hp = [{ title: 'Venom', year: 2018 }, { title: 'Venom', year: 2021 }];
  ok(needYearNote('Venom', [2018, 2021], suggestPrefix(test, p)) === '📅 Venom — we have 2018, 2021. Send $beta004 #request Venom 2021',
    'the "which year" line');
  ok(needYearNote('Venom', [2018, 2021], suggestPrefix(null, p)) === '📅 Venom — we have 2018, 2021. Send #request Venom 2021', 'unchanged for members');
  ok(formatExpired(hp, { prefix: suggestPrefix(test, p) }) === 'expired — send $beta004 #request Venom 2021', 'the expired list\'s line');
  const wicks = [{ title: 'John Wick', year: 2014 }, { title: 'John Wick: Chapter 2', year: 2017 }];
  ok(narrowDownText('john wick', wicks, { prefix: suggestPrefix(test, p) }).endsWith('e.g. $beta004 #request John Wick: Chapter 2'),
    'the "add a word or the year" line');
  ok(narrowDownText('john wick', wicks, { prefix: p }).endsWith('e.g. #request John Wick: Chapter 2'), 'unchanged for members');
  // A "$beta001 venom" list still open when beta001 was retired (2026-10-11)
  // runs out minutes later, saying what to send. Under its own code that
  // would be answered ❓ "has finished"; $stamtest runs it.
  const old = { beta: true, notifyGroup: TESTING, test: 'beta001' };
  ok(formatExpired(hp, { prefix: suggestPrefix(old, p) }) === 'expired — send $stamtest #request Venom 2021',
    'a list asked under a code since retired suggests $stamtest, not the code that would be refused');
  ok(testCodeFor(cfg, 'tv', 'beta004') === 'beta003', 'a film test told "that is a series" is pointed at a TV test\'s code');
  ok(testCodeFor(config({ features: { 'movie-duplicate-notice': 'beta' } }), 'tv', 'beta004') === null, 'and at none when no TV test is running');

  // Through the TV plugin, end to end: the example, sent back as it is, passes.
  const h = harness();
  const m = await say(h, '$beta003 #request fullmetal alchemist brotherhood');
  const ask = texts(h).find((e) => e.quoted === m.id)?.body ?? '';
  const example = /Send e\.g\. \*(.+)\*/.exec(ask)?.[1];
  ok(example === `$beta003 #request ${FMA} season 1`, `"which season?" gives an example with the code: "${example}"`);
  const back = await say(h, example ?? '');
  const passed = texts(h).find((e) => e.quoted === back.id)?.body ?? '';
  ok(passed.startsWith('✅ *Test passed* ($beta003)\n\nThe bot would queue 61 episodes'), `and that example, sent back, passes: "${passed.split('\n\n').slice(0, 2).join(' / ')}"`);
  ok(!h.logs.some((l) => /no test code/.test(l)), 'with nothing ignored for want of a code');
  ok(nothingQueued(h), 'and nothing queued');
  // A member's "which season?" is worded as it always was.
  const main = harness();
  const mm = await say(main, '#request fullmetal alchemist brotherhood', TV_REQ);
  ok(new RegExp(`Send e\\.g\\. \\*#request ${FMA} season 1\\*`).test(texts(main).find((e) => e.quoted === mm.id)?.body ?? ''),
    'a member\'s example is unchanged');
}

console.log('=== the hourly check does not research a test ===');
{
  const NOW = Date.now();
  const row = (o) => ({ id: `R${++seq}`, at: NOW - 60_000, requester: 'Tester', groupJid: TESTING, ...o });
  const findings = (rows) => {
    const r = scan({ now: NOW, config: config(), state: { 'movie-requests': { history: rows } }, memory: { v: 1, lastScanAt: NOW - 3_600_000, seen: {} } });
    return [...r.incidents, ...r.notices];
  };
  const missing = { status: 'not-in-library', title: 'The Muppet Movie', year: 1979, request: 'the muppet movie' };
  const lost = { status: 'lost', title: 'Captain Phillips', year: 2013, request: 'captain phillips', detail: 'interrupted before it finished' };
  const tests = findings([row({ ...missing, beta: true, test: 'beta001' }), row({ ...lost, beta: true, test: 'beta001' })]);
  ok(tests.length === 0, `a test's "not in the library" and its row lost to a restart are no findings (${tests.map((f) => f.title).join(' | ')})`);
  const members = findings([row({ ...missing, groupJid: MAIN_REQ }), row({ ...lost, groupJid: MAIN_REQ })]);
  ok(members.some((f) => /not in the library/.test(f.title)) && members.some((f) => /lost to a restart/.test(f.title)),
    'while the same rows from members still are');
}

console.log('=== no real network was touched ===');
ok(netCalls.every((u) => u.includes('omdbapi.com') || u.includes('jf.test')), 'every call went to a stubbed host');
ok(!downloads.length, 'and nothing was ever downloaded');

moviePlugin.teardown?.();
await tvPlugin.teardown?.();
fs.rmSync(TMP, { recursive: true, force: true });
console.log('=== several tests in one message are answered, not run as one request ===');
{
  // 2026-09-30, 05:27: three example lines pasted as one message were read as
  // one request, the AI title lookup guessed John Wick from the jumble, and
  // none of the three tests ran.
  const cfg = { beta: { groups: ['beta@g.us'], features: { 'movie-duplicate-notice': 'beta' } } };
  const r = readBetaTest(cfg, '$beta004 #request harry potter\n$beta004 #request john wick\n$beta004 #request captain phillips');
  ok(r.outcome === 'several' && r.count === 3, `three coded lines: "several" (${r.outcome}, ${r.count})`);
  ok(readBetaTest(cfg, '$beta004 #request harry potter\nplease').outcome === 'movie', 'one coded line with a note after it is still one test');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
