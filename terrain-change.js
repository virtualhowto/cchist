(() => {
  'use strict';

  let changeLayer = null;
  let catalogue = null;

  function addStyles() {
    if (document.getElementById('terrainChangeStyles')) return;
    const style = document.createElement('style');
    style.id = 'terrainChangeStyles';
    style.textContent = `
      .changeLegend{display:grid;grid-template-columns:1fr 1fr;gap:6px 10px;margin-top:9px;font-size:11px;color:var(--muted)}
      .changeLegendItem{display:flex;align-items:center;gap:6px;min-width:0}
      .changeSwatch{width:13px;height:13px;border-radius:3px;border:1px solid rgba(255,255,255,.35);flex:0 0 auto}
      .changeHint{margin-top:7px;font-size:11px;line-height:1.35;color:var(--muted)}
    `;
    document.head.appendChild(style);
  }

  function addUi() {
    const panel = document.getElementById('layerPanel');
    if (!panel || document.getElementById('terrainChangePair')) return;

    const group = document.createElement('div');
    group.className = 'layerGroup';
    group.id = 'terrainChangeGroup';
    group.innerHTML = `
      <h3>Terrain change</h3>
      <label for="terrainChangePair">LiDAR comparison</label>
      <select class="search" id="terrainChangePair" disabled>
        <option value="">Off</option>
      </select>
      <div class="layerOpacity">
        <label for="terrainChangeOpacity"><span>Change opacity</span><span id="terrainChangeOpacityValue">80%</span></label>
        <input class="range" id="terrainChangeOpacity" type="range" min="10" max="100" step="5" value="80">
      </div>
      <div id="terrainChangeLegend" class="changeLegend"></div>
      <div id="terrainChangeStatus" class="layerStatus warn">Loading terrain-change catalogue…</div>
      <div class="changeHint">Research aid only. Survey alignment, vegetation/classification and interpolation can also create apparent differences.</div>
    `;

    const share = document.getElementById('copyViewLink')?.closest('.layerGroup');
    if (share) panel.insertBefore(group, share); else panel.appendChild(group);

    document.getElementById('terrainChangePair').addEventListener('change', applyLayer);
    document.getElementById('terrainChangeOpacity').addEventListener('input', e => {
      const value = Number(e.target.value || 80);
      document.getElementById('terrainChangeOpacityValue').textContent = `${value}%`;
      if (changeLayer) changeLayer.setOpacity(value / 100);
    });
  }

  function renderLegend(items) {
    const el = document.getElementById('terrainChangeLegend');
    if (!el) return;
    el.innerHTML = '';
    for (const item of items || []) {
      const rgba = item.rgba || [128,128,128,220];
      const row = document.createElement('div');
      row.className = 'changeLegendItem';
      row.innerHTML = `<span class="changeSwatch" style="background:rgba(${rgba.join(',')})"></span><span></span>`;
      row.lastElementChild.textContent = item.label || '';
      el.appendChild(row);
    }
  }

  function removeLayer() {
    if (changeLayer && map.hasLayer(changeLayer)) map.removeLayer(changeLayer);
    changeLayer = null;
  }

  function applyLayer() {
    removeLayer();
    const select = document.getElementById('terrainChangePair');
    const status = document.getElementById('terrainChangeStatus');
    const key = select?.value || '';
    if (!key) {
      status.className = 'layerStatus ready';
      status.textContent = catalogue ? `${Object.keys(catalogue.pairs || {}).length} terrain comparisons available` : 'Terrain change off';
      return;
    }

    const item = catalogue?.pairs?.[key];
    if (!item?.available || !item.tileUrl) {
      status.className = 'layerStatus warn';
      status.textContent = 'Selected terrain comparison is unavailable.';
      return;
    }

    const opacity = Number(document.getElementById('terrainChangeOpacity')?.value || 80) / 100;
    changeLayer = L.tileLayer(item.tileUrl, {
      minZoom: item.minZoom || 9,
      maxZoom: 20,
      maxNativeZoom: item.maxZoom || 17,
      opacity,
      pane: 'terrainChange',
      attribution: 'Terrain change derived from NSW Spatial Services LiDAR DEMs'
    }).addTo(map);

    status.className = 'layerStatus ready';
    status.textContent = `${item.fromYear} → ${item.toYear}; changes ≥ ${item.thresholdMetres} m shown`;
  }

  async function loadCatalogue() {
    const status = document.getElementById('terrainChangeStatus');
    const select = document.getElementById('terrainChangePair');
    try {
      const response = await fetch('/lidar/change.json?' + Date.now(), { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      catalogue = await response.json();

      for (const [key, item] of Object.entries(catalogue.pairs || {})) {
        if (!item?.available) continue;
        const option = document.createElement('option');
        option.value = key;
        option.textContent = `${item.fromYear} → ${item.toYear}`;
        select.appendChild(option);
      }
      select.disabled = Object.keys(catalogue.pairs || {}).length === 0;
      renderLegend(catalogue.legend || []);
      status.className = catalogue.ready ? 'layerStatus ready' : 'layerStatus warn';
      status.textContent = catalogue.ready
        ? `${Object.keys(catalogue.pairs || {}).length} terrain comparisons available`
        : 'Terrain-change layers have not been built yet.';
      select.dispatchEvent(new CustomEvent('terrainchange:ready', { bubbles: true }));
    } catch (e) {
      status.className = 'layerStatus warn';
      status.textContent = `Terrain-change catalogue unavailable: ${e.message}`;
    }
  }

  addStyles();
  addUi();
  if (!map.getPane('terrainChange')) map.createPane('terrainChange');
  map.getPane('terrainChange').style.zIndex = 365;
  map.getPane('terrainChange').style.pointerEvents = 'none';
  loadCatalogue();
})();
