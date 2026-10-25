/* Per-member activity tracking. Run: node test/member-activity.test.mjs */
import { MemberActivity } from '../src/core/member-activity.js';
import { aggregateMembers, memberDetail } from '../src/core/members.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const T = 1_800_000_000_000;
const mk = (o = {}) => ({
  isGroup: true, fromMe: false, chatJid: 'g1@g.us', id: 'x',
  senderJid: 'aaa@lid', senderNumber: null, pushName: null, timestamp: T, ...o,
});

console.log('=== counting ===');
{
  const a = new MemberActivity();
  ok(a.record(mk()) === true, 'records a group message');
  ok(a.record(mk({ isGroup: false })) === false, 'ignores DMs');
  ok(a.record(mk({ fromMe: true })) === false, 'ignores our own messages');
  ok(a.record(mk({ senderJid: null, senderNumber: null })) === false, 'ignores unidentifiable senders');
  a.record(mk({ timestamp: T + 5000 }));
  const e = a.all()['lid:aaa@lid'];
  ok(e.msgCount === 2, 'counts each message');
  ok(e.firstSeen === T && e.lastSeen === T + 5000, 'tracks first and last seen');
  ok(e.perGroup['g1@g.us'].count === 2, 'per-group counts');
}

console.log('=== display name + per-group split ===');
{
  const a = new MemberActivity();
  a.record(mk({ pushName: 'Mark' }));
  a.record(mk({ chatJid: 'g2@g.us', pushName: 'Mark R' }));
  const e = a.all()['lid:aaa@lid'];
  ok(e.name === 'Mark R', 'keeps the most recent display name');
  ok(Object.keys(e.perGroup).length === 2, 'splits activity by group');
}

console.log('=== lid record folds into the number record when it resolves ===');
{
  const a = new MemberActivity();
  a.record(mk({ senderNumber: null, senderJid: 'aaa@lid', pushName: 'Mark' }));
  a.record(mk({ senderNumber: null, senderJid: 'aaa@lid' }));
  ok(a.size === 1 && a.all()['lid:aaa@lid'].msgCount === 2, 'starts keyed by lid');
  // now WhatsApp reveals the phone number for the same person
  a.record(mk({ senderNumber: '15551112222', senderJid: 'aaa@lid' }));
  ok(a.size === 1, 'still one person, not two rows');
  const e = a.all()['num:15551112222'];
  ok(e && e.msgCount === 3, 'earlier lid-only history carried over');
  ok(e.lid === 'aaa@lid' && e.number === '15551112222', 'both identities linked');
  ok(!a.all()['lid:aaa@lid'], 'stale lid row removed');
}

console.log('=== eviction keeps the store bounded ===');
{
  const a = new MemberActivity({ maxMembers: 3 });
  for (let i = 0; i < 6; i++) a.record(mk({ senderJid: `p${i}@lid`, timestamp: T + i * 1000 }));
  ok(a.size === 3, 'capped at maxMembers');
  ok(!!a.all()['lid:p5@lid'], 'most recent kept');
  ok(!a.all()['lid:p0@lid'], 'least recently active evicted');
}

console.log('=== persistence ===');
{
  const backing = {};
  const store = { get: (k, d) => backing[k] ?? d, set: (k, v) => { backing[k] = v; } };
  const a = new MemberActivity({ store });
  a.record(mk({ pushName: 'Mark' }));
  ok(backing.members && Object.keys(backing.members).length === 1, 'written to the store');
  const b = new MemberActivity({ store });
  ok(b.all()['lid:aaa@lid'].msgCount === 1, 'reloads after a restart');
  b.record(mk());
  ok(b.all()['lid:aaa@lid'].msgCount === 2, 'continues counting across the restart');
}

console.log('=== feeds the roster end-to-end ===');
{
  const a = new MemberActivity();
  a.record(mk({ senderNumber: '15551112222', senderJid: 'aaa@lid', pushName: 'Mark', timestamp: T }));
  a.record(mk({ chatJid: 'g2@g.us', senderNumber: '15551112222', senderJid: 'aaa@lid', timestamp: T + 1000 }));

  const groups = [
    { jid: 'g1@g.us', subject: 'Requests', members: [{ id: 'aaa@lid', number: null, admin: 'admin' }] },
    { jid: 'g2@g.us', subject: 'Posts', members: [{ id: 'aaa@lid', number: null, admin: null }] },
  ];
  const roster = aggregateMembers(groups, a.all());
  ok(roster.length === 1, 'one row for the person');
  ok(roster[0].name === 'Mark', 'name comes from activity');
  ok(roster[0].msgCount === 2 && roster[0].groupCount === 2, 'counts and group span');
  ok(roster[0].adminCount === 1, 'admin roles counted');
  ok(roster[0].number === '15551112222', 'lid resolved to the phone number via activity');

  const events = [{ ts: T - 9000, action: 'add', groupJid: 'g1@g.us', groupName: 'Requests', actorNumber: '15550000000', targets: [{ jid: 'aaa@lid' }] }];
  const d = memberDetail({ member: roster[0], events, activity: a.all() });
  ok(d.timeline.length === 1 && d.timeline[0].by === '+15550000000', 'join event with attribution');
  ok(d.perGroup['g1@g.us'].count === 1, 'per-group activity in the detail');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
