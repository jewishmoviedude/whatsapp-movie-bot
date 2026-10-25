/* A nudity check that keeps failing must tell someone, once, and say why.
   Run: node test/content-check-alert.test.mjs

   2026-09-22: the content check did not run all morning, for three different
   reasons in turn. First gemini-2.0-flash was retired and every call got HTTP
   404. Then, on gemini-3.6-flash, every reply was cut off by the token cap
   (finishReason MAX_TOKENS). Then the free tier's 20-requests-a-day quota ran
   out and every call got HTTP 429. Each time checkNudity() returned null, the
   gate fell back to the rating as designed, and the only trace was one warn
   line per film. Nobody was told, and films went out with no nudity check.

   The error bodies below are the shapes the Gemini API really returns. No
   network: globalThis.fetch is stubbed throughout. */
import fs from 'node:fs';
import log from '../src/util/logger.js';
import { checkNudity } from '../src/plugins/movie-requests/content-check.js';
import { geminiHttpFailure, redactKey } from '../src/plugins/movie-requests/gemini.js';
import {
  ContentCheckHealth, describeFailure, untilMidnightPacific, ALERT_DEFAULTS,
} from '../src/core/content-check-health.js';
import { AlertWatcher } from '../src/core/alerts.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const KEY = 'AIzaSyTESTKEY_0123456789-abcdefghijklmno';
const lines = [];
log.on('line', (e) => lines.push(`${e.level} ${e.scope}: ${e.msg}`));

/* ------------------------------ fixtures ------------------------------ */

const BODY_404 = JSON.stringify({ error: {
  code: 404,
  message: 'models/gemini-2.0-flash is not found for API version v1beta, or is not supported for generateContent.',
  status: 'NOT_FOUND',
} });

// The key is echoed into the message on purpose: whatever Google sends back,
// it must never reach an email, the panel or the log.
const BODY_429_DAILY = JSON.stringify({ error: {
  code: 429,
  message: `You exceeded your current quota. key=${KEY} * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-3.6-flash\nPlease retry in 37.49s.`,
  status: 'RESOURCE_EXHAUSTED',
  details: [
    { '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
      violations: [{
        quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
        quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
        quotaDimensions: { location: 'global', model: 'gemini-3.6-flash' },
        quotaValue: '20',
      }] },
    { '@type': 'type.googleapis.com/google.rpc.Help', links: [{ description: 'Learn more', url: 'https://ai.google.dev/gemini-api/docs/rate-limits' }] },
    { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '37s' },
  ],
} });

const BODY_429_MINUTE = JSON.stringify({ error: {
  code: 429, message: 'Resource has been exhausted.', status: 'RESOURCE_EXHAUSTED',
  details: [
    { '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
      violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier', quotaValue: '10' }] },
    { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '12s' },
  ],
} });

const BODY_BAD_KEY = JSON.stringify({ error: {
  code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT',
  details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com' }],
} });

const TRUNCATED = {
  candidates: [{ content: { parts: [{ text: '": "' }] }, finishReason: 'MAX_TOKENS' }],
  usageMetadata: { promptTokenCount: 53, candidatesTokenCount: 2, thoughtsTokenCount: 144 },
};
const answered = (text) => ({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] });

function httpError(status, body) {
  globalThis.fetch = async () => ({ ok: false, status, text: async () => body, json: async () => JSON.parse(body) });
}
function reply(payload) {
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) });
}
function hang() {
  globalThis.fetch = (_url, init) => new Promise((_res, rej) => {
    init.signal.addEventListener('abort', () => rej(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })));
  });
}
function unreachable() {
  globalThis.fetch = async () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND generativelanguage.googleapis.com'), { code: 'ENOTFOUND' }) });
  };
}

const GCFG = { enabled: true, contentCheck: true, apiKey: KEY, model: 'gemini-3.6-flash' };

/** Run one check and hand back what onResult was told. */
async function attempt(title = 'Some Film', cfg = GCFG, opts = {}) {
  const seen = [];
  const verdict = await checkNudity(title, 2001, cfg, { ...opts, onResult: (r) => seen.push(r) });
  return { verdict, seen, r: seen[0] ?? null };
}

function memoryState() {
  const data = {};
  return {
    data,
    namespace(ns) {
      data[ns] ??= {};
      return {
        get: (k, d = null) => (data[ns][k] === undefined ? d : data[ns][k]),
        set: (k, v) => { data[ns][k] = JSON.parse(JSON.stringify(v)); return v; },
        push: (k, v, cap = 200) => { const a = data[ns][k] ?? []; a.unshift(v); a.length = Math.min(a.length, cap); data[ns][k] = a; return a; },
      };
    },
  };
}

