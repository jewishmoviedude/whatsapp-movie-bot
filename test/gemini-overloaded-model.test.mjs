/* Gemini on Automatic asks the next Flash, once, when the newest is
   overloaded, and passes the overloaded one over for a while.
   Run: node test/gemini-overloaded-model.test.mjs

   On 2026-09-29 Automatic had chosen gemini-3.8-flash, the newest Flash on
   the key, and from 12:59 UTC every call to it came back HTTP 503
   UNAVAILABLE: "This model is currently experiencing high demand. Spikes in
   demand are usually temporary." Nothing fed that back to Automatic and
   nothing tried another Gemini model, so every check went on to Groq, whose
   openai/gpt-oss-120b said The Last Samurai had nudity - citing IMDb, which
   says it has none - and the film, on the operator's override list, was
   withheld. gemini-3.6-flash, the previous Flash on the same key, answered at
   once with nudity=false (0.95) when it was tried by hand at 16:58.

   Pinned here, with Google and Groq a stubbed fetch replaying that body: a
   503 from the newest sends the question once to the next Flash, whose
   answer is the verdict, in exactly two Gemini calls and none to Groq; the
   next request goes straight to the model that answered; once the memory
   lapses the newest is asked again; never a third Gemini call in one turn,
   nor a retry the chain has no time for; a model somebody typed in is never
   swapped; a 500 is not an overload; the memory is per key; a TV episode's
   check gets the same; and the key test is unchanged.

   And from the review of that fix. The stand-in's own failures went to the
   breaker, which on Automatic holds all of Gemini: gemini-3.6-flash running
   out of its own 20 a day (Gemini's free-tier quotas are per model) held
   Gemini until midnight Pacific, and once gemini-3.8-flash recovered every
   check still went to Groq, which may not clear a rated title - the
   incident again. Pinned: a stand-in's quota or 404 holds that model and not
   Gemini, the next turn goes past it to the next Flash, and a refused key
   still holds Gemini. The retry could take up to twice a provider's turn and
   leave Groq out of time; it now fits in what is left of Gemini's own turn,
   or is not made. And a lone Gemini reported its first model's 503 while a
   stand-in's failure had set the hold; it reports the one that did. */
import {
  askChain, resetModelCache, resetBreakers, breakerSnapshot, testProvider, OVERLOAD_MS, isOverloaded,
  rankGeminiModels,
} from '../src/core/ai-providers.js';
import { askGemini, listGeminiModels } from '../src/plugins/movie-requests/gemini.js';
import { checkNudity, checkEpisodeNudity, parseVerdict } from '../src/plugins/movie-requests/content-check.js';
import { ContentCheckHealth, describeFailure } from '../src/core/content-check-health.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const KEY = 'AIzaSyTEST-overloaded-model-0000000000000';
const OTHER_KEY = 'AIzaSyTEST-another-key-000000000000000000';
const GROQ_KEY = 'gsk_TESTTESTTESTTESTTESTTESTTEST00';

// The key's list, as Google gives it: two stable Flash versions, an older
// one, a Pro, a Flash-Lite and a preview.
const LISTED = [
  'gemini-2.5-flash', 'gemini-3.6-flash', 'gemini-3.8-flash', 'gemini-3.8-flash-lite',
  'gemini-3-pro', 'gemini-3.9-flash-preview-09-2026', 'gemini-3.8-flash-001',
];
const OVERLOADED = JSON.stringify({
  error: {
    code: 503,
    message: 'This model is currently experiencing high demand. Spikes in demand are usually temporary.',
    status: 'UNAVAILABLE',
  },
});
const CLEAN = { nudity: false, confidence: 0.95, basis: 'battle violence; nothing sexual is shown' };

