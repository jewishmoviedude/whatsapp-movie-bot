/* Settings, and every control in the panel that takes you somewhere: each
   does something you can see, and nothing sits on top of one.
   Run: node test/settings-reach.test.mjs

   Reported from the live panel, a week after the Dashboard's chips were fixed:
   "certain buttons in the panel not reacting in the settings tab". Every
   control on the tab was then pressed with a real pointer in headless
   Chromium, at 1280x800 and on a 390x844 touch screen. These turned up, the
   last three when the first fixes were reviewed the same way.

   - The group chips. Each switched its group, and nothing on the screen moved.
     The fresh-install checklist sits above every group and, on a box that is
     set up, runs to thirty-odd rows - 2,500 px on a desktop, nearly 4,000 on a
     phone. A chip scrolled to the top of the tab, which is the checklist, and
     the group it had just shown began two or three screens further down. All
     ten group chips, on both screens, from the top of the tab and from half
     way down a group.
   - The sticky bars were pinned at fixed heights that the header no longer
     had: 66 px on a desktop against the 53 assumed, and 143 px on a phone,
     where it wraps. Scrolled, the phone's tabs and its "Save settings" were
     underneath the header, so a tap on Save landed on the search box. The chip
     row was pinned at the very top, over the header, and covered the header's
     own search results where they crossed it.
   - The clean-title catalogue card was in no settings group, so it showed
     under every one and no chip led to it.
   - A second press of a Save or a Test wrote, word for word, the answer that
     was already there - "saved" over "saved", the same verdict, the same
     refusal - and the "saving…" in between lasts one round trip. Nothing on
     the screen changed. On a phone the toast from the last press also sat
     over the button at the bottom of the screen for three seconds.
   - On a phone the AI providers row for Gemini, whose pill read "daily quota
     used up — asked last until 07:00", was 51 px wider than the screen. Its
     ▲ ▼ sat past the right edge, and the whole page scrolled sideways. The
     first fix squeezed every row's title instead, which left "he" of the
     admin "helper" under its Activity button; now the buttons drop below.
   - Every link that lands on a field - the checklist's rows, the "API keys &
     logins 🔑 →" pointers left where a key used to be, the header's search
     results - did nothing once the page was scrolled, and a chip did nothing
     when pressed within a second of opening the tab. Chromium drops an
     element's smooth scrollIntoView() called from an ordinary task while a
     smooth window.scrollTo() is still moving the page, and stops that one
     too; opening a tab starts one to the top, and the link's landing came
     60 ms later. Measured in headless Chromium (Chromium 129, 1280x800 and
     390x844): with a smooth scroll to the top started 30, 120 or 400 ms
     earlier, a smooth scrollIntoView() from a timer was lost every time, the
     same call from a requestAnimationFrame callback landed every time, and a
     smooth window.scrollTo() landed either way. That rule is modelled below,
     so these tests fail on code that scrolls the old way.
   - Enter in the find box, or in the header's search, left the page where it
     was even with nothing else scrolling: the field was focused just after
     its smooth scroll began, and focus moving out of a text box stops one
     that is under way (measured the same way, modelled the same way).
   - The header's search offered "🔒 Lock (admins only)" from the group card
     while no group was open; picking it showed nothing at all.

   Then everything in the rest of the panel whose job is to take you
   somewhere or show you something was pressed the same way, on every tab -
   tabs, chips, links, search results, Manage and back, a member's row and
   close, View - from the top of a page, from half-way down it and within a
   second of switching tab. These turned up:

   - A tab opened wherever the last one had been left. Only Settings went to
     its top: pressed from 4,000 px down Settings, Groups, Members, History,
     Logs and the Dashboard each opened 4,000 px down their own page.
   - The Checklist chip, pressed within a second of opening Settings from a
     scrolled page, stopped the page where it was, 1,800 px down. Chromium
     drops a smooth scrollIntoView() even from an animation frame when it
     would end where the scroll under way is already going - here, the top -
     and on a phone, tapped during a smooth scroll, it landed 0 times in 20
     wherever it was going. The panel no longer lands with scrollIntoView()
     at all: it works out where the page must be and asks window.scrollTo(),
     which landed in every case measured (194 of 194). The model below holds
     the desktop's rules, and the source check forbids scrollIntoView().
   - A member's details, opened from further down the list, came up with the
     name behind the tabs: only cards and groups kept clear of the bars.
   - View, on a saved log, opened the log below the bottom of the screen.
   - "← back" on a group only hid its card, and the lockdown card came up in
     its place; "✕ close" on a member left the page at the top of the list,
     not at the row it had come from.
   - Manage on a group whose name has an apostrophe threw a syntax error.
   - On a phone, a link that switched tab or settings group lit a tab or a
     chip off the edge of its row.

   A review of that sweep pressed what it had not: every admin's Activity,
   not just the first. On a phone with three admins the third admin's trail
   opened below the bottom of the screen, on a tab too short to scroll it up,
   and Activity looked like it did nothing. The same review broke the fixes
   one at a time and found landings nothing here checked, now checked below:
   a search result inside a list of groups that scrolls by itself, a chip on
   a folded card, "← back" once the group has gone from the list, a jump into
   another settings group in a browser that stores nothing, and a jump to
   something that is not on the page at all.

   It runs the REAL app.js against the REAL index.html and style.css in
   linkedom. linkedom does no layout, so the geometry a browser would measure
   is given to it here, and scrolling is recorded rather than done. */
import fs from 'node:fs';
import { parseHTML } from 'linkedom';
import { DEFAULT_CONFIG } from '../src/config/schema.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const app = fs.readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../src/web/public/index.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../src/web/public/style.css', import.meta.url), 'utf8');

/**
 * The panel, with a pretend layout. `tops` gives an element's distance from
 * the top of the PAGE by selector, `heights` its height, and `sticky` which
 * elements the stylesheet makes sticky - what getComputedStyle would say.
 * `scrollers` names boxes that scroll on their own (overflow-y: auto), with
 * how tall they show and how tall their contents run: what is inside one
 * moves up by however far it has been scrolled. `storage: 'refused'` is a
 * browser that will not store anything - a private window, blocked site data.
 */
