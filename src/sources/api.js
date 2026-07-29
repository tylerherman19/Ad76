/**
 * Node-side wrapper around the shared county API client.
 *
 * The fetching and parsing live in shared/countyApi.js so the browser build
 * (static GitHub Pages deployment) runs byte-identical logic. This file only
 * injects Node-specific config: base URL, timeout and a User-Agent (browsers
 * are not allowed to set that header, so it is applied only here).
 *
 * On the deprecation question: the "This is depracated and should no longer be
 * used" note on https://api.danecounty.gov/Help sits under the **Press** API
 * heading. The Election API section carries no such notice and is live and
 * current — /elections/list returns elections through the April 2026 Spring
 * Election. This is the election-night default source.
 */

import config from '../config.js';
import { fetchCountyResults, listElections as sharedList, findRaceNumber as sharedFind } from '../../shared/countyApi.js';

const opts = () => ({
  timeoutMs: config.source.requestTimeoutMs,
  headers: { 'user-agent': config.source.userAgent },
});

export const listElections = () => sharedList(config.source.apiBaseUrl, opts());

export const findRaceNumber = (electionId, raceNamePattern) =>
  sharedFind(config.source.apiBaseUrl, electionId, raceNamePattern, opts());

export const fetchApiResults = ({ electionId, raceNamePattern, raceNumber }) =>
  fetchCountyResults(
    { baseUrl: config.source.apiBaseUrl, electionId, raceNamePattern, raceNumber },
    opts(),
  );
