/* The TV group's cooldown never leaves a member without an answer.
   Run: node test/tv-cooldown.test.mjs

   Found in an audit of the TV group (2026-09-29). The TV group's cooldown is
   a quarter of an hour (cooldownSecondsPerUser 900), and it was started by
   every request that got as far as a lookup - including the ones that queued
   nothing. A member told 📺 "which season?" who answered with the season, as
   the reply asks, was inside their own cooldown, and a request refused for
   the cooldown got nothing at all: a log line, and no reaction. The member
   saw the bot ignore them for fifteen minutes. The same after 📬 (not in the
   library), ⛔, ⚠️ or a duplicate's 🤥.

   The first fix gave the clock back for any request that queued nothing,
   which a review the same day (before it shipped) found let one member make
   the bot post without limit: in its harness, ten "#request The Boys" in a
   row got ten quoted "which season?" replies and ten notifications lines
   (twenty messages, thirty Jellyfin calls), where the kept clock allowed
   two; ten "Frasier season 1" (not in the library) got ten 📬 lines. The film side keeps the clock after its "which one?"
   reply for exactly that reason (movie-requests _narrowDown).

   Then the clock was given back only when nothing was said in any group - a
   failed lookup, say - and kept for everything that posts.

   2026-10-01, the operator's rule after Ben Lewis's three 🚫 on the film
   side (test/cooldown-after-queued.test.mjs): "cooldown is only if the
   members first request actually puts an item in queue, otherwise why we
   cooling him down???" So the clock starts only when a request queues at
   least one episode: "which season?", not in the library, a duplicate and a
   rating refusal no longer start it, and there is no clock to give back. What
   limits those answers now is the flood backstop (src/core/request-cooldown.js):
   five answers without queueing in ten minutes, and the next ones get 🚫. The
   blocks below that pinned the kept clock now pin that instead, and say so.
   The member asked "which season?" may still answer once whatever would
   refuse it - with a season, of the same show. One refused for the cooldown
   gets 🚫, as a film does, and group admins are not held to it, as they are
   not for films. These run the real plugin against the real queue, paused so
   nothing downloads. */
import plugin from '../src/plugins/tv-requests/index.js';
import { parseTvRequest } from '../src/plugins/tv-requests/parse.js';
import { JobQueue } from '../src/core/queue.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const settle = () => new Promise((r) => setTimeout(r, 5));

const TVREQ = 'tvreq@g.us';
const NOTIFY = 'notify@g.us';

// The Boys, seasons 1 and 2, three episodes each. Anything else is not in
// the library, and "The Boys" alone is asked which season.
const SERIES = { Items: [{ Id: 'SER1', Name: 'The Boys', ProductionYear: 2019 }] };
const SEASONS = { Items: [{ Id: 'S1', IndexNumber: 1 }, { Id: 'S2', IndexNumber: 2 }] };
const episodesOf = (season) => ({
  Items: [1, 2, 3].map((n) => ({
    Id: `S${season}E${n}`, SeriesName: 'The Boys', ParentIndexNumber: season, IndexNumber: n,
    Name: `Ep ${n}`, MediaSources: [{ Path: `/s${season}e${n}.mkv`, Size: n }],
  })),
});
let jellyfinDown = false;
let lookups = 0;
globalThis.fetch = async (url) => {
  lookups += 1;
  if (jellyfinDown) throw new Error('fetch failed');
  const u = String(url);
  const season = Number(new URL(u).searchParams.get('season') ?? 1);
  for (const [k, v] of Object.entries({ '/Items': SERIES, '/Seasons': SEASONS, '/Episodes': episodesOf(season) })) {
    if (u.includes(k)) return { ok: true, status: 200, json: async () => v };
  }
  return { ok: false, status: 404, statusText: 'NF', json: async () => ({}) };
};

