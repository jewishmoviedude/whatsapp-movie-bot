/* The History tab's "Wanted" card: films people asked for that the server
   does not have.

   The operator, 2026-10-11, looking at it: "give me a mark as resolved so
   other admins and you know as well as a box to add notes for you to review
   on the hour". So each entry has Mark resolved, and a notes box with Save.
   A resolved entry leaves the open list for a collapsed "Resolved" section
   under it, the newest first, saying who resolved it and when (the bot
   resolves what it finds on the server), with Reopen; it is kept 30 days.
   Each note shows who wrote it and when; an admin can delete their own, the
   super-admin any. The hourly check reads every new note as an instruction
   about that film, and every entry an admin resolved (incident-scan.js).

   It lives in a file of its own, loaded after app.js and using app.js's
   helpers ($, api, esc, fmtDateTime, phoneOut, toast, CURRENT_USER), as the
   Hourly checks card does. The panel is push-only over SSE: app.js hands this
   card the server's 'wanted' event (any admin's change, a request, the
   recheck), and the card reloads, keeping whatever is being typed in a notes
   box. It also reloads when the History tab is opened. Refresh first asks the
   server to look every film up in the library (POST /api/wanted/recheck),
   then reloads. Every time shown goes through fmtDateTime, the 24-hour
   clock.

   And what is done when a film arrives (src/core/wanted-arrival.js; the
   operator, 2026-10-11: once a film is available, queue it for whoever
   asked and react on their message). What says it is available is the
   bot's own recheck finding it in the library. The card's switch is
   wanted.rerunOnArrival (POST /api/wanted/settings). An entry shows what
   came of the recheck's find and what each re-run came to; a resolved one
   has "Re-run requests" (POST /api/wanted/:key/rerun), for a film resolved
   before the bot re-ran arrivals by itself, or by an admin or a new
   request - the operator chooses which. */
