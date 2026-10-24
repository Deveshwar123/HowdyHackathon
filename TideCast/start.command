#!/bin/bash
# Double-click to run TideCast: opens the landing page (Backbone); "Explore" opens the fish atlas (FishMigration).
cd "$(dirname "$0")"
python3 FishMigration/server.py
