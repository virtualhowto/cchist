(() => {
  'use strict';
  if (typeof map === 'undefined' || typeof L === 'undefined') return;

  const panel = document.getElementById('layerPanel');
  if (!panel || document.getElementById('ga5mToggle')) return;

  if (!map.getPane('statewideTerrain')) map.createPane('statewideTerrain');
  map.getPane('statewideTerrain').style.zIndex = 330;
  map.getPane('statewideTerrain').style.pointerEvents = 'none';

  const WMS = 'https://services.ga.gov.au/gis/services/DEM_LiDAR_5m_2025/MapServer/WMSServer';
  const layer = L.tileLayer.wms(WMS, {
    layers: '0',
    format: 'image/png',
    transparent: true,
    version: '1.1.1',
    opacity: 0.65,
    pane: 'statewideTerrain',
    attribution: 'Geoscience Australia — DEM LiDAR 5m'
  });

  const group = document.createElement('div');
  group.className = 'layerGroup';
  group.id = 'statewideTerrainGroup';
  group.innerHTML = `
    <h3>Statewide terrain baseline</h3>
    <label class="layerRow"><input type="checkbox" id="ga5mToggle"><span class="layerText"><b>GA 5 m LiDAR-derived DEM</b><small>National 5 m bare-earth LiDAR compilation, displayed live where source coverage exists.</small></span></label>
    <div class="layerOpacity"><label for="ga5mOpacity"><span>Baseline opacity</span><span id="ga5mOpacityValue">65%</span></label><input class="range" id="ga5mOpacity" type="range" min="10" max="100" step="5" value="65"></div>
    <div id="ga5mStatus" class="layerStatus">Remote baseline — does not consume local ELVIS storage.</div>
    <a href="https://services.ga.gov.au/gis/rest/services/DEM_LiDAR_5m_2025/MapServer" target="_blank" rel="noopener">Geoscience Australia 5 m DEM service</a>`;

  const lidarGroup = [...panel.querySelectorAll('.layerGroup')].find(x => x.querySelector('h3')?.textContent.trim().toLowerCase() === 'lidar-derived analysis');
  if (lidarGroup) panel.insertBefore(group, lidarGroup); else panel.appendChild(group);

  const toggle = document.getElementById('ga5mToggle');
  const opacity = document.getElementById('ga5mOpacity');
  const value = document.getElementById('ga5mOpacityValue');
  const status = document.getElementById('ga5mStatus');

  toggle.addEventListener('change', () => {
    if (toggle.checked) layer.addTo(map); else if (map.hasLayer(layer)) map.removeLayer(layer);
  });
  opacity.addEventListener('input', () => {
    const v = Number(opacity.value) || 65;
    value.textContent = `${v}%`;
    layer.setOpacity(v / 100);
  });
  layer.on('loading', () => { status.className = 'layerStatus'; status.textContent = 'Loading Geoscience Australia 5 m terrain…'; });
  layer.on('load', () => { status.className = 'layerStatus ready'; status.textContent = 'GA 5 m terrain loaded for the current map view where coverage exists.'; });
  layer.on('tileerror', () => { status.className = 'layerStatus warn'; status.textContent = 'Some GA 5 m terrain tiles are unavailable in this view; the source compilation has coverage gaps.'; });

  window.cchistStatewideTerrain = { layer, toggle, opacity };
})();
