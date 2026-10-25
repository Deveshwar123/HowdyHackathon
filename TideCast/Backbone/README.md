# Backbone — the TideCast landing page

**Dive in:** one continuous, scroll-driven journey from orbit into the water nearest you.

| Scroll | What happens |
|---|---|
| 0–5% | Hero: a photoreal rotating Earth (NASA Blue Marble, night lights, relief, ocean glint, atmosphere) with fishing spots, routes, labels and your location pinging slowly. The headline lifts away as you scroll. |
| 5–22% | **Your water** — the globe turns to you (College Station until you share your location) and zooms in; a ping travels out from you to the nearest body of water, which lights up. |
| 22–47% | **Descent** — the camera dives onto that water, turning slowly; satellite imagery (Sentinel-2, 10 m) sharpens from the region down to the lake. |
| 46–70% | **Surface** — the same satellite picture becomes a live 3D lake: only the water (from a water mask) starts to move, brightening as the camera drops to it and tilts to the horizon. |
| 64–76% | **Waterline** — the lens sinks half under, then fully under. |
| 72–88% | **Beneath** — fish swim through clear blue water with caustics and warm shafts of sunlight; every so often a hook drops in, a fish takes it and is reeled out (with the points it's worth). |
| 86–100% | **Leaderboard** — rises through the water and settles in front of the fish. |

Every story element is a function of the scroll position: stop anywhere and it holds; scroll up and it
reverses exactly. Only ambient motion keeps going on its own (globe spin, ping pulses, water, swimming
fish, the hook). The chapter dots (right) and the *Leaderboard* / *Back to the globe* buttons just scroll the page.

**Spots around you** (bottom left): *Find my location* asks the browser for your location, finds the
named lakes, reservoirs and bays around you (OpenStreetMap, via the server), and lists them with
distance and the fish to go for, with their points. The nearest one becomes the dive; click any spot
to dive there instead. Without a location it uses College Station and the built-in list in `waters.js`.

- **Leaderboard data:** edit `leaderboard.js` (angler, species, measure, location, date, points, period).
- **Points per species:** edit `fish-points.js` (placeholder values until the scoring rules are set).
- **Default location / offline spots:** edit `waters.js`.
- **Rendering:** one WebGL canvas (three.js 0.169, vendored); the globe, lake surface and underwater
  scenes render to separate layers that one compositor blends (waterline, vignette). The satellite
  image, its bounds and water mask are shared by the globe and the 3D lake, so the picture carries
  through from orbit to the water.
- **Server routes it uses** (`../FishMigration/server.py`): `/api/water` and `/api/water/shape`
  (OpenStreetMap Overpass), `/api/reverse` (Photon place names), `/api/sat` (Esri World Imagery for
  waters without built-in imagery).

## Credits
- Earth textures: NASA Blue Marble / Black Marble via the `three-globe` examples.
- Satellite imagery (Lake Bryan / College Station): Copernicus Sentinel-2 L2A (2025-04-10, tiles 14RQU
  and 14RQV), from the AWS Open Data `sentinel-cogs` bucket; the water mask is from its NDWI.
  Contains modified Copernicus Sentinel data 2025. Other places: Esri World Imagery at runtime.
- Nearby waters: © OpenStreetMap contributors (ODbL), via the Overpass API.
- Fish: *Barramundi Fish* from the Khronos glTF Sample Assets (CC0), as glTF in `assets/fish/`.
- Water normal map: three.js examples (`waternormals.jpg`, MIT).

Served at `/backbone/` by `../FishMigration/server.py`; *Explore the waters* links to the atlas at `/`.
