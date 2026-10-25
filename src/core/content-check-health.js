/**
 * Notice when the nudity check keeps failing, and tell someone.
 *
 * checkNudity() returning null is the designed fail-safe: decide() then falls
 * back to the rating, so a Gemini outage can never open a gate. Since the
 * operator's rule of 2026-09-29, "No, AI only helps", the check is asked only
 * to clear a title its rating blocks, so an outage sends nothing it would
 * have stopped: it refuses, on their rating, titles it would have cleared.
 * It also makes an outage invisible. On 2026-09-22 the check did not run all morning, for
 * three different reasons in turn - the model was retired (HTTP 404), then its
 * replies were cut off by the token cap, then the free tier's 20-a-day quota
 * ran out (HTTP 429) - and every film in that time was judged on its letter
 * grade alone. The only trace was one warn line per film. Nobody was told.
 *
 * So this counts. A few failures in a row, or several inside half an hour,
 * opens an incident: one log line, one audit entry, one email that names the
 * reason and what to do about it, and a "degraded" flag the panel shows. A
 * DIFFERENT reason inside the same incident is a different fix, so it gets its
 * own email; the same reason does not repeat until the check has worked again.
 * The next success closes the incident, and if anybody was emailed about it
 * they are told it is working again.
 *
 * The rule under all of the email is that the inbox's last word must match
 * what the check is doing. A "working again" note is owed whenever the reader
 * was last told it was failing, and once they have been told it works, the
 * next failure is news and is never swallowed by a throttle.
 *
 * The exception to "the next success closes it" is a check that fails on and
 * off. If a success has already come between the failures in the window, one
 * more proves nothing, so the incident stays open until those failures age
 * out - and it then closes on its own if the last check worked, rather than
 * waiting for the next film, which can be hours away.
 *
 * A well-formed "I do not recognise this film" is the check working, and is
 * counted as a success. Only a check that could not run counts against it.
 *
 * With fallback providers (src/core/ai-providers.js) the check has failed only
 * when every provider did; a Gemini that has used its free tier for the day
 * while Groq answers is the check working, and raises nothing. What it does
 * get is a line on the dashboard - which provider answered last, and that
 * Gemini is being asked last until midnight Pacific - because a film judged by
 * a fallback is judged under a stricter rule, and the operator should be able
 * to see that without reading the log.
 */
import { EventEmitter } from 'node:events';
import log from '../util/logger.js';
import {
  PROVIDERS, providerLabel, scrubKeys, scrubFailure, configuredKeys, chainPlan, usable, untilMidnightPacific, isProvider,
} from './ai-providers.js';

// Gemini's quota resets at midnight Pacific; this used to live here, and the
// tests and the wording below still reach it through this module.
export { untilMidnightPacific };

const logger = log.scope('content-check');

/** Overridable under gemini.contentCheckAlert in config. */
export const ALERT_DEFAULTS = {
  // Low traffic is the normal case here - a handful of films a day - so three
  // in a row can already be an hour of films going out unchecked.
  afterFailuresInARow: 3,
  // Catches a check that fails on and off (Gemini overloaded, say), which the
  // in-a-row count never reaches because the odd success keeps resetting it.
  failuresWithin: 5,
  windowMinutes: 30,
  // Per reason, and only while the reader's last word is that this reason is
  // failing: the backstop for an outage that closed without a "working again"
  // note getting through, and then opened again the same way. A relapse after
  // "working again" is always mailed; see _email.
  throttleMinutes: 360,
};

// The films shown in the panel and in a failure email, most recent first.
const KEEP_TITLES = 5;
// The films the "working again" note lists. It is the one list the reader is
// given of films that went out unchecked, so it is not cut to the five a
// dashboard card has room for; a morning-long outage at 20 checks a day fits.
const KEEP_UNCHECKED = 50;
const KEEP_RECENT = 20;

/* ------------------------------- wording ------------------------------ */

/**
 * "Sep 22, 09:14" in New York, where the rest of the bot measures its days - on
 * the 24-hour clock, like every time the bot and the panel show. hourCycle,
 * not hour12: false, which writes the hour after midnight as 24.
 */
export function fmtTime(ts) {
  if (!ts) return 'unknown';
  return `${new Date(ts).toLocaleString('en-US', {
    timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  })} New York time`;
}

