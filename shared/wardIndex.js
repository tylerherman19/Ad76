/**
 * Build the ward index from the AD76 ward GeoJSON.
 *
 * PURE MODULE — takes a parsed FeatureCollection, returns an index. The Node
 * backend reads the file from disk and the browser fetches it; both then call
 * this, so ward identity is computed the same way in both deployments.
 *
 * Source layer: Dane County GIS DaneCountyBase/MapServer/18 "Ward Boundaries",
 * filtered AsmDistrict='76'. It carries AldDistrict, so the alder-district
 * grouping in the results table comes from the county's own attribute rather
 * than a hand-maintained lookup. Wards outside the City of Madison have
 * AldDistrict = null — verified: AD76 includes Town of Blooming Grove and
 * Village of Maple Bluff, which have no alder districts and group by
 * municipality instead.
 */

import { wardKey, normalizeMunicipality } from './precinctName.js';

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

/**
 * @param {object} featureCollection parsed ward GeoJSON
 * @param {(event:string, detail:any)=>void} [warn] optional warning sink
 */
export function buildWardIndex(featureCollection, warn = () => {}) {
  const features = featureCollection?.features ?? [];

  const byKeyRaw = new Map();
  for (const f of features) {
    const p = f.properties ?? {};
    const municipality = p.NAME;
    const wardNumber = p.WardNumber;
    if (!municipality || wardNumber === null || wardNumber === undefined) {
      warn('geo.feature_missing_attributes', { properties: p });
      continue;
    }
    const key = wardKey(municipality, wardNumber);
    if (!byKeyRaw.has(key)) {
      byKeyRaw.set(key, {
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
    byKeyRaw.get(key).geometries.push(f.geometry);
  }

  const wards = [...byKeyRaw.values()].map(({ geometries, ...w }) => ({
    ...w,
    geometry: mergeGeometries(geometries),
  }));

  return {
    wards,
    byKey: new Map(wards.map((w) => [w.key, w])),
    municipalities: [...new Set(wards.map((w) => w.municipality))].sort(),
    featureCount: features.length,
  };
}

/** GeoJSON for the map: one feature per ward, minimal properties. */
export function wardsToGeoJson(index) {
  return {
    type: 'FeatureCollection',
    features: index.wards.map((w) => ({
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
