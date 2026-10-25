"""Find a picture for every species that doesn't have one yet, then cut it out like the rest.

    pip3 install pillow numpy scipy certifi
    python3 TideCast/fish-photos/fetch_photos.py              # every species missing a picture
    python3 TideCast/fish-photos/fetch_photos.py bowfin wahoo # just these (replaces existing)

Where it looks:
  1. Google Images, through Google's Programmable Search API, when GOOGLE_API_KEY and
     GOOGLE_CSE_ID are set (environment or TideCast/.env). Only results Google marks as free
     to reuse (Creative Commons / public domain) are taken.
  2. Wikimedia Commons (no key needed): public-domain U.S. Fish & Wildlife / NOAA
     illustrations are preferred, since they are side-on fish on white like the rest.

A candidate is only used if it is a side-on fish on a white (or transparent) background, so
the cut-out works. Each pick is saved here as <id>.jpg/.png, credited in CREDITS.md, and turned
into Backbone/assets/species/<id>.webp by make_species.py. Check the results on the Species
page: if one is wrong, delete its <id>.* file here, drop in your own, and run make_species.py.
"""
import io
import json
import os
import ssl
import sys
import time
import urllib.parse
import urllib.request

import numpy as np
from PIL import Image

import make_species

HERE = make_species.HERE
ROOT = os.path.join(HERE, "..")
COMMONS_API = os.environ.get("COMMONS_API", "https://commons.wikimedia.org/w/api.php")
GOOGLE_API = os.environ.get("GOOGLE_SEARCH_API", "https://www.googleapis.com/customsearch/v1")
UA = "TideCast-species-fetch/1.0 (hackathon project; fish species guide)"
GOOD_LICENSES = ("public domain", "pd", "cc0", "cc by", "cc-by", "cc by-sa", "cc-by-sa")
LIKE = ("raver", "illustration", "drawing", "usfws", "fws", "fish and wildlife", "noaa", "fishwatch",
        "white background", "isolated")
AVOID = ("map", "range", "distribution", "skeleton", "skull", "egg", "larva", "fry", "juvenile", "stamp",
         "diagram", "fillet", "market", "dish", "cooked", "sushi", "aquarium", "logo", "coin", "postage")

try:
    import certifi
    SSL = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    SSL = ssl.create_default_context()


def env(name):
    if os.environ.get(name):
        return os.environ[name]
    for path in (os.path.join(ROOT, ".env"), os.path.join(ROOT, "Catch", ".env")):
        if os.path.exists(path):
            for line in open(path):
                k, _, v = line.strip().partition("=")
                if k.strip() == name and v.strip():
                    return v.strip().strip('"').strip("'")
    return None


def get(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout, context=SSL) as r:
        return r.read(12_000_000)


def score_text(text):
    t = text.lower()
    return sum(2 for w in LIKE if w in t) - sum(5 for w in AVOID if w in t)


def google_candidates(name, sci):
    key, cx = env("GOOGLE_API_KEY"), env("GOOGLE_CSE_ID")
    if not key or not cx:
        return []
    q = {"key": key, "cx": cx, "q": f"{name} {sci} fish side view white background", "searchType": "image",
         "num": 10, "imgDominantColor": "white", "safe": "active",
         "rights": "cc_publicdomain,cc_attribute,cc_sharealike"}
    try:
        data = json.loads(get(GOOGLE_API + "?" + urllib.parse.urlencode(q)))
    except Exception as e:
        print(f"   google search failed ({e})")
        return []
    out = []
    for it in data.get("items", []):
        img = it.get("image", {})
        out.append({"url": it.get("link"), "page": img.get("contextLink", it.get("link")),
                    "credit": it.get("displayLink", ""), "license": "Creative Commons (per Google)",
                    "w": img.get("width", 0), "h": img.get("height", 0),
                    "score": score_text(it.get("title", "") + " " + it.get("snippet", "")) + 1})
    return out


