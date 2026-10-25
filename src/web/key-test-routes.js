/**
 * The "Test key" button behind OMDb, TMDB and the Jellyfin share key in
 * Settings → API keys & logins 🔑.
 *
 * The AI providers card got a per-key Test first (see the Test route in
 * ai-routes.js), and gathering every key into one section made the gap
 * obvious: the three keys that are NOT AI keys could only be proved by
 * waiting for a real request to go wrong in a group. OMDb especially - a key
 * copied one character short means every request is refused with "not found",
 * which reads like an empty library rather than a bad key.
 *
 * The rules are the AI route's rules, because they are what make a test safe
 * to press next to a running bot:
 *
 * - the key typed into the box is tested WITHOUT being saved, so a key can be
 *   tried before it replaces one that works; an empty box, or the mask the
 *   panel shows in place of a saved key, tests the saved key instead;
 * - no key - typed or saved - ever reaches a response, a log line or the
 *   audit trail, even when the service quotes it back inside its own error;
 * - the test changes nothing the bot relies on: it writes no config, trips no
 *   breaker and clears no status;
 * - one test per key every few seconds, behind the same sign-in guard as
 *   saving the settings.
 *
 * Each probe asks the service the way the bot itself asks it, so a pass here
 * means the real path works rather than some cheaper endpoint.
 */
import log from '../util/logger.js';
import { MASK } from '../config/store.js';
import { SECRET_PATHS, getPath } from '../config/schema.js';
import { scrubKeys, KEY_TEST } from '../core/ai-providers.js';
import { testApiKey as omdbLookup } from '../plugins/movie-requests/omdb.js';

const logger = log.scope('api');

// The same shape the AI card accepts: one token of URL-safe characters.
// Anything else pasted in - a sentence, a line break, "Bearer ..." - is a
// mistake worth refusing before it is sent anywhere.
const KEY_SHAPE = /^[A-Za-z0-9._\-]{8,300}$/;

const TIMEOUT_MS = 12_000;

/**
 * Everything secret this install holds, for scrubbing what a service says
 * back. The AI routes scrub the AI keys; a Jellyfin error can quote the share
 * key, and a reverse proxy in front of OMDb could echo anything, so all of
 * them go in the list.
 */
function allSecrets(cfg) {
  return SECRET_PATHS
    .map((p) => getPath(cfg, p))
    .filter((v) => typeof v === 'string' && v.length >= 6);
}

/** A failed probe, in the shape the panel shows: a verdict line and a reason. */
const bad = (reason, message) => ({ ok: false, reason, message });

/** Why a fetch never produced an answer. Timeouts and DNS read very differently to somebody holding a key they just pasted. */
function reasonForThrow(err, label) {
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
    return bad('timeout', `✗ ${label} did not answer within ${Math.round(TIMEOUT_MS / 1000)} s`);
  }
  return bad('network', `✗ Could not reach ${label} — ${err?.message ?? 'the request failed'}`);
}

/**
 * OMDb, by looking up one fixed well-known title - which is exactly what
 * every request does, and is therefore the only thing that proves the key.
 * It does spend one of the day's lookups, which the card says out loud.
 */
async function probeOmdb({ key }) {
  let r;
  try {
    r = await omdbLookup(key, AbortSignal.timeout(TIMEOUT_MS));
  } catch (err) {
    return reasonForThrow(err, 'OMDb');
  }
  if (r.ok) return { ok: true, reason: null, message: '✓ Works — OMDb answered for the test title' };
  const msg = String(r.error ?? '');
  if (/invalid api key|unauthor|http 401/i.test(msg)) return bad('auth', '✗ OMDb rejected the key');
  if (/limit reached|http 429/i.test(msg)) return bad('quota', '✗ The key works, but OMDb\'s daily limit is used up');
  if (/http 5\d\d/i.test(msg)) return bad('server', `✗ OMDb is failing on its side — ${msg}`);
  // testApiKey() catches everything and hands back the message as a string,
  // so the catch above never fires for this probe and a service that is down,
  // or slow, arrived here as an unexplained answer: the pill read "odd
  // answer" and the line read "OMDb did not answer as expected — fetch
  // failed", which is the confusion this whole route exists to prevent. The
  // two cases are told apart by what the failed fetch said instead.
  // `ETIMEDOUT` deliberately does not count as a timeout here: it is the
  // operating system giving up on the connection, not our own 12 seconds, so
  // it belongs with the other ways the service could not be reached.
  if (/abort|timeout|timed out/i.test(msg)) {
    return bad('timeout', `✗ OMDb did not answer within ${Math.round(TIMEOUT_MS / 1000)} s`);
  }
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ETIMEDOUT|socket hang up|network/i.test(msg)) {
    return bad('network', `✗ Could not reach OMDb — ${msg}`);
  }
  // OMDb answers a bad key with a 401 and a plain sentence, so anything else
  // here is the service being odd rather than the key being wrong. Say what
  // it said rather than guessing "bad key" at somebody's good key.
  return bad('unreadable', `✗ OMDb did not answer as expected — ${msg}`);
}

/**
 * TMDB, through the free /configuration endpoint, with the key as the
 * `api_key` parameter - which is how theatrical.js passes it, so a v4 read
 * token that only works as a bearer is correctly reported as not working.
 */
async function probeTmdb({ key }) {
  const url = new URL('https://api.themoviedb.org/3/configuration');
  url.searchParams.set('api_key', key);
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    return reasonForThrow(err, 'TMDB');
  }
  if (res.status === 401 || res.status === 403) return bad('auth', '✗ TMDB rejected the key');
  if (res.status === 429) return bad('quota', '✗ The key works, but TMDB is rate-limiting it just now');
  if (!res.ok) return bad('server', `✗ TMDB answered HTTP ${res.status}`);
  let body = null;
  try { body = await res.json(); } catch { /* handled below */ }
  if (!body?.images?.base_url) return bad('unreadable', '✗ TMDB answered, but not with its configuration');
  return { ok: true, reason: null, message: '✓ Works — TMDB accepted the key' };
}

