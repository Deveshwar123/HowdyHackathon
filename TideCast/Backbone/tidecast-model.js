// TideCast's length model and species finder, running in the visitor's browser: no server, no
// install. DINOv2 ViT-g/14 (ONNX, 4- or 8-bit weights) turns the photo into 1536 features; the
// trained XGBoost regressor (2,147 trees, model/length-regressor.*) turns those into a length, and
// the same features are compared with every species' reference pictures (model/species-refs.*).
//
// The ONNX file is large, so it downloads once (with progress) and is kept in the browser's Cache
// Storage; later visits load it from disk. Runs on WebGPU when the browser has it, else WebAssembly.
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
  };
  let st = 'idle', session = null, reg = null, refs = null, loading = null, lastError = '';

  // ---- onnxruntime-web, loaded on demand from the CDN ---------------------------------------
  function loadOrt() {
    if (window.ort) return Promise.resolve(window.ort);
    return new Promise((ok, fail) => {
      const s = document.createElement('script');
      s.src = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/ort.all.min.js`;
      s.onload = () => {
        window.ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
        window.ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(8, navigator.hardwareConcurrency || 4) : 1;
        ok(window.ort);
      };
      s.onerror = () => fail(new Error('Couldn’t load the model runtime (onnxruntime-web).'));
      document.head.appendChild(s);
    });
  }

  // ---- the big file: Cache Storage first, else download with progress -----------------------
  async function cachedResponse(url = config.modelUrl) {
    try { return await (await caches.open(config.cacheName)).match(url); } catch { return null; }
  }
  async function isCached(url) { return !!(await cachedResponse(url)); }

  // One file (url) from the cache, or downloaded with progress and cached. `done`/`total` let
  // two files (a model and its separate weights) share one progress bar.
  async function fetchFile(url, onProgress, prog) {
    const hit = await cachedResponse(url);
    if (hit) {
      onProgress && onProgress(1, 'Loading the model from this browser…');
      return new Uint8Array(await hit.arrayBuffer());
    }
    const r = await fetch(url);
    if (!r.ok || !r.body) throw new Error(`Couldn’t download the model (HTTP ${r.status}).`);
    const reader = r.body.getReader();
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      prog.done += value.length;
      onProgress && onProgress(prog.total ? prog.done / prog.total : 0,
        `Downloading the model… ${(prog.done / 1048576).toFixed(0)}${prog.total ? ` of ${(prog.total / 1048576).toFixed(0)}` : ''} MB`);
    }
    // A Blob (which the browser may keep on disk) instead of one more 1 GB copy in memory.
    const blob = new Blob(chunks, { type: 'application/octet-stream' });
    chunks.length = 0;
    try {
      const cache = await caches.open(config.cacheName);
      await cache.put(url, new Response(blob, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(blob.size) } }));
    } catch { /* storage full or private mode: it just downloads again next time */ }
    return new Uint8Array(await blob.arrayBuffer());
  }
  async function fetchModel(onProgress) {
    const prog = { done: 0, total: config.modelBytes || 0 };
    const model = await fetchFile(config.modelUrl, onProgress, prog);
    // Big models keep their weights in a separate file (ONNX "external data").
    const data = config.dataUrl ? await fetchFile(config.dataUrl, onProgress, prog) : null;
    return { model, data };
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
        const ort = await loadOrt();
        const [r, s] = await Promise.all([loadRegressor(), loadRefs()]);
        let files = await fetchModel(onProgress);
        onProgress && onProgress(1, 'Starting the model…');
        const opts = (ep) => ({
          executionProviders: ep, graphOptimizationLevel: 'all',
          ...(files.data ? { externalData: [{ path: config.dataUrl.split('/').pop(), data: files.data }] } : {}),
        });
        const eps = navigator.gpu ? ['webgpu', 'wasm'] : ['wasm'];
        try {
          session = await ort.InferenceSession.create(files.model, opts(eps));
        } catch (e) {
          if (eps[0] !== 'webgpu') throw e;
          session = await ort.InferenceSession.create(files.model, opts(['wasm']));
        }
        files = null;                              // the runtime has its own copy now
        reg = r;
        refs = s;
        st = 'ready';
      } catch (e) {
        st = 'failed';
        lastError = e && e.message ? e.message : String(e);
        loading = null;
        throw e;
      }
    })();
    return loading;
  }

  async function embed(blob) {
    const ort = window.ort;
    const input = new ort.Tensor('float32', await pixels(blob), [1, 3, 224, 224]);
    const out = await session.run({ [session.inputNames[0]]: input });
    return Float32Array.from(out[session.outputNames[0]].data);
  }

  async function analyze(blob) {
    if (st !== 'ready') throw new Error('The model isn’t loaded yet.');
    const t0 = performance.now();
    const emb = await embed(blob);
    return { length_cm: predictLength(reg, emb), candidates: identify(refs, emb), ms: Math.round(performance.now() - t0), embedding: emb };
  }

  window.TCModel = {
    config, isCached, load, analyze, state: () => st, error: () => lastError,
    // exposed for tests
    _predictLength: (emb) => loadRegressor().then((R) => predictLength(R, emb)),
    _identify: (emb) => loadRefs().then((R) => identify(R, emb)),
    _pixels: pixels,
    _embedPixels: async (px) => {
      const out = await session.run({ [session.inputNames[0]]: new window.ort.Tensor('float32', px, [1, 3, 224, 224]) });
      return Float32Array.from(out[session.outputNames[0]].data);
    },
  };
})();
