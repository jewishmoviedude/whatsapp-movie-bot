/* The request defaults: 10 episodes a request, 1 season a message, and an
   hour's cooldown for films and TV - the operator's (2026-10-12): "change
   repo that it should be 10 episodes, 1 season, 900 secs cooldown by
   default", then "in repo by default 1 season max 10 espidoes and 1 hour
   cooldown for both movies and shows". With no cap, The Flash season 2
   queued all 23 episodes in one request. And the film request rules are the
   operator's own export. Run: node test/request-rule-defaults.test.mjs */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG } from '../src/config/schema.js';
import { ConfigStore } from '../src/config/store.js';
import plugin from '../src/plugins/tv-requests/index.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

console.log('=== the film request rules: the operator\'s export, request-rules-2026-10-12-1700.csv ===');
{
  // "set what I currently have as request-rules-2026-10-12-1700.csv as
  // default" (2026-10-12): Settings -> Movies -> Request rules, row by row.
  // Its one other row, a rated-R override for "rick and morty s08", is the
  // operator's own list, not a default.
  const m = DEFAULT_CONFIG.movieRequests;
  ok(m.blockedRatings.join(', ') === 'R, NC-17, X, TV-MA', 'Blocked ratings: R, NC-17, X, TV-MA');
  ok(m.requirePrefix === true && m.prefix === '#request', 'only messages starting with #request');
  ok(m.requireYearWhenAmbiguous === true, 'ask which one when several films share a title');
  ok(m.replyOnBlock === true, 'also send a text reply when blocking');
  ok(m.maxQueueLength === 0, 'Max queue length 0 - no limit (queue-length-zero-means-no-limit)');
  ok(m.cooldownSecondsPerUser === 3600 && m.cooldownOnlyWhenOthersWait === true,
    'an hour\'s cooldown, skipped while nobody else is waiting');
  const r = m.reactions;
  const csv = {
    researching: '🔍', added: '🎬', duplicate: '🤥', downloading: '⬇️', converting: '⚙️', sending: '⬆️', done: '✅',
    positionOverflow: '🔢', rated: '⛔', theaters: '🎪', notFound: '❓', needYear: '📅', notInLibrary: '📬',
    failed: '⚠️', skipped: '⏭️',
  };
  const off = Object.entries(csv).filter(([k, v]) => r[k] !== v).map(([k]) => k);
  ok(!off.length, `every reaction as exported${off.length ? ` - differs: ${off.join(', ')}` : ''}`);
  ok(r.positions.join(', ') === '1️⃣, 2️⃣, 3️⃣, 4️⃣, 5️⃣, 6️⃣, 7️⃣, 8️⃣, 9️⃣, 🔟', 'the place-in-line numbers 1️⃣ to 🔟');
}

console.log('=== the defaults ===');
{
  const tv = DEFAULT_CONFIG.tvRequests;
  ok(tv.maxEpisodesPerRequest === 10, 'at most 10 episodes a request');
  ok(tv.maxSeasonsPerRequest === 1, 'at most 1 season a message');
  ok(tv.cooldownSecondsPerUser === 3600, 'an hour\'s cooldown for TV');
  ok(DEFAULT_CONFIG.movieRequests.cooldownSecondsPerUser === 3600, 'and for films');
}

console.log('=== an install with no TV limits saved gets them ===');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-defaults-'));
  try {
    // Saved before the limits had defaults worth keeping: only the groups.
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      tvRequests: { enabled: true, requestGroups: ['tvreq@g.us'], postsGroups: ['p@g.us'] },
      media: { workDir: path.join(dir, 'media') },
    }));
    const cfg = new ConfigStore({ dataDir: dir, masterKey: 'k'.repeat(64) }).load();
    ok(cfg.tvRequests.maxEpisodesPerRequest === 10 && cfg.tvRequests.maxSeasonsPerRequest === 1
      && cfg.tvRequests.cooldownSecondsPerUser === 3600 && cfg.movieRequests.cooldownSecondsPerUser === 3600,
      'the defaults fill in what was never saved');
    ok(cfg.tvRequests.requestGroups.join() === 'tvreq@g.us', 'and what was saved stays');
    // A choice saved in the panel stays the operator's, 0 (no limit) too.
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      tvRequests: { maxEpisodesPerRequest: 0, maxSeasonsPerRequest: 3, cooldownSecondsPerUser: 30 },
      movieRequests: { cooldownSecondsPerUser: 30 },
      media: { workDir: path.join(dir, 'media') },
    }));
    const kept = new ConfigStore({ dataDir: dir, masterKey: 'k'.repeat(64) }).load();
    ok(kept.tvRequests.maxEpisodesPerRequest === 0 && kept.tvRequests.maxSeasonsPerRequest === 3
      && kept.tvRequests.cooldownSecondsPerUser === 30 && kept.movieRequests.cooldownSecondsPerUser === 30,
      'a saved setting is never overridden by the default');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

