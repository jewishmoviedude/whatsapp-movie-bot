/* The Groq, Cerebras and Mistral keys are secrets like every other key.
   Run: node test/ai-provider-keys.test.mjs

   2026-09-22: the fallback providers went in because Gemini's free tier ran
   out by mid-morning, and the user created keys at Groq, Cerebras and Mistral
   to paste into the panel. config.json encrypts every path in SECRET_PATHS
   with MASTER_KEY and the API masks them; a key added to the schema but left
   out of that list would be written to disk in plain text and sent to every
   browser that opens Settings. This drives the real ConfigStore and the real
   router over HTTP to prove it is not: encrypted at rest, masked in every
   response, kept when a box is left blank, and absent from the log, the audit
   trail and the model-list endpoint, which uses the stored key on the server
   so the browser never holds one. No network: fetch is stubbed. */
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import log from '../src/util/logger.js';
import { ConfigStore, MASK } from '../src/config/store.js';
import { SECRET_PATHS } from '../src/config/schema.js';
import { createApiRouter } from '../src/web/api.js';
import { JobQueue } from '../src/core/queue.js';
import { hashPassword, isEncrypted } from '../src/util/crypto.js';
import { resetBreakers, breakerSnapshot, resetModelCache } from '../src/core/ai-providers.js';
import { checkNudity } from '../src/plugins/movie-requests/content-check.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const lines = [];
log.on('line', (e) => lines.push(`${e.level} ${e.scope}: ${e.msg}`));

const GROQ_KEY = 'gsk_TESTgroqKEY0123456789abcdefghijklmnopqrstuvwxyzABCDEF';
const CEREBRAS_KEY = 'csk-TESTcerebrasKEY0123456789abcdefghijklmnopqrstuv';
const MISTRAL_KEY = 'TESTmistralKEY' + '0123456789abcdefgh';
const NEW_GROQ_KEY = 'gsk_SECONDgroqKEY9876543210zyxwvutsrqponmlkjihgfedcba';
const KEYS = [GROQ_KEY, CEREBRAS_KEY, MISTRAL_KEY, NEW_GROQ_KEY];
const hasKey = (s) => KEYS.some((k) => String(s).includes(k));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-keys-'));
const MASTER = 'test-master-key-for-ai-providers';

console.log('=== the three keys are secret paths ===');
{
  for (const p of ['ai.groq.apiKey', 'ai.cerebras.apiKey', 'ai.mistral.apiKey']) {
    ok(SECRET_PATHS.includes(p), `${p} is in SECRET_PATHS`);
  }
}

console.log('=== encrypted at rest, and read back ===');
{
  const store = new ConfigStore({ dataDir: tmp, masterKey: MASTER });
  store.load();
  store.update({ ai: {
    groq: { enabled: true, apiKey: GROQ_KEY },
    cerebras: { enabled: true, apiKey: CEREBRAS_KEY },
    mistral: { enabled: true, apiKey: MISTRAL_KEY },
  } });
  const raw = fs.readFileSync(path.join(tmp, 'config.json'), 'utf8');
  ok(!hasKey(raw), 'no key appears in config.json in plain text');
  const onDisk = JSON.parse(raw).ai;
  ok(['groq', 'cerebras', 'mistral'].every((id) => isEncrypted(onDisk[id].apiKey)), 'each is stored as enc:v1:…');
  const again = new ConfigStore({ dataDir: tmp, masterKey: MASTER });
  again.load();
  ok(again.get().ai.groq.apiKey === GROQ_KEY && again.get().ai.mistral.apiKey === MISTRAL_KEY,
    'and decrypts back to the same keys with the same MASTER_KEY');
  const red = again.redacted();
  ok(red.ai.groq.apiKey === MASK && red.ai.cerebras.apiKey === MASK && red.ai.mistral.apiKey === MASK,
    'redacted() masks all three');
  ok(!hasKey(JSON.stringify(red)), 'and nothing else in it carries a key');
}

/* ------------------------------ over HTTP ------------------------------ */

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

async function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-api-'));
  const configStore = new ConfigStore({ dataDir: dir, masterKey: MASTER });
  configStore.load();
  configStore.update({ web: { admins: [{ username: 'mommy', role: 'superadmin', passwordHash: hashPassword('x-password-1') }] } });
  const stateStore = makeStateStore();
  const queue = new JobQueue({ concurrency: 1 });
  queue.pause();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { user: { username: 'mommy', role: 'superadmin' } }; next(); });
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
  }));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  return { server, port: server.address().port, configStore, dir, events: () => stateStore.namespace('audit').get('events', []) };
}

