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


def info():
    """Facts about the shipped model (model_info.json): where it's from, how many photos it
    was trained on, the length range."""
    for d in [artifacts_dir()] + _dirs():
        path = d and os.path.join(d, "model_info.json")
        if path and os.path.exists(path):
            try:
                with open(path) as f:
                    return json.load(f)
            except (OSError, ValueError):
                return None
    return None


_lock = threading.Lock()
_predictor = None
_cache = {}
# idle -> loading -> ready | failed. Loading the first time downloads DINOv2 (~4 GB).
_load = {"state": "idle", "error": "", "since": 0.0}


def _load_now():
    global _predictor
    import sys
    import time
    _load.update(state="loading", error="", since=time.time())
    print("  Length model: loading (the first time downloads DINOv2, about 4 GB)...", flush=True)
    os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
    try:
        sys.path.insert(0, HERE)
        from fish_length.predictor import FishLengthPredictor
        p = FishLengthPredictor(artifacts_dir=artifacts_dir(), device="auto")
        with _lock:
            _predictor = p
        _load.update(state="ready")
        print(f"  Length model: ready on {p.utils.device} ({time.time() - _load['since']:.0f} s)", flush=True)
    except Exception as e:  # download blocked, bad pickle, out of memory...
        _load.update(state="failed", error=_explain(e))
        print("  Length model: FAILED to load - " + _load["error"], flush=True)


def _explain(e):
    """A load failure in words an angler can act on."""
    text = f"{type(e).__name__}: {e}"
    low = text.lower()
    if "certificate_verify_failed" in low:
        return ("couldn't download the image model: this Python can't verify secure websites. On a Mac, "
                "open Applications > Python 3.x > Install Certificates.command, then restart TideCast")
    if isinstance(e, MemoryError) or "out of memory" in low:
        return "not enough memory: the model needs about 8 GB of free RAM"
    if "urlopen error" in low or "connection" in low or "timed out" in low:
        return "couldn't download the image model (about 4 GB): check the internet connection and restart TideCast"
    if isinstance(e, (ImportError, ModuleNotFoundError)):
        return f"a package is missing ({e}); click Install the length model again"
    return text


def warm_up():
    """Start loading in the background (never blocks a request)."""
    if status()["available"] and _load["state"] in ("idle", "failed"):
        _load["state"] = "loading"
        threading.Thread(target=_load_now, daemon=True).start()


def ready():
    return _predictor is not None


def load_state():
    return dict(_load)


_emb_cache = {}


def embed_file(image_path):
    """DINOv2 features for any image (no caching); the model must be loaded."""
    with _lock:
        return _predictor.utils.embed_image(image_path)


def embedding(image_path, key=None):
    """DINOv2 features of a catch photo, cached per photo, shared by the length model and the
    species finder so each photo goes through DINOv2 once. None while the model isn't loaded."""
    key = key or image_path
    if key in _emb_cache:
        return _emb_cache[key]
    if _predictor is None:
        return None
    feats = embed_file(image_path)
    if len(_emb_cache) > 200:
        _emb_cache.clear()
    _emb_cache[key] = feats
    return feats


def predict_length_cm(image_path, key=None):
    """Learned length (cm) for a photo, cached per photo. None while the model isn't installed or
    is still loading; callers fall back to the knuckle method then."""
    key = key or image_path
    if key in _cache:
        return _cache[key]
    if not status()["available"]:
        return None
    if _predictor is None:
        warm_up()
        return None
    feats = embedding(image_path, key=key)
    with _lock:
        value = float(_predictor.predict_features(feats))
    if not value > 0:
        return None
    _cache[key] = value
    return value


def load_error():
    return _load["error"] or None
