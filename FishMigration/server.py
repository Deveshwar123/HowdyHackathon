#!/usr/bin/env python3
"""Pelagic local server.

Serves the static atlas and implements the API routes the front end calls:

  /api/observations?species=&bbox=   live OBIS records (thousands, not a 180-record sample)
  /api/places?q=                     place search via Photon / OpenStreetMap
  /api/obis/<path>                   pass-through to api.obis.org/v3 (checklists, grids)
  /api/gfw/<path>                    pass-through to the Global Fishing Watch API,
                                     adding the API token server-side
  /api/config                        what is available (e.g. whether a GFW token is set)
  /data/<Species_name>.json          cached OBIS sample; fetched and saved on first use

Standard library only. Run:  python3 server.py   (then open http://localhost:8765)

The GFW API token is built in (BUILT_IN_GFW_TOKEN); the GFW_TOKEN environment
variable overrides it.
"""

import json
import os
import re
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from collections import OrderedDict
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("PORT", "8790"))
OBIS = os.environ.get("OBIS_URL", "https://api.obis.org/v3")
GFW = os.environ.get("GFW_URL", "https://gateway.api.globalfishingwatch.org/v3")
PHOTON = os.environ.get("PHOTON_URL", "https://photon.komoot.io/api/")
# Records returned per species query. OBIS pages are capped at 10,000; above
# that the server pages through results. The globe stays smooth to ~20,000.
MAX_RECORDS = int(os.environ.get("PELAGIC_MAX_RECORDS", "5000"))
SAMPLE_RECORDS = 500  # size of the cached /data sample used for area counts
OBS_FIELDS = ",".join([
    "id", "decimalLatitude", "decimalLongitude", "eventDate", "date_year",
    "datasetName", "coordinateUncertaintyInMeters", "recordedBy",
    "institutionCode", "license", "scientificName", "basisOfRecord",
    "depth", "absence", "dropped",
])
USER_AGENT = "Pelagic/1.0 (HowdyHackathon fish atlas)"


JWT = re.compile(r"eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+")
INVISIBLE = re.compile("[\u00ad\u200b-\u200f\u2060\ufeff\u201c\u201d\"' ]")


def find_token(text):
    """Finds a GFW token (a JWT) anywhere in the text, however the line is written
    (with or without GFW_TOKEN=, quotes, or trailing junk). Copying a long token out
    of a chat window can add invisible characters, so those are removed first."""
    match = JWT.search(INVISIBLE.sub("", text or ""))
    return match.group(0) if match else ""


# Team Global Fishing Watch API token (application "Final", valid until 2036).
# Built in so nobody needs a .env file; set the GFW_TOKEN environment variable to use another.
BUILT_IN_GFW_TOKEN = (
    "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6ImtpZEtleSJ9."
    "eyJkYXRhIjp7Im5hbWUiOiJGaW5hbCAiLCJ1c2VySWQiOjc0NzAxLCJhcHBsaWNhdGlvbk5hbWUiOiJGaW5hbCAiLCJpZCI6MTYzNzYsInR5cGUiOiJ1c2VyLWFwcGxpY2F0aW9uIn0sImlhdCI6MTc5Mjg3MDU1OSwiZXhwIjoyMTA4MjMwNTU5LCJhdWQiOiJnZnciLCJpc3MiOiJnZncifQ."
    "b26cF2CkfpSU662B1x_08I__zNCwa4Y8gtErPBAe3X46pg7oGy-xZbl4AizRoECyrvdkYrgGjLKUy5xDYpg9UaSdnoJLDWM1Yzd8kFcpfF9sEITciv-qYXhPqdcaFNTUzwBjIuiYEiUU_k--ZTmolytO52eg126ZGUJCAoYA16G-5TtIpvSW-eNJqQKTa6ubrx5lI2LcA3Zm0J9hsekgdCnPpganvQlBtIeY0kb_pjbaTYu8Jv30UruMKRnWswBD25VNy83xgm_sXY5VBHXajoGbBUrY_JiwvA0GtV0_T4OY1Jk2h9Okqq_eoVD-8b2r96RphCQ03XFM9Mr4p1HifKhALG29KD2pYmq8haWlySDHq1smPA2P9PvZOcTybBYpSbJm7TwLyRmzCZ0SyBc7sR2tO9IXtBNaNguVejuYj4Hh0cIDQHYmZiE2nu_9PeTRS7rHPi9JRRvLbbD3QYHAO-v1rtoS-WVdQpHnU9O7exzTKy_3swCmyQyF263WOchF"
)


def load_token():
    return find_token(os.environ.get("GFW_TOKEN", "")) or BUILT_IN_GFW_TOKEN


