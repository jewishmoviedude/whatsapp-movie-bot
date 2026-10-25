/* Choosing which running job gets the next stage slot. Run: node test/running-order.test.mjs

   Asked for from the live panel: Avengers was encoding, and Guardians of the
   Galaxy and Ready Player One were both downloaded and "waiting to convert -
   another file is encoding", in the order they had happened to finish
   downloading. The Queue card's waiting jobs have arrows; the running ones did
   not, so there was no way to say Ready Player One should be converted next.

   A running job that is in line for a stage slot (the one download, encoder
   or upload the stages share) can now be moved up that line. The job holding
   the slot is never interrupted - an encode is not thrown away - so this only
   decides who goes next. */
import express from 'express';
import http from 'node:http';
import { Semaphore } from '../src/util/semaphore.js';
import { stageSems, stageWaits } from '../src/media/stages.js';
import { JobQueue } from '../src/core/queue.js';
import { createApiRouter } from '../src/web/api.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const tick = () => new Promise((r) => setTimeout(r, 5));

console.log('=== the semaphore: a waiter can be moved up the line ===');
{
  const s = new Semaphore(1, 'convert');
  await s.acquire(1, 'holder', { key: 'h' });
  const got = [];
  const wait = (prio, key) => s.acquire(prio, null, { key }).then(() => { got.push(key); });
  const a = wait(1, 'a'), b = wait(1, 'b'), c = wait(0, 'c');
  ok(s.position('a') === 1 && s.position('b') === 2 && s.position('c') === 3, 'movies first, then the TV episode, in arrival order');
  ok(s.position('h') === 0 && s.position('zzz') === 0, 'the holder and a stranger are not in line');
  ok(s.promote('c', 'up') && s.position('c') === 2 && s.position('b') === 3, '"up" passes the one ahead');
  ok(s.promote('c', 'top') && s.position('c') === 1 && s.position('a') === 2, '"top" makes it next');
  ok(!s.promote('c', 'top') && !s.promote('c', 'up'), 'already next: nothing to do');
  ok(!s.promote('h') && !s.promote('zzz') && !s.promote(null), 'the holder, a stranger, no key: nothing to do');

  // A movie arriving now must not slip back in front of the episode the admin
  // just put first: acquire() places newcomers after everyone of equal or
  // higher priority, so the promoted one took the priority of the one it passed.
  const d = wait(1, 'd');
  ok(s.position('c') === 1 && s.position('d') === 4, 'a movie that starts waiting afterwards joins the back, not the front');

  s.release('holder');
  await tick();
  ok(got[0] === 'c', `the promoted one gets the slot next (${got.join()})`);
  for (let i = 0; i < 3; i++) { s.release(); await tick(); }
  await Promise.all([a, b, c, d]);
  ok(got.join() === 'c,a,b,d', `and the rest follow in the line as it now stands (${got.join()})`);
}

console.log('=== the queue: running jobs say where they stand, and can be moved ===');
const gate = {};
const holdConvert = (name) => new Promise((r) => { gate[name] = r; });
function convertJob(name) {
  return {
    label: name,
    kind: 'movie',
    run: async (job) => {
      if (stageSems.convert.free === 0) job.progress({ stage: 'wait', text: 'waiting to convert — another file is encoding' }, 40);
      await stageSems.convert.acquire(1, null, { key: job.id });
      try {
        job.progress({ stage: 'convert', text: 'encoding' }, 50);
        order.push(name);
        await holdConvert(name);
      } finally {
        stageSems.convert.release();
      }
    },
  };
}
const order = [];
const queue = new JobQueue({ concurrency: 3, maxLength: 10 });
queue.setStageWaits(stageWaits);
for (const name of ['Avengers: Age of Ultron', 'Guardians of the Galaxy', 'Ready Player One', 'Waiting Room']) {
  queue.add(convertJob(name));
}
await tick();
const view = (name) => queue.snapshot().active.find((j) => j.label === name);
const pendingView = (name) => queue.snapshot().pending.find((j) => j.label === name);
{
  ok(order.join() === 'Avengers: Age of Ultron' && queue.snapshot().active.length === 3, 'Avengers is encoding; three running');
  ok(!view('Avengers: Age of Ultron').waiting, 'the one encoding is not in line');
  const g = view('Guardians of the Galaxy').waiting, rp = view('Ready Player One').waiting;
  ok(g?.stage === 'convert' && g.position === 1 && g.of === 2, `Guardians is next to convert (${JSON.stringify(g)})`);
  ok(rp?.stage === 'convert' && rp.position === 2, 'Ready Player One is second');
  ok(pendingView('Waiting Room') && !pendingView('Waiting Room').waiting, 'a job not yet started has no place in a stage line');

  let pushed = 0;
  const onState = () => { pushed += 1; };
  queue.on('state', onState);
  const rpo = view('Ready Player One').id;
  ok(queue.moveRunning(rpo, 'top') === true, 'Ready Player One moved to next');
  ok(view('Ready Player One').waiting.position === 1 && view('Guardians of the Galaxy').waiting.position === 2, 'the places swap');
  ok(pushed === 1, 'and the panel is pushed the new order at once');
  queue.off('state', onState);
  ok(queue.moveRunning(rpo, 'top') === false, 'moving the one already next does nothing');
  ok(queue.moveRunning(view('Avengers: Age of Ultron').id, 'top') === false, 'the one encoding cannot be moved - it is not in line');
  ok(queue.moveRunning(pendingView('Waiting Room').id, 'top') === false, 'nor can a job that has not started (that is move/moveTop)');

  gate['Avengers: Age of Ultron']();
  await tick(); await tick();
  ok(order[1] === 'Ready Player One', `when Avengers finishes, Ready Player One is converted next (${order.join(' → ')})`);
}

