/**
 * Data layer. Two implementations behind one interface, so app.js does not care
 * which deployment it is running in.
 *
 * SERVER MODE — a Node backend is present. It owns the schedule as real shared
 *   state, does the county fetch once per interval no matter how many people
 *   are watching, and debounces force refresh across all visitors. The client
 *   just reads /api/results.
 *
 * STATIC MODE — GitHub Pages. There is no backend, so the browser fetches the
 *   county API directly (it sends `Access-Control-Allow-Origin: *`, verified)
 *   and runs the *same* shared/ modules the server would have run, producing an
 *   identical payload.
 *
 *   The countdown stays synchronised across visitors by anchoring refreshes to
 *   absolute UTC boundaries rather than to page-load time — see shared/schedule.js.
 *   What genuinely cannot work without a backend: a force refresh that resets
 *   other people's countdowns, and a cross-visitor debounce protecting the
 *   county. Those are reported honestly via `schedule.sharedStateAvailable`
 *   rather than faked.
 */

import { buildWardIndex, wardsToGeoJson } from '/shared/wardIndex.js';
import { buildPayload, buildPlaceholderPayload } from '/shared/normalize.js';
import { fetchCountyResults } from '/shared/countyApi.js';
import { staticScheduleInfo, phaseFor, intervalFor } from '/shared/schedule.js';

/* ------------------------------------------------------------ server mode */

class ServerPipeline {
  constructor() {
    this.mode = 'server';
  }

  async wardsGeoJson() {
    const res = await fetch('/api/wards.geojson');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async results() {
    const res = await fetch('/api/results', { cache: 'no-store' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const err = new Error(body.error ?? `HTTP ${res.status}`);
      err.schedule = body.schedule;
      throw err;
    }
    return res.json();
  }

  async forceRefresh() {
    const res = await fetch('/api/refresh', { method: 'POST' });
    return res.json();
  }
}

/* ------------------------------------------------------------ static mode */

class StaticPipeline {
  constructor(config) {
    this.mode = 'static';
    this.config = config;
    this.wardIndex = null;
    this.logs = [];
    this.lastSuccessAt = null;
    this.lastFailureAt = null;
    this.lastError = null;
    this.consecutiveFailures = 0;
    this.lastForceRefreshAt = null;
    this.lastPayload = null;
  }

  warn(event, detail) {
    this.logs.push({ ts: new Date().toISOString(), level: 'warn', event, detail });
    if (this.logs.length > 200) this.logs.shift();
    console.warn(event, detail);
  }

  async loadWards() {
    if (this.wardIndex) return this.wardIndex;
    const res = await fetch(this.config.geo.wardsUrl);
    if (!res.ok) throw new Error(`ward boundaries: HTTP ${res.status}`);
    this.wardIndex = buildWardIndex(await res.json(), (e, d) => this.warn(e, d));
    return this.wardIndex;
  }

  async wardsGeoJson() {
    return wardsToGeoJson(await this.loadWards());
  }

  buildSchedule(payload) {
    return staticScheduleInfo({
      nowMs: Date.now(),
      wardsReported: payload?.awaitingResults ? 0 : payload?.reporting?.wardsReported ?? 0,
      polling: this.config.polling,
      lastSuccessAt: this.lastSuccessAt,
      lastFailureAt: this.lastFailureAt,
      consecutiveFailures: this.consecutiveFailures,
      lastError: this.lastError,
      lastForceRefreshAt: this.lastForceRefreshAt,
    });
  }

  display() {
    return {
      noDataColor: this.config.candidates.noDataColor,
      writeInColor: this.config.candidates.writeInColor,
      margin: { ...this.config.margin },
    };
  }

  async results() {
    const wardIndex = await this.loadWards();
    const { electionId, raceNamePattern, raceNumber } = this.config.election;

    // No election id yet: render real structure, no numbers. Same placeholder
    // builder the backend uses.
    if (!electionId) {
      const payload = buildPlaceholderPayload(
        wardIndex,
        this.config,
        'No electionId configured yet. Dane County has not published the August 11 2026 primary. ' +
          'Set election.electionId in config/default.json and redeploy once it is listed.',
      );
      this.lastPayload = payload;
      return { ...payload, schedule: this.buildSchedule(payload), display: this.display() };
    }

    try {
      const raw = await fetchCountyResults(
        { baseUrl: this.config.source.apiBaseUrl, electionId, raceNamePattern, raceNumber },
        { timeoutMs: this.config.source.requestTimeoutMs },
      );
      const payload = buildPayload(raw, wardIndex, this.config, (e, d) => this.warn(e, d));
      this.lastSuccessAt = new Date().toISOString();
      this.consecutiveFailures = 0;
      this.lastError = null;
      this.lastPayload = payload;
      return { ...payload, schedule: this.buildSchedule(payload), display: this.display() };
    } catch (err) {
      this.lastFailureAt = new Date().toISOString();
      this.consecutiveFailures += 1;
      this.lastError = { message: err.message, status: err.status ?? null };
      this.warn('fetch.failed', this.lastError);

      // The race not existing yet is an expected state before the county posts
      // it, not an error condition — show structure, say why.
      if (err.raceNotFound) {
        const payload = buildPlaceholderPayload(
          wardIndex,
          this.config,
          `Election ${electionId} exists, but the AD76 race has not been posted yet.`,
        );
        this.lastPayload = payload;
        return { ...payload, schedule: this.buildSchedule(payload), display: this.display() };
      }

      // Keep the last good payload on screen; the stale badge covers the gap.
      if (this.lastPayload) {
        return { ...this.lastPayload, schedule: this.buildSchedule(this.lastPayload), display: this.display() };
      }
      const payload = buildPlaceholderPayload(wardIndex, this.config, `Could not reach the county API: ${err.message}`);
      this.lastPayload = payload;
      return { ...payload, schedule: this.buildSchedule(payload), display: this.display() };
    }
  }

  /**
   * Static force refresh: refreshes THIS browser only. There is no shared state
   * to move, so other viewers keep their own countdown — which the UI states
   * plainly instead of implying a global reset.
   *
   * A local cooldown still applies, so hammering the button does not hammer the
   * county from this browser.
   */
  async forceRefresh() {
    const cooldown = this.config.polling.forceRefreshCooldownMs;
    const now = Date.now();
    const last = this.lastForceRefreshAt ? Date.parse(this.lastForceRefreshAt) : null;
    if (last !== null && now - last < cooldown) {
      return {
        accepted: false,
        debounced: true,
        retryAfterMs: cooldown - (now - last),
        localOnly: true,
        schedule: this.buildSchedule(this.lastPayload),
      };
    }
    this.lastForceRefreshAt = new Date(now).toISOString();
    return { accepted: true, debounced: false, localOnly: true, schedule: this.buildSchedule(this.lastPayload) };
  }
}

/* ------------------------------------------------------------------ boot */

/**
 * Pick a pipeline. `runtime-config.json` is written by the static build; when
 * it is absent (or says mode: server) we are talking to the Node backend.
 */
export async function createPipeline() {
  let cfg = null;
  try {
    const res = await fetch('/runtime-config.json', { cache: 'no-cache' });
    if (res.ok && (res.headers.get('content-type') || '').includes('json')) cfg = await res.json();
  } catch {
    /* no runtime config -> server mode */
  }
  if (cfg && cfg.mode === 'static') return new StaticPipeline(cfg);
  return new ServerPipeline();
}

export { phaseFor, intervalFor };
