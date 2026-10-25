/* The hourly check sees rating refusals, repeat requests, a full disk,
   duplicates in the queue and the settings. Run: node test/hourly-scan-blind-spots.test.mjs

   What the scanner missed on 2026-09-28, the owner's list:

   1. A member got Fullmetal Alchemist: Brotherhood season 1 with 3 of 64
      episodes withheld on rating (TV-MA), asked for S01E14 on its own twice
      (a bare ⛔ each time), then for the whole season again (the same 61
      posted). The scan saw a "sent" row and nothing else.
   2. The same member asking for the same thing again is a sign the first
      answer did not do: three Minority Report requests in two and a half
      hours, the last two both made and posted. But "newsies", asked for its
      year, then "newsies 1992" delivered 17 minutes later, is the question
      answered - and the scan reported "Newsies (1992) was asked for a year
      and never came back".
   3. The disk filled at 20:34 and 21:01 UTC. ffmpeg said so only as "exited
      228"; /tmp had held 4.09 GB of Baileys upload copies nobody removed.
   4. The live journal held "Loki season 1" three times and "The Mentalist
      S03E05" twice - each episode about to be made and posted again.
   5. No queue notifications group had been set since 2026-09-25, so members
      saw only reactions.

   None of these is cured by a restart, so none may ask for one. Fixtures
   are shaped like bot-box's data/state.json, config.json and debug log, with
   made-up names and numbers. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scan, parseLog, requestChains, configCheckDue, DISK_FULL, UPLOAD_COPY_NAME, DEFAULTS, headline } from '../src/core/incident-scan.js';
import { panelRun, fallbackReport } from '../src/core/hourly-checks.js';
import { diskState, botGroups, settings } from '../tools/hourly-debug.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR, GB = 1024 ** 3;
const NOW = Date.parse('2026-09-28T22:00:00Z');
const MOVIE_REQ = '120363100000000001@g.us';
const TV_REQ = '120363100000000002@g.us';
const MOVIE_POSTS = '120363100000000003@g.us';
const TV_POSTS = '120363100000000004@g.us';
const NOTIFY = '120363100000000005@g.us';
const BETA = '120363100000000006@g.us';
const NAMES = { [MOVIE_REQ]: 'MOVIE REQUESTS ONLY!', [TV_REQ]: 'TV REQUESTS ONLY!' };

// config.json as bot-box has it: the notifications group emptied in the
// panel, no text reply on a block, the TV rating notice never switched on.
const config = (o = {}) => ({
  movieRequests: {
    requestGroups: [MOVIE_REQ], postsGroup: MOVIE_POSTS, postsGroups: [], requirePrefix: true, prefix: '#request',
    notify: { group: o.notify ?? '', tagRequester: false, tagPostsGroup: true, steps: { queued: true, blocked: true } },
    replyOnBlock: false, blockedRatings: ['R', 'NC-17'],
  },
  tvRequests: { enabled: true, requestGroups: [TV_REQ], postsGroups: [TV_POSTS], requirePrefix: true, prefix: '#request', blockedRatings: ['TV-MA'] },
  beta: { groups: [BETA], postsGroup: '', features: o.features ?? { 'movie-pick-list': 'off' } },
  media: { workDir: '/home/bot/whatsapp-bot/data/media' },
});

const iso = (ts) => new Date(ts).toISOString();
const L = (ts, level, scope, msg) => `${iso(ts)} [${level.toUpperCase().padEnd(5)}] (${scope}) ${msg}`;
const log = (...lines) => parseLog(lines.join('\n'));
const at = (hhmm, day = '2026-09-28') => Date.parse(`${day}T${hhmm}:00Z`);

let seq = 0;
const hex = (n) => Array.from({ length: n }, () => '0123456789ABCDEF'[(seq++ * 7 + 3) % 16]).join('');
// A member, as the history row names them: a push name, a LID, a number.
const member = (name, n) => ({
  requester: name, requesterJid: `9${String(n).padStart(14, '0')}@lid`,
  requesterNumber: `1555000${String(n).padStart(4, '0')}`, requesterNumberDisplay: `+1 (555) 000-${String(n).padStart(4, '0')}`,
});
const AVI = member('Avi', 1);
const BEN = member('Ben', 2);
const DIANE = member('Diane', 3);

const tvRow = (who, o) => ({
  id: `AC${hex(30)}`, kind: 'tv', groupJid: TV_REQ, title: 'Fullmetal Alchemist: Brotherhood', year: 2009, season: 1, ...who,
  ...o, requestedAt: o.requestedAt ?? Math.floor(o.at / 1000) * 1000,
});
const movieRow = (who, o) => ({
  id: `3A${hex(18)}`, groupJid: MOVIE_REQ, rated: 'PG-13', ...who, ...o, requestedAt: o.requestedAt ?? Math.floor(o.at / 1000) * 1000,
});
const WITHHELD = '3 withheld (TV-MA): E14, E19, E26';

const stateWith = ({ movie = [], tv = [], moviePending = [], tvPending = [], audit = [] } = {}) => ({
  'movie-requests': { history: [...movie].reverse(), pending: moviePending },
  'tv-requests': { history: [...tv].reverse(), pending: tvPending, 'library-misses': [] },
  'msg-index': { entries: [] },
  audit: { events: audit },
});
const UNIT = { ActiveState: 'active', NRestarts: '0' };
const hourAgo = (now = NOW) => ({ v: 1, lastScanAt: now - HOUR, seen: {}, configCheckedAt: now - HOUR });
const run = (o = {}) => scan({ now: NOW, config: config(), names: NAMES, unit: UNIT, memory: hourAgo(), ...o });
const all = (r) => [...r.incidents, ...r.notices];

/* ------------------------------------------------------------------ */
console.log('=== 1. a season withheld on rating, then asked for again and again ===');
{
  // Ari's day, as the rating-notice rows record it.
  const fma = [
    tvRow(AVI, { at: at('17:38', '2026-09-27'), request: 'Fullmetal alchemist:brotherhood season 1', episodes: 61, status: 'sent', detail: `61 episode(s) posted · ${WITHHELD}`, withheld: WITHHELD }),
    tvRow(AVI, { at: at('12:03'), request: 'fullmetal alchemist brotherhood S01E14', episodes: 0, status: 'blocked-rating', rated: 'TV-MA', detail: 'S01E14 rated TV-MA', withheld: '1 withheld (TV-MA): E14' }),
    tvRow(AVI, { at: at('12:16'), request: 'fullmetal alchemist brotherhood S01E14', episodes: 0, status: 'blocked-rating', rated: 'TV-MA', detail: 'S01E14 rated TV-MA', withheld: '1 withheld (TV-MA): E14' }),
    tvRow(AVI, { at: at('14:40'), requestedAt: at('13:33'), request: 'fullmetal alchemist brotherhood  s1', episodes: 61, status: 'sent', detail: `61 episode(s) posted · ${WITHHELD}`, withheld: WITHHELD }),
  ];
  const memory = { v: 1, lastScanAt: at('11:00'), seen: {}, configCheckedAt: at('11:00') };
  const r = scan({ now: at('15:00'), memory, config: config(), names: NAMES, unit: UNIT, state: stateWith({ tv: fma }) });
  const again = r.incidents.filter((f) => f.kind === 'refused-again');
  ok(again.length === 1 && again[0].severity === 'unfulfilled', `the pattern is flagged once, as unfulfilled (${again.length})`);
  ok(/Avi asked again/.test(again[0]?.title) && /Fullmetal Alchemist: Brotherhood season 1/.test(again[0].title) && /4 requests/.test(again[0].title),
    `it names the member, the season and the count: "${again[0]?.title}"`);
  ok(/without the withheld episodes again/.test(again[0]?.title), 'and says the last request went out without them again');
  ok(again[0]?.evidence.length === 4 && again[0].evidence.filter((e) => /blocked-rating: S01E14 rated TV-MA/.test(e)).length === 2,
    'the evidence is the four requests in order, the two lone S01E14 refusals among them');
  ok(/rating policy working/.test(again[0]?.remedy) && /beta feature is Off/.test(again[0].remedy) && /no queue notifications group/.test(again[0].remedy),
    'the remedy says the rule is working and why the member was never told: the beta flag is Off, and there is no notifications group');
  ok(!again[0]?.rerunnable && !again[0]?.restartHelps && !r.restart.advised, 'never re-run, never a restart');
  ok(!r.incidents.some((f) => f.kind === 'repeat-request'), 'one story, not a refused-again and a repeat besides');

  const digest = r.notices.find((f) => f.kind === 'rating-policy');
  ok(digest && !r.incidents.some((f) => f.kind === 'rating-policy'), 'the refusals and withholds are one digest line among the notices, never researched');
  ok(digest?.items.length === 3 && /2 requests refused/.test(digest.title) && /1 request sent without episodes withheld/.test(digest.title),
    `since the last run: two refusals and today's withheld season - yesterday's row is not news (${digest?.title})`);
  ok(/not a fault/.test(digest?.title) && /no restart/.test(digest.title), 'and it says it is policy, not a fault');
  ok(digest?.evidence.some((e) => /S01E14 rated TV-MA/.test(e)) && digest.evidence.some((e) => /E14, E19, E26/.test(e)), 'naming what was refused and what was withheld');
  // A member is named by their number masked (2026-10-01), never in full.
  ok(!/1555000\d{4}|\(555\) 000-/.test(JSON.stringify(all(r))) && !JSON.stringify(r.memory).includes('00000000000001'),
    'no member\'s full number or LID in the findings or the memory');

  const r2 = scan({ now: at('16:00'), memory: r.memory, config: config(), names: NAMES, unit: UNIT, state: stateWith({ tv: fma }) });
  ok(!all(r2).some((f) => f.kind === 'refused-again' || f.kind === 'rating-policy'), 'an hour later with nothing new: neither is reported again');

  const fifth = tvRow(AVI, { at: at('16:20'), request: 'fullmetal alchemist brotherhood S01E19', episodes: 0, status: 'blocked-rating', rated: 'TV-MA', detail: 'S01E19 rated TV-MA', withheld: '1 withheld (TV-MA): E19' });
  const r3 = scan({ now: at('17:00'), memory: r2.memory, config: config(), names: NAMES, unit: UNIT, state: stateWith({ tv: [...fma, fifth] }) });
  const upd = r3.incidents.find((f) => f.kind === 'refused-again');
  ok(upd && /5 requests/.test(upd.title), `asked a fifth time: reported again, with the new count (${upd?.title})`);
  ok(r3.notices.find((f) => f.kind === 'rating-policy')?.items.length === 1, 'and the digest lists only the new refusal');

  // With the rating notice on and a notifications group, the member was told.
  const told = scan({ now: at('15:00'), memory, config: { ...config({ notify: NOTIFY, features: { 'tv-rating-notice': 'on' } }) }, names: NAMES, unit: UNIT, state: stateWith({ tv: fma }) });
  const t = told.incidents.find((f) => f.kind === 'refused-again');
  ok(t && !/beta feature/.test(t.remedy) && !/no queue notifications group/.test(t.remedy), 'where members are told, the remedy does not blame the settings');

  // A film refused on rating, asked for again: the same pattern.
  const shutter = [
    movieRow(DIANE, { at: at('14:32'), request: 'Shutter Island 2010', status: 'blocked-rating', title: 'Shutter Island', year: 2010, rated: 'R', detail: 'rated R' }),
    movieRow(DIANE, { at: at('21:21'), request: 'Shutter Island 2010', status: 'blocked-rating', title: 'Shutter Island', year: 2010, rated: 'R', detail: 'rated R' }),
  ];
  const m = run({ state: stateWith({ movie: shutter }) });
  ok(m.incidents.some((f) => f.kind === 'refused-again' && /Movie: Diane/.test(f.title) && /Shutter Island \(2010\)/.test(f.title)), 'a film refused twice to the same member is flagged too');
  ok(!/beta feature/.test(m.incidents.find((f) => f.kind === 'refused-again')?.remedy ?? ''), 'without the TV-only beta flag in its remedy');

  // Given it in the end (a rating override): a repeat, not unfulfilled any more.
  const overridden = [...fma.slice(0, 2), tvRow(AVI, { at: at('21:30'), request: 'fullmetal alchemist brotherhood S01E14', episodes: 1, status: 'sent', detail: '1 episode(s) posted' })];
  const o2 = run({ state: stateWith({ tv: overridden }) });
  ok(!o2.incidents.some((f) => f.kind === 'refused-again') && o2.incidents.some((f) => f.kind === 'repeat-request'), 'asked again and then given it: a repeat, no longer refused');
}

