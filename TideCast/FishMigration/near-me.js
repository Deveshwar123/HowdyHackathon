// "Spots near me" for the atlas: asks for your location, lists the named lakes, reservoirs and bays
// around you (OpenStreetMap via /api/water) with the fish to go for and their TideCast points, and
// adds the one you pick to the explorer as an area. Fish and points come from the landing page's
// fish-points.js; waters.js is the offline fallback list.
(() => {
  'use strict';

  const FISH = Object.fromEntries((window.TIDECAST_FISH || []).map((f) => [f.id, f]));
  const DEFAULTS = window.TIDECAST_DEFAULT_FISH || { fresh: [], salt: [] };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const km = (a, b) => {
    const r = Math.PI / 180, p1 = a.lat * r, p2 = b.lat * r;
    const h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(h));
  };
  const fmtKm = (d) => (d < 10 ? `${d.toFixed(1)} km` : `${Math.round(d)} km`);
  const fishFor = (w) => (w.fish && w.fish.length ? w.fish : DEFAULTS[w.water || 'fresh'] || []).filter((id) => FISH[id]);
  const getJSON = async (url) => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url} → ${r.status}`);
    return r.json();
  };

  const root = document.createElement('div');
  root.id = 'nm';
  root.innerHTML = `
    <button id="nm-open" type="button" aria-expanded="false">
      <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      Spots near me</button>
    <section id="nm-panel" hidden aria-labelledby="nm-title">
      <header><strong id="nm-title">Spots near me</strong><button id="nm-close" type="button" aria-label="Close">×</button></header>
      <p id="nm-status"></p>
      <ol id="nm-list"></ol>
      <small class="nm-credit">Waters © OpenStreetMap contributors · points: TideCast</small>
    </section>`;
  document.body.appendChild(root);
  const $ = (s) => root.querySelector(s);
  let waters = [];

  function render(where) {
    $('#nm-status').innerHTML = waters.length ? `Near <b>${esc(where)}</b> — pick one to add it as an area` : `No named water found near <b>${esc(where)}</b>.`;
    $('#nm-list').innerHTML = waters.slice(0, 8).map((w, i) => `
      <li><button type="button" data-i="${i}">
        <span class="nm-head"><b>${esc(w.name)}</b><em>${fmtKm(w.km)}</em></span>
        <span class="nm-kind">${esc(w.kind || 'Water')}</span>
        <span class="nm-fish">${fishFor(w).slice(0, 4).map((id) => `<i>${esc(FISH[id].name)} <b>${FISH[id].points} pts</b></i>`).join('')}</span>
      </button></li>`).join('');
  }

  async function locate() {
    $('#nm-status').textContent = 'Finding your location…';
    $('#nm-list').innerHTML = '';
    if (!navigator.geolocation) return ($('#nm-status').textContent = 'This browser can’t share a location.');
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const me = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      let where = 'your location';
      $('#nm-status').textContent = 'Finding water near you…';
      const [place, found] = await Promise.all([
        getJSON(`/api/reverse?lat=${me.lat.toFixed(4)}&lon=${me.lon.toFixed(4)}`).catch(() => ({})),
        getJSON(`/api/water?lat=${me.lat.toFixed(4)}&lon=${me.lon.toFixed(4)}`).then((r) => r.waters || []).catch(() => []),
      ]);
      if (place.name) where = place.name;
      waters = (found.length ? found : window.TIDECAST_WATERS || []).map((w) => ({ ...w, km: km(me, w) })).sort((a, b) => a.km - b.km);
      render(where);
      window.PelagicExplorer?.flyTo(me.lon, me.lat, 120);
    }, () => {
      $('#nm-status').textContent = 'Location permission was denied. Allow it in the browser’s address bar and try again.';
    }, { timeout: 15000, maximumAge: 600000 });
  }

  function toggle(open) {
    $('#nm-panel').hidden = !open;
    $('#nm-open').setAttribute('aria-expanded', String(open));
    if (open && !waters.length) locate();
  }
  $('#nm-open').onclick = () => toggle($('#nm-panel').hidden);
  $('#nm-close').onclick = () => toggle(false);
  $('#nm-list').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-i]');
    if (!b) return;
    const w = waters[+b.dataset.i];
    const pad = 0.02;
    const bbox = w.bbox ? [w.bbox[0] - pad, w.bbox[1] - pad, w.bbox[2] + pad, w.bbox[3] + pad] : [w.lon - 0.1, w.lat - 0.08, w.lon + 0.1, w.lat + 0.08];
    window.PelagicExplorer?.addArea(w.name, bbox);
  });
})();