/** A tracker wired to a real AlertWatcher whose mail never leaves the process. */
function rig({ email = {}, gemini = {}, stateStore = memoryState(), clock = { t: Date.parse('2026-09-22T14:00:00Z') } } = {}) {
  const cfg = {
    // An account to send through (emailReady, since email is on by default),
    // and these emails asked for: off by default since 2026-10-12.
    email: { enabled: true, to: 'a@b.c', user: 'bot@b.c', appPassword: 'app-pw', onContentCheck: true, ...email },
    gemini: { ...GCFG, ...gemini },
  };
  const configStore = { get: () => cfg };
  const alerts = new AlertWatcher({ configStore, fileLogger: { today: () => 'LOG' } });
  alerts.delivered = [];
  alerts.failNext = 0;
  alerts._deliver = async (_c, payload) => {
    if (alerts.failNext > 0) { alerts.failNext -= 1; throw new Error('SMTP 421 try later'); }
    alerts.delivered.push(payload);
  };
  const health = new ContentCheckHealth({ alerts, configStore, stateStore, now: () => clock.t });
  return { cfg, alerts, health, stateStore, clock };
}

const failure = (reason, extra = {}) => ({ ok: false, failure: { reason, model: 'gemini-3.6-flash', ...extra } });
const success = { ok: true, verdict: { nudity: false, confidence: 0.9, basis: 'x' } };
const unknownFilm = { ok: true, verdict: { nudity: null, confidence: 0, basis: 'unknown film' } };

/* ------------------------------ reasons ------------------------------- */

console.log('=== a retired model is reported as a missing model, by name ===');
{
  httpError(404, BODY_404);
  const { verdict, r } = await attempt('D3: The Mighty Ducks', { ...GCFG, model: 'gemini-2.0-flash' });
  ok(verdict === null, 'the check returns null, so the gate falls back to the rating');
  ok(r && r.ok === false && r.failure.reason === 'model-not-found', `classified as model-not-found (${r?.failure?.reason})`);
  ok(r?.failure.model === 'gemini-2.0-flash', 'and it knows which model');
  const d = describeFailure(r.failure);
  ok(/gemini-2\.0-flash/.test(d.headline), `the headline names it: ${d.headline}`);
  ok(/Settings → .*Gemini → Model/.test(d.advice), 'and says to change it in Settings → Gemini model');
}

