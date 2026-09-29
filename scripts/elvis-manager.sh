#!/usr/bin/env bash
set -euo pipefail
umask 022

ROOT="${LIDAR_ROOT:-/mnt/usb/stack/cchist/lidar}"
GDAL_IMAGE="${GDAL_IMAGE:-ghcr.io/osgeo/gdal:ubuntu-small-3.13.3}"
RAW="$ROOT/raw"
ELVIS="$RAW/elvis"
BASELINE="$RAW/baseline"
UNKNOWN="$RAW/unknown"
EXTRACTED="$RAW/extracted"
CATALOGUE="$ROOT/catalogue"
WORKING="$ROOT/working"
AREAS="$ROOT/areas"
INDEX="$CATALOGUE/elvis-index.json"
WEB="$ROOT/web"
WEB_AREAS="$WEB/areas"
AREAS_INDEX="$WEB/areas.json"
CPUS="${CPUS:-$(nproc)}"
MIN_ZOOM="${MIN_ZOOM:-9}"
MAX_ZOOM="${MAX_ZOOM:-17}"
AUTO_MAX_SURVEYS="${ELVIS_AUTO_MAX_SURVEYS:-0}"
ZIP_SETTLE_SECONDS="${ELVIS_ZIP_SETTLE_SECONDS:-120}"

say(){ printf '%s\n' "$*"; }
die(){ echo "ERROR: $*" >&2; exit 1; }
need(){ command -v "$1" >/dev/null 2>&1 || die "Missing command: $1"; }

usage(){ cat <<'HELP'
ELVIS archive manager

Commands:
  scan
      Organise ZIPs, extract new ELVIS packages, rebuild the spatial catalogue.

  list
      Show indexed surveys.

  pending
      Show indexed surveys that do not yet have a built multi-area cache.

  build <name> <west> <south> <east> <north>
      Build a named AOI from the best available intersecting DEM tiles.

  build-survey <survey>
      Build only DEM tiles belonging to the named survey.

  all <name> <west> <south> <east> <north>
      scan + build

  all-survey <survey>
      scan + build-survey

  auto
      scan + automatically build newly discovered survey names. Existing built
      survey names in /lidar/areas.json are skipped. Failed builds remain pending
      and are retried on the next run.

Environment:
  LIDAR_ROOT=/mnt/usb/stack/cchist/lidar
  ELVIS_AUTO_MAX_SURVEYS=0   # 0 = unlimited per run
  ELVIS_ZIP_SETTLE_SECONDS=120
  CPUS=<nproc>
  MIN_ZOOM=9
  MAX_ZOOM=17

Examples:
  ./elvis-manager.sh scan
  ./elvis-manager.sh list
  ./elvis-manager.sh pending
  ./elvis-manager.sh build-survey Bathurst201510
  ELVIS_AUTO_MAX_SURVEYS=2 ./elvis-manager.sh auto
HELP
}

init_tree(){
  mkdir -p "$RAW/dem" "$ELVIS" "$BASELINE" "$UNKNOWN" "$EXTRACTED" \
    "$CATALOGUE" "$WORKING" "$AREAS" "$WEB" "$WEB_AREAS"
  chmod 755 "$ROOT" "$RAW" "$ELVIS" "$BASELINE" "$UNKNOWN" "$EXTRACTED" \
    "$CATALOGUE" "$WORKING" "$AREAS" "$WEB" "$WEB_AREAS" 2>/dev/null || true
}

acquire_lock(){
  need flock
  init_tree
  exec 9>"$WORKING/elvis-manager.lock"
  flock -n 9 || die "Another ELVIS manager job is already running."
}

file_age_seconds(){
  local file="$1" now mtime
  now="$(date +%s)"
  mtime="$(stat -c '%Y' "$file")"
  echo $((now-mtime))
}

