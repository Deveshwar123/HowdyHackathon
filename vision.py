"""Gemini call: species + spine points + two knuckle spans (4 and 3)."""
import io
import os
import time
from dotenv import load_dotenv

load_dotenv()

from google import genai
from google.genai import errors, types
from PIL import Image, ImageOps
from pydantic import BaseModel, Field, ValidationError
from fish_data import FISH_DB

MODELS = ["gemini-flash-latest", "gemini-flash-lite-latest"]
RETRIES_PER_MODEL = 3
REQUEST_TIMEOUT_MS = 90_000
MAX_IMAGE_SIDE = 1024
MOCK_MODE = False  # True = skip the real API call and return fake data for testing

_api_key = os.environ.get("GEMINI_API_KEY")
if not _api_key:
    raise RuntimeError("GEMINI_API_KEY is not set (check your .env file).")

client = genai.Client(
    api_key=_api_key,
    http_options=types.HttpOptions(timeout=REQUEST_TIMEOUT_MS),
)


class VisionUnavailable(Exception):
    pass


class Point(BaseModel):
    x: int = Field(description="0=left, 1000=right")
    y: int = Field(description="0=top, 1000=bottom")


class CatchAnalysis(BaseModel):
    fish_detected: bool
    hand_detected: bool
    species: str = Field(description="Common name, or 'Unknown'.")
    confidence: float
    fish_spine: list[Point] = Field(
        description="6 ordered points snout->tail along the centerline, even if curved."
    )
    knuckle4_left: Point = Field(description="Outer edge of the index knuckle")
    knuckle4_right: Point = Field(description="Outer edge of the pinky knuckle")
    knuckle3_left: Point = Field(description="Outer edge of the middle knuckle")
    knuckle3_right: Point = Field(description="Outer edge of the pinky knuckle")


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


def _make_config():
    return types.GenerateContentConfig(
        response_mime_type="application/json",
        response_schema=CatchAnalysis,
        temperature=0.0,
        thinking_config=types.ThinkingConfig(thinking_level="LOW"),
    )


def call_gemini(contents):
    last_error = None
    for model in MODELS:
        for attempt in range(RETRIES_PER_MODEL):
            try:
                resp = client.models.generate_content(
                    model=model, contents=contents, config=_make_config()
                )
                print("answered by:", resp.model_version)
                return resp
            except errors.ServerError as e:      # 5xx, including 503 overloaded
                last_error = e
                print(f"{model} attempt {attempt + 1} failed: {e}")
                time.sleep(2 ** attempt)
            except errors.ClientError as e:       # 4xx, including 429 quota
                last_error = e
                print(f"{model} client error: {e}")
                break                             # don't retry a 4xx on this model
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


def analyze_image(image_bytes: bytes):
    # Fix phone rotation, shrink. Everything downstream uses THIS image.
    img = ImageOps.exif_transpose(Image.open(io.BytesIO(image_bytes))).convert("RGB")
    img.thumbnail((MAX_IMAGE_SIDE, MAX_IMAGE_SIDE))
    w, h = img.size

    if MOCK_MODE:
        return _mock_data(), w, h, img

    resp = call_gemini([img, PROMPT])

    try:
        data = CatchAnalysis.model_validate_json(resp.text).model_dump()
    except ValidationError:
        print("Bad JSON from model:", resp.text)
        raise ValueError("The AI returned an unreadable answer. Please try again.")

    # Convert pydantic point dicts into [x, y] lists for measure.py.
    data["fish_spine"] = [[p["x"], p["y"]] for p in data["fish_spine"]]
    for key in ("knuckle4_left", "knuckle4_right",
                "knuckle3_left", "knuckle3_right"):
        data[key] = [data[key]["x"], data[key]["y"]]

    return data, w, h, img