console.log('=== the daily quota is reported as the daily quota, with the reset time ===');
{
  httpError(429, BODY_429_DAILY);
  const { r } = await attempt();
  const f = r?.failure ?? {};
  ok(f.reason === 'quota-daily', `classified as the DAILY quota from the structured violations (${f.reason})`);
  ok(f.quotaId === 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', `quotaId kept: ${f.quotaId}`);
  ok(f.quotaValue === '20', 'the limit kept: 20');
  ok(f.retryDelay === '37s', 'and the RetryInfo delay');
  ok(!String(f.message).includes(KEY), 'the key echoed in the body is gone from the kept message');
  const d = describeFailure(f, { now: Date.parse('2026-09-22T17:00:00Z') });   // 10:00 Pacific
  ok(/daily quota/i.test(d.headline), `headline: ${d.headline}`);
  ok(d.detail.includes('GenerateRequestsPerDayPerProjectPerModel-FreeTier') && /limit 20/.test(d.detail),
    'the detail names the quota and its limit');
  ok(/midnight Pacific/.test(d.detail) && /about 14 h/.test(d.detail),
    `and when it resets: "${d.detail.match(/in about [^.]*/)?.[0]}"`);
}

console.log('=== a per-minute limit is not mistaken for the daily one ===');
{
  httpError(429, BODY_429_MINUTE);
  const { r } = await attempt();
  ok(r?.failure.reason === 'quota' && r.failure.daily === false, 'quota, but not quota-daily');
  const d = describeFailure(r.failure);
  ok(/rate-limiting/.test(d.headline) && !/midnight/.test(d.detail), 'described as rate limiting, no midnight reset');
  ok(/12s/.test(d.detail), 'with the retry delay Gemini asked for');
}

console.log('=== a timeout is a timeout ===');
{
  hang();
  const { verdict, r } = await attempt('Slow Film', GCFG, { timeoutMs: 30 });
  ok(verdict === null && r?.failure.reason === 'timeout', `classified as timeout (${r?.failure?.reason})`);
  ok(/did not answer within/.test(describeFailure(r.failure).headline), 'and described as one');
}

console.log('=== a caller giving up is not the check failing ===');
{
  hang();
  const ac = new AbortController();
  const p = attempt('Cancelled Film', GCFG, { signal: ac.signal, timeoutMs: 5000 });
  ac.abort();
  const { verdict, seen } = await p;
  ok(verdict === null && seen.length === 0, 'nothing is reported, so it cannot count toward an alert');
}

console.log('=== a reply cut off by the token cap names the finishReason ===');
{
  reply(TRUNCATED);
  const { r } = await attempt('D3: The Mighty Ducks');
  ok(r?.failure.reason === 'incomplete', 'classified as incomplete');
  ok(r?.failure.finishReason === 'MAX_TOKENS' && r.failure.thoughts === 144, 'with MAX_TOKENS and the thinking tokens');
  const d = describeFailure(r.failure);
  ok(/MAX_TOKENS/.test(d.headline) && /GEMINI_MAX_OUTPUT_TOKENS/.test(d.advice), 'and points at the token ceiling');
}

console.log('=== the other ways it fails each get their own reason ===');
{
  httpError(400, BODY_BAD_KEY);
  ok((await attempt()).r?.failure.reason === 'auth', 'API_KEY_INVALID (in ErrorInfo, on a 400) -> auth');
  httpError(503, JSON.stringify({ error: { code: 503, message: 'The model is overloaded.', status: 'UNAVAILABLE' } }));
  ok((await attempt()).r?.failure.reason === 'server', '503 -> server');
  httpError(400, '<html>bad gateway page</html>');
  ok((await attempt()).r?.failure.reason === 'http', 'an unrecognised status with a non-JSON body -> http, without throwing');
  unreachable();
  const net = (await attempt()).r?.failure;
  ok(net?.reason === 'network' && net.code === 'ENOTFOUND', 'fetch failed -> network, with the real cause code');
  reply(answered('I think this film is fine for families.'));
  ok((await attempt()).r?.failure.reason === 'unreadable', 'a finished reply that is not JSON -> unreadable');
  const none = await attempt('X', { ...GCFG, apiKey: '' });
  ok(none.r?.failure.reason === 'no-key', 'switched on with no key -> no-key, not silence');
  const off = await attempt('X', { ...GCFG, contentCheck: false });
  ok(off.seen.length === 0, 'switched off -> nothing reported at all');
}

console.log('=== a legitimate "unknown film" is the check working ===');
{
  reply(answered('{"nudity": null, "confidence": 0, "basis": "unknown film"}'));
  const { verdict, r } = await attempt('An Obscure Short');
  ok(verdict && verdict.nudity === null, 'it is a verdict, of "do not know"');
  ok(r?.ok === true, 'and it is reported as a success, not a failure');
}

console.log('=== structural classification does not depend on the wording ===');
{
  const reworded = JSON.parse(BODY_429_DAILY);
  reworded.error.message = 'Something entirely different.';
  const f = geminiHttpFailure(429, JSON.stringify(reworded), { model: 'm' });
  ok(f.reason === 'quota-daily', 'the daily quota is found from details[], not the message');
  ok(redactKey(`a ${KEY} b ${KEY}`, KEY) === 'a *** b ***', 'redactKey takes out every copy, not only the first');
}

/* ------------------------------ alerting ------------------------------ */

console.log('=== a streak raises exactly one alert ===');
{
  const { health, alerts, stateStore } = rig();
  await health.record({ ...failure('quota-daily', { quotaId: 'Q', quotaValue: '20' }), title: 'Film A', year: 2001 });
  await health.record({ ...failure('quota-daily', { quotaId: 'Q', quotaValue: '20' }), title: 'Film B', year: 2002 });
  ok(alerts.delivered.length === 0, `two failures in a row: no alert yet (default is ${ALERT_DEFAULTS.afterFailuresInARow})`);
  ok(health.snapshot().degraded === false, 'and not yet degraded');
  await health.record({ ...failure('quota-daily', { quotaId: 'Q', quotaValue: '20' }), title: 'Film C', year: 2003 });
  ok(alerts.delivered.length === 1, 'the third raises one alert');
  for (const t of ['Film D', 'Film E', 'Film F']) {
    await health.record({ ...failure('quota-daily', { quotaId: 'Q', quotaValue: '20' }), title: t });
  }
  ok(alerts.delivered.length === 1, 'and more of the same reason raise nothing further');
  const mail = alerts.delivered[0];
  ok(/daily quota/i.test(mail.label), `subject names the reason: ${mail.label}`);
  ok(/failed 3 time\(s\)/.test(mail.note), 'the note carries the count');
  ok(['Film A (2001)', 'Film B (2002)', 'Film C (2003)'].every((t) => mail.note.includes(t)),
    'and the films that were decided on their rating alone');
  ok(mail.note.indexOf('Film C') < mail.note.indexOf('Film A'), 'most recent first');
  ok(mail.logText === 'LOG', 'with the day\'s log attached like every other alert');
  const snap = health.snapshot();
  ok(snap.degraded === true && snap.incident.count === 6, `the panel sees it degraded, 6 failures (${snap.incident?.count})`);
  ok(snap.incident.titles.length === 5, 'listing the five most recent films');
  const audit = stateStore.data.audit?.events ?? [];
  ok(audit.filter((e) => /stopped working/.test(e.action)).length === 1, 'one durable audit entry');
  ok(lines.some((l) => l.startsWith('warn content-check: the nudity check is not running')), 'and one log line saying so');
}

console.log('=== a legitimate "unknown film" breaks the streak ===');
{
  const { health, alerts } = rig();
  await health.record(failure('timeout'));
  await health.record(failure('timeout'));
  await health.record(unknownFilm);
  await health.record(failure('timeout'));
  await health.record(failure('timeout'));
  ok(alerts.delivered.length === 0, 'F F unknown F F is never three in a row, so no alert');
  ok(health.snapshot().consecutive === 2, 'the unknown answer reset the count');
}

console.log('=== recovery closes the incident, and says so once ===');
{
  const { health, alerts, stateStore } = rig();
  for (let i = 0; i < 3; i++) await health.record({ ...failure('model-not-found', { model: 'gemini-2.0-flash' }), title: `Film ${i}` });
  ok(alerts.delivered.length === 1, 'the alert went out');
  await health.record({ ...success, title: 'Fixed Film' });
  ok(health.snapshot().degraded === false && health.snapshot().consecutive === 0, 'a success resets the streak and clears the flag');
  ok(alerts.delivered.length === 2 && /working again/.test(alerts.delivered[1].label), 'one "working again" note');
  ok(alerts.delivered[1].note.includes('Film 2'), 'which lists the films that went unchecked');
  await health.record(success);
  ok(alerts.delivered.length === 2, 'further successes send nothing');
  ok((stateStore.data.audit?.events ?? []).some((e) => /working again/.test(e.action)), 'recovery is on the audit log too');

}

console.log('=== broken again after "working again" is news, and is mailed ===');
{
  // Flapping 503s: the old throttle held the relapse back for six hours, so
  // the inbox's last word was "working again" while films went out unchecked.
  const { health, alerts, clock } = rig();
  for (let i = 0; i < 3; i++) await health.record(failure('server', { status: 503, apiStatus: 'UNAVAILABLE' }));
  clock.t += 40 * 60_000;
  await health.record(success);
  ok(alerts.delivered.length === 2 && /working again/.test(alerts.delivered[1].label), 'failing, then working again');
  for (let i = 0; i < 12; i++) {
    clock.t += 15 * 60_000;
    await health.record(failure('server', { status: 503, apiStatus: 'UNAVAILABLE' }));
  }
  ok(alerts.delivered.length === 3, `the relapse is mailed, inside the throttle period (${alerts.delivered.length})`);
  ok(/not running/.test(alerts.delivered.at(-1).label), 'so the inbox ends on "not running", which is true');
  await health.record(success);
  ok(alerts.delivered.length === 4 && /working again/.test(alerts.delivered.at(-1).label),
    'and its recovery is mailed too');
}

console.log('=== the throttle still holds while the reader believes it is failing ===');
{
  const { health, alerts } = rig();
  for (let i = 0; i < 3; i++) await health.record(failure('timeout'));
  ok(alerts.delivered.length === 1, 'the alert went out');
  alerts.failNext = 1;
  await health.record(success);
  ok(alerts.delivered.length === 1, 'the "working again" note could not be sent');
  for (let i = 0; i < 3; i++) await health.record(failure('timeout'));
  ok(alerts.delivered.length === 1, 'so a relapse the same way is not news to the reader, and is throttled');
  await health.record(success);
  ok(alerts.delivered.length === 2 && /working again/.test(alerts.delivered[1].label),
    'but the next recovery still owes them the "working again" note');
}

console.log('=== a success while the alert is still sending still gets its "working again" ===');
{
  const { health, alerts } = rig();
  await health.record(failure('timeout'));
  await health.record(failure('timeout'));
  const deliver = alerts._deliver;
  let release;
  const gate = new Promise((r) => { release = r; });
  alerts._deliver = async (c, p) => { await gate; return deliver(c, p); };
  const third = health.record(failure('timeout'));      // opens the incident; its email is held
  const fixed = health.record(success);                 // the check works before the email has gone
  ok(health.snapshot().degraded === false, 'the panel clears at once');
  release();
  await Promise.all([third, fixed]);
  ok(alerts.delivered.length === 2, `both emails went (${alerts.delivered.length})`);
  ok(/not running/.test(alerts.delivered[0]?.label) && /working again/.test(alerts.delivered[1]?.label),
    '"not running", then "working again"');
}

console.log('=== a different reason in the same incident is a different fix, and is mailed ===');
{
  // The morning of 2026-09-22 in order: 404, then truncation, then quota.
  const { health, alerts } = rig();
  for (let i = 0; i < 3; i++) await health.record(failure('model-not-found', { model: 'gemini-2.0-flash' }));
  await health.record(failure('incomplete', { finishReason: 'MAX_TOKENS', thoughts: 144 }));
  await health.record(failure('incomplete', { finishReason: 'MAX_TOKENS', thoughts: 144 }));
  await health.record(failure('quota-daily', { quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaValue: '20' }));
  ok(alerts.delivered.length === 3, `one email per distinct reason (${alerts.delivered.length})`);
  ok(/gemini-2\.0-flash/.test(alerts.delivered[0].label), 'first the missing model');
  ok(/MAX_TOKENS/.test(alerts.delivered[1].label), 'then the truncated replies');
  ok(/daily quota/i.test(alerts.delivered[2].label), 'then the quota');
}

console.log('=== the daily quota running out after a per-minute limit gets its own email ===');
{
  // As one reason, the per-minute email ("clears within a minute or two") was
  // the only one sent, and the admin never heard about the midnight reset.
  const { health, alerts } = rig();
  httpError(429, BODY_429_MINUTE);
  for (const t of ['M1', 'M2', 'M3']) {
    await checkNudity(t, 2001, GCFG, { onResult: (r) => health.record({ ...r, title: t }) });
  }
  await new Promise((r) => setTimeout(r, 10));
  ok(alerts.delivered.length === 1 && /rate-limiting/.test(alerts.delivered[0].label), 'first the short-term limit');
  httpError(429, BODY_429_DAILY);
  for (const t of ['D1', 'D2']) {
    await checkNudity(t, 2001, GCFG, { onResult: (r) => health.record({ ...r, title: t }) });
  }
  await new Promise((r) => setTimeout(r, 10));
  ok(alerts.delivered.length === 2, `then the daily quota, in the same outage (${alerts.delivered.length})`);
  ok(/daily quota/i.test(alerts.delivered[1]?.label) && /midnight Pacific/.test(alerts.delivered[1]?.note),
    'with the midnight Pacific reset');
}

console.log('=== a fix confirmed by a dry run clears the warning at once ===');
{
  // Three films failed, then two dry runs to see the error, then a new model
  // and a dry run that worked. The five failures filled the half-hour window,
  // and the card went on saying there was no such model for hours.
  const { health, alerts, clock } = rig();
  for (let i = 0; i < 5; i++) {
    await health.record({ ...failure('model-not-found', { model: 'gemini-2.0-flash' }),
      title: `Film ${i}`, source: i < 3 ? 'request' : 'dry run' });
    clock.t += 2 * 60_000;
  }
  ok(health.snapshot().degraded === true && alerts.delivered.length === 1, 'the outage was open and mailed');
  await health.record({ ...success, title: 'Test Film', source: 'dry run' });
  ok(health.snapshot().degraded === false, 'the dry run that worked clears it, although the window holds five');
  ok(alerts.delivered.length === 2 && /working again/.test(alerts.delivered[1].label), 'and "working again" goes at once');
}

console.log('=== the "working again" note lists every film that went unchecked ===');
{
  const { health, alerts, clock } = rig();
  for (let i = 1; i <= 12; i++) {
    await health.record({ ...failure('timeout'), title: `Film ${i}`, year: 2000 + i });
    clock.t += 10 * 60_000;
  }
  const alert = alerts.delivered[0].note;
  ok(/Film 3 \(2003\)/.test(alert) && !/Film 4 \(/.test(alert), 'the alert, sent at the third, lists those three');
  ok(health.snapshot().incident.titles.length === 5 && health.snapshot().incident.unchecked === 12,
    'the panel shows five, and knows there were twelve');
  await health.record(success);
  const note = alerts.delivered.at(-1).note;
  ok(/working again/.test(alerts.delivered.at(-1).label), 'the "working again" note went');
  const missing = Array.from({ length: 12 }, (_, i) => `Film ${i + 1} (${2001 + i})`).filter((t) => !note.includes(t));
  ok(missing.length === 0, `all twelve films are in it (missing: ${missing.join(', ') || 'none'})`);
  ok(/History tab/.test(note), 'and it says where else they are marked');

  const big = rig();
  for (let i = 1; i <= 55; i++) {
    await big.health.record({ ...failure('timeout'), title: `Film ${i}` });
    big.clock.t += 10 * 60_000;
  }
  await big.health.record(success);
  const bigNote = big.alerts.delivered.at(-1).note;
  ok(/and 5 before those, 55 in all/.test(bigNote), 'past fifty, it says how many more there were');
}

console.log('=== the History tab marks a film that was not checked ===');
{
  const app = fs.readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
  const fn = (name) => app.match(new RegExp(`function ${name}[\\s\\S]*?\\n\\}`))[0];
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const fmtDur = (x) => `${x}s`;
  // eslint-disable-next-line no-new-func
  // The panel's 24-hour clock helpers, which the lifted code calls.
  const clock = [/const CLOCK_24 = .*;/, /const HM = .*;/, /function fmtDateTime\([\s\S]*?\n\}/, /function fmtClock\([\s\S]*?\n\}/]
    .map((re) => app.match(re)[0]).join('\n');
  // And its phone-number helpers, which show the requester's number (2026-10-01).
  const phones = [/const PHONE_SHAPED = .*;/, /const PHONE_JID = .*;/].map((re) => app.match(re)[0])
    .concat(['phoneOut', 'numberBeside', 'historyNumber'].map(fn)).join('\n');
  // And its notes on what was sent: a film the member had before, a film sent
  // in place of another (historyNotes, 2026-10-11).
  const historyRow = new Function('esc', 'fmtDur', `${clock}\n${phones}\n${fn('historyTimeline')}; ${fn('historyNotes')}; `
    + `${fn('historyRow')}; return historyRow;`)(esc, fmtDur);
  const row = { request: 'kill me three times', title: 'Kill Me Three Times', status: 'sent', at: Date.now() };
  ok(!/Not checked for nudity/.test(historyRow(row)), 'a checked film has no mark');
  ok(/Not checked for nudity[\s\S]*quota-daily/.test(historyRow({ ...row, contentCheckSkipped: 'quota-daily' })),
    'an unchecked one says so, and why');
}

console.log('=== on-and-off failures inside the window are caught too ===');
{
  const { health, alerts, clock } = rig();
  for (let i = 0; i < 4; i++) {
    await health.record(failure('server', { status: 503 }));
    clock.t += 60_000;
    await health.record(success);
    clock.t += 60_000;
  }
  ok(alerts.delivered.length === 0, 'four failures, each followed by a success: nothing yet');
  await health.record(failure('server', { status: 503 }));
  ok(alerts.delivered.length === 1, `the fifth inside ${ALERT_DEFAULTS.windowMinutes} minutes raises the alert`);
  ok(/on and off/.test(alerts.delivered[0].note), 'and says it is failing on and off');
  clock.t += 60_000;
  await health.record(success);
  const snap = health.snapshot();
  ok(snap.degraded === true, 'one lucky success does not close it while the window is still full');
  ok(snap.incident.lastCheckWorked === true && snap.incident.clearsAt > clock.t,
    'but the panel is told the last check worked, and when the warning will clear');
  clock.t += 31 * 60_000;
  await health.record(success);
  ok(health.snapshot().degraded === false, 'once the window has drained, a success does');
}

console.log('=== an on-and-off outage closes on its own once the failures age out ===');
{
  // Nothing else re-checks the window, and with a handful of films a day the
  // next success could be hours away.
  const { health, alerts, clock } = rig();
  for (let i = 0; i < 5; i++) {
    await health.record(failure('server', { status: 503 }));
    clock.t += 60_000;
    await health.record(success);
    clock.t += 60_000;
  }
  ok(health.snapshot().degraded === true && alerts.delivered.length === 1, 'open, mailed, last check worked');
  await health.settle();
  ok(health.snapshot().degraded === true, 'settling early changes nothing');
  clock.t = health.snapshot().incident.clearsAt + 1000;
  await health.settle();
  ok(health.snapshot().degraded === false, 'once the window has drained, it closes with no new check');
  ok(alerts.delivered.length === 2 && /on and off/.test(alerts.delivered[1].note), 'and says why the note waited');

  const again = rig();
  for (let i = 0; i < 5; i++) {
    await again.health.record(failure('server', { status: 503 }));
    again.clock.t += 60_000;
    await again.health.record(success);
    again.clock.t += 60_000;
  }
  const clearsAt = again.health.snapshot().incident.clearsAt;
  await again.health.record(failure('server', { status: 503 }));
  again.clock.t = clearsAt + 1000;
  await again.health.settle();
  ok(again.health.snapshot().degraded === true, 'a failure before then keeps it open');
}

console.log('=== the key never reaches the email, the panel or the log ===');
{
  lines.length = 0;
  const { health, alerts } = rig();
  httpError(429, BODY_429_DAILY);
  for (const t of ['Film K1', 'Film K2', 'Film K3']) {
    await checkNudity(t, 2000, GCFG, { onResult: (r) => health.record({ ...r, title: t }) });
  }
  // Belt and braces: even a failure that somehow still carries it is scrubbed.
  await health.record(failure('http', { status: 418, message: `teapot ${KEY}` }));
  await new Promise((r) => setTimeout(r, 10));
  ok(alerts.delivered.length >= 1, 'an alert went out');
  const everything = JSON.stringify(alerts.delivered) + JSON.stringify(health.snapshot()) + lines.join('\n');
  ok(!everything.includes(KEY), 'no copy of the key anywhere in the mail, the snapshot or the log lines');
  ok(!/AIza[0-9A-Za-z_-]{20,}/.test(everything), 'nor anything shaped like a Google key');
}

console.log('=== an alert through the real check path reads the way it should ===');
{
  const { health, alerts } = rig();
  httpError(429, BODY_429_DAILY);
  for (const t of ['Nymphomaniac: Vol. I', 'Kill Me Three Times', 'D3: The Mighty Ducks']) {
    await checkNudity(t, 2014, GCFG, { onResult: (r) => health.record({ ...r, title: t, year: 2014 }) });
  }
  await new Promise((r) => setTimeout(r, 10));
  const mail = alerts.delivered[0];
  ok(!!mail, 'three 429s in a row produce an email');
  ok(mail && mail.note.includes('GenerateRequestsPerDayPerProjectPerModel-FreeTier'), 'naming the quota');
  ok(mail && /limit 20 requests a day/.test(mail.note), 'its limit');
  ok(mail && /midnight Pacific/.test(mail.note), 'that it resets at midnight Pacific');
  ok(mail && mail.note.includes('D3: The Mighty Ducks (2014)'), 'and the films affected');
}

console.log('=== email switched off still leaves a trace ===');
{
  lines.length = 0;
  const { health, alerts, stateStore } = rig({ email: { onContentCheck: false } });
  for (let i = 0; i < 3; i++) await health.record(failure('timeout'));
  ok(alerts.delivered.length === 0, 'no email when the operator turned these off');
  ok(health.snapshot().degraded === true, 'but the panel still shows it');
  ok((stateStore.data.audit?.events ?? []).length === 1, 'and the audit log records it');
  ok(lines.some((l) => /not running/.test(l)), 'and the log says so');
}

console.log('=== a failed send is tried again, not given up on ===');
{
  const { health, alerts } = rig();
  alerts.failNext = 1;
  for (let i = 0; i < 3; i++) await health.record(failure('timeout'));
  ok(alerts.delivered.length === 0, 'the first send failed');
  await health.record(failure('timeout'));
  ok(alerts.delivered.length === 1, 'the next failure of the same reason retries it');
  await health.record(failure('timeout'));
  ok(alerts.delivered.length === 1, 'and only until it has gone');
}

console.log('=== a restart mid-incident neither forgets nor repeats ===');
{
  const stateStore = memoryState();
  const clock = { t: Date.parse('2026-09-22T15:00:00Z') };
  const first = rig({ stateStore, clock });
  for (let i = 0; i < 3; i++) await first.health.record(failure('quota-daily'));
  ok(first.alerts.delivered.length === 1, 'alerted before the restart');
  const second = rig({ stateStore, clock });          // a new process: fresh AlertWatcher, same state
  ok(second.health.snapshot().degraded === true, 'the panel is still told after a restart');
  await second.health.record(failure('quota-daily'));
  ok(second.alerts.delivered.length === 0, 'and the same reason is not mailed again');
}

console.log('=== the thresholds come from config, with defaults ===');
{
  const { health, alerts } = rig({ gemini: { contentCheckAlert: { afterFailuresInARow: 1 } } });
  await health.record(failure('model-not-found', { model: 'x' }));
  ok(alerts.delivered.length === 1, 'afterFailuresInARow: 1 alerts on the first failure');
  const schema = fs.readFileSync(new URL('../src/config/schema.js', import.meta.url), 'utf8');
  ok(/contentCheckAlert: \{\s*afterFailuresInARow: 3,/.test(schema), 'the schema carries the defaults');
  // On by default until 2026-10-12, when the operator's live settings, with
  // it off, became the defaults; the dashboard card and the audit log stay.
  ok(/onContentCheck: false/.test(schema), 'and the email switch, off by default, the operator\'s choice');
}

console.log('=== untilMidnightPacific ===');
{
  const at = (iso) => Math.round(untilMidnightPacific(Date.parse(iso)) / 60_000);
  ok(at('2026-09-22T06:59:00Z') === 1, '23:59 PDT is a minute before the reset');
  ok(at('2026-09-22T07:00:00Z') === 24 * 60, 'midnight PDT is a full day away');
  ok(at('2026-12-01T20:00:00Z') === 12 * 60, 'noon PST, in winter, is twelve hours away');
}

console.log('=== it is wired into the live gate, the dry run and the panel ===');
{
  const src = (p) => fs.readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');
  const idx = src('plugins/movie-requests/index.js');
  // Through contentGate (film-gate.js), which hands checkNudity's reports on.
  const gate = src('plugins/movie-requests/film-gate.js');
  ok(/await contentGate\(\{\s*store: ctx\.store, movie, hit,[\s\S]{0,400}onResult: \(r\) => \{\s*ctx\.contentHealth/.test(idx)
    && /onResult: \(r\) => \{\s*if \(!r\.ok\) failed = r\.failure;\s*onResult\?\.\(r\);/.test(gate),
    'the live gate reports every attempt');
  ok(/ctx\.contentHealth\?\.record\(/.test(idx), 'to the tracker it is handed');
  ok(/record\.contentCheckSkipped = failed\.reason/.test(idx), 'and marks the film\'s own history row');
  const api = src('web/api.js');
  const dry = api.match(/router\.post\('\/test\/request'[\s\S]*?\n  \}\);/)[0];
  ok(/source: 'dry run'/.test(dry), 'the dry run reports too, labelled as a dry run');
  ok(/the check did not run: \$\{describeFailure\(failed\)\.headline\}/.test(dry), 'and says why it could not decide');
  const main = src('index.js');
  ok(/new ContentCheckHealth\(\{ alerts, configStore, stateStore \}\)/.test(main), 'index.js builds it with the alerts module');
  ok(/new PluginManager\(\{[^}]*contentHealth \}\)/.test(main), 'hands it to the plugins');
  ok(/createServer\(\{[^}]*contentHealth \}\)/.test(main), 'and to the web server');
  const pm = src('core/plugin-manager.js');
  ok(/contentHealth: this\.contentHealth/.test(pm), 'the plugin context carries it');
  const server = src('web/server.js');
  ok(/send\('contentcheck', contentHealth\.snapshot\(\)\)/.test(server), 'the panel gets the state when it connects');
  ok(/contentHealth\?\.on\('change'/.test(server) && /contentHealth\?\.off\('change'/.test(server),
    'and every change, with the listener removed when the stream closes');
  const app = fs.readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
  ok(/addEventListener\('contentcheck'/.test(app), 'the panel listens for it');
}

console.log('=== the panel shows the card only while the check is degraded ===');
{
  // The real renderContentHealth from app.js, against the two elements it
  // touches. Plain stubs rather than linkedom, so this suite still runs on a
  // production install without the dev dependencies.
  const app = fs.readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
  const src = app.match(/function renderContentHealth[\s\S]*?\n\}/)[0];
  const el = () => {
    const cls = new Set(['hidden']);
    return { innerHTML: '', classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), has: (c) => cls.has(c) } };
  };
  const els = { 'card-cc-health': el(), 'cc-health-dash': el(), 'cc-health-settings': el() };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // eslint-disable-next-line no-new-func
  // The panel's 24-hour clock helpers, which the lifted code calls.
  const clock = [/const CLOCK_24 = .*;/, /const HM = .*;/, /function fmtDateTime\([\s\S]*?\n\}/, /function fmtClock\([\s\S]*?\n\}/]
    .map((re) => app.match(re)[0]).join('\n');
  const render = new Function('$', 'esc', `${clock}\n${src}; return renderContentHealth;`)((id) => els[id], esc);

  const { health } = rig();
  for (const t of ['<b>Film</b>', 'Film Two']) await health.record({ ...failure('quota-daily'), title: t, year: 2000 });
  await health.record({ ...failure('quota-daily'), title: 'Film Three', source: 'dry run' });
  render(health.snapshot());
  const card = els['card-cc-health'];
  ok(!card.classList.has('hidden'), 'degraded: the dashboard card is shown');
  ok(/daily quota/.test(els['cc-health-dash'].innerHTML), 'naming the reason');
  ok(els['cc-health-dash'].innerHTML.includes('&lt;b&gt;Film&lt;/b&gt;'), 'with film titles escaped');
  ok(/\(dry run\)/.test(els['cc-health-dash'].innerHTML), 'and a dry run marked as one');
  ok(/cc-health-box/.test(els['cc-health-settings'].innerHTML), 'the Settings card says so too');
  ok(!/latest check/.test(els['cc-health-dash'].innerHTML), 'with no talk of a check that worked');
  const flapping = health.snapshot();
  render({ ...flapping, lastSuccessAt: Date.now(),
    incident: { ...flapping.incident, lastCheckWorked: true, clearsAt: Date.now() + 20 * 60_000 } });
  ok(/latest check, [^<]*, worked[\s\S]*clears by itself around/.test(els['cc-health-dash'].innerHTML),
    'on and off with the last check working: the card says it worked, and when it clears');

  await health.record(success);
  render(health.snapshot());
  ok(card.classList.has('hidden'), 'working again: the card is hidden');
  ok(/Working — last answered/.test(els['cc-health-settings'].innerHTML), 'and Settings says it is working');

  await health.record(failure('timeout'));
  render(health.snapshot());
  ok(card.classList.has('hidden') && /last check did not run/.test(els['cc-health-settings'].innerHTML),
    'a single failure is mentioned in Settings without raising the dashboard card');

  render({ ...health.snapshot(), enabled: false });
  ok(card.classList.has('hidden') && els['cc-health-settings'].innerHTML === '', 'switched off: nothing shown');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
