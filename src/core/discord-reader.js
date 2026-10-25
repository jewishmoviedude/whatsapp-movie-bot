/**
 * Discord, read-only, as the operator's own account.
 *
 * The operator ("Head Admin" on Discord) opens support tickets with the
 * Jellyfin host - server "media1", the bot's jf.example-media.org - in the host's
 * Discord server, where the Ticket Tool bot makes a private channel for each
 * ticket: rename "Harry Potter and the Philosopher's Stone" to "...Sorcerer's
 * Stone" (tt0241527), "Star Wars" (1977) to "Star Wars: Episode IV - A New
 * Hope" (tt0076759). The answers came back in Discord, where nothing on this
 * box could see them. The operator, 2026-10-11: "create from scratch a way I
 * can connect my discord account to the ubuntu so you can access it", and
 * before that, "make it that I can sign into my discord with full readonly
 * access to my discord acc". So the hourly check sees how each ticket ended.
 *
 * It signs in with the account's own token, because the tickets are private
 * channels only that account (and the host's staff) can open: a bot of our
 * own could not be added to somebody else's server. The operator was told
 * plainly, and accepted, that automating a personal account is against
 * Discord's terms - the account can be banned - and that the token is the
 * whole account, two-factor or not.
 *
 * So this is the smallest thing that does the job, and it is read-only by
 * construction, not by good intentions:
 *
 *   - get() is the only door, and every request it makes is a GET with no
 *     body: the method is written into the fetch call, not taken from the
 *     caller. Anything else a caller asks for is refused before fetch is
 *     reached, with the reason (readOnlyProblem).
 *   - It can ask for seven things (ALLOWED) and nothing else: who the account
 *     is, its servers and direct-message channels, a server, a server's
 *     channels, a channel, and a channel's messages by before/after/limit.
 *     A path is matched whole, one character class at a time, so "..",
 *     percent-encoding, a backslash, a query string smuggled into the path,
 *     an absolute URL or a second host are all refused rather than resolved.
 *   - The host is fixed. There is no option to point it anywhere but
 *     https://discord.com/api/v10, and the URL it builds is checked once more
 *     after it is built. Redirects are not followed: the token goes to
 *     discord.com and nowhere else.
 *   - It does not pretend to be anything. The User-Agent says what it is,
 *     there are no browser "super properties", and no randomised timing: the
 *     watcher makes a handful of requests every half hour, at fixed times.
 *     Disguising automation is the part of self-botting Discord punishes, and
 *     it would also make this harder to recognise in the account's sessions.
 *   - Rate limits are obeyed, never raced. A 429 is waited out once and the
 *     request retried once; a bucket Discord says is empty is waited for
 *     before the next request; a wait longer than a minute is not made at
 *     all - the request fails and the next run tries again.
 *   - A 401 means the token is dead: the password was changed, or the account
 *     logged out of all devices (which is how the operator revokes it). The
 *     client marks itself broken, says so once (onUnauthorized), and makes
 *     no further request with that token. Retrying a revoked token is how a
 *     client gets an account flagged.
 *
 * The token is held in a private field, so it is not in util.inspect or
 * JSON.stringify of a client, and every message an error carries is scrubbed
 * of it (scrubToken) - including whatever fetch itself put in one.
 */

export const API_BASE = 'https://discord.com/api/v10';
const ORIGIN = 'https://discord.com';
const PREFIX = '/api/v10/';

/** What every request says it is. Honest, and the same every time. */
export const USER_AGENT = 'whatsapp-bot-ticket-reader/1.0 (read-only)';

/** A Discord id: a snowflake, decimal digits. */
export const SNOWFLAKE = /^\d{15,21}$/;

/**
 * Everything this client can ask Discord for, as whole paths under
 * /api/v10/. `query` names the parameters a path may carry and what each must
 * be; a path without it takes none.
 */
