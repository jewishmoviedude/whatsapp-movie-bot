/* Portal search: index coverage + ranking, run against the real markup.
   Run: node test/portal-search.test.mjs */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(here, '..', 'src', 'web', 'public');
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(pub, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(pub, 'style.css'), 'utf8');

console.log('=== the search UI is actually wired up ===');
ok(/id="gsearch"/.test(html), 'search input exists in the markup');
ok(/id="gsearch-results"/.test(html), 'results dropdown exists');
ok(/id="jumpnav"/.test(html), 'jump-nav container exists');
ok(/#gsearch\s*\{/.test(css), 'search input is styled');
ok(/\.card\.collapsed/.test(css), 'collapsed-card rule exists');
ok(/\.jumpnav/.test(css), 'jump-nav is styled');

console.log('=== keyboard affordances ===');
ok(/key === '\/'/.test(appJs), '"/" focuses search');
ok(/metaKey \|\| e\.ctrlKey|ctrlKey \|\| e\.metaKey/.test(appJs), 'Ctrl/Cmd-K focuses search');
ok(/ArrowDown/.test(appJs) && /ArrowUp/.test(appJs), 'arrow keys move the selection');
ok(/key === 'Enter'/.test(appJs), 'Enter opens the highlighted hit');
ok(/key === 'Escape'/.test(appJs), 'Escape closes the dropdown');

console.log('=== ranking helper ===');
{
  // Re-implement the scorer's contract from source to verify ordering rules.
  const norm = appJs.match(/function normalizeSearch\([^)]*\) \{[\s\S]*?\n\}/);
  const m = appJs.match(/function scoreHit\([^)]*\) \{[\s\S]*?\n\}/);
  ok(!!m, 'scoreHit found in app.js');
  const scoreHit = new Function(`${norm ? norm[0] : ''}\n${m[0]}; return scoreHit;`)();
  ok(scoreHit('Library', 'library') === 100, 'exact match ranks highest');
  ok(scoreHit('Library path', 'lib') === 80, 'prefix beats a mid-string match');
  ok(scoreHit('Movie data (OMDb)', 'omdb') === 60, 'substring match still found');
  ok(scoreHit('Delete chat after rules', 'delete rules') === 40, 'all words in any order match');
  ok(scoreHit('Groups', 'zzz') === 0, 'no match scores zero');
  ok(scoreHit('Library', 'LIBRARY') === 100, 'case-insensitive');
  ok(scoreHit('Library path', 'lib') > scoreHit('Movie library', 'lib'), 'prefix outranks substring');
  ok(scoreHit('Dry-run a request', 'dry run') > 0, 'hyphen ignored: "dry run" finds "Dry-run"');
  ok(scoreHit('Request-group enforcement 🧹', 'request group') > 0, 'hyphen + emoji ignored');
  ok(scoreHit('Movie data (OMDb)', 'movie data omdb') > 0, 'brackets ignored');
  ok(scoreHit('Group lockdown 🔒', 'lockdown') > 0, 'trailing emoji does not block a match');
}

console.log('=== every settings card is reachable by search ===');
{
  // The index is built from .card h2 / label / button[id]; confirm the markup
  // still provides those hooks in each panel that has settings.
  const panels = [...html.matchAll(/<section class="panel"[^>]*id="tab-([\w-]+)"[^>]*>([\s\S]*?)<\/section>/g)];
  const settings = panels.find((p) => p[1] === 'settings');
  ok(!!settings, 'settings panel found');
  const cards = settings[2].match(/<div class="card"/g) || [];
  const h2s = settings[2].match(/<h2[^>]*>/g) || [];
  ok(cards.length >= 10, `settings has ${cards.length} cards (the tab worth indexing)`);
  ok(h2s.length >= cards.length, 'every card carries an h2 for the index and collapse toggle');

  const labels = settings[2].match(/<label/g) || [];
  ok(labels.length >= 40, `${labels.length} labelled fields become searchable`);
}

