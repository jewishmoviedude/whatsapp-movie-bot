/**
 * Build the per-group rule sets + new group descriptions.
 *
 * Writes a plan file only - nothing is sent to WhatsApp from here. Review the
 * printed preview, then apply with:
 *   node tools/build-descriptions.mjs --apply
 * which drops the plan into data/bot-cmd.json for the running bot to execute.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FORM_MISSING, LEGEND, TV_LEGEND } from './legends.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const orig = JSON.parse(fs.readFileSync(path.join(DATA, 'backups', 'original-descriptions.json'), 'utf8'));

/* ---------------------------------------------------------------- links -- */
const FORM_GROUPS  = 'https://forms.gle/ExampleForm02';   // overall groups feedback
const FORM_BOT     = 'https://forms.gle/ExampleForm03';   // feedback on the bot

// Every code below was read back from the live groups (admin op `dump-invites`)
// on 2026-08-20. WhatsApp keeps ONE live invite code per group, so a code that
// does not appear in that dump has been rotated and is a dead link. Two were:
// CphFauyKmkwJuuzfegbZ0i (used in FIVE descriptions as "Request group") and
// K4qeFQuorVnDjQ3AkdVZUU. Re-run `dump-invites` and re-check these after any
// group has its invite reset, otherwise a pinned description sends members to
// a link that does nothing.
const LINK_POSTS1   = 'https://chat.whatsapp.com/ExampleInvite07xxxxxxxx';  // MOVIE POSTS ONLY
const LINK_REQUESTS = 'https://chat.whatsapp.com/ExampleInvite06xxxxxxxx';  // MOVIE REQUESTS ONLY
const LINK_QUEUE    = 'https://chat.whatsapp.com/ExampleInvite05xxxxxxxx';  // queue notifications
const LINK_TVREQ    = 'https://chat.whatsapp.com/ExampleInvite09xxxxxxxx';  // TV REQUESTS ONLY
const LINK_TVPOSTS  = 'https://chat.whatsapp.com/ExampleInvite04xxxxxxxx';  // TV POSTS ONLY
const LINK_TESTREQ  = 'https://chat.whatsapp.com/ExampleInvite10xxxxxxxx';  // Testing things
// #test movie posts - deliberately NOT linked from the testing request group.
// The movie plugin resolves exactly one posts group (cfg.postsGroup), so a
// request made in the testing group is delivered to MOVIE POSTS ONLY like any
// other. Linking testers here would send them somewhere their file never lands.
const LINK_TESTPOSTS= 'https://chat.whatsapp.com/ExampleInvite11xxxxxxxx';
const LINK_VLC      = 'https://apps.apple.com/us/app/vlc-media-player/id650377962';
const BLACKLIST     = 'https://docs.google.com/spreadsheets/d/EXAMPLE_SHEET_ID/edit?usp=sharing';
// The "PM the bot for the rules" link is deliberately gone. It hard-coded a
// phone number into fifteen group descriptions, so every number switch made
// all fifteen wrong at once, and it existed to deliver text that now lives in
// content/rules/ where it can be read and versioned. Rules are still available
// in-group with the per-group command.

// What the reactions mean - the movie legend and the TV one - is in
// ./legends.mjs, where a test can read it without running this file.

