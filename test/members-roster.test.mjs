/* Cross-group member roster aggregation. Run: node test/members-roster.test.mjs */
import { aggregateMembers, memberTimeline, memberDetail, memberKey } from '../src/core/members.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

console.log('=== memberKey ===');
ok(memberKey({ number: '15551112222' }) === 'num:15551112222', 'number wins');
ok(memberKey({ id: 'abc@lid' }) === 'lid:abc@lid', 'falls back to lid');
ok(memberKey({}) === null, 'nothing -> null');

console.log('=== aggregate dedups across groups ===');
{
  const groups = [
    { jid: 'g1@g.us', subject: 'Movies', members: [
      { id: 'aaa@lid', number: null, admin: 'admin' },
      { id: 'bbb@lid', number: null, admin: null },
    ] },
    { jid: 'g2@g.us', subject: 'TV', members: [
      { id: 'aaa@lid', number: null, admin: null },        // same person, second group
      { id: 'ccc@lid', number: null, admin: 'superadmin' },
    ] },
  ];
  const list = aggregateMembers(groups, {});
  ok(list.length === 3, 'three unique members across two groups');
  const a = list.find((m) => m.id === 'aaa@lid');
  ok(a.groupCount === 2, 'aaa is in 2 groups');
  ok(a.adminCount === 1, 'aaa is admin in exactly one group');
  ok(a.groups.some((g) => g.subject === 'Movies' && g.admin === 'admin'), 'admin flag preserved per group');
  const c = list.find((m) => m.id === 'ccc@lid');
  ok(c.adminCount === 1 && c.groupCount === 1, 'ccc superadmin counted');
}

console.log('=== activity overlay + lid/number merge ===');
{
  const groups = [
    { jid: 'g1@g.us', subject: 'Movies', members: [{ id: 'aaa@lid', number: null, admin: null }] },
    // same human shows as a phone JID in another group
    { jid: 'g2@g.us', subject: 'TV', members: [{ id: '15551112222@s.whatsapp.net', number: '15551112222', admin: null }] },
  ];
  // activity links the @lid to the phone number and carries stats
  const activity = {
    'num:15551112222': { key: 'num:15551112222', lid: 'aaa@lid', number: '15551112222', name: 'Mommy', msgCount: 42, firstSeen: 1000, lastSeen: 9000, perGroup: { 'g1@g.us': { count: 40, lastSeen: 9000 } } },
  };
  const list = aggregateMembers(groups, activity);
  ok(list.length === 1, 'lid + phone-JID appearances merged via activity linkage into one row');
  ok(list[0].groupCount === 2, 'merged member spans both groups');
  ok(list[0].msgCount === 42 && list[0].name === 'Mommy', 'activity stats + name overlaid');
}

console.log('=== sort: most active first ===');
{
  const groups = [{ jid: 'g@g.us', subject: 'G', members: [
    { id: 'quiet@lid' }, { id: 'loud@lid' },
  ] }];
  const activity = {
    'lid:quiet@lid': { lid: 'quiet@lid', msgCount: 2 },
    'lid:loud@lid': { lid: 'loud@lid', msgCount: 99 },
  };
  const list = aggregateMembers(groups, activity);
  ok(list[0].id === 'loud@lid', 'busiest member sorts first');
}

console.log('=== timeline matches by lid and by number ===');
{
  const events = [
    { ts: 300, action: 'promote', groupJid: 'g1@g.us', groupName: 'Movies', actor: null, actorNumber: '15550000000', targets: [{ jid: 'aaa@lid', number: null }] },
    { ts: 100, action: 'add', groupJid: 'g1@g.us', groupName: 'Movies', actor: 'admin@lid', actorNumber: null, targets: [{ jid: 'aaa@lid', number: null }] },
    { ts: 200, action: 'add', groupJid: 'g2@g.us', groupName: 'TV', actor: null, actorNumber: null, targets: [{ jid: 'zzz@lid', number: '15551112222' }] },
    { ts: 400, action: 'remove', groupJid: 'g9@g.us', groupName: 'Other', targets: [{ jid: 'someone@lid', number: null }] },
  ];
  const t1 = memberTimeline(events, { id: 'aaa@lid', number: null });
  ok(t1.length === 2, 'two events for aaa');
  ok(t1[0].ts === 100 && t1[1].ts === 300, 'chronological (oldest first)');
  ok(t1[0].action === 'add' && t1[1].by === '+15550000000', 'action + actor attribution');
  const t2 = memberTimeline(events, { id: null, number: '15551112222' });
  ok(t2.length === 1 && t2[0].groupName === 'TV', 'matched by number when lid unknown');
  const t3 = memberTimeline(events, { id: 'nobody@lid', number: null });
  ok(t3.length === 0, 'member with no recorded events -> empty timeline (joined before tracking)');
}

console.log('=== memberDetail combines everything ===');
{
  const member = { key: 'lid:aaa@lid', id: 'aaa@lid', number: null, groups: [{ jid: 'g1@g.us', subject: 'Movies', admin: 'admin' }], groupCount: 1, adminCount: 1, msgCount: 5 };
  const events = [{ ts: 100, action: 'add', groupJid: 'g1@g.us', groupName: 'Movies', targets: [{ jid: 'aaa@lid' }] }];
  const activity = { 'lid:aaa@lid': { lid: 'aaa@lid', perGroup: { 'g1@g.us': { count: 5, lastSeen: 8000 } } } };
  const d = memberDetail({ member, events, activity });
  ok(d.timeline.length === 1 && d.timeline[0].action === 'add', 'detail carries the timeline');
  ok(d.perGroup['g1@g.us'].count === 5, 'detail carries per-group activity');
  ok(d.adminCount === 1, 'detail keeps roster fields');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
