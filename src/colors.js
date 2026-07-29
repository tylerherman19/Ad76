/**
 * Candidate → colour assignment and the shared margin scale.
 *
 * This is the ONE place colours are decided. The map fills, the legend, the
 * table header chips and the summary bar all read the assignment produced here,
 * so changing the candidate field or a colour is an edit to config/default.json
 * and nothing else.
 *
 * Palette: Okabe-Ito, chosen for distinguishability under deuteranopia,
 * protanopia and tritanopia. Yellow is deliberately absent (unreadable on the
 * dark background) and no red/green pair carries meaning.
 */

import config from './config.js';

const normalizeName = (s) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z\s-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

export function isWriteIn(name) {
  return new RegExp(config.candidates.writeInPattern, 'i').test(String(name ?? '').trim());
}

/**
 * Assign colours to candidates.
 *
 * - Locked candidates (currently Dina Nina Martinez-Rutherford → Sky Blue) keep
 *   their colour no matter where they fall in ballot/scrape order.
 * - Everyone else takes paletteOrder in the order the scrape returned them.
 * - Write-in lines are counted in totals but get a neutral grey, not a hue.
 *
 * @param {Array<{name:string}>} candidates in scrape order
 */
export function assignCandidateColors(candidates) {
  const { lockedColors, paletteOrder, writeInColor } = config.candidates;
  const palette = [...paletteOrder];
  const assigned = [];
  const usedLocks = new Set();

  // Pass 1: locks and write-ins.
  for (const c of candidates) {
    const n = normalizeName(c.name);
    const lock = lockedColors.find((l, i) => !usedLocks.has(i) && n.includes(normalizeName(l.match)));
    if (lock) {
      usedLocks.add(lockedColors.indexOf(lock));
      assigned.push({ ...c, color: lock.color, colorLabel: lock.label, locked: true, writeIn: false });
    } else if (isWriteIn(c.name)) {
      assigned.push({ ...c, color: writeInColor, colorLabel: 'Neutral', locked: false, writeIn: true });
    } else {
      assigned.push({ ...c, color: null, colorLabel: null, locked: false, writeIn: false });
    }
  }

  // Pass 2: everyone else takes the palette in scrape order.
  let p = 0;
  for (const c of assigned) {
    if (c.color) continue;
    const slot = palette[p++];
    if (slot) {
      c.color = slot.color;
      c.colorLabel = slot.label;
    } else {
      // More candidates than palette entries. Do not invent a colour that
      // breaks the colourblind-safe guarantee — fall back to neutral and say so.
      c.color = config.candidates.writeInColor;
      c.colorLabel = 'Unassigned (palette exhausted)';
      c.paletteExhausted = true;
    }
  }

  return assigned;
}

/**
 * Shared margin → strength scale. Identical for every candidate; the leader's
 * hue is the only thing that changes between wards.
 *
 * margin is the winner's share minus the runner-up's share, as a fraction
 * (0.42 = 42 points). Below lightestMargin renders at minOpacity, at or above
 * fullStrengthMargin renders at maxOpacity, linear in between.
 */
export function marginStrength(margin) {
  const { lightestMargin, fullStrengthMargin, minOpacity, maxOpacity } = config.margin;
  if (!Number.isFinite(margin)) return minOpacity;
  const m = Math.max(0, margin);
  if (m <= lightestMargin) return minOpacity;
  if (m >= fullStrengthMargin) return maxOpacity;
  const t = (m - lightestMargin) / (fullStrengthMargin - lightestMargin);
  return minOpacity + t * (maxOpacity - minOpacity);
}

/** Config the browser needs so it renders from the same numbers. */
export function clientColorConfig() {
  return {
    noDataColor: config.candidates.noDataColor,
    writeInColor: config.candidates.writeInColor,
    margin: { ...config.margin },
  };
}
