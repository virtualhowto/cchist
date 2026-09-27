#!/usr/bin/env python3
"""Discover NSW Spatial Services historical imagery and statewide cached-tile coverage."""
import argparse
import concurrent.futures
import json
import math
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

PORTAL = "https://portal.spatial.nsw.gov.au/portal"
SEARCH = PORTAL + "/sharing/rest/search"
ITEM = PORTAL + "/sharing/rest/content/items/{id}"
WEB_MERCATOR_WKIDS = {3857, 102100, 102113, 900913}
NSW_AOI = [140.8, -37.7, 159.4, -28.0]  # west,south,east,north; includes NSW islands
COVERAGE_ZOOM = int(os.getenv("NSW_IMAGERY_COVERAGE_ZOOM", "10"))
PROBE_WORKERS = int(os.getenv("NSW_IMAGERY_PROBE_WORKERS", "32"))


def get_json(url, params=None, timeout=30):
    if params:
        url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "history-research-map-nsw-imagery/2.0"})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.load(response)


def year_from(item):
    text = " ".join(str(item.get(k, "")) for k in ("title", "snippet", "description", "tags"))
    years = [int(x) for x in re.findall(r"\b(19\d{2}|20\d{2})\b", text)]
    years = [y for y in years if 1930 <= y <= datetime.now().year]
    return min(years) if years else None


def webmercator_to_lonlat(x, y):
    lon = x * 180.0 / 20037508.342789244
    lat = math.degrees(2.0 * math.atan(math.exp(y / 6378137.0)) - math.pi / 2.0)
    return lon, max(-90.0, min(90.0, lat))


def bbox_from_extent(extent):
    if not extent:
        return None
    if isinstance(extent, list) and len(extent) == 2:
        try:
            west, south = float(extent[0][0]), float(extent[0][1])
            east, north = float(extent[1][0]), float(extent[1][1])
            if -180 <= west <= 180 and -180 <= east <= 180 and -90 <= south <= 90 and -90 <= north <= 90:
                return [min(west, east), min(south, north), max(west, east), max(south, north)]
        except Exception:
            return None
    if not isinstance(extent, dict):
        return None
    try:
        west, south, east, north = (float(extent[k]) for k in ("xmin", "ymin", "xmax", "ymax"))
    except Exception:
        return None
    sr = extent.get("spatialReference") or {}
    wkid = sr.get("latestWkid") or sr.get("wkid")
    try:
        wkid = int(wkid) if wkid is not None else None
    except Exception:
        wkid = None
    if wkid in WEB_MERCATOR_WKIDS:
        west, south = webmercator_to_lonlat(west, south)
        east, north = webmercator_to_lonlat(east, north)
    elif not (-180 <= west <= 180 and -180 <= east <= 180 and -90 <= south <= 90 and -90 <= north <= 90):
        return None
    return [min(west, east), min(south, north), max(west, east), max(south, north)]


