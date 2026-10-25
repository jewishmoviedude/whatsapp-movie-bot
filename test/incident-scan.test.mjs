/* The hourly check's scanner: what counts as failed or unanswered, and that
   each finding is handled once. Run: node test/incident-scan.test.mjs

   The operator asked for a debug pass every hour on the hour over "any
   request that failed or ... got unfulfilled due to some sort of error". The
   scanner decides what that is, from what the bot already writes down, and
   an all-clear hour must cost nothing - no model run, and above all no
   restart, which throws away every encode in progress.

   The shapes here are the live box's (bot-box, 2026-09-28): movie history rows
   "failed" with "ENOSPC" and "This operation was aborted", a TV row "partial"
   with "28 of 29 posted after a restart, 1 failed", 24 "unhandled rejection"
   lines from inside Baileys, 24 TV requests silently ignored inside the
   30-second cooldown. The first read of that day also flagged 104 group
   messages as unanswered, nearly all of them chatter the "#request" prefix
   rule ignores by design; the message index now records each message's type
   and command word so those are told apart (message-index.js). */
import {
  scan, parseLog, errorSignature, headline, restartAdvice, looksLikeRequest, processFromLog, quoteLine, DEFAULTS,
} from '../src/core/incident-scan.js';
import { messageShape, MessageIndex } from '../src/core/message-index.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const NOW = Date.parse('2026-09-28T18:00:00Z');
const MIN = 60_000, HOUR = 60 * MIN;
const MOVIE_REQ = '120363900000000001@g.us';
const TV_REQ = '120363900000000003@g.us';
const BETA = '120363900000000013@g.us';
const NOTIFY = '120363900000000015@g.us';
// A notifications group is set: without one, the once-a-day settings check
// notes it, and these cases are about other things.
const CONFIG = {
  movieRequests: { requestGroups: [MOVIE_REQ], requirePrefix: true, prefix: '#request', notify: { group: NOTIFY } },
  tvRequests: { enabled: true, requestGroups: [TV_REQ], requirePrefix: true, prefix: '#request' },
  beta: { groups: [BETA] },
};
const NAMES = { [MOVIE_REQ]: 'MOVIE REQUESTS ONLY!', [TV_REQ]: 'TV REQUESTS ONLY!' };

const iso = (ts) => new Date(ts).toISOString();
const L = (ts, level, scope, msg) => `${iso(ts)} [${level.toUpperCase().padEnd(5)}] (${scope}) ${msg}`;
const log = (...lines) => parseLog(lines.join('\n'));
const movieRow = (o) => ({ id: `M${Math.random().toString(16).slice(2, 10)}`, at: NOW - HOUR, requester: 'Mia', requesterJid: '100000000000916@lid', requesterNumber: '12125550186', groupJid: MOVIE_REQ, ...o });
const tvRow = (o) => ({ kind: 'tv', ...movieRow(o) });
const stateWith = ({ movie = [], tv = [], misses = [], index = [], moviePending = [], tvPending = [] } = {}) => ({
  'movie-requests': { history: movie, pending: moviePending },
  'tv-requests': { history: tv, pending: tvPending, 'library-misses': misses },
  'msg-index': { entries: index },
});
const run = (o = {}) => scan({ now: NOW, config: CONFIG, names: NAMES, unit: { ActiveState: 'active', NRestarts: '0' }, ...o });
const kinds = (r) => r.incidents.map((f) => f.kind);

console.log('=== reading the log ===');
{
  const lines = log(
    L(NOW - 5 * MIN, 'info', 'main', 'debug log -> /home/x/data/logs'),
    L(NOW - 4 * MIN, 'error', 'main', 'unhandled rejection: boom | {"stack":"TypeError: boom\\n at x"}'),
    L(NOW - 3 * MIN, 'warn', 'gemini', 'title lookup failed: Gemini HTTP 503: {'),
    '  "error": "overloaded"',
    '}',
  );
  ok(lines.length === 3, 'three entries; the lines without a timestamp belong to the one before');
  ok(lines[1].msg === 'unhandled rejection: boom' && lines[1].extra.startsWith('{"stack"'), 'the stack after " | " is kept apart from the message');
  ok(lines[2].msg.includes('"error": "overloaded"'), 'a quoted body stays with its line');
  ok(lines[0].level === 'info' && lines[0].scope === 'main' && lines[0].ts === NOW - 5 * MIN, 'level, scope and time parsed');
  ok(errorSignature({ scope: 'movie-requests', msg: 'could not resume "Doctor Strange": Queue is full (104 waiting)' })
    === errorSignature({ scope: 'movie-requests', msg: 'could not resume "Ready Player One": Queue is full (98 waiting)' }),
  'two occurrences of one error, with different titles and counts, have one signature');
  // Quoted as evidence, a line keeps the group it names, so the model can
  // look it up; the live dry run showed "12036+390000***0001@g.us".
  const q = quoteLine({ ts: NOW, level: 'info', scope: 'bot', msg: 'sending document x -> 120363900000000006@g.us for +1 (212) 555-0186' });
  ok(q.includes('120363900000000006@g.us') && !q.includes('555-0186'), `a quoted line keeps the group id and masks the number (${q})`);
}

console.log('=== an hour with nothing new is all clear ===');
{
  const r = run({ state: stateWith({ movie: [movieRow({ status: 'sent', detail: 'encode, 1.70 GB' })] }), memory: { v: 1, lastScanAt: NOW - HOUR, seen: {} } });
  ok(r.incidents.length === 0 && r.notices.length === 0, 'a sent film is not a finding');
  ok(!r.restart.advised, 'and no restart is advised - it would cost every encode in progress');
  ok(headline(r.incidents) === 'all clear', 'headline: "all clear"');
  const empty = scan({ now: NOW });
  ok(empty.incidents.length === 0 && empty.firstRun, 'no data at all is all clear, not a crash');
}

