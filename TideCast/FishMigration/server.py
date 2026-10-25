#!/usr/bin/env python3
"""Pelagic local server.

Serves the static atlas and implements the API routes the front end calls:

  /api/observations?species=&bbox=   live OBIS records (thousands, not a 180-record sample)
  /api/places?q=                     place search via Photon / OpenStreetMap
  /api/obis/<path>                   pass-through to api.obis.org/v3 (checklists, grids)
  /api/gfw/<path>                    pass-through to the Global Fishing Watch API,
                                     adding the API token server-side
  /api/config                        what is available (e.g. whether a GFW token is set)
  /api/water?lat=&lon=               named lakes / reservoirs / bays nearest a point (OpenStreetMap)
  /api/water/shape?osm=way/123       outline of one of those waters plus an open-water point
  /api/reverse?lat=&lon=             place name for a point (Photon)
  /api/sat?bbox=w,s,e,n&w=&h=        satellite image of a lon/lat box (Esri World Imagery)
  /api/catch/upload|analyze|measure|submit   log a catch: photo -> species, length, weight, points
  /api/leaderboard, /api/species, /api/stats  leaderboard, species + points, live totals
  /catch-photos/<id>.jpg             photos of posted catches
  (all catch routes live in ../Catch, the photo-measuring app)
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
# The catch app (photo -> species, length, weight, points; SQLite leaderboard): TideCast/Catch.
sys.path.insert(0, os.path.join(os.path.dirname(ROOT), "Catch"))
import main as catch  # noqa: E402
import net  # noqa: E402  (trusted certificates for every outside call)
# The TideCast landing page (TideCast/Backbone), served at /backbone/.
BACKBONE = os.path.join(os.path.dirname(ROOT), "Backbone")
PORT = int(os.environ.get("PORT", "8790"))
OBIS = os.environ.get("OBIS_URL", "https://api.obis.org/v3")
GFW = os.environ.get("GFW_URL", "https://gateway.api.globalfishingwatch.org/v3")
PHOTON = os.environ.get("PHOTON_URL", "https://photon.komoot.io/api/")
PHOTON_REVERSE = os.environ.get("PHOTON_REVERSE_URL", "https://photon.komoot.io/reverse")
OVERPASS = os.environ.get("OVERPASS_URL", "https://overpass-api.de/api/interpreter")
ESRI_EXPORT = os.environ.get("ESRI_EXPORT_URL",
                             "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export")
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
    except (urllib.error.URLError, OSError) as e:
        # No answer at all (offline, blocked, certificate problem): say why, as JSON.
        return 502, "application/json", json.dumps({"error": net.explain(e, url)}).encode()


def fetch_json(url):
    status, _, data = fetch(url)
    if status >= 400:
        try:
            reason = json.loads(data).get("error") or ""
        except (ValueError, AttributeError):
            reason = ""
        host = urllib.parse.urlsplit(url).hostname
        raise RuntimeError(reason or f"{host} answered {status}; try again in a moment")
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


# ---- Nearby waters (OpenStreetMap via Overpass) ------------------------------
SKIP_WATER = {"wastewater", "swimming_pool", "fountain", "basin", "moat", "reflecting_pool", "fish_pass"}


def overpass(query):
    status, _, data = fetch(OVERPASS, "POST", urllib.parse.urlencode({"data": query}).encode(),
                            {"Content-Type": "application/x-www-form-urlencoded"}, timeout=60)
    if status >= 400:
        raise RuntimeError(f"Overpass -> HTTP {status}: {data[:200]!r}")
    return json.loads(data)


def km_between(lat1, lon1, lat2, lon2):
    import math
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 12742 * math.asin(math.sqrt(a))


def nearby_waters(lat, lon):
    """Named lakes, reservoirs and bays around a point, nearest first (tiny ponds left out)."""
    for radius in (40000, 120000):
        q = (f'[out:json][timeout:40];(way["natural"="water"]["name"](around:{radius},{lat},{lon});'
             f'relation["natural"="water"]["name"](around:{radius},{lat},{lon});'
             f'way["natural"="bay"]["name"](around:{radius},{lat},{lon}););out tags center bb;')
        found = []
        for el in overpass(q).get("elements", []):
            tags, bb, c = el.get("tags", {}), el.get("bounds"), el.get("center")
            if not bb or not c or tags.get("water") in SKIP_WATER:
                continue
            size = km_between(bb["minlat"], bb["minlon"], bb["maxlat"], bb["maxlon"])
            if size < 0.35:
                continue
            kind = tags.get("water") or tags.get("natural") or "water"
            found.append({
                "name": tags["name"], "kind": kind.replace("_", " ").capitalize(),
                "water": "salt" if kind in ("bay", "lagoon", "sea") or tags.get("salt") == "yes" else "fresh",
                "lat": c["lat"], "lon": c["lon"], "sizeKm": round(size, 2),
                "bbox": [bb["minlon"], bb["minlat"], bb["maxlon"], bb["maxlat"]],
                "osm": f'{el["type"]}/{el["id"]}',
                "km": round(km_between(lat, lon, c["lat"], c["lon"]), 1),
            })
        if found:
            seen, out = set(), []
            for w in sorted(found, key=lambda w: w["km"]):
                if w["name"] not in seen:
                    seen.add(w["name"])
                    out.append(w)
            return out[:8]
    return []


def join_rings(ways):
    """Joins way segments (lists of [lon, lat]) end to end into closed rings."""
    ways = [list(w) for w in ways if len(w) > 1]
    rings = []
    while ways:
        ring = ways.pop(0)
        changed = True
        while ring[0] != ring[-1] and changed:
            changed = False
            for i, w in enumerate(ways):
                if w[0] == ring[-1]:
                    ring += w[1:]
                elif w[-1] == ring[-1]:
                    ring += w[::-1][1:]
                elif w[-1] == ring[0]:
                    ring = w[:-1] + ring
                elif w[0] == ring[0]:
                    ring = w[::-1][:-1] + ring
                else:
                    continue
                ways.pop(i)
                changed = True
                break
        if len(ring) > 3:
            rings.append(ring)
    return rings


def water_shape(osm):
    """Outline rings of a water (outer, inner) and a point well inside its open water."""
    kind, _, num = osm.partition("/")
    if kind not in ("way", "relation") or not num.isdigit():
        raise ValueError("osm must look like way/123 or relation/123")
    el = (overpass(f"[out:json][timeout:60];{kind}({num});out geom;").get("elements") or [None])[0]
    if not el:
        raise RuntimeError("not found")
    pts = lambda g: [[round(p["lon"], 6), round(p["lat"], 6)] for p in g]
    if kind == "way":
        outer, inner = [pts(el.get("geometry", []))], []
    else:
        members = [m for m in el.get("members", []) if m.get("type") == "way" and m.get("geometry")]
        outer = join_rings([pts(m["geometry"]) for m in members if m.get("role") != "inner"])
        inner = join_rings([pts(m["geometry"]) for m in members if m.get("role") == "inner"])
    return {"outer": outer, "inner": inner, "target": open_water_point(outer, inner)}


def open_water_point(outer, inner):
    """The point farthest from any shore (grid search), so a dive lands in open water."""
    import math
    rings = [r[:: max(1, len(r) // 400)] for r in outer + inner]
    allp = [p for r in outer for p in r]
    if not allp:
        return None
    w, e = min(p[0] for p in allp), max(p[0] for p in allp)
    s, n = min(p[1] for p in allp), max(p[1] for p in allp)
    kx = math.cos(math.radians((s + n) / 2))

    def inside(x, y, ring):
        c = False
        for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
            if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
                c = not c
        return c

    def shore(x, y):
        best = 1e9
        for r in rings:
            for (x1, y1), (x2, y2) in zip(r, r[1:]):
                dx, dy = (x2 - x1) * kx, y2 - y1
                px, py = (x - x1) * kx, y - y1
                t = max(0.0, min(1.0, (px * dx + py * dy) / (dx * dx + dy * dy or 1e-12)))
                best = min(best, (px - t * dx) ** 2 + (py - t * dy) ** 2)
        return best

    best, at = -1, None
    steps = 24
    for i in range(steps):
        for j in range(steps):
            x, y = w + (e - w) * (i + 0.5) / steps, s + (n - s) * (j + 0.5) / steps
            if any(inside(x, y, r) for r in outer) and not any(inside(x, y, r) for r in inner):
                d = shore(x, y)
                if d > best:
                    best, at = d, [round(x, 6), round(y, 6)]
    return at


CATCH_ROUTES = {
    "/api/catch/upload": catch.upload,
    "/api/catch/analyze": catch.analyze,
    "/api/catch/measure": catch.measure_points,
    "/api/catch/submit": catch.submit,
    "/api/catch/key": catch.set_key,
}


def fish_points_js():
    """/backbone/fish-points.js, generated from the catch app's species database so the site
    and the scoring always agree."""
    def water(w):
        return "salt" if w.lower().startswith("salt") else "fresh"
    fish = [{"id": s["id"], "name": s["name"], "scientific": s["scientific"], "water": water(s["water"]),
             "rarity": s["rarity"], "points": s["points_typical"]} for s in catch.species()[1]["species"]]
    defaults = {"fresh": ["largemouth-bass", "channel-catfish", "white-crappie", "bluegill"],
                "salt": ["redfish", "spotted-seatrout", "southern-flounder", "black-drum"]}
    return ("// Generated by server.py from TideCast/Catch/fish_data.py + scoring.py. Do not edit.\n"
            f"window.TIDECAST_FISH = {json.dumps(fish)};\n"
            f"window.TIDECAST_DEFAULT_FISH = {json.dumps(defaults)};\n").encode()


def species_extra_js():
    """/species-extra.js: every TideCast species joins the atlas field guide (searchable by its
    angler names too, e.g. "redfish" finds Red drum), so the two never disagree."""
    def shape(name):
        n = name.lower()
        if any(k in n for k in ("gar", "sturgeon", "paddlefish", "catfish", "bowfin", "pike", "pickerel", "muskellunge")):
            return "shark"
        if any(k in n for k in ("tuna", "mackerel", "marlin", "sailfish", "swordfish", "wahoo", "mahi", "cobia",
                                "salmon", "trout", "bonefish", "ladyfish", "tarpon", "bluefish", "amberjack")):
            return "tuna"
        return "reef"
    extra = []
    for name, info in catch.FISH_DB.items():
        water = info.get("water", "")
        salt = "salt" in water.lower()
        mx = info.get("max_length_cm") or 0
        size = f"Up to about {mx / 100:.1f} m" if mx >= 100 else f"Up to about {mx} cm"
        extra.append({
            "id": "tc-" + catch.scoring.slug(name), "name": name, "scientific": info["scientific_name"],
            "group": "Open ocean" if "Open" in info.get("habitat", "") or "offshore" in info.get("habitat", "").lower()
            else ("Coastal & bottom" if salt else "Freshwater"),
            "color": "#e8454f", "size": size, "depth": water, "habitat": info.get("habitat", ""),
            "description": f"Look for: {info.get('features', '')}.", "fact": f"Eats: {info.get('diet', '')}.",
            "regions": ["gulf", "atlantic"] if salt else [], "shape": shape(name),
            "aka": [name] + list(info.get("aliases", [])),
        })
    # Kept apart from window.PELAGIC_SPECIES: the prebuilt atlas page was rendered with that
    # list, and changing it before React starts makes React throw away and redraw the page.
    return ("// Generated by server.py from TideCast/Catch/fish_data.py. Do not edit.\n"
            f"window.TIDECAST_GUIDE_EXTRA = {json.dumps(extra)};\n").encode()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def translate_path(self, path):
        url_path = urllib.parse.urlsplit(path).path
        if url_path == "/backbone" or url_path.startswith("/backbone/"):
            rel = urllib.parse.unquote(url_path[len("/backbone"):]).lstrip("/")
            full = os.path.normpath(os.path.join(BACKBONE, rel))
            if full == BACKBONE or full.startswith(BACKBONE + os.sep):
                return full
            return os.path.join(BACKBONE, "__not_found__")
        return super().translate_path(path)

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
            if url.path == "/species.js":   # the atlas guide + every TideCast species
                with open(os.path.join(ROOT, "species.js"), "rb") as f:
                    return self.send_bytes(200, "text/javascript", f.read() + b"\n" + species_extra_js())
            if url.path == "/backbone/fish-points.js":
                return self.send_bytes(200, "text/javascript", fish_points_js())
            if url.path == "/api/leaderboard":
                return self.send_json(*reversed(catch.leaderboard(query)))
            if url.path == "/api/species":
                return self.send_json(*reversed(catch.species(query)))
            if url.path == "/api/stats":
                return self.send_json(*reversed(catch.stats(query)))
            if url.path.startswith("/catch-photos/"):
                data = catch.photo_bytes(url.path[len("/catch-photos/"):])
                if data is None:
                    return self.send_json({"error": "Not found"}, 404)
                return self.send_bytes(200, "image/jpeg", data, cache_seconds=86400)
            if url.path == "/api/config":
                return self.send_json({"gfw": bool(GFW_TOKEN), "maxRecords": MAX_RECORDS})
            if url.path == "/api/observations":
                return self.observations(query)
            if url.path == "/api/places":
                return self.places(query)
            if url.path == "/api/water":
                return self.waters(query)
            if url.path == "/api/water/shape":
                return self.cached_json("shape:" + (query.get("osm") or [""])[0],
                                        lambda: water_shape((query.get("osm") or [""])[0]))
            if url.path == "/api/reverse":
                return self.reverse(query)
            if url.path == "/api/sat":
                return self.satellite(query)
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
        if length > 9 * 1024 * 1024:
            return self.send_json({"ok": False, "error": "That upload is too large."}, 413)
        body = self.rfile.read(length) if length else None
        try:
            if url.path in CATCH_ROUTES:
                try:
                    payload = json.loads(body or b"{}")
                except ValueError:
                    return self.send_json({"ok": False, "error": "Bad request."}, 400)
                if not isinstance(payload, dict):
                    return self.send_json({"ok": False, "error": "Bad request."}, 400)
                status, out = CATCH_ROUTES[url.path](payload)
                return self.send_json(out, status)
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
        limit = MAX_RECORDS
        if query.get("limit"):
            limit = max(1, min(MAX_RECORDS, int(query["limit"][0])))
        key = f"obs:{species}:{bbox}:{limit}"
        data = cache.get(key)
        if data is None:
            data = json.dumps(obis_occurrences(species, bbox, limit)).encode()
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

    def cached_json(self, key, make):
        data = cache.get(key)
        if data is None:
            data = json.dumps(make()).encode()
            cache.put(key, data)
        self.send_bytes(200, "application/json", data, cache_seconds=3600)

    def point(self, query):
        lat, lon = float(query["lat"][0]), float(query["lon"][0])
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            raise ValueError("lat/lon out of range")
        return lat, lon

    def waters(self, query):
        lat, lon = self.point(query)
        self.cached_json(f"water:{lat:.3f},{lon:.3f}", lambda: {"waters": nearby_waters(lat, lon)})

    def reverse(self, query):
        lat, lon = self.point(query)

        def make():
            data = fetch_json(PHOTON_REVERSE + "?" + urllib.parse.urlencode({"lat": lat, "lon": lon}))
            p = (data.get("features") or [{}])[0].get("properties", {})
            place = p.get("city") or p.get("town") or p.get("village") or p.get("county") or p.get("name") or ""
            region = p.get("state") or p.get("country") or ""
            return {"name": ", ".join(x for x in [place, region] if x)}
        self.cached_json(f"rev:{lat:.3f},{lon:.3f}", make)

    def satellite(self, query):
        w, s, e, n = [float(v) for v in (query.get("bbox") or [""])[0].split(",")]
        if not (-180 <= w < e <= 180 and -85 <= s < n <= 85 and e - w <= 30 and n - s <= 30):
            return self.send_json({"error": "bad bbox"}, 400)
        width = max(64, min(2048, int((query.get("w") or ["1024"])[0])))
        height = max(64, min(2048, int((query.get("h") or ["1024"])[0])))
        url = ESRI_EXPORT + "?" + urllib.parse.urlencode({
            "bbox": f"{w},{s},{e},{n}", "bboxSR": 4326, "imageSR": 4326,
            "size": f"{width},{height}", "format": "jpg", "f": "image"})
        hit = cache.get("sat:" + url)
        if not hit:
            status, ctype, data = fetch(url, timeout=60)
            if status != 200 or not ctype.startswith("image/"):
                return self.send_json({"error": f"imagery unavailable ({status})"}, 502)
            hit = (ctype, data)
            cache.put("sat:" + url, hit)
        self.send_bytes(200, hit[0], hit[1], cache_seconds=86400)

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
    catch.init()
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    url = f"http://127.0.0.1:{port}/backbone/"   # TideCast landing page; "Explore" opens the atlas at /
    print(f"TideCast running at {url}  (press Ctrl+C to stop)")
    print(f"  Fish atlas (FishMigration): http://127.0.0.1:{port}/")
    print(f"  OBIS records per species query: {MAX_RECORDS:,}")
    print("  Catch measuring (Gemini): " + ("on" if catch.vision.api_key() else
          "off - set GEMINI_API_KEY (or put it in TideCast/.env); anglers can still mark points by hand"))
    print("  Global Fishing Watch: checking the API token with GFW…")
    threading.Thread(target=check_token, daemon=True).start()
    if not os.environ.get("NO_BROWSER"):
        threading.Timer(0.8, webbrowser.open, [url]).start()
    server.serve_forever()
