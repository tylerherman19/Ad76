/**
 * Logging with a retained in-memory tail.
 *
 * Election-night requirement: scrape failures and unmatched wards have to be
 * checkable *while it is happening*, without shelling into the host to read
 * stdout. Everything logged here also lands in a ring buffer that /api/health
 * and /api/logs serve.
 */

const MAX_ENTRIES = 400;
const buffer = [];

function push(level, event, detail) {
  const entry = { ts: new Date().toISOString(), level, event, detail };
  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) buffer.shift();

  const line = `[${entry.ts}] ${level.toUpperCase()} ${event}` +
    (detail === undefined ? '' : ` ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
  return entry;
}

export const log = {
  info: (event, detail) => push('info', event, detail),
  warn: (event, detail) => push('warn', event, detail),
  error: (event, detail) => push('error', event, detail),

  /** Most recent entries, newest last. Optionally filtered by level. */
  tail(limit = 100, level = null) {
    const rows = level ? buffer.filter((e) => e.level === level) : buffer;
    return rows.slice(-limit);
  },

  counts() {
    return buffer.reduce((acc, e) => ({ ...acc, [e.level]: (acc[e.level] ?? 0) + 1 }), {});
  },
};

export default log;