export const ALLOWED = Object.freeze([
  { name: 'me', re: /^users\/@me$/ },
  { name: 'guilds', re: /^users\/@me\/guilds$/ },
  { name: 'dm-channels', re: /^users\/@me\/channels$/ },
  { name: 'guild', re: /^guilds\/\d{15,21}$/ },
  { name: 'guild-channels', re: /^guilds\/\d{15,21}\/channels$/ },
  { name: 'channel', re: /^channels\/\d{15,21}$/ },
  { name: 'messages', re: /^channels\/\d{15,21}\/messages$/, query: { before: 'id', after: 'id', limit: 'limit' } },
]);

/**
 * A Discord account token by its shape: the user id in base64, a timestamp,
 * an HMAC - or the older "mfa." form. Used to scrub one out of text whose
 * token is not known here (a pasted error, a quoted log line).
 */
export const TOKEN_SHAPE = /(?:mfa\.[A-Za-z0-9_-]{20,}|\b[MNO][A-Za-z0-9_-]{22,27}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{25,45})(?![A-Za-z0-9_-])/g;

const DEFAULT_TIMEOUT_MS = 15_000;
// A rate-limit wait longer than this is not waited out: the run gives up and
// the next one, half an hour later, tries again.
const DEFAULT_MAX_WAIT_MS = 60_000;

// Not unref'd. A wait Discord asked for is part of a request still being
// made, and has to hold the process open as the request itself does.
// tools/discord.mjs has nothing else keeping it alive, and an unref'd wait let
// it exit with status 0 in the middle of one (2026-10-11: one 429 made
// `whoami` print nothing at all, and an empty bucket cut `tickets --live` off
// after the first server). Every wait is at most maxWaitMs, and the bot's
// shutdown exits outright rather than waiting for its timers.
const sleepFor = (ms) => new Promise((r) => { setTimeout(r, ms); });

