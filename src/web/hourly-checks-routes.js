/**
 * The Logs tab's "Hourly checks" card: the runs of the hourly check, and each
 * run's report.
 *
 * The check runs from cron, outside the bot, and leaves its record in
 * data/hourly-debug/ (src/core/hourly-checks.js). These routes only read it.
 * What they return is scrubbed once more on the way out - every saved secret
 * and any phone number - because the report was written partly by an AI
 * session that read the logs, and a scrub that happened when it was written
 * cannot know about a key saved in Settings since. Then, and only then, a
 * member the report names by a masked number gets the full number back from
 * the run's key (readNumbers, expandNumbers): the panel is the operator's.
 */
import fs from 'node:fs';
import path from 'node:path';
import { SECRET_PATHS, getPath } from '../config/schema.js';
import {
  readRuns, readReport, panelRun, checkStatus, sanitize, hourlyCheckSummary, readNumbers, expandNumbers,
} from '../core/hourly-checks.js';

const secretsOf = (cfg) => SECRET_PATHS
  .map((p) => getPath(cfg, p))
  .filter((v) => typeof v === 'string' && v.length >= 6);

/**
 * The hourly check for GET /diagnostics, which feeds the fresh-install
 * checklist: installed, token, last run - and whether this box was told to do
 * without it (`node tools/routines.mjs --skip hourly-check`, which writes
 * data/routines-skip.json; src/core/routines.js). Files only, all of them the
 * bot's own: the panel gains no way to look at the crontab or the token.
 */
export function hourlyCheckDiagnostics(configStore, { now = Date.now() } = {}) {
  // No data directory, nothing to read - and /diagnostics must still answer.
  if (!configStore?.dataDir) return null;
  let skipped = null;
  try {
    const skips = JSON.parse(fs.readFileSync(path.join(configStore.dataDir, 'routines-skip.json'), 'utf8'));
    const s = skips?.['hourly-check'];
    if (s && typeof s === 'object') skipped = String(s.reason || 'skipped on this machine');
  } catch { /* no skips recorded */ }
  return hourlyCheckSummary(configStore.dataDir, { now, secrets: secretsOf(configStore.get()), skipped });
}

export function mountHourlyCheckRoutes(router, { configStore, guard }) {
  router.get('/hourly-checks', guard, (req, res) => {
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 48));
    const runs = readRuns(configStore.dataDir);
    const secrets = secretsOf(configStore.get());
    res.json({
      status: checkStatus(runs),
      runs: runs.slice(0, limit).map((r) => panelRun(r, secrets, readNumbers(configStore.dataDir, r.id))),
    });
  });

  router.get('/hourly-checks/:id/report', guard, (req, res) => {
    const text = readReport(configStore.dataDir, req.params.id);
    if (text == null) return res.status(404).json({ error: 'No report for that run' });
    res.set('Content-Disposition', `inline; filename="hourly-check-${req.params.id}.md"`);
    // Scrubbed first, so a secret stays masked, and its secrets masked again
    // after the numbers go in; a run from before the key was kept has none,
    // and reads as it always did.
    const secrets = secretsOf(configStore.get());
    const clean = sanitize(text, secrets);
    res.type('text/plain; charset=utf-8').send(expandNumbers(clean, readNumbers(configStore.dataDir, req.params.id), secrets));
  });
}
