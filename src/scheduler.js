/**
 * The refresh schedule lives here, in the backend, as shared state.
 *
 * Every visitor sees the same countdown because `nextScheduledFetchAt` is a
 * single server-side timestamp served to all clients — not a timer each tab
 * starts when it happens to load. A force refresh moves that shared timestamp,
 * so it resets the countdown for everyone, not just the tab that clicked.
 *
 * Cadence (all configurable — config/default.json → polling, or env vars):
 *   idleIntervalMs   while fewer than `reportingThreshold` wards have reported
 *   activeIntervalMs from the moment that threshold is crossed
 *
 * A failed scrape retries with exponential backoff inside the attempt, and if
 * it still fails the loop schedules the next attempt normally. It never throws
 * out of the loop and never blocks the following cycle.
 */

import fs from 'node:fs';
import path from 'node:path';
import config, { ROOT } from './config.js';
import log from './logger.js';
import fetchResults from './sources/index.js';
import { buildPayload, buildPlaceholderPayload as makePlaceholder } from './normalize.js';
import { trendPointFrom, pushTrendPoint, MAX_TREND_POINTS } from '../shared/trend.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Last-good-payload snapshot, written to disk after every successful fetch so
 * a process restart (crash, redeploy, host reboot) mid-election-night does not
 * blank the map for the gap before the next fetch succeeds. Loaded once at
 * startup and immediately treated as stale — it is never mistaken for a fresh
 * result, only shown until a real fetch replaces it.
 */
const SNAPSHOT_FILE = path.join(ROOT, '.cache', 'last-payload.json');

function loadSnapshot() {
  try {
    if (!fs.existsSync(SNAPSHOT_FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
    return raw?.payload ? raw : null;
  } catch (err) {
    log.warn('scheduler.snapshot_load_failed', { message: err.message });
    return null;
  }
}

function saveSnapshot(payload, lastSuccessAt) {
  try {
    fs.mkdirSync(path.dirname(SNAPSHOT_FILE), { recursive: true });
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify({ savedAt: new Date().toISOString(), lastSuccessAt, payload }));
  } catch (err) {
    log.warn('scheduler.snapshot_save_failed', { message: err.message });
  }
}

/** Shared, process-wide state. */
const state = {
  payload: null,
  lastFetchAttemptAt: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastError: null,
  consecutiveFailures: 0,
  nextScheduledFetchAt: null,
  currentIntervalMs: null,
  phase: 'idle', // 'idle' | 'active'
  fetchCount: 0,
  successCount: 0,
  failureCount: 0,
  lastForceRefreshAt: null,
  forceRefreshesAccepted: 0,
  forceRefreshesDebounced: 0,
  running: false,
  history: [],
};

let timer = null;
let inFlight = null;

/**
 * Pre-results placeholder: real ward geometry, real candidate names, and every
 * ward explicitly "not reporting". No invented vote numbers anywhere — every
 * votes/percent field is null. Implementation is shared with the static build.
 */
export const buildPlaceholderPayload = (reason) => makePlaceholder(reason);

/** How many wards have reported — drives the idle→active interval switch. */
function wardsReporting(payload) {
  if (!payload || payload.awaitingResults) return 0;
  return payload.reporting?.wardsReported ?? 0;
}

function computeIntervalMs() {
  const { idleIntervalMs, activeIntervalMs, reportingThreshold } = config.polling;
  const reported = wardsReporting(state.payload);
  const phase = reported >= reportingThreshold ? 'active' : 'idle';
  if (phase !== state.phase) {
    log.info('scheduler.phase_change', { from: state.phase, to: phase, wardsReported: reported });
    state.phase = phase;
  }
  return phase === 'active' ? activeIntervalMs : idleIntervalMs;
}

/** One fetch, with bounded retry/backoff. Resolves to true on success. */
async function attemptFetch(trigger) {
  const { maxAttempts, baseDelayMs, maxDelayMs } = config.polling.retry;
  state.lastFetchAttemptAt = new Date().toISOString();
  state.fetchCount += 1;

  if (!config.election.electionId) {
    state.payload = buildPlaceholderPayload(
      'No electionId configured yet. Dane County has not published the August 11 2026 primary; ' +
        'set ELECTION_ID (or election.electionId in config) once /election-dates lists it.',
    );
    log.info('scheduler.awaiting_election_id', { trigger });
    return true;
  }

  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const raw = await fetchResults({
        electionId: config.election.electionId,
        raceNamePattern: config.election.raceNamePattern,
        raceNumber: config.election.raceNumber,
      });
      state.payload = buildPayload(raw);
      state.lastSuccessAt = new Date().toISOString();
      state.consecutiveFailures = 0;
      state.successCount += 1;
      state.lastError = null;
      state.history = pushTrendPoint(state.history, trendPointFrom(state.payload, Date.now()), MAX_TREND_POINTS);
      saveSnapshot(state.payload, state.lastSuccessAt);
      log.info('scrape.success', {
        trigger,
        attempt,
        mode: raw.sourceMode,
        fellBackFrom: raw.fellBackFrom ?? null,
        unitsReported: state.payload.reporting.unitsReported,
        unitsTotal: state.payload.reporting.unitsTotal,
        unmatched: state.payload.matching.unmatched.length,
      });
      return true;
    } catch (err) {
      lastErr = err;
      const isLast = attempt === maxAttempts;
      log.warn('scrape.attempt_failed', {
        trigger,
        attempt,
        maxAttempts,
        message: err.message,
        status: err.status ?? null,
        hint: err.hint ?? null,
      });
      if (!isLast) {
        const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
        await sleep(delay);
      }
    }
  }

  state.lastFailureAt = new Date().toISOString();
  state.consecutiveFailures += 1;
  state.failureCount += 1;
  state.lastError = { message: lastErr?.message ?? 'unknown error', status: lastErr?.status ?? null, hint: lastErr?.hint ?? null };
  log.error('scrape.failed', { trigger, consecutiveFailures: state.consecutiveFailures, ...state.lastError });

  // First-ever fetch failing still needs a renderable page: show real structure,
  // flagged as awaiting results, rather than an empty screen.
  if (!state.payload) {
    state.payload = buildPlaceholderPayload(`Could not reach the county results source: ${state.lastError.message}`);
  }
  return false;
}

