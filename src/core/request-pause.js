/**
 * Requests paused from the panel: held with ⏸️, and run in order on resume.
 *
 * The operator (2026-10-01): "add option in panel dash for me as admin to
 * pause processing of requests, in case I don't want requests to process
 * because were testing something but I also don't want to close the bot
 * because I'm also debugging and because locking the group is annoying,
 * instead when I place into pause mode all requests should get a ⏸️
 * reaction. direct links can be excluded I guess because those take
 * milliseconds anyway". Asked what happens to the held ones: "Run them, in
 * order" on resume, kept even through a restart - each handled as if it had
 * just arrived, in arrival order, the ⏸️ giving way to the normal reactions,
 * and nobody has to send theirs again. Asked about the jobs already in hand:
 * "Finish the running ones" - nothing new starts while paused, as with the
 * queue's own Pause, and a film already converting or uploading finishes.
 *
 * WHERE IT BITES. In the movie and TV plugins, at the one point where a
 * message has passed moderation, the prefix rule and the cooldown and would
 * be run as a request - and for a pick from a "which one?" list. There the
 * plugin calls hold() instead: ⏸️ on the message, the message journalled
 * here with what it takes to run it later, and nothing else. Chatter is
 * moderated as ever and never gets ⏸️. The cooldown is asked at intake, as
 * it would be live (🚫 when too soon), and again when the held request runs,
 * which is handled as if it had just arrived: since 2026-10-01 a member's
 * clock starts only when a request of theirs queues something (the
 * operator's rule, src/core/request-cooldown.js), and one of theirs held
 * before it may just have done so on resume. Refused then, it gets 🚫 in
 * place of its ⏸️. A pick from a "which one?" list meets no cooldown, held
 * or not.
 *
 * NOT PAUSED: the beta groups ("we're testing something" is what the pause is
 * for, so $betaNNN tests and $stamtest go on working), the direct-links
 * plugin (its own groups and its own queue), and anything an admin queues
 * from the panel or the box - their call, and it waits in the paused queue.
 *
 * THE QUEUE. Pausing requests pauses the media queue too (nothing new starts;
 * what runs finishes) and remembers that it did; resuming them resumes the
 * queue only if it was this pause that paused it. An admin who pauses or
 * resumes the queue by hand in between has taken it over, and it is left as
 * they set it. The queue's own Pause used to live in memory only, so a
 * restart quietly undid it (found by the main session the same day); it is
 * kept here too, in its own namespace, and put back before any plugin loads.
 *
 * Both live in data/state.json, read when the process starts, before any
 * message is handled:
 *
 *   "request-pause": {
 *     "state": { "paused": true, "since": <ms>, "by": "<who>", "pausedQueue": true },
 *     "held":  [ { "id", "plugin", "kind": "request" | "pick", "at", "msg", ... } ]
 *   },
 *   "queue-pause": { "state": { "paused": true, "since": <ms>, "by": "<who>" } }
 *
 * tools/pause-requests.mjs writes the same shape while the bot is stopped, so
 * it can be started with the pause already in force (docs/operations.md,
 * "Starting and stopping").
 */
import { EventEmitter } from 'node:events';
import log from '../util/logger.js';
import { formatPhone } from './members.js';

const logger = log.scope('request-pause');

export const NAMESPACE = 'request-pause';
export const QUEUE_NAMESPACE = 'queue-pause';
export const PAUSED_EMOJI = '⏸️';

const OFF = Object.freeze({ paused: false, since: null, by: null, pausedQueue: false });
const QUEUE_OFF = Object.freeze({ paused: false, since: null, by: null });

/** The request pause as stored, or "not paused" for anything else. */
export function normalState(v) {
  if (!v || typeof v !== 'object' || v.paused !== true) return { ...OFF };
  return {
    paused: true,
    since: Number.isFinite(v.since) ? v.since : null,
    by: typeof v.by === 'string' && v.by ? v.by : null,
    pausedQueue: v.pausedQueue === true,
  };
}

/** The queue's own pause as stored. */
export function normalQueue(v) {
  if (!v || typeof v !== 'object' || v.paused !== true) return { ...QUEUE_OFF };
  return {
    paused: true,
    since: Number.isFinite(v.since) ? v.since : null,
    by: typeof v.by === 'string' && v.by ? v.by : null,
  };
}

