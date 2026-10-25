/* Per-group rule commands. Run: node test/rules-groups.test.mjs */
import { rulesReplyFor, isRulesCommand, normalizeCommand } from '../src/plugins/movie-requests/rules.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const cfg = {
  groupRules: true,
  rulesCommand: '#rules',
  rules: 'MASTER combined rules',
  ruleSets: [
    { command: '#rules-movies', label: 'Movie request groups', text: 'MOVIE rules here' },
    { command: '#rules-tv', label: 'TV groups', text: 'TV rules here' },
    { command: '#rules-empty', label: 'Not written yet', text: '   ' },
  ],
  groupRuleSet: {
    'movies@g.us': '#rules-movies',
    'tv@g.us': '#rules-tv',
  },
};

console.log('=== specific set commands ===');
ok(rulesReplyFor(cfg, { text: '#rules-movies', isGroup: true, chatJid: 'x@g.us' })?.text === 'MOVIE rules here', '#rules-movies -> movie text anywhere');
ok(rulesReplyFor(cfg, { text: '#RULES-TV', isGroup: true, chatJid: 'x@g.us' })?.text === 'TV rules here', 'case-insensitive');
ok(rulesReplyFor(cfg, { text: ' #rules-movies ', isGroup: true, chatJid: 'x@g.us' })?.text === 'MOVIE rules here', 'trims surrounding whitespace');
ok(rulesReplyFor(cfg, { text: '#rules-empty', isGroup: false }) === null, 'a set with blank text is not served');

console.log('=== master #rules routing ===');
ok(rulesReplyFor(cfg, { text: '#rules', isGroup: true, chatJid: 'movies@g.us' })?.text === 'MOVIE rules here', 'bare #rules in movie group -> movie set');
ok(rulesReplyFor(cfg, { text: '#rules', isGroup: true, chatJid: 'tv@g.us' })?.text === 'TV rules here', 'bare #rules in tv group -> tv set');
ok(rulesReplyFor(cfg, { text: '#rules', isGroup: true, chatJid: 'other@g.us' })?.text === 'MASTER combined rules', 'unassigned group -> master text');
// The DM route is deliberately gone: it served text that now lives in
// content/rules/, and it needed a wa.me link carrying a hard-coded phone
// number in fifteen group descriptions.
ok(rulesReplyFor(cfg, { text: '#rules', isGroup: false }) === null, 'a DM gets nothing');
ok(rulesReplyFor(cfg, { text: '#rules-tv', isGroup: false }) === null, 'not even a specific set command');

console.log('=== menu fallback when no master text ===');
{
  const noMaster = { ...cfg, rules: '' };
  // In an UNASSIGNED group now, not a DM - the DM route is gone.
  const r = rulesReplyFor(noMaster, { text: '#rules', isGroup: true, chatJid: 'other@g.us' });
  ok(r && r.text.includes('#rules-movies') && r.text.includes('#rules-tv'), '#rules with no master text -> menu of commands');
  ok(!r.text.includes('#rules-empty'), 'menu omits sets that have no text');
  // an assigned group still resolves its own set even without master text
  ok(rulesReplyFor(noMaster, { text: '#rules', isGroup: true, chatJid: 'tv@g.us' })?.text === 'TV rules here', 'assigned group works without master text');
}

console.log('=== non-commands ===');
ok(rulesReplyFor(cfg, { text: 'the matrix', isGroup: true, chatJid: 'movies@g.us' }) === null, 'a normal request is not a rules command');
ok(rulesReplyFor(cfg, { text: '', isGroup: false }) === null, 'empty text -> null');
ok(rulesReplyFor(cfg, { text: '#rules please', isGroup: false }) === null, 'extra words -> not matched (exact only)');
ok(isRulesCommand(cfg, { text: '#rules-tv', isGroup: true, chatJid: 'x@g.us' }) === true, 'isRulesCommand true for a set');
ok(isRulesCommand(cfg, { text: 'hello', isGroup: false }) === false, 'isRulesCommand false for chatter');

console.log('=== defaults / missing config ===');
ok(rulesReplyFor({}, { text: '#rules', isGroup: false }) === null, 'no rules configured -> null');
ok(rulesReplyFor({ groupRules: true, ruleSets: [{ command: '#r', text: 'x' }] }, { text: '#r', isGroup: true, chatJid: 'x@g.us' })?.text === 'x', 'works with only ruleSets, default master');

console.log('=== trailing punctuation is tolerated ===');
{
  // This began as a fix for the wa.me bracket bug: "(PM the bot: …%23rules)"
  // pre-filled "#rules)" because WhatsApp pulled the ")" into the URL. Those
  // links are gone, but people still type "#rules." and "#rules?" by hand, so
  // the tolerance stays.
  const G = { isGroup: true, chatJid: 'other@g.us' };
  ok(rulesReplyFor(cfg, { ...G, text: '#rules)' })?.text === 'MASTER combined rules', '"#rules)" is recognised');
  ok(rulesReplyFor(cfg, { ...G, text: '#rules-tv)' })?.text === 'TV rules here', '"#rules-tv)" is recognised');
  ok(rulesReplyFor(cfg, { ...G, text: '#rules.' }) !== null, 'a trailing full stop is tolerated');
  ok(rulesReplyFor(cfg, { ...G, text: '#rules?' }) !== null, 'a trailing question mark is tolerated');
  ok(rulesReplyFor(cfg, { ...G, text: '#rules!!' }) !== null, 'repeated punctuation is tolerated');
  ok(normalizeCommand('#rules)') === '#rules', 'normalizeCommand strips the bracket');
  ok(normalizeCommand('  #RULES  ') === '#rules', 'trims and lowercases');
  ok(normalizeCommand(null) === '', 'null is safe');
  // ...but real words are not mangled into commands
  ok(rulesReplyFor(cfg, { text: 'rules)', isGroup: false }) === null, 'a message without the # is still not a command');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
