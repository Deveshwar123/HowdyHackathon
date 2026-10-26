#!/usr/bin/env python3
"""TideCast model service: the fish-length model and the species finder behind a small HTTP API,
so the website (and anyone using it) never has to download the 4 GB model.

It runs as a Hugging Face Space (see ./space), on any machine with ~8 GB of free RAM:

    pip install -r TideCast/ModelService/requirements.txt
    python3 TideCast/ModelService/server.py          # http://127.0.0.1:7860

The website uses it when its MODEL_API_URL environment variable points here.

  GET  /health    {"ready", "length": {...}, "species": {...}, "device"}
  POST /analyze   {"image": base64 JPEG/PNG (data: URLs are fine)}
                  -> {"ok", "length_cm", "candidates": [{"id", "species", "prob"}], "ms"}

Standard library HTTP; the heavy lifting is TideCast/Catch/length_ai.py and species_ai.py, the same
code the website runs when the model is installed locally.
"""
import base64
import hashlib
import json
import os
import sys
import tempfile
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
CATCH = os.path.join(os.path.dirname(HERE), "Catch")
sys.path.insert(0, CATCH)

import length_ai   # noqa: E402
import scoring     # noqa: E402
import species_ai  # noqa: E402
from fish_data import FISH_DB  # noqa: E402

SPECIES_BY_ID = {scoring.slug(name): name for name in FISH_DB}
MAX_BYTES = 8 * 1024 * 1024
STARTED = time.time()
STATS = {"analyzed": 0, "errors": 0}


def health():
    ls = length_ai.load_state()
    ss = species_ai.state()
    dev = None
    if length_ai.ready():
        try:
            dev = str(length_ai._predictor.utils.device)
        except Exception:
            dev = None
    return {"ready": length_ai.ready() and species_ai.ready(), "device": dev,
            "length": {"state": ls["state"], "error": ls["error"]},
            "species": {"state": ss["state"], "error": ss["error"], "references": ss["n_refs"]},
            "uptime_s": int(time.time() - STARTED), **STATS}


def analyze(payload):
    raw = str(payload.get("image") or "")
    if "," in raw[:100]:
        raw = raw.split(",", 1)[1]
    try:
        data = base64.b64decode(raw, validate=True)
    except (ValueError, TypeError):
        return 400, {"ok": False, "error": "image must be base64"}
    if not data or len(data) > MAX_BYTES:
        return 400, {"ok": False, "error": "image missing or larger than 8 MB"}
    if not (data[:2] == b"\xff\xd8" or data[:8] == b"\x89PNG\r\n\x1a\n" or data[8:12] == b"WEBP"):
        return 400, {"ok": False, "error": "image must be a JPEG, PNG or WebP"}
    if not length_ai.ready():
        return 503, {"ok": False, "error": "model is loading", "loading": True, "health": health()}
    t0 = time.time()
    key = hashlib.sha256(data).hexdigest()
    fd, path = tempfile.mkstemp(suffix=".img")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        length = length_ai.predict_length_cm(path, key=key)
        found = species_ai.identify(path, key=key) if species_ai.ready() else None
    except Exception as e:  # unreadable image, out of memory...
        STATS["errors"] += 1
        return 422, {"ok": False, "error": f"{type(e).__name__}: {e}"}
    finally:
        try:
            os.remove(path)
        except OSError:
            pass
    STATS["analyzed"] += 1
    cands = [{"id": c["id"], "species": SPECIES_BY_ID.get(c["id"], c["id"]), "prob": c["prob"]}
             for c in (found or [])]
    return 200, {"ok": True, "length_cm": round(length, 2) if length else None, "candidates": cands,
                 "species_ready": found is not None, "ms": int((time.time() - t0) * 1000)}


INDEX_HTML = b"""<!doctype html><meta charset=utf-8><title>TideCast model</title>
<body style="font:15px/1.5 system-ui;max-width:640px;margin:40px auto;padding:0 16px">
<h1>TideCast model service</h1>
<p>The fish-length model (DINOv2 ViT-g/14 + AutoML regressor) and the species finder behind
<a href="https://tidecast-kdl9.onrender.com/backbone/">TideCast</a>.
<p><code>GET /health</code> &middot; <code>POST /analyze {"image": "&lt;base64 JPEG&gt;"}</code>
<p>Source: <a href="https://github.com/Deveshwar123/HowdyHackathon">github.com/Deveshwar123/HowdyHackathon</a>
</body>"""


class Handler(BaseHTTPRequestHandler):
    server_version = "TideCastModel/1.0"

    def log_message(self, fmt, *args):
        if self.path != "/health":
            sys.stderr.write("[model] " + (fmt % args) + "\n")

    def send(self, status, body, ctype="application/json"):
        if not isinstance(body, bytes):
            body = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            return self.send(200, INDEX_HTML, "text/html; charset=utf-8")
        if self.path == "/health":
            h = health()
            return self.send(200, h)
        self.send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/analyze":
            return self.send(404, {"error": "not found"})
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BYTES * 2:
            return self.send(413, {"ok": False, "error": "too large"})
        try:
            payload = json.loads(self.rfile.read(n) or b"{}")
            if not isinstance(payload, dict):
                raise ValueError
        except ValueError:
            return self.send(400, {"ok": False, "error": "bad JSON"})
        self.send(*analyze(payload))


def main():
    try:
        import torch
        torch.set_num_threads(max(1, os.cpu_count() or 1))
    except ImportError:
        pass
    length_ai.warm_up()
    species_ai.warm_up(SPECIES_BY_ID)
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "7860"))
    print(f"TideCast model service on http://{host}:{port}", flush=True)
    ThreadingHTTPServer((host, port), Handler).serve_forever()


if __name__ == "__main__":
    main()