function fmtSpan(ms) {
  const mins = Math.max(0, Math.round(ms / 60_000));
  if (mins < 1) return 'under a minute';
  const h = Math.floor(mins / 60), m = mins % 60;
  return h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`;
}

const SETTINGS_MODEL = 'Settings → API keys & logins 🔑 → Gemini → Model';
const SETTINGS_KEY = 'Settings → API keys & logins 🔑 → Gemini API key';

/**
 * A failure from checkNudity() in words: a headline for a subject line or the
 * panel, the facts, and what to do. Every reason the check can fail for has a
 * different fix, which is the whole reason for telling them apart.
 */
export function describeFailure(f = {}, { now = Date.now() } = {}) {
  if (f.reason === 'all-failed') return describeAllFailed(f, { now });
  if (f.standIn) return describeStandIn(f, { now });
  if (f.reason === 'out-of-time' || (f.provider && f.provider !== 'gemini')) return describeProviderFailure(f, { now });
  const http = f.status ? `HTTP ${f.status}${f.apiStatus ? ` ${f.apiStatus}` : ''}` : '';
  const said = f.message ? ` Gemini said: "${f.message}"` : '';
  switch (f.reason) {
    case 'quota-daily':
      return {
        headline: 'Gemini\'s daily quota is used up',
        detail: `Gemini refused the check with ${http || 'HTTP 429'}: quota ${f.quotaId ?? '(not named)'}`
          + `${f.quotaValue ? `, limit ${f.quotaValue} requests a day` : ''}`
          + `${f.model ? `, model ${f.model}` : ''}.`
          + ` Daily quotas reset at midnight Pacific time, in about ${fmtSpan(untilMidnightPacific(now))}.`,
        advice: 'Every check until then will fail the same way. The film lookup uses the same key and'
          + ' model, so it spends the same quota. If this keeps happening, the free tier is too small'
          + ' for the traffic: enable billing on the Google Cloud project behind the key, or switch on'
          + ` a fallback provider in ${SETTINGS_PROVIDERS}, which is asked while Gemini is out.`,
      };
    case 'quota':
      return {
        headline: 'Gemini is rate-limiting the check',
        detail: `Gemini refused the check with ${http || 'HTTP 429'}`
          + `${f.quotaId ? `: quota ${f.quotaId}` : ''}${f.quotaValue ? `, limit ${f.quotaValue}` : ''}`
          + `${f.retryDelay ? `. It asked for a retry after ${f.retryDelay}` : ''}.${said}`,
        advice: 'A short-term limit usually clears within a minute or two. If it keeps happening,'
          + ' requests are arriving faster than the key\'s tier allows.',
      };
    case 'model-not-found':
      return {
        headline: `Gemini has no model called "${f.model ?? '(none set)'}"`,
        detail: `Gemini answered ${http || 'HTTP 404'} for the model "${f.model ?? '(none set)'}". Models are retired`
          + ' without much notice - gemini-2.0-flash went this way on 2026-09-22.',
        advice: `Pick a current model in ${SETTINGS_MODEL}, then dry-run a request on the Test tab to confirm.`,
      };
    case 'auth':
      return {
        headline: 'Gemini refused the API key',
        detail: `Gemini answered ${http || 'with an authorisation error'}.${said}`,
        advice: `Check the key in ${SETTINGS_KEY}. If every key in Settings looks blank, MASTER_KEY in`
          + ' .env does not match the saved settings.',
      };
    case 'no-key':
      return {
        headline: 'the content check is on, but there is no Gemini API key',
        detail: 'The nudity check is switched on in Settings, but the Gemini key is empty and no fallback'
          + ' provider is switched on with a key of its own, so no film is being checked.',
        advice: `Enter the key in ${SETTINGS_KEY}, or switch on a provider in ${SETTINGS_PROVIDERS}.`
          + ' If every key in Settings looks blank, MASTER_KEY in .env does not match the saved settings.',
      };
    case 'no-provider': {
      // Keys are saved, but every provider that has one is switched off in
      // the AI providers card. Told "there is no Gemini API key", the
      // operator was sent to enter a key that was already there.
      const off = (Array.isArray(f.off) ? f.off : []).filter(isProvider);
      const names = off.map(providerLabel);
      const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
      const switches = off.map((id) => (id === 'gemini' ? '"Ask Gemini"' : `"Ask ${providerLabel(id)}"`));
      return {
        headline: 'the content check is on, but every AI provider with a key is switched off',
        detail: `The nudity check is switched on in Settings, and ${list ?? 'a provider'} ${names.length > 1 ? 'have' : 'has'}`
          + ` a key saved, but ${names.length > 1 ? 'they are' : 'it is'} switched off in ${SETTINGS_PROVIDERS},`
          + ' so no film is being checked. The film lookup is not running either.',
        advice: `Tick ${switches.length ? switches.join(' or ') : 'a provider'} in ${SETTINGS_PROVIDERS} and save.`,
      };
    }
    case 'timeout':
      return {
        headline: `Gemini did not answer within ${Math.round((f.timeoutMs ?? 20000) / 1000)} seconds`,
        detail: `The check gave up waiting for ${f.model ?? 'the model'}.`,
        advice: 'Usually a slow patch on Google\'s side that passes. If it persists, run Dashboard →'
          + ' Outbound connectivity to rule out this box\'s own connection.',
      };
    case 'incomplete':
      return {
        headline: `Gemini's answers are coming back incomplete (finishReason ${f.finishReason ?? 'unknown'})`,
        detail: `The reply stopped before the answer was finished: finishReason ${f.finishReason ?? 'unknown'},`
          + ` ${f.thoughts ?? 0} thinking tokens${f.model ? `, model ${f.model}` : ''}.`,
        advice: f.finishReason === 'MAX_TOKENS'
          ? 'The model ran out of output room, most likely spent on thinking. GEMINI_MAX_OUTPUT_TOKENS in'
            + ' src/plugins/movie-requests/gemini.js is the ceiling; it was raised to 2048 when this happened'
            + ' on 2026-09-22, and a model that thinks harder may need more.'
          : 'Gemini stopped without answering. If it is a safety block it may be this particular film;'
            + ' if it is every film, try another model.',
      };
    case 'unreadable':
      return {
        headline: 'Gemini is answering, but not in the form the check asks for',
        detail: `The reply finished normally but was not the JSON the check asks for.${f.message ? ` It began: "${f.message}"` : ''}`,
        advice: `The model may not follow instructions well enough for this; try another in ${SETTINGS_MODEL}.`,
      };
    case 'server':
      return {
        headline: `Gemini is failing on Google's side (${http})`,
        detail: `Gemini answered ${http}.${said}`,
        advice: 'Nothing to change here; it usually clears on its own.',
      };
    case 'network':
      return {
        headline: `the bot cannot reach Gemini${f.code ? ` (${f.code})` : ''}`,
        detail: `The request never got an answer: ${f.message ?? 'no detail'}.`,
        advice: 'Run Dashboard → Outbound connectivity. On this network an untrusted, intercepted TLS'
          + ' certificate is the usual cause, not Google.',
      };
    default:
      return {
        headline: `Gemini refused the check${http ? ` (${http})` : ''}`,
        detail: `${http ? `Gemini answered ${http}.` : 'The check failed.'}${said}`,
        advice: 'The log attached has the full line.',
      };
  }
}

