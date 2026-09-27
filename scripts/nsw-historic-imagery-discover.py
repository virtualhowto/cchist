#!/usr/bin/env python3
"""Discover NSW Spatial Services historical imagery and Central Coast coverage."""
import argparse
import json
import math
import re
import urllib.parse
import urllib.request
from datetime import datetime, timezone

PORTAL = "https://portal.spatial.nsw.gov.au/portal"
SEARCH = PORTAL + "/sharing/rest/search"
ITEM = PORTAL + "/sharing/rest/content/items/{id}"
WEB_MERCATOR_WKIDS = {3857, 102100, 102113, 900913}
AOI = [150.95, -33.62, 151.65, -33.10]  # west,south,east,north
COVERAGE_ZOOM = 14
TILEMAP_CHUNK = 32


def get_json(url, params=None, timeout=30):
    if params:
        url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "cchist-historic-imagery/1.2"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


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


def tile_coverage_grid(service_url, bbox=AOI, level=COVERAGE_ZOOM):
    """Probe ArcGIS tilemap so broad service extents don't imply false coverage."""
    west, south, east, north = bbox
    left, top = lonlat_to_tile(west, north, level)
    right, bottom = lonlat_to_tile(east, south, level)
    width, height = right - left + 1, bottom - top + 1
    if width <= 0 or height <= 0:
        return None
    values = [0] * (width * height)
    got_response = False
    base = service_url.rstrip("/")
    for row0 in range(0, height, TILEMAP_CHUNK):
        for col0 in range(0, width, TILEMAP_CHUNK):
            cw = min(TILEMAP_CHUNK, width - col0)
            ch = min(TILEMAP_CHUNK, height - row0)
            url = f"{base}/tilemap/{level}/{top + row0}/{left + col0}/{cw}/{ch}"
            payload = get_json(url, {"f": "json"}, timeout=20)
            data = payload.get("data")
            if not isinstance(data, list) or len(data) != cw * ch:
                raise RuntimeError(f"unexpected tilemap response from {url}")
            got_response = True
            for rr in range(ch):
                src = rr * cw
                dst = (row0 + rr) * width + col0
                for cc in range(cw):
                    values[dst + cc] = 1 if data[src + cc] else 0
    if not got_response:
        return None
    return {
        "level": level,
        "left": left,
        "top": top,
        "width": width,
        "height": height,
        "bits": "".join("1" if v else "0" for v in values),
        "availableTiles": sum(values),
        "aoi": bbox,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    queries = [
        'owner:ss-sds AND title:"Historical Imagery"',
        'owner:ss-sds AND HAPE',
        'title:"Historical Imagery" AND (type:"Image Service" OR type:"Map Service" OR type:"Image")',
    ]
    found, errors = {}, []
    for q in queries:
        try:
            data = get_json(SEARCH, {"f": "json", "q": q, "num": 100, "start": 1})
            for item in data.get("results", []):
                found[item.get("id")] = item
        except Exception as e:
            errors.append(f"{q}: {e}")

    entries = []
    for item_id, seed in found.items():
        if not item_id:
            continue
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
                if url.rstrip("/").lower().endswith("/imageserver"):
                    service_type = "ImageServer"
                elif url.rstrip("/").lower().endswith("/mapserver"):
                    service_type = "MapServer"
            except Exception as e:
                errors.append(f"{title}: {e}")
        bbox = bbox_from_extent(item.get("extent")) or bbox_from_extent(seed.get("extent"))
        coverage_source = "portal-item" if bbox else None
        if not bbox:
            bbox = bbox_from_extent(service.get("fullExtent")) or bbox_from_extent(service.get("extent"))
            coverage_source = "service-extent" if bbox else None
        grid = None
        if url and tiled and service_type == "MapServer":
            try:
                grid = tile_coverage_grid(url)
            except Exception as e:
                errors.append(f"{title} tilemap: {e}")
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
            "coverageSource": "tilemap-grid" if grid else coverage_source,
            "coverageGrid": grid,
            "source": "NSW Spatial Services HAPE",
        })

    by_year = {}
    for entry in sorted(entries, key=lambda x: (x["year"], not bool(x["serviceUrl"]), not bool(x.get("coverageGrid")), not bool(x.get("bbox")), x["title"])):
        cur = by_year.get(entry["year"])
        if cur is None:
            by_year[entry["year"]] = entry
        elif entry.get("coverageGrid") and not cur.get("coverageGrid"):
            by_year[entry["year"]] = entry
        elif entry.get("serviceUrl") and not cur.get("serviceUrl"):
            by_year[entry["year"]] = entry

    epochs = [by_year[y] for y in sorted(by_year)]
    out = {
        "updated": datetime.now(timezone.utc).isoformat(),
        "source": "NSW Spatial Services Historical Imagery / HAPE",
        "viewer": f"{PORTAL}/apps/webappviewer/index.html?id=f7c215b873864d44bccddda8075238cb",
        "coverageModel": f"ArcGIS tile availability sampled across the Central Coast at Web Mercator zoom {COVERAGE_ZOOM}; bbox is fallback only",
        "coverageAoi": AOI,
        "epochs": epochs,
        "errors": errors[-40:],
    }
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2)
    print(json.dumps({
        "epochs": len(epochs),
        "withTileCoverage": sum(1 for x in epochs if x.get("coverageGrid")),
        "withAnyCentralCoastTiles": sum(1 for x in epochs if (x.get("coverageGrid") or {}).get("availableTiles", 0) > 0),
        "yearsWithCentralCoastTiles": [x["year"] for x in epochs if (x.get("coverageGrid") or {}).get("availableTiles", 0) > 0],
    }, indent=2))


if __name__ == "__main__":
    main()
