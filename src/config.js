import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** Strip the "//"-prefixed documentation keys used in config/default.json. */
function stripComments(value) {
  if (Array.isArray(value)) return value.map(stripComments);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === '//' || k.startsWith('//')) continue;
      out[k] = stripComments(v);
    }
    return out;
  }
  return value;
}

function deepMerge(base, override) {
  const out = { ...base };
  for (const [k, v] of Object.entries(override ?? {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(base[k] ?? {}, v) : v;
  }
  return out;
}

const num = (v) => (v === undefined || v === '' ? undefined : Number(v));

/**
 * Env overrides. Every value that might need changing on election night is
 * reachable without editing a file, so the container can be restarted with a
 * new ELECTION_ID or a faster poll interval and nothing else changes.
 */
function envOverrides(env) {
  const o = { election: {}, source: {}, polling: { retry: {} }, server: {}, margin: {} };
  if (env.ELECTION_ID) o.election.electionId = env.ELECTION_ID;
  if (env.RACE_NUMBER) o.election.raceNumber = env.RACE_NUMBER;
  if (env.RACE_NAME_PATTERN) o.election.raceNamePattern = env.RACE_NAME_PATTERN;
  if (env.SOURCE_MODE) o.source.mode = env.SOURCE_MODE;
  if (env.HTML_BASE_URL) o.source.htmlBaseUrl = env.HTML_BASE_URL;
  if (env.API_BASE_URL) o.source.apiBaseUrl = env.API_BASE_URL;
  if (env.REQUEST_TIMEOUT_MS) o.source.requestTimeoutMs = num(env.REQUEST_TIMEOUT_MS);
  if (env.IDLE_INTERVAL_MS) o.polling.idleIntervalMs = num(env.IDLE_INTERVAL_MS);
  if (env.ACTIVE_INTERVAL_MS) o.polling.activeIntervalMs = num(env.ACTIVE_INTERVAL_MS);
  if (env.REPORTING_THRESHOLD) o.polling.reportingThreshold = num(env.REPORTING_THRESHOLD);
  if (env.FORCE_REFRESH_COOLDOWN_MS) o.polling.forceRefreshCooldownMs = num(env.FORCE_REFRESH_COOLDOWN_MS);
  if (env.STALE_AFTER_MS) o.polling.staleAfterMs = num(env.STALE_AFTER_MS);
  if (env.PORT) o.server.port = num(env.PORT);
  if (env.HOST) o.server.host = env.HOST;

  // Drop empty branches so deepMerge does not overwrite with {}.
  for (const k of Object.keys(o)) {
    if (o[k] && typeof o[k] === 'object' && Object.keys(o[k]).length === 0) delete o[k];
  }
  if (o.polling && Object.keys(o.polling.retry ?? {}).length === 0) delete o.polling.retry;
  return o;
}

function load() {
  const base = stripComments(readJson(path.join(ROOT, 'config', 'default.json')));
  const localPath = path.join(ROOT, 'config', 'local.json');
  const local = fs.existsSync(localPath) ? stripComments(readJson(localPath)) : {};
  const merged = deepMerge(deepMerge(base, local), envOverrides(process.env));

  merged.election.electionId =
    merged.election.electionId === null || merged.election.electionId === undefined
      ? null
      : String(merged.election.electionId);

  return merged;
}

export const config = load();
export default config;
