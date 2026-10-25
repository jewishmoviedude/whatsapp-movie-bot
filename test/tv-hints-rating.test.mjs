/* A TV-MA series found through Search/Hints is still refused.
   Run: node test/tv-hints-rating.test.mjs

   findSeries() tries the plain /Items search first, then /Search/Hints - the
   endpoint the Jellyfin web UI uses - for shows the plain search cannot see.
   A search hint carries a name, a year and an id, and no OfficialRating, and
   the hints layer returned the show with its rating set to null. The TV
   plugin's series-level gate reads that rating, so it could not fire: a TV-MA
   show found only through Search/Hints went past the ⛔, and a season of it
   whose episodes carry no OfficialRating of their own was queued whole (the
   audit of the TV request path, 2026-09-29). The series is now read back by
   its id with the fields every other layer returns; when that read fails,
   the lookup fails rather than send a show whose rating is unknown. */
import plugin from '../src/plugins/tv-requests/index.js';
import { findSeries } from '../src/plugins/tv-requests/jellyfin-tv.js';
import { bestMatch } from '../src/util/fuzzy.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const settle = () => new Promise((r) => setTimeout(r, 10));

const TVREQ = 'tvreq@g.us';
const NOTIFY = 'notify@g.us';
const OPTS = { base: 'http://jf:8096', token: 'TOK', userId: 'U1', bestMatch };

// Stored under a name the plain search's substring filter cannot reach from
// what members type ("Kitchen Nightmares"), so only /Search/Hints finds it.
const SHOW = { Id: 'KN', Name: 'Kitchen: Nightmares Uncut', ProductionYear: 2007, OfficialRating: 'TV-MA', RecursiveItemCount: 3 };

/**
 * A Jellyfin whose /Items?searchTerm is a plain substring test and whose
 * /Search/Hints is word-aware and returns hints only - no rating. `detail`
 * is what an /Items?Ids= read answers: the series, nothing, or an error.
 */
function jellyfin({ detail = 'ok' } = {}) {
  const seen = [];
  const fetchImpl = async (raw) => {
    const url = new URL(String(raw));
    seen.push(url.pathname + url.search);
    const json = (body) => ({ ok: true, status: 200, json: async () => body });
    if (url.pathname.endsWith('/Search/Hints')) {
      const words = (url.searchParams.get('searchTerm') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      const hit = words.every((w) => SHOW.Name.toLowerCase().includes(w));
      return json({ SearchHints: hit ? [{ ItemId: SHOW.Id, Name: SHOW.Name, ProductionYear: SHOW.ProductionYear }] : [] });
    }
    if (url.pathname.endsWith('/Seasons')) return json({ Items: [{ Id: 'S1', IndexNumber: 1, ChildCount: 3 }] });
    if (url.pathname.endsWith('/Episodes')) {
      // Episodes with no rating of their own: only the series gate can stop them.
      return json({
        Items: [1, 2, 3].map((n) => ({
          Id: `E${n}`, SeriesName: SHOW.Name, ParentIndexNumber: 1, IndexNumber: n, Name: `Ep ${n}`,
          MediaSources: [{ Path: `/tv/kn/${n}.mkv`, Size: 1000 }],
        })),
      });
    }
    if (url.pathname.endsWith('/Items')) {
      if (url.searchParams.get('Ids')) {
        if (detail === 'error') return { ok: false, status: 500, statusText: 'Server Error', json: async () => ({}) };
        return json({ Items: detail === 'ok' ? [SHOW] : [] });
      }
      const term = (url.searchParams.get('searchTerm') ?? '').toLowerCase();
      if (term) return json({ Items: SHOW.Name.toLowerCase().includes(term) ? [SHOW] : [] });
      return json({ Items: [], TotalRecordCount: 0 });
    }
    return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) };
  };
  return { fetchImpl, seen };
}

console.log('=== findSeries: a show found through Search/Hints comes back with its rating ===');
{
  const { fetchImpl, seen } = jellyfin();
  const s = await findSeries('Kitchen Nightmares', { ...OPTS, fetchImpl });
  ok(s?.id === 'KN' && s.via === 'hints', `found through Search/Hints (${s?.via})`);
  ok(s?.rating === 'TV-MA', `with its OfficialRating, not null (${s?.rating})`);
  ok(s?.ids === null || typeof s?.ids === 'object', 'shaped like every other layer');
  ok(seen.some((u) => /\/Items\?Ids=KN/.test(u) && /OfficialRating/.test(decodeURIComponent(u)) && /UserId=U1/.test(u)),
    'by reading the series back by its id, with the rating field, as the bot\'s own user');
}

