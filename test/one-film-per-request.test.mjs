/* A movie request that asks for several films at once is refused: one film per request.
   Run: node test/one-film-per-request.test.mjs

   The operator, 2026-10-11, going through History rows that had ended
   "need-year - too many matches - needs a year": "the equalizer 1 & 2" and
   "the extraction 1 & 2", both from Matt Fisher, and "rocky 1 2 3 4 5 and
   6" from JJ - "these dont need year, they should get denied because they
   didnt ask for 1 movie at a time". OMDb had found each phrase too broad, so
   each was answered 📅 and asked for a year that would not have helped.

   Pinned here:
   - the three real requests, and every other shape the operator listed, are
     refused before OMDb is asked (no quota spent) and before the 🔍: ☝️, a
     History row 'one-at-a-time', and a notifications line naming the
     group's real prefix - "send each on its own: "#request the equalizer",
     then "#request the equalizer 2"" - and with replies on, the same as a
     quoted reply; nothing reaches the wanted or not-in-library lists, and
     the refusal starts no cooldown clock;
   - no single film is refused: every title in library/clean-titles.json and
     clean-titles.md, as typed, with its year and lower-cased, and the
     operator's list of titles that hold numbers ("2 fast 2 furious", "ocean's
     11", "9 to 5", "harry potter 7 part 2", ...), go through untouched, and
     the counts are printed;
   - nor is a title that ends in "all": a review of this branch found "Kill
     'Em All" (2017), "Kill 'Em All 2" (2024) and "Bless 'Em All" (1949)
     refused as "a whole series" - in a group, on a Re-run and from a pasted
     TMDB link - and told to send "kill' em"; the lines to send are now the
     title as it was typed;
   - a beta test ($beta004) and a $stamtest are refused the way a main group
     refuses, the suggested lines carrying the test's code;
   - the panel's dry run and Re-run say the same, without asking OMDb;
   - the hourly check lists such a row as a notice, never a fault to research
     or re-run; the daily digest and the activity record count it; the
     reaction is never shed, and the group legends explain it. */
import './fixtures/roomy-disk.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { DEFAULT_CONFIG, mergeDefaults } from '../src/config/schema.js';
import moviePlugin from '../src/plugins/movie-requests/index.js';
import { severalFilms, oneFilmNote, oneFilmReply } from '../src/plugins/movie-requests/several-films.js';
import { scan, requestChains } from '../src/core/incident-scan.js';
import { buildDigest } from '../src/core/daily-digest.js';
import { summarise } from '../src/core/activity-backup.js';
import { reactionKind, TERMINAL_KEYS } from '../src/media/reaction-class.js';
import { runStamTest, stamIntercept, formatStamSummary } from '../src/core/stam-test.js';
import { createApiRouter } from '../src/web/api.js';
import { JobQueue } from '../src/core/queue.js';
import { LEGEND } from '../tools/legends.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const ROOT = new URL('..', import.meta.url);
const REQ = 'movie-requests@g.us';
const POSTS = 'movie-posts@g.us';
const NOTIFY = 'movie-notify@g.us';
const TESTING = '120363900000000013@g.us';
const BETA_POSTS = '120363900000000014@g.us';

/* ------------------------------ fixtures ------------------------------ */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'one-film-'));
const LIB = path.join(TMP, 'lib');
const WORK = path.join(TMP, 'work');
fs.mkdirSync(LIB); fs.mkdirSync(WORK);
fs.writeFileSync(path.join(LIB, 'The Equalizer 2 (2018).mp4'), 'not really a film');
fs.writeFileSync(path.join(LIB, "Kill 'Em All (2017).mp4"), 'not really a film');

// OMDb as it answered the real requests: no film by the whole phrase, and a
// search too broad to answer - which is how all three ended in "needs a year".
const FILMS = {
  'the equalizer 2': { Title: 'The Equalizer 2', Year: '2018', Rated: 'PG-13', imdbID: 'tt3766354' },
  "kill 'em all": { Title: "Kill 'Em All", Year: '2017', Rated: 'R', imdbID: 'tt6271042' },
};
const omdbCalls = [];
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  const json = (v) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
  if (u.hostname.includes('omdbapi')) {
    omdbCalls.push(Object.fromEntries(u.searchParams));
    if (u.searchParams.get('s')) return json({ Response: 'False', Error: 'Too many results.' });
    const f = FILMS[String(u.searchParams.get('t') ?? '').toLowerCase()];
    return json(f ? { Response: 'True', Type: 'movie', ...f } : { Response: 'False', Error: 'Movie not found!' });
  }
  return new Response('{}', { status: 404 });
};