/**
 * Switch requests to paused. Pure, so the panel, the box's command channel
 * and tools/pause-requests.mjs (which edits the file with the bot stopped)
 * all decide it the same way. `queue` is the queue's stored pause: it is
 * paused along with the requests unless it already was, and `pausedQueue`
 * remembers which.
 */
export function switchOn(req, queue, { by, now }) {
  const r = normalState(req);
  const q = normalQueue(queue);
  if (r.paused) return { req: r, queue: q, changed: false, pausedQueue: false };
  const pausedQueue = !q.paused;
  return {
    req: { paused: true, since: now, by: by ?? null, pausedQueue },
    queue: pausedQueue ? { paused: true, since: now, by: by ?? null } : q,
    changed: true,
    pausedQueue,
  };
}

/** Switch requests back on; the queue too, only if switching them off paused it. */
export function switchOff(req, queue) {
  const r = normalState(req);
  const q = normalQueue(queue);
  if (!r.paused) return { req: r, queue: q, changed: false, resumeQueue: false };
  const resumeQueue = r.pausedQueue && q.paused;
  return { req: { ...OFF }, queue: resumeQueue ? { ...QUEUE_OFF } : q, changed: true, resumeQueue };
}

/**
 * What of a message is journalled to run it later: the shape the pick-list
 * journal keeps as list.msg, which is what a pick is replayed from after a
 * restart. The Baileys message itself is not kept (heldMessage).
 */
export function slimMessage(msg) {
  return {
    id: msg.id, key: msg.key ? JSON.parse(JSON.stringify(msg.key)) : null, chatJid: msg.chatJid,
    isGroup: true, fromMe: false,
    senderJid: msg.senderJid ?? null, senderNumber: msg.senderNumber ?? null,
    senderNumberDisplay: msg.senderNumberDisplay ?? null, pushName: msg.pushName ?? null,
    timestamp: msg.timestamp ?? null, messageType: msg.messageType ?? null, text: msg.text ?? '',
    ...(msg.reaction ? { reaction: { ...msg.reaction } } : {}),
  };
}

/**
 * A journalled message, ready to be run. A reply quotes the request it
 * answers, and Baileys builds the quote from the message's key and content
 * (`raw`), which the journal does not keep: a plain-text stand-in is enough
 * for it, and the "which one?" list or "which season?" posted after a pause
 * still says which request it answers.
 */
export function heldMessage(slim) {
  const m = { ...slim };
  if (m.key?.id && m.key.remoteJid) m.raw = { key: m.key, message: { conversation: String(m.text ?? '') } };
  return m;
}

