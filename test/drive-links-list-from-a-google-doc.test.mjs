/* A member's own list of Drive links, made in Google Docs and downloaded as
   .docx, goes into the Google Drive Links document with its sections.
   Run: node test/drive-links-list-from-a-google-doc.test.mjs

   The operator, 2026-10-25, of "Movies on the Drive": "I made this a little bit
   ago, the bot can take the info if it needs". */
import { createZip, readZip } from '../src/media/docx.js';
import { DriveLinks, importDriveDoc, canonicalUrl, kindOf, documentBlocks } from '../src/core/drive-links.js';
import { runAdminCommand } from '../src/core/admin-commands.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const store = () => { const m = new Map(); return { get: (k, d = null) => (m.has(k) ? m.get(k) : d), set: (k, v) => m.set(k, v) }; };

/* A document laid out as Google Docs writes it: bullets are numPr/ilvl, a link a hyperlink with r:id. */
const links = [];
const t = (s) => `<w:r><w:t xml:space="preserve">${s}</w:t></w:r>`;
const a = (url, s) => { links.push(url); return `<w:hyperlink r:id="kix${links.length}">${t(s)}</w:hyperlink>`; };
const li = (lv, body) => `<w:p><w:pPr><w:numPr><w:ilvl w:val="${lv}"/><w:numId w:val="5"/></w:numPr></w:pPr>${body}</w:p>`;
const plain = (s) => `<w:p>${s ? t(s) : ''}</w:p>`;
const F = (id) => `https://drive.google.com/drive/folders/${id}?usp=drive_link`;
const O = (id) => `https://drive.google.com/open?id=${id}&amp;usp=drive_copy`;
const body = [
  plain('Comedy Specials:'), plain(''),
  li(0, t('Matt Rife')),
  li(1, a(O('MR1'), 'Natural Selection (2023).mp4')),
  plain('Movies:'),
  li(0, a(F('TED'), 'Ted')),
  li(1, a(O('TED2'), 'Ted 2')),
  li(1, a(O('TED1'), 'Ted 1') + t(' ')),
  li(0, t('Just Go With It (') + a(O('JGWI'), 'mkv') + t(')')),
  li(0, a(O('THB'), 'Thunderbolts (cam version)')),
  li(0, t('Guns &amp; Moses ') + a(O('GM'), 'link')),
  plain('TV Shows:'),
  li(0, t('NCIS - verse')),
  li(1, t('NCIS Sydney (uploading)')),
  li(1, a(F('TZ'), 'Tony &amp; Ziva')),
  li(0, a(F('SWAT'), 'S.W.A.T.') + t(' (S06)')),
  li(0, a('https://example.com/x', 'Not a Drive link')),
].join('');
const docXml = `<?xml version="1.0"?><w:document xmlns:w="w" xmlns:r="r"><w:body>${body}</w:body></w:document>`;
const rels = `<?xml version="1.0"?><Relationships>${links.map((u, i) => `<Relationship Id="kix${i + 1}" Type="hyperlink" Target="${u}" TargetMode="External"/>`).join('')}</Relationships>`;
const docx = createZip([{ name: 'word/document.xml', data: docXml }, { name: 'word/_rels/document.xml.rels', data: rels }]);

console.log('=== the zip is read back ===');
{
  const files = readZip(docx);
  ok(files['word/document.xml'].toString('utf8') === docXml, 'a deflated entry comes back as written');
  let threw = false; try { readZip(Buffer.from('not a zip at all, not even close')); } catch { threw = true; }
  ok(threw, 'something that is not a zip is refused');
}