function config({ replyOnBlock = false, cooldown = 0, betaFeature = 'off' } = {}) {
  return mergeDefaults({
    movieRequests: { notifyRefusals: true,
      requestGroups: [REQ], postsGroup: POSTS, notify: { group: NOTIFY }, cooldownSecondsPerUser: cooldown,
      blockedRatings: [], requirePrefix: true, prefix: '#request', replyOnBlock,
    },
    omdb: { apiKey: 'test-key' },
    library: { provider: 'local', local: { roots: [LIB], extensions: ['.mp4'] } },
    media: { workDir: WORK, ffprobePath: '/bin/false', ffmpegPath: '/bin/false', deleteAfterSend: true },
    beta: { groups: [TESTING], postsGroup: BETA_POSTS, features: { 'movie-duplicate-notice': betaFeature } },
    whatsapp: { broadcastPacingMs: 0 },
  }, DEFAULT_CONFIG);
}

function fakeStore(data = {}) {
  return { get: (k, d = null) => (k in data ? data[k] : d), set: (k, v) => { data[k] = v; }, push: (k, v) => { (data[k] ??= []).unshift(v); }, data };
}

function harness(cfg = config(), { stam = false } = {}) {
  const out = [];
  const jobs = [];
  const store = fakeStore();
  const bot = {
    isConnected: () => true,
    // A $stamtest gathers what the bot would send instead of sending it, as
    // bot.js does (stamIntercept).
    react: async (msg, emoji) => { if (stam) { const g = stamIntercept('react', { emoji }); if (g) return g; } out.push({ op: 'react', id: msg.id, emoji }); return true; },
    sendText: async (jid, body, opts) => {
      if (stam) { const g = stamIntercept('text', { jid, text: body, quoted: !!opts?.quoted }); if (g) return g; }
      out.push({ op: 'text', jid, body, quoted: !!opts?.quoted });
      return { key: { id: 'sent' } };
    },
    sendDocument: async () => ({}), deleteMessage: async () => {}, archiveChat: async () => {}, isGroupAdmin: () => false,
    groupMemberInfo: () => ({ isMember: false }), groups: () => [], on() {}, off() {},
  };
  const queue = {
    maxLength: 50, pending: [], active: new Map(), on() {}, off() {},
    add(j) { jobs.push(j); this.pending.push({ id: `job-${jobs.length}`, kind: 'movie', meta: j.meta }); return `job-${jobs.length}`; },
    moveTop() { return true; }, hasOthers: () => false,
    snapshot() { return { pending: [], active: [] }; },
  };
  const ctx = { config: cfg, store, bot, queue, log: { info() {}, warn() {}, error() {}, debug() {} }, configStore: { update() {} } };
  return { ctx, out, jobs, store };
}

let seq = 0;
const ask = (text, { chatJid = REQ, who = 'Matt Fisher', number = '15558170173' } = {}) => {
  const id = `MSG${++seq}`;
  return {
    id, key: { id, remoteJid: chatJid }, text, chatJid, isGroup: true, fromMe: false, messageType: 'conversation',
    senderJid: `${number}@s.whatsapp.net`, senderNumber: number, pushName: who, timestamp: Date.now(),
  };
};
const rowOf = (store, id) => (store.data.history ?? []).find((h) => h.id === id);
const reactions = (out, id) => out.filter((e) => e.op === 'react' && e.id === id).map((e) => e.emoji);
const notes = (out, jid = NOTIFY) => out.filter((e) => e.op === 'text' && e.jid === jid && !e.quoted).map((e) => e.body);
const replies = (out) => out.filter((e) => e.op === 'text' && e.quoted).map((e) => e.body);

moviePlugin._reactors = new Map();                    // normally made by setup()

/* ------------------------------ the detector ------------------------------ */

