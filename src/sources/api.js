/**
 * Source: api.danecounty.gov JSON.
 *
 * The build spec asked for the HTML site and flagged this API as deprecated.
 * Two things were checked and both change the picture (details in README):
 *
 *  1. The "This is depracated and should no longer be used" note on
 *     https://api.danecounty.gov/Help sits under the **Press** API heading.
 *     The Election API section carries no deprecation notice.
 *  2. The Election endpoints are live and current — /elections/list returns
 *     elections through the April 2026 Spring Election.
 *
 * It is kept as a *secondary* source (html stays the default in `auto`)
 * because elections.danecounty.gov refuses datacenter IPs via Cloudflare,
 * which is exactly where a deployed backend runs. If the HTML scrape 403s on
 * election night, this path keeps the site alive on identical data.
 *
 * Response shapes below were verified against election 168 / race 0031
 * (2024 Partisan Primary, DEM Representative to the Assembly District 76).
 */

import config from '../config.js';

async function getJson(url, { timeoutMs, userAgent }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'user-agent': userAgent, accept: 'application/json' },
    });
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

/** Elections list, newest first. Used by scripts to discover the election id. */
export async function listElections() {
  const { apiBaseUrl, requestTimeoutMs, userAgent } = config.source;
  const rows = await getJson(`${apiBaseUrl}/list`, { timeoutMs: requestTimeoutMs, userAgent });
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
export async function findRaceNumber(electionId, raceNamePattern) {
  const { apiBaseUrl, requestTimeoutMs, userAgent } = config.source;
  const races = await getJson(`${apiBaseUrl}/races/${encodeURIComponent(electionId)}`, {
    timeoutMs: requestTimeoutMs,
    userAgent,
  });
  const re = new RegExp(raceNamePattern, 'i');
  const hit = races.find((r) => re.test(trim(r.RaceName)));
  return hit ? { raceNumber: String(hit.RaceNumber), raceName: trim(hit.RaceName) } : null;
}

export async function fetchApiResults({ electionId, raceNamePattern, raceNumber }) {
  const { apiBaseUrl, requestTimeoutMs, userAgent } = config.source;
  const opts = { timeoutMs: requestTimeoutMs, userAgent };

  let resolvedRace = raceNumber ? { raceNumber: String(raceNumber), raceName: null } : null;
  if (!resolvedRace) {
    resolvedRace = await findRaceNumber(electionId, raceNamePattern);
    if (!resolvedRace) {
      throw new Error(
        `No race matching /${raceNamePattern}/i in election ${electionId}. ` +
          'Before the county posts this race the election exists but the race does not yet.',
      );
    }
  }

  const url = `${apiBaseUrl}/precinctresults/${encodeURIComponent(electionId)}/${encodeURIComponent(resolvedRace.raceNumber)}`;
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
  const namesFromRows = [...new Set(rows.map((r) => trim(r.CandidateName)))];
  for (const n of namesFromRows) {
    if (!candidates.some((c) => c.name === n)) candidates.push({ name: n, votes: null, percent: null });
  }

  const reporting =
    typeof race.TotalPrecincts === 'number'
      ? { reported: race.PrecinctsReported ?? 0, total: race.TotalPrecincts }
      : null;

  return {
    sourceMode: 'api',
    sourceUrls: [url],
    raceName: trim(race.RaceName) || resolvedRace.raceName || null,
    raceId: resolvedRace.raceNumber,
    candidates,
    reporting,
    countyUpdatedAt: payload.Election?.LastPublished
      ? new Date(`${payload.Election.LastPublished}Z`).toISOString()
      : null,
    units: [...byPrecinct.values()],
  };
}