console.log('=== failed requests ===');
{
  const failed = movieRow({ status: 'failed', title: 'Thor: Love and Thunder', year: 2022, request: 'Thor love and thunder', detail: 'ENOSPC: no space left on device, write' });
  const lost = movieRow({ status: 'lost', title: 'Annie', year: 1982, request: 'Annie 1982', detail: 'interrupted before it finished' });
  const interrupted = movieRow({ status: 'interrupted', title: 'Newsies', year: 1992, request: 'newsies 1992', detail: 'Connection Closed' });
  const metadata = movieRow({ status: 'error', request: 'barefoot 2014', detail: 'metadata lookup failed: fetch failed' });
  const noPosts = movieRow({ status: 'error', request: 'dune', detail: 'posts group not set' });
  const beta = movieRow({ status: 'failed', title: 'Dune', year: 2021, request: 'dune 2021', detail: 'x', beta: true, groupJid: BETA });
  const partial = tvRow({ status: 'partial', title: 'One Piece', year: 1999, season: 12, request: 'one piece season 12 dub', detail: '28 of 29 posted after a restart, 1 failed' });
  const tvFailed = tvRow({ status: 'failed', title: 'Gravity Falls', request: 'gravity falls s1', detail: '0 of 20 posted, 20 failed' });
  const lines = log(L(NOW - 50 * MIN, 'error', 'movie-requests', 'delivery failed for Thor: Love and Thunder: ENOSPC: no space left on device, write'));
  // Journalled, as the plugin leaves a film that failed transiently.
  const moviePending = [{ jobKey: `${interrupted.id}:tt0104990`, msgId: interrupted.id }];
  const r = run({ state: stateWith({ movie: [failed, lost, interrupted, metadata, noPosts, beta], tv: [partial, tvFailed], moviePending }), lines });
  const by = (id) => r.incidents.find((f) => f.request?.id === id);
  ok(by(failed.id)?.kind === 'request-failed' && by(failed.id).severity === 'error', 'a failed film is an error-level finding');
  ok(by(failed.id).evidence.some((e) => e.includes('ENOSPC')), 'with the log line that says why, as evidence');
  ok(by(failed.id).rerunnable, 'and it may be re-run once fixed');
  ok(by(lost.id)?.kind === 'request-failed' && by(lost.id).rerunnable, 'a request lost to a restart is a failure');
  ok(by(interrupted.id)?.restartHelps && !by(interrupted.id).rerunnable, 'an interrupted one waits for a restart, which is what cures it - not a re-run');
  ok(by(metadata.id)?.kind === 'request-failed', 'an OMDb outage is a failure');
  ok(by(noPosts.id) && !by(noPosts.id).rerunnable, 'no posts group is reported, and not re-run until the setting is fixed');
  // Since the operator's test mode (2026-09-29) a beta row is a test, or a
  // beta job an older bot journalled that is no longer resumed: neither
  // serves a member, and neither is researched (test/beta-test-mode.test.mjs).
  ok(!by(beta.id), 'a failed beta row is not a finding: a beta request serves nobody now');
  ok(by(partial.id) && !by(partial.id).rerunnable, 'a partly posted season is reported, and not re-run - that would post the rest again');
  ok(by(tvFailed.id)?.rerunnable, 'a TV request that posted nothing may be re-run');
  ok(!JSON.stringify(r.incidents).includes('12125550186'), 'the requester\'s phone number is nowhere in the findings');
  ok(r.restart.advised && r.restart.reasons.some((x) => /retry on the next start/.test(x)), 'a restart is advised, for the interrupted request');

  // A partly posted season's evidence is its episodes' lines, not every
  // other request for the same show that day (the first live read quoted
  // "one piece season amazon lily" lookups under a season 12 failure).
  const tvLines = log(
    L(NOW - 58 * MIN, 'info', 'tv-requests', '✅ TV COMPLETE One Piece S08E01 S08E01.mp4 — 227.80 MB to 1 group(s) in 1m 51s'),
    L(NOW - 55 * MIN, 'error', 'tv-requests', 'TV delivery failed for One Piece S12E32: could not post to any group: Connection Closed'),
    L(NOW - 50 * MIN, 'warn', 'tv-requests', 'TV lookup: no series matched "one piece season amazon lily" in 8610 series'),
  );
  const tv = run({ state: stateWith({ tv: [partial] }), lines: tvLines });
  const ev = tv.incidents.find((f) => f.request?.id === partial.id)?.evidence ?? [];
  ok(ev.length === 1 && /S12E32: could not post/.test(ev[0]), `a TV failure's evidence is its own season's episodes, not another season's (${ev.length} line(s))`);
}

console.log('=== unfulfilled: one finding per title, again at most once a day ===');
{
  const a = movieRow({ status: 'not-in-library', title: 'The Fantastic Four: First Steps', year: 2025, request: 'The fantastic four first steps', at: NOW - 2 * HOUR });
  const b = movieRow({ status: 'not-in-library', title: 'The Fantastic Four: First Steps', year: 2025, request: 'the fantastic 4: first steps 2025', at: NOW - HOUR });
  const needYear = movieRow({ status: 'need-year', title: 'Tangled', request: 'tangled', detail: '2 copies: 2010, 2022' });
  const r1 = run({ state: stateWith({ movie: [a, b, needYear] }) });
  const ff = r1.incidents.filter((f) => f.request?.title === 'The Fantastic Four: First Steps');
  ok(ff.length === 1 && ff[0].occurrences === 2, 'two people asking for the same missing film is one finding, counted twice');
  ok(ff[0].severity === 'unfulfilled', 'at the "unfulfilled" level');
  ok(r1.notices.some((f) => f.request?.title === 'Tangled') && !r1.incidents.some((f) => f.request?.title === 'Tangled'),
    'a "which year?" nobody answered is noted, not researched: the bot did its job');
  const r2 = run({ state: stateWith({ movie: [a, b, movieRow({ status: 'not-in-library', title: 'The Fantastic Four: First Steps', year: 2025, request: 'ff', at: NOW - 10 * MIN })] }), memory: r1.memory });
  ok(!r2.incidents.some((f) => f.request?.title === 'The Fantastic Four: First Steps'), 'asked again an hour later: not reported again the same day');
  const later = NOW + 25 * HOUR;
  const r3 = scan({ now: later, config: CONFIG, memory: r1.memory, state: stateWith({ movie: [movieRow({ status: 'not-in-library', title: 'The Fantastic Four: First Steps', year: 2025, request: 'ff', at: later - 10 * MIN })] }) });
  ok(r3.incidents.some((f) => f.request?.title === 'The Fantastic Four: First Steps'), 'asked again the next day: reported again, since it is still happening');
}

