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
  const CURRENT = 'https://maps.six.nsw.gov.au/arcgis/rest/services/public/NSW_Imagery/MapServer/tile/{z}/{y}/{x}';
  const MIN_OVERLAP = 0.08;

  let allSources = [];
  let sources = [];
  let imageryEpochs = [];
  let namedAreas = [];
  let legacyStatus = null;
  let leftLayer = null;
  let rightLayer = null;
  let dragging = false;
  let dragWas = true;
  let raf = 0;
  let rebuildTimer = null;

  function addStyles() {
    if (document.getElementById('compareStylesV4')) return;
    const style = document.createElement('style');
    style.id = 'compareStylesV4';
    style.textContent = `.compareGrid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.compareActions{display:flex;gap:8px;margin-top:8px}.compareBtn{flex:1;min-height:40px;border:1px solid var(--line);background:var(--panel2);color:var(--text);border-radius:9px;cursor:pointer}.compareBtn:disabled{opacity:.5}.compareDivider{display:none;position:absolute;z-index:590;top:0;bottom:0;width:34px;margin-left:-17px;cursor:ew-resize;touch-action:none}.compareDivider:before{content:'';position:absolute;left:16px;top:0;bottom:0;width:2px;background:#fff;box-shadow:0 0 0 1px rgba(0,0,0,.45),0 0 12px rgba(0,0,0,.5)}.compareHandle{position:absolute;left:4px;top:50%;transform:translateY(-50%);width:26px;height:48px;border-radius:13px;background:rgba(15,23,32,.95);border:1px solid rgba(255,255,255,.85);display:flex;align-items:center;justify-content:center;color:#fff}.compareLabel{display:none;position:absolute;z-index:580;bottom:18px;max-width:42%;padding:7px 9px;border-radius:8px;background:rgba(15,23,32,.92);border:1px solid var(--line);color:var(--text);font-size:12px;pointer-events:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.compareLabel.left{left:12px}.compareLabel.right{right:12px;text-align:right}.compareActive .compareDivider,.compareActive .compareLabel{display:block}@media(max-width:760px){.compareGrid{grid-template-columns:1fr}.compareLabel{bottom:10px;max-width:45%;font-size:11px}}`;
    document.head.appendChild(style);
  }

  const option = (select, value, label) => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    select.appendChild(o);
  };

  function addUi() {
    const panel = document.getElementById('layerPanel');
    if (!panel || document.getElementById('compareEnabled')) return;
    const group = document.createElement('div');
    group.className = 'layerGroup';
    group.id = 'compareGroup';
    group.innerHTML = `
      <h3>Swipe comparison</h3>
      <label class="layerRow"><input type="checkbox" id="compareEnabled" disabled><span class="layerText"><b>Enable comparison</b><small>Left stays underneath; drag the divider to reveal the right layer.</small></span></label>
      <div class="compareGrid"><div><label for="compareLeft">Left</label><select class="search" id="compareLeft" disabled></select></div><div><label for="compareRight">Right</label><select class="search" id="compareRight" disabled></select></div></div>
      <div class="compareActions"><button type="button" class="compareBtn" id="compareSwap" disabled>⇄ Swap</button></div>
      <div class="layerOpacity"><label for="compareSplit"><span>Divider</span><span id="compareSplitValue">${desired.split}%</span></label><input class="range" id="compareSplit" type="range" min="5" max="95" step="1" value="${desired.split}"></div>
      <div id="compareStatus" class="layerStatus warn">Loading comparison sources…</div>`;
    panel.appendChild(group);

    const wrap = document.querySelector('.mapWrap');
    const divider = document.createElement('div');
    divider.id = 'compareDivider';
    divider.className = 'compareDivider';
    divider.innerHTML = '<div class="compareHandle">↔</div>';
    const leftLabel = document.createElement('div');
    leftLabel.id = 'compareLeftLabel';
    leftLabel.className = 'compareLabel left';
    const rightLabel = document.createElement('div');
    rightLabel.id = 'compareRightLabel';
    rightLabel.className = 'compareLabel right';
    wrap.append(divider, leftLabel, rightLabel);

    const enabled = document.getElementById('compareEnabled');
    const left = document.getElementById('compareLeft');
    const right = document.getElementById('compareRight');
    const split = document.getElementById('compareSplit');
    enabled.checked = desired.enabled;
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
      left.dispatchEvent(new Event('change', { bubbles: true }));
      right.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const fromPointer = e => {
      const rect = map.getContainer().getBoundingClientRect();
      const pct = clamp((e.clientX - rect.left) / Math.max(1, rect.width) * 100, 5, 95);
      split.value = String(Math.round(pct));
      split.dispatchEvent(new Event('input', { bubbles: true }));
    };
    divider.addEventListener('pointerdown', e => {
      dragging = true;
      dragWas = map.dragging.enabled();
      divider.setPointerCapture?.(e.pointerId);
      if (dragWas) map.dragging.disable();
      fromPointer(e);
      e.preventDefault();
    });
    divider.addEventListener('pointermove', e => { if (dragging) fromPointer(e); });
    const stop = e => {
      if (!dragging) return;
      dragging = false;
      divider.releasePointerCapture?.(e.pointerId);
      if (dragWas) map.dragging.enable();
    };
    divider.addEventListener('pointerup', stop);
    divider.addEventListener('pointercancel', stop);
  }

  const sourceById = id => sources.find(s => s.id === id);

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

  function clearLayers() {
    for (const layer of [leftLayer, rightLayer]) {
      if (!layer) continue;
      const el = layer.getContainer?.();
      if (el) {
        el.style.clip = 'auto';
        el.style.clipPath = '';
        el.style.webkitClipPath = '';
      }
      layer.off('loading load tileload tileerror', scheduleClip);
      if (map.hasLayer(layer)) map.removeLayer(layer);
    }
    leftLayer = rightLayer = null;
  }

  function scheduleClip() {
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => { raf = requestAnimationFrame(applyClip); });
  }

  function applyClip() {
    raf = 0;
    if (!document.getElementById('compareEnabled')?.checked || !rightLayer) return;
    const pct = clamp(Number(document.getElementById('compareSplit')?.value || 50), 5, 95) / 100;
    const mapRect = map.getContainer().getBoundingClientRect();
    const splitX = mapRect.left + mapRect.width * pct;
    const right = rightLayer.getContainer?.();
    if (right) {
      const r = right.getBoundingClientRect();
      const leftInset = clamp(splitX - r.left, 0, Math.max(0, r.width));
      right.style.clip = 'auto';
      right.style.clipPath = `inset(0 0 0 ${leftInset}px)`;
      right.style.webkitClipPath = `inset(0 0 0 ${leftInset}px)`;
    }
    const left = leftLayer?.getContainer?.();
    if (left) {
      left.style.clip = 'auto';
      left.style.clipPath = '';
      left.style.webkitClipPath = '';
    }
    const divider = document.getElementById('compareDivider');
    if (divider) divider.style.left = `${pct * 100}%`;
  }

  function applyComparison() {
    const enabled = document.getElementById('compareEnabled');
    const leftSelect = document.getElementById('compareLeft');
    const rightSelect = document.getElementById('compareRight');
    const status = document.getElementById('compareStatus');
    const wrap = document.querySelector('.mapWrap');
    clearLayers();
    wrap?.classList.toggle('compareActive', !!enabled?.checked);
    if (!enabled?.checked) {
      status.className = 'layerStatus ready';
      status.textContent = `${sources.length} comparison sources available here`;
      return;
    }
    const a = sourceById(leftSelect.value);
    const b = sourceById(rightSelect.value);
    if (!a || !b) {
      status.className = 'layerStatus warn';
      status.textContent = 'Choose an available source for both sides.';
      return;
    }
    leftLayer = createLayer(a, 'compareLeft').addTo(map);
    rightLayer = createLayer(b, 'compareRight').addTo(map);
    document.getElementById('compareLeftLabel').textContent = a.label;
    document.getElementById('compareRightLabel').textContent = b.label;
    status.className = a.id === b.id ? 'layerStatus warn' : 'layerStatus ready';
    status.textContent = a.id === b.id ? 'Both sides use the same source.' : `${a.label} ↔ ${b.label}`;
    scheduleClip();
  }

  function lonLatToTile(lng, lat, z) {
    const n = 2 ** z;
    const clipped = Math.max(-85.05112878, Math.min(85.05112878, lat));
    const x = Math.floor((lng + 180) / 360 * n);
    const r = clipped * Math.PI / 180;
    const y = Math.floor((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2 * n);
    return [Math.max(0, Math.min(n - 1, x)), Math.max(0, Math.min(n - 1, y))];
  }

  function gridAvailable(g) {
    if (!g || !Number.isInteger(g.level) || typeof g.bits !== 'string' || g.bits.length < g.width * g.height) return null;
    const b = map.getBounds();
    const [left, top] = lonLatToTile(b.getWest(), b.getNorth(), g.level);
    const [right, bottom] = lonLatToTile(b.getEast(), b.getSouth(), g.level);
    const total = Math.max(1, (right - left + 1) * (bottom - top + 1));
    let available = 0;
    for (let y = Math.max(top, g.top); y <= Math.min(bottom, g.top + g.height - 1); y++) {
      for (let x = Math.max(left, g.left); x <= Math.min(right, g.left + g.width - 1); x++) {
        if (g.bits[(y - g.top) * g.width + (x - g.left)] === '1') available++;
      }
    }
    const c = map.getCenter();
    const [cx, cy] = lonLatToTile(c.lng, c.lat, g.level);
    const gx = cx - g.left;
    const gy = cy - g.top;
    const centre = gx >= 0 && gy >= 0 && gx < g.width && gy < g.height && g.bits[gy * g.width + gx] === '1';
    return centre || available / total >= MIN_OVERLAP;
  }

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

  function bboxAvailable(b) {
    if (!validBBox(b)) return false;
    const v = map.getBounds();
    const c = map.getCenter();
    const intersects = Math.max(v.getWest(), b[0]) < Math.min(v.getEast(), b[2]) && Math.max(v.getSouth(), b[1]) < Math.min(v.getNorth(), b[3]);
    return intersects && c.lng >= b[0] && c.lng <= b[2] && c.lat >= b[1] && c.lat <= b[3];
  }

  const historicAvailable = e => {
    const g = gridAvailable(e.coverageGrid);
    return g === null ? bboxAvailable(e.bbox) : g;
  };

  function rebuild(preserve = true) {
    const left = document.getElementById('compareLeft');
    const right = document.getElementById('compareRight');
    if (!left || !right) return;
    const previousLeft = preserve ? left.value : desired.left;
    const previousRight = preserve ? right.value : desired.right;
    const historicIds = new Set(imageryEpochs.filter(historicAvailable).map(e => `imagery:${e.year}`));

    sources = allSources.filter(source => {
      if (source.kind === 'historic') return historicIds.has(source.id);
      if (source.kind === 'lidar') return bboxAvailable(source.bbox);
      return true;
    });

    for (const select of [left, right]) {
      select.innerHTML = '';
      const aerial = document.createElement('optgroup');
      aerial.label = 'Aerial imagery';
      sources.filter(s => s.kind === 'current' || s.kind === 'historic').forEach(s => option(aerial, s.id, s.label));
      select.appendChild(aerial);
      const lidar = document.createElement('optgroup');
      lidar.label = 'High-resolution LiDAR hillshade';
      sources.filter(s => s.kind === 'lidar').forEach(s => option(lidar, s.id, s.label));
      if (lidar.children.length) select.appendChild(lidar);
    }

    const oldest = sources.filter(s => s.kind === 'historic').sort((a, b) => a.year - b.year)[0];
    const defaultLeft = oldest?.id || 'imagery:current';
    const defaultRight = sources.some(s => s.id === 'imagery:current') ? 'imagery:current' : (sources[0]?.id || '');
    left.value = sourceById(previousLeft) ? previousLeft : defaultLeft;
    right.value = sourceById(previousRight) ? previousRight : defaultRight;
    left.disabled = right.disabled = sources.length < 2;
    const enabled = document.getElementById('compareEnabled');
    const swap = document.getElementById('compareSwap');
    enabled.disabled = swap.disabled = sources.length < 2;
    if (desired.enabled && !enabled.disabled) enabled.checked = true;
    const localCount = sources.filter(s => s.kind === 'lidar').length;
    document.getElementById('compareStatus').textContent = `${sources.length} comparison sources available here${localCount ? ` • ${localCount} high-resolution LiDAR source${localCount === 1 ? '' : 's'}` : ''}`;
    applyComparison();
  }

  function addNamedAreaSources() {
    namedAreas.filter(a => a?.ready && a?.slug && a?.layers?.hillshade?.available).forEach(area => {
      const bbox = areaBBox(area);
      if (!bbox) return;
      const years = (area.years || []).join(', ');
      const res = Number(area.targetResolutionMeters);
      allSources.push({
        id: `lidar-area:${area.slug}`,
        kind: 'lidar',
        year: Math.max(...(area.years || [0]).map(Number)),
        label: `${area.name || area.slug} hillshade${years ? ` — ${years}` : ''}${Number.isFinite(res) ? ` (${res} m)` : ''}`,
        url: `/lidar/areas/${area.slug}/hillshade/{z}/{x}/{y}.png`,
        minZoom: Number(area.layers.hillshade.minZoom ?? 9),
        maxNativeZoom: Number(area.layers.hillshade.maxZoom ?? 17),
        bbox
      });
    });
  }

  function addLegacySources() {
    if (!legacyStatus?.ready) return;
    const bbox = areaBBox(legacyStatus);
    if (!bbox) return;
    if (legacyStatus.layers?.hillshade?.available) {
      allSources.push({ id:'lidar:legacy:latest', kind:'lidar', year:9999, label:'Legacy local LiDAR — latest hillshade', url:'/lidar/hillshade/{z}/{x}/{y}.png', minZoom:9, maxNativeZoom:17, bbox });
    }
    Object.entries(legacyStatus.epochLayers || {})
      .filter(([, v]) => v?.hillshade?.available)
      .sort(([a], [b]) => +a - +b)
      .forEach(([year]) => allSources.push({ id:`lidar:legacy:${year}`, kind:'lidar', year:+year, label:`${year} legacy local LiDAR hillshade`, url:`/lidar/epochs/${year}/hillshade/{z}/{x}/{y}.png`, minZoom:9, maxNativeZoom:17, bbox }));
  }

  async function load() {
    const status = document.getElementById('compareStatus');
    try {
      const [ir, ar, lr] = await Promise.allSettled([
        fetch('/lidar/imagery.json?' + Date.now(), { cache: 'no-store' }).then(r => r.ok ? r.json() : Promise.reject(new Error('imagery catalogue unavailable'))),
        fetch('/lidar/areas.json?' + Date.now(), { cache: 'no-store' }).then(r => r.ok ? r.json() : Promise.reject(new Error('area catalogue unavailable'))),
        fetch('/lidar/status.json?' + Date.now(), { cache: 'no-store' }).then(r => r.ok ? r.json() : Promise.reject(new Error('legacy LiDAR status unavailable')))
      ]);
      const imagery = ir.status === 'fulfilled' ? ir.value : { epochs: [] };
      namedAreas = ar.status === 'fulfilled' ? (ar.value.areas || []) : [];
      legacyStatus = lr.status === 'fulfilled' ? lr.value : null;
      imageryEpochs = (imagery.epochs || []).filter(e => e.tileUrl);

      allSources = [{
        id:'imagery:current', kind:'current', year:9999,
        label:'Current NSW aerial imagery', url:CURRENT, maxNativeZoom:18,
        attribution:'© State of New South Wales (Spatial Services)'
      }];
      imageryEpochs.forEach(e => allSources.push({
        id:`imagery:${e.year}`, kind:'historic', year:Number(e.year),
        label:`${e.year} aerial — ${e.title || 'NSW historical imagery'}`,
        url:e.tileUrl, maxNativeZoom:20,
        attribution:'© State of New South Wales (Spatial Services historical imagery)'
      }));
      addNamedAreaSources();
      addLegacySources();
      rebuild(false);
    } catch (err) {
      status.className = 'layerStatus warn';
      status.textContent = `Comparison sources unavailable: ${err.message}`;
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
  map.on('move zoom resize zoomend', scheduleClip);
  map.on('moveend zoomend', () => {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => rebuild(true), 180);
  });
  document.addEventListener('lidarareachange', () => rebuild(true));
  load();
})();
