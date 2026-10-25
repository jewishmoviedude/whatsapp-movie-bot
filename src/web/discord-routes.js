/**
 * Settings -> Connection -> "Discord (read-only)": connecting the operator's
 * own Discord account, choosing what it reads, and seeing how the reader is
 * doing (src/core/discord-watch.js).
 *
 * The operator, 2026-10-11: "create from scratch a way I can connect my
 * discord account to the ubuntu so you can access it". The token pasted here
 * is the whole account - it gets past two-factor, and only a password change
 * or "Log out of all devices" takes it back - so:
 *
 *   - only the super-admin may connect, disconnect, or change what is read,
 *     and a plain admin who tries is refused, logged and audited; everyone
 *     signed in may see whether it is connected and as whom;
 *   - a token is checked with Discord (GET users/@me) before it is saved, and
 *     saved only through ConfigStore, which encrypts it (SECRET_PATHS);
 *   - no response, log line or audit row carries it, and anything Discord or
 *     fetch says back is scrubbed of it first; a settings save (PUT /config)
 *     that carries any of the discord section is refused in api.js, so this
 *     card is the only way in;
 *   - the routes that ask Discord something (the server list, the channel
 *     preview, Read now, Connect) are each held to one call every few
 *     seconds, so a stuck button cannot become a burst on the account;
 *   - once Discord has refused the saved token (401), the server list, the
 *     channel preview and Read now answer 409 and ask Discord nothing; only
 *     Connect, with a new token, goes on. They used to check only that a
 *     token was saved, and "Load my servers" pressed after the card said
 *     "disconnected - reconnect" sent the revoked token again (2026-10-11,
 *     review).
 */
import log from '../util/logger.js';
import { isSuperAdmin } from './auth.js';
import { tokenProblem, scrubToken, SNOWFLAKE } from '../core/discord-reader.js';
import { DiscordWatch, NAMESPACE, patternProblem, watchSettings, DEFAULT_PATTERN, BROKEN_MESSAGE } from '../core/discord-watch.js';

const logger = log.scope('api');

// The least time between two calls of one route that asks Discord something.
export const DISCORD_ROUTE_GAP_MS = { connect: 5_000, guilds: 10_000, channels: 10_000, read: 60_000 };

/** What is wrong with a watch save, or null; `out` gets the cleaned value. */
export function watchProblem(body, out = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'send { guilds, channelPattern, channels }';
  const list = (v, what) => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) throw new Error(`${what} must be a list of Discord ids`);
    const ids = v.map((x) => String(x ?? '').trim()).filter(Boolean);
    const bad = ids.find((x) => !SNOWFLAKE.test(x));
    if (bad) throw new Error(`"${bad.slice(0, 40)}" in ${what} is not a Discord id (digits only)`);
    if (ids.length > 50) throw new Error(`at most 50 ${what}`);
    return [...new Set(ids)];
  };
  try {
    out.guilds = list(body.guilds, 'servers');
    out.channels = list(body.channels, 'channels');
  } catch (err) {
    return err.message;
  }
  const pattern = body.channelPattern === undefined || body.channelPattern === '' ? DEFAULT_PATTERN : body.channelPattern;
  const p = patternProblem(pattern);
  if (p) return p;
  out.channelPattern = pattern;
  return null;
}