def commons_candidates(name, sci):
    out, seen = [], set()
    for q in (f'"{sci}" illustration', f'"{sci}"', f'"{name}" fish'):
        params = {"action": "query", "format": "json", "generator": "search", "gsrnamespace": 6,
                  "gsrsearch": q + " filetype:bitmap", "gsrlimit": 25, "prop": "imageinfo",
                  "iiprop": "url|size|mime|extmetadata", "iiurlwidth": 1400}
        try:
            data = json.loads(get(COMMONS_API + "?" + urllib.parse.urlencode(params)))
        except Exception as e:
            print(f"   commons search failed ({e})")
            continue
        for page in (data.get("query", {}).get("pages", {}) or {}).values():
            info = (page.get("imageinfo") or [{}])[0]
            title = page.get("title", "")
            if title in seen or info.get("mime") not in ("image/jpeg", "image/png"):
                continue
            seen.add(title)
            meta = info.get("extmetadata", {})
            val = lambda k: (meta.get(k, {}) or {}).get("value", "") or ""
            lic = val("LicenseShortName")
            if not any(g in lic.lower() for g in GOOD_LICENSES):
                continue
            text = " ".join([title, val("ImageDescription"), val("Artist"), val("Credit")])
            if sci.lower().split()[0] not in text.lower() and name.lower() not in text.lower():
                continue
            out.append({"url": info.get("thumburl") or info.get("url"), "page": info.get("descriptionurl", ""),
                        "credit": _plain(val("Artist")) or "Wikimedia Commons", "license": lic,
                        "w": info.get("width", 0), "h": info.get("height", 0), "score": score_text(text)})
        time.sleep(0.5)
    return out


def _plain(html):
    import re
    return re.sub(r"<[^>]+>", "", html).strip()[:120]


def usable(img):
    """Side-on fish on a white or transparent background (so the cut-out will be clean)."""
    a = np.asarray(img.convert("RGBA"))
    h, w = a.shape[:2]
    if w < 400 or w < h * 1.25:
        return False, "not a side-on picture"
    b = np.concatenate([a[:4].reshape(-1, 4), a[-4:].reshape(-1, 4), a[:, :4].reshape(-1, 4), a[:, -4:].reshape(-1, 4)])
    rgb = b[:, :3].astype(int)
    white = ((rgb.min(1) > 225) & (rgb.max(1) - rgb.min(1) < 20)) | (b[:, 3] < 30)
    if white.mean() < 0.85:
        return False, "background isn't plain white"
    mask = make_species.fish_mask(a)
    area = mask.mean()
    if not 0.08 < area < 0.85:
        return False, "fish too small or cut-out failed"
    ys, xs = np.nonzero(mask)
    if (xs.max() - xs.min()) < 1.4 * (ys.max() - ys.min()):
        return False, "doesn't look side-on"
    return True, ""


def fetch(sid, name, sci):
    cands = google_candidates(name, sci) + commons_candidates(name, sci)
    cands = [c for c in cands if c["url"] and (not c["w"] or c["w"] >= c["h"] * 1.25)]
    cands.sort(key=lambda c: -c["score"])
    for c in cands[:15]:
        try:
            img = Image.open(io.BytesIO(get(c["url"])))
            img.load()
        except Exception:
            continue
        ok, why = usable(img)
        if not ok:
            print(f"   skip {c['url'][:80]}  ({why})")
            continue
        ext = "png" if img.mode in ("RGBA", "LA", "P") else "jpg"
        for old in os.listdir(HERE):
            if old.startswith(sid + ".") and old.lower().endswith((".jpg", ".jpeg", ".png", ".webp")):
                os.remove(os.path.join(HERE, old))
        path = os.path.join(HERE, f"{sid}.{ext}")
        (img.convert("RGBA") if ext == "png" else img.convert("RGB")).save(path, quality=95)
        with open(os.path.join(HERE, "CREDITS.md"), "a") as f:
            f.write(f"- **{name}** (`{sid}.{ext}`): {c['credit']}, {c['license']}, {c['page']}\n")
        return True
    return False


def main(only):
    sys.path.insert(0, os.path.join(ROOT, "Catch"))
    from fish_data import FISH_DB
    from scoring import slug
    if not os.path.exists(os.path.join(HERE, "CREDITS.md")):
        open(os.path.join(HERE, "CREDITS.md"), "w").write("# Photo credits (added by fetch_photos.py)\n\n")
    have = lambda sid: os.path.exists(os.path.join(make_species.OUT, sid + ".webp"))
    wanted = (lambda sid: sid in only) if only else (lambda sid: not have(sid))
    todo = [(slug(n), n, i["scientific_name"]) for n, i in FISH_DB.items() if wanted(slug(n))]
    if not todo:
        print("Every species already has a picture.")
        return
    if not (env("GOOGLE_API_KEY") and env("GOOGLE_CSE_ID")):
        print("(No GOOGLE_API_KEY / GOOGLE_CSE_ID set: searching Wikimedia Commons only.)")
    done, missed = [], []
    for sid, name, sci in todo:
        print(f"{name} ({sci})")
        (done if fetch(sid, name, sci) else missed).append(sid)
        print("   ->", "saved" if sid in done else "nothing usable found")
    if done:
        make_species.main(done)
    print(f"\n{len(done)} new pictures.", "Still missing: " + ", ".join(missed) if missed else "")


if __name__ == "__main__":
    os.chdir(HERE)
    main(sys.argv[1:])