console.log('=== TV misses, which leave no history row ===');
{
  const miss = {
    key: 'tv|american dad!|2005|5|', kind: 'tv', reason: 'empty-season', detail: '"American Dad!" has no season 5',
    request: 'American dad season 5', title: 'American Dad!', year: 2005, season: 5, groupJid: TV_REQ,
    searched: ['American dad', 'American dad season 5'], diagnostics: ['no series matched "x" in 8610 series'],
    count: 4, firstAt: NOW - 5 * HOUR, lastAt: NOW - 30 * MIN, requesters: ['Mommy Lee'], resolved: false,
  };
  const r = run({ state: stateWith({ misses: [miss, { ...miss, key: 'tv|x|||', resolved: true }] }) });
  const f = r.incidents.find((x) => x.fp === `miss:${miss.key}`);
  ok(f?.kind === 'request-unfulfilled' && f.request.timesAsked === 4, 'reported, with how many times it was asked');
  ok(f.evidence.some((e) => e.startsWith('searched:')) && f.evidence.some((e) => e.startsWith('lookup:')), 'with what the lookup searched and saw');
  ok(!r.incidents.some((x) => x.fp === 'miss:tv|x|||'), 'a miss that turned up later is not reported');
}

console.log('=== a full queue is one finding with a list ===');
{
  const lines = log(
    L(NOW - 40 * MIN, 'warn', 'tv-requests', '📺 queue full - refused Suits season 2'),
    L(NOW - 30 * MIN, 'warn', 'tv-requests', '📺 queue full - took 20 of 62 episode(s) of One Piece'),
  );
  const movie = movieRow({ status: 'error', title: 'Oblivion', year: 2013, request: 'oblivion 2013', detail: 'queue full' });
  const r1 = run({ state: stateWith({ movie: [movie] }), lines });
  const q = r1.incidents.filter((f) => f.kind === 'queue-full');
  ok(q.length === 1 && q[0].items.length === 3, 'three refusals, one finding listing them');
  ok(q[0].items.find((i) => i.request?.id === movie.id)?.rerunnable, 'the refused film can be re-run once there is room');
  const more = log(L(NOW + 30 * MIN, 'warn', 'tv-requests', '📺 queue full - refused Loki season 1'));
  const r2 = scan({ now: NOW + HOUR, config: CONFIG, memory: r1.memory, lines: more });
  ok(r2.incidents.every((f) => f.kind !== 'queue-full') && r2.notices.some((f) => f.kind === 'queue-full'),
    'another refusal an hour later is noted, not a new model run: capacity is not a bug');
}

console.log('=== requests nothing answered ===');
{
  const shape = (text, type = 'conversation') => messageShape({ messageType: type, text });
  const at = NOW - 40 * MIN;
  const e = (i, o) => ({ k: 'num:15558180174', g: MOVIE_REQ, i, p: '100000000000004@lid', t: at, ...o });
  const index = [
    e('UNANSWERED', shape('#request Inception 2010')),
    e('CHATTER', shape('thanks so much!!')),
    e('THUMBS', shape('', 'reactionMessage')),
    e('PHOTO', shape('', 'imageMessage')),
    e('REACTED', shape('#request Dune')),
    e('INHISTORY', shape('#request Heat')),
    e('DELETED', { ...shape('#request a b c'), k: 'num:15558140175', p: '1@lid' }),
    // The same line since 2026-10-01 names the sender as +<digits>.
    e('DELETED-PLUS', { ...shape('#request d e f'), k: 'num:15558140176', p: '4@lid' }),
    e('COOLED', { ...shape('#request loki season 2'), g: TV_REQ, k: 'lid:2@lid', p: '2@lid' }),
    e('TOO-NEW', { ...shape('#request Up'), t: NOW - 2 * MIN }),
    e('ELSEWHERE', { ...shape('#request Up'), g: 'other@g.us' }),
    e('OLDSHAPE', {}),
  ];
  const lines = log(
    L(at + 2000, 'debug', 'bot', 'reacted 🔍 on REACTED'),
    L(at + 3000, 'info', 'movie-requests', `🧹 deleted a message in ${MOVIE_REQ} from 15558140175: multiple (one movie per message)`),
    L(at + 3500, 'info', 'movie-requests', `🧹 deleted a message in ${MOVIE_REQ} from +15558140176: multiple (one movie per message)`),
    L(at + 4000, 'info', 'tv-requests', 'ignoring 2@lid: cooling down'),
  );
  // A member cooling down on the MOVIE side does not explain a TV message:
  // the movie plugin never looks at the TV group.
  index.push(e('TV-BUT-MOVIE-COOLDOWN', { ...shape('#request loki season 3'), g: TV_REQ, k: 'lid:3@lid', p: '3@lid' }));
  lines.push(...log(L(at + 5000, 'info', 'movie-requests', 'ignoring 3@lid: cooling down (800s left)')));
  const r = run({ state: stateWith({ index, movie: [movieRow({ id: 'INHISTORY', status: 'sent' })] }), lines });
  const un = r.incidents.find((f) => f.fp === 'noreact:unanswered');
  ok(un?.items.length === 2 && un.items[0].request.id === 'UNANSWERED', 'a "#request" with no row, no reaction and no deletion is unanswered');
  ok(!un.items.some((x) => x.request.id === 'DELETED-PLUS'),
    'a message deleted by moderation is answered, whether the line names its sender as 15558140176 or +15558140176');
  ok(un.items[1].request.id === 'TV-BUT-MOVIE-COOLDOWN', 'and so is a TV request whose sender was only cooling down on the movie side');
  ok(un.severity === 'unfulfilled', 'which is worth researching');
  ok(un.items[0].request.text.startsWith('#request') && !un.items[0].request.text.includes('Inception'), 'the finding names the command word, never the text (the index keeps none)');
  const cool = r.incidents.find((f) => f.fp === 'noreact:cooldown');
  ok(cool?.items.length === 1 && /TV side ignores that without a reaction/.test(cool.items[0].request.detail),
    'a TV request inside the cooldown got nothing at all - the movie side at least reacts 🚫');
  const old = r.notices.find((f) => f.fp === 'noreact:unknown');
  ok(old?.items.length === 1, 'an entry from before the index recorded shapes is only noted: it may have been chatter');
  ok(!JSON.stringify(r).includes('CHATTER') && !JSON.stringify(r).includes('THUMBS') && !JSON.stringify(r).includes('PHOTO'),
    'chatter without the prefix, a reaction and a photo are not requests (104 of them were flagged on the first read of a live day)');
  ok(!JSON.stringify(r).includes('TOO-NEW'), 'a message younger than ten minutes is left for the next run - its reaction may still be on the way');
  ok(looksLikeRequest({ y: 'conversation', n: 12 }, null) === 'yes' && looksLikeRequest({ y: 'conversation', n: 1 }, null) === 'no'
    && looksLikeRequest({ y: 'conversation', n: 400 }, null) === 'no', 'with no prefix rule, text of 2 to 200 characters is a request, as the plugins judge it');
}