zip_ready(){
  local zip="$1" age
  age="$(file_age_seconds "$zip")"
  if (( age < ZIP_SETTLE_SECONDS )); then
    echo "WAIT: $(basename "$zip") is only ${age}s old; waiting for copy/download to settle." >&2
    return 1
  fi
  if ! unzip -Z1 "$zip" >/dev/null 2>&1; then
    echo "WAIT: $(basename "$zip") has no readable ZIP central directory yet; leaving it in place." >&2
    return 1
  fi
  return 0
}

move_safe(){
  local src="$1" destination="$2" name dest
  name="$(basename "$src")"
  dest="$destination/$name"
  [[ "$src" == "$dest" ]] && return 0
  if [[ -e "$dest" ]]; then
    if cmp -s "$src" "$dest"; then
      echo "Duplicate already exists: $dest"
      rm -f "$src"
    else
      echo "WARNING: different file already exists at $dest; leaving $src" >&2
    fi
    return 0
  fi
  echo "MOVE: $src -> $dest"
  mv -- "$src" "$dest"
}

classify_zip(){
  local zip="$1" name listing
  name="$(basename "$zip")"
  case "$name" in
    nationalz*_ag.zip|1_Second_DEM_*.zip|1_Second_DSM_*.zip|Hydro_Enforced_1_Second_DEM_*.zip)
      echo baseline; return 0 ;;
  esac
  listing="$(unzip -Z1 "$zip" 2>/dev/null || true)"
  if [[ "$name" =~ ^DATA_[0-9]+\.zip$ ]] || \
     printf '%s\n' "$listing" | grep -Eqi 'LID[0-9]+.*\.(tif|tiff|laz|las)$|NSW Government - Spatial Services/(DEM|Point Clouds)/'; then
    echo elvis; return 0
  fi
  if printf '%s\n' "$listing" | grep -Eqi '(1.?second|national.*dem|digital.?elevation|hydro.?enforced)'; then
    echo baseline; return 0
  fi
  echo unknown
}

organise(){
  need unzip
  init_tree
  echo
  echo '================================================='
  echo ' Organising elevation archives'
  echo '================================================='
  local directory zip class
  for directory in "$RAW/dem" "$RAW/unknown"; do
    [[ -d "$directory" ]] || continue
    while IFS= read -r -d '' zip; do
      zip_ready "$zip" || continue
      class="$(classify_zip "$zip")"
      case "$class" in
        elvis) echo "ELVIS:    $(basename "$zip")"; move_safe "$zip" "$ELVIS" ;;
        baseline) echo "BASELINE: $(basename "$zip")"; move_safe "$zip" "$BASELINE" ;;
        *) echo "UNKNOWN:  $(basename "$zip")"; move_safe "$zip" "$UNKNOWN" ;;
      esac
    done < <(find "$directory" -maxdepth 1 -type f -iname '*.zip' -print0)
  done
  find "$ELVIS" "$BASELINE" "$UNKNOWN" -maxdepth 1 -type f -iname '*.zip' -exec chmod 644 {} + 2>/dev/null || true
}

