# Backbone — the TideCast landing page

**Dive in:** one continuous, scroll-driven journey from orbit into the water nearest you.

| Scroll | What happens |
|---|---|
| 0–5% | Hero: a photoreal rotating Earth (NASA Blue Marble, night lights, relief, ocean glint, atmosphere) with fishing spots, routes, labels and your location pinging slowly. The page asks for your location on load (College Station until you allow it). |
| 5–22% | **Your water** — the globe turns to you and zooms in; a ping travels out from you to the nearest body of water, which lights up with its name and distance. |
| 22–47% | **Descent** — the camera dives straight down onto that water; satellite imagery (Sentinel-2, 10 m) sharpens from the region down to the lake. |
| 46–62% | **Your lake** — the same satellite picture becomes a live 3D lake (only the water moves) and the camera comes straight down to hover just above it, with ripples spreading out. |
| after | The page scrolls on over the lake: **How it works** (placeholder walkthrough frame, steps, placeholder leaderboard rules), then **By the numbers** (market, impact and model stats). |

The **leaderboard** is its own page, `leaderboard.html` (top anglers this week / all time, and the
points every species is worth).

Every story element of the journey is a function of the scroll position: stop anywhere and it holds;
scroll up and it reverses exactly. Only ambient motion keeps going on its own (globe spin, ping pulses,
water).

- **Leaderboard data:** `leaderboard.js`. **Points per species:** `fish-points.js` (placeholder values).
- **Stats:** `stats.js` — market figures are sourced; impact and model figures are placeholders
  (`value: null` shows "—"; set the number and `placeholder: false`).
- **How it works:** the walkthrough frame and the leaderboard rules in `index.html` (`#program`) are placeholders.
- **Default location / offline waters:** `waters.js`.
- **Spots near me** (pick a location, list nearby waters with fish and points) lives in the atlas
  (`../FishMigration/near-me.js`), not on this page.
- **Rendering:** one WebGL canvas (three.js 0.169, vendored); the globe and lake surface
  scenes render to separate layers that one compositor blends. The satellite image, its bounds and
  water mask are shared by the globe and the 3D lake.
- **Server routes it uses** (`../FishMigration/server.py`): `/api/water`, `/api/water/shape`
  (OpenStreetMap Overpass), `/api/reverse` (Photon), `/api/sat` (Esri World Imagery).

## Credits
- Earth textures: NASA Blue Marble / Black Marble via the `three-globe` examples.
- Satellite imagery (Lake Bryan / College Station): Copernicus Sentinel-2 L2A (2025-04-10, tiles 14RQU
  and 14RQV), from the AWS Open Data `sentinel-cogs` bucket; the water mask is from its NDWI.
  Contains modified Copernicus Sentinel data 2025. Other places: Esri World Imagery at runtime.
- Continental close-up (US South / Mexico, `continent.jpg`): ESA WorldCover 2021 Sentinel-2 cloud-free
  composite (© ESA WorldCover project 2021, CC BY 4.0), contains modified Copernicus Sentinel data 2021.
- Nearby waters: © OpenStreetMap contributors (ODbL), via the Overpass API.
- Water normal map: three.js examples (`waternormals.jpg`, MIT).

Served at `/backbone/` by `../FishMigration/server.py`; *Explore the waters* links to the atlas at `/`.