console.log('=== the message index records a shape, never the text ===');
{
  const s = messageShape({ messageType: 'conversation', text: '#request Inception 2010' });
  ok(s.y === 'conversation' && s.n === 23 && s.w === '#request', 'type, length and the command word');
  ok(!JSON.stringify(messageShape({ messageType: 'conversation', text: 'my address is 5 Main St' })).includes('Main'), 'ordinary text leaves nothing of itself behind');
  // A mention or a number up front starts with a sigil too, and it is a
  // member's phone number: the index promises to keep none of the text.
  for (const text of ['@19735551576 can you send me the link', '+19735551576 call me', '#19735551576', '(973) 555-1576 is mine']) {
    ok(!JSON.stringify(messageShape({ messageType: 'extendedTextMessage', text })).includes('555'), `no phone number from "${text.slice(0, 16)}…" is kept`);
  }
  ok(messageShape({ messageType: 'conversation', text: '!tv loki s1' }).w === '!tv', 'while a command word still is');
  const ix = new MessageIndex();
  ix.record({ isGroup: true, fromMe: false, senderNumber: '1', senderJid: '1@lid', id: 'X', chatJid: 'g@g.us', timestamp: NOW, messageType: 'conversation', text: '#Request Up' }, NOW);
  ok(ix.entries[0].w === '#request' && ix.entries[0].i === 'X', 'recorded by the index itself, lower-cased');
}

