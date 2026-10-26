"""Species from the photo, using the length model's own DINOv2 image features (no Gemini needed).

Every species in fish_data.py has reference pictures (Backbone/assets/species/<id>.* and
fish-photos/<name>.*). Each reference is embedded once with the same DINOv2 the length model uses,
plus a mirrored copy so a fish facing either way matches. A catch photo's embedding is compared with
all of them (cosine similarity); the best match per species, turned into a softmax, gives the
candidates. The index is cached in species_index.npz next to this file and rebuilt when the
reference pictures change.

It runs only when the length model is installed and loaded. The angler always sees the pick and
can change it.
"""
import json
import os
import re
import threading

import length_ai
import remote_model

HERE = os.path.dirname(os.path.abspath(__file__))
TIDECAST = os.path.dirname(HERE)
REF_DIRS = [os.path.join(TIDECAST, "Backbone", "assets", "species"), os.path.join(TIDECAST, "fish-photos")]
EXTRA_NAMES = {"northern-red-snapper": "red-snapper"}   # fish-photos file names that differ from the id
INDEX_FILE = os.environ.get("SPECIES_INDEX") or os.path.join(HERE, "species_index.npz")
IMAGE_EXT = (".jpg", ".jpeg", ".png", ".webp")
TEMPERATURE = 0.03          # softmax sharpness over cosine similarities
CONFIDENT = 0.45            # top probability above which the pick is shown as a match, not a guess

_state = {"state": "idle", "error": "", "n_refs": 0}
_index = None               # (names[list], matrix[np.ndarray N x D, rows L2-normalized])
_lock = threading.Lock()


def _norm(name):
    return re.sub(r"[^a-z0-9]+", "-", os.path.splitext(name)[0].lower()).strip("-")


def references(species_ids):
    """[(species_id, path)] for every reference picture of a known species."""
    out = []
    for d in REF_DIRS:
        if not os.path.isdir(d):
            continue
        for f in sorted(os.listdir(d)):
            if not f.lower().endswith(IMAGE_EXT):
                continue
            name = re.sub(r"-\d+$", "", _norm(f))          # largemouth-bass-2.jpg -> largemouth-bass
            sid = EXTRA_NAMES.get(name, name)
            if sid in species_ids:
                out.append((sid, os.path.join(d, f)))
    return out


def _signature(refs):
    """Fingerprint of the reference pictures by content (not file times), so an index built on one
    computer is reused on another, e.g. a fresh git clone on the model server."""
    import hashlib
    h = hashlib.sha1()
    for sid, p in refs:
        with open(p, "rb") as f:
            h.update(f"{sid}:{os.path.basename(p)}:".encode() + hashlib.sha1(f.read()).digest())
    return json.dumps({"v": 2, "n": len(refs), "sha1": h.hexdigest()})


def _build(species_ids):
    global _index
    import numpy as np
    from PIL import Image, ImageOps
    refs = references(species_ids)
    sig = _signature(refs)
    try:
        cached = np.load(INDEX_FILE, allow_pickle=False)
        if str(cached["sig"]) == sig:
            with _lock:
                _index = ([str(n) for n in cached["names"]], cached["matrix"].astype("float32"))
            _state.update(state="ready", n_refs=len(refs))
            return
    except (OSError, KeyError, ValueError):
        pass
    _state.update(state="building", n_refs=len(refs))
    print(f"  Species finder: indexing {len(refs)} reference pictures (once)...", flush=True)
    names, rows = [], []
    tmp = os.path.join(HERE, ".species_flip.png")
    for sid, path in refs:
        rows.append(length_ai.embed_file(path))
        names.append(sid)
        ImageOps.mirror(Image.open(path).convert("RGB")).save(tmp)   # facing the other way
        rows.append(length_ai.embed_file(tmp))
        names.append(sid)
    try:
        os.remove(tmp)
    except OSError:
        pass
    m = np.stack(rows).astype("float32")
    m /= np.linalg.norm(m, axis=1, keepdims=True) + 1e-8
    try:
        # float16 halves the file (it's committed to the repo so a fresh server starts instantly)
        np.savez_compressed(INDEX_FILE, names=np.array(names), matrix=m.astype("float16"), sig=np.array(sig))
    except OSError:
        pass
    with _lock:
        _index = (names, m)
    _state.update(state="ready")
    print("  Species finder: ready", flush=True)


def warm_up(species_ids):
    """Build (or load) the reference index in the background once the length model is loaded."""
    if remote_model.enabled():                  # the hosted model service has its own index
        return
    if _state["state"] in ("building", "ready", "waiting"):
        return
    _state["state"] = "waiting"

    def run():
        import time
        while not length_ai.ready():                      # the model loads in its own thread
            if length_ai.load_state()["state"] == "failed" or not length_ai.status()["available"]:
                _state.update(state="idle")
                return
            time.sleep(1)
        try:
            _build(set(species_ids))
        except Exception as e:  # never let this break the app
            _state.update(state="failed", error=f"{type(e).__name__}: {e}")
            print("  Species finder: FAILED - " + _state["error"], flush=True)

    threading.Thread(target=run, daemon=True).start()


def ready():
    if remote_model.enabled():
        return remote_model.health()["species"] == "ready"
    return _index is not None


def state():
    if remote_model.enabled():
        h = remote_model.health()
        st = h["species"] if h["species"] not in ("idle", "waiting", "building") else "loading"
        if h["state"] == "failed":
            st = "failed"
        return {"state": st, "error": h["error"] if st == "failed" else "", "n_refs": h["references"]}
    return dict(_state)


def identify(image_path, key=None, top=3):
    """[{"id", "prob", "similarity"}] best first, or None when the index isn't ready."""
    if remote_model.enabled():
        if not length_ai.ready():               # asleep or starting: the page will retry
            return None
        found = remote_model.analyze(image_path, key or image_path).get("candidates") or []
        return [{"id": c["id"], "prob": c["prob"], "similarity": None} for c in found[:top]] or None
    if _index is None:
        return None
    import numpy as np
    e = length_ai.embedding(image_path, key=key)
    if e is None:
        return None
    e = np.asarray(e, dtype="float32")
    e /= np.linalg.norm(e) + 1e-8
    names, m = _index
    sims = m @ e
    best = {}
    for sid, s in zip(names, sims.tolist()):
        if s > best.get(sid, -2.0):
            best[sid] = s
    ids = list(best)
    vals = np.array([best[i] for i in ids])
    p = np.exp((vals - vals.max()) / TEMPERATURE)
    p /= p.sum()
    order = np.argsort(-p)[:top]
    return [{"id": ids[i], "prob": round(float(p[i]), 3), "similarity": round(float(vals[i]), 3)} for i in order]