async function setUp({ admins = [], replyOnBlock = false } = {}) {
  await plugin.teardown();
  const reacted = [];
  const texts = [];
  const logs = [];
  const store = new Map();
  const queue = new JobQueue({ concurrency: 1, maxLength: 50 });
  queue.pause();
  const ctx = {
    config: {
      tvRequests: { enabled: true, requestGroups: [TVREQ], postsGroups: ['tvposts@g.us'], cooldownSecondsPerUser: 900, blockedRatings: [] },
      movieRequests: { notifyRefusals: true,
        reactions: {
          researching: '🔍', added: '🎬', duplicate: '🤥', notInLibrary: '📬', failed: '⚠️', done: '✅',
          tooFast: '🚫', positions: ['1️⃣', '2️⃣', '3️⃣'], positionOverflow: '🔢',
        },
        notify: { group: NOTIFY },
        replyOnBlock,
      },
      library: { jellyfin: { baseUrl: 'http://jf:8096', accessToken: 'TOK', userId: 'U1' } },
      media: { workDir: '/tmp/tv-cooldown-test' },
    },
    bot: {
      isConnected: () => true,
      isGroupAdmin: (chat, { jid }) => admins.includes(jid),
      deleteMessage: async () => {},
      archiveChat: async () => {},
      sendText: async (jid, text, opts) => { texts.push({ jid, text, quoted: opts?.quoted?.id ?? null }); return { key: { id: 'T' } }; },
      react: async (msg, emoji, opts) => { reacted.push({ id: msg.id, emoji, kind: opts?.kind }); return true; },
    },
    queue,
    store: { get: (k, d) => (store.has(k) ? structuredClone(store.get(k)) : d), set: (k, v) => store.set(k, structuredClone(v)) },
    log: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m), debug() {} },
  };
  ctx.config.tvRequests.reactions = { needSeason: '📺' };
  await plugin.setup(ctx);
  const on = (id) => reacted.filter((r) => r.id === id).map((r) => r.emoji).join(' ');
  return { ctx, queue, reacted, texts, logs, store, on };
}

let seq = 0;
const mkMsg = (text, sender = 'avi') => {
  const id = `m${++seq}`;
  return {
    id, key: { id, remoteJid: TVREQ }, text, chatJid: TVREQ, isGroup: true, fromMe: false, messageType: 'conversation',
    // A number each: the same number is the same member (requestMemberKey),
    // and since 2026-10-11 a member's own request asked again is no duplicate.
    senderJid: `${sender}@lid`, senderNumber: sender === 'avi' ? '15551112222' : `1555${[...sender].map((c) => c.charCodeAt(0)).join('').slice(0, 7)}`,
    senderNumberDisplay: '+1 555 111 2222', pushName: sender, timestamp: Date.now(),
  };
};
const ask = async (ctx, text, sender) => { const m = mkMsg(text, sender); await plugin.onMessage(m, ctx); await settle(); return m; };
const tvWaiting = (q) => q.snapshot().pending.filter((e) => e.kind === 'tv').map((e) => e.label);

console.log('=== the answer to "which season?" is let through the cooldown, once ===');
{
  const { ctx, queue, texts, on } = await setUp();
  const first = await ask(ctx, 'The Boys');
  ok(on(first.id) === '🔍 📺', `asked which season (${on(first.id)})`);
  ok(texts.some((t) => /which season\?/.test(t.text)), 'with the question in the group');
  const answer = await ask(ctx, 'The Boys season 1');
  ok(tvWaiting(queue).join() === 'The Boys season 1', `the season sent straight after is queued (${tvWaiting(queue).join() || 'nothing'})`);
  ok(on(answer.id).startsWith('🔍 🎬'), `and answered as a queued request, not ignored (${on(answer.id)})`);
  const third = await ask(ctx, 'The Boys season 2');
  ok(on(third.id) === '🚫' && tvWaiting(queue).length === 1, `the answer takes the clock as a request does: the next is too soon (${on(third.id)})`);
  await plugin.teardown();
}

