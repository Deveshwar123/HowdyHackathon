// Runs DINOv2 for tidecast-model.js on a background thread, so the page stays responsive while
// the model starts (graph optimisation and WebGPU setup take tens of seconds on a 1B-parameter
// model) and while it runs on WebAssembly. Also does the download and caching, so the big
// buffers never have to cross to the page.
//
//   page -> {type: 'load', config}           worker -> {type: 'progress', f, msg} ... {type: 'ready', ep}
//   page -> {type: 'run', id, px}            worker -> {type: 'out', id, emb}
//                                            worker -> {type: 'error', id?, message}
let session = null, runtime = null;   // (not `ort`: the runtime script declares that name itself)

function loadOrt(version, base) {
  if (runtime) return runtime;
  base = base || `https://cdn.jsdelivr.net/npm/onnxruntime-web@${version}/dist/`;
  try {
    importScripts(base + 'ort.all.min.js');
  } catch (e) {
    console.error('onnxruntime-web:', e);
    throw new Error('Couldn’t load the model runtime. Check your connection and try again.');
  }
  runtime = self.ort;
  runtime.env.wasm.wasmPaths = base;
  runtime.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(8, navigator.hardwareConcurrency || 4) : 1;
  return runtime;
}

const progress = (f, msg) => postMessage({ type: 'progress', f, msg });

async function cachedResponse(cacheName, url) {
  try { return await (await caches.open(cacheName)).match(url); } catch { return null; }
}

// One file from the cache, or downloaded with progress and cached. `prog` lets a model and its
// separate weights file share one progress bar.
async function fetchFile(cacheName, url, prog) {
  const hit = await cachedResponse(cacheName, url);
  if (hit) {
    progress(1, 'Loading the model from this browser…');
    return new Uint8Array(await hit.arrayBuffer());
  }
  const r = await fetch(url);
  if (!r.ok || !r.body) throw new Error(`Couldn’t download the model (HTTP ${r.status}).`);
  const reader = r.body.getReader();
  const chunks = [];
  let last = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    prog.done += value.length;
    const now = Date.now();
    if (now - last > 150) {                     // don't flood the page with messages
      last = now;
      progress(prog.total ? prog.done / prog.total : 0,
        `Downloading the model… ${(prog.done / 1048576).toFixed(0)}${prog.total ? ` of ${(prog.total / 1048576).toFixed(0)}` : ''} MB`);
    }
  }
  // A Blob (which the browser may keep on disk) instead of one more 1 GB copy in memory.
  const blob = new Blob(chunks, { type: 'application/octet-stream' });
  chunks.length = 0;
  try {
    const cache = await caches.open(cacheName);
    await cache.put(url, new Response(blob, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(blob.size) } }));
  } catch { /* storage full or private mode: it just downloads again next time */ }
  return new Uint8Array(await blob.arrayBuffer());
}

async function load(config) {
  const rt = loadOrt(config.ortVersion, config.ortBase);
  const prog = { done: 0, total: config.modelBytes || 0 };
  let model = await fetchFile(config.cacheName, config.modelUrl, prog);
  // Big models keep their weights in a separate file (ONNX "external data").
  let data = config.dataUrl ? await fetchFile(config.cacheName, config.dataUrl, prog) : null;
  progress(1, 'Starting the model… (about a minute the first time on a new device)');
  const opts = (ep) => ({
    executionProviders: ep, graphOptimizationLevel: 'all',
    ...(data ? { externalData: [{ path: config.dataUrl.split('/').pop(), data }] } : {}),
  });
  const eps = self.navigator.gpu ? ['webgpu', 'wasm'] : ['wasm'];
  let ep = eps[0];
  try {
    session = await rt.InferenceSession.create(model, opts(eps));
  } catch (e) {
    if (eps[0] !== 'webgpu') throw e;
    ep = 'wasm';
    session = await rt.InferenceSession.create(model, opts(['wasm']));
  }
  model = data = null;                          // the runtime has its own copy now
  return ep;
}

self.onmessage = async ({ data: m }) => {
  if (m.type === 'load') {
    try {
      postMessage({ type: 'ready', ep: await load(m.config) });
    } catch (e) {
      postMessage({ type: 'error', message: e && e.message ? e.message : String(e) });
    }
  } else if (m.type === 'run') {
    try {
      const out = await session.run({ [session.inputNames[0]]: new runtime.Tensor('float32', m.px, [1, 3, 224, 224]) });
      const emb = Float32Array.from(out[session.outputNames[0]].data);
      postMessage({ type: 'out', id: m.id, emb }, [emb.buffer]);
    } catch (e) {
      postMessage({ type: 'error', id: m.id, message: e && e.message ? e.message : String(e) });
    }
  }
};
