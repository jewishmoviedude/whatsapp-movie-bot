/* The Google Drive Links group's document: its links are kept, organized, and
   posted nightly and to new members. Run: node test/drive-links-document-for-new-members.test.mjs

   The operator, 2026-10-23: "pull everything posted in the past on google drive
   links and organize it into a docx file for new members, then post in group, do
   so daily at 0000 ... any time a new member joins that group without history,
   ... send them the history". The bot kept only message ids there, so the past is
   the group's Export chat. */
import zlib from 'node:zlib';
import fs from 'node:fs';
import { buildDocx, crc32 } from '../src/media/docx.js';
import { DriveLinks, parseMessage, importExport, canonicalUrl, documentBlocks, newYorkParts } from '../src/core/drive-links.js';
import { DriveLinksJob } from '../src/core/drive-links-job.js';
import { runAdminCommand } from '../src/core/admin-commands.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const GROUP = '120363900000000004@g.us';
const BETA = '120363900000000014@g.us';

/** Reads the parts of a .docx back: { name -> text }. */
function unzip(buf) {
  const out = {};
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054B50) eocd -= 1;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i += 1) {
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20), crc = buf.readUInt32LE(p + 16);
    const nameLen = buf.readUInt16LE(p + 28), local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataStart, dataStart + size);
    const data = method === 8 ? zlib.inflateRawSync(raw) : raw;
    if (crc32(data) !== crc) throw new Error(`bad crc for ${name}`);
    out[name] = data.toString('utf8');
    p += 46 + nameLen;
  }
  return out;
}
const store = () => { const m = new Map(); return { get: (k, d = null) => (m.has(k) ? m.get(k) : d), set: (k, v) => m.set(k, v), push() {}, _m: m }; };

console.log('=== reading a post: titles, seasons, notes ===');
{
  const a = parseMessage('> The Summer I Turned Pretty\n\n`Season 1`\nhttps://drive.google.com/drive/folders/AAA111\n\n`Season 2`\nhttps://drive.google.com/drive/folders/BBB222');
  ok(a.length === 2 && a[0].title === 'The Summer I Turned Pretty' && a[0].label === 'Season 1' && a[1].label === 'Season 2', 'a title, then a label before each link');
  const b = parseMessage('> NCIS: Tony & Ziva\n\n`Season 1 Episode 4`\nhttps://drive.google.com/file/d/FILE444/view');
  ok(b[0].title === 'NCIS: Tony & Ziva' && b[0].label === 'Season 1 Episode 4' && b[0].kind === 'file', 'an episode file');
  const c = parseMessage('https://drive.google.com/drive/folders/CCC333\nSeasons 1-6');
  ok(c[0].title === null && c[0].note === 'Seasons 1-6', 'a line after the link is its note');
  const d = parseMessage('https://docs.google.com/document/d/DOC555/edit');
  ok(d[0].kind === 'doc', 'a Google Doc');
  ok(parseMessage('Thanks for the links!').length === 0 && parseMessage('https://chat.whatsapp.com/xyz').length === 0, 'chat and other links are not Drive links');
  ok(canonicalUrl('https://drive.google.com/file/d/ABC/view?usp=drivesdk') === 'https://drive.google.com/file/d/ABC/view', 'the same file shared two ways is one link');
}

console.log('=== the chat export ===');
{
  const sample = [
    '3/19/25, 14:56 - +1 (555) 808-0185: https://drive.google.com/drive/folders/AAA111',
    '8/20/25, 11:31 - +1 (555) 808-0185: `The Summer I Turned Pretty`',
    '',
    '> Season 1',
    'https://drive.google.com/drive/folders/BBB222',
    '8/21/25, 1:05 PM - Head Admin: <Media omitted>',
    '8/25/25, 19:09 - +1 (555) 808-0185: This message was deleted',
    '9/1/25, 12:00 AM - +1 (555) 803-0188: https://drive.google.com/drive/folders/CCC333',
    'Seasons 1-6',
    '10/1/25, 09:00 - Messages and calls are end-to-end encrypted.',
  ].join('\n');
  const e = importExport(sample);
  ok(e.length === 3, `three links (${e.length})`);
  ok(e[0].date === '2025-03-19' && e[2].date === '2025-09-01' && e[2].time === '00:00', '12 AM is midnight, dates are ISO');
  ok(e[1].title === 'The Summer I Turned Pretty' && e[1].label === 'Season 1', 'a title on its own line before a label');
  ok(e[2].note === 'Seasons 1-6', 'a note on the next line');
}

