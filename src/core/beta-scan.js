/**
 * The hourly check's reading of the beta groups: the testers' conversations
 * with the bot, from the transcript (beta-transcript.js), turned into
 * findings.
 *
 * The operator (2026-09-30): "the bot likes to edit it's messages on the test
 * group but I need it all logged somewhere for you to check on the hourly
 * debug so I don't have to manually report to you, hourly debug analyze the
 * recent conversations in that group". Until then the check skipped every
 * beta row on purpose - a test's refusal is not a member let down - and so a
 * test that went wrong was heard of only when the operator typed it up. The
 * cases that started this, all from the testing group on 2026-09-30 (UTC):
 *
 *   - 00:08 "Mission Impossible": the pick list's search matched no film at
 *     all, and the request went on to queue Mission: Impossible (1996) as a
 *     real download, the other six never offered;
 *   - 02:17 "john wick": four John Wick films on the server, none of them
 *     listed (all four R-rated), and the request fell through to a single
 *     film's "Test passed";
 *   - a list crammed onto one line, unreadable on a phone.
 *
 * Every finding is labelled a test (kind 'beta-test', `beta: true`): the
 * people involved are testers trying features under development, not members
 * with a request that failed. Each carries the conversation around it,
 * exactly as the testers saw it, every edit of every bot message included
 * (`excerpt`), so the research session and the report show what happened
 * without anyone retyping it.
 *
 * Pure: the caller reads the transcript and the clock.
 */
import { normalizeTitle, startsWithWords, sameTitleWords, cleanRequestText, extractYear } from '../util/fuzzy.js';
import { parseTvRequest } from '../plugins/tv-requests/parse.js';
import { keycapNumber } from '../plugins/movie-requests/pick-list.js';
import { RETIRED_CODES } from './beta.js';

const MIN = 60_000;

export const BETA_DEFAULTS = {
  // A reaction can wait behind the outbound pacing, and a lookup takes
  // seconds; a test younger than this is left for the next hour.
  betaGraceMs: 10 * MIN,
  // The same tester sending the same request again within this long was
  // not helped by the first answer.
  betaRepeatMs: 10 * MIN,
  // A list is shown, maybe struck through once or twice, then ticked: past
  // this many edits it is going round in circles.
  betaManyEdits: 4,
  // What a phone shows as a wall: one line this long, or a whole reply this
  // long. A list is one film per line.
  betaLongLine: 250,
  betaLongReply: 1500,
  // A long reply laid out as paragraphs none longer than this is not a wall:
  // beta001's pick list of nine films, each with its plot, runs past
  // betaLongReply and is the layout the operator asked for (2026-09-30,
  // "message needs to be neater paragraphed").
  betaLongParagraph: 400,
  // How much of the conversation a finding carries.
  betaExcerptMax: 40,
};

const t = (e) => Date.parse(e.at);
const short = (id) => (id ? String(id).slice(-6) : '?');
const clock = (ms) => new Date(ms).toISOString().slice(11, 19);