/* ------------------------------------------------------------------ */
console.log('=== 2. the same member asking for the same thing again ===');
{
  // Aaron, 2026-09-28: failed (upload), then asked again twice; the third
  // came while the second was still encoding, and both were posted.
  const mr = [
    movieRow(BEN, { at: at('18:38'), request: 'minority report 2002', status: 'failed', title: 'Minority Report', year: 2002, detail: 'Media upload failed on all hosts', enqueuedAt: at('18:38') + 3000 }),
    movieRow(BEN, { at: at('20:27'), request: 'minority report 2002', status: 'sent', title: 'Minority Report', year: 2002, detail: 'encode, 1.67 GB', startedAt: at('20:28'), finishedAt: at('21:21') }),
    movieRow(BEN, { at: at('21:09'), request: 'minority report 2002', status: 'sent', title: 'Minority Report', year: 2002, detail: 'encode, 1.67 GB', startedAt: at('21:09'), finishedAt: at('21:58') }),
  ];
  const r = run({ state: stateWith({ movie: mr }) });
  const rep = r.incidents.find((f) => f.kind === 'repeat-request');
  ok(rep?.severity === 'unfulfilled' && /Ben asked for Minority Report \(2002\) 3 times/.test(rep.title) && /\(failed, sent, sent\)/.test(rep.title),
    `three requests for one film are reported: "${rep?.title}"`);
  ok(/after the earlier request failed/.test(rep?.remedy) && /still being made - and both were made and posted/.test(rep.remedy),
    'saying why: once after a failure, once while the last was still being made - and that both were posted');
  ok(/no queue notifications group/.test(rep?.remedy), 'and that the member could not see it coming');
  ok(!rep?.restartHelps && !r.restart.advised, 'no restart for it');
  ok(rep?.request?.timesAsked === 3 && rep.request.requester === 'Ben', 'the request it is about names the member, and how many times');

  // Newsies: the bot asked which year; the answer came 17 minutes later.
  const newsies = [
    movieRow(DIANE, { at: at('17:28'), request: 'newsies', status: 'need-year', title: 'Newsies', year: 1992, rated: 'PG', detail: '2 copies: 1992, 2017' }),
    movieRow(DIANE, { at: at('17:45'), request: 'newsies 1992', status: 'sent', title: 'Newsies', year: 1992, rated: 'PG', detail: 'encode, 1.66 GB', finishedAt: at('18:34') }),
  ];
  const tangled = movieRow(BEN, { at: at('15:26'), request: 'tangled', status: 'need-year', title: 'Tangled', year: 2010, rated: 'PG', detail: '2 copies: 2010, 2022' });
  const n = scan({ now: at('19:00'), memory: { v: 1, lastScanAt: at('18:00'), seen: {}, configCheckedAt: at('18:00') }, config: config(), unit: UNIT, state: stateWith({ movie: [...newsies, tangled] }) });
  ok(!all(n).some((f) => /Newsies/.test(f.title)), 'a "which year?" answered and delivered is neither "never came back" nor a repeat');
  ok(n.notices.some((f) => /Tangled \(2010\) was asked for a year and never came back/.test(f.title)), 'one nobody answered still is');
  // Answered with the year of the other copy, or with the question's words
  // and the year: still the answer.
  const other = [
    movieRow(DIANE, { at: at('17:28'), request: 'newsies', status: 'need-year', title: 'Newsies', year: 1992, detail: '2 copies: 1992, 2017' }),
    movieRow(DIANE, { at: at('17:40'), request: 'newsies 2017', status: 'sent', title: 'Newsies', year: 2017, detail: 'encode' }),
  ];
  const untitled = [
    movieRow(DIANE, { at: at('17:28'), request: 'the parent trap', status: 'need-year', title: null, year: null, detail: 'too many matches - needs a year' }),
    movieRow(DIANE, { at: at('17:31'), request: 'the parent trap 1998', status: 'sent', title: 'The Parent Trap', year: 1998, detail: 'encode' }),
  ];
  ok(!all(scan({ now: at('19:00'), config: config(), unit: UNIT, state: stateWith({ movie: [...other, ...untitled] }) })).some((f) => /never came back/.test(f.title) || f.kind === 'repeat-request'),
    'answered with the other copy\'s year, or by a question that had no title yet: answered all the same');
  const chains = requestChains(stateWith({ movie: newsies }));
  ok(chains.length === 1 && chains[0].asks.length === 1 && chains[0].answered.length === 1, 'the question and its answer are one chain and one ask');

  // Not repeats.
  const twoPeople = [
    movieRow(BEN, { at: at('20:00'), request: 'heat 1995', status: 'sent', title: 'Heat', year: 1995, finishedAt: at('20:50') }),
    movieRow(DIANE, { at: at('20:30'), request: 'heat 1995', status: 'sent', title: 'Heat', year: 1995, finishedAt: at('21:40') }),
  ];
  const agt = [
    tvRow(DIANE, { at: at('10:20'), title: "America's Got Talent", season: 21, request: 'America’s got talent season 21 episode 7', episodes: 1, status: 'sent', detail: '1 episode(s) posted' }),
    tvRow(DIANE, { at: at('15:48'), title: "America's Got Talent", season: 21, request: 'America’s got talent season 21', episodes: 8, status: 'sent', detail: '8 episode(s) posted' }),
  ];
  // Rows the panel and this check write: "manual (admin)" with no number,
  // "panel (<login>)", and a member's request re-run by the check.
  const panel = [
    movieRow(BEN, { at: at('19:00'), request: 'dune 2021', status: 'failed', title: 'Dune', year: 2021, detail: 'x' }),
    { ...movieRow({}, { at: at('19:30'), request: 'dune 2021', status: 'sent', title: 'Dune', year: 2021 }), id: 'manual-1790620000000', requester: 'manual (admin)', requesterNumber: null },
    { ...movieRow(BEN, { at: at('19:40'), request: 'dune 2021', status: 'sent', title: 'Dune', year: 2021 }), requester: 'Ben (re-run by the hourly check)' },
    { ...movieRow({}, { at: at('19:10'), request: 'jellyfin:ab12', status: 'sent', title: 'Up', year: 2009 }), id: 'panel-1790620000001', requester: 'panel (owner)' },
    { ...movieRow({}, { at: at('19:20'), request: 'jellyfin:ab12', status: 'sent', title: 'Up', year: 2009 }), id: 'panel-1790620000002', requester: 'panel (owner)' },
  ];
  const queueFull = [
    movieRow(BEN, { at: at('19:00'), request: 'oblivion 2013', status: 'error', title: 'Oblivion', year: 2013, detail: 'queue full' }),
    movieRow(BEN, { at: at('20:00'), request: 'oblivion 2013', status: 'sent', title: 'Oblivion', year: 2013 }),
  ];
  const missing = [1, 2, 3].map((i) => movieRow(DIANE, { at: at(`1${i}:00`), request: 'the fantastic 4: first steps 2025', status: 'not-in-library', title: 'The Fantastic Four: First Steps', year: 2025, detail: 'not in library' }));
  const beta = [0, 1].map((i) => ({ ...movieRow(BEN, { at: at(`2${i}:00`), request: 'up 2009', status: 'sent', title: 'Up', year: 2009 }), beta: true, groupJid: BETA }));
  const dunes = [
    movieRow(AVI, { at: at('20:00'), request: 'dune', status: 'sent', title: 'Dune', year: 1984 }),
    movieRow(AVI, { at: at('20:30'), request: 'dune 2021', status: 'sent', title: 'Dune', year: 2021 }),
  ];
  // All of them since the last run, so it is the rules that keep them out,
  // not their age.
  const none = run({ memory: { v: 1, lastScanAt: at('09:00'), seen: {}, configCheckedAt: at('09:00') }, state: stateWith({ movie: [...twoPeople, ...panel, ...queueFull, ...missing, ...beta, ...dunes], tv: agt }) });
  const reps = all(none).filter((f) => f.kind === 'repeat-request' || f.kind === 'refused-again');
  ok(reps.length === 0, `not repeats: two members, one episode then its season, the panel and the check re-running, "queue full - ask again", a film the server lacks (counted on its own), beta tests, two different films of one name (${reps.map((f) => f.title).join(' | ')})`);
  ok(none.incidents.some((f) => /Fantastic Four/.test(f.title) && f.occurrences === 3), 'the missing film is still one finding, asked three times');

  // A lone episode asked for twice, and a season asked for again after one
  // of its episodes and the season itself.
  const eps = [
    tvRow(BEN, { at: at('16:02'), title: 'The Mentalist', season: 3, request: 'the mentalist season 3 episode 5', episodes: 1, status: 'queued', detail: 'The Mentalist S03E05' }),
    tvRow(BEN, { at: at('16:28'), title: 'The Mentalist', season: 3, request: 'the mentalist season 3 episode 5', episodes: 0, status: 'duplicate', detail: 'already in the queue — 1 episode(s) waiting from an earlier request' }),
  ];
  const e = run({ now: at('17:00'), memory: { v: 1, lastScanAt: at('16:00'), seen: {}, configCheckedAt: at('16:00') }, state: stateWith({ tv: eps }) });
  const ef = e.incidents.find((f) => f.kind === 'repeat-request');
  ok(/The Mentalist S03E05 2 times/.test(ef?.title) && /was not queued a second time/.test(ef.remedy), `a lone episode asked twice: "${ef?.title}"`);
  // With the notice Off it was not told "already in the queue", so the
  // finding does not claim it was (tv-duplicate-notice).
  ok(!/told "already in the queue"/.test(ef?.remedy ?? ''), 'and does not say what the member was told');

  // The duplicate is told how the earlier request ended, and its row reads
  // that outcome: still one copy, not "both were made and posted".
  const followed = [
    movieRow(AVI, { at: at('18:38'), request: 'minority report 2002', status: 'sent', title: 'Minority Report', year: 2002, finishedAt: at('19:40') }),
    movieRow(AVI, { at: at('19:06'), request: 'minority report 2002', status: 'sent', title: 'Minority Report', year: 2002, detail: 'posted, with an earlier request for it', finishedAt: at('19:40') }),
  ];
  const fr = run({ now: at('20:00'), memory: { v: 1, lastScanAt: at('19:00'), seen: {}, configCheckedAt: at('19:00') }, state: stateWith({ movie: followed }) });
  const ff = all(fr).find((f) => f.kind === 'repeat-request');
  ok(!!ff && /was not queued a second time/.test(ff.remedy) && !/both were made and posted/.test(ff.remedy),
    `a duplicate told its outcome is still the one copy: "${ff?.remedy}"`);

  // Asked again after a failure and then given it: a notice, not research.
  const charlie = [
    movieRow(DIANE, { at: at('20:23'), request: 'Charlie and the chocolate factory 2005', status: 'failed', title: 'Charlie and the Chocolate Factory', year: 2005, detail: 'ffmpeg exited 228: drop_frames=0 | speed=2.78x | progress=end' }),
    movieRow(DIANE, { at: at('21:10'), request: 'Charlie and the chocolate factory 2005', status: 'sent', title: 'Charlie and the Chocolate Factory', year: 2005, finishedAt: at('21:55') }),
  ];
  const c = run({ state: stateWith({ movie: charlie }) });
  ok(c.notices.some((f) => f.kind === 'repeat-request') && !c.incidents.some((f) => f.kind === 'repeat-request'),
    'asked again after a failure and then posted: listed, not researched - the failure is its own finding');

  // Each chain once; a chain whose last ask is older than the last run is
  // not news (its first report was then).
  const again = scan({ now: NOW + HOUR, memory: r.memory, config: config(), unit: UNIT, state: stateWith({ movie: mr }) });
  ok(!all(again).some((f) => f.kind === 'repeat-request'), 'the next hour, the same three requests are not reported again');
  const late = scan({ now: NOW + 3 * DAY, memory: { v: 1, lastScanAt: NOW + 3 * DAY - HOUR, seen: {}, configCheckedAt: NOW + 3 * DAY - HOUR }, config: config(), unit: UNIT, state: stateWith({ movie: mr }) });
  ok(!all(late).some((f) => f.kind === 'repeat-request'), 'nor days later, when the memory of it is gone but nothing new was asked');
}

