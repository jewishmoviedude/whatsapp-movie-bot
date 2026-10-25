/* The top of the dashboard is always the connection, what is running, and
   the queue; notices come after them.
   Run: node test/dashboard-order.test.mjs

   The operator, 2026-10-09: "make the nudity chek on fall back provider
   notice somewhere middle of dash not on top, top of dash should always be
   connection status, running and queue". The nudity-check cards and the
   requests-paused banner sat above all three, so a notice that could stay up
   for hours pushed what the operator opens the panel to see down the page.
   Read from the markup, no DOM needed: the cards are in source order, and
   nothing in app.js moves them. */
import fs from 'node:fs';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const html = fs.readFileSync(new URL('../src/web/public/index.html', import.meta.url), 'utf8');
const dash = html.slice(html.indexOf('id="tab-dashboard"'), html.indexOf('</section>', html.indexOf('id="tab-dashboard"')));

// Each card on the dashboard, in order, by id or (the queue has none) title.
const cards = [...dash.matchAll(/<div class="card[^"]*"(?: id="([^"]+)")?>\s*<h2>([^<]*)/g)]
  .map((m) => m[1] ?? m[2].trim());
console.log(`  (the dashboard, in order: ${cards.join(' · ')})`);

ok(cards[0] === 'card-conn', 'first: the WhatsApp connection');
ok(cards[1] === 'card-activity', 'second: what is running now');
ok(cards[2] === 'Queue', 'third: the queue');
for (const id of ['card-cc-fallback', 'card-cc-health', 'card-req-paused']) {
  const at = cards.indexOf(id);
  ok(at > 2, `${id} comes after them (at ${at})`);
}
ok(cards.indexOf('card-cc-fallback') < cards.indexOf('card-dash-log'), 'the nudity-check notice still in the middle, before the activity log');

const app = fs.readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
ok(!/(prepend|insertBefore)\([^)]*card-(cc-|req-paused)/.test(app), 'and no script moves a notice back to the top');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
