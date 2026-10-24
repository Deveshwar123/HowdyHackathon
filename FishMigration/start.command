#!/bin/bash
# Serves the Pelagic atlas locally (with live OBIS + Global Fishing Watch data) and opens it in Chrome.
cd "$(dirname "$0")"
PORT=8765
( sleep 1; open -a "Google Chrome" "http://localhost:$PORT/" ) &
echo "Pelagic running at http://localhost:$PORT  (close this window to stop)"
PORT=$PORT python3 server.py