console.log('=== ...and when the series cannot be read back, nothing is returned as unrated ===');
{
  const { fetchImpl } = jellyfin({ detail: 'error' });
  let threw = null;
  try { await findSeries('Kitchen Nightmares', { ...OPTS, fetchImpl }); } catch (err) { threw = err; }
  ok(!!threw, `a failed read fails the lookup (${threw?.message})`);

  const notes = [];
  const { fetchImpl: f2 } = jellyfin({ detail: 'none' });
  const s = await findSeries('Kitchen Nightmares', { ...OPTS, fetchImpl: f2, onDiagnostic: (m) => notes.push(m) });
  ok(s === null || s.rating === 'TV-MA', `a read that finds nothing is not taken for an unrated show (${s?.via ?? 'null'})`);
  ok(notes.some((n) => /cannot read that series/.test(n)), 'and the log says why');
}

function harness() {
  const reacted = [], texts = [], jobs = [];
  const store = new Map();
  const ctx = {
    config: {
      tvRequests: {
        enabled: true, requestGroups: [TVREQ], postsGroups: ['tvposts@g.us'], cooldownSecondsPerUser: 0,
        blockedRatings: ['TV-MA', 'R', 'NC-17', 'X'],
      },
      movieRequests: {
        requestGroups: [],
        reactions: { researching: '🔍', added: '🎬', rated: '⛔', notInLibrary: '📬', failed: '⚠️', done: '✅' },
        notify: { group: NOTIFY },
      },
      beta: { groups: [], postsGroup: '', features: {} },
      library: { jellyfin: { baseUrl: 'http://jf:8096', accessToken: 'TOK', userId: 'U1' } },
      media: { workDir: '/tmp/tv-hints-rating' },
    },
    bot: {
      isConnected: () => true,
      react: async (m, e) => { reacted.push(e); return true; },
      sendText: async (jid, body) => { texts.push({ jid, body }); return { key: { id: 'X' } }; },
      isGroupAdmin: () => false,
      deleteMessage: async () => {},
      archiveChat: async () => {},
    },
    queue: { maxLength: 50, pending: [], add: (j) => { jobs.push(j); return `job-${jobs.length}`; } },
    store: { get: (k, d) => (store.has(k) ? store.get(k) : d), set: (k, v) => store.set(k, v) },
    log: { info() {}, warn() {}, error() {}, debug() {} },
  };
  return { ctx, reacted, texts, jobs, store };
}
const mkMsg = (text) => ({
  id: `M${Math.random().toString(16).slice(2, 8)}`, key: { id: 'k' }, text, chatJid: TVREQ, isGroup: true, fromMe: false,
  messageType: 'conversation', senderJid: 'ari@lid', senderNumber: '15551112222', pushName: 'Ari', timestamp: Date.now(),
});

console.log('=== a TV-MA series found through Search/Hints is still refused ===');
{
  const { fetchImpl } = jellyfin();
  globalThis.fetch = fetchImpl;
  const h = harness();
  await plugin.onMessage(mkMsg('Kitchen Nightmares season 1'), h.ctx);
  await settle();
  ok(h.jobs.length === 0, `nothing is queued (${h.jobs.length} episode(s))`);
  ok(h.reacted.includes('⛔') && !h.reacted.includes('🎬'), `the request gets ⛔, not 🎬 (${h.reacted.join(' ')})`);
  const row = (h.store.get('history') ?? [])[0];
  ok(row?.status === 'blocked-rating' && row.rated === 'TV-MA', `History says it was refused on its rating (${row?.status}, ${row?.rated})`);
  await plugin.teardown();
}

console.log('=== ...and one whose rating cannot be read is not queued either ===');
{
  const { fetchImpl } = jellyfin({ detail: 'error' });
  globalThis.fetch = fetchImpl;
  const h = harness();
  await plugin.onMessage(mkMsg('Kitchen Nightmares season 1'), h.ctx);
  await settle();
  ok(h.jobs.length === 0, 'nothing is queued');
  ok(h.reacted.includes('⚠️'), `the requester is told something went wrong, to ask again (${h.reacted.join(' ')})`);
  await plugin.teardown();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
