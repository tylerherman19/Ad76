import config from '../config.js';
import log from '../logger.js';
import { fetchHtmlResults } from './html.js';
import { fetchApiResults } from './api.js';

/**
 * Fetch raw results using the configured source mode.
 *   html -> scrape only (fail loudly if blocked)
 *   api  -> JSON only
 *   auto -> html first, fall back to api and record that it happened
 */
export async function fetchResults(params) {
  const mode = config.source.mode;

  if (mode === 'html') return fetchHtmlResults(params);
  if (mode === 'api') return fetchApiResults(params);

  if (mode !== 'auto') throw new Error(`Unknown source.mode "${mode}" (expected html | api | auto)`);

  try {
    return await fetchHtmlResults(params);
  } catch (err) {
    log.warn('source.html_failed_falling_back', {
      message: err.message,
      status: err.status ?? null,
      hint: err.hint ?? null,
    });
    const result = await fetchApiResults(params);
    return { ...result, fellBackFrom: 'html', fallbackReason: err.message };
  }
}

export default fetchResults;
