/* Fallback AI providers for the nudity check and the film lookup.
   Run: node test/ai-providers.test.mjs

   2026-09-22: the Gemini key was on the free tier - 20 requests a day for
   gemini-3.6-flash, reset at midnight Pacific - and the bot makes about 30 in
   its first hour. By mid-morning every check was refused with HTTP 429 and
   every film was judged on its rating alone until the next day. Groq, Cerebras
   and Mistral were added as fallbacks. They run open models that recall
   particular films less reliably than Gemini, so a "no nudity" from one of
   them must not clear a film its rating blocks unless the operator says so
   for that provider.

   Since 2026-09-29 no answer from any provider refuses anything - the
   operator's "No, AI only helps" - and the nudity check is asked only to
   clear a title its rating blocks. So it asks only the providers allowed to
   clear one (onlyClearing): an answer from any other could change nothing,
   and, the first answer deciding, would keep one that could from being
   asked. Pinned in "the safety policy" below.

   No network: globalThis.fetch is stubbed throughout, with the response shapes
   each API really returns (OpenAI-style chat.completions for the three
   fallbacks, generateContent for Gemini). */
import fs from 'node:fs';
import log from '../src/util/logger.js';
import { checkNudity, decide, mayClearRated } from '../src/plugins/movie-requests/content-check.js';
import { identifyTitle, geminiHttpFailure } from '../src/plugins/movie-requests/gemini.js';
import {
  askChain, stripReasoning, chatAnswer, openAiHttpFailure, parseDuration, pickModel, listModels,
  chainPlan, normaliseOrder, resetBreakers, resetModelCache, breakerSnapshot, untilMidnightPacific,
  scrubKeys, scrubFailure, isOneJsonObject, breakerFor, HOLD_MS, MODEL_PREFERENCES, PROVIDER_MAX_TOKENS,
} from '../src/core/ai-providers.js';
import { ContentCheckHealth, describeFailure, alertKeys } from '../src/core/content-check-health.js';
import { AlertWatcher } from '../src/core/alerts.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const lines = [];
log.on('line', (e) => lines.push(`${e.level} ${e.scope}: ${e.msg}`));

/* ------------------------------ fixtures ------------------------------ */

const GEMINI_KEY = 'AIzaSyTESTKEY_0123456789-abcdefghijklmno';
const GROQ_KEY = 'gsk_TESTgroqKEY0123456789abcdefghijklmnopqrstuvwxyzABCDEF';
const CEREBRAS_KEY = 'csk-TESTcerebrasKEY0123456789abcdefghijklmnopqrstuv';
const MISTRAL_KEY = 'TESTmistralKEY' + '0123456789abcdefgh';
const ALL_KEYS = [GEMINI_KEY, GROQ_KEY, CEREBRAS_KEY, MISTRAL_KEY];

const GCFG = { enabled: true, contentCheck: true, apiKey: GEMINI_KEY, model: 'gemini-3.6-flash' };
const AI = (over = {}) => ({
  order: ['gemini', 'groq', 'cerebras', 'mistral'],
  gemini: { enabled: true, canClearRated: true },
  groq: { enabled: true, apiKey: GROQ_KEY, model: 'llama-3.3-70b-versatile', canClearRated: false },
  cerebras: { enabled: true, apiKey: CEREBRAS_KEY, model: 'llama-3.3-70b', canClearRated: false },
  mistral: { enabled: true, apiKey: MISTRAL_KEY, model: 'mistral-large-latest', canClearRated: false },
  ...over,
});

const HOST = { gemini: 'generativelanguage.googleapis.com', groq: 'api.groq.com', cerebras: 'api.cerebras.ai', mistral: 'api.mistral.ai' };

function res(status, payload, headers = {}) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => JSON.parse(text),
    text: async () => text,
  };
}
const geminiSays = (text) => res(200, { candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] });
const chat = (content, { finish = 'stop', model = 'llama-3.3-70b-versatile', reasoning = 0 } = {}) => res(200, {
  id: 'chatcmpl-9f1', object: 'chat.completion', created: 1758550000, model,
  choices: [{ index: 0, message: { role: 'assistant', content }, logprobs: null, finish_reason: finish }],
  usage: { prompt_tokens: 180, completion_tokens: 31, total_tokens: 211,
    ...(reasoning ? { completion_tokens_details: { reasoning_tokens: reasoning } } : {}) },
});
const CLEAN = '{"nudity": false, "confidence": 0.95, "basis": "no nudity in parents guide"}';
const NUDE = '{"nudity": true, "confidence": 0.9, "basis": "brief topless scene"}';

const GEMINI_429_DAILY = res(429, { error: {
  code: 429,
  message: `You exceeded your current quota. key=${GEMINI_KEY} Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-3.6-flash`,
  status: 'RESOURCE_EXHAUSTED',
  details: [
    { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{
      quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
      quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaValue: '20',
    }] },
    { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '37s' },
  ],
} });
const GEMINI_503 = () => res(503, { error: { code: 503, message: 'The model is overloaded.', status: 'UNAVAILABLE' } });

// Groq's real 429 for requests-per-day, with its headers.
const GROQ_429_RPD = () => res(429, { error: {
  message: 'Rate limit reached for model `llama-3.3-70b-versatile` in organization `org_01j` service tier `on_demand` on requests per day (RPD): Limit 1000, Used 1000, Requested 1. Please try again in 1m26.4s.',
  type: 'requests', code: 'rate_limit_exceeded',
} }, {
  'retry-after': '87', 'x-ratelimit-limit-requests': '1000', 'x-ratelimit-remaining-requests': '0',
  'x-ratelimit-reset-requests': '1m26.4s', 'x-ratelimit-limit-tokens': '12000',
  'x-ratelimit-remaining-tokens': '11800', 'x-ratelimit-reset-tokens': '1s',
});
const GROQ_429_TPM = () => res(429, { error: {
  message: 'Rate limit reached for model `llama-3.3-70b-versatile` on tokens per minute (TPM): Limit 12000, Used 11900, Requested 400. Please try again in 1.5s.',
  type: 'tokens', code: 'rate_limit_exceeded',
} }, { 'retry-after': '30', 'x-ratelimit-remaining-tokens': '0', 'x-ratelimit-reset-tokens': '1.5s', 'x-ratelimit-remaining-requests': '940' });
const GROQ_401 = () => res(401, { error: { message: 'Invalid API Key', type: 'invalid_request_error', code: 'invalid_api_key' } });
const GROQ_404 = () => res(404, { error: {
  message: 'The model `llama-9-huge` does not exist or you do not have access to it.', type: 'invalid_request_error', code: 'model_not_found',
} });
const CEREBRAS_429_DAY = () => res(429, {
  message: 'Requests per day limit exceeded - too many requests sent.', type: 'too_many_requests_error', param: 'quota', code: 'request_quota_exceeded',
}, { 'x-ratelimit-limit-requests-day': '14400', 'x-ratelimit-remaining-requests-day': '0', 'x-ratelimit-reset-requests-day': '33011.38' });
const MISTRAL_BAD_MODEL = () => res(400, { object: 'error', message: 'Invalid model: mistral-huge', type: 'invalid_model', param: null, code: '1500' });

function hang(_url, init) {
  return new Promise((_ok, bad) => {
    init.signal.addEventListener('abort', () => bad(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })));
  });
}

/**
 * Route each request by host (and /models vs /chat) to a handler, and keep a
 * record of every call made. A provider with no handler is a test failure, not
 * a network call.
 */
