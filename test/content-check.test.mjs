/* Asking what is IN a film, not only its letter grade - and using the answer
   only ever to let a request through.
   Run: node test/content-check.test.mjs

   Both real outcomes were wrong, in opposite directions:
     Nymphomaniac: Vol. I (2013)  "Not Rated"  -> SENT
     Kill Me Three Times (2014)   R (violence) -> BLOCKED
   An MPAA rating conflates violence, language and sex, and says nothing at all
   about a film no board classified.

   The check was first written to block on nudity whatever the rating. On
   2026-09-29 the operator changed that: "The AI check is so the request can
   go through without getting denied if possible", and, asked whether the AI
   should still block an unrated or PG-13 film it says has nudity - the
   Nymphomaniac case - "No, AI only helps". Pinned here: decide() never
   refuses anything the rating did not; a sure "no nudity" from a provider
   allowed to clear clears a rated film where the operator allows that, and
   every other answer leaves it blocked on its rating; and the AI is asked
   only when its answer could change the outcome (aiCanClear). */
import fs from 'node:fs';
import {
  parseVerdict, decide, checkNudity, checkEpisodeNudity, aiCanClear, notClearedWhy,
} from '../src/plugins/movie-requests/content-check.js';
import { isBlockedRating, isUnrated } from '../src/plugins/movie-requests/theatrical.js';
import { DEFAULT_CONFIG } from '../src/config/schema.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const BLOCKED = ['R', 'NC-17', 'X', 'TV-MA'];

console.log('=== the two films that motivated this, under "No, AI only helps" ===');
{
  const nym = { nudity: true, confidence: 0.95, basis: 'explicit sex scenes' };
  const kill = { nudity: false, confidence: 0.9, basis: 'violence only' };

  // Not Rated, so the rating lets it through; the operator chose, knowing
  // this case, that the AI's "nudity" does not block it. blockUnrated does.
  const a = decide(nym, isBlockedRating('Not Rated', BLOCKED), { allowCleanRatedFilms: true });
  ok(a.blocked === false && a.reason === 'allowed', `Nymphomaniac, "Not Rated", goes by its rating: ${a.reason}`);
  const au = decide(nym, isBlockedRating('Not Rated', BLOCKED, { blockUnrated: true }), { allowCleanRatedFilms: true });
  ok(au.blocked === true && au.reason === 'blocked by rating', `with blockUnrated on it is refused - on its rating: ${au.reason}`);

  // R for violence. Only sent if the operator opted into that.
  const b = decide(kill, isBlockedRating('R', BLOCKED));
  ok(b.blocked === true, 'Kill Me Three Times stays blocked by default');
  const c = decide(kill, isBlockedRating('R', BLOCKED), { allowCleanRatedFilms: true });
  ok(c.blocked === false, 'and is allowed once the operator turns that on');
  ok(c.reason === 'rated, but no nudity', `saying why: ${c.reason}`);
}

console.log('=== the AI never denies: no answer refuses anything the rating did not ===');
{
  const OPTS = { minConfidence: 0.7, allowCleanRatedFilms: true };
  for (const v of [
    { nudity: true, confidence: 0.99, basis: 'explicit', provider: 'gemini' },
    { nudity: true, confidence: 0.9, basis: 'x', provider: 'groq', canClearRated: true },
    { nudity: null, confidence: 0, basis: 'unknown film' },
    null,
  ]) {
    ok(decide(v, false, OPTS).blocked === false, `a film its rating allows is sent whatever the AI says (${JSON.stringify(v)?.slice(0, 40)})`);
    const r = decide(v, true, OPTS);
    ok(r.blocked === true && r.reason === 'blocked by rating', `a rated one is refused on its rating, not on the answer (${r.reason})`);
  }
  const src = fs.readFileSync(new URL('../src/plugins/movie-requests/content-check.js', import.meta.url), 'utf8');
  ok(!/contains nudity/.test(src.slice(src.indexOf('export function decide'))), 'decide() has no "contains nudity" outcome any more');
}

