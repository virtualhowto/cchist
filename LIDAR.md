# Central Coast LiDAR pipeline

`cchist` keeps raw elevation data outside Git and serves only derived web tiles.

## Storage

The self-hosted runner uses:

```text
/srv/cchist/lidar/
├── raw/
│   ├── dem/
│   ├── laz/
│   └── extracted/
├── derived/
├── working/
└── web/
    ├── hillshade/
    ├── slope/
    ├── tri/
    └── status.json
```

The Swarm service bind-mounts `/srv/cchist/lidar/web` read-only at `/usr/share/nginx/html/lidar`. Because this is node-local data, the service is currently constrained to `NUC8i7HNK`. If the data moves to shared/NFS storage, remove that placement constraint and replace the bind mount with the shared volume.

## Source data

Use Geoscience Australia ELVIS for NSW Spatial Services point clouds and bare-earth DEMs:

https://elevation.fsdf.org.au/

NSW Spatial Services describes current standard elevation deliverables as classified LAZ point clouds and 1 m bare-earth Cloud Optimised GeoTIFF DEMs. Older Central Coast acquisitions can also be 1 m or 2 m DEM products.

The runner is manifest-driven because ELVIS is an on-demand download platform rather than a documented stable bulk-download API.

Add direct ELVIS download URLs to `data/lidar-downloads.txt`:

```text
dem|https://download-url/example-dem.zip|
laz|https://download-url/example-pointcloud.zip|
```

Optional SHA-256 checksums may be supplied in the third field:

```text
dem|https://download-url/example-dem.zip|0123456789abcdef...
```

A push that changes the manifest triggers `.github/workflows/lidar-sync.yml`. The workflow can also be run manually and can accept a remote manifest URL.

## Generated map layers

The processing job uses a pinned GDAL container and produces:

- multidirectional hillshade
- slope
- terrain ruggedness index (TRI)
- XYZ PNG tiles at zoom levels 9–17

The web map checks `/lidar/status.json` and enables these layers only after processing is complete.

Raw LAZ and DEM files are retained for future analysis such as local-relief models, contours, point-cloud inspection and site-specific archaeology/history investigations.