console.log('=== the archive: new links only, a repost brings news ===');
{
  const d = new DriveLinks({ store: store(), getConfig: () => ({ driveLinks: { enabled: true, group: GROUP } }), now: () => Date.parse('2026-10-24T12:00:00Z') });
  ok(d.add([{ url: 'https://drive.google.com/drive/folders/AAA111', title: 'Show', label: 'Season 3', date: '2025-08-20', note: 'Just episodes 6 and 7' }]) === 1, 'one kept');
  ok(d.add([{ url: 'https://drive.google.com/drive/folders/AAA111', title: 'Show', label: 'Episode 11 added', date: '2025-09-17' }]) === 0, 'the same folder again is not a new link');
  ok(d.items()[0].note === 'Episode 11 added' && d.items()[0].label === 'Season 3', 'but its note is the newest word on it');
  ok(d.observe({ chatJid: GROUP, text: 'https://drive.google.com/drive/folders/NEW999', timestamp: Date.parse('2026-10-24T03:30:00Z') }) === 1, 'a live post in the group is kept');
  ok(d.items().find((i) => i.url.endsWith('NEW999')).date === '2026-10-23', 'dated in New York (03:30 UTC is still the 23rd there)');
  ok(d.observe({ chatJid: BETA, text: 'https://drive.google.com/drive/folders/ELSE' }) === 0 && d.observe({ chatJid: GROUP, fromMe: true, text: 'https://drive.google.com/drive/folders/ME' }) === 0, 'another group, or the bot\'s own post, is not');
}

console.log('=== the names Drive gives untitled links ===');
{
  const asked = [];
  const d = new DriveLinks({ store: store(), getConfig: () => ({}), fetchTitle: async (u) => { asked.push(u); return u.endsWith('X1') ? 'Every Year After Season 01 (720p)' : null; }, now: () => 1 });
  d.add([
    { url: 'https://drive.google.com/drive/folders/X1', date: '2026-08-24' },
    { url: 'https://drive.google.com/drive/folders/X2', date: '2026-08-25' },
    { url: 'https://drive.google.com/drive/folders/T1', title: 'Titled', date: '2026-08-26' },
  ]);
  await d.nameLinks({ pauseMs: 0, sleep: async () => {} });
  ok(asked.length === 2 && !asked.some((u) => u.endsWith('T1')), 'only the untitled are asked');
  await d.nameLinks({ pauseMs: 0, sleep: async () => {} });
  ok(asked.length === 2, 'and a name found, or tried today, is not asked again');
  const text = JSON.stringify(documentBlocks(d.items(), d.store.get('titles'), 0));
  ok(/Every Year After/.test(text) && /Season 1 \(720p\)/.test(text), 'the name is in the document, under its show');
}

console.log('=== the document: organized, with no one\'s number ===');
{
  const items = [
    { url: 'https://drive.google.com/drive/folders/S10', kind: 'folder', title: 'The Rookie', label: 'Season 10', date: '2026-01-22' },
    { url: 'https://drive.google.com/drive/folders/S2', kind: 'folder', title: 'The Rookie', label: 'Season 2', date: '2026-01-21' },
    { url: 'https://drive.google.com/drive/folders/A', kind: 'folder', title: 'Alpha', label: 'Season 1', date: '2025-08-20' },
    { url: 'https://drive.google.com/drive/folders/L1', kind: 'folder', title: null, label: null, date: '2026-08-24' },
    { url: 'https://docs.google.com/document/d/D/edit', kind: 'doc', title: null, label: 'Repost bc it\'s super helpful', date: '2025-04-10' },
  ];
  const blocks = documentBlocks(items, { 'https://drive.google.com/drive/folders/L1': { name: 'Every Year After Season 01', at: 1 } }, Date.parse('2026-10-24T12:00:00Z'));
  const heads = blocks.filter((b) => b.h).map((b) => b.text);
  ok(heads.join('|') === 'Google Drive Links|Shows and movies|Alpha|Every Year After|The Rookie|Link lists made by members', `sections: ${heads.join(' | ')}`);
  ok(JSON.stringify(blocks).includes('Season 1') && /Every Year After[\s\S]*Season 1/.test(JSON.stringify(blocks)), 'a folder Drive names "Every Year After Season 01" joins its show, as Season 1');
  const rookie = blocks.filter((b) => b.bullet && /Season (2|10) —/.test(JSON.stringify(b.bullet))).map((b) => b.bullet[0]);
  ok(rookie.join() === 'Season 2 — ,Season 10 — ', `seasons in number order, not text order (${rookie.join()})`);
  const all = JSON.stringify(blocks);
  ok(/Every Year After/.test(all) && /Google Doc of links/.test(all) && !/Repost bc/.test(all), 'a name for the untitled; the Doc listed plainly');
  ok(!/\+?\d{1,2}[ (]\d{3}[) ]\s?\d{3}[- ]\d{4}/.test(all), 'no phone number anywhere in it');
}