/* ------------------------------------------------------------------ */
console.log('=== 3. the disk ===');
{
  // 2026-09-28 20:34-21:01 UTC, as the log has it. The first line was cut
  // short by the full disk itself.
  const lines = log(
    L(at('19:48'), 'info', 'main', 'debug log -> /home/bot/whatsapp-bot/data/logs'),
    L(at('20:34') + 47_088, 'error', 'main', 'uncaught exception: ENOSPC: no space left on device, write | {"stack":"Error:'),
    L(at('20:34') + 47_576, 'error', 'movie-requests', 'delivery failed for Charlie and the Chocolate Factory: ffmpeg exited 228: drop_frames=0 | speed=2.78x | progress=end'),
    L(at('20:34') + 48_093, 'error', 'queue', 'job Charlie and the Chocolate Factory (2005) failed: ffmpeg exited 228: drop_frames=0 | speed=2.78x | progress=end'),
    L(at('20:35'), 'warn', 'session', 'could not persist sessions: ENOSPC: no space left on device, write'),
    L(at('20:36'), 'error', 'state', 'state save failed: ENOSPC: no space left on device, write'),
    L(at('21:01') + 8215, 'error', 'movie-requests', 'delivery failed for The Parent Trap: ENOSPC: no space left on device, write'),
    L(at('21:01') + 8496, 'error', 'queue', 'job The Parent Trap (1998) failed: ENOSPC: no space left on device, write'),
    L(at('21:30'), 'error', 'main', "unhandled rejection: Cannot read properties of null (reading 'remoteJid')"),
  );
  const rows = [
    movieRow(DIANE, { at: at('20:23'), request: 'Charlie and the chocolate factory 2005', status: 'failed', title: 'Charlie and the Chocolate Factory', year: 2005, detail: 'ffmpeg exited 228: drop_frames=0 | speed=2.78x | progress=end' }),
    movieRow(BEN, { at: at('20:59'), request: 'the parent trap 1998', status: 'failed', title: 'The Parent Trap', year: 1998, detail: 'ENOSPC: no space left on device, write' }),
  ];
  const disk = { workDir: '/home/bot/whatsapp-bot/data/media', free: 16.4 * GB, size: 28.4 * GB, tmpDir: '/tmp', tmpFree: 16.4 * GB, sameFs: true, uploadCopies: [] };
  const r = run({ lines, disk, state: stateWith({ movie: rows }), memory: { v: 1, lastScanAt: at('20:00'), seen: {}, configCheckedAt: at('20:00') } });
  const full = r.incidents.filter((f) => f.kind === 'disk');
  ok(full.length === 1 && full[0].severity === 'error', 'the two times it filled, 27 minutes apart, are one episode and one finding');
  ok(/7 "no space left" lines from 20:34Z to 21:01Z/.test(full[0]?.title) && /2 jobs failed: Charlie and the Chocolate Factory \(2005\), The Parent Trap \(1998\)/.test(full[0].title),
    `with its lines and the jobs it failed: "${full[0]?.title}"`);
  ok(full[0]?.evidence.some((e) => /ffmpeg exited 228/.test(e)), 'the ffmpeg exit is in the evidence');
  ok(/Free space on the filesystem holding \/home\/bot\/whatsapp-bot\/data\/media \(16\.4 GB of 28\.4 GB free now\)/.test(full[0]?.remedy)
    && /ENOSPC/.test(full[0].remedy) && /re-run from History once there is room/.test(full[0].remedy), 'the remedy: where to free space, how much there is, and the re-runs after');
  const charlie = r.incidents.find((f) => f.request?.title === 'Charlie and the Chocolate Factory');
  ok(/the disk was full/.test(charlie?.title) && /ffmpeg exited 228, which is ENOSPC/.test(charlie.remedy) && charlie.rerunnable,
    'a film ffmpeg failed with 228 is named a full-disk failure, re-runnable once there is room');
  const errs = r.incidents.filter((f) => f.kind === 'log-error');
  ok(errs.length === 1 && /remoteJid/.test(errs[0].title), 'the ENOSPC exception and the failed state save are not "errors in the log" as well; other errors still are');
  ok(!r.restart.advised && full.every((f) => !f.restartHelps), 'and nothing asks for a restart: it would throw away the encodes, not free the disk');
  ok(DISK_FULL.test('ffmpeg exited 228: x') && !DISK_FULL.test('ffmpeg exited 2280: x') && !DISK_FULL.test('ffmpeg exited 1: Invalid data'), 'ffmpeg 228, and only 228, is a full disk');

  const r2 = scan({ now: NOW + HOUR, memory: r.memory, config: config(), unit: UNIT, lines, disk, state: stateWith({ movie: rows }) });
  ok(!all(r2).some((f) => f.kind === 'disk'), 'the next hour the same episode is not news');
  const more = log(...lines.map((l) => L(l.ts, l.level, l.scope, l.msg)), L(NOW + 30 * MIN, 'error', 'state', 'state save failed: ENOSPC: no space left on device, write'));
  const r3 = scan({ now: NOW + HOUR, memory: r.memory, config: config(), unit: UNIT, lines: more, disk, state: stateWith({ movie: rows }) });
  ok(r3.incidents.filter((f) => f.kind === 'disk').length === 1 && /at 22:30Z/.test(r3.incidents.find((f) => f.kind === 'disk').title), 'filling again an hour later is a new episode, reported');

  // Free space now.
  const free = (n, o = {}) => run({ disk: { ...disk, free: n * GB, ...o } });
  const crit = free(3).incidents.find((f) => f.fp === 'disk:free:critical');
  ok(crit?.severity === 'error' && /Only 3\.0 GB free/.test(crit.title) && /next feature film will not fit/.test(crit.title), 'under 4 GB free: an error - the next film will not fit');
  const low = free(8);
  ok(low.notices.some((f) => f.fp === 'disk:free:low') && !low.incidents.some((f) => f.kind === 'disk'), 'under 10 GB: noted');
  ok(!all(free(16)).some((f) => f.kind === 'disk'), '16 GB free: nothing');
  const c1 = free(3);
  const c2 = scan({ now: NOW + HOUR, memory: c1.memory, config: config(), unit: UNIT, disk: { ...disk, free: 3 * GB } });
  const c3 = scan({ now: NOW + 25 * HOUR, memory: { ...c2.memory, lastScanAt: NOW + 24 * HOUR }, config: config(), unit: UNIT, disk: { ...disk, free: 3 * GB } });
  ok(!all(c2).some((f) => f.kind === 'disk') && c3.incidents.some((f) => f.fp === 'disk:free:critical'), 'still that full: said again after a day, not every hour');
  const tmp = free(16, { sameFs: false, tmpDir: '/scratch/tmp', tmpFree: 1 * GB });
  ok(tmp.incidents.some((f) => f.fp === 'disk:tmp:critical' && /\/scratch\/tmp/.test(f.title)), 'a temp directory on another disk with no room for an upload copy is an error');
  ok(!free(3).restart.advised, 'none of it asks for a restart');

  // Upload copies nothing uses: one from before this process (the sweep at
  // start missed it), one this process left hours ago, one being written.
  const processStart = at('19:48');
  const health = { startedAt: processStart, connection: { state: 'connected' }, queues: { media: { running: [] } } };
  const copies = [
    { name: 'document3EB04D2182D3B1663C79D2-enc', bytes: 1.5 * GB, mtimeMs: at('06:44') },
    // Written by this process two minutes after it started, then never
    // again: no upload takes two hours.
    { name: 'document3EB0A5F300861677FBA71E-enc', bytes: 1.36 * GB, mtimeMs: processStart + 2 * MIN },
    { name: 'document3EB0C0FFEE000011112222-enc', bytes: 0.49 * GB, mtimeMs: NOW - MIN },
  ];
  ok(copies.every((f) => UPLOAD_COPY_NAME.test(f.name)) && !UPLOAD_COPY_NAME.test('document3EB0-enc') && !UPLOAD_COPY_NAME.test('notes.txt'), 'upload copies are known by the name Baileys gives them');
  const o = run({ health, disk: { ...disk, uploadCopies: copies } });
  const orphan = o.incidents.find((f) => f.fp.startsWith('disk:orphans:'));
  ok(/2 upload copies \(2\.9 GB\) left in \/tmp/.test(orphan?.title), `the two nobody uses are reported, the one being written is not: "${orphan?.title}"`);
  ok(/rm -f \/tmp\/document3EB04D2182D3B1663C79D2-enc \/tmp\/document3EB0A5F300861677FBA71E-enc/.test(orphan?.remedy) && !/C0FFEE/.test(orphan.remedy),
    'the remedy is the command that removes exactly those');
  ok(!orphan?.restartHelps && !o.restart.advised, 'removing them is a person\'s job, not a restart\'s');
  // Restarted half an hour ago: a copy from 40 minutes ago is the last
  // process's, which the sweep at start should have taken.
  const young = run({ health: { ...health, startedAt: NOW - 30 * MIN }, disk: { ...disk, uploadCopies: [{ name: 'document3EB0000000000000000001-enc', bytes: GB, mtimeMs: NOW - 40 * MIN }] } });
  ok(young.incidents.some((f) => f.fp.startsWith('disk:orphans:') && /1 upload copy/.test(f.title)), 'a copy older than the process that is running is left over, however new');
  const first = scan({ now: NOW, config: config({ notify: NOTIFY }), unit: UNIT, health, disk: { ...disk, uploadCopies: copies } });
  ok(first.firstRun && first.incidents.some((f) => f.fp.startsWith('disk:orphans:')), 'a first run reports copies written long before the day it looks back over');
  const o2 = scan({ now: NOW + HOUR, memory: o.memory, config: config(), unit: UNIT, health, disk: { ...disk, uploadCopies: copies } });
  ok(!all(o2).some((f) => f.fp.startsWith('disk:orphans:')), 'the same copies are not reported every hour');
}

