"""Gemini call: species + spine points + two knuckle spans (4 and 3).

Uses the Gemini REST API directly (standard library only), with the same prompt and
response schema as before. The browser sends an already-rotated, downscaled JPEG
(max side MAX_IMAGE_SIDE), so no image library is needed here.

Key: the GEMINI_API_KEY environment variable, or a line GEMINI_API_KEY=... in
TideCast/.env or TideCast/Catch/.env.
"""
import base64
import json
import os
import re
import time
import urllib.error
import urllib.request

from fish_data import FISH_DB

MODELS = ["gemini-flash-latest", "gemini-flash-lite-latest"]
RETRIES_PER_MODEL = 3
REQUEST_TIMEOUT_S = 90
MAX_IMAGE_SIDE = 1024
MOCK_MODE = False  # True = skip the real API call and return fake data for testing
API_URL = os.environ.get("GEMINI_URL", "https://generativelanguage.googleapis.com/v1beta")

HERE = os.path.dirname(os.path.abspath(__file__))


def _read_env_key():
    for path in (os.path.join(HERE, ".env"), os.path.join(os.path.dirname(HERE), ".env")):
        try:
            with open(path, encoding="utf-8") as f:
                for line in f:
                    m = re.match(r"\s*(?:export\s+)?GEMINI_API_KEY\s*=\s*['\"]?([^'\"\s#]+)", line)
                    if m:
                        return m.group(1)
        except OSError:
            pass
    return ""


def api_key():
    return (os.environ.get("GEMINI_API_KEY") or _read_env_key()).strip()


class VisionUnavailable(Exception):
    pass


def _point(desc):
    return {"type": "OBJECT", "description": desc, "required": ["x", "y"],
            "properties": {"x": {"type": "INTEGER", "description": "0=left, 1000=right"},
                           "y": {"type": "INTEGER", "description": "0=top, 1000=bottom"}}}


# Same fields as the original pydantic CatchAnalysis model.
SCHEMA = {
    "type": "OBJECT",
    "required": ["fish_detected", "hand_detected", "species", "confidence", "fish_spine",
                 "knuckle4_left", "knuckle4_right", "knuckle3_left", "knuckle3_right"],
    "properties": {
        "fish_detected": {"type": "BOOLEAN"},
        "hand_detected": {"type": "BOOLEAN"},
        "species": {"type": "STRING", "description": "Common name, or 'Unknown'."},
        "confidence": {"type": "NUMBER"},
        "fish_spine": {"type": "ARRAY", "items": _point("spine point"),
                       "description": "6 ordered points snout->tail along the centerline, even if curved."},
        "knuckle4_left": _point("Outer edge of the index knuckle"),
        "knuckle4_right": _point("Outer edge of the pinky knuckle"),
        "knuckle3_left": _point("Outer edge of the middle knuckle"),
        "knuckle3_right": _point("Outer edge of the pinky knuckle"),
    },
}

PROMPT = f"""You are analyzing a photo of a caught fish held by hand.
Identify the species by common name from this list, or 'Unknown':
{", ".join(FISH_DB)}.

Return on a 1000x1000 grid (x left->right, y top->bottom):
- fish_spine: exactly 6 points, in order from the snout tip (point 1) to the
  farthest tip of the tail fin (point 6), following the fish's centerline,
  evenly spaced so the line traces any curve in the body.
- knuckle4_left / knuckle4_right: the two OUTER edges of the four-knuckle span
  (index knuckle to pinky knuckle) on the gripping hand.
- knuckle3_left / knuckle3_right: the OUTER edges of the three-knuckle span
  (middle knuckle to pinky knuckle) on the same hand.
Set fish_detected true if a fish is clearly visible. Set hand_detected true if
a hand with knuckles facing the camera is visible. If something is not clearly
visible, still give best-guess points and set the matching flag false.
Place points precisely on the edges."""


def call_gemini(jpeg_bytes):
    key = api_key()
    if not key:
        raise VisionUnavailable("no_key")
    body = json.dumps({
        "contents": [{"parts": [
            {"inline_data": {"mime_type": "image/jpeg", "data": base64.b64encode(jpeg_bytes).decode()}},
            {"text": PROMPT},
        ]}],
        "generationConfig": {"responseMimeType": "application/json", "responseSchema": SCHEMA, "temperature": 0.0},
    }).encode()
    last_error = None
    for model in MODELS:
        for attempt in range(RETRIES_PER_MODEL):
            req = urllib.request.Request(f"{API_URL}/models/{model}:generateContent", data=body, method="POST",
                                         headers={"Content-Type": "application/json", "x-goog-api-key": key})
            try:
                with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_S) as r:
                    resp = json.loads(r.read())
                print("answered by:", resp.get("modelVersion", model))
                return resp["candidates"][0]["content"]["parts"][0]["text"]
            except urllib.error.HTTPError as e:
                last_error = f"{model}: HTTP {e.code} {e.read()[:200]!r}"
                print(last_error)
                if e.code >= 500:                      # 5xx, including 503 overloaded
                    time.sleep(2 ** attempt)
                    continue
                if e.code in (401, 403):               # bad key: no point trying other models
                    raise VisionUnavailable("bad_key")
                break                                  # other 4xx (incl. 429 quota): next model
            except (urllib.error.URLError, TimeoutError, KeyError, IndexError) as e:
                last_error = f"{model}: {e}"
                print(last_error)
                time.sleep(2 ** attempt)
    raise VisionUnavailable(str(last_error))


def _mock_data():
    """Fake response for testing without spending Gemini quota."""
    return {
        "fish_detected": True,
        "hand_detected": True,
        "species": "Largemouth Bass",
        "confidence": 0.9,
        "fish_spine": [[150, 500], [280, 490], [420, 500],
                       [560, 510], [700, 505], [840, 500]],
        "knuckle4_left": [300, 430],
        "knuckle4_right": [372, 430],
        "knuckle3_left": [330, 430],
        "knuckle3_right": [378, 430],
    }


def analyze_image(jpeg_bytes):
    """Returns the analysis with points as [x, y] lists on the 1000x1000 grid."""
    if MOCK_MODE:
        return _mock_data()
    text = call_gemini(jpeg_bytes)
    try:
        data = json.loads(text)
        data["fish_spine"] = [[int(p["x"]), int(p["y"])] for p in data["fish_spine"]]
        for key in ("knuckle4_left", "knuckle4_right", "knuckle3_left", "knuckle3_right"):
            data[key] = [int(data[key]["x"]), int(data[key]["y"])]
    except (ValueError, KeyError, TypeError):
        print("Bad JSON from model:", text[:500])
        raise ValueError("The AI returned an unreadable answer. Please try again.")
    return data
