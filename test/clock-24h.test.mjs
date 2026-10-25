/* Every time the panel and the bot show is on the 24-hour clock. Run: node test/clock-24h.test.mjs

   The operator's rule: "everything in panel and bot programming should be 24
   hour time format". The panel showed times the browser's way - "4:37:19 PM"
   for an American browser - through 27 separate toLocaleString calls, and the
   nudity-check alerts said "Sep 22, 9:14 AM".

   It has to be hourCycle 'h23', not hour12: false: en-US with hour12: false
   writes the hour after midnight as "24", which is how nyHour() answered 24
   instead of 0 between midnight and one, and the nightly backup's "is it past
   the configured hour yet" was true at 00:30 whatever the hour was set to.

   The scan below fails on a time formatted any other way, so the rule holds
   for code written later, too. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fmtTime } from '../src/core/content-check-health.js';
import { nyHour, isDue } from '../src/core/activity-backup.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  return e.isDirectory() ? files(p) : /\.(m?js)$/.test(e.name) ? [p] : [];
});

/**
 * The source with comments blanked out - newlines kept, so line numbers still
 * point at the right place - and string and regex literals left intact.
 * A "/" starts a regex literal where an operator or opening bracket comes
 * before it (the usual rule); otherwise the quotes inside /[&<>"']/ would be
 * read as the start of a string, and everything after it out of step.
 */
function code(src) {
  let out = '';
  const blank = (t) => t.replace(/[^\n]/g, ' ');
  const regexCanStart = () => {
    const before = out.replace(/\s+$/, '');
    return !before || /[(,=:[!&|?{};+\-*%<>~^]$/.test(before) || /\b(return|typeof|case|of|in)$/.test(before);
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (c === '"' || c === "'" || c === '`') {
      const q = c; out += c;
      for (i++; i < src.length && src[i] !== q; i++) { if (src[i] === '\\') out += src[i++]; out += src[i]; }
      out += q; continue;
    }
    if (c === '/' && n === '*') { const end = src.indexOf('*/', i + 2); const stop = end < 0 ? src.length : end + 2; out += blank(src.slice(i, stop)); i = stop - 1; continue; }
    if (c === '/' && n === '/') { const end = src.indexOf('\n', i); const stop = end < 0 ? src.length : end; out += blank(src.slice(i, stop)); i = stop - 1; continue; }
    if (c === '/' && regexCanStart()) {
      let j = i + 1, inClass = false;
      for (; j < src.length && src[j] !== '\n'; j++) {
        if (src[j] === '\\') { j++; continue; }
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) break;
      }
      out += src.slice(i, j + 1); i = j; continue;
    }
    out += c;
  }
  return out;
}

/** The argument text of the call whose "(" is at `open`. */
function argsAt(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')' && --depth === 0) return s.slice(open + 1, i);
  }
  return s.slice(open + 1);
}

const H23 = /hourCycle:\s*'h23'|CLOCK_24/;

console.log('=== no time anywhere in src/ is formatted on a 12-hour clock ===');
{
  const problems = [];
  const where = (file, s, i) => `${path.relative(ROOT, file)}:${s.slice(0, i).split('\n').length}`;
  for (const file of files(path.join(ROOT, 'src'))) {
    const s = code(fs.readFileSync(file, 'utf8'));
    for (const m of s.matchAll(/\bhour12\b/g)) problems.push(`${where(file, s, m.index)} uses hour12 (midnight comes out as 24) - use hourCycle: 'h23'`);
    for (const m of s.matchAll(/\.(toLocaleTimeString|toLocaleString)\(|new Intl\.DateTimeFormat\(/g)) {
      const args = argsAt(s, m.index + m[0].length - 1);
      const kind = m[1] ?? 'DateTimeFormat';
      const hasTime = kind !== 'toLocaleString' || /\bhour\b/.test(args)
        // A bare toLocaleString() on a date prints the time too; on a number it
        // does not, so only a call on something date-like is held to it.
        || (!args.trim() && /(Date\([^()]*\)|\bd|\bdate|\bat|\bts|\bwhen)\s*$/.test(s.slice(Math.max(0, m.index - 40), m.index)));
      if (hasTime && !H23.test(args)) problems.push(`${where(file, s, m.index)} ${kind}(${args.trim().slice(0, 60)}) is not on the 24-hour clock`);
    }
    for (const m of s.matchAll(/['"`][^'"`\n]*\b\d{1,2}(:\d{2})?\s?[AaPp]\.?[Mm]\.?\b[^'"`\n]*['"`]/g)) {
      problems.push(`${where(file, s, m.index)} has a 12-hour time in a string: ${m[0].slice(0, 60)}`);
    }
  }
  ok(problems.length === 0, `every time is formatted with hourCycle 'h23'${problems.length ? `:\n       ${problems.join('\n       ')}` : ''}`);
}

console.log('=== the panel\'s helpers ===');
{
  // Lifted out of app.js and run, so what is tested is what the browser runs.
  const app = fs.readFileSync(path.join(ROOT, 'src/web/public/app.js'), 'utf8');
  const pick = (re) => app.match(re)?.[0] ?? '';
  const helpers = [
    pick(/const CLOCK_24 = .*;/), pick(/const HM = .*;/),
    pick(/function fmtDateTime\([\s\S]*?\n\}/), pick(/function fmtClock\([\s\S]*?\n\}/),
  ].join('\n');
  // eslint-disable-next-line no-new-func
  const h = new Function(`${helpers}\nreturn { fmtDateTime, fmtClock, HM };`)();
  const at = (iso) => new Date(iso).getTime();
  const noon = at('2026-09-25T16:05:09'), midnight = at('2026-09-25T00:05:09');
  ok(/16:05:09/.test(h.fmtDateTime(noon)) && !/[AP]M/i.test(h.fmtDateTime(noon)), `a date and time: "${h.fmtDateTime(noon)}"`);
  ok(/^00:05:09$/.test(h.fmtClock(midnight)), `five past midnight is 00:05, never 12:05 AM or 24:05 ("${h.fmtClock(midnight)}")`);
  ok(h.fmtClock(noon, h.HM) === '16:05', `hours and minutes: "${h.fmtClock(noon, h.HM)}"`);
  ok(!/toLocale(Time)?String\(\)/.test(app), 'and no bare toLocaleString() or toLocaleTimeString() is left in app.js');
}

console.log('=== the bot\'s own ===');
{
  ok(fmtTime(Date.parse('2026-09-22T13:14:00Z')) === 'Sep 22, 09:14 New York time', `nudity-check alerts: "${fmtTime(Date.parse('2026-09-22T13:14:00Z'))}"`);
  ok(fmtTime(Date.parse('2026-09-23T01:05:00Z')) === 'Sep 22, 21:05 New York time', 'an evening one is 21:05');
  ok(fmtTime(Date.parse('2026-09-23T04:05:00Z')) === 'Sep 23, 00:05 New York time', 'and five past midnight is 00:05');

  const nyMidnight = Date.parse('2026-01-01T05:30:00Z');       // 00:30 in New York
  ok(nyHour(nyMidnight) === 0, `nyHour at 00:30 New York is 0, not 24 (${nyHour(nyMidnight)})`);
  ok(!isDue({ enabled: true, hour: 4 }, { now: nyMidnight, lastRun: null }),
    'so a backup set for 04:00 is not run at 00:30 - with hour12: false it was, as 24 >= 4');
  ok(isDue({ enabled: true, hour: 4 }, { now: Date.parse('2026-01-01T09:05:00Z'), lastRun: null }), 'and is run at 04:05');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
