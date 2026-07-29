/**
 * Turn a raw source fetch into the payload the frontend renders.
 *
 * PURE MODULE — identical output in the Node backend and the static browser
 * build, so the two deployments can never disagree about totals, grouping or
 * colour.
 *
 * Rules that matter more than anything else here:
 *  - A ward that has not reported has votes = null and reported = false. It is
 *    never a row of zeroes, never gets a percentage, and never gets a colour.
 *  - Percentages are computed only from numbers the county actually published.
 *  - "0 of 28 wards reporting" is a valid, fully-rendered state.
 */

import { assignCandidateColors, marginStrength } from './colors.js';
import { matchUnitsToWards } from './match.js';
import { shortWardLabel } from './precinctName.js';

const pct = (n, d) => (d > 0 ? (n / d) * 100 : null);

function summarize(votesByCandidate, candidates) {
  const total = candidates.reduce((s, c) => s + (votesByCandidate[c.name] ?? 0), 0);
  const rows = candidates.map((c) => {
    const v = votesByCandidate[c.name];
    return {
      name: c.name,
      votes: v ?? null,
      percent: v === null || v === undefined ? null : pct(v, total),
    };
  });
  return { total, rows };
}

/** Leader + margin over the runner-up, ignoring write-in lines for the map hue. */
function leaderOf(rows, candidates) {
  const contenders = rows
    .filter((r) => r.votes !== null && !candidates.find((c) => c.name === r.name)?.writeIn)
    .sort((a, b) => b.votes - a.votes);

  if (!contenders.length) return null;
  const total = rows.reduce((s, r) => s + (r.votes ?? 0), 0);
  if (total === 0) return null; // reported, but genuinely zero votes cast

  const first = contenders[0];
  const second = contenders[1];
  if (second && second.votes === first.votes) {
    return { name: null, tied: true, margin: 0, votes: first.votes, percent: pct(first.votes, total) };
  }
  const margin = (first.votes - (second?.votes ?? 0)) / total;
  return { name: first.name, tied: false, margin, votes: first.votes, percent: pct(first.votes, total) };
}

/**
 * @param {object} raw          source result ({candidates, units, reporting, ...})
 * @param {object} wardIndex    from buildWardIndex()
 * @param {object} config       full config object
 * @param {function} [warn]     warning sink for match problems
 */