extract_one(){
  local zip="$1" stem target marker oldmarker fingerprint
  zip_ready "$zip" || return 0
  stem="$(basename "$zip" .zip)"
  target="$EXTRACTED/$stem"
  marker="$target/.elvis-source.json"
  oldmarker="$target/.cchist-extracted"
  fingerprint="$(stat -c '%s|%Y' "$zip")"
  if [[ -f "$marker" ]]; then
    if python3 - "$marker" "$fingerprint" <<'PY'
import json,sys
try:
    x=json.load(open(sys.argv[1]))
    raise SystemExit(0 if x.get('fingerprint')==sys.argv[2] else 1)
except Exception:
    raise SystemExit(1)
PY
    then
      echo "Already extracted: $(basename "$zip")"
      return 0
    fi
  fi
  if [[ -f "$oldmarker" && "$oldmarker" -nt "$zip" ]]; then
    echo "Adopting existing extraction: $(basename "$zip")"
    python3 - "$marker" "$zip" "$fingerprint" <<'PY'
import json,sys,datetime
json.dump({'source':sys.argv[2],'fingerprint':sys.argv[3],'adoptedLegacyExtraction':True,'updated':datetime.datetime.now(datetime.timezone.utc).isoformat()},open(sys.argv[1],'w'),indent=2)
PY
    return 0
  fi
  echo "Extracting: $(basename "$zip") -> $target"
  rm -rf "$target.tmp"
  mkdir -p "$target.tmp"
  python3 - "$zip" "$target.tmp" <<'PY'
import os,sys,zipfile
src,out=sys.argv[1:]
root=os.path.realpath(out)
with zipfile.ZipFile(src) as z:
    for member in z.infolist():
        target=os.path.realpath(os.path.join(out,member.filename))
        if not (target==root or target.startswith(root+os.sep)):
            raise SystemExit('Unsafe ZIP member: '+member.filename)
    z.extractall(out)
PY
  rm -rf "$target"
  mv "$target.tmp" "$target"
  python3 - "$marker" "$zip" "$fingerprint" <<'PY'
import json,sys,datetime
json.dump({'source':sys.argv[2],'fingerprint':sys.argv[3],'updated':datetime.datetime.now(datetime.timezone.utc).isoformat()},open(sys.argv[1],'w'),indent=2)
PY
}

extract_all(){
  need python3
  init_tree
  echo
  echo '================================================='
  echo ' Extracting ELVIS packages'
  echo '================================================='
  while IFS= read -r -d '' zip; do
    extract_one "$zip"
  done < <(find "$ELVIS" -maxdepth 1 -type f -iname '*.zip' -print0 | sort -z)
}

ensure_gdal(){
  need docker
  docker info >/dev/null
  if ! docker image inspect "$GDAL_IMAGE" >/dev/null 2>&1; then
    echo "Pulling: $GDAL_IMAGE"
    docker pull "$GDAL_IMAGE"
  fi
}

