#!/usr/bin/env node
/**
 * Keeps the Drive links of a WhatsApp "Export chat" (.txt, without media) in the
 * Google Drive Links archive (src/core/drive-links.js).
 *
 *   node tools/import-whatsapp-export.mjs "<WhatsApp Chat with 08 Google Drive Links.txt>" [--dry]
 *   node tools/import-whatsapp-export.mjs "<Movies on the Drive.docx>" [--dry]
 *
 * A .docx is a link list a member made in Google Docs (File > Download >
 * Microsoft Word): its sections ("Movies:", "TV Shows:") become the document's.
 *
 * The bot kept only message ids in that group, never what they said, so the
 * past comes from the group's own export. The links are handed to the running
 * bot through data/bot-cmd.json ("import-drive-links"), which keeps the new ones
 * and ignores a link it already has. Nothing is posted by this.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importExport, importDriveDoc, newYorkParts } from '../src/core/drive-links.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const file = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!file) {
  console.error('usage: node tools/import-whatsapp-export.mjs "<the exported .txt>" [--dry]');
  process.exit(2);
}

const isDocx = /\.docx$/i.test(file);
const entries = isDocx
  ? importDriveDoc(fs.readFileSync(file), { date: newYorkParts(Date.now()).date })
  : importExport(fs.readFileSync(file, 'utf8'));
const titled = entries.filter((e) => e.title).length;
if (isDocx) console.log(`sections: ${[...new Set(entries.map((e) => e.section).filter(Boolean))].join(', ') || 'none'}`);
console.log(`${entries.length} Drive links in the ${isDocx ? 'list' : 'export'}: ${titled} with a title, ${entries.length - titled} without (their names are read from Google Drive).`);
if (process.argv.includes('--dry')) process.exit(0);
if (!entries.length) { console.error('nothing to keep'); process.exit(1); }

fs.writeFileSync(path.join(DATA, 'bot-cmd.json'), JSON.stringify({ op: 'import-drive-links', entries, by: 'tools/import-whatsapp-export.mjs', ...(isDocx ? { source: 'list' } : {}) }, null, 2));
console.log('queued import-drive-links for the running bot (result in data/bot-cmd.result.json)');
