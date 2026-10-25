/* The direct-links group: URLs instead of files.
   Run: node test/direct-links.test.mjs */
import fs from 'node:fs';
import { parseLinkCommand, isLinkCommand } from '../src/plugins/direct-links/parse.js';
import { movieMessage, seasonMessages, streamUrl, isRestricted, disclaimerLine } from '../src/plugins/direct-links/format.js';
import plugin from '../src/plugins/direct-links/index.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

console.log('=== the commands from the group description ===');
{
  const m = parseLinkCommand('#request-movie The Truman Show 1998');
  ok(m?.kind === 'movie' && m.title === 'The Truman Show' && m.year === 1998, '"#request-movie name year"');
  const t = parseLinkCommand('#request-tv The Boys S01');
  ok(t?.kind === 'tv' && t.title === 'The Boys' && t.season === 1, '"#request-tv name S01"');
  const e = parseLinkCommand('#request-tv The Boys S01E03');
  ok(e?.episode === 3, 'a single episode is understood too');
  // A list is those episodes (2026-10-12), not the first of them alone.
  const l = parseLinkCommand('#request-tv The Boys S01E03, E07');
  ok(l?.season === 1 && l.episode === null && l.episodeList?.join() === '3,7', `a list of episodes is passed on whole (${l?.episodeList})`);
  ok(parseLinkCommand('#request-movie Dune')?.year === null, 'a movie without a year still parses');
  ok(parseLinkCommand('#request-tv Rick and Morty season 4')?.season === 4, '"season 4" wording works');
}

console.log('=== these commands do not collide with the file requests ===');
{
  ok(parseLinkCommand('#request Dune 2021') === null, '"#request" (files) is NOT a links command');
  ok(parseLinkCommand('hello') === null, 'chatter is ignored');
  ok(parseLinkCommand('') === null, 'empty is safe');
  ok(parseLinkCommand(null) === null, 'null is safe');
  // "#request-movie" also begins with "#request", so ordering matters
  ok(parseLinkCommand('#request-movie X', { movieCommand: '#request-movie', tvCommand: '#request' })?.kind === 'movie',
    'the longer command wins when one is a prefix of the other');
  ok(parseLinkCommand('#request-movie')?.empty === true, 'the bare command asks for a title rather than erroring');
  ok(isLinkCommand('#request-tv The Boys S01') === true, 'isLinkCommand agrees');
}

console.log('=== ratings are NOT blocked here, only flagged ===');
{
  ok(isRestricted('R') && isRestricted('TV-MA') && isRestricted('nc-17'), 'restricted ratings recognised, case-insensitively');
  ok(!isRestricted('PG-13') && !isRestricted('') && !isRestricted(null), 'ordinary ratings are not flagged');

  const r = movieMessage({ title: 'Some Film', year: 2015, rating: 'R', url: 'https://x/1' });
  ok(r.includes('https://x/1'), 'an R-rated title still gets its link — nothing is blocked');
  ok(/⚠️ \*Rated R\*/.test(r), 'and carries the disclaimer');
  ok(r.indexOf('Rated R') < r.indexOf('https://x/1'), 'the warning comes BEFORE the link, not after it');

  const clean = movieMessage({ title: 'Family Film', year: 2010, rating: 'PG', url: 'https://x/2' });
  ok(!clean.includes('⚠️'), 'an unrestricted title gets no warning');

  const custom = disclaimerLine('R', 'House rules apply.');
  ok(custom.includes('House rules apply.'), 'a configured disclaimer is used');
  ok(disclaimerLine('R', '').length > 30, 'and a sensible default when blank');
}