console.log('=== ten "The Boys" in a row: five "which season?" replies and lines, and the rest 🚫 ===');
{
  // Before 2026-10-01 the first "which season?" started the clock, and the
  // other nine got 🚫: two messages in all. The question starts no clock now
  // (it queues nothing), so the flood backstop is what stops it: five
  // questions, then 🚫 until ten minutes have passed - ten messages, where
  // there were twenty before the kept clock.
  const { ctx, queue, texts, on } = await setUp();
  lookups = 0;
  const msgs = [];
  for (let i = 0; i < 10; i += 1) msgs.push(await ask(ctx, 'The Boys'));
  const asked = texts.filter((t) => t.jid === TVREQ && /which season\?/.test(t.text));
  const lines = texts.filter((t) => t.jid === NOTIFY);
  ok(asked.length === 5 && asked.every((a, i) => a.quoted === msgs[i].id), `five "which season?" replies, to the first five (${asked.length})`);
  ok(lines.length === 5 && lines.every((l) => /asked which season/.test(l.text)), `five notifications lines (${lines.length})`);
  ok(msgs.slice(5).every((m) => on(m.id) === '🚫'), `the other five get 🚫 and nothing else (${msgs.slice(5).map((m) => on(m.id)).join(' ')})`);
  ok(texts.length === 10, `ten messages in all, where there were twenty before any limit (${texts.length})`);
  ok(!texts.some((t) => t.quoted === msgs[5].id), 'the sixth gets no quoted reply');
  const answer = await ask(ctx, 'The Boys season 2');
  ok(tvWaiting(queue).join() === 'The Boys season 2', `the member can still answer the question (${tvWaiting(queue).join() || 'nothing'})`);
  ok(on(answer.id).startsWith('🔍 🎬'), `with 🎬 (${on(answer.id)})`);
  await plugin.teardown();
}

console.log('=== the answer must be the same show, and is let through once ===');
{
  // The pass matters where something would refuse the answer: here the
  // backstop, tripped by four refusals and the question itself.
  const { ctx, queue, on, texts } = await setUp();
  for (let i = 0; i < 4; i += 1) await ask(ctx, 'Frasier season 1');
  await ask(ctx, 'The Boys');
  const said = texts.length;
  const other = await ask(ctx, 'Frasier season 1');
  ok(on(other.id) === '🔍 🚫', `another show is refused for the cooldown, after the one lookup (${on(other.id)})`);
  ok(texts.length === said, 'with nothing said in any group - no 📬, no line');
  const then = await ask(ctx, 'The Boys season 1');
  ok(on(then.id) === '🚫' && tvWaiting(queue).length === 0, `and the pass is spent: the right answer after it is refused (${on(then.id)})`);
  await plugin.teardown();
}

console.log('=== not in the library, or already waiting, starts no clock ===');
{
  // These kept the clock before 2026-10-01. They queue nothing, so they
  // start none now; ten "not in the library" in a row are stopped by the
  // backstop after five.
  const { ctx, on, texts } = await setUp();
  const msgs = [];
  for (let i = 0; i < 10; i += 1) msgs.push(await ask(ctx, 'Frasier season 1'));
  ok(on(msgs[0].id) === '🔍 📬', `not in the library: 📬 (${on(msgs[0].id)})`);
  ok(msgs.slice(0, 5).every((m) => on(m.id) === '🔍 📬'), 'the first five are each answered');
  ok(texts.filter((t) => t.jid === NOTIFY).length === 5, `ten of them make five notifications lines, not ten (${texts.filter((t) => t.jid === NOTIFY).length})`);
  ok(msgs.slice(5).every((m) => on(m.id) === '🚫'), 'and the other five get 🚫');
  await plugin.teardown();

  const d = await setUp();
  await ask(d.ctx, 'The Boys season 1', 'dina');       // somebody else asks first
  const dup = await ask(d.ctx, 'The Boys season 1');
  ok(d.on(dup.id).startsWith('🔍 🤥'), `already waiting: 🤥 (${d.on(dup.id)})`);
  const next = await ask(d.ctx, 'The Boys season 2');
  ok(d.on(next.id).startsWith('🔍 🎬'), `and the member's next request is looked up and queued (${d.on(next.id)})`);
  await plugin.teardown();
}

console.log('=== a failed lookup, which says nothing in any group, starts no clock ===');
{
  const { ctx, queue, on, texts } = await setUp();
  jellyfinDown = true;
  const broken = await ask(ctx, 'The Boys season 2');
  jellyfinDown = false;
  ok(on(broken.id) === '🔍 ⚠️', `the library could not be reached: ⚠️ (${on(broken.id)})`);
  ok(texts.length === 0, 'and nothing was said in any group');
  const next = await ask(ctx, 'The Boys season 2');
  ok(tvWaiting(queue).join() === 'The Boys season 2', `so the member's next request is still queued (${tvWaiting(queue).join()})`);
  ok(on(next.id).startsWith('🔍 🎬'), `with 🎬 (${on(next.id)})`);
  await plugin.teardown();
}

