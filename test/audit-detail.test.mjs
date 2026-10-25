/* The audit log says WHAT happened, not just that something did.
   Run: node test/audit-detail.test.mjs

   Real gaps this covers:
   - a cancellation recorded as "DELETE /queue/478b53eb4285" — attributable to
     an admin, but you could never tell which title they cancelled
   - 27 "PUT /config" rows with no indication of which setting changed
   - the description rollout: 15 groups rewritten, posted into and pinned, and
     nothing in the audit log to show it happened
   - one click writing two rows ("unlocked all groups" AND "POST /lockdown/unlock") */
import fs from 'node:fs';
import { JobQueue } from '../src/core/queue.js';
import { changedPaths, describeConfigChange, describeValue } from '../src/util/diff.js';
import { summariseAdminCommand, auditAdminCommand } from '../src/core/admin-commands.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

console.log('=== a cancelled job can still be named ===');
{
  const q = new JobQueue({ concurrency: 1 });
  const id = q.add({
    label: 'Predator: Badlands (2025)',
    meta: { requester: '+15558090186' },
    run: () => new Promise(() => {}),          // never settles; stays put
  });
  const before = q.describe(id);
  ok(before?.label === 'Predator: Badlands (2025)', 'the job can be described by id');
  ok(before.meta.requester === '+15558090186', 'including who asked for it');

  // The title must be readable BEFORE the mutation — that is the whole point.
  q.cancel(id);
  const after = q.describe(id);
  ok(after?.label === 'Predator: Badlands (2025)', 'and remains findable in history afterwards');
  ok(q.describe('nope') === null, 'an unknown id returns null rather than throwing');
}

console.log('=== clearing the queue records what was lost ===');
{
  const q = new JobQueue({ concurrency: 1 });
  q.pause();                                   // so both stay waiting
  q.add({ label: 'A (2001)', run: async () => {} });
  q.add({ label: 'B (2002)', run: async () => {} });
  const labels = q.pendingLabels();
  ok(labels.length === 2, 'the waiting titles are readable before clearing');
  ok(labels[0] === 'A (2001)' && labels[1] === 'B (2002)', 'in queue order');
  const n = q.clearPending();
  ok(n === 2, 'and clearing reports how many went');
  ok(q.pendingLabels().length === 0, 'the queue is then empty');
}

console.log('=== a config change says which setting moved ===');
{
  const before = { movieRequests: { enforcement: { enabled: true }, prefix: '#request' }, media: { concurrency: 2 } };
  const after = { movieRequests: { enforcement: { enabled: false }, prefix: '#request' }, media: { concurrency: 2 } };
  const s = describeConfigChange(before, after, []);
  ok(/movieRequests\.enforcement\.enabled/.test(s), 'names the exact path');
  ok(/true → false/.test(s), 'and shows the change');
  ok(!/prefix/.test(s), 'settings that did not change are not mentioned');
  ok(describeConfigChange(before, before, []) === null,
    'saving a form without changing anything is not an audit event');
}

console.log('=== secret values are NEVER written to the log ===');
{
  const before = { omdb: { apiKey: 'sk-real-secret-aaa' } };
  const after = { omdb: { apiKey: 'sk-real-secret-bbb' } };
  const s = describeConfigChange(before, after, ['omdb.apiKey']);
  ok(/omdb\.apiKey: changed/.test(s), 'the change is recorded');
  ok(!s.includes('sk-real-secret-aaa') && !s.includes('sk-real-secret-bbb'),
    'but neither the old nor the new value appears');

  // and the same field without a secret marking WOULD show — proving the guard does the work
  const unguarded = describeConfigChange(before, after, []);
  ok(unguarded.includes('sk-real-secret-bbb'), 'control: unguarded paths do show values');
}

console.log('=== long and structured values are summarised, not dumped ===');
{
  const s = describeConfigChange(
    { movieRequests: { rules: 'x'.repeat(4000) } },
    { movieRequests: { rules: 'y'.repeat(4000) } }, []);
  ok(s.length < 400, `a 4000-char rules blob does not flood the log (${s.length} chars)`);
  ok(/4000 chars/.test(s), 'it says how big it is instead');

  ok(describeValue([1, 2, 3]) === '[3 items]', 'arrays are counted');
  ok(describeValue({ a: 1 }) === '{1 field}', 'objects are counted');
  ok(describeValue('') === '(empty)', 'an emptied field is legible');
  ok(describeValue(undefined) === '(unset)', 'and so is an unset one');

  // an array reordered is ONE change, not one per element
  const c = changedPaths({ g: ['a', 'b'] }, { g: ['b', 'a'] }, []);
  ok(c.length === 1 && c[0].path === 'g', 'a reordered list is a single change');
}

