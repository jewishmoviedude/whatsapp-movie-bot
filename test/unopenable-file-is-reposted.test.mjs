/* A file WhatsApp would not open is found from the member's #issue, and sent
   again once the cause is fixed. Run: node test/unopenable-file-is-reposted.test.mjs

   Daniel Sloss - Live Shows S01E01 went out on 2026-10-12 as the library
   held it, an H.264/AAC mp4 with 26 subtitle tracks besides, and A. Ito
   wrote "#issue #group04": WhatsApp said "This file was sent in an unusual
   format that may indicate it is dangerous, corrupted, or otherwise not
   supported on WhatsApp. For security precautions, this file cannot be
   opened." Repackaged with its picture and sound only (5ea102d) it opened.
   The operator, 2026-10-13: "if anybody opens an #issue ticket and quotes
   that error you'll know what to do, and of course put that logic in the
   repo in the hourly debug instructions". The re-post itself was refused
   that night - "a request that ended "sent" is not re-run from here" - and
   had to be queued by hand. Now the scan marks such an #issue `unopenable`
   with the known cure, and the check may re-post the send, once, in a run
   that has one. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scan, UNOPENABLE } from '../src/core/incident-scan.js';
import { rerunRefusal } from '../src/core/hourly-policy.js';
import { botRequest } from '../tools/hourly-debug.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const QUOTE = 'This file was sent in an unusual format that may indicate it is dangerous, corrupted, or otherwise not supported on WhatsApp. For security precautions, this file cannot be opened.';
const NOW = Date.parse('2026-10-13T15:00:00Z');
const HOUR = 3600_000;

console.log('=== the quote is recognised, in whole or in part ===');
{
  ok(UNOPENABLE.test(QUOTE), 'the whole warning');
  ok(UNOPENABLE.test('#issue #group04 daniel sloss says unusual format, cant open'), 'its words, half remembered');
  ok(UNOPENABLE.test('whatsapp says the file cannot be opened'), '"cannot be opened"');
  ok(UNOPENABLE.test('#issue #group04 file for Daniel Sloss S01E01 gives this message when download is attempted'),
    'A. Ito\'s own words, which showed the warning rather than typing it');
  ok(UNOPENABLE.test('the episode wont open on my phone'), 'a file that will not open');
  ok(!UNOPENABLE.test('#issue the movie has no sound after 20 minutes'), 'not another fault');
  ok(!UNOPENABLE.test('#issue I asked for Arrow and it never came'), 'nor one never sent');
  ok(!UNOPENABLE.test('#issue season 3 is missing'), 'nor a missing season');
}

console.log('=== the scan marks it, with the cure ===');
{
  const DISCUSSIONS = '120363900000000002@g.us';
  const config = {
    movieRequests: { requestGroups: [], notify: {} }, tvRequests: { requestGroups: [] }, beta: { groups: [], features: {} }, media: {},
    libraryNews: { senders: [], groups: [DISCUSSIONS] },
  };
  const state = {
    'movie-requests': { history: [], pending: [] }, 'tv-requests': { history: [], pending: [], 'library-misses': [] },
    'msg-index': { entries: [] }, audit: { events: [] },
  };
  const news = [
    { kind: 'issue', group: DISCUSSIONS, groupName: '06 MOVIE DISCUSSIONS', at: NOW - 20 * 60_000, id: 'I1', sender: '18455551234', name: 'A. Ito', text: `#issue #group04 Daniel sloss live shows ${QUOTE}` },
    { kind: 'issue', group: DISCUSSIONS, groupName: '06 MOVIE DISCUSSIONS', at: NOW - 10 * 60_000, id: 'I2', sender: '18455554321', name: 'B. Other', text: '#issue Arrow S01E03 has no sound' },
  ];
  const r = scan({ now: NOW, config, names: {}, unit: { ActiveState: 'active', NRestarts: '0' }, state, memory: { v: 1, lastScanAt: NOW - HOUR, seen: {}, configCheckedAt: NOW }, news });
  const sloss = r.incidents.find((f) => f.fp === 'issue:I1');
  const other = r.incidents.find((f) => f.fp === 'issue:I2');
  ok(sloss?.unopenable === true, 'the #issue quoting the warning is unopenable');
  ok(/plan=copy/.test(sloss?.remedy ?? '') && /plan=remux/.test(sloss?.remedy ?? '') && /"op":"repost"/.test(sloss?.remedy ?? ''),
    'its remedy names the cause, the cure and the re-post');
  ok(/research it as fully as the member described it/i.test(sloss?.remedy ?? ''), 'and still asks for the research every #issue gets');
  ok(other && !other.unopenable && !/repost/.test(other.remedy), 'another #issue is not');
}

console.log('=== the bot re-posts a send, and only when asked to ===');
{
  const sent = { id: 'S1', status: 'sent', at: NOW - 19 * HOUR, request: 'Daniel sloss live shows s01e01', title: 'Daniel Sloss: Live Shows', season: 1, episodes: [1] };
  const refused = rerunRefusal({ plugin: 'tv', row: sent, now: NOW });
  ok(/not re-run from here/.test(refused ?? '') && /"repost": true/.test(refused ?? ''), `a send is not re-run, and the refusal says how it is re-posted: ${refused}`);
  ok(rerunRefusal({ plugin: 'tv', row: sent, now: NOW, repost: true }) === null, 'with repost, it is re-posted');
  ok(rerunRefusal({ plugin: 'movie', row: { ...sent, status: 'partial' }, now: NOW, repost: true }) === null, 'a partial send too');
  ok(/was sent/.test(rerunRefusal({ plugin: 'movie', row: { ...sent, status: 'failed' }, now: NOW, repost: true }) ?? ''), 'a failure is re-run, not re-posted');
  ok(/already re-run once/.test(rerunRefusal({ plugin: 'tv', row: sent, now: NOW, repost: true, ledger: { 'tv:S1': { at: NOW - HOUR } } }) ?? ''), 'and only once');
  ok(/more than a week old/.test(rerunRefusal({ plugin: 'tv', row: { ...sent, at: NOW - 8 * 24 * HOUR }, now: NOW, repost: true }) ?? ''), 'not a week-old send');
  const again = { ...sent, id: 'S2', at: sent.at + HOUR };
  ok(rerunRefusal({ plugin: 'tv', row: sent, history: [sent, again], now: NOW, repost: true }) === null, 'a later send of the same, unopenable too, does not bar it');
  ok(/asked for again since/.test(rerunRefusal({ plugin: 'tv', row: sent, history: [sent, { ...again, status: 'queued' }], now: NOW, repost: true }) ?? ''),
    'one still on its way does');
  ok(/still in the queue/.test(rerunRefusal({ plugin: 'tv', row: sent, now: NOW, repost: true, journal: [{ msgId: 'S1' }] }) ?? ''), 'nor while it is queued');
}

console.log('=== the check allows re-posts only in a run that quotes the warning ===');
{
  const asked = [];
  const ask = async (_dir, cmd) => { asked.push(cmd); return { op: 'requeue', ok: true, queued: 'x', repost: true }; };
  const s = { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'repost-')) };
  const none = { rerunnable: new Set(), requeued: 0, unopenable: 0, reposted: 0, runId: 'r1' };
  const a = await botRequest(s, { op: 'repost', plugin: 'tv', id: 'S1' }, none, { ask });
  ok(a.ok === false && /unusual format/.test(a.error) && asked.length === 0, `refused without such a finding: ${a.error}`);
  const one = { rerunnable: new Set(), requeued: 0, unopenable: 1, reposted: 0, runId: 'r2' };
  const b = await botRequest(s, { op: 'repost', plugin: 'tv', id: 'S1' }, one, { ask });
  ok(b.ok === true && asked[0]?.op === 'requeue' && asked[0].repost === true && asked[0].id === 'S1' && /hourly check r2/.test(asked[0].by),
    'with one, the bot is asked for a requeue with repost');
  const c = await botRequest(s, { op: 'repost', plugin: 'tv', id: 'S9' }, one, { ask });
  ok(c.ok === false && asked.length === 1, `one re-post per such finding: ${c.error}`);
  const many = { rerunnable: new Set(), requeued: 0, unopenable: 5, reposted: 2, runId: 'r3' };
  ok((await botRequest(s, { op: 'repost', plugin: 'movie', id: 'M1' }, many, { ask })).ok === false, 'two at most a run');
  ok((await botRequest(s, { op: 'repost', id: 'M1' }, one, { ask })).ok === false, 'it names the plugin');
  const prompt = fs.readFileSync(new URL('../deploy/hourly-debug/prompt.md', import.meta.url), 'utf8');
  ok(/`unopenable` true/.test(prompt) && /"op":"repost"/.test(prompt) && /plan=copy/.test(prompt), 'the session\'s instructions say what to do');
  fs.rmSync(s.dataDir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
