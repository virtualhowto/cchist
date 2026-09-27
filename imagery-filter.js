(() => {
  'use strict';

  const MIN_VIEW_OVERLAP = 0.08;
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
      <span class="layerText"><b>Show years outside this view</b><small>Off by default. Years without matching imagery coverage are hidden.</small></span>
    </label>
    <div id="imageryCoverageStatus" class="layerStatus">Checking actual imagery coverage for this map view…</div>`;
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

  function lonLatToTile(lng, lat, z) {
    const n = 2 ** z;
    const clippedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
    const x = Math.floor((lng + 180) / 360 * n);
    const r = clippedLat * Math.PI / 180;
    const y = Math.floor((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2 * n);
    return [Math.max(0, Math.min(n - 1, x)), Math.max(0, Math.min(n - 1, y))];
  }

  function gridAvailability(grid, vb) {
    if (!grid || !Number.isInteger(grid.level) || !Number.isInteger(grid.left) || !Number.isInteger(grid.top) ||
        !Number.isInteger(grid.width) || !Number.isInteger(grid.height) || typeof grid.bits !== 'string') return null;
    if (grid.bits.length < grid.width * grid.height) return null;

    const [left, top] = lonLatToTile(vb[0], vb[3], grid.level);
    const [right, bottom] = lonLatToTile(vb[2], vb[1], grid.level);
    const viewWidth = Math.max(1, right - left + 1);
    const viewHeight = Math.max(1, bottom - top + 1);
    const total = viewWidth * viewHeight;
    let available = 0;

    const x0 = Math.max(left, grid.left);
    const x1 = Math.min(right, grid.left + grid.width - 1);
    const y0 = Math.max(top, grid.top);
    const y1 = Math.min(bottom, grid.top + grid.height - 1);
    if (x0 <= x1 && y0 <= y1) {
      for (let y = y0; y <= y1; y++) {
        const gy = y - grid.top;
        for (let x = x0; x <= x1; x++) {
          const gx = x - grid.left;
          if (grid.bits[gy * grid.width + gx] === '1') available++;
        }
      }
    }

    const center = map.getCenter();
    const [cx, cy] = lonLatToTile(center.lng, center.lat, grid.level);
    const cgx = cx - grid.left, cgy = cy - grid.top;
    const centerAvailable = cgx >= 0 && cgy >= 0 && cgx < grid.width && cgy < grid.height &&
      grid.bits[cgy * grid.width + cgx] === '1';
    const ratio = available / total;
    return { available: centerAvailable || ratio >= MIN_VIEW_OVERLAP, unknown: false, ratio, source: 'tilemap' };
  }

  function availability(epoch, vb) {
    const gridState = gridAvailability(epoch.coverageGrid, vb);
    if (gridState) return gridState;
    if (!validBBox(epoch.bbox)) return { available: false, unknown: true, ratio: 0, source: 'unknown' };
    const center = map.getCenter();
    const ratio = intersectionRatio(vb, epoch.bbox);
    const available = containsPoint(epoch.bbox, center.lat, center.lng) || ratio >= MIN_VIEW_OVERLAP;
    return { available, unknown: false, ratio, source: 'bbox' };
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  }

  function optionLabel(epoch, state) {
    const title = epoch.title || 'NSW historical imagery';
    let suffix = '';
    if (showAll && state.unknown) suffix = ' — coverage unknown';
    else if (showAll && !state.available) suffix = ' — no imagery here';
    else if (state.available && state.ratio > 0 && state.ratio < 0.92) suffix = ' — partial';
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
      .map(({ epoch, state }) => `<option value="${escapeHtml(epoch.year)}">${escapeHtml(optionLabel(epoch, state))}</option>`)
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
    const exactCount = states.filter(x => x.state.source === 'tilemap').length;
    const partialCount = states.filter(x => x.state.available && x.state.ratio > 0 && x.state.ratio < 0.92).length;
    const unknownCount = states.filter(x => x.state.unknown).length;
    if (coverageStatus) {
      coverageStatus.className = availableCount ? 'layerStatus ready' : 'layerStatus warn';
      coverageStatus.textContent = showAll
        ? `${availableCount} of ${states.length} years have imagery here • ${exactCount} checked from actual tile coverage${unknownCount ? ` • ${unknownCount} unknown` : ''}`
        : `${availableCount} imagery year${availableCount === 1 ? '' : 's'} available here${partialCount ? ` • ${partialCount} partial` : ''}`;
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
      // Core map loading is asynchronous too; repeat after it has definitely
      // populated its original all-years selector so our filtered list wins.
      setTimeout(applyFilter, 1000);
      setTimeout(applyFilter, 3000);
    } catch (err) {
      if (coverageStatus) {
        coverageStatus.className = 'layerStatus warn';
        coverageStatus.textContent = 'Coverage filtering unavailable; imagery catalogue could not be read.';
      }
      console.warn('Historic imagery coverage filter:', err);
    }
  }

  setTimeout(loadCatalogue, 250);
})();
