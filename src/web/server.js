import express from 'express';
import session from 'express-session';
import path from 'node:path';
import { idleTimeout, effectiveIdleMinutes } from './idle.js';
import { fileURLToPath } from 'node:url';
import log from '../util/logger.js';
import { createApiRouter } from './api.js';
import { FileSessionStore } from './session-store.js';
import { mustChangePassword } from './auth.js';
import { wantedEvents } from '../core/wanted.js';

const logger = log.scope('web');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createServer({ configStore, bot, queue, linkQueue, pluginManager, stateStore, fileLogger, alerts, lockScheduler, failover = null, contentHealth = null, spareLinker = null, requestPause = null, wantedRecheck = null, discordWatch = null, arrivals = null }) {
  const cfg = configStore.get();
  const app = express();

  app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));

  app.use(session({
    name: 'wabot.sid',
    secret: cfg.web.sessionSecret,
    // Persisted, so a restart does not log the operator out and leave the
    // UI reporting "unauthorized" against whatever they were doing.
    store: new FileSessionStore({
      file: path.join(configStore.dataDir, 'sessions.json'),
    }),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 7 * 24 * 3600 * 1000,
      // secure:true would break plain-http access on the LAN, which is the
      // documented deployment. Put a TLS proxy in front for anything public.
      secure: false,
    },
  }));

  // Sign out an admin who has walked away. Mounted before the API so every
  // route is covered, and before /events so a stale stream is cut too. The
  // limit is resolved per request from the signed-in admin's own account, so a
  // timeout the super-admin changes reaches sessions that are already open.
  app.use(idleTimeout((user) => effectiveIdleMinutes(configStore.get().web, user?.username)));

  app.use('/api', createApiRouter({ configStore, bot, queue, linkQueue, pluginManager, stateStore, fileLogger, alerts, lockScheduler, failover, contentHealth, spareLinker, requestPause, wantedRecheck, discordWatch, arrivals }));

  /* Server-sent events: live status, queue, and log lines for the dashboard. */
  app.get('/events', (req, res) => {
    if (!req.session?.user) return res.status(401).end();
    // Queue, status and log lines are the panel; a temporary password has to
    // be changed before any of it (see mustChangePassword in auth.js).
    if (mustChangePassword(configStore, req.session.user.username)) return res.status(403).end();

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');

    const send = (event, data) => {
      try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
      catch { /* client vanished */ }
    };

    send('status', bot.status());
    send('queue', queue.snapshot());
    // Whether the nudity check is actually running. Pushed because the panel
    // does not poll, and a check that has quietly stopped is exactly the thing
    // nobody would think to go and look for.
    if (contentHealth) send('contentcheck', contentHealth.snapshot());
    // A spare being linked in the background shows its code on its own row,
    // and the page does not poll, so the code and every change of state has
    // to be pushed.
    if (spareLinker) send('spares', spareLinker.snapshot());
    // Whether requests are paused, since when, by whom and how many are held:
    // the dashboard's banner and its Pause requests button. Pushed on every
    // change - a request held, one run on resume - as the page does not poll.
    if (requestPause) send('requestpause', requestPause.snapshot());

    const onState = (s) => send('status', s);
    const onGroups = (g) => send('groups', g);
    const onGroupEvent = (ev) => send('groupevent', ev);
    const onQueue = () => send('queue', queue.snapshot());
    const onLog = (line) => send('log', line);
    const onContentCheck = (snap) => send('contentcheck', snap);
    const onSpares = (snap) => send('spares', snap);
    const onRequestPause = (snap) => send('requestpause', snap);
    // The wanted list changed: a film resolved or reopened, a note added or
    // deleted, a request, the recheck. Only that it changed, and which entry;
    // an open Wanted card reloads itself, so one admin's "Mark resolved" is
    // on every other admin's screen (the operator, 2026-10-11: "so other
    // admins ... know").
    const onWanted = (ev) => send('wanted', ev);

    // The panel does not poll; it lives entirely off this stream. Pushing
    // status only on a STATE change meant an account rename, or any switch
    // that left the bot in the same state, never reached the page - so the
    // dashboard kept naming the number you had just moved away from.
    const onConfig = (cfg) => {
      const key = JSON.stringify({
        active: cfg.whatsapp?.activeAccount,
        accounts: (cfg.whatsapp?.accounts ?? []).map((a) => `${a.id}:${a.label}:${a.phoneNumber}`),
      });
      if (key === lastAccountKey) return;      // only when the numbers change
      lastAccountKey = key;
      send('status', bot.status());
    };
    let lastAccountKey = null;
    const offConfig = configStore.onChange(onConfig);

    bot.on('state', onState);
    bot.on('groups', onGroups);
    bot.on('group-event', onGroupEvent);
    queue.on('added', onQueue);
    queue.on('updated', onQueue);
    queue.on('progress', onQueue);
    queue.on('state', onQueue);
    log.on('line', onLog);
    contentHealth?.on('change', onContentCheck);
    spareLinker?.on('change', onSpares);
    requestPause?.on('change', onRequestPause);
    wantedEvents.on('change', onWanted);

    const ping = setInterval(() => send('ping', Date.now()), 25_000);

    req.on('close', () => {
      clearInterval(ping);
      bot.off('state', onState);
      bot.off('groups', onGroups);
      bot.off('group-event', onGroupEvent);
      queue.off('added', onQueue);
      queue.off('updated', onQueue);
      queue.off('progress', onQueue);
      queue.off('state', onQueue);
      log.off('line', onLog);
      contentHealth?.off('change', onContentCheck);
      spareLinker?.off('change', onSpares);
      requestPause?.off('change', onRequestPause);
      wantedEvents.off('change', onWanted);
      // A config listener that outlives its stream leaks: every reconnecting
      // browser tab would add another and none would ever be removed.
      offConfig?.();
    });
  });

  // Revalidate assets on every load. During rapid iteration a cached broken
  // app.js would otherwise blank the page until a manual hard-refresh; ETags
  // make the browser check freshness each time (a 304 when unchanged is cheap).
  app.use(express.static(path.join(__dirname, 'public'), {
    index: 'index.html',
    etag: true,
    lastModified: true,
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
  }));

  // SPA fallback so a refresh on any path still loads the UI.
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  app.use((err, req, res, next) => {
    // A body express.json() cannot read is refused before any route runs, and
    // its message quotes the start of the body. On the AI providers card that
    // body can hold an API key typed for a Test and never saved: sent with a
    // stray character, the key's first characters came back in the response
    // and went into an error line, which emails an alert. It is the client's
    // mistake, so it is a 400 and a warning, without the body's text.
    if (typeof err?.type === 'string' && err.status >= 400 && err.status < 500) {
      const what = err.type === 'entity.parse.failed' ? 'was not valid JSON'
        : err.type === 'entity.too.large' ? 'is too large'
          : 'could not be read';
      logger.warn(`refused ${req.method} ${req.path}: its body ${what} (${err.type})`);
      return res.status(err.status).json({ error: `The request body ${what}` });
    }
    logger.error(`unhandled: ${err.message}`);
    res.status(500).json({ error: err.message });
  });

  return app;
}

export function startServer(app, configStore) {
  const { port, bindAddress } = configStore.get().web;
  return new Promise((resolve, reject) => {
    const server = app.listen(port, bindAddress, () => {
      logger.info(`control panel listening on http://${bindAddress}:${port}`);
      if (bindAddress === '0.0.0.0') {
        logger.warn('bound to all interfaces - reachable from your LAN. Do not port-forward this without HTTPS in front.');
      }
      resolve(server);
    });
    server.on('error', reject);
  });
}
