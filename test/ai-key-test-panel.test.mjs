/* The Test button on each row of Settings → AI providers: what the panel sends.
   Run: node test/ai-key-test-panel.test.mjs

   2026-09-22: after the Groq, Cerebras and Mistral fallbacks went in, the
   user asked "you didn't put a test key button for each one". The server
   side - what a test does, and that it changes and leaks nothing - is pinned
   in ai-key-test.test.mjs. This pins the panel's half, which decides WHICH
   key is tested: the key typed in the row's box if there is one, and
   otherwise none at all, so the server tests the saved key. Getting that
   wrong either way misleads: a pasted key reported on as the old saved one,
   or the mask (which Gemini's key box holds whenever a key is saved) sent
   as though it were a key.

   The card code is taken from the real app.js and run against the real
   index.html markup in linkedom, with api() stubbed. */
import fs from 'node:fs';
import { parseHTML } from 'linkedom';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const app = fs.readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../src/web/public/index.html', import.meta.url), 'utf8');
const MASK = '••••••••';
const TYPED = 'gsk_TYPEDinTHEboxNOTsaved0123456789abcdefghijklmnop';
const TYPED_GEMINI = 'AIzaSyTYPEDgeminiKEY_0123456789-abcdefgh';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const start = app.indexOf('/* --------------------------- AI providers');
const end = app.indexOf('/* ----------------------------- helpers');
const block = app.slice(start, end);

const VIEW = () => ({
  order: ['gemini', 'groq', 'cerebras', 'mistral'],
  lookupOn: true, contentCheckOn: true, allowCleanRatedFilms: false,
  providers: [
    { id: 'gemini', label: 'Gemini', console: 'aistudio.google.com', enabled: true, apiKey: MASK, model: 'gemini-3.6-flash',
      autoModel: null, preferences: [], canClearRated: true, status: null },
    { id: 'groq', label: 'Groq', console: 'console.groq.com', enabled: true, apiKey: MASK, model: '',
      autoModel: 'llama-3.3-70b-versatile', preferences: [], canClearRated: false, status: null },
    { id: 'cerebras', label: 'Cerebras', console: 'cloud.cerebras.ai', enabled: true, apiKey: MASK, model: 'llama-3.3-70b',
      autoModel: null, preferences: [], canClearRated: false, status: null },
    { id: 'mistral', label: 'Mistral', console: 'console.mistral.ai', enabled: false, apiKey: '', model: '',
      autoModel: null, preferences: [], canClearRated: false, status: null },
  ],
});

const RESULT = (over = {}) => ({
  ok: true, provider: 'groq', model: 'llama-3.3-70b-versatile', automatic: true, latencyMs: 812, reason: null, keySource: 'saved',
  steps: [
    { step: 'key', ok: true, detail: 'Groq accepted the key and lists 3 chat model(s)' },
    { step: 'model', ok: true, detail: 'Automatic → llama-3.3-70b-versatile; available on this key' },
    { step: 'answer', ok: true, detail: 'llama-3.3-70b-versatile answered in 0.8 s, and the reply parsed as JSON' },
  ],
  message: '✓ Works — llama-3.3-70b-versatile answered in 0.8 s',
  ...over,
});

/** Run the real card code against the real markup; `answer`, when a test is settled, decides what it gets back. */
async function card(view = VIEW) {
  const { document } = parseHTML(html);
  const $ = (id) => document.getElementById(id);
  const calls = [];
  const pending = [];
  let answer = () => RESULT();
  const api = (method, url, body) => {
    calls.push({ method, url, body: body === undefined ? undefined : JSON.parse(JSON.stringify(body)) });
    if (method === 'GET' && url === '/ai/providers') return Promise.resolve(view());
    if (method === 'POST' && /^\/ai\/providers\/\w+\/test$/.test(url)) {
      return new Promise((resolve, reject) => pending.push({ resolve, reject, url, body }));
    }
    return Promise.reject(new Error(`unexpected ${method} ${url}`));
  };
  const win = {};
  // eslint-disable-next-line no-new-func
  new Function('$', 'esc', 'api', 'document', 'window', 'confirm', 'toast', 'CURRENT_USER', `
    ${block}
    window.__load = loadAiProviders;
  `)($, esc, api, document, win, () => true, () => {}, { username: 'mommy' });
  await win.__load();
  /** Press Test on a row; settle() then answers it the way `answer` says. */
  const press = (id) => {
    const done = win.testAiProvider(id);
    const req = pending.at(-1);
    return {
      req,
      settle: async () => {
        const out = answer(req);
        if (out instanceof Error) req.reject(out); else req.resolve(out);
        await done;
      },
    };
  };
  return { document, $, win, calls, press, setAnswer: (fn) => { answer = fn; } };
}

const c = await card();
const tests = () => c.calls.filter((x) => x.method === 'POST');