let busy = new Set(['gemini-3.8-flash']);   // models answering 503
let broken = new Set();                      // models answering 500
let daily = new Set();                       // models whose own daily quota is used up (429, PerDay)
let gone = new Set();                        // models Google no longer offers (404)
let refused = new Set();                     // models answering as if the key were refused (403)
let hang = new Set();                        // models that never answer, until the request is aborted
let slowMs = 0;                              // how long a 503 takes to come back
// Google's real per-day, per-model free-tier 429.
const PER_DAY = (model) => JSON.stringify({ error: {
  code: 429,
  message: `You exceeded your current quota. Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: ${model}`,
  status: 'RESOURCE_EXHAUSTED',
  details: [
    { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{
      quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
      quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaValue: '20',
    }] },
    { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '37s' },
  ],
} });
const gen = [];                              // every generateContent call, by model
let groqCalls = 0;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  const json = (v, status = 200) => new Response(typeof v === 'string' ? v : JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
  if (u.hostname === 'generativelanguage.googleapis.com') {
    if (u.pathname === '/v1beta/models') {
      return json({ models: LISTED.map((m) => ({ name: `models/${m}`, supportedGenerationMethods: ['generateContent'] })) });
    }
    const model = decodeURIComponent(u.pathname.match(/\/models\/(.+):generateContent$/)?.[1] ?? '');
    gen.push(model);
    if (busy.has(model)) {
      if (slowMs) await new Promise((r) => setTimeout(r, slowMs));
      return json(OVERLOADED, 503);
    }
    if (broken.has(model)) return json({ error: { code: 500, message: 'Internal error encountered.', status: 'INTERNAL' } }, 500);
    if (daily.has(model)) return json(PER_DAY(model), 429);
    if (gone.has(model)) return json({ error: { code: 404, message: `models/${model} is not found for API version v1beta.`, status: 'NOT_FOUND' } }, 404);
    if (refused.has(model)) return json({ error: { code: 403, message: 'Method doesn\'t allow unregistered callers.', status: 'PERMISSION_DENIED' } }, 403);
    if (hang.has(model)) {
      await new Promise((_, reject) => {
        const abort = () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
        if (init.signal?.aborted) abort();
        init.signal?.addEventListener?.('abort', abort, { once: true });
      });
    }
    return json({ candidates: [{ content: { parts: [{ text: JSON.stringify(CLEAN) }] }, finishReason: 'STOP' }] });
  }
  if (u.hostname === 'api.groq.com') {
    groqCalls += 1;
    // What Groq's gpt-oss-120b said that afternoon.
    return json({
      model: 'openai/gpt-oss-120b',
      choices: [{ message: { content: '{"nudity": true, "confidence": 0.8, "basis": "brief nudity (IMDb Parents Guide)"}' }, finish_reason: 'stop' }],
    });
  }
  throw new Error(`unexpected request ${u} ${init.method ?? 'GET'}`);
};

let clock = Date.parse('2026-09-29T13:00:00Z');
const now = () => clock;
const lines = [];
const log = { info: (m) => lines.push(`info ${m}`), warn: (m) => lines.push(`warn ${m}`), error: (m) => lines.push(`error ${m}`) };
const AI = { order: ['gemini', 'groq'], gemini: { enabled: true }, groq: { enabled: true, apiKey: GROQ_KEY, model: 'openai/gpt-oss-120b' } };
const ask = ({ key = KEY, model = '', ai = AI, totalMs, attemptMs } = {}) => askChain({
  purpose: 'content check', subject: 'The Last Samurai (2003)', prompt: 'Film: The Last Samurai (2003)',
  gemini: { apiKey: key, model }, ai,
  parse: (t) => { const v = parseVerdict(t); return v ? { value: v } : null; },
  clients: { gemini: askGemini, geminiModels: listGeminiModels },
  ...(totalMs ? { totalMs } : {}),
  ...(attemptMs ? { attemptMs } : {}),
  now, log,
});
function fresh() {
  resetModelCache(); resetBreakers();
  busy = new Set(['gemini-3.8-flash']); broken = new Set(); slowMs = 0;
  daily = new Set(); gone = new Set(); refused = new Set(); hang = new Set();
  gen.length = 0; groqCalls = 0; lines.length = 0;
  clock = Date.parse('2026-09-29T13:00:00Z');
}

