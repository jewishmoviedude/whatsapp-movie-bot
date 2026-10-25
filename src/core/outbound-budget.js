/**
 * A ceiling on how MUCH the bot says, not just how fast.
 *
 * Every other control here shapes the gap between actions: minActionDelayMs
 * randomises the pause before each one, the bulk pacers slow repetitive loops,
 * the group-list floor stops one call being hammered. None of them caps the
 * TOTAL. At the 1.2-3.5s floor, sustained, roughly 1,000-3,000 actions an hour
 * is reachable with nothing to stop it - and volume is the one thing WhatsApp
 * has measurably punished this account for.
 *
 * So this adds the missing axis. Two rolling windows (an hour and a day) count
 * everything sent. As they fill, two things happen, in this order:
 *
 *   1. BACK-PRESSURE. The pacing delay stretches, so the bot slows to fit the
 *      ceiling rather than sprinting into it and stopping dead. A gradual
 *      slowdown looks like a busy person; a hard stop looks like a broken bot.
 *
 *   2. SHEDDING. Past a threshold, work nobody is waiting on is dropped
 *      outright rather than delayed - a queue-position reaction is superseded
 *      by the next one anyway, so delaying it is pure waste. What a person is
 *      actually waiting for is NEVER shed, at any utilisation.
 *
 * The classes exist so that "slow down" never turns into "lose someone's film".
 *
 *   critical - a person is waiting on this: a reply, a document, a failure
 *              notice. Never shed. Slowed only as far as the cap allows.
 *   normal   - useful lifecycle signal (a reaction marking 'downloading').
 *              Shed only when genuinely over the limit.
 *   low      - cosmetic or self-superseding: queue positions, presence.
 *              Shed first, and early.
 *
 * The default is `normal`: a call site that says nothing participates in
 * back-pressure but is only dropped in a real overrun. Making the default
 * `low` would risk silently dropping something that mattered; making it
 * `critical` would mean nothing ever sheds.
 */
import { RateWindow } from '../util/rate-window.js';

/** Utilisation at which each class starts being dropped. */
export const SHED_AT = {
  critical: Infinity,   // never
  normal: 1.0,          // only once genuinely over
  low: 0.75,            // early, because nobody is waiting on these
};

export class OutboundBudget {
  /**
   * @param {object}   opts
   * @param {Function} opts.getConfig  () => config.whatsapp.budget, read live so
   *                                   the portal can change limits without a restart
   * @param {Function} opts.now        clock, for tests
   * @param {object}   opts.log        logger
   */
  constructor({ getConfig, now = Date.now, log = null } = {}) {
    this.getConfig = getConfig ?? (() => ({}));
    this.now = now;
    this.log = log;

    this.hour = new RateWindow({ windowMs: 3_600_000, buckets: 60, now });
    this.day = new RateWindow({ windowMs: 86_400_000, buckets: 96, now });  // 15-min buckets

    this.shed = { critical: 0, normal: 0, low: 0 };
    this._lastWarnAt = 0;
  }

  /**
   * Save and restore across restarts.
   *
   * The counters live in memory, so without this a restart wipes the budget -
   * and a crash loop, which is exactly when a volume ceiling matters most,
   * would evade it entirely. This bot restarted three times in one night.
   *
   * The windows hold absolute bucket indices, so a restored count ages
   * correctly however long the process was down.
   */
  toJSON() {
    return { hour: this.hour.toJSON(), day: this.day.toJSON(), shed: { ...this.shed } };
  }

  restore(data) {
    if (!data) return false;
    const h = this.hour.restore(data.hour);
    const d = this.day.restore(data.day);
    if (data.shed) for (const k of Object.keys(this.shed)) this.shed[k] = Number(data.shed[k]) || 0;
    return h || d;
  }

  get settings() {
    const c = this.getConfig() ?? {};
    return {
      enabled: c.enabled !== false,
      perHour: Number(c.perHour ?? 1200),
      perDay: Number(c.perDay ?? 12000),
      // Below this, nothing changes at all - the budget is invisible on a
      // normal night and only exists for the abnormal ones.
      softAt: Number(c.softAt ?? 0.7),
      // How much the pace may stretch at full utilisation.
      maxStretch: Number(c.maxStretch ?? 4),
    };
  }

  /**
   * Utilisation, 0..n. The HIGHER of the two windows governs, so a slow
   * grinding day is caught even when no single hour looks busy.
   */
  utilisation() {
    const { perHour, perDay } = this.settings;
    return Math.max(this.hour.fractionOf(perHour), this.day.fractionOf(perDay));
  }

  /**
   * May this action go at all?
   *
   * Returning false means DROP IT, not retry later - the caller has nowhere to
   * put it. Only ever true for work nobody is waiting on.
   */
  allows(kind = 'normal') {
    if (!this.settings.enabled) return true;
    const threshold = SHED_AT[kind] ?? SHED_AT.normal;
    if (this.utilisation() < threshold) return true;

    this.shed[kind in this.shed ? kind : 'normal'] += 1;
    this._warn(kind);
    return false;
  }

  /**
   * How much to stretch the pacing delay, as a multiplier >= 1.
   *
   * Linear from 1x at `softAt` to `maxStretch` at 100%, then held there. It is
   * held rather than grown without bound because an unbounded stretch turns a
   * busy night into a queue that never drains, which reads as the bot being
   * broken - and the shedding above is the mechanism for a real overrun.
   */
  stretch() {
    const { enabled, softAt, maxStretch } = this.settings;
    if (!enabled) return 1;
    const u = this.utilisation();
    if (u <= softAt) return 1;
    const span = Math.max(0.0001, 1 - softAt);
    const over = Math.min(1, (u - softAt) / span);
    return 1 + over * Math.max(0, maxStretch - 1);
  }

  /** Count one action against the budget. */
  record(n = 1) {
    this.hour.add(n);
    this.day.add(n);
  }

  /** Say so once when it starts biting, rather than on every dropped action. */
  _warn(kind) {
    const at = this.now();
    if (at - this._lastWarnAt < 60_000) return;
    this._lastWarnAt = at;
    const { perHour, perDay } = this.settings;
    this.log?.warn?.(
      `outbound budget is shedding ${kind} work — ${this.hour.count()}/${perHour} this hour, `
      + `${this.day.count()}/${perDay} today. Nothing a person is waiting on is affected.`);
  }

  /** For the portal, so a slowdown is legible rather than looking like a fault. */
  snapshot() {
    const { enabled, perHour, perDay, softAt } = this.settings;
    const u = this.utilisation();
    return {
      enabled,
      hour: { used: this.hour.count(), limit: perHour },
      day: { used: this.day.count(), limit: perDay },
      utilisation: Math.round(u * 100) / 100,
      stretch: Math.round(this.stretch() * 100) / 100,
      // What an operator actually wants to know: is this thing affecting
      // anything right now, and if so what?
      state: !enabled ? 'off' : u >= 1 ? 'over' : u > softAt ? 'slowing' : 'normal',
      shedding: Object.entries(SHED_AT)
        .filter(([, t]) => u >= t)
        .map(([k]) => k),
      shedTotals: { ...this.shed },
    };
  }
}
