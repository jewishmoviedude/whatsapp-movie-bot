/* The hourly check fixes what it finds; it does not hand it back.
   Run: node test/hourly-fixes-on-its-own.test.mjs

   The operator, 2026-10-09: "why do I need to keep prompting you step after
   step, just get it done on your own during the hourly debug". The check had
   called Frieren season 1 "3 episodes, a content gap" (28 files, 3 numbered
   by Jellyfin; tools/diagnose-library.mjs could not show episodes), fixed
   "X2 2003" but not the full "X2: X-Men United 2003" an hour later, and its
   instructions said to report a hypothesis rather than change code when
   unsure. These pin the instructions and the tool that change that. */
import fs from 'node:fs';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const prompt = fs.readFileSync(new URL('../deploy/hourly-debug/prompt.md', import.meta.url), 'utf8');
const flat = prompt.replace(/\s+/g, ' ');

console.log('=== the research session is told to fix, not to report ===');
ok(!/If you are not sure, do not change code - report the hypothesis/.test(flat), 'the old "report the hypothesis" rule is gone');
ok(/the operator wants problems fixed, not reported/.test(flat), 'it is told the operator wants problems fixed');
ok(/Anything you would tell the operator to look into, look into yourself first/.test(flat), 'and to look into anything before handing it on');
ok(/code bug until the library proves otherwise/.test(flat), 'a wrong answer to a member is a code bug until the library proves otherwise');
ok(/Call it \*\*content\*\* only after you have looked at the files/.test(flat), '"content" only after looking at the files');
ok(/Fix the whole class of the bug, not only the spelling in front of you/.test(flat), 'the whole class of a bug, not one spelling');
ok(/\*\*Anything else wrong that you come across, fix too\.\*\*/.test(flat) && /"Also found"/.test(flat), 'and anything else it comes across, in an "Also found" section');
ok(/two fixes a run/.test(flat), 'within the two-fix limit');

console.log('=== the library tool shows what the bot would send ===');
const tool = fs.readFileSync(new URL('../tools/diagnose-library.mjs', import.meta.url), 'utf8');
ok(/import \{ listSeasons, listEpisodes \} from '\.\.\/src\/plugins\/tv-requests\/jellyfin-tv\.js'/.test(tool), 'it uses the bot\'s own episode listing');
ok(/Season by season/.test(tool) && /folder holds/.test(tool) && /the bot sends/.test(tool), 'season by season: what the folder holds against what the bot sends');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
