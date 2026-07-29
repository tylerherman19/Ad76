#!/usr/bin/env node
/**
 * Verify ward-name matching between the county's reporting units and the GIS
 * ward layer, and print every unmatched item rather than hiding the gap.
 *
 * With no arguments it uses the most recent election that actually contains an
 * AD76 race, so the matching can be proven before the 2026 primary is posted.
 *
 *   npm run verify:match                 # auto-pick a reference election
 *   npm run verify:match -- 168          # a specific election id
 *   npm run verify:match -- --live       # the configured election.electionId
 */

import config from '../src/config.js';
import { listElections, findRaceNumber, fetchApiResults } from '../src/sources/api.js';
import { fetchHtmlResults } from '../src/sources/html.js';
import { matchUnitsToWards } from '../src/match.js';
import { loadWards } from '../src/geo/wards.js';
import { parsePrecinctName, displayWardLabel } from '../shared/precinctName.js';

const arg = process.argv[2];
const pattern = config.election.raceNamePattern;

async function pickElection() {
  if (arg === '--live') {
    if (!config.election.electionId) {
      console.error('election.electionId is not set. Set ELECTION_ID or pass an id explicitly.');
      process.exit(1);
    }
    return config.election.electionId;
  }
  if (arg && /^\d+$/.test(arg)) return arg;

  console.log('No election id given — searching recent elections for an AD76 race...\n');
  const elections = await listElections();
  for (const e of elections.slice(0, 12)) {
    try {
      const hit = await findRaceNumber(e.electionId, pattern);
      if (hit) {
        console.log(`Using reference election ${e.electionId} — ${e.name} (${e.date})`);
        console.log(`  race ${hit.raceNumber}: ${hit.raceName}\n`);
        return e.electionId;
      }
    } catch {
      /* skip elections that error */
    }
  }
  console.error(`No recent election contained a race matching /${pattern}/i.`);
  process.exit(1);
}

const electionId = await pickElection();

let raw;
try {
  raw = config.source.mode === 'html'
    ? await fetchHtmlResults({ electionId, raceNamePattern: pattern, raceNumber: config.election.raceNumber })
    : await fetchApiResults({ electionId, raceNamePattern: pattern, raceNumber: config.election.raceNumber });
} catch (err) {
  console.error(`Fetch failed: ${err.message}`);
  if (err.hint) console.error(`Hint: ${err.hint}`);
  process.exit(1);
}

const { wards } = loadWards();

console.log('='.repeat(78));
console.log(`RACE: ${raw.raceName}`);
console.log(`SOURCE: ${raw.sourceMode}  ${raw.sourceUrls.join(' ')}`);
console.log(`CANDIDATES (scrape order): ${raw.candidates.map((c) => c.name).join(' | ')}`);
console.log(`REPORTING UNITS: ${raw.units.length}   GIS WARDS IN AD76: ${wards.length}`);
console.log('='.repeat(78));

console.log('\nPRECINCT LABEL -> PARSED WARDS');
console.log('-'.repeat(78));
for (const u of raw.units) {
  const p = parsePrecinctName(u.precinctName);
  const status = p.ok ? 'ok  ' : 'FAIL';
  const detail = p.ok
    ? `${p.wardKeys.join(', ')}   ->   "${displayWardLabel(p)}"`
    : p.reason;
  console.log(`  [${status}] ${String(u.precinctName).padEnd(30)} ${detail}`);
}

const { unmatched, wardsWithoutResults, summary } = matchUnitsToWards(raw.units);

console.log('\n' + '='.repeat(78));
console.log('MATCH SUMMARY');
console.log('='.repeat(78));
for (const [k, v] of Object.entries(summary)) console.log(`  ${k.padEnd(28)} ${v}`);

console.log('\nUNMATCHED / PARTIAL REPORTING UNITS');
console.log('-'.repeat(78));
if (!unmatched.length) console.log('  (none)');
for (const u of unmatched) {
  console.log(`  ${u.precinctName}`);
  console.log(`     reason: ${u.reason}`);
  if (u.missingWards) console.log(`     missing: ${u.missingWards.join(', ')}`);
  if (u.note) console.log(`     note: ${u.note}`);
}

console.log('\nGIS WARDS WITH NO REPORTING UNIT');
console.log('-'.repeat(78));
if (!wardsWithoutResults.length) console.log('  (none)');
for (const w of wardsWithoutResults) console.log(`  ${w.municipality} ward ${w.wardNumber}  (${w.wardKey})`);

const clean = !unmatched.length && !wardsWithoutResults.length;
console.log('\n' + (clean
  ? 'RESULT: every reporting unit matched, and every AD76 ward is covered.'
  : 'RESULT: gaps listed above. Nothing was dropped silently.'));
process.exit(clean ? 0 : 1);