const SETTINGS_PROVIDERS = 'Settings → API keys & logins 🔑 → AI providers';

/**
 * A model Automatic asked in place of its own overloaded choice failed
 * (askChain, `standIn`). That is the stand-in's own trouble - Gemini's
 * free-tier quotas are per model - so it is named, and Gemini is not said to
 * be out: on 2026-09-29 a stand-in's used-up daily quota read as "Gemini's
 * daily quota is used up" while Gemini's own model was back and answering.
 */
function describeStandIn(f = {}, { now = Date.now() } = {}) {
  const own = describeFailure({ ...f, standIn: false }, { now });
  const who = `${providerLabel(f.provider ?? 'gemini')}'s stand-in model ${f.model ?? '(unknown)'}`;
  const what = {
    'quota-daily': 'has used up its own daily quota',
    quota: 'is rate-limiting',
    'model-not-found': 'is no longer offered',
  }[f.reason];
  return {
    headline: what ? `${who} ${what}` : `${who}: ${own.headline}`,
    detail: `Automatic's own choice was overloaded, so ${f.model ?? 'another model'} was asked in its place. ${own.detail}`
      + `${f.modelUntil && f.modelUntil > now ? ` It is passed over until ${fmtTime(f.modelUntil)};` : ''}`
      + ` ${providerLabel(f.provider ?? 'gemini')} itself is not held back.`,
    advice: 'Nothing to change: the next Flash on the key\'s list stands in meanwhile, and Automatic\'s own'
      + ' choice is asked again once its overload has passed.',
  };
}

/**
 * The same, for Groq, Cerebras and Mistral - and for a provider that was never
 * asked because the ones before it used up the time. The fixes differ from
 * Gemini's (another model from the provider's own list; a key from its own
 * console), and a fallback failing is less urgent while another answers.
 */
function describeProviderFailure(f = {}, { now = Date.now() } = {}) {
  const who = providerLabel(f.provider);
  const where = `${SETTINGS_PROVIDERS} → ${who}`;
  const http = f.status ? `HTTP ${f.status}${f.apiStatus ? ` ${f.apiStatus}` : ''}` : '';
  const said = f.message ? ` ${who} said: "${f.message}"` : '';
  const model = f.model ? `, model ${f.model}` : '';
  const held = f.until && f.until > now ? ` It is asked last until ${fmtTime(f.until)}.` : '';
  switch (f.reason) {
    case 'quota-daily':
      return {
        headline: `${who}'s daily limit is used up`,
        detail: `${who} refused the check with ${http || 'HTTP 429'}`
          + `${f.quotaId ? ` (${f.quotaId} exhausted${f.quotaValue ? `, limit ${f.quotaValue}` : ''})` : ''}${model}.`
          + `${f.retryDelay ? ` It resets in about ${f.retryDelay}.` : ''}${held}`,
        advice: 'The other providers are asked in the meantime. If every one of them runs dry on an ordinary'
          + ` day, add another provider in ${SETTINGS_PROVIDERS}, or move to a paid tier.`,
      };
    case 'quota':
      return {
        headline: `${who} is rate-limiting the check`,
        detail: `${who} refused the check with ${http || 'HTTP 429'}${f.quotaId ? ` (${f.quotaId})` : ''}${model}.`
          + `${f.retryDelay ? ` It asked for a retry after ${f.retryDelay}.` : ''}${held}${said}`,
        advice: 'A short-term limit that usually clears within a minute; the other providers are asked meanwhile.',
      };
    case 'model-not-found':
      return {
        headline: `${who} has no model called "${f.model ?? '(none set)'}"`,
        detail: `${who} answered ${http || 'HTTP 404'} for the model "${f.model ?? '(none set)'}".${said}`,
        advice: `Pick another in ${where} → Model, or leave it on Automatic so a current one is chosen from`
          + ` ${who}'s own list.`,
      };
    case 'auth':
      return {
        headline: `${who} refused the API key`,
        detail: `${who} answered ${http || 'with an authorisation error'}.${said}`,
        advice: `Check the key in ${where}`
          + `${PROVIDERS[f.provider]?.console ? ` (keys are made at ${PROVIDERS[f.provider].console})` : ''}.`
          + ' If every key in Settings looks blank, MASTER_KEY in .env does not match the saved settings.',
      };
    case 'timeout':
      return {
        headline: `${who} did not answer within ${Math.round((f.timeoutMs ?? 20000) / 1000)} seconds`,
        detail: `The check gave up waiting for ${f.model ?? 'the model'}.`,
        advice: 'Usually a slow patch on the provider\'s side that passes; the next provider is asked meanwhile.',
      };
    case 'incomplete':
      return {
        headline: `${who}'s answers are coming back incomplete (finish_reason ${f.finishReason ?? 'unknown'})`,
        detail: `The reply stopped before the answer was finished: finish_reason ${f.finishReason ?? 'unknown'},`
          + ` ${f.thoughts ?? 0} reasoning tokens${model}.`,
        advice: f.finishReason === 'length'
          ? 'The model ran out of output room, most likely spent reasoning. PROVIDER_MAX_TOKENS in'
            + ' src/core/ai-providers.js is the ceiling; a model that does not reason at length avoids it.'
          : `The model stopped without answering. If it is every film, try another model in ${where}.`,
      };
    case 'unreadable':
      return {
        headline: `${who} is answering, but not in the form the check asks for`,
        detail: `The reply finished normally but was not the JSON the check asks for.${f.message ? ` It began: "${f.message}"` : ''}`,
        advice: `The model may not follow instructions well enough for this; try another in ${where} → Model.`,
      };
    case 'server':
      return {
        headline: `${who} is failing on its side (${http})`,
        detail: `${who} answered ${http}.${said}`,
        advice: 'Nothing to change here; it usually clears on its own, and the next provider is asked meanwhile.',
      };
    case 'network':
      return {
        headline: `the bot cannot reach ${who}${f.code ? ` (${f.code})` : ''}`,
        detail: `The request never got an answer: ${f.message ?? 'no detail'}.`,
        advice: 'Run Dashboard → Outbound connectivity. On this network an untrusted, intercepted TLS'
          + ' certificate is the usual cause.',
      };
    case 'out-of-time':
      return {
        headline: `${who} was not asked: the check ran out of time`,
        detail: 'The providers before it used up the time allowed for one check.',
        advice: `Put the provider that answers most reliably first in ${SETTINGS_PROVIDERS}, or switch off one`
          + ' that keeps timing out.',
      };
    default:
      return {
        headline: `${who} refused the check${http ? ` (${http})` : ''}`,
        detail: `${http ? `${who} answered ${http}.` : 'The check failed.'}${said}`,
        advice: 'The log attached has the full line.',
      };
  }
}