/**
 * The share key, against the Jellyfin the links will point at. /System/Info
 * is free and needs a valid token, and it names the server - which is worth
 * showing, because pointing the share key at the wrong Jellyfin is a mistake
 * that otherwise only appears as links nobody can play.
 */
async function probeShareKey({ key, cfg }) {
  const baseUrl = String(cfg.library?.jellyfin?.baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!baseUrl) {
    return bad('no-server', '✗ No Jellyfin address is saved yet — set the server URL in Library & files first');
  }
  let res;
  try {
    res = await fetch(`${baseUrl}/System/Info`, {
      headers: { 'X-Emby-Token': key, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return reasonForThrow(err, 'Jellyfin');
  }
  if (res.status === 401 || res.status === 403) return bad('auth', '✗ Jellyfin rejected the key');
  if (!res.ok) return bad('server', `✗ Jellyfin answered HTTP ${res.status}`);
  let body = null;
  try { body = await res.json(); } catch { /* handled below */ }
  if (!body?.Version) return bad('unreadable', '✗ That address answered, but not like a Jellyfin server');
  const name = typeof body.ServerName === 'string' ? body.ServerName : '';
  return { ok: true, reason: null, message: `✓ Works — ${name ? `${name}, ` : ''}Jellyfin ${body.Version}` };
}

/**
 * The keys this route can test. `label` is what the audit trail and every
 * message call the key, so "tested the OMDb key: bad key" reads the same way
 * as the AI card's rows do.
 */
export const TESTABLE_KEYS = Object.freeze({
  omdb: { label: 'OMDb', path: 'omdb.apiKey', probe: probeOmdb },
  tmdb: { label: 'TMDB', path: 'movieRequests.theatrical.tmdbApiKey', probe: probeTmdb },
  'direct-links': { label: 'Jellyfin share', path: 'directLinks.apiKey', probe: probeShareKey },
});

/** One word or two for the audit trail, the way keyTestOutcome() does it for the AI keys. */
export function outcomeWord(r) {
  if (r?.ok) return 'ok';
  return ({
    auth: 'bad key',
    quota: 'quota used up',
    timeout: 'timed out',
    network: 'unreachable',
    server: 'failing on its side',
    unreadable: 'unreadable answer',
    'no-server': 'no server address',
  })[r?.reason] ?? 'failed';
}

export function mountKeyTestRoutes(router, { configStore, guard, audit }) {
  const lastTest = new Map();   // key id -> when its last test started
  const testing = new Set();    // key ids with a test in flight

  router.post('/keys/:id/test', guard, async (req, res) => {
    const id = req.params.id;
    const meta = Object.hasOwn(TESTABLE_KEYS, id) ? TESTABLE_KEYS[id] : null;
    if (!meta) return res.status(404).json({ ok: false, error: 'unknown key' });
    const label = meta.label;
    const refuse = (status, message, extra = {}) => res.status(status).json({
      ok: false, key: id, message, error: message, ...extra,
    });

    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const typedRaw = typeof b.apiKey === 'string' ? b.apiKey.trim() : '';
    const typed = typedRaw && typedRaw !== MASK ? typedRaw : '';
    if (typed && !KEY_SHAPE.test(typed)) {
      // Said without the text itself: it may be a real key with junk around it.
      logger.warn(`refused to test the ${label} key from ${req.session?.user?.username ?? '?'}: not the shape of an API key`);
      // No article: "a OMDb key" and "a TMDB key" both read wrong, and which
      // one a label needs is not worth carrying around for one sentence.
      return refuse(400, `✗ That does not look like the ${label} API key — paste the key alone`, { reason: 'key-shape' });
    }

    const cfg = configStore.get();
    const key = typed || String(getPath(cfg, meta.path) ?? '');
    if (!key) {
      return refuse(400, `✗ No ${label} key to test — paste one into the box, or save one first`, { reason: 'no-key' });
    }

    const wait = KEY_TEST.gapMs - (Date.now() - (lastTest.get(id) ?? -Infinity));
    if (testing.has(id) || wait > 0) {
      return refuse(429, testing.has(id)
        ? `A ${label} test is already running — wait for its result`
        : `${label} was tested a moment ago — wait ${Math.max(1, Math.ceil(wait / 1000))} s and try again`,
      { reason: 'rate-limited', retryAfterMs: Math.max(0, wait) });
    }
    lastTest.set(id, Date.now());
    testing.add(id);

    const scrub = [key, ...allSecrets(cfg)];
    const which = typed ? 'a key typed into the panel, not saved' : 'the saved key';
    try {
      const r = await meta.probe({ key, cfg });
      const out = { ok: !!r.ok, key: id, reason: r.reason ?? null, message: scrubKeys(r.message, scrub) };
      audit(req, `tested the ${label} key: ${outcomeWord(r)}`, which, res);
      // Info, not warn: a test that finds a bad key has done its job, and an
      // error line would email the operator an alert about their own click.
      logger.info(scrubKeys(`${label} key test (${which}): ${out.message}`, scrub));
      res.json(out);
    } catch (err) {
      const message = scrubKeys(`✗ The ${label} test could not run: ${err.message}`, scrub);
      logger.warn(message);
      audit(req, `tested the ${label} key: could not run`, which, res);
      res.status(500).json({ ok: false, key: id, reason: 'failed', message, error: message });
    } finally {
      testing.delete(id);
    }
  });
}
