/* mark-extras judges a request by the member's last request that really put something in the queue.
   Run: node test/mark-extras-counts-what-really-queued.test.mjs

   The 'mark-extras' admin command (src/core/mark-extras.js) makes a waiting
   request an extra when the member's previous request of the kind was asked
   for less than the cooldown before it - "previous" meaning one that put
   something in the queue, since that is when the member's clock starts
   (request-cooldown.js, the operator's rule of 2026-10-01). It went by the
   History status alone, and disagreed with the clock on three kinds of row
   (found in review, 2026-10-12, and reproduced):

     - 'resent', a member's own waiting request sent again, queues nothing
       and starts no clock, but stood for that request at the resend's time;
     - a TV 'failed' row "season 2 not added — the bot restarted part-way
       through the request", and a request that followed another's and was
       'sent' with it ("posted, with an earlier request for it", TV and film
       alike), queued nothing, but counted;
     - a film 'lost' row - a queued film a restart dropped, which did start
       the clock - did not count.

   Now a TV row counts when its episodes went in (`episodes` > 0) and a film
   row when the film did (`enqueuedAt`), not one the queue refused as full.
   Dry runs on the real JobQueue, with the plugins' History and journals. */
import { JobQueue } from '../src/core/queue.js';
import { markExtras } from '../src/core/mark-extras.js';
import { requestMemberKey } from '../src/core/members.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const MIN = 60_000, HOUR = 60 * MIN;
const now = Date.now();
const TVREQ = 'tvreq@g.us';
const FILMREQ = 'films@g.us';
const PEOPLE = ['ana', 'ben', 'cy', 'dov', 'eli', 'fred', 'gus'];
const NUMBER = Object.fromEntries(PEOPLE.map((p, i) => [p, `1555000${String(i + 1).padStart(4, '0')}`]));
const keyOf = (who) => requestMemberKey({ senderNumber: NUMBER[who], senderJid: `${who}@lid` });
const who = (p) => ({ requester: p, requesterJid: `${p}@lid`, requesterNumber: NUMBER[p], requesterNumberDisplay: null });

const tvRow = (p, id, request, status, ago, extra = {}) => ({
  id, kind: 'tv', at: now - ago, requestedAt: now - ago, ...who(p), groupJid: TVREQ, request, title: 'The Boys', status, ...extra,
});
const filmRow = (p, id, request, status, ago, extra = {}) => ({
  id, at: now - ago, requestedAt: now - ago, ...who(p), groupJid: FILMREQ, request, title: request, status, ...extra,
});
const POSTED_WITH = 'posted, with an earlier request for it';

const tvHistory = [
  // Ana: the restart's note for a season it never added, a minute ago; her
  // last request that queued anything, two hours ago.
  tvRow('ana', 'h-ana1', 'the boys s1', 'sent', 2 * HOUR, { episodes: 8 }),
  tvRow('ana', 'h-ana2', 'the boys season 2', 'failed', MIN,
    { episodes: 0, detail: 'season 2 not added — the bot restarted part-way through the request' }),
  // Ben: a minute ago, a request that followed somebody else's and was posted with it.
  tvRow('ben', 'h-ben1', 'the boys s1', 'sent', MIN, { episodes: 0, detail: POSTED_WITH }),
  // Cy: his request three hours ago, sent again a minute ago while it waited.
  tvRow('cy', 'h-cy1', 'the boys s1', 'sent', 3 * HOUR, { episodes: 8 }),
  tvRow('cy', 'h-cy2', 'the boys s1', 'resent', MIN, { episodes: 0, resendOf: 'h-cy1' }),
  // Dan: part of a season posted five minutes ago - it queued, and counts.
  tvRow('dov', 'h-dov1', 'the boys s1', 'partial', 5 * MIN, { episodes: 4 }),
  // Each one's waiting request, asked for now.
  ...['ana', 'ben', 'cy', 'dov'].map((p) => tvRow(p, `h-${p}`, `the boys season 4 (${p})`, 'queued', 0, { episodes: 2 })),
];
const filmHistory = [
  // Eli: a film queued five minutes ago that a restart dropped ('lost').
  filmRow('eli', 'h-eli1', 'heat 1995', 'lost', 5 * MIN, { enqueuedAt: now - 5 * MIN + 2000, detail: 'interrupted before it finished' }),
  // Fred: a minute ago, a film that followed somebody else's and was posted with it.
  filmRow('fred', 'h-fred1', 'heat 1995', 'sent', MIN, { detail: POSTED_WITH }),
  // Gus: a minute ago, refused as the queue was full after it was stamped queued.
  filmRow('gus', 'h-gus1', 'heat 1995', 'error', MIN, { enqueuedAt: now - MIN + 2000, detail: 'queue full' }),
  ...['eli', 'fred', 'gus'].map((p) => filmRow(p, `h-${p}`, `dune 2021 (${p})`, 'queued', 0, { enqueuedAt: now })),
];

