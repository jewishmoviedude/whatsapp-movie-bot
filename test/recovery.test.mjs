/* Queue journalling. Without this a restart silently drops queued movies,
   leaving them showing "queued" forever. Run: node test/recovery.test.mjs */
import plugin from '../src/plugins/movie-requests/index.js';
import fs from 'node:fs';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

function fakeStore() {
  const data = {};
  return {
    get: (k, d = null) => (k in data ? data[k] : d),
    set: (k, v) => { data[k] = v; },
    push: (k, v, cap = 200) => { (data[k] ??= []).unshift(v); if (data[k].length > cap) data[k].length = cap; },
    all: () => ({ ...data }),
    _data: data,
  };
}

console.log('=== journal add / remove ===');
{
  const store = fakeStore();
  const ctx = { store };
  plugin._journalAdd(ctx, { jobKey: 'a', movie: { title: 'A' } });
  plugin._journalAdd(ctx, { jobKey: 'b', movie: { title: 'B' } });
  ok(store.get('pending').length === 2, 'two jobs journalled');

  plugin._journalRemove(ctx, 'a');
  const left = store.get('pending');
  ok(left.length === 1 && left[0].jobKey === 'b', 'removing one leaves the other');

  plugin._journalRemove(ctx, 'nope');
  ok(store.get('pending').length === 1, 'removing an unknown key is a no-op');

  plugin._journalRemove(ctx, 'b');
  ok(store.get('pending').length === 0, 'journal empties');
}

console.log('\n=== recovery clears the journal before replaying ===');
{
  // A job that cannot be resumed must not be retried on every restart.
  const store = fakeStore();
  store.set('pending', [{ jobKey: 'x', msgId: 'm', msgKey: {}, chatJid: 'g@g.us',
                          movie: { title: 'Nonexistent Zzz', year: 2099 }, meta: {}, record: {} }]);
  const added = [];
  const ctx = {
    store,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    queue: { add: (j) => added.push(j) },
    // No provider configured, so findInLibrary throws - the unresumable case.
    config: { library: { provider: 'jellyfin', jellyfin: {} }, media: {} },
    bot: { react: async () => {} },
  };
  await plugin.recoverPending(ctx);
  ok(store.get('pending').length === 0, 'journal cleared even though recovery failed');
  ok(added.length === 0, 'nothing queued for an unresumable job');
}

console.log('\n=== an empty journal is a no-op ===');
{
  const store = fakeStore();
  let called = false;
  const ctx = { store, log: { warn: () => { called = true; }, info: () => {}, error: () => {} },
                queue: { add: () => {} }, config: { library: {}, media: {} }, bot: {} };
  await plugin.recoverPending(ctx);
  ok(!called, 'no recovery message when there is nothing pending');
}

console.log('\n=== transient vs terminal classification ===');
{
  const re = /not connected|ECONNRESET|ETIMEDOUT|socket hang up|EAI_AGAIN|rate.?overlimit/i;
  for (const m of ['WhatsApp is not connected', 'socket hang up', 'ETIMEDOUT', 'rate-overlimit'])
    ok(re.test(m), `transient: ${m}`);
  for (const m of ['encoded file is 2.4 GB, still over the limit', 'ffmpeg exited 1', 'no such file'])
    ok(!re.test(m), `terminal: ${m}`);
}

console.log('\n=== a resumed job must carry its jobKey ===');
{
  // deliver() clears the journal via _journalRemove(ctx, jobKey). If a
  // resumed job is queued without one, the filter matches nothing and the
  // job is replayed on every restart for ever.
  const src = fs.readFileSync(new URL('../src/plugins/movie-requests/index.js', import.meta.url), 'utf8');
  // Bound the slice by the next method's doc comment, not by a call name
  // that also appears inside recoverPending itself.
  const recover = src.slice(src.indexOf('async recoverPending'),
                            src.indexOf('/** Journal a job so a restart'));
  ok(/jobKey:\s*p\.jobKey/.test(recover), 'recoverPending passes jobKey through to deliver');
  // Where it is, not 🔄 - which a member read as "send it again" after the
  // 15:22 restart on 2026-10-11 (Iron Man 3; test/no-redo-reaction.test.mjs).
  ok(/this\._whereNow\(ctx, p, \{ queued \}\)/.test(recover) && !/\.redo\b/.test(recover.replace(/live\.redo/g, '')),
    'a resumed job is shown where it is (_whereNow), never the redo emoji');
  ok(/_journalAdd/.test(recover),
     're-journals the job, so a second restart does not lose it');
}

console.log(`\n${'='.repeat(50)}\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
