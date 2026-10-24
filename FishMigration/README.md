# Pelagic — A living ocean atlas (FishMigration)

Interactive 3D globe showing where seven marine species have been observed (bluefin tuna, whale shark, great white, mahi-mahi, clownfish, blue shark, red snapper).

## Run it

```bash
cd FishMigration
python3 -m http.server 8765
```
Then open http://localhost:8765 (or double-click `start.command` on macOS).

## What's here
- `index.html`, `_next/` — the app (built React front end)
- `cesium/` — CesiumJS globe library + Natural Earth II textures
- `data/*.json` — saved OBIS observation samples per species (used offline)
- `data/api-observations/` — cached observation API responses

## Data source
Species observations come from [OBIS](https://obis.org) (Ocean Biodiversity Information System). Place search used an OpenStreetMap/Photon server route that isn't included; offline it matches the built-in ocean regions.
