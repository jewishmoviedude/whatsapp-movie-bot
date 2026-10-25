/**
 * What the reactions mean, as the request groups are told: the movie legend
 * and the TV one. tools/build-descriptions.mjs puts them in the group
 * descriptions and the rules.
 *
 * They live here, on their own, because build-descriptions.mjs rewrites
 * content/ and reads data/ as it loads, so a test that imports it cannot run
 * on a clone without data/. test/tv-legend.test.mjs checks from here that
 * every emoji the TV legend explains is one the TV plugin can send.
 */

export const FORM_MISSING = 'https://forms.gle/ExampleForm01';   // movie not on the server

// 🔢 is the 11th place and on: positionEmoji() gives 1️⃣…🔟 to places 1 to
// 10. It said "more than 10 ahead", which is the 12th place on.
export const LEGEND = `🔍 Researching · 🎬 Added to the queue
1️⃣2️⃣3️⃣…🔟 Your place in line (updates live) · 🔢 11th or further back
⬇️ Downloading · ⚙️ Converting · ⬆️ Sending · ✅ Done

If we can't do it:
⛔ Rated R / NC-17 / X / TV-MA — not allowed
🎪 Only in theaters — not on the server yet
📬 Not in the library — tell us here: ${FORM_MISSING}
❓ Not a movie we could find — check the spelling. An unofficial film? Request it in group 07
📅 More than one movie has that name — add the year
☝️ More than one movie in one message — send each on its own
❌ An admin cancelled it — it isn't coming
⏭️ An admin set it aside (usually a huge file)
⚠️ Something went wrong (the bot usually retries)
⏸️ On hold — requests are paused for a moment; it runs by itself when they resume, no need to ask again`;

// ⏸️ is the request pause (src/core/request-pause.js, the operator's request
// of 2026-10-01): a request that arrives while an admin has paused requests
// waits, and runs by itself, in order, when they resume. Both legends say so,
// as every reaction a request can get must be explained (tv-legend.test.mjs).
//
// Neither has a 🔄 line any more: no request gets one. A request picked back
// up after a restart, or retried, shows its place or its stage instead, the
// lines above (src/media/stage-reaction.js). 🔄 on Ethan Adams's "Iron Man
// 3 2013" after the 15:22 restart on 2026-10-11 was read as "send it again".
//
// The operator's wording (2026-09-29), for the TV request group, once TV
// requests showed their place in line: a season is one place, films go
// first so a TV place can go up, 🤥 is a repeat, and ⬇️ ⚙️ ⬆️ come round
// once per episode of a season.
export const TV_LEGEND = `🔍 Researching · 🎬 Added to the queue · 🤥 Already asked for — it's coming, not added twice
1️⃣2️⃣3️⃣…🔟 Your place in line (updates live; a whole season is one place, and films go first, so it can go up) · 🔢 11th or further back
⬇️ Downloading · ⚙️ Converting · ⬆️ Sending (repeats for each episode of a season) · ✅ Done

If we can't do it:
⛔ Rated TV-MA / R / NC-17 / X — not allowed (in a season, only those episodes are left out)
📺 Which season? — say the season, e.g. *#request The Office S01*
📬 Not in the library, or the name didn't match — check the spelling. Admin will review and advise on discussions group (link below)
✍️ Not written properly — write the season and episode like *#request The Office S01E05* (a zero, not the letter O)
❌ An admin cancelled it — it isn't coming
⏭️ An admin set it aside (usually a huge file)
⚠️ Something went wrong and the bot gave up — ask again later
🚫 Too soon — one request per person per hour; send it again once the hour is up
⏸️ On hold — requests are paused for a moment; it runs by itself when they resume, no need to ask again
Up to 10 episodes of one season a request — for more, the bot replies with how to ask for the rest.
No reaction at all? Start the message with *#request*.`;
