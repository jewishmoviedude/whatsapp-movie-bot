/**
 * Ask Gemini what film someone meant.
 *
 * OMDb matches titles literally: it has no idea that "the one with the guy who
 * forgets everything" is Memento, and "f1 brad pitt movie" resolves to nothing
 * at all. Searching the library helps with spellings but only for films already
 * on the server. This fills the remaining gap - a description, a paraphrase, a
 * foreign title, a half-remembered name.
 *
 * IT IDENTIFIES ONLY. The title it returns is fed straight back through OMDb,
 * which remains the sole source of the rating. A model's opinion of what is
 * rated R is not something to gate content on, and it must never be able to
 * talk a blocked film past the check by asserting a rating.
 *
 * Gemini is the first provider asked, not the only one: when its free tier
 * runs dry (20 requests a day, gone by mid-morning on 2026-09-22) the lookup
 * and the nudity check go on to Groq, Cerebras, Mistral and OpenRouter. The
 * chain lives in src/core/ai-providers.js; askGemini() below is Gemini's link
 * in it.
 */
import log from '../../util/logger.js';
import { askChain, providerLabel, geminiModelId, anyAiKey } from '../../core/ai-providers.js';

const logger = log.scope('gemini');

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Room for the answer AND the model's thinking.
 *
 * Newer Gemini models think before answering, and the thinking counts against
 * maxOutputTokens. With the old 150-token cap, gemini-3.6-flash spent 144 tokens
 * thinking about D3: The Mighty Ducks and was cut off two tokens into its JSON.
 * Every content check that day failed that way and let the film through
 * unchecked. Given room, it used 239 thinking tokens and answered correctly.
 * Only tokens actually used are billed, so a generous ceiling costs older,
 * non-thinking models nothing.
 */
export const GEMINI_MAX_OUTPUT_TOKENS = 2048;

/**
 * The model's answer text, whether the reply looks complete, and a short reason
 * to log when it does not.
 *
 * A reply cut off by the token cap arrives as HTTP 200 with finishReason
 * MAX_TOKENS and a fragment of JSON, which parses to nothing. Unless that is
 * logged, it reads exactly like the model not knowing the film. Parts flagged
 * as thoughts are skipped in case a model starts returning its reasoning inline.
 */
export function answerText(data) {
  const cand = data?.candidates?.[0];
  const text = (cand?.content?.parts ?? [])
    .filter((p) => !p?.thought)
    .map((p) => p?.text ?? '')
    .join('');
  const finish = cand?.finishReason
    ?? (data?.promptFeedback?.blockReason ? `blocked (${data.promptFeedback.blockReason})` : 'no candidate');
  const thoughts = data?.usageMetadata?.thoughtsTokenCount ?? 0;
  return {
    text,
    complete: finish === 'STOP' && text.trim() !== '',
    why: `finishReason ${finish}, ${thoughts} thinking tokens`,
    // The same facts as fields, so a caller that has to explain the failure
    // to a person does not have to pick them back out of the sentence above.
    finishReason: finish,
    thoughts,
  };
}

/**
 * Take every copy of the key out of a piece of text.
 *
 * Every copy, not the first: String.replace with a string pattern stops after
 * one, and an error body that quotes the request can quote the key twice.
 */
export function redactKey(text, key) {
  const s = String(text ?? '');
  if (!key || String(key).length < 6) return s;
  return s.split(String(key)).join('***');
}

/**
 * What a failed Gemini HTTP call actually means, read from the error JSON.
 *
 * On 2026-09-22 the content check failed all morning for three different
 * reasons in turn - the model was retired (404), then its replies were cut off,
 * then the free tier's 20-a-day quota ran out (429) - and all three reached the
 * log as the same "content check failed" line with the first 160 characters of
 * the body. The fixes are completely different (change the model, wait until
 * midnight Pacific, raise a limit), so the reason is worked out here from the
 * status code and Google's structured error details rather than by searching
 * the message text, which Google rewords freely.
 *
 * Never contains the key: the message is redacted before it is kept.
 */
