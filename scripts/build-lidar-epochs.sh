#!/usr/bin/env bash
set -euo pipefail

ROOT="${LIDAR_ROOT:-/mnt/usb/stack/cchist/lidar}"
GDAL_IMAGE="ghcr.io/osgeo/gdal:ubuntu-small-3.13.3"
AOI_XMIN="${AOI_XMIN:-150.95}"
AOI_YMIN="${AOI_YMIN:--33.62}"
AOI_XMAX="${AOI_XMAX:-151.65}"
AOI_YMAX="${AOI_YMAX:--33.10}"
CPUS="$(nproc)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "$ROOT/working" "$ROOT/derived/epochs" "$ROOT/web/epochs"
python3 "$SCRIPT_DIR/select-lidar-epochs.py" "$ROOT"

DOCKER_CONFIG_TMP="$(mktemp -d "$ROOT/working/docker-anon-epochs.XXXXXX")"
printf '%s\n' '{"auths":{}}' > "$DOCKER_CONFIG_TMP/config.json"
cleanup(){ rm -rf "$DOCKER_CONFIG_TMP"; }
trap cleanup EXIT
DOCKER_CONFIG="$DOCKER_CONFIG_TMP" docker pull "$GDAL_IMAGE" >/dev/null

years="$(python3 - "$ROOT/working/selection.json" <<'PY'
import json,sys
with open(sys.argv[1]) as f:d=json.load(f)
print(' '.join(str(y) for y in d.get('years',[])))
PY
)"

for year in $years; do
  list="$ROOT/working/dem-epochs/$year.txt"
  [[ -s "$list" ]] || continue
  sig="$( { cat "$list"; printf '\nAOI=%s,%s,%s,%s\n' "$AOI_XMIN" "$AOI_YMIN" "$AOI_XMAX" "$AOI_YMAX"; } | sha256sum | awk '{print $1}')"
  out="$ROOT/web/epochs/$year/hillshade"
  marker="$ROOT/web/epochs/$year/.source-signature"
  if [[ -f "$marker" ]] && [[ "$(cat "$marker")" == "$sig" ]] && find "$out" -type f -name '*.png' -print -quit 2>/dev/null | grep -q .; then
    echo "LiDAR epoch $year already built for AOI $AOI_XMIN,$AOI_YMIN,$AOI_XMAX,$AOI_YMAX; skipping"
    continue
  fi

  echo "Building LiDAR hillshade epoch $year for AOI $AOI_XMIN,$AOI_YMIN,$AOI_XMAX,$AOI_YMAX"
  mkdir -p "$ROOT/derived/epochs/$year" "$out"
  rm -rf "$out"/*

  DOCKER_CONFIG="$DOCKER_CONFIG_TMP" docker run --rm --entrypoint /bin/bash \
    -v "$ROOT:/data" "$GDAL_IMAGE" -lc "
      set -euo pipefail
      gdalbuildvrt -overwrite -input_file_list /data/working/dem-epochs/$year.txt /data/derived/epochs/$year/dem.vrt
      gdalwarp -overwrite \
        -te_srs EPSG:4326 -te $AOI_XMIN $AOI_YMIN $AOI_XMAX $AOI_YMAX \
        -t_srs EPSG:3857 -r bilinear -multi -wo NUM_THREADS=ALL_CPUS \
        -co TILED=YES -co COMPRESS=DEFLATE -co BIGTIFF=IF_SAFER \
        /data/derived/epochs/$year/dem.vrt /data/derived/epochs/$year/dem-3857.tif
      gdaldem hillshade /data/derived/epochs/$year/dem-3857.tif /data/derived/epochs/$year/hillshade.tif \
        -multidirectional -compute_edges
      gdal2tiles.py --xyz --processes=$CPUS -z 9-17 -w none \
        /data/derived/epochs/$year/hillshade.tif /data/web/epochs/$year/hillshade
      chmod -R a+rX /data/web/epochs/$year
    "
  printf '%s' "$sig" > "$marker"
done

python3 - "$ROOT" <<'PY'
import json,os,sys,datetime
root=sys.argv[1]
status_path=os.path.join(root,'web','status.json')
selection_path=os.path.join(root,'working','selection.json')
try:
    with open(status_path) as f:status=json.load(f)
except Exception:
    status={'ready':True}
try:
    with open(selection_path) as f:selection=json.load(f)
except Exception:
    selection={}
epoch_layers={}
for year in selection.get('years',[]):
    folder=os.path.join(root,'web','epochs',str(year),'hillshade')
    available=False
    for b,_,fs in os.walk(folder):
        if any(f.lower().endswith('.png') for f in fs):
            available=True;break
    epoch_layers[str(year)]={
        'hillshade':{'available':available,'minZoom':9,'maxZoom':17},
        'demFiles':selection.get('epochs',{}).get(str(year),{}).get('demFiles',0),
        'pointCloudFiles':selection.get('epochs',{}).get(str(year),{}).get('pointCloudFiles',0),
        'surveys':selection.get('epochs',{}).get(str(year),{}).get('surveys',[]),
    }
status['selection']=selection
status['epochLayers']=epoch_layers
status['updated']=datetime.datetime.now(datetime.timezone.utc).isoformat()
os.makedirs(os.path.dirname(status_path),exist_ok=True)
with open(status_path,'w') as f:json.dump(status,f,indent=2)
print(json.dumps({'epochLayers':epoch_layers},indent=2))
PY

echo "LiDAR epoch layers ready under $ROOT/web/epochs"
