(() => {
  'use strict';

  const style = document.createElement('style');
  style.id = 'compareClipFixStyles';
  style.textContent = `
    .leaflet-compareLeft-pane .leaflet-layer,
    .leaflet-compareRight-pane .leaflet-layer{clip:auto!important}
  `;
  document.head.appendChild(style);

  function applyStableClip() {
    const enabled = document.getElementById('compareEnabled');
    const splitControl = document.getElementById('compareSplit');
    const leftPane = map.getPane('compareLeft');
    const rightPane = map.getPane('compareRight');
    if (!leftPane || !rightPane) return;

    if (!enabled?.checked) {
      leftPane.querySelectorAll('.leaflet-layer').forEach(el => { el.style.clipPath = ''; });
      rightPane.querySelectorAll('.leaflet-layer').forEach(el => { el.style.clipPath = ''; });
      return;
    }

    const pct = Math.max(5, Math.min(95, Number(splitControl?.value || 50))) / 100;
    const mapRect = map.getContainer().getBoundingClientRect();
    const splitX = mapRect.left + mapRect.width * pct;

    leftPane.querySelectorAll('.leaflet-layer').forEach(el => {
      const r = el.getBoundingClientRect();
      const visible = Math.max(0, Math.min(r.width, splitX - r.left));
      const rightInset = Math.max(0, r.width - visible);
      el.style.clipPath = `inset(0 ${rightInset}px 0 0)`;
    });

    rightPane.querySelectorAll('.leaflet-layer').forEach(el => {
      const r = el.getBoundingClientRect();
      const leftInset = Math.max(0, Math.min(r.width, splitX - r.left));
      el.style.clipPath = `inset(0 0 0 ${leftInset}px)`;
    });
  }

  const refresh = () => requestAnimationFrame(() => requestAnimationFrame(applyStableClip));
  document.getElementById('compareEnabled')?.addEventListener('change', refresh);
  document.getElementById('compareLeft')?.addEventListener('change', refresh);
  document.getElementById('compareRight')?.addEventListener('change', refresh);
  document.getElementById('compareSplit')?.addEventListener('input', refresh);
  map.on('move zoom zoomend resize layeradd', refresh);
  setInterval(() => {
    if (document.getElementById('compareEnabled')?.checked) applyStableClip();
  }, 500);
  refresh();
})();
