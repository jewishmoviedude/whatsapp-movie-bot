/* A CSV download on every card of the control panel.

   Asked for on 2026-09-28: "add options in every single part of the panel to
   easily download a csv export of data in each section, for example take a
   csv download of the queue if I want to share with someone quickly". So every
   .card - on every tab, the Settings cards and the cards the panel only shows
   or builds while it runs included - gets the same small "CSV" button in its
   heading, and pressing it downloads that card's data.

   Its own file, loaded after app.js, rather than more of app.js: it reads the
   page's data model (lastQueue, HISTORY, ROSTER, CONFIG, ...) through the
   top-level names app.js declares, which every classic script on a page
   shares, and it changes none of them. Nothing in app.js calls into it.

   Where a card is a view of data - the queue, the history, the logs, the
   members - the file is built from that data, not scraped from the screen:
   the history pane draws 40 rows at a time and the member list 100, and a CSV
   of one page of either is not what anybody sharing it means. Filters the
   card has applied (a search box, a level, a category) are kept; paging is
   not. Every other card, and any card added later, goes through one generic
   exporter that reads its fields, lists and tables off the page, so no card
   is ever without the button - unless the card's own script registers an
   exporter for it (window.panelCsvExporters, below), as the Hourly checks
   card does. Either way the button in the heading is the card's one CSV
   control.

   Secrets never reach a file. A key or password box is written as the same
   mask the server sends for a saved key, whatever is typed in it, and every
   text cell is swept for anything shaped like a credential on top.

   Personal data does. The queue, the history, the member lists and the
   group pages carry the names and phone numbers of the people in them, on
   purpose: the owner shares these files deliberately, with people who need
   to know who asked. The README's Security section says so. */
(() => {
  'use strict';

  // The mask the server puts in place of a saved secret (MASK in
  // src/config/store.js, KEY_MASK in app.js), so a CSV says "set" the same
  // way the panel does.
  const MASK = typeof KEY_MASK === 'string' ? KEY_MASK : '•'.repeat(8);

  /* ------------------------------ serializer ------------------------------ */

  const pad = (n) => String(n).padStart(2, '0');

  /**
   * "2026-09-25 16:05" in the browser's own time zone, as the panel shows
   * times - on the 24-hour clock by the operator's rule, and in an order a
   * spreadsheet sorts correctly. Blank for no time at all.
   */
  function csvWhen(t, { seconds = false } = {}) {
    if (t === null || t === undefined || t === '' || t === 0) return '';
    const d = t instanceof Date ? t : new Date(t);
    if (Number.isNaN(d.getTime())) return String(t);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
      + `${pad(d.getHours())}:${pad(d.getMinutes())}${seconds ? `:${pad(d.getSeconds())}` : ''}`;
  }

  /** The same, as the clock reads in another city - the lockdown card is in New York time. */
  function csvWhenIn(t, timeZone) {
    if (t === null || t === undefined || t === '') return '';
    const d = new Date(t);
    if (Number.isNaN(d.getTime())) return String(t);
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(d).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
  }

  /*
   * Anything shaped like a credential, wherever it turns up in a cell: a
   * Jellyfin link pasted with its api_key (the Queue and Test cards take
   * those), an auth header, a provider key quoted in a log line. The key boxes
   * are masked before they get here; this is for text nobody thought of.
   *
   * Every text cell of every file goes through these, titles included, so
   * each one needs the context a credential comes in, not merely a word that
   * could begin one. The first version masked "Basic" or "Bearer" before any
   * long word, and "sk-" inside any word: "Basic Instinct" came out as
   * "Basic ••••••••" in History, Wanted and the queue, and a file called
   * "Mask-of-Zorro-1998-1080p.mkv" as "Ma••••••••.mkv". So a scheme counts
   * after a header name, or before a token that looks random; a provider key
   * counts only as a word of its own. (No lookbehind: a regex literal with one
   * is a syntax error in Safari before 16.4, and would take the whole file -
   * every CSV button - down with it on an older iPhone.)
   */
  // Random-looking: long with a digit in it, base64 padding, or a long run
  // of mixed case. A word in a title is none of these.
  const looksRandom = (t) => (t.length >= 12 && /[0-9]/.test(t)) || /[A-Za-z0-9+/]{6,}={1,2}$/.test(t)
    || (t.length >= 24 && /[a-z]/.test(t) && /[A-Z]/.test(t.slice(1)));
  const SECRET_TEXT = [
    // In a link: ?api_key=…, &X-Emby-Token=…
    [/([?&;](?:api[_-]?key|access[_-]?token|token|x-emby-token|x-plex-token|x-mediabrowser-token|password|passwd|pw|secret|auth)=)[^&\s#"'<>]+/gi, `$1${MASK}`],
    // Jellyfin's own header, MediaBrowser Client="…", Token="…". Before the
    // header rule below, which would otherwise take `Token=` for the value.
    [/(^|[^A-Za-z0-9_])(Token=")[^"]+/g, `$1$2${MASK}`],
    // A header by its name: "Authorization: Basic …", "X-Emby-Token: …".
    [/(^|[^A-Za-z0-9_-])((?:Proxy-)?Authorization|X-Emby-Token|X-MediaBrowser-Token|X-Plex-Token|X-Api-Key)(\s*[:=]\s*)(?:(Bearer|Basic|Digest|Token)\s+)?[^\s",;]+/gi,
      (m, pre, name, sep, scheme) => `${pre}${name}${sep}${scheme ? `${scheme} ` : ''}${MASK}`],
    // A scheme and token with no header name: only a token that looks random.
    [/(^|[^A-Za-z0-9_])(Bearer|Basic)(\s+)([A-Za-z0-9._~+/-]{8,}=*)/gi,
      (m, pre, scheme, sp, tok) => (looksRandom(tok) ? `${pre}${scheme}${sp}${MASK}` : m)],
    // Provider keys by their prefixes, each a word of its own.
    [/(^|[^A-Za-z0-9])(?:AIza[0-9A-Za-z_-]{30,}|gsk_[A-Za-z0-9]{20,}|csk-[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abpr]-[A-Za-z0-9-]{10,})/g, `$1${MASK}`],
    // A JSON web token.
    [/(^|[^A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, `$1${MASK}`],
    // A Discord account token (the Discord card, 2026-10-11): the user id in
    // base64, a stamp and an HMAC, or the older mfa. form. Three runs of that
    // exact shape, so a dotted file name is left alone.
    [/(^|[^A-Za-z0-9_.-])(?:mfa\.[A-Za-z0-9_-]{20,}|[MNO][A-Za-z0-9_-]{22,27}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{25,45})(?![A-Za-z0-9_-])/g, `$1${MASK}`],
  ];
  function scrubSecrets(s) {
    let out = s;
    for (const [re, to] of SECRET_TEXT) out = out.replace(re, to);
    return out;
  }

  /**
   * A cell that starts with = + - @, a tab or a carriage return is read as a
   * formula by Excel, LibreOffice and Sheets. These files carry text other
   * people typed - titles, requests, group names - and are made to be passed
   * on, so such a cell gets a leading apostrophe (OWASP's CSV-injection
   * advice). A plain number, -5 or +15551234567, is left as it is.
   */
  const PLAIN_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

  /** One field, quoted by RFC 4180 when it holds a comma, a quote or a line break. */
  function csvCell(v) {
    let s;
    if (v === null || v === undefined) s = '';
    else if (typeof v === 'number') s = Number.isFinite(v) ? String(v) : '';
    else if (typeof v === 'boolean') s = v ? 'yes' : 'no';
    else if (v instanceof Date) s = csvWhen(v);
    else {
      s = scrubSecrets(String(v));
      if (/^[=+\-@\t\r]/.test(s) && !PLAIN_NUMBER.test(s)) s = `'${s}`;
    }
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  /**
   * The whole file. CRLF between records, as RFC 4180 has it, and a UTF-8
   * byte-order mark first: without one Excel reads the file as the system code
   * page, and every emoji reaction and Hebrew group name comes out as mojibake.
   */
  function toCsv(columns, rows) {
    return `\uFEFF${[columns, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
  }

  function csvSlug(s) {
    const slug = String(s ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '');
    return slug || 'section';
  }

  /** "queue-2026-09-25-1605.csv": which section, and when, in the name. */
  function csvFilename(slug, now = new Date()) {
    return `${csvSlug(slug)}-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
      + `-${pad(now.getHours())}${pad(now.getMinutes())}.csv`;
  }

  /**
   * A Blob and a temporary <a download>, which is what saves a file on a phone
   * as well as a desktop - the owner runs this panel from a phone. The object
   * URL is revoked once the browser has had time to start the download; iOS
   * Safari loses a download whose URL is revoked straight after the click.
   */
  function downloadCsv(filename, text) {
    const blob = new window.Blob([text], { type: 'text/csv;charset=utf-8' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.setAttribute('href', url);
    a.setAttribute('download', filename);
    a.setAttribute('rel', 'noopener');
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => window.URL.revokeObjectURL(url), 10000);
  }

  /* ----------------------------- page helpers ----------------------------- */

  // Controls and chrome, never data. A pairing code or QR is how a device
  // links to this WhatsApp number, so it is kept out along with the buttons.
  const NOT_TEXT = 'button, script, style, img, svg, input, select, textarea, option, .csv-btn, .hidden, .pair-box';

  /** An element's text without its buttons, controls or hidden parts, on one line. */
  function textOf(el, drop = '') {
    if (!el) return '';
    const copy = el.cloneNode(true);
    copy.querySelectorAll(drop ? `${NOT_TEXT}, ${drop}` : NOT_TEXT).forEach((x) => x.remove());
    return String(copy.textContent ?? '').replace(/\s+/g, ' ').trim();
  }

  /** The text of a snippet of markup app.js would have drawn, such as a status pill. */
  function htmlText(html) {
    const box = document.createElement('div');
    box.innerHTML = String(html ?? '');
    return textOf(box);
  }

  const ownCard = (el) => el?.closest?.('.card') ?? null;
  const owns = (card, sel) => { const el = card.querySelector(sel); return !!el && ownCard(el) === card; };

  /**
   * Where the button goes: the card's own <h2>. The member page the Members
   * tab builds is a card headed by an <h3>, so the first heading of the card's
   * own is taken next; a card with no heading at all gets a row of its own.
   */
  function headerOf(card, { create = true } = {}) {
    const h2 = [...card.children].find((el) => el.tagName === 'H2');
    if (h2) return h2;
    const h = [...card.querySelectorAll('h2, h3, h4')].find((el) => ownCard(el) === card);
    if (h) return h;
    const made = [...card.children].find((el) => el.classList.contains('csv-head'));
    if (made || !create) return made ?? null;
    const row = document.createElement('div');
    row.className = 'csv-head';
    card.insertBefore(row, card.firstChild);
    return row;
  }

  /** The card's name as its heading shows it, without the counts and links beside it. */
  function cardTitle(card) {
    return textOf(headerOf(card, { create: false }), 'a, .pill, .badge, .hint, .tag');
  }

  const yes = (v) => (v ? 'yes' : 'no');
  const orBlank = (v) => (v === null || v === undefined ? '' : v);
  const asList = (v) => (Array.isArray(v) ? v : []);

  /**
   * A phone number as +15551234567, however it was stored. Movie requests
   * kept "+1 (555) 123-4567" until 2026-10-01 and TV requests bare digits, so
   * one column held both; and the formatted one, starting with "+", would
   * have been taken for a formula and prefixed with an apostrophe. Anything
   * that is not a number (a name) comes back as it was. The rule is the
   * panel's own (phoneOut in app.js), so a file says what the page does.
   */
  const phoneRule = typeof phoneOut === 'function' ? phoneOut : (v) => v;
  function phone(v) {
    return String(phoneRule(String(v ?? '').trim()) ?? '');
  }
  // Free text with the old "+1 (555) 123-4567" in it as +15551234567, and a
  // search box's test that finds a pasted number by its digits (app.js).
  const numbersIn = typeof phonesInText === 'function' ? phonesInText : (t) => t;
  const phoneDigits = typeof phoneQuery === 'function' ? phoneQuery : () => null;
  const textMatch = typeof textMatches === 'function' ? textMatches : (t, q) => String(t ?? '').toLowerCase().includes(q);

  /* ---------------------------- generic exporter --------------------------- */

  /**
   * Is this box a secret? A password box always is. So is any text box whose
   * id, name or label says key, token, password, secret or auth - the Jellyfin
   * share key was a plain text box until recently, and a box added tomorrow
   * need not be type=password either. A tick box or a dropdown never is: "API
   * key" as a sign-in method is a choice, not a key.
   */
  const SECRET_NAME = /password|passwd|\bpass\b|secret|token|api[-_ ]?key|apikey|\bkey\b|auth|session|cookie|credential|bearer/i;
  function isSecretField(el, name = '') {
    const type = String(el.getAttribute('type') ?? '').toLowerCase();
    if (type === 'password') return true;
    if (el.tagName === 'SELECT' || type === 'checkbox' || type === 'radio') return false;
    return SECRET_NAME.test(`${el.id ?? ''} ${el.getAttribute('name') ?? ''} ${el.getAttribute('autocomplete') ?? ''} ${name}`);
  }

  const isChecked = (el) => (el.checked === undefined ? el.hasAttribute('checked') : !!el.checked);

  function selectedText(sel) {
    const opt = sel.selectedOptions?.[0]
      ?? [...sel.querySelectorAll('option')].find((o) => (o.getAttribute('value') ?? textOf(o)) === String(sel.value ?? ''))
      ?? null;
    return opt ? textOf(opt) : String(sel.value ?? '');
  }

  /** What a form control says, the way someone reading the card would put it. */
  function controlValue(el, name = '') {
    const type = String(el.getAttribute('type') ?? '').toLowerCase();
    if (type === 'checkbox' || type === 'radio') return yes(isChecked(el));
    if (el.tagName === 'SELECT') return selectedText(el);
    const v = String(el.value ?? '');
    // Typed or saved, a secret is written as the mask: a key pasted and not
    // saved yet is exactly the one a shared file must not carry.
    if (isSecretField(el, name)) return v.trim() ? MASK : '';
    return v;
  }

  const isControl = (el) => ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)
    && String(el.getAttribute('type') ?? '').toLowerCase() !== 'hidden';

  const BREAKS = new Set(['P', 'DIV', 'UL', 'OL', 'LI', 'TABLE', 'PRE', 'LABEL', 'H3', 'H4', 'SECTION']);
  const LEAF_TEXT = new Set(['P', 'DIV', 'LI', 'STRONG']);
  const SKIP = 'button, script, style, img, svg, a, .csv-btn, .pair-box, .bar, .empty';

  /*
   * The panel writes a date and time with fmtDateTime, in the browser's own
   * order - "9/25/2026, 16:05:09" in the US, "25.9.2026, 16:05:09" in
   * Germany - and a card read off the page carries that text, while every
   * dedicated exporter writes "2026-09-25 16:05". A Rated-R override's date
   * or a content-check warning came out one way and the history the other,
   * and the two sort differently. So text read off a card has the panel's
   * own format rewritten, learned by formatting one known moment the way the
   * panel does: whatever the locale writes, this reads. A locale that gives
   * no pattern (digits other than 0-9) is left as it is.
   *
   * The same goes for the other ways a moment reaches a card, each of which
   * names one exactly: fmtWhen()'s "today 16:05" (the last 16:05 before
   * now), the lockdown card's "Sat, Sep 26, 11:51" (always en-US, no year:
   * the year whose Sep 26 is a Saturday, nearest to now), and an ISO time
   * from the server, "2026-09-25T20:05:09Z" (in the browser's time, as
   * every other). "yesterday" and "3 days ago" name no minute, and are left
   * as they are, like any other free text.
   */
  const PANEL_DATES = (() => {
    const probe = new Date(2033, 10, 22, 13, 44, 55);
    const PARTS = [['Y', '2033', '(\\d{4})'], ['M', '11', '(\\d{1,2})'], ['D', '22', '(\\d{1,2})'],
      ['h', '13', '(\\d{1,2})'], ['m', '44', '(\\d{2})'], ['s', '55', '(\\d{2})']];
    const MARK = '\u0000';
    const learn = (sample, want, { today = false } = {}) => {
      let s = String(sample ?? '').replace(/\s+/g, ' ').trim();
      for (const [k, v] of PARTS) {
        const i = s.indexOf(v);
        if (i >= 0) s = `${s.slice(0, i)}${MARK}${k}${MARK}${s.slice(i + v.length)}`;
      }
      const bits = s.split(new RegExp(`${MARK}([YMDhms])${MARK}`));
      const order = bits.filter((b, i) => i % 2 === 1);
      if (want.some((k) => !order.includes(k)) || /[0-9]/.test(bits.filter((b, i) => i % 2 === 0).join(''))) return null;
      const src = bits.map((b, i) => (i % 2 ? PARTS.find(([k]) => k === b)[2]
        : b.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&').replace(/ /g, '\\s+'))).join('');
      // A date only needs its digits kept whole; "today" must also be a word of its own.
      return { re: new RegExp(`(^|[^0-9${today ? 'A-Za-z' : ''}])${src}(?![0-9])`, 'g'), order, time: order.includes('h'), today };
    };
    const found = [];
    try {
      found.push(learn(typeof fmtDateTime === 'function' ? fmtDateTime(probe)
        : probe.toLocaleString(undefined, { hourCycle: 'h23' }), ['Y', 'M', 'D', 'h', 'm']));
      // fmtWhen() writes an old enough date alone, as toLocaleDateString().
      found.push(learn(probe.toLocaleDateString(), ['Y', 'M', 'D']));
      // ...and a moment in the last day as "today" and the time, fmtClock(t, HM).
      const clock = probe.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
      found.push(learn(`today ${clock}`, ['h', 'm'], { today: true }));
    } catch (err) {
      console.warn(`CSV export: dates read off a card stay as the panel writes them (${err?.message})`);
    }
    return found.filter(Boolean);
  })();

  const okDate = (v) => v.M >= 1 && v.M <= 12 && v.D >= 1 && v.D <= 31;
  const okTime = (v) => v.h <= 23 && v.m <= 59;

  // An ISO 8601 time: with a zone it is one moment, written in the browser's
  // time; without one it is already local, and loses only its seconds.
  const ISO_TIME = /(^|[^0-9A-Za-z])(\d{4})-(\d{2})-(\d{2})([T ])(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?(?![0-9A-Za-z:])/g;
  function isoTime(whole, pre, Y, M, D, sep, h, m, s, frac, zone) {
    const v = { M: Number(M), D: Number(D), h: Number(h), m: Number(m) };
    if (!okDate(v) || !okTime(v)) return whole;
    if (zone) {
      const z = zone === 'Z' ? 'Z' : `${zone.slice(0, 3)}:${zone.slice(-2)}`;
      const t = Date.parse(`${Y}-${M}-${D}T${h}:${m}:${s ?? '00'}${frac ?? ''}${z}`);
      return Number.isNaN(t) ? whole : `${pre}${csvWhen(t)}`;
    }
    return sep === ' ' && s === undefined ? whole : `${pre}${Y}-${M}-${D} ${h}:${m}`;
  }

  // lockTimeIn() in app.js: "Sat, Sep 26, 11:51", en-US whatever the browser's language.
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const LOCK_TIME = new RegExp(`(^|[^0-9A-Za-z])(${WEEKDAYS.join('|')}), (${MONTHS.join('|')}) (\\d{1,2}), (\\d{2}):(\\d{2})(?![0-9])`, 'g');
  function lockTime(now) {
    return (whole, pre, wd, mon, day, h, m) => {
      const M = MONTHS.indexOf(mon);
      const D = Number(day);
      if (!okDate({ M: M + 1, D }) || !okTime({ h: Number(h), m: Number(m) })) return whole;
      const year = [0, 1, -1].map((k) => now.getFullYear() + k)
        .filter((y) => new Date(y, M, D).getMonth() === M && new Date(y, M, D).getDay() === WEEKDAYS.indexOf(wd))
        .sort((a, b) => Math.abs(new Date(a, M, D) - now) - Math.abs(new Date(b, M, D) - now))[0];
      return year ? `${pre}${year}-${pad(M + 1)}-${pad(D)} ${h}:${m}` : whole;
    };
  }

  function isoPanelDates(text, now = new Date()) {
    let out = String(text).replace(ISO_TIME, isoTime).replace(LOCK_TIME, lockTime(now));
    for (const { re, order, time, today } of PANEL_DATES) {
      out = out.replace(re, (whole, pre, ...groups) => {
        const v = Object.fromEntries(order.map((k, i) => [k, Number(groups[i])]));
        if (time && !okTime(v)) return whole;
        if (today) {
          const d = new Date(now);
          d.setHours(v.h, v.m, 0, 0);
          if (d > now) d.setDate(d.getDate() - 1);
          return `${pre}${csvWhen(d)}`;
        }
        if (!okDate(v)) return whole;
        return `${pre}${v.Y}-${pad(v.M)}-${pad(v.D)}${time ? ` ${pad(v.h)}:${pad(v.m)}` : ''}`;
      });
    }
    return out;
  }

  /**
   * A card's rows read off the page, as [part, name, value, detail]: its
   * fields, lists, key/value pairs, tables and lines of text, under the
   * sub-heading each sits beneath. Anything matching `omit` is left out - a
   * dedicated exporter that has the data behind part of a card reads the
   * rest this way.
   */
  function cardRows(card, { omit = '' } = {}) {
    const settings = !!card.closest('#tab-settings');
    const head = headerOf(card, { create: false });
    const title = cardTitle(card);
    const rows = [];
    let part = '';
    // `typed`: the value is what a box holds, which is written exactly as it
    // is - a rules text saying "closed 12/25/2026" is not the panel's date.
    const push = (name, value, detail = '', typed = false) => {
      const row = [part, name, value, detail];
      if (typed) row.typed = true;
      rows.push(row);
    };

    // The pill in a key card's heading ("saved", "not set") is its one line of state.
    for (const pill of head?.querySelectorAll('.pill') ?? []) {
      const t = textOf(pill);
      if (t) push('Status', t);
    }

    const skip = (el) => el === head || el.classList.contains('hidden') || el.classList.contains('card') || el.matches(SKIP)
      || (omit !== '' && el.matches(omit));
    const visible = (el) => { const h = el.closest('.hidden'); return !h || h === card || !card.contains(h); };

    const label = (lab) => {
      const ctl = [...lab.querySelectorAll('input, select, textarea')].find(isControl);
      const name = textOf(lab, '.hint, .gjid, .small');
      const detail = [...lab.querySelectorAll('.hint, .gjid, .small')].filter(visible)
        .map((x) => textOf(x)).filter(Boolean).join(' · ');
      // A label with no box of its own heads the list of tick boxes under it.
      if (!ctl) { if (name) part = name; return; }
      push(name || ctl.getAttribute('aria-label') || ctl.id, controlValue(ctl, name), detail, true);
    };
    const bareControl = (el) => {
      if (!isControl(el)) return;
      const name = el.getAttribute('aria-label') || part || title;
      const value = controlValue(el, name);
      if (String(value).trim()) push(name, value, '', true);
    };
    const item = (el) => {
      const titleEl = el.querySelector('.item-title');
      const name = titleEl ? textOf(titleEl, '.pill, .tag, .badge') : '';
      const tags = [...el.querySelectorAll('.pill, .tag')].filter(visible).map((x) => textOf(x)).filter(Boolean);
      const picks = [...el.querySelectorAll('input, select, textarea')].filter((c) => isControl(c) && visible(c))
        .map((c) => controlValue(c, name)).filter((v) => String(v).trim());
      const subs = [...el.querySelectorAll('.item-sub, .dl-row, .dl-sub')].filter(visible)
        .map((x) => textOf(x)).filter(Boolean);
      push(name || textOf(el), [...tags, ...picks].join(' · '), subs.join(' | '));
    };
    const kv = (el) => {
      let key = null;
      for (const c of el.children) {
        if (c.classList.contains('k')) key = textOf(c);
        else if (c.classList.contains('v')) { push(key ?? '', textOf(c)); key = null; }
      }
    };
    const table = (el) => {
      for (const tr of el.querySelectorAll('tr')) {
        const cells = [...tr.children].map((c) => textOf(c));
        if (cells.some(Boolean)) push(cells[0] ?? '', cells[1] ?? '', cells.slice(2).join(' | '));
      }
    };
    const isLeaf = (el) => ![...el.children].some((c) => BREAKS.has(c.tagName) && !c.classList.contains('hidden'));

    const walk = (node) => {
      for (const el of node.children) {
        if (skip(el)) continue;
        const tag = el.tagName;
        const cl = el.classList;
        if (tag === 'H3' || tag === 'H4' || cl.contains('rg-sec') || cl.contains('fic-head')) {
          part = textOf(el, '.badge, .hint');
        } else if (tag === 'LABEL') label(el);
        else if (isControl(el)) bareControl(el);
        else if (cl.contains('kv')) kv(el);
        else if (cl.contains('item') || cl.contains('fic-item')) item(el);
        else if (cl.contains('step')) push(textOf(el.querySelector('.step-name')), textOf(el.querySelector('.step-detail')), textOf(el.querySelector('.step-emoji')));
        else if (cl.contains('rg-row')) push(textOf(el.querySelector('.rg-label')), textOf(el.querySelector('.rg-emoji')));
        else if (cl.contains('ak-row')) push(textOf(el.querySelector('.ak-what')), textOf(el.querySelector('.pill')), textOf(el.querySelector('.ak-sub')));
        else if (tag === 'TABLE') table(el);
        else if (settings) {
          // A settings card is its settings; the prose around them is not data.
          if (tag !== 'P') walk(el);
        } else if (tag === 'PRE') {
          for (const line of String(el.textContent ?? '').split('\n')) if (line.trim()) push('', line.trim());
        } else if (cl.contains('verdict')) push('Result', textOf(el));
        else if (cl.contains('status-row')) push(textOf(el.querySelector('.status-title')), textOf(el, '.status-title'));
        else if (cl.contains('hint')) continue;
        else if (LEAF_TEXT.has(tag) && isLeaf(el) && !el.querySelector('input, select, textarea')) {
          const t = textOf(el);
          if (t) push('', t);
        } else walk(el);
      }
    };
    walk(card);

    const lines = [];
    if (!rows.length) {
      // Nothing shaped like data - the sign-out note, a warning card's
      // paragraphs. Its text is what it has to say, a line per block.
      const blocks = (node, hints) => {
        for (const el of node.children) {
          if (skip(el) || (!hints && el.classList.contains('hint'))) continue;
          if (isLeaf(el)) { const t = textOf(el); if (t) lines.push([t]); } else blocks(el, hints);
        }
      };
      blocks(card, false);
      if (!lines.length) blocks(card, true);
    }
    const iso = (r) => r.map((c, i) => (typeof c === 'string' && !(r.typed && i === 2) ? isoPanelDates(c) : c));
    return { rows: rows.map(iso), lines: lines.map(iso), settings };
  }

  /**
   * Any card, read off the page. Settings cards come out as setting name and
   * value, which is what they are; the others as their lists, key/value
   * pairs, tables and lines of text, one row each.
   */
  function genericTable(card) {
    const { rows, lines, settings } = cardRows(card);
    if (!rows.length) return { columns: ['Text'], rows: lines };

    // A column nothing filled in (no sub-headings, no hints) is left out.
    const columns = ['Part', settings ? 'Setting' : 'Item', 'Value', 'Detail'];
    const keep = columns.map((c, i) => i === 1 || i === 2 || rows.some((r) => String(r[i] ?? '').trim()));
    return {
      columns: columns.filter((c, i) => keep[i]),
      rows: rows.map((r) => r.filter((c, i) => keep[i])),
    };
  }

  /* --------------------------- dedicated exporters ------------------------- */

  /** A GET the card itself would make; a lapsed session stops the export, anything else falls back. */
  async function fetchOr(url, fallback) {
    try {
      return { data: await api('GET', url), note: '' };
    } catch (err) {
      if (err?.handled) throw err;
      if (fallback === undefined) throw err;
      return { data: fallback, note: `what the page had loaded - the server said: ${err.message}` };
    }
  }

  const STAGE_WORD = { download: 'downloading', convert: 'converting', upload: 'sending', start: 'starting', wait: 'waiting for a slot', done: 'done' };
  // Stage 'wait' was only ever a place in line for a slot, until the
  // pipelines began asking for room on the disk before a job writes anything
  // (src/media/disk-space.js): that wait is stage 'wait' too, with the text
  // "waiting for disk space — it needs …", and a slot freeing does not end
  // it. "Waiting for a slot" would send whoever reads the file to the wrong
  // cause.
  const stageWord = (p) => (p?.stage === 'wait' && /^waiting for disk space\b/i.test(String(p.text ?? ''))
    ? 'waiting for disk space'
    : STAGE_WORD[p?.stage ?? 'start']);
  const SLOT_WORD = { download: 'download', convert: 'convert', upload: 'send' };

  /** "S05E04" from "American Dad! S05E04", as the panel names an episode on its buttons. */
  const episodeCodeOf = (label) => (String(label ?? '').match(/S\d+E\d+$/) ?? [String(label ?? '')])[0];

  /** "next to convert", "number 2 in line to send": a running job's place in a stage's line. */
  const lineWords = (w) => `${w.position === 1 ? 'next' : `number ${w.position} in line`} to ${SLOT_WORD[w.stage] ?? w.stage}`;

  const JOB_COLUMNS = ['Place', 'Status', 'Kind', 'Title', 'Series', 'Season', 'Episodes', 'Done', 'Running', 'Waiting',
    'Failed', 'Skipped or cancelled', 'Current episode', 'Stage', 'Progress %', 'Requester', 'Requester number',
    'Detail', 'Added', 'Started', 'Finished', 'Error'];

  /*
   * One row per request, which is what the queue sends. Asked for on
   * 2026-09-28: "if season was requested entire season should be 1 item in
   * the queue, don't need 50 episodes counting as individual queue items".
   * The queue (src/core/queue.js, _itemView) sends a film as itself and a TV
   * request - a season, or one episode asked for alone - as one item: `jobs`
   * counts its episodes (total, done, running, waiting, failed, cancelled),
   * `current` has the episodes in hand, `place` is its place in line, and
   * `next` the episode it starts on when it has none in hand. So a season is
   * one row with its counts in columns of their own, which a spreadsheet can
   * add up, and the episode in hand and its stage beside them.
   */
  function jobRow(j, { status, place = '', q = {} }) {
    const m = j.meta ?? {};
    const p = j.progress ?? {};
    const tv = (j.kind ?? m.kind) === 'tv';
    const n = j.jobs && typeof j.jobs === 'object' ? j.jobs : null;
    const running = status === 'running';
    const current = n ? asList(j.current) : [];
    // A season between two episodes, or held while the films go first, is
    // still running, with nothing in hand this minute.
    const idle = running && !!n && !current.length;
    const many = (n?.total ?? 1) > 1;

    // Blank for a film, which is not counted in episodes; numbers, zeros
    // included, for a TV request, so a column of them adds up.
    const count = (k) => (n ? Number(n[k] ?? 0) : '');
    const inHand = [...current].sort((a, b) => (a.meta?.episode ?? 0) - (b.meta?.episode ?? 0))
      .map((c) => c.meta?.episode ?? episodeCodeOf(c.label));

    let stage = '';
    if (idle) stage = q.paused ? 'paused' : 'between episodes';
    // No progress yet reads "starting", as on the Now running card.
    else if (running) stage = stageWord(p) ?? orBlank(p.stage);

    const detail = [];
    if (running && many && current.length) {
      // Each episode in hand and what it is doing, as the Now running card
      // lists them: with two TV slots one is sending while the next
      // downloads, or waits in line for the encoder.
      for (const c of current) {
        // A disk wait with its numbers, as a lone film's Detail has them.
        const word = c.progress?.stage ? stageWord(c.progress) : null;
        const doing = c.waiting ? lineWords(c.waiting)
          : word === 'waiting for disk space' ? String(c.progress.text) : word || 'starting';
        detail.push(`${episodeCodeOf(c.label)} ${doing}${c.meta?.retry ? ` (retry ${c.meta.retry})` : ''}`);
      }
    } else if (running) {
      if (p.text) detail.push(p.text);
      const line = j.line ?? j.waiting;
      if (line) detail.push(lineWords(line));
    }
    if (idle) {
      const films = (q.counts?.active?.movie ?? 0) + (q.counts?.pending?.movie ?? 0);
      if (!q.paused) detail.push(q.strictMoviePriority !== false && films ? 'waiting - films go first' : 'waiting for a free slot');
      if (j.next) detail.push(`next: ${j.next}`);
    }
    if (j.missing) detail.push(`${j.missing} more finished before the queue's recent list begins`);
    // Waiting for its retry, in no queue (src/core/queue.js holdRetry).
    if (status === 'retrying') {
      detail.push(`attempt ${j.attempt ?? '?'}${j.max ? ` of ${j.max}` : ''}`);
      const why = { delay: 'trying again shortly', connection: 'waiting for WhatsApp to reconnect', room: 'waiting for disk space' }[j.waitingFor];
      if (why) detail.push(why);
    }
    if (m.resumed) detail.push('resumed after a restart');
    if (m.beta) detail.push('beta test');

    return [place, status, tv ? 'TV' : 'Movie', j.label ?? j.groupLabel ?? '',
      tv ? orBlank(m.series) : '', tv ? orBlank(m.season) : '',
      count('total'), count('done'), count('running'), count('waiting'), count('failed'), count('cancelled'),
      inHand.join(', '), stage, running && !idle ? (p.pct ?? 0) : '',
      phone(m.requester), phone(m.requesterNumber),
      detail.join(' · '), csvWhen(j.addedAt), csvWhen(j.startedAt), csvWhen(j.finishedAt), orBlank(j.error)];
  }

  const finite = (xs) => xs.filter(Number.isFinite);
  const earliest = (...xs) => (finite(xs).length ? Math.min(...finite(xs)) : null);
  const latest = (...xs) => (finite(xs).length ? Math.max(...finite(xs)) : null);

  /*
   * The queue's recently finished jobs, one row per request too. The queue
   * keeps them a job at a time - a finished season is ten entries - so they
   * are put back together by the request each came from (`group`). A request
   * still running or waiting is left out: its done and failed episodes are
   * counted on its own row. An episode tried twice counts once, as it last
   * ended: the failed attempt stays in the list beside the retry that sent it.
   * The list goes back a fixed number of jobs, so a request can have begun
   * before it; its size ("k/N" on each episode) says how many are not in it.
   */
  function finishedRequests(history, live) {
    const out = [];
    const byGroup = new Map();
    for (const j of history) {
      if (!j.group) { out.push(j); continue; }
      if (live.has(j.group)) continue;
      let r = byGroup.get(j.group);
      if (!r) {
        const { episode, position, retry, retryKey, ...meta } = j.meta ?? {};
        r = { label: j.groupLabel ?? j.label, kind: j.kind, meta, eps: new Map(), size: 0, addedAt: j.addedAt, startedAt: j.startedAt, finishedAt: j.finishedAt };
        byGroup.set(j.group, r);
        out.push(r);
      }
      if (!r.eps.has(j.label)) r.eps.set(j.label, j);        // newest first: how it last ended
      r.size = Math.max(r.size, Number(/\/(\d+)$/.exec(String(j.meta?.position ?? ''))?.[1] ?? 0));
      r.addedAt = earliest(r.addedAt, j.addedAt);
      r.startedAt = earliest(r.startedAt, j.startedAt);
      r.finishedAt = latest(r.finishedAt, j.finishedAt);
    }
    return out.map((r) => {
      if (!r.eps) return r;
      const eps = [...r.eps.values()];
      const by = (s) => eps.filter((e) => e.state === s).length;
      const total = Math.max(r.size, eps.length);
      // Its episodes' one outcome, or "partial" when some were sent and some
      // not, as the History tab words a season that partly posted.
      const state = new Set(eps.map((e) => e.state)).size === 1 ? eps[0].state
        : by('done') ? 'partial' : by('failed') ? 'failed' : 'cancelled';
      return {
        label: r.label, kind: r.kind, meta: r.meta, addedAt: r.addedAt, startedAt: r.startedAt, finishedAt: r.finishedAt,
        state,
        jobs: { total, done: by('done'), failed: by('failed'), cancelled: eps.length - by('done') - by('failed'), running: 0, waiting: 0 },
        missing: total - eps.length,
        error: [...new Set(eps.map((e) => e.error).filter(Boolean))].join('; '),
      };
    });
  }

  async function freshQueue() {
    const { data, note } = await fetchOr('/queue', lastQueue);
    return { q: data ?? {}, note };
  }

  function queueRows(q) {
    const live = new Set([...asList(q.active), ...asList(q.pending)].map((j) => j.group).filter(Boolean));
    return {
      running: asList(q.active).map((j) => jobRow(j, { status: 'running', q })),
      retrying: asList(q.retrying).map((j) => jobRow({ ...j, addedAt: j.since }, { status: 'retrying', q })),
      waiting: asList(q.pending).map((j, i) => jobRow(j, { status: 'waiting', place: j.place ?? i + 1, q })),
      // The card's "Recently finished" list, all of what the server sends rather than its first five.
      finished: finishedRequests(asList(q.history), live).map((j) => jobRow(j, { status: j.state ?? 'finished', q })),
    };
  }

  async function exportQueue() {
    const { q, note } = await freshQueue();
    const { running, retrying, waiting, finished } = queueRows(q);
    return { columns: JOB_COLUMNS, rows: [...running, ...retrying, ...waiting, ...finished], note };
  }

  async function exportNowRunning() {
    const { q, note } = await freshQueue();
    return { columns: JOB_COLUMNS, rows: queueRows(q).running, note };
  }

  const HISTORY_COLUMNS = ['Time', 'Requested', 'Kind', 'Title', 'Year', 'Season', 'Episodes', 'Status',
    'Asked as', 'Looked up as', 'Requester', 'Requester number', 'Rating', 'Detail',
    'Nudity check', 'Checked by', 'Check note', 'Not checked because',
    'Queued (s)', 'Download (s)', 'Convert (s)', 'Send (s)', 'Work (s)', 'Request to done (s)', 'Beta'];

  function historyCsvRow(x) {
    const cc = x.contentCheck ?? {};
    const t = x.timings ?? {};
    const tv = x.kind === 'tv';
    const nudity = cc.nudity === true ? 'contains nudity' : cc.nudity === false ? 'no nudity'
      : cc.provider ? 'did not know the film' : '';
    return [csvWhen(x.at), csvWhen(x.requestedAt), tv ? 'TV' : 'Movie', x.title ?? x.request ?? '', orBlank(x.year),
      tv ? orBlank(x.season) : '', tv ? orBlank(x.episodes) : '', orBlank(x.status),
      x.typed ?? x.request ?? '', orBlank(x.request), phone(x.requester),
      phone(x.requesterNumberDisplay ?? x.requesterNumber), orBlank(x.rated), orBlank(x.detail),
      nudity, [cc.by ?? cc.provider, cc.model].filter(Boolean).join(' · '), cc.note ?? cc.basis ?? '',
      x.contentCheckSkipped ? `${x.contentCheckSkipped}${x.contentCheckSkippedWhy ? ` (${x.contentCheckSkippedWhy})` : ''}` : '',
      orBlank(t.queueWaitSec), orBlank(t.downloadSec), orBlank(t.convertSec), orBlank(t.uploadSec),
      orBlank(t.totalSec), orBlank(t.endToEndSec), x.beta ? 'yes' : ''];
  }

  /**
   * The whole history, movies and TV together, however far the panes have
   * been paged: they draw HIST_PAGE rows at a time. Asked for afresh, as the
   * tab's Refresh would; if that fails, what the page has already loaded.
   */
  async function exportHistory() {
    const loaded = [...(HISTORY.movies ?? []), ...(HISTORY.tv ?? [])].sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
    const { data, note } = await fetchOr('/history', loaded);
    return { columns: HISTORY_COLUMNS, rows: (Array.isArray(data) ? data : loaded).map(historyCsvRow), note };
  }

  const LOG_COLUMNS = ['Time', 'Level', 'Scope', 'Message'];
  const logRow = (l) => [csvWhen(l.ts, { seconds: true }), orBlank(l.level), orBlank(l.scope), orBlank(numbersIn(l.msg))];

  /** The live log as it is shown: the same filter box and level as renderLog(). */
  function exportLiveLog() {
    const q = String($('log-filter')?.value ?? '').toLowerCase();
    const min = $('log-level')?.value ?? '';
    const minRank = min ? LEVEL_RANK[min] : -1;
    const shown = logLines.filter((l) => {
      if (minRank >= 0 && LEVEL_RANK[l.level] < minRank) return false;
      if (min === 'error' && l.level !== 'error') return false;
      if (q && !textMatch(`${l.scope} ${l.msg}`, q)) return false;
      return true;
    });
    return { columns: LOG_COLUMNS, rows: shown.map(logRow) };
  }

  /** The dashboard's mirror draws the last 40 lines; the file has every line the page holds. */
  function exportDashLog() {
    return { columns: LOG_COLUMNS, rows: logLines.map(logRow) };
  }

  /** Every audit entry the filters on the card match, not the 300 it draws: the API pages by 1000. */
  async function exportAudit() {
    const params = new URLSearchParams();
    if (AUDIT_CAT && AUDIT_CAT !== 'all') params.set('category', AUDIT_CAT);
    if (AUDIT_WHO) params.set('user', AUDIT_WHO);
    const q = String($('audit-search')?.value ?? '').trim();
    if (q) params.set('q', q);
    params.set('limit', '1000');
    const events = [];
    for (let page = 0; page < 100; page++) {
      params.set('offset', String(events.length));
      const d = await api('GET', `/audit?${params}`);
      const evs = Array.isArray(d) ? d : asList(d?.events);
      events.push(...evs);
      if (Array.isArray(d) || evs.length < 1000 || events.length >= (d?.total ?? 0)) break;
    }
    return {
      columns: ['Time', 'Admin', 'Role', 'Action', 'Detail'],
      rows: events.map((e) => [csvWhen(e.ts, { seconds: true }), orBlank(e.user), orBlank(e.role),
        orBlank(numbersIn(e.action)), e.detail && e.detail !== e.action ? numbersIn(e.detail) : '']),
    };
  }

  async function exportMisses() {
    const params = new URLSearchParams();
    if (MISS_FILTER === 'movie' || MISS_FILTER === 'tv') params.set('kind', MISS_FILTER);
    if (MISS_FILTER === 'open') params.set('resolved', '0');
    const q = String($('miss-search')?.value ?? '').trim();
    if (q) params.set('q', q);
    const d = await api('GET', `/library-misses?${params}`);
    let misses = asList(d?.misses);
    if (MISS_FILTER === 'resolved') misses = misses.filter((m) => m.resolved);
    const why = (r) => d?.reasons?.[r] ?? r ?? '';
    return {
      columns: ['Last asked', 'First asked', 'Kind', 'Title', 'Year', 'Season', 'Episode', 'Asked as', 'Why',
        'Times asked', 'Requesters', 'Turned up later', 'Detail', 'What the lookup did'],
      rows: misses.map((m) => [csvWhen(m.lastAt), csvWhen(m.firstAt), m.kind === 'tv' ? 'TV' : 'Movie',
        orBlank(m.title), orBlank(m.year), orBlank(m.season), orBlank(m.episode), orBlank(m.request),
        why(m.reason), orBlank(m.count), (m.requesters ?? []).map(phone).join(', '),
        m.resolved ? `yes${m.resolvedAt ? `, ${csvWhen(m.resolvedAt)}` : ''}` : '', orBlank(m.detail),
        (m.diagnostics ?? []).join(' | ')]),
    };
  }

  // The open list and the resolved section under it, one row a film, with
  // who resolved it and when, and every note: the card's whole state, as the
  // operator asked for it on 2026-10-11 ("mark as resolved ... a box to add
  // notes").
  async function exportWanted() {
    const d = await api('GET', '/wanted');
    const noteText = (n) => `${orBlank(n.by)} ${csvWhen(n.at)}: ${orBlank(n.text)}`;
    return {
      columns: ['Title', 'Year', 'IMDb', 'Rating', 'Why', 'Times asked', 'First asked', 'Last asked', 'Requesters',
        'Resolved', 'Resolved by', 'Resolved at', 'Notes'],
      rows: [...asList(d?.wanted), ...asList(d?.resolved)].map((w) => [orBlank(w.title), orBlank(w.year), orBlank(w.imdbId),
        orBlank(w.rated), w.reason === 'not-yet-theatrical' ? 'still in cinemas' : 'not in the library', orBlank(w.count),
        csvWhen(w.firstAt), csvWhen(w.lastAt), (w.requesters ?? []).map(phone).join(', '),
        !!w.resolved, orBlank(w.resolved?.by), csvWhen(w.resolved?.at), asList(w.notes).map(noteText).join(' | ')]),
    };
  }

  async function exportTransfers() {
    // A transfer is a file, so a season is the episodes it has in hand, as
    // the card shows them - not one row for the season with one of their bars.
    const files = asList(lastQueue?.active).flatMap((j) => (j.jobs ? asList(j.current) : [j]));
    const live = files.map((j) => {
      const p = j.progress ?? {};
      return ['in progress', '', j.label ?? '', '', (p.stage && stageWord(p)) || orBlank(p.stage),
        phone(j.meta?.requester), p.totalBytes ? fmtBytes(p.totalBytes) : '', orBlank(p.totalBytes), '',
        '', orBlank(p.bytesPerSec), '', '', '', p.pct ?? 0, ''];
    });
    const done = asList(await api('GET', '/transfers'));
    return {
      columns: ['State', 'Finished', 'Title', 'Year', 'What was done', 'Requester', 'Size', 'Size (bytes)',
        'Original size (bytes)', 'Download (s)', 'Average speed (bytes/s)', 'Convert (s)', 'Send (s)',
        'Total (s)', 'Progress %', 'File'],
      rows: [...live, ...done.map((t) => ['done', csvWhen(t.at), orBlank(t.title), orBlank(t.year),
        `${t.action ?? ''}${t.access === 'local' ? ' (read in place)' : ''}`, phone(t.requester),
        t.bytes ? fmtBytes(t.bytes) : '', orBlank(t.bytes), orBlank(t.sourceBytes), orBlank(t.downloadSec),
        orBlank(t.avgBytesPerSec), orBlank(t.convertSec), orBlank(t.uploadSec), orBlank(t.totalSec), '',
        orBlank(t.file)])],
    };
  }

  async function exportLogFiles() {
    const files = asList(await api('GET', '/logs/files'));
    return {
      columns: ['File', 'Size', 'Size (bytes)', 'Compressed', 'Last written'],
      rows: files.map((f) => [f.name, fmtBytes(f.size), orBlank(f.size), yes(f.gzipped), csvWhen(f.mtime)]),
    };
  }

  const GROUP_EVENT = { add: 'joined/added', remove: 'left/removed', promote: 'promoted to admin', demote: 'demoted', 'join-request': 'requested to join' };

  async function exportGroupActivity() {
    const evs = asList(await api('GET', '/group-activity'));
    return {
      columns: ['Time', 'What happened', 'Who', 'Group', 'By'],
      rows: evs.map((e) => [csvWhen(e.ts, { seconds: true }), GROUP_EVENT[e.action] ?? orBlank(e.action),
        (e.targets ?? []).map((t) => (t.number ? `+${t.number}` : t.jid)).filter(Boolean).join(', '),
        orBlank(e.groupName), e.actorNumber ? `+${e.actorNumber}` : '']),
    };
  }

  function exportGroups() {
    return {
      columns: ['Group', 'Members', 'Group id', 'Beta', 'Private'],
      rows: GROUPS.map((g) => [orBlank(g.subject), orBlank(g.size), orBlank(g.jid), htmlText(betaPill(g.jid)), g.private ? 'yes' : '']),
    };
  }

  /**
   * The group open in the Groups tab: whether it is admins-only, its
   * description and whether the bot can edit it, then its members with the
   * filter applied as renderMembers() applies it. The first version wrote the
   * members alone, which left out the two things the card is mostly opened
   * for.
   */
  function exportGroupMembers() {
    const q = String($('ga-member-filter')?.value ?? '').toLowerCase();
    const d = phoneDigits(q);
    const members = (window._gaMembers ?? [])
      .filter((m) => !q || (m.number || '').includes(q) || (m.id || '').toLowerCase().includes(q)
        || (!!d && (m.number || '').includes(d)));
    const muted = new Set((CONFIG?.movieRequests?.notify?.noTag ?? []).map((x) => String(x).replace(/[^0-9]/g, '')));
    const group = textOf($('ga-name'));
    const about = [
      ['Posting', textOf($('ga-lock-state')).replace(/^[^\p{L}\p{N}]+/u, ''), textOf($('ga-lock-note'))],
      ['Description', String($('ga-desc')?.value ?? ''), ''],
      ['Bot', textOf($('ga-adminwarn')).replace(/^[^\p{L}\p{N}]+/u, ''), ''],
      ['Members', orBlank(window._gaMembers?.length), q ? `${members.length} match the filter "${q}"` : ''],
    ].filter(([, value]) => String(value).trim() && value !== '…');
    return {
      columns: ['Group', 'Part', 'Item', 'Value', 'Detail', 'Number', 'WhatsApp id', 'Role', 'Not tagged'],
      rows: [
        ...about.map(([item, value, detail]) => [group, 'Group', item, value, detail, '', '', '', '']),
        ...members.map((m) => [group, 'Member', '', '', '', m.number ? `+${m.number}` : '', orBlank(m.id),
          m.admin === 'superadmin' ? 'owner' : m.admin === 'admin' ? 'admin' : 'member',
          m.number && muted.has(m.number) ? 'yes' : '']),
      ],
    };
  }

  /**
   * The Group lockdown card: whether the groups are locked now and why, the
   * automatic-lockdown settings, the always-locked groups, and the schedule.
   * The first version wrote the schedule alone, so a file sent to ask "why
   * is the group still locked?" never said that it was, or that someone had
   * locked it by hand.
   *
   * The schedule is from the data, in New York and Jerusalem time both - the
   * card shows New York and adds Jerusalem in brackets - so "when do the
   * groups close over Sukkos" can be answered by whoever it is sent to. The
   * rest is read off the card, as the generic exporter would.
   */
  async function exportLockdown(card) {
    const st = (await api('GET', '/lockdown/status')) ?? {};
    const NY = 'America/New_York';
    const JLM = 'Asia/Jerusalem';
    const now = Date.now();
    const times = (lockAt, unlockAt) => [csvWhenIn(lockAt, NY), csvWhenIn(unlockAt, NY), csvWhenIn(lockAt, JLM),
      csvWhenIn(unlockAt, JLM), lockAt && unlockAt ? Math.round((new Date(unlockAt) - new Date(lockAt)) / 3600000) : ''];
    const noTimes = ['', '', '', '', '', ''];
    const rows = [
      ['Status', 'Groups', st.locked ? 'locked' : 'open',
        { manual: 'by hand', schedule: 'by the schedule' }[st.source] ?? orBlank(st.source), ...noTimes],
      ['Status', 'Automatic lockdown', st.enabled ? 'on' : 'off', '', ...noTimes],
    ];
    const reopened = st.window?.reopened;
    if (reopened?.unlockAt) {
      rows.push(['Status', 'Reopened', '', `while it is still ${reopened.yomTov ? 'Shabbos / yom tov' : 'Shabbos'} in New York,`
        + ` until ${csvWhenIn(reopened.nyHolyUntil, NY)}`, ...times(reopened.lockAt, reopened.unlockAt), reopened.yomTov ? 'yes' : '']);
    }
    for (const [part, name, value, detail] of cardRows(card, { omit: '#lock-status, #lock-upcoming, #lock-cities-hint' }).rows) {
      rows.push([part || 'Note', name, value, detail, ...noTimes]);
    }
    let list = asList(st.upcoming);
    if (!list.length && st.nextLockAt && st.nextUnlockAt) {
      list = [{ lockAt: st.nextLockAt, unlockAt: st.nextUnlockAt, label: st.label, yomTov: false }];
    }
    for (const b of list) {
      const note = [];
      if (new Date(b.lockAt).getTime() <= now) note.push(st.locked ? 'locked now' : 'in progress');
      if (b.nyHolyUntil) note.push(`reopens while it is still Shabbos or yom tov in New York, until ${csvWhenIn(b.nyHolyUntil, NY)}`);
      rows.push(['Schedule', orBlank(b.label), '', note.join('; '), ...times(b.lockAt, b.unlockAt), b.yomTov ? 'yes' : '']);
    }
    return {
      columns: ['Part', 'Item', 'Value', 'Detail', 'Lock (New York)', 'Unlock (New York)', 'Lock (Jerusalem)',
        'Unlock (Jerusalem)', 'Hours', 'Yom tov'],
      rows,
    };
  }

  /** Everyone across every group, filtered and ordered as the list is, without its 100-row pages. */
  function exportRoster() {
    const q = String($('mr-filter')?.value ?? '').toLowerCase().trim();
    const sort = $('mr-sort')?.value;
    const d = phoneDigits(q);
    let list = ROSTER.filter((m) => !q
      || memberLabel(m).toLowerCase().includes(q)
      || (m.number || '').includes(q)
      || (!!d && (m.number || '').includes(d))
      || (m.id || '').toLowerCase().includes(q)
      || (m.groups ?? []).some((g) => String(g.subject ?? '').toLowerCase().includes(q)));
    const cmp = {
      active: (a, b) => b.msgCount - a.msgCount || b.groupCount - a.groupCount,
      groups: (a, b) => b.groupCount - a.groupCount || b.msgCount - a.msgCount,
      admin: (a, b) => b.adminCount - a.adminCount || b.groupCount - a.groupCount,
      recent: (a, b) => (b.lastSeen || 0) - (a.lastSeen || 0),
      name: (a, b) => memberLabel(a).localeCompare(memberLabel(b)),
    }[sort];
    if (cmp) list = [...list].sort(cmp);
    return {
      columns: ['Name', 'Number', 'WhatsApp id', 'Groups', 'Admin roles', 'Messages', 'First seen', 'Last seen',
        'Admin in', 'Member of'],
      rows: list.map((m) => [orBlank(m.name), m.number ? `+${m.number}` : '', orBlank(m.id), orBlank(m.groupCount),
        orBlank(m.adminCount), orBlank(m.msgCount), csvWhen(m.firstSeen), csvWhen(m.lastSeen),
        (m.groups ?? []).filter((g) => g.admin).map((g) => g.subject).join('; '),
        (m.groups ?? []).map((g) => g.subject).join('; ')]),
    };
  }

  // The member page is drawn from a key the page does not otherwise keep, so
  // the last one opened is noted on the way through.
  let memberKey = null;
  if (typeof window.openMember === 'function') {
    const open = window.openMember;
    window.openMember = (key, ...rest) => { memberKey = key; return open(key, ...rest); };
  }

  async function exportMember() {
    if (!memberKey) return null;
    const d = await api('GET', `/members/${encodeURIComponent(memberKey)}/detail`);
    const per = d.perGroup ?? {};
    const rows = [
      ['Member', 'Name', d.name ?? memberLabel(d), ''],
      ['Member', 'Number', d.number ? `+${d.number}` : 'not visible (LID only)', ''],
      ['Member', 'WhatsApp id', orBlank(d.id), ''],
      ['Member', 'Groups', orBlank(d.groupCount), ''],
      ['Member', 'Admin roles', orBlank(d.adminCount), ''],
      ['Member', 'Messages', orBlank(d.msgCount), ''],
      ['Member', 'First seen', csvWhen(d.firstSeen), ''],
      ['Member', 'Last seen', csvWhen(d.lastSeen), ''],
      ['Member', 'Banned', yes(d.banned), ''],
      ['Member', 'Never tagged', yes(d.noTag), ''],
      ...(d.groups ?? []).map((g) => {
        const a = per[g.jid];
        return ['Group', orBlank(g.subject), g.admin ? `${g.admin}` : 'member',
          a ? `${a.count} message${a.count === 1 ? '' : 's'}, last ${csvWhen(a.lastSeen)}` : ''];
      }),
      ...(d.timeline ?? []).map((t) => ['Joined / left', csvWhen(t.ts), orBlank(t.action),
        `${t.groupName ?? ''}${t.by ? ` · by ${t.by}` : ''}`]),
    ];
    return { columns: ['Part', 'Item', 'Value', 'Detail'], rows };
  }

  async function exportBanned() {
    const list = asList(await api('GET', '/banned'));
    return { columns: ['Number'], rows: list.map((n) => [`+${String(n).replace(/[^0-9]/g, '')}`]) };
  }

  /** Who can sign in. Never a password or a hash: the route that lists them has neither. */
  async function exportAdmins() {
    const r = (await api('GET', '/admins')) ?? {};
    const def = r.defaultIdleMinutes ?? 15;
    const words = (m) => (m === 0 ? 'never' : `${m} min`);
    return {
      columns: ['Admin', 'Role', 'Last signed in', 'Sign-out after'],
      rows: asList(r.admins).map((a) => [orBlank(a.username), a.role === 'superadmin' ? 'super-admin' : 'admin',
        a.lastLogin ? csvWhen(a.lastLogin) : 'never',
        a.idleTimeoutMinutes === null || a.idleTimeoutMinutes === undefined
          ? `default (${words(def)})` : words(a.idleTimeoutMinutes)]),
    };
  }

  async function exportAccounts() {
    const { data, note } = await fetchOr('/wa/accounts', { accounts: FRESH.accounts ?? [] });
    return {
      columns: ['Name', 'Number', 'In use', 'Linked'],
      rows: asList(data?.accounts).map((a) => [orBlank(a.label), phone(a.phoneNumber), yes(a.active), yes(a.linked)]),
      note,
    };
  }

  /**
   * The AI providers, from the card's working copy. A key is only ever the
   * mask or blank: a key typed into a row and not saved lives in `_key`, which
   * is never read here.
   */
  async function exportAiProviders() {
    if (!AI) await loadAiProviders();
    if (!AI) return null;
    readAiForm();
    const byId = new Map(AI.providers.map((p) => [p.id, p]));
    const rows = AI.order.map((id, i) => {
      const p = byId.get(id);
      if (!p) return null;
      const g = id === 'gemini';
      return [i + 1, orBlank(p.label), yes(p.enabled),
        (g ? CONFIG?.gemini?.apiKey : p.apiKey) ? MASK : '',
        (g ? CONFIG?.gemini?.model : p.model) || 'Automatic', orBlank(p.autoModel),
        yes(p.canClearRated), htmlText(aiStatusPill(p.status)), orBlank(p.status?.headline)];
    }).filter(Boolean);
    return {
      columns: ['Order', 'Provider', 'Asked', 'API key', 'Model', 'Automatic would pick', 'May clear rated films',
        'Status', 'Status detail'],
      rows,
    };
  }

  function exportFreshInstall() {
    const items = freshInstallChecklist(freshInstallContext());
    return {
      columns: ['Needed', 'Status', 'Step', 'Why', 'Note', 'Where'],
      rows: items.map((it) => [it.required ? 'required' : 'optional', FIC_MARK[it.status]?.[1] ?? it.status,
        orBlank(it.label), orBlank(it.why), orBlank(it.note), freshInstallWhere(it.tab, it.target).where]),
    };
  }

  function exportKeyLogins() {
    return {
      columns: ['Login', 'State', 'Set up', 'What it is for'],
      rows: keyLoginRows().map((r) => [r.what, r.state, yes(r.ok), r.sub]),
    };
  }

  function exportCatalogue() {
    const q = String($('cat-search')?.value ?? '').trim().toLowerCase();
    const rows = q ? CATALOGUE.filter((m) => String(m.title ?? '').toLowerCase().includes(q)) : CATALOGUE;
    return { columns: ['Title', 'Year', 'Rating'], rows: rows.map((m) => [orBlank(m.title), orBlank(m.year), orBlank(m.rated)]) };
  }

  function exportReactions(card) {
    const rows = [];
    let when = '';
    for (const el of card.querySelector('#reaction-guide')?.children ?? []) {
      if (el.classList.contains('rg-sec')) when = textOf(el);
      else if (el.classList.contains('rg-row')) rows.push([when, textOf(el.querySelector('.rg-emoji')), textOf(el.querySelector('.rg-label'))]);
    }
    return { columns: ['When', 'Reaction', 'Meaning'], rows };
  }

  /** The connection as the page last heard it. The pairing code and QR stay out: they link a device to the number. */
  function exportConnection() {
    const s = lastStatus ?? {};
    const a = s.account ?? {};
    const rows = [
      ['State', textOf($('conn-state'))],
      ['Detail', textOf($('conn-detail'))],
      ['Connected as', orBlank(s.me?.name)],
      ['Number', s.me?.id ? `+${String(s.me.id).split(/[:@]/)[0]}` : ''],
      ['Groups', orBlank(s.groupCount)],
      ['Account', orBlank(a.label)],
      ['Account number', phone(a.phoneNumber)],
      ['Account linked', a.label ? yes(a.linked) : ''],
      ['Reconnect attempts', orBlank(s.reconnectAttempts)],
      ['Next attempt', csvWhen(s.nextReconnectAt, { seconds: true })],
      ['Last error', orBlank(s.lastError)],
    ].filter(([, v]) => String(v).trim());
    return { columns: ['Item', 'Value'], rows };
  }

  /**
   * Cards with a data model behind them, found by an element only that card
   * holds - the Queue card has no id of its own. Anything not listed here,
   * including a card added later, gets genericTable().
   */
  const EXPORTERS = [
    { test: (c) => c.id === 'card-conn', slug: 'whatsapp-connection', run: exportConnection },
    { sel: '#activity', slug: 'now-running', run: exportNowRunning },
    { sel: '#queue-list', slug: 'queue', run: exportQueue },
    { sel: '#reaction-guide', slug: 'reactions', run: exportReactions },
    { sel: '#dash-log', slug: 'recent-activity', run: exportDashLog },
    { sel: '#dash-history', slug: 'recent-requests', run: exportHistory },
    { sel: '#fic-list', slug: 'fresh-install-checklist', run: exportFreshInstall },
    { sel: '#ai-list', slug: 'ai-providers', run: exportAiProviders },
    { sel: '#ak-logins', slug: 'logins', run: exportKeyLogins },
    { sel: '#wa-accounts', slug: 'whatsapp-numbers', run: exportAccounts },
    { sel: '#cat-list', slug: 'clean-title-catalogue', run: exportCatalogue },
    { sel: '#ga-list', slug: 'groups', run: exportGroups },
    { sel: '#ga-members', slug: () => `group-${csvSlug(textOf($('ga-name')))}`.replace(/-section$/, ''), run: exportGroupMembers },
    { sel: '#lock-status', slug: 'group-lockdown', run: exportLockdown },
    { sel: '#ga-activity', slug: 'group-activity', run: exportGroupActivity },
    { sel: '#history-list', slug: 'history', run: exportHistory },
    { sel: '#wanted-list', slug: 'wanted', run: exportWanted },
    { sel: '#mr-list', slug: 'members', run: exportRoster },
    { test: (c) => c.parentElement?.id === 'mr-detail', slug: 'member', run: exportMember },
    { sel: '#banned-list', slug: 'banned-numbers', run: exportBanned },
    { sel: '#admins-list', slug: 'admins', run: exportAdmins },
    { sel: '#audit-list', slug: 'audit-log', run: exportAudit },
    { sel: '#miss-list', slug: 'not-in-library', run: exportMisses },
    { sel: '#transfer-history', slug: 'transfers', run: exportTransfers },
    { sel: '#log-out', slug: 'live-log', run: exportLiveLog },
    { sel: '#logfiles', slug: 'saved-debug-logs', run: exportLogFiles },
  ];

  /*
   * Exporters other scripts bring for their own cards - the hook. A card's
   * own script knows its data where this file can only read the card: the
   * Hourly checks card (hourly-checks.js) has every run the server keeps,
   * while its screen folds a quiet night into one line. So it hands the
   * shared button its exporter, and the button in the heading stays the
   * card's one CSV control. That card was first written with a "Download
   * CSV" button of its own, and once merged it had two, saving different
   * files: one in the browser's date format with lower-case headings and no
   * secret sweep, one read off the screen.
   *
   *   (window.panelCsvExporters ||= []).push({ sel: '#hc-list', slug: 'hourly-checks', run: () => ({ columns, rows }) });
   *
   * That line works whether the script loads before this file or after it.
   * `sel` names an element only that card holds (or `test(card)` picks the
   * card), `run(card)` returns { columns, rows, note? } or a promise of them,
   * and `slug`, if given, names the file. The rows go through the same
   * serializer as every other card's - a Date in a cell is written
   * YYYY-MM-DD HH:mm - and a registered exporter wins over the ones above.
   * If it throws, the card is read off the page instead, as for any other.
   */
  const REGISTERED = [];
  function register(...xs) {
    for (const x of xs) {
      if (!x || typeof x.run !== 'function' || (typeof x.sel !== 'string' && typeof x.test !== 'function')) {
        console.warn('CSV export: an exporter needs run() and a sel or a test(card); this one is ignored', x);
        continue;
      }
      REGISTERED.push(x);
    }
    return REGISTERED.length;
  }
  register(...(Array.isArray(window.panelCsvExporters) ? window.panelCsvExporters : []));
  window.panelCsvExporters = { push: register };

  const fits = (card) => (x) => (x.test ? x.test(card) : owns(card, x.sel));
  const exporterFor = (card) => REGISTERED.find(fits(card)) ?? EXPORTERS.find(fits(card)) ?? null;
  const slugOf = (x, card) => csvSlug((typeof x.slug === 'function' ? x.slug(card) : x.slug) || cardTitle(card));

  /**
   * The table for a card. A dedicated exporter that fails for any reason but
   * a lapsed session - a route that answers 503 while WhatsApp is down, a
   * name app.js no longer has - falls back to what the card shows, and says
   * so, rather than leave the button doing nothing.
   */
  async function tableFor(card) {
    const x = exporterFor(card);
    if (x) {
      const slug = slugOf(x, card);
      try {
        const t = await x.run(card);
        if (t) return { slug, note: '', ...t };
      } catch (err) {
        if (err?.handled) throw err;
        console.warn(`CSV export: the ${slug} exporter failed (${err?.message}); using what the card shows`);
        return { slug, ...genericTable(card), note: `what the card shows - ${err?.message ?? 'the full list could not be read'}` };
      }
    }
    return { slug: csvSlug(cardTitle(card)), note: '', ...genericTable(card) };
  }

  /** The finished file for a card, without downloading it. */
  async function csvFor(card, now = new Date()) {
    const t = await tableFor(card);
    return { ...t, filename: csvFilename(t.slug, now), text: toCsv(t.columns, t.rows) };
  }

  async function exportCard(card, btn) {
    if (btn?.getAttribute('aria-busy') === 'true') return null;
    btn?.setAttribute('aria-busy', 'true');
    const title = cardTitle(card) || 'this section';
    try {
      const out = await csvFor(card);
      if (!out.rows.length) {
        toast(`Nothing to export in ${title} yet`);
        return out;
      }
      downloadCsv(out.filename, out.text);
      toast(`${out.filename} — ${out.rows.length} row${out.rows.length === 1 ? '' : 's'}${out.note ? ` (${out.note})` : ''}`, !!out.note);
      return out;
    } catch (err) {
      if (!err?.handled) {
        console.warn(`CSV export of "${title}" failed: ${err?.message}`);
        toast(`Could not export ${title}: ${err?.message}`, true);
      }
      return null;
    } finally {
      btn?.removeAttribute('aria-busy');
    }
  }

  /* ------------------------------ the button ------------------------------- */

  /**
   * Put the button in a card's heading, once.
   *
   * It has no text of its own - "CSV" is drawn by style.css - and no id, on
   * purpose. The heading's text is how the panel names a card: the collapse
   * state saved in localStorage is keyed on it (cardId), and the search index,
   * the Settings filter and the fresh-install checklist all read it. A word
   * added to every heading would have renamed every card, forgotten every
   * folded one and made "csv" match the whole Settings tab; button[id] is what
   * the search indexes as an action. The collapse click ignores buttons, and
   * the jump-nav chip drops them, so neither changes either.
   */
  function ensureButton(card) {
    const had = card.__csvButton;
    if (had && had.isConnected && ownCard(had) === card) return had;
    const found = [...card.querySelectorAll('.csv-btn')].find((b) => ownCard(b) === card);
    if (found) { card.__csvButton = found; return found; }
    const head = headerOf(card);
    const btn = document.createElement('button');
    btn.setAttribute('type', 'button');
    btn.className = 'btn tiny csv-btn';
    btn.setAttribute('aria-label', 'Download as CSV');
    btn.setAttribute('title', 'Download this section as a CSV file');
    // Pushed to the right edge of the heading, unless something there - a
    // Refresh button, an "open full log →" link - already is.
    const pushed = [...head.children].some((el) => el.classList.contains('card-link')
      || /margin-left\s*:\s*auto/.test(el.getAttribute('style') ?? ''));
    if (head.tagName === 'H2' && !pushed) btn.classList.add('csv-push');
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      exportCard(card, btn);
    });
    head.appendChild(btn);
    card.__csvButton = btn;
    return btn;
  }

  function injectAll() {
    for (const card of document.querySelectorAll('.card')) ensureButton(card);
  }

  injectAll();
  // Cards the panel builds while it runs - the member page on the Members tab,
  // anything added later - get theirs as they appear. The log redraws on
  // every line, so a burst of changes is one pass, not one per change.
  if (typeof window.MutationObserver === 'function' && document.body) {
    let queued = false;
    new window.MutationObserver(() => {
      if (queued) return;
      queued = true;
      setTimeout(() => { queued = false; injectAll(); }, 0);
    }).observe(document.body, { childList: true, subtree: true });
  }

  // For the tests, and for anyone poking at it from the browser console.
  window.panelCsv = {
    csvCell, toCsv, csvWhen, csvWhenIn, csvSlug, csvFilename, scrubSecrets, isSecretField,
    genericTable, tableFor, csvFor, exportCard, exporterFor, injectAll, downloadCsv, MASK,
    register, isoPanelDates, queueRows,
  };
})();