/* ----------------------------------------------------------- rule sets -- */
export const RULE_SETS = [
  {
    command: '#rules-requests',
    label: 'Movie request groups',
    text: `*📋 MOVIE REQUEST RULES*

*This is a requests-only group. Absolutely no chatting.*

*HOW TO REQUEST*
• ONE message: *#request* then the movie's correct official name and year.
• *Text only* — no pictures, screenshots, voice notes or links.
• No tagging, no replying, no "thank you", no yes/no — *only actual requests.*
• *One movie at a time.* More than one gets your request deleted.
• *We will not do the research for you.*

*REPOSTING*
• You may repost a request *only once every 24 hours.*
• If someone already requested it, *do not request it again* — you'll be removed.
• *No reposting over the weekend (Friday–Sunday).*
• Do not tag or reply to a previous request — it will be deleted.

*NOT ALLOWED*
• *No rated-R movies* (or NC-17 / X / TV-MA).
• *No movies that are only in theaters* — this results in removal. A 🎪 means theaters-only; ask again once it's out digitally.

*POSTING*
• Movies are posted *only in the Posts group.*
• Have a movie to post and aren't a Posts admin? *PM an admin.*

*GOOD TO KNOW*
• Most admins don't post at night or on weekends.
• Nobody is getting paid. A proper request doesn't obligate anyone to send it — if it's filled, great; if not, try again tomorrow.

*ENFORCEMENT*
• *Two strikes and you're removed.* Wrong formats get you removed or banned.

*WHAT THE REACTIONS MEAN*
${LEGEND}`,
  },
  {
    command: '#rules-cam',
    label: 'Recently released (cam) requests',
    text: `*📋 RECENTLY RELEASED — RULES*

*This group is for cam versions of movies only.*

• If you want a proper digital file, *wait until it's released digitally* and request it in the main movie requests group.
• Request format is the same: ONE message, *#request* then the correct name and year. Text only.
• *One movie at a time.* No chatting, no tagging, no replying.
• *No rated-R movies* (or NC-17 / X / TV-MA).
• You may repost *only once every 24 hours*, and not over the weekend.
• *Two strikes and you're removed.*

*WHAT THE REACTIONS MEAN*
${LEGEND}`,
  },
  {
    command: '#rules-posts',
    label: 'Posts groups',
    text: `*📋 POSTS GROUP RULES*

*This group is for posting movie files only. No chatting.*

• *Do not PM an admin with a request.* Join the request group and request there.
• If you have something to post and you're not an admin here, *PM an admin's Head Admin* to be made an admin.
• *IF YOU'RE ON MOVIE POSTS #2, DO NOT JOIN #1.*

*HOW TO SEND A MOVIE FILE* (under 2GB only)
1. Download the file to your phone
2. Open this chat
3. Tap the 📎 paperclip
4. Choose *Document*
5. Find the movie in your file manager and send

*TO WATCH ON IPHONE* — VLC:
${LINK_VLC}`,
  },
  {
    command: '#rules-tv',
    label: 'TV posts groups',
    text: `*📋 TV POSTS RULES*

*This group is for posting TV episodes only. No chatting.*

• *No PMing admins with requests.* Use the TV request chat:
${LINK_TVREQ}
• Post episodes as a *Document* (paperclip → Document), under 2GB.
• Name episodes clearly, e.g. *The Boys S01E01 Pilot*.
• No chatting, no tagging, no replying.

*TO WATCH ON IPHONE* — VLC:
${LINK_VLC}`,
  },
  {
    command: '#rules-tvreq',
    label: 'TV request group',
    text: `*📋 TV REQUEST RULES*

*This is a requests-only group. Absolutely no chatting.*

• Start every request with *#request*, then the show, season and episode:
*#request The Boys S01E01* — one episode
*#request The Boys season 1* — the whole season, sent one episode at a time
• Text only — no pictures, voice notes or links. ONE show per message.
• No tagging, no replying, no "thank you" — *only actual requests.*
• *No rated-R / TV-MA shows.*
• You may repost *only once every 24 hours*, and not over the weekend.
• Episodes are posted *only in the TV Posts group.*
• *Two strikes and you're removed.*

*WHAT THE REACTIONS MEAN*
${TV_LEGEND}`,
  },
  {
    command: '#rules-chat',
    label: 'Discussion group',
    text: `*📋 DISCUSSION GROUP RULES*

• Discuss anything movie related — *try to stay on topic.*
• *No group calls.* You call, you get removed. This is the last warning.
• No requests here — use the request group.
• Be decent to each other.

*TO WATCH ON IPHONE* — VLC:
${LINK_VLC}`,
  },
  {
    command: '#rules-admins',
    label: 'Admin groups',
    text: `*📋 ADMIN RULES*

*The admins in this group are executive admins of the Movie group system and are the only ones authorized to make executive decisions.*

• If you leave this group, you are no longer an admin on the Movie Posts groups.
• If someone needs to be removed, *post it here.*
• *Letting in new members isn't your job* — leave that to the executives.
• *No one* may add a member as admin unless they are an admin in this group.
• Failure to comply and your admin privileges are stripped indefinitely.

*Blacklist:*
${BLACKLIST}`,
  },
];