def lonlat_to_tile(lon, lat, z):
    lat = max(-85.05112878, min(85.05112878, lat))
    n = 2 ** z
    x = int((lon + 180.0) / 360.0 * n)
    y = int((1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n)
    return max(0, min(n - 1, x)), max(0, min(n - 1, y))


def tile_exists(service_url, level, row, col):
    """ArcGIS blankTile=false returns HTTP 404 when no cached image tile exists."""
    url = f"{service_url.rstrip('/')}/tile/{level}/{row}/{col}?blankTile=false"
    req = urllib.request.Request(url, headers={
        "User-Agent": "history-research-map-nsw-coverage/2.0",
        "Accept": "image/*",
    })
    try:
        with urllib.request.urlopen(req, timeout=12) as response:
            response.read(1)
            return True, None
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return False, None
        return False, f"HTTP {exc.code}"
    except Exception as exc:
        return False, str(exc)


def tile_coverage_grid(service_url, bbox=NSW_AOI, level=COVERAGE_ZOOM):
    west, south, east, north = bbox
    left, top = lonlat_to_tile(west, north, level)
    right, bottom = lonlat_to_tile(east, south, level)
    width, height = right - left + 1, bottom - top + 1
    if width <= 0 or height <= 0:
        return None
    coords = [(row, col) for row in range(top, bottom + 1) for col in range(left, right + 1)]
    values = [0] * len(coords)
    errors = []

    def probe(index_coord):
        index, (row, col) = index_coord
        exists, error = tile_exists(service_url, level, row, col)
        return index, exists, error

    with concurrent.futures.ThreadPoolExecutor(max_workers=PROBE_WORKERS) as pool:
        for index, exists, error in pool.map(probe, enumerate(coords)):
            values[index] = 1 if exists else 0
            if error and len(errors) < 10:
                errors.append(error)

    # If every request failed for reasons other than normal 404 misses, coverage is unknown.
    if errors and not any(values):
        return None
    return {
        "level": level,
        "left": left,
        "top": top,
        "width": width,
        "height": height,
        "bits": "".join("1" if v else "0" for v in values),
        "availableTiles": sum(values),
        "testedTiles": len(values),
        "aoi": bbox,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    parser.add_argument("--skip-tile-probe", action="store_true", help="Use service/portal extents only")
    args = parser.parse_args()

    queries = [
        'owner:ss-sds AND title:"Historical Imagery"',
        'owner:ss-sds AND HAPE',
        'title:"Historical Imagery" AND (type:"Image Service" OR type:"Map Service" OR type:"Image")',
    ]
    found, errors = {}, []
    for query in queries:
        try:
            data = get_json(SEARCH, {"f": "json", "q": query, "num": 100, "start": 1})
            for item in data.get("results", []):
                if item.get("id"):
                    found[item["id"]] = item
        except Exception as exc:
            errors.append(f"{query}: {exc}")

    entries = []
    for item_id, seed in found.items():
        try:
            item = get_json(ITEM.format(id=item_id), {"f": "json"})
        except Exception:
            item = seed
        title = item.get("title") or seed.get("title") or item_id
        low = title.lower()
        if "histor" not in low and "hape" not in low:
            continue
        year = year_from(item)
        if not year:
            continue

        url = item.get("url") or seed.get("url")
        service_type, tiled, service = None, False, {}
        if url:
            try:
                service = get_json(url, {"f": "json"})
                tiled = bool(service.get("tileInfo") or service.get("singleFusedMapCache"))
                tail = url.rstrip("/").lower()
                if tail.endswith("/imageserver"):
                    service_type = "ImageServer"
                elif tail.endswith("/mapserver"):
                    service_type = "MapServer"
            except Exception as exc:
                errors.append(f"{title}: {exc}")

        bbox = bbox_from_extent(item.get("extent")) or bbox_from_extent(seed.get("extent"))
        coverage_source = "portal-item" if bbox else None
        if not bbox:
            bbox = bbox_from_extent(service.get("fullExtent")) or bbox_from_extent(service.get("extent"))
            coverage_source = "service-extent" if bbox else None

        grid = None
        if not args.skip_tile_probe and url and tiled and service_type in ("MapServer", "ImageServer"):
            try:
                grid = tile_coverage_grid(url)
            except Exception as exc:
                errors.append(f"{title} tile probe: {exc}")

        entries.append({
            "year": year,
            "title": title,
            "itemId": item_id,
            "itemUrl": f"{PORTAL}/home/item.html?id={item_id}",
            "serviceUrl": url,
            "serviceType": service_type,
            "tiled": tiled,
            "tileUrl": (url.rstrip("/") + "/tile/{z}/{y}/{x}") if url and tiled else None,
            "bbox": bbox,
            "coverageSource": "tile-probe-grid" if grid else coverage_source,
            "coverageGrid": grid,
            "source": "NSW Spatial Services HAPE",
        })

    # Keep the strongest service-backed entry for each nominal year.
    by_year = {}
    for entry in sorted(entries, key=lambda x: (
        x["year"], not bool(x.get("coverageGrid")), not bool(x.get("serviceUrl")), not bool(x.get("bbox")), x["title"]
    )):
        current = by_year.get(entry["year"])
        if current is None:
            by_year[entry["year"]] = entry
        elif entry.get("coverageGrid") and not current.get("coverageGrid"):
            by_year[entry["year"]] = entry
        elif entry.get("serviceUrl") and not current.get("serviceUrl"):
            by_year[entry["year"]] = entry

    epochs = [by_year[y] for y in sorted(by_year)]
    output = {
        "updated": datetime.now(timezone.utc).isoformat(),
        "scope": "New South Wales",
        "source": "NSW Spatial Services Historical Imagery / HAPE",
        "viewer": f"{PORTAL}/apps/webappviewer/index.html?id=f7c215b873864d44bccddda8075238cb",
        "coverageModel": (
            f"Actual ArcGIS cached tiles sampled statewide with blankTile=false at Web Mercator zoom {COVERAGE_ZOOM}; "
            "published bbox is retained as fallback when tile coverage cannot be sampled"
        ),
        "coverageAoi": NSW_AOI,
        "coverageZoom": COVERAGE_ZOOM,
        "epochs": epochs,
        "errors": errors[-80:],
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(output, handle, indent=2)

    print(json.dumps({
        "epochs": len(epochs),
        "withTileCoverage": sum(1 for x in epochs if x.get("coverageGrid")),
        "yearsWithNswTiles": [x["year"] for x in epochs if (x.get("coverageGrid") or {}).get("availableTiles", 0) > 0],
        "coverageZoom": COVERAGE_ZOOM,
    }, indent=2))


if __name__ == "__main__":
    main()
