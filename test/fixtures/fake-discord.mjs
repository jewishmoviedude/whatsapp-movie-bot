/* A fake Discord for the Discord reader's suites: a real HTTP server on
   127.0.0.1 that answers the API v10 paths the reader may read, and a fetch
   that only lets a request through to it when the reader aimed it at
   https://discord.com - so a suite proves the host, not just the path.

   No suite has, or needs, a real token; nothing here can reach discord.com.

   `scene` changes how it answers, for one case at a time:
     revoked          every request is a 401, as after a password change
     rateLimit        { times, retryAfter (s), global } - the next `times` requests are 429s
     emptyBucket      { resetAfter (s) } - the next answer says X-RateLimit-Remaining 0
     forbid           Set of channel ids answered 403 (somebody else's ticket)
     deleted          Set of message ids deleted: no longer in a channel's messages, but
                      still its last_message_id when it was the newest, as Discord leaves it */
import http from 'node:http';

const realFetch = globalThis.fetch;

export const DISCORD_EPOCH = 1420070400000n;
/** A snowflake for the moment `ms`, with `seq` in the low bits so ids made in one millisecond differ. */
export const flake = (ms, seq = 0) => (((BigInt(ms) - DISCORD_EPOCH) << 22n) + BigInt(seq)).toString();

export async function fakeDiscord({ token, me, guilds = [], channels = {}, messages = {} }) {
  const requests = [];
  const scene = { revoked: false, rateLimit: null, emptyBucket: null, forbid: new Set(), deleted: new Set() };
  const state = { token, me, guilds, channels, messages };

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const row = {
      method: req.method, path: u.pathname.replace(/^\/api\/v10\//, ''), query: Object.fromEntries(u.searchParams),
      auth: req.headers.authorization ?? null, ua: req.headers['user-agent'] ?? null, headers: { ...req.headers },
    };
    requests.push(row);
    if (req.method !== 'GET') return send(res, 405, { message: '405: Method Not Allowed', code: 0 });
    if (scene.rateLimit?.times > 0) {
      scene.rateLimit.times -= 1;
      return send(res, 429, { message: 'You are being rate limited.', retry_after: scene.rateLimit.retryAfter ?? 0.01, global: !!scene.rateLimit.global },
        { 'retry-after': String(Math.ceil(scene.rateLimit.retryAfter ?? 0.01)) });
    }
    if (scene.revoked || row.auth !== state.token) return send(res, 401, { message: '401: Unauthorized', code: 0 });
    const bucket = scene.emptyBucket ? { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': String(scene.emptyBucket.resetAfter) }
      : { 'x-ratelimit-remaining': '4', 'x-ratelimit-reset-after': '1' };
    scene.emptyBucket = null;
    const p = row.path;
    let m;
    if (p === 'users/@me') return send(res, 200, state.me, bucket);
    if (p === 'users/@me/guilds') return send(res, 200, state.guilds, bucket);
    if (p === 'users/@me/channels') return send(res, 200, [], bucket);
    if ((m = /^guilds\/(\d+)$/.exec(p))) {
      const g = state.guilds.find((x) => x.id === m[1]);
      return g ? send(res, 200, g, bucket) : send(res, 404, { message: 'Unknown Guild', code: 10004 });
    }
    if ((m = /^guilds\/(\d+)\/channels$/.exec(p))) {
      const list = state.channels[m[1]];
      if (!list) return send(res, 403, { message: 'Missing Access', code: 50001 });
      // last_message_id as Discord keeps it: the newest message's id.
      return send(res, 200, list.map((c) => ({ ...c, guild_id: m[1], last_message_id: lastId(c.id) })), bucket);
    }
    if ((m = /^channels\/(\d+)$/.exec(p))) {
      for (const [g, list] of Object.entries(state.channels)) {
        const c = list.find((x) => x.id === m[1]);
        if (c) return send(res, 200, { ...c, guild_id: g, last_message_id: lastId(c.id) }, bucket);
      }
      return send(res, 404, { message: 'Unknown Channel', code: 10003 });
    }
    if ((m = /^channels\/(\d+)\/messages$/.exec(p))) {
      if (scene.forbid.has(m[1])) return send(res, 403, { message: 'Missing Access', code: 50001 });
      let list = [...(state.messages[m[1]] ?? [])].filter((x) => !scene.deleted.has(x.id)).sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
      const limit = Math.min(100, Number(row.query.limit ?? 50));
      if (row.query.after) list = list.filter((x) => BigInt(x.id) > BigInt(row.query.after)).slice(0, limit);
      else if (row.query.before) list = list.filter((x) => BigInt(x.id) < BigInt(row.query.before)).slice(-limit);
      else list = list.slice(-limit);
      // Discord answers newest first.
      return send(res, 200, list.reverse().map((x) => ({ channel_id: m[1], ...x })), bucket);
    }
    return send(res, 404, { message: '404: Not Found', code: 0 });
  });
  const lastId = (channelId) => {
    const list = state.messages[channelId] ?? [];
    return list.length ? list.reduce((a, b) => (BigInt(a.id) > BigInt(b.id) ? a : b)).id : null;
  };

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const aimed = [];

  /** What the reader is given as fetch: Discord's address in, the fake out. */
  const fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    aimed.push({ url: u.toString(), method: init.method ?? 'GET', headers: { ...(init.headers ?? {}) }, redirect: init.redirect, body: init.body });
    if (u.origin !== 'https://discord.com') throw new Error(`the reader aimed a request at ${u.origin}, not https://discord.com`);
    return realFetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, init);
  };

  return {
    fetch, requests, aimed, scene, state, port,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}

/** A Discord message as the API answers it. */
export function msg({ id, at, author, content = '', embeds = [], attachments = [], type = 0 }) {
  return { id, type, content, embeds, attachments, author, timestamp: new Date(at).toISOString() };
}