console.log('=== the operator\'s shapes of several films in one request are refused ===');
{
  const shapes = [
    ['the equalizer 1 & 2', 2, ['the equalizer', 'the equalizer 2']],
    ['the extraction 1 & 2', 2, ['the extraction', 'the extraction 2']],
    ['rocky 1 2 3 4 5 and 6', 6, ['rocky', 'rocky 2']],
    ['harry potter 1-8', 8, ['harry potter', 'harry potter 2']],
    ['toy story 1, 2 and 3', 3, ['toy story', 'toy story 2']],
    ['kill bill vol 1 and 2', 2, ['kill bill vol 1', 'kill bill vol 2']],
    ['kill bill volume 1 & 2', 2, ['kill bill volume 1', 'kill bill volume 2']],
    ['saw 1 2 3', 3, ['saw', 'saw 2']],
    ['rocky ii and iii', 2, ['rocky ii', 'rocky iii']],
    ['the godfather part 1 and 2', 2, ['the godfather part 1', 'the godfather part 2']],
    ['john wick 1-4', 4, ['john wick', 'john wick 2']],
    ['harry potter 1 to 8', 8, null],
    ['rocky 1 thru 6', 6, null],
    ['kill bill vol. 1 & vol. 2', 2, ['kill bill vol 1', 'kill bill vol 2']],
    ['the equalizer 1&2 please', 2, null],
    ['shrek 1/2/3', 3, null],
    ['the equalizer 1 & 2 (2014, 2018)', 2, null],
    ['the equalizer 1 and the equalizer 2', 2, ['the equalizer', 'the equalizer 2']],
    ["ocean's 11 & ocean's 12", 2, ["ocean's 11", "ocean's 12"]],
    // "movie" is a title word here, and stays in what to send.
    ['scary movie 2 and 3', 2, ['scary movie 2', 'scary movie 3']],
    ['harry potter movies 1-8', 8, ['harry potter', 'harry potter 2']],
  ];
  for (const [text, count, requests] of shapes) {
    const r = severalFilms(text);
    ok(r?.count === count && (!requests || JSON.stringify(r.requests) === JSON.stringify(requests)),
      `"${text}": ${count} films${requests ? `, send "${requests.join('" then "')}"` : ''} (${JSON.stringify(r)})`);
  }
  for (const [text, stem] of [
    ['all the harry potter movies', 'harry potter'], ['harry potter all', 'harry potter'],
    ['the matrix trilogy', 'the matrix'], ['lord of the rings trilogy', 'lord of the rings'],
    ['kill bill both', 'kill bill'], ['star wars all 9 movies', 'star wars'],
  ]) {
    const r = severalFilms(text);
    ok(r?.how === 'series' && r.count === null && r.requests[0] === stem, `"${text}": a whole series, asked for in words`);
  }
}