/* ------------------------------------------------------- master rules -- */
/**
 * What a bare `#rules` serves in a DM. Deliberately NOT one giant dump of
 * every section: the shared rules, then an index pointing at the specific
 * command for each kind of group, so nobody has to read TV posting rules to
 * find out how to request a movie.
 *
 * Generated from the same constants as the group descriptions, so the two can
 * never drift apart again.
 */
const PREFIX = '#request';

export function buildMasterRules(sets = RULE_SETS) {
  const index = sets
    .filter((s) => (s.command || '').trim() && (s.text || '').trim())
    .map((s) => `• *${s.command}* — ${s.label}`)
    .join('\n');

  return `*📋 MOVIE & TV GROUP RULES*

*THE BASICS — everywhere*
• Request only in the request groups. *No chatting there.*
• *One title per message*, text only — no pictures, voice notes or links.
• No tagging, no replying, no "thank you" — only actual requests.
• *No rated-R / TV-MA* material anywhere.
• Repost at most *once every 24 hours*, and not over the weekend.
• Nobody is getting paid. A correct request doesn't oblige anyone to fill it.
• *Two strikes and you're removed.*

*HOW TO REQUEST A MOVIE*
${PREFIX} The Truman Show 1998

*HOW TO REQUEST TV*
${PREFIX} The Boys S01E01 — one episode
${PREFIX} The Boys season 1 — the whole season, sent one episode at a time

*RULES FOR YOUR GROUP* — send any of these:
${index}

*WHAT THE REACTIONS MEAN*
${LEGEND}
📺 Which season? — for TV, say the season (not a year)

*💬 Feedback on the groups:* ${FORM_GROUPS}
*🤖 Feedback on the bot:* ${FORM_BOT}
*📬 Movie not on the server?* ${FORM_MISSING}`;
}

/* -------------------------------------------------- per-group mapping --- */
const G = {
  TEST_POSTS:   '120363900000000014@g.us',
  TEST_REQ:     '120363900000000013@g.us',
  ADMINS_POST:  '120363900000000005@g.us',
  GDRIVE:       '120363900000000004@g.us',
  DISCUSSIONS:  '120363900000000002@g.us',
  HEAD_ADMINS:   '120363900000000012@g.us',
  POSTS:        '120363900000000006@g.us',
  REQUESTS:     '120363900000000001@g.us',
  SYSTEM_A:     '120363900000000010@g.us',
  SYSTEM_B:     '120363900000000009@g.us',
  DIRECT_LINKS: '120363900000000011@g.us',   // links-only group (direct-links plugin)
  RECENT:       '120363900000000007@g.us',
  QUEUE_NOTIF:  '120363900000000015@g.us',
  TV_POSTS:     '120363900000000008@g.us',
  TV_REQ:       '120363900000000003@g.us',
};

// The operator's own texts (2026-10-22), kept verbatim in content/manual/ and
// never generated: they were edited by hand on the groups, and a rebuild must
// not replace them with the generated versions
// (test/manual-descriptions-are-kept.test.mjs).
const MANUAL_FILE = {
  [G.REQUESTS]: 'movie-requests-only-no-chatting-whatsoever.txt',
  [G.POSTS]: 'movie-posts-only.txt',
  [G.TV_REQ]: 'tv-requests-only-no-chatting-whatsoever.txt',
};
const MANUAL = Object.fromEntries(Object.entries(MANUAL_FILE).map(([jid, name]) =>
  [jid, fs.readFileSync(path.join(ROOT, 'content', 'manual', name), 'utf8').replace(/\n+$/, '')]));

export const GROUP_RULE_SET = {
  [G.REQUESTS]:    '#rules-requests',
  [G.TEST_REQ]:    '#rules-requests',
  [G.RECENT]:      '#rules-cam',
  [G.POSTS]:       '#rules-posts',
  [G.TEST_POSTS]:  '#rules-posts',
  [G.TV_POSTS]:    '#rules-tv',
  [G.TV_REQ]:      '#rules-tvreq',
  [G.DISCUSSIONS]: '#rules-chat',
  [G.ADMINS_POST]: '#rules-admins',
  [G.HEAD_ADMINS]:  '#rules-admins',
};

