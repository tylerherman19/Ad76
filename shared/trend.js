/**
 * District-wide momentum snapshots.
 *
 * PURE MODULE — used by both the Node scheduler (state.history, in-process)
 * and the static browser build (StaticPipeline, per-tab). Each successful
 * fetch adds one point so the frontend can draw "how has the margin moved
 * tonight" without either deployment inventing its own shape.
 *
 * A point is skipped if it would look identical to the last one plotted
 * (same wards reported, same leader, same margin) — idle-phase polling
 * would otherwise fill the buffer with flat repeats before the county posts
 * anything.
 */

export const MAX_TREND_POINTS = 2000;

/** @returns {object|null} null when there is nothing meaningful to plot yet. */
export function trendPointFrom(payload, ts) {
  if (!payload || payload.awaitingResults) return null;
  const leader = payload.summary?.leader;
  return {
    ts,
    wardsReported: payload.reporting?.wardsReported ?? 0,
    wardsTotal: payload.reporting?.wardsTotal ?? 0,
    totalVotes: payload.summary?.totalVotes ?? null,
    leaderName: leader && !leader.tied ? leader.name : null,
    leaderColor: leader && !leader.tied ? leader.color : null,
    tied: Boolean(leader?.tied),
    marginPct: leader && !leader.tied ? leader.margin * 100 : leader?.tied ? 0 : null,
  };
}

/** Returns a new array (does not mutate `history`). */
export function pushTrendPoint(history, point, maxPoints = MAX_TREND_POINTS) {
  if (!point) return history;
  const last = history[history.length - 1];
  if (
    last &&
    last.wardsReported === point.wardsReported &&
    last.leaderName === point.leaderName &&
    last.marginPct === point.marginPct
  ) {
    return history;
  }
  const next = [...history, point];
  return next.length > maxPoints ? next.slice(next.length - maxPoints) : next;
}