console.log('=== the process: stuck jobs, the connection, crashes, deploys ===');
{
  const started = NOW - 4 * HOUR;
  const lines = log(
    L(started - 60_000, 'info', 'main', 'debug log -> /data/logs'),
    L(started, 'info', 'queue', '▶ start One Piece S12E28 (1/3 active, 50 waiting)'),
    L(started + 1000, 'info', 'queue', '▶ start Newsies (1992) (2/3 active, 49 waiting)'),
    L(started + 60 * MIN, 'info', 'queue', '■ end   Newsies (1992) → done after 3599s (1 still active)'),
    L(started + 61 * MIN, 'info', 'bot', 'state -> connected'),
  );
  const r = run({ lines });
  const stuck = r.incidents.filter((f) => f.kind === 'stuck-job');
  ok(stuck.length === 1 && /One Piece S12E28/.test(stuck[0].title), 'a job started four hours ago and never ended is stuck; the one that ended is not');
  ok(r.restart.advised, 'and a restart is advised for it');
  const before = log(L(started - 3 * HOUR, 'info', 'queue', '▶ start Old Job (1/3 active, 0 waiting)'), ...lines.map((l) => L(l.ts, l.level, l.scope, l.msg)));
  ok(!run({ lines: before }).incidents.some((f) => /Old Job/.test(f.title)), 'a job from before the last restart is not "running" in this process');
  const live = run({ lines, health: { connection: { state: 'connected' }, queues: { media: { running: [{ label: 'One Piece S12E28', startedAt: started, progressAt: NOW - 2 * MIN, stage: 'convert' }] } } } });
  ok(!live.incidents.some((f) => f.kind === 'stuck-job'), 'when the bot says the job reported progress two minutes ago, it is a long job, not a stuck one');
  const idle = run({ lines, health: { connection: { state: 'connected' }, queues: { media: { running: [] } } } });
  ok(!idle.incidents.some((f) => f.kind === 'stuck-job'), 'and when the bot says nothing is running, a start line with no end line is not a stuck job');
  const frozen = run({ lines, health: { connection: { state: 'connected' }, queues: { media: { running: [{ label: 'One Piece S12E28', startedAt: started, progressAt: NOW - 50 * MIN, stage: 'upload' }] } } } });
  ok(frozen.incidents.some((f) => f.kind === 'stuck-job' && /no progress for 50 min \(stage: upload\)/.test(f.title)), 'fifty minutes without progress, by the bot\'s own account, is stuck');
  ok(processFromLog(lines).startedAt === started - 60_000, 'the process started at its "debug log ->" line (the banner before it never reaches the file)');

  const down = log(L(NOW - 2 * HOUR, 'info', 'main', 'debug log -> /d'), L(NOW - HOUR, 'warn', 'bot', 'connection closed (connectionClosed)'), L(NOW - HOUR, 'info', 'bot', 'state -> connecting'));
  const d = run({ lines: down });
  ok(d.incidents.some((f) => f.kind === 'bot-unhealthy' && /connecting for 60 min/.test(f.title)) && d.restart.advised, 'an hour without WhatsApp: a restart is advised');
  const out = log(L(NOW - 2 * HOUR, 'info', 'main', 'debug log -> /d'), L(NOW - HOUR, 'warn', 'bot', 'connection closed (loggedOut)'), L(NOW - HOUR, 'info', 'bot', 'state -> stopped'));
  const o = run({ lines: out });
  ok(!o.restart.advised && o.restart.blockedBy.some((b) => /re-linking/.test(b)), 'logged out: no restart - it is one more login attempt that cannot succeed');
  const rep = run({ lines: log(L(NOW - 2 * HOUR, 'info', 'main', 'debug log -> /d'), L(NOW - HOUR, 'warn', 'bot', 'connection closed (connectionReplaced)'), L(NOW - HOUR, 'info', 'bot', 'state -> connecting')) });
  ok(!rep.restart.advised, 'connectionReplaced: no restart - another process holds the session (rule 3)');

  const quiet = restartAdvice({ incidents: d.incidents, mem: { lastHealthRestartAt: NOW - HOUR }, now: NOW });
  ok(!quiet.advised && /not again within 3 hours/.test(quiet.blockedBy.join()), 'a health restart that did not cure it is not repeated every hour');

  const restarting = run({ unit: { ActiveState: 'activating', SubState: 'auto-restart', NRestarts: '0' } });
  ok(!restarting.incidents.some((f) => /not running/.test(f.title)), 'systemd in the middle of a restart is not "not running"');
  const stopped = run({ unit: { ActiveState: 'inactive', NRestarts: '0' } });
  ok(stopped.incidents.some((f) => /not running/.test(f.title)) && !stopped.restart.advised, 'a stopped service is reported and left stopped: somebody stopped it');
  const crashed = run({ unit: { ActiveState: 'active', NRestarts: '5' }, memory: { v: 1, lastScanAt: NOW - HOUR, seen: {}, lastNRestarts: 2 } });
  ok(crashed.incidents.some((f) => /restarted it 3 time/.test(f.title)), 'systemd restarting the bot by itself since the last check is a crash');
  ok(crashed.memory.lastNRestarts === 5, 'and the count is remembered, so the same crashes are not news next hour');

  const rolled = run({ autoUpdate: { result: 'rolled-back', reason: 'abc1234 was restarted 3 times', checkedAt: iso(NOW - 20 * MIN) } });
  ok(rolled.incidents.some((f) => f.kind === 'update-failed' && f.severity === 'error'), 'a commit the updater took back out is an error');
  const fetch = run({ autoUpdate: { result: 'failed', reason: 'could not fetch origin/main after 4 attempts: https://user:tok@github.com x', checkedAt: iso(NOW - 20 * MIN) } });
  const nf = fetch.notices.find((f) => f.kind === 'update-failed');
  ok(nf && !fetch.incidents.some((f) => f.kind === 'update-failed'), 'a fetch that failed at boot is only noted: the next start retries it');
  ok(!nf.evidence.join().includes('tok@'), 'and a token in the remote URL is not repeated');
}

console.log('=== errors in the log ===');
{
  const lines = log(
    ...Array.from({ length: 24 }, (_, i) => L(NOW - 50 * MIN + i * 1000, 'error', 'main', "unhandled rejection: Cannot read properties of null (reading 'remoteJid')")),
    L(NOW - 40 * MIN, 'error', 'queue', 'job Ready Player One (2018) failed: This operation was aborted'),
    L(NOW - 40 * MIN, 'error', 'movie-requests', 'delivery failed for Ready Player One: This operation was aborted'),
    L(NOW - 30 * MIN, 'error', 'mail', 'could not send mail: +1 (555) 813-0191 rejected'),
  );
  const r = run({ lines });
  const errs = r.incidents.filter((f) => f.kind === 'log-error');
  ok(errs.length === 2, 'two signatures: the rejection and the mail error');
  ok(errs.find((f) => /remoteJid/.test(f.title))?.count === 24, 'the 24 rejections are one finding with a count');
  ok(!errs.some((f) => /Ready Player One/.test(f.title)), 'a job failure is left to its history row, which says more');
  ok(!JSON.stringify(errs).includes('813-0191'), 'a phone number in an error line is masked');
  const r2 = scan({ now: NOW + HOUR, config: CONFIG, memory: r.memory, lines: log(L(NOW + 30 * MIN, 'error', 'main', "unhandled rejection: Cannot read properties of null (reading 'remoteJid')")) });
  ok(!r2.incidents.some((f) => f.kind === 'log-error'), 'the same error an hour later is not a new finding the same day');
}

console.log('=== a first run looks one day back; everything older is remembered, not reported ===');
{
  const old = movieRow({ status: 'failed', title: 'Annie', request: 'Annie 1982', at: NOW - 30 * HOUR });
  const fresh = movieRow({ status: 'failed', title: 'Thor', request: 'thor', at: NOW - 2 * HOUR });
  const r = run({ state: stateWith({ movie: [old, fresh] }) });
  ok(r.firstRun && r.since === NOW - DEFAULTS.firstRunLookbackMs, 'the first run starts a day back');
  ok(r.incidents.some((f) => f.request?.id === fresh.id) && !r.incidents.some((f) => f.request?.id === old.id), 'reports this morning, not last week');
  ok(r.memory.seen[`hist:movie:${old.id}:failed`], 'and remembers the old one as known');

  console.log('=== and after that, each finding is handled once ===');
  const r2 = scan({ now: NOW + HOUR, config: CONFIG, memory: r.memory, state: stateWith({ movie: [old, fresh] }) });
  ok(r2.incidents.length === 0 && !r2.firstRun, 'the next hour, the same two rows are not news');
  ok(r2.since === NOW - DEFAULTS.overlapMs, 'and it looks back to the last run, with a little overlap');
  const again = { ...old, status: 'interrupted' };
  const r3 = scan({ now: NOW + 2 * HOUR, config: CONFIG, memory: r2.memory, state: stateWith({ movie: [again, fresh] }) });
  ok(r3.incidents.some((f) => f.request?.id === old.id), 'but a row whose status changes - even an old one, resumed after a restart - is');
  const forgotten = scan({ now: NOW + 20 * 24 * HOUR, config: CONFIG, memory: r.memory, state: {} });
  ok(!Object.keys(forgotten.memory.seen).some((k) => k.includes(old.id)), 'remembered fingerprints are forgotten after two weeks');
}

