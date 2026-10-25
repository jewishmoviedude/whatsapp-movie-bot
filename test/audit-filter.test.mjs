/* Finding one thing in the audit log. Run: node test/audit-filter.test.mjs

   The log is one flat stream of every mutating request, so "who reset a
   password last week" meant scrolling past hundreds of settings saves. */
import fs from 'node:fs';
import { categoryOf, filterAudit, categoryCounts, summariseAdmin, auditCategories } from '../src/core/audit-filter.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const EV = [
  { ts: 100, user: 'mommy', action: 'login' },
  { ts: 200, user: 'mommy', action: 'reset password for "fishy"' },
  { ts: 300, user: 'mark', action: 'cancelled "Red Notice (2021)"', detail: 'requested by +1555***0186' },
  { ts: 400, user: 'mark', action: 'banned +1718 from all groups' },
  { ts: 500, user: 'mommy', action: 'locked all groups (manual)' },
  { ts: 600, user: 'mommy', action: 'changed settings', detail: 'media.concurrency: 2 → 3' },
  { ts: 700, user: 'mark', action: 'switched WhatsApp to "Rachel"' },
  { ts: 800, user: 'mommy', action: 'POST /api/something' },
];

console.log('=== actions land in the bucket someone would look in ===');
{
  ok(categoryOf({ action: 'login' }) === 'signin', 'login → sign in');
  ok(categoryOf({ action: 'reset password for "x"' }) === 'accounts', 'password reset → accounts');
  ok(categoryOf({ action: 'cancelled "Film"' }) === 'queue', 'a cancellation → queue');
  ok(categoryOf({ action: 'banned +1 from all groups' }) === 'moderation', 'a ban → moderation');
  ok(categoryOf({ action: 'locked all groups (manual)' }) === 'lockdown', 'lockdown → its own bucket');
  ok(categoryOf({ action: 'switched WhatsApp to "X"' }) === 'numbers', 'a number switch → numbers');
  ok(categoryOf({ action: 'changed settings' }) === 'settings', 'a settings save → settings');
  ok(categoryOf({ action: 'POST /api/whatever' }) === 'other', 'and anything unrecognised still lands somewhere');
}

console.log('=== a ban is moderation, not lockdown ===');
{
  // Both mention groups; putting a ban under lockdown would hide it from the
  // person looking for it.
  ok(categoryOf({ action: 'removed +1718 across 5 group(s)' }) === 'moderation', 'removing someone is moderation');
  ok(categoryOf({ action: 'unlocked all groups (manual)' }) === 'lockdown', 'unlocking is lockdown');
}

console.log('=== filtering by person ===');
{
  const r = filterAudit(EV, { user: 'mommy' });
  ok(r.total === 5, `only their entries (${r.total})`);
  ok(r.events.every((e) => e.user === 'mommy'), 'and nobody else\'s');
  ok(filterAudit(EV, { user: 'MOMMY' }).total === 5, 'the name is matched case-insensitively');
  ok(filterAudit(EV, { user: 'nobody' }).total === 0, 'an unknown name returns nothing rather than everything');
}

console.log('=== filtering by category, and by both at once ===');
{
  ok(filterAudit(EV, { category: 'queue' }).total === 1, 'one queue action');
  ok(filterAudit(EV, { category: 'all' }).total === EV.length, '"all" means all');
  const both = filterAudit(EV, { user: 'mark', category: 'moderation' });
  ok(both.total === 1 && both.events[0].action.startsWith('banned'), 'person and category combine');
}

console.log('=== free-text search covers the detail, not just the action ===');
{
  ok(filterAudit(EV, { q: 'Red Notice' }).total === 1, 'a title in the action');
  ok(filterAudit(EV, { q: 'concurrency' }).total === 1, 'and one only present in the detail');
  ok(filterAudit(EV, { q: 'MOMMY' }).total === 5, 'the username too, case-insensitively');
  ok(filterAudit(EV, { q: 'nothing here' }).total === 0, 'no match returns empty');
}

console.log('=== paging ===');
{
  const p1 = filterAudit(EV, { limit: 3 });
  ok(p1.events.length === 3 && p1.total === 8, 'a page reports the FULL total, not the page size');
  const p2 = filterAudit(EV, { limit: 3, offset: 3 });
  ok(p2.events[0].ts === EV[3].ts, 'the offset moves through in order');
}

console.log('=== the counts drive the filter buttons ===');
{
  const all = categoryCounts(EV);
  ok(all.all === 8, 'a total');
  ok(all.queue === 1 && all.accounts === 1 && all.signin === 1, 'and a count per bucket');

  const mine = categoryCounts(EV, { user: 'mark' });
  ok(mine.all === 3, 'scoped to one person when asked');
  ok(mine.accounts === 0, 'buckets they never touched read zero, so they can be hidden');
}

console.log('=== an admin summary answers "what does this person do" ===');
{
  const s = summariseAdmin(EV, 'mommy');
  ok(s.total === 5, 'how many actions');
  ok(s.first === 100 && s.last === 800, 'and over what period');
  ok(s.top.length > 0 && s.top[0].count >= s.top[s.top.length - 1].count, 'their commonest first');
  ok(s.top.every((t) => t.label && t.label !== t.key), 'labelled for reading, not raw keys');

  const none = summariseAdmin(EV, 'ghost');
  ok(none.total === 0 && none.first === null, 'someone with no activity summarises cleanly');
}

console.log('=== the API and portal are wired to it ===');
{
  const api = fs.readFileSync(new URL('../src/web/api.js', import.meta.url), 'utf8');
  ok(/router\.get\('\/admins\/:username\/audit'/.test(api), 'one admin\'s activity has its own route');
  // Each entry with its numbers as +digits (auditShown, 2026-10-01), still a bare array.
  ok(/if \(!user && !category && !q && !limit && !offset\) return res\.json\(events(?:\.map\(auditShown\))?\)/.test(api),
    'an unfiltered request still returns the old bare array, so nothing else breaks');

  const app = fs.readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
  ok(/window\.showAdminAudit/.test(app), 'clicking an admin opens their activity');
  ok(/window\.setAuditCat/.test(app), 'and the Logs tab has category buttons');
  ok(/Nothing matches those filters/.test(app),
    'an empty filtered result says so, rather than claiming nothing was ever recorded');
  ok(auditCategories().length >= 8, 'there are enough buckets to be useful');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