console.log('=== no single film is refused, whatever numbers its title holds ===');
{
  const singles = [
    '2 fast 2 furious', "ocean's 11", "ocean's 8", 'apollo 13', '1917', '21 jump street', '22 jump street',
    '10 things i hate about you', '3 idiots', 'rocky 2', 'rocky ii', 'the equalizer 2', 'fantastic 4', 'super 8',
    'district 9', 'se7en', 'blade runner 2049', '2001 a space odyssey', 'the 39 steps', '12 angry men',
    '13 going on 30', '50 first dates', '8 mile', '300', '300 rise of an empire', 'toy story 3', 'x2', '1408',
    '2012', '9 to 5', 'the hateful 8', '28 days later', '28 weeks later', '10 cloverfield lane',
    '7 days in entebbe', 'the number 23', 'catch 22', 'mission impossible 2', 'fast 5', 'fast & furious 6',
    'the fast and the furious 2001', 'harry potter 7 part 2', 'deathly hallows part 1', 'kill bill vol 1',
    'kill bill volume 2', 'dune part two', 'high school musical 3', '2 guns', '3 days to kill', '6 underground',
    'the magnificent 7', 'number 9',
    // And the guards' own reasons: a date, fractions, a countdown the wrong
    // way round, a title said twice, "all" that belongs to the title.
    'fahrenheit 9/11', 'the naked gun 33 1/3', 'the naked gun 2 1/2', '8 1/2', 'christmas 9 to 5', '20/20',
    'new york, new york', 'free for all', 'winner takes all', 'kill them all', 'one show fits all',
    'the king and i', 'all the president\'s men movie', 'every which way but loose movie', 'x-men',
    'romeo + juliet', 'sex and the city 2', 'dumb and dumber to', 'the story of fire saga', 'the collection',
  ];
  const wrong = singles.filter((t) => severalFilms(t) || severalFilms(t.toUpperCase()) || severalFilms(`${t} 2010`));
  ok(wrong.length === 0, `${singles.length} single films with numbers in their titles, as typed, upper-cased and with a year: none refused`
    + `${wrong.length ? ` - refused: ${wrong.join(', ')}` : ''}`);

  // Seasons and episodes are TV's to answer ("that is a series" in a movie
  // group), and "star wars episode 4 5 and 6" could be either: let through.
  const tv = ['the office season 1 and 2', 'the office seasons 1-3', 'doctor who series 1-3', 'friends s03 e06, e08',
    'the office season 1 and the office season 2', 'star wars episode 4 5 and 6'];
  ok(tv.every((t) => !severalFilms(t)), `seasons and episodes are not refused as films (${tv.filter((t) => severalFilms(t)).join(', ') || 'none'})`);

  // Every film on the server, as a member might type it.
  const json = JSON.parse(fs.readFileSync(new URL('library/clean-titles.json', ROOT), 'utf8')).titles;
  const md = fs.readFileSync(new URL('library/clean-titles.md', ROOT), 'utf8').split('\n')
    .map((l) => /^- (.+) \((\d{4})\) — /.exec(l)).filter(Boolean).map((m) => ({ title: m[1], year: Number(m[2]) }));
  let forms = 0;
  const refused = [];
  for (const { title, year } of [...json, ...md]) {
    for (const t of [title, `${title} ${year}`, `${title} (${year})`, title.toLowerCase(), `${title} ${year}`.toLowerCase()]) {
      forms += 1;
      if (severalFilms(t)) refused.push(t);
    }
  }
  console.log(`       catalogue check: ${json.length} titles from clean-titles.json and ${md.length} from clean-titles.md, `
    + `${forms} forms, ${refused.length} refused`);
  ok(json.length > 5000 && md.length === json.length, `both catalogue files read (${json.length}, ${md.length})`);
  ok(refused.length === 0, `no catalogue title is refused, as typed, with its year or lower-cased (${forms} forms)`
    + `${refused.length ? ` - refused: ${refused.slice(0, 10).join(' | ')}` : ''}`);
}

console.log('=== a title that ends in "all" is not a whole series: Kill \'Em All ===');
{
  // A review of this branch found "Kill 'Em All" (2017), its sequel "Kill
  // 'Em All 2" (2024) and "Bless 'Em All" (1949) refused ☝️ as "a whole
  // series", told to send "kill' em". The word before "all" was "'em", which
  // the list of words that keep "all" in the title lacked, and a year did not
  // help, since it is taken off first. None of them is in clean-titles.json,
  // so the catalogue check above could not see it.
  const titles = [
    "kill 'em all", 'kill em all 2017', "Kill 'Em All 2", "Bless 'Em All", "Kill 'Em All (2017)", "Kill 'Em All 2 (2024)",
    // As a pasted TMDB link becomes it for the panel's queue (urlToRequestText).
    'Kill Em All', 'Kill Em All 2',
    'kill ’em all', "kill'em all", "gotta catch 'em all", "that's all", "it's all", 'gave it my all', 'winner take all',
    'once and for all', 'above all', 'after all', 'love conquers all', 'the know-it-all', 'god help us all', 'kill them both',
  ];
  const wrong = titles.filter((t) => severalFilms(t) || severalFilms(t.toUpperCase()) || severalFilms(`${t} 2017`));
  ok(wrong.length === 0, `${titles.length} titles ending in "all" or "both", as typed, upper-cased and with a year: none refused`
    + `${wrong.length ? ` - refused: ${wrong.join(', ')}` : ''}`);

  // Two of them in one message is still two films, and what to send keeps
  // the apostrophe where it was typed.
  ok(JSON.stringify(severalFilms("kill 'em all 1 & 2")?.requests) === JSON.stringify(["kill 'em all", "kill 'em all 2"]),
    `"kill 'em all 1 & 2" is refused, with "kill 'em all" then "kill 'em all 2" to send (${JSON.stringify(severalFilms("kill 'em all 1 & 2"))})`);
  // A possessive is not a contraction: these name a series and ask for all of it.
  ok(["five nights at freddy's both", "ocean's all"].every((t) => severalFilms(t)?.how === 'series'),
    'a possessive before "all" or "both" is still a whole series ("five nights at freddy\'s both", "ocean\'s all")');

  // The lines to send are the title as it was typed, not re-spaced token by token.
  const said = [
    ['the \'burbs 1 and 2', "the 'burbs"], ['airport \'77 1 & 2', "airport '77"], ['3:10 to yuma 1 & 2', '3:10 to yuma'],
    ['a.i. artificial intelligence 1 & 2', 'a.i. artificial intelligence'], ['10,000 bc 1 & 2', '10,000 bc'],
    ['rock \'n\' roll high school 1 and 2', "rock 'n' roll high school"], ["'the equalizer' 1 & 2", 'the equalizer'],
    ['mission impossible - fallout 1 & 2', 'mission impossible - fallout'], ['x-men 1-3', 'x-men'],
  ];
  const off = said.filter(([t, first]) => severalFilms(t)?.requests[0] !== first);
  ok(off.length === 0, `the suggested lines keep the title as typed: "the 'burbs", "3:10 to yuma", "a.i."`
    + `${off.length ? ` - wrong: ${off.map(([t]) => `${t} -> ${severalFilms(t)?.requests[0]}`).join(' | ')}` : ''}`);
}

