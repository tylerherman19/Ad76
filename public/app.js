/* ==========================================================================
   AD76 live results — frontend.

   Two independent concerns, deliberately kept separate:

   1. GEOMETRY renders immediately from /api/wards.geojson. The map is fully
      drawn — every ward outlined and filled neutral grey — before any result
      exists, and stays drawn if the results endpoint is failing.

   2. RESULTS arrive from /api/results and only ever repaint fills and text.

   The refresh schedule is NOT owned here. The countdown counts toward the
   server's `schedule.nextScheduledFetchAt`, so every tab and device shows the
   same number, and a force refresh from any visitor moves it for all of them.
   ========================================================================== */

import { createPipeline } from '/pipeline.js';

let pipeline = null;

const els = {
  map: document.getElementById('map'),
  mapDetail: document.getElementById('mapdetail'),
  mapHint: document.getElementById('map-hint'),
  raceNote: document.getElementById('race-note'),
  reportingValue: document.getElementById('reporting-value'),
  reportingFill: document.getElementById('reporting-fill'),
  countdown: document.getElementById('countdown'),
  countdownSub: document.getElementById('countdown-sub'),
  lastFetch: document.getElementById('last-fetch'),
  countyUpdated: document.getElementById('county-updated'),
  staleBadge: document.getElementById('stale-badge'),
  refreshBtn: document.getElementById('refresh-btn'),
  refreshHint: document.getElementById('refresh-hint'),
  summaryLead: document.getElementById('summary-lead'),
  summaryBars: document.getElementById('summary-bars'),
  legendCandidates: document.getElementById('legend-candidates'),
  legendRamp: document.getElementById('legend-ramp'),
  rampMin: document.getElementById('ramp-min'),
  rampMax: document.getElementById('ramp-max'),
  tableWrap: document.getElementById('tablewrap'),
  groupingNote: document.getElementById('grouping-note'),
  expandAll: document.getElementById('expand-all'),
  collapseAll: document.getElementById('collapse-all'),
  footerSource: document.getElementById('footer-source'),
  footerMatch: document.getElementById('footer-match'),
  footerDiagnostics: document.getElementById('footer-diagnostics'),
  scoreboardGrid: document.getElementById('scoreboard-grid'),
  scoreboardNote: document.getElementById('scoreboard-note'),
  viewWard: document.getElementById('view-ward'),
  viewDistrict: document.getElementById('view-district'),
  trendWrap: document.getElementById('trend-wrap'),
  trendSpark: document.getElementById('trend-spark'),
  toastStack: document.getElementById('toast-stack'),
  soundToggle: document.getElementById('sound-toggle'),
  soundToggleLabel: document.getElementById('sound-toggle-label'),
};

const NO_DATA_COLOR = '#d6d6d6';
const BLEND_TARGET = '#FFFFFF';
const isTouch = !window.matchMedia('(hover: hover) and (pointer: fine)').matches;
const isNarrow = () => window.matchMedia('(max-width: 900px)').matches;

const state = {
  payload: null,
  schedule: null,
  display: { noDataColor: NO_DATA_COLOR, margin: {} },
  selectedUnitId: null,
  selectedGroupKey: null,
  // 'ward'     -> every ward coloured by its own leader
  // 'district' -> wards coloured by their alder district's / municipality's
  //               leader, with ward borders suppressed so districts read as
  //               single shapes. Answers "are we winning district 12".
  view: 'ward',
  openGroups: null,   // Set of group keys, initialised from viewport width
  openCards: new Set(),
  layersByWardKey: new Map(),
  pollTimer: null,
  refreshLockUntil: 0,
  soundEnabled: localStorage.getItem('ad76-sound') === '1',
};

/* --------------------------------------------------------------- helpers */

const fmtInt = (n) => (n === null || n === undefined ? '—' : n.toLocaleString('en-US'));
const fmtPct = (p, digits = 1) => (p === null || p === undefined ? '—' : `${p.toFixed(digits)}%`);

function fmtClock(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

function fmtAgo(iso) {
  if (!iso) return 'never';
  const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 5) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s ago`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m ago`;
}

/**
 * Blend a candidate colour toward the page background so margin of victory
 * reads as colour intensity within a single hue. On the light theme the blend
 * target is white, so a narrow win is a pale tint of the winner's colour.
 */
function tint(hex, strength) {
  const s = Math.max(0, Math.min(1, strength ?? 1));
  const parse = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [r, g, b] = parse(hex);
  const bg = parse(state.display?.margin?.blendTarget ?? BLEND_TARGET);
  const mix = (c, t) => Math.round(t + (c - t) * s);
  return `rgb(${mix(r, bg[0])}, ${mix(g, bg[1])}, ${mix(b, bg[2])})`;
}

/** The group (alder district or municipality) a reporting unit belongs to. */
function groupForUnitId(unitId) {
  return state.payload?.groups.find((g) => g.unitIds.includes(unitId)) ?? null;
}
function groupForWardKey(wardKey) {
  const fill = state.payload?.wardFill?.[wardKey];
  return fill?.unitId ? groupForUnitId(fill.unitId) : null;
}

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function unitById(id) {
  return state.payload?.units.find((u) => u.id === id) ?? null;
}
function unitForWardKey(wardKey) {
  const fill = state.payload?.wardFill?.[wardKey];
  return fill?.unitId ? unitById(fill.unitId) : null;
}

/* ------------------------------------------------------------------- map */

let map = null;
let wardLayer = null;

function baseStyle(wardKey) {
  const fill = state.payload?.wardFill?.[wardKey];
  const noData = state.display.noDataColor || NO_DATA_COLOR;

  if (state.view === 'district') {
    // Colour by the ward's alder district (or municipality) rather than by the
    // ward itself, and paint the ward border in the fill colour so internal
    // boundaries disappear and each district reads as one shape.
    const group = groupForWardKey(wardKey);
    const selected = group && group.key === state.selectedGroupKey;
    const lead = group?.leader;
    let color = noData;
    if (lead && !lead.tied) color = tint(lead.color, lead.strength ?? 1);
    else if (lead?.tied) color = '#b9bec4';
    return {
      color: selected ? '#1a1a1a' : color,
      weight: selected ? 2.5 : 1,
      opacity: 1,
      fillColor: color,
      fillOpacity: 1,
    };
  }

  const selected = fill?.unitId && fill.unitId === state.selectedUnitId;
  let fillColor = noData;
  if (fill?.reported && fill.color) fillColor = tint(fill.color, fill.strength ?? 1);
  else if (fill?.reported && fill.tied) fillColor = '#b9bec4';

  return {
    color: selected ? '#1a1a1a' : '#ffffff',
    weight: selected ? 2.5 : 0.8,
    opacity: 1,
    fillColor,
    fillOpacity: 1,
  };
}