export function buildPayload(raw, wardIndex, config, warn = () => {}) {
  const candidates = assignCandidateColors(raw.candidates ?? [], config.candidates);
  const colorOf = new Map(candidates.map((c) => [c.name, c.color]));
  const { matched, unmatched, wardsWithoutResults, summary } = matchUnitsToWards(
    raw.units ?? [],
    wardIndex,
    warn,
  );
  const { byKey } = wardIndex;

  // ---- per reporting unit -------------------------------------------------
  const units = matched.map((u) => {
    const reported = Boolean(u.reported);
    const { total, rows } = summarize(u.votes ?? {}, candidates);
    const leader = reported ? leaderOf(rows, candidates) : null;

    return {
      id: u.wardKeys.join('+'),
      label: u.label,
      shortLabel: shortWardLabel(u.parsed),
      precinctName: u.precinctName,
      precinctNumber: u.precinctNumber ?? null,
      wardKeys: u.wardKeys,
      municipality: u.municipality,
      alderDistrict: u.alderDistrict,
      spansMultipleAlderDistricts: u.spansMultipleAlderDistricts,
      reported,
      totalVotes: reported ? total : null,
      candidates: reported ? rows : rows.map((r) => ({ name: r.name, votes: null, percent: null })),
      leader: leader
        ? {
            name: leader.name,
            tied: leader.tied,
            margin: leader.margin,
            percent: leader.percent,
            color: leader.tied ? null : colorOf.get(leader.name) ?? null,
            strength: marginStrength(leader.margin, config.margin),
          }
        : null,
    };
  });

  // Every AD76 ward must appear in the table, even when the county's results
  // contain no reporting unit covering it (true before the race is posted, and
  // true for any ward the county has not yet listed). Explicit "not reporting"
  // rows — structure without invented numbers.
  for (const w of wardsWithoutResults) {
    const ward = byKey.get(w.wardKey);
    const shortLabel = `${ward.municipality.replace(/^City of /, '')} Ward ${ward.wardNumber}`;
    units.push({
      id: w.wardKey,
      label: ward.municipality.startsWith('City') ? shortLabel : `${ward.municipality} Ward ${ward.wardNumber}`,
      shortLabel,
      precinctName: null,
      precinctNumber: null,
      wardKeys: [w.wardKey],
      municipality: ward.municipality,
      alderDistrict: ward.alderDistrict,
      spansMultipleAlderDistricts: false,
      reported: false,
      totalVotes: null,
      candidates: candidates.map((c) => ({ name: c.name, votes: null, percent: null })),
      leader: null,
      noReportingUnit: true,
    });
  }

  // ---- ward -> unit index for the map ------------------------------------
  // Wards inside one combined reporting unit share that unit's result. They are
  // painted identically because the county publishes one number for them
  // together; the detail panel names every ward in the unit so this is not hidden.
  const wardFill = {};
  for (const u of units) {
    for (const k of u.wardKeys) {
      wardFill[k] = {
        unitId: u.id,
        reported: u.reported,
        color: u.reported && u.leader && !u.leader.tied ? u.leader.color : null,
        strength: u.reported && u.leader ? u.leader.strength : null,
        tied: Boolean(u.leader?.tied),
      };
    }
  }

  // ---- groups: alder district for Madison, municipality elsewhere ---------
  // Verified against Dane County GIS: AD76 covers City of Madison (alder
  // districts 2,4,6,12,15,18), Town of Blooming Grove and Village of Maple
  // Bluff. The latter two have no alder district, so they group by municipality.
  const groups = new Map();
  for (const u of units) {
    const isMadison = /city of madison/i.test(u.municipality);
    const key = isMadison && u.alderDistrict ? `alder:${u.alderDistrict}` : `muni:${u.municipality}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        kind: isMadison && u.alderDistrict ? 'alder' : 'municipality',
        label: isMadison && u.alderDistrict ? `Alder District ${u.alderDistrict}` : u.municipality,
        sortValue: isMadison && u.alderDistrict ? Number(u.alderDistrict) : Number.MAX_SAFE_INTEGER,
        unitIds: [],
      });
    }
    groups.get(key).unitIds.push(u.id);
  }

  const unitById = new Map(units.map((u) => [u.id, u]));
  const groupList = [...groups.values()]
    .sort((a, b) => a.sortValue - b.sortValue || a.label.localeCompare(b.label))
    .map((g) => {
      const members = g.unitIds.map((id) => unitById.get(id));
      const reportedMembers = members.filter((m) => m.reported);
      const tally = {};
      for (const c of candidates) {
        tally[c.name] = reportedMembers.length
          ? reportedMembers.reduce((s, m) => s + (m.candidates.find((r) => r.name === c.name)?.votes ?? 0), 0)
          : null;
      }
      const { total, rows } = summarize(tally, candidates);
      const anyReported = reportedMembers.length > 0;
      // Group-level leader, so the UI can answer "who is winning alder
      // district 12" without recomputing totals in the browser.
      const gLeader = anyReported ? leaderOf(rows, candidates) : null;
      return {
        ...g,
        leader: gLeader
          ? {
              name: gLeader.name,
              tied: gLeader.tied,
              margin: gLeader.margin,
              percent: gLeader.percent,
              votes: gLeader.votes,
              color: gLeader.tied ? null : colorOf.get(gLeader.name) ?? null,
              strength: marginStrength(gLeader.margin, config.margin),
            }
          : null,
        unitIds: g.unitIds.sort((a, b) =>
          (unitById.get(a).label ?? '').localeCompare(unitById.get(b).label ?? '', undefined, { numeric: true }),
        ),
        reportedUnits: reportedMembers.length,
        totalUnits: members.length,
        totalVotes: anyReported ? total : null,
        candidates: anyReported ? rows : rows.map((r) => ({ name: r.name, votes: null, percent: null })),
      };
    });

  // ---- district-wide totals ----------------------------------------------
  const reportedUnits = units.filter((u) => u.reported);
  const grandTally = {};
  for (const c of candidates) {
    grandTally[c.name] = reportedUnits.length
      ? reportedUnits.reduce((s, u) => s + (u.candidates.find((r) => r.name === c.name)?.votes ?? 0), 0)
      : null;
  }
  const grand = summarize(grandTally, candidates);
  const grandLeader = reportedUnits.length ? leaderOf(grand.rows, candidates) : null;

  // The county publishes its own precinct-reporting counts; prefer them, but
  // fall back to what we can see in the unit rows.
  const reporting = {
    reported: raw.reporting?.reported ?? reportedUnits.length,
    total: raw.reporting?.total ?? units.length,
    unitsReported: reportedUnits.length,
    unitsTotal: units.length,
    wardsReported: reportedUnits.reduce((s, u) => s + u.wardKeys.length, 0),
    wardsTotal: Object.keys(wardFill).length,
  };
  reporting.percent = reporting.total > 0 ? (reporting.reported / reporting.total) * 100 : 0;

  return {
    election: {
      electionId: config.election.electionId ?? null,
      electionDate: config.election.electionDate,
      label: config.election.electionLabel,
      raceName: raw.raceName ?? null,
      raceId: raw.raceId ?? null,
    },
    source: {
      mode: raw.sourceMode,
      urls: raw.sourceUrls ?? [],
      fellBackFrom: raw.fellBackFrom ?? null,
      fallbackReason: raw.fallbackReason ?? null,
      countyUpdatedAt: raw.countyUpdatedAt ?? null,
    },
    candidates: candidates.map((c) => ({
      name: c.name,
      color: c.color,
      colorLabel: c.colorLabel,
      locked: Boolean(c.locked),
      writeIn: Boolean(c.writeIn),
    })),
    reporting,
    summary: {
      totalVotes: reportedUnits.length ? grand.total : null,
      candidates: reportedUnits.length ? grand.rows : grand.rows.map((r) => ({ name: r.name, votes: null, percent: null })),
      leader: grandLeader
        ? {
            name: grandLeader.name,
            tied: grandLeader.tied,
            votes: grandLeader.votes,
            percent: grandLeader.percent,
            margin: grandLeader.margin,
            color: grandLeader.tied ? null : colorOf.get(grandLeader.name) ?? null,
          }
        : null,
    },
    units,
    groups: groupList,
    wardFill,
    matching: { ...summary, unmatched, wardsWithoutResults },
  };
}

/**
 * Pre-results placeholder: real ward geometry, real candidate names, every ward
 * explicitly "not reporting". No invented vote numbers anywhere — every
 * votes/percent field is null.
 */
export function buildPlaceholderPayload(wardIndex, config, reason) {
  const candidates = assignCandidateColors(
    (config.election.expectedCandidates ?? []).map((name) => ({ name, votes: null, percent: null })),
    config.candidates,
  );

  const units = wardIndex.wards
    .map((w) => {
      const shortLabel = `${w.municipality.replace(/^City of /, '')} Ward ${w.wardNumber}`;
      return {
        id: w.key,
        label: w.municipality.startsWith('City') ? shortLabel : `${w.municipality} Ward ${w.wardNumber}`,
        shortLabel,
        precinctName: null,
        precinctNumber: null,
        wardKeys: [w.key],
        municipality: w.municipality,
        alderDistrict: w.alderDistrict,
        spansMultipleAlderDistricts: false,
        reported: false,
        totalVotes: null,
        candidates: candidates.map((c) => ({ name: c.name, votes: null, percent: null })),
        leader: null,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));

  const wardFill = {};
  for (const w of wardIndex.wards) {
    wardFill[w.key] = { unitId: w.key, reported: false, color: null, strength: null, tied: false };
  }

  const groups = new Map();
  for (const u of units) {
    const isMadison = /city of madison/i.test(u.municipality);
    const key = isMadison && u.alderDistrict ? `alder:${u.alderDistrict}` : `muni:${u.municipality}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        kind: isMadison && u.alderDistrict ? 'alder' : 'municipality',
        label: isMadison && u.alderDistrict ? `Alder District ${u.alderDistrict}` : u.municipality,
        sortValue: isMadison && u.alderDistrict ? Number(u.alderDistrict) : Number.MAX_SAFE_INTEGER,
        unitIds: [],
        reportedUnits: 0,
        totalVotes: null,
        leader: null,
        candidates: candidates.map((c) => ({ name: c.name, votes: null, percent: null })),
      });
    }
    groups.get(key).unitIds.push(u.id);
  }
  for (const g of groups.values()) g.totalUnits = g.unitIds.length;

  return {
    election: {
      electionId: config.election.electionId ?? null,
      electionDate: config.election.electionDate,
      label: config.election.electionLabel,
      raceName: null,
      raceId: null,
    },
    source: { mode: 'placeholder', urls: [], fellBackFrom: null, fallbackReason: null, countyUpdatedAt: null },
    candidates: candidates.map((c) => ({
      name: c.name,
      color: c.color,
      colorLabel: c.colorLabel,
      locked: Boolean(c.locked),
      writeIn: Boolean(c.writeIn),
    })),
    reporting: {
      reported: 0,
      total: units.length,
      unitsReported: 0,
      unitsTotal: units.length,
      wardsReported: 0,
      wardsTotal: wardIndex.wards.length,
      percent: 0,
    },
    summary: {
      totalVotes: null,
      candidates: candidates.map((c) => ({ name: c.name, votes: null, percent: null })),
      leader: null,
    },
    units,
    groups: [...groups.values()].sort((a, b) => a.sortValue - b.sortValue || a.label.localeCompare(b.label)),
    wardFill,
    matching: {
      reportingUnits: 0,
      matchedUnits: 0,
      unmatchedUnits: 0,
      partialUnits: 0,
      wardsInLayer: wardIndex.wards.length,
      wardsCovered: 0,
      wardsWithoutReportingUnit: wardIndex.wards.length,
      unmatched: [],
      wardsWithoutResults: [],
    },
    awaitingResults: true,
    awaitingReason: reason,
  };
}

export default buildPayload;