console.log('=== names that belong to a show, and notes already in brackets ===');
{
  const { splitName } = await import('../src/core/drive-links.js');
  ok(JSON.stringify(splitName('Reacher Season 04')) === '{"title":"Reacher","label":"Season 4"}', '"Reacher Season 04" is Reacher, Season 4');
  ok(splitName('Outer Banks Season 05 (720p)').label === 'Season 5 (720p)', 'what follows is kept');
  ok(splitName('The Rookie Feds Season 01 (720p)').title === 'The Rookie Feds', 'a longer title');
  ok(splitName('Mayday (2026)') === null && splitName('The Mentalist') === null, 'other names are not split');
  const b = documentBlocks([{ url: 'https://drive.google.com/drive/folders/Q', kind: 'folder', label: null, date: '2025-03-23', note: "(I'm aware everything isn't here)" }], {}, 0);
  ok(JSON.stringify(b).includes('(I\'m aware everything isn\'t here)') && !JSON.stringify(b).includes('((I'), 'one set of brackets');
}

console.log('=== the .docx is a real one ===');
{
  const buf = buildDocx({ title: 'Google Drive Links', blocks: [{ h: 1, text: 'Tom & Jerry <1>' }, { bullet: ['a — ', { text: 'https://x.test/?a=1&b=2', url: 'https://x.test/?a=1&b=2' }] }] });
  const parts = unzip(buf);
  ok(['[Content_Types].xml', 'word/document.xml', 'word/_rels/document.xml.rels', 'word/styles.xml'].every((n) => n in parts), 'the parts a Word file needs');
  ok(parts['word/document.xml'].includes('Tom &amp; Jerry &lt;1&gt;'), 'text is escaped');
  ok(/Target="https:\/\/x\.test\/\?a=1&amp;b=2" TargetMode="External"/.test(parts['word/_rels/document.xml.rels']), 'a link is a real hyperlink');
  ok(buf.subarray(0, 2).toString() === 'PK', 'it starts as a zip');
}

console.log('=== the nightly post: 00:00 New York, once, never on a locked night ===');
{
  const mk = ({ post = true, locked = false, links = true, connected = true, failSend = false } = {}) => {
    const sent = [];
    const st = store();
    const drive = new DriveLinks({ store: store(), getConfig: () => ({ driveLinks: { enabled: true, post, group: GROUP } }), fetchTitle: async () => null, now: () => 0 });
    if (links) drive.add([{ url: 'https://drive.google.com/drive/folders/A', title: 'Alpha', label: 'Season 1', date: '2025-08-20' }]);
    drive.nameLinks = async () => 0;
    let t = Date.parse('2026-10-24T04:05:00Z');   // 00:05 in New York (EDT)
    const bot = { isConnected: () => connected, sendDocument: async (jid, file, o) => { if (failSend) throw new Error('boom'); sent.push({ jid, name: o.fileName, mime: o.mimetype, exists: fs.existsSync(file), caption: o.caption }); return {}; }, sendText: async (jid, text, o) => { sent.push({ jid, text, mentions: o.mentions }); }, numberFromJid: (j) => j.split('@')[0].replace(/\D/g, '') || null, isSelf: (j) => j === 'me@s.whatsapp.net' };
    const job = new DriveLinksJob({ drive, bot, store: st, isLocked: () => locked, now: () => t });
    return { job, sent, st, setT: (v) => { t = v; } };
  };
  ok(newYorkParts(Date.parse('2026-10-24T04:05:00Z')).hour === 0, '04:05 UTC is 00:05 in New York in October');
  ok(newYorkParts(Date.parse('2026-12-24T05:05:00Z')).hour === 0, 'and 05:05 UTC in December (winter time)');

  const a = mk();
  ok(await a.job.tick() === 'posted' && a.sent.length === 1 && a.sent[0].jid === GROUP, 'posted to the group just after midnight');
  ok(a.sent[0].name === 'Google Drive Links.docx' && /wordprocessingml/.test(a.sent[0].mime) && a.sent[0].exists, 'a .docx, from a file that existed');
  ok(await a.job.tick() === 'posted-already' && a.sent.length === 1, 'once a night');
  a.setT(Date.parse('2026-10-24T09:00:00Z'));
  ok(await a.job.tick() === 'not-night', 'not at 5 am');
  a.setT(Date.parse('2026-10-25T04:05:00Z'));
  ok(await a.job.tick() === 'posted' && a.sent.length === 2, 'and again the next night');

  ok(await mk({ post: false }).job.tick() === 'off', 'off while driveLinks.post is off');
  const l = mk({ locked: true });
  ok(await l.job.tick() === 'locked' && l.sent.length === 0 && await l.job.tick() === 'skipped', 'a locked night (Shabbos, yom tov) is skipped, not made up');
  ok(await mk({ links: false }).job.tick() === 'empty', 'nothing to post with no links');
  ok(await mk({ connected: false }).job.tick() === 'not-ready', 'not while WhatsApp is down');
  const f = mk({ failSend: true });
  ok(await f.job.tick() === 'failed' && f.st.get('lastPostedDate') == null && f.st.get('lastError')?.message === 'boom', 'a failure is kept and tried again');
}