export function geminiHttpFailure(status, bodyText = '', { model = null, key = '' } = {}) {
  let err = null;
  try { err = JSON.parse(String(bodyText ?? ''))?.error ?? null; }
  catch { /* not JSON - an HTML error page from a proxy, say */ }
  const details = Array.isArray(err?.details) ? err.details : [];
  const typed = (name) => details.filter((d) => String(d?.['@type'] ?? '').endsWith(name));
  // Shown in the headline ("HTTP 503 UNAVAILABLE") and saved with the
  // failure, so it is redacted and kept short like the message.
  const apiStatus = typeof err?.status === 'string' ? redactKey(err.status, key).slice(0, 60) : null;
  const base = {
    status: Number(status) || null,
    apiStatus,
    model,
    message: redactKey(String(err?.message ?? bodyText ?? ''), key).replace(/\s+/g, ' ').trim().slice(0, 240),
  };

  if (base.status === 429 || apiStatus === 'RESOURCE_EXHAUSTED') {
    const violations = typed('google.rpc.QuotaFailure').flatMap((d) => d?.violations ?? []);
    // A per-day quota is the one that will not clear on its own for hours, so
    // it is the one to report when Google lists several.
    const daily = violations.find((v) => /PerDay/.test(String(v?.quotaId ?? '')));
    const v = daily ?? violations[0] ?? null;
    return {
      ...base,
      // Two reasons, not one with a flag: the tracker mails each reason once
      // per outage, and the two need different fixes. As one reason, a burst
      // that tripped the per-minute limit first sent the only email ("clears
      // within a minute or two"), and the daily quota running out later in the
      // same outage - the one that lasts until midnight Pacific - said nothing.
      reason: daily ? 'quota-daily' : 'quota',
      daily: !!daily,
      quotaId: v?.quotaId ?? null,
      quotaValue: v?.quotaValue ?? null,
      quotaMetric: v?.quotaMetric ?? null,
      retryDelay: typed('google.rpc.RetryInfo')[0]?.retryDelay ?? null,
    };
  }
  if (base.status === 404 || apiStatus === 'NOT_FOUND') return { ...base, reason: 'model-not-found' };
  const keyRejected = typed('google.rpc.ErrorInfo').some((d) => /^API_KEY_/.test(String(d?.reason ?? '')));
  if (keyRejected || base.status === 401 || base.status === 403
      || apiStatus === 'UNAUTHENTICATED' || apiStatus === 'PERMISSION_DENIED') {
    return { ...base, reason: 'auth' };
  }
  if (base.status >= 500) return { ...base, reason: 'server' };
  return { ...base, reason: 'http' };
}

const PROMPT = `You identify films from imprecise descriptions.

Given the user's text, reply with ONLY a JSON object:
{"title": "<the film's official English title>", "year": <release year as a number>, "confidence": <0-1>}

Rules:
- Return the film's real, official title as it would appear on IMDb.
- If the text is already an exact title, return it unchanged.
- If you cannot identify a specific film with reasonable confidence, return
  {"title": null, "year": null, "confidence": 0}.
- Never invent a film. Never guess between several equally likely candidates -
  return null instead.
- Do NOT include a rating, a plot, or any other field.

User's text: `;

/**
 * One generateContent request: Gemini's link in the provider chain.
 *
 * @returns {{ok: true, text, complete, why, finishReason, thoughts, model}
 *   | {ok: false, failure, detail} | {cancelled: true}}
 *   `failure` is geminiHttpFailure()'s structured reason; `detail` is the line
 *   for the log. Neither ever carries the key.
 */
