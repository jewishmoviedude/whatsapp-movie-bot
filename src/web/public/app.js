/* Control panel front-end. Vanilla JS on purpose: no build step, no toolchain
   to maintain on the server, and it stays fast on a small box. */

const $ = (id) => document.getElementById(id);
const api = async (method, url, body) => {
  const res = await fetch(`/api${url}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }

  if (!res.ok) {
    // A lapsed session must not be reported as "unauthorized" against
    // whatever button was pressed - that reads as the credentials being
    // wrong when the real problem is simply being logged out.
    // 440 is the idle sign-out; 401 is any other lapsed session.
    if ((res.status === 401 || res.status === 440) && !url.startsWith('/auth/')) {
      sessionExpired();
      throw Object.assign(new Error(res.status === 440
        ? (data?.message ?? 'Signed out after a period of inactivity')
        : 'Your session expired — please sign in again'),
      { status: res.status, handled: true });
    }
    // An account given a temporary password that has not yet chosen its own:
    // the server refuses everything else, so go to the screen that fixes it.
    if (res.status === 403 && data?.error === 'password-change-required') {
      showPasswordChange(CURRENT_USER);
      throw Object.assign(new Error('Choose your own password first'), { status: 403, handled: true });
    }
    // A settings save that would change many settings across sections at
    // once is held until somebody looks at the list and says yes
    // (sweepingChange in src/config/store.js): asked here, so every Save that
    // goes through PUT /config asks the same way. The answer is the
    // fingerprint of exactly the changes shown; if the settings move in
    // between, the server asks again with the new list.
    if (res.status === 409 && data?.confirm && method === 'PUT' && (url === '/config' || url.startsWith('/config?'))
        && confirmSweep(data.changes ?? [])) {
      return api(method, `${url}${url.includes('?') ? '&' : '?'}confirm=${encodeURIComponent(data.confirm)}`, body);
    }
    throw Object.assign(new Error(data?.error ?? res.statusText), { status: res.status, data });
  }
  // Every config round-trip comes through here: the first load, and the seven
  // save buttons that each PUT their own slice and get the whole masked config
  // back. Refreshing the fresh-install checklist from this one place means a
  // save button added later cannot forget to. It is deferred a tick, so the
  // caller's `CONFIG = await api(...)` has landed before the checklist reads it.
  if (url === '/config' || url.startsWith('/config?')) refreshFreshInstall();
  return data;
};

/** The list a held settings save would change, put to the person saving. Cancel saves nothing. */
function confirmSweep(changes) {
  const shown = changes.slice(0, 30).map((c) => `• ${c}`);
  if (changes.length > shown.length) shown.push(`… and ${changes.length - shown.length} more (the audit log has them all)`);
  return confirm(`This save would change ${changes.length} settings at once:\n\n${shown.join('\n')}\n\n`
    + 'Save all of them? Cancel saves nothing.');
}

let gateShownForExpiry = false;
function sessionExpired() {
  if (gateShownForExpiry) return;
  gateShownForExpiry = true;
  SETUP_MODE = false;
  $('gate-title').textContent = 'Signed out';
  $('gate-sub').textContent = 'Your session ended. Sign in to continue.';
  $('gate-pw').value = '';
  $('gate-pw2').classList.add('hidden');
  $('gate-pw2').disabled = true;      // a disabled field is ignored by password managers
  $('gate-btn').textContent = 'Sign in';
  $('gate-err').textContent = '';
  showGate();
}

let CONFIG = null;
let GROUPS = [];
let SETUP_MODE = false;

/* ------------------------------ toast ------------------------------ */
let toastTimer;
function toast(msg, bad = false) {
  const el = $('toast');
  el.textContent = msg;
  el.className = `toast show${bad ? ' bad' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 3200);
}

/* ------------------------------ gate ------------------------------- */
let CURRENT_USER = null;

async function boot() {
  const status = await api('GET', '/auth/status');
  if (status.setupRequired) {
    SETUP_MODE = true;
    $('gate-title').textContent = 'Set a super-admin password';
    $('gate-sub').textContent = 'First run — create the super-admin login (username is "superadmin"). At least 8 characters.';
    $('gate-user').classList.add('hidden');
    $('gate-pw').placeholder = 'New password';
    $('gate-pw').autocomplete = 'new-password';
    $('gate-pw2').classList.remove('hidden');
    $('gate-pw2').disabled = false;
    $('gate-btn').textContent = 'Create';
    showGate();
  } else if (!status.authed) {
    $('gate-user').classList.remove('hidden');
    showGate();
  } else if (status.user?.mustChangePassword) {
    CURRENT_USER = status.user;
    showPasswordChange(status.user);
  } else {
    CURRENT_USER = status.user;
    await enterApp();
  }
}

/**
 * The account signed in with a password a super-admin set for it, and must
 * choose its own before the panel opens (the operator, 2026-10-08). The
 * server refuses everything else until it does; this is the screen for it.
 * `temp` is the password just typed at sign-in, so it is not asked for twice;
 * after a reload it is not known, and the field is shown.
 */
let TEMP_PASSWORD = null;
function showPasswordChange(user, temp = null) {
  TEMP_PASSWORD = temp;
  $('gate-title').textContent = 'Choose your own password';
  $('gate-sub').textContent = `${user?.username ?? 'This account'} was given a temporary password. `
    + 'Pick your own to continue: at least 8 characters.';
  $('gate-form').classList.add('hidden');
  $('chpw-gate-form').classList.remove('hidden');
  $('chpw-gate-user').value = user?.username ?? '';
  $('chpw-gate-cur').classList.toggle('hidden', !!temp);
  $('chpw-gate-cur').required = !temp;
  $('chpw-gate-err').textContent = '';
  $('gate').classList.remove('hidden');
  $('app').classList.add('hidden');
  setTimeout(() => $(temp ? 'chpw-gate-new' : 'chpw-gate-cur').focus(), 60);
}

$('chpw-gate-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const cur = TEMP_PASSWORD ?? $('chpw-gate-cur').value;
  const next = $('chpw-gate-new').value;
  const bad = (m) => { $('chpw-gate-err').textContent = m; };
  if (!cur) return bad('Enter the temporary password you were given');
  if (next !== $('chpw-gate-new2').value) return bad('The two new passwords do not match');
  if (next.length < 8) return bad('The new password must be at least 8 characters');
  if (next === cur) return bad('Choose a password different from the temporary one');
  try {
    await api('POST', '/auth/password', { current: cur, next });
    TEMP_PASSWORD = null;
    CURRENT_USER = { ...CURRENT_USER, mustChangePassword: false };
    $('chpw-gate-form').reset();
    $('gate').classList.add('hidden');
    toast('Password set');
    await enterApp();
  } catch (err) {
    bad(err.message);
  }
});

$('chpw-gate-out').addEventListener('click', async () => {
  await api('POST', '/auth/logout');
  location.reload();
});

function showGate() {
  $('gate').classList.remove('hidden');
  $('app').classList.add('hidden');
  setTimeout(() => $('gate-pw').focus(), 60);
}

$('gate-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pw = $('gate-pw').value;
  $('gate-err').textContent = '';
  try {
    let r;
    if (SETUP_MODE) {
      if (pw !== $('gate-pw2').value) { $('gate-err').textContent = 'Passwords do not match'; return; }
      r = await api('POST', '/auth/setup', { password: pw });
    } else {
      r = await api('POST', '/auth/login', { username: $('gate-user').value.trim(), password: pw });
    }
    CURRENT_USER = r.user ?? null;
    if (r.user?.mustChangePassword) { showPasswordChange(r.user, pw); return; }
    $('gate').classList.add('hidden');
    gateShownForExpiry = false;
    await enterApp();
  } catch (err) {
    $('gate-err').textContent = err.message;
  }
});

$('btn-logout').addEventListener('click', async () => {
  await api('POST', '/auth/logout');
  location.reload();
});

async function enterApp() {
  $('app').classList.remove('hidden');
  applyUser();
  await loadConfig();
  loadAdmins();
  loadAudit();
  loadMisses();
  loadOverrides();
  loadLockdown();
  loadBanned();
  loadMembersRoster();
  loadEnforcement();
  loadTvSection();
  loadBetaSection();
  loadDirectLinks();
  loadLinkQueue();
  loadAccounts();
  loadFailover();
  loadCatalogue();
  // wanted.js; when it runs after this, it loads itself.
  window.__wanted?.load();
  setTimeout(initPortalNav, 120);
  await Promise.all([loadGroups(), loadDiagnostics(), loadHistory(), loadLogs(), loadLogFiles(), loadTransfers(), loadGroupActivity()]);
  connectEvents();
}

/* ------------------------------ tabs ------------------------------- */
/**
 * Switch tabs from code: the "open full log →" links, the checklist's rows,
 * the header's search. Exactly a press of the tab, so it opens at its top the
 * way a press does; a caller that lands on something in the tab does that
 * afterwards.
 */
function goTab(name) {
  const btn = document.querySelector(`.tab[data-tab="${name}"]`);
  // Not when it is showing already: a second press is "back to the top", the
  // wrong way to start for a link about to land further down the same tab.
  if (btn && !btn.classList.contains('active')) btn.click();
}

document.addEventListener('click', (e) => {
  const link = e.target.closest('.card-link');
  if (!link) return;
  e.preventDefault();
  const target = link.dataset.target;
  goTab(link.dataset.goto);
  // A link may also name the exact card or field to land on, as every row of
  // the fresh-install checklist does. It waits out the same delay as the search
  // box: switching tab makes the jump-nav put back the last settings group a
  // moment later, which would otherwise hide the group just revealed.
  if (target) setTimeout(() => revealInPage(null, document.querySelector(target)), 60);
});

$('tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  const again = btn.classList.contains('active');
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === btn));
  document.querySelectorAll('.panel').forEach((p) => {
    p.classList.toggle('active', p.id === `tab-${btn.dataset.tab}`);
  });
  // A tab opens at its top. Only Settings did, by way of its chip row; every
  // other tab kept the page's offset from the tab before. Pressed from 4,000
  // px down Settings, Groups opened 4,000 px down its own page, in the middle
  // of the lockdown card's list of groups, and Members, History, Logs and the
  // Dashboard the same way: the tab changed, and what showed was whichever of
  // its cards sat at that depth, often the last. At once when the tab changes,
  // since the old offset belongs to another page and there is nothing to
  // watch go by; smoothly for the tab already showing, which is "back to the
  // top", as Settings always did it.
  scrollToTop({ smooth: again });
  showInStrip(btn);
});

/**
 * Slide a row that scrolls sideways - the tabs, the chips - so `btn` is in it.
 *
 * On a phone neither row fits: the tabs run 349 px past the right-hand edge
 * and the Settings chips 551. A link that opened Logs, or a checklist row that
 * switched to System, lit a tab or a chip nobody could see. Only the row
 * moves, never the page (scrollIntoView would move both, and could stop a
 * landing already under way).
 */
function showInStrip(btn) {
  const bar = btn?.parentElement;
  if (!bar || !(bar.scrollWidth > bar.clientWidth)) return;
  const b = btn.getBoundingClientRect();
  const r = bar.getBoundingClientRect();
  if (b.left >= r.left && b.right <= r.right) return;
  bar.scrollLeft += (b.left + b.width / 2) - (r.left + r.width / 2);
}

/* ----------------------------- config ------------------------------ */
async function loadConfig() {
  CONFIG = await api('GET', '/config');
  // Every box is about to show what is saved, so nothing on it is an edit.
  FORM_EDITED.clear();
  fillForm(CONFIG);
  renderReactionGuide(CONFIG.movieRequests?.reactions);
}

function fillForm(c) {
  const wa = c.whatsapp, mr = c.movieRequests, lib = c.library, md = c.media;

  fillPhoneOptions(wa);
  $('f-phone').value = wa.phoneNumber ?? '';
  $('f-loginmethod').value = wa.loginMethod ?? 'qr';
  $('f-autoreconnect').checked = !!wa.autoReconnect;
  $('f-markonline').checked = !!wa.markOnline;
  $('f-mindelay').value = wa.minActionDelayMs;
  $('f-maxdelay').value = wa.maxActionDelayMs;

  // The group pickers and the two notification boxes are filled here, with the
  // rest of the saved config, and not only when the group list arrives: until
  // then they held the page's defaults, and a save in that window sent "no
  // group" and "do not tag" - see renderMovieGroupPickers.
  renderMovieGroupPickers();
  renderLibraryNewsCard({ fresh: true });
  $('f-notifytag').checked = mr.notify?.tagRequester !== false;
  // Shown as +digits, the way every number is; saved as digits (below).
  $('f-notify-notag').value = (mr.notify?.noTag ?? []).map(phoneOut).join('\n');

  $('f-blocked').value = (mr.blockedRatings ?? []).join(', ');
  $('f-requireprefix').checked = !!mr.requirePrefix;
  $('f-prefix').value = mr.prefix ?? '';
  $('f-replyonblock').checked = !!mr.replyOnBlock;
  $('f-requireyear').checked = !!mr.requireYearWhenAmbiguous;
  $('f-maxqueue').value = mr.maxQueueLength;
  $('f-rules').value = mr.rules ?? '';
  $('f-rules-cmd').value = mr.rulesCommand ?? '#rules';
  $('f-cooldown').value = mr.cooldownSecondsPerUser;
  $('f-cooldown-others').checked = !!mr.cooldownOnlyWhenOthersWait;

  const r = mr.reactions ?? {};
  $('r-researching').value = r.researching ?? '';
  $('r-added').value = r.added ?? '';
  $('r-downloading').value = r.downloading ?? '';
  $('r-converting').value = r.converting ?? '';
  $('r-sending').value = r.sending ?? '';
  $('r-positions').value = (r.positions ?? []).join(', ');
  $('r-posoverflow').value = r.positionOverflow ?? '';
  $('r-skipped').value = r.skipped ?? '';
  $('r-rated').value = r.rated ?? '';
  $('r-theaters').value = r.theaters ?? '';
  $('r-notfound').value = r.notFound ?? '';
  $('r-writtenwrong').value = r.writtenWrong ?? '';
  $('r-needyear').value = r.needYear ?? '';
  $('r-notinlibrary').value = r.notInLibrary ?? '';
  $('r-duplicate').value = r.duplicate ?? '';
  $('r-done').value = r.done ?? '';
  $('r-failed').value = r.failed ?? '';

  const th = mr.theatrical ?? {};
  $('f-th-enabled').checked = !!th.enabled;
  $('f-th-usedvd').checked = !!th.useHomeReleaseDate;
  $('f-th-window').value = th.windowDays;

  // The API keys section's own boxes. They are filled through fillKeyBox
  // because this function runs after every save, including saves that do not
  // own these fields.
  fillKeyBox('f-tmdbkey', th.tmdbApiKey);
  fillKeyBox('f-omdbkey', c.omdb?.apiKey);
  fillKeyBox('f-gemini-key', c.gemini?.apiKey);
  fillKeyBox('f-gemini-model', c.gemini?.model ?? '');
  fillKeyBox('f-dl-apikey', c.directLinks?.apiKey);

  $('f-gemini-on').checked = !!c.gemini?.enabled;
  $('f-gemini-conf').value = c.gemini?.minConfidence ?? 0.6;
  $('f-gemini-content').checked = !!c.gemini?.contentCheck;
  $('f-gemini-allowclean').checked = !!c.gemini?.allowCleanRatedFilms;
  $('f-gemini-cconf').value = c.gemini?.minContentConfidence ?? 0.7;
  $('f-block-unrated').checked = !!c.movieRequests?.blockUnrated;

  $('f-libprovider').value = lib.provider;
  $('f-jf-url').value = lib.jellyfin?.baseUrl ?? '';
  $('f-jf-method').value = lib.jellyfin?.authMethod ?? 'password';
  $('f-jf-username').value = lib.jellyfin?.username ?? '';
  $('f-jf-password').value = lib.jellyfin?.password ?? '';
  $('f-jf-key').value = lib.jellyfin?.apiKey ?? '';
  $('f-jf-user').value = lib.jellyfin?.userId ?? '';
  syncJfSections();
  $('f-plex-url').value = lib.plex?.baseUrl ?? '';
  $('f-plex-token').value = lib.plex?.token ?? '';
  $('f-http-url').value = lib.http?.searchUrl ?? '';
  $('f-http-auth').value = lib.http?.authHeader ?? '';
  $('f-local-roots').value = (lib.local?.roots ?? []).join('\n');
  $('f-local-ext').value = (lib.local?.extensions ?? []).join(', ');
  $('f-libthreshold').value = lib.matchThreshold;
  $('f-libtimeout').value = lib.searchTimeoutMs ?? 180000;
  syncLibSections();

  $('f-maxbytes').value = md.maxOutputBytes;
  $('f-maxdownload').value = md.maxDownloadBytes ?? 21474836480;
  $('f-strategy').value = md.strategy;
  $('f-encprofile').value = md.encodeProfile ?? 'fast';
  $('f-vencoder').value = md.videoEncoder ?? 'auto';
  $('f-maxheight').value = md.maxHeight;
  $('f-abitrate').value = md.audioBitrateK;
  $('f-preset').value = md.preset;
  $('f-deleteafter').checked = !!md.deleteAfterSend;
  $('f-workdir').value = md.workDir ?? '';

  $('f-port').value = c.web.port;
  $('f-bind').value = c.web.bindAddress;
  $('f-idle').value = c.web.idleTimeoutMinutes ?? 15;
  $('f-loglevel').value = c.logging.level;

  const em = c.email ?? {};
  $('f-em-enabled').checked = !!em.enabled;
  $('f-em-provider').value = em.provider ?? 'gmail';
  $('f-em-host').value = em.host ?? '';
  $('f-em-port').value = em.port ?? 587;
  $('f-em-secure').checked = !!em.secure;
  $('f-em-user').value = em.user ?? '';
  $('f-em-pass').value = em.appPassword ?? '';
  $('f-em-to').value = em.to ?? '';
  $('f-em-onerror').checked = !!em.onError;
  $('f-em-onfailover').checked = em.onFailover !== false;
  $('f-em-oncontent').checked = em.onContentCheck === true;
  $('f-em-daily').checked = !!em.dailySummary;
  $('f-em-dailyhour').value = em.dailySummaryHour ?? 0;
  $('f-em-throttle').value = em.errorThrottleMinutes ?? 30;
  syncEmailSections();
  $('f-plugins').value = (c.plugins?.enabled ?? []).join('\n');
  renderKeySection();
}

function collectForm() {
  const list = (v) => v.split(',').map((s) => s.trim()).filter(Boolean);
  const lines = (v) => v.split('\n').map((s) => s.trim()).filter(Boolean);

  return {
    whatsapp: {
      // phoneNumber is NOT written here. It belongs to whichever account is
      // active, and switchAccount() keeps it in step. Saving it from the
      // dropdown let Settings and activeAccount drift apart, so the bot kept
      // running as the old number while the panel showed the new one.
      loginMethod: $('f-loginmethod').value,
      autoReconnect: $('f-autoreconnect').checked,
      markOnline: $('f-markonline').checked,
      minActionDelayMs: +$('f-mindelay').value,
      maxActionDelayMs: +$('f-maxdelay').value,
    },
    movieRequests: {
      // Left out of the save (undefined) by a picker the saved config has
      // not been drawn into yet, so the stored groups stand.
      requestGroups: groupChecksValue($('group-checks'), 'req-g'),
      postsGroup: groupSelectValue($('f-postsgroup')),
      notify: {
        group: groupSelectValue($('f-notifygroup')),
        tagRequester: $('f-notifytag').checked,
        noTag: $('f-notify-notag').value.split(/[\n,]/).map((x) => x.replace(/[^0-9]/g, '')).filter(Boolean),
      },
      blockedRatings: list($('f-blocked').value),
      blockUnrated: $('f-block-unrated').checked,
      requirePrefix: $('f-requireprefix').checked,
      prefix: $('f-prefix').value,
      replyOnBlock: $('f-replyonblock').checked,
      requireYearWhenAmbiguous: $('f-requireyear').checked,
      maxQueueLength: +$('f-maxqueue').value,
      cooldownSecondsPerUser: +$('f-cooldown').value,
      cooldownOnlyWhenOthersWait: $('f-cooldown-others').checked,
      reactions: {
        researching: $('r-researching').value, added: $('r-added').value,
        downloading: $('r-downloading').value, converting: $('r-converting').value,
        sending: $('r-sending').value, done: $('r-done').value,
        positions: $('r-positions').value.split(',').map((x) => x.trim()).filter(Boolean),
        positionOverflow: $('r-posoverflow').value,
        rated: $('r-rated').value, theaters: $('r-theaters').value,
        notFound: $('r-notfound').value, notInLibrary: $('r-notinlibrary').value,
        writtenWrong: $('r-writtenwrong').value,
        needYear: $('r-needyear').value, duplicate: $('r-duplicate').value,
        skipped: $('r-skipped').value, failed: $('r-failed').value,
      },
      theatrical: {
        // tmdbApiKey is NOT written here, and neither are omdb.apiKey,
        // gemini.apiKey or gemini.model below: the API keys section owns those
        // boxes and saves them itself. Two saves that both carried a key meant
        // whichever was pressed second decided, and pressing Save settings
        // after pasting a key into the key section - or the other way round -
        // quietly put the old one back.
        enabled: $('f-th-enabled').checked,
        useHomeReleaseDate: $('f-th-usedvd').checked,
        windowDays: +$('f-th-window').value,
      },
    },
    gemini: {
      enabled: $('f-gemini-on').checked,
      minConfidence: +$('f-gemini-conf').value,
      contentCheck: $('f-gemini-content').checked,
      allowCleanRatedFilms: $('f-gemini-allowclean').checked,
      minContentConfidence: +$('f-gemini-cconf').value,
    },
    library: {
      provider: $('f-libprovider').value,
      jellyfin: {
        baseUrl: $('f-jf-url').value,
        authMethod: $('f-jf-method').value,
        username: $('f-jf-username').value,
        password: $('f-jf-password').value,
        apiKey: $('f-jf-key').value,
        userId: $('f-jf-user').value,
      },
      plex: { baseUrl: $('f-plex-url').value, token: $('f-plex-token').value },
      http: { searchUrl: $('f-http-url').value, authHeader: $('f-http-auth').value },
      local: { roots: lines($('f-local-roots').value), extensions: list($('f-local-ext').value) },
      matchThreshold: +$('f-libthreshold').value,
      searchTimeoutMs: +$('f-libtimeout').value,
    },
    media: {
      maxOutputBytes: +$('f-maxbytes').value,
      maxDownloadBytes: +$('f-maxdownload').value || 21474836480,
      strategy: $('f-strategy').value,
      encodeProfile: $('f-encprofile').value,
      videoEncoder: $('f-vencoder').value,
      maxHeight: +$('f-maxheight').value,
      audioBitrateK: +$('f-abitrate').value,
      preset: $('f-preset').value,
      deleteAfterSend: $('f-deleteafter').checked,
      workDir: $('f-workdir').value,
    },
    web: { port: +$('f-port').value, bindAddress: $('f-bind').value, ...idleField() },
    logging: { level: $('f-loglevel').value },
    email: {
      enabled: $('f-em-enabled').checked,
      provider: $('f-em-provider').value,
      host: $('f-em-host').value,
      port: +$('f-em-port').value,
      secure: $('f-em-secure').checked,
      user: $('f-em-user').value,
      appPassword: $('f-em-pass').value,
      to: $('f-em-to').value,
      onError: $('f-em-onerror').checked,
      onFailover: $('f-em-onfailover').checked,
      onContentCheck: $('f-em-oncontent').checked,
      dailySummary: $('f-em-daily').checked,
      dailySummaryHour: +$('f-em-dailyhour').value,
      errorThrottleMinutes: +$('f-em-throttle').value,
    },
    plugins: { enabled: lines($('f-plugins').value) },
  };
}

/* "Save settings" saves what was edited on this page, and nothing else.

   It used to send collectForm() whole: eleven cards in five settings groups -
   the WhatsApp account, the film groups and request rules, the theatrical
   check, Gemini, the library, file handling, the sign-out timeout, the
   control panel, email and plugins - whichever one had been changed. So a
   save carried every box on the page as the page showed it, and whatever the
   page showed that was not what was saved went in with it.

   On 2026-10-12 at 21:00 UTC the operator changed the film cooldown and the
   text reply, pressed Save settings, and 22 settings changed: every group but
   five became a film request group, both posts groups, the TV request group
   and the notifications group among them; the posts and notifications groups
   were emptied; the theatrical check, Gemini, the nudity check and the email
   alerts switched off. The page's boxes said so when the save went out -
   nothing the panel itself does turns them that way, and how they got there
   is not known - and the save sent all of them. At 22:10, after the settings
   had been restored by hand, a page that had not read them since 21:00 was
   saved again with the Groups card put right: the theatrical check, Gemini
   and email went back off, as that page still showed them.

   So each control the save reads is listed here with the setting it writes,
   an edit on the page (the browser's input or change event, which typing,
   ticking and choosing all fire) marks that control, and the save sends the
   marked ones alone. A box nobody touched on this page is not sent, whatever
   it shows; the server keeps its own guard for the pages that still send
   everything (sweepingChange in src/config/store.js). Every setting
   collectForm() reads must have a line here, or it could never be saved;
   test/settings-save-sends-only-what-was-edited.test.mjs checks the two
   against each other. */
const FORM_FIELDS = {
  'f-loginmethod': 'whatsapp.loginMethod', 'f-autoreconnect': 'whatsapp.autoReconnect',
  'f-markonline': 'whatsapp.markOnline', 'f-mindelay': 'whatsapp.minActionDelayMs', 'f-maxdelay': 'whatsapp.maxActionDelayMs',
  // The request groups are one setting, edited through a box per group.
  'group-checks': 'movieRequests.requestGroups', 'f-postsgroup': 'movieRequests.postsGroup',
  'f-notifygroup': 'movieRequests.notify.group', 'f-notifytag': 'movieRequests.notify.tagRequester',
  'f-notify-notag': 'movieRequests.notify.noTag',
  'f-blocked': 'movieRequests.blockedRatings', 'f-block-unrated': 'movieRequests.blockUnrated',
  'f-requireprefix': 'movieRequests.requirePrefix', 'f-prefix': 'movieRequests.prefix',
  'f-replyonblock': 'movieRequests.replyOnBlock', 'f-requireyear': 'movieRequests.requireYearWhenAmbiguous',
  'f-maxqueue': 'movieRequests.maxQueueLength', 'f-cooldown': 'movieRequests.cooldownSecondsPerUser',
  'f-cooldown-others': 'movieRequests.cooldownOnlyWhenOthersWait',
  'r-researching': 'movieRequests.reactions.researching', 'r-added': 'movieRequests.reactions.added',
  'r-downloading': 'movieRequests.reactions.downloading', 'r-converting': 'movieRequests.reactions.converting',
  'r-sending': 'movieRequests.reactions.sending', 'r-done': 'movieRequests.reactions.done',
  'r-positions': 'movieRequests.reactions.positions', 'r-posoverflow': 'movieRequests.reactions.positionOverflow',
  'r-rated': 'movieRequests.reactions.rated', 'r-theaters': 'movieRequests.reactions.theaters',
  'r-notfound': 'movieRequests.reactions.notFound', 'r-notinlibrary': 'movieRequests.reactions.notInLibrary',
  'r-writtenwrong': 'movieRequests.reactions.writtenWrong',
  'r-needyear': 'movieRequests.reactions.needYear', 'r-duplicate': 'movieRequests.reactions.duplicate',
  'r-skipped': 'movieRequests.reactions.skipped', 'r-failed': 'movieRequests.reactions.failed',
  'f-th-enabled': 'movieRequests.theatrical.enabled', 'f-th-usedvd': 'movieRequests.theatrical.useHomeReleaseDate',
  'f-th-window': 'movieRequests.theatrical.windowDays',
  'f-gemini-on': 'gemini.enabled', 'f-gemini-conf': 'gemini.minConfidence', 'f-gemini-content': 'gemini.contentCheck',
  'f-gemini-allowclean': 'gemini.allowCleanRatedFilms', 'f-gemini-cconf': 'gemini.minContentConfidence',
  'f-libprovider': 'library.provider', 'f-jf-url': 'library.jellyfin.baseUrl', 'f-jf-method': 'library.jellyfin.authMethod',
  'f-jf-username': 'library.jellyfin.username', 'f-jf-password': 'library.jellyfin.password',
  'f-jf-key': 'library.jellyfin.apiKey', 'f-jf-user': 'library.jellyfin.userId',
  'f-plex-url': 'library.plex.baseUrl', 'f-plex-token': 'library.plex.token',
  'f-http-url': 'library.http.searchUrl', 'f-http-auth': 'library.http.authHeader',
  'f-local-roots': 'library.local.roots', 'f-local-ext': 'library.local.extensions',
  'f-libthreshold': 'library.matchThreshold', 'f-libtimeout': 'library.searchTimeoutMs',
  'f-maxbytes': 'media.maxOutputBytes', 'f-maxdownload': 'media.maxDownloadBytes', 'f-strategy': 'media.strategy',
  'f-encprofile': 'media.encodeProfile', 'f-vencoder': 'media.videoEncoder', 'f-maxheight': 'media.maxHeight',
  'f-abitrate': 'media.audioBitrateK', 'f-preset': 'media.preset', 'f-deleteafter': 'media.deleteAfterSend',
  'f-workdir': 'media.workDir',
  'f-port': 'web.port', 'f-bind': 'web.bindAddress', 'f-idle': 'web.idleTimeoutMinutes',
  'f-loglevel': 'logging.level',
  'f-em-enabled': 'email.enabled', 'f-em-provider': 'email.provider', 'f-em-host': 'email.host', 'f-em-port': 'email.port',
  'f-em-secure': 'email.secure', 'f-em-user': 'email.user', 'f-em-pass': 'email.appPassword', 'f-em-to': 'email.to',
  'f-em-onerror': 'email.onError', 'f-em-onfailover': 'email.onFailover', 'f-em-oncontent': 'email.onContentCheck',
  'f-em-daily': 'email.dailySummary', 'f-em-dailyhour': 'email.dailySummaryHour', 'f-em-throttle': 'email.errorThrottleMinutes',
  'f-plugins': 'plugins.enabled',
};

/** The controls in FORM_FIELDS edited on this page since it was last filled from the saved config. */
const FORM_EDITED = new Set();

/** Which FORM_FIELDS control an input or change event came from, if any. */
function formFieldOf(el) {
  if (!el || el.nodeType !== 1) return null;
  if (el.closest?.('#group-checks')) return 'group-checks';
  return el.id && Object.hasOwn(FORM_FIELDS, el.id) ? el.id : null;
}

function noteFormEdit(e) {
  const id = formFieldOf(e.target);
  if (id) FORM_EDITED.add(id);
}
document.addEventListener('input', noteFormEdit);
document.addEventListener('change', noteFormEdit);

/** Has this control been edited on this page since the last fill? */
const formEdited = (id) => FORM_EDITED.has(id);

/**
 * The part of collectForm() that somebody edited on this page: each edited
 * control's setting, nothing else. An edited group picker never drawn from
 * the config (undefined in the form) is still left out, as before.
 */
function editedSettings(form) {
  const out = {};
  for (const id of FORM_EDITED) {
    const keys = FORM_FIELDS[id].split('.');
    let from = form;
    for (const k of keys) from = from?.[k];
    if (from === undefined) continue;
    let to = out;
    for (const k of keys.slice(0, -1)) to = (to[k] ??= {});
    to[keys[keys.length - 1]] = from;
  }
  return out;
}

/**
 * The global sign-out timeout, sent by the super-admin's save only. A plain
 * admin's form leaves it out: the server refuses a whole save that changes it,
 * and echoing back a value the super-admin has changed since this page loaded
 * would turn an ordinary save into that refusal.
 *
 * For the super-admin, a box the browser reads as '' stops the save instead of
 * being sent or skipped. Sent, +'' is 0 and would quietly switch the timeout
 * off. Skipped, the panel said "Settings saved" while the number typed there -
 * '1e', say, which a number box also reports as '' - was thrown away. Thrown
 * from here, the save handler shows it and nothing is saved.
 */
function idleField() {
  if (CURRENT_USER?.role !== 'superadmin') return {};
  if ($('f-idle').validity?.badInput || $('f-idle').value.trim() === '') {
    throw new Error('Sign-out timeout: whole minutes from 0 to 1440 (0 means never). Nothing was saved.');
  }
  return { idleTimeoutMinutes: +$('f-idle').value };
}

$('btn-save').addEventListener('click', async () => {
  try {
    // Only what was edited on this page (FORM_FIELDS). Nothing edited sends
    // an empty save, which still brings the page back in step with what is
    // saved: the refill below.
    const form = editedSettings(collectForm());
    // The server keeps a stored group that a save would empty, because a form
    // saved before its pickers were drawn used to wipe them. When a picker
    // showed a saved group and somebody chose "none", or unticked every
    // request group, say so - somebody, on this page: a picker nobody touched
    // is not sent at all.
    const clears = clearGroupsQuery([
      formEdited('group-checks') && clearedGroupChecks($('group-checks'), 'req-g') && 'movieRequests.requestGroups',
      formEdited('f-postsgroup') && clearedGroupSelect($('f-postsgroup')) && 'movieRequests.postsGroup',
      formEdited('f-notifygroup') && clearedGroupSelect($('f-notifygroup')) && 'movieRequests.notify.group',
    ]);
    // ?edited=1 says this save holds only edits: the server refuses a whole
    // form without it, as a page from before this change (isWholeSettingsForm).
    CONFIG = await api('PUT', `/config?edited=1${clears.replace(/^\?/, '&')}`, form);
    FORM_EDITED.clear();
    // Read before the refill, which puts the section's pills back in step.
    const pending = pendingKeyEdits();
    fillForm(CONFIG);
    renderKeySection();
    loadBetaSection({ fresh: false });          // which groups are main may have changed
    const at = fmtClock(Date.now());
    // This button is sticky at the top of the tab, so it is the nearest and
    // biggest Save to the API keys section directly below it - and it no
    // longer carries those keys. An unqualified "Settings saved" therefore
    // told somebody who had just pasted a key that their key was stored, when
    // the only sign otherwise was a small "unsaved" note further down.
    if (pending.length) {
      const which = `${pending.join(' and ')} still ${pending.length > 1 ? 'need' : 'needs'}`;
      $('save-note').textContent = `Saved ${at} — ${which} Save API keys`;
      toast(`Settings saved — ${which} "Save API keys"`, true);
      flashField($('ak-save'));
    } else {
      $('save-note').textContent = `Saved ${at}`;
      toast('Settings saved');
    }
    loadDiagnostics();
    loadAdmins();          // the default timeout may have changed under the Admins rows and My account
  } catch (err) {
    toast(err.message, true);
  }
});

$('f-libprovider').addEventListener('change', syncLibSections);
function syncLibSections() {
  const p = $('f-libprovider').value;
  document.querySelectorAll('.lib-section').forEach((s) => {
    s.classList.toggle('hidden', s.dataset.lib !== p);
  });
  if (p === 'jellyfin') refreshJfStatus();
}

/* ----------------------------- groups ------------------------------ */
/** The API may answer with a bare array (SSE) or a wrapper object. */
function unwrapGroups(payload) {
  return Array.isArray(payload) ? payload : (payload?.groups ?? []);
}

async function loadGroups(refresh = false) {
  try {
    GROUPS = unwrapGroups(await api('GET', `/wa/groups${refresh ? '?refresh=1' : ''}`));
  } catch { GROUPS = []; }
  renderGroups();
}

function describeAge(ms) {
  if (!isFinite(ms)) return 'never fetched';
  const s = Math.round(ms / 1000);
  if (s < 60) return `updated ${s}s ago`;
  return `updated ${Math.round(s / 60)}m ago`;
}

function renderGroups() {
  rememberGroupNames(GROUPS);
  renderGroupsList();
  renderMxGroups();
  renderTvGroupPickers();
  renderDlGroups();
  renderBetaCard();
  renderLibraryNewsCard();
  renderAlwaysLocked();
  renderMovieGroupPickers();
}

/* The group pickers that are settings - every one that a Save sends back.

   On 2026-09-24 at 22:19 New York time a "Save settings" emptied the queue
   notifications group and switched off @-tagging, and nobody could say
   whether it had been meant. That save changed those two boxes and nothing
   else, which is what choosing "none" and unticking does, not what the bugs
   below do. But looking into it found that these pickers could send an empty
   group nobody had chosen:

   - the posts and notifications dropdowns, the request-group boxes, the tag
     tick box and the no-tag list were filled only once the group list
     arrived. Until then they held the page's defaults - "— none —", nothing
     ticked - and a Save in that window sent exactly that. The list is late
     whenever WhatsApp is slow to hand it over, and for as long as it is
     rate-limited after a reconnect;
   - the TV, direct-links and always-locked lists drew only the groups the
     connected number is in. A saved group that number is not in - after a
     switch to another number, say - had no box, so the next Save of that card
     dropped it, and with no list loaded the card sent an empty one. The
     always-locked list was not redrawn when the group list arrived at all, so
     a page whose lockdown status answered first kept an empty list, and
     "Save" emptied it;
   - every redraw - one comes with each group-list push - put the saved values
     back over whatever had been picked and not yet saved.

   So each picker is now drawn from the saved config as soon as the config
   arrives, keeps every saved group as a selected option or a ticked box
   whether or not the loaded list holds it, and keeps a choice made on this
   page through a redraw. `data-saved` on the picker holds the saved value it
   last showed: a value that differs from it is somebody's unsaved choice, and
   one that matches it follows the config. A picker that has never been drawn
   from the config sends nothing at all, and a save that empties a group names
   it in ?clearGroups= only when the picker showed a saved group and somebody
   chose "none" or unticked the last box - the server keeps a stored group a
   save would otherwise empty (holdGroupClears in src/config/store.js). */

/**
 * Every group name this page has been told, by JID. The pickers draw from the
 * connected number's list, and after a switch to another number a saved group
 * that number is not in would otherwise be offered as a bare JID.
 */
const GROUP_NAMES = new Map();
function rememberGroupNames(list) {
  for (const g of list ?? []) if (g?.jid && g.subject) GROUP_NAMES.set(g.jid, g.subject);
}

/** The label for a group a picker must offer although the loaded list lacks it. */
function missingGroupLabel(jid, kind = 'saved') {
  const why = GROUPS.length ? 'not in this number\'s groups' : 'group list not loaded';
  return `(${kind}: ${GROUP_NAMES.get(jid) ?? jid} — ${why})`;
}

/**
 * Draw a one-group dropdown - see the note above. `chosen: false` says nobody
 * has chosen anything in it on this page, so whatever it shows that differs
 * from the saved value is not a choice, and it goes back to the saved value.
 */
function renderGroupSelect(sel, saved, none = '— none —', { chosen = true } = {}) {
  if (!sel) return;
  saved = saved ?? '';
  const draft = chosen && sel.dataset.saved !== undefined && sel.value !== sel.dataset.saved ? sel.value : null;
  const want = draft ?? saved;
  const known = new Set(GROUPS.map((g) => g.jid));
  const opt = (jid, label) => `<option value="${esc(jid)}"${jid === want ? ' selected' : ''}>${esc(label)}</option>`;
  const missing = [...new Set([saved, want])].filter((j) => j && !known.has(j));
  sel.innerHTML = opt('', none)
    + GROUPS.map((g) => opt(g.jid, g.subject)).join('')
    + missing.map((j) => opt(j, missingGroupLabel(j, j === saved ? 'saved' : 'chosen'))).join('');
  sel.value = want;
  sel.dataset.saved = saved;
}

/** A dropdown's group for a save; undefined, so it is left out, if never drawn. */
function groupSelectValue(sel) {
  return sel?.dataset.saved === undefined ? undefined : sel.value;
}

/** True when the dropdown showed a saved group and "none" has been chosen since. */
function clearedGroupSelect(sel) {
  return !!sel?.dataset.saved && sel.value === '';
}

/**
 * The rows and ticks for a list of group boxes: every loaded group, then each
 * saved or ticked group the loaded list lacks. Ticks somebody changed since the
 * list was last drawn win over the saved ones - unless `chosen: false` says
 * nobody ticked anything in it on this page (renderGroupSelect).
 */
function groupCheckRows(box, cls, saved, { chosen: mayKeep = true } = {}) {
  const savedList = [...new Set(saved ?? [])];
  const shown = box.dataset.saved !== undefined ? JSON.parse(box.dataset.saved) : null;
  const ticked = [...box.querySelectorAll(`input.${cls}`)].filter((i) => i.checked).map((i) => i.value);
  const edited = mayKeep && shown && (ticked.length !== shown.length || ticked.some((j) => !shown.includes(j)));
  const chosen = new Set(edited ? ticked : savedList);
  const known = new Set(GROUPS.map((g) => g.jid));
  const rows = [
    ...GROUPS.map((g) => ({ jid: g.jid, subject: g.subject, size: g.size })),
    ...[...new Set([...savedList, ...chosen])].filter((j) => !known.has(j)).map((j) => ({
      jid: j, missing: missingGroupLabel(j, savedList.includes(j) ? 'saved' : 'chosen'), named: GROUP_NAMES.has(j),
    })),
  ];
  return { rows, chosen, savedList };
}

/** Draw a list of group tick boxes (TV, direct links, always-locked) - see the note above. */
function renderGroupChecks(box, cls, saved, { hidePrivate = false } = {}) {
  if (!box) return;
  const all = groupCheckRows(box, cls, saved);
  const { chosen, savedList } = all;
  // A "$" group is not offered: the lockdown leaves those groups alone, so one
  // saved as always-locked before this simply drops off at the next save,
  // which changes nothing.
  const rows = hidePrivate ? all.rows.filter((g) => !GROUPS.find((x) => x.jid === g.jid)?.private) : all.rows;
  const hidden = all.rows.length - rows.length;
  box.innerHTML = (rows.length ? rows.map((g) => `
    <label class="check"><input type="checkbox" class="${cls}" value="${esc(g.jid)}"${chosen.has(g.jid) ? ' checked' : ''}>
      <span>${g.missing
    ? `<span class="muted">${esc(g.missing)}</span>${g.named ? `<br><span class="gjid">${esc(g.jid)}</span>` : ''}`
    : `${esc(g.subject)} <span class="muted small">(${g.size})</span>`}</span></label>`).join('')
    : '<div class="empty">No groups loaded.</div>')
    + (hidden ? `<div class="muted small" style="margin-top:8px">🔒 ${hidden} private group${hidden === 1 ? '' : 's'} hidden (names starting with “$”): the lockdown leaves ${hidden === 1 ? 'it' : 'them'} alone.</div>` : '');
  box.dataset.saved = JSON.stringify(savedList);
}

/** A list's ticked groups for a save; undefined, so it is left out, if never drawn. */
function groupChecksValue(box, cls) {
  if (!box || box.dataset.saved === undefined) return undefined;
  return [...box.querySelectorAll(`input.${cls}`)].filter((i) => i.checked).map((i) => i.value);
}

/** True when the list showed saved groups and every box has been unticked since. */
function clearedGroupChecks(box, cls) {
  const value = groupChecksValue(box, cls);
  return !!value && !value.length && JSON.parse(box.dataset.saved).length > 0;
}

/** The query that tells PUT /config which group settings were emptied on purpose. */
function clearGroupsQuery(paths) {
  const named = paths.filter(Boolean);
  return named.length ? `?clearGroups=${encodeURIComponent(named.join(','))}` : '';
}

/**
 * The Movies card's request groups, posts group and notifications group.
 *
 * A picker keeps what it shows over the saved value only when somebody edited
 * it on this page (FORM_FIELDS). The 2026-10-12 21:00 save went out with ten
 * request groups ticked and both dropdowns on "none" while the config held one
 * request group, a posts group and a notifications group: the panel took what
 * the pickers showed for somebody's unsaved choice, which a redraw keeps, and
 * named both dropdowns in the save as emptied on purpose. Nobody had chosen
 * any of it.
 */
function renderMovieGroupPickers() {
  if (!CONFIG) return;
  const mr = CONFIG.movieRequests ?? {};
  const box = $('group-checks');
  if (box) {
    const { rows, chosen, savedList } = groupCheckRows(box, 'req-g', mr.requestGroups, { chosen: formEdited('group-checks') });
    if (!rows.length) {
      box.innerHTML = '<div class="empty">No groups loaded. Connect WhatsApp, then hit Refresh.</div>';
      $('groups-note').textContent = '';
    } else {
      box.innerHTML = rows.map((g) => `
      <label class="check">
        <input type="checkbox" class="req-g" value="${esc(g.jid)}" ${chosen.has(g.jid) ? 'checked' : ''}>
        <span>${g.missing ? `<span class="muted">${esc(g.missing)}</span>` : `${esc(g.subject)} <span class="muted small">(${g.size})</span>`}
          <br><span class="gjid">${esc(g.jid)}</span></span>
      </label>`).join('');
      const missing = rows.length - GROUPS.length;
      $('groups-note').textContent = GROUPS.length
        ? `${GROUPS.length} groups${missing ? ` (+${missing} configured but not listed)` : ''}`
        : `${missing} configured group(s); list not loaded yet`;
    }
    box.dataset.saved = JSON.stringify(savedList);
  }
  renderGroupSelect($('f-postsgroup'), mr.postsGroup, undefined, { chosen: formEdited('f-postsgroup') });
  renderGroupSelect($('f-notifygroup'), mr.notify?.group, undefined, { chosen: formEdited('f-notifygroup') });
}

$('btn-refresh-groups').addEventListener('click', async () => {
  const btn = $('btn-refresh-groups');
  btn.disabled = true;
  $('groups-note').textContent = 'refreshing…';
  try {
    const r = await api('GET', '/wa/groups?refresh=1');
    GROUPS = unwrapGroups(r);
    renderGroups();
    // A cached answer is a normal outcome, not a failure worth alarming about.
    const detail = r.refreshed ? 'refreshed just now' : (r.note ?? describeAge(r.ageMs));
    $('groups-note').innerHTML = `${GROUPS.length} groups <span class="muted">· ${esc(detail)}</span>`;
    toast(r.refreshed ? `${GROUPS.length} groups refreshed` : `${GROUPS.length} groups · ${detail}`);
  } catch (err) {
    if (err.data?.groups?.length) { GROUPS = err.data.groups; renderGroups(); }
    $('groups-note').innerHTML = `<span style="color:var(--warn)">${esc(err.message)}</span>`;
  } finally {
    btn.disabled = false;
  }
});

/* ---------------------------- connection --------------------------- */

// The panel is push-only: status arrives over SSE when something CHANGES, and
// a backoff is precisely a period in which nothing does. So the last status is
// kept and the link area re-rendered on a local tick, otherwise the countdown
// below would freeze at whatever it said when the wait began.
let lastStatus = null;
let linkTicker = null;

function renderStatus(s) {
  lastStatus = s;
  renderLinkArea(s);
  clearInterval(linkTicker);
  linkTicker = null;
  if (s.state === 'connecting' && s.nextReconnectAt) {
    linkTicker = setInterval(() => {
      if (!lastStatus) return;
      if (Date.now() >= lastStatus.nextReconnectAt) { clearInterval(linkTicker); linkTicker = null; }
      renderLinkArea(lastStatus);
    }, 1000);
  }
  renderConnPill(s);
  // "Linked and connected" is a live fact, not a setting, so the checklist
  // follows the same push that moves the connection pill.
  refreshFreshInstall();
}

function renderConnPill(s) {
  const dot = $('conn-dot'), pill = $('conn-pill');
  const map = {
    connected: ['ok', 'Connected'],
    connecting: ['warn', 'Connecting…'],
    'awaiting-pairing': ['warn', 'Waiting for pairing'],
    'awaiting-qr': ['warn', 'Waiting for QR scan'],
    conflict: ['bad', 'Session taken over'],
    error: ['bad', 'Error'],
    stopped: ['', 'Not connected'],
  };
  const [cls, label] = map[s.state] ?? ['', s.state];
  dot.className = `dot ${cls}`;
  pill.className = `pill ${cls}`;
  pill.textContent = label;
  $('conn-state').textContent = label;
  // Connected: who we actually are. Not connected: which number is SELECTED,
  // so "Link / Connect" says what it will link as. Falling back to the last
  // connected identity made a number switch look like it had been ignored -
  // the panel kept naming the previous number.
  if (s.me?.id) {
    $('conn-detail').textContent =
      `${s.me.name ?? ''} · +${String(s.me.id).split(/[:@]/)[0]} · ${s.groupCount} groups`;
  } else if (s.account) {
    const a = s.account;
    $('conn-detail').textContent = `will link as ${a.label}`
      + `${a.phoneNumber ? ` · +${a.phoneNumber}` : ''}`
      + `${a.linked ? ' · already linked' : ' · not linked yet'}`
      + (s.lastError ? ` · ${s.lastError}` : '');
  } else {
    $('conn-detail').textContent = s.lastError ?? '';
  }
}

function renderLinkArea(s) {
  const area = $('link-area');
  // Keyed on STATE, not on whether a field happens to be populated. A pairing
  // code left over from a previous attempt used to win this test and hide the
  // live QR behind it, which read as "the QR never shows".
  if (s.state === 'awaiting-pairing' && s.pairingCode) {
    area.innerHTML = `
      <div class="pair-box">
        <div class="muted small">Enter this code on your phone</div>
        <div class="pair-code">${esc(s.pairingCode)}</div>
        <ol class="pair-steps">
          <li>Open WhatsApp on the phone for this number</li>
          <li>Settings → Linked devices → Link a device</li>
          <li>Tap <strong>Link with phone number instead</strong></li>
          <li>Type the code above</li>
        </ol>
      </div>`;
  } else if (s.state === 'awaiting-qr' && s.qr) {
    area.innerHTML = `
      <div class="pair-box">
        <div class="muted small">Scan with WhatsApp → Linked devices</div>
        <img src="${s.qr}" alt="QR code">
        <div class="muted small" style="margin-top:6px">Codes expire after about two
          minutes. A fresh one appears on its own — you do not need to click again.</div>
      </div>`;
  } else if (s.state === 'connecting' && s.nextReconnectAt) {
    // Say what it is waiting for. A bare "Connecting…" through a fifteen-minute
    // backoff is indistinguishable from a hang, and clicking again does not
    // help — the countdown is the only thing that explains the wait.
    const secs = Math.max(0, Math.round((s.nextReconnectAt - Date.now()) / 1000));
    area.innerHTML = `
      <div class="pair-box">
        <div class="muted small">${s.linking
          ? `Waiting to show the next code — about ${secs}s.`
          : `Next connection attempt in about ${secs}s (attempt ${s.reconnectAttempts}).`}</div>
        ${secs > 60 && !s.linking
          ? '<div class="muted small" style="margin-top:6px">To link a number now rather than'
            + ' waiting out the backoff, restart the bot and press Link / Connect again.</div>'
          : ''}
      </div>`;
  } else {
    area.innerHTML = '';
  }
}

$('btn-start').addEventListener('click', async () => {
  try { await api('POST', '/wa/start'); toast('Connecting…'); }
  catch (err) { toast(err.message, true); }
});
$('btn-stop').addEventListener('click', async () => {
  await api('POST', '/wa/stop'); toast('Disconnected');
});
$('btn-wipe').addEventListener('click', async () => {
  if (!confirm('Unlink this number and delete the saved session?\n\nYou will need to link again from scratch.')) return;
  await api('POST', '/wa/logout');
  toast('Session wiped');
});

/* ------------------------------ queue ------------------------------ */
const STAGES = [
  { key: 'download', label: 'Download' },
  { key: 'convert',  label: 'Convert' },
  { key: 'upload',   label: 'Send' },
];

/*
 * A TV request is ONE row, however many episodes it holds: the queue sends a
 * season as a single item (`group`, with `jobs` counting its episodes and
 * `current` holding the ones in hand) and moves and cancels it by that row's
 * id. Skip is the one thing aimed at an episode, by the episode's own job id.
 * It used to be one row per episode - a 22-episode season was 22 rows, each
 * with its own arrows and Cancel.
 */
const STAGE_VERB = { download: 'downloading', convert: 'converting', upload: 'sending', done: 'sent', start: 'starting', wait: 'waiting' };

/** "22 episodes · 3 done · S05E04 converting" - where a request has got to. */
function requestProgress(j) {
  const n = j.jobs ?? {};
  const bits = [`${n.total} episode${n.total === 1 ? '' : 's'}`];
  if (n.done) bits.push(`${n.done} done`);
  if (n.failed) bits.push(`${n.failed} failed`);
  if (n.cancelled) bits.push(`${n.cancelled} skipped or cancelled`);
  for (const c of j.current ?? []) {
    const slot = c.waiting ? ({ download: 'download', convert: 'convert', upload: 'send' }[c.waiting.stage] ?? c.waiting.stage) : null;
    bits.push(`${c.label} ${slot ? `waiting to ${slot}` : (STAGE_VERB[c.progress?.stage] ?? 'starting')}`);
  }
  return bits.join(' \u00b7 ');
}

/** The running jobs behind a row: a request's episodes in hand, or the job itself. */
const jobsOf = (j) => (j.group ? (j.current ?? []) : [j]);

/** "S05E04" from "American Dad! S05E04" - enough to tell a season's episodes apart on a button. */
const episodeCode = (label) => (String(label ?? '').match(/S\d+E\d+$/) ?? [String(label ?? '')])[0];

/** The prominent panel for whatever is running right now. */
let lastQueue = { active: [], pending: [], history: [] };
function renderActivity(q) {
  lastQueue = q;
  const box = $('activity');
  if (!q.active.length) {
    box.innerHTML = `<div class="empty">${q.paused ? 'Queue paused.' : 'Nothing in progress.'}</div>`;
    return;
  }
  // Show EVERY active job, not just the first - with stage pipelining, several
  // run at once (one downloading, one converting, one uploading). The ones
  // doing something come first, then the ones in line for a slot in the order
  // they will get it, so moving one up moves it up the card too.
  const LINE_ORDER = { upload: 0, convert: 1, download: 2 };
  const shown = [...q.active].sort((a, b) => (a.waiting ? 1 : 0) - (b.waiting ? 1 : 0)
    || (a.waiting && b.waiting
      ? (LINE_ORDER[a.waiting.stage] ?? 3) - (LINE_ORDER[b.waiting.stage] ?? 3) || a.waiting.position - b.waiting.position
      : 0));
  box.innerHTML = shown.map((job) => renderActiveJob(job, q)).join('<hr class="act-div">');
}

/** "2nd", "3rd", "11th" - a place in line. */
function ordinal(n) {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th');
  return String(n) + suffix;
}

/**
 * A running job in line for a stage slot - downloaded and waiting for the one
 * encoder, say - gets its place in that line and buttons to move it up, as
 * the Queue card's waiting jobs have. The job holding the slot is never
 * interrupted; this only decides who goes next.
 */
function lineControls(job) {
  // A season's card can have one episode working while the next waits for a
  // slot - its usual state with two TV slots. `line` is where the best-placed
  // of them stands, and the buttons move the season's episodes up that line;
  // read from the episode on the card alone, they would vanish just then.
  const w = job.line ?? job.waiting;
  if (!w) return { place: '', buttons: '' };
  const slot = { download: 'download', convert: 'convert', upload: 'send' }[w.stage] ?? w.stage;
  const where = w.position === 1 ? 'next to ' + slot : ordinal(w.position) + ' in line to ' + slot;
  const place = job.group && w.label && (job.jobs?.total ?? 1) > 1 ? episodeCode(w.label) + ' ' + where : where;
  const first = w.position === 1 ? 'disabled' : '';
  const buttons = '<button class="btn small" title="Move up one place in line to ' + slot + '" '
      + 'onclick="moveJob(\'' + job.id + '\',\'up\')" ' + first + '>▲</button>'
    + '<button class="btn small" title="Make this the next one to ' + slot + '" '
      + 'onclick="moveJob(\'' + job.id + '\',\'top\')" ' + first + '>⤒ next</button>';
  return { place, buttons };
}

function renderActiveJob(job, q) {
  const p = job.progress ?? {};
  // A season between two episodes - or held while the films go first - is
  // still running, with nothing in hand this minute.
  const idle = !!job.group && !(job.current ?? []).length;
  const stage = p.stage ?? (idle ? 'wait' : 'start');
  const pct = p.pct ?? 0;
  const elapsed = job.startedAt ? Math.round((Date.now() - job.startedAt) / 1000) : 0;

  // A job in line for a slot is at stage 'wait', which is none of the three,
  // so every step used to show grey - Ready Player One, downloaded and waiting
  // to convert, read as if nothing had happened yet. The line it is in says
  // which step it has reached.
  const idx = STAGES.findIndex((x) => x.key === (stage === 'wait' && job.waiting ? job.waiting.stage : stage));
  const steps = STAGES.map((sdef) => {
    const mine = STAGES.findIndex((x) => x.key === sdef.key);
    const cls = stage === 'done' || mine < idx ? 'step-done'
              : sdef.key === stage ? 'step-now' : 'step-todo';
    return `<span class="stage ${cls}">${sdef.label}</span>`;
  }).join('<span class="stage-sep">\u203a</span>');

  const films = (q.counts?.active?.movie ?? 0) + (q.counts?.pending?.movie ?? 0);
  const why = idle
    ? (q.paused ? 'paused' : (q.strictMoviePriority !== false && films ? 'waiting \u2014 films go first' : 'waiting for a free slot'))
    : '';
  const waitNote = stage === 'wait' ? ` <span class="muted">(${esc(p.text || why || 'waiting')})</span>` : '';
  const line = lineControls(job);
  const many = !!job.group && (job.jobs?.total ?? 1) > 1;
  // One Skip per job in hand, aimed at that job: a season can have two
  // episodes at once (one sending, the next downloading), and one Skip for
  // the card would stop both, throwing a healthy download away to get past
  // the one stuck sending.
  const skips = jobsOf(job).map((c) => (pendingSkip === c.id
    ? `<button class="btn small warn" disabled>Skipping\u2026</button>`
    : (many
      ? `<button class="btn small warn" onclick="skipJob('${c.id}')" title="Skip this episode; the rest of the season carries on">Skip ${esc(episodeCode(c.label))}</button>`
      : `<button class="btn small warn" onclick="skipJob('${c.id}')">Skip${q.pending.length ? ` (${q.pending.length} waiting)` : ''}</button>`))).join('');

  return `
    <div class="act-job">
      <div class="act-title">${esc(job.label)}${waitNote}</div>
      ${many ? `<div class="act-meta" data-request-progress>${esc(requestProgress(job))}</div>` : ''}
      <div class="act-meta">${esc(job.meta?.requester ? `requested by ${phoneOut(job.meta.requester)}` : '')}${numberBeside(job.meta?.requester, job.meta?.requesterNumber) ? ` \u00b7 ${esc(numberBeside(job.meta?.requester, job.meta?.requesterNumber))}` : ''}${job.meta?.resumed ? ' \u00b7 resumed' : ''}</div>
      <div class="stages">${steps}</div>
      <div class="bar big"><i style="width:${pct}%"></i></div>
      <div class="act-line">
        <span class="act-pct">${pct}%</span>
        <span class="act-detail">${esc(p.text || (idle && job.next ? `next: ${job.next}` : 'starting\u2026'))}</span>
      </div>
      <div class="act-stats">
        ${p.bytesPerSec ? `<span><b>${fmtBytes(p.bytesPerSec)}/s</b> transfer</span>` : ''}
        ${p.etaSec != null ? `<span><b>${fmtDur(p.etaSec)}</b> remaining</span>` : ''}
        ${p.totalBytes ? `<span><b>${fmtBytes(p.totalBytes)}</b> total</span>` : ''}
        <span><b>${fmtDur(elapsed)}</b> elapsed</span>
      </div>
      <div class="row gap" style="margin-top:10px">
        ${skips}
        <button class="btn small danger" onclick="cancelJob('${job.id}')"${many ? ' title="Cancel the whole request: every episode not yet sent"' : ''}>Cancel</button>
        ${line.buttons}
        ${line.place ? `<span class="muted small" data-line-place>${esc(line.place)}</span>` : ''}
      </div>
    </div>`;
}

function renderReactionGuide(reactions) {
  const box = $('reaction-guide');
  if (!box || !reactions) return;
  const r = reactions;
  const pos = (r.positions && r.positions.length) ? r.positions.slice(0, 3).join(' ') + ' …' : '1\u20e3 2\u20e3 3\u20e3';

  const row = (emoji, label) => `<div class="rg-row"><span class="rg-emoji">${esc(emoji || '\u2022')}</span><span class="rg-label">${esc(label)}</span></div>`;

  box.innerHTML = `
    <div class="rg-sec">While your request is handled — the bot updates one reaction as it moves:</div>
    ${row(r.researching, 'Researching — looking it up')}
    ${row(r.added, 'Added to the queue')}
    ${row(r.duplicate, 'Already asked for — it is coming, not added twice')}
    ${row(pos, 'Your place in line (updates as it moves up)')}
    ${row(r.downloading, 'Downloading from the server')}
    ${row(r.converting, 'Converting to fit WhatsApp')}
    ${row(r.sending, 'Sending to the group')}
    ${row(r.done, 'Done — posted!')}
    <div class="rg-sec">If we can't fulfil it:</div>
    ${row(r.rated, 'Rated R / NC-17 / etc — not allowed')}
    ${row(r.theaters, 'Still in theaters — not on the server yet')}
    ${row(r.notInLibrary, "Not in the library — we don't have it")}
    ${row(r.notFound, 'Not found — check the spelling')}
    ${row(r.writtenWrong || '\u270d\ufe0f', 'Not written properly — write the season and episode like S01E05')}
    ${row(r.needYear, 'Which year? — add a year (e.g. Dune 2021)')}
    ${row(r.oneAtATime || '\u261d\ufe0f', 'One movie per request — send each in a message of its own')}
    <div class="rg-sec">Occasional:</div>
    ${row(r.failed, 'Something went wrong (usually retries)')}
    ${row(r.skipped, 'An admin skipped it (huge file)')}
    ${row(r.paused || '\u23f8\ufe0f', 'On hold — requests are paused for a moment; it runs by itself, in order, when they resume')}`;
}

/* -------------------------- request pause -------------------------- */
// The operator (2026-10-01): pause processing of requests from the dashboard
// without stopping the bot or locking the groups - every request gets ⏸️ and
// waits, and runs, in order, on Resume (src/core/request-pause.js). Pushed
// over SSE ('requestpause') whenever it changes: a request held, one run.
let REQ_PAUSE = null;

/** "14:02" today, with the date on any other day; 24-hour either way. */
function pauseWhen(t) {
  if (!t) return '?';
  return new Date(t).toDateString() === new Date().toDateString()
    ? fmtClock(t, HM)
    : fmtDateTime(t, { ...HM, month: 'short', day: 'numeric' });
}

function renderRequestPause(s) {
  if (!s) return;
  REQ_PAUSE = s;
  const btn = $('btn-req-pause');
  const card = $('card-req-paused');
  const held = s.held ?? 0;
  if (btn) {
    btn.textContent = s.paused ? `\u25b6\ufe0f Resume requests (runs ${held} held)` : '\u23f8\ufe0f Pause requests';
    btn.classList.toggle('primary', !!s.paused);
  }
  if (card) {
    card.classList.toggle('hidden', !s.paused);
    $('req-paused-line').textContent = s.paused
      ? `Requests paused since ${pauseWhen(s.since)} by ${s.by || 'someone'} \u00b7 ${held} held`
      : '';
    const items = s.heldItems ?? [];
    $('req-paused-held').innerHTML = s.paused
      ? [
        'Every request from a request group gets \u23f8\ufe0f and waits; on Resume they run, in the order they came. '
          + 'Beta tests, direct links and what you queue here are not paused.',
        ...items.map((it) => `${esc(pauseWhen(it.at))} \u00b7 ${esc(it.who ? phoneOut(it.who) : '?')} \u00b7 ${esc(it.text || '')}`
          + `${it.kind === 'pick' ? ' (a pick from a list)' : ''}${it.plugin === 'tv-requests' ? ' (TV)' : ''}`),
        ...(held > items.length ? [`\u2026 and ${held - items.length} more`] : []),
      ].map((l) => `<div>${l}</div>`).join('')
      : '';
  }
  const note = $('req-pause-note');
  if (note) {
    // From the live queue as well as from pausedQueue: an admin who presses
    // the queue's own Resume while requests stay paused clears pausedQueue,
    // and the note went on saying the queue was paused while it downloaded
    // and posted (found in review, 2026-10-01).
    note.textContent = s.paused
      ? (s.pausedQueue ? 'The queue was paused with them, and resumes with them.'
        : s.queue?.paused ? 'The queue is paused by its own Pause; Resume requests leaves it paused.'
          : 'The queue is running (resumed by hand); Resume requests leaves it so.')
      : s.replaying ? `Running the held requests, in the order they came: ${held} to go.`
        : held ? `${held} held request(s) wait to run, in order, once WhatsApp is connected.` : '';
  }
  const qn = $('queue-paused-note');
  if (qn) {
    qn.classList.toggle('hidden', !s.queue?.paused);
    qn.textContent = s.queue?.paused
      ? `Queue paused${s.queue.since ? ` since ${pauseWhen(s.queue.since)}` : ''}${s.queue.by ? ` by ${s.queue.by}` : ''} \u2014 it stays paused through a restart until Resume.`
      : '';
  }
}

function renderTransfer(q) {
  const box = $('transfer-live');
  if (!box) return;
  // Transfers are per file, so a season shows the episode(s) actually moving.
  const jobs = q.active.flatMap(jobsOf);
  if (!jobs.length) { box.innerHTML = '<div class="empty">No transfer in progress.</div>'; return; }
  box.innerHTML = jobs.map((job) => {
    const p = job.progress ?? {};
    const pct = p.pct ?? 0;
    const stageLabel = { download: 'Downloading', convert: 'Converting', upload: 'Sending to WhatsApp',
                         start: 'Preparing', wait: 'Waiting', done: 'Complete' }[p.stage] ?? 'Working';
    const got = p.receivedBytes, tot = p.totalBytes;
    return `
      <div class="dl">
        <div class="dl-head"><span class="dl-name">${esc(job.label)}</span><span class="dl-pct">${pct}%</span></div>
        <div class="bar big"><i style="width:${pct}%"></i></div>
        <div class="dl-row">
          <span class="dl-stage">${esc(stageLabel)}</span>
          ${got != null && tot ? `<span>${fmtBytes(got)} of ${fmtBytes(tot)}</span>` : (tot ? `<span>${fmtBytes(tot)}</span>` : '')}
          ${p.bytesPerSec ? `<span class="dl-speed">${fmtBytes(p.bytesPerSec)}/s</span>` : ''}
          ${p.etaSec != null ? `<span>${fmtDur(p.etaSec)} remaining</span>` : ''}
        </div>
        <div class="dl-sub">${esc(p.text || '')}</div>
      </div>`;
  }).join('<hr class="act-div">');
}

async function loadTransfers() {
  const box = $('transfer-history');
  if (!box) return;
  try {
    const list = await api('GET', '/transfers');
    if (!list.length) { box.innerHTML = '<div class="empty">No transfers yet.</div>'; return; }
    box.innerHTML = list.map((t) => `
      <div class="item">
        <div class="item-top">
          <span class="item-title">${esc(t.title)}${t.year ? ` <span class="muted">(${t.year})</span>` : ''}</span>
          <span class="muted small">${fmtBytes(t.bytes)}</span>
        </div>
        <div class="item-sub">
          ${fmtDateTime(t.at)} \u00b7 ${esc(t.action)}${t.access === 'local' ? ' (read in place)' : ''}${t.requester ? ` \u00b7 ${esc(phoneOut(t.requester))}` : ''}
        </div>
        <div class="dl-row" style="margin-top:6px">
          ${t.downloadSec ? `<span>download <b>${fmtDur(t.downloadSec)}</b></span>` : ''}
          ${t.avgBytesPerSec ? `<span><b>${fmtBytes(t.avgBytesPerSec)}/s</b> avg</span>` : ''}
          ${t.convertSec ? `<span>convert <b>${fmtDur(t.convertSec)}</b></span>` : ''}
          ${t.uploadSec ? `<span>send <b>${fmtDur(t.uploadSec)}</b></span>` : ''}
          <span>total <b>${fmtDur(t.totalSec)}</b></span>
        </div>
      </div>`).join('');
  } catch (err) {
    box.innerHTML = `<div class="verdict bad">${esc(err.message)}</div>`;
  }
}

function renderQueue(q) {
  // "Skipping…" lasts until the job being skipped has gone. For a season
  // that is the one episode, not the row: the rest of it carries on.
  if (pendingSkip && !q.active.some((j) => jobsOf(j).some((c) => c.id === pendingSkip))) pendingSkip = null;
  renderActivity(q);
  renderTransfer(q);
  const retrying = q.retrying ?? [];
  $('queue-count').textContent = q.active.length + q.pending.length + retrying.length;

  // The running job has its own panel; this list is what is waiting behind it,
  // in the order it will start - the same place the number on each request's
  // message shows. With strict movie priority every film starts before any
  // TV, so the arrows never offer to swap a film and a show: nothing would
  // change.
  const waiting = q.pending;
  const box = $('queue-list');
  // A film the fair order holds behind the TV (queue.fairShare) is in a lane
  // of its own after the TV until its hold ends, as the queue's arrows are.
  const lane = (j) => (q.strictMoviePriority === false ? 'all' : (j.fair?.heldUntil ? 'held' : (j.kind === 'tv' ? 'tv' : 'movie')));
  // A job whose send failed and that waits for its retry is in no queue
  // until the retry fires - after a delay, for WhatsApp to come back, or for
  // room on the disk. It used to show only as "failed" under Recently
  // finished, with nothing to cancel it by, and then be posted anyway.
  const why = { delay: 'trying again shortly', connection: 'waiting for WhatsApp to reconnect', room: 'waiting for disk space' };
  const retryRows = retrying.map((j) => `
      <div class="item">
        <div class="item-top">
          <span class="item-title">${esc(j.label)}</span>
          <span class="tag retrying">retrying</span>
        </div>
        <div class="item-sub">${esc([`attempt ${j.attempt}${j.max ? ` of ${j.max}` : ''}`, why[j.waitingFor] ?? '',
          j.meta?.requester ? `from ${phoneOut(j.meta.requester)}` : '',
          numberBeside(j.meta?.requester, j.meta?.requesterNumber) ?? ''].filter(Boolean).join(' · '))}</div>
        <div class="row gap" style="margin-top:9px">
          <button class="btn tiny danger" title="${j.kind === 'tv' ? 'Cancel the whole request' : 'Cancel it'}" onclick="cancelJob('${j.id}')">Cancel</button>
        </div>
      </div>`).join('');
  if (!waiting.length) {
    box.innerHTML = retryRows || `<div class="empty">${q.paused ? 'Queue paused.' : 'Nothing waiting.'}</div>`;
  } else {
    box.innerHTML = retryRows + waiting.map((j, i) => {
      const up = i > 0 && lane(waiting[i - 1]) === lane(j);
      const afterFilms = lane(j) === 'tv' && waiting.some((w) => lane(w) === 'movie');
      const topTitle = lane(j) === 'held' ? 'Run next after the TV' : (afterFilms ? 'Run next after the films' : 'Run next');
      const down = i < waiting.length - 1 && lane(waiting[i + 1]) === lane(j);
      const many = !!j.group && (j.jobs?.total ?? 1) > 1;
      const sub = [many ? `${j.jobs.total} episodes` : '', j.meta?.requester ? `from ${phoneOut(j.meta.requester)}` : '']
        .filter(Boolean).join(' · ');
      const number = numberBeside(j.meta?.requester, j.meta?.requesterNumber);
      // An extra request of a member who had another in the queue, or asked
      // inside their cooldown (the fair order): the ones that members asking
      // for one thing go ahead of. The hold's end comes with a queue event,
      // so this needs no timer here.
      const extra = j.fair?.extra
        ? ` <span class="tag extra" title="This member had another request in the queue when they asked for this one, or asked for it within their cooldown of their last one: members asking for one thing go ahead of it.">extra${j.fair.heldUntil ? ` · after TV until ${esc(fmtClock(j.fair.heldUntil, HM))}` : ''}</span>`
        : '';
      return `
      <div class="item">
        <div class="item-top">
          <span class="item-title">${j.place ?? i + 1}. ${esc(j.label)}</span>
          <span><span class="tag pending">waiting</span>${extra}</span>
        </div>
        <div class="item-sub">${esc(sub)}${number ? ` · ${esc(number)}` : ''}</div>
        <div class="row gap" style="margin-top:9px">
          <button class="btn tiny" title="Move up"   onclick="moveJob('${j.id}','up')"   ${up ? '' : 'disabled'}>▲</button>
          <button class="btn tiny" title="Move down" onclick="moveJob('${j.id}','down')" ${down ? '' : 'disabled'}>▼</button>
          <button class="btn tiny" title="${topTitle}" onclick="moveJob('${j.id}','top')"  ${up ? '' : 'disabled'}>⤒ next</button>
          <button class="btn tiny danger"${many ? ' title="Cancel the whole request"' : ''} onclick="cancelJob('${j.id}')">Cancel</button>
        </div>
      </div>`;
    }).join('');
  }

  // Recently finished, so a completed send does not just vanish. A season
  // finishes an episode at a time, so a run of one request's episodes with
  // the same outcome reads as one line.
  const recent = [];
  for (const j of q.history ?? []) {
    const last = recent[recent.length - 1];
    if (last && j.group && last.group === j.group && last.state === j.state) { last.count += 1; continue; }
    if (recent.length === 5) break;
    recent.push({ ...j, count: 1 });
  }
  const done = recent.map((j) => (j.count > 1 ? { ...j, label: `${j.groupLabel ?? j.label} — ${j.count} episodes` } : j));
  const hbox = $('queue-recent');
  if (hbox) {
    hbox.innerHTML = done.length
      ? done.map((j) => `
        <div class="item">
          <div class="item-top">
            <span class="item-title">${esc(j.label)}</span>
            <span class="tag ${j.state}">${j.state}</span>
          </div>
          <div class="item-sub">${j.finishedAt ? fmtClock(j.finishedAt) : ''}${j.error ? ` · ${esc(j.error)}` : ''}</div>
        </div>`).join('')
      : '<div class="empty">Nothing finished yet.</div>';
  }
}

// The elapsed counter should tick even when no event arrives.
setInterval(() => {
  if (document.querySelector('#activity .act-title')) {
    api('GET', '/queue').then(renderQueue).catch(() => {});
  }
}, 5000);

window.cancelJob = async (id) => {
  await api('DELETE', `/queue/${id}`);
  toast('Cancelled');
};

let pendingSkip = null;            // the id of the job being skipped: a film, or one episode
// A hand-queued title goes in past the queue limit; say so, so a queue of
// 51 on a limit of 50 does not look like a bug. A season that lost episodes
// to the rating filter says which, as the request groups are told. `scope`
// is "season 2", a run of episodes ("S01E01–E05") or several seasons, and
// several seasons say which of them did not go in. A season the episode
// limit (maxEpisodesPerRequest) cut says what it left out, and what to type
// here for the next part (`cutNote`): a Re-run of "Arrow season 1" read
// "Queued 10 episodes" of a season of 23 (2026-10-12).
const queuedLabel = (r) => (r.kind === 'tv'
  ? `Queued ${r.queued} episode${r.queued === 1 ? '' : 's'} — ${r.series} ${r.scope ?? `season ${r.season}`}`
  : `Queued ${r.title}${r.year ? ` (${r.year})` : ''}`) + (r.overLimit ? ' — past the queue limit of ' + r.limit : '')
  + (r.cutNote ? ` · ${r.cutNote}` : '')
  + (r.withheldNote ? ` · ${r.withheldNote}` : '')
  + (r.notQueued?.length ? ` · not queued: ${r.notQueued.join(' · ')}` : '');

window.requeue = async (text) => {
  try {
    const r = await api('POST', '/requeue', { text });
    toast(queuedLabel(r));
    loadHistory();
  } catch (err) { toast(err.message, true); }
};

window.moveJob = async (id, dir) => {
  try { await api('POST', `/queue/${id}/move`, { dir }); }
  catch (err) { toast(err.message, true); }
};

window.skipJob = async (id) => {
  pendingSkip = id;
  renderActivity(lastQueue);        // reflect "Skipping…" at once
  toast('Skipping — stopping this job…');
  try {
    await api('POST', `/queue/${id}/skip`);
  } catch (err) {
    pendingSkip = null;
    toast(err.message, true);
  }
  // pendingSkip is cleared in renderQueue once the job has gone.
};
$('btn-rules-save')?.addEventListener('click', async () => {
  $('rules-note').textContent = 'saving…';
  try {
    CONFIG = await api('PUT', '/config', { movieRequests: { rules: $('f-rules').value, rulesCommand: $('f-rules-cmd').value.trim() || '#rules' } });
    $('rules-note').innerHTML = '<span style="color:var(--accent)">saved</span>';
    toast('Rules updated');
  } catch (err) { $('rules-note').innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`; }
});

/* ------------------- assigning a queued item to a member ------------------- */

/* The operator (2026-09-30): "When i manually put an item in the queue I
   should have the option to assign it to a member". The picker lists the
   roster (/api/members) by name and number; what is sent is the member's
   roster key, so only someone in one of the bot's groups can be picked. The
   roster is fetched when a picker is first focused, not with the page. */
let MEMBER_PICKS = null;
// The same roster by number: a pasted +15558100180 (or "+1 (555) 810-0180")
// picks its member though the list labels them "Name · +15558100180".
let MEMBER_PICK_NUMBERS = new Map();
function memberPickLabel(m) {
  const num = m.number ? `+${m.number}` : null;
  return m.name ? (num ? `${m.name} · ${num}` : m.name) : (num ?? String(m.id ?? m.key).split('@')[0]);
}
async function loadMemberPicks() {
  if (MEMBER_PICKS) return MEMBER_PICKS;
  const r = await api('GET', '/members');
  const map = new Map();
  const byNumber = new Map();
  for (const m of r.members ?? []) {
    let label = memberPickLabel(m);
    if (map.has(label)) label = `${label} (${m.key})`;
    map.set(label, m.key);
    const digits = String(m.number ?? '').replace(/[^0-9]/g, '');
    if (digits && !byNumber.has(digits)) byNumber.set(digits, m.key);
  }
  MEMBER_PICKS = map;
  MEMBER_PICK_NUMBERS = byNumber;
  const list = $('q-member-list');
  if (list) list.innerHTML = [...map.keys()].map((l) => `<option value="${esc(l)}"></option>`).join('');
  return map;
}
['q-member', 'pl-member'].forEach((id) => $(id)?.addEventListener('focus', () => {
  loadMemberPicks().catch(() => { MEMBER_PICKS = null; });
}));
/** The roster key for a picker's text: '' for none, or throws for text no member has. */
window.memberKeyFrom = async (id) => {
  const text = ($(id)?.value ?? '').trim();
  if (!text) return '';
  const picks = await loadMemberPicks();
  // A number pasted on its own is the member with exactly that number - a
  // whole one, so a few digits typed never pick somebody by accident.
  const digits = phoneQuery(text);
  const key = picks.get(text) ?? (digits && digits.length >= 7 ? MEMBER_PICK_NUMBERS.get(digits) : null);
  if (!key) throw new Error(`"${text}" is not a member - pick one from the list, or leave it empty.`);
  return key;
};

$('btn-manual-add').addEventListener('click', addManual);
$('manual-add').addEventListener('keydown', (e) => { if (e.key === 'Enter') addManual(); });
async function addManual() {
  const text = $('manual-add').value.trim();
  if (!text) return;
  $('manual-note').textContent = 'looking up…';
  try {
    const member = await memberKeyFrom('q-member');
    const r = await api('POST', '/requeue', { text, member });
    $('manual-add').value = '';
    // Cleared too: the next item is not necessarily for the same person.
    $('q-member').value = '';
    // queuedLabel knows a TV request, which has no title or year - this said
    // "queued undefined (undefined)" for every season typed in here.
    $('manual-note').innerHTML = `<span style="color:var(--accent)">${esc(queuedLabel(r))}</span>`;
    toast(queuedLabel(r));
  } catch (err) {
    $('manual-note').innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`;
  }
}

$('btn-pause').addEventListener('click', () => api('POST', '/queue/pause').then(() => toast('Paused')));
$('btn-resume').addEventListener('click', () => api('POST', '/queue/resume').then(() => toast('Resumed')));
$('btn-req-pause').addEventListener('click', async () => {
  const resuming = !!REQ_PAUSE?.paused;
  try {
    const r = await api('POST', resuming ? '/requests/resume' : '/requests/pause');
    renderRequestPause(r);
    toast(resuming
      ? (r.ran ? `Requests resumed \u2014 running ${r.ran} held, in order` : 'Requests resumed')
      : 'Requests paused \u2014 each new request gets \u23f8\ufe0f');
  } catch (err) {
    if (!err.handled) toast(err.message, true);
  }
});
// One click used to clear the whole line with no second look, and each
// request it clears that came from a group now shows ❌ on its message
// (docs/whatsapp-ban-risk.md, §4c): a hundred requests is a hundred
// reactions, paced, but sent.
window.clearWaitingPrompt = (q) => {
  const n = (q?.pending ?? []).length;
  if (!n) return null;
  // A job assigned to a member on the panel carries their name, but has no
  // message to react on either.
  const asked = (q.pending ?? []).filter((j) => !j.meta?.assigned
    && !/^(manual|panel|bulk re-run)/i.test(String(j.meta?.requester ?? ''))).length;
  return `Clear ${n} waiting request(s)?`
    + (asked ? `\n\nUp to ${asked} requester(s) will see ❌ on their message in the group.` : '');
};
$('btn-clearq').addEventListener('click', async () => {
  const ask = window.clearWaitingPrompt(lastQueue);
  if (ask && !confirm(ask)) return;
  const r = await api('POST', '/queue/clear');
  toast(`Cleared ${r.cleared} waiting job(s)`);
});

/* --------------------------- diagnostics --------------------------- */
// One line on which encoder re-encodes, from encoderStatus() in
// src/media/ffmpeg.js. A GPU turned off after repeated failures says so,
// since films then take several times longer until the bot restarts.
function describeEncoder(e) {
  if (!e) return 'unknown';
  if (e.mode === 'cpu') return 'CPU (libx264), set in Settings';
  if (e.disabled) return `CPU: the GPU failed ${e.failures} times in a row and is off until restart (${e.lastError ?? ''})`;
  if (e.mode === 'nvenc') return `GPU (NVENC), forced in Settings · ${e.nvencEncodes} encoded`;
  if (e.available === true) return `GPU (NVENC) · ${e.nvencEncodes} encoded`;
  if (e.available === false) return 'CPU (libx264): NVENC does not work on this box';
  return 'auto: decided at the first encode';
}
async function loadDiagnostics() {
  try {
    const d = await api('GET', '/diagnostics');
    // Both tools, not just ffmpeg: every send starts by probing the file with
    // ffprobe, so a box with ffmpeg alone fails every film all the same.
    FRESH.ffmpeg = d.ffmpeg ? { ffmpeg: !!d.ffmpeg.ffmpeg, ffprobe: !!d.ffmpeg.ffprobe } : null;
    FRESH.update = d.autoUpdate ?? null;
    FRESH.hourly = d.hourlyCheck ?? null;
    refreshFreshInstall();
    const upd = describeAutoUpdate(d.autoUpdate);
    const updColor = upd.state === 'broken' ? 'var(--warn)' : upd.state === 'done' ? 'var(--accent)' : 'inherit';
    const hc = describeHourlyCheck(d.hourlyCheck);
    const hcColor = hc.state === 'broken' ? 'var(--warn)' : hc.state === 'done' ? 'var(--accent)' : 'inherit';
    const tool = (on) => (on
      ? `<span style="color:var(--accent)">installed</span>`
      : `<span style="color:var(--danger)">MISSING — run install.sh</span>`);
    $('diag').innerHTML = `
      <span class="k">ffmpeg</span><span class="v">${tool(d.ffmpeg.ffmpeg)}</span>
      <span class="k">ffprobe</span><span class="v">${tool(d.ffmpeg.ffprobe)}</span>
      <span class="k">encoder</span><span class="v">${esc(describeEncoder(d.encoder))}</span>
      <span class="k">node</span><span class="v">${esc(d.node)}</span>
      <span class="k">uptime</span><span class="v">${fmtDur(d.uptimeSec)}</span>
      <span class="k">memory</span><span class="v">${esc(d.memory.rssHuman)}</span>
      <span class="k">disk free</span><span class="v">${esc(d.disk?.freeHuman ?? '?')}</span>
      <span class="k">size cap</span><span class="v">${esc(d.maxOutput)}</span>
      <span class="k">work dir</span><span class="v">${esc(d.workDir)}</span>
      <span class="k">code</span><span class="v">${esc(d.code?.commit ? d.code.commit.slice(0, 7) : 'unknown')}</span>
      <span class="k">updates</span><span class="v" style="color:${updColor}">${esc(upd.note)}</span>
      <span class="k">hourly check</span><span class="v" style="color:${hcColor}">${esc(hc.note)}</span>`;
    $('plugin-list').innerHTML = d.plugins.length
      ? d.plugins.map((p) => `<span class="k">${esc(p.name)}</span><span class="v">${esc(p.description)}</span>`).join('')
      : '<span class="k">none loaded</span><span class="v"></span>';
  } catch (err) {
    $('diag').innerHTML = `<span class="k">error</span><span class="v">${esc(err.message)}</span>`;
  }
}
$('btn-diag').addEventListener('click', loadDiagnostics);

// The Ollama agent card: is it answering the discussions group? The panel is
// push-only, so this polls while the dashboard is open, and the Refresh button
// asks now.
const OA_STATES = {
  working: ['good', 'Working'],
  off: ['warn', 'Off — turn it on in the config (discussionAnswers.enabled)'],
  'not-set-up': ['warn', 'Not set up — no Ollama key is saved'],
  failing: ['bad', 'Failing — the AI has not answered since its last error'],
};
async function loadOllamaAgent() {
  const card = $('card-ollama-agent');
  if (!card || card.offsetParent === null) return;
  try {
    const s = await api('GET', '/discussion-answers/status');
    const [cls, label] = OA_STATES[s.state] ?? ['warn', s.state];
    $('oa-state').className = `verdict ${cls}`;
    $('oa-state').textContent = s.state === 'working' && !s.answered && !s.passed && !s.failed
      ? 'Working — nobody has asked it anything in the last day'
      : label;
    const when = (t) => (t ? fmtDateTime(t) : 'never');
    $('oa-stats').innerHTML = [
      ['Model', `${esc(s.model || 'none')}${s.modelIsAutomatic ? ' (automatic)' : ''}`],
      ['Answered (24 h)', s.answered],
      ['Passed to admins (24 h)', s.passed],
      ['AI failed (24 h)', s.failed],
      ['Reminded to keep to the topic (24 h)', s.reminded ?? 0],
      ['Messages it ignored (24 h)', `${s.ignored ?? 0} (not a question, and not to the bot)`],
      ['Answers used this hour', `${s.usedThisHour} of ${s.maxPerHour} per group`],
      ['Last answer', when(s.lastAnswerAt)],
      ...(s.lastError ? [['Last error', esc(String(s.lastError).slice(0, 200))]] : []),
    ].map(([k, v]) => `<div class="kv-row"><span>${esc(k)}</span><span>${v}</span></div>`).join('');
    const rows = (s.recent ?? []).map((e) => {
      const tag = e.outcome === 'answered' ? '🤖 answered' : e.outcome === 'failed' ? '⚠️ AI failed' : e.outcome === 'reminded' ? '👋 topic reminder' : '👤 to admins';
      const detail = e.outcome === 'answered' ? e.answer : (e.why ?? '');
      return `<div class="list-item"><div><strong>${esc(tag)}</strong> · ${esc(fmtDateTime(e.at))} · ${esc(e.who ?? '')}</div>`
        + `<div class="hint">“${esc(e.question ?? '')}”</div>`
        + `<div class="hint">${esc(detail ?? '')}</div></div>`;
    });
    const ignored = (s.recentIgnored ?? []).map((e) => `<div class="hint">${esc(fmtClock(e.at))} · ${esc(e.who ?? '')}: “${esc(e.text)}”${e.why ? ` — ${esc(e.why)}` : ''}</div>`);
    $('oa-recent').innerHTML = (rows.length ? rows.join('') : '<div class="empty">No questions yet.</div>')
      + (ignored.length ? `<div style="margin-top:10px"><strong>Recently ignored</strong> <span class="hint">— seen in the group, not taken as a question</span>${ignored.join('')}</div>` : '');
  } catch (err) {
    if (!err.handled) $('oa-state').textContent = err.message;
  }
}
// The Tickets tab: every ticket opened, member #issues and the agent's, to
// resolve or reopen with a note (src/core/tickets.js). The panel is push-only,
// so this polls once a minute for the open count on the tab.
let TICKETS = [];
let TIX_FILTER = 'open';
async function loadTickets() {
  try {
    const r = await api('GET', '/tickets');
    TICKETS = r.tickets ?? [];
    const open = TICKETS.filter((t) => t.status === 'open').length;
    const badge = $('tix-open-badge');
    badge.textContent = open;
    badge.classList.toggle('hidden', open === 0);
    $('tix-count-open').textContent = open;
    $('tix-count-resolved').textContent = TICKETS.length - open;
    $('tix-count-all').textContent = TICKETS.length;
    renderTickets();
  } catch (err) {
    if (!err.handled && $('tix-list')) $('tix-list').innerHTML = `<div class="verdict bad">${esc(err.message)}</div>`;
  }
}
function renderTickets() {
  const rows = TICKETS.filter((t) => TIX_FILTER === 'all' || t.status === TIX_FILTER);
  if (!rows.length) {
    $('tix-list').innerHTML = `<div class="empty">${TIX_FILTER === 'open' ? 'No open tickets.' : 'Nothing here.'}</div>`;
    return;
  }
  $('tix-list').innerHTML = rows.map((t) => {
    const src = t.source === 'agent' ? '🤖 Agent' : (t.keeper ? '⭐ Keeper #issue' : '🚩 Member #issue');
    const resolved = t.status === 'resolved';
    return `<div class="list-item">
      <div><strong>#${String(t.n).padStart(4, "0")}</strong> · ${esc(src)} · ${esc(fmtDateTime(t.at))} · ${esc(t.who ?? '')}${t.group ? ` · ${esc(t.group)}` : ''}
        · <span class="pill ${resolved ? 'ok' : 'warn'}">${resolved ? 'Resolved' : 'Open'}</span></div>
      <div style="margin:4px 0">${esc(t.text)}</div>
      ${t.replyTo ? `<div class="hint">replying to: “${esc(t.replyTo)}”</div>` : ''}
      ${t.question ? `<div class="hint">question: “${esc(t.question)}”</div>` : ''}
      ${resolved ? `<div class="hint">resolved ${esc(fmtDateTime(t.resolvedAt))}${t.resolvedBy ? ` by ${esc(t.resolvedBy)}` : ''}${t.note ? ` — ${esc(t.note)}` : ''}</div>` : ''}
      <div class="row gap wrap" style="align-items:center;margin-top:6px">
        <input id="tix-note-${t.n}" type="text" maxlength="500" placeholder="${resolved ? 'note (optional)' : 'what was done (optional)'}" style="flex:1;min-width:180px">
        <button class="btn small ${resolved ? '' : 'primary'}" onclick="setTicketStatus(${t.n}, '${resolved ? 'open' : 'resolved'}')">${resolved ? 'Reopen' : 'Resolve'}</button>
      </div>
    </div>`;
  }).join('');
}
window.setTicketStatus = async (n, status) => {
  const note = $(`tix-note-${n}`)?.value ?? '';
  try {
    await api('POST', `/tickets/${n}/status`, { status, note });
    toast(status === 'resolved' ? `Ticket #${String(n).padStart(4, "0")} resolved` : `Ticket #${String(n).padStart(4, "0")} reopened`);
    loadTickets();
  } catch (err) {
    if (!err.handled) toast(err.message);
  }
};
$('tix-filter').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tix]');
  if (!b) return;
  TIX_FILTER = b.dataset.tix;
  document.querySelectorAll('#tix-filter .seg-btn').forEach((x) => x.classList.toggle('active', x === b));
  renderTickets();
});
$('btn-tix-refresh').addEventListener('click', loadTickets);
document.querySelector('.tab[data-tab="tickets"]').addEventListener('click', loadTickets);
setInterval(loadTickets, 60000);
loadTickets();
$('btn-oa-refresh').addEventListener('click', loadOllamaAgent);
setInterval(loadOllamaAgent, 30000);
loadOllamaAgent();

/* ------------------------ connectivity check ----------------------- */
async function runConnCheck() {
  const box = $('conncheck');
  box.innerHTML = '<div class="empty">Checking…</div>';
  try {
    const d = await api('GET', '/test/connectivity');
    box.innerHTML = d.results.map((r) => `
      <div class="item">
        <div class="item-top">
          <span class="item-title">${esc(r.name)}</span>
          <span class="tag ${r.ok ? 'done' : 'failed'}">${r.ok ? `HTTP ${r.status}` : 'failed'}</span>
        </div>
        <div class="item-sub">${r.ok ? `${r.ms} ms` : esc(r.error)}${r.hint ? `<br><strong>${esc(r.hint)}</strong>` : ''}</div>
      </div>`).join('') +
      (d.anyCertProblem
        ? `<div class="verdict bad" style="margin-top:10px">TLS interception detected — see certs/README.txt</div>`
        : '') +
      (d.extraCaLoaded
        ? `<div class="item-sub" style="margin-top:8px">Extra CA bundle loaded: <code>${esc(d.extraCaLoaded)}</code></div>`
        : '');
  } catch (err) {
    box.innerHTML = `<div class="verdict bad">${esc(err.message)}</div>`;
  }
}
$('btn-conncheck').addEventListener('click', runConnCheck);

/* ------------------------------ tests ------------------------------ */
$('btn-test-lib').addEventListener('click', async () => {
  const btn = $('btn-test-lib');
  btn.disabled = true;
  const t0 = Date.now();
  // A cold Jellyfin search can take a while; show it is still working
  // rather than looking frozen.
  const tick = setInterval(() => {
    $('lib-result').textContent = `testing… ${Math.round((Date.now() - t0) / 1000)}s`;
  }, 500);
  try {
    const r = await api('POST', '/test/library');
    $('lib-result').innerHTML = r.ok
      ? `<span style="color:var(--accent)">connected in ${((Date.now() - t0) / 1000).toFixed(1)}s</span>`
      : `<span style="color:var(--danger)">${esc(r.error)}</span>`;
  } catch (err) {
    $('lib-result').innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`;
  } finally {
    clearInterval(tick);
    btn.disabled = false;
  }
});

/* -------------------------- jellyfin sign-in ------------------------- */
$('f-jf-method').addEventListener('change', () => { syncJfSections(); refreshJfStatus(); });

function syncJfSections() {
  const m = $('f-jf-method').value;
  document.querySelectorAll('.jf-auth').forEach((el) => {
    el.classList.toggle('hidden', el.dataset.jf !== m);
  });
}

async function refreshJfStatus() {
  const box = $('jf-status');
  if (!box) return;
  if ($('f-libprovider').value !== 'jellyfin' || !$('f-jf-url').value) { box.innerHTML = ''; return; }
  box.innerHTML = '<span class="muted small">checking…</span>';
  try {
    const st = await api('GET', '/jellyfin/status');
    const bits = [];
    bits.push(st.linked
      ? `<span style="color:var(--accent)">● linked${st.userName ? ` as ${esc(st.userName)}` : ''}</span>`
      : '<span style="color:var(--warn)">● not linked</span>');
    if (st.authMethod === 'quickconnect' && !st.quickConnectAvailable) {
      bits.push('<span class="muted small">Quick Connect is switched off on the server (Dashboard → Quick Connect)</span>');
    }
    if (st.linked) bits.push('<button class="btn small" id="btn-jf-unlink">Unlink</button>');
    box.innerHTML = bits.join('<br>');
    const un = $('btn-jf-unlink');
    if (un) un.addEventListener('click', async () => {
      try {
        await api('POST', '/jellyfin/unlink');
      } catch (err) {
        if (!err.handled) toast(err.message, true);
        return;
      }
      toast('Jellyfin unlinked');
      await rereadJellyfinAuth();
      refreshJfStatus();
    });
  } catch (err) {
    box.innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`;
  }
}

/**
 * Catch the page's copy of the config up after a route that changed the config
 * on the server but did not hand it back: Jellyfin sign-in, Quick Connect and
 * Unlink (which store the token themselves), and switching number (which
 * rewrites the pairing number). Without it the fresh-install checklist sent
 * someone to sign in, they did, the toast said "Signed in as bot" - and the row
 * stayed red until a reload; after Unlink it went on saying "signed in". The
 * /config hook in api() redraws the checklist from what this fetches.
 *
 * The form is deliberately NOT refilled, because that would throw away unsaved
 * edits in every settings group; each caller syncs only the field its own
 * route wrote.
 */
async function rereadConfig() {
  try {
    CONFIG = await api('GET', '/config');
    return true;
  } catch (err) {
    // The change itself worked; only the page's copy is behind. Say so, so a
    // checklist still showing the old state is not taken at its word.
    if (!err.handled) {
      toast(`Saved on the server, but the page could not re-read settings (${err.message}) — reload to see it`, true);
    }
    return false;
  }
}

/**
 * The hidden Jellyfin user id is written by these routes and sent back by the
 * main Save, so left stale, the next Save would blank the id the sign-in had
 * just stored.
 */
async function rereadJellyfinAuth() {
  if (await rereadConfig()) $('f-jf-user').value = CONFIG.library?.jellyfin?.userId ?? '';
}

$('f-jf-url').addEventListener('blur', refreshJfStatus);

$('btn-jf-login').addEventListener('click', async () => {
  const btn = $('btn-jf-login');
  btn.disabled = true;
  $('jf-status').innerHTML = '<span class="muted small">signing in…</span>';
  try {
    const r = await api('POST', '/jellyfin/link/password', {
      baseUrl: $('f-jf-url').value,
      username: $('f-jf-username').value,
      password: $('f-jf-password').value,
    });
    toast(`Signed in as ${r.userName}`);
    $('f-jf-password').value = '';
    await rereadJellyfinAuth();
    await refreshJfStatus();
  } catch (err) {
    $('jf-status').innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`;
  } finally {
    btn.disabled = false;
  }
});

let qcTimer = null;
$('btn-jf-qc').addEventListener('click', async () => {
  const box = $('jf-qc-box');
  clearInterval(qcTimer);
  box.innerHTML = '<span class="muted small">requesting a code…</span>';
  try {
    const r = await api('POST', '/jellyfin/quickconnect/start', { baseUrl: $('f-jf-url').value });
    box.innerHTML = `
      <div class="pair-box">
        <div class="muted small">Enter this code in Jellyfin</div>
        <div class="pair-code">${esc(r.code)}</div>
        <ol class="pair-steps">
          <li>Open Jellyfin on any device you are already signed in to</li>
          <li>Profile menu → <strong>Quick Connect</strong></li>
          <li>Type the code above and confirm</li>
        </ol>
        <div id="qc-wait" class="muted small">waiting for approval…</div>
      </div>`;

    // Poll until approved or the code expires.
    const started = Date.now();
    qcTimer = setInterval(async () => {
      if (Date.now() - started > 300000) {
        clearInterval(qcTimer);
        $('qc-wait').innerHTML = '<span style="color:var(--danger)">code expired — try again</span>';
        return;
      }
      try {
        const p = await api('GET', `/jellyfin/quickconnect/poll?id=${encodeURIComponent(r.id)}`);
        if (p.authenticated) {
          clearInterval(qcTimer);
          box.innerHTML = '';
          toast(`Linked as ${p.userName}`);
          await rereadJellyfinAuth();
          refreshJfStatus();
        }
      } catch (err) {
        clearInterval(qcTimer);
        $('qc-wait').innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`;
      }
    }, 2000);
  } catch (err) {
    box.innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`;
  }
});

$('btn-test').addEventListener('click', runTest);
$('test-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') runTest(); });

async function runTest() {
  const text = $('test-input').value.trim();
  if (!text) return;
  $('test-out').innerHTML = '<div class="empty">Checking…</div>';
  try {
    const r = await api('POST', '/test/request', { text });
    // The AI check never refuses anything since 2026-09-29 ("No, AI only
    // helps"), so a title its rating blocks that the check did not clear is
    // "Blocked: rating", with the reason beside it; a title on the bypass
    // list is sent without the check, and the verdict says so.
    const verdicts = {
      'would-send': ['good', r.reason ? `Would send — ${r.reason}` : 'Passes every check — the bot would send this'],
      'blocked-rating': ['bad', r.reason ? `Blocked: ${r.reason}` : 'Blocked: rating'],
      // Step 4b: the server's file is not the film that was asked for.
      'wrong-film': ['bad', 'Blocked: the file on the server is a different film'],
      'not-yet-theatrical': ['bad', 'Not on the server yet — still in theaters'],
      'not-found': ['bad', 'No matching film'],
      'not-in-library': ['bad', 'Not in your library'],
      'need-year': ['bad', 'Ambiguous — needs a year'],
      'one-at-a-time': ['bad', 'Several films in one request — the member is told to send each on its own'],
      // Step 0 of a request, which the dry run takes too since the "which
      // one?" list left beta for every group (2026-10-11): it had said
      // "Ambiguous — needs a year" where members were shown the list.
      'pick-list': ['warn', r.reason ? `Asks which one — a list of ${r.reason}` : 'Asks which one — the requester gets a list to pick from'],
      narrow: ['bad', 'Too many films start with that — the requester is asked for another word or the year'],
      error: ['bad', 'Error'],
    };
    const [vc, vt] = verdicts[r.verdict] ?? ['bad', r.verdict];
    $('test-out').innerHTML =
      r.steps.map((s) => `
        <div class="step ${s.ok ? 'ok' : 'no'}">
          <span class="step-name">${esc(s.step)}</span>
          <span class="step-detail">${esc(s.detail)}</span>
          ${s.reaction ? `<span class="step-emoji">${esc(s.reaction)}</span>` : ''}
        </div>`).join('') +
      `<div class="verdict ${vc}">${esc(vt)}</div>`;
  } catch (err) {
    $('test-out').innerHTML = `<div class="verdict bad">${esc(err.message)}</div>`;
  }
}

/* ----------------------------- history ----------------------------- */
function historyTimeline(x) {
  const t = x.timings;
  const rows = [];
  if (x.requestedAt) rows.push(`<span>requested <b>${fmtClock(x.requestedAt)}</b></span>`);
  if (x.at) rows.push(`<span>bot got it <b>${fmtClock(x.at)}</b></span>`);
  if (t?.receiveLatencySec != null && t.receiveLatencySec > 1) rows.push(`<span>delivery lag <b>${fmtDur(t.receiveLatencySec)}</b></span>`);
  if (t) {
    if (t.queueWaitSec != null) rows.push(`<span>queued <b>${fmtDur(t.queueWaitSec)}</b></span>`);
    if (t.downloadSec) rows.push(`<span>download <b>${fmtDur(t.downloadSec)}</b></span>`);
    if (t.convertSec) rows.push(`<span>convert <b>${fmtDur(t.convertSec)}</b></span>`);
    if (t.uploadSec) rows.push(`<span>send <b>${fmtDur(t.uploadSec)}</b></span>`);
    if (t.totalSec != null) rows.push(`<span>work <b>${fmtDur(t.totalSec)}</b></span>`);
    if (t.endToEndSec != null) rows.push(`<span>request→done <b>${fmtDur(t.endToEndSec)}</b></span>`);
  }
  return rows.length ? `<div class="dl-row" style="margin-top:6px">${rows.join('')}</div>` : '';
}

/**
 * A History row's number, as +digits. The rows stored before 2026-10-01 say
 * "+1 (555) 807-0190" (the operator could not paste it into the Members
 * tab), and some carry only the bare digits.
 */
function historyNumber(x) {
  return numberBeside(x.requester, x.requesterNumberDisplay ?? x.requesterNumber);
}

/**
 * What a film's History row says about what was sent, beyond its status: a
 * film this member was sent before, and a film the library sent in place of
 * the one the request was taken for. On 2026-10-11 at 11:21 UTC "fast and
 * furios 6" was sent Fast & Furious (2009), the film jake had been sent on
 * 2026-10-09 at 03:42 UTC, for a Fast and Furious (1939) the server does not
 * have, and the row said neither. Times on the 24-hour clock (fmtDateTime).
 */
function historyNotes(x) {
  const notes = [];
  const film = (f) => `${esc(f.title)}${f.year ? ` (${esc(f.year)})` : ''}`;
  if (x.sentBefore) {
    notes.push(`Already sent to this member${x.sentBefore.at ? ` on ${esc(fmtDateTime(x.sentBefore.at))}` : ''}${
      x.sentBefore.request ? `, for "${esc(x.sentBefore.request)}"` : ''} — asked for again.`);
  }
  if (x.sentFor?.title) {
    notes.push(`${x.sentFor.file?.title ? `The library's ${film(x.sentFor.file)}` : 'Another film'} was sent for ${
      film(x.sentFor)}, which is not on the server.`);
  }
  return notes.map((n) => `<br><span style="color:var(--warn)">${n}</span>`).join('');
}

/**
 * One history row, used by both the movie and TV sections.
 *
 * The quote shows what the member typed (`typed`, when it differs), and
 * Re-run sends `request`, which is what was actually looked up: for an answer
 * to a "which one?" list that is "Venom 2011", and re-running the bare
 * "Venom" the member first typed sent whichever Venom OMDb returns first.
 */
function historyRow(x) {
  return `
      <div class="item">
        <div class="item-top">
          <span class="item-title">${x.kind === 'tv' ? '📺 ' : ''}${esc(x.title ?? x.request)}${x.year ? ` <span class="muted">(${x.year})</span>` : ''}${
            x.kind === 'tv' && x.season != null ? ` <span class="muted">S${String(x.season).padStart(2, '0')}${x.episodes > 1 ? ` · ${x.episodes} eps` : ''}</span>` : ''}</span>
          ${x.beta
            ? `<span><span class="tag">🧪 beta</span> <span class="tag ${x.status}">${esc(x.status)}</span></span>`
            : `<span class="tag ${x.status}">${esc(x.status)}</span>`}
        </div>
        <div class="item-sub">
          "${esc(x.typed ?? x.request)}" · ${esc(phoneOut(x.requester) ?? '?')}${historyNumber(x) ? ` · ${esc(historyNumber(x))}` : ''}
          ${x.detail ? `<br>${esc(x.detail)}` : ''}
          ${historyNotes(x)}
          ${x.rerun ? `<br><span class="muted">Re-run ${esc(fmtDateTime(x.rerun.at))}: ${esc(x.rerun.why ?? 'it arrived on the server')}${
            x.rerun.trigger === 'manual' && x.rerun.by ? `, by ${esc(x.rerun.by)}` : x.rerun.trigger === 'arrival' ? ', found by the wanted recheck' : ''}${
            x.rerun.was?.status ? ` - first answered ${esc(x.rerun.was.status)}` : ''}</span>` : ''}
          ${x.contentCheckSkipped ? `<br><span style="color:var(--warn)">Not checked for nudity: the AI check did not
            run, so its rating alone decided. Reason: ${esc(x.contentCheckSkipped)}${
              x.contentCheckSkippedWhy ? ` (${esc(x.contentCheckSkippedWhy)})` : ''}.</span>` : ''}
          ${x.override && x.kind !== 'tv' ? `<br><span class="muted">${esc(x.override)}</span>` : ''}
          ${x.contentCheck?.provider ? `<br><span class="muted">Nudity check: ${
            x.contentCheck.nudity === true ? 'contains nudity' : x.contentCheck.nudity === false ? 'no nudity' : 'did not know the film'}${
            x.contentCheck.confidence != null ? ` (${esc(x.contentCheck.confidence)})` : ''}, judged by ${
            esc(x.contentCheck.by ?? x.contentCheck.provider)}${x.contentCheck.model ? ` · ${esc(x.contentCheck.model)}` : ''}${
            x.contentCheck.note ? ` — ${esc(x.contentCheck.note)}` : ''}</span>` : ''}
        </div>
        ${historyTimeline(x)}
        ${x.beta
          // Re-run queues panel work, which goes to the MAIN posts group. A
          // test request re-run from here would land in front of every member.
          ? '<div class="small muted" style="margin-top:8px">beta test — re-run it by asking again in the beta group</div>'
          : `<button class="btn tiny" style="margin-top:8px" onclick="requeue(${JSON.stringify(x.request).replace(/"/g,'&quot;')})">↻ Re-run</button>`}
      </div>`;
}

/**
 * Movies and TV get their own sections: a season buried among films is hard to
 * find, and they are answered by different pipelines.
 */
/**
 * Movies and TV are separate panes rather than two stacked lists.
 *
 * Stacked, the TV section sat below 121 movie rows - roughly 78,000 characters
 * of scrolling - so it read as missing entirely. Only one pane is on screen,
 * and each renders a page at a time so a long history stays responsive.
 */
const HIST_PAGE = 40;
let HISTORY = { movies: [], tv: [] };
let histShown = { movies: HIST_PAGE, tv: HIST_PAGE };

function renderHistPane(which) {
  const rows = HISTORY[which] ?? [];
  const box = $(which === 'tv' ? 'history-tv' : 'history-list');
  const more = $(which === 'tv' ? 'hist-more-tv' : 'hist-more-movies');
  if (!box) return;
  const shown = rows.slice(0, histShown[which]);
  box.innerHTML = shown.length ? shown.map(historyRow).join('')
    : `<div class="empty">No ${which === 'tv' ? 'TV' : 'movie'} requests yet.</div>`;
  if (more) {
    more.innerHTML = pagerButtons({ shown: shown.length, total: rows.length, page: HIST_PAGE, noun: 'older',
      more: `moreHistory('${which}')`, all: `allHistory('${which}')` });
  }
}
window.moreHistory = (which) => { histShown[which] += HIST_PAGE; renderHistPane(which); };
/*
 * Infinity rather than the number of rows there are now: History is drawn
 * again on every reload (Refresh, a Re-run, Clear), and nothing resets how
 * far a pane has been paged, so a pane shown in full stays in full, with a
 * request that came in since at the top and no "Show 1 more" under it.
 */
window.allHistory = (which) => { histShown[which] = Infinity; renderHistPane(which); };

function showHistPane(which) {
  $('hist-pane-movies')?.classList.toggle('hidden', which !== 'movies');
  $('hist-pane-tv')?.classList.toggle('hidden', which !== 'tv');
  document.querySelectorAll('#hist-tabs .seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.hist === which);
  });
  try { localStorage.setItem('botpanel.histPane', which); } catch { /* private mode */ }
}
$('hist-tabs')?.addEventListener('click', (e) => {
  const b = e.target.closest('.seg-btn');
  if (b) showHistPane(b.dataset.hist);
});

async function loadHistory() {
  try {
    const h = await api('GET', '/history');
    renderDashHistory(h);
    HISTORY = {
      movies: h.filter((x) => x.kind !== 'tv'),
      tv: h.filter((x) => x.kind === 'tv'),
    };
    if ($('hist-movie-count')) $('hist-movie-count').textContent = HISTORY.movies.length;
    if ($('hist-tv-count')) $('hist-tv-count').textContent = HISTORY.tv.length;
    renderHistPane('movies');
    renderHistPane('tv');
    let saved = null;
    try { saved = localStorage.getItem('botpanel.histPane'); } catch { /* ignore */ }
    showHistPane(saved === 'tv' ? 'tv' : 'movies');
  } catch { /* not fatal */ }
}
// Wanted now sits on this tab, so Refresh means both. Refreshing the requests
// and leaving the list under them stale is the sort of thing that gets read as
// "the wanted list is wrong".
$('btn-hist-refresh').addEventListener('click', () => { loadHistory(); window.__wanted?.load(); });
$('btn-hist-rerunall').addEventListener('click', async () => {
  const btn = $('btn-hist-rerunall');
  btn.disabled = true;
  $('hist-note').textContent = 'looking up and queueing… this can take a moment';
  try {
    const r = await api('POST', '/requeue-all');
    $('hist-note').innerHTML =
      `<span style="color:var(--accent)">queued ${r.queued.length}</span>` +
      (r.skipped.length ? ` · <span class="muted">skipped ${r.skipped.length} (blocked / not found / not in library)</span>` : '') +
      (r.betaSkipped ? ` · <span class="muted">${r.betaSkipped} beta test(s) left for the beta group — ask again there to re-run</span>` : '');
    toast(`Queued ${r.queued.length} movie(s)`);
    loadHistory();
  } catch (err) {
    $('hist-note').innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`;
  } finally {
    btn.disabled = false;
  }
});
$('btn-transfers-refresh').addEventListener('click', loadTransfers);
$('btn-transfers-clear').addEventListener('click', async () => {
  await api('DELETE', '/transfers'); loadTransfers(); toast('Transfer history cleared');
});
$('btn-hist-clear').addEventListener('click', async () => {
  await api('DELETE', '/history'); loadHistory(); toast('History cleared');
});

/* ------------------------------- logs ------------------------------ */
async function loadLogs() {
  try {
    logLines = await api('GET', '/logs?n=300');
    renderLog();
  } catch { /* not fatal */ }
}
function logLine(l) {
  const t = fmtClock(l.ts);
  // A line logged before 2026-10-01 says "[from Name +1 (555) 807-0190]".
  return `<span class="lg-${l.level}"><span class="lg-ts">${t}</span> [${l.level}] (${esc(l.scope)}) ${esc(phonesInText(l.msg))}</span>\n`;
}
function scrollLog() {
  if ($('log-follow').checked) { const b = $('log-out'); b.scrollTop = b.scrollHeight; }
}
$('btn-log-clear').addEventListener('click', () => { logLines = []; renderLog(); });

/* --------------------------- password ------------------------------ */
$('btn-chpw').addEventListener('click', async () => {
  const cur = $('f-pw-cur').value;
  const next = $('f-pw-new').value;
  const again = $('f-pw-new2').value;
  const bad = (m) => { $('pw-result').innerHTML = `<span style="color:var(--danger)">${esc(m)}</span>`; };

  // Caught here rather than after a round trip, so a typo in a field you
  // cannot read back does not just report "wrong" with no idea which one.
  if (!cur || !next) return bad('Fill in your current and new password');
  if (next !== again) return bad('The two new passwords do not match');
  if (next.length < 8) return bad('The new password must be at least 8 characters');
  if (next === cur) return bad('That is your current password');

  try {
    const r = await api('POST', '/auth/password', { current: cur, next });
    $('f-pw-cur').value = ''; $('f-pw-new').value = ''; $('f-pw-new2').value = '';
    $('pw-result').innerHTML = `<span style="color:var(--accent)">updated${
      r?.endedElsewhere ? ` — signed out ${r.endedElsewhere} other session${r.endedElsewhere === 1 ? '' : 's'}` : ''}</span>`;
    toast('Password updated');
  } catch (err) {
    bad(err.message);
  }
});

/* ------------------------------ email ------------------------------ */
$('f-em-provider').addEventListener('change', syncEmailSections);
function syncEmailSections() {
  $('em-custom').classList.toggle('hidden', $('f-em-provider').value !== 'custom');
}

function emailBody() {
  return {
    provider: $('f-em-provider').value,
    host: $('f-em-host').value,
    port: +$('f-em-port').value,
    secure: $('f-em-secure').checked,
    user: $('f-em-user').value,
    appPassword: $('f-em-pass').value,
    to: $('f-em-to').value,
    enabled: true,
  };
}

async function emailAction(btn, url, body, okMsg) {
  const el = $('em-result');
  const b = $(btn);
  b.disabled = true;
  el.innerHTML = '<span class="muted">working…</span>';
  try {
    const r = await api('POST', url, body);
    el.innerHTML = r.ok
      ? `<span style="color:var(--accent)">${esc(okMsg)}${r.detail ? ` — ${esc(r.detail)}` : ''}</span>`
      : `<span style="color:var(--danger)">${esc(r.error)}</span>`;
    if (r.ok) toast(okMsg);
  } catch (err) {
    if (!err.handled) el.innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`;
  } finally {
    b.disabled = false;
  }
}

$('btn-em-verify').addEventListener('click', () =>
  emailAction('btn-em-verify', '/email/verify', emailBody(), 'Credentials accepted'));
$('btn-em-test').addEventListener('click', () =>
  emailAction('btn-em-test', '/email/test', emailBody(), 'Test email sent'));
$('btn-em-sendlog').addEventListener('click', () =>
  emailAction('btn-em-sendlog', '/email/send-log', {}, "Log emailed"));

/* --------------------------- saved log files ----------------------- */
async function loadLogFiles() {
  const box = $('logfiles');
  try {
    const files = await api('GET', '/logs/files');
    if (!files.length) { box.innerHTML = '<div class="empty">No log files yet.</div>'; return; }
    box.innerHTML = files.map((f) => `
      <div class="item">
        <div class="item-top">
          <span class="item-title">${esc(f.name)}</span>
          <span class="muted small">${fmtBytes(f.size)}${f.gzipped ? ' · gzipped' : ''}</span>
        </div>
        <div class="item-sub">${fmtDateTime(f.mtime)}</div>
        <div class="row gap" style="margin-top:8px">
          <button class="btn small" onclick="viewLogFile('${esc(f.name)}')">View</button>
          <a class="btn small" href="/api/logs/download/${encodeURIComponent(f.name)}">Download</a>
        </div>
      </div>`).join('');
  } catch (err) {
    box.innerHTML = `<div class="verdict bad">${esc(err.message)}</div>`;
  }
}

/**
 * View opens the file in a box under the list, and brings the box on screen:
 * it opened below the bottom of the screen, where nobody saw it, and View
 * looked like it did nothing. (The box is a fixed height, so it is brought on
 * screen at once, "loading…" and all.)
 */
window.viewLogFile = async (name) => {
  const view = $('logfile-view');
  view.classList.remove('hidden');
  view.textContent = 'loading…';
  scrollToElement(view, 'nearest');
  try {
    const res = await fetch(`/api/logs/file/${encodeURIComponent(name)}`);
    // A file written before 2026-10-01 says "[from Name +1 (555) 807-0190]";
    // shown as +15558070190, like the live log (logLine). Download keeps the
    // file exactly as it was written.
    view.textContent = phonesInText(await res.text());
    view.scrollTop = view.scrollHeight;
  } catch (err) {
    view.textContent = `error: ${err.message}`;
  }
};

$('btn-logfiles-refresh').addEventListener('click', loadLogFiles);
$('btn-logfiles-email').addEventListener('click', () =>
  emailAction('btn-logfiles-email', '/email/send-log', { label: "today's debug log" }, 'Log emailed'));

/* --------------------------- live log filter ----------------------- */
const LEVEL_RANK = { debug: 0, info: 1, warn: 2, error: 3 };
let logLines = [];

/** Compact mirrors of the log and history, shown on the dashboard. */
function renderDashMirrors() {
  const dl = $('dash-log');
  if (dl) {
    dl.innerHTML = logLines.slice(-40).map(logLine).join('');
    dl.scrollTop = dl.scrollHeight;
  }
}

function renderDashHistory(list) {
  const box = $('dash-history');
  if (!box) return;
  const recent = (list ?? []).slice(0, 6);
  box.innerHTML = recent.length
    ? recent.map((x) => `
      <div class="item compact">
        <div class="item-top">
          <span class="item-title">${esc(x.title ?? x.request)}${x.year ? ` <span class="muted">(${x.year})</span>` : ''}</span>
          <span class="tag ${x.status}">${esc(x.status)}</span>
        </div>
        <div class="item-sub">${esc(phoneOut(x.requester) ?? '')} · ${fmtClock(x.at)}</div>
      </div>`).join('')
    : '<div class="empty">Nothing yet.</div>';
}

function renderLog() {
  const q = $('log-filter').value.toLowerCase();
  const min = $('log-level').value;
  const minRank = min ? LEVEL_RANK[min] : -1;
  const shown = logLines.filter((l) => {
    if (minRank >= 0 && LEVEL_RANK[l.level] < minRank) return false;
    if (min === 'error' && l.level !== 'error') return false;
    if (q && !textMatches(`${l.scope} ${l.msg}`, q)) return false;
    return true;
  });
  $('log-out').innerHTML = shown.map(logLine).join('');
  $('log-count').textContent = `${shown.length} of ${logLines.length} lines`;
  scrollLog();
  renderDashMirrors();
}

$('log-filter').addEventListener('input', renderLog);
$('log-level').addEventListener('change', renderLog);

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B','KB','MB','GB'];
  const i = Math.min(u.length-1, Math.floor(Math.log(n)/Math.log(1024)));
  return `${(n/1024**i).toFixed(i?1:0)} ${u[i]}`;
}

/* --------------------------- members / lockdown -------------------- */

/* ------------------------- lockdown cities -------------------------- */
/* Which city each end of the lockdown is measured in. The operator chose New
   York candle-lighting and Jerusalem havdalah on 2026-09-22, knowing it
   reopens the groups late on Saturday morning in New York and leaves New
   York's second day of yom tov open. So the hint spells out the next lock and
   unlock in both cities whenever the card is open, and says so when the
   groups would open while it is still Shabbos or yom tov in New York - that
   consequence should never have to be worked out from two dropdowns. It is
   information, not an error: nothing is blocked. */
const LOCK_CITIES = {
  'new-york': { name: 'New York', tz: 'America/New_York' },
  jerusalem: { name: 'Jerusalem', tz: 'Asia/Jerusalem' },
};
// The same defaults as src/config/schema.js, for a config saved before the
// cities existed.
const LOCK_CITY_DEFAULT = { candle: 'new-york', havdalah: 'jerusalem' };

function lockCityKey(key, end) {
  return typeof key === 'string' && Object.hasOwn(LOCK_CITIES, key) ? key : LOCK_CITY_DEFAULT[end];
}
function lockCityName(key, end) { return LOCK_CITIES[lockCityKey(key, end)].name; }

/** "Sat, Sep 26, 11:51" as the clock reads in that city, wherever the browser is. */
function lockTimeIn(t, key) {
  return new Date(t).toLocaleString('en-US', { timeZone: LOCK_CITIES[key].tz,
    weekday: 'short', month: 'short', day: 'numeric', ...HM, ...CLOCK_24 });
}

/** The hint under the city pickers, from status.window or GET /lockdown/preview. */
function lockWindowHint(w, { unsaved = false } = {}) {
  if (!w) return '';
  const lead = unsaved ? '<strong>If saved:</strong> ' : '';
  // Now, not next week: the groups have just reopened and New York is still
  // in Shabbos or yom tov. The card used to move straight on to the next
  // block at the unlock, so during exactly the hours the note below is about
  // it only ever described the following week. Not for an unsaved choice -
  // that is a past nobody lived through.
  const reopenedLine = w.reopened && !unsaved
    ? `<span style="color:var(--warn)">ⓘ The groups reopened ${esc(lockTimeIn(w.reopened.unlockAt, 'new-york'))} New York`
      + ` while it is still ${w.reopened.yomTov ? 'Shabbos / yom tov' : 'Shabbos'} there, until `
      + `${esc(lockTimeIn(w.reopened.nyHolyUntil, 'new-york'))}.</span><br>`
    : '';
  if (!w.lockAt || !w.unlockAt) {
    return `${reopenedLine}<span class="muted">${lead}no lock in the next few weeks (candle-lighting in `
      + `${esc(lockCityName(w.candleCity, 'candle'))}, havdalah in ${esc(lockCityName(w.havdalahCity, 'havdalah'))})</span>`;
  }
  const both = (t) => `<strong>${esc(lockTimeIn(t, 'new-york'))}</strong> New York`
    + ` <span class="muted">(${esc(lockTimeIn(t, 'jerusalem'))} Jerusalem)</span>`;
  let html = `${reopenedLine}${lead}${w.inWindow ? 'Locked since' : 'Next lock'} ${both(w.lockAt)} → unlock ${both(w.unlockAt)}`
    + (w.label ? ` · ${esc(w.label)}` : '');
  if (w.nyHolyUntil) {
    html += `<br><span style="color:var(--warn)">ⓘ The groups reopen while it is still `
      + `${w.yomTov ? 'Shabbos / yom tov' : 'Shabbos'} in New York, which ends there `
      + `${esc(lockTimeIn(w.nyHolyUntil, 'new-york'))}.</span>`;
  }
  if (w.fallback) html += `<br><span class="muted">${esc(w.fallback)}</span>`;
  return html;
}
/* ----------------------- end lockdown cities ------------------------ */

/* What the lockdown card would save, read ONE way for Save and for the
   preview. They used to read the minutes differently - Save as `+box`, so an
   emptied box was stored as 0, while the preview skipped it and showed the
   saved minutes - and "If saved:" could show times the save would not have
   produced. An empty box is null here, and the server refuses it with the
   reason, the same way for both. */
function lockFormValues() {
  const minutes = (id) => { const v = $(id).value.trim(); return v === '' ? null : Number(v); };
  return {
    candleCity: $('f-lock-candle-city').value,
    havdalahCity: $('f-lock-havdalah-city').value,
    candleMinutes: minutes('f-lock-candle'),
    havdalahMinutes: minutes('f-lock-havdalah'),
    yomTov: $('f-lock-yomtov').checked,
  };
}

/* The hint for what is on screen, before it is saved: choosing a city is
   choosing when the groups reopen, so show the real times for the choice
   first. A slow answer for an older choice must not overwrite a newer one. */
let lockPreviewSeq = 0;
async function previewLockWindow() {
  const box = $('lock-cities-hint');
  if (!box) return;
  const saved = CONFIG?.lockdown ?? {};
  const want = lockFormValues();
  const unsaved = want.candleCity !== lockCityKey(saved.candleCity, 'candle')
    || want.havdalahCity !== lockCityKey(saved.havdalahCity, 'havdalah')
    || want.candleMinutes !== (saved.candleMinutes ?? 18)
    || want.havdalahMinutes !== (saved.havdalahMinutes ?? 20)
    || want.yomTov !== (saved.yomTov !== false);
  const seq = ++lockPreviewSeq;
  // null (an empty box) goes as an empty value, which the server refuses the
  // way it refuses the same box on Save - not as the word "null".
  const query = new URLSearchParams(Object.entries(want).map(([k, v]) => [k, v ?? '']));
  try {
    const w = await api('GET', `/lockdown/preview?${query}`);
    if (seq === lockPreviewSeq) box.innerHTML = lockWindowHint(w, { unsaved });
  } catch (err) {
    if (seq === lockPreviewSeq) box.innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`;
  }
}
for (const id of ['f-lock-candle-city', 'f-lock-havdalah-city', 'f-lock-candle', 'f-lock-havdalah', 'f-lock-yomtov']) {
  $(id)?.addEventListener('change', previewLockWindow);
}

async function loadLockdown() {
  const box = $('lock-status');
  if (!box) return;
  try {
    const st = await api('GET', '/lockdown/status');
    box.innerHTML = `
      <div class="status-row">
        <span class="dot ${st.locked ? 'bad' : 'ok'}"></span>
        <div>
          <div class="status-title">${st.locked ? '🔒 Groups are LOCKED' : '🔓 Groups are open'}${st.source ? ` <span class="muted small">(${esc(st.source)})</span>` : ''}</div>
          <div class="muted small">
            ${st.enabled ? 'Auto-lockdown ON' : 'Auto-lockdown off'}
            ${st.label ? ` · <strong>${esc(st.label)}</strong>` : ''}
            ${st.nextLockAt ? ` · ${st.inWindow ? 'locked since' : 'next lock'} ${esc(lockTimeIn(st.nextLockAt, 'new-york'))}` : ''}
            ${st.nextUnlockAt ? ` · unlock ${esc(lockTimeIn(st.nextUnlockAt, 'new-york'))} (New York time)` : ''}
          </div>
          ${st.enabled && st.held ? `<div class="small" style="color:var(--warn)">Waiting: the schedule locks nothing until a group
            is ticked under <em>Always-locked groups</em> below, or havdalah would open every admin-only group.
            <em>Sync from WhatsApp</em> finds them; if none of your groups is admins-only for good, <em>Save</em> this
            card as it is.</div>` : ''}
        </div>
      </div>`;
    renderLockUpcoming(st.upcoming ?? []);
    $('f-lock-enabled').checked = !!(CONFIG?.lockdown?.enabled);
    $('f-lock-candle').value = CONFIG?.lockdown?.candleMinutes ?? 18;
    $('f-lock-havdalah').value = CONFIG?.lockdown?.havdalahMinutes ?? 20;
    $('f-lock-yomtov').checked = CONFIG?.lockdown?.yomTov !== false;
    $('f-lock-candle-city').value = lockCityKey(CONFIG?.lockdown?.candleCity, 'candle');
    $('f-lock-havdalah-city').value = lockCityKey(CONFIG?.lockdown?.havdalahCity, 'havdalah');
    // The saved settings win over any preview still on its way back, which
    // would otherwise repaint "If saved:" over what has just been saved.
    lockPreviewSeq++;
    $('lock-cities-hint').innerHTML = lockWindowHint(st.window);
    renderAlwaysLocked();
  } catch (err) { box.innerHTML = `<div class="verdict bad">${esc(err.message)}</div>`; }
}

/* The next few locks, spelled out. A four-day Pesach block reads as a bug
   unless the schedule says what it is and why it does not open in between.
   In New York time, like the rest of the card: with the ends in two cities, a
   browser's own clock (Israel, or a server in UTC) made the same window read
   differently depending on who opened the page. */
function renderLockUpcoming(list) {
  const box = $('lock-upcoming');
  if (!box) return;
  if (!list.length) { box.innerHTML = ''; return; }
  const when = (t) => lockTimeIn(t, 'new-york');
  box.innerHTML = '<strong>Coming up</strong> <span class="muted">(New York time)</span><br>' + list.map((b) => {
    const hrs = Math.round((new Date(b.unlockAt) - new Date(b.lockAt)) / 3600000);
    return `<div>${b.yomTov ? '🕯️' : '🕯'} ${esc(b.label)} — ${when(b.lockAt)} → ${when(b.unlockAt)}`
      + ` <span class="muted">(${hrs}h)</span></div>`;
  }).join('');
}

/* Redrawn with every group list as well as with the lockdown status: drawn
   only here, a page whose status answered before its group list kept "No
   groups loaded" for good, and its Save emptied the list. */
function renderAlwaysLocked() {
  if (!CONFIG) return;
  renderGroupChecks($('always-locked'), 'al-g', CONFIG.lockdown?.alwaysLocked, { hidePrivate: true });
}

/**
 * A pass paces ~1.2s per group, so it can take 20 seconds. Nothing used to
 * happen on screen during that time, so people clicked again — and the
 * overlapping passes each reported a different count. Disable both buttons,
 * say what is happening, then report exactly what changed.
 */
async function runLockdown(locked) {
  const btns = [$('lock-now'), $('unlock-now')].filter(Boolean);
  const note = $('lock-run-note');
  const n = (GROUPS || []).length;
  btns.forEach((b) => { b.disabled = true; });
  // Paced deliberately slowly to avoid WhatsApp's rate limits, so tell the
  // operator how long it will really take rather than leaving them guessing.
  const paceS = Math.max(0, (CONFIG?.lockdown?.pacingMs ?? 5000)) / 1000;
  const etaS = Math.max(5, Math.round(Math.max(0, n - 1) * paceS + n * 0.5));
  const eta = etaS >= 60 ? `${Math.floor(etaS / 60)}m ${etaS % 60}s` : `${etaS}s`;
  if (note) note.innerHTML = `<span class="muted">${locked ? 'locking' : 'unlocking'} ${n || ''} group${n === 1 ? '' : 's'}, one at a time… about ${eta}. Paced on purpose so WhatsApp doesn't rate-limit the account.</span>`;
  try {
    const r = await api('POST', locked ? '/lockdown/lock' : '/lockdown/unlock');
    const s = r.summary ?? {};
    const bits = [`${s.changed ?? 0} ${locked ? 'locked' : 'unlocked'}`];
    if (s.skipped) bits.push(`${s.skipped} always-locked (skipped)`);
    if (s.failed) bits.push(`${s.failed} failed`);
    if (note) {
      note.innerHTML = `<span style="color:${s.failed ? 'var(--warn)' : 'var(--accent)'}">${bits.join(' · ')}</span>`
        + (r.failures?.length
            ? '<br>' + r.failures.map((f) => `<span class="muted small">${esc(f.subject)}: ${esc(f.error)}</span>`).join('<br>')
            : '');
    }
    toast(bits.join(' · '));
    loadLockdown();
  } catch (err) {
    // A 409 means a pass is already running — say so instead of "error".
    if (note) note.innerHTML = `<span style="color:var(--warn)">${esc(err.message)}</span>`;
    toast(err.message, true);
  } finally {
    btns.forEach((b) => { b.disabled = false; });
  }
}

$('lock-now')?.addEventListener('click', () => {
  if (!confirm('Lock ALL groups now? Only admins will be able to post until you unlock.')) return;
  runLockdown(true);
});
$('unlock-now')?.addEventListener('click', () => runLockdown(false));
/* Sync reads every group's real admins-only setting and shows what WOULD
   change. It deliberately writes nothing: this list is what stops the schedule
   opening a group at havdalah, so a wrong entry either seals a group for good
   or opens one on Shabbos. The admin applies it with the normal Save. */
$('al-sync')?.addEventListener('click', async () => {
  const btn = $('al-sync');
  const note = $('al-sync-note');
  const diff = $('al-diff');
  const n = (GROUPS || []).length;
  btn.disabled = true;
  diff.classList.add('hidden');
  // One metadata read per group, paced - so say how long that actually is
  // rather than leaving them wondering whether it hung.
  const etaS = Math.max(5, Math.round(n * 1.5));
  note.innerHTML = `<span class="muted">reading ${n} group${n === 1 ? '' : 's'}, one at a time… about ${etaS}s.`
    + ` Paced on purpose so WhatsApp doesn't rate-limit the account.</span>`;
  try {
    const r = await api('POST', '/lockdown/sync-always');
    const rows = [];
    for (const g of r.add) rows.push(`<div style="color:var(--accent)">+ ${esc(g.subject)} <span class="muted">is admins-only on WhatsApp</span></div>`);
    for (const g of r.remove) rows.push(`<div style="color:var(--warn)">− ${esc(g.subject)} <span class="muted">is open on WhatsApp</span></div>`);
    for (const g of r.unreadable) rows.push(`<div class="muted">? ${esc(g.subject)} — could not read (${esc(g.error)}); left as it is</div>`);

    note.innerHTML = `<span class="muted">read ${r.read}/${r.scanned} · ${r.lockedNow} admins-only on WhatsApp</span>`;
    if (!r.add.length && !r.remove.length) {
      diff.innerHTML = '<div class="empty">Already in step with WhatsApp — nothing to change.</div>';
      diff.classList.remove('hidden');
      return;
    }
    diff.innerHTML = `<div class="verdict"><div style="margin-bottom:8px"><strong>${r.add.length + r.remove.length} change(s)</strong></div>`
      + rows.join('')
      + '<div class="row gap" style="margin-top:10px">'
      + '<button class="btn small primary" id="al-apply">Apply to the tick boxes</button>'
      + '<button class="btn small" id="al-cancel">Cancel</button>'
      + '<span class="muted small">then press Save to store it</span></div></div>';
    diff.classList.remove('hidden');

    $('al-apply').addEventListener('click', () => {
      const want = new Set(r.proposed);
      // Matched on jid. Matching by label text broke on any group whose name is
      // a prefix of another's, and silently left the wrong box ticked.
      const unreadable = new Set((r.unreadable ?? []).map((g) => g.jid).filter(Boolean));
      for (const box of document.querySelectorAll('.al-g')) {
        if (unreadable.has(box.value)) continue;   // could not read it; leave it alone
        box.checked = want.has(box.value);
      }
      diff.classList.add('hidden');
      note.innerHTML = '<span style="color:var(--accent)">applied to the boxes — press Save to store it</span>';
    });
    $('al-cancel').addEventListener('click', () => { diff.classList.add('hidden'); });
  } catch (err) {
    note.innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`;
  } finally {
    btn.disabled = false;
  }
});

$('lock-save')?.addEventListener('click', async () => {
  $('lock-save-note').textContent = 'saving…';
  try {
    const clears = clearGroupsQuery([clearedGroupChecks($('always-locked'), 'al-g') && 'lockdown.alwaysLocked']);
    CONFIG = await api('PUT', `/config${clears}`, { lockdown: {
      enabled: $('f-lock-enabled').checked,
      ...lockFormValues(),
      alwaysLocked: groupChecksValue($('always-locked'), 'al-g'),
    }});
    $('lock-save-note').innerHTML = '<span style="color:var(--accent)">saved</span>';
    loadLockdown();
  } catch (err) { $('lock-save-note').innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`; }
});

function renderMxGroups() {
  const box = $('mx-groups');
  if (!box) return;
  if (!GROUPS.length) { box.innerHTML = '<div class="empty">No groups loaded.</div>'; return; }
  // Groups named "$…" are internal; never offer them for a bulk add, so
  // "select all" can't drop somebody into an admin back-channel.
  const pickable = GROUPS.filter((g) => !g.private);
  const hidden = GROUPS.length - pickable.length;
  box.innerHTML = pickable.map((g) => `
    <label class="check"><input type="checkbox" class="mx-g" value="${esc(g.jid)}">
      <span>${esc(g.subject)} <span class="muted small">(${g.size})</span></span></label>`).join('')
    + (hidden ? `<div class="muted small" style="margin-top:8px">🔒 ${hidden} private group${hidden === 1 ? '' : 's'} hidden (names starting with “$”). Add people to those from the Groups tab.</div>` : '');
}
function mxSelected() { return [...document.querySelectorAll('.mx-g:checked')].map((i) => i.value); }
$('mx-all')?.addEventListener('click', () => document.querySelectorAll('.mx-g').forEach((i) => (i.checked = true)));
$('mx-none')?.addEventListener('click', () => document.querySelectorAll('.mx-g').forEach((i) => (i.checked = false)));

async function mxAcross(action, verb) {
  const number = $('mx-num').value.replace(/[^0-9]/g, '');
  const groupJids = mxSelected();
  if (!number) return toast('Enter a number', true);
  if (!groupJids.length) return toast('Select at least one group', true);
  if ((action === 'demote') && !confirm(`Remove admin from +${number} on ${groupJids.length} group(s)?`)) return;
  $('mx-note').textContent = `${verb}…`;
  try {
    const r = await api('POST', '/members/across', { number, groupJids, action });
    const okc = r.results.filter((x) => !x.error).length;
    $('mx-note').innerHTML = `<span style="color:var(--accent)">${verb} done on ${okc}/${r.results.length} group(s)</span>` +
      r.results.filter((x) => x.error).map((x) => `<br><span class="muted">${esc(x.subject)}: ${esc(x.error)}</span>`).join('');
  } catch (err) { $('mx-note').innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`; }
}
$('mx-add')?.addEventListener('click', () => mxAcross('add', 'Adding'));
$('mx-promote')?.addEventListener('click', () => mxAcross('promote', 'Promoting'));
$('mx-demote')?.addEventListener('click', () => mxAcross('demote', 'Demoting'));

$('mx-banall')?.addEventListener('click', async () => {
  const number = $('mx-num').value.replace(/[^0-9]/g, '');
  if (!number) return toast('Enter a number', true);
  if (!confirm(`BAN +${number} from ALL groups and add to the banned list? This removes them everywhere.`)) return;
  $('mx-note').textContent = 'banning from all groups…';
  try {
    const r = await api('POST', '/members/ban-all', { number });
    const w = r.wiped || {};
    $('mx-note').innerHTML = `<span style="color:var(--accent)">removed from ${r.results.length} group(s) and added to the banned list</span>` +
      (w.deleted ? `<br><span class="muted small">🧹 deleted ${w.deleted} recent message(s)${w.failed ? ` — ${w.failed} were too old or the bot isn't admin there` : ''}</span>` : '');
    loadBanned();
  } catch (err) { $('mx-note').innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`; }
});

async function loadBanned() {
  const box = $('banned-list');
  if (!box) return;
  try {
    const list = await api('GET', '/banned');
    $('banned-count').textContent = list.length;
    box.innerHTML = list.length ? list.map((n) => `
      <div class="item compact">
        <div class="item-top">
          <span class="item-title">+${esc(n)}</span>
          <button class="btn tiny" onclick="unban('${esc(n)}')">Remove from list</button>
        </div>
      </div>`).join('') : '<div class="empty">No banned numbers.</div>';
  } catch { /* ignore */ }
}
window.unban = async (n) => { await api('DELETE', `/banned/${encodeURIComponent(n)}`); toast(`+${n} removed from banned list`); loadBanned(); };
$('ban-add')?.addEventListener('click', async () => {
  const n = $('ban-add-num').value.replace(/[^0-9]/g, '');
  if (!n) return;
  // banning locally only (no group removal) — just add to the list
  try {
    const cur = await api('GET', '/banned');
    if (!cur.includes(n)) { CONFIG = await api('PUT', '/config', { bannedNumbers: [...cur, n] }); }
    $('ban-add-num').value = ''; loadBanned();
  } catch (err) { toast(err.message, true); }
});

/* --------------------------- accounts / audit ---------------------- */
function applyUser() {
  const u = CURRENT_USER;
  $('who').textContent = u ? `${u.username}${u.role === 'superadmin' ? ' · super-admin' : ''}` : '';
  const isSuper = u?.role === 'superadmin';
  document.querySelectorAll('.superadmin-only').forEach((el) => el.classList.toggle('hidden', !isSuper));
  // The sign-out timeout is the super-admin's alone; the server refuses a plain
  // admin's save that changes it. Disabled rather than hidden, so everyone can
  // still see what it is.
  $('f-idle').disabled = !isSuper;
  $('f-idle-lock').classList.toggle('hidden', isSuper);
}

/* Per-admin sign-out timeouts. */
let ADMIN_IDLE_DEFAULT = 15;
const idleWords = (m) => (m === 0 ? 'never signed out' : `signed out after ${m} min idle`);
const idleNote = (own) => (own === null || own === undefined
  ? `uses the default — ${idleWords(ADMIN_IDLE_DEFAULT)}` : idleWords(own));
const validIdle = (n) => Number.isInteger(n) && n >= 0 && n <= 1440;

/** Say what the number in a row's box will mean before it is saved. */
window.admIdleHint = (username) => {
  const box = $(`adm-idle-${username}`), note = $(`adm-idle-note-${username}`);
  if (!box || !note) return;
  const raw = box.value.trim();
  if (box.validity?.badInput) note.textContent = 'whole minutes, 0–1440';
  else if (raw === '') note.textContent = idleNote(null);
  else note.textContent = validIdle(Number(raw)) ? idleWords(Number(raw)) : 'whole minutes, 0–1440';
};

window.adminSetTimeout = async (username) => {
  const box = $(`adm-idle-${username}`);
  if (!box) return;
  const raw = box.value.trim();
  // An empty box means the default. A number box holding text it cannot parse
  // also reads as '', so check for that rather than resetting someone by accident.
  if (box.validity?.badInput) { toast('Whole minutes from 0 to 1440, or empty for the default', true); return; }
  const minutes = raw === '' ? null : Number(raw);
  if (minutes !== null && !validIdle(minutes)) {
    toast('Whole minutes from 0 to 1440, or empty for the default', true);
    return;
  }
  try {
    await api('PUT', `/admins/${encodeURIComponent(username)}/timeout`, { minutes });
    toast(minutes === null ? `${username} now uses the default` : `${username}: ${idleWords(minutes)}`);
    loadAdmins();
  } catch (err) { toast(err.message, true); }
};

/** My account: what the idle guard will actually apply to whoever is looking. */
function renderMyIdle(mine) {
  const el = $('my-idle');
  if (!el || !mine) return;
  el.textContent = mine.minutes === 0
    ? 'You are never signed out for being idle.'
    : `You are signed out after ${mine.minutes} minute${mine.minutes === 1 ? '' : 's'} without activity`
      + `${mine.own === null ? ' — the default for every admin.' : ' — set for your account by the super-admin.'}`;
}

async function loadAdmins() {
  const box = $('admins-list');
  if (!box) return;
  try {
    const r = await api('GET', '/admins');
    FRESH.admins = r.admins ?? null;
    refreshFreshInstall();
    ADMIN_IDLE_DEFAULT = r.defaultIdleMinutes ?? 15;
    renderMyIdle(r.myIdle);
    const isSuper = CURRENT_USER?.role === 'superadmin';
    const defLabel = `default (${ADMIN_IDLE_DEFAULT === 0 ? 'never' : ADMIN_IDLE_DEFAULT})`;
    box.innerHTML = r.admins.map((a) => `
      <div class="item compact">
        <div class="item-top">
          <span class="item-title" style="cursor:pointer" onclick="showAdminAudit('${esc(a.username)}')"
                title="see what this admin has done">${esc(a.username)} ${a.role === 'superadmin' ? '<span class="tag done">super-admin</span>' : '<span class="tag">admin</span>'}</span>
          <span class="row gap">
            <button class="btn tiny" onclick="showAdminAudit('${esc(a.username)}')">Activity</button>
            ${isSuper ? `
              <button class="btn tiny" onclick="adminReset('${esc(a.username)}')">Reset password</button>
              ${a.username !== CURRENT_USER.username ? `<button class="btn tiny danger" onclick="adminRemove('${esc(a.username)}')">Remove</button>` : ''}` : ''}
          </span>
        </div>
        <div class="item-sub">${a.lastLogin ? 'last login ' + fmtDateTime(a.lastLogin) : 'never signed in'}${
          a.mustChangePassword ? ' · temporary password: they choose their own at next sign-in' : ''}</div>
        ${isSuper ? `
        <div class="adm-idle">
          <label>Sign out after
            <input id="adm-idle-${esc(a.username)}" type="number" min="0" max="1440" step="1"
                   placeholder="${defLabel}" value="${a.idleTimeoutMinutes ?? ''}"
                   oninput="admIdleHint('${esc(a.username)}')"> min idle
          </label>
          <button class="btn tiny" onclick="adminSetTimeout('${esc(a.username)}')">Save</button>
          <span class="muted" id="adm-idle-note-${esc(a.username)}">${esc(idleNote(a.idleTimeoutMinutes))}</span>
        </div>` : `<div class="item-sub">${esc(idleNote(a.idleTimeoutMinutes))}</div>`}
        <div id="adm-audit-${esc(a.username)}" class="hidden" style="margin-top:10px;border-top:1px solid var(--line);padding-top:10px"></div>
      </div>`).join('');
  } catch { /* non-super admins can still see their own via /admins */ }
}

/**
 * One admin's own audit trail, opened in place under their row. Answering
 * "what has this person been doing" meant scrolling the whole flat log before.
 *
 * The row is brought on screen as the trail opens, and again once it is in.
 * On a 390x844 phone with three admins, the third admin's Activity (or their
 * name) opened the trail below the bottom of the screen, and the tab is too
 * short to scroll it up: the press looked like it did nothing. The row, not
 * just the trail, so whose trail it is, and the Activity that folds it away,
 * stay in view: a trail that fits comes up to the bottom of the screen, and a
 * longer one starts with the admin's name just under the bars.
 */
window.showAdminAudit = async (username) => {
  const box = $(`adm-audit-${username}`);
  if (!box) return;
  if (!box.classList.contains('hidden')) { box.classList.add('hidden'); return; }
  // Not once it has been folded away again, by a second press while it loaded.
  const reveal = () => { if (!box.classList.contains('hidden')) scrollToElement(box.closest('.item') ?? box, 'nearest'); };
  box.classList.remove('hidden');
  box.innerHTML = '<div class="empty">Loading…</div>';
  reveal();
  try {
    const d = await api('GET', `/admins/${encodeURIComponent(username)}/audit?limit=100`);
    if (!d.total) { box.innerHTML = '<div class="empty">No recorded activity.</div>'; return; }
    const s = d.summary;
    const when = (t) => (t ? fmtDateTime(t) : '—');
    box.innerHTML = `
      <div class="small muted" style="margin-bottom:8px">
        ${d.total} action(s) · first ${when(s.first)} · most recent ${when(s.last)}<br>
        ${s.top.map((t) => `${esc(t.label)}: ${t.count}`).join(' · ')}
      </div>
      ${d.events.map((e) => `
        <div class="item compact">
          <div class="item-top">
            <span class="item-title">${esc(phonesInText(e.action))}</span>
            <span class="muted small">${fmtDateTime(e.ts)}</span>
          </div>
          ${e.detail && e.detail !== e.action ? `<div class="item-sub">${esc(phonesInText(e.detail))}</div>` : ''}
        </div>`).join('')}
      ${d.total > d.events.length ? `<div class="empty">showing ${d.events.length} of ${d.total}</div>` : ''}`;
  } catch (err) {
    box.innerHTML = `<div class="verdict bad">${esc(err.message)}</div>`;
  } finally {
    reveal();
  }
};

$('na-add')?.addEventListener('click', async () => {
  const username = $('na-user').value.trim(), password = $('na-pass').value, role = $('na-role').value;
  $('na-note').textContent = 'adding…';
  try {
    await api('POST', '/admins', { username, password, role });
    $('na-user').value = ''; $('na-pass').value = '';
    $('na-note').innerHTML = '<span style="color:var(--accent)">added - they choose their own password the first time they sign in</span>';
    loadAdmins();
  } catch (err) { $('na-note').innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`; }
});
window.adminRemove = async (u) => {
  if (!confirm(`Remove admin "${u}"? They will no longer be able to sign in.`)) return;
  try { await api('DELETE', `/admins/${encodeURIComponent(u)}`); toast(`Removed ${u}`); loadAdmins(); }
  catch (err) { toast(err.message, true); }
};
window.adminReset = async (u) => {
  const own = u.toLowerCase() === String(CURRENT_USER?.username ?? '').toLowerCase();
  const pw = prompt(own ? `New password for "${u}" (8+ chars):`
    : `Temporary password for "${u}" (8+ chars). They will be asked to choose their own when they sign in:`);
  if (!pw) return;
  try {
    await api('POST', `/admins/${encodeURIComponent(u)}/reset`, { password: pw });
    toast(own ? `Password reset for ${u}` : `Temporary password set for ${u}`);
    loadAdmins();
  }
  catch (err) { toast(err.message, true); }
};

async function loadAudit() {
  const box = $('audit-list');
  if (!box) return;
  try {
    const params = new URLSearchParams();
    if (AUDIT_CAT && AUDIT_CAT !== 'all') params.set('category', AUDIT_CAT);
    if (AUDIT_WHO) params.set('user', AUDIT_WHO);
    const q = $('audit-search')?.value.trim();
    if (q) params.set('q', q);
    params.set('limit', '300');

    const d = await api('GET', `/audit?${params}`);
    const evs = Array.isArray(d) ? d : d.events;
    if (!Array.isArray(d)) renderAuditFilters(d);
    if (!evs.length) {
      const filtered = AUDIT_CAT !== 'all' || AUDIT_WHO || $('audit-search')?.value.trim();
      box.innerHTML = `<div class="empty">${filtered
        ? 'Nothing matches those filters.' : 'No actions recorded yet.'}</div>`;
      return;
    }
    box.innerHTML = evs.map((e) => `
      <div class="item compact">
        <div class="item-top">
          <span class="item-title">${esc(e.user)} <span class="muted">${e.role === 'superadmin' ? '(super)' : ''}</span></span>
          <span class="muted small">${fmtDateTime(e.ts)}</span>
        </div>
        <div class="item-sub">${esc(phonesInText(e.action))}${e.detail && e.detail !== e.action ? ` · ${esc(phonesInText(e.detail))}` : ''}</div>
      </div>`).join('');
  } catch (err) { box.innerHTML = `<div class="verdict bad">${esc(err.message)}</div>`; }
}
$('btn-audit-refresh')?.addEventListener('click', loadAudit);
$('btn-audit-clear')?.addEventListener('click', async () => {
  await api('DELETE', '/audit'); loadAudit(); toast('Audit log cleared');
});

/* --------------------------- groups admin -------------------------- */
let gaCurrent = null;   // jid of the group being edited

function renderGroupsList() {
  const box = $('ga-list');
  if (!GROUPS.length) { box.innerHTML = '<div class="empty">No groups loaded. Connect WhatsApp, then Refresh.</div>'; return; }
  box.innerHTML = GROUPS.map((g) => `
    <div class="item" data-jid="${esc(g.jid)}">
      <div class="item-top">
        <span class="item-title">${esc(g.subject)} <span class="muted small">(${g.size})</span>${betaPill(g.jid)}</span>
        <button class="btn small" onclick="gaOpen('${esc(g.jid)}')">Manage</button>
      </div>
      <div class="gjid">${esc(g.jid)}</div>
    </div>`).join('');
}

/**
 * Open a group's card. The name is looked up rather than passed in by Manage:
 * written into its onclick, a name with an apostrophe - "Head Admin's movie night",
 * which WhatsApp allows - ended the string early, and Manage threw a syntax
 * error and opened nothing.
 */
window.gaOpen = async (jid, name = GROUPS.find((g) => g.jid === jid)?.subject ?? jid) => {
  gaCurrent = jid;
  $('ga-detail').classList.remove('hidden');
  $('ga-name').textContent = name;
  $('ga-desc').value = ''; $('ga-members').innerHTML = '<div class="empty">Loading…</div>';
  $('ga-desc-note').textContent = ''; $('ga-add-note').textContent = '';
  scrollToElement($('ga-detail'), 'start');
  try {
    const d = await api('GET', `/groups/${encodeURIComponent(jid)}/details`);
    $('ga-desc').value = d.desc || '';
    $('ga-count').textContent = d.members.length;
    $('ga-adminwarn').innerHTML = d.botIsAdmin
      ? '<span style="color:var(--accent)">✓ the bot is an admin here — edits and member actions will work</span>'
      : '<span style="color:var(--warn)">⚠ the bot is NOT an admin here — description/member changes will be rejected by WhatsApp</span>';
    renderLockState(d);
    renderMembers(d.members);
  } catch (err) {
    $('ga-members').innerHTML = `<div class="verdict bad">${esc(err.message)}</div>`;
  }
};

/** Show whether this group is admins-only right now, and why. */
function renderLockState(d) {
  const pill = $('ga-lock-state');
  if (!pill) return;
  pill.className = `pill ${d.locked ? 'bad' : 'ok'}`;
  pill.textContent = d.locked ? '🔒 admins only' : '🔓 everyone can post';
  // An always-locked group is skipped by the bulk unlock, so say so here
  // rather than letting an admin wonder why it came back locked.
  $('ga-lock-note').innerHTML = d.alwaysLocked
    ? '<span style="color:var(--warn)">marked always-locked — bulk unlock skips this group</span>'
    : '';
  $('ga-lock').disabled = !!d.locked;
  $('ga-unlock').disabled = !d.locked;
}

async function setGroupLock(locked) {
  if (!gaCurrent) return;
  $('ga-lock-note').textContent = locked ? 'locking…' : 'unlocking…';
  try {
    await api('POST', `/groups/${encodeURIComponent(gaCurrent)}/lock`, { locked });
    const d = await api('GET', `/groups/${encodeURIComponent(gaCurrent)}/details`);
    renderLockState(d);
    toast(locked ? 'Group locked — admins only' : 'Group unlocked');
  } catch (err) { $('ga-lock-note').innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`; }
}
$('ga-lock')?.addEventListener('click', () => setGroupLock(true));
$('ga-unlock')?.addEventListener('click', () => setGroupLock(false));

function renderMembers(members) {
  window._gaMembers = members;
  const q = $('ga-member-filter').value.toLowerCase();
  // A pasted +15558100180 or "+1 (555) 810-0180" finds the member by digits.
  const d = phoneQuery(q);
  const shown = members.filter((m) => !q || (m.number || '').includes(q) || (m.id || '').toLowerCase().includes(q)
    || (!!d && (m.number || '').includes(d)));
  const box = $('ga-members');
  // Is the group being managed the notifications group? If so, offer a
  // per-member tag mute so specific people opt out of being @-pinged.
  const notifyJid = CONFIG?.movieRequests?.notify?.group ?? '';
  const isNotifyGroup = gaCurrent && gaCurrent === notifyJid;
  const muted = new Set((CONFIG?.movieRequests?.notify?.noTag ?? []).map((x) => String(x).replace(/[^0-9]/g, '')));

  box.innerHTML = shown.map((m) => {
    const label = m.number ? `+${m.number}` : `<span class="muted">${esc(m.id)}</span>`;
    const badge = m.admin === 'superadmin' ? '<span class="tag done">owner</span>'
                : m.admin === 'admin' ? '<span class="tag done">admin</span>' : '';
    const who = m.number || m.id;
    const isMuted = m.number && muted.has(m.number);
    const tagBtn = (isNotifyGroup && m.number)
      ? (isMuted
          ? `<button class="btn tiny" onclick="gaTag('${esc(m.number)}',false)">🔔 Tag again</button>`
          : `<button class="btn tiny warn" onclick="gaTag('${esc(m.number)}',true)">🔕 Don't tag</button>`)
      : '';
    return `
      <div class="item">
        <div class="item-top">
          <span class="item-title">${label} ${badge} ${isMuted ? '<span class="tag">not tagged</span>' : ''}</span>
        </div>
        <div class="row gap wrap" style="margin-top:8px">
          ${tagBtn}
          ${m.admin
            ? `<button class="btn tiny" onclick="gaAct('demote','${esc(who)}')">Remove admin</button>`
            : `<button class="btn tiny" onclick="gaAct('promote','${esc(who)}')">Make admin</button>`}
          <button class="btn tiny danger" onclick="gaAct('remove','${esc(who)}')">Remove from group</button>
        </div>
      </div>`;
  }).join('') || '<div class="empty">No members match.</div>';
}

window.gaTag = async (number, muted) => {
  try {
    const r = await api('POST', '/notify/no-tag', { number, muted });
    // keep the local config in sync so the toggle reflects immediately
    if (CONFIG?.movieRequests?.notify) CONFIG.movieRequests.notify.noTag = r.noTag;
    // And the "Never @-tag" box on Settings, which every "Save settings" sends:
    // left as it was, the next save put the old list back and undid this. The
    // one number is added or taken out, so anything typed there unsaved stays.
    const box = $('f-notify-notag');
    if (box) {
      const list = box.value.split(/[\n,]/).map((x) => x.replace(/[^0-9]/g, '')).filter(Boolean);
      box.value = (muted ? [...new Set([...list, number])] : list.filter((x) => x !== number)).map((x) => `+${x}`).join('\n');
    }
    toast(muted ? `+${number} will no longer be tagged` : `+${number} will be tagged again`);
    renderMembers(window._gaMembers || []);
  } catch (err) { toast(err.message, true); }
};

window.gaAct = async (action, who) => {
  const verb = { remove:'remove', promote:'make admin', demote:'remove admin from' }[action];
  // Named as +digits; what is sent stays as the members list holds it.
  const shown = /^\d+$/.test(String(who)) ? `+${who}` : who;
  if ((action === 'remove' || action === 'demote') &&
      !confirm(`Really ${verb} ${shown}? This affects a real person in the group.`)) return;
  try {
    const r = await api('POST', `/groups/${encodeURIComponent(gaCurrent)}/participants`, { action, numbers: [who] });
    const st = r.results?.[0]?.status;
    toast(st && st !== '200' ? `WhatsApp said: ${st}` : `Done: ${verb} ${shown}`);
    gaOpen(gaCurrent, $('ga-name').textContent);   // reload
  } catch (err) { toast(err.message, true); }
};

/**
 * "← back" goes back to the group in the list.
 *
 * It only hid the card. The card sits under the list, so what came up in its
 * place was the lockdown card below it, and the list was a screen or more
 * above: back led somewhere else.
 */
$('ga-close').addEventListener('click', () => {
  const jid = gaCurrent;
  $('ga-detail').classList.add('hidden');
  gaCurrent = null;
  const row = [...$('ga-list').querySelectorAll('.item[data-jid]')].find((r) => r.dataset.jid === jid);
  scrollToElement(row ?? $('ga-list').closest('.card'), row ? 'center' : 'start');
});
$('ga-member-filter').addEventListener('input', () => renderMembers(window._gaMembers || []));

$('ga-desc-save').addEventListener('click', async () => {
  $('ga-desc-note').textContent = 'saving…';
  try {
    await api('PUT', `/groups/${encodeURIComponent(gaCurrent)}/description`, { description: $('ga-desc').value });
    $('ga-desc-note').innerHTML = '<span style="color:var(--accent)">saved</span>';
    toast('Description updated');
  } catch (err) {
    $('ga-desc-note').innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`;
  }
});

$('ga-add-btn').addEventListener('click', async () => {
  const num = $('ga-add-num').value.replace(/[^0-9]/g, '');
  if (!num) return;
  $('ga-add-note').textContent = 'adding…';
  try {
    const r = await api('POST', `/groups/${encodeURIComponent(gaCurrent)}/participants`, { action: 'add', numbers: [num] });
    const st = r.results?.[0]?.status;
    $('ga-add-note').innerHTML = st && st !== '200'
      ? `<span style="color:var(--warn)">WhatsApp returned ${esc(st)} (they may need to be invited, or privacy settings block it)</span>`
      : '<span style="color:var(--accent)">added</span>';
    $('ga-add-num').value = '';
    if (!st || st === '200') gaOpen(gaCurrent, $('ga-name').textContent);
  } catch (err) {
    $('ga-add-note').innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`;
  }
});

async function loadGroupActivity() {
  const box = $('ga-activity');
  if (!box) return;
  try {
    const evs = await api('GET', '/group-activity');
    if (!evs.length) { box.innerHTML = '<div class="empty">No activity recorded yet.</div>'; return; }
    const verb = { add:'joined/added', remove:'left/removed', promote:'promoted to admin', demote:'demoted', 'join-request':'requested to join' };
    box.innerHTML = evs.map((e) => {
      const tgt = (e.targets || []).map((t) => t.number ? `+${t.number}` : t.jid).filter(Boolean).join(', ');
      const by = e.actorNumber ? ` · by +${e.actorNumber}` : '';
      return `
        <div class="item compact">
          <div class="item-top">
            <span class="item-title">${esc(verb[e.action] || e.action)}: ${esc(tgt || '?')}</span>
            <span class="muted small">${fmtDateTime(e.ts)}</span>
          </div>
          <div class="item-sub">${esc(e.groupName)}${by}</div>
        </div>`;
    }).join('');
  } catch (err) { box.innerHTML = `<div class="verdict bad">${esc(err.message)}</div>`; }
}

$('btn-ga-refresh').addEventListener('click', async () => {
  try { GROUPS = unwrapGroups(await api('GET', '/wa/groups?refresh=1')); } catch {}
  renderGroupsList();
});
$('btn-ga-activity-refresh').addEventListener('click', loadGroupActivity);
$('btn-ga-activity-clear').addEventListener('click', async () => {
  await api('DELETE', '/group-activity'); loadGroupActivity(); toast('Activity cleared');
});

/* ------------------------------ SSE -------------------------------- */
let eventSource = null;
function connectEvents() {
  // Re-entering the app after a re-login must not leave the previous stream
  // open, or every update arrives twice.
  if (eventSource) { try { eventSource.close(); } catch {} }
  const es = new EventSource('/events');
  eventSource = es;
  es.addEventListener('status', (e) => renderStatus(JSON.parse(e.data)));
  let lastActive = 0;
  es.addEventListener('queue', (e) => {
    const q = JSON.parse(e.data);
    renderQueue(q);
    // A job just finished - pull the transfer record it wrote. Counted in
    // files, not rows: a season stays one running row from its first episode
    // to its last, and each episode writes a record of its own.
    const files = q.active.flatMap(jobsOf).length;
    if (lastActive > 0 && files < lastActive) loadTransfers();
    lastActive = files;
  });
  es.addEventListener('groups', (e) => { GROUPS = unwrapGroups(JSON.parse(e.data)); renderGroups(); });
  es.addEventListener('groupevent', () => loadGroupActivity());
  es.addEventListener('spares', (e) => onSparesPush(JSON.parse(e.data)));
  es.addEventListener('requestpause', (e) => renderRequestPause(JSON.parse(e.data)));
  // The wanted list changed - another admin resolved a film or wrote a note,
  // a request, the recheck: the Wanted card reloads (wanted.js).
  es.addEventListener('wanted', () => window.__wanted?.changed());
  es.addEventListener('contentcheck', (e) => {
    const s = JSON.parse(e.data);
    renderContentHealth(s);
    renderAiStatus(s);
  });
  es.addEventListener('log', (e) => {
    logLines.push(JSON.parse(e.data));
    if (logLines.length > 600) logLines.shift();
    renderLog();
  });
  es.onerror = () => { /* EventSource retries on its own */ };
}

/* ----------------------- content-check health ---------------------- */
// A nudity check that cannot run falls back to the rating without a word, and
// on 2026-09-22 it did that all morning with nobody the wiser. The server pushes
// its health after every check; this is where the panel says it has stopped.
function renderContentHealth(s) {
  const card = $('card-cc-health');
  const line = $('cc-health-settings');
  const when = (ts) => (ts ? fmtDateTime(ts) : 'unknown');
  if (!s?.enabled) {
    card.classList.add('hidden');
    line.innerHTML = '';
    return;
  }
  const i = s.degraded ? s.incident : null;
  if (i) {
    const films = (i.titles ?? []).map((t) => `${esc(t.title ?? '?')}${t.year ? ` (${esc(t.year)})` : ''}`
      + `${t.source === 'dry run' ? ' <span class="muted">(dry run)</span>' : ''}`).join(', ');
    const earlier = (i.unchecked ?? 0) - (i.titles ?? []).length;
    // Still open after a success means it has been failing on and off. Saying
    // only the old failure read as if the fix just tried on the Test tab had
    // not worked.
    const working = i.lastCheckWorked
      ? `<p>The latest check, ${esc(when(s.lastSuccessAt))}, worked. It has been failing on and off, so one
        success is not taken as fixed: this clears by itself ${i.clearsAt ? `around ${esc(when(i.clearsAt))}` : 'shortly'}
        if nothing fails before then.</p>`
      : '';
    const body = `<strong>${esc(i.headline)}</strong>
      ${working}
      <p>${esc(i.count)} failed check(s) since ${esc(when(i.since))}. Until it works again, films are
        sent or refused on their rating alone.</p>
      ${i.advice ? `<p>${esc(i.advice)}</p>` : ''}
      ${films ? `<p class="muted">Most recent: ${films}${earlier > 0 ? `, and ${esc(earlier)} before those` : ''}</p>` : ''}`;
    $('cc-health-dash').innerHTML = body;
    card.classList.remove('hidden');
    line.innerHTML = `<div class="cc-health-box">${body}</div>`;
    return;
  }
  card.classList.add('hidden');
  // Who answered, and whether the first provider is being held back: a film
  // judged by a fallback is judged under a stricter rule, so it is shown.
  const by = s.answeredBy?.label ? ` by ${esc(s.answeredBy.label)}` : '';
  const fb = s.fallback
    ? `<br>${esc(s.fallback.headline ?? `${s.fallback.label} is being held back`)} — ${
      s.fallback.using ? `using ${esc(s.fallback.using)}` : 'asking the others first'} until ${esc(when(s.fallback.until))}`
    : '';
  line.innerHTML = s.consecutive > 0 && s.lastFailure
    ? `<span style="color:var(--warn)">The last check did not run: ${esc(s.lastFailure.headline)}</span>`
    : s.lastSuccessAt
      ? `Working — last answered ${esc(when(s.lastSuccessAt))}${by}${fb}`
      : 'No check has run yet.';
}

/* --------------------------- AI providers --------------------------- */
// Groq, Cerebras, Mistral and OpenRouter answer the nudity check and the film
// lookup when Gemini cannot - its free tier was gone by mid-morning on
// 2026-09-22. The card loads itself the first time the server pushes the check's health, or
// when Settings is opened, so it needs nothing from enterApp.
let AI = null;              // the card's working copy, edits included, until saved
let aiLoading = null;
// Every provider in the chain, by id, as PROVIDERS in ai-providers.js names
// them: for the fresh-install checklist, which reads the config and not this
// card, and so has no labels of its own.
const AI_NAMES = { gemini: 'Gemini', groq: 'Groq', cerebras: 'Cerebras', mistral: 'Mistral', openrouter: 'OpenRouter', ollama: 'Ollama' };

async function loadAiProviders() {
  if (aiLoading) return aiLoading;
  aiLoading = (async () => {
    try {
      const prev = AI;
      AI = await api('GET', '/ai/providers');
      aiKeepModels(prev);
      renderAiProviders();
    } catch (err) {
      const box = $('ai-list');
      if (box && !err.handled) box.innerHTML = `<div class="verdict bad">${esc(err.message)}</div>`;
    } finally {
      aiLoading = null;
    }
  })();
  return aiLoading;
}

/** A model list loaded with "Load models" survives a save or a reload of the card. */
function aiKeepModels(prev) {
  if (!AI) return;
  for (const p of AI.providers) {
    const old = prev?.providers?.find((x) => x.id === p.id);
    if (old?.models) p.models = old.models;
    if (old?._test) p._test = old._test;
    p._savedClear = p.canClearRated;
  }
}

function aiReasonWord(r) {
  return ({
    'quota-daily': 'daily quota used up',
    quota: 'rate-limited',
    auth: 'bad key',
    'model-not-found': 'unknown model',
    timeout: 'timed out',
    network: 'unreachable',
    server: 'failing on its side',
    incomplete: 'incomplete answers',
    unreadable: 'unreadable answers',
    'out-of-time': 'not reached in time',
  })[r] ?? (r || 'failed');
}

/** The last status the health tracker has for a provider, as a pill. */
function aiStatusPill(st) {
  if (!st) return '';
  const t = (ts) => fmtClock(ts, HM);
  const title = st.headline ? ` title="${esc(st.headline)}"` : '';
  if (st.state === 'off') return `<span class="pill">${st.enabled && !st.hasKey ? 'no key' : 'off'}</span>`;
  if (st.state === 'held') {
    return `<span class="pill warn"${title}>${esc(aiReasonWord(st.reason))} — asked last until ${esc(t(st.until))}</span>`;
  }
  if (st.state === 'failed') {
    return `<span class="pill bad"${title}>${esc(aiReasonWord(st.reason))}${st.at ? ` · ${esc(t(st.at))}` : ''}</span>`;
  }
  if (st.state === 'ok') return `<span class="pill ok">answered${st.at ? ` · ${esc(t(st.at))}` : ''}</span>`;
  return '<span class="pill">not asked yet</span>';
}

function aiModelOptions(p) {
  const auto = p.autoModel ? `Automatic (now ${p.autoModel})` : 'Automatic';
  const list = [...new Set([...(p.models ?? []), ...(p.model ? [p.model] : [])])];
  return `<option value="">${esc(auto)}</option>`
    + list.map((m) => `<option value="${esc(m)}" ${m === p.model ? 'selected' : ''}>${esc(m)}</option>`).join('');
}

function renderAiProviders() {
  const box = $('ai-list');
  if (!box || !AI) return;
  const byId = new Map(AI.providers.map((p) => [p.id, p]));
  box.innerHTML = AI.order.map((id, i) => {
    const p = byId.get(id);
    if (!p) return '';
    const g = id === 'gemini';
    const testBtn = `<button class="btn small" id="ai-${id}-testbtn" ${p._test?.running ? 'disabled' : ''}
            title="Tests the key in the box if one is typed there, otherwise the saved key, with the model chosen here"
            onclick="testAiProvider('${id}')">${p._test?.running ? 'Testing…' : 'Test'}</button>`;
    const keyAndModel = g ? `
        <div class="row gap wrap" style="align-items:center;margin-top:6px">
          ${testBtn}
          <span class="hint" style="margin:0">tests the key and model in the Gemini card above, typed or saved — it only lists
            Gemini's models, so no request is spent from the 20 a day</span>
        </div>` : `
        <div class="row gap wrap" style="align-items:flex-end">
          <label class="flex1">API key <span class="hint">from ${esc(p.console)}${p.apiKey ? ' — a key is saved; leave this blank to keep it' : ''}</span>
            <input id="ai-${id}-key" type="password" autocomplete="off" value="${esc(p._key ?? '')}"
              placeholder="${p.apiKey ? 'saved — leave blank to keep' : 'not set'}" oninput="aiKeyTyped('${id}')">
          </label>
          ${testBtn}
          ${p.keysUrl ? `<a class="ak-get" href="${esc(p.keysUrl)}" target="_blank" rel="noopener">get a key →</a>` : ''}
        </div>
        ${p.apiKey ? `<label class="check"><input type="checkbox" id="ai-${id}-removekey" ${p._removeKey ? 'checked' : ''}> Remove the saved key</label>` : ''}
        <div class="row gap wrap" style="align-items:flex-end">
          <label class="flex1">Model
            <select id="ai-${id}-model">${aiModelOptions(p)}</select>
          </label>
          <button class="btn small" onclick="loadAiModels('${id}')">Load models</button>
        </div>`;
    // Groq, Cerebras and OpenRouter may clear rated films by default since
    // 2026-10-12, the operator's live settings, and their rows still said
    // "leave this off" in amber beside a box a new install starts with
    // ticked, against the default and the docs. A provider that does not
    // clear by default (Mistral) keeps the warning.
    const clearHint = g ? 'on is how Gemini has always worked'
      : p.clearsByDefault
        ? 'on by default: its “no nudity” can send a film its rating blocks, and open models misremember films'
          + ' more often than Gemini - untick it to have it answer the film lookup only'
        : 'its “no nudity” could then send a film its rating blocks; open models misremember films, so leave this off';
    return `
      <div class="item compact ai-row">
        <div class="item-top">
          <span class="item-title">${i + 1}. ${esc(p.label)} <span id="ai-${id}-status">${aiStatusPill(p.status)}</span></span>
          <span class="row gap">
            <button class="btn tiny" ${i === 0 ? 'disabled' : ''} onclick="moveAiProvider('${id}',-1)">▲</button>
            <button class="btn tiny" ${i === AI.order.length - 1 ? 'disabled' : ''} onclick="moveAiProvider('${id}',1)">▼</button>
          </span>
        </div>
        <label class="check"><input type="checkbox" id="ai-${id}-enabled" ${p.enabled ? 'checked' : ''}>
          ${g ? 'Ask Gemini <span class="hint">— its key and model are set in the Gemini card above</span>' : `Ask ${esc(p.label)}`}</label>
        ${keyAndModel}
        <label class="check"><input type="checkbox" id="ai-${id}-clear" ${p.canClearRated ? 'checked' : ''}> May clear rated films
          <span class="hint${g || p.clearsByDefault ? '' : ' ai-warn'}">— ${clearHint}</span></label>
        <div id="ai-${id}-test" class="ai-test">${aiTestResult(p._test)}</div>
      </div>`;
  }).join('');
}

/** Copy what is on screen into the working copy, so a re-render keeps it. */
function readAiForm() {
  if (!AI) return;
  for (const p of AI.providers) {
    const el = (part) => $(`ai-${p.id}-${part}`);
    if (el('enabled')) p.enabled = el('enabled').checked;
    if (el('clear')) p.canClearRated = el('clear').checked;
    if (el('key')) p._key = el('key').value.trim();
    if (el('removekey')) p._removeKey = el('removekey').checked;
    if (el('model')) p.model = el('model').value;
  }
}

window.aiKeyTyped = (id) => {
  // Pasting a key is the whole of switching a provider on, near enough.
  const en = $(`ai-${id}-enabled`);
  if (en && $(`ai-${id}-key`)?.value.trim()) en.checked = true;
  $('ai-note').textContent = 'unsaved — press Save AI providers';
  // A result shown under the row was about the key that was in the box before.
  const p = AI?.providers.find((x) => x.id === id);
  if (p && p._test && !p._test.running) {
    p._test = null;
    aiShowTest(p);
  }
};

window.moveAiProvider = (id, dir) => {
  if (!AI) return;
  readAiForm();
  const i = AI.order.indexOf(id);
  const j = i + dir;
  if (i === -1 || j < 0 || j >= AI.order.length) return;
  [AI.order[i], AI.order[j]] = [AI.order[j], AI.order[i]];
  renderAiProviders();
  $('ai-note').textContent = 'unsaved — press Save AI providers';
};

window.loadAiModels = async (id) => {
  readAiForm();
  const p = AI?.providers.find((x) => x.id === id);
  if (!p) return;
  // The list is fetched on the server with the SAVED key, so a key that only
  // exists in this box has to be saved first; the browser never sends it.
  if (p._key) {
    $('ai-note').textContent = `Save the new ${p.label} key first, then load its models.`;
    return;
  }
  $('ai-note').textContent = `loading ${p.label} models…`;
  try {
    const r = await api('GET', `/ai/providers/${id}/models`);
    p.models = r.models.map((m) => m.id).sort();
    p.autoModel = r.automatic;
    renderAiProviders();
    $('ai-note').textContent = `${p.label}: ${r.models.length} chat model(s); Automatic would pick ${r.automatic ?? 'none'}`;
  } catch (err) {
    $('ai-note').innerHTML = `<span style="color:var(--danger)">${esc(err.message)}${
      err.data?.advice ? ` — ${esc(err.data.advice)}` : ''}</span>`;
  }
};

// What the server sends in place of a saved key (MASK in src/config/store.js).
// Gemini's own key box holds it whenever a key is saved; it means
// "the saved key", never a key to test.
const AI_MASK = '••••••••';

/**
 * What a Test click sends: the key typed in this row's box, if there is one,
 * and the model chosen in the row. With no typed key the server tests the
 * saved one, so an unchanged box never sends a key at all. Gemini's key and
 * model boxes are in the Gemini card above, not in its row here.
 */
function aiTestBody(id) {
  readAiForm();
  const p = AI?.providers.find((x) => x.id === id);
  const g = id === 'gemini';
  const typed = String((g ? $('f-gemini-key')?.value : p?._key) ?? '').trim();
  const body = { model: g ? String($('f-gemini-model')?.value ?? '').trim() : (p?.model ?? '') };
  if (typed && typed !== AI_MASK) body.apiKey = typed;
  return body;
}

/** A test's verdict, and each step it took, for under the row. */
function aiTestResult(t) {
  if (!t) return '';
  if (t.running) return '<span class="muted">testing…</span>';
  const r = t.result ?? {};
  const mark = (ok) => (ok === true ? '✓' : ok === false ? '✗' : '–');
  const steps = Array.isArray(r.steps) ? r.steps : [];
  const which = r.keySource === 'typed' ? 'the key typed in the box — not saved' : r.keySource === 'saved' ? 'the saved key' : '';
  const hover = steps.map((st) => `${mark(st.ok)} ${st.detail}`).join('\n');
  return `<div class="ai-test-head ${r.ok ? 'good' : 'bad'}" title="${esc(hover)}">${esc(r.message ?? (r.ok ? '✓ Works' : '✗ The test failed'))}</div>
    ${which || steps.length ? `<ul class="ai-test-steps">
      ${which ? `<li class="muted">Tested ${esc(which)}</li>` : ''}
      ${steps.map((st) => `<li>${mark(st.ok)} ${esc(st.detail)}</li>`).join('')}
    </ul>` : ''}`;
}

/** Redraw one row's Test button and result without redrawing the card, which would lose what is typed. */
function aiShowTest(p) {
  const btn = $(`ai-${p.id}-testbtn`);
  if (btn) {
    btn.disabled = !!p._test?.running;
    btn.textContent = p._test?.running ? 'Testing…' : 'Test';
  }
  const box = $(`ai-${p.id}-test`);
  if (box) box.innerHTML = aiTestResult(p._test);
}

window.testAiProvider = async (id) => {
  const p = AI?.providers.find((x) => x.id === id);
  if (!p || p._test?.running) return;
  const body = aiTestBody(id);
  p._test = { running: true };
  aiShowTest(p);
  let result;
  try {
    result = await api('POST', `/ai/providers/${id}/test`, body);
  } catch (err) {
    // No key, too soon after the last test, or not a key: refused with the
    // same shape as a result, so it is shown in the same place.
    result = err.data?.message ? err.data : { ok: false, message: `✗ ${err.message}`, steps: [] };
  }
  // The card may have been reloaded or saved while the test ran.
  const cur = AI?.providers.find((x) => x.id === id) ?? p;
  cur._test = { result };
  if (cur !== p) p._test = cur._test;
  aiShowTest(cur);
};

window.retryAiProvider = async (id) => {
  try {
    const prev = AI;
    AI = await api('POST', `/ai/providers/${id}/retry`);
    aiKeepModels(prev);
    renderAiProviders();
    toast('It will be asked in its usual place from the next film');
  } catch (err) { toast(err.message, true); }
};

$('ai-save')?.addEventListener('click', async () => {
  if (!AI) return;
  readAiForm();
  const loosened = AI.providers.filter((p) => p.id !== 'gemini' && p.canClearRated && !p._savedClear);
  if (loosened.length && !confirm(`${loosened.map((p) => p.label).join(' and ')} will be able to clear films their `
    + 'rating blocks, on a "no nudity" answer from an open model that may misremember the film.\n\nSave anyway?')) {
    return;
  }
  const body = { order: AI.order };
  for (const p of AI.providers) {
    if (p.id === 'gemini') {
      body.gemini = { enabled: p.enabled, canClearRated: p.canClearRated };
      continue;
    }
    body[p.id] = { enabled: p.enabled, model: p.model ?? '', canClearRated: p.canClearRated };
    if (p._removeKey) body[p.id].removeKey = true;
    else if (p._key) body[p.id].apiKey = p._key;
  }
  $('ai-note').textContent = 'saving…';
  try {
    const prev = AI;
    AI = await api('PUT', '/ai/providers', body);
    aiKeepModels(prev);
    renderAiProviders();
    $('ai-note').innerHTML = '<span style="color:var(--accent)">saved</span>';
  } catch (err) {
    $('ai-note').innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`;
  }
});

// Settings opened before the event stream has said anything.
$('tabs').addEventListener('click', (e) => {
  if (e.target.closest('.tab')?.dataset.tab === 'settings' && !AI && CURRENT_USER) loadAiProviders();
});

/**
 * The dashboard line for a check running on a fallback, and the per-provider
 * pills on the card. Pushed with the check's health over SSE.
 */
function renderAiStatus(s) {
  const card = $('card-cc-fallback');
  const box = $('cc-fallback-dash');
  const fb = s?.enabled && !s.degraded ? s.fallback : null;
  if (card && box) {
    if (fb) {
      const d = new Date(fb.until);
      const at = `${fmtClock(d, HM)} (${d.toISOString().slice(11, 16)} UTC)`;
      const who = fb.using ?? fb.next?.[0] ?? 'the next provider';
      box.innerHTML = `<strong>${esc(fb.headline ?? `${fb.label} is being held back`)} — using ${esc(who)} until ${esc(at)}.</strong>
        <p>${esc(who)} answers until then. The nudity check only ever helps a film through; ${fb.usingMayClearRated
          ? 'you have allowed it to clear films their rating blocks.'
          : 'it is not allowed to clear films their rating blocks, so the nudity check does not ask it, and those stay blocked.'}</p>
        ${s.answeredBy ? `<p class="muted">Last answered by ${esc(s.answeredBy.label)}${
          s.answeredBy.model ? ` (${esc(s.answeredBy.model)})` : ''}, ${esc(fmtDateTime(s.answeredBy.at))}.</p>` : ''}
        <p><button class="btn tiny" onclick="retryAiProvider('${esc(fb.provider)}')">Ask ${esc(fb.label)} first again now</button>
          <span class="muted small">— after enabling billing, say</span></p>`;
      card.classList.remove('hidden');
    } else {
      card.classList.add('hidden');
      box.innerHTML = '';
    }
  }
  if (!AI) {
    if (CURRENT_USER) loadAiProviders();
    return;
  }
  for (const row of s?.providers ?? []) {
    const p = AI.providers.find((x) => x.id === row.id);
    if (p) p.status = row;
    const el = $(`ai-${row.id}-status`);
    if (el) el.innerHTML = aiStatusPill(row);
  }
}

/* --------------------------- API keys section ----------------------- */
/**
 * Settings → API keys & logins 🔑.
 *
 * The keys were spread over six cards in four settings groups, and the
 * switcher only shows one group at a time, so "where does the TMDB key go"
 * meant opening groups until it turned up. The boxes themselves moved into
 * one section - the same ids, because the fresh-install checklist, the tests
 * and fillForm all address them by id - and this code is what the section
 * needs beyond the markup: a status pill per key, a Test button per key, and
 * a Save that sends these fields and nothing else.
 *
 * The cards the boxes came from no longer send them, so no two saves can
 * fight over the same key.
 */

// What the server sends in place of a saved key (MASK in src/config/store.js).
// A box holding it means "the key already saved", never a key to save or test.
const KEY_MASK = AI_MASK;

/**
 * One entry per key this section owns or tests. `into` writes the value into
 * the body of this section's Save, in the same shape the old card sent, so
 * PUT /config sees exactly the field it always saw.
 */
const KEY_CARDS = [
  { id: 'omdb', label: 'OMDb', box: 'f-omdbkey', pointer: 'ptr-omdb',
    button: 'btn-test-omdb', result: 'omdb-result', test: '/keys/omdb/test',
    saved: (c) => c?.omdb?.apiKey,
    into: (b, v) => { b.omdb = { apiKey: v }; } },
  { id: 'tmdb', label: 'TMDB', box: 'f-tmdbkey', pointer: 'ptr-tmdb',
    button: 'btn-test-tmdb', result: 'tmdb-result', test: '/keys/tmdb/test',
    saved: (c) => c?.movieRequests?.theatrical?.tmdbApiKey,
    into: (b, v) => { b.movieRequests = { theatrical: { tmdbApiKey: v } }; } },
  { id: 'gemini', label: 'Gemini', box: 'f-gemini-key', pointer: 'ptr-gemini',
    button: 'btn-test-gemini', result: 'gemini-result', test: '/ai/providers/gemini/test',
    saved: (c) => c?.gemini?.apiKey,
    into: (b, v) => { b.gemini = { ...b.gemini, apiKey: v }; },
    // Gemini goes through the AI providers' own Test route, which checks the
    // model as well - and lists models rather than generating, so a test
    // never spends one of the 20 requests a day.
    body: () => ({ model: String($('f-gemini-model')?.value ?? '').trim() }) },
  { id: 'direct-links', label: 'Jellyfin share key', box: 'f-dl-apikey', pointer: 'ptr-dl',
    button: 'btn-test-dlkey', result: 'dlkey-result', test: '/keys/direct-links/test',
    saved: (c) => c?.directLinks?.apiKey,
    into: (b, v) => { b.directLinks = { apiKey: v }; } },
];

/**
 * The last Test pressed on this page, per key. Deliberately not persisted and
 * not asked of the server: nothing about a test is stored anywhere, so the
 * pill can only ever say what happened here, just now, rather than promising
 * that a key which worked yesterday still does.
 */
const KEY_TESTS = {};

/**
 * Fill a key box from the saved config, unless something unsaved has been
 * typed into it.
 *
 * Without this, pressing "Save settings" after pasting a key threw the key
 * away in silence: that save no longer carries the key, but it still refills
 * the whole form, and the box went back to the mask as though nothing had
 * been typed.
 */
function fillKeyBox(id, value) {
  const el = $(id);
  if (!el) return;
  const now = String(el.value ?? '');
  if (now && now !== KEY_MASK && now !== String(value ?? '')) return;
  el.value = value ?? '';
}

/**
 * Put this section's own boxes back to whatever the server now holds - the
 * mask for a key it stores, blank for one it does not.
 *
 * Deliberately not fillForm(), which refills every box on the tab: this Save
 * sends five fields and the tab has well over a hundred, so refilling them
 * all reverted anything typed into another card and not saved yet, without a
 * word. That is the same silent loss fillKeyBox() was added to close for the
 * keys, reopened for everything else.
 *
 * Deliberately not fillKeyBox() either. Straight after a save the box still
 * holds the plaintext key while the config answers with the mask, so that
 * guard reads it as "typed, leave it alone": the key stayed legible on screen
 * after it had been stored, and a second press of Save sent it again over
 * whatever had been stored by then.
 */
function refillKeySection() {
  const c = CONFIG ?? {};
  for (const k of KEY_CARDS) {
    const el = $(k.box);
    if (el) el.value = k.saved(c) ?? '';
  }
  const model = $('f-gemini-model');
  if (model) model.value = c.gemini?.model ?? '';
}

/** The labels of the keys typed into this section but not saved through it yet. */
function pendingKeyEdits() {
  return KEY_CARDS.filter((k) => keyBoxValue(k) !== null).map((k) => k.label);
}

/** What a route refuses to test at all, before anything is asked of a service. */
const KEY_REFUSALS = {
  'no-server': 'no server address',
  'no-key': 'no key',
  'key-shape': 'not a key',
  'model-shape': 'not a model name',
  'rate-limited': 'tested too soon',
};

/**
 * Short words for the pill, from the reason a test gave.
 *
 * Gemini's Test goes to the AI providers' route rather than to
 * key-test-routes.js, and that route has a vocabulary of its own - a retired
 * automatic model, a model that cannot answer in JSON, an unreadable model
 * list. None of them were named here, so the pill flattened all of them to
 * "✗ failed" while the line underneath said exactly what had happened.
 * aiReasonWord() is where the AI card already names them.
 */
function keyReasonWord(reason, id) {
  if (reason && Object.hasOwn(KEY_REFUSALS, reason)) return KEY_REFUSALS[reason];
  if (id === 'gemini') return aiReasonWord(reason);
  return ({
    auth: 'bad key',
    quota: 'quota used up',
    timeout: 'timed out',
    network: 'unreachable',
    server: 'server error',
    unreadable: 'odd answer',
  })[reason] ?? 'failed';
}

/** "saved" / "not set", or the last test pressed here, with the time. */
function keyStatus(k) {
  const saved = !!k.saved(CONFIG);
  const t = KEY_TESTS[k.id];
  if (t) {
    const at = fmtClock(t.at, HM);
    return { saved, cls: t.ok ? 'ok' : 'bad', text: `${t.ok ? '✓ tested' : `✗ ${t.word}`} · ${at}` };
  }
  return saved ? { saved, cls: 'ok', text: 'saved' } : { saved, cls: '', text: 'not set' };
}

/** '' to clear the key, a key to save, or null when the box says "leave it alone". */
function keyBoxValue(k) {
  if ($(`ak-${k.id}-remove`)?.checked) return '';
  const v = String($(k.box)?.value ?? '').trim();
  return v && v !== KEY_MASK ? v : null;
}

/**
 * The body of this section's Save: the four keys it owns, and Gemini's model.
 *
 * A box left blank, or still holding the mask, is left OUT of the body
 * entirely rather than sent as ''. The store reads the mask as "unchanged",
 * but a blank would clear the key, and somebody pasting keys from three
 * consoles over a few days expects the ones they have not touched to survive
 * - which is the bargain the AI providers card already makes. Clearing a key
 * is the explicit "Remove the saved key" tick.
 */
function collectKeySection() {
  // Blank is Automatic, the newest Gemini Flash the key can see.
  const body = { gemini: { model: String($('f-gemini-model')?.value ?? '').trim() } };
  for (const k of KEY_CARDS) {
    const v = keyBoxValue(k);
    if (v !== null) k.into(body, v);
  }
  return body;
}

/** A login that stayed with its connection settings, as one status row. */
function keyLoginRows() {
  const c = CONFIG ?? {};
  const lib = c.library ?? {};
  const jf = lib.jellyfin ?? {};
  const em = c.email ?? {};
  const has = (v) => typeof v === 'string' && v.trim() !== '';
  const provider = lib.provider ?? 'jellyfin';
  const unused = (p) => (provider === p ? '' : ` — not in use; the library provider is ${provider}`);
  /**
   * Where "go to →" should land for a provider's own field. Those fields live
   * in a `.lib-section` that syncLibSections() keeps display:none unless that
   * provider is chosen, and scrollIntoView() and focus() are both no-ops on a
   * hidden element - so the link switched to Library & files and then did
   * visibly nothing. The provider picker is the thing that reveals the field,
   * so that is where the link goes until the provider is the one in use.
   */
  const whereFor = (p, field) => (provider === p ? field : '#f-libprovider');

  const method = jf.authMethod ?? 'password';
  const signedIn = has(jf.accessToken);
  const jfKey = method === 'apikey' && has(jf.apiKey);
  return [
    {
      what: 'Jellyfin — the bot’s own login',
      sub: `Finds the file for every request. Its address, sign-in method and Test connection are in Library & files${unused('jellyfin')}.`,
      state: signedIn ? `signed in${jf.userName ? ` as ${jf.userName}` : ''}`
        : jfKey ? 'API key saved'
        : has(jf.password) ? 'password saved, not signed in yet' : 'not set',
      ok: signedIn || jfKey,
      target: method === 'apikey' ? '#f-jf-key' : method === 'quickconnect' ? '#btn-jf-qc' : '#f-jf-password',
    },
    {
      what: 'Plex — X-Plex-Token',
      sub: `Stands in for the Jellyfin login when the library is Plex${unused('plex')}.`,
      state: has(lib.plex?.token) ? 'token saved' : 'not set',
      ok: has(lib.plex?.token),
      target: whereFor('plex', '#f-plex-token'),
    },
    {
      what: 'Custom HTTP index — auth header',
      sub: `Sent with every search against your own index${unused('http')}.`,
      state: has(lib.http?.authHeader) ? 'header saved' : 'not set',
      ok: has(lib.http?.authHeader),
      target: whereFor('http', '#f-http-auth'),
    },
    {
      what: 'Email — app password',
      sub: 'Sends the alerts and the daily summary. Send test email, in Email alerts, proves it end to end.',
      state: has(em.appPassword) ? 'app password saved' : 'not set',
      ok: has(em.appPassword),
      target: '#f-em-pass',
    },
  ];
}

function renderKeyLogins() {
  const box = $('ak-logins');
  if (!box) return;
  box.innerHTML = keyLoginRows().map((r) => `
    <div class="item compact ak-row">
      <span class="ak-what">${esc(r.what)}</span>
      <span class="pill ${r.ok ? 'ok' : ''}">${esc(r.state)}</span>
      <span class="ak-sub">${esc(r.sub)}</span>
      <a href="#" class="card-link" data-goto="settings" data-target="${esc(r.target)}">go to →</a>
    </div>`).join('');
}

/** The pills, the Remove tick and the line each old card keeps in the key's place. */
function renderKeySection() {
  if (!$('ak-note')) return;
  for (const k of KEY_CARDS) {
    const st = keyStatus(k);
    const pill = $(`ak-${k.id}-pill`);
    if (pill) {
      pill.className = st.cls ? `pill ${st.cls}` : 'pill';
      pill.textContent = st.text;
    }
    const wrap = $(`ak-${k.id}-removewrap`);
    const remove = $(`ak-${k.id}-remove`);
    if (wrap) wrap.classList.toggle('hidden', !st.saved);
    if (remove && !st.saved) remove.checked = false;
    const ptr = $(k.pointer);
    if (ptr) ptr.textContent = st.saved ? 'saved. It moved to' : 'not set. It lives in';
  }
  renderKeyLogins();
}

/**
 * Test one key. The key typed into the box is sent so it can be tried before
 * it replaces one that works; an untouched box holds the mask, which means
 * the saved key, so nothing secret goes over the wire at all. The server
 * neither saves nor echoes a typed key - see key-test-routes.js.
 */
async function testKey(id) {
  const k = KEY_CARDS.find((x) => x.id === id);
  if (!k) return;
  const btn = $(k.button);
  const out = $(k.result);
  if (btn?.disabled) return;
  if (btn) { btn.disabled = true; btn.textContent = 'Testing…'; }
  if (out) { out.innerHTML = ''; out.textContent = 'testing…'; }

  const body = k.body ? k.body() : {};
  const typed = String($(k.box)?.value ?? '').trim();
  if (typed && typed !== KEY_MASK) body.apiKey = typed;

  let r;
  try {
    r = await api('POST', k.test, body);
  } catch (err) {
    // No key, too soon after the last test, or not a key: refused with the
    // same shape as a result, so it is shown in the same place.
    r = err.data?.message ? err.data : { ok: false, message: `✗ ${err.message}` };
  }
  KEY_TESTS[k.id] = { ok: !!r.ok, at: Date.now(), word: keyReasonWord(r.reason, k.id) };
  if (btn) { btn.disabled = false; btn.textContent = 'Test key'; }
  if (out) {
    out.innerHTML = `<span style="color:var(--${r.ok ? 'accent' : 'danger'})">${
      esc(r.message ?? (r.ok ? '✓ Works' : '✗ The test failed'))}</span>`;
  }
  renderKeySection();
}

for (const k of KEY_CARDS) $(k.button)?.addEventListener('click', () => testKey(k.id));

/** A box this section's Save owns was typed into: the note, and any stale result. */
function keyEdited(id) {
  $('ak-note').textContent = 'unsaved — press Save API keys';
  // A result under the box was about whatever was in it before.
  if (KEY_TESTS[id]) {
    delete KEY_TESTS[id];
    const k = KEY_CARDS.find((x) => x.id === id);
    if (k && $(k.result)) $(k.result).textContent = '';
    renderKeySection();
  }
}
for (const k of KEY_CARDS) $(k.box)?.addEventListener('input', () => keyEdited(k.id));
// Gemini's model is sent by this Save as well, and its Test tries the key
// WITH the model, so changing the model needs the same unsaved note and
// leaves the same stale result behind as changing the key does.
$('f-gemini-model')?.addEventListener('input', () => keyEdited('gemini'));

$('ak-save')?.addEventListener('click', async () => {
  $('ak-note').textContent = 'saving…';
  try {
    CONFIG = await api('PUT', '/config', collectKeySection());
    refillKeySection();
    for (const k of KEY_CARDS) { const el = $(`ak-${k.id}-remove`); if (el) el.checked = false; }
    renderKeySection();
    $('ak-note').innerHTML = '<span style="color:var(--accent)">saved</span>';
    // The AI providers card sits a few centimetres below this button, inside
    // the same section, and holds a working copy with unsaved edits in it: a
    // typed Groq key, the enable tick pasting one sets, a may-clear tick, the
    // provider order. Re-fetching it from the server - which is what
    // loadAiProviders() does - threw every one of them away in silence, which
    // is exactly the "one save undoes the other" trap this section was built
    // to close. The only thing saving a key changes over there is whether
    // Gemini has one, so say that in place: readAiForm() takes the edits off
    // the page into the working copy first, exactly as reordering the rows
    // does, and the re-render puts every one of them back.
    if (AI) {
      readAiForm();
      const gem = AI.providers.find((p) => p.id === 'gemini');
      if (gem) {
        gem.apiKey = CONFIG.gemini?.apiKey ?? '';
        if (gem.status) gem.status.hasKey = !!gem.apiKey;
      }
      renderAiProviders();
    }
  } catch (err) {
    $('ak-note').innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`;
  }
});

/* ----------------------- find a setting --------------------------- */
/**
 * The search box at the top of Settings.
 *
 * It is not the global search in the header: that one jumps you somewhere,
 * one result at a time. This one FILTERS the tab, across every settings
 * group, so "key" or "timeout" shows every card that has one at once. The
 * groups are shown one at a time by the switcher, so without this a setting
 * whose group nobody could name was effectively hidden.
 *
 * Cards are hidden with a class rather than removed, so whatever was typed
 * into one survives the filter being cleared.
 */
let SET_HITS = [];

function runSettingsSearch(raw) {
  const panel = $('tab-settings');
  if (!panel) return;
  const q = normalizeSearch(raw);
  const count = $('set-search-count');
  panel.querySelectorAll('.searchhit').forEach((el) => el.classList.remove('searchhit'));

  if (!q) {
    panel.querySelectorAll('.nomatch').forEach((el) => el.classList.remove('nomatch'));
    SET_HITS = [];
    if (count) { count.textContent = ''; count.classList.remove('none'); }
    $('set-search-clear')?.classList.add('hidden');
    // Put the switcher back: while filtering, every matching group is open.
    let saved = null;
    try { saved = localStorage.getItem('botpanel.settingsGroup'); } catch { /* private mode */ }
    showSettingsGroup(panel, saved ?? panel.querySelector('.settings-group')?.dataset.group);
    return;
  }

  $('set-search-clear')?.classList.remove('hidden');
  const hits = [];
  for (const card of panel.querySelectorAll('.card')) {
    const mine = [];
    // A match inside a switched-off sub-panel - the .lib-section for a
    // provider that is not chosen, the .jf-auth for an auth method that is
    // not in use - was counted and could be the one Enter jumped to, and
    // scrollIntoView() on a display:none element does nothing. The card still
    // matches through the whole-card rule below, which marks its heading, so
    // Enter always lands on something that is actually on screen.
    const buried = (el) => {
      const h = el.closest('.hidden');
      return !!h && h !== card && card.contains(h);
    };
    const add = (mark, el, rank) => { if (!buried(mark)) mine.push({ card, mark, el, rank }); };
    const h2 = card.querySelector('h2');
    if (h2 && normalizeSearch(h2.textContent).includes(q)) add(h2, null, 0);
    for (const h3 of card.querySelectorAll('h3')) {
      if (normalizeSearch(h3.textContent).includes(q)) add(h3, h3, 0);
    }
    for (const lab of card.querySelectorAll('label')) {
      // A label that wraps other labels is a group heading; matching it would
      // mark every checkbox under it as its own hit.
      if (lab.querySelector('label')) continue;
      if (normalizeSearch(lab.textContent).includes(q)) {
        add(lab, lab.querySelector('input, select, textarea') ?? lab, 0);
      }
    }
    // The hint paragraphs carry the words people actually search for - what a
    // setting is for, rather than what it is called.
    for (const hint of card.querySelectorAll('.hint')) {
      if (hint.closest('label')) continue;
      if (normalizeSearch(hint.textContent).includes(q)) add(hint, hint, 1);
    }
    for (const btn of card.querySelectorAll('button[id]')) {
      if (normalizeSearch(btn.textContent).includes(q)) add(btn, btn, 0);
    }
    // Nothing named it, but the card says the word somewhere - in a policy
    // box, a table, a row the panel drew itself. "groq" is the case that
    // showed this up: the provider is named in the AI card's prose and on
    // rows built in JavaScript, and in neither a label nor a hint.
    if (!mine.length && h2 && normalizeSearch(card.textContent).includes(q)) {
      mine.push({ card, mark: h2, el: null, rank: 2 });
    }
    card.classList.toggle('nomatch', mine.length === 0);
    hits.push(...mine);
  }

  // A group with every card filtered out would be an empty page behind its chip.
  for (const g of panel.querySelectorAll('.settings-group')) {
    g.classList.toggle('hidden', ![...g.querySelectorAll('.card')].some((c) => !c.classList.contains('nomatch')));
  }
  for (const hit of hits) (hit.mark ?? hit.card).classList.add('searchhit');
  // Every hit is highlighted and counted, but the one Enter lands on is
  // chosen rather than taken in document order. The fresh-install checklist
  // is the first card on the tab and names every key in its rows, so "omdb",
  // "tmdb", "gemini" and "key" all jumped to the checklist instead of to the
  // key. It is a summary of the other cards rather than a place a setting
  // lives, so it goes last; and a setting named in a heading or a label beats
  // one only mentioned in passing. sort() is stable, so document order
  // decides between equals.
  SET_HITS = [...hits].sort((a, b) =>
    (a.rank + (a.card.id === 'card-fresh-install' ? 10 : 0))
    - (b.rank + (b.card.id === 'card-fresh-install' ? 10 : 0)));
  if (count) {
    count.textContent = hits.length ? `${hits.length} match${hits.length === 1 ? '' : 'es'}` : 'no matches';
    count.classList.toggle('none', !hits.length);
  }
}

/** Enter, or a click on the count: land on the first match without undoing the filter. */
function gotoFirstSettingHit() {
  const hit = SET_HITS[0];
  if (hit) revealInPage(hit.card, hit.el, { switchGroup: false });
}

$('set-search')?.addEventListener('input', (e) => runSettingsSearch(e.target.value));
$('set-search')?.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.target.value = ''; runSettingsSearch(''); e.target.blur(); return; }
  if (e.key === 'Enter') { e.preventDefault(); gotoFirstSettingHit(); }
});
$('set-search-clear')?.addEventListener('click', () => {
  $('set-search').value = '';
  runSettingsSearch('');
  $('set-search').focus();
});
$('set-search-count')?.addEventListener('click', gotoFirstSettingHit);

/**
 * Put the Settings filter away and show everything again.
 *
 * Anything that navigates the tab has to be able to do this, because the
 * filter hides whole cards and whole groups: without it, a chip pressed while
 * filtering opened a group whose cards were all still hidden - an apparently
 * empty page, with the count below it still promising matches - and a link
 * into a card that did not match scrolled to something that was not rendered.
 */
function clearSettingsFilter() {
  const box = $('set-search');
  if (!box?.value) return false;
  box.value = '';
  runSettingsSearch('');
  return true;
}

/* ----------------------- end API keys section ---------------------- */

/* ----------------------------- helpers ----------------------------- */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
/*
 * Phone numbers, as the panel shows them: "+" then the digits, country code
 * first, nothing else - +15558100180, +447700900428. The operator
 * (2026-10-01): "EVERYWHERE ON THE BOT NUMBERS SHOULD BE FORMATTED
 * +COUNTRYAREANUMBER NO SPACES NO DASHES NO PARENTHESIS ... I see in history
 * and queue it's got parenthesis and stuff making it un pastable in the
 * members tab". The bot wrote "+1 (555) 810-0180" until then, and History
 * rows, journalled queue jobs, the audit log and the logs still hold it; a TV
 * job's number was bare digits. These put any of them right on screen. The
 * same rules as src/core/members.js (phoneOut, phonesInText, phoneQuery);
 * test/phone-format.test.mjs holds the two copies to each other.
 */
const PHONE_SHAPED = /^\+?[0-9 ().-]+$/;
const PHONE_JID = /^(\d{7,15})(?::\d+)?@s\.whatsapp\.net$/;
/** A value with any phone number as +<digits> - "+1 (555) 807-0190", "15558070190", a phone jid; anything else as it was. */
function phoneOut(v) {
  if (v === null || v === undefined) return v;
  const s = String(v).trim();
  const jid = s.match(PHONE_JID);
  if (jid) return `+${jid[1]}`;
  if (!PHONE_SHAPED.test(s)) return v;
  const digits = s.replace(/[^0-9]/g, '');
  return digits.length >= 7 && digits.length <= 15 ? `+${digits}` : v;
}
/** Free text (a log line, an audit entry) with every "+1 (555) 807-0190" in it as +15558070190. */
function phonesInText(text) {
  if (text === null || text === undefined) return text;
  return String(text).replace(/(?<![\w+])(\+1 )?\((\d{3})\) (\d{3})-(\d{4})(?!\d)/g,
    (_m, one, a, b, c) => `+${one ? '1' : ''}${a}${b}${c}`);
}
/**
 * The digits to look for when a search box holds a phone number - only
 * digits, spaces, +, -, ( ) and dots, three digits or more - else null. A
 * member's number is stored as bare digits, so "+15558100180" and
 * "+1 (555) 810-0180" pasted into a search are compared digit for digit.
 */
function phoneQuery(q) {
  const s = String(q ?? '').trim();
  if (!PHONE_SHAPED.test(s)) return null;
  const digits = s.replace(/[^0-9]/g, '');
  return digits.length >= 3 ? digits : null;
}
/**
 * The number to show beside a requester, as +digits - or null when there is
 * none, or when the requester shown is that number already (a TV request
 * from someone with no WhatsApp name is named by its number).
 */
function numberBeside(requester, number) {
  const num = phoneOut(number);
  return num && num !== phoneOut(requester) ? num : null;
}
/**
 * Does `text` answer a search box's lower-cased `q` - as typed, or, when `q`
 * is a phone number, digit for digit, whether the text holds the number as
 * +digits, as bare digits or in the old "+1 (555) 810-0180" form?
 */
function textMatches(text, q) {
  const t = String(text ?? '').toLowerCase();
  if (t.includes(q)) return true;
  const digits = phoneQuery(q);
  return !!digits && phonesInText(t).includes(digits);
}
/**
 * The buttons under a list drawn a page at a time: "Show 40 more", as it
 * always was, and "Show all" beside it.
 *
 * The operator (2026-10-11), on History: "also in that list on the panel I
 * get 'Show 40 more (120 older)' just give me a button to show all". Reaching
 * the oldest of 160 requests took three presses, and the Members roster, a
 * hundred at a time, took more. Show all is offered only while more than a
 * page is left: with a page or less to go, "Show 12 more" already shows the
 * rest, and two buttons doing one thing read as two different things.
 *
 * `more` and `all` are onclick handlers, as text, like every button the panel
 * draws inside a string. Show all draws the rest the way each page always
 * was, as one string set with one innerHTML, so even the 500 requests History
 * holds at most appear in one go rather than row by row.
 */
function pagerButtons({ shown, total, page, noun, more, all }) {
  const left = total - shown;
  if (left <= 0) return '';
  return `<button class="btn small" onclick="${more}">Show ${Math.min(page, left)} more (${left} ${noun})</button>`
    + (left > page ? `<button class="btn small" onclick="${all}">Show all (${total})</button>` : '');
}
/*
 * Every time the panel shows is on the 24-hour clock, by the operator's rule:
 * "everything in panel and bot should be 24 hour time format". It is
 * hourCycle, not hour12: false - with hour12: false, en-US writes the hour
 * after midnight as 24 ("24:05"). The date part keeps the browser's own order
 * and month names; only the clock is fixed. test/clock-24h.test.mjs fails on
 * a time formatted any other way.
 */
const CLOCK_24 = { hourCycle: 'h23' };
/** Hours and minutes only, "16:05". */
const HM = { hour: '2-digit', minute: '2-digit' };

/** A date and time: "9/25/2026, 16:05:09". */
function fmtDateTime(t, opts = {}) {
  return new Date(t).toLocaleString(undefined, { ...opts, ...CLOCK_24 });
}

/** A time of day: "16:05:09", or "16:05" given HM. */
function fmtClock(t, opts = {}) {
  return new Date(t).toLocaleTimeString(undefined, { ...opts, ...CLOCK_24 });
}

function fmtDur(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

boot().catch((err) => {
  document.body.innerHTML = `<pre style="padding:24px;color:#f0553c">Failed to start: ${esc(err.message)}</pre>`;
});

/* ----------------------- members roster (all groups) ---------------- */
let ROSTER = [];
const ROSTER_PAGE = 100;
let ROSTER_SHOWN = ROSTER_PAGE;

const fmtWhen = (ts) => {
  if (!ts) return '—';
  const d = new Date(ts);
  const days = Math.floor((Date.now() - ts) / 86400000);
  if (days === 0) return `today ${fmtClock(d, HM)}`;
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return d.toLocaleDateString();
};

const memberLabel = (m) =>
  m.name || (m.number ? `+${m.number}` : (m.id || '').split('@')[0]);

async function loadMembersRoster() {
  const box = $('mr-list');
  if (!box) return;
  try {
    const d = await api('GET', '/members');
    ROSTER = d.members || [];
    $('mr-count').textContent = ROSTER.length;
    renderRoster();
  } catch (err) {
    box.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}

function renderRoster() {
  const box = $('mr-list');
  if (!box) return;
  const q = ($('mr-filter').value || '').toLowerCase().trim();
  const sort = $('mr-sort').value;
  // The operator (2026-10-01) pastes a number copied from History or the
  // queue: +15558100180, or "+1 (555) 810-0180" as they used to read. A
  // member's number is bare digits, so a number is matched on its digits.
  const d = phoneQuery(q);

  let list = ROSTER.filter((m) => !q
    || memberLabel(m).toLowerCase().includes(q)
    || (m.number || '').includes(q)
    || (!!d && (m.number || '').includes(d))
    || (m.id || '').toLowerCase().includes(q)
    || m.groups.some((g) => g.subject.toLowerCase().includes(q)));

  const cmp = {
    active: (a, b) => b.msgCount - a.msgCount || b.groupCount - a.groupCount,
    groups: (a, b) => b.groupCount - a.groupCount || b.msgCount - a.msgCount,
    admin: (a, b) => b.adminCount - a.adminCount || b.groupCount - a.groupCount,
    recent: (a, b) => (b.lastSeen || 0) - (a.lastSeen || 0),
    name: (a, b) => memberLabel(a).localeCompare(memberLabel(b)),
  }[sort] || ((a, b) => b.msgCount - a.msgCount);
  list = [...list].sort(cmp);

  const shown = list.slice(0, ROSTER_SHOWN);
  box.innerHTML = shown.length ? shown.map((m) => `
    <div class="item compact member-row" data-key="${esc(m.key)}" onclick="openMember('${esc(m.key)}')" style="cursor:pointer">
      <div class="item-top">
        <span class="item-title">${esc(memberLabel(m))}${m.adminCount ? ` <span class="pill ok">admin ×${m.adminCount}</span>` : ''}</span>
        <span class="muted small">${m.msgCount} msg${m.msgCount === 1 ? '' : 's'}</span>
      </div>
      <div class="item-sub">
        ${m.groupCount} group${m.groupCount === 1 ? '' : 's'}
        ${m.number ? ` · +${esc(m.number)}` : ' · no phone number visible'}
        ${m.lastSeen ? ` · last seen ${esc(fmtWhen(m.lastSeen))}` : ''}
      </div>
    </div>`).join('') : '<div class="empty">Nobody matches that search.</div>';

  $('mr-more').innerHTML = pagerButtons({ shown: shown.length, total: list.length, page: ROSTER_PAGE, noun: 'hidden',
    more: 'moreRoster()', all: 'allRoster()' });
}

window.moreRoster = () => { ROSTER_SHOWN += ROSTER_PAGE; renderRoster(); };
/*
 * Infinity, so a Refresh or a change of sort keeps the whole roster on
 * screen, as either keeps the pages shown so far. Typing in the search box
 * goes back to the first page, as it always has: the roster is drawn again
 * on every key, and drawing every member on each of them would make the box
 * lag while the search is still one or two letters long.
 */
window.allRoster = () => { ROSTER_SHOWN = Infinity; renderRoster(); };

/** Whose details are open, for ✕ close to go back to their row. */
let memberOpen = null;

window.openMember = async (key) => {
  memberOpen = key;
  const box = $('mr-detail');
  box.classList.remove('hidden');
  box.innerHTML = '<div class="empty">Loading…</div>';
  scrollToElement(box, 'nearest');
  try {
    const d = await api('GET', `/members/${encodeURIComponent(key)}/detail`);
    const admin = d.groups.filter((g) => g.admin);
    const plain = d.groups.filter((g) => !g.admin);
    const per = d.perGroup || {};

    const groupLine = (g) => {
      const a = per[g.jid];
      return `<div class="item-sub">• ${esc(g.subject)}${g.admin ? ` <span class="pill ok">${esc(g.admin)}</span>` : ''}${a ? ` <span class="muted">— ${a.count} msg${a.count === 1 ? '' : 's'}, last ${esc(fmtWhen(a.lastSeen))}</span>` : ''}</div>`;
    };

    const timeline = (d.timeline || []).length
      ? d.timeline.map((t) => `<div class="item-sub">${esc(fmtDateTime(t.ts))} — <b>${esc(t.action)}</b> in ${esc(t.groupName)}${t.by ? ` <span class="muted">by ${esc(t.by)}</span>` : ''}</div>`).join('')
      : '<div class="item-sub muted">No join/leave events recorded — they were already in these groups before the bot started watching. WhatsApp doesn\'t expose historical join dates.</div>';

    box.innerHTML = `
      <div class="card" style="margin-bottom:14px;border:1px solid var(--accent)">
        <div class="row gap" style="justify-content:space-between;align-items:flex-start">
          <div>
            <h3 style="margin:0">${esc(memberLabel(d))}</h3>
            <div class="muted small">${d.number ? `+${esc(d.number)}` : 'no phone number visible (LID-only)'}${d.banned ? ' · <span class="pill bad">banned</span>' : ''}${d.noTag ? ' · <span class="pill warn">never tagged</span>' : ''}</div>
          </div>
          <button class="btn tiny" onclick="closeMember()">✕ close</button>
        </div>

        <div class="row gap wrap" style="margin:12px 0">
          <span class="pill">${d.groupCount} group${d.groupCount === 1 ? '' : 's'}</span>
          <span class="pill ${d.adminCount ? 'ok' : ''}">${d.adminCount} admin role${d.adminCount === 1 ? '' : 's'}</span>
          <span class="pill">${d.msgCount} message${d.msgCount === 1 ? '' : 's'}</span>
          <span class="pill">first seen ${esc(fmtWhen(d.firstSeen))}</span>
          <span class="pill">last seen ${esc(fmtWhen(d.lastSeen))}</span>
        </div>

        ${admin.length ? `<h4 style="margin:10px 0 4px">Admin in ${admin.length} group${admin.length === 1 ? '' : 's'}</h4>${admin.map(groupLine).join('')}` : ''}
        <h4 style="margin:12px 0 4px">Member of ${plain.length} other group${plain.length === 1 ? '' : 's'}</h4>
        ${plain.map(groupLine).join('') || '<div class="item-sub muted">none</div>'}

        <h4 style="margin:14px 0 4px">How they joined / left</h4>
        ${timeline}

        <div class="row gap wrap" style="margin-top:14px">
          <button class="btn tiny" onclick="useMemberNumber('${esc(d.number || '')}')">Use this number below ↓</button>
        </div>
      </div>`;
  } catch (err) {
    box.innerHTML = `<div class="verdict bad">${esc(err.message)}</div>`;
  }
};

/**
 * ✕ close goes back to the person's row. Their details open above the whole
 * list, so a row sixty down sent the page up to the top of the list, and
 * closing left it there, sixty rows from where it had been.
 */
window.closeMember = () => {
  const key = memberOpen;
  memberOpen = null;
  $('mr-detail').classList.add('hidden');
  $('mr-detail').innerHTML = '';
  const row = [...$('mr-list').querySelectorAll('.member-row[data-key]')].find((r) => r.dataset.key === key);
  if (row) scrollToElement(row, 'center');
};
window.useMemberNumber = (n) => {
  if (!n) return toast('This person has no visible phone number — WhatsApp only exposes their internal id.', true);
  // +digits, as the number is shown everywhere; the box's buttons take its digits.
  $('mx-num').value = `+${String(n).replace(/[^0-9]/g, '')}`;
  scrollToElement($('mx-num'), 'center');
  toast(`+${n} filled in below`);
};

$('mr-filter')?.addEventListener('input', () => { ROSTER_SHOWN = ROSTER_PAGE; renderRoster(); });
$('mr-sort')?.addEventListener('change', renderRoster);
$('mr-refresh')?.addEventListener('click', loadMembersRoster);

/* --------------------- request-group enforcement -------------------- */
function loadEnforcement() {
  const e = CONFIG?.movieRequests?.enforcement ?? {};
  if (!$('f-enf-enabled')) return;
  $('f-enf-enabled').checked = !!e.enabled;
  $('f-enf-nonreq').checked = e.deleteNonRequests !== false;
  $('f-enf-media').checked = e.deleteMedia !== false;
  $('f-enf-multi').checked = e.deleteMultiple !== false;
  $('f-enf-admins').checked = e.exemptAdmins !== false;
  $('f-enf-dm').checked = !!e.warnByDm;
}

$('enf-save')?.addEventListener('click', async () => {
  $('enf-note').textContent = 'saving…';
  try {
    CONFIG = await api('PUT', '/config', { movieRequests: { enforcement: {
      enabled: $('f-enf-enabled').checked,
      deleteNonRequests: $('f-enf-nonreq').checked,
      deleteMedia: $('f-enf-media').checked,
      deleteMultiple: $('f-enf-multi').checked,
      exemptAdmins: $('f-enf-admins').checked,
      warnByDm: $('f-enf-dm').checked,
    }}});
    $('enf-note').innerHTML = '<span style="color:var(--accent)">saved</span>';
  } catch (err) { $('enf-note').innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`; }
});

/* ================= portal navigation: search, jump-nav, collapse =========
   The index is built from the live DOM rather than a hand-kept list, so it
   can never drift out of sync as cards and settings are added. */

const TAB_LABEL = () => Object.fromEntries(
  [...document.querySelectorAll('.tab')].map((t) => [t.dataset.tab, t.textContent.trim()]));

function buildSearchIndex() {
  const labels = TAB_LABEL();
  const idx = [];

  document.querySelectorAll('.panel').forEach((panel) => {
    const tab = panel.id.replace(/^tab-/, '');
    if (panel.classList.contains('superadmin-only') && panel.classList.contains('hidden')) return;

    panel.querySelectorAll('.card').forEach((card) => {
      const h2 = card.querySelector('h2');
      const section = h2 ? h2.textContent.replace(/\s+/g, ' ').trim() : '';
      if (section) idx.push({ kind: 'section', what: section, tab, tabLabel: labels[tab], card });

      // Sub-headings inside a card.
      card.querySelectorAll('h3').forEach((h3) => {
        const t = h3.textContent.replace(/\s+/g, ' ').trim();
        if (t) idx.push({ kind: 'section', what: t, sub: section, tab, tabLabel: labels[tab], card, el: h3 });
      });

      // Every labelled field becomes searchable.
      card.querySelectorAll('label').forEach((lab) => {
        const field = lab.querySelector('input, select, textarea');
        const text = [...lab.childNodes]
          .filter((n) => n.nodeType === 3 || (n.nodeType === 1 && !['INPUT', 'SELECT', 'TEXTAREA'].includes(n.tagName)))
          .map((n) => n.textContent).join(' ').replace(/\s+/g, ' ').trim();
        if (text && text.length < 90) {
          idx.push({ kind: 'setting', what: text, sub: section, tab, tabLabel: labels[tab], card, el: field || lab });
        }
      });

      card.querySelectorAll('button[id]').forEach((b) => {
        const t = b.textContent.replace(/\s+/g, ' ').trim();
        if (t && t.length < 40) idx.push({ kind: 'action', what: t, sub: section, tab, tabLabel: labels[tab], card, el: b });
      });
    });
  });
  return idx;
}

let SEARCH_IDX = [];
let SEARCH_SEL = 0;

function refreshSearchIndex() { SEARCH_IDX = buildSearchIndex(); }

/** Fold punctuation, emoji and case away so "dry run" finds "Dry-run 🧹". */
function normalizeSearch(v) {
  return String(v || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreHit(hay, query) {
  // Normalise both sides here rather than trusting every caller to do it.
  const h = normalizeSearch(hay);
  const q = normalizeSearch(query);
  if (!h || !q) return 0;
  if (h === q) return 100;
  if (h.startsWith(q)) return 80;
  if (h.includes(q)) return 60;
  // all query words present, in any order
  const words = q.split(' ').filter(Boolean);
  if (words.length > 1 && words.every((w) => h.includes(w))) return 40;
  return 0;
}

/**
 * Whether a search entry's card can be brought on screen right now.
 *
 * Some cards are hidden until something opens them: the group being managed,
 * the Dashboard's warnings when there is nothing to warn about. "lock" offered
 * "🔒 Lock (admins only)" from the group card with no group open, and picking
 * it opened the Groups tab and showed nothing at all. A card in a Settings
 * group that is not the one showing is fine - landing on it switches group -
 * and so is one on another tab.
 */
function canLandOn(entry) {
  const hider = entry.card?.closest?.('.hidden');
  return !hider || hider.classList.contains('settings-group') || !entry.card.closest('.panel')?.contains(hider);
}

function runSearch(q) {
  const box = $('gsearch-results');
  q = (q || '').trim().toLowerCase();
  if (!q) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  if (!SEARCH_IDX.length) refreshSearchIndex();

  // Live data: groups and members are searchable too.
  const extra = [];
  const labels = TAB_LABEL();
  for (const g of (GROUPS || [])) {
    const sc = scoreHit(g.subject, q);
    if (sc) extra.push({ kind: 'group', what: g.subject, sub: `${g.size} members`, tab: 'groups', tabLabel: labels.groups, score: sc, jid: g.jid });
  }
  // A pasted number - "+15558100180", "+1 (555) 810-0180" - finds its member by digits.
  const digits = phoneQuery(q);
  for (const m of (ROSTER || [])) {
    const name = memberLabel(m);
    const byNumber = (m.number || '').includes(q) || (!!digits && (m.number || '').includes(digits));
    const sc = Math.max(scoreHit(name, q), byNumber ? 70 : 0);
    if (sc) extra.push({ kind: 'member', what: name, sub: `${m.groupCount} groups`, tab: 'members', tabLabel: labels.members, score: sc, mkey: m.key });
  }

  const hits = [
    ...SEARCH_IDX.filter(canLandOn)
      .map((e) => ({ ...e, score: Math.max(scoreHit(e.what, q), e.sub ? scoreHit(e.sub, q) * 0.5 : 0) })),
    ...extra,
  ].filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score || a.what.length - b.what.length)
    .slice(0, 14);

  if (!hits.length) {
    box.innerHTML = '<div class="sr-empty">Nothing matches that.</div>';
    box.classList.remove('hidden');
    return;
  }

  const icon = { section: '▤', setting: '⚙', action: '▸', group: '👥', member: '👤' };
  SEARCH_SEL = 0;
  window._searchHits = hits;
  box.innerHTML = hits.map((h, i) => `
    <div class="sr-item ${i === 0 ? 'sel' : ''}" data-i="${i}">
      <span>${icon[h.kind] || '•'}</span>
      <span class="sr-what">${esc(h.what)}${h.sub ? ` <span class="muted small">— ${esc(h.sub)}</span>` : ''}</span>
      <span class="sr-tab">${esc(h.tabLabel || h.tab)}</span>
    </div>`).join('');
  box.classList.remove('hidden');
  box.querySelectorAll('.sr-item').forEach((el) => {
    el.addEventListener('click', () => gotoHit(hits[+el.dataset.i]));
  });
}

function gotoHit(hit) {
  if (!hit) return;
  $('gsearch-results').classList.add('hidden');
  $('gsearch').value = '';
  // The tab opens at its top, at once, as any press of it does; the landing
  // on the card, field, group or person goes from there.
  goTab(hit.tab);

  setTimeout(() => {
    if (hit.kind === 'group' && hit.jid) { gaOpen(hit.jid, hit.what); return; }
    if (hit.kind === 'member' && hit.mkey) { openMember(hit.mkey); return; }
    revealInPage(hit.card, hit.el);
  }, 60);
}

/**
 * Bring a card, and optionally one field inside it, into view on the tab that
 * is already showing: open its settings group, un-collapse it, scroll to it and
 * flash it. Shared by the search box and the fresh-install checklist links, so
 * both land the same way. `card` may be null; it is then the one around `el`.
 *
 * `switchGroup: false` is for the Settings filter, which has already opened
 * every group that has a match: switching to one of them would hide the rest
 * while the count still promised them.
 */
function revealInPage(card, el, { switchGroup = true } = {}) {
  card = card ?? el?.closest?.('.card') ?? null;
  if (!card && !el) return;
  // The target may be a card the Settings filter has hidden. A link from a
  // card that matches the query to one that does not is easy to reach - the
  // checklist rows, the pointer each old key card keeps, the header's own
  // search - and it scrolled the page to a display:none card, which reads as
  // the link being broken. `switchGroup: false` is the filter's own Enter, and
  // its target always matches, so it is left alone.
  if (switchGroup && (card ?? el)?.closest?.('.nomatch')) clearSettingsFilter();
  // A target may be inside a settings group that is currently hidden; show it
  // first, or the page would scroll to something invisible.
  const group = card?.closest?.('.settings-group') ?? el?.closest?.('.settings-group');
  if (switchGroup && group) {
    const panel = group.closest('.panel');
    // No scroll to the top of the tab on the way: the landing below is the
    // only scroll this makes.
    if (panel) showSettingsGroup(panel, group.dataset.group, { scroll: false });
  }
  if (card) {
    card.classList.remove('collapsed');
    saveCollapse(card, false);
    card.classList.remove('flash'); void card.offsetWidth; card.classList.add('flash');
  }
  // Focus before the scroll, never after. Enter in the find box, or in the
  // header's search, left the page where it was: moving focus out of a text
  // box stops a smooth scroll that has already started, and the field was
  // focused just after its scroll began.
  if (el && el !== card) {
    flashField(el);
    if (typeof el.focus === 'function' && el.tagName !== 'BUTTON') el.focus({ preventScroll: true });
  }
  // One scroll: to the field, or to its card when the field is not drawn (a
  // sub-panel that is switched off, a row redrawn since the search index was
  // built). It used to be both, one after the other, and the second won.
  const field = el && el !== card && isDrawn(el) ? el : null;
  scrollToElement(field ?? card, field ? 'center' : 'start');
}

/** Is it laid out at all? Where nothing can say (no layout engine), assume so. */
function isDrawn(el) {
  return typeof el?.getClientRects !== 'function' || el.getClientRects().length > 0;
}

/**
 * Scroll the page smoothly to `el`, on the next animation frame.
 *
 * Every scroll that brings something into view goes through here, and every
 * one to the top through scrollToTop, so one added later cannot bring back
 * what follows (settings-reach.test.mjs checks that).
 *
 * Reported as Settings buttons that did nothing. Every link that lands on a
 * field - the fresh-install checklist's rows, the "moved to API keys →"
 * pointers, the header's search results - left the page where it was once it
 * had been scrolled: the group switched and the field was focused, off
 * screen, and the page moved a few pixels and stopped. A group chip did the
 * same when pressed just after the tab had opened. In Chromium an element's
 * smooth scrollIntoView(), called from an ordinary task while a smooth
 * window.scrollTo() is still moving the page, is dropped - and the running
 * scroll stops with it. Asked from a requestAnimationFrame callback it
 * landed, and that was the fix, until the same sweep of the whole panel found
 * a second way to lose one, from a frame too: a smooth scrollIntoView() that
 * would end where the scroll under way is already going. The Checklist chip,
 * pressed within a second of opening Settings from a scrolled page, was that
 * case - its card lands at the very top, where the tab was on its way - and
 * the page stopped 1,800 px down. On a bare page in headless Chromium, with
 * a button pressed 150 or 400 ms into a smooth scroll to the top, a smooth
 * scrollIntoView() asked for from a frame landed 12 times in 20 on a desktop
 * (never when it too ended at the top) and 0 times in 20 on a phone, tapped;
 * a smooth window.scrollTo() to the same places landed 80 in 80, from a frame
 * or not, and 96 in 96 across a running scroll to the top or to an element,
 * up the page or down it. So this works out where the page has to be and
 * asks window.scrollTo() for that.
 *
 * The frame is kept: it puts the scroll after whatever else the handler does -
 * switching group, un-collapsing a card, focusing a field - and focus moving
 * out of a text box stops a smooth scroll that is already under way.
 */
function scrollToElement(el, block = 'start') {
  if (!el) return;
  const go = () => {
    const top = landingFor(el, block);
    if (top !== null) window.scrollTo({ top, behavior: 'smooth' });
  };
  if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(go);
  else go();
}

/**
 * Scroll the page to its top: smoothly, unless `smooth` is false. The one other
 * way the panel moves the page, kept beside scrollToElement for the same
 * reason.
 */
function scrollToTop({ smooth = true } = {}) {
  window.scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'auto' });
}

/**
 * How far down the page must be for `el` to show below the sticky bars: with
 * its top just under them ('start'), in the middle of the screen they leave
 * ('center'), or wherever is nearest ('nearest', null when it shows already).
 * null too when it is not drawn, since there is then nowhere to go. A box of
 * its own that scrolls - a list of groups to tick - is scrolled to it first,
 * as scrollIntoView() would have done.
 */
function landingFor(el, block) {
  if (!isDrawn(el)) return null;
  for (let box = el.parentElement; box && box !== document.body; box = box.parentElement) {
    if (box.scrollHeight > box.clientHeight && /auto|scroll/.test(window.getComputedStyle?.(box)?.overflowY ?? '')) {
      showInBox(box, el);
    }
  }
  const r = el.getBoundingClientRect();
  // Clear of the bars, with 10 px of air, whatever it is. The cards' and
  // groups' scroll-margin did this before, so a member's details, which are
  // not a card, came up with the name behind the tabs.
  const bars = stickyStack() + 10;
  const screen = window.innerHeight ?? 0;
  const room = screen - bars;
  const now = window.scrollY ?? 0;
  let top = now + r.top - bars;
  if (block === 'center' && r.height < room) top -= (room - r.height) / 2;
  if (block === 'nearest') {
    if (r.top >= bars && r.bottom <= screen) return null;
    if (r.top >= bars && r.height < room) top = now + r.bottom - screen;
  }
  return Math.max(0, Math.round(top));
}

/** Scroll a box of its own, and only it, so `el` inside it is in view. */
function showInBox(box, el) {
  const b = box.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  if (r.top < b.top) box.scrollTop += r.top - b.top;
  else if (r.bottom > b.bottom) box.scrollTop += Math.min(r.bottom - b.bottom, r.top - b.top);
}

/** The sticky bars' whole height, as layoutStickyBars last measured it. */
function stickyStack() {
  const own = document.documentElement?.style?.getPropertyValue?.('--stick-all');
  return parseFloat(own || window.getComputedStyle?.(document.documentElement)?.getPropertyValue?.('--stick-all')) || 0;
}

/**
 * The brief outline that says "this is the thing". One copy, because the two
 * places that draw attention to a field - landing on it from a link, and
 * pointing at the Save that a field still needs - must not drift apart.
 */
function flashField(el) {
  if (!el) return;
  el.classList.remove('flash-field');
  void el.offsetWidth;
  el.classList.add('flash-field');
}

/** Where a Settings button writes its answer: the "saved" beside a Save, the verdict beside a Test. */
const ANSWER_LINE = '[id$="-note"], [id$="-result"], [id$="-msg"], [id$="-status"], .ai-test';
/** The last Settings button pressed: what surrounds it, and when. */
let lastPress = null;

/**
 * Blink the answer line a changed node belongs to, if a button beside it was
 * pressed a moment ago.
 *
 * Found by pressing every Settings button in a real browser. Pressed a second
 * time, "Save TV settings" wrote "saved" over "saved", "Test key" wrote the
 * verdict it had already written, and "Send test email" after "Check
 * credentials" wrote the same refusal. Each did its work and nothing on the
 * screen changed: the "saving…" in between lasts one round trip on the LAN,
 * which is no time at all. An answer repeated word for word reads as the
 * button not working, so the line it lands in blinks each time it is written.
 */
function markAnswer(node) {
  if (!lastPress || Date.now() - lastPress.at > 15000) return;
  const el = (node?.nodeType === 1 ? node : node?.parentElement)?.closest?.(ANSWER_LINE);
  if (!el || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || !lastPress.near?.contains(el)) return;
  flashField(el);
}
document.addEventListener('click', (e) => {
  const btn = e.target?.closest?.('#tab-settings button');
  if (btn) lastPress = { near: btn.closest('.card, .settings-actions, .ak-saverow') ?? btn.parentElement, at: Date.now() };
}, true);
if (typeof window.MutationObserver === 'function' && $('tab-settings')) {
  new window.MutationObserver((list) => {
    new Set(list.map((m) => m.target)).forEach(markAnswer);
  }).observe($('tab-settings'), { subtree: true, childList: true, characterData: true });
}

$('gsearch')?.addEventListener('input', (e) => runSearch(e.target.value));
$('gsearch')?.addEventListener('keydown', (e) => {
  const hits = window._searchHits || [];
  const box = $('gsearch-results');
  if (e.key === 'Escape') { box.classList.add('hidden'); e.target.blur(); return; }
  if (!hits.length || box.classList.contains('hidden')) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    SEARCH_SEL = (SEARCH_SEL + (e.key === 'ArrowDown' ? 1 : hits.length - 1)) % hits.length;
    box.querySelectorAll('.sr-item').forEach((el, i) => el.classList.toggle('sel', i === SEARCH_SEL));
    const sel = box.querySelector('.sr-item.sel');
    if (sel) showInBox(box, sel);
  }
  if (e.key === 'Enter') { e.preventDefault(); gotoHit(hits[SEARCH_SEL]); }
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.searchwrap')) $('gsearch-results')?.classList.add('hidden');
});
// "/" focuses search, the way most tools do it.
document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
  if (e.key === '/' && !typing) { e.preventDefault(); $('gsearch')?.focus(); }
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); $('gsearch')?.focus(); }
});

/* ------------------------- collapsible cards ------------------------ */
const COLLAPSE_KEY = 'botpanel.collapsed';
const collapsedSet = () => {
  try { return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]')); } catch { return new Set(); }
};
const cardId = (card) => {
  const panel = card.closest('.panel');
  const h2 = card.querySelector('h2');
  return `${panel ? panel.id : '?'}::${h2 ? h2.textContent.replace(/\s+/g, ' ').trim() : '?'}`;
};
function saveCollapse(card, isCollapsed) {
  const set = collapsedSet();
  const id = cardId(card);
  if (isCollapsed) set.add(id); else set.delete(id);
  try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set])); } catch { /* private mode */ }
}

function setupCollapsibles() {
  const saved = collapsedSet();
  document.querySelectorAll('.card').forEach((card) => {
    const h2 = card.querySelector('h2');
    if (!h2 || h2.dataset.collapseHooked) return;
    h2.dataset.collapseHooked = '1';
    if (saved.has(cardId(card))) card.classList.add('collapsed');
    h2.addEventListener('click', (e) => {
      if (e.target.closest('a, button, input, select, .card-link')) return;
      card.classList.toggle('collapsed');
      saveCollapse(card, card.classList.contains('collapsed'));
    });
  });
}

/* --------------------------- per-tab jump nav ----------------------- */
/**
 * Show one settings group and hide the rest.
 *
 * `scroll` says where the page goes next. 'top', for clearing the find box,
 * goes back to the top of the tab, where the find box is. 'group' is a chip
 * press: the group asked for is brought on screen. false is for opening the
 * tab, which pressing it has put at its top already, and for a caller about to
 * land on something inside the group, which does its own scrolling.
 */
function showSettingsGroup(panel, slug, { scroll = 'top' } = {}) {
  const groups = [...panel.querySelectorAll('.settings-group')];
  if (!groups.length) return;
  const target = groups.find((g) => g.dataset.group === slug) ?? groups[0];
  groups.forEach((g) => g.classList.toggle('hidden', g !== target));
  try { localStorage.setItem('botpanel.settingsGroup', target.dataset.group); } catch { /* private mode */ }
  const nav = $('jumpnav');
  nav?.querySelectorAll('button[data-group]').forEach((b) => {
    b.classList.toggle('active', b.dataset.group === target.dataset.group);
  });
  showInStrip(nav?.querySelector('button[data-group].active'));
  if (scroll === 'group') revealSettingsGroup(target);
  else if (scroll) scrollToTop();
}

/**
 * Scroll a group that has just been switched in to where it can be seen.
 *
 * Reported from the live panel: buttons on the Settings tab did nothing. The
 * group chips were the ones - each one switched its group, and nothing on the
 * screen changed. The fresh-install checklist sits above every group, and
 * once a box is set up it lists thirty-odd rows: 2,500 px on a desktop, nearly
 * 4,000 on a phone. A chip scrolled the page to the top, which is the
 * checklist, and the group it had just shown started two or three screens
 * further down. The chip lit up and the page stayed exactly as it was.
 *
 * Going to the top is kept when the group would show near the top of the
 * screen anyway (the checklist folded away), so the find box stays in view.
 * Otherwise the group's heading is brought up to just under the sticky bars;
 * the CSS scroll-margin is what keeps it from landing underneath them.
 */
function revealSettingsGroup(group) {
  const top = group.getBoundingClientRect().top + (window.scrollY ?? 0);
  if (top < (window.innerHeight ?? 0) * 0.6) {
    scrollToTop();
    return;
  }
  // Through scrollToElement: pressed while the tab's own scroll to the top was
  // still running - within a second of opening Settings from a scrolled page -
  // a chip's scroll was dropped, and the group stayed off screen.
  scrollToElement(group, 'start');
}

function renderJumpNav() {
  const nav = $('jumpnav');
  if (!nav) return;
  const panel = document.querySelector('.panel.active');
  // On a phone the row scrolls sideways, and it kept its place across a
  // redraw: after Settings had been slid along to System, the next tab's
  // first chips were off the left-hand edge. Each tab's row starts at its
  // start; Settings then slides to the group that is showing.
  nav.scrollLeft = 0;

  // A tab split into groups gets a switcher, not a scroll list: only the
  // chosen group is on screen, so there is nothing to scroll past.
  const groups = panel ? [...panel.querySelectorAll('.settings-group')] : [];
  if (groups.length) {
    let saved = null;
    try { saved = localStorage.getItem('botpanel.settingsGroup'); } catch { /* ignore */ }
    // The fresh-install checklist sits outside every group, so it has no chip
    // of its own; without one it is the only thing on the tab that cannot be
    // reached from the row, and it is the first thing a new machine needs.
    const outside = panel.querySelector('#card-fresh-install');
    nav.innerHTML = (outside ? '<button data-scroll="card-fresh-install">Checklist</button>' : '')
      + groups.map((g) =>
        `<button data-group="${esc(g.dataset.group)}">${esc(g.dataset.label ?? g.dataset.group)}</button>`).join('');
    // The chips are sticky and sit outside #tab-settings, so they stay on
    // screen and clickable while the find box is filtering. A chip that only
    // un-hid the group showed a page with every card still filtered out, and
    // nothing said the search box was the reason - so a chip is also how you
    // get out of the filter.
    nav.querySelectorAll('button[data-group]').forEach((b) => {
      b.addEventListener('click', () => {
        clearSettingsFilter();
        showSettingsGroup(panel, b.dataset.group, { scroll: 'group' });
      });
    });
    nav.querySelectorAll('button[data-scroll]').forEach((b) => {
      b.addEventListener('click', () => {
        clearSettingsFilter();
        const card = $(b.dataset.scroll);
        if (!card) return;
        card.classList.remove('collapsed');
        saveCollapse(card, false);
        scrollToElement(card, 'start');
      });
    });
    // No scroll: pressing the tab has put the page at its top already. This
    // runs 30 ms after the press, and its own smooth scroll to the same place
    // was still going when a link's landing began.
    showSettingsGroup(panel, saved ?? groups[0].dataset.group, { scroll: false });
    return;
  }

  const cards = panel ? [...panel.querySelectorAll('.card')] : [];
  JUMP_CARDS = cards;
  // Only worth showing when there is enough on the page to get lost in.
  if (cards.length < 3) { nav.innerHTML = ''; return; }
  nav.innerHTML = cards.map((c, i) => `<button data-i="${i}">${esc(jumpChipName(c, i))}</button>`).join('')
    + '<button data-all="1">⇕ expand / collapse all</button>';

  nav.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.all) {
      const real = [...panel.querySelectorAll('.card')];
      const anyOpen = real.some((c) => !c.classList.contains('collapsed'));
      real.forEach((c) => { c.classList.toggle('collapsed', anyOpen); saveCollapse(c, anyOpen); });
      return;
    }
    const card = cards[+b.dataset.i];
    card.classList.remove('collapsed');
    saveCollapse(card, false);
    scrollToElement(card, 'start');
    card.classList.remove('flash'); void card.offsetWidth; card.classList.add('flash');
  }));
  syncJumpNav();
}

/** The cards the scroll-list chips point at, by their data-i. */
let JUMP_CARDS = [];

/**
 * A chip's name: the card's heading without the links and buttons that share
 * its line. The Dashboard's chips read "Recent activity open full log →" and
 * the Groups tab's "Groups Refresh" when the whole heading was used.
 */
function jumpChipName(card, i) {
  const head = card.querySelector('h2, .section-head');
  if (!head) return `Section ${i + 1}`;
  const copy = head.cloneNode(true);
  copy.querySelectorAll('a, button').forEach((el) => el.remove());
  return copy.textContent.replace(/\s+/g, ' ').trim() || `Section ${i + 1}`;
}

/**
 * Show a chip only while its card is on the page. The Dashboard's first two
 * cards - "Nudity check not running" and "…on a fallback provider" - only
 * appear when something is wrong, and the Groups tab's detail card only when a
 * group is open. Their chips were listed regardless, first in the row, and a
 * click scrolled to a card that was display:none: nothing happened at all.
 */
function syncJumpNav() {
  const nav = $('jumpnav');
  if (!nav) return;
  nav.querySelectorAll('button[data-i]').forEach((b) => {
    const card = JUMP_CARDS[+b.dataset.i];
    // Hidden by itself or by something inside its own tab; what hides the
    // whole app (the sign-in gate) is not this card's doing.
    const hider = card?.closest('.hidden');
    const gone = !card || (!!hider && !!card.closest('.panel')?.contains(hider));
    b.classList.toggle('hidden', gone);
  });
}
// Cards are shown and hidden from a dozen places, and one added later would
// not know to call syncJumpNav; watching the class changes catches them all.
if (typeof window.MutationObserver === 'function' && $('app')) {
  let queued = false;
  new window.MutationObserver(() => {
    if (queued) return;
    queued = true;
    setTimeout(() => { queued = false; syncJumpNav(); }, 0);
  }).observe($('app'), { subtree: true, attributes: true, attributeFilter: ['class'] });
}

/**
 * Stack the sticky bars - header, tabs, chips and, on Settings, the Save bar -
 * each directly under the one above, by measuring them.
 *
 * Their offsets were fixed numbers, and the header is not a fixed height: 66 px
 * on a desktop against the 53 assumed, and on a phone, where the search box
 * and the sign-out row wrap, 143 px. There the tabs (stuck at 52 px) and the
 * Settings Save bar (at 94 px) were underneath the header once the page was
 * scrolled, so a tap on "Save settings" landed on the header instead. The
 * chips were stuck at 0 on top of everything, over the header's own search
 * results, where a chip took the click meant for a result.
 *
 * A ResizeObserver keeps it right when the header wraps, the chip row changes
 * or the Save bar comes and goes with its tab. --stick-all is the whole stack,
 * which the CSS uses as scroll-margin so a card or group scrolled to lands
 * below the bars rather than behind them.
 */
function layoutStickyBars() {
  const css = document.documentElement?.style;
  if (!css || typeof window.getComputedStyle !== 'function') return;
  // Behind the sign-in screen nothing is laid out and everything measures 0;
  // the stylesheet's own numbers stand until the panel is shown.
  if (!document.querySelector('.topbar')?.getClientRects().length) return;
  const tall = (el) => (el && el.getClientRects().length && window.getComputedStyle(el).position === 'sticky'
    ? el.getBoundingClientRect().height : 0);
  const head = tall(document.querySelector('.topbar'));
  const tabs = tall($('tabs'));
  const chips = tall($('jumpnav'));
  const save = tall(document.querySelector('.panel.active .settings-actions'));
  // Rounded down, so a bar tucks a fraction of a pixel under the one above it
  // rather than leaving a hairline of the page showing through between them.
  const at = (px) => `${Math.floor(px)}px`;
  css.setProperty('--stick-tabs', at(head));
  css.setProperty('--stick-chips', at(head + tabs));
  css.setProperty('--stick-save', at(head + tabs + chips));
  css.setProperty('--stick-all', at(head + tabs + chips + save));
}
if (typeof window.ResizeObserver === 'function' && $('app')) {
  const bars = new window.ResizeObserver(() => layoutStickyBars());
  for (const el of [document.querySelector('.topbar'), $('tabs'), $('jumpnav'), ...document.querySelectorAll('.settings-actions')]) {
    if (el) bars.observe(el);
  }
}
layoutStickyBars();

function initPortalNav() {
  setupCollapsibles();
  renderJumpNav();
  refreshSearchIndex();
}
$('tabs')?.addEventListener('click', () => setTimeout(() => { renderJumpNav(); setupCollapsibles(); }, 30));

/* ===================== fresh-install checklist ======================
   The bot is rebuilt on new machines fairly often, and the settings a new box
   needs are spread over seven settings groups and three other tabs. Several of
   them fail quietly when missed: a nudity check that is ticked while "Use
   Gemini" is off never runs at all (content-check.js returns before asking),
   and with email off nobody hears that the bot went down with no spare to move
   to. This card lists every one of them, says whether it is done, and links
   straight to the field.

   The status logic is a pure function of what the page already holds: the
   masked config, the last WhatsApp status pushed over the event stream, and the
   numbers, admins and diagnostics the page loads anyway. That keeps it testable
   without a browser and means it never needs an endpoint of its own - the panel
   is push-only, so it is recomputed when one of those changes, never on a timer. */

/** What the page has learned outside the config. null means "not loaded yet". */
const FRESH = { accounts: null, admins: null, ffmpeg: null, update: null, hourly: null };

/**
 * One line about deploy/auto-update.sh, from the autoUpdate block that
 * diagnostics returns: { state: 'done' | 'broken' | 'optional', note }.
 * 'broken' whenever this box is not in fact taking updates - a failed pull, a
 * rollback, local edits, or an installed unit too old to run the updater at
 * all - because that is how a box falls behind without anyone noticing.
 * Turned off on purpose (AUTO_UPDATE=0) is a choice, not a fault.
 */
function describeAutoUpdate(up) {
  if (!up) return { state: 'optional', note: 'not checked yet' };
  if (!up.installed) {
    return { state: 'broken', note: 'has never run on this machine — its service unit predates it; re-render the unit (docs/operations.md, Upgrading)' };
  }
  const when = up.checkedAt ? fmtDateTime(up.checkedAt) : 'unknown';
  if (!up.ranThisStart) {
    return { state: 'broken', note: 'did not run when the bot last started — last ran ' + when + '; re-render the service unit (docs/operations.md, Upgrading)' };
  }
  if (up.result === 'off') return { state: 'optional', note: 'turned off on this machine (AUTO_UPDATE=0)' };
  if (up.result === 'updated' || up.result === 'up-to-date') {
    const n = Number(up.commits) || 0;
    const what = up.result === 'updated' ? 'updated at start, ' + n + (n === 1 ? ' commit' : ' commits') : 'up to date at start';
    const at = up.head ? ' · on ' + up.head.slice(0, 7) : '';
    const trial = up.trial ? ', on trial until it has run 10 minutes' : '';
    return { state: 'done', note: what + at + trial + ' · ' + when };
  }
  const reason = String(up.reason || up.result);
  const head = up.result === 'rolled-back' ? 'rolled back' : up.result === 'skipped' ? 'not updating' : 'update failed';
  return { state: 'broken', note: head + ': ' + (reason.length > 180 ? reason.slice(0, 177) + '…' : reason) };
}

/**
 * One line about the hourly check, from the hourlyCheck block diagnostics
 * returns (src/core/hourly-checks.js, hourlyCheckSummary). It is a cron job
 * the bot cannot see: what the page knows is the installer's record
 * (installed, removed, token saved and tested) and the runs the check
 * leaves. 'broken' whenever the box is not in fact being checked every hour
 * with research on - never installed, taken out, stopped running, or
 * running without a Claude token - because the owner's rule is that every
 * box runs it, and a quiet gap here is how it ran nowhere for days.
 */
function describeHourlyCheck(h) {
  if (!h) return { state: 'optional', note: 'not checked yet' };
  if (h.skipped) return { state: 'optional', note: 'this machine does without it: ' + h.skipped };
  const inst = h.install ?? null;
  const last = h.lastRun ?? null;
  const fix = 'node tools/routines.mjs --fix, from the live checkout';
  if (inst && inst.event === 'remove' && (!last || inst.at > last.at)) {
    return { state: 'broken', note: 'taken out of cron ' + fmtDateTime(inst.at) + ' — ' + fix };
  }
  if (!last && !inst) return { state: 'broken', note: 'not installed on this machine — ' + fix };
  // Whichever is newer says whether there is a token: a run records why it
  // could not research, and the installer records a token it saved.
  const noToken = last && (!inst || last.at >= inst.at)
    ? /^no token/.test(last.claude ?? '')
    : !!inst && !inst.token;
  const tokenNote = 'no Claude token, so it scans and reports but never fixes — claude setup-token, then deploy/install-hourly-debug.sh --set-token';
  if (!last) {
    const when = 'installed ' + fmtDateTime(inst.at) + ', first run at the top of the hour';
    if (noToken) return { state: 'broken', note: when + ' · ' + tokenNote };
    if (inst.verify === 'failed') return { state: 'broken', note: when + ' · the Claude token failed its test — run claude setup-token again, then --set-token' };
    // Not the token: the sandbox it is tested in would not start (WSL,
    // 2026-09-29), and a new token would fail the same way.
    if (inst.verify === 'no-sandbox') return { state: 'broken', note: when + ' · its sandbox does not start on this machine, so it scans and reports but never fixes — node tools/routines.mjs --only hourly-check says why' };
    return { state: 'done', note: when + (inst.verify === 'ok' ? ' · Claude token tested' : '') };
  }
  const outcome = last.alerts ? 'alert: see Logs → Hourly checks'
    : last.result === 'all-clear' ? 'all clear'
    : last.found ? last.found + (last.found === 1 ? ' finding' : ' findings') : String(last.result || 'unknown');
  const lastNote = 'last run ' + fmtDateTime(last.at) + ', ' + outcome;
  if (h.status?.overdue) {
    return { state: 'broken', note: lastNote + ' — nothing since; is it still in cron? deploy/install-hourly-debug.sh --status' };
  }
  if (noToken) return { state: 'broken', note: lastNote + ' · ' + tokenNote };
  const claude = String(last.claude ?? '');
  if (/^no token/.test(claude)) {
    return { state: 'done', note: lastNote + ' · Claude token saved ' + fmtDateTime(inst.at) + '; the next run researches' };
  }
  if (claude && claude !== 'ready' && claude !== 'off') {
    return { state: 'broken', note: lastNote + ' · research did not run: ' + (claude.length > 140 ? claude.slice(0, 137) + '…' : claude) };
  }
  return { state: 'done', note: 'on the hour · ' + lastNote + (claude === 'off' ? ' · research turned off on this machine' : '') };
}

/**
 * Every setting a new machine needs, in the order to do it.
 *
 * ctx: { config, role, status, accounts, admins, ffmpeg, update, hourly }. Each item is
 * { id, label, why, note, required, tab, target, status } where status is
 * 'done', 'missing' (a required item not done, or an optional one that is
 * switched on but cannot work), or 'optional' (optional and simply not set up).
 *
 * Failover, the TV section, direct links, the lockdown and the AI checks are
 * switched on by default since the operator's live settings became the
 * defaults (2026-10-12), and each waits without a word until it is given what
 * it needs. Switched on with none of it, such a part is 'optional', not set
 * up yet - every new install would otherwise open on six faults it never
 * made. Switched on and half set up is still a fault.
 */
function freshInstallChecklist(ctx = {}) {
  const c = ctx.config;
  if (!c) return [];
  const isSuper = ctx.role === 'superadmin';
  // Secrets reach the page as the mask when they are set and as '' when they
  // are not, so "non-empty" is the whole test. Nothing here needs a real
  // value, and no secret field is ever copied into a note, masked or not.
  const has = (v) => (Array.isArray(v) ? v.length > 0
    : typeof v === 'string' ? v.trim() !== '' : v != null && v !== false);
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const out = [];
  const add = (it) => out.push({
    tab: 'settings', note: '', ...it,
    status: it.done ? 'done' : (it.required || it.broken) ? 'missing' : 'optional',
  });

  const wa = c.whatsapp ?? {};
  const mr = c.movieRequests ?? {};
  const lib = c.library ?? {};
  const jf = lib.jellyfin ?? {};
  const g = c.gemini ?? {};
  const web = c.web ?? {};
  const plugins = c.plugins?.enabled ?? [];
  const s = ctx.status ?? null;
  const connected = s?.state === 'connected';
  const groupsHint = connected ? '' : ' — the list loads once WhatsApp is connected';

  /* ---- required ---- */

  // The Admins tab is the super-admin's alone, so a regular admin is never
  // sent there.
  const admins = ctx.admins ?? web.admins ?? [];
  if (isSuper) {
    add({ id: 'superadmin', required: true, tab: 'admins', target: '#card-admins',
      label: 'Super-admin sign-in',
      why: 'Made on the first-run screen. Only a super-admin can add admins or set their sign-out times.',
      done: true, note: `${plural(admins.length || 1, 'account')} can sign in` });
  }

  // Pairing sends its code to whatsapp.phoneNumber and to nothing else, so that
  // is the value judged here. Taking whichever of it and the numbers list had
  // digits ticked this step on a fresh install whose Edit had filled in the
  // list but not the pairing number, while Link / Connect failed with "Set your
  // WhatsApp phone number in Settings before linking".
  const digitsOf = (v) => String(v ?? '').replace(/[^0-9]/g, '');
  const active = ctx.accounts?.find((a) => a.active);
  const pairTo = digitsOf(wa.phoneNumber);
  const listed = digitsOf(active ? active.phoneNumber : s?.account?.phoneNumber);
  const pressEdit = 'press Edit on the number in use and save it';
  let waNumber;
  if ((wa.loginMethod || 'qr') !== 'pairing') {
    // A QR link needs no number, but the rest of the panel names the bot by it.
    const n = pairTo || listed;
    waNumber = n.length >= 7 ? { done: true, note: `+${n}` }
      : { done: false, note: 'no number yet — press Edit on it in the numbers list' };
  } else if (pairTo.length < 7) {
    waNumber = { done: false,
      note: listed.length >= 7 ? `+${listed} is in the numbers list, but a pairing code has no number to go to — ${pressEdit}`
        : 'no number yet — press Edit on it in the numbers list' };
  } else if (active && listed !== pairTo) {
    // Only against the numbers list the page loaded alongside this config: the
    // live status can run ahead of both after a failover, and comparing across
    // the two would cry wolf until the next reload.
    waNumber = { done: false,
      note: `a pairing code would go to +${pairTo}, but the number in use (${active.label}) is ${listed ? `+${listed}` : 'blank'} — ${pressEdit}` };
  } else {
    waNumber = { done: true, note: `+${pairTo} — the pairing code goes to this number` };
  }
  add({ id: 'wa-number', required: true, target: '#wa-accounts',
    label: 'WhatsApp number',
    why: 'The number the bot runs as. The pairing code is sent to it, so the digits must be right.',
    ...waNumber });

  const STATE_NOTE = {
    connected: 'connected',
    connecting: 'connecting…',
    'awaiting-pairing': 'waiting for the pairing code to be typed on the phone',
    'awaiting-qr': 'waiting for the QR code to be scanned',
    conflict: 'another session took this number over',
    error: `error${s?.lastError ? `: ${s.lastError}` : ''}`,
    stopped: s?.account?.linked
      ? 'linked, but not connected — press Link / Connect'
      : 'not linked on this machine yet — press Link / Connect',
  };
  add({ id: 'wa-linked', required: true, tab: 'dashboard', target: connected ? '#card-conn' : '#btn-start',
    label: 'WhatsApp linked and connected',
    why: 'Live from the bot. Link once per machine, unless the saved session came across with the backup.',
    done: connected,
    note: s ? (STATE_NOTE[s.state] ?? s.state) : 'waiting for the live connection state' });

  const provider = lib.provider || 'jellyfin';
  const PROVIDER = { jellyfin: 'Jellyfin', plex: 'Plex', http: 'custom HTTP index', local: 'local folders' };
  const proves = ' — Test connection proves search works';
  let libItem;
  if (provider === 'jellyfin') {
    const method = jf.authMethod || 'password';
    const token = method === 'apikey' ? jf.apiKey : jf.accessToken;
    const signIn = { apikey: '#f-jf-key', quickconnect: '#btn-jf-qc' }[method] ?? '#btn-jf-login';
    libItem = !has(jf.baseUrl) ? { done: false, target: '#f-jf-url', note: 'no server address yet' }
      : !has(token) ? { done: false, target: signIn,
        note: method === 'apikey' ? 'server set, but no API key' : 'server set, but the bot has not signed in to it' }
      : { done: true, target: '#btn-test-lib', note: `signed in${jf.userName ? ` as ${jf.userName}` : ''}${proves}` };
  } else if (provider === 'plex') {
    const p = lib.plex ?? {};
    libItem = !has(p.baseUrl) ? { done: false, target: '#f-plex-url', note: 'no server address yet' }
      : !has(p.token) ? { done: false, target: '#f-plex-token', note: 'no X-Plex-Token yet' }
      : { done: true, target: '#btn-test-lib', note: `set${proves}` };
  } else if (provider === 'http') {
    libItem = has(lib.http?.searchUrl)
      ? { done: true, target: '#btn-test-lib', note: `set${proves}` }
      : { done: false, target: '#f-http-url', note: 'no search URL yet' };
  } else {
    const roots = lib.local?.roots ?? [];
    libItem = roots.length
      ? { done: true, target: '#btn-test-lib', note: `${plural(roots.length, 'folder')}${proves}` }
      : { done: false, target: '#f-local-roots', note: 'no folders yet' };
  }
  add({ id: 'library', required: true, ...libItem,
    label: `Library server (${PROVIDER[provider] ?? provider})`,
    why: 'Where the films come from. The bot searches as this account, so it must see every library you serve.' });

  // ffprobe as well as ffmpeg: every send starts by probing the file, so a box
  // with ffmpeg alone would read "installed" here and still fail every film.
  const ff = ctx.ffmpeg;
  const noTool = !ff ? [] : ['ffmpeg', 'ffprobe'].filter((t) => !ff[t]);
  add({ id: 'ffmpeg', required: true, tab: 'dashboard', target: '#diag',
    label: 'ffmpeg and ffprobe on this machine',
    why: 'Every film is probed, then copied or re-encoded. install.sh, or tools/bootstrap.sh, puts them there.',
    done: !!ff && noTool.length === 0,
    note: !ff ? 'not checked yet'
      : !noTool.length ? 'both installed'
      : `${noTool.join(' and ')} missing — nothing can be sent until ${noTool.length > 1 ? 'they are' : 'it is'} installed` });

  // Optional, so it never holds up a new machine, but amber whenever this box
  // is not actually taking updates: nothing else would say so.
  const upd = describeAutoUpdate(ctx.update);
  add({ id: 'auto-update', required: false, tab: 'dashboard', target: '#diag',
    label: 'Updates from GitHub on every start',
    why: 'Each start pulls the latest code first, so fixes arrive without anyone logging in to pull.',
    done: upd.state === 'done', broken: upd.state === 'broken', note: upd.note });

  // The same: a routine of the machine rather than a setting, so never what
  // holds a new box up, but flagged whenever it is not really running.
  const hc = describeHourlyCheck(ctx.hourly);
  add({ id: 'hourly-check', required: false, tab: 'logs', target: '#card-hourly-checks',
    label: 'The hourly check',
    why: 'Every hour, failed or unanswered requests are researched, fixed if they are a bug, and reported to you.',
    done: hc.state === 'done', broken: hc.state === 'broken', note: hc.note });

  const md = c.media ?? {};
  const cap = Number(md.maxOutputBytes);
  // WhatsApp refuses documents over 2 GB, so a cap above that turns every film
  // big enough to need it into a failed send rather than a re-encode.
  const capOk = cap > 0 && cap <= 2 * 1024 ** 3;
  add({ id: 'files', required: true, target: has(md.workDir) ? '#f-maxbytes' : '#f-workdir',
    label: 'File handling',
    why: 'Where films are staged, and the size they are squeezed under to fit WhatsApp.',
    done: has(md.workDir) && capOk,
    note: !has(md.workDir) ? 'no work directory'
      : !capOk ? 'the size cap is missing or above WhatsApp’s 2 GB limit'
      : `cap ${(cap / 1024 ** 3).toFixed(1)} GiB · ${md.strategy || 'auto'}` });

  const omdb = has(c.omdb?.apiKey);
  add({ id: 'omdb', required: true, target: omdb ? '#btn-test-omdb' : '#f-omdbkey',
    label: 'OMDb API key',
    why: 'Every request is identified, and its rating read, through OMDb. Without it nothing is sent.',
    done: omdb, note: omdb ? 'saved — Test key checks it still works' : 'a free key from omdbapi.com' });

  const reqGroups = (mr.requestGroups ?? []).length;
  add({ id: 'request-groups', required: true, target: '#group-checks',
    label: 'Movie request groups',
    why: 'The groups the bot listens to for film titles.',
    done: reqGroups > 0, note: reqGroups ? plural(reqGroups, 'group') : `none ticked${groupsHint}` });

  add({ id: 'posts-group', required: true, target: '#f-postsgroup',
    label: 'Movie posts group',
    why: 'Where finished films are sent.',
    done: has(mr.postsGroup), note: has(mr.postsGroup) ? '' : `none chosen${groupsHint}` });

  const blocked = mr.blockedRatings ?? [];
  add({ id: 'blocked-ratings', required: true, target: '#f-blocked',
    label: 'Blocked ratings',
    why: 'The rating gate on what may be posted to the groups.',
    done: blocked.length > 0,
    note: blocked.length ? `blocking ${blocked.join(', ')}${mr.blockUnrated ? ', and unrated films' : ''}`
      : 'nothing is blocked — every rating would be sent' });

  const em = c.email ?? {};
  const emGap = !em.enabled ? 'enabled' : !has(em.user) ? 'user' : !has(em.appPassword) ? 'pass'
    : em.provider === 'custom' && !has(em.host) ? 'host' : '';
  add({ id: 'email', required: true,
    target: { enabled: '#f-em-enabled', user: '#f-em-user', pass: '#f-em-pass', host: '#f-em-host' }[emGap] ?? '#btn-em-test',
    label: 'Email alerts',
    why: 'The only way anyone hears that the bot went down with no spare number to move to.',
    done: !emGap,
    note: { enabled: 'switched off', user: 'no email address', pass: 'no app password saved', host: 'custom SMTP with no host' }[emGap]
      ?? `alerts go to ${em.to || em.user} — Send test email proves it` });

  const port = Number(web.port);
  const panelOk = Number.isInteger(port) && port > 0 && port < 65536 && has(web.bindAddress);
  add({ id: 'panel', required: true, target: '#f-port',
    label: 'Control panel address',
    why: 'The port and bind address this panel answers on. A change takes effect after a restart.',
    done: panelOk, note: panelOk ? `port ${port} on ${web.bindAddress}` : 'the port or bind address is empty' });

  add({ id: 'plugins', required: true, target: '#f-plugins',
    label: 'Movie-request plugin enabled',
    why: 'The plugin list decides what the bot answers at all.',
    done: plugins.includes('movie-requests'),
    note: plugins.includes('movie-requests') ? plugins.join(', ')
      : 'movie-requests is missing from the list, so nothing answers requests' });

  /* ---- optional ---- */

  if (isSuper) {
    const others = Math.max(0, admins.length - 1);
    add({ id: 'admins', required: false, tab: 'admins', target: '#na-user',
      label: 'Admin accounts for helpers',
      why: 'Each person signs in as themselves, so the audit log says who did what.',
      done: others > 0, note: others ? plural(others, 'other admin') : 'only the super-admin can sign in' });
  }

  // Without the per-number list the page cannot tell whether a spare is
  // linked, so it falls back to counting the configured numbers.
  // "Active" comes from accountInUseId(), which mirrors listAccounts(). A bare
  // `activeAccount || first` got a blank value right but not a stale one: an
  // activeAccount naming a deleted number marked nothing active, and the number
  // in use was counted as its own spare.
  const known = Array.isArray(ctx.accounts);
  const inUse = accountInUseId(wa);
  const numbers = known ? ctx.accounts : (wa.accounts ?? []).map((a) => ({ ...a, active: a.id === inUse }));
  const spares = numbers.filter((a) => !a.active);
  const ready = known ? spares.filter((a) => a.linked).length : spares.length;
  const foOn = !!wa.failover?.enabled;
  add({ id: 'wa-spares', required: false,
    target: !spares.length ? '#acct-label' : !ready ? '#wa-accounts' : '#fo-enabled',
    label: 'Backup number and failover',
    why: 'If the main number is logged out or banned, a linked spare takes over instead of the bot going quiet.',
    done: foOn && ready > 0,
    // With one number failover stands aside (failover.js, _hasSpare): not
    // set up, rather than broken. A spare added and never linked is broken.
    broken: foOn && spares.length > 0 && ready === 0,
    note: !spares.length ? (foOn ? 'only one number is set up — failover is on, and takes over once a spare is linked' : 'only one number is set up')
      : !ready ? `${plural(spares.length, 'spare')} set up, none linked — switch to it and link it once`
      : !foOn ? `${plural(ready, known ? 'linked spare' : 'spare')} ready, but automatic failover is off`
      : `${plural(ready, known ? 'linked spare' : 'spare')}, failover on` });

  add({ id: 'notify-group', required: false, target: '#f-notifygroup',
    label: 'Notifications group',
    why: 'A live play-by-play of each request, with the requester @-mentioned.',
    done: has(mr.notify?.group), note: has(mr.notify?.group) ? '' : `none — requesters see reactions only${groupsHint}` });

  const th = mr.theatrical ?? {};
  add({ id: 'tmdb', required: false, target: th.enabled ? '#f-tmdbkey' : '#f-th-enabled',
    label: 'Theatrical check with a TMDB key',
    why: 'Tells “still in cinemas” apart from “we do not have it”. The key makes that definite instead of a guess.',
    done: !!th.enabled && has(th.tmdbApiKey),
    note: !th.enabled ? 'switched off' : has(th.tmdbApiKey) ? '' : 'on, but guessing from release dates without a key' });

  const gKey = has(g.apiKey);
  // Who the film lookup and the nudity check would ask, in the chain's order,
  // read as chainPlan in ai-providers.js reads it: Gemini asked, and allowed
  // to clear a rated film, unless switched off; every other provider neither,
  // unless ticked. Groq, Cerebras and OpenRouter are ticked for both by
  // default since 2026-10-12 (the operator's live settings), so a key for any
  // one of them runs the lookup and the check with no Gemini key at all.
  // These rows read only Gemini's key, and called such a setup two faults -
  // "no Gemini key", "never runs" - while a review ran the real check on the
  // same config and Groq cleared a film with it.
  const aiIds = Object.keys(AI_NAMES);
  const aiChain = [...(Array.isArray(c.ai?.order) ? c.ai.order : []), ...aiIds]
    .filter((id, i, all) => aiIds.includes(id) && all.indexOf(id) === i)
    .map((id) => (id === 'gemini'
      ? { id, on: c.ai?.gemini?.enabled !== false, key: gKey, clears: c.ai?.gemini?.canClearRated !== false }
      : { id, on: c.ai?.[id]?.enabled === true, key: has(c.ai?.[id]?.apiKey), clears: c.ai?.[id]?.canClearRated === true }));
  // No key for any AI provider is AI not set up at all: the lookup and the
  // nudity check, on by default, are then not asked (anyAiKey in
  // ai-providers.js), so they are waiting rather than broken.
  const aiKey = aiChain.some((p) => p.key);
  const answers = aiChain.filter((p) => p.on && p.key);
  // Who answers first, when it is not Gemini, and why: "no Gemini key - Groq
  // answers it".
  const gem = aiChain.find((p) => p.id === 'gemini');
  const insteadOfGemini = (asked, clearing = false) => `${!gKey ? 'no Gemini key'
    : !gem.on ? 'Gemini is switched off under AI providers'
      : clearing && !gem.clears ? 'Gemini may not clear rated films' : 'Gemini is not asked'}`
    + ` — ${AI_NAMES[asked.find((p) => p.id !== 'gemini')?.id] ?? 'another provider'} answers it`;
  add({ id: 'gemini', required: false,
    target: answers.length || !aiKey ? (!gKey ? '#f-gemini-key' : '#f-gemini-on') : '#ai-list',
    label: 'Gemini film identification',
    why: 'Works out which film a paraphrase or half-remembered title meant, when OMDb draws a blank.',
    // A blank model is Automatic (the newest Flash on the key), not missing.
    done: !!g.enabled && answers.length > 0,
    broken: !!g.enabled && !answers.length && aiKey,
    note: g.enabled
      ? (answers.some((p) => p.id === 'gemini') ? (!has(g.model) ? 'model: Automatic, the newest Flash' : `model ${g.model}`)
        : answers.length ? insteadOfGemini(answers)
        : aiKey ? 'every AI provider with a key is switched off under AI providers, so it never runs'
        : 'on, waiting for an API key — it runs once one is saved')
      : (gKey ? 'key saved, but switched off' : 'switched off') });

  // The content check is gated on Gemini being ENABLED as well as on its own
  // box, so ticking only the nudity box looks like protection and is none.
  // And it is asked only to clear a title its rating blocks, so only with
  // "Also send rated films" on and a provider allowed to clear one that can
  // be asked (aiCanClear in content-check.js, which asks only those).
  const allowClean = g.allowCleanRatedFilms === true;
  const clearers = answers.filter((p) => p.clears);
  const ccRuns = !!g.enabled && !!g.contentCheck && allowClean && clearers.length > 0;
  // Ticked with Gemini on and no AI key anywhere is the default on a new
  // install: waiting for a key, not broken (see aiKey above).
  const ccWaits = !!g.enabled && !!g.contentCheck && !aiKey;
  add({ id: 'content-check', required: false,
    target: g.contentCheck && !g.enabled ? '#f-gemini-on'
      : g.contentCheck && !ccRuns && !ccWaits ? (!allowClean ? '#f-gemini-allowclean' : !gKey ? '#f-gemini-key' : '#ai-list')
      : '#f-gemini-content',
    label: 'Nudity content check',
    why: 'Checks what is actually in a film before it is sent, instead of trusting one rating letter.',
    done: ccRuns,
    broken: !!g.contentCheck && !ccRuns && !ccWaits,
    note: !g.contentCheck ? 'switched off'
      : !g.enabled ? 'ticked, but it only runs when “Use Gemini” is on too'
      : ccWaits ? 'on, waiting for an API key — until then a rated film is refused on its rating'
      : !allowClean ? 'ticked, but “Also send rated films and episodes with no nudity” is off, so it has nothing to clear and is never asked'
      : !clearers.length ? (gKey ? 'ticked, but no provider allowed to clear rated films is switched on with a key'
        : 'ticked, but there is no Gemini key, and no other provider allowed to clear rated films has one')
      : clearers.some((p) => p.id === 'gemini') ? '' : insteadOfGemini(clearers, true) });

  const tv = c.tvRequests ?? {};
  const tvReq = (tv.requestGroups ?? []).length;
  const tvPosts = (tv.postsGroups ?? []).length;
  const tvGap = !plugins.includes('tv-requests') ? 'plugin' : !tvReq ? 'req' : !tvPosts ? 'posts' : '';
  // On by default with no TV group at all, it answers nothing: waiting to be
  // set up. One group without the other is half set up, and broken.
  const tvWaits = !!tv.enabled && tvGap !== 'plugin' && !tvReq && !tvPosts;
  add({ id: 'tv', required: false,
    target: !tv.enabled ? '#f-tv-enabled'
      : { plugin: '#f-plugins', req: '#tv-request-groups', posts: '#tv-posts-groups' }[tvGap] ?? '#f-tv-enabled',
    label: 'TV section',
    why: 'TV has its own request and posts groups, and every episode queues behind every film.',
    done: !!tv.enabled && !tvGap,
    broken: !!tv.enabled && !!tvGap && !tvWaits,
    note: !tv.enabled ? 'switched off'
      : tvWaits ? 'on, waiting for a TV request group and a posts group'
      : { plugin: 'switched on, but the tv-requests plugin is not enabled',
          req: 'switched on with no TV request group', posts: 'switched on with no TV posts group' }[tvGap]
        ?? `${plural(tvReq, 'request group')}, ${plural(tvPosts, 'posts group')}` });

  const enf = mr.enforcement ?? {};
  add({ id: 'enforcement', required: false, target: '#f-enf-enabled',
    label: 'Request-group enforcement',
    why: 'Deletes anything in the request groups that is not a request. The bot must be a group admin there.',
    done: !!enf.enabled, note: enf.enabled ? '' : 'switched off' });

  add({ id: 'group-rules', required: false, target: '#f-rules',
    label: 'Group rules text',
    why: `What the bot answers when someone sends ${mr.rulesCommand || '#rules'} in a group.`,
    done: has(mr.rules), note: has(mr.rules) ? '' : 'empty — the command has nothing to answer with' });

  // The plugin falls back to the bot's own Jellyfin credential when no
  // dedicated key is set, so a missing share key still works - it just
  // publishes a key that cannot be revoked without breaking the bot.
  const dl = c.directLinks ?? {};
  const dlKey = has(dl.apiKey) || (dl.allowBotKeyFallback !== false && (has(jf.apiKey) || has(jf.accessToken)));
  const dlGap = !plugins.includes('direct-links') ? 'plugin' : !(dl.groups ?? []).length ? 'groups' : !dlKey ? 'key' : '';
  // On by default with no group ticked, it answers nothing: waiting.
  const dlWaits = !!dl.enabled && dlGap === 'groups';
  add({ id: 'direct-links', required: false,
    target: !dl.enabled ? '#f-dl-enabled'
      : { plugin: '#f-plugins', groups: '#dl-groups', key: '#f-dl-apikey' }[dlGap]
        ?? (has(dl.apiKey) ? '#f-dl-enabled' : '#f-dl-apikey'),
    label: 'Direct links group',
    why: 'A separate group that gets Jellyfin links instead of files.',
    done: !!dl.enabled && !dlGap,
    broken: !!dl.enabled && !!dlGap && !dlWaits,
    note: !dl.enabled ? 'switched off'
      : { plugin: 'switched on, but the direct-links plugin is not enabled',
          groups: 'on, waiting for a group to be ticked', key: 'switched on with no Jellyfin key to put in the links' }[dlGap]
        ?? (has(dl.apiKey) ? '' : 'using the bot’s own Jellyfin key — a dedicated share key can be revoked on its own') });

  // Havdalah opens every group the bot can see except the always-locked ones
  // (_runLockdown in bot.js), so a schedule switched on with that list empty
  // would open the posts group and every other admin-only group to all
  // members on the first Motzei Shabbos. On a new install - the lockdown is
  // on by default since 2026-10-12 - the schedule waits instead, locking
  // nothing until a group is always-locked or the card is saved as it is
  // (scheduleHeld in lockdown.js), so the row is not a finished step, nor a
  // fault: it says what it is waiting for. Once somebody has saved the list
  // empty, or switched the lockdown on before it was the default, every
  // group is locked and opened, and the row says so.
  const lk = c.lockdown ?? {};
  const kept = (lk.alwaysLocked ?? []).length;
  const lkWaits = !!lk.enabled && !kept && lk.alwaysLockedReviewed !== true;
  //
  // Each end is measured in its own city (New York candle-lighting and
  // Jerusalem havdalah by the operator's choice), so the note names both
  // rather than telling the operator every time is New York's.
  add({ id: 'lockdown', required: false, tab: 'groups',
    target: lkWaits ? '#al-sync' : '#f-lock-enabled',
    label: 'Shabbos and yom tov lockdown',
    why: 'Locks every group at candle-lighting and opens it at havdalah, each in the city chosen on the Groups tab.',
    done: !!lk.enabled && !lkWaits,
    note: !lk.enabled ? 'switched off'
      : lkWaits ? 'on, waiting: nothing is locked until a group is always-locked, or havdalah would open every admin-only group'
        + ' — Sync from WhatsApp finds them, or Save the card as it is if none is admins-only for good'
      : `${lk.yomTov !== false ? 'Shabbos and yom tov' : 'Shabbos only'} · candle-lighting in `
        + `${lockCityName(lk.candleCity, 'candle')}, havdalah in ${lockCityName(lk.havdalahCity, 'havdalah')}`
        + ` · ${kept ? `${plural(kept, 'group')} always locked` : 'no group always locked: havdalah opens every group'}` });

  // How long an idle panel stays signed in is the super-admin's decision, so
  // a regular admin is not pointed at it.
  //
  // Since per-admin timeouts, #f-idle holds only the default: an account can
  // carry its own, 0 ("never") included. The checklist and the timeouts were
  // built side by side, and once merged the note still read "after 15 min
  // idle" while an admin was set to never be signed out, a promise the panel
  // was not keeping. So the note counts the accounts with their own time. The
  // Admins tab list already carries each value as the guard applies it (null
  // for the default); the raw config copy is checked with the same rule the
  // guard uses, so a hand-edited "0" string is not counted as "never".
  if (isSuper) {
    const idle = Number(web.idleTimeoutMinutes ?? 15);
    const own = admins.map((a) => a.idleTimeoutMinutes).filter(validIdle);
    const never = own.filter((m) => m === 0).length;
    const perAdmin = own.length
      ? ` · own time for ${plural(own.length, 'admin')}${never ? ` (${never} never signed out)` : ''}` : '';
    add({ id: 'idle', required: false, target: '#f-idle',
      label: 'Idle sign-out',
      why: 'Signs out a panel left open and forgotten. This is the default; the Admins tab can give an admin their own.',
      done: idle > 0,
      note: (idle > 0 ? `after ${idle} min idle by default` : 'off by default — an open tab stays signed in') + perAdmin });
  }

  return out;
}

/** The counts the progress line shows. */
function freshInstallSummary(items) {
  const req = items.filter((i) => i.required);
  const opt = items.filter((i) => !i.required);
  return {
    requiredDone: req.filter((i) => i.status === 'done').length,
    requiredTotal: req.length,
    optionalDone: opt.filter((i) => i.status === 'done').length,
    optionalTotal: opt.length,
    broken: opt.filter((i) => i.status === 'missing').length,
  };
}

function freshInstallContext() {
  return { config: CONFIG, role: CURRENT_USER?.role ?? null, status: lastStatus, ...FRESH };
}

const FIC_MARK = {
  done: ['✓', 'Done'],
  missing: ['!', 'Needs attention'],
  optional: ['○', 'Optional, not set up'],
};

/** "Settings › Movies", worked out from the page so it cannot drift from it. */
function freshInstallWhere(tab, target) {
  const tabName = document.querySelector(`.tab[data-tab="${tab}"]`)?.textContent.trim() || tab;
  const el = document.querySelector(target);
  const group = el?.closest('.settings-group');
  const card = el?.closest('.card');
  return {
    where: group ? `${tabName} › ${group.dataset.label ?? group.dataset.group}` : tabName,
    card: card?.querySelector('h2')?.textContent.replace(/\s+/g, ' ').trim() ?? '',
  };
}

function renderFreshInstall(ctx = freshInstallContext()) {
  const box = $('fic-list');
  const head = $('fic-summary');
  if (!box || !head) return;
  const items = freshInstallChecklist(ctx);
  if (!items.length) {
    head.innerHTML = '';
    box.innerHTML = '<div class="empty">Loading…</div>';
    return;
  }

  const sum = freshInstallSummary(items);
  const allDone = sum.requiredDone === sum.requiredTotal;
  const pct = sum.requiredTotal ? Math.round((sum.requiredDone / sum.requiredTotal) * 100) : 100;
  head.innerHTML = `
    <strong class="${allDone ? 'fic-all' : ''}">${allDone
      ? `All ${sum.requiredTotal} required settings are done`
      : `${sum.requiredDone} of ${sum.requiredTotal} required done`}</strong>
    <div class="bar"><i style="width:${pct}%"></i></div>
    <span class="muted">${sum.optionalDone} of ${sum.optionalTotal} optional set up</span>
    ${sum.broken ? `<span class="fic-warn">${sum.broken} optional ${sum.broken === 1 ? 'feature is' : 'features are'} switched on but incomplete</span>` : ''}
    ${allDone ? '<a href="#" class="card-link" data-goto="test" data-target="#test-input">now dry-run a title in the Test tab →</a>' : ''}`;

  const row = (it) => {
    const [mark, markTitle] = FIC_MARK[it.status];
    const { where, card } = freshInstallWhere(it.tab, it.target);
    return `
      <div class="fic-item fic-${it.status}${it.required ? '' : ' fic-opt'}" data-item="${esc(it.id)}">
        <span class="fic-mark" title="${esc(markTitle)}" aria-label="${esc(markTitle)}">${mark}</span>
        <div class="fic-body">
          <div class="fic-label">${esc(it.label)}</div>
          <div class="fic-why">${esc(it.why)}</div>
          ${it.note ? `<div class="fic-note">${esc(it.note)}</div>` : ''}
        </div>
        <a href="#" class="card-link" data-goto="${esc(it.tab)}" data-target="${esc(it.target)}"
           title="${esc(card)}">${esc(where)} →</a>
      </div>`;
  };
  box.innerHTML =
    '<div class="fic-head">Required on every new machine</div>'
    + items.filter((i) => i.required).map(row).join('')
    + '<div class="fic-head">Optional — worth a look, not needed to take requests</div>'
    + items.filter((i) => !i.required).map(row).join('');
}

let freshTimer = null;
/**
 * Coalesced, because a save, a status push and a list reload often arrive
 * together, and deferred, because the api() hook fires before its caller has
 * stored the config it is about to return.
 */
function refreshFreshInstall() {
  clearTimeout(freshTimer);
  freshTimer = setTimeout(() => renderFreshInstall(), 0);
}

/* ------------------------------ TV section -------------------------- */
function renderTvGroupPickers() {
  if (!CONFIG) return;
  const tv = CONFIG.tvRequests ?? {};
  renderGroupChecks($('tv-request-groups'), 'tvreq-g', tv.requestGroups);
  renderGroupChecks($('tv-posts-groups'), 'tvposts-g', tv.postsGroups);
}

function loadTvSection() {
  const tv = CONFIG?.tvRequests ?? {};
  if (!$('f-tv-enabled')) return;
  $('f-tv-enabled').checked = !!tv.enabled;
  $('f-tv-maxeps').value = tv.maxEpisodesPerRequest ?? 10;
  $('f-tv-maxseasons').value = tv.maxSeasonsPerRequest ?? 1;
  $('f-tv-cooldown').value = tv.cooldownSecondsPerUser ?? 3600;
  $('f-tv-cooldown-others').checked = !!tv.cooldownOnlyWhenOthersWait;
  $('f-tv-prefix').checked = !!tv.requirePrefix;
  $('f-queue-priority').checked = CONFIG?.queue?.strictMoviePriority !== false;
  $('f-queue-fair').checked = CONFIG?.queue?.fairShare === true;
  renderTvGroupPickers();
}

$('tv-save')?.addEventListener('click', async () => {
  $('tv-save-note').textContent = 'saving…';
  try {
    const clears = clearGroupsQuery([
      clearedGroupChecks($('tv-request-groups'), 'tvreq-g') && 'tvRequests.requestGroups',
      clearedGroupChecks($('tv-posts-groups'), 'tvposts-g') && 'tvRequests.postsGroups',
    ]);
    CONFIG = await api('PUT', `/config${clears}`, {
      tvRequests: {
        enabled: $('f-tv-enabled').checked,
        requestGroups: groupChecksValue($('tv-request-groups'), 'tvreq-g'),
        postsGroups: groupChecksValue($('tv-posts-groups'), 'tvposts-g'),
        // An empty box keeps the default rather than lifting the limit: +'' is
        // 0, which means no limit, and one message could then fill the queue.
        maxEpisodesPerRequest: $('f-tv-maxeps').value.trim() === '' ? 10 : Math.max(0, Math.floor(+$('f-tv-maxeps').value) || 0),
        maxSeasonsPerRequest: $('f-tv-maxseasons').value.trim() === '' ? 1 : Math.max(0, Math.floor(+$('f-tv-maxseasons').value) || 0),
        cooldownSecondsPerUser: +$('f-tv-cooldown').value || 0,
        cooldownOnlyWhenOthersWait: $('f-tv-cooldown-others').checked,
        requirePrefix: $('f-tv-prefix').checked,
      },
      queue: { strictMoviePriority: $('f-queue-priority').checked, fairShare: $('f-queue-fair').checked },
    });
    const tv = CONFIG.tvRequests ?? {};
    const warn = tv.enabled && (!tv.requestGroups?.length || !tv.postsGroups?.length)
      ? ' <span style="color:var(--warn)">— pick at least one request group and one posts group</span>' : '';
    $('tv-save-note').innerHTML = `<span style="color:var(--accent)">saved</span>${warn}`;
    loadTvSection();
    loadBetaSection({ fresh: false });          // which groups are main may have changed
  } catch (err) { $('tv-save-note').innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`; }
});

/* ------------------------- beta testing ----------------------------- */
/* The feature registry lives in code (src/core/beta.js), not in the config, so
   it comes from GET /beta. Saving goes through PUT /config like every other
   card, and the server refuses a beta group that the main service already uses.

   The card is redrawn whenever the group list arrives over SSE. Ticks that
   have not been saved yet survive that redraw: a group refresh landing while
   somebody is choosing should not quietly undo their choice.

   Which groups the main service uses also comes from GET /beta, so it is
   fetched again after the Settings, TV and direct-links saves - any of them
   can change it, and the card would otherwise go on offering a group that has
   just become a main one.

   Until GET /beta has answered, the card cannot tell which groups are main
   or which features exist. It says so and cannot be saved, rather than draw an
   empty registry ("No features are in testing right now") and a picker in
   which every main group is tickable. `loaded`/`error` are what keep an SSE
   redraw from painting over a failed load with that. */
let BETA = { loaded: false, error: null, features: [], modes: ['off', 'beta', 'on'], mainGroups: {}, conflicts: [] };
const BETA_MODE_LABEL = { off: 'Off', beta: 'Beta — test groups only', on: 'On — every group' };
const BETA_SCOPE_LABEL = { movie: 'movies', tv: 'TV', all: 'movies & TV' };
const betaReady = () => BETA.loaded && !BETA.error;

/* ------------------------- library updates ------------------------- */
/** The Library updates card (library-news.js): who, and in which groups. */
function renderLibraryNewsCard({ fresh = false } = {}) {
  const box = $('news-groups');
  if (!box) return;
  const saved = CONFIG?.libraryNews ?? {};
  const draft = !fresh && box.dataset.rendered === '1'
    ? [...box.querySelectorAll('input.news-g:checked')].map((i) => i.value) : null;
  const chosen = new Set(draft ?? saved.groups ?? []);
  if (fresh || !$('f-news-senders').value) $('f-news-senders').value = (saved.senders ?? []).join(', ');
  const known = new Set(GROUPS.map((g) => g.jid));
  // A saved group missing from the list still gets a ticked row, or saving
  // while the list is unavailable would drop it (as the beta card does).
  const rows = [
    ...GROUPS.map((g) => ({ jid: g.jid, name: g.subject, size: g.size })),
    ...[...chosen].filter((j) => !known.has(j)).map((j) => ({ jid: j, name: missingGroupLabel(j, 'saved'), size: null, missing: true })),
  ];
  box.innerHTML = rows.length ? rows.map((g) => `<label class="check"><input type="checkbox" class="news-g" value="${esc(g.jid)}"${chosen.has(g.jid) ? ' checked' : ''}>
      <span>${g.missing ? `<span class="muted">${esc(g.name)}</span>` : esc(g.name)}${g.size != null ? ` <span class="muted small">(${g.size})</span>` : ''}${
        g.missing ? `<br><span class="gjid">${esc(g.jid)}</span>` : ''}</span></label>`).join('')
    : '<div class="empty">No groups loaded. Connect WhatsApp, then refresh the group list.</div>';
  box.dataset.rendered = '1';
}

$('news-save')?.addEventListener('click', async () => {
  const senders = $('f-news-senders').value.split(/[,\s;]+/).map((n) => n.replace(/\D/g, '')).filter(Boolean);
  const bad = senders.filter((n) => n.length < 10 || n.length > 15);
  if (bad.length) { $('news-note').innerHTML = `<span style="color:var(--danger)">Not a full number with its country code: ${esc(bad.join(', '))}</span>`; return; }
  const groups = [...document.querySelectorAll('#news-groups input.news-g:checked')].map((i) => i.value);
  try {
    CONFIG = await api('PUT', '/config', { libraryNews: { senders, groups } });
    renderLibraryNewsCard({ fresh: true });
    $('news-note').innerHTML = `<span style="color:var(--accent)">saved - watching ${senders.length} number(s) in ${groups.length} group(s)</span>`;
  } catch (err) {
    $('news-note').innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`;
  }
});

async function loadBetaSection({ fresh = true } = {}) {
  if (!$('card-beta')) return;
  try {
    BETA = { ...BETA, ...(await api('GET', '/beta')), loaded: true, error: null };
  } catch (err) {
    BETA = { ...BETA, error: err.message };
  }
  renderBetaCard({ fresh });
  renderGroupsList();
}

/**
 * The Groups-tab marker for one group, so a test group is never mistaken for
 * a real one where people go to manage it. A group ticked as beta that the
 * main service also uses runs as MAIN (see isBetaGroup in src/core/beta.js),
 * and is labelled as such rather than as a test group.
 */
function betaPill(jid) {
  if (!betaReady()) return '';
  const main = BETA.mainGroups?.[jid];
  if ((CONFIG?.beta?.groups ?? []).includes(jid)) {
    return main
      ? ` <span class="pill warn">🧪 beta ignored — it is the ${esc(main)}</span>`
      : ' <span class="pill">🧪 beta</span>';
  }
  if (jid && CONFIG?.beta?.postsGroup === jid && !main) return ' <span class="pill">🧪 beta posts</span>';
  return '';
}

/** What the card says right now, or null before it has been drawn. */
function readBetaForm() {
  const box = $('beta-groups');
  if (!box || box.dataset.rendered !== '1') return null;
  const features = {};
  document.querySelectorAll('#beta-features select.beta-mode').forEach((s) => { features[s.dataset.key] = s.value; });
  return {
    groups: [...document.querySelectorAll('#beta-groups input.beta-g:checked')].map((i) => i.value),
    postsGroup: $('beta-posts').value,
    features,
  };
}

function renderBetaCard({ fresh = false } = {}) {
  const box = $('beta-groups');
  if (!box) return;
  const saved = CONFIG?.beta ?? {};
  const draft = fresh ? null : readBetaForm();
  const chosen = new Set(draft?.groups ?? saved.groups ?? []);
  const posts = draft?.postsGroup ?? saved.postsGroup ?? '';
  const main = BETA.mainGroups ?? {};
  const known = new Set(GROUPS.map((g) => g.jid));

  // A saved beta group missing from the fetched list still gets a ticked row,
  // or saving while the list is unavailable would silently drop it. It shows
  // its JID, the only way to tell two such rows apart.
  const rows = [
    ...GROUPS.map((g) => ({ jid: g.jid, name: g.subject, size: g.size })),
    ...[...chosen].filter((j) => !known.has(j)).map((j) => ({
      jid: j, name: missingGroupLabel(j, (saved.groups ?? []).includes(j) ? 'saved' : 'chosen'), size: null, missing: true,
    })),
  ];
  // A main group can never be ticked here - that is how a test would reach
  // real members. One that is ticked already (the main side took it over
  // later) stays tickable so it can be removed.
  box.innerHTML = rows.length ? rows.map((g) => {
    const role = main[g.jid];
    const on = chosen.has(g.jid);
    return `<label class="check"><input type="checkbox" class="beta-g" value="${esc(g.jid)}"${on ? ' checked' : ''}${role && !on ? ' disabled' : ''}>
        <span>${g.missing ? `<span class="muted">${esc(g.name)}</span>` : esc(g.name)}${g.size != null ? ` <span class="muted small">(${g.size})</span>` : ''}${
          role ? ` <span class="pill warn">${esc(role)}</span>` : ''}${
          g.missing ? `<br><span class="gjid">${esc(g.jid)}</span>` : ''}</span></label>`;
  }).join('') : '<div class="empty">No groups loaded. Connect WhatsApp, then refresh the group list.</div>';
  box.dataset.rendered = '1';

  const sel = $('beta-posts');
  sel.innerHTML = '<option value="">— back into the beta group it was asked in —</option>'
    + GROUPS.map((g) => {
      const role = main[g.jid];
      return `<option value="${esc(g.jid)}"${g.jid === posts ? ' selected' : ''}${role && g.jid !== posts ? ' disabled' : ''}>${
        esc(g.subject)}${role ? ` — ${esc(role)}` : ''}</option>`;
    }).join('');
  if (posts && !known.has(posts)) {
    const kind = posts === (saved.postsGroup ?? '') ? 'saved' : 'chosen';
    sel.insertAdjacentHTML('beforeend', `<option value="${esc(posts)}" selected>${esc(missingGroupLabel(posts, kind))}</option>`);
  }

  const modes = BETA.modes ?? ['off', 'beta', 'on'];
  const feats = BETA.features ?? [];
  $('beta-save').disabled = !betaReady();
  $('beta-features').innerHTML = betaReady()
    ? (feats.length ? feats.map((f) => {
      const want = draft?.features?.[f.key] ?? saved.features?.[f.key] ?? f.mode;
      const mode = modes.includes(want) ? want : 'off';
      return `<div class="item beta-feature">
        <div class="item-top">
          <span class="item-title">${esc(f.label)} <span class="muted small">${esc(BETA_SCOPE_LABEL[f.scope] ?? f.scope ?? '')}</span></span>
          <span class="row gap">${f.code ? `<button class="btn small beta-guide" data-code="${esc(f.code)}" title="A text file for the testers: what to try, and what they should see">Guide ⬇</button>` : ''}
          <select class="beta-mode" data-key="${esc(f.key)}" aria-label="${esc(f.label)} mode">${
            modes.map((m) => `<option value="${esc(m)}"${m === mode ? ' selected' : ''}>${esc(BETA_MODE_LABEL[m] ?? m)}</option>`).join('')}</select></span>
        </div>
        ${f.description ? `<div class="item-sub">${esc(f.description)}</div>` : ''}
      </div>`;
    }).join('') : '<div class="empty">No features are in testing right now.</div>')
    : (BETA.error
      ? `<div class="verdict bad">Could not load the beta settings: ${esc(BETA.error)}. Reload the page to try again.</div>`
      : '<div class="empty">Loading…</div>');

  const warn = (BETA.conflicts ?? []).map((c) => {
    const name = GROUPS.find((g) => g.jid === c.jid)?.subject ?? c.jid;
    return `⚠️ "${esc(name)}" is picked as the ${esc(c.as)} but is also the ${esc(c.role)}. `
      + 'It is treated as a main group until it is removed here.';
  });
  if (!chosen.size) warn.push('<span class="muted">No beta group picked — beta testing is off, and the bot behaves exactly as before.</span>');
  $('beta-warn').innerHTML = warn.join('<br>');
}

$('beta-save')?.addEventListener('click', async () => {
  const form = readBetaForm();
  if (!form || !betaReady()) return;
  // Moving a feature to On is the one step here that reaches real members, so
  // it is confirmed rather than taken on a single click.
  const saved = CONFIG?.beta?.features ?? {};
  const goingOn = Object.entries(form.features).filter(([k, m]) => m === 'on' && saved[k] !== 'on');
  if (goingOn.length && !confirm(`"On" switches ${goingOn.length === 1 ? 'this feature' : 'these features'} on in EVERY group, `
      + 'the main request groups included. Continue?')) return;
  $('beta-note').textContent = 'saving…';
  try {
    // The card always shows the saved groups (a missing one gets its own row),
    // so emptying one here is somebody's choice; the server keeps a stored
    // group a save empties without saying so.
    const was = CONFIG?.beta ?? {};
    const clears = clearGroupsQuery([
      (was.groups ?? []).length && !form.groups.length && 'beta.groups',
      was.postsGroup && !form.postsGroup && 'beta.postsGroup',
    ]);
    CONFIG = await api('PUT', `/config${clears}`, { beta: form });
    await loadBetaSection();
    $('beta-note').innerHTML = '<span style="color:var(--accent)">saved</span>';
  } catch (err) { $('beta-note').innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`; }
});

/**
 * Download the testers' guide: every feature saved on Beta, or one feature by
 * its number. Fetched rather than linked, so "nothing is on Beta" is said
 * here instead of being saved as a file holding an error.
 */
async function downloadBetaGuide(code) {
  $('beta-note').textContent = 'preparing the guide…';
  try {
    const res = await fetch(`/api/beta/guide${code ? `?code=${encodeURIComponent(code)}` : ''}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }
    const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'beta-testers-guide.txt';
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    $('beta-note').textContent = `downloaded ${name}`;
  } catch (err) { $('beta-note').innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`; }
}
$('beta-guide-all')?.addEventListener('click', () => downloadBetaGuide(null));
$('beta-features')?.addEventListener('click', (e) => {
  const b = e.target.closest?.('.beta-guide');
  if (b) downloadBetaGuide(b.dataset.code);
});
/* ----------------------- end beta testing --------------------------- */

/* ---------------------- WhatsApp numbers (accounts) ----------------- */
// The last list fetched, and the background links pushed over /events as
// 'spares'. Kept so a pushed code can be drawn on its row without a refetch.
let ACCOUNTS_LIST = null;
let SPARE_LINKS = {};

async function loadAccounts() {
  const box = $('wa-accounts');
  if (!box) return;
  try {
    const d = await api('GET', '/wa/accounts');
    FRESH.accounts = d.accounts ?? null;
    ACCOUNTS_LIST = d.accounts ?? [];
    if (d.linking) SPARE_LINKS = d.linking;
    refreshFreshInstall();
    renderAccounts();
  } catch (err) { box.innerHTML = `<div class="verdict bad">${esc(err.message)}</div>`; }
}

function renderAccounts() {
  const box = $('wa-accounts');
  if (!box || !ACCOUNTS_LIST) return;
  const all = ACCOUNTS_LIST;
  box.innerHTML = all.map((a) => {
    const link = SPARE_LINKS[a.id] ?? null;
    const live = spareLinkLive(link);
    return `
      <div class="item compact">
        <div class="item-top">
          <span class="item-title">${esc(a.label)}
            ${a.active ? '<span class="pill ok">in use</span>' : ''}
            ${spareLinkPill(a, link)}
          </span>
          <span class="row gap">
            <button class="btn tiny" onclick="editAccount('${esc(a.id)}')">Edit</button>
            ${spareLinkButtons(a, link)}
            ${a.active || live ? '' : `<button class="btn tiny" onclick="switchAccount('${esc(a.id)}')">Switch to this</button>`}
            ${a.active || all.length < 2 ? '' : `<button class="btn tiny danger" onclick="removeAccount('${esc(a.id)}')">Remove</button>`}
          </span>
        </div>
        <div class="item-sub">${a.phoneNumber ? `+${esc(a.phoneNumber)}` : 'no number set'}</div>
        ${spareLinkBox(a, link)}
      </div>`;
  }).join('') || '<div class="empty">No numbers configured.</div>';
}

/** Is a background link for this number still running? */
function spareLinkLive(link) {
  return !!link && ['starting', 'awaiting-qr', 'awaiting-pairing', 'finishing'].includes(link.state);
}

/**
 * The link status on a number's row: linked, not linked, or linking. A spare
 * is linked in the background (POST /wa/accounts/:id/link), so its status is
 * its own and says nothing about the number the bot is running on.
 */
function spareLinkPill(a, link) {
  if (spareLinkLive(link)) return '<span class="pill warn">linking…</span>';
  return a.linked ? '<span class="pill">linked</span>' : '<span class="pill warn">not linked</span>';
}

/**
 * Link / Re-link / Cancel. Never offered for the number in use: that one is
 * linked with Link / Connect under Connection, on the bot's own socket.
 */
function spareLinkButtons(a, link) {
  if (a.active) return '';
  if (spareLinkLive(link)) {
    return `<button class="btn tiny danger" onclick="cancelSpareLink('${esc(a.id)}')">Cancel link</button>`;
  }
  return `<button class="btn tiny" onclick="linkSpare('${esc(a.id)}', ${a.linked ? 'true' : 'false'})">${
    a.linked ? 'Re-link' : 'Link'}</button>`;
}

/** The code itself, or how the last attempt ended. */
function spareLinkBox(a, link) {
  if (!link || a.active) return '';
  if (link.state === 'awaiting-qr' && link.qr) {
    return `
      <div class="pair-box">
        <div class="muted small">Scan with the phone for <b>${esc(a.label)}</b>: WhatsApp → Linked devices → Link a device</div>
        <img src="${link.qr}" alt="QR code for ${esc(a.label)}">
        <div class="muted small" style="margin-top:6px">The bot stays on the number it is using while you do this.
          A fresh code appears on its own when this one expires.</div>
      </div>`;
  }
  if (link.state === 'awaiting-pairing' && link.pairingCode) {
    return `
      <div class="pair-box">
        <div class="muted small">Enter this code on the phone for <b>${esc(a.label)}</b></div>
        <div class="pair-code">${esc(link.pairingCode)}</div>
        <ol class="pair-steps">
          <li>Settings → Linked devices → Link a device</li>
          <li>Tap <strong>Link with phone number instead</strong></li>
          <li>Type the code above</li>
        </ol>
      </div>`;
  }
  if (link.state === 'starting') return '<div class="item-sub small">Getting a code…</div>';
  if (link.state === 'finishing') return '<div class="item-sub small">Scanned — finishing the link…</div>';
  if (link.state === 'linked') {
    return '<div class="item-sub small" style="color:var(--accent)">Linked. It stays disconnected until failover or a switch needs it.</div>';
  }
  if (link.state === 'failed' || link.state === 'expired') {
    return `<div class="item-sub small" style="color:var(--warn)">Link ${link.state === 'expired' ? 'timed out' : 'failed'}: ${
      esc(link.error ?? 'no reason given')}</div>`;
  }
  return '';
}

/** A 'spares' push: redraw the rows, and refetch once a link has finished. */
function onSparesPush(snap) {
  const before = SPARE_LINKS;
  SPARE_LINKS = snap ?? {};
  const finished = Object.values(SPARE_LINKS).some((l) => l.state === 'linked' && before[l.id]?.state !== 'linked');
  if (finished) { loadAccounts(); loadFailover(); } else renderAccounts();
}

window.linkSpare = async (id, relink = false) => {
  if (relink && !confirm('Re-link this number? It links in the background on its own connection; '
    + 'the bot stays on the number it is using. The current saved session is replaced only once the new link works.')) return;
  const pairing = (CONFIG?.whatsapp?.loginMethod === 'pairing');
  $('acct-note').textContent = 'getting a code…';
  try {
    const r = await api('POST', `/wa/accounts/${encodeURIComponent(id)}/link`, { method: pairing ? 'pairing' : 'qr' });
    if (r.linking) onSparesPush(r.linking);
    $('acct-note').textContent = '';
  } catch (err) { $('acct-note').innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`; }
};

window.cancelSpareLink = async (id) => {
  try {
    const r = await api('DELETE', `/wa/accounts/${encodeURIComponent(id)}/link`);
    if (r.linking) onSparesPush(r.linking);
  } catch (err) { $('acct-note').innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`; }
};

/**
 * Which number is in use, decided exactly as listAccounts() decides it on the
 * server: a missing, blank or unknown activeAccount means the first account.
 * This page used `activeAccount ?? 'default'`, but a new install's
 * activeAccount is '' - present, so `??` never fell back. No option was marked
 * "in use", and choosing the number already connected asked to switch to it.
 */
function accountInUseId(wa = {}) {
  const accounts = Array.isArray(wa.accounts) ? wa.accounts.filter(Boolean) : [];
  if (!accounts.length) return 'default';
  return wa.activeAccount && accounts.some((a) => a.id === wa.activeAccount)
    ? wa.activeAccount
    : accounts[0].id;
}

/**
 * The connection dropdown lists the configured numbers rather than being a free
 * text box. A typed number that matched no configured account was the confusing
 * part: it looked like it set which number the bot runs as, but the bot runs as
 * whichever ACCOUNT is active - so the two could silently disagree.
 */
function fillPhoneOptions(wa = {}) {
  const sel = $('f-phone');
  if (!sel) return;
  const accounts = Array.isArray(wa.accounts) && wa.accounts.length
    ? wa.accounts
    : [{ id: 'default', label: wa.phoneNumber ? `+${wa.phoneNumber}` : 'Main number', phoneNumber: wa.phoneNumber ?? '' }];
  const active = accountInUseId(wa);
  const current = String(wa.phoneNumber ?? '');

  const opts = accounts.map((a) => {
    const num = String(a.phoneNumber ?? '');
    const mark = a.id === active ? ' — in use' : '';
    // Mark the chosen option in the markup rather than assigning sel.value
    // afterwards: setting .value silently does nothing if no option matches.
    const sel = num === current ? ' selected' : '';
    return `<option value="${esc(num)}" data-id="${esc(a.id)}"${sel}>${esc(a.label)}${num ? ` (+${esc(num)})` : ''}${mark}</option>`;
  });
  // A number configured before the accounts list existed would otherwise vanish
  // from the dropdown and be silently rewritten on the next save.
  if (current && !accounts.some((a) => String(a.phoneNumber ?? '') === current)) {
    opts.unshift(`<option value="${esc(current)}" data-id="" selected>+${esc(current)} (not in your numbers list)</option>`);
  }
  sel.innerHTML = opts.join('');
  sel.value = current;

  const chosen = accounts.find((a) => a.id === active);
  $('f-phone-note').textContent = chosen
    ? `Switching here changes which number the bot connects as. Add or remove numbers under "WhatsApp numbers" below.`
    : '';
}

// Choosing a different number here switches the bot, rather than just editing a
// field that the next account switch would overwrite anyway.
$('f-phone')?.addEventListener('change', async (e) => {
  const opt = e.target.selectedOptions?.[0];
  const id = opt?.dataset?.id;
  const wa = CONFIG?.whatsapp ?? {};
  if (!id || id === accountInUseId(wa)) return;
  if (!confirm(`Switch the bot to ${opt.textContent.replace(' — in use', '')}? It will disconnect from the current number.`)) {
    $('f-phone').value = wa.phoneNumber ?? '';
    return;
  }
  await window.switchAccount(id, { skipConfirm: true });
  await loadConfig?.();
});

/* --------------------------- audit filters ------------------------- */

let AUDIT_CAT = 'all';
let AUDIT_WHO = '';

/** The category buttons, with a count on each so empty ones are obvious. */
function renderAuditFilters(d) {
  const bar = $('audit-cats');
  if (!bar || !d.categories) return;
  const counts = d.counts ?? {};
  bar.innerHTML = [{ key: 'all', label: 'Everything' }, ...d.categories]
    .filter((c) => c.key === 'all' || counts[c.key])
    .map((c) => `<button class="btn tiny${c.key === AUDIT_CAT ? ' primary' : ''}"
        onclick="setAuditCat('${c.key}')">${esc(c.label)} <span class="muted">${counts[c.key] ?? 0}</span></button>`)
    .join('');

  // Keep the person picker in step with who actually appears in the log.
  const sel = $('audit-who');
  if (sel && sel.options.length <= 1) {
    const who = [...new Set((d.events ?? []).map((e) => e.user).filter(Boolean))].sort();
    for (const u of who) {
      const o = document.createElement('option');
      o.value = u; o.textContent = u;
      sel.appendChild(o);
    }
  }
}

window.setAuditCat = (key) => { AUDIT_CAT = key; loadAudit(); };
$('audit-who')?.addEventListener('change', (e) => { AUDIT_WHO = e.target.value; loadAudit(); });
let auditSearchTimer = null;
$('audit-search')?.addEventListener('input', () => {
  clearTimeout(auditSearchTimer);
  auditSearchTimer = setTimeout(loadAudit, 250);
});

/* ----------------------- rated-R override -------------------------- */

/* The one control here that makes the bot send something it would otherwise
   refuse. Adding is confirmed, and every entry shows who added it, because the
   question afterwards is always "who allowed this one".

   One list, films and TV alike, with nothing to choose: a title covers the
   film or show of exactly that name, with case, spaces and punctuation
   ignored ("Heat" covers "Heat", not "Heat and Dust" - the operator's "Exact
   title only", 2026-09-29), narrowed by a year, a season or an episode typed
   on the end; a pasted Jellyfin link covers exactly its item. An entry sends
   what it covers with no AI check - the operator's "Send it, no AI check"
   (2026-09-29) - so each entry shows what it matches in the library right
   now, which is what it sends (src/core/rating-overrides.js). Nothing typed
   is refused. */

const roPad = (n) => String(n ?? 0).padStart(2, '0');

/* What an entry covers, in words. */
function overrideScope(e) {
  if (e.jellyfinId) return e.covers ?? null;
  const scope = e.episode != null ? `only S${roPad(e.season)}E${roPad(e.episode)} of each show`
    : e.season != null ? `only season ${e.season} of each show` : null;
  // A year on the end may be the end of the name ("Blade Runner 2049"), so
  // an entry with one covers both readings (rating-overrides.js coversName).
  return `every film and show named exactly “${e.title}”`
    + (e.year ? `, from ${e.year}, or named “${e.title} ${e.year}”` : '')
    + (scope ? ` — ${scope} (no films)` : '');
}

/* The "matches now" line of one entry, from GET /rating-overrides/matches or
   an add's answer. Information only. `films` false: the film library is not
   Jellyfin, so no film was looked at - "matches nothing" would then be wrong
   about an entry for a film, which it covers in requests all the same. */
function overrideMatchesText(m, films = true) {
  if (!m) return '';
  const notListed = ' (films not listed: the film library is not Jellyfin)';
  if (!m.count) return films ? 'Matches nothing in the library right now.' : `Matches no show in the library right now${notListed}.`;
  const items = (m.items ?? []).map((i) => `${i.type === 'tv' ? '📺' : '🎬'} ${i.name}${i.year ? ` (${i.year})` : ''}`);
  const more = m.count > items.length ? ` and ${m.count - items.length} more` : '';
  return `Matches now: ${items.join(' · ')}${more}${films ? '' : notListed}`;
}

async function loadOverrideMatches(box) {
  let d = null;
  try { d = await api('GET', '/rating-overrides/matches'); } catch { return; }
  for (const el of box.querySelectorAll('.ro-matches')) {
    const key = el.getAttribute('data-key');
    const text = d?.checked === false
      ? `Couldn't check the library right now (${d.reason ?? 'no answer'}).`
      : overrideMatchesText(d?.matches?.[key], d?.films !== false);
    if (!text) continue;
    el.textContent = text;
    el.classList.remove('hidden');
  }
}

async function loadOverrides() {
  const box = $('ro-list');
  if (!box) return;
  try {
    const d = await api('GET', '/rating-overrides');
    const list = d.overrides ?? [];
    if (!list.length) { box.innerHTML = '<div class="empty">Nothing is overridden.</div>'; return; }
    box.innerHTML = list.map((e) => {
      const link = !!e.jellyfinId;
      // addedBy was once saved as the whole session user; show its name.
      const by = e.addedBy && typeof e.addedBy === 'object' ? e.addedBy.username : e.addedBy;
      const name = e.title
        ? `${esc(e.title)}${e.season != null ? ` <span class="muted">${
          e.episode != null ? `S${roPad(e.season)}E${roPad(e.episode)}` : `season ${e.season}`}</span>` : ''}`
        : `Jellyfin item ${esc(String(e.jellyfinId).slice(0, 8))}…`;
      const icon = link ? (e.kind === 'tv' ? '📺 ' : e.kind === 'film' ? '🎬 ' : '🔗 ') : '';
      const scope = overrideScope(e);
      return `
      <div class="item compact">
        <div class="item-top">
          <span class="item-title">${icon}${name}${e.year ? ` <span class="muted">(${e.year})</span>` : ''}</span>
          <span class="row gap">
            ${link ? `<span class="tag">by link${e.kind ? ` · ${e.kind === 'tv' ? 'TV' : 'film'}` : ''}</span>` : '<span class="tag">by title</span>'}
            <button class="btn tiny danger" onclick="removeOverride('${esc(e.key)}')">Remove</button>
          </span>
        </div>
        ${scope ? `<div class="item-sub">Covers: ${esc(scope)}</div>` : ''}
        <div class="item-sub">${by ? `added by ${esc(by)}` : 'added'}${
          e.addedAt ? ` · ${fmtDateTime(e.addedAt)}` : ''}${
          e.note ? ` · ${esc(e.note)}` : ''}</div>
        <div class="item-sub ro-matches hidden" data-key="${esc(e.key)}"></div>
      </div>`;
    }).join('');
    loadOverrideMatches(box);
  } catch (err) { box.innerHTML = `<div class="verdict bad">${esc(err.message)}</div>`; }
}

window.removeOverride = async (key) => {
  await api('DELETE', `/rating-overrides/${encodeURIComponent(key)}`);
  loadOverrides();
  toast('Override removed');
};

$('ro-add')?.addEventListener('click', async () => {
  const input = $('ro-input').value.trim();
  const note = $('ro-note').value.trim();
  const msg = $('ro-note-msg');
  if (!input) { msg.innerHTML = '<span style="color:var(--danger)">Enter a title or a Jellyfin link.</span>'; return; }
  // Deliberate friction. An entry sends what it covers with no AI check,
  // and a post to a group that shouldn't have it does not come back.
  if (!confirm(`Send "${input}" despite its rating?\n\n`
    + 'A title covers only the film or show of exactly that name, with case, spaces and punctuation ignored '
    + '("Heat" covers "Heat", not "Heat and Dust"). Everything it covers is sent whatever its '
    + 'rating, with no AI nudity check - check what it matches in the list once it is added.\n\n'
    + 'This is recorded in the audit log under your name.')) return;
  try {
    msg.innerHTML = '<span class="muted">adding…</span>';
    const r = await api('POST', '/rating-overrides', { input, note });
    $('ro-input').value = ''; $('ro-note').value = '';
    const matched = r?.matches ? overrideMatchesText(r.matches, r.matches.films !== false)
      : r?.matchesUnknown ? `Couldn't check the library right now (${r.matchesUnknown}).` : '';
    msg.innerHTML = `<span style="color:var(--accent)">added</span>${matched ? ` — ${esc(matched)}` : ''}`;
    loadOverrides();
  } catch (err) { msg.innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`; }
});

/* --------------------- not in the library -------------------------- */

/* Requests that died at the library lookup and nowhere else. Separate from the
   portal audit log above it, which records what ADMINS did; this records what
   the bot was asked and could not answer. The two sit together because they
   are looked at together - something went wrong, and this is where you find
   out what. */

let MISS_FILTER = 'all';

const MISS_FILTERS = [
  { key: 'all', label: 'Everything' },
  { key: 'movie', label: '🎬 Movies' },
  { key: 'tv', label: '📺 TV' },
  { key: 'open', label: 'Still missing' },
  { key: 'resolved', label: 'Turned up later' },
];

async function loadMisses() {
  const box = $('miss-list');
  if (!box) return;
  try {
    const params = new URLSearchParams();
    if (MISS_FILTER === 'movie' || MISS_FILTER === 'tv') params.set('kind', MISS_FILTER);
    if (MISS_FILTER === 'open') params.set('resolved', '0');
    const q = $('miss-search')?.value.trim();
    if (q) params.set('q', q);

    const d = await api('GET', `/library-misses?${params}`);
    let misses = d.misses ?? [];
    // "Turned up later" is the interesting one and has no server-side flag of
    // its own - it is the complement of the "still missing" filter.
    if (MISS_FILTER === 'resolved') misses = misses.filter((m) => m.resolved);

    renderMissFilters(d.counts ?? {});
    $('miss-count').textContent = (d.counts ?? {}).all ?? 0;

    if (!misses.length) {
      box.innerHTML = `<div class="empty">${q || MISS_FILTER !== 'all'
        ? 'Nothing matches that filter.'
        : 'Nothing has been refused for not being in the library.'}</div>`;
      return;
    }
    box.innerHTML = misses.map(renderMiss).join('');
  } catch (err) {
    box.innerHTML = `<div class="verdict bad">${esc(err.message)}</div>`;
  }
}

function renderMiss(m) {
  const what = m.kind === 'tv'
    ? `${m.title}${m.season != null ? ` S${String(m.season).padStart(2, '0')}` : ''}`
      + `${m.episode != null ? `E${String(m.episode).padStart(2, '0')}` : ''}`
    : `${m.title}${m.year ? ` (${m.year})` : ''}`;

  // What was TYPED next to what it was UNDERSTOOD as. When those two disagree
  // the disagreement is usually the whole bug - the bot went looking for
  // something nobody asked for.
  const typed = m.request && m.request.trim().toLowerCase() !== String(m.title).trim().toLowerCase()
    ? `<div class="item-sub">asked as “${esc(m.request)}”</div>`
    : '';

  const why = (m.reason && m.reason !== 'not-in-library')
    ? `<span class="tag">${esc(m.reason === 'empty-season' ? 'season missing' : 'episode missing')}</span>`
    : '';

  // The evidence. This is the reason the list is worth having: it says what the
  // lookup actually did, so "it is right there" can be settled rather than
  // argued about.
  const diag = (m.diagnostics ?? []).length
    ? `<div class="item-sub" style="margin-top:4px">${(m.diagnostics ?? [])
        .map((d) => `<div>· ${esc(d)}</div>`).join('')}</div>`
    : '';

  return `
    <div class="item compact">
      <div class="item-top">
        <span class="item-title">${esc(what)}</span>
        <span class="row gap">
          <span class="tag">${m.kind === 'tv' ? '📺' : '🎬'}</span>
          ${why}
          <span class="tag">${m.count}x asked</span>
          ${m.resolved ? '<span class="tag done">turned up later</span>' : ''}
        </span>
      </div>
      ${typed}
      <div class="item-sub">
        ${fmtDateTime(m.lastAt)}
        ${m.requesters?.length ? ` · ${esc(m.requesters.slice(0, 3).map(phoneOut).join(', '))}` : ''}
        ${m.detail ? ` · ${esc(m.detail)}` : ''}
      </div>
      ${diag}
    </div>`;
}

function renderMissFilters(counts) {
  const bar = $('miss-cats');
  if (!bar) return;
  const n = (k) => (k === 'all' ? counts.all : k === 'open'
    ? Math.max(0, (counts.all ?? 0) - (counts.resolved ?? 0)) : counts[k]) ?? 0;
  bar.innerHTML = MISS_FILTERS
    .map((f) => `<button class="btn tiny${f.key === MISS_FILTER ? ' primary' : ''}"
        onclick="setMissFilter('${f.key}')">${esc(f.label)} <span class="muted">${n(f.key)}</span></button>`)
    .join('');
}

window.setMissFilter = (key) => { MISS_FILTER = key; loadMisses(); };
$('btn-miss-refresh')?.addEventListener('click', loadMisses);
$('btn-miss-clear')?.addEventListener('click', async () => {
  if (!confirm('Clear the not-in-library list?\n\nThis is the record of what the bot could not find — including anything it got wrong.')) return;
  await api('DELETE', '/library-misses');
  loadMisses();
  toast('Not-in-library list cleared');
});
let missSearchTimer = null;
$('miss-search')?.addEventListener('input', () => {
  clearTimeout(missSearchTimer);
  missSearchTimer = setTimeout(loadMisses, 250);
});

/* ------------------------ queue from a link ------------------------ */

/* In the Test tab this only LOOKS. Queueing lives on the queue, next to the
   other way of adding something, because that is where you go to add work. */
$('btn-jf-check')?.addEventListener('click', async () => {
  const url = $('jf-url').value.trim();
  if (!url) return;
  $('jf-result').textContent = 'looking it up…';
  try {
    const r = await api('POST', '/test/jellyfin-url', { url });
    // Amber for a title its rating blocks that the AI check could clear:
    // whether it goes out is the check's answer, which a lookup cannot know
    // in advance. A title on the bypass list is green - it is sent.
    const tone = r.verdict === 'check' ? 'warn' : r.wouldSend ? 'good' : 'bad';
    $('jf-result').innerHTML = `
      <div class="verdict ${tone}">
        ${esc(r.title)}${r.year ? ` (${r.year})` : ''}
        ${r.rated ? `· ${esc(r.rated)}` : '· no rating set'}
        ${r.onDisk ? '· readable on this server' : '· would be downloaded'}
      </div>
      <div class="small muted" style="margin-top:6px">${esc(r.why)}</div>`;
  } catch (err) {
    $('jf-result').innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`;
  }
});

/* And this one actually queues it, from the Dashboard queue. */
$('btn-q-jf')?.addEventListener('click', async () => {
  const url = $('q-jf-url').value.trim();
  if (!url) return;
  $('manual-note').textContent = 'looking it up…';
  try {
    const member = await memberKeyFrom('q-member');
    const r = await api('POST', '/queue/from-url', { url, member });
    $('q-member').value = '';
    $('manual-note').innerHTML = `<span style="color:var(--accent)">queued ${esc(r.title)}`
      + `${r.year ? ` (${r.year})` : ''}${r.rated ? ` — rated ${esc(r.rated)}` : ''}</span>`;
    // Clear it: a pasted URL usually carries an api_key, and leaving it in the
    // field puts it on screen for anyone walking past.
    $('q-jf-url').value = '';
    // No reload: the queue is pushed over the stream, and this line called a
    // loadQueue() that does not exist. `?.()` does not save an undeclared
    // name, so the queued film was reported as "loadQueue is not defined".
  } catch (err) {
    $('manual-note').innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`;
  }
});

/* ---------------------- queue a public link ----------------------- */

/* The operator (2026-09-30): a film that is free to download publicly should
   not need to be in Jellyfin. The server checks the link (public addresses
   only, a video, under the size cap) before anything is queued, so the
   answer here is either what was queued, with its size, or why not.

   And a YouTube page, since 2026-10-11, when one pasted here was refused as
   "a web page (text/html)": the link is looked at as it is pasted (POST
   /queue/public-link/inspect), a page through yt-dlp, and the line under it
   says what it is - "from YouTube via yt-dlp - 1 h 32 min" - and the page's
   title fills the name when none is typed. */
let plLooked = { url: null, result: null };
let plTimer = null;

/** What the line under the link says about it. */
function describePublicLink(r) {
  if (r?.kind === 'page') {
    return `from ${r.site} via yt-dlp${r.length ? ` - ${r.length}` : ''}${r.size ? ` · about ${fmtBytes(r.size)}` : ''}`
      + `${r.title ? ` · “${r.title}”` : ''}`;
  }
  return `a video file${r?.size ? ` - ${fmtBytes(r.size)}` : ' - its size not given by the server'}`;
}

/** Look at the link in the box; the answer, or null. The same link is looked at once. */
async function inspectPublicLink() {
  const url = $('pl-url').value.trim();
  const about = $('pl-about');
  if (!/^https?:\/\/\S+$/i.test(url)) {
    about.textContent = '';
    plLooked = { url: null, result: null };
    return null;
  }
  if (plLooked.url === url) return plLooked.result;
  about.textContent = 'looking at the link…';
  try {
    const r = await api('POST', '/queue/public-link/inspect', { url });
    // Pasted over meanwhile: this answer is about another link.
    if ($('pl-url').value.trim() !== url) return null;
    plLooked = { url, result: r };
    about.innerHTML = `<span style="color:var(--accent)">${esc(describePublicLink(r))}</span>`;
    if (r.title && !$('pl-title').value.trim()) $('pl-title').value = r.title;
    return r;
  } catch (err) {
    if ($('pl-url').value.trim() === url) {
      plLooked = { url, result: null };
      about.innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`;
    }
    return null;
  }
}
$('pl-url')?.addEventListener('input', () => {
  clearTimeout(plTimer);
  plTimer = setTimeout(() => { inspectPublicLink(); }, 700);
});
$('pl-url')?.addEventListener('change', () => {
  clearTimeout(plTimer);
  inspectPublicLink();
});

$('btn-pl-queue')?.addEventListener('click', async () => {
  const url = $('pl-url').value.trim();
  const year = $('pl-year').value.trim();
  const note = $('pl-note');
  if (!url) {
    note.innerHTML = '<span style="color:var(--danger)">Paste the download link.</span>';
    return;
  }
  const btn = $('btn-pl-queue');
  if (!$('pl-title').value.trim()) {
    // A page names itself: looked at first, and the name shown before the
    // film is posted under it - the admin presses Queue once more.
    btn.disabled = true;
    note.textContent = 'looking at the link…';
    const r = await inspectPublicLink();
    btn.disabled = false;
    note.innerHTML = r?.title && $('pl-title').value.trim()
      ? '<span style="color:var(--accent)">Named from the page - check the name, then press Queue.</span>'
      : '<span style="color:var(--danger)">Give the film its title.</span>';
    return;
  }
  const title = $('pl-title').value.trim();
  btn.disabled = true;
  note.textContent = 'checking the link…';
  try {
    const member = await memberKeyFrom('pl-member');
    const r = await api('POST', '/queue/public-link', { url, title, year, member });
    $('pl-member').value = '';
    note.innerHTML = `<span style="color:var(--accent)">Queued: ${esc(r.title)}${r.year ? ` (${r.year})` : ''}`
      + (r.via
        ? ` - from ${esc(r.site)} via yt-dlp${r.length ? ` - ${esc(r.length)}` : ''}`
        : `${r.size ? ` - ${esc(fmtBytes(r.size))}` : ' - size not given by the server'}`)
      + '</span>';
    // Cleared, as Queue link's field is: a link can carry a token in its query.
    $('pl-url').value = '';
    $('pl-title').value = '';
    $('pl-year').value = '';
    $('pl-about').textContent = '';
    plLooked = { url: null, result: null };
  } catch (err) {
    note.innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`;
  } finally {
    btn.disabled = false;
  }
});

/* ----------------------- yt-dlp and its cookies ----------------------- */

/* Settings -> Library & files -> File handling: whether yt-dlp is on this
   box, and the cookies it signs in to YouTube with (media/yt-dlp-cookies.js).
   The cookies are uploaded and never come back: the server says only that
   they are set, when and by whom, how many, whether youtube.com is among
   them, and when they expire. Read when Settings is opened. */
function describeYtDlp(d) {
  const tool = !d.installed
    ? 'yt-dlp is not installed on this box: node tools/routines.mjs --fix installs it.'
    : `yt-dlp${d.version ? ` ${d.version}` : ''} is installed${d.deno ? ', with deno' : ', without deno: YouTube formats may be missing'}`
      + `${d.lastCheck?.at ? `; last update check ${fmtDateTime(d.lastCheck.at)}${d.lastCheck.ok ? '' : ` (failed: ${d.lastCheck.error ?? '?'})`}` : ''}.`;
  const c = d.cookies ?? {};
  let cookies;
  if (!c.set) cookies = 'Cookies: none uploaded - yt-dlp fetches as a visitor.';
  else if (c.problem) cookies = `Cookies: set, but they cannot be read: ${c.problem}`;
  else {
    cookies = `Cookies: set, uploaded ${c.uploadedAt ? fmtDateTime(c.uploadedAt) : 'at an unknown time'} by ${c.by ?? '?'}, `
      + `${c.count} cookie${c.count === 1 ? '' : 's'}, youtube.com present: ${c.youtube ? 'yes' : 'no'}`
      + `${c.youtube ? `, signed in: ${c.signedIn ? 'yes' : 'no'}` : ''}`
      + `${c.expires ? `, ${c.expired ? 'expired' : 'expires'} ${fmtDateTime(c.expires)}` : ''}.`;
  }
  return { tool, cookies, warn: !d.installed || (c.set && (c.expired || !c.youtube || !c.signedIn || !!c.problem)) };
}

async function loadYtDlp() {
  const box = $('ytdlp-status');
  if (!box) return;
  try {
    const d = describeYtDlp(await api('GET', '/yt-dlp'));
    box.innerHTML = `${esc(d.tool)}<br><span${d.warn ? ' style="color:var(--danger)"' : ''}>${esc(d.cookies)}</span>`;
  } catch (err) {
    if (!err.handled) box.textContent = `Could not read it: ${err.message}`;
  }
}
$('tabs').addEventListener('click', (e) => {
  if (e.target.closest('.tab')?.dataset.tab === 'settings' && CURRENT_USER) loadYtDlp();
});

$('btn-ytdlp-cookies-upload')?.addEventListener('click', async () => {
  const input = $('ytdlp-cookies-file');
  const file = input.files?.[0];
  const note = $('ytdlp-note');
  if (!file) {
    note.innerHTML = '<span style="color:var(--danger)">Choose the cookies.txt file first.</span>';
    return;
  }
  if (file.size > 512 * 1024) {
    note.innerHTML = '<span style="color:var(--danger)">That file is too big to be a cookies.txt.</span>';
    return;
  }
  note.textContent = 'uploading…';
  try {
    const r = await api('PUT', '/yt-dlp/cookies', { text: await file.text() });
    const c = r.cookies;
    note.innerHTML = `<span style="color:var(--accent)">Saved: ${c.count} cookie${c.count === 1 ? '' : 's'}`
      + `${c.youtube ? (c.signedIn ? ', signed in to YouTube' : ', for youtube.com but not signed in - export them again while signed in') : ', none of them for youtube.com'}.</span>`;
  } catch (err) {
    note.innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`;
  } finally {
    // Not left in the page: it is a login.
    input.value = '';
    loadYtDlp();
  }
});

$('btn-ytdlp-cookies-remove')?.addEventListener('click', async () => {
  if (!confirm('Remove the cookies? yt-dlp then fetches as a visitor, and YouTube may ask it to sign in.')) return;
  const note = $('ytdlp-note');
  try {
    await api('DELETE', '/yt-dlp/cookies');
    note.textContent = 'Removed.';
  } catch (err) {
    note.innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`;
  }
  loadYtDlp();
});

/* ------------------------------ wanted ----------------------------- */
// The Wanted card - its list, Mark resolved, notes, Refresh and Clear - is
// src/web/public/wanted.js, loaded after this file (window.__wanted).

$('btn-em-digest')?.addEventListener('click', async () => {
  $('em-result').textContent = 'sending…';
  try {
    await api('POST', '/digest/send');
    $('em-result').innerHTML = '<span style="color:var(--accent)">daily summary sent</span>';
  } catch (err) { $('em-result').innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`; }
});

/* ---------------------------- catalogue ---------------------------- */

let CATALOGUE = [];

async function loadCatalogue() {
  const box = $('cat-list');
  if (!box) return;
  try {
    const d = await api('GET', '/catalogue');
    CATALOGUE = d.clean ?? [];
    let status = d.at
      ? `${CATALOGUE.length} clean of ${d.scanned} scanned`
        + `${d.total != null ? ` (the server holds ${d.total})` : ''} · ${d.skipped?.blocked ?? 0} blocked by rating, `
        + `${d.skipped?.unrated ?? 0} unrated · built ${fmtDateTime(d.at)}`
      : 'never built';
    // A list from before the full-library walk read at most 10,000 films and
    // recorded no server size; it looks complete and is not.
    if (d.at && d.total == null) status += ' · built before the full-library walk, so it may be missing films — rebuild it';
    $('cat-status').textContent = status;
    renderCatalogueOutcome(d);
    renderCatalogue();
    if (d.running) followCatalogueRebuild();
  } catch (err) { box.innerHTML = `<div class="verdict bad">${esc(err.message)}</div>`; }
}

/**
 * Say what happened to the last rebuild that was not published. The list shown
 * is still the previous one, which may itself be old or short - so this states
 * the refusal, and never implies the kept list is the better one.
 */
function renderCatalogueOutcome(d) {
  const note = $('cat-outcome');
  if (!note) return;
  const li = d.lastIncomplete;
  if (!li || d.running || (d.at && li.at < d.at)) { note.innerHTML = ''; return; }
  note.innerHTML = `<div class="verdict bad">The rebuild on ${esc(fmtDateTime(li.at))} was not published: `
    + `${esc(li.reason ?? 'it did not read the whole library')}.`
    + (li.shrink ? ' <button class="btn small" id="btn-cat-publish-anyway">Rebuild and publish anyway</button>' : '')
    + '</div>';
  $('btn-cat-publish-anyway')?.addEventListener('click', () => startCatalogueRebuild({ allowShrink: true }));
}

let CATALOGUE_TIMER = null;

/**
 * Follow a rebuild running on the server. The panel is push-only, but a walk
 * of the library changes nothing the stream carries until it ends, so this is
 * a local timer - only while a rebuild is running.
 */
function followCatalogueRebuild() {
  if (CATALOGUE_TIMER) return;
  const btn = $('btn-cat-refresh');
  if (btn) btn.disabled = true;
  CATALOGUE_TIMER = setInterval(async () => {
    try {
      const d = await api('GET', '/catalogue');
      if (d.running) {
        const p = d.progress ?? {};
        $('cat-status').textContent = `walking the library — ${p.scanned ?? 0}`
          + `${p.total != null ? ` of ${p.total}` : ''} read, ${p.clean ?? 0} clean`
          + `${p.windows > 1 ? ` (window ${p.windows})` : ''}…`;
        return;
      }
      clearInterval(CATALOGUE_TIMER);
      CATALOGUE_TIMER = null;
      if (btn) btn.disabled = false;
      const published = d.at && (!d.lastIncomplete || d.lastIncomplete.at < d.at);
      if (published) toast(`${(d.clean ?? []).length} clean titles`);
      await loadCatalogue();
    } catch { /* a missed poll is retried on the next tick */ }
  }, 2000);
}

async function startCatalogueRebuild({ allowShrink = false } = {}) {
  const btn = $('btn-cat-refresh');
  if (btn) btn.disabled = true;
  $('cat-status').textContent = 'walking the library — this takes a minute or two…';
  const note = $('cat-outcome');
  if (note) note.innerHTML = '';
  try {
    await api('POST', '/catalogue/refresh', allowShrink ? { allowShrink: true } : {});
    followCatalogueRebuild();
  } catch (err) {
    if (btn) btn.disabled = false;
    $('cat-status').innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`;
  }
}

function renderCatalogue() {
  const q = ($('cat-search')?.value ?? '').trim().toLowerCase();
  const rows = q ? CATALOGUE.filter((m) => m.title.toLowerCase().includes(q)) : CATALOGUE;
  const box = $('cat-list');
  if (!rows.length) {
    box.innerHTML = `<div class="empty">${CATALOGUE.length ? 'Nothing matches that.' : 'Not built yet.'}</div>`;
    return;
  }
  // A long library makes a very long page; show a slice and say so.
  const shown = rows.slice(0, 500);
  box.innerHTML = shown.map((m) => `
    <div class="item compact">
      <div class="item-top">
        <span class="item-title">${esc(m.title)}${m.year ? ` <span class="muted">(${m.year})</span>` : ''}</span>
        <span class="tag">${esc(m.rated)}</span>
      </div>
    </div>`).join('')
    + (rows.length > shown.length
      ? `<div class="empty">…and ${rows.length - shown.length} more — filter to narrow it down</div>` : '');
}

$('cat-search')?.addEventListener('input', renderCatalogue);

$('btn-cat-refresh')?.addEventListener('click', () => startCatalogueRebuild());

/* ----------------------------- failover ---------------------------- */

let FO_ORDER = [];          // the order being edited, before it is saved

async function loadFailover() {
  const box = $('fo-list');
  if (!box) return;
  try {
    const d = await api('GET', '/wa/failover');
    if (!d.available) { box.innerHTML = '<div class="empty">Failover is not available.</div>'; return; }
    FO_ORDER = d.accounts.map((a) => a.id);
    $('fo-enabled').checked = !!d.enabled;
    const f = (CONFIG?.whatsapp?.failover) ?? {};
    $('fo-attempts').value = f.failAfterAttempts ?? 4;
    $('fo-holddown').value = Math.round((f.holdDownMs ?? 600000) / 60000);
    $('fo-cooldown').value = Math.round((f.cooldownMs ?? 900000) / 60000);
    renderFailover(d.accounts);
  } catch (err) { box.innerHTML = `<div class="verdict bad">${esc(err.message)}</div>`; }
}

function renderFailover(accounts) {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  $('fo-list').innerHTML = FO_ORDER.map((id, i) => {
    const a = byId.get(id);
    if (!a) return '';
    // Two separate facts, both needed, so neither hides the other: can it
    // connect at all, and can it administer the groups once connected?
    const cov = a.coverage;
    const link = a.linking
      ? '<span class="pill warn">linking…</span>'
      : a.needsRelink
      ? '<span class="pill bad">logged out — needs re-linking</span>'
      : a.linked
        ? '<span class="pill ok">linked</span>'
        : '<span class="pill warn">not linked — cannot take over</span>';
    const reach = !cov
      ? ''
      : cov.gaps.length
        ? `<span class="pill warn">covers ${cov.covered}/${cov.total} groups</span>`
        : `<span class="pill ok">covers all ${cov.total} groups</span>`;
    const ready = `${link}${reach}`;

    const gaps = (cov?.gaps ?? []).map((g) => `${esc(g.subject)} (${esc(g.role)} — ${esc(g.why)})`).join(', ');
    return `
      <div class="item compact">
        <div class="item-top">
          <span class="item-title">${i + 1}. ${esc(a.label)}
            ${a.active ? '<span class="pill ok">in use</span>' : ''}
            ${ready}
          </span>
          <span class="row gap">
            <button class="btn tiny" onclick="editAccount('${esc(a.id)}')">Edit</button>
            <button class="btn tiny" ${i === 0 ? 'disabled' : ''} onclick="moveFailover('${esc(a.id)}',-1)">▲</button>
            <button class="btn tiny" ${i === FO_ORDER.length - 1 ? 'disabled' : ''} onclick="moveFailover('${esc(a.id)}',1)">▼</button>
          </span>
        </div>
        <div class="item-sub">${a.phoneNumber ? `+${esc(a.phoneNumber)}` : 'no number set'}${
          a.unhealthyReason ? ` · <span style="color:var(--warn)">${esc(a.unhealthyReason)}</span>` : ''}</div>
        ${gaps ? `<div class="item-sub small" style="color:var(--warn)">missing: ${gaps}</div>` : ''}
        ${a.linked ? '' : '<div class="item-sub small" style="color:var(--warn)">Press Link on it under WhatsApp numbers before failover can use it — the bot keeps running while you do.</div>'}
      </div>`;
  }).join('') || '<div class="empty">No numbers configured.</div>';
}

window.moveFailover = (id, dir) => {
  const i = FO_ORDER.indexOf(id);
  const j = i + dir;
  if (i === -1 || j < 0 || j >= FO_ORDER.length) return;
  [FO_ORDER[i], FO_ORDER[j]] = [FO_ORDER[j], FO_ORDER[i]];
  $('fo-note').textContent = 'unsaved — press Save failover';
  api('GET', '/wa/failover').then((d) => renderFailover(d.accounts)).catch(() => {});
};

$('fo-save')?.addEventListener('click', async () => {
  $('fo-note').textContent = 'saving…';
  try {
    await api('PUT', '/wa/failover', {
      enabled: $('fo-enabled').checked,
      order: FO_ORDER,
      failAfterAttempts: Number($('fo-attempts').value),
      holdDownMs: Number($('fo-holddown').value) * 60000,
      cooldownMs: Number($('fo-cooldown').value) * 60000,
    });
    $('fo-note').innerHTML = '<span style="color:var(--accent)">saved</span>';
    await loadConfig?.();
    loadFailover();
  } catch (err) { $('fo-note').innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`; }
});

/**
 * Rename a number or correct its digits. The saved session is keyed by the
 * account id, not the number, so neither edit unlinks anything - worth saying
 * out loud, because "changing the phone number" sounds like it would.
 */
window.editAccount = async (id) => {
  let list = [];
  try { list = (await api('GET', '/wa/accounts')).accounts ?? []; } catch { /* fall through */ }
  const a = list.find((x) => x.id === id);
  if (!a) return;

  const label = prompt('Name for this number', a.label ?? '');
  if (label === null) return;
  const num = prompt(
    `Phone number for "${label}" — with + and the country code, e.g. +15551234567.

`
    + 'This does not unlink it; the saved session stays. It is the number a pairing code would be sent to.',
    a.phoneNumber ? `+${a.phoneNumber}` : '');
  if (num === null) return;

  try {
    await api('PUT', `/wa/accounts/${encodeURIComponent(id)}`, {
      label, phoneNumber: String(num).replace(/[^0-9]/g, ''),
    });
    toast('Number updated');
    await loadConfig?.();
    loadAccounts(); loadFailover();
  } catch (err) { alert(err.message); }
};

window.switchAccount = async (id, { skipConfirm = false } = {}) => {
  if (!skipConfirm && !confirm('Switch the bot to this number? It will disconnect from the current one.')) return;
  $('acct-note').textContent = 'switching…';
  try {
    const r = await api('POST', `/wa/accounts/${encodeURIComponent(id)}/activate`);
    $('acct-note').innerHTML = r.linked
      ? '<span style="color:var(--accent)">switched — reconnecting on that number</span>'
      : '<span style="color:var(--warn)">switched — that number has never been linked, use Link below to pair it</span>';
    // No status fetch: the bot stopping and starting, and the active number
    // changing, each push a status over the event stream. The `loadStatus?.()`
    // that stood here named a function that never existed, and `?.` does not
    // save an undeclared name - it threw, and the catch below replaced
    // "switched" with "loadStatus is not defined".
    loadAccounts(); loadFailover();
    // The switch rewrote the pairing number on the server. Left stale, the
    // checklist and the Connection dropdown went on naming the old number.
    if (await rereadConfig()) fillPhoneOptions(CONFIG.whatsapp ?? {});
  } catch (err) { $('acct-note').innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`; }
};

window.removeAccount = async (id) => {
  if (!confirm('Remove this number from the list? Its saved session is kept, so you can add it back without re-linking.')) return;
  try { await api('DELETE', `/wa/accounts/${encodeURIComponent(id)}`); loadAccounts(); }
  catch (err) { $('acct-note').innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`; }
};

$('acct-add')?.addEventListener('click', async () => {
  const label = $('acct-label').value.trim();
  const phoneNumber = $('acct-number').value.replace(/[^0-9]/g, '');
  if (!label && !phoneNumber) return toast('Give the number a name or a phone number', true);
  $('acct-note').textContent = 'adding…';
  try {
    await api('POST', '/wa/accounts', { label, phoneNumber });
    $('acct-label').value = ''; $('acct-number').value = '';
    $('acct-note').innerHTML = '<span style="color:var(--accent)">added — press Link on it to pair it; the bot keeps running on its current number</span>';
    loadAccounts();
  } catch (err) { $('acct-note').innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`; }
});

/* --------------------------- direct links --------------------------- */
function renderDlGroups() {
  if (!CONFIG) return;
  renderGroupChecks($('dl-groups'), 'dl-g', CONFIG.directLinks?.groups);
}

function loadDirectLinks() {
  const d = CONFIG?.directLinks ?? {};
  if (!$('f-dl-enabled')) return;
  $('f-dl-enabled').checked = !!d.enabled;
  $('f-dl-moviecmd').value = d.movieCommand ?? '#request-movie';
  $('f-dl-tvcmd').value = d.tvCommand ?? '#request-tv';
  // The share key box is not filled here: it belongs to the API keys section,
  // and fillForm() fills it from the same config this reads.
  $('f-dl-baseurl').value = d.publicBaseUrl ?? '';
  $('f-dl-ratings').value = (d.restrictedRatings ?? []).join(', ');
  $('f-dl-disclaimer').value = d.disclaimer ?? '';
  renderDlGroups();
}

$('dl-save')?.addEventListener('click', async () => {
  $('dl-note').textContent = 'saving…';
  try {
    const clears = clearGroupsQuery([clearedGroupChecks($('dl-groups'), 'dl-g') && 'directLinks.groups']);
    CONFIG = await api('PUT', `/config${clears}`, { directLinks: {
      enabled: $('f-dl-enabled').checked,
      groups: groupChecksValue($('dl-groups'), 'dl-g'),
      movieCommand: $('f-dl-moviecmd').value.trim() || '#request-movie',
      tvCommand: $('f-dl-tvcmd').value.trim() || '#request-tv',
      // apiKey is left out: the share key box lives in the API keys section
      // now and is saved there. Sending it from here as well would mean this
      // card's Save decided the key, whichever one was pressed last.
      publicBaseUrl: $('f-dl-baseurl').value.trim(),
      restrictedRatings: $('f-dl-ratings').value.split(',').map((x) => x.trim()).filter(Boolean),
      disclaimer: $('f-dl-disclaimer').value,
    }});
    const d = CONFIG.directLinks ?? {};
    const warn = d.enabled && !d.apiKey
      ? ' <span style="color:var(--warn)">— add a share key, or the links will not play</span>'
      : (d.enabled && !d.groups?.length ? ' <span style="color:var(--warn)">— pick at least one group</span>' : '');
    $('dl-note').innerHTML = `<span style="color:var(--accent)">saved</span>${warn}`;
    loadDirectLinks();
    loadBetaSection({ fresh: false });          // which groups are main may have changed
  } catch (err) { $('dl-note').innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`; }
});

/* the link queue is separate from the media one, and shown with its section */
async function loadLinkQueue() {
  const box = $('dl-queue');
  if (!box) return;
  try {
    const q = await api('GET', '/queue/links');
    const rows = [...(q.active ?? []), ...(q.pending ?? [])];
    $('dl-queue-count').textContent = rows.length;
    box.innerHTML = rows.length ? rows.map((e) => `
      <div class="item compact">
        <div class="item-top">
          <span class="item-title">${esc(e.label ?? '(request)')}</span>
          <span class="muted small">${esc(e.state ?? '')}</span>
        </div>
        ${e.meta?.requester ? `<div class="item-sub">from ${esc(phoneOut(e.meta.requester))}</div>` : ''}
      </div>`).join('') : '<div class="empty">Nothing waiting.</div>';
  } catch { /* the section may be off */ }
}
