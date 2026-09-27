(() => {
  'use strict';
  if (typeof map === 'undefined' || typeof L === 'undefined') return;
  const cfg=window.NSW_CONFIG||{bounds:{west:140.8,south:-37.7,east:159.4,north:-28},stateLibraryUrl:'https://archival.sl.nsw.gov.au/search/simple',historicalImageryUrl:'https://portal.spatial.nsw.gov.au/portal/apps/webappviewer/index.html?id=f7c215b873864d44bccddda8075238cb',hlrvUrl:'https://hlrv.nswlrs.com.au/',heritageUrl:'https://www.environment.nsw.gov.au/topics/heritage/resources/search-heritage-databases/state-heritage-inventory',elvisUrl:'https://elevation.fsdf.org.au/'};
  const params=new URLSearchParams(location.search);
  const VALID=new Set(['all','view','centre','point']);
  let scope=VALID.has(params.get('rscope'))?params.get('rscope'):'view';
  let radiusKm=Math.max(.5,Math.min(100,Number(params.get('rr'))||5));
  const inNsw=(lat,lng)=>Number.isFinite(lat)&&Number.isFinite(lng)&&lat>=cfg.bounds.south&&lat<=cfg.bounds.north&&lng>=cfg.bounds.west&&lng<=cfg.bounds.east;
  let researchPoint=null;
  const pLat=Number(params.get('rlat')),pLng=Number(params.get('rlng'));
  if(inNsw(pLat,pLng))researchPoint=L.latLng(pLat,pLng);
  if(!researchPoint)researchPoint=map.getCenter();
  let topic=params.get('rtopic')||'',researchArea=null,researchPin=null,timer=null;
  const controls=document.querySelector('.sidebar .controls');
  if(!controls||document.getElementById('researchScope'))return;

  const box=document.createElement('div');box.id='researchScopeBox';box.style.cssText='border:1px solid var(--line);border-radius:10px;padding:10px;margin:0 0 12px;background:var(--panel2)';box.innerHTML=`
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:5px"><b>Research this area</b><span class="badge" id="researchScopeBadge">Map view</span></div>
    <label for="researchScope">Research scope</label><select class="search" id="researchScope"><option value="view">Visible map area</option><option value="centre">Around map centre</option><option value="point">Around clicked point</option><option value="all">All known research</option></select>
    <div id="researchRadiusWrap"><label for="researchRadius">Radius: <span id="researchRadiusValue">5 km</span></label><input class="range" id="researchRadius" type="range" min="0.5" max="100" step="0.5" value="5"></div>
    <div id="researchScopeStatus" class="layerStatus">Researching the visible map area.</div>
    <label for="researchTopic">Research topic <span style="font-weight:400">(optional)</span></label><input class="search" id="researchTopic" placeholder="racecourse, wharf, picnic ground…" autocomplete="off">
    <div id="researchAreaLabel" class="meta" style="margin-top:8px"></div><div id="researchLaunch" style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:7px"></div>`;
  controls.prepend(box);
  const scopeEl=document.getElementById('researchScope'),radiusEl=document.getElementById('researchRadius'),radiusValue=document.getElementById('researchRadiusValue'),radiusWrap=document.getElementById('researchRadiusWrap'),statusEl=document.getElementById('researchScopeStatus'),badgeEl=document.getElementById('researchScopeBadge'),topicEl=document.getElementById('researchTopic'),areaLabel=document.getElementById('researchAreaLabel'),launch=document.getElementById('researchLaunch');
  scopeEl.value=scope;radiusEl.value=String(radiusKm);topicEl.value=topic;

  function km(a,b){const R=6371,dLat=(b.lat-a.lat)*Math.PI/180,dLng=(b.lng-a.lng)*Math.PI/180,la=a.lat*Math.PI/180,lb=b.lat*Math.PI/180,s=Math.sin(dLat/2)**2+Math.cos(la)*Math.cos(lb)*Math.sin(dLng/2)**2;return 2*R*Math.asin(Math.min(1,Math.sqrt(s)));}
  const ref=()=>scope==='point'?researchPoint:map.getCenter();
  function placeInScope(p){if(scope==='all')return true;const ll=L.latLng(Number(p.lat),Number(p.lon));if(scope==='view')return map.getBounds().contains(ll);return km(ref(),ll)<=radiusKm;}
  function nearest(){if(typeof places==='undefined'||!places.length)return null;const r=ref();let n=null;for(const p of places){const d=km(r,L.latLng(Number(p.lat),Number(p.lon)));if(!n||d<n.distance)n={place:p,distance:d};}return n;}
  const button=(label,href)=>`<a href="${href}" target="_blank" rel="noopener" style="display:flex;align-items:center;justify-content:center;text-align:center;min-height:38px;padding:6px 8px;border:1px solid var(--line);border-radius:8px;background:#11202d;text-decoration:none">${label}</a>`;
  function researchLinks(){const n=nearest(),near=n&&n.distance<=75?n:null,r=ref(),locality=near?.place?.suburb||near?.place?.name||'New South Wales';areaLabel.innerHTML=near?`Nearest known research locality: <b>${esc(locality)}</b> • ${near.distance.toFixed(1)} km`:`Research reference: <b>${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}</b> • NSW`;const terms=[topic.trim(),locality].filter(Boolean).join(' ');const trove=`https://trove.nla.gov.au/search/category/newspapers?keyword=${encodeURIComponent(terms)}&l-artType=newspapers&l-state=New%20South%20Wales`;launch.innerHTML=[button('Search Trove',trove),button('State Library NSW',cfg.stateLibraryUrl),button('Historical imagery',cfg.historicalImageryUrl),button('Historic land records',cfg.hlrvUrl),button('Heritage NSW',cfg.heritageUrl),button('ELVIS elevation',cfg.elvisUrl)].join('');}
  function overlay(){if(researchArea){map.removeLayer(researchArea);researchArea=null;}if(researchPin){map.removeLayer(researchPin);researchPin=null;}if(!['centre','point'].includes(scope))return;const r=ref();researchArea=L.circle(r,{radius:radiusKm*1000,weight:1,fillOpacity:.04,dashArray:'5 5',interactive:false}).addTo(map);if(scope==='point')researchPin=L.circleMarker(r,{radius:6,weight:2,fillOpacity:.65,interactive:false}).addTo(map);}
  const scopeName=()=>({all:'All research',view:'Map view',centre:'Map centre',point:'Clicked point'})[scope]||'Map view';
  function apply(){if(typeof places==='undefined'||typeof markers==='undefined'||typeof markerLayer==='undefined')return;let shown=0;for(const card of document.querySelectorAll('#list .card')){const p=places.find(x=>x.name===card.dataset.name),keep=!!p&&placeInScope(p);card.style.display=keep?'':'none';const m=p?markers.get(p.name):null;if(m){if(keep&&!markerLayer.hasLayer(m))markerLayer.addLayer(m);if(!keep&&markerLayer.hasLayer(m))markerLayer.removeLayer(m);}if(keep)shown++;}const rt=`${radiusKm%1?radiusKm.toFixed(1):radiusKm.toFixed(0)} km`;badgeEl.textContent=scopeName();radiusValue.textContent=rt;radiusWrap.style.display=['centre','point'].includes(scope)?'':'none';statusEl.textContent=scope==='all'?`${shown} matching known research locations across the catalogue.`:scope==='view'?`${shown} matching known research location${shown===1?'':'s'} in the visible map area.`:scope==='centre'?`${shown} matching location${shown===1?'':'s'} within ${rt} of the map centre.`:`${shown} matching location${shown===1?'':'s'} within ${rt} of the clicked point. Click the map to move it.`;statusEl.className=shown?'layerStatus ready':'layerStatus';const stats=document.getElementById('stats');if(stats)stats.textContent=`${shown} research location${shown===1?'':'s'} shown • scope: ${scopeName().toLowerCase()}`;overlay();researchLinks();}
  const queue=()=>{clearTimeout(timer);timer=setTimeout(apply,80);};const signal=()=>document.dispatchEvent(new Event('researchscopechange'));
  const core=window.render;if(typeof core==='function')window.render=function(...args){const x=core.apply(this,args);queue();return x;};
  scopeEl.addEventListener('change',()=>{scope=VALID.has(scopeEl.value)?scopeEl.value:'view';if(scope==='point'&&!researchPoint)researchPoint=map.getCenter();apply();signal();});
  radiusEl.addEventListener('input',()=>{radiusKm=Math.max(.5,Math.min(100,Number(radiusEl.value)||5));apply();signal();});topicEl.addEventListener('input',()=>{topic=topicEl.value;researchLinks();signal();});
  map.on('moveend zoomend',()=>{if(scope==='view'||scope==='centre')queue();else researchLinks();});map.on('click',e=>{if(scope!=='point'||!inNsw(e.latlng.lat,e.latlng.lng))return;researchPoint=e.latlng;apply();signal();});
  document.getElementById('q')?.addEventListener('input',()=>setTimeout(apply,0));document.getElementById('yr')?.addEventListener('input',()=>setTimeout(apply,0));document.getElementById('cats')?.addEventListener('click',()=>setTimeout(apply,0));
  window.cchistResearchState=()=>({scope,radiusKm,point:researchPoint?{lat:researchPoint.lat,lng:researchPoint.lng}:null,topic:topic.trim()});
  const ready=setInterval(()=>{if(typeof places!=='undefined'&&places.length){clearInterval(ready);apply();}},150);setTimeout(()=>clearInterval(ready),15000);apply();
})();
