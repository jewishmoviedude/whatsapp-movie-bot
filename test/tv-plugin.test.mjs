/* TV plugin routing + multi-group broadcast. Run: node test/tv-plugin.test.mjs */
import fs from 'node:fs';
import plugin from '../src/plugins/tv-requests/index.js';
import { postsTargets, broadcastFile } from '../src/media/broadcast.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const TVREQ = 'tvreq@g.us';
const POSTS1 = 'tvposts1@g.us';
const POSTS2 = 'tvposts2@g.us';

console.log('=== postsTargets ===');
ok(postsTargets({ postsGroup: 'a@g.us' }).join() === 'a@g.us', 'single legacy postsGroup');
ok(postsTargets({ postsGroups: ['a@g.us', 'b@g.us'] }).length === 2, 'array of posts groups');
ok(postsTargets({ postsGroup: 'a@g.us', postsGroups: ['b@g.us'] }).join() === 'a@g.us,b@g.us', 'both forms combine');
ok(postsTargets({ postsGroup: 'a@g.us', postsGroups: ['a@g.us'] }).length === 1, 'duplicates removed — never posts twice to one group');
ok(postsTargets({}).length === 0, 'nothing configured -> empty');
ok(postsTargets({ postsGroups: ['', '  '] }).length === 0, 'blank entries ignored');

console.log('=== broadcastFile ===');
{
  const hit = [];
  const r = await broadcastFile([POSTS1, POSTS2], async (jid) => { hit.push(jid); });
  ok(hit.join() === `${POSTS1},${POSTS2}`, 'uploads sequentially, in order');
  ok(r.sent.length === 2 && r.failed.length === 0, 'reports both as sent');
}
{
  // one group failing must not stop the others
  const hit = [];
  const r = await broadcastFile([POSTS1, POSTS2], async (jid) => {
    hit.push(jid);
    if (jid === POSTS1) throw new Error('not admin there');
  });
  ok(hit.length === 2, 'the second group is still attempted after a failure');
  ok(r.sent.join() === POSTS2, 'reports which succeeded');
  ok(r.failed[0].jid === POSTS1 && /not admin/.test(r.failed[0].error), 'reports why the other failed');
}

/* ------------------------------- plugin ------------------------------- */
const SERIES = { Items: [{ Id: 'SER1', Name: 'The Boys', ProductionYear: 2019 }] };
const SEASONS = { Items: [{ Id: 'S1', IndexNumber: 1 }, { Id: 'S2', IndexNumber: 2 }] };
const EPISODES = {
  Items: [
    { Id: 'E3', SeriesName: 'The Boys', ParentIndexNumber: 1, IndexNumber: 3, Name: 'Get Some', MediaSources: [{ Path: '/c.mkv', Size: 3 }] },
    { Id: 'E1', SeriesName: 'The Boys', ParentIndexNumber: 1, IndexNumber: 1, Name: 'Pilot', MediaSources: [{ Path: '/a.mkv', Size: 1 }] },
    { Id: 'E2', SeriesName: 'The Boys', ParentIndexNumber: 1, IndexNumber: 2, Name: 'Cherry', MediaSources: [{ Path: '/b.mkv', Size: 2 }] },
  ],
};

function makeCtx({ routes = { '/Items': SERIES, '/Seasons': SEASONS, '/Episodes': EPISODES }, tv = {} } = {}) {
  const queued = [];
  const reacted = [];
  const notes = [];
  const deleted = [];
  globalThis.fetch = async (url) => {
    for (const [k, v] of Object.entries(routes)) {
      if (String(url).includes(k)) return { ok: true, status: 200, json: async () => v };
    }
    return { ok: false, status: 404, statusText: 'NF', json: async () => ({}) };
  };
  const store = new Map();
  return {
    queued, reacted, notes, deleted,
    ctx: {
      config: {
        tvRequests: {
          enabled: true, requestGroups: [TVREQ], postsGroups: [POSTS1, POSTS2],
          blockedRatings: ['TV-MA'], cooldownSecondsPerUser: 0, ...tv,
        },
        movieRequests: { reactions: { researching: '🔍', added: '🎬', needYear: '📅', notInLibrary: '📬', rated: '⛔', failed: '⚠️', done: '✅' }, notify: { group: 'notif@g.us' } },
        library: { jellyfin: { baseUrl: 'http://jf:8096', accessToken: 'TOK', userId: 'U1' } },
        media: { workDir: '/tmp/tvtest' },
      },
      bot: {
        react: async (m, e) => { reacted.push(e); },
        isConnected: () => true,
        sendText: async (j, t) => { notes.push(t); return { key: { id: 'X' } }; },
        isGroupAdmin: () => false,
        deleteMessage: async (m) => { deleted.push(m.text || '(media)'); },   // '' is not nullish
        archiveChat: async () => {},
      },
      queue: { add: (j) => { queued.push(j); return j.label; } },
      store: { get: (k, d) => (store.has(k) ? store.get(k) : d), set: (k, v) => store.set(k, v) },
      log: { info() {}, warn() {}, error() {}, debug() {} },
    },
  };
}
const mkMsg = (text, chatJid = TVREQ) => ({
  text, chatJid, isGroup: true, fromMe: false, messageType: 'conversation',
  senderJid: 'u@lid', senderNumber: '15551112222', senderNumberDisplay: '+1 555 111 2222',
});

