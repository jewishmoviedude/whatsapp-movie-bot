/* The hourly check tells a job waiting out a full disk from one it failed.
   Run: node test/hourly-scan-disk-retry.test.mjs

   Two pieces of work met here. The hourly check learned to read a full disk
   (2026-09-28, 20:34 and 21:01 UTC on bot-box: "Charlie and the Chocolate
   Factory" as "ffmpeg exited 228", "The Parent Trap" as ENOSPC, "Minority
   Report" as an upload cut short) and to tell the owner to re-run the
   requests it failed from History once there was room. Meanwhile the
   pipelines stopped failing those jobs at all: a job the full disk hits now
   waits for room and tries again by itself, up to three times, and a film
   whose retries run out stays journalled for the next start. The queue still
   logs "job ... failed" for each attempt, so the check named them failed and
   said to re-run them - and a panel re-run is not checked for duplicates, so
   following that advice would have made and posted each film twice.

   Also here: an upload the full disk cut short is a full disk ("the disk
   filled while ..."), and in a member's repeat requests a film superseded
   after its retries ran out is a failure, and one found still waiting for
   room is "still in the queue", not "failed". */
import { scan, parseLog, DISK_FULL } from '../src/core/incident-scan.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const MIN = 60_000, HOUR = 60 * MIN, GB = 1024 ** 3;
const NOW = Date.parse('2026-09-28T22:00:00Z');
const at = (hhmm) => Date.parse(`2026-09-28T${hhmm}:00Z`);
const iso = (ts) => new Date(ts).toISOString();
const L = (ts, level, scope, msg) => `${iso(ts)} [${level.toUpperCase().padEnd(5)}] (${scope}) ${msg}`;
const log = (...lines) => parseLog(lines.join('\n'));

const MOVIE_REQ = '120363100000000001@g.us';
const TV_REQ = '120363100000000002@g.us';
const config = () => ({
  movieRequests: { requestGroups: [MOVIE_REQ], postsGroup: '120363100000000003@g.us', notify: { group: '' }, replyOnBlock: false },
  tvRequests: { enabled: true, requestGroups: [TV_REQ], postsGroups: ['120363100000000004@g.us'] },
  media: { workDir: '/home/bot/whatsapp-bot/data/media' },
});
const UNIT = { ActiveState: 'active', NRestarts: '0' };
const disk = { workDir: '/home/bot/whatsapp-bot/data/media', free: 16.4 * GB, size: 28.4 * GB, tmpDir: '/tmp', tmpFree: 16.4 * GB, sameFs: true, uploadCopies: [] };
const stateWith = ({ movie = [], tv = [], moviePending = [], tvPending = [] } = {}) => ({
  'movie-requests': { history: [...movie].reverse(), pending: moviePending },
  'tv-requests': { history: [...tv].reverse(), pending: tvPending, 'library-misses': [] },
  'msg-index': { entries: [] },
  audit: { events: [] },
});
const memory = { v: 1, lastScanAt: at('20:00'), seen: {}, configCheckedAt: at('20:00') };
const run = (o) => scan({ now: NOW, config: config(), unit: UNIT, memory, disk, ...o });
const all = (r) => [...r.incidents, ...r.notices];
const member = (name, n) => ({ requester: name, requesterJid: `9${String(n).padStart(14, '0')}@lid` });
let seq = 0;
const movieRow = (who, o) => ({ id: `3A${String(++seq).padStart(18, '0')}`, groupJid: MOVIE_REQ, ...who, ...o, requestedAt: o.requestedAt ?? o.at });
const DIANE = member('Diane', 3);
const BEN = member('Ben', 2);

const START = L(at('19:48'), 'info', 'main', 'debug log -> /home/bot/whatsapp-bot/data/logs');

