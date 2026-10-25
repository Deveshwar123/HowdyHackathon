// TideCast stats, shown in the "By the numbers" section of the home page.
// Market figures are sourced (see `sources`). `live` figures come from the catch database.
// Placeholders show "—" until you set `value` (and `placeholder: false`).
// Each stat: { value | live, label, prefix?, suffix?, decimals?, note?, placeholder? }
window.TIDECAST_STATS = {
  market: [
    { value: 57.9, decimals: 1, suffix: 'M', label: 'Americans went fishing in 2024', note: 'A record — 19% of the U.S. population (age 6+)' },
    { value: 43, suffix: 'M+', label: 'fished in freshwater', note: 'Lakes, rivers and reservoirs — our first market' },
    { value: 5.1, decimals: 1, suffix: 'M', label: 'first-time anglers in 2024', note: '9% of all participants' },
    { value: 230.5, decimals: 1, prefix: '$', suffix: 'B', label: 'yearly U.S. economic output of sportfishing', note: 'Supporting 1.1 million jobs' },
  ],
  // `live` stats come from the server (/api/stats) when the page loads.
  impact: [
    { live: 'catches', label: 'catches measured and posted' },
    { live: 'anglers', label: 'anglers on the board' },
    { live: 'species', label: 'species landed' },
    { live: 'total_lb', decimals: 0, suffix: ' lb', label: 'of fish weighed, no scale' },
  ],
  model: [
    { value: null, decimals: 1, suffix: '%', label: 'species identification accuracy', note: 'Top-1, on held-out catch photos', placeholder: true },
    { live: 'species_known', label: 'species it can measure', note: 'Each with its own length–weight curve' },
    { value: 2, label: 'knuckle spans per photo', note: 'Index–pinky and middle–pinky; the median wins' },
    { live: 'avg_err_pct', prefix: '±', suffix: '%', label: 'average weight range', note: 'Length error plus natural plumpness spread' },
  ],
  sources: [
    { name: 'RBFF / Outdoor Foundation, 2025 Special Report on Fishing (2024 data)', url: 'https://www.nmma.org/press/article/25183' },
    { name: 'American Sportfishing Association, Sportfishing in America (2025)', url: 'https://asafishing.org/industry/sportfishing-economic-impact/' },
  ],
};
