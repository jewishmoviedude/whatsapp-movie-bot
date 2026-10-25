/* The Test button on each row of Settings → AI providers, and the route behind it.
   Run: node test/ai-key-test.test.mjs

   2026-09-22: the Groq, Cerebras and Mistral fallbacks went in because
   Gemini's free tier (20 requests a day) was gone by mid-morning, and the user
   pasted keys from three consoles into the card - then asked "you didn't put
   a test key button for each one". Without one, the first sign of a key
   copied short or a model the key cannot use was a film going out on its
   rating alone.

   What must hold, because the test runs beside the live bot:
   - a key typed into the box is tested without being saved, and never
     appears in a response, a log line or the audit trail;
   - an empty box, or the mask, tests the saved key;
   - each failure says what to do (key rejected / model not available /
     quota reached, key fine / unreachable);
   - Gemini is NEVER sent generateContent - that would spend one of the 20
     requests a day the bot needs; its key and model are checked by listing
     models instead;
   - a failing test changes nothing the chain relies on: no breaker tripped or
     closed, no health status, no alert, no automatic-model cache written;
   - one test per provider every few seconds, and only for signed-in admins -
     the same guard as saving the card.

   Drives the real ConfigStore, ContentCheckHealth and router over HTTP. No
   network: fetch is stubbed with the response shapes each API really returns.
   The panel half is in ai-key-test-panel.test.mjs, which needs linkedom. */
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import log from '../src/util/logger.js';
import { ConfigStore, MASK } from '../src/config/store.js';
import { createApiRouter } from '../src/web/api.js';
import { JobQueue } from '../src/core/queue.js';
import { hashPassword } from '../src/util/crypto.js';
import {
  resetBreakers, breakerSnapshot, resetModelCache, resolveModel, cachedModel, chainPlan, askChain,
  breakerFor, testProvider, KEY_TEST,
} from '../src/core/ai-providers.js';
import { ContentCheckHealth } from '../src/core/content-check-health.js';
import { askGemini } from '../src/plugins/movie-requests/gemini.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const lines = [];
log.on('line', (e) => lines.push(`${e.level} ${e.scope}: ${e.msg}`));

/* ------------------------------ fixtures ------------------------------ */

const GEMINI_KEY = 'AIzaSyTESTsavedGEMINI_0123456789-abcdefg';
const TYPED_GEMINI_KEY = 'AIzaSyTESTtypedGEMINI_9876543210-zyxwvut';
const BAD_GEMINI_KEY = 'AIzaSyTESTbadGEMINIkey_000000000-aaaaaa';
const GROQ_KEY = 'gsk_TESTsavedGROQ0123456789abcdefghijklmnopqrstuvwxyzAB';
const TYPED_GROQ_KEY = 'gsk_TESTtypedGROQ9876543210zyxwvutsrqponmlkjihgfedcbaZ';
const BAD_GROQ_KEY = 'gsk_TESTbadGROQ00000000000000000000000000000000000000';
const CEREBRAS_KEY = 'csk-TESTsavedCEREBRAS0123456789abcdefghijklmnopqrstu';
const TYPED_MISTRAL_KEY = 'TESTtypedMISTRALkey0123456789abcd';
const KEYS = [GEMINI_KEY, TYPED_GEMINI_KEY, BAD_GEMINI_KEY, GROQ_KEY, TYPED_GROQ_KEY, BAD_GROQ_KEY, CEREBRAS_KEY, TYPED_MISTRAL_KEY];
const hasKey = (s) => KEYS.some((k) => String(s).includes(k));

// The rate limit is a real 5 s. Rather than sleep, the clock is moved on.
const realNow = Date.now;
let skew = 0;
Date.now = () => realNow() + skew;
const later = () => { skew += KEY_TEST.gapMs + 1000; };

const json = (status, payload, headers = {}) => new Response(
  typeof payload === 'string' ? payload : JSON.stringify(payload),
  { status, headers: { 'content-type': 'application/json', ...headers } },
);