console.log('=== the disk fills, and the pipelines wait it out ===');
{
  // The same evening as the pipelines log it now: Charlie and Loki's episode
  // wait for room; The Parent Trap has spent its three retries and waits for
  // the next start; Glass Onion fails for good.
  const lines = log(
    START,
    L(at('20:34') + 47_088, 'error', 'main', 'uncaught exception: ENOSPC: no space left on device, write'),
    L(at('20:34') + 47_500, 'warn', 'movie-requests', '"Charlie and the Chocolate Factory" failed transiently (ffmpeg exited 228 (no space left on device): drop_frames=0 | speed=2.78x | progress=end) - retrying once WhatsApp is connected and there is room on the disk (attempt 1 of 3)'),
    L(at('20:34') + 48_093, 'error', 'queue', 'job Charlie and the Chocolate Factory (2005) failed: ffmpeg exited 228 (no space left on device): drop_frames=0 | speed=2.78x | progress=end'),
    L(at('20:40'), 'warn', 'tv-requests', 'TV: Loki S01E03 failed transiently (ENOSPC: no space left on device, write) - retrying once WhatsApp is connected and there is room on the disk (attempt 2 of 3)'),
    L(at('20:40') + 300, 'error', 'queue', 'job Loki S01E03 failed: ENOSPC: no space left on device, write'),
    L(at('21:01') + 8215, 'warn', 'movie-requests', '"The Parent Trap" failed transiently (ENOSPC: no space left on device, write) - retried 3 times in this process; will retry on next start'),
    L(at('21:01') + 8496, 'error', 'queue', 'job The Parent Trap (1998) failed: ENOSPC: no space left on device, write'),
    L(at('21:02'), 'error', 'movie-requests', 'delivery failed for Glass Onion: not enough disk space for Glass Onion: it needs 9.5 GB (source 5.1 GB) and 3.0 GB is free with nothing else running'),
    L(at('21:02') + 200, 'error', 'queue', 'job Glass Onion (2022) failed: not enough disk space for Glass Onion: it needs 9.5 GB (source 5.1 GB) and 3.0 GB is free with nothing else running'),
  );
  const r = run({ lines, state: stateWith() });
  const full = all(r).filter((f) => f.kind === 'disk');
  ok(full.length === 1 && full[0].severity === 'error' && !full[0].restartHelps, 'the episode is still one finding, and asks for no restart');
  const t = full[0]?.title ?? '';
  ok(/1 job failed: Glass Onion \(2022\)/.test(t), `the job refused for good is named failed: "${t}"`);
  ok(/2 jobs waiting for room to try again: Charlie and the Chocolate Factory \(2005\), Loki S01E03/.test(t),
    'the film and the episode that wait for room are named as waiting, not failed');
  ok(/1 job waiting for the next start: The Parent Trap \(1998\)/.test(t), 'the film whose retries ran out waits for the next start');
  ok(!/failed: [^;]*(Charlie|Loki|Parent Trap)/.test(t), 'none of the three is in the failed list');
  const rem = full[0]?.remedy ?? '';
  ok(/Charlie and the Chocolate Factory \(2005\), Loki S01E03 wait for room and try again by themselves/.test(rem)
    && /from History as well would make and post them twice/.test(rem), `the remedy says not to re-run what is coming back: "${rem}"`);
  ok(/The Parent Trap \(1998\) is still journalled, and the next start takes it back/.test(rem), 'and what the next start takes back');
  ok(/can be re-run from History once there is room/.test(rem), 'the one that failed can still be re-run');

  // Everything is coming back: no word of re-running anything.
  const quiet = log(
    START,
    L(at('20:34') + 47_500, 'warn', 'movie-requests', '"Charlie and the Chocolate Factory" failed transiently (ffmpeg exited 228 (no space left on device): x) - retrying once WhatsApp is connected and there is room on the disk (attempt 1 of 3)'),
    L(at('20:34') + 48_093, 'error', 'queue', 'job Charlie and the Chocolate Factory (2005) failed: ffmpeg exited 228 (no space left on device): x'),
  );
  const q = all(run({ lines: quiet, state: stateWith() })).find((f) => f.kind === 'disk');
  ok(q && !/failed:/.test(q.title) && /1 job waiting for room to try again: Charlie/.test(q.title), `with every job coming back, nothing is called failed: "${q?.title}"`);
  ok(!/re-run from History once there is room/.test(q?.remedy ?? '') && /would make and post it twice/.test(q?.remedy ?? ''),
    'and the remedy does not invite a re-run');

  // A retry that later failed for good in the same episode is failed.
  const later = log(
    START,
    L(at('20:34'), 'warn', 'tv-requests', 'TV: Loki S01E03 failed transiently (ENOSPC: no space left on device, write) - retrying once WhatsApp is connected and there is room on the disk (attempt 3 of 3)'),
    L(at('20:34') + 100, 'error', 'queue', 'job Loki S01E03 failed: ENOSPC: no space left on device, write'),
    L(at('20:50'), 'error', 'tv-requests', 'TV delivery failed for Loki S01E03: ENOSPC: no space left on device, write'),
    L(at('20:50') + 100, 'error', 'queue', 'job Loki S01E03 failed: ENOSPC: no space left on device, write'),
  );
  const lf = all(run({ lines: later, state: stateWith() })).find((f) => f.kind === 'disk');
  ok(/1 job failed: Loki S01E03/.test(lf?.title ?? '') && !/waiting/.test(lf?.title ?? ''), `its last word decides: "${lf?.title}"`);
}