def check_token():
    """Asks GFW whether the token works and says so in the terminal."""
    url = GFW + "/vessels/search?" + urllib.parse.urlencode(
        {"query": "Galapagos", "datasets[0]": "public-global-vessel-identity:latest", "limit": 1})
    try:
        status, _, data = fetch(url, headers={"Authorization": "Bearer " + GFW_TOKEN}, timeout=30)
    except Exception as e:
        return print(f"  Global Fishing Watch: could not reach the API to check the token ({e})")
    if status == 200:
        print("  Global Fishing Watch: token accepted by GFW - fishing layers are live")
    elif status in (401, 403):
        print(f"  Global Fishing Watch: GFW REJECTED the token ({status}): {data[:200].decode(errors='ignore')}")
        print("    -> create a new token at https://globalfishingwatch.org/our-apis/tokens and replace BUILT_IN_GFW_TOKEN in server.py")
    else:
        print(f"  Global Fishing Watch: token check returned {status}: {data[:200].decode(errors='ignore')}")


GFW_TOKEN = load_token()


class TTLCache:
    """Small thread-safe LRU cache so repeated tiles and queries are instant."""

    def __init__(self, size=3000, ttl=6 * 3600):
        self.size, self.ttl = size, ttl
        self.items = OrderedDict()
        self.lock = threading.Lock()

    def get(self, key):
        with self.lock:
            hit = self.items.get(key)
            if not hit or hit[0] < time.time():
                return None
            self.items.move_to_end(key)
            return hit[1]

    def put(self, key, value):
        with self.lock:
            self.items[key] = (time.time() + self.ttl, value)
            self.items.move_to_end(key)
            while len(self.items) > self.size:
                self.items.popitem(last=False)


cache = TTLCache()


def fetch(url, method="GET", body=None, headers=None, timeout=60):
    """Returns (status, content_type, bytes)."""
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header("User-Agent", USER_AGENT)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.headers.get("Content-Type", "application/octet-stream"), r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get("Content-Type", "application/json"), e.read()


def fetch_json(url):
    status, _, data = fetch(url)
    if status >= 400:
        raise RuntimeError(f"{url} -> HTTP {status}: {data[:200]!r}")
    return json.loads(data)


def bbox_to_wkt(bbox):
    w, s, e, n = bbox
    ring = lambda a, b: f"(({a} {s},{b} {s},{b} {n},{a} {n},{a} {s}))"
    if w > e:  # crosses the antimeridian
        return f"MULTIPOLYGON({ring(w, 180)},{ring(-180, e)})"
    return "POLYGON" + ring(w, e)


