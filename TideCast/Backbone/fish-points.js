// TideCast points table — what each species is worth when you log a catch.
// Placeholder values: replace with the real scoring rules when they're decided.
// `water` is 'fresh' or 'salt' (used to suggest fish for a spot); `atlas` links a species to its
// entry in the FishMigration atlas (TideCast/FishMigration/species.js) where one exists.
window.TIDECAST_FISH = [
  // Freshwater — Texas lakes, rivers and reservoirs
  { id: 'largemouth', name: 'Largemouth bass', scientific: 'Micropterus salmoides', water: 'fresh', points: 120 },
  { id: 'spotted-bass', name: 'Spotted bass', scientific: 'Micropterus punctulatus', water: 'fresh', points: 100 },
  { id: 'hybrid-striper', name: 'Hybrid striped bass', scientific: 'Morone chrysops × saxatilis', water: 'fresh', points: 140 },
  { id: 'white-bass', name: 'White bass', scientific: 'Morone chrysops', water: 'fresh', points: 70 },
  { id: 'channel-catfish', name: 'Channel catfish', scientific: 'Ictalurus punctatus', water: 'fresh', points: 80 },
  { id: 'blue-catfish', name: 'Blue catfish', scientific: 'Ictalurus furcatus', water: 'fresh', points: 110 },
  { id: 'flathead', name: 'Flathead catfish', scientific: 'Pylodictis olivaris', water: 'fresh', points: 130 },
  { id: 'white-crappie', name: 'White crappie', scientific: 'Pomoxis annularis', water: 'fresh', points: 60 },
  { id: 'bluegill', name: 'Bluegill', scientific: 'Lepomis macrochirus', water: 'fresh', points: 30 },
  { id: 'redear', name: 'Redear sunfish', scientific: 'Lepomis microlophus', water: 'fresh', points: 40 },
  { id: 'alligator-gar', name: 'Alligator gar', scientific: 'Atractosteus spatula', water: 'fresh', points: 250 },
  // Saltwater — Texas bays and the Gulf
  { id: 'redfish', name: 'Red drum', scientific: 'Sciaenops ocellatus', water: 'salt', points: 150, atlas: 'redfish' },
  { id: 'speckled-trout', name: 'Spotted seatrout', scientific: 'Cynoscion nebulosus', water: 'salt', points: 110 },
  { id: 'flounder', name: 'Southern flounder', scientific: 'Paralichthys lethostigma', water: 'salt', points: 120 },
  { id: 'black-drum', name: 'Black drum', scientific: 'Pogonias cromis', water: 'salt', points: 90 },
  { id: 'sheepshead', name: 'Sheepshead', scientific: 'Archosargus probatocephalus', water: 'salt', points: 70 },
  { id: 'snapper', name: 'Northern red snapper', scientific: 'Lutjanus campechanus', water: 'salt', points: 180, atlas: 'snapper' },
  { id: 'tarpon', name: 'Atlantic tarpon', scientific: 'Megalops atlanticus', water: 'salt', points: 300, atlas: 'tarpon' },
  { id: 'mahi', name: 'Mahi-mahi', scientific: 'Coryphaena hippurus', water: 'salt', points: 220, atlas: 'mahi' },
];

// Fish to suggest for a spot when nothing more specific is known about it.
window.TIDECAST_DEFAULT_FISH = {
  fresh: ['largemouth', 'channel-catfish', 'white-crappie', 'bluegill'],
  salt: ['redfish', 'speckled-trout', 'flounder', 'black-drum'],
};