/* ------------------------------------------------------------------ */
console.log('=== 4. the same film or episodes waiting in the queue twice ===');
{
  // tv-requests' journal, as the live one read on 2026-09-28.
  const eps = (series, season, nums) => nums.map((n) => ({
    id: `${series.length.toString(16)}${String(season).padStart(2, '0')}${String(n).padStart(2, '0')}`.padEnd(32, 'a'),
    series, season, episode: n, title: `Episode ${n}`, rating: 'TV-14', localPath: `/mnt/tv/${series}/S${season}E${n}.mp4`, size: 5e8, container: 'mp4',
  }));
  const req = (msgId, label, who, askedAt, episodes, extra = {}) => ({
    reqKey: `tv-${msgId}-${askedAt}`, label, msgId, msgKey: { remoteJid: TV_REQ, fromMe: false, id: msgId, participant: who.requesterJid },
    chatJid: TV_REQ, requester: who.requesterNumberDisplay, requesterNumber: who.requesterNumber,
    baseRow: { id: msgId, kind: 'tv', at: askedAt, requestedAt: askedAt, ...who, groupJid: TV_REQ, request: label, title: episodes[0].series, season: episodes[0].season, episodes: episodes.length, status: 'queued', detail: label },
    episodes, ...extra,
  });
  const loki = eps('Loki', 1, [1, 2, 3, 4, 5, 6]);
  const tvPending = [
    req('3A6561020FC1DEB51CDF', 'Loki season 1 — 6 episode(s)', BEN, at('15:31'), loki),
    req('ACE3400819D8D8923846', 'The Mentalist S03E04', DIANE, at('15:40'), eps('The Mentalist', 3, [4])),
    req('AC6F9399A41017B84FDD', 'The Mentalist S03E05', DIANE, at('16:02'), eps('The Mentalist', 3, [5])),
    req('ACF557BFC3F65C0EC5D8', 'The Mentalist S03E05', DIANE, at('16:28'), eps('The Mentalist', 3, [5])),
    req('3A61383D46DCE9B38146', 'Loki season 1 — 6 episode(s)', BEN, at('19:06'), loki),
    req('3A8CB9B4250CB1330ABF', 'Loki season 1 — 6 episode(s)', BEN, at('20:14'), loki),
    // The same season asked for in the beta group goes to the beta posts
    // group: a test, not a second post.
    req('3ABE7A000000000000AA', 'Loki season 1 — 6 episode(s)', AVI, at('20:20'), loki, { route: { beta: true, postsGroup: BETA, notifyGroup: BETA } }),
  ];
  const moviePending = [
    { jobKey: 'AC8347C93EDA0C4151D0:tt0181689', msgId: 'AC8347C93EDA0C4151D0', chatJid: MOVIE_REQ, movie: { title: 'Minority Report', year: 2002, imdbId: 'tt0181689', rated: 'PG-13' }, meta: { requester: BEN.requester, requesterNumber: BEN.requesterNumberDisplay, group: MOVIE_REQ, imdbId: 'tt0181689' }, record: { id: 'AC8347C93EDA0C4151D0', at: at('20:27'), ...BEN, groupJid: MOVIE_REQ, request: 'minority report 2002', status: 'queued', title: 'Minority Report', year: 2002 } },
    { jobKey: 'ACDACFAAB9150BD18AE9:tt0181689', msgId: 'ACDACFAAB9150BD18AE9', chatJid: MOVIE_REQ, movie: { title: 'Minority Report', year: 2002, imdbId: 'tt0181689', rated: 'PG-13' }, meta: { requester: BEN.requester, requesterNumber: BEN.requesterNumberDisplay, group: MOVIE_REQ, imdbId: 'tt0181689' }, record: { id: 'ACDACFAAB9150BD18AE9', at: at('21:09'), ...BEN, groupJid: MOVIE_REQ, request: 'minority report 2002', status: 'queued', title: 'Minority Report', year: 2002 } },
    { jobKey: '3ACAF5B89B9C96263530:tt0367594', msgId: '3ACAF5B89B9C96263530', chatJid: MOVIE_REQ, movie: { title: 'Charlie and the Chocolate Factory', year: 2005, imdbId: 'tt0367594', rated: 'PG' }, record: { id: '3ACAF5B89B9C96263530', at: at('21:00'), ...DIANE, status: 'queued' } },
  ];
  const r = run({ state: stateWith({ tvPending, moviePending }) });
  const dup = r.incidents.filter((f) => f.kind === 'duplicate-queued');
  ok(dup.length === 1 && dup[0].severity === 'unfulfilled', 'the copies are one incident, a list');
  const items = dup[0]?.items ?? [];
  ok(items.length === 4, `four later copies: two of Loki, one of S03E05, one of Minority Report - not the beta test, not S03E04 (${items.length})`);
  ok(items.filter((i) => /Loki season 1/.test(i.title) && /6 episodes \(S01E01, S01E02, S01E03, S01E04, S01E05, S01E06\)/.test(i.title)).length === 2, 'each Loki copy names its six episodes');
  ok(items.some((i) => /Minority Report \(2002\) is waiting in the queue a second time/.test(i.title)), 'a film waiting twice is found as well');
  ok(dup[0]?.evidence.some((e) => /waiting already from "Loki season 1 — 6 episode\(s\)", asked 2026-09-28 15:31Z by Ben/.test(e)), 'saying which request it copies, and when');
  ok(/Cancel the later copy in the panel/.test(dup[0]?.remedy) && !dup[0].restartHelps && !r.restart.advised, 'the remedy is a Cancel in the panel, not a restart');
  ok(!/1555000\d{4}|\(555\) 000-/.test(JSON.stringify(dup)), 'no member\'s full number in it (the journal holds them)');
  const r2 = scan({ now: NOW + HOUR, memory: r.memory, config: config(), unit: UNIT, state: stateWith({ tvPending, moviePending }) });
  ok(!all(r2).some((f) => f.kind === 'duplicate-queued'), 'the same copies are not news the next hour');
  const gone = scan({ now: NOW + HOUR, memory: r.memory, config: config(), unit: UNIT, state: stateWith({ tvPending: tvPending.filter((x) => x.msgId !== '3A8CB9B4250CB1330ABF'), moviePending }) });
  ok(!all(gone).some((f) => f.kind === 'duplicate-queued'), 'nor is a copy leaving the queue');
  const fourth = [...tvPending, req('3A0000000000000000F4', 'Loki season 1 — 6 episode(s)', BEN, NOW + 10 * MIN, loki)];
  const r3 = scan({ now: NOW + HOUR, memory: r.memory, config: config(), unit: UNIT, state: stateWith({ tvPending: fourth, moviePending }) });
  ok(r3.incidents.find((f) => f.kind === 'duplicate-queued')?.items.length === 1, 'a new copy is');
}

