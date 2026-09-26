#!/usr/bin/env python3
import argparse
import json
import os
import re
import sys
import urllib.parse
import urllib.request

DEFAULT_ENDPOINT = "https://elvis-ga.fmecloud.com/fmedatastreaming/elvis_indexes/ReturnDownloadables.fmw"
DEFAULT_BBOX = (150.95, -33.62, 151.65, -33.10)


def polygon_from_bbox(b):
    xmin, ymin, xmax, ymax = b
    return f"POLYGON (({xmin} {ymin},{xmax} {ymin},{xmax} {ymax},{xmin} {ymax},{xmin} {ymin}))"


def fetch_json(endpoint, polygon):
    url = endpoint + "?" + urllib.parse.urlencode({"polygon": polygon})
    req = urllib.request.Request(url, headers={"User-Agent": "cchist-elvis-discovery/1.0"})
    with urllib.request.urlopen(req, timeout=180) as r:
        body = r.read()
    return url, json.loads(body.decode("utf-8"))


def rows_from_node(node):
    """Recursively yield dicts that look like downloadable catalogue rows."""
    if isinstance(node, dict):
        lower = {str(k).lower(): v for k, v in node.items()}
        keys = set(lower)
        if any(k in keys for k in ("file_name", "filename", "name")) and any(
            k in keys for k in ("url", "download_url", "download", "file_url", "href", "path")
        ):
            yield node
        for v in node.values():
            yield from rows_from_node(v)
    elif isinstance(node, list):
        for v in node:
            yield from rows_from_node(v)


def pick(d, names):
    for n in names:
        for k, v in d.items():
            if str(k).lower() == n and v not in (None, ""):
                return str(v)
    return ""


def classify(name, row):
    text = (name + " " + json.dumps(row, ensure_ascii=False)).lower()
    if re.search(r"\.(laz|las)(?:$|[?\s])", text) or "point cloud" in text or "pointcloud" in text:
        return "laz"
    if re.search(r"\.(tif|tiff|zip)(?:$|[?\s])", text) and any(x in text for x in ("dem", "elevation", "bare earth", "bare-earth")):
        return "dem"
    if "dem" in text:
        return "dem"
    return ""


def normalise_url(url, row):
    if url.startswith("http://") or url.startswith("https://"):
        return url
    for k, v in row.items():
        if isinstance(v, str) and v.startswith(("http://", "https://")):
            return v
    return ""


def year_of(name, row):
    text = name + " " + json.dumps(row, ensure_ascii=False)
    years = [int(x) for x in re.findall(r"(?:19|20)\d{2}", text)]
    return max(years) if years else 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--endpoint", default=DEFAULT_ENDPOINT)
    ap.add_argument("--bbox", nargs=4, type=float, metavar=("XMIN", "YMIN", "XMAX", "YMAX"), default=DEFAULT_BBOX)
    ap.add_argument("--json", default="/tmp/elvis-central-coast.json")
    ap.add_argument("--manifest", default="/tmp/elvis-central-coast-manifest.txt")
    ap.add_argument("--latest-only", action="store_true", default=False)
    args = ap.parse_args()

    polygon = polygon_from_bbox(tuple(args.bbox))
    url, data = fetch_json(args.endpoint, polygon)
    with open(args.json, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)

    rows = list(rows_from_node(data))
    print(f"ELVIS query succeeded: {url}")
    print(f"Catalogue candidate rows: {len(rows)}")
    print("Top-level keys:", ", ".join(data.keys()) if isinstance(data, dict) else type(data).__name__)

    candidates = []
    for row in rows:
        name = pick(row, ("file_name", "filename", "name", "title"))
        raw_url = pick(row, ("download_url", "file_url", "url", "download", "href", "path"))
        dl = normalise_url(raw_url, row)
        typ = classify(name, row)
        if not typ or not dl:
            continue
        candidates.append((typ, year_of(name, row), name, dl))

    # De-duplicate URLs, and when requested retain only the newest survey year per type.
    seen = set()
    unique = []
    for c in sorted(candidates, key=lambda x: (x[0], -x[1], x[2])):
        if c[3] not in seen:
            seen.add(c[3]); unique.append(c)

    if args.latest_only:
        newest = {}
        for typ, year, _, _ in unique:
            newest[typ] = max(newest.get(typ, 0), year)
        unique = [c for c in unique if c[1] == newest.get(c[0], c[1]) or c[1] == 0]

    with open(args.manifest, "w", encoding="utf-8") as f:
        f.write("# Generated automatically from ELVIS for Central Coast NSW\n")
        for typ, year, name, dl in unique:
            f.write(f"{typ}|{dl}|\n")

    counts = {"dem": 0, "laz": 0}
    years = {"dem": set(), "laz": set()}
    for typ, year, _, _ in unique:
        counts[typ] += 1
        if year: years[typ].add(year)
    print(f"Usable DEM downloads: {counts['dem']} years={sorted(years['dem'])}")
    print(f"Usable point-cloud downloads: {counts['laz']} years={sorted(years['laz'])}")
    for typ, year, name, dl in unique[:20]:
        print(f"  {typ} {year or '-'} {name} -> {dl}")
    print(f"Generated manifest: {args.manifest}")

    if not unique:
        # Useful diagnostic without dumping the entire potentially huge response.
        print("No direct download rows recognised. Sample JSON structure:")
        print(json.dumps(data, indent=2)[:12000])
        return 2
    return 0

if __name__ == "__main__":
    sys.exit(main())
