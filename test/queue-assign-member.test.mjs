/* A job queued by hand on the panel can be assigned to a member.
   Run: node test/queue-assign-member.test.mjs

   The operator (2026-09-30): "When i manually put an item in the queue I
   should have the option to assign it to a member". Until then every job
   queued from the panel - a title, a Jellyfin link, a public link, a TV
   season - was History's "manual (admin)" or "panel (<admin>)", with no one
   to tag in the notifications group. These tests pin that an assigned job
   carries the member everywhere a request from a group carries its sender,
   keeps the admin who queued it beside them, and that one not assigned is
   exactly what it was. */
import './fixtures/roomy-disk.mjs';
import fs from 'node:fs';
import { assignedMember, panelRequester, formatPhone } from '../src/core/members.js';
import moviePlugin from '../src/plugins/movie-requests/index.js';
import tvPlugin from '../src/plugins/tv-requests/index.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const ROSTER = [
  { key: 'num:15558070190', id: '10000000000007@lid', number: '15558070190', name: 'Abby' },
  { key: 'lid:999@lid', id: '999@lid', number: null, name: null },
];

console.log('=== picking a member from the roster ===');
{
  const m = assignedMember(ROSTER, 'num:15558070190');
  ok(m.name === 'Abby' && m.number === '15558070190', 'the name and number come from the roster');
  // +digits since 2026-10-01 (test/phone-format.test.mjs).
  ok(m.display === '+15558070190', `the number is shown as a request's is: ${m.display}`);
  ok(m.jid === '10000000000007@lid', 'the jid is the one the groups know them by');
  ok(assignedMember(ROSTER, '') === null && assignedMember(ROSTER, null) === null, 'no pick is no member');
  const bare = assignedMember(ROSTER, 'lid:999@lid');
  ok(bare.name === '999' && bare.number === null, 'a member with neither name nor number is named by their id');
  let threw = null;
  try { assignedMember(ROSTER, 'num:15550000000'); } catch (e) { threw = e; }
  ok(/not in any of the bot's groups/.test(threw?.message ?? ''), 'a key off the roster is refused, not trusted');
  ok(formatPhone('447700900123') === '+447700900123', 'formatPhone lives in members.js');
}

console.log('=== the requester fields ===');
{
  const none = panelRequester('panel (mommy)', null);
  ok(none.requester === 'panel (mommy)' && none.requesterNumber === null && !('assignedBy' in none),
    'not assigned: the panel label, as before');
  const who = panelRequester('panel (mommy)', assignedMember(ROSTER, 'num:15558070190'));
  ok(who.requester === 'Abby' && who.requesterNumber === '15558070190'
    && who.requesterNumberDisplay === '+15558070190' && who.requesterJid === '10000000000007@lid',
  'assigned: the member, in the fields a group request fills');
  ok(who.assignedBy === 'panel (mommy)', 'and the admin who queued it is kept');
}

const member = assignedMember(ROSTER, 'num:15558070190');

function movieCtx() {
  const added = [];
  const sent = [];
  const store = (() => { const m = {}; return { get: (k, d) => (k in m ? m[k] : d), set: (k, v) => { m[k] = v; } }; })();
  return {
    added, sent, store,
    ctx: {
      config: {
        movieRequests: {
          postsGroup: 'posts@g.us', blockedRatings: ['R'], reactions: {},
          notify: { group: 'notify@g.us', tagRequester: true },
        },
        media: {},
      },
      log: { info() {}, warn() {}, debug() {} },
      store,
      queue: { add: (j) => added.push(j) },
      bot: {
        isConnected: () => true,
        groupMemberInfo: (g, { number }) => ({ isMember: g === 'notify@g.us', mentionJid: `${number}@s.whatsapp.net`, mentionText: number }),
        sendText: async (to, body, opts) => { sent.push({ to, body, opts }); },
      },
    },
  };
}
const ITEM = { id: '39b452edcb8e1db19bb78cf69764ab4b', title: 'F1', year: 2025, rated: 'PG-13', downloadUrl: 'https://srv/x', headers: {} };

console.log('=== a Jellyfin link queued for a member ===');
{
  const { ctx, added, sent, store } = movieCtx();
  await moviePlugin.queueLibraryItem(ITEM, ctx, { requester: 'panel (mommy)', member });
  await new Promise((r) => setImmediate(r));
  const row = (store.get('history', []) ?? []).find((h) => h.title === 'F1');
  ok(row?.requester === 'Abby' && row?.requesterNumber === '15558070190', 'History names the member');
  ok(row?.assignedBy === 'panel (mommy)', 'and who assigned it');
  ok(added[0]?.meta.requester === 'Abby' && added[0]?.meta.requesterNumber === '+15558070190',
    'the queue shows the member and their number');
  ok(added[0]?.meta.assigned === true, 'marked assigned, so Clear waiting does not promise them a ❌');
  const pend = (store.get('pending', []) ?? [])[0];
  ok(pend?.record?.requesterNumber === '15558070190', 'the journal keeps the member, so a restart does too');
  ok(sent.length === 1 && sent[0].to === 'notify@g.us' && /F1 \(2025\) — added to the queue/.test(sent[0].body),
    'the notifications group is told it was added');
  ok(sent[0]?.opts?.mentions?.[0] === '15558070190@s.whatsapp.net', 'with the member tagged');
}

console.log('=== the same link, not assigned, is what it was ===');
{
  const { ctx, added, sent, store } = movieCtx();
  await moviePlugin.queueLibraryItem(ITEM, ctx, { requester: 'panel (mommy)' });
  await new Promise((r) => setImmediate(r));
  const row = (store.get('history', []) ?? []).find((h) => h.title === 'F1');
  ok(row?.requester === 'panel (mommy)' && row?.requesterNumber === null && !row?.assignedBy, 'History says the panel');
  ok(added[0]?.meta.requester === 'panel (mommy)' && !added[0]?.meta.assigned, 'the queue too');
  ok(sent.length === 0, 'and nothing is posted, as a hand-queued job never was');
}

console.log('=== a TV season queued for a member ===');
{
  const SERIES = { Items: [{ Id: 'S1', Name: 'Rick and Morty', ProductionYear: 2013, OfficialRating: 'TV-14' }] };
  const SEASONS = { Items: [{ Id: 'X', IndexNumber: 4 }] };
  const EPISODES = { Items: [
    { Id: 'E1', SeriesName: 'Rick and Morty', ParentIndexNumber: 4, IndexNumber: 1, Name: 'A', MediaSources: [{ Path: '/a.mkv' }] },
  ] };
  globalThis.fetch = async (url) => {
    for (const [k, v] of Object.entries({ '/Items': SERIES, '/Seasons': SEASONS, '/Episodes': EPISODES })) {
      if (String(url).includes(k)) return { ok: true, status: 200, json: async () => v };
    }
    return { ok: false, status: 404, statusText: 'NF', json: async () => ({}) };
  };
  const queued = [];
  const m = {};
  const ctx = {
    config: {
      tvRequests: { enabled: true, postsGroups: ['posts@g.us'], blockedRatings: ['TV-MA'] },
      movieRequests: { reactions: {} },
      library: { jellyfin: { baseUrl: 'http://jf:8096', accessToken: 'T', userId: 'U' } },
      media: { workDir: '/tmp/x' },
    },
    queue: { add: (j) => queued.push(j) },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    bot: { isConnected: () => true, sendText: async () => ({}) },
    store: { get: (k, d) => (k in m ? m[k] : d), set: (k, v) => { m[k] = v; } },
  };
  await tvPlugin.requeue('rick and morty season 4', ctx, { member });
  const row = Object.values(m).flat().find((h) => h?.kind === 'tv' && h?.title === 'Rick and Morty');
  ok(row?.requester === 'Abby' && row?.assignedBy === 'manual (admin)', 'History names the member, and who assigned it');
  ok(queued[0]?.meta.requester === 'Abby' && queued[0]?.meta.assigned === true, 'the queue shows the member');
}

console.log('=== the panel and the routes ===');
{
  const api = fs.readFileSync(new URL('../src/web/api.js', import.meta.url), 'utf8');
  for (const route of ['/requeue', '/queue/from-url', '/queue/public-link']) {
    const block = api.match(new RegExp(`router\\.post\\('${route.replace(/\//g, '\\/')}'[\\s\\S]*?\\n  \\}\\);`))[0];
    ok(/memberFor\(req\)/.test(block) && /member\b[^]*requeue|member \}|member,|member\)/.test(block),
      `${route} resolves the picked member and passes it on`);
  }
  const html = fs.readFileSync(new URL('../src/web/public/index.html', import.meta.url), 'utf8');
  ok(/id="q-member"[^>]*list="q-member-list"/.test(html) && /id="pl-member"[^>]*list="q-member-list"/.test(html),
    'both queue boxes have a member picker');
  const app = fs.readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
  ok((app.match(/memberKeyFrom\('(q|pl)-member'\)/g) ?? []).length === 3, 'all three queue buttons send the pick');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
