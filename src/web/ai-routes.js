/**
 * The panel's "AI providers" card: Groq, Cerebras, Mistral and OpenRouter as
 * fallbacks for Gemini, which ran out of its 20-a-day free tier by mid-morning on
 * 2026-09-22 and left every film after that judged on its rating alone.
 *
 * Kept out of PUT /config for two reasons. Saving the card is one auditable
 * action ("changed the AI providers") rather than a line lost in a whole
 * settings save. And a blank key box here means "keep the saved key", which
 * is what someone pasting three keys over a few days expects, whereas the main
 * form clears a secret whose box is emptied.
 *
 * Keys go one way only: into config, where the store encrypts them (they are
 * in SECRET_PATHS). Every response carries MASK in their place, the model list
 * is fetched server-side with the stored key, and nothing here logs, audits or
 * returns a key - scrubKeys() runs over anything a provider said back. The
 * Test button is the one place a key arrives without being saved, and it is
 * used for that one test and then dropped.
 */
import log from '../util/logger.js';
import { MASK } from '../config/store.js';
import { SECRET_PATHS, DEFAULT_CONFIG } from '../config/schema.js';
import { describeConfigChange } from '../util/diff.js';
import {
  PROVIDERS, FALLBACK_IDS, MODEL_PREFERENCES, normaliseOrder, chainPlan, listModels, pickModel,
  cachedModel, resetBreakers, scrubKeys, scrubFailure, configuredKeys, isProvider,
  testProvider, keyTestOutcome, KEY_TEST,
} from '../core/ai-providers.js';
import { describeFailure } from '../core/content-check-health.js';
import { listGeminiModels } from '../plugins/movie-requests/gemini.js';

const logger = log.scope('api');

// A key is one token of URL-safe characters. Anything else pasted into the box
// - a sentence, a line break, "Bearer ..." - is a mistake worth refusing
// before it is encrypted and saved as though it were a key.
const KEY_SHAPE = /^[A-Za-z0-9._\-]{8,300}$/;
const MODEL_SHAPE = /^[A-Za-z0-9._:/\-]{0,200}$/;

