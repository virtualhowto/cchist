(() => {
  'use strict';

  if (typeof map === 'undefined' || typeof L === 'undefined') return;

  const params = new URLSearchParams(location.search);
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  const desired = {
    enabled: params.get('compare') === 'swipe',
    left: params.get('left') || '',
    right: params.get('right') || '',
    split: clamp(Number(params.get('split')) || 50, 5, 95)
  };

  const CURRENT_IMAGERY_URL = 'https://maps.six.nsw.gov.au/arcgis/rest/services/public/NSW_Imagery/MapServer/tile/{z}/{y}/{x}';
  const MIN_VIEW_OVERLAP = 0.08;
  let allSources = [];
  let sources = [];
  let imageryEpochs = [];
  let leftLayer = null;
  let rightLayer = null;
  let dragging = false;
  let mapDraggingWasEnabled = true;
  let clipRaf = 0;

  function addStyles() {
    if (document.getElementById('compareStyles')) return;
    const style = document.createElement('style');
    style.id = 'compareStyles';
    style.textContent = `
      .compareGrid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.compareGrid label{margin-top:3px}.compareActions{display:flex;gap:8px;margin-top:8px}.compareBtn{flex:1;min-height:40px;border:1px solid var(--line);background:var(--panel2);color:var(--text);border-radius:9px;cursor:pointer}.compareBtn:disabled{opacity:.5;cursor:not-allowed}.compareDivider{display:none;position:absolute;z-index:590;top:0;bottom:0;width:34px;margin-left:-17px;cursor:ew-resize;touch-action:none}.compareDivider::before{content:'';position:absolute;left:16px;top:0;bottom:0;width:2px;background:#fff;box-shadow:0 0 0 1px rgba(0,0,0,.45),0 0 12px rgba(0,0,0,.5)}.compareHandle{position:absolute;left:4px;top:50%;transform:translateY(-50%);width:26px;height:48px;border-radius:13px;background:rgba(15,23,32,.95);border:1px solid rgba(255,255,255,.85);display:flex;align-items:center;justify-content:center;color:#fff;font-size:15px;box-shadow:0 3px 12px rgba(0,0,0,.45)}.compareLabel{display:none;position:absolute;z-index:580;bottom:18px;max-width:42%;padding:7px 9px;border-radius:8px;background:rgba(15,23,32,.92);border:1px solid var(--line);color:var(--text);font-size:12px;pointer-events:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.compareLabel.left{left:12px}.compareLabel.right{right:12px;text-align:right}.compareActive .compareDivider,.compareActive .compareLabel{display:block}.leaflet-compareLeft-pane .leaflet-layer,.leaflet-compareRight-pane .leaflet-layer{will-change:clip-path}
      @media(max-width:760px){.compareGrid{grid-template-columns:1fr}.compareLabel{bottom:10px;max-width:45%;font-size:11px}}
    `;
    document.head.appendChild(style);
  }

  function option(select, value, label) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    select.appendChild(o);
  }

  function addUi() {
    const panel = document.getElementById('layerPanel');
    if (!panel || document.getElementById('compareEnabled')) return;

    const group = document.createElement('div');
    group.className = 'layerGroup';
    group.id = 'compareGroup';
    group.innerHTML = `
      <h3>Swipe comparison</h3>
      <label class="layerRow"><input type="checkbox" id="compareEnabled" disabled><span class="layerText"><b>Enable comparison</b><small>Drag the divider to compare two available aerial or LiDAR layers</small></span></label>
      <div class="compareGrid">
        <div><label for="compareLeft">Left</label><select class="search" id="compareLeft" disabled></select></div>
        <div><label for="compareRight">Right</label><select class="search" id="compareRight" disabled></select></div>
      </div>
      <div class="compareActions"><button type="button" class="compareBtn" id="compareSwap" disabled>⇄ Swap</button></div>
      <div class="layerOpacity"><label for="compareSplit"><span>Divider</span><span id="compareSplitValue">50%</span></label><input class="range" id="compareSplit" type="range" min="5" max="95" step="1" value="50"></div>
      <div id="compareStatus" class="layerStatus warn">Loading comparison sources…</div>
    `;
    panel.appendChild(group);

    const enabled = document.getElementById('compareEnabled');
    const left = document.getElementById('compareLeft');
    const right = document.getElementById('compareRight');
    const split = document.getElementById('compareSplit');
    enabled.checked = desired.enabled;
    split.value = String(desired.split);
    document.getElementById('compareSplitValue').textContent = `${desired.split}%`;

    const mapWrap = document.querySelector('.mapWrap');
    const divider = document.createElement('div');
    divider.className = 'compareDivider';
    divider.id = 'compareDivider';
    divider.innerHTML = '<div class="compareHandle">↔</div>';
    const leftLabel = document.createElement('div');
    leftLabel.className = 'compareLabel left';
    leftLabel.id = 'compareLeftLabel';
    const rightLabel = document.createElement('div');
    rightLabel.className = 'compareLabel right';
    rightLabel.id = 'compareRightLabel';
    mapWrap.append(divider, leftLabel, rightLabel);

    divider.addEventListener('pointerdown', e => {
      dragging = true;
      mapDraggingWasEnabled = map.dragging.enabled();
      divider.setPointerCapture?.(e.pointerId);
      if (mapDraggingWasEnabled) map.dragging.disable();
      updateSplitFromPointer(e);
      e.preventDefault();
    });
    divider.addEventListener('pointermove', e => {
      if (dragging) updateSplitFromPointer(e);
    });
    const stopDrag = e => {
      if (!dragging) return;
      dragging = false;
      try { divider.releasePointerCapture?.(e.pointerId); } catch (_) {}
      if (mapDraggingWasEnabled) map.dragging.enable();
    };
    divider.addEventListener('pointerup', stopDrag);
    divider.addEventListener('pointercancel', stopDrag);

    enabled.addEventListener('change', applyComparison);
    left.addEventListener('change', applyComparison);
    right.addEventListener('change', applyComparison);
    split.addEventListener('input', () => {
      document.getElementById('compareSplitValue').textContent = `${split.value}%`;
      scheduleClip();
    });
    document.getElementById('compareSwap').addEventListener('click', () => {
      const a = left.value;
      left.value = right.value;
      right.value = a;
      applyComparison();
      document.dispatchEvent(new Event('comparestatechange'));
    });
  }

  function updateSplitFromPointer(e) {
    const rect = map.getContainer().getBoundingClientRect();
    const pct = clamp(((e.clientX - rect.left) / Math.max(1, rect.width)) * 100, 5, 95);
    const split = document.getElementById('compareSplit');
    split.value = String(Math.round(pct));
    split.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function createLayer(source, pane) {
    const layer = L.tileLayer(source.url, {
      minZoom: source.minZoom || 0,
      maxZoom: source.maxZoom || 20,
      maxNativeZoom: source.maxNativeZoom || 20,
      opacity: 1,
      pane,
      updateWhenZooming: true,
      keepBuffer: 3,
      attribution: source.attribution || 'NSW Spatial Services'
    });
    layer.on('loading load tileload tileerror', scheduleClip);
    return layer;
  }

  function sourceById(id) {
    return sources.find(s => s.id === id);
  }

  function clearLayerClip(layer) {
    const container = layer?.getContainer?.();
    if (container) {
      container.style.clip = '';
      container.style.clipPath = '';
      container.style.webkitClipPath = '';
    }
  }

  function removeLayers() {
    [leftLayer, rightLayer].forEach(layer => {
      if (!layer) return;
      clearLayerClip(layer);
      layer.off('loading load tileload tileerror', scheduleClip);
      if (map.hasLayer(layer)) map.removeLayer(layer);
    });
    leftLayer = null;
    rightLayer = null;
  }

  function updateLabels(leftSource, rightSource) {
    const l = document.getElementById('compareLeftLabel');
    const r = document.getElementById('compareRightLabel');
    if (l) l.textContent = leftSource?.label || '';
    if (r) r.textContent = rightSource?.label || '';
  }

  function clipLayerAt(layer, splitX, side) {
    const el = layer?.getContainer?.();
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    if (side === 'left') {
      const visible = clamp(splitX - r.left, 0, r.width);
      const inset = Math.max(0, r.width - visible);
      const clip = `inset(0 ${inset}px 0 0)`;
      el.style.clipPath = clip;
      el.style.webkitClipPath = clip;
    } else {
      const inset = clamp(splitX - r.left, 0, r.width);
      const clip = `inset(0 0 0 ${inset}px)`;
      el.style.clipPath = clip;
      el.style.webkitClipPath = clip;
    }
  }

  function applyClip() {
    clipRaf = 0;
    const enabled = document.getElementById('compareEnabled');
    if (!enabled?.checked || !leftLayer || !rightLayer) return;
    const splitPct = clamp(Number(document.getElementById('compareSplit')?.value || 50), 5, 95);
    const rect = map.getContainer().getBoundingClientRect();
    const splitX = rect.left + rect.width * (splitPct / 100);
    clipLayerAt(leftLayer, splitX, 'left');
    clipLayerAt(rightLayer, splitX, 'right');
    const divider = document.getElementById('compareDivider');
    if (divider) divider.style.left = `${splitPct}%`;
  }

  function scheduleClip() {
    if (clipRaf) cancelAnimationFrame(clipRaf);
    clipRaf = requestAnimationFrame(() => {
      clipRaf = requestAnimationFrame(applyClip);
    });
  }

  function applyComparison() {
    const enabled = document.getElementById('compareEnabled');
    const leftSelect = document.getElementById('compareLeft');
    const rightSelect = document.getElementById('compareRight');
    const status = document.getElementById('compareStatus');
    const mapWrap = document.querySelector('.mapWrap');

    removeLayers();
    mapWrap?.classList.toggle('compareActive', Boolean(enabled?.checked));
    if (!enabled?.checked) {
      updateLabels(null, null);
      status.className = 'layerStatus ready';
      status.textContent = `${sources.length} comparison sources available here`;
      return;
    }

    const leftSource = sourceById(leftSelect.value);
    const rightSource = sourceById(rightSelect.value);
    if (!leftSource || !rightSource) {
      status.className = 'layerStatus warn';
      status.textContent = 'Choose an available source for both sides.';
      return;
    }

    leftLayer = createLayer(leftSource, 'compareLeft').addTo(map);
    rightLayer = createLayer(rightSource, 'compareRight').addTo(map);
    updateLabels(leftSource, rightSource);
    status.className = leftSource.id === rightSource.id ? 'layerStatus warn' : 'layerStatus ready';
    status.textContent = leftSource.id === rightSource.id
      ? 'Both sides use the same source — choose a different year/layer to compare.'
      : `${leftSource.label} ↔ ${rightSource.label}`;
    scheduleClip();
  }

  function validBBox(b) {
    return Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) && b[0] <= b[2] && b[1] <= b[3];
  }

  function lonLatToTile(lng, lat, z) {
    const n = 2 ** z;
    const clippedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
    const x = Math.floor((lng + 180) / 360 * n);
    const r = clippedLat * Math.PI / 180;
    const y = Math.floor((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2 * n);
    return [Math.max(0, Math.min(n - 1, x)), Math.max(0, Math.min(n - 1, y))];
  }

  function gridAvailable(grid) {
    if (!grid || !Number.isInteger(grid.level) || !Number.isInteger(grid.left) || !Number.isInteger(grid.top) ||
        !Number.isInteger(grid.width) || !Number.isInteger(grid.height) || typeof grid.bits !== 'string' ||
        grid.bits.length < grid.width * grid.height) return null;
    const b = map.getBounds();
    const [left, top] = lonLatToTile(b.getWest(), b.getNorth(), grid.level);
    const [right, bottom] = lonLatToTile(b.getEast(), b.getSouth(), grid.level);
    const total = Math.max(1, (right - left + 1) * (bottom - top + 1));
    let available = 0;
    const x0 = Math.max(left, grid.left);
    const x1 = Math.min(right, grid.left + grid.width - 1);
    const y0 = Math.max(top, grid.top);
    const y1 = Math.min(bottom, grid.top + grid.height - 1);
    if (x0 <= x1 && y0 <= y1) {
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const gx = x - grid.left;
          const gy = y - grid.top;
          if (grid.bits[gy * grid.width + gx] === '1') available++;
        }
      }
    }
    const c = map.getCenter();
    const [cx, cy] = lonLatToTile(c.lng, c.lat, grid.level);
    const gx = cx - grid.left;
    const gy = cy - grid.top;
    const centreAvailable = gx >= 0 && gy >= 0 && gx < grid.width && gy < grid.height && grid.bits[gy * grid.width + gx] === '1';
    return centreAvailable || available / total >= MIN_VIEW_OVERLAP;
  }

  function bboxAvailable(bbox) {
    if (!validBBox(bbox)) return false;
    const b = map.getBounds();
    const west = Math.max(b.getWest(), bbox[0]);
    const south = Math.max(b.getSouth(), bbox[1]);
    const east = Math.min(b.getEast(), bbox[2]);
    const north = Math.min(b.getNorth(), bbox[3]);
    if (west >= east || south >= north) return false;
    const c = map.getCenter();
    return (c.lng >= bbox[0] && c.lng <= bbox[2] && c.lat >= bbox[1] && c.lat <= bbox[3]);
  }

  function imageryAvailable(epoch) {
    const grid = gridAvailable(epoch.coverageGrid);
    if (grid !== null) return grid;
    return bboxAvailable(epoch.bbox);
  }

  function rebuildAvailableSources({ preserve = true } = {}) {
    const left = document.getElementById('compareLeft');
    const right = document.getElementById('compareRight');
    if (!left || !right) return;

    const previousLeft = preserve ? left.value : desired.left;
    const previousRight = preserve ? right.value : desired.right;
    const nonHistoric = allSources.filter(s => s.kind !== 'imagery-historic');
    const historicIds = new Set(imageryEpochs.filter(imageryAvailable).map(e => `imagery:${e.year}`));
    sources = allSources.filter(s => s.kind !== 'imagery-historic' || historicIds.has(s.id));

    left.innerHTML = '';
    right.innerHTML = '';
    for (const select of [left, right]) {
      const aerial = document.createElement('optgroup');
      aerial.label = 'Aerial imagery available here';
      sources.filter(s => s.kind === 'imagery' || s.kind === 'imagery-historic').forEach(s => option(aerial, s.id, s.label));
      select.appendChild(aerial);
      const lidar = document.createElement('optgroup');
      lidar.label = 'LiDAR hillshade';
      sources.filter(s => s.kind === 'lidar').forEach(s => option(lidar, s.id, s.label));
      select.appendChild(lidar);
    }

    const historic = sources.filter(s => s.kind === 'imagery-historic').sort((a, b) => a.year - b.year);
    const lidar = sources.filter(s => s.kind === 'lidar' && s.id !== 'lidar:latest').sort((a, b) => a.year - b.year);
    const defaultLeft = historic[0]?.id || lidar[0]?.id || 'imagery:current';
    const defaultRight = sources.some(s => s.id === 'imagery:current') ? 'imagery:current' : (sources.at(-1)?.id || defaultLeft);
    left.value = sourceById(previousLeft) ? previousLeft : defaultLeft;
    right.value = sourceById(previousRight) ? previousRight : defaultRight;

    const ready = sources.length >= 2;
    left.disabled = !ready;
    right.disabled = !ready;
    document.getElementById('compareEnabled').disabled = !ready;
    document.getElementById('compareSwap').disabled = !ready;
    const status = document.getElementById('compareStatus');
    status.className = ready ? 'layerStatus ready' : 'layerStatus warn';
    status.textContent = ready
      ? `${sources.length} comparison sources available here${historic.length ? ` • ${historic.length} historic aerial years` : ''}`
      : 'Not enough comparison sources are available in this map area.';

    if (document.getElementById('compareEnabled').checked) applyComparison();
  }

  async function loadSources() {
    const status = document.getElementById('compareStatus');
    try {
      const [imageryResult, lidarResult] = await Promise.allSettled([
        fetch('/lidar/imagery.json?' + Date.now(), { cache: 'no-store' }).then(r => {
          if (!r.ok) throw new Error('imagery catalogue unavailable');
          return r.json();
        }),
        fetch('/lidar/status.json?' + Date.now(), { cache: 'no-store' }).then(r => {
          if (!r.ok) throw new Error('LiDAR status unavailable');
          return r.json();
        })
      ]);

      const imagery = imageryResult.status === 'fulfilled' ? imageryResult.value : { epochs: [] };
      const lidar = lidarResult.status === 'fulfilled' ? lidarResult.value : { epochLayers: {} };
      imageryEpochs = (imagery.epochs || []).filter(e => e.tileUrl);

      allSources = [{
        id: 'imagery:current', kind: 'imagery', year: 9999,
        label: 'Current NSW aerial imagery', url: CURRENT_IMAGERY_URL,
        maxNativeZoom: 18,
        attribution: '© State of New South Wales (Spatial Services)'
      }];

      imageryEpochs.forEach(e => allSources.push({
        id: `imagery:${e.year}`, kind: 'imagery-historic', year: Number(e.year),
        label: `${e.year} aerial — ${e.title || 'NSW historical imagery'}`,
        url: e.tileUrl, maxNativeZoom: 20,
        attribution: '© State of New South Wales (Spatial Services historical imagery)'
      }));

      if (lidar.layers?.hillshade?.available) allSources.push({
        id: 'lidar:latest', kind: 'lidar', year: 9999,
        label: 'Latest LiDAR hillshade', url: '/lidar/hillshade/{z}/{x}/{y}.png',
        minZoom: 9, maxNativeZoom: 17,
        attribution: 'LiDAR derived from NSW Spatial Services elevation data'
      });
      Object.entries(lidar.epochLayers || {})
        .filter(([, v]) => v?.hillshade?.available)
        .sort(([a], [b]) => Number(a) - Number(b))
        .forEach(([year]) => allSources.push({
          id: `lidar:${year}`, kind: 'lidar', year: Number(year),
          label: `${year} LiDAR hillshade`, url: `/lidar/epochs/${year}/hillshade/{z}/{x}/{y}.png`,
          minZoom: 9, maxNativeZoom: 17,
          attribution: 'LiDAR derived from NSW Spatial Services elevation data'
        }));

      rebuildAvailableSources({ preserve: false });
      if (desired.enabled && !document.getElementById('compareEnabled').disabled) {
        document.getElementById('compareEnabled').checked = true;
        applyComparison();
      }
    } catch (e) {
      status.className = 'layerStatus warn';
      status.textContent = `Comparison sources unavailable: ${e.message}`;
    }
  }

  addStyles();
  addUi();
  if (!map.getPane('compareLeft')) map.createPane('compareLeft');
  if (!map.getPane('compareRight')) map.createPane('compareRight');
  map.getPane('compareLeft').style.zIndex = 500;
  map.getPane('compareRight').style.zIndex = 510;
  map.getPane('compareLeft').style.pointerEvents = 'none';
  map.getPane('compareRight').style.pointerEvents = 'none';

  map.on('move zoom zoomend resize', scheduleClip);
  map.on('moveend zoomend', () => {
    rebuildAvailableSources({ preserve: true });
    scheduleClip();
  });
  window.addEventListener('resize', scheduleClip);
  loadSources();
})();