// Groq's GET /openai/v1/models. The typed key sees Kimi K2, which Automatic
// prefers; the saved key's automatic choice is already cached (see below).
const GROQ_MODELS = (withKimi) => ({ object: 'list', data: [
  { id: 'whisper-large-v3', object: 'model', created: 1693721698, owned_by: 'OpenAI', active: true, context_window: 448, public_apps: null },
  ...(withKimi ? [{ id: 'moonshotai/kimi-k2-instruct-0905', object: 'model', created: 1757046093, owned_by: 'Moonshot AI', active: true, context_window: 262144, public_apps: null }] : []),
  { id: 'llama-3.3-70b-versatile', object: 'model', created: 1733447754, owned_by: 'Meta', active: true, context_window: 131072, public_apps: null },
  { id: 'llama-3.1-8b-instant', object: 'model', created: 1693721698, owned_by: 'Meta', active: true, context_window: 131072, public_apps: null },
] });
const CEREBRAS_MODELS = { object: 'list', data: [
  { id: 'llama-3.3-70b', object: 'model', created: 0, owned_by: 'Meta' },
  { id: 'llama3.1-8b', object: 'model', created: 0, owned_by: 'Meta' },
] };
const MISTRAL_MODELS = { object: 'list', data: [
  { id: 'mistral-embed', object: 'model', created: 1758550000, owned_by: 'mistralai',
    capabilities: { completion_chat: false, completion_fim: false, function_calling: false, fine_tuning: false, vision: false, classification: false },
    name: 'mistral-embed', max_context_length: 8192, aliases: [], deprecation: null, type: 'base' },
  { id: 'mistral-large-latest', object: 'model', created: 1758550000, owned_by: 'mistralai',
    capabilities: { completion_chat: true, completion_fim: false, function_calling: true, fine_tuning: false, vision: false, classification: false },
    name: 'mistral-large-2411', max_context_length: 131072, aliases: [], deprecation: null, type: 'base' },
] };
const GEMINI_MODELS = { models: [
  { name: 'models/embedding-001', version: '001', displayName: 'Embedding 001', inputTokenLimit: 2048, outputTokenLimit: 1,
    supportedGenerationMethods: ['embedContent'] },
  { name: 'models/gemini-3.6-flash', version: '001', displayName: 'Gemini 3.6 Flash', inputTokenLimit: 1048576, outputTokenLimit: 65536,
    supportedGenerationMethods: ['generateContent', 'countTokens', 'createCachedContent', 'batchGenerateContent'], thinking: true },
  { name: 'models/gemini-2.5-flash', version: '001', displayName: 'Gemini 2.5 Flash', inputTokenLimit: 1048576, outputTokenLimit: 65536,
    supportedGenerationMethods: ['generateContent', 'countTokens'] },
] };
const GEMINI_BAD_KEY = () => json(400, { error: {
  code: 400,
  message: 'API key not valid. Please pass a valid API key.',
  status: 'INVALID_ARGUMENT',
  details: [
    { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com',
      metadata: { service: 'generativelanguage.googleapis.com' } },
    { '@type': 'type.googleapis.com/google.rpc.LocalizedMessage', locale: 'en-US', message: 'API key not valid. Please pass a valid API key.' },
  ],
} });
const chat = (content, model) => json(200, {
  id: 'chatcmpl-7a1', object: 'chat.completion', created: 1758550000, model,
  choices: [{ index: 0, message: { role: 'assistant', content }, logprobs: null, finish_reason: 'stop' }],
  usage: { prompt_tokens: 24, completion_tokens: 6, total_tokens: 30 },
});
// Groq's real 429 for requests-per-day, with its headers.
const GROQ_429_RPD = () => json(429, { error: {
  message: 'Rate limit reached for model `llama-3.3-70b-versatile` in organization `org_01j` service tier `on_demand` on requests per day (RPD): Limit 1000, Used 1000, Requested 1. Please try again in 1m26.4s.',
  type: 'requests', code: 'rate_limit_exceeded',
} }, {
  'retry-after': '87', 'x-ratelimit-limit-requests': '1000', 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '1m26.4s',
});
const CEREBRAS_404 = (model) => json(404, {
  message: `Model ${model} does not exist or you do not have access to it.`, type: 'not_found_error', param: 'model', code: 'model_not_found',
});

/**
 * Every request is answered here and recorded, with the key it carried. A
 * request this suite did not expect fails the suite instead of reaching the
 * internet.
 */
const outbound = [];
const scene = { groqChat: null, cerebrasChat: null };
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const h = init.headers ?? {};
  const auth = String(h.Authorization ?? '').replace(/^Bearer /, '') || h['x-goog-api-key'] || null;
  const body = init.body ? JSON.parse(init.body) : null;
  const call = { url: u, method: init.method ?? 'GET', key: auth, body };
  outbound.push(call);

  if (u.startsWith('https://generativelanguage.googleapis.com/')) {
    if (u.includes(':generateContent')) return json(200, { candidates: [{ content: { parts: [{ text: '{}' }] }, finishReason: 'STOP' }] });
    if (!u.startsWith('https://generativelanguage.googleapis.com/v1beta/models?')) throw new Error(`unexpected Gemini request ${u}`);
    return [GEMINI_KEY, TYPED_GEMINI_KEY].includes(auth) ? json(200, GEMINI_MODELS) : GEMINI_BAD_KEY();
  }
  if (u === 'https://api.groq.com/openai/v1/models') {
    if (![GROQ_KEY, TYPED_GROQ_KEY].includes(auth)) {
      // Groq does not echo the key; this stand-in does, to prove it is scrubbed anyway.
      return json(401, { error: { message: `Invalid API Key ${auth}`, type: 'invalid_request_error', code: 'invalid_api_key' } });
    }
    return json(200, GROQ_MODELS(auth === TYPED_GROQ_KEY));
  }
  if (u === 'https://api.groq.com/openai/v1/chat/completions') {
    return scene.groqChat ? scene.groqChat(call) : chat('{"ok": true}', body.model);
  }
  if (u === 'https://api.cerebras.ai/v1/models') return json(200, CEREBRAS_MODELS);
  if (u === 'https://api.cerebras.ai/v1/chat/completions') {
    return scene.cerebrasChat ? scene.cerebrasChat(call) : chat('{"ok":true}', body.model);
  }
  if (u === 'https://api.mistral.ai/v1/models') {
    return auth === TYPED_MISTRAL_KEY ? json(200, MISTRAL_MODELS) : json(401, { message: 'Unauthorized', request_id: 'r1' });
  }
  if (u === 'https://api.mistral.ai/v1/chat/completions') {
    return json(200, {
      id: 'cmpl-e5c', object: 'chat.completion', created: 1758550000, model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', tool_calls: null, content: '{"ok": true}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 22, total_tokens: 29, completion_tokens: 7 },
    });
  }
  throw new Error(`test made an unexpected request to ${u}`);
};
const sent = (from) => outbound.slice(from);

