/**
 * Dane County election results, JSON API.
 *
 * PURE MODULE — uses only global `fetch`, so the identical code runs in the
 * Node backend and in the browser (static GitHub Pages build). The county API
 * sends `Access-Control-Allow-Origin: *` (verified), which is what makes the
 * browser path possible at all. Note that the HTML results host does NOT send
 * CORS headers and additionally blocks datacenter IPs — it can only be read
 * server-side, via src/sources/html.js.
 *
 * Response shapes verified against election 168 / race 0031 (2024 Partisan
 * Primary) and re-verified live against election 194 / race 0065 (2026 Partisan
 * Primary, DEM Representative to the Assembly District 76): 28 reporting units,
 * six ballot lines including "write-in:", PrecinctName padded with trailing
 * spaces (hence the trim() on every field used as a key).
 */

import { parseCountyTimestamp } from './countyTime.js';

async function getJson(url, { timeoutMs = 20000, headers = {} } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json', ...headers } });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} from ${url}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const trim = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** Elections list, newest first. */
export async function listElections(baseUrl, opts) {
  const rows = await getJson(`${baseUrl}/list`, opts);
  return rows
    .map((e) => ({
      electionId: String(e.ElectionId),
      name: trim(e.ElectionName),
      date: e.ElectionDate ? String(e.ElectionDate).slice(0, 10) : null,
      lastPublished: e.LastPublished ?? null,
    }))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

/** Find the race number whose name matches the configured pattern. */
export async function findRaceNumber(baseUrl, electionId, raceNamePattern, opts) {
  const races = await getJson(`${baseUrl}/races/${encodeURIComponent(electionId)}`, opts);
  const re = new RegExp(raceNamePattern, 'i');
  const hit = races.find((r) => re.test(trim(r.RaceName)));
  return hit ? { raceNumber: String(hit.RaceNumber), raceName: trim(hit.RaceName) } : null;
}

export async function fetchCountyResults({ baseUrl, electionId, raceNamePattern, raceNumber, countyTimeZone }, opts = {}) {
  let resolvedRace = raceNumber ? { raceNumber: String(raceNumber), raceName: null } : null;
  if (!resolvedRace) {
    resolvedRace = await findRaceNumber(baseUrl, electionId, raceNamePattern, opts);
    if (!resolvedRace) {
      const err = new Error(
        `No race matching /${raceNamePattern}/i in election ${electionId}. ` +
          'Before the county posts this race the election exists but the race does not yet.',
      );
      err.raceNotFound = true;
      throw err;
    }
  }

  const url = `${baseUrl}/precinctresults/${encodeURIComponent(electionId)}/${encodeURIComponent(resolvedRace.raceNumber)}`;
  const payload = await getJson(url, opts);

  const race = payload.ElectionRace ?? {};
  const rows = payload.PrecinctVotes ?? [];

  const candidates = (race.Candidates ?? []).map((c) => ({
    name: trim(c.Name),
    votes: typeof c.Votes === 'number' ? c.Votes : null,
    percent: typeof c.Percentage === 'number' ? c.Percentage : null,
  }));

  // Group the flat candidate×precinct rows into one entry per reporting unit.
  const byPrecinct = new Map();
  for (const r of rows) {
    const key = `${r.PrecinctNumber}|${trim(r.PrecinctName)}`;
    if (!byPrecinct.has(key)) {
      byPrecinct.set(key, {
        precinctName: trim(r.PrecinctName),
        precinctNumber: String(r.PrecinctNumber ?? '').trim() || null,
        votes: {},
        reported: false,
      });
    }
    const unit = byPrecinct.get(key);
    // Reported === false means the county has no numbers for this unit yet.
    // Leave votes null in that case; never write a 0.
    unit.votes[trim(r.CandidateName)] = r.Reported ? (typeof r.TotalVotes === 'number' ? r.TotalVotes : null) : null;
    if (r.Reported) unit.reported = true;
  }

  // Candidates can appear in the precinct rows but not the summary (rare); union them.
  for (const n of new Set(rows.map((r) => trim(r.CandidateName)))) {
    if (!candidates.some((c) => c.name === n)) candidates.push({ name: n, votes: null, percent: null });
  }

  return {
    sourceMode: 'api',
    sourceUrls: [url],
    raceName: trim(race.RaceName) || resolvedRace.raceName || null,
    raceId: resolvedRace.raceNumber,
    candidates,
    reporting:
      typeof race.TotalPrecincts === 'number'
        ? { reported: race.PrecinctsReported ?? 0, total: race.TotalPrecincts }
        : null,
    // LastPublished has no zone marker and is county-local, not UTC. See
    // shared/countyTime.js for the evidence and the conversion.
    countyUpdatedAt: parseCountyTimestamp(payload.Election?.LastPublished, countyTimeZone),
    units: [...byPrecinct.values()],
  };
}