def obis_occurrences(species, bbox=None, limit=MAX_RECORDS):
    """Pages through OBIS until `limit` records (or the end) are reached."""
    results, total, after = [], 0, None
    while len(results) < limit:
        params = {
            "scientificname": species,
            "size": min(10000, limit - len(results)),
            "fields": OBS_FIELDS,
        }
        if bbox:
            params["geometry"] = bbox_to_wkt(bbox)
        if after:
            params["after"] = after
        page = fetch_json(OBIS + "/occurrence?" + urllib.parse.urlencode(params))
        total = page.get("total", total)
        batch = page.get("results", [])
        results.extend(batch)
        if len(batch) < params["size"] or not batch[-1].get("id"):
            break
        after = batch[-1]["id"]
    return {"total": total, "results": results}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):
        if "/api/" in self.path or (args and str(args[1])[0] in "45"):
            sys.stderr.write("[pelagic] " + (fmt % args) + "\n")

    def end_headers(self):
        # Static files (the app itself) must never come from a stale browser cache:
        # an old bundle would bring back behaviour that has since been changed.
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache, must-revalidate")
        super().end_headers()

    def send_bytes(self, status, ctype, body, cache_seconds=0):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        if cache_seconds:
            self.send_header("Cache-Control", f"public, max-age={cache_seconds}")
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, obj, status=200):
        self.send_bytes(status, "application/json", json.dumps(obj).encode())

    # ---- routing ---------------------------------------------------------
    def do_GET(self):
        url = urllib.parse.urlsplit(self.path)
        query = urllib.parse.parse_qs(url.query)
        try:
            if url.path == "/api/config":
                return self.send_json({"gfw": bool(GFW_TOKEN), "maxRecords": MAX_RECORDS})
            if url.path == "/api/observations":
                return self.observations(query)
            if url.path == "/api/places":
                return self.places(query)
            if url.path.startswith("/api/obis/"):
                return self.proxy(OBIS + url.path[len("/api/obis"):], url.query)
            if url.path.startswith("/api/gfw/"):
                return self.proxy(GFW + url.path[len("/api/gfw"):], url.query, gfw=True)
            if url.path.startswith("/data/") and url.path.endswith(".json"):
                return self.sample(url.path)
        except Exception as e:  # upstream unreachable, bad JSON, etc.
            return self.send_json({"error": str(e)}, 502)
        return super().do_GET()

    def do_POST(self):
        url = urllib.parse.urlsplit(self.path)
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        try:
            if url.path.startswith("/api/gfw/"):
                return self.proxy(GFW + url.path[len("/api/gfw"):], url.query,
                                  gfw=True, method="POST", body=body)
        except Exception as e:
            return self.send_json({"error": str(e)}, 502)
        self.send_json({"error": "Not found"}, 404)

    # ---- handlers --------------------------------------------------------
    def observations(self, query):
        species = (query.get("species") or [""])[0].strip()
        if not species:
            return self.send_json({"error": "species is required"}, 400)
        bbox = None
        if query.get("bbox"):
            bbox = [float(v) for v in query["bbox"][0].split(",")]
        key = f"obs:{species}:{bbox}"
        data = cache.get(key)
        if data is None:
            data = json.dumps(obis_occurrences(species, bbox)).encode()
            cache.put(key, data)
        self.send_bytes(200, "application/json", data)

    def places(self, query):
        q = (query.get("q") or [""])[0].strip()
        if len(q) < 2:
            return self.send_json({"results": []})
        data = fetch_json(PHOTON + "?" + urllib.parse.urlencode({"q": q, "limit": 6}))
        results = []
        for f in data.get("features", []):
            p, (lon, lat) = f.get("properties", {}), f["geometry"]["coordinates"]
            context = ", ".join(x for x in [p.get("state"), p.get("country")] if x)
            results.append({"name": p.get("name") or q, "context": context or p.get("type", ""),
                            "lon": lon, "lat": lat})
        self.send_json({"results": results})

    def sample(self, path):
        name = os.path.basename(path)
        if not re.fullmatch(r"[A-Za-z_\-]+\.json", name):
            return self.send_json({"error": "bad name"}, 400)
        local = os.path.join(ROOT, "data", name)
        if not os.path.exists(local):
            species = name[:-5].replace("_", " ")
            data = obis_occurrences(species, limit=SAMPLE_RECORDS)
            os.makedirs(os.path.dirname(local), exist_ok=True)
            with open(local, "w") as f:
                json.dump(data, f)
        with open(local, "rb") as f:
            self.send_bytes(200, "application/json", f.read())

    def proxy(self, target, qs, gfw=False, method="GET", body=None):
        if gfw and not GFW_TOKEN:
            return self.send_json({"error": "No GFW token on the server"}, 503)
        full = target + ("?" + qs if qs else "")
        key = f"{method}:{full}:{body!r}"
        hit = cache.get(key)
        if hit:
            return self.send_bytes(*hit, cache_seconds=3600)
        headers = {}
        if gfw:
            headers["Authorization"] = "Bearer " + GFW_TOKEN
        if body is not None:
            headers["Content-Type"] = self.headers.get("Content-Type", "application/json")
        status, ctype, data = fetch(full, method, body, headers, timeout=120)
        if status == 200:
            cache.put(key, (status, ctype, data))
        elif gfw:
            sys.stderr.write(f"[pelagic] GFW answered {status} for {target}: {data[:300]!r}\n")
        self.send_bytes(status, ctype, data, cache_seconds=3600 if status == 200 else 0)


def port_in_use(port):
    """True if anything answers on this port over IPv4 or IPv6 (macOS lets two
    servers share a port across the two, so "localhost" can reach the wrong app)."""
    for family, host in ((socket.AF_INET, "127.0.0.1"), (socket.AF_INET6, "::1")):
        try:
            with socket.socket(family, socket.SOCK_STREAM) as s:
                s.settimeout(0.3)
                if s.connect_ex((host, port)) == 0:
                    return True
        except OSError:  # e.g. no IPv6 on this machine
            pass
    return False


if __name__ == "__main__":
    port = PORT
    while port_in_use(port):
        print(f"Port {port} is already used by another app - trying {port + 1}")
        port += 1
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    url = f"http://127.0.0.1:{port}/"
    print(f"Pelagic running at {url}  (press Ctrl+C to stop)")
    print(f"  OBIS records per species query: {MAX_RECORDS:,}")
    print("  Global Fishing Watch: checking the API token with GFW…")
    threading.Thread(target=check_token, daemon=True).start()
    if not os.environ.get("NO_BROWSER"):
        threading.Timer(0.8, webbrowser.open, [url]).start()
    server.serve_forever()
