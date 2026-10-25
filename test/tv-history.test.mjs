/* TV requests appear in the History tab, and Settings switches rather than
   scrolls. Run: node test/tv-history.test.mjs */
import fs from 'node:fs';
import plugin from '../src/plugins/tv-requests/index.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

function store() {
  const data = {};
  return { get: (k, d) => data[k] ?? d, set: (k, v) => { data[k] = v; }, _data: data };
}

console.log('=== a TV request writes ONE history row ===');
{
  const st = store();
  const ctx = { store: st, log: { debug() {}, info() {}, warn() {}, error() {} } };
  plugin._history(ctx, { id: 'M1', kind: 'tv', title: 'The Boys', season: 1, episodes: 8, status: 'queued' });
  const h = st.get('history', []);
  ok(h.length === 1, 'one row for the request');
  ok(h[0].kind === 'tv', 'tagged as TV');
  ok(h[0].episodes === 8, 'and records how many episodes — not eight separate rows');
}

console.log('=== the row is UPDATED as the season finishes, not duplicated ===');
{
  const st = store();
  const ctx = { store: st, log: { debug() {} } };
  plugin._history(ctx, { id: 'M1', title: 'The Boys', status: 'queued' });
  plugin._history(ctx, { id: 'M1', title: 'The Boys', status: 'sent', detail: '8 episode(s) posted' });
  const h = st.get('history', []);
  ok(h.length === 1, 'still one row, not two');
  ok(h[0].status === 'sent', 'updated in place');
  ok(h[0].detail === '8 episode(s) posted', 'with the final detail');
}

console.log('=== history is capped and newest-first ===');
{
  const st = store();
  const ctx = { store: st, log: { debug() {} } };
  for (let i = 0; i < 520; i++) plugin._history(ctx, { id: `M${i}`, title: `T${i}` });
  const h = st.get('history', []);
  ok(h.length === 500, `capped at 500 (got ${h.length})`);
  ok(h[0].id === 'M519', 'newest first');
}

console.log('=== a write failure never breaks a request ===');
{
  const bad = { get: () => { throw new Error('disk gone'); }, set: () => {} };
  let threw = null;
  try { plugin._history({ store: bad, log: { debug() {} } }, { id: 'X' }); } catch (e) { threw = e; }
  ok(!threw, 'history problems are swallowed — delivery matters more than the log');
}

console.log('=== the plugin records on accept and on finish ===');
{
  const src = fs.readFileSync(new URL('../src/plugins/tv-requests/index.js', import.meta.url), 'utf8');
  ok(/this\._history\(ctx, baseRow\)/.test(src), 'a row is written when the request is accepted');
  ok(/onFinish: \(\{ completed, failed, cancelled = 0(, skipped = 0)? \}\) => this\._history/.test(src), 'and updated when it finishes');
  ok(/status: \(failed === 0 && cancelled === 0\) \? 'sent'/.test(src),
    "only a clean sweep is recorded as 'sent'");
  // A request an admin set aside whole is 'skipped', not 'cancelled' (tv-request-outcome).
  ok(/completed === 0 \? \(failed \? 'failed' : \(cancelled === skipped \? 'skipped' : 'cancelled'\)\) : 'partial'/.test(src),
    'a partly-delivered season is recorded as partial, not as sent');
  ok(/onFinish\?\.\(\{ completed, failed, cancelled(, skipped)?(, why)? \}\)/.test(src), 'the notifier reports the finish');
  ok(/if \(finished \|\| completed \+ failed \+ cancelled < total\) return;/.test(src),
    'a request concludes only once EVERY episode reported — cancellations included');
}

console.log('=== the API merges movie and TV history ===');
{
  const api = fs.readFileSync(new URL('../src/web/api.js', import.meta.url), 'utf8');
  const block = api.match(/router\.get\('\/history'[\s\S]*?\n  \}\);/)[0];
  ok(/namespace\('movie-requests'\)/.test(block) && /namespace\('tv-requests'\)/.test(block),
    'reads both namespaces');
  ok(/sort\(\(a, b\) => \(b\.at \?\? 0\) - \(a\.at \?\? 0\)\)/.test(block), 'merged newest-first');
  ok(/kind: r\.kind \?\? 'movie'/.test(block), 'older movie rows are labelled so the UI can tell them apart');

  const app = fs.readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
  ok(/x\.kind === 'tv' \? '📺 ' : ''/.test(app), 'TV rows are marked in the list');
  ok(/x\.episodes > 1 \? ` · \$\{x\.episodes\} eps`/.test(app), 'and show the episode count');
}

console.log('=== Settings switches between sections instead of scrolling ===');
{
  const html = fs.readFileSync(new URL('../src/web/public/index.html', import.meta.url), 'utf8');
  const groups = [...html.matchAll(/<div class="settings-group[^"]*" data-group="([\w-]+)" data-label="([^"]+)"/g)];
  ok(groups.length >= 6, `settings is split into ${groups.length} switchable groups`);
  ok(groups.filter((g) => !g[0].includes('hidden')).length === 1, 'exactly one is visible at a time');

  const app = fs.readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
  ok(/function showSettingsGroup/.test(app), 'a switcher exists');
  ok(/groups\.forEach\(\(g\) => g\.classList\.toggle\('hidden', g !== target\)\)/.test(app),
    'choosing one hides the others — so there is nothing to scroll past');
  ok(/localStorage\.setItem\('botpanel\.settingsGroup'/.test(app), 'your last section is remembered');
  ok(/const group = card\?\.closest\?\.\('\.settings-group'\)/.test(app),
    'search reveals a hidden group before scrolling to a hit inside it');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
