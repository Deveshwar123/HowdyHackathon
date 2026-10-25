# TideCast

Find your next great catch. Explore the waters. Learn what's biting. Make every catch count.

TideCast is one website with four parts, all in the same design and served by one Python server:

| Page | Where | What it does |
|---|---|---|
| **Home** | `/backbone/` | Scroll-driven 3D journey: the Earth → your location (asked for on load) → a dive onto the water nearest you → *How it works* → live stats |
| **Explore the waters** | `/` | The fish atlas: OBIS fish records and Global Fishing Watch fishing, vessels and protected areas on a 3D globe, plus **Spots near me** (nearby lakes, rivers and bays with the fish to target and their points) |
| **Log a catch** | `/backbone/catch.html` | Photo of your catch with your knuckles in view → AI identifies the species and traces the fish and your knuckles → length, weight (with an honest range) and points → post to the leaderboard. Every point can be dragged to correct it; without the AI you tap them yourself |
| **Leaderboard** | `/backbone/leaderboard.html` | This week / all time, by species, with catch photos, rarity and points |
| **Species & points** | `/backbone/species.html` | Field guide of the 30 species TideCast measures: how to recognize them, where they live, what they're worth |

## Run it

```bash
cd TideCast
python3 FishMigration/server.py
```
or double-click `start.command`. Python 3 only — nothing to install. It opens the home page.
One server runs everything: `FishMigration/server.py`.

**Turn on AI measuring:** get a free Gemini API key at https://aistudio.google.com/apikey, open
*Log a catch* and paste it into **Turn on automatic measuring** (it's checked with Google and saved
to `TideCast/.env`, which is never committed). Or create `TideCast/.env` yourself:

```
GEMINI_API_KEY=your-key-here
```

Without a key everything still works; on *Log a catch* anglers mark the snout, tail and knuckles
with four taps instead. The terminal says which mode is on when the server starts.

## Working on *Log a catch*

| To change… | Edit |
|---|---|
| The page (layout, text) | `Backbone/catch.html` |
| How the page behaves (upload, drawing the points, dragging, posting) | `Backbone/catch.js` |
| How it looks | `Backbone/catch.css` (shared colours, buttons, header: `Backbone/site.css`) |
| What the AI is asked and which models are used | `Catch/vision.py` |
| The measuring math (knuckle scale → length → weight) | `Catch/measure.py`, `Catch/knuckle_data.py` |
| Species and their length–weight constants | `Catch/fish_data.py` |
| Points | `Catch/scoring.py` |
| The API routes the page calls | `Catch/main.py` |

Restart the server after editing a `.py` file; for the page files, just reload the browser.

## Folders

| Folder | What it is |
|---|---|
| [`Backbone/`](Backbone/) | The site's design and pages: home journey, log a catch, leaderboard, species guide, shared header (`site.js`) and design system (`site.css`) |
| [`FishMigration/`](FishMigration/) | The atlas, and `server.py`, the one server for the whole site and all APIs |
| [`Catch/`](Catch/) | Catch measuring and the leaderboard database (from the `weight/leaderboard` branch): `vision.py` (Gemini), `measure.py` (knuckle scale → length → weight), `fish_data.py` (species, length–weight curves), `knuckle_data.py`, `scoring.py` (points), `db.py` (SQLite), `main.py` (the API) |

## How a catch is measured

1. The browser rotates the photo upright, shrinks it to 1024 px and uploads it.
2. Gemini returns the species, six points along the fish from snout to tail, and two knuckle spans
   (index–pinky and middle–pinky) on a 1000 × 1000 grid.
3. Each knuckle span is a ruler: average widths (8.4 / 5.6 cm men, 7.4 / 4.8 cm women) or the
   angler's own measurement. The fish's length is measured along its curve against each ruler, and
   the median is kept.
4. Weight = a × length^b with the species' own constants; the range combines the length error and
   natural plumpness spread.
5. Points = rarity (50–600) + 10 per pound + 150 for a trophy (longer than typical). Lengths past
   a species' record are rejected; the same photo can't be posted twice.

The server recomputes the measurement from the points on every edit and again on posting, so the
numbers in the browser can't be inflated.