function restyleAll() {
  for (const [wardKey, layer] of state.layersByWardKey) layer.setStyle(baseStyle(wardKey));
}

async function initMap() {
  map = L.map(els.map, {
    zoomControl: true,
    attributionControl: true,
    scrollWheelZoom: false, // avoid hijacking page scroll; box/pinch zoom still work
    tap: true,
    // Fractional zoom. With Leaflet's default integer snapping, fitBounds picks
    // the largest whole zoom that fits and can leave the district at half the
    // size the container allows.
    zoomSnap: 0,
    zoomDelta: 0.5,
  });
  map.attributionControl.setPrefix('');
  map.addAttribution?.('');

  // The geometry is the whole page. A single transient failure here used to
  // leave a permanently blank map until somebody reloaded the tab by hand —
  // which is not something a viewer will do, and not something we can ask them
  // to do at 21:30. Retry with backoff, indefinitely, and say what is happening.
  let geo = null;
  for (let attempt = 1; !geo; attempt++) {
    try {
      geo = await pipeline.wardsGeoJson();
    } catch (err) {
      const delay = Math.min(2000 * 2 ** (attempt - 1), 30000);
      els.mapHint.textContent = `Ward boundaries could not be loaded (${err.message}). Retrying in ${Math.round(
        delay / 1000,
      )}s…`;
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  wardLayer = L.geoJSON(geo, {
    style: (f) => baseStyle(f.properties.wardKey),
    onEachFeature: (feature, layer) => {
      const wardKey = feature.properties.wardKey;
      state.layersByWardKey.set(wardKey, layer);

      if (isTouch) {
        layer.on('click', () => selectWardKey(wardKey, { scrollTable: true }));
      } else {
        layer.on('mouseover', () => selectWardKey(wardKey, { scrollTable: false }));
        layer.on('click', () => selectWardKey(wardKey, { scrollTable: true }));
      }
      layer.on('keydown', (e) => {
        if (e.originalEvent.key === 'Enter' || e.originalEvent.key === ' ') selectWardKey(wardKey, { scrollTable: true });
      });
    },
  }).addTo(map);

  // Fit once now, then again whenever the container is actually resized.
  // Leaflet measures the container on creation, which can happen before the
  // grid has settled its final width — without this the district renders
  // under-zoomed in a mostly empty box.
  const fit = () => {
    map.invalidateSize({ animate: false });
    map.fitBounds(wardLayer.getBounds(), { padding: [14, 14] });
  };
  fit();
  requestAnimationFrame(fit);

  if (window.ResizeObserver) {
    let settled = false;
    new ResizeObserver(() => {
      map.invalidateSize({ animate: false });
      // Only auto-refit until the user has interacted; after that, respect
      // whatever they have panned/zoomed to.
      if (!settled) map.fitBounds(wardLayer.getBounds(), { padding: [14, 14] });
    }).observe(els.map);
    map.once('zoomstart dragstart', () => { settled = true; });
  }

  map.attributionControl.addAttribution('Boundaries: Dane County GIS');

  els.mapHint.textContent = isTouch
    ? 'Tap a ward for its full breakdown.'
    : 'Hover a ward for its full breakdown; click to jump to its row.';
}

/* ------------------------------------------------- selection & linkage */

/**
 * Single selection path for both directions of the map ↔ table link:
 * map hover/tap and table row tap both land here, so the two views can never
 * disagree about which ward is active.
 */
function selectWardKey(wardKey, { scrollTable = false } = {}) {
  if (state.view === 'district') {
    const group = groupForWardKey(wardKey);
    return selectGroup(group?.key ?? null, { scrollTable });
  }
  const unit = unitForWardKey(wardKey);
  selectUnit(unit?.id ?? null, { scrollTable });
}

/** Select a whole alder district / municipality (district view). */
function selectGroup(groupKey, { scrollTable = false } = {}) {
  state.selectedGroupKey = groupKey;
  state.selectedUnitId = null;
  restyleAll();
  renderDetail();
  renderScoreboard();
  for (const el of document.querySelectorAll('[data-group-key]')) {
    el.classList.toggle('is-linked', el.dataset.groupKey === groupKey);
  }
  for (const el of document.querySelectorAll('[data-unit-id]')) el.classList.remove('is-linked');
  if (scrollTable && groupKey) {
    document.querySelector(`[data-group-key="${CSS.escape(groupKey)}"][data-row]`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

function selectUnit(unitId, { scrollTable = false, panMap = false } = {}) {
  state.selectedUnitId = unitId;
  state.selectedGroupKey = null;
  restyleAll();
  renderDetail();
  syncTableHighlight(scrollTable);

  if (panMap && unitId) {
    const unit = unitById(unitId);
    const layer = unit?.wardKeys.map((k) => state.layersByWardKey.get(k)).find(Boolean);
    if (layer && !map.getBounds().intersects(layer.getBounds())) {
      map.fitBounds(layer.getBounds(), { padding: [40, 40], maxZoom: map.getZoom() });
    }
  }
}

function syncTableHighlight(scrollIntoView) {
  const id = state.selectedUnitId;
  for (const el of document.querySelectorAll('[data-unit-id]')) {
    el.classList.toggle('is-linked', el.dataset.unitId === id);
  }
  if (!scrollIntoView || !id) return;

  // Make sure the row's group is open before scrolling to it.
  const unit = unitById(id);
  const group = state.payload?.groups.find((g) => g.unitIds.includes(id));
  if (group && state.openGroups && !state.openGroups.has(group.key)) {
    state.openGroups.add(group.key);
    renderTable();
    syncTableHighlight(false);
  }
  const target = document.querySelector(`[data-unit-id="${CSS.escape(id)}"]`);
  target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  void unit;
}

function renderDetail() {
  if (state.view === 'district') return renderGroupDetail();
  const unit = state.selectedUnitId ? unitById(state.selectedUnitId) : null;
  if (!unit) {
    els.mapDetail.innerHTML = `<p class="mapdetail__empty">${
      isTouch ? 'Tap' : 'Select'
    } a ward to see its five-candidate breakdown.</p>`;
    return;
  }

  const colorOf = new Map((state.payload?.candidates ?? []).map((c) => [c.name, c.color]));
  const group =
    unit.alderDistrict ? `Alder District ${unit.alderDistrict}` : unit.municipality;

  let body;
  if (!unit.reported) {
    body = '<p class="mapdetail__status">Not yet reporting.</p>';
  } else {
    const rows = [...unit.candidates].sort((a, b) => (b.votes ?? -1) - (a.votes ?? -1));
    const leadName = unit.leader?.tied ? null : unit.leader?.name;
    body =
      '<ul class="mapdetail__rows">' +
      rows
        .map(
          (r) => `<li class="mapdetail__row ${r.name === leadName ? 'mapdetail__row--lead' : ''}">
            <span class="chip" style="background:${colorOf.get(r.name) ?? NO_DATA_COLOR}"></span>
            <span class="mapdetail__row-name">${escapeHtml(r.name)}</span>
            <span class="mapdetail__row-num"><b>${fmtInt(r.votes)}</b> · ${fmtPct(r.percent)}</span>
          </li>`,
        )
        .join('') +
      '</ul>' +
      `<p class="mapdetail__total">${fmtInt(unit.totalVotes)} votes counted${
        unit.leader && !unit.leader.tied
          ? ` · lead ${(unit.leader.margin * 100).toFixed(1)} pts`
          : unit.leader?.tied
            ? ' · tied'
            : ''
      }</p>`;
  }

  const wardCount = unit.wardKeys.length;
  els.mapDetail.innerHTML =
    `<p class="mapdetail__ward">${escapeHtml(unit.label)}</p>` +
    `<p class="mapdetail__meta">${escapeHtml(group)}${
      wardCount > 1 ? ` · one reporting unit covering ${wardCount} wards` : ''
    }</p>` +
    body;
}

/** Detail panel contents when the map is in alder-district view. */
function renderGroupDetail() {
  const group = state.selectedGroupKey
    ? state.payload?.groups.find((g) => g.key === state.selectedGroupKey)
    : null;

  if (!group) {
    els.mapDetail.innerHTML = `<p class="mapdetail__empty">${
      isTouch ? 'Tap' : 'Select'
    } an alder district to see its combined five-candidate totals.</p>`;
    return;
  }

  const colorOf = new Map((state.payload?.candidates ?? []).map((c) => [c.name, c.color]));
  let body;
  if (group.totalVotes === null) {
    body = '<p class="mapdetail__status">No wards in this district have reported.</p>';
  } else {
    const rows = [...group.candidates].sort((a, b) => (b.votes ?? -1) - (a.votes ?? -1));
    const leadName = group.leader?.tied ? null : group.leader?.name;
    body =
      '<ul class="mapdetail__rows">' +
      rows
        .map(
          (r) => `<li class="mapdetail__row ${r.name === leadName ? 'mapdetail__row--lead' : ''}">
            <span class="chip" style="background:${colorOf.get(r.name) ?? NO_DATA_COLOR}"></span>
            <span class="mapdetail__row-name">${escapeHtml(r.name)}</span>
            <span class="mapdetail__row-num"><b>${fmtInt(r.votes)}</b> · ${fmtPct(r.percent)}</span>
          </li>`,
        )
        .join('') +
      '</ul>' +
      `<p class="mapdetail__total">${fmtInt(group.totalVotes)} votes · ${group.reportedUnits} of ${group.totalUnits} wards reporting${
        group.leader && !group.leader.tied ? ` · lead ${(group.leader.margin * 100).toFixed(1)} pts` : group.leader?.tied ? ' · tied' : ''
      }</p>`;
  }

  els.mapDetail.innerHTML =
    `<p class="mapdetail__ward">${escapeHtml(group.label)}</p>` +
    `<p class="mapdetail__meta">${group.kind === 'alder' ? 'City of Madison' : 'Outside Madison'} · ${group.totalUnits} ward${group.totalUnits === 1 ? '' : 's'}</p>` +
    body;
}

/**
 * Alder district scoreboard — one card per district showing who leads it.
 * This is the "are we winning district 12" view: it reads as a scoreboard
 * rather than something you have to add up from the ward table.
 */
function renderScoreboard() {
  const p = state.payload;
  if (!p) return;

  const decided = p.groups.filter((g) => g.leader && !g.leader.tied);
  const wins = new Map();
  for (const g of decided) wins.set(g.leader.name, (wins.get(g.leader.name) ?? 0) + 1);
  const tally = [...wins.entries()].sort((a, b) => b[1] - a[1]);

  els.scoreboardNote.textContent = decided.length
    ? `Leading in ${decided.length} of ${p.groups.length} districts — ` +
      tally.map(([n, c]) => `${n} ${c}`).join(' · ')
    : 'No district has reported yet.';

  const colorOf = new Map(p.candidates.map((c) => [c.name, c.color]));

  els.scoreboardGrid.innerHTML = p.groups
    .map((g) => {
      const lead = g.leader;
      const accent = lead && !lead.tied ? lead.color : 'transparent';
      const body = !lead
        ? '<span class="scorecard__pending">Not yet reporting</span>'
        : lead.tied
          ? '<span class="scorecard__pending">Tied</span>'
          : `<span class="scorecard__leader"><span class="chip" style="background:${colorOf.get(lead.name) ?? NO_DATA_COLOR}"></span><span>${escapeHtml(lead.name)}</span></span>
             <span class="scorecard__margin">${fmtPct(lead.percent, 1)} · +${(lead.margin * 100).toFixed(1)} pts</span>`;

      return `<button class="scorecard ${g.key === state.selectedGroupKey ? 'is-linked' : ''}" type="button"
                data-group-key="${escapeHtml(g.key)}" style="border-left-color:${accent}">
          <span class="scorecard__name">${escapeHtml(g.label)}</span>
          <span class="scorecard__kind">${g.kind === 'alder' ? 'City of Madison' : 'Outside Madison'} · ${g.reportedUnits}/${g.totalUnits} wards</span>
          ${body}
        </button>`;
    })
    .join('');
}

/* ----------------------------------------------------------- momentum */

/** Sparkline of the district-wide leading margin across every successful fetch. */
function renderTrend() {
  const points = state.payload?.trend ?? [];
  if (points.length < 2) {
    els.trendWrap.hidden = true;
    return;
  }
  els.trendWrap.hidden = false;

  const w = 600, h = 46, pad = 3;
  const maxMargin = Math.max(10, (state.display?.margin?.fullStrengthMargin ?? 0.5) * 100);
  const n = points.length;
  const x = (i) => pad + (i / (n - 1)) * (w - pad * 2);
  const y = (m) => {
    const v = Math.max(0, Math.min(maxMargin, m ?? 0));
    return h - pad - (v / maxMargin) * (h - pad * 2);
  };

  let segs = '';
  for (let i = 1; i < n; i++) {
    const a = points[i - 1];
    const b = points[i];
    const color = b.tied ? '#b9bec4' : b.leaderColor ?? NO_DATA_COLOR;
    segs += `<line x1="${x(i - 1).toFixed(1)}" y1="${y(a.marginPct).toFixed(1)}" x2="${x(i).toFixed(1)}" y2="${y(b.marginPct).toFixed(1)}" stroke="${color}" stroke-width="2" stroke-linecap="round" />`;
  }
  const last = points[n - 1];
  const dotColor = last.tied ? '#b9bec4' : last.leaderColor ?? NO_DATA_COLOR;

  els.trendSpark.innerHTML =
    `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Leading margin over the course of the night">` +
    segs +
    `<circle cx="${x(n - 1).toFixed(1)}" cy="${y(last.marginPct).toFixed(1)}" r="3.5" fill="${dotColor}" />` +
    `</svg>`;
}

/* -------------------------------------------------------- milestone alerts */

let audioCtx = null;
function ensureAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

/** Short synthesised beep — no audio asset to fetch or fail to load. */
function playAlertSound() {
  if (!state.soundEnabled || !audioCtx) return;
  const ctx = audioCtx;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = 720;
  osc.type = 'sine';
  gain.gain.setValueAtTime(0.0001, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
  osc.connect(gain).connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + 0.4);
}

let toastSeq = 0;
function pushToast(text, kind = 'leader') {
  const el = document.createElement('div');
  el.className = `toast toast--${kind}`;
  el.id = `toast-${++toastSeq}`;
  el.textContent = text;
  els.toastStack.appendChild(el);
  playAlertSound();
  setTimeout(() => {
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 400);
  }, 8000);
}

/**
 * Diff the previous and current payload for things worth interrupting for:
 * the district-wide leader flipping, a district finishing, or the whole
 * district hitting 100%. Never fires on the first load (prev is null) and
 * never treats a tie as a "flip" in either direction.
 */
function checkMilestones(prev, next) {
  if (!prev || !next) return;

  const prevLeader = prev.summary?.leader && !prev.summary.leader.tied ? prev.summary.leader.name : null;
  const nextLeader = next.summary?.leader && !next.summary.leader.tied ? next.summary.leader.name : null;
  if (prevLeader && nextLeader && prevLeader !== nextLeader) {
    pushToast(`District lead flips: ${nextLeader} overtakes ${prevLeader}`, 'leader');
  }

  const prevByKey = new Map((prev.groups ?? []).map((g) => [g.key, g]));
  for (const g of next.groups ?? []) {
    const before = prevByKey.get(g.key);
    if (before && g.totalUnits > 0 && before.reportedUnits < before.totalUnits && g.reportedUnits === g.totalUnits) {
      const lead = g.leader && !g.leader.tied ? ` — ${g.leader.name} leads` : '';
      pushToast(`${g.label} fully reported${lead}`, 'district');
    }
  }

  const pr = prev.reporting;
  const nr = next.reporting;
  if (pr && nr && nr.wardsTotal > 0 && pr.wardsReported < pr.wardsTotal && nr.wardsReported === nr.wardsTotal) {
    pushToast('All AD76 wards have reported.', 'district');
  }
}

els.soundToggle.addEventListener('click', () => {
  state.soundEnabled = !state.soundEnabled;
  localStorage.setItem('ad76-sound', state.soundEnabled ? '1' : '0');
  els.soundToggle.setAttribute('aria-pressed', String(state.soundEnabled));
  els.soundToggleLabel.textContent = state.soundEnabled ? '🔔 Alerts on' : '🔕 Alerts muted';
  if (state.soundEnabled) {
    ensureAudioCtx();
    playAlertSound();
  }
});
els.soundToggle.setAttribute('aria-pressed', String(state.soundEnabled));
els.soundToggleLabel.textContent = state.soundEnabled ? '🔔 Alerts on' : '🔕 Alerts muted';
if (state.soundEnabled) ensureAudioCtx();

/* --------------------------------------------------------------- status */

function renderStatus() {
  const p = state.payload;
  const s = state.schedule;
  if (!p || !s) return;

  const r = p.reporting;
  els.reportingValue.textContent = `${r.wardsReported} of ${r.wardsTotal}`;
  const pctReporting = r.wardsTotal ? (r.wardsReported / r.wardsTotal) * 100 : 0;
  els.reportingFill.style.width = `${pctReporting}%`;

  els.lastFetch.textContent = s.lastSuccessAt ? `${fmtClock(s.lastSuccessAt)} (${fmtAgo(s.lastSuccessAt)})` : 'not yet';

  // There is no backend in the static build, so do not call it one.
  const staticMode = s.sharedStateAvailable === false;
  document.querySelector('#last-fetch').previousElementSibling.textContent =
    staticMode ? 'This page last fetched' : 'Backend last fetched';
  document.querySelector('#last-fetch').nextElementSibling.textContent =
    staticMode ? 'this browser\u2019s read of the county API' : 'our successful read of the county site';
  els.countyUpdated.textContent = p.source.countyUpdatedAt
    ? fmtClock(p.source.countyUpdatedAt)
    : p.awaitingResults
      ? 'not published yet'
      : '—';

  // Say plainly whether the schedule is genuinely shared or wall-clock derived.
  if (!state.refreshLockUntil) {
    els.refreshHint.textContent = s.sharedStateAvailable === false ? 'refreshes this browser' : 'refreshes for everyone';
  }

  els.countdownSub.textContent =
    s.phase === 'active'
      ? `every ${Math.round((s.intervalMs ?? 0) / 1000)}s while results come in`
      : `every ${Math.round((s.intervalMs ?? 0) / 1000)}s until the first ward reports`;

  // Stale / failure indicator: never show old numbers as if they were current.
  const problems = [];
  if (s.stale && s.lastSuccessAt) problems.push(`Data stale — last successful fetch ${fmtAgo(s.lastSuccessAt)}`);
  if (!s.lastSuccessAt) problems.push('No successful fetch yet');
  if (s.consecutiveFailures > 0) problems.push(`${s.consecutiveFailures} failed fetch${s.consecutiveFailures > 1 ? 'es' : ''} in a row`);

  if (problems.length) {
    els.staleBadge.textContent = problems.join(' · ');
    els.staleBadge.classList.remove('badge--hidden');
  } else {
    els.staleBadge.classList.add('badge--hidden');
  }

  els.raceNote.textContent = p.awaitingResults
    ? 'Results have not been published yet. Ward boundaries and the candidate field are shown below; no vote totals exist.'
    : `${p.election.raceName ?? 'Ward-level results'} — updated live from the Dane County Clerk.`;

  const srcBits = [`Source: Dane County Clerk (${p.source.mode})`];
  if (p.source.fellBackFrom) srcBits.push(`fell back from ${p.source.fellBackFrom}`);
  els.footerSource.textContent = srcBits.join(' · ') + '.';

  // In server mode the health/log endpoints exist; on static hosting they do
  // not, so surface the same diagnostics inline instead of linking nowhere.
  if (s.sharedStateAvailable === false) {
    const problems = (p.matching?.unmatched ?? []).map((u) => `${u.precinctName}: ${u.reason}`);
    els.footerDiagnostics.textContent = problems.length
      ? `Ward-match problems: ${problems.join('; ')}`
      : 'Static build: no backend, so each visitor reads the county API directly. ' +
        'The countdown is derived from the clock, so all visitors share it; force refresh affects only your browser.';
  } else {
    els.footerDiagnostics.innerHTML =
      'Pipeline status: <a href="/api/health">/api/health</a> · <a href="/api/logs">/api/logs</a>';
  }

  const m = p.matching;
  els.footerMatch.textContent = m
    ? ` Matched ${m.matchedUnits}/${m.reportingUnits} reporting units to ${m.wardsCovered}/${m.wardsInLayer} wards${
        m.unmatched?.length ? ` — ${m.unmatched.length} need review (see /api/health)` : ''
      }.`
    : '';
}

function tickCountdown() {
  const s = state.schedule;
  if (!s?.nextScheduledFetchAt) {
    els.countdown.textContent = '—';
    return;
  }
  // Correct for clock skew between browser and server using serverTime.
  const skew = state.clockSkewMs ?? 0;
  const msLeft = new Date(s.nextScheduledFetchAt).getTime() - (Date.now() + skew);
  if (msLeft <= 0) {
    els.countdown.textContent = 'refreshing…';
    return;
  }
  const secs = Math.ceil(msLeft / 1000);
  els.countdown.textContent = secs >= 60 ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : `${secs}s`;

  // Re-enable the force button once the server-side cooldown has passed.
  if (state.refreshLockUntil && Date.now() > state.refreshLockUntil) {
    state.refreshLockUntil = 0;
    els.refreshBtn.disabled = false;
    // Must match renderStatus(): in the static build this button only refreshes
    // the clicking browser, and hardcoding "for everyone" here quietly undid the
    // honest label a few seconds after every click.
    els.refreshHint.textContent =
      state.schedule?.sharedStateAvailable === false ? 'refreshes this browser' : 'refreshes for everyone';
  }
}

/* -------------------------------------------------------------- summary */

function renderSummary() {
  const p = state.payload;
  if (!p) return;

  const lead = p.summary.leader;
  if (!lead || p.summary.totalVotes === null) {
    // Three genuinely different states, and calling the third one "no wards
    // have reported" would contradict the ward counter right beside it.
    const pending = p.awaitingResults
      ? 'Results have not been published yet.'
      : p.reporting.wardsReported > 0
        ? `${p.reporting.wardsReported} of ${p.reporting.wardsTotal} wards reporting, no votes recorded in them yet.`
        : 'No wards have reported yet.';
    els.summaryLead.innerHTML = `<p class="summary__pending">${pending}</p>`;
  } else if (lead.tied) {
    els.summaryLead.innerHTML =
      `<div class="summary__leadline"><span class="summary__leadname">Tied</span>` +
      `<span class="summary__leadmeta">${fmtInt(p.summary.totalVotes)} votes counted</span></div>`;
  } else {
    els.summaryLead.innerHTML =
      `<div class="summary__leadline">` +
      `<span class="chip" style="background:${lead.color ?? NO_DATA_COLOR};width:14px;height:14px"></span>` +
      `<span class="summary__leadname">${escapeHtml(lead.name)}</span>` +
      `<span class="summary__leadmeta">leads by ${(lead.margin * 100).toFixed(1)} pts</span>` +
      `</div>` +
      `<p class="summary__total">${fmtInt(p.summary.totalVotes)} votes counted · ` +
      `${p.reporting.wardsReported} of ${p.reporting.wardsTotal} wards reporting (${fmtPct(
        p.reporting.wardsTotal ? (p.reporting.wardsReported / p.reporting.wardsTotal) * 100 : 0,
        0,
      )})</p>`;
  }

  const colorOf = new Map(p.candidates.map((c) => [c.name, c.color]));
  const rows = [...p.summary.candidates].sort((a, b) => (b.votes ?? -1) - (a.votes ?? -1));
  const max = Math.max(1, ...rows.map((r) => r.percent ?? 0));

  els.summaryBars.innerHTML = rows
    .map(
      (r) => `<li class="sumrow">
        <span class="sumrow__name"><span class="chip" style="background:${colorOf.get(r.name) ?? NO_DATA_COLOR}"></span><span>${escapeHtml(r.name)}</span></span>
        <span class="sumrow__track"><span class="sumrow__fill" style="width:${
          r.percent === null ? 0 : (r.percent / max) * 100
        }%;background:${colorOf.get(r.name) ?? NO_DATA_COLOR}"></span></span>
        <span class="sumrow__num">${r.votes === null ? '<span class="notreporting">no results</span>' : `<b>${fmtInt(r.votes)}</b> · ${fmtPct(r.percent)}`}</span>
      </li>`,
    )
    .join('');
}

/* --------------------------------------------------------------- legend */

function renderLegend() {
  const p = state.payload;
  if (!p) return;

  els.legendCandidates.innerHTML = p.candidates
    .map(
      (c) => `<span class="legend__item ${c.writeIn ? 'legend__item--writein' : ''}">
        <span class="legend__swatch" style="background:${c.color}"></span>${escapeHtml(c.name)}
      </span>`,
    )
    .join('');

  // Ramp is drawn from an actual candidate colour so it reads as the same scale
  // the map uses. Uses the leader's colour when there is one.
  const rampColor = p.summary.leader?.color ?? p.candidates.find((c) => !c.writeIn)?.color ?? '#56B4E9';
  const m = state.display.margin ?? {};
  const stops = [0, 0.25, 0.5, 0.75, 1].map((t) => {
    const s = (m.minOpacity ?? 0.28) + t * ((m.maxOpacity ?? 1) - (m.minOpacity ?? 0.28));
    return `${tint(rampColor, s)} ${t * 100}%`;
  });
  els.legendRamp.style.background = `linear-gradient(90deg, ${stops.join(', ')})`;
  els.rampMin.textContent = `≤${Math.round((m.lightestMargin ?? 0.1) * 100)} pts`;
  els.rampMax.textContent = `≥${Math.round((m.fullStrengthMargin ?? 0.5) * 100)} pts`;
}

/* ----------------------------------------------------------------- table */

function candidateHeaderCells(candidates) {
  return candidates
    .map(
      (c) => `<th scope="col" colspan="2"><span class="th-cand"><span class="chip" style="background:${c.color}"></span><span>${escapeHtml(
        c.name,
      )}</span></span></th>`,
    )
    .join('');
}

function voteCells(rows, candidates) {
  return candidates
    .map((c) => {
      const r = rows.find((x) => x.name === c.name);
      if (!r || r.votes === null) return '<td class="num">—</td><td class="pct">—</td>';
      return `<td class="num">${fmtInt(r.votes)}</td><td class="pct">${fmtPct(r.percent)}</td>`;
    })
    .join('');
}

function renderGroupDesktop(group, candidates) {
  const units = group.unitIds.map(unitById).filter(Boolean);
  const rows = units
    .map((u) => {
      const cells = u.reported
        ? voteCells(u.candidates, candidates)
        : `<td class="notreporting" colspan="${candidates.length * 2}">Not yet reporting</td>`;
      return `<tr class="wardrow ${u.reported ? '' : 'is-unreported'}" data-unit-id="${escapeHtml(u.id)}" tabindex="0">
        <td class="ward-name">${escapeHtml(u.label)}</td>${cells}
        <td class="num">${u.reported ? fmtInt(u.totalVotes) : '—'}</td>
      </tr>`;
    })
    .join('');

  const subtotal = `<tr class="subtotal">
      <td class="ward-name">Subtotal — ${escapeHtml(group.label)}</td>
      ${group.totalVotes === null ? `<td class="notreporting" colspan="${candidates.length * 2}">No wards reporting</td>` : voteCells(group.candidates, candidates)}
      <td class="num">${group.totalVotes === null ? '—' : fmtInt(group.totalVotes)}</td>
    </tr>`;

  return `<table class="results">
      <thead><tr><th scope="col">Ward</th>${candidateHeaderCells(candidates)}<th scope="col">Total</th></tr></thead>
      <tbody>${rows}${subtotal}</tbody>
    </table>`;
}

function renderGroupMobile(group, candidates) {
  const colorOf = new Map(candidates.map((c) => [c.name, c.color]));
  const units = group.unitIds.map(unitById).filter(Boolean);

  const cards = units
    .map((u) => {
      const open = state.openCards.has(u.id);
      let head;
      if (!u.reported) {
        head = `<span class="chip" style="background:${NO_DATA_COLOR}"></span>
          <span><span class="cardrow__ward">${escapeHtml(u.shortLabel)}</span><br><span class="cardrow__lead notreporting">Not yet reporting</span></span>
          <span class="cardrow__total">—</span>`;
      } else {
        const lead = u.leader;
        const leadText = lead?.tied ? 'Tied' : `${lead?.name ?? '—'} · ${fmtPct(lead?.percent, 0)}`;
        head = `<span class="chip" style="background:${lead?.color ?? NO_DATA_COLOR}"></span>
          <span><span class="cardrow__ward">${escapeHtml(u.shortLabel)}</span><br><span class="cardrow__lead">${escapeHtml(leadText)}</span></span>
          <span class="cardrow__total">${fmtInt(u.totalVotes)}</span>`;
      }

      const detail = u.reported
        ? `<ul class="cardrow__list">${[...u.candidates]
            .sort((a, b) => (b.votes ?? -1) - (a.votes ?? -1))
            .map(
              (r) => `<li class="cardrow__item">
                <span class="chip" style="background:${colorOf.get(r.name) ?? NO_DATA_COLOR}"></span>
                <span>${escapeHtml(r.name)}</span>
                <span class="cardrow__item-num">${fmtInt(r.votes)} · ${fmtPct(r.percent)}</span>
              </li>`,
            )
            .join('')}</ul>`
        : `<p class="cardrow__lead">This ward has not reported. No votes have been published for it.</p>`;

      return `<li class="cardrow" data-unit-id="${escapeHtml(u.id)}" data-open="${open}">
        <button class="cardrow__head" type="button" data-card-toggle="${escapeHtml(u.id)}" aria-expanded="${open}">${head}</button>
        <div class="cardrow__detail">${detail}</div>
      </li>`;
    })
    .join('');

  const sub =
    group.totalVotes === null
      ? `<div class="cardsub"><span class="cardsub__label">Subtotal — ${escapeHtml(group.label)}</span>
           <p class="cardrow__lead notreporting">No wards reporting</p></div>`
      : `<div class="cardsub"><span class="cardsub__label">Subtotal — ${escapeHtml(group.label)} · ${fmtInt(group.totalVotes)} votes</span>
          <ul class="cardsub__list">${[...group.candidates]
            .sort((a, b) => (b.votes ?? -1) - (a.votes ?? -1))
            .map(
              (r) => `<li class="cardrow__item">
                <span class="chip" style="background:${colorOf.get(r.name) ?? NO_DATA_COLOR}"></span>
                <span>${escapeHtml(r.name)}</span>
                <span class="cardrow__item-num">${fmtInt(r.votes)} · ${fmtPct(r.percent)}</span>
              </li>`,
            )
            .join('')}</ul></div>`;

  return `<div class="wardcard"><ul class="cardlist">${cards}</ul>${sub}</div>`;
}

/** Table body when in alder-district view: one row per district, no nesting. */
function renderDistrictTable() {
  const p = state.payload;
  const candidates = p.candidates;
  const colorOf = new Map(candidates.map((c) => [c.name, c.color]));

  const rows = p.groups
    .map((g) => {
      const cells = g.totalVotes === null
        ? `<td class="notreporting" colspan="${candidates.length * 2}">No wards reporting</td>`
        : voteCells(g.candidates, candidates);
      return `<tr class="wardrow ${g.totalVotes === null ? 'is-unreported' : ''}"
                  data-group-key="${escapeHtml(g.key)}" data-row="1" tabindex="0">
          <td class="ward-name">${escapeHtml(g.label)}</td>
          ${cells}
          <td class="num">${g.totalVotes === null ? '—' : fmtInt(g.totalVotes)}</td>
        </tr>`;
    })
    .join('');

  const desktop = `<table class="results">
      <thead><tr><th scope="col">Alder district</th>${candidateHeaderCells(candidates)}<th scope="col">Total</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  const cards = p.groups
    .map((g) => {
      const lead = g.leader;
      const head = `<span class="chip" style="background:${lead && !lead.tied ? lead.color : NO_DATA_COLOR}"></span>
        <span><span class="cardrow__ward">${escapeHtml(g.label)}</span><br><span class="cardrow__lead">${
          !lead ? 'Not yet reporting' : lead.tied ? 'Tied' : `${escapeHtml(lead.name)} · ${fmtPct(lead.percent, 0)}`
        }</span></span>
        <span class="cardrow__total">${g.totalVotes === null ? '—' : fmtInt(g.totalVotes)}</span>`;
      const detail = g.totalVotes === null
        ? '<p class="cardrow__lead">No wards in this district have reported.</p>'
        : `<ul class="cardrow__list">${[...g.candidates]
            .sort((a, b) => (b.votes ?? -1) - (a.votes ?? -1))
            .map((r) => `<li class="cardrow__item">
                <span class="chip" style="background:${colorOf.get(r.name) ?? NO_DATA_COLOR}"></span>
                <span>${escapeHtml(r.name)}</span>
                <span class="cardrow__item-num">${fmtInt(r.votes)} · ${fmtPct(r.percent)}</span>
              </li>`).join('')}</ul>`;
      const open = state.openCards.has(g.key);
      return `<li class="cardrow" data-group-key="${escapeHtml(g.key)}" data-row="1" data-open="${open}">
          <button class="cardrow__head" type="button" data-card-toggle="${escapeHtml(g.key)}" aria-expanded="${open}">${head}</button>
          <div class="cardrow__detail">${detail}</div>
        </li>`;
    })
    .join('');

  return desktop + `<div class="wardcard"><ul class="cardlist">${cards}</ul></div>`;
}

function renderTable() {
  const p = state.payload;
  if (!p) return;
  const candidates = p.candidates;

  document.getElementById('table-heading').textContent =
    state.view === 'district' ? 'Results by alder district' : 'Results by ward';
  document.getElementById('map-heading').textContent =
    state.view === 'district' ? 'Leading candidate by alder district' : 'Leading candidate by ward';

  // Collapsed by default on mobile, expanded by default on desktop.
  if (state.openGroups === null) {
    state.openGroups = new Set(isNarrow() ? [] : p.groups.map((g) => g.key));
  }

  if (state.view === 'district') {
    els.groupingNote.textContent =
      'One row per alder district (City of Madison) or municipality (outside Madison), ' +
      'summing every ward in it. Switch to Ward view for individual wards.';
    els.tableWrap.innerHTML = renderDistrictTable() + renderGrandTotal(p, candidates);
    for (const el of document.querySelectorAll('[data-group-key]')) {
      el.classList.toggle('is-linked', el.dataset.groupKey === state.selectedGroupKey);
    }
    return;
  }

  els.groupingNote.textContent =
    'Wards inside the City of Madison are grouped by alder district. ' +
    'Wards outside Madison have no alder district and are grouped by municipality. ' +
    'Where the county reports two wards as a single unit, they share one row.';

  els.tableWrap.innerHTML =
    p.groups
      .map((g) => {
        const open = state.openGroups.has(g.key);
        return `<section class="group" data-group="${escapeHtml(g.key)}" data-open="${open}">
          <button class="group__toggle" type="button" data-group-toggle="${escapeHtml(g.key)}" aria-expanded="${open}">
            <span class="group__caret">▸</span>
            <span><span class="group__name">${escapeHtml(g.label)}</span><span class="group__kind">${
              g.kind === 'alder' ? 'City of Madison' : 'outside Madison'
            }</span></span>
            <span class="group__count">${g.reportedUnits}/${g.totalUnits} reporting</span>
          </button>
          <div class="group__body">
            ${renderGroupDesktop(g, candidates)}
            ${renderGroupMobile(g, candidates)}
          </div>
        </section>`;
      })
      .join('') +
    renderGrandTotal(p, candidates);

  syncTableHighlight(false);
}

function renderGrandTotal(p, candidates) {
  const colorOf = new Map(candidates.map((c) => [c.name, c.color]));
  const pctReporting = p.reporting.wardsTotal ? (p.reporting.wardsReported / p.reporting.wardsTotal) * 100 : 0;

  const desktop = `<table class="results">
      <thead><tr><th scope="col">District total</th>${candidateHeaderCells(candidates)}<th scope="col">Total</th></tr></thead>
      <tbody><tr class="subtotal">
        <td class="ward-name">All wards</td>
        ${p.summary.totalVotes === null ? `<td class="notreporting" colspan="${candidates.length * 2}">No wards reporting</td>` : voteCells(p.summary.candidates, candidates)}
        <td class="num">${p.summary.totalVotes === null ? '—' : fmtInt(p.summary.totalVotes)}</td>
      </tr></tbody>
    </table>`;

  const mobile = `<div class="wardcard"><div class="cardsub" style="border-top:none">
      <span class="cardsub__label">All wards · ${p.summary.totalVotes === null ? 'no results yet' : `${fmtInt(p.summary.totalVotes)} votes`}</span>
      ${
        p.summary.totalVotes === null
          ? ''
          : `<ul class="cardsub__list">${[...p.summary.candidates]
              .sort((a, b) => (b.votes ?? -1) - (a.votes ?? -1))
              .map(
                (r) => `<li class="cardrow__item">
                  <span class="chip" style="background:${colorOf.get(r.name) ?? NO_DATA_COLOR}"></span>
                  <span>${escapeHtml(r.name)}</span>
                  <span class="cardrow__item-num">${fmtInt(r.votes)} · ${fmtPct(r.percent)}</span>
                </li>`,
              )
              .join('')}</ul>`
      }
    </div></div>`;

  return `<div class="grandtotal">
      <p class="grandtotal__label">District-wide · ${p.reporting.wardsReported} of ${p.reporting.wardsTotal} wards reporting (${fmtPct(pctReporting, 0)})</p>
      ${desktop}${mobile}
    </div>`;
}

/* ------------------------------------------------------------- interaction */

els.tableWrap.addEventListener('click', (e) => {
  const groupBtn = e.target.closest('[data-group-toggle]');
  if (groupBtn) {
    const key = groupBtn.dataset.groupToggle;
    if (state.openGroups.has(key)) state.openGroups.delete(key);
    else state.openGroups.add(key);
    renderTable();
    return;
  }

  const cardBtn = e.target.closest('[data-card-toggle]');
  if (cardBtn) {
    const id = cardBtn.dataset.cardToggle;
    if (state.openCards.has(id)) state.openCards.delete(id);
    else state.openCards.add(id);
    // Tapping a row also highlights it on the map.
    if (state.view === 'district') selectGroup(id);
    else selectUnit(id, { panMap: true });
    renderTable();
    return;
  }

  const row = e.target.closest('tr.wardrow');
  if (row) {
    if (row.dataset.groupKey) selectGroup(row.dataset.groupKey);
    else selectUnit(row.dataset.unitId, { panMap: true });
  }
});

// Scoreboard cards select their district on the map and in the table.
els.scoreboardGrid.addEventListener('click', (e) => {
  const card = e.target.closest('[data-group-key]');
  if (!card) return;
  if (state.view !== 'district') setView('district');
  selectGroup(card.dataset.groupKey, { scrollTable: true });
});

els.tableWrap.addEventListener('keydown', (e) => {
  const row = e.target.closest('tr.wardrow');
  if (row && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    // District-view rows carry a group key and no unit id. Routing them through
    // selectUnit(undefined) cleared the selection instead of making it, so the
    // table was unusable by keyboard in that view — mirror the click handler.
    if (row.dataset.groupKey) selectGroup(row.dataset.groupKey);
    else selectUnit(row.dataset.unitId, { panMap: true });
  }
});

// Desktop: hovering a table row previews it on the map too.
els.tableWrap.addEventListener('mouseover', (e) => {
  if (isTouch) return;
  const row = e.target.closest('tr.wardrow');
  if (!row) return;
  if (row.dataset.groupKey) {
    if (row.dataset.groupKey !== state.selectedGroupKey) selectGroup(row.dataset.groupKey);
  } else if (row.dataset.unitId !== state.selectedUnitId) {
    selectUnit(row.dataset.unitId);
  }
});

/** Switch between ward-level and alder-district-level map + table. */
function setView(view) {
  if (state.view === view) return;
  state.view = view;
  state.selectedUnitId = null;
  state.selectedGroupKey = null;
  els.viewWard.setAttribute('aria-pressed', String(view === 'ward'));
  els.viewDistrict.setAttribute('aria-pressed', String(view === 'district'));
  els.mapHint.textContent =
    view === 'district'
      ? (isTouch ? 'Tap a district for its combined totals.' : 'Hover a district for its combined totals.')
      : (isTouch ? 'Tap a ward for its full breakdown.' : 'Hover a ward for its full breakdown; click to jump to its row.');
  restyleAll();
  renderDetail();
  renderTable();
  renderScoreboard();
}

els.viewWard.addEventListener('click', () => setView('ward'));
els.viewDistrict.addEventListener('click', () => setView('district'));

els.expandAll.addEventListener('click', () => {
  setView('ward');
  state.openGroups = new Set((state.payload?.groups ?? []).map((g) => g.key));
  renderTable();
});
els.collapseAll.addEventListener('click', () => {
  state.openGroups = new Set();
  renderTable();
});

els.refreshBtn.addEventListener('click', async () => {
  els.refreshBtn.disabled = true;
  els.refreshHint.textContent = 'requesting…';
  try {
    const body = await pipeline.forceRefresh();
    applySchedule(body.schedule);

    if (body.debounced) {
      // Server mode: someone else just forced a refresh. Static mode: this
      // browser just did. Either way, say so rather than pretending.
      const secs = Math.ceil((body.retryAfterMs ?? 0) / 1000);
      els.refreshHint.textContent = body.localOnly ? `just refreshed — wait ${secs}s` : `someone else just refreshed — wait ${secs}s`;
      state.refreshLockUntil = Date.now() + (body.retryAfterMs ?? 0);
    } else {
      els.refreshHint.textContent = body.localOnly ? 'refreshed this browser' : 'refreshed for everyone';
      state.refreshLockUntil = Date.now() + (state.schedule?.forceRefreshCooldownMs ?? 12000);
    }
    await loadResults();
  } catch (err) {
    els.refreshHint.textContent = 'refresh failed';
    state.refreshLockUntil = Date.now() + 5000;
  }
});

// Re-render the table when crossing the mobile breakpoint so the default
// collapsed/expanded state matches the viewport the user is actually on.
let wasNarrow = isNarrow();
window.addEventListener('resize', () => {
  const now = isNarrow();
  if (now !== wasNarrow) {
    wasNarrow = now;
    state.openGroups = new Set(now ? [] : (state.payload?.groups ?? []).map((g) => g.key));
    renderTable();
  }
});

/* --------------------------------------------------------------- polling */

function applySchedule(schedule) {
  if (!schedule) return;
  state.schedule = schedule;
  if (schedule.serverTime) state.clockSkewMs = new Date(schedule.serverTime).getTime() - Date.now();
}

async function loadResults() {
  const prevPayload = state.payload;
  try {
    const payload = await pipeline.results();
    state.payload = payload;
    state.display = payload.display ?? state.display;
    applySchedule(payload.schedule);

    if (state.openGroups === null) state.openGroups = new Set(isNarrow() ? [] : payload.groups.map((g) => g.key));

    renderLegend();
    renderSummary();
    renderTrend();
    renderScoreboard();
    renderStatus();
    renderTable();
    restyleAll();
    renderDetail();
    checkMilestones(prevPayload, payload);
  } catch (err) {
    // Leave the last good render in place; the stale badge covers the gap.
    applySchedule(err.schedule);
    if (state.schedule) {
      state.schedule = { ...state.schedule, consecutiveFailures: (state.schedule.consecutiveFailures ?? 0) + 1 };
    }
    renderStatus();
  } finally {
    scheduleNextPoll();
  }
}

/**
 * Poll just after the server's own next scheduled fetch, so clients follow the
 * backend's cadence rather than running their own independent timer.
 */
function scheduleNextPoll() {
  clearTimeout(state.pollTimer);
  const next = state.schedule?.nextScheduledFetchAt;
  let delay = 5000;
  if (next) {
    const skew = state.clockSkewMs ?? 0;
    delay = new Date(next).getTime() - (Date.now() + skew) + 1200;
  }
  delay = Math.min(Math.max(delay, 2500), 30000);
  state.pollTimer = setTimeout(loadResults, delay);
}

/* ------------------------------------------------------------------ boot */

(async () => {
  pipeline = await createPipeline();
  document.body.dataset.mode = pipeline.mode;

  // Geometry and results are deliberately not sequenced. initMap() now retries
  // the boundary fetch until it succeeds, so awaiting it would hold the summary,
  // scoreboard and results table hostage to a slow or flapping geojson request.
  // The map paints itself from state.payload whenever it does arrive.
  initMap().then(restyleAll);

  await loadResults();
  setInterval(tickCountdown, 250);
})();
