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


def walk_prefix(prefix, limit_pages=20):
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
        if low.endswith((".tif", ".tiff", ".asc", ".zip")) and ("1m-dem" in low or "dem" in low):
            dem.append(k)
        elif low.endswith((".laz", ".las", ".zip")) and any(x in low for x in ("point", "lidar", "laz", "las")):
            laz.append(k)
        else:
            other.append(k)
    return dem,laz,other


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--survey", default="Gosford202008")
    ap.add_argument("--json", default="")
    ap.add_argument("--manifest", default="")
    args=ap.parse_args()

    probes = [
        "elevation/",
        "elevation/1m-dem/",
        "elevation/1m-dem/z56/",
        f"elevation/1m-dem/z56/{args.survey}/",
        "elevation/point-cloud/",
        "elevation/pointcloud/",
        "elevation/lidar/",
        "point-cloud/",
        "lidar/",
    ]
    result={"survey":args.survey,"bucket":BUCKET,"probes":{},"survey_keys":[]}
    all_keys=[]
    for p in probes:
        try:
            page=list_objects(p, delimiter="/")
            result["probes"][p]={"prefixes":page["prefixes"],"keys":page["keys"][:50],"content_type":page["content_type"]}
            print(f"PROBE {p}: prefixes={len(page['prefixes'])} keys={len(page['keys'])}")
            for x in page["prefixes"][:50]: print("  PREFIX",x)
            for x in page["keys"][:20]: print("  KEY",x)
        except Exception as e:
            result["probes"][p]={"error":str(e)}
            print(f"PROBE {p}: ERROR {e}")

    # Known DEM survey prefix from the public metadata URL.
    known=f"elevation/1m-dem/z56/{args.survey}/"
    try:
        keys=walk_prefix(known)
        all_keys.extend(keys)
        result["survey_keys"].extend(keys)
        print(f"SURVEY {known}: {len(keys)} objects")
    except Exception as e:
        print(f"SURVEY {known}: ERROR {e}")

    # Any discovered prefix containing the survey name is worth walking.
    discovered=set()
    for p,info in result["probes"].items():
        for x in info.get("prefixes",[]):
            if args.survey.lower() in x.lower(): discovered.add(x)
    for p in sorted(discovered):
        if p == known: continue
        try:
            keys=walk_prefix(p)
            all_keys.extend(keys)
            result["survey_keys"].extend(keys)
            print(f"SURVEY {p}: {len(keys)} objects")
        except Exception as e:
            print(f"SURVEY {p}: ERROR {e}")

    # De-duplicate and classify.
    keys=sorted(set(result["survey_keys"]))
    result["survey_keys"]=keys
    dem,laz,other=classify(keys)
    result["dem_keys"]=dem
    result["laz_keys"]=laz
    print(f"Classified: DEM={len(dem)} LAZ/LAS={len(laz)} OTHER={len(other)}")

    if args.manifest:
        with open(args.manifest,"w",encoding="utf-8") as f:
            f.write("# Auto-discovered NSW ELVIS S3 objects\n")
            for k in dem:
                f.write(f"dem|{BUCKET}/{urllib.parse.quote(k, safe='/')}|\n")
            for k in laz:
                f.write(f"laz|{BUCKET}/{urllib.parse.quote(k, safe='/')}|\n")
        print(f"Manifest written: {args.manifest}")
    if args.json:
        with open(args.json,"w",encoding="utf-8") as f: json.dump(result,f,indent=2)
        print(f"JSON written: {args.json}")

    # Discovery is considered useful if the bucket can be enumerated, even if
    # point-cloud paths need a second probe after we see the actual prefixes.
    if not result["probes"].get("elevation/",{}).get("prefixes") and not keys:
        return 3
    return 0

if __name__ == "__main__":
    sys.exit(main())
