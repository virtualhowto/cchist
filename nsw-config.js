(() => {
  'use strict';
  window.NSW_CONFIG = Object.freeze({
    bounds: Object.freeze({ west: 140.8, south: -37.7, east: 159.4, north: -28.0 }),
    mainlandBounds: Object.freeze({ west: 140.8, south: -37.7, east: 153.8, north: -28.0 }),
    defaultView: Object.freeze({ lat: -32.7, lng: 147.0, zoom: 6 }),
    elvisUrl: 'https://elevation.fsdf.org.au/',
    historicalImageryUrl: 'https://portal.spatial.nsw.gov.au/portal/apps/webappviewer/index.html?id=f7c215b873864d44bccddda8075238cb',
    stateLibraryUrl: 'https://archival.sl.nsw.gov.au/search/simple',
    heritageUrl: 'https://www.environment.nsw.gov.au/topics/heritage/resources/search-heritage-databases/state-heritage-inventory',
    hlrvUrl: 'https://hlrv.nswlrs.com.au/'
  });
})();