/** "14:02", on the 24-hour clock (CLAUDE.md, house style). */
export function clock(ts) {
  if (!Number.isFinite(ts)) return '?';
  return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

export class RequestPause extends EventEmitter {
  /**
   * @param store       the 'request-pause' namespace of the state store
   * @param queueStore  the 'queue-pause' namespace
   * @param queue       the media queue
   * @param bot         for the reactions and _bulkPace
   * @param audit       the 'audit' namespace, for what could not be run
   * @param getConfig   the live config (the ⚠️ for a held request that cannot run)
   */
  constructor({ store, queueStore, queue = null, bot = null, audit = null, getConfig = null, now = () => Date.now() }) {
    super();
    this.store = store;
    this.queueStore = queueStore;
    this.queue = queue;
    this.bot = bot;
    this.audit = audit;
    this.getConfig = getConfig ?? (() => ({}));
    this.now = now;
    this.plugins = null;
    this._replaying = null;
  }

  /** The plugins, by name, whose replayHeld() runs a held request. */
  attach(pluginManager) { this.plugins = pluginManager?.plugins ?? null; }

  state() { return normalState(this.store.get('state', null)); }
  queueState() { return normalQueue(this.queueStore.get('state', null)); }
  isPaused() { return this.state().paused; }
  _held() { const v = this.store.get('held', []); return Array.isArray(v) ? v : []; }
  heldCount() { return this._held().length; }

  /**
   * How many requests (not picks) from this member a plugin has held. The
   * flood backstop counts them as answers already given, since each is
   * answered when requests resume: before it, one member's eight held were
   * eight lookups and refusals in the replay (src/core/request-cooldown.js,
   * found in review, 2026-10-01).
   */
  heldFrom(plugin, senderJid) {
    if (!senderJid) return 0;
    return this._held().filter((it) => it.plugin === plugin && it.kind !== 'pick' && it.msg?.senderJid === senderJid).length;
  }

  /** Is this held - a request by its message id, or a pick by its list's id? */
  holds(plugin, id) {
    return this._held().some((it) => it.plugin === plugin && (it.kind === 'pick' ? it.listId : it.id) === id);
  }

  /**
   * Put the stored pauses back on the queue, at start-up, before any plugin
   * loads: recovery puts the last process's jobs back in the queue, and a
   * paused queue must not start one of them in the moment before it is told.
   */
  restore() {
    const st = this.state();
    const q = this.queueState();
    // A request pause that says it paused the queue keeps it paused, even
    // where the queue's own entry was lost (a hand edit of the file) - and
    // writes that entry back, so resuming requests resumes the queue too.
    if (st.paused && st.pausedQueue && !q.paused) this.queueStore.set('state', { paused: true, since: st.since, by: st.by });
    if ((q.paused || (st.paused && st.pausedQueue)) && this.queue && !this.queue.paused) this.queue.pause();
    const held = this.heldCount();
    if (st.paused) {
      logger.warn(`⏸️ requests are PAUSED (since ${clock(st.since)} by ${st.by ?? 'someone'}), `
        + `${held} held - each new request gets ⏸️ until they are resumed from the panel`);
    } else if (held) {
      logger.info(`⏸️ requests are not paused, and ${held} held request(s) are still to run - they run, in order, once WhatsApp is up`);
    }
    if (q.paused || (st.paused && st.pausedQueue)) {
      logger.warn(`⏸️ the queue is paused (since ${clock(q.since ?? st.since)} by ${q.by ?? st.by ?? 'someone'}) - nothing new starts until it is resumed`);
    }
    return { requests: st, queue: this.queueState(), held };
  }

  /** What the panel shows, pushed over SSE on every change. */
  snapshot() {
    const st = this.state();
    const q = this.queueState();
    const held = this._held();
    return {
      paused: st.paused, since: st.since, by: st.by, pausedQueue: st.pausedQueue,
      held: held.length,
      // The first few, so the banner can say whose are waiting.
      heldItems: held.slice(0, 10).map((it) => ({
        at: it.at, plugin: it.plugin, kind: it.kind,
        who: formatPhone(it.msg?.senderNumber) ?? it.msg?.pushName ?? null,
        // A pick shows what the member sent: the number typed, or for a pick
        // made by reacting (which has no text) the emoji, as hold() was given it.
        text: String(it.kind === 'pick' ? (it.msg?.reaction ? it.text ?? it.msg.reaction.emoji : it.msg?.text) ?? ''
          : it.text ?? it.msg?.text ?? '').slice(0, 80),
      })),
      replaying: !!this._replaying,
      queue: { paused: !!this.queue?.paused, since: q.paused ? q.since : null, by: q.paused ? q.by : null },
    };
  }

  _changed() { this.emit('change', this.snapshot()); }

  _save(state, queueState) {
    this.store.set('state', state);
    this.queueStore.set('state', queueState);
    this._flush();
  }

  _flush() {
    // On the disk before anything else happens: a restart in the next half
    // second (the store's debounce) must not forget a pause, or a held request.
    try { this.store.flush?.(); } catch (err) { logger.warn(`could not write the request pause now: ${err.message}`); }
  }

  /** Pause requests. Returns what it did. */
  pause(by) {
    const out = switchOn(this.store.get('state', null), this.queueStore.get('state', null), { by, now: this.now() });
    if (!out.changed) return { ok: true, already: true, ...this.snapshot() };
    this._save(out.req, out.queue);
    if (out.pausedQueue) this.queue?.pause();
    logger.warn(`⏸️ requests PAUSED by ${by ?? 'someone'}${out.pausedQueue ? ', and the queue with them' : ' (the queue was already paused)'}`
      + ' - each new request gets ⏸️ and waits; beta tests, direct links and the panel are not paused');
    this._changed();
    return { ok: true, already: false, pausedQueue: out.pausedQueue, ...this.snapshot() };
  }

  /**
   * Resume requests: the queue too if this pause paused it, then every held
   * request, in the order they came. The replay is not awaited here - it is
   * paced, and can take minutes - and is returned for whoever wants it.
   */
  resume(by) {
    const out = switchOff(this.store.get('state', null), this.queueStore.get('state', null));
    const held = this.heldCount();
    if (!out.changed) return { ok: true, already: true, ...this.snapshot(), replay: this.replay() };
    this._save(out.req, out.queue);
    if (out.resumeQueue) this.queue?.resume();
    logger.warn(`▶️ requests RESUMED by ${by ?? 'someone'}${out.resumeQueue ? ', and the queue with them' : ''}`
      + `${held ? ` - running the ${held} held, in the order they came` : ''}`);
    this._changed();
    const replay = this.replay();
    return { ok: true, already: false, resumedQueue: out.resumeQueue, ran: held, ...this.snapshot(), replay };
  }

  /**
   * The queue's own Pause, from the panel or the box, now kept across a
   * restart. Pausing or resuming it by hand takes it over from the request
   * pause: resuming requests later leaves it as the admin set it.
   */
  pauseQueue(by) {
    const st = this.state();
    if (st.paused && st.pausedQueue) this.store.set('state', { ...st, pausedQueue: false });
    this.queueStore.set('state', { paused: true, since: this.now(), by: by ?? null });
    this._flush();
    this.queue?.pause();
    this._changed();
  }

  resumeQueue(by) {
    const st = this.state();
    if (st.paused && st.pausedQueue) this.store.set('state', { ...st, pausedQueue: false });
    this.queueStore.set('state', { ...QUEUE_OFF });
    this._flush();
    this.queue?.resume();
    logger.info(`the queue was resumed by ${by ?? 'someone'}`);
    this._changed();
  }

  /**
   * Hold one request: journal it, then ⏸️ on the member's message. The
   * journal comes first, so a reaction that fails still leaves it to run.
   * `extra` is what the plugin needs to run it later (replayHeld); its
   * `reactOn` is where the ⏸️ goes when the message is a member's reaction.
   */
  async hold(ctx, msg, { plugin, kind = 'request', text = null, emoji = PAUSED_EMOJI, extra = {} }) {
    const item = {
      id: msg.id, plugin, kind, at: this.now(), msg: slimMessage(msg),
      ...(text != null ? { text } : {}), ...extra,
    };
    this.store.set('held', [...this._held(), item]);
    this._flush();
    const st = this.state();
    const who = formatPhone(msg.senderNumber) ?? msg.senderJid;
    (ctx?.log ?? logger).info(`⏸️ held ${kind === 'pick' ? 'a pick' : 'a request'} from ${who} in ${msg.chatJid}: `
      + `"${String(text ?? msg.text ?? '').slice(0, 120)}" - requests paused since ${clock(st.since)} by ${st.by ?? 'someone'} `
      + `(${this.heldCount()} held)`);
    this._changed();
    // 'critical': being told the request is on hold is the whole answer for
    // now, maybe for an hour - shed, it would look as if the bot missed it.
    //
    // A member's reaction (a pick made by reacting to a list) cannot carry
    // one, and the bot never reacts back to one - so its ⏸️ goes on the
    // request the list answers (`reactOn`), where the pick's own reactions
    // will land when it runs. It used to get none at all, which left a
    // member who had reacted 2️⃣ with no sign the bot had seen it for as long
    // as the pause lasted, against the operator's "all requests should get a
    // ⏸️ reaction" (found in review, 2026-10-01).
    const target = msg.reaction ? (item.reactOn ? heldMessage(item.reactOn) : null) : msg;
    if (!target) return item;
    try { await (ctx?.bot ?? this.bot)?.react?.(target, emoji || PAUSED_EMOJI, { kind: 'critical' }); }
    catch (err) { (ctx?.log ?? logger).warn(`could not react ${emoji} to a held request: ${err.message}`); }
    return item;
  }

  /**
   * Run the held requests, oldest first, through each plugin's own request
   * path. Each is taken off the list, and the list written to the disk,
   * before it is handed over, so a restart part-way through goes on with
   * what is left and never runs one twice. Stops when requests are paused
   * again, or WhatsApp goes away (the rest run at the next connect).
   *
   * Paced like every loop that calls WhatsApp (CLAUDE.md rule 1): each one
   * reacts, and may post a list or a question.
   *
   * Never rejects: a replay that fails is logged here, with the requests it
   * did not reach still held on the disk for the next connect or Resume.
   * The command channel's resume-requests used to drop the rejection with a
   * comment saying the replay logged it, which it did not - a replay whose
   * pacing threw left no line at all while the op's answer said "running"
   * (found in review, 2026-10-01).
   */
  replay() {
    if (this._replaying) return this._replaying;
    if (!this.heldCount() || this.isPaused()) return Promise.resolve(0);
    this._replaying = (async () => {
      let ran = 0;
      try {
        for (;;) {
          if (this._replayMustStop()) break;
          await this.bot?._bulkPace?.();
          // Asked again after the wait, before the next one is taken off the
          // list: requests paused again, or WhatsApp gone, in those seconds.
          // Asked only before it, a socket that dropped during the pace had
          // the next request handed over with nothing to answer it on - its
          // reactions thrown away, a "which one?" list never shown - and off
          // the list, so the next connect did not run it again (found in
          // review, 2026-10-01).
          if (this._replayMustStop()) break;
          const [item, ...rest] = this._held();
          if (!item) break;
          this.store.set('held', rest);
          this._flush();
          this._changed();
          await this._handOver(item);
          ran += 1;
        }
      } catch (err) {
        logger.error(`running the held requests stopped: ${err.message} - `
          + `${this.heldCount()} still held, to run at the next connect or Resume`);
      } finally {
        this._replaying = null;
        if (ran) logger.info(`▶️ ran ${ran} held request(s)${this.heldCount() ? `, ${this.heldCount()} still held` : ''}`);
        this._changed();
      }
      return ran;
    })();
    this._changed();
    return this._replaying;
  }

  /** Should the replay stop before handing over the next one? */
  _replayMustStop() {
    if (this.isPaused() || !this.heldCount()) return true;
    if (this.bot?.isConnected?.() === false) {
      logger.info(`⏸️ ${this.heldCount()} held request(s) wait for WhatsApp to reconnect`);
      return true;
    }
    return false;
  }

  /** One held request, to its plugin. */
  async _handOver(item) {
    const entry = this.plugins?.get?.(item.plugin);
    const who = formatPhone(item.msg?.senderNumber) ?? item.msg?.senderJid ?? '?';
    const what = `"${String(item.text ?? item.msg?.text ?? '').slice(0, 120)}" from ${who}`;
    if (!entry?.plugin?.replayHeld) {
      return this._couldNotRun(item, what, `the ${item.plugin} plugin is not loaded`);
    }
    logger.info(`▶️ running the held ${item.kind === 'pick' ? 'pick' : 'request'} ${what}, `
      + `held since ${clock(item.at)}`);
    try {
      await entry.plugin.replayHeld(item, entry.ctx);
    } catch (err) {
      await this._couldNotRun(item, what, err.message);
    }
  }

  /**
   * A held request that could not be run: ⚠️ on it, an error line, and a row
   * in the audit log - it was taken off the list, so nothing else would say.
   */
  async _couldNotRun(item, what, why) {
    logger.error(`could not run the held request ${what}: ${why}`);
    try {
      this.audit?.push?.('events', {
        ts: this.now(), user: 'request pause', role: 'system', ip: 'local',
        action: `could not run a held request ${what}`, detail: why,
      }, 2000);
    } catch { /* the audit log must never stop the replay */ }
    const emoji = this.getConfig()?.movieRequests?.reactions?.failed ?? '⚠️';
    // A pick made by reacting to a list is a member's reaction, which is
    // never reacted to: its ⚠️ goes on the request the list answered, kept
    // with it when it was held (the movie plugin's _holdPick).
    const on = item.msg?.reaction ? item.reactOn : item.msg;
    try { if (on?.key) await this.bot?.react?.(heldMessage(on), emoji, { kind: 'critical' }); }
    catch (err) { logger.warn(`could not react to it: ${err.message}`); }
  }
}