console.log('=== the description rollout leaves a trace ===');
{
  const s = summariseAdminCommand(
    { op: 'post-descriptions' },
    { results: [
      { subject: 'MOVIE POSTS ONLY', ok: true, pinned: true },
      { subject: 'TV POSTS ONLY!', ok: true, pinned: true },
      { subject: 'Google Drive Links', ok: true, pinned: false },
    ] });
  ok(/posted the description into 3 group\(s\)/.test(s.action), 'says how many groups');
  ok(/pinned 2/.test(s.action), 'and distinguishes posted from pinned');
  ok(/MOVIE POSTS ONLY/.test(s.detail), 'and names them');

  const a = summariseAdminCommand({ op: 'apply-descriptions' },
    { results: [{ subject: 'A', ok: true }, { subject: 'B', ok: false, error: 'not admin' }] });
  ok(/rewrote the description of 1 group/.test(a.action), 'only successes are counted');
  ok(/FAILED: B/.test(a.detail), 'and failures are named, not silently dropped');
}

console.log('=== reads are not logged as changes ===');
{
  for (const op of ['dump-groups', 'dump-descriptions', 'dump-invites', 'check-invites', 'scan-mentions']) {
    ok(summariseAdminCommand({ op }, { ok: true }) === null, `${op} is a read, not an audit event`);
  }
  const events = [];
  const store = { namespace: () => ({ push: (k, v) => events.push(v) }) };
  auditAdminCommand(store, { op: 'dump-groups' }, { ok: true });
  ok(events.length === 0, 'so it writes nothing');
  auditAdminCommand(store, { op: 'apply-descriptions' }, { results: [{ subject: 'A', ok: true }] });
  ok(events.length === 1, 'while a mutating op does write');
  ok(events[0].user === 'admin-command (local shell)', 'attributed to the shell operator');
  ok(events[0].role === 'operator', 'with a role that is not a portal admin');
}

console.log('=== a failed admin command is recorded too ===');
{
  const events = [];
  const store = { namespace: () => ({ push: (k, v) => events.push(v) }) };
  auditAdminCommand(store, { op: 'dump-groups' }, null, new Error('not connected'));
  ok(events.length === 1, 'even a read is logged when it FAILS');
  ok(/FAILED/.test(events[0].action), 'and is marked as a failure');
  ok(/not connected/.test(events[0].detail), 'with the reason');
}

console.log('=== the audit log never breaks the thing it records ===');
{
  const broken = { namespace: () => { throw new Error('state store gone'); } };
  let threw = null;
  try { auditAdminCommand(broken, { op: 'apply-descriptions' }, { results: [] }); }
  catch (e) { threw = e; }
  ok(!threw, 'a failing audit write is swallowed');
}

console.log('=== one action writes ONE row ===');
{
  const api = fs.readFileSync(new URL('../src/web/api.js', import.meta.url), 'utf8');
  ok(/if \(res\) res\.locals\.audited = true;/.test(api), 'a described action marks the response');
  ok(/if \(res\.statusCode < 400 && !res\.locals\.audited\)/.test(api),
    'and the catch-all skips it, so one click no longer writes two rows');

  const calls = api.match(/audit\(req,[\s\S]*?\);/g) ?? [];
  // An explicit `null` is the one exception: an outcome recorded in the
  // background after the response went out (the catalogue rebuild answers 202
  // and walks the library afterwards) has no response left to mark.
  const missing = calls.filter((c) => !c.includes('res)') && !c.includes('req.method') && !/,\s*null\);$/.test(c));
  ok(missing.length === 0, `every explicit audit call marks the response (${calls.length} calls)`);
}

console.log('=== queue routes name the job ===');
{
  const api = fs.readFileSync(new URL('../src/web/api.js', import.meta.url), 'utf8');
  for (const [route, verb] of [['/queue/:id', 'cancelled'], ['/queue/:id/skip', 'skipped'], ['/queue/:id/move', 'moved']]) {
    const re = new RegExp(`'${route.replace(/[/:]/g, '\\$&')}'[\\s\\S]{0,700}?audit\\(req, \`${verb}`);
    ok(re.test(api), `${route} records "${verb} <title>"`);
  }
  ok(/const job = queue\.describe\(req\.params\.id\);\n\s+const ok = queue\.cancel/.test(api),
    'and reads the title BEFORE the cancel removes it');
  ok(/const labels = queue\.pendingLabels\(\);\n\s+const n = queue\.clearPending\(\)/.test(api),
    'clear reads the titles before emptying the queue');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
