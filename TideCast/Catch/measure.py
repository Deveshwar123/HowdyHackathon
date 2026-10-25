"""Math + species lookup + multi-reference median to reduce error."""
import math
import difflib
import statistics
from fish_data import FISH_DB
from knuckle_data import lookup_width

GRAMS_PER_POUND = 453.592

# Error model. CONDITION_ERROR is biological plumpness spread.
# LENGTH_ERROR is reduced because we now median across references.
LENGTH_ERROR_FRAC = 0.10
CONDITION_ERROR_FRAC = 0.12

LOOKUP = {}
for _name, _info in FISH_DB.items():
    for _alias in _info.get("aliases", []):
        LOOKUP.setdefault(_alias.lower(), _name)
for _name in FISH_DB:                      # a real species name always wins over an alias
    LOOKUP[_name.lower()] = _name


def find_fish(name):
    text = str(name).strip().lower()
    if not text or text == "unknown":
        return None, None
    key = LOOKUP.get(text)
    if not key:
        close = difflib.get_close_matches(text, list(LOOKUP), n=1, cutoff=0.85)
        key = LOOKUP[close[0]] if close else None
    return (key, FISH_DB[key]) if key else (None, None)


def grid_to_pixels(point, img_w, img_h):
    return (point[0] / 1000.0 * img_w, point[1] / 1000.0 * img_h)


def pixel_distance(p1, p2):
    return math.hypot(p1[0] - p2[0], p1[1] - p2[1])


def polyline_length_px(points, img_w, img_h):
    pts = [grid_to_pixels(p, img_w, img_h) for p in points]
    total = 0.0
    for i in range(len(pts) - 1):
        total += pixel_distance(pts[i], pts[i + 1])
    return total


def estimate(species_name, fish_spine, references, img_w, img_h,
             own_knuckle_cm=None, sex="male"):
    """
    references: list of dicts, each:
        {"knuckles": 4, "left": [x,y], "right": [x,y]}
    own_knuckle_cm: if the user measured their own 4-knuckle width, use it
                    (overrides the average for the 4-knuckle reference).
    Returns length (median of references), weight, range, warnings.
    """
    key, info = find_fish(species_name)
    if not info:
        raise ValueError(f"Species not in database: {species_name}")

    fish_px = polyline_length_px(fish_spine, img_w, img_h)

    # One length estimate per usable reference.
    length_estimates = []
    for ref in references:
        kl = grid_to_pixels(ref["left"], img_w, img_h)
        kr = grid_to_pixels(ref["right"], img_w, img_h)
        span_px = pixel_distance(kl, kr)
        if span_px <= 0:
            continue
        n = ref.get("knuckles", 4)
        if own_knuckle_cm and n == 4:
            width_cm = own_knuckle_cm          # most accurate when provided
        else:
            width_cm = lookup_width(sex, n)
        cm_per_pixel = width_cm / span_px
        length_estimates.append(fish_px * cm_per_pixel)

    if not length_estimates:
        raise ValueError("No usable knuckle reference detected.")

    # Median voting suppresses a single bad detection.
    length_cm = statistics.median(length_estimates)

    # Spread between estimates becomes an extra honest error term.
    if len(length_estimates) > 1:
        spread = (max(length_estimates) - min(length_estimates)) / length_cm
    else:
        spread = 0.0

    length_err = math.sqrt(LENGTH_ERROR_FRAC ** 2 + (spread / 2) ** 2)
    extra = []
    if len(length_estimates) > 1 and spread > 0.25:
        extra.append("The knuckle references disagreed a lot - treat the weight as rough.")
    out = from_length(key, length_cm, length_err, extra)
    out["num_references"] = len(length_estimates)
    out["method"] = "knuckles"
    return out


def from_length(species_name, length_cm, length_err_frac=LENGTH_ERROR_FRAC, extra_warnings=()):
    """Weight, range, warnings and species facts for a fish of this length (shared by the
    knuckle measurement and the learned model, so both are scored the same way)."""
    key, info = find_fish(species_name)
    if not info:
        raise ValueError(f"Species not in database: {species_name}")
    a, b = info["a"], info["b"]
    max_len = info.get("max_length_cm", math.inf)

    weight_g = a * (length_cm ** b)
    weight_lb = weight_g / GRAMS_PER_POUND
    weight_kg = weight_g / 1000.0
    weight_err_frac = math.sqrt((b * length_err_frac) ** 2 + CONDITION_ERROR_FRAC ** 2)
    low_lb = weight_lb * (1 - weight_err_frac)
    high_lb = weight_lb * (1 + weight_err_frac)

    warnings = []
    lo, hi = info.get("length_cm", (0, 0))
    if length_cm > max_len:
        warnings.append(
            f"Measured length {length_cm:.0f} cm exceeds species max "
            f"{max_len} cm - likely a scale error."
        )
    elif hi and length_cm > hi * 1.25:
        warnings.append(
            f"Measured length {length_cm:.0f} cm is well above the typical "
            f"max ({hi} cm) - double-check the grip and points."
        )
    warnings.extend(extra_warnings)

    return {
        "species": key,
        "scientific_name": info.get("scientific_name", ""),
        "rarity": info.get("rarity", "?"),
        "water": info.get("water", "?"),
        "habitat": info.get("habitat", "?"),
        "features": info.get("features", "?"),
        "diet": info.get("diet", "?"),
        "typical_range_cm": f"{lo}-{hi}",
        "length_cm": round(length_cm, 1),
        "weight_lb": round(weight_lb, 2),
        "weight_kg": round(weight_kg, 2),
        "weight_low_lb": round(max(low_lb, 0), 2),
        "weight_high_lb": round(high_lb, 2),
        "error_frac": round(weight_err_frac, 3),
        "warnings": warnings,
    }