const store = (data) => ({ get: (k, d = null) => (k in data ? structuredClone(data[k]) : d), set: (k, v) => { data[k] = structuredClone(v); } });
const tvData = {
  history: tvHistory,
  pending: ['ana', 'ben', 'cy', 'dov'].map((p) => ({ reqKey: `tv-${p}`, baseRow: { id: `h-${p}` } })),
};
const filmData = {
  history: filmHistory,
  pending: ['eli', 'fred', 'gus'].map((p) => ({ jobKey: `f-${p}`, record: { id: `h-${p}` }, meta: { memberKey: keyOf(p) } })),
};

const queue = new JobQueue({ concurrency: 1, fairShare: true });
queue.pause();
for (const p of ['eli', 'fred', 'gus']) {
  queue.add({ label: `Dune (${p})`, meta: { memberKey: keyOf(p), jobKey: `f-${p}` }, run: async () => {} });
}
for (const p of ['ana', 'ben', 'cy', 'dov']) {
  queue.add({
    kind: 'tv', label: `The Boys S04E01 (${p})`, group: `tv-${p}`, groupLabel: `The Boys season 4 (${p})`,
    groupMeta: { memberKey: keyOf(p) }, meta: { memberKey: keyOf(p) }, run: async () => {},
  });
}

const r = markExtras({
  queue, apply: false, now,
  config: { tvRequests: { cooldownSecondsPerUser: 3600 }, movieRequests: { cooldownSecondsPerUser: 3600 } },
  bot: { isGroupAdmin: () => false },
  pluginManager: { plugins: new Map([['tv-requests', { ctx: { store: store(tvData) } }], ['movie-requests', { ctx: { store: store(filmData) } }]]) },
});
const res = (label) => r.requests.find((x) => x.label === label) ?? {};
const said = (label) => `${res(label).extra ? 'extra' : 'not'}: ${res(label).why}`;

console.log('=== TV: only a row whose episodes went in is a request that queued ===');
ok(!res('The Boys season 4 (ana)').extra && /2h after it: past the 1h TV cooldown/.test(res('The Boys season 4 (ana)').why),
  `Ana: the restart's note queued nothing; her request two hours ago did (${said('The Boys season 4 (ana)')})`);
ok(!res('The Boys season 4 (ben)').extra && /no earlier TV request of theirs that queued something/.test(res('The Boys season 4 (ben)').why),
  `Ben: posted with somebody else's request, his queued nothing (${said('The Boys season 4 (ben)')})`);
ok(!res('The Boys season 4 (cy)').extra && /3h after it/.test(res('The Boys season 4 (cy)').why) && res('The Boys season 4 (cy)').previous?.status === 'sent',
  `Cy: his resend a minute ago queued nothing; his request three hours ago did (${said('The Boys season 4 (cy)')})`);
ok(res('The Boys season 4 (dov)').extra && res('The Boys season 4 (dov)').previous?.status === 'partial',
  `Dan: part of a season posted five minutes ago still counts (${said('The Boys season 4 (dov)')})`);

console.log('=== films: only a film that went into the queue ===');
ok(res('Dune (eli)').extra && res('Dune (eli)').previous?.status === 'lost' && /5m after it: inside/.test(res('Dune (eli)').why),
  `Eli: a film queued five minutes ago and lost to a restart started his clock (${said('Dune (eli)')})`);
ok(!res('Dune (fred)').extra && /no earlier film request of theirs that queued something/.test(res('Dune (fred)').why),
  `Fred: posted with somebody else's request, his queued nothing (${said('Dune (fred)')})`);
ok(!res('Dune (gus)').extra && /no earlier film request/.test(res('Dune (gus)').why),
  `Gus: refused as the queue was full, though stamped queued (${said('Dune (gus)')})`);
ok(r.wouldMark === 2, `two to mark, Dan's and Eli's (${r.wouldMark})`);
queue.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