/* ------------------------------ the server ------------------------------ */

function makeStateStore() {
  const spaces = new Map();
  return {
    namespace(name) {
      if (!spaces.has(name)) spaces.set(name, { data: {} });
      const sp = spaces.get(name);
      return {
        get: (k, d) => sp.data[k] ?? d,
        set: (k, v) => { sp.data[k] = v; },
        push: (k, v) => { (sp.data[k] ??= []).unshift(v); },
      };
    },
  };
}

const MASTER = 'test-master-key-for-the-key-test';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-key-test-'));
const configStore = new ConfigStore({ dataDir: dir, masterKey: MASTER });
configStore.load();
configStore.update({
  web: { admins: [
    { username: 'mommy', role: 'superadmin', passwordHash: hashPassword('x-password-1') },
    { username: 'helper', role: 'admin', passwordHash: hashPassword('x-password-2') },
  ] },
  gemini: { enabled: true, contentCheck: true, apiKey: GEMINI_KEY, model: 'gemini-3.6-flash' },
  ai: {
    order: ['gemini', 'groq', 'cerebras', 'mistral'],
    groq: { enabled: true, apiKey: GROQ_KEY, model: '' },
    cerebras: { enabled: true, apiKey: CEREBRAS_KEY, model: 'llama-3.3-70b' },
    mistral: { enabled: false, apiKey: '', model: '' },
  },
});
const stateStore = makeStateStore();
const contentHealth = new ContentCheckHealth({ configStore, stateStore });
let healthEvents = 0;
contentHealth.on('change', () => { healthEvents += 1; });

let who = { username: 'mommy', role: 'superadmin' };
const queue = new JobQueue({ concurrency: 1 });
queue.pause();
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.session = who ? { user: who } : {}; next(); });
app.use('/api', createApiRouter({
  configStore,
  bot: { groupCache: new Map(), groups: () => [], on: () => {}, state: 'connected' },
  queue,
  linkQueue: queue,
  pluginManager: { plugins: new Map(), notifyConfigChange: async () => {}, list: () => [] },
  stateStore,
  fileLogger: { tail: () => [] },
  alerts: {},
  lockScheduler: {},
  contentHealth,
}));
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const port = server.address().port;
const events = () => stateStore.namespace('audit').get('events', []);

const everyResponse = [];
function api(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, method, path: p,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} },
    (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(buf); } catch { /* not JSON */ }
        everyResponse.push(buf);
        resolve({ status: res.statusCode, text: buf, json: parsed });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const test = async (id, body) => { later(); return api('POST', `/api/ai/providers/${id}/test`, body); };

// The chain has already been running with the saved Groq key: its automatic
// choice is cached, from a list without Kimi in it.
resetBreakers();
resetModelCache();
const savedGroq = chainPlan(configStore.get()).find((p) => p.id === 'groq');
{
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init) => (String(url).endsWith('/models') ? json(200, GROQ_MODELS(false)) : prev(url, init));
  await resolveModel(savedGroq);
  globalThis.fetch = prev;
}
const cachedBefore = cachedModel(savedGroq);
const configOnDisk = () => fs.readFileSync(path.join(dir, 'config.json'), 'utf8');

console.log('=== a key typed into the box is tested, and not saved ===');
{
  const disk = configOnDisk();
  const from = outbound.length;
  const r = await test('groq', { apiKey: TYPED_GROQ_KEY, model: '' });
  ok(r.status === 200 && r.json.ok === true, `the typed key works (${r.status}: ${r.json?.message})`);
  ok(/^✓ Works — moonshotai\/kimi-k2-instruct-0905 answered in \d+\.\d s$/.test(r.json.message),
    `said plainly, with the model and the time: "${r.json.message}"`);
  ok(r.json.keySource === 'typed', 'and says it was the typed key that was tested');
  ok(sent(from).length === 2 && sent(from).every((c) => c.key === TYPED_GROQ_KEY),
    'both requests to Groq carried the typed key, not the saved one');
  const ask = sent(from).find((c) => c.url.endsWith('/chat/completions'));
  ok(ask?.body?.response_format?.type === 'json_object' && ask.body.temperature === 0,
    'the one chat request is in JSON mode at temperature 0, as the chain asks');
  ok(ask?.body?.messages?.length === 1 && ask.body.messages[0].content.length < 200, 'with a trivial prompt');
  ok(r.json.steps.map((s) => `${s.step}:${s.ok}`).join(' ') === 'key:true model:true answer:true',
    `three steps, each reported: ${r.json.steps.map((s) => s.detail).join(' | ')}`);
  ok(typeof r.json.latencyMs === 'number' && r.json.model === 'moonshotai/kimi-k2-instruct-0905' && r.json.automatic === true,
    'with the latency, the model and that it was the automatic choice');
  ok(configStore.get().ai.groq.apiKey === GROQ_KEY, 'the saved key is still the saved key');
  ok(configOnDisk() === disk, 'and config.json was not written at all');
  ok(!hasKey(r.text), 'the response carries no key');
  ok(cachedModel(savedGroq) === cachedBefore && cachedBefore === 'llama-3.3-70b-versatile',
    'the saved key\'s automatic model is unchanged, although the typed key would pick another');
  ok(cachedModel({ id: 'groq', key: TYPED_GROQ_KEY }) === null, 'and nothing was cached for the typed key either');
  const row = events()[0];
  ok(row?.action === 'tested the Groq key: ok' && /typed into the panel, not saved/.test(row.detail),
    `audited as "${row?.action}" — "${row?.detail}"`);
}

