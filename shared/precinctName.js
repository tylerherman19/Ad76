/**
 * Parse Dane County reporting-unit ("precinct") labels into municipality + ward numbers.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Dane County's results are published per *precinct*, and a precinct is NOT
 * always one ward. Verified against the 2024 Partisan Primary AD76 race
 * (election 168, race 0031), which reported 28 precincts covering 30 wards:
 *
 *   "C Madison Wd 016"          -> City of Madison, ward 16          (1 ward)
 *   "T Blooming Grove Wds 1-2"  -> Town of Blooming Grove, wards 1,2 (2 wards)
 *   "V Maple Bluff Wds 1-2"     -> Village of Maple Bluff, wards 1,2 (2 wards)
 *
 * So "precinct" and "ward" are NOT interchangeable in this county's data. Every
 * parse result is a set of wards, and matching is done on that set. Parsing is
 * strict: anything that does not fit a known shape is returned as unparsed and
 * gets logged, rather than being fuzzy-matched into the nearest ward.
 */

const PREFIXES = {
  C: 'City',
  T: 'Town',
  V: 'Village',
};

/** "City of Madison" / "Town of Blooming Grove" -> "city of madison". */
export function normalizeMunicipality(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Canonical join key used on both sides of the match. */
export function wardKey(municipality, wardNumber) {
  return `${normalizeMunicipality(municipality)}|${String(Number(wardNumber))}`;
}

/**
 * Expand a ward spec: "016" -> [16]; "1-2" -> [1,2]; "1-3,7" -> [1,2,3,7].
 * Returns null if any token is unrecognised, so callers can report it.
 */
function expandWardSpec(spec) {
  const out = [];
  for (const rawToken of String(spec).split(/\s*[,&]\s*/)) {
    const token = rawToken.trim();
    if (!token) continue;
    const range = token.match(/^(\d+)\s*[-–]\s*(\d+)$/);
    if (range) {
      const [a, b] = [Number(range[1]), Number(range[2])];
      if (b < a || b - a > 60) return null;
      for (let i = a; i <= b; i++) out.push(i);
      continue;
    }
    if (/^\d+$/.test(token)) {
      out.push(Number(token));
      continue;
    }
    return null;
  }
  return out.length ? [...new Set(out)] : null;
}

/**
 * Parse one precinct label.
 *
 * @returns {{ok:true, raw, municipality, municipalityType, wards:number[], wardKeys:string[]}
 *          |{ok:false, raw, reason:string}}
 */
export function parsePrecinctName(raw) {
  const cleaned = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return { ok: false, raw, reason: 'empty label' };

  // <prefix> <municipality words> Wd|Wds <spec>
  const m = cleaned.match(/^([CTV])\s+(.+?)\s+Wds?\.?\s+([\d\s,&\-–]+)$/i);
  if (!m) return { ok: false, raw: cleaned, reason: 'does not match "<C|T|V> <Municipality> Wd(s) <numbers>"' };

  const type = PREFIXES[m[1].toUpperCase()];
  const shortName = m[2].replace(/\s+/g, ' ').trim();
  const wards = expandWardSpec(m[3]);
  if (!wards) return { ok: false, raw: cleaned, reason: `unparseable ward spec "${m[3].trim()}"` };

  // County writes "C Madison"; GIS writes "City of Madison".
  const municipality = `${type} of ${shortName}`;

  return {
    ok: true,
    raw: cleaned,
    municipality,
    municipalityType: type,
    shortName,
    wards,
    wardKeys: wards.map((w) => wardKey(municipality, w)),
  };
}

/**
 * Human label for the UI. The spec asks for "ward" wording throughout, and a
 * combined reporting unit is shown honestly as the wards it actually covers.
 */
export function displayWardLabel(parsed) {
  if (!parsed?.ok) return String(parsed?.raw ?? 'Unknown');
  const { shortName, municipalityType, wards } = parsed;
  const place = municipalityType === 'City' ? shortName : `${municipalityType} of ${shortName}`;
  if (wards.length === 1) return `${place} Ward ${wards[0]}`;

  // Collapse consecutive runs: [1,2] -> "1–2", [1,2,5] -> "1–2, 5".
  const runs = [];
  for (const w of wards) {
    const last = runs[runs.length - 1];
    if (last && w === last[1] + 1) last[1] = w;
    else runs.push([w, w]);
  }
  const spec = runs.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(', ');
  return `${place} Wards ${spec}`;
}

/** Short label for dense contexts (map tooltip title, mobile table). */
export function shortWardLabel(parsed) {
  if (!parsed?.ok) return String(parsed?.raw ?? 'Unknown');
  return displayWardLabel(parsed).replace(/^City of /, '');
}
