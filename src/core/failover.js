/**
 * Keep the bot on the best WhatsApp number available.
 *
 * The numbers are a priority list: the first one is preferred, the rest are
 * spares. Exactly ONE is ever connected - three live WhatsApp Web sessions from
 * one IP is the sort of footprint this bot spends all its pacing trying to
 * avoid, and three connected numbers would each process every request, so a
 * single message would be answered, reacted to and uploaded three times.
 *
 * Switching is therefore cold: a spare sits linked but disconnected until it is
 * needed. Its saved session is untouched, so taking over does not require
 * re-linking, and neither does going back.
 *
 * Two rules shape when a switch is allowed:
 *
 *  - Failing BACK to a preferred number waits for the queue to be completely
 *    idle. There is no hurry - the spare is working fine - and switching mid
 *    job would throw away a download that is already half done.
 *
 *  - Failing OVER cannot wait for the queue, because the queue is precisely
 *    what has stopped: uploads need a connection. Waiting for "empty" when the
 *    active number is dead would wait forever. So the bot's own reconnect
 *    backoff gets first refusal, and only once it has given up does a spare
 *    take over. Whatever was in flight is requeued, since a dead socket was
 *    never going to finish it.
 */
import log from '../util/logger.js';
import { listAccounts, activeAccount, switchAccount } from './accounts.js';

const logger = log.scope('failover');

/** A number that logged out needs a human with a phone; do not keep retrying. */
const NEEDS_RELINK = 'logged-out';

/**
 * The groups the bot cannot do its job without, and what each is for.
 * A spare that is missing one of these connects and looks healthy while
 * silently not processing part of the workload - the worst kind of failure.
 *
 * Beta groups (config.beta) are deliberately NOT listed. This answers "can
 * this number serve the members?", and a test group serves none of them: a
 * spare that is not an admin in "Testing things" would show a coverage gap
 * for something no member depends on, and a warning that cries wolf is one
 * people learn to ignore. If a spare takes over, testing pauses; nobody else
 * notices.
 */
export function functionalGroups(cfg = {}) {
  const out = new Map();
  const mr = cfg.movieRequests ?? {};
  const tv = cfg.tvRequests ?? {};
  const dl = cfg.directLinks ?? {};
  for (const j of mr.requestGroups ?? []) out.set(j, 'movie requests');
  if (mr.postsGroup) out.set(mr.postsGroup, 'movie posts');
  for (const j of mr.postsGroups ?? []) out.set(j, 'movie posts');
  if (tv.enabled) {
    for (const j of tv.requestGroups ?? []) out.set(j, 'TV requests');
    for (const j of tv.postsGroups ?? []) out.set(j, 'TV posts');
  }
  if (dl.enabled) for (const j of dl.groups ?? []) out.set(j, 'direct links');
  const n = mr.notify?.group;
  if (n) out.set(n, 'queue notifications');
  return out;
}

/**
 * Can this number actually run the bot? Being a member is not enough - almost
 * everything the bot does in a group (posting, deleting, locking) needs admin.
 */
export function coverageFor(groups, cfg, phoneNumber) {
  const need = functionalGroups(cfg);
  const want = String(phoneNumber ?? '').replace(/[^0-9]/g, '');
  if (!want || !groups?.length) return null;           // cannot tell yet
  const gaps = [];
  for (const [jid, role] of need) {
    const g = groups.find((x) => x.jid === jid);
    if (!g) continue;                                  // bot cannot see it either
    const m = (g.members ?? []).find((p) => {
      const n = String(p.number ?? '').replace(/[^0-9]/g, '');
      return n && (n === want || n.endsWith(want) || want.endsWith(n));
    });
    if (!m) gaps.push({ role, subject: g.subject, why: 'not a member' });
    else if (!m.admin) gaps.push({ role, subject: g.subject, why: 'not an admin' });
  }
  return { total: need.size, covered: need.size - gaps.length, gaps };
}

export class FailoverSupervisor {
  constructor({ bot, configStore, queues = [], stateStore = null, audit = null, alerts = null } = {}) {
    this.bot = bot;
    this.configStore = configStore;
    this.queues = queues.filter(Boolean);
    this.stateStore = stateStore;
    this.auditFn = audit;
    this.alerts = alerts;

    /** id -> { failedAt, reason, cooldownUntil } */
    this.health = new Map();
    this.activeSince = 0;
    this.switching = null;          // single-flight guard
    // The background linker (spare-linker.js), set by src/index.js. A number
    // it is linking is not a spare yet: switching to it would put the bot's
    // socket on a session that is still being written.
    this.linker = null;
    this._timer = null;
    this._onState = null;
  }

