// Fishing waters used when the live lookup (/api/water, OpenStreetMap) is unavailable, and the
// default location. Every lat/lon is open water (checked against Sentinel-2 water classification).
// `sat` points at satellite imagery baked into assets/ (Copernicus Sentinel-2, 10 m); waters without
// it fetch imagery from the server at runtime (/api/sat).
window.TIDECAST_HOME = { name: 'College Station, TX', lat: 30.628, lon: -96.334 };

window.TIDECAST_WATERS = [
  {
    name: 'Lake Bryan', kind: 'Reservoir', lat: 30.7104, lon: -96.4737, water: 'fresh',
    fish: ['largemouth', 'hybrid-striper', 'channel-catfish', 'white-crappie', 'bluegill'],
    sat: {
      region: 'assets/region.jpg', regionB: [-96.80, 30.42, -96.14, 30.94],
      lake: 'assets/lake-sat.jpg', mask: 'assets/lake-mask.png', lakeB: [-96.5205, 30.6689, -96.4265, 30.7499],
    },
  },
  { name: 'Lake Somerville', kind: 'Reservoir', lat: 30.307, lon: -96.5855, water: 'fresh', fish: ['white-bass', 'hybrid-striper', 'largemouth', 'channel-catfish', 'white-crappie'] },
  { name: 'Lake Conroe', kind: 'Reservoir', lat: 30.45, lon: -95.585, water: 'fresh', fish: ['largemouth', 'hybrid-striper', 'white-crappie', 'channel-catfish'] },
  { name: 'Lake Belton', kind: 'Reservoir', lat: 31.14, lon: -97.52, water: 'fresh', fish: ['largemouth', 'spotted-bass', 'hybrid-striper', 'white-bass'] },
  { name: 'Lake Waco', kind: 'Reservoir', lat: 31.58, lon: -97.23, water: 'fresh', fish: ['white-bass', 'largemouth', 'blue-catfish', 'white-crappie'] },
  { name: 'Galveston Bay', kind: 'Bay', lat: 29.5, lon: -94.9, water: 'salt', fish: ['redfish', 'speckled-trout', 'flounder', 'black-drum'] },
];
