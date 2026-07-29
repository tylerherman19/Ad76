/**
 * Refresh scheduling.
 *
 * Two deployments, two mechanisms, one observable property: every visitor sees
 * the same countdown.
 *
 * SERVER DEPLOYMENT (`npm start`)
 *   The backend owns `nextScheduledFetchAt` as shared state and ships it to
 *   every client. One upstream request per interval no matter how many people
 *   are watching, and a force refresh moves the shared timestamp for everyone.
 *
 * STATIC DEPLOYMENT (GitHub Pages)
 *   There is no server to hold shared state, so the schedule is instead a pure
 *   function of the wall clock: refreshes land on absolute UTC boundaries of
 *   the current interval. Every tab, on every device, independently computes
 *   the *same* next-refresh instant — not a timer that starts when the page
 *   happened to load. That reproduces the "same countdown for everyone"
 *   property without shared state.
 *
 *   What it cannot reproduce: a force refresh that resets the countdown for
 *   other people, and a debounce that protects the county from a click burst
 *   across visitors. Both require shared state by definition. In the static
 *   build the force button refreshes only the clicking browser, and the UI says
 *   so rather than implying otherwise.
 */

/** Which cadence applies, given how many wards have reported. */
export function phaseFor(wardsReported, polling) {
  return wardsReported >= polling.reportingThreshold ? 'active' : 'idle';
}

export function intervalFor(phase, polling) {
  return phase === 'active' ? polling.activeIntervalMs : polling.idleIntervalMs;
}

/**
 * Next refresh instant on an absolute UTC boundary.
 *
 * Anchoring to the epoch rather than to page-load time is the whole trick: two
 * browsers opened 40 seconds apart still agree on when the next refresh is.
 *
 * @returns {number} epoch ms
 */
export function nextBoundary(nowMs, intervalMs) {
  return Math.floor(nowMs / intervalMs) * intervalMs + intervalMs;
}

/**
 * Build the schedule block for the static build, shaped exactly like the one
 * the server sends so the frontend renders both identically.
 */
export function staticScheduleInfo({ nowMs, wardsReported, polling, lastSuccessAt, lastFailureAt, consecutiveFailures, lastError, lastForceRefreshAt }) {
  const phase = phaseFor(wardsReported, polling);
  const intervalMs = intervalFor(phase, polling);
  return {
    serverTime: new Date(nowMs).toISOString(),
    lastFetchAttemptAt: lastSuccessAt ?? lastFailureAt ?? null,
    lastSuccessAt: lastSuccessAt ?? null,
    lastFailureAt: lastFailureAt ?? null,
    nextScheduledFetchAt: new Date(nextBoundary(nowMs, intervalMs)).toISOString(),
    intervalMs,
    phase,
    stale: !lastSuccessAt || nowMs - Date.parse(lastSuccessAt) > polling.staleAfterMs,
    staleAfterMs: polling.staleAfterMs,
    consecutiveFailures: consecutiveFailures ?? 0,
    lastError: lastError ?? null,
    forceRefreshCooldownMs: polling.forceRefreshCooldownMs,
    lastForceRefreshAt: lastForceRefreshAt ?? null,
    // Tells the UI to describe the countdown and force button honestly.
    sharedStateAvailable: false,
  };
}
