import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCountyTimestamp } from '../shared/countyTime.js';

/**
 * The county publishes "last updated" with no zone marker, in its own local
 * time. Both source paths used to disagree about what that meant — the JSON
 * client appended "Z" and the HTML scraper used the server's zone — so the same
 * instant rendered up to five hours apart depending on which source was live
 * and where the process happened to be running.
 *
 * These tests pin the reading to America/Chicago and, critically, pin it
 * independently of the process TZ.
 */

test('ISO-like county stamps are read as county-local, not UTC', () => {
  // 2026-08-03 07:53:39 CDT (UTC-5) -> 12:53:39Z. Reading it as UTC would have
  // implied a 02:53 Central publish, which is what flagged the bug.
  assert.equal(parseCountyTimestamp('2026-08-03T07:53:39'), '2026-08-03T12:53:39.000Z');
});

test('election-night HTML stamps convert from the county clock', () => {
  // "Results Last Updated On 8/11/2026 9:14:03 PM" — the shape the scraper feeds in.
  assert.equal(parseCountyTimestamp('8/11/2026 9:14:03 PM'), '2026-08-12T02:14:03.000Z');
  assert.equal(parseCountyTimestamp('8/11/2026 12:00:00 AM'), '2026-08-11T05:00:00.000Z');
  assert.equal(parseCountyTimestamp('8/11/2026 12:00:00 PM'), '2026-08-11T17:00:00.000Z');
});

test('the reading does not depend on the server timezone', () => {
  const original = process.env.TZ;
  const readings = [];
  for (const tz of ['UTC', 'America/Chicago', 'Asia/Tokyo', 'Pacific/Auckland']) {
    process.env.TZ = tz;
    readings.push(parseCountyTimestamp('2026-08-11T21:14:03'));
  }
  process.env.TZ = original;
  assert.equal(new Set(readings).size, 1, `expected one instant, got ${JSON.stringify(readings)}`);
  assert.equal(readings[0], '2026-08-12T02:14:03.000Z');
});

test('standard time is handled as well as daylight time', () => {
  // February: Central is UTC-6, so 14:23 local -> 20:23Z.
  assert.equal(parseCountyTimestamp('2026-02-23T14:23:29'), '2026-02-23T20:23:29.000Z');
});

test('an explicit zone on the value is honoured rather than re-interpreted', () => {
  assert.equal(parseCountyTimestamp('2026-08-11T21:14:03Z'), '2026-08-11T21:14:03.000Z');
  assert.equal(parseCountyTimestamp('2026-08-11T21:14:03-05:00'), '2026-08-12T02:14:03.000Z');
});

test('missing or unparseable values return null instead of a wrong time', () => {
  assert.equal(parseCountyTimestamp(null), null);
  assert.equal(parseCountyTimestamp(''), null);
  assert.equal(parseCountyTimestamp('   '), null);
  assert.equal(parseCountyTimestamp('not a timestamp'), null);
});