// A wa.me link must never be wrapped in brackets: WhatsApp's link detection
// swallows the closing ")" into the URL, so the pre-filled message arrives as
// "#rules)" and the command does not match. Links always end the line.
// The group rules command is off (movieRequests.groupRules, 2026-10-22), so
// the descriptions no longer point at it: only the feedback link is left.
const RULES_ON = false;
const footer = (cmd) => RULES_ON
  ? `\n\n*📋 Full rules:* send *${cmd}* in this group.\n*💬 Feedback on the groups:* ${FORM_GROUPS}`
  : `\n\n*💬 Feedback on the groups:* ${FORM_GROUPS}`;

/* ------------------------------------------------- new descriptions ----- */

export const DESCRIPTIONS = {
  [G.REQUESTS]: MANUAL[G.REQUESTS],

  [G.TEST_REQ]: `*#test movie requests*

Testing group — same rules as the main request group.
Request in ONE message: *#request* + the correct movie name and year. Text only, one at a time.

*To receive the actual files:*
${LINK_POSTS1}

*Live queue updates:*
${LINK_QUEUE}

${LEGEND}

*🤖 Feedback on the bot:* ${FORM_BOT}${footer('#rules-requests')}`,

  [G.RECENT]: `*RECENTLY RELEASED MOVIES — REQUESTS*

*This group is for cam versions of movies only.*
If you want a digital file, wait until it's released digitally and request it in the main movie requests group.

Request in ONE message: *#request* + the correct movie name and year. Text only, one at a time. No chatting.

*Movies are posted in the Posts group:*
${LINK_POSTS1}

*🤖 Feedback on the bot:* ${FORM_BOT}${footer('#rules-cam')}`,

  [G.POSTS]: MANUAL[G.POSTS],

  [G.TEST_POSTS]: `*#test movie posts*

Testing group for movie file posts. No chatting.

To post: 📎 paperclip → *Document* → pick the movie (under 2GB).

*Test request group:*
${LINK_TESTREQ}

*VLC for iPhone:*
${LINK_VLC}${footer('#rules-posts')}`,

  [G.TV_POSTS]: `*TV POSTS ONLY — NO CHATTING WHATSOEVER*

*No PMing admins with requests.*

*TV request chat:*
${LINK_TVREQ}

To post: 📎 paperclip → *Document* → pick the episode (under 2GB).
Name episodes clearly, e.g. *The Boys S01E01 Pilot*.

*VLC for iPhone:*
${LINK_VLC}${footer('#rules-tv')}`,

  // The operator's own text (2026-10-22), kept verbatim in content/manual/ and
  // never generated: it was edited by hand on the group, and a rebuild must not
  // replace it with the generated version (test/tv-requests-description-is-manual.test.mjs).
  [G.TV_REQ]: MANUAL[G.TV_REQ],

  [G.DISCUSSIONS]: `*MOVIE DISCUSSIONS*

Discuss anything movie related — try to stay on topic.

*No group calls.* You call, you get removed. Last warning.

No requests here — request in the request group:
${LINK_REQUESTS}

*VLC for iPhone:*
${LINK_VLC}${footer('#rules-chat')}`,

  [G.ADMINS_POST]: `*ADMINS FOR POSTING*

*The admins in this group are executive admins of the Movie group system and are the only ones authorized to make executive decisions.*

If you leave this group, you will no longer be an admin on the Movie Posts groups.

If someone needs to be removed, post it here. Simple, easy, and makes fewer issues in the future.

Letting in new members isn't your job. Leave that to the executives.

No one, and we mean no one, is permitted to add members as admin if you aren't an admin in this group.

Failure to comply, and we'll strip your admin privileges indefinitely.

*Blacklist:*
${BLACKLIST}${footer('#rules-admins')}`,

  [G.HEAD_ADMINS]: `*HEAD ADMIN'S*

*Super-admin group.* Executive decisions for the Movie group system are made here.

• Ban requests are posted here with a *reason*, and take effect once approved.
• Keep it to admin business.

*Blacklist:*
${BLACKLIST}${footer('#rules-admins')}`,

  [G.QUEUE_NOTIF]: `*REQUEST QUEUE NOTIFICATIONS*

Live play-by-play of the bot working through the queue — *both movies and TV*. *Read-only — no chatting.*

You'll see each request move through: queued → downloading → converting → sending → done.
A whole TV season is ONE request here, not one line per episode.

*Movie request group:*
${LINK_REQUESTS}

*Movies are posted here:*
${LINK_POSTS1}

*TV request group:*
${LINK_TVREQ}

*Episodes are posted here:*
${LINK_TVPOSTS}

*🤖 Feedback on the bot:* ${FORM_BOT}`,

  [G.SYSTEM_A]: `*MOVIE SYSTEM*

Announcements and coordination for the Movie group system.

*💬 Feedback on the groups:* ${FORM_GROUPS}
*🤖 Feedback on the bot:* ${FORM_BOT}
*📬 Movie not on the server?* ${FORM_MISSING}`,

  [G.SYSTEM_B]: `*MOVIE SYSTEM*

Announcements and coordination for the Movie group system.

*💬 Feedback on the groups:* ${FORM_GROUPS}
*🤖 Feedback on the bot:* ${FORM_BOT}
*📬 Movie not on the server?* ${FORM_MISSING}`,

  [G.DIRECT_LINKS]: `*DO NOT STAY IN THIS GROUP IF YOU HAVE A STRICT FILTER ON YOUR DEVICE*

This group sends *links only* — no file is ever sent.

Movies:
Type *#request-movie name year*

TV shows:
Type *#request-tv name S01*
A whole season comes back as one message with every episode link.

Ratings are not blocked here — restricted titles just come back with a warning.

*Join Movie Posts #1:*
${LINK_POSTS1}

*Request group:*
${LINK_REQUESTS}`,

  [G.GDRIVE]: `*GOOGLE DRIVE LINKS*

Google Drive links for movies too big to send on WhatsApp (over 2GB).

*Read-only — no chatting.*

*Request group:*
${LINK_REQUESTS}`,
};