console.log('=== an upload the full disk cut short is a full disk ===');
{
  const cut = 'the disk filled while Minority Report (2002).mp4 was uploading, cutting its upload copy short (Media upload failed on all hosts)';
  ok(DISK_FULL.test(cut) && DISK_FULL.test('the disk filled while Heat.mp4 was uploading - its upload copy was cut short (x)'),
    'bot.js uploadCutShort\'s error and warning both read as a full disk');
  ok(DISK_FULL.test('not enough disk space for Glass Onion: it needs 9.5 GB') && !DISK_FULL.test('💾 waiting for disk space for Heat: it needs 9.5 GB'),
    'the refusal of a job that cannot fit does; the wait before a job starts does not (nothing failed)');
  const rows = [movieRow(BEN, { at: at('20:30'), request: 'minority report', status: 'failed', title: 'Minority Report', year: 2002, detail: cut })];
  const r = run({ lines: log(START), state: stateWith({ movie: rows }) });
  const f = r.incidents.find((x) => x.request?.title === 'Minority Report');
  ok(/the disk was full/.test(f?.title ?? '') && f?.cause === 'disk-full' && /then re-run it from History/.test(f.remedy) && f.rerunnable,
    `a film failed for good by it is named a full-disk failure, re-runnable: "${f?.title}"`);
}

console.log('=== a film whose retries on a full disk ran out waits for the next start ===');
{
  const detail = 'ENOSPC: no space left on device, write — retried 3 times; will retry on the next start';
  const row = movieRow(BEN, { at: at('20:59'), request: 'the parent trap 1998', status: 'interrupted', title: 'The Parent Trap', year: 1998, detail });
  const lines = log(
    START,
    L(at('21:01'), 'warn', 'movie-requests', '"The Parent Trap" failed transiently (ENOSPC: no space left on device, write) - retried 3 times in this process; will retry on next start'),
  );
  const r = run({ lines, state: stateWith({ movie: [row], moviePending: [{ jobKey: `${row.id}:tt0120783`, msgId: row.id }] }) });
  const f = r.incidents.find((x) => x.request?.title === 'The Parent Trap');
  ok(/waiting for a restart - the disk was full/.test(f?.title ?? ''), `named as waiting for a restart, on a full disk: "${f?.title}"`);
  ok(/still journalled, so the next start takes it back/.test(f?.remedy ?? '') && !/then re-run it from History/.test(f?.remedy ?? '') && !f?.rerunnable,
    `the remedy does not send the owner to History, where a re-run would post it twice: "${f?.remedy}"`);

  // Out of the journal, nothing brings it back: then a re-run is the way.
  const gone = run({ lines, state: stateWith({ movie: [row], moviePending: [] }) }).incidents.find((x) => x.request?.title === 'The Parent Trap');
  ok(/then re-run it from History/.test(gone?.remedy ?? ''), 'once it is no longer journalled, re-running it is the remedy');

  // A season that went out in part is asked for again by episode.
  const tv = { id: 'ACPARTIAL0001', kind: 'tv', groupJid: TV_REQ, title: 'Loki', season: 1, request: 'loki season 1', ...BEN,
    at: at('20:45'), requestedAt: at('20:10'), status: 'partial', episodes: 6, detail: '5 of 6 posted · E03: ENOSPC: no space left on device, write' };
  const p = run({ lines: log(START), state: stateWith({ tv: [tv] }) }).incidents.find((x) => x.request?.title === 'Loki');
  ok(/the disk was full/.test(p?.title ?? '') && /ask for the missing episodes again/.test(p?.remedy ?? '') && !/then re-run it from History/.test(p?.remedy ?? ''),
    `a season posted in part is not re-run whole: "${p?.remedy}"`);
}

