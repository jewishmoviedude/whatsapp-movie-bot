/**
 * Link a spare WhatsApp number without touching the one the bot is running on.
 *
 * The operator's request: "NEED AN OPTION TO CONTROL LINKING FOR FAILOVER
 * NUMBERS WITHOUT HAVING TO MANUALLY SWITCH CURRENT CONFIG OF BOT AND
 * INTERRUPT SHIT". Until now the only code that could show a QR was the bot's
 * own connection, and that connection only ever runs as the ACTIVE account. So
 * linking a spare meant switching the whole bot onto it - disconnecting the
 * main number, stranding whatever was uploading, and leaving every group
 * unanswered until somebody scanned a code and switched back.
 *
 * This opens a separate, short-lived socket whose only job is to show that
 * spare's code and save what WhatsApp hands back. It is deliberately a much
 * smaller thing than the bot's connection:
 *
 *  - It links into a STAGING directory of its own, never into any session
 *    directory the bot could be using, and moves the result into the spare's
 *    place only once the link has succeeded. So it cannot open a second socket
 *    on a live session (CLAUDE.md rule 3), a half-finished attempt never makes
 *    a spare look "linked" to failover, and a cancelled re-link leaves the old
 *    session exactly as it was.
 *  - It refuses the active number, a number failover is switching to, and a
 *    second link while one is running; failover in turn refuses to switch to a
 *    number being linked (failover.js eligible() and switchToAccount()), and
 *    the bot cancels a link for any number it is about to connect as.
 *  - It never reconnects on failure. It offers a fresh code when one expires
 *    unscanned, a bounded number of times, and otherwise stops and says why.
 *    There is no backoff here to shorten (rule 2) because there is no retry.
 *  - It registers no message handlers and has no send path. It cannot answer,
 *    react, post or join the failover rotation; once linked it closes, and the
 *    spare stays cold until failover or an operator switches to it.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import qrcode from 'qrcode';
import log from '../util/logger.js';
import { listAccounts, sessionDirFor } from './accounts.js';

const logger = log.scope('spare-link');

// How long one link attempt may run, all codes included, before it is torn
// down. A person with the phone in hand needs a couple of minutes; past this
// they have walked away, and an open socket nobody is looking at is exactly the
// idle footprint the rest of the project works to avoid.
export const LINK_TIMEOUT_MS = 10 * 60_000;

// How many sockets one attempt may open to offer codes. Baileys closes a link
// socket itself after roughly two and a half minutes of unscanned QRs, so four
// covers the timeout above; the cap is what keeps an abandoned attempt from
// knocking on WhatsApp indefinitely.
export const MAX_LINK_SOCKETS = 4;

// After the phone scans the code, WhatsApp closes the socket with
// restartRequired and expects the client to log in with its new credentials.
// That login is what finishes the link, so it is the one reconnect this module
// makes - once per attempt.
const RESTART_REQUIRED = 515;

// How long the finished login is held open before closing, so the pre-key
// upload and the first creds writes that follow 'open' have landed on disk
// before the directory is moved into place.
const SETTLE_MS = 3_000;

// Same bound as the bot's own connection (bot.js VERSION_FETCH_MS): Baileys'
// version lookup has no timeout of its own.
const VERSION_FETCH_MS = 5_000;

const TERMINAL = new Set(['linked', 'failed', 'expired', 'cancelled']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class SpareLinker extends EventEmitter {
  /**
   * @param {object} o
   * @param {object} o.bot           the WhatsAppBot, for its authDir, dataDir and _bulkPace
   * @param {object} o.configStore
   * @param {object} [o.failover]    the FailoverSupervisor, consulted before every open
   * @param {Function} o.loadBaileys resolves the Baileys module (stubbed in tests)
   */
  constructor({ bot, configStore, failover = null, loadBaileys, timeoutMs = LINK_TIMEOUT_MS,
    maxSockets = MAX_LINK_SOCKETS, settleMs = SETTLE_MS } = {}) {
    super();
    this.bot = bot;
    this.configStore = configStore;
    this.failover = failover;
    this.loadBaileys = loadBaileys;
    this.timeoutMs = timeoutMs;
    this.maxSockets = maxSockets;
    this.settleMs = settleMs;
    /** id -> the attempt, live or finished (the panel shows the outcome). */
    this.sessions = new Map();
  }

  get dataDir() { return this.bot.dataDir; }

  /** Where an attempt for `id` builds its credentials before they are moved in. */
  stagingDirFor(id) {
    return path.join(this.dataDir, 'sessions', `.linking-${String(id)}`);
  }

  /** Is a link for this number in progress right now? */
  isLinking(id) {
    const s = this.sessions.get(id);
    return !!s && !TERMINAL.has(s.state);
  }

  /** Any link in progress at all. */
  busy() {
    return [...this.sessions.values()].some((s) => !TERMINAL.has(s.state));
  }

  /** What the panel shows, per number. No sockets or timers, just facts. */
  snapshot() {
    const out = {};
    for (const [id, s] of this.sessions) {
      out[id] = {
        id,
        state: s.state,
        method: s.method,
        qr: s.state === 'awaiting-qr' ? s.qr : null,
        pairingCode: s.state === 'awaiting-pairing' ? s.pairingCode : null,
        error: s.error ?? null,
        startedAt: s.startedAt,
        endsAt: s.endsAt ?? null,
        codes: s.sockets,
        finishedAt: s.finishedAt ?? null,
      };
    }
    return out;
  }

  _changed() { this.emit('change', this.snapshot()); }

  /**
   * Why this number may not be linked in the background right now, or null.
   * Checked when an attempt starts AND before every socket it opens, because
   * the answer can change while a code is on screen.
   */
  refusal(id) {
    const cfg = this.configStore.get();
    const acc = listAccounts(cfg, this.dataDir).find((a) => a.id === id);
    if (!acc) return 'no such number';
    if (acc.active) {
      return 'that is the number the bot is running on — link it with Link / Connect under Connection';
    }
    // The active account is resolved from config, but the socket that is
    // actually open was opened on bot.authDir. They agree except in the middle
    // of a switch, and in that window the directory is the truth.
    const dir = path.resolve(sessionDirFor(this.dataDir, id));
    if (this.bot.authDir && path.resolve(this.bot.authDir) === dir) {
      return 'the bot is using that number\'s session right now';
    }
    if (this.failover?.switching || this.failover?._switchBusy) {
      return 'a number switch is in progress — try again once it has finished';
    }
    return null;
  }

  /**
   * Start linking `id`. Returns { ok, error }.
   *
   * `method` is 'qr' or 'pairing'. A pairing code is sent to the spare's OWN
   * digits, never to whatsapp.phoneNumber, which belongs to the active number.
   */
  async start(id, { method } = {}) {
    const why = this.refusal(id);
    if (why) return { ok: false, error: why };
    if (this.busy()) {
      // One at a time. Each link is another socket from this address beside
      // the bot's own, and there is never a reason to be showing two codes.
      const other = [...this.sessions.values()].find((s) => !TERMINAL.has(s.state));
      return { ok: false, busy: true, error: `already linking "${other.label}" — finish or cancel that first` };
    }
    const acc = listAccounts(this.configStore.get(), this.dataDir).find((a) => a.id === id);
    const wanted = method ?? (this.configStore.get().whatsapp?.loginMethod === 'pairing' ? 'pairing' : 'qr');
    const usePairing = wanted === 'pairing';
    const phone = String(acc.phoneNumber ?? '').replace(/[^0-9]/g, '');
    if (usePairing && !phone) {
      return { ok: false, error: 'set this number\'s digits (Edit) before asking for a pairing code' };
    }

    const now = Date.now();
    const s = {
      id,
      label: acc.label,
      phone,
      method: usePairing ? 'pairing' : 'qr',
      state: 'starting',
      qr: null,
      pairingCode: null,
      error: null,
      startedAt: now,
      endsAt: now + this.timeoutMs,
      sockets: 0,
      paired: false,
      restarted: false,
      gen: 0,
      sock: null,
      timer: null,
      staging: this.stagingDirFor(id),
    };
    this.sessions.set(id, s);

    // Whatever an earlier attempt left in staging is not ours to resume: it
    // either failed or was cancelled, and half a pairing is not a link.
    this._clearStaging(s);
    fs.mkdirSync(s.staging, { recursive: true });

    // Deliberately NOT unref'd, for the same reason as failover's probe: this
    // timer is the only thing that ends an attempt nobody finishes.
    s.timer = setTimeout(() => {
      this._finish(s, 'expired', `nobody finished linking within ${Math.round(this.timeoutMs / 60000)} min`);
    }, this.timeoutMs);

    logger.info(`linking "${acc.label}" in the background (${s.method}) — the bot stays on its current number`);
    this._changed();
    this._open(s).catch((err) => this._finish(s, 'failed', err.message));
    return { ok: true };
  }

  /** Stop an attempt. Safe to call for a number that is not being linked. */
  async cancel(id, reason = 'cancelled') {
    const s = this.sessions.get(id);
    if (!s || TERMINAL.has(s.state)) return false;
    await this._finish(s, 'cancelled', reason);
    return true;
  }

  /** Shut every attempt down, for process exit. */
  async cancelAll(reason = 'the bot is shutting down') {
    for (const id of [...this.sessions.keys()]) await this.cancel(id, reason);
  }

  /** Open one socket for `s`. Everything past here runs on staging only. */
  async _open(s) {
    if (TERMINAL.has(s.state)) return;
    const why = this.refusal(s.id);
    if (why) { await this._finish(s, 'failed', why); return; }
    if (s.sockets >= this.maxSockets && !s.paired) {
      await this._finish(s, 'expired', `${s.sockets} codes went unscanned`);
      return;
    }

    const B = await this.loadBaileys();
    const { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, Browsers } = { ...B, ...B.__ns };
    if (TERMINAL.has(s.state)) return;          // cancelled while Baileys loaded

    const { state: authState, saveCreds } = await useMultiFileAuthState(s.staging);
    let version;
    try {
      ({ version } = await fetchLatestBaileysVersion({ timeout: VERSION_FETCH_MS }));
    } catch { /* the library default is fine */ }
    if (TERMINAL.has(s.state)) return;

    const myGen = ++s.gen;
    s.sockets += 1;
    s.saveCreds = saveCreds;
    const sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: authState,
      browser: Browsers ? Browsers.ubuntu('Desktop') : ['Ubuntu', 'Desktop', '22.04'],
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      // This socket only links. It must not show the spare as online, and it
      // has no use for history: the bot's own first connection as this number
      // does the one-off history sync that fetches the app-state key.
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      generateHighQualityLinkPreview: false,
    });
    s.sock = sock;

    sock.ev.on('creds.update', saveCreds);
    // No messages.upsert, no group handlers, nothing that emits on the bot:
    // a linking socket must never be mistaken for the bot's connection.
    let codeAsked = false;
    sock.ev.on('connection.update', async (update) => {
      if (myGen !== s.gen || TERMINAL.has(s.state)) return;
      const { connection, lastDisconnect, qr, isNewLogin } = update;

      if (isNewLogin) {
        // pair-success: the phone accepted the code. What remains is the
        // restart WhatsApp is about to ask for.
        s.paired = true;
        s.qr = null;
        s.pairingCode = null;
        s.state = 'finishing';
        this._changed();
      }

      if (qr && !s.paired) {
        if (s.method === 'pairing') {
          // The first qr event is the socket saying it is ready; a pairing
          // code is asked for once per socket, not once per QR refresh.
          if (!codeAsked) {
            codeAsked = true;
            try {
              const code = await sock.requestPairingCode(s.phone);
              if (myGen !== s.gen || TERMINAL.has(s.state)) return;
              s.pairingCode = code?.match(/.{1,4}/g)?.join('-') ?? code;
              s.state = 'awaiting-pairing';
              logger.info(`pairing code issued for spare "${s.label}" (+${s.phone})`);
              this._changed();
            } catch (err) {
              await this._finish(s, 'failed', `could not get a pairing code: ${err.message}`);
            }
          }
        } else {
          s.qr = await qrcode.toDataURL(qr, { margin: 1, width: 320 });
          if (myGen !== s.gen || TERMINAL.has(s.state)) return;
          s.state = 'awaiting-qr';
          this._changed();
        }
      }

      if (connection === 'open') {
        // Logged in with the new credentials: the link is real.
        await this._succeed(s);
        return;
      }

      if (connection === 'close') {
        s.sock = null;
        const code = lastDisconnect?.error?.output?.statusCode;
        if (s.paired && code === RESTART_REQUIRED && !s.restarted) {
          s.restarted = true;
          // The paired credentials arrive in a creds.update that is saved
          // asynchronously; the login must read them, not the pre-scan ones.
          try { await saveCreds(); } catch { /* the reopen reports any failure */ }
          if (TERMINAL.has(s.state)) return;
          this._open(s).catch((err) => this._finish(s, 'failed', err.message));
          return;
        }
        if (!s.paired && (code === 408 || code === undefined)) {
          // The code expired unscanned - Baileys ends a link socket itself
          // when its refs run out. Offer another, spaced like every repeated
          // WhatsApp call in this project (rule 1), and bounded by
          // maxSockets and the overall timeout.
          s.qr = null;
          s.pairingCode = null;
          s.state = 'starting';
          this._changed();
          try { await this.bot._bulkPace?.(); } catch { /* pacing is best effort here */ }
          if (myGen !== s.gen || TERMINAL.has(s.state)) return;
          this._open(s).catch((err) => this._finish(s, 'failed', err.message));
          return;
        }
        // Anything else - logged out, replaced, refused, a network failure -
        // is reported, not retried. The person at the screen can press Link
        // again; retrying on their behalf is how knocking starts.
        await this._finish(s, 'failed', `WhatsApp closed the link (${code ?? 'no reason given'})`);
      }
    });
  }

  /** The login worked. Close, then move the new session into place. */
  async _succeed(s) {
    if (TERMINAL.has(s.state)) return;
    s.state = 'finishing';
    this._changed();
    await sleep(this.settleMs);
    if (TERMINAL.has(s.state)) return;
    try { await s.saveCreds?.(); } catch { /* the creds.update handler already wrote them */ }
    s.gen += 1;                                   // silence the socket's close
    try { s.sock?.end?.(); } catch {}
    s.sock = null;

    // Checked once more at the last moment: moving a directory into place
    // under a live socket would be rule 3 by another route.
    const why = this.refusal(s.id);
    if (why) { await this._finish(s, 'failed', `linked, but not saved: ${why}`); return; }

    const target = sessionDirFor(this.dataDir, s.id);
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      // The previous session (a re-link) is kept beside it rather than
      // deleted, so a mistaken re-link can still be undone by hand.
      const previous = `${target}.previous`;
      if (fs.existsSync(target)) {
        fs.rmSync(previous, { recursive: true, force: true });
        fs.renameSync(target, previous);
      }
      fs.renameSync(s.staging, target);
    } catch (err) {
      await this._finish(s, 'failed', `linked, but the session could not be saved: ${err.message}`);
      return;
    }
    // A number that failover gave up on as logged out is usable again.
    try { this.failover?.markHealthy?.(s.id); } catch { /* status only */ }
    logger.info(`spare "${s.label}" linked — it stays disconnected until it is needed`);
    await this._finish(s, 'linked', null);
  }

  /** Tear an attempt down, whatever state it is in. Idempotent. */
  async _finish(s, state, error) {
    if (TERMINAL.has(s.state)) return;
    s.state = state;
    s.error = error;
    s.finishedAt = Date.now();
    s.qr = null;
    s.pairingCode = null;
    s.gen += 1;
    clearTimeout(s.timer);
    s.timer = null;
    const sock = s.sock;
    s.sock = null;
    try { sock?.end?.(); } catch {}
    if (state !== 'linked') this._clearStaging(s);
    if (error) logger.warn(`linking "${s.label}" ${state}: ${error}`);
    this._changed();
  }

  /**
   * Remove this attempt's staging directory, and nothing else. The path is
   * built here, never taken from a caller, and checked to be the staging path
   * for this very id - CLAUDE.md rule 5, applied to the data directory.
   */
  _clearStaging(s) {
    const dir = path.resolve(s.staging);
    const expected = path.resolve(this.stagingDirFor(s.id));
    if (dir !== expected || !path.basename(dir).startsWith('.linking-')) return;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* nothing to clear */ }
  }
}
