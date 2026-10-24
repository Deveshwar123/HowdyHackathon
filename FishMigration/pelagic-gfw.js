// Pelagic × Global Fishing Watch overlay.
// Brings the Global Fishing Watch APIs onto the Pelagic globe:
//   4Wings     — fishing effort, AIS vessel presence and SAR (satellite radar) detection
//                heatmaps, plus area reports by flag, gear type and vessel
//   Events     — fishing, encounters, loitering, port visits and AIS gaps (going dark)
//   Vessels    — search any vessel, its identity and registry details
//   Insights   — IUU listing, fishing in no-take MPAs, AIS-off history for a vessel
//   Datasets   — MPA, EEZ, high seas and RFMO boundaries (vector context layers)
// plus OBIS: every fish species recorded in an area, an all-fish density layer and
// plotting of any taxon. All API calls go through server.py, which holds the GFW token.
(() => {
  'use strict';

  const GFW = '/api/gfw';
  const OBIS = '/api/obis';
  const IDENTITY_DATASET = 'public-global-vessel-identity:latest';
  // 4Wings heatmap datasets.
  const HEATMAPS = [
    { id: 'fishing', dataset: 'public-global-fishing-effort:latest', label: 'Apparent fishing effort', note: 'AIS-based fishing hours', color: '#ff7a1a', unit: 'h' },
    { id: 'presence', dataset: 'public-global-presence:latest', label: 'All vessel presence', note: 'Every AIS-broadcasting vessel', color: '#4fc3f7', unit: 'h' },
    { id: 'sar', dataset: 'public-global-sar-presence:latest', label: 'Satellite radar detections', note: 'SAR — finds vessels with AIS off', color: '#e84a5f', unit: 'detections' },
  ];
  // Events API datasets.
  const EVENT_TYPES = [
    { id: 'fishing', dataset: 'public-global-fishing-events:latest', label: 'Fishing', color: '#ff7a1a', on: true },
    { id: 'encounter', dataset: 'public-global-encounters-events:latest', label: 'Encounters (possible transshipment)', color: '#e84a5f', on: true },
    { id: 'loitering', dataset: 'public-global-loitering-events:latest', label: 'Loitering', color: '#b07cff', on: true },
    { id: 'port', dataset: 'public-global-port-visits-events:latest', label: 'Port visits', color: '#4fc3f7', on: false },
    { id: 'gap', dataset: 'public-global-gaps-events:latest', label: 'AIS gaps (went dark)', color: '#ffd54f', on: true },
  ];
  // Context layers from the GFW Marine Manager map, drawn from GFW vector tiles.
  const CONTEXT_LAYERS = [
    { id: 'mpa', dataset: 'public-mpa-all', label: 'Marine protected areas', note: 'WDPA via Global Fishing Watch', fill: 'rgba(77, 208, 160, 0.22)', stroke: 'rgba(77, 208, 160, 0.95)' },
    { id: 'eez', dataset: 'public-eez-areas', label: 'Exclusive economic zones', note: 'National waters (EEZ)', fill: null, stroke: 'rgba(255, 255, 255, 0.7)' },
    { id: 'highseas', dataset: 'public-high-seas', label: 'High seas', note: 'Waters beyond national jurisdiction', fill: 'rgba(120, 160, 255, 0.10)', stroke: 'rgba(120, 160, 255, 0.6)' },
    { id: 'rfmo', dataset: 'public-rfmo', label: 'Fisheries management (RFMO)', note: 'Regional fisheries bodies', fill: null, stroke: 'rgba(255, 210, 120, 0.8)' },
  ];
  // The Marine Manager workspace this was built from: the Eastern Tropical
  // Pacific Marine Corridor (CMAR) core MPAs, 25 Jul – 23 Oct 2026.
  const CMAR = { lon: -86, lat: 2.5, height: 4.2e6, start: '2026-07-25', end: '2026-10-23' };
  const FISH_TAXA = ['Actinopterygii', 'Elasmobranchii'];
  const PLOT_COLORS = ['#ffb347', '#ff6f91', '#c3f584', '#7fdbff', '#f9f871', '#d29bfd'];

  const state = {
    viewer: null,
    gfwReady: false,
    start: CMAR.start,
    end: CMAR.end,
    heatLayers: {},
    contextLayers: {},
    densityLayer: null,
    eventsPoints: null,
    vesselPoints: null,
    vesselLines: null,
    plotPoints: null,
    plots: [],
    area: null,
    analyze: true,
    reportSeq: 0,
    vesselSeq: 0,
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
  // Cesium imagery providers

  function contextLayerProvider(Cesium, def) {
    const provider = new Cesium.UrlTemplateImageryProvider({
      url: `${GFW}/datasets/${def.dataset}/context-layers/{z}/{x}/{y}`,
      maximumLevel: 9,
      credit: 'Global Fishing Watch',
    });
    const tiles = new Map();
    let failures = 0;
    provider.requestImage = (x, y, level) => fetch(`${GFW}/datasets/${def.dataset}/context-layers/${level}/${x}/${y}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.arrayBuffer();
      })
      .then((buf) => {
        const features = buf.byteLength ? decodeMVT(buf) : [];
        tiles.set(`${level}/${x}/${y}`, features);
        return drawTile(features, def);
      })
      .catch((err) => {
        if (++failures === 3) setStatus(def.id, `Layer unavailable (${err.message})`);
        return drawTile([], def);
      });
    provider.featuresAt = (lon, lat) => {
      for (let z = 9; z >= 0; z--) {
        const t = lonLatToTile(lon, lat, z);
        const features = tiles.get(`${z}/${t.x}/${t.y}`);
        if (!features) continue;
        return features.filter((f) => featureContains(f, t.fx * f.extent, t.fy * f.extent));
      }
      return [];
    };
    return provider;
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
      for (const part of f.parts) {
        part.forEach(([x, y], i) => (i ? ctx.lineTo(x * s, y * s) : ctx.moveTo(x * s, y * s)));
      }
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


  // ---------------------------------------------------------------------------
  // GFW requests

  const gfwJSON = async (path, options) => {
    const r = await fetch(GFW + path, options);
    const text = await r.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { error: text.slice(0, 200) }; }
    if (!r.ok) {
      const detail = body.error || body.message || (body.messages && body.messages.map((m) => m.detail || m.title || m).join('; '));
      throw new Error(typeof detail === 'string' && detail ? detail : `HTTP ${r.status}`);
    }
    return body;
  };
  const postJSON = (path, body) => gfwJSON(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  const dateRange = () => `${state.start},${state.end}`;
  const bboxPolygon = ([w, s, e, n]) => ({ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });
  const fmt = (n) => Math.round(n || 0).toLocaleString();

  // ---------------------------------------------------------------------------
  // Layers

  async function showHeatmap(def, on) {
    const { viewer } = state;
    const Cesium = window.Cesium;
    if (state.heatLayers[def.id]) {
      viewer.imageryLayers.remove(state.heatLayers[def.id], true);
      delete state.heatLayers[def.id];
    }
    if (!on) {
      setStatus(`heat-${def.id}`, def.note);
      return viewer.scene.requestRender();
    }
    setStatus(`heat-${def.id}`, 'Loading…');
    try {
      const params = new URLSearchParams({ interval: 'DAY', 'datasets[0]': def.dataset, 'date-range': dateRange(), color: def.color });
      const style = await postJSON(`/4wings/generate-png?${params}`, {});
      const url = style.url.replace(/^https:\/\/gateway\.api\.globalfishingwatch\.org\/v3/, GFW);
      const provider = new Cesium.UrlTemplateImageryProvider({ url, maximumLevel: 12, credit: 'Global Fishing Watch' });
      const layer = viewer.imageryLayers.addImageryProvider(provider, 1);
      layer.alpha = 0.9;
      state.heatLayers[def.id] = layer;
      setStatus(`heat-${def.id}`, `${def.note} · ${state.start} → ${state.end}`);
      renderLegend(def, style.colorRamp);
      viewer.scene.requestRender();
    } catch (err) {
      setStatus(`heat-${def.id}`, `Unavailable: ${err.message}`);
      $(`#gfw-heat-${def.id}`).checked = false;
    }
  }

  function showContext(def, on) {
    const { viewer } = state;
    const existing = state.contextLayers[def.id];
    if (existing) {
      viewer.imageryLayers.remove(existing.layer, true);
      delete state.contextLayers[def.id];
    }
    if (on) {
      const provider = contextLayerProvider(window.Cesium, def);
      const layer = viewer.imageryLayers.addImageryProvider(provider);
      state.contextLayers[def.id] = { layer, provider, def };
      setStatus(def.id, def.note);
    }
    viewer.scene.requestRender();
  }

  // OBIS density grid of every fish record: drawn once into a world image.
  async function showDensity(on) {
    const { viewer } = state;
    const Cesium = window.Cesium;
    if (state.densityLayer) {
      viewer.imageryLayers.remove(state.densityLayer, true);
      state.densityLayer = null;
    }
    if (!on) {
      setStatus('density', 'Every ray-finned fish, shark & ray in OBIS');
      return viewer.scene.requestRender();
    }
    setStatus('density', 'Loading every fish record in OBIS…');
    try {
      const grids = await Promise.all(FISH_TAXA.map(async (taxon) => {
        const r = await fetch(`${OBIS}/occurrence/grid/3?scientificname=${encodeURIComponent(taxon)}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      }));
      const W = 2048, H = 1024;
      const canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d');
      const cells = grids.flatMap((g) => g.features || []);
      const max = Math.max(1, ...cells.map((f) => f.properties.n || 0));
      let total = 0;
      for (const f of cells) {
        const n = f.properties.n || 0;
        total += n;
        const t = Math.log(1 + n) / Math.log(1 + max);
        ctx.fillStyle = `hsla(${200 - 160 * t}, 90%, ${45 + 25 * t}%, ${0.25 + 0.6 * t})`;
        const polys = f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [f.geometry.coordinates];
        for (const poly of polys) {
          ctx.beginPath();
          poly[0].forEach(([lon, lat], i) => {
            const x = ((lon + 180) / 360) * W, y = ((90 - lat) / 180) * H;
            i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
          });
          ctx.fill();
        }
      }
      const provider = await Cesium.SingleTileImageryProvider.fromUrl(canvas.toDataURL('image/png'), {
        rectangle: Cesium.Rectangle.fromDegrees(-180, -90, 180, 90),
        credit: 'OBIS',
      });
      state.densityLayer = viewer.imageryLayers.addImageryProvider(provider, 1);
      state.densityLayer.alpha = 0.85;
      setStatus('density', `${total.toLocaleString()} fish records in ${cells.length.toLocaleString()} grid cells`);
      viewer.scene.requestRender();
    } catch (err) {
      setStatus('density', `Density unavailable: ${err.message}`);
      $('#gfw-density').checked = false;
    }
  }

  function renderLegend(def, ramp) {
    const steps = ramp && ramp.stepsByZoom && (ramp.stepsByZoom[2] || ramp.stepsByZoom[Object.keys(ramp.stepsByZoom)[0]]);
    $('#gfw-legend').innerHTML = steps && steps.length
      ? `<div class="gfw-ramp">${steps.map((s) => `<i style="background:${s.color}"></i>`).join('')}</div><div class="gfw-ramp-labels"><span>${esc(def.label)}: less</span><span>more</span></div>`
      : '';
  }

  // ---------------------------------------------------------------------------
  // Area report (4Wings report + Events + OBIS checklist)

  // Sums a 4Wings report by one property; rows hold `hours` or `detections`.
  async function report(def, groupBy, geometry) {
    const params = new URLSearchParams({
      'spatial-resolution': 'LOW', 'temporal-resolution': 'ENTIRE', 'spatial-aggregation': 'true',
      'datasets[0]': def.dataset, 'date-range': dateRange(), format: 'JSON',
    });
    if (groupBy) params.set('group-by', groupBy);
    const res = await postJSON(`/4wings/report?${params}`, { geojson: geometry });
    const rows = [];
    for (const entry of res.entries || []) for (const list of Object.values(entry)) rows.push(...(list || []));
    return rows;
  }

  const sumBy = (rows, key) => {
    const out = {};
    for (const r of rows) {
      const k = typeof key === 'function' ? key(r) : r[key] || '—';
      out[k] = (out[k] || 0) + (r.hours ?? r.detections ?? r.value ?? 0);
    }
    return Object.entries(out).sort((a, b) => b[1] - a[1]);
  };

  const label = (k) => (/^[A-Z]{3}$/.test(k) ? k : String(k).toLowerCase().replace(/_/g, ' '));
  const bars = (rows, unit, color = '#ff7a1a') => rows.length
    ? rows.slice(0, 8).map(([k, v]) => `<div class="gfw-bar"><span title="${esc(k)}">${esc(label(k))}</span><i style="width:${Math.max(2, (100 * v) / rows[0][1])}%;background:${color}"></i><small>${fmt(v)} ${unit}</small></div>`).join('')
    : '<p class="gfw-muted">Nothing detected here in this period.</p>';

  function section(id, html) {
    const el = $(`#gfw-${id}`);
    if (el) el.innerHTML = html;
  }

  async function analyzeArea(area) {
    const seq = ++state.reportSeq;
    const current = () => seq === state.reportSeq;
    state.area = area;
    $('#gfw-report').hidden = false;
    $('#gfw-report-title').textContent = area.name;
    const geometry = bboxPolygon(area.bbox);
    const loading = '<p class="gfw-muted">Loading…</p>';
    ['flags', 'gear', 'vessels', 'presence', 'sar', 'events-summary', 'checklist'].forEach((id) => section(id, loading));
    const needToken = (fn) => (state.gfwReady ? fn() : Promise.reject(new Error('GFW is not connected')));
    const show = (promise, id, render) => promise
      .then((v) => current() && section(id, render(v)))
      .catch((err) => current() && section(id, `<p class="gfw-muted">Unavailable: ${esc(err.message)}</p>`));

    const [fishing, presence, sar] = HEATMAPS;
    show(needToken(() => report(fishing, 'FLAG', geometry)), 'flags', (rows) => {
      const byFlag = sumBy(rows, 'flag');
      const total = byFlag.reduce((s, r) => s + r[1], 0);
      return `<p><strong>${fmt(total)}</strong> hours of apparent fishing</p>${bars(byFlag, 'h')}`;
    });
    show(needToken(() => report(fishing, 'GEARTYPE', geometry)), 'gear', (rows) => bars(sumBy(rows, (r) => r.geartype || r.gearType || '—'), 'h'));
    show(needToken(() => report(fishing, 'VESSEL_ID', geometry)), 'vessels', (rows) => {
      const byVessel = new Map();
      for (const r of rows) {
        const id = r.vesselId || r.vessel_id || r.id;
        if (!id) continue;
        const v = byVessel.get(id) || { id, name: r.shipName || r.shipname || r.vesselName, flag: r.flag, gear: r.geartype, hours: 0 };
        v.hours += r.hours || 0;
        byVessel.set(id, v);
      }
      const top = [...byVessel.values()].sort((a, b) => b.hours - a.hours).slice(0, 10);
      return top.length
        ? top.map((v) => `<button class="gfw-vessel" data-vessel="${esc(v.id)}"><span><strong>${esc(v.name || 'Unknown vessel')}</strong><small>${esc([v.flag, v.gear && v.gear.toLowerCase().replace(/_/g, ' ')].filter(Boolean).join(' · '))}</small></span><small>${fmt(v.hours)} h</small></button>`).join('')
        : '<p class="gfw-muted">No fishing vessels detected here in this period.</p>';
    });
    show(needToken(() => report(presence, 'VESSEL_TYPE', geometry)), 'presence', (rows) => bars(sumBy(rows, (r) => r.vessel_type || r.vesselType || '—'), 'h', presence.color));
    show(needToken(() => report(sar, 'MATCHED', geometry)), 'sar', (rows) => {
      const total = rows.reduce((s, r) => s + (r.detections ?? r.hours ?? 0), 0);
      const dark = rows.filter((r) => r.matched === false || r.matched === 'false').reduce((s, r) => s + (r.detections ?? 0), 0);
      return `<p><strong>${fmt(total)}</strong> vessels seen by satellite radar${dark ? `, <strong>${fmt(dark)}</strong> not broadcasting AIS (possible dark vessels)` : ''}</p>`;
    });

    // Events API: one request per selected event type.
    const types = EVENT_TYPES.filter((t) => $(`#gfw-ev-${t.id}`).checked);
    state.eventsPoints.removeAll();
    show(needToken(async () => {
      const results = await Promise.all(types.map(async (t) => {
        try {
          const res = await postJSON('/events?offset=0&limit=200', { datasets: [t.dataset], startDate: state.start, endDate: state.end, geometry });
          if (current()) plotEvents(res.entries || [], t);
          return { t, total: res.total ?? (res.entries || []).length };
        } catch (err) {
          return { t, error: err.message };
        }
      }));
      return results;
    }), 'events-summary', (results) => results.length
      ? results.map(({ t, total, error }) => `<div class="gfw-legend-row"><i style="background:${t.color}"></i><span>${esc(t.label)}</span><small>${error ? `unavailable: ${esc(error)}` : fmt(total)}</small></div>`).join('')
      : '<p class="gfw-muted">Choose event types above.</p>');

    show((async () => {
      const wkt = `POLYGON((${geometry.coordinates[0].map((p) => p.join(' ')).join(',')}))`;
      const lists = await Promise.all(FISH_TAXA.map(async (taxon) => {
        const r = await fetch(`${OBIS}/checklist?${new URLSearchParams({ scientificname: taxon, geometry: wkt, size: 200 })}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      }));
      const byName = new Map();
      for (const t of lists.flatMap((l) => l.results || [])) {
        if ((t.taxonRank || '').toLowerCase() === 'species') byName.set(t.scientificName, t);
      }
      return { total: lists.reduce((s, l) => s + (l.total || 0), 0), species: [...byName.values()].sort((a, b) => (b.records || 0) - (a.records || 0)) };
    })(), 'checklist', ({ species, total }) => species.length
      ? `<p>${total.toLocaleString()} fish taxa recorded here. Click one to plot it.</p>` +
        species.slice(0, 60).map((t) => `<button class="gfw-taxon" data-name="${esc(t.scientificName)}"><i>${esc(t.scientificName)}</i><small>${(t.records || 0).toLocaleString()}</small></button>`).join('')
      : '<p class="gfw-muted">No fish records in OBIS for this area.</p>');
  }

  function plotEvents(entries, type, collection = state.eventsPoints) {
    const Cesium = window.Cesium;
    for (const e of entries) {
      if (!e.position) continue;
      collection.add({
        position: Cesium.Cartesian3.fromDegrees(e.position.lon, e.position.lat, 2500),
        pixelSize: 7,
        color: Cesium.Color.fromCssColorString(type.color),
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 1,
        id: { gfwEvent: e, type },
      });
    }
    state.viewer.scene.requestRender();
  }

  // ---------------------------------------------------------------------------
  // Vessels API + Insights API

  async function searchVessels(query) {
    section('vessel-results', '<p class="gfw-muted">Searching…</p>');
    try {
      const params = new URLSearchParams({ query, 'datasets[0]': IDENTITY_DATASET, limit: 10 });
      const res = await gfwJSON(`/vessels/search?${params}`);
      const entries = (res.entries || []).map(vesselSummary).filter((v) => v.id);
      section('vessel-results', entries.length
        ? entries.map((v) => `<button class="gfw-vessel" data-vessel="${esc(v.id)}"><span><strong>${esc(v.name)}</strong><small>${esc([v.flag, v.type, v.ssvid && `MMSI ${v.ssvid}`].filter(Boolean).join(' · '))}</small></span></button>`).join('')
        : '<p class="gfw-muted">No vessels found.</p>');
    } catch (err) {
      section('vessel-results', `<p class="gfw-muted">Vessel search unavailable: ${esc(err.message)}</p>`);
    }
  }

  // Flattens a GFW vessel identity record (self-reported AIS + registries).
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

  async function openVessel(id) {
    const seq = ++state.vesselSeq;
    const current = () => seq === state.vesselSeq;
    openPanel(true);
    selectTab('vessels');
    const box = $('#gfw-vessel');
    box.hidden = false;
    box.innerHTML = '<p class="gfw-muted">Loading vessel…</p>';
    state.vesselPoints.removeAll();
    state.vesselLines.removeAll();

    // Identity (Vessels API).
    let v = { id, name: 'Vessel' };
    try {
      const res = await gfwJSON(`/vessels/${encodeURIComponent(id)}?${new URLSearchParams({ dataset: IDENTITY_DATASET })}`);
      v = vesselSummary(res);
      v.id = v.id || id;
    } catch (err) {
      v.error = err.message;
    }
    if (!current()) return;
    const fields = [['Flag', v.flag], ['MMSI', v.ssvid], ['IMO', v.imo], ['Call sign', v.callsign], ['Gear', v.gear && v.gear.toLowerCase().replace(/_/g, ' ')], ['Type', v.type && v.type.toLowerCase()], ['Owner', v.owner], ['Authorizations', v.authorizations && v.authorizations.join(', ')], ['AIS seen', v.firstSeen && `${v.firstSeen.slice(0, 10)} → ${(v.lastSeen || '').slice(0, 10)}`]];
    box.innerHTML = `
      <div class="gfw-zone"><small>Vessel · Global Fishing Watch</small><strong>${esc(v.name)}</strong>
        ${v.error ? `<span>Identity unavailable: ${esc(v.error)}</span>` : ''}</div>
      <dl class="gfw-facts">${fields.filter(([, val]) => val).map(([k, val]) => `<dt>${k}</dt><dd>${esc(val)}</dd>`).join('')}</dl>
      <a target="_blank" rel="noreferrer" href="https://globalfishingwatch.org/map/vessel/${encodeURIComponent(v.id)}">Open full profile in GFW ↗</a>
      <h5>Risk insights (last 12 months)</h5><div id="gfw-insights"><p class="gfw-muted">Loading…</p></div>
      <h5>Activity on the globe</h5><div id="gfw-vessel-events"><p class="gfw-muted">Loading…</p></div>`;

    // Insights API.
    const end = state.end, start = shiftDate(end, -365);
    postJSON('/insights/vessels', {
      includes: ['FISHING', 'GAP', 'COVERAGE', 'VESSEL-IDENTITY-IUU-VESSEL-LIST'],
      startDate: start, endDate: end,
      vessels: [{ datasetId: IDENTITY_DATASET, vesselId: v.id }],
    }).then((ins) => current() && section('insights', insightsHtml(ins)))
      .catch((err) => current() && section('insights', `<p class="gfw-muted">Insights unavailable: ${esc(err.message)}</p>`));

    // Events API for this vessel: plotted in time order and joined by a line.
    const results = await Promise.all(EVENT_TYPES.map(async (t) => {
      try {
        const params = new URLSearchParams({ 'vessels[0]': v.id, 'datasets[0]': t.dataset, 'start-date': start, 'end-date': end, limit: 200, offset: 0 });
        const res = await gfwJSON(`/events?${params}`);
        return { t, entries: res.entries || [] };
      } catch (err) {
        return { t, entries: [], error: err.message };
      }
    }));
    if (!current()) return;
    const all = [];
    for (const { t, entries } of results) {
      plotEvents(entries, t, state.vesselPoints);
      for (const e of entries) if (e.position) all.push({ ...e, type: t });
    }
    all.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    const Cesium = window.Cesium;
    if (all.length > 1) {
      state.vesselLines.add({
        positions: Cesium.Cartesian3.fromDegreesArrayHeights(all.flatMap((e) => [e.position.lon, e.position.lat, 3000])),
        width: 1.5,
        material: Cesium.Material.fromType('Color', { color: Cesium.Color.WHITE.withAlpha(0.6) }),
      });
    }
    if (all.length) {
      const lons = all.map((e) => e.position.lon), lats = all.map((e) => e.position.lat);
      state.viewer.camera.flyTo({ destination: Cesium.Rectangle.fromDegrees(Math.min(...lons) - 2, Math.min(...lats) - 2, Math.max(...lons) + 2, Math.max(...lats) + 2), duration: 1.5 });
    }
    state.viewer.scene.requestRender();
    section('vessel-events', results.map(({ t, entries, error }) => `<div class="gfw-legend-row"><i style="background:${t.color}"></i><span>${esc(t.label)}</span><small>${error ? 'unavailable' : entries.length}</small></div>`).join('') +
      (all.length ? `<p class="gfw-muted">Line joins events in time order (${all[0].start.slice(0, 10)} → ${all[all.length - 1].start.slice(0, 10)}). <button class="gfw-link" id="gfw-clear-vessel">Clear</button></p>` : '<p class="gfw-muted">No events in the last 12 months.</p>'));
  }

  function insightsHtml(ins) {
    const rows = [];
    const fishing = ins.apparentFishing || {};
    const fc = fishing.periodSelectedCounters || {};
    const gap = ins.gap || {};
    const gc = gap.periodSelectedCounters || {};
    const iuu = (ins.vesselIdentity || {}).iuuVesselList || {};
    const cov = ins.coverage || {};
    if (iuu.totalTimesListed !== undefined || iuu.valuesInThePeriod) {
      const listed = (iuu.totalTimesListedInThePeriod || 0) > 0 || (iuu.valuesInThePeriod || []).length > 0;
      rows.push([listed ? 'warn' : 'ok', 'IUU vessel list', listed ? 'Listed as illegal, unreported or unregulated' : 'Not on IUU lists']);
    }
    if (fc.events !== undefined) rows.push(['', 'Fishing events', fmt(fc.events)]);
    if (fc.eventsInNoTakeMPAs !== undefined) rows.push([fc.eventsInNoTakeMPAs ? 'warn' : 'ok', 'Fishing in no-take MPAs', fmt(fc.eventsInNoTakeMPAs)]);
    if (fc.eventsInRFMOWithoutKnownAuthorization !== undefined) rows.push([fc.eventsInRFMOWithoutKnownAuthorization ? 'warn' : 'ok', 'Fishing in RFMOs without known authorization', fmt(fc.eventsInRFMOWithoutKnownAuthorization)]);
    if (gc.eventsGapOff !== undefined || gc.events !== undefined) rows.push([(gc.eventsGapOff ?? gc.events) ? 'warn' : 'ok', 'AIS turned off', fmt(gc.eventsGapOff ?? gc.events)]);
    if (cov.percentage !== undefined) rows.push(['', 'AIS coverage', `${Math.round(cov.percentage)}%`]);
    return rows.length
      ? rows.map(([level, k, val]) => `<div class="gfw-insight ${level}"><span>${esc(k)}</span><strong>${esc(val)}</strong></div>`).join('')
      : '<p class="gfw-muted">No insights returned for this vessel.</p>';
  }

  const shiftDate = (iso, days) => {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    const s = d.toISOString().slice(0, 10);
    return s < '2020-01-01' ? '2020-01-01' : s;
  };

  // ---------------------------------------------------------------------------
  // OBIS species plots

  async function plotSpecies(name, bbox) {
    const Cesium = window.Cesium;
    const color = PLOT_COLORS[state.plots.length % PLOT_COLORS.length];
    const plot = { name, color, count: 0, loading: true, points: [] };
    state.plots.push(plot);
    renderPlots();
    try {
      const params = new URLSearchParams({ species: name });
      if (bbox) params.set('bbox', bbox.join(','));
      const r = await fetch(`/api/observations?${params}`);
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      for (const rec of data.results || []) {
        if (!Number.isFinite(rec.decimalLatitude) || !Number.isFinite(rec.decimalLongitude)) continue;
        plot.points.push(state.plotPoints.add({
          position: Cesium.Cartesian3.fromDegrees(rec.decimalLongitude, rec.decimalLatitude, 2200),
          pixelSize: 5,
          color: Cesium.Color.fromCssColorString(color),
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 1,
          id: { obisRecord: rec, plot: name },
        }));
      }
      plot.count = plot.points.length;
      plot.total = data.total;
    } catch (err) {
      plot.error = err.message;
    }
    plot.loading = false;
    renderPlots();
    state.viewer.scene.requestRender();
  }

  function removePlot(i) {
    const [plot] = state.plots.splice(i, 1);
    plot.points.forEach((p) => state.plotPoints.remove(p));
    renderPlots();
    state.viewer.scene.requestRender();
  }

  function renderPlots() {
    section('plots', state.plots.map((p, i) => `
      <div class="gfw-plot"><i style="background:${p.color}"></i>
        <span><em>${esc(p.name)}</em><small>${p.loading ? 'Loading…' : p.error ? esc(p.error) : `${p.count.toLocaleString()} of ${(p.total ?? p.count).toLocaleString()} records`}</small></span>
        <button data-remove="${i}" aria-label="Remove ${esc(p.name)}">×</button></div>`).join(''));
  }

  // ---------------------------------------------------------------------------
  // Clicks on the globe

  function onClick(movement) {
    const { viewer } = state;
    const Cesium = window.Cesium;
    const picked = viewer.scene.pick(movement.position);
    if (picked && picked.id && picked.id.gfwEvent) return showInfo(eventHtml(picked.id.gfwEvent, picked.id.type));
    if (picked && picked.id && picked.id.obisRecord) return showInfo(recordHtml(picked.id.obisRecord, picked.id.plot));
    const cart = viewer.camera.pickEllipsoid(movement.position, viewer.scene.globe.ellipsoid);
    if (!cart) return;
    const c = Cesium.Cartographic.fromCartesian(cart);
    const lon = Cesium.Math.toDegrees(c.longitude), lat = Cesium.Math.toDegrees(c.latitude);
    const zones = [];
    for (const { provider, def } of Object.values(state.contextLayers)) {
      for (const f of provider.featuresAt(lon, lat)) zones.push(zoneHtml(def, f.props));
    }
    showInfo(zones.join(''));
    if (state.analyze) {
      // Same 6° × 6° box the atlas uses when you click the globe.
      const bbox = [Math.max(-180, lon - 3), Math.max(-90, lat - 3), Math.min(180, lon + 3), Math.min(90, lat + 3)];
      const name = `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(1)}°${lon >= 0 ? 'E' : 'W'}`;
      analyzeArea({ bbox, name });
      openPanel(true);
      selectTab('area');
    }
  }

  const zoneHtml = (def, p) => {
    const name = p.name || p.NAME || p.label || p.WDPA_NAME || p.GEONAME || p.id || 'Unnamed area';
    const extra = [p.desig_eng || p.DESIG_ENG, p.iucn_cat || p.IUCN_CAT ? `IUCN ${p.iucn_cat || p.IUCN_CAT}` : '', p.status_yr || p.STATUS_YR ? `since ${p.status_yr || p.STATUS_YR}` : '', p.no_take || p.NO_TAKE ? `No-take: ${p.no_take || p.NO_TAKE}` : '']
      .filter(Boolean).join(' · ');
    return `<div class="gfw-zone"><small>${esc(def.label)}</small><strong>${esc(name)}</strong>${extra ? `<span>${esc(extra)}</span>` : ''}</div>`;
  };

  const eventHtml = (e, type) => {
    const v = e.vessel || {};
    const other = e.encounter && e.encounter.vessel;
    const port = e.port_visit && (e.port_visit.intermediateAnchorage || e.port_visit.startAnchorage);
    const hours = e.start && e.end ? ` · ${((Date.parse(e.end) - Date.parse(e.start)) / 36e5).toFixed(1)} h` : '';
    return `<div class="gfw-zone" style="border-color:${type ? type.color : '#111'}"><small>${esc(type ? type.label : 'Event')} event · Global Fishing Watch</small>
      <strong>${esc(v.name || 'Unknown vessel')}</strong>
      <span>${esc([v.flag, v.type, v.ssvid ? `MMSI ${v.ssvid}` : ''].filter(Boolean).join(' · '))}</span>
      <span>${esc((e.start || '').slice(0, 16).replace('T', ' '))} → ${esc((e.end || '').slice(0, 16).replace('T', ' '))}${hours}</span>
      ${other ? `<span>With ${esc(other.name || 'unknown vessel')} (${esc(other.flag || '?')})</span>` : ''}
      ${port ? `<span>Port: ${esc(port.name || port.label || '')} ${esc(port.flag || '')}</span>` : ''}
      ${v.id ? `<button class="gfw-link" data-vessel="${esc(v.id)}">Vessel profile & risk insights →</button>` : ''}</div>`;
  };

  const recordHtml = (r, plot) => `<div class="gfw-zone"><small>OBIS record · ${esc(plot)}</small>
      <strong><i>${esc(r.scientificName || plot)}</i></strong>
      <span>${esc((r.eventDate || 'Date not provided').slice(0, 10))} · ${esc(r.datasetName || 'OBIS dataset')}</span>
      <a target="_blank" rel="noreferrer" href="https://obis.org/occurrence/${encodeURIComponent(r.id)}">View source record ↗</a></div>`;

  function showInfo(html) {
    const info = $('#gfw-info');
    info.innerHTML = html;
    info.hidden = !html;
    if (html) openPanel(true);
  }

  // ---------------------------------------------------------------------------
  // Panel

  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function setStatus(id, text) {
    const el = document.querySelector(`[data-status="${id}"]`);
    if (el) el.textContent = text;
  }

  function openPanel(open) {
    $('#gfw-panel').classList.toggle('open', open);
    document.body.classList.toggle('gfw-open', open);
  }

  function selectTab(tab) {
    document.querySelectorAll('.gfw-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.gfw-page').forEach((p) => (p.hidden = p.dataset.page !== tab));
  }

  const toggleRow = (id, label, note, color) =>
    `<label class="gfw-toggle"><span>${color ? `<i class="gfw-swatch" style="background:${color}"></i>` : ''}<strong>${label}</strong><small data-status="${id}">${note}</small></span><input type="checkbox" id="gfw-${id}"></label>`;

  function buildPanel(mapArea) {
    const panel = document.createElement('section');
    panel.id = 'gfw-panel';
    panel.setAttribute('aria-label', 'Global Fishing Watch');
    panel.innerHTML = `
      <button class="gfw-tab" id="gfw-tab"><span class="gfw-dot"></span> Fishing Watch</button>
      <div class="gfw-body">
        <div class="gfw-head"><span class="gfw-eyebrow">Global Fishing Watch × OBIS</span><button id="gfw-close" aria-label="Close panel">×</button></div>
        <p class="gfw-token" id="gfw-token" hidden>Global Fishing Watch is not connected — check the server window.</p>
        <button class="gfw-preset" id="gfw-cmar">Eastern Tropical Pacific corridor (CMAR MPAs) →</button>
        <div class="gfw-dates">
          <label>From<input type="date" id="gfw-start" value="${state.start}"></label>
          <label>To<input type="date" id="gfw-end" value="${state.end}"></label>
        </div>
        <nav class="gfw-tabs">
          <button data-tab="layers" class="active">Layers</button><button data-tab="area">Area</button><button data-tab="vessels">Vessels</button><button data-tab="fish">Fish</button>
        </nav>
        <div class="gfw-page" data-page="layers">
          <h4>Vessel activity (4Wings)</h4>
          ${HEATMAPS.map((d) => toggleRow(`heat-${d.id}`, d.label, d.note, d.color)).join('')}
          <div id="gfw-legend"></div>
          <h4>Ocean boundaries</h4>
          ${CONTEXT_LAYERS.map((d) => toggleRow(d.id, d.label, d.note, d.stroke)).join('')}
          <h4>Fish everywhere (OBIS)</h4>
          ${toggleRow('density', 'All fish records (density)', 'Every ray-finned fish, shark & ray in OBIS')}
        </div>
        <div class="gfw-page" data-page="area" hidden>
          <label class="gfw-check"><input type="checkbox" id="gfw-analyze" checked> Report on the area I click on the globe</label>
          <h4>Events to show</h4>
          ${EVENT_TYPES.map((t) => `<label class="gfw-check"><input type="checkbox" id="gfw-ev-${t.id}" ${t.on ? 'checked' : ''}><i class="gfw-swatch" style="background:${t.color}"></i>${esc(t.label)}</label>`).join('')}
          <div id="gfw-info" hidden></div>
          <div id="gfw-report" hidden>
            <h4 id="gfw-report-title"></h4>
            <h5>Fishing hours by vessel flag</h5><div id="gfw-flags"></div>
            <h5>Fishing hours by gear type</h5><div id="gfw-gear"></div>
            <h5>Top fishing vessels</h5><div id="gfw-vessels"></div>
            <h5>All vessel traffic by type</h5><div id="gfw-presence"></div>
            <h5>Satellite radar (SAR) detections</h5><div id="gfw-sar"></div>
            <h5>Events</h5><div id="gfw-events-summary"></div>
            <h5>Fish recorded here (OBIS)</h5><div id="gfw-checklist"></div>
          </div>
          <p class="gfw-muted" id="gfw-area-hint">Click anywhere on the ocean to analyse a 6° × 6° area.</p>
        </div>
        <div class="gfw-page" data-page="vessels" hidden>
          <form id="gfw-vessel-search" class="gfw-search">
            <input id="gfw-vessel-query" placeholder="Vessel name, MMSI, IMO or call sign" autocomplete="off">
            <button type="submit">Search</button>
          </form>
          <div id="gfw-vessel-results"></div>
          <div id="gfw-vessel" hidden></div>
        </div>
        <div class="gfw-page" data-page="fish" hidden>
          <form id="gfw-search" class="gfw-search">
            <input id="gfw-species" placeholder="Plot any species, genus or family" autocomplete="off">
            <button type="submit">Plot</button>
          </form>
          <div id="gfw-plots"></div>
          <p class="gfw-muted">Or click an area on the globe and pick from every fish species recorded there.</p>
        </div>
        <p class="gfw-credit">Fishing and vessel data © <a href="https://globalfishingwatch.org" target="_blank" rel="noreferrer">Global Fishing Watch</a> (CC BY-NC 4.0). Fish records © <a href="https://obis.org" target="_blank" rel="noreferrer">OBIS</a>.</p>
      </div>`;
    mapArea.appendChild(panel);

    $('#gfw-tab').onclick = () => openPanel(!panel.classList.contains('open'));
    $('#gfw-close').onclick = () => openPanel(false);
    panel.querySelectorAll('.gfw-tabs button').forEach((b) => (b.onclick = () => selectTab(b.dataset.tab)));
    for (const def of HEATMAPS) $(`#gfw-heat-${def.id}`).onchange = (e) => showHeatmap(def, e.target.checked);
    for (const def of CONTEXT_LAYERS) $(`#gfw-${def.id}`).onchange = (e) => showContext(def, e.target.checked);
    $('#gfw-density').onchange = (e) => showDensity(e.target.checked);
    $('#gfw-analyze').onchange = (e) => (state.analyze = e.target.checked);
    for (const t of EVENT_TYPES) $(`#gfw-ev-${t.id}`).onchange = () => state.area && analyzeArea(state.area);
    const onDates = () => {
      const start = $('#gfw-start').value, end = $('#gfw-end').value;
      if (!start || !end || start >= end) return;
      state.start = start; state.end = end;
      for (const def of HEATMAPS) if ($(`#gfw-heat-${def.id}`).checked) showHeatmap(def, true);
      if (state.area) analyzeArea(state.area);
    };
    $('#gfw-start').onchange = onDates;
    $('#gfw-end').onchange = onDates;
    $('#gfw-cmar').onclick = () => {
      $('#gfw-start').value = CMAR.start; $('#gfw-end').value = CMAR.end;
      state.start = CMAR.start; state.end = CMAR.end;
      for (const id of ['mpa', 'heat-fishing']) {
        const box = $(`#gfw-${id}`);
        if (box.disabled || box.checked) continue;
        box.checked = true;
        box.dispatchEvent(new Event('change'));
      }
      selectTab('layers');
      state.viewer.camera.flyTo({ destination: window.Cesium.Cartesian3.fromDegrees(CMAR.lon, CMAR.lat, CMAR.height), duration: 1.6 });
    };
    $('#gfw-search').onsubmit = (e) => {
      e.preventDefault();
      const name = $('#gfw-species').value.trim();
      if (name.length < 3) return;
      $('#gfw-species').value = '';
      plotSpecies(name);
    };
    $('#gfw-vessel-search').onsubmit = (e) => {
      e.preventDefault();
      const q = $('#gfw-vessel-query').value.trim();
      if (q.length >= 3) searchVessels(q);
    };
    panel.addEventListener('click', (e) => {
      const taxon = e.target.closest('.gfw-taxon');
      if (taxon) {
        plotSpecies(taxon.dataset.name, state.area && state.area.bbox);
        selectTab('fish');
      }
      const remove = e.target.closest('[data-remove]');
      if (remove) removePlot(+remove.dataset.remove);
      const vessel = e.target.closest('[data-vessel]');
      if (vessel) openVessel(vessel.dataset.vessel);
      if (e.target.id === 'gfw-clear-vessel') {
        state.vesselPoints.removeAll();
        state.vesselLines.removeAll();
        state.viewer.scene.requestRender();
      }
    });
  }

  async function init(viewer) {
    if (state.viewer === viewer) return;
    state.viewer = viewer;
    const Cesium = window.Cesium;
    const mapArea = viewer.container.closest('.map-area') || viewer.container.parentElement;
    if (!$('#gfw-panel')) buildPanel(mapArea);
    // Separate primitive collections: the atlas clears viewer.entities on every update.
    state.eventsPoints = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());
    state.vesselLines = viewer.scene.primitives.add(new Cesium.PolylineCollection());
    state.vesselPoints = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());
    state.plotPoints = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());
    new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas).setInputAction(onClick, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    viewer.scene.camera.moveEnd.addEventListener(() => viewer.scene.requestRender());

    try {
      const config = await (await fetch('/api/config')).json();
      state.gfwReady = !!config.gfw;
    } catch {
      state.gfwReady = false; // static server without server.py
    }
    if (!state.gfwReady) {
      $('#gfw-token').hidden = false;
      for (const id of [...HEATMAPS.map((d) => `heat-${d.id}`), ...CONTEXT_LAYERS.map((d) => d.id)]) $(`#gfw-${id}`).disabled = true;
    }
  }

  if (window.pelagicViewer) init(window.pelagicViewer);
  window.addEventListener('pelagic:viewer', (e) => init(e.detail));
})();
