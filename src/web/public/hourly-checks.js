/* The Logs tab's "Hourly checks" card.

   Every hour on the hour the hourly check (tools/hourly-debug.mjs, run from
   cron) looks for requests that failed or went unanswered, has Claude Code
   research and fix what it finds, restarts the bot when a fix was shipped or
   the bot was unhealthy, and emails a report. This card is where each run is
   seen afterwards: when it ran, what it found, what it fixed and pushed, what
   it refused to ship, how the restart went, any alert, and a link to the
   full report.

   It lives in a file of its own, loaded after app.js and using app.js's
   helpers ($, api, esc, fmtDateTime, fmtClock, HM), so the card can
   change without touching the panel's main script. The check runs outside the
   bot, which cannot tell the panel when a run finishes - the panel is
   push-only over SSE - so the card reloads when the Logs tab is opened, on
   Refresh, and every ten minutes while the tab is showing. */
(function hourlyChecksCard() {
  const card = document.getElementById('card-hourly-checks');
  if (!card) return;

  let RUNS = [];
  let STATUS = null;
  let loadedAt = 0;

  const RESTART_CLASS = {
    healthy: 'done', 'not-needed': '', 'not-connected': 'pending', 'needs-sudo': 'pending',
    'rolled-back': 'failed', 'not-updated': 'failed', 'crash-restarting': 'failed', down: 'failed', failed: 'failed',
  };

  async function load() {
    const box = $('hc-list');
    try {
      const d = await api('GET', '/hourly-checks?limit=200');
      RUNS = d.runs ?? [];
      STATUS = d.status ?? null;
      loadedAt = Date.now();
      render();
    } catch (err) {
      if (box) box.innerHTML = `<div class="verdict bad">${esc(err.message)}</div>`;
    }
  }

  function pill() {
    const p = $('hc-pill');
    if (!p) return;
    if (!STATUS?.lastRunAt) { p.className = 'pill warn'; p.textContent = 'not running yet'; return; }
    if (STATUS.overdue) { p.className = 'pill bad'; p.textContent = 'no run for 2 h+'; return; }
    const last = RUNS[0];
    if (last?.alerts?.length) { p.className = 'pill bad'; p.textContent = 'alert on the last run'; return; }
    const bad = last && last.found > 0 && !['healthy', 'not-needed', undefined].includes(last.restart?.outcome);
    p.className = `pill ${bad ? 'warn' : 'ok'}`;
    p.textContent = `last run ${fmtClock(STATUS.lastRunAt, HM)}`;
  }

  function statusLine() {
    const el = $('hc-status');
    if (!el) return;
    if (!STATUS?.lastRunAt) {
      el.innerHTML = 'No run recorded yet. It is installed with <span class="mono">deploy/install-hourly-debug.sh</span> '
        + '(docs/operations.md, "The hourly check"); the first run is at the top of the next hour.';
      return;
    }
    const bits = [`${STATUS.runsToday} run(s) in the last 24 h`];
    if (STATUS.lastFoundAt) bits.push(`last finding ${fmtDateTime(STATUS.lastFoundAt)}`);
    if (STATUS.claudeReady && STATUS.claudeReady !== 'ready') bits.push(`research: ${STATUS.claudeReady}`);
    if (STATUS.sudoReady === false) bits.push('restarts: no sudo - they are reported, not made');
    if (STATUS.overdue) bits.push(`nothing since ${fmtDateTime(STATUS.lastRunAt)} - check <span class="mono">deploy/install-hourly-debug.sh --status</span>`);
    el.innerHTML = bits.map((b) => (b.includes('<span') ? b : esc(b))).join(' · ');
  }

  function commitsHtml(r) {
    if (!r.commits?.length) return '';
    return `<div class="item-sub">Pushed to ${esc(r.pushedTo ?? 'main')}: ${r.commits.map((c) => (c.url
      ? `<a href="${esc(c.url)}" target="_blank" rel="noopener" class="mono">${esc(c.sha.slice(0, 7))}</a>`
      : `<span class="mono">${esc(c.sha.slice(0, 7))}</span>`) + ` ${esc(c.subject ?? '')}`).join(' · ')}</div>`;
  }

  /**
   * What the run only noted, by title: the rating digest, a settings note, a
   * disk getting full. Never researched, but the owner asked to see them.
   */
  function notedHtml(r) {
    return r.noted?.length ? `<div class="item-sub muted">Noted: ${r.noted.map(esc).join(' · ')}</div>` : '';
  }

  function runHtml(r) {
    const rs = r.restart?.outcome ?? 'not-needed';
    const restart = rs === 'not-needed' ? '' : `<span class="tag ${RESTART_CLASS[rs] ?? ''}" title="${esc(r.restart?.detail ?? '')}">restart: ${esc(r.restart?.words ?? rs)}</span>`;
    const research = r.claude?.outcome && !['not-needed', 'finished'].includes(r.claude.outcome)
      ? `<span class="tag pending" title="${esc(r.claude.detail ?? '')}">research: ${esc(r.claude.outcome)}</span>` : '';
    const report = r.hasReport
      ? `<a href="/api/hourly-checks/${encodeURIComponent(r.id)}/report" target="_blank" rel="noopener">full report →</a>` : '';
    const actions = r.userActions?.length
      ? `<div class="item-sub"><b>For you:</b> ${r.userActions.map(esc).join(' · ')}</div>` : '';
    const reruns = r.reruns?.length ? `<div class="item-sub">Re-run: ${r.reruns.map(esc).join(' · ')}</div>` : '';
    // The research session pushing by itself, which it is not able or
    // allowed to do: first thing on the run, since it needs a person.
    const alerts = (r.alerts ?? []).map((a) => `<div class="verdict bad">${esc(a)}</div>`).join('');
    const refused = r.refused?.length ? `<div class="item-sub">Not shipped: ${r.refused.map(esc).join(' · ')}</div>` : '';
    return `
      <div class="item compact">
        <div class="item-top">
          <span class="item-title">${esc(fmtDateTime(r.at))} — ${esc(r.headline ?? (r.found ? `${r.found} found` : 'all clear'))}</span>
          <span class="row gap">
            <span class="tag ${r.found ? 'failed' : 'done'}">${r.found ? `${r.found} found` : 'all clear'}</span>
            ${research}${restart}
          </span>
        </div>
        ${alerts}
        ${r.summary ? `<div class="item-sub">${esc(r.summary)}</div>` : ''}
        ${commitsHtml(r)}${refused}${reruns}${actions}${notedHtml(r)}
        <div class="item-sub">${report}${r.notices ? `${report ? ' · ' : ''}${r.notices} noted` : ''}${r.emailed === true ? ' · emailed' : r.emailed === false ? ' · email failed' : ''}</div>
      </div>`;
  }

  /** A stretch of all-clear hours is one line, unless every hour was asked for. */
  function quietHtml(group) {
    const first = group[group.length - 1], last = group[0];
    return `<div class="item compact"><div class="item-top"><span class="item-title muted">${group.length === 1
      ? `${esc(fmtDateTime(first.at))} — all clear`
      : `${esc(fmtDateTime(first.at))} to ${esc(fmtClock(last.at, HM))} — all clear, ${group.length} runs`}</span></div>`
      + `${group.length === 1 ? notedHtml(first) : ''}</div>`;
  }

  function render() {
    pill();
    statusLine();
    const box = $('hc-list');
    if (!box) return;
    if (!RUNS.length) { box.innerHTML = '<div class="empty">No runs yet.</div>'; return; }
    const everyHour = $('hc-all')?.checked;
    const out = [];
    let quiet = [];
    const flush = () => { if (quiet.length) out.push(quietHtml(quiet)); quiet = []; };
    for (const r of RUNS.slice(0, 96)) {
      // An all-clear hour that noted something keeps its own line, so what
      // it noted can be read.
      if (!everyHour && r.result === 'all-clear' && !r.found && !r.noted?.length) { quiet.push(r); continue; }
      flush();
      out.push(r.result === 'all-clear' ? quietHtml([r]) : runHtml(r));
    }
    flush();
    box.innerHTML = out.join('');
  }

  /* ---------------------------- CSV ---------------------------- */

  /*
   * The runs, for the "↓ CSV" button csv-export.js puts in this card's
   * heading - the card's one CSV control. The card was first written with a
   * "Download CSV" button of its own, and once csv-export.js was merged it
   * had two, saving different files. So it hands the shared button its runs
   * instead (the hook is described in csv-export.js), and the file comes out
   * like every other card's: YYYY-MM-DD HH:mm from the Date in each time
   * cell, the house column names and file name, the same secret sweep and
   * formula guard.
   *
   * Every run the server keeps, one row each: the card draws the last 96
   * and folds a quiet stretch into one line, and a file is for counting
   * them. Fetched afresh; if that fails, the runs the card has loaded.
   *
   * "What was noted" is the titles the card lists under a run ("Noted: …",
   * notedHtml) - the rating digest, a settings note, a disk getting full -
   * beside "Noted", which only counts them.
   */
  const COLUMNS = ['Time', 'Finished', 'Result', 'Found', 'Noted', 'What was noted', 'Headline', 'Summary', 'Research', 'Research detail',
    'Commits', 'Pushed to', 'Not shipped', 'Alerts', 'Restart', 'Restart detail', 'Re-runs', 'For you to do',
    'Emailed', 'Report'];
  const at = (t) => (t ? new Date(t) : '');
  const list = (xs) => (xs ?? []).join('; ');

  function csvRow(r) {
    return [
      at(r.at), at(r.finishedAt), r.result, r.found, r.notices, list(r.noted), r.headline, r.summary,
      r.claude?.outcome, r.claude?.detail,
      list((r.commits ?? []).map((c) => `${String(c.sha ?? '').slice(0, 7)} ${c.subject ?? ''}`.trim())), r.pushedTo,
      list(r.refused), list(r.alerts), r.restart?.words ?? r.restart?.outcome, r.restart?.detail, list(r.reruns),
      list(r.userActions), r.emailed === true ? 'yes' : r.emailed === false ? 'failed' : 'no',
      r.hasReport ? `/api/hourly-checks/${r.id}/report` : '',
    ];
  }

  async function csvTable() {
    let runs = RUNS;
    let note = '';
    try {
      runs = (await api('GET', '/hourly-checks?limit=500'))?.runs ?? [];
    } catch (err) {
      if (err?.handled || !RUNS.length) throw err;
      note = `the runs the card had loaded - the server said: ${err.message}`;
    }
    return { columns: COLUMNS, rows: runs.map(csvRow), note };
  }

  (window.panelCsvExporters ||= []).push({ sel: '#hc-list', slug: 'hourly-checks', run: csvTable });

  $('btn-hc-refresh')?.addEventListener('click', load);
  $('hc-all')?.addEventListener('change', render);

  const onLogsTab = () => document.getElementById('tab-logs')?.classList.contains('active');
  document.getElementById('tabs')?.addEventListener('click', (e) => {
    if (e.target.closest?.('.tab')?.dataset?.tab === 'logs') load();
  });
  setInterval(() => { if (onLogsTab() && Date.now() - loadedAt > 9 * 60_000) load(); }, 60_000);

  // For the tests, which run this file against the real markup.
  window.__hourlyChecks = { load, render, csvTable, runs: () => RUNS };
}());
