"""The learned fish-length model (DINOv2 image embeddings + an AutoML regressor, trained by
fish_length/cli_trainer.py), wired into the catch app.

It is optional. It switches on when its Python packages are installed
(pip3 install -r TideCast/Catch/requirements-model.txt) and the trained files are in
TideCast/Catch/fish_length/artifacts/ (automl_model.pkl, features_scaler_model.pkl,
length_scaler_model.pkl, and metrics.json from training). Without it, the catch app measures
from the angler's knuckles as before.
"""
import importlib.util
import json
import os
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
NEEDED_FILES = ("automl_model.pkl", "features_scaler_model.pkl", "length_scaler_model.pkl")
NEEDED_PACKAGES = ("torch", "torchvision", "sklearn", "flaml", "xgboost", "numpy", "PIL")


def _dirs():
    return [d for d in (os.environ.get("FISH_LENGTH_ARTIFACTS"), os.path.join(HERE, "fish_length", "artifacts"),
                        os.path.join(HERE, "artifacts")) if d]


def artifacts_dir():
    for d in _dirs():
        if all(os.path.exists(os.path.join(d, f)) for f in NEEDED_FILES):
            return d
    return None


def status():
    """{"available": bool, "reason": str} without loading anything heavy."""
    missing = [p for p in NEEDED_PACKAGES if importlib.util.find_spec(p) is None]
    if missing:
        return {"available": False, "reason": "packages not installed: " + ", ".join(missing)}
    if not artifacts_dir():
        return {"available": False, "reason": "trained model files not found in Catch/fish_length/artifacts"}
    return {"available": True, "reason": ""}


def metrics():
    """Test-set results saved by training (r2, mae in cm, n_test...), or None."""
    found = [os.path.join(d, "metrics.json") for d in [artifacts_dir()] + _dirs() if d]
    path = next((p for p in found if os.path.exists(p)), None)
    if not path:
        return None
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


_lock = threading.Lock()
_predictor = None
_failed = None
_cache = {}


def _get_predictor():
    global _predictor, _failed
    with _lock:
        if _predictor is None and _failed is None:
            try:
                import sys
                sys.path.insert(0, HERE)
                from fish_length.predictor import FishLengthPredictor
                _predictor = FishLengthPredictor(artifacts_dir=artifacts_dir(), device="auto")
            except Exception as e:  # missing download, bad pickle, out of memory...
                _failed = f"{type(e).__name__}: {e}"
        return _predictor


def warm_up():
    """Load the model in the background at start-up (the first load downloads DINOv2)."""
    if status()["available"]:
        threading.Thread(target=_get_predictor, daemon=True).start()


def ready():
    return _predictor is not None


def predict_length_cm(image_path, key=None):
    """Learned length (cm) for a photo, cached per photo; None if the model isn't available."""
    key = key or image_path
    if key in _cache:
        return _cache[key]
    if not status()["available"]:
        return None
    p = _get_predictor()
    if p is None:
        return None
    with _lock:
        value = float(p.predict_file(image_path))
    if not value > 0:
        return None
    _cache[key] = value
    return value


def load_error():
    return _failed
