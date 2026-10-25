"""Catch API: upload a photo, analyze it, adjust the points, post it to the leaderboard.

Served by ../FishMigration/server.py (standard library only), which routes:
  POST /api/catch/upload    {image: base64 JPEG}                  -> photo id + size
  POST /api/catch/analyze   {photo, sex, own_knuckle_cm}           -> AI points + measurement
  POST /api/catch/measure   {photo, species, spine, k4, k3, ...}   -> measurement for edited points
  POST /api/catch/submit    {photo, angler, species, points..., location} -> saved + rank
  GET  /api/leaderboard?period=week|all&species=&limit=
  GET  /api/species         every species with rarity and points
  GET  /api/stats           live totals for the home page
Each handler returns (http_status, json_dict).
"""
import base64
import json
import os
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import db           # noqa: E402
import measure      # noqa: E402
import scoring      # noqa: E402
import vision       # noqa: E402
from fish_data import FISH_DB  # noqa: E402

# The same photo can't be posted twice.
ENABLE_DUPLICATE_CHECK = True

# Allowed knuckle width (cm). Stops people typing a huge number to inflate fish.
MIN_KNUCKLE_CM = 6.0
MAX_KNUCKLE_CM = 10.0

PHOTOS = os.path.join(HERE, "photos")
MAX_PHOTO_BYTES = 6 * 1024 * 1024
PHOTO_ID = re.compile(r"^[0-9a-f]{64}$")


def init():
    db.init_db()
    os.makedirs(PHOTOS, exist_ok=True)
    _seed_samples()
    _prune_unposted()


# ---- helpers ---------------------------------------------------------------

def jpeg_size(data):
    """(width, height) from a JPEG's frame header, or None."""
    if data[:2] != b"\xff\xd8":
        return None
    i = 2
    while i + 9 < len(data):
        if data[i] != 0xFF:
            i += 1
            continue
        marker = data[i + 1]
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
            i += 2
            continue
        seg_len = int.from_bytes(data[i + 2:i + 4], "big")
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            h = int.from_bytes(data[i + 5:i + 7], "big")
            w = int.from_bytes(data[i + 7:i + 9], "big")
            return w, h
        i += 2 + seg_len
    return None


def _photo_path(photo_id):
    if not isinstance(photo_id, str) or not PHOTO_ID.match(photo_id):
        raise ValueError("bad photo id")
    return os.path.join(PHOTOS, photo_id + ".jpg")


def _photo_size(photo_id):
    path = _photo_path(photo_id)
    if not os.path.exists(path):
        raise FileNotFoundError("Photo not found. Upload it again.")
    with open(path, "rb") as f:
        size = jpeg_size(f.read())
    if not size:
        raise ValueError("That photo couldn't be read. Try another one.")
    return size


def _point(p):
    x, y = float(p[0]), float(p[1])
    if not (-50 <= x <= 1050 and -50 <= y <= 1050):
        raise ValueError("point outside the photo")
    return [x, y]


def _references(payload):
    refs = []
    for n, key in ((4, "k4"), (3, "k3")):
        pair = payload.get(key)
        if pair and len(pair) == 2:
            refs.append({"knuckles": n, "left": _point(pair[0]), "right": _point(pair[1])})
    return refs


def _knuckle(payload):
    v = float(payload.get("own_knuckle_cm") or 0)
    if v and not (MIN_KNUCKLE_CM <= v <= MAX_KNUCKLE_CM):
        raise ValueError(f"Knuckle width must be between {MIN_KNUCKLE_CM:.0f} and {MAX_KNUCKLE_CM:.0f} cm.")
    return v or None


def _measure(payload, w, h):
    key, info = measure.find_fish(payload.get("species", ""))
    if not info:
        raise LookupError("Species not recognized in our database.")
    spine = [_point(p) for p in payload.get("spine") or []]
    if len(spine) < 2:
        raise ValueError("Mark the fish from snout to tail.")
    refs = _references(payload)
    if not refs:
        raise ValueError("Mark your knuckles so we have a scale.")
    sex = "female" if payload.get("sex") == "female" else "male"
    result = measure.estimate(key, spine, refs, w, h, own_knuckle_cm=_knuckle(payload), sex=sex)
    pts = scoring.score(info, result["length_cm"], result["weight_lb"])
    result["points"] = pts["total"]
    result["points_breakdown"] = pts
    result["length_in"] = round(result["length_cm"] / 2.54, 1)
    return info, result


