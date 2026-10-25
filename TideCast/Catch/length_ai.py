"""Wraps the DINOv2 + AutoML fish-length predictor (centimeters) and combines
it with our species database and weight formula."""
import difflib
from fish_length.predictor import FishLengthPredictor   # learned model [6]
from fish_data import FISH_DB                            # species DB [2]

_predictor = None

# Build the same name/alias lookup fish_simple.py uses [1].
LOOKUP = {}
for _name, _info in FISH_DB.items():
    LOOKUP[_name.lower()] = _name
    for _alias in _info.get("aliases", []):
        LOOKUP[_alias.lower()] = _name


def find_fish(name):
    """Resolve a species name (tolerates aliases/typos), same logic as [1]."""
    text = str(name).strip().lower()
    if not text or text == "unknown":
        return None, None
    key = LOOKUP.get(text)
    if not key:
        close = difflib.get_close_matches(text, list(LOOKUP), n=1, cutoff=0.85)
        key = LOOKUP[close[0]] if close else None
    return (key, FISH_DB[key]) if key else (None, None)


def _get_predictor():
    global _predictor
    if _predictor is None:
        _predictor = FishLengthPredictor(artifacts_dir="artifacts", device="cpu")
    return _predictor


def predict_length_cm(image_path):
    """Predicted length in centimeters for one image. [6]"""
    return float(_get_predictor().predict_file(image_path))


def weight_kg(info, length_cm):
    """Same formula the app already uses: a * length_cm**b / 1000. [1][2]"""
    a = info.get("a", 0.012)
    b = info.get("b", 3.0)
    return round(a * length_cm ** b / 1000, 2)


def analyze(image_path, species_name):
    """Full result: profile from FISH_DB + learned length + weight."""
    key, info = find_fish(species_name)
    if not info:
        return {"ok": False, "error": "Species not recognized in the database."}

    length_cm = predict_length_cm(image_path)
    # Clamp to species max so an overestimate can't go impossible [1][2].
    length_cm = min(length_cm, info.get("max_length_cm", length_cm))

    lo, hi = info.get("length_cm", (0, 0))
    return {
        "ok": True,
        "species": key,
        "scientific_name": info.get("scientific_name", ""),
        "rarity": info.get("rarity", "?"),
        "water": info.get("water", "?"),
        "habitat": info.get("habitat", "?"),
        "features": info.get("features", "?"),
        "diet": info.get("diet", "?"),
        "typical_range_cm": f"{lo}-{hi}",
        "length_cm": round(length_cm, 1),
        "weight_kg": weight_kg(info, length_cm),
        "method": "learned (DINOv2 + regression)",
    }