/* The Discord ticket reader reads only what is new, only from the tickets,
   and only a handful of requests at a time. Run: node test/discord-watch.test.mjs

   The operator, 2026-10-11: "create from scratch a way I can connect my
   discord account to the ubuntu so you can access it", so that the hourly
   check sees what the Jellyfin host's staff answer in the support tickets the
   operator opens in their server ("Harry Potter and the Philosopher's Stone"
   to "...Sorcerer's Stone", tt0241527; "Star Wars" (1977) to "Star Wars:
   Episode IV - A New Hope", tt0076759). Pinned here, against a fake Discord
   (test/fixtures/fake-discord.mjs) - there is no token in this suite and no
   request leaves the box:

   - which channels: the watched server's channels named like a ticket, the
     ones that are the operator's own; never somebody else's ticket, a voice
     channel or #general; an explicit channel id whatever its name; and a
     ticket once read still read after Ticket Tool renames it closed-NNNN;
   - how much: the first run reads 7 days back and no further, later runs
     only after the last message read (kept in the state store), and a
     channel with nothing new costs no request at all - a quiet half hour is
     one request per server; never more than MAX_REQUESTS_PER_RUN in a run,
     and no run within ten minutes of the last;
   - what is kept: one line per message in discord-tickets.jsonl, with who
     wrote it, whether it was the operator, the embeds as text and the
     attachments, kept 90 days;
   - a 403 leaves that channel alone for a week; a 401 stops the reader,
     says so in the status and the audit log, and no request follows - not
     from the panel's server list or channel preview either, which each
     built a client of their own and sent the revoked token again (review,
     2026-10-11); a 401 tools/discord.mjs got first, and left in
     discord-refused.json, stops it the same way without a request;
   - a ticket whose newest message was deleted is asked for once, not on
     every run: Discord leaves last_message_id on the deleted message, and
     the first version asked for it twice an hour for ever (review,
     2026-10-11);
   - nothing but GET ever reaches Discord, and the token is in no log line. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import log from '../src/util/logger.js';
import { StateStore } from '../src/core/state.js';
import {
  DiscordWatch, NAMESPACE, ticketsFile, readDiscordTickets, snowflakeAt, timeOfSnowflake, visibleToMe, watchSettings,
  EVERY_MS, MIN_GAP_MS, BACKFILL_DAYS, KEEP_DAYS, MAX_REQUESTS_PER_RUN, refusedFile, writeRefused,
} from '../src/core/discord-watch.js';
import { fakeDiscord, flake, msg } from './fixtures/fake-discord.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const logged = [];
log.setSink({ write: (e) => logged.push(JSON.stringify(e)) });

const TOKEN = 'MTA5ODc2NTQzMjE5ODc2NTQzMg' + '.GxYzAb.' + 'fake-test-token_not-real_0123456789ab';
const ME = '1098765432198765432';
const STAFF = '1077777777777777777';
const TICKET_TOOL = '557628352828014614';
const SOMEONE = '1066666666666666666';
const HOST = '1100000000000000001';
const OTHER_GUILD = '1100000000000000002';
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
let clock = Date.parse('2026-10-11T15:00:00Z');
const ago = (ms) => clock - ms;
const VIEW = String(1 << 10);

// Ticket Tool's channels: @everyone cannot see them, the member who opened
// the ticket can.
const mine = [{ id: HOST, type: 0, allow: '0', deny: VIEW }, { id: ME, type: 1, allow: VIEW, deny: '0' }];
const theirs = [{ id: HOST, type: 0, allow: '0', deny: VIEW }, { id: SOMEONE, type: 1, allow: VIEW, deny: '0' }];
const CH = {
  hp: '1200000000000000001', other: '1200000000000000002', closedOld: '1200000000000000003', general: '1200000000000000004',
  old: '1200000000000000005', sw: '1200000000000000006', stale: '1200000000000000007', voice: '1200000000000000008',
  elsewhere: '1200000000000000009',
};
const me = { id: ME, username: 'headadmin', global_name: 'Head Admin' };
const staff = { id: STAFF, username: 'mediastaff', global_name: 'Media Staff' };
const tt = { id: TICKET_TOOL, username: 'Ticket Tool', bot: true };
let seq = 0;
const m = (at, author, content, extra = {}) => msg({ id: flake(at, seq++), at, author, content, ...extra });

const D = await fakeDiscord({
  token: TOKEN,
  me,
  guilds: [{ id: HOST, name: 'Media Host' }, { id: OTHER_GUILD, name: 'Elsewhere' }],
  channels: {
    [HOST]: [
      { id: CH.hp, name: 'ticket-0001', type: 0, permission_overwrites: mine },
      { id: CH.other, name: 'ticket-0002', type: 0, permission_overwrites: theirs },
      { id: CH.closedOld, name: 'closed-0003', type: 0, permission_overwrites: mine },
      { id: CH.general, name: 'general', type: 0, permission_overwrites: [] },
      { id: CH.old, name: 'ticket-0004', type: 0, permission_overwrites: mine },
      { id: CH.sw, name: 'ticket-0005', type: 0, permission_overwrites: mine },
      { id: CH.stale, name: 'ticket-0006', type: 0, permission_overwrites: mine },
      { id: CH.voice, name: 'ticket-voice', type: 2, permission_overwrites: [] },
    ],
    [OTHER_GUILD]: [{ id: CH.elsewhere, name: 'support', type: 0, permission_overwrites: [] }],
  },
  messages: {
    [CH.hp]: [
      m(ago(3 * DAY), tt, '', { embeds: [{ title: 'Ticket', description: 'Support will be with you shortly. To close this ticket react with 🔒' }] }),
      m(ago(3 * DAY) + MIN, me, 'Please rename "Harry Potter and the Philosopher\'s Stone" to "Harry Potter and the Sorcerer\'s Stone" - https://www.imdb.com/title/tt0241527/'),
      m(ago(2 * DAY), staff, 'Done, renamed it to Sorcerer\'s Stone. Rescan running.', { attachments: [{ filename: 'proof.png', url: 'https://cdn.discordapp.com/attachments/x/proof.png' }] }),
    ],
    [CH.other]: [m(ago(DAY), { id: SOMEONE, username: 'someone' }, 'my own ticket')],
    [CH.closedOld]: [m(ago(DAY), me, 'an old closed ticket')],
    [CH.general]: [m(ago(HOUR), staff, 'hello everyone')],
    [CH.old]: [
      m(ago(10 * DAY), me, 'ten days ago'),
      m(ago(8 * DAY), staff, 'eight days ago'),
      m(ago(DAY), staff, 'yesterday'),
    ],
    [CH.sw]: Array.from({ length: 150 }, (_, i) => m(ago(5 * DAY) + i * MIN, i % 2 ? staff : me, `Star Wars (1977) -> Episode IV, message ${i + 1}`)),
    [CH.stale]: [m(ago(9 * DAY), me, 'nine days ago, nothing since')],
    [CH.elsewhere]: [m(ago(2 * HOUR), staff, 'a reply in another server')],
  },
});

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-watch-'));
const stateStore = new StateStore(path.join(dataDir, 'state.json'));
let config = { discord: { token: TOKEN, watch: { guilds: [HOST], channelPattern: '^ticket-', channels: [] } } };
const watch = new DiscordWatch({
  dataDir, configStore: { get: () => config }, store: stateStore.namespace(NAMESPACE), audit: stateStore.namespace('audit'),
  fetch: D.fetch, now: () => clock, sleep: async () => {},
});
const store = stateStore.namespace(NAMESPACE);
const asked = (from) => D.requests.slice(from).map((r) => `${r.path}${r.query.after ? ' after' : ''}`);
const rows = () => readDiscordTickets(dataDir);
const add = (ch, author, content, extra) => { const x = m(clock - MIN, author, content, extra); D.state.messages[ch].push(x); return x; };

console.log('=== the settings ===');
{
  const w = watchSettings({ discord: { watch: { guilds: [HOST, 'not-an-id', HOST], channelPattern: '(', channels: [CH.sw] } } });
  ok(w.guilds.join() === HOST && w.channels.join() === CH.sw, 'only Discord ids are kept, once each');
  ok(w.pattern.source === '^ticket-', 'a pattern that does not compile falls back to ^ticket-');
  ok(watchSettings({}).patternText === '^ticket-' && watchSettings({}).guilds.length === 0, 'and nothing set means nothing is read');
  ok(visibleToMe({ permission_overwrites: mine }, ME, HOST) && !visibleToMe({ permission_overwrites: theirs }, ME, HOST)
    && visibleToMe({ permission_overwrites: [] }, ME, HOST), 'a ticket is the operator\'s when it lets them in by name; a public channel is visible');
  const t = Date.parse('2026-10-04T15:00:00Z');
  ok(Math.abs(timeOfSnowflake(snowflakeAt(t)) - t) < 1, 'a time and its snowflake agree');
  ok(EVERY_MS === 30 * MIN && MIN_GAP_MS === 10 * MIN && BACKFILL_DAYS === 7 && KEEP_DAYS === 90, 'every 30 minutes, 7 days back, kept 90 days');
}

console.log('=== nothing connected, nothing watched: nothing asked ===');
{
  const saved = config;
  config = { discord: { token: '', watch: saved.discord.watch } };
  ok((await watch.run()).skipped === 'not connected', 'no token: skipped');
  config = { discord: { token: TOKEN, watch: { guilds: [], channelPattern: '^ticket-', channels: [] } } };
  ok((await watch.run()).skipped === 'nothing to watch', 'no server and no channel: skipped');
  ok(D.requests.length === 0, 'and Discord was not asked anything');
  config = saved;
}

console.log('=== the first run: the tickets, 7 days back, in a handful of requests ===');
{
  const from = D.requests.length;
  const r = await watch.run();
  const got = asked(from);
  ok(r.ok && r.errors.length === 0, `it ran (${JSON.stringify(r.errors)})`);
  ok(got.join(' | ') === [
    'users/@me', `guilds/${HOST}/channels`, `guilds/${HOST}`,
    `channels/${CH.hp}/messages after`, `channels/${CH.old}/messages after`, `channels/${CH.sw}/messages after`, `channels/${CH.sw}/messages after`,
  ].join(' | '), `exactly: who am I, the server's channels, its name, then each ticket with something new (${got.length}): ${got.join(', ')}`);
  ok(!got.some((p) => p.includes(CH.other)), 'somebody else\'s ticket is never asked for');
  ok(!got.some((p) => [CH.general, CH.closedOld, CH.voice].some((c) => p.includes(c))), 'nor #general, a closed ticket never read, or a voice channel');
  ok(!got.some((p) => p.includes(CH.stale)), 'nor a ticket whose last message is older than the 7 days read back');
  ok(r.private === 1, 'the other ticket is counted as somebody else\'s');
  const firstAfter = D.requests.slice(from).find((q) => q.path === `channels/${CH.old}/messages`).query.after;
  ok(Math.abs(timeOfSnowflake(firstAfter) - ago(7 * DAY)) < 1000, 'a ticket never read is read from 7 days back');
  const kept = rows();
  ok(kept.filter((x) => x.channel === CH.old).map((x) => x.content).join() === 'yesterday', 'so the 10- and 8-day-old messages are not kept');
  ok(kept.filter((x) => x.channel === CH.sw).length === 150, 'a busy ticket is read page by page: 150 messages, two requests');
  const hp = kept.filter((x) => x.channel === CH.hp);
  ok(hp.length === 3 && hp[1].fromMe && !hp[2].fromMe && hp[2].author.username === 'mediastaff' && hp[0].author.bot,
    'who wrote each: the operator\'s own marked fromMe, the staff\'s not, Ticket Tool\'s as a bot');
  ok(hp[0].embeds[0].includes('Support will be with you shortly') && hp[2].attachments[0].name === 'proof.png'
    && hp[2].attachments[0].url.startsWith('https://cdn.discordapp.com/'), 'embeds as text, attachments by name and link');
  ok(hp.every((x) => x.guild === HOST && x.guildName === 'Media Host' && x.channelName === 'ticket-0001' && x.messageId && x.readAt === clock),
    'and where: the server, its name, the channel, its name, the message id, when it was read');
  ok(D.requests.every((q) => q.method === 'GET'), 'every request was a GET: nothing posted, reacted, edited, marked read or typed');
  const hw = store.get('hw', {});
  ok(hw[CH.hp] === D.state.messages[CH.hp][2].id && hw[CH.sw] === D.state.messages[CH.sw][149].id,
    'the last message read in each channel is kept in the state store');
  stateStore.flush();
  const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'))[NAMESPACE];
  ok(onDisk?.hw?.[CH.hp] === hw[CH.hp] && !config.discord.hw, 'in state.json, not in the settings');
  ok(fs.statSync(ticketsFile(dataDir)).mode % 0o1000 === 0o600, 'discord-tickets.jsonl is readable by the bot\'s user only');
}

console.log('=== the next runs: only what is new ===');
{
  const from = D.requests.length;
  ok((await watch.run()).skipped === 'ran recently' && D.requests.length === from, 'straight after: skipped, no request');
  clock += 31 * MIN;
  const r = await watch.run();
  ok(asked(from).join() === `guilds/${HOST}/channels`, `half an hour later, nothing new: one request (${asked(from).join(', ')})`);
  ok(r.appended === 0 && rows().length === 154, 'and nothing appended');

  add(CH.hp, staff, 'Also fixed the poster. Anything else?');
  clock += 31 * MIN;
  const f2 = D.requests.length;
  const r2 = await watch.run();
  ok(asked(f2).join(' | ') === `guilds/${HOST}/channels | channels/${CH.hp}/messages after`, `a new reply: two requests (${asked(f2).join(', ')})`);
  ok(D.requests[D.requests.length - 1].query.after === D.state.messages[CH.hp][2].id, 'asked for what came after the last message read');
  ok(r2.appended === 1 && rows().at(-1).content === 'Also fixed the poster. Anything else?', 'and only that is appended');
}

console.log('=== a ticket whose newest message was deleted is not asked for on every run ===');
{
  // Discord leaves a channel's last_message_id on a message that has been
  // deleted. The reader asked for what came after its read position, got
  // nothing, kept its position, and asked again the next run: two requests
  // every half hour for as long as the ticket lived (review, 2026-10-11).
  const gone = add(CH.hp, staff, 'sent, then deleted');
  D.scene.deleted.add(gone.id);
  clock += 31 * MIN;
  const from = D.requests.length;
  const r = await watch.run();
  ok(asked(from).join(' | ') === `guilds/${HOST}/channels | channels/${CH.hp}/messages after` && r.appended === 0,
    `the first run after it asks once and finds nothing (${asked(from).join(', ')})`);
  ok(store.get('hw', {})[CH.hp] === gone.id, 'and moves the read position up to the deleted message: the empty answer showed there is nothing before it');
  for (let i = 0; i < 3; i += 1) { clock += 31 * MIN; await watch.run(); }
  ok(asked(from + 2).join() === Array(3).fill(`guilds/${HOST}/channels`).join(),
    `three more half hours: one request each, as for any quiet ticket (${asked(from + 2).join(', ')})`);

  // A new message, and a newer one deleted before the reader comes by.
  const kept = add(CH.hp, staff, 'Poster fixed as well.');
  D.scene.deleted.add(add(CH.hp, staff, 'deleted too').id);
  clock += 31 * MIN;
  const f2 = D.requests.length;
  const r2 = await watch.run();
  ok(r2.appended === 1 && rows().at(-1).content === kept.content, 'the message that is still there is read');
  clock += 31 * MIN;
  const f3 = D.requests.length;
  await watch.run();
  ok(f3 - f2 === 2 && asked(f3).join() === `guilds/${HOST}/channels`, 'and the deleted one after it costs nothing the next run');

  const next = add(CH.hp, staff, 'A real reply after the deleted ones.');
  const position = store.get('hw', {})[CH.hp];
  clock += 31 * MIN;
  const f4 = D.requests.length;
  const r4 = await watch.run();
  ok(r4.appended === 1 && rows().at(-1).content === next.content && D.requests.slice(f4).at(-1).query.after === position,
    'a reply written after them is still read, from the position the deleted one left');
}

console.log('=== a ticket stays read when Ticket Tool renames it closed-0001 ===');
{
  D.state.channels[HOST][0].name = 'closed-0001';
  add(CH.hp, tt, '', { embeds: [{ description: `Ticket Closed by <@${ME}>` }] });
  clock += 31 * MIN;
  const r = await watch.run();
  const last = rows().at(-1);
  ok(r.appended === 1 && last.channelName === 'closed-0001' && /Ticket Closed by/.test(last.embeds[0]), `its closing is read, under its new name (${last.channelName})`);
}

console.log('=== an explicit channel id is read whatever its name, in any server ===');
{
  config = { discord: { token: TOKEN, watch: { guilds: [HOST], channelPattern: '^ticket-', channels: [CH.closedOld, CH.elsewhere] } } };
  clock += 31 * MIN;
  const from = D.requests.length;
  await watch.run();
  const got = asked(from);
  ok(got.includes(`channels/${CH.closedOld}/messages after`), 'closed-0003, named by id, is read although it does not match');
  ok(got.includes(`channels/${CH.elsewhere}`) && got.includes(`channels/${CH.elsewhere}/messages after`),
    'a channel in a server not watched is looked up, then read');
  ok(rows().some((x) => x.channel === CH.elsewhere && x.content === 'a reply in another server'), 'and kept');
  config = { discord: { token: TOKEN, watch: { guilds: [HOST], channelPattern: '^ticket-', channels: [] } } };
}

console.log('=== a 403 is left alone for a week ===');
{
  D.scene.forbid.add(CH.old);
  add(CH.old, staff, 'you cannot see this');
  clock += 31 * MIN;
  const from = D.requests.length;
  const r = await watch.run();
  ok(asked(from).includes(`channels/${CH.old}/messages after`) && r.denied === 1, 'refused once');
  add(CH.old, staff, 'nor this');
  clock += 31 * MIN;
  const f2 = D.requests.length;
  await watch.run();
  ok(!asked(f2).some((p) => p.includes(CH.old)), 'and not asked again the next time');
  D.scene.forbid.delete(CH.old);
}

console.log('=== a deleted ticket is forgotten ===');
{
  D.state.channels[HOST] = D.state.channels[HOST].filter((c) => c.id !== CH.sw);
  clock += 31 * MIN;
  await watch.run();
  ok(!store.get('hw', {})[CH.sw] && !store.get('channels', {})[CH.sw], 'its read position and name are dropped');
}

console.log('=== never more than MAX_REQUESTS_PER_RUN in a run ===');
{
  // Forty tickets, each with something new: the run stops at the ceiling,
  // and the next run reads on.
  const many = Array.from({ length: 40 }, (_, i) => ({ id: `13000000000000000${String(i).padStart(2, '0')}`, name: `ticket-1${String(i).padStart(3, '0')}`, type: 0, permission_overwrites: mine }));
  D.state.channels[HOST].push(...many);
  for (const c of many) D.state.messages[c.id] = [m(clock - HOUR, staff, `reply in ${c.name}`)];
  clock += 31 * MIN;
  const from = D.requests.length;
  const r = await watch.run();
  ok(D.requests.length - from === MAX_REQUESTS_PER_RUN && r.requests === MAX_REQUESTS_PER_RUN, `${D.requests.length - from} requests, the ceiling (${MAX_REQUESTS_PER_RUN})`);
  clock += 31 * MIN;
  const f2 = D.requests.length;
  await watch.run();
  clock += 31 * MIN;
  await watch.run();
  const readAll = many.every((c) => rows().some((x) => x.channel === c.id));
  ok(readAll && D.requests.length - f2 <= 2 * MAX_REQUESTS_PER_RUN, 'the next runs read the rest, each under the ceiling');
}

console.log('=== kept 90 days ===');
{
  const old = { at: clock - (KEEP_DAYS + 1) * DAY, readAt: clock - (KEEP_DAYS + 1) * DAY, channel: CH.hp, messageId: '1', content: 'ancient' };
  fs.writeFileSync(ticketsFile(dataDir), `${JSON.stringify(old)}\n${fs.readFileSync(ticketsFile(dataDir), 'utf8')}`);
  ok(rows().some((x) => x.content === 'ancient'), 'an old row is there');
  clock += DAY;
  add(CH.hp, staff, 'a new day');
  await watch.run();
  ok(!rows().some((x) => x.content === 'ancient') && rows().some((x) => x.content === 'a new day'), `older than ${KEEP_DAYS} days is dropped on a new day`);
}

console.log('=== a 401: the reader stops, says so, and asks nothing more ===');
{
  D.scene.revoked = true;
  add(CH.hp, staff, 'unread');
  clock += 31 * MIN;
  const from = D.requests.length;
  const r = await watch.run();
  ok(!r.ok && D.requests.length === from + 1, `the first refused request ends the run (${D.requests.length - from} request)`);
  const st = watch.status();
  ok(st.brokenSince === clock && /HTTP 401/.test(st.brokenWhy) && /logged out of all devices/.test(st.brokenWhy), `broken since now: ${st.brokenWhy}`);
  const row = stateStore.namespace('audit').get('events', [])[0];
  ok(row?.user === 'discord-reader' && /refused the saved token/.test(row.action), `an audit row says so: "${row?.action}"`);
  ok(logged.some((l) => /reconnect in Settings -> Connection -> Discord/.test(l)), 'and a log line, saying where to reconnect');
  for (let i = 0; i < 3; i += 1) { clock += 31 * MIN; await watch.run(); }
  ok(D.requests.length === from + 1, 'three more half hours: not one more request with that token');
  ok(watch.panelStatus().brokenSince === st.brokenSince && watch.panelStatus().connected, 'the panel is told: still connected, broken since then');
  // The panel's buttons each built a client of their own, which knew nothing
  // of the 401, and sent the revoked token again (review, 2026-10-11).
  for (const [what, call] of [['the server list', () => watch.guildList()], ['the channel preview', () => watch.matchingChannels(HOST, /^ticket-/i)]]) {
    let e = null;
    try { await call(); } catch (x) { e = x; }
    ok(e?.code === 'broken' && /not sent again/.test(e.message) && D.requests.length === from + 1, `${what} is refused as well, with no request: ${e?.message}`);
  }
  watch.connected({ id: ME, username: 'headadmin' }, 'superadmin');
  D.scene.revoked = false;
  clock += 31 * MIN;
  const f2 = D.requests.length;
  const r2 = await watch.run();
  ok(r2.ok && D.requests.length > f2 && rows().at(-1).content === 'unread', 'reconnected, it reads on from where it stopped');
  const f3 = D.requests.length;
  ok((await watch.guildList()).length === 2 && D.requests.length === f3 + 1, 'and the server list asks Discord again, once');
}

console.log('=== a 401 tools/discord.mjs got first: the reader stops without asking ===');
{
  // The CLI may not write state.json, which belongs to the running bot, so
  // the bot's next run sent the token the CLI had just been refused (review,
  // 2026-10-11). The CLI leaves discord-refused.json instead: when, and on
  // which connection.
  const connectedAt = watch.status().connectedAt;
  const refusedAt = clock - MIN;
  writeRefused(dataDir, { at: refusedAt, connectedAt });
  add(CH.hp, staff, 'written while the token is dead');
  clock += 31 * MIN;
  const from = D.requests.length;
  const r = await watch.run();
  ok(r.skipped === 'broken' && D.requests.length === from, 'the next run asks Discord nothing');
  const st = watch.status();
  ok(st.brokenSince === refusedAt && /tools\/discord\.mjs/.test(st.brokenWhy), `broken since the CLI was refused: ${st.brokenWhy}`);
  ok(stateStore.namespace('audit').get('events', [])[0]?.action === 'Discord refused the saved token - the reader stopped', 'with the audit row');
  let e = null;
  try { await watch.guildList(); } catch (x) { e = x; }
  ok(e?.code === 'broken' && D.requests.length === from, 'and the panel\'s server list is refused too');

  watch.connected({ id: ME, username: 'headadmin' }, 'superadmin');
  ok(!fs.existsSync(refusedFile(dataDir)), 'Connect with a new token clears the note');
  writeRefused(dataDir, { at: clock, connectedAt });
  clock += 31 * MIN;
  const f2 = D.requests.length;
  const r2 = await watch.run();
  ok(r2.ok && D.requests.length > f2 && !watch.status().brokenSince && rows().at(-1).content === 'written while the token is dead',
    'a note made on an earlier connection is about the old token, and counts for nothing');
  fs.rmSync(refusedFile(dataDir), { force: true });
}

console.log('=== start and stop ===');
{
  const w2 = new DiscordWatch({ dataDir, configStore: { get: () => ({}) }, store: stateStore.namespace('x'), fetch: D.fetch });
  w2.start();
  ok(w2._timer && w2._first, 'start sets the half-hourly timer and the first run');
  w2.stop();
  const src = fs.readFileSync(new URL('../src/core/discord-watch.js', import.meta.url), 'utf8');
  ok(/this\._timer = setInterval\(/.test(src) && /discordWatch\.start\(\)/.test(fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')),
    'the bot starts it (and routines.js claims the timer: test/routines.test.mjs)');
}

console.log('=== the token is in no log line and no record ===');
{
  ok(logged.length > 0 && !logged.some((l) => l.includes(TOKEN)), `${logged.length} log lines, none with the token`);
  ok(!fs.readFileSync(ticketsFile(dataDir), 'utf8').includes(TOKEN), 'nor discord-tickets.jsonl');
  stateStore.flush();
  ok(!fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8').includes(TOKEN), 'nor state.json');
  ok(!JSON.stringify(watch.panelStatus({ full: true })).includes(TOKEN), 'nor what the panel is sent');
}

await D.close();
fs.rmSync(dataDir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
