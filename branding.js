(() => {
  'use strict';

  document.title = 'History Research Map';
  const heading = document.querySelector('.brand h1');
  if (heading) heading.textContent = 'History Research Map';

  function cleanResearchLabels() {
    const area = document.getElementById('researchAreaLabel');
    if (area && area.textContent.includes('Central Coast')) {
      area.innerHTML = area.innerHTML.replace(/Using the current Central Coast map area\./g, 'Using the current map area.');
    }

    document.querySelectorAll('#researchLaunch a').forEach(a => {
      if (a.textContent.trim() === 'Aerial Central Coast') a.textContent = 'Local aerial archive';
    });
  }

  cleanResearchLabels();
  const sidebar = document.getElementById('sidebar');
  if (sidebar) {
    new MutationObserver(cleanResearchLabels).observe(sidebar, { childList: true, subtree: true, characterData: true });
  }
})();
