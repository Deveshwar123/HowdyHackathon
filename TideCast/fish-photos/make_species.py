"""Turn the photos in this folder into the species pictures the site shows.

For each species: remove the white / checkerboard background, keep only the fish, add a white
outline, and save a transparent WebP to Backbone/assets/species/<id>.webp (shown on black).

    python3 TideCast/fish-photos/make_species.py        # needs Pillow, numpy, scipy

Any other species is picked up from a file named after its id (e.g. `bowfin.jpg`), which is
what fetch_photos.py saves.
"""
import glob
import os
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "Backbone", "assets", "species")
WIDTH = 1000          # output fish width, px
OUTLINE = 5           # white outline thickness, px

# species id -> photo in this folder (picked to match each species' description).
PHOTOS = {
    "largemouth-bass": "largemouth-bass.jpg",
    "smallmouth-bass": "smallmouth-bass.jpg",
    "bluegill": "bluegill.jpg",
    "redear-sunfish": "redear-sunfish.jpg",
    "white-crappie": "white-crappie.jpg",
    "black-crappie": "black-crappie.jpg",
    "yellow-perch": "yellow-perch.jpg",
    "walleye": "walleye.jpg",
    "white-bass": "white-bass.jpg",
    "striped-bass": "striped-bass.jpg",
    "channel-catfish": "channel-catfish.jpg",
    "blue-catfish": "blue-catfish.jpg",
    "flathead-catfish": "flathead-catfish.jpg",
    "rainbow-trout": "rainbow-trout.jpg",
    "brown-trout": "brown-trout.jpg",
    "brook-trout": "brook-trout.png",
    "common-carp": "Common carp.png",
    "black-drum": "Black Drum.png",
    "sheepshead": "Sheepshead.png",
    "southern-flounder": "Southern-Flounder.png",
    "spotted-seatrout": "Spotted Seatrout.png",
    "cobia": "Cobia.png",
    "mahi-mahi": "Mahi Mahi.png",
    "red-snapper": "Northern Red Snapper.png",
    # Light bean-shaped spots on a green body = northern pike.
    "northern-pike": "Chain Pickerel.png",
    # Dark bars/spots on a lighter body = muskellunge.
    "muskellunge": "northern pike.png",
    # Huge silver scales, upturned mouth = tarpon.
    "tarpon": "Atlantic Croaker.png",
    "wahoo": "Wahoo.png",
}


# Photos where the fish faces right: mirrored so every fish faces left like the rest.
FLIP = {"alligator-gar", "arctic-grayling", "bonefish", "common-snook", "bowfin"}

# Photos with a pale halo, blocky patch or soft shadow around the fish: remove any light grey.
LOOSE = {"flathead-catfish.jpg", "yellow-perch.jpg", "Chain Pickerel.png", "Spotted Seatrout.png", "Black Drum.png"}


def fish_mask(rgba, loose=False):
    rgb = rgba[..., :3].astype(np.int16)
    if (rgba[..., 3] < 128).mean() > 0.05:                  # real transparency
        mask = rgba[..., 3] >= 128
    else:
        # Background: light, grey-ish pixels (white, checkerboard, soft studio shadow)
        # connected to the image border.
        # The threshold comes from this photo's own border, so silvery bellies don't leak away.
        lo, hi = rgb.min(-1), rgb.max(-1)
        border = np.concatenate([lo[:3].ravel(), lo[-3:].ravel(), lo[:, :3].ravel(), lo[:, -3:].ravel()])
        floor = min(np.percentile(border, 2) - 8, 245)
        bgish = (lo > 175) & (hi - lo < 28) if loose else (lo > floor) & (hi - lo < 16)
        lab, _ = ndimage.label(bgish)
        edge = np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))
        bg = np.isin(lab, edge[edge > 0])
        mask = ~bg
    mask = ndimage.binary_opening(mask, iterations=2)
    lab, n = ndimage.label(mask)
    if n > 1:                                                # keep the fish, drop text/specks
        sizes = ndimage.sum(mask, lab, range(1, n + 1))
        mask = lab == (1 + int(np.argmax(sizes)))
    mask = ndimage.binary_fill_holes(ndimage.binary_closing(mask, iterations=2))
    return mask


def process(src, dst):
    im = Image.open(src).convert("RGBA")
    if os.path.basename(dst).rsplit(".", 1)[0] in FLIP:
        im = im.transpose(Image.FLIP_LEFT_RIGHT)
    a = np.asarray(im)
    mask = fish_mask(a, os.path.basename(src) in LOOSE)
    ys, xs = np.nonzero(mask)
    pad = 4
    box = (max(xs.min() - pad, 0), max(ys.min() - pad, 0), min(xs.max() + pad + 1, a.shape[1]), min(ys.max() + pad + 1, a.shape[0]))
    fish = im.crop(box)
    m = Image.fromarray((mask[box[1]:box[3], box[0]:box[2]] * 255).astype(np.uint8))
    k = WIDTH / fish.width
    size = (WIDTH, max(1, round(fish.height * k)))
    fish = fish.resize(size, Image.LANCZOS)
    m = np.asarray(m.resize(size, Image.LANCZOS), np.float32) / 255.0
    # Pull the edge in a touch so no background fringe is left, then soften it.
    m = ndimage.gaussian_filter(np.clip((m - 0.5) * 2.5 + 0.5, 0, 1), 0.6)

    # Canvas with room for the outline.
    P = OUTLINE + 6
    H, W = size[1] + 2 * P, size[0] + 2 * P
    body = np.zeros((H, W), np.float32)
    body[P:P + size[1], P:P + size[0]] = m
    rgb = np.zeros((H, W, 3), np.float32)
    rgb[P:P + size[1], P:P + size[0]] = np.asarray(fish, np.float32)[..., :3]

    # White outline: the fish shape grown by OUTLINE px, antialiased.
    dist = ndimage.distance_transform_edt(body < 0.5)
    ring = np.clip(OUTLINE + 0.5 - dist, 0, 1)
    alpha = np.maximum(body, ring)
    col = rgb * body[..., None] + 255.0 * (1 - body[..., None])
    out = np.dstack([np.clip(col, 0, 255), alpha * 255]).astype(np.uint8)
    Image.fromarray(out, "RGBA").save(dst, "WEBP", quality=90, method=6)


def species_ids():
    sys.path.insert(0, os.path.join(HERE, "..", "Catch"))
    from fish_data import FISH_DB
    from scoring import slug
    return [slug(name) for name in FISH_DB]


def photo_for(sid):
    if sid in PHOTOS:
        return os.path.join(HERE, PHOTOS[sid])
    for path in sorted(glob.glob(os.path.join(HERE, sid + ".*"))):
        if path.lower().endswith((".jpg", ".jpeg", ".png", ".webp")):
            return path
    return None


def main(only=None):
    os.makedirs(OUT, exist_ok=True)
    for sid in only or species_ids():
        src = photo_for(sid)
        if not src or not os.path.exists(src):
            print("no photo", sid)
            continue
        try:
            process(src, os.path.join(OUT, sid + ".webp"))
            print("ok", sid, "<-", os.path.basename(src))
        except Exception as e:  # one bad photo shouldn't stop the rest
            print("failed", sid, e)


if __name__ == "__main__":
    main(sys.argv[1:] or None)
