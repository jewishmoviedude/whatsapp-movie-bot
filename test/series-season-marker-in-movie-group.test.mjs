/* A show asked for with a season marker in the movie group is pointed at TV.
   Run: node test/series-season-marker-in-movie-group.test.mjs

   Incident, 2026-10-11 01:42 New York: Joey asked "smiling friends S01" in
   the movie requests group. OMDb has no film by that name, so the request
   ended at "no matching film" (❓, "not recognised") without the series check
   ever running - it ran only for a request OMDb had resolved to some film.
   Smiling Friends (2020) is in the library. A request nothing resolves now
   gets the series check too, with the season marker taken off, and the
   member is told it is a TV series. A name that is neither stays not-found. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import moviePlugin from '../src/plugins/movie-requests/index.js';
import { DEFAULT_CONFIG, mergeDefaults } from '../src/config/schema.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const REQ = 'movie-requests@g.us';
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const SERIES = [{ Id: '00000000000000000000000000000001', Name: 'Smiling Friends', ProductionYear: 2020, OfficialRating: 'TV-MA', Type: 'Series', RecursiveItemCount: 10 }];

globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  const json = (v) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
  if (u.hostname === 'www.omdbapi.com') return json({ Response: 'False', Error: 'Movie not found!' });
  if (u.hostname === 'jf.test' && u.pathname === '/Items') {
    const term = u.searchParams.get('searchTerm');
    if (u.searchParams.get('IncludeItemTypes') === 'Series') {
      const items = SERIES.filter((i) => !term || norm(i.Name).includes(norm(term)));
      return json({ Items: items, TotalRecordCount: items.length });
    }
    return json({ Items: [], TotalRecordCount: 0 });
  }
  if (u.hostname === 'jf.test') return json({ Items: [], SearchHints: [], TotalRecordCount: 0 });
  return new Response('{}', { status: 404 });
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'series-marker-'));
function harness() {
  const out = [];
  const data = {};
  const c = mergeDefaults({
    movieRequests: {
      requestGroups: [REQ], postsGroup: 'p@g.us', notify: { group: 'n@g.us' },
      requirePrefix: true, prefix: '#request', cooldownSecondsPerUser: 0, replyOnBlock: true,
    },
  }, DEFAULT_CONFIG);
  c.omdb.apiKey = 'test-key';
  c.gemini = { ...c.gemini, enabled: false };
  c.library = mergeDefaults({ provider: 'jellyfin', jellyfin: { baseUrl: 'http://jf.test', authMethod: 'apikey', apiKey: 'KEY', accessToken: 'TOK', userId: 'U1' } }, DEFAULT_CONFIG.library);
  Object.assign(c.media, { workDir: TMP });
  const s = {
    data,
    get: (k, d = null) => (k in data ? data[k] : d),
    set: (k, v) => { data[k] = v; },
    push: (k, v) => { (data[k] ??= []).unshift(v); },
  };
  const ctx = {
    config: c, store: s,
    bot: {
      isConnected: () => true,
      react: async (m, emoji) => { out.push({ op: 'react', emoji }); return true; },
      sendText: async (jid, body) => { out.push({ op: 'text', jid, body }); return { key: { id: 'B' } }; },
      editText: async () => true, deleteMessage: async () => {}, archiveChat: async () => {},
      isGroupAdmin: () => false,
      groupMemberInfo: () => ({ isMember: false, mentionJid: null, mentionText: null }),
      groups: () => [], groupCache: new Map(), sameCommunity: () => false,
      groupMentionToken: (jid) => `@${jid.split('@')[0]}`,
      async _bulkPace() {}, on() {}, off() {},
    },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    configStore: { update() {} },
    queue: { maxLength: 50, pending: [], add: () => 'job-1', snapshot: () => ({ pending: [], active: [] }) },
  };
  return { ctx, out, s };
}

moviePlugin._reactors = new Map();
let seq = 0;
async function request(h, text) {
  const id = `M${++seq}`;
  await moviePlugin.onMessage({
    id, key: { id, remoteJid: REQ, participant: 'joey@lid', fromMe: false }, text: `#request ${text}`, chatJid: REQ,
    isGroup: true, fromMe: false, messageType: 'conversation', senderJid: 'joey@lid', senderNumber: '15550000002',
    senderNumberDisplay: '+15550000002', pushName: 'Joey', timestamp: Date.now(), raw: { key: { id } },
  }, h.ctx);
  await new Promise((r) => setTimeout(r, 20));
  return (h.s.get('history', []) ?? []).find((r) => r.id === id);
}
const replies = (h) => h.out.filter((o) => o.op === 'text' && o.jid === REQ).map((o) => o.body);

console.log('=== "smiling friends S01" in the movie group ===');
for (const text of ['smiling friends S01', 'smiling friends season 1', 'smiling friends']) {
  const h = harness();
  const row = await request(h, text);
  ok(row?.status === 'is-a-series', `"${text}" is pointed at the TV group (${row?.status})`);
  ok(replies(h).some((t) => /Smiling Friends\* is a TV series/.test(t)), 'and the member is told which series it is');
}
{
  const h = harness();
  const row = await request(h, 'qwzx plorb S01');
  ok(row?.status === 'not-found', `a show the library lacks is still not-found (${row?.status})`);
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