console.log('=== an empty box, or the mask, tests the saved key ===');
{
  for (const [what, body] of [['no apiKey at all', {}], ['an empty box', { apiKey: '' }], ['the mask', { apiKey: MASK }]]) {
    const from = outbound.length;
    const r = await test('groq', body);
    ok(r.status === 200 && r.json.ok && r.json.keySource === 'saved'
      && sent(from).length === 2 && sent(from).every((c) => c.key === GROQ_KEY), `${what}: the saved key was tested`);
  }
  const r = await test('groq', {});
  ok(r.json.model === 'llama-3.3-70b-versatile',
    `Automatic is checked exactly as the chain would ask: its cached choice for this key (${r.json.model}), not a fresh pick`);
  ok(/Automatic → llama-3\.3-70b-versatile/.test(r.json.steps[1].detail), `and says so: "${r.json.steps[1].detail}"`);
  const c = await test('cerebras', {});
  ok(c.json.ok && c.json.model === 'llama-3.3-70b' && c.json.automatic === false,
    'no model in the body: the saved model is the one checked');
  const s = await test('cerebras', { model: 'llama3.1-8b' });
  ok(s.json.ok && s.json.model === 'llama3.1-8b', 'a model in the body (the one chosen in the row) is checked instead');
  ok(configStore.get().ai.cerebras.model === 'llama-3.3-70b', 'without being saved');
}

console.log('=== automatic, from the provider\'s own list ===');
{
  const from = outbound.length;
  const r = await test('mistral', { apiKey: TYPED_MISTRAL_KEY, model: '' });
  ok(r.json.ok && r.json.model === 'mistral-large-latest', `Mistral: Automatic picks ${r.json.model}, skipping the embedding model`);
  ok(sent(from).every((c) => c.key === TYPED_MISTRAL_KEY), 'a key with no recognisable prefix is still the one sent');
  ok(!hasKey(r.text), 'and it is not in the response');
  ok(configStore.get().ai.mistral.apiKey === '' && configStore.get().ai.mistral.enabled === false,
    'Mistral is still unconfigured: testing a key does not save it or switch the provider on');
}

console.log('=== a bad key is said to be a bad key ===');
{
  const from = outbound.length;
  const r = await test('groq', { apiKey: BAD_GROQ_KEY });
  ok(r.status === 200 && r.json.ok === false && r.json.reason === 'auth', `refused (${r.json.reason})`);
  ok(r.json.message === '✗ Key rejected — check it was copied in full', `"${r.json.message}"`);
  ok(r.json.steps.length === 1 && r.json.steps[0].step === 'key' && r.json.steps[0].ok === false,
    `the key step failed and nothing after it ran: "${r.json.steps[0].detail}"`);
  ok(sent(from).length === 1, 'so no chat request was spent on it');
  ok(!hasKey(r.text), 'even though the provider quoted the key back in its error');
  ok(events()[0].action === 'tested the Groq key: bad key', `audited as "${events()[0].action}"`);
  const m = await test('mistral', {});
  ok(m.status === 400 && /^✗ No Mistral key to test/.test(m.json.message), `no typed key and none saved: "${m.json.message}"`);
  const junk = await test('groq', { apiKey: 'Bearer something with spaces' });
  ok(junk.status === 400 && /does not look like a Groq key/.test(junk.json.message), 'something that is not a key is refused, not sent');
}

console.log('=== a model the key cannot use ===');
{
  const from = outbound.length;
  const r = await test('cerebras', { model: 'llama-9-huge' });
  ok(r.json.ok === false && r.json.reason === 'model-not-found', 'not on the key\'s list: refused before any chat request');
  ok(r.json.message === '✗ llama-9-huge is not available on this key — pick another or use Automatic', `"${r.json.message}"`);
  ok(/llama-3\.3-70b/.test(r.json.steps[1].detail), `the detail names what the key can use: "${r.json.steps[1].detail}"`);
  ok(sent(from).length === 1, 'only the model list was fetched');
  scene.cerebrasChat = (call) => CEREBRAS_404(call.body.model);
  const gone = await test('cerebras', { model: 'llama3.1-8b' });
  scene.cerebrasChat = null;
  ok(gone.json.reason === 'model-not-found' && gone.json.steps.at(-1).step === 'answer'
    && /not available on this key/.test(gone.json.message), 'listed but refused when asked: the same plain message, at the answer step');
}

