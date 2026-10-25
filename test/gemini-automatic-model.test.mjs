/* A Gemini key picks the newest model by itself. Run: node test/gemini-automatic-model.test.mjs

   Gemini was the one AI provider without an Automatic: its model was a fixed
   default, gemini-2.0-flash, which Google retired on 2026-09-22, and every
   content check then failed with "model not found" until somebody typed a new
   name into the panel. The operator's rule since: "gemini api key should
   automatically pick latest model no need to specify". So a blank model is
   Automatic - the newest stable Flash the key lists, chosen again daily - and
   an install still holding the dead default is moved onto Automatic. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  pickGeminiModel, pickModel, chainPlan, askChain, resetModelCache, resetBreakers, cachedModel,
} from '../src/core/ai-providers.js';
import { askGemini, listGeminiModels } from '../src/plugins/movie-requests/gemini.js';
import { DEFAULT_CONFIG } from '../src/config/schema.js';
import { ConfigStore } from '../src/config/store.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const KEY = 'AIzaSyTEST-automatic-model-000000000000';

console.log('=== the newest stable Flash is chosen ===');
{
  const ids = ['gemini-2.5-flash', 'gemini-3.6-flash', 'gemini-3-pro', 'gemini-3.6-flash-lite', 'gemini-2.5-pro', 'gemini-3.10-flash-preview-09-2026'];
  ok(pickGeminiModel(ids)?.model === 'gemini-3.6-flash', `3.6 Flash over 2.5, over Pro, Flash-Lite and a preview (${pickGeminiModel(ids)?.model})`);
  ok(pickGeminiModel(['gemini-3.9-flash', 'gemini-3.10-flash'])?.model === 'gemini-3.10-flash', '3.10 is newer than 3.9: versions compare as numbers');
  ok(pickGeminiModel(['gemini-4-flash', 'gemini-3.6-flash'])?.model === 'gemini-4-flash', 'a version with no minor number is still read');
  ok(pickGeminiModel(['gemini-3.6-flash-001', 'gemini-3.6-flash'])?.model === 'gemini-3.6-flash', 'the moving name over a pinned -001 of the same version');
  ok(pickModel('gemini', [{ id: 'gemini-2.5-flash' }, { id: 'gemini-3.6-flash' }])?.model === 'gemini-3.6-flash', 'pickModel() hands Gemini to it');
}

console.log('=== with no stable Flash, the next best ===');
{
  ok(pickGeminiModel(['gemini-2.5-pro', 'gemini-4-flash-preview-05-20'])?.model === 'gemini-4-flash-preview-05-20', 'a preview Flash before Pro');
  ok(pickGeminiModel(['gemini-2.5-pro', 'gemini-flash-latest'])?.model === 'gemini-flash-latest', 'Google\'s own latest-Flash alias');
  ok(pickGeminiModel(['gemini-2.5-pro'])?.model === 'gemini-2.5-pro', 'Pro when that is all there is');
  ok(pickGeminiModel(['learnlm-2.0'])?.model === 'learnlm-2.0', 'else the first model listed');
  ok(pickGeminiModel([]) === null, 'and nothing from an empty list');
}

console.log('=== a blank model is Automatic, for Gemini as for the others ===');
{
  ok(DEFAULT_CONFIG.gemini.model === '', 'the default model is blank, not a name that can be retired');
  const g = (model) => chainPlan({ gemini: { apiKey: KEY, model }, ai: {} }).find((p) => p.id === 'gemini');
  ok(g('').automatic === true && g('').model === '', 'blank: automatic');
  ok(g(undefined).automatic === true, 'missing: automatic');
  ok(g('gemini-2.5-flash').automatic === false && g('gemini-2.5-flash').model === 'gemini-2.5-flash', 'a model typed in is still used as typed');
  ok(g('models/gemini-2.5-flash').model === 'gemini-2.5-flash', 'with Google\'s "models/" prefix taken off');
}

console.log('=== the chain lists the models once, then asks the newest ===');
{
  resetModelCache();
  resetBreakers();
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (u.includes('/v1beta/models?')) {
      return json({ models: [
        { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-3.6-flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-3.6-flash-preview-tts', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
      ] });
    }
    if (u.includes(':generateContent')) {
      return json({ candidates: [{ content: { parts: [{ text: '{"answer":1}' }] }, finishReason: 'STOP' }] });
    }
    throw new Error(`unexpected request ${u}`);
  };
  try {
    const ask = () => askChain({
      purpose: 'test', subject: 'x', prompt: 'x',
      gemini: { apiKey: KEY, model: '' },
      ai: { order: ['gemini'], gemini: { enabled: true } },
      parse: (t) => ({ value: JSON.parse(t) }),
      clients: { gemini: askGemini, geminiModels: listGeminiModels },
      log: { info() {}, warn() {}, error() {} },
    });
    const first = await ask();
    ok(first.ok && first.model === 'gemini-3.6-flash', `the answer came from gemini-3.6-flash (${first.model ?? first.failure?.reason})`);
    ok(calls.some((u) => u.endsWith('/models/gemini-3.6-flash:generateContent')), 'and that is the model the request went to');
    ok(cachedModel({ id: 'gemini', key: KEY }) === 'gemini-3.6-flash', 'the choice is kept for the day');
    const listed = calls.filter((u) => u.includes('/v1beta/models?')).length;
    await ask();
    ok(calls.filter((u) => u.includes('/v1beta/models?')).length === listed, 'so the next film does not list the models again');

    resetModelCache();
    const blind = await askChain({
      purpose: 'test', subject: 'x', prompt: 'x',
      gemini: { apiKey: KEY, model: '' },
      ai: { order: ['gemini'], gemini: { enabled: true } },
      parse: (t) => ({ value: JSON.parse(t) }),
      clients: { gemini: askGemini },
      log: { info() {}, warn() {}, error() {} },
    });
    ok(!blind.ok && blind.failure?.model === '(automatic)',
      `a caller that passes no model list gets a failure, not a request to a model named "" (${blind.failure?.reason})`);
  } finally {
    globalThis.fetch = realFetch;
    resetModelCache();
    resetBreakers();
  }
}

console.log('=== an install holding the retired default is moved onto Automatic ===');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-auto-'));
  try {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ gemini: { enabled: true, model: 'gemini-2.0-flash' } }));
    const store = new ConfigStore({ dataDir: dir, masterKey: 'a'.repeat(64) });
    store.load();
    ok(store.get().gemini.model === '', 'gemini-2.0-flash becomes blank, which is Automatic');
    ok(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).gemini.model === '', 'and that is saved');

    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ gemini: { enabled: true, model: 'gemini-2.5-flash' } }));
    const chosen = new ConfigStore({ dataDir: dir, masterKey: 'a'.repeat(64) });
    chosen.load();
    ok(chosen.get().gemini.model === 'gemini-2.5-flash', 'a model somebody chose is left alone');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