write_index_program(){
cat > "$WORKING/elvis-index.py" <<'PY'
import os,re,json,subprocess,datetime,sys
ROOT='/data'
ELVIS=os.path.join(ROOT,'raw','elvis')
EXTRACTED=os.path.join(ROOT,'raw','extracted')
OUTPUT=os.path.join(ROOT,'catalogue','elvis-index.json')
os.makedirs(os.path.dirname(OUTPUT),exist_ok=True)
packages=[]
if os.path.isdir(ELVIS):
    for filename in sorted(os.listdir(ELVIS)):
        if not filename.lower().endswith('.zip'): continue
        path=os.path.join(ELVIS,filename)
        stem=os.path.splitext(filename)[0]
        packages.append({'name':filename,'stem':stem,'bytes':os.path.getsize(path),'mtime':os.path.getmtime(path)})

def relative(path): return os.path.relpath(path,ROOT).replace(os.sep,'/')

def parse_filename(path,product):
    filename=os.path.basename(path)
    m=re.match(r'(.+?)-LID(\d+)',filename,re.I)
    survey=m.group(1) if m else re.sub(r'\.(tif|tiff|laz|las)$','',filename,flags=re.I)
    lid=int(m.group(2)) if m else None
    capture=year=month=None
    m6=re.search(r'((?:19|20)\d{4})',survey)
    if m6:
        capture=m6.group(1); year=int(capture[:4])
        try: month=int(capture[4:6])
        except Exception: pass
    else:
        m4=re.search(r'((?:19|20)\d{2})',survey)
        if m4: capture=m4.group(1); year=int(capture)
    resolution=None
    mr=re.search(r'_([0-9]+(?:\.[0-9]+)?)m\.(?:tif|tiff)$',filename,re.I)
    if mr: resolution=float(mr.group(1))
    tile=zone=None
    mt=re.search(r'_(\d{7,8})_(5[4-6])_0002_0002(?:_[0-9.]+m)?\.(?:tif|tiff|laz|las)$',filename,re.I)
    if mt: tile=mt.group(1); zone=int(mt.group(2))
    return {'survey':survey,'capture':capture,'year':year,'month':month,'lidLevel':lid,'resolutionMeters':resolution,'tileId':tile,'zone':zone,'product':product}

def gdal_info(path):
    p=subprocess.run(['gdalinfo','-json',path],check=True,capture_output=True,text=True,timeout=180)
    return json.loads(p.stdout)

def bbox_wgs84(info):
    try: ring=info['wgs84Extent']['coordinates'][0]
    except Exception: return None
    xs=[float(p[0]) for p in ring]; ys=[float(p[1]) for p in ring]
    return [min(xs),min(ys),max(xs),max(ys)]

def get_epsg(path):
    try:
        p=subprocess.run(['gdalsrsinfo','-o','epsg',path],capture_output=True,text=True,timeout=60)
        m=re.search(r'EPSG:(\d+)',p.stdout+p.stderr,re.I)
        if m: return int(m.group(1))
    except Exception: pass
    return None

dem=[]; pointcloud=[]
for package in packages:
    directory=os.path.join(EXTRACTED,package['stem'])
    if not os.path.isdir(directory):
        print('WARNING: extraction missing:',directory,file=sys.stderr); continue
    for base,_,files in os.walk(directory):
        for filename in files:
            path=os.path.join(base,filename); low=filename.lower()
            if low.endswith(('.tif','.tiff')):
                item=parse_filename(path,'dem')
                try:
                    info=gdal_info(path)
                    item.update({'path':relative(path),'sourceZip':package['name'],'bboxWgs84':bbox_wgs84(info),'epsg':get_epsg(path),'rasterSize':info.get('size')})
                    dem.append(item)
                except Exception as exc: print('WARNING gdalinfo:',path,exc,file=sys.stderr)
            elif low.endswith(('.laz','.las')):
                item=parse_filename(path,'point-cloud'); item['path']=relative(path); item['sourceZip']=package['name']; pointcloud.append(item)

dem_lookup={}
for item in dem:
    key=(item.get('survey'),item.get('tileId'),item.get('zone'))
    if all(key): dem_lookup[key]=item
for item in pointcloud:
    key=(item.get('survey'),item.get('tileId'),item.get('zone')); matching=dem_lookup.get(key)
    if matching:
        item['bboxWgs84']=matching.get('bboxWgs84'); item['epsg']=matching.get('epsg'); item['resolutionMeters']=matching.get('resolutionMeters')
    else:
        item['bboxWgs84']=None; item['epsg']=None

def union(a,b):
    if not b: return a
    if not a: return list(b)
    return [min(a[0],b[0]),min(a[1],b[1]),max(a[2],b[2]),max(a[3],b[3])]

surveys={}
for item in dem+pointcloud:
    name=item.get('survey') or 'unknown'
    s=surveys.setdefault(name,{'survey':name,'capture':item.get('capture'),'year':item.get('year'),'demFiles':0,'pointCloudFiles':0,'resolutionsMeters':set(),'zones':set(),'epsg':set(),'bboxWgs84':None})
    if item['product']=='dem': s['demFiles']+=1
    else: s['pointCloudFiles']+=1
    if item.get('resolutionMeters') is not None: s['resolutionsMeters'].add(item['resolutionMeters'])
    if item.get('zone') is not None: s['zones'].add(item['zone'])
    if item.get('epsg') is not None: s['epsg'].add(item['epsg'])
    s['bboxWgs84']=union(s['bboxWgs84'],item.get('bboxWgs84'))

survey_list=[]
for s in surveys.values():
    s['resolutionsMeters']=sorted(s['resolutionsMeters']); s['zones']=sorted(s['zones']); s['epsg']=sorted(s['epsg']); survey_list.append(s)

catalogue={'version':2,'generated':datetime.datetime.now(datetime.timezone.utc).isoformat(),'summary':{'packageCount':len(packages),'surveyCount':len(survey_list),'demFiles':len(dem),'pointCloudFiles':len(pointcloud)},'packages':packages,'surveys':sorted(survey_list,key=lambda x:(x.get('year') or 0,x['survey'])),'dem':sorted(dem,key=lambda x:(x.get('survey') or '',x.get('tileId') or '',x['path'])),'pointCloud':sorted(pointcloud,key=lambda x:(x.get('survey') or '',x.get('tileId') or '',x['path']))}
with open(OUTPUT,'w') as f: json.dump(catalogue,f,indent=2)
print(json.dumps(catalogue['summary'],indent=2))
for s in catalogue['surveys']:
    print(s.get('year'),s['survey'],f"DEM={s['demFiles']}",f"LAZ={s['pointCloudFiles']}",f"res={s['resolutionsMeters']}",f"zones={s['zones']}")
PY
}