function call(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, method, path: p,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} },
    (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, text: buf, json });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const t = await boot();
const everyResponse = [];
const api = async (...a) => { const r = await call(t.port, ...a); everyResponse.push(r.text); return r; };

// Nothing in this suite may reach a real provider. Requests the models route
// makes are answered here, and recorded so the key they carried can be checked.
const outbound = [];
globalThis.fetch = async (url, init = {}) => {
  outbound.push({ url: String(url), auth: init.headers?.Authorization ?? null });
  if (String(url) === 'https://api.groq.com/openai/v1/models') {
    const auth = init.headers?.Authorization;
    if (auth !== `Bearer ${GROQ_KEY}` && auth !== `Bearer ${NEW_GROQ_KEY}`) {
      return new Response(JSON.stringify({ error: { message: `Invalid API Key ${auth}`, type: 'invalid_request_error', code: 'invalid_api_key' } }), { status: 401 });
    }
    return new Response(JSON.stringify({ object: 'list', data: [
      { id: 'whisper-large-v3', object: 'model', owned_by: 'OpenAI', active: true, context_window: 448 },
      { id: 'llama-3.3-70b-versatile', object: 'model', owned_by: 'Meta', active: true, context_window: 131072 },
      { id: 'llama-3.1-8b-instant', object: 'model', owned_by: 'Meta', active: true, context_window: 131072 },
    ] }), { status: 200 });
  }
  if (String(url).startsWith('https://api.mistral.ai/')) {
    return new Response(JSON.stringify({ message: `Unauthorized key ${MISTRAL_KEY}`, request_id: 'r1' }), { status: 401 });
  }
  throw new Error(`unexpected request to ${url}`);
};

console.log('=== saving keys through the card: stored, encrypted, never echoed ===');
{
  const r = await api('PUT', '/api/ai/providers', {
    order: ['gemini', 'groq', 'mistral', 'cerebras'],
    gemini: { enabled: true, canClearRated: true },
    groq: { enabled: true, apiKey: GROQ_KEY, model: '', canClearRated: false },
    cerebras: { enabled: true, apiKey: CEREBRAS_KEY, model: 'llama-3.3-70b' },
    mistral: { enabled: true, apiKey: MISTRAL_KEY, model: 'mistral-large-latest' },
  });
  ok(r.status === 200, `saved (${r.status})`);
  ok(!hasKey(r.text), 'the response carries no key');
  const groq = r.json.providers.find((p) => p.id === 'groq');
  ok(groq.apiKey === MASK && r.json.providers.find((p) => p.id === 'mistral').apiKey === MASK, 'only the mask');
  ok(r.json.order.join(',') === 'gemini,groq,mistral,cerebras,openrouter,ollama', 'the order was saved');
  const cfg = t.configStore.get().ai;
  ok(cfg.groq.apiKey === GROQ_KEY && cfg.cerebras.apiKey === CEREBRAS_KEY && cfg.mistral.apiKey === MISTRAL_KEY,
    'in memory the config holds the real keys, for the providers to use');
  const disk = fs.readFileSync(path.join(t.dir, 'config.json'), 'utf8');
  ok(!hasKey(disk) && isEncrypted(JSON.parse(disk).ai.groq.apiKey), 'on disk they are encrypted');
}

console.log('=== GET /config and GET /ai/providers mask every key ===');
{
  const c = await api('GET', '/api/config');
  ok(c.status === 200 && !hasKey(c.text), 'GET /config carries no key');
  ok(c.json.ai.groq.apiKey === MASK && c.json.ai.cerebras.apiKey === MASK && c.json.ai.mistral.apiKey === MASK,
    'and shows each as the mask, like every other secret');
  const a = await api('GET', '/api/ai/providers');
  ok(a.status === 200 && !hasKey(a.text), 'GET /ai/providers carries no key');
}