console.log('=== the "which season?" example keeps the episodes asked for ===');
{
  // Found in review (2026-09-29): "#request The Office episodes 3-6" was
  // answered "Send e.g. #request The Office season 1", which, copied,
  // queued about 22 episodes for the 4 wanted - and, answered through the
  // pass above, spent the member's one answer on it.
  const { ctx, texts } = await setUp();
  const example = (m) => (texts.find((t) => t.quoted === m.id)?.text.match(/Send e\.g\. \*#request (.+)\*/) ?? [])[1];
  const range = await ask(ctx, 'The Boys episodes 2-3', 'ari');
  ok(example(range) === 'The Boys S01E02-E03', `a run of episodes: "${example(range)}", not "The Boys season 1"`);
  const back = parseTvRequest(example(range));
  ok(back.season === 1 && back.episodeRange?.from === 2 && back.episodeRange?.to === 3, 'which reads back as exactly those episodes of season 1');
  const one = await ask(ctx, 'The Boys episode 2', 'bea');
  ok(example(one) === 'The Boys S01E02', `one episode: "${example(one)}"`);
  const whole = await ask(ctx, 'The Boys', 'cal');
  ok(example(whole) === 'The Boys season 1', `the show alone: "${example(whole)}", as before`);
  await plugin.teardown();
}

console.log('=== a request refused for the cooldown gets 🚫 ===');
{
  const { ctx, queue, on, logs, texts } = await setUp();
  await ask(ctx, 'The Boys season 1');
  const again = await ask(ctx, 'The Boys season 2');
  ok(tvWaiting(queue).join() === 'The Boys season 1', 'a request that queued something still starts the cooldown');
  ok(on(again.id) === '🚫', `the next one inside it gets 🚫, where it used to get nothing (${on(again.id) || 'nothing'})`);
  ok(logs.some((l) => /cooling down \(1\dm/.test(l)), 'and a log line saying how long is left');
  ok(!texts.some((t) => t.quoted === again.id), 'no reply in the group unless replies on blocking are on');
  await plugin.teardown();

  const withReply = await setUp({ replyOnBlock: true });
  await ask(withReply.ctx, 'The Boys season 1');
  const refused = await ask(withReply.ctx, 'The Boys season 2');
  const reply = withReply.texts.find((t) => t.quoted === refused.id);
  ok(reply && /^🚫 Request denied — too many at once\. Please wait 1\dm/.test(reply.text),
    `with "Also send a text reply when blocking" on, a quoted reply says how long (${reply?.text})`);
  await plugin.teardown();
}

console.log('=== a group admin is not held to the cooldown ===');
{
  const { ctx, queue, on } = await setUp({ admins: ['avi@lid'] });
  await ask(ctx, 'The Boys season 1');
  const second = await ask(ctx, 'The Boys season 2');
  ok(tvWaiting(queue).join() === 'The Boys season 1,The Boys season 2', `both of an admin's requests are queued (${tvWaiting(queue).join()})`);
  ok(!on(second.id).includes('🚫'), `and neither gets 🚫 (${on(second.id)})`);
  await plugin.teardown();
}

console.log('=== no clock is taken while a request is looked up, and one that fails takes none ===');
{
  // Before 2026-10-01 the clock was taken as the lookup started, so that a
  // second message meanwhile met it, and given back if the lookup failed.
  // Now the second waits for the first to settle instead
  // (test/cooldown-after-queued.test.mjs), and the clock starts only at a
  // queued request.
  const { ctx, store } = await setUp();
  let release;
  const gate = new Promise((r) => { release = r; });
  const real = globalThis.fetch;
  globalThis.fetch = async () => { await gate; throw new Error('fetch failed'); };
  const slow = plugin.onMessage(mkMsg('The Boys season 1'), ctx);  // its lookup will fail
  await settle();
  const key = 'cooldown:avi@lid';
  ok(store.get(key) == null, 'no clock while the lookup runs');
  release();
  await slow;
  globalThis.fetch = real;
  ok(store.get(key) == null, 'and none after it failed');
  await plugin.teardown();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
