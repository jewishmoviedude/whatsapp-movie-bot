/* Settings -> Connection -> "Discord (read-only)".

   The operator, 2026-10-11: "create from scratch a way I can connect my
   discord account to the ubuntu so you can access it" - so that the hourly
   check sees what the Jellyfin host's staff answer in the support tickets.
   The server side is src/web/discord-routes.js; the reader itself is
   src/core/discord-watch.js.

   Its own file, loaded after app.js and using app.js's helpers ($, api, esc,
   fmtDateTime, CURRENT_USER), like hourly-checks.js. The panel is push-only
   over SSE and the reader runs every 30 minutes on its own, so the card loads
   its status when Settings is opened, after each of its buttons, and on
   Refresh - never on a timer, and never by asking Discord: only the buttons
   that say so (Connect, Load my servers, Show matching channels, Read now)
   reach Discord, each through the server.

   The token box is a password box, emptied as soon as Connect has been
   answered either way that saved it; the token never comes back from the
   server, so there is nothing to fill it with. */
(function discordCard() {
  const card = document.getElementById('card-discord');
  if (!card) return;

  let STATUS = null;
  let GUILDS = null;   // [{ id, name }] once loaded from Discord
  let loadedAt = 0;

  const note = (id, text, kind = '') => {
    const el = $(id);
    if (!el) return;
    const color = kind === 'bad' ? 'var(--danger)' : kind === 'good' ? 'var(--accent)' : 'inherit';
    el.innerHTML = text ? `<span style="color:${color}">${esc(text)}</span>` : '';
  };
  const when = (t) => (t ? fmtDateTime(t) : '—');
  /** "1 channel", "3 channels". */
  const count = (n, one, many = `${one}s`) => `${Number(n) || 0} ${Number(n) === 1 ? one : many}`;

  async function load({ quiet = false } = {}) {
    try {
      STATUS = await api('GET', '/discord');
      loadedAt = Date.now();
      render();
    } catch (err) {
      if (!quiet && !err?.handled) $('dc-status').innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`;
    }
  }

  function pill() {
    const p = $('dc-pill');
    if (!p) return;
    if (!STATUS?.connected) { p.className = 'pill'; p.textContent = 'not connected'; return; }
    if (STATUS.brokenSince) { p.className = 'pill bad'; p.textContent = 'disconnected - reconnect'; return; }
    if (STATUS.lastError) { p.className = 'pill warn'; p.textContent = 'reading failed'; return; }
    p.className = 'pill ok';
    p.textContent = STATUS.user?.username ? `connected as ${STATUS.user.username}` : 'connected';
  }

  function statusHtml() {
    const s = STATUS;
    if (!s?.connected) return 'Not connected. Nothing is read from Discord.';
    const who = s.user ? `<b>${esc(s.user.username ?? s.user.id)}</b>${s.user.name && s.user.name !== s.user.username ? ` (${esc(s.user.name)})` : ''}` : 'an account';
    const bits = [`Connected as ${who}${s.connectedAt ? ` since ${esc(when(s.connectedAt))}` : ''}.`];
    if (s.brokenSince) {
      bits.push(`<span style="color:var(--danger)"><b>Broken since ${esc(when(s.brokenSince))}</b>: ${esc(s.brokenWhy ?? 'Discord refused the token')}. `
        + 'The reader has stopped. Paste a new token and press Connect.</span>');
    }
    bits.push(`Last read: ${esc(when(s.lastReadAt))}, every ${esc(String(s.everyMinutes ?? 30))} minutes.`);
    if (s.lastRun && !s.brokenSince) {
      const r = s.lastRun;
      bits.push(`Last run: ${esc(count(r.requests, 'request'))}, ${esc(count(r.channels, 'channel'))} watched, `
        + `${esc(count(r.appended, 'new message'))}${r.private ? `, ${esc(count(r.private, 'channel'))} that are somebody else's skipped` : ''}.`);
    }
    if (s.lastError && !s.brokenSince) bits.push(`<span style="color:var(--warn)">Last problem (${esc(when(s.lastErrorAt))}): ${esc(s.lastError)}</span>`);
    return bits.join('<br>');
  }

  function renderGuilds() {
    const box = $('dc-guilds');
    if (!box) return;
    const saved = new Set(STATUS?.watch?.guilds ?? []);
    const names = { ...(STATUS?.guildNames ?? {}), ...Object.fromEntries((GUILDS ?? []).map((g) => [g.id, g.name])) };
    const draft = box.dataset.rendered === '1' ? new Set([...box.querySelectorAll('input.dc-g:checked')].map((i) => i.value)) : null;
    const chosen = draft ?? saved;
    // Every server Discord listed, and every saved one even when the list has
    // not been loaded: saving must never drop a server nobody unticked.
    const ids = [...new Set([...(GUILDS ?? []).map((g) => g.id), ...saved])];
    if (!ids.length) {
      box.innerHTML = `<div class="empty">${STATUS?.connected ? 'Press "Load my servers" to choose the host\'s server.' : 'Connect, then load your servers.'}</div>`;
      return;
    }
    box.innerHTML = ids.map((id) => `<label class="check"><input type="checkbox" class="dc-g" value="${esc(id)}"${chosen.has(id) ? ' checked' : ''}>
      <span>${esc(names[id] ?? 'a server not in the list just loaded')} <span class="muted small">${esc(id)}</span></span></label>`).join('');
    box.dataset.rendered = '1';
  }

  function renderRecent() {
    const box = $('dc-recent');
    if (!box) return;
    const recent = STATUS?.recent ?? [];
    box.innerHTML = recent.length ? recent.map((m) => `<div class="item"><div>
        <div class="item-title">#${esc(m.channelName ?? '?')}${m.guildName ? ` <span class="muted small">on ${esc(m.guildName)}</span>` : ''}</div>
        <div class="item-sub">${esc(fmtDateTime(m.at))} · <b>${esc(m.who ?? 'someone')}</b>${m.fromMe ? ' (you)' : m.bot ? ' (bot)' : ''}: ${esc(m.text)}</div>
      </div></div>`).join('')
      : '<div class="empty">Nothing read yet.</div>';
  }

  function render() {
    pill();
    $('dc-status').innerHTML = statusHtml();
    const connected = !!STATUS?.connected;
    $('dc-disconnect')?.classList.toggle('hidden', !connected);
    $('dc-connect').textContent = connected ? (STATUS.brokenSince ? 'Reconnect' : 'Replace token') : 'Connect';
    if (!$('dc-pattern').value) $('dc-pattern').value = STATUS?.watch?.channelPattern ?? '^ticket-';
    if (!$('dc-channels').value) $('dc-channels').value = (STATUS?.watch?.channels ?? []).join(', ');
    // A token Discord has refused is not offered to it again: the buttons that
    // would ask Discord something wait for a new token and Connect (the server
    // refuses them too, 409). Saving what to read asks Discord nothing.
    const dead = !!STATUS?.brokenSince;
    for (const id of ['dc-load-guilds', 'dc-watch-save', 'dc-preview', 'dc-read-now']) {
      const b = $(id);
      if (b) b.disabled = !connected || !STATUS?.canChange || (dead && id !== 'dc-watch-save');
    }
    renderGuilds();
    renderRecent();
  }

  async function connect() {
    const token = $('dc-token').value.trim();
    if (!token) { note('dc-note', 'Paste the token first.', 'bad'); return; }
    note('dc-note', 'Asking Discord who this is…');
    try {
      STATUS = await api('POST', '/discord/connect', { token });
      $('dc-token').value = '';
      note('dc-note', `Connected as ${STATUS.user?.username ?? 'the account'}.`, 'good');
      render();
    } catch (err) {
      note('dc-note', err.message, 'bad');
    }
  }

  async function disconnect() {
    if (!confirm('Disconnect Discord? The token is wiped from this machine and nothing more is read. '
      + 'To revoke the token itself, change your Discord password or log out of all devices.')) return;
    try {
      STATUS = await api('POST', '/discord/disconnect');
      GUILDS = null;
      note('dc-note', 'Disconnected. The token is wiped from this machine.', 'good');
      render();
    } catch (err) {
      note('dc-note', err.message, 'bad');
    }
  }

  async function loadGuilds() {
    note('dc-watch-note', 'Asking Discord for your servers…');
    try {
      GUILDS = (await api('GET', '/discord/guilds')).guilds ?? [];
      note('dc-watch-note', `${count(GUILDS.length, 'server')}. Tick the host's.`, 'good');
      renderGuilds();
    } catch (err) {
      note('dc-watch-note', err.message, 'bad');
    }
  }

  const chosenGuilds = () => [...document.querySelectorAll('#dc-guilds input.dc-g:checked')].map((i) => i.value);
  const channelIds = () => $('dc-channels').value.split(/[,\s;]+/).map((x) => x.trim()).filter(Boolean);

  async function saveWatch() {
    const body = { guilds: chosenGuilds(), channelPattern: $('dc-pattern').value.trim() || '^ticket-', channels: channelIds() };
    try {
      STATUS = await api('PUT', '/discord/watch', body);
      $('dc-guilds').dataset.rendered = '';
      note('dc-watch-note', `Saved: ${count(body.guilds.length, 'server')}, channels named /${body.channelPattern}/`
        + `${body.channels.length ? `, and ${count(body.channels.length, 'channel id')}` : ''}.`, 'good');
      render();
    } catch (err) {
      note('dc-watch-note', err.message, 'bad');
    }
  }

  async function preview() {
    const box = $('dc-matches');
    const guilds = chosenGuilds();
    if (!guilds.length) { note('dc-watch-note', 'Tick a server first.', 'bad'); return; }
    note('dc-watch-note', 'Asking Discord for the channels…');
    try {
      const pattern = $('dc-pattern').value.trim() || '^ticket-';
      const parts = [];
      // One server per call: the route is held to one call every few seconds.
      const d = await api('GET', `/discord/channels?guild=${encodeURIComponent(guilds[0])}&pattern=${encodeURIComponent(pattern)}`);
      for (const g of d.guilds ?? []) {
        const rows = (g.channels ?? []).map((c) => `<div class="item"><div>
            <div class="item-title">#${esc(c.name)}${c.read ? ' <span class="tag done">read before</span>' : ''}${c.visible ? '' : ' <span class="tag">somebody else\'s - skipped</span>'}</div>
            <div class="item-sub">${c.lastMessageAt ? `last message ${esc(fmtDateTime(c.lastMessageAt))}` : 'no messages'} · <span class="muted">${esc(c.id)}</span></div>
          </div></div>`);
        parts.push(`<div class="item-sub"><b>${esc(g.guildName ?? g.guild)}</b>: ${esc(count(rows.length, 'channel'))} named /${esc(d.pattern)}/</div>${rows.join('')}`);
      }
      box.innerHTML = parts.join('') || '<div class="empty">No channel matches.</div>';
      note('dc-watch-note', guilds.length > 1 ? 'Shown for the first server ticked.' : '');
    } catch (err) {
      note('dc-watch-note', err.message, 'bad');
    }
  }

  async function readNow() {
    note('dc-watch-note', 'Reading…');
    try {
      const d = await api('POST', '/discord/read-now');
      STATUS = d;
      const r = d.result ?? {};
      note('dc-watch-note', r.skipped ? `Not read: ${r.skipped}.` : `${count(r.appended, 'new message')} from ${count(r.channels, 'channel')}, `
        + `${count(r.requests, 'request')}${r.errors?.length ? ` - ${r.errors.join('; ')}` : ''}.`, r.ok === false ? 'bad' : 'good');
      render();
    } catch (err) {
      note('dc-watch-note', err.message, 'bad');
    }
  }

  $('dc-connect')?.addEventListener('click', connect);
  $('dc-disconnect')?.addEventListener('click', disconnect);
  $('dc-load-guilds')?.addEventListener('click', loadGuilds);
  $('dc-watch-save')?.addEventListener('click', saveWatch);
  $('dc-preview')?.addEventListener('click', preview);
  $('dc-read-now')?.addEventListener('click', readNow);
  $('dc-refresh')?.addEventListener('click', () => load());

  // Loaded when Settings is opened (at most once a minute), not before: a
  // signed-out page has nothing to ask, and a plain admin may never look.
  document.getElementById('tabs')?.addEventListener('click', (e) => {
    if (e.target.closest?.('.tab')?.dataset?.tab === 'settings' && Date.now() - loadedAt > 60_000) load({ quiet: true });
  });

  // For the tests, which run this file against the real markup.
  window.__discordCard = { load, render, connect, disconnect, loadGuilds, saveWatch, preview, readNow, status: () => STATUS };
}());
