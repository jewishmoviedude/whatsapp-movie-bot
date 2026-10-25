/* The operator's own group descriptions are kept in content/manual/ and never
   generated. Run: node test/manual-descriptions-are-kept.test.mjs

   The operator, 2026-10-22: "from now on, i already edited it, only place this
   pasted as backup in repo logic" - for the TV requests group, then the movie
   posts group ("01 movie posts backup") and the movie requests group ("02 movie
   requests"). A rebuild once replaced hand edits made on the groups, so these
   texts must come out of a rebuild unchanged. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const generator = read('tools/build-descriptions.mjs');
const LIMIT = 2048;
const chars = (t) => [...t.replace(/\n+$/, '')].length;

const KEPT = [
  ['movie-requests-only-no-chatting-whatsoever.txt', 'the movie requests group', '*Absolutely no chatting is allowed.*', 'https://chat.whatsapp.com/ExampleInvite07xxxxxxxx'],
  ['movie-posts-only.txt', 'the movie posts group', 'Do not PM anyone ever for any reason', 'https://chat.whatsapp.com/ExampleInvite06xxxxxxxx'],
  ['tv-requests-only-no-chatting-whatsoever.txt', 'the TV requests group', 'Absolutely no chatting is allowed.', 'Bot Will ignore you for 1 hour minutes after you do a request'],
];

for (const [file, what, opens, mustHave] of KEPT) {
  console.log(`=== ${what}: the operator's text, verbatim ===`);
  const text = read(`content/manual/${file}`);
  ok(text.startsWith(opens), `it opens as the operator wrote it`);
  ok(text.includes(mustHave), `it keeps "${mustHave.slice(0, 50)}"`);
  ok(chars(text) <= LIMIT, `it fits WhatsApp's ${LIMIT}-character limit (${chars(text)})`);
  const built = `content/descriptions/${file}`;
  ok(fs.existsSync(path.join(root, built)) && read(built) === text, 'the repo copy the build writes is that text');
  ok(generator.includes(`'${file}'`), 'the build reads it from content/manual/');
}

console.log('=== the generator does not write its own text for these groups ===');
ok(/\[G\.REQUESTS\]: MANUAL\[G\.REQUESTS\]/.test(generator), 'the requests description is the manual text');
ok(/\[G\.POSTS\]: MANUAL\[G\.POSTS\]/.test(generator), 'the posts description is the manual text');
ok(/\[G\.TV_REQ\]: MANUAL\[G\.TV_REQ\]/.test(generator), 'the TV requests description is the manual text');
ok(!/\[G\.(REQUESTS|POSTS|TV_REQ)\]: `/.test(generator), 'no generated text is left for them to fall back to');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
