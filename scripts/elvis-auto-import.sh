#!/usr/bin/env bash
set -euo pipefail

ROOT="${LIDAR_ROOT:-/mnt/usb/stack/cchist/lidar}"
MANAGER="${ELVIS_MANAGER:-/mnt/usb/stack/cchist/elvis-manager.sh}"
INDEX="$ROOT/catalogue/elvis-index.json"
AREAS="$ROOT/web/areas.json"
MAX_SURVEYS="${ELVIS_AUTO_MAX_SURVEYS:-2}"
SETTLE_SECONDS="${ELVIS_ZIP_SETTLE_SECONDS:-120}"
LOCK="$ROOT/working/elvis-auto-import.lock"

mkdir -p "$ROOT/working" "$ROOT/catalogue" "$ROOT/web/areas"
command -v flock >/dev/null || { echo 'flock is required' >&2; exit 1; }
command -v python3 >/dev/null || { echo 'python3 is required' >&2; exit 1; }
command -v docker >/dev/null || { echo 'docker is required' >&2; exit 1; }
[[ -f "$MANAGER" ]] || { echo "ELVIS manager not found: $MANAGER" >&2; exit 1; }
chmod +x "$MANAGER"

exec 9>"$LOCK"
if ! flock -n 9; then
  echo 'Another ELVIS auto-import is already running; exiting.'
  exit 0
fi

uid="$(id -u)"
gid="$(id -g)"

repair_permissions() {
  docker run --rm -v "$ROOT:/data" alpine:3.22 sh -c \
    "mkdir -p /data/catalogue /data/working /data/areas /data/web/areas; chown -R ${uid}:${gid} /data/catalogue /data/working /data/areas /data/web/areas; chmod -R u+rwX,go+rX /data/catalogue /data/working /data/areas /data/web/areas"
}

patch_manager_user_mode() {
  python3 - "$MANAGER" <<'PY'
import re,sys
p=sys.argv[1]
s=open(p).read()
if '--user "$(id -u):$(id -g)"' in s:
    raise SystemExit(0)
patterns=[
    (r'(docker run \\\n\s*--rm \\\n)(\s*--entrypoint python3 \\\n)', r'\1        --user "$(id -u):$(id -g)" \\\n\2'),
    (r'(docker run \\\n\s*--rm \\\n)(\s*--entrypoint /bin/bash \\\n)', r'\1        --user "$(id -u):$(id -g)" \\\n\2'),
]
changed=0
for pattern,repl in patterns:
    s,n=re.subn(pattern,repl,s,count=1)
    changed+=n
if changed:
    open(p,'w').write(s)
    print(f'Patched {p} so GDAL containers write as the host user.')
else:
    print('Manager did not need/accept the ownership patch; continuing with permission repair.')
PY
}

zip_is_settled() {
  local zip="$1" now mtime age
  now="$(date +%s)"
  mtime="$(stat -c '%Y' "$zip")"
  age=$((now-mtime))
  if (( age < SETTLE_SECONDS )); then
    echo "ZIP still settling (${age}s old): $zip"
    return 1
  fi
  if ! unzip -Z1 "$zip" >/dev/null 2>&1; then
    echo "ZIP is incomplete/unreadable; waiting for next run: $zip"
    return 1
  fi
  return 0
}

# Never race a file that is still being copied into the ELVIS archive.
while IFS= read -r -d '' zip; do
  if ! zip_is_settled "$zip"; then
    echo 'ELVIS ingest deferred until all ZIP files are complete.'
    exit 0
  fi
done < <(find "$ROOT/raw" -type f -iname '*.zip' -print0 2>/dev/null || true)

repair_permissions
patch_manager_user_mode
repair_permissions

echo '=== Refreshing ELVIS catalogue ==='
"$MANAGER" scan

[[ -s "$INDEX" ]] || { echo "Catalogue was not generated: $INDEX" >&2; exit 1; }

mapfile -t pending < <(python3 - "$INDEX" "$AREAS" <<'PY'
import json,sys
index_path,areas_path=sys.argv[1:]
index=json.load(open(index_path))
built=set()
try:
    areas=json.load(open(areas_path))
    for area in areas.get('areas',[]):
        if not area.get('ready'):
            continue
        for survey in area.get('surveys',[]):
            built.add(str(survey).strip().lower())
except Exception:
    pass
pending=[]
for survey in index.get('surveys',[]):
    name=str(survey.get('survey') or '').strip()
    if not name or not survey.get('bboxWgs84') or int(survey.get('demFiles') or 0)<=0:
        continue
    if name.lower() in built:
        continue
    pending.append(survey)
# newest first; for the same year, smaller exports first
pending.sort(key=lambda s:(-(int(s.get('year') or 0)),int(s.get('demFiles') or 0),str(s.get('survey') or '').lower()))
for survey in pending:
    print(survey['survey'])
PY
)

if (( ${#pending[@]} == 0 )); then
  echo 'No new survey names found. Nothing to import.'
  exit 0
fi

echo '=== New survey names ==='
printf '  %s\n' "${pending[@]}"

built_count=0
failed_count=0
for survey in "${pending[@]}"; do
  if (( MAX_SURVEYS > 0 && built_count >= MAX_SURVEYS )); then
    echo "Per-run limit reached (${MAX_SURVEYS}); remaining surveys stay pending for the next run."
    break
  fi

  echo
  echo "=== Auto importing: $survey ==="
  if "$MANAGER" build-survey "$survey"; then
    built_count=$((built_count+1))
  else
    failed_count=$((failed_count+1))
    echo "Import failed for $survey; it will be retried on the next run." >&2
  fi
done

echo
echo "ELVIS auto import finished: built=$built_count failed=$failed_count pending_before=${#pending[@]}"
(( failed_count == 0 ))