function scheduleNext(fromMs = Date.now()) {
  if (!state.running) return;
  if (timer) clearTimeout(timer);
  const interval = computeIntervalMs();
  state.currentIntervalMs = interval;
  const nextAt = fromMs + interval;
  state.nextScheduledFetchAt = new Date(nextAt).toISOString();
  timer = setTimeout(() => {
    runCycle('schedule').catch((err) => log.error('scheduler.cycle_threw', { message: err.message }));
  }, Math.max(0, nextAt - Date.now()));
  timer.unref?.();
}

/** Runs a fetch, coalescing concurrent callers onto one in-flight request. */
async function runCycle(trigger) {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      await attemptFetch(trigger);
    } finally {
      inFlight = null;
      // Always schedule the next cycle, success or failure.
      scheduleNext(Date.now());
    }
  })();
  return inFlight;
}

export async function start() {
  if (state.running) return;
  state.running = true;

  const snap = loadSnapshot();
  if (snap) {
    state.payload = snap.payload;
    state.lastSuccessAt = snap.lastSuccessAt ?? snap.savedAt;
    log.info('scheduler.snapshot_restored', { savedAt: snap.savedAt, lastSuccessAt: state.lastSuccessAt });
  }

  log.info('scheduler.start', {
    idleIntervalMs: config.polling.idleIntervalMs,
    activeIntervalMs: config.polling.activeIntervalMs,
    reportingThreshold: config.polling.reportingThreshold,
    forceRefreshCooldownMs: config.polling.forceRefreshCooldownMs,
    electionId: config.election.electionId,
    sourceMode: config.source.mode,
  });
  await runCycle('startup');
}

export function stop() {
  state.running = false;
  if (timer) clearTimeout(timer);
  timer = null;
}

/**
 * Force refresh, debounced process-wide.
 *
 * The cooldown is on the *server*, so a burst of clicks from many visitors
 * results in one request to the county. Debounced callers are told when the
 * accepted refresh happened rather than being silently ignored.
 */
export async function forceRefresh() {
  const cooldown = config.polling.forceRefreshCooldownMs;
  const now = Date.now();
  const last = state.lastForceRefreshAt ? Date.parse(state.lastForceRefreshAt) : null;

  if (last !== null && now - last < cooldown) {
    state.forceRefreshesDebounced += 1;
    const retryAfterMs = cooldown - (now - last);
    log.info('force_refresh.debounced', { retryAfterMs });
    return { accepted: false, debounced: true, retryAfterMs, lastForceRefreshAt: state.lastForceRefreshAt };
  }

  state.lastForceRefreshAt = new Date(now).toISOString();
  state.forceRefreshesAccepted += 1;
  log.info('force_refresh.accepted', {});

  if (timer) clearTimeout(timer);
  await runCycle('force');
  return { accepted: true, debounced: false, lastForceRefreshAt: state.lastForceRefreshAt };
}

export function isStale() {
  const { staleAfterMs } = config.polling;
  if (!state.lastSuccessAt) return true;
  return Date.now() - Date.parse(state.lastSuccessAt) > staleAfterMs;
}

/** Schedule/freshness block sent with every payload so all tabs agree. */
export function scheduleInfo() {
  return {
    serverTime: new Date().toISOString(),
    lastFetchAttemptAt: state.lastFetchAttemptAt,
    lastSuccessAt: state.lastSuccessAt,
    lastFailureAt: state.lastFailureAt,
    nextScheduledFetchAt: state.nextScheduledFetchAt,
    intervalMs: state.currentIntervalMs,
    phase: state.phase,
    stale: isStale(),
    staleAfterMs: config.polling.staleAfterMs,
    consecutiveFailures: state.consecutiveFailures,
    lastError: state.lastError,
    forceRefreshCooldownMs: config.polling.forceRefreshCooldownMs,
    lastForceRefreshAt: state.lastForceRefreshAt,
    // This deployment holds the schedule as real shared state, so a force
    // refresh resets the countdown for every viewer and the cooldown protects
    // the county from a burst across visitors. The static build cannot do
    // either, and says so.
    sharedStateAvailable: true,
  };
}

export function getState() {
  return state;
}

export function getPayload() {
  return state.payload;
}

/** District-wide momentum snapshots, oldest first, for the frontend sparkline. */
export function getTrend() {
  return state.history;
}