console.log('=== a member asking again around a disk wait ===');
{
  // Asked again while the first waits for room: the pipeline answers
  // "duplicate" and queues nothing. The first is not a failure.
  const waiting = [
    movieRow(DIANE, { at: at('20:23'), request: 'charlie and the chocolate factory', status: 'interrupted', title: 'Charlie and the Chocolate Factory', year: 2005,
      detail: 'waiting for disk space — ffmpeg exited 228 (no space left on device): x (attempt 1 of 3)' }),
    movieRow(DIANE, { at: at('20:50'), request: 'charlie and the chocolate factory 2005', status: 'duplicate', title: 'Charlie and the Chocolate Factory', year: 2005,
      detail: 'already in the queue — waiting from an earlier request' }),
  ];
  const w = all(run({ lines: log(START), state: stateWith({ movie: waiting }) })).find((f) => f.kind === 'repeat-request');
  ok(/still in the queue, and was not queued a second time/.test(w?.remedy ?? '') && !/failed/.test(w?.remedy ?? ''),
    `found still in the queue, not "after the earlier request failed": "${w?.remedy}"`);

  // Asked again after the retries ran out: the new request takes the film
  // over, the old row becomes "duplicate" - and the story is a failure the
  // member got round by asking again, which is worth a line, not research.
  const superseded = [
    movieRow(DIANE, { at: at('18:00'), request: 'the parent trap', status: 'duplicate', title: 'The Parent Trap', year: 1998,
      detail: 'asked for again after its retries ran out — the newer request takes it' }),
    movieRow(DIANE, { at: at('20:40'), request: 'the parent trap 1998', status: 'sent', title: 'The Parent Trap', year: 1998, finishedAt: at('21:30') }),
  ];
  const r = run({ lines: log(START), state: stateWith({ movie: superseded }) });
  const s = all(r).find((f) => f.kind === 'repeat-request');
  ok(/after the earlier request failed/.test(s?.remedy ?? ''), `the superseded request counts as the failure it was: "${s?.remedy}"`);
  ok(r.notices.includes(s) && !r.incidents.some((f) => f.kind === 'repeat-request'), 'and, posted in the end, it is listed, not researched');
}

console.log('=== a failed film sent since is not offered for a re-run ===');
{
  // The dry run on bot-box's data, 2026-09-28: Minority Report failed on the
  // full disk, then was sent to the same member twice; Charlie failed, then
  // was sent to another member. Both findings were marked re-runnable, with
  // "re-run it from History" - and the panel's Re-run has no duplicate
  // check, so following that would have posted each a second (or third) time.
  const MIA = member('Mia', 4);
  const rows = [
    movieRow(DIANE, { at: at('20:23'), request: 'charlie and the chocolate factory', status: 'failed', title: 'Charlie and the Chocolate Factory', year: 2005,
      detail: 'ffmpeg exited 228: drop_frames=0 | speed=2.78x | progress=end' }),
    movieRow(MIA, { at: at('21:10'), request: 'charlie and the chocolate factory 2005', status: 'sent', title: 'Charlie and the Chocolate Factory', year: 2005, finishedAt: at('21:55') }),
    movieRow(BEN, { at: at('20:40'), request: 'heat 1995', status: 'failed', title: 'Heat', year: 1995, detail: 'forbidden: not allowed to post' }),
  ];
  const r = run({ lines: log(START), state: stateWith({ movie: rows }) });
  const charlie = all(r).find((f) => f.kind === 'request-failed' && /Charlie/.test(f.title));
  ok(charlie && charlie.rerunnable === false, `Charlie, sent since to another member, is not re-runnable (${charlie?.rerunnable})`);
  ok(/it was sent since, to Mia \(request 3A\d+\): nothing to re-run/.test(charlie?.remedy ?? '') && !/re-run it from History/.test(charlie?.remedy ?? ''),
    `and the remedy says so: "${charlie?.remedy}"`);
  const heat = all(r).find((f) => f.kind === 'request-failed' && /Heat/.test(f.title));
  ok(heat?.rerunnable === true, 'a failed film nobody has been sent since still is');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
