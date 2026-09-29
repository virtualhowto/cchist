# History Research Map

Research-first interactive map for historical places, aerial imagery, LiDAR/elevation surveys, landscape change and source discovery across **New South Wales**.

Production hostname: **https://cchist.virtualhowto.com**

## What the map does

- Research scope follows the visible map, map centre, or a clicked point anywhere in NSW.
- NSW Spatial Services historical aerial imagery is filtered to years with coverage around the current view.
- NSW Spatial Services Elevation Data Index supplies statewide LiDAR/elevation survey footprints and capture metadata.
- ELVIS remains the acquisition source for high-resolution DEM and classified point-cloud data.
- Local generated hillshade, slope, ruggedness, dated LiDAR and terrain-change tiles are only offered where that AOI has actually been processed on the server.
- Swipe comparison supports current aerial, available historical aerial and locally cached LiDAR epochs.
- Share links preserve position, map/layer selections, research scope and comparison state.

## Data architecture

The app deliberately separates **statewide availability** from **locally cached high-resolution terrain**.

### Statewide catalogues

Generated under the persistent `/lidar/` web mount:

- `imagery.json` — historical imagery services and coarse statewide cached-tile availability grid.
- `elevation-index.json` — NSW Spatial Services elevation/LiDAR survey polygons and metadata.

Refresh them with the **Refresh NSW Research Catalogues** GitHub Actions workflow.

### Local high-resolution cache

The **Sync Local High-Resolution LiDAR Cache** workflow accepts an NSW bounding box and builds:

- latest hillshade
- slope
- terrain ruggedness
- dated epoch hillshades

The newer multi-area cache is published below `/lidar/areas/<survey>/`, with `/lidar/areas.json` describing which processed survey caches are available. The browser automatically selects a matching cache when the map moves into its coverage.

### Terrain change

**Build Local Terrain Change** automatically uses the dated DEM epochs currently built for the local AOI. It creates adjacent-year comparisons plus oldest-to-newest when more than two epochs exist.

## ELVIS acquisition

Use **Request ELVIS Data by NSW AOI** for an arbitrary NSW bounding box. The workflow defaults to 1 m DEM products. Classified point-cloud/LAZ ordering is explicitly opt-in because a broad or statewide order can be extremely large.

The project does **not** automatically request or download the entire raw NSW point-cloud archive. Instead, the statewide survey catalogue shows what exists and high-resolution source data can be acquired for the research AOI being investigated.

### Automatic ELVIS survey ingestion

New ELVIS export ZIPs can be dropped into either:

```text
/mnt/usb/stack/cchist/lidar/raw/dem/
```

or directly into:

```text
/mnt/usb/stack/cchist/lidar/raw/elvis/
```

The **Auto Import New ELVIS Surveys** workflow runs on the self-hosted NUC every 30 minutes. It:

1. waits until ZIP files are complete and readable;
2. classifies and extracts new ELVIS packages;
3. rebuilds `/lidar/catalogue/elvis-index.json`;
4. detects survey names that do not yet have a clean single-survey cache;
5. builds each survey using only DEM tiles belonging to that exact survey;
6. publishes hillshade, slope and TRI tiles below `/lidar/areas/<survey>/`;
7. updates `/lidar/areas.json`, which makes the new cache discoverable by the web map.

The scheduled workflow builds at most two new survey caches per run to avoid saturating the NUC. Remaining surveys stay pending and are picked up by later runs. A manual workflow run can set the limit to `0` to process all pending surveys.

The versioned manager is `scripts/elvis-manager.sh`. Useful manual commands are:

```bash
./scripts/elvis-manager.sh scan
./scripts/elvis-manager.sh list
./scripts/elvis-manager.sh pending
./scripts/elvis-manager.sh build-survey Bathurst201510
ELVIS_AUTO_MAX_SURVEYS=2 ./scripts/elvis-manager.sh auto
```

## Research sources

Map-driven research links include Trove, State Library NSW, NSW Historical Imagery, Historic Land Records Viewer, Heritage NSW and ELVIS. Existing curated place/map records remain in:

- `data/places.json`
- `data/historic-maps.json`

These records can grow beyond the original seed area without changing the application architecture.

## Docker

```bash
git clone https://github.com/virtualhowto/cchist.git
cd cchist
docker compose up -d --build
```

Production uses Docker Swarm, Traefik and the persistent data path `/mnt/usb/stack/cchist/lidar/web`.

## Research caution

Place markers, terrain change, historical imagery coverage and survey footprints are research aids. Approximate locations and apparent terrain changes should be checked against primary sources, survey metadata, historical imagery and land records before drawing conclusions.