def _err(status, message, **extra):
    return status, {"ok": False, "error": message, **extra}


# ---- handlers ----------------------------------------------------------------

def upload(payload):
    raw = payload.get("image") or ""
    if "," in raw[:80]:
        raw = raw.split(",", 1)[1]
    try:
        data = base64.b64decode(raw, validate=True)
    except (ValueError, TypeError):
        return _err(400, "That file isn't a photo we can read.")
    if len(data) > MAX_PHOTO_BYTES:
        return _err(413, "That photo is too large.")
    size = jpeg_size(data)
    if not size:
        return _err(400, "That file isn't a photo we can read.")
    photo_id = db.image_hash(data)
    if ENABLE_DUPLICATE_CHECK and db.is_duplicate(photo_id):
        return _err(400, "This photo was already submitted.")
    with open(_photo_path(photo_id), "wb") as f:
        f.write(data)
    return 200, {"ok": True, "photo": photo_id, "width": size[0], "height": size[1]}


def analyze(payload):
    try:
        w, h = _photo_size(payload.get("photo"))
        with open(_photo_path(payload["photo"]), "rb") as f:
            data = vision.analyze_image(f.read())
    except vision.VisionUnavailable as e:
        reason = str(e)
        if reason in ("no_key", "bad_key"):
            msg = ("Automatic measuring isn't set up on this server (no Gemini API key)." if reason == "no_key"
                   else "The Gemini API key was rejected.")
            return _err(503, msg + " You can mark the fish and your knuckles yourself.", manual=True)
        return _err(503, "The AI is busy. Try again shortly, or mark the points yourself.", manual=True)
    except (FileNotFoundError, ValueError) as e:
        return _err(400, str(e))

    analysis = {k: data.get(k) for k in ("fish_detected", "hand_detected", "species", "confidence",
                                         "fish_spine", "knuckle4_left", "knuckle4_right",
                                         "knuckle3_left", "knuckle3_right")}
    points = {"spine": data["fish_spine"],
              "k4": [data["knuckle4_left"], data["knuckle4_right"]],
              "k3": [data["knuckle3_left"], data["knuckle3_right"]]}
    if not data.get("fish_detected"):
        return _err(400, "No fish detected. Retake the photo.", analysis=analysis)
    if not data.get("hand_detected"):
        return _err(400, "Knuckles not visible. Retake so your knuckles face the camera, "
                         "or mark them yourself.", analysis=analysis, points=points, manual=True)
    key, info = measure.find_fish(data.get("species", "Unknown"))
    if not info:
        return _err(400, "Species not recognized in our database. Pick it from the list.",
                    analysis=analysis, points=points, manual=True)
    try:
        _, result = _measure({**payload, "species": key, **points}, w, h)
    except (ValueError, LookupError) as e:
        return _err(400, str(e), analysis=analysis, points=points, manual=True)
    result["confidence"] = data.get("confidence")
    return 200, {"ok": True, "analysis": analysis, "points": points, "result": result}


def measure_points(payload):
    try:
        w, h = _photo_size(payload.get("photo"))
        _, result = _measure(payload, w, h)
    except (FileNotFoundError, ValueError, LookupError) as e:
        return _err(400, str(e))
    return 200, {"ok": True, "result": result}


