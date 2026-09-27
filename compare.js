(() => {
  'use strict';

  const params = new URLSearchParams(location.search);
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  const desired = {
    enabled: params.get('compare') === 'swipe',
    left: params.get('left') || '',
    right: params.get('right') || '',
    split: clamp(Number(params.get('split')) || 50, 5, 95)
  };

  const CURRENT_IMAGERY_URL = 'https://maps.six.nsw.gov.au/arcgis/rest/services/public/NSW_Imagery/MapServer/tile/{z}/{y}/{x}';
  let sources = [];
  let leftLayer = null;
  let rightLayer = null;
  let dragging = false;

  function addStyles() {
    if (document.getElementById('compareStyles')) return;
    const style = document.createElement('style');
    style.id = 'compareStyles';
    style.textContent = `
      .compareGrid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.compareGrid label{margin-top:3px}.compareActions{display:flex;gap:8px;margin-top:8px}.compareBtn{flex:1;min-height:40px;border:1px solid var(--line);background:var(--panel2);color:var(--text);border-radius:9px;cursor:pointer}.compareDivider{display:none;position:absolute;z-index:590;top:0;bottom:0;width:28px;margin-left:-14px;cursor:ew-resize;touch-action:none}.compareDivider::before{content:'';position:absolute;left:13px;top:0;bottom:0;width:2px;background:#fff;box-shadow:0 0 0 1px rgba(0,0,0,.45),0 0 12px rgba(0,0,0,.5)}.compareHandle{position:absolute;left:2px;top:50%;transform:translateY(-50%);width:24px;height:44px;border-radius:12px;background:rgba(15,23,32,.94);border:1px solid rgba(255,255,255,.8);display:flex;align-items:center;justify-content:center;color:#fff;font-size:15px;box-shadow:0 3px 12px rgba(0,0,0,.45)}.compareLabel{display:none;position:absolute;z-index:580;bottom:18px;max-width:42%;padding:7px 9px;border-radius:8px;background:rgba(15,23,32,.9);border:1px solid var(--line);color:var(--text);font-size:12px;pointer-events:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.compareLabel.left{left:12px}.compareLabel.right{right:12px;text-align:right}.compareActive .compareDivider,.compareActive .compareLabel{display:block}@media(max-width:760px){.compareGrid{grid-template-columns:1fr}.compareLabel{bottom:10px;max-width:45%;font-size:11px}.compareDivider{width:34px;margin-left:-17px}.compareDivider::before{left:16px}.compareHandle{left:4px;width:26px}}
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
      <label class="layerRow"><input type="checkbox" id="compareEnabled"><span class="layerText"><b>Enable comparison</b><small>Drag across two dated aerial or LiDAR layers</small></span></label>
      <div class="compareGrid">
        <div><label for="compareLeft">Left</label><select class="search" id="compareLeft" disabled></select></div>
        <div><label for="compareRight">Right</label><select class="search" id="compareRight" disabled></select></div>
      </div>
      <div class="compareActions"><button type="button" class="compareBtn" id="compareSwap">⇄ Swap</button></div>
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

    // Preserve requested URL state while the two catalogues load asynchronously.
    if (desired.left) option(left, desired.left, 'Restoring left source…');
    if (desired.right) option(right, desired.right, 'Restoring right source…');

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
      divider.setPointerCapture?.(e.pointerId);
      map.dragging.disable();
      updateSplitFromPointer(e);
      e.preventDefault();
    });
    divider.addEventListener('pointermove', e => {
      if (dragging) updateSplitFromPointer(e);
    });
    const stopDrag = e => {
      if (!dragging) return;
      dragging = false;
      divider.releasePointerCapture?.(e.pointerId);
      map.dragging.enable();
    };
    divider.addEventListener('pointerup', stopDrag);
    divider.addEventListener('pointercancel', stopDrag);

    enabled.addEventListener('change', applyComparison);
    left.addEventListener('change', applyComparison);
    right.addEventListener('change', applyComparison);
    split.addEventListener('input', () => {
      document.getElementById('compareSplitValue').textContent = `${split.value}%`;
      updateClip();
    });
    document.getElementById('compareSwap').addEventListener('click', () => {
      const a = left.value;
      left.value = right.value;
      right.value = a;
      left.dispatchEvent(new Event('change', { bubbles: true }));
      right.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  function updateSplitFromPointer(e) {
    const rect = map.getContainer().getBoundingClientRect();
    const pct = clamp(((e.clientX - rect.left) / rect.width) * 100, 5, 95);
    const split = document.getElementById('compareSplit');
    split.value = String(Math.round(pct));
    split.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function createLayer(source, pane) {
    return L.tileLayer(source.url, {
      minZoom: source.minZoom || 0,
      maxZoom: 20,
      maxNativeZoom: source.maxNativeZoom || 20,
      opacity: 1,
      pane,
      attribution: source.attribution || 'NSW Spatial Services'
    });
  }

  function sourceById(id) {
    return sources.find(s => s.id === id);
  }

  function removeLayers() {
    [leftLayer, rightLayer].forEach(layer => {
      if (!layer) return;
      const container = layer.getContainer?.();
      if (container) container.style.clip = '';
      if (map.hasLayer(layer)) map.removeLayer(layer);
    });
    leftLayer = null;
    rightLayer = null;
  }

  function updateLabels(leftSource, rightSource) {
    document.getElementById('compareLeftLabel').textContent = leftSource?.label || '';
    document.getElementById('compareRightLabel').textContent = rightSource?.label || '';
  }

  function updateClip() {
    if (!leftLayer || !rightLayer) return;
    const split = Number(document.getElementById('compareSplit')?.value || 50) / 100;
    const size = map.getSize();
    const nw = map.containerPointToLayerPoint([0, 0]);
    const se = map.containerPointToLayerPoint(size);
    const x = nw.x + split * (se.x - nw.x);
    const leftContainer = leftLayer.getContainer?.();
    const rightContainer = rightLayer.getContainer?.();
    if (leftContainer) leftContainer.style.clip = `rect(${nw.y}px, ${x}px, ${se.y}px, ${nw.x}px)`;
    if (rightContainer) rightContainer.style.clip = `rect(${nw.y}px, ${se.x}px, ${se.y}px, ${x}px)`;
    const divider = document.getElementById('compareDivider');
    if (divider) divider.style.left = `${split * 100}%`;
  }

  function applyComparison() {
    const enabled = document.getElementById('compareEnabled');
    const leftSelect = document.getElementById('compareLeft');
    const rightSelect = document.getElementById('compareRight');
    const status = document.getElementById('compareStatus');
    const mapWrap = document.querySelector('.mapWrap');

    removeLayers();
    mapWrap.classList.toggle('compareActive', Boolean(enabled?.checked));
    if (!enabled?.checked) {
      status.className = 'layerStatus ready';
      status.textContent = `${sources.length} comparison sources available`;
      return;
    }

    const leftSource = sourceById(leftSelect.value);
    const rightSource = sourceById(rightSelect.value);
    if (!leftSource || !rightSource) {
      status.className = 'layerStatus warn';
      status.textContent = 'Choose a source for both sides.';
      return;
    }

    leftLayer = createLayer(leftSource, 'compareLeft').addTo(map);
    rightLayer = createLayer(rightSource, 'compareRight').addTo(map);
    updateLabels(leftSource, rightSource);
    status.className = 'layerStatus ready';
    status.textContent = `${leftSource.label} ↔ ${rightSource.label}`;
    requestAnimationFrame(updateClip);
  }

  function buildSourceOptions() {
    const left = document.getElementById('compareLeft');
    const right = document.getElementById('compareRight');
    const previousLeft = desired.left || left.value;
    const previousRight = desired.right || right.value;
    left.innerHTML = '';
    right.innerHTML = '';

    for (const select of [left, right]) {
      const aerial = document.createElement('optgroup');
      aerial.label = 'Aerial imagery';
      sources.filter(s => s.kind === 'imagery').forEach(s => option(aerial, s.id, s.label));
      select.appendChild(aerial);
      const lidar = document.createElement('optgroup');
      lidar.label = 'LiDAR hillshade';
      sources.filter(s => s.kind === 'lidar').forEach(s => option(lidar, s.id, s.label));
      select.appendChild(lidar);
    }

    const oldestHistoric = sources.filter(s => s.kind === 'imagery' && s.id !== 'imagery:current').sort((a, b) => a.year - b.year)[0];
    const defaultLeft = oldestHistoric?.id || 'lidar:2011';
    const defaultRight = sources.some(s => s.id === 'imagery:current') ? 'imagery:current' : (sources.at(-1)?.id || defaultLeft);
    left.value = sourceById(previousLeft) ? previousLeft : defaultLeft;
    right.value = sourceById(previousRight) ? previousRight : defaultRight;
    left.disabled = !sources.length;
    right.disabled = !sources.length;
    document.getElementById('compareStatus').className = 'layerStatus ready';
    document.getElementById('compareStatus').textContent = `${sources.length} comparison sources available`;
    applyComparison();
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

      sources = [{
        id: 'imagery:current', kind: 'imagery', year: 9999,
        label: 'Current NSW aerial imagery', url: CURRENT_IMAGERY_URL,
        maxNativeZoom: 18,
        attribution: '© State of New South Wales (Spatial Services)'
      }];

      (imagery.epochs || []).filter(e => e.tileUrl).forEach(e => sources.push({
        id: `imagery:${e.year}`, kind: 'imagery', year: Number(e.year),
        label: `${e.year} aerial — ${e.title || 'NSW historical imagery'}`,
        url: e.tileUrl, maxNativeZoom: 20,
        attribution: '© State of New South Wales (Spatial Services historical imagery)'
      }));

      if (lidar.layers?.hillshade?.available) sources.push({
        id: 'lidar:latest', kind: 'lidar', year: 9999,
        label: 'Latest LiDAR hillshade', url: '/lidar/hillshade/{z}/{x}/{y}.png',
        minZoom: 9, maxNativeZoom: 17,
        attribution: 'LiDAR derived from NSW Spatial Services elevation data'
      });
      Object.entries(lidar.epochLayers || {})
        .filter(([, v]) => v?.hillshade?.available)
        .sort(([a], [b]) => Number(a) - Number(b))
        .forEach(([year]) => sources.push({
          id: `lidar:${year}`, kind: 'lidar', year: Number(year),
          label: `${year} LiDAR hillshade`, url: `/lidar/epochs/${year}/hillshade/{z}/{x}/{y}.png`,
          minZoom: 9, maxNativeZoom: 17,
          attribution: 'LiDAR derived from NSW Spatial Services elevation data'
        }));

      buildSourceOptions();
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
  map.on('move zoom resize zoomend', updateClip);
  loadSources();
})();