  get cfg() {
    const f = this.configStore.get().whatsapp?.failover ?? {};
    return {
      enabled: f.enabled === true,
      order: Array.isArray(f.order) ? f.order : [],
      failAfterAttempts: Number(f.failAfterAttempts ?? 4),
      holdDownMs: Number(f.holdDownMs ?? 600_000),
      cooldownMs: Number(f.cooldownMs ?? 900_000),
      probeTimeoutMs: Number(f.probeTimeoutMs ?? 45_000),
      checkEveryMs: Number(f.checkEveryMs ?? 60_000),
      maxSwitchesPerWindow: Number(f.maxSwitchesPerWindow ?? 3),
      switchWindowMs: Number(f.switchWindowMs ?? 3_600_000),
    };
  }

  /** Accounts in preference order, best first. Unlisted ones keep config order. */
  ranked() {
    const accounts = listAccounts(this.configStore.get(), this.bot.dataDir);
    const order = this.cfg.order;
    if (!order.length) return accounts;
    const rank = (a) => {
      const i = order.indexOf(a.id);
      return i === -1 ? order.length + accounts.indexOf(a) : i;
    };
    return [...accounts].sort((a, b) => rank(a) - rank(b));
  }

  /**
   * The number in use, decided exactly as listAccounts() decides it: a missing,
   * blank or unknown activeAccount means the first account. This used to be
   * `activeAccount ?? 'default'`, but a new install's activeAccount is '' -
   * present, so `??` never fell back. The supervisor then believed nothing was
   * in use: the number actually connected ranked as its own spare, so an
   * outage "failed over" to it (a pointless disconnect and reconnect, logged
   * as a switch), and its health was recorded against ''.
   */
  activeId() {
    return activeAccount(this.configStore.get()).id;
  }

  /**
   * Is there any number but the one in use to move to, linked or not? None
   * is a bot with one number, which failover cannot help: there it stands
   * aside exactly as if it were off. It is on by default since the
   * operator's live settings became the defaults (2026-10-12), and on a new
   * install's only number every outage would otherwise have marked it
   * failed, logged "no healthy spare to fail over to" as an error and sent
   * the "DOWN - no spare number available" email, about spares nobody had
   * set up. A spare that is set up but not linked is different: that is a
   * failover with nowhere to go, and it is still said loudly.
   */
  _hasSpare() {
    const current = this.activeId();
    return this.ranked().some((a) => a.id !== current);
  }

  /** Can this account be switched to right now? */
  eligible(acc, now = Date.now()) {
    if (!acc.linked) return false;                      // nothing to connect with
    if (this.linker?.isLinking?.(acc.id)) return false; // not until the link is done
    const h = this.health.get(acc.id);
    if (!h) return true;
    if (h.reason === NEEDS_RELINK) return false;        // until someone re-links it
    return !h.cooldownUntil || h.cooldownUntil <= now;
  }

  markFailed(id, reason, { permanent = false } = {}) {
    const now = Date.now();
    this.health.set(id, {
      failedAt: now,
      reason,
      cooldownUntil: permanent ? Number.MAX_SAFE_INTEGER : now + this.cfg.cooldownMs,
    });
    logger.warn(`"${id}" marked unhealthy: ${reason}${permanent ? ' (needs re-linking)' : ''}`);
  }

  markHealthy(id) {
    if (this.health.delete(id)) logger.info(`"${id}" is healthy again`);
  }

  /** Nothing running and nothing waiting, across every queue. */
  queuesIdle() {
    return this.queues.every((q) => {
      const active = q.active?.size ?? 0;
      const pending = q.pending?.length ?? 0;
      return active === 0 && pending === 0;
    });
  }

  /** A one-line description of what the queues are doing, for the log. */
  queueSummary() {
    // In requests, as the panel counts them - a season is one, not one per episode.
    const count = (q) => q.requestCounts?.() ?? { active: q.active?.size ?? 0, waiting: q.pending?.length ?? 0 };
    const active = this.queues.reduce((n, q) => n + count(q).active, 0);
    const pending = this.queues.reduce((n, q) => n + count(q).waiting, 0);
    return `${active} running, ${pending} waiting`;
  }

