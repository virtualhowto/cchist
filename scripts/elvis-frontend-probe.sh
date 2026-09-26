#!/usr/bin/env bash
set -euo pipefail
BASE="https://elevation.fsdf.org.au"
TMP="${RUNNER_TEMP:-/tmp}/elvis-probe"
rm -rf "$TMP" && mkdir -p "$TMP"

curl -fsSL -A 'Mozilla/5.0 cchist-elvis-probe/1.0' "$BASE/" -o "$TMP/index.html"
echo '=== base/script tags ==='
grep -Eoi '<base[^>]*>|<script[^>]+src=[^>]+>|<link[^>]+href=[^>]+' "$TMP/index.html" | head -80 || true

echo '=== candidate assets ==='
python3 - "$TMP/index.html" > "$TMP/assets.txt" <<'PY'
import re,sys
h=open(sys.argv[1],encoding='utf-8',errors='replace').read()
for x in re.findall(r'(?:src|href)=["\']([^"\']+\.(?:js|mjs)(?:\?[^"\']*)?)["\']',h,re.I):
    print(x)
PY
cat "$TMP/assets.txt"

: > "$TMP/real-js.txt"
while IFS= read -r asset; do
  [ -n "$asset" ] || continue
  name="${asset#./}"
  name="${name#/}"
  for prefix in '' 'cache/' 'assets/' 'cache/assets/' 'cache/js/' 'js/'; do
    url="$BASE/${prefix}${name}"
    hdr="$TMP/hdr"
    out="$TMP/body"
    code=$(curl -sSL -A 'Mozilla/5.0 cchist-elvis-probe/1.0' -H 'Accept: application/javascript,text/javascript,*/*;q=0.8' -D "$hdr" -o "$out" -w '%{http_code}' "$url" || true)
    ctype=$(grep -i '^content-type:' "$hdr" | tail -1 | tr -d '\r' | cut -d: -f2- | xargs || true)
    bytes=$(wc -c < "$out" 2>/dev/null || echo 0)
    echo "$code type=${ctype:-?} bytes=$bytes $url"
    if [[ "$code" == 200 && "$ctype" != text/html* && "$bytes" -gt 1000 ]]; then
      echo "$url" >> "$TMP/real-js.txt"
      break
    fi
  done
done < "$TMP/assets.txt"

echo '=== auxiliary app files ==='
for path in ngsw.json manifest.webmanifest asset-manifest.json cache/ngsw.json cache/manifest.webmanifest cache/asset-manifest.json runtime.js cache/runtime.js; do
  code=$(curl -sSL -A 'Mozilla/5.0 cchist-elvis-probe/1.0' -o "$TMP/aux" -w '%{http_code}' "$BASE/$path" || true)
  bytes=$(wc -c < "$TMP/aux" 2>/dev/null || echo 0)
  first=$(head -c 100 "$TMP/aux" | tr '\n\r' '  ' || true)
  echo "$code bytes=$bytes $BASE/$path :: $first"
done

echo '=== endpoint strings from real JS ==='
if [ -s "$TMP/real-js.txt" ]; then
  while IFS= read -r url; do
    f="$TMP/$(printf '%s' "$url" | sha256sum | cut -c1-16).js"
    curl -fsSL -A 'Mozilla/5.0 cchist-elvis-probe/1.0' "$url" -o "$f"
    echo "--- $url ($(wc -c < "$f") bytes) ---"
    grep -Eo 'https?://[^"'"'"'[:space:]<>\\)]+' "$f" | grep -Ei 'fme|api|elvis|elev|download|order|fsdf' | sort -u | head -150 || true
    python3 - "$f" <<'PY'
import re,sys
s=open(sys.argv[1],encoding='utf-8',errors='replace').read()
for needle in ['fme','api/','/api','download','order','email','polygon','ReturnDownloadables','submit']:
    low=s.lower(); n=needle.lower(); pos=0; count=0
    while count<8:
        i=low.find(n,pos)
        if i<0: break
        print(f'[{needle}] '+s[max(0,i-240):min(len(s),i+500)].replace('\n',' ')[:760])
        pos=i+len(n); count+=1
PY
  done < "$TMP/real-js.txt"
else
  echo 'No non-HTML JavaScript asset located.'
fi
