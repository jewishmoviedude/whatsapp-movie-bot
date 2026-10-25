/* The "Beta testing 🧪" card, and the API behind it.
   Run: node test/beta-panel.test.mjs

   The card is how the operator picks the test group ("Testing things"), the
   beta posts group and each feature's mode, so the things that must hold are
   the ones that keep a test out of the 783-member main groups: a group the
   main service already uses cannot be picked, the server refuses that overlap
   even if a stale page sends it, "On" is confirmed before it reaches everyone,
   and a History row from a test cannot be re-run into the real posts group.

   Review found the card could mislead in three ways, pinned below: a failed
   GET /beta was painted over by the next group-list redraw with "No features
   are in testing right now" and every main group tickable; the Groups tab
   marked "🧪 beta" on a group that runs as main; and the card kept offering a
   group the Movies/TV/direct-links cards had just made main, until a reload.

   The card code is taken from the real app.js and run against the real
   index.html markup in linkedom. The server side of the card - GET /api/beta,
   the refusal in PUT /api/config, the bulk re-run - is in beta.test.mjs, so it
   still runs on a production install where linkedom is absent. */
import fs from 'node:fs';
import { parseHTML } from 'linkedom';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const app = fs.readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../src/web/public/index.html', import.meta.url), 'utf8');

const TESTING = '120363900000000013@g.us';
const BETA_POSTS = '120363900000000014@g.us';
const MAIN_REQ = 'movie-requests@g.us';
const MAIN_POSTS = 'movie-posts@g.us';

const GROUPS = [
  { jid: TESTING, subject: 'Testing things', size: 30 },
  { jid: BETA_POSTS, subject: '#test movie posts', size: 29 },
  { jid: MAIN_REQ, subject: 'MOVIE REQUESTS ONLY!', size: 800 },
  { jid: MAIN_POSTS, subject: 'MOVIE POSTS ONLY', size: 783 },
];
const MAIN_ROLES = { [MAIN_REQ]: 'movie request group', [MAIN_POSTS]: 'movie posts group' };
const FAKE_REGISTRY = [
  { key: 'smart-replies', label: 'Smarter replies', description: 'Explains a refusal in words.', scope: 'movie', mode: 'off' },
  { key: 'season-picker', label: 'Season picker', description: 'Offers the seasons as a list.', scope: 'tv', mode: 'off' },
];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const start = app.indexOf('/* ------------------------- beta testing');
const end = app.indexOf('/* ----------------------- end beta testing');
const block = app.slice(start, end);
// The card labels a saved group the list lacks, and names a group it empties,
// with the helpers every group picker on Settings shares. Taken from app.js too.
const fn = (name) => { const at = app.indexOf(`function ${name}(`); return app.slice(at, app.indexOf('\n}\n', at) + 2); };
const shared = `const GROUP_NAMES = new Map();\n${fn('missingGroupLabel')}\n${fn('clearGroupsQuery')}`;