  /* ------------------------------------------------------------ wiring --- */

  start() {
    if (this._onState) return;
    this._onState = (st) => { this._onBotState(st); };
    this.bot.on('state', this._onState);
    this.activeSince = Date.now();
    this._timer = setInterval(() => {
      this.considerFailback().catch((e) => logger.error(`failback check: ${e.message}`));
    }, this.cfg.checkEveryMs);
    this._timer.unref?.();
    logger.info('failover supervisor armed');
  }

  stop() {
    if (this._onState) { this.bot.off?.('state', this._onState); this._onState = null; }
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  _onBotState(st) {
    if (!this.cfg.enabled || this._switchBusy || this.switching || !this._hasSpare()) return;
    const id = this.activeId();

    if (st.state === 'connected') {
      this.markHealthy(id);
      this._failedOverThisOutage = false;     // the outage is over
      if (!this.activeSince) this.activeSince = Date.now();
      return;
    }

    // Logged out on the phone: the session is wiped and only a human with the
    // handset can fix it. Never retry this number automatically.
    if (st.state === 'stopped' && /logged ?out/i.test(st.lastError ?? '')) {
      if (this._failedOverThisOutage) return;      // one handover per outage
      this._failedOverThisOutage = true;
      this.markFailed(id, NEEDS_RELINK, { permanent: true });
      // This one cannot be fixed from the server at all, so it is worth its own
      // message rather than being folded into the takeover notice.
      this._email({
        kind: 'relink-needed',
        subject: `WhatsApp number needs re-linking`,
        lines: [
          `"${id}" was logged out on the phone, so its saved session has been wiped.`,
          '',
          'It cannot be used again until someone links it from the handset:',
          'Settings -> WhatsApp numbers -> Re-link on its row, then scan the code.',
          'That links it in the background; the bot stays on the number it is using.',
          'Until then it will be skipped when choosing a number.',
        ],
      });
      this.failover('the number was logged out on the phone').catch((e) => logger.error(e.message));
      return;
    }

    // Someone opened WhatsApp Web on this number elsewhere and took the slot.
    if (st.state === 'conflict') {
      this.markFailed(id, 'the session was taken over elsewhere');
      this.failover('another WhatsApp Web session replaced ours').catch((e) => logger.error(e.message));
      return;
    }

    // The bot retries with its own backoff. Only once that has genuinely given
    // up is a spare worth waking - a blip should not move the whole bot.
    //
    // reconnectAttempts is cumulative and only resets on a successful connect,
    // so during a bad patch it climbs without bound. Firing on every state
    // event past the threshold is what produced 91 number switches and 264
    // reconnect attempts in a single day - each switch tearing down a session
    // that might have recovered on its own. One failover per outage only: the
    // next is allowed after a connection has actually succeeded.
    // Never switch out from under somebody who is linking a number by hand.
    // A wiped account has no session to reconnect to, so it will sit in
    // 'connecting' by design while a QR is offered - which used to look
    // exactly like a failed reconnect, and moved the bot to a spare before the
    // code had even been drawn. Linking is not an outage.
    if (st.linking) return;

    if (st.state === 'connecting' && (st.reconnectAttempts ?? 0) >= this.cfg.failAfterAttempts
        && !this._failedOverThisOutage) {
      this._failedOverThisOutage = true;
      this.markFailed(id, `${st.reconnectAttempts} reconnect attempts failed`);
      this.failover(`could not reconnect after ${st.reconnectAttempts} attempts`)
        .catch((e) => logger.error(e.message));
    }
  }

  /* --------------------------------------------------------- switching --- */

  /**
   * Move to the best eligible spare. The queue is deliberately NOT waited on:
   * the active number is down, so nothing in the queue can progress anyway.
   */
  /**
   * Have we been switching too often? Switching numbers is not free - each one
   * tears down a WhatsApp session and starts another, and doing that
   * repeatedly is exactly the pattern that gets an account flagged.
   *
   * When the connection itself is unstable, no number will hold, so switching
   * cannot help and only makes things worse. Past the limit the supervisor
   * stands down and lets the bot's own reconnect backoff do its job.
   */
  _tooManySwitches() {
    const win = this.cfg.switchWindowMs;
    const now = Date.now();
    this._switchTimes = (this._switchTimes ?? []).filter((t) => now - t < win);
    return this._switchTimes.length >= this.cfg.maxSwitchesPerWindow;
  }

  _recordSwitch() {
    (this._switchTimes ??= []).push(Date.now());
  }

  async failover(why) {
    if (!this.cfg.enabled || !this._hasSpare()) return null;
    if (this._tooManySwitches()) {
      const mins = Math.round(this.cfg.switchWindowMs / 60000);
      logger.error(`refusing to switch again - ${this._switchTimes.length} switches in ${mins} min. `
        + 'The connection itself looks unstable, so another number will not help.');
      this._email({
        kind: 'failover-thrashing',
        subject: 'WhatsApp bot: too many number switches, standing down',
        lines: [
          `The bot has switched numbers ${this._switchTimes.length} times in the last ${mins} minutes.`,
          '',
          'That usually means the connection itself is unstable rather than any',
          'one number being at fault, and switching repeatedly risks getting the',
          'accounts flagged. Automatic switching has stood down; the bot keeps',
          'retrying on the number it is on.',
          '',
          `  Last trigger: ${why}`,
        ],
      });
      return null;
    }
    const current = this.activeId();
    const candidate = this.ranked().find((a) => a.id !== current && this.eligible(a));
    if (!candidate) {
      logger.error(`no healthy spare to fail over to (${why}) - staying on "${current}"`);
      this._record('failover FAILED - no healthy spare', `${why}; still on "${current}"`);
      this._email({
        kind: 'failover-stuck',
        subject: 'WhatsApp bot is DOWN - no spare number available',
        lines: [
          `The bot lost its WhatsApp connection and could not move to another number.`,
          '',
          `  Number in use : ${current}`,
          `  What happened : ${why}`,
          '',
          'It is not processing requests until this is fixed. Every other number is',
          'either unlinked, logged out, or in a cooldown after failing.',
        ],
      });
      return null;
    }
    logger.warn(`failing over to "${candidate.label}" — ${why}`);
    const from = this.ranked().find((a) => a.id === current);
    const ok = await this._switchTo(candidate, `failover: ${why}`);
    if (ok) {
      const requeued = this._requeueInterrupted();
      const cover = this.status().accounts.find((a) => a.id === candidate.id)?.coverage;
      this._email({
        kind: 'failover',
        subject: `WhatsApp bot switched to ${candidate.label}`,
        lines: [
          `The number the bot was using stopped working, so it took over on the next one.`,
          '',
          `  Was using : ${from?.label ?? current}`,
          `  Now using : ${candidate.label}${candidate.phoneNumber ? ` (+${candidate.phoneNumber})` : ''}`,
          `  Why       : ${why}`,
          requeued ? `  Requeued  : ${requeued} job(s) that were in progress` : '',
          '',
          // A spare that cannot administer every group looks healthy while
          // quietly ignoring part of the workload - say so plainly.
          cover && cover.gaps.length
            ? `WARNING: this number can only administer ${cover.covered} of ${cover.total} groups.\n`
              + cover.gaps.map((g) => `  - ${g.subject} (${g.role} - ${g.why})`).join('\n')
              + '\nRequests in those groups will NOT be handled until that is fixed.'
            : 'This number can administer every group the bot needs.',
        ].filter((l) => l !== ''),
      });
    }
    return ok ? candidate : null;
  }

  /**
   * Return to a more-preferred number once it looks safe. Waits for the queues
   * to be completely idle, so a failback never interrupts a job in progress.
   */
  async considerFailback() {
    if (!this.cfg.enabled || this.switching) return null;
    if (this.bot.state !== 'connected') return null;

    const current = this.activeId();
    const ranked = this.ranked();
    const currentRank = ranked.findIndex((a) => a.id === current);
    if (currentRank <= 0) return null;                    // already on the best one

    const better = ranked.slice(0, currentRank).find((a) => this.eligible(a));
    if (!better) return null;

    const stableFor = Date.now() - (this.activeSince || 0);
    if (stableFor < this.cfg.holdDownMs) return null;     // do not flap

    if (!this.queuesIdle()) {
      logger.info(`"${better.label}" looks available, but the queue is busy (${this.queueSummary()}) — waiting`);
      return null;
    }

    logger.info(`trying to move back to the preferred number "${better.label}"`);
    const wasOn = ranked.find((a) => a.id === current);
    const ok = await this._switchTo(better, 'failback to the preferred number');
    if (ok) {
      this._email({
        kind: 'failback',
        subject: `WhatsApp bot is back on ${better.label}`,
        lines: [
          `The preferred number is working again, so the bot has returned to it.`,
          '',
          `  Was using : ${wasOn?.label ?? current}`,
          `  Now using : ${better.label}${better.phoneNumber ? ` (+${better.phoneNumber})` : ''}`,
          '',
          'The queue was idle at the time, so nothing was interrupted.',
        ],
      });
    }
    if (!ok) {
      // The probe failed. Go back to what was working rather than sit down.
      const previous = ranked.find((a) => a.id === current);
      if (previous) await this._switchTo(previous, 'failback probe failed - returning');
    }
    return ok ? better : null;
  }

  /** Stop, repoint at `acc`, start, and wait for it to actually connect. */
  async _switchTo(acc, why) {
    // The busy flag is set BEFORE __switchTo runs, not after. Assigning
    // this.switching to the result meant the flag did not exist yet while
    // __switchTo's synchronous prefix ran - and that prefix calls bot.stop(),
    // which emits 'stopped' straight back into _onBotState. The guard there
    // saw switching === undefined and started another switch, re-entrantly:
    // one logout became 929 failovers inside a single second.
    if (this._switchBusy) return this.switching;
    this._switchBusy = true;
    this.switching = this.__switchTo(acc, why)
      .finally(() => { this._switchBusy = false; this.switching = null; });
    return this.switching;
  }

  async __switchTo(acc, why) {
    const from = this.activeId();
    try {
      const { patch } = switchAccount(this.configStore.get(), acc.id);
      try { await this.bot.stop(); } catch { /* already down */ }
      this.configStore.update(patch);
      this.activeSince = 0;

      const connected = this._waitForConnected(this.cfg.probeTimeoutMs);
      this.bot.start().catch((e) => logger.error(`switch: could not start: ${e.message}`));
      const ok = await connected;

      if (ok) {
        this.markHealthy(acc.id);
        this._recordSwitch();
        this.activeSince = Date.now();
        logger.info(`now running as "${acc.label}" (${why})`);
        this._record(`switched WhatsApp to "${acc.label}"`, `${why}; previously "${from}"`);
        return true;
      }
      this.markFailed(acc.id, `did not connect within ${Math.round(this.cfg.probeTimeoutMs / 1000)}s`);
      logger.error(`"${acc.label}" did not connect - it stays marked unhealthy`);
      return false;
    } catch (err) {
      this.markFailed(acc.id, err.message);
      logger.error(`switch to "${acc.label}" failed: ${err.message}`);
      return false;
    }
  }

  /** Resolves true on 'connected', false on timeout or a terminal state. */
  _waitForConnected(timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.bot.off?.('state', onState);
        resolve(v);
      };
      const onState = (st) => {
        if (st.state === 'connected') finish(true);
        else if (st.state === 'conflict') finish(false);
        else if (st.state === 'stopped' && /logged ?out/i.test(st.lastError ?? '')) finish(false);
      };
      // Deliberately NOT unref'd. This timeout is the only thing that ends a
      // failed probe: unref'd, an otherwise-idle event loop would never fire
      // it, the switch would never resolve, and the bot would sit disconnected
      // with a half-finished handover.
      const timer = setTimeout(() => finish(false), timeoutMs);
      this.bot.on('state', onState);
    });
  }

  /**
   * Anything that was mid-flight when the connection died cannot finish on the
   * new number - the socket it was uploading through is gone. Put it back on
   * the queue so it restarts, rather than leaving it wedged as "sending".
   */
  _requeueInterrupted() {
    let moved = 0;
    for (const q of this.queues) {
      for (const [id, entry] of [...(q.active ?? new Map())]) {
        try {
          logger.warn(`requeuing "${entry.label ?? id}" - the connection it was using is gone`);
          q.cancel(id, 'interrupted');
          moved += 1;
        } catch { /* best effort - never block the switch */ }
      }
    }
    return moved;
  }

  /**
   * Switch by operator request, through the SAME single-flight lock the
   * automatic switching uses. A manual switch racing an automatic failover is
   * the nastiest version of this: both call stop() then start(), and the config
   * can end up naming one number while the socket connects as another.
   *
   * Returns { ok, error } rather than throwing, so the route can answer 409.
   */
  async switchToAccount(id) {
    if (this.switching) return { ok: false, busy: true, error: 'a number switch is already in progress' };
    const acc = this.ranked().find((a) => a.id === id);
    if (!acc) return { ok: false, error: 'no such account' };
    if (this.linker?.isLinking?.(id)) {
      return { ok: false, busy: true, error: 'that number is being linked — finish or cancel the link first' };
    }
    const ok = await this._switchTo(acc, 'switched by an operator');
    if (ok) this.noteManualSwitch(id);
    return { ok, linked: !!acc.linked, target: acc };
  }

  /**
   * An operator switched by hand. Their choice stands for the hold-down period
   * before a preferred number may reclaim - otherwise pressing "Switch to this"
   * would be quietly undone a minute later.
   */
  noteManualSwitch(id) {
    this.activeSince = Date.now();
    this.markHealthy(id);
    logger.info(`manual switch to "${id}" - no failback for ${Math.round(this.cfg.holdDownMs / 60000)} min`);
  }

  /**
   * Email about a change of number. Uses the address already configured in
   * Settings, the same path the error alerts use.
   *
   * Sent for a takeover, for a return to a preferred number, and above all for
   * a failure with nothing to move to - the bot is then simply down, and
   * without this nobody finds out until someone notices requests going
   * unanswered.
   */
  _email({ kind, subject, lines }) {
    const cfg = this.configStore.get();
    if (cfg.email?.onFailover === false) return;
    if (!this.alerts?.notify) return;
    const body = [
      ...lines,
      '',
      `Numbers, in order of preference:`,
      ...this.status().accounts.map((a) => {
        const bits = [`  ${a.preference}. ${a.label}${a.phoneNumber ? ` (+${a.phoneNumber})` : ''}`];
        if (a.active) bits.push('IN USE');
        if (!a.linked) bits.push('not linked');
        if (a.needsRelink) bits.push('LOGGED OUT - needs re-linking');
        else if (a.unhealthyReason) bits.push(a.unhealthyReason);
        if (a.coverage) {
          bits.push(a.coverage.gaps.length
            ? `covers ${a.coverage.covered}/${a.coverage.total} groups`
            : `covers all ${a.coverage.total} groups`);
        }
        return bits.join(' - ');
      }),
      '',
      `Queues: ${this.queueSummary()}.`,
      'The day\'s log is attached.',
    ].join('\n');

    this.alerts.notify({
      kind,
      label: subject,
      note: body,
      throttleMinutes: Number(cfg.email?.failoverThrottleMinutes ?? 15),
    }).catch(() => { /* never let an email failure affect a recovery */ });
  }

  _record(action, detail) {
    try {
      this.auditFn?.(action, detail);
      this.stateStore?.namespace('audit').push('events', {
        ts: Date.now(),
        user: 'failover (automatic)',
        role: 'system',
        ip: 'local',
        action,
        detail,
      }, 2000);
    } catch { /* the audit log must never break a recovery */ }
  }

  /** What the portal shows. */
  status() {
    const active = this.activeId();
    return {
      enabled: this.cfg.enabled,
      active,
      switching: !!this.switching,
      queuesIdle: this.queuesIdle(),
      queues: this.queueSummary(),
      accounts: this.ranked().map((a, i) => {
        const h = this.health.get(a.id);
        let cover = null;
        try { cover = coverageFor(this.bot.groupsWithMembers?.() ?? [], this.configStore.get(), a.phoneNumber); }
        catch { cover = null; }
        return {
          ...a,
          coverage: cover,
          preference: i + 1,
          active: a.id === active,
          eligible: this.eligible(a),
          linking: !!this.linker?.isLinking?.(a.id),
          unhealthyReason: h?.reason ?? null,
          needsRelink: h?.reason === NEEDS_RELINK,
          retryAfter: h?.cooldownUntil && h.cooldownUntil !== Number.MAX_SAFE_INTEGER
            ? h.cooldownUntil : null,
        };
      }),
    };
  }
}
