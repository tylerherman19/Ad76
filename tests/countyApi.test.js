import fs from 'node:fs';
import config from '../src/config.js';
import { buildPayload } from '../shared/normalize.js';
import { buildWardIndex } from '../shared/wardIndex.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { listElections, findRaceNumber, fetchCountyResults, resolveElectionId } from '../shared/countyApi.js';

/**
 * SOURCE_MODE=api is the actual election-night default (config/default.json),
 * so this is the code path that runs live — unlike src/sources/html.js, which
 * only ever runs as a manually-enabled fallback. Fixtures below mirror the
 * real response shapes documented in shared/countyApi.js, verified against
 * election 168 / race 0031 (2024 Partisan Primary, AD76).
 */

const BASE = 'https://api.danecounty.gov/api/v1/elections';
const CANDS = ['Isaia Ben-Ami', 'Juliana Bennett', 'Tony Castañeda', 'Dina Nina Martinez-Rutherford', 'Zoe Sullivan'];

function jsonResponse(body, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

/** Install a fetch stub for the duration of one test, restored after. */
function withFetch(t, routes) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    for (const [pattern, body, status] of routes) {
      if (pattern.test(String(url))) return jsonResponse(body, status);
    }
    throw new Error(`no mocked route for ${url}`);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
}

test('listElections normalises shape and sorts newest first', async (t) => {
  withFetch(t, [
    [
      /\/list$/,
      [
        { ElectionId: 168, ElectionName: '2024 Partisan Primary', ElectionDate: '2024-08-13', LastPublished: 'x' },
        { ElectionId: 190, ElectionName: '2026 Spring Election', ElectionDate: '2026-04-07', LastPublished: 'y' },
      ],
    ],
  ]);
  const rows = await listElections(BASE, {});
  assert.deepEqual(rows.map((r) => r.electionId), ['190', '168']);
  assert.equal(rows[0].date, '2026-04-07');
});

test('findRaceNumber matches the configured pattern and ignores others', async (t) => {
  withFetch(t, [
    [
      /\/races\/195$/,
      [
        { RaceNumber: '0012', RaceName: 'DEM Governor' },
        { RaceNumber: '0031', RaceName: 'DEM Representative to the Assembly District 76' },
      ],
    ],
  ]);
  const hit = await findRaceNumber(BASE, '195', 'DEM\\s+Representative to the Assembly District\\s+76\\b', {});
  assert.equal(hit.raceNumber, '0031');
});

test('findRaceNumber returns null when the race has not been posted yet', async (t) => {
  withFetch(t, [[/\/races\/195$/, [{ RaceNumber: '0012', RaceName: 'DEM Governor' }]]]);
  const hit = await findRaceNumber(BASE, '195', 'DEM\\s+Representative to the Assembly District\\s+76\\b', {});
  assert.equal(hit, null);
});

test('fetchCountyResults raises raceNotFound (not a generic error) before the race is posted', async (t) => {
  withFetch(t, [[/\/races\/195$/, [{ RaceNumber: '0012', RaceName: 'DEM Governor' }]]]);
  await assert.rejects(
    () => fetchCountyResults({ baseUrl: BASE, electionId: '195', raceNamePattern: 'DEM\\s+Rep.*76\\b' }, {}),
    (err) => {
      assert.equal(err.raceNotFound, true);
      return true;
    },
  );
});

test('fetchCountyResults groups flat precinct×candidate rows into units, unreported stays null (never 0)', async (t) => {
  withFetch(t, [
    [
      /\/precinctresults\/195\/0031$/,
      {
        ElectionRace: {
          RaceName: 'DEM Representative to the Assembly District 76',
          Candidates: CANDS.map((name) => ({ Name: name, Votes: null, Percentage: null })),
          TotalPrecincts: 28,
          PrecinctsReported: 1,
        },
        PrecinctVotes: [
          ...CANDS.map((name, i) => ({
            PrecinctNumber: 1,
            PrecinctName: 'C Madison Wd 016',
            CandidateName: name,
            Reported: true,
            TotalVotes: (i + 1) * 10,
          })),
          ...CANDS.map((name) => ({
            PrecinctNumber: 2,
            PrecinctName: 'T Blooming Grove Wds 1-2',
            CandidateName: name,
            Reported: false,
            TotalVotes: null,
          })),
        ],
        Election: { LastPublished: '2026-08-11T21:14:03' },
      },
    ],
  ]);

  const result = await fetchCountyResults({ baseUrl: BASE, electionId: '195', raceNumber: '0031' }, {});

  assert.equal(result.sourceMode, 'api');
  assert.equal(result.units.length, 2);

  const madison = result.units.find((u) => u.precinctName === 'C Madison Wd 016');
  assert.equal(madison.reported, true);
  assert.equal(madison.votes['Dina Nina Martinez-Rutherford'], 40);

  const blooming = result.units.find((u) => u.precinctName.startsWith('T Blooming Grove'));
  assert.equal(blooming.reported, false);
  for (const name of CANDS) assert.equal(blooming.votes[name], null, `${name} must stay null, not 0`);

  assert.equal(result.reporting.reported, 1);
  assert.equal(result.reporting.total, 28);
  // The county's timestamp has no zone marker and is county-local, NOT UTC:
  // 21:14:03 Central on Aug 11 is 02:14:03Z on Aug 12. See shared/countyTime.js.
  assert.equal(result.countyUpdatedAt, '2026-08-12T02:14:03.000Z');
});