console.log('=== what the member is told to send instead ===');
{
  const r = severalFilms('the equalizer 1 & 2');
  ok(oneFilmNote('the equalizer 1 & 2', r, '#request')
    === '☝️ "the equalizer 1 & 2" — one film per request. Send each on its own: "#request the equalizer", then "#request the equalizer 2"',
  'the operator\'s own wording, with the group\'s prefix');
  ok(/^☝️ "rocky 1 2 3 4 5 and 6" — 6 films; one film per request\. .*"#request rocky", then "#request rocky 2", and so on$/
    .test(oneFilmNote('rocky 1 2 3 4 5 and 6', severalFilms('rocky 1 2 3 4 5 and 6'), '#request')), 'past two films it counts them');
  ok(/e\.g\. "#request the matrix"/.test(oneFilmNote('the matrix trilogy', severalFilms('the matrix trilogy'), '#request')),
    'a series in words: send each film by its name');
  ok(oneFilmReply(r, '') === 'One film per request. Send each on its own: "the equalizer", then "the equalizer 2".',
    'with no prefix required, the lines are the titles alone');
}

/* --------------------------- through the plugin --------------------------- */

console.log('=== the three real requests: ☝️ and one film per request, at no OMDb cost ===');
{
  const { ctx, out, jobs, store } = harness();
  for (const [text, who, number, count] of [
    ['the equalizer 1 & 2', 'Matt Fisher', '15558170173', 2],
    ['the extraction 1 & 2', 'Matt Fisher', '15558170173', 2],
    ['rocky 1 2 3 4 5 and 6', 'JJ', '15558200194', 6],
  ]) {
    omdbCalls.length = 0;
    out.length = 0;
    const msg = ask(`#request ${text}`, { who, number });
    await moviePlugin.onMessage(msg, ctx);
    const row = rowOf(store, msg.id);
    ok(row?.status === 'one-at-a-time' && row.request === text && !row.title
      && row.detail === `${count} films in one request - told to send each on its own`,
    `"${text}" (${who}): History says one-at-a-time, not need-year (${row?.status}: ${row?.detail})`);
    ok(JSON.stringify(reactions(out, msg.id)) === '["☝️"]', `one reaction, ☝️ - no 🔍 first, no 📅 (${reactions(out, msg.id).join(' ')})`);
    ok(omdbCalls.length === 0, 'OMDb is never asked: the refusal costs no quota');
    const stem = text.replace(/ 1 .*$/, '');
    ok(notes(out).length === 1 && notes(out)[0].startsWith(`☝️ "${text}" — `)
      && notes(out)[0].includes(`Send each on its own: "#request ${stem}", then "#request ${stem} 2"`),
    `the notifications group is told what to send, with the real prefix (${notes(out)[0]})`);
    ok(replies(out).length === 0, 'and nothing is said in the request group, where replies on a refusal are off');
  }
  ok(jobs.length === 0 && !(store.data.pending ?? []).length, 'nothing is queued');
  ok(!store.data.wanted?.length && !store.data['library-misses']?.length, 'nothing reaches the wanted list or the not-in-library list');
}

