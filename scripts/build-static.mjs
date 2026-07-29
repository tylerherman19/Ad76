#!/usr/bin/env node
/**
 * Build the static site for GitHub Pages into dist/.
 *
 * What this produces is the SAME frontend the Node server serves, plus a
 * runtime-config.json that flips public/pipeline.js into static mode. In that
 * mode the browser calls the county JSON API directly (it sends
 * Access-Control-Allow-Origin: *) and runs the shared/ modules itself, so
 * parsing, ward matching, grouping and colours are identical to the server
 * deployment.
 *
 * What static hosting cannot provide, and is therefore reported honestly in the
 * UI rather than faked: a force refresh that resets other viewers' countdowns,
 * and a cross-visitor debounce protecting the county from a click burst. The
 * countdown itself IS still synchronised, by anchoring to absolute UTC
 * boundaries rather than page-load time (see shared/schedule.js).
 *
 *   npm run build:static
 *   npx http-server dist -p 4000     # to preview
 */

import fs from 'node:fs';
import path from 'node:path';
import config, { ROOT } from '../src/config.js';

const DIST = path.join(ROOT, 'dist');
const BASE = process.env.PAGES_BASE_PATH ?? '';

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

const copyDir = (from, to) => {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else fs.copyFileSync(src, dst);
  }
};

// Frontend + the shared logic modules it imports.
copyDir(path.join(ROOT, 'public'), DIST);
copyDir(path.join(ROOT, 'shared'), path.join(DIST, 'shared'));

// Leaflet, vendored rather than pulled from a CDN, so the page makes no
// third-party requests at runtime.
copyDir(path.join(ROOT, 'node_modules', 'leaflet', 'dist'), path.join(DIST, 'vendor', 'leaflet'));

// Ward boundaries.
fs.mkdirSync(path.join(DIST, 'data'), { recursive: true });
const wardsSrc = path.join(ROOT, config.geo.wardsFile);
if (!fs.existsSync(wardsSrc)) {
  console.error(`Missing ${config.geo.wardsFile}. Run \`npm run fetch:wards\` first.`);
  process.exit(1);
}
fs.copyFileSync(wardsSrc, path.join(DIST, 'data', 'ad76-wards.geojson'));

// Runtime config. Only what the browser needs — no server-only settings.
const runtimeConfig = {
  mode: 'static',
  builtAt: new Date().toISOString(),
  election: {
    electionId: config.election.electionId,
    electionDate: config.election.electionDate,
    electionLabel: config.election.electionLabel,
    raceNamePattern: config.election.raceNamePattern,
    raceNumber: config.election.raceNumber,
    expectedCandidates: config.election.expectedCandidates,
  },
  source: {
    apiBaseUrl: config.source.apiBaseUrl,
    requestTimeoutMs: config.source.requestTimeoutMs,
  },
  polling: config.polling,
  candidates: config.candidates,
  margin: config.margin,
  geo: { wardsUrl: `${BASE}/data/ad76-wards.geojson` },
};
fs.writeFileSync(path.join(DIST, 'runtime-config.json'), JSON.stringify(runtimeConfig, null, 2));

// Rewrite absolute asset paths when the site is served from a subpath
// (https://user.github.io/Ad76/ rather than a custom domain at the root).
if (BASE) {
  for (const file of ['index.html', 'app.js', 'pipeline.js']) {
    const p = path.join(DIST, file);
    let s = fs.readFileSync(p, 'utf8');
    s = s
      .replace(/(["'(])\/(vendor|shared|data|styles\.css|app\.js|pipeline\.js|runtime-config\.json)/g, `$1${BASE}/$2`)
      .replace(/fetch\(['"]\/runtime-config\.json['"]/g, `fetch('${BASE}/runtime-config.json'`);
    fs.writeFileSync(p, s);
  }
}

// Jekyll would otherwise ignore files it does not recognise.
fs.writeFileSync(path.join(DIST, '.nojekyll'), '');

// Serve index.html for unknown paths so a stray /api/... request 404s as HTML
// rather than looking like a broken deploy.
fs.copyFileSync(path.join(DIST, 'index.html'), path.join(DIST, '404.html'));

const size = (d) =>
  fs.readdirSync(d, { withFileTypes: true }).reduce(
    (s, e) => s + (e.isDirectory() ? size(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size),
    0,
  );

console.log(`Built dist/ (${(size(DIST) / 1024 / 1024).toFixed(2)} MB)`);
console.log(`  base path:  ${BASE || '(site root)'}`);
console.log(`  electionId: ${config.election.electionId ?? '(not set — renders pre-election state)'}`);
console.log(`  county API: ${config.source.apiBaseUrl}`);
console.log('\nNOTE: static hosting has no shared server state. The countdown stays in sync');
console.log('across visitors via absolute UTC boundaries, but force refresh affects only the');
console.log('clicking browser and each visitor polls the county directly.');
