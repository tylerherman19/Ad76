import fs from 'node:fs';
import path from 'node:path';
import config, { ROOT } from '../config.js';
import log from '../logger.js';
import { wardKey, normalizeMunicipality } from '../precinctName.js';

/**
 * Loads the AD76 ward boundary GeoJSON pulled from Dane County GIS
 * (DaneCountyBase/MapServer/18 "Ward Boundaries", filtered AsmDistrict='76').
 *
 * The layer carries AldDistrict, so the alder-district grouping in the results
 * table comes from the county's own attribute rather than a hand-maintained
 * lookup. Wards outside the City of Madison have AldDistrict = null — verified:
 * AD76 includes Town of Blooming Grove and Village of Maple Bluff, which have
 * no alder districts and are grouped by municipality instead.
 */

let cache = null;

function mergeGeometries(geoms) {
  // A ward can arrive as several polygon features (split by water etc.).
  // Merge into one MultiPolygon so each ward is a single map shape.
  const polys = [];
  for (const g of geoms) {
    if (!g) continue;
    if (g.type === 'Polygon') polys.push(g.coordinates);
    else if (g.type === 'MultiPolygon') polys.push(...g.coordinates);
  }
  if (polys.length === 1) return { type: 'Polygon', coordinates: polys[0] };
  return { type: 'MultiPolygon', coordinates: polys };
}

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
  const features = fc.features ?? [];

  // Collapse multi-feature wards into one record per (municipality, ward).
  const byKey = new Map();
  for (const f of features) {
    const p = f.properties ?? {};
    const municipality = p.NAME;
    const wardNumber = p.WardNumber;
    if (!municipality || wardNumber === null || wardNumber === undefined) {
      log.warn('geo.feature_missing_attributes', { properties: p });
      continue;
    }
    const key = wardKey(municipality, wardNumber);
    if (!byKey.has(key)) {
      byKey.set(key, {
        key,
        municipality,
        municipalityNorm: normalizeMunicipality(municipality),
        wardNumber: Number(wardNumber),
        alderDistrict: p.AldDistrict ?? null,
        supervisorDistrict: p.SupDistrict ?? null,
        assemblyDistrict: p.AsmDistrict ?? null,
        geometries: [],
      });
    }
    byKey.get(key).geometries.push(f.geometry);
  }

  const wards = [...byKey.values()].map((w) => ({
    ...w,
    geometry: mergeGeometries(w.geometries),
    geometries: undefined,
  }));

  cache = {
    wards,
    byKey: new Map(wards.map((w) => [w.key, w])),
    municipalities: [...new Set(wards.map((w) => w.municipality))].sort(),
    sourceFile: file,
    featureCount: features.length,
  };

  log.info('geo.loaded', {
    file: path.relative(ROOT, file),
    features: features.length,
    distinctWards: wards.length,
    municipalities: cache.municipalities,
  });

  return cache;
}

/** GeoJSON for the browser: one feature per ward, minimal properties. */
export function wardsGeoJson() {
  const { wards } = loadWards();
  return {
    type: 'FeatureCollection',
    features: wards.map((w) => ({
      type: 'Feature',
      id: w.key,
      properties: {
        wardKey: w.key,
        municipality: w.municipality,
        wardNumber: w.wardNumber,
        alderDistrict: w.alderDistrict,
      },
      geometry: w.geometry,
    })),
  };
}

export function resetWardCache() {
  cache = null;
}
