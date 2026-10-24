# Backbone — the TideCast landing page

**Follow the Ping:** one continuous, scroll-driven journey from orbit into a lake.

| Scroll | What happens |
|---|---|
| 0–5% | Hero: a photoreal rotating Earth (NASA Blue Marble, night lights, relief, ocean glint, clouds, atmosphere) with fishing spots, routes, labels and the College Station pin. The headline lifts away as you scroll. |
| 5–22% | **Signal** — the globe turns to Texas and pulls back; a tagged fish pings from Lake Somerville and a sonar wave spreads across the map. |
| 22–47% | **Descent** — the camera dives toward the ping, turning slowly; real Sentinel-2 satellite imagery (10 m) sharpens from the region down to the lake, then the camera passes through a cloud deck. |
| 46–64% | **Surface** — below the clouds: live lake water. The ping lands as a sonar ring and becomes ripples; the camera drops to the water and tilts to the horizon. |
| 62–76% | **Waterline** — the lake at eye level (leaf, bokeh, ripples); the lens sinks half under, then fully under. |
| 72–88% | **Beneath** — photoscanned fish swim through murky lake water with caustics and light shafts; tagged fish emit ping rings and draw their tracks as you scroll. |
| 86–100% | **Leaderboard** — rises from beneath, breaks the surface (tinted while underwater) and settles in place. |

Every story element is a function of the scroll position: stop anywhere and it holds; scroll up and it
reverses exactly. Only ambient motion keeps going on its own (globe spin, water, swimming fish, leaf
sway). The chapter dots (right) and the *Leaderboard* / *Back to the globe* buttons just scroll the page.

- **Leaderboard data:** edit `leaderboard.js` (angler, species, measure, location, date, points, period).
- **Rendering:** one WebGL canvas (three.js 0.169, vendored); the globe, lake surface, eye-level lake and
  underwater scenes render to separate layers that one compositor blends (clouds, waterline, vignette).

## Credits
- Earth textures: NASA Blue Marble / Black Marble via the `three-globe` examples.
- Satellite imagery: Copernicus Sentinel-2 L2A (2025-04-10, tile 14RQU), from the AWS Open Data
  `sentinel-cogs` bucket. Contains modified Copernicus Sentinel data 2025.
- Fish: *Barramundi Fish* from the Khronos glTF Sample Assets (CC0).
- Water normal map: three.js examples (`waternormals.jpg`, MIT).
- Lake photo: supplied by the team.

Served at `/backbone/` by `../FishMigration/server.py`; *Explore the waters* links to the atlas at `/`.