console.log('=== the list is read: sections, names, the lines under a name ===');
const entries = importDriveDoc(docx, { date: '2026-10-25' });
const by = (id) => entries.find((e) => e.url.includes(id));
{
  ok(entries.length === 9, `every Drive link, and nothing else (${entries.length})`);
  ok(by('MR1')?.section === 'Comedy Specials' && by('MR1')?.title === 'Matt Rife' && by('MR1')?.label === 'Natural Selection (2023).mp4', 'a link under a name has that name as its title');
  ok(by('TED')?.title === null && by('TED')?.label === 'Ted' && by('TED')?.kind === 'folder', 'a name that is a link is an entry of its own');
  ok(by('TED2')?.title === 'Ted' && by('TED1')?.label === 'Ted 1', 'and the links under it are its');
  ok(by('JGWI')?.label === 'Just Go With It' && by('JGWI')?.note === 'mkv', '"Just Go With It (mkv" + link + ")" is the film, noted mkv');
  ok(by('THB')?.label === 'Thunderbolts' && by('THB')?.note === 'cam version', '"(cam version)" is a note');
  ok(by('GM')?.label === 'Guns & Moses link', `the text is unescaped: "${by('GM')?.label}"`);
  ok(by('SWAT')?.note === 'S06' && by('SWAT')?.section === 'TV Shows', 'a note after the link is kept');
  ok(by('TZ')?.title === 'NCIS - verse', 'a line without a link (uploading) is skipped and names nothing');
  ok(by('GM')?.url === 'https://drive.google.com/open?id=GM&usp=drive_copy' && kindOf(by('GM').url) === 'file', 'an open?id link is a file');
  ok(canonicalUrl(by('GM').url) === 'https://drive.google.com/open?id=GM', 'and the same file shared twice is one link');
  ok(entries.every((e) => e.source === 'list' && e.date === '2026-10-25'), 'each is marked as from a list');
}

console.log('=== into the archive, beside what was posted in the group ===');
{
  const d = new DriveLinks({ store: store(), getConfig: () => ({}), now: () => Date.parse('2026-10-25T12:00:00Z') });
  d.add([{ url: 'https://drive.google.com/drive/folders/SWAT', kind: 'folder', title: null, label: 'SWAT season 6', note: 'Episode 11 added', date: '2026-09-01' }]);
  const added = d.add(entries);
  ok(added === 8, `the new ones are added, the one posted before is not (${added})`);
  const swat = d.items().find((i) => i.url.endsWith('/SWAT'));
  ok(swat.section === 'TV Shows' && swat.note === 'Episode 11 added' && swat.label === 'SWAT season 6' && !swat.reposted,
    'a link already posted learns its section and keeps what the group said of it');
  const text = JSON.stringify(documentBlocks(d.items(), {}, Date.parse('2026-10-25T12:00:00Z')));
  if (process.env.SHOW) console.log(text);
  const at = (s) => text.indexOf(s);
  ok(at('"h":2,"text":"Comedy Specials"') > 0 && at('"h":2,"text":"Movies"') > at('"h":2,"text":"Comedy Specials"') && at('"h":2,"text":"TV Shows"') > at('"h":2,"text":"Movies"'),
    'the list\'s sections are the document\'s, in its order');
  ok(at('"h":3,"text":"Ted"') > 0 && at('Ted 1 — ') > at('"h":3,"text":"Ted"') && at('Ted 2 — ') > at('Ted 1 — '), 'Ted is a heading over Ted 1 and Ted 2');
  ok(/Folder — ","text":"https:\/\/drive\.google\.com\/drive\/folders\/TED"/.test(text.replace(/\{/g, '')), 'with its own folder first');
  ok(/Thunderbolts — .{0,200}cam version/.test(text), 'a note is shown');
  ok(!/posted October 25, 2026/.test(text) && /posted September 1, 2026/.test(text), 'a list entry says no "posted" date; a group post does');
}

console.log('=== the admin command keeps the sections ===');
{
  const d = new DriveLinks({ store: store(), getConfig: () => ({}) });
  const res = await runAdminCommand({ op: 'import-drive-links', entries, source: 'list', by: 'test' }, { bot: { driveLinks: d } });
  ok(res.added === 9 && d.items().every((i) => i.section && i.source === 'list'), 'section and source are passed through');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