console.log('=== a quota refusal on the tiny request: the key is fine ===');
{
  scene.groqChat = () => GROQ_429_RPD();
  const r = await test('groq', {});
  scene.groqChat = null;
  ok(r.json.ok === false && /^quota/.test(r.json.reason), `refused (${r.json.reason})`);
  ok(/^✗ Rate limit \/ quota reached — try again in .+ \(the key itself is fine\)$/.test(r.json.message), `"${r.json.message}"`);
  ok(r.json.steps[0].ok === true && r.json.steps[1].ok === true && r.json.steps[2].ok === false,
    'the key and model steps passed; only the answer was refused');
}

console.log('=== an answer that is not JSON ===');
{
  scene.groqChat = (call) => chat('Sure! Here is the JSON you asked for: ok = true', call.body.model);
  const r = await test('groq', {});
  scene.groqChat = null;
  ok(r.json.ok === false && r.json.reason === 'unreadable' && /not with the JSON the bot needs/.test(r.json.message),
    `a reply that does not parse fails the test: "${r.json.message}"`);
}

console.log('=== Gemini: the key and model are checked, and no request is spent ===');
{
  const from = outbound.length;
  const r = await test('gemini', {});
  ok(r.status === 200 && r.json.ok === true && r.json.model === 'gemini-3.6-flash', 'the saved key and saved model work');
  // A box emptied in the panel is Automatic, as it is for the fallbacks.
  const auto = await test('gemini', { model: '' });
  ok(auto.json.ok === true && auto.json.automatic === true && auto.json.model === 'gemini-3.6-flash',
    `a blank model is Automatic, the newest Flash on the list: "${auto.json.message}"`);
  ok(/no request spent from Gemini's daily 20/.test(r.json.message), `and it says so: "${r.json.message}"`);
  ok(r.json.steps[2]?.step === 'answer' && r.json.steps[2].skipped === true && r.json.steps[2].ok === null,
    'the answer step is shown as not asked, rather than as passed');
  const typed = await test('gemini', { apiKey: TYPED_GEMINI_KEY, model: 'gemini-2.5-flash' });
  ok(typed.json.ok && typed.json.keySource === 'typed' && typed.json.model === 'gemini-2.5-flash', 'a typed key and model, too');
  const bad = await test('gemini', { apiKey: BAD_GEMINI_KEY });
  ok(bad.json.reason === 'auth' && bad.json.message === '✗ Key rejected — check it was copied in full',
    'a key Google calls API_KEY_INVALID is a rejected key');
  const retired = await test('gemini', { model: 'gemini-2.0-flash' });
  ok(retired.json.reason === 'model-not-found'
    && retired.json.message === '✗ gemini-2.0-flash is not available on this key — pick another or use Automatic',
  `a retired model: "${retired.json.message}"`);
  const toGemini = sent(from).filter((c) => c.url.includes('generativelanguage'));
  ok(toGemini.length === 5, `five tests, five requests to Gemini (${toGemini.length})`);
  ok(toGemini.every((c) => c.method === 'GET' && !c.url.includes(':generateContent')),
    'every one of them a GET of the model list: generateContent was never called');
  ok(toGemini.every((c) => !c.url.includes('key=')), 'with the key in a header, not in the URL');
  ok(configStore.get().gemini.apiKey === GEMINI_KEY && configStore.get().gemini.model === 'gemini-3.6-flash',
    'and Gemini\'s saved key and model are untouched');
}

console.log('=== a test changes nothing the live chain relies on ===');
{
  resetBreakers();
  const healthBefore = JSON.stringify(contentHealth.state);
  const eventsBefore = healthEvents;
  await test('groq', { apiKey: BAD_GROQ_KEY });
  scene.groqChat = () => GROQ_429_RPD();
  await test('groq', {});
  scene.groqChat = null;
  await test('gemini', { apiKey: BAD_GEMINI_KEY });
  await test('cerebras', { model: 'llama-9-huge' });
  ok(breakerSnapshot().length === 0, 'four failing tests tripped no breaker');
  ok(breakerFor(savedGroq) === null, 'Groq is still asked in its place');
  ok(JSON.stringify(contentHealth.state) === healthBefore, 'the content-check health record is unchanged');
  ok(healthEvents === eventsBefore, 'and no status change was pushed to the panel');
  ok(!lines.some((l) => l.startsWith('error ')), 'nothing was logged at error level, which would email an alert');

  // A breaker the chain opened stays open through a passing test: one good
  // answer to a trivial prompt is not the chain answering a film.
  const g = configStore.get();
  scene.groqChat = () => GROQ_429_RPD();
  await askChain({ purpose: 'content check', subject: 'Film', prompt: 'x', gemini: { ...g.gemini, apiKey: '' },
    ai: { ...g.ai, order: ['groq'], cerebras: { enabled: false } }, parse: () => ({ value: true }) });
  scene.groqChat = null;
  ok(breakerFor(savedGroq) !== null, 'the chain itself held Groq back after a 429');
  const r = await test('groq', {});
  ok(r.json.ok && breakerFor(savedGroq) !== null, 'and a passing test did not put it back: that is the Retry button\'s job');
  resetBreakers();
}

console.log('=== one test per provider every few seconds ===');
{
  const a = await test('cerebras', {});
  const from = outbound.length;
  const b = await api('POST', '/api/ai/providers/cerebras/test', {});
  ok(a.status === 200 && b.status === 429, `a second click straight away is refused (${b.status})`);
  ok(/^Cerebras was tested a moment ago — wait \d s and try again$/.test(b.json.message), `"${b.json.message}"`);
  ok(b.json.retryAfterMs > 0 && sent(from).length === 0, 'and made no request');
  const other = await api('POST', '/api/ai/providers/groq/test', {});
  ok(other.status === 200, 'another provider can still be tested');

  // One still running.
  let release;
  scene.cerebrasChat = (call) => new Promise((r) => { release = () => r(chat('{"ok":true}', call.body.model)); });
  later();
  const first = api('POST', '/api/ai/providers/cerebras/test', {});
  for (let i = 0; i < 100 && !release; i++) await new Promise((r) => setTimeout(r, 5));
  const second = await test('cerebras', {});
  ok(second.status === 429 && /already running/.test(second.json.message), `a test still in flight: "${second.json.message}"`);
  release();
  ok((await first).json.ok === true, 'and the first finishes normally');
  scene.cerebrasChat = null;
}

console.log('=== only the four providers, by name ===');
{
  const from = outbound.length;
  for (const id of ['openai', 'constructor', '__proto__', 'https%3A%2F%2Fevil.example%2Fv1', '..%2Fgroq']) {
    const r = await test(id, { apiKey: TYPED_GROQ_KEY });
    ok(r.status === 404, `"${decodeURIComponent(id)}" is not a provider (${r.status})`);
  }
  ok(sent(from).length === 0, 'and none of them sent anything anywhere');
}

console.log('=== the same permission as saving the card ===');
{
  who = null;
  const put = await api('PUT', '/api/ai/providers', { groq: { enabled: true } });
  const t = await test('groq', {});
  ok(put.status === 401 && t.status === 401, `signed out: both refused (${put.status}, ${t.status})`);
  who = { username: 'helper', role: 'admin' };
  const put2 = await api('PUT', '/api/ai/providers', { groq: { enabled: true } });
  const t2 = await test('groq', {});
  ok(put2.status === 200 && t2.status === 200, `an ordinary admin: both allowed (${put2.status}, ${t2.status})`);
  ok(events()[0].user === 'helper' && /^tested the Groq key/.test(events()[0].action), 'and the test is attributed to them');
  who = { username: 'mommy', role: 'superadmin' };
}

console.log('=== the core function scrubs by value and by shape ===');
{
  // A provider that echoes a key the route did not know about - one of
  // Cerebras's, say, pasted into the Groq box - is still scrubbed by its shape.
  const stray = 'csk-STRAYkeyNOTconfigured0123456789abcdefghijk';
  const prev = globalThis.fetch;
  globalThis.fetch = async () => json(401, { error: { message: `Invalid API Key ${stray} ${TYPED_GROQ_KEY}`, code: 'invalid_api_key' } });
  const r = await testProvider('groq', { key: TYPED_GROQ_KEY, model: '' });
  globalThis.fetch = prev;
  const text = JSON.stringify(r);
  ok(r.reason === 'auth' && !text.includes(stray) && !hasKey(text), `neither key survives: ${r.steps[0].detail}`);
}

console.log('=== the other ways a test can fail, each said plainly ===');
{
  const prev = globalThis.fetch;
  const run = async (handler, opts = {}) => {
    globalThis.fetch = handler;
    try { return await testProvider('groq', { key: TYPED_GROQ_KEY, model: 'llama-3.3-70b-versatile', ...opts }); }
    finally { globalThis.fetch = prev; }
  };
  const overloaded = await run(async (url) => (String(url).endsWith('/models')
    ? json(200, GROQ_MODELS(false))
    : json(503, { error: { message: 'Service Unavailable', type: 'internal_server_error' } })));
  ok(overloaded.reason === 'server' && overloaded.message === '✗ Groq is failing on its side (HTTP 503) — try again later',
    `5xx: "${overloaded.message}"`);
  const slow = await run((url, init) => new Promise((_r, bad) => {
    init.signal.addEventListener('abort', () => bad(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })));
  }), { modelsMs: 30 });
  ok(slow.reason === 'timeout' && /^✗ Groq did not answer within \d+ s/.test(slow.message) && slow.steps[0].step === 'key',
    `timeout: "${slow.message}"`);
  const offline = await run(async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.groq.com'), { code: 'ENOTFOUND' }) }); });
  ok(offline.reason === 'network' && offline.message === '✗ Could not reach Groq (ENOTFOUND) — run Dashboard → Outbound connectivity',
    `network: "${offline.message}"`);
  const unknown = await testProvider('openai', { key: TYPED_GROQ_KEY });
  ok(unknown.ok === false && unknown.reason === 'unknown-provider', 'and an unknown provider is refused by the function too, not only the route');
}

