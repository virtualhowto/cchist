#!/usr/bin/env bash
set -euo pipefail
BASE="https://customerdigitalservices.ga.gov.au"
ORIGIN="https://elevation.fsdf.org.au"
TMP="${RUNNER_TEMP:-/tmp}/elvis-backend-probe"
rm -rf "$TMP" && mkdir -p "$TMP"

probe() {
  local path="$1"
  local safe="$(printf '%s' "$path" | tr '/?&=' '____')"
  local hdr="$TMP/${safe}.hdr" body="$TMP/${safe}.body"
  local code
  code=$(curl -sS -L --connect-timeout 8 --max-time 20 \
    -A 'Mozilla/5.0 cchist-elvis-probe/1.0' \
    -H "Origin: $ORIGIN" \
    -H 'Accept: application/json,text/plain,*/*' \
    -D "$hdr" -o "$body" -w '%{http_code}' "$BASE$path" || true)
  local ctype allow cors bytes first
  ctype=$(grep -i '^content-type:' "$hdr" | tail -1 | tr -d '\r' | cut -d: -f2- | xargs || true)
  allow=$(grep -i '^allow:' "$hdr" | tail -1 | tr -d '\r' | cut -d: -f2- | xargs || true)
  cors=$(grep -i '^access-control-allow-origin:' "$hdr" | tail -1 | tr -d '\r' | cut -d: -f2- | xargs || true)
  bytes=$(wc -c < "$body" 2>/dev/null || echo 0)
  first=$(head -c 350 "$body" 2>/dev/null | tr '\n\r\t' '   ' || true)
  echo "$code type=${ctype:-?} bytes=$bytes allow=${allow:--} cors=${cors:--} $path :: $first"
}

echo '=== DNS/TLS ==='
getent ahosts customerdigitalservices.ga.gov.au | head -10 || true
curl -sSI --connect-timeout 8 --max-time 15 "$BASE/" | sed -n '1,30p' || true

echo '=== CORS preflight ==='
curl -sS -i -X OPTIONS --connect-timeout 8 --max-time 15 \
  -H "Origin: $ORIGIN" \
  -H 'Access-Control-Request-Method: GET' \
  -H 'Access-Control-Request-Headers: content-type,authorization' \
  "$BASE/" | sed -n '1,50p' || true

echo '=== Public endpoint candidates ==='
for path in \
  /robots.txt \
  /health /healthz /api/health /api/healthz /actuator/health \
  /swagger /swagger/index.html /swagger/v1/swagger.json /swagger.json \
  /openapi.json /api/openapi.json /api-docs /v3/api-docs \
  /api /api/ /graphql \
  /elvis /api/elvis \
  /datasets /api/datasets /v1/datasets /api/v1/datasets \
  /search /api/search /v1/search /api/v1/search \
  /orders /api/orders /v1/orders /api/v1/orders \
  /order /api/order \
  /downloadables /api/downloadables \
  /downloads /api/downloads \
  /elevation /api/elevation; do
  probe "$path"
done