console.log('=== a Test button on every row ===');
{
  for (const id of ['gemini', 'groq', 'cerebras', 'mistral']) {
    const btn = c.$(`ai-${id}-testbtn`);
    ok(btn && btn.textContent.trim() === 'Test' && c.$(`ai-${id}-test`), `${id}: a Test button, and a place for its result`);
  }
  for (const id of ['groq', 'cerebras', 'mistral']) {
    ok(c.$(`ai-${id}-testbtn`).parentNode === c.$(`ai-${id}-key`).closest('label').parentNode,
      `${id}: the button sits beside the key box`);
  }
  ok(/Gemini card above/.test(c.$('ai-gemini-testbtn').parentNode.textContent),
    'Gemini\'s says which key it tests, since its key box is in its own card');
  ok(start > 0 && end > start && /testAiProvider/.test(block) && /aiTestBody/.test(block),
    'the button\'s code is inside the AI providers card block');
}

console.log('=== an empty box sends no key, so the saved key is tested ===');
{
  const t = c.press('groq');
  ok(t.req.url === '/ai/providers/groq/test', 'POST /ai/providers/groq/test');
  ok(!('apiKey' in t.req.body) && t.req.body.model === '', `body ${JSON.stringify(t.req.body)}: no key, and Automatic as the row shows`);
  ok(c.$('ai-groq-testbtn').disabled === true && /Testing/.test(c.$('ai-groq-testbtn').textContent),
    'the button is disabled while the test runs');
  ok(/testing/.test(c.$('ai-groq-test').textContent), 'and the row says it is testing');
  const again = c.calls.length;
  await c.win.testAiProvider('groq');
  ok(c.calls.length === again, 'a second press while it runs sends nothing more');
  await t.settle();
  ok(c.$('ai-groq-testbtn').disabled === false && c.$('ai-groq-testbtn').textContent === 'Test', 'enabled again with the result');
  const head = c.$('ai-groq-test').querySelector('.ai-test-head');
  ok(head?.classList.contains('good') && head.textContent === '✓ Works — llama-3.3-70b-versatile answered in 0.8 s',
    `the result is shown under the row, in green: "${head?.textContent}"`);
  const items = [...c.$('ai-groq-test').querySelectorAll('.ai-test-steps li')].map((li) => li.textContent.trim());
  ok(items.length === 4 && /the saved key/.test(items[0]) && items.slice(1).every((s) => s.startsWith('✓')),
    `with which key was tested and each step: ${items.join(' | ')}`);
  ok(/Groq accepted the key/.test(head.getAttribute('title')), 'and the steps on hover too');
}

console.log('=== a key typed in the box is sent, with the model chosen in the row ===');
{
  c.$('ai-groq-key').value = `  ${TYPED}  `;
  const t = c.press('groq');
  ok(t.req.body.apiKey === TYPED && t.req.body.model === '', 'the typed key, trimmed, and the row\'s model');
  c.setAnswer(() => RESULT({ keySource: 'typed' }));
  await t.settle();
  ok(/typed in the box — not saved/.test(c.$('ai-groq-test').textContent), 'and the result says it was the typed key');
  ok(c.$('ai-groq-key').value.trim() === TYPED, 'the box still holds it, unsaved');

  // As if "Load models" had filled the list and another model were chosen, unsaved.
  const sel = c.$('ai-cerebras-model');
  const opt = c.document.createElement('option');
  opt.value = 'llama3.1-8b';
  opt.textContent = 'llama3.1-8b';
  sel.appendChild(opt);
  for (const o of sel.options) { if (o.value === 'llama3.1-8b') o.setAttribute('selected', ''); else o.removeAttribute('selected'); }
  const cb = c.press('cerebras');
  ok(cb.req.body.model === 'llama3.1-8b' && !('apiKey' in cb.req.body), 'Cerebras: the model selected in its row, and its saved key');
  await cb.settle();
}

