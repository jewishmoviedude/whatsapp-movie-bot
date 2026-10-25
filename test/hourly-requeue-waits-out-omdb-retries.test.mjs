/* The hourly check's re-run waits out OMDb's retries, and reads only its own answer.
   Run: node test/hourly-requeue-waits-out-omdb-retries.test.mjs

   The incident, 2026-10-12. At 01:46:14Z "First daughter 2004" failed with
   "OMDb HTTP 525" for an OMDb outage of under 90 seconds, the member got ⚠️,
   and Head Admin raised it ('#issue #group02 on 10-11-2025 1945 @...
   requested "First Daughter 2004" and got an ⚠️ reaction, please queue once
   resolved'). At 03:06:50Z "My Fault London 2025" failed the same way with
   "OMDb HTTP 403", and the hourly check re-ran it. Since then an OMDb call
   that meets a failure of the moment tries again for up to two minutes
   (src/plugins/movie-requests/omdb.js).

   Review of that change found that the hourly check's re-run goes through
   the same lookup, over the bot's command channel, which runs one command
   at a time (src/index.js, cmdBusy), and the check waited 60 s for its
   answer. A re-run asked for while OMDb was still failing was reported as
   "the bot did not answer", and its late answer - matched by op and time
   alone - was taken as the answer to the check's next re-run, which was
   then reported as queuing the earlier film. So the check now waits for a
   re-run REQUEUE_WAIT_MS, OMDb's span included, and every answer carries
   the `ref` of the command it answers (answerFor, admin-commands.js).

   The bot here is a stand-in that takes data/bot-cmd.json one command at a
   time, as index.js does, on a fake clock: nothing really waits. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { botCommand, botRequest, REQUEUE_WAIT_MS } from '../tools/hourly-debug.mjs';
import { answerFor } from '../src/core/admin-commands.js';
import { OMDB_RETRY_SPAN_MS } from '../src/plugins/movie-requests/omdb.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hourly-requeue-'));
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));

const FILMS = { A: 'First Daughter (2004)', B: 'My Fault: London (2025)' };

/**
 * The bot's command channel: every 3 s it takes bot-cmd.json if it is not
 * busy with one already, and answers it `takes[id]` ms later with answerFor,
 * as src/index.js does.
 */
function standInBot(takes) {
  const dir = fs.mkdtempSync(path.join(TMP, 'data-'));
  const file = path.join(dir, 'bot-cmd.json');
  const result = path.join(dir, 'bot-cmd.result.json');
  let t = 1_000_000;
  let busy = null;
  let nextPoll = t + 3000;
  const poll = () => {
    if (busy && t >= busy.doneAt) {
      fs.writeFileSync(result, JSON.stringify(answerFor(busy.cmd, { ok: true, queued: FILMS[busy.cmd.id] }, t)));
      busy = null;
    }
    if (!busy && fs.existsSync(file)) {
      const cmd = JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.unlinkSync(file);
      busy = { cmd, doneAt: t + takes[cmd.id] };
    }
  };
  return {
    dir,
    now: () => t,
    wait: async (ms) => {
      const until = t + ms;
      while (nextPoll <= until) { t = nextPoll; poll(); nextPoll += 3000; }
      t = until;
    },
  };
}

console.log('=== the check waits for a re-run as long as OMDb\'s retries can take, and more ===');
{
  ok(REQUEUE_WAIT_MS >= 60_000 + OMDB_RETRY_SPAN_MS,
    `a re-run is waited for ${REQUEUE_WAIT_MS / 1000} s: the minute it had, and OMDb's ${OMDB_RETRY_SPAN_MS / 1000} s`);
  const asked = [];
  const ctx = { rerunnable: new Set(['movie:A']), requeued: 0, runId: 'r1' };
  await botRequest({ dataDir: TMP }, { op: 'requeue', plugin: 'movie', id: 'A' }, ctx, {
    ask: async (_dir, cmd, opts) => { asked.push(opts); return { op: 'requeue', ok: true, queued: FILMS.A }; },
  });
  ok(asked[0]?.timeoutMs === REQUEUE_WAIT_MS, `and botRequest asks with that wait (${asked[0]?.timeoutMs})`);

  // OMDb still failing when the check asks: the lookup waits 5, 25 and 60 s
  // between its tries and is answered at 90 s.
  const bot = standInBot({ A: 91_000 });
  const t0 = bot.now();
  const a = await botCommand(bot.dir, { op: 'requeue', plugin: 'movie', id: 'A' }, { timeoutMs: REQUEUE_WAIT_MS, raw: true, now: bot.now, wait: bot.wait });
  ok(a?.queued === FILMS.A, `a re-run answered at ${Math.round((bot.now() - t0) / 1000)} s is read as answered: queued ${a?.queued}`);
}

console.log('=== a late answer is never read as the answer to the next command ===');
{
  // The review's sequence: A outlasts a 60 s wait and answers at about 93 s;
  // B, asked for in the meantime, must get B's answer, not A's.
  const bot = standInBot({ A: 91_000, B: 5_000 });
  const opts = { timeoutMs: 60_000, raw: true, now: bot.now, wait: bot.wait };
  const a = await botCommand(bot.dir, { op: 'requeue', plugin: 'movie', id: 'A' }, opts);
  ok(a === null, 'A, waited for only 60 s, is unanswered');
  const b = await botCommand(bot.dir, { op: 'requeue', plugin: 'movie', id: 'B' }, opts);
  ok(b?.queued === FILMS.B, `B is answered with its own result (${b?.queued}), not A's late one (${FILMS.A})`);
}
{
  const bot = standInBot({});
  const result = path.join(bot.dir, 'bot-cmd.result.json');
  // A bot started before answers carried a ref answers as it always did.
  const old = { ...bot, wait: async (ms) => {
    await bot.wait(ms);
    const file = path.join(bot.dir, 'bot-cmd.json');
    if (fs.existsSync(file)) {
      const cmd = JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.unlinkSync(file);
      fs.writeFileSync(result, JSON.stringify({ op: cmd.op, at: bot.now(), ok: true, queued: FILMS[cmd.id] }));
    }
  } };
  const r = await botCommand(bot.dir, { op: 'requeue', plugin: 'movie', id: 'A' }, { timeoutMs: 10_000, raw: true, now: old.now, wait: old.wait });
  ok(r?.queued === FILMS.A, `an answer with no ref, from a bot started before, is still read (${r?.queued})`);
}

console.log('=== what the bot writes: the command\'s ref, with its result ===');
{
  const ans = answerFor({ op: 'requeue', id: 'A', ref: 'r-1' }, { ok: true, queued: FILMS.A }, 42);
  ok(ans.op === 'requeue' && ans.at === 42 && ans.ok === true && ans.queued === FILMS.A && ans.ref === 'r-1',
    `an answer: op, time, result and ref (${JSON.stringify(ans)})`);
  const err = answerFor({ op: 'requeue', ref: 'r-2' }, { ok: false, error: 'not re-run: already re-run once' });
  ok(err.ref === 'r-2' && err.ok === false && typeof err.at === 'number', 'a refusal carries the ref too');
  ok(!('ref' in answerFor({ op: 'health' }, { ok: true })), 'a command with no ref - an operator\'s by hand - is answered as before');
  ok(answerFor(null, { ok: false, error: 'bad JSON' }).op === null, 'and one that did not parse still gets an answer');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
