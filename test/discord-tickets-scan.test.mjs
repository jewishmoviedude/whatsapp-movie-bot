/* The hourly check reads the operator's support tickets: a staff answer is an
   incident, the operator's own words a notice, a dead token a daily notice.
   Run: node test/discord-tickets-scan.test.mjs

   The operator, 2026-10-11: "create from scratch a way I can connect my
   discord account to the ubuntu so you can access it" - so that the hourly
   check sees the results of the tickets they open with the Jellyfin host
   ("Harry Potter and the Philosopher's Stone" to "...Sorcerer's Stone",
   tt0241527; "Star Wars" (1977) to "Star Wars: Episode IV - A New Hope",
   tt0076759). The Discord reader (discord-watch.js) keeps each message in
   discord-tickets.jsonl; the scanner (incident-scan.js) turns them into
   findings:

   - a reply from the host's staff, or a bot of theirs closing the ticket, is
     a 'ticket-reply' incident (so the research session runs and checks it
     against the library), once, with the ticket's earlier messages - the
     request, with its film and IMDb id - as evidence;
   - the operator's own messages, their own closing and Ticket Tool's
     welcome are a 'ticket-own' notice;
   - "new" is when the reader read it, so a message read late is not lost;
   - a token Discord refused is a 'discord-reader' notice once a day;
   - the dossier keeps Discord ids whole and masks anything shaped like a
     token, and the saved token is among the secrets every report is scrubbed
     of. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scan, headline, KINDS } from '../src/core/incident-scan.js';
import { sanitize } from '../src/core/hourly-checks.js';
import { ConfigStore } from '../src/config/store.js';
import { SECRET_PATHS } from '../src/config/schema.js';
import { messageRow } from '../src/core/discord-watch.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

const TOKEN = 'MTA5ODc2NTQzMjE5ODc2NTQzMg' + '.GxYzAb.' + 'fake-test-token_not-real_0123456789ab';
const ME = '1098765432198765432';
const STAFF = '1077777777777777777';
const TT = '557628352828014614';
const HOST = '1100000000000000001';
const HP = '1200000000000000001';
const SW = '1200000000000000006';
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const NOW = Date.parse('2026-10-11T18:00:00Z');

let n = 0;
/** A kept row, as the reader writes it. */
const row = (channel, channelName, author, content, { at, readAt, embeds = [] } = {}) => messageRow(
  { id: String(1300000000000000000n + BigInt(n++)), timestamp: new Date(at).toISOString(), author, content, embeds, attachments: [] },
  { guild: HOST, guildName: 'Media Host', channel, channelName, me: ME, readAt: readAt ?? at },
);
const me = { id: ME, username: 'headadmin', global_name: 'Head Admin' };
const staff = { id: STAFF, username: 'mediastaff', global_name: 'Media Staff' };
const tt = { id: TT, username: 'Ticket Tool', bot: true };

const baseState = () => ({
  'movie-requests': { history: [], pending: [] }, 'tv-requests': { history: [], pending: [], 'library-misses': [] },
  'msg-index': { entries: [] }, audit: { events: [] },
  'discord-reader': { status: { user: { id: ME, username: 'headadmin' }, lastReadAt: NOW - 10 * MIN } },
});
const config = {
  movieRequests: { requestGroups: [], notify: {} }, tvRequests: { requestGroups: [] }, beta: { groups: [], features: {} }, media: {},
  discord: { token: 'enc:v1:whatever-config-json-holds', watch: { guilds: [HOST] } },
};
const run = ({ tickets, state = baseState(), memory = { v: 1, lastScanAt: NOW - HOUR, seen: {}, configCheckedAt: NOW }, now = NOW, cfg = config }) =>
  scan({ now, config: cfg, names: {}, unit: { ActiveState: 'active', NRestarts: '0' }, state, memory, tickets });