console.log('=== the mask is never sent as a key ===');
{
  c.$('ai-mistral-key').value = MASK;
  const m = c.press('mistral');
  ok(!('apiKey' in m.req.body), 'a box holding the mask sends no key');
  await m.settle();

  c.$('f-gemini-key').value = MASK;
  c.$('f-gemini-model').value = 'gemini-3.6-flash';
  const g = c.press('gemini');
  ok(!('apiKey' in g.req.body) && g.req.body.model === 'gemini-3.6-flash',
    'Gemini: its Movie-data box holds the mask when a key is saved, so nothing is sent but the model');
  c.setAnswer(() => RESULT({ provider: 'gemini', model: 'gemini-3.6-flash', latencyMs: null,
    message: '✓ Works — key and gemini-3.6-flash checked; no request spent from Gemini\'s daily 20' }));
  await g.settle();
  ok(/no request spent from Gemini's daily 20/.test(c.$('ai-gemini-test').textContent), 'and its result says no request was spent');

  c.$('f-gemini-key').value = TYPED_GEMINI;
  const g2 = c.press('gemini');
  ok(g2.req.body.apiKey === TYPED_GEMINI, 'a new Gemini key typed in the Gemini card is the one tested');
  await g2.settle();
}

console.log('=== failures and refusals are shown in red, in the row ===');
{
  c.$('ai-groq-key').value = '';
  c.setAnswer(() => RESULT({ ok: false, reason: 'auth', keySource: 'saved', message: '✗ Key rejected — check it was copied in full',
    steps: [{ step: 'key', ok: false, detail: 'bad key — HTTP 401 invalid_api_key' }] }));
  const t = c.press('groq');
  await t.settle();
  const head = c.$('ai-groq-test').querySelector('.ai-test-head');
  ok(head.classList.contains('bad') && head.textContent === '✗ Key rejected — check it was copied in full', 'a rejected key, in red');
  ok(/✗ bad key/.test(c.$('ai-groq-test').textContent), 'with the failed step');

  c.setAnswer(() => Object.assign(new Error('Groq was tested a moment ago — wait 4 s and try again'), {
    status: 429,
    data: { ok: false, provider: 'groq', steps: [], message: 'Groq was tested a moment ago — wait 4 s and try again' },
  }));
  const r = c.press('groq');
  await r.settle();
  ok(/wait 4 s and try again/.test(c.$('ai-groq-test').textContent) && c.$('ai-groq-testbtn').disabled === false,
    'a refusal from the server (too soon) is shown in the same place, and the button comes back');

  c.setAnswer(() => new Error('Your session expired — please sign in again'));
  const s = c.press('groq');
  await s.settle();
  ok(/✗ Your session expired/.test(c.$('ai-groq-test').textContent), 'and so is an error with no result at all');
}

console.log('=== typing a new key clears the old result ===');
{
  ok(c.$('ai-groq-test').textContent.trim() !== '', 'a result is showing');
  // linkedom does not run inline handlers; this is the one the box names.
  ok(/oninput="aiKeyTyped\('groq'\)"/.test(c.$('ai-groq-key').outerHTML), 'the key box calls aiKeyTyped on input');
  c.$('ai-groq-key').value = 'gsk_another';
  c.win.aiKeyTyped('groq');
  ok(c.$('ai-groq-test').textContent.trim() === '', 'and a result about the key that was there before is cleared');
  ok(c.$('ai-cerebras-test').textContent.trim() !== '', 'while the other rows keep theirs');
}

console.log('=== "May clear rated films" is worded by the provider\'s default ===');
{
  // Review finding (2026-10-12): Groq, Cerebras and OpenRouter may clear
  // rated films by default since the operator's live settings became the
  // defaults, and a new install showed each box ticked beside the amber "open
  // models misremember films, so leave this off" - against the default and
  // docs/operations.md. GET /ai/providers says which clear by default
  // (clearsByDefault, pinned in live-settings-defaults); Mistral does not.
  const fresh = () => {
    const v = VIEW();
    v.order.push('openrouter');
    v.providers.push({ id: 'openrouter', label: 'OpenRouter', console: 'openrouter.ai', enabled: true, apiKey: '', model: '',
      autoModel: null, preferences: [], canClearRated: true, status: null });
    for (const p of v.providers) {
      p.clearsByDefault = p.id !== 'mistral';
      p.canClearRated = p.clearsByDefault;
    }
    return v;
  };
  const f = await card(fresh);
  const hint = (id) => f.$(`ai-${id}-clear`).parentNode.querySelector('.hint');
  for (const id of ['groq', 'cerebras', 'openrouter']) {
    ok(f.$(`ai-${id}-clear`).hasAttribute('checked') && !/leave this off/.test(hint(id).textContent) && !hint(id).classList.contains('ai-warn')
      && /on by default/.test(hint(id).textContent) && /untick it to have it answer the film lookup only/.test(hint(id).textContent),
    `${id}: ticked, and its hint says it is on by default and what unticking does, not "leave this off"`);
  }
  ok(/misremember films/.test(hint('groq').textContent), 'still saying why an open model is less sure than Gemini');
  ok(!f.$('ai-mistral-clear').hasAttribute('checked') && /leave this off/.test(hint('mistral').textContent) && hint('mistral').classList.contains('ai-warn'),
    'Mistral, off by default, keeps the amber warning');
  ok(/how Gemini has always worked/.test(hint('gemini').textContent), 'and Gemini\'s is as it was');
}

console.log('=== no key typed is ever sent except to its own test ===');
{
  const leaks = c.calls.filter((x) => x.method !== 'POST' && JSON.stringify(x.body ?? '').includes(TYPED));
  ok(leaks.length === 0, 'nothing but a test request carried the typed key');
  ok(tests().every((x) => /^\/ai\/providers\/(gemini|groq|cerebras|mistral)\/test$/.test(x.url)), 'and every test went to its own provider');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
