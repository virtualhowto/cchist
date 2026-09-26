#!/usr/bin/env bash
set -euo pipefail

ROOT="${LIDAR_ROOT:-/srv/cchist/lidar}"
MANIFEST="${1:-data/lidar-downloads.txt}"
PROCESS="${2:-true}"
GDAL_IMAGE="ghcr.io/osgeo/gdal:ubuntu-full-3.10.0"
RUNNER_UID="$(id -u)"
RUNNER_GID="$(id -g)"

mkdir_host_tree() {
  docker run --rm -v /srv/cchist:/data alpine:3.22 sh -c \
    "mkdir -p /data/lidar/raw/dem /data/lidar/raw/laz /data/lidar/raw/extracted /data/lidar/derived /data/lidar/working /data/lidar/web/hillshade /data/lidar/web/slope /data/lidar/web/tri && chown -R ${RUNNER_UID}:${RUNNER_GID} /data/lidar && chmod -R u+rwX,go+rX /data/lidar"
}

mkdir_host_tree

echo "LiDAR root: $ROOT"
echo "Manifest: $MANIFEST"

if [[ ! -f "$MANIFEST" ]]; then
  echo "Manifest not found: $MANIFEST"
  exit 1
fi

count=0
while IFS='|' read -r type url sha || [[ -n "${type:-}" ]]; do
  type="${type%%#*}"
  type="$(echo "${type:-}" | xargs)"
  url="$(echo "${url:-}" | xargs)"
  sha="$(echo "${sha:-}" | xargs)"
  [[ -z "$type" || -z "$url" ]] && continue
  case "$type" in dem|laz) ;; *) echo "Skipping unknown type '$type'"; continue ;; esac

  name="$(basename "${url%%\?*}")"
  if [[ -z "$name" || "$name" == "/" || "$name" == "." ]]; then
    name="$(printf '%s' "$url" | sha256sum | awk '{print $1}').bin"
  fi
  dest="$ROOT/raw/$type/$name"
  echo "Downloading [$type] $name"
  curl --fail --location --retry 5 --retry-delay 5 --continue-at - --output "$dest" "$url"

  if [[ -n "$sha" ]]; then
    echo "$sha  $dest" | sha256sum -c -
  fi
  count=$((count+1))
done < "$MANIFEST"

echo "Manifest downloads processed: $count"

# Extract zip/tar packages without mutating the original downloads.
python3 - "$ROOT" <<'PY'
import os, sys, zipfile, tarfile
root=sys.argv[1]
out=os.path.join(root,'raw','extracted')
os.makedirs(out, exist_ok=True)
for base, _, files in os.walk(os.path.join(root,'raw')):
    if base.startswith(out):
        continue
    for fn in files:
        src=os.path.join(base,fn)
        stem=os.path.splitext(fn)[0]
        target=os.path.join(out,stem)
        try:
            if zipfile.is_zipfile(src):
                os.makedirs(target,exist_ok=True)
                with zipfile.ZipFile(src) as z:z.extractall(target)
            elif tarfile.is_tarfile(src):
                os.makedirs(target,exist_ok=True)
                with tarfile.open(src) as t:t.extractall(target,filter='data')
        except Exception as e:
            print(f'Archive extraction warning for {src}: {e}', file=sys.stderr)
PY

if [[ "$PROCESS" != "true" ]]; then
  echo "Processing disabled; raw downloads retained."
  exit 0
fi

# There must be at least one DEM GeoTIFF to generate web analysis layers.
if ! find "$ROOT/raw" -type f \( -iname '*.tif' -o -iname '*.tiff' \) -print -quit | grep -q .; then
  echo "No DEM GeoTIFFs found yet. Download completed; tile generation skipped."
  python3 - "$ROOT/web/status.json" <<'PY'
import json,sys,datetime,os
p=sys.argv[1]; os.makedirs(os.path.dirname(p),exist_ok=True)
json.dump({'ready':False,'reason':'No DEM GeoTIFFs available','updated':datetime.datetime.now(datetime.timezone.utc).isoformat()},open(p,'w'),indent=2)
PY
  exit 0
fi

CPUS="$(nproc)"
echo "Generating derived terrain products with $CPUS CPUs"

docker pull "$GDAL_IMAGE"
docker run --rm --entrypoint /bin/bash -v "$ROOT:/data" "$GDAL_IMAGE" -lc "
  set -euo pipefail
  find /data/raw -type f \( -iname '*.tif' -o -iname '*.tiff' \) | sort > /data/working/dem-list.txt
  gdalbuildvrt -overwrite -input_file_list /data/working/dem-list.txt /data/derived/dem.vrt
  gdalwarp -overwrite -t_srs EPSG:3857 -r bilinear -multi -wo NUM_THREADS=ALL_CPUS \
    -co TILED=YES -co COMPRESS=DEFLATE -co BIGTIFF=YES \
    /data/derived/dem.vrt /data/derived/dem-3857.tif

  gdaldem hillshade /data/derived/dem-3857.tif /data/derived/hillshade.tif \
    -multidirectional -compute_edges
  gdaldem slope /data/derived/dem-3857.tif /data/derived/slope-float.tif -compute_edges
  gdaldem TRI /data/derived/dem-3857.tif /data/derived/tri-float.tif -compute_edges

  gdal_translate -ot Byte -scale 0 90 0 255 -co TILED=YES -co COMPRESS=DEFLATE \
    /data/derived/slope-float.tif /data/derived/slope.tif
  gdal_translate -ot Byte -scale -co TILED=YES -co COMPRESS=DEFLATE \
    /data/derived/tri-float.tif /data/derived/tri.tif

  rm -rf /data/web/hillshade/* /data/web/slope/* /data/web/tri/*
  gdal2tiles.py --xyz --processes=$CPUS -z 9-17 -w none /data/derived/hillshade.tif /data/web/hillshade
  gdal2tiles.py --xyz --processes=$CPUS -z 9-17 -w none /data/derived/slope.tif /data/web/slope
  gdal2tiles.py --xyz --processes=$CPUS -z 9-17 -w none /data/derived/tri.tif /data/web/tri
  chmod -R a+rX /data/web
"

# Restore runner ownership so later incremental syncs can overwrite generated files.
mkdir_host_tree

python3 - "$ROOT" <<'PY'
import os,sys,json,datetime
root=sys.argv[1]
def count(ext,where):
    n=0
    for b,_,fs in os.walk(where):
        n += sum(1 for f in fs if f.lower().endswith(ext))
    return n
status={
  'ready': True,
  'updated': datetime.datetime.now(datetime.timezone.utc).isoformat(),
  'raw': {
    'lazFiles': count('.laz',os.path.join(root,'raw')),
    'demFiles': count('.tif',os.path.join(root,'raw'))+count('.tiff',os.path.join(root,'raw'))
  },
  'layers': {
    'hillshade': {'available': True, 'minZoom': 9, 'maxZoom': 17},
    'slope': {'available': True, 'minZoom': 9, 'maxZoom': 17},
    'tri': {'available': True, 'minZoom': 9, 'maxZoom': 17}
  }
}
with open(os.path.join(root,'web','status.json'),'w') as f: json.dump(status,f,indent=2)
PY

echo "LiDAR web layers ready under $ROOT/web"
