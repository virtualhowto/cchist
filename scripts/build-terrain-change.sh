#!/usr/bin/env bash
set -euo pipefail

ROOT="${LIDAR_ROOT:-/mnt/usb/stack/cchist/lidar}"
GDAL_IMAGE="${GDAL_IMAGE:-ghcr.io/osgeo/gdal:ubuntu-small-3.13.3}"
RESOLUTION_M="${CHANGE_RESOLUTION_M:-2}"
THRESHOLD_M="${CHANGE_THRESHOLD_M:-0.75}"
MAJOR_M="${CHANGE_MAJOR_M:-2.0}"
CPUS="$(nproc)"

mkdir -p "$ROOT/working/change" "$ROOT/derived/change" "$ROOT/web/change"

mapfile -t YEARS < <(find "$ROOT/derived/epochs" -mindepth 2 -maxdepth 2 -type f -name dem-3857.tif -printf '%h\n' 2>/dev/null | awk -F/ '{print $NF}' | grep -E '^[0-9]{4}$' | sort -nu)
if (( ${#YEARS[@]} < 2 )); then
  echo "Need at least two locally built LiDAR epoch DEMs; found: ${YEARS[*]-none}"
  python3 - "$ROOT/web/change.json" <<'PY'
import json,sys,datetime,os
p=sys.argv[1];os.makedirs(os.path.dirname(p),exist_ok=True)
json.dump({'ready':False,'updated':datetime.datetime.now(datetime.timezone.utc).isoformat(),'reason':'Fewer than two locally built LiDAR epochs','pairs':{}},open(p,'w'),indent=2)
PY
  exit 0
fi

PAIRS=()
for ((i=0;i<${#YEARS[@]}-1;i++)); do PAIRS+=("${YEARS[$i]}:${YEARS[$((i+1))]}"); done
if (( ${#YEARS[@]} > 2 )); then PAIRS+=("${YEARS[0]}:${YEARS[$((${#YEARS[@]}-1))]}"); fi
mapfile -t PAIRS < <(printf '%s\n' "${PAIRS[@]}" | awk '!seen[$0]++')
echo "Terrain-change pairs for local cache: ${PAIRS[*]}"

DOCKER_CONFIG_TMP="$(mktemp -d "$ROOT/working/docker-anon-change.XXXXXX")"
printf '%s\n' '{"auths":{}}' > "$DOCKER_CONFIG_TMP/config.json"
cleanup(){ rm -rf "$DOCKER_CONFIG_TMP"; }
trap cleanup EXIT
DOCKER_CONFIG="$DOCKER_CONFIG_TMP" docker pull "$GDAL_IMAGE" >/dev/null

extent_json(){
  local year="$1" out="$ROOT/working/change/$year-gdalinfo.json"
  DOCKER_CONFIG="$DOCKER_CONFIG_TMP" docker run --rm -v "$ROOT:/data:ro" "$GDAL_IMAGE" \
    gdalinfo -json "/data/derived/epochs/$year/dem-3857.tif" > "$out"
  printf '%s' "$out"
}

intersection_bbox(){
  python3 - "$1" "$2" <<'PY'
import json,sys
def bounds(path):
    d=json.load(open(path)); poly=((d.get('wgs84Extent') or {}).get('coordinates') or [[]])[0]
    pts=[p for p in poly if isinstance(p,list) and len(p)>=2]
    if not pts: raise SystemExit(2)
    xs=[float(p[0]) for p in pts];ys=[float(p[1]) for p in pts]
    return min(xs),min(ys),max(xs),max(ys)
a,b=bounds(sys.argv[1]),bounds(sys.argv[2])
xmin,ymin,xmax,ymax=max(a[0],b[0]),max(a[1],b[1]),min(a[2],b[2]),min(a[3],b[3])
if xmin>=xmax or ymin>=ymax: raise SystemExit(3)
print(f'{xmin:.10f} {ymin:.10f} {xmax:.10f} {ymax:.10f}')
PY
}

built_pairs=()
for spec in "${PAIRS[@]}"; do
  from="${spec%%:*}"; to="${spec##*:}"; pair="$from-$to"
  from_tif="$ROOT/derived/epochs/$from/dem-3857.tif"; to_tif="$ROOT/derived/epochs/$to/dem-3857.tif"
  [[ -s "$from_tif" && -s "$to_tif" ]] || { echo "Skipping $pair: local epoch DEM missing"; continue; }

  from_info="$(extent_json "$from")"; to_info="$(extent_json "$to")"
  if ! bbox="$(intersection_bbox "$from_info" "$to_info")"; then echo "Skipping $pair: local epoch DEMs do not overlap"; continue; fi
  read -r xmin ymin xmax ymax <<<"$bbox"

  from_sig="$(cat "$ROOT/web/epochs/$from/.source-signature" 2>/dev/null || stat -c '%s:%Y' "$from_tif")"
  to_sig="$(cat "$ROOT/web/epochs/$to/.source-signature" 2>/dev/null || stat -c '%s:%Y' "$to_tif")"
  signature="$(printf '%s\n%s\nresolution=%s threshold=%s major=%s version=2' "$from_sig" "$to_sig" "$RESOLUTION_M" "$THRESHOLD_M" "$MAJOR_M" | sha256sum | awk '{print $1}')"
  web_dir="$ROOT/web/change/$pair"; marker="$web_dir/.source-signature"
  if [[ -f "$marker" && "$(cat "$marker")" == "$signature" ]] && find "$web_dir" -type f -name '*.png' -print -quit 2>/dev/null | grep -q .; then
    echo "Terrain change $pair already built for current local AOI; skipping"; built_pairs+=("$pair"); continue
  fi

  echo "Building terrain change $pair over local overlap: $bbox"
  work="/data/derived/change/$pair"; mkdir -p "$ROOT/derived/change/$pair" "$web_dir"; rm -rf "$web_dir"/*
  DOCKER_CONFIG="$DOCKER_CONFIG_TMP" docker run --rm --entrypoint /bin/bash -v "$ROOT:/data" "$GDAL_IMAGE" -lc "
    set -euo pipefail
    mkdir -p '$work' /data/web/change/$pair
    gdalwarp -overwrite -te_srs EPSG:4326 -te $xmin $ymin $xmax $ymax -t_srs EPSG:3857 -tr $RESOLUTION_M $RESOLUTION_M -tap \
      -r bilinear -multi -wo NUM_THREADS=ALL_CPUS -dstnodata -9999 -co TILED=YES -co COMPRESS=DEFLATE -co BIGTIFF=IF_SAFER \
      /data/derived/epochs/$from/dem-3857.tif '$work/from.tif'
    gdalwarp -overwrite -te_srs EPSG:4326 -te $xmin $ymin $xmax $ymax -t_srs EPSG:3857 -tr $RESOLUTION_M $RESOLUTION_M -tap \
      -r bilinear -multi -wo NUM_THREADS=ALL_CPUS -dstnodata -9999 -co TILED=YES -co COMPRESS=DEFLATE -co BIGTIFF=IF_SAFER \
      /data/derived/epochs/$to/dem-3857.tif '$work/to.tif'
    gdal_calc.py -A '$work/from.tif' -B '$work/to.tif' --outfile='$work/classes.tif' --type=Byte --NoDataValue=0 \
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
    gdal2tiles.py --xyz --processes=$CPUS -z 9-17 -w none '$work/change-rgba.tif' /data/web/change/$pair
    chmod -R a+rX /data/web/change/$pair
  "
  printf '%s' "$signature" > "$marker"; built_pairs+=("$pair")
done

pairs_csv="$(IFS=,; echo "${built_pairs[*]-}")"
python3 - "$ROOT/working/change/change.json" "$ROOT/web/status.json" "$pairs_csv" "$RESOLUTION_M" "$THRESHOLD_M" "$MAJOR_M" <<'PY'
import json,sys,datetime,os
out,status_path,pairs,res,threshold,major=sys.argv[1:]
items={}
for pair in filter(None,pairs.split(',')):
    a,b=pair.split('-',1);items[pair]={'fromYear':int(a),'toYear':int(b),'available':True,'tileUrl':f'/lidar/change/{pair}/{{z}}/{{x}}/{{y}}.png','minZoom':9,'maxZoom':17,'resolutionMetres':float(res),'thresholdMetres':float(threshold),'majorChangeMetres':float(major)}
try: status=json.load(open(status_path))
except Exception: status={}
payload={'ready':bool(items),'updated':datetime.datetime.now(datetime.timezone.utc).isoformat(),'aoi':status.get('aoi'),'method':'DEM elevation difference, later local survey minus earlier local survey','note':'Research aid only. Differences can include survey alignment, vegetation/classification and interpolation effects; inspect source imagery before interpreting a feature as ground disturbance.','pairs':items,'legend':[{'class':1,'label':f'Lower by ≥ {major} m','rgba':[10,70,220,235]},{'class':2,'label':f'Lower by {threshold}–{major} m','rgba':[80,175,255,205]},{'class':3,'label':f'Higher by {threshold}–{major} m','rgba':[255,180,55,205]},{'class':4,'label':f'Higher by ≥ {major} m','rgba':[220,35,35,235]}]}
os.makedirs(os.path.dirname(out),exist_ok=True);json.dump(payload,open(out,'w'),indent=2);print(json.dumps(payload,indent=2))
PY

docker run --rm -v "$ROOT:/data" nginx:1.27-alpine sh -lc '
  cp /data/working/change/change.json /data/web/change.json
  chmod 644 /data/web/change.json
  chmod -R a+rX /data/web/change
'
echo "Terrain change catalogue ready: $ROOT/web/change.json"