/* The four cases below were found reviewing the first version of the button:
   each passed a test the chain would then fail, or blamed the wrong thing. */

console.log('=== a model list that is not JSON is not blamed on a model ===');
{
  // A captive portal, a TLS-intercepting proxy or a CDN error page answers
  // HTTP 200 with HTML. It used to read "✗ null answered, but not with the
  // JSON the bot needs - pick another model": no model had been asked.
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init) => (/\/models(\?|$)/.test(String(url))
    ? new Response('<!doctype html><title>Sign in to the Wi-Fi</title>', { status: 200, headers: { 'content-type': 'text/html' } })
    : prev(url, init));
  const from = outbound.length;
  const g = await test('groq', { apiKey: TYPED_GROQ_KEY });
  const auditGroq = events()[0];
  const m = await test('gemini', {});
  globalThis.fetch = prev;
  for (const [r, label] of [[g, 'Groq'], [m, 'Gemini']]) {
    ok(r.json.ok === false && r.json.reason === 'list-unreadable', `${label}: refused as an unreadable model list (${r.json.reason})`);
    ok(r.json.message === `✗ Could not read ${label}'s model list — something between the bot and ${label} answered instead;`
      + ' run Dashboard → Outbound connectivity', `"${r.json.message}"`);
    ok(!/null|pick another/.test(r.json.message), 'no "null answered", and no advice to change the model');
    ok(r.json.steps.length === 1 && r.json.steps[0].step === 'key' && /not JSON/.test(r.json.steps[0].detail)
      && !new RegExp(`${label} said`).test(r.json.steps[0].detail),
    `the key step failed, without putting words in ${label}'s mouth: "${r.json.steps[0].detail}"`);
  }
  ok(auditGroq.action === 'tested the Groq key: unreadable model list', `audited as "${auditGroq.action}", not as an unreadable answer`);
  ok(!sent(from).some((c) => c.url.includes('/chat/completions') || c.url.includes(':generateContent')), 'and nothing was asked of a model');
}