/* --------------------------------------------------------------- main --- */
const LIMIT = 2048;                     // WhatsApp group description limit
const plan = Object.entries(DESCRIPTIONS).map(([jid, desc]) => ({ jid, desc }));

let over = 0;
console.log('='.repeat(78));
for (const { jid, desc } of plan) {
  const o = orig[jid];
  const cmd = GROUP_RULE_SET[jid];
  const len = [...desc].length;
  if (len > LIMIT) over++;
  console.log(`\n### ${o?.subject ?? jid}`);
  console.log(`    command: ${cmd ?? '(none — no rules command in this group)'}`);
  console.log(`    length : ${len}/${LIMIT}${len > LIMIT ? '  ⚠️ OVER LIMIT' : ''}`);
  console.log(`    was    : ${o?.desc ? `${[...o.desc].length} chars` : '(EMPTY)'}`);
  console.log('    ---- new ----');
  console.log(desc.split('\n').map((l) => `    │ ${l}`).join('\n'));
}
console.log('\n' + '='.repeat(78));
console.log(`${plan.length} groups planned, ${over} over the ${LIMIT}-char limit`);
const missing = Object.keys(orig).filter((j) => !DESCRIPTIONS[j]);
if (missing.length) console.log(`NOT covered: ${missing.map((j) => orig[j].subject).join(', ')}`);

const planFile = path.join(DATA, 'descriptions-plan.json');
fs.writeFileSync(planFile, JSON.stringify({ plan, ruleSets: RULE_SETS, groupRuleSet: GROUP_RULE_SET }, null, 2));
console.log(`\nplan written -> ${planFile}`);

/* ------------------------------------------------- the repo copy ------- */
// Everything that gets posted to a group, kept in the repo where it can be
// read, diffed and reviewed before it goes out. data/ is gitignored (it holds
// the session and the encrypted config), so this lives in content/.
const contentDir = path.join(ROOT, 'content');
const descDir = path.join(contentDir, 'descriptions');
const rulesDir = path.join(contentDir, 'rules');
fs.mkdirSync(descDir, { recursive: true });
fs.mkdirSync(rulesDir, { recursive: true });

