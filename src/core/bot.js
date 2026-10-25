import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import qrcode from 'qrcode';
import log from '../util/logger.js';
import { scanForGroupMentions, deduceTokenConvention } from './mention-scan.js';
import { HistoryBuffer, catchUpPlan } from './catch-up.js';
import { sessionDirFor, activeAccount } from './accounts.js';
import { OutboundBudget } from './outbound-budget.js';
import { diskFullSince } from '../media/disk-space.js';
import { BetaTranscript } from './beta-transcript.js';
import { formatPhone } from './members.js';
import { stamIntercept, isStamKey } from './stam-test.js';
import { baileysLogger, DecryptWatch } from './decrypt-watch.js';

const logger = log.scope('bot');

// Baileys is CommonJS-ish with a default export; import lazily so the app can
// boot (and show the web UI) even if the dependency is not installed yet.
let baileys = null;
// Exported for the background linker (spare-linker.js), so both load the one
// copy of the library.
export async function loadBaileys() {
  if (!baileys) {
    const mod = await import('@whiskeysockets/baileys');
    baileys = mod.default ?? mod;
    baileys.__ns = mod;
  }
  return baileys;
}

/**
 * Groups whose name starts with "$" are private/internal (admin back-channels).
 * They are deliberately kept out of bulk member operations so nobody is added
 * to an internal group by ticking "select all", and out of the Shabbos and yom
 * tov lockdown, which neither locks nor opens them (the operator, 2026-09-29:
 * "groups with a name starting with the $ shouldn't be part of the lockdown
 * logic just like it isn't part of the members logic").
 */
export function isPrivateGroupName(subject) {
  return String(subject ?? '').trim().startsWith('$');
}

/**
 * The message's real content type.
 *
 * Taking Object.keys(msg)[0] is wrong: group messages carry
 * `senderKeyDistributionMessage` (and sometimes `messageContextInfo`) BEFORE
 * the actual content, so every plain-text group request was typed as that and
 * the enforcement rules then deleted it as "media". Baileys uses this same
 * find() in Utils/messages.js when it needs the content key.
 */
function contentType(inner) {
  if (!inner || typeof inner !== 'object') return 'unknown';
  const keys = Object.keys(inner);
  const key = keys.find((k) => (k === 'conversation' || k.includes('Message'))
    && k !== 'senderKeyDistributionMessage'
    && k !== 'messageContextInfo');
  return key ?? keys[0] ?? 'unknown';
}

