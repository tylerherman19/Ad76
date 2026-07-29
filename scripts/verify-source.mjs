#!/usr/bin/env node
/**
 * Fetch the live county pages, save the raw HTML into fixtures/, and print
 * exactly what the parser extracted.
 *
 * Run this from a normal network connection. elections.danecounty.gov is behind
 * a Cloudflare rule that returns 403 to datacenter/cloud IPs, so this cannot be
 * run from most CI or cloud shells — see README "Data source reality check".
 *
 *   npm run verify:source -- 190          # a specific election id
 *   npm run verify:source                 # uses election.electionId from config
 *   npm run verify:source -- 190 --api    # compare against the JSON API
 */

import fs from 'node:fs';
import path from 'node:path';
import config, { ROOT } from '../src/config.js';
import { parseElectionPage, parsePrecinctPage, extractCountyTimestamp, extractReporting } from '../src/sources/html.js';
import { fetchApiResults } from '../src/sources/api.js';

const args = process.argv.slice(2);
const useApi = args.includes('--api');
const electionId = args.find((a) => /^\d+$/.test(a)) ?? config.election.electionId;

if (!electionId) {
  console.error('No election id. Pass one (npm run verify:source -- 190) or set ELECTION_ID.');
  process.exit(1);
}

const fixturesDir = path.join(ROOT, 'fixtures');
fs.mkdirSync(fixturesDir, { recursive: true });

async function get(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': config.source.userAgent, accept: 'text/html,application/xhtml+xml' },
    signal: AbortSignal.timeout(config.source.requestTimeoutMs),
  });
  const body = await res.text();
  return { status: res.status, body };
}

if (useApi) {
  const raw = await fetchApiResults({
    electionId,
    raceNamePattern: config.election.raceNamePattern,
    raceNumber: config.election.raceNumber,
  });
  fs.writeFileSync(path.join(fixturesDir, `api-${electionId}.json`), JSON.stringify(raw, null, 2));
  console.log(`API race: ${raw.raceName}`);
  console.log(`Candidates: ${raw.candidates.map((c) => `${c.name} (${c.votes ?? 'null'})`).join(', ')}`);
  console.log(`Reporting: ${raw.reporting ? `${raw.reporting.reported}/${raw.reporting.total}` : 'unknown'}`);
  console.log(`Units: ${raw.units.length}, reported: ${raw.units.filter((u) => u.reported).length}`);
  console.log(`Saved fixtures/api-${electionId}.json`);
  process.exit(0);
}

const electionUrl = `${config.source.htmlBaseUrl}/Election-Result/${electionId}`;
console.log(`GET ${electionUrl}`);
const electionRes = await get(electionUrl);
console.log(`  HTTP ${electionRes.status}, ${electionRes.body.length} bytes`);

const electionFixture = path.join(fixturesDir, `election-${electionId}.html`);
fs.writeFileSync(electionFixture, electionRes.body);
console.log(`  saved ${path.relative(ROOT, electionFixture)}`);

if (electionRes.status === 403) {
  console.error(
    '\n403 Forbidden. This host blocks datacenter/cloud egress IPs via Cloudflare.\n' +
      'Run this from a residential connection, or run the backend with SOURCE_MODE=api.',
  );
  process.exit(2);
}
if (electionRes.status !== 200) {
  console.error(`\nUnexpected status ${electionRes.status}; nothing to parse.`);
  process.exit(1);
}

console.log(`\nCounty "Results Last Updated" timestamp: ${extractCountyTimestamp(electionRes.body) ?? '(not found)'}`);
console.log(`Page-level reporting counts: ${JSON.stringify(extractReporting(electionRes.body)) ?? '(not found)'}`);

let race;
try {
  race = parseElectionPage(electionRes.body, config.election.raceNamePattern);
} catch (err) {
  console.error(`\nPARSE FAILED on the election page: ${err.message}`);
  console.error(`Inspect ${path.relative(ROOT, electionFixture)} and adjust src/sources/html.js.`);
  process.exit(1);
}

console.log('\n--- ELECTION PAGE PARSE ---');
console.log(`  raceName: ${race.raceName}`);
console.log(`  raceId:   ${race.raceId ?? '(no Votes By Precinct link found)'}`);
console.log(`  reporting: ${race.reporting ? `${race.reporting.reported} of ${race.reporting.total}` : '(not found)'}`);
console.log('  candidates (scrape order):');
for (const c of race.candidates) {
  console.log(`    ${c.name.padEnd(34)} votes=${c.votes ?? 'null'}  pct=${c.percent ?? 'null'}`);
}

const raceId = config.election.raceNumber ?? race.raceId;
if (!raceId) {
  console.error('\nNo raceId available; cannot fetch the per-ward breakdown.');
  process.exit(1);
}

const precinctUrl = `${config.source.htmlBaseUrl}/Precincts-Result/${electionId}/${raceId}`;
console.log(`\nGET ${precinctUrl}`);
const precinctRes = await get(precinctUrl);
console.log(`  HTTP ${precinctRes.status}, ${precinctRes.body.length} bytes`);

const precinctFixture = path.join(fixturesDir, `precincts-${electionId}-${raceId}.html`);
fs.writeFileSync(precinctFixture, precinctRes.body);
console.log(`  saved ${path.relative(ROOT, precinctFixture)}`);

let units;
try {
  units = parsePrecinctPage(precinctRes.body, race.candidates.map((c) => c.name));
} catch (err) {
  console.error(`\nPARSE FAILED on the precinct page: ${err.message}`);
  console.error(`Inspect ${path.relative(ROOT, precinctFixture)} and adjust src/sources/html.js.`);
  process.exit(1);
}

console.log('\n--- PRECINCT PAGE PARSE ---');
console.log(`  reporting units: ${units.length}`);
console.log(`  reported:        ${units.filter((u) => u.reported).length}`);
console.log(`  not reporting:   ${units.filter((u) => !u.reported).length}`);
console.log('\n  first 5 rows:');
for (const u of units.slice(0, 5)) {
  console.log(`    ${u.precinctName.padEnd(30)} reported=${u.reported}  ${JSON.stringify(u.votes)}`);
}

console.log('\nNow run `npm run verify:match -- ' + electionId + '` to check ward matching.');
