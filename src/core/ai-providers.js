/**
 * Fallback AI providers for the nudity check and the film lookup.
 *
 * Both used to ask Google Gemini and nothing else. On 2026-09-22 the key was
 * on Gemini's free tier - 20 requests a day for gemini-3.6-flash, reset at
 * midnight Pacific - and the bot makes about 30 in its first hour, so by
 * mid-morning every check was refused with HTTP 429 and every film went out on
 * its rating alone until the next day. Groq, Cerebras and Mistral have much
 * larger free tiers, and all three speak OpenAI's Chat Completions format, so
 * one small client covers them. OpenRouter, added later at the operator's
 * request, speaks the same format and fronts many hosted models, including
 * free ones, behind one key.
 *
 * askChain() asks the providers in the configured order, and the first usable
 * answer wins; the answer says which provider gave it. Three things keep that
 * from being slower or less safe than asking Gemini alone:
 *
 *  - A circuit breaker. A provider that has just said "quota used up" is asked
 *    LAST until its retry time (midnight Pacific for Gemini's daily quota), so
 *    a waiting requester is not first made to sit through a refusal. It is
 *    demoted rather than dropped: when nothing else answers it is still tried,
 *    which is how a key that has had billing switched on gets noticed, and it
 *    means a Gemini configured on its own behaves exactly as it did before. A
 *    rejected key or an unknown model is demoted the same way, for a while.
 *  - A bound on the whole chain as well as on each attempt, because somebody
 *    is waiting on the answer in a group chat.
 *  - A policy in decide() (src/plugins/movie-requests/content-check.js). These
 *    providers run open models that recall particular films less reliably
 *    than Gemini, so their "no nudity" does not clear a title its rating
 *    blocks unless the operator has said otherwise for that provider - and
 *    the nudity check, which is asked only to clear such a title, then does
 *    not ask them at all. No answer from any provider refuses a title: the
 *    operator's rule since 2026-09-29, "No, AI only helps".
 *
 * Nothing this module returns or logs carries a key: every message that could
 * echo one goes through scrubKeys().
 */
import crypto from 'node:crypto';
import log from '../util/logger.js';

const logger = log.scope('ai');

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

// `keysUrl` is the page that actually issues a key, not the console's front
// door: the panel links straight to it from each key box, because the three
// fallbacks are the keys a new operator is least likely to know how to get,
// and naming a bare hostname left them the only ones with nothing to click.
export const PROVIDERS = Object.freeze({
  gemini: { id: 'gemini', label: 'Gemini', openai: false, console: 'aistudio.google.com', keysUrl: 'https://aistudio.google.com/apikey' },
  groq: { id: 'groq', label: 'Groq', openai: true, base: 'https://api.groq.com/openai/v1', console: 'console.groq.com', keysUrl: 'https://console.groq.com/keys' },
  cerebras: { id: 'cerebras', label: 'Cerebras', openai: true, base: 'https://api.cerebras.ai/v1', console: 'cloud.cerebras.ai', keysUrl: 'https://cloud.cerebras.ai/' },
  mistral: { id: 'mistral', label: 'Mistral', openai: true, base: 'https://api.mistral.ai/v1', console: 'console.mistral.ai', keysUrl: 'https://console.mistral.ai/api-keys' },
  // OpenRouter lists its models to anybody, key or none, so a model list
  // proves nothing about the key the way it does for the others. `keyCheck`
  // is the endpoint that does: GET /key answers 401 for a key it does not know.
  openrouter: { id: 'openrouter', label: 'OpenRouter', openai: true, base: 'https://openrouter.ai/api/v1', console: 'openrouter.ai', keysUrl: 'https://openrouter.ai/settings/keys', keyCheck: '/key' },
  // Ollama's cloud API, OpenAI-compatible at /v1 with the key as a Bearer
  // token (docs.ollama.com/openai). It may never clear a rated title. The
  // discussions group's questions use it (src/core/discussion-answers.js).
  ollama: { id: 'ollama', label: 'Ollama', openai: true, base: 'https://ollama.com/v1', console: 'ollama.com', keysUrl: 'https://ollama.com/settings/keys', canClearRated: false },
});
export const PROVIDER_IDS = Object.keys(PROVIDERS);
export const FALLBACK_IDS = PROVIDER_IDS.filter((id) => id !== 'gemini');
// OpenRouter last: it was added after the others, and an install that already
// has an order keeps it, with OpenRouter appended by normaliseOrder().
// Ollama is last: it has a key only once the operator adds one, so
// until then it is a row in the card with nothing to ask. normaliseOrder adds
// the providers a saved order leaves out from this list, so this is what puts
// it in the panel of a box whose saved order predates it.
export const DEFAULT_ORDER = ['gemini', 'groq', 'cerebras', 'mistral', 'openrouter', 'ollama'];

/**
 * Whether an id names a provider. An own-property check, because ids arrive
 * from request bodies and URLs, and PROVIDERS.constructor is truthy.
 */
export const isProvider = (id) => typeof id === 'string' && Object.hasOwn(PROVIDERS, id);

/** A failure recorded before there were several providers has no `provider`, and was Gemini's. */
export function providerLabel(id) {
  return isProvider(id) ? PROVIDERS[id].label : (id ? String(id) : 'Gemini');
}

/**
 * Room for the answer and any reasoning, for the same reason as
 * GEMINI_MAX_OUTPUT_TOKENS: some hosted models reason before answering and the
 * reasoning counts against the cap. Only tokens actually used are billed, so a
 * generous ceiling costs a model that answers straight away nothing.
 */
export const PROVIDER_MAX_TOKENS = 2048;

export const CHAIN_LIMITS = Object.freeze({
  // One provider's turn. The content check passes its own 20 s, the lookup 15 s.
  attemptMs: 20 * SECOND,
  // The whole chain. A requester is waiting for a reaction in a group chat;
  // four providers at 20 s each would be well over a minute of nothing.
  totalMs: 45 * SECOND,
  // Listing models to choose one automatically.
  modelsMs: 10 * SECOND,
});

/**
 * How long a provider is asked last after each kind of refusal. Quota and
 * rate limits use the provider's own retry time when it gives one.
 */
export const HOLD_MS = Object.freeze({
  auth: 15 * MINUTE,
  'model-not-found': 15 * MINUTE,
  quota: MINUTE,
  // A daily limit on Groq, Cerebras or Mistral with no reset time in the
  // reply. Gemini's always resets at midnight Pacific, so it never uses this.
  'quota-daily': HOUR,
  max: 24 * HOUR,
});

/**
 * Which model to use when the operator leaves it on "automatic": the first
 * of these the key can see, else the first chat model the provider lists.
 *
 * Bigger general-knowledge instruct models come first. Knowing what is in a
 * particular film is recall, not reasoning, and recall grows with model size;
 * speed barely matters for a handful of films a day. Models that reason at
 * length before answering come after plain instruct models of similar size,
 * because they can spend the whole token budget thinking.
 */
export const MODEL_PREFERENCES = Object.freeze({
  // No preferred list: the first chat model the key can see is used, as for
  // any provider this list does not name.
  // Ollama's cloud models that its free usage credits cover (its own list,
  // which the operator pasted 2026-10-23). Its list also holds decision and
  // embedding models that refuse a chat request (clef:27b answered HTTP 400
  // "a decision model ... only supports /v1/systemone"), so Automatic must
  // pick from these, not from the first name the list gives.
  ollama: ['gpt-oss:120b', 'gemma4:31b', 'nemotron-3-super', 'gpt-oss:20b', 'nemotron-3-nano:30b', 'beam', 'nemotron-3-ultra'],
  // Gemini has no list: pickGeminiModel() takes the newest version it sees,
  // so a new Flash is used the day the key can see it.
  gemini: [],
  groq: [
    'moonshotai/kimi-k2-instruct-0905',
    'moonshotai/kimi-k2-instruct',
    'llama-3.3-70b-versatile',
    'meta-llama/llama-4-maverick-17b-128e-instruct',
    'openai/gpt-oss-120b',
    'qwen/qwen3-32b',
    'meta-llama/llama-4-scout-17b-16e-instruct',
    'llama-3.1-8b-instant',
  ],
  cerebras: [
    'qwen-3-235b-a22b-instruct-2507',
    'llama-3.3-70b',
    'llama-4-maverick-17b-128e-instruct',
    'gpt-oss-120b',
    'zai-glm-4.6',
    'qwen-3-32b',
    'llama-4-scout-17b-16e-instruct',
    'llama3.1-8b',
  ],
  mistral: [
    'mistral-large-latest',
    'mistral-medium-latest',
    'mistral-small-latest',
    'open-mistral-nemo',
    'ministral-8b-latest',
  ],
  // OpenRouter fronts hundreds of models, most of them paid per token, and
  // this install runs on its free tier, where only the ":free" variants cost
  // nothing (and a paid one fails with 402 on an account with no credit). So
  // the free variants of the biggest general-knowledge instruct models come
  // first, for the same recall reason as above; pickModel() then takes any
  // other ":free" chat model before it will consider a paid one. The paid
  // entries at the end are only for an account that has credit and nothing
  // free left on its list. Reasoning models (DeepSeek R1, Qwen3 in thinking
  // mode) are last among the free ones, because they can spend the whole token
  // budget thinking.
  openrouter: [
    'moonshotai/kimi-k2:free',
    'deepseek/deepseek-chat-v3.1:free',
    'deepseek/deepseek-chat-v3-0324:free',
    'nousresearch/hermes-3-llama-3.1-405b:free',
    'meta-llama/llama-3.1-405b-instruct:free',
    'qwen/qwen3-235b-a22b-2507:free',
    'meta-llama/llama-3.3-70b-instruct:free',
    'meta-llama/llama-4-maverick:free',
    'google/gemini-2.0-flash-exp:free',
    'openai/gpt-oss-120b:free',
    'z-ai/glm-4.5-air:free',
    'mistralai/mistral-small-3.2-24b-instruct:free',
    'qwen/qwen3-235b-a22b:free',
    'deepseek/deepseek-r1:free',
    'google/gemini-2.5-flash',
    'meta-llama/llama-3.3-70b-instruct',
  ],
});

