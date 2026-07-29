/**
 * Explicit, inspectable matching between the county's reporting units and the
 * GIS ward layer.
 *
 * Deliberately NOT a fuzzy match. Each precinct label is parsed into
 * (municipality, ward numbers) by a documented grammar, and each resulting ward
 * is looked up by exact canonical key. Anything that fails is returned in
 * `unmatched` with the reason, logged, and surfaced on /api/health — never
 * dropped, and never snapped to a "close enough" ward.
 */

import log from './logger.js';
import { loadWards } from './geo/wards.js';
import { parsePrecinctName, displayWardLabel } from './precinctName.js';

export function matchUnitsToWards(units) {
  const { byKey, wards } = loadWards();

  const matched = [];
  const unmatched = [];
  const claimedWardKeys = new Set();

  for (const unit of units) {
    const parsed = parsePrecinctName(unit.precinctName);

    if (!parsed.ok) {
      const problem = {
        precinctName: unit.precinctName,
        precinctNumber: unit.precinctNumber ?? null,
        reason: `unparseable precinct label: ${parsed.reason}`,
      };
      unmatched.push(problem);
      log.warn('match.unparseable_precinct', problem);
      continue;
    }

    const hits = [];
    const misses = [];
    for (let i = 0; i < parsed.wardKeys.length; i++) {
      const k = parsed.wardKeys[i];
      if (byKey.has(k)) hits.push(k);
      else misses.push({ wardKey: k, ward: parsed.wards[i] });
    }

    if (!hits.length) {
      const problem = {
        precinctName: unit.precinctName,
        precinctNumber: unit.precinctNumber ?? null,
        reason: 'no ward in this reporting unit exists in the AD76 GIS layer',
        parsedMunicipality: parsed.municipality,
        parsedWards: parsed.wards,
        triedKeys: parsed.wardKeys,
      };
      unmatched.push(problem);
      log.warn('match.no_ward_found', problem);
      continue;
    }

    if (misses.length) {
      // Partial match is still a match for the wards we found, but the gap is
      // reported rather than swallowed. This happens legitimately when a
      // reporting unit straddles the district line: some of its wards are in
      // AD76 and some are not.
      const problem = {
        precinctName: unit.precinctName,
        reason: 'reporting unit references wards not present in the AD76 ward layer',
        matchedWards: hits,
        missingWards: misses.map((m) => m.wardKey),
        note: 'Expected when a precinct straddles the district boundary; its votes are still shown against the wards that are in AD76.',
      };
      unmatched.push(problem);
      log.warn('match.partial_ward_coverage', problem);
    }

    for (const k of hits) claimedWardKeys.add(k);

    const wardRecords = hits.map((k) => byKey.get(k));
    const alderDistricts = [...new Set(wardRecords.map((w) => w.alderDistrict).filter(Boolean))];

    matched.push({
      ...unit,
      parsed,
      label: displayWardLabel(parsed),
      wardKeys: hits,
      municipality: wardRecords[0].municipality,
      alderDistrict: alderDistricts.length === 1 ? alderDistricts[0] : null,
      alderDistricts,
      spansMultipleAlderDistricts: alderDistricts.length > 1,
    });
  }

  // Wards the GIS layer knows about that no reporting unit covered. On election
  // night this is normally empty; if it is not, the district's ward list and
  // the county's precinct list disagree and that needs to be visible.
  const wardsWithoutResults = wards
    .filter((w) => !claimedWardKeys.has(w.key))
    .map((w) => ({ wardKey: w.key, municipality: w.municipality, wardNumber: w.wardNumber }));

  if (wardsWithoutResults.length) {
    log.warn('match.wards_with_no_reporting_unit', {
      count: wardsWithoutResults.length,
      wards: wardsWithoutResults.map((w) => w.wardKey),
    });
  }

  const summary = {
    reportingUnits: units.length,
    matchedUnits: matched.length,
    unmatchedUnits: unmatched.filter((u) => !u.matchedWards).length,
    partialUnits: unmatched.filter((u) => u.matchedWards).length,
    wardsInLayer: wards.length,
    wardsCovered: claimedWardKeys.size,
    wardsWithoutReportingUnit: wardsWithoutResults.length,
  };

  log.info('match.summary', summary);

  return { matched, unmatched, wardsWithoutResults, summary };
}

export default matchUnitsToWards;
