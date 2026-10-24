# Backbone — the TideCast landing page

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
- **Leaderboard data:** edit `leaderboard.js` (angler, species, measure, location, date,
  points, period). Rows are ranked by points.
- Assets: NASA imagery via the `three-globe` examples, three.js 0.169 and GSAP 3.13 are vendored
  in `vendor/`, so the page works offline except for Google Fonts.


Served at `/backbone/` by `../FishMigration/server.py`; *Explore the waters* links to the atlas at `/`.
