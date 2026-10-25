/* The parts of a season the episode limit cut are re-run apart: one is never "asked for again" by another.
   Run: node test/tv-parts-of-a-season-rerun-apart.test.mjs

   Since 2026-10-12 a season past tvRequests.maxEpisodesPerRequest is asked
   for in parts, and its member is told the exact message for the next one:
   "Arrow s1" queues E1-E10, then "#request Arrow S01E11-E20" (tv-requests
   cap-cut.js, next-part.js); a request queued before the limit, trimmed to
   it, is told the same (trimQueued). The hourly check's re-run rules
   (src/core/hourly-policy.js askedAgain, rerunRefusal) matched a later
   request on its title and season alone, so (found in review):

   - the first part failed whole - none of E1-E10 posted - and the member
     then sent the second as told: the scan said "It was sent since, to Ari
     (request B): nothing to re-run", rerunnable false, and the bot's
     requeue op refused "it was asked for again since, and that request is
     sent". E1-E10 were never posted, and never would be;
   - the first part still being made, the second failed whole: the scan
     offered the re-run, and the requeue op refused it, "it is still in the
     queue", because part 1's journal entry had the same title and season.

   A TV row is now the same request again only if it is about an episode in
   common - what a cut row queued (its `cut`), else what its request named -
   and a journal entry holds a failed row only if it holds one of its
   episodes. The scan reads which episodes a row is about the same way
   (incident-scan.js sameShowPart), so it never calls a part a repeat that a
   re-run would be let through for. A cut row is re-run as the run it
   queued, "Arrow S01E01-E10", not the whole season it asked for. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { askedAgain, rerunRefusal, shareEpisodes, tvEpisodes } from '../src/core/hourly-policy.js';
import { scan, requestChains } from '../src/core/incident-scan.js';
import { runAdminCommand } from '../src/core/admin-commands.js';
import { StateStore } from '../src/core/state.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const NOW = Date.now();
const MIN = 60_000;
const CUT = {
  limit: 10, count: 10, of: 23, queued: [[1, 10]], left: [[11, 23]], next: { season: 1, from: 11, to: 20, last: false }, parts: [[11, 20], [21, 23]],
};
const tvRow = (id, request, at, extra = {}) => ({
  id, kind: 'tv', request, title: 'Arrow', year: 2012, season: 1, episodes: 10, status: 'sent',
  requester: 'Ari', requesterJid: 'ari@lid', groupJid: 'tvreq@g.us', requestedAt: at, at, ...extra,
});
const failedA = tvRow('A', 'Arrow s1', NOW - 120 * MIN, { status: 'failed', cut: CUT, detail: '0 of 10 posted, 10 failed' });
const sentB = tvRow('B', 'Arrow S01E11-E20', NOW - 30 * MIN);

console.log('=== which episodes a row is about ===');
{
  ok(same(tvEpisodes(failedA), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 'a cut row: what it queued');
  ok(same(tvEpisodes(sentB), [11, 12, 13, 14, 15, 16, 17, 18, 19, 20]), 'a run');
  ok(same(tvEpisodes(tvRow('L', 'Arrow S01E06, E09', NOW)), [6, 9]), 'a list, by the episodes it names');
  ok(same(tvEpisodes(tvRow('E', 'Arrow S01E05', NOW)), [5]), 'one episode');
  ok(tvEpisodes(tvRow('S', 'Arrow season 1', NOW)) === null, 'a whole season: every episode of it');
  ok(!shareEpisodes(failedA, sentB) && shareEpisodes(failedA, tvRow('S', 'Arrow season 1', NOW)), 'the parts share nothing; a season shares all');
  // Read defensively: History holds whatever an older version wrote.
  ok(same(tvEpisodes({ request: 'Arrow s1', cut: { queued: [['x', 3], 'junk', [1, 2]] } }), [1, 2]), 'a malformed run is skipped');
}

console.log('=== the first part failed, the second sent: the first is still re-run ===');
{
  const history = [sentB, failedA];
  ok(askedAgain('tv', failedA, history) === null, 'the next part is not the first asked for again');
  ok(rerunRefusal({ plugin: 'tv', row: failedA, history, now: NOW }) === null, 'so the re-run rules let it through');
  const queued = { ...sentB, status: 'queued' };
  ok(rerunRefusal({ plugin: 'tv', row: failedA, history: [queued, failedA], now: NOW }) === null, 'and so while the next part is still queued');

  // What still counts as asking again: an episode it queued, the season
  // again, a run or a list that takes in one of its episodes.
  for (const [request, why] of [['Arrow S01E05', 'one of its episodes'], ['Arrow season 1', 'the whole season'],
    ['Arrow S01E08-E15', 'a run that takes in some of it'], ['Arrow S01E09, E12', 'a list that names one of them']]) {
    const again = tvRow('C', request, NOW - 20 * MIN);
    ok(askedAgain('tv', failedA, [again, failedA])?.id === 'C'
      && /asked for again since, and that request is sent/.test(rerunRefusal({ plugin: 'tv', row: failedA, history: [again, failedA], now: NOW }) ?? ''),
    `${why} ("${request}") is still asking again`);
  }
  ok(askedAgain('tv', failedA, [tvRow('D', 'Arrow S01E12, E14', NOW - 20 * MIN), failedA]) === null, 'a list of the next part\'s episodes is not');
  // Before 2026-10-12 a run was matched on its season too: "Arrow
  // S01E01-E05" failed and "S01E06-E10" sent was "asked for again".
  const runA = tvRow('RA', 'Arrow S01E01-E05', NOW - 120 * MIN, { status: 'failed' });
  ok(askedAgain('tv', runA, [tvRow('RB', 'Arrow S01E06-E10', NOW - 20 * MIN), runA]) === null, 'two runs with nothing in common are two requests');
  const seasonA = tvRow('SA', 'Arrow season 1', NOW - 120 * MIN, { status: 'failed' });
  ok(askedAgain('tv', seasonA, [tvRow('SB', 'Arrow S01E05', NOW - 20 * MIN), seasonA])?.id === 'SB', 'a whole season failed, then one of it sent: still asked again');

  // The hourly check's scan offers the re-run, and does not say "nothing to re-run".
  const found = scan({ now: NOW, state: { 'tv-requests': { history } }, options: { firstRunLookbackMs: 24 * 60 * MIN } });
  const f = found.incidents.find((x) => x.kind === 'request-failed' && x.request?.id === 'A');
  ok(f && f.rerunnable === true && !/nothing to re-run/.test(f.remedy ?? ''),
    `the scan: rerunnable, no "nothing to re-run" (${f?.rerunnable}; ${f?.remedy ?? 'no remedy'})`);
  ok(!found.incidents.some((x) => x.kind === 'repeat-request'), 'and no repeat-request');
}

console.log('=== the first part still being made, the second failed: the second is re-run ===');
{
  const failedB = { ...sentB, status: 'failed', detail: '0 of 10 posted, 10 failed' };
  const part1 = {
    reqKey: 'tv-A-1', label: 'Arrow S01E01–E10 — 10 of season 1', msgId: 'A',
    baseRow: { ...failedA, status: 'queued' },
    episodes: [4, 5, 6, 7, 8, 9, 10].map((n) => ({ id: `A1E${n}`, series: 'Arrow', season: 1, episode: n })),
  };
  ok(rerunRefusal({ plugin: 'tv', row: failedB, history: [failedB, failedA], journal: [part1], now: NOW }) === null,
    'part 1 in the journal holds none of E11-E20: the re-run is let through');
  const holding = { ...part1, episodes: [...part1.episodes, { id: 'A1E15', series: 'Arrow', season: 1, episode: 15 }] };
  ok(/still in the queue/.test(rerunRefusal({ plugin: 'tv', row: failedB, history: [failedB], journal: [holding], now: NOW }) ?? ''),
    'one journalled with E15 holds it: refused, as it always was');
  // A journal entry whose episodes have no number to read is judged by what it asked for.
  const old = { reqKey: 'tv-O-1', baseRow: { title: 'Arrow', season: 1, request: 'Arrow season 1' }, episodes: [{ id: 'x', series: 'Arrow', season: 1 }] };
  ok(/still in the queue/.test(rerunRefusal({ plugin: 'tv', row: failedB, history: [failedB], journal: [old], now: NOW }) ?? ''),
    'a whole season journalled with episodes it cannot number holds it');
  ok(/still in the queue/.test(rerunRefusal({ plugin: 'tv', row: failedB, history: [failedB], journal: [{ ...part1, msgId: 'B' }], now: NOW }) ?? ''),
    'its own journal entry always does');
}

console.log('=== the bot\'s requeue op re-runs a cut row as the run it queued ===');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-parts-rerun-'));
  try {
    const st = new StateStore(path.join(tmp, 'state.json'));
    const tvNs = st.namespace('tv-requests');
    tvNs.set('history', [sentB, failedA]);
    const calls = [];
    const stub = {
      plugins: new Map([['tv-requests', {
        plugin: { async requeue(text) { calls.push(text); return { kind: 'tv', series: 'Arrow', season: 1, scope: 'S01E01–E10', queued: 10 }; } },
        ctx: { store: tvNs },
      }]]),
    };
    const r = await runAdminCommand({ op: 'requeue', plugin: 'tv', id: 'A', by: 'hourly check' }, { bot: {}, dataDir: tmp, stateStore: st, pluginManager: stub });
    ok(r.ok && same(calls, ['Arrow S01E01-E10']), `re-run, as "Arrow S01E01-E10" - what it queued, not the whole season (${JSON.stringify(calls)})`);
    // A row with no `cut`, or one whose queued episodes are not one run, is
    // asked for as its member asked.
    tvNs.set('history', [tvRow('Z', 'arrow s1', NOW - 60 * MIN, { status: 'failed' }), tvRow('Y', 'Arrow s1', NOW - 60 * MIN, {
      status: 'failed', cut: { ...CUT, queued: [[1, 2], [4, 11]] },
    })]);
    await runAdminCommand({ op: 'requeue', plugin: 'tv', id: 'Z' }, { bot: {}, dataDir: tmp, stateStore: st, pluginManager: stub });
    await runAdminCommand({ op: 'requeue', plugin: 'tv', id: 'Y' }, { bot: {}, dataDir: tmp, stateStore: st, pluginManager: stub });
    ok(same(calls.slice(1), ['arrow s1', 'Arrow s1']), `otherwise as the member asked (${JSON.stringify(calls.slice(1))})`);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

console.log('=== the scan reads a part the same way: a range that overlaps nothing is a later part ===');
{
  const chainsOf = (rows) => requestChains({ 'tv-requests': { history: rows } }).filter((c) => c.plugin === 'tv');
  const a = tvRow('A', 'Arrow s1', NOW - 60 * MIN, { status: 'queued', cut: CUT });
  // Not one of the parts the bot named, but none of what it queued either.
  ok(chainsOf([a, tvRow('X', 'Arrow S01E15-E18', NOW - 30 * MIN)]).length === 2, 'S01E15-E18 after a cut E1-E10 is not a repeat');
  ok(chainsOf([a, tvRow('Y', 'Arrow S01E09-E12', NOW - 30 * MIN)]).length === 1, 'S01E09-E12 takes in two of what it queued: a repeat');
  ok(chainsOf([a, tvRow('L', 'Arrow S01E12, E14', NOW - 30 * MIN)]).length === 2, 'a list of none of them is not');
  // A malformed `cut` neither throws nor counts.
  const odd = tvRow('O', 'Arrow s1', NOW - 60 * MIN, { status: 'queued', cut: { queued: [['x', 3], [1, 2]], parts: 'nope' } });
  ok(chainsOf([odd, tvRow('P', 'Arrow S01E11-E20', NOW - 30 * MIN)]).length === 2, 'a malformed cut is read for what it holds');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