export function mountDiscordRoutes(router, { configStore, stateStore, guard, audit, discord = null }) {
  const watcher = discord ?? new DiscordWatch({
    dataDir: configStore.dataDir, configStore, store: stateStore.namespace(NAMESPACE), audit: stateStore.namespace('audit'),
  });
  const last = new Map();
  const tooSoon = (route) => {
    const now = Date.now();
    if (now - (last.get(route) ?? 0) < DISCORD_ROUTE_GAP_MS[route]) return true;
    last.set(route, now);
    return false;
  };
  const scrub = (text) => scrubToken(text, configStore.get()?.discord?.token);
  const isSuper = (req) => isSuperAdmin(configStore, req.session?.user);

  /** Refuse a plain admin, with a log line and an audit row. */
  const superOnly = (what) => (req, res, next) => {
    if (isSuper(req)) return next();
    logger.warn(`refused "${req.session?.user?.username ?? '?'}": ${what} - the super-admin only`);
    audit(req, `refused: ${what}`, 'Only the super-admin can connect, disconnect or change the Discord reader.', res);
    return res.status(403).json({ error: 'Only the super-admin can connect, disconnect or change the Discord reader.' });
  };

  /** A Discord failure as the panel shows it. */
  const answerError = (res, err) => {
    const status = { unauthorized: 400, 'bad-token': 400, broken: 409, 'rate-limited': 429 }[err?.code] ?? 502;
    res.status(status).json({ error: scrub(err?.message ?? String(err)), code: err?.code ?? null });
  };

  /**
   * Refuse a route that would ask Discord something: nothing saved, or a
   * token Discord has refused. Returns whether it answered. Checked before
   * the route's own gap, so a refused press does not hold the next one back.
   */
  const notUsable = (res) => {
    if (!watcher.token) { res.status(400).json({ error: 'Connect Discord first.' }); return true; }
    if (watcher.deadSince()) { res.status(409).json({ error: `${BROKEN_MESSAGE}.`, code: 'broken' }); return true; }
    return false;
  };

  router.get('/discord', guard, (req, res) => {
    res.json({ ...watcher.panelStatus({ full: isSuper(req) }), canChange: isSuper(req) });
  });

  router.post('/discord/connect', guard, superOnly('connect Discord'), async (req, res) => {
    const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    const problem = tokenProblem(token);
    if (problem) {
      audit(req, 'refused: connect Discord', problem, res);
      return res.status(400).json({ error: problem });
    }
    if (tooSoon('connect')) return res.status(429).json({ error: 'One try every few seconds - wait a moment and press Connect again.' });
    let user;
    try {
      user = await watcher.verify(token);
    } catch (err) {
      const why = err?.code === 'unauthorized'
        ? 'Discord did not accept that token. Copy it again from a request the Discord web app makes while you are signed in.'
        : scrubToken(err?.message ?? String(err), token);
      logger.warn(`connecting Discord failed: ${why}`);
      audit(req, 'refused: connect Discord', `${why} Nothing was saved.`, res);
      return answerError(res, { ...err, code: err?.code, message: `${why} Nothing was saved.` });
    }
    const was = watcher.status().user;
    configStore.update({ discord: { token } });
    watcher.connected(user, req.session?.user?.username ?? null);
    const who = user.username ?? user.name ?? user.id;
    logger.info(`Discord connected as ${who} (read-only)`);
    audit(req, `connected Discord as ${who}`,
      `read-only${was?.username && was.username !== user.username ? `; replaced ${was.username}` : ''}`, res);
    res.json({ ...watcher.panelStatus({ full: true }), canChange: true });
  });

  router.post('/discord/disconnect', guard, superOnly('disconnect Discord'), (req, res) => {
    const was = watcher.status().user;
    const had = !!configStore.get()?.discord?.token;
    configStore.update({ discord: { token: '' } });
    watcher.disconnected();
    logger.info(`Discord disconnected${was?.username ? ` (was ${was.username})` : ''}; the token is wiped from this box`);
    audit(req, 'disconnected Discord', had ? `was connected as ${was?.username ?? 'an account'}; the token was wiped` : 'nothing was connected', res);
    res.json({ ...watcher.panelStatus({ full: true }), canChange: true });
  });

  router.get('/discord/guilds', guard, superOnly('list the Discord servers'), async (req, res) => {
    if (notUsable(res)) return;
    if (tooSoon('guilds')) return res.status(429).json({ error: 'The server list was just loaded - wait a few seconds.' });
    try {
      res.json({ guilds: await watcher.guildList() });
    } catch (err) {
      answerError(res, err);
    }
  });

  router.get('/discord/channels', guard, superOnly('list Discord channels'), async (req, res) => {
    if (notUsable(res)) return;
    const saved = watchSettings(configStore.get());
    const guilds = req.query.guild ? [String(req.query.guild)] : saved.guilds;
    if (guilds.some((g) => !SNOWFLAKE.test(g))) return res.status(400).json({ error: 'That is not a Discord server id.' });
    if (!guilds.length) return res.status(400).json({ error: 'Choose a server first.' });
    if (guilds.length > 5) return res.status(400).json({ error: 'At most five servers at a time.' });
    const patternText = typeof req.query.pattern === 'string' && req.query.pattern ? req.query.pattern : saved.patternText;
    const p = patternProblem(patternText);
    if (p) return res.status(400).json({ error: p });
    if (tooSoon('channels')) return res.status(429).json({ error: 'The channels were just looked up - wait a few seconds.' });
    const pattern = new RegExp(patternText, 'i');
    const names = watcher.store.get('guildNames', {}) ?? {};
    const out = [];
    try {
      for (const g of guilds) out.push({ guild: g, guildName: names[g] ?? null, channels: await watcher.matchingChannels(g, pattern) });
    } catch (err) {
      return answerError(res, err);
    }
    res.json({ pattern: patternText, guilds: out });
  });

  router.put('/discord/watch', guard, superOnly('change what the Discord reader reads'), (req, res) => {
    const clean = {};
    const problem = watchProblem(req.body, clean);
    if (problem) {
      audit(req, 'refused: change what the Discord reader reads', problem, res);
      return res.status(400).json({ error: problem });
    }
    const names = watcher.store.get('guildNames', {}) ?? {};
    configStore.update({ discord: { watch: clean } });
    const servers = clean.guilds.map((g) => names[g] ?? g).join(', ') || 'no server';
    audit(req, 'changed what the Discord reader reads',
      `${servers}; channels named /${clean.channelPattern}/${clean.channels.length ? `; and ${clean.channels.length} channel id(s)` : ''}`, res);
    res.json({ ...watcher.panelStatus({ full: true }), canChange: true });
  });

  router.post('/discord/read-now', guard, superOnly('read Discord now'), async (req, res) => {
    if (notUsable(res)) return;
    if (tooSoon('read')) return res.status(429).json({ error: 'It read a moment ago - once a minute at most.' });
    const r = await watcher.run({ force: true });
    audit(req, 'read Discord now', r.skipped ? `skipped: ${r.skipped}`
      : `${r.requests} request(s), ${r.appended} new message(s)${r.errors?.length ? `; ${scrub(r.errors.join('; ')).slice(0, 200)}` : ''}`, res);
    res.json({ result: { ...r, errors: (r.errors ?? []).map(scrub) }, ...watcher.panelStatus({ full: true }), canChange: true });
  });
}
