(() => {
  'use strict';

  const params = new URLSearchParams(location.search);
  let restoring = true;
  let writeTimer = null;
  const pending = new Set();
  const DEFAULT_VIEW = { lat: -33.39, lng: 151.39, zoom: 10 };

  const num = (name, fallback, min, max) => {
    const raw = params.get(name);
    if (raw === null || String(raw).trim() === '') return fallback;
    const value = Number(raw);
    return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
  };

  const desired = {
    lat: num('lat', DEFAULT_VIEW.lat, -90, 90),
    lng: num('lng', DEFAULT_VIEW.lng, -180, 180),
    zoom: Math.round(num('z', DEFAULT_VIEW.zoom, 1, 20)),
    base: params.get('base') || 'osm',
    imagery: params.get('imagery') || '',
    lidar: params.get('lidar') || 'latest',
    layers: (params.get('layers') || '').split(',').filter(Boolean),
    lidarOpacity: Math.round(num('lop', 70, 10, 100)),
    imageryOpacity: Math.round(num('iop', 100, 10, 100)),
    change: params.get('change') || '',
    changeOpacity: Math.round(num('cop', 80, 10, 100)),
    markers: params.get('markers') !== '0',
    researchYear: Math.round(num('research', 1950, 1820, 2100))
  };

  const isCentralCoastRegion = (lat, lng) =>
    Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= -34.5 && lat <= -32.5 && lng >= 150.0 && lng <= 152.5;

  if (!isCentralCoastRegion(desired.lat, desired.lng)) {
    desired.lat = DEFAULT_VIEW.lat;
    desired.lng = DEFAULT_VIEW.lng;
    desired.zoom = DEFAULT_VIEW.zoom;
  }

  function dispatch(el, type) {
    if (el) el.dispatchEvent(new Event(type, { bubbles: true }));
  }

  function setInput(id, value, eventType = 'input') {
    const el = document.getElementById(id);
    if (!el) return;
    el.value = String(value);
    dispatch(el, eventType);
  }

  function applyImmediateState() {
    map.setView([desired.lat, desired.lng], desired.zoom, { animate: false });

    const base = baseLayers[desired.base] ? desired.base : 'osm';
    const baseRadio = document.querySelector(`input[name="base"][value="${CSS.escape(base)}"]`);
    if (baseRadio) {
      baseRadio.checked = true;
      dispatch(baseRadio, 'change');
    }

    setInput('overlayOpacity', desired.lidarOpacity);
    setInput('imageryOpacity', desired.imageryOpacity);
    setInput('terrainChangeOpacity', desired.changeOpacity);

    const markerToggle = document.getElementById('markersToggle');
    if (markerToggle) {
      markerToggle.checked = desired.markers;
      dispatch(markerToggle, 'change');
    }

    const research = document.getElementById('yr');
    if (research) {
      desired.researchYear = Math.max(Number(research.min || 1820), Math.min(Number(research.max || desired.researchYear), desired.researchYear));
      research.value = String(desired.researchYear);
      dispatch(research, 'input');
    }
  }

  function selectWhenAvailable(id, wanted, key) {
    const el = document.getElementById(id);
    if (!el) return false;
    const option = [...el.options].find(o => o.value === String(wanted));
    if (!option || el.disabled) return false;
    el.value = String(wanted);
    dispatch(el, 'change');
    pending.delete(key);
    return true;
  }

  function layersWhenAvailable() {
    if (!desired.layers.length) {
      pending.delete('layers');
      return true;
    }
    let waiting = false;
    document.querySelectorAll('.lidarCheck').forEach(el => {
      const shouldBeOn = desired.layers.includes(el.value);
      if (shouldBeOn && el.disabled) {
        waiting = true;
        return;
      }
      el.checked = shouldBeOn;
      dispatch(el, 'change');
    });
    if (!waiting) pending.delete('layers');
    return !waiting;
  }

  function restoreDeferred() {
    if (desired.lidar !== 'latest') {
      pending.add('lidar');
      selectWhenAvailable('lidarEpoch', desired.lidar, 'lidar');
    } else {
      const el = document.getElementById('lidarEpoch');
      if (el) {
        el.value = 'latest';
        dispatch(el, 'change');
      }
    }

    if (desired.imagery) {
      pending.add('imagery');
      selectWhenAvailable('historicImageryYear', desired.imagery, 'imagery');
    }

    if (desired.change) {
      pending.add('change');
      selectWhenAvailable('terrainChangePair', desired.change, 'change');
    }

    if (desired.layers.length) {
      pending.add('layers');
      layersWhenAvailable();
    }

    if (!pending.size) finishRestore();
  }

  function finishRestore() {
    if (!restoring) return;
    restoring = false;
    updateUrl();
  }

  function currentBaseName() {
    const checked = document.querySelector('input[name="base"]:checked');
    return checked?.value || 'osm';
  }

  function updateUrl() {
    if (restoring) return;
    let center = map.getCenter();
    if (!isCentralCoastRegion(center.lat, center.lng)) {
      map.setView([DEFAULT_VIEW.lat, DEFAULT_VIEW.lng], DEFAULT_VIEW.zoom, { animate: false });
      center = map.getCenter();
    }

    const out = new URLSearchParams();
    out.set('lat', center.lat.toFixed(6));
    out.set('lng', center.lng.toFixed(6));
    out.set('z', String(map.getZoom()));
    out.set('base', currentBaseName());

    const imagery = document.getElementById('historicImageryYear')?.value || '';
    if (imagery) out.set('imagery', imagery);

    out.set('lidar', document.getElementById('lidarEpoch')?.value || 'latest');
    const activeLayers = [...document.querySelectorAll('.lidarCheck:checked')].map(x => x.value);
    if (activeLayers.length) out.set('layers', activeLayers.join(','));

    out.set('lop', document.getElementById('overlayOpacity')?.value || '70');
    out.set('iop', document.getElementById('imageryOpacity')?.value || '100');

    const change = document.getElementById('terrainChangePair')?.value || '';
    if (change) {
      out.set('change', change);
      out.set('cop', document.getElementById('terrainChangeOpacity')?.value || '80');
    }

    if (!document.getElementById('markersToggle')?.checked) out.set('markers', '0');
    out.set('research', document.getElementById('yr')?.value || '1950');

    const researchState = typeof window.cchistResearchState === 'function' ? window.cchistResearchState() : null;
    if (researchState) {
      out.set('rscope', researchState.scope || 'view');
      if (researchState.scope === 'centre' || researchState.scope === 'point') {
        out.set('rr', String(researchState.radiusKm || 5));
      }
      if (researchState.scope === 'point' && researchState.point) {
        out.set('rlat', Number(researchState.point.lat).toFixed(6));
        out.set('rlng', Number(researchState.point.lng).toFixed(6));
      }
      if (researchState.topic) out.set('rtopic', researchState.topic);
    }

    const compareEnabled = document.getElementById('compareEnabled');
    if (compareEnabled?.checked) {
      out.set('compare', 'swipe');
      const left = document.getElementById('compareLeft')?.value || '';
      const right = document.getElementById('compareRight')?.value || '';
      if (left) out.set('left', left);
      if (right) out.set('right', right);
      out.set('split', document.getElementById('compareSplit')?.value || '50');
    }

    const next = `${location.pathname}?${out.toString()}${location.hash}`;
    history.replaceState(null, '', next);
  }

  function queueUrlUpdate() {
    if (restoring) return;
    clearTimeout(writeTimer);
    writeTimer = setTimeout(updateUrl, 120);
  }

  function addListeners() {
    map.on('moveend', queueUrlUpdate);
    document.querySelectorAll('input[name="base"],.lidarCheck,#markersToggle,#compareEnabled').forEach(el => el.addEventListener('change', queueUrlUpdate));
    ['lidarEpoch', 'historicImageryYear', 'terrainChangePair', 'compareLeft', 'compareRight'].forEach(id => document.getElementById(id)?.addEventListener('change', queueUrlUpdate));
    ['overlayOpacity', 'imageryOpacity', 'terrainChangeOpacity', 'yr', 'compareSplit'].forEach(id => document.getElementById(id)?.addEventListener('input', queueUrlUpdate));
    document.addEventListener('researchscopechange', queueUrlUpdate);
  }

  function addShareControl() {
    const panel = document.getElementById('layerPanel');
    if (!panel || document.getElementById('copyViewLink')) return;
    const group = document.createElement('div');
    group.className = 'layerGroup';
    group.innerHTML = '<h3>Share research view</h3><button id="copyViewLink" type="button" style="width:100%;min-height:42px;border:1px solid var(--line);background:var(--panel2);color:var(--text);border-radius:9px;cursor:pointer">Copy view link</button><div id="copyViewStatus" class="layerStatus">URL tracks map position, research scope, dated layers, terrain change and swipe comparison.</div>';
    panel.appendChild(group);
    document.getElementById('copyViewLink').addEventListener('click', async () => {
      updateUrl();
      const status = document.getElementById('copyViewStatus');
      try {
        await navigator.clipboard.writeText(location.href);
        status.className = 'layerStatus ready';
        status.textContent = 'View link copied.';
      } catch {
        status.className = 'layerStatus warn';
        status.textContent = location.href;
      }
    });
  }

  applyImmediateState();
  addListeners();
  addShareControl();
  restoreDeferred();

  const poll = setInterval(() => {
    if (!restoring) {
      clearInterval(poll);
      return;
    }
    if (pending.has('lidar')) selectWhenAvailable('lidarEpoch', desired.lidar, 'lidar');
    if (pending.has('imagery')) selectWhenAvailable('historicImageryYear', desired.imagery, 'imagery');
    if (pending.has('change')) selectWhenAvailable('terrainChangePair', desired.change, 'change');
    if (pending.has('layers')) layersWhenAvailable();
    if (!pending.size) {
      clearInterval(poll);
      finishRestore();
    }
  }, 300);

  setTimeout(() => {
    clearInterval(poll);
    finishRestore();
  }, 15000);
})();
