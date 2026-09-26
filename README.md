# Central Coast History Map

Research-first interactive map of historic properties, parks, reserves, swimming/bathing places, fishing spots, fairs, holiday destinations and other gathering places on the NSW Central Coast.

Production hostname: **https://cchist.virtualhowto.com**

## Mobile-first UI

The map is designed for phones as well as desktop. On small screens the map remains full-height while filters, search, source material and place cards live in a touch-friendly bottom sheet.

## Docker

```bash
git clone https://github.com/virtualhowto/cchist.git
cd cchist
docker compose up -d --build
```

The compose file expects an existing external Docker network named `t3_proxy` and a Traefik router accepting `websecure`.

## Data

- `data/places.json` — historical places and gathering locations
- `data/historic-maps.json` — historical map/plan references

Each location contains a date/year, category, coordinates, location confidence, history, period search terms and source links. Approximate locations are deliberately labelled until primary-source research can establish the historical footprint.

## Research roadmap

Search Trove, NSW gazettes, parish maps and subdivision plans for period terminology including picnic ground, pleasure ground, bathing place, swimming hole, baths, fishing ground, anglers outing, camping reserve, tourist camp, regatta, showground, racecourse, market day, holiday resort, excursion train, steamer excursion, dance hall, picture hall, guest house, wharf and jetty.

Planned features include marker clustering, historical-map overlays with opacity control, Then/Now comparison, deep-linked place records, image/newspaper clipping support, GeoJSON/CSV exports and an authenticated research/admin workflow.
