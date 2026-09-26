#!/usr/bin/env python3
import argparse, html.parser, json, os, re, sys, urllib.error, urllib.parse, urllib.request

DEFAULT_METADATA = "https://nsw-elvis.s3-ap-southeast-2.amazonaws.com/elevation/1m-dem/z56/Gosford202008/metadata/Gosford202008-LID1-AHD_3546308_56_0002_0002_1m.html"

class LinkParser(html.parser.HTMLParser):
    def __init__(self):
        super().__init__(); self.links=[]
    def handle_starttag(self, tag, attrs):
        for k,v in attrs:
            if k.lower() in ("href","src") and v: self.links.append(v)

def fetch(url, method="GET", headers=None, timeout=30):
    req=urllib.request.Request(url, method=method, headers={"User-Agent":"cchist-elvis-probe/1.0", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data=r.read() if method=="GET" else b""
            return {"ok":True,"status":r.status,"url":r.geturl(),"headers":dict(r.headers.items()),"data":data}
    except urllib.error.HTTPError as e:
        body=b""
        try: body=e.read(4096)
        except Exception: pass
        return {"ok":False,"status":e.code,"url":url,"headers":dict(e.headers.items()) if e.headers else {},"data":body}
    except Exception as e:
        return {"ok":False,"status":0,"url":url,"headers":{},"data":str(e).encode()}

def exists(url):
    r=fetch(url,"HEAD",timeout=20)
    if r["status"] in (200,206): return r
    # Some S3/object gateways do not honour HEAD consistently; range GET is tiny.
    r=fetch(url,"GET",{"Range":"bytes=0-0"},timeout=20)
    return r

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--metadata-url",default=DEFAULT_METADATA)
    ap.add_argument("--json",default="")
    ap.add_argument("--manifest",default="")
    args=ap.parse_args()

    meta=fetch(args.metadata_url)
    if not meta["ok"]:
        print(f"Metadata fetch failed HTTP {meta['status']}: {args.metadata_url}")
        return 2
    text=meta["data"].decode("utf-8","replace")
    print(f"Metadata HTTP {meta['status']} bytes={len(meta['data'])} type={meta['headers'].get('Content-Type','')}")

    parser=LinkParser(); parser.feed(text)
    links=[]
    for x in parser.links:
        links.append(urllib.parse.urljoin(args.metadata_url,x))

    # Pull anything that looks like a data filename/path from text, scripts, or table values.
    token_rx=re.compile(r'''(?i)(?:https?://[^\s"'<>]+|[A-Za-z0-9_./%+\-]+\.(?:tif|tiff|asc|zip|laz|las|xyz|dem|html?))''')
    tokens=[m.group(0) for m in token_rx.finditer(text)]
    for t in tokens:
        if t.lower().startswith(("http://","https://")): links.append(t)
        else: links.append(urllib.parse.urljoin(args.metadata_url,t))

    parsed=urllib.parse.urlparse(args.metadata_url)
    base_name=os.path.basename(parsed.path)
    stem=re.sub(r'\.html?$', '', base_name, flags=re.I)
    survey_root=args.metadata_url.rsplit('/metadata/',1)[0]+'/'

    candidates=set(links)
    # Likely sibling layouts used by static ELVIS exports.
    dirs=[survey_root, survey_root+'data/', survey_root+'dem/', survey_root+'raster/', survey_root+'geotiff/', survey_root+'tif/', survey_root+'tiles/']
    stems={stem, stem.replace('_1m',''), stem.replace('-LID1-','-DEM1-')}
    for d in dirs:
        for s in stems:
            for ext in ('.tif','.tiff','.zip','.asc','.laz','.las'):
                candidates.add(d+s+ext)

    # Also probe filenames explicitly printed in metadata, preserving only likely payloads.
    for t in tokens:
        low=t.lower()
        if low.endswith(('.tif','.tiff','.zip','.asc','.laz','.las')):
            candidates.add(urllib.parse.urljoin(args.metadata_url,t))

    results=[]; found=[]
    for url in sorted(candidates):
        if not url.startswith('http'): continue
        # Avoid crawling ordinary HTML/navigation/assets except the known metadata itself.
        if not re.search(r'(?i)\.(tif|tiff|zip|asc|laz|las)(?:\?|$)',url): continue
        r=exists(url)
        size=r['headers'].get('Content-Length','')
        ctype=r['headers'].get('Content-Type','')
        item={"url":url,"status":r['status'],"ok":r['status'] in (200,206),"size":size,"content_type":ctype}
        results.append(item)
        print(f"PROBE {r['status']} size={size or '?'} type={ctype or '?'} {url}")
        if item['ok']: found.append(item)

    # Save metadata text for diagnostics, but don't dump it into logs.
    out={"metadata_url":args.metadata_url,"metadata_bytes":len(meta['data']),"survey_root":survey_root,"extracted_links":sorted(set(links)),"probes":results,"found":found}
    if args.json:
        with open(args.json,'w',encoding='utf-8') as f: json.dump(out,f,indent=2)
        txt=os.path.splitext(args.json)[0]+'-metadata.html'
        with open(txt,'w',encoding='utf-8') as f: f.write(text)
    if args.manifest:
        with open(args.manifest,'w',encoding='utf-8') as f:
            f.write('# NSW ELVIS objects discovered from known Gosford202008 metadata\n')
            for it in found:
                low=urllib.parse.urlparse(it['url']).path.lower()
                typ='laz' if low.endswith(('.laz','.las')) or 'point' in low or 'lidar' in low and not low.endswith(('.tif','.tiff','.asc')) else 'dem'
                f.write(f"{typ}|{it['url']}|\n")
        print(f"Manifest written: {args.manifest} entries={len(found)}")

    # Print likely embedded source/object references for diagnosis.
    refs=sorted(set(x for x in tokens if re.search(r'(?i)(gosford|\.tif|\.zip|\.laz|\.las|lidar|dem)',x)))
    print('Metadata references:')
    for x in refs[:150]: print('  ',x)
    print(f"Found downloadable candidates: {len(found)}")
    return 0 if found else 4

if __name__=='__main__':
    sys.exit(main())