/**
 * Every provider failed. Each gets its own line, because each has its own fix;
 * an alert naming only the first would leave the reader fixing Gemini's quota
 * while Groq's key was the thing actually wrong.
 */
function describeAllFailed(f = {}, { now = Date.now() } = {}) {
  const each = (f.attempts ?? []).map((a) => ({ who: providerLabel(a.provider), d: describeFailure(a, { now }) }));
  if (!each.length) {
    return {
      headline: 'no AI provider could run the check',
      detail: 'None of them answered.',
      advice: 'The log attached has the full lines.',
    };
  }
  return {
    headline: `no AI provider could run the check: ${each.map(({ d }) => d.headline).join('; ')}`,
    detail: each.map(({ who, d }) => `${who}: ${d.detail}`).join('\n'),
    advice: [...new Set(each.map(({ who, d }) => `${who}: ${d.advice}`))].join('\n'),
  };
}

/**
 * What an email about a failure is filed under, so that each different fix is
 * mailed once per incident. For a single provider that is its reason, as it
 * always was. For the whole chain failing it is each provider's own reason:
 * filed under "all-failed" alone, the first email named Groq's bad key and
 * Mistral's unknown model, and when Groq's key was fixed and Groq then ran out
 * of quota and Mistral started refusing its key, nothing more was sent.
 *
 * "Not reached in time" is left out: it says nothing about that provider,
 * only that the ones before it were slow, which their own reasons already say.
 */
export function alertKeys(f = {}) {
  if (f.reason !== 'all-failed') return [f.reason ?? 'unknown'];
  const keys = [...new Set((Array.isArray(f.attempts) ? f.attempts : [])
    .filter((a) => a?.reason && a.reason !== 'out-of-time')
    .map((a) => `all-failed:${a.provider ?? 'gemini'}=${a.reason}`))];
  return keys.length ? keys : ['all-failed'];
}

/** Take out every configured key, and anything shaped like a Google, Groq or Cerebras key. */
function scrub(text, keys) {
  return scrubKeys(text, keys);
}

function filmLine(e) {
  const name = `${e.title ?? '(no title)'}${e.year ? ` (${e.year})` : ''}`;
  const where = e.source === 'dry run' ? ' - a dry run in the panel, nothing was sent' : '';
  return `  - ${name}, ${fmtTime(e.at)}${where}`;
}

/* ------------------------------- tracker ------------------------------ */

function freshState() {
  return {
    consecutive: 0,
    streakSince: null,
    window: [],               // timestamps of failures inside the window
    recent: [],               // the last few failures, newest first
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailure: null,
    incident: null,
    lastIncident: null,
    // What the inbox last said, so the next email can be decided by it: when
    // each reason was last mailed as failing, and when "working again" went.
    mailedAt: {},
    toldWorkingAt: null,
    // Per provider: how its last attempt went, and until when it is asked
    // last. Shown on the AI providers card and behind the dashboard's
    // "using Groq until ..." line.
    providers: {},
    lastAnswer: null,          // { provider, model, at } of the last check that worked
  };
}

