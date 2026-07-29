#!/usr/bin/env node
/**
 * Pull AD76 ward boundaries from Dane County GIS into data/ad76-wards.geojson.
 *
 * Layer: DaneCountyBase/MapServer/18 "Ward Boundaries". It carries AsmDistrict
 * (so the district filter is the county's own attribute, not a spatial guess)
 * and AldDistrict (so alder-district grouping comes from the same source).
 *
 * Usage: npm run fetch:wards
 */

import fs from 'node:fs';
import path from 'node:path';
import config, { ROOT } from '../src/config.js';

const layer = config.geo.arcgisWardLayer;
const district = config.geo.assemblyDistrict;

const params = new URLSearchParams({
  where: `AsmDistrict='${district}'`,
  outFields: 'NAME,WardNumber,AldDistrict,SupDistrict,AsmDistrict,WardID',
  returnGeometry: 'true',
  outSR: '4326',
  f: 'geojson',
});

const url = `${layer}/query?${params}`;
console.log(`Fetching AD${district} wards from:\n  ${layer}`);

const res = await fetch(url, { headers: { 'user-agent': config.source.userAgent } });
if (!res.ok) {
  console.error(`Request failed: HTTP ${res.status}`);
  process.exit(1);
}

const fc = await res.json();
if (fc.error) {
  console.error('ArcGIS returned an error:', JSON.stringify(fc.error));
  process.exit(1);
}
if (!fc.features?.length) {
  console.error(`No features returned for AsmDistrict='${district}'. Check the layer and field name.`);
  process.exit(1);
}

const out = path.join(ROOT, config.geo.wardsFile);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(fc));

const byMuni = {};
const wardSet = new Set();
const alders = new Set();
for (const f of fc.features) {
  const p = f.properties ?? {};
  byMuni[p.NAME] = (byMuni[p.NAME] ?? 0) + 1;
  wardSet.add(`${p.NAME}|${p.WardNumber}`);
  if (p.AldDistrict) alders.add(p.AldDistrict);
}

console.log(`\nWrote ${path.relative(ROOT, out)} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
console.log(`  features:        ${fc.features.length}`);
console.log(`  distinct wards:  ${wardSet.size}`);
console.log('  municipalities:');
for (const [m, n] of Object.entries(byMuni).sort()) console.log(`    ${m}: ${n} feature(s)`);
console.log(`  alder districts: ${[...alders].sort((a, b) => Number(a) - Number(b)).join(', ') || '(none)'}`);
console.log(
  '\nWards with no alder district are outside the City of Madison and are grouped by municipality in the results table.',
);
