/* The Discord reader's client is read-only by construction, honest about
   what it is, and careful with the account. Run: node test/discord-reader.test.mjs

   The operator, 2026-10-11: "create from scratch a way I can connect my
   discord account to the ubuntu so you can access it", and earlier "make it
   that I can sign into my discord with full readonly access to my discord
   acc". The token is the whole account and automating it is against
   Discord's terms, which the operator accepted; what this suite pins is
   everything that keeps the risk to the least the request needs:

   - it can only GET, and only seven kinds of path; any other method, path or
     parameter - "..", an encoded slash, a query in the path, an absolute URL,
     another host - is refused before fetch is called at all;
   - the host is https://discord.com/api/v10 whatever the caller passes, and
     redirects are not followed;
   - it says what it is (an honest User-Agent) and sends nothing that would
     pass it off as the Discord client;
   - a 429 is waited out once, a long one not at all, an empty bucket before
     the next request; a 401 stops it for good, without a second try;
   - the token is in no error message, and not in the client when it is
     printed or serialised.

   There is no Discord token here: test/fixtures/fake-discord.mjs is a fake
   Discord on 127.0.0.1, reached only through a fetch that refuses any URL not
   aimed at https://discord.com. */
import util from 'node:util';
import fs from 'node:fs';
import {
  DiscordReader, DiscordError, readOnlyProblem, requestUrl, tokenProblem, scrubToken, ALLOWED, USER_AGENT, API_BASE,
} from '../src/core/discord-reader.js';
import { fakeDiscord } from './fixtures/fake-discord.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

// Shaped like a real account token (a user id in base64, a stamp, an HMAC),
// so a scrub that only knew the shape would be caught too. Not a real one.
const TOKEN = 'MTA5ODc2NTQzMjE5ODc2NTQzMg' + '.GxYzAb.' + 'fake-test-token_not-real_0123456789ab';
const ME = '1098765432198765432';
const GUILD = '1100000000000000001';
const CH = '1200000000000000001';

const D = await fakeDiscord({
  token: TOKEN,
  me: { id: ME, username: 'headadmin', global_name: 'Head Admin' },
  guilds: [{ id: GUILD, name: 'Media Host' }],
  channels: { [GUILD]: [{ id: CH, name: 'ticket-0001', type: 0 }] },
  messages: { [CH]: [] },
});
let clock = Date.parse('2026-10-11T15:00:00Z');
const sleeps = [];
const client = (o = {}) => new DiscordReader({
  token: TOKEN, fetch: D.fetch, now: () => clock, sleep: async (ms) => { sleeps.push(ms); }, ...o,
});
const refused = async (p, why) => {
  try { await p; return `not refused (${why})`; } catch (err) { return err instanceof DiscordError ? err : `threw ${err?.message}`; }
};

console.log('=== only GET, refused before anything is sent ===');
{
  const c = client();
  const before = D.aimed.length;
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'get', 'Get', '', null, 'GET ', ' GET']) {
    ok(readOnlyProblem(method, 'users/@me') !== null, `${JSON.stringify(method)} is refused by the check`);
    const err = await refused(c.get('users/@me', null, { method }), method);
    ok(err?.code === 'read-only', `and by get() (${err?.message ?? err})`);
  }
  // The writes the account could make, each by the path it would take.
  for (const [method, p] of [['POST', `channels/${CH}/messages`], ['POST', `channels/${CH}/typing`],
    ['PUT', `channels/${CH}/messages/1200000000000000009/reactions/%F0%9F%91%8D/@me`], ['PATCH', `channels/${CH}/messages/1200000000000000009`],
    ['DELETE', `channels/${CH}/messages/1200000000000000009`], ['POST', `channels/${CH}/messages/1200000000000000009/ack`]]) {
    ok((await refused(c.get(p, null, { method }), p))?.code === 'read-only', `${method} ${p} - refused`);
  }
  ok(D.aimed.length === before && c.requests === 0, 'and not one of them reached fetch');
}