console.log('=== a single film with a number in its title goes on as before ===');
{
  const { ctx, out, jobs, store } = harness();
  omdbCalls.length = 0;
  // With its year, so no "which one?" list comes first, whichever groups
  // it is asked in.
  const msg = ask('#request the equalizer 2 2018');
  await moviePlugin.onMessage(msg, ctx);
  ok(omdbCalls.length > 0 && jobs.length === 1 && rowOf(store, msg.id)?.status === 'queued',
    `"the equalizer 2 2018" is looked up and queued (${rowOf(store, msg.id)?.status})`);
  ok(reactions(out, msg.id)[0] === '🔍' && !reactions(out, msg.id).includes('☝️'), 'with the 🔍 a lookup always shows first');

  // The film the review found refused as "a whole series".
  omdbCalls.length = 0;
  const kill = ask("#request kill 'em all 2017");
  await moviePlugin.onMessage(kill, ctx);
  ok(omdbCalls.length > 0 && rowOf(store, kill.id)?.status !== 'one-at-a-time' && !reactions(out, kill.id).includes('☝️'),
    `"kill 'em all 2017" is looked up, not refused ☝️ (${rowOf(store, kill.id)?.status}: ${rowOf(store, kill.id)?.detail})`);
  ok(rowOf(store, kill.id)?.status === 'queued' && jobs.length === 2, 'and queued from the library');
}

console.log('=== with replies on, the request group is told too ===');
{
  const { ctx, out } = harness(config({ replyOnBlock: true }));
  const msg = ask('#request the equalizer 1 & 2');
  await moviePlugin.onMessage(msg, ctx);
  ok(replies(out).join() === 'One film per request. Send each on its own: "#request the equalizer", then "#request the equalizer 2".',
    `a quoted reply in the request group (${replies(out).join()})`);
}

console.log('=== the refusal starts no cooldown clock ===');
{
  const { ctx, out, jobs } = harness(config({ cooldown: 600 }));
  await moviePlugin.onMessage(ask('#request rocky 1 2 3 4 5 and 6', { who: 'JJ', number: '15558200194' }), ctx);
  const next = ask('#request the equalizer 2 2018', { who: 'JJ', number: '15558200194' });
  await moviePlugin.onMessage(next, ctx);
  ok(jobs.length === 1 && !reactions(out, next.id).includes('🚫'), 'the member\'s next request, one film, goes through');
}

console.log('=== a beta test is refused as a main group refuses it ===');
{
  const { ctx, out, store, jobs } = harness(config({ betaFeature: 'beta' }));
  omdbCalls.length = 0;
  const msg = ask('$beta004 the equalizer 1 & 2', { chatJid: TESTING });
  await moviePlugin.onMessage(msg, ctx);
  const row = rowOf(store, msg.id);
  ok(row?.status === 'one-at-a-time' && row.beta === true && row.test === 'beta004', `History: a beta row, one-at-a-time (${row?.status})`);
  ok(JSON.stringify(reactions(out, msg.id)) === '["☝️"]' && omdbCalls.length === 0, '☝️ alone, and OMDb never asked');
  ok(notes(out, TESTING).some((b) => b.includes('"$beta004 #request the equalizer", then "$beta004 #request the equalizer 2"')),
    `in the beta group, with the test's code on the lines to send (${notes(out, TESTING).join(' | ')})`);
  ok(!notes(out).length && !jobs.length, 'nothing in the main notifications group, nothing queued');
  ok(!store.data.wanted?.length && !store.data['library-misses']?.length, 'and nothing on the operator\'s lists');
}

console.log('=== a $stamtest says a main group would refuse it ===');
{
  const { ctx, out, store } = harness(config(), { stam: true });
  const msg = ask('$stamtest the equalizer 1 & 2', { chatJid: TESTING });
  const cap = await runStamTest(() => moviePlugin.onMessage(msg, ctx));
  const summary = formatStamSummary('the equalizer 1 & 2', cap.actions, { groupJid: TESTING });
  ok(/It would not go through as asked \(the bot would react ☝️\)/.test(summary), 'it would not go through: ☝️');
  ok(/one film per request\. Send each on its own: "\$stamtest #request the equalizer", then "\$stamtest #request the equalizer 2"/.test(summary),
    'with the line the notifications group would get');
  ok(!out.length && rowOf(store, msg.id)?.status === 'one-at-a-time', 'nothing sent on its own; History says one-at-a-time');
}

