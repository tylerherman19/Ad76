/**
 * Node-side wrapper over shared/match.js, binding it to the loaded ward index
 * and routing match warnings into the logger (and therefore /api/logs and
 * /api/health).
 */

import log from './logger.js';
import { loadWards } from './geo/wards.js';
import { matchUnitsToWards as sharedMatch } from '../shared/match.js';

export function matchUnitsToWards(units) {
  const result = sharedMatch(units, loadWards(), (event, detail) => log.warn(event, detail));
  log.info('match.summary', result.summary);
  return result;
}

export default matchUnitsToWards;