console.log('=== over HTTP: the panel\'s arrows move a running job, and say so ===');
{
  const events = [];
  const stateStore = { namespace: (n) => ({
    get: (k, d) => (n === 'audit' && k === 'events' ? events : d),
    set: () => {},
    push: (k, v) => { if (n === 'audit') events.unshift(v); },
  }) };
  const cfg = {
    web: { adminPasswordHash: 'x', users: [{ username: 'mommy', role: 'superadmin', passwordHash: 'x' }] },
    movieRequests: { requestGroups: [], maxQueueLength: 50, reactions: {} }, media: { concurrency: 3 },
    whatsapp: { accounts: [], failover: { enabled: false, order: [] } }, tvRequests: {}, directLinks: {}, queue: {}, lockdown: {},
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { user: { username: 'mommy', role: 'superadmin' } }; next(); });
  app.use('/api', createApiRouter({
    configStore: { get: () => cfg, update: () => cfg, redacted: () => ({}), onChange: () => {} },
    bot: { groupCache: new Map(), groups: () => [], on: () => {}, state: 'connected' },
    queue, linkQueue: new JobQueue({ concurrency: 1 }),
    pluginManager: { plugins: new Map(), notifyConfigChange: async () => {} },
    stateStore, fileLogger: { tail: () => [] }, alerts: {}, lockScheduler: {},
  }));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const post = (path, body) => new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port: server.address().port, method: 'POST', path,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(buf || '{}') }));
    });
    r.on('error', reject);
    r.end(data);
  });

  // Ready Player One is encoding now; Guardians and Waiting Room are in line.
  const wr = view('Waiting Room');
  ok(wr?.waiting?.position === 2, `Waiting Room started and is second in line (${JSON.stringify(wr?.waiting)})`);
  const r1 = await post(`/api/queue/${wr.id}/move`, { dir: 'up' });
  ok(r1.status === 200 && r1.body.ok && view('Waiting Room').waiting.position === 1, 'POST move "up" moves a running job up the line');
  ok(/moved "Waiting Room" up in line to convert/.test(events[0]?.action ?? ''), `and the audit log says what, and for which slot: "${events[0]?.action}"`);
  const r2 = await post(`/api/queue/${wr.id}/move`, { dir: 'top' });
  ok(r2.status === 409 && r2.body.error === 'It is already next in line', `already next: refused, saying why ("${r2.body.error}")`);
  const r3 = await post(`/api/queue/${view('Guardians of the Galaxy').id}/move`, { dir: 'down' });
  ok(r3.status === 409 && view('Guardians of the Galaxy').waiting.position === 2, 'a running job is not moved down - move the other one up');
  const r4 = await post(`/api/queue/${view('Ready Player One').id}/move`, { dir: 'top' });
  ok(r4.status === 409 && /already running/.test(r4.body.error), 'the one encoding cannot be moved, and the panel is told why');
  server.close();
}

for (const name of Object.keys(gate)) gate[name]();
queue.pause();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