def submit(payload):
    angler = re.sub(r"\s+", " ", str(payload.get("angler") or "")).strip()[:40]
    if not angler:
        return _err(400, "Add your name for the leaderboard.")
    photo = payload.get("photo")
    try:
        w, h = _photo_size(photo)
        if ENABLE_DUPLICATE_CHECK and db.is_duplicate(photo):
            return _err(400, "This photo was already submitted.")
        _, result = _measure(payload, w, h)     # recomputed here; the browser's numbers aren't trusted
    except (FileNotFoundError, ValueError, LookupError) as e:
        return _err(400, str(e))
    if any("exceeds species max" in msg for msg in result["warnings"]):
        return _err(400, result["warnings"][0])
    location = re.sub(r"\s+", " ", str(payload.get("location") or "")).strip()[:80] or None
    lat = lon = None
    try:
        if payload.get("lat") is not None and payload.get("lon") is not None:
            lat, lon = round(float(payload["lat"]), 3), round(float(payload["lon"]), 3)
    except (TypeError, ValueError):
        pass
    new_id = db.save_catch(angler, result, photo, points=result["points"], location=location,
                           lat=lat, lon=lon, photo=photo + ".jpg")
    return 200, {"ok": True, "id": new_id, "result": result,
                 "rank_week": db.rank_of(new_id, "week"), "rank_all": db.rank_of(new_id, "all")}


def leaderboard(query):
    period = "week" if (query.get("period") or ["all"])[0] == "week" else "all"
    species = (query.get("species") or [""])[0].strip() or None
    limit = max(1, min(100, int((query.get("limit") or ["50"])[0] or 50)))
    rows = db.top_catches(limit=limit, species=species, period=period)
    for r in rows:
        r.pop("image_hash", None)
        info = FISH_DB.get(r["species"], {})
        r["rarity"] = info.get("rarity", "")
        r["length_in"] = round(r["length_cm"] / 2.54, 1)
    return 200, {"ok": True, "period": period, "species": species, "rows": rows,
                 "week_start": db.week_start()}


def species(_query=None):
    return 200, {"ok": True, "species": scoring.species_table(FISH_DB), "rules": scoring.rules()}


def stats(_query=None):
    s = db.stats()
    return 200, {"ok": True, **s, "species_known": len(FISH_DB), "ai": bool(vision.api_key())}


def photo_bytes(name):
    """A posted catch photo (only ones on the leaderboard are served)."""
    if not re.fullmatch(r"[0-9a-f]{64}\.jpg", name or ""):
        return None
    path = os.path.join(PHOTOS, name)
    if not os.path.exists(path) or not db.photo_posted(name):
        return None
    with open(path, "rb") as f:
        return f.read()


# ---- start-up ----------------------------------------------------------------

def _seed_samples():
    """Demo leaderboard rows (marked as samples) so a fresh install isn't empty.
    Turn off with TIDECAST_SAMPLES=0, or delete them with db.py's sample flag."""
    if os.environ.get("TIDECAST_SAMPLES", "1") == "0" or db.count():
        return
    with open(os.path.join(HERE, "samples.json"), encoding="utf-8") as f:
        samples = json.load(f)
    now = time.time()
    since_monday = now - db.week_start()
    for s in samples:
        info = FISH_DB[s["species"]]
        length = s.get("length_cm") or scoring.length_for_weight(info, s["weight_lb"])
        weight = scoring.weight_lb(info, length)
        result = {"species": s["species"], "length_cm": round(length, 1), "weight_lb": round(weight, 2),
                  "weight_low_lb": round(weight * 0.85, 2), "weight_high_lb": round(weight * 1.15, 2)}
        pts = scoring.score(info, length, weight)["total"]
        db.save_catch(s["angler"], result, f"sample-{s['angler']}", points=pts, location=s["location"],
                      sample=True,
                      # "this week" samples stay inside the current week
                      created_at=now - min(s["days_ago"] * 86400, since_monday * s["days_ago"] / 6)
                      if s["days_ago"] < 7 else now - s["days_ago"] * 86400)


def _prune_unposted(max_age_s=2 * 86400):
    """Delete uploaded photos that were never posted (after two days)."""
    posted = set()
    conn = db.get_conn()
    for r in conn.execute("SELECT photo FROM catches WHERE photo IS NOT NULL"):
        posted.add(r["photo"])
    conn.close()
    cutoff = time.time() - max_age_s
    for name in os.listdir(PHOTOS):
        path = os.path.join(PHOTOS, name)
        if name not in posted and os.path.getmtime(path) < cutoff:
            os.remove(path)
