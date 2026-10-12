import test from 'node:test';
import assert from 'node:assert/strict';
import { trackDistrictUpdate } from '../shared/districtUpdate.js';
const firstAt = '2026-11-04T02:00:00.000Z';
const nextAt = '2026-11-04T02:01:00.000Z';
const payload = () => ({
  election: { electionId: '200', electionDate: '2026-11-03' },
  source: { countyUpdatedAt: firstAt },
  reporting: { wardsReported: 1, wardsTotal: 30 },
  summary: { candidates: [{ name: 'Dina', votes: 90 }, { name: 'Nina', votes: 10 }] },
  units: [{ id: 'ward16', reported: true, candidates: [{ name: 'Dina', votes: 90 }, { name: 'Nina', votes: 10 }] }],
});
test('first district read is explicitly an observation, not a claimed publication time', () => {
  const result = trackDistrictUpdate(payload(), null, nextAt);
  assert.equal(result.source.districtUpdatedAt, nextAt);
  assert.equal(result.source.countyUpdatedAt, firstAt);
  assert.equal(result.source.districtUpdateKind, 'first-observed');
});
test('county-only updates and reordering never advance the district clock', () => {
  const previous = trackDistrictUpdate(payload(), null, firstAt);
  const current = payload(); current.source.countyUpdatedAt = nextAt;
  current.units[0].candidates.reverse(); current.summary.candidates.reverse();
  const result = trackDistrictUpdate(current, previous, nextAt);
  assert.equal(result.source.districtUpdatedAt, firstAt);
  assert.equal(result.source.countyUpdatedAt, nextAt);
});
test('ward vote corrections advance district clock even when district totals are unchanged', () => {
  const previous = trackDistrictUpdate(payload(), null, firstAt);
  const current = payload(); current.units[0].candidates[0].votes = 89;
  const result = trackDistrictUpdate(current, previous, nextAt);
  assert.equal(result.source.districtUpdatedAt, nextAt);
  assert.equal(result.source.districtUpdateKind, 'changed');
});
test('reporting corrections back to zero are still district changes', () => {
  const previous = trackDistrictUpdate(payload(), null, firstAt);
  const current = payload(); current.reporting.wardsReported = 0;
  current.units[0].reported = false;
  assert.equal(trackDistrictUpdate(current, previous, nextAt).source.districtUpdatedAt, nextAt);
});
test('no district update time is invented before reporting', () => {
  const current = payload(); current.reporting.wardsReported = 0;
  assert.equal(trackDistrictUpdate(current, null, firstAt).source.districtUpdatedAt, null);
});
test('another election starts a fresh observation history', () => {
  const previous = trackDistrictUpdate(payload(), null, firstAt);
  const current = payload(); current.election.electionId = '201';
  assert.equal(trackDistrictUpdate(current, previous, nextAt).source.districtUpdateKind, 'first-observed');
});