console.log('=== Automatic: a cached choice the key no longer lists ===');
{
  // The chain asks its cached automatic choice without looking at the list
  // again. When that model was retired within the day, the test used to pick
  // afresh and say "✓ Works - kimi-k2 answered", while the next film went to
  // the retired model and Groq was held back for 15 minutes.
  resetBreakers();
  ok(cachedModel(savedGroq) === 'llama-3.3-70b-versatile', 'the chain\'s automatic choice for the saved key is llama-3.3-70b-versatile');
  const prev = globalThis.fetch;
  const retired = { ...GROQ_MODELS(true), data: GROQ_MODELS(true).data.filter((m) => m.id !== 'llama-3.3-70b-versatile') };
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u === 'https://api.groq.com/openai/v1/models') { outbound.push({ url: u, method: 'GET' }); return json(200, retired); }
    if (u === 'https://api.groq.com/openai/v1/chat/completions' && JSON.parse(init.body).model === 'llama-3.3-70b-versatile') {
      outbound.push({ url: u, method: 'POST' });
      return json(400, { error: {
        message: 'The model `llama-3.3-70b-versatile` has been decommissioned and is no longer supported. Please refer to https://console.groq.com/docs/deprecations for a recommendation on which model to use instead.',
        type: 'invalid_request_error', code: 'model_decommissioned',
      } });
    }
    return prev(url, init);
  };
  const from = outbound.length;
  const r = await test('groq', {});
  ok(r.json.ok === false && r.json.reason === 'model-retired' && r.json.model === 'llama-3.3-70b-versatile' && r.json.automatic === true,
    `not a clean ✓: the model reported is the one the chain will ask (${r.json.model}, ${r.json.reason})`);
  ok(r.json.message === '✗ The bot is still using llama-3.3-70b-versatile, which Groq no longer lists — its next Groq request will fail once,'
    + ' then Automatic moves to moonshotai/kimi-k2-instruct-0905', `"${r.json.message}"`);
  ok(r.json.steps.length === 2 && r.json.steps[1].step === 'model' && r.json.steps[1].ok === false
    && /To switch now, choose moonshotai\/kimi-k2-instruct-0905 under Model and save/.test(r.json.steps[1].detail),
  `the model step says what will happen and how to switch now: "${r.json.steps[1].detail}"`);
  ok(sent(from).length === 1, 'only the model list was fetched; no chat request was spent on a model the chain will not ask');
  ok(cachedModel(savedGroq) === 'llama-3.3-70b-versatile' && breakerFor(savedGroq) === null,
    'and the test itself changed nothing: the cache and the breaker are as they were');
  ok(events()[0].action === 'tested the Groq key: automatic model retired', `audited as "${events()[0].action}"`);

  // What the test warned of is what the chain then does.
  const g = configStore.get();
  const asked = [];
  const c = await askChain({ purpose: 'content check', subject: 'Film', prompt: 'x', gemini: { ...g.gemini, apiKey: '' },
    ai: { ...g.ai, order: ['groq'], cerebras: { enabled: false } }, parse: () => ({ value: true }),
    log: { info: () => {}, warn: (m) => asked.push(m) } });
  ok(c.ok === false && c.failure?.reason === 'model-not-found' && c.failure.model === 'llama-3.3-70b-versatile',
    'the chain\'s next request went to the retired model and failed, as the test said it would');
  globalThis.fetch = prev;

  // Put the chain back as the rest of the suite found it.
  resetBreakers();
  resetModelCache();
  globalThis.fetch = async (url, init) => (String(url).endsWith('/models') ? json(200, GROQ_MODELS(false)) : prev(url, init));
  await resolveModel(savedGroq);
  globalThis.fetch = prev;
}

