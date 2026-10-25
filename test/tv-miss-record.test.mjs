/* A TV request that finds nothing must leave a trace.
   Run: node test/tv-miss-record.test.mjs

   The three ways a TV request ends at "not in the library" - the show is not
   there, the season is empty, the episode is missing - used to be three silent
   `return`s. Same emoji for all three, no reply, no log line, no history row,
   nothing written anywhere. A requester saw 📬 and an operator saw nothing at
   all, so "the bot says you do not have Kitchen Nightmares and you plainly do"
   was unanswerable after the fact: you could not tell which of the three it
   was, what was searched for, or even which group it was asked in. */
import plugin from '../src/plugins/tv-requests/index.js';
import { listMisses } from '../src/core/library-misses.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const TVREQ = 'tvreq@g.us';

const SERIES = { Items: [{ Id: 'SER1', Name: 'The Boys', ProductionYear: 2019 }] };
const SEASONS = { Items: [{ Id: 'S1', IndexNumber: 1 }, { Id: 'S2', IndexNumber: 2 }] };
const EPISODES = {
  Items: [{
    Id: 'E1', SeriesName: 'The Boys', ParentIndexNumber: 1, IndexNumber: 1, Name: 'Pilot',
    MediaSources: [{ Path: '/tv/a.mkv', Size: 1000, Container: 'mkv' }],
  }],
};

function makeCtx(routes = { '/Items': SERIES, '/Seasons': SEASONS, '/Episodes': EPISODES }) {
  const reacted = [], notes = [], queued = [];
  globalThis.fetch = async (url) => {
    // Longest pattern first, so '/Shows/x/Episodes' does not match '/Items'.
    const keys = Object.keys(routes).sort((a, b) => b.length - a.length);
    for (const k of keys) {
      if (String(url).includes(k)) return { ok: true, status: 200, json: async () => routes[k] };
    }
    return { ok: false, status: 404, statusText: 'NF', json: async () => ({}) };
  };
  const store = new Map();
  return {
    reacted, notes, queued, store,
    ctx: {
      config: {
        tvRequests: { enabled: true, requestGroups: [TVREQ], postsGroups: ['p@g.us'], cooldownSecondsPerUser: 0 },
        movieRequests: {
          reactions: { researching: '🔍', added: '🎬', needYear: '📅', notInLibrary: '📬', rated: '⛔', failed: '⚠️', done: '✅' },
          notify: { group: 'notif@g.us' },
        },
        library: { jellyfin: { baseUrl: 'http://jf:8096', accessToken: 'TOK', userId: 'U1' } },
        media: { workDir: '/tmp/tvmiss' },
      },
      bot: {
        react: async (m, e) => { reacted.push(e); },
        isConnected: () => true,
        sendText: async (j, t) => { notes.push(t); return { key: { id: 'X' } }; },
        isGroupAdmin: () => false,
        deleteMessage: async () => {},
        archiveChat: async () => {},
      },
      queue: { add: (j) => { queued.push(j); return j.label; } },
      store: { get: (k, d) => (store.has(k) ? store.get(k) : d), set: (k, v) => store.set(k, v) },
      log: { info() {}, warn() {}, error() {}, debug() {} },
    },
  };
}

const mkMsg = (text) => ({
  text, chatJid: TVREQ, isGroup: true, fromMe: false, messageType: 'conversation',
  senderJid: 'u@lid', senderNumber: '15551112222', senderNumberDisplay: '+1 555 111 2222',
  pushName: 'Avi', id: 'MSG1', timestamp: Date.now(),
});

console.log('=== a show that is not there is recorded ===');
{
  const { ctx, reacted, store } = makeCtx({ '/Items': { Items: [] } });
  await plugin.onMessage(mkMsg('Kitchen Nightmares S01E01'), ctx);

  ok(reacted.includes('📬'), 'the requester still gets the not-in-library reaction');
  const misses = listMisses({ get: (k, d) => (store.has(k) ? store.get(k) : d), set: () => {} });
  ok(misses.length === 1, 'and a miss is written, where it used to write nothing at all');
  ok(misses[0].kind === 'tv', 'marked as TV');
  ok(misses[0].reason === 'not-in-library', 'as a genuine miss');
  ok(misses[0].request === 'Kitchen Nightmares S01E01', 'with what was actually typed');
  ok(misses[0].requesters.includes('Avi'), 'and who asked');
  ok(misses[0].groupJid === TVREQ, 'and which group, so it can be traced');
}

console.log('=== an empty season is recorded as its own thing, and said out loud ===');
{
  const { ctx, reacted, notes, store } = makeCtx({
    '/Items': SERIES, '/Seasons': SEASONS, '/Episodes': { Items: [] },
  });
  await plugin.onMessage(mkMsg('The Boys season 9'), ctx);

  ok(reacted.includes('📬'), 'reaction unchanged');
  const misses = listMisses({ get: (k, d) => (store.has(k) ? store.get(k) : d), set: () => {} });
  ok(misses[0]?.reason === 'empty-season', 'distinguished from a missing show');
  ok(misses[0]?.title === 'The Boys', 'the show it DID find is named');
  ok(misses[0]?.season === 9, 'with the season asked for');
  // Previously the requester could not tell "ask for season 2 instead" from
  // "we have never heard of this show".
  ok(notes.some((n) => /don't have/.test(n) && /1, 2/.test(n)),
    'and they are told which seasons the server does have');
}

console.log('=== a missing episode is recorded too ===');
{
  const { ctx, store } = makeCtx({
    '/Items': SERIES, '/Seasons': SEASONS, '/Episodes': EPISODES,
  });
  await plugin.onMessage(mkMsg('The Boys S01E99'), ctx);

  const misses = listMisses({ get: (k, d) => (store.has(k) ? store.get(k) : d), set: () => {} });
  ok(misses[0]?.reason === 'no-such-episode', 'recorded as a missing episode');
  ok(misses[0]?.episode === 99, 'with the episode number');
}

console.log('=== a request that succeeds records no miss ===');
{
  const { ctx, queued, store } = makeCtx();
  await plugin.onMessage(mkMsg('The Boys S01E01'), ctx);

  ok(queued.length === 1, 'it queued');
  const misses = listMisses({ get: (k, d) => (store.has(k) ? store.get(k) : d), set: () => {} });
  ok(misses.length === 0, 'and nothing was logged as a fault');
}

console.log('=== courtesy words do not cost you the show ===');
{
  // The movie path has always stripped these before searching; the TV path
  // never did, and it mattered more here - the show name goes straight to
  // Jellyfin as a searchTerm and then to a 0.72 similarity threshold.
  const asked = [];
  const routes = { '/Items': SERIES, '/Seasons': SEASONS, '/Episodes': EPISODES };
  const { ctx } = makeCtx(routes);
  const inner = globalThis.fetch;
  globalThis.fetch = async (url) => { asked.push(String(url)); return inner(url); };

  await plugin.onMessage(mkMsg('The Boys season 1 please'), ctx);
  const search = asked.find((u) => u.includes('searchTerm'));
  ok(search && !/please/i.test(decodeURIComponent(search)),
    'the courtesy word never reaches Jellyfin');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