/* ------------------------------------------------------------------ */
console.log('=== 5. the settings, once a day ===');
{
  const cleared = { ts: Date.parse('2026-09-25T02:19:49Z'), user: 'owner', role: 'admin', ip: '10.0.0.2', action: 'changed settings',
    detail: `changed 2 settings — movieRequests.notify.group: "${NOTIFY}" → (empty); movieRequests.notify.tagRequester: true → false` };
  const groups = { at: NOW - HOUR, jids: [MOVIE_REQ, TV_REQ, MOVIE_POSTS, NOTIFY, BETA] };
  const fresh = { v: 1, lastScanAt: NOW - HOUR, seen: {} };
  const r = run({ memory: fresh, groups, state: stateWith({ audit: [cleared] }) });
  const cfg = r.notices.filter((f) => f.kind === 'config');
  const noNotify = cfg.find((f) => f.fp === 'config:no-notify-group');
  ok(noNotify && /members see only reactions/.test(noNotify.title) && noNotify.evidence.some((e) => /cleared in the panel 2026-09-25 02:19Z/.test(e)),
    'no notifications group: noted, with when it was cleared');
  ok(/Queue notifications group/.test(noNotify?.remedy), 'and where to set it');
  const notIn = cfg.find((f) => f.fp === `config:not-in:${TV_POSTS}`);
  ok(notIn && /The TV posts group/.test(notIn.title) && /not among the 5 groups/.test(notIn.title), 'a posts group the bot is not in is noted');
  ok(!cfg.some((f) => f.fp === `config:not-in:${MOVIE_POSTS}`), 'one it is in is not');
  ok(!r.incidents.some((f) => f.kind === 'config') && !r.restart.advised && headline(r.incidents) === 'all clear',
    'settings notes are low-priority: never researched, never a restart - the hour is all clear');
  ok(r.memory.configCheckedAt === NOW && !configCheckDue(r.memory, NOW + HOUR) && configCheckDue(r.memory, NOW + DAY), 'and looked at once a day');

  // The next hour a posts group the bot is not in appears as well: it waits
  // for tomorrow's look, like everything else in the settings.
  const next = scan({ now: NOW + HOUR, memory: r.memory, config: { ...config(), movieRequests: { ...config().movieRequests, postsGroups: ['120363100000000099@g.us'] } }, unit: UNIT, groups, state: stateWith({ audit: [cleared] }) });
  ok(!all(next).some((f) => f.kind === 'config'), 'the next hour: not looked at, so neither repeated nor anything new'); 
  const tomorrow = scan({ now: NOW + DAY + MIN, memory: { ...next.memory, lastScanAt: NOW + DAY }, config: config(), unit: UNIT, groups, state: stateWith({ audit: [cleared] }) });
  ok(tomorrow.notices.some((f) => f.fp === 'config:no-notify-group'), 'the next day, while it still stands, it is noted again');
  ok(!run({ memory: fresh }).notices.some((f) => /not among/.test(f.title)), 'with no list of the bot\'s groups, membership is not judged');
  ok(!run({ memory: fresh, config: config({ notify: NOTIFY }), groups }).notices.some((f) => f.fp === 'config:no-notify-group'), 'with a notifications group set, nothing about it');

  // A beta feature parked on Beta.
  const toBeta = (days) => ({ ts: NOW - days * DAY, action: 'changed settings', detail: 'changed 1 setting — beta.features.tv-rating-notice: "off" → "beta"' });
  const betaCfg = config({ notify: NOTIFY, features: { 'tv-rating-notice': 'beta' } });
  const stale = run({ memory: fresh, config: betaCfg, state: stateWith({ audit: [toBeta(10)] }) });
  ok(stale.notices.some((f) => f.fp === 'config:beta-stale:tv-rating-notice' && /"TV episodes withheld on rating" has been on Beta for 10 days/.test(f.title)), 'on Beta for ten days: noted');
  ok(!run({ memory: fresh, config: betaCfg, state: stateWith({ audit: [toBeta(2)] }) }).notices.some((f) => f.kind === 'config'), 'for two days: not yet');
  const seenLong = run({ memory: { ...fresh, betaSince: { 'tv-rating-notice': NOW - 9 * DAY } }, config: betaCfg });
  ok(seenLong.notices.some((f) => f.fp === 'config:beta-stale:tv-rating-notice'), 'with no audited change, since this check first saw it on Beta');
  ok(run({ memory: fresh, config: betaCfg }).memory.betaSince['tv-rating-notice'] === NOW, 'which it remembers');
  ok(!run({ memory: fresh, config: config({ notify: NOTIFY, features: { 'tv-rating-notice': 'on' } }), state: stateWith({ audit: [toBeta(10)] }) }).notices.some((f) => f.kind === 'config'),
    'a feature promoted to On is not "on Beta"');
}

