#!/bin/bash
# Serves the Pelagic atlas locally and opens it in Chrome.
cd "$(dirname "$0")"
PORT=8765
( sleep 1; open -a "Google Chrome" "http://localhost:$PORT/" ) &
echo "Pelagic running at http://localhost:$PORT  (close this window to stop)"
python3 -m http.server $PORT