/** An error from this client; `code` says which kind. Its message never holds the token. */
export class DiscordError extends Error {
  constructor(message, { code = 'http', status = null, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'DiscordError';
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Text with the token - and anything shaped like one - masked. */
export function scrubToken(text, token = '') {
  let out = String(text ?? '');
  const t = String(token ?? '').trim();
  if (t.length >= 8) {
    for (const v of new Set([t, encodeURIComponent(t)])) out = out.split(v).join('***');
  }
  return out.replace(TOKEN_SHAPE, '***');
}

/**
 * Why `token` cannot be what the operator meant to paste, or null. The common
 * slips are said by name: the whole header line, a bot token ("Bot ..."), an
 * OAuth bearer, quotes from the dev tools' copy.
 */
export function tokenProblem(token) {
  if (typeof token !== 'string' || !token.trim()) return 'Paste the token first.';
  const t = token.trim();
  if (/^authorization\s*:/i.test(t)) return 'Paste only the value of the "authorization" header, not the header name.';
  if (/^bot\s/i.test(t)) return 'That is a bot token. This connects your own account: paste the "authorization" value from your browser.';
  if (/^bearer\s/i.test(t)) return 'That is an OAuth token. Paste the "authorization" value from your browser, which has no "Bearer" in front.';
  if (/^["'].*["']$/.test(t)) return 'Paste the token without the quotes around it.';
  if (!/^[A-Za-z0-9._-]{20,200}$/.test(t)) return 'That does not look like a Discord token: it should be one long word of letters, digits, dots, dashes and underscores.';
  return null;
}

/**
 * Why this request may not be made, or null. The only way a request is
 * allowed: GET, a path matched whole against ALLOWED, and only the query
 * parameters that path takes, each in its own shape.
 */
export function readOnlyProblem(method, path, query = null) {
  if (method !== 'GET') return `only GET is allowed, not ${JSON.stringify(method)}: this client never posts, edits, reacts, marks read or types`;
  if (typeof path !== 'string' || !path) return 'no path';
  if (path.length > 200) return 'the path is too long';
  // Letters, digits, @, /, _ and - are all a path here needs. That leaves out
  // ".", "%", "?", "#", ":", "\" and whitespace: "..", an encoded slash, a
  // query in the path, a scheme or a second host cannot be written at all.
  if (/[^A-Za-z0-9@/_-]/.test(path)) return `${clip(path)} has a character no allowed path has`;
  if (path.startsWith('/') || path.endsWith('/') || path.includes('//')) return `${clip(path)} is not a plain relative path`;
  const route = ALLOWED.find((r) => r.re.test(path));
  if (!route) return `${clip(path)} is not one of the paths this reader may read`;
  if (query == null) return null;
  if (typeof query !== 'object' || Array.isArray(query)) return 'the query must be a set of named values';
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    const kind = route.query?.[k];
    if (!kind) return `${clip(k)} is not a parameter "${route.name}" takes`;
    if (kind === 'id' && !(typeof v === 'string' && SNOWFLAKE.test(v))) return `${k} must be a Discord id`;
    if (kind === 'limit' && !(/^\d{1,3}$/.test(String(v)) && Number(v) >= 1 && Number(v) <= 100)) return 'limit must be a whole number from 1 to 100';
  }
  return null;
}

/** The URL for an allowed request, checked once more after it is built. */
export function requestUrl(path, query = null) {
  const problem = readOnlyProblem('GET', path, query);
  if (problem) throw new DiscordError(`refused before sending: ${problem}`, { code: 'read-only' });
  const url = new URL(`${API_BASE}/${path}`);
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  if (url.origin !== ORIGIN || url.pathname !== `${PREFIX}${path}` || url.username || url.password || url.hash) {
    throw new DiscordError('refused before sending: the URL did not come out as built', { code: 'read-only' });
  }
  return url;
}

// Quoted as JSON, so a newline or a NUL in a refused path cannot break a log line.
const clip = (s, n = 80) => JSON.stringify(String(s).length > n ? `${String(s).slice(0, n)}…` : String(s));

export class DiscordReader {
  #token;
  #broken = null;

  /**
   * @param token          the account token, exactly as the operator pasted it (trimmed)
   * @param fetch          injectable for the tests, which answer as a fake Discord
   * @param onUnauthorized told once, when Discord refuses the token
   */
  constructor({ token, fetch = globalThis.fetch, now = Date.now, sleep = sleepFor, timeoutMs = DEFAULT_TIMEOUT_MS,
    maxWaitMs = DEFAULT_MAX_WAIT_MS, onUnauthorized = null } = {}) {
    const problem = tokenProblem(token);
    if (problem) throw new DiscordError(problem, { code: 'bad-token' });
    this.#token = token.trim();
    this.fetch = fetch;
    this.now = now;
    this.sleep = sleep;
    this.timeoutMs = timeoutMs;
    this.maxWaitMs = maxWaitMs;
    this.onUnauthorized = onUnauthorized;
    // When the next request may be made, as Discord's rate-limit headers say.
    this.resumeAt = 0;
    // Every request that reached fetch, for the watcher's own ceiling and the tests.
    this.requests = 0;
  }

  /** { at, status } once Discord has refused the token, else null. */
  get broken() { return this.#broken ? { ...this.#broken } : null; }

  /** Scrub this client's token (and any token-shaped text) out of `text`. */
  scrub(text) { return scrubToken(text, this.#token); }

  /**
   * The only way this client talks to Discord. Refuses anything but an
   * allowed GET before fetch is reached; then waits its turn, asks, and
   * handles 429 and 401 as the header comment says.
   */
  async get(path, query = null, { method = 'GET' } = {}) {
    const problem = readOnlyProblem(method, path, query);
    if (problem) throw new DiscordError(`refused before sending: ${problem}`, { code: 'read-only' });
    const url = requestUrl(path, query);
    if (this.#broken) {
      throw new DiscordError('the Discord token was refused earlier and has not been replaced: reconnect in Settings', { code: 'broken', status: 401 });
    }
    for (let attempt = 0; ; attempt += 1) {
      await this.#waitTurn();
      let res;
      try {
        this.requests += 1;
        res = await this.fetch(url.toString(), {
          method: 'GET',
          headers: { Authorization: this.#token, 'User-Agent': USER_AGENT, Accept: 'application/json' },
          redirect: 'error',
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        const why = err?.name === 'TimeoutError' || err?.name === 'AbortError'
          ? `Discord did not answer within ${Math.round(this.timeoutMs / 1000)} s`
          : `could not reach Discord: ${err?.cause?.code ?? err?.message ?? 'the request failed'}`;
        throw new DiscordError(this.scrub(why), { code: 'network' });
      }
      this.#noteBucket(res);
      if (res.status === 429) {
        const body = await res.json().catch(() => ({}));
        const secs = Number(body?.retry_after ?? res.headers.get('retry-after'));
        const waitMs = Number.isFinite(secs) && secs >= 0 ? Math.ceil(secs * 1000) : 5000;
        if (attempt === 0 && waitMs <= this.maxWaitMs) {
          await this.sleep(waitMs);
          continue;
        }
        this.resumeAt = Math.max(this.resumeAt, this.now() + waitMs);
        throw new DiscordError(`Discord is rate-limiting this reader (asked to wait ${Math.ceil(waitMs / 1000)} s${body?.global ? ', across the account' : ''}); `
          + 'the next run tries again', { code: 'rate-limited', status: 429, retryAfterMs: waitMs });
      }
      if (res.status === 401) {
        this.#broken = { at: this.now(), status: 401 };
        try { this.onUnauthorized?.(this.broken); } catch { /* the caller's own trouble */ }
        throw new DiscordError('Discord refused the token (HTTP 401): it has been revoked - the password was changed, or the '
          + 'account logged out of all devices. Reconnect in Settings', { code: 'unauthorized', status: 401 });
      }
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const said = typeof body?.message === 'string' ? `: ${this.scrub(body.message).slice(0, 200)}` : '';
        const code = res.status === 403 ? 'forbidden' : res.status === 404 ? 'not-found' : 'http';
        throw new DiscordError(`Discord answered HTTP ${res.status} for ${path}${said}`, { code, status: res.status });
      }
      try {
        return await res.json();
      } catch {
        throw new DiscordError(`Discord's answer for ${path} was not JSON`, { code: 'http', status: res.status });
      }
    }
  }

  async #waitTurn() {
    const wait = this.resumeAt - this.now();
    if (wait <= 0) return;
    if (wait > this.maxWaitMs) {
      throw new DiscordError(`Discord asked this reader to wait ${Math.ceil(wait / 1000)} s; the next run tries again`,
        { code: 'rate-limited', status: 429, retryAfterMs: wait });
    }
    await this.sleep(wait);
  }

  /** X-RateLimit-Remaining 0: the bucket is empty until Reset-After has passed. */
  #noteBucket(res) {
    if (res.headers.get('x-ratelimit-remaining') !== '0') return;
    const after = Number(res.headers.get('x-ratelimit-reset-after'));
    if (Number.isFinite(after) && after > 0) this.resumeAt = Math.max(this.resumeAt, this.now() + Math.ceil(after * 1000));
  }

  /* -------------- the seven things it can ask, by name -------------- */

  me() { return this.get('users/@me'); }

  guilds() { return this.get('users/@me/guilds'); }

  privateChannels() { return this.get('users/@me/channels'); }

  guild(id) { return this.get(`guilds/${idOf(id)}`); }

  guildChannels(id) { return this.get(`guilds/${idOf(id)}/channels`); }

  channel(id) { return this.get(`channels/${idOf(id)}`); }

  /** A channel's messages: { before | after, limit } (1-100). Discord answers newest first. */
  messages(id, { before, after, limit } = {}) {
    return this.get(`channels/${idOf(id)}/messages`, { before, after, limit });
  }
}

/** An id as a path segment: only digits get through; anything else is refused by the path check. */
const idOf = (id) => (typeof id === 'string' || typeof id === 'number' ? String(id) : '?');

/** A name to show for a Discord user: the display name, else the username. */
export function displayName(user) {
  return user?.global_name || user?.username || null;
}
