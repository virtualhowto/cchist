#!/usr/bin/env python3
"""Discover public NSW Spatial Services historical imagery mosaics.

Writes a small JSON catalogue for the cchist Leaflet client. The catalogue is
kept outside Git under the LiDAR web mount so it can be refreshed by the
self-hosted runner without rebuilding the app image.
"""
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


def get_json(url, params=None, timeout=30):
    if params:
        url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "cchist-historic-imagery/1.1"})
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
    """Return [west,south,east,north] in EPSG:4326 when possible."""
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
        west = float(extent["xmin"])
        south = float(extent["ymin"])
        east = float(extent["xmax"])
        north = float(extent["ymax"])
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    queries = [
        'owner:ss-sds AND title:"Historical Imagery"',
        'owner:ss-sds AND HAPE',
        'title:"Historical Imagery" AND (type:"Image Service" OR type:"Map Service" OR type:"Image")',
    ]
    found = {}
    errors = []
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
        service_type = None
        tiled = False
        service = {}
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
            "coverageSource": coverage_source,
            "source": "NSW Spatial Services HAPE",
        })

    by_year = {}
    for entry in sorted(entries, key=lambda x: (x["year"], not bool(x["serviceUrl"]), not bool(x.get("bbox")), x["title"])):
        cur = by_year.get(entry["year"])
        if cur is None:
            by_year[entry["year"]] = entry
            continue
        if entry.get("serviceUrl") and not cur.get("serviceUrl"):
            by_year[entry["year"]] = entry
        elif entry.get("bbox") and not cur.get("bbox"):
            by_year[entry["year"]] = entry

    epochs = [by_year[y] for y in sorted(by_year)]
    out = {
        "updated": datetime.now(timezone.utc).isoformat(),
        "source": "NSW Spatial Services Historical Imagery / HAPE",
        "viewer": f"{PORTAL}/apps/webappviewer/index.html?id=f7c215b873864d44bccddda8075238cb",
        "coverageModel": "catalogue bounding boxes in EPSG:4326; an epoch is shown when its coverage intersects the current map view",
        "epochs": epochs,
        "errors": errors[-20:],
    }
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2)

    print(json.dumps({
        "epochs": len(epochs),
        "withCoverage": sum(1 for x in epochs if x.get("bbox")),
        "years": [x["year"] for x in epochs],
    }, indent=2))


if __name__ == "__main__":
    main()