export function mountAiRoutes(router, { configStore, guard, audit, contentHealth = null, pluginManager = null }) {
  const keys = () => configuredKeys(configStore.get());

  /** What the card shows. Keys appear only as MASK, or '' when none is saved. */
  function view() {
    const cfg = configStore.get();
    const status = new Map((contentHealth?.snapshot?.()?.providers ?? []).map((p) => [p.id, p]));
    return {
      order: normaliseOrder(cfg.ai?.order),
      lookupOn: !!cfg.gemini?.enabled,
      contentCheckOn: !!(cfg.gemini?.enabled && cfg.gemini?.contentCheck),
      allowCleanRatedFilms: cfg.gemini?.allowCleanRatedFilms === true,
      providers: chainPlan(cfg).map((p) => ({
        id: p.id,
        label: p.label,
        console: PROVIDERS[p.id].console,
        keysUrl: PROVIDERS[p.id].keysUrl,
        enabled: p.enabled,
        apiKey: p.key ? MASK : '',
        // Gemini's model is set in its own card. A blank one means automatic,
        // for Gemini as for the fallbacks.
        model: p.id === 'gemini' ? p.model : String(cfg.ai?.[p.id]?.model ?? ''),
        autoModel: p.automatic && p.key ? cachedModel(p) : null,
        preferences: MODEL_PREFERENCES[p.id] ?? [],
        canClearRated: p.canClearRated,
        // Whether a new install has it ticked. Groq, Cerebras and OpenRouter
        // do since 2026-10-12 (the operator's live settings), and their rows
        // still told the operator to leave it off - against the default and
        // the docs - so the hint is worded by this.
        clearsByDefault: chainPlan(DEFAULT_CONFIG).find((d) => d.id === p.id)?.canClearRated === true,
        status: status.get(p.id) ?? null,
      })),
    };
  }

  router.get('/ai/providers', guard, (req, res) => res.json(view()));

  router.put('/ai/providers', guard, async (req, res) => {
    try {
      const b = req.body ?? {};
      const before = JSON.parse(JSON.stringify(configStore.get()));
      const patch = {};
      if (Array.isArray(b.order)) patch.order = normaliseOrder(b.order.filter((id) => typeof id === 'string'));
      if (b.gemini && typeof b.gemini === 'object') {
        const g = {};
        if (typeof b.gemini.enabled === 'boolean') g.enabled = b.gemini.enabled;
        if (typeof b.gemini.canClearRated === 'boolean') g.canClearRated = b.gemini.canClearRated;
        patch.gemini = g;
      }
      for (const id of FALLBACK_IDS) {
        const x = b[id];
        if (!x || typeof x !== 'object') continue;
        const o = {};
        if (typeof x.enabled === 'boolean') o.enabled = x.enabled;
        if (typeof x.canClearRated === 'boolean') o.canClearRated = x.canClearRated;
        if (typeof x.model === 'string') {
          const m = x.model.trim();
          if (!MODEL_SHAPE.test(m)) return res.status(400).json({ error: `${PROVIDERS[id].label}: that is not a model name` });
          o.model = m;
        }
        if (x.removeKey === true) {
          o.apiKey = '';
        } else if (typeof x.apiKey === 'string') {
          const k = x.apiKey.trim();
          // Blank, or the mask sent back unchanged, keeps the saved key.
          if (k && k !== MASK) {
            if (!KEY_SHAPE.test(k)) {
              // Said without the text itself: it may be a key with junk around it.
              logger.warn(`refused a ${PROVIDERS[id].label} key from ${req.session?.user?.username ?? '?'}: not the shape of an API key`);
              return res.status(400).json({ error: `${PROVIDERS[id].label}: that does not look like an API key — paste the key alone` });
            }
            o.apiKey = k;
          }
        }
        patch[id] = o;
      }

      configStore.update({ ai: patch });
      const after = configStore.get();
      await pluginManager?.notifyConfigChange?.(after);

      // What was learned about a provider no longer applies once its key,
      // model or switch has changed. The breaker notices a new key or model
      // by itself; the panel's status line is cleared here so it does not
      // go on saying "bad key" about a key that has just been replaced.
      for (const id of FALLBACK_IDS) {
        const was = before.ai?.[id] ?? {};
        const now = after.ai?.[id] ?? {};
        if (was.apiKey !== now.apiKey || was.model !== now.model || was.enabled !== now.enabled) {
          contentHealth?.clearProvider?.(id);
        }
      }

      // Secret values are reported as "changed" and never written out.
      const summary = describeConfigChange(before, after, SECRET_PATHS);
      if (summary) audit(req, 'changed the AI providers', summary, res);
      else res.locals.audited = true;
      logger.info(`AI providers updated${summary ? ` — ${summary}` : ' (no effective change)'}`);
      res.json(view());
    } catch (err) {
      res.status(400).json({ error: scrubKeys(err.message, keys()) });
    }
  });

  /**
   * The chat models a provider offers this key, for the model dropdown. Uses
   * the STORED key, so the browser never holds one: a key typed into the card
   * has to be saved first.
   */
  router.get('/ai/providers/:id/models', guard, async (req, res) => {
    const id = req.params.id;
    const p = isProvider(id) ? PROVIDERS[id] : null;
    if (!p?.openai) return res.status(404).json({ ok: false, error: 'no model list for that provider' });
    const key = String(configStore.get().ai?.[id]?.apiKey ?? '');
    if (!key) {
      return res.status(400).json({
        ok: false,
        error: `No ${p.label} key is saved yet. Paste it, press Save AI providers, then load the models.`,
      });
    }
    const r = await listModels(id, key, { timeoutMs: 12_000 });
    if (!r.ok) {
      const f = { ...r.failure, provider: id };
      const d = describeFailure(f);
      logger.warn(scrubKeys(`could not list ${p.label} models: ${d.headline}${f.message ? ` — ${f.message}` : ''}`, keys()));
      return res.status(502).json({
        ok: false,
        reason: f.reason,
        error: scrubKeys(d.headline, keys()),
        advice: scrubKeys(d.advice, keys()),
      });
    }
    const pick = pickModel(id, r.models);
    res.json({
      ok: true,
      provider: id,
      models: r.models.map((m) => ({ id: m.id, ownedBy: m.ownedBy, contextWindow: m.contextWindow })),
      automatic: pick?.model ?? null,
      automaticWhy: pick?.why ?? null,
      preferences: MODEL_PREFERENCES[id] ?? [],
    });
  });

  /**
   * The Test button on each row of the card: does this key work, with this
   * model, the way the chain would use it? See testProvider() for the steps.
   *
   * It tests the key typed into the box when there is one - so a key can be
   * tried before it is saved - and the saved key otherwise. A typed key is
   * used for this one test and dropped: it is not stored, and it never
   * appears in the response, the log or the audit trail, even when the
   * provider quotes it back in an error. The test changes nothing the live
   * chain relies on - no breaker, no status line, no alert, and no cached
   * automatic model - so trying a bad key cannot demote a good saved one.
   *
   * A body `model` of '' is Automatic, as it is when the card is saved; no
   * `model` at all means whatever is saved.
   */
  const lastTest = new Map();   // provider id -> when its last test started
  const testing = new Set();    // provider ids with a test in flight
  router.post('/ai/providers/:id/test', guard, async (req, res) => {
    const id = req.params.id;
    if (!isProvider(id)) return res.status(404).json({ ok: false, error: 'unknown provider' });
    const label = PROVIDERS[id].label;
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const refuse = (status, message, extra = {}) => res.status(status).json({
      ok: false, provider: id, model: null, latencyMs: null, steps: [], message, error: message, ...extra,
    });

    const typedRaw = typeof b.apiKey === 'string' ? b.apiKey.trim() : '';
    const typed = typedRaw && typedRaw !== MASK ? typedRaw : '';
    if (typed && !KEY_SHAPE.test(typed)) {
      // Said without the text itself, as for a save: it may be a key with junk around it.
      logger.warn(`refused to test a ${label} key from ${req.session?.user?.username ?? '?'}: not the shape of an API key`);
      return refuse(400, `✗ That does not look like a ${label} key — paste the key alone`, { reason: 'key-shape' });
    }
    if (b.model != null && typeof b.model !== 'string') return refuse(400, '✗ That is not a model name', { reason: 'model-shape' });
    const asked = typeof b.model === 'string' ? b.model.trim() : null;
    if (asked && !MODEL_SHAPE.test(asked)) return refuse(400, '✗ That is not a model name', { reason: 'model-shape' });

    const cfg = configStore.get();
    const plan = chainPlan(cfg).find((p) => p.id === id);
    const key = typed || plan.key;
    if (!key) {
      return refuse(400, `✗ No ${label} key to test — paste one into the box${id === 'gemini' ? ' in the Gemini card above' : ''}, or save one first`,
        { reason: 'no-key' });
    }
    // A box sent blank is Automatic, as it is when saved - for Gemini too,
    // whose model box used to fall back to a fixed default instead.
    const model = asked ?? (id === 'gemini' ? plan.model : String(cfg.ai?.[id]?.model ?? '').trim());

    const wait = KEY_TEST.gapMs - (Date.now() - (lastTest.get(id) ?? -Infinity));
    if (testing.has(id) || wait > 0) {
      return refuse(429, testing.has(id)
        ? `A ${label} test is already running — wait for its result`
        : `${label} was tested a moment ago — wait ${Math.max(1, Math.ceil(wait / 1000))} s and try again`,
      { reason: 'rate-limited', retryAfterMs: Math.max(0, wait) });
    }
    lastTest.set(id, Date.now());
    testing.add(id);

    const scrub = [key, ...configuredKeys(cfg)];
    const which = typed ? 'a key typed into the panel, not saved' : 'the saved key';
    try {
      const r = await testProvider(id, { key, model, keys: scrub, listGemini: listGeminiModels });
      const out = scrubFailure({ ...r, keySource: typed ? 'typed' : 'saved' }, scrub);
      const outcome = keyTestOutcome(out);
      audit(req, `tested the ${label} key: ${outcome}`, which, res);
      // Info, not warn or error: a test that finds a bad key has done its
      // job, and an error line would email the operator about their own click.
      logger.info(scrubKeys(`${label} key test (${which}): ${out.message}`, scrub));
      res.json(out);
    } catch (err) {
      const message = scrubKeys(`✗ The ${label} test could not run: ${err.message}`, scrub);
      logger.warn(message);
      audit(req, `tested the ${label} key: could not run`, which, res);
      res.status(500).json({ ok: false, provider: id, model: null, latencyMs: null, steps: [], message, error: message });
    } finally {
      testing.delete(id);
    }
  });

  /**
   * Put a held-back provider back in its place now: billing was switched on,
   * say, and waiting for midnight Pacific would waste a day of Gemini.
   */
  router.post('/ai/providers/:id/retry', guard, (req, res) => {
    const id = req.params.id;
    if (!isProvider(id)) return res.status(404).json({ error: 'unknown provider' });
    resetBreakers(id);
    contentHealth?.clearProvider?.(id);
    audit(req, `put ${PROVIDERS[id].label} back in its place in the AI provider order`, null, res);
    logger.info(`${PROVIDERS[id].label} will be asked in its usual place again (reset from the panel)`);
    res.json(view());
  });
}
