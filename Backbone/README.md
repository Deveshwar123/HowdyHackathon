# Backbone — Tidecast + the Pelagic ocean atlas

Everything for the HowdyHackathon project lives in this folder.

## Run it

```bash
cd Backbone
python3 server.py
```
It opens the **Tidecast** landing page (`/tidecast/`). *Explore the waters* opens the atlas (`/`).

## Tidecast landing page (`tidecast/`)

- A photoreal, slowly rotating Earth (NASA Blue Marble day map, city lights on the night side,
  relief shading, ocean sun glint, thin procedural clouds, atmosphere glow) with glowing fishing
  spots, dashed migration routes, ocean labels and a *College Station, TX* pin.
- **Leaderboard** (nav link, the *This week's top catch* card, or scrolling down) plays the
  sequence: the Earth morphs into a water drop → the view follows it down into the lake → splash,
  ripples and a rebound jet → the leaderboard pops out of the rebound drop and lands on the leaf,
  which bends under it → a drop gathers on the leaf tip; **tap it** (or wait) and it falls, the
  leaf springs back and the full leaderboard rises. *Skip* jumps to the board; *Back to the globe*
  returns. Visitors who prefer reduced motion get the board directly.
- The lake is your photo, made live in WebGL: the leaf is cut out so it can bend, the water
  ripples, and the drops are rendered as refracting lenses of the real scene.
- **Leaderboard data:** edit `tidecast/leaderboard.js` (angler, species, measure, location, date,
  points, period). Rows are ranked by points.
- Assets: NASA imagery via the `three-globe` examples, three.js 0.169 and GSAP 3.13 are vendored
  in `tidecast/vendor/`, so the page works offline except for Google Fonts.

# Pelagic — A living ocean atlas

Interactive 3D globe of where fish have been recorded, layered with Global Fishing Watch data on
where fishing happens and where the ocean is protected.

## How it works: Where → What → Results

Nothing is drawn on the globe until you ask for it, and then only inside the areas you chose.

1. **Where** (left panel) — add one or more areas: click the ocean (choose a ¼°–5° box size; default 1° ≈ 111 km),
   pick a region (Eastern Tropical Pacific corridor / CMAR, Gulf of Mexico, Caribbean, Coral
   Triangle, …), or search a place or `lat, lon`. Each area gets a letter and colour.
   The selected area (the newest one, or any area you click on the map or in the list) opens a
   **Fish in this area** box on the map listing every fish species recorded inside it — click one
   to map it, or *Show every fish record here*.
2. **What** (left panel) — tick the data and set the dates:
   - **Fish (OBIS):** every fish species recorded in your areas (listed automatically), the 64
     field-guide species and groups, or any other species/genus/family. **One click on a fish**
     puts it on the map, highlights it in the list and opens its profile in a card on the map — no need
     to press Show. Click another fish to switch; untick to remove it.
     **Select all fish recorded in your areas** (under the instructions) ticks every species in
     the list, or only those matching the filter; untick it to clear them.
   - **Fishing activity (GFW 4Wings):** fishing effort, all vessel traffic, satellite radar (SAR)
     detections that reveal vessels with AIS switched off.
   - **Vessel events (GFW Events):** fishing, encounters (possible transshipment), loitering, port
     visits, AIS gaps.
   - **Boundaries (GFW):** marine protected areas, EEZs, high seas, tuna RFMOs.
3. **Show on map** — a results card on the map shows one section per area with only what you ticked: record
   counts, fishing hours by flag and gear, top vessels, traffic by type, likely dark vessels, event
   counts. A legend on the map lists what is drawn. There is no right-hand panel: the map uses the
   full width, and the results card (top-right of the map) opens when there is something to show and
   closes with ×.

The map switcher (bottom-right) picks **Satellite** (Esri World Imagery, high resolution), **Ocean**
(seafloor bathymetry) or **Simple**, with optional labels.

Click any dot or boundary on the map for details. Click a vessel (or use **Find a vessel** in the top-right corner of the map) for
its identity, owner, authorizations, risk insights (IUU listing, fishing in no-take MPAs, without
RFMO authorization, AIS turned off) and its last 12 months of events drawn on the globe.

## Running the atlas

`python3 server.py` (above) picks a free port (8790 or the next free one), prints the address and
opens the landing page; the atlas is at the site root.
On macOS you can instead double-click `start.command`. Needs Python 3 only, and
an internet connection for live data. The Global Fishing Watch API token is built into `server.py`
(this repo is private); the startup output says whether GFW accepts it.

Options (environment variables): `PORT` (default 8790), `PELAGIC_MAX_RECORDS` (records per species
query, default 5000; the globe stays smooth to about 20,000).

To use a different token, set the `GFW_TOKEN` environment variable or replace `BUILT_IN_GFW_TOKEN`
in `server.py`. Tokens come from https://globalfishingwatch.org/our-apis/tokens. If this repo is
ever made public, delete the built-in token on that page first.

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
