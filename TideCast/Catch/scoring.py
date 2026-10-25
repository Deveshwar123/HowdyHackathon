"""TideCast points. One rule set, used by the server and shown on the site.

points = rarity base + 10 per pound + trophy bonus (longer than the species' typical max)
"""
RARITY_POINTS = {"Common": 50, "Uncommon": 100, "Rare": 200, "Epic": 350, "Legendary": 600}
POINTS_PER_LB = 10
TROPHY_BONUS = 150
RARITY_ORDER = list(RARITY_POINTS)


def score(info, length_cm, weight_lb):
    base = RARITY_POINTS.get(info.get("rarity"), 50)
    typical_max = (info.get("length_cm") or (0, 0))[1]
    trophy = TROPHY_BONUS if typical_max and length_cm > typical_max else 0
    total = base + round(POINTS_PER_LB * max(weight_lb, 0)) + trophy
    return {"total": int(total), "base": base, "weight": round(POINTS_PER_LB * max(weight_lb, 0)), "trophy": trophy}


def slug(name):
    return "".join(c if c.isalnum() else "-" for c in name.lower()).strip("-").replace("--", "-")


def weight_lb(info, length_cm):
    return info["a"] * length_cm ** info["b"] / 453.592


def length_for_weight(info, lb):
    return (lb * 453.592 / info["a"]) ** (1 / info["b"])


def species_table(fish_db):
    """Every species with what a typical and a trophy catch is worth (for the site)."""
    out = []
    for name, info in fish_db.items():
        lo, hi = info.get("length_cm", (0, 0))
        typical = score(info, (lo + hi) / 2, weight_lb(info, (lo + hi) / 2))["total"]
        trophy_len = hi * 1.1
        out.append({
            "id": slug(name), "name": name, "scientific": info.get("scientific_name", ""),
            "water": info.get("water", ""), "habitat": info.get("habitat", ""),
            "features": info.get("features", ""), "diet": info.get("diet", ""),
            "rarity": info.get("rarity", "Common"), "base": RARITY_POINTS.get(info.get("rarity"), 50),
            "length_cm": [lo, hi], "max_length_cm": info.get("max_length_cm"),
            "typical_lb": round(weight_lb(info, (lo + hi) / 2), 1),
            "points_typical": typical,
            "points_trophy": score(info, trophy_len, weight_lb(info, trophy_len))["total"],
            "aliases": info.get("aliases", []),
        })
    out.sort(key=lambda s: (RARITY_ORDER.index(s["rarity"]) if s["rarity"] in RARITY_ORDER else 0, s["name"]))
    return out


def rules():
    return {"rarity": RARITY_POINTS, "per_lb": POINTS_PER_LB, "trophy": TROPHY_BONUS}