console.log('=== collapse state persists ===');
ok(/localStorage/.test(appJs) && /botpanel\.collapsed/.test(appJs), 'collapsed cards are remembered in localStorage');
ok(/try \{ localStorage\.setItem/.test(appJs), 'localStorage write is guarded (private mode safe)');
ok(/catch \{ return new Set\(\); \}/.test(appJs), 'unreadable storage degrades to nothing collapsed');

console.log('=== search reaches live data, not just static markup ===');
ok(/for \(const g of \(GROUPS \|\| \[\]\)\)/.test(appJs), 'groups are searchable');
ok(/for \(const m of \(ROSTER \|\| \[\]\)\)/.test(appJs), 'members are searchable');
ok(/gaOpen\(hit\.jid/.test(appJs), 'selecting a group opens it');
ok(/openMember\(hit\.mkey\)/.test(appJs), 'selecting a member opens their page');

console.log('=== index is derived, never hand-maintained ===');
ok(/document\.querySelectorAll\('\.panel'\)/.test(appJs), 'index built from the live DOM');
ok(!/const SEARCH_ITEMS = \[/.test(appJs), 'no hardcoded list that could drift out of sync');

console.log('=== REAL DOM: the index actually finds things in the live markup ===');
{
  const { parseHTML } = await import('linkedom');
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);

  // Run the real buildSearchIndex + scoreHit against the real page.
  const src = appJs.match(/const TAB_LABEL[\s\S]*?\nfunction runSearch/)[0]
    .replace(/\nfunction runSearch$/, '');
  const make = new Function('document', `${src}; return { buildSearchIndex, scoreHit };`);
  const { buildSearchIndex, scoreHit } = make(document);

  const idx = buildSearchIndex();
  ok(idx.length > 100, `indexed ${idx.length} things from the real page`);

  const find = (q) => idx
    .map((e) => ({ e, s: Math.max(scoreHit(e.what, q), e.sub ? scoreHit(e.sub, q) * 0.5 : 0) }))
    .filter((x) => x.s > 0).sort((a, b) => b.s - a.s)[0]?.e;

  // Things the user would plausibly search for, and the tab each must land on.
  const cases = [
    ['library', 'settings'],
    ['omdb', 'settings'],
    ['password', null],
    // Lockdown lives with Groups (it is a group control) and enforcement with
    // Settings (it is a rules setting); Members keeps the people-shaped things.
    ['lockdown', 'groups'],
    ['banned', 'members'],
    ['enforcement', 'settings'],
    ['audit', 'logs'],
    ['plugins', 'settings'],
    ['email', 'settings'],
  ];
  let bad = 0;
  for (const [q, wantTab] of cases) {
    const hit = find(q);
    if (!hit) { console.log(`       "${q}" -> NOTHING FOUND`); bad++; continue; }
    if (wantTab && hit.tab !== wantTab) { console.log(`       "${q}" -> ${hit.what} (tab ${hit.tab}, expected ${wantTab})`); bad++; }
  }
  ok(bad === 0, `all ${cases.length} realistic searches land on the right tab`);

  // Every card heading must be findable by its own name - that is the core promise.
  const headings = [...document.querySelectorAll('.panel .card h2')]
    .map((h) => h.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const unreachable = headings.filter((h) => {
    // Type it the way a person would: punctuation and emoji become spaces.
    const hit = find(h.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim());
    return !hit;
  });
  ok(unreachable.length === 0, `all ${headings.length} section headings are reachable by search${unreachable.length ? ` — missing: ${unreachable.join(', ')}` : ''}`);

  // Collapse ids must be unique, or toggling one card would toggle another.
  const ids = [...document.querySelectorAll('.panel .card')].map((c) => {
    const panel = c.closest('.panel'); const h2 = c.querySelector('h2');
    return `${panel ? panel.id : '?'}::${h2 ? h2.textContent.replace(/\s+/g, ' ').trim() : '?'}`;
  });
  ok(new Set(ids).size === ids.length, `all ${ids.length} card ids are unique (collapse state cannot collide)`);
}

console.log('=== CSS soundness (a typo\'d var renders as transparent) ===');
{
  const defined = new Set([...css.matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((m) => m[1]));
  const used = new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]));
  const undef = [...used].filter((v) => !defined.has(v));
  ok(undef.length === 0, `every CSS variable is defined${undef.length ? ` — undefined: ${undef.join(', ')}` : ''}`);

  // The dropdown floats over page content, so it must be opaque and on top.
  const block = css.match(/\.search-results \{[\s\S]*?\}/)[0];
  ok(/background:\s*var\(--card\)/.test(block), 'dropdown has a solid themed background');
  ok(/z-index:\s*[2-9]\d\d/.test(block), 'dropdown stacks above the page');

  // Highlight must be visible in BOTH themes - white-on-white was invisible.
  const hov = css.match(/\.sr-item:hover[^{]*\{[^}]*\}/)[0];
  ok(!/rgba\(255,\s*255,\s*255/.test(hov), 'selection highlight is not hardcoded white (invisible in light mode)');

  // Light mode exists, so nothing may assume a dark background.
  ok(/prefers-color-scheme: light/.test(css), 'light theme is defined');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