console.log('=== the model is handed a bounded list ===');
{
  const rows = Array.from({ length: 50 }, (_, i) => movieRow({ id: `F${i}`, status: 'failed', title: `Film ${i}`, request: `film ${i}` }));
  const r = run({ state: stateWith({ movie: rows }) });
  ok(r.incidents.length === DEFAULTS.maxIncidents && r.overflow === 10, 'forty findings in detail, the rest counted');
  ok(r.incidents[0].ref === 'I1' && r.incidents[39].ref === 'I40', 'each with a reference the report uses');
  ok(Object.keys(r.memory.seen).filter((k) => k.startsWith('hist:')).length === 50, 'all fifty are remembered as handled, the counted ones too');
  ok(headline(r.incidents) === '40 failed requests', 'headline: "40 failed requests"');
  ok(headline([{ kind: 'no-reaction' }, { kind: 'log-error' }, { kind: 'log-error' }]) === '2 errors in the log, 1 unanswered request', 'and singular where it is one');
}

console.log('=== a job waiting in line for a stage slot is not stuck ===');
{
  // 2026-09-24: Inception waited 53 minutes between its download and its
  // encode behind two others, Guardians of the Galaxy 50, The Incredible Hulk
  // 45 - and all three were posted. A job in line reports progress once, when
  // it joins, and nothing until the slot frees; counting that as "stuck"
  // restarted the bot and threw away the encode the film was waiting for.
  const started = NOW - 2 * HOUR;
  const lines = log(L(started - MIN, 'info', 'main', 'debug log -> /d'), L(started, 'info', 'bot', 'state -> connected'));
  const health = (running) => ({ startedAt: started - MIN, connection: { state: 'connected', lastError: null }, queues: { media: { running } } });
  const encoding = { label: 'Minority Report (2002)', startedAt: started, progressAt: NOW - 20_000, stage: 'convert' };
  const inLine = { label: 'Inception (2010)', startedAt: started + MIN, progressAt: NOW - 50 * MIN, stage: 'wait' };
  // A TV episode waiting for the encoder still says "download": the bot's
  // own line position is what gives it away.
  const tvInLine = { label: 'Loki S01E02', startedAt: started, progressAt: NOW - 60 * MIN, stage: 'download', waitingFor: { stage: 'convert', position: 2, of: 2 } };
  const r = run({ lines, health: health([encoding, inLine, tvInLine]) });
  ok(!r.incidents.some((f) => f.kind === 'stuck-job'), 'a film waiting 50 minutes behind an encode that is moving is not stuck, and neither is an episode in line for the encoder');
  ok(!r.restart.advised, 'so nothing is restarted, and the encode it waits for is kept');
  const frozen = { ...encoding, progressAt: NOW - 50 * MIN };
  const f = run({ lines, health: health([frozen, inLine, tvInLine]) });
  const stuckOnes = f.incidents.filter((x) => x.kind === 'stuck-job');
  ok(stuckOnes.some((x) => /Minority Report/.test(x.title) && /no progress for 50 min/.test(x.title)), 'the job holding the slot, silent for 50 minutes, is stuck');
  ok(stuckOnes.some((x) => /Inception/.test(x.title) && /nothing in the queue has moved/.test(x.title)) && f.restart.advised,
    'and when nothing in the queue has moved at all, the line itself is stuck - a slot that was never given back');
}

console.log('=== WhatsApp stopped from the panel is left stopped ===');
{
  // POST /api/wa/stop: bot.stop() sets "stopped", clears lastError (a
  // deliberate stop is not a failure) and leaves the service running. A
  // restart connects WhatsApp again on boot, which would overrule the
  // operator - every three hours, and interrupting the queue each time.
  const lines = log(
    L(NOW - 5 * HOUR, 'info', 'main', 'debug log -> /d'),
    L(NOW - 35 * MIN, 'warn', 'bot', 'connection closed (connectionClosed)'),
    L(NOW - 35 * MIN, 'info', 'bot', 'state -> stopped'),
  );
  const health = { startedAt: NOW - 5 * HOUR, connection: { state: 'stopped', lastError: null }, queues: { media: { running: [] } } };
  const r = run({ lines, health });
  ok(!r.restart.advised && r.restart.blockedBy.some((b) => /stopped on purpose/.test(b)), 'not restarted: a restart would connect it again');
  ok(!r.incidents.some((x) => x.kind === 'bot-unhealthy') && r.notices.some((x) => /stopped on purpose/.test(x.title)),
    'noted, not researched: somebody pressing Stop is not a fault');
  // An hour later the stop is old news, but still in force: a film
  // interrupted meanwhile must not be the reason WhatsApp comes back.
  const film = movieRow({ status: 'interrupted', title: 'Heat', year: 1995, request: 'heat', at: NOW + 10 * MIN });
  const later = scan({
    now: NOW + HOUR, config: CONFIG, memory: r.memory, health, unit: { ActiveState: 'active', NRestarts: '0' },
    lines: [...lines, ...log(L(NOW + 20 * MIN, 'warn', 'movie-requests', '"Heat" failed transiently (Connection Closed) - will retry on next start'))],
    state: stateWith({ movie: [film], moviePending: [{ jobKey: `${film.id}:tt0113277`, msgId: film.id }] }),
  });
  ok(later.incidents.some((x) => x.request?.id === film.id) && !later.restart.advised && later.restart.blockedBy.some((b) => /stopped on purpose/.test(b)),
    'an hour later, with an interrupted film to retry, still no restart while WhatsApp is stopped');
  const noReconnect = run({ lines, health: { ...health, connection: { state: 'stopped', lastError: 'disconnected: connectionLost' } } });
  ok(noReconnect.incidents.some((x) => x.kind === 'bot-unhealthy') && !noReconnect.restart.advised,
    'stopped after a dropped connection (auto-reconnect off) is reported, and reconnecting is left to a person');
}

