// Pelagic explorer: a Where → What → Results flow over the globe.
//   1. Where   — add one or more areas (click the globe, presets, or place search)
//   2. What    — pick the data: fish (OBIS), fishing activity (GFW 4Wings), events
//                (GFW Events), boundaries (GFW context layers), dates
//   3. Results — one card per area with only the chosen data; vessels open a profile
//                (GFW Vessels + Insights). The globe shows nothing until "Show on map",
//                and then only inside the chosen areas.
// All API calls go through server.py, which holds the GFW token.
(() => {
  'use strict';

  const GFW = '/api/gfw';
  const OBIS = '/api/obis';
  const IDENTITY_DATASET = 'public-global-vessel-identity:latest';
  // 4Wings heatmaps.
  const HEATMAPS = [
    { id: 'fishing', dataset: 'public-global-fishing-effort:latest', label: 'Fishing effort', note: 'Hours of apparent fishing (AIS)', color: '#ff7a1a' },
    { id: 'presence', dataset: 'public-global-presence:latest', label: 'All vessel traffic', note: 'Every vessel broadcasting AIS', color: '#4fc3f7' },
    { id: 'sar', dataset: 'public-global-sar-presence:latest', label: 'Satellite radar detections', note: 'Finds vessels with AIS switched off', color: '#e84a5f' },
  ];
  // Events API. Several dataset names are tried in order (GFW has renamed some).
  const EVENT_TYPES = [
    { id: 'fishing', datasets: ['public-global-fishing-events:latest'], label: 'Fishing events', color: '#ff9d4d' },
    { id: 'encounter', datasets: ['public-global-encounters-events:latest'], label: 'Encounters (possible transshipment)', color: '#ff4f7b' },
    { id: 'loitering', datasets: ['public-global-loitering-events:latest'], label: 'Loitering', color: '#b07cff' },
    { id: 'port', datasets: ['public-global-port-visits-events:latest', 'public-global-port-visits-c2-events:latest'], label: 'Port visits', color: '#7fdbff' },
    { id: 'gap', datasets: ['public-global-gaps-events:latest'], label: 'AIS gaps (vessel went dark)', color: '#ffd54f' },
  ];
  // GFW context layers (vector tiles).
  const BOUNDARIES = [
    { id: 'mpa', datasets: ['public-mpa-all'], label: 'Marine protected areas', fill: 'rgba(77, 208, 160, 0.22)', stroke: 'rgba(77, 208, 160, 0.95)' },
    { id: 'eez', datasets: ['public-eez-areas'], label: 'Exclusive economic zones', fill: null, stroke: 'rgba(255, 255, 255, 0.75)' },
    { id: 'highseas', datasets: ['public-high-seas'], label: 'High seas', fill: 'rgba(120, 160, 255, 0.10)', stroke: 'rgba(120, 160, 255, 0.6)' },
    { id: 'rfmo', datasets: ['public-tuna-rfmo', 'public-rfmo'], label: 'Tuna fisheries bodies (RFMOs)', fill: null, stroke: 'rgba(255, 210, 120, 0.85)' },
  ];
  const PRESETS = [
    { name: 'Eastern Tropical Pacific corridor (CMAR)', bbox: [-93, -3, -77, 9], dates: ['2026-07-25', '2026-10-23'] },
    { name: 'Gulf of Mexico', bbox: [-98, 18, -80, 31] },
    { name: 'Caribbean Sea', bbox: [-88, 9, -60, 23] },
    { name: 'Coral Triangle', bbox: [95, -12, 150, 22] },
    { name: 'Mediterranean Sea', bbox: [-6, 30, 36, 46] },
    { name: 'North Atlantic', bbox: [-80, 5, 10, 65] },
    { name: 'Indian Ocean', bbox: [35, -40, 100, 25] },
    { name: 'Eastern Pacific', bbox: [-150, -30, -75, 55] },
  ];
  const AREA_COLORS = ['#ffffff', '#7fdbff', '#c3f584', '#ff6f91', '#f9f871', '#d29bfd', '#ffb347'];
  const FISH_COLORS = ['#75e1cd', '#f5a078', '#b7b7f5', '#e9cb79', '#79b8f2', '#ef9391', '#c3f584', '#d29bfd'];
  const FISH_TAXA = ['Actinopterygii', 'Elasmobranchii'];

  const state = {
    viewer: null,
    gfwReady: false,
    start: '2026-07-25',
    end: '2026-10-23',
    areas: [],
    nextArea: 0,
    clickToAdd: true,
    size: 6,
    sel: { allFish: false, species: new Set(), custom: [], heat: new Set(), events: new Set(), bounds: new Set() },
    shown: false,
    dirty: false,
    runSeq: 0,
    vesselSeq: 0,
    mapLayers: [],
    boundaryProviders: [],
    resolvedDataset: {},
  };

  // ---------------------------------------------------------------------------
  // Minimal Mapbox Vector Tile decoder (protobuf), enough to draw GFW context layers.
  function decodeMVT(buffer) {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    let pos = 0;
    const varint = () => {
      let result = 0, shift = 0, b;
      do {
        b = bytes[pos++];
        result += (b & 0x7f) * Math.pow(2, shift);
        shift += 7;
      } while (b & 0x80);
      return result;
    };
    const skip = (wire) => {
      if (wire === 0) varint();
      else if (wire === 1) pos += 8;
      else if (wire === 2) pos += varint();
      else if (wire === 5) pos += 4;
    };
    const string = (end) => new TextDecoder().decode(bytes.subarray(pos, end));
    const packed = () => {
      const end = varint() + pos, out = [];
      while (pos < end) out.push(varint());
      return out;
    };
    const readValue = (end) => {
      let v = null;
      while (pos < end) {
        const tag = varint(), field = tag >> 3, wire = tag & 7;
        if (field === 1) { const len = varint(); v = string(pos + len); pos += len; }
        else if (field === 2) { v = view.getFloat32(pos, true); pos += 4; }
        else if (field === 3) { v = view.getFloat64(pos, true); pos += 8; }
        else if (field === 4) { const n = varint(); v = n >= 2 ** 63 ? n - 2 ** 64 : n; }
        else if (field === 5) v = varint();
        else if (field === 6) { const n = varint(); v = n % 2 ? -(n + 1) / 2 : n / 2; }
        else if (field === 7) v = !!varint();
        else skip(wire);
      }
      return v;
    };
    const readFeature = (end) => {
      const f = { type: 0, tags: [], geometry: [] };
      while (pos < end) {
        const tag = varint(), field = tag >> 3, wire = tag & 7;
        if (field === 2) f.tags = packed();
        else if (field === 3) f.type = varint();
        else if (field === 4) f.geometry = packed();
        else skip(wire);
      }
      return f;
    };
    const readLayer = (end) => {
      const layer = { name: '', extent: 4096, keys: [], values: [], features: [] };
      while (pos < end) {
        const tag = varint(), field = tag >> 3, wire = tag & 7;
        if (field === 1) { const len = varint(); layer.name = string(pos + len); pos += len; }
        else if (field === 2) { const len = varint(); layer.features.push(readFeature(pos + len)); }
        else if (field === 3) { const len = varint(); layer.keys.push(string(pos + len)); pos += len; }
        else if (field === 4) { const len = varint(); layer.values.push(readValue(pos + len)); }
        else if (field === 5) layer.extent = varint();
        else skip(wire);
      }
      return layer;
    };
    const layers = [];
    while (pos < bytes.length) {
      const tag = varint(), field = tag >> 3, wire = tag & 7;
      if (field === 3) { const len = varint(); layers.push(readLayer(pos + len)); }
      else skip(wire);
    }
    // Resolve geometry commands into rings/lines in tile units, and tags into properties.
    const features = [];
    for (const layer of layers) {
      for (const f of layer.features) {
        const props = {};
        for (let i = 0; i + 1 < f.tags.length; i += 2) props[layer.keys[f.tags[i]]] = layer.values[f.tags[i + 1]];
        const parts = [];
        let x = 0, y = 0, part = null;
        for (let i = 0; i < f.geometry.length;) {
          const cmd = f.geometry[i] & 7, count = f.geometry[i] >> 3;
          i++;
          if (cmd === 7) { if (part && part.length) part.push(part[0]); continue; }
          for (let c = 0; c < count; c++) {
            const dx = f.geometry[i++], dy = f.geometry[i++];
            x += (dx >> 1) ^ -(dx & 1);
            y += (dy >> 1) ^ -(dy & 1);
            if (cmd === 1) { part = [[x, y]]; parts.push(part); }
            else if (part) part.push([x, y]);
          }
        }
        features.push({ type: f.type, props, parts, extent: layer.extent, layer: layer.name });
      }
    }
    return features;
  }

  // Even-odd point-in-polygon over all rings of a feature (holes handled implicitly).
  function featureContains(feature, px, py) {
    if (feature.type !== 3) return false;
    let inside = false;
    for (const ring of feature.parts) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
      }
    }
    return inside;
  }

  const lonLatToTile = (lon, lat, z) => {
    const n = 2 ** z, rad = (lat * Math.PI) / 180;
    const x = ((lon + 180) / 360) * n;
    const y = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n;
    return { x: Math.floor(x), y: Math.floor(y), fx: x - Math.floor(x), fy: y - Math.floor(y) };
  };


  // ---------------------------------------------------------------------------
  // Helpers

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => Math.round(n || 0).toLocaleString();
  const label = (k) => (/^[A-Z]{3}$/.test(k) ? k : String(k).toLowerCase().replace(/_/g, ' '));
  const dateRange = () => `${state.start},${state.end}`;
  const bboxPolygon = ([w, s, e, n]) => ({ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });
  const coordName = (lon, lat) => `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(1)}°${lon >= 0 ? 'E' : 'W'}`;
  const species = () => window.PELAGIC_SPECIES || [];
  const inBox = (lon, lat, [w, s, e, n]) => Number.isFinite(lon) && Number.isFinite(lat) && lat >= s && lat <= n &&
    (w <= e ? lon >= w && lon <= e : lon >= w || lon <= e);

  function setStatus(id, text) {
    const el = $(`[data-status="${id}"]`);
    if (el) el.textContent = text;
  }

  const gfwJSON = async (path, options) => {
    if (!state.gfwReady) throw new Error('Global Fishing Watch is not connected');
    const r = await fetch(GFW + path, options);
    const text = await r.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { error: text.slice(0, 200) }; }
    if (!r.ok) {
      const detail = body.error || body.message || (body.messages && body.messages.map((m) => m.detail || m.title || m).join('; '));
      const err = new Error(typeof detail === 'string' && detail ? detail : `HTTP ${r.status}`);
      err.status = r.status;
      throw err;
    }
    return body;
  };
  const postJSON = (path, body) => gfwJSON(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  // Tries each candidate dataset name until GFW accepts one, and remembers it.
  async function withDataset(key, datasets, request) {
    const start = state.resolvedDataset[key] ?? 0;
    let lastErr;
    for (let i = start; i < datasets.length; i++) {
      try {
        const result = await request(datasets[i]);
        state.resolvedDataset[key] = i;
        return result;
      } catch (err) {
        lastErr = err;
        if (![400, 404, 422].includes(err.status)) throw err;
      }
    }
    throw lastErr;
  }

  // ---------------------------------------------------------------------------
  // Map layers, always clipped to the chosen areas

  const rect = (bbox) => window.Cesium.Rectangle.fromDegrees(...bbox);

  function addClippedLayer(provider, area, alpha) {
    const layer = new window.Cesium.ImageryLayer(provider, { rectangle: rect(area.bbox), alpha });
    state.viewer.imageryLayers.add(layer);
    state.mapLayers.push(layer);
    return layer;
  }

  // Vector-tile boundary layer; also answers "which zone is this point in?".
  function boundaryProvider(def) {
    const Cesium = window.Cesium;
    const provider = new Cesium.UrlTemplateImageryProvider({ url: `${GFW}/datasets/{z}/{x}/{y}`, maximumLevel: 9, credit: 'Global Fishing Watch' });
    const tiles = new Map();
    provider.requestImage = (x, y, level) => tileBuffer(def, x, y, level)
      .then((buf) => {
        const features = buf && buf.byteLength ? decodeMVT(buf) : [];
        tiles.set(`${level}/${x}/${y}`, features);
        return drawTile(features, def);
      })
      .catch((err) => {
        setStatus(`b-${def.id}`, `Layer unavailable (${err.message})`);
        return drawTile([], def);
      });
    provider.featuresAt = (lon, lat) => {
      for (let z = 9; z >= 0; z--) {
        const t = lonLatToTile(lon, lat, z);
        const features = tiles.get(`${z}/${t.x}/${t.y}`);
        if (features) return features.filter((f) => featureContains(f, t.fx * f.extent, t.fy * f.extent));
      }
      return [];
    };
    state.boundaryProviders.push({ provider, def });
    return provider;
  }

  async function tileBuffer(def, x, y, level) {
    const resolved = state.resolvedDataset[def.id];
    for (let i = resolved ?? 0; i < def.datasets.length; i++) {
      const r = await fetch(`${GFW}/datasets/${def.datasets[i]}/context-layers/${level}/${x}/${y}`);
      if (r.ok) {
        state.resolvedDataset[def.id] = i;
        return r.arrayBuffer();
      }
      if (r.status === 404 && resolved !== undefined) return null; // known dataset, empty tile
      if (r.status !== 404) throw new Error(`HTTP ${r.status}`);
    }
    throw new Error('HTTP 404 for every dataset name');
  }

  function drawTile(features, def) {
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.lineJoin = 'round';
    for (const f of features) {
      const s = size / f.extent;
      ctx.beginPath();
      for (const part of f.parts) part.forEach(([x, y], i) => (i ? ctx.lineTo(x * s, y * s) : ctx.moveTo(x * s, y * s)));
      if (f.type === 3 && def.fill) {
        ctx.fillStyle = def.fill;
        ctx.fill('evenodd');
      }
      ctx.strokeStyle = def.stroke;
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
    return canvas;
  }

  const styleCache = new Map();
  async function heatmapProvider(def) {
    const key = `${def.id}:${dateRange()}`;
    if (!styleCache.has(key)) {
      const params = new URLSearchParams({ interval: 'DAY', 'datasets[0]': def.dataset, 'date-range': dateRange(), color: def.color });
      styleCache.set(key, postJSON(`/4wings/generate-png?${params}`, {}).catch((err) => {
        styleCache.delete(key);
        throw err;
      }));
    }
    const style = await styleCache.get(key);
    const url = style.url.replace(/^https:\/\/gateway\.api\.globalfishingwatch\.org\/v3/, GFW);
    return new window.Cesium.UrlTemplateImageryProvider({ url, maximumLevel: 12, credit: 'Global Fishing Watch' });
  }

  function drawAreas() {
    const Cesium = window.Cesium;
    state.outlines.removeAll();
    state.labels.removeAll();
    for (const a of state.areas) {
      const [w, s, e, n] = a.bbox;
      const east = e < w ? e + 360 : e;
      const ring = [];
      const steps = 40;
      for (let i = 0; i <= steps; i++) ring.push([w + ((east - w) * i) / steps, s]);
      for (let i = 0; i <= steps; i++) ring.push([east, s + ((n - s) * i) / steps]);
      for (let i = 0; i <= steps; i++) ring.push([east - ((east - w) * i) / steps, n]);
      for (let i = 0; i <= steps; i++) ring.push([w, n - ((n - s) * i) / steps]);
      state.outlines.add({
        positions: Cesium.Cartesian3.fromDegreesArrayHeights(ring.flatMap(([lon, lat]) => [((lon + 540) % 360) - 180, lat, 4000])),
        width: 2,
        material: Cesium.Material.fromType('Color', { color: Cesium.Color.fromCssColorString(a.color) }),
      });
      state.labels.add({
        position: Cesium.Cartesian3.fromDegrees(w, n, 5000),
        text: ` ${a.letter} `,
        font: 'bold 13px Arial',
        fillColor: Cesium.Color.BLACK,
        showBackground: true,
        backgroundColor: Cesium.Color.fromCssColorString(a.color),
        horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
    }
    state.viewer.scene.requestRender();
  }

  function clearMap() {
    for (const layer of state.mapLayers) state.viewer.imageryLayers.remove(layer, true);
    state.mapLayers = [];
    state.boundaryProviders = [];
    state.fishPoints.removeAll();
    state.eventPoints.removeAll();
    state.vesselPoints.removeAll();
    state.vesselLines.removeAll();
    state.viewer.scene.requestRender();
  }

  function addPoint(collection, lon, lat, color, id, size = 6) {
    const Cesium = window.Cesium;
    collection.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat, 2500),
      pixelSize: size,
      color: Cesium.Color.fromCssColorString(color),
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 1,
      id,
    });
  }

  // ---------------------------------------------------------------------------
  // Step 1: Where

  function addArea(name, bbox, dates) {
    const i = state.nextArea++;
    state.areas.push({ id: `a${i}`, letter: String.fromCharCode(65 + (i % 26)), name, bbox, color: AREA_COLORS[i % AREA_COLORS.length] });
    if (dates) {
      [state.start, state.end] = dates;
      $('#px-start').value = state.start;
      $('#px-end').value = state.end;
    }
    drawAreas();
    changed();
  }

  function areaAround(lon, lat, size) {
    const h = size / 2;
    const wrap = (x) => ((x + 540) % 360) - 180;
    return [wrap(lon - h), Math.max(-85, lat - h), wrap(lon + h), Math.min(85, lat + h)];
  }

  function removeArea(id) {
    state.areas = state.areas.filter((a) => a.id !== id);
    drawAreas();
    changed();
  }

  function renderAreas() {
    $('#px-areas').innerHTML = state.areas.length
      ? state.areas.map((a) => `<div class="px-area"><b style="background:${a.color}">${a.letter}</b><span>${esc(a.name)}</span><button data-zoom-area="${a.id}" title="Zoom to area">⤢</button><button data-remove-area="${a.id}" aria-label="Remove area">×</button></div>`).join('')
      : '<p class="px-muted">No areas yet.</p>';
    $('#px-where-sum').textContent = state.areas.length ? `${state.areas.length} area${state.areas.length > 1 ? 's' : ''} selected` : 'Add one or more areas';
    $('[data-step="where"]').classList.toggle('done', state.areas.length > 0);
  }

  async function searchPlace(q) {
    const coords = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (coords) {
      const lat = +coords[1], lon = +coords[2];
      addArea(coordName(lon, lat), areaAround(lon, lat, state.size));
      return;
    }
    const box = $('#px-place-results');
    box.innerHTML = '<p class="px-muted">Searching…</p>';
    try {
      const r = await fetch(`/api/places?q=${encodeURIComponent(q)}`);
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      box.innerHTML = (data.results || []).map((p, i) => `<button class="px-place" data-place="${i}"><strong>${esc(p.name)}</strong><small>${esc(p.context)}</small></button>`).join('') || '<p class="px-muted">No places found.</p>';
      box.onclick = (e) => {
        const b = e.target.closest('[data-place]');
        if (!b) return;
        const p = data.results[+b.dataset.place];
        addArea(p.name, areaAround(p.lon, p.lat, state.size));
        box.innerHTML = '';
        $('#px-place input').value = '';
      };
    } catch (err) {
      box.innerHTML = `<p class="px-muted">Place search unavailable: ${esc(err.message)}</p>`;
    }
  }

  // ---------------------------------------------------------------------------
  // Step 2: What

  function dataCount() {
    const s = state.sel;
    return (s.allFish ? 1 : 0) + s.species.size + s.custom.filter((c) => c.on).length + s.heat.size + s.events.size + s.bounds.size;
  }

  function changed(markDirty = true) {
    renderAreas();
    const n = dataCount();
    $('#px-what-sum').textContent = n ? `${n} data layer${n > 1 ? 's' : ''} selected` : 'Choose what to show';
    $('[data-step="what"]').classList.toggle('done', n > 0);
    const ready = state.areas.length > 0 && n > 0;
    const btn = $('#px-show');
    btn.disabled = !ready;
    if (state.shown && markDirty) state.dirty = true;
    btn.textContent = state.shown ? 'Update map' : 'Show on map';
    btn.classList.toggle('pulse', ready && (!state.shown || state.dirty));
    $('#px-ready').textContent = !state.areas.length ? 'Step 1: add at least one area.' : !n ? 'Step 2: choose at least one kind of data.' : `${state.areas.length} area${state.areas.length > 1 ? 's' : ''} · ${n} data layer${n > 1 ? 's' : ''}`;
    renderHint();
  }

  function renderSpeciesList() {
    const q = ($('#px-species-filter').value || '').toLowerCase();
    $('#px-species-list').innerHTML = species()
      .filter((sp) => `${sp.name} ${sp.scientific} ${sp.group}`.toLowerCase().includes(q))
      .map((sp) => `<label class="px-check"><input type="checkbox" data-species="${esc(sp.scientific)}" ${state.sel.species.has(sp.scientific) ? 'checked' : ''}><span>${esc(sp.name)}<small>${esc(sp.scientific)} · ${esc(sp.group)}</small></span></label>`)
      .join('') || '<p class="px-muted">No match in the guide — add it below as any species.</p>';
  }

  function renderCustom() {
    $('#px-custom').innerHTML = state.sel.custom.map((c, i) => `<label class="px-check"><input type="checkbox" data-custom="${i}" ${c.on ? 'checked' : ''}><span><i>${esc(c.name)}</i></span></label>`).join('');
  }

  function fishSelection() {
    const guide = species().filter((sp) => state.sel.species.has(sp.scientific)).map((sp) => ({ name: sp.name, scientific: sp.scientific }));
    const custom = state.sel.custom.filter((c) => c.on).map((c) => ({ name: c.name, scientific: c.name }));
    return [...guide, ...custom].map((f, i) => ({ ...f, color: FISH_COLORS[i % FISH_COLORS.length] }));
  }

  // ---------------------------------------------------------------------------
  // Step 3: Results

  async function run() {
    const seq = ++state.runSeq;
    const live = () => seq === state.runSeq;
    state.shown = true;
    state.dirty = false;
    state.clickToAdd = false;
    $('#px-click').checked = false;
    changed(false);
    clearMap();
    showResults();
    const fish = fishSelection();
    const heat = HEATMAPS.filter((d) => state.sel.heat.has(d.id));
    const events = EVENT_TYPES.filter((t) => state.sel.events.has(t.id));
    const bounds = BOUNDARIES.filter((d) => state.sel.bounds.has(d.id));
    renderLegend(fish, heat, events, bounds);

    $('#px-results').innerHTML = `<p class="px-period">${esc(state.start)} → ${esc(state.end)}</p>` + state.areas.map((a) => `
      <section class="px-card" style="--area:${a.color}">
        <header><b>${a.letter}</b><div><strong>${esc(a.name)}</strong><small>${a.bbox.map((v) => v.toFixed(1)).join(', ')}</small></div><button data-zoom-area="${a.id}" title="Zoom to area">⤢</button></header>
        ${fish.length ? `<h5>Fish records</h5><div id="r-${a.id}-fish"></div>` : ''}
        ${state.sel.allFish ? `<h5>Every fish species recorded here</h5><div id="r-${a.id}-all"></div>` : ''}
        ${heat.some((d) => d.id === 'fishing') ? `<h5>Fishing effort</h5><div id="r-${a.id}-fishing"></div>` : ''}
        ${heat.some((d) => d.id === 'presence') ? `<h5>All vessel traffic</h5><div id="r-${a.id}-presence"></div>` : ''}
        ${heat.some((d) => d.id === 'sar') ? `<h5>Satellite radar detections</h5><div id="r-${a.id}-sar"></div>` : ''}
        ${events.length ? `<h5>Events <small>click a dot on the map</small></h5><div id="r-${a.id}-events"></div>` : ''}
        ${bounds.length ? `<p class="px-muted">Boundaries are drawn on the map — click inside one for its name.</p>` : ''}
      </section>`).join('');

    // Map layers, clipped to each area.
    for (const def of heat) {
      try {
        const provider = await heatmapProvider(def);
        if (!live()) return;
        for (const a of state.areas) addClippedLayer(provider, a, 0.9);
        setStatus(`h-${def.id}`, def.note);
      } catch (err) {
        setStatus(`h-${def.id}`, `Unavailable: ${err.message}`);
      }
    }
    for (const def of bounds) {
      setStatus(`b-${def.id}`, '');
      for (const a of state.areas) addClippedLayer(boundaryProvider(def), a, 1);
    }
    state.viewer.scene.requestRender();
    flyToAreas();

    for (const a of state.areas) analyzeArea(a, fish, heat, events, live);
  }

  function fill(id, html) {
    const el = $(`#${id}`);
    if (el) el.innerHTML = html;
  }

  function section(id, live, promise, render) {
    fill(id, '<p class="px-muted">Loading…</p>');
    return promise
      .then((v) => live() && fill(id, render(v)))
      .catch((err) => live() && fill(id, `<p class="px-muted">Unavailable: ${esc(err.message)}</p>`));
  }

  async function report(def, groupBy, area) {
    const params = new URLSearchParams({
      'spatial-resolution': 'LOW', 'temporal-resolution': 'ENTIRE', 'spatial-aggregation': 'true',
      'datasets[0]': def.dataset, 'date-range': dateRange(), format: 'JSON', 'group-by': groupBy,
    });
    const res = await postJSON(`/4wings/report?${params}`, { geojson: bboxPolygon(area.bbox) });
    const rows = [];
    for (const entry of res.entries || []) for (const list of Object.values(entry)) rows.push(...(list || []));
    return rows;
  }

  const sumBy = (rows, key) => {
    const out = {};
    for (const r of rows) {
      const k = key(r) || '—';
      out[k] = (out[k] || 0) + (r.hours ?? r.detections ?? r.value ?? 0);
    }
    return Object.entries(out).sort((a, b) => b[1] - a[1]);
  };

  const bars = (rows, unit, color) => rows.length
    ? rows.slice(0, 6).map(([k, v]) => `<div class="px-bar"><span title="${esc(k)}">${esc(label(k))}</span><i style="width:${Math.max(2, (100 * v) / rows[0][1])}%;background:${color}"></i><small>${fmt(v)} ${unit}</small></div>`).join('')
    : '<p class="px-muted">None detected in this period.</p>';

  function analyzeArea(a, fish, heat, events, live) {
    const id = (k) => `r-${a.id}-${k}`;

    if (fish.length) {
      fill(id('fish'), fish.map((f, i) => `<div class="px-legend-row"><i style="background:${f.color}"></i><span>${esc(f.name)}</span><small id="${id(`fish${i}`)}">…</small></div>`).join(''));
      fish.forEach(async (f, i) => {
        try {
          const params = new URLSearchParams({ species: f.scientific, bbox: a.bbox.join(',') });
          const r = await fetch(`/api/observations?${params}`);
          const data = await r.json();
          if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
          if (!live()) return;
          let shown = 0;
          for (const rec of data.results || []) {
            if (!inBox(rec.decimalLongitude, rec.decimalLatitude, a.bbox)) continue;
            addPoint(state.fishPoints, rec.decimalLongitude, rec.decimalLatitude, f.color, { obisRecord: rec, fish: f }, 5);
            shown++;
          }
          state.viewer.scene.requestRender();
          fill(id(`fish${i}`), data.total > shown ? `${fmt(shown)} of ${fmt(data.total)}` : `${fmt(shown)} records`);
        } catch (err) {
          if (live()) fill(id(`fish${i}`), 'unavailable');
        }
      });
    }

    if (state.sel.allFish) {
      const wkt = `POLYGON((${bboxPolygon(a.bbox).coordinates[0].map((p) => p.join(' ')).join(',')}))`;
      section(id('all'), live, (async () => {
        const lists = await Promise.all(FISH_TAXA.map(async (taxon) => {
          const r = await fetch(`${OBIS}/checklist?${new URLSearchParams({ scientificname: taxon, geometry: wkt, size: 200 })}`);
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        }));
        const byName = new Map();
        for (const t of lists.flatMap((l) => l.results || [])) if ((t.taxonRank || '').toLowerCase() === 'species') byName.set(t.scientificName, t);
        return [...byName.values()].sort((x, y) => (y.records || 0) - (x.records || 0));
      })(), (list) => list.length
        ? `<p class="px-muted">${fmt(list.length)}+ species. Tap + to put one on the map.</p><div class="px-taxa">${list.slice(0, 40).map((t) => `<button class="px-taxon" data-add-species="${esc(t.scientificName)}"><i>${esc(t.scientificName)}</i><small>${fmt(t.records)}</small><b>+</b></button>`).join('')}</div>`
        : '<p class="px-muted">No fish records in OBIS for this area.</p>');
    }

    const [fishingDef, presenceDef, sarDef] = HEATMAPS;
    if (heat.includes(fishingDef)) {
      section(id('fishing'), live, Promise.all([
        report(fishingDef, 'FLAG', a), report(fishingDef, 'GEARTYPE', a), report(fishingDef, 'VESSEL_ID', a),
      ]), ([flags, gear, vessels]) => {
        const byFlag = sumBy(flags, (r) => r.flag);
        const total = byFlag.reduce((s, r) => s + r[1], 0);
        const byVessel = new Map();
        for (const r of vessels) {
          const vid = r.vesselId || r.vessel_id || r.id;
          if (!vid) continue;
          const v = byVessel.get(vid) || { id: vid, name: r.shipName || r.shipname || r.vesselName, flag: r.flag, gear: r.geartype, hours: 0 };
          v.hours += r.hours || 0;
          byVessel.set(vid, v);
        }
        const top = [...byVessel.values()].sort((x, y) => y.hours - x.hours).slice(0, 5);
        return `<p class="px-stat"><strong>${fmt(total)}</strong> hours of fishing</p>
          <div class="px-sub">By flag</div>${bars(byFlag, 'h', fishingDef.color)}
          <div class="px-sub">By gear</div>${bars(sumBy(gear, (r) => r.geartype || r.gearType), 'h', fishingDef.color)}
          <div class="px-sub">Top vessels</div>${top.length ? top.map((v) => `<button class="px-vessel" data-vessel="${esc(v.id)}"><span><strong>${esc(v.name || 'Unknown vessel')}</strong><small>${esc([v.flag, v.gear && label(v.gear)].filter(Boolean).join(' · '))}</small></span><small>${fmt(v.hours)} h ›</small></button>`).join('') : '<p class="px-muted">None.</p>'}`;
      });
    }
    if (heat.includes(presenceDef)) {
      section(id('presence'), live, report(presenceDef, 'VESSEL_TYPE', a), (rows) => {
        const byType = sumBy(rows, (r) => r.vessel_type || r.vesselType);
        return `<p class="px-stat"><strong>${fmt(byType.reduce((s, r) => s + r[1], 0))}</strong> vessel hours</p>${bars(byType, 'h', presenceDef.color)}`;
      });
    }
    if (heat.includes(sarDef)) {
      section(id('sar'), live, report(sarDef, 'MATCHED', a), (rows) => {
        const total = rows.reduce((s, r) => s + (r.detections ?? r.hours ?? 0), 0);
        const dark = rows.filter((r) => r.matched === false || r.matched === 'false').reduce((s, r) => s + (r.detections ?? 0), 0);
        return `<p class="px-stat"><strong>${fmt(total)}</strong> vessels seen from space</p>${dark ? `<p class="px-warn"><strong>${fmt(dark)}</strong> were not broadcasting AIS — possible dark vessels</p>` : ''}`;
      });
    }

    if (events.length) {
      fill(id('events'), events.map((t) => `<div class="px-legend-row"><i style="background:${t.color}"></i><span>${esc(t.label)}</span><small id="${id(`ev-${t.id}`)}">…</small></div>`).join(''));
      for (const t of events) {
        withDataset(`ev-${t.id}`, t.datasets, (dataset) => postJSON('/events?offset=0&limit=200', {
          datasets: [dataset], startDate: state.start, endDate: state.end, geometry: bboxPolygon(a.bbox),
        })).then((res) => {
          if (!live()) return;
          for (const e of res.entries || []) if (e.position) addPoint(state.eventPoints, e.position.lon, e.position.lat, t.color, { gfwEvent: e, type: t }, 7);
          state.viewer.scene.requestRender();
          fill(id(`ev-${t.id}`), fmt(res.total ?? (res.entries || []).length));
        }).catch((err) => live() && fill(id(`ev-${t.id}`), `unavailable (${esc(err.message)})`));
      }
    }
  }

  function renderLegend(fish, heat, events, bounds) {
    const rows = [
      ...state.areas.map((a) => [a.color, `${a.letter} · ${a.name}`, 'square']),
      ...heat.map((d) => [d.color, d.label, 'bar']),
      ...fish.map((f) => [f.color, f.name, 'dot']),
      ...events.map((t) => [t.color, t.label, 'dot']),
      ...bounds.map((d) => [d.stroke, d.label, 'line']),
    ];
    const box = $('#px-legend');
    box.hidden = !rows.length;
    box.innerHTML = `<strong>On the map</strong>${rows.map(([c, l, kind]) => `<div><i class="px-k-${kind}" style="--c:${c}"></i>${esc(l)}</div>`).join('')}`;
  }

  function renderHint() {
    const hint = $('#px-hint');
    if (!hint) return;
    hint.textContent = state.clickToAdd
      ? `Click the ocean to add a ${state.size}° area${state.areas.length ? ` (${state.areas.length} so far)` : ''}`
      : state.shown ? 'Click a dot or a zone for details' : '';
    hint.hidden = !hint.textContent;
  }

  function flyToAreas() {
    if (!state.areas.length) return;
    const ws = state.areas.map((a) => a.bbox[0]), ss = state.areas.map((a) => a.bbox[1]);
    const es = state.areas.map((a) => a.bbox[2]), ns = state.areas.map((a) => a.bbox[3]);
    const crosses = state.areas.some((a) => a.bbox[0] > a.bbox[2]);
    const bbox = crosses ? [-180, Math.min(...ss), 180, Math.max(...ns)] : [Math.min(...ws), Math.min(...ss), Math.max(...es), Math.max(...ns)];
    zoomTo(bbox);
  }

  function zoomTo(bbox) {
    const [w, s, e, n] = bbox;
    const pad = Math.max(2, (n - s) * 0.25);
    state.viewer.camera.flyTo({ destination: window.Cesium.Rectangle.fromDegrees(w - pad, Math.max(-89, s - pad), e + pad, Math.min(89, n + pad)), duration: 1.4 });
  }

  // ---------------------------------------------------------------------------
  // Detail view (right panel): map clicks, vessels

  function showDetail(html) {
    $('#px-detail-body').innerHTML = html;
    $('#px-detail').hidden = false;
    $('#px-results-wrap').hidden = true;
    $('#px-empty').hidden = true;
  }

  function showResults() {
    $('#px-detail').hidden = true;
    $('#px-results-wrap').hidden = !state.shown;
    $('#px-empty').hidden = state.shown;
  }

  const zoneHtml = (def, p) => {
    const name = p.name || p.NAME || p.label || p.WDPA_NAME || p.GEONAME || p.id || 'Unnamed area';
    const extra = [p.desig_eng || p.DESIG_ENG, p.iucn_cat || p.IUCN_CAT ? `IUCN ${p.iucn_cat || p.IUCN_CAT}` : '', p.status_yr || p.STATUS_YR ? `since ${p.status_yr || p.STATUS_YR}` : '', p.no_take || p.NO_TAKE ? `No-take: ${p.no_take || p.NO_TAKE}` : '']
      .filter(Boolean).join(' · ');
    return `<div class="px-zone" style="--c:${def.stroke}"><small>${esc(def.label)}</small><strong>${esc(name)}</strong>${extra ? `<span>${esc(extra)}</span>` : ''}</div>`;
  };

  const eventHtml = (e, type) => {
    const v = e.vessel || {};
    const other = e.encounter && e.encounter.vessel;
    const port = e.port_visit && (e.port_visit.intermediateAnchorage || e.port_visit.startAnchorage);
    const hours = e.start && e.end ? ` · ${((Date.parse(e.end) - Date.parse(e.start)) / 36e5).toFixed(1)} h` : '';
    return `<div class="px-zone" style="--c:${type.color}"><small>${esc(type.label)}</small>
      <strong>${esc(v.name || 'Unknown vessel')}</strong>
      <span>${esc([v.flag, v.type, v.ssvid ? `MMSI ${v.ssvid}` : ''].filter(Boolean).join(' · '))}</span>
      <span>${esc((e.start || '').slice(0, 16).replace('T', ' '))} → ${esc((e.end || '').slice(0, 16).replace('T', ' '))}${hours}</span>
      ${other ? `<span>Met ${esc(other.name || 'unknown vessel')} (${esc(other.flag || '?')})</span>` : ''}
      ${port ? `<span>Port: ${esc(port.name || port.label || '')} ${esc(port.flag || '')}</span>` : ''}</div>
      ${v.id ? `<button class="px-primary small" data-vessel="${esc(v.id)}">Vessel profile & risk insights</button>` : ''}`;
  };

  const recordHtml = (r, f) => `<div class="px-zone" style="--c:${f.color}"><small>Fish record · OBIS</small>
      <strong>${esc(f.name)}</strong><span><i>${esc(r.scientificName || f.scientific)}</i></span>
      <span>${esc((r.eventDate || 'Date not provided').slice(0, 10))} · ${esc(r.datasetName || 'OBIS dataset')}</span>
      ${r.depth !== undefined ? `<span>Depth ${esc(r.depth)} m</span>` : ''}</div>
      <a target="_blank" rel="noreferrer" href="https://obis.org/occurrence/${encodeURIComponent(r.id)}">View source record ↗</a>
      <a target="_blank" rel="noreferrer" href="https://www.fishbase.se/summary/${encodeURIComponent((r.scientificName || f.scientific).replace(/ /g, '-'))}.html">Species on FishBase ↗</a>`;

  function vesselSummary(entry) {
    const self = (entry.selfReportedInfo || [])[0] || {};
    const reg = (entry.registryInfo || [])[0] || {};
    const combined = (entry.combinedSourcesInfo || [])[0] || {};
    const first = (list) => (list || []).map((x) => x.name || x).filter(Boolean)[0];
    return {
      id: self.id || combined.vesselId || entry.id,
      name: self.shipname || reg.shipname || entry.shipname || 'Unknown vessel',
      flag: self.flag || reg.flag || entry.flag,
      ssvid: self.ssvid || reg.ssvid,
      imo: self.imo || reg.imo,
      callsign: self.callsign || reg.callsign,
      gear: first(combined.geartypes) || first(reg.geartypes),
      type: first(combined.shiptypes) || first(reg.shiptypes),
      owner: ((entry.registryOwners || [])[0] || {}).name,
      authorizations: (entry.registryPublicAuthorizations || []).map((a) => (a.sourceCode || []).join('/')).filter(Boolean),
      firstSeen: self.transmissionDateFrom,
      lastSeen: self.transmissionDateTo,
    };
  }

  const shiftDate = (iso, days) => {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    const s = d.toISOString().slice(0, 10);
    return s < '2020-01-01' ? '2020-01-01' : s;
  };

  async function openVessel(id) {
    const seq = ++state.vesselSeq;
    const live = () => seq === state.vesselSeq;
    showDetail('<p class="px-muted">Loading vessel…</p>');
    state.vesselPoints.removeAll();
    state.vesselLines.removeAll();
    let v = { id, name: 'Vessel' };
    try {
      v = vesselSummary(await gfwJSON(`/vessels/${encodeURIComponent(id)}?${new URLSearchParams({ dataset: IDENTITY_DATASET })}`));
      v.id = v.id || id;
    } catch (err) {
      v.error = err.message;
    }
    if (!live()) return;
    const facts = [['Flag', v.flag], ['MMSI', v.ssvid], ['IMO', v.imo], ['Call sign', v.callsign], ['Gear', v.gear && label(v.gear)], ['Type', v.type && label(v.type)], ['Owner', v.owner], ['Authorizations', v.authorizations && v.authorizations.join(', ')], ['AIS seen', v.firstSeen && `${v.firstSeen.slice(0, 10)} → ${(v.lastSeen || '').slice(0, 10)}`]];
    showDetail(`
      <div class="px-zone" style="--c:#111"><small>Vessel · Global Fishing Watch</small><strong>${esc(v.name)}</strong>${v.error ? `<span>Identity unavailable: ${esc(v.error)}</span>` : ''}</div>
      <dl class="px-facts">${facts.filter(([, val]) => val).map(([k, val]) => `<dt>${k}</dt><dd>${esc(val)}</dd>`).join('')}</dl>
      <a target="_blank" rel="noreferrer" href="https://globalfishingwatch.org/map/vessel/${encodeURIComponent(v.id)}">Full profile on Global Fishing Watch ↗</a>
      <h5>Risk insights · last 12 months</h5><div id="px-insights"><p class="px-muted">Loading…</p></div>
      <h5>Its activity on the map</h5><div id="px-vessel-events"><p class="px-muted">Loading…</p></div>`);

    const end = state.end, start = shiftDate(end, -365);
    postJSON('/insights/vessels', {
      includes: ['FISHING', 'GAP', 'COVERAGE', 'VESSEL-IDENTITY-IUU-VESSEL-LIST'],
      startDate: start, endDate: end, vessels: [{ datasetId: IDENTITY_DATASET, vesselId: v.id }],
    }).then((ins) => live() && fill('px-insights', insightsHtml(ins)))
      .catch((err) => live() && fill('px-insights', `<p class="px-muted">Unavailable: ${esc(err.message)}</p>`));

    const results = await Promise.all(EVENT_TYPES.map(async (t) => {
      try {
        const res = await withDataset(`ev-${t.id}`, t.datasets, (dataset) => gfwJSON(`/events?${new URLSearchParams({ 'vessels[0]': v.id, 'datasets[0]': dataset, 'start-date': start, 'end-date': end, limit: 200, offset: 0 })}`));
        return { t, entries: res.entries || [] };
      } catch (err) {
        return { t, entries: [], error: err.message };
      }
    }));
    if (!live()) return;
    const Cesium = window.Cesium;
    const all = [];
    for (const { t, entries } of results) {
      for (const e of entries) {
        if (!e.position) continue;
        addPoint(state.vesselPoints, e.position.lon, e.position.lat, t.color, { gfwEvent: e, type: t }, 7);
        all.push(e);
      }
    }
    all.sort((x, y) => Date.parse(x.start) - Date.parse(y.start));
    if (all.length > 1) {
      state.vesselLines.add({
        positions: Cesium.Cartesian3.fromDegreesArrayHeights(all.flatMap((e) => [e.position.lon, e.position.lat, 3000])),
        width: 1.5,
        material: Cesium.Material.fromType('Color', { color: Cesium.Color.WHITE.withAlpha(0.7) }),
      });
      const lons = all.map((e) => e.position.lon), lats = all.map((e) => e.position.lat);
      zoomTo([Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)]);
    }
    state.viewer.scene.requestRender();
    fill('px-vessel-events', results.map(({ t, entries, error }) => `<div class="px-legend-row"><i style="background:${t.color}"></i><span>${esc(t.label)}</span><small>${error ? 'unavailable' : entries.length}</small></div>`).join('') +
      (all.length ? `<p class="px-muted">White line joins its events in time order, ${all[0].start.slice(0, 10)} → ${all[all.length - 1].start.slice(0, 10)}.</p>` : '<p class="px-muted">No events in the last 12 months.</p>'));
  }

  function insightsHtml(ins) {
    const rows = [];
    const fc = (ins.apparentFishing || {}).periodSelectedCounters || {};
    const gc = (ins.gap || {}).periodSelectedCounters || {};
    const iuu = (ins.vesselIdentity || {}).iuuVesselList || {};
    const cov = ins.coverage || {};
    if (iuu.totalTimesListed !== undefined || iuu.valuesInThePeriod) {
      const listed = (iuu.totalTimesListedInThePeriod || 0) > 0 || (iuu.valuesInThePeriod || []).length > 0;
      rows.push([listed ? 'warn' : 'ok', 'IUU vessel list', listed ? 'Listed' : 'Not listed']);
    }
    if (fc.events !== undefined) rows.push(['', 'Fishing events', fmt(fc.events)]);
    if (fc.eventsInNoTakeMPAs !== undefined) rows.push([fc.eventsInNoTakeMPAs ? 'warn' : 'ok', 'Fishing in no-take MPAs', fmt(fc.eventsInNoTakeMPAs)]);
    if (fc.eventsInRFMOWithoutKnownAuthorization !== undefined) rows.push([fc.eventsInRFMOWithoutKnownAuthorization ? 'warn' : 'ok', 'Fishing without known RFMO authorization', fmt(fc.eventsInRFMOWithoutKnownAuthorization)]);
    if (gc.eventsGapOff !== undefined || gc.events !== undefined) rows.push([(gc.eventsGapOff ?? gc.events) ? 'warn' : 'ok', 'AIS turned off', fmt(gc.eventsGapOff ?? gc.events)]);
    if (cov.percentage !== undefined) rows.push(['', 'AIS coverage', `${Math.round(cov.percentage)}%`]);
    return rows.length
      ? rows.map(([level, k, val]) => `<div class="px-insight ${level}"><span>${esc(k)}</span><strong>${esc(val)}</strong></div>`).join('')
      : '<p class="px-muted">No insights returned for this vessel.</p>';
  }

  async function searchVessels(q) {
    showDetail('<p class="px-muted">Searching vessels…</p>');
    try {
      const res = await gfwJSON(`/vessels/search?${new URLSearchParams({ query: q, 'datasets[0]': IDENTITY_DATASET, limit: 10 })}`);
      const list = (res.entries || []).map(vesselSummary).filter((v) => v.id);
      showDetail(`<h5>Vessels matching “${esc(q)}”</h5>` + (list.length
        ? list.map((v) => `<button class="px-vessel" data-vessel="${esc(v.id)}"><span><strong>${esc(v.name)}</strong><small>${esc([v.flag, v.type && label(v.type), v.ssvid && `MMSI ${v.ssvid}`].filter(Boolean).join(' · '))}</small></span><small>›</small></button>`).join('')
        : '<p class="px-muted">No vessels found.</p>'));
    } catch (err) {
      showDetail(`<p class="px-muted">Vessel search unavailable: ${esc(err.message)}</p>`);
    }
  }

  // ---------------------------------------------------------------------------
  // Globe clicks

  function onClick(movement) {
    const { viewer } = state;
    const Cesium = window.Cesium;
    const picked = viewer.scene.pick(movement.position);
    if (picked && picked.id && picked.id.gfwEvent) return showDetail(eventHtml(picked.id.gfwEvent, picked.id.type));
    if (picked && picked.id && picked.id.obisRecord) return showDetail(recordHtml(picked.id.obisRecord, picked.id.fish));
    const cart = viewer.camera.pickEllipsoid(movement.position, viewer.scene.globe.ellipsoid);
    if (!cart) return;
    const c = Cesium.Cartographic.fromCartesian(cart);
    const lon = Cesium.Math.toDegrees(c.longitude), lat = Cesium.Math.toDegrees(c.latitude);
    if (state.clickToAdd) return addArea(coordName(lon, lat), areaAround(lon, lat, state.size));
    const zones = [];
    for (const { provider, def } of state.boundaryProviders) {
      for (const f of provider.featuresAt(lon, lat)) zones.push(zoneHtml(def, f.props));
    }
    if (zones.length) showDetail([...new Set(zones)].join(''));
  }

  // ---------------------------------------------------------------------------
  // Panels

  const check = (attr, value, text, note, color, statusId) => `<label class="px-check"><input type="checkbox" ${attr}="${value}">${color ? `<i class="px-swatch" style="background:${color}"></i>` : ''}<span>${text}${note || statusId ? `<small ${statusId ? `data-status="${statusId}"` : ''}>${note || ''}</small>` : ''}</span></label>`;

  function buildPanels() {
    const left = document.createElement('div');
    left.id = 'px-left';
    left.innerHTML = `
      <div class="px-scroll">
        <section class="px-step" data-step="where">
          <header><b>1</b><div><strong>Where</strong><small id="px-where-sum">Add one or more areas</small></div></header>
          <label class="px-check"><input type="checkbox" id="px-click" checked><span>Click the globe to add an area</span></label>
          <label class="px-inline">Area size
            <select id="px-size">${[2, 6, 12, 20].map((s) => `<option value="${s}" ${s === state.size ? 'selected' : ''}>${s}° × ${s}° (~${fmt(s * 111)} km)</option>`).join('')}</select></label>
          <form id="px-place" class="px-search"><input placeholder="Search a place, or lat, lon" autocomplete="off"><button type="submit">Add</button></form>
          <div id="px-place-results"></div>
          <div class="px-sub">Or pick a region</div>
          <div class="px-presets">${PRESETS.map((p, i) => `<button data-preset="${i}">${esc(p.name)}</button>`).join('')}</div>
          <div id="px-areas"></div>
        </section>
        <section class="px-step" data-step="what">
          <header><b>2</b><div><strong>What</strong><small id="px-what-sum">Choose what to show</small></div></header>
          <div class="px-dates"><label>From<input type="date" id="px-start" value="${state.start}"></label><label>To<input type="date" id="px-end" value="${state.end}"></label></div>
          <details open><summary>Fish <small>OBIS</small></summary>
            ${check('id', 'px-allfish', 'Every fish species recorded in my areas', 'A list per area — add any of them to the map')}
            <input id="px-species-filter" class="px-filter" placeholder="Filter the field guide (${species().length})">
            <div id="px-species-list" class="px-list"></div>
            <form id="px-any" class="px-search"><input placeholder="Any other species, genus or family" autocomplete="off"><button type="submit">Add</button></form>
            <div id="px-custom"></div>
          </details>
          <details open><summary>Fishing activity <small>Global Fishing Watch</small></summary>
            ${HEATMAPS.map((d) => check('data-heat', d.id, d.label, d.note, d.color, `h-${d.id}`)).join('')}
          </details>
          <details><summary>Vessel events <small>Global Fishing Watch</small></summary>
            ${EVENT_TYPES.map((t) => check('data-event', t.id, t.label, '', t.color)).join('')}
          </details>
          <details><summary>Boundaries <small>Global Fishing Watch</small></summary>
            ${BOUNDARIES.map((d) => check('data-bound', d.id, d.label, '', d.stroke, `b-${d.id}`)).join('')}
          </details>
        </section>
      </div>
      <footer class="px-actions">
        <small id="px-ready"></small>
        <div><button id="px-show" class="px-primary" disabled>Show on map</button><button id="px-reset" class="px-ghost">Start over</button></div>
      </footer>`;

    const right = document.createElement('div');
    right.id = 'px-right';
    right.innerHTML = `
      <div class="px-right-head"><span class="px-eyebrow">3 · Results</span>
        <form id="px-vsearch" class="px-search"><input placeholder="Find a vessel (name, MMSI, IMO)" autocomplete="off"><button type="submit">Find</button></form></div>
      <div id="px-empty" class="px-empty">
        <p><b>1</b><span>Add one or more <strong>areas</strong> — click the globe or pick a region.</span></p>
        <p><b>2</b><span>Choose the <strong>data</strong>: fish, fishing activity, vessel events, boundaries.</span></p>
        <p><b>3</b><span>Press <strong>Show on map</strong>. Results for each area appear here.</span></p>
        <p class="px-muted">Nothing is drawn on the globe until you do.</p>
        <p class="px-token" id="px-token" hidden>Global Fishing Watch is not connected — check the server window. Fish data still works.</p>
      </div>
      <div id="px-detail" hidden><button class="px-back" id="px-back">← Back to results</button><div id="px-detail-body"></div></div>
      <div id="px-results-wrap" hidden><div id="px-results"></div></div>
      <p class="px-credit">Fishing & vessel data © <a href="https://globalfishingwatch.org" target="_blank" rel="noreferrer">Global Fishing Watch</a> (CC BY-NC 4.0) · Fish records © <a href="https://obis.org" target="_blank" rel="noreferrer">OBIS</a></p>`;

    const sidebar = $('.sidebar'), details = $('.details'), mapArea = state.viewer.container.closest('.map-area');
    sidebar.appendChild(left);
    (details || mapArea).appendChild(right);
    const legend = document.createElement('div');
    legend.id = 'px-legend';
    legend.hidden = true;
    const hint = document.createElement('div');
    hint.id = 'px-hint';
    mapArea.append(legend, hint);
    document.body.classList.add('px-on');

    renderSpeciesList();
    changed();

    // Where
    $('#px-click').onchange = (e) => { state.clickToAdd = e.target.checked; renderHint(); };
    $('#px-size').onchange = (e) => { state.size = +e.target.value; renderHint(); };
    $('#px-place').onsubmit = (e) => {
      e.preventDefault();
      const q = $('#px-place input').value.trim();
      if (q.length >= 2) searchPlace(q);
    };
    // What
    $('#px-allfish').onchange = (e) => { state.sel.allFish = e.target.checked; changed(); };
    $('#px-species-filter').oninput = renderSpeciesList;
    $('#px-any').onsubmit = (e) => {
      e.preventDefault();
      const name = $('#px-any input').value.trim();
      if (name.length < 3) return;
      if (!state.sel.custom.some((c) => c.name.toLowerCase() === name.toLowerCase())) state.sel.custom.push({ name, on: true });
      $('#px-any input').value = '';
      renderCustom();
      changed();
    };
    const onDates = () => {
      const start = $('#px-start').value, end = $('#px-end').value;
      if (!start || !end || start >= end) return;
      state.start = start; state.end = end;
      changed();
    };
    $('#px-start').onchange = onDates;
    $('#px-end').onchange = onDates;
    left.addEventListener('change', (e) => {
      const t = e.target;
      const toggle = (set, key) => (t.checked ? set.add(key) : set.delete(key));
      if (t.dataset.species) toggle(state.sel.species, t.dataset.species);
      else if (t.dataset.custom) state.sel.custom[+t.dataset.custom].on = t.checked;
      else if (t.dataset.heat) toggle(state.sel.heat, t.dataset.heat);
      else if (t.dataset.event) toggle(state.sel.events, t.dataset.event);
      else if (t.dataset.bound) toggle(state.sel.bounds, t.dataset.bound);
      else return;
      changed();
    });
    // Actions
    $('#px-show').onclick = run;
    $('#px-reset').onclick = () => {
      state.runSeq++;
      state.areas = [];
      state.sel = { allFish: false, species: new Set(), custom: [], heat: new Set(), events: new Set(), bounds: new Set() };
      state.shown = false;
      state.dirty = false;
      state.clickToAdd = true;
      $$('#px-left input[type=checkbox]').forEach((c) => (c.checked = false));
      $('#px-click').checked = true;
      renderCustom();
      clearMap();
      drawAreas();
      renderLegend([], [], [], []);
      showResults();
      changed();
    };
    $('#px-back').onclick = showResults;
    $('#px-vsearch').onsubmit = (e) => {
      e.preventDefault();
      const q = $('#px-vsearch input').value.trim();
      if (q.length >= 3) searchVessels(q);
    };
    document.addEventListener('click', (e) => {
      const el = e.target.closest('[data-remove-area],[data-zoom-area],[data-preset],[data-vessel],[data-add-species]');
      if (!el || !el.closest('#px-left, #px-right')) return;
      if (el.dataset.removeArea) removeArea(el.dataset.removeArea);
      else if (el.dataset.zoomArea) zoomTo(state.areas.find((a) => a.id === el.dataset.zoomArea).bbox);
      else if (el.dataset.preset) {
        const p = PRESETS[+el.dataset.preset];
        addArea(p.name, p.bbox, p.dates);
        zoomTo(p.bbox);
      } else if (el.dataset.vessel) openVessel(el.dataset.vessel);
      else if (el.dataset.addSpecies) {
        const name = el.dataset.addSpecies;
        const guide = species().find((sp) => sp.scientific === name);
        if (guide) state.sel.species.add(name);
        else if (!state.sel.custom.some((c) => c.name === name)) state.sel.custom.push({ name, on: true });
        renderSpeciesList();
        renderCustom();
        run();
      }
    });
  }

  async function init(viewer) {
    if (state.viewer === viewer) return;
    state.viewer = viewer;
    const Cesium = window.Cesium;
    // The explorer owns globe clicks; the atlas's own click-to-search is switched off.
    // (Deferred: the atlas registers its handler right after announcing the viewer.)
    setTimeout(() => {
      viewer.screenSpaceEventHandler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_CLICK);
      viewer.entities.removeAll();
      viewer.scene.requestRender();
    }, 0);
    const prims = viewer.scene.primitives;
    state.outlines = prims.add(new Cesium.PolylineCollection());
    state.vesselLines = prims.add(new Cesium.PolylineCollection());
    state.fishPoints = prims.add(new Cesium.PointPrimitiveCollection());
    state.eventPoints = prims.add(new Cesium.PointPrimitiveCollection());
    state.vesselPoints = prims.add(new Cesium.PointPrimitiveCollection());
    state.labels = prims.add(new Cesium.LabelCollection());
    new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas).setInputAction(onClick, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    viewer.scene.camera.moveEnd.addEventListener(() => viewer.scene.requestRender());
    // The explorer draws only with its own primitives. Anything the atlas adds to
    // viewer.entities (e.g. from an older cached bundle) is removed straight away.
    viewer.entities.collectionChanged.addEventListener(() => {
      if (viewer.entities.values.length) setTimeout(() => {
        viewer.entities.removeAll();
        viewer.scene.requestRender();
      }, 0);
    });
    if (!$('#px-left')) buildPanels();

    try {
      state.gfwReady = !!(await (await fetch('/api/config')).json()).gfw;
    } catch {
      state.gfwReady = false; // plain static server without server.py
    }
    $('#px-token').hidden = state.gfwReady;
  }

  if (window.pelagicViewer) init(window.pelagicViewer);
  window.addEventListener('pelagic:viewer', (e) => init(e.detail));
})();
