#!/usr/bin/env python3
"""Applies Pelagic's extensions to the compiled page bundle and index.html (no source is in the repo).

Re-run after editing species.js:  python3 tools/patch_bundle.py

Idempotent: replacements already applied are skipped. Each pattern must match exactly once.
"""
import os
import sys

BUNDLE = os.path.join(os.path.dirname(__file__), "..", "_next", "static", "chunks", "page-D2klT2o5.js")

PATCHES = [
    # Species list comes from species.js when present.
    ("P=[{id:`bluefin`", "P=window.PELAGIC_SPECIES||[{id:`bluefin`"),
    # Expose the Cesium viewer so pelagic-gfw.js can add layers.
    ("t.current=o,", "t.current=o,window.pelagicViewer=o,window.dispatchEvent(new CustomEvent(`pelagic:viewer`,{detail:o})),"),
    # Category filter lists every group used in species.js.
    ("[`All species`,`Open ocean`,`Sharks & rays`,`Reef fish`]", "[`All species`,...new Set(P.map(e=>e.group))]"),
    ("`STARTER FIELD GUIDE · 7 SPECIES`", "`FIELD GUIDE · ${P.length} SPECIES & GROUPS`"),
    ("`OBIS · 7-species starter collection`", "`OBIS · ${P.length} species & groups · live records`"),
    ("`No matching species in this starter field guide.`", "`No matching species in this field guide.`"),
    # Group entries (e.g. all sharks) show the recorded species, not the group name.
    ("(0,I.jsx)(`h3`,{children:L.name})", "(0,I.jsx)(`h3`,{children:H.scientificName||L.name})"),
    ("Queries retrieve up to 500 records. Cached samples contain up to 180.",
     "Live queries retrieve thousands of records per species from OBIS. Cached samples contain up to 500."),
    ("curated seven-species field guide", "curated field guide of fish species and whole groups"),
    ("filters the seven-species guide", "filters the field guide"),
    # The explorer panel (pelagic-gfw.js) owns what is drawn: the atlas no longer fetches or
    # plots its own observation points unless window.PELAGIC_APP_POINTS is set.
    ("Promise.all(P.map(async e=>{try{", "Promise.all((window.PELAGIC_APP_POINTS?P:[]).map(async e=>{try{"),
    ("let n=new URLSearchParams({species:L.scientific});", "if(!window.PELAGIC_APP_POINTS)throw Error(`off`);let n=new URLSearchParams({species:L.scientific});"),
    ("e.entities.removeAll(),z&&$.forEach", "e.entities.removeAll(),window.PELAGIC_APP_POINTS&&z&&$.forEach"),
]

src = open(BUNDLE, encoding="utf-8").read()
for old, new in PATCHES:
    if new in src:
        continue
    count = src.count(old)
    if count != 1:
        sys.exit(f"pattern found {count} times, expected 1: {old}")
    src = src.replace(old, new)
open(BUNDLE, "w", encoding="utf-8").write(src)
print("bundle patched")

# ---------------------------------------------------------------------------
# Re-render the server-rendered sidebar in index.html from species.js so React
# hydrates without a mismatch. Mirrors the markup the page component produces.
import re

ROOT = os.path.join(os.path.dirname(__file__), "..")
species_src = open(os.path.join(ROOT, "species.js"), encoding="utf-8").read()
SPECIES = re.findall(r"\{ id: `([^`]*)`, name: `([^`]*)`, scientific: `([^`]*)`, group: `([^`]*)`", species_src)
if not SPECIES:
    sys.exit("no species found in species.js (entries must start with id, name, scientific, group)")


def esc(text):
    return (text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;").replace("'", "&#x27;"))


CHEVRON = ('<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" '
           'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" '
           'class="lucide lucide-chevron-right" aria-hidden="true"><path d="m9 18 6-6-6-6"></path></svg>')
n = len(SPECIES)
groups = list(dict.fromkeys(g for *_, g in SPECIES))
options = '<option selected="">All species</option>' + "".join(f"<option>{esc(g)}</option>" for g in groups)
rows = "".join(
    f'<button class="species-row {"selected" if i == 0 else ""}"><span class="species-number">{i + 1:02d}</span>'
    f"<div><strong>{esc(name)}</strong><i>{esc(sci)}</i><small>{esc(group)}</small></div>{CHEVRON}</button>"
    for i, (_, name, sci, group) in enumerate(SPECIES)
)

html_path = os.path.join(ROOT, "index.html")
html = open(html_path, encoding="utf-8").read()
replacements = [
    (r'<select aria-label="Species category">.*?</select><span>\d+<!-- --> SPECIES</span>',
     f'<select aria-label="Species category">{options}</select><span>{n}<!-- --> SPECIES</span>'),
    (r'<div class="area-discovery"><span>[^<]*</span></div>',
     f'<div class="area-discovery"><span>FIELD GUIDE · {n} SPECIES &amp; GROUPS</span></div>'),
    (r'<div class="species-list">.*?</div><div class="sidebar-footer"><div>[^<]*<small>',
     f'<div class="species-list">{rows}</div><div class="sidebar-footer"><div>OBIS · {n} species &amp; groups · live records<small>'),
]
for pattern, new in replacements:
    html, count = re.subn(pattern, lambda _m, new=new: new, html, count=1, flags=re.S)
    if count != 1:
        sys.exit(f"index.html: could not find {pattern[:40]}")
open(html_path, "w", encoding="utf-8").write(html)
print(f"index.html sidebar rendered for {n} species")