console.log('=== the ranking the stand-in is taken from ===');
{
  ok(rankGeminiModels(LISTED).filter((c) => c.rank === 0).map((c) => c.id).join() === 'gemini-3.8-flash,gemini-3.8-flash-001,gemini-3.6-flash,gemini-2.5-flash',
    'stable Flash, newest first, the moving name before its pinned twin');
  ok(isOverloaded({ reason: 'server', status: 503 }) && isOverloaded({ reason: 'server', apiStatus: 'UNAVAILABLE' })
    && !isOverloaded({ reason: 'server', status: 500, apiStatus: 'INTERNAL' }) && !isOverloaded({ reason: 'quota', status: 429 }),
  'a 503 or UNAVAILABLE is an overload; a 500 and a 429 are not');
}

console.log('=== the newest says 503: the next Flash answers, in two Gemini calls, and Groq is not asked ===');
{
  fresh();
  const results = [];
  const v = await checkNudity('The Last Samurai', 2003, { enabled: true, contentCheck: true, apiKey: KEY, model: '' }, {
    ai: AI, now, onResult: (r) => results.push(r),
  });
  ok(v?.provider === 'gemini' && v.model === 'gemini-3.6-flash' && v.nudity === false && v.confidence === 0.95,
    `the verdict is gemini-3.6-flash's: nudity=${v?.nudity} (${v?.confidence}) from ${v?.provider} ${v?.model}`);
  ok(gen.join() === 'gemini-3.8-flash,gemini-3.6-flash', `exactly two Gemini calls, the newest then the next Flash (${gen.join()})`);
  ok(!gen.includes('gemini-3.8-flash-001'), 'not the pinned twin of the overloaded model, which is the same model');
  ok(groqCalls === 0, 'and Groq, whose "nudity" withheld the film, was never asked');
  const attempts = results[0]?.attempts ?? [];
  ok(attempts.length === 2 && attempts[0].ok === false && attempts[0].reason === 'server' && attempts[0].status === 503
    && attempts[0].model === 'gemini-3.8-flash' && attempts[1].ok === true && attempts[1].model === 'gemini-3.6-flash',
  `the health tracker is told both: ${JSON.stringify(attempts.map((a) => `${a.model}:${a.ok ? 'ok' : a.reason}`))}`);
  ok(breakerSnapshot(clock).length === 0, 'Gemini is not held back: the overload was one model\'s, not the key\'s');
}

console.log('=== the log says which model answered, and why the newest was passed over ===');
{
  fresh();
  const r = await ask();
  ok(r.ok && r.model === 'gemini-3.6-flash', 'answered by the next Flash');
  ok(lines.some((l) => /^warn content check for "The Last Samurai \(2003\)": Gemini gemini-3\.8-flash is overloaded \(HTTP 503: .*high demand.*\), so gemini-3\.6-flash is asked instead, and gemini-3\.8-flash is passed over until 13:30 UTC$/.test(l)),
    `the overload, and what was done about it: ${lines.find((l) => /overloaded/.test(l))}`);
  ok(lines.some((l) => /^info content check for "The Last Samurai \(2003\)" answered by Gemini \(gemini-3\.6-flash\) after Gemini gemini-3\.8-flash: server/.test(l)),
    `which model answered: ${lines.find((l) => /answered by/.test(l))}`);
  ok(!lines.some((l) => l.includes(KEY)), 'with no key in any line');

  // The next film, a minute later: straight to the model that answered.
  gen.length = 0; lines.length = 0; clock += 60_000;
  const next = await ask();
  ok(next.ok && next.model === 'gemini-3.6-flash' && gen.join() === 'gemini-3.6-flash',
    `the next request goes straight to gemini-3.6-flash, with no 503 first (${gen.join()})`);
  ok(next.attempts.length === 1 && next.attempts[0].ok, 'one attempt, and it answered');
  ok(lines.some((l) => /answered by Gemini \(gemini-3\.6-flash\); gemini-3\.8-flash is passed over until 13:30 UTC, as it was overloaded/.test(l)),
    `and the log says why it was not the newest: ${lines.find((l) => /answered by/.test(l))}`);

  // Still overloaded when the memory lapses: asked, 503, and moved on again.
  gen.length = 0; clock = Date.parse('2026-09-29T13:00:00Z') + OVERLOAD_MS + 1000;
  const later = await ask();
  ok(later.ok && gen.join() === 'gemini-3.8-flash,gemini-3.6-flash',
    `after ${OVERLOAD_MS / 60000} minutes the newest is asked again first (${gen.join()})`);

  // Recovered: the newest answers, and is the choice again.
  busy = new Set(); gen.length = 0; clock += OVERLOAD_MS + 1000;
  const back = await ask();
  ok(back.ok && back.model === 'gemini-3.8-flash' && gen.join() === 'gemini-3.8-flash',
    `once it recovers, the choice returns to the newest (${gen.join()})`);
}

