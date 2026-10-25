import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import log from '../util/logger.js';
import { buildDocx, readZip, DOCX_MIME } from '../media/docx.js';

const logger = log.scope('drive-links');

/**
 * The Google Drive Links group's archive and its document.
 *
 * The operator, 2026-10-23: "pull everything posted in the past on google drive
 * links and organize it into a docx file for new members, then post in group, do
 * so daily at 0000". Head Admin told the group: "I will have the bot send an
 * organized docx file at 12am NY time daily with all the links previously posted
 * in this chat (whatever it has access to)".
 *
 * The bot kept only message IDs of that group, never their text, so the past
 * comes from the group's own "Export chat" (importExport) and the future from
 * every post the bot sees from now on (DriveLinks.observe). The links are kept in
 * the state file, which the sealed backup carries.
 *
 * Nobody's number goes in the document: it is posted to the group.
 */

export const GROUP_NAME_HINT = '08 Google Drive Links';

const DRIVE_URL = /https?:\/\/(?:drive|docs)\.google\.com\/[^\s<>"')]+/gi;
// Characters WhatsApp wraps around an @-mention.
const ISOLATES = /[⁦-⁩‎‏]/g;

/** What kind of Google link: a folder, a file, or a document. */
export function kindOf(url) {
  if (/drive\.google\.com\/drive\/folders\//i.test(url)) return 'folder';
  if (/drive\.google\.com\/file\/d\//i.test(url)) return 'file';
  if (/docs\.google\.com\/document\//i.test(url)) return 'doc';
  if (/docs\.google\.com\//i.test(url)) return 'doc';
  if (/drive\.google\.com\/open\?(?:[^#]*&)?id=/i.test(url)) return 'file';
  return 'link';
}

/** A link without the parts that differ between two shares of the same thing. */
export function canonicalUrl(url) {
  const u = String(url).replace(/[.,;:!?]+$/, '');
  const folder = /drive\.google\.com\/drive\/folders\/([\w-]+)/i.exec(u);
  if (folder) return `https://drive.google.com/drive/folders/${folder[1]}`;
  const file = /drive\.google\.com\/file\/d\/([\w-]+)/i.exec(u);
  if (file) return `https://drive.google.com/file/d/${file[1]}/view`;
  // "Copy link" in Drive gives open?id=...&usp=drive_copy: the id is the file.
  const open = /drive\.google\.com\/open\?(?:[^#]*&)?id=([\w-]+)/i.exec(u);
  if (open) return `https://drive.google.com/open?id=${open[1]}`;
  const doc = /docs\.google\.com\/(document|spreadsheets|presentation)\/d\/([\w-]+)/i.exec(u);
  if (doc) return `https://docs.google.com/${doc[1]}/d/${doc[2]}/edit`;
  return u;
}

/** Strips the marks WhatsApp's formatting leaves on a label: "> ", backticks, bold stars, italics. */
function cleanLabel(s) {
  return String(s ?? '')
    .replace(ISOLATES, '')
    .replace(/<This message was edited>/gi, '')
    .replace(/^\s*>\s*/, '')
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The Drive links in one message, with what the sender called them.
 *
 *   > The Summer I Turned Pretty        the title (a line starting ">", or a line
 *   `Season 1`                           of its own in backticks before the first link)
 *   https://drive.google.com/...         a line before a link is its label
 *   Seasons 1-6                          a line after the last link is its note
 *
 * Returns [{ title, label, note, url }] (one per link), or [] for a message
 * with none.
 */
export function parseMessage(text) {
  const raw = String(text ?? '').replace(ISOLATES, '');
  if (!raw.match(DRIVE_URL)) return [];
  const lines = raw.split('\n').map((l) => l.trim());
  const items = [];
  let title = null;
  let pending = [];           // text lines waiting for the link they label
  let first = true;
  const urlOf = (l) => { const m = l.match(DRIVE_URL); return m ? m[0].replace(/[.,;:!?]+$/, '') : null; };

  for (const line of lines) {
    if (!line) continue;
    const url = urlOf(line);
    if (url) {
      const before = cleanLabel(line.replace(DRIVE_URL, ''));
      if (before) pending.push(before);
      // A title is the first line, starting ">" or standing alone in backticks,
      // when links follow it; otherwise the lines are this link's label.
      let label = pending.length ? pending.join(' - ') : null;
      items.push({ title, label, note: null, url });
      pending = [];
      first = false;
      continue;
    }
    const looksTitle = /^>\s*\S/.test(line) || (first && /^`[^`]+`$/.test(line));
    if (looksTitle && !items.length && (title == null)) { title = cleanLabel(line); continue; }
    if (/^>\s*\S/.test(line) && !items.length) { pending.push(cleanLabel(line)); continue; }
    pending.push(cleanLabel(line));
  }
  // Text after the last link is a note on it.
  const tail = pending.filter(Boolean).join(' ');
  if (tail && items.length) {
    const last = items[items.length - 1];
    // "Repost bc it's super helpful" came BEFORE its link and was taken as the
    // label of the next link; only a trailing line has nothing to label.
    last.note = tail;
  }
  // A title with a single "Season 2 Episode 8" label reads best as the label of
  // that title; a message whose first line is a label and not a title keeps it.
  return items.map((i) => ({ ...i, title: i.title || null, kind: kindOf(i.url) })).filter((i) => i.kind !== 'link');
}

/* ------------------------------------------------------ the chat export --- */

const HEADER = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4}), (\d{1,2}):(\d{2})(?:\s?([AP]M))? - (.*)$/i;

/**
 * The Drive links in a WhatsApp "Export chat" (.txt), oldest first. Messages
 * run over several lines; a line that does not start with a date belongs to the
 * one before. Entries are { date: 'YYYY-MM-DD', ...parseMessage item }.
 */
export function importExport(text) {
  const msgs = [];
  for (const line of String(text ?? '').replace(/^﻿/, '').split('\n')) {
    const m = HEADER.exec(line.replace(/\r$/, ''));
    if (m) {
      let [, mo, d, y, h, mi, ap, rest] = m;
      y = Number(y) < 100 ? 2000 + Number(y) : Number(y);
      let hour = Number(h);
      if (ap) hour = (hour % 12) + (/p/i.test(ap) ? 12 : 0);
      msgs.push({ date: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`, time: `${String(hour).padStart(2, '0')}:${mi}`, rest });
    } else if (msgs.length) {
      msgs[msgs.length - 1].rest += `\n${line.replace(/\r$/, '')}`;
    }
  }
  const out = [];
  for (const m of msgs) {
    const body = /^[^:\n]{1,60}: ([\s\S]*)$/.exec(m.rest)?.[1];
    if (!body || /This message was deleted|<Media omitted>/.test(body)) continue;
    for (const item of parseMessage(body)) out.push({ date: m.date, time: m.time, ...item });
  }
  return out;
}

/* ------------------------------------------------ a member's link list --- */

const xmlText = (s) => String(s ?? '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');

/**
 * The Drive links in a list a member made in Google Docs, downloaded as .docx
 * ("Movies on the Drive", the operator's, 2026-10-25). It is laid out as
 *
 *   Movies:                       a section: a line of its own ending ":"
 *   • Ted  <link>                 a bulleted line with a link is one entry
 *     ◦ Ted 2  <link>             indented under a line: that line is its title
 *   • NCIS - verse                a line without a link only names those under it
 *     ◦ NCIS Sydney (uploading)   and an indented line without a link is skipped
 *
 * "(mkv)", "(S06)" after a name are its note. Entries are
 * { section, title, label, note, url, kind, date, source: 'list' }, in the
 * list's order; `date` is the day it was read.
 */
export function importDriveDoc(buffer, { date }) {
  const files = readZip(buffer);
  const xml = files['word/document.xml']?.toString('utf8');
  if (!xml) throw new Error('not a Word document (no word/document.xml)');
  const relsXml = files['word/_rels/document.xml.rels']?.toString('utf8') ?? '';
  const rels = {};
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]+)"/.exec(m[0])?.[1];
    const target = /\bTarget="([^"]+)"/.exec(m[0])?.[1];
    if (id && target) rels[id] = xmlText(target);
  }
  const out = [];
  let section = null;
  const parents = [];              // parents[level] = the text of the last line at that level
  for (const p of xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? []) {
    const level = /<w:numPr>[\s\S]*?<w:ilvl w:val="(\d+)"/.exec(p)?.[1];
    let text = '';
    let url = null;
    for (const m of p.matchAll(/<w:hyperlink\b([^>]*)>([\s\S]*?)<\/w:hyperlink>|<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)) {
      if (m[1] != null) {
        const id = /r:id="([^"]+)"/.exec(m[1])?.[1];
        const target = id ? rels[id] : null;
        if (!url && target && target.match(DRIVE_URL)) url = target;
        text += [...m[2].matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((t) => t[1]).join('');
      } else {
        text += m[3];
      }
    }
    text = xmlText(text).replace(/\s+/g, ' ').trim();
    if (!url) { const inText = text.match(DRIVE_URL); if (inText) { url = inText[0]; text = text.replace(DRIVE_URL, '').trim(); } }
    if (!text && !url) continue;
    if (level == null && !url && /:$/.test(text)) { section = text.replace(/:$/, '').trim(); parents.length = 0; continue; }
    const lv = level == null ? 0 : Number(level);
    parents.length = lv;
    parents[lv] = text;
    if (!url) continue;
    // "Just Go With It (mkv", the link, ")": the brackets close round the link.
    let label = text.replace(/\(\s*\)/g, '').replace(/\(\s*([^()]*?)\s*$/, '($1)').replace(/\s+/g, ' ').trim();
    const notes = [];
    label = label.replace(/\s*\(([^()]{1,30})\)\s*$/, (_, n) => { notes.push(n.trim()); return ''; }).trim();
    const title = lv > 0 ? (parents.slice(0, lv).filter(Boolean).pop() ?? null) : null;
    out.push({
      section, title, label: label || null, note: notes.join(', ') || null,
      url: url.replace(/[.,;:!?]+$/, ''), kind: kindOf(url), date, source: 'list',
    });
  }
  return out.filter((e) => e.kind !== 'link');
}

/* --------------------------------------------------------- the archive --- */

const NS = 'drive-links';

export class DriveLinks {
  /**
   * @param store      a state namespace; 'items' is the archive, 'titles' the names fetched from Drive
   * @param getConfig  () => the whole config
   * @param fetchTitle async (url) => the name Google Drive shows, or null
   * @param now        () => ms
   */
  constructor({ store, getConfig, fetchTitle = fetchDriveTitle, now = () => Date.now() }) {
    this.store = store;
    this.getConfig = getConfig;
    this.fetchTitle = fetchTitle;
    this.now = now;
  }

  get cfg() { return { enabled: false, post: false, group: '', ...(this.getConfig()?.driveLinks ?? {}) }; }
  items() { return this.store.get('items', []) ?? []; }

  /** Adds links not already in the archive. Returns how many were new. */
  add(entries) {
    const items = this.items();
    const have = new Set(items.map((i) => canonicalUrl(i.url)));
    let added = 0;
    for (const e of entries) {
      const key = canonicalUrl(e.url);
      if (have.has(key)) {
        // Posted again: the earlier entry keeps its place, and learns a label it lacked.
        const prior = items.find((i) => canonicalUrl(i.url) === key);
        if (prior && !prior.title && e.title) prior.title = e.title;
        if (prior && !prior.label && e.label) prior.label = e.label;
        if (prior && !prior.section && e.section) prior.section = e.section;
        // A member's list is not a post: it adds what it knows and moves nothing.
        if (e.source === 'list') continue;
        // "Episode 11 added" under the same folder is news about it: the
        // newest word on a link is the one kept as its note.
        if (prior && e.note) prior.note = e.note;
        else if (prior && e.label && prior.label && e.label !== prior.label) prior.note = e.label;
        if (prior) prior.reposted = (prior.reposted ?? 0) + 1;
        continue;
      }
      have.add(key);
      items.push({
        url: key, kind: e.kind ?? kindOf(key), title: e.title ?? null, label: e.label ?? null, note: e.note ?? null, date: e.date, time: e.time ?? null,
        ...(e.section ? { section: e.section } : {}), ...(e.source === 'list' ? { source: 'list' } : {}),
      });
      added += 1;
    }
    items.sort((a, b) => `${a.date} ${a.time ?? ''}`.localeCompare(`${b.date} ${b.time ?? ''}`));
    this.store.set('items', items);
    return added;
  }

  /** A message the bot saw in the group: its Drive links are kept. */
  observe(msg) {
    const c = this.cfg;
    if (!c.enabled || !c.group || msg?.chatJid !== c.group || msg.fromMe) return 0;
    const text = msg.text || msg.edit?.text || '';
    if (!text) return 0;
    const found = parseMessage(text);
    if (!found.length) return 0;
    const date = newYorkParts(msg.timestamp || this.now()).date;
    const n = this.add(found.map((f) => ({ ...f, date })));
    if (n) logger.info(`📎 ${n} new Drive link(s) kept from the Google Drive Links group`);
    return n;
  }

  /** The names Drive gives the links that have none, fetched a few at a time and kept. */
  async nameLinks({ max = 12, pauseMs = 1200, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    const titles = this.store.get('titles', {}) ?? {};
    const day = 24 * 3600_000;
    let fetched = 0;
    for (const it of this.items()) {
      if (fetched >= max) break;
      if (it.title || it.label || it.kind === 'doc') continue;
      const known = titles[it.url];
      if (known && (known.name || this.now() - known.at < day)) continue;
      let name = null;
      try { name = await this.fetchTitle(it.url); } catch (err) { logger.debug(`no name for a Drive link: ${err.message}`); }
      titles[it.url] = { name, at: this.now() };
      fetched += 1;
      if (fetched < max) await sleep(pauseMs);
    }
    this.store.set('titles', titles);
    return fetched;
  }

  /** The document, as a Buffer, with how many links it holds. */
  document() {
    const items = this.items();
    const titles = this.store.get('titles', {}) ?? {};
    return { buffer: buildDocx({ title: 'Google Drive Links', blocks: documentBlocks(items, titles, this.now()) }), links: items.length };
  }

  /** The document written to a temp file, ready to send; the caller removes it. */
  writeDocument() {
    const { buffer, links } = this.document();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-links-'));
    const file = path.join(dir, 'Google Drive Links.docx');
    fs.writeFileSync(file, buffer);
    return { file, dir, links };
  }
}

/* ------------------------------------------------------ the document ----- */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const longDate = (iso) => { const [y, m, d] = String(iso).split('-').map(Number); return y ? `${MONTHS[m - 1]} ${d}, ${y}` : String(iso); };

const byName = (a, b) => a.localeCompare(b, 'en', { sensitivity: 'base', numeric: true });

/** Season 1, Season 2, Season 10: in order, then Episode N within them. */
const labelKey = (s) => String(s ?? '').replace(/\d+/g, (n) => n.padStart(4, '0'));

/** "Reacher Season 04 (720p)" is the show "Reacher", "Season 4 (720p)"; any other name is not split. */
export function splitName(name) {
  const m = /^(.*?)[\s._-]+(?:S|Season\s*)0*(\d{1,2})\b[\s._-]*(.*)$/i.exec(String(name ?? '').trim());
  if (!m || m[1].trim().length < 2) return null;
  const rest = m[3].replace(/^[\s._-]+|[\s._-]+$/g, '');
  return { title: m[1].trim(), label: `Season ${Number(m[2])}${rest ? ` ${rest}` : ''}` };
}

const noteText = (n) => String(n ?? '').replace(/^\((.*)\)$/, '$1').trim();

export function documentBlocks(items, titles = {}, now = Date.now()) {
  const blocks = [];
  const updated = longDate(newYorkParts(now).date);
  blocks.push({ h: 1, text: 'Google Drive Links' });
  blocks.push({ p: [{ bold: true, text: 'Everything posted in this group so far, in one place. ' }, `Updated ${updated}.`] });
  blocks.push({ p: 'Movies and shows too big to send on WhatsApp (over 2 GB) are shared here as Google Drive links. Tap a link to open it in Google Drive. Read-only: no chatting and no requests here. To request something, use the request groups.' });

  const titled = new Map();
  const shown = new Map();          // a title in lower case -> the way it is written first
  const loose = [];
  const docs = [];
  const group = (title, it) => {
    const k = title.toLowerCase();
    if (!shown.has(k)) { shown.set(k, title); titled.set(title, []); }
    titled.get(shown.get(k)).push(it);
  };
  // Sections of a member's list ("Movies", "TV Shows"), in the list's order.
  const sections = new Map();
  for (const it of items) {
    if (it.kind === 'doc') { docs.push(it); continue; }
    if (it.section) {
      if (!sections.has(it.section)) sections.set(it.section, []);
      sections.get(it.section).push(it);
      continue;
    }
    if (it.title) { group(it.title, it); continue; }
    // Untitled, but Drive names it "Reacher Season 04": it belongs with its show.
    const split = !it.label && splitName(titles[it.url]?.name);
    if (split) { group(split.title, { ...it, label: split.label }); continue; }
    loose.push(it);
  }
  const nameOf = (r) => r.label || titles[r.url]?.name || (r.kind === 'folder' ? 'Folder' : 'File');
  loose.sort((a, b) => byName(nameOf(a), nameOf(b)) || `${a.date}`.localeCompare(`${b.date}`));

  const posted = (r) => (r.source === 'list' ? [] : [`  · posted ${longDate(r.date)}`]);
  const noted = (r) => (r.note ? [`  (${noteText(r.note)})`] : []);
  // In the list's order: a section is placed where the list has it, even when
  // a link of it was posted in the group before the list was read.
  const firstAt = (rows) => Math.min(...rows.map((r) => (r.source === 'list' ? items.indexOf(r) : items.length + items.indexOf(r))));
  for (const [section, rows] of [...sections].sort((x, y) => firstAt(x[1]) - firstAt(y[1]))) {
    blocks.push({ h: 2, text: section });
    // A name with links under it ("Ted": Ted 1, Ted 2) is a heading; a name with one link is a line.
    const groups = new Map();
    for (const r of rows) {
      const name = r.title || r.label || titles[r.url]?.name || (r.kind === 'folder' ? 'Folder' : 'File');
      const k = name.toLowerCase();
      if (!groups.has(k)) groups.set(k, { name, own: [], under: [] });
      (r.title ? groups.get(k).under : groups.get(k).own).push(r);
    }
    for (const g of [...groups.values()].sort((a, b) => byName(a.name, b.name))) {
      if (!g.under.length) {
        for (const r of g.own) blocks.push({ bullet: [`${g.name} — `, { text: r.url, url: r.url }, ...noted(r), ...posted(r)] });
        continue;
      }
      blocks.push({ h: 3, text: g.name });
      for (const r of g.own) blocks.push({ bullet: [`${r.kind === 'folder' ? 'Folder' : 'File'} — `, { text: r.url, url: r.url }, ...noted(r), ...posted(r)] });
      for (const r of g.under.slice().sort((a, b) => byName(labelKey(a.label), labelKey(b.label)))) {
        blocks.push({ bullet: [`${r.label || (r.kind === 'folder' ? 'Folder' : 'File')} — `, { text: r.url, url: r.url }, ...noted(r), ...posted(r)] });
      }
    }
  }

  if (titled.size) {
    blocks.push({ h: 2, text: sections.size ? 'More shows and movies' : 'Shows and movies' });
    for (const name of [...titled.keys()].sort(byName)) {
      blocks.push({ h: 3, text: name });
      const rows = titled.get(name).slice().sort((a, b) => byName(labelKey(a.label), labelKey(b.label)));
      for (const r of rows) {
        const what = r.label || (r.kind === 'folder' ? 'Folder' : 'File');
        blocks.push({ bullet: [`${what} — `, { text: r.url, url: r.url }, ...(r.note ? [`  (${noteText(r.note)})`] : []), `  · posted ${longDate(r.date)}`] });
      }
    }
  }

  if (loose.length) {
    blocks.push({ h: 2, text: titled.size ? 'Other folders and files' : 'Folders and files' });
    blocks.push({ p: 'Shared without a title. The name is what Google Drive shows for the link, when it could be read. In alphabetical order.' });
    for (const r of loose) {
      blocks.push({ bullet: [`${nameOf(r)} — `, { text: r.url, url: r.url }, ...(r.note ? [`  (${noteText(r.note)})`] : []), `  · posted ${longDate(r.date)}`] });
    }
  }

  if (docs.length) {
    blocks.push({ h: 2, text: 'Link lists made by members' });
    blocks.push({ p: 'Documents full of Google Drive links. Not made by the group and not checked: the group takes no responsibility for what is in them.' });
    for (const r of docs) blocks.push({ bullet: ['Google Doc of links — ', { text: r.url, url: r.url }, `  · first posted ${longDate(r.date)}`] });
  }

  if (!items.length) blocks.push({ p: 'No links have been kept yet.' });
  blocks.push({ p: '' });
  blocks.push({ p: 'Some older posts were pictures or files, which cannot be listed here. If a link has stopped working, tell an admin in the discussions group.' });
  return blocks;
}

/* --------------------------------------------------------- New York time --- */

/** The date and clock in New York at `ms`: { date: 'YYYY-MM-DD', hour, minute }. */
export function newYorkParts(ms) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), minute: Number(parts.minute) };
}

/* ----------------------------------------------------- the name of a link --- */

/** The name Google Drive shows for a public link ("<name> - Google Drive"), or null. */
export async function fetchDriveTitle(url, { timeoutMs = 8000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal, redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; link-title)' } });
    if (!res.ok) return null;
    const html = (await res.text()).slice(0, 200_000);
    const m = /<title>([^<]{1,200})<\/title>/i.exec(html);
    if (!m) return null;
    const name = m[1].replace(/\s*[-–]\s*Google (?:Drive|Docs)\s*$/i, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
    if (!name || /^(Google Drive|Sign in|Meet Google Drive|Error|404)/i.test(name)) return null;
    return name.slice(0, 120);
  } finally {
    clearTimeout(timer);
  }
}

export { DOCX_MIME, NS };
