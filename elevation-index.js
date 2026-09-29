(() => {
  'use strict';
  if (typeof map === 'undefined' || typeof L === 'undefined') return;

  let catalogue = null;
  let localStatus = null;
  let footprintLayer = null;
  let refreshTimer = null;
  let currentSurveys = [];

  const panel = document.getElementById('layerPanel');
  if (!panel || document.getElementById('nswElevationSurvey')) return;

  const group = document.createElement('div');
  group.className = 'layerGroup';
  group.id = 'nswElevationGroup';
  group.innerHTML = `
    <h3>NSW elevation / ELVIS</h3>
    <label for="nswElevationSurvey">Survey covering this view</label>
    <select class="search" id="nswElevationSurvey" disabled><option value="">None in current view</option></select>
    <label class="layerRow"><input type="checkbox" id="nswElevationFootprints"><span class="layerText"><b>Survey footprints</b><small>Show NSW Spatial Services elevation survey coverage in the current view</small></span></label>
    <div id="nswElevationStatus" class="layerStatus warn">Loading NSW elevation survey index…</div>
    <div id="nswLocalCacheStatus" class="layerStatus">Checking local high-resolution terrain cache…</div>
    <div class="meta">The survey index is statewide. High-resolution hillshade and terrain-change layers are only enabled where matching data has been processed into this server's local cache.</div>
    <a id="nswElvisLink" href="https://elevation.fsdf.org.au/" target="_blank" rel="noopener">Open ELVIS elevation downloads</a>
  `;

  const researchGroup = [...panel.querySelectorAll('.layerGroup')].find(x => x.querySelector('h3')?.textContent.trim().toLowerCase() === 'research');
  if (researchGroup) panel.insertBefore(group, researchGroup); else panel.appendChild(group);

  const select = document.getElementById('nswElevationSurvey');
  const toggle = document.getElementById('nswElevationFootprints');
  const statusEl = document.getElementById('nswElevationStatus');
  const localEl = document.getElementById('nswLocalCacheStatus');

  function validBBox(b) {
    return Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) && b[0] <= b[2] && b[1] <= b[3];
  }

  function intersectsView(b) {
    if (!validBBox(b)) return false;
    const v = map.getBounds();
    return Math.max(v.getWest(), b[0]) < Math.min(v.getEast(), b[2]) &&
      Math.max(v.getSouth(), b[1]) < Math.min(v.getNorth(), b[3]);
  }

  function centreInside(b) {
    if (!validBBox(b)) return false;
    const c = map.getCenter();
    return c.lng >= b[0] && c.lng <= b[2] && c.lat >= b[1] && c.lat <= b[3];
  }

  function localAoiBBox() {
    const a = localStatus?.aoi;
    if (!a) return null;
    const b = [Number(a.xmin), Number(a.ymin), Number(a.xmax), Number(a.ymax)];
    return validBBox(b) ? b : null;
  }

  function localAvailableHere() {
    const b = localAoiBBox();
    return b ? (centreInside(b) || intersectsView(b)) : false;
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  }

  function surveyLabel(s) {
    const year = s.year || String(s.captureStart || '').slice(0,4) || 'undated';
    return `${year} — ${s.projectName || 'NSW elevation survey'}`;
  }

  function popupHtml(s) {
    const bits = [];
    if (s.captureStart || s.captureEnd) bits.push(`<b>Capture:</b> ${escapeHtml(s.captureStart || '?')} → ${escapeHtml(s.captureEnd || '?')}`);
    if (s.pointsPerSquareMetre != null) bits.push(`<b>Density:</b> ${escapeHtml(s.pointsPerSquareMetre)} pts/m²`);
    if (s.horizontalAccuracy != null) bits.push(`<b>Horizontal accuracy:</b> ${escapeHtml(s.horizontalAccuracy)}`);
    if (s.verticalAccuracy != null) bits.push(`<b>Vertical accuracy:</b> ${escapeHtml(s.verticalAccuracy)}`);
    if (s.horizontalDatum || s.verticalDatum) bits.push(`<b>Datum:</b> ${escapeHtml(s.horizontalDatum || '')} / ${escapeHtml(s.verticalDatum || '')}`);
    if (s.areaSqKm != null) bits.push(`<b>Area:</b> ${escapeHtml(s.areaSqKm)} km²`);
    return `<div><b>${escapeHtml(s.projectName || 'NSW elevation survey')}</b><div class="meta">${bits.join('<br>')}</div><a href="${escapeHtml(catalogue?.elvisUrl || 'https://elevation.fsdf.org.au/')}" target="_blank" rel="noopener">Find/download in ELVIS</a></div>`;
  }

  function clearFootprints() {
    if (footprintLayer && map.hasLayer(footprintLayer)) map.removeLayer(footprintLayer);
    footprintLayer = null;
  }

  function drawFootprints() {
    clearFootprints();
    if (!toggle.checked || !currentSurveys.length) return;
    const features = currentSurveys.slice(0, 100).filter(s => s.geometry).map(s => ({
      type: 'Feature', properties: { survey: s }, geometry: s.geometry
    }));
    footprintLayer = L.geoJSON({ type: 'FeatureCollection', features }, {
      style: { weight: 2, fillOpacity: 0.06, dashArray: '5 4' },
      onEachFeature: (feature, layer) => layer.bindPopup(popupHtml(feature.properties.survey))
    }).addTo(map);
  }

  function updateLocalControls() {
    if (typeof window.cchistLidarAreaState === 'function') {
      const state = window.cchistLidarAreaState();
      const active = state?.active;
      if (state?.mode === 'area' && active) {
        const years = (active.years || []).join(', ');
        const resolution = Number(active.targetResolutionMeters);
        localEl.className = 'layerStatus ready';
        localEl.textContent = `Local cache: ${active.name || active.slug}${years ? ` • ${years}` : ''}${Number.isFinite(resolution) ? ` • ${resolution} m` : ''}`;
        return;
      }
      if (state?.mode === 'legacy') {
        const years = Object.keys(state.legacy?.epochLayers || {}).sort((a,b)=>+a-+b);
        localEl.className = 'layerStatus ready';
        localEl.textContent = `Legacy local high-resolution cache available here${years.length ? ` • epochs ${years.join(', ')}` : ''}`;
        return;
      }
      localEl.className = 'layerStatus';
      localEl.textContent = 'No locally processed high-resolution terrain tiles for this view. Statewide terrain remains available; acquire/process an ELVIS export for local detail.';
      return;
    }

    if (!localStatus) return;
    const here = localAvailableHere();
    const checks = [...document.querySelectorAll('.lidarCheck')];
    if (!here) {
      checks.forEach(c => {
        if (c.checked) { c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); }
        c.disabled = true;
      });
      const epoch = document.getElementById('lidarEpoch');
      if (epoch) epoch.disabled = true;
      const change = document.getElementById('terrainChangePair');
      if (change && change.value) { change.value = ''; change.dispatchEvent(new Event('change', { bubbles: true })); }
      if (change) change.disabled = true;
      localEl.className = 'layerStatus';
      localEl.textContent = 'No locally processed high-resolution terrain tiles for this view. Check the NSW survey list above, then acquire the area through ELVIS.';
      return;
    }

    checks.forEach(c => {
      c.disabled = !(localStatus.layers?.[c.value]?.available);
    });
    const epoch = document.getElementById('lidarEpoch');
    if (epoch) epoch.disabled = !Object.keys(localStatus.epochLayers || {}).length;
    const change = document.getElementById('terrainChangePair');
    if (change) change.disabled = change.options.length <= 1;
    const a = localAoiBBox();
    localEl.className = 'layerStatus ready';
    localEl.textContent = `Local high-resolution terrain cache available here${a ? ` • ${a[0].toFixed(2)},${a[1].toFixed(2)} to ${a[2].toFixed(2)},${a[3].toFixed(2)}` : ''}`;
  }

  function refresh() {
    if (!catalogue) return;
    currentSurveys = (catalogue.surveys || []).filter(s => intersectsView(s.bbox));
    currentSurveys.sort((a,b) => (Number(b.year)||0) - (Number(a.year)||0) || String(a.projectName).localeCompare(String(b.projectName)));
    const old = select.value;
    select.innerHTML = '<option value="">None selected</option>' + currentSurveys.slice(0, 250).map(s => `<option value="${escapeHtml(s.id)}">${escapeHtml(surveyLabel(s))}</option>`).join('');
    select.disabled = !currentSurveys.length;
    if (old && [...select.options].some(o => o.value === old)) select.value = old;
    const years = [...new Set(currentSurveys.map(s => s.year).filter(Boolean))].sort((a,b)=>b-a);
    statusEl.className = currentSurveys.length ? 'layerStatus ready' : 'layerStatus warn';
    statusEl.textContent = currentSurveys.length
      ? `${currentSurveys.length} NSW elevation survey footprint${currentSurveys.length===1?'':'s'} intersects this view${years.length ? ` • years ${years.slice(0,8).join(', ')}${years.length>8?'…':''}` : ''}`
      : 'No indexed NSW elevation survey intersects this view at the current extent.';
    drawFootprints();
    updateLocalControls();
  }

  function queueRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 150);
  }

  select.addEventListener('change', () => {
    const survey = currentSurveys.find(s => String(s.id) === String(select.value));
    if (!survey?.bbox) return;
    L.rectangle([[survey.bbox[1], survey.bbox[0]], [survey.bbox[3], survey.bbox[2]]], { opacity: 0, fillOpacity: 0 }).addTo(map);
    if (survey.geometry && toggle.checked) drawFootprints();
  });
  toggle.addEventListener('change', drawFootprints);
  map.on('moveend zoomend', queueRefresh);
  document.addEventListener('lidarareachange', updateLocalControls);

  async function load() {
    try {
      const [indexResult, statusResult] = await Promise.allSettled([
        fetch('/lidar/elevation-index.json?' + Date.now(), { cache: 'no-store' }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }),
        fetch('/lidar/status.json?' + Date.now(), { cache: 'no-store' }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      ]);
      if (indexResult.status === 'fulfilled') {
        catalogue = indexResult.value;
        if (catalogue.elvisUrl) document.getElementById('nswElvisLink').href = catalogue.elvisUrl;
      } else {
        throw indexResult.reason;
      }
      localStatus = statusResult.status === 'fulfilled' ? statusResult.value : null;
      refresh();
      setTimeout(updateLocalControls, 1200);
      setTimeout(updateLocalControls, 3500);
    } catch (err) {
      statusEl.className = 'layerStatus warn';
      statusEl.textContent = `NSW elevation index unavailable: ${err.message || err}`;
    }
  }

  load();
})();