export class ContentCheckHealth extends EventEmitter {
  /**
   * @param alerts      the AlertWatcher; notify() is how mail leaves
   * @param configStore for the thresholds, the email switch, and the key to scrub
   * @param stateStore  so an incident survives a restart: without it, a
   *                    restart mid-outage would forget it had already emailed,
   *                    and the dashboard would read healthy until three more
   *                    films had gone out unchecked
   */
  constructor({ alerts = null, configStore = null, stateStore = null, now = () => Date.now() } = {}) {
    super();
    // One listener per open panel tab, over SSE.
    this.setMaxListeners(50);
    this.alerts = alerts;
    this.configStore = configStore;
    this.now = now;
    this.store = stateStore?.namespace?.('content-check') ?? null;
    this.auditStore = stateStore?.namespace?.('audit') ?? null;
    this.state = { ...freshState(), ...(this.store?.get('health', null) ?? {}) };
    // A send that was in flight when the process died never finished; let the
    // next failure try it again rather than waiting on it forever.
    for (const [r, v] of Object.entries(this.state.incident?.raised ?? {})) {
      if (v === 'pending') this.state.incident.raised[r] = 'failed';
    }
    // Failure emails still being handed to the mailer. A success that closes
    // the incident meanwhile has to wait for them, or it cannot know whether
    // anyone was told and would skip the "working again" note.
    this._sending = new Set();
    this._settleTimer = null;
    // Restarted while an on-and-off incident was waiting to age out.
    this._armSettle(this.now());
    // Switching the check on or off changes what the panel should say, and the
    // panel only hears about things that are pushed to it.
    this._enabled = this.enabled;
    configStore?.onChange?.(() => {
      if (this.enabled === this._enabled) return;
      this._enabled = this.enabled;
      this.emit('change', this.snapshot());
    });
  }

  get cfg() { return this.configStore?.get?.() ?? {}; }

  get enabled() {
    const g = this.cfg.gemini ?? {};
    return !!(g.enabled && g.contentCheck);
  }

  get opts() {
    const o = { ...ALERT_DEFAULTS, ...(this.cfg.gemini?.contentCheckAlert ?? {}) };
    const n = (v, d, min) => (Number.isFinite(Number(v)) ? Math.max(min, Number(v)) : d);
    return {
      afterFailuresInARow: n(o.afterFailuresInARow, ALERT_DEFAULTS.afterFailuresInARow, 1),
      failuresWithin: n(o.failuresWithin, ALERT_DEFAULTS.failuresWithin, 1),
      windowMinutes: n(o.windowMinutes, ALERT_DEFAULTS.windowMinutes, 1),
      throttleMinutes: n(o.throttleMinutes, ALERT_DEFAULTS.throttleMinutes, 0),
    };
  }

  _scrub(text) { return scrub(text, configuredKeys(this.cfg)); }

  /**
   * One attempt at the check, as reported by checkNudity's onResult.
   *
   * Resolves once any email has been handed over. The request path does not
   * wait for it - a slow SMTP server must not hold up a film - but tests do.
   */
  async record({
    ok, failure = null, title = null, year = null, source = 'request',
    attempts = null, provider = null, model = null, verdict = null,
  } = {}) {
    const now = this.now();
    const st = this.state;
    const o = this.opts;
    st.window = st.window.filter((t) => now - t < o.windowMinutes * 60_000);
    const pending = [];
    // All of it, not just the message: the failure is saved to state.json as
    // it stands, and a provider's error code once went there unscrubbed.
    const keys = configuredKeys(this.cfg);
    this._noteProviders(scrubFailure(attempts, keys), now);

    if (ok) {
      const prevSuccessAt = st.lastSuccessAt;
      st.consecutive = 0;
      st.streakSince = null;
      st.lastSuccessAt = now;
      // A verdict with no provider on it came from before there were
      // fallbacks, when Gemini was the only thing that could answer.
      st.lastAnswer = { provider: provider ?? verdict?.provider ?? 'gemini', model: model ?? verdict?.model ?? null, at: now };
      // An on-and-off failure is still an incident while the window is full,
      // or every lucky success would close it and the next failure reopen it.
      // But only if it really has been on and off: a success that ends one
      // unbroken run of failures is a fix. Counting the window alone kept the
      // card saying "no model called gemini-2.0-flash" for hours after a dry
      // run had proved the new model worked, because the dry runs made to see
      // the error had filled the window.
      if (st.incident) {
        const flapping = st.window.length >= o.failuresWithin
          && prevSuccessAt != null && prevSuccessAt > st.window[0];
        if (flapping) this._armSettle(now);
        else pending.push(this._recover(now));
      }
    } else {
      clearTimeout(this._settleTimer);
      const f = scrubFailure({ reason: 'unknown', ...(failure ?? {}) }, keys);
      const entry = { at: now, title, year, source, reason: f.reason };
      st.consecutive += 1;
      if (st.consecutive === 1) st.streakSince = now;
      st.window.push(now);
      st.recent = [entry, ...st.recent].slice(0, KEEP_RECENT);
      st.lastFailureAt = now;
      st.lastFailure = f;

      if (st.incident) {
        st.incident.count += 1;
        tally(st.incident, entry);
      } else {
        const inRow = st.consecutive >= o.afterFailuresInARow;
        const inWindow = st.window.length >= o.failuresWithin;
        if (inRow || inWindow) {
          const since = Math.min(inRow ? st.streakSince : Infinity, inWindow ? st.window[0] : Infinity);
          st.incident = {
            since,
            count: Math.max(inRow ? st.consecutive : 0, inWindow ? st.window.length : 0),
            onAndOff: !inRow,
            reasons: {},
            titles: [],
            unchecked: 0,
            raised: {},
          };
          for (const e of st.recent.filter((r) => r.at >= since).reverse()) tally(st.incident, e);
        }
      }

      const inc = st.incident;
      if (inc) {
        const said = alertKeys(f);
        const news = said.filter((k) => !(k in inc.raised));
        const retry = said.filter((k) => inc.raised[k] === 'failed');
        if (news.length) pending.push(this._raise(f, now, news));
        else if (retry.length) pending.push(this._email(f, now, retry));
      }
    }

    this._save();
    this.emit('change', this.snapshot());
    await Promise.all(pending);
  }