console.log('=== with the defaults, a 23-episode season queues 10 and "seasons 1-2" one season ===');
{
  const season = (n) => Array.from({ length: 23 }, (_, i) => ({
    Id: `S${n}E${i + 1}`, SeriesName: 'The Flash', ParentIndexNumber: n, IndexNumber: i + 1, Name: `Ep ${i + 1}`,
    MediaSources: [{ Path: `/f/s${n}e${i + 1}.mkv`, Size: 1 }],
  }));
  const routes = {
    '/Items': { Items: [{ Id: 'SER', Name: 'The Flash', ProductionYear: 2014 }] },
    '/Seasons': { Items: [{ Id: 'S1', IndexNumber: 1, ChildCount: 23 }, { Id: 'S2', IndexNumber: 2, ChildCount: 23 }] },
  };
  globalThis.fetch = async (url) => {
    const u = String(url);
    // Each season's own episodes, by the season the lookup names.
    if (u.includes('/Episodes')) {
      const n = Number(new URL(u).searchParams.get('season') ?? 1);
      return { ok: true, status: 200, json: async () => ({ Items: season(n) }) };
    }
    for (const [k, v] of Object.entries(routes)) if (u.includes(k)) return { ok: true, status: 200, json: async () => v };
    return { ok: false, status: 404, statusText: 'NF', json: async () => ({}) };
  };
  const run = async (text) => {
    const queued = [], store = new Map();
    const ctx = {
      config: {
        tvRequests: { ...structuredClone(DEFAULT_CONFIG.tvRequests), enabled: true, requestGroups: ['tvreq@g.us'], postsGroups: ['p@g.us'], blockedRatings: [] },
        movieRequests: { reactions: { researching: '🔍', added: '🎬', needYear: '📅', notInLibrary: '📬', rated: '⛔', failed: '⚠️', done: '✅' }, notify: { group: 'notif@g.us' } },
        library: { jellyfin: { baseUrl: 'http://jf:8096', accessToken: 'TOK', userId: 'U1' } },
        media: { workDir: '/tmp/tv-defaults-test' },
      },
      bot: {
        react: async () => {}, isConnected: () => true, sendText: async () => ({ key: { id: 'X' } }),
        isGroupAdmin: () => false, deleteMessage: async () => {}, archiveChat: async () => {}, _bulkPace: async () => {},
      },
      queue: { add: (j) => { queued.push(j); return j.label; } },
      store: { get: (k, d) => (store.has(k) ? store.get(k) : d), set: (k, v) => store.set(k, v) },
      log: { info() {}, warn() {}, error() {}, debug() {} },
    };
    await plugin.onMessage({
      id: 'M1', text, chatJid: 'tvreq@g.us', isGroup: true, fromMe: false, messageType: 'conversation',
      senderJid: 'u@lid', senderNumber: '15551112222', senderNumberDisplay: '+1 555 111 2222',
    }, ctx);
    return queued;
  };
  // With the #request prefix the TV groups need by default since 2026-10-12
  // (live-settings-defaults); without it the message is not a request.
  const one = await run('#request The Flash season 2');
  ok(one.length === 10, `season 2 queues 10 of its 23 episodes (queued ${one.length})`);
  ok(one[0]?.label === 'The Flash S02E01' && one[9]?.label === 'The Flash S02E10', 'the first ten, in order');
  const two = await run('#request The Flash seasons 1-2');
  const seasons = [...new Set(two.map((j) => j.label.match(/S(\d+)E/)?.[1]))];
  ok(seasons.join() === '01' && two.length === 10, `"seasons 1-2" queues season 1 alone, 10 episodes (queued ${two.length} from season(s) ${seasons.join(', ') || 'none'})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