/** "$beta001 #request john wick" -> "john wick": what the tester asked for. */
export function askedFor(text) {
  return String(text ?? '')
    .replace(/^\s*\$beta\S*[\s:,.;-]*/i, '')
    .replace(/^#[\w-]+\s*/, '')
    .trim();
}

/**
 * Is this bot message a pick list? Since 2026-09-30 it opens
 * '🔍 *Search results for "john wick"*' (or '🔍 *Search results*' for a list
 * journalled before the words were kept); before that, "Search Results:".
 * Both are read, so a transcript that spans the change reads whole.
 */
export function isPickList(text) {
  return /^(?:🔍\s*\*Search results\b|Search Results:)/.test(String(text ?? ''));
}

/** A bare number answering a list, with or without the code in front. */
const PICK_ANSWER = /^\s*(?:\$beta\d+[\s:,.;-]*)?(?:#[\w-]+\s+)?(\d{1,2})\s*$/i;

/**
 * { n, title, year, refused } for each film of a list: "*1.* John Wick (2014)"
 * with its plot in italics on the next line, "~2. Venom (1981)~ — can't be
 * sent" struck through (pick-list.js formatPickList), and the older one-line
 * "1 John Wick (2014) - plot" and "~1 Venom (1981)~".
 */
export function listItems(text) {
  const items = [];
  for (const line of String(text ?? '').split('\n')) {
    const m = /^(~)?\*?(\d{1,2})\.?\*?\s+(.+?) \((\d{4}|\?)\)/.exec(line.trim());
    if (m) items.push({ n: Number(m[2]), title: m[3], year: Number(m[4]) || null, refused: !!m[1] });
  }
  return items;
}

/** What a "Test passed" said the bot would send, or null. */
export function passedFilm(text) {
  const s = String(text ?? '');
  if (!/Test passed/.test(s)) return null;
  const film = /would send \*(.+?)\* \((\d{4})\)/.exec(s);
  if (film) return { title: film[1], year: Number(film[2]) };
  // "The bot would queue 10 episodes of *The Office* season 1." (tv-requests
  // _testPassedWords), or one episode in bold; before 2026-09-30, "would
  // queue 10 episode(s) of The Office S01 — nothing was downloaded".
  const show = /would queue (?:\d+ episodes? of )?\*(.+?)\*/.exec(s) ?? /would queue (.+?) — /.exec(s);
  return show ? { title: show[1], year: null, tv: true } : null;
}

/** One transcript event as a line of the excerpt, as the group saw it. */
export function excerptLine(e) {
  const at = `${clock(t(e))} UTC`;
  const body = (s) => String(s ?? '').replace(/\n/g, '\n      | ');
  switch (e.type) {
    case 'in':
      return `${at} ${e.from?.name ?? 'someone'}${e.from?.id ? ` (#${e.from.id})` : ''} [${short(e.id)}]: ${body(e.text || `(${e.messageType ?? 'no text'})`)}`;
    case 'in-react':
      return `${at} ${e.from?.name ?? 'someone'}${e.from?.id ? ` (#${e.from.id})` : ''} reacted ${e.emoji} on [${short(e.on)}]`;
    case 'out':
      return `${at} BOT [${short(e.id)}${e.replyTo ? ` replying to ${short(e.replyTo)}` : ''}]${e.document ? ` sent the file ${e.document}` : ''}: ${body(e.text)}`;
    case 'edit':
      return `${at} BOT edited [${short(e.of)}] to: ${body(e.text)}`;
    case 'react':
      // An empty emoji takes the bot's reaction back off (a ⏸️ when a held
      // pick runs, a ❓ once the list is answered).
      return e.emoji ? `${at} BOT reacted ${e.emoji} on [${short(e.on)}]` : `${at} BOT took its reaction off [${short(e.on)}]`;
    case 'delete':
      return `${at} BOT deleted [${short(e.of)}]`;
    case 'failed':
      return `${at} BOT could not ${e.action ?? 'send'}${e.replyTo ? ` (replying to ${short(e.replyTo)})` : ''}${e.of ? ` [${short(e.of)}]` : ''}: ${e.error}`;
    case 'note':
      return `${at} (not shown in the group) ${e.note}${e.heldTitles ? ` - on the server: ${e.heldTitles}` : ''}${e.ref ? ` [re ${short(e.ref)}]` : ''}`;
    default:
      return `${at} ${e.type}`;
  }
}

/**
 * The events of one group, threaded: each tester message with everything the
 * bot did about it - replies, reactions, notes, the edits of those replies -
 * and each list with the numbers that answered it.
 */
function thread(events) {
  const byId = new Map();
  for (const e of events) if (e.id && (e.type === 'in' || e.type === 'out')) byId.set(e.id, e);
  // The message a bot event is ultimately about: a reply's quoted message,
  // an edit's original, a reaction's target - followed back to a tester's.
  const root = new Map();
  const rootOf = (id, depth = 0) => {
    if (!id || depth > 6) return id;
    if (root.has(id)) return root.get(id);
    const m = byId.get(id);
    const up = m?.type === 'out' ? m.replyTo : null;
    const r = up ? rootOf(up, depth + 1) : id;
    root.set(id, r);
    return r;
  };
  // A number answering a list belongs to the list's request: the latest list
  // in the group before it, and the sender's own when there is one.
  const lists = events.filter((e) => e.type === 'out' && isPickList(e.text));
  for (const e of events) {
    if (e.type !== 'in' || !PICK_ANSWER.test(e.text ?? '')) continue;
    const before = lists.filter((l) => t(l) <= t(e));
    const mine = before.filter((l) => byId.get(l.replyTo)?.from?.id === e.from?.id);
    const list = (mine.length ? mine : before).at(-1);
    if (list) root.set(e.id, rootOf(list.replyTo ?? list.id));
  }
  const about = (e) => {
    switch (e.type) {
      case 'in': return rootOf(e.id);
      // A tester's reaction belongs with the message it is on: a number put
      // on a list, with the request the list answers.
      case 'in-react': return rootOf(e.on);
      case 'out': return rootOf(e.id);
      case 'edit': case 'delete': return rootOf(e.of);
      case 'react': return rootOf(e.on);
      case 'note': return rootOf(e.ref);
      case 'failed': return rootOf(e.replyTo ?? e.of);
      default: return null;
    }
  };
  const threads = new Map();
  const home = new Map();
  for (const e of events) {
    const k = about(e);
    if (!k) continue;
    if (!threads.has(k)) threads.set(k, []);
    threads.get(k).push(e);
    home.set(e, k);
  }
  return { threads, byId, rootOf, home };
}

/** The conversation around a thread: everything in the group while it ran. */
function excerptFor(groupEvents, threadEvents, opt) {
  if (!threadEvents.length) return [];
  const from = t(threadEvents[0]);
  const to = t(threadEvents.at(-1));
  let around = groupEvents.filter((e) => t(e) >= from && t(e) <= to);
  // A busy group: the thread itself, rather than a window cut off halfway.
  if (around.length > opt.betaExcerptMax) around = threadEvents.slice(-opt.betaExcerptMax);
  return around.map(excerptLine);
}

/**
 * Did the bot do anything at all about this thread's request? A tester's
 * own reaction ('in-react') is not the bot answering.
 */
const answered = (evs) => evs.some((e) => e.type !== 'in' && e.type !== 'in-react'
  && !(e.type === 'note' && e.event === 'pick-decision'));

/**
 * The pick a tester made by reacting to a list, for the answer `e`, read by
 * the bot's own rules (movie-requests _claimPick): after the list last stood
 * as a list (shown, or reopened with a version struck through) and before
 * the answer, the tester's first number the bot would have TAKEN - a keycap
 * on that list's own message, or a typed number, either one on the list and
 * not struck through. First, because the first pick wins. Null when that
 * pick was typed, or there was none.
 *
 * It took the tester's first keycap anywhere in the thread at first, and so
 * filed a wrong film for a stray 1️⃣ put on the list after a typed "2" had
 * won, and missed a real one behind a 7️⃣ the bot had refused before the 2️⃣
 * it took (found in review, 2026-10-01).
 */
function reactionPick(tev, req, e) {
  if (!req?.from?.id) return null;
  const list = [...tev].reverse().find((x) => (x.type === 'out' || x.type === 'edit') && t(x) <= t(e) && isPickList(x.text));
  if (!list) return null;
  const listId = list.type === 'edit' ? list.of : list.id;
  const items = listItems(list.text);
  const takes = (n) => items.some((i) => i.n === n && !i.refused);
  const won = tev.find((x) => x !== req && t(x) >= t(list) && t(x) <= t(e) && x.from?.id === req.from.id
    && ((x.type === 'in-react' && x.on === listId && takes(keycapNumber(x.emoji)))
      || (x.type === 'in' && takes(Number(PICK_ANSWER.exec(x.text ?? '')?.[1])))));
  if (won?.type !== 'in-react') return null;
  return { event: won, n: keycapNumber(won.emoji), list };
}

/** Events that mean a real download happened in a test, which must never happen. */
const DOCUMENT_FILE = /\.(docx?|pdf|txt|xlsx?|csv)$/i;

function downloadSigns(evs, config) {
  const r = config?.movieRequests?.reactions ?? {};
  const queueEmoji = new Set([r.added ?? '🎬', r.downloading ?? '⬇️', r.converting ?? '⚙️', r.sending ?? '⬆️',
    ...(Array.isArray(r.positions) ? r.positions : ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟']),
    r.positionOverflow ?? '🔢']);
  // The Drive links document (Google Drive Links.docx), posted by an admin's
  // "post-drive-links" into the test group on 2026-10-23 19:16 UTC, is not a
  // film: only a file that is not an office or text document counts.
  return evs.filter((e) => (e.type === 'out' && e.document && !DOCUMENT_FILE.test(e.document))
    || (e.type === 'react' && queueEmoji.has(e.emoji))
    || ((e.type === 'out' || e.type === 'edit') && /\bon its way\b/i.test(e.text ?? '')));
}

/** What the thread's request ended with: a "Test passed" film, or signs of a download. */
function outcomeOf(evs, config) {
  const note = evs.find((e) => e.type === 'note' && e.event === 'test-passed');
  const said = evs.find((e) => e.type === 'out' && passedFilm(e.text));
  if (note || said) {
    const film = note?.film ?? (note?.show ? { title: note.show.title, year: null, tv: true } : null) ?? passedFilm(said.text);
    return { kind: 'passed', film, event: said ?? note };
  }
  const dl = downloadSigns(evs, config);
  if (dl.length) return { kind: 'download', event: dl[0] };
  return null;
}

function label(film) {
  return film ? `${film.title}${film.year ? ` (${film.year})` : ''}` : 'a film';
}

/**
 * The findings for the beta groups' conversations since `since`.
 *
 * `events` is the transcript, from a while before `since` so a list shown
 * earlier is there for the number that answers it now.
 */
export function betaFindings({ events = [], since = 0, now = Date.now(), config = {}, options = {} } = {}) {
  const opt = { ...BETA_DEFAULTS, ...options };
  const findings = [];
  const groups = new Map();
  for (const e of events) {
    if (!e?.group || !Number.isFinite(t(e))) continue;
    if (!groups.has(e.group)) groups.set(e.group, []);
    groups.get(e.group).push(e);
  }

  for (const [group, evs] of groups) {
    evs.sort((a, b) => t(a) - t(b));
    const { threads, byId, rootOf, home } = thread(evs);
    const groupName = evs.find((e) => e.groupName)?.groupName ?? group;

    const add = (rule, anchor, rootId, severity, title, extra = {}) => {
      const tev = threads.get(rootId) ?? [anchor];
      const req = byId.get(rootId);
      const code = req?.test?.code ?? tev.find((e) => e.code)?.code ?? null;
      const excerpt = excerptFor(evs, tev, opt);
      findings.push({
        fp: `beta:${rule}:${anchor.type}:${anchor.id ?? anchor.of ?? anchor.on ?? anchor.ref ?? rootId}:${anchor.at}`,
        kind: 'beta-test',
        rule,
        beta: true,
        severity,
        title: `Beta test${code ? ` $${code}` : ''} in ${groupName}: ${title}`,
        at: t(anchor),
        request: req ? {
          text: req.text, requester: req.from?.name ?? null, group: groupName,
          detail: `a test of a feature under development${code ? ` ($${code})` : ''} - not a member's request`,
        } : { group: groupName, detail: 'a test of a feature under development - not a member\'s request' },
        evidence: excerpt.slice(0, 6),
        excerpt,
        restartHelps: false,
        rerunnable: false,
        ...extra,
      });
    };
    const fresh = (e) => t(e) >= since;

    // 1. A coded test that got no answer at all.
    for (const e of evs) {
      if (e.type !== 'in' || !e.test || !fresh(e) || now - t(e) < opt.betaGraceMs) continue;
      // A number answering a list is answered by what happens to the list
      // after it: the ✔ edit, the "Test passed".
      const mine = threads.get(rootOf(e.id)) ?? [];
      const reply = rootOf(e.id) === e.id ? mine : mine.filter((x) => x.type !== 'in' && t(x) >= t(e));
      if (answered(reply)) continue;
      add('unanswered', e, e.id, 'unfulfilled', `"${e.text}" from ${e.from?.name ?? 'a tester'} got no answer - no reply, no reaction`);
    }

    // 2. A pick list that came back empty, or with nothing sendable, when the
    //    server holds the films - or whose search found nothing, while the
    //    request then went on to find one.
    for (const e of evs) {
      if (e.type !== 'note' || e.event !== 'pick-decision' || !fresh(e)) continue;
      const rootId = home.get(e) ?? e.ref;
      const after = (threads.get(rootId) ?? []).filter((x) => t(x) >= t(e));
      const end = outcomeOf(after, config);
      const went = end ? (end.kind === 'passed' ? ` - and the request then fell through to a single film's "Test passed" for ${label(end.film)}, with no list`
        : ' - and the request then went on to a real download') : '';
      if (e.decision === 'none' && e.held > 0 && !e.sendable) {
        add('pick-none-sendable', e, rootId, 'unfulfilled',
          `the pick list for "${e.query}" listed none of the ${e.held} film(s) the server holds (${e.why})${went}`);
      } else if (e.decision === 'none' && !e.held && end) {
        add('pick-empty', e, rootId, 'unfulfilled',
          `the pick list's search matched no film on the server for "${e.query}"${went.replace(/^ - and/, ', yet')} - the list's search missed what the request found`);
      }
    }
    for (const e of evs) {
      if ((e.type !== 'out' && e.type !== 'edit') || !isPickList(e.text) || !fresh(e)) continue;
      const items = listItems(e.text);
      if (!items.length || items.every((i) => i.refused)) {
        add('pick-empty', e, home.get(e) ?? e.replyTo ?? e.id, 'unfulfilled',
          `a pick list ${e.type === 'edit' ? 'was edited to' : 'went out with'} ${items.length ? 'every film struck through' : 'no films in it'}`);
      }
    }

    // 3. A "Test passed" for a film other than the one named or picked.
    for (const [rootId, tev] of threads) {
      const req = byId.get(rootId);
      if (!req || req.type !== 'in') continue;
      for (const e of tev) {
        const film = e.type === 'out' ? passedFilm(e.text) : null;
        if (!film || !fresh(e)) continue;
        const target = byId.get(e.replyTo);
        const pick = target && target !== req && PICK_ANSWER.exec(target.text ?? '');
        // A pick made by reacting has no message of its own for the answer
        // to quote; the answer quotes the request, and the number is the
        // tester's keycap on the list (reactionPick).
        const reacted = pick ? null : reactionPick(tev, req, e);
        const wrongPick = (item, who) => (item && !(sameTitleWords(item.title, film.title)
          && (!item.year || !film.year || Math.abs(item.year - film.year) <= 1))
          ? `${who ?? 'the tester'} picked ${item.n} · ${item.title}${item.year ? ` (${item.year})` : ''}, and the test passed for ${label(film)}`
          : null);
        let wrong = null;
        if (pick) {
          // The number, read against the list as it stood when it was sent.
          const list = [...tev].reverse().find((x) => (x.type === 'out' || x.type === 'edit') && t(x) <= t(target)
            && isPickList(x.text));
          wrong = wrongPick(listItems(list?.text).find((i) => i.n === Number(pick[1])), target.from?.name);
        } else if (reacted) {
          const item = listItems(reacted.list.text).find((i) => i.n === reacted.n);
          wrong = wrongPick(item, reacted.event.from?.name);
          if (wrong) wrong = wrong.replace(' picked ', ` reacted ${reacted.event.emoji}, picking `);
        } else if (target === req || e.replyTo === rootId) {
          const said = askedFor(req.text);
          const typed = film.tv ? (parseTvRequest(said).title ?? said) : cleanRequestText(said) || said;
          const year = film.tv ? null : extractYear(said);
          const words = normalizeTitle(typed);
          const title = normalizeTitle(film.title);
          const fits = !words || startsWithWords(film.title, typed) || title.includes(words);
          if (!fits || (year && film.year && Math.abs(year - film.year) > 1)) {
            wrong = `"${said}" was asked for, and the test passed for ${label(film)}`;
          }
        }
        if (wrong) add('wrong-film', e, rootId, 'unfulfilled', wrong);
      }
    }

    // 4. A bot error, or ⚠️, in the group; 9. anything of a real download.
    for (const e of evs) {
      if (!fresh(e)) continue;
      const rootId = home.get(e) ?? e.id;
      if (e.type === 'failed') add('bot-error', e, rootId, 'error', `the bot could not ${e.action ?? 'send'} there: ${e.error}`);
      else if (e.type === 'react' && /⚠/.test(e.emoji)) add('bot-error', e, rootId, 'error', 'the bot answered a test with ⚠️ (something went wrong)');
      else if ((e.type === 'out' || e.type === 'edit') && /⚠/.test(e.text ?? '')) {
        add('bot-error', e, rootId, 'error', `the bot said ⚠️: "${String(e.text).split('\n')[0].slice(0, 160)}"`);
      }
    }
    for (const [rootId, tev] of threads) {
      const signs = downloadSigns(tev, config).filter(fresh);
      if (signs.length) {
        add('test-downloaded', signs[0], rootId, 'error',
          `a test went on to a real download (${signs.map((s) => (s.type === 'react' ? s.emoji : s.document ? 'a file sent' : '"on its way"')).join(', ')}) - a test must never download, queue or send`);
      }
    }

    // 5. The same tester asking for the same thing again within minutes.
    const reqs = evs.filter((e) => e.type === 'in' && e.test && ['movie', 'tv'].includes(e.test.outcome) && !PICK_ANSWER.test(e.text ?? ''));
    for (let i = 0; i < reqs.length; i++) {
      const b = reqs[i];
      if (!fresh(b)) continue;
      const key = normalizeTitle(askedFor(b.text));
      const a = reqs.slice(0, i).reverse().find((x) => x.from?.id && x.from.id === b.from?.id
        && t(b) - t(x) <= opt.betaRepeatMs && normalizeTitle(askedFor(x.text)) === key);
      if (!a || !key) continue;
      const mins = Math.max(1, Math.round((t(b) - t(a)) / MIN));
      const first = threads.get(a.id) ?? [a];
      // A test that already passed was answered; asking it again is a tester
      // re-checking on purpose (2026-09-30 05:28-05:32: four of eight
      // "repeat" alarms were heat, ride along and twilight re-run after
      // "Test passed"). Only a first attempt that never got there is worth a look.
      if (first.some((x) => (x.type === 'note' && x.event === 'test-passed')
        || ((x.type === 'out' || x.type === 'edit') && /test passed/i.test(x.text ?? '')))) continue;
      add('repeat', b, a.id, 'unfulfilled',
        `${b.from?.name ?? 'a tester'} asked for "${askedFor(b.text)}" again ${mins} min after the first time - the first answer may have been wrong or unclear`,
        { excerpt: excerptFor(evs, [...first, ...(threads.get(b.id) ?? [b])].sort((x, y) => t(x) - t(y)), opt) });
      findings.at(-1).evidence = findings.at(-1).excerpt.slice(0, 6);
    }

    // 6. A message edited many times; 7. a long or unparagraphed reply.
    const edits = new Map();
    for (const e of evs) if (e.type === 'edit') edits.set(e.of, [...(edits.get(e.of) ?? []), e]);
    for (const [of, list] of edits) {
      const last = list.at(-1);
      if (list.length < opt.betaManyEdits || !fresh(last)) continue;
      add('many-edits', last, home.get(last) ?? of, 'unfulfilled',
        `one bot message [${short(of)}] was edited ${list.length} times - the testers watched it change under them`);
    }
    for (const e of evs) {
      if ((e.type !== 'out' && e.type !== 'edit') || !fresh(e)) continue;
      const text = String(e.text ?? '');
      const lines = text.split('\n');
      const crammed = lines.find((l) => l.length > opt.betaLongLine || (l.match(/\((?:19|20)\d\d\)/g) ?? []).length >= 4);
      const paragraphed = text.split(/\n\s*\n/).every((p) => p.length <= opt.betaLongParagraph);
      if ((text.length <= opt.betaLongReply || paragraphed) && !crammed) continue;
      const rootId = home.get(e) ?? e.id;
      add('long-reply', e, rootId, 'unfulfilled', crammed
        ? `a reply crams ${crammed.length} characters into one line${(crammed.match(/\((?:19|20)\d\d\)/g) ?? []).length >= 4 ? ' - a list of films with no line breaks' : ''}: hard to read on a phone`
        : `a reply ${text.length} characters long - hard to read on a phone`);
    }

    // 8. ❓ for a code.
    for (const [rootId, tev] of threads) {
      const req = byId.get(rootId);
      if (!req?.test) continue;
      // A retired code is answered ❓ "has finished" on purpose. beta001 is
      // in every testers' guide pasted into the group before 2026-10-11, when
      // the "which one?" list left beta for every group, and a finding for
      // each tester still using it would set the hourly check to bring back a
      // code that must never be reused (beta.js RETIRED_CODES).
      if (RETIRED_CODES.includes(req.test.code)) continue;
      const q = tev.find((e) => fresh(e) && ((e.type === 'react' && e.on === rootId && /❓/.test(e.emoji))
        || (e.type === 'out' && e.replyTo === rootId && /^❓/.test(e.text ?? ''))));
      if (q) {
        add('code-questioned', q, rootId, 'unfulfilled',
          `"${req.text}" was answered ❓${req.test.typed ? ` - the code ${req.test.typed} was not taken` : ''}`);
      }
    }
  }

  // One finding per fingerprint; the same event can meet a rule twice.
  const seen = new Set();
  return findings.filter((f) => (seen.has(f.fp) ? false : seen.add(f.fp)));
}

/**
 * The report's own section for the tests: every beta finding with its
 * conversation, under a heading of its own, so a test is never read as a
 * member let down.
 */
export function betaReportSection(findings = []) {
  const beta = findings.filter((f) => f?.beta);
  if (!beta.length) return [];
  const out = [`## Beta tests in the testing group (${beta.length})`, '',
    'Tests of features under development, from the transcript of the beta groups (data/beta-transcript/). '
    + 'The people are testers, not members with a failed request. Times are UTC.', ''];
  for (const f of beta) {
    out.push(`### ${f.ref ? `${f.ref} ` : ''}${String(f.title).replace(/`/g, "'")}`, '');
    if (f.remedy) out.push(`What to do: ${f.remedy}`, '');
    out.push('```', ...(f.excerpt ?? f.evidence ?? []).map((l) => String(l).replace(/```/g, "'''")), '```', '');
  }
  return out;
}