console.log('=== never a third Gemini call in one turn ===');
{
  fresh();
  busy = new Set(['gemini-3.8-flash', 'gemini-3.6-flash']);
  const r = await ask();
  ok(gen.join() === 'gemini-3.8-flash,gemini-3.6-flash', `the newest and one stand-in, and not gemini-2.5-flash (${gen.join()})`);
  ok(r.ok && r.provider === 'groq' && groqCalls === 1, 'then the next provider, as before');

  // Both are remembered, so the next turn starts with the one left.
  gen.length = 0; clock += 60_000;
  await ask();
  ok(gen[0] === 'gemini-2.5-flash', `the next turn goes to the Flash that has not said 503 (${gen.join()})`);
}

console.log('=== no stand-in without the time to ask it ===');
{
  fresh();
  slowMs = 1100;
  const r = await ask({ totalMs: 1500 });
  ok(gen.join() === 'gemini-3.8-flash', `with under a second of the chain's budget left, no second call (${gen.join()})`);
  ok(!r.ok || r.provider !== 'gemini', 'and Gemini did not answer that turn');
  slowMs = 0;
}

console.log('=== a model somebody typed in is never swapped ===');
{
  fresh();
  const r = await ask({ model: 'gemini-3.8-flash', ai: { order: ['gemini'], gemini: { enabled: true } } });
  ok(!r.ok && r.failure?.reason === 'server' && r.failure.status === 503, `the 503 is the answer (${r.failure?.reason})`);
  ok(gen.join() === 'gemini-3.8-flash', `one call, to the model typed in (${gen.join()})`);
  gen.length = 0;
  await ask({ model: 'gemini-3.8-flash', ai: { order: ['gemini'], gemini: { enabled: true } } });
  ok(gen.join() === 'gemini-3.8-flash', 'and it is asked again next time, whatever Automatic has learnt');
}

console.log('=== a 500 is not an overload ===');
{
  fresh();
  busy = new Set(); broken = new Set(['gemini-3.8-flash']);
  const r = await ask({ ai: { order: ['gemini'], gemini: { enabled: true } } });
  ok(!r.ok && r.failure?.reason === 'server' && gen.join() === 'gemini-3.8-flash', `one call, and the failure stands (${gen.join()})`);
}

console.log('=== the memory is per key ===');
{
  fresh();
  await ask();
  gen.length = 0;
  await ask({ key: OTHER_KEY });
  ok(gen[0] === 'gemini-3.8-flash', `another key still asks its newest first (${gen.join()})`);
}

console.log('=== a TV episode\'s check gets the same ===');
{
  fresh();
  const v = await checkEpisodeNudity({ season: 1, episode: 14, title: 'Those Who Lurk Underground' },
    { name: 'Fullmetal Alchemist: Brotherhood', year: 2009 },
    { enabled: true, contentCheck: true, apiKey: KEY, model: '' }, { ai: AI, now });
  ok(v?.model === 'gemini-3.6-flash' && gen.join() === 'gemini-3.8-flash,gemini-3.6-flash' && groqCalls === 0,
    `the episode is answered by the next Flash (${gen.join()})`);
}

