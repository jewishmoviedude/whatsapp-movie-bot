import log from './logger.js';

const logger = log.scope('mail');

// Lazy import: the app must still boot if the dependency is missing.
let nodemailer = null;
async function loadNodemailer() {
  if (!nodemailer) {
    const mod = await import('nodemailer');
    nodemailer = mod.default ?? mod;
  }
  return nodemailer;
}

/**
 * Common providers. Gmail and Outlook both require an *app password* rather
 * than the account password once two-factor is on, which is what the settings
 * page asks for.
 */
export const PRESETS = {
  gmail:   { host: 'smtp.gmail.com',       port: 465, secure: true },
  outlook: { host: 'smtp-mail.outlook.com', port: 587, secure: false },
  yahoo:   { host: 'smtp.mail.yahoo.com',  port: 465, secure: true },
  custom:  null,
};

function resolveSettings(cfg) {
  const preset = PRESETS[cfg.provider] ?? null;
  return {
    host: preset?.host ?? cfg.host,
    port: preset?.port ?? Number(cfg.port),
    secure: preset ? preset.secure : !!cfg.secure,
    user: cfg.user,
    pass: cfg.appPassword,
    from: cfg.from || cfg.user,
    to: cfg.to || cfg.user,
  };
}

/**
 * Is email switched on with an account to send through - an address, an app
 * password and, for custom SMTP, a host? Email is on by default since the
 * operator's live settings became the defaults (2026-10-12), so a new
 * install has it switched on with nothing to send through, and every send
 * failed: the daily summary alone tried once a minute, with two warn lines
 * each time. The automatic emails treat it as off until it is set up; the
 * panel's own buttons still try, and say what is missing.
 */
export function emailReady(cfg = {}) {
  if (!cfg?.enabled) return false;
  // No provider is Gmail, the schema's default and the panel's.
  const s = resolveSettings({ ...cfg, provider: cfg.provider ?? 'gmail' });
  return !!(s.host && s.user && s.pass);
}

async function makeTransport(cfg) {
  const s = resolveSettings(cfg);
  if (!s.host) throw new Error('No SMTP host set');
  if (!s.user) throw new Error('No email address set');
  if (!s.pass) throw new Error('No app password set');

  const nm = await loadNodemailer();
  return {
    transport: nm.createTransport({
      host: s.host,
      port: s.port,
      secure: s.secure,
      auth: { user: s.user, pass: s.pass },
      // A dead SMTP server must not wedge the queue.
      connectionTimeout: 20000,
      greetingTimeout: 15000,
      socketTimeout: 30000,
    }),
    settings: s,
  };
}

/** Turn SMTP's terse failures into something actionable. */
function describe(err) {
  const m = String(err?.message ?? err);
  if (/Invalid login|535|BadCredentials/i.test(m)) {
    return 'Rejected the login. With Gmail or Outlook you need an app password, '
         + 'not your normal account password - and two-factor must be on to create one.';
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(m)) return 'Could not resolve the SMTP host - check the hostname.';
  if (/ECONNREFUSED/i.test(m)) return 'Nothing is listening on that SMTP host and port.';
  if (/ETIMEDOUT|timeout/i.test(m)) return 'Timed out reaching the SMTP server. Port 465 or 587 may be blocked outbound.';
  if (/self.signed|unable to verify/i.test(m)) return 'The SMTP server presented an untrusted certificate.';
  return m;
}

export async function verifyEmail(cfg) {
  try {
    const { transport, settings } = await makeTransport(cfg);
    await transport.verify();
    transport.close();
    return { ok: true, detail: `${settings.host}:${settings.port} as ${settings.user}` };
  } catch (err) {
    return { ok: false, error: describe(err) };
  }
}

export async function sendMail(cfg, { subject, text, attachments = [] }) {
  const { transport, settings } = await makeTransport(cfg);
  try {
    const info = await transport.sendMail({
      from: settings.from,
      to: settings.to,
      subject,
      text,
      attachments,
    });
    logger.info(`sent "${subject}" to ${settings.to}`);
    return { ok: true, messageId: info.messageId };
  } catch (err) {
    const detail = describe(err);
    logger.error(`could not send mail: ${detail}`);
    throw new Error(detail);
  } finally {
    transport.close();
  }
}