console.log('=== a cooldown line explains one message, not every message near it ===');
{
  // 2026-09-28 05:03:02: one "ignoring ...: cooling down" line was matched to
  // four messages of the same member, and the one it was really about had
  // got its 🚫 - so the dossier said the movie side "logged no 🚫".
  const sender = { k: 'lid:77@lid', p: '77@lid', g: MOVIE_REQ };
  const t0 = Date.parse('2026-09-28T05:03:02Z');
  const at = (sec) => t0 + sec * 1000;
  const index = [
    { ...sender, i: 'EARLIER', t: at(-22), ...messageShape({ messageType: 'conversation', text: '#request Spaceballs' }) },
    { ...sender, i: 'COOLED-AND-TOLD', t: at(0), ...messageShape({ messageType: 'conversation', text: '#request Spaceballs 1987' }) },
    { ...sender, i: 'OLD-SHAPE-1', t: at(-40) },
    { ...sender, i: 'OLD-SHAPE-2', t: at(-50) },
  ];
  const lines = log(
    L(at(0), 'info', 'movie-requests', 'ignoring 77@lid: cooling down (20s left)'),
    L(at(1), 'debug', 'bot', 'reacted 🚫 on COOLED-AND-TOLD'),
  );
  const nowish = at(60 * 60);
  const r = scan({ now: nowish, config: CONFIG, names: NAMES, state: stateWith({ index }), lines, memory: { v: 1, lastScanAt: at(-600), seen: {} } });
  const all = [...r.incidents, ...r.notices];
  ok(!all.some((f) => f.fp === 'noreact:cooldown'), 'the line belongs to the message that got the 🚫, so nothing is blamed on the cooldown');
  const un = r.incidents.find((f) => f.fp === 'noreact:unanswered');
  ok(un?.items.length === 1 && un.items[0].request.id === 'EARLIER', 'the earlier request with no answer is unanswered - not "cooled down"');
  ok(r.notices.find((f) => f.fp === 'noreact:unknown')?.items.length === 2, 'entries with no recorded shape stay notices');

  // A TV cooldown line matched to an entry with no recorded shape: still a
  // notice. It may not have been a request, and for a day or two after the
  // index began recording shapes every entry is like that.
  const tvIndex = [{ k: 'lid:78@lid', p: '78@lid', g: TV_REQ, i: 'TV-OLD', t: at(0) }];
  const tv = scan({ now: nowish, config: CONFIG, state: stateWith({ index: tvIndex }), memory: { v: 1, lastScanAt: at(-600), seen: {} },
    lines: log(L(at(1), 'info', 'tv-requests', 'ignoring 78@lid: cooling down')) });
  ok(!tv.incidents.some((f) => f.kind === 'no-reaction') && tv.notices.some((f) => f.fp === 'noreact:unknown'),
    'a typeless entry is never researched on a cooldown match alone');
}

console.log('=== every new unanswered request is news ===');
{
  // A day's quiet after the first report let the next unanswered requests
  // through as notices, and the hour was recorded as all clear - the very
  // failure the operator asked about, heard a day late.
  const e = (i, t) => ({ k: 'num:15558180174', g: MOVIE_REQ, i, p: '5@lid', t, ...messageShape({ messageType: 'conversation', text: '#request Up 2009' }) });
  const r1 = run({ state: stateWith({ index: [e('FIRST', NOW - 40 * MIN)] }), memory: { v: 1, lastScanAt: NOW - HOUR, seen: {} } });
  ok(r1.incidents.some((f) => f.fp === 'noreact:unanswered'), 'hour 1: one unanswered request is researched');
  const r2 = scan({ now: NOW + HOUR, config: CONFIG, memory: r1.memory, state: stateWith({ index: [e('FIRST', NOW - 40 * MIN), e('SECOND', NOW + 10 * MIN), e('THIRD', NOW + 20 * MIN)] }) });
  const un = r2.incidents.find((f) => f.fp === 'noreact:unanswered');
  ok(un?.items.length === 2 && un.items.every((x) => x.request.id !== 'FIRST'), 'hour 2: the two new ones are researched too, and the first is not repeated');
}

