# Pelagic — A living ocean atlas (FishMigration)

Interactive 3D globe of where fish have been recorded, layered with Global Fishing Watch data on
where fishing happens and where the ocean is protected.

- **64 species & groups** in the field guide (tunas, billfish, sharks, rays, reef fish, cod, salmon,
  deep-sea fish) plus whole-group entries — *all ray-finned fish*, *all sharks & rays*, *tunas &
  mackerels*, *groupers* — that pull every matching record in OBIS.
- **Live OBIS records**: up to 5,000 points per species per query (the old offline sample had 180).
- **Plot any species**: type any species, genus or family into the Fishing Watch panel, or click an
  area and pick from every fish species OBIS has recorded there.
- **All fish density layer**: every ray-finned fish, shark and ray record in OBIS as a heatmap.
- **Global Fishing Watch** (the Marine Manager map): apparent fishing effort, marine protected
  areas, EEZs, high seas and RFMO boundaries; click an area for fishing hours by vessel flag and
  individual fishing events (click an orange dot for the vessel). The *Eastern Tropical Pacific
  corridor* button opens the CMAR core-MPA view from the Marine Manager link (25 Jul – 23 Oct 2026).

## Run it

```bash
cd FishMigration
echo "GFW_TOKEN=<your Global Fishing Watch API token>" > .env   # once; .env is git-ignored
python3 server.py
```
It picks a free port (8790 or the next free one), prints the address and opens it in your browser.
On macOS you can instead double-click `start.command`. Needs Python 3 only, and
an internet connection for live data. Without a token everything except the GFW layers still works.

Options (environment variables): `PORT` (default 8790), `PELAGIC_MAX_RECORDS` (records per species
query, default 5000; the globe stays smooth to about 20,000).

Do not commit the token — it is tied to your GFW account. Get one at
https://globalfishingwatch.org/our-apis/tokens.

## What's here
- `index.html`, `_next/` — the app (built React front end; no source in this repo)
- `species.js` — the field guide. Add a species by appending an entry, then run
  `python3 tools/patch_bundle.py` to refresh the pre-rendered sidebar in `index.html`
- `pelagic-gfw.js`, `pelagic-gfw.css` — the Global Fishing Watch / OBIS panel and globe layers
- `server.py` — static server plus the API routes the app calls (`/api/observations`,
  `/api/places`) and proxies for OBIS and GFW (keeps the GFW token off the browser)
- `tools/patch_bundle.py` — the edits applied to the built bundle (idempotent)
- `cesium/` — CesiumJS globe library + Natural Earth II textures
- `data/*.json` — cached OBIS samples per species; missing ones are fetched and saved on first run

## Data sources
- Fish records: [OBIS](https://obis.org) (Ocean Biodiversity Information System).
- Fishing activity, events, MPAs, EEZs, RFMOs: [Global Fishing Watch](https://globalfishingwatch.org)
  API v3 (CC BY-NC 4.0). Apparent fishing effort is derived from AIS and does not include vessels
  that don't broadcast AIS.
- Place search: [Photon](https://photon.komoot.io) / OpenStreetMap.