/* ------------------------------------------------------------------ */
console.log('=== none of it asks for a restart, all of it together ===');
{
  const r = run({
    memory: { v: 1, lastScanAt: NOW - HOUR, seen: {} },
    lines: log(L(NOW - 30 * MIN, 'error', 'state', 'state save failed: ENOSPC: no space left on device, write')),
    disk: { workDir: '/w', free: 1 * GB, size: 28 * GB, tmpDir: '/tmp', sameFs: true, uploadCopies: [{ name: 'document3EB04D2182D3B1663C79D2-enc', bytes: GB, mtimeMs: NOW - 5 * HOUR }] },
    groups: { at: NOW, jids: [MOVIE_REQ] },
    state: stateWith({
      movie: [
        movieRow(BEN, { at: NOW - 50 * MIN, request: 'heat 1995', status: 'blocked-rating', title: 'Heat', year: 1995, rated: 'R', detail: 'rated R' }),
        movieRow(BEN, { at: NOW - 40 * MIN, request: 'heat 1995', status: 'blocked-rating', title: 'Heat', year: 1995, rated: 'R', detail: 'rated R' }),
      ],
    }),
  });
  const kinds = new Set(all(r).map((f) => f.kind));
  ok(['disk', 'refused-again', 'rating-policy', 'config'].every((k) => kinds.has(k)), `every new kind is there (${[...kinds].join(', ')})`);
  ok(!r.restart.advised && r.restart.reasons.length === 0, 'and not one of them is a reason to restart');
  ok(all(r).every((f) => !f.restartHelps), 'none claims a restart would help');
}

