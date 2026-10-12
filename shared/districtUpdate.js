/** Track changes to this race independently of the county-wide publication clock.
 * The county supplies no district timestamp: these times are observations, not
 * a claimed upstream publication time. Static mode starts a new history per tab.
 */
function fingerprint(payload) {
  const candidates = (rows) => (rows ?? []).map((c) => [c.name, c.votes ?? null])
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify({
    reporting: payload.reporting,
    totals: candidates(payload.summary?.candidates),
    units: (payload.units ?? []).map((u) => [u.id, u.reported, candidates(u.candidates)])
      .sort(([a], [b]) => a.localeCompare(b)),
  });
}

export function trackDistrictUpdate(payload, previous, observedAt = new Date().toISOString()) {
  const sameRace = previous?.election?.electionId === payload.election?.electionId &&
    previous?.election?.electionDate === payload.election?.electionDate;
  let districtUpdatedAt = null;
  let districtUpdateKind = null;
  if (!payload.awaitingResults && (payload.reporting?.wardsReported > 0 || (sameRace && previous?.source?.districtUpdatedAt))) {
    if (sameRace && previous?.source?.districtUpdatedAt) {
      const changed = fingerprint(payload) !== fingerprint(previous);
      districtUpdatedAt = changed ? observedAt : previous.source.districtUpdatedAt;
      districtUpdateKind = changed ? 'changed' : previous.source.districtUpdateKind;
    } else {
      districtUpdatedAt = observedAt;
      districtUpdateKind = 'first-observed';
    }
  }
  return { ...payload, source: { ...payload.source, districtUpdatedAt, districtUpdateKind } };
}