export async function sendTestEmail(cfg) {
  try {
    const r = await sendMail(cfg, {
      subject: 'WhatsApp Bot — test email',
      text: [
        'This is a test from your WhatsApp bot control panel.',
        '',
        'If you are reading this, email delivery works and the bot can send',
        'you debug logs and error alerts.',
        '',
        `Sent: ${new Date().toISOString()}`,
        `Host: ${resolveSettings(cfg).host}`,
      ].join('\n'),
    });
    return { ok: true, messageId: r.messageId };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Email the debug log as a gzipped attachment. */
/**
 * Scrub anything that identifies a person from text about to leave the box.
 *
 * The debug log is attached to every error alert, so it lands in an external
 * mailbox on events as mundane as a library timeout. It carried subscribers'
 * full phone numbers alongside what each of them asked to watch. Correlating a
 * request to a job needs a stable handle, not a dialable number, so the number
 * is masked here regardless of what reached the file.
 *
 * `masked`, when given, is told of every number masked, as (handle, kind,
 * digits): kind is 'phone', 'national', 's.whatsapp.net' or 'lid', and
 * digits are what the handle was made from. 'national' is ten bare digits,
 * which may be a number with its country code left off: "9735552861" was
 * +1 973..., not +973. The hourly check keeps all this as a private key
 * (src/core/hourly-checks.js, numberLog), so the report it shows the operator
 * can name a member by the number the research session was only ever handed
 * masked.
 */
export function redactPersonal(text, masked = null) {
  const tell = (handle, kind, digits) => {
    if (typeof masked === 'function') masked(handle, kind, digits);
    if (maskLog && maskLog !== masked) maskLog(handle, kind, digits);
    return handle;
  };
  return String(text ?? '')
    // JIDs FIRST. A jid is a long digit run, so the phone pattern below would
    // otherwise chew its middle and leave a mangled half-identifier behind.
    .replace(/\b(\d{6,})@(lid|s\.whatsapp\.net)\b/g, (_m, d, dom) => tell(`***${String(d).slice(-4)}@${dom}`, dom, d))
    // +1 (555) 813-0191 / +15558130191 / 15558130191 -> +1555***0191
    .replace(/\+?\d{0,3}[\s.-]*\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, (m) => {
      const d = m.replace(/\D/g, '');
      if (d.length < 10) return m;
      // A number written without a "+" is matched from the space before it,
      // which is kept: the hourly reports read "TV:+973***2861 asked again".
      const lead = /^[\s.-]*/.exec(m)[0];
      // With its country code: written with a "+", or the eleven digits and
      // more WhatsApp keeps a number as. Ten bare digits may be a national
      // number - that member's requester read "973..." and their number was
      // 1973... - so the key never takes it for +973.
      const kind = m.slice(lead.length).startsWith('+') || d.length >= 11 ? 'phone' : 'national';
      return lead + tell(`+${d.slice(0, -7)}***${d.slice(-4)}`, kind, d);
    });
}

// Told of every number redactPersonal masks while withMaskLog() runs. The
// hourly check's scanner masks as it goes - a log line quoted as evidence, a
// history row's detail - long before the dossier is written, and the handles
// it leaves there are in the report too (2026-10-01: reports said "the
// member", "the same member", and the operator could not tell who).
let maskLog = null;

/** Run `fn` (synchronous) with `log` told of every number masked meanwhile. */
export function withMaskLog(log, fn) {
  const was = maskLog;
  maskLog = typeof log === 'function' ? log : null;
  try { return fn(); } finally { maskLog = was; }
}

export async function sendLog(cfg, { logText, label = 'debug log', note = '' }) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const zlib = await import('node:zlib');
  // Redact on the way out, not only at the point of logging: this is the last
  // place the text is still on our machine.
  const safe = redactPersonal(logText || '(log is empty)');
  const gz = zlib.gzipSync(Buffer.from(safe, 'utf8'));

  const lines = safe ? safe.split('\n').length : 0;
  const errors = (safe.match(/\[ERROR\]/g) || []).length;
  const warns = (safe.match(/\[WARN /g) || []).length;

  return sendMail(cfg, {
    subject: `WhatsApp Bot — ${label} (${errors} errors, ${warns} warnings)`,
    text: [
      note || `Attached is the ${label} from your WhatsApp bot.`,
      '',
      `Lines    : ${lines}`,
      `Errors   : ${errors}`,
      `Warnings : ${warns}`,
      `Generated: ${new Date().toISOString()}`,
      '',
      errors ? 'Most recent errors:' : '',
      ...(errors
        ? logText.split('\n').filter((l) => l.includes('[ERROR]')).slice(-15)
        : []),
    ].filter(Boolean).join('\n'),
    attachments: [{ filename: `whatsapp-bot-${stamp}.log.gz`, content: gz }],
  });
}
