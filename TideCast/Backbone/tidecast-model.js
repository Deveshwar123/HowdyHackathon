// TideCast's length model and species finder, running in the visitor's browser: no server, no
// install. DINOv2 ViT-g/14 (ONNX, 4- or 8-bit weights) turns the photo into 1536 features; the
// trained XGBoost regressor (2,147 trees, model/length-regressor.*) turns those into a length, and
// the same features are compared with every species' reference pictures (model/species-refs.*).
//
// The ONNX file is large, so it downloads once (with progress) and is kept in the browser's Cache
// Storage; later visits load it from disk. Runs on WebGPU when the browser has it, else WebAssembly,
// in a background worker so the page never freezes.
//
//   TCModel.config            where the files are
//   TCModel.isCached(url?)    Promise<bool>  model already downloaded on this browser?
//   TCModel.load(onProgress)  Promise        download (or load from cache) and start the model
//   TCModel.analyze(blob)     Promise<{length_cm, candidates:[{id, name, prob}], ms}>
//   TCModel.state()           'idle' | 'loading' | 'ready' | 'failed'
(() => {
  const ORT_VERSION = '1.30.0';
  const cfg = window.TC_MODEL_CONFIG || {};
  const config = {
    modelUrl: cfg.modelUrl || 'https://huggingface.co/Deveshwar123/tidecast-fish-length/resolve/main/dinov2_vitg14_q4.onnx',
    dataUrl: cfg.dataUrl || null,             // separate weights file, for models over 2 GB of protobuf
    modelBytes: cfg.modelBytes || 0,          // total download size, for the progress bar
    base: cfg.base || '/backbone/model/',
    cacheName: 'tidecast-model-v1',
    worker: cfg.worker || '/backbone/tidecast-model-worker.js',
    ortBase: cfg.ortBase || null,             // onnxruntime-web's dist/ folder; default the jsDelivr CDN
  };
  let st = 'idle', backend = '', reg = null, refs = null, loading = null, lastError = '';

  // ---- the network itself runs in a worker (tidecast-model-worker.js) ---------------------------
  async function cachedResponse(url = config.modelUrl) {
    try { return await (await caches.open(config.cacheName)).match(url); } catch { return null; }
  }
  async function isCached(url) { return !!(await cachedResponse(url)); }

  let worker = null, nextId = 1;
  const pending = new Map();
  function startWorker(onProgress) {
    return new Promise((ok, fail) => {
      try {
        worker = new Worker(config.worker);
      } catch (e) {
        return fail(new Error('This browser can’t run the model in the background.'));
      }
      worker.onerror = (e) => { e.preventDefault && e.preventDefault(); fail(new Error('Couldn’t start the model runtime.')); };
      worker.onmessage = ({ data: m }) => {
        if (m.type === 'progress') onProgress && onProgress(m.f, m.msg);
        else if (m.type === 'ready') { backend = m.ep; ok(); }
        else if (m.type === 'out' || (m.type === 'error' && m.id)) {
          const p = pending.get(m.id);
          pending.delete(m.id);
          if (p) m.type === 'out' ? p.ok(m.emb) : p.fail(new Error(m.message));
        } else if (m.type === 'error') fail(new Error(m.message));
      };
      worker.postMessage({ type: 'load', config: { ...config, ortVersion: ORT_VERSION } });
    });
  }
  function runWorker(px) {
    return new Promise((ok, fail) => {
      const id = nextId++;
      pending.set(id, { ok, fail });
      worker.postMessage({ type: 'run', id, px }, [px.buffer]);
    });
  }

  // ---- the regressor and the species index (small, from this site) --------------------------
  async function loadRegressor() {
    const [h, bin] = await Promise.all([
      fetch(config.base + 'length-regressor.json').then((r) => r.json()),
      fetch(config.base + 'length-regressor.bin').then((r) => r.arrayBuffer()),
    ]);
    // Layout: offsets u32[trees], feature i16[nodes], threshold-or-leaf f32[nodes], left, right.
    // Copied out with slice() because the arrays aren't 4-byte aligned in the file.
    const bytes = new Uint8Array(bin);
    const Child = h.child_dtype === 'uint32' ? Uint32Array : Uint16Array;
    let at = 0;
    const take = (Type, n) => {
      const a = new Type(bytes.slice(at, at + n * Type.BYTES_PER_ELEMENT).buffer);
      at += n * Type.BYTES_PER_ELEMENT;
      return a;
    };
    const offsets = take(Uint32Array, h.trees), feat = take(Int16Array, h.nodes), thr = take(Float32Array, h.nodes);
    const left = take(Child, h.nodes), right = take(Child, h.nodes);
    return { h, offsets, feat, thr, left, right };
  }
  function predictLength(R, emb) {
    const { h, offsets, feat, thr, left, right } = R;
    const x = new Float32Array(h.n_features);
    for (let i = 0; i < x.length; i++) x[i] = (emb[i] - h.feature_mean[i]) / h.feature_scale[i];
    let sum = h.base_score;
    for (let t = 0; t < h.trees; t++) {
      const base = offsets[t];
      let n = 0;
      while (feat[base + n] !== -1) n = x[feat[base + n]] < thr[base + n] ? left[base + n] : right[base + n];
      sum += thr[base + n];
    }
    const [r0, r1] = h.length_range;
    return h.length_min + ((sum - r0) / (r1 - r0)) * (h.length_max - h.length_min);
  }

  async function loadRefs() {
    const [meta, bin] = await Promise.all([
      fetch(config.base + 'species-refs.json').then((r) => r.json()),
      fetch(config.base + 'species-refs.bin').then((r) => r.arrayBuffer()),
    ]);
    const half = new Uint16Array(bin);
    const m = new Float32Array(half.length);
    for (let i = 0; i < half.length; i++) m[i] = f16(half[i]);
    return { meta, m };
  }
  function f16(h) {
    const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
    if (e === 0) return s * 2 ** -14 * (f / 1024);
    if (e === 31) return f ? NaN : s * Infinity;
    return s * 2 ** (e - 15) * (1 + f / 1024);
  }
  function identify(R, emb, top = 3, temperature = 0.03) {
    const { meta, m } = R, d = meta.dim;
    let norm = 0;
    for (let i = 0; i < d; i++) norm += emb[i] * emb[i];
    norm = Math.sqrt(norm) || 1;
    const best = {};
    for (let r = 0; r < meta.count; r++) {
      let s = 0;
      for (let i = 0, o = r * d; i < d; i++) s += m[o + i] * emb[i];
      s /= norm;
      const id = meta.ids[r];
      if (!(id in best) || s > best[id]) best[id] = s;
    }
    const ids = Object.keys(best), vals = ids.map((k) => best[k]), mx = Math.max(...vals);
    const ex = vals.map((v) => Math.exp((v - mx) / temperature)), z = ex.reduce((a, b) => a + b, 0);
    return ids.map((id, i) => ({ id, name: meta.names[id] || id, prob: ex[i] / z }))
      .sort((a, b) => b.prob - a.prob).slice(0, top).map((c) => ({ ...c, prob: Math.round(c.prob * 1000) / 1000 }));
  }

  // ---- preprocessing: exactly the length model's (resize short side to 244, centre crop 224,
  // scale to [-1, 1]) -------------------------------------------------------------------------
  async function pixels(blob) {
    const bmp = await createImageBitmap(blob);
    // torchvision Resize(244): short side 244, long side floor(244 * long / short)
    const short = Math.min(bmp.width, bmp.height);
    const w = bmp.width === short ? 244 : Math.floor((244 * bmp.width) / short);
    const h = bmp.height === short ? 244 : Math.floor((244 * bmp.height) / short);
    const c = document.createElement('canvas');
    c.width = 224;
    c.height = 224;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.fillStyle = '#fff';                        // transparent pixels: white, like Pillow's convert('RGB')
    g.fillRect(0, 0, 224, 224);
    g.drawImage(bmp, -Math.round((w - 224) / 2), -Math.round((h - 224) / 2), w, h);   // CenterCrop(224)
    const d = g.getImageData(0, 0, 224, 224).data;
    const out = new Float32Array(3 * 224 * 224);
    for (let i = 0, p = 0; p < 224 * 224; p++, i += 4) {
      out[p] = d[i] / 127.5 - 1;
      out[224 * 224 + p] = d[i + 1] / 127.5 - 1;
      out[2 * 224 * 224 + p] = d[i + 2] / 127.5 - 1;
    }
    return out;
  }

  async function load(onProgress) {
    if (st === 'ready') return;
    if (loading) return loading;
    st = 'loading';
    loading = (async () => {
      try {
        const [r, s] = await Promise.all([loadRegressor(), loadRefs()]);
        await startWorker(onProgress);
        reg = r;
        refs = s;
        st = 'ready';
      } catch (e) {
        st = 'failed';
        lastError = e && e.message ? e.message : String(e);
        loading = null;
        if (worker) { worker.terminate(); worker = null; }
        throw e;
      }
    })();
    return loading;
  }

  async function embed(blob) {
    return runWorker(await pixels(blob));
  }

  async function analyze(blob) {
    if (st !== 'ready') throw new Error('The model isn’t loaded yet.');
    const t0 = performance.now();
    const emb = await embed(blob);
    return { length_cm: predictLength(reg, emb), candidates: identify(refs, emb), ms: Math.round(performance.now() - t0), embedding: emb };
  }

  window.TCModel = {
    config, isCached, load, analyze, state: () => st, error: () => lastError, backend: () => backend,
    // exposed for tests
    _predictLength: (emb) => loadRegressor().then((R) => predictLength(R, emb)),
    _identify: (emb) => loadRefs().then((R) => identify(R, emb)),
    _pixels: pixels,
    _embedPixels: (px) => runWorker(new Float32Array(px)),
  };
})();