console.log('=== Gemini: the name the test checks is the name the chain sends ===');
{
  // Google's own model list writes "models/gemini-2.5-flash", so that gets
  // pasted into Movie data. The test used to strip the prefix while askGemini
  // sent it, to .../models/models%2Fgemini-2.5-flash:generateContent.
  const r = await test('gemini', { model: 'models/gemini-2.5-flash' });
  ok(r.json.ok === true && r.json.model === 'gemini-2.5-flash', `the test checks gemini-2.5-flash (${r.json.message})`);
  const from = outbound.length;
  await askGemini({ key: GEMINI_KEY, model: 'models/gemini-2.5-flash', prompt: 'x' });
  const call = sent(from)[0];
  ok(call?.url === 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
    `and the chain asks the same model: ${call?.url}`);
  const from2 = outbound.length;
  await askGemini({ key: GEMINI_KEY, model: 'gemini-3.6-flash', prompt: 'x' });
  ok(sent(from2)[0]?.url === 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent',
    'a name saved without the prefix is sent exactly as before');
}

console.log('=== Gemini: a listed model that cannot give a JSON text answer ===');
{
  // Speech, image and Gemma models list generateContent too. Gemini is never
  // asked for an answer by a test, so the list is the only check, and it
  // passed them as "✓ Works".
  const prev = globalThis.fetch;
  const withOthers = { models: [
    ...GEMINI_MODELS.models,
    { name: 'models/gemini-2.5-flash-preview-tts', version: 'gemini-2.5-flash-exp-tts-2025-05-19', displayName: 'Gemini 2.5 Flash Preview TTS',
      description: 'Gemini 2.5 Flash Preview TTS', inputTokenLimit: 8192, outputTokenLimit: 16384,
      supportedGenerationMethods: ['countTokens', 'generateContent'], temperature: 1, topP: 0.95, topK: 64, maxTemperature: 2 },
    { name: 'models/gemini-2.5-flash-image', version: '2.0', displayName: 'Nano Banana', description: 'Gemini 2.5 Flash Image',
      inputTokenLimit: 32768, outputTokenLimit: 32768, supportedGenerationMethods: ['generateContent', 'countTokens', 'batchGenerateContent'],
      temperature: 1, topP: 0.95, topK: 64, maxTemperature: 2 },
    { name: 'models/gemma-3-27b-it', version: '001', displayName: 'Gemma 3 27B', inputTokenLimit: 131072, outputTokenLimit: 8192,
      supportedGenerationMethods: ['generateContent', 'countTokens'], temperature: 1, topP: 0.95, topK: 64 },
  ] };
  globalThis.fetch = async (url, init) => (String(url).startsWith('https://generativelanguage.googleapis.com/v1beta/models?')
    ? json(200, withOthers) : prev(url, init));
  for (const [model, kind] of [['gemma-3-27b-it', /Gemma/], ['gemini-2.5-flash-preview-tts', /speech model/], ['gemini-2.5-flash-image', /image-generation/]]) {
    const r = await test('gemini', { model });
    ok(r.json.ok === false && r.json.reason === 'model-unsuitable'
      && r.json.message === `✗ ${model} cannot give the JSON text answer the bot asks for — pick a Gemini text model`,
    `${model}: "${r.json.message}"`);
    ok(r.json.steps[1]?.step === 'model' && r.json.steps[1].ok === false && kind.test(r.json.steps[1].detail),
      `and the model step says why: "${r.json.steps[1]?.detail}"`);
  }
  ok(events()[0].action === 'tested the Gemini key: model cannot answer in JSON', `audited as "${events()[0].action}"`);
  const fine = await test('gemini', { model: 'gemini-2.5-flash' });
  ok(fine.json.ok === true && /lists 2 chat model/.test(fine.json.steps[0].detail),
    `a text model on the same list still passes, and the count leaves the others out: "${fine.json.steps[0].detail}"`);
  globalThis.fetch = prev;
}

console.log('=== no key anywhere it could leak ===');
{
  ok(!everyResponse.some(hasKey), `none of the ${everyResponse.length} responses carried a key`);
  ok(!lines.some(hasKey), `none of the ${lines.length} log lines did`);
  ok(!events().some((e) => hasKey(JSON.stringify(e))), `nor any of the ${events().length} audit rows`);
  ok(!hasKey(JSON.stringify(contentHealth.state)), 'nor the health record');
  const tested = events().filter((e) => /^tested the /.test(e.action));
  ok(tested.length > 10 && tested.every((e) => /^(a key typed into the panel, not saved|the saved key)$/.test(e.detail)),
    'every test row says only which key was tested');
}

server.close();
Date.now = realNow;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
