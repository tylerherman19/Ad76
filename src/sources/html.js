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
 * VERIFICATION STATUS: see README, "Data source reality check". elections.danecounty.gov
 * itself sits behind a Cloudflare rule that refuses datacenter IPs. The county's live
 * site currently also answers at elections.countyofdane.com (not blocked from every
 * network), which made it possible to run this parser against real live markup for
 * election 194 / race 0065 (2026 Partisan Primary, DEM AD76):
 *
 *   - /Election-Result parses correctly (as of this check). The race heading and its
 *     results table are NOT direct siblings in the real markup — they are separate
 *     descendants of a shared wrapping <div>, one per race — and the "Number of Votes"
 *     header does not match a `/^votes?$/`-style column pattern. Both are handled below.
 *   - /Precincts-Result does NOT parse, and cannot with this approach: the live page
 *     ships an empty <table><thead id="thCandidate"></thead><tbody id="tbCandidate">
 *     </tbody></table> — the per-ward numbers are filled in by the county's own
 *     JavaScript after load, not present in the HTML response this module fetches.
 *     `fetchHtmlResults` (and therefore SOURCE_MODE=html / auto's fallback) cannot
 *     get ward-level results this way. This is not a parser bug to patch; getting this
 *     data would mean reverse-engineering the county's client-side data call or running
 *     a real browser — both larger than this module's scope, and the former would just
 *     reimplement api.js, which already works and is the default. Treat SOURCE_MODE=html
 *     as non-functional for ward-level results until this is revisited.
 */

import * as cheerio from 'cheerio';
import config from '../config.js';
import log from '../logger.js';
import { parseCountyTimestamp } from '../../shared/countyTime.js';

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
  const thCounts = [];
  const cellCounts = [];
  $t.find('tr').each((_, tr) => {
    const $cells = $(tr).find('th,td');
    const cells = $cells.map((__, td) => norm($(td).text())).get();
    if (!cells.length) return;
    rows.push(cells);
    thCounts.push($(tr).find('th').length);
    cellCounts.push(cells.length);
  });
  if (!rows.length) return null;

  // Header row = the first row made up ENTIRELY of <th>, else row 0.
  //
  // "Entirely", not "contains a th": county CMS tables routinely mark the first
  // cell of every data row as <th scope="row">, and a merely-contains test then
  // walks the header pointer down into the body — losing the real header row and
  // with it every candidate column, which made the whole table unusable.
  let headerIdx = 0;
  for (let i = 0; i < rows.length; i++) {
    if (thCounts[i] > 0 && thCounts[i] === cellCounts[i]) {
      headerIdx = i;
      break;
    }
  }
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
  // "Number of Votes" is the current county page's actual header text — a
  // vote-count column with "vote" nowhere near the front, so it needs its own
  // pattern rather than falling out of a `/^votes?$/`-style anchor. It must
  // stay distinct from `percent` below: "Vote Percentage" also contains
  // "vote" and would otherwise be claimed as the votes column instead.
  votes: [/^votes?$/i, /total votes/i, /^vote total/i, /number of votes/i],
  percent: [/^%$/, /percent/i, /^pct/i],
  precinct: [/^precinct/i, /^ward/i, /^reporting unit/i, /^municipality/i],
};

/**
 * "Results Last Updated On 8/11/2026 9:14:03 PM" -> ISO string.
 * This is the county's own timestamp and is deliberately kept separate from
 * our own fetch time — the UI shows both.
 */