console.log('=== an interrupted film: waiting for a restart, or already resumed ===');
{
  const film = movieRow({ id: 'MR', status: 'interrupted', title: 'Minority Report', year: 2002, request: 'minority report 2002', at: NOW - 3 * HOUR, detail: 'Connection Closed' });
  const journal = (resumedAt) => [{ jobKey: 'MR:tt0181689', msgId: 'MR', ...(resumedAt ? { resumedAt } : {}) }];
  const failed = (ts) => L(ts, 'warn', 'movie-requests', '"Minority Report" failed transiently (Connection Closed) - will retry on next start');
  const start = (ts) => L(ts, 'info', 'main', 'debug log -> /d');

  // 2026-09-28: interrupted at 19:47:59Z, resumed by the start at 19:48:11Z
  // and re-encoding from 19:54Z - with its row still "interrupted", which the
  // plugin only rewrites when the retry ends.
  const resumed = run({
    lines: log(start(NOW - 5 * HOUR), failed(NOW - 40 * MIN), start(NOW - 39 * MIN)),
    state: stateWith({ movie: [film], moviePending: journal(NOW - 39 * MIN + 9000) }),
  });
  ok(!resumed.incidents.some((f) => f.request?.id === 'MR') && !resumed.restart.advised,
    'resumed by this process and being retried: no finding, and above all no restart that would throw its new encode away');

  const waiting = run({
    lines: log(start(NOW - 5 * HOUR), failed(NOW - 40 * MIN)),
    state: stateWith({ movie: [film], moviePending: journal(null) }),
  });
  ok(waiting.incidents.some((f) => f.request?.id === 'MR' && f.restartHelps) && waiting.restart.advised,
    'interrupted in this process: it waits for the next start, so a restart is advised');

  // The check restarts; the film resumes, and is interrupted again in the
  // new process. Keyed on the request and its status alone, that was never
  // news again and nothing restarted for it.
  const again = scan({
    now: NOW + HOUR, config: CONFIG, memory: waiting.memory, unit: { ActiveState: 'active', NRestarts: '0' },
    lines: log(start(NOW - 5 * HOUR), failed(NOW - 40 * MIN), start(NOW + 5 * MIN), failed(NOW + 45 * MIN)),
    state: stateWith({ movie: [film], moviePending: journal(NOW + 5 * MIN + 9000) }),
  });
  const f2 = again.incidents.find((f) => f.request?.id === 'MR');
  ok(f2 && /interrupted again \(2nd time\)/.test(f2.title) && again.restart.advised, 'interrupted again after the restart: reported again, and restarted for');
  const third = scan({
    now: NOW + 2 * HOUR, config: CONFIG, memory: { ...again.memory, lastHealthRestartAt: null }, unit: { ActiveState: 'active', NRestarts: '0' },
    lines: log(start(NOW - 5 * HOUR), failed(NOW - 40 * MIN), start(NOW + 5 * MIN), failed(NOW + 45 * MIN), start(NOW + 65 * MIN), failed(NOW + 105 * MIN)),
    state: stateWith({ movie: [film], moviePending: journal(NOW + 65 * MIN + 9000) }),
  });
  const f3 = third.incidents.find((f) => f.request?.id === 'MR');
  ok(f3 && /3rd time/.test(f3.title) && !f3.restartHelps && !third.restart.advised,
    'a third time is reported as something for a person: another restart would only cost the queue');

  const dropped = run({ lines: log(start(NOW - 5 * HOUR), failed(NOW - 40 * MIN)), state: stateWith({ movie: [film] }) });
  const fd = dropped.incidents.find((f) => f.request?.id === 'MR');
  ok(fd && /no longer journalled/.test(fd.title) && !dropped.restart.advised, 'out of the journal, nothing will retry it: reported, with no restart that could not help');
}

console.log('=== an interrupted film this process is retrying by itself ===');
{
  // Since the in-process retries (incident-fixes, media/resume.js), a film
  // that loses its send is tried again once WhatsApp is back, and logged as
  // such. Its row reads "interrupted" while it waits the 30 seconds to 2
  // minutes - which the scanner took for "waiting for the next start" and
  // answered with a restart that threw the retry away.
  const film = movieRow({ id: 'SB', status: 'interrupted', title: 'Spaceballs', year: 1987, request: 'spaceballs', at: NOW - 2 * HOUR, detail: 'Connection Closed' });
  const journal = [{ jobKey: 'SB:tt0094012', msgId: 'SB', ready: { path: '/w/sb.mp4', size: 1 } }];
  const start = (ts) => L(ts, 'info', 'main', 'debug log -> /d');
  const line = (ts, tail) => L(ts, 'warn', 'movie-requests', `"Spaceballs" failed transiently (Connection Closed) - ${tail}`);

  const retrying = run({
    lines: log(start(NOW - 5 * HOUR), line(NOW - 2 * MIN, 'retrying once WhatsApp is connected (attempt 1 of 3), sending the finished 1.67 GB file as it is')),
    state: stateWith({ movie: [film], moviePending: journal }),
  });
  ok(!retrying.incidents.some((f) => f.request?.id === 'SB') && !retrying.restart.advised,
    'its retry is booked in this process: no finding, and no restart');

  const spent = run({
    lines: log(start(NOW - 5 * HOUR), line(NOW - 20 * MIN, 'retrying once WhatsApp is connected (attempt 1 of 3)'),
      line(NOW - 2 * MIN, 'retried 3 times in this process; will retry on next start')),
    state: stateWith({ movie: [film], moviePending: journal }),
  });
  ok(spent.incidents.some((f) => f.request?.id === 'SB' && f.restartHelps) && spent.restart.advised,
    'once its retries are spent it waits for the next start, and a restart is advised');

  // Since 2026-09-29 a film left for the next start keeps its work, and the
  // line says the start goes on from it; it is the same finding.
  const kept = run({
    lines: log(start(NOW - 5 * HOUR), line(NOW - 20 * MIN, 'retrying once WhatsApp is connected (attempt 1 of 3)'),
      line(NOW - 2 * MIN, 'retried 3 times in this process; will retry on next start, going on from what it had done')),
    state: stateWith({ movie: [film], moviePending: journal }),
  });
  ok(kept.incidents.some((f) => f.request?.id === 'SB' && f.restartHelps) && kept.restart.advised,
    'left for the next start with its work kept, it is read the same way: a restart is advised');

  const before = run({
    lines: log(line(NOW - 50 * MIN, 'retrying once WhatsApp is connected (attempt 1 of 3)'), start(NOW - 40 * MIN)),
    state: stateWith({ movie: [film], moviePending: [{ ...journal[0], resumedAt: NOW - 40 * MIN + 9000 }] }),
  });
  ok(!before.incidents.some((f) => f.request?.id === 'SB') && !before.restart.advised,
    'booked by a process that has since stopped: this one resumed it at its start, so nothing to do either');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