console.log('=== only the seven paths, matched whole ===');
{
  const c = client();
  const before = D.aimed.length;
  const tricks = [
    '/users/@me', 'users/@me/', 'users//@me', 'users/@me/../../oauth2/token', 'users/@me/./guilds', '..', 'users/%40me',
    `channels/${CH}%2Fmessages`, `channels/${CH}/messages%3Flimit=5`, `channels/${CH}/messages?limit=5`, `channels/${CH}/messages#frag`,
    'https://evil.example/api/v10/users/@me', 'http://discord.com/api/v10/users/@me', 'https://discord.com/api/v10/users/@me',
    '//evil.example/users/@me', 'discord.com.evil.example/users/@me', 'users/@me\\..\\..\\oauth2', 'users/@me∕guilds',
    'users/@me guilds', 'users/@me\nguilds', 'users/@me\u0000', 'users/@me/settings', 'users/@me/relationships', 'users/@me/billing',
    `guilds/${GUILD}/members`, `guilds/${GUILD}/members/@me`, `guilds/${GUILD}/roles`, `channels/${CH}/messages/1200000000000000009`,
    `channels/${CH}/typing`, `channels/${CH}/pins`, `channels/${CH}/messages/1200000000000000009/ack`, 'channels/abc/messages',
    'channels/123/messages', 'oauth2/token', 'gateway', 'auth/login', `channels/${CH}/messages/../../users/@me`, '', 'USERS/@ME',
    `channels/${CH}/messages/`, `users/@me/channels/../guilds`, `invites/abc`, `channels/${CH}/invites`,
  ];
  for (const p of tricks) {
    const why = readOnlyProblem('GET', p);
    const err = await refused(c.get(p), p);
    ok(why !== null && err?.code === 'read-only', `${JSON.stringify(p)} - refused: ${why}`);
  }
  for (const q of [{ limit: 101 }, { limit: 0 }, { limit: '5; drop' }, { limit: 2.5 }, { around: '1200000000000000009' },
    { after: 'abc' }, { after: 1200000000000000009 }, { before: '../x' }, { with_counts: true }]) {
    const err = await refused(c.get(`channels/${CH}/messages`, q), JSON.stringify(q));
    ok(err?.code === 'read-only', `messages with ${JSON.stringify(q)} - refused (${err?.message ?? err})`);
  }
  ok((await refused(c.get('users/@me', { limit: 5 }), 'q'))?.code === 'read-only', 'a parameter on a path that takes none - refused');
  ok((await refused(c.get(`channels/${CH}/messages`, 'limit=5'), 'q'))?.code === 'read-only', 'a query as text - refused');
  ok(D.aimed.length === before && c.requests === 0, `none of the ${tricks.length} tricks reached fetch`);
  ok(ALLOWED.length === 7 && ALLOWED.map((r) => r.name).join() === 'me,guilds,dm-channels,guild,guild-channels,channel,messages',
    'the list is the seven things the reader needs, and nothing else');
}