test('fetchCountyResults unions a candidate present in precinct rows but missing from the race summary', async (t) => {
  withFetch(t, [
    [
      /\/precinctresults\/195\/0031$/,
      {
        ElectionRace: { RaceName: 'DEM Representative to the Assembly District 76', Candidates: [{ Name: 'Zoe Sullivan', Votes: 5, Percentage: 100 }] },
        PrecinctVotes: [
          { PrecinctNumber: 1, PrecinctName: 'C Madison Wd 016', CandidateName: 'Zoe Sullivan', Reported: true, TotalVotes: 5 },
          { PrecinctNumber: 1, PrecinctName: 'C Madison Wd 016', CandidateName: 'write-in:', Reported: true, TotalVotes: 1 },
        ],
        Election: {},
      },
    ],
  ]);
  const result = await fetchCountyResults({ baseUrl: BASE, electionId: '195', raceNumber: '0031' }, {});
  assert.ok(result.candidates.some((c) => c.name === 'write-in:'));
  assert.equal(result.countyUpdatedAt, null);
});

test('general election discovery waits rather than loading primary results', async (t) => {
  withFetch(t, [[/\/list$/, [
    { ElectionId: 194, ElectionName: '2026 Partisan Primary', ElectionDate: '2026-08-11T00:00:00' },
    { ElectionId: 172, ElectionName: '2024 General Election', ElectionDate: '2024-11-05T00:00:00' },
  ]]]);
  await assert.rejects(() => resolveElectionId(BASE, { electionDate: '2026-11-03' }),
    (err) => err.electionNotFound === true);
});

test('general election discovery starts using results when the exact date is published', async (t) => {
  withFetch(t, [[/\/list$/, [
    { ElectionId: 999, ElectionName: '2027 Spring Election', ElectionDate: '2027-04-06T00:00:00' },
    { ElectionId: 200, ElectionName: '2026 General Election', ElectionDate: '2026-11-03T00:00:00' },
    { ElectionId: 194, ElectionName: '2026 Partisan Primary', ElectionDate: '2026-08-11T00:00:00' },
  ]]]);
  assert.equal(await resolveElectionId(BASE, { electionDate: '2026-11-03' }), '200');
});

test('explicit election ID overrides automatic discovery without fetching the list', async () => {
  assert.equal(await resolveElectionId(BASE, { electionId: '200', electionDate: '2026-11-03' }), '200');
});

test('configured general race excludes party primaries and neighbouring districts', async (t) => {
  withFetch(t, [[/\/races\/200$/, [
    { RaceNumber: '0001', RaceName: 'DEM Representative to the Assembly District 76' },
    { RaceNumber: '0002', RaceName: 'REP Representative to the Assembly District 76' },
    { RaceNumber: '0003', RaceName: 'Representative to the Assembly District 760' },
    { RaceNumber: '0042', RaceName: 'Representative to the Assembly District 76' },
  ]]]);
  const hit = await findRaceNumber(BASE, '200', config.election.raceNamePattern);
  assert.equal(hit.raceNumber, '0042');
});

test('general election payload keeps discovered ID, both nominees and neutral write-ins', async (t) => {
  withFetch(t, [[/\/precinctresults\/200\/0042$/, {
    ElectionRace: { RaceName: 'Representative to the Assembly District 76', Candidates: [
      { Name: 'Nina Chat', Votes: 10 }, { Name: 'Dina Nina Martinez-Rutherford', Votes: 90 },
      { Name: 'write-in:', Votes: 1 },
    ], TotalPrecincts: 28, PrecinctsReported: 1 },
    PrecinctVotes: [
      { PrecinctNumber: 1, PrecinctName: 'C Madison Wd 016', CandidateName: 'Nina Chat', Reported: true, TotalVotes: 10 },
      { PrecinctNumber: 1, PrecinctName: 'C Madison Wd 016', CandidateName: 'Dina Nina Martinez-Rutherford', Reported: true, TotalVotes: 90 },
      { PrecinctNumber: 1, PrecinctName: 'C Madison Wd 016', CandidateName: 'write-in:', Reported: true, TotalVotes: 1 },
    ], Election: { LastPublished: '2026-11-03T21:00:00' },
  }]]);
  const raw = await fetchCountyResults({ baseUrl: BASE, electionId: '200', raceNumber: '0042' });
  const payload = buildPayload(raw, buildWardIndex(JSON.parse(fs.readFileSync(new URL('../data/ad76-wards.geojson', import.meta.url)))), config);
  assert.equal(payload.election.electionId, '200');
  assert.equal(payload.election.electionDate, '2026-11-03');
  assert.equal(payload.candidates.find((c) => c.name === 'Nina Chat').color, '#D73027');
  assert.equal(payload.candidates.find((c) => /Martinez/.test(c.name)).color, '#56B4E9');
  assert.equal(payload.candidates.find((c) => c.writeIn).color, config.candidates.writeInColor);
  assert.equal(payload.reporting.wardsReported, 1);
});
