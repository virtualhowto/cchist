(() => {
  'use strict';

  const desktop = window.matchMedia('(min-width: 761px)');
  const app = document.querySelector('.app');
  const sidebar = document.getElementById('sidebar');
  const topbar = document.querySelector('.topbar');
  if (!app || !sidebar || !topbar) return;

  const style = document.createElement('style');
  style.id = 'layoutStyles';
  style.textContent = `
    .researchToggle{margin-left:0;border:1px solid var(--line);background:var(--panel2);color:var(--text);border-radius:10px;padding:9px 11px;min-width:44px;min-height:44px;cursor:pointer}
    @media(min-width:761px){
      .app{transition:grid-template-columns .18s ease}
      body.researchCollapsed .app{grid-template-columns:0 1fr}
      body.researchCollapsed .sidebar{padding-left:0;padding-right:0;border-right:0;overflow:hidden}
      body.researchCollapsed .sidebar>*{visibility:hidden}
    }
    @media(max-width:760px){.researchToggle{display:none}}
  `;
  document.head.appendChild(style);

  const button = document.createElement('button');
  button.type = 'button';
  button.id = 'researchToggle';
  button.className = 'researchToggle';
  button.setAttribute('aria-controls', 'sidebar');
  const layersButton = document.getElementById('layersBtn');
  topbar.insertBefore(button, layersButton || null);

  const stored = localStorage.getItem('cchist.researchCollapsed') === '1';

  function setCollapsed(collapsed, persist = true) {
    if (!desktop.matches) collapsed = false;
    document.body.classList.toggle('researchCollapsed', collapsed);
    button.textContent = collapsed ? 'Show research' : 'Hide research';
    button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    if (persist) localStorage.setItem('cchist.researchCollapsed', collapsed ? '1' : '0');
    requestAnimationFrame(() => {
      map.invalidateSize({ animate: false });
      setTimeout(() => map.invalidateSize({ animate: false }), 220);
    });
  }

  button.addEventListener('click', () => setCollapsed(!document.body.classList.contains('researchCollapsed')));
  desktop.addEventListener?.('change', () => setCollapsed(desktop.matches && localStorage.getItem('cchist.researchCollapsed') === '1', false));
  setCollapsed(stored, false);
})();
