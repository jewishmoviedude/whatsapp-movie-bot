/* OpenRouter is a fallback AI provider like Groq, Cerebras and Mistral.
   Run: node test/openrouter-provider.test.mjs

   2026-09-29: the operator asked for OpenRouter (openrouter.ai) to be added to
   the chain that answers the film lookup and the nudity check. It speaks
   OpenAI's Chat Completions format, so it rides on the same client, but four
   things about it differ from the others and each is pinned here:
   - its keys look like sk-or-v1-<hex>, a shape nothing scrubbed before, and a
     key must never reach a log, a stored failure or the hourly check's report;
   - its model list is public, so listing models proves nothing about a key -
     GET /key is asked first, or a mistyped key would pass the Test button;
   - it fronts hundreds of models, most of them paid, and this install is on
     its free tier, so Automatic must choose a ":free" model before a paid one;
   - its 429 for the free tier's daily cap says "free-models-per-day" and gives
     the reset as an epoch-millisecond instant in x-ratelimit-reset.
   And an existing config, saved before OpenRouter existed, must behave
   exactly as before: OpenRouter off, last, and never asked.
   No network: fetch is stubbed with the shapes OpenRouter really returns. The
   key below is a made-up test value, not a real key. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import log from '../src/util/logger.js';
import { ConfigStore, MASK } from '../src/config/store.js';
import { DEFAULT_CONFIG as DEFAULTS, SECRET_PATHS } from '../src/config/schema.js';
import { isEncrypted } from '../src/util/crypto.js';
import {
  PROVIDERS, PROVIDER_IDS, DEFAULT_ORDER, MODEL_PREFERENCES, normaliseOrder, chainPlan, usable,
  scrubKeys, pickModel, listModels, testProvider, askChain, openAiHttpFailure, configuredKeys,
  resetBreakers, resetModelCache,
} from '../src/core/ai-providers.js';
import { sanitize } from '../src/core/hourly-checks.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const lines = [];
log.on('line', (e) => lines.push(`${e.level} ${e.scope}: ${e.msg}`));

// Shaped like a real OpenRouter key (sk-or-v1- and 64 hex digits), but invented.
const OR_KEY = `sk-or-v1-${'0123456789abcdef'.repeat(4)}`;
const BAD_KEY = `sk-or-v1-${'fedcba9876543210'.repeat(4)}`;
const BASE = 'https://openrouter.ai/api/v1';

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', ...headers },
});

// GET /models as OpenRouter answers it, abridged: public, with paid models,
// ":free" variants, an image generator and its own router mixed together.
const MODELS = { data: [
  { id: 'openrouter/auto', context_length: 2000000, architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
  { id: 'google/gemini-2.5-flash-image', context_length: 32768, architecture: { input_modalities: ['text', 'image'], output_modalities: ['image'] } },
  { id: 'google/gemini-2.5-flash', context_length: 1048576, architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
  { id: 'qwen/qwen3-coder:free', context_length: 262144, architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
  { id: 'meta-llama/llama-3.3-70b-instruct:free', context_length: 131072, architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
  { id: 'meta-llama/llama-3.3-70b-instruct', context_length: 131072, architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
] };

/** A stub of OpenRouter that knows OR_KEY and nothing else, and records every call. */
function stubOpenRouter({ chat } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const auth = String(init.headers?.Authorization ?? '').replace(/^Bearer /, '');
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: u, auth, body });
    if (!u.startsWith(BASE)) return json(599, { error: 'not OpenRouter' });
    if (u === `${BASE}/models`) return json(200, MODELS);    // public: no key needed
    if (u === `${BASE}/key`) {
      return auth === OR_KEY
        ? json(200, { data: { label: 'sk-or-v1-012...def', limit: null, usage: 0, is_free_tier: true } })
        // OpenRouter's real 401 does not echo the key; this one does, to prove it is scrubbed.
        : json(401, { error: { code: 401, message: `No auth credentials found for ${auth}` } });
    }
    if (u === `${BASE}/chat/completions`) {
      if (auth !== OR_KEY) return json(401, { error: { code: 401, message: 'User not found.' } });
      if (chat) return chat(body);
      return json(200, {
        id: 'gen-1', model: body.model, object: 'chat.completion',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"nudity": false, "confidence": 0.9}' } }],
      });
    }
    return json(404, { error: { code: 404, message: 'Not Found' } });
  };
  return { calls, to: (p) => calls.filter((c) => c.url === `${BASE}${p}`) };
}

