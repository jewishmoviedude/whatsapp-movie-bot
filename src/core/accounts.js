/**
 * Multiple WhatsApp numbers, each with its own session.
 *
 * A single hardcoded session directory meant one number, and every linking
 * problem took the whole bot down with no way back. Each account now keeps its
 * credentials in `data/sessions/<id>/`, so switching numbers is instant and
 * switching BACK does not require re-linking - the previous session is still
 * sitting there, untouched.
 *
 * Pure helpers here; the bot owns connecting and the API owns the routes.
 */
import fs from 'node:fs';
import path from 'node:path';

/** A stable, filesystem-safe id for an account. */
export function accountId(label, existing = []) {
  const base = String(label ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'account';
  const taken = new Set(existing.map((a) => a.id));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 500; i++) {
    if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  }
  return `${base}-${Date.now()}`;
}

/** Where an account's credentials live. */
export function sessionDirFor(dataDir, id) {
  // The original single-account install kept its session in data/session;
  // keep using it for the default account so nobody has to re-link on upgrade.
  if (!id || id === 'default') return path.join(dataDir, 'session');
  return path.join(dataDir, 'sessions', String(id));
}

/** Has this account actually been linked? */
export function isLinked(dataDir, id) {
  const dir = sessionDirFor(dataDir, id);
  try {
    return fs.existsSync(path.join(dir, 'creds.json'));
  } catch { return false; }
}

/**
 * Normalise the configured accounts, inventing the default one on first run so
 * an existing single-number install keeps working untouched.
 */
export function listAccounts(cfg = {}, dataDir = '') {
  const wa = cfg.whatsapp ?? {};
  let accounts = Array.isArray(wa.accounts) ? wa.accounts.filter(Boolean) : [];

  if (!accounts.length) {
    accounts = [{
      id: 'default',
      label: wa.phoneNumber ? `+${wa.phoneNumber}` : 'Main number',
      phoneNumber: wa.phoneNumber ?? '',
    }];
  }
  const activeId = wa.activeAccount && accounts.some((a) => a.id === wa.activeAccount)
    ? wa.activeAccount
    : accounts[0].id;

  return accounts.map((a) => ({
    id: a.id,
    label: a.label || (a.phoneNumber ? `+${a.phoneNumber}` : a.id),
    phoneNumber: a.phoneNumber ?? '',
    active: a.id === activeId,
    linked: dataDir ? isLinked(dataDir, a.id) : false,
    sessionDir: dataDir ? sessionDirFor(dataDir, a.id) : null,
  }));
}

/** The account the bot should be using. */
export function activeAccount(cfg = {}, dataDir = '') {
  const all = listAccounts(cfg, dataDir);
  return all.find((a) => a.active) ?? all[0];
}

/** Add an account, returning the patch to persist. */
export function addAccount(cfg = {}, { label, phoneNumber } = {}) {
  const existing = listAccounts(cfg);
  const digits = String(phoneNumber ?? '').replace(/[^0-9]/g, '');
  const name = String(label ?? '').trim() || (digits ? `+${digits}` : 'New number');
  if (existing.some((a) => digits && a.phoneNumber === digits)) {
    throw new Error(`+${digits} is already set up`);
  }
  const id = accountId(name, existing);
  const accounts = existing.map(({ id: i, label: l, phoneNumber: p }) => ({ id: i, label: l, phoneNumber: p }));
  accounts.push({ id, label: name, phoneNumber: digits });
  return { id, patch: { whatsapp: { accounts } } };
}

/** Remove an account. The active one cannot be removed out from under the bot. */
/**
 * Rename a number or correct its digits.
 *
 * The saved session lives in a directory keyed by the account ID, never by the
 * phone number, so editing either of these does NOT touch the link - a linked
 * number stays linked. What the digits DO affect is pairing-code linking, which
 * sends its code to whatsapp.phoneNumber, so an account whose digits are wrong
 * would send the code to the wrong handset.
 */
export function updateAccount(cfg = {}, id, { label, phoneNumber } = {}) {
  const wa = cfg.whatsapp ?? {};
  const existing = Array.isArray(wa.accounts) && wa.accounts.length
    ? wa.accounts
    : [{ id: 'default', label: wa.phoneNumber ? `+${wa.phoneNumber}` : 'Main number', phoneNumber: wa.phoneNumber ?? '' }];
  const target = existing.find((a) => a.id === id);
  if (!target) throw new Error('no such account');

  const digits = phoneNumber === undefined ? undefined : String(phoneNumber).replace(/[^0-9]/g, '');
  if (digits !== undefined && digits && digits.length < 7) throw new Error('that does not look like a phone number');

  const accounts = existing.map((a) => (a.id !== id ? a : {
    id: a.id,
    label: (label === undefined ? a.label : String(label).trim()) || a.label,
    phoneNumber: digits === undefined ? a.phoneNumber : digits,
  }));

  const patch = { whatsapp: { accounts } };
  // The pairing flow reads whatsapp.phoneNumber; keep it in step when the
  // number being edited is the one currently in use. "In use" is decided
  // exactly as listAccounts() decides it. It used to be
  // `activeAccount ?? 'default'`, but a new install's activeAccount is '' -
  // not missing - so the fallback never applied: Edit filled in the numbers
  // list, the pairing number stayed blank, and Link / Connect failed with "Set
  // your WhatsApp phone number in Settings before linking".
  const active = listAccounts(cfg).find((a) => a.active)?.id;
  if (id === active && digits) patch.whatsapp.phoneNumber = digits;
  return { target: accounts.find((a) => a.id === id), patch };
}

export function removeAccount(cfg = {}, id) {
  const existing = listAccounts(cfg);
  const target = existing.find((a) => a.id === id);
  if (!target) throw new Error('no such account');
  if (existing.length === 1) throw new Error('cannot remove the only account');
  if (target.active) throw new Error('switch to another number before removing this one');
  const accounts = existing
    .filter((a) => a.id !== id)
    .map(({ id: i, label: l, phoneNumber: p }) => ({ id: i, label: l, phoneNumber: p }));
  return { patch: { whatsapp: { accounts } } };
}

/** Switch the active account. */
export function switchAccount(cfg = {}, id) {
  const existing = listAccounts(cfg);
  const target = existing.find((a) => a.id === id);
  if (!target) throw new Error('no such account');
  const accounts = existing.map(({ id: i, label: l, phoneNumber: p }) => ({ id: i, label: l, phoneNumber: p }));
  return {
    target,
    patch: {
      whatsapp: {
        accounts,
        activeAccount: id,
        // The pairing flow reads whatsapp.phoneNumber, so keep it in step with
        // whichever number is now active.
        ...(target.phoneNumber ? { phoneNumber: target.phoneNumber } : {}),
      },
    },
  };
}