console.log('=== a blank key box, or the mask sent back, keeps the saved key ===');
{
  await api('PUT', '/api/ai/providers', { groq: { enabled: true, apiKey: '', model: '' } });
  ok(t.configStore.get().ai.groq.apiKey === GROQ_KEY, 'blank keeps it');
  await api('PUT', '/api/ai/providers', { groq: { enabled: true, apiKey: MASK } });
  ok(t.configStore.get().ai.groq.apiKey === GROQ_KEY, 'the mask keeps it');
  const main = await api('PUT', '/api/config', { omdb: { apiKey: MASK }, gemini: { enabled: true } });
  ok(main.status === 200 && t.configStore.get().ai.mistral.apiKey === MISTRAL_KEY,
    'and a save of the main settings form, which does not carry them, leaves them alone');
  const junk = await api('PUT', '/api/ai/providers', { groq: { apiKey: 'Bearer something with spaces' } });
  ok(junk.status === 400 && t.configStore.get().ai.groq.apiKey === GROQ_KEY, 'something that is not a key is refused, not saved');
}

console.log('=== the models list uses the stored key on the server, and returns none ===');
{
  const r = await api('GET', '/api/ai/providers/groq/models');
  ok(r.status === 200 && r.json.ok, `listed (${r.status})`);
  ok(outbound.at(-1).auth === `Bearer ${GROQ_KEY}`, 'the request to Groq carried the stored key');
  ok(r.json.models.map((m) => m.id).join(',') === 'llama-3.3-70b-versatile,llama-3.1-8b-instant', 'chat models only');
  ok(r.json.automatic === 'llama-3.3-70b-versatile', 'with what Automatic would pick');
  ok(!hasKey(r.text), 'and no key in the response');

  const bad = await api('GET', '/api/ai/providers/mistral/models');
  ok(bad.status === 502 && /refused the API key/.test(bad.json.error), `a refused key is said plainly: "${bad.json.error}"`);
  ok(!hasKey(bad.text), 'even though Mistral echoed the key back in its error');
  const none = await api('GET', '/api/ai/providers/gemini/models');
  ok(none.status === 404, 'Gemini has no list here; its model is set in its own card');
  const proto = await api('GET', '/api/ai/providers/constructor/models');
  const retry = await api('POST', '/api/ai/providers/constructor/retry');
  ok(proto.status === 404 && retry.status === 404, 'and a name every object has is not a provider');
}

console.log('=== replacing and removing a key ===');
{
  await api('PUT', '/api/ai/providers', { groq: { apiKey: NEW_GROQ_KEY } });
  ok(t.configStore.get().ai.groq.apiKey === NEW_GROQ_KEY, 'a new key replaces the old one');
  const audit = t.events().find((e) => e.action === 'changed the AI providers' && /ai\.groq\.apiKey/.test(e.detail));
  ok(!!audit && /ai\.groq\.apiKey: changed/.test(audit.detail), `the audit trail records that it changed: "${audit?.detail}"`);
  await api('PUT', '/api/ai/providers', { cerebras: { removeKey: true } });
  ok(t.configStore.get().ai.cerebras.apiKey === '', 'Remove the saved key clears it');
  const after = await api('GET', '/api/ai/providers');
  ok(after.json.providers.find((p) => p.id === 'cerebras').apiKey === '', 'and the card then shows none saved');
}

console.log('=== putting a held-back provider back in its place ===');
{
  resetBreakers();
  resetModelCache();
  const g = { enabled: true, contentCheck: true, apiKey: '', model: 'gemini-3.6-flash' };
  const ai = t.configStore.get().ai;
  const prev = globalThis.fetch;
  globalThis.fetch = async (url) => (String(url).includes('mistral')
    ? new Response(JSON.stringify({ message: 'Requests rate limit exceeded' }), { status: 429, headers: { 'retry-after': '600' } })
    : prev(url, {}));
  await checkNudity('Film', 2001, g, { ai: { ...ai, order: ['mistral'], groq: { enabled: false } } });
  globalThis.fetch = prev;
  ok(breakerSnapshot().some((b) => b.provider === 'mistral'), 'Mistral is being held back after a 429');
  const r = await api('POST', '/api/ai/providers/mistral/retry');
  ok(r.status === 200 && !breakerSnapshot().some((b) => b.provider === 'mistral'), 'and one click puts it back');
}

console.log('=== no key anywhere it could leak ===');
{
  ok(!everyResponse.some(hasKey), `none of the ${everyResponse.length} responses carried a key`);
  ok(!lines.some(hasKey), `none of the ${lines.length} log lines did`);
  ok(!t.events().some((e) => hasKey(JSON.stringify(e))), `nor any of the ${t.events().length} audit rows`);
}

t.server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