function loadPanel({ innerHeight = 800, tops = {}, heights = {}, lefts = {}, widths = {}, sticky = [], scrollers = {}, storage = 'kept', answers = {} } = {}) {
  const { document, window } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);

  // Fake timers, run in due order. Each timer, each animation frame and each
  // press() is a task of its own, which is what the scroll rule below needs.
  let now = 0, seq = 0, inFrame = false;
  const timers = new Map();
  const setTimeout = (fn, ms = 0) => { const id = ++seq; timers.set(id, { id, fn, at: now + (Number(ms) || 0) }); return id; };
  const clearTimeout = (id) => { timers.delete(id); };
  const next = () => [...timers.values()].sort((a, b) => a.at - b.at || a.id - b.id)[0];
  const run = (t) => { timers.delete(t.id); now = t.at; startTask(); t.fn(); };
  const flush = () => { for (let n = 0; timers.size && n < 500; n++) run(next()); };
  /** Run what falls due in the next `ms` - a person pressing something part-way through. */
  const runFor = (ms) => {
    const end = now + ms;
    for (let n = 0; n < 500; n++) { const t = next(); if (!t || t.at > end) break; run(t); }
    now = end;
  };
  let frame = [];
  const requestAnimationFrame = (fn) => {
    frame.push(fn);
    if (frame.length === 1) {
      setTimeout(() => {
        const due = frame; frame = [];
        inFrame = true;
        try { due.forEach((f) => f()); } finally { inFrame = false; }
      }, 16);
    }
    return frame.length;
  };

  // On screen unless something up the tree is display:none: the class rules
  // this panel hides things with, and an inactive tab.
  const drawn = (el) => !el.closest('.hidden, .panel:not(.active)');
  window.HTMLElement.prototype.getClientRects = function getClientRects() { return drawn(this) ? [{}] : []; };

  // Where things are. `tops` pins an element's distance from the top of the
  // page, by selector. Anything not pinned gets a place of its own further
  // down (from 100,000 px, 100 apart), so that a scroll to a number can be
  // told apart from any other: landing() works out which element it was for.
  const pinned = (map, el) => {
    for (const [sel, v] of Object.entries(map)) if (el.matches(sel)) return v;
    return undefined;
  };
  const lookup = (map, el) => pinned(map, el) ?? 0;
  const placed = new WeakMap();
  const pageTop = (el) => {
    const v = pinned(tops, el);
    if (v !== undefined) return v;
    if (!placed.has(el)) placed.set(el, 100000 + 100 * placed.n++);
    return placed.get(el);
  };
  placed.n = 0;
  /** Its distance from the top of the page, less how far the boxes around it have been scrolled. */
  const docTop = (el) => {
    let top = pageTop(el);
    for (let box = el.parentElement; box; box = box.parentElement) top -= Number(box.scrollTop) || 0;
    return top;
  };
  for (const [sel, size] of Object.entries(scrollers)) {
    for (const box of document.querySelectorAll(sel)) {
      Object.defineProperty(box, 'clientHeight', { value: size.clientHeight, configurable: true });
      Object.defineProperty(box, 'scrollHeight', { value: size.scrollHeight, configurable: true });
      box.scrollTop = 0;
    }
  }
  /** The bars' height as the panel last set it, and the 10 px it keeps clear under them. */
  const clear = () => (parseFloat(document.documentElement.style.getPropertyValue('--stick-all')) || 0) + 10;

  // Every scroll, in order: scrollIntoView on an element, or the window's
  // scrollTo. Chromium's rules, as measured in headless Chromium:
  //  - while a smooth window.scrollTo() started in an earlier task is still
  //    moving the page (most of a second for a long way), a smooth
  //    scrollIntoView() from an ordinary task is dropped, the moving page
  //    stops, and every other one in that task is dropped too - even after
  //    an instant scroll in between;
  //  - from an animation frame it lands, unless it would end where the page
  //    is already going: then it is dropped just the same;
  //  - a smooth window.scrollTo() always lands, from anywhere;
  //  - on something not drawn, scrollIntoView() does nothing at all.
  const scrolls = [];
  let pageScroll = null, moving = null, elementScroll = null;
  function startTask() { moving = pageScroll && now < pageScroll.until ? pageScroll : null; }
  window.HTMLElement.prototype.scrollIntoView = function scrollIntoView(opts) {
    if (!drawn(this)) { scrolls.push({ el: this, opts, frame: inFrame, nothing: true }); return; }
    const smooth = opts?.behavior === 'smooth';
    const end = Math.max(0, pageTop(this) - clear());
    const entry = { el: this, opts, frame: inFrame, dropped: smooth && !!moving && (!inFrame || end === moving.to) };
    scrolls.push(entry);
    pageScroll = null;
    elementScroll = !entry.dropped && smooth ? { entry, until: now + 700 } : null;
  };
  // The other way a smooth scroll dies, measured the same way: with a text box
  // focused, one that is under way stops when focus moves to anything else.
  // Only something focusable takes focus; on a heading focus() does nothing.
  // (It was measured for scrollIntoView(); a scrollTo() is held to it too.)
  let active = null;
  Object.defineProperty(document, 'activeElement', { get: () => active, configurable: true });
  const focus = window.HTMLElement.prototype.focus;
  const focusable = (el) => /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(el.tagName)
    || (el.tagName === 'A' && el.hasAttribute('href')) || el.hasAttribute('tabindex');
  window.HTMLElement.prototype.focus = function (...args) {
    if (!focusable(this)) return undefined;
    const running = [elementScroll, pageScroll].find((x) => x && now < x.until);
    if (active && active !== this && /^(INPUT|TEXTAREA)$/.test(active.tagName) && running) {
      running.entry.dropped = true;
      elementScroll = pageScroll = null;
    }
    active = this;
    return focus.apply(this, args);
  };
  window.HTMLElement.prototype.blur = function () { if (active === this) active = null; };
  const win = {
    document, innerHeight, scrollY: 0, navigator: {}, location: { reload() {}, href: '' },
    addEventListener() {}, requestAnimationFrame,
    scrollTo(opts) {
      const to = typeof opts === 'object' ? opts.top : opts;
      const smooth = opts?.behavior === 'smooth';
      const entry = { to, smooth };
      scrolls.push(entry);
      pageScroll = smooth ? { entry, to, until: now + 700 } : null;
      elementScroll = null;
    },
  };
  /**
   * Where the page ends up: { el, block } for the last scroll that took
   * effect, el being the element it was for, 'top', or a number nothing is
   * placed at; null if it stopped part-way. A scroll to a number is matched
   * to the drawn element whose landing it is, by the panel's own sums - its
   * top just under the bars, mid-screen, or its bottom at the bottom.
   */
  const landing = () => {
    const last = scrolls.filter((x) => !x.nothing).at(-1);
    if (!last || last.dropped) return null;
    if (last.el) return { el: last.el, block: last.opts?.block ?? 'start' };
    if (last.to === 0) return { el: 'top', block: 'start' };
    const bars = clear();
    const room = innerHeight - bars;
    for (const el of document.querySelectorAll('body *')) {
      if (!drawn(el)) continue;
      const top = docTop(el);
      const h = lookup(heights, el);
      const ways = { start: top - bars, center: top - bars - (h < room ? (room - h) / 2 : 0), nearest: top + h - innerHeight };
      for (const [block, y] of Object.entries(ways)) if (Math.max(0, Math.round(y)) === last.to) return { el, block };
    }
    return { el: last.to, block: null };
  };
  const landed = () => landing()?.el ?? null;
  /**
   * Where `el`'s top is on the screen once the last scroll has finished, or
   * null when that cannot be said. After a scrollTo() it is sums; after a
   * scrollIntoView() to `el` itself it is the scroll margin the stylesheet
   * gives it - a card's or a group's clears the bars, anything else's is 0,
   * the very top of the screen, behind them.
   */
  const endsAt = (el) => {
    const last = scrolls.filter((x) => !x.nothing).at(-1);
    if (!last || last.dropped) return null;
    if (!last.el) return docTop(el) - last.to;
    if (last.el !== el || (last.opts?.block ?? 'start') === 'center') return null;
    return el.matches('.card, .settings-group') ? clear() : 0;
  };
  // Sideways, `lefts` is from the left of the row the element sits in, which
  // moves it by however far that row has been slid. Something not drawn is
  // all zeros, as a browser measures it.
  window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    if (!drawn(this)) return { top: 0, bottom: 0, height: 0, left: 0, right: 0, width: 0 };
    const top = docTop(this) - win.scrollY;
    const height = lookup(heights, this);
    const left = lookup(lefts, this) - (Number(this.parentElement?.scrollLeft) || 0);
    const width = lookup(widths, this);
    return { top, bottom: top + height, height, left, right: left + width, width };
  };
  win.getComputedStyle = (el) => ({
    position: sticky.some((s) => el.matches(s)) ? 'sticky' : 'static',
    overflowY: Object.keys(scrollers).some((s) => el.matches(s)) ? 'auto' : 'visible',
  });

  const kept = new Map();
  const localStorage = {
    getItem: (k) => (kept.has(k) ? kept.get(k) : null),
    setItem: (k, v) => {
      if (storage === 'refused') throw Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' });
      kept.set(k, String(v));
    },
    removeItem: (k) => { kept.delete(k); },
  };
  // /auth/status is never answered, so the panel's own loaders never run.
  const fetch = async (url) => (url === '/api/auth/status' ? new Promise(() => {})
    : { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(answers[url] ?? {}) });

  const exported = ['renderJumpNav', 'showSettingsGroup', 'layoutStickyBars', 'runSettingsSearch', 'markAnswer', 'loadAiProviders',
    'renderFreshInstall', 'loadGroups', 'loadMembersRoster', 'loadLogFiles', 'refreshSearchIndex', 'loadAdmins'];
  // What the page puts on `window` - gaOpen, openMember - it also calls by its
  // bare name, which a browser finds on the global object. Here `window` is a
  // plain object, so each gets a name that hands the call on.
  const globals = [...new Set([...app.matchAll(/^window\.(\w+) = /gm)].map((m) => m[1]))]
    .map((g) => `const ${g} = (...a) => window.${g}(...a);`).join('\n');
  // eslint-disable-next-line no-new-func
  const make = new Function('window', 'document', 'localStorage', 'fetch', 'EventSource',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'confirm', 'alert', 'prompt',
    'navigator', 'location', `"use strict";\n${globals}\n${app}\n;return { ${exported.join(', ')} };`);
  const h = make(win, document, localStorage, fetch, function EventSource() {},
    setTimeout, clearTimeout, () => {}, () => {}, () => true, () => {}, () => null,
    win.navigator, win.location);
  /** A click by a person: a task of its own. */
  const press = (el) => { startTask(); el.click(); };
  /**
   * A click on something the panel wires with an onclick attribute - Manage,
   * a member's row, View, ✕ close - which linkedom does not run. The attribute
   * is run as the browser would, with the page's globals in scope.
   */
  const pressInline = (el) => {
    const owner = el.closest('[onclick]');
    startTask();
    // eslint-disable-next-line no-new-func
    return new Function('win', `with (win) { return ${owner.getAttribute('onclick')}; }`)(win);
  };
  return { document, window, win, h, flush, runFor, press, pressInline, scrolls, landed, landing, endsAt };
}

/** Signed in, then Settings opened the way a click does, and the chip row drawn. */
function openSettings(p) {
  p.document.getElementById('app').classList.remove('hidden');
  p.press(p.document.querySelector('.tab[data-tab="settings"]'));
  p.flush();
  // A moment passes before anything else is pressed: the tab's own scroll to
  // the top has finished (the section below is about when it has not).
  p.runFor(1000);
  p.scrolls.length = 0;
}
const tabBtn = (document, t) => document.querySelector(`.tab[data-tab="${t}"]`);
/** Signed in on `t`, a second after pressing it, with the page `y` down. */
function onTab(p, t, y = 0) {
  p.document.getElementById('app').classList.remove('hidden');
  p.press(tabBtn(p.document, t));
  p.flush();
  p.runFor(1000);
  p.win.scrollY = y;
  p.scrolls.length = 0;
}
const chip = (document, group) => document.querySelector(`#jumpnav button[data-group="${group}"]`);
const shown = (document) => [...document.querySelectorAll('#tab-settings .settings-group')]
  .filter((g) => !g.classList.contains('hidden')).map((g) => g.dataset.group);