console.log('=== a season queues every episode, in order ===');
{
  const { ctx, queued, reacted } = makeCtx();
  await plugin.onMessage(mkMsg('The Boys season 1'), ctx);
  ok(queued.length === 3, `all 3 episodes queued (no cap)`);
  ok(queued.map((j) => j.label).join(',') === 'The Boys S01E01,The Boys S01E02,The Boys S01E03',
    'queued in broadcast order despite the fixture being shuffled');
  ok(queued.every((j) => j.kind === 'tv'), 'every job is marked kind:tv so movies keep priority');
  ok(reacted.includes('🎬'), 'requester sees the added reaction');
  ok(queued[0].meta.position === '1/3', 'each job records its place in the season');
}

console.log('=== a single episode queues just that one ===');
{
  const { ctx, queued } = makeCtx();
  await plugin.onMessage(mkMsg('The Boys S01E02'), ctx);
  ok(queued.length === 1 && queued[0].label === 'The Boys S01E02', 'exactly the requested episode');
}

console.log('=== a bare show name asks which season instead of dumping the series ===');
{
  const { ctx, queued, reacted, notes } = makeCtx();
  await plugin.onMessage(mkMsg('The Boys'), ctx);
  ok(queued.length === 0, 'nothing queued');
  ok(reacted.includes('📅'), 'asks with the needs-a-year/season reaction');
  ok(notes.some((n) => /which season/i.test(n) && /1, 2/.test(n)), 'tells them which seasons exist');
}

console.log('=== only listens to its own request groups ===');
{
  const { ctx, queued } = makeCtx();
  await plugin.onMessage(mkMsg('The Boys season 1', 'somewhere-else@g.us'), ctx);
  ok(queued.length === 0, 'a message from another group is ignored');
}
{
  const { ctx, queued } = makeCtx({ tv: { enabled: false } });
  await plugin.onMessage(mkMsg('The Boys season 1'), ctx);
  ok(queued.length === 0, 'disabled section queues nothing');
}
{
  const { ctx, queued } = makeCtx();
  await plugin.onMessage({ ...mkMsg('The Boys season 1'), fromMe: true }, ctx);
  ok(queued.length === 0, "the bot's own message is ignored");
}

console.log('=== unknown show ===');
{
  const { ctx, queued, reacted } = makeCtx({ routes: { '/Items': { Items: [] } } });
  await plugin.onMessage(mkMsg('Nonexistent S01E01'), ctx);
  ok(queued.length === 0 && reacted.includes('📬'), 'not in the library');
}

console.log('=== prefix mode ===');
{
  const { ctx, queued } = makeCtx({ tv: { requirePrefix: true, prefix: '#request' } });
  await plugin.onMessage(mkMsg('The Boys season 1'), ctx);
  ok(queued.length === 0, 'without the prefix it is ignored');
  await plugin.onMessage(mkMsg('#request The Boys season 1'), ctx);
  ok(queued.length === 3, 'with the prefix it queues');
}

console.log('=== cooldown ===');
{
  const { ctx, queued } = makeCtx({ tv: { cooldownSecondsPerUser: 300 } });
  await plugin.onMessage(mkMsg('The Boys S01E01'), ctx);
  ok(queued.length === 1, 'first request accepted');
  await plugin.onMessage(mkMsg('The Boys S01E02'), ctx);
  ok(queued.length === 1, 'a second request inside the cooldown is ignored');
}

