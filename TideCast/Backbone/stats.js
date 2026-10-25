// TideCast stats, shown in the "By the numbers" section after the leaderboard.
// Market figures are sourced (see `sources`). Impact and model figures are PLACEHOLDERS: set
// `value` to the real number and `placeholder: false` once you have it (value: null shows "—").
// Each stat: { value, label, prefix?, suffix?, decimals?, note?, placeholder? }
window.TIDECAST_STATS = {
  market: [
    { value: 57.9, decimals: 1, suffix: 'M', label: 'Americans went fishing in 2024', note: 'A record — 19% of the U.S. population (age 6+)' },
    { value: 43, suffix: 'M+', label: 'fished in freshwater', note: 'Lakes, rivers and reservoirs — our first market' },
    { value: 5.1, decimals: 1, suffix: 'M', label: 'first-time anglers in 2024', note: '9% of all participants' },
    { value: 230.5, decimals: 1, prefix: '$', suffix: 'B', label: 'yearly U.S. economic output of sportfishing', note: 'Supporting 1.1 million jobs' },
  ],
  impact: [
    { value: null, label: 'catches logged', placeholder: true },
    { value: null, label: 'active anglers', placeholder: true },
    { value: null, label: 'waters fished', placeholder: true },
    { value: null, suffix: '%', label: 'of logged fish released', placeholder: true },
  ],
  model: [
    { value: null, decimals: 1, suffix: '%', label: 'species identification accuracy', note: 'Top-1, on held-out catch photos', placeholder: true },
    { value: null, decimals: 1, suffix: '%', label: 'length estimate within ±1 in', placeholder: true },
    { value: (window.TIDECAST_FISH || []).length, label: 'species scored today', note: 'From fish-points.js' },
    { value: null, suffix: ' s', decimals: 1, label: 'from upload to points', placeholder: true },
  ],
  sources: [
    { name: 'RBFF / Outdoor Foundation, 2025 Special Report on Fishing (2024 data)', url: 'https://www.nmma.org/press/article/25183' },
    { name: 'American Sportfishing Association, Sportfishing in America (2025)', url: 'https://asafishing.org/industry/sportfishing-economic-impact/' },
  ],
};
