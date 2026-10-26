/* The agent answers questions in 05, the direct links group, from that group's
   own description, and never sends the discussions group's on-topic reminder
   there. Run: node test/agent-answers-in-the-links-group.test.mjs

   The operator, 2026-10-25: "why isnt the bot being trained what to respond in
   05". Only the discussions group (libraryNews.groups) reached the agent, so a
   question in 05 that was not #request-movie or #request-tv got nothing. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG } from '../src/config/schema.js';
import { DiscussionAnswers, buildPrompt, groupDescription } from '../src/core/discussion-answers.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const DISCUSSIONS = '120363900000000002@g.us';
const LINKS = '120363900000000011@g.us';
const t = 1_800_000_000_000;

console.log('=== setting ===');
ok(Array.isArray(DEFAULT_CONFIG.discussionAnswers.groups) && DEFAULT_CONFIG.discussionAnswers.groups.length === 0, 'discussionAnswers.groups exists and is empty by default');

console.log('=== 05\'s description is found by the group\'s name ===');
const desc = groupDescription(path.join(ROOT, 'content'), '05 Direct download links for peeps without a filter');
ok(desc.includes('#request-movie') && desc.includes('links only'), 'the numbered name finds content/descriptions/direct-download-links-for-peeps-without-a-filter.txt');
ok(groupDescription(path.join(ROOT, 'content'), 'No such group here') === '', 'an unknown group has no description');
ok(groupDescription(path.join(ROOT, 'content'), null) === '', 'nor does a group with no name');

console.log('=== the prompt for 05 ===');
{
  const p = buildPrompt({ question: 'how do I get a link?', knowledge: 'K', group: { name: '05 Direct download links', description: desc } });
  ok(p.includes('THIS GROUP ("05 Direct download links")') && p.includes('#request-movie'), 'it carries the group\'s description');
  ok(!p.includes('This is the discussions group'), 'and is not told it is the discussions group');
  ok(!p.includes('chatting is allowed'), 'nor that chatting is allowed');
  const d = buildPrompt({ question: 'q?', knowledge: 'K' });
  ok(d.includes('This is the discussions group') && !d.includes('THIS GROUP'), 'the discussions group\'s prompt is unchanged');
}

function mk({ groups = [LINKS], topic = async () => ({ ok: true, onTopic: false }) } = {}) {
  const sent = [], kv = new Map();
  const asked = [];
  const dA = new DiscussionAnswers({
    getConfig: () => ({ discussionAnswers: { enabled: true, maxPerHour: 20, keepOnTopic: true, groups } }),
    isDiscussion: (jid) => jid === DISCUSSIONS || groups.includes(jid),
    isChatGroup: (jid) => jid === DISCUSSIONS,
    topic: async (x) => { asked.push(x); return topic(x); },
    agent: async () => ({ ok: true, verdict: { answer: 'Type #request-movie and the name and year.' }, tickets: [] }),
    say: async (jid, text) => { sent.push({ jid, text }); },
    escalate: async () => {},
    now: () => t,
    store: { get: (k, d) => (kv.has(k) ? kv.get(k) : d), set: (k, v) => kv.set(k, v) },
  });
  let n = 0;
  const msg = (text, chatJid) => ({ id: `M${++n}`, isGroup: true, fromMe: false, chatJid, pushName: 'Ari', senderJid: `u${n}@lid`, text, timestamp: t });
  return { dA, sent, asked, msg };
}

console.log('=== a question in 05 ===');
{
  const h = mk();
  ok(h.dA.observe(h.msg('how do I get a movie link here?', LINKS)), 'is taken');
  await h.dA.chain;
  ok(h.sent.length === 1 && h.sent[0].jid === LINKS && h.sent[0].text.includes('#request-movie'), 'and answered in 05');
}
{
  const h = mk({ groups: [] });
  ok(!h.dA.observe(h.msg('how do I get a movie link here?', LINKS)), 'not taken when 05 is not in discussionAnswers.groups');
}

console.log('=== no on-topic reminder in 05 ===');
{
  const h = mk();
  h.dA.observe(h.msg('the weather today is really nice and sunny outside here', LINKS));
  await h.dA.chain;
  ok(h.asked.length === 0 && h.sent.length === 0, 'an off-topic remark in 05 is not checked or reminded');
  h.dA.observe(h.msg('the weather today is really nice and sunny outside here', DISCUSSIONS));
  await h.dA.chain;
  ok(h.asked.length === 1 && h.sent.length === 1, 'the same remark in the discussions group still is');
}

console.log('=== wiring ===');
{
  const src = fs.readFileSync(path.join(ROOT, 'src/index.js'), 'utf8');
  ok(/isDiscussion:[^\n]*\n[^\n]*discussionAnswers\?\.groups/.test(src), 'index.js lets discussionAnswers.groups reach the agent');
  ok(/isChatGroup: \(jid\) => newsSettings/.test(src), 'only the discussions group is a chat group');
  ok(src.includes('groupDescription(') && /runAgent\(\{\s*question, knowledge, admin, group,/.test(src), 'the agent is given the group\'s description');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
