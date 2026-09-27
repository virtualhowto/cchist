#!/usr/bin/env bash
set -euo pipefail

ROOT="${LIDAR_ROOT:-/mnt/usb/stack/cchist/lidar}"
GDAL_IMAGE="${GDAL_IMAGE:-ghcr.io/osgeo/gdal:ubuntu-small-3.13.3}"
RESOLUTION_M="${CHANGE_RESOLUTION_M:-2}"
THRESHOLD_M="${CHANGE_THRESHOLD_M:-0.75}"
MAJOR_M="${CHANGE_MAJOR_M:-2.0}"
CPUS="$(nproc)"
PAIRS=("2011:2014" "2014:2020" "2011:2020")

mkdir -p "$ROOT/working/change" "$ROOT/derived/change" "$ROOT/web/change"

DOCKER_CONFIG_TMP="$(mktemp -d "$ROOT/working/docker-anon-change.XXXXXX")"
printf '%s\n' '{"auths":{}}' > "$DOCKER_CONFIG_TMP/config.json"
cleanup(){ rm -rf "$DOCKER_CONFIG_TMP"; }
trap cleanup EXIT
DOCKER_CONFIG="$DOCKER_CONFIG_TMP" docker pull "$GDAL_IMAGE" >/dev/null

ensure_vrt(){
  local year="$1"
  local vrt="$ROOT/derived/epochs/$year/dem.vrt"
  local list="$ROOT/working/dem-epochs/$year.txt"
  [[ -s "$list" ]] || return 1
  if [[ ! -s "$vrt" ]]; then
    mkdir -p "$ROOT/derived/epochs/$year"
    DOCKER_CONFIG="$DOCKER_CONFIG_TMP" docker run --rm \
      -v "$ROOT:/data" "$GDAL_IMAGE" \
      gdalbuildvrt -overwrite -input_file_list "/data/working/dem-epochs/$year.txt" "/data/derived/epochs/$year/dem.vrt"
  fi
}

extent_json(){
  local year="$1"
  local out="$ROOT/working/change/$year-gdalinfo.json"
  DOCKER_CONFIG="$DOCKER_CONFIG_TMP" docker run --rm \
    -v "$ROOT:/data:ro" "$GDAL_IMAGE" \
    gdalinfo -json "/data/derived/epochs/$year/dem.vrt" > "$out"
  printf '%s' "$out"
}

intersection_bbox(){
  python3 - "$1" "$2" <<'PY'
import json,sys

def bounds(path):
    with open(path) as f:d=json.load(f)
    poly=((d.get('wgs84Extent') or {}).get('coordinates') or [[]])[0]
    pts=[p for p in poly if isinstance(p,list) and len(p)>=2]
    if not pts: raise SystemExit(2)
    xs=[float(p[0]) for p in pts]; ys=[float(p[1]) for p in pts]
    return min(xs),min(ys),max(xs),max(ys)
a=bounds(sys.argv[1]); b=bounds(sys.argv[2])
xmin=max(a[0],b[0]); ymin=max(a[1],b[1]); xmax=min(a[2],b[2]); ymax=min(a[3],b[3])
if xmin>=xmax or ymin>=ymax: raise SystemExit(3)
print(f'{xmin:.10f} {ymin:.10f} {xmax:.10f} {ymax:.10f}')
PY
}

