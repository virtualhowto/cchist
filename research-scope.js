(() => {
  'use strict';

  if (typeof map === 'undefined') return;

  const params = new URLSearchParams(location.search);
  const VALID_SCOPES = new Set(['all', 'view', 'centre', 'point']);
  let scope = VALID_SCOPES.has(params.get('rscope')) ? params.get('rscope') : 'view';
  let radiusKm = Math.max(0.5, Math.min(25, Number(params.get('rr')) || 5));
  let researchPoint = null;
  const pLat = Number(params.get('rlat'));
  const pLng = Number(params.get('rlng'));
  if (Number.isFinite(pLat) && Number.isFinite(pLng) && pLat >= -34.5 && pLat <= -32.5 && pLng >= 150 && pLng <= 152.5) {
    researchPoint = L.latLng(pLat, pLng);
  }
  if (!researchPoint) researchPoint = map.getCenter();

  let topic = params.get('rtopic') || '';
  let refreshTimer = null;
  let researchArea = null;
  let researchPin = null;

  const controls = document.querySelector('.sidebar .controls');
  if (!controls || document.getElementById('researchScope')) return;

  const box = document.createElement('div');
  box.id = 'researchScopeBox';
  box.style.cssText = 'border:1px solid var(--line);border-radius:10px;padding:10px;margin:0 0 12px;background:var(--panel2)';
  box.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:5px">
      <b>Research this area</b>
      <span class="badge" id="researchScopeBadge">Map view</span>
    </div>
    <label for="researchScope">Research scope</label>
    <select class="search" id="researchScope">
      <option value="view">Visible map area</option>
      <option value="centre">Around map centre</option>
      <option value="point">Around clicked point</option>
      <option value="all">All known research</option>
    </select>
    <div id="researchRadiusWrap">
      <label for="researchRadius"><span>Radius: </span><span id="researchRadiusValue">5 km</span></label>
      <input class="range" id="researchRadius" type="range" min="0.5" max="25" step="0.5" value="5">
    </div>
    <div id="researchScopeStatus" class="layerStatus">Researching the visible map area.</div>
    <label for="researchTopic">Research topic <span style="font-weight:400">(optional)</span></label>
    <input class="search" id="researchTopic" placeholder="racecourse, wharf, picnic ground…" autocomplete="off">
    <div id="researchAreaLabel" class="meta" style="margin-top:8px"></div>
    <div id="researchLaunch" style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:7px"></div>
  `;
  controls.prepend(box);

  const scopeEl = document.getElementById('researchScope');
  const radiusEl = document.getElementById('researchRadius');
  const radiusValue = document.getElementById('researchRadiusValue');
  const radiusWrap = document.getElementById('researchRadiusWrap');
  const statusEl = document.getElementById('researchScopeStatus');
  const badgeEl = document.getElementById('researchScopeBadge');
  const topicEl = document.getElementById('researchTopic');
  const areaLabelEl = document.getElementById('researchAreaLabel');
  const launchEl = document.getElementById('researchLaunch');

  scopeEl.value = scope;
  radiusEl.value = String(radiusKm);
  topicEl.value = topic;

  function kmBetween(a, b) {
    const R = 6371;
    const dLat = (b.lat - a.lat) * Math.PI / 180;
    const dLng = (b.lng - a.lng) * Math.PI / 180;
    const lat1 = a.lat * Math.PI / 180;
    const lat2 = b.lat * Math.PI / 180;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  function referencePoint() {
    return scope === 'point' ? researchPoint : map.getCenter();
  }

  function placeInScope(p) {
    if (scope === 'all') return true;
    const ll = L.latLng(Number(p.lat), Number(p.lon));
    if (scope === 'view') return map.getBounds().contains(ll);
    return kmBetween(referencePoint(), ll) <= radiusKm;
  }

  function nearestLocality() {
    if (typeof places === 'undefined' || !places.length) return null;
    const ref = referencePoint();
    let nearest = null;
    for (const p of places) {
      const d = kmBetween(ref, L.latLng(Number(p.lat), Number(p.lon)));
      if (!nearest || d < nearest.distance) nearest = { place: p, distance: d };
    }
    return nearest;
  }

  function launchButton(label, href) {
    return `<a href="${href}" target="_blank" rel="noopener" style="display:flex;align-items:center;justify-content:center;text-align:center;min-height:38px;padding:6px 8px;border:1px solid var(--line);border-radius:8px;background:#11202d;text-decoration:none">${label}</a>`;
  }

  function updateResearchLinks() {
    const nearest = nearestLocality();
    const locality = nearest?.place?.suburb || nearest?.place?.name || 'Central Coast NSW';
    const localityNote = nearest
      ? `Nearest known locality: <b>${esc(locality)}</b> • ${nearest.distance.toFixed(1)} km from research reference`
      : 'Using the current Central Coast map area.';
    areaLabelEl.innerHTML = localityNote;

    const terms = [locality, topic.trim()].filter(Boolean).join(' ');
    const trove = `https://trove.nla.gov.au/search/category/newspapers?keyword=${encodeURIComponent(terms)}&l-artType=newspapers&l-state=New%20South%20Wales`;
    const memories = 'https://centralcoast.contentdm.oclc.org/';
    const aerial = 'https://centralcoast.contentdm.oclc.org/digital/collection/p20041coll8';
    const slnsw = 'https://archival.sl.nsw.gov.au/search/simple';
    const historicViewer = 'https://portal.spatial.nsw.gov.au/portal/apps/webappviewer/index.html?id=f7c215b873864d44bccddda8075238cb';
    const hlrv = 'https://hlrv.nswlrs.com.au/';

    launchEl.innerHTML = [
      launchButton('Search Trove', trove),
      launchButton('Central Coast Memories', memories),
      launchButton('Aerial Central Coast', aerial),
      launchButton('State Library NSW', slnsw),
      launchButton('Historical imagery', historicViewer),
      launchButton('Historic land records', hlrv)
    ].join('');
  }

  function updateAreaOverlay() {
    if (researchArea) { map.removeLayer(researchArea); researchArea = null; }
    if (researchPin) { map.removeLayer(researchPin); researchPin = null; }
    if (scope !== 'centre' && scope !== 'point') return;
    const ref = referencePoint();
    researchArea = L.circle(ref, { radius: radiusKm * 1000, weight: 1, fillOpacity: 0.04, dashArray: '5 5', interactive: false }).addTo(map);
    if (scope === 'point') researchPin = L.circleMarker(ref, { radius: 6, weight: 2, fillOpacity: 0.65, interactive: false }).addTo(map);
  }

  function scopeName() {
    return ({ all: 'All research', view: 'Map view', centre: 'Map centre', point: 'Clicked point' })[scope] || 'Map view';
  }

  function applyScope() {
    if (typeof places === 'undefined' || typeof markers === 'undefined' || typeof markerLayer === 'undefined') return;

    const cards = [...document.querySelectorAll('#list .card')];
    let shown = 0;
    for (const card of cards) {
      const p = places.find(x => x.name === card.dataset.name);
      const keep = !!p && placeInScope(p);
      card.style.display = keep ? '' : 'none';
      const marker = p ? markers.get(p.name) : null;
      if (marker) {
        if (keep && !markerLayer.hasLayer(marker)) markerLayer.addLayer(marker);
        if (!keep && markerLayer.hasLayer(marker)) markerLayer.removeLayer(marker);
      }
      if (keep) shown++;
    }

    const radiusText = `${radiusKm % 1 ? radiusKm.toFixed(1) : radiusKm.toFixed(0)} km`;
    badgeEl.textContent = scopeName();
    radiusValue.textContent = radiusText;
    radiusWrap.style.display = (scope === 'centre' || scope === 'point') ? '' : 'none';

    let scopeText;
    if (scope === 'all') scopeText = `${shown} matching known research locations across the catalogue.`;
    else if (scope === 'view') scopeText = `${shown} matching known research location${shown === 1 ? '' : 's'} in the visible map area.`;
    else if (scope === 'centre') scopeText = `${shown} matching location${shown === 1 ? '' : 's'} within ${radiusText} of the map centre.`;
    else scopeText = `${shown} matching location${shown === 1 ? '' : 's'} within ${radiusText} of the clicked research point. Click the map to move it.`;
    statusEl.textContent = scopeText;
    statusEl.className = shown ? 'layerStatus ready' : 'layerStatus';

    const stats = document.getElementById('stats');
    if (stats) stats.textContent = `${shown} research location${shown === 1 ? '' : 's'} shown • scope: ${scopeName().toLowerCase()}`;

    updateAreaOverlay();
    updateResearchLinks();
  }

  function queueApply() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(applyScope, 80);
  }

  function signalStateChange() {
    document.dispatchEvent(new Event('researchscopechange'));
  }

  // Preserve the application's normal text/year/category render, then narrow it geographically.
  const coreRender = window.render;
  if (typeof coreRender === 'function') {
    window.render = function scopedRender(...args) {
      const result = coreRender.apply(this, args);
      queueApply();
      return result;
    };
  }

  scopeEl.addEventListener('change', () => {
    scope = VALID_SCOPES.has(scopeEl.value) ? scopeEl.value : 'view';
    if (scope === 'point' && !researchPoint) researchPoint = map.getCenter();
    applyScope();
    signalStateChange();
  });

  radiusEl.addEventListener('input', () => {
    radiusKm = Math.max(0.5, Math.min(25, Number(radiusEl.value) || 5));
    applyScope();
    signalStateChange();
  });

  topicEl.addEventListener('input', () => {
    topic = topicEl.value;
    updateResearchLinks();
    signalStateChange();
  });

  map.on('moveend zoomend', () => {
    if (scope === 'view' || scope === 'centre') queueApply();
    else updateResearchLinks();
  });

  map.on('click', e => {
    if (scope !== 'point') return;
    researchPoint = e.latlng;
    applyScope();
    signalStateChange();
  });

  // The original q/year handlers already render globally. Run geographic narrowing immediately after them.
  document.getElementById('q')?.addEventListener('input', () => setTimeout(applyScope, 0));
  document.getElementById('yr')?.addEventListener('input', () => setTimeout(applyScope, 0));
  document.getElementById('cats')?.addEventListener('click', () => setTimeout(applyScope, 0));

  window.cchistResearchState = () => ({
    scope,
    radiusKm,
    point: researchPoint ? { lat: researchPoint.lat, lng: researchPoint.lng } : null,
    topic: topic.trim()
  });

  // places.json is loaded asynchronously by the core page.
  const readyPoll = setInterval(() => {
    if (typeof places !== 'undefined' && places.length) {
      clearInterval(readyPoll);
      applyScope();
    }
  }, 150);
  setTimeout(() => clearInterval(readyPoll), 15000);

  applyScope();
})();