/**
 * Providers whose automatic choice takes any free model before a paid one.
 * Only OpenRouter marks its free models, with a ":free" suffix on the id.
 */
const FREE_FIRST = new Set(['openrouter']);
const isFree = (id) => /:free$/.test(id);

/* ------------------------------ keys ------------------------------ */

/**
 * Take every copy of every key out of a piece of text, and anything shaped
 * like one of these providers' keys. Every copy, not the first: an error body
 * that quotes the request can quote the key twice.
 */
export function scrubKeys(text, keys = []) {
  let s = String(text ?? '');
  for (const k of keys) {
    if (k && String(k).length >= 6) s = s.split(String(k)).join('***');
  }
  return s
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, 'AIza***')
    .replace(/gsk_[0-9A-Za-z]{20,}/g, 'gsk_***')
    .replace(/csk-[0-9A-Za-z]{20,}/g, 'csk-***')
    // OpenRouter: sk-or-v1-<64 hex>. The version is matched loosely so a v2
    // key is scrubbed too.
    .replace(/sk-or-(?:v\d+-)?[0-9A-Za-z]{20,}/g, 'sk-or-***')
    .replace(/(Bearer\s+)[^\s"',}]{8,}/gi, '$1***');
}

/**
 * A failure with every string in it scrubbed, however deep.
 *
 * Scrubbing only `message` was not enough: a provider's machine-readable
 * error code and type were copied into `apiStatus` and `quotaId` verbatim, and
 * from there into state.json and the dry run's headline. No real provider is
 * known to put the key in those fields, but a failure object is kept, saved
 * and shown, so all of it is treated as text that could echo the key.
 */
export function scrubFailure(f, keys = [], depth = 0) {
  if (typeof f === 'string') return scrubKeys(f, keys);
  if (!f || typeof f !== 'object') return f;
  // Nothing a failure carries nests this deep; whatever does is dropped
  // rather than kept unscrubbed.
  if (depth > 6) return null;
  if (Array.isArray(f)) return f.map((v) => scrubFailure(v, keys, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(f)) out[k] = scrubFailure(v, keys, depth + 1);
  return out;
}

/** A short machine-readable field from a provider's error body, scrubbed and capped. */
function errorField(v, keys) {
  if (v == null || typeof v === 'object') return null;
  return scrubKeys(String(v), keys).replace(/\s+/g, ' ').trim().slice(0, 60) || null;
}

/** Every AI key in a config, for scrubbing. */
export function configuredKeys(cfg = {}) {
  return [cfg?.gemini?.apiKey, ...FALLBACK_IDS.map((id) => cfg?.ai?.[id]?.apiKey)]
    .filter((k) => typeof k === 'string' && k);
}

/** Never logged or returned: only compared, so a changed key or model clears what was learned about the old one. */
function fingerprint(...parts) {
  return crypto.createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16);
}

/* ------------------------------ plan ------------------------------ */

/** The configured order, with unknown ids dropped and any provider it leaves out appended. */
export function normaliseOrder(order) {
  const out = [];
  for (const id of Array.isArray(order) ? order : []) {
    if (isProvider(id) && !out.includes(id)) out.push(id);
  }
  for (const id of DEFAULT_ORDER) if (!out.includes(id)) out.push(id);
  return out;
}

/**
 * Every provider in order, with what is needed to ask it. Gemini keeps its
 * key and model where they always were (gemini.apiKey, gemini.model), so an
 * existing install carries on unchanged; `ai.gemini` holds only its place in
 * the chain and whether it may clear rated films.
 *
 * `canClearRated` defaults to true for Gemini - what it has always been
 * trusted to do - and to false for the others. See decide() and aiCanClear().
 */
export function chainPlan({ gemini = {}, ai = {} } = {}) {
  return normaliseOrder(ai?.order).map((id) => {
    const meta = PROVIDERS[id];
    if (id === 'gemini') {
      return {
        id, label: meta.label, openai: false,
        enabled: ai?.gemini?.enabled !== false,
        key: String(gemini?.apiKey ?? ''),
        model: geminiModelId(gemini?.model),
        automatic: !geminiModelId(gemini?.model),
        canClearRated: ai?.gemini?.canClearRated !== false,
      };
    }
    const c = ai?.[id] ?? {};
    const model = String(c.model ?? '').trim();
    return {
      id, label: meta.label, openai: true, base: meta.base,
      enabled: c.enabled === true,
      key: String(c.apiKey ?? '').trim(),
      model,
      automatic: !model,
      canClearRated: c.canClearRated === true,
    };
  });
}

export const usable = (p) => !!(p?.enabled && p.key);

/**
 * Does any provider in the chain have a key, switched on or off? None is AI
 * not set up on this install at all. The film lookup, the nudity check and
 * every provider are on by default since the operator's live settings
 * became the defaults (2026-10-12), so a new install has them all switched
 * on and no key: asked anyway, each rated film failed its check as "no key",
 * raised the nudity-check alert, and each unidentified title logged a warn.
 * With no key anywhere they are not asked (aiCanClear, identifyTitle), and a
 * request is judged on its rating alone, as it was with them off. A key on
 * any provider is a chain being set up, and what is missing is reported.
 */
export function anyAiKey({ gemini = {}, ai = {} } = {}) {
  return chainPlan({ gemini, ai }).some((p) => !!p.key);
}

/**
 * A Gemini model name as the generateContent URL wants it. Google's own model
 * list calls them "models/gemini-2.5-flash", so that form gets pasted into
 * the Movie data box. The key test used to drop the prefix before looking the
 * model up while askGemini() sent the name as saved, to
 * .../models/models%2Fgemini-2.5-flash:generateContent; the test passed a
 * name the chain then sent wrongly. Both go through this now, so they agree.
 */
export const geminiModelId = (model) => String(model ?? '').trim().replace(/^models\//, '');

/* --------------------------- clock helpers --------------------------- */

const LA_CLOCK = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

/** The wall clock in Los Angeles at an instant, as if it were UTC, to the second. */
function laWallClock(ts) {
  const p = Object.fromEntries(LA_CLOCK.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
}

/** How far Los Angeles is ahead of UTC at an instant (negative: -7 h or -8 h). */
const laOffset = (ts) => laWallClock(ts) - Math.floor(ts / 1000) * 1000;

/**
 * How long until Gemini's daily quotas reset. Google resets them at midnight
 * Pacific time, not UTC and not the box's own midnight.
 *
 * Worked out as the actual instant of the next midnight in Los Angeles, not as
 * 24 hours minus the time elapsed there: the day the clocks change is 23 or 25
 * hours long. Counted the simple way, between midnight and 2 AM on those two
 * days, Gemini was held an hour past its reset in March - a fallback judged
 * films Gemini could have - and released an hour early in November, which
 * wasted a request on a refusal.
 */
export function untilMidnightPacific(now = Date.now()) {
  const today = new Date(laWallClock(now));
  const wall = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1);
  // The offset at the next midnight can differ from the offset now; a second
  // pass reads it there. Midnight itself is never inside a change, which in
  // Los Angeles happens at 2 AM.
  let at = wall - laOffset(now);
  at = wall - laOffset(at);
  return at - now;
}

/**
 * "2m59.56s", "7.66s", "150ms", "1h2m", "37s" (Groq, Gemini), or plain seconds
 * as a number or numeric string (Retry-After, Cerebras) - in milliseconds.
 */
export function parseDuration(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  let total = 0;
  let matched = false;
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s*(ms|h|m|s)/g)) {
    matched = true;
    total += Number(m[1]) * { ms: 1, s: SECOND, m: MINUTE, h: HOUR }[m[2]];
  }
  return matched ? Math.round(total) : null;
}