  /** `keys` are what the email is filed under; see alertKeys(). */
  async _raise(f, now, keys = alertKeys(f)) {
    const inc = this.state.incident;
    const d = describeFailure(f, { now });
    for (const k of keys) inc.raised[k] = 'pending';
    logger.warn(this._scrub(`the nudity check is not running: ${d.headline}. `
      + `${inc.count} failed check(s) since ${fmtTime(inc.since)}; films are being judged on their rating alone`));
    this._audit('the nudity check stopped working',
      this._scrub(`${d.headline} — ${inc.count} failed check(s) since ${fmtTime(inc.since)}`));
    return this._email(f, now, keys);
  }

  async _email(f, now, keys = alertKeys(f)) {
    const st = this.state;
    const inc = st.incident;
    const mark = (v) => { for (const k of keys) inc.raised[k] = v; };
    if (this.cfg.email?.onContentCheck === false) { mark('not-wanted'); return null; }
    if (!this.alerts?.notify) { mark('no-mailer'); return null; }
    mark('pending');

    const d = describeFailure(f, { now });
    const shown = inc.titles.slice(0, KEEP_TITLES);
    const earlier = (inc.unchecked ?? inc.titles.length) - shown.length;
    const note = [
      `The nudity check has failed ${inc.count} time(s) ${inc.onAndOff ? 'on and off' : 'in a row'}`
        + ` since ${fmtTime(inc.since)}.`,
      'While it is down, every film and episode is sent or refused on its rating alone. The check only'
        + ' ever helps a title its rating blocks through, so nothing it would have stopped goes out - but'
        + ' a rated title it would have cleared is refused.',
      '',
      `What is wrong: ${d.headline}.`,
      d.detail,
      '',
      `What to do: ${d.advice}`,
      '',
      'Most recent films decided on their rating alone:',
      ...(shown.length ? shown.map(filmLine) : ['  (none recorded)']),
      ...(earlier > 0 ? [`  ...and ${earlier} before those; the History tab marks every request among them.`] : []),
      '',
      'The check keeps trying on every request. You will be emailed again if it starts failing for a'
        + ' different reason, and once more when it is working again. The day\'s log is attached.',
    ].join('\n');

    // The throttle is there so the reader is not told the same thing twice.
    // A relapse after "working again" is not the same thing: throttled, it
    // left "working again" as the inbox's last word for six hours while 503s
    // sent films out unchecked. So it only applies while the last thing said
    // about this reason is that it is failing.
    const repeat = keys.every((k) => (st.mailedAt?.[k] ?? -Infinity) > (st.toldWorkingAt ?? -Infinity));
    const send = (async () => this.alerts.notify({
      kind: `content-check-failing:${keys.join(',')}`,
      label: this._scrub(`nudity check not running: ${d.headline}`),
      note: this._scrub(note),
      throttleMinutes: repeat ? this.opts.throttleMinutes : 0,
    }))();
    this._sending.add(send);
    let r;
    try {
      r = await send;
    } catch (err) {
      r = { sent: false, why: err.message };
    } finally {
      this._sending.delete(send);
    }
    // Throttled means this reason was mailed recently, so the reader already
    // knows; email switched off, or on with no account to send through (the
    // default on a new install), will not change on its own. Only a send that
    // actually failed is worth another go on the next failure.
    const outcome = r?.sent ? 'sent'
      : r?.why === 'throttled' ? 'throttled'
        : r?.why === 'email is off' || r?.why === 'email is not set up' ? 'email-off'
          : 'failed';
    mark(outcome);
    if (r?.sent) for (const k of keys) (st.mailedAt ??= {})[k] = this.now();
    if (outcome === 'failed') logger.warn(`could not email about the nudity check: ${r?.why ?? 'unknown'}`);
    this._save();
    return r;
  }