console.log('=== episode cap (0 = no cap, per the spec) ===');
{
  const { ctx, queued } = makeCtx({ tv: { maxEpisodesPerRequest: 2 } });
  await plugin.onMessage(mkMsg('The Boys season 1'), ctx);
  ok(queued.length === 2, 'a cap is honoured when set');
  const b = makeCtx({ tv: { maxEpisodesPerRequest: 0 } });
  await plugin.onMessage(mkMsg('The Boys season 1'), b.ctx);
  ok(b.queued.length === 3, '0 means no cap — the whole season goes');
}

console.log('=== only the LAST episode marks the request done ===');
{
  const { ctx, queued } = makeCtx();
  await plugin.onMessage(mkMsg('The Boys season 1'), ctx);
  const flags = queued.map((j) => String(j.run));
  ok(queued.length === 3, 'three jobs');
  // isLast is passed positionally into deliverEpisode; check the wiring exists
  ok(/isLast/.test(flags[0]), 'each job knows whether it is the final episode');
}

console.log('=== TV groups are enforced too ===');
{
  const ENF = { enforcement: { enabled: true, deleteNonRequests: true, deleteMedia: true, exemptAdmins: true } };
  const base = makeCtx({ tv: { requirePrefix: true, prefix: '#request' } });
  base.ctx.config.movieRequests = { ...base.ctx.config.movieRequests, ...ENF };

  await plugin.onMessage(mkMsg('thanks guys!'), base.ctx);
  ok(base.deleted.includes('thanks guys!'), 'chatting in a TV request group is deleted');
  ok(base.queued.length === 0, 'and nothing is queued from it');

  await plugin.onMessage(mkMsg('#request The Boys S01E01'), base.ctx);
  ok(base.queued.length === 1, 'a properly formatted TV request still goes through');
  ok(!base.deleted.includes('#request The Boys S01E01'), 'and is NOT deleted');

  // a picture in a TV request group is removed like anywhere else
  await plugin.onMessage({ ...mkMsg(''), messageType: 'imageMessage' }, base.ctx);
  ok(base.deleted.includes('(media)'), 'media posted in a TV request group is deleted');
}
{
  // a season request contains numbers — it must never be mistaken for "multiple"
  const c = makeCtx({ tv: { requirePrefix: true, prefix: '#request' } });
  c.ctx.config.movieRequests = { ...c.ctx.config.movieRequests, enforcement: { enabled: true, deleteNonRequests: true, deleteMultiple: true, exemptAdmins: true } };
  await plugin.onMessage(mkMsg('#request The Boys season 1'), c.ctx);
  ok(c.deleted.length === 0, 'a season request is never deleted by the multi-title heuristic');
  ok(c.queued.length === 3, 'and it queues normally');
}
{
  // enforcement off -> nothing deleted
  const c = makeCtx({ tv: { requirePrefix: true, prefix: '#request' } });
  c.ctx.config.movieRequests = { ...c.ctx.config.movieRequests, enforcement: { enabled: false } };
  await plugin.onMessage(mkMsg('just chatting'), c.ctx);
  ok(c.deleted.length === 0, 'master switch off -> TV messages are left alone');
}
{
  // the rules command must survive in a TV group
  const c = makeCtx({ tv: { requirePrefix: true, prefix: '#request' } });
  c.ctx.config.movieRequests = { ...c.ctx.config.movieRequests, rulesCommand: '#rules', ruleSets: [{ command: '#rules-tvreq', text: 'x' }], enforcement: { enabled: true, deleteNonRequests: true, exemptAdmins: true } };
  await plugin.onMessage(mkMsg('#rules-tvreq'), c.ctx);
  ok(c.deleted.length === 0, 'a rules command is not deleted in a TV group');
}

console.log('=== every stage that starts also reports finishing ===');
{
  const src = fs.readFileSync(new URL('../src/plugins/tv-requests/index.js', import.meta.url), 'utf8');
  // A START with no DONE makes the log unreadable for "what is running right
  // now?" - which is exactly the question asked before restarting the bot.
  const starts = (src.match(/TV download START/g) ?? []).length;
  const dones = (src.match(/TV download DONE/g) ?? []).length;
  ok(starts === dones && starts > 0, `TV downloads log START and DONE in pairs (${starts}/${dones})`);
  ok(/⬇ TV download DONE/.test(src), 'the DONE line uses the same marker style as the START');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