console.log('=== a 15-episode season is ONE message ===');
{
  const eps = Array.from({ length: 15 }, (_, i) => ({
    season: 1, episode: i + 1, title: `Episode ${i + 1}`, url: `https://x/${i}`,
  }));
  const msgs = seasonMessages({ series: 'The Boys', season: 1, episodes: eps, rating: 'TV-MA' });
  ok(msgs.length === 1, `fifteen episodes in one message, not fifteen (got ${msgs.length})`);
  ok((msgs[0].match(/https:\/\/x\//g) ?? []).length === 15, 'every episode link is present');
  ok(/S01E01/.test(msgs[0]) && /S01E15/.test(msgs[0]), 'episodes are labelled');
  ok(/⚠️ \*Rated TV-MA\*/.test(msgs[0]), 'the season disclaimer appears once, at the top');
  ok((msgs[0].match(/⚠️/g) ?? []).length === 1, 'and only once — not per episode');
  ok(/15 episodes/.test(msgs[0]), 'the header says how many');
}

console.log('=== an enormous season splits rather than being dropped ===');
{
  const many = Array.from({ length: 120 }, (_, i) => ({
    season: 1, episode: i + 1, title: 'A fairly long episode title here', url: `https://example.org/Items/${'x'.repeat(30)}${i}/Download?api_key=${'k'.repeat(30)}`,
  }));
  const msgs = seasonMessages({ series: 'Long Show', season: 1, episodes: many });
  ok(msgs.length > 1, 'it splits when it must');
  ok(msgs.every((m) => m.length < 4096), 'no part exceeds what WhatsApp will carry');
  const total = msgs.reduce((n, m) => n + (m.match(/https:\/\//g) ?? []).length, 0);
  ok(total === 120, 'every link survives the split — nothing is silently dropped');
  ok(/\(1 of \d+\)/.test(msgs[0]), 'parts are numbered so nobody wonders if they missed one');
}

console.log('=== the link itself ===');
{
  const u = streamUrl('abc123', { base: 'https://jf.example.org/', apiKey: 'KEY' });
  ok(u === 'https://jf.example.org/Videos/abc123/stream?static=true&api_key=KEY',
    'built from the item id, trailing slash trimmed');
  ok(streamUrl('', { base: 'https://x' }) === null, 'no id -> no link');
  ok(streamUrl('a', {}) === null, 'no base -> no link');
}

console.log('=== the share key is treated as a secret ===');
{
  const schema = fs.readFileSync(new URL('../src/config/schema.js', import.meta.url), 'utf8');
  ok(/'directLinks\.apiKey'/.test(schema), 'encrypted at rest like every other credential');
  // The operator chose to use the Jellyfin account already in Settings, so the
  // fallback is on; a dedicated key still takes precedence when one is set.
  ok(/allowBotKeyFallback: true/.test(schema), 'falls back to the configured Jellyfin account');

  const src = fs.readFileSync(new URL('../src/plugins/direct-links/index.js', import.meta.url), 'utf8');
  ok(/if \(cfg\.apiKey\) return cfg\.apiKey;/.test(src), 'a dedicated key always wins when set');
  ok(/if \(!cfg\.allowBotKeyFallback\) return null;/.test(src), 'and the fallback can still be switched off');
  ok(/an admin needs to add the Jellyfin address and a share key/.test(src), 'says so plainly when unconfigured');
}

console.log('=== the plugin only answers in its own group ===');
{
  const sent = [];
  const ctx = {
    config: {
      directLinks: { enabled: true, groups: ['links@g.us'], apiKey: 'K', movieCommand: '#request-movie', tvCommand: '#request-tv' },
      library: { jellyfin: { baseUrl: 'https://x' } },
    },
    bot: { sendText: async (j, t) => { sent.push(t); return {}; } },
    log: { info() {}, warn() {}, error() {}, debug() {} },
  };
  const mk = (text, chatJid = 'links@g.us') => ({ text, chatJid, isGroup: true, fromMe: false, messageType: 'conversation' });

  await plugin.onMessage(mk('#request-movie X', 'other@g.us'), ctx);
  ok(sent.length === 0, 'a command in another group is ignored');
  await plugin.onMessage({ ...mk('#request-movie X'), fromMe: true }, ctx);
  ok(sent.length === 0, "the bot's own message is ignored");
  await plugin.onMessage(mk('just chatting'), ctx);
  ok(sent.length === 0, 'ordinary chatter is ignored — this group is not moderated');
  await plugin.onMessage(mk('#request-movie'), ctx);
  ok(sent.length === 1 && /#request-movie/.test(sent[0]), 'a bare command explains the format');

  const off = { ...ctx, config: { ...ctx.config, directLinks: { ...ctx.config.directLinks, enabled: false } } };
  sent.length = 0;
  await plugin.onMessage(mk('#request-movie X'), off);
  ok(sent.length === 0, 'disabled section answers nothing');
}

console.log('=== stream links, and the configured Jellyfin account ===');
{
  const stream = streamUrl('abc', { base: 'https://jf.example.org', apiKey: 'K' });
  ok(/\/Videos\/abc\/stream/.test(stream), 'defaults to the stream endpoint');
  ok(/static=true/.test(stream), 'static=true — the original file, no transcoding');
  const dl = streamUrl('abc', { base: 'https://jf.example.org', apiKey: 'K', linkType: 'download' });
  ok(/\/Items\/abc\/Download/.test(dl), 'download type still available');

  const schema = fs.readFileSync(new URL('../src/config/schema.js', import.meta.url), 'utf8');
  ok(/allowBotKeyFallback: true/.test(schema), "uses the Jellyfin account from Settings unless a dedicated key is set");
  ok(/linkType: 'stream'/.test(schema), 'stream links by default');
}

console.log('=== link requests use their OWN queue ===');
{
  const src = fs.readFileSync(new URL('../src/plugins/direct-links/index.js', import.meta.url), 'utf8');
  ok(/const q = ctx\.linkQueue \?\? ctx\.queue;/.test(src), 'prefers the link queue, falling back to the media one');
  ok(/kind: 'link'/.test(src), 'jobs are tagged as link work');

  const idx = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  ok(/const linkQueue = new JobQueue\(\{ concurrency: 1/.test(idx), 'a separate serial queue is created');
  ok(/PluginManager\(\{ bot, configStore, queue, linkQueue/.test(idx), 'and handed to the plugins');

  const api = fs.readFileSync(new URL('../src/web/api.js', import.meta.url), 'utf8');
  ok(/router\.get\('\/queue\/links'/.test(api), 'the portal can see it separately');
}
{
  // a queued request replies exactly once, through the queue
  const sent = [];
  const jobs = [];
  const ctx = {
    config: {
      directLinks: { enabled: true, groups: ['links@g.us'], apiKey: 'K', movieCommand: '#request-movie', tvCommand: '#request-tv' },
      library: { jellyfin: { baseUrl: 'https://jf' } },
    },
    bot: { sendText: async (j, t) => { sent.push(t); return {}; } },
    linkQueue: { add: (j) => { jobs.push(j); } },
    queue: { add: () => { throw new Error('must not use the MEDIA queue'); } },
    log: { info(){}, warn(){}, error(){}, debug(){} },
  };
  await plugin.onMessage({ text: '#request-movie Dune 2021', chatJid: 'links@g.us', isGroup: true, fromMe: false, messageType: 'conversation' }, ctx);
  ok(jobs.length === 1, 'the request was queued, not run inline');
  ok(sent.length === 0, 'and nothing was sent before it ran');
  ok(/Dune/.test(jobs[0].label), `the job is labelled with the request: "${jobs[0].label}"`);
  ok(jobs[0].kind === 'link', 'tagged as link work so it never mixes with media jobs');
}

// The operator, 2026-10-12: "if it's a dash it's 4 through 10, comma then
// it'll only be those 2". This group reads a request with the TV group's
// parser, so a list here was its first episode alone as well.
console.log('=== a list of episodes gets links for those, and names what is missing ===');
{
  const realFetch = globalThis.fetch;
  // The Office: season 1 is E01 to E10.
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    const json = (v) => ({ ok: true, status: 200, json: async () => v });
    if (u.pathname.endsWith('/Seasons')) return json({ Items: [{ Id: 'S1', IndexNumber: 1, ChildCount: 10 }] });
    if (u.pathname.endsWith('/Episodes')) {
      return json({ Items: Array.from({ length: 10 }, (_, i) => i + 1).map((n) => ({
        Id: `S1E${n}`, SeriesName: 'The Office', ParentIndexNumber: 1, IndexNumber: n, Name: `Ep ${n}`,
      })) });
    }
    if (u.pathname.endsWith('/Items') || u.pathname.endsWith('/Search/Hints')) {
      return json({ Items: [{ Id: 'OFF', Name: 'The Office', ProductionYear: 2005, OfficialRating: 'TV-14', RecursiveItemCount: 10 }] });
    }
    return { ok: false, status: 404, statusText: 'NF', json: async () => ({}) };
  };
  try {
    const sent = [];
    const ctx = {
      config: {
        directLinks: { enabled: true, groups: ['links@g.us'], apiKey: 'K', movieCommand: '#request-movie', tvCommand: '#request-tv' },
        library: { jellyfin: { baseUrl: 'https://jf', accessToken: 'TOK', userId: 'U1' } },
      },
      bot: { sendText: async (j, t) => { sent.push(t); return {}; } },
      linkQueue: { add: (j) => j.run({ isCancelled: () => false }) },
      log: { info() {}, warn() {}, error() {}, debug() {} },
    };
    const ask = async (text) => {
      sent.length = 0;
      await plugin.onMessage({ text, chatJid: 'links@g.us', isGroup: true, fromMe: false, messageType: 'conversation' }, ctx);
      await new Promise((r) => setTimeout(r, 5));
      return sent.join('\n');
    };
    const links = (all) => [...all.matchAll(/\/Videos\/(S1E\d+)\//g)].map((m) => m[1]).join();
    const two = await ask('#request-tv The Office S01E06, E09');
    ok(links(two) === 'S1E6,S1E9', `"S01E06, E09" is links to E06 and E09, nothing between (${links(two)})`);
    ok(!/isn't on the server/.test(two), 'and nothing is said to be missing');
    const part = await ask('#request-tv The Office S01E02, E30');
    ok(links(part) === 'S1E2', `"S01E02, E30" is a link to E02 (${links(part)})`);
    ok(sent.at(-1) === "📬 S01E30 of *The Office* isn't on the server.", `and E30 is named as not on the server (${sent.at(-1)})`);
    const run = await ask('#request-tv The Office S01E04-E07, E09');
    ok(links(run) === 'S1E4,S1E5,S1E6,S1E7,S1E9', `"S01E04-E07, E09" is E04 to E07 and E09 (${links(run)})`);
    const dash = await ask('#request-tv The Office S01E04-E10');
    ok(links(dash).split(',').length === 7, `a dash is still every episode through the last (${links(dash)})`);
    // None of a list, or of a run, on the server: named by its codes, as the
    // TV group names them. It was "That episode of *The Office* isn't on the
    // server", one episode for two (found in review, 2026-10-12).
    const none = await ask('#request-tv The Office S01E20, E30');
    ok(none === "📬 S01E20, E30 of *The Office* aren't on the server.", `a list the season has none of is named (${none})`);
    const noRun = await ask('#request-tv The Office S01E20-E30');
    ok(noRun === "📬 S01E20–E30 of *The Office* aren't on the server.", `and a run (${noRun})`);
    const one = await ask('#request-tv The Office S01E30');
    ok(one === "📬 That episode of *The Office* isn't on the server.", `one episode as it always was (${one})`);
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
