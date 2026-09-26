#!/usr/bin/env bash
set -euo pipefail

ROOT="${LIDAR_ROOT:-/mnt/usb/stack/cchist/lidar}"
MANIFEST="${1:-data/lidar-downloads.txt}"
PROCESS="${2:-true}"
# Official OSGeo release image. Use ubuntu-small: it includes GDAL Python and
# all raster features required here, while being much smaller than ubuntu-full.
GDAL_IMAGE="ghcr.io/osgeo/gdal:ubuntu-small-3.13.3"
RUNNER_UID="$(id -u)"
RUNNER_GID="$(id -g)"

# Broad Central Coast NSW AOI. Crop before reprojection/tile generation so a
# state/national source archive does not produce web tiles outside the project.
AOI_XMIN="${AOI_XMIN:-150.95}"
AOI_YMIN="${AOI_YMIN:--33.62}"
AOI_XMAX="${AOI_XMAX:-151.65}"
AOI_YMAX="${AOI_YMAX:--33.10}"

mkdir_host_tree() {
  mkdir -p "$ROOT/raw/dem" "$ROOT/raw/laz" "$ROOT/raw/extracted" \
    "$ROOT/derived" "$ROOT/working" "$ROOT/web/hillshade" "$ROOT/web/slope" "$ROOT/web/tri"
  docker run --rm -v "$ROOT:/data" alpine:3.22 sh -c \
    "chown -R ${RUNNER_UID}:${RUNNER_GID} /data && chmod -R u+rwX,go+rX /data"
}

mkdir_host_tree

echo "LiDAR root: $ROOT"
echo "Manifest: $MANIFEST"
echo "Central Coast AOI: $AOI_XMIN,$AOI_YMIN,$AOI_XMAX,$AOI_YMAX (EPSG:4326)"

if [[ ! -f "$MANIFEST" ]]; then
  echo "Manifest not found: $MANIFEST"
  exit 1
fi

download_file() {
  local url="$1" dest="$2"
  local local_size=0 remote_size=""

  if [[ -f "$dest" ]]; then
    local_size="$(stat -c '%s' "$dest" 2>/dev/null || echo 0)"
    remote_size="$(curl -fsSIL --retry 3 --retry-delay 2 "$url" 2>/dev/null | tr -d '\r' | awk 'tolower($1)=="content-length:" {v=$2} END {print v}')"

    if [[ "$remote_size" =~ ^[0-9]+$ ]] && (( local_size == remote_size )); then
      echo "Already downloaded: $(basename "$dest") ($local_size bytes)"
      return 0
    fi

    if [[ "$remote_size" =~ ^[0-9]+$ ]] && (( local_size > remote_size )); then
      echo "Local file is larger than source; restarting download: $(basename "$dest")"
      rm -f "$dest"
      local_size=0
    elif (( local_size > 0 )); then
      echo "Resuming $(basename "$dest") from $local_size bytes"
    fi
  fi

  curl --fail --location --retry 5 --retry-all-errors --retry-delay 5 \
    --continue-at - --output "$dest" "$url"
}

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
  download_file "$url" "$dest"

  if [[ -n "$sha" ]]; then
    echo "$sha  $dest" | sha256sum -c -
  fi
  count=$((count+1))
done < "$MANIFEST"

echo "Manifest downloads processed: $count"

# Extract archives without mutating originals. A marker tied to source mtime
# avoids repeatedly unpacking the multi-gigabyte GA archive on every retry.
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
        marker=os.path.join(target,'.cchist-extracted')
        try:
            if os.path.isfile(marker) and os.path.getmtime(marker) >= os.path.getmtime(src):
                print(f'Already extracted: {src}')
                continue
            if zipfile.is_zipfile(src):
                os.makedirs(target,exist_ok=True)
                print(f'Extracting {src} -> {target}')
                with zipfile.ZipFile(src) as z:z.extractall(target)
                open(marker,'w').write('ok\n')
            elif tarfile.is_tarfile(src):
                os.makedirs(target,exist_ok=True)
                print(f'Extracting {src} -> {target}')
                with tarfile.open(src) as t:t.extractall(target,filter='data')
                open(marker,'w').write('ok\n')
        except Exception as e:
            print(f'Archive extraction warning for {src}: {e}', file=sys.stderr)
PY

if [[ "$PROCESS" != "true" ]]; then
  echo "Processing disabled; raw downloads retained."
  exit 0
fi

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
echo "Generating Central Coast terrain products with $CPUS CPUs"

# Deploy jobs log in to ghcr.io with this repository's GITHUB_TOKEN and Docker
# persists those credentials on the self-hosted runner. Presenting that scoped
# token to another organisation's public GHCR package can return 'denied'. Use
# an empty, temporary DOCKER_CONFIG so the OSGeo image is pulled anonymously,
# without modifying the runner's normal Docker credentials.
GDAL_DOCKER_CONFIG="$(mktemp -d "$ROOT/working/docker-anon.XXXXXX")"
printf '%s\n' '{"auths":{}}' > "$GDAL_DOCKER_CONFIG/config.json"
cleanup_gdal_config() { rm -rf "$GDAL_DOCKER_CONFIG"; }
trap cleanup_gdal_config EXIT

DOCKER_CONFIG="$GDAL_DOCKER_CONFIG" docker pull "$GDAL_IMAGE"
DOCKER_CONFIG="$GDAL_DOCKER_CONFIG" docker run --rm --entrypoint /bin/bash -v "$ROOT:/data" "$GDAL_IMAGE" -lc "
  set -euo pipefail
  find /data/raw -type f \( -iname '*.tif' -o -iname '*.tiff' \) | sort > /data/working/dem-list.txt
  echo 'DEM inputs:'
  cat /data/working/dem-list.txt
  gdalbuildvrt -overwrite -input_file_list /data/working/dem-list.txt /data/derived/dem-source.vrt

  # Crop in geographic coordinates while reprojecting to Web Mercator. This is
  # especially important for GA's multi-gigabyte national Zone 56 mosaic.
  gdalwarp -overwrite \
    -te_srs EPSG:4326 -te $AOI_XMIN $AOI_YMIN $AOI_XMAX $AOI_YMAX \
    -t_srs EPSG:3857 -r bilinear -multi -wo NUM_THREADS=ALL_CPUS \
    -co TILED=YES -co COMPRESS=DEFLATE -co BIGTIFF=IF_SAFER \
    /data/derived/dem-source.vrt /data/derived/dem-central-coast-3857.tif

  gdaldem hillshade /data/derived/dem-central-coast-3857.tif /data/derived/hillshade.tif \
    -multidirectional -compute_edges
  gdaldem slope /data/derived/dem-central-coast-3857.tif /data/derived/slope-float.tif -compute_edges
  gdaldem TRI /data/derived/dem-central-coast-3857.tif /data/derived/tri-float.tif -compute_edges

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

mkdir_host_tree

python3 - "$ROOT" "$AOI_XMIN" "$AOI_YMIN" "$AOI_XMAX" "$AOI_YMAX" <<'PY'
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
  'aoi': {'xmin':float(sys.argv[2]),'ymin':float(sys.argv[3]),'xmax':float(sys.argv[4]),'ymax':float(sys.argv[5]),'crs':'EPSG:4326'},
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
