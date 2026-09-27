(() => {
  'use strict';

  const MIN_VIEW_OVERLAP = 0.10;
  const sel = document.getElementById('historicImageryYear');
  if (!sel || typeof map === 'undefined') return;

  let catalogue = [];
  let showAll = false;
  let refreshTimer = null;

  const group = sel.closest('.layerGroup');
  const controls = document.createElement('div');
  controls.innerHTML = `
    <label class="layerRow" style="margin-top:6px">
      <input type="checkbox" id="historicImageryShowAll">
      <span class="layerText"><b>Show years outside this view</b><small>Off by default. Years without matching coverage are hidden.</small></span>
    </label>
    <div id="imageryCoverageStatus" class="layerStatus">Checking imagery coverage for this map view…</div>`;
  const status = group?.querySelector('#imageryStatus');
  if (group && status) status.insertAdjacentElement('afterend', controls);
  else group?.appendChild(controls);

  const showAllToggle = document.getElementById('historicImageryShowAll');
  const coverageStatus = document.getElementById('imageryCoverageStatus');

  function validBBox(b) {
    return Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) && b[0] <= b[2] && b[1] <= b[3];
  }

  function viewBBox() {
    const b = map.getBounds();
    return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  }

  function area(b) {
    return Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  }

  function intersectionRatio(a, b) {
    const i = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
    if (i[0] >= i[2] || i[1] >= i[3]) return 0;
    const denom = area(a);
    return denom > 0 ? area(i) / denom : 0;
  }

  function containsPoint(b, lat, lng) {
    return validBBox(b) && lng >= b[0] && lng <= b[2] && lat >= b[1] && lat <= b[3];
  }

  function availability(epoch, vb) {
    if (!validBBox(epoch.bbox)) return { available: false, unknown: true, ratio: 0 };
    const center = map.getCenter();
    const ratio = intersectionRatio(vb, epoch.bbox);
    const available = containsPoint(epoch.bbox, center.lat, center.lng) || ratio >= MIN_VIEW_OVERLAP;
    return { available, unknown: false, ratio };
  }

  function optionLabel(epoch, state) {
    const title = epoch.title || 'NSW historical imagery';
    let suffix = '';
    if (showAll && state.unknown) suffix = ' — coverage unknown';
    else if (showAll && !state.available) suffix = ' — outside view';
    else if (state.available && state.ratio > 0 && state.ratio < 0.98) suffix = ' — partial';
    return `${epoch.year} — ${title}${suffix}`;
  }

  function applyFilter() {
    if (!catalogue.length) return;
    const current = sel.value;
    const vb = viewBBox();
    const states = catalogue.map(epoch => ({ epoch, state: availability(epoch, vb) }));
    const visible = showAll ? states : states.filter(x => x.state.available);

    sel.innerHTML = '<option value="">None</option>' + visible
      .slice()
      .sort((a, b) => Number(b.epoch.year) - Number(a.epoch.year))
      .map(({ epoch, state }) => `<option value="${String(epoch.year).replace(/"/g, '&quot;')}">${optionLabel(epoch, state).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</option>`)
      .join('');
    sel.disabled = !visible.length;

    const currentState = states.find(x => String(x.epoch.year) === String(current));
    const currentStillVisible = currentState && (showAll || currentState.state.available);
    if (current && !currentStillVisible) {
      sel.value = '';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (current && [...sel.options].some(o => o.value === String(current))) {
      sel.value = String(current);
    }

    const availableCount = states.filter(x => x.state.available).length;
    const partialCount = states.filter(x => x.state.available && x.state.ratio > 0 && x.state.ratio < 0.98).length;
    const unknownCount = states.filter(x => x.state.unknown).length;
    if (coverageStatus) {
      coverageStatus.className = availableCount ? 'layerStatus ready' : 'layerStatus warn';
      coverageStatus.textContent = showAll
        ? `${availableCount} of ${states.length} years cover this view${unknownCount ? ` • ${unknownCount} unknown` : ''}`
        : `${availableCount} imagery year${availableCount === 1 ? '' : 's'} available for this view${partialCount ? ` • ${partialCount} partial` : ''}`;
    }
  }

  function queueFilter() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(applyFilter, 180);
  }

  showAllToggle?.addEventListener('change', e => {
    showAll = !!e.target.checked;
    applyFilter();
  });
  map.on('moveend zoomend', queueFilter);

  async function loadCatalogue() {
    try {
      const r = await fetch('/lidar/imagery.json?' + Date.now(), { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      catalogue = (data.epochs || []).filter(x => x.tileUrl);
      applyFilter();
    } catch (err) {
      if (coverageStatus) {
        coverageStatus.className = 'layerStatus warn';
        coverageStatus.textContent = 'Coverage filtering unavailable; imagery catalogue could not be read.';
      }
      console.warn('Historic imagery coverage filter:', err);
    }
  }

  // The core map also loads the catalogue. A short delay lets its normal layer
  // setup finish first, then this module narrows the year list by coverage.
  setTimeout(loadCatalogue, 250);
})();