index_archive(){
  ensure_gdal
  init_tree
  write_index_program
  echo
  echo '================================================='
  echo ' Building ELVIS spatial catalogue'
  echo '================================================='
  docker run --rm --user "$(id -u):$(id -g)" --entrypoint python3 -v "$ROOT:/data" "$GDAL_IMAGE" /data/working/elvis-index.py
  chmod 644 "$INDEX"
  cp "$INDEX" "$WEB/elvis-index.json"
  chmod 644 "$WEB/elvis-index.json"
  echo "Catalogue: $INDEX"
}

scan(){ organise; extract_all; index_archive; }

list_catalogue(){
  [[ -f "$INDEX" ]] || die "No catalogue. Run '$0 scan' first."
  python3 - "$INDEX" <<'PY'
import json,sys
x=json.load(open(sys.argv[1])); s=x['summary']
print(f"\nPackages: {s['packageCount']}\nSurveys: {s['surveyCount']}\nDEM files: {s['demFiles']}\nLAZ/LAS: {s['pointCloudFiles']}\n")
print(f"{'YEAR':6} {'SURVEY':32} {'DEM':>5} {'LAZ':>5} {'RES(m)':14} {'ZONE':10}")
print('-'*82)
for survey in x.get('surveys',[]):
    resolutions=','.join(str(int(r) if float(r).is_integer() else r) for r in survey.get('resolutionsMeters',[])) or '-'
    zones=','.join(map(str,survey.get('zones',[]))) or '-'
    print(f"{str(survey.get('year') or '-'):6} {survey['survey'][:32]:32} {survey['demFiles']:5} {survey['pointCloudFiles']:5} {resolutions:14} {zones:10}")
PY
}