(function wantedCard() {
  const card = document.getElementById('card-wanted');
  if (!card) return;

  const MAX_NOTE = 2000;
  let OPEN = [];
  let RESOLVED = [];
  // What is typed in each entry's notes box, by the entry's key. A reload -
  // any admin's change, pushed - redraws the card, and must not throw away a
  // note half written.
  const drafts = new Map();
  let reloadTimer = null;

  const keyOf = (el) => el?.closest?.('.wanted-entry')?.getAttribute('data-key') ?? null;
  // CURRENT_USER is app.js's; a page without it shows no Delete buttons, and
  // the server decides either way.
  const me = () => (typeof CURRENT_USER === 'undefined' ? null : CURRENT_USER);
  const mayDelete = (n) => {
    const u = me();
    return !!u && (u.role === 'superadmin' || String(n.by ?? '').toLowerCase() === String(u.username ?? '').toLowerCase());
  };

  function noteHtml(n) {
    return `
          <div class="wanted-note${n.auto ? ' by-bot' : ''}" data-note="${esc(n.id)}">
            <div class="small muted">${esc(n.by)} · ${esc(fmtDateTime(n.at))}${mayDelete(n)
              ? ' <button class="btn tiny" data-wanted="del-note" title="Delete this note">Delete</button>' : ''}</div>
            <div class="wanted-note-text">${esc(n.text)}</div>
          </div>`;
  }

  // What a re-run came to, in a word: the film is on its way, or the member
  // still needs telling. 'already-posted' is a member whose film was posted
  // since with another request: their message was marked done rather than
  // the film posted twice. 'waiting' is a member a stopped batch left for
  // the next pass (src/core/wanted-arrival.js).
  const ON_ITS_WAY = ['queued', 'working', 'sent', 'duplicate'];
  function rerunHtml(r) {
    const who = String(r.requester ?? '').trim() || phoneOut(r.number) || 'a member';
    const what = r.outcome === 'skipped' ? `not re-run - ${r.why ?? '?'}`
      : r.outcome === 'waiting' ? `waiting - ${r.why ?? 're-run at the next pass'}`
        : r.outcome === 'already-posted' ? `already posted${r.detail ? ` (${r.detail})` : ''} - marked done`
          : ON_ITS_WAY.includes(r.outcome) ? `re-run: ${r.outcome}` : `re-run: ${r.outcome}${r.detail ? ` (${r.detail})` : ''} - still to tell`;
    return `<div class="item-sub wanted-rerun">${esc(who)}: ${esc(what)} · ${esc(fmtDateTime(r.at))}${
      r.trigger === 'manual' && r.by ? ` · by ${esc(r.by)}` : ''}</div>`;
  }

  // The recheck's find, and what the re-runs made of it. One settled as
  // 'left for an admin' was resolved before the bot re-ran arrivals by
  // itself, and is said so: its time is when it was resolved.
  function arrivalHtml(a) {
    if (!a) return '';
    const before = a.settled?.outcome === 'left for an admin';
    const settled = a.settled ? ` · ${esc(a.settled.outcome)}${a.settled.detail ? ` (${esc(a.settled.detail)})` : ''}`
      : ' · its requests are re-run at the next pass';
    return `<div class="item-sub wanted-arrival">${before ? 'Resolved before re-runs began' : 'Found on the server by the recheck'}${
      a.at ? ` · ${esc(fmtDateTime(a.at))}` : ''}${settled}</div>`;
  }

  function entryHtml(w) {
    const notes = (w.notes ?? []).map(noteHtml).join('');
    const reruns = (w.reruns ?? []).slice(-6).map(rerunHtml).join('');
    return `
      <div class="item compact wanted-entry${w.resolved ? ' resolved' : ''}" data-key="${esc(w.key)}">
        <div class="item-top">
          <span class="item-title">${esc(w.title)}${w.year ? ` <span class="muted">(${esc(w.year)})</span>` : ''}</span>
          <span class="row gap">
            <span class="tag">${esc(w.count)}x asked</span>
            ${w.reason === 'not-yet-theatrical' ? '<span class="tag">in cinemas</span>' : ''}
            ${w.resolved
              ? '<button class="btn small" data-wanted="rerun" title="Run each request answered &quot;not in the library&quot; for it again, on the member\'s own message">Re-run requests</button>'
                + ' <button class="btn small" data-wanted="reopen">Reopen</button>'
              : '<button class="btn small" data-wanted="resolve">Mark resolved</button>'}
          </span>
        </div>
        <div class="item-sub">${w.imdbId ? esc(w.imdbId) : ''}${
          w.requesters?.length ? ` · ${esc(w.requesters.slice(0, 3).map(phoneOut).join(', '))}` : ''}</div>
        ${w.resolved ? `<div class="item-sub wanted-resolved-by">Resolved by ${esc(w.resolved.by)} · ${esc(fmtDateTime(w.resolved.at))}</div>` : ''}
        ${arrivalHtml(w.arrival)}
        ${w.rerunPending ? `<div class="item-sub wanted-rerun-pending">Re-run requests by ${esc(w.rerunPending.by ?? 'an admin')} · ${
          esc(fmtDateTime(w.rerunPending.at))} · not finished: the rest go one at a time, or at the next pass</div>` : ''}
        ${reruns ? `<div class="wanted-reruns">${reruns}</div>` : ''}
        ${notes ? `<div class="wanted-notes">${notes}</div>` : ''}
        <div class="wanted-note-add">
          <textarea class="wanted-note-box" rows="2" maxlength="${MAX_NOTE}"
            placeholder="A note for the other admins - and for the hourly check, which reads it as an instruction about this film">${esc(drafts.get(w.key) ?? '')}</textarea>
          <button class="btn small" data-wanted="note">Save</button>
        </div>
      </div>`;
  }

  function render() {
    const box = $('wanted-list');
    if (!box) return;
    // The notes box being typed in, so the redraw can put the caret back.
    const active = document.activeElement?.classList?.contains('wanted-note-box') ? document.activeElement : null;
    const focus = active ? { key: keyOf(active), start: active.selectionStart, end: active.selectionEnd } : null;

    const status = OPEN.length ? `${OPEN.length} title(s) people asked for` : 'nothing outstanding';
    $('wanted-status').textContent = RESOLVED.length ? `${status} · ${RESOLVED.length} resolved in the last 30 days` : status;
    box.innerHTML = OPEN.length ? OPEN.map(entryHtml).join('') : '<div class="empty">Everything asked for is on the server.</div>';
    $('wanted-resolved-box')?.classList.toggle('hidden', !RESOLVED.length);
    if ($('wanted-resolved-count')) $('wanted-resolved-count').textContent = String(RESOLVED.length);
    if ($('wanted-resolved')) $('wanted-resolved').innerHTML = RESOLVED.map(entryHtml).join('');

    if (focus?.key) {
      const again = [...card.querySelectorAll('.wanted-entry')].find((el) => el.getAttribute('data-key') === focus.key)
        ?.querySelector('.wanted-note-box');
      if (again) {
        again.focus?.();
        try { again.setSelectionRange?.(focus.start, focus.end); } catch { /* not every element takes one */ }
      }
    }
  }

  async function load() {
    clearTimeout(reloadTimer);
    reloadTimer = null;
    try {
      const d = await api('GET', '/wanted');
      OPEN = d?.wanted ?? [];
      RESOLVED = d?.resolved ?? [];
      // The switch shows the saved setting; on by default, as schema.js has it.
      const sw = $('wanted-rerun-on-arrival');
      if (sw) sw.checked = d?.settings?.rerunOnArrival !== false;
      render();
    } catch (err) {
      const box = $('wanted-list');
      if (box) box.innerHTML = `<div class="verdict bad">${esc(err.message)}</div>`;
    }
  }

  /** The server said the list changed. Several changes at once (a recheck finding three) are one reload. */
  function changed() {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(load, 400);
  }

  async function refresh() {
    const btn = $('btn-wanted-refresh');
    if (btn) btn.disabled = true;
    $('wanted-status').textContent = 'looking every film up in the library…';
    try {
      const r = await api('POST', '/wanted/recheck');
      const n = r?.found?.length ?? 0;
      toast(n ? `${n} on the server now - marked resolved` : 'Nothing on the list has turned up on the server');
    } catch (err) {
      if (!err.handled) toast(`The library check did not run: ${err.message}`, true);
    } finally {
      if (btn) btn.disabled = false;
    }
    await load();
  }

  card.addEventListener('input', (e) => {
    if (!e.target?.classList?.contains('wanted-note-box')) return;
    const key = keyOf(e.target);
    if (key) drafts.set(key, e.target.value);
  });

  card.addEventListener('click', async (e) => {
    const btn = e.target?.closest?.('[data-wanted]');
    const key = keyOf(btn);
    if (!btn || !key) return;
    const k = encodeURIComponent(key);
    const what = btn.getAttribute('data-wanted');
    btn.disabled = true;
    try {
      if (what === 'resolve') {
        await api('POST', `/wanted/${k}/resolve`);
        toast('Marked resolved');
      } else if (what === 'reopen') {
        await api('POST', `/wanted/${k}/reopen`);
        toast('Reopened');
      } else if (what === 'rerun') {
        const title = btn.closest('.wanted-entry')?.querySelector('.item-title')?.textContent?.trim() ?? 'this film';
        if (!confirm(`Re-run every request answered "not in the library" for ${title}, on each member's own message? `
          + 'Each goes through the usual checks, one at a time.')) return;
        const r = await api('POST', `/wanted/${k}/rerun`);
        const n = r?.run?.length ?? 0;
        const left = (r?.skipped ?? []).map((s) => `${s.requester ?? s.number} (${s.why})`).join('; ');
        toast(n ? `Re-running ${n} request(s)${left ? ` - not: ${left}` : ''}` : `Nothing to re-run${left ? `: ${left}` : ''}`);
      } else if (what === 'note') {
        const text = btn.closest('.wanted-entry')?.querySelector('.wanted-note-box')?.value ?? '';
        if (!text.trim()) { toast('Write the note first', true); return; }
        await api('POST', `/wanted/${k}/notes`, { text });
        drafts.delete(key);
        toast('Note saved');
      } else if (what === 'del-note') {
        const id = btn.closest('[data-note]')?.getAttribute('data-note');
        if (!id || !confirm('Delete this note?')) return;
        await api('DELETE', `/wanted/${k}/notes/${encodeURIComponent(id)}`);
        toast('Note deleted');
      } else {
        return;
      }
      await load();
    } catch (err) {
      if (!err.handled) toast(err.message, true);
      // Gone, or changed under us by another admin: show the list as it is.
      if (err.status === 404 || err.status === 409) load();
    } finally {
      btn.disabled = false;
    }
  });

  $('btn-wanted-refresh')?.addEventListener('click', refresh);
  // wanted.rerunOnArrival: put back as it was when the save is refused.
  // The box is held before the save is awaited: an event's target is not
  // kept once its dispatch is over, and a refused save could not be undone.
  $('wanted-rerun-on-arrival')?.addEventListener('change', async (e) => {
    const box = e.target;
    const on = !!box.checked;
    try {
      await api('POST', '/wanted/settings', { rerunOnArrival: on });
      toast(on ? 'A film that arrives will have its requests re-run' : 'A film that arrives will only be marked resolved');
    } catch (err) {
      box.checked = !on;
      if (!err.handled) toast(err.message, true);
    }
  });
  $('btn-wanted-clear')?.addEventListener('click', async () => {
    if (!confirm('Clear the wanted list, resolved films and notes included? Anything still missing will reappear the next time someone asks for it.')) return;
    try {
      await api('DELETE', '/wanted');
      drafts.clear();
      toast('Wanted list cleared');
    } catch (err) {
      if (!err.handled) toast(err.message, true);
    }
    load();
  });
  document.getElementById('tabs')?.addEventListener('click', (e) => {
    if (e.target.closest?.('.tab')?.getAttribute('data-tab') === 'history') load();
  });

  // app.js loads the card when the panel opens (enterApp), and hands it the
  // SSE push. This file can run after enterApp has: then it loads itself.
  window.__wanted = { load, changed, refresh, render, state: () => ({ open: OPEN, resolved: RESOLVED, drafts }) };
  if (me() && !document.getElementById('app')?.classList.contains('hidden')) load();
}());