built_pairs=()
for spec in "${PAIRS[@]}"; do
  from="${spec%%:*}"
  to="${spec##*:}"
  pair="$from-$to"

  if ! ensure_vrt "$from" || ! ensure_vrt "$to"; then
    echo "Skipping $pair: one or both epoch DEM lists are unavailable"
    continue
  fi

  from_info="$(extent_json "$from")"
  to_info="$(extent_json "$to")"
  if ! bbox="$(intersection_bbox "$from_info" "$to_info")"; then
    echo "Skipping $pair: surveys have no overlapping WGS84 extent"
    continue
  fi
  read -r xmin ymin xmax ymax <<<"$bbox"

  from_list="$ROOT/working/dem-epochs/$from.txt"
  to_list="$ROOT/working/dem-epochs/$to.txt"
  signature="$( { sha256sum "$from_list" "$to_list"; printf '%s\n' "resolution=$RESOLUTION_M threshold=$THRESHOLD_M major=$MAJOR_M version=1"; } | sha256sum | awk '{print $1}' )"
  web_dir="$ROOT/web/change/$pair"
  marker="$web_dir/.source-signature"

  if [[ -f "$marker" ]] && [[ "$(cat "$marker")" == "$signature" ]] && find "$web_dir" -type f -name '*.png' -print -quit 2>/dev/null | grep -q .; then
    echo "Terrain change $pair already built; skipping"
    built_pairs+=("$pair")
    continue
  fi

  echo "Building terrain change $pair over overlap: $bbox"
  work="/data/derived/change/$pair"
  mkdir -p "$ROOT/derived/change/$pair" "$web_dir"
  rm -rf "$web_dir"/*

  DOCKER_CONFIG="$DOCKER_CONFIG_TMP" docker run --rm --entrypoint /bin/bash \
    -v "$ROOT:/data" "$GDAL_IMAGE" -lc "
      set -euo pipefail
      mkdir -p '$work' /data/web/change/$pair

      gdalwarp -overwrite \
        -te_srs EPSG:4326 -te $xmin $ymin $xmax $ymax \
        -t_srs EPSG:3857 -tr $RESOLUTION_M $RESOLUTION_M -tap \
        -r bilinear -multi -wo NUM_THREADS=ALL_CPUS -dstnodata -9999 \
        -co TILED=YES -co COMPRESS=DEFLATE -co BIGTIFF=IF_SAFER \
        /data/derived/epochs/$from/dem.vrt '$work/from.tif'

      gdalwarp -overwrite \
        -te_srs EPSG:4326 -te $xmin $ymin $xmax $ymax \
        -t_srs EPSG:3857 -tr $RESOLUTION_M $RESOLUTION_M -tap \
        -r bilinear -multi -wo NUM_THREADS=ALL_CPUS -dstnodata -9999 \
        -co TILED=YES -co COMPRESS=DEFLATE -co BIGTIFF=IF_SAFER \
        /data/derived/epochs/$to/dem.vrt '$work/to.tif'

      gdal_calc.py -A '$work/from.tif' -B '$work/to.tif' \
        --outfile='$work/classes.tif' --type=Byte --NoDataValue=0 \
        --co=TILED=YES --co=COMPRESS=DEFLATE --co=BIGTIFF=IF_SAFER \
        --calc='1*((B-A)<=-$MAJOR_M)+2*(((B-A)>-$MAJOR_M)&((B-A)<=-$THRESHOLD_M))+3*(((B-A)>=$THRESHOLD_M)&((B-A)<$MAJOR_M))+4*((B-A)>=$MAJOR_M)'

      cat > '$work/change-colors.txt' <<'COLORS'
0 0 0 0 0
1 10 70 220 235
2 80 175 255 205
3 255 180 55 205
4 220 35 35 235
nv 0 0 0 0
COLORS

      gdaldem color-relief '$work/classes.tif' '$work/change-colors.txt' '$work/change-rgba.tif' -alpha -nearest_color_entry
      gdal2tiles.py --xyz --processes=$CPUS -z 9-17 -w none \
        '$work/change-rgba.tif' /data/web/change/$pair
      chmod -R a+rX /data/web/change/$pair
    "

  printf '%s' "$signature" > "$marker"
  built_pairs+=("$pair")
done

pairs_csv="$(IFS=,; echo "${built_pairs[*]-}")"
python3 - "$ROOT/working/change/change.json" "$pairs_csv" "$RESOLUTION_M" "$THRESHOLD_M" "$MAJOR_M" <<'PY'
import json,sys,datetime
out,pairs,res,threshold,major=sys.argv[1:]
items={}
for pair in filter(None,pairs.split(',')):
    a,b=pair.split('-',1)
    items[pair]={
      'fromYear':int(a),'toYear':int(b),'available':True,
      'tileUrl':f'/lidar/change/{pair}/{{z}}/{{x}}/{{y}}.png',
      'minZoom':9,'maxZoom':17,
      'resolutionMetres':float(res),'thresholdMetres':float(threshold),'majorChangeMetres':float(major)
    }
payload={
  'ready':bool(items),
  'updated':datetime.datetime.now(datetime.timezone.utc).isoformat(),
  'method':'DEM elevation difference, later survey minus earlier survey',
  'note':'Research aid only. Differences can include survey alignment, vegetation/classification and interpolation effects; inspect source imagery before interpreting a feature as ground disturbance.',
  'pairs':items,
  'legend':[
    {'class':1,'label':f'Lower by ≥ {major} m','rgba':[10,70,220,235]},
    {'class':2,'label':f'Lower by {threshold}–{major} m','rgba':[80,175,255,205]},
    {'class':3,'label':f'Higher by {threshold}–{major} m','rgba':[255,180,55,205]},
    {'class':4,'label':f'Higher by ≥ {major} m','rgba':[220,35,35,235]}
  ]
}
with open(out,'w') as f:json.dump(payload,f,indent=2)
print(json.dumps(payload,indent=2))
PY

DOCKER_CONFIG="$DOCKER_CONFIG_TMP" docker run --rm -v "$ROOT:/data" nginx:1.27-alpine sh -lc '
  cp /data/working/change/change.json /data/web/change.json
  chmod 644 /data/web/change.json
  chmod -R a+rX /data/web/change
'

echo "Terrain change catalogue ready: $ROOT/web/change.json"
