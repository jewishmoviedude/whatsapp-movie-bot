/* Nothing dialable leaves the box. Run: node test/log-redaction.test.mjs

   The debug log is gzipped and attached to every error alert, so it lands in
   an external mailbox on events as mundane as a library timeout. It carried
   subscribers' full phone numbers next to what each of them asked to watch -
   nobody chose to send that; it was a side effect of attaching the raw log.

   Correlating a request to a job needs a stable handle, not a number you can
   ring, so the number is masked on the way out. */
import fs from 'node:fs';
import { redactPersonal } from '../src/util/mailer.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

console.log('=== phone numbers are masked, in every shape they are logged ===');
{
  for (const [raw, gone] of [
    ['from Jed Cole +1 (555) 821-0177', '8210177'],
    ['tagged 15558090186: added to the queue', '8090186'],
    ['banned +1 (555) 813-0191 from all groups', '8130191'],
    ['requested by +15558110179', '8110179'],
  ]) {
    const out = redactPersonal(raw);
    ok(!out.includes(gone), `the dialable part is gone: "${out}"`);
    ok(/\*\*\*/.test(out), 'and it is visibly masked rather than deleted');
  }
}

console.log('=== enough is kept to correlate a person across lines ===');
{
  // A log where every number is identical is useless for debugging.
  const a = redactPersonal('tagged 15558090186');
  const b = redactPersonal('requested by +1 (555) 809-0186');
  ok(a.includes('0186') && b.includes('0186'), 'the last four survive');
  ok(redactPersonal('15558090186') !== redactPersonal('15558110179'),
    'two different people still look different');
}

console.log('=== WhatsApp jids are masked BEFORE the phone pattern sees them ===');
{
  // A jid is a long digit run; letting the phone rule at it first chews the
  // middle and leaves a mangled half-identifier that is neither safe nor useful.
  const out = redactPersonal('sender 100000000002393@lid asked');
  ok(out === 'sender ***2393@lid asked', `clean mask: "${out}"`);
  ok(!/\+\d/.test(out), 'no half-rewritten phone number is left behind');

  ok(redactPersonal('cooldown:100000000000001@lid') === 'cooldown:***0001@lid', 'store keys too');
  ok(redactPersonal('15558090186@s.whatsapp.net') === '***0186@s.whatsapp.net', 'and full jids');
}

console.log('=== the log is still readable ===');
{
  for (const keep of [
    'downloaded 2.36 GB in 12m 25s (3.24 MB/s avg)',
    'The Hobbit: An Unexpected Journey (2014) — 1.66 GB',
    'convert DONE — encode, 1.80 GB in 25m 52s',
    'group cache refreshed: 15 groups',
    'reconnecting in 60s (attempt 192)',
  ]) {
    ok(redactPersonal(keep) === keep, `untouched: "${keep.slice(0, 46)}…"`);
  }
}

console.log('=== nonsense input is safe ===');
{
  ok(redactPersonal(null) === '', 'null becomes an empty string');
  ok(redactPersonal(undefined) === '', 'so does undefined');
  ok(redactPersonal('') === '', 'and an empty string stays empty');
}

console.log('=== it runs on the way OUT, not just at the log call ===');
{
  const mailer = fs.readFileSync(new URL('../src/util/mailer.js', import.meta.url), 'utf8');
  const block = mailer.match(/export async function sendLog[\s\S]*?const gz =[^\n]*\n/)[0];
  ok(/redactPersonal\(logText/.test(block),
    'sendLog scrubs before gzipping — the last point the text is still on our machine');
  ok(/gzipSync\(Buffer\.from\(safe/.test(block), 'and the attachment is built from the scrubbed copy');
  ok(!/gzipSync\(Buffer\.from\(logText/.test(mailer), 'the raw text is never what gets attached');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
