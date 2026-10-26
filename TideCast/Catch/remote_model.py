"""Client for the hosted TideCast model service (TideCast/ModelService), used when the website's
MODEL_API_URL environment variable is set: the length model and the species finder then run on
that server and nobody needs the 4 GB model locally.

One /analyze call per photo returns both the length and the species candidates; results are cached
per photo. /health is polled in the background so the page can say when the model is waking up
(a free Hugging Face Space sleeps when it hasn't been used for a while).
"""
import base64
import json
import os
import threading
import time
import urllib.error
import urllib.request

import net  # noqa: F401  (trusted certificates)

URL = os.environ.get("MODEL_API_URL", "").strip().rstrip("/")
ANALYZE_TIMEOUT_S = 180     # the first request after waking runs on a cold CPU
HEALTH_TTL_S = 8

_lock = threading.Lock()
_cache = {}
_failed = {}                 # photo -> time of a failed call; not retried for FAIL_TTL_S
FAIL_TTL_S = 60
_health = {"state": "idle", "error": "", "checked": 0.0, "species": "idle", "references": 0}
_poller = {"running": False}


def enabled():
    return bool(URL)


def _get(path, timeout=20):
    req = urllib.request.Request(URL + path, headers={"User-Agent": "TideCast/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def check_health():
    """Ask the model service how it's doing; updates the cached state."""
    try:
        h = _get("/health", timeout=20)
        length = (h.get("length") or {}).get("state", "loading")
        species = (h.get("species") or {}).get("state", "idle")
        state = "ready" if length == "ready" else ("failed" if length == "failed" else "loading")
        _health.update(state=state, error=(h.get("length") or {}).get("error", ""), species=species,
                       references=(h.get("species") or {}).get("references") or 0)
    except urllib.error.HTTPError as e:
        # A sleeping or rebuilding Hugging Face Space answers 503 with an HTML page while it starts.
        _health.update(state="loading", error=f"model server starting (HTTP {e.code})")
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as e:
        _health.update(state="loading", error=f"model server not reachable yet ({e.__class__.__name__})")
    _health["checked"] = time.time()
    return dict(_health)


def _poll():
    """Background: keep checking until the service is ready (wakes a sleeping Space)."""
    try:
        for _ in range(240):                    # up to ~20 minutes
            if check_health()["state"] == "ready" and _health["species"] in ("ready", "failed", "idle"):
                return
            time.sleep(5)
    finally:
        _poller["running"] = False


def warm_up():
    if enabled() and not _poller["running"]:
        _poller["running"] = True
        threading.Thread(target=_poll, daemon=True).start()


def health():
    """Cached health; refreshed in the background when stale (never blocks a request)."""
    if enabled() and time.time() - _health["checked"] > HEALTH_TTL_S:
        if _health["state"] == "ready":
            threading.Thread(target=check_health, daemon=True).start()
        else:
            warm_up()
    return dict(_health)


def analyze(image_path, key):
    """{"length_cm", "candidates": [{"id", "species", "prob"}]} for a photo, cached. Raises on
    failure (callers fall back to the knuckle method)."""
    with _lock:
        if key in _cache:
            return _cache[key]
        if time.time() - _failed.get(key, 0) < FAIL_TTL_S:
            raise RuntimeError("model service failed on this photo a moment ago")
    try:
        return _analyze(image_path, key)
    except Exception:
        with _lock:
            _failed[key] = time.time()
        raise


def _analyze(image_path, key):
    with open(image_path, "rb") as f:
        body = json.dumps({"image": base64.b64encode(f.read()).decode()}).encode()
    req = urllib.request.Request(URL + "/analyze", data=body, method="POST",
                                 headers={"Content-Type": "application/json", "User-Agent": "TideCast/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=ANALYZE_TIMEOUT_S) as r:
            out = json.loads(r.read())
    except urllib.error.HTTPError as e:
        if e.code in (502, 503):
            _health.update(state="loading", checked=time.time())
            warm_up()
        raise RuntimeError(f"model service answered {e.code}") from e
    if not out.get("ok"):
        raise RuntimeError(out.get("error") or "model service error")
    _health.update(state="ready")
    with _lock:
        if len(_cache) > 500:
            _cache.clear()
        if out.get("species_ready", True):        # don't cache a reply missing the species
            _cache[key] = out
    return out