/** What a message's content says: its text, or a picture's or a video's caption. */
function textOf(inner) {
  return inner?.conversation ??
    inner?.extendedTextMessage?.text ??
    inner?.imageMessage?.caption ??
    inner?.videoMessage?.caption ??
    inner?.documentWithCaptionMessage?.message?.documentMessage?.caption ??
    '';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Pull a real phone number out of a WhatsApp JID.
 *
 * Only `@s.whatsapp.net` JIDs carry the phone number in the user part.
 * WhatsApp's newer `@lid` (linked-ID) JIDs are opaque and are NOT phone
 * numbers, so those are rejected here and recovered from a companion field.
 */
function phoneFromJid(jid) {
  if (typeof jid !== 'string' || !jid.endsWith('@s.whatsapp.net')) return null;
  const num = jid.split('@')[0].split(':')[0];
  return /^[0-9]{7,15}$/.test(num) ? num : null;
}

/**
 * Best-effort sender phone number, trying every field WhatsApp is known to
 * put it in. Under LID migration the participant JID may be a `@lid`, and the
 * real number then arrives in a parallel `...Pn` field.
 */
function senderNumberFrom(raw, key, chatJid, isGroup) {
  const candidates = [
    key.participantPn, raw.participantPn, raw.key?.participantPn,
    key.participantAlt, raw.participantAlt,
    isGroup ? (key.participant ?? raw.participant) : chatJid,
  ];
  for (const c of candidates) {
    const n = phoneFromJid(c);
    if (n) return n;
  }
  return null;
}

// The group list is the one call WhatsApp has actually rate-limited us for, so
// it gets two gates: a normal cache, and a hard floor that even a forced
// refresh cannot go under.
const GROUP_CACHE_MS = 300_000;        // 5 min - ordinary reads (UI, plugins)
const GROUP_FORCE_FLOOR_MS = 60_000;   // 1 min - the most a bulk admin run may force

// How long a new start() waits for one already in flight before going ahead
// anyway. Long enough to cover a normal connect, short enough that a hung one
// cannot lock the operator out.
const START_GATE_MS = 20_000;

// How long to wait before offering a fresh QR / pairing code after an unscanned
// one expires. This is deliberately NOT the reconnect backoff: linking is a
// person standing at the screen, not an outage to back away from, and the
// account has no session to reconnect to. Short enough that the next code
// arrives while they are still looking; long enough not to spin.
const LINK_RETRY_MS = 5_000;

// How many codes to offer before concluding nobody is coming.
//
// This bound matters as much as the fast retry it bounds. A link session that
// keeps closing would otherwise reconnect every 5 seconds for as long as the
// process lived - which is precisely the sustained knocking that got this
// number flagged in the first place. Twenty codes is roughly three quarters of
// an hour of somebody standing at the screen; past that they have walked away,
// and the ordinary backoff should take over.
const MAX_LINK_ATTEMPTS = 20;

// How long a version lookup may hold up a connection. Baileys fetches its
// protocol version from GitHub before the socket opens, with no timeout of its
// own, so a blackholed host used to stall every link attempt for the kernel's
// full TCP timeout with no QR on screen. The bundled version is a fine
// fallback; waiting is not.
const VERSION_FETCH_MS = 5_000;

// What one socket open costs against the volume budget, in message-equivalents.
// A connect is not a message, but it is the traffic WhatsApp reacted to most,
// so it should not be free.
const CONNECT_COST = 5;

// A full participant fetch across every group - the single most expensive call
// the bot makes, and the one that earned all 26 rate-limits.
const GROUP_FETCH_COST = 3;

// How long a finished upload waits for the connection to come back before its
// message is given up on (see sendDocument). The reconnects that cost
// Spaceballs and Minority Report their uploads took 5 and 6 seconds; the
// first five backoff steps together are about two minutes.
const RELAY_WAIT_MS = 120_000;

// Baileys' own temporary files for an upload: `${mediaType}${message id}-enc`
// (and `-original`) in os.tmpdir(), from encryptedStream in
// lib/Utils/messages-media.js. The id is generateMessageIDV2's "3EB0" and 18
// hex digits.
const UPLOAD_TEMP_NAME = /^[a-z-]+3EB0[0-9A-F]{18}-(?:enc|original)$/;
// Room kept spare beyond the encrypted copy itself (padding, MAC, the logs).
const UPLOAD_TEMP_SPARE = 64 * 1024 * 1024;

/**
 * Delete the encrypted upload copies an earlier process left behind.
 *
 * Baileys writes an encrypted copy of every document it sends to the temp
 * directory and deletes it when the send ends, successfully or not - but not
 * when the process stops mid-send. Every restart or crash during an upload
 * left one, and nothing removed them: on 2026-09-28 /tmp held 4.09 GB of
 * them (1.5 GB from 09-23, 1.36 GB from 09-24, two from the 06:43 and 06:44
 * stops), on the disk the work directory is on, which filled that evening.
 *
 * This is the one deletion outside the work directory (CLAUDE.md rule 5),
 * and it is narrow: regular files, directly in `dir`, named exactly as
 * Baileys names them, owned by this user, and last written before this
 * process started - so never the copy of an upload in progress. `dir` has no
 * default; src/index.js passes os.tmpdir() once, at start.
 */
export function sweepUploadLeftovers(dir, { before = Date.now() - process.uptime() * 1000 } = {}) {
  if (!dir) return 0;
  let names;
  try { names = fs.readdirSync(dir); } catch { return 0; }
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  let removed = 0;
  let bytes = 0;
  for (const name of names) {
    if (!UPLOAD_TEMP_NAME.test(name)) continue;
    const p = path.join(dir, name);
    try {
      const st = fs.lstatSync(p);
      if (!st.isFile() || st.mtimeMs >= before || (uid != null && st.uid !== uid)) continue;
      fs.unlinkSync(p);
      removed += 1;
      bytes += st.size;
    } catch { /* gone meanwhile, or not ours to remove */ }
  }
  if (removed) {
    logger.info(`removed ${removed} upload temp file(s) an earlier process left in ${dir} `
      + `(${(bytes / 1048576).toFixed(0)} MB)`);
  }
  return removed;
}

/** Bytes free to this user on the filesystem holding `dir`, or null if it cannot say. */
function freeBytesIn(dir) {
  try {
    const st = fs.statfsSync(dir);
    return st.bavail * st.bsize;
  } catch {
    return null;
  }
}

/**
 * An upload's failure, as what it was when the disk filled during it.
 *
 * The pre-flight check in sendDocument leaves room for Baileys' encrypted
 * copy, but the disk can still fill while the copy is written - another
 * job's download, or anything else on the disk. Baileys then uploads the
 * cut-short copy and ends, much later, with "Media upload failed on all
 * hosts", which says nothing about the disk: "Minority Report", 20:34 to
 * 21:07 UTC on 2026-09-28, was failed for good as if WhatsApp had refused
 * it. A full disk seen since the upload started (media/disk-space.js
 * noteDiskFull - the uncaught ENOSPC that write throws, or a job that ran
 * out of space) makes it an ENOSPC, which the pipelines wait out and retry.
 */
function uploadCutShort(err, name, since) {
  if (err?.code === 'ENOSPC' || !diskFullSince(since)) return err;
  logger.warn(`the disk filled while ${name} was uploading - its upload copy was cut short (${err?.message})`);
  return Object.assign(
    new Error(`the disk filled while ${name} was uploading, cutting its upload copy short (${err?.message})`),
    { code: 'ENOSPC', cause: err },
  );
}

// Who speaks first when several actions are waiting. A film delivery must not
// sit behind a season's worth of reactions once the budget stretches a slot to
// several seconds.
const PACE_RANK = { critical: 2, normal: 1, low: 0 };
// Waiting raises standing by one rank per PACE_AGE_MS, capped so that nothing
// can ever overtake `critical`. Late, but never abandoned.
const PACE_AGE_MS = 15_000;
const PACE_AGE_CAP = 1.9;

/**
 * Connection states surfaced to the UI:
 *   stopped | connecting | awaiting-pairing | awaiting-qr | connected | conflict | error
 */
export class WhatsAppBot extends EventEmitter {
  constructor({ configStore, dataDir }) {
    super();
    this.setMaxListeners(50);
    this.configStore = configStore;
    // What history sync and live traffic deliver, for a catch-up (catch-up.js).
    this.historyBuffer = new HistoryBuffer();
    this.dataDir = dataDir;
    // Messages their senders deleted, by id, for a day: nothing answers one.
    this.revoked = new Map();
    // Whose messages this number cannot decrypt (decrypt-watch.js): Baileys
    // names them, and its logger used to be silent.
    this.decryptWatch = new DecryptWatch({
      describe: ({ chat, sender, senderPn }) => {
        const n = phoneFromJid(senderPn) ?? phoneFromJid(sender);
        return {
          sender: n ? `${formatPhone(n)}` : String(sender ?? '?'),
          chat: chat?.endsWith('@g.us') ? `"${this.groupCache.get(chat)?.subject ?? chat}"` : String(chat ?? '?'),
        };
      },
    });
    // Failures between two of the watch's lines are written out on this
    // timer, so the hourly check counts every one (decrypt-watch.js flush).
    setInterval(() => { try { this.decryptWatch.flush(); } catch { /* never fatal */ } }, this.decryptWatch.everyMs).unref?.();
    // Resolved per connection from the active account, so each number keeps
    // its own credentials and switching back never means re-linking.
    this.authDir = sessionDirFor(dataDir, activeAccount({ whatsapp: configStore.get().whatsapp }, dataDir)?.id);
    this.sock = null;
    this.state = 'stopped';
    this.qrDataUrl = null;
    this.pairingCode = null;
    this.me = null;
    this.lastError = null;
    this.groupCache = new Map();
    this.reconnectAttempts = 0;
    // When the next reconnect is due, so the panel can show a countdown rather
    // than an indefinite "Connecting...".
    this.nextReconnectAt = null;
    // True while this connection is trying to LINK a number rather than resume
    // one: the session directory holds no credentials, so a QR or pairing code
    // is the only thing that can move it forward.
    this._linking = false;
    // Codes offered in the current link attempt, bounded by MAX_LINK_ATTEMPTS.
    this._linkAttempts = 0;
    this.stopping = false;
    this._lastGroupFetch = 0;
    this._groupTimer = null;
    this._groupFetch = null;      // the in-flight group fetch, shared by concurrent callers
    this._starting = null;        // the in-flight start(), so two cannot open sockets at once
    this._paceWaiting = [];       // callers waiting their turn to speak
    this._paceSeq = 0;            // arrival order, to break ties fairly
    this._pacing = false;

    // The volume ceiling. Pacing controls the GAP between actions; this is the
    // only thing that caps the TOTAL, which is what WhatsApp actually punished.
    this.budget = new OutboundBudget({
      getConfig: () => this.config.whatsapp?.budget ?? {},
      log: logger,
    });
    this._budgetFile = path.join(dataDir, 'outbound-budget.json');
    this._loadBudget();
    // Flushed on a clean stop too, but a crash is exactly when a volume ceiling
    // matters most, so it is also written periodically. unref'd: this must
    // never be the reason the process stays alive.
    this._budgetTimer = setInterval(() => this.saveBudget(), 60_000);
    this._budgetTimer.unref?.();
    this._lastActionAt = 0;
    // Each socket gets a generation number. Handlers from an older socket must
    // not act: a stale close handler rescheduling start() is what produced an
    // endless 4-second reconnect loop that killed each healthy socket in turn.
    this._gen = 0;
    this._reconnectTimer = null;
    // Set by src/index.js when background linking of spares is available.
    this.spareLinker = null;
    // Every beta group's conversation, word for word, for the hourly check
    // (beta-transcript.js). Here, where every send, edit and reaction passes,
    // so nothing a plugin says in a test group can miss it.
    this.transcript = new BetaTranscript({
      dataDir,
      getConfig: () => this.config,
      groupName: (jid) => this.groupCache.get(jid)?.subject ?? null,
      log: logger,
    });
  }

  /** Hands one event to the beta transcript; never the reason a send fails. */
  _transcribe(what, jid, detail) {
    try { this.transcript?.[what]?.(jid, detail); } catch (err) { logger.debug(`beta transcript: ${err.message}`); }
  }

  /** Cancel any scheduled reconnect - a newer connection has superseded it. */
  _clearReconnect() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  get config() { return this.configStore.get(); }

  _setState(state, extra = {}) {
    this.state = state;
    this.emit('state', this.status());
    logger.info(`state -> ${state}${extra.detail ? ` (${extra.detail})` : ''}`);
  }

  status() {
    // `me` is who we are CONNECTED as, and is null while stopped. `account` is
    // which number is SELECTED, which is what a disconnected panel needs to
    // show - "link as X" is unanswerable from `me` alone.
    let account = null;
    try {
      const acct = activeAccount(this.config, this.dataDir);
      if (acct) {
        account = {
          id: acct.id,
          label: acct.label,
          phoneNumber: acct.phoneNumber ?? '',
          linked: !!acct.linked,
        };
      }
    } catch { /* config unreadable; the rest of the status still stands */ }

    return {
      state: this.state,
      me: this.me,
      account,
      qr: this.qrDataUrl,
      pairingCode: this.pairingCode,
      lastError: this.lastError,
      reconnectAttempts: this.reconnectAttempts,
      // When the next attempt is due, and whether this is a person linking a
      // number rather than the bot recovering. Both exist so "Connecting..."
      // can say what it is actually waiting for - a silent fifteen-minute
      // wait is why re-linking felt broken.
      nextReconnectAt: this.nextReconnectAt,
      linking: this._linking,
      groupCount: this.groupCache.size,
      // So a deliberate slowdown reads as a slowdown in the panel rather than
      // looking like the bot has gone wrong.
      budget: this.budget.snapshot(),
    };
  }

  isConnected() {
    return this.state === 'connected' && !!this.sock;
  }

  /** Wipe the linked-device session so a fresh number can be paired. */
  async logout({ wipe = true } = {}) {
    this.stopping = true;
    this._gen++;
    this._clearReconnect();
    clearTimeout(this._groupTimer);
    try { await this.sock?.logout(); } catch {}
    try { this.sock?.end?.(); } catch {}
    this.sock = null;
    if (wipe && fs.existsSync(this.authDir)) {
      fs.rmSync(this.authDir, { recursive: true, force: true });
      logger.warn('session wiped');
    }
    this.me = null;
    this.qrDataUrl = null;
    this.pairingCode = null;
    // A wipe is the start of a fresh link, not the continuation of an outage.
    // Leaving the counter where the failing session left it meant the first
    // re-link attempt inherited a backoff of up to fifteen minutes - and
    // failover, which reads the same number, could switch the account away
    // before a QR was ever drawn.
    this.reconnectAttempts = 0;
    this.nextReconnectAt = null;
    this._linkAttempts = 0;
    this._setState('stopped');
    this.stopping = false;
  }

  /**
   * Stop deliberately. `reason` is recorded so a watcher can tell an operator
   * pressing Disconnect apart from the connection dying - they are the same
   * 'stopped' state otherwise, and treating one as the other is what turned a
   * single logout into hundreds of pointless number switches.
   */
  async stop({ reason = 'stopped by request' } = {}) {
    this.stopping = true;
    this._gen++;                 // orphan any in-flight socket handlers
    this._clearReconnect();
    clearTimeout(this._groupTimer);
    try { this.sock?.end?.(); } catch {}
    this.sock = null;
    this.saveBudget();           // a restart must not wipe the volume ceiling
    this.lastError = null;       // a deliberate stop is not a failure
    this.stoppedReason = reason;
    // Same reasoning as logout(): whatever the operator does next is a fresh
    // attempt and must not inherit the old one's backoff. And a code that is
    // no longer being offered must not stay on screen - the panel renders
    // whatever is here, so a stale QR reads as a live one.
    this.reconnectAttempts = 0;
    this.nextReconnectAt = null;
    this._linkAttempts = 0;
    this.qrDataUrl = null;
    this.pairingCode = null;
    // A stopped bot is not signed in as anyone. Leaving this set made the
    // dashboard keep showing the PREVIOUS number after switching accounts, so
    // a switch that had worked looked like it had been ignored.
    this.me = null;
    this._setState('stopped');
    this.stopping = false;
  }

  /**
   * Open a connection, one at a time.
   *
   * _start() awaits several times - loading Baileys, reading the auth state,
   * fetching the protocol version over the network - before it ever assigns
   * this.sock. Two concurrent callers therefore both saw sock === null, both
   * sailed past the "already exists" guard, and both opened a socket. The
   * generation counter orphans the loser's handlers but cannot un-open its
   * connection, and two live sockets on one account is precisely what
   * connectionReplaced punishes. That is the 168 overlap warnings in the logs.
   *
   * Four callers reach here with nothing shared between them: the reconnect
   * loop (which backs off), plus boot auto-connect, the portal Connect button
   * and an account switch (which do not). The gate belongs here, so all four
   * inherit it rather than three of them being fixed one at a time.
   */
  async start() {
    // A CHAIN, not a single flag. Several callers waiting on one shared gate
    // all wake together the moment it resolves, which reproduces the very
    // overlap this is meant to prevent - three concurrent starts became one,
    // then two at once. Each call must queue behind the previous one.
    const prev = this._starting;
    const run = (async () => {
      // Bounded on purpose: a start hung on a network fetch must not lock out
      // every later connect attempt, including the operator's own button.
      if (prev) await Promise.race([prev, sleep(START_GATE_MS)]);
      return this._start();
    })();
    // Kept even once settled: a resolved link costs nothing and the next
    // caller passes straight through, whereas clearing it reopens the race.
    this._starting = run.then(() => {}, () => {});
    return run;
  }

  async _start() {
    // Supersede any older socket AND any reconnect it may have queued, before
    // touching the existing socket - otherwise ending it fires a close handler
    // that schedules yet another start(), and the two chains feed each other.
    const myGen = ++this._gen;
    this._clearReconnect();
    if (this.sock) {
      logger.warn('start() called while a socket already exists; restarting');
      try { this.sock.end?.(); } catch {}
      this.sock = null;
    }
    this.stopping = false;
    this.lastError = null;
    this._appStateSyncTried = false;   // a fresh connection gets a fresh attempt
    this._setState('connecting');

    let B;
    try {
      B = await loadBaileys();
    } catch (err) {
      this.lastError = `Baileys not installed: ${err.message}. Run: npm install`;
      this._setState('error');
      return;
    }

    const { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason, Browsers } = {
      ...B,
      ...B.__ns,
    };

    // Re-resolve every time: an account switch between connections must take
    // effect without restarting the process.
    const acct = activeAccount(this.config, this.dataDir);
    this.authDir = sessionDirFor(this.dataDir, acct?.id);
    this.activeAccountId = acct?.id ?? 'default';
    logger.info(`using account "${acct?.label ?? 'default'}" (${this.authDir})`);
    // The bot's own connection always wins. A background link of this same
    // number (spare-linker.js) would otherwise finish by moving a new session
    // into the directory this socket is about to use - two sessions for one
    // number, which is rule 3 however it comes about. The routes and failover
    // already refuse that combination; this catches any path they do not.
    if (this.spareLinker?.isLinking?.(this.activeAccountId)) {
      await this.spareLinker.cancel(this.activeAccountId, 'the bot is connecting as this number');
      if (myGen !== this._gen) return;
    }
    fs.mkdirSync(this.authDir, { recursive: true });
    const { state: authState, saveCreds } = await useMultiFileAuthState(this.authDir);

    // No credentials means this connection exists solely to show somebody a
    // code. Recorded before the socket opens, because the close handler needs
    // it to tell an unscanned QR apart from a dropped connection.
    this._linking = !authState.creds?.registered;

    let version;
    try {
      ({ version } = await fetchLatestBaileysVersion({ timeout: VERSION_FETCH_MS }));
      logger.info(`using WhatsApp Web version ${version.join('.')}`);
    } catch (err) {
      logger.warn(`could not fetch WA version, using library default: ${err.message}`);
    }

    const cfg = this.config.whatsapp;
    const usePairing = cfg.loginMethod === 'pairing' && !authState.creds.registered;
    const needsAppStateKey = !authState.creds?.myAppStateKeyId;
    if (needsAppStateKey) {
      logger.info('no app-state key yet - syncing history this session so WhatsApp shares one (needed to archive/delete chats)');
    }

    // Count the connection itself.
    //
    // 6,136 socket opens in twelve days, 935 in the worst single hour - by far
    // the largest source of traffic in the logs, and the one most associated
    // with the six real logouts. It cannot be gated at _requireSock() because
    // it happens BEFORE a socket exists, and it must not be blocked: refusing
    // to reconnect turns a rate problem into an outage.
    //
    // So it is counted but never refused. A reconnect storm visibly spends the
    // budget, and the message side slows and sheds in response rather than
    // piling more traffic on top of an account already knocking repeatedly.
    // Weighted heavily because a connect costs far more standing than a
    // reaction does.
    this.budget.record(CONNECT_COST);

    this.sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: authState,
      // Identifies as a normal linked desktop client, which is what this is.
      browser: Browsers ? Browsers.ubuntu('Desktop') : ['Ubuntu', 'Desktop', '22.04'],
      printQRInTerminal: false,
      // Silent but for decrypt failures, which name the chat and sender the
      // libsignal errors in the journal never do (decrypt-watch.js).
      logger: (this._baileysLog ??= baileysLogger((f) => this.decryptWatch.record(f))),
      markOnlineOnConnect: !!cfg.markOnline,
      // WhatsApp only hands over the app-state key during an initial history
      // sync: with syncFullHistory off, shouldSyncHistoryMessage() returns
      // false, the connection goes straight to Online instead of Syncing, and
      // the appStateSyncKeyShare handler (gated on Syncing) never fires. Without
      // that key every chatModify - deleting or archiving a chat - is rejected.
      // So sync history exactly until we have the key, then go back to
      // lightweight connections.
      syncFullHistory: needsAppStateKey,
      generateHighQualityLinkPreview: false,
      retryRequestDelayMs: 1000,
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', async (update) => {
      // A superseded socket must stay silent; acting here is what looped.
      if (myGen !== this._gen) return;
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        if (usePairing) {
          // Pairing mode: the phone gets a code to type, no QR scanning.
          this.qrDataUrl = null;
        } else {
          this.qrDataUrl = await qrcode.toDataURL(qr, { margin: 1, width: 320 });
          this._setState('awaiting-qr');
        }
      }

      if (connection === 'open') {
        this._clearReconnect();
        this.reconnectAttempts = 0;
        this.nextReconnectAt = null;
        this._linking = false;
        this._linkAttempts = 0;
        this.qrDataUrl = null;
        this.pairingCode = null;
        // A connection that worked clears the last failure. Leaving it set was
        // catastrophic: stop() reports state 'stopped' without touching it, so
        // one genuine logout left lastError saying "loggedOut" forever, and
        // every later stop - including the deliberate one inside a number
        // switch - looked like a fresh logout. The supervisor then condemned
        // each healthy number in turn: 5 real logouts produced 930 "logged
        // out" markings and 929 failovers.
        this.lastError = null;
        this.me = {
          id: this.sock.user?.id ?? null,
          name: this.sock.user?.name ?? this.sock.user?.verifiedName ?? null,
        };
        this._setState('connected');
        // WhatsApp rate-limits group enumeration hard right after connecting,
        // so give it a moment rather than asking straight away.
        this.scheduleGroupRefresh(6000);
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const reasonName = Object.entries(DisconnectReason ?? {})
          .find(([, v]) => v === statusCode)?.[0] ?? String(statusCode ?? 'unknown');
        this.lastError = `disconnected: ${reasonName}`;
        logger.warn(`connection closed (${reasonName})`);

        this.sock = null;
        // The code on screen died with the socket. It was never cleared here,
        // so the panel kept rendering an expired QR - and an expired pairing
        // code, which renderStatus preferred over the QR, could hide the live
        // one entirely. Whatever comes next will publish its own.
        this.qrDataUrl = null;
        this.pairingCode = null;

        if (this.stopping) return;

        if (statusCode === DisconnectReason?.loggedOut) {
          logger.error('logged out on the phone - session wiped, re-link required');
          try { fs.rmSync(this.authDir, { recursive: true, force: true }); } catch {}
          this.me = null;
          this._setState('stopped');
          return;
        }

        if (statusCode === DisconnectReason?.connectionReplaced) {
          // Another WhatsApp Web session took over this slot.
          this._setState('conflict');
          return;
        }

        if (this.config.whatsapp.autoReconnect) {
          // An unscanned QR is not an outage.
          //
          // Baileys ends a link session itself once its ref list runs out -
          // roughly 140 seconds - with statusCode 408, which is
          // indistinguishable here from a network failure. Counted as one, it
          // fed the exponential backoff below, so an operator who missed two
          // or three QR windows was then told nothing for a quarter of an
          // hour while the panel sat on "Connecting...". That is the
          // "sometimes the QR never shows" report.
          //
          // The account has no credentials yet, so there is nothing to
          // reconnect TO: this is a human standing at the screen waiting to be
          // shown a code, and the right answer is another code, promptly. The
          // ban-risk ceiling still governs every other close reason.
          if (this._linking && this._linkAttempts < MAX_LINK_ATTEMPTS) {
            this._linkAttempts += 1;
            this._clearReconnect();
            const delay = LINK_RETRY_MS;
            logger.info(`link attempt expired - showing a fresh code in ${Math.round(delay / 1000)}s `
              + `(${this._linkAttempts}/${MAX_LINK_ATTEMPTS})`);
            this.nextReconnectAt = Date.now() + delay;
            this._setState('connecting');
            this._reconnectTimer = setTimeout(() => {
              this._reconnectTimer = null;
              this.nextReconnectAt = null;
              if (this.stopping || myGen !== this._gen) return;
              this.start().catch((e) => logger.error(`re-link failed: ${e.message}`));
            }, delay);
            this._reconnectTimer.unref?.();
            return;
          }
          if (this._linking) {
            // Nobody scanned twenty codes. Stop offering them quickly and fall
            // through to the ordinary backoff, so an abandoned link attempt
            // does not knock on WhatsApp every five seconds indefinitely.
            logger.warn(`${MAX_LINK_ATTEMPTS} codes went unscanned - backing off. `
              + 'Press Link / Connect when you are ready with the phone.');
            this._linking = false;
          }

          this.reconnectAttempts += 1;
          // The backoff used to plateau at 60s and stay there for as long as
          // the outage lasted - 169 reconnects in a single day, which is the
          // sustained pattern WhatsApp flags. It now keeps doubling to a much
          // larger ceiling: a blip still recovers in seconds, but a genuine
          // outage settles to a knock every few minutes instead of every
          // minute, for as long as it takes.
          const ceiling = Math.max(60_000, Number(this.config.whatsapp?.maxReconnectDelayMs ?? 900_000));
          const backoff = Math.min(ceiling, 2_000 * 2 ** Math.min(this.reconnectAttempts, 10));
          // A little jitter, so a fleet of reconnecting clients does not all
          // knock on the same second.
          const delay = Math.round(backoff * (0.85 + Math.random() * 0.3));
          logger.info(`reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempts})`);
          // Published in status() so the panel can count down instead of
          // showing a bare "Connecting..." for fifteen minutes.
          this.nextReconnectAt = Date.now() + delay;
          this._setState('connecting');
          this._clearReconnect();
          this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            this.nextReconnectAt = null;
            // Re-check: another socket may have connected while we waited, in
            // which case reconnecting would tear down a working connection.
            if (this.stopping || myGen !== this._gen) return;
            this.start().catch((e) => logger.error(`reconnect failed: ${e.message}`));
          }, delay);
          this._reconnectTimer.unref?.();
        } else {
          this._setState('stopped');
        }
      }
    });

    // A member's reaction arrives here too, as a message whose content is a
    // reactionMessage (normalize() gives it msg.reaction), and it is handed
    // to the plugins like any message: the movie plugin takes a keycap number
    // on a "which one?" list as a pick (the operator, 2026-10-01: "for
    // beta001 users should be able to react with a number emoji instead of
    // replying"). Baileys (6.7.x) also emits every reaction a second time as
    // 'messages.reaction', from processMessage; that event is deliberately not
    // listened to, so each reaction is dispatched once, and with the same
    // 'notify'/'append' rule as every other message - a reaction made while
    // the bot was offline is backlog, exactly as a typed number would be.
    // async, as the handler always was: whatever one message throws becomes a
    // rejected promise here, never an exception inside Baileys' own emit.
    this.sock.ev.on('messages.upsert', async (upsert) => this._onMessagesUpsert(upsert));

    // These fire often - every subject change, every participant edit.
    // Coalesce them into one refresh rather than one call per event.
    // Admin activity feed: joins/leaves/removals/promotions with the actor.
    this.sock.ev.on('group-participants.update', (u) => {
      try {
        this.emit('group-event', {
          ts: Date.now(),
          groupJid: u.id,
          groupName: this.groupCache.get(u.id)?.subject ?? u.id,
          action: u.action,
          actor: u.author ?? null,
          actorNumber: u.author ? this.numberFromJid(u.author) : null,
          targets: (u.participants ?? []).map((pj) => ({ jid: pj, number: this.numberFromJid(pj) })),
        });
      } catch (err) { logger.warn(`group-event capture failed: ${err.message}`); }
      this.scheduleGroupRefresh(15_000);
    });
    this.sock.ev.on('group.join-request', (u) => {
      const who = u.participant ?? u.author ?? null;
      this.emit('group-event', {
        ts: Date.now(), groupJid: u.id ?? u.jid ?? null,
        groupName: this.groupCache.get(u.id ?? u.jid)?.subject ?? (u.id ?? u.jid),
        action: 'join-request', actor: who, actorNumber: this.numberFromJid(who ?? ''),
        targets: [{ jid: who, number: this.numberFromJid(who ?? '') }],
      });
    });

    // On-demand history sync arrives here; it is the richest source of real
    // group-mention examples from this account.
    this.sock.ev.on('messaging-history.set', ({ messages }) => {
      if (messages?.length) {
        logger.info(`history sync delivered ${messages.length} message(s)`);
        this._captureMentionSamples(messages);
        this.historyBuffer.add(messages);
      }
    });

    this.sock.ev.on('groups.upsert', () => this.scheduleGroupRefresh(30_000));
    this.sock.ev.on('groups.update', (updates) => {
      // An admin opening a group in WhatsApp lifts a spam lock (spam-guard.js).
      for (const u of updates ?? []) {
        if (u?.id && u.announce === false) {
          try { this.emit('group-opened', { jid: u.id, by: u.author ?? null }); } catch (err) { logger.warn(`group-opened: ${err.message}`); }
        }
      }
      this.scheduleGroupRefresh(120_000);
    });

    if (usePairing) {
      const phone = String(cfg.phoneNumber || '').replace(/[^0-9]/g, '');
      if (!phone) {
        this.lastError = 'Set your WhatsApp phone number in Settings before linking.';
        this._setState('error');
        return;
      }
      this._setState('awaiting-pairing');
      // The socket needs a moment to establish before it can request a code.
      await sleep(3000);
      try {
        const code = await this.sock.requestPairingCode(phone);
        this.pairingCode = code?.match(/.{1,4}/g)?.join('-') ?? code;
        logger.info(`pairing code issued for +${phone}: ${this.pairingCode}`);
        this.emit('state', this.status());
      } catch (err) {
        this.lastError = `Could not request pairing code: ${err.message}`;
        this._setState('error');
      }
    }
  }

  /** New messages from WhatsApp, each handed on as a 'message' event. */
  _onMessagesUpsert({ messages, type } = {}) {
    // Kept before the filter: a catch-up needs the backfill, and the bot's own
    // replies, to tell which requests were answered.
    this.historyBuffer?.add(messages);
    if (type !== 'notify') return;   // ignore history backfill
    for (const raw of messages ?? []) {
      this._noteRevoke(raw);
      this._captureMentionSamples([raw]);
      const msg = this.normalize(raw);
      if (!msg) continue;
      // A reaction taken off (WhatsApp sends it as an empty one) means
      // nothing to anyone here: no plugin acts on it, and it is not a
      // message a member sent.
      if (msg.reaction && !msg.reaction.emoji) {
        logger.debug(`a reaction was taken off ${msg.reaction.targetId ?? '?'} in ${msg.chatJid} - ignored`);
        continue;
      }
      try { this.transcript?.inbound(msg); } catch (err) { logger.debug(`beta transcript: ${err.message}`); }
      this.emit('message', msg);
    }
  }

  /**
   * A member deleting a message, noted so nothing answers it.
   *
   * 2026-10-09 08:08 UTC: Ari (+1555***0178) sent "#request friren:beyond
   * journeys end", deleted it six seconds later and sent it again with "s1".
   * The bot went on with the deleted one and asked "which season?" at
   * 08:09:02 - quoting a message no longer in the group, under the one that
   * said s1 - and the operator's reading was "he literally wrote s1". A
   * delete is a protocolMessage of type REVOKE (0, which protobuf may leave
   * unset) naming the message; an edit (MESSAGE_EDIT) also names one, and is
   * not a delete.
   */
  _noteRevoke(raw) {
    const pm = raw?.message?.protocolMessage;
    if (!pm?.key?.id) return;
    if (!(pm.type == null || pm.type === 0 || pm.type === 'REVOKE')) return;
    const now = Date.now();
    this.revoked ??= new Map();
    for (const [id, at] of this.revoked) if (now - at > 24 * 3600_000) this.revoked.delete(id); else break;
    this.revoked.set(pm.key.id, now);
    if (this.revoked.size > 1000) this.revoked.delete(this.revoked.keys().next().value);
    logger.info(`a message was deleted in ${pm.key.remoteJid ?? raw.key?.remoteJid ?? '?'}: ${pm.key.id} - nothing will answer it`);
  }

  /** Was this message deleted by its sender (see _noteRevoke)? */
  isRevoked(id) {
    return !!id && !!this.revoked?.has(id);
  }

  /** Flatten a Baileys message into a stable shape plugins can rely on. */
  normalize(raw) {
    if (!raw?.message) return null;
    const key = raw.key ?? {};
    const chatJid = key.remoteJid;
    if (!chatJid || chatJid === 'status@broadcast') return null;

    const isGroup = chatJid.endsWith('@g.us');
    const inner = raw.message.ephemeralMessage?.message
      ?? raw.message.viewOnceMessage?.message
      ?? raw.message.viewOnceMessageV2?.message
      ?? raw.message;

    const text = textOf(inner);

    const senderJid = isGroup ? (key.participant ?? raw.participant ?? null) : chatJid;
    const senderNumber = senderNumberFrom(raw, key, chatJid, isGroup);

    // A reaction: which emoji, on which message. It has no text, and the
    // member who reacted is the sender, as for anything they send. The
    // target is matched by its id; `targetFromMe` is Baileys' view of whether
    // the target is ours, which in a group addressed by @lid it can get wrong
    // (cleanMessage compares the target's participant with our phone JID), so
    // nothing is decided on it alone. An empty emoji is a reaction taken off.
    const r = inner.reactionMessage;
    const reaction = r ? {
      emoji: String(r.text ?? ''),
      targetId: r.key?.id ?? null,
      targetFromMe: !!r.key?.fromMe,
    } : null;

    // A member editing a message of theirs: which one, and what it says now.
    // WhatsApp sends it as a protocolMessage of type MESSAGE_EDIT (14),
    // which its apps wrap in editedMessage, and Baileys hands the new text on
    // only as 'messages.update', which nothing here listens to - so Head
    // Admin's message edited into an #issue, or an #issue whose details she
    // added by an edit, was never read (found in review, 2026-10-12). The
    // edit's own text stays empty: no plugin is to take an edit for a new
    // request. library-news.js keeps it.
    const pm = inner.protocolMessage ?? inner.editedMessage?.message?.protocolMessage;
    const edit = pm?.key?.id && pm.editedMessage && (pm.type === 14 || pm.type === 'MESSAGE_EDIT')
      ? { targetId: pm.key.id, text: String(textOf(pm.editedMessage) || '').trim() }
      : null;

    // A reply: the message it answers, and what that said. Head Admin's
    // "#issue #group04" (2026-10-18) was a reply to a member's message about
    // episodes the bot had said were not in the library; the bot kept only
    // her two words, and the hourly check researched the wrong request. The
    // operator: "had bot paid attention I was replying to a users message
    // above". library-news.js keeps it on the row.
    const ci = inner[contentType(inner)]?.contextInfo;
    const replyTo = ci?.stanzaId ? {
      id: ci.stanzaId,
      senderJid: ci.participant ?? null,
      senderNumber: phoneFromJid(ci.participant) ?? null,
      text: String(textOf(ci.quotedMessage) || '').trim(),
    } : null;

    // Number extraction is validated against real LID traffic, so only log
    // when it FAILS - otherwise every group message spams the debug log and
    // buries the pipeline milestones.
    if (isGroup && !key.fromMe && !senderNumber) {
      log.scope('bot').debug(
        `could not resolve sender number: participant=${key.participant ?? '-'} ` +
        `participantPn=${key.participantPn ?? raw.participantPn ?? '-'}`,
      );
    }

    return {
      id: key.id,
      key,
      chatJid,
      isGroup,
      fromMe: !!key.fromMe,
      senderJid,
      senderNumber,
      senderNumberDisplay: formatPhone(senderNumber),
      pushName: raw.pushName ?? null,
      text: String(text || '').trim(),
      timestamp: Number(raw.messageTimestamp ?? 0) * 1000,
      messageType: contentType(inner),
      ...(reaction ? { reaction } : {}),
      ...(edit ? { edit } : {}),
      ...(replyTo ? { replyTo } : {}),
      // Who the message @-mentions: the discussions agent answers a message
      // that mentions the bot (src/core/discussion-answers.js).
      ...(ci?.mentionedJid?.length ? { mentionedJids: ci.mentionedJid } : {}),
      raw,
    };
  }

  /**
   * How long to wait between repetitions of a bulk action.
   *
   * Bulk repetition is what WhatsApp rate-limits, so every such loop goes
   * through here rather than carrying its own hand-picked number - that is how
   * message revokes ended up at 400ms, about ten times faster than a person
   * could do it.
   */
  _bulkDelay(kind = 'bulk') {
    const w = this.config.whatsapp ?? {};
    const v = {
      bulk: w.bulkPacingMs ?? 4000,
      revoke: w.revokePacingMs ?? 2500,
      broadcast: w.broadcastPacingMs ?? 8000,
    }[kind] ?? w.bulkPacingMs ?? 4000;
    return Math.max(0, Number(v) || 0);
  }

  /** Wait out the bulk pacing for `kind`. */
  async _bulkPace(kind = 'bulk') {
    // Bulk work counts against the volume ceiling like anything else. It is
    // recorded here rather than in _gate() because the loop supplies its own,
    // much slower, pacing and must not be delayed twice.
    this.budget.record();

    // And it SLOWS with the budget too. Recording bulk work without slowing it
    // would invert the whole point: bulk group operations are the volume that
    // actually earns rate-limits, so a budget that let them fill the hour and
    // then paid for it by dropping queue-position reactions would be throttling
    // the wrong thing entirely. Here the stretch lands on the traffic that
    // caused it.
    const ms = this._bulkDelay(kind) * (this.budget?.stretch?.() ?? 1);
    if (ms > 0) await sleep(ms);
  }

  /** Space out outbound actions so the bot does not flood a group. */
  /**
   * Space out actions so the account does not fire in bursts.
   *
   * This has to SERIALISE, not merely delay. The previous version read
   * _lastActionAt, awaited, and only then wrote it - so two concurrent callers
   * both read the same timestamp, both computed the same wait, and both fired
   * at the end of it. Every caller that ran in parallel bypassed the pacing
   * completely, which is most of them: three queue jobs each reacting and
   * notifying, plus enforcement, all overlap.
   *
   * Each call now chains onto the last, so N callers take N gaps.
   */
  /**
   * Wait for this account's turn to speak.
   *
   * Serialised, so concurrent callers are spaced out rather than firing
   * together - a plain "read the clock, await, write the clock" collapses under
   * concurrency and paces nothing at all.
   *
   * Ordered by PRIORITY rather than arrival. Strict arrival order was fine at
   * the 1.2-3.5s base pace, but the budget can stretch a slot to 14s, and a
   * film delivery arriving behind a season's worth of reactions would then wait
   * minutes. Presidential priority is enforced when jobs are picked
   * (queue.js) and was being quietly undone here, at the wire.
   *
   * Waiting raises a caller's standing, so `low` work becomes late but is never
   * abandoned - the aging is capped just below `critical` so nothing can
   * overtake a person who is waiting.
   */
  async _pace(kind = 'normal') {
    const { minActionDelayMs: min = 0, maxActionDelayMs: max = 0 } = this.config.whatsapp;
    if (max <= 0) return;

    return new Promise((resolve) => {
      this._paceWaiting.push({
        rank: PACE_RANK[kind] ?? PACE_RANK.normal,
        at: Date.now(),
        seq: this._paceSeq += 1,
        resolve,
      });
      this._drainPace();
    });
  }

  /** Release one waiter at a time, highest standing first. */
  _drainPace() {
    if (this._pacing) return;
    this._pacing = true;

    const step = async () => {
      if (!this._paceWaiting.length) { this._pacing = false; return; }

      const now = Date.now();
      const standing = (w) => w.rank + Math.min(PACE_AGE_CAP, (now - w.at) / PACE_AGE_MS);
      // Highest standing wins; equals keep their arrival order, so the
      // requester who asked first is still served first.
      this._paceWaiting.sort((a, b) => standing(b) - standing(a) || a.seq - b.seq);
      const next = this._paceWaiting.shift();

      const { minActionDelayMs: min = 0, maxActionDelayMs: max = 0 } = this.config.whatsapp;
      // The budget stretches this as the hour fills, so the bot slows into its
      // ceiling instead of sprinting at it and stopping dead. A gradual
      // slowdown looks like a busy person; a hard stop looks like a fault.
      const stretch = this.budget?.stretch?.() ?? 1;
      const wait = (min + Math.random() * Math.max(0, max - min)) * stretch;
      const remaining = wait - (Date.now() - this._lastActionAt);
      if (remaining > 0) await sleep(remaining);
      this._lastActionAt = Date.now();

      next.resolve();
      step();
    };

    step();
  }

  /**
   * The single gate every outbound action passes through.
   *
   * Returns false when the action must be DROPPED - which only ever happens to
   * work nobody is waiting on. A caller that is told false has nowhere to put
   * the action and should simply not do it; a queue-position reaction is
   * superseded by the next one anyway.
   *
   * @param {'critical'|'normal'|'low'} kind
   */
  async _gate(kind = 'normal') {
    if (!this.budget.allows(kind)) return false;
    await this._pace(kind);
    this.budget.record();
    return true;
  }

  /** Persist the budget so a restart - or a crash loop - cannot wipe it. */
  _loadBudget() {
    try {
      if (fs.existsSync(this._budgetFile)) {
        this.budget.restore(JSON.parse(fs.readFileSync(this._budgetFile, 'utf8')));
      }
    } catch { /* a corrupt file just means starting from zero */ }
  }

  saveBudget() {
    try {
      fs.writeFileSync(this._budgetFile, JSON.stringify(this.budget.toJSON()));
    } catch (err) {
      logger.debug(`could not save the outbound budget: ${err.message}`);
    }
  }

  _requireSock() {
    if (!this.sock || this.state !== 'connected') {
      throw new Error('WhatsApp is not connected');
    }
    return this.sock;
  }

  /**
   * `unless` is asked once this reaction's turn to be sent comes round, which
   * the pacer can make many seconds after it was asked for; true drops it.
   * A queue-position number asked for just before its request started would
   * otherwise land AFTER the ⬇️ that overtook it in the pacer, and sit on top
   * of it through the whole download. The gate has counted it by then, which
   * errs the budget toward sending less, never more.
   */
  async react(msg, emoji, { kind = 'normal', unless = null } = {}) {
    // Nothing to react to: a job queued from the panel carries a placeholder
    // message ("manual-1790263529080") with no key. Sent anyway, the reaction
    // went out with key: null, and Baileys then threw while echoing it back to
    // itself (stringifyMessageKey, "Cannot read properties of null (reading
    // 'remoteJid')"), in a promise nothing of ours holds - 24 unhandled
    // rejections on 2026-09-28, 23 of them as the 01:36 restart resumed
    // panel-queued films. Refused here, the one place every reaction passes
    // through, so no caller can put a keyless reaction on the wire.
    if (!msg?.key?.id || !msg.key.remoteJid) {
      logger.debug(`not reacting ${emoji} on ${msg?.id ?? '(no message)'}: no WhatsApp message behind it`);
      return false;
    }
    // Never on a member's reaction. Since reactions reach the plugins (picks
    // by reaction, 2026-10-01), a path that answers "the message" could be
    // handed one; a reaction on a reaction is meaningless to the member and
    // one more action on the wire. Refused here, where every reaction passes.
    if (msg.reaction || msg.messageType === 'reactionMessage') {
      logger.debug(`not reacting ${emoji} on ${msg.id}: it is a member's reaction, not a message`);
      return false;
    }
    // Deleted by its sender (_noteRevoke): a reaction would land on nothing.
    if (this.isRevoked(msg.key.id)) {
      logger.info(`not reacting ${emoji} on ${msg.key.id}: its sender deleted it`);
      return false;
    }
    // A $stamtest is answered in one message at the end (stam-test.js): the
    // reaction is noted for it, not sent.
    const stam = stamIntercept('react', { emoji, jid: msg.key.remoteJid });
    if (stam) return stam;
    const sock = this._requireSock();
    // Shed-able: a lifecycle reaction is useful but nobody is blocked on it,
    // and a queue-position update (kind 'low') is superseded by the next one.
    if (!(await this._gate(kind))) return false;
    if (unless?.()) return false;
    await sock.sendMessage(msg.chatJid, { react: { text: emoji, key: msg.key } });
    logger.debug(`reacted ${emoji} on ${msg.id}`);
    this._transcribe('reacted', msg.chatJid, { on: msg.key.id, emoji });
    // Returns whether it actually went. A caller that records "I already showed
    // them this" must key that on the ANSWER, not on having asked - see
    // _updatePositions.
    return true;
  }

  /**
   * @param mentions       person JIDs to @-mention (text must contain @number)
   * @param groupMentions  [{ groupJid, groupSubject }] - tappable group links,
   *                       which WhatsApp only renders for groups in the same
   *                       community. The text must contain the matching
   *                       @<jid-local-part> token (see groupMentionToken).
   */
  async sendText(jid, text, { quoted = null, mentions = null, groupMentions = null, kind = 'critical' } = {}) {
    // An answer to a message its sender deleted (_noteRevoke) answers nothing
    // they still asked, and quotes a message the group no longer has.
    const answering = quoted?.key?.id ?? quoted?.id ?? null;
    if (this.isRevoked(answering)) {
      logger.info(`not answering ${answering}: its sender deleted it - "${String(text).slice(0, 80).replace(/\s+/g, ' ')}"`);
      return null;
    }
    const stam = stamIntercept('text', { jid, text, quoted: !!quoted });
    if (stam) return stam;
    const sock = this._requireSock();
    if (!(await this._gate(kind))) return null;
    const content = { text };
    if (mentions?.length) content.mentions = mentions;
    if (groupMentions?.length) {
      content.contextInfo = {
        ...(content.contextInfo ?? {}),
        groupMentions: groupMentions.map((g) => ({
          groupJid: g.groupJid,
          groupSubject: g.groupSubject ?? this.groupCache.get(g.groupJid)?.subject ?? '',
        })),
      };
    }
    const replyTo = quoted?.key?.id ?? quoted?.id ?? null;
    let sent;
    try {
      sent = await sock.sendMessage(jid, content, quoted ? { quoted: quoted.raw } : {});
    } catch (err) {
      this._transcribe('failed', jid, { action: 'send', replyTo, error: err.message });
      throw err;
    }
    this._transcribe('sent', jid, { id: sent?.key?.id ?? null, text, replyTo });
    return sent;
  }

  /**
   * Rewrite the text of a message this account sent.
   *
   * An edit reaches WhatsApp like any other send, so it passes the same gate
   * and is counted the same way. It defaults to `low`: an edit only ever
   * tidies up something already said (the pick list's "✔ 2 · Venom (2005)"),
   * so under budget pressure it is the first thing to go, and a caller told
   * `false` has lost nothing anyone was waiting on. WhatsApp itself refuses
   * edits to messages older than 15 minutes.
   */
  async editText(jid, key, text, { kind = 'low' } = {}) {
    const stam = stamIntercept('edit', { jid, text });
    if (stam) return stam;
    // A message a $stamtest only pretended to send (a pick list, edited when
    // it expires, long after the test): there is nothing on WhatsApp to edit.
    if (isStamKey(key)) {
      logger.debug(`not editing ${key.id}: a $stamtest message that was never sent`);
      return false;
    }
    const sock = this._requireSock();
    if (!key?.id) throw new Error('no message key to edit');
    if (!(await this._gate(kind))) return false;
    try {
      await sock.sendMessage(jid, { text, edit: key });
    } catch (err) {
      this._transcribe('failed', jid, { action: 'edit', of: key.id, error: err.message });
      throw err;
    }
    logger.debug(`edited ${key.id} in ${jid}`);
    this._transcribe('edited', jid, { of: key.id, text });
    return true;
  }

  /**
   * The token placed in message text for a group mention.
   *
   * Group mentions deliberately invert the person-mention convention: a person
   * is "@" + the JID's LOCAL part (@15551234567), but a group is "@" + the
   * WHOLE serialized JID, domain included (@1203631668...@g.us). WhatsApp scans
   * the body for that literal string, matches it against
   * contextInfo.groupMentions[].groupJid, and swaps it for a tappable chip
   * showing groupSubject. Get the token wrong and the entry is silently
   * ignored - which is why "@1203631668..." (domain stripped) rendered to
   * recipients as a raw number.
   */
  groupMentionToken(groupJid) {
    const jid = String(groupJid || '');
    return jid ? `@${jid}` : '';
  }

  /** Are these two groups in the same community? (group mentions need this.) */
  sameCommunity(jidA, jidB) {
    const a = this.groupCache.get(jidA)?.community ?? null;
    const b = this.groupCache.get(jidB)?.community ?? null;
    return !!a && !!b && a === b;
  }

  /**
   * Send a file as a document - this is the paperclip -> Document path,
   * which preserves the original file instead of re-compressing it as video.
   *
   * Done in the two steps Baileys' sendMessage takes, so that a connection
   * lost in between costs the message rather than the upload. The file goes
   * to WhatsApp's media servers over HTTPS, which a closed websocket does not
   * interrupt; then a small message pointing at it goes over the websocket.
   * sendMessage sends that message on the socket it started with, so when
   * WhatsApp closed the connection mid-upload the whole send failed at the
   * very end with "Connection Closed", although the file had arrived and the
   * bot had long since reconnected: "Spaceballs" (1.7 GB, 2026-09-28, closed
   * 18:53:27, connected 18:53:32, failed 18:56:37 - 6m26s at the usual
   * 4.4 MB/s, i.e. a finished upload) and "Minority Report" an hour later.
   * The message now goes on the connection that is live when the upload
   * ends - the same number, the same message id - so a dropped connection
   * costs seconds, not a re-upload. A different number, or no connection
   * within RELAY_WAIT_MS, fails as before and the pipelines retry.
   */
  async sendDocument(jid, filePath, opts = {}) {
    const stamDoc = stamIntercept('document', { jid, name: opts.fileName ?? path.basename(filePath) });
    if (stamDoc) return stamDoc;
    const replyTo = opts.quoted?.key?.id ?? opts.quoted?.id ?? null;
    const name = opts.fileName ?? path.basename(filePath);
    let sent;
    try {
      sent = await this._sendDocument(jid, filePath, opts);
    } catch (err) {
      this._transcribe('failed', jid, { action: `send the file ${name}`, replyTo, error: err.message });
      throw err;
    }
    // A test never sends a file (beta.js), so one in a beta group is itself
    // something for the hourly check to see.
    if (sent) this._transcribe('sent', jid, { id: sent?.key?.id ?? null, text: opts.caption ?? '', replyTo, document: name });
    return sent;
  }

  async _sendDocument(jid, filePath, { fileName, mimetype = 'video/mp4', caption, quoted = null, kind = 'critical' } = {}) {
    const sock = this._requireSock();
    const name = fileName ?? path.basename(filePath);
    const stat = fs.statSync(filePath);
    // Baileys encrypts the whole file into the temp directory before the
    // upload starts, with no error handler on that write. On a full disk the
    // copy is cut short, the process logs an uncaught ENOSPC, and the upload
    // goes on with the truncated copy: "Minority Report", 20:34 UTC on
    // 2026-09-28, stopped at 1.01 GB of 1.67 GB and was still being read half
    // an hour later. Refused before it starts, with the reason.
    const tmp = os.tmpdir();
    const free = freeBytesIn(tmp);
    const need = stat.size + UPLOAD_TEMP_SPARE;
    if (free != null && free < need) {
      const mb = (n) => `${(n / 1048576).toFixed(0)} MB`;
      logger.warn(`not sending ${name}: its encrypted copy needs ${mb(need)} in ${tmp}, and ${mb(free)} is free`);
      throw Object.assign(
        new Error(`not enough disk space to upload ${name}: ${mb(need)} needed in ${tmp}, ${mb(free)} free`),
        { code: 'ENOSPC' },
      );
    }
    if (!(await this._gate(kind))) return null;
    logger.info(`sending document ${name} (${(stat.size / 1048576).toFixed(1)} MB) -> ${jid}`);
    // Passing a path lets Baileys stream from disk instead of buffering the
    // whole film in memory, which matters a lot on a small server.
    const content = { document: { url: filePath }, mimetype, fileName: name, ...(caption ? { caption } : {}) };
    const options = quoted ? { quoted: quoted.raw } : {};

    const B = await loadBaileys();
    const { generateWAMessage, generateMessageIDV2 } = { ...B, ...B.__ns };
    // The disk can still fill while the copy is written (uploadCutShort).
    const upStarted = Date.now();
    if (typeof generateWAMessage !== 'function' || typeof sock.waUploadToServer !== 'function'
        || typeof sock.relayMessage !== 'function') {
      try { return await sock.sendMessage(jid, content, options); } catch (err) { throw uploadCutShort(err, name, upStarted); }
    }
    const account = this.activeAccountId;
    // Step one, the upload - exactly as sendMessage builds it.
    let msg;
    try {
      msg = await generateWAMessage(jid, content, {
        logger: (this._silentLog ??= pino({ level: 'silent' })),
        userJid: sock.authState?.creds?.me?.id ?? sock.user?.id,
        upload: sock.waUploadToServer,
        ...(typeof generateMessageIDV2 === 'function' ? { messageId: generateMessageIDV2(sock.user?.id) } : {}),
        ...options,
      });
    } catch (err) {
      throw uploadCutShort(err, name, upStarted);
    }
    // Step two, the message, on whichever socket is live now. The socket
    // that relays it can also close under it; each retry is on a newer one,
    // and a connection that keeps dropping gets three.
    let relay = sock;
    if (this.sock !== sock) relay = (await this._liveSocketAfter(sock, account)) ?? sock;
    for (let attempt = 1; ; attempt++) {
      try {
        await relay.relayMessage(jid, msg.message, { messageId: msg.key.id });
        break;
      } catch (err) {
        const closed = err?.output?.statusCode === 428 || /Connection Closed/i.test(err?.message ?? '');
        const next = closed && attempt < 3 ? await this._liveSocketAfter(relay, account) : null;
        if (!next) throw err;
        relay = next;
      }
    }
    if (relay !== sock) {
      logger.warn(`the connection dropped while ${name} was uploading - sent it on the new connection `
        + 'instead of uploading it again');
    }
    return msg;
  }

  /**
   * The connected socket that replaced `old`, for the same account, waiting
   * up to RELAY_WAIT_MS for one. Null when the account changed (media sent
   * as one number is not re-posted as another), the bot is stopping, or
   * nothing connected in time.
   */
  _liveSocketAfter(old, account, timeoutMs = this.relayWaitMs ?? RELAY_WAIT_MS) {
    const ready = () => this.state === 'connected' && this.sock && this.sock !== old;
    const gone = () => this.stopping || this.activeAccountId !== account;
    if (gone()) return Promise.resolve(null);
    if (ready()) return Promise.resolve(this.sock);
    return new Promise((resolve) => {
      const finish = (v) => { clearTimeout(timer); this.off('state', onState); resolve(v); };
      const onState = () => {
        if (gone()) finish(null);
        else if (ready()) finish(this.sock);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      timer.unref?.();
      this.on('state', onState);
    });
  }

  /**
   * Delete a chat from the bot's own account (housekeeping so the chat list
   * doesn't clutter with one-off PMs). This is a local delete on the bot's
   * side — it does NOT delete the message for the other person, who keeps it.
   */
  /**
   * WhatsApp app-state edits (deleting/archiving a chat) are encrypted with a
   * key the phone shares during app-state sync. We connect with
   * syncFullHistory disabled, so that key can be absent and every chatModify
   * then fails with "App state key not present!". Ask for a sync once, lazily,
   * the first time we actually need it.
   */
  async _ensureAppStateKey() {
    const sock = this._requireSock();
    if (sock.authState?.creds?.myAppStateKeyId) return true;
    if (this._appStateSyncTried) return !!sock.authState?.creds?.myAppStateKeyId;
    this._appStateSyncTried = true;
    try {
      logger.info('app-state key missing - requesting a sync from the phone');
      await sock.resyncAppState(['critical_unblock_low', 'regular_high', 'regular_low', 'regular'], true);
    } catch (err) {
      logger.debug(`app-state resync failed: ${err.message}`);
    }
    return !!sock.authState?.creds?.myAppStateKeyId;
  }

  /**
   * Archive a chat - used after PM'ing someone, so the bot's chat list stays
   * clean without destroying the conversation. Same app-state key requirement
   * as deleteChat.
   */
  async archiveChat(jid, lastMsg = null) {
    const stam = stamIntercept('archive', { jid });
    if (stam) return stam;
    const sock = this._requireSock();
    if (!(await this._ensureAppStateKey())) {
      throw new Error('WhatsApp has not shared the app-state key with this device yet, so chats cannot be archived');
    }
    const lastMessages = lastMsg?.key
      ? [{ key: lastMsg.key, messageTimestamp: lastMsg.messageTimestamp ?? Math.floor(Date.now() / 1000) }]
      : [];
    // Counted, not gated: this reaches WhatsApp, so the volume ceiling must
    // see it. Pacing is left as it is - the loops that call these are already
    // spaced by _bulkPace, and gating here would pace the same action twice.
    this.budget.record();
    await sock.chatModify({ archive: true, lastMessages }, jid);
    logger.debug(`archived chat ${jid}`);
  }

  async deleteChat(jid, lastMsg = null) {
    const sock = this._requireSock();
    if (!(await this._ensureAppStateKey())) {
      throw new Error('WhatsApp has not shared the app-state key with this device yet, so chats cannot be deleted');
    }
    const lastMessages = lastMsg?.key
      ? [{ key: lastMsg.key, messageTimestamp: lastMsg.messageTimestamp ?? Math.floor(Date.now() / 1000) }]
      : [];
    // Counted, not gated: this reaches WhatsApp, so the volume ceiling must
    // see it. Pacing is left as it is - the loops that call these are already
    // spaced by _bulkPace, and gating here would pace the same action twice.
    this.budget.record();
    await sock.chatModify({ delete: true, lastMessages }, jid);
    logger.debug(`deleted chat ${jid}`);
  }

  async sendPresence(jid, kind = 'composing') {
    // 'low': a typing indicator is the definition of cosmetic - nobody is
    // waiting on it and the next one supersedes it - so it is the first thing
    // to go when the budget is tight. It also bypasses _requireSock, so without
    // an explicit gate here the ceiling could not see it at all.
    if (!this.budget.allows('low')) return;
    this.budget.record();
    try {
      await this.sock?.sendPresenceUpdate(kind, jid);
    } catch { /* presence is best-effort */ }
  }

  /**
   * Queue a group refresh. Repeated calls collapse into one, which matters
   * because groups.update can fire dozens of times in a burst.
   */
  scheduleGroupRefresh(delay = 10_000, attempt = 0, { force = false } = {}) {
    clearTimeout(this._groupTimer);
    this._groupTimer = setTimeout(() => {
      // Unforced by default. WhatsApp emits groups.update constantly, and
      // forcing on that path bypassed the cache and produced a permanent cycle
      // of refresh -> rate-limit -> back off -> refresh.
      //
      // `force` is opt-in for one caller: a bulk admin operation that has just
      // CHANGED the membership and would otherwise read its own stale cache.
      // That path is driven by an admin pressing a button, not by WhatsApp
      // events, so it cannot re-enter the cycle - and refreshGroups() puts a
      // floor under it regardless.
      this.refreshGroups({ force }).catch((err) => {
        const rateLimited = /rate.?overlimit|429|too many/i.test(err.message ?? '');
        if (rateLimited && attempt < 5) {
          // Back off properly: 30s, 1m, 2m, 4m, 8m.
          const backoff = Math.min(480_000, 30_000 * 2 ** attempt);
          logger.warn(`group list rate-limited by WhatsApp, retrying in ${Math.round(backoff / 1000)}s`);
          this.scheduleGroupRefresh(backoff, attempt + 1, { force });
        } else {
          logger.warn(`group refresh failed: ${err.message}`);
        }
      });
    }, delay);
    this._groupTimer.unref?.();
  }

  /**
   * Fetch the group list. Cached for five minutes - the UI can ask freely, and
   * WhatsApp will not see a request per page load.
   *
   * `groupFetchAllParticipating()` is the single most expensive call the bot
   * makes: it pulls the full participant list of every group. It is also the
   * only thing WhatsApp has measurably punished us for - 26 rate-limits with
   * escalating 30s -> 480s penalties. So even a forced fetch gets a floor.
   */
  async refreshGroups({ force = false } = {}) {
    const since = Date.now() - this._lastGroupFetch;
    if (!force && since < GROUP_CACHE_MS) return this.groups();

    // Share an in-flight fetch rather than starting a second one. This used to
    // return the stale list, which silently DROPPED the refresh a bulk
    // operation had just asked for - so the cache stayed wrong until the next
    // five-minute expiry.
    if (this._groupFetch) return this._groupFetch.then(() => this.groups(), () => this.groups());

    // Every bulk admin operation forces a refresh when it finishes. Banning
    // five people in a row therefore meant five full participant fetches in
    // quick succession. Collapse them into one later run instead: delayed, not
    // dropped, so the cache still ends up correct.
    if (force && since < GROUP_FORCE_FLOOR_MS) {
      this.scheduleGroupRefresh(GROUP_FORCE_FLOOR_MS - since + 250, 0, { force: true });
      return this.groups();
    }

    const sock = this._requireSock();
    const fetching = (async () => {
      try {
        // Weighted: this pulls every group's full participant list, and it is
        // the one call WhatsApp has actually rate-limited us for. It should
        // not cost the same as a single reaction.
        this.budget.record(GROUP_FETCH_COST);
        const res = await sock.groupFetchAllParticipating();
        this._lastGroupFetch = Date.now();
        return res;
      } finally {
        this._groupFetch = null;
      }
    })();
    this._groupFetch = fetching;
    const all = await fetching;
    this.groupCache.clear();
    for (const [jid, meta] of Object.entries(all ?? {})) {
      // Capture member identities so we can tell whether a requester is in a
      // given group and how to @-mention them. Under WhatsApp's LID system a
      // participant id may be a phone JID (…@s.whatsapp.net) or an opaque
      // …@lid, so we index both the raw id and any phone number we can derive.
      const memberIds = new Set();
      const memberNumbers = new Set();
      const members = [];
      for (const pp of meta.participants ?? []) {
        if (pp.id) memberIds.add(pp.id);
        let number = null;
        if (pp.id?.endsWith('@s.whatsapp.net')) {
          number = pp.id.split('@')[0].split(':')[0];
          memberNumbers.add(number);
        }
        const pn = pp.phoneNumber ?? pp.jid;
        if (typeof pn === 'string') {
          const digits = pn.replace(/[^0-9]/g, '');
          if (digits.length >= 7) { memberNumbers.add(digits); if (!number) number = digits; }
        }
        members.push({ id: pp.id ?? null, number: number || null, admin: pp.admin ?? null });
      }
      this.groupCache.set(jid, {
        jid,
        subject: meta.subject ?? '(no name)',
        desc: meta.desc ?? '',
        // "$" prefix marks an internal group - excluded from bulk adds.
        private: isPrivateGroupName(meta.subject),
        size: meta.participants?.length ?? 0,
        isAdmin: !!meta.participants?.find((p) => p.admin && this.isSelf(p.id)),
        owner: meta.owner ?? null,
        // The community this group belongs to. Group @-mentions only render
        // for groups inside the same community, so we need it to decide
        // whether tagging another group is worth doing.
        community: meta.linkedParent ?? null,
        memberIds,
        memberNumbers,
        members,
      });
    }
    logger.info(`group cache refreshed: ${this.groupCache.size} groups`);
    this.emit('groups', this.groups());
    return this.groups();
  }

  groups() {
    return [...this.groupCache.values()]
      // drop internal Sets and the heavier per-member/desc fields from the list
      .map(({ memberIds, memberNumbers, members, desc, ...g }) => g)
      .sort((a, b) => a.subject.localeCompare(b.subject));
  }

  /** [{ jid, subject, desc }] for every cached group - for backup + editing. */
  groupDescriptionsSnapshot() {
    return [...this.groupCache.values()]
      .map((g) => ({ jid: g.jid, subject: g.subject, desc: g.desc ?? '' }))
      .sort((a, b) => a.subject.localeCompare(b.subject));
  }

  /** Groups including per-member admin status (for the cross-group roster). */
  groupsWithMembers() {
    return [...this.groupCache.values()].map((g) => ({
      jid: g.jid,
      subject: g.subject,
      members: (g.members ?? []).map((m) => ({ ...m })),
    }));
  }

  /** Apply a batch of description edits: [{ jid, desc }] -> per-group results. */
  async applyDescriptions(plan = []) {
    const results = [];
    for (const item of plan ?? []) {
      const jid = item?.jid;
      const subject = this.groupCache.get(jid)?.subject ?? jid;
      if (!jid) { results.push({ jid, ok: false, error: 'missing jid' }); continue; }
      try {
        await this.setGroupDescription(jid, String(item.desc ?? ''));
        const cached = this.groupCache.get(jid);
        if (cached) cached.desc = String(item.desc ?? '');
        results.push({ jid, subject, ok: true });
      } catch (err) {
        results.push({ jid, subject, ok: false, error: err.message });
      }
      await this._bulkPace();   // one group at a time, deliberately slowly
    }
    return results;
  }

  /** Bare phone number from a JID, or null for opaque @lid ids. */
  numberFromJid(jid) {
    if (typeof jid !== 'string' || !jid.endsWith('@s.whatsapp.net')) return null;
    const n = jid.split('@')[0].split(':')[0];
    return /^[0-9]{7,15}$/.test(n) ? n : null;
  }

  /** Full metadata for one group: description + members with admin status. */
  async groupDetails(jid) {
    const sock = this._requireSock();
    // Counted, not gated: this reaches WhatsApp, so the volume ceiling must
    // see it. Pacing is left as it is - the loops that call these are already
    // spaced by _bulkPace, and gating here would pace the same action twice.
    this.budget.record();
    const meta = await sock.groupMetadata(jid);
    return {
      jid,
      subject: meta.subject ?? '',
      desc: meta.desc ?? '',
      owner: meta.owner ?? null,
      size: meta.participants?.length ?? 0,
      // "announcement" mode = only admins may post. Reported so the portal can
      // show the real state instead of guessing.
      locked: !!meta.announce,
      alwaysLocked: (this.config.lockdown?.alwaysLocked ?? []).includes(jid),
      spamLocked: !!this.spamGuard?.isHeld(jid),
      botIsAdmin: !!meta.participants?.find((p) => p.admin && this.isSelf(p.id)),
      members: (meta.participants ?? []).map((p) => ({
        id: p.id,
        number: this.numberFromJid(p.id) ?? (p.phoneNumber ? String(p.phoneNumber).replace(/[^0-9]/g, '') : null),
        admin: p.admin ?? null,
      })).sort((a, b) => (b.admin ? 1 : 0) - (a.admin ? 1 : 0)),
    };
  }

  async setGroupDescription(jid, description) {
    const sock = this._requireSock();
    // Counted, not gated: this reaches WhatsApp, so the volume ceiling must
    // see it. Pacing is left as it is - the loops that call these are already
    // spaced by _bulkPace, and gating here would pace the same action twice.
    this.budget.record();
    await sock.groupUpdateDescription(jid, description ?? '');
    logger.info(`updated description for ${jid}`);
  }

  async setGroupSubject(jid, subject) {
    const sock = this._requireSock();
    // Counted, not gated: this reaches WhatsApp, so the volume ceiling must
    // see it. Pacing is left as it is - the loops that call these are already
    // spaced by _bulkPace, and gating here would pace the same action twice.
    this.budget.record();
    await sock.groupUpdateSubject(jid, subject);
    logger.info(`updated subject for ${jid}`);
  }

  async modifyParticipants(jid, targets, action) {
    const sock = this._requireSock();
    if (!['add', 'remove', 'promote', 'demote'].includes(action)) {
      throw new Error(`invalid participant action: ${action}`);
    }
    const jids = (Array.isArray(targets) ? targets : [targets]).map((t) => {
      const v = String(t).trim();
      if (v.includes('@')) return v;
      return `${v.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
    });
    const results = [];
    for (let i = 0; i < jids.length; i += 5) {
      const chunk = jids.slice(i, i + 5);
      // Counted, not gated: this reaches WhatsApp, so the volume ceiling must
      // see it. Pacing is left as it is - the loops that call these are already
      // spaced by _bulkPace, and gating here would pace the same action twice.
      this.budget.record();
      const res = await sock.groupParticipantsUpdate(jid, chunk, action);
      for (const r of res ?? []) results.push({ jid: r.jid, status: r.status });
      if (i + 5 < jids.length) await this._bulkPace();
    }
    logger.info(`${action} ${jids.length} participant(s) in ${jid}`);
    this.refreshGroups({ force: true }).catch(() => {});
    return results;
  }

  /** Lock (admins-only messaging) or unlock a single group. */
  async setGroupLocked(jid, locked) {
    const sock = this._requireSock();
    // Counted, not gated: this reaches WhatsApp, so the volume ceiling must
    // see it. Pacing is left as it is - the loops that call these are already
    // spaced by _bulkPace, and gating here would pace the same action twice.
    this.budget.record();
    await sock.groupSettingUpdate(jid, locked ? 'announcement' : 'not_announcement');
  }

  /**
   * Lock or unlock EVERY group the bot administers. Paced, and reports per
   * group (including which ones were skipped because the bot is not an admin).
   */
  /**
   * Lock or unlock every group.
   *
   * Paced at ~1.2s per group, so a 15-group estate takes ~20 seconds. Because
   * nothing visibly happened during that time, operators clicked again - and
   * six overlapping passes then fought each other, each reporting a different
   * count (3, 2, 3, 0, 1, 2 in one real run). Only one pass may run at a time;
   * a second request joins the one already in flight instead of competing.
   */
  async setAllGroupsLocked(locked, { onProgress = null } = {}) {
    if (this._lockdownRun) {
      logger.warn('a lockdown pass is already running - joining it instead of starting another');
      return this._lockdownRun;
    }
    this._lockdownRun = this._runLockdown(locked, onProgress)
      .finally(() => { this._lockdownRun = null; });
    return this._lockdownRun;
  }

  /** True while a lock/unlock pass is in flight. */
  get lockdownBusy() { return !!this._lockdownRun; }

  /**
   * Which groups are admins-only on WhatsApp right now.
   *
   * The always-locked list was maintained entirely by hand: somebody ticked
   * boxes, and nothing ever checked those ticks against reality. A group made
   * admins-only in WhatsApp stayed unticked, so the schedule cheerfully opened
   * it at havdalah; a group opened in WhatsApp stayed ticked, so the bulk
   * unlock kept skipping it. This reads the real setting so the two can be
   * reconciled.
   *
   * One `groupMetadata` call per group rather than a single
   * `groupFetchAllParticipating`. That looks like more traffic and is the
   * safer choice: the bulk call is the one WhatsApp has actually rate-limited
   * this number for, 26 times, with escalating penalties. Paced through
   * `_bulkPace` like every other bulk loop here.
   */
  async syncAlwaysLocked(onProgress) {
    const groups = this.groups();
    const out = [];
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      // Not part of the lockdown, so there is nothing to reconcile: not read.
      if (isPrivateGroupName(g.subject)) continue;
      try {
        const meta = await this.groupDetails(g.jid);
        out.push({ jid: g.jid, subject: g.subject, locked: !!meta.locked, botIsAdmin: !!meta.botIsAdmin });
      } catch (err) {
        // A group we cannot read is NOT evidence that it is unlocked, and
        // treating it as such would silently drop it from the list.
        out.push({ jid: g.jid, subject: g.subject, error: err.message });
      }
      try { onProgress?.({ done: i + 1, total: groups.length, subject: g.subject }); } catch { /* reporting only */ }
      if (i < groups.length - 1) await this._bulkPace();
    }
    const readable = out.filter((g) => !g.error);
    logger.info(`always-locked sync: read ${readable.length}/${out.length} groups, `
      + `${readable.filter((g) => g.locked).length} are admins-only`);
    return out;
  }

  async _runLockdown(locked, onProgress) {
    const alwaysLocked = new Set(this.config.lockdown?.alwaysLocked ?? []);
    // One group at a time, well spaced: a burst of group-setting changes is
    // what WhatsApp rate-limits, and nothing here is urgent to the second.
    const pace = Math.max(0, Number(this.config.lockdown?.pacingMs ?? this._bulkDelay('bulk')));
    const groups = this.groups();
    const results = [];
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      // A "$" group is a private back-channel, outside the lockdown as it is
      // outside the member tools: neither locked nor opened (isPrivateGroupName).
      if (isPrivateGroupName(g.subject)) {
        results.push({ jid: g.jid, subject: g.subject, skipped: 'private ($)' });
      // Never OPEN a group that is meant to stay admins-only permanently.
      } else if (!locked && alwaysLocked.has(g.jid)) {
        results.push({ jid: g.jid, subject: g.subject, skipped: 'always locked' });
      // Nor one the spam guard locked: havdalah would reopen it to the member
      // who flooded it. A person opens it (src/core/spam-guard.js).
      } else if (!locked && this.spamGuard?.isHeld(g.jid)) {
        results.push({ jid: g.jid, subject: g.subject, skipped: 'locked for spam' });
      } else {
        try {
          await this.setGroupLocked(g.jid, locked);
          results.push({ jid: g.jid, subject: g.subject, ok: true });
        } catch (err) {
          const notAdmin = /not-authorized|forbidden|403/i.test(err.message ?? '');
          results.push({ jid: g.jid, subject: g.subject, error: notAdmin ? 'the bot is not an admin there' : err.message });
        }
        // No need to wait after the final group - that is just dead time.
        if (i < groups.length - 1) await sleep(pace);
      }
      try { onProgress?.({ done: i + 1, total: groups.length, subject: g.subject }); } catch { /* reporting only */ }
    }
    const changed = results.filter((r) => r.ok).length;
    logger.debug(`lockdown paced at ${pace}ms between groups`);
    const skipped = results.filter((r) => r.skipped).length;
    const privateSkipped = results.filter((r) => r.skipped === 'private ($)').length;
    const spamSkipped = results.filter((r) => r.skipped === 'locked for spam').length;
    const alwaysSkipped = skipped - privateSkipped - spamSkipped;
    const failed = results.filter((r) => r.error).length;
    // Say what actually happened: "5/9" alone reads as failure when four of
    // those were deliberately skipped.
    logger.info(`${locked ? 'locked' : 'unlocked'} ${changed}/${results.length} groups` +
      `${alwaysSkipped ? `, ${alwaysSkipped} skipped (always-locked)` : ''}` +
      `${privateSkipped ? `, ${privateSkipped} private ($) left alone` : ''}` +
      `${spamSkipped ? `, ${spamSkipped} left locked for spam` : ''}` +
      `${failed ? `, ${failed} failed` : ''}`);
    for (const f of results.filter((r) => r.error)) {
      logger.warn(`  ${locked ? 'lock' : 'unlock'} failed for "${f.subject}": ${f.error}`);
    }
    results.summary = { changed, skipped, alwaysLocked: alwaysSkipped, private: privateSkipped, spam: spamSkipped, failed, total: results.length };
    return results;
  }

  /** Raw participant update for one group (used by the cross-group helpers). */
  async _rawParticipant(jid, number, action) {
    const sock = this._requireSock();
    const target = `${String(number).replace(/[^0-9]/g, '')}@s.whatsapp.net`;
    // Counted, not gated: this reaches WhatsApp, so the volume ceiling must
    // see it. Pacing is left as it is - the loops that call these are already
    // spaced by _bulkPace, and gating here would pace the same action twice.
    this.budget.record();
    const res = await sock.groupParticipantsUpdate(jid, [target], action);
    return res?.[0]?.status ?? null;
  }

  /** Remove a number from every group it is currently in. */
  /**
   * Delete-for-everyone every message this person posted that is still inside
   * WhatsApp's revoke window. Requires the bot to be admin in the group; where
   * it is not, that group's deletions simply fail and are reported.
   */
  async deleteRecentMessagesFrom({ number = null, jid = null } = {}) {
    if (!this.messageIndex) return { deleted: 0, failed: 0, groups: [] };
    const sock = this._requireSock();
    const targets = this.messageIndex.forSender({ number, jid });
    let deleted = 0, failed = 0;
    const groups = new Set();
    for (const t of targets) {
      try {
        await sock.sendMessage(t.groupJid, { delete: t.key });
        deleted++;
        groups.add(this.groupCache.get(t.groupJid)?.subject ?? t.groupJid);
      } catch (err) {
        failed++;
        logger.debug(`revoke failed in ${t.groupJid}: ${err.message}`);
      }
      // Pace after failures too - a burst of rejected deletes is the surest
      // sign we are already being throttled, and the worst time to speed up.
      await this._bulkPace('revoke');   // deleting fast is what gets noticed
    }
    if (deleted || failed) {
      logger.info(`wiped ${deleted} message(s) from ${number ? `+${number}` : jid}` +
        `${failed ? ` (${failed} could not be deleted)` : ''}`);
    }
    this.messageIndex.forget({ number, jid });
    return { deleted, failed, groups: [...groups] };
  }

  async banFromAllGroups(number, { wipeMessages = true } = {}) {
    // Wipe their recent posts BEFORE removing them - once they are out of the
    // group the revoke can be rejected, and the message keys reference them.
    let wiped = { deleted: 0, failed: 0, groups: [] };
    if (wipeMessages) {
      try { wiped = await this.deleteRecentMessagesFrom({ number }); }
      catch (err) { logger.warn(`could not wipe messages for +${number}: ${err.message}`); }
    }
    const results = [];
    for (const g of this.groups()) {
      const info = this.groupMemberInfo(g.jid, { number });
      if (!info.isMember) continue;                    // only where they actually are
      try {
        const status = await this._rawParticipant(g.jid, number, 'remove');
        results.push({ jid: g.jid, subject: g.subject, status: status ?? 'removed' });
      } catch (err) {
        results.push({ jid: g.jid, subject: g.subject, error: err.message });
      }
      await this._bulkPace();
    }
    this.refreshGroups({ force: true }).catch(() => {});
    logger.info(`banned +${number} from ${results.length} group(s)`);
    results.wiped = wiped;
    return results;
  }

  /** add / promote / demote a number across a chosen set of groups. */
  async participantAcrossGroups(number, groupJids, action) {
    const results = [];
    for (const jid of groupJids) {
      // Belt and braces behind the UI filter: a bulk ADD must never put someone
      // into an internal "$" group, even if the jid is passed explicitly.
      // Removing/demoting there is still allowed - that is a safety operation.
      const cached = this.groupCache.get(jid);
      if (action === 'add' && cached?.private) {
        results.push({ jid, subject: cached.subject, error: 'private group - bulk add is not allowed here' });
        continue;
      }
      try {
        const status = await this._rawParticipant(jid, number, action);
        results.push({ jid, subject: this.groupCache.get(jid)?.subject ?? jid, status: status ?? 'ok' });
      } catch (err) {
        results.push({ jid, subject: this.groupCache.get(jid)?.subject ?? jid, error: err.message });
      }
      await this._bulkPace();
    }
    this.refreshGroups({ force: true }).catch(() => {});
    logger.info(`${action} +${number} across ${groupJids.length} group(s)`);
    return results;
  }

  /**
   * Decide whether `requester` is in `groupJid`, and how to tag them.
   * Matches on the LID/JID first (stable per user across groups) and falls
   * back to the phone number. Returns { isMember, mentionJid, mentionText }.
   */
  groupMemberInfo(groupJid, { jid = null, number = null } = {}) {
    const g = this.groupCache.get(groupJid);
    const digits = number ? String(number).replace(/[^0-9]/g, '') : null;
    if (!g) return { isMember: false, mentionJid: null, mentionText: digits };

    const isMember =
      (jid && g.memberIds.has(jid)) ||
      (digits && (g.memberNumbers.has(digits) || g.memberIds.has(`${digits}@s.whatsapp.net`)));

    // Prefer a phone-JID mention so the tag renders as @<number> rather than
    // an opaque @<lid>. Fall back to the raw jid if that is all we have.
    const mentionJid = digits ? `${digits}@s.whatsapp.net` : jid;
    return { isMember: !!isMember, mentionJid, mentionText: digits ?? (jid ? jid.split('@')[0] : null) };
  }

  /**
   * Record any real group mention we see, from live traffic or history sync.
   * Samples are the evidence for which in-text token WhatsApp actually links.
   */
  _captureMentionSamples(messages) {
    try {
      const hits = scanForGroupMentions(messages);
      if (!hits.length) return;
      this.mentionSamples = (this.mentionSamples ?? []).concat(hits).slice(-50);
      for (const h of hits) {
        const conv = deduceTokenConvention(h);
        logger.info(`📎 REAL GROUP MENTION  text=${JSON.stringify(h.text)}`);
        for (const c of conv) {
          logger.info(`   -> ${c.groupSubject ?? c.groupJid}: token convention = ${c.matched}` +
            `${c.token ? ` (${JSON.stringify(c.token)})` : ''}`);
        }
      }
    } catch (err) { logger.debug(`mention capture failed: ${err.message}`); }
  }

  /**
   * Ask WhatsApp to send older messages for a chat, so we can scan them for a
   * real group mention. Needs a message key to page back from - the message
   * index keeps recent ones.
   */
  async requestHistory({ chatJid, count = 50, fromKey = null, fromTs = null } = {}) {
    const sock = this._requireSock();
    let key = fromKey;
    let ts = fromTs;
    // Page back from the oldest message a catch-up already has, so that asking
    // again reaches further back rather than fetching the same page.
    const held = chatJid ? this.historyBuffer.entries(chatJid)
      .filter((r) => Number(r.messageTimestamp))
      .sort((x, y) => Number(x.messageTimestamp) - Number(y.messageTimestamp))[0] : null;
    if (!key && held) {
      key = held.key;
      ts = Number(held.messageTimestamp);
    }
    if (!key && this.messageIndex) {
      // oldest entry we know for this chat is the best paging anchor
      const mine = this.messageIndex.entries
        .filter((e) => !chatJid || e.g === chatJid)
        .sort((a, b) => (a.t ?? 0) - (b.t ?? 0))[0];
      if (mine) {
        key = { remoteJid: mine.g, id: mine.i, fromMe: false, participant: mine.p ?? undefined };
        ts = Math.floor((mine.t ?? Date.now()) / 1000);
      }
    }
    if (!key) throw new Error('no message key to page back from - the bot needs to have seen a message in that chat first');
    // Counted, not gated: this reaches WhatsApp, so the volume ceiling must
    // see it. Pacing is left as it is - the loops that call these are already
    // spaced by _bulkPace, and gating here would pace the same action twice.
    this.budget.record();
    const res = await sock.fetchMessageHistory(count, key, ts);
    logger.info(`requested ${count} historical message(s) for ${key.remoteJid} (req ${res})`);
    return { requested: count, chatJid: key.remoteJid, requestId: res };
  }

  /**
   * Hand a group's unanswered requests since a moment to the plugins, as if
   * they had just arrived (catch-up.js says why). Without run it only says
   * what it would do. With run it works through them in the background, one
   * at a time with _bulkPace() between, and returns at once.
   */
  async catchUp({ chatJid, sinceMs, run = false } = {}) {
    if (!chatJid || !Number.isFinite(sinceMs)) throw new Error('catch-up needs chatJid and since');
    const plan = catchUpPlan(this.historyBuffer.entries(chatJid), {
      sinceMs, normalize: (raw) => this.normalize(raw), done: this.historyBuffer.done,
    });
    const list = plan.pending.map((m) => ({
      id: m.id, at: new Date(m.timestamp).toISOString(), from: m.senderNumberDisplay ?? m.pushName ?? null, text: m.text.slice(0, 200),
    }));
    const summary = {
      chatJid, since: new Date(sinceMs).toISOString(), pending: list.length, alreadyAnswered: plan.answered.length,
      oldestBuffered: plan.oldestMs ? new Date(plan.oldestMs).toISOString() : null, reachesSince: plan.reachesSince, list,
    };
    if (!run) return { ...summary, ran: false };
    for (const m of plan.pending) this.historyBuffer.done.add(m.id);
    (async () => {
      for (const m of plan.pending) {
        logger.info(`catch-up ${chatJid}: ${m.id} (${new Date(m.timestamp).toISOString()}) "${m.text.slice(0, 60)}"`);
        this.emit('message', { ...m, catchUp: true });
        await this._bulkPace();
      }
      logger.info(`catch-up ${chatJid}: ${plan.pending.length} request(s) handed to the plugins`);
    })().catch((err) => logger.error(`catch-up ${chatJid}: ${err.message}`));
    return { ...summary, ran: true };
  }

  /** Is this person an admin of the group? (used to exempt staff from rules) */
  isGroupAdmin(groupJid, { jid = null, number = null } = {}) {
    const g = this.groupCache.get(groupJid);
    if (!g?.members) return false;
    const digits = number ? String(number).replace(/[^0-9]/g, '') : null;
    return g.members.some((m) => !!m.admin && (
      (jid && m.id === jid) ||
      (digits && (m.number === digits || m.id === `${digits}@s.whatsapp.net`))
    ));
  }

  /**
   * Pin a message in a group for a fixed window.
   *
   * WhatsApp only accepts three durations - 24 hours, 7 days or 30 days - and
   * PIN_FOR_ALL (type 1) requires the bot to be an admin of the group.
   */
  /** Look up which group an invite code belongs to. Throws if it is dead. */
  async groupInviteInfo(code) {
    const sock = this._requireSock();
    await this._gate('normal');
    return sock.groupGetInviteInfo(String(code).trim());
  }

  /** The group's existing invite code. Read only - this never rotates it. */
  async groupInviteCode(jid) {
    const sock = this._requireSock();
    await this._gate('normal');
    return sock.groupInviteCode(jid);
  }

  async pinMessage(jid, key, seconds = 2592000) {
    const sock = this._requireSock();
    const allowed = [86400, 604800, 2592000];
    const time = allowed.includes(seconds) ? seconds : 2592000;
    if (!allowed.includes(seconds)) {
      logger.warn(`pin duration ${seconds}s is not one WhatsApp accepts; using 30 days`);
    }
    await this._gate('normal');
    await sock.sendMessage(jid, { pin: key, type: 1, time });   // 1 = PIN_FOR_ALL
    logger.info(`pinned a message in ${this.groupCache.get(jid)?.subject ?? jid} for ${Math.round(time / 86400)} day(s)`);
  }

  /**
   * Delete one message for everyone. Needs the bot to be a group admin.
   *
   * Paced like any other action. It was not: enforcement deletes went straight
   * to the socket, so a burst of rule-breaking messages produced a burst of
   * revokes - 30 in a minute at one point. The 2.5s revokePacingMs only ever
   * covered the BULK ban-wipe loop, never this, which is the path that
   * actually runs day to day.
   */
  async deleteMessage(msg) {
    const stam = stamIntercept('delete', { jid: (msg?.key ?? msg)?.remoteJid ?? null });
    if (stam) return stam;
    const sock = this._requireSock();
    const key = msg?.key ?? msg;
    if (isStamKey(key)) return false;
    if (!key?.id || !key?.remoteJid) throw new Error('no message key');
    await this._gate('critical');
    await sock.sendMessage(key.remoteJid, {
      delete: {
        remoteJid: key.remoteJid,
        fromMe: !!key.fromMe,
        id: key.id,
        participant: key.participant ?? msg?.senderJid ?? undefined,
      },
    });
    this._transcribe('deleted', key.remoteJid, { id: key.id });
  }

  /**
   * Every JID form this account can appear as in a participant list.
   *
   * Under WhatsApp's LID system our own entry may be the opaque `…@lid` rather
   * than the phone JID, and either form can carry a `:device` suffix. Matching
   * only one form made the bot believe it was never an admin anywhere, which
   * made the portal warn that every edit would fail - while the edits actually
   * worked. Collect all of them and compare against the set.
   */
  _selfIds() {
    const u = this.sock?.user ?? {};
    const out = new Set();
    const add = (v) => {
      if (typeof v !== 'string' || !v.includes('@')) return;
      const [local, domain] = v.split('@');
      const bare = local.split(':')[0];
      if (bare && domain) { out.add(`${bare}@${domain}`); out.add(v); }
    };
    add(u.id); add(u.lid); add(u.jid);
    const digits = String(u.id ?? '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
    if (digits.length >= 7) out.add(`${digits}@s.whatsapp.net`);
    return out;
  }

  /** Is this participant id us? (LID- and device-suffix aware) */
  isSelf(jid) {
    if (typeof jid !== 'string' || !jid.includes('@')) return false;
    const [local, domain] = jid.split('@');
    return this._selfIds().has(`${local.split(':')[0]}@${domain}`);
  }

  /** Milliseconds since the group list was last actually fetched. */
  groupCacheAge() {
    return this._lastGroupFetch ? Date.now() - this._lastGroupFetch : Infinity;
  }
}