console.log('=== the AI is asked only when its answer could change the outcome ===');
{
  const on = { enabled: true, contentCheck: true, allowCleanRatedFilms: true, apiKey: 'k' };
  ok(aiCanClear(on) === true, 'check on, clean rated films allowed, Gemini may clear: asked');
  ok(aiCanClear({ ...on, allowCleanRatedFilms: false }) === false, 'with "Also send rated films" off, a "no nudity" could send nothing: not asked');
  ok(aiCanClear({ ...on, contentCheck: false }) === false && aiCanClear({ ...on, enabled: false }) === false, 'nor with the check off');
  ok(aiCanClear(on, { gemini: { canClearRated: false } }) === false,
    'nor when no provider allowed to clear a rated title is switched on');
  ok(aiCanClear(on, { gemini: { canClearRated: false }, groq: { enabled: true, apiKey: 'g', canClearRated: true } }) === true,
    'a fallback the operator ticked counts');
  ok(notClearedWhy({ verdict: { nudity: true, provider: 'groq' } }) === 'Groq said nudity'
    && notClearedWhy({ failure: { reason: 'quota-daily' } }) === 'did not run: quota-daily'
    && notClearedWhy({ verdict: { nudity: null, provider: 'gemini' } }) === 'Gemini could not confirm no nudity',
  'and why one was not cleared is said in a few words');
}

console.log('=== unrated is not a clean bill of health ===');
{
  for (const r of ['Not Rated', 'UNRATED', 'NR', 'N/A', '', null, undefined]) {
    ok(isUnrated(r), `${JSON.stringify(r)} counts as unrated`);
  }
  ok(!isUnrated('PG-13'), 'a real rating does not');
  ok(isBlockedRating('Not Rated', BLOCKED) === false, 'by default unrated still passes (unchanged behaviour)');
  ok(isBlockedRating('Not Rated', BLOCKED, { blockUnrated: true }) === true,
    'and can be blocked outright when the operator asks');
}

console.log('=== a model hedging never reads as "safe" ===');
{
  // Anything that is not an explicit false must not open the gate.
  for (const raw of [
    '{"nudity":"maybe","confidence":0.9}',
    '{"nudity":null,"confidence":0.9}',
    '{"confidence":0.9}',
    '{"nudity":0,"confidence":0.9}',
  ]) {
    ok(parseVerdict(raw)?.nudity === null, `${raw.slice(0, 32)}… → unknown, not false`);
  }
  ok(parseVerdict('{"nudity":false,"confidence":0.9}')?.nudity === false, 'an explicit false IS false');
}

console.log('=== low confidence is treated as unknown ===');
{
  const unsure = { nudity: false, confidence: 0.3, basis: 'guessing' };
  ok(decide(unsure, true, { allowCleanRatedFilms: true }).blocked === true, 'an unsure "no nudity" cannot clear a blocked rating');
  const bare = { nudity: false, confidence: 0, basis: '' };
  ok(decide(bare, true, { allowCleanRatedFilms: true, minConfidence: 0 }).blocked === true,
    'nor can a bare "no nudity" when the confidence box was emptied to 0 (clearingBar reads it as 0.7)');
}

console.log('=== a checker that is down never opens a gate ===');
{
  ok(decide(null, true).blocked === true, 'no answer + blocked rating = blocked');
  ok(decide(null, false).blocked === false, 'no answer + clean rating = the rating decides, as before');
  ok(await checkNudity('X', 2020, { enabled: false, contentCheck: true, apiKey: 'k' }) === null,
    'disabled means it does not run');
  ok(await checkNudity('X', 2020, { enabled: true, contentCheck: false, apiKey: 'k' }) === null,
    'and the check has its own switch, separate from Gemini itself');
  ok(await checkNudity('X', 2020, { enabled: true, contentCheck: true, apiKey: '' }) === null,
    'no key, no call');
}