function stub(handlers) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const provider = Object.keys(HOST).find((k) => u.includes(HOST[k]));
    const kind = u.endsWith('/models') ? 'models' : 'ask';
    const call = { provider, kind, url: u, body: init.body ? JSON.parse(init.body) : null, headers: init.headers ?? {} };
    calls.push(call);
    const h = handlers[`${provider}:${kind}`] ?? handlers[provider];
    if (!h) throw new Error(`test made an unexpected request to ${u}`);
    return h(u, init, calls.filter((c) => c.provider === provider && c.kind === kind).length, call);
  };
  calls.to = (p, kind = 'ask') => calls.filter((c) => c.provider === p && c.kind === kind);
  return calls;
}

function fresh() {
  resetBreakers();
  resetModelCache();
  lines.length = 0;
}

async function check(ai = AI(), opts = {}, cfg = GCFG, title = 'Some Film') {
  const seen = [];
  const verdict = await checkNudity(title, 2001, cfg, { ai, ...opts, onResult: (r) => seen.push(r) });
  return { verdict, r: seen[0] ?? null, seen };
}

/* --------------------------- order and choice -------------------------- */

console.log('=== the first provider that answers decides, and the others are not asked ===');
{
  fresh();
  const calls = stub({ gemini: () => geminiSays(CLEAN), groq: () => chat(NUDE) });
  const { verdict, r } = await check();
  ok(verdict?.nudity === false && verdict.provider === 'gemini', 'Gemini answered, and the verdict says so');
  ok(calls.to('groq').length === 0 && calls.to('cerebras').length === 0, 'nobody after it was asked');
  ok(r?.ok && r.provider === 'gemini' && r.attempts.length === 1, 'onResult reports who answered');
}

console.log('=== when the first cannot answer, the next one is asked, in the configured order ===');
{
  fresh();
  const calls = stub({ gemini: GEMINI_503, groq: GROQ_401, cerebras: () => chat(CLEAN, { model: 'llama-3.3-70b' }), mistral: () => chat(NUDE) });
  const { verdict, r } = await check();
  ok(verdict?.provider === 'cerebras', `the third provider answered (${verdict?.provider})`);
  ok(calls.map((c) => c.provider).join(',') === 'gemini,groq,cerebras', `asked in order: ${calls.map((c) => c.provider).join(', ')}`);
  ok(calls.to('mistral').length === 0, 'and the fourth was never asked');
  ok(r.attempts.map((a) => `${a.provider}:${a.ok ? 'ok' : a.reason}`).join(' ') === 'gemini:server groq:auth cerebras:ok',
    'every attempt is reported, with its reason');

  fresh();
  const reordered = stub({ gemini: () => geminiSays(NUDE), mistral: () => chat(CLEAN, { model: 'mistral-large-latest' }) });
  const o = await check(AI({ order: ['mistral', 'gemini', 'groq', 'cerebras'] }));
  ok(o.verdict?.provider === 'mistral' && reordered.to('gemini').length === 0, 'a different order is honoured');
  ok(normaliseOrder(['mistral', 'bogus', 'mistral']).join(',') === 'mistral,gemini,groq,cerebras,openrouter,ollama',
    'an order missing providers keeps them, after the named ones; unknown and repeated ids are dropped');
  ok(normaliseOrder(['constructor', '__proto__', 'toString', 'groq']).join(',') === 'groq,gemini,cerebras,mistral,openrouter,ollama',
    'names that exist on every object are not providers (the order arrives from a request body)');
}

console.log('=== a provider switched off, or with no key, is not asked ===');
{
  fresh();
  const calls = stub({ gemini: GEMINI_503, mistral: () => chat(CLEAN, { model: 'mistral-large-latest' }) });
  const ai = AI({
    groq: { enabled: true, apiKey: '', model: 'llama-3.3-70b-versatile' },         // no key
    cerebras: { enabled: false, apiKey: CEREBRAS_KEY, model: 'llama-3.3-70b' },   // switched off
  });
  const { verdict } = await check(ai);
  ok(verdict?.provider === 'mistral', 'Mistral answered');
  ok(calls.to('groq').length === 0 && calls.to('cerebras').length === 0, 'Groq (no key) and Cerebras (off) were never called');

  fresh();
  const g = stub({ groq: () => chat(CLEAN) });
  const noGemini = await check(AI({ gemini: { enabled: false } }));
  ok(noGemini.verdict?.provider === 'groq' && g.to('gemini').length === 0, 'Gemini can be taken out of the chain too');

  fresh();
  stub({});
  const none = await check(AI({ groq: { enabled: false }, cerebras: { enabled: false }, mistral: { enabled: false } }), {}, { ...GCFG, apiKey: '' });
  ok(none.verdict === null && none.r?.failure.reason === 'no-key', 'nothing usable at all is still reported, as no-key');
  ok(await checkNudity('X', 2001, { ...GCFG, contentCheck: false }, { ai: AI() }) === null, 'and the feature switch still turns it all off');
}

/* ---------------------------- the breaker ---------------------------- */

console.log("=== Gemini's daily quota: asked last until midnight Pacific, not first on every film ===");
{
  fresh();
  const clock = { t: Date.parse('2026-09-22T17:00:00Z') };      // 10:00 in Los Angeles
  const calls = stub({ gemini: () => GEMINI_429_DAILY, groq: () => chat(CLEAN) });
  const first = await check(AI(), { now: () => clock.t });
  ok(first.verdict?.provider === 'groq', 'the film that found the quota gone was answered by Groq');
  const b = breakerSnapshot(clock.t).find((x) => x.provider === 'gemini');
  const midnight = Date.parse('2026-09-23T07:00:00Z');
  ok(b?.reason === 'quota-daily' && b.until === midnight, `Gemini is held until midnight Pacific (${b && new Date(b.until).toISOString()})`);
  ok(b?.until === clock.t + untilMidnightPacific(clock.t), 'which is what untilMidnightPacific says');

  clock.t += 3 * 3600_000;
  const second = await check(AI(), { now: () => clock.t });
  ok(calls.to('gemini').length === 1, 'the next film did not spend a request on Gemini first');
  ok(second.verdict?.provider === 'groq', 'Groq answered it straight away');
  const skipped = second.r.attempts.find((a) => a.provider === 'gemini');
  ok(skipped?.skipped === true && skipped.reason === 'quota-daily' && skipped.until === midnight,
    'and the report says Gemini was skipped, why, and until when');
  ok(lines.filter((l) => /Gemini: its daily quota is used up/.test(l)).length === 1,
    'the log says so once, not once per film');
  ok(lines.some((l) => /^info ai: Gemini: its daily quota is used up.*07:00 UTC \(midnight Pacific\)/.test(l)),
    'at info level, since a free tier running dry is routine and the next provider carries on');

  clock.t = midnight + 60_000;
  const calls2 = stub({ gemini: () => geminiSays(CLEAN), groq: () => chat(CLEAN) });
  const next = await check(AI(), { now: () => clock.t });
  ok(next.verdict?.provider === 'gemini' && calls2[0].provider === 'gemini', 'after midnight Pacific, Gemini is first again');
  ok(!breakerSnapshot(clock.t).some((x) => x.provider === 'gemini'), 'and its breaker is closed');
}

