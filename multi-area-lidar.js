(() => {
  'use strict';
  if (typeof map === 'undefined' || typeof L === 'undefined' || typeof lidarLayers === 'undefined') return;

  let areas = [];
  let legacyStatus = null;
  let active = null;
  let activeMode = 'none';
  let manual = '';
  let refreshTimer = null;

  const checks = () => [...document.querySelectorAll('.lidarCheck')];
  const statusEl = document.getElementById('lidarStatus');
  const epochSelect = document.getElementById('lidarEpoch');
  const epochLabel = epochSelect?.previousElementSibling?.tagName === 'LABEL' ? epochSelect.previousElementSibling : null;
  const group = epochSelect?.closest('.layerGroup');

  function validBBox(b) {
    return Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) && b[0] < b[2] && b[1] < b[3];
  }

  function areaBBox(area) {
    const a = area?.aoi || {};
    const b = [
      Number(a.west ?? a.xmin),
      Number(a.south ?? a.ymin),
      Number(a.east ?? a.xmax),
      Number(a.north ?? a.ymax)
    ];
    return validBBox(b) ? b : null;
  }

  function intersects(b) {
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

  function candidateAreas() {
    return areas.filter(a => a?.ready && intersects(areaBBox(a))).sort((a, b) => {
      const ac = centreInside(areaBBox(a)) ? 1 : 0;
      const bc = centreInside(areaBBox(b)) ? 1 : 0;
      if (bc !== ac) return bc - ac;
      const ar = Number(a.targetResolutionMeters ?? 9999);
      const br = Number(b.targetResolutionMeters ?? 9999);
      if (ar !== br) return ar - br;
      return String(b.updated || '').localeCompare(String(a.updated || ''));
    });
  }

  function legacyBBox() {
    return areaBBox(legacyStatus);
  }

  function legacyAvailable() {
    const b = legacyBBox();
    return !!legacyStatus?.ready && !!b && intersects(b) && (centreInside(b) || candidateAreas().length === 0);
  }

  function makeLayer(url, type, definition = {}) {
    const opacity = Number(document.getElementById('overlayOpacity')?.value || 70) / 100;
    return L.tileLayer(url, {
      minZoom: Number(definition.minZoom ?? 9),
      maxZoom: 19,
      maxNativeZoom: Number(definition.maxZoom ?? 17),
      opacity,
      pane: 'terrain',
      attribution: type === 'hillshade'
        ? 'LiDAR derived from NSW Spatial Services elevation data'
        : 'Derived from NSW Spatial Services elevation data'
    });
  }

  function removeCurrentLayers() {
    Object.values(lidarLayers || {}).forEach(layer => {
      try { if (layer && map.hasLayer(layer)) map.removeLayer(layer); } catch (_) {}
    });
  }

  function replaceLayers(layerDefs, basePath) {
    const enabled = new Set(checks().filter(c => c.checked).map(c => c.value));
    removeCurrentLayers();
    const next = {};
    for (const type of ['hillshade', 'slope', 'tri']) {
      const def = layerDefs?.[type] || {};
      next[type] = makeLayer(`${basePath}/${type}/{z}/{x}/{y}.png`, type, def);
    }
    lidarLayers = next;
    checks().forEach(c => {
      const available = !!layerDefs?.[c.value]?.available;
      c.disabled = !available;
      if (!available) c.checked = false;
      if (available && enabled.has(c.value)) lidarLayers[c.value].addTo(map);
    });
  }

  function setEpochUi(mode) {
    if (!epochSelect) return;
    const named = mode === 'area';
    if (epochLabel) epochLabel.style.display = named ? 'none' : '';
    epochSelect.style.display = named ? 'none' : '';
    if (named) epochSelect.disabled = true;
  }

  function populateLegacyEpochs() {
    if (!epochSelect || !legacyStatus) return;
    const years = Object.entries(legacyStatus.epochLayers || {})
      .filter(([, v]) => v?.hillshade?.available)
      .map(([y]) => y)
      .sort((a, b) => +b - +a);
    const old = epochSelect.value || 'latest';
    epochSelect.innerHTML = '<option value="latest">Latest available composite</option>' +
      years.map(y => `<option value="${y}">${y} survey hillshade</option>`).join('');
    epochSelect.disabled = !years.length;
    if ([...epochSelect.options].some(o => o.value === old)) epochSelect.value = old;
  }

  function useLegacy() {
    const layers = legacyStatus?.layers || {};
    const epoch = epochSelect?.value || 'latest';
    const enabled = new Set(checks().filter(c => c.checked).map(c => c.value));
    removeCurrentLayers();
    lidarLayers = {
      hillshade: makeLayer(epoch === 'latest' ? '/lidar/hillshade/{z}/{x}/{y}.png' : `/lidar/epochs/${epoch}/hillshade/{z}/{x}/{y}.png`, 'hillshade', layers.hillshade || {}),
      slope: makeLayer('/lidar/slope/{z}/{x}/{y}.png', 'slope', layers.slope || {}),
      tri: makeLayer('/lidar/tri/{z}/{x}/{y}.png', 'tri', layers.tri || {})
    };
    checks().forEach(c => {
      const available = !!layers?.[c.value]?.available;
      c.disabled = !available;
      if (!available) c.checked = false;
      if (available && enabled.has(c.value)) lidarLayers[c.value].addTo(map);
    });
    populateLegacyEpochs();
    setEpochUi('legacy');
  }

  function disableAll() {
    removeCurrentLayers();
    checks().forEach(c => { c.checked = false; c.disabled = true; });
    if (epochSelect) epochSelect.disabled = true;
    setEpochUi('none');
  }

  function labelArea(area) {
    const years = (area?.years || []).join(', ');
    const res = Number(area?.targetResolutionMeters);
    return `${area?.name || area?.slug || 'High-resolution cache'}${years ? ` • ${years}` : ''}${Number.isFinite(res) ? ` • ${res} m` : ''}`;
  }

  function addUi() {
    if (!group || document.getElementById('lidarArea')) return;
    const label = document.createElement('label');
    label.htmlFor = 'lidarArea';
    label.textContent = 'High-resolution cache';
    const select = document.createElement('select');
    select.className = 'search';
    select.id = 'lidarArea';
    select.innerHTML = '<option value="auto">Automatic for map location</option>';
    group.insertBefore(select, epochLabel || epochSelect || group.firstChild?.nextSibling || null);
    group.insertBefore(label, select);
    select.addEventListener('change', () => {
      manual = select.value === 'auto' ? '' : select.value;
      refresh(true);
    });
  }

  function updateAreaSelect(candidates, chosen, mode) {
    const select = document.getElementById('lidarArea');
    if (!select) return;
    const current = manual || 'auto';
    const items = candidates.map(a => `<option value="${String(a.slug).replace(/["&<>]/g, '')}">${labelArea(a)}</option>`);
    if (legacyAvailable()) items.push('<option value="__legacy__">Legacy local cache</option>');
    select.innerHTML = `<option value="auto">Automatic${chosen ? ` — ${labelArea(chosen)}` : mode === 'legacy' ? ' — legacy local cache' : ''}</option>${items.join('')}`;
    if ([...select.options].some(o => o.value === current)) select.value = current;
    else { select.value = 'auto'; manual = ''; }
    select.disabled = candidates.length + (legacyAvailable() ? 1 : 0) <= 1;
  }

  function refresh(force = false) {
    const candidates = candidateAreas();
    let chosen = null;
    let mode = 'none';

    if (manual === '__legacy__' && legacyAvailable()) mode = 'legacy';
    else if (manual) chosen = candidates.find(a => String(a.slug) === manual) || null;
    if (chosen) mode = 'area';
    if (mode === 'none' && candidates.length) { chosen = candidates[0]; mode = 'area'; }
    if (mode === 'none' && legacyAvailable()) mode = 'legacy';

    updateAreaSelect(candidates, chosen, mode);

    const key = mode === 'area' ? `area:${chosen?.slug}` : mode;
    const previousKey = activeMode === 'area' ? `area:${active?.slug}` : activeMode;
    if (!force && key === previousKey) return;

    active = chosen;
    activeMode = mode;

    if (mode === 'area' && chosen) {
      replaceLayers(chosen.layers || {}, `/lidar/areas/${chosen.slug}`);
      setEpochUi('area');
      if (statusEl) {
        statusEl.className = 'layerStatus ready';
        statusEl.textContent = `High-resolution cache: ${labelArea(chosen)} • ${(chosen.sourceCount ?? '?')} DEM source tile${chosen.sourceCount === 1 ? '' : 's'}`;
      }
    } else if (mode === 'legacy') {
      useLegacy();
      if (statusEl) {
        const years = Object.keys(legacyStatus?.epochLayers || {}).sort((a, b) => +a - +b);
        statusEl.className = 'layerStatus ready';
        statusEl.textContent = `Legacy high-resolution cache available here${years.length ? ` • epochs ${years.join(', ')}` : ''}`;
      }
    } else {
      disableAll();
      if (statusEl) {
        statusEl.className = 'layerStatus warn';
        statusEl.textContent = 'No locally processed high-resolution terrain cache for this view. Statewide terrain remains available; add/process an ELVIS export for high resolution.';
      }
    }

    const detail = state();
    document.dispatchEvent(new CustomEvent('lidarareachange', { detail }));
  }

  function queueRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => refresh(false), 160);
  }

  function state() {
    return {
      mode: activeMode,
      active: activeMode === 'area' ? active : (activeMode === 'legacy' ? legacyStatus : null),
      areas,
      legacy: legacyStatus
    };
  }

  async function load() {
    addUi();
    const [ar, lr] = await Promise.allSettled([
      fetch('/lidar/areas.json?' + Date.now(), { cache: 'no-store' }).then(r => r.ok ? r.json() : Promise.reject(new Error(`areas HTTP ${r.status}`))),
      fetch('/lidar/status.json?' + Date.now(), { cache: 'no-store' }).then(r => r.ok ? r.json() : Promise.reject(new Error(`status HTTP ${r.status}`)))
    ]);
    areas = ar.status === 'fulfilled' ? (ar.value.areas || []).filter(a => a?.ready && a?.slug) : [];
    legacyStatus = lr.status === 'fulfilled' ? lr.value : null;
    window.cchistLidarAreas = areas;
    refresh(true);
    setTimeout(() => refresh(true), 1200);
    setTimeout(() => refresh(true), 3500);
  }

  window.cchistLidarAreaState = state;
  map.on('moveend zoomend', queueRefresh);
  epochSelect?.addEventListener('change', () => { if (activeMode === 'legacy') setTimeout(() => useLegacy(), 0); });
  load();
})();
