(() => {
  'use strict';

  if (typeof map === 'undefined') return;
  const cfg = window.NSW_CONFIG || { bounds:{west:140.8,south:-37.7,east:159.4,north:-28.0}, defaultView:{lat:-32.7,lng:147,zoom:6} };
  const params = new URLSearchParams(location.search);
  let restoring = true;
  let writeTimer = null;
  const pending = new Set();

  const num = (name, fallback, min, max) => {
    const raw = params.get(name);
    if (raw === null || String(raw).trim() === '') return fallback;
    const value = Number(raw);
    return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
  };
  const inNsw = (lat,lng) => Number.isFinite(lat) && Number.isFinite(lng) && lat >= cfg.bounds.south && lat <= cfg.bounds.north && lng >= cfg.bounds.west && lng <= cfg.bounds.east;

  const desired = {
    lat: num('lat', cfg.defaultView.lat, -90, 90),
    lng: num('lng', cfg.defaultView.lng, -180, 180),
    zoom: Math.round(num('z', cfg.defaultView.zoom, 1, 20)),
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
  if (!inNsw(desired.lat, desired.lng)) Object.assign(desired, cfg.defaultView);

  const dispatch = (el,type) => el?.dispatchEvent(new Event(type,{bubbles:true}));
  const setInput = (id,value,type='input') => { const el=document.getElementById(id); if(!el)return; el.value=String(value); dispatch(el,type); };

  function applyImmediate() {
    map.setView([desired.lat,desired.lng],desired.zoom,{animate:false});
    const base = baseLayers?.[desired.base] ? desired.base : 'osm';
    const radio = document.querySelector(`input[name="base"][value="${CSS.escape(base)}"]`);
    if (radio) { radio.checked=true; dispatch(radio,'change'); }
    setInput('overlayOpacity',desired.lidarOpacity);
    setInput('imageryOpacity',desired.imageryOpacity);
    setInput('terrainChangeOpacity',desired.changeOpacity);
    const markers = document.getElementById('markersToggle');
    if (markers) { markers.checked=desired.markers; dispatch(markers,'change'); }
    const yr = document.getElementById('yr');
    if (yr) {
      desired.researchYear=Math.max(Number(yr.min||1820),Math.min(Number(yr.max||desired.researchYear),desired.researchYear));
      yr.value=String(desired.researchYear); dispatch(yr,'input');
    }
  }

  function selectWhenReady(id,wanted,key) {
    const el=document.getElementById(id);
    if(!el || el.disabled || ![...el.options].some(o=>o.value===String(wanted))) return false;
    el.value=String(wanted); dispatch(el,'change'); pending.delete(key); return true;
  }
  function restoreLayers() {
    if (!desired.layers.length) { pending.delete('layers'); return true; }
    let waiting=false;
    document.querySelectorAll('.lidarCheck').forEach(el=>{
      const on=desired.layers.includes(el.value);
      if(on && el.disabled) { waiting=true; return; }
      el.checked=on; dispatch(el,'change');
    });
    if(!waiting) pending.delete('layers');
    return !waiting;
  }
  function restoreDeferred() {
    if(desired.lidar!=='latest'){pending.add('lidar');selectWhenReady('lidarEpoch',desired.lidar,'lidar');}
    if(desired.imagery){pending.add('imagery');selectWhenReady('historicImageryYear',desired.imagery,'imagery');}
    if(desired.change){pending.add('change');selectWhenReady('terrainChangePair',desired.change,'change');}
    if(desired.layers.length){pending.add('layers');restoreLayers();}
    if(!pending.size) finishRestore();
  }
  function finishRestore(){ if(!restoring)return; restoring=false; updateUrl(); }
  function currentBase(){return document.querySelector('input[name="base"]:checked')?.value||'osm';}

  function updateUrl() {
    if(restoring) return;
    let c=map.getCenter();
    if(!inNsw(c.lat,c.lng)) { map.setView([cfg.defaultView.lat,cfg.defaultView.lng],cfg.defaultView.zoom,{animate:false}); c=map.getCenter(); }
    const out=new URLSearchParams();
    out.set('lat',c.lat.toFixed(6)); out.set('lng',c.lng.toFixed(6)); out.set('z',String(map.getZoom())); out.set('base',currentBase());
    const imagery=document.getElementById('historicImageryYear')?.value||''; if(imagery)out.set('imagery',imagery);
    const lidar=document.getElementById('lidarEpoch')?.value||'latest'; out.set('lidar',lidar);
    const active=[...document.querySelectorAll('.lidarCheck:checked')].map(x=>x.value); if(active.length)out.set('layers',active.join(','));
    out.set('lop',document.getElementById('overlayOpacity')?.value||'70'); out.set('iop',document.getElementById('imageryOpacity')?.value||'100');
    const change=document.getElementById('terrainChangePair')?.value||''; if(change){out.set('change',change);out.set('cop',document.getElementById('terrainChangeOpacity')?.value||'80');}
    if(!document.getElementById('markersToggle')?.checked)out.set('markers','0');
    out.set('research',document.getElementById('yr')?.value||'1950');
    const rs=typeof window.cchistResearchState==='function'?window.cchistResearchState():null;
    if(rs){out.set('rscope',rs.scope||'view'); if(['centre','point'].includes(rs.scope))out.set('rr',String(rs.radiusKm||5)); if(rs.scope==='point'&&rs.point){out.set('rlat',Number(rs.point.lat).toFixed(6));out.set('rlng',Number(rs.point.lng).toFixed(6));} if(rs.topic)out.set('rtopic',rs.topic);}
    if(document.getElementById('compareEnabled')?.checked){out.set('compare','swipe');const l=document.getElementById('compareLeft')?.value||'';const r=document.getElementById('compareRight')?.value||'';if(l)out.set('left',l);if(r)out.set('right',r);out.set('split',document.getElementById('compareSplit')?.value||'50');}
    history.replaceState(null,'',`${location.pathname}?${out.toString()}${location.hash}`);
  }
  function queue(){if(restoring)return;clearTimeout(writeTimer);writeTimer=setTimeout(updateUrl,120);}
  function listeners(){
    map.on('moveend',queue);
    document.querySelectorAll('input[name="base"],.lidarCheck,#markersToggle,#compareEnabled').forEach(el=>el.addEventListener('change',queue));
    ['lidarEpoch','historicImageryYear','terrainChangePair','compareLeft','compareRight'].forEach(id=>document.getElementById(id)?.addEventListener('change',queue));
    ['overlayOpacity','imageryOpacity','terrainChangeOpacity','yr','compareSplit'].forEach(id=>document.getElementById(id)?.addEventListener('input',queue));
    document.addEventListener('researchscopechange',queue);
  }
  function shareControl(){
    const panel=document.getElementById('layerPanel'); if(!panel||document.getElementById('copyViewLink'))return;
    const g=document.createElement('div');g.className='layerGroup';g.innerHTML='<h3>Share research view</h3><button id="copyViewLink" type="button" style="width:100%;min-height:42px;border:1px solid var(--line);background:var(--panel2);color:var(--text);border-radius:9px;cursor:pointer">Copy view link</button><div id="copyViewStatus" class="layerStatus">URL tracks NSW map position, research scope and selected layers.</div>';panel.appendChild(g);
    document.getElementById('copyViewLink').addEventListener('click',async()=>{updateUrl();const s=document.getElementById('copyViewStatus');try{await navigator.clipboard.writeText(location.href);s.className='layerStatus ready';s.textContent='View link copied.';}catch{s.className='layerStatus warn';s.textContent=location.href;}});
  }

  applyImmediate(); listeners(); shareControl(); restoreDeferred();
  const poll=setInterval(()=>{if(!restoring){clearInterval(poll);return;}if(pending.has('lidar'))selectWhenReady('lidarEpoch',desired.lidar,'lidar');if(pending.has('imagery'))selectWhenReady('historicImageryYear',desired.imagery,'imagery');if(pending.has('change'))selectWhenReady('terrainChangePair',desired.change,'change');if(pending.has('layers'))restoreLayers();if(!pending.size){clearInterval(poll);finishRestore();}},300);
  setTimeout(()=>{clearInterval(poll);finishRestore();},15000);
})();
