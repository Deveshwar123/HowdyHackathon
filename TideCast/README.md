# TideCast

Find your next great catch. Explore the waters. Learn what's biting. Make every catch count.

| Folder | What it is |
|---|---|
| [`Backbone/`](Backbone/) | The TideCast landing page: rotating photoreal Earth, and the Earth → water drop → lake → leaf → leaderboard sequence |
| [`FishMigration/`](FishMigration/) | The fish atlas: live OBIS fish records and Global Fishing Watch data on a 3D globe |

## Run it

```bash
cd TideCast
python3 FishMigration/server.py
```
or double-click `start.command`. It opens the landing page (`/backbone/`); **Explore the waters**
opens the fish atlas (`/`). Python 3 only; an internet connection for live data.