console.log('=== the key test is unchanged ===');
{
  // It reports the choice Automatic has made for the key and spends none of
  // the free tier's 20 a day; an overload is not a change of choice.
  fresh();
  await ask();
  gen.length = 0;
  const t = await testProvider('gemini', { key: KEY, model: '', listGemini: listGeminiModels });
  ok(t.ok && t.automatic && t.model === 'gemini-3.8-flash', `Automatic (now ${t.model})`);
  ok(/Automatic \(now gemini-3\.8-flash\)/.test(t.message), `"${t.message}"`);
  ok(gen.length === 0, 'and no generateContent call');
}

console.log('=== a stand-in out of its own daily quota holds that model, not Gemini ===');
{
  fresh();
  daily = new Set(['gemini-3.6-flash']);
  const r = await ask();
  ok(gen.join() === 'gemini-3.8-flash,gemini-3.6-flash', `the newest, then the stand-in (${gen.join()})`);
  ok(r.ok && r.provider === 'groq', 'Groq answers that turn, as it must');
  ok(breakerSnapshot(clock).length === 0, `and Gemini is not held back: the quota used up was gemini-3.6-flash's (${JSON.stringify(breakerSnapshot(clock))})`);
  const standIn = r.attempts.find((a) => a.model === 'gemini-3.6-flash');
  ok(standIn?.reason === 'quota-daily' && standIn.standIn === true && !standIn.until
    && standIn.modelUntil === Date.parse('2026-09-30T07:00:00Z'),
  `the attempt says it was the stand-in's own quota, held until midnight Pacific (${JSON.stringify({ reason: standIn?.reason, standIn: standIn?.standIn, until: standIn?.until, modelUntil: standIn?.modelUntil })})`);
  ok(lines.some((l) => /^info Gemini: gemini-3\.6-flash, asked in place of gemini-3\.8-flash, failed because its own daily quota is used up, so it is passed over until 07:00 UTC; Gemini itself is not held back$/.test(l)),
    `the log says so: ${lines.find((l) => /asked in place of/.test(l))}`);
  const d = describeFailure(standIn, { now: clock });
  ok(d.headline === 'Gemini\'s stand-in model gemini-3.6-flash has used up its own daily quota',
    `and describeFailure does not say Gemini's own quota is gone: "${d.headline}"`);

  // The health tracker's Gemini row is about Gemini, not the stand-in.
  const cfg = { gemini: { enabled: true, contentCheck: true, apiKey: KEY, model: '' }, ai: AI };
  const health = new ContentCheckHealth({ configStore: { get: () => cfg }, now });
  health.noteProviders(r.attempts);
  const row = health.snapshot().providers.find((p) => p.id === 'gemini');
  ok(row?.state === 'failed' && row.reason === 'server' && !row.until,
    `the dashboard's Gemini row shows the overload, not a daily quota held till midnight (${row?.state}, ${row?.reason})`);

  // gemini-3.8-flash recovers once its overload has lapsed: Gemini answers,
  // and Groq - which may not clear a rated title - is not asked.
  busy = new Set(); gen.length = 0; groqCalls = 0; clock += OVERLOAD_MS + 1000;
  const back = await ask();
  ok(back.ok && back.provider === 'gemini' && back.model === 'gemini-3.8-flash' && groqCalls === 0 && gen.join() === 'gemini-3.8-flash',
    `the next check is Gemini's own model again, with no Groq call (${back.provider} ${back.model}; ${gen.join()}; Groq ${groqCalls})`);
}

console.log('=== within the window, a stand-in out of quota is passed over: the next Flash is asked ===');
{
  fresh();
  daily = new Set(['gemini-3.6-flash']);
  await ask();
  gen.length = 0; clock += 60_000;
  const r = await ask();
  ok(gen.join() === 'gemini-2.5-flash', `not gemini-3.8-flash (overloaded) nor gemini-3.6-flash (out of quota), but gemini-2.5-flash (${gen.join()})`);
  ok(r.ok && r.provider === 'gemini' && r.model === 'gemini-2.5-flash', 'which answers');
  ok(lines.some((l) => /answered by Gemini \(gemini-2\.5-flash\); gemini-3\.8-flash is passed over until 13:30 UTC, as it was overloaded/.test(l)),
    `and the log says why: ${lines.filter((l) => /answered by/.test(l)).at(-1)}`);
}

