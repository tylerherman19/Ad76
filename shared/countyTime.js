/**
 * County timestamps -> ISO instants.
 *
 * PURE MODULE — no Node built-ins, so the browser build and the Node backend
 * convert the county's clock the same way.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Both county sources publish a "last updated" timestamp with NO zone marker:
 *
 *   JSON API   Election.LastPublished       "2026-08-03T07:53:39"
 *   HTML page  "Results Last Updated On ..." "8/11/2026 9:14:03 PM"
 *
 * Read naively these are ambiguous, and the two paths used to disagree: the API
 * client appended "Z" (forcing UTC) while the HTML scraper handed the string to
 * `new Date()` (server-local — UTC in the container, Central on a laptop). The
 * same instant therefore rendered up to five hours apart depending on which
 * source was live and where the process was running.
 *
 * They are county-local (America/Chicago). Election 194 reports LastPublished
 * 2026-08-03T07:53:39: 07:53 Central is an ordinary morning publish, 02:53
 * Central — what the "append Z" reading implies — is not.
 *
 * So: interpret the wall-clock reading in the county's zone, explicitly, in one
 * place, for both sources.
 */

/** Offset of `timeZone` from UTC, in minutes, at a given UTC instant. */
function zoneOffsetMinutes(utcMs, timeZone) {
  // Format the instant as wall-clock time in the target zone, read the parts
  // back as if they were UTC, and the difference is the offset. This gets DST
  // right without a table, because Intl already knows the rules.
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour) % 24,
    Number(p.minute),
    Number(p.second),
  );
  return (asUtc - utcMs) / 60000;
}

/**
 * Turn a zone-less wall-clock reading into a real instant.
 *
 * @param {{year:number,month:number,day:number,hour:number,minute:number,second:number}} parts
 * @param {string} timeZone IANA zone the reading was taken in
 * @returns {Date}
 */
function fromZonedParts(parts, timeZone) {
  const naive = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  // One correction pass, then a second using the offset in effect at the
  // candidate instant — this settles the hour on either side of a DST switch.
  let guess = naive - zoneOffsetMinutes(naive, timeZone) * 60000;
  guess = naive - zoneOffsetMinutes(guess, timeZone) * 60000;
  return new Date(guess);
}

const DEFAULT_ZONE = 'America/Chicago';

/**
 * Parse a county timestamp into an ISO string, or null if it is not a
 * timestamp. Never throws, and never guesses a value for unparseable input —
 * the UI shows "—" rather than a wrong time.
 *
 * Accepts the two shapes the county actually emits:
 *   ISO-like, no zone   "2026-08-03T07:53:39"  (JSON API)
 *   US date + clock     "8/11/2026 9:14:03 PM" (HTML page)
 *
 * A value that already carries an explicit zone ("...Z", "...-05:00") is
 * honoured as-is rather than re-interpreted.
 *
 * @param {string} value
 * @param {string} [timeZone] IANA zone the county publishes in
 * @returns {string|null} ISO 8601 instant
 */
export function parseCountyTimestamp(value, timeZone = DEFAULT_ZONE) {
  const raw = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!raw) return null;

  // Already zoned: trust it.
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)) {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (iso) {
    return fromZonedParts(
      {
        year: +iso[1],
        month: +iso[2],
        day: +iso[3],
        hour: +iso[4],
        minute: +iso[5],
        second: +(iso[6] ?? 0),
      },
      timeZone,
    ).toISOString();
  }

  const us = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:,)?(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?/);
  if (us) {
    let hour = us[4] === undefined ? 0 : +us[4];
    const meridiem = (us[7] ?? '').toLowerCase();
    if (meridiem === 'pm' && hour < 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
    return fromZonedParts(
      {
        year: +us[3],
        month: +us[1],
        day: +us[2],
        hour,
        minute: us[5] === undefined ? 0 : +us[5],
        second: us[6] === undefined ? 0 : +us[6],
      },
      timeZone,
    ).toISOString();
  }

  return null;
}

export { DEFAULT_ZONE as COUNTY_TIME_ZONE };
export default parseCountyTimestamp;
