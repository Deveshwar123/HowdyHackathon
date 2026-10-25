"""FastAPI app: upload page, analyze endpoint, leaderboard."""
import base64
from io import BytesIO
from dotenv import load_dotenv

# Must run BEFORE `import vision`, which reads GEMINI_API_KEY at import time.
load_dotenv()

from fastapi import FastAPI, Request, UploadFile, File, Form
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.templating import Jinja2Templates
from PIL import ImageDraw

import db
import measure
import vision

# Set to True before the demo so the same photo can't be submitted twice.
ENABLE_DUPLICATE_CHECK = False

# Allowed knuckle width (cm). Stops people typing a huge number to inflate fish.
MIN_KNUCKLE_CM = 6.0
MAX_KNUCKLE_CM = 10.0

app = FastAPI(title="Fish Catch Leaderboard")
templates = Jinja2Templates(directory="templates")
db.init_db()


@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    return templates.TemplateResponse(request, "index.html", {})


from fish_data import FISH_DB

@app.get("/leaderboard", response_class=HTMLResponse)
def leaderboard(request: Request, species: str = None):
    try:
        return templates.TemplateResponse(request, "leaderboard.html", {
            "catches": db.top_catches(species=species),
            "species": FISH_DB,
            "selected": species,
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        return HTMLResponse(
            f"<pre>Leaderboard error: {type(e).__name__}: {e}</pre>",
            status_code=500,
        )


@app.post("/analyze")
async def analyze(
    angler: str = Form(...),
    sex: str = Form("male"),                          # "male" or "female"
    own_knuckle_cm: float = Form(0.0),                # 0 = use averages
    file: UploadFile = File(...),
):
    try:
        image_bytes = await file.read()

        img_hash = db.image_hash(image_bytes)
        if ENABLE_DUPLICATE_CHECK and db.is_duplicate(img_hash):
            return JSONResponse(
                {"ok": False, "error": "This photo was already submitted."},
                status_code=400,
            )

        try:
            data, w, h, img = await run_in_threadpool(
                vision.analyze_image, image_bytes
            )
        except vision.VisionUnavailable:
            return JSONResponse(
                {"ok": False, "error": "The AI is busy. Try again shortly."},
                status_code=503,
            )

        if not data.get("fish_detected"):
            return JSONResponse(
                {"ok": False, "error": "No fish detected. Retake the photo."},
                status_code=400,
            )
        if not data.get("hand_detected"):
            return JSONResponse(
                {"ok": False, "error": "Knuckles not visible. Retake so your "
                                       "knuckles face the camera."},
                status_code=400,
            )

        key, info = measure.find_fish(data.get("species", "Unknown"))
        if not info:
            return JSONResponse(
                {"ok": False, "error": "Species not recognized in our database."},
                status_code=400,
            )

        references = [
            {"knuckles": 4,
             "left": data["knuckle4_left"], "right": data["knuckle4_right"]},
            {"knuckles": 3,
             "left": data["knuckle3_left"], "right": data["knuckle3_right"]},
        ]

        result = measure.estimate(
            data["species"], data["fish_spine"], references, w, h,
            own_knuckle_cm=(own_knuckle_cm or None),
            sex=sex,
        )

        if any("exceeds species max" in msg for msg in result["warnings"]):
            return JSONResponse(
                {"ok": False, "error": result["warnings"][0]}, status_code=400
            )

        result["confidence"] = data.get("confidence", None)
        overlay = make_overlay(img, data, w, h)
        db.save_catch(angler, result, img_hash)

        return JSONResponse({
            "ok": True, "result": result, "overlay_png_b64": overlay,
        })

    except Exception as e:
        import traceback
        traceback.print_exc()
        return JSONResponse(
            {"ok": False, "error": f"Server error: {type(e).__name__}: {e}"},
            status_code=500,
        )


def make_overlay(img, data, w, h):
    img = img.copy()
    draw = ImageDraw.Draw(img)

    def px(point):
        return measure.grid_to_pixels(point, w, h)

    spine = [px(p) for p in data["fish_spine"]]
    k4 = [px(data["knuckle4_left"]), px(data["knuckle4_right"])]
    k3 = [px(data["knuckle3_left"]), px(data["knuckle3_right"])]

    draw.line(spine, fill=(255, 255, 0), width=5)      # fish = yellow
    draw.line(k4, fill=(0, 255, 255), width=5)         # 4-knuckle = cyan
    draw.line(k3, fill=(255, 0, 255), width=5)         # 3-knuckle = magenta
    for p in spine + k4 + k3:
        r = 7
        draw.ellipse([p[0]-r, p[1]-r, p[0]+r, p[1]+r],
                     outline=(255, 255, 255), width=2)

    buf = BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()