const name = (el) => (el === 'top' ? 'the top of the page' : !el ? 'nowhere (the scroll was dropped)'
  : typeof el === 'number' ? `${el} px down, where nothing is`
  : el.id ? `#${el.id}` : el.dataset?.group ? `the ${el.dataset.group} group`
  : el.classList?.contains('card') ? `the "${el.querySelector('h2')?.textContent.trim().slice(0, 30)}" card`
  : `<${el.tagName.toLowerCase()}> "${el.textContent.replace(/\s+/g, ' ').trim().slice(0, 30)}"`);

// The desktop the report came from: the checklist open above the groups, and
// every group starting at 2,769 px - the page as headless Chromium laid it out.
const DESKTOP = { innerHeight: 800, tops: { '.settings-group': 2769 } };

console.log('=== a group chip brings its group on screen, below a long checklist ===');
{
  const p = loadPanel(DESKTOP);
  openSettings(p);
  for (const g of ['tv', 'moderation', 'system', 'api-keys']) {
    p.scrolls.length = 0;
    p.press(chip(p.document, g));
    p.flush();
    const group = p.document.querySelector(`.settings-group[data-group="${g}"]`);
    ok(shown(p.document).join() === g && chip(p.document, g).classList.contains('active'),
      `"${chip(p.document, g).textContent}" switches to its group`);
    ok(p.landed() === group && p.landing().block === 'start',
      `and scrolls that group to the top of the screen (went to ${name(p.landed())}, ${p.landing()?.block})`);
  }
}

console.log('=== pressed from half-way down a long group, it does the same ===');
{
  const p = loadPanel(DESKTOP);
  openSettings(p);
  p.press(chip(p.document, 'movies'));
  p.flush();
  p.runFor(1000);
  p.win.scrollY = 4500;
  p.scrolls.length = 0;
  p.press(chip(p.document, 'tv'));
  p.flush();
  ok(p.landed() === p.document.querySelector('.settings-group[data-group="tv"]'),
    `the new group is scrolled to, not the top of the page (went to ${name(p.landed())})`);
}

console.log('=== pressed within a second of opening Settings, a chip still lands ===');
{
  // Opening the tab used to scroll it to the top smoothly, from wherever the
  // last tab was left: from 2,000 px down the Dashboard that took most of a
  // second, and a chip pressed during it asked for its group from an ordinary
  // task, was dropped, and the page stopped part-way down the checklist - at
  // 150 ms and at 400 ms, on a desktop and on a phone. The tab now opens at
  // its top at once; pressing Settings while it shows still goes up smoothly,
  // and a chip pressed while that is under way must land all the same.
  for (const after of [150, 400]) {
    for (const from of ['dashboard', 'settings']) {
      const p = loadPanel(DESKTOP);
      onTab(p, from, 2090);
      p.press(p.document.querySelector('.tab[data-tab="settings"]'));
      p.runFor(after);
      const up = p.scrolls.find((x) => x.to === 0);
      ok(up && up.smooth === (from === 'settings'),
        `${after} ms after pressing Settings on ${from}, the page is ${from === 'settings' ? 'still sliding' : 'already'} at the top`);
      p.press(chip(p.document, 'tv'));
      p.flush();
      const tv = p.document.querySelector('.settings-group[data-group="tv"]');
      ok(p.landed() === tv, `the TV chip, pressed then, lands on its group (went to ${name(p.landed())})`);
    }
  }
}

console.log('=== the Checklist chip lands on the checklist while the tab slides up ===');
{
  // Found sweeping the whole panel: the Checklist chip, pressed within a
  // second of opening Settings from a scrolled page, stopped the page where it
  // was - 1,800 px down, from the Dashboard - even with its scroll asked for
  // from an animation frame. The checklist is at the very top, where the tab
  // was already on its way, and Chromium drops a smooth scrollIntoView() that
  // would end where the page is already going. The desktop as Chromium laid
  // it out: the checklist's top at 212 px and the bars on Settings 205 px
  // deep, so the card lands with the page at 0, where the tab is going.
  const p = loadPanel({
    ...DESKTOP,
    tops: { ...DESKTOP.tops, '#card-fresh-install': 212 },
    heights: { '.topbar': 66, '#tabs': 43, '#jumpnav': 32, '.settings-actions': 64 },
    sticky: ['.topbar', '#tabs', '#jumpnav', '.settings-actions'],
  });
  onTab(p, 'settings', 3000);
  p.h.layoutStickyBars();
  p.press(p.document.querySelector('.tab[data-tab="settings"]'));
  p.runFor(150);
  p.press(p.document.querySelector('#jumpnav button[data-scroll="card-fresh-install"]'));
  p.flush();
  ok(p.landed() === 'top' || p.landed() === p.document.getElementById('card-fresh-install'),
    `the page ends at the checklist (went to ${name(p.landed())})`);
}

console.log('=== with the checklist folded away, the top of the tab is kept ===');
{
  // The group then starts near the top of the screen anyway, and going to the
  // top keeps the find box in view, as it always has.
  const p = loadPanel({ innerHeight: 800, tops: { '.settings-group': 300 } });
  openSettings(p);
  p.press(chip(p.document, 'tv'));
  p.flush();
  ok(shown(p.document).join() === 'tv', 'the chip switches the group');
  ok(p.scrolls.length === 1 && p.scrolls[0].to === 0, 'and the page goes to the top, where the group already shows');
}

console.log('=== opening the tab still starts at the top, checklist first ===');
{
  const p = loadPanel(DESKTOP);
  p.document.getElementById('app').classList.remove('hidden');
  p.scrolls.length = 0;
  p.press(p.document.querySelector('.tab[data-tab="settings"]'));
  p.flush();
  ok(p.scrolls.length === 1 && p.scrolls[0].to === 0,
    'the tab opens at its top, once: only a chip press jumps down to a group');
}

console.log('=== a chip pressed while the find box is filtering clears it and shows the group ===');
{
  const p = loadPanel(DESKTOP);
  openSettings(p);
  const box = p.document.getElementById('set-search');
  box.value = 'key';
  box.dispatchEvent(new p.window.Event('input'));
  ok(p.document.querySelectorAll('#tab-settings .card.nomatch').length > 0, 'the filter is on');
  p.scrolls.length = 0;
  p.press(chip(p.document, 'connection'));
  p.flush();
  const group = p.document.querySelector('.settings-group[data-group="connection"]');
  ok(box.value === '' && !group.querySelector('.card.nomatch'), 'the filter is cleared');
  ok(p.landed() === group, `and the group, not the top of the page, is what ends on screen (went to ${name(p.landed())})`);
}

/** The field a link lands on, or its card when the field itself is not drawn. */
const expectedLanding = (el) => (el.closest('.hidden') && !el.classList.contains('card') ? el.closest('.card') : el);

console.log('=== every row of the fresh-install checklist lands on its field, from anywhere down the page ===');
{
  // The rows sit 30 deep in a card 2,500 px tall, so a row is always pressed
  // from a page that has been scrolled. They switched the group and focused
  // the field, off screen, and the page moved 18 px and stopped.
  const p = loadPanel(DESKTOP);
  openSettings(p);
  p.h.renderFreshInstall({ config: structuredClone(DEFAULT_CONFIG), role: 'superadmin', status: null,
    accounts: null, admins: null, ffmpeg: null, update: null });
  const links = [...p.document.querySelectorAll('#fic-list a.card-link[data-target]')];
  ok(links.length >= 20, `the checklist drew its rows (${links.length} links)`);
  const lost = [];
  for (const a of links) {
    const target = p.document.querySelector(a.dataset.target);
    if (!target) { lost.push(`${a.dataset.target} (no such element)`); continue; }
    // Back to Settings, part-way down the checklist, the way a person gets to a row.
    p.press(p.document.querySelector('.tab[data-tab="settings"]'));
    p.flush();
    p.runFor(1000);
    p.win.scrollY = 1500;
    p.scrolls.length = 0;
    p.press(a);
    p.flush();
    const want = expectedLanding(target);
    if (p.landed() !== want) lost.push(`${a.dataset.target} -> ${name(p.landed())}`);
    // A field mid-screen, with its label above it; brought to just under the
    // bars, the label would be under them. A card from its heading.
    else if (p.landing().block !== (want.classList.contains('card') ? 'start' : 'center')) {
      lost.push(`${a.dataset.target} -> ${p.landing().block}`);
    }
  }
  ok(lost.length === 0, `each one ends with its field on screen, a field mid-screen${lost.length ? ` - not: ${lost.join('; ')}` : ''}`);
}