console.log('=== the panel: Re-run and the dry run say the same, without OMDb ===');
{
  const { ctx } = harness();
  omdbCalls.length = 0;
  let threw = null;
  try { await moviePlugin.requeue('rocky 1 2 3 4 5 and 6', ctx); } catch (err) { threw = err; }
  ok(threw?.code === 'SEVERAL_FILMS' && /6 films - one film per request: "rocky", then "rocky 2"/.test(threw.message) && omdbCalls.length === 0,
    `a Re-run is refused with what to queue instead (${threw?.message})`);
  // "Kill 'Em All", re-run from History or queued from its TMDB link (which
  // the panel reads as "Kill Em All"), is one film.
  for (const text of ["Kill 'Em All 2017", 'Kill Em All']) {
    let err = null;
    try { await moviePlugin.requeue(text, ctx); } catch (e) { err = e; }
    ok(err?.code !== 'SEVERAL_FILMS', `a Re-run of "${text}" is not refused as several films (${err?.message ?? 'queued'})`);
  }

  // A panel that has been set up: an owner with a password.
  const cfg = { ...config(), web: { ...config().web, adminPasswordHash: 'x', users: [{ username: 'owner', role: 'superadmin', passwordHash: 'x' }] } };
  const queue = new JobQueue({ concurrency: 1 }); queue.pause();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { user: { username: 'owner', role: 'superadmin' } }; next(); });
  app.use('/api', createApiRouter({
    configStore: { get: () => cfg, update: () => cfg, redacted: () => ({}), onChange: () => {} },
    bot: { groupCache: new Map(), groups: () => [], on: () => {}, state: 'connected' },
    queue, linkQueue: queue,
    pluginManager: { plugins: new Map(), notifyConfigChange: async () => {} },
    stateStore: { namespace: () => fakeStore() }, fileLogger: { tail: () => [] }, alerts: {}, lockScheduler: {},
  }));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const dryRun = (text) => new Promise((resolve, reject) => {
    const data = JSON.stringify({ text });
    const r = http.request({ host: '127.0.0.1', port: server.address().port, method: 'POST', path: '/api/test/request',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve(JSON.parse(buf)));
    });
    r.on('error', reject);
    r.end(data);
  });
  omdbCalls.length = 0;
  const r = await dryRun('the extraction 1 & 2');
  ok(r.verdict === 'one-at-a-time' && r.steps[0]?.step === 'one film' && r.steps[0].reaction === '☝️' && omdbCalls.length === 0,
    `the dry run's verdict is one-at-a-time, decided before OMDb (${JSON.stringify(r)})`);
  const single = await dryRun('the equalizer 2 2018');
  ok(single.verdict !== 'one-at-a-time' && omdbCalls.length > 0, `one film is dry-run as before (${single.verdict})`);
  const killEmAll = await dryRun("kill 'em all");
  ok(killEmAll.verdict !== 'one-at-a-time', `"kill 'em all" is dry-run as one film (${killEmAll.verdict})`);
  server.close();
  const app$ = fs.readFileSync(new URL('src/web/public/app.js', ROOT), 'utf8');
  ok(/'one-at-a-time': \['bad', 'Several films in one request/.test(app$), 'the Test tab names the verdict');
  ok(/row\(r\.oneAtATime \|\| '\\u261d\\ufe0f', 'One movie per request/.test(app$), 'and the reaction guide explains ☝️');
}

/* ------------------------- what reports on it ------------------------- */

const NOW = Date.parse('2026-10-11T21:00:00Z');
const realRow = (o) => ({
  id: `3A${++seq}`, at: o.at, requestedAt: o.at, groupJid: REQ, title: null, year: null, rated: null,
  status: 'one-at-a-time', detail: '2 films in one request - told to send each on its own', ...o,
});
const ROWS = [
  realRow({ at: Date.parse('2026-10-11T20:22:48Z'), request: 'the extraction 1 & 2', requester: 'Matt Fisher', requesterJid: '15558170173@s.whatsapp.net', requesterNumber: '15558170173' }),
  realRow({ at: Date.parse('2026-10-11T20:24:31Z'), request: 'the equalizer 1 & 2', requester: 'Matt Fisher', requesterJid: '15558170173@s.whatsapp.net', requesterNumber: '15558170173' }),
  realRow({ at: Date.parse('2026-10-11T17:50:54Z'), request: 'rocky 1 2 3 4 5 and 6', requester: 'JJ', requesterJid: '15558200194@s.whatsapp.net', requesterNumber: '15558200194', detail: '6 films in one request - told to send each on its own' }),
];

console.log('=== the hourly check: a notice, never a fault ===');
{
  const state = {
    'movie-requests': { history: [...ROWS].reverse(), pending: [] },
    'tv-requests': { history: [], pending: [], 'library-misses': [] },
    'msg-index': { entries: [] }, audit: { events: [] },
  };
  const r = scan({ now: NOW, memory: { v: 1, lastScanAt: NOW - 6 * 3600_000, seen: {}, configCheckedAt: NOW }, config: config(), unit: { ActiveState: 'active', NRestarts: '0' }, state });
  const mine = [...r.incidents, ...r.notices].filter((f) => /1 & 2|rocky 1 2/.test(f.title));
  ok(mine.length === 3 && mine.every((f) => r.notices.includes(f) && f.severity === 'notice' && !f.rerunnable && !f.restartHelps),
    `each is listed as a notice, never researched, re-run or restarted for (${mine.map((f) => f.severity).join(', ')})`);
  ok(mine.every((f) => /asked for several films in one message and was told to send each on its own/.test(f.title)),
    `saying what happened (${mine[0]?.title})`);

  // Asked the same way twice is a member who missed the answer, not a fault
  // the bot repeated.
  const twice = [ROWS[2], realRow({ ...ROWS[2], id: 'again', at: ROWS[2].at + 60_000, requestedAt: ROWS[2].at + 60_000 })];
  const chains = requestChains({ 'movie-requests': { history: twice } });
  ok(chains.length === 1 && chains[0].asks.length === 1, 'sent twice, the first is answered by the second: no repeat request');
}

console.log('=== the daily digest and the activity record count it ===');
{
  const digest = buildDigest({ history: ROWS, now: NOW });
  ok(/Several at once {2}: 3 \(told to send one film per request\)/.test(digest), 'the digest has a line for it');
  ok(!/Several at once/.test(buildDigest({ history: [], now: NOW })), 'and none on a day without one');
  const summary = summarise({ day: '2026-10-11', generatedAt: 'now', movies: { history: ROWS }, tv: { history: [] } });
  ok(/\| &nbsp;&nbsp;several films in one request \| 3 \|/.test(summary), 'the nightly activity record counts it');
}

console.log('=== the reaction: configured, never shed, explained ===');
{
  const r = DEFAULT_CONFIG.movieRequests.reactions;
  ok(r.oneAtATime === '☝️', 'reactions.oneAtATime defaults to ☝️');
  ok(Object.entries(r).filter(([k, v]) => k !== 'oneAtATime' && v === '☝️').length === 0, 'and no other reaction uses it');
  ok(TERMINAL_KEYS.includes('oneAtATime') && reactionKind(r, '☝️') === 'critical', 'it is the last word on a request, so never shed');
  ok(LEGEND.includes('☝️ More than one movie in one message — send each on its own'), 'the request groups\' legend explains it');
  const rules = fs.readFileSync(new URL('src/plugins/movie-requests/default-rules.txt', ROOT), 'utf8');
  const desc = fs.readFileSync(new URL('content/descriptions/movie-requests-only-no-chatting-whatsoever.txt', ROOT), 'utf8');
  ok(rules.includes(LEGEND), 'and the bundled #rules carries it');
  const manualReq = fs.readFileSync(new URL('content/manual/movie-requests-only-no-chatting-whatsoever.txt', ROOT), 'utf8').replace(/\n+$/, '');
  ok(desc.replace(/\n+$/, '') === manualReq, 'the request group\'s description is the operator\'s text, which says what ☝️ asks');
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