console.log('=== a stand-in Google no longer offers (404) does not hold Gemini ===');
{
  fresh();
  gone = new Set(['gemini-3.6-flash']);
  const r = await ask();
  ok(breakerSnapshot(clock).length === 0, `no hold on Gemini (${JSON.stringify(breakerSnapshot(clock))})`);
  const a = r.attempts.find((x) => x.model === 'gemini-3.6-flash');
  ok(a?.reason === 'model-not-found' && a.standIn === true && a.modelUntil === clock + 15 * 60_000,
    'the stand-in is passed over for 15 minutes, as a provider would be');
  gen.length = 0; clock += 60_000;
  await ask();
  ok(gen.join() === 'gemini-2.5-flash', `and the next turn goes past it (${gen.join()})`);
}

console.log('=== a stand-in whose key is refused still holds Gemini ===');
{
  fresh();
  refused = new Set(['gemini-3.6-flash']);
  const r = await ask();
  const b = breakerSnapshot(clock);
  ok(b.length === 1 && b[0].provider === 'gemini' && b[0].reason === 'auth', `a refused key is the whole provider's (${JSON.stringify(b)})`);
  const a = r.attempts.find((x) => x.model === 'gemini-3.6-flash');
  ok(a?.reason === 'auth' && a.until && !a.standIn, 'and the attempt says Gemini is held, not only the model');
}

console.log('=== the stand-in fits in Gemini\'s own turn, so the next provider keeps its time ===');
{
  // 1/10 of the title lookup's limits: 1.5 s a turn, 3 s in all. A 503 after
  // 1.4 s leaves 0.1 s of Gemini's turn, not worth a request; Groq gets the
  // 1.6 s it always had.
  fresh();
  slowMs = 1400; hang = new Set(['gemini-3.6-flash']);
  const r = await ask({ attemptMs: 1500, totalMs: 3000 });
  ok(gen.join() === 'gemini-3.8-flash', `no stand-in with a tenth of a second of the turn left (${gen.join()})`);
  ok(r.ok && r.provider === 'groq' && groqCalls === 1, `Groq is asked, and answers (${r.ok ? r.provider : r.failure?.summary})`);

  // A quick 503 leaves most of the turn: the stand-in is asked, but only for
  // what is left of it, so a stand-in that hangs cannot take Groq's time.
  fresh();
  slowMs = 200; hang = new Set(['gemini-3.6-flash']);
  const t0 = Date.now();
  const q = await ask({ attemptMs: 1500, totalMs: 3000 });
  const stand = q.attempts.find((a) => a.model === 'gemini-3.6-flash');
  ok(gen.join() === 'gemini-3.8-flash,gemini-3.6-flash' && stand?.reason === 'timeout',
    `after a quick 503 the stand-in is asked, and times out (${gen.join()}: ${stand?.reason})`);
  ok(stand.ms < 1450, `bounded by what was left of Gemini's turn, about 1.3 s, not a whole turn of 1.5 s (${stand.ms} ms)`);
  ok(q.ok && q.provider === 'groq' && groqCalls === 1 && Date.now() - t0 < 3000, 'and Groq still answers within the chain\'s time');
  slowMs = 0;
}

console.log('=== a lone Gemini reports the failure that set its hold ===');
{
  const lone = { order: ['gemini'], gemini: { enabled: true } };
  fresh();
  daily = new Set(['gemini-3.6-flash']);
  const r = await ask({ ai: lone });
  ok(!r.ok && breakerSnapshot(clock).length === 0 && r.failure.reason === 'server' && r.failure.status === 503
    && r.failure.model === 'gemini-3.8-flash',
  `no hold was set, so the first model's 503 is the failure, not a quota Gemini does not have (${r.failure?.reason})`);

  fresh();
  refused = new Set(['gemini-3.6-flash']);
  const q = await ask({ ai: lone });
  const b = breakerSnapshot(clock);
  ok(!q.ok && b.length === 1 && q.failure.reason === b[0].reason && q.failure.reason === 'auth',
    `a hold was set, so the failure is the one that set it (${q.failure?.reason}; held for ${b[0]?.reason})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
