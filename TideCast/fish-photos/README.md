# Fish photos (upload here)

Drop one realistic photo per species in this folder, named exactly as below (`.jpg`, `.png` or
`.webp` all work). A plain white background is fine: it gets removed and each fish gets a clean
white outline on black. Side-on, whole fish, any size over ~800 px wide.

When you're done, tell Claude, and the photos will be processed into `Backbone/assets/species/`
to replace the drawn fish on the species guide and leaderboard.

| File name | Species | Scientific name | Should look like |
|---|---|---|---|
| `largemouth-bass.jpg` | Largemouth Bass | *Micropterus salmoides* | Olive-green back, dark horizontal stripe along the side, jaw extends past the eye |
| `smallmouth-bass.jpg` | Smallmouth Bass | *Micropterus dolomieu* | Bronze-brown body with vertical bars, red-orange eye, jaw ends under the eye |
| `bluegill.jpg` | Bluegill | *Lepomis macrochirus* | Round flat body, dark 'ear' flap on the gill, blue tint on the cheek |
| `redear-sunfish.jpg` | Redear Sunfish | *Lepomis microlophus* | Red or orange edge on the dark gill flap, olive body with a rounded profile |
| `white-crappie.jpg` | White Crappie | *Pomoxis annularis* | Silvery body with faint vertical bars, 5-6 dorsal spines |
| `black-crappie.jpg` | Black Crappie | *Pomoxis nigromaculatus* | Dark speckled blotches on a silvery-green body, 7-8 dorsal spines |
| `yellow-perch.jpg` | Yellow Perch | *Perca flavescens* | Yellow-gold body with 6-8 dark vertical bars, orange lower fins |
| `walleye.jpg` | Walleye | *Sander vitreus* | Golden-olive body, large glassy reflective eyes, white tip on the lower tail lobe |
| `white-bass.jpg` | White Bass | *Morone chrysops* | Silvery body with thin dark horizontal stripes, deep-bodied for its length |
| `channel-catfish.jpg` | Channel Catfish | *Ictalurus punctatus* | Deeply forked tail, whiskers (barbels), small dark spots on the body |
| `blue-catfish.jpg` | Blue Catfish | *Ictalurus furcatus* | Slate-blue back, no spots, straight-edged anal fin, forked tail |
| `flathead-catfish.jpg` | Flathead Catfish | *Pylodictis olivaris* | Broad flat head, lower jaw sticks out past the upper, mottled yellow-brown body, squared tail |
| `rainbow-trout.jpg` | Rainbow Trout | *Oncorhynchus mykiss* | Pink-red stripe along the side, black spots on the back and tail |
| `brown-trout.jpg` | Brown Trout | *Salmo trutta* | Golden-brown body, dark spots with pale halos, scattered red or orange spots |
| `brook-trout.jpg` | Brook Trout | *Salvelinus fontinalis* | Dark green back with pale worm-like markings, red spots with blue halos, white-edged lower fins |
| `common-carp.jpg` | Common Carp | *Cyprinus carpio* | Large scales, two pairs of barbels at the mouth, long dorsal fin |
| `northern-pike.jpg` | Northern Pike | *Esox lucius* | Long duck-bill snout, light bean-shaped spots on a green body, dorsal fin set far back |
| `muskellunge.jpg` | Muskellunge | *Esox masquinongy* | Dark vertical bars or spots on a lighter body, pointed tail lobes, long toothy snout |
| `striped-bass.jpg` | Striped Bass | *Morone saxatilis* | Silver body with 7-8 dark horizontal stripes, two separate dorsal fins |
| `redfish.jpg` | Redfish | *Sciaenops ocellatus* | Copper-red body, one or more black spots near the tail |
| `black-drum.jpg` | Black Drum | *Pogonias cromis* | High arched back, deep body, many short barbels under the chin, dark vertical bars on young fish |
| `spotted-seatrout.jpg` | Spotted Seatrout | *Cynoscion nebulosus* | Silvery body with many black spots, two prominent canine teeth |
| `southern-flounder.jpg` | Southern Flounder | *Paralichthys lethostigma* | Flat body with both eyes on the left side, camouflaged brown coloring |
| `red-snapper.jpg` | Red Snapper | *Lutjanus campechanus* | Rosy-red body, red eye, pointed anal fin |
| `sheepshead.jpg` | Sheepshead | *Archosargus probatocephalus* | 5-6 black vertical bars on a silver-gray body, human-like teeth |
| `cobia.jpg` | Cobia | *Rachycentron canadum* | Long streamlined body, dark stripe along the side, broad flat head, short spines before the dorsal fin |
| `king-mackerel.jpg` | King Mackerel | *Scomberomorus cavalla* | Slender silver body, lateral line dips sharply below the second dorsal fin, sharp teeth |
| `mahi-mahi.jpg` | Mahi-Mahi | *Coryphaena hippurus* | Bright green, blue and gold body, one long dorsal fin, blunt forehead on large males |
| `tarpon.jpg` | Tarpon | *Megalops atlanticus* | Huge silver scales, upturned mouth, last dorsal ray trails as a long filament |
| `alligator-gar.jpg` | Alligator Gar | *Atractosteus spatula* | Long alligator-like snout with a double row of teeth, armored diamond scales |

## Processing

`python3 TideCast/fish-photos/make_species.py` (needs Pillow, numpy, scipy) cuts each fish out,
adds the white outline and writes `Backbone/assets/species/<id>.webp`. The `PHOTOS` table at the
top of the script says which uploaded photo is used for which species; any other species uses a
file named after its id (e.g. `bowfin.jpg`).

## Finding pictures automatically

```bash
pip3 install pillow numpy scipy certifi
python3 TideCast/fish-photos/fetch_photos.py
```

For every species without a picture it searches online, keeps only side-on fish on a white
background that are free to reuse, saves the pick here as `<id>.jpg` (credited in `CREDITS.md`)
and makes the cut-out. To redo one: `python3 TideCast/fish-photos/fetch_photos.py bowfin`.

- **Google Images:** add `GOOGLE_API_KEY=...` and `GOOGLE_CSE_ID=...` to `TideCast/.env`
  (a Programmable Search Engine with image search on, plus the Custom Search API enabled).
- **Without those** it uses Wikimedia Commons, preferring public-domain U.S. Fish & Wildlife and
  NOAA illustrations.

Check the Species page afterwards; if a picture is wrong, replace `<id>.*` here with your own and
run `make_species.py`.