/** Run the real card code against the real markup. */
function card({ features = [], beta = { groups: [], postsGroup: '', features: {} }, groups = GROUPS,
  conflicts = [], confirmAnswer = true, putError = null, getError = null, mainGroups = MAIN_ROLES } = {}) {
  const win = parseHTML(html);
  const { document } = win;
  const $ = (id) => document.getElementById(id);
  const calls = [];
  const confirms = [];
  let saved = { beta };
  const api = async (method, url, body) => {
    calls.push({ method, url, body });
    if (method === 'GET' && url === '/beta') {
      if (getError) throw new Error(getError);
      return { features, modes: ['off', 'beta', 'on'], beta: saved.beta, mainGroups, conflicts };
    }
    if (method === 'PUT' && url === '/config') {
      if (putError) throw new Error(putError);
      saved = { beta: { ...saved.beta, ...body.beta } };
      return saved;
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  const groupsList = { draws: 0 };
  // eslint-disable-next-line no-new-func
  const ui = new Function('$', 'esc', 'api', 'document', 'confirm', 'renderGroupsList', 'state', `
    let CONFIG = state.CONFIG;
    let GROUPS = state.GROUPS;
    ${shared}
    ${block}
    return { loadBetaSection, renderBetaCard, readBetaForm, betaPill, config: () => CONFIG };
  `)($, esc, api, document, (m) => { confirms.push(m); return confirmAnswer; }, () => { groupsList.draws += 1; },
    { CONFIG: { beta }, GROUPS: groups });
  const click = async (id) => {
    $(id).dispatchEvent(new win.Event('click'));
    await new Promise((r) => setTimeout(r, 10));
  };
  const tick = (jid, on = true) => {
    const box = [...document.querySelectorAll('#beta-groups input.beta-g')].find((i) => i.value === jid);
    if (on) box.setAttribute('checked', ''); else box.removeAttribute('checked');
  };
  const choose = (sel, value) => {
    for (const o of sel.options) { if (o.value === value) o.setAttribute('selected', ''); else o.removeAttribute('selected'); }
  };
  return { document, $, ui, calls, confirms, click, tick, choose, groupsList };
}

console.log('=== the markup ===');
{
  const groupAt = (slug) => html.indexOf(`data-group="${slug}"`);
  ok(groupAt('beta') > 0, 'the card has its own settings section');
  ok(groupAt('tv') < groupAt('beta') && groupAt('beta') < groupAt('moderation'),
    'placed after TV and before Moderation');
  ok(/<h2>Beta testing 🧪<\/h2>/.test(html), 'titled "Beta testing 🧪"');
  ok(/<b>On<\/b> means every group/.test(html), 'the card says in plain words that On means every group');
  ok(start > 0 && end > start, 'the card code is one self-contained block in app.js');
  ok(/renderDlGroups\(\);\n\s+renderBetaCard\(\);/.test(app), 'it is redrawn when the group list arrives over SSE');
  ok(/loadTvSection\(\);\n\s+loadBetaSection\(\);/.test(app), 'and loaded with the rest of the settings');
}

console.log('=== an empty registry ===');
{
  const c = card();
  await c.ui.loadBetaSection();
  ok(/No features are in testing right now/.test(c.$('beta-features').textContent),
    'says "No features are in testing right now" instead of an empty table');
  ok(c.document.querySelectorAll('#beta-features select').length === 0, 'with no mode controls');
  ok(/beta testing is off/.test(c.$('beta-warn').textContent), 'and says beta testing is off while no group is picked');
  ok(c.calls[0]?.url === '/beta', 'the registry comes from the server, not a copy in the page');
}

console.log('=== the group pickers ===');
{
  const c = card({ beta: { groups: [TESTING], postsGroup: BETA_POSTS, features: {} } });
  await c.ui.loadBetaSection();
  const boxes = [...c.document.querySelectorAll('#beta-groups input.beta-g')];
  ok(boxes.length === 4, 'every group is listed by name');
  ok(/Testing things/.test(c.$('beta-groups').textContent) && !/120363900000000013/.test(c.$('beta-groups').textContent),
    'names are shown, not JIDs');
  const box = (jid) => boxes.find((b) => b.value === jid);
  ok(box(TESTING).hasAttribute('checked'), 'the saved beta group is ticked');
  ok(box(MAIN_POSTS).hasAttribute('disabled') && box(MAIN_REQ).hasAttribute('disabled'),
    'a group the main service uses cannot be ticked');
  ok(/movie posts group/.test(c.$('beta-groups').textContent), 'and it says what that group is used for');
  const opts = [...c.$('beta-posts').options];
  ok(opts[0].value === '' && /back into the beta group/.test(opts[0].textContent),
    'the beta posts group defaults to "back into the beta group it was asked in"');
  ok(opts.find((o) => o.value === BETA_POSTS)?.hasAttribute('selected'), 'the saved beta posts group is selected');
  ok(opts.find((o) => o.value === MAIN_POSTS)?.hasAttribute('disabled'), 'a main posts group cannot be chosen as the beta one');
}
{
  // Saving while the group list is unavailable must not wipe the beta group.
  const c = card({ beta: { groups: [TESTING], postsGroup: BETA_POSTS, features: {} }, groups: [] });
  await c.ui.loadBetaSection();
  ok(c.ui.readBetaForm().groups.join() === TESTING, 'a saved group missing from the fetched list is kept, still ticked');
  ok(c.$('beta-groups').textContent.includes(TESTING),
    'and shows its JID - with only "(not in the fetched list)", two such rows could not be told apart');
  ok([...c.$('beta-posts').options].some((o) => o.value === BETA_POSTS && o.hasAttribute('selected')),
    'and so is a saved posts group');
}

console.log('=== a registry with features in it ===');
{
  const c = card({ features: FAKE_REGISTRY, beta: { groups: [TESTING], postsGroup: '', features: { 'season-picker': 'beta' } } });
  await c.ui.loadBetaSection();
  const selects = [...c.document.querySelectorAll('#beta-features select.beta-mode')];
  ok(selects.length === 2, 'one Off / Beta / On control per feature');
  ok([...selects[0].options].map((o) => o.value).join() === 'off,beta,on', 'offering exactly the three modes');
  ok(/On — every group/.test(selects[0].textContent), '"On" is labelled as every group in the control itself');
  ok(selects[1].value === 'beta', 'the saved mode is selected');
  ok(/Offers the seasons as a list\./.test(c.$('beta-features').textContent), 'each feature shows its description');
  ok(/TV/.test(c.$('beta-features').textContent), 'and what it applies to');
}

console.log('=== saving writes the beta section through PUT /config ===');
{
  const c = card({ features: FAKE_REGISTRY });
  await c.ui.loadBetaSection();
  c.tick(TESTING);
  c.choose(c.$('beta-posts'), BETA_POSTS);
  c.choose(c.document.querySelector('select.beta-mode[data-key="smart-replies"]'), 'beta');
  await c.click('beta-save');
  const put = c.calls.find((x) => x.method === 'PUT');
  ok(put?.url === '/config', 'it uses the ordinary config save');
  ok(Object.keys(put.body).join() === 'beta', 'and sends only the beta section, so no other setting is touched');
  ok(put.body.beta.groups.join() === TESTING, 'with the ticked group, by JID');
  ok(put.body.beta.postsGroup === BETA_POSTS, 'the chosen posts group, by JID');
  ok(put.body.beta.features['smart-replies'] === 'beta' && put.body.beta.features['season-picker'] === 'off',
    'and every feature\'s mode');
  ok(c.confirms.length === 0, 'Beta needs no confirmation');
  ok(/saved/.test(c.$('beta-note').textContent), 'it says it saved');
  ok(c.ui.config().beta.groups.join() === TESTING, 'and the page now holds what the server stored');
  ok(c.calls.filter((x) => x.url === '/beta').length === 2, 'the card is reloaded from the server afterwards');
}

console.log('=== "On" reaches every group, so it is confirmed ===');
{
  const c = card({ features: FAKE_REGISTRY, confirmAnswer: false, beta: { groups: [TESTING], postsGroup: '', features: {} } });
  await c.ui.loadBetaSection();
  c.choose(c.document.querySelector('select.beta-mode[data-key="smart-replies"]'), 'on');
  await c.click('beta-save');
  ok(c.confirms.length === 1 && /EVERY group/.test(c.confirms[0]), `it asks first: "${c.confirms[0]}"`);
  ok(!c.calls.some((x) => x.method === 'PUT'), 'and saying no saves nothing');
}
{
  const c = card({ features: FAKE_REGISTRY, beta: { groups: [TESTING], postsGroup: '', features: { 'smart-replies': 'on' } } });
  await c.ui.loadBetaSection();
  await c.click('beta-save');
  ok(c.confirms.length === 0, 'a feature that is already On does not ask again on every save');
}

console.log('=== a refused save says why ===');
{
  const c = card({ putError: '"MOVIE POSTS ONLY" is already the movie posts group, so it cannot also be the beta posts group' });
  await c.ui.loadBetaSection();
  await c.click('beta-save');
  ok(/already the movie posts group/.test(c.$('beta-note').textContent), 'the server\'s reason is shown on the card');
}

console.log('=== an unsaved choice survives a group-list refresh ===');
{
  const c = card();
  await c.ui.loadBetaSection();
  c.tick(TESTING);
  c.ui.renderBetaCard();                    // what the SSE "groups" event triggers
  ok(c.ui.readBetaForm().groups.join() === TESTING, 'the tick is still there after the redraw');
}

console.log('=== conflicts are shown ===');
{
  const c = card({ beta: { groups: [MAIN_REQ], postsGroup: '', features: {} },
    conflicts: [{ jid: MAIN_REQ, as: 'beta group', role: 'movie request group' }] });
  await c.ui.loadBetaSection();
  ok(/MOVIE REQUESTS ONLY!.*also the movie request group/.test(c.$('beta-warn').textContent),
    'a group that is both is named, with what it is');
  const box = [...c.document.querySelectorAll('#beta-groups input.beta-g')].find((b) => b.value === MAIN_REQ);
  ok(box.hasAttribute('checked') && !box.hasAttribute('disabled'), 'and it stays tickable, so it can be taken off the list');
}

console.log('=== a failed GET /beta is not painted over ===');
{
  const c = card({ features: FAKE_REGISTRY, getError: 'Server error' });
  await c.ui.loadBetaSection();
  ok(/Could not load the beta settings: Server error/.test(c.$('beta-features').textContent), 'the error is shown');
  c.ui.renderBetaCard();                    // the next SSE "groups" event
  ok(/Server error/.test(c.$('beta-features').textContent) && !/No features are in testing/.test(c.$('beta-features').textContent),
    'and a group-list redraw keeps it, rather than claiming there are no features');
  ok(c.$('beta-save').disabled === true, 'the card cannot be saved while it does not know which groups are main');
  await c.click('beta-save');
  ok(!c.calls.some((x) => x.method === 'PUT'), 'and clicking Save sends nothing');
}
{
  const c = card();
  c.ui.renderBetaCard();                    // SSE lands before GET /beta has answered
  ok(/Loading/.test(c.$('beta-features').textContent) && !/No features/.test(c.$('beta-features').textContent),
    'before GET /beta answers the card says it is loading, not that nothing is in testing');
  ok(c.$('beta-save').disabled === true, 'and cannot be saved yet');
  await c.ui.loadBetaSection();
  ok(c.$('beta-save').disabled === false, 'once loaded it can');
}

console.log('=== the Groups tab marks only groups that really run as beta ===');
{
  const c = card({ beta: { groups: [TESTING, MAIN_REQ], postsGroup: BETA_POSTS, features: {} } });
  ok(c.ui.betaPill(TESTING) === '', 'before GET /beta answers nothing is marked - the page cannot yet tell');
  await c.ui.loadBetaSection();
  ok(/🧪 beta</.test(c.ui.betaPill(TESTING)), 'a beta group is marked 🧪 beta');
  ok(/🧪 beta posts/.test(c.ui.betaPill(BETA_POSTS)), 'so is the beta posts group');
  const clash = c.ui.betaPill(MAIN_REQ);
  ok(/ignored/.test(clash) && /movie request group/.test(clash) && /warn/.test(clash),
    `a ticked group the main service uses is marked as running as main: ${clash.trim()}`);
  ok(c.ui.betaPill(MAIN_POSTS) === '', 'an ordinary group is not marked');
  ok(c.groupsList.draws === 1, 'and the Groups tab is redrawn when the beta data arrives');
}

console.log('=== a Movies / TV / direct-links save refreshes which groups are main ===');
{
  // One line may sit between: the settings save also puts the API keys
  // section's pills back in step. What matters is that the beta list is
  // refreshed by the same save, not that the two calls are adjacent.
  ok(/fillForm\(CONFIG\);\n(?:\s+\S[^\n]*\n)?\s+loadBetaSection\(\{ fresh: false \}\);/.test(app), 'after the Settings save');
  ok(/loadTvSection\(\);\n\s+loadBetaSection\(\{ fresh: false \}\);/.test(app), 'after the TV save');
  ok(/loadDirectLinks\(\);\n\s+loadBetaSection\(\{ fresh: false \}\);/.test(app), 'after the direct-links save');
  const main = { ...MAIN_ROLES };
  const c = card({ mainGroups: main });
  await c.ui.loadBetaSection();
  c.tick(TESTING);
  main[BETA_POSTS] = 'TV posts group';      // the TV card just made it a posts group
  await c.ui.loadBetaSection({ fresh: false });
  const box = [...c.document.querySelectorAll('#beta-groups input.beta-g')].find((b) => b.value === BETA_POSTS);
  ok(box.hasAttribute('disabled'), 'the group it just made main can no longer be ticked as beta');
  ok(c.ui.readBetaForm().groups.join() === TESTING, 'and an unsaved tick survives the refresh');
}

console.log('=== the bulk re-run counts beta rows on their own ===');
ok(/r\.betaSkipped \? ` · <span class="muted">\$\{r\.betaSkipped\} beta test\(s\) left for the beta group/.test(app),
  'History says how many beta tests were left, instead of "skipped 1 (blocked / not found / not in library)"');

console.log('=== History: a beta row is marked, and cannot be re-run into the main group ===');
{
  const fn = app.match(/function historyRow\(x\) \{[\s\S]*?\n\}/)[0];
  // eslint-disable-next-line no-new-func
  // The requester's number (phoneOut, historyNumber) is test/phone-format.test.mjs's to check,
  // and the notes on what was sent (historyNotes) test/same-title-far-year-not-sent.test.mjs's.
  const historyRow = new Function('esc', 'historyTimeline', 'phoneOut', 'historyNumber', 'historyNotes',
    `${fn}; return historyRow;`)(esc, () => '', (v) => v, () => null, () => '');
  const betaRow = historyRow({ title: 'Inception', request: 'inception', status: 'sent', beta: true });
  const mainRow = historyRow({ title: 'Inception', request: 'inception', status: 'sent' });
  ok(/🧪 beta/.test(betaRow), 'a beta row carries a 🧪 beta tag');
  ok(!/Re-run/.test(betaRow), 'and no Re-run button - panel work goes to the MAIN posts group');
  ok(/Re-run/.test(mainRow) && !/🧪/.test(mainRow), 'a normal row is unchanged');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
