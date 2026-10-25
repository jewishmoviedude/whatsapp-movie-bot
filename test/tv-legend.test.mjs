/* Every emoji the TV legend explains is one the TV plugin can send, and the other way round.
   Run: node test/tv-legend.test.mjs

   The TV request group's legend is the only place a member can find out what
   a reaction on their request means. Once TV requests showed their place in
   line (and 🤥 for a repeat, and 🚫 for the cooldown), the old legend had no
   line for any of them, and nothing would have caught a legend promising a
   reaction the plugin never sends. The operator wrote a new one (2026-09-29);
   this pins it to what the plugin can actually put on a message: the
   reactions it asks for by name, with their default emoji. It reads
   tools/legends.mjs, not build-descriptions.mjs, which rewrites content/ as
   it loads and needs data/ (test/rules-freshness.test.mjs covers that side).

   It also pins what 🔢 means. positionEmoji() gives 1️⃣…🔟 to places 1 to 10,
   so 🔢 is the 11th place and further back; the legends said "more than 10
   ahead", the 12th on, and the schema comment called the number "places
   ahead", one less than it is. */
import fs from 'node:fs';
import plugin from '../src/plugins/tv-requests/index.js';
import { DEFAULT_CONFIG } from '../src/config/schema.js';
import { positionEmoji } from '../src/media/reaction-class.js';
import { TV_LEGEND, LEGEND } from '../tools/legends.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

// A keycap (1️⃣) is a digit, VS16 and U+20E3; everything else here is one
// pictographic code point, with or without VS16. Compared without VS16,
// since a config value and a legend can differ only in that.
const EMOJI = /[0-9#*]️?⃣|\p{Extended_Pictographic}️?/gu;
const bare = (e) => String(e).replace(/️/g, '');
const emojisIn = (text) => [...new Set((String(text).match(EMOJI) ?? []).map(bare))];

// The reactions the TV plugin asks for by name: `R.<key>` and
// `this._react(ctx).<key>`, and the place numbers through positionEmoji(R, …).
const src = fs.readFileSync(new URL('../src/plugins/tv-requests/index.js', import.meta.url), 'utf8');
const keys = new Set([
  ...[...src.matchAll(/\bR\.([a-zA-Z]+)/g)].map((m) => m[1]),
  ...[...src.matchAll(/this\._react\(ctx\)\.([a-zA-Z]+)/g)].map((m) => m[1]),
]);
const R = plugin._react({ config: DEFAULT_CONFIG });
const sendable = new Map();
for (const k of keys) if (typeof R[k] === 'string') sendable.set(bare(R[k]), k);
ok(/positionEmoji\(R, /.test(src), 'the TV plugin puts place numbers on messages through positionEmoji');
for (const n of (R.positions ?? [])) sendable.set(bare(n), 'positions');
if (R.positionOverflow) sendable.set(bare(R.positionOverflow), 'positionOverflow');

console.log('=== every emoji in the TV legend is one the TV plugin can send ===');
{
  const inLegend = emojisIn(TV_LEGEND);
  ok(inLegend.length >= 20, `the legend explains ${inLegend.length} emoji`);
  for (const e of inLegend) ok(sendable.has(e), `${e} is sent by the TV plugin${sendable.has(e) ? ` (${sendable.get(e)})` : ' - NOT one it can send'}`);
}

console.log('=== and every reaction a TV request can get is in the legend ===');
{
  const inLegend = new Set(emojisIn(TV_LEGEND));
  // ❓ goes on a request that has no show name left once the prefix is taken
  // off ("#request ..."), and 📅 only stands in for 📺 when an install has no
  // needSeason reaction. The operator's legend covers neither, deliberately.
  const unlisted = new Set(['notFound', 'needYear']);
  for (const [e, k] of sendable) {
    if (unlisted.has(k) || k === 'positions') continue;
    ok(inLegend.has(e), `${e} (${k}) is explained`);
  }
  // The legend shows the place numbers as 1️⃣2️⃣3️⃣…🔟: the first three and the last.
  for (const n of [1, 2, 3, 10]) ok(inLegend.has(bare(positionEmoji(R, n))), `place ${n} (${positionEmoji(R, n)}) is shown`);
}

console.log('=== 🔢 is the 11th place and further back ===');
{
  ok(positionEmoji(R, 10) === '🔟' && positionEmoji(R, 11) === '🔢', 'places 1 to 10 have numbers, the 11th is 🔢');
  ok(/🔢 11th or further back/.test(TV_LEGEND) && /🔢 11th or further back/.test(LEGEND), 'and both legends say so');
  ok(!/more than 10 ahead/.test(TV_LEGEND + LEGEND), 'not "more than 10 ahead", which is the 12th on');
  const schema = fs.readFileSync(new URL('../src/config/schema.js', import.meta.url), 'utf8');
  ok(/1-based place in line/.test(schema) && !/reacted with the number of places ahead/.test(schema),
    "the schema calls the number the request's place in line, not the places ahead of it");
}

console.log('=== the TV legend is the operator\'s ===');
{
  ok(TV_LEGEND.startsWith("🔍 Researching · 🎬 Added to the queue · 🤥 Already asked for — it's coming, not added twice"), 'it opens with 🔍 🎬 🤥');
  ok(/a whole season is one place, and films go first, so it can go up/.test(TV_LEGEND), 'a season is one place, and films go first');
  ok(/⬆️ Sending \(repeats for each episode of a season\)/.test(TV_LEGEND), 'the stages repeat per episode');
  ok(TV_LEGEND.trim().endsWith('No reaction at all? Start the message with *#request*.'), 'and it ends on the no-reaction line');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
