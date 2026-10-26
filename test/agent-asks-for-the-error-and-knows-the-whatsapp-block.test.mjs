/* A member who cannot download or open a file is asked for the exact error;
   WhatsApp's "unusual format" warning is a known error with a known cure, and
   the agent's tickets reach the hourly check. Run:
   node test/agent-asks-for-the-error-and-knows-the-whatsapp-block.test.mjs

   The operator, 2026-10-25: "if someone asks why he cant download that is a
   standard tech question bot should ask for the error, and if that error that
   wahtsapp blocked the download like we troubleshooted in the past the bot
   will know how to resolve". Ticket #0003 (2026-10-24, "Why can't I download
   any of the movies") was opened with no error asked for. */
import { DiscussionAnswers, buildPrompt } from '../src/core/discussion-answers.js';
import { WHATSAPP_BLOCKED, UNOPENABLE } from '../src/core/known-errors.js';
import { UNOPENABLE as SCAN_UNOPENABLE, agentTicketFindings, scan } from '../src/core/incident-scan.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const WARNING = 'This file was sent in an unusual format that may indicate it is dangerous, corrupted, or otherwise not supported on WhatsApp. For security precautions, this file cannot be opened.';

console.log('=== the warning ===');
ok(WHATSAPP_BLOCKED.test(WARNING), 'WhatsApp\'s warning is known');
ok(!WHATSAPP_BLOCKED.test("Why can't I download any of the movies"), 'a plain "can\'t download" is not the warning');
ok(SCAN_UNOPENABLE === UNOPENABLE, 'the hourly check and the agent share one pattern');

console.log('=== the prompt ===');
{
  const p = buildPrompt({ question: "Why can't I download any of the movies", knowledge: '' });
  ok(/cannot download, open or play a file is asking a tech question/.test(p), 'a download problem is a tech question');
  ok(/ask them two things[^.]*which film or episode, and the exact error they see, copied word for word/.test(p), 'the member is asked which file and the exact error');
  ok(/do not open a ticket for "it does not work" alone/.test(p), 'no ticket for "it does not work" alone');
  ok(p.includes('unusual format') && /re-post/.test(p) && /extra subtitle or sound tracks/.test(p), 'the known WhatsApp block and its cure are in it');
  ok(!p.includes('This message quotes that WhatsApp warning'), 'a plain question is not marked as the warning');
  const q = buildPrompt({ question: WARNING, knowledge: '' });
  ok(q.includes('This message quotes that WhatsApp warning'), 'a quoted warning is marked as the known error');
}

const G = '120363900000000002@g.us';
let t = 1_800_000_000_000;
function mk() {
  const asked = [], sent = [], kv = new Map();
  const dA = new DiscussionAnswers({
    getConfig: () => ({ discussionAnswers: { enabled: true, maxPerHour: 20 } }),
    isDiscussion: (j) => j === G,
    isAddressed: (m) => !!m.toBot,
    agent: async ({ question }) => { asked.push(question); return { ok: true, verdict: { answer: 'Which film, and what error do you see, word for word?' }, tickets: [] }; },
    say: async (jid, text) => { sent.push(text); },
    escalate: async () => {},
    now: () => t,
    store: { get: (k, d) => (kv.has(k) ? kv.get(k) : d), set: (k, v) => kv.set(k, v) },
  });
  let n = 0;
  const msg = (text, extra = {}) => ({ id: `E${++n}`, isGroup: true, fromMe: false, chatJid: G, pushName: 'Zack', senderJid: 'zack@lid', text, timestamp: t, ...extra });
  return { dA, asked, sent, msg };
}

console.log('=== the member\'s answer reaches the agent ===');
{
  const h = mk();
  ok(h.dA.observe(h.msg("Why can't I download any of the movies")), 'the question is taken');
  await h.dA.chain;
  t += 30_000;
  ok(h.dA.observe(h.msg(WARNING)), 'the warning pasted 30 seconds later, not as a reply, is taken (no two-minute gap)');
  await h.dA.chain;
  t += 30_000;
  ok(h.dA.observe(h.msg('it says download failed', { toBot: true })), 'a reply to the bot giving another error is taken too');
  await h.dA.chain;
  t += 30_000;
  ok(!h.dA.observe(h.msg('ok thanks, what time is it?', { toBot: true })), 'a reply with no error still waits out the gap');
  ok(h.asked.length === 3, 'three went to the agent');
}

console.log('=== agent tickets reach the hourly check ===');
{
  const state = { 'agent-tickets': { list: [
    { n: 7, at: 2000, summary: `Member's file Daniel Sloss S01E01 shows: "${WARNING}"`, group: G, who: 'Zack', question: WARNING },
    { n: 3, at: 1000, summary: 'User reports they cannot download any movies.', group: G, who: 'Zack', question: "Why can't I download any of the movies" },
  ] } };
  const f = agentTicketFindings({ state, since: 1500 });
  ok(f.length === 1 && f[0].fp === 'agent-ticket:7', 'a ticket since the last run is a finding; older ones are not');
  ok(f[0].kind === 'member-issue' && f[0].title.startsWith('Ticket #0007'), 'it is researched as an #issue, numbered 0007');
  ok(f[0].unopenable === true && /plan=remux/.test(f[0].remedy) && /repost/.test(f[0].remedy), 'the quoted warning carries the known cure: repack and re-post');
  const plain = agentTicketFindings({ state, since: 0 }).find((x) => x.fp === 'agent-ticket:3');
  ok(plain && !plain.unopenable, 'a ticket with no warning is researched without it');
  ok(agentTicketFindings({ state: {}, since: 0 }).length === 0, 'no tickets, no findings');
  const r = scan({ now: 3000, state, memory: null });
  ok(JSON.stringify(r).includes('agent-ticket:7'), 'scan() includes it');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