console.log('=== the pointers left where a key used to be land on the key ===');
{
  // "TMDB API key - saved  API keys & logins 🔑 →" in Movies, and its kind in
  // Direct links, TV and the Gemini card: pressed from the middle of a group.
  const p = loadPanel(DESKTOP);
  openSettings(p);
  const links = [...p.document.querySelectorAll('#tab-settings .settings-group a.card-link[data-target]')];
  ok(links.length >= 5, `the groups carry their pointer links (${links.length})`);
  const lost = [];
  for (const a of links) {
    const from = a.closest('.settings-group').dataset.group;
    p.press(chip(p.document, from));
    p.flush();
    p.runFor(1000);
    p.win.scrollY = 4500;
    p.scrolls.length = 0;
    p.press(a);
    p.flush();
    const target = p.document.querySelector(a.dataset.target);
    if (p.landed() !== expectedLanding(target)) lost.push(`${from}: ${a.dataset.target} -> ${name(p.landed())}`);
    // Straight there: a link into the tab already showing used to press the
    // tab again on the way, which is a slide back to the top first.
    else if (p.scrolls.filter((x) => !x.nothing).length !== 1) {
      lost.push(`${from}: ${a.dataset.target} after ${p.scrolls.filter((x) => !x.nothing).length - 1} other scroll(s)`);
    }
  }
  ok(lost.length === 0, `each lands on its key, in one move${lost.length ? ` - not: ${lost.join('; ')}` : ''}`);
}

console.log('=== a header search result picked while scrolled lands on it ===');
{
  const p = loadPanel(DESKTOP);
  openSettings(p);
  const box = p.document.getElementById('gsearch');
  for (const [q, id] of [['blocked ratings', 'f-blocked'], ['tmdb api key', 'f-tmdbkey'], ['prefix', 'f-prefix']]) {
    p.press(p.document.querySelector('.tab[data-tab="settings"]'));
    p.flush();
    p.runFor(1000);
    p.win.scrollY = 2500;
    box.value = q;
    box.dispatchEvent(new p.window.Event('input'));
    const item = [...p.document.querySelectorAll('#gsearch-results .sr-item')]
      .find((x) => p.win._searchHits?.[+x.dataset.i]?.el?.id === id);
    if (!item) { ok(false, `"${q}": the header search offers #${id}`); continue; }
    p.scrolls.length = 0;
    p.press(item);
    p.flush();
    const target = p.document.getElementById(id);
    ok(p.landed() === target, `"${q}": lands on #${id} (went to ${name(p.landed())})`);
  }
}

console.log('=== Enter in the find box lands on the first match ===');
{
  // Enter moved focus from the find box to the field it had just started
  // scrolling to, and moving focus out of a text box stops that scroll: the
  // field lit up wherever it was, usually below the screen.
  const p = loadPanel(DESKTOP);
  openSettings(p);
  const box = p.document.getElementById('set-search');
  const enter = () => {
    const e = new p.window.Event('keydown');
    Object.defineProperty(e, 'key', { value: 'Enter', configurable: true });
    box.dispatchEvent(e);
  };
  for (const q of ['prefix', 'blocked', 'delete the local']) {
    p.document.querySelectorAll('.flash-field').forEach((x) => x.classList.remove('flash-field'));
    box.focus();
    box.value = q;
    box.dispatchEvent(new p.window.Event('input'));
    p.win.scrollY = 0;
    p.scrolls.length = 0;
    enter();
    p.flush();
    const lit = p.document.querySelector('.flash-field');
    ok(!!lit && p.landed() === lit,
      `"${q}": the match it lights is where the page goes (${name(lit)}, went to ${name(p.landed())})`);
    p.runFor(1000);
  }
}

console.log('=== a header search result picked with the keyboard lands on it ===');
{
  // The same, from the search box in the header: arrow to a result, Enter.
  const p = loadPanel(DESKTOP);
  openSettings(p);
  const box = p.document.getElementById('gsearch');
  box.focus();
  box.value = 'blocked ratings';
  box.dispatchEvent(new p.window.Event('input'));
  p.win.scrollY = 2500;
  p.scrolls.length = 0;
  const e = new p.window.Event('keydown');
  Object.defineProperty(e, 'key', { value: 'Enter', configurable: true });
  box.dispatchEvent(e);
  p.flush();
  const want = p.document.getElementById('f-blocked');
  ok(p.landed() === want, `Enter on "Blocked ratings" lands on it (went to ${name(p.landed())})`);
}

console.log('=== the header search offers nothing in a card that is closed ===');
{
  // "lock" offered "🔒 Lock (admins only)" from the Groups tab's group card
  // while no group was open; picking it opened the tab and showed nothing.
  const p = loadPanel(DESKTOP);
  openSettings(p);
  const box = p.document.getElementById('gsearch');
  const offered = () => {
    box.value = 'lock admins only';
    box.dispatchEvent(new p.window.Event('input'));
    return (p.win._searchHits ?? []).some((x) => x.card?.id === 'ga-detail');
  };
  ok(!offered(), 'with no group open, nothing in the group card is offered');
  p.document.getElementById('ga-detail').classList.remove('hidden');
  ok(offered(), 'with a group open, it is');
  box.value = 'blocked ratings';
  box.dispatchEvent(new p.window.Event('input'));
  ok((p.win._searchHits ?? []).some((x) => x.el?.id === 'f-blocked'),
    'and a setting in a Settings group that is not showing is still offered - landing on it switches group');
}

console.log('=== a link to a field that is not drawn lands on its card ===');
{
  // The Plex token lives in a sub-panel that is display:none unless Plex is
  // the provider; scrolling to it does nothing, so the card is the landing.
  const p = loadPanel(DESKTOP);
  openSettings(p);
  const a = p.document.createElement('a');
  a.className = 'card-link';
  a.href = '#';
  a.dataset.goto = 'settings';
  a.dataset.target = '#f-plex-token';
  p.document.getElementById('fic-list').appendChild(a);
  p.win.scrollY = 1500;
  p.press(a);
  p.flush();
  const card = p.document.getElementById('f-plex-token').closest('.card');
  ok(p.landed() === card, `lands on the Library card (went to ${name(p.landed())})`);
}

