/**
 * Scraper for https://elections.danecounty.gov (server-side only).
 *
 * Page shapes this targets:
 *   /Election-Result/{electionId}            per-race vote tables + "Votes By Precinct" links
 *   /Precincts-Result/{electionId}/{raceId}  one row per precinct, one column per candidate
 *
 * PARSING STRATEGY: columns are located by *header text*, never by fixed index,
 * and the results table is located by looking for the race heading rather than
 * by an nth-child selector. County CMS markup shifts between elections; header
 * matching survives a column being added or reordered, and anything that cannot
 * be located is reported as a failure instead of being guessed at.
 *
 * VERIFICATION STATUS: see README, "Data source reality check". This parser was
 * written against the documented page structure and is exercised by fixtures in
 * fixtures/, but elections.danecounty.gov sits behind a Cloudflare rule that
 * refuses datacenter IPs, so it could not be run against the live HTML from the
 * build environment. `npm run verify:source` fetches the live pages from a
 * normal network, saves the HTML, and prints exactly what the parser extracted.
 */

import * as cheerio from 'cheerio';
import config from '../config.js';
import log from '../logger.js';

const norm = (s) => String(s ?? '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

/** "1,234" -> 1234. Returns null for blanks/dashes so "no data" never becomes 0. */
export function parseVotes(text) {
  const t = norm(text);
  if (!t || /^[-–—]$/.test(t)) return null;
  const m = t.replace(/,/g, '').match(/-?\d+/);
  return m ? Number(m[0]) : null;
}

export function parsePercent(text) {
  const t = norm(text).replace('%', '');
  if (!t || /^[-–—]$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

async function fetchText(url, { timeoutMs, userAgent }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'user-agent': userAgent, accept: 'text/html,application/xhtml+xml' },
    });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} from ${url}`);
      err.status = res.status;
      if (res.status === 403) {
        err.hint =
          'elections.danecounty.gov returned 403. This host is behind a Cloudflare rule that ' +
          'blocks datacenter/cloud egress IPs. Set SOURCE_MODE=api, or deploy somewhere with a ' +
          'residential/allow-listed egress IP. See README "Data source reality check".';
      }
      throw err;
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** Read a <table> into { headers:string[], rows:string[][] }. */
function readTable($, table) {
  const $t = $(table);
  const rows = [];
  $t.find('tr').each((_, tr) => {
    const cells = $(tr)
      .find('th,td')
      .map((__, td) => norm($(td).text()))
      .get();
    if (cells.length) rows.push(cells);
  });
  if (!rows.length) return null;

  // Header row = first row that is <th>-based, else the first row.
  let headerIdx = 0;
  $t.find('tr').each((i, tr) => {
    if (headerIdx === 0 && $(tr).find('th').length) headerIdx = i;
  });
  return { headers: rows[headerIdx] ?? [], rows: rows.slice(headerIdx + 1) };
}

/** Locate a column whose header matches any of the given patterns. */
function findCol(headers, patterns) {
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i].toLowerCase();
    if (patterns.some((p) => p.test(h))) return i;
  }
  return -1;
}

const RE = {
  candidate: [/^candidate/i, /^name$/i, /^choice/i],
  votes: [/^votes?$/i, /total votes/i, /^vote total/i],
  percent: [/^%$/, /percent/i, /^pct/i],
  precinct: [/^precinct/i, /^ward/i, /^reporting unit/i, /^municipality/i],
};

/**
 * "Results Last Updated On 8/11/2026 9:14:03 PM" -> ISO string.
 * This is the county's own timestamp and is deliberately kept separate from
 * our own fetch time — the UI shows both.
 */
export function extractCountyTimestamp(html) {
  const m = String(html).match(
    /Results?\s+Last\s+Updated\s*(?:On)?\s*:?\s*([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{4}[^<\n]{0,20})/i,
  );
  if (!m) return null;
  const d = new Date(norm(m[1]));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** "12 of 28 precincts reporting" -> { reported: 12, total: 28 }. */
export function extractReporting(text) {
  const m = String(text).match(/(\d+)\s+of\s+(\d+)\s+(?:precinct|ward|reporting unit)/i);
  if (!m) return null;
  return { reported: Number(m[1]), total: Number(m[2]) };
}

/**
 * Find the race whose heading matches the configured pattern, and return its
 * summary table plus the raceId from its "Votes By Precinct" link.
 */
export function parseElectionPage(html, raceNamePattern) {
  const $ = cheerio.load(html);
  const re = new RegExp(raceNamePattern, 'i');
  const pageText = norm($.root().text());

  let found = null;
  $('table').each((_, table) => {
    if (found) return;

    // The race name sits either in the table's own caption/first row, or in a
    // heading somewhere before the table.
    const tableText = norm($(table).text());
    let heading = null;
    if (re.test(tableText)) {
      heading = tableText;
    } else {
      const prev = $(table).prevAll('h1,h2,h3,h4,h5,caption,strong,p').filter((__, el) => re.test(norm($(el).text()))).first();
      if (prev.length) heading = norm(prev.text());
    }
    if (!heading) return;

    const parsed = readTable($, table);
    if (!parsed) return;

    const candCol = findCol(parsed.headers, RE.candidate);
    const voteCol = findCol(parsed.headers, RE.votes);
    const pctCol = findCol(parsed.headers, RE.percent);
    if (candCol === -1 || voteCol === -1) return;

    const candidates = [];
    for (const row of parsed.rows) {
      const name = norm(row[candCol]);
      if (!name || /^total/i.test(name)) continue;
      candidates.push({
        name,
        votes: parseVotes(row[voteCol]),
        percent: pctCol === -1 ? null : parsePercent(row[pctCol]),
      });
    }
    if (!candidates.length) return;

    // raceId comes from the "Votes By Precinct" link nearest this table.
    const scope = $(table).parent();
    let raceId = null;
    scope
      .find('a[href*="Precincts-Result"], a[href*="precincts-result"]')
      .each((__, a) => {
        if (raceId) return;
        const m = String($(a).attr('href')).match(/Precincts-Result\/(\d+)\/([\w-]+)/i);
        if (m) raceId = m[2];
      });
    if (!raceId) {
      $('a[href*="Precincts-Result"]').each((__, a) => {
        if (raceId) return;
        const $a = $(a);
        const ctx = norm($a.closest('div,section,td,tr').text()) || norm($a.parent().text());
        if (re.test(ctx)) {
          const m = String($a.attr('href')).match(/Precincts-Result\/(\d+)\/([\w-]+)/i);
          if (m) raceId = m[2];
        }
      });
    }

    found = {
      raceName: heading,
      raceId,
      candidates,
      reporting: extractReporting(tableText) ?? extractReporting(pageText),
    };
  });

  if (!found) {
    throw new Error(
      `No race matching /${raceNamePattern}/i on the election page. ` +
        'If the county renamed the race, update election.raceNamePattern in config.',
    );
  }
  return { ...found, countyUpdatedAt: extractCountyTimestamp(html) };
}

/**
 * Parse the per-precinct breakdown: rows are reporting units, columns are
 * candidates. A blank/dash vote cell means "not reported" and stays null.
 */
export function parsePrecinctPage(html, candidateNames) {
  const $ = cheerio.load(html);
  let best = null;

  $('table').each((_, table) => {
    const parsed = readTable($, table);
    if (!parsed) return;
    const precinctCol = findCol(parsed.headers, RE.precinct);
    if (precinctCol === -1) return;

    // Map each remaining header to a candidate by name match.
    const colFor = new Map();
    parsed.headers.forEach((h, i) => {
      if (i === precinctCol) return;
      const hn = norm(h).toLowerCase();
      const match = candidateNames.find(
        (c) => hn === c.toLowerCase() || hn.includes(c.toLowerCase()) || c.toLowerCase().includes(hn),
      );
      if (match && !colFor.has(match)) colFor.set(match, i);
    });
    if (colFor.size === 0) return;
    if (best && colFor.size <= best.colFor.size) return;
    best = { parsed, precinctCol, colFor };
  });

  if (!best) {
    throw new Error('No precinct breakdown table found (no table had a precinct/ward column plus candidate columns).');
  }

  const { parsed, precinctCol, colFor } = best;
  const missing = candidateNames.filter((c) => !colFor.has(c));
  if (missing.length) {
    log.warn('scrape.precinct_columns_missing', {
      missing,
      headers: parsed.headers,
      note: 'These candidates had no column in the precinct table; their per-ward votes stay null rather than 0.',
    });
  }

  const units = [];
  for (const row of parsed.rows) {
    const name = norm(row[precinctCol]);
    if (!name || /^(total|grand total|county total)/i.test(name)) continue;

    const votes = {};
    let anyNumber = false;
    for (const cand of candidateNames) {
      const idx = colFor.get(cand);
      const v = idx === undefined ? null : parseVotes(row[idx]);
      votes[cand] = v;
      if (v !== null) anyNumber = true;
    }
    // "Reported" is derived from whether the county printed numbers at all.
    // No numbers => not reporting. It never becomes a row of zeroes.
    units.push({ precinctName: name, votes, reported: anyNumber });
  }

  if (!units.length) throw new Error('Precinct table had a header but no data rows.');
  return units;
}

/** Fetch + parse both pages. Returns the raw shape consumed by normalize(). */
export async function fetchHtmlResults({ electionId, raceNamePattern, raceNumber }) {
  const { htmlBaseUrl, requestTimeoutMs, userAgent } = config.source;
  const opts = { timeoutMs: requestTimeoutMs, userAgent };

  const electionUrl = `${htmlBaseUrl}/Election-Result/${encodeURIComponent(electionId)}`;
  const electionHtml = await fetchText(electionUrl, opts);
  const race = parseElectionPage(electionHtml, raceNamePattern);

  const raceId = raceNumber ?? race.raceId;
  if (!raceId) {
    throw new Error(
      'Found the race summary but no "Votes By Precinct" link, so the per-ward breakdown cannot be located. ' +
        'Set election.raceNumber in config to bypass link discovery.',
    );
  }

  const precinctUrl = `${htmlBaseUrl}/Precincts-Result/${encodeURIComponent(electionId)}/${encodeURIComponent(raceId)}`;
  const precinctHtml = await fetchText(precinctUrl, opts);
  const candidateNames = race.candidates.map((c) => c.name);
  const units = parsePrecinctPage(precinctHtml, candidateNames);

  return {
    sourceMode: 'html',
    sourceUrls: [electionUrl, precinctUrl],
    raceName: race.raceName,
    raceId,
    candidates: race.candidates,
    reporting: race.reporting ?? extractReporting(cheerio.load(precinctHtml).root().text()),
    countyUpdatedAt: race.countyUpdatedAt ?? extractCountyTimestamp(precinctHtml),
    units,
  };
}
