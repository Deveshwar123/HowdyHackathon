"""Population-average knuckle widths (cm). Used when the angler's own
measurement is unknown (e.g. internet photos). Values you provided."""

KNUCKLE_WIDTHS_CM = {
    ("male",   5): 8.9,   # full hand width
    ("female", 5): 7.9,
    ("male",   4): 8.4,   # index to pinky  <-- default
    ("female", 4): 7.4,
    ("male",   3): 5.6,   # middle to pinky
    ("female", 3): 4.8,
}

DEFAULT_SEX = "male"
DEFAULT_KNUCKLES = 4  # index-to-pinky is the most commonly visible span


def lookup_width(sex, knuckles):
    return KNUCKLE_WIDTHS_CM.get(
        (sex, knuckles),
        KNUCKLE_WIDTHS_CM[(DEFAULT_SEX, DEFAULT_KNUCKLES)],
    )