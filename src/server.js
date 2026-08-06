import path from 'node:path';
import express from 'express';
import compression from 'compression';
import config, { ROOT } from './config.js';
import log from './logger.js';
import { wardsGeoJson, loadWards } from './geo/wards.js';
import { clientColorConfig } from './colors.js';
import { start, stop, forceRefresh, getPayload, getState, scheduleInfo, isStale, getTrend } from './scheduler.js';

/**
 * Election-night safety net: an uncaught exception or unhandled rejection
 * anywhere (a stray promise, a third-party bug) would otherwise kill the
 * process with no supervisor to bring it back. Logging and continuing keeps
 * the map on screen; the alternative (crash) is strictly worse for a live
 * results page than a logged, survived error.
 */
process.on('uncaughtException', (err) => {
  log.error('process.uncaught_exception', { message: err.message, stack: err.stack });
});
process.on('unhandledRejection', (reason) => {
  log.error('process.unhandled_rejection', {
    message: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

const app = express();
app.disable('x-powered-by');
app.use(compression());

// ---------------------------------------------------------------- static ---
app.use(express.static(path.join(ROOT, 'public'), { maxAge: '5m', index: 'index.html' }));
// Leaflet is served from node_modules rather than a CDN so the page has no
// third-party runtime dependency.
app.use('/vendor/leaflet', express.static(path.join(ROOT, 'node_modules', 'leaflet', 'dist'), { maxAge: '1d' }));
// The browser imports the same shared/ modules the backend uses, so the static
// GitHub Pages build and this server run identical parsing, matching and
// colouring code.
app.use('/shared', express.static(path.join(ROOT, 'shared'), { maxAge: '5m' }));

// ------------------------------------------------------------------- api ---

/** Ward geometry. Served independently of results so the map draws immediately. */
app.get('/api/wards.geojson', (req, res) => {
  try {
    res.set('cache-control', 'public, max-age=3600');
    res.json(wardsGeoJson());
  } catch (err) {
    log.error('api.wards_failed', { message: err.message });
    res.status(500).json({ error: err.message });
  }
});

/** The cached, parsed results plus the shared schedule. */
app.get('/api/results', (req, res) => {
  const payload = getPayload();
  res.set('cache-control', 'no-store');
  if (!payload) {
    return res.status(503).json({ error: 'No results cached yet', schedule: scheduleInfo() });
  }
  res.json({
    ...payload,
    schedule: scheduleInfo(),
    display: clientColorConfig(),
    trend: getTrend(),
  });
});

/**
 * Force refresh. Debounced server-side, so a burst of clicks produces one
 * request to the county. Returns the updated shared schedule either way.
 */
app.post('/api/refresh', async (req, res) => {
  try {
    const result = await forceRefresh();
    res.status(result.accepted ? 200 : 429).json({ ...result, schedule: scheduleInfo() });
  } catch (err) {
    log.error('api.force_refresh_failed', { message: err.message });
    res.status(500).json({ error: err.message, schedule: scheduleInfo() });
  }
});

/** Health/status: enough to sanity-check the pipeline without reading logs. */
app.get('/api/health', (req, res) => {
  const s = getState();
  const payload = getPayload();
  let wardsInLayer = null;
  try {
    wardsInLayer = loadWards().wards.length;
  } catch {
    /* reported via matching below */
  }

  const fresh = Boolean(s.lastSuccessAt) && !isStale() && s.consecutiveFailures === 0;
  const status = fresh ? 'ok' : s.lastSuccessAt ? 'degraded' : 'starting';

  // The HTTP status reports whether THIS PROCESS can serve, not whether the
  // county is currently answering. Fly and Render both restart / de-pool a
  // machine whose health check fails, and this endpoint is wired to both. A
  // county-side outage longer than staleAfterMs would otherwise take the map
  // down at exactly the moment it matters — while the process is fine, still
  // serving the last good numbers, and already flagging them stale in the UI.
  // Restarting also throws away the in-memory trend history and does nothing to
  // bring the county back.
  //
  // 503 is reserved for "cannot serve a page at all": no payload has ever been
  // built. `?strict=1` restores the freshness-sensitive status for a human or
  // an alerting probe that genuinely wants it.
  const strict = req.query.strict === '1';
  const serviceable = Boolean(payload);
  res.status(strict ? (fresh ? 200 : 503) : serviceable ? 200 : 503).json({
    status,
    fresh,
    serviceable,
    stale: isStale(),
    schedule: scheduleInfo(),
    election: {
      electionId: config.election.electionId,
      configured: Boolean(config.election.electionId),
      raceName: payload?.election?.raceName ?? null,
      raceId: payload?.election?.raceId ?? null,
      awaitingResults: Boolean(payload?.awaitingResults),
      awaitingReason: payload?.awaitingReason ?? null,
    },
    source: {
      mode: config.source.mode,
      activeMode: payload?.source?.mode ?? null,
      fellBackFrom: payload?.source?.fellBackFrom ?? null,
      countyUpdatedAt: payload?.source?.countyUpdatedAt ?? null,
    },
    counters: {
      fetches: s.fetchCount,
      successes: s.successCount,
      failures: s.failureCount,
      consecutiveFailures: s.consecutiveFailures,
      forceRefreshesAccepted: s.forceRefreshesAccepted,
      forceRefreshesDebounced: s.forceRefreshesDebounced,
    },
    reporting: payload?.reporting ?? null,
    matching: payload
      ? {
          reportingUnits: payload.matching.reportingUnits,
          matchedUnits: payload.matching.matchedUnits,
          unmatchedUnits: payload.matching.unmatchedUnits,
          partialUnits: payload.matching.partialUnits,
          wardsInLayer: payload.matching.wardsInLayer,
          wardsCovered: payload.matching.wardsCovered,
          wardsWithoutReportingUnit: payload.matching.wardsWithoutReportingUnit,
          unmatched: payload.matching.unmatched,
          wardsWithoutResults: payload.matching.wardsWithoutResults,
        }
      : { wardsInLayer },
    logCounts: log.counts(),
  });
});

/** Recent log tail, for checking scrape/match problems mid-election-night. */
app.get('/api/logs', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 400);
  const level = ['info', 'warn', 'error'].includes(req.query.level) ? req.query.level : null;
  res.set('cache-control', 'no-store');
  res.json({ entries: log.tail(limit, level), counts: log.counts() });
});

// ----------------------------------------------------------------- boot ----
const server = app.listen(config.server.port, config.server.host, async () => {
  log.info('server.listening', { host: config.server.host, port: config.server.port });
  try {
    loadWards();
  } catch (err) {
    log.error('server.wards_missing', { message: err.message });
  }
  await start();
});

function shutdown(signal) {
  log.info('server.shutdown', { signal });
  stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export default app;
