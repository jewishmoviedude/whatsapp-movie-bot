/* An operator on the box can write a note on a Wanted entry.
   Run: node test/wanted-note-command.test.mjs

   The operator, 2026-10-11, of films asked for from the Jellyfin host: "make
   a note on those items in the panel". The panel's note box needs a
   signed-in admin, and the state file must never be edited under the running
   bot (a hand edit is overwritten, or overwrites the bot's), so the bot-cmd
   channel writes the note through the bot itself - same store, same limits,
   audited. */
import { runAdminCommand, summariseAdminCommand } from '../src/core/admin-commands.js';
import { recordWanted } from '../src/core/wanted.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const spaces = new Map();
const stateStore = {
  namespace(n) {
    if (!spaces.has(n)) spaces.set(n, {});
    const d = spaces.get(n);
    return { get: (k, v = null) => (k in d ? d[k] : v), set: (k, v) => { d[k] = v; return v; }, push: (k, v) => { (d[k] ??= []).push(v); } };
  },
};
const movies = stateStore.namespace('movie-requests');
recordWanted(movies, { title: 'Stars Fell on Alabama', year: 2021, imdbId: 'tt10712928' }, { requester: 'Mia' });
const deps = { bot: {}, dataDir: '/nonexistent', configStore: { get: () => ({}) }, stateStore };

console.log('=== a note is written on the entry ===');
{
  const cmd = { op: 'wanted-note', key: 'tt10712928', text: 'Requested to be added to Jellyfin, 2026-10-11.', by: 'Claude Code (for the operator)' };
  const r = await runAdminCommand(cmd, deps);
  ok(r.ok && r.title === 'Stars Fell on Alabama' && r.note?.text === cmd.text, 'answered with the film and the note');
  const w = movies.get('wanted').find((x) => x.key === 'tt10712928');
  ok(w.notes?.length === 1 && w.notes[0].by === 'Claude Code (for the operator)' && !w.notes[0].auto,
    'stored on the entry as an admin note (not the bot\'s own), so the hourly check reads it');
  const s = summariseAdminCommand(cmd, r);
  ok(/added a note to Stars Fell on Alabama \(2021\) on the wanted list/.test(s?.action ?? '') && /Requested to be added/.test(s?.detail ?? ''),
    `audited: ${s?.action}`);
}

console.log('=== a fact the bot knows is its own note, not an admin\'s ===');
{
  const r = await runAdminCommand({ op: 'wanted-note', key: 'tt10712928', text: 'On the server now.', by: 'the bot', auto: true }, deps);
  ok(r.ok && r.note?.auto === true, 'auto: true is stored as the bot\'s own note, which starts no hourly research');
}

console.log('=== refused the way the panel refuses ===');
{
  const rej = async (cmd) => { try { await runAdminCommand(cmd, deps); return null; } catch (e) { return e.message; } };
  ok(/not on the wanted list/.test(await rej({ op: 'wanted-note', key: 'tt0000001', text: 'x' }) ?? ''), 'an unknown film');
  ok(/needs some text/.test(await rej({ op: 'wanted-note', key: 'tt10712928', text: '   ' }) ?? ''), 'an empty note');
  ok(/key required/.test(await rej({ op: 'wanted-note', text: 'x' }) ?? ''), 'no key');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
