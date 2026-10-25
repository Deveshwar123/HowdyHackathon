// Species pictures. window.fishPicture(name, image) shows the realistic photo from
// assets/species/ (centred on black; a white studio background is removed automatically) and
// falls back to an illustration (window.fishArt) for species that don't have a photo yet.
(() => {
  const SHAPES = {
    bass: { d: 'M10 52C30 28 72 16 116 20C138 22 156 30 168 38L198 18C203 15 208 19 206 24L198 52L206 80C208 85 203 89 198 86L168 66C156 74 138 82 116 84C72 88 30 76 10 52Z', eye: [30, 46], fin: 'M64 24C80 6 112 4 132 18', gill: 'M48 34C56 44 56 60 48 70' },
    deep: { d: 'M12 52C24 18 70 6 112 12C134 15 152 28 162 40L194 22C199 19 204 23 202 28L194 52L202 76C204 81 199 85 194 82L162 64C152 76 134 89 112 92C70 98 24 86 12 52Z', eye: [32, 44], fin: 'M56 14C78 0 120 0 142 18', gill: 'M50 30C60 44 60 62 50 76' },
    long: { d: 'M6 52C26 38 80 32 128 34C148 35 162 40 172 44L200 28C205 25 210 29 208 34L200 52L208 70C210 75 205 79 200 76L172 60C162 64 148 69 128 70C80 72 26 66 6 52Z', eye: [22, 49], fin: 'M96 34C106 24 124 22 136 30', gill: 'M40 40C46 47 46 58 40 64' },
    cat: { d: 'M8 56C10 38 40 30 80 32C120 34 150 40 170 46L198 28C203 25 208 29 206 34L198 54L206 74C208 79 203 83 198 80L170 64C150 70 120 76 80 76C40 76 12 72 8 56Z', eye: [26, 48], fin: 'M58 32C64 20 76 18 84 26', gill: 'M44 40C50 48 50 62 44 70', barbels: true },
    flat: { d: 'M14 52C14 24 60 14 110 14C150 14 176 30 184 44L204 36L200 52L204 68L184 60C176 74 150 90 110 90C60 90 14 80 14 52Z', eye: [40, 38], eye2: [48, 44], fin: 'M30 30C70 6 150 8 178 36', gill: '' },
    gar: { d: 'M2 52L40 47C70 40 120 38 150 42L196 30C201 28 205 32 203 37L196 52L203 67C205 72 201 76 196 74L150 62C120 66 70 64 40 57Z', eye: [48, 49], fin: 'M140 42C146 34 158 32 164 38', gill: 'M60 44C64 49 64 56 60 60' },
  };
  // [shape, back colour, belly colour, markings]
  const SPECIES = {
    'Largemouth Bass': ['bass', '#6f8a3c', '#dfe4b8', 'stripe'],
    'Smallmouth Bass': ['bass', '#8a6a3a', '#dccaa0', 'bars'],
    'Bluegill': ['deep', '#4c6878', '#e8b45a', 'bars'],
    'Redear Sunfish': ['deep', '#6f7f4a', '#ecc27a', 'ear'],
    'White Crappie': ['deep', '#a5b6ad', '#f0f3ef', 'bars'],
    'Black Crappie': ['deep', '#5f6e5e', '#dfe5dc', 'speckle'],
    'Yellow Perch': ['bass', '#c9a43a', '#f3e6ad', 'bars'],
    'Walleye': ['long', '#9a8a4a', '#ece4c4', 'none'],
    'White Bass': ['bass', '#98aab4', '#f1f5f6', 'lines'],
    'Channel Catfish': ['cat', '#7c8a94', '#eceff2', 'spots'],
    'Blue Catfish': ['cat', '#58748e', '#e1e9f0', 'none'],
    'Flathead Catfish': ['cat', '#8a7442', '#e9dcab', 'speckle'],
    'Rainbow Trout': ['long', '#6d8a7a', '#f5e9e3', 'pink'],
    'Brown Trout': ['long', '#9a7a4a', '#f1dfb4', 'spots'],
    'Brook Trout': ['long', '#55663f', '#f2a674', 'light-spots'],
    'Common Carp': ['bass', '#a08a4a', '#eedfb2', 'scales'],
    'Northern Pike': ['long', '#647540', '#e6ebc4', 'light-spots'],
    'Muskellunge': ['long', '#8a9a6a', '#ebedd4', 'bars'],
    'Striped Bass': ['bass', '#8b9da8', '#f2f5f6', 'lines'],
    'Redfish': ['bass', '#bd7a48', '#f2dbbf', 'eyespot'],
    'Black Drum': ['deep', '#626464', '#d9d9d3', 'bars'],
    'Spotted Seatrout': ['long', '#86979e', '#eff1f1', 'spots'],
    'Southern Flounder': ['flat', '#86775a', '#d9c9a2', 'speckle'],
    'Red Snapper': ['deep', '#d3624a', '#f5c4b3', 'none'],
    'Sheepshead': ['deep', '#b2b6b2', '#f0f0ec', 'bold-bars'],
    'Cobia': ['long', '#57483a', '#e3dbcc', 'stripe'],
    'King Mackerel': ['long', '#7489a0', '#eff3f6', 'none'],
    'Mahi-Mahi': ['bass', '#2f9a6a', '#f2d24a', 'blue-spots'],
    'Tarpon': ['long', '#8da2b4', '#f3f6f8', 'scales'],
    'Alligator Gar': ['gar', '#6a6a48', '#dad6b2', 'spots'],
    'Spotted Bass': ['bass', '#6f7f44', '#e3e2bc', 'speckle'],
    'Guadalupe Bass': ['bass', '#5f7a3c', '#e0e2b4', 'bars'],
    'Green Sunfish': ['deep', '#4f6a4a', '#e8d27a', 'none'],
    'Pumpkinseed': ['deep', '#6a7a54', '#f0a65a', 'speckle'],
    'Warmouth': ['deep', '#6a5a3e', '#e2cfa0', 'speckle'],
    'Freshwater Drum': ['deep', '#8e989c', '#ecefef', 'none'],
    'Bowfin': ['long', '#5f6a3e', '#d9dcae', 'none'],
    'Longnose Gar': ['gar', '#7a7a54', '#e2dfbe', 'spots'],
    'Chain Pickerel': ['long', '#6a7a3a', '#e8e8bc', 'bars'],
    'Lake Trout': ['long', '#5f6e6a', '#e8ece6', 'light-spots'],
    'Cutthroat Trout': ['long', '#8a8a5a', '#efe2c4', 'spots'],
    'Chinook Salmon': ['long', '#5f7a8a', '#eef2f2', 'spots'],
    'Coho Salmon': ['long', '#64808e', '#eef2f3', 'spots'],
    'Atlantic Croaker': ['bass', '#9a8a6a', '#efe6cf', 'lines'],
    'Bluefish': ['long', '#4f7f8e', '#eef3f4', 'none'],
    'Spanish Mackerel': ['long', '#5f7f9a', '#f0f3f5', 'blue-spots'],
    'Florida Pompano': ['deep', '#8ea0aa', '#f3eba8', 'none'],
    'Common Snook': ['long', '#8a8a72', '#f0efe6', 'stripe'],
    'Bonefish': ['long', '#9ab0bc', '#f4f6f7', 'lines'],
    'Gag Grouper': ['bass', '#6e6a62', '#d8d4c8', 'speckle'],
    'Yellowfin Tuna': ['long', '#2f4a6a', '#e8eef2', 'none'],
    'Wahoo': ['long', '#3f6a8e', '#eef3f6', 'bars'],
    'Sailfish': ['long', '#2f4a72', '#e8eef4', 'bars'],
  };
  const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  const rand = (seed) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

  function markings(kind, id, r) {
    const dark = 'rgba(20,28,24,.42)';
    switch (kind) {
      case 'stripe': return `<path d="M20 52C70 44 120 46 170 52" stroke="${dark}" stroke-width="9" fill="none" stroke-linecap="round" stroke-dasharray="14 5"/>`;
      case 'pink': return `<path d="M20 54C70 48 120 48 170 54" stroke="rgba(236,120,140,.55)" stroke-width="10" fill="none"/>` + markings('spots', id, r);
      case 'bars': case 'bold-bars': {
        const op = kind === 'bold-bars' ? .55 : .26;
        return [62, 82, 102, 122, 142].map((x) => `<rect x="${x}" y="0" width="${kind === 'bold-bars' ? 9 : 7}" height="100" fill="rgba(20,28,24,${op})" transform="rotate(8 ${x} 50)"/>`).join('');
      }
      case 'lines': return [38, 45, 52, 59, 66].map((y) => `<path d="M20 ${y}C80 ${y - 4} 130 ${y - 3} 172 ${y}" stroke="${dark}" stroke-width="1.6" fill="none"/>`).join('');
      case 'spots': case 'light-spots': case 'blue-spots': case 'speckle': {
        const n = kind === 'speckle' ? 70 : 34;
        const col = kind === 'light-spots' ? 'rgba(245,240,215,.55)' : kind === 'blue-spots' ? 'rgba(60,140,230,.75)' : 'rgba(20,24,22,.5)';
        let out = '';
        for (let i = 0; i < n; i++) out += `<circle cx="${(40 + r() * 140).toFixed(1)}" cy="${(24 + r() * 52).toFixed(1)}" r="${(kind === 'speckle' ? 0.8 + r() * 2.4 : 1.2 + r() * 2.2).toFixed(1)}" fill="${col}"/>`;
        return out;
      }
      case 'scales': {
        let out = '';
        for (let y = 26; y < 82; y += 8) for (let x = 46 + ((y / 8) % 2) * 6; x < 172; x += 12) out += `<path d="M${x} ${y}a6 6 0 0 1 12 0" stroke="rgba(255,255,255,.22)" fill="none" stroke-width="1.2"/>`;
        return out;
      }
      case 'eyespot': return '<circle cx="160" cy="50" r="6.5" fill="#17120f"/><circle cx="160" cy="50" r="8.5" fill="none" stroke="rgba(255,230,180,.6)" stroke-width="1.5"/>';
      case 'ear': return '<ellipse cx="54" cy="48" rx="6" ry="8" fill="#1d1a16"/><path d="M58 42a8 9 0 0 1 0 13" stroke="#e0503a" stroke-width="2.5" fill="none"/>';
      default: return '';
    }
  }

  window.fishArt = (name) => {
    const [shape, back, belly, mark] = SPECIES[name] || ['bass', '#7b95a8', '#e6eef3', 'none'];
    const S = SHAPES[shape];
    const id = `f${hash(name).toString(36)}`;
    const r = rand(hash(name));
    const eye = (p) => `<circle cx="${p[0]}" cy="${p[1]}" r="4.2" fill="#0b1520"/><circle cx="${p[0] + 1.2}" cy="${p[1] - 1.2}" r="1.4" fill="#fff" opacity=".85"/>`;
    return `<svg viewBox="0 0 220 100" aria-hidden="true">
      <defs>
        <linearGradient id="${id}g" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${back}"/><stop offset=".55" stop-color="${back}" stop-opacity=".92"/><stop offset="1" stop-color="${belly}"/></linearGradient>
        <linearGradient id="${id}h" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".28"/><stop offset=".4" stop-color="#fff" stop-opacity="0"/></linearGradient>
        <clipPath id="${id}c"><path d="${S.d}"/></clipPath>
      </defs>
      <path d="${S.fin}" stroke="${back}" stroke-width="7" fill="none" stroke-linecap="round" opacity=".85"/>
      <path d="${S.d}" fill="url(#${id}g)"/>
      <g clip-path="url(#${id}c)">${markings(mark, id, r)}<rect width="220" height="100" fill="url(#${id}h)"/></g>
      ${S.gill ? `<path d="${S.gill}" stroke="rgba(10,16,20,.35)" stroke-width="2" fill="none"/>` : ''}
      ${S.barbels ? '<path d="M12 58C2 62-2 70 0 76M14 60C8 68 8 76 12 82M14 50C4 46 0 40 2 34" stroke="#2a2a26" stroke-width="1.6" fill="none" opacity=".8"/>' : ''}
      ${eye(S.eye)}${S.eye2 ? eye(S.eye2) : ''}
    </svg>`;
  };
  window.FISH_SVG = window.fishArt('');

  window.fishPicture = (name, image) => (image
    ? `<img class="fish-photo" src="${image}" alt="${name}" loading="lazy" decoding="async">`
    : window.fishArt(name));

  // White (or near-white) studio backgrounds become transparent, so the fish sits on black.
  const cutout = (img) => {
    if (img.dataset.done) return;
    img.dataset.done = '1';
    const k = Math.min(1, 900 / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * k)), h = Math.max(1, Math.round(img.naturalHeight * k));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(img, 0, 0, w, h);
    let d;
    try { d = x.getImageData(0, 0, w, h); } catch { return; }
    const p = d.data;
    const light = (i) => 765 - (p[i] + p[i + 1] + p[i + 2]);   // 0 = pure white
    const corners = [0, (w - 1) * 4, (h - 1) * w * 4, ((h - 1) * w + w - 1) * 4];
    if (corners.some((i) => p[i + 3] < 250 || light(i) > 60)) {   // already transparent or not a light background
      img.classList.add('ready');
      return;
    }
    const seen = new Uint8Array(w * h);
    const stack = [];
    for (let i = 0; i < w; i++) stack.push(i, (h - 1) * w + i);
    for (let j = 0; j < h; j++) stack.push(j * w, j * w + w - 1);
    while (stack.length) {
      const n = stack.pop();
      if (seen[n]) continue;
      const i = n * 4;
      if (light(i) > 70) continue;
      seen[n] = 1;
      p[i + 3] = 0;
      const cx = n % w, cy = (n / w) | 0;
      if (cx > 0) stack.push(n - 1);
      if (cx < w - 1) stack.push(n + 1);
      if (cy > 0) stack.push(n - w);
      if (cy < h - 1) stack.push(n + w);
    }
    // Soften the edge: pixels next to the removed background fade with their lightness.
    for (let n = 0; n < w * h; n++) {
      if (seen[n]) continue;
      const cx = n % w;
      if (!(seen[n - 1] && cx > 0) && !(seen[n + 1] && cx < w - 1) && !seen[n - w] && !seen[n + w]) continue;
      const i = n * 4;
      p[i + 3] = Math.min(255, Math.round((light(i) / 140) * 255));
    }
    x.putImageData(d, 0, 0);
    img.src = c.toDataURL('image/png');
    img.classList.add('ready');
  };
  document.addEventListener('load', (e) => {
    if (e.target.classList?.contains('fish-photo')) cutout(e.target);
  }, true);
})();