  async _recover(now) {
    const st = this.state;
    const inc = st.incident;
    clearTimeout(this._settleTimer);
    st.incident = null;
    st.lastIncident = { since: inc.since, until: now, count: inc.count, reasons: inc.reasons };
    logger.info(`the nudity check is working again, after ${inc.count} failed check(s) since ${fmtTime(inc.since)}`);
    this._audit('the nudity check is working again',
      `after ${inc.count} failed check(s) since ${fmtTime(inc.since)}`);

    // A failure email still going out has not yet said whether anyone was
    // told. Deciding without it skipped "working again" for an alert that
    // then arrived, so the reader heard "not running" and nothing after. The
    // wait can be long - the day's log rides along on a slow uplink - and if
    // the check has broken again meanwhile, the failure is the true last word.
    if (Object.values(inc.raised).includes('pending')) {
      await Promise.allSettled([...this._sending]);
      if (st.incident) {
        logger.info('the nudity check failed again before its alert had gone; no "working again" note');
        return null;
      }
    }

    // Owed only if the last thing the reader was told is that it is failing.
    // Otherwise it is news about something they were never told about.
    const owed = Object.values(st.mailedAt ?? {}).some((t) => t > (st.toldWorkingAt ?? -Infinity));
    if (!owed || !this.alerts?.notify || this.cfg.email?.onContentCheck === false) return null;

    const answeredAt = st.lastSuccessAt ?? now;
    const listed = inc.titles;
    const more = (inc.unchecked ?? listed.length) - listed.length;
    const note = [
      `The nudity check answered again at ${fmtTime(answeredAt)}, after ${inc.count} failed check(s) since`
        + ` ${fmtTime(inc.since)}.`,
      ...(now - answeredAt > 60_000
        ? ['It had been failing on and off, so this waited until those failures were more than'
          + ` ${this.opts.windowMinutes} minutes old, with nothing failing since.`]
        : []),
      '',
      'These were decided on their rating alone while it was down. The check only helps a title its'
        + ' rating blocks through, so one refused among them may have been cleared; if it matters, ask'
        + ' for it again:',
      ...(listed.length ? listed.map(filmLine) : ['  (none recorded)']),
      ...(more > 0 ? [`  ...and ${more} before those, ${inc.unchecked} in all.`] : []),
      '',
      'Every request among them is also marked "not checked for nudity" on the History tab.',
    ].join('\n');

    // Marked before the send, not after: a failure arriving while this note
    // is still going out must see that the reader is being told it works, or
    // its own email would be throttled and "working again" would land last.
    const before = st.toldWorkingAt;
    st.toldWorkingAt = now;
    let r;
    try {
      r = await this.alerts.notify({
        kind: 'content-check-recovered',
        label: 'the nudity check is working again',
        note: this._scrub(note),
        throttleMinutes: 0,
        attachLog: false,
      });
    } catch (err) {
      r = { sent: false, why: err.message };
    }
    if (!r?.sent) {
      // Nobody was told after all, so the next recovery still owes the note.
      if (st.toldWorkingAt === now) st.toldWorkingAt = before;
      logger.warn(`could not email that the nudity check recovered: ${r?.why ?? 'unknown'}`);
    }
    this._save();
    return r;
  }

  /** The most recent check worked. */
  get _lastCheckWorked() { return this.state.consecutive === 0 && this.state.lastSuccessAt != null; }

  /** When the window will hold too few failures to count as on and off, or null if it already does. */
  _drainsAt(now) {
    const o = this.opts;
    const w = this.state.window.filter((t) => now - t < o.windowMinutes * 60_000);
    if (w.length < o.failuresWithin) return null;
    return w[w.length - o.failuresWithin] + o.windowMinutes * 60_000;
  }

  /**
   * Close an on-and-off incident once its failures have aged out, if the last
   * check worked. Nothing else would: the window only shrinks when a check
   * comes in, and with a handful of films a day the panel would go on saying
   * the check was not running for hours after it had started working.
   */
  _armSettle(now) {
    clearTimeout(this._settleTimer);
    if (!this.state.incident || !this._lastCheckWorked) return;
    const at = this._drainsAt(now) ?? now;
    this._settleTimer = setTimeout(() => {
      this.settle().catch((err) => logger.warn(`content check health: ${err.message}`));
    }, Math.max(1000, at - now + 1000));
    this._settleTimer.unref?.();
  }

  /** Run by the timer above; tests call it after moving their clock on. */
  async settle() {
    const now = this.now();
    const st = this.state;
    if (!st.incident || !this._lastCheckWorked) return null;
    if (this._drainsAt(now) != null) { this._armSettle(now); return null; }
    st.window = st.window.filter((t) => now - t < this.opts.windowMinutes * 60_000);
    const done = this._recover(now);
    this._save();
    this.emit('change', this.snapshot());
    return done;
  }

  /** Fold one check's (or one lookup's) attempts into the per-provider status. */
  _noteProviders(attempts, now) {
    if (!Array.isArray(attempts) || !attempts.length) return false;
    const st = this.state;
    st.providers ??= {};
    // A provider's row is about the provider. A model asked in its place
    // (askChain's `standIn`) failing on its own quota is not Gemini failing,
    // and after the chosen model's own attempt it would overwrite that with
    // "daily limit used up" for a provider nothing is holding back.
    const own = new Set(attempts.filter((a) => a && !a.standIn && !a.skipped).map((a) => a.provider));
    for (const a of attempts) {
      if (!a || !isProvider(a.provider)) continue;
      if (a.standIn && !a.ok && own.has(a.provider)) continue;
      const prev = st.providers[a.provider] ?? {};
      if (a.skipped) {
        // Not asked this time because it is being held back; what it said
        // last still stands, but the time it is held until may have moved.
        st.providers[a.provider] = {
          ...prev,
          ok: false,
          reason: a.reason ?? prev.reason ?? null,
          until: a.until ?? prev.until ?? null,
          headline: a.reason && a.reason !== prev.reason
            ? this._scrub(describeFailure({ provider: a.provider, reason: a.reason, model: a.model }, { now }).headline)
            : prev.headline ?? null,
        };
        continue;
      }
      // Not reached says nothing about the provider itself. Over a provider
      // that is being held back it would hide why, and until when.
      if (a.reason === 'out-of-time' && !prev.ok && prev.until > now) continue;
      st.providers[a.provider] = a.ok
        ? { ok: true, at: now, model: a.model ?? null }
        : {
          ok: false,
          at: now,
          reason: a.reason ?? 'unknown',
          model: a.model ?? null,
          until: a.until ?? null,
          headline: this._scrub(describeFailure(a, { now }).headline),
        };
    }
    return true;
  }

