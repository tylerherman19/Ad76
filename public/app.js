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
};

const NO_DATA_COLOR = '#3a3a3a';
const isTouch = !window.matchMedia('(hover: hover) and (pointer: fine)').matches;
const isNarrow = () => window.matchMedia('(max-width: 900px)').matches;

const state = {
  payload: null,
  schedule: null,
  display: { noDataColor: NO_DATA_COLOR, margin: {} },
  selectedUnitId: null,
  openGroups: null,   // Set of group keys, initialised from viewport width
  openCards: new Set(),
  layersByWardKey: new Map(),
  pollTimer: null,
  refreshLockUntil: 0,
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

/** Blend a hex colour toward the page background so margin reads as strength. */
function tint(hex, strength) {
  const s = Math.max(0, Math.min(1, strength ?? 1));
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const bg = [14, 15, 17];
  const mix = (c, bgc) => Math.round(bgc + (c - bgc) * s);
  return `rgb(${mix(r, bg[0])}, ${mix(g, bg[1])}, ${mix(b, bg[2])})`;
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
  const selected = fill?.unitId && fill.unitId === state.selectedUnitId;

  let fillColor = state.display.noDataColor || NO_DATA_COLOR;
  let fillOpacity = 0.85;

  if (fill?.reported && fill.color) {
    fillColor = tint(fill.color, fill.strength ?? 1);
    fillOpacity = 0.95;
  } else if (fill?.reported && fill.tied) {
    fillColor = '#5a6068'; // reported but tied: no single leader to colour by
    fillOpacity = 0.9;
  }

  return {
    color: selected ? '#ecebe8' : '#0e0f11',
    weight: selected ? 2.5 : 1,
    opacity: 1,
    fillColor,
    fillOpacity,
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

  let geo;
  try {
    geo = await pipeline.wardsGeoJson();
  } catch (err) {
    els.map.innerHTML =
      '<p style="padding:1.5rem;color:#9ba0a6;font-size:0.875rem">Ward boundaries could not be loaded. ' +
      'Check that data/ad76-wards.geojson was published with the site.</p>';
    return;
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
  const unit = unitForWardKey(wardKey);
  selectUnit(unit?.id ?? null, { scrollTable });
}

function selectUnit(unitId, { scrollTable = false, panMap = false } = {}) {
  state.selectedUnitId = unitId;
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
    els.refreshHint.textContent = 'refreshes for everyone';
  }
}

/* -------------------------------------------------------------- summary */

function renderSummary() {
  const p = state.payload;
  if (!p) return;

  const lead = p.summary.leader;
  if (!lead || p.summary.totalVotes === null) {
    els.summaryLead.innerHTML = `<p class="summary__pending">${
      p.awaitingResults ? 'Results have not been published yet.' : 'No wards have reported yet.'
    }</p>`;
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

function renderTable() {
  const p = state.payload;
  if (!p) return;
  const candidates = p.candidates;

  // Collapsed by default on mobile, expanded by default on desktop.
  if (state.openGroups === null) {
    state.openGroups = new Set(isNarrow() ? [] : p.groups.map((g) => g.key));
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
    // Tapping a ward row also highlights it on the map.
    selectUnit(id, { panMap: true });
    renderTable();
    return;
  }

  const row = e.target.closest('tr.wardrow');
  if (row) selectUnit(row.dataset.unitId, { panMap: true });
});

els.tableWrap.addEventListener('keydown', (e) => {
  const row = e.target.closest('tr.wardrow');
  if (row && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    selectUnit(row.dataset.unitId, { panMap: true });
  }
});

// Desktop: hovering a table row previews it on the map too.
els.tableWrap.addEventListener('mouseover', (e) => {
  if (isTouch) return;
  const row = e.target.closest('tr.wardrow');
  if (row && row.dataset.unitId !== state.selectedUnitId) selectUnit(row.dataset.unitId);
});

els.expandAll.addEventListener('click', () => {
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
  try {
    const payload = await pipeline.results();
    state.payload = payload;
    state.display = payload.display ?? state.display;
    applySchedule(payload.schedule);

    if (state.openGroups === null) state.openGroups = new Set(isNarrow() ? [] : payload.groups.map((g) => g.key));

    renderLegend();
    renderSummary();
    renderStatus();
    renderTable();
    restyleAll();
    renderDetail();
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
  await initMap();
  restyleAll();
  await loadResults();
  setInterval(tickCountdown, 250);
})();
