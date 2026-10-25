/* Gemini as a last-resort identifier. Run: node test/gemini-fallback.test.mjs

   OMDb matches titles literally, so a description or a half-remembered name
   gets nowhere. Gemini fills that gap - but it IDENTIFIES ONLY. Whatever it
   names is looked up in OMDb again, and the rating always comes from OMDb.
   A model must never be able to talk a blocked film past the rating gate by
   asserting a rating of its own. */
import fs from 'node:fs';
import { parseAnswer, identifyTitle, redactKey } from '../src/plugins/movie-requests/gemini.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

console.log('=== the answer is parsed out of whatever the model wraps it in ===');
{
  const clean = parseAnswer('{"title":"Memento","year":2000,"confidence":0.95}');
  ok(clean.title === 'Memento' && clean.year === 2000, 'plain JSON');

  ok(parseAnswer('```json\n{"title":"Dune","year":2021,"confidence":0.9}\n```')?.title === 'Dune',
    'JSON in a code fence');
  ok(parseAnswer('Sure! {"title":"Heat","year":1995,"confidence":0.8}')?.title === 'Heat',
    'JSON after chatter');
}

console.log('=== "I do not know" is respected, not turned into a guess ===');
{
  ok(parseAnswer('{"title":null,"year":null,"confidence":0}') === null, 'an explicit null is null');
  ok(parseAnswer('I could not identify that film.') === null, 'prose with no JSON is null');
  ok(parseAnswer('') === null, 'an empty answer is null');
  ok(parseAnswer('{"title":"","year":2000,"confidence":1}') === null, 'an empty title is null');
  ok(parseAnswer('not json at all') === null, 'garbage is null');
}

console.log('=== nonsense values are clamped, not trusted ===');
{
  const wild = parseAnswer('{"title":"X","year":99999,"confidence":5}');
  ok(wild.year === null, 'an impossible year is dropped rather than passed on');
  ok(wild.confidence === 1, 'confidence is clamped to 0-1');
  ok(parseAnswer('{"title":"X","year":1850,"confidence":0.9}').year === null, 'so is a pre-cinema year');
  ok(parseAnswer('{"title":"X","confidence":-3}').confidence === 0, 'and a negative one');
}

console.log('=== it does nothing unless switched on AND keyed ===');
{
  ok(await identifyTitle('anything', { enabled: false, apiKey: 'k' }) === null, 'off means off');
  ok(await identifyTitle('anything', { enabled: true, apiKey: '' }) === null, 'no key means no call');
  ok(await identifyTitle('', { enabled: true, apiKey: 'k' }) === null, 'and empty text is not sent');
  ok(await identifyTitle('x'.repeat(400), { enabled: true, apiKey: 'k' }) === null,
    'nor is an absurdly long message');
}

console.log('=== the rating NEVER comes from the model ===');
{
  // The whole safety property. Gemini names a film; OMDb decides what it is
  // rated and therefore whether it may be sent.
  const g = fs.readFileSync(new URL('../src/plugins/movie-requests/gemini.js', import.meta.url), 'utf8');
  ok(/Do NOT include a rating/.test(g), 'the prompt forbids returning a rating');
  ok(!/rated|rating/.test(g.match(/export function parseAnswer[\s\S]*?\n\}/)[0]),
    'and the parser has no field for one, so a model volunteering it is ignored');

  const idx = fs.readFileSync(new URL('../src/plugins/movie-requests/index.js', import.meta.url), 'utf8');
  const block = idx.match(/if \(!found && ctx\.config\.gemini\?\.enabled\)[\s\S]*?\n    \}/)[0];
  ok(/found = await lookupMovie\(/.test(block),
    "Gemini's answer is re-looked-up in OMDb rather than used directly");
  ok(!/found = \{/.test(block) && !/found = guess/.test(block),
    'the model result is never assigned as the movie record itself');
  ok(/guess\.confidence >= minConfidence/.test(block), 'a low-confidence guess is discarded');
}

console.log('=== it runs LAST, after the cheaper and safer routes ===');
{
  const idx = fs.readFileSync(new URL('../src/plugins/movie-requests/index.js', import.meta.url), 'utf8');
  const research = idx.indexOf('researching the library');
  const gemini = idx.indexOf('ctx.config.gemini?.enabled');
  const notFound = idx.indexOf('no match for');
  ok(research < gemini, 'the library search is tried first — it is free and bounded');
  ok(gemini < notFound, 'and Gemini before giving up');
}

console.log('=== an outage cannot fail a request ===');
{
  // A research aid that is down must be invisible, not fatal.
  const g = fs.readFileSync(new URL('../src/plugins/movie-requests/gemini.js', import.meta.url), 'utf8');
  ok(/return null;\s*\/\/ a research aid that is down must not fail a request/.test(g),
    'network errors return null rather than throwing');
  ok(/AbortError/.test(g) && /timeoutMs/.test(g), 'and it cannot hang a request forever');
  // redactKey, not body.replace(key, '***'): a string pattern only replaces the
  // FIRST copy, and an error body that quotes the request can quote it twice.
  ok(/redactKey\(body, key\)/.test(g), 'an API error echoing the key back never reaches the log');
  ok(redactKey('k=SECRETKEY1 and again SECRETKEY1', 'SECRETKEY1') === 'k=*** and again ***',
    'every copy of the key is taken out, not only the first');
}

console.log('=== the key is stored encrypted, like the others ===');
{
  const schema = fs.readFileSync(new URL('../src/config/schema.js', import.meta.url), 'utf8');
  ok(/'gemini\.apiKey',/.test(schema), 'gemini.apiKey is in SECRET_PATHS');
  ok(/minConfidence: 0\.6/.test(schema), 'and there is a sane confidence floor by default');
  // Off until 2026-10-12, when the operator's live settings, with it on,
  // became the defaults ("please set these in the repo coding as default").
  // A new install has no key, so on by default it must cost nothing: no
  // request, and nothing louder than a debug line (anyAiKey).
  ok(/enabled: true/.test(schema.match(/gemini: \{[\s\S]*?\}/)[0]), 'on by default, the operator\'s live setting');
  const realFetch = globalThis.fetch;
  let asked = 0;
  globalThis.fetch = async () => { asked += 1; throw new Error('no network in tests'); };
  try {
    ok(await identifyTitle('the one with the dream heist', { enabled: true, apiKey: '' }, { ai: { groq: { enabled: true, apiKey: '' } } }) === null
      && asked === 0, 'and with no key for any provider it asks nothing, and finds nothing');
  } finally { globalThis.fetch = realFetch; }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