/* ------------------------------------------------------------------ */
console.log('=== the hourly run measures the disk and asks for the groups ===');
{
  const box = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-blind-'));
  try {
    const data = path.join(box, 'data');
    const tmp = path.join(box, 'tmp');
    fs.mkdirSync(path.join(data, 'media'), { recursive: true });
    fs.mkdirSync(path.join(data, 'backups'), { recursive: true });
    fs.mkdirSync(tmp);
    fs.writeFileSync(path.join(tmp, 'document3EB04D2182D3B1663C79D2-enc'), 'x'.repeat(1000));
    fs.writeFileSync(path.join(tmp, 'notes.txt'), 'not ours');
    const s = settings({ HOME: box, HOURLY_DEBUG_APP_DIR: box, HOURLY_DEBUG_DATA_DIR: data, HOURLY_DEBUG_STATE_DIR: path.join(box, 'state'), HOURLY_DEBUG_BOT_TMPDIR: tmp });
    const d = diskState(s, {});
    ok(d.workDir === path.join(data, 'media') && Number.isFinite(d.free) && d.free > 0 && Number.isFinite(d.size), 'free space where the bot works, defaulting to data/media');
    ok(d.tmpDir === tmp && d.sameFs === true && d.uploadCopies.length === 1 && d.uploadCopies[0].bytes === 1000, 'and the upload copies in the bot\'s temp directory, only those');
    ok(diskState(s, { media: { workDir: path.join(box, 'nowhere') } }).free === undefined, 'a work directory that cannot be measured is left out, not guessed');

    const asked = [];
    const ask = async (_d, cmd) => { asked.push(cmd.op); return { op: 'dump-groups', ok: true, at: NOW, groups: [{ jid: MOVIE_REQ, subject: 'x' }, { jid: TV_REQ, subject: 'y' }] }; };
    const g = await botGroups(s, { health: { connection: { state: 'connected' } }, ask, now: NOW });
    ok(g?.from === 'bot' && g.jids.length === 2 && asked.join() === 'dump-groups', 'connected: the bot is asked for its own list of groups');
    const none = await botGroups(s, { health: { connection: { state: 'connecting' } }, ask, now: NOW });
    ok(none === null && asked.length === 1, 'not connected, and no snapshot: nothing - an empty list would make every group look left');
    fs.writeFileSync(path.join(data, 'backups', 'descriptions-latest.json'), JSON.stringify({ at: NOW - HOUR, groups: [{ jid: MOVIE_REQ, subject: 'x', desc: '' }] }));
    const snap = await botGroups(s, { dryRun: true, ask, now: NOW });
    ok(snap?.from === 'snapshot' && snap.jids[0] === MOVIE_REQ && asked.length === 1, 'a dry run asks nothing and uses the recent group snapshot');
    ok(await botGroups(s, { dryRun: true, ask, now: NOW + 3 * DAY }) === null, 'but not one days old');
  } finally {
    fs.rmSync(box, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */
console.log('=== the panel and the report carry what was noted and what to do ===');
{
  const row = panelRun({ id: '20260928T220002Z', at: NOW, result: 'all-clear', found: 0, notices: 1, noted: ['Rating policy at work: 2 requests refused - call +1 (555) 000-0001'] });
  ok(row.noted.length === 1 && /Rating policy at work/.test(row.noted[0]) && !row.noted[0].includes('000-0001'), 'the panel gets the noted titles, scrubbed');
  const r = run({ disk: { workDir: '/w', free: 3 * GB, size: 28 * GB, uploadCopies: [] }, memory: { v: 1, lastScanAt: NOW - HOUR, seen: {} } });
  const report = fallbackReport({ id: 'x', scanResult: r, claude: { outcome: 'not-set-up', detail: 'no token' } });
  ok(/what to do: Free space before it fills/.test(report), 'the report says what to do for an incident');
  ok(/## Also noted[\s\S]*No queue notifications group[\s\S]*what to do: Settings/.test(report), 'and for what it only noted');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
