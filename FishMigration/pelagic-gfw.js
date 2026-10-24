// Pelagic × Global Fishing Watch overlay.
// Adds GFW layers (apparent fishing effort, MPAs, EEZs, RFMOs), an area report
// (fishing hours by flag, fishing events, every fish species OBIS has recorded there),
// and an "any species" search on top of the Pelagic globe. All API calls go through
// server.py, which holds the GFW token.
(() => {
  'use strict';

  const GFW = '/api/gfw';
  const OBIS = '/api/obis';
  const EFFORT_DATASET = 'public-global-fishing-effort:latest';
  const EVENTS_DATASET = 'public-global-fishing-events:latest';
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
    effortLayer: null,
    contextLayers: {},
    densityLayer: null,
    eventsPoints: null,
    plotPoints: null,
    plots: [],
    area: null,
    analyze: true,
    reportSeq: 0,
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
    if (!r.ok) throw new Error(body.error || body.message || (body.messages && body.messages.join('; ')) || `HTTP ${r.status}`);
    return body;
  };

  const dateRange = () => `${state.start},${state.end}`;

  function bboxPolygon([w, s, e, n]) {
    return { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] };
  }

  async function showEffort(on) {
    const { viewer } = state;
    const Cesium = window.Cesium;
    if (state.effortLayer) {
      viewer.imageryLayers.remove(state.effortLayer, true);
      state.effortLayer = null;
    }
    if (!on) {
      setStatus('effort', '');
      return viewer.scene.requestRender();
    }
    setStatus('effort', 'Loading fishing activity…');
    try {
      const params = new URLSearchParams({ interval: 'DAY', 'datasets[0]': EFFORT_DATASET, 'date-range': dateRange(), color: '#ff7a1a' });
      const style = await gfwJSON(`/4wings/generate-png?${params}`, { method: 'POST' });
      const url = style.url.replace(/^https:\/\/gateway\.api\.globalfishingwatch\.org\/v3/, GFW);
      const provider = new Cesium.UrlTemplateImageryProvider({ url, maximumLevel: 12, credit: 'Global Fishing Watch' });
      state.effortLayer = viewer.imageryLayers.addImageryProvider(provider, 1);
      state.effortLayer.alpha = 0.9;
      setStatus('effort', `AIS apparent fishing effort · ${state.start} → ${state.end}`);
      renderLegend(style.colorRamp);
      viewer.scene.requestRender();
    } catch (err) {
      setStatus('effort', `Fishing effort unavailable: ${err.message}`);
      $('#gfw-effort').checked = false;
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
      setStatus(def.id, '');
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
      setStatus('density', '');
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

  // ---------------------------------------------------------------------------
  // Area report

  async function analyzeArea(area) {
    const seq = ++state.reportSeq;
    state.area = area;
    const box = $('#gfw-report');
    box.hidden = false;
    $('#gfw-report-title').textContent = area.name;
    $('#gfw-flags').innerHTML = '<p class="gfw-muted">Loading fishing hours…</p>';
    $('#gfw-events-summary').textContent = 'Loading fishing events…';
    $('#gfw-checklist').innerHTML = '<p class="gfw-muted">Loading species recorded here…</p>';
    const geometry = bboxPolygon(area.bbox);

    const flags = (async () => {
      if (!state.gfwReady) throw new Error('Set GFW_TOKEN on the server to enable');
      const params = new URLSearchParams({
        'spatial-resolution': 'LOW', 'temporal-resolution': 'ENTIRE', 'spatial-aggregation': 'true',
        'group-by': 'FLAG', 'datasets[0]': EFFORT_DATASET, 'date-range': dateRange(), format: 'JSON',
      });
      const report = await gfwJSON(`/4wings/report?${params}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ geojson: geometry }),
      });
      const byFlag = {};
      for (const entry of report.entries || []) {
        for (const rows of Object.values(entry)) {
          for (const row of rows || []) byFlag[row.flag || '—'] = (byFlag[row.flag || '—'] || 0) + (row.hours || 0);
        }
      }
      return Object.entries(byFlag).sort((a, b) => b[1] - a[1]);
    })();

    const events = (async () => {
      if (!state.gfwReady) throw new Error('Set GFW_TOKEN on the server to enable');
      return gfwJSON('/events?offset=0&limit=200', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ datasets: [EVENTS_DATASET], startDate: state.start, endDate: state.end, geometry }),
      });
    })();

    const checklist = (async () => {
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
      const species = [...byName.values()];
      return { total: lists.reduce((s, l) => s + (l.total || 0), 0), species: species.sort((a, b) => (b.records || 0) - (a.records || 0)) };
    })();

    flags.then((rows) => {
      if (seq !== state.reportSeq) return;
      const total = rows.reduce((s, r) => s + r[1], 0);
      $('#gfw-flags').innerHTML = rows.length
        ? `<p><strong>${Math.round(total).toLocaleString()}</strong> hours of apparent fishing</p>` +
          rows.slice(0, 8).map(([flag, h]) => `<div class="gfw-bar"><span>${esc(flag)}</span><i style="width:${Math.max(2, (100 * h) / rows[0][1])}%"></i><small>${Math.round(h).toLocaleString()} h</small></div>`).join('')
        : '<p class="gfw-muted">No AIS fishing activity detected here in this period.</p>';
    }).catch((err) => {
      if (seq === state.reportSeq) $('#gfw-flags').innerHTML = `<p class="gfw-muted">Fishing report unavailable: ${esc(err.message)}</p>`;
    });

    events.then((res) => {
      if (seq !== state.reportSeq) return;
      plotEvents(res.entries || []);
      $('#gfw-events-summary').textContent = `${(res.total ?? (res.entries || []).length).toLocaleString()} fishing events (orange) · showing ${(res.entries || []).length}`;
    }).catch((err) => {
      if (seq === state.reportSeq) $('#gfw-events-summary').textContent = `Fishing events unavailable: ${err.message}`;
    });

    checklist.then(({ species, total }) => {
      if (seq !== state.reportSeq) return;
      $('#gfw-checklist').innerHTML = species.length
        ? `<p>${total.toLocaleString()} fish taxa recorded here. Click one to plot it.</p>` +
          species.slice(0, 60).map((t) => `<button class="gfw-taxon" data-name="${esc(t.scientificName)}"><i>${esc(t.scientificName)}</i><small>${(t.records || 0).toLocaleString()}</small></button>`).join('')
        : '<p class="gfw-muted">No fish records in OBIS for this area.</p>';
    }).catch((err) => {
      if (seq === state.reportSeq) $('#gfw-checklist').innerHTML = `<p class="gfw-muted">Species list unavailable: ${esc(err.message)}</p>`;
    });
  }

  function plotEvents(entries) {
    const Cesium = window.Cesium;
    state.eventsPoints.removeAll();
    for (const e of entries) {
      if (!e.position) continue;
      state.eventsPoints.add({
        position: Cesium.Cartesian3.fromDegrees(e.position.lon, e.position.lat, 2500),
        pixelSize: 7,
        color: Cesium.Color.fromCssColorString('#ff7a1a'),
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 1,
        id: { gfwEvent: e },
      });
    }
    state.viewer.scene.requestRender();
  }

  // Plot any OBIS species (or higher taxon) on top of the guide species.
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
    $('#gfw-plots').innerHTML = state.plots.map((p, i) => `
      <div class="gfw-plot"><i style="background:${p.color}"></i>
        <span><em>${esc(p.name)}</em><small>${p.loading ? 'Loading…' : p.error ? esc(p.error) : `${p.count.toLocaleString()} of ${(p.total ?? p.count).toLocaleString()} records`}</small></span>
        <button data-remove="${i}" aria-label="Remove ${esc(p.name)}">×</button></div>`).join('');
  }

  function renderLegend(ramp) {
    const steps = ramp && ramp.stepsByZoom && (ramp.stepsByZoom[2] || ramp.stepsByZoom[Object.keys(ramp.stepsByZoom)[0]]);
    $('#gfw-legend').innerHTML = steps && steps.length
      ? `<div class="gfw-ramp">${steps.map((s) => `<i style="background:${s.color}"></i>`).join('')}</div><div class="gfw-ramp-labels"><span>Less fishing</span><span>More</span></div>`
      : '';
  }

  // ---------------------------------------------------------------------------
  // Clicks on the globe

  function onClick(movement) {
    const { viewer } = state;
    const Cesium = window.Cesium;
    const picked = viewer.scene.pick(movement.position);
    if (picked && picked.id && picked.id.gfwEvent) return showInfo(eventHtml(picked.id.gfwEvent));
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
    }
  }

  const zoneHtml = (def, p) => {
    const name = p.name || p.NAME || p.label || p.WDPA_NAME || p.GEONAME || p.id || 'Unnamed area';
    const extra = [p.desig_eng || p.DESIG_ENG, p.iucn_cat || p.IUCN_CAT ? `IUCN ${p.iucn_cat || p.IUCN_CAT}` : '', p.status_yr || p.STATUS_YR ? `since ${p.status_yr || p.STATUS_YR}` : '', p.no_take || p.NO_TAKE ? `No-take: ${p.no_take || p.NO_TAKE}` : '']
      .filter(Boolean).join(' · ');
    return `<div class="gfw-zone"><small>${esc(def.label)}</small><strong>${esc(name)}</strong>${extra ? `<span>${esc(extra)}</span>` : ''}</div>`;
  };

  const eventHtml = (e) => {
    const v = e.vessel || {};
    return `<div class="gfw-zone"><small>Fishing event · Global Fishing Watch</small>
      <strong>${esc(v.name || 'Unknown vessel')}</strong>
      <span>${esc([v.flag, v.type, v.ssvid ? `MMSI ${v.ssvid}` : ''].filter(Boolean).join(' · '))}</span>
      <span>${esc((e.start || '').slice(0, 16).replace('T', ' '))} → ${esc((e.end || '').slice(0, 16).replace('T', ' '))}</span>
      ${v.id ? `<a target="_blank" rel="noreferrer" href="https://globalfishingwatch.org/map/vessel/${encodeURIComponent(v.id)}">Open vessel in GFW ↗</a>` : ''}</div>`;
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
    const panel = $('#gfw-panel');
    panel.classList.toggle('open', open);
    document.body.classList.toggle('gfw-open', open);
  }

  function toggleRow(id, label, note) {
    return `<label class="gfw-toggle"><span><strong>${label}</strong><small data-status="${id}">${note}</small></span><input type="checkbox" id="gfw-${id}"></label>`;
  }

  function buildPanel(mapArea) {
    const panel = document.createElement('section');
    panel.id = 'gfw-panel';
    panel.setAttribute('aria-label', 'Global Fishing Watch layers');
    panel.innerHTML = `
      <button class="gfw-tab" id="gfw-tab"><span class="gfw-dot"></span> Fishing Watch</button>
      <div class="gfw-body">
        <div class="gfw-head"><span class="gfw-eyebrow">Global Fishing Watch × OBIS</span><button id="gfw-close" aria-label="Close panel">×</button></div>
        <p class="gfw-token" id="gfw-token" hidden>No GFW token on the server — fishing layers are off. See README.</p>
        <button class="gfw-preset" id="gfw-cmar">Eastern Tropical Pacific corridor (CMAR MPAs) →</button>
        <div class="gfw-dates">
          <label>From<input type="date" id="gfw-start" value="${state.start}"></label>
          <label>To<input type="date" id="gfw-end" value="${state.end}"></label>
        </div>
        <h4>Fishing activity</h4>
        ${toggleRow('effort', 'Apparent fishing effort', 'AIS-based fishing hours')}
        <div id="gfw-legend"></div>
        <h4>Ocean boundaries</h4>
        ${CONTEXT_LAYERS.map((d) => toggleRow(d.id, d.label, d.note)).join('')}
        <h4>Fish everywhere</h4>
        ${toggleRow('density', 'All fish records (density)', 'Every ray-finned fish, shark & ray in OBIS')}
        <form id="gfw-search" class="gfw-search">
          <input id="gfw-species" placeholder="Plot any species, genus or family" autocomplete="off">
          <button type="submit">Plot</button>
        </form>
        <div id="gfw-plots"></div>
        <label class="gfw-check"><input type="checkbox" id="gfw-analyze" checked> Report on the area I click</label>
        <div id="gfw-info" hidden></div>
        <div id="gfw-report" hidden>
          <h4 id="gfw-report-title"></h4>
          <h5>Fishing hours by vessel flag</h5>
          <div id="gfw-flags"></div>
          <h5>Fishing events</h5>
          <p class="gfw-muted" id="gfw-events-summary"></p>
          <h5>Fish recorded here (OBIS)</h5>
          <div id="gfw-checklist"></div>
        </div>
        <p class="gfw-credit">Fishing data © <a href="https://globalfishingwatch.org" target="_blank" rel="noreferrer">Global Fishing Watch</a> (CC BY-NC 4.0). Fish records © <a href="https://obis.org" target="_blank" rel="noreferrer">OBIS</a>.</p>
      </div>`;
    mapArea.appendChild(panel);

    $('#gfw-tab').onclick = () => openPanel(!panel.classList.contains('open'));
    $('#gfw-close').onclick = () => openPanel(false);
    $('#gfw-effort').onchange = (e) => showEffort(e.target.checked);
    $('#gfw-density').onchange = (e) => showDensity(e.target.checked);
    $('#gfw-analyze').onchange = (e) => (state.analyze = e.target.checked);
    for (const def of CONTEXT_LAYERS) $(`#gfw-${def.id}`).onchange = (e) => showContext(def, e.target.checked);
    const onDates = () => {
      const start = $('#gfw-start').value, end = $('#gfw-end').value;
      if (!start || !end || start >= end) return;
      state.start = start; state.end = end;
      if ($('#gfw-effort').checked) showEffort(true);
      if (state.area) analyzeArea(state.area);
    };
    $('#gfw-start').onchange = onDates;
    $('#gfw-end').onchange = onDates;
    $('#gfw-cmar').onclick = () => {
      $('#gfw-start').value = CMAR.start; $('#gfw-end').value = CMAR.end;
      state.start = CMAR.start; state.end = CMAR.end;
      for (const id of ['mpa', 'effort']) {
        const box = $(`#gfw-${id}`);
        if (box.disabled) continue;
        box.checked = true;
        box.dispatchEvent(new Event('change'));
      }
      state.viewer.camera.flyTo({ destination: window.Cesium.Cartesian3.fromDegrees(CMAR.lon, CMAR.lat, CMAR.height), duration: 1.6 });
    };
    $('#gfw-search').onsubmit = (e) => {
      e.preventDefault();
      const name = $('#gfw-species').value.trim();
      if (name.length < 3) return;
      $('#gfw-species').value = '';
      plotSpecies(name);
    };
    panel.addEventListener('click', (e) => {
      const taxon = e.target.closest('.gfw-taxon');
      if (taxon) plotSpecies(taxon.dataset.name, state.area && state.area.bbox);
      const remove = e.target.closest('[data-remove]');
      if (remove) removePlot(+remove.dataset.remove);
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
      for (const id of ['effort', ...CONTEXT_LAYERS.map((d) => d.id)]) $(`#gfw-${id}`).disabled = true;
    }
  }

  if (window.pelagicViewer) init(window.pelagicViewer);
  window.addEventListener('pelagic:viewer', (e) => init(e.detail));
})();
