import fs from 'node:fs';
import path from 'node:path';
import config, { ROOT } from '../config.js';
import log from '../logger.js';
import { buildWardIndex, wardsToGeoJson } from '../../shared/wardIndex.js';

/**
 * Node-side loader for the AD76 ward boundary GeoJSON. Indexing itself lives in
 * shared/wardIndex.js so the browser build derives ward identity identically.
 */

let cache = null;

export function loadWards() {
  if (cache) return cache;

  const file = path.isAbsolute(config.geo.wardsFile)
    ? config.geo.wardsFile
    : path.join(ROOT, config.geo.wardsFile);

  if (!fs.existsSync(file)) {
    throw new Error(
      `Ward boundary file not found at ${file}. Run \`npm run fetch:wards\` to pull it from Dane County GIS.`,
    );
  }

  const fc = JSON.parse(fs.readFileSync(file, 'utf8'));
  cache = { ...buildWardIndex(fc, (event, detail) => log.warn(event, detail)), sourceFile: file };

  log.info('geo.loaded', {
    file: path.relative(ROOT, file),
    features: cache.featureCount,
    distinctWards: cache.wards.length,
    municipalities: cache.municipalities,
  });

  return cache;
}

/** GeoJSON for the browser: one feature per ward, minimal properties. */
export function wardsGeoJson() {
  return wardsToGeoJson(loadWards());
}

export function resetWardCache() {
  cache = null;
}
