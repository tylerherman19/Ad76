/**
 * Node-side wrapper over the shared colour module, binding it to the loaded
 * config. shared/colors.js holds the actual assignment and margin scale so the
 * browser build colours the map from the same code.
 */

import config from './config.js';
import {
  assignCandidateColors as sharedAssign,
  marginStrength as sharedStrength,
  isWriteIn as sharedIsWriteIn,
} from '../shared/colors.js';

export const assignCandidateColors = (candidates) => sharedAssign(candidates, config.candidates);
export const marginStrength = (margin) => sharedStrength(margin, config.margin);
export const isWriteIn = (name) => sharedIsWriteIn(name, config.candidates);

/** Config the browser needs so it renders from the same numbers. */
export function clientColorConfig() {
  return {
    noDataColor: config.candidates.noDataColor,
    writeInColor: config.candidates.writeInColor,
    margin: { ...config.margin },
  };
}
