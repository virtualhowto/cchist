#!/usr/bin/env python3
"""Build a compact statewide NSW elevation/LiDAR survey catalogue from Spatial Services."""
import argparse
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

SERVICES = [
    "https://beta.portal.spatial.nsw.gov.au/server/rest/services/Hosted/Spatial_Services_Elevation_Data_Index/FeatureServer/0",
    "https://alpha.portal.spatial.nsw.gov.au/server/rest/services/Hosted/Spatial_Services_Elevation_Data_Index/FeatureServer/0",
    "https://portal.spatial.nsw.gov.au/server/rest/services/Hosted/Spatial_Services_Elevation_Data_Index/FeatureServer/0",
]
ELVIS = "https://elevation.fsdf.org.au/"


def get_json(url, params=None, timeout=60):
    if params:
        url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "history-research-map-nsw-elevation/1.1"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        body = ""
        try:
            body = exc.read().decode("utf-8", "replace")[:1200]
        except Exception:
            pass
        raise RuntimeError(f"HTTP {exc.code} from {url}: {body}") from exc


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


def norm_key(value):
    return re.sub(r"[^a-z0-9]+", "", str(value or "").lower())


def prop(props, *candidates):
    lookup = {norm_key(k): v for k, v in (props or {}).items()}
    for candidate in candidates:
        key = norm_key(candidate)
        if key in lookup and lookup[key] not in (None, ""):
            return lookup[key]
    return None


def arcgis_geometry_to_geojson(geometry):
    if not isinstance(geometry, dict):
        return None
    if "rings" in geometry:
        rings = geometry.get("rings") or []
        return {"type": "Polygon", "coordinates": rings}
    if "paths" in geometry:
        return {"type": "MultiLineString", "coordinates": geometry.get("paths") or []}
    if "x" in geometry and "y" in geometry:
        return {"type": "Point", "coordinates": [geometry.get("x"), geometry.get("y")]}
    return None


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
    return None if value in (None, "") else value


def date_text(value):
    if value in (None, ""):
        return None
    if isinstance(value, (int, float)):
        try:
            seconds = float(value) / 1000.0 if abs(float(value)) > 10_000_000_000 else float(value)
            return datetime.fromtimestamp(seconds, tz=timezone.utc).date().isoformat()
        except Exception:
            return str(value)
    return str(value)


def year_from(props):
    for value in (
        prop(props, "capture_start_date", "capture start date", "capturestartdate", "start_date", "startdate"),
        prop(props, "capture_end_date", "capture end date", "captureenddate", "end_date", "enddate"),
        prop(props, "project_name", "project name", "projectname", "project"),
        prop(props, "group_by_key", "group by key", "groupbykey"),
    ):
        if value in (None, ""):
            continue
        if isinstance(value, (int, float)):
            try:
                seconds = float(value) / 1000.0 if abs(float(value)) > 10_000_000_000 else float(value)
                year = datetime.fromtimestamp(seconds, tz=timezone.utc).year
                if 1900 <= year <= datetime.now(timezone.utc).year + 1:
                    return year
            except Exception:
                pass
        match = re.search(r"\b(19\d{2}|20\d{2})\b", str(value))
        if match:
            return int(match.group(1))
    return None


def query_geojson(service, params):
    data = get_json(service.rstrip("/") + "/query", {**params, "f": "geojson"}, timeout=120)
    features = data.get("features")
    if not isinstance(features, list):
        raise RuntimeError(f"GeoJSON query did not return features: {str(data)[:800]}")
    return features


def query_arcgis_json(service, params):
    data = get_json(service.rstrip("/") + "/query", {**params, "f": "json"}, timeout=120)
    raw = data.get("features")
    if not isinstance(raw, list):
        raise RuntimeError(f"ArcGIS JSON query did not return features: {str(data)[:800]}")
    result = []
    for item in raw:
        result.append({
            "type": "Feature",
            "properties": item.get("attributes") or {},
            "geometry": arcgis_geometry_to_geojson(item.get("geometry")),
        })
    return result


def query_batch(service, params):
    try:
        return query_geojson(service, params)
    except Exception as first:
        try:
            return query_arcgis_json(service, params)
        except Exception as second:
            raise RuntimeError(f"GeoJSON query failed ({first}); JSON fallback failed ({second})") from second