/** Retry-After is seconds or an HTTP date. */
function parseRetryAfter(v, now) {
  if (v == null || v === '') return null;
  const secs = parseDuration(v);
  if (secs != null) return secs;
  const at = Date.parse(String(v));
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/** "1 h 5 min", "37 s" - for a person reading an email or the panel. */
export function fmtDelay(ms) {
  if (ms == null) return null;
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  const h = Math.floor(m / 60);
  return h ? `${h} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`;
}

const fmtUtc = (ts) => `${new Date(ts).toISOString().slice(11, 16)} UTC`;

/* ------------------------------ breaker ------------------------------ */

const breakers = new Map();   // provider id -> { fp, until, reason, since, failure }

function breakerFp(p) { return fingerprint(p.id, p.key, p.model); }

/** The open breaker for this provider as configured now, or null. */
export function breakerFor(p, now = Date.now()) {
  const b = breakers.get(p.id);
  if (!b || b.fp !== breakerFp(p) || b.until <= now) return null;
  return b;
}

/** How long a failure keeps a provider at the back of the queue; 0 for failures that say nothing about the next film. */
export function holdFor(p, f, now = Date.now()) {
  let ms = 0;
  switch (f?.reason) {
    case 'quota-daily':
      ms = p.id === 'gemini' ? untilMidnightPacific(now) : (f.retryAfterMs ?? HOLD_MS['quota-daily']);
      break;
    case 'quota':
      ms = f.retryAfterMs ?? parseDuration(f.retryDelay) ?? HOLD_MS.quota;
      break;
    case 'auth':
    case 'model-not-found':
      ms = HOLD_MS[f.reason];
      break;
    default:
      return 0;
  }
  return Math.min(HOLD_MS.max, Math.max(SECOND, ms));
}

function trip(p, f, now) {
  const ms = holdFor(p, f, now);
  if (!ms) return null;
  const prev = breakerFor(p, now);
  // What it said, kept so that a check which runs out of time before
  // reaching it can still give the real reason it was at the back (see
  // askChain). `f` has already been scrubbed.
  const entry = { fp: breakerFp(p), until: now + ms, reason: f.reason, since: prev?.since ?? now, failure: { ...f } };
  breakers.set(p.id, entry);
  // Once per trip, not once per film: a demoted provider that is tried last
  // and refuses again the same way only moves its retry time.
  if (!prev || prev.reason !== f.reason) {
    const routine = p.id === 'gemini' && f.reason === 'quota-daily';
    const what = {
      'quota-daily': 'its daily quota is used up',
      quota: 'it is rate-limiting',
      auth: 'it refused the API key',
      'model-not-found': `it has no model called "${f.model ?? '(automatic)'}"`,
    }[f.reason] ?? f.reason;
    // A free-tier Gemini running dry every morning is expected, and the next
    // provider carries on; a rejected key or model needs someone to act.
    logger[routine ? 'info' : 'warn'](`${p.label}: ${what}, so it is asked last until ${fmtUtc(entry.until)}`
      + `${routine ? ' (midnight Pacific)' : ''}, after the other providers`);
  }
  return entry;
}

function close(p) {
  const b = breakers.get(p.id);
  if (!b) return;
  breakers.delete(p.id);
  logger.info(`${p.label} answered again; it is back in its place in the order`);
}

/** Forget what was learned; one provider, or all of them. */
export function resetBreakers(id = null) {
  if (id) breakers.delete(id);
  else breakers.clear();
}

/** For the panel and tests. Never includes the fingerprint. */
export function breakerSnapshot(now = Date.now()) {
  return [...breakers.entries()]
    .filter(([, b]) => b.until > now)
    .map(([provider, b]) => ({ provider, reason: b.reason, until: b.until, since: b.since }));
}

/* ------------------------ reading the replies ------------------------ */

/**
 * The answer with any inline reasoning taken out.
 *
 * Some hosted models think out loud before answering: <think>...</think> from
 * Qwen and DeepSeek-style models, similar tags from others. That reasoning
 * routinely contains the very JSON shape being asked for - "maybe
 * {"nudity": true}? no..." - and the extractor takes the first brace it
 * sees, so it must never reach the parser. A reasoning block that was cut off
 * before it closed means there is no answer at all, not that the reasoning is
 * one.
 */
export function stripReasoning(raw) {
  let s = String(raw ?? '');
  const TAGS = 'think|thinking|reasoning|thought|reflection';
  s = s.replace(new RegExp(`<(${TAGS})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`, 'gi'), '');
  s = s.replace(/◁think▷[\s\S]*?◁\/think▷/g, '');
  // Magistral's raw reasoning markers.
  s = s.replace(/\[THINK\][\s\S]*?\[\/THINK\]/g, '');
  // A closing tag with no opening one: the opening was put in by the chat
  // template, so everything before the last close is reasoning.
  const closers = [...s.matchAll(new RegExp(`<\\/(?:${TAGS})\\s*>|◁\\/think▷|\\[\\/THINK\\]`, 'gi'))];
  if (closers.length) {
    const last = closers[closers.length - 1];
    s = s.slice(last.index + last[0].length);
  }
  // Harmony-format leakage (gpt-oss) - only the final channel is the answer,
  // and a reply with channels but no final one has no answer in it at all.
  const fin = s.lastIndexOf('<|channel|>final<|message|>');
  if (fin !== -1) s = s.slice(fin + '<|channel|>final<|message|>'.length).replace(/<\|(end|return)\|>[\s\S]*$/, '');
  else if (s.includes('<|channel|>')) s = '';
  // Cut off mid-thought.
  s = s.replace(new RegExp(`<(?:${TAGS})\\b[^>]*>[\\s\\S]*$`, 'i'), '');
  s = s.replace(/◁think▷[\s\S]*$/, '');
  s = s.replace(/\[THINK\][\s\S]*$/, '');
  return s.trim();
}

/**
 * The answer text from a Chat Completions reply, whether it looks complete,
 * and a short reason to log when it does not. Mistral's reasoning models
 * return content as a list of chunks; only the "text" chunks are the answer.
 * A separate `reasoning` field (gpt-oss on Groq) is never read at all.
 */
export function chatAnswer(data) {
  const choice = data?.choices?.[0];
  const content = choice?.message?.content;
  const raw = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((c) => (typeof c === 'string' ? c : c?.type === 'text' ? (c.text ?? '') : '')).join('')
      : '';
  const text = stripReasoning(raw);
  // Read from the provider's body and repeated in the log and the alert, so
  // it is kept short; askChain scrubs it with everything else it reports.
  const finish = choice ? String(choice.finish_reason ?? 'none').slice(0, 40) : 'no choice';
  const reasoning = Number(data?.usage?.completion_tokens_details?.reasoning_tokens ?? 0) || 0;
  const cut = ['length', 'model_length', 'error', 'content_filter', 'no choice'].includes(finish);
  return {
    text,
    complete: !cut && text !== '',
    finishReason: finish,
    thoughts: reasoning,
    why: `finish_reason ${finish}${reasoning ? `, ${reasoning} reasoning tokens` : ''}`
      + `${text !== raw.trim() ? ', reasoning removed' : ''}`,
  };
}

/** Whether a piece of text is exactly one JSON object, with nothing before or after it but whitespace. */
export function isOneJsonObject(text) {
  const t = String(text ?? '').trim();
  if (!t.startsWith('{') || !t.endsWith('}')) return false;
  try {
    const v = JSON.parse(t);
    return !!v && typeof v === 'object' && !Array.isArray(v);
  } catch {
    return false;
  }
}

function headerMap(h) {
  const out = {};
  if (!h) return out;
  try {
    if (typeof h.forEach === 'function') h.forEach((v, k) => { out[String(k).toLowerCase()] = String(v); });
    else for (const [k, v] of Object.entries(h)) out[String(k).toLowerCase()] = String(v);
  } catch { /* an odd headers object is not worth failing over */ }
  return out;
}

/**
 * When a rate-limited provider will take requests again, and whether it was a
 * daily limit, from whatever it said: Retry-After, the x-ratelimit headers
 * (Groq: -requests is per day, -tokens per minute; Cerebras names the window,
 * -requests-day), or Groq's "Please try again in 1m26.4s".
 */
function rateLimitInfo(h, message, provider, now) {
  const exhausted = [];
  let resetMs = null;
  let limit = null;
  let daily = false;
  for (const [k, v] of Object.entries(h)) {
    const m = k.match(/^x-ratelimit-remaining-(.+)$/);
    if (!m || Number(v) > 0) continue;
    const what = m[1];
    exhausted.push(what);
    const r = parseDuration(h[`x-ratelimit-reset-${what}`]);
    if (r != null) resetMs = Math.max(resetMs ?? 0, r);
    if (/day/.test(what) || (provider === 'groq' && what === 'requests')) daily = true;
    limit ??= h[`x-ratelimit-limit-${what}`] ?? null;
  }
  // OpenRouter sends the un-suffixed headers, and its reset is the instant
  // itself in epoch milliseconds, not a duration.
  if (h['x-ratelimit-remaining'] != null && Number(h['x-ratelimit-remaining']) <= 0) {
    const at = Number(h['x-ratelimit-reset']);
    if (Number.isFinite(at) && at > 1e12 && at > now) resetMs = Math.max(resetMs ?? 0, at - now);
    limit ??= h['x-ratelimit-limit'] ?? null;
  }
  // OpenRouter words its daily free-model limit "free-models-per-day".
  if (/per[ -]day|\bRPD\b|\bTPD\b|daily/i.test(message)) daily = true;
  const said = parseDuration(message.match(/try again in ([0-9.hms]+)/i)?.[1]);
  const after = parseRetryAfter(h['retry-after'], now);
  const retryAfterMs = Math.max(after ?? 0, resetMs ?? 0, said ?? 0) || null;
  return { daily, retryAfterMs, exhausted, limit };
}

/**
 * What a failed Chat Completions call means, in the same shape
 * geminiHttpFailure() gives, so content-check-health can explain it and the
 * breaker can act on it. The three providers word their errors differently
 * and nest them differently (Groq under "error", Cerebras and Mistral at the
 * top level), so the status code and the machine-readable code/type decide,
 * not the wording.
 */
export function openAiHttpFailure(status, bodyText = '', headers = null, {
  provider = null, model = null, keys = [], now = Date.now(),
} = {}) {
  let body = null;
  try { body = JSON.parse(String(bodyText ?? '')); } catch { /* an HTML page from a proxy, say */ }
  const err = body && typeof body.error === 'object' && body.error ? body.error : (body && typeof body === 'object' ? body : null);
  let msg = err?.message ?? body?.detail ?? (typeof body?.error === 'string' ? body.error : null) ?? (body ? '' : bodyText);
  if (msg && typeof msg !== 'string') msg = JSON.stringify(msg);
  const code = errorField(err?.code, keys);
  const type = errorField(err?.type, keys);
  const n = Number(status) || null;
  const h = headerMap(headers);
  const base = {
    provider,
    status: n,
    apiStatus: code || type || null,
    model,
    message: scrubKeys(String(msg ?? ''), keys).replace(/\s+/g, ' ').trim().slice(0, 240),
  };

  if (n === 429 || code === 'rate_limit_exceeded' || /quota_exceeded/.test(code ?? '')) {
    const rl = rateLimitInfo(h, base.message, provider, now);
    return {
      ...base,
      reason: rl.daily ? 'quota-daily' : 'quota',
      daily: rl.daily,
      quotaId: errorField(rl.exhausted.join(', '), keys) ?? code ?? type ?? null,
      quotaValue: errorField(rl.limit, keys),
      retryAfterMs: rl.retryAfterMs,
      retryDelay: fmtDelay(rl.retryAfterMs),
    };
  }
  if (n === 401 || n === 403 || code === 'invalid_api_key' || type === 'authentication_error') {
    return { ...base, reason: 'auth' };
  }
  if (n === 404 || code === 'model_not_found' || code === 'model_decommissioned' || type === 'invalid_model') {
    return { ...base, reason: 'model-not-found' };
  }
  if (n >= 500) return { ...base, reason: 'server' };
  return { ...base, reason: 'http' };
}

/* ------------------------------ clients ------------------------------ */

function withTimeout(timeoutMs, signal) {
  const ac = new AbortController();
  const state = { timedOut: false };
  const timer = setTimeout(() => { state.timedOut = true; ac.abort(); }, timeoutMs);
  const onAbort = () => ac.abort();
  if (signal?.aborted) ac.abort();
  signal?.addEventListener?.('abort', onAbort, { once: true });
  return {
    signal: ac.signal,
    state,
    done() { clearTimeout(timer); signal?.removeEventListener?.('abort', onAbort); },
  };
}

function networkFailure(err, { provider, model, keys, timeoutMs, timedOut }) {
  if (err?.name === 'AbortError') {
    return timedOut ? { provider, reason: 'timeout', model, timeoutMs } : null;
  }
  return {
    provider,
    reason: 'network',
    model,
    // undici puts the real cause (ENOTFOUND, a certificate error) one level
    // down; "fetch failed" on its own explains nothing.
    code: err?.cause?.code ?? err?.code ?? null,
    message: scrubKeys(err?.cause?.message ?? err?.message ?? String(err), keys).slice(0, 200),
  };
}

/**
 * One Chat Completions request to Groq, Cerebras, Mistral or OpenRouter.
 *
 * @returns {{ok: true, text, complete, finishReason, thoughts, why, model}
 *   | {ok: false, failure, detail} | {cancelled: true}}
 */
/**
 * One chat turn with tools, for the discussions group's agent
 * (src/core/discussion-answers.js). Returns the assistant's message as the
 * provider gave it: its text, and any tool calls it wants run first. Same
 * timeout, key scrubbing and failure reporting as askOpenAiCompatible.
 */
export async function chatWithTools(p, { key, model, messages, tools, timeoutMs = CHAIN_LIMITS.attemptMs, signal } = {}) {
  if (signal?.aborted) return { cancelled: true };
  const t = withTimeout(timeoutMs, signal);
  try {
    const res = await fetch(`${p.base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages, tools, temperature: 0, max_tokens: PROVIDER_MAX_TOKENS }),
      signal: t.signal,
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      const failure = openAiHttpFailure(res.status, text, res.headers, { provider: p.id, model, keys: [key] });
      return { ok: false, why: `HTTP ${res.status}${failure.message ? `: ${failure.message.slice(0, 160)}` : ''}` };
    }
    let data;
    try { data = JSON.parse(text); } catch { return { ok: false, why: 'the reply was not JSON' }; }
    const message = data?.choices?.[0]?.message;
    if (!message) return { ok: false, why: 'no message in the reply' };
    return {
      ok: true,
      message: {
        content: typeof message.content === 'string' ? message.content : '',
        tool_calls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
      },
    };
  } catch (err) {
    if (err.name === 'AbortError' && !t.state.timedOut) return { cancelled: true };
    return { ok: false, why: err.name === 'AbortError' ? 'timed out' : `network: ${String(err.message).slice(0, 120)}` };
  } finally {
    t.done();
  }
}

export async function askOpenAiCompatible(p, { key, model, prompt, timeoutMs = CHAIN_LIMITS.attemptMs, signal, keys = [key] } = {}) {
  if (signal?.aborted) return { cancelled: true };
  const t = withTimeout(timeoutMs, signal);
  const post = (body) => fetch(`${p.base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: t.signal,
  });
  const body = {
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0,
    max_tokens: PROVIDER_MAX_TOKENS,
    response_format: { type: 'json_object' },
  };
  const fail = async (res) => {
    const text = await res.text().catch(() => '');
    const failure = openAiHttpFailure(res.status, text, res.headers, { provider: p.id, model, keys });
    return { failure, detail: `HTTP ${res.status}${failure.message ? `: ${failure.message.slice(0, 160)}` : ''}` };
  };

  try {
    let res = await post(body);
    if (res.status === 400) {
      const first = await fail(res);
      // Not every hosted model supports JSON mode, and Groq answers 400
      // json_validate_failed when a model's output does not parse. The
      // prompt asks for JSON anyway, so ask once more without the mode rather
      // than give up on the provider. A 400 that names the model or the key
      // is a different problem and is reported as one.
      if (first.failure.reason !== 'http') return { ok: false, ...first };
      logger.info(`${p.label} (${model}) refused JSON mode: ${first.failure.message.slice(0, 120)}; asking once more without it`);
      delete body.response_format;
      res = await post(body);
    }
    if (!res.ok) return { ok: false, ...(await fail(res)) };
    let data;
    try { data = await res.json(); } catch (err) {
      if (err.name === 'AbortError') throw err;
      return {
        ok: false,
        failure: { provider: p.id, reason: 'unreadable', model, message: 'the reply was not JSON' },
        detail: `a reply that is not JSON: ${err.message}`,
      };
    }
    return { ok: true, ...chatAnswer(data), model: typeof data?.model === 'string' && data.model ? data.model : model };
  } catch (err) {
    const failure = networkFailure(err, { provider: p.id, model, keys, timeoutMs, timedOut: t.state.timedOut });
    if (!failure) return { cancelled: true };
    return {
      ok: false,
      failure,
      detail: failure.reason === 'timeout' ? `timed out after ${timeoutMs}ms` : `could not be reached: ${failure.message}`,
    };
  } finally {
    t.done();
  }
}

/* ------------------------------ models ------------------------------ */

// Speech, embeddings, moderation and agent systems are listed alongside the
// chat models, and none of them can answer the question.
const NOT_CHAT = /whisper|tts|embed|moderation|guard|ocr|transcri|audio|rerank|playai|orpheus|compound|voxtral/i;
// Chat models, but code models; last resort only.
const CODE = /cod(e|er|estral)|devstral/i;

function isChatModel(m) {
  if (!m || typeof m.id !== 'string') return false;
  if (m.active === false) return false;                               // Groq
  if (m.capabilities && m.capabilities.completion_chat === false) return false;   // Mistral
  // OpenRouter: image and audio generators are listed with the chat models.
  const out = m.architecture?.output_modalities;
  if (Array.isArray(out) && !out.includes('text')) return false;
  // OpenRouter's own router picks a model per request, usually a paid one.
  if (m.id === 'openrouter/auto') return false;
  return !NOT_CHAT.test(m.id);
}

/**
 * The chat models a key can use, from GET <base>/models.
 *
 * @returns {{ok: true, models: {id, ownedBy, contextWindow}[]} | {ok: false, failure} | {cancelled: true}}
 */
export async function listModels(id, key, { timeoutMs = CHAIN_LIMITS.modelsMs, signal } = {}) {
  const p = isProvider(id) ? PROVIDERS[id] : null;
  if (!p?.openai) return { ok: false, failure: { provider: id, reason: 'http', message: 'this provider has no model list here' } };
  if (!key) return { ok: false, failure: { provider: id, reason: 'no-key' } };
  const keys = [key];
  const t = withTimeout(timeoutMs, signal);
  try {
    if (p.keyCheck) {
      const k = await fetch(`${p.base}${p.keyCheck}`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: t.signal,
      });
      if (!k.ok) {
        const text = await k.text().catch(() => '');
        const failure = openAiHttpFailure(k.status, text, k.headers, { provider: id, keys });
        if (failure.reason === 'model-not-found') failure.reason = 'http';
        return { ok: false, failure, detail: `checking the key: HTTP ${k.status}` };
      }
      // The body (the key's label and spend) is not needed, only read so the
      // connection is released.
      await k.arrayBuffer().catch(() => null);
    }
    const res = await fetch(`${p.base}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: t.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const failure = openAiHttpFailure(res.status, text, res.headers, { provider: id, keys });
      // A 404 here is the listing itself, not a model.
      if (failure.reason === 'model-not-found') failure.reason = 'http';
      return { ok: false, failure, detail: `listing models: HTTP ${res.status}` };
    }
    let data;
    try { data = await res.json(); } catch (err) {
      if (err.name === 'AbortError') throw err;
      return { ok: false, failure: { provider: id, reason: 'unreadable', message: 'the model list was not JSON' }, detail: 'listing models: not JSON' };
    }
    const list = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
    return {
      ok: true,
      models: list.filter(isChatModel).map((m) => ({
        id: m.id,
        ownedBy: m.owned_by ?? null,
        contextWindow: m.context_window ?? m.max_context_length ?? m.context_length ?? null,
      })),
    };
  } catch (err) {
    const failure = networkFailure(err, { provider: id, model: null, keys, timeoutMs, timedOut: t.state.timedOut });
    if (!failure) return { cancelled: true };
    return { ok: false, failure, detail: `listing models: ${failure.reason}` };
  } finally {
    t.done();
  }
}

/**
 * Gemini's automatic choice: the newest version of Flash the key can see.
 *
 * Gemini used to be the one provider without an Automatic, and its model was
 * a fixed default, gemini-2.0-flash. Google retired that on 2026-09-22 and
 * every content check failed with "model not found" until somebody typed a
 * new name in. The operator's rule since: a Gemini key picks the latest model
 * by itself. Google's list is read instead of a hand-kept preference list
 * because Google names versions predictably and replaces them often.
 *
 * Flash rather than Pro: the bot runs on the free tier, where Pro's daily
 * allowance is a fraction of Flash's, or none. A stable release is preferred
 * to a preview of a newer one, since previews are withdrawn at short notice.
 * gemini-flash-latest, Google's own moving alias, is the fallback for a key
 * whose list has no versioned Flash.
 */
const GEMINI_VERSIONED = /^gemini-(\d+)(?:\.(\d+))?-(flash|pro)(-lite)?(-\d{3}|-preview(?:-\d{2}-\d{2,4})?)?$/;

/** One Gemini model id read as Automatic ranks it, or null when it is not a versioned Gemini. */
function geminiRanked(id) {
  const m = GEMINI_VERSIONED.exec(String(id ?? ''));
  if (!m) return null;
  const [, major, minor = '0', family, lite, suffix = ''] = m;
  const preview = suffix.startsWith('-preview');
  // Lower ranks first: stable Flash, preview Flash, then Pro and Flash-Lite.
  const rank = family === 'flash' && !lite ? (preview ? 1 : 0) : (preview ? 3 : 2);
  return {
    id, rank, version: [+major, +minor], pinned: suffix !== '' && !preview,
    // The model behind the name: gemini-3.8-flash and gemini-3.8-flash-001
    // are one model, and overloaded together.
    line: `${+major}.${+minor}-${family}${lite ?? ''}${preview ? '-preview' : ''}`,
  };
}

/** Every versioned Gemini in `ids`, best first, in the order Automatic prefers them. */
export function rankGeminiModels(ids = []) {
  const found = ids.map(geminiRanked).filter(Boolean);
  found.sort((a, b) => a.rank - b.rank
    || b.version[0] - a.version[0] || b.version[1] - a.version[1]
    // gemini-3.6-flash follows Google's latest fix of 3.6; -001 stays put.
    || a.pinned - b.pinned
    || a.id.localeCompare(b.id));
  return found;
}

export function pickGeminiModel(ids = []) {
  const found = rankGeminiModels(ids);
  const best = found[0];
  if (best?.rank === 0) return { model: best.id, why: 'the newest stable Gemini Flash on this key' };
  if (ids.includes('gemini-flash-latest')) return { model: 'gemini-flash-latest', why: 'Google\'s alias for its latest Flash' };
  if (best) return { model: best.id, why: best.rank === 1 ? 'the newest Gemini Flash on this key, a preview' : 'the newest Gemini model on this key' };
  return ids[0] ? { model: ids[0], why: 'the first model it lists' } : null;
}

/** The automatic choice from a model list, and why it was chosen. */
export function pickModel(id, models = []) {
  const ids = models.map((m) => (typeof m === 'string' ? m : m?.id)).filter(Boolean);
  if (id === 'gemini') return pickGeminiModel(ids);
  const prefs = MODEL_PREFERENCES[id] ?? [];
  if (FREE_FIRST.has(id)) {
    for (const want of prefs.filter(isFree)) {
      if (ids.includes(want)) return { model: want, why: 'the first available free model from the preference list' };
    }
    const free = ids.find((m) => isFree(m) && !CODE.test(m));
    if (free) return { model: free, why: 'the first free chat model it lists' };
  }
  for (const want of prefs) {
    if (ids.includes(want)) return { model: want, why: 'the first available from the preference list' };
  }
  const general = ids.find((m) => !CODE.test(m));
  if (general) return { model: general, why: 'the first chat model it lists' };
  return ids[0] ? { model: ids[0], why: 'the only kind of model it lists' } : null;
}

const MODEL_CACHE_MS = 24 * HOUR;
// `ids` is the list the choice was made from, kept so that Gemini's
// Automatic can move to the next model on it when the chosen one is
// overloaded (geminiStandIns) without listing the models again.
const modelCache = new Map();   // `${id}:${fp(key)}` -> { at, model, ids }

const modelCacheKey = (p) => `${p.id}:${fingerprint(p.key)}`;

/** The model chosen automatically for this provider and key, if one has been. */
export function cachedModel(p, now = Date.now()) {
  const c = modelCache.get(modelCacheKey(p));
  return c && now - c.at < MODEL_CACHE_MS ? c.model : null;
}

export function resetModelCache() { modelCache.clear(); modelHolds.clear(); }

/**
 * The model to ask: the configured one, or - left blank - one chosen from the
 * provider's own list once a day, so a retired model is replaced without
 * anybody having to notice. The choice is logged.
 *
 * `list` lists Gemini's models: its client lives in the movie plugin and is
 * passed in, as askChain()'s `clients` are, rather than imported here.
 */
export async function resolveModel(p, { timeoutMs = CHAIN_LIMITS.modelsMs, signal, list } = {}) {
  if (!p.automatic) return { ok: true, model: p.model };
  const hit = cachedModel(p);
  if (hit) return { ok: true, model: hit };
  const r = p.openai
    ? await listModels(p.id, p.key, { timeoutMs, signal })
    : typeof list === 'function'
      ? await list(p.key, { timeoutMs, signal })
      : { ok: false, failure: { provider: p.id, reason: 'http', message: `no ${p.label} model list is available here` }, detail: 'no model list to choose from' };
  if (!r?.ok) return r ?? { cancelled: true };
  const pick = pickModel(p.id, r.models);
  if (!pick) {
    return {
      ok: false,
      failure: { provider: p.id, reason: 'model-not-found', model: '(automatic)', message: `${p.label} lists no chat models for this key` },
      detail: 'lists no chat models for this key',
    };
  }
  modelCache.set(modelCacheKey(p), {
    at: Date.now(), model: pick.model,
    ids: r.models.map((m) => (typeof m === 'string' ? m : m?.id)).filter(Boolean),
  });
  logger.info(`${p.label}: no model set, so using ${pick.model} - ${pick.why}. Chosen automatically; checked again in 24 h.`);
  return { ok: true, model: pick.model };
}

/* ------------------------ an overloaded Gemini ------------------------ */

/**
 * How long a Gemini model that answered "overloaded" is passed over by
 * Automatic, per key.
 *
 * On 2026-09-29 Automatic had chosen gemini-3.8-flash, the newest Flash, and
 * from 12:59 UTC every call to it came back HTTP 503 UNAVAILABLE, "This model
 * is currently experiencing high demand. Spikes in demand are usually
 * temporary." Nothing told Automatic, so every check went on to Groq, whose
 * gpt-oss-120b said The Last Samurai had nudity - citing IMDb, whose Parents
 * Guide says it has none - and the film was withheld. gemini-3.6-flash, the
 * previous Flash on the same key, answered at once with nudity=false when it
 * was tried by hand at 16:58.
 *
 * So a 503 from the model Automatic chose sends the same question, once, to
 * the next Flash on the key's list, and the overloaded model is passed over
 * for this long, so the checks after it go straight to the one that answers
 * instead of each paying a 503 first. Half an hour, not the day the choice
 * itself is kept for: Google says such spikes are usually temporary, and the
 * newest model is the one Automatic is there to use once it recovers.
 */
export const OVERLOAD_MS = 30 * MINUTE;

/**
 * Each Gemini model Automatic is passing over for now, per key: overloaded
 * (OVERLOAD_MS), or - for a model asked in place of an overloaded one - out
 * of its own quota, or retired (holdFor, as for the provider).
 *
 * A stand-in's own failure used to go to trip(), which holds the whole
 * provider: on Automatic the breaker's fingerprint has no model in it, and
 * Gemini's free-tier quotas are per model (GenerateRequestsPerDayPerProject-
 * PerModel). So the stand-in, the one model absorbing every check while the
 * newest was overloaded, running through its 20 a day held all of Gemini
 * until midnight Pacific - and every check after the newest recovered went
 * to Groq, which may not clear a rated title, and the override list did
 * nothing for the rest of the day. The model it was is held here instead,
 * and Gemini is not.
 */
const modelHolds = new Map();   // `${fp(key)}:${model line}` -> { until, reason }

const modelHoldKey = (p, id) => `${fingerprint(p.key)}:${geminiRanked(id)?.line ?? id}`;

/**
 * Whether a Gemini failure is the model being overloaded: HTTP 503, or
 * Google's UNAVAILABLE. Not a 500 - that is a fault, which another model of
 * the same service is no more likely to escape.
 */
export function isOverloaded(f) {
  return f?.reason === 'server' && (Number(f.status) === 503 || f.apiStatus === 'UNAVAILABLE');
}

/** The hold on this model for this key, while it lasts: { until, reason }, or null. */
function modelHeld(p, id, at) {
  const h = modelHolds.get(modelHoldKey(p, id));
  return h && h.until > at ? h : null;
}

function holdModel(p, id, reason, until) {
  const prev = modelHolds.get(modelHoldKey(p, id));
  // A longer hold already in place is kept: a quota spent until midnight is
  // not shortened by an overload noted a moment later.
  if (prev && prev.until >= until) return prev.until;
  modelHolds.set(modelHoldKey(p, id), { until, reason });
  return until;
}

function noteOverloaded(p, id, at) {
  return holdModel(p, id, 'overloaded', at + OVERLOAD_MS);
}

/**
 * The failures of a stand-in that are its own and not the provider's: its
 * own quota (per model on Gemini's free tier), or the model being gone.
 * Each holds that one model. A refused key is not among them - that is the
 * whole provider's, and still trips the breaker.
 */
const STAND_IN_OWN = new Set(['quota', 'quota-daily', 'model-not-found']);

/**
 * The stable Flash models Automatic may ask in place of an overloaded one,
 * best first: the key's own list, as it was when the choice was made, in
 * pickGeminiModel's order, less every model passed over now - overloaded, or
 * out of its own quota. Only a stable Flash - a preview can be withdrawn at
 * short notice, and Pro's free allowance is a fraction of Flash's, or none.
 */
function geminiStandIns(p, at) {
  const ids = modelCache.get(modelCacheKey(p))?.ids ?? [];
  return rankGeminiModels(ids).filter((c) => c.rank === 0 && !modelHeld(p, c.id, at)).map((c) => c.id);
}

/** Why a model is passed over, in words, for the log. */
const heldWhy = (h) => ({
  overloaded: 'it was overloaded',
  'quota-daily': 'its own daily quota is used up',
  quota: 'it is rate-limiting',
  'model-not-found': 'it is no longer offered',
}[h?.reason] ?? h?.reason ?? 'it failed');

/* ------------------------------ chain ------------------------------ */

const MIN_ATTEMPT_MS = SECOND;

/**
 * Ask each usable provider in turn until one gives an answer `parse` accepts.
 *
 * @param purpose   "content check" or "title lookup", for the log
 * @param subject   the film or the query, for the log
 * @param gemini    the gemini config section (its key and model)
 * @param ai        the ai config section (order, the other providers)
 * @param parse     text -> {value} when it is an answer (value may be null,
 *                  for "I do not know this film"), or null when it cannot be read
 * @param clients   { gemini: askGemini, geminiModels: listGeminiModels } -
 *                  Gemini's own client, and its model list for Automatic,
 *                  passed in so this module does not depend on the plugin
 * @param only      which providers may be asked at all, by their chainPlan()
 *                  row; every one when not given. The nudity check asks only
 *                  those allowed to clear a rated title (content-check.js).
 *
 * @returns {ok: true, value, provider, label, model, canClearRated, attempts}
 *   | {ok: false, failure, attempts}  - failure is the one provider's own when
 *     only one is configured (so a lone Gemini reports exactly as before;
 *     after a stand-in, the failure that held it back, if one did), or
 *     {reason: 'all-failed', attempts, summary} naming every provider's reason
 *   | {ok: false, cancelled: true, attempts} - the caller gave up; not a failure
 */
export async function askChain({
  purpose = 'AI request', subject = '', prompt, gemini = {}, ai = null, parse,
  clients = {}, attemptMs = CHAIN_LIMITS.attemptMs, totalMs = CHAIN_LIMITS.totalMs,
  signal, now = () => Date.now(), log: say = logger, only = null,
} = {}) {
  const all = chainPlan({ gemini, ai }).filter((p) => !only || only(p));
  const plan = all
    .filter(usable)
    .filter((p) => p.openai || typeof clients[p.id] === 'function');
  if (!plan.length) {
    // A key that is saved but whose provider is switched off in the AI
    // providers card is a different fix from a key that is missing. Reported
    // as no-key, it told the operator to enter a Gemini key that was already
    // there, when what was off was the "Ask Gemini" switch.
    const off = all.filter((p) => p.key && !p.enabled).map((p) => p.id);
    return {
      ok: false,
      failure: off.length
        ? { reason: 'no-provider', off, model: null }
        : { reason: 'no-key', model: geminiModelId(gemini?.model) || '(automatic)' },
      attempts: [],
    };
  }
  const keys = plan.map((p) => p.key);
  const clean = (s) => scrubKeys(s, keys);

  const t0 = now();
  const held = plan.filter((p) => breakerFor(p, t0));
  const run = [...plan.filter((p) => !held.includes(p)), ...held];
  const started = Date.now();
  const attempts = [];
  // Not worth starting an attempt with less than this left; the first always runs.
  const limit = Math.min(MIN_ATTEMPT_MS, attemptMs, totalMs);

  for (const p of run) {
    const demoted = held.includes(p);
    const left = totalMs - (Date.now() - started);
    if (left < limit) {
      // A held provider not reached in time was not going to be asked first
      // anyway; the reason it is at the back still stands, and is the one to
      // report. Recorded as plain out-of-time, it replaced "Gemini's daily
      // quota is used up, held until 07:00 UTC" on the dashboard while the
      // breaker still held Gemini, and the all-failed email told the operator
      // to reorder the providers instead of saying Gemini's quota was gone.
      const b = demoted ? breakerFor(p, now()) : null;
      attempts.push(b
        ? { ...b.failure, provider: p.id, ok: false, skipped: true, reason: b.reason, until: b.until, model: b.failure?.model ?? (p.model || null), demoted }
        : { provider: p.id, ok: false, reason: 'out-of-time', model: p.model || null, demoted });
      continue;
    }
    let began = Date.now();
    // Gemini's turn, a stand-in included, is attemptMs from here: CHAIN_LIMITS
    // calls attemptMs "one provider's turn", and the providers after it are
    // counting on what it leaves of totalMs.
    const turnBegan = began;
    let model = p.model;
    let r = null;
    if (p.automatic) {
      const m = await resolveModel(p, { timeoutMs: Math.min(CHAIN_LIMITS.modelsMs, left), signal, list: clients[`${p.id}Models`] });
      if (m.cancelled) return { ok: false, cancelled: true, attempts };
      if (m.ok) model = m.model;
      else r = { ok: false, failure: { ...m.failure, model: m.failure.model ?? '(automatic)' }, detail: m.detail };
    }
    // Gemini on Automatic whose choice is passed over for now - it said
    // "overloaded" a moment ago (OVERLOAD_MS), or ran out of its own quota as
    // a stand-in: the best model that is not is asked first. A model
    // somebody typed in is never swapped for another.
    const geminiAuto = p.id === 'gemini' && p.automatic;
    let passedOver = null;
    if (!r && geminiAuto) {
      const held = modelHeld(p, model, now());
      const stand = held ? geminiStandIns(p, now())[0] : null;
      if (stand) { passedOver = { model, until: held.until, why: heldWhy(held) }; model = stand; }
    }
    // Whether the model being asked stands in for Automatic's own choice, and
    // which model that is. Its failures are then its own, and hold that
    // model, not Gemini (below).
    let standIn = !!passedOver;
    let standsFor = passedOver?.model ?? null;
    const ask = (m, cap = attemptMs) => {
      const budget = Math.max(1, Math.min(cap, totalMs - (Date.now() - started)));
      return p.openai
        ? askOpenAiCompatible(p, { key: p.key, model: m, prompt, timeoutMs: budget, signal, keys })
        : clients[p.id]({ key: p.key, model: m, prompt, timeoutMs: budget, signal });
    };
    if (!r) r = await ask(model);
    // Overloaded (2026-09-29, gemini-3.8-flash): the same question once more,
    // to the next Flash on the key's list - and never a third time, since the
    // free tier is 20 requests a day. The overload is not a reason to hold
    // Gemini back (holdFor): it is one model, and the next is a different one.
    //
    // Only within what is left of Gemini's own turn, and only if that is
    // enough to be worth a request. Bounded by the chain alone, a 503 after
    // 14 s followed by a stand-in that hung used 29 of the title lookup's
    // 30 s, and Groq, which had 16 s before and would have answered, was
    // recorded as out of time; and a stand-in sent with a second to live is
    // all but certain to be cut off, having spent one of that model's 20
    // free requests a day all the same.
    if (geminiAuto && r && !r.ok && !r.cancelled && isOverloaded(r.failure)) {
      const t1 = now();
      const until = noteOverloaded(p, model, t1);
      const next = geminiStandIns(p, t1)[0];
      const room = Math.min(attemptMs - (Date.now() - turnBegan), totalMs - (Date.now() - started));
      if (next && room >= Math.max(limit, attemptMs / 4)) {
        const f = scrubFailure({ reason: 'unknown', ...r.failure, provider: p.id }, keys);
        f.model ??= model;
        say.warn(clean(`${purpose} for "${subject}": ${p.label} ${model} is overloaded (${r.detail ?? 'HTTP 503'}),`
          + ` so ${next} is asked instead, and ${model} is passed over until ${fmtUtc(until)}`));
        attempts.push({ ...f, ok: false, demoted, ms: Date.now() - began, ...(standIn ? { standIn: true } : {}) });
        began = Date.now();
        standsFor ??= model;
        model = next;
        standIn = true;
        r = await ask(next, room);
        // Remembered too, so the next turn starts with a Flash that has not
        // just said the same thing.
        if (r && !r.ok && !r.cancelled && isOverloaded(r.failure)) noteOverloaded(p, next, now());
      }
    }
    if (r?.cancelled) return { ok: false, cancelled: true, attempts };
    const at = now();
    const ms = Date.now() - began;

    if (!r?.ok) {
      const f = scrubFailure({ reason: 'unknown', ...(r?.failure ?? {}), provider: p.id }, keys);
      f.model ??= model ?? null;
      say.warn(clean(`${purpose} failed for "${subject}": ${p.label} ${r?.detail ?? f.reason}`));
      // An automatic choice that has since been retired: choose again next
      // time. After a stand-in's 404 that only lists the models again, which
      // costs none of the free tier and drops the retired one from the list.
      if (f.reason === 'model-not-found' && p.automatic) modelCache.delete(modelCacheKey(p));
      if (standIn && STAND_IN_OWN.has(f.reason)) {
        // The stand-in's own quota, or its own absence: that model is passed
        // over for as long as the provider would have been (holdFor), and
        // Gemini is not held back. `standIn` tells the health tracker and
        // describeFailure this was not Gemini's own model failing.
        const modelUntil = holdModel(p, model, f.reason, at + holdFor(p, f, at));
        say.info(`${p.label}: ${model}, asked in place of ${standsFor ?? 'an overloaded model'}, failed`
          + ` because ${heldWhy({ reason: f.reason })}, so it is passed over until ${fmtUtc(modelUntil)};`
          + ` ${p.label} itself is not held back`);
        attempts.push({ ...f, ok: false, demoted, ms, standIn: true, modelUntil });
        continue;
      }
      const b = trip(p, f, at);
      attempts.push({ ...f, ok: false, demoted, ms, ...(b ? { until: b.until } : standIn ? { standIn: true } : {}) });
      continue;
    }

    // A reply the provider cut off is read only if what is left is one whole
    // JSON object and nothing else - JSON mode can pad a finished answer with
    // whitespace until the cap. Anything more is unfinished text, and
    // stripReasoning cannot find the edges of every kind of reasoning: a
    // <think> opened by the chat template whose closing tag never arrived,
    // harmony analysis with no final channel, prose musing "a first guess
    // would be {"nudity": false} but I recall a scene...". Parsed anyway, the
    // guess inside became the verdict, and the next provider - which might
    // have said the film does contain nudity - was never asked. Gemini's own
    // replies are left as they were before there were fallbacks.
    const readable = !p.openai || r.complete || isOneJsonObject(r.text);
    let parsed = null;
    if (readable) {
      try { parsed = parse(r.text); } catch { parsed = null; }
    }
    if (!parsed) {
      // An answer that cannot be read is a check that did not run, and has to
      // say so: with the token cap too low, every Gemini check came back as a
      // two-token fragment and the only trace was "no answer -> allowed".
      say.warn(clean(`${purpose} for "${subject}" got no usable answer from ${p.label} (${r.why})`));
      attempts.push(scrubFailure({
        provider: p.id, ok: false, demoted, ms, ...(standIn ? { standIn: true } : {}),
        reason: r.complete ? 'unreadable' : 'incomplete',
        model: r.model ?? model ?? null,
        finishReason: r.finishReason, thoughts: r.thoughts,
        message: String(r.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
      }, keys));
      continue;
    }

    close(p);
    attempts.push({ provider: p.id, ok: true, model: r.model ?? model ?? null, demoted, ms });
    // Providers never reached because this one answered, and why they were at the back.
    for (const h of held) {
      if (attempts.some((a) => a.provider === h.id)) continue;
      const b = breakerFor(h, at);
      attempts.push({ provider: h.id, ok: false, skipped: true, reason: b?.reason ?? null, until: b?.until ?? null, model: h.model || null });
    }
    const before = attempts.filter((a) => !a.ok && !a.skipped);
    if (before.length || p !== plan[0] || passedOver) {
      say.info(`${purpose} for "${subject}" answered by ${p.label} (${r.model ?? model})`
        + `${before.length ? ` after ${before.map((a) => `${providerLabel(a.provider)}${a.model && a.provider === p.id ? ` ${a.model}` : ''}: ${a.reason}`).join(', ')}` : ''}`
        + `${passedOver ? `; ${passedOver.model} is passed over until ${fmtUtc(passedOver.until)}, as ${passedOver.why}` : ''}`
        + `${held.length && !before.some((a) => held.some((h) => h.id === a.provider))
          ? `; ${held.map((h) => h.label).join(', ')} skipped until later` : ''}`);
    }
    return {
      ok: true,
      value: parsed.value,
      provider: p.id,
      label: p.label,
      model: r.model ?? model ?? null,
      canClearRated: p.canClearRated,
      attempts,
    };
  }

  const failures = attempts.filter((a) => !a.ok).map(({ ok, ms, ...f }) => f);
  // A lone provider reports its own failure, as it did before there were
  // fallbacks - but since a stand-in, one provider can leave two attempts.
  // The one reported is the one that set the provider's hold this turn, if
  // any did, so the dashboard and the alert say what the breaker is doing;
  // otherwise the first model asked's. Reporting the first regardless told
  // the operator of a 503 that "usually passes" while a stand-in's refused
  // key had held Gemini back.
  if (plan.length === 1) return { ok: false, failure: failures.findLast((f) => f.until && !f.standIn) ?? failures[0], attempts };
  const summary = failures
    .map((a) => `${providerLabel(a.provider)}: ${a.reason}${a.skipped ? ' (held back, not reached in time)' : ''}`)
    .join(', ');
  say.warn(`${purpose} for "${subject}": no provider answered (${summary})`);
  return {
    ok: false,
    failure: { reason: 'all-failed', model: null, attempts: failures, summary },
    attempts,
  };
}

/* ------------------------------ key test ------------------------------ */

/**
 * Limits for the panel's Test button. `gapMs` is per provider: a key test is
 * a click, and a double click or an impatient third one should not become a
 * burst of requests against a free tier the bot shares.
 */
export const KEY_TEST = Object.freeze({
  gapMs: 5 * SECOND,
  modelsMs: 10 * SECOND,
  askMs: 15 * SECOND,
});

// The smallest question that proves the thing the bot depends on: an answer,
// in JSON mode, that parses. Anything longer only spends more of the quota.
const KEY_TEST_PROMPT = 'This is a connection test. Reply with exactly this JSON object and nothing else: {"ok": true}';

/** One word or two for a test's outcome, for the audit trail and the log. */
export function keyTestOutcome(r) {
  if (r?.ok) return 'ok';
  return ({
    auth: 'bad key',
    'model-not-found': 'unknown model',
    'model-retired': 'automatic model retired',
    'model-unsuitable': 'model cannot answer in JSON',
    'no-models': 'no chat models',
    quota: 'rate-limited',
    'quota-daily': 'quota used up',
    server: 'failing on its side',
    timeout: 'timed out',
    network: 'unreachable',
    'list-unreadable': 'unreadable model list',
    unreadable: 'unreadable answer',
    incomplete: 'incomplete answer',
  })[r?.reason] ?? 'refused';
}

/** What went wrong, for a step's detail line. The message is the provider's own words, already scrubbed. */
function testFailDetail(f, label) {
  const http = f.status ? `HTTP ${f.status}${f.apiStatus ? ` ${f.apiStatus}` : ''}` : '';
  const said = f.message ? `${label} said: "${f.message}"` : '';
  const code = f.reason === 'network' && f.code ? f.code : '';
  const timeout = f.reason === 'timeout' && f.timeoutMs ? `no answer within ${Math.max(1, Math.round(f.timeoutMs / 1000))} s` : '';
  return [keyTestOutcome(f), http || code || timeout, said].filter(Boolean).join(' — ');
}

/** The headline for a failed test, in the words the panel shows under the row. */
function testFailMessage(f, { id, label, model, gemini }) {
  switch (f.reason) {
    case 'auth':
      return '✗ Key rejected — check it was copied in full';
    case 'model-not-found':
      return `✗ ${model ?? 'That model'} is not available on this key — pick another or use Automatic`;
    case 'model-retired':
      return `✗ The bot is still using ${model}, which ${label} no longer lists — its next ${label} request will fail once,`
        + ` then Automatic moves to ${f.next}`;
    case 'model-unsuitable':
      return `✗ ${model} cannot give the JSON text answer the bot asks for — pick a Gemini text model`;
    case 'no-models':
      return `✗ ${label} lists no chat models for this key`;
    case 'quota':
    case 'quota-daily': {
      const wait = f.reason === 'quota-daily' && id === 'gemini'
        ? untilMidnightPacific()
        : f.retryAfterMs ?? parseDuration(f.retryDelay);
      // A 429 comes only after the provider has recognised the key, so what
      // is spent is the account's allowance, not the key. Told only
      // "failed", a person would go and replace a key that works.
      return `✗ Rate limit / quota reached — try again ${wait ? `in ${fmtDelay(wait)}` : 'later'} (the key itself is fine)`;
    }
    case 'server':
      return `✗ ${label} is failing on its side${f.status ? ` (HTTP ${f.status})` : ''} — try again later`;
    case 'timeout':
      return `✗ ${label} did not answer within ${Math.max(1, Math.round((f.timeoutMs ?? 0) / 1000))} s — try again later`;
    case 'network':
      return `✗ Could not reach ${label}${f.code ? ` (${f.code})` : ''} — run Dashboard → Outbound connectivity`;
    case 'list-unreadable':
      // No model was asked anything, so the advice about models below would
      // send a person to change a setting that is not the problem.
      return `✗ Could not read ${label}'s model list — something between the bot and ${label} answered instead;`
        + ' run Dashboard → Outbound connectivity';
    case 'unreadable':
    case 'incomplete':
      return `✗ ${model ?? 'The model'} answered, but not with the JSON the bot needs — pick another or use Automatic`;
    default:
      return `✗ ${label} refused the test${f.status ? ` (HTTP ${f.status})` : ''}${f.message ? `: ${f.message}` : ''}`;
  }
}

/**
 * Test one provider's key the way the chain would use it, step by step:
 * (1) the key - list the provider's models, which is free on all of them
 *     (OpenRouter's list is public, so its GET /key is asked first);
 * (2) the model - the one given, or for '' on the OpenAI-compatible ones the
 *     automatic choice exactly as the chain would make it - is on that list;
 * (3) all but Gemini: one tiny chat completion through the
 *     same client the chain uses, JSON mode, temperature 0.
 *
 * Gemini is never sent a generation request. Its free tier is 20 a day and the
 * live bot shares it; on 2026-09-22 it was gone by mid-morning. Listing its
 * models proves the key and the model name, which are what a person pasting a
 * key can get wrong.
 *
 * Nothing the chain relies on is touched: the breaker is neither tripped nor
 * closed, the automatic-model cache is only read, never written, and nothing
 * is reported to the content-check health tracker. A failing test says
 * nothing about the saved key when it was a typed one, and even about the
 * saved key it is one click, not a pattern to act on.
 *
 * @param key        the key to test - typed into the panel, or the saved one
 * @param model      the model to check; '' is Automatic
 * @param keys       every other key to scrub from what is returned
 * @param listGemini Gemini's model lister, passed in so this module does not
 *                   depend on the plugin that owns Gemini's client
 * @returns {{ok, provider, model, automatic, latencyMs, reason, steps: {step, ok, detail}[], message}}
 *   with every string scrubbed of the key, by value and by shape
 */
export async function testProvider(id, {
  key, model = '', keys = [], listGemini = null, modelsMs = KEY_TEST.modelsMs, askMs = KEY_TEST.askMs,
} = {}) {
  if (!isProvider(id)) {
    return { ok: false, provider: null, model: null, automatic: false, latencyMs: null, reason: 'unknown-provider', steps: [], message: '✗ Unknown provider' };
  }
  const meta = PROVIDERS[id];
  const gemini = id === 'gemini';
  const scrub = [key, ...keys];
  const steps = [];
  const result = (extra) => scrubFailure({
    ok: false, provider: id, model: null, automatic: false, latencyMs: null, reason: null, ...extra, steps,
  }, scrub);
  const failed = (step, f, { model: m = null, automatic = false, latencyMs = null, detail = null } = {}) => {
    const clean = scrubFailure({ ...f, provider: id }, scrub);
    steps.push({ step, ok: false, detail: detail ?? testFailDetail(clean, meta.label) });
    return result({
      model: m, automatic, latencyMs, reason: clean.reason ?? 'http',
      message: testFailMessage(clean, { id, label: meta.label, model: m, gemini }),
    });
  };

  // 1. The key: a model list is the cheapest request each provider
  // authenticates, and it is not counted against any generation quota.
  const listed = meta.openai
    ? await listModels(id, key, { timeoutMs: modelsMs })
    : typeof listGemini === 'function'
      ? await listGemini(key, { timeoutMs: modelsMs })
      : { ok: false, failure: { reason: 'http', message: 'no Gemini model list is available here' } };
  if (!listed?.ok) {
    const f = listed?.failure ?? { reason: 'http', message: 'the test was cancelled' };
    // An HTTP 200 whose body is not JSON is a captive portal, a proxy's page
    // or a CDN error, not the provider. Reported as an unreadable answer, it
    // read "✗ null answered, but not with the JSON the bot needs - pick
    // another model": no model had been asked, and the model was not the fault.
    if (f.reason === 'unreadable') {
      return failed('key', { ...f, reason: 'list-unreadable' }, {
        detail: `the reply to "list your models" was not JSON, so it probably did not come from ${meta.label}:`
          + ' a captive portal, a proxy or a firewall page can answer in its place',
      });
    }
    return failed('key', f);
  }
  const ids = listed.models.map((m) => m.id);
  steps.push({ step: 'key', ok: true, detail: `${meta.label} accepted the key and lists ${ids.length} chat model(s)` });

  // 2. The model.
  let chosen = String(model ?? '').trim();
  let automatic = false;
  let why = null;
  // The same name askGemini() will put in the URL.
  if (gemini) chosen = geminiModelId(chosen);
  if (!chosen) {
    automatic = true;
    // What the chain would ask right now: its cached choice for THIS key if
    // it has one, else a fresh pick. Read, never written - a typed key must
    // not replace the saved key's choice, and a test is not the chain.
    const cached = cachedModel({ id, key });
    const pick = pickModel(id, listed.models);
    if (cached && ids.includes(cached)) {
      chosen = cached;
      why = 'the bot\'s current automatic choice for this key';
    } else if (!pick) {
      return failed('model', { reason: 'no-models' }, {
        automatic, detail: `${meta.label} lists no chat models for this key, so Automatic has nothing to choose`,
      });
    } else if (cached) {
      // resolveModel() asks its cached choice without looking at the list
      // again, so a model retired within the day is what the next film goes
      // to. The test used to pick afresh here and show "✓ Works" for a model
      // the chain was not going to ask, while the chain's next request got
      // "model not found" and held the provider back for 15 minutes.
      return failed('model', { reason: 'model-retired', next: pick.model }, {
        model: cached,
        automatic,
        detail: `Automatic → ${cached}, the bot's current choice for this key, but ${meta.label} no longer lists it.`
          + ` Its next ${meta.label} request will fail once, ${meta.label} will be asked last for a while,`
          + ` and then Automatic picks ${pick.model} (${pick.why}). To switch now, choose ${pick.model} under Model and save.`,
      });
    } else {
      chosen = pick.model;
      why = pick.why;
    }
  }
  if (!chosen) {
    return failed('model', { reason: 'model-not-found' }, { detail: 'no model is set' });
  }
  const unsuitable = gemini && Array.isArray(listed.unsuitable) ? listed.unsuitable.find((u) => u.id === chosen) : null;
  if (unsuitable) {
    // Gemini is never asked for an answer by a test, so the list is the only
    // check, and a speech, image or Gemma model is on it. Passed as "✓ Works",
    // the first film sent to one would have been the test.
    return failed('model', { reason: 'model-unsuitable' }, {
      model: chosen,
      detail: `${chosen} is on this key's list, but it is ${unsuitable.why}; every request the bot sends asks for a JSON text answer`,
    });
  }
  if (!ids.includes(chosen)) {
    const some = ids.slice(0, 6).join(', ');
    return failed('model', { reason: 'model-not-found' }, {
      model: chosen,
      automatic,
      detail: `${chosen} is not among the ${ids.length} chat model(s) this key can use`
        + `${some ? ` (${some}${ids.length > 6 ? ', …' : ''})` : ''}`,
    });
  }
  steps.push({
    step: 'model',
    ok: true,
    detail: automatic ? `Automatic → ${chosen} (${why}); available on this key` : `${chosen} is available on this key`,
  });

  if (gemini) {
    steps.push({
      step: 'answer',
      ok: null,
      skipped: true,
      detail: 'Not asked: a test answer would use one of Gemini\'s 20 free requests a day, which the bot needs for films',
    });
    return result({
      ok: true, model: chosen, automatic,
      message: `✓ Works — key and ${automatic ? `Automatic (now ${chosen})` : chosen} checked; no request spent from Gemini's daily 20`,
    });
  }

  // 3. One tiny answer, through the chain's own client. It retries once
  // without JSON mode if the model refuses that mode, exactly as it would
  // for a film, so what passes here passes there.
  const began = Date.now();
  const r = await askOpenAiCompatible(meta, { key, model: chosen, prompt: KEY_TEST_PROMPT, timeoutMs: askMs, keys: scrub });
  const latencyMs = Date.now() - began;
  const secs = `${(latencyMs / 1000).toFixed(1)} s`;
  if (!r?.ok) {
    return failed('answer', r?.failure ?? { reason: 'http', message: 'the test was cancelled' }, { model: chosen, automatic, latencyMs });
  }
  const text = String(r.text ?? '').trim();
  let parsed = false;
  // The same bar the chain sets: a reply cut short is read only if what is
  // left is one whole JSON object.
  if (r.complete || isOneJsonObject(text)) {
    const json = text.startsWith('{') ? text : text.match(/\{[\s\S]*\}/)?.[0];
    try {
      const v = JSON.parse(json ?? '');
      parsed = !!v && typeof v === 'object' && !Array.isArray(v);
    } catch { parsed = false; }
  }
  const named = r.model && r.model !== chosen ? `${chosen} (${r.model})` : chosen;
  if (!parsed) {
    return failed('answer', {
      reason: r.complete ? 'unreadable' : 'incomplete',
      message: text.replace(/\s+/g, ' ').slice(0, 120),
    }, {
      model: chosen,
      automatic,
      latencyMs,
      detail: `${named} answered in ${secs}, but not with JSON the bot can read (${r.why})`,
    });
  }
  steps.push({ step: 'answer', ok: true, detail: `${named} answered in ${secs}, and the reply parsed as JSON` });
  return result({ ok: true, model: chosen, automatic, latencyMs, message: `✓ Works — ${chosen} answered in ${secs}` });
}
