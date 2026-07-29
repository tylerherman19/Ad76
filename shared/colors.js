/**
 * Candidate → colour assignment and the shared margin scale.
 *
 * PURE MODULE — no Node built-ins, no imports. Runs unchanged in the browser
 * (static GitHub Pages build) and in the Node backend, so both deployments
 * colour the map identically from the same code.
 *
 * Config is passed in rather than imported, because the two runtimes load it
 * differently (fs vs fetch). `config/default.json` remains the single source of
 * truth for the values themselves.
 *
 * Palette: Okabe-Ito, chosen for distinguishability under deuteranopia,
 * protanopia and tritanopia. Yellow is deliberately absent (unreadable on the
 * dark background) and no red/green pair carries meaning.
 */

const normalizeName = (s) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z\s-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

export function isWriteIn(name, candidatesConfig) {
  return new RegExp(candidatesConfig.writeInPattern, 'i').test(String(name ?? '').trim());
}

/**
 * Assign colours to candidates.
 *
 * - Locked candidates (currently Dina Nina Martinez-Rutherford → Sky Blue) keep
 *   their colour no matter where they fall in ballot/scrape order, and never
 *   consume a palette slot from anyone else.
 * - Everyone else takes paletteOrder in the order the source returned them.
 * - Write-in lines are counted in totals but get a neutral grey, not a hue.
 *
 * @param {Array<{name:string}>} candidates in source order
 * @param {object} candidatesConfig config.candidates
 */
export function assignCandidateColors(candidates, candidatesConfig) {
  const { lockedColors, paletteOrder, writeInColor } = candidatesConfig;
  const palette = [...paletteOrder];
  const assigned = [];
  const usedLocks = new Set();

  // Pass 1: locks and write-ins.
  for (const c of candidates) {
    const n = normalizeName(c.name);
    const lockIdx = lockedColors.findIndex(
      (l, i) => !usedLocks.has(i) && n.includes(normalizeName(l.match)),
    );
    if (lockIdx !== -1) {
      const lock = lockedColors[lockIdx];
      usedLocks.add(lockIdx);
      assigned.push({ ...c, color: lock.color, colorLabel: lock.label, locked: true, writeIn: false });
    } else if (isWriteIn(c.name, candidatesConfig)) {
      assigned.push({ ...c, color: writeInColor, colorLabel: 'Neutral', locked: false, writeIn: true });
    } else {
      assigned.push({ ...c, color: null, colorLabel: null, locked: false, writeIn: false });
    }
  }

  // Pass 2: everyone else takes the palette in source order.
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
      c.color = writeInColor;
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
/**
 * Blend a candidate colour toward the page background by `strength`, so margin
 * of victory reads as colour intensity within one hue. Shared by the map, the
 * legend ramp and the district scoreboard.
 */
export function tintColor(hex, strength, blendTarget = '#FFFFFF') {
  const s = Math.max(0, Math.min(1, strength ?? 1));
  const parse = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [r, g, b] = parse(hex);
  const bg = parse(blendTarget);
  const mix = (c, t) => Math.round(t + (c - t) * s);
  return `rgb(${mix(r, bg[0])}, ${mix(g, bg[1])}, ${mix(b, bg[2])})`;
}

export function marginStrength(margin, marginConfig) {
  const { lightestMargin, fullStrengthMargin, minOpacity, maxOpacity } = marginConfig;
  if (!Number.isFinite(margin)) return minOpacity;
  const m = Math.max(0, margin);
  if (m <= lightestMargin) return minOpacity;
  if (m >= fullStrengthMargin) return maxOpacity;
  const t = (m - lightestMargin) / (fullStrengthMargin - lightestMargin);
  return minOpacity + t * (maxOpacity - minOpacity);
}