  /**
   * The film lookup's attempts. It spends the same quotas as the nudity
   * check, so the per-provider status has to include it - a Gemini quota used
   * up by lookups is still used up - but a lookup is not a nudity check and
   * is never counted towards an alert.
   */
  noteProviders(attempts) {
    if (!this._noteProviders(scrubFailure(attempts, configuredKeys(this.cfg)), this.now())) return;
    this._save();
    this.emit('change', this.snapshot());
  }

  /** Forget one provider's status: its key or model changed, or someone asked for it to be tried first again. */
  clearProvider(id) {
    if (!isProvider(id) || !this.state.providers?.[id]) return;
    delete this.state.providers[id];
    this._save();
    this.emit('change', this.snapshot());
  }

  /** Each provider in order, with how it last went. Never carries a key: `hasKey` only. */
  _providerRows(now) {
    const st = this.state;
    return chainPlan(this.cfg).map((p) => {
      const s = st.providers?.[p.id] ?? null;
      const held = !!(s && !s.ok && s.until && s.until > now);
      return {
        id: p.id,
        label: p.label,
        enabled: p.enabled,
        hasKey: !!p.key,
        usable: usable(p),
        canClearRated: p.canClearRated,
        state: !usable(p) ? 'off' : held ? 'held' : !s ? 'unknown' : s.ok ? 'ok' : 'failed',
        reason: s && !s.ok ? (s.reason ?? null) : null,
        headline: s && !s.ok ? (s.headline ?? null) : null,
        until: held ? s.until : null,
        at: s?.at ?? null,
        model: s?.model ?? null,
      };
    });
  }

  _audit(action, detail) {
    try {
      this.auditStore?.push('events', {
        ts: this.now(), user: 'content check (automatic)', role: 'system', ip: 'local', action, detail,
      }, 2000);
    } catch { /* the audit log must never break a request */ }
  }

  _save() {
    try { this.store?.set('health', this.state); } catch { /* best effort; the next event saves again */ }
  }

  /** What the panel shows. Never carries the key: every string is scrubbed. */
  snapshot() {
    const st = this.state;
    const now = this.now();
    const last = st.lastFailure ? describeFailure(st.lastFailure, { now }) : null;
    const inc = st.incident;
    const providers = this._providerRows(now);
    const live = providers.filter((p) => p.usable);
    const primary = live[0] ?? null;
    const answered = st.lastAnswer ?? null;
    // The first provider in the order is being held back and another is
    // answering in its place: routine for a free-tier Gemini by mid-morning,
    // so it is a line on the dashboard, not an alert.
    const standIn = answered && primary && answered.provider !== primary.id && answered.at >= (primary.at ?? 0)
      ? live.find((p) => p.id === answered.provider) ?? null
      : null;
    const fallback = primary?.state === 'held' && live.length > 1 ? {
      provider: primary.id,
      label: primary.label,
      reason: primary.reason,
      headline: primary.headline,
      until: primary.until,
      using: standIn?.label ?? null,
      usingMayClearRated: standIn ? standIn.canClearRated : null,
      next: live.filter((p) => p !== primary && p.state !== 'held').map((p) => p.label),
    } : null;
    return {
      enabled: this.enabled,
      degraded: !!inc,
      providers,
      answeredBy: answered ? {
        provider: answered.provider, label: providerLabel(answered.provider), model: answered.model ?? null, at: answered.at,
      } : null,
      fallback,
      consecutive: st.consecutive,
      lastSuccessAt: st.lastSuccessAt,
      lastFailureAt: st.lastFailureAt,
      lastFailure: last ? { reason: st.lastFailure.reason, headline: this._scrub(last.headline) } : null,
      incident: inc ? {
        since: inc.since,
        count: inc.count,
        reason: st.lastFailure?.reason ?? null,
        headline: this._scrub(last?.headline ?? ''),
        advice: this._scrub(last?.advice ?? ''),
        titles: inc.titles.slice(0, KEEP_TITLES).map(({ title, year, at, source }) => ({ title, year, at, source })),
        unchecked: inc.unchecked ?? inc.titles.length,
        // Still open although the last check worked: it has been failing on
        // and off. Said on the card, so it does not read as if the fix just
        // confirmed on the Test tab had not worked.
        lastCheckWorked: this._lastCheckWorked,
        clearsAt: this._lastCheckWorked ? this._drainsAt(now) : null,
      } : null,
    };
  }
}

/** Add one failure to an open incident: per-reason counts, and recent films without repeats. */
function tally(inc, e) {
  inc.reasons[e.reason] = (inc.reasons[e.reason] ?? 0) + 1;
  const same = (t) => t.title === e.title && t.year === e.year;
  if (!inc.titles.some(same)) inc.unchecked = (inc.unchecked ?? inc.titles.length) + 1;
  inc.titles = [e, ...inc.titles.filter((t) => !same(t))].slice(0, KEEP_UNCHECKED);
}
