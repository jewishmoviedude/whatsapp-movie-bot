/* Gemini replies cut off by the token cap must be noticed, and must not happen.
   Run: node test/gemini-thinking-budget.test.mjs

   2026-09-22: gemini-2.0-flash was retired and the model was switched to
   gemini-3.6-flash, which thinks before it answers and bills the thinking
   against maxOutputTokens. The content check allowed 150 tokens; the model spent
   144 of them thinking and returned '": "' with finishReason MAX_TOKENS. That
   parsed to nothing, so every film was logged "no answer -> allowed" and went
   out with no nudity check at all, and nothing in the log said why. The title
   lookup (120 tokens) failed the same way. The responses below are the real
   shapes the API returned. */
import log from '../src/util/logger.js';
import { checkNudity } from '../src/plugins/movie-requests/content-check.js';
import { identifyTitle, answerText } from '../src/plugins/movie-requests/gemini.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const warnings = [];
log.on('line', (e) => { if (e.level === 'warn') warnings.push(`${e.scope}: ${e.msg}`); });

let lastBody = null;
function reply(payload) {
  globalThis.fetch = async (_url, init) => {
    lastBody = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
  };
}

const TRUNCATED = {
  candidates: [{ content: { parts: [{ text: '": "' }] }, finishReason: 'MAX_TOKENS' }],
  usageMetadata: { promptTokenCount: 53, candidatesTokenCount: 2, thoughtsTokenCount: 144 },
};
const answered = (text) => ({
  candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
  usageMetadata: { thoughtsTokenCount: 239 },
});

const CFG = { enabled: true, contentCheck: true, apiKey: 'k', model: 'gemini-3.6-flash' };

console.log('=== the content check leaves the model room to think ===');
{
  reply(answered('{"nudity": false, "confidence": 1.0, "basis": "PG Disney family film"}'));
  const v = await checkNudity('D3: The Mighty Ducks', 1996, CFG);
  const max = lastBody.generationConfig.maxOutputTokens;
  ok(max >= 1024, `asks for ${max} output tokens, not 150`);
  ok(v && v.nudity === false && v.confidence === 1, 'a complete reply is read as an answer');
}

console.log('=== a reply cut off mid-JSON is a check that did not run, and says so ===');
{
  warnings.length = 0;
  reply(TRUNCATED);
  const v = await checkNudity('D3: The Mighty Ducks', 1996, CFG);
  ok(v === null, 'returns null, so the caller falls back to the rating');
  ok(warnings.some((w) => w.includes('D3: The Mighty Ducks') && w.includes('MAX_TOKENS') && w.includes('144')),
    'and logs a warning naming the film, MAX_TOKENS and the thinking tokens');
}

console.log('=== the title lookup leaves room too ===');
{
  reply(answered('{"title": "Memento", "year": 2000, "confidence": 0.9}'));
  const r = await identifyTitle('the one with the guy who forgets everything', CFG);
  ok(lastBody.generationConfig.maxOutputTokens >= 1024, 'asks for enough output tokens');
  ok(r && r.title === 'Memento' && r.year === 2000, 'and reads a complete answer');
}

console.log('=== a truncated lookup warns, an honest "do not know" does not ===');
{
  warnings.length = 0;
  reply(TRUNCATED);
  ok(await identifyTitle('once opon a hollywood', CFG) === null, 'truncated lookup returns null');
  ok(warnings.some((w) => w.includes('once opon a hollywood') && w.includes('MAX_TOKENS')), 'and warns');

  warnings.length = 0;
  reply(answered('{"title": null, "year": null, "confidence": 0}'));
  ok(await identifyTitle('asdfgh', CFG) === null, '"do not know" returns null');
  ok(warnings.length === 0, 'without a warning, because that is the prompt working');
}

console.log('=== thoughts are never mistaken for the answer ===');
{
  const t = answerText({
    candidates: [{
      content: { parts: [{ thought: true, text: '{"nudity": true, "confidence": 0.9}' }, { text: '{"nudity": false}' }] },
      finishReason: 'STOP',
    }],
  });
  ok(t.text === '{"nudity": false}', 'only the non-thought part is the answer');
  ok(t.complete === true, 'and it counts as complete');
  ok(answerText({}).complete === false && /no candidate/.test(answerText({}).why), 'an empty reply is incomplete');
  ok(/blocked \(SAFETY\)/.test(answerText({ promptFeedback: { blockReason: 'SAFETY' } }).why),
    'a blocked prompt says it was blocked');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