slugify(){ printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g;s/^-+//;s/-+$//'; }

validate_bbox(){
  python3 - "$@" <<'PY'
import os,sys
w,s,e,n=map(float,sys.argv[1:])
if not (w<e and s<n): raise SystemExit('Invalid bounding box')
if w<140 or e>160 or s<-39 or n>-27: raise SystemExit('Bounding box is outside expected NSW extent')
area=(e-w)*(n-s)
if area>4 and os.environ.get('ALLOW_LARGE_AOI')!='1': raise SystemExit('AOI is very large. Set ALLOW_LARGE_AOI=1 if intentional.')
PY
}

get_survey_bbox(){
  local survey="$1"
  python3 - "$INDEX" "$survey" <<'PY'
import json,sys
x=json.load(open(sys.argv[1])); wanted=sys.argv[2].lower()
for s in x['surveys']:
    if s['survey'].lower()==wanted:
        bbox=s.get('bboxWgs84')
        if not bbox: raise SystemExit('Survey has no geographic extent')
        print(' '.join(map(str,bbox))); raise SystemExit(0)
raise SystemExit('Survey not found: '+sys.argv[2])
PY
}

select_area(){
  local slug="$1" west="$2" south="$3" east="$4" north="$5" survey_filter="${6:-}"
  local area="$AREAS/$slug"
  mkdir -p "$area/working" "$area/derived" "$WEB_AREAS/$slug/hillshade" "$WEB_AREAS/$slug/slope" "$WEB_AREAS/$slug/tri"
  python3 - "$INDEX" "$area/working" "$west" "$south" "$east" "$north" "$survey_filter" <<'PY'
import json,sys,os
index,working=sys.argv[1:3]; west,south,east,north=map(float,sys.argv[3:7]); survey_filter=sys.argv[7].strip().lower()
x=json.load(open(index))
def intersects(b):
    return bool(b) and max(west,b[0])<min(east,b[2]) and max(south,b[1])<min(north,b[3])
candidates=[d for d in x.get('dem',[]) if intersects(d.get('bboxWgs84')) and (not survey_filter or str(d.get('survey','')).lower()==survey_filter)]
if not candidates: raise SystemExit('No indexed ELVIS DEM tiles intersect this area'+((' for survey '+survey_filter) if survey_filter else ''))
def key(d): return (d.get('tileId') or d['path'],d.get('zone'))
def rank(d): return (-float(d.get('resolutionMeters') or 9999),int(d.get('year') or 0),d.get('survey') or '')
chosen={}
for d in candidates:
    k=key(d)
    if k not in chosen or rank(d)>rank(chosen[k]): chosen[k]=d
selected=sorted(chosen.values(),key=lambda d:d['path'])
with open(os.path.join(working,'dem-list.txt'),'w') as f:
    for d in selected: f.write('/data/'+d['path']+'\n')
resolutions=[float(d['resolutionMeters']) for d in selected if d.get('resolutionMeters')]
resolution=min(resolutions or [2.0])
selection={'aoi':{'west':west,'south':south,'east':east,'north':north},'surveyFilter':survey_filter or None,'candidateCount':len(candidates),'selectedCount':len(selected),'targetResolutionMeters':resolution,'surveys':sorted(set(d['survey'] for d in selected)),'years':sorted(set(d['year'] for d in selected if d.get('year'))),'sources':selected}
json.dump(selection,open(os.path.join(working,'selection.json'),'w'),indent=2)
print(json.dumps({'selected':selection['selectedCount'],'resolution':resolution,'surveys':selection['surveys'],'years':selection['years']},indent=2))
PY
}

build_area(){
  [[ $# -ge 5 && $# -le 6 ]] || die 'build requires name west south east north [survey_filter]'
  local name="$1" west="$2" south="$3" east="$4" north="$5" survey_filter="${6:-}"
  validate_bbox "$west" "$south" "$east" "$north"
  local slug area resolution
  slug="$(slugify "$name")"; [[ -n "$slug" ]] || die 'Invalid area name'
  [[ -f "$INDEX" ]] || index_archive
  ensure_gdal
  area="$AREAS/$slug"
  echo
  echo '================================================='
  echo " Selecting source data for $name"
  echo '================================================='
  select_area "$slug" "$west" "$south" "$east" "$north" "$survey_filter"
  resolution="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["targetResolutionMeters"])' "$area/working/selection.json")"
  echo
  echo '================================================='
  echo ' Building terrain cache'
  echo '================================================='
  echo "Area: $name"
  [[ -n "$survey_filter" ]] && echo "Survey: $survey_filter"
  echo "Slug: $slug"
  echo "Resolution: ${resolution}m"
  echo "CPUs: $CPUS"

  docker run --rm --user "$(id -u):$(id -g)" --entrypoint /bin/bash \
    -v "$ROOT:/data" -e SLUG="$slug" -e WEST="$west" -e SOUTH="$south" -e EAST="$east" -e NORTH="$north" \
    -e RESOLUTION="$resolution" -e CPUS="$CPUS" -e MIN_ZOOM="$MIN_ZOOM" -e MAX_ZOOM="$MAX_ZOOM" "$GDAL_IMAGE" -lc '
set -euo pipefail
AREA="/data/areas/$SLUG"; WEB="/data/web/areas/$SLUG"
mkdir -p "$AREA/derived" "$WEB/hillshade" "$WEB/slope" "$WEB/tri"
mapfile -t SOURCES < "$AREA/working/dem-list.txt"
(( ${#SOURCES[@]} > 0 )) || { echo "No DEM sources selected"; exit 1; }
echo "DEM sources:"; printf "  %s\n" "${SOURCES[@]}"
rm -f "$AREA/derived/dem-3857.tif" "$AREA/derived/hillshade.tif" "$AREA/derived/slope-float.tif" "$AREA/derived/slope.tif" "$AREA/derived/tri-float.tif" "$AREA/derived/tri.tif"
gdalwarp -overwrite -te_srs EPSG:4326 -te "$WEST" "$SOUTH" "$EAST" "$NORTH" -t_srs EPSG:3857 -tr "$RESOLUTION" "$RESOLUTION" -tap -r bilinear -multi -wo NUM_THREADS=ALL_CPUS -co TILED=YES -co COMPRESS=DEFLATE -co BIGTIFF=IF_SAFER "${SOURCES[@]}" "$AREA/derived/dem-3857.tif"
gdaldem hillshade "$AREA/derived/dem-3857.tif" "$AREA/derived/hillshade.tif" -multidirectional -compute_edges
gdaldem slope "$AREA/derived/dem-3857.tif" "$AREA/derived/slope-float.tif" -compute_edges
gdaldem TRI "$AREA/derived/dem-3857.tif" "$AREA/derived/tri-float.tif" -compute_edges
gdal_translate -ot Byte -scale 0 90 0 255 -co TILED=YES -co COMPRESS=DEFLATE "$AREA/derived/slope-float.tif" "$AREA/derived/slope.tif"
gdal_translate -ot Byte -scale -co TILED=YES -co COMPRESS=DEFLATE "$AREA/derived/tri-float.tif" "$AREA/derived/tri.tif"
rm -rf "$WEB/hillshade/"* "$WEB/slope/"* "$WEB/tri/"*
gdal2tiles.py --xyz --processes="$CPUS" -z "$MIN_ZOOM-$MAX_ZOOM" -w none "$AREA/derived/hillshade.tif" "$WEB/hillshade"
gdal2tiles.py --xyz --processes="$CPUS" -z "$MIN_ZOOM-$MAX_ZOOM" -w none "$AREA/derived/slope.tif" "$WEB/slope"
gdal2tiles.py --xyz --processes="$CPUS" -z "$MIN_ZOOM-$MAX_ZOOM" -w none "$AREA/derived/tri.tif" "$WEB/tri"
chmod -R a+rX "$WEB"
'

  python3 - "$name" "$slug" "$area/working/selection.json" "$WEB_AREAS/$slug/status.json" "$AREAS_INDEX" "$MIN_ZOOM" "$MAX_ZOOM" <<'PY'
import json,sys,os,datetime
name,slug,selection_file,status_file,areas_file,minzoom,maxzoom=sys.argv[1:]
selection=json.load(open(selection_file)); now=datetime.datetime.now(datetime.timezone.utc).isoformat()
status={'ready':True,'name':name,'slug':slug,'updated':now,'aoi':selection['aoi'],'targetResolutionMeters':selection['targetResolutionMeters'],'surveys':selection['surveys'],'years':selection['years'],'sourceCount':selection['selectedCount'],'layers':{'hillshade':{'available':True,'minZoom':int(minzoom),'maxZoom':int(maxzoom)},'slope':{'available':True,'minZoom':int(minzoom),'maxZoom':int(maxzoom)},'tri':{'available':True,'minZoom':int(minzoom),'maxZoom':int(maxzoom)}}}
os.makedirs(os.path.dirname(status_file),exist_ok=True); json.dump(status,open(status_file,'w'),indent=2)
try: areas=json.load(open(areas_file))
except Exception: areas={'version':1,'areas':[]}
by_slug={a.get('slug'):a for a in areas.get('areas',[])}; by_slug[slug]=status
areas['generated']=now; areas['areas']=sorted(by_slug.values(),key=lambda a:a.get('name','').lower()); json.dump(areas,open(areas_file,'w'),indent=2)
PY
  chmod 644 "$WEB_AREAS/$slug/status.json" "$AREAS_INDEX"
  echo
  echo '================================================='
  echo ' AREA READY'
  echo '================================================='
  echo "Name: $name"
  echo "URL path: /lidar/areas/$slug/"
}

build_survey(){
  [[ $# -eq 1 ]] || die 'build-survey requires survey name'
  local survey="$1" bbox west south east north
  [[ -f "$INDEX" ]] || die 'Run scan first'
  bbox="$(get_survey_bbox "$survey")"
  read -r west south east north <<< "$bbox"
  echo "Survey: $survey"
  echo "Extent: $west $south $east $north"
  build_area "$survey" "$west" "$south" "$east" "$north" "$survey"
}

pending_surveys(){
  [[ -f "$INDEX" ]] || die "No catalogue. Run '$0 scan' first."
  python3 - "$INDEX" "$AREAS_INDEX" <<'PY'
import json,sys
index_path,areas_path=sys.argv[1:]
x=json.load(open(index_path))
built=set()
try:
    a=json.load(open(areas_path))
    for area in a.get('areas',[]):
        if not area.get('ready'): continue
        for survey in area.get('surveys',[]): built.add(str(survey).lower())
except Exception: pass
pending=[]
for s in x.get('surveys',[]):
    name=str(s.get('survey') or '').strip()
    if not name or not s.get('bboxWgs84') or int(s.get('demFiles') or 0)<=0: continue
    if name.lower() in built: continue
    pending.append(s)
pending.sort(key=lambda s:(-(int(s.get('year') or 0)),int(s.get('demFiles') or 0),str(s.get('survey') or '').lower()))
for s in pending: print(s['survey'])
PY
}

auto_import(){
  scan
  mapfile -t pending < <(pending_surveys)
  if (( ${#pending[@]} == 0 )); then
    echo 'No new survey names need importing.'
    return 0
  fi
  echo
  echo '================================================='
  echo ' New ELVIS surveys detected'
  echo '================================================='
  printf '  %s\n' "${pending[@]}"
  local limit="$AUTO_MAX_SURVEYS" built=0 failed=0 survey rc
  for survey in "${pending[@]}"; do
    if (( limit > 0 && built >= limit )); then
      echo "Import limit reached (${limit}); remaining surveys will be picked up next run."
      break
    fi
    echo
    echo "AUTO IMPORT: $survey"
    set +e
    build_survey "$survey"
    rc=$?
    set -e
    if (( rc == 0 )); then
      built=$((built+1))
    else
      failed=$((failed+1))
      echo "AUTO IMPORT FAILED: $survey (exit $rc); it will remain pending." >&2
    fi
  done
  echo
  echo "Auto import complete: built=$built failed=$failed"
  (( failed == 0 ))
}

main(){
  init_tree
  local command="${1:-help}"; shift || true
  case "$command" in
    scan) acquire_lock; scan ;;
    list) list_catalogue ;;
    pending) pending_surveys ;;
    build) acquire_lock; build_area "$@" ;;
    build-survey) acquire_lock; build_survey "$@" ;;
    all) acquire_lock; scan; build_area "$@" ;;
    all-survey) acquire_lock; scan; build_survey "$@" ;;
    auto) acquire_lock; auto_import ;;
    help|-h|--help) usage ;;
    *) usage; die "Unknown command: $command" ;;
  esac
}
main "$@"
