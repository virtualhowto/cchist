#!/usr/bin/env python3
"""Build a compact statewide NSW elevation/LiDAR survey catalogue from Spatial Services."""
import argparse
import json
import os
import re
import urllib.parse
import urllib.request
from datetime import datetime, timezone

SERVICES = [
    "https://beta.portal.spatial.nsw.gov.au/server/rest/services/Hosted/Spatial_Services_Elevation_Data_Index/FeatureServer/0",
    "https://alpha.portal.spatial.nsw.gov.au/server/rest/services/Hosted/Spatial_Services_Elevation_Data_Index/FeatureServer/0",
    "https://portal.spatial.nsw.gov.au/server/rest/services/Hosted/Spatial_Services_Elevation_Data_Index/FeatureServer/0",
]
ELVIS = "https://elevation.fsdf.org.au/"
FIELDS = [
    "OBJECTID", "project_name", "capture_start_date", "capture_end_date", "license",
    "metadata_filename", "horizontal_accuracy", "vertical_accuracy", "horizontal_datum",
    "vertical_datum", "zone", "epsg_code", "capture_device_name",
    "points_per_square_metre__ppsm_", "classification_level", "group_by_key",
    "areasqkm", "upload_date",
]


def get_json(url, params=None, timeout=60):
    if params:
        url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "history-research-map-nsw-elevation/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.load(response)


def find_service():
    errors = []
    for service in SERVICES:
        try:
            info = get_json(service, {"f": "json"})
            if info.get("name") or info.get("fields"):
                return service, info, errors
        except Exception as exc:
            errors.append(f"{service}: {exc}")
    raise RuntimeError("NSW elevation index service unavailable: " + "; ".join(errors))


def bbox_geometry(geometry):
    if not isinstance(geometry, dict):
        return None
    coords = geometry.get("coordinates")
    if coords is None:
        return None
    xs, ys = [], []

    def walk(node):
        if not isinstance(node, (list, tuple)):
            return
        if len(node) >= 2 and isinstance(node[0], (int, float)) and isinstance(node[1], (int, float)):
            xs.append(float(node[0])); ys.append(float(node[1])); return
        for child in node:
            walk(child)

    walk(coords)
    if not xs:
        return None
    return [min(xs), min(ys), max(xs), max(ys)]


def normalize_value(value):
    if value in (None, ""):
        return None
    return value


def year_from(props):
    for key in ("capture_start_date", "capture_end_date", "project_name", "group_by_key"):
        value = props.get(key)
        if value is None:
            continue
        match = re.search(r"\b(19\d{2}|20\d{2})\b", str(value))
        if match:
            return int(match.group(1))
    return None


def query_features(service, page_size=1000):
    offset = 0
    all_features = []
    while True:
        data = get_json(service.rstrip("/") + "/query", {
            "f": "geojson",
            "where": "1=1",
            "outFields": ",".join(FIELDS),
            "returnGeometry": "true",
            "outSR": "4326",
            "resultOffset": offset,
            "resultRecordCount": page_size,
            "orderByFields": "OBJECTID ASC",
        }, timeout=120)
        features = data.get("features") or []
        all_features.extend(features)
        if len(features) < page_size:
            break
        offset += len(features)
        if offset > 100000:
            raise RuntimeError("Refusing to paginate beyond 100000 elevation index features")
    return all_features


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    service, info, probe_errors = find_service()
    features = query_features(service)
    surveys = []
    for feature in features:
        props = feature.get("properties") or {}
        geometry = feature.get("geometry")
        bbox = bbox_geometry(geometry)
        if not bbox:
            continue
        surveys.append({
            "id": normalize_value(props.get("OBJECTID")) or normalize_value(feature.get("id")),
            "projectName": normalize_value(props.get("project_name")) or "NSW elevation survey",
            "captureStart": normalize_value(props.get("capture_start_date")),
            "captureEnd": normalize_value(props.get("capture_end_date")),
            "year": year_from(props),
            "license": normalize_value(props.get("license")),
            "metadataFilename": normalize_value(props.get("metadata_filename")),
            "horizontalAccuracy": normalize_value(props.get("horizontal_accuracy")),
            "verticalAccuracy": normalize_value(props.get("vertical_accuracy")),
            "horizontalDatum": normalize_value(props.get("horizontal_datum")),
            "verticalDatum": normalize_value(props.get("vertical_datum")),
            "zone": normalize_value(props.get("zone")),
            "epsgCode": normalize_value(props.get("epsg_code")),
            "captureDevice": normalize_value(props.get("capture_device_name")),
            "pointsPerSquareMetre": normalize_value(props.get("points_per_square_metre__ppsm_")),
            "classificationLevel": normalize_value(props.get("classification_level")),
            "groupKey": normalize_value(props.get("group_by_key")),
            "areaSqKm": normalize_value(props.get("areasqkm")),
            "uploadDate": normalize_value(props.get("upload_date")),
            "bbox": bbox,
            "geometry": geometry,
        })

    surveys.sort(key=lambda x: ((x.get("year") or 0), str(x.get("projectName") or ""), str(x.get("id") or "")))
    years = sorted({x["year"] for x in surveys if x.get("year")})
    output = {
        "updated": datetime.now(timezone.utc).isoformat(),
        "scope": "New South Wales",
        "source": "NSW Spatial Services Elevation Data Index",
        "serviceUrl": service,
        "elvisUrl": ELVIS,
        "serviceExtent": info.get("extent"),
        "featureCount": len(surveys),
        "years": years,
        "surveys": surveys,
        "probeErrors": probe_errors,
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(output, handle, indent=2)
    print(json.dumps({
        "service": service,
        "surveys": len(surveys),
        "yearRange": [years[0], years[-1]] if years else [],
    }, indent=2))


if __name__ == "__main__":
    main()