const slug = (t) => String(t || 'group').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'group';

// One file per group description. Two groups share the name "MOVIE SYSTEM",
// so a plain slug silently overwrote one with the other - 15 groups produced
// 14 files. Collisions get the jid's tail appended.
const usedNames = new Map();
const fileFor = (jid) => {
  const base = slug(orig[jid]?.subject ?? jid);
  const seen = usedNames.get(base);
  if (!seen) { usedNames.set(base, jid); return base; }
  if (seen === jid) return base;
  return `${base}-${String(jid).replace(/@.*$/, '').slice(-4)}`;
};
for (const { jid, desc } of plan) {
  fs.writeFileSync(path.join(descDir, `${fileFor(jid)}.txt`), `${desc}\n`);
}

// One file per rule set, plus the combined master text.
for (const set of RULE_SETS) {
  const cmd = String(set.command || '').replace(/^#/, '') || 'rules';
  fs.writeFileSync(path.join(rulesDir, `${slug(cmd)}.txt`),
    `${set.label ? `# ${set.label}\n# command: ${set.command}\n\n` : ''}${set.text.trim()}\n`);
}
fs.writeFileSync(path.join(rulesDir, '_master.txt'), `${buildMasterRules(RULE_SETS).trim()}\n`);

// An index, so the folder explains itself.
const idx = [
  '# Group descriptions and rules',
  '',
  'Generated by `node tools/build-descriptions.mjs`. Edit the generator, not',
  'these files - a hand edit here is overwritten on the next run.',
  '',
  '## Descriptions',
  '',
  ...plan.map(({ jid }) => {
    const name = orig[jid]?.subject ?? jid;
    return `- [${name}](descriptions/${fileFor(jid)}.txt) — \`${GROUP_RULE_SET[jid] ?? 'no rules command'}\``;
  }),
  '',
  '## Rule sets',
  '',
  ...RULE_SETS.map((s) => `- [${s.label ?? s.command}](rules/${slug(String(s.command).replace(/^#/, ''))}.txt) — \`${s.command}\``),
  '- [Combined master text](rules/_master.txt)',
  '',
  '## A note on how these reach people',
  '',
  'Rules are answered **in the group** with the command above. The old "PM the',
  'bot" route is gone: it needed a wa.me link with a hard-coded phone number in',
  'every description, so switching numbers broke all fifteen at once.',
].join('\n');
fs.writeFileSync(path.join(contentDir, 'README.md'), `${idx}\n`);
console.log(`content written -> ${contentDir} (${plan.length} descriptions, ${RULE_SETS.length} rule sets)`);

if (process.argv.includes('--apply')) {
  if (over) { console.error('refusing to apply: some descriptions exceed the limit'); process.exit(1); }
  fs.writeFileSync(path.join(DATA, 'bot-cmd.json'), JSON.stringify({ op: 'apply-descriptions', plan }, null, 2));
  console.log('queued apply-descriptions for the running bot');
}
if (process.argv.includes('--post')) {
  // Post each description INTO its group and pin it for 30 days.
  fs.writeFileSync(path.join(DATA, 'bot-cmd.json'),
    JSON.stringify({ op: 'post-descriptions', plan, pin: true, pinSeconds: 2592000 }, null, 2));
  console.log(`queued post-descriptions for ${plan.length} group(s) — will pin for 30 days`);
}
if (process.argv.includes('--apply-rules')) {
  // The master `#rules` text is regenerated too. Leaving it out is exactly how
  // it went stale before: the plugin only seeds `rules` when it is EMPTY, so
  // edits to default-rules.txt never reached an already-configured install.
  fs.writeFileSync(path.join(DATA, 'bot-cmd.json'), JSON.stringify({
    op: 'set-rule-sets',
    ruleSets: RULE_SETS,
    groupRuleSet: GROUP_RULE_SET,
    rules: buildMasterRules(RULE_SETS),
  }, null, 2));
  console.log('queued set-rule-sets (including the master #rules text)');
}
