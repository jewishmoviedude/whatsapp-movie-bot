/* What the panel is told about the startup auto-update. Run: node test/auto-update-status.test.mjs

   deploy/auto-update.sh runs before node and leaves data/auto-update.json
   behind. A box whose installed unit predates the updater still has that
   script - it came with a pull - but never runs it, so an old status file
   could read as "updates are working" on a box that quietly stopped taking
   them. These pin that the file only counts for the start it belongs to. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readAutoUpdate, runningCommit, scrubUrlCredentials, processStartedAt } from '../src/core/auto-update-status.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-update-status-'));
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
const SHA = 'a'.repeat(40);
const put = (obj) => fs.writeFileSync(path.join(dir, 'auto-update.json'), typeof obj === 'string' ? obj : JSON.stringify(obj));
const START = Date.parse('2026-09-23T20:21:30Z');
const at = (ms) => new Date(START + ms).toISOString();

console.log('=== no data directory, no file ===');
{
  ok(readAutoUpdate(null) === null, 'nothing to look in: null, so the panel says "not checked yet"');
  ok(readAutoUpdate(dir, { startedAt: START }).installed === false, 'no file: the updater has never run here');
}

console.log('=== a file from just before this start describes this start ===');
{
  put({ checkedAt: at(-4000), result: 'updated', reason: 'updated 1 -> 2', branch: 'origin/main', head: SHA, from: SHA, to: SHA, commits: 2, trial: SHA, rejected: '' });
  const s = readAutoUpdate(dir, { startedAt: START });
  ok(s.installed && s.ranThisStart, 'ran this start');
  ok(s.result === 'updated' && s.commits === 2 && s.head === SHA && s.trial === SHA && s.rejected === null, 'with what it did');
  put({ checkedAt: at(-4 * 60_000), result: 'up-to-date' });
  ok(readAutoUpdate(dir, { startedAt: START }).ranThisStart, 'a long dependency install before the start still counts');
}

console.log('=== a file from an earlier start does not ===');
{
  // The unit on this box has no ExecStartPre=: the file is from before.
  put({ checkedAt: at(-3 * 86_400_000), result: 'up-to-date' });
  ok(readAutoUpdate(dir, { startedAt: START }).ranThisStart === false, 'three days before this start: not this start');
  put({ checkedAt: at(10 * 60_000), result: 'up-to-date' });
  ok(readAutoUpdate(dir, { startedAt: START }).ranThisStart === false, 'nor one written well after it started');
  put({ checkedAt: 'yesterday', result: 'up-to-date' });
  ok(readAutoUpdate(dir, { startedAt: START }).ranThisStart === false, 'nor one with no usable time');
}

console.log('=== what it passes on is checked, not trusted ===');
{
  put({ checkedAt: at(-1000), result: '<img src=x>', head: 'not-a-sha', commits: 'many', reason: 'x'.repeat(2000) });
  const s = readAutoUpdate(dir, { startedAt: START });
  ok(s.result === 'unreadable' && s.head === null && s.commits === 0, 'an unknown result, a bad sha and a non-number are dropped');
  ok(s.reason.length === 500, 'and a runaway reason is cut short');
  put('{ not json');
  const bad = readAutoUpdate(dir, { startedAt: START });
  ok(bad.installed && bad.result === 'unreadable' && bad.ranThisStart === false, 'a torn file reads as unreadable, never as fine');
}

console.log('=== a token in a URL is never passed on ===');
{
  ok(scrubUrlCredentials("fatal: unable to access 'https://me:ghp_abc123@github.com/x.git/'") ===
    "fatal: unable to access 'https://***@github.com/x.git/'", 'user and token are replaced');
  ok(scrubUrlCredentials('https://github.com/x.git') === 'https://github.com/x.git', 'a URL without one is left alone');
  put({ checkedAt: at(-1000), result: 'failed', reason: 'fetch https://u:secret@github.com failed' });
  ok(!/secret/.test(readAutoUpdate(dir, { startedAt: START }).reason), 'including in what the file says');
}

console.log('=== the running commit ===');
{
  const sha = runningCommit(new URL('..', import.meta.url).pathname);
  ok(sha === null || /^[0-9a-f]{40}$/.test(sha), `a full sha from a checkout, or null from a tarball (${sha})`);
  ok(runningCommit(dir) === null, 'null outside a git checkout, rather than a throw');
  ok(Math.abs(processStartedAt() - (Date.now() - process.uptime() * 1000)) < 1000, 'and when this process started');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
