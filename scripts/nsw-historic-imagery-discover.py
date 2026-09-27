#!/usr/bin/env python3
"""Discover public NSW Spatial Services historical imagery mosaics.

Writes a small JSON catalogue for the cchist Leaflet client. The catalogue is
kept outside Git under the LiDAR web mount so it can be refreshed by the
self-hosted runner without rebuilding the app image.
"""
import argparse
import json
import re
import urllib.parse
import urllib.request
from datetime import datetime, timezone

PORTAL = "https://portal.spatial.nsw.gov.au/portal"
SEARCH = PORTAL + "/sharing/rest/search"
ITEM = PORTAL + "/sharing/rest/content/items/{id}"


def get_json(url, params=None, timeout=30):
    if params:
        url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "cchist-historic-imagery/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def year_from(item):
    text = " ".join(str(item.get(k, "")) for k in ("title", "snippet", "description", "tags"))
    years = [int(x) for x in re.findall(r"\b(19\d{2}|20\d{2})\b", text)]
    # Historical imagery service titles normally carry the capture year. Prefer
    # the earliest plausible capture year over metadata/update years.
    years = [y for y in years if 1930 <= y <= datetime.now().year]
    return min(years) if years else None


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
        entries.append({
            "year": year,
            "title": title,
            "itemId": item_id,
            "itemUrl": f"{PORTAL}/home/item.html?id={item_id}",
            "serviceUrl": url,
            "serviceType": service_type,
            "tiled": tiled,
            "tileUrl": (url.rstrip("/") + "/tile/{z}/{y}/{x}") if url and tiled else None,
            "source": "NSW Spatial Services HAPE",
        })

    # Prefer a service-backed item when duplicate years exist.
    by_year = {}
    for entry in sorted(entries, key=lambda x: (x["year"], not bool(x["serviceUrl"]), x["title"])):
        cur = by_year.get(entry["year"])
        if cur is None or (entry["serviceUrl"] and not cur.get("serviceUrl")):
            by_year[entry["year"]] = entry

    out = {
        "updated": datetime.now(timezone.utc).isoformat(),
        "source": "NSW Spatial Services Historical Imagery / HAPE",
        "viewer": f"{PORTAL}/apps/webappviewer/index.html?id=f7c215b873864d44bccddda8075238cb",
        "epochs": [by_year[y] for y in sorted(by_year)],
        "errors": errors[-20:],
    }
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2)
    print(json.dumps({"epochs": len(out["epochs"]), "years": [x["year"] for x in out["epochs"]]}, indent=2))


if __name__ == "__main__":
    main()