console.log('=== it asks about the film being SENT, not the metadata record ===');
{
  // Nymphomaniac resolved to a different 2010 record; the library held Vol. I.
  // Checking the record would have asked about the wrong film entirely.
  // The check itself lives in contentGate (film-gate.js), which the live
  // gate and the dry run both call, and is handed the library's match.
  const idx = fs.readFileSync(new URL('../src/plugins/movie-requests/index.js', import.meta.url), 'utf8');
  const gate = fs.readFileSync(new URL('../src/plugins/movie-requests/film-gate.js', import.meta.url), 'utf8');
  ok(/checkNudity\(hit\?\.title \?\? movie\?\.title, hit\?\.year \?\? movie\?\.year/.test(gate)
    && /contentGate\(\{\s*store: ctx\.store, movie, hit,/.test(idx),
    "the LIBRARY's title and year are what get checked");
  ok(!/blocked-content/.test(idx), 'and nothing is refused on the content any more - only on the rating');
}

console.log('=== the prompt asks the right question ===');
{
  const src = fs.readFileSync(new URL('../src/plugins/movie-requests/content-check.js', import.meta.url), 'utf8');
  ok(/Parents Guide/i.test(src), 'it points at published content advisories');
  ok(/bare breasts, buttocks or genitals/.test(src), 'and defines nudity concretely rather than leaving it to taste');
  ok(/false for kissing, implied sex/.test(src), 'with the negative cases spelled out too');
  ok(/Never guess from the genre or the rating alone/.test(src),
    'and forbids inferring it from the rating, which is the thing being replaced');
}

console.log('=== the basis says what is shown, and names no source ===');
{
  // 2026-09-29: asked only for a "basis" of "<max 15 words>", Groq's
  // gpt-oss-120b withheld The Last Samurai for nudity with a basis citing
  // IMDb, whose Parents Guide says Sex & Nudity: None. A model cannot consult
  // a source while it answers, and a named one made a wrong answer look
  // checked. The definition of nudity is the operator's policy, and is pinned
  // here word for word so rewording the basis cannot move it.
  const FILM_DEFINITION = `"nudity" means true if the film contains ANY of:
  - bare breasts, buttocks or genitals, however brief
  - explicit or simulated sex scenes
  - sustained sexual content that would be described as graphic

It is false for kissing, implied sex with nothing shown, innuendo, or
suggestive dialogue alone.`;
  const EPISODE_DEFINITION = `"nudity" means true if THIS EPISODE contains ANY of:
  - bare breasts, buttocks or genitals, however brief (animated counts too)
  - explicit or simulated sex scenes
  - sustained sexual content that would be described as graphic

It is false for kissing, implied sex with nothing shown, innuendo, or
suggestive dialogue alone. Violence, gore and strong language are not nudity.`;
  const prompts = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    prompts.push(JSON.parse(init.body).contents[0].parts[0].text);
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"nudity": false, "confidence": 0.9, "basis": "x"}' }] }, finishReason: 'STOP' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const g = { enabled: true, contentCheck: true, apiKey: 'k', model: 'gemini-test' };
  try {
    await checkNudity('The Last Samurai', 2003, g);
    await checkEpisodeNudity({ season: 1, episode: 14 }, { name: 'Fullmetal Alchemist: Brotherhood' }, g);
  } finally {
    globalThis.fetch = realFetch;
  }
  for (const [what, prompt, definition] of [['film', prompts[0], FILM_DEFINITION], ['episode', prompts[1], EPISODE_DEFINITION]]) {
    const field = String(prompt ?? '').match(/"basis": "<([^>]*)>"/)?.[1] ?? '';
    ok(/^what the (film|episode) shows, max 15 words$/.test(field), `the ${what} prompt asks the basis for what is shown ("${field}")`);
    ok(/Do not name\s+or cite a source in it/.test(prompt ?? ''), `and says not to name or cite a source in it (${what})`);
    ok(String(prompt ?? '').includes(definition), `the ${what} prompt's definition of nudity is word for word what it was`);
  }
}

console.log('=== the loosening is the operator\'s choice, and does nothing until AI is set up ===');
{
  // Opt-in until 2026-10-12, when the operator's live settings - the check
  // on, and clean rated films let through - became the defaults: "I just
  // updated most of the settings, please set these in the repo coding as
  // default". The choice is still theirs, a switch of its own, and a new
  // install with no AI key loosens nothing: the AI is not asked (aiCanClear),
  // so a rated film is refused on its rating, exactly as with the switches off.
  const schema = fs.readFileSync(new URL('../src/config/schema.js', import.meta.url), 'utf8');
  const g = schema.match(/gemini: \{[\s\S]*?\n  \},/)[0];
  ok(/contentCheck: true/.test(g), 'the check is on by default, the operator\'s live setting');
  ok(/allowCleanRatedFilms: true/.test(g),
    'and letting an R film through on a clean content report is a separate switch, on by the operator\'s choice');
  ok(aiCanClear(DEFAULT_CONFIG.gemini, DEFAULT_CONFIG.ai) === false,
    'with no key for any provider - a new install - the AI is not asked, so nothing is cleared');
  ok(aiCanClear({ ...DEFAULT_CONFIG.gemini, apiKey: 'k' }, DEFAULT_CONFIG.ai) === true,
    'and once a key is saved, it is');
  ok(aiCanClear(DEFAULT_CONFIG.gemini, { ...DEFAULT_CONFIG.ai, mistral: { ...DEFAULT_CONFIG.ai.mistral, apiKey: 'm' } }) === true,
    'a key on any provider is a chain being set up: a Gemini switched on without its key still counts, and fails as "no key"');
  ok(/blockUnrated: false/.test(schema), 'blocking unrated films is opt-in, so nothing changes silently');
}

console.log('=== a lost download is retried, not thrown away ===');
{
  // D3: The Mighty Ducks downloaded 3.52 GB over 24 minutes, then failed with
  // a bare ENOENT on its own source file and was marked permanently failed.
  // The most expensive moment to fail was the one treated as unrecoverable.
  // The list lives in media/resume.js now, shared with the TV pipeline.
  const idx = fs.readFileSync(new URL('../src/plugins/movie-requests/index.js', import.meta.url), 'utf8');
  const { isTransient } = await import('../src/media/resume.js');
  for (const sig of ['ENOENT', 'SOURCE_VANISHED', 'terminated', 'fetch failed',
                     'Connection Closed', 'ENETUNREACH', 'Timed Out']) {
    ok(isTransient(new Error(`x ${sig} y`)), `"${sig}" is treated as transient`);
  }
  ok(/const transient = interrupted \|\| isTransient\(err\)/.test(idx), 'and deliver() classifies with that list');
}

console.log('=== and a vanished source says what it found ===');
{
  const idx = fs.readFileSync(new URL('../src/plugins/movie-requests/index.js', import.meta.url), 'utf8');
  ok(/the download reported success but/.test(idx),
    'the error names the contradiction rather than leaving a bare stat trace');
  ok(/work dir holds \$\{siblings/.test(idx),
    'and lists what IS in the directory, which is what identifies the culprit');
  ok(/the download produced an empty file/.test(idx), 'a zero-byte result is caught separately');
  ok(idx.indexOf("code = 'SOURCE_VANISHED'") > 0, 'with a code the retry logic can match on');
}

console.log('=== the dry run applies the SAME gates as a real request ===');
{
  // "Nymphomaniac" reported "Passes every check — the bot would send this"
  // with the nudity check switched on, because the dry run only ever called
  // isBlockedRating. A dry run that disagrees with the live path is worse
  // than none: it is the thing you check BEFORE trusting the bot.
  const api = fs.readFileSync(new URL('../src/web/api.js', import.meta.url), 'utf8');
  const dry = api.match(/router\.post\('\/test\/request'[\s\S]*?\n  \}\);/)[0];

  // Since 2026-09-29 the dry run takes the live gate's own steps
  // (film-gate.js) rather than a copy of them: its copy of the rating step
  // knew nothing of the override list, and told the operator a listed title
  // was "Blocked: rating".
  const gate = fs.readFileSync(new URL('../src/plugins/movie-requests/film-gate.js', import.meta.url), 'utf8');
  const idx = fs.readFileSync(new URL('../src/plugins/movie-requests/index.js', import.meta.url), 'utf8');
  // `vetted` is the library's file as step 4b identified it (fileGate), the
  // film a request goes on with.
  ok(/const vetted = file\.movie;/.test(dry) && /contentGate\(\{\s*store: overrideStore\(\), movie: vetted, hit,/.test(dry)
    && /checkNudity\(hit\?\.title \?\? movie\?\.title/.test(gate),
    'it runs the content step, against the LIBRARY film as the live path does');
  ok(!/blocked-content|blocked-override/.test(dry), 'and returns no verdict the AI decided: only the rating refuses');
  ok(/cfg: mr,/.test(dry) && /blockUnrated: cfg\.blockUnrated === true/.test(gate),
    'and honours blockUnrated, which it previously ignored');
  ok(/ratingGate\(overrideStore\(\), m, mr, \{ gemini: cfg\.gemini, ai: cfg\.ai \}\)/.test(dry)
    && /ratingGate\(ctx\.store, movie, cfg, \{ gemini: ctx\.config\.gemini, ai: ctx\.config\.ai \}\)/.test(idx),
    'and its rating step is the live one, bypass list and all');
  ok(/could not determine\$\{didNotRun\}/.test(dry),
    'an inconclusive answer is shown as such rather than as a pass');
  ok(/nothing has classified this film/.test(dry),
    'and an unrated film says so, instead of a bare "allowed"');

  // The live gate and the dry run must decide the same way, or they can
  // still diverge on the settings that matter. They do: both call
  // contentGate, which reads every one of them.
  ok(/contentGate\(/.test(dry) && /await contentGate\(/.test(idx), 'the dry run and the live gate decide through the same contentGate');
  ok(/decide\(verdict, true, \{[\s\S]*?minConfidence/.test(gate) && /aiCanClear\(g, ai\)/.test(gate),
    'which passes the operator\'s bar to decide(), and asks only when aiCanClear says an answer could help');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