export function extractCountyTimestamp(html, timeZone = config.source.countyTimeZone) {
  const m = String(html).match(
    /Results?\s+Last\s+Updated\s*(?:On)?\s*:?\s*([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{4}[^<\n]{0,20})/i,
  );
  if (!m) return null;
  // The county prints its own local wall clock with no zone. Handing it to
  // `new Date()` would read it in the *server's* zone — UTC in the container,
  // Central on a laptop — so the same page produced different times depending
  // on where the process ran, and disagreed with the JSON API path as well.
  return parseCountyTimestamp(m[1], timeZone);
}

/**
 * "12 of 28 precincts reporting" -> { reported: 12, total: 28 }.
 * Also matches the current county page phrasing, "0.0% of Precincts
 * Reporting (0 of 28)" — the number pair sits in parens after the word,
 * not immediately before it.
 */
export function extractReporting(text) {
  const t = String(text);
  const m = t.match(/(\d+)\s+of\s+(\d+)\s+(?:precinct|ward|reporting unit)/i) ??
    t.match(/precincts?\s+reporting\s*\(\s*(\d+)\s+of\s+(\d+)\s*\)/i);
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

  // Real county markup nests each race's heading and its results table as
  // separate descendants of a shared wrapping <div> (one row per race), not as
  // direct siblings — so a `prevAll` sibling search finds nothing, and naively
  // climbing ancestors and searching *down* from there over-matches: once the
  // climb reaches a container wide enough to hold several races' rows, its
  // heading bleeds onto every table inside it, not just its own.
  //
  // A single pass over headings and tables in document order sidesteps both
  // problems: races render sequentially and fully self-contained (heading,
  // then its table, then the next race's heading), so "the most recent
  // matching heading seen so far" is always this table's own — with no
  // ancestor-walking and no risk of grabbing a neighbouring race's heading.
  // 'p' is deliberately not in this list: the reporting-count line ("0 of 28
  // precincts reporting") is itself a <p>, and tracking it as a heading
  // candidate would overwrite the real heading with body text before the
  // table is ever reached.
  let lastHeading = null;
  let found = null;
  $('h1,h2,h3,h4,h5,caption,strong,table').each((_, el) => {
    if (found) return;
    if (el.tagName?.toLowerCase() !== 'table') {
      lastHeading = norm($(el).text());
      return;
    }
    const table = el;

    // The race name sits either in the table's own caption/first row, or in
    // the most recently seen heading (a direct previous sibling in the simple
    // page shape the tests pin; further out, but still the closest preceding
    // match in reading order, in the real county markup).
    const tableText = norm($(table).text());
    let heading = null;
    // Reporting counts ("N of M precincts") live outside the table itself —
    // in the simple/test-fixture shape that's the whole page; in the real
    // county markup it's a footer scoped to this race's own wrapping element,
    // two levels up (table -> column -> row). Narrowed below when that shape
    // is the one in play, so a multi-race page can't bleed a neighbouring
    // race's count into this one.
    let reportingScope = $(table);
    if (re.test(tableText)) {
      // Keep only the matched race name, not the whole flattened table. The
      // heading becomes `election.raceName` and is printed in the page header,
      // so taking `tableText` wholesale put every candidate row and vote count
      // into that line.
      heading = norm(tableText.match(re)?.[0] ?? tableText);
    } else if (lastHeading && re.test(lastHeading)) {
      heading = lastHeading;
      const climbed = $(table).parent().parent();
      if (climbed.length) reportingScope = climbed;
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
      reporting: extractReporting(norm(reportingScope.text())) ?? extractReporting(tableText) ?? extractReporting(pageText),
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
    //
    // Exact matches are bound first, across the whole header row, before any
    // fuzzy containment is considered. Otherwise a loose header earlier in the
    // row claims a candidate and the candidate's own column — sitting later in
    // the row — is then skipped as already-taken, and that candidate's votes
    // read as null from the wrong cell while the ward still counts as reported.
    // Silently wrong numbers are the one outcome this file exists to prevent.
    const colFor = new Map();
    const takenCols = new Set([precinctCol]);
    const headerNames = parsed.headers.map((h) => norm(h).toLowerCase());

    headerNames.forEach((hn, i) => {
      if (takenCols.has(i) || !hn) return;
      const exact = candidateNames.find((c) => hn === c.toLowerCase());
      if (exact && !colFor.has(exact)) {
        colFor.set(exact, i);
        takenCols.add(i);
      }
    });

    headerNames.forEach((hn, i) => {
      // A blank header matches nothing. `"name".includes("")` is always true,
      // so without this guard an empty column binds to the first candidate.
      if (takenCols.has(i) || hn.length < 3) return;
      const match = candidateNames.find(
        (c) => !colFor.has(c) && (hn.includes(c.toLowerCase()) || c.toLowerCase().includes(hn)),
      );
      if (match) {
        colFor.set(match, i);
        takenCols.add(i);
      }
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