console.log('=== every scroll of the page goes through the two helpers ===');
{
  // The rule the landings above and below depend on, kept for the next one
  // written. Chromium loses a smooth scrollIntoView() in the two cases
  // scrollToElement describes, so there is none left in the panel; the page
  // is moved by window.scrollTo(), and only from scrollToElement, which works
  // out where to go and waits for a frame, and scrollToTop.
  const code = app.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const body = (fn) => new RegExp(`\\nfunction ${fn}\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}`).exec(code)?.[0] ?? '';
  const helpers = body('scrollToElement') + body('scrollToTop');
  const count = (text, re) => [...text.matchAll(re)].length;
  const intoView = count(code, /\.scrollIntoView\(/g);
  ok(intoView === 0, `no scrollIntoView() anywhere in app.js${intoView ? ` - found ${intoView}` : ''}`);
  const scrolls = count(code, /\bscroll(To|By)\(/g) - count(helpers, /\bscroll(To|By)\(/g);
  ok(count(helpers, /window\.scrollTo\(/g) === 2 && scrolls === 0,
    `window.scrollTo() is called from scrollToElement and scrollToTop and nowhere else${scrolls ? ` - ${scrolls} more` : ''}`);
  const smooth = count(code, /'smooth'/g) - count(helpers, /'smooth'/g);
  ok(smooth === 0, `nothing else asks for a smooth scroll${smooth ? ` - ${smooth} more` : ''}`);
  ok(/requestAnimationFrame\(go\)/.test(body('scrollToElement')),
    'scrollToElement waits for an animation frame, after whatever the handler that called it does');
}

console.log('=== the sticky bars stack under one another at their measured heights ===');
{
  // The phone the report was checked on: the header wraps to 143 px (with a
  // fraction), the tabs are 42.6, the chip row 32, the Save bar 65.
  const phone = {
    innerHeight: 844,
    heights: { '.topbar': 143.4, '#tabs': 42.6, '#jumpnav': 32, '.settings-actions': 65 },
    sticky: ['.topbar', '#tabs', '#jumpnav', '.settings-actions'],
  };
  const p = loadPanel(phone);
  const v = (name) => p.document.documentElement.style.getPropertyValue(name);
  p.h.layoutStickyBars();
  ok(v('--stick-tabs') === '' && v('--stick-all') === '',
    'behind the sign-in screen, where everything measures 0, the stylesheet\'s own numbers are left alone');
  openSettings(p);
  p.h.layoutStickyBars();
  ok(v('--stick-tabs') === '143px', `the tabs stick under the whole header (${v('--stick-tabs')}), not at 52 px inside it`);
  ok(v('--stick-chips') === '186px', `the chips under the tabs (${v('--stick-chips')}), not at 0 over the header`);
  ok(v('--stick-save') === '218px', `the Save bar under the chips (${v('--stick-save')}), not at 94 px under the header`);
  ok(v('--stick-all') === '283px', `and the whole stack is ${v('--stick-all')}, which is where a scrolled-to card lands`);

  // Off the Settings tab there is no Save bar to leave room for.
  p.document.querySelector('.tab[data-tab="dashboard"]').click();
  p.flush();
  p.h.layoutStickyBars();
  ok(v('--stick-all') === '218px', `on another tab the stack stops at the chips (${v('--stick-all')})`);

  // A header that is not sticky takes no room at all.
  const q = loadPanel({ ...phone, sticky: ['#tabs', '#jumpnav', '.settings-actions'] });
  openSettings(q);
  q.h.layoutStickyBars();
  ok(q.document.documentElement.style.getPropertyValue('--stick-tabs') === '0px',
    'a header that scrolls away is not counted');
}

console.log('=== the stylesheet uses the measured heights, and the chips paint under the header ===');
{
  const rule = (sel) => {
    const m = css.match(new RegExp(`(^|\\n)${sel.replace(/[.#]/g, '\\$&')}\\s*\\{([^}]*)\\}`));
    return m ? m[2] : '';
  };
  ok(/top:\s*var\(--stick-tabs/.test(rule('.tabs')), '.tabs sticks at --stick-tabs');
  ok(/top:\s*var\(--stick-chips/.test(rule('.jumpnav')), '.jumpnav sticks at --stick-chips');
  ok(/top:\s*var\(--stick-save/.test(rule('.settings-actions')), '.settings-actions sticks at --stick-save');
  // Anywhere else - a media query included - a fixed top would win on the
  // screens it covers, which is how the phone's 52 px and 94 px got stuck.
  const fixed = [...css.matchAll(/(\.tabs|\.jumpnav|\.settings-actions)\s*\{[^}]*\btop:\s*\d/g)].map((m) => m[1]);
  ok(fixed.length === 0, `no rule pins them at a fixed height${fixed.length ? ` - ${fixed.join(', ')}` : ''}`);
  const z = (sel) => Number(/z-index:\s*(\d+)/.exec(rule(sel))?.[1]);
  ok(z('.jumpnav') < z('.topbar'), `the chips (z ${z('.jumpnav')}) sit under the header (z ${z('.topbar')}), so its search results cover them rather than the reverse`);
  ok(z('.settings-actions') < z('.jumpnav') && z('.jumpnav') < z('.tabs'), 'and each bar tucks under the one above it');
  ok(/scroll-margin-top:\s*calc\(var\(--stick-all/.test(css) && /\.card,\s*\.settings-group\s*\{[^}]*scroll-margin-top/.test(css),
    'a card or group scrolled to lands below the whole stack, not behind it');
}

console.log('=== every Settings card is in a group, except the checklist ===');
{
  const { document } = loadPanel();
  const loose = [...document.querySelectorAll('#tab-settings .card')]
    .filter((c) => !c.closest('.settings-group') && c.id !== 'card-fresh-install')
    .map((c) => c.querySelector('h2')?.textContent.trim());
  ok(loose.length === 0, `no card shows under whichever group happens to be open${loose.length ? ` - ${loose.join(', ')}` : ''}`);
  ok(document.getElementById('btn-cat-refresh')?.closest('.settings-group')?.dataset.group === 'library-amp-files',
    'the clean-title catalogue is in Library & files, with the library it walks');
}

console.log('=== an answer written again, word for word, still shows ===');
{
  const p = loadPanel(DESKTOP);
  openSettings(p);
  const $ = (id) => p.document.getElementById(id);
  const blinks = (el) => el.classList.contains('flash-field');
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    $('tv-save-note').textContent = 'saved';
    $('tv-save').click();
    $('tv-save-note').classList.remove('flash-field');
    p.h.markAnswer($('tv-save-note').firstChild ?? $('tv-save-note'));
    ok(blinks($('tv-save-note')), '"saved" written over "saved" after a second Save blinks, so the press was visibly answered');

    p.h.markAnswer($('dl-note'));
    ok(!blinks($('dl-note')), 'a line in another card, written by something else, does not');
    p.h.markAnswer($('ro-note'));
    ok(!blinks($('ro-note')), 'nor does a text box that happens to be called a note');

    $('btn-test-omdb').click();
    p.h.markAnswer($('omdb-result'));
    ok(blinks($('omdb-result')), 'a Test key verdict repeated blinks too');
    $('btn-save').click();
    p.h.markAnswer($('save-note'));
    ok(blinks($('save-note')), 'and so does the sticky Save\'s own note, which sits outside every card');

    // The time limit, with a press in the same card as the line: only the
    // clock stands between this redraw and a blink.
    $('btn-test-omdb').click();
    $('omdb-result').classList.remove('flash-field');
    clock += 5000;
    p.h.markAnswer($('omdb-result'));
    ok(blinks($('omdb-result')), 'five seconds after Test key, its verdict landing still blinks');
    $('omdb-result').classList.remove('flash-field');
    clock += 11000;
    p.h.markAnswer($('omdb-result'));
    ok(!blinks($('omdb-result')), 'sixteen seconds after it, a line redrawn in the background stays still');
  } finally {
    Date.now = realNow;
  }
  ok(/\.toast\s*\{[^}]*pointer-events:\s*none/.test(css), 'the toast lets a tap through to the button under it');
}

console.log('=== a list row\'s buttons drop below its title when both do not fit ===');
{
  // linkedom does no layout, so what these rules do on a 390 px phone was
  // measured in Chromium, every tab and every Settings group: no row wider
  // than its card, no title narrower than its longest word. These pin the
  // rules that do it. The first fix let the title shrink to nothing
  // (min-width: 0) and forbade the buttons to wrap (flex: none): the admin
  // "helper" showed as "he" under Activity, the number "Christopher Nolan" as
  // "Christop" under Edit, a Logs title one word to a line under its tags.
  const block = (sel) => [...css.matchAll(new RegExp(`(^|\\n|\\}\\s*)${sel.replace(/[.>*:()]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'g'))]
    .map((m) => m[2]).join(';');
  ok(/flex-wrap:\s*wrap/.test(block('.item-top')), 'a row wraps: its buttons may go to a line of their own');
  ok(/flex:\s*1 1 \d+(\.\d+)?em\b/.test(block('.item-top > :first-child')),
    'the title keeps a few words\' width, grows into the rest, and never less than its longest word (min-width left at auto)');
  const squeeze = [...css.matchAll(/\.item-(top|title)[^{]*\{[^}]*min-width:\s*0/g)].map((m) => m[0].split('{')[0].trim());
  ok(squeeze.length === 0, `nothing lets a row's title shrink below its longest word${squeeze.length ? ` - ${squeeze.join(', ')}` : ''}`);
  ok(/margin-left:\s*auto/.test(block('.item-top > :last-child:not(:first-child)')), 'buttons that drop below stay at the right');
  const row = block('.item-top > .row');
  ok(/flex-wrap:\s*wrap/.test(row) && !/flex:\s*none/.test(row), 'and a button group wider than the phone wraps rather than running off it');
  ok(/white-space:\s*normal/.test(block('.item-title .pill')), 'a pill in the title wraps instead of running on');
  // The row that did it, drawn by the real card from what GET /ai/providers says
  // when Gemini's free tier has run out for the day.
  const provider = (id, label, extra = {}) => ({ id, label, console: `${id}.example`, keysUrl: '', enabled: true,
    apiKey: '', model: '', autoModel: null, preferences: [], canClearRated: false, status: null, ...extra });
  const p = loadPanel({ answers: { '/api/ai/providers': {
    order: ['gemini', 'groq'],
    providers: [
      provider('gemini', 'Gemini', { status: { state: 'held', reason: 'quota-daily', until: Date.now() + 3600e3, enabled: true, hasKey: true } }),
      provider('groq', 'Groq'),
    ],
  } } });
  await p.h.loadAiProviders();
  const top = p.document.querySelector('#ai-list .item-top');
  const title = top?.firstElementChild;
  ok(title?.classList.contains('item-title') && title.querySelector('.pill.warn')?.textContent.includes('daily quota used up'),
    'the Gemini row\'s title is the first thing in the row and carries the long pill');
  ok([...(top?.querySelector(':scope > .row')?.querySelectorAll('button') ?? [])].map((b) => b.textContent).join() === '▲,▼',
    'and its ▲ ▼ are the .row beside it, which the rules keep on screen');
}

/* ------------------------------------------------------------------------
   The rest of the panel. After the Settings chips, every control in the
   panel whose job is to take you somewhere was pressed the same way, on
   every tab, at 1280x800 and on a 390x844 touch screen, from the top of a
   page, from half-way down it and just after switching tab.
   ------------------------------------------------------------------------ */

console.log('=== every tab opens at its top, wherever the last one was left ===');
{
  // Only Settings did. Pressed from 4,000 px down Settings, Groups opened
  // 4,000 px down its own page, in the middle of the lockdown card's list of
  // groups; Members, History, Logs and the Dashboard the same way.
  const p = loadPanel(DESKTOP);
  const names = [...p.document.querySelectorAll('#tabs .tab')].map((b) => b.dataset.tab);
  const wrong = [];
  for (const t of names) {
    onTab(p, t === 'settings' ? 'logs' : 'settings', 4000);
    p.press(tabBtn(p.document, t));
    p.flush();
    const shows = p.document.querySelector('.panel.active')?.id === `tab-${t}`;
    if (!shows) wrong.push(`${t}: did not show`);
    else if (p.landed() !== 'top') wrong.push(`${t}: went to ${name(p.landed())}`);
    else if (p.scrolls.some((x) => x.smooth || x.opts?.behavior === 'smooth')) wrong.push(`${t}: slid up over the new tab`);
  }
  ok(names.length >= 8 && wrong.length === 0,
    `each of the ${names.length} tabs opens at its top, at once${wrong.length ? ` - not: ${wrong.join('; ')}` : ''}`);

  onTab(p, 'logs', 3000);
  p.press(tabBtn(p.document, 'logs'));
  p.flush();
  ok(p.landed() === 'top' && p.scrolls.at(-1).smooth,
    'pressing the tab already showing takes it back to its top, smoothly, as Settings always did');
}

console.log('=== a link that opens another tab opens it at its top ===');
{
  // "open full log →" and "open history →" on the Dashboard.
  for (const [sel, t] of [['#card-dash-log .card-link', 'logs'], ['#card-dash-history .card-link', 'history']]) {
    const p = loadPanel(DESKTOP);
    onTab(p, 'dashboard', 900);
    p.press(p.document.querySelector(sel));
    p.flush();
    ok(p.document.querySelector('.panel.active')?.id === `tab-${t}` && p.landed() === 'top',
      `"${p.document.querySelector(sel).textContent.trim()}" shows ${t} from its top (went to ${name(p.landed())})`);
  }
}

console.log('=== on a phone, the tab and the chip a link lights are slid into their rows ===');
{
  // Neither row fits a phone: the tabs, eight of them about 80 px each, and
  // the Settings chips. "open full log →" lit Logs off the right-hand edge of
  // the tab row, and a checklist row for a System setting lit a chip nobody
  // could see.
  const tabs = ['dashboard', 'settings', 'groups', 'members', 'admins', 'test', 'history', 'logs'];
  const groups = ['api-keys', 'connection', 'movies', 'tv', 'beta', 'moderation', 'direct-links', 'library-amp-files', 'account', 'system'];
  const lefts = { '#tabs': 0, '#jumpnav': 0 };
  const widths = { '#tabs': 390, '#jumpnav': 390 };
  tabs.forEach((t, i) => { lefts[`.tab[data-tab="${t}"]`] = 10 + i * 80; widths[`.tab[data-tab="${t}"]`] = 80; });
  lefts['#jumpnav button[data-scroll]'] = 12;
  widths['#jumpnav button[data-scroll]'] = 80;
  groups.forEach((g, i) => { lefts[`#jumpnav button[data-group="${g}"]`] = 100 + i * 95; widths[`#jumpnav button[data-group="${g}"]`] = 90; });
  const p = loadPanel({ innerHeight: 844, tops: { '.settings-group': 4308 }, lefts, widths });
  for (const [id, wide] of [['tabs', 10 + tabs.length * 80], ['jumpnav', 100 + groups.length * 95]]) {
    const bar = p.document.getElementById(id);
    Object.defineProperty(bar, 'scrollWidth', { value: wide, configurable: true });
    Object.defineProperty(bar, 'clientWidth', { value: 390, configurable: true });
    bar.scrollLeft = 0;
  }
  const inRow = (btn) => {
    const b = btn.getBoundingClientRect();
    const r = btn.parentElement.getBoundingClientRect();
    return b.left >= r.left && b.right <= r.right;
  };
  onTab(p, 'dashboard');
  p.press(p.document.querySelector('#card-dash-log .card-link'));
  p.flush();
  ok(inRow(tabBtn(p.document, 'logs')), `"open full log →" slides the tab row to Logs (row at ${p.document.getElementById('tabs').scrollLeft} px)`);
  ok(p.document.querySelector('.panel.active')?.id === 'tab-logs', 'and Logs is what shows');

  onTab(p, 'settings');
  const a = p.document.createElement('a');
  Object.assign(a, { className: 'card-link', href: '#' });
  a.dataset.goto = 'settings';
  a.dataset.target = '#f-port';
  p.document.getElementById('fic-list').appendChild(a);
  p.press(a);
  p.flush();
  const lit = p.document.querySelector('#jumpnav button.active');
  ok(lit?.dataset.group === 'system' && inRow(lit),
    `a checklist row for a System setting slides the chips to System (${lit?.dataset.group}, row at ${p.document.getElementById('jumpnav').scrollLeft} px)`);
  const tabsRow = p.document.getElementById('tabs').scrollLeft;
  p.press(tabBtn(p.document, 'dashboard'));
  p.flush();
  ok(p.document.getElementById('tabs').scrollLeft === tabsRow, 'a tab that is already in the row leaves the row where it is');
  // The chip row kept its place across the redraw: after Settings had been
  // slid along to System, the Dashboard's first chips were off the left edge.
  ok(p.document.getElementById('jumpnav').scrollLeft === 0, 'and the next tab\'s chip row starts at its start');
}

console.log('=== every jump chip on every tab lands on its card, however soon after the tab opened ===');
{
  // The Dashboard, Groups, Members and Logs list their cards as chips. Each is
  // pressed a second after the tab opened, 150 ms after it opened from 4,000 px
  // down another tab, and 150 ms after the tab was pressed again, while the
  // page is still sliding back to its top.
  const p = loadPanel(DESKTOP);
  const lost = [];
  let n = 0;
  for (const t of ['dashboard', 'groups', 'members', 'logs', 'history', 'test', 'admins']) {
    onTab(p, t);
    const chips = [...p.document.querySelectorAll('#jumpnav button[data-i]')].filter((b) => !b.classList.contains('hidden'));
    for (const b of chips) {
      const i = b.dataset.i;
      const card = [...p.document.querySelectorAll(`#tab-${t} .card`)][+i];
      for (const [when, from] of [['a second after', null], ['just after, from another tab', 'settings'], ['just after pressing it again', t]]) {
        if (from) {
          onTab(p, from, 4000);
          p.press(tabBtn(p.document, t));
          p.runFor(150);
        } else {
          onTab(p, t, 900);
        }
        p.press(p.document.querySelector(`#jumpnav button[data-i="${i}"]`));
        p.flush();
        n++;
        if (p.landed() !== card || p.landing().block !== 'start') lost.push(`${t} "${b.textContent}" ${when}: went to ${name(p.landed())}`);
      }
    }
  }
  ok(n >= 45 && lost.length === 0, `${n} presses of ${n / 3} chips each land on their card${lost.length ? ` - not: ${lost.join('; ')}` : ''}`);
}

/** Groups, members and saved logs as the server would answer for them. */
const GROUPS = [
  { jid: '111@g.us', subject: 'MOVIE POSTS ONLY', size: 7 },
  { jid: '222@g.us', subject: "Head Admin's movie night", size: 4 },
  { jid: '333@g.us', subject: 'TV REQUESTS ONLY!', size: 9 },
];
const MEMBERS = Array.from({ length: 12 }, (_, i) => ({
  key: `1555000${i}`, number: `1555000${i}`, name: `Person ${i}`, groupCount: 1, adminCount: 0, msgCount: 12 - i,
  groups: [{ jid: '111@g.us', subject: 'MOVIE POSTS ONLY', admin: null }],
}));
const ANSWERS = {
  '/api/wa/groups': GROUPS,
  '/api/members': { members: MEMBERS },
  '/api/logs/files': [{ name: 'debug-2026-09-28.log', size: 4096, mtime: Date.parse('2026-09-28T10:00:00Z') },
    { name: 'debug-2026-09-27.log.gz', size: 2048, mtime: Date.parse('2026-09-27T10:00:00Z'), gzipped: true }],
  ...Object.fromEntries(GROUPS.map((g) => [`/api/groups/${encodeURIComponent(g.jid)}/details`,
    { desc: '', botIsAdmin: true, members: [{ id: '1@lid', number: '15550001', admin: 'admin' }] }])),
  ...Object.fromEntries(MEMBERS.map((m) => [`/api/members/${encodeURIComponent(m.key)}/detail`,
    { ...m, perGroup: {}, timeline: [], firstSeen: null, lastSeen: null }])),
};
// The phone the sweep used: 142 px of header, tabs and chips over 844 px.
const PHONE_BARS = {
  innerHeight: 844,
  heights: { '.topbar': 67, '#tabs': 43, '#jumpnav': 32 },
  sticky: ['.topbar', '#tabs', '#jumpnav'],
};
/** A panel with the lists drawn, on tab `t`, the page `y` down and the bars measured. */
async function withLists(opts, t, y = 0) {
  const p = loadPanel({ ...opts, answers: ANSWERS });
  onTab(p, t, y);
  p.h.layoutStickyBars();
  await p.h.loadGroups();
  await p.h.loadMembersRoster();
  await p.h.loadLogFiles();
  p.flush();
  p.scrolls.length = 0;
  return p;
}
const clearOfBars = (p, el) => {
  const at = p.endsAt(el);
  const bars = parseFloat(p.document.documentElement.style.getPropertyValue('--stick-all'));
  return { ok: at !== null && at >= bars, at, bars };
};

console.log('=== Manage opens a group below the bars, and ← back returns to its row ===');
{
  const p = await withLists({ ...PHONE_BARS, tops: { '#ga-detail': 1400 } }, 'groups', 3000);
  const rows = [...p.document.querySelectorAll('#ga-list .item')];
  ok(rows.length === GROUPS.length, `the list has its ${GROUPS.length} groups`);
  for (const g of GROUPS) {
    const row = rows.find((r) => r.dataset.jid === g.jid);
    p.scrolls.length = 0;
    let err = null;
    try { await p.pressInline(row.querySelector('button')); } catch (e) { err = e; }
    p.flush();
    const detail = p.document.getElementById('ga-detail');
    // Written into the button's onclick, an apostrophe in the name ended the
    // string: Manage threw a syntax error and opened nothing.
    ok(!err && !detail.classList.contains('hidden') && p.document.getElementById('ga-name').textContent === g.subject,
      `Manage on "${g.subject}" opens it${err ? ` - threw ${err.name}: ${err.message}` : ''}`);
    const c = clearOfBars(p, detail);
    ok(p.landed() === detail && c.ok, `and lands on its card, clear of the bars (top at ${c.at}, bars ${c.bars})`);
    p.win.scrollY = 1900;
    p.scrolls.length = 0;
    p.press(p.document.getElementById('ga-close'));
    p.flush();
    // It only hid the card, and the lockdown card below it came up in its place.
    ok(p.landed() === row && p.landing().block === 'center', `← back returns to the "${g.subject}" row (went to ${name(p.landed())})`);
  }
}

console.log('=== a member\'s row opens their details clear of the bars; ✕ close goes back to the row ===');
{
  // The details open above the whole list. From a row further down they were
  // brought in with their top at the very top of the screen, behind the tabs.
  for (const [label, opts] of [['desktop', { innerHeight: 800, heights: { '.topbar': 66, '#tabs': 43, '#jumpnav': 32 }, sticky: ['.topbar', '#tabs', '#jumpnav'] }], ['phone', PHONE_BARS]]) {
    const p = await withLists({ ...opts, tops: { '#mr-detail': 420 } }, 'members', 2500);
    const row = p.document.querySelectorAll('#mr-list .member-row')[9];
    await p.pressInline(row);
    p.flush();
    const box = p.document.getElementById('mr-detail');
    const c = clearOfBars(p, box);
    ok(p.landed() === box && c.ok, `${label}: the details land clear of the bars (top at ${c.at}, bars ${c.bars})`);
    p.scrolls.length = 0;
    await p.pressInline([...box.querySelectorAll('button')].find((b) => /Use this number/.test(b.textContent)));
    p.flush();
    ok(p.landed() === p.document.getElementById('mx-num') && p.document.getElementById('mx-num').value === '+15550009',
      `${label}: "Use this number below ↓" fills the box and lands on it (went to ${name(p.landed())})`);
    p.scrolls.length = 0;
    await p.pressInline([...box.querySelectorAll('button')].find((b) => /close/.test(b.textContent)));
    p.flush();
    ok(box.classList.contains('hidden') && p.landed() === row,
      `${label}: ✕ close goes back to the row that was opened (went to ${name(p.landed())})`);
  }
}

console.log('=== View brings a saved log on screen ===');
{
  // The box opens under the list of files; with a week of them, below the
  // bottom of the screen.
  const p = await withLists({ ...PHONE_BARS, tops: { '#logfile-view': 3200 } }, 'logs', 1500);
  for (const b of p.document.querySelectorAll('#logfiles button')) {
    p.scrolls.length = 0;
    await p.pressInline(b);
    p.flush();
    ok(p.landed() === p.document.getElementById('logfile-view') && p.landing().block === 'nearest',
      `View on ${b.closest('.item').querySelector('.item-title').textContent} brings the log up from below, no further than it must (went to ${name(p.landed())}, ${p.landing()?.block})`);
  }
}

console.log('=== a header search result on every tab lands on it ===');
{
  const p = await withLists(DESKTOP, 'dashboard');
  p.h.refreshSearchIndex();
  const box = p.document.getElementById('gsearch');
  const missed = [];
  let n = 0;
  for (const [q, tab] of [['what the reactions mean', 'dashboard'], ['group lockdown', 'groups'], ['banned numbers', 'members'],
    ['admin accounts', 'admins'], ['dry-run a request', 'test'], ['wanted', 'history'], ['transfers', 'logs'], ['saved debug logs', 'logs'],
    ['blocked ratings', 'settings'], ["mom's movie night", 'groups'], ['person 7', 'members']]) {
    for (const [from, y] of [['dashboard', 0], ['logs', 5000], ['settings', 3000]]) {
      onTab(p, from, y);
      box.value = q;
      box.dispatchEvent(new p.window.Event('input'));
      const hit = p.win._searchHits?.[0];
      const item = p.document.querySelector('#gsearch-results .sr-item');
      if (!hit || !item) { missed.push(`"${q}": nothing offered`); continue; }
      p.scrolls.length = 0;
      p.press(item);
      p.flush();
      await new Promise((r) => setImmediate(r));
      p.flush();
      n++;
      const want = hit.kind === 'group' ? p.document.getElementById('ga-detail')
        : hit.kind === 'member' ? p.document.getElementById('mr-detail')
        : hit.el && !hit.el.closest('.hidden') ? hit.el : hit.card;
      const shows = p.document.querySelector('.panel.active')?.id === `tab-${tab}`;
      if (!shows || p.landed() !== want) missed.push(`"${q}" from ${from}: ${shows ? `went to ${name(p.landed())}, not ${name(want)}` : 'wrong tab'}`);
      p.document.getElementById('ga-detail').classList.add('hidden');
    }
  }
  ok(n === 33 && missed.length === 0, `${n} results, each picked from three places, land on what they name${missed.length ? ` - not: ${missed.join('; ')}` : ''}`);
}

console.log('=== Activity opens an admin\'s trail on screen, the last admin\'s on a phone too ===');
{
  // Found reviewing the sweep, which pressed only the first admin's Activity.
  // The trail opens in place under the admin's row. On a 390x844 phone with
  // the three admins the live box has, the third admin's opened with its top
  // at 873 px, below the bottom of the screen, on a tab that can scroll 24 px:
  // Activity, and the admin's name, which does the same, did nothing anyone
  // could see. The rows as Chromium laid them out: the third from 690 px, its
  // trail from 871, 240 px of row while the trail says "Loading…" - and taller
  // once it is in.
  const ADMINS = ['superadmin', 'helper', 'third-admin'].map((username, i) => ({
    username, role: i ? 'admin' : 'superadmin', lastLogin: null, idleTimeoutMinutes: null }));
  const trail = { total: 2, summary: { first: Date.parse('2026-09-27T10:00:00Z'), last: Date.parse('2026-09-28T10:00:00Z'), top: [{ label: 'saved settings', count: 2 }] },
    events: [{ action: 'saved settings', detail: '', ts: Date.parse('2026-09-28T10:00:00Z') }, { action: 'saved settings', detail: '', ts: Date.parse('2026-09-27T10:00:00Z') }] };
  const answers = { '/api/admins': { admins: ADMINS, defaultIdleMinutes: 15, myIdle: { minutes: 15, own: null } },
    ...Object.fromEntries(ADMINS.map((a) => [`/api/admins/${a.username}/audit?limit=100`, trail])) };
  const third = '#admins-list > .item:last-child';
  // A trail that fits on the screen, and one that runs off it, as the
  // super-admin's hundred actions do.
  for (const [label, rowHeight] of [['a short trail', 300], ['a long trail', 1400]]) {
    for (const via of ['Activity', 'the admin\'s name']) {
      const heights = { ...PHONE_BARS.heights, [third]: 240, '#adm-audit-third-admin': 59 };
      const p = loadPanel({ ...PHONE_BARS, answers, heights, tops: { [third]: 690, '#adm-audit-third-admin': 871 } });
      onTab(p, 'admins');
      p.h.layoutStickyBars();
      await p.h.loadAdmins();
      const row = p.document.querySelector(third);
      const box = p.document.getElementById('adm-audit-third-admin');
      if (!row?.contains(box)) { ok(false, `the third admin's row holds their trail (${label})`); continue; }
      const control = via === 'Activity' ? [...row.querySelectorAll('button')].find((b) => b.textContent === 'Activity') : row.querySelector('.item-title');
      p.scrolls.length = 0;
      const opening = p.pressInline(control);
      p.flush();
      const soon = p.landed();
      const loading = p.endsAt(box);
      // The trail comes in.
      heights[third] = rowHeight;
      heights['#adm-audit-third-admin'] = rowHeight - 181;
      await opening;
      p.flush();
      const bars = parseFloat(p.document.documentElement.style.getPropertyValue('--stick-all'));
      const boxAt = p.endsAt(box);
      const rowAt = p.endsAt(row);
      ok(!box.classList.contains('hidden') && box.textContent.includes('2 action(s)'), `${label}, ${via}: the trail opens`);
      ok(soon === row && loading + 59 <= 844, `${label}, ${via}: "Loading…" comes up on the screen at once (at ${loading})`);
      ok(p.landed() === row, `${label}, ${via}: and the admin's row again once the trail is in (went to ${name(p.landed())})`);
      ok(boxAt !== null && boxAt >= bars && boxAt < 844, `${label}, ${via}: the trail's top ends on the screen, clear of the bars (at ${boxAt}, bars ${bars}, screen 844)`);
      ok(rowAt !== null && rowAt >= bars, `${label}, ${via}: and so does the admin's name, with the Activity that folds it away (at ${rowAt})`);
      if (label === 'a short trail') {
        ok(rowAt + rowHeight === 844, `${label}, ${via}: no further than it must: the row's foot comes to the foot of the screen (at ${rowAt + rowHeight})`);
      } else {
        ok(rowAt === bars + 10, `${label}, ${via}: a trail longer than the screen starts just under the bars, with whose it is (row at ${rowAt})`);
      }
      p.scrolls.length = 0;
      await p.pressInline(control);
      p.flush();
      ok(box.classList.contains('hidden') && p.scrolls.length === 0, `${label}, ${via}: pressed again, it folds away and the page stays put`);
    }
  }
  // Folded again before the trail came in: when it does, the page is left alone.
  const p = loadPanel({ ...PHONE_BARS, answers, tops: { [third]: 690, '#adm-audit-third-admin': 871 }, heights: { ...PHONE_BARS.heights, [third]: 240, '#adm-audit-third-admin': 59 } });
  onTab(p, 'admins');
  p.h.layoutStickyBars();
  await p.h.loadAdmins();
  const activity = [...p.document.querySelector(third).querySelectorAll('button')].find((b) => b.textContent === 'Activity');
  const opening = p.pressInline(activity);
  p.flush();
  p.scrolls.length = 0;
  p.pressInline(activity);
  await opening;
  p.flush();
  ok(p.document.getElementById('adm-audit-third-admin').classList.contains('hidden') && p.scrolls.length === 0,
    `a trail folded away while it loaded is not scrolled to when it arrives (${p.scrolls.length} scroll(s))`);
}

console.log('=== a search result inside a list that scrolls by itself is scrolled into that list ===');
{
  // The request groups, and the TV, beta, direct-link and mass-message
  // groups, are each ticked in a box 260 px tall that scrolls on its own.
  // After sign-in the header's search holds a label for every row of every
  // one: 94 on the live box. Picked from below a box's fold, the row has to
  // be scrolled up inside its box as well as the page brought to the box, or
  // the row it lights is out of sight in the box it is in: in Chromium, 10
  // rows of 10 without that.
  // The request groups' own list is drawn only once the settings are loaded
  // (renderMovieGroupPickers: a list drawn without them could be saved back
  // empty), so this uses the Groups tab's bulk-add list, which the same
  // search indexes and which scrolls by itself in the same way.
  const p = await withLists({ ...DESKTOP,
    tops: { ...DESKTOP.tops, '#mx-groups': 3000, '#mx-groups input[value="333@g.us"]': 3700 },
    heights: { '#mx-groups': 260, '#mx-groups input[value="333@g.us"]': 17 },
    scrollers: { '#mx-groups': { clientHeight: 260, scrollHeight: 900 } } }, 'dashboard');
  p.h.refreshSearchIndex();
  const list = p.document.getElementById('mx-groups');
  const tick = list.querySelector('input[value="333@g.us"]');
  const search = p.document.getElementById('gsearch');
  search.value = 'TV REQUESTS ONLY';
  search.dispatchEvent(new p.window.Event('input'));
  const i = (p.win._searchHits ?? []).findIndex((x) => x.el === tick);
  ok(i >= 0, `the header's search offers TV REQUESTS ONLY's tick box, far down a list (${(p.win._searchHits ?? []).length} results)`);
  p.press(p.document.querySelectorAll('#gsearch-results .sr-item')[i]);
  p.flush();
  const b = list.getBoundingClientRect();
  const r = tick.getBoundingClientRect();
  ok(list.scrollTop > 0 && r.top >= b.top && r.bottom <= b.bottom,
    `the box is scrolled to it (scrollTop ${list.scrollTop}; row at ${r.top}-${r.bottom}, box at ${b.top}-${b.bottom})`);
  const at = p.endsAt(tick);
  ok(p.landed() === tick && at !== null && at >= 10 && at + 17 <= 800,
    `and the page to the box, with the row on screen (went to ${name(p.landed())}, row at ${at})`);
}

console.log('=== a chip opens a folded card on its way to it ===');
{
  // A card folded away shows its heading and nothing under it. A chip lands
  // on what it names, so it opens the card first.
  const p = loadPanel(DESKTOP);
  openSettings(p);
  const fic = p.document.getElementById('card-fresh-install');
  fic.classList.add('collapsed');
  p.press(p.document.querySelector('#jumpnav button[data-scroll="card-fresh-install"]'));
  p.flush();
  ok(!fic.classList.contains('collapsed') && p.landed() === fic,
    `the Checklist chip opens the folded checklist and lands on it (went to ${name(p.landed())})`);
  const shut = [];
  let n = 0;
  for (const t of ['dashboard', 'groups', 'members', 'logs', 'history', 'test']) {
    onTab(p, t, 900);
    const cards = [...p.document.querySelectorAll(`#tab-${t} .card`)];
    for (const c of [...p.document.querySelectorAll('#jumpnav button[data-i]')].filter((x) => !x.classList.contains('hidden'))) {
      const card = cards[+c.dataset.i];
      card.classList.add('collapsed');
      p.scrolls.length = 0;
      p.press(c);
      p.flush();
      n++;
      if (card.classList.contains('collapsed') || p.landed() !== card) shut.push(`${t} "${c.textContent}": ${card.classList.contains('collapsed') ? 'still folded' : `went to ${name(p.landed())}`}`);
    }
  }
  ok(n >= 15 && shut.length === 0, `each of ${n} chips on the other tabs opens its folded card and lands on it${shut.length ? ` - not: ${shut.join('; ')}` : ''}`);
}

console.log('=== ← back, once the group has gone from the list, goes to the list ===');
{
  // The bot can be taken out of a group while its card is open, and the list
  // redraws without it. ← back has no row to go back to then, and goes to the
  // top of the list, not nowhere.
  const answers = { ...ANSWERS };
  const p = loadPanel({ ...PHONE_BARS, tops: { '#ga-detail': 1400 }, answers });
  onTab(p, 'groups', 3000);
  p.h.layoutStickyBars();
  await p.h.loadGroups();
  p.flush();
  await p.pressInline(p.document.querySelector('#ga-list .item[data-jid="222@g.us"] button'));
  p.flush();
  answers['/api/wa/groups'] = GROUPS.filter((g) => g.jid !== '222@g.us');
  await p.h.loadGroups();
  p.flush();
  ok(!p.document.querySelector('#ga-list .item[data-jid="222@g.us"]') && !p.document.getElementById('ga-detail').classList.contains('hidden'),
    'the list is redrawn without the group, its card still open');
  p.win.scrollY = 1900;
  p.scrolls.length = 0;
  p.press(p.document.getElementById('ga-close'));
  p.flush();
  const card = p.document.getElementById('ga-list').closest('.card');
  ok(p.landed() === card && p.landing().block === 'start', `← back lands on the list of groups (went to ${name(p.landed())})`);
}

console.log('=== with a browser that stores nothing, a jump into another settings group still shows it ===');
{
  // Opening Settings redraws its chip row 30 ms after the tab is pressed, and
  // the redraw puts back the settings group last stored - or, in a browser
  // that stores nothing (a private window, blocked site data), the first
  // group, API keys. A search result, or a link, from another tab into a
  // setting in any other group waits that out; landing at once, it was
  // hidden again 30 ms later, and the page was left part-way down API keys.
  const p = loadPanel({ ...DESKTOP, storage: 'refused' });
  const blocked = p.document.getElementById('f-blocked');
  for (const via of ['a header search result', 'a link']) {
    onTab(p, 'settings');
    ok(shown(p.document).join() === 'api-keys', `${via}: with nothing stored, Settings opens on API keys`);
    onTab(p, 'dashboard', 900);
    if (via === 'a link') {
      const a = p.document.createElement('a');
      Object.assign(a, { className: 'card-link', href: '#' });
      a.dataset.goto = 'settings';
      a.dataset.target = '#f-blocked';
      p.document.querySelector('#tab-dashboard .card').appendChild(a);
      p.press(a);
    } else {
      const box = p.document.getElementById('gsearch');
      box.value = 'blocked ratings';
      box.dispatchEvent(new p.window.Event('input'));
      const i = (p.win._searchHits ?? []).findIndex((x) => x.el === blocked);
      p.press(p.document.querySelectorAll('#gsearch-results .sr-item')[i]);
    }
    p.flush();
    ok(shown(p.document).join() === 'movies' && p.landed() === blocked,
      `${via} into Movies from the Dashboard shows Movies and lands on Blocked ratings (showing ${shown(p.document).join()}, went to ${name(p.landed())})`);
  }
}

console.log('=== a jump to something that is not on the page leaves the page where it is ===');
{
  // A card that is hidden has nowhere to be scrolled to: a browser measures
  // it as all zeros, which read as a place would send the page up by the
  // height of the bars for nothing.
  const p = loadPanel({ ...DESKTOP, heights: { '.topbar': 66, '#tabs': 43, '#jumpnav': 32 }, sticky: ['.topbar', '#tabs', '#jumpnav'] });
  onTab(p, 'dashboard', 900);
  p.h.layoutStickyBars();
  const a = p.document.createElement('a');
  Object.assign(a, { className: 'card-link', href: '#' });
  a.dataset.goto = 'dashboard';
  a.dataset.target = '#card-cc-health';
  p.document.querySelector('#tab-dashboard .card').appendChild(a);
  ok(p.document.getElementById('card-cc-health').classList.contains('hidden'), 'the content-check warning card is hidden, with nothing to warn about');
  p.scrolls.length = 0;
  p.press(a);
  p.flush();
  ok(p.scrolls.length === 0, `a link to it does not move the page (${p.scrolls.map((x) => x.to).join(', ') || 'no scroll'})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
