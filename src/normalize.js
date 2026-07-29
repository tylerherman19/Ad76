/**
 * Node-side adapters over the shared payload builders.
 *
 * All the logic lives in shared/normalize.js so the static browser build
 * produces byte-identical payloads. These wrappers only inject the Node config
 * object, the loaded ward index, and the logger as the warning sink.
 */

import config from './config.js';
import log from './logger.js';
import { loadWards } from './geo/wards.js';
import {
  buildPayload as sharedBuildPayload,
  buildPlaceholderPayload as sharedPlaceholder,
} from '../shared/normalize.js';

const warn = (event, detail) => log.warn(event, detail);

export function buildPayload(raw) {
  const wardIndex = loadWards();
  const payload = sharedBuildPayload(raw, wardIndex, config, warn);
  log.info('match.summary', {
    reportingUnits: payload.matching.reportingUnits,
    matchedUnits: payload.matching.matchedUnits,
    unmatchedUnits: payload.matching.unmatchedUnits,
    partialUnits: payload.matching.partialUnits,
    wardsInLayer: payload.matching.wardsInLayer,
    wardsCovered: payload.matching.wardsCovered,
    wardsWithoutReportingUnit: payload.matching.wardsWithoutReportingUnit,
  });
  return payload;
}

export function buildPlaceholderPayload(reason) {
  return sharedPlaceholder(loadWards(), config, reason);
}

export default buildPayload;