console.log('=== OpenRouter is registered as a fallback, off and last ===');
{
  ok(PROVIDER_IDS.includes('openrouter') && PROVIDERS.openrouter.openai === true, 'it is an OpenAI-compatible provider');
  ok(PROVIDERS.openrouter.base === BASE, `its base is ${BASE}`);
  ok(/^https:\/\/openrouter\.ai\//.test(PROVIDERS.openrouter.keysUrl), 'the panel links to OpenRouter\'s own key page');
  ok(DEFAULT_ORDER.indexOf('openrouter') === DEFAULT_ORDER.length - 2, 'it is last of the default order before Ollama, which was added after it');
  ok(DEFAULTS.ai.order.indexOf('openrouter') === DEFAULTS.ai.order.length - 2, 'and in the default config');
  // Off and not clearing until 2026-10-12, when the operator's live settings
  // - it on, and allowed to clear a rated film - became the defaults
  // (live-settings-defaults). With no key it is passed over.
  const d = DEFAULTS.ai.openrouter;
  ok(d.enabled === true && d.apiKey === '' && d.model === '' && d.canClearRated === true,
    'it defaults to on, no key, Automatic, and may clear rated films, as the operator has it');
  ok(SECRET_PATHS.includes('ai.openrouter.apiKey'), 'its key is a secret path');
}

console.log('=== an existing config behaves exactly as before ===');
{
  const oldOrder = ['gemini', 'groq', 'cerebras', 'mistral'];
  ok(normaliseOrder(oldOrder).join(',') === 'gemini,groq,cerebras,mistral,openrouter,ollama',
    'an order saved before OpenRouter existed keeps its order, with OpenRouter appended');
  ok(normaliseOrder(['mistral', 'groq']).join(',') === 'mistral,groq,gemini,cerebras,openrouter,ollama',
    'and a custom order is untouched apart from the providers it left out');
  // A config written before this change has no ai.openrouter at all.
  const plan = chainPlan({ gemini: { apiKey: 'AIzaTEST' }, ai: { order: oldOrder, groq: { enabled: true, apiKey: 'gsk_x' } } });
  const or = plan.find((p) => p.id === 'openrouter');
  ok(or && or.enabled === false && !usable(or), 'OpenRouter is in the plan, but not usable');
  ok(plan.filter(usable).map((p) => p.id).join(',') === 'gemini,groq', 'so the usable providers are the same as before');

  const calls = stubOpenRouter();
  resetBreakers(); resetModelCache();
  const r = await askChain({
    purpose: 'content check', subject: 'Film', prompt: 'x',
    gemini: { apiKey: '' }, ai: { order: oldOrder },
    parse: (t) => ({ value: t }),
  });
  ok(!r.ok && calls.calls.length === 0, 'with nothing else configured, OpenRouter is not asked either');
}

console.log('=== the key is encrypted at rest and masked ===');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openrouter-'));
  const store = new ConfigStore({ dataDir: tmp, masterKey: 'test-master-key-for-openrouter' });
  store.load();
  store.update({ ai: { openrouter: { enabled: true, apiKey: OR_KEY } } });
  const raw = fs.readFileSync(path.join(tmp, 'config.json'), 'utf8');
  ok(!raw.includes(OR_KEY), 'config.json does not hold the key in plain text');
  ok(isEncrypted(JSON.parse(raw).ai.openrouter.apiKey), 'it is stored as enc:v1:…');
  const again = new ConfigStore({ dataDir: tmp, masterKey: 'test-master-key-for-openrouter' });
  again.load();
  ok(again.get().ai.openrouter.apiKey === OR_KEY, 'and decrypts back with the same MASTER_KEY');
  ok(again.redacted().ai.openrouter.apiKey === MASK, 'redacted() masks it');
  ok(configuredKeys(again.get()).includes(OR_KEY), 'it is among the keys scrubbed by value');
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('=== an sk-or-v1 key is scrubbed by its shape ===');
{
  ok(scrubKeys(`bad key ${OR_KEY} and again ${OR_KEY}`) === 'bad key sk-or-*** and again sk-or-***',
    'scrubKeys takes out every copy with no key list at all');
  ok(!sanitize(`Authorization failed for ${OR_KEY}`).includes(OR_KEY), 'the hourly check\'s sanitize() takes it out too');
  ok(!/0123456789abcdef0123/.test(scrubKeys(`k=${OR_KEY.replace('v1', 'v2')}`)), 'and a later key version');
}

console.log('=== Automatic picks a free model first ===');
{
  ok(MODEL_PREFERENCES.openrouter.length > 0 && MODEL_PREFERENCES.openrouter[0].endsWith(':free'),
    'the preference list starts with a free model');
  const pick = pickModel('openrouter', MODELS.data.map((m) => m.id));
  ok(pick?.model === 'meta-llama/llama-3.3-70b-instruct:free', `from the list, the free Llama 70B: ${pick?.model}`);
  ok(pickModel('openrouter', ['meta-llama/llama-3.3-70b-instruct', 'some/unknown-model:free'])?.model === 'some/unknown-model:free',
    'any free model beats a paid one, even a preferred paid one');
  ok(pickModel('openrouter', ['qwen/qwen3-coder:free', 'some/chat-model:free'])?.model === 'some/chat-model:free',
    'a free code model only after a free general one');
  ok(pickModel('openrouter', ['vendor/other', 'google/gemini-2.5-flash'])?.model === 'google/gemini-2.5-flash',
    'with nothing free, the preference list decides among the paid ones');
  ok(pickModel('groq', ['z-model:free', 'llama-3.3-70b-versatile'])?.model === 'llama-3.3-70b-versatile',
    'and the free-first rule is OpenRouter\'s alone');
}

console.log('=== the model list, and the key check in front of it ===');
{
  let s = stubOpenRouter();
  const good = await listModels('openrouter', OR_KEY);
  ok(good.ok && s.to('/key').length === 1 && s.to('/models').length === 1, 'a good key: GET /key, then GET /models');
  const ids = good.models.map((m) => m.id);
  ok(!ids.includes('openrouter/auto') && !ids.includes('google/gemini-2.5-flash-image'),
    'OpenRouter\'s router and image-only models are not offered as chat models');
  ok(good.models.find((m) => m.id === 'google/gemini-2.5-flash')?.contextWindow === 1048576, 'context_length is read');

  s = stubOpenRouter();
  const bad = await listModels('openrouter', BAD_KEY);
  ok(!bad.ok && bad.failure.reason === 'auth', 'a bad key is refused, although the list itself is public');
  ok(s.to('/models').length === 0, 'and the list is not fetched after that');
  ok(!JSON.stringify(bad).includes(BAD_KEY), 'the key OpenRouter echoed is not in the failure');
}

console.log('=== the Test button ===');
{
  resetModelCache();
  let s = stubOpenRouter();
  const t = await testProvider('openrouter', { key: OR_KEY, model: '' });
  ok(t.ok === true, `a good key works: ${t.message}`);
  ok(t.automatic && t.model === 'meta-llama/llama-3.3-70b-instruct:free', `Automatic → ${t.model}`);
  const chat = s.to('/chat/completions')[0];
  ok(chat?.auth === OR_KEY && chat.body.model === t.model && chat.body.response_format?.type === 'json_object',
    'one JSON-mode chat request, with the Bearer key, to the chosen model');

  s = stubOpenRouter();
  const b = await testProvider('openrouter', { key: BAD_KEY, model: '' });
  ok(!b.ok && b.reason === 'auth' && /Key rejected/.test(b.message), `a bad key fails the test: ${b.message}`);
  ok(!JSON.stringify(b).includes(BAD_KEY), 'and nothing returned carries it');
  ok(s.to('/chat/completions').length === 0, 'no chat request is spent on a key that was refused');
}

console.log('=== OpenRouter\'s free-tier limit is read as a daily one ===');
{
  const now = Date.UTC(2026, 8, 29, 20, 0, 0);
  const reset = Date.UTC(2026, 8, 30, 0, 0, 0);
  const f = openAiHttpFailure(429, JSON.stringify({ error: {
    code: 429, message: 'Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day',
  } }), new Headers({ 'X-RateLimit-Limit': '50', 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': String(reset) }),
  { provider: 'openrouter', now });
  ok(f.reason === 'quota-daily' && f.daily === true, 'free-models-per-day is a daily limit');
  ok(f.retryAfterMs === reset - now, `held until the reset OpenRouter gave (${f.retryDelay})`);
  ok(f.quotaValue === '50', 'with its limit');
  const m = openAiHttpFailure(429, JSON.stringify({ error: { code: 429, message: 'Rate limit exceeded: free-models-per-min.' } }),
    new Headers(), { provider: 'openrouter', now });
  ok(m.reason === 'quota', 'the per-minute limit is not');
}

console.log('=== in the chain ===');
{
  resetBreakers(); resetModelCache();
  const s = stubOpenRouter();
  const r = await askChain({
    purpose: 'content check', subject: 'Film', prompt: 'is there nudity?',
    gemini: { apiKey: '' },
    ai: { order: DEFAULT_ORDER, gemini: { enabled: false }, openrouter: { enabled: true, apiKey: OR_KEY, model: '' } },
    parse: (t) => { try { return { value: JSON.parse(t) }; } catch { return null; } },
  });
  ok(r.ok && r.provider === 'openrouter' && r.value?.nudity === false, `OpenRouter answered: ${r.provider}`);
  ok(r.model === 'meta-llama/llama-3.3-70b-instruct:free', `with the free model Automatic chose: ${r.model}`);
  ok(r.canClearRated === false, 'and its answer may not clear a rated film unless the operator allows it');
  ok(s.calls.every((c) => c.url.startsWith(BASE)), 'every request went to OpenRouter');
}

ok(!lines.some((l) => l.includes(OR_KEY) || l.includes(BAD_KEY)), 'no key appears in any log line');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