console.log('=== the host is fixed ===');
{
  // Whatever a caller passes, there is no option for another host.
  const c = client({ base: 'https://evil.example/api', baseUrl: 'https://evil.example', host: 'evil.example', origin: 'http://127.0.0.1' });
  const from = D.aimed.length;
  const u = await c.me();
  const sent = D.aimed.slice(from);
  ok(u.id === ME && sent.length === 1 && sent[0].url === `${API_BASE}/users/@me`, `it asked ${sent[0]?.url}`);
  ok(API_BASE === 'https://discord.com/api/v10', 'which is https://discord.com/api/v10');
  ok(sent[0].redirect === 'error', 'and redirects are not followed: the token goes to discord.com and nowhere else');
  ok(sent[0].method === 'GET' && sent[0].body === undefined, 'a GET with no body');
  const url = requestUrl(`channels/${CH}/messages`, { after: '1200000000000000002', limit: 100 });
  ok(url.origin === 'https://discord.com' && url.pathname === `/api/v10/channels/${CH}/messages` && url.search === '?after=1200000000000000002&limit=100',
    `a messages URL comes out as built: ${url}`);
  const src = fs.readFileSync(new URL('../src/core/discord-reader.js', import.meta.url), 'utf8');
  ok((src.match(/this\.fetch\(/g) ?? []).length === 1 && /this\.fetch\(url\.toString\(\), \{\n\s+method: 'GET',/.test(src),
    'there is one fetch call in the client, and its method is the literal GET, not the caller\'s');
}

console.log('=== it says what it is, and nothing else ===');
{
  const c = client();
  const from = D.requests.length;
  await c.me();
  await c.guilds();
  await c.guildChannels(GUILD);
  await c.messages(CH, { limit: 5 });
  const seen = D.requests.slice(from);
  ok(seen.length === 4 && seen.every((r) => r.ua === USER_AGENT), `every request: User-Agent "${USER_AGENT}"`);
  ok(/whatsapp-bot-ticket-reader/.test(USER_AGENT) && !/mozilla|chrome|safari|discord\//i.test(USER_AGENT), 'no browser or Discord client name in it');
  const forged = ['x-super-properties', 'x-discord-locale', 'x-discord-timezone', 'x-debug-options', 'x-fingerprint', 'x-context-properties', 'origin', 'referer', 'cookie'];
  ok(seen.every((r) => forged.every((h) => !(h in r.headers))), `none of the headers the web client sends to look like itself (${forged.slice(0, 4).join(', ')}, ...)`);
  ok(seen.every((r) => r.auth === TOKEN), 'the Authorization header is the token as given - no "Bot", no "Bearer"');
  const spaced = client({ token: `  ${TOKEN}\n` });
  const f2 = D.requests.length;
  await spaced.me();
  ok(D.requests[f2].auth === TOKEN, 'a token pasted with a newline after it is trimmed');
}

console.log('=== the token: refused when it is plainly not one, and never shown ===');
{
  for (const [bad, why] of [[`Bot ${TOKEN}`, /bot token/], [`Bearer ${TOKEN}`, /OAuth/], [`authorization: ${TOKEN}`, /value of the "authorization" header/],
    [`"${TOKEN}"`, /quotes/], ['short', /does not look like/], [`${TOKEN} extra`, /does not look like/], ['', /Paste the token/]]) {
    ok(why.test(tokenProblem(bad) ?? ''), `${JSON.stringify(bad.slice(0, 12))}…: ${tokenProblem(bad)}`);
  }
  ok(tokenProblem(TOKEN) === null, 'the real shape passes');
  let threw = null;
  try { new DiscordReader({ token: 'Bot abc', fetch: D.fetch }); } catch (err) { threw = err; }
  ok(threw?.code === 'bad-token', 'a client cannot be made with one that is not');
  const c = client();
  ok(!util.inspect(c, { depth: 5 }).includes(TOKEN) && !JSON.stringify(c).includes(TOKEN), 'printing or serialising a client shows no token');
  ok(scrubToken(`header was ${TOKEN} and ${encodeURIComponent(TOKEN)}`, TOKEN) === 'header was *** and ***', 'scrubToken masks it, encoded too');
  ok(scrubToken('another: NzEyMzQ1Njc4OTAxMjM0NTY3OA' + '.AbCdEf.' + 'abcdefghijklmnopqrstuvwxyz0123456789AB') === 'another: ***',
    'and anything shaped like one');
  ok(scrubToken('The.Matrix.1999.1080p.mkv and tt0133093') === 'The.Matrix.1999.1080p.mkv and tt0133093', 'but not a dotted file name or an IMDb id');
  const leaky = new DiscordReader({ token: TOKEN, fetch: async () => { throw new Error(`connect ECONNREFUSED (Authorization: ${TOKEN})`); } });
  const err = await refused(leaky.me(), 'network');
  ok(err?.code === 'network' && !err.message.includes(TOKEN), `a network error that quoted the token is scrubbed: "${err?.message}"`);
  const echo = new DiscordReader({ token: TOKEN, fetch: async () => new Response(JSON.stringify({ message: `bad token ${TOKEN}` }), { status: 403 }) });
  const e2 = await refused(echo.me(), '403');
  ok(e2?.status === 403 && !e2.message.includes(TOKEN), `and so is a refusal that echoed it: "${e2?.message}"`);
}

console.log('=== a 401: the token is dead, and is never tried again ===');
{
  let told = 0;
  const c = client({ onUnauthorized: () => { told += 1; } });
  D.scene.revoked = true;
  const from = D.requests.length;
  const err = await refused(c.me(), '401');
  ok(err?.code === 'unauthorized' && err.status === 401, `refused: ${err?.message}`);
  ok(/password was changed|logged out of all devices/.test(err?.message) && /Reconnect in Settings/.test(err?.message), 'saying what revokes a token and what to do');
  ok(!err.message.includes(TOKEN), 'with no token in it');
  ok(told === 1 && c.broken?.status === 401, 'the client marks itself broken, and says so once');
  const again = await refused(c.guilds(), 'after');
  ok(again?.code === 'broken' && D.requests.length === from + 1, 'the next call is refused without a request: a 401 is never retried');
  await refused(c.messages(CH, { limit: 5 }), 'after');
  ok(told === 1 && D.requests.length === from + 1, 'nor the one after');
  D.scene.revoked = false;
}

console.log('=== 429: waited out once, then given up ===');
{
  sleeps.length = 0;
  const c = client();
  D.scene.rateLimit = { times: 1, retryAfter: 0.25 };
  const from = D.requests.length;
  const u = await c.me();
  ok(u.id === ME && D.requests.length === from + 2, 'one 429, then the same request once more, answered');
  ok(sleeps.includes(250), `it waited the retry_after Discord gave (${sleeps.join(', ')} ms)`);

  D.scene.rateLimit = { times: 2, retryAfter: 0.1 };
  const f2 = D.requests.length;
  const err = await refused(c.me(), 'twice');
  ok(err?.code === 'rate-limited' && D.requests.length === f2 + 2, `two 429s in a row: two requests and it gives up (${err?.message})`);
  D.scene.rateLimit = null;

  sleeps.length = 0;
  const slow = client();
  D.scene.rateLimit = { times: 1, retryAfter: 120, global: true };
  const f3 = D.requests.length;
  const e3 = await refused(slow.me(), 'long');
  ok(e3?.code === 'rate-limited' && !sleeps.length && D.requests.length === f3 + 1, 'a wait of two minutes is not made: one request, no sleep, an error');
  ok(/across the account/.test(e3?.message), `and a global limit says so (${e3?.message})`);
  D.scene.rateLimit = null;
  const e4 = await refused(slow.guilds(), 'still');
  ok(e4?.code === 'rate-limited' && D.requests.length === f3 + 1, 'until it has passed, the next call is not sent at all');
  clock += 121_000;
  ok((await slow.guilds())?.length === 1, 'and after it has, it is');
}

console.log('=== X-RateLimit-Remaining 0: the next request waits for the reset ===');
{
  sleeps.length = 0;
  const c = client();
  D.scene.emptyBucket = { resetAfter: 2.5 };
  await c.me();
  ok(!sleeps.length, 'the request that emptied the bucket is not delayed');
  await c.guilds();
  ok(sleeps[0] === 2500, `the next one waits the reset first (${sleeps.join(', ')} ms)`);
}

await D.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