def query_features(service, info, batch_size=200):
    oid_field = info.get("objectIdField") or info.get("objectIdFieldName")
    try:
        ids = get_json(service.rstrip("/") + "/query", {
            "f": "json",
            "where": "1=1",
            "returnIdsOnly": "true",
        }, timeout=120)
        oid_field = ids.get("objectIdFieldName") or oid_field
        object_ids = sorted(set(ids.get("objectIds") or []))
    except Exception:
        object_ids = []

    base = {
        "outFields": "*",
        "returnGeometry": "true",
        "outSR": "4326",
    }
    all_features = []
    if object_ids:
        for offset in range(0, len(object_ids), batch_size):
            chunk = object_ids[offset:offset + batch_size]
            all_features.extend(query_batch(service, {**base, "objectIds": ",".join(map(str, chunk))}))
        return all_features, oid_field

    # Fallback for services that disable returnIdsOnly.
    offset = 0
    page_size = min(int(info.get("maxRecordCount") or 500), 1000)
    while True:
        features = query_batch(service, {
            **base,
            "where": "1=1",
            "resultOffset": offset,
            "resultRecordCount": page_size,
        })
        all_features.extend(features)
        if len(features) < page_size:
            break
        offset += len(features)
        if offset > 100000:
            raise RuntimeError("Refusing to paginate beyond 100000 elevation index features")
    return all_features, oid_field


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    service, info, probe_errors = find_service()
    features, oid_field = query_features(service, info)
    surveys = []
    discovered_fields = set()
    for feature in features:
        props = feature.get("properties") or {}
        discovered_fields.update(props.keys())
        geometry = feature.get("geometry")
        bbox = bbox_geometry(geometry)
        if not bbox:
            continue
        identifier = prop(props, oid_field or "OBJECTID", "OBJECTID", "objectid", "fid") or feature.get("id")
        surveys.append({
            "id": normalize_value(identifier),
            "projectName": normalize_value(prop(props, "project_name", "project name", "projectname", "project", "name")) or "NSW elevation survey",
            "captureStart": date_text(prop(props, "capture_start_date", "capture start date", "capturestartdate", "start_date", "startdate")),
            "captureEnd": date_text(prop(props, "capture_end_date", "capture end date", "captureenddate", "end_date", "enddate")),
            "year": year_from(props),
            "license": normalize_value(prop(props, "license", "licence")),
            "metadataFilename": normalize_value(prop(props, "metadata_filename", "metadata filename", "metadatafilename", "metadata")),
            "horizontalAccuracy": normalize_value(prop(props, "horizontal_accuracy", "horizontal accuracy", "horizontalaccuracy")),
            "verticalAccuracy": normalize_value(prop(props, "vertical_accuracy", "vertical accuracy", "verticalaccuracy")),
            "horizontalDatum": normalize_value(prop(props, "horizontal_datum", "horizontal datum", "horizontaldatum")),
            "verticalDatum": normalize_value(prop(props, "vertical_datum", "vertical datum", "verticaldatum")),
            "zone": normalize_value(prop(props, "zone", "utm_zone", "utmzone")),
            "epsgCode": normalize_value(prop(props, "epsg_code", "epsg code", "epsgcode", "epsg")),
            "captureDevice": normalize_value(prop(props, "capture_device_name", "capture device name", "capturedevicename", "sensor")),
            "pointsPerSquareMetre": normalize_value(prop(props, "points_per_square_metre__ppsm_", "points per square metre", "points per square meter", "ppsm", "point_density", "pointdensity")),
            "classificationLevel": normalize_value(prop(props, "classification_level", "classification level", "classificationlevel")),
            "groupKey": normalize_value(prop(props, "group_by_key", "group by key", "groupbykey")),
            "areaSqKm": normalize_value(prop(props, "areasqkm", "area_sq_km", "area sq km", "area")),
            "uploadDate": date_text(prop(props, "upload_date", "upload date", "uploaddate")),
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
        "serviceFields": sorted(discovered_fields),
        "probeErrors": probe_errors,
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(output, handle, indent=2)
    print(json.dumps({
        "service": service,
        "surveys": len(surveys),
        "yearRange": [years[0], years[-1]] if years else [],
        "fields": sorted(discovered_fields),
    }, indent=2))


if __name__ == "__main__":
    main()
