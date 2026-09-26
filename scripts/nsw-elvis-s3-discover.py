#!/usr/bin/env python3
import argparse, json, sys, urllib.parse, urllib.request, xml.etree.ElementTree as ET

BUCKET = "https://nsw-elvis.s3-ap-southeast-2.amazonaws.com"


def list_objects(prefix, delimiter=None, continuation=None):
    params = {"list-type": "2", "prefix": prefix, "max-keys": "1000"}
    if delimiter:
        params["delimiter"] = delimiter
    if continuation:
        params["continuation-token"] = continuation
    url = BUCKET + "/?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "cchist-lidar-discovery/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        body = r.read()
        status = r.status
        ctype = r.headers.get("content-type", "")
    if status != 200:
        raise RuntimeError(f"S3 listing returned HTTP {status}")
    root = ET.fromstring(body)
    ns = {"s3": "http://s3.amazonaws.com/doc/2006-03-01/"}
    keys = [e.text for e in root.findall("s3:Contents/s3:Key", ns) if e.text]
    prefixes = [e.text for e in root.findall("s3:CommonPrefixes/s3:Prefix", ns) if e.text]
    truncated = (root.findtext("s3:IsTruncated", default="false", namespaces=ns).lower() == "true")
    nxt = root.findtext("s3:NextContinuationToken", default="", namespaces=ns)
    return {"url": url, "content_type": ctype, "keys": keys, "prefixes": prefixes, "truncated": truncated, "next": nxt}


def walk_prefix(prefix, limit_pages=200):
    out=[]; token=None
    for _ in range(limit_pages):
        page=list_objects(prefix, continuation=token)
        out.extend(page["keys"])
        if not page["truncated"] or not page["next"]:
            break
        token=page["next"]
    return out


def classify(keys):
    dem=[]; laz=[]; other=[]
    for k in keys:
        low=k.lower()
        # Avoid metadata/report files; only actual raster/archive payloads.
        is_meta = "/metadata/" in low or low.endswith((".html", ".htm", ".xml", ".pdf", ".txt", ".json", ".shp", ".dbf", ".shx", ".prj"))
        if not is_meta and low.endswith((".tif", ".tiff", ".asc", ".zip")) and ("1m-dem" in low or "/dem" in low or "dem_" in low):
            dem.append(k)
        elif not is_meta and low.endswith((".laz", ".las", ".zip")) and any(x in low for x in ("point-cloud", "pointcloud", "lidar", "/laz", "/las")):
            laz.append(k)
        else:
            other.append(k)
    return dem,laz,other


def depth(prefix):
    return len([x for x in prefix.split('/') if x])


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--survey", default="Gosford202008")
    ap.add_argument("--json", default="")
    ap.add_argument("--manifest", default="")
    ap.add_argument("--max-prefixes", type=int, default=200)
    args=ap.parse_args()

    result={"survey":args.survey,"bucket":BUCKET,"probes":{},"survey_prefixes":[],"survey_keys":[]}
    survey_lc=args.survey.lower()

    # Start from known and likely roots, then recursively follow relevant folder names.
    queue=[
        "elevation/",
        "elevation/1m-dem/",
        "elevation/1m-dem/z56/",
        f"elevation/1m-dem/z56/{args.survey}/",
        "elevation/point-cloud/",
        "elevation/pointcloud/",
        "elevation/lidar/",
        "elevation/laz/",
        "point-cloud/",
        "pointcloud/",
        "lidar/",
        "laz/",
    ]
    seen=set()
    survey_prefixes=set()
    interesting_terms=("1m-dem","point","cloud","lidar","laz","las","z56",survey_lc)

    while queue and len(seen) < args.max_prefixes:
        p=queue.pop(0)
        if p in seen: continue
        seen.add(p)
        try:
            page=list_objects(p, delimiter="/")
            result["probes"][p]={"prefixes":page["prefixes"],"keys":page["keys"][:50],"content_type":page["content_type"]}
            print(f"PROBE {p}: prefixes={len(page['prefixes'])} keys={len(page['keys'])}")
            for x in page["prefixes"][:60]: print("  PREFIX",x)
            for x in page["keys"][:20]: print("  KEY",x)

            if survey_lc in p.lower(): survey_prefixes.add(p)
            for child in page["prefixes"]:
                cl=child.lower()
                if survey_lc in cl:
                    survey_prefixes.add(child)
                # Traverse only a bounded number of relevant branches.
                if depth(child) <= 6 and any(t in cl for t in interesting_terms):
                    if child not in seen: queue.append(child)
        except Exception as e:
            result["probes"][p]={"error":str(e)}
            print(f"PROBE {p}: ERROR {e}")

    # Always include the exact known DEM prefix from the user's public metadata URL.
    survey_prefixes.add(f"elevation/1m-dem/z56/{args.survey}/")
    result["survey_prefixes"]=sorted(survey_prefixes)

    for p in sorted(survey_prefixes):
        try:
            keys=walk_prefix(p)
            result["survey_keys"].extend(keys)
            print(f"SURVEY {p}: {len(keys)} objects")
        except Exception as e:
            print(f"SURVEY {p}: ERROR {e}")

    keys=sorted(set(result["survey_keys"]))
    result["survey_keys"]=keys
    dem,laz,other=classify(keys)
    result["dem_keys"]=dem
    result["laz_keys"]=laz
    result["other_keys"]=other[:500]
    print(f"Classified: DEM={len(dem)} LAZ/LAS={len(laz)} OTHER={len(other)}")

    if args.manifest:
        with open(args.manifest,"w",encoding="utf-8") as f:
            f.write("# Auto-discovered NSW ELVIS S3 objects for %s\n" % args.survey)
            for k in dem:
                f.write(f"dem|{BUCKET}/{urllib.parse.quote(k, safe='/')}|\n")
            for k in laz:
                f.write(f"laz|{BUCKET}/{urllib.parse.quote(k, safe='/')}|\n")
        print(f"Manifest written: {args.manifest}")
    if args.json:
        with open(args.json,"w",encoding="utf-8") as f: json.dump(result,f,indent=2)
        print(f"JSON written: {args.json}")

    # Success means we could enumerate something useful from the public bucket.
    if dem or laz:
        return 0
    if any(info.get("prefixes") or info.get("keys") for info in result["probes"].values() if isinstance(info,dict)):
        return 4
    return 3

if __name__ == "__main__":
    sys.exit(main())
