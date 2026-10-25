// Log a catch: photo → (Gemini) species + fish line + knuckle spans → length, weight, points →
// leaderboard. Every point can be dragged to correct it; without the AI, the angler taps them.
// The server recomputes the measurement from the points on every change and again on posting.
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const MAX_SIDE = 1024;

  const S = {
    photo: null, w: 0, h: 0, url: null, mode: 'idle',
    species: '', spine: [], k4: null, k3: null, result: null,
    hand: store.get('tc-hand') || 'male', own: store.get('tc-own-cm') || '',
    ai: false, step: 0, taps: [], pos: null, busy: 0,
  };
  const el = {
    drop: $('#drop'), file: $('#file'), file2: $('#file2'), photo: $('#photo'), box: $('#photo-box'), img: $('#photo-img'),
    lines: $('#lines'), spine: $('#ln-spine'), k4: $('#ln-k4'), k3: $('#ln-k3'), handles: $('#handles'),
    scan: $('#scan'), tap: $('#tap-guide'), bar: $('#stage-bar'), retake: $('#retake'),
    setup: $('#p-setup'), result: $('#p-result'), done: $('#p-done'), status: $('#status'),
    statusTitle: $('#status-title'), statusSub: $('#status-sub'), pick: $('#pick'),
    angler: $('#angler'), hand: $('#hand'), own: $('#own'), ownCm: $('#own-cm'),
    banner: $('#banner'), species: $('#species'), sci: $('#sci'), rarity: $('#rarity'),
    len: $('#m-len'), len2: $('#m-len2'), wt: $('#m-wt'), wt2: $('#m-wt2'), band: $('#range-band'), dot: $('#range-dot'),
    rangeNote: $('#range-note'), pts: $('#m-pts'), brk: $('#m-break'), warn: $('#warnings'), facts: $('#facts'),
    where: $('#where'), locate: $('#locate'), post: $('#post'), aiPill: $('#ai-pill'), lgK3: $('#lg-k3'), dragHint: $('#drag-hint'),
  };

  const api = async (path, body) => {
    const r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
    let data = {};
    try { data = await r.json(); } catch { /* not JSON */ }
    if (!r.ok && data.ok === undefined) data = { ok: false, error: `Server error (${r.status}).` };
    return data;
  };

  // ---- Setup panel ------------------------------------------------------------
  el.angler.value = store.get('tc-angler') || '';
  el.angler.addEventListener('input', () => store.set('tc-angler', el.angler.value.trim()));
  el.ownCm.value = S.own;
  const setHand = (h) => {
    S.hand = h;
    store.set('tc-hand', h);
    el.hand.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.hand === h)));
    el.own.hidden = h !== 'own';
  };
  el.hand.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-hand]');
    if (!b) return;
    setHand(b.dataset.hand);
    if (b.dataset.hand === 'own') el.ownCm.focus();
    remeasure();
  });
  el.ownCm.addEventListener('input', () => {
    S.own = el.ownCm.value;
    store.set('tc-own-cm', S.own);
    remeasure();
  });
  setHand(S.hand);
  const handPayload = () => {
    const own = parseFloat(S.own);
    return { sex: S.hand === 'female' ? 'female' : 'male', own_knuckle_cm: S.hand === 'own' && own >= 6 && own <= 10 ? own : 0 };
  };

  // Species list and whether the AI is on.
  let SPECIES = [];
  api('/api/species').then((d) => {
    SPECIES = (d.species || []).slice().sort((a, b) => a.name.localeCompare(b.name));
    el.species.innerHTML = '<option value="">Choose the species…</option>' +
      SPECIES.map((s) => `<option value="${esc(s.name)}">${esc(s.name)}</option>`).join('');
    if (S.species) el.species.value = S.species;
  });
  const showAi = (on) => {
    S.ai = on;
    el.aiPill.hidden = false;
    el.aiPill.classList.toggle('off', !S.ai);
    el.aiPill.innerHTML = S.ai ? '<i></i>AI measuring is on' : '<i></i>AI measuring is off · you can mark points by hand';
    $('#keybox').hidden = S.ai;
  };
  api('/api/stats').then((d) => showAi(!!d.ai));

  // Saving a Gemini key from the page (stored in TideCast/.env on the server's computer).
  $('#keybox').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('#key-msg');
    msg.className = 'small';
    msg.textContent = 'Checking the key with Google…';
    $('#key-save').disabled = true;
    const d = await api('/api/catch/key', { key: $('#key').value.trim() }).catch(() => ({ ok: false, error: 'Couldn’t reach the server.' }));
    $('#key-save').disabled = false;
    msg.className = `small ${d.ok ? 'ok' : 'bad'}`;
    msg.textContent = d.ok ? 'Key saved. Automatic measuring is on.' : d.error;
    if (d.ok) {
      $('#key').value = '';
      setTimeout(() => showAi(true), 900);
    }
  });

  // ---- Photo in ---------------------------------------------------------------
  async function toJpeg(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();   // browsers apply the photo's EXIF rotation when drawing it
      const k = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.round(img.naturalWidth * k), h = Math.round(img.naturalHeight * k);
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      const blob = await new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.9));
      return { blob, w, h };
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  const blobToDataURL = (blob) => new Promise((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(r.result);
    r.onerror = fail;
    r.readAsDataURL(blob);
  });

  async function takeFile(file) {
    if (!file || !/^image\//.test(file.type || 'image/')) return;
    reset(false);
    let jpeg;
    try {
      jpeg = await toJpeg(file);
    } catch {
      return showSetupError('This browser can’t open that photo. Try a JPEG or PNG (iPhone: Settings → Camera → Formats → Most Compatible).');
    }
    S.w = jpeg.w;
    S.h = jpeg.h;
    S.url = URL.createObjectURL(jpeg.blob);
    el.img.src = S.url;
    el.lines.setAttribute('viewBox', `0 0 ${S.w} ${S.h}`);
    el.drop.hidden = true;
    el.photo.hidden = false;
    layout();
    setBusy('Uploading', 'Preparing your photo');
    const up = await api('/api/catch/upload', { image: await blobToDataURL(jpeg.blob) }).catch(() => ({ ok: false, error: 'Couldn’t reach the server.' }));
    if (!up.ok) return showSetupError(up.error);
    S.photo = up.photo;
    if (S.ai) analyze();
    else startManual('Mark the fish and your knuckles: four taps.');
  }

  async function analyze() {
    S.mode = 'analyzing';
    el.scan.hidden = false;
    const msgs = ['Finding the fish', 'Reading your knuckles', 'Identifying the species', 'Measuring snout to tail'];
    let i = 0;
    setBusy('Analyzing your catch', msgs[0]);
    const tick = setInterval(() => { i = (i + 1) % msgs.length; el.statusSub.textContent = msgs[i]; }, 1600);
    const d = await api('/api/catch/analyze', { photo: S.photo, ...handPayload() }).catch(() => ({ ok: false, error: 'Couldn’t reach the server.', manual: true }));
    clearInterval(tick);
    el.scan.hidden = true;
    setBusy(null);
    if (d.ok) {
      S.species = d.result.species;
      setPoints(d.points);
      showResult(d.result, d.analysis);
      return;
    }
    if (d.points) {
      // The AI found something but not everything: keep its points, let the angler fix them.
      if (d.analysis && d.analysis.species && d.analysis.species !== 'Unknown') {
        const known = SPECIES.find((s) => s.name.toLowerCase() === d.analysis.species.toLowerCase());
        if (known) S.species = known.name;
      }
      setPoints(d.points);
      showResult(null, d.analysis, d.error);
      if (S.species) remeasure(true);
      return;
    }
    if (d.manual) return startManual(d.error);
    showSetupError(d.error || 'Something went wrong. Try again.');
  }

  // ---- Points and overlay --------------------------------------------------------
  const G = (p) => [(p[0] / 1000) * S.w, (p[1] / 1000) * S.h];
  function setPoints(p) {
    S.spine = p.spine.map((q) => q.slice());
    S.k4 = p.k4 ? p.k4.map((q) => q.slice()) : null;
    S.k3 = p.k3 ? p.k3.map((q) => q.slice()) : null;
    buildHandles();
    drawLines(true);
  }
  function drawLines(animate) {
    const set = (line, on, attrs) => {
      line.style.display = on ? '' : 'none';
      if (!on) return;
      for (const [k, v] of Object.entries(attrs)) line.setAttribute(k, v);
      line.classList.remove('drawn', 'live');
      if (animate && !reduce) {
        void line.getBoundingClientRect();
        requestAnimationFrame(() => line.classList.add('drawn'));
      } else line.classList.add('live');
    };
    set(el.spine, S.spine.length > 1, { points: S.spine.map((p) => G(p).join(',')).join(' ') });
    const pair = (q) => { const [a, b] = q.map(G); return { x1: a[0], y1: a[1], x2: b[0], y2: b[1] }; };
    set(el.k4, !!S.k4, S.k4 ? pair(S.k4) : {});
    set(el.k3, !!S.k3, S.k3 ? pair(S.k3) : {});
    el.lgK3.hidden = !S.k3;
    const k = el.box.clientWidth / S.w || 1;           // keep strokes the same on screen at any size
    el.spine.style.strokeWidth = 4.5 / k;
    el.k4.style.strokeWidth = 4.5 / k;
    el.k3.style.strokeWidth = 3.2 / k;
  }
  function buildHandles() {
    el.handles.innerHTML = '';
    const add = (arr, i, cls, label, delay) => {
      const h = document.createElement('div');
      h.className = `handle ${cls}`;
      h.dataset.label = label;
      h.tabIndex = 0;
      h.setAttribute('role', 'slider');
      h.setAttribute('aria-label', `${label}: drag to adjust`);
      place(h, arr[i]);
      el.handles.appendChild(h);
      setTimeout(() => h.classList.add('in'), reduce ? 0 : delay);
      dragify(h, arr, i);
    };
    S.spine.forEach((_, i) => add(S.spine, i, i === 0 || i === S.spine.length - 1 ? '' : 'small',
      i === 0 ? 'Snout' : i === S.spine.length - 1 ? 'Tail tip' : 'Body line', 300 + i * 90));
    if (S.k4) { add(S.k4, 0, 'k4', 'Index knuckle (outer edge)', 900); add(S.k4, 1, 'k4', 'Pinky knuckle (outer edge)', 980); }
    if (S.k3) { add(S.k3, 0, 'k3', 'Middle knuckle (outer edge)', 1060); add(S.k3, 1, 'k3', 'Pinky knuckle (outer edge)', 1140); }
  }
  const place = (h, p) => { h.style.left = `${p[0] / 10}%`; h.style.top = `${p[1] / 10}%`; };
  function gridFromEvent(e) {
    const r = el.box.getBoundingClientRect();
    return [Math.max(0, Math.min(1000, ((e.clientX - r.left) / r.width) * 1000)), Math.max(0, Math.min(1000, ((e.clientY - r.top) / r.height) * 1000))];
  }
  function dragify(h, arr, i) {
    h.addEventListener('pointerdown', (e) => {
      if (S.mode === 'posted') return;
      e.preventDefault();
      h.setPointerCapture(e.pointerId);
      h.classList.add('dragging');
      const move = (ev) => {
        arr[i] = gridFromEvent(ev);
        place(h, arr[i]);
        drawLines(false);
      };
      const up = () => {
        h.classList.remove('dragging');
        h.removeEventListener('pointermove', move);
        h.removeEventListener('pointerup', up);
        h.removeEventListener('pointercancel', up);
        remeasure();
      };
      h.addEventListener('pointermove', move);
      h.addEventListener('pointerup', up);
      h.addEventListener('pointercancel', up);
    });
    h.addEventListener('keydown', (e) => {
      const d = { ArrowLeft: [-4, 0], ArrowRight: [4, 0], ArrowUp: [0, -4], ArrowDown: [0, 4] }[e.key];
      if (!d) return;
      e.preventDefault();
      arr[i] = [arr[i][0] + d[0] * (e.shiftKey ? 4 : 1), arr[i][1] + d[1] * (e.shiftKey ? 4 : 1)];
      place(h, arr[i]);
      drawLines(false);
      remeasure();
    });
  }

  // ---- Manual marking (no AI, or the AI missed something) ----------------------------
  const STEPS = [
    { label: 'Tap the tip of the snout', c: '#b90101' },
    { label: 'Tap the very end of the tail fin', c: '#b90101' },
    { label: 'Tap the outer edge of your index knuckle', c: '#7fd6cf' },
    { label: 'Tap the outer edge of your pinky knuckle', c: '#7fd6cf' },
  ];
  function startManual(message) {
    S.mode = 'manual';
    S.taps = [];
    S.spine = [];
    S.k4 = S.k3 = null;
    el.handles.innerHTML = '';
    drawLines(false);
    el.box.classList.add('manual');
    showResult(null, null, message, true);
    showStep();
  }
  function showStep() {
    const s = STEPS[S.taps.length];
    el.tap.hidden = !s;
    if (s) el.tap.innerHTML = `<b style="--c:${s.c}">${S.taps.length + 1}</b>${s.label}`;
  }
  el.box.addEventListener('click', (e) => {
    if (S.mode !== 'manual' || e.target.closest('.handle')) return;
    const p = gridFromEvent(e);
    S.taps.push(p);
    const h = document.createElement('div');
    h.className = `handle in ${S.taps.length > 2 ? 'k4' : ''}`;
    place(h, p);
    el.handles.appendChild(h);
    if (S.taps.length < STEPS.length) return showStep();
    const [a, b, k1, k2] = S.taps;
    const spine = Array.from({ length: 6 }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / 5, a[1] + ((b[1] - a[1]) * i) / 5]);
    el.box.classList.remove('manual');
    el.tap.hidden = true;
    S.mode = 'result';
    setPoints({ spine, k4: [k1, k2] });
    el.dragHint.textContent = 'Drag the middle points onto the fish’s centre line if it curves';
    if (!S.species) {
      el.species.classList.add('need');
      banner('Now choose the species.', false);
      el.species.focus();
    } else remeasure(true);
  });

  // ---- Result panel ------------------------------------------------------------
  function showResult(result, analysis, message, manual) {
    if (S.mode !== 'manual') S.mode = 'result';
    el.setup.hidden = true;
    el.result.hidden = false;
    el.bar.hidden = false;
    el.dragHint.textContent = manual ? 'Tap the points in order' : 'Drag any point to correct it';
    el.species.value = S.species || '';
    el.species.classList.toggle('need', !S.species && !manual);
    if (message) banner(message, !manual && !result);
    else el.banner.hidden = true;
    renderResult(result, analysis);
    if (!S.pos) locate(false);
  }
  function banner(text, isError) {
    el.banner.hidden = !text;
    el.banner.textContent = text || '';
    el.banner.classList.toggle('error', !!isError);
  }
  function animateNumber(node, to, decimals = 0) {
    const from = parseFloat(node.dataset.v || '0') || 0;
    node.dataset.v = to;
    if (reduce || !Number.isFinite(from)) {
      node.textContent = to.toFixed(decimals);
      return;
    }
    const t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / 700);
      const e = 1 - Math.pow(1 - k, 3);
      node.textContent = (from + (to - from) * e).toFixed(decimals);
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  function renderResult(r, analysis) {
    S.result = r;
    const info = SPECIES.find((s) => s.name === S.species);
    el.sci.textContent = (r && r.scientific_name) || (info && info.scientific) || '';
    const rar = (r && r.rarity) || (info && info.rarity) || '';
    el.rarity.className = rar ? `rarity rarity-${rar.toLowerCase()}` : 'rarity';
    el.rarity.textContent = rar;
    el.rarity.hidden = !rar;
    el.post.disabled = !r;
    if (!r) {
      for (const n of [el.len, el.wt, el.pts]) { n.textContent = '—'; n.dataset.v = '0'; }
      el.len2.textContent = el.wt2.textContent = el.rangeNote.textContent = el.facts.textContent = '';
      el.brk.innerHTML = '';
      el.warn.innerHTML = '';
      el.band.style.width = '0';
      el.dot.style.opacity = '0';
      return;
    }
    animateNumber(el.len, r.length_in, 1);
    el.len2.textContent = `${r.length_cm.toFixed(1)} cm · typical ${r.typical_range_cm} cm`;
    animateNumber(el.wt, r.weight_lb, r.weight_lb < 10 ? 2 : 1);
    el.wt2.textContent = `${r.weight_low_lb}–${r.weight_high_lb} lb · ${r.weight_kg} kg`;
    const top = r.weight_high_lb * 1.25 || 1;
    el.band.style.left = `${(r.weight_low_lb / top) * 100}%`;
    el.band.style.width = `${((r.weight_high_lb - r.weight_low_lb) / top) * 100}%`;
    el.dot.style.left = `${(r.weight_lb / top) * 100}%`;
    el.dot.style.opacity = '1';
    const conf = analysis && typeof analysis.confidence === 'number' ? ` · AI confidence ${Math.round(analysis.confidence * 100)}%` : '';
    el.rangeNote.textContent = `±${Math.round(r.error_frac * 100)}% · measured against ${r.num_references} knuckle span${r.num_references > 1 ? 's' : ''}${conf}`;
    animateNumber(el.pts, r.points, 0);
    const b = r.points_breakdown || {};
    el.brk.innerHTML = `<li>${esc(r.rarity)} species <b>${b.base}</b></li><li>${r.weight_lb.toFixed(1)} lb × 10 <b>${b.weight}</b></li>${b.trophy ? `<li>Trophy size <b>+${b.trophy}</b></li>` : ''}`;
    el.warn.innerHTML = (r.warnings || []).map((w) => `<li>${esc(w)}</li>`).join('');
    el.facts.textContent = [r.habitat && `Lives in: ${r.habitat}.`, r.diet && `Eats: ${r.diet}.`].filter(Boolean).join(' ');
  }

  let measureTimer = 0, measureSeq = 0;
  function remeasure(now) {
    if (!S.photo || !S.spine.length || !S.k4 || !S.species || S.mode === 'posted') return;
    clearTimeout(measureTimer);
    measureTimer = setTimeout(async () => {
      const seq = ++measureSeq;
      el.post.disabled = true;
      const d = await api('/api/catch/measure', payload()).catch(() => ({ ok: false, error: 'Couldn’t reach the server.' }));
      if (seq !== measureSeq) return;
      if (d.ok) {
        if (!el.banner.classList.contains('error')) banner('');
        renderResult(d.result);
      } else {
        banner(d.error, true);
        renderResult(null);
      }
    }, now ? 0 : 220);
  }
  const payload = () => ({ photo: S.photo, species: S.species, spine: S.spine, k4: S.k4, k3: S.k3, ...handPayload() });

  el.species.addEventListener('change', () => {
    S.species = el.species.value;
    el.species.classList.remove('need');
    banner('');
    remeasure(true);
  });

  // ---- Where it was caught ------------------------------------------------------------
  function locate(ask) {
    if (!navigator.geolocation) return;
    const go = () => navigator.geolocation.getCurrentPosition(async (pos) => {
      S.pos = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      if (el.where.value.trim()) return;
      const q = `lat=${S.pos.lat.toFixed(4)}&lon=${S.pos.lon.toFixed(4)}`;
      const [place, water] = await Promise.all([api(`/api/reverse?${q}`).catch(() => ({})), api(`/api/water?${q}`).catch(() => ({}))]);
      const near = (water.waters || [])[0];
      const name = near && near.km < 3 ? `${near.name}${place.name ? `, ${place.name.split(',').pop().trim()}` : ''}` : place.name;
      if (name && !el.where.value.trim()) el.where.value = name;
    }, () => {}, { timeout: 15000, maximumAge: 600000 });
    if (ask) return go();
    navigator.permissions?.query({ name: 'geolocation' }).then((s) => { if (s.state !== 'denied') go(); }).catch(go);
  }
  el.locate.addEventListener('click', () => { el.where.value = ''; locate(true); });

  // ---- Post -------------------------------------------------------------------
  el.post.addEventListener('click', async () => {
    const angler = el.angler.value.trim();
    if (!angler) {
      banner('Add your name for the leaderboard.', true);
      el.angler.focus();
      return;
    }
    el.angler.value = angler;
    store.set('tc-angler', angler);
    el.post.disabled = true;
    el.post.textContent = 'Posting…';
    const d = await api('/api/catch/submit', { ...payload(), angler, location: el.where.value.trim(), lat: S.pos?.lat, lon: S.pos?.lon })
      .catch(() => ({ ok: false, error: 'Couldn’t reach the server.' }));
    el.post.textContent = 'Post to the leaderboard';
    if (!d.ok) {
      el.post.disabled = false;
      return banner(d.error, true);
    }
    S.mode = 'posted';
    el.result.hidden = true;
    el.done.hidden = false;
    el.handles.querySelectorAll('.handle').forEach((h) => (h.style.cursor = 'default'));
    el.dragHint.textContent = 'Posted';
    $('#d-rank').textContent = `#${d.rank_week}`;
    $('#d-line').innerHTML = `${esc(angler)}, your ${esc(d.result.species.toLowerCase())} is worth <b>${d.result.points} points</b>${d.rank_all ? ` and ranks #${d.rank_all} all time` : ''}.`;
    $('#d-board').href = `leaderboard.html?catch=${d.id}`;
  });

  // ---- Reset / layout / status ------------------------------------------------------------
  function reset(clearPhoto = true) {
    S.mode = 'idle';
    S.photo = null;
    S.species = '';
    S.spine = [];
    S.k4 = S.k3 = null;
    S.taps = [];
    clearTimeout(measureTimer);
    measureSeq++;
    el.handles.innerHTML = '';
    drawLines(false);
    el.box.classList.remove('manual');
    el.tap.hidden = el.scan.hidden = true;
    el.result.hidden = el.done.hidden = true;
    el.setup.hidden = false;
    el.bar.hidden = true;
    el.status.hidden = true;
    el.pick.hidden = false;
    el.post.disabled = true;
    renderResult(null);
    if (clearPhoto) {
      el.photo.hidden = true;
      el.drop.hidden = false;
      if (S.url) URL.revokeObjectURL(S.url);
      S.url = null;
    }
  }
  function setBusy(title, sub) {
    el.status.hidden = !title;
    el.status.classList.remove('error');
    el.pick.hidden = !!title;
    if (title) {
      el.statusTitle.textContent = title;
      el.statusSub.textContent = sub || '';
    }
  }
  function showSetupError(msg) {
    setBusy(null);
    reset(true);
    el.status.hidden = false;
    el.status.classList.add('error');
    el.statusTitle.textContent = 'Let’s try that again';
    el.statusSub.textContent = msg;
  }
  function layout() {
    if (!S.w) return;
    const avail = el.photo.clientWidth - 28;
    const maxH = Math.max(260, innerHeight * 0.72);
    const k = Math.min(avail / S.w, maxH / S.h);
    el.box.style.width = `${Math.round(S.w * k)}px`;
    el.box.style.height = `${Math.round(S.h * k)}px`;
    drawLines(false);
  }
  addEventListener('resize', layout);

  // Inputs: file pickers, drag and drop, paste.
  for (const input of [el.file, el.file2]) input.addEventListener('change', () => { takeFile(input.files[0]); input.value = ''; });
  el.drop.addEventListener('dragover', (e) => { e.preventDefault(); el.drop.classList.add('over'); });
  el.drop.addEventListener('dragleave', () => el.drop.classList.remove('over'));
  el.drop.addEventListener('drop', (e) => { e.preventDefault(); el.drop.classList.remove('over'); takeFile(e.dataTransfer.files[0]); });
  addEventListener('paste', (e) => {
    const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith('image/'));
    if (f) takeFile(f);
  });
  el.retake.addEventListener('click', () => reset(true));
  $('#d-again').addEventListener('click', () => reset(true));
})();