console.log('=== a held provider is still tried last, so a lone Gemini behaves as before ===');
{
  fresh();
  const clock = { t: Date.parse('2026-09-22T17:00:00Z') };
  const calls = stub({ gemini: () => GEMINI_429_DAILY, groq: GEMINI_503 });
  await check(AI({ groq: { enabled: true, apiKey: GROQ_KEY, model: 'm' }, cerebras: { enabled: false }, mistral: { enabled: false } }), { now: () => clock.t });
  const calls2 = stub({ gemini: () => geminiSays(CLEAN), groq: () => res(503, { error: { message: 'down' } }) });
  const { verdict } = await check(AI({ groq: { enabled: true, apiKey: GROQ_KEY, model: 'm' }, cerebras: { enabled: false }, mistral: { enabled: false } }), { now: () => clock.t });
  ok(calls2.map((c) => c.provider).join(',') === 'groq,gemini', 'Groq first, then the held Gemini as a last resort');
  ok(verdict?.provider === 'gemini', 'which answered - billing was switched on, say - and so is noticed the same day');
  ok(calls.length === 2, '(the first check asked both)');

  fresh();
  stub({ gemini: () => GEMINI_429_DAILY });
  await check(null, { now: () => clock.t });
  const again = stub({ gemini: () => geminiSays(CLEAN) });
  const lone = await check(null, { now: () => clock.t });
  ok(again.to('gemini').length === 1 && lone.verdict?.provider === 'gemini',
    'with no fallbacks configured, Gemini is asked every time exactly as before');
}

console.log('=== a 429 with Retry-After holds that provider for as long as it asked ===');
{
  fresh();
  const clock = { t: Date.parse('2026-09-22T15:00:00Z') };
  const ai = AI({ order: ['groq', 'mistral', 'gemini', 'cerebras'], gemini: { enabled: false }, cerebras: { enabled: false } });
  const calls = stub({ groq: GROQ_429_TPM, mistral: () => chat(CLEAN, { model: 'mistral-large-latest' }) });
  const first = await check(ai, { now: () => clock.t });
  const f = first.r.attempts.find((a) => a.provider === 'groq');
  ok(f.reason === 'quota' && f.retryAfterMs === 30_000, `a tokens-per-minute limit is "quota", retry after 30 s (${f.reason}, ${f.retryAfterMs})`);
  ok(f.until === clock.t + 30_000, 'Groq is held for exactly that long');
  clock.t += 10_000;
  await check(ai, { now: () => clock.t });
  ok(calls.to('groq').length === 1 && calls.to('mistral').length === 2, 'ten seconds later Mistral is asked first');
  clock.t += 25_000;
  stub({ groq: () => chat(CLEAN), mistral: () => chat(NUDE) });
  const back = await check(ai, { now: () => clock.t });
  ok(back.verdict?.provider === 'groq', 'once the time is up, Groq is first again');
}

console.log('=== daily limits on Groq and Cerebras are read from their headers ===');
{
  const groq = openAiHttpFailure(429, await GROQ_429_RPD().text(), GROQ_429_RPD().headers, { provider: 'groq', model: 'm' });
  ok(groq.reason === 'quota-daily', `Groq's requests-per-day limit is a daily quota (${groq.reason})`);
  ok(groq.retryAfterMs === 87_000, `retry after the larger of Retry-After and the reset header: ${groq.retryAfterMs} ms`);
  ok(groq.quotaValue === '1000' && /requests/.test(groq.quotaId), `with the limit (${groq.quotaValue}) and what ran out (${groq.quotaId})`);
  const cer = openAiHttpFailure(429, await CEREBRAS_429_DAY().text(), CEREBRAS_429_DAY().headers, { provider: 'cerebras', model: 'm' });
  ok(cer.reason === 'quota-daily' && cer.retryAfterMs === 33_011_380,
    `Cerebras's top-level error and -day headers: quota-daily, reset in ${cer.retryDelay}`);
  const mis = openAiHttpFailure(429, JSON.stringify({ message: 'Requests rate limit exceeded' }), new Headers(), { provider: 'mistral' });
  ok(mis.reason === 'quota' && mis.retryAfterMs === null, 'Mistral with no timing information is plain quota');
  ok(HOLD_MS.quota === 60_000, 'which is held for the one-minute default');
  ok(parseDuration('2m59.56s') === 179_560 && parseDuration('150ms') === 150 && parseDuration('37s') === 37_000
    && parseDuration('1h2m') === 3_720_000 && parseDuration('33011.38') === 33_011_380, 'durations in every shape they arrive in');
}