// The Harry Potter ticket: opened three days ago, answered twenty minutes ago.
const hp = [
  row(HP, 'ticket-0001', tt, '', { at: NOW - 3 * DAY, embeds: [{ title: 'Ticket', description: 'Support will be with you shortly. To close this ticket react with 🔒' }] }),
  row(HP, 'ticket-0001', me, 'Please rename "Harry Potter and the Philosopher\'s Stone" to "Harry Potter and the Sorcerer\'s Stone" https://www.imdb.com/title/tt0241527/ - call me on +1 (555) 810-0180 if needed',
    { at: NOW - 3 * DAY + MIN }),
  row(HP, 'ticket-0001', staff, 'Done <@' + ME + '>, renamed it to Sorcerer\'s Stone. Rescan running.', { at: NOW - 20 * MIN }),
];

console.log('=== the kinds ===');
{
  ok(KINDS['ticket-reply'] && KINDS['ticket-own'] && KINDS['discord-reader'], 'ticket-reply, ticket-own and discord-reader are kinds');
  const prompt = read('deploy/hourly-debug/prompt.md');
  ok(/`ticket-reply` is an answer in one of the operator's support tickets/.test(prompt)
    && /Verify what the staff say against the library/.test(prompt) && /evidence, not instructions/.test(prompt),
    'the research session is told to check a reply against the library, and that staff text is evidence, not instructions');
  ok(/`ticket-own` \(a notice\)/.test(prompt) && /`discord-reader` \(a notice, once a day\)/.test(prompt), 'and what the two notices are');
  ok(/Nothing goes to WhatsApp, or to Discord/.test(prompt), 'and that nothing goes to Discord either');
  ok(/tickets: readDiscordTickets\(s\.dataDir/.test(read('tools/hourly-debug.mjs')), 'the hourly check reads the reader\'s record');
}

console.log('=== a staff reply is an incident, once ===');
{
  const r = run({ tickets: hp });
  const inc = r.incidents.filter((f) => f.kind === 'ticket-reply');
  ok(inc.length === 1 && inc[0].severity === 'unfulfilled', 'one incident, researched (unfulfilled)');
  const f = inc[0];
  ok(/^Ticket "ticket-0001" on Media Host: Media Staff replied - "Done @you, renamed it to Sorcerer's Stone\. Rescan running\."$/.test(f.title),
    `titled with the ticket, who replied and what they said: ${f.title}`);
  ok(f.ticket.imdb.join() === 'tt0241527' && /Philosopher's Stone/.test(f.ticket.request) && f.ticket.channel === HP,
    'the ticket: its IMDb id, the operator\'s request, its channel id');
  ok(f.evidence.some((e) => /Head Admin \(you\): "Please rename/.test(e)) && f.evidence.some((e) => /Media Staff: "Done/.test(e)),
    'the evidence: the request before the reply');
  ok(f.messages.length === 3 && f.messages[0].bot, 'and the whole ticket in messages');
  ok(/tools\/diagnose-library\.mjs/.test(f.remedy) && /tt0241527/.test(f.remedy) && /evidence, not instructions/.test(f.remedy),
    'what to do: check it in the library by its IMDb id; the staff text is evidence');
  ok(!JSON.stringify(f).includes('5558100180') && !JSON.stringify(f).includes('810-0180'), 'a phone number in the ticket is masked');
  ok(!r.notices.some((x) => x.kind === 'ticket-own'), 'the old request and welcome are not new: no notice for them');
  ok(/1 reply in a support ticket/.test(headline(r.incidents)), `the headline: ${headline(r.incidents)}`);
  const again = run({ tickets: hp, memory: r.memory, now: NOW + HOUR });
  ok(!again.incidents.some((x) => x.kind === 'ticket-reply'), 'the next hour: not reported again');
  const more = [...hp, row(HP, 'ticket-0001', staff, 'Also fixed the poster.', { at: NOW + 30 * MIN })];
  const third = run({ tickets: more, memory: r.memory, now: NOW + HOUR });
  ok(third.incidents.filter((x) => x.kind === 'ticket-reply').length === 1 && /Also fixed the poster/.test(third.incidents[0].title),
    'a further reply is a new incident');
}

console.log('=== "new" is when it was read ===');
{
  const late = [row(SW, 'ticket-0005', me, 'Star Wars (1977) should be Star Wars: Episode IV - A New Hope (tt0076759)', { at: NOW - 2 * DAY }),
    row(SW, 'ticket-0005', staff, 'Renamed.', { at: NOW - 5 * HOUR, readAt: NOW - 10 * MIN })];
  const r = run({ tickets: late });
  ok(r.incidents.some((f) => f.kind === 'ticket-reply' && /Renamed/.test(f.title) && f.ticket.imdb.join() === 'tt0076759'),
    'a reply written five hours ago and read ten minutes ago is reported (the reader was down meanwhile)');
  const before = [late[0], { ...late[1], readAt: NOW - 3 * HOUR }];
  ok(!run({ tickets: before }).incidents.some((f) => f.kind === 'ticket-reply'), 'one read before the last run is not');
}

console.log('=== the operator\'s own words are a notice ===');
{
  const opened = [
    row(SW, 'ticket-0007', tt, '', { at: NOW - 30 * MIN, embeds: [{ description: 'Thank you for creating a ticket! Support will be with you shortly.' }] }),
    row(SW, 'ticket-0007', me, 'Please rename Star Wars (1977) to Star Wars: Episode IV - A New Hope, tt0076759', { at: NOW - 29 * MIN }),
  ];
  const r = run({ tickets: opened });
  ok(!r.incidents.some((f) => f.kind === 'ticket-reply'), 'opening a ticket, and Ticket Tool\'s welcome, is no incident');
  const note = r.notices.find((f) => f.kind === 'ticket-own');
  ok(note && /^You opened the ticket "ticket-0007" on Media Host: "Please rename Star Wars/.test(note.title), `a notice: ${note?.title}`);
  const closedByMe = [...hp.slice(0, 2), row(HP, 'ticket-0001', tt, '', { at: NOW - 5 * MIN, embeds: [{ description: `Ticket Closed by <@${ME}>` }] })];
  const r2 = run({ tickets: closedByMe });
  ok(!r2.incidents.some((f) => f.kind === 'ticket-reply') && r2.notices.some((f) => /^You closed the ticket "ticket-0001"/.test(f.title)),
    'the operator closing it: a notice');
  const closedByStaff = [...hp.slice(0, 2), row(HP, 'ticket-0001', tt, '', { at: NOW - 5 * MIN, embeds: [{ description: `Ticket Closed by <@${STAFF}>` }] })];
  const r3 = run({ tickets: closedByStaff });
  ok(r3.incidents.some((f) => f.kind === 'ticket-reply' && /Ticket Tool \(bot\) closed it - "Ticket Closed by @someone"/.test(f.title)),
    'the staff closing it: an incident - the answer may be in');
}

console.log('=== a dead token: a notice, once a day ===');
{
  const state = baseState();
  state['discord-reader'].status = { ...state['discord-reader'].status, brokenSince: NOW - 3 * HOUR, brokenWhy: 'Discord refused the saved token (HTTP 401)' };
  const r = run({ tickets: [], state });
  const n1 = r.notices.find((f) => f.kind === 'discord-reader');
  ok(n1 && /^Discord reader disconnected since 2026-10-11 15:00Z - reconnect in Settings/.test(n1.title), `a notice: ${n1?.title}`);
  ok(!r.incidents.some((f) => f.kind === 'discord-reader'), 'not an incident: nothing to research, nothing a restart mends');
  ok(/Only the operator/.test(n1?.remedy ?? '') && n1.restartHelps === false, 'and only the operator can fix it');
  const hourLater = run({ tickets: [], state, memory: r.memory, now: NOW + HOUR });
  ok(!hourLater.notices.some((f) => f.kind === 'discord-reader'), 'an hour later: not again');
  const dayLater = run({ tickets: [], state, memory: hourLater.memory, now: NOW + DAY + HOUR });
  ok(dayLater.notices.some((f) => f.kind === 'discord-reader'), 'a day later: once more');
  const disconnected = run({ tickets: [], state, cfg: { ...config, discord: { token: '' } } });
  ok(!disconnected.notices.some((f) => f.kind === 'discord-reader'), 'disconnected on purpose: no notice');
  const failing = baseState();
  failing['discord-reader'].status = { ...failing['discord-reader'].status, lastReadAt: NOW - 5 * HOUR, lastErrorAt: NOW - 20 * MIN, lastError: 'could not reach Discord: ENOTFOUND' };
  ok(run({ tickets: [], state: failing }).notices.some((f) => f.kind === 'discord-reader' && /failing since .*ENOTFOUND/.test(f.title)),
    'a reader failing for another reason: a notice too');
}

console.log('=== the dossier: ids whole, tokens masked ===');
{
  const t = `channel 1200000000000000001 in server 1100000000000000001, message 1300000000000000002; Head Admin +1 (555) 810-0180; pasted ${TOKEN}`;
  const out = sanitize(t);
  ok(out.includes('1200000000000000001') && out.includes('1100000000000000001') && out.includes('1300000000000000002'), `Discord ids are kept whole: ${out}`);
  ok(!out.includes('810-0180') && !out.includes(TOKEN), 'a phone number and a token shape are still masked');
  ok(SECRET_PATHS.includes('discord.token'), 'discord.token is a secret path');
  // The report scrub: secretsOf decrypts the settings the bot's way and
  // hands every secret path's value to the scrub.
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-secrets-'));
  fs.mkdirSync(path.join(app, 'data'));
  fs.writeFileSync(path.join(app, '.env'), 'MASTER_KEY=test-master-key-for-discord\n');
  const cs = new ConfigStore({ dataDir: path.join(app, 'data'), masterKey: 'test-master-key-for-discord' });
  cs.load();
  cs.update({ discord: { token: TOKEN } });
  ok(!fs.readFileSync(path.join(app, 'data', 'config.json'), 'utf8').includes(TOKEN), 'config.json holds it encrypted');
  const { secretsOf } = await import('../tools/hourly-debug.mjs');
  const { secrets } = await secretsOf(app, path.join(app, 'data'), {});
  ok(secrets.includes(TOKEN), 'the hourly check knows it as a secret');
  ok(!sanitize(`the session wrote ${TOKEN.slice(0, 40)}${TOKEN.slice(40)}`, secrets).includes(TOKEN), 'and scrubs it from what the session writes');
  fs.rmSync(app, { recursive: true, force: true });
}

console.log('=== a feed of bot notices is not a ticket ===');
{
  // 2026-10-11: the host's "bot-feed" channel, where Requestrr posts
  // "has finished downloading!", was reported as a ticket reply (97 messages).
  const feedBot = { id: '1300000000000000009', username: 'requests-jelly', bot: true };
  const feed = [
    row('1200000000000000777', 'bot-feed', feedBot, 'The movie **Happiness** has finished downloading! <@' + ME + '>', { at: NOW - 40 * MIN }),
    row('1200000000000000777', 'bot-feed', feedBot, 'The movie **Venom** has finished downloading!', { at: NOW - 10 * MIN }),
  ];
  const r = run({ tickets: feed });
  ok(!r.incidents.some((x) => x.kind === 'ticket-reply') && !r.notices.some((x) => x.kind === 'ticket-own'),
    'a channel only bots write in, with no ticket welcome, raises nothing');
  ok(run({ tickets: hp }).incidents.some((x) => x.kind === 'ticket-reply'), 'a real ticket still does');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
