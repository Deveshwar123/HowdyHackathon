# Catch — measure a fish from a photo, score it, rank it

The photo-measuring app from the `weight/leaderboard` branch, now part of TideCast. It runs inside
`../FishMigration/server.py` (standard library only — the FastAPI / Gemini SDK / Pillow version
is no longer needed, see `requirements.txt`).

| File | What it does |
|---|---|
| `main.py` | The API handlers: upload, analyze, measure (for edited points), submit, leaderboard, species, stats |
| `vision.py` | Gemini (REST): species, 6 spine points, 4- and 3-knuckle spans, same prompt and schema as before |
| `measure.py` | Knuckle span → cm per pixel → fish length (median over references) → weight and range |
| `fish_data.py` | The 30 species: length range, record length, length–weight constants, rarity, how to recognize them |
| `knuckle_data.py` | Average knuckle widths |
| `scoring.py` | Points: rarity + 10/lb + trophy bonus; the species table for the site |
| `db.py` | SQLite (`fish.db`): catches, duplicate photos, rankings, live stats |
| `samples.json` | Demo leaderboard rows for a fresh install (marked *sample*; `TIDECAST_SAMPLES=0` turns them off) |

Photos of posted catches are kept in `photos/` and shown on the leaderboard; unposted uploads are
deleted after two days. `fish.db`, `photos/` and `.env` are not committed.

Settings: `GEMINI_API_KEY` (or `TideCast/.env`), `TIDECAST_DB` (database path), `TIDECAST_SAMPLES=0`,
`GEMINI_URL` (testing). `MOCK_MODE` in `vision.py` returns fixed points without calling Gemini.

## Learned length model (optional)

`fish_length/` is a DINOv2 + AutoML model that predicts a fish's length straight from the photo.
When it's installed, every catch is measured and scored from the model's length (the knuckle marks
become a cross-check), and the home page's "The model" numbers come from its test results.

The model and its trained files come from
[fishsizeproject/fish-length-predictor](https://github.com/fishsizeproject/fish-length-predictor)
(MIT, see `fish_length/LICENSE`); it was trained on 2,148 fish photos of 10–80 cm. The trained
files are already in `fish_length/artifacts/`.

1. Click **Install the length model** on the Log a catch page, or run
   `pip3 install -r TideCast/Catch/requirements-model.txt`.
2. Restart the server. The first catch downloads DINOv2 (a few GB) once.
3. Optional: add `metrics.json` (written by `python3 -m fish_length.cli_trainer data.csv
   --artifacts fish_length/artifacts`) to show measured accuracy on the home page instead of the
   labelled estimates.

Without it, the catch app measures from the angler's knuckles exactly as before.