console.log('=== every other failure moves on to the next provider ===');
{
  const cases = [
    ['401 bad key', GROQ_401, 'auth', true],
    ['404 unknown model', GROQ_404, 'model-not-found', true],
    ['503 server error', () => res(503, { error: { message: 'Service Unavailable', type: 'internal_server_error' } }), 'server', false],
    ['timeout', hang, 'timeout', false],
    ['network', async () => { throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.groq.com'), { code: 'ENOTFOUND' }) }); }, 'network', false],
    ['incomplete (finish_reason length)', () => chat('{"nudity": fal', { finish: 'length', reasoning: 2000 }), 'incomplete', false],
    ['unreadable (prose)', () => chat('This film is fine for families.'), 'unreadable', false],
    ['unreadable (not JSON at all)', () => ({ ok: true, status: 200, headers: new Headers(), json: async () => { throw new SyntaxError('Unexpected token <'); }, text: async () => '<html>' }), 'unreadable', false],
  ];
  const ai = AI({ order: ['groq', 'mistral', 'gemini', 'cerebras'], gemini: { enabled: false }, cerebras: { enabled: false } });
  for (const [name, h, reason, holds] of cases) {
    fresh();
    stub({ groq: h, mistral: () => chat(CLEAN, { model: 'mistral-large-latest' }) });
    const { verdict, r } = await check(ai, { timeoutMs: 50 });
    const g = r?.attempts?.find((a) => a.provider === 'groq');
    ok(verdict?.provider === 'mistral' && g?.reason === reason, `${name} -> ${g?.reason}, and Mistral answered`);
    const held = breakerSnapshot().some((b) => b.provider === 'groq');
    ok(held === holds, `${name}: ${holds ? 'held back for a while, so the next film does not waste time on it' : 'not held back - it says nothing about the next film'}`);
  }
  ok(HOLD_MS.auth === 15 * 60_000 && HOLD_MS['model-not-found'] === 15 * 60_000, 'a bad key or model is held back for 15 minutes');

  fresh();
  const calls = stub({ mistral: MISTRAL_BAD_MODEL, groq: () => chat(CLEAN) });
  const mb = await check(AI({ order: ['mistral', 'groq'], gemini: { enabled: false }, cerebras: { enabled: false } }));
  ok(mb.r.attempts[0].reason === 'model-not-found', "Mistral's 400 invalid_model is an unknown model, not a JSON-mode refusal");
  ok(calls.to('mistral').length === 1, 'so it is not retried without response_format');
}

console.log('=== the whole chain is bounded, not just each attempt ===');
{
  fresh();
  stub({ gemini: hang, groq: hang, cerebras: hang, mistral: hang });
  const t0 = Date.now();
  const { verdict, r } = await check(AI(), { timeoutMs: 5000, totalMs: 250 });
  const took = Date.now() - t0;
  ok(verdict === null && took < 1500, `four hanging providers took ${took} ms, not four times the per-attempt timeout`);
  ok(r?.failure.reason === 'all-failed', 'reported as all failed');
  ok(r.failure.attempts.some((a) => a.reason === 'timeout') && r.failure.attempts.some((a) => a.reason === 'out-of-time'),
    'the first timed out, the rest were never reached - and it says which');
}

console.log('=== a caller giving up stops the chain and is not a failure ===');
{
  fresh();
  const calls = stub({ gemini: hang, groq: () => chat(CLEAN) });
  const ac = new AbortController();
  const p = check(AI(), { signal: ac.signal, timeoutMs: 5000 });
  setTimeout(() => ac.abort(), 20);
  const { verdict, seen } = await p;
  ok(verdict === null && seen.length === 0, 'nothing reported, so it cannot count towards an alert');
  ok(calls.to('groq').length === 0, 'and the next provider was not asked on behalf of nobody');
}

/* --------------------------- reading the answer --------------------------- */

console.log('=== inline reasoning is removed and never read as the answer ===');
{
  ok(stripReasoning('<think>maybe {"nudity": true}? no.</think>{"nudity": false}') === '{"nudity": false}',
    'a closed <think> block goes, including the JSON-shaped guess inside it');
  ok(stripReasoning('Let me recall... {"nudity": true}</think>\n{"nudity": false}') === '{"nudity": false}',
    'a closing tag with no opening one: everything before it was reasoning');
  ok(stripReasoning('<think>it has {"nudity": true') === '', 'reasoning cut off before it closed leaves no answer at all');
  ok(stripReasoning('<reasoning>x</reasoning><thinking>y</thinking>{"a":1}') === '{"a":1}', 'other tag names too');
  ok(stripReasoning('◁think▷{"nudity": true}◁/think▷{"nudity": false}') === '{"nudity": false}', "and Kimi's markers");
  ok(stripReasoning('{"nudity": false}') === '{"nudity": false}', 'a plain answer is untouched');

  const mistralChunks = chatAnswer({ choices: [{ message: { content: [
    { type: 'thinking', thinking: [{ type: 'text', text: '{"nudity": true}' }] },
    { type: 'text', text: '{"nudity": false, "confidence": 0.9}' },
  ] }, finish_reason: 'stop' }] });
  ok(mistralChunks.text === '{"nudity": false, "confidence": 0.9}', "Mistral's thinking chunk is skipped; only the text chunk is the answer");
  const gptOss = chatAnswer({ choices: [{ message: { content: CLEAN, reasoning: 'maybe {"nudity": true}' }, finish_reason: 'stop' }] });
  ok(gptOss.text === CLEAN, 'a separate reasoning field (gpt-oss on Groq) is never read');

  fresh();
  stub({ gemini: GEMINI_503, groq: () => chat(`<think>I recall {"nudity": true, "confidence": 0.9} from somewhere... no, that was another film.</think>\n${CLEAN}`, { model: 'qwen/qwen3-32b' }) });
  const { verdict } = await check();
  ok(verdict?.nudity === false && verdict.provider === 'groq', 'through the chain: the answer after the reasoning is the one used');

  fresh();
  stub({ gemini: GEMINI_503, groq: () => chat('<think>Thinking about whether {"nudity": true, "confidence": 0.99', { finish: 'length', model: 'qwen/qwen3-32b' }), cerebras: () => chat(NUDE, { model: 'llama-3.3-70b' }) });
  const cut = await check();
  const g = cut.r.attempts.find((a) => a.provider === 'groq');
  ok(g?.reason === 'incomplete' && cut.verdict?.provider === 'cerebras',
    'reasoning cut off by the token cap is "incomplete", not a verdict, and the next provider is asked');
}

console.log('=== a model that refuses JSON mode is asked once more without it ===');
{
  fresh();
  const calls = stub({
    gemini: GEMINI_503,
    groq: (_u, _i, n) => (n === 1
      ? res(400, { error: { message: 'response_format `json_object` is not supported with this model', type: 'invalid_request_error', param: 'response_format' } })
      : chat(CLEAN, { model: 'some-model' })),
  });
  const { verdict } = await check();
  const asks = calls.to('groq');
  ok(asks.length === 2, 'Groq was asked twice');
  ok(asks[0].body.response_format?.type === 'json_object' && !('response_format' in asks[1].body),
    'first with response_format, then without it');
  ok(verdict?.provider === 'groq' && verdict.nudity === false, 'and the second answer was used');
  ok(asks[0].body.temperature === 0 && asks[0].body.max_tokens === PROVIDER_MAX_TOKENS && PROVIDER_MAX_TOKENS >= 2048,
    `temperature 0 and ${PROVIDER_MAX_TOKENS} tokens of room, as for Gemini`);
  ok(asks[0].headers.Authorization === `Bearer ${GROQ_KEY}` && asks[0].url === 'https://api.groq.com/openai/v1/chat/completions',
    'sent to the right endpoint with a Bearer key');

  fresh();
  const twice = stub({
    gemini: GEMINI_503,
    groq: () => res(400, { error: { message: 'Failed to generate JSON.', type: 'invalid_request_error', code: 'json_validate_failed' } }),
    cerebras: () => chat(CLEAN, { model: 'llama-3.3-70b' }),
  });
  const v2 = await check();
  ok(twice.to('groq').length === 2 && v2.verdict?.provider === 'cerebras', 'only once: a second 400 moves on to the next provider');
}

/* ------------------------------ models ------------------------------ */

console.log('=== a blank model is chosen from the provider\'s own list, once, and logged ===');
{
  fresh();
  const GROQ_MODELS = { object: 'list', data: [
    { id: 'whisper-large-v3', object: 'model', created: 1693721698, owned_by: 'OpenAI', active: true, context_window: 448 },
    { id: 'llama-3.1-8b-instant', object: 'model', created: 1693721698, owned_by: 'Meta', active: true, context_window: 131072 },
    { id: 'meta-llama/llama-guard-4-12b', object: 'model', created: 1, owned_by: 'Meta', active: true, context_window: 131072 },
    { id: 'llama-3.3-70b-versatile', object: 'model', created: 1733447754, owned_by: 'Meta', active: true, context_window: 131072 },
    { id: 'moonshotai/kimi-k2-instruct-0905', object: 'model', created: 1, owned_by: 'Moonshot AI', active: false, context_window: 262144 },
  ] };
  const calls = stub({ gemini: GEMINI_503, 'groq:models': () => res(200, GROQ_MODELS), groq: () => chat(CLEAN) });
  const ai = AI({ groq: { enabled: true, apiKey: GROQ_KEY, model: '' } });
  const { verdict } = await check(ai);
  ok(calls.to('groq', 'models')[0]?.url === 'https://api.groq.com/openai/v1/models', 'the list comes from GET /openai/v1/models');
  ok(calls.to('groq')[0]?.body.model === 'llama-3.3-70b-versatile',
    `the first preferred model it offers was used (${calls.to('groq')[0]?.body.model}), not the inactive Kimi or the 8B`);
  ok(verdict?.model === 'llama-3.3-70b-versatile', 'and the verdict names it');
  ok(lines.some((l) => /Groq: no model set, so using llama-3\.3-70b-versatile/.test(l)), 'the choice is logged');
  await check(ai);
  ok(calls.to('groq', 'models').length === 1, 'the list is fetched once, not per film');

  const list = await listModels('groq', GROQ_KEY);
  ok(list.ok && !list.models.some((m) => /whisper|guard/.test(m.id)), 'speech and guard models are not offered as chat models');
  ok(!list.models.some((m) => m.id.startsWith('moonshotai')), 'nor is one Groq marks inactive');

  ok(pickModel('mistral', [{ id: 'codestral-latest' }, { id: 'pixtral-large-latest' }])?.model === 'pixtral-large-latest',
    'with none of the preferred models, the first general chat model - not a code model');
  ok(pickModel('mistral', [{ id: 'codestral-latest' }])?.model === 'codestral-latest', 'and a code model only if that is all there is');
  ok(MODEL_PREFERENCES.mistral[0] === 'mistral-large-latest' && MODEL_PREFERENCES.cerebras.includes('llama-3.3-70b'),
    'the preference lists start with the large general-knowledge models');

  fresh();
  const mistralCalls = stub({
    gemini: GEMINI_503,
    'mistral:models': () => res(200, { object: 'list', data: [
      { id: 'mistral-embed', object: 'model', owned_by: 'mistralai', capabilities: { completion_chat: false } },
      { id: 'mistral-small-latest', object: 'model', owned_by: 'mistralai', capabilities: { completion_chat: true }, max_context_length: 131072 },
    ] }),
    mistral: () => chat(CLEAN, { model: 'mistral-small-latest' }),
  });
  await check(AI({ order: ['mistral'], groq: { enabled: false }, cerebras: { enabled: false }, gemini: { enabled: false }, mistral: { enabled: true, apiKey: MISTRAL_KEY, model: '' } }));
  ok(mistralCalls.to('mistral')[0]?.body.model === 'mistral-small-latest', "Mistral's embedding model is filtered out by its capabilities");

  fresh();
  let listed = 0;
  stub({
    gemini: GEMINI_503,
    'groq:models': () => { listed += 1; return res(200, GROQ_MODELS); },
    groq: (_u, _i, n) => (n === 1 ? GROQ_404() : chat(CLEAN)),
    cerebras: () => chat(CLEAN, { model: 'llama-3.3-70b' }),
  });
  const auto = AI({ groq: { enabled: true, apiKey: GROQ_KEY, model: '' } });
  await check(auto);
  resetBreakers();
  await check(auto);
  ok(listed === 2, 'an automatic model the provider no longer has is forgotten, and chosen again from a fresh list');

  fresh();
  stub({ gemini: GEMINI_503, 'groq:models': GROQ_401, cerebras: () => chat(CLEAN, { model: 'llama-3.3-70b' }) });
  const bad = await check(auto);
  ok(bad.r.attempts[1]?.provider === 'groq' && bad.r.attempts[1].reason === 'auth' && bad.verdict?.provider === 'cerebras',
    'a key the model list refuses is a bad key, and the chain moves on');
}

/* ------------------------------ the policy ------------------------------ */

console.log('=== the safety policy: a fallback clears nothing unless ticked, and nobody denies ===');
{
  const OPTS = { minConfidence: 0.7, allowCleanRatedFilms: true };
  const v = (provider, nudity, canClearRated, confidence = 0.95) => ({ nudity, confidence, basis: 'b', provider, canClearRated });

  // A rated-blocked film (an R), with the operator having allowed clean rated films through.
  ok(decide(v('groq', false, false), true, OPTS).blocked === true,
    'Groq "no nudity" does NOT clear an R film, even with allowCleanRatedFilms on');
  ok(decide(v('groq', false, false), true, OPTS).reason === 'blocked by rating'
    && /not trusted to clear rated titles/.test(decide(v('groq', false, false), true, OPTS).note),
    'it is treated as no answer: blocked by rating, with a note saying why');
  for (const p of ['cerebras', 'mistral']) {
    ok(decide(v(p, false, false), true, OPTS).blocked === true, `nor does ${p[0].toUpperCase()}${p.slice(1)}'s`);
  }
  ok(decide({ nudity: false, confidence: 0.95, basis: 'b', provider: 'groq' }, true, OPTS).blocked === true,
    'a fallback verdict that does not say it may clear is treated as one that may not');
  ok(decide(v('groq', false, true), true, OPTS).blocked === false,
    'only when the operator ticks "may clear rated films" for that provider does it clear one');
  ok(decide(v('groq', false, true), true, { ...OPTS, allowCleanRatedFilms: false }).blocked === true,
    'and even then only with allowCleanRatedFilms on');

  // No "nudity" blocks anything the rating lets through, whoever says it:
  // "No, AI only helps" (the operator, 2026-09-29).
  const nude = decide(v('mistral', true, false), false, OPTS);
  ok(nude.blocked === false && nude.reason === 'allowed',
    'a confident "contains nudity" from a fallback does not block a film the rating allows');
  ok(decide(v('gemini', true, true), false, OPTS).blocked === false, 'nor does Gemini\'s');
  ok(decide(v('gemini', true, true), true, OPTS).reason === 'blocked by rating',
    'on a film its rating blocks, Gemini\'s "nudity" leaves it refused on its rating, not on the answer');
  ok(decide(v('groq', false, false), false, OPTS).blocked === false, 'and a fallback "no nudity" on a film the rating allows changes nothing');

  // Gemini behaviour unchanged.
  ok(decide(v('gemini', false, true), true, OPTS).blocked === false, 'Gemini "no nudity" still clears an R film with allowCleanRatedFilms on');
  ok(decide({ nudity: false, confidence: 0.95, basis: 'b' }, true, OPTS).blocked === false,
    'as does a verdict from before providers were named (it was Gemini)');
  ok(decide(v('gemini', false, true), true, { ...OPTS, allowCleanRatedFilms: false }).blocked === true, 'and not with it off');
  ok(decide(v('gemini', false, false), true, OPTS).blocked === true, 'unless the operator turns Gemini\'s flag off too');
  ok(decide(null, true, OPTS).blocked === true && decide(null, false, OPTS).blocked === false, 'no answer: the rating decides, as before');
  ok(mayClearRated(null) === false, 'no verdict clears nothing');

  // The request paths ask only the providers allowed to clear (onlyClearing):
  // Gemini out of quota, Groq unticked, Cerebras ticked - Groq is not asked,
  // and Cerebras's "no nudity" clears the film.
  fresh();
  const only = stub({ gemini: () => GEMINI_429_DAILY, groq: () => chat(NUDE), cerebras: () => chat(CLEAN, { model: 'llama-3.3-70b' }) });
  const ticked = await check(AI({ cerebras: { enabled: true, apiKey: CEREBRAS_KEY, model: 'llama-3.3-70b', canClearRated: true } }),
    { onlyClearing: true });
  ok(only.to('groq').length === 0 && ticked.verdict?.provider === 'cerebras' && decide(ticked.verdict, true, OPTS).blocked === false,
    `onlyClearing: a provider not allowed to clear is not asked, and one that is answers (${ticked.verdict?.provider})`);
  fresh();
  const none = stub({ gemini: () => GEMINI_429_DAILY });
  const noone = await check(AI(), { onlyClearing: true });
  ok(noone.verdict === null && none.to('groq').length === 0 && none.to('cerebras').length === 0,
    'with only Gemini allowed and out of quota, no untrusted provider is asked in its place');

  // End to end: the flag comes from config and rides on the verdict.
  fresh();
  stub({ gemini: () => GEMINI_429_DAILY, groq: () => chat(CLEAN) });
  const fb = await check();
  ok(fb.verdict.canClearRated === false, 'a Groq verdict carries canClearRated false by default');
  ok(decide(fb.verdict, true, OPTS).blocked === true, 'so, end to end, Kill Me Three Times stays blocked when Groq judged it');
  fresh();
  stub({ gemini: () => geminiSays(CLEAN) });
  const gm = await check();
  ok(gm.verdict.canClearRated === true && decide(gm.verdict, true, OPTS).blocked === false, 'and is cleared when Gemini judged it, as before');
  const plan = chainPlan({ gemini: GCFG, ai: {} });
  ok(plan.find((p) => p.id === 'gemini').canClearRated === true
    && plan.filter((p) => p.id !== 'gemini').every((p) => p.canClearRated === false && p.enabled === false),
    'defaults with no ai config at all: Gemini may clear, the others may not and are off');
}

/* ------------------------------ the lookup ------------------------------ */

console.log('=== the film lookup uses the same chain ===');
{
  fresh();
  const calls = stub({ gemini: () => GEMINI_429_DAILY, groq: () => chat('{"title": "Memento", "year": 2000, "confidence": 0.9}') });
  const seen = [];
  const r = await identifyTitle('the one with the guy who forgets everything', GCFG, { ai: AI(), onResult: (x) => seen.push(x) });
  ok(r?.title === 'Memento' && r.provider === 'groq', `Groq identified it when Gemini's quota was gone (${r?.provider})`);
  ok(calls[0].body.contents?.[0].parts[0].text.includes('forgets everything'), 'Gemini was asked first, with the same prompt as before');
  ok(calls.to('groq')[0].body.messages[0].content.includes('Do NOT include a rating'), 'and Groq got that prompt too');
  ok(seen[0]?.attempts?.length === 2, 'onResult hears about both attempts, for the panel');
  ok(breakerSnapshot().some((b) => b.provider === 'gemini' && b.reason === 'quota-daily'),
    'and the lookup trips the same breaker as the nudity check, since it spends the same quota');

  fresh();
  const dunno = stub({ gemini: () => geminiSays('{"title": null, "year": null, "confidence": 0}'), groq: () => chat('{"title": "Something", "year": 2001, "confidence": 0.9}') });
  ok(await identifyTitle('asdfgh', GCFG, { ai: AI() }) === null, 'Gemini saying it does not know is an answer: null');
  ok(dunno.to('groq').length === 0, 'and a less knowledgeable model is not then asked to guess');

  fresh();
  stub({ gemini: GEMINI_503, groq: GROQ_401, cerebras: GEMINI_503, mistral: () => res(500, {}) });
  ok(await identifyTitle('heat 1995', GCFG, { ai: AI() }) === null, 'every provider failing is still just "no suggestion"');

  fresh();
  const noGemini = stub({ groq: () => chat('{"title": "Heat", "year": 1995, "confidence": 0.9}') });
  const h = await identifyTitle('heat', { enabled: true, apiKey: '' }, { ai: AI() });
  ok(h?.title === 'Heat' && noGemini.to('gemini').length === 0, 'with no Gemini key, the fallbacks still answer');
}

/* ------------------------------ health ------------------------------ */

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

function rig({ ai = AI(), clock = { t: Date.parse('2026-09-22T17:00:00Z') } } = {}) {
  // An account to send through: email with none counts as off (emailReady).
  const cfg = { email: { enabled: true, to: 'a@b.c', user: 'bot@b.c', appPassword: 'app-pw', onContentCheck: true }, gemini: { ...GCFG }, ai };
  const configStore = { get: () => cfg };
  const alerts = new AlertWatcher({ configStore, fileLogger: { today: () => 'LOG' } });
  alerts.delivered = [];
  alerts._deliver = async (_c, payload) => { alerts.delivered.push(payload); };
  const stateStore = memoryState();
  const health = new ContentCheckHealth({ alerts, configStore, stateStore, now: () => clock.t });
  const run = async (title) => {
    await checkNudity(title, 2001, cfg.gemini, {
      ai: cfg.ai, now: () => clock.t, timeoutMs: 50,
      onResult: (r) => health.record({ ...r, title, year: 2001 }),
    });
    await new Promise((r) => setTimeout(r, 5));
  };
  return { cfg, alerts, health, clock, run, stateStore };
}

console.log('=== a routine Gemini exhaustion raises no alert while a fallback answers ===');
{
  fresh();
  const { health, alerts, run, clock } = rig();
  stub({ gemini: () => GEMINI_429_DAILY, groq: () => chat(CLEAN) });
  for (let i = 0; i < 8; i++) { await run(`Film ${i}`); clock.t += 10 * 60_000; }
  const snap = health.snapshot();
  ok(alerts.delivered.length === 0 && snap.degraded === false, 'eight films on Groq: no email, not degraded');
  ok(snap.answeredBy?.provider === 'groq' && snap.answeredBy.label === 'Groq', 'the panel is told Groq answered last');
  ok(snap.fallback?.provider === 'gemini' && snap.fallback.using === 'Groq', 'and that Gemini is held back while Groq stands in');
  ok(snap.fallback.until === Date.parse('2026-09-23T07:00:00Z'), 'until midnight Pacific');
  ok(/daily quota/.test(snap.fallback.headline), `with the reason: "${snap.fallback.headline}"`);
  ok(snap.fallback.usingMayClearRated === false, 'and that Groq may not clear rated films');
  const rows = Object.fromEntries(snap.providers.map((p) => [p.id, p]));
  ok(rows.gemini.state === 'held' && rows.groq.state === 'ok' && rows.cerebras.state === 'unknown',
    `per provider: Gemini held, Groq ok, Cerebras not asked yet (${rows.gemini.state}, ${rows.groq.state}, ${rows.cerebras.state})`);
}

console.log('=== the whole chain failing is one aggregated failure, naming every reason ===');
{
  fresh();
  const { health, alerts, run } = rig();
  stub({ gemini: () => GEMINI_429_DAILY, groq: GROQ_401, cerebras: CEREBRAS_429_DAY, mistral: MISTRAL_BAD_MODEL });
  const seen = [];
  await checkNudity('Film X', 2001, GCFG, { ai: AI(), onResult: (r) => seen.push(r) });
  const f = seen[0]?.failure;
  ok(seen.length === 1 && f?.reason === 'all-failed', 'one report, of all-failed');
  ok(f.attempts.map((a) => `${a.provider}:${a.reason}`).join(' ')
    === 'gemini:quota-daily groq:auth cerebras:quota-daily mistral:model-not-found', `each provider's reason: ${f.summary}`);
  resetBreakers();
  for (const t of ['Film A', 'Film B', 'Film C']) await run(t);
  ok(alerts.delivered.length === 1, `three all-failed checks raise one alert (${alerts.delivered.length})`);
  const mail = alerts.delivered[0];
  ok(/no AI provider could run the check/.test(mail.label), `the subject says no provider could: ${mail.label.slice(0, 90)}…`);
  for (const [who, what] of [['Gemini', /daily quota/], ['Groq', /refused the API key/], ['Cerebras', /daily limit/], ['Mistral', /no model called "mistral-large-latest"|no model called/]]) {
    ok(mail.note.includes(who) && what.test(mail.note), `the email names ${who}'s reason`);
  }
  ok(/Groq: Check the key in Settings → API keys & logins 🔑 → AI providers → Groq/.test(mail.note), 'with each provider\'s own fix');
  ok(health.snapshot().degraded === true, 'the dashboard shows the check not running');
  const everything = JSON.stringify(alerts.delivered) + JSON.stringify(health.snapshot()) + lines.join('\n');
  ok(ALL_KEYS.every((k) => !everything.includes(k)), 'no key in the email, the snapshot or the log');

  stub({ gemini: () => GEMINI_429_DAILY, groq: () => chat(CLEAN) });
  resetBreakers();
  await run('Film D');
  ok(health.snapshot().degraded === false && /working again/.test(alerts.delivered.at(-1).label),
    'one provider answering again is the check working again');
}

console.log('=== with only one provider, its failure is reported exactly as before ===');
{
  fresh();
  stub({ gemini: () => GEMINI_429_DAILY });
  const { r } = await check(null);
  ok(r.failure.reason === 'quota-daily' && r.failure.quotaId === 'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
    'a lone Gemini reports quota-daily with its quota id, not all-failed');
  ok(/Gemini's daily quota is used up/.test(describeFailure(r.failure).headline), 'and reads as it always did');
}

console.log('=== keys never reach a log line, an alert or a failure ===');
{
  fresh();
  const echo = (key) => () => res(401, { error: { message: `Invalid API Key: ${key} (Authorization: Bearer ${key})`, type: 'invalid_request_error', code: 'invalid_api_key' } });
  stub({ gemini: () => GEMINI_429_DAILY, groq: echo(GROQ_KEY), cerebras: echo(CEREBRAS_KEY), mistral: echo(MISTRAL_KEY) });
  const { r } = await check();
  const out = JSON.stringify(r) + lines.join('\n');
  ok(ALL_KEYS.every((k) => !out.includes(k)), 'an error body that echoes the key back has it taken out everywhere');
  ok(!/gsk_[0-9A-Za-z]{20,}|csk-[0-9A-Za-z]{20,}|AIza[0-9A-Za-z_-]{20,}/.test(out), 'nor anything shaped like one');
  ok(scrubKeys(`a ${MISTRAL_KEY} b ${MISTRAL_KEY}`, [MISTRAL_KEY]) === 'a *** b ***', 'a Mistral key has no prefix, so it is taken out by value, every copy');
}

/* ------------------------- found in review ------------------------- */

// Review of this branch: a reply cut off by the token cap was parsed anyway,
// and whatever JSON its unfinished reasoning held became the verdict. With no
// opening tag to find, stripReasoning could not take the reasoning out, the
// chain stopped at the half-finished "maybe {nudity: false}", and the next
// provider - which would have said the film has nudity - was never asked.
console.log('=== a reply cut off by the token cap is not read unless it is one whole JSON object ===');
{
  const GUESS = '{"nudity": false, "confidence": 0.9, "basis": "a first guess"}';
  const cases = [
    ['prose musing, no tags', `Okay, let me think. A first guess would be ${GUESS} but I recall a scene in the second act where`],
    ['a <think> opened by the chat template, never closed', `The user asks about this film. I believe ${GUESS} is right, although`],
    ['harmony analysis with no final channel', `<|channel|>analysis<|message|>Recall the parents guide: ${GUESS} hmm, but`],
    ["Magistral's [THINK] marker", `[THINK]Let me see. ${GUESS} but wait, there is`],
  ];
  for (const [name, text] of cases) {
    fresh();
    const calls = stub({ gemini: GEMINI_503, groq: () => chat(text, { finish: 'length', reasoning: 2000 }), cerebras: () => chat(NUDE, { model: 'llama-3.3-70b' }) });
    const { verdict, r } = await check();
    const g = r?.attempts?.find((a) => a.provider === 'groq');
    ok(g?.reason === 'incomplete' && verdict?.provider === 'cerebras' && verdict.nudity === true && calls.to('cerebras').length === 1,
      `${name}: incomplete, and the next provider decides (${g?.reason}, ${verdict?.provider})`);
  }

  fresh();
  stub({ gemini: GEMINI_503, groq: () => chat(`${NUDE}\n\n   \n`, { finish: 'length' }) });
  const padded = await check();
  ok(padded.verdict?.provider === 'groq' && padded.verdict.nudity === true,
    'a finished answer padded with whitespace up to the cap (JSON mode does that) is still read');

  fresh();
  stub({ gemini: GEMINI_503, groq: () => chat('...maybe {"title": "Heat", "year": 1995, "confidence": 0.8} though it could be', { finish: 'length' }), cerebras: () => chat('{"title": "Ronin", "year": 1998, "confidence": 0.9}', { model: 'llama-3.3-70b' }) });
  const t = await identifyTitle('the one with the heist', GCFG, { ai: AI() });
  ok(t?.title === 'Ronin' && t.provider === 'cerebras', `the film lookup does not take a title from cut-off reasoning either (${t?.title} from ${t?.provider})`);

  fresh();
  stub({ gemini: () => res(200, { candidates: [{ content: { parts: [{ text: NUDE }] }, finishReason: 'MAX_TOKENS' }] }) });
  const gem = await check();
  ok(gem.verdict?.provider === 'gemini' && gem.verdict.nudity === true, "Gemini's replies are read as they were before there were fallbacks");

  ok(isOneJsonObject(' {"a": 1}\n') && !isOneJsonObject('x {"a": 1}') && !isOneJsonObject('{"a": 1} y') && !isOneJsonObject('[1]') && !isOneJsonObject('{"a": '),
    'isOneJsonObject: one object and whitespace, nothing else');
  ok(stripReasoning('[THINK]{"nudity": true}[/THINK]{"nudity": false}') === '{"nudity": false}', "a closed Magistral [THINK] block goes");
  ok(stripReasoning('[THINK]it has {"nudity": true') === '', 'an unclosed one leaves no answer');
  ok(stripReasoning('<|channel|>analysis<|message|>{"nudity": true}<|end|>') === '', 'harmony analysis with no final channel leaves no answer');
}

// Review of this branch: openAiHttpFailure scrubbed the message but copied a
// provider's error code and type into apiStatus and quotaId as they came. A key
// echoed there reached state.json and the dry run's headline. No provider is
// known to do that; the failure object is saved and shown, so all of it is
// scrubbed now.
console.log('=== a key echoed in an error code or type is scrubbed from the failure, state.json and the headline ===');
{
  fresh();
  const echo = (key) => () => res(500, { error: { message: 'x', type: `t ${key}`, code: `c ${key}` } });
  stub({ gemini: () => res(503, { error: { code: 503, message: 'down', status: `UNAVAILABLE ${GEMINI_KEY}` } }), groq: echo(GROQ_KEY), cerebras: echo(CEREBRAS_KEY), mistral: echo(MISTRAL_KEY) });
  const { r } = await check();
  const f = r.failure;
  ok(f.reason === 'all-failed' && f.attempts.length === 4, 'every provider failed (the case the probe used)');
  ok(ALL_KEYS.every((k) => !JSON.stringify(f).includes(k)), 'no key anywhere in the failure object');
  ok(ALL_KEYS.every((k) => !describeFailure(f).headline.includes(k)), 'nor in the headline the dry run shows');
  ok(f.attempts.find((a) => a.provider === 'groq').apiStatus === 'c ***', `the code keeps its shape with the key taken out (${f.attempts.find((a) => a.provider === 'groq').apiStatus})`);

  const { health, stateStore } = rig();
  await health.record({ ok: false, failure: { ...f, attempts: f.attempts.map((a) => ({ ...a, apiStatus: `c ${GROQ_KEY}`, finishReason: GROQ_KEY })) }, attempts: [{ provider: 'groq', ok: false, reason: 'server', model: GROQ_KEY }] });
  ok(ALL_KEYS.every((k) => !JSON.stringify(stateStore.data).includes(k)), 'the health tracker scrubs what it saves, whatever it is handed');

  const direct = openAiHttpFailure(429, JSON.stringify({ error: { message: 'm', type: `requests ${'x'.repeat(200)}`, code: `rate_limit_exceeded ${GROQ_KEY}` } }), new Headers(), { provider: 'groq', keys: [GROQ_KEY] });
  ok(!JSON.stringify(direct).includes(GROQ_KEY) && direct.apiStatus.length <= 60 && direct.quotaId.length <= 60,
    'openAiHttpFailure scrubs and caps the code and type itself');
  ok(!JSON.stringify(geminiHttpFailure(503, JSON.stringify({ error: { status: `UNAVAILABLE ${GEMINI_KEY}` } }), { key: GEMINI_KEY })).includes(GEMINI_KEY),
    "and so does Gemini's, for its status field");
  ok(JSON.stringify(scrubFailure({ a: [{ b: { c: `k ${MISTRAL_KEY}` } }], n: 3, z: null }, [MISTRAL_KEY])) === '{"a":[{"b":{"c":"k ***"}}],"n":3,"z":null}',
    'scrubFailure reaches nested strings and leaves the rest alone');
  const api = fs.readFileSync(new URL('../src/web/api.js', import.meta.url), 'utf8');
  ok(/failed = gate\.failed \? scrubFailure\(gate\.failed, configuredKeys\(cfg\)\)/.test(api), 'the dry run scrubs the failure its headline is built from as well');
}

// Review of this branch: with several providers the reason is always
// "all-failed", and the incident filed its one email under that. When the
// providers' reasons changed inside the same incident - Groq's key fixed, then
// Groq out of quota and Mistral refusing its key - nothing more was sent.
console.log('=== a new reason from any provider, while every provider is failing, is a new email ===');
{
  fresh();
  const { health, alerts, run } = rig();
  stub({ gemini: () => GEMINI_429_DAILY, groq: GROQ_401, cerebras: () => res(500, { error: { message: 'boom' } }), mistral: MISTRAL_BAD_MODEL });
  for (const t of ['A1', 'A2', 'A3']) { resetBreakers(); await run(t); }
  ok(alerts.delivered.length === 1, `three all-failed checks: one email (${alerts.delivered.length})`);
  stub({ gemini: () => GEMINI_429_DAILY, groq: GROQ_429_RPD, cerebras: () => chat('{"nudity": tr', { finish: 'length' }), mistral: () => res(401, { message: 'Unauthorized', type: 'authentication_error' }) });
  resetBreakers();
  await run('B1');
  ok(alerts.delivered.length === 2, `the reasons changed: a second email (${alerts.delivered.length})`);
  const mail = alerts.delivered[1];
  ok(/Groq's daily limit is used up/.test(mail.note) && /Mistral refused the API key/.test(mail.note), 'naming what is wrong now');
  resetBreakers();
  await run('B2');
  ok(alerts.delivered.length === 2, 'the same set again sends nothing more');
  ok(JSON.stringify(alertKeys({ reason: 'all-failed', attempts: [{ provider: 'gemini', reason: 'timeout' }, { provider: 'groq', reason: 'out-of-time' }] }))
    === '["all-failed:gemini=timeout"]', 'a provider only not reached in time is not a reason of its own');
  ok(JSON.stringify(alertKeys({ reason: 'quota-daily' })) === '["quota-daily"]', 'a single provider files under its reason, as before');
  stub({ gemini: () => geminiSays(CLEAN) });
  resetBreakers();
  await run('C1');
  ok(/working again/.test(alerts.delivered.at(-1).label) && alerts.delivered.length === 3, 'and one "working again" note closes it');
}

// Review of this branch: a held provider that the chain ran out of time to
// reach was recorded as "out-of-time" with no retry time. That replaced
// "Gemini's daily quota is used up, held until 07:00 UTC" on the dashboard
// while the breaker still held Gemini, and the email advised reordering the
// providers instead of saying Gemini's quota was gone.
console.log('=== a held provider not reached in time keeps its reason and its retry time ===');
{
  fresh();
  const { health, clock, cfg } = rig({ ai: AI({ mistral: { enabled: false } }) });
  stub({ gemini: () => GEMINI_429_DAILY, groq: () => chat(CLEAN) });
  await checkNudity('Film A', 2001, cfg.gemini, { ai: cfg.ai, now: () => clock.t, onResult: (r) => health.record(r) });
  ok(health.snapshot().providers.find((p) => p.id === 'gemini').state === 'held', 'after film A, Gemini is held (its quota is gone)');
  stub({ gemini: () => GEMINI_429_DAILY, groq: hang, cerebras: hang });
  let fB = null;
  lines.length = 0;
  await checkNudity('Film B', 2001, cfg.gemini, {
    ai: cfg.ai, now: () => clock.t, timeoutMs: 100, totalMs: 250,
    onResult: (r) => { fB = r.failure; return health.record(r); },
  });
  const g = fB?.attempts?.find((a) => a.provider === 'gemini');
  ok(g?.skipped === true && g.reason === 'quota-daily' && g.until === Date.parse('2026-09-23T07:00:00Z'),
    `Groq and Cerebras used the time; Gemini is reported as held for its quota until midnight Pacific (${g?.reason})`);
  const snap = health.snapshot();
  const row = snap.providers.find((p) => p.id === 'gemini');
  ok(row.state === 'held' && row.reason === 'quota-daily' && breakerFor(chainPlan(cfg)[0], clock.t),
    `the dashboard still says so, as the breaker does (${row.state}, ${row.reason})`);
  ok(snap.fallback?.provider === 'gemini', 'and the fallback line stays');
  const advice = describeFailure(fB).advice.split('\n').find((l) => l.startsWith('Gemini:'));
  ok(/billing|fallback provider/.test(advice) && !/Put the provider/.test(advice), `the alert gives the real cause for Gemini: "${advice.slice(0, 80)}…"`);
  ok(lines.some((l) => /Gemini: quota-daily \(held back, not reached in time\)/.test(l)), 'and so does the log');
}

// Review of this branch: untilMidnightPacific counted 24 hours minus the time
// elapsed in Los Angeles, but the days the clocks change are 23 and 25 hours
// long. It now drives the breaker, so between midnight and 2 AM on those days
// Gemini was held an hour past its reset, or released an hour early.
console.log('=== midnight Pacific is found correctly on the days the clocks change ===');
{
  const reset = (iso) => new Date(Date.parse(iso) + untilMidnightPacific(Date.parse(iso))).toISOString();
  ok(reset('2026-03-08T09:30:00Z') === '2026-03-09T07:00:00.000Z', `spring forward, 01:30 PST: resets at 00:00 PDT (${reset('2026-03-08T09:30:00Z')})`);
  ok(reset('2026-03-08T20:00:00Z') === '2026-03-09T07:00:00.000Z', 'and later the same day');
  ok(reset('2026-03-07T20:00:00Z') === '2026-03-08T08:00:00.000Z', 'and the day before');
  ok(reset('2026-11-01T07:30:00Z') === '2026-11-02T08:00:00.000Z', `fall back, 00:30 PDT: resets at 00:00 PST (${reset('2026-11-01T07:30:00Z')})`);
  ok(reset('2026-11-01T20:00:00Z') === '2026-11-02T08:00:00.000Z', 'and later the same day');
  ok(reset('2026-10-31T20:00:00Z') === '2026-11-01T07:00:00.000Z', 'and the day before');
  ok(untilMidnightPacific(Date.parse('2026-09-22T07:00:00Z')) === 86_400_000, 'midnight itself is a full day away');
  ok(untilMidnightPacific(Date.parse('2026-09-22T06:59:59.500Z')) === 500, 'to the millisecond');
}

// Review of this branch: with "Ask Gemini" switched off in the AI providers
// card, a Gemini key saved and no fallback on, the check reported "there is
// no Gemini API key" and sent the operator to enter a key that was there. The
// film lookup meanwhile did nothing, without a log line.
console.log('=== every provider switched off is told apart from no key at all ===');
{
  fresh();
  stub({});
  const offAi = AI({ gemini: { enabled: false }, groq: { enabled: false }, cerebras: { enabled: false }, mistral: { enabled: false } });
  const { verdict, r } = await check(offAi);
  ok(verdict === null && r?.failure.reason === 'no-provider' && r.failure.off.join() === 'gemini', `reported as no-provider, naming Gemini (${r?.failure.reason})`);
  const d = describeFailure(r.failure);
  ok(/switched off/.test(d.headline) && !/no Gemini API key/.test(d.headline), `"${d.headline}"`);
  ok(/"Ask Gemini"/.test(d.advice) && /AI providers/.test(d.advice), `and says which switch: "${d.advice}"`);
  ok(lines.some((l) => /content check for "Some Film" did not run: every AI provider with a key is switched off \(Gemini\)/.test(l)), 'with a log line');
  lines.length = 0;
  ok(await identifyTitle('heat', GCFG, { ai: offAi }) === null, 'the lookup returns nothing');
  ok(lines.some((l) => /^warn gemini: title lookup for "heat" did not run: every AI provider with a key is switched off/.test(l)), 'but says why in the log');
  const none = await check(offAi, {}, { ...GCFG, apiKey: '' });
  ok(none.r?.failure.reason === 'no-key', 'with no key anywhere it is still no-key');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
