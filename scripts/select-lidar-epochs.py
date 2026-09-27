#!/usr/bin/env python3
import json
import os
import re
import sys

root = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "/mnt/usb/stack/cchist/lidar")
raw = os.path.join(root, "raw")
working = os.path.join(root, "working")
epoch_dir = os.path.join(working, "dem-epochs")
laz_epoch_dir = os.path.join(working, "laz-epochs")
os.makedirs(epoch_dir, exist_ok=True)
os.makedirs(laz_epoch_dir, exist_ok=True)

for folder in (epoch_dir, laz_epoch_dir):
    for name in os.listdir(folder):
        p = os.path.join(folder, name)
        if os.path.isfile(p):
            os.unlink(p)

dems = []
clouds = []
for base, _, files in os.walk(raw):
    for fn in files:
        path = os.path.join(base, fn)
        low = fn.lower()
        if low.endswith((".tif", ".tiff")):
            dems.append(path)
        elif low.endswith((".laz", ".las")):
            clouds.append(path)

survey_rx = re.compile(r"(?P<place>[A-Za-z]+)(?P<date>20\d{4})-LID1", re.I)
tile_rx = re.compile(r"_(?P<tile>\d{7})_56_0002_0002(?:_1m)?\.(?:tif|tiff|laz|las)$", re.I)

def info(path):
    name = os.path.basename(path)
    sm = survey_rx.search(name)
    tm = tile_rx.search(name)
    return {
        "path": path,
        "year": int(sm.group("date")[:4]) if sm else None,
        "survey": sm.group("date") if sm else None,
        "place": sm.group("place") if sm else None,
        "tile": tm.group("tile") if tm else None,
        "one_m": bool(re.search(r"_1m\.(?:tif|tiff)$", name, re.I)),
    }

def container_path(path):
    return "/data/" + os.path.relpath(path, root).replace(os.sep, "/")

def newest_per_tile(items):
    selected = {}
    loose = []
    for item in items:
        if not item["tile"]:
            loose.append(item)
            continue
        cur = selected.get(item["tile"])
        rank = (item.get("survey") or "", item["path"])
        if cur is None or rank > (cur.get("survey") or "", cur["path"]):
            selected[item["tile"]] = item
    return [selected[k] for k in sorted(selected)], loose

dem_info = [info(p) for p in dems]
cloud_info = [info(p) for p in clouds]
one_m = [x for x in dem_info if x["one_m"] and x["year"]]

# Latest composite: newest 1 m survey for every ELVIS tile. Fall back to all DEMs
# only if no 1 m ELVIS tiles exist at all.
if one_m:
    latest, _ = newest_per_tile(one_m)
    mode = "latest-1m-per-tile"
else:
    latest = sorted(dem_info, key=lambda x: x["path"])
    mode = "fallback-all-dem"

with open(os.path.join(working, "dem-list.txt"), "w") as f:
    for item in latest:
        f.write(container_path(item["path"]) + "\n")

# Preserve each survey year independently. Multiple survey names in the same
# year (for example Gosford/Lake Macquarie) are allowed and simply mosaic.
years = sorted({x["year"] for x in one_m})
epochs = {}
for year in years:
    year_dems = [x for x in one_m if x["year"] == year]
    year_clouds = [x for x in cloud_info if x["year"] == year]
    # There should normally be one file per tile/year, but de-duplicate safely.
    year_dems, _ = newest_per_tile(year_dems)
    year_clouds, _ = newest_per_tile(year_clouds)
    dem_list = os.path.join(epoch_dir, f"{year}.txt")
    laz_list = os.path.join(laz_epoch_dir, f"{year}.txt")
    with open(dem_list, "w") as f:
        for item in year_dems:
            f.write(container_path(item["path"]) + "\n")
    with open(laz_list, "w") as f:
        for item in year_clouds:
            f.write(container_path(item["path"]) + "\n")
    epochs[str(year)] = {
        "demFiles": len(year_dems),
        "pointCloudFiles": len(year_clouds),
        "surveys": sorted({x["survey"] for x in year_dems + year_clouds if x["survey"]}),
    }

latest_clouds, _ = newest_per_tile([x for x in cloud_info if x["year"]])
with open(os.path.join(working, "laz-list.txt"), "w") as f:
    for item in latest_clouds:
        f.write(container_path(item["path"]) + "\n")

meta = {
    "mode": mode,
    "availableDemFiles": len(dems),
    "available1mDemFiles": len(one_m),
    "selectedDemFiles": len(latest),
    "availablePointCloudFiles": len(clouds),
    "selectedPointCloudFiles": len(latest_clouds),
    "epochs": epochs,
    "years": years,
    "latestYear": max(years) if years else None,
}
with open(os.path.join(working, "selection.json"), "w") as f:
    json.dump(meta, f, indent=2)

print(json.dumps(meta, indent=2))