console.log('=== a member who joins gets it, tagged, in the group ===');
{
  const sent = [];
  const drive = new DriveLinks({ store: store(), getConfig: () => ({ driveLinks: { enabled: true, post: true, group: GROUP } }), now: () => 0 });
  drive.add([{ url: 'https://drive.google.com/drive/folders/A', title: 'Alpha', date: '2025-08-20' }]);
  drive.nameLinks = async () => 0;
  const bot = { isConnected: () => true, isSelf: (j) => j === 'me@s.whatsapp.net', numberFromJid: (j) => (j.startsWith('1') ? j.split('@')[0] : null), sendDocument: async (jid) => { sent.push({ doc: jid }); }, sendText: async (jid, text, o) => { sent.push({ jid, text, mentions: o.mentions }); } };
  const job = new DriveLinksJob({ drive, bot, store: store(), now: () => 1_000_000 });
  ok(job.onJoin(BETA, ['15551110000@s.whatsapp.net']) === 0, 'a join in another group is not for this');
  ok(job.onJoin(GROUP, ['15551110000@s.whatsapp.net', 'me@s.whatsapp.net', '15552220000@s.whatsapp.net', '15551110000@s.whatsapp.net']) === 2, 'the bot itself and a repeat are not counted');
  clearTimeout(job.joinTimer);
  ok(await job.flushJoins() === 'posted', 'one post for the batch');
  ok(sent[0].text.includes('@15551110000') && sent[0].text.includes('@15552220000') && sent[0].mentions.length === 2, 'tagging each by name');
  ok(sent[1].doc === GROUP && sent.length === 2, 'and the document, in the group, never a private message');
  ok(await job.flushJoins() === 'nothing', 'nothing more to send');
  const off = new DriveLinksJob({ drive: new DriveLinks({ store: store(), getConfig: () => ({ driveLinks: { enabled: true, post: false, group: GROUP } }) }), bot, store: store() });
  ok(off.onJoin(GROUP, ['15551110000@s.whatsapp.net']) === 0, 'nothing while posting is off');
}

console.log('=== the admin commands: import the past, try it in a group ===');
{
  const drive = new DriveLinks({ store: store(), getConfig: () => ({}), now: () => 0 });
  const calls = [];
  const bot = { driveLinks: drive, driveLinksJob: { postTo: async (jid, cap) => { calls.push([jid, cap]); return { links: 2 }; } } };
  const r = await runAdminCommand({ op: 'import-drive-links', entries: [{ url: 'https://drive.google.com/drive/folders/A', title: 'Alpha', date: '2025-08-20' }, { url: 'not a link' }] }, { bot });
  ok(r.ok && r.added === 1 && r.total === 1, 'links kept, a non-link ignored');
  ok((await runAdminCommand({ op: 'import-drive-links', entries: [{ url: 'https://drive.google.com/drive/folders/A', date: '2025-08-20' }] }, { bot })).added === 0, 'importing again adds nothing');
  const p = await runAdminCommand({ op: 'post-drive-links', to: BETA }, { bot });
  ok(p.ok && p.links === 2 && calls[0][0] === BETA, 'the document sent to the group asked for');
  let err = null;
  try { await runAdminCommand({ op: 'post-drive-links', to: '15551110000@s.whatsapp.net' }, { bot }); } catch (e) { err = e; }
  ok(err && /group jid/.test(err.message), 'but never to a person');
}

console.log('=== the tool and the routine ===');
{
  const root = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  ok(/import-drive-links/.test(root('tools/import-whatsapp-export.mjs')), 'tools/import-whatsapp-export.mjs queues the import');
  ok(/bot\.driveLinksJob\.start\(\)/.test(root('src/index.js')) && /bot\.driveLinks\.observe\(msg\)/.test(root('src/index.js')), 'the bot keeps links and runs the job');
  ok(/ev\.action === 'add'/.test(root('src/index.js')) && /onJoin\(ev\.groupJid/.test(root('src/index.js')), 'and hears about joins');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
