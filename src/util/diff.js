/**
 * Describe what changed between two config objects, in words.
 *
 * The audit log recorded "PUT /config" and nothing else, so a settings change
 * was attributable to an admin but not identifiable - you could see that
 * someone changed something, never what. Reconstructing an incident from that
 * is impossible.
 *
 * Secret values are never written out. A changed API key is recorded as having
 * changed, which is the part that matters for an audit trail; the value itself
 * belongs only in the config file.
 */

const MAX_VALUE = 60;          // a rules blob is thousands of chars - summarise

/** A short, human-readable rendering of one config value. */
export function describeValue(v) {
  if (v === undefined) return '(unset)';
  if (v === null) return 'null';
  if (typeof v === 'string') {
    if (v === '') return '(empty)';
    return v.length > MAX_VALUE ? `"${v.slice(0, MAX_VALUE)}…" (${v.length} chars)` : `"${v}"`;
  }
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) return `[${v.length} item${v.length === 1 ? '' : 's'}]`;
  if (typeof v === 'object') return `{${Object.keys(v).length} field${Object.keys(v).length === 1 ? '' : 's'}}`;
  return String(v);
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Every leaf path whose value differs. Arrays are compared whole - a reordered
 * group list is one change, not five.
 *
 * @param {object} before
 * @param {object} after
 * @param {string[]} secretPaths  dotted paths whose VALUES must never be logged
 * @returns {{path:string, from:any, to:any, secret:boolean}[]}
 */
export function changedPaths(before, after, secretPaths = []) {
  const secret = new Set(secretPaths);
  const out = [];

  const walk = (a, b, prefix) => {
    const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
    for (const k of keys) {
      const path = prefix ? `${prefix}.${k}` : k;
      const av = a?.[k];
      const bv = b?.[k];
      if (isPlainObject(av) && isPlainObject(bv)) { walk(av, bv, path); continue; }
      if (JSON.stringify(av) === JSON.stringify(bv)) continue;
      out.push({ path, from: av, to: bv, secret: secret.has(path) });
    }
  };
  walk(before, after, '');
  return out;
}

/** One change from changedPaths(), in words: "path: from → to", or "path: changed" for a secret. */
export function describeChange(c) {
  return c.secret
    ? `${c.path}: changed`                       // never the value itself
    : `${c.path}: ${describeValue(c.from)} → ${describeValue(c.to)}`;
}

/**
 * One line summarising a config change, suitable for the audit log and the
 * debug log, naming EVERY setting that changed. Returns null when nothing
 * actually changed - a form submitted unmodified should not manufacture an
 * audit entry.
 *
 * It named the first twelve and then "and N more" until 2026-10-12, when a
 * save at 21:00 changed 22 settings, and the ten it did not name - the email
 * alerts among them - had to be pieced together from the config file and from
 * what the bot stopped doing; some were still wrong after the settings had
 * been restored by hand. A long line is read once; a setting nobody can see
 * changed is restored by nobody. Each change is already short (describeValue),
 * and an ordinary save changes one to three.
 */
export function describeConfigChange(before, after, secretPaths = []) {
  const changes = changedPaths(before, after, secretPaths);
  if (!changes.length) return null;
  return `changed ${changes.length} setting${changes.length === 1 ? '' : 's'} — `
    + changes.map(describeChange).join('; ');
}
