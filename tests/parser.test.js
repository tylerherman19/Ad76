import test from 'node:test';
import assert from 'node:assert/strict';

import { parsePrecinctName, displayWardLabel, wardKey } from '../shared/precinctName.js';
import { parseVotes, parsePercent, parseElectionPage, parsePrecinctPage, extractReporting, extractCountyTimestamp } from '../src/sources/html.js';
import { assignCandidateColors, marginStrength } from '../shared/colors.js';
import { readFileSync } from 'node:fs';

// Load the real config, so these tests pin the values that actually ship
// rather than a copy that can drift from config/default.json.
const rawConfig = JSON.parse(readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'));
const strip = (v) => Array.isArray(v) ? v.map(strip)
  : v && typeof v === 'object'
    ? Object.fromEntries(Object.entries(v).filter(([k]) => !k.startsWith('//')).map(([k, x]) => [k, strip(x)]))
    : v;
const CONFIG = strip(rawConfig);
const CANDS = CONFIG.candidates;
const MARGIN = CONFIG.margin;

// ---------------------------------------------------------------------------
// Precinct label parsing. Shapes below are the real ones observed in Dane
// County's AD76 data (election 168, race 0031).
// ---------------------------------------------------------------------------

test('parses a single-ward Madison precinct', () => {
  const p = parsePrecinctName('C Madison Wd 016');
  assert.equal(p.ok, true);
  assert.equal(p.municipality, 'City of Madison');
  assert.deepEqual(p.wards, [16]);
  assert.deepEqual(p.wardKeys, ['city of madison|16']);
  assert.equal(displayWardLabel(p), 'Madison Ward 16');
});

test('parses a combined multi-ward town precinct', () => {
  const p = parsePrecinctName('T Blooming Grove Wds 1-2');
  assert.equal(p.ok, true);
  assert.equal(p.municipality, 'Town of Blooming Grove');
  assert.deepEqual(p.wards, [1, 2]);
  assert.equal(displayWardLabel(p), 'Town of Blooming Grove Wards 1–2');
});

test('parses a village precinct', () => {
  const p = parsePrecinctName('V Maple Bluff Wds 1-2');
  assert.equal(p.ok, true);
  assert.equal(p.municipality, 'Village of Maple Bluff');
  assert.deepEqual(p.wards, [1, 2]);
});

test('handles comma-separated and mixed ward specs', () => {
  assert.deepEqual(parsePrecinctName('C Madison Wds 1,3').wards, [1, 3]);
  assert.deepEqual(parsePrecinctName('C Madison Wds 1-3,7').wards, [1, 2, 3, 7]);
});

test('reports unparseable labels instead of guessing', () => {
  const p = parsePrecinctName('Somewhere Else Entirely');
  assert.equal(p.ok, false);
  assert.match(p.reason, /does not match/);
});

test('ward keys normalise zero padding and case', () => {
  assert.equal(wardKey('City of Madison', '016'), 'city of madison|16');
  assert.equal(wardKey('CITY OF MADISON', 16), 'city of madison|16');
});

// ---------------------------------------------------------------------------
// Never turn "no data" into zero.
// ---------------------------------------------------------------------------

test('blank and dash vote cells parse to null, not 0', () => {
  assert.equal(parseVotes(''), null);
  assert.equal(parseVotes('—'), null);
  assert.equal(parseVotes('-'), null);
  assert.equal(parseVotes('0'), 0);
  assert.equal(parseVotes('1,234'), 1234);
  assert.equal(parsePercent(''), null);
  assert.equal(parsePercent('42.5%'), 42.5);
});

test('extractReporting reads the "0 of N" state as valid', () => {
  assert.deepEqual(extractReporting('0 of 28 precincts reporting'), { reported: 0, total: 28 });
  assert.deepEqual(extractReporting('12 of 28 precincts reporting'), { reported: 12, total: 28 });
  assert.equal(extractReporting('no counts here'), null);
});

test('extractCountyTimestamp reads the county-reported update time', () => {
  const iso = extractCountyTimestamp('<p>Results Last Updated On 8/11/2026 9:14:03 PM</p>');
  assert.ok(iso, 'expected a timestamp');
  assert.equal(new Date(iso).getFullYear(), 2026);
});

// ---------------------------------------------------------------------------
// HTML parsing. Fixtures below are synthetic and mirror the documented page
// structure; they exist to pin the zero/partial-state behaviour.
// ---------------------------------------------------------------------------

const ELECTION_HTML = `
<html><body>
  <p>Results Last Updated On 8/11/2026 8:05:00 PM</p>
  <div>
    <h3>DEM Representative to the Assembly District 76</h3>
    <p>0 of 28 precincts reporting</p>
    <table>
      <tr><th>Candidate</th><th>Votes</th><th>Percent</th></tr>
      <tr><td>Isaia Ben-Ami</td><td></td><td></td></tr>
      <tr><td>Juliana Bennett</td><td></td><td></td></tr>
      <tr><td>Tony Casta&ntilde;eda</td><td></td><td></td></tr>
      <tr><td>Dina Nina Martinez-Rutherford</td><td></td><td></td></tr>
      <tr><td>Zoe Sullivan</td><td></td><td></td></tr>
    </table>
    <a href="/Precincts-Result/195/0031">Votes By Precinct</a>
  </div>
</body></html>`;

const PRECINCT_HTML_ZERO = `
<html><body><table>
  <tr><th>Precinct</th><th>Isaia Ben-Ami</th><th>Juliana Bennett</th><th>Tony Casta&ntilde;eda</th><th>Dina Nina Martinez-Rutherford</th><th>Zoe Sullivan</th></tr>
  <tr><td>C Madison Wd 016</td><td></td><td></td><td></td><td></td><td></td></tr>
  <tr><td>T Blooming Grove Wds 1-2</td><td></td><td></td><td></td><td></td><td></td></tr>
</table></body></html>`;

const PRECINCT_HTML_PARTIAL = `
<html><body><table>
  <tr><th>Precinct</th><th>Isaia Ben-Ami</th><th>Juliana Bennett</th><th>Tony Casta&ntilde;eda</th><th>Dina Nina Martinez-Rutherford</th><th>Zoe Sullivan</th></tr>
  <tr><td>C Madison Wd 016</td><td>40</td><td>120</td><td>15</td><td>200</td><td>25</td></tr>
  <tr><td>T Blooming Grove Wds 1-2</td><td></td><td></td><td></td><td></td><td></td></tr>
  <tr><td>Total</td><td>40</td><td>120</td><td>15</td><td>200</td><td>25</td></tr>
</table></body></html>`;

test('election page parse finds the race, candidates and raceId', () => {
  const race = parseElectionPage(ELECTION_HTML, 'DEM\\s+Representative to the Assembly District\\s+76\\b');
  assert.equal(race.raceId, '0031');
  assert.equal(race.candidates.length, 5);
  assert.deepEqual(race.reporting, { reported: 0, total: 28 });
  // Zero reporting: every vote total is null, NOT 0.
  for (const c of race.candidates) {
    assert.equal(c.votes, null, `${c.name} should have null votes before reporting`);
    assert.equal(c.percent, null);
  }
});

test('zero-reporting precinct page yields reported=false and null votes', () => {
  const names = ['Isaia Ben-Ami', 'Juliana Bennett', 'Tony Castañeda', 'Dina Nina Martinez-Rutherford', 'Zoe Sullivan'];
  const units = parsePrecinctPage(PRECINCT_HTML_ZERO, names);
  assert.equal(units.length, 2);
  for (const u of units) {
    assert.equal(u.reported, false);
    for (const n of names) assert.equal(u.votes[n], null, `${u.precinctName}/${n} must stay null`);
  }
});

test('partial reporting keeps reported and non-reported units distinct', () => {
  const names = ['Isaia Ben-Ami', 'Juliana Bennett', 'Tony Castañeda', 'Dina Nina Martinez-Rutherford', 'Zoe Sullivan'];
  const units = parsePrecinctPage(PRECINCT_HTML_PARTIAL, names);

  // The "Total" row is excluded, not treated as a ward.
  assert.equal(units.length, 2);

  const madison = units.find((u) => u.precinctName === 'C Madison Wd 016');
  assert.equal(madison.reported, true);
  assert.equal(madison.votes['Dina Nina Martinez-Rutherford'], 200);

  const town = units.find((u) => u.precinctName.startsWith('T Blooming Grove'));
  assert.equal(town.reported, false);
  for (const n of names) assert.equal(town.votes[n], null);
});

// ---------------------------------------------------------------------------
// Colour assignment and the shared margin scale.
// ---------------------------------------------------------------------------

test('Martinez-Rutherford is locked to Sky Blue regardless of scrape order', () => {
  const order1 = assignCandidateColors([
    { name: 'Dina Nina Martinez-Rutherford' }, { name: 'Zoe Sullivan' }, { name: 'Juliana Bennett' },
  ], CANDS);
  const order2 = assignCandidateColors([
    { name: 'Zoe Sullivan' }, { name: 'Juliana Bennett' }, { name: 'Dina Nina Martinez-Rutherford' },
  ], CANDS);
  assert.equal(order1.find((c) => /Martinez/.test(c.name)).color, '#56B4E9');
  assert.equal(order2.find((c) => /Martinez/.test(c.name)).color, '#56B4E9');
  // And she never consumes a palette slot from the others.
  assert.equal(order2[0].color, '#E69F00');
  assert.equal(order2[1].color, '#009E73');
});

test('remaining candidates take the palette in scrape order, write-ins get neutral', () => {
  const assigned = assignCandidateColors([
    { name: 'Isaia Ben-Ami' },
    { name: 'Juliana Bennett' },
    { name: 'Tony Castañeda' },
    { name: 'Dina Nina Martinez-Rutherford' },
    { name: 'Zoe Sullivan' },
    { name: 'write-in:' },
  ], CANDS);
  assert.deepEqual(
    assigned.map((c) => c.color),
    ['#E69F00', '#009E73', '#CC79A7', '#56B4E9', '#D55E00', '#6B6B6B'],
  );
  assert.equal(assigned.at(-1).writeIn, true);
});

test('margin scale is monotonic and clamped at both ends', () => {
  const lightest = marginStrength(0, MARGIN);
  const narrow = marginStrength(0.05, MARGIN);
  const mid = marginStrength(0.30, MARGIN);
  const landslide = marginStrength(0.50, MARGIN);
  const blowout = marginStrength(0.95, MARGIN);

  assert.equal(lightest, narrow, 'anything at or below the light threshold is the lightest tint');
  assert.ok(narrow < mid && mid < landslide, 'strength increases with margin');
  assert.equal(landslide, 1.0);
  assert.equal(blowout, 1.0, 'clamped at full strength');
});