export async function askGemini({ key, model, prompt, timeoutMs = 20000, signal } = {}) {
  if (signal?.aborted) return { cancelled: true };
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ac.abort(); }, timeoutMs);
  const onAbort = () => ac.abort();
  signal?.addEventListener?.('abort', onAbort, { once: true });

  try {
    // "models/gemini-2.5-flash", as Google's own list writes it, is sent as
    // gemini-2.5-flash: the key test checks that name, so the chain must ask it.
    const res = await fetch(`${ENDPOINT}/${encodeURIComponent(geminiModelId(model))}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS, responseMimeType: 'application/json' },
      }),
      signal: ac.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      // Never let the key reach the log, whatever the API echoes back.
      return {
        ok: false,
        failure: geminiHttpFailure(res.status, body, { model, key }),
        detail: `HTTP ${res.status}${body ? `: ${redactKey(body, key).slice(0, 160)}` : ''}`,
      };
    }

    let data;
    try { data = await res.json(); } catch (err) {
      if (err.name === 'AbortError') throw err;
      return {
        ok: false,
        failure: { reason: 'unreadable', model, message: 'the reply was not JSON' },
        detail: `a reply that is not JSON: ${err.message}`,
      };
    }
    return { ok: true, ...answerText(data), model };
  } catch (err) {
    // The caller gave up, not Gemini. Not a sign that anything is broken.
    if (err.name === 'AbortError' && !timedOut) return { cancelled: true };
    if (err.name === 'AbortError') {
      return { ok: false, failure: { reason: 'timeout', model, timeoutMs }, detail: `timed out after ${timeoutMs}ms` };
    }
    const failure = {
      reason: 'network', model,
      // undici puts the real cause (ENOTFOUND, a certificate error) one level
      // down; "fetch failed" on its own explains nothing.
      code: err.cause?.code ?? err.code ?? null,
      message: redactKey(err.cause?.message ?? err.message, key).slice(0, 200),
    };
    return { ok: false, failure, detail: `could not be reached: ${failure.message}` };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}

/**
 * Gemini models that list generateContent but cannot give the bot what every
 * request asks for: a text answer in JSON mode (responseMimeType
 * application/json). Speech models answer in audio and image models with
 * pictures, and Gemma on Gemini's API does not accept JSON mode. The Test
 * button never spends one of Gemini's 20 requests a day on an answer, so the
 * model list is its only check, and it passed any of these as "✓ Works".
 * Gemma is the one most likely to be tried, because its free allowance on
 * the same key is far larger than Gemini's 20 a day.
 */
const GEMINI_NOT_JSON_TEXT = [
  [/tts|audio/i, 'a speech model, which answers in audio'],
  [/image/i, 'an image-generation model'],
  [/gemma/i, 'a Gemma model, and Gemini\'s API does not let Gemma answer in JSON mode'],
  [/embed|aqa/i, 'not a model that writes answers'],
];

/** Why a listed Gemini model cannot answer the bot, or null when it can. */
export function geminiUnsuitable(id) {
  return GEMINI_NOT_JSON_TEXT.find(([re]) => re.test(String(id ?? '')))?.[1] ?? null;
}

/**
 * The models a Gemini key can generate with, from GET /v1beta/models.
 *
 * This is what the panel's Test button asks Gemini, and all it asks. The free
 * tier is 20 generateContent requests a day, shared with the live bot, and ran
 * out by mid-morning on 2026-09-22; a test that spent one would take a film's
 * check away. Listing models is not a generation request and is not counted
 * against that quota, yet it still proves the key: a bad one is refused here
 * exactly as it is by generateContent (HTTP 400, ErrorInfo API_KEY_INVALID).
 *
 * @returns {{ok: true, models: {id, displayName}[], unsuitable: {id, why}[]}
 *   | {ok: false, failure, detail} | {cancelled: true}}
 *   Model ids are without the "models/" prefix, as they are typed in Settings.
 *   `unsuitable` is what the key lists but geminiUnsuitable() rules out, so
 *   the test can say why rather than "not available on this key".
 */
export async function listGeminiModels(key, { timeoutMs = 10000, signal } = {}) {
  if (!key) return { ok: false, failure: { provider: 'gemini', reason: 'no-key' }, detail: 'no key' };
  if (signal?.aborted) return { cancelled: true };
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ac.abort(); }, timeoutMs);
  const onAbort = () => ac.abort();
  signal?.addEventListener?.('abort', onAbort, { once: true });

  try {
    const models = [];
    const unsuitable = [];
    let pageToken = '';
    // Google pages the list; at 1000 a page there is one page today. The cap
    // is only there so a misbehaving token cannot loop forever.
    for (let page = 0; page < 5; page++) {
      const qs = `pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
      const res = await fetch(`${ENDPOINT}?${qs}`, {
        headers: { 'x-goog-api-key': key },
        signal: ac.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        const failure = { ...geminiHttpFailure(res.status, body, { key }), provider: 'gemini' };
        // A 404 here is the listing itself, not a model.
        if (failure.reason === 'model-not-found') failure.reason = 'http';
        return { ok: false, failure, detail: `listing models: HTTP ${res.status}` };
      }
      let data;
      try { data = await res.json(); } catch (err) {
        if (err.name === 'AbortError') throw err;
        return {
          ok: false,
          failure: { provider: 'gemini', reason: 'unreadable', message: 'the model list was not JSON' },
          detail: 'listing models: not JSON',
        };
      }
      for (const m of Array.isArray(data?.models) ? data.models : []) {
        if (typeof m?.name !== 'string') continue;
        // Embedding and answer-ranking models are listed too, and cannot answer the check.
        const methods = Array.isArray(m.supportedGenerationMethods) ? m.supportedGenerationMethods : [];
        if (!methods.includes('generateContent')) continue;
        const id = m.name.replace(/^models\//, '');
        const why = geminiUnsuitable(id);
        if (why) unsuitable.push({ id, why });
        else models.push({ id, displayName: m.displayName ?? null });
      }
      pageToken = typeof data?.nextPageToken === 'string' ? data.nextPageToken : '';
      if (!pageToken) break;
    }
    return { ok: true, models, unsuitable };
  } catch (err) {
    if (err.name === 'AbortError' && !timedOut) return { cancelled: true };
    if (err.name === 'AbortError') {
      return { ok: false, failure: { provider: 'gemini', reason: 'timeout', timeoutMs }, detail: `listing models: timed out after ${timeoutMs}ms` };
    }
    const failure = {
      provider: 'gemini',
      reason: 'network',
      code: err.cause?.code ?? err.code ?? null,
      message: redactKey(err.cause?.message ?? err.message, key).slice(0, 200),
    };
    return { ok: false, failure, detail: `listing models: could not be reached: ${failure.message}` };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}

/**
 * An answer to the lookup prompt, or null when the reply could not be read.
 * A well-formed {"title": null} is an answer - the model saying it does not
 * know, which is the prompt working - so it is {value: null}, and the chain
 * stops there rather than asking a less knowledgeable model to guess.
 */
function readLookup(raw) {
  const text = String(raw ?? '').trim();
  const json = text.startsWith('{') ? text : text.match(/\{[\s\S]*\}/)?.[0];
  if (!json) return null;
  try { JSON.parse(json); } catch { return null; }
  return { value: parseAnswer(text) };
}

/**
 * @param opts.ai        the `ai` config section: the fallback providers and
 *                       their order. Without it, only Gemini is asked.
 * @param opts.onResult  told which providers were tried and how each went, so
 *                       the panel's per-provider status covers the lookup too
 *                       (it spends the same Gemini quota as the nudity check)
 * @returns {{title, year, confidence, provider, model}|null}
 */
export async function identifyTitle(text, cfg = {}, {
  signal, timeoutMs = 15000, totalMs = 30000, ai = null, onResult = null, now,
} = {}) {
  if (!cfg.enabled) return null;
  const query = String(text ?? '').trim();
  if (!query || query.length > 300) return null;
  // On by default (2026-10-12): with no key for any provider it is AI not
  // set up, not a lookup that failed, and worth no more than a debug line
  // (anyAiKey). A key somewhere is a chain being set up: see below.
  if (!anyAiKey({ gemini: cfg, ai: ai ?? {} })) {
    logger.debug(`title lookup for "${query}" skipped: no AI provider has an API key`);
    return null;
  }

  const r = await askChain({
    purpose: 'title lookup',
    subject: query,
    prompt: PROMPT + query,
    gemini: cfg,
    ai,
    parse: readLookup,
    clients: { gemini: askGemini, geminiModels: listGeminiModels },
    attemptMs: timeoutMs,
    totalMs,
    signal,
    ...(now ? { now } : {}),
    log: logger,
  });
  if (r.attempts?.length) {
    try { onResult?.({ ok: !!r.ok, attempts: r.attempts, provider: r.provider ?? null }); }
    catch (err) { logger.warn(`title lookup result could not be recorded: ${err.message}`); }
  }
  if (r.cancelled) {
    logger.warn(`title lookup for "${query}" was cancelled`);
    return null;
  }
  if (!r.ok) {
    // Each provider's failure has already been logged by the chain. With
    // nothing to ask there was no attempt to log, and the lookup - ticked on
    // in Settings - did nothing without a word; say why, since the fix is a
    // setting rather than an outage.
    if (r.failure?.reason === 'no-key') {
      logger.warn(`title lookup for "${query}" did not run: no AI provider has an API key`);
    } else if (r.failure?.reason === 'no-provider') {
      logger.warn(`title lookup for "${query}" did not run: every AI provider with a key is switched off`
        + ` (${(r.failure.off ?? []).map(providerLabel).join(', ')})`);
    }
    return null;             // a research aid that is down must not fail a request
  }
  return r.value ? { ...r.value, provider: r.provider, model: r.model } : null;
}

/** Pull the answer out, tolerating a model that wraps JSON in prose or fences. */
export function parseAnswer(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const json = text.startsWith('{') ? text : text.match(/\{[\s\S]*\}/)?.[0];
  if (!json) return null;

  let parsed;
  try { parsed = JSON.parse(json); } catch { return null; }

  const title = typeof parsed.title === 'string' ? parsed.title.trim() : '';
  if (!title || title.toLowerCase() === 'null') return null;

  const year = Number(parsed.year);
  const confidence = Number(parsed.confidence);
  return {
    title,
    year: Number.isFinite(year) && year > 1870 && year < 2100 ? year : null,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
  };
}
