/* Browser load-lint: catches runtime ReferenceErrors in app.js that `node --check`
   cannot see (a deleted-but-still-called function blanks the whole panel).
   Also verifies every id app.js touches exists in index.html. Run: node test/webui-lint.test.mjs */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(here, '..', 'src', 'web', 'public');
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
// Every script the page loads, in order, as the browser runs them. The
// top-level run and the id check take them joined; the call check below takes
// each on its own, with what the scripts before it expose.
const scripts = [...html.matchAll(/<script src="\/([\w.-]+\.js)"/g)].map((m) => m[1]);
const appJs = scripts.map((f) => fs.readFileSync(path.join(pub, f), 'utf8')).join('\n;\n');

console.log('=== app.js executes top-level in a stubbed DOM ===');
{
  // Minimal DOM good enough to run app.js's top level: every element lookup
  // returns a chainable stub, so we surface *code* errors, not missing markup.
  const el = new Proxy(function () {}, {
    get: (t, k) => {
      if (k === 'classList') return { add() {}, remove() {}, toggle() {}, contains: () => false };
      if (k === 'style') return {};
      if (k === 'dataset') return {};
      if (k === 'value' || k === 'textContent' || k === 'innerHTML') return '';
      if (k === 'checked') return false;
      if (k === Symbol.toPrimitive) return () => '';
      return typeof k === 'string' ? el : undefined;
    },
    apply: () => el,
    set: () => true,
  });
  const doc = {
    getElementById: () => el, querySelector: () => el, querySelectorAll: () => [],
    addEventListener() {}, createElement: () => el, body: el, documentElement: el,
    cookie: '', readyState: 'complete',
  };
  const win = {
    document: doc, addEventListener() {}, location: { reload() {}, href: '', origin: 'http://x' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' }),
    setTimeout() {}, setInterval() {}, clearTimeout() {}, clearInterval() {},
    EventSource: function () { return { addEventListener() {}, close() {} }; },
    scrollTo() {}, confirm: () => false, alert() {}, navigator: { clipboard: { writeText: async () => {} } },
    console,
  };
  win.window = win; win.self = win; win.globalThis = win;

  let err = null;
  try {
    const fn = new Function('window', 'document', 'globalThis', 'self', 'localStorage', 'fetch',
      'EventSource', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'confirm', 'alert',
      'navigator', 'location',
      `"use strict";${appJs}`);
    fn(win, doc, win, win, win.localStorage, win.fetch, win.EventSource,
      win.setTimeout, win.setInterval, win.clearTimeout, win.clearInterval,
      win.confirm, win.alert, win.navigator, win.location);
  } catch (e) {
    err = e;
  }
  ok(!err, `app.js top level runs clean${err ? ` — ${err.constructor.name}: ${err.message}` : ''}`);
  if (err) console.log(`       ${err.stack?.split('\n').slice(0, 3).join('\n       ')}`);
}

console.log('=== every $("id") referenced by app.js exists in index.html (or is created by app.js) ===');
{
  const ids = new Set([...appJs.matchAll(/\$\(['"]([\w-]+)['"]\)/g)].map((m) => m[1]));
  const htmlIds = new Set([...html.matchAll(/\bid=["']([\w-]+)["']/g)].map((m) => m[1]));
  // app.js also injects markup, so ids it writes itself are legitimate too.
  for (const m of appJs.matchAll(/\bid=\\?["']([\w-]+)\\?["']/g)) htmlIds.add(m[1]);
  const missing = [...ids].filter((i) => !htmlIds.has(i));
  ok(missing.length === 0, `all ${ids.size} referenced ids resolve${missing.length ? ` — missing: ${missing.join(', ')}` : ''}`);
}

/*
 * Each script is checked against its own names and what the scripts before it
 * leave where it can see them - their top-level declarations and what they put
 * on window - not against the text of every script joined together. The
 * joined check let csv-export.js's private names (textOf, downloadCsv, push,
 * open, table, ...: some 126 of them, inside its IIFE) count as declared for
 * app.js, so app.js calling one it does not have, after a merge say, passed
 * here and threw a ReferenceError in the browser.
 */
const BUILTINS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function',
  'async', 'await', 'of', 'in', 'delete', 'void', 'yield', 'isFinite', 'prompt', 'EventSource',
  'URLSearchParams', 'FormData', 'Intl', 'AbortController', 'structuredClone', 'queueMicrotask',
  'fetch', 'confirm', 'alert', 'parseInt', 'parseFloat', 'String', 'Number', 'Boolean', 'Array',
  'Object', 'JSON', 'Math', 'Date', 'Set', 'Map', 'Promise', 'RegExp', 'Error', 'console',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'encodeURIComponent',
  'decodeURIComponent', 'isNaN', 'require', 'super', 'this', 'await', 'new', 'else', 'do',
  // Browser constructors a card's script builds a download or watches the page with.
  'Blob', 'URL', 'File', 'FileReader', 'MutationObserver', 'Event', 'CustomEvent', 'TextEncoder',
  'TextDecoder', 'WeakMap', 'WeakSet', 'Symbol', 'requestAnimationFrame', 'cancelAnimationFrame']);

// Strip comments and string/template literals first - prose like "it (usually)"
// otherwise looks exactly like a call site.
const stripped = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1 ')
  .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``')
  .replace(/'(?:\\[\s\S]|[^'\\\n])*'/g, "''")
  .replace(/"(?:\\[\s\S]|[^"\\\n])*"/g, '""');

/** Every name a script declares or assigns, at any depth: what its own calls may use. */
function declaredIn(src) {
  return new Set([
    ...[...src.matchAll(/function\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
    ...[...src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)].map((m) => m[1]),
    ...[...src.matchAll(/window\.([A-Za-z_$][\w$]*)\s*=/g)].map((m) => m[1]),
    ...[...src.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g)].map((m) => m[1]),
    ...[...src.matchAll(/([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?(?:function|\()/g)].map((m) => m[1]),
  ]);
}

/**
 * What a classic script leaves for the scripts after it: what it puts on
 * window, and what it declares outside every brace - a function or const
 * inside an IIFE is its own.
 */
function exposedBy(src) {
  let depth = 0;
  let top = '';
  for (const ch of stripped(src)) {
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    else if (depth === 0) top += ch;
  }
  return new Set([
    ...[...src.matchAll(/window\.([A-Za-z_$][\w$]*)\s*=/g)].map((m) => m[1]),
    ...[...top.matchAll(/\b(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
    ...[...top.matchAll(/\b(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
  ]);
}

function calledIn(src) {
  const code = stripped(src);
  return new Set([
    ...[...code.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]),
    // `name?.()` too. It reads like a guard, but optional calling only forgives
    // a declared name that is null - an undeclared one still throws, which is
    // how `loadQueue?.()` reported a queued film as "loadQueue is not defined".
    ...[...code.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\?\.\s*\(/g)].map((m) => m[1]),
  ]);
}

/** For each script, in page order, the names it calls that nothing it can see defines. */
function undefinedCalls(sources) {
  return sources.map((src, i) => {
    const seen = new Set(declaredIn(src));
    for (const before of sources.slice(0, i)) for (const n of exposedBy(before)) seen.add(n);
    return [...calledIn(src)].filter((n) => !seen.has(n) && !BUILTINS.has(n));
  });
}

console.log('=== the check itself: a later script\'s own names cover nothing in app.js ===');
{
  const app = 'function shown() { return 1; }\nconst KEPT = 2;\nshown();\ntextOf(document.body);\n';
  const later = '(() => {\n  function textOf(el) { return el; }\n  const hidden = () => 1;\n  shown(); textOf(null); hidden();\n})();\n';
  const [inApp, inLater] = undefinedCalls([app, later]);
  ok(inApp.includes('textOf'), `app.js calling a name only a later script's IIFE declares is caught (${inApp.join(', ') || 'nothing caught'})`);
  ok(inLater.length === 0, `a later script may call what app.js declares at top level, and its own names (${inLater.join(', ') || 'none flagged'})`);
  const [, after] = undefinedCalls(['(() => { function inner() {} })();', 'inner();']);
  ok(after.includes('inner'), 'a function inside an earlier script\'s IIFE is not visible to the next one');
  const [, onWindow] = undefinedCalls(['(() => { window.shared = () => 1; })();', 'shared(); new Blob([]);']);
  ok(onWindow.length === 0, `while one it puts on window is, and so is a browser constructor like Blob (${onWindow.join(', ') || 'none flagged'})`);
}

console.log('=== no function is called but never defined ===');
{
  const sources = scripts.map((f) => fs.readFileSync(path.join(pub, f), 'utf8'));
  const undef = undefinedCalls(sources);
  scripts.forEach((f, i) => {
    ok(undef[i].length === 0, `every function ${f} calls is defined${undef[i].length ? ` — undefined: ${undef[i].join(', ')}` : ''}`);
  });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
