// Tidecast — "Dive in".
// One scroll-driven journey: Earth → your location (College Station by default) pinging slowly while
// it finds the nearest water → a descent from orbit onto that water (Sentinel-2 / satellite imagery,
// the same image carried from the globe down to the live 3D lake) → the waterline → beneath the
// surface, where a hook catches fish → the leaderboard rising through the water. Every story element
// is a pure function of scroll position, so the journey stops, reverses and scrubs exactly with the
// scrollbar. Only ambient motion (globe spin, ping pulses, water, swimming fish, the hook) runs on its own.
import * as THREE from 'three';
import { GLTFLoader } from './vendor/addons/loaders/GLTFLoader.js';

const $ = (s) => document.querySelector(s);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const D2R = Math.PI / 180;
const M_PER_DEG = 111195;               // metres per degree on the globe's sphere
const isSmall = () => innerWidth < 860;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ===========================================================================
// Scroll → progress
// ===========================================================================

// Scroll ranges of each beat of the story (fractions of the whole scroll).
const R = {
  heroOut: [0.0, 0.05],
  signal: [0.05, 0.22],
  descent: [0.22, 0.465],
  surface: [0.465, 0.6],
  tilt: [0.53, 0.64],
  low: [0.6, 0.7],
  under: [0.72, 0.88],
  board: [0.86, 1.0],
};
let pTarget = 0;
let p = 0;
const seg = ([a, b]) => clamp((p - a) / (b - a), 0, 1);
const bell = (a, b, c, d) => clamp((p - a) / (b - a), 0, 1) * (1 - clamp((p - c) / (d - c), 0, 1));
const maxScroll = () => Math.max(1, document.documentElement.scrollHeight - innerHeight);
const readScroll = () => (pTarget = clamp(scrollY / maxScroll(), 0, 1));
addEventListener('scroll', readScroll, { passive: true });
const scrollToP = (f) => scrollTo({ top: f * maxScroll(), behavior: reduceMotion ? 'auto' : 'smooth' });

// ===========================================================================
// Where you are, and the water nearest you
// ===========================================================================

const FISH_INFO = Object.fromEntries((window.TIDECAST_FISH || []).map((f) => [f.id, f]));
const DEFAULT_FISH = window.TIDECAST_DEFAULT_FISH || { fresh: [], salt: [] };
const HOME = window.TIDECAST_HOME || { name: 'College Station, TX', lat: 30.628, lon: -96.334 };
const kmBetween = (a, b) => {
  const p1 = a.lat * D2R, p2 = b.lat * D2R;
  const h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(((b.lon - a.lon) * D2R) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
};
const fishFor = (w) => (w.fish && w.fish.length ? w.fish : DEFAULT_FISH[w.water || 'fresh'] || []).filter((id) => FISH_INFO[id]);
const loc = { user: { ...HOME }, water: null, waters: [], km: 1 };

// ===========================================================================
// Renderer, layers and compositor
// ===========================================================================

const canvas = $('#stage');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;
const DPR = () => Math.min(window.devicePixelRatio || 1, isSmall() ? 1.5 : 2);
const makeRT = (samples) => new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples });
const RT = { globe: makeRT(4), surface: makeRT(0), under: makeRT(4) };

const loader = new THREE.TextureLoader();
const prep = (t, srgb = true, wrap = false) => {
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  if (wrap) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
};
const tex = (url, srgb = true, wrap = false) => prep(loader.load(url), srgb, wrap);
const loadTex = (url, srgb = true) => new Promise((ok, fail) => loader.load(url, (t) => ok(prep(t, srgb)), undefined, fail));

const NOISE = /* glsl */ `
  float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float vnoise(vec3 x) {
    vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  float fbm(vec3 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 6; i++) { s += a * vnoise(p); p = p * 2.03 + 3.1; a *= 0.5; } return s; }
`;

// Satellite imagery of the dive: a regional image, a close-up of the water and its water mask.
// Shared by the globe (as lon/lat decals) and the 3D lake surface (as the ground), so the picture
// stays the same from orbit down to the water.
const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
blank.needsUpdate = true;
const SAT = {
  region: { value: blank }, lake: { value: blank }, mask: { value: blank },
  regionB: { value: new THREE.Vector4(0, 0, 1, 1) }, lakeB: { value: new THREE.Vector4(0, 0, 1, 1) },
  ready: { value: 0 },
};

// ===========================================================================
// Layer 1 — the globe
// ===========================================================================

const EARTH_KM = 6371;
const gScene = new THREE.Scene();
const gCamera = new THREE.PerspectiveCamera(30, 1, 0.01, 50);
const tilt = new THREE.Group();
const spin = new THREE.Group();
tilt.add(spin);
gScene.add(tilt);
const SUN = new THREE.Vector3(0.95, 0.75, 1.0).normalize();

const earthMat = new THREE.ShaderMaterial({
  uniforms: {
    uDay: { value: tex('assets/earth-day.jpg') },
    uNight: { value: tex('assets/earth-night.jpg') },
    uRelief: { value: tex('assets/earth-relief.jpg', false) },
    uWater: { value: tex('assets/earth-water.jpg', false) },
    uRegion: SAT.region, uLakeSat: SAT.lake, uRegionB: SAT.regionB, uLakeB: SAT.lakeB, uSatReady: SAT.ready,
    uRegionMix: { value: 0 }, uLakeMix: { value: 0 },
    uPin: { value: new THREE.Vector2(HOME.lon, HOME.lat) }, uTarget: { value: new THREE.Vector2(HOME.lon, HOME.lat) },
    uAltKm: { value: 10000 }, uPing: { value: 0 }, uPingA: { value: 0 }, uPulse: { value: 0 }, uFound: { value: 0 },
    uHaze: { value: 0 }, uSun: { value: SUN }, uTime: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv; varying vec3 vN; varying vec3 vPos; varying vec3 vNorth;
    void main() {
      vUv = uv;
      vN = normalize(normalMatrix * normal);
      vNorth = normalize(normalMatrix * vec3(0.0, 1.0, 0.0));
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      vPos = mv.xyz;
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D uDay, uNight, uRelief, uWater, uRegion, uLakeSat;
    uniform vec4 uRegionB, uLakeB; uniform vec2 uPin, uTarget;
    uniform float uRegionMix, uLakeMix, uSatReady, uAltKm, uPing, uPingA, uPulse, uFound, uHaze, uTime;
    uniform vec3 uSun;
    varying vec2 vUv; varying vec3 vN; varying vec3 vPos; varying vec3 vNorth;
    float edgeMask(vec2 q, float f) {
      return smoothstep(0.0, f, q.x) * smoothstep(0.0, f, 1.0 - q.x) * smoothstep(0.0, f, q.y) * smoothstep(0.0, f, 1.0 - q.y);
    }
    float kmTo(vec2 ll, vec2 c) { return length(vec2((ll.x - c.x) * cos(radians(c.y)), ll.y - c.y)) * 111.195; }
    void main() {
      vec3 V = normalize(-vPos);
      vec3 N = normalize(vN);
      vec3 L = normalize(uSun);
      vec2 ll = vec2(vUv.x * 360.0 - 180.0, vUv.y * 180.0 - 90.0);

      // Satellite imagery for the dive (lon/lat-aligned decals).
      vec2 rq = (ll - uRegionB.xy) / (uRegionB.zw - uRegionB.xy);
      vec2 lq = (ll - uLakeB.xy) / (uLakeB.zw - uLakeB.xy);
      float rIn = edgeMask(rq, 0.06) * uRegionMix * uSatReady;
      float lIn = edgeMask(lq, 0.08) * uLakeMix * uSatReady;
      float decal = max(rIn, lIn);

      float h = texture2D(uRelief, vUv).r;
      float hx = texture2D(uRelief, vUv + vec2(1.0 / 2048.0, 0.0)).r - h;
      float hy = texture2D(uRelief, vUv + vec2(0.0, 1.0 / 1024.0)).r - h;
      vec3 east = normalize(cross(vNorth, N) + 1e-5);
      vec3 north = cross(N, east);
      vec3 Nb = normalize(N - (east * hx + north * hy) * 2.2 * (1.0 - decal));

      vec3 day = texture2D(uDay, vUv).rgb;
      day = max(mix(vec3(dot(day, vec3(0.299, 0.587, 0.114))), day, 1.2), 0.0);
      float water = texture2D(uWater, vUv).r;
      float shallow = smoothstep(0.02, 0.12, max(day.g - day.b * 0.55, 0.0)) * water;
      day = mix(day, day * vec3(0.75, 1.15, 1.18) + vec3(0.0, 0.02, 0.03), shallow * 0.6);
      day = mix(day, day * vec3(1.12, 1.02, 0.86), (1.0 - water) * 0.35);
      if (rIn > 0.0) day = mix(day, texture2D(uRegion, rq).rgb, rIn);
      if (lIn > 0.0) day = mix(day, texture2D(uLakeSat, lq).rgb, lIn);
      water *= 1.0 - decal;

      float ndl = dot(Nb, L);
      float lit = smoothstep(-0.12, 0.35, ndl);
      vec3 sunCol = vec3(1.0, 0.93, 0.84);
      // Close to the ground the view is straight down at noon: light evenly.
      float evenLight = clamp(uHaze, 0.0, 1.0);
      vec3 col = day * mix(max(ndl, 0.0) * 1.25 + 0.035, 1.05, evenLight) * sunCol;

      vec3 H = normalize(L + V);
      float nh = max(dot(N, H), 0.0);
      col += (pow(nh, 1400.0) * 0.3 + pow(nh, 160.0) * 0.025) * water * vec3(1.0, 0.86, 0.68) * lit;
      col += texture2D(uNight, vUv).rgb * vec3(1.0, 0.72, 0.42) * 1.8 * (1.0 - lit);

      float fres = pow(1.0 - max(dot(N, V), 0.0), 3.6);
      vec3 atm = mix(vec3(0.32, 0.58, 1.0), vec3(1.0, 0.68, 0.48), smoothstep(0.3, 1.0, dot(N, L)));
      col = mix(col, atm * (lit * 0.95 + 0.08), fres * 0.45);
      col = mix(col, vec3(0.62, 0.72, 0.84), uHaze * 0.08);            // aerial perspective

      // Your location pings, slowly: a scroll-driven wave that travels out to the nearest water,
      // plus ambient sonar pulses sized to the view.
      float dist = kmTo(ll, uPin);
      float ring = exp(-pow((dist - uPing) / max(uAltKm * 0.006, 0.12), 2.0)) * uPingA * 0.75;
      float reach = clamp(uAltKm * 0.3, 4.0, 1500.0);
      for (int k = 0; k < 3; k++) {
        float f = fract(uTime * 0.1 + float(k) / 3.0);
        ring += exp(-pow((dist - reach * f) / max(uAltKm * 0.0032, 0.02), 2.0)) * (1.0 - f) * (1.0 - f) * 0.8 * uPulse;
      }
      float core = exp(-pow(dist / max(uAltKm * 0.005, 0.02), 2.0)) * uPulse;
      // The water it found glows.
      float wd = kmTo(ll, uTarget);
      float found = exp(-pow(wd / max(uAltKm * 0.006, 0.03), 2.0)) * uFound;
      found += exp(-pow((wd - uAltKm * 0.02 * (0.6 + 0.4 * sin(uTime * 1.2))) / max(uAltKm * 0.002, 0.01), 2.0)) * uFound * 0.6;
      col += (ring + core * 1.4 + found * 1.2) * vec3(1.0, 0.48, 0.3) * 1.2;

      gl_FragColor = vec4(col, 1.0);
      #include <colorspace_fragment>
    }`,
});
const earth = new THREE.Mesh(new THREE.SphereGeometry(1, 256, 160), earthMat);
earth.renderOrder = -1;
spin.add(earth);

const glowMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, side: THREE.BackSide, blending: THREE.AdditiveBlending,
  uniforms: { uSun: { value: SUN }, uFade: { value: 1 } },
  vertexShader: `varying vec3 vN; varying vec3 vP; void main(){ vN = normalize(normalMatrix * normal); vec4 mv = modelViewMatrix * vec4(position,1.0); vP = mv.xyz; gl_Position = projectionMatrix * mv; }`,
  fragmentShader: `uniform vec3 uSun; uniform float uFade; varying vec3 vN; varying vec3 vP;
    void main(){
      float dv = -dot(vN, normalize(-vP));
      float i = pow(clamp(dv * 2.7, 0.0, 1.0), 3.0);
      float k = clamp(dot(vN, normalize(uSun)) * 0.6 + 0.4, 0.0, 1.0);
      vec3 c = mix(vec3(0.28, 0.55, 1.0), vec3(1.0, 0.62, 0.42), k);
      gl_FragColor = vec4(c * i * 0.95 * uFade, i * 0.8 * uFade);
    }`,
});
const glow = new THREE.Mesh(new THREE.SphereGeometry(1.05, 96, 64), glowMat);
glow.renderOrder = 1;
tilt.add(glow);

function latLon(lat, lon, r = 1) {
  const phi = (lon + 180) * D2R, theta = (90 - lat) * D2R;
  return new THREE.Vector3(-r * Math.cos(phi) * Math.sin(theta), r * Math.cos(theta), r * Math.sin(phi) * Math.sin(theta));
}

const SPOTS = [
  [58.3, -134.4], [57.8, -152.4], [49.3, -124.9], [46.2, -124.1], [38.0, -123.2], [34.0, -119.6], [24.6, -112.2], [22.9, -109.9],
  [18.5, -130.5], [20.8, -156.5], [29.3, -94.8], [27.6, -97.2], [21.3, -86.8], [18.4, -77.9], [18.5, -66.6], [24.6, -81.8],
  [27.0, -80.0], [32.8, -79.6], [35.2, -75.5], [40.5, -73.5], [41.5, -70.0], [44.6, -63.0], [47.6, -52.7], [10.5, -66.9],
  [11.0, -74.8], [8.9, -79.5], [-0.7, -90.3], [-12.0, -77.2], [-33.0, -71.7], [-23.0, -43.2], [64.1, -21.9], [62.5, 6.2],
  [38.7, -9.4], [36.1, 14.3], [14.7, -17.5], [-33.9, 18.4], [-20.0, 57.5], [21.5, 39.1], [10.0, 76.2], [-8.7, 115.2],
  [11.0, 124.0], [35.3, 139.8], [-18.3, 147.7], [-41.3, 174.8], [56.9, -170.0], [13.4, 144.8], [-17.6, -149.5],
];
const ROUTES = [[[20.8, -156.5], [34.0, -119.6]], [[18.5, -130.5], [24.6, -112.2]], [[27.6, -97.2], [18.4, -77.9]],
  [[35.2, -75.5], [64.1, -21.9]], [[24.6, -81.8], [18.5, -66.6]], [[18.5, -66.6], [14.7, -17.5]], [[57.8, -152.4], [49.3, -124.9]]];

function glowTexture(inner, ring) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.16, inner);
  g.addColorStop(0.26, ring);
  g.addColorStop(0.38, ring.replace(/[\d.]+\)$/, '0.9)'));
  g.addColorStop(0.52, ring.replace(/[\d.]+\)$/, '0.3)'));
  g.addColorStop(1, ring.replace(/[\d.]+\)$/, '0)'));
  x.fillStyle = g;
  x.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const spotTex = glowTexture('rgba(255,240,230,1)', 'rgba(240,110,80,1)');
const spots = SPOTS.map(([lat, lon], i) => {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: spotTex, transparent: true, depthWrite: false }));
  s.position.copy(latLon(lat, lon, 1.004));
  s.userData.phase = i * 1.7;
  s.renderOrder = 3;
  spin.add(s);
  return s;
});
const routeMat = new THREE.LineDashedMaterial({ color: 0xffffff, transparent: true, opacity: 0.42, dashSize: 0.012, gapSize: 0.012, depthWrite: false });
for (const [a, b] of ROUTES) {
  const va = latLon(...a), vb = latLon(...b);
  const pts = [];
  for (let i = 0; i <= 80; i++) {
    const t = i / 80;
    pts.push(new THREE.Vector3().copy(va).lerp(vb, t).normalize().multiplyScalar(1.003 + Math.sin(Math.PI * t) * 0.02));
  }
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), routeMat);
  line.computeLineDistances();
  line.renderOrder = 2;
  spin.add(line);
}

// HTML labels that ride on the globe.
const overlay = $('#overlay');
const FISH_SVG = '<svg viewBox="0 0 46 14"><path d="M2 7c6-6 18-7 28-2l8-5-2 7 2 7-8-5C20 14 8 13 2 7z" fill="rgba(200,215,225,.9)"/></svg>';
const PIN_SVG = '<svg viewBox="0 0 24 24"><path d="M12 22s7-6.3 7-12a7 7 0 1 0-14 0c0 5.7 7 12 7 12z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="10" r="2.6" fill="currentColor"/></svg>';
const DROP_SVG = '<svg viewBox="0 0 24 24"><path d="M12 3s6 6.6 6 11a6 6 0 0 1-12 0c0-4.4 6-11 6-11z" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
const globeLabels = [
  { lat: 17, lon: -121, html: 'PACIFIC<br>OCEAN', cls: 'ocean-label', group: 'hero' },
  { lat: 31, lon: -62, html: 'ATLANTIC<br>OCEAN', cls: 'ocean-label', group: 'hero' },
  { lat: 24.5, lon: -90, html: 'GULF OF<br>MEXICO', cls: 'ocean-label', group: 'hero' },
  { lat: -10, lon: 75, html: 'INDIAN<br>OCEAN', cls: 'ocean-label', group: 'hero' },
  { id: 'you', lat: HOME.lat, lon: HOME.lon, html: `<i></i><span>${PIN_SVG}<em></em></span>`, cls: 'pin you', group: 'you' },
  { id: 'water', lat: HOME.lat, lon: HOME.lon, html: `<i></i><span>${DROP_SVG}<em></em></span>`, cls: 'pin target', group: 'water' },
  { lat: 30, lon: -135, html: FISH_SVG, cls: 'fish', drift: 1, group: 'hero' },
  { lat: 2, lon: -118, html: FISH_SVG, cls: 'fish', drift: -1, group: 'hero' },
  { lat: 32, lon: -60, html: FISH_SVG, cls: 'fish', drift: 1, group: 'hero' },
  { lat: 15, lon: -40, html: FISH_SVG, cls: 'fish', drift: -1, group: 'hero' },
].map((l) => {
  const el = document.createElement('div');
  el.className = l.cls;
  el.innerHTML = l.html;
  overlay.appendChild(el);
  return { ...l, el, pos: latLon(l.lat, l.lon, 1.0) };
});
const label = (id) => globeLabels.find((l) => l.id === id);
function moveLabel(id, lat, lon, text) {
  const l = label(id);
  l.lat = lat;
  l.lon = lon;
  l.pos = latLon(lat, lon, 1.0);
  l.el.querySelector('em').textContent = text;
}

const tmpV = new THREE.Vector3(), tmpN = new THREE.Vector3(), camDir = new THREE.Vector3();
const Y_AXIS = new THREE.Vector3(0, 1, 0);
function updateGlobeLabels(t, alpha) {
  const W = innerWidth, H = innerHeight;
  for (const l of globeLabels) {
    const a = alpha[l.group] || 0;
    if (a <= 0.001) {
      l.el.style.opacity = '0';
      continue;
    }
    tmpV.copy(l.pos);
    if (l.drift) tmpV.applyAxisAngle(Y_AXIS, Math.sin(t * 0.05 + l.lat) * 0.04 * l.drift);
    spin.localToWorld(tmpV);
    tmpN.copy(tmpV).normalize();
    camDir.copy(gCamera.position).sub(tmpV).normalize();
    const facing = tmpN.dot(camDir);
    tmpV.project(gCamera);
    const x = (tmpV.x * 0.5 + 0.5) * W, y = (-tmpV.y * 0.5 + 0.5) * H;
    const clear = l.cls === 'fish' ? clamp((x - 0.47 * W) / (0.05 * W), 0, 1) : 1;
    l.el.style.opacity = (clamp((facing - 0.06) / 0.2, 0, 1) * a * clear).toFixed(3);
    l.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%)${l.drift ? ` scaleX(${l.drift})` : ''}`;
  }
}

const heroView = () => {
  const W = innerWidth, H = innerHeight;
  if (W < 860) return { cx: 0.62, cy: 1.08, r: Math.min(0.62, (0.95 * W) / H) };
  return { cx: 0.74, cy: 1.15, r: Math.min(1.045, (0.62 * W) / H) };
};
// Camera distance for a globe of on-screen radius r (fraction of viewport height).
const distFor = (r) => {
  const k = 1 / (2 * Math.tan((gCamera.fov * D2R) / 2) * r);
  return Math.sqrt(1 + k * k);
};
// Altitude that frames you and your water together at the end of the signal beat.
const signalAltKm = () => clamp((loc.km * 3.5) / Math.min(1, innerWidth / innerHeight / 1.2), 40, 900);
const ALT_END_KM = 9;
const lerpLL = (a, b, t) => ({ lat: lerp(a.lat, b.lat, t), lon: lerp(a.lon, b.lon, t) });

let ambientAngle = 0;
const globeState = { altKm: 10000, roll: 0 };

function placeGlobe(dt, t) {
  const W = innerWidth, H = innerHeight;
  const hv = heroView();
  // Turn to you first, then zoom in, so nothing is still rotating once the view is close.
  const eSig = easeInOut(seg([0.05, 0.15]));
  const eZoom = easeInOut(seg([0.08, R.signal[1]]));
  const eDesc = seg(R.descent);
  const water = loc.water || loc.user;
  const mid = lerpLL(loc.user, water, 0.5);
  // Where the camera looks: you, then you and your water, then the water.
  const focus = eDesc > 0 ? lerpLL(mid, water, easeInOut(seg([0.22, 0.36]))) : lerpLL(loc.user, mid, smooth(seg([0.12, 0.22])));
  // Ambient spin slows to a stop as the story takes over.
  ambientAngle += 0.045 * dt * (1 - eSig);
  const spinGoal = -(focus.lon + 90) * D2R;
  const goal = ambientAngle + Math.atan2(Math.sin(spinGoal - ambientAngle), Math.cos(spinGoal - ambientAngle));
  spin.rotation.y = lerp(ambientAngle, goal, eSig);
  tilt.rotation.x = lerp(0.1, focus.lat * D2R, eSig);

  const dHero = distFor(hv.r), dSig = 1 + signalAltKm() / EARTH_KM;
  let d = Math.exp(lerp(Math.log(dHero - 1), Math.log(dSig - 1), eZoom)) + 1;
  if (eDesc > 0) d = 1 + Math.exp(lerp(Math.log(dSig - 1), Math.log(ALT_END_KM / EARTH_KM), easeInOut(eDesc)));
  const cx = lerp(hv.cx, 0.5, eSig), cy = lerp(hv.cy, 0.5, eSig);
  const roll = 0.5 * easeInOut(eDesc);          // a slow turn as we dive
  globeState.roll = roll;
  gCamera.position.set(0, 0, d);
  gCamera.up.set(Math.sin(roll), Math.cos(roll), 0);
  gCamera.lookAt(0, 0, 0);
  gCamera.setViewOffset(W, H, W / 2 - cx * W, H / 2 - cy * H, W, H);
  gCamera.near = Math.max(1e-6, (d - 1) * 0.25);
  gCamera.far = d + 1.2;
  gCamera.updateProjectionMatrix();

  const altKm = (d - 1) * EARTH_KM;
  globeState.altKm = altKm;
  const u = earthMat.uniforms;
  u.uAltKm.value = altKm;
  u.uRegionMix.value = 1 - smooth(clamp((altKm - 300) / 600, 0, 1));
  u.uLakeMix.value = 1 - smooth(clamp((altKm - 30) / 50, 0, 1));
  u.uHaze.value = 1 - smooth(clamp((altKm - 20) / 2500, 0, 1));
  u.uPing.value = seg([0.09, 0.2]) * (loc.km * 1.25 + 3);
  u.uPingA.value = bell(0.09, 0.11, 0.18, 0.22);
  u.uPulse.value = 1 - seg([0.24, 0.32]);
  u.uFound.value = seg([0.16, 0.2]) * (1 - seg([0.42, 0.46]));
  u.uTime.value = t;
  glowMat.uniforms.uFade.value = smooth(clamp((altKm - 800) / 3000, 0, 1));

  const heroA = 1 - seg([0.06, 0.16]);
  for (const s of spots) {
    const k = 0.034 + 0.008 * Math.sin(t * 2.2 + s.userData.phase);
    s.scale.set(k, k, k);
    s.material.opacity = heroA;
    s.visible = heroA > 0.01;
  }
  routeMat.opacity = 0.42 * heroA;
  updateGlobeLabels(t, { hero: heroA, you: 1 - seg([0.3, 0.36]), water: bell(0.17, 0.2, 0.36, 0.42) });
}

// ===========================================================================
// Layer 2 — the water you dove into, from 9 km up down to the waterline
// ===========================================================================

const sScene = new THREE.Scene();
const sCamera = new THREE.PerspectiveCamera(30, 1, 0.05, 60000);
const waterNormals = tex('assets/waternormals.jpg', false, true);
// Sky, with the lake's wooded shore as a hazy treeline along the horizon (seen near the water).
const SKY_GLSL = /* glsl */ `
  uniform float uShore;
  ${NOISE}
  vec3 skyColor(vec3 d, float shore) {
    float h = clamp(d.y, 0.0, 1.0);
    vec3 c = mix(vec3(0.82, 0.9, 0.96), vec3(0.22, 0.5, 0.95), pow(h, 0.5));
    float sun = max(dot(normalize(d), normalize(vec3(0.35, 0.7, -0.6))), 0.0);
    c += vec3(1.0, 0.85, 0.6) * (pow(sun, 400.0) * 6.0 + pow(sun, 12.0) * 0.2);
    if (shore > 0.0 && d.y < 0.06) {
      float az = atan(d.z, d.x);
      float top = 0.008 + 0.016 * vnoise(vec3(az * 9.0, 0.0, 0.0)) + 0.008 * vnoise(vec3(az * 55.0, 1.0, 0.0)) + 0.003 * vnoise(vec3(az * 260.0, 2.0, 0.0));
      float tree = smoothstep(top + 0.0015, top - 0.0015, d.y) * shore;
      vec3 leaves = mix(vec3(0.05, 0.085, 0.05), vec3(0.11, 0.15, 0.08), vnoise(vec3(az * 400.0, d.y * 900.0, 0.0)));
      c = mix(c, mix(leaves, vec3(0.62, 0.72, 0.8), 0.42), tree);
    }
    return c;
  }`;
const groundMat = new THREE.ShaderMaterial({
  uniforms: {
    uNormals: { value: waterNormals }, uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uCamH: { value: 9000 },
    uRing: { value: 0 }, uRingA: { value: 0 }, uWave: { value: 1 },
    uRegion: SAT.region, uLakeSat: SAT.lake, uMask: SAT.mask, uRegionB: SAT.regionB, uLakeB: SAT.lakeB, uSatReady: SAT.ready,
    uTarget: { value: new THREE.Vector2() }, uShore: { value: 0 },
  },
  vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D uNormals, uRegion, uLakeSat, uMask;
    uniform vec4 uRegionB, uLakeB; uniform vec2 uTarget;
    uniform float uTime, uRing, uRingA, uWave, uCamH, uSatReady; uniform vec3 uCam;
    varying vec3 vW;
    ${SKY_GLSL}
    vec3 nrm(vec2 uv) { return texture2D(uNormals, uv).rbg * 2.0 - 1.0; }
    float inside(vec2 q, float f) {
      return smoothstep(0.0, f, q.x) * smoothstep(0.0, f, 1.0 - q.x) * smoothstep(0.0, f, q.y) * smoothstep(0.0, f, 1.0 - q.y);
    }
    void main() {
      vec2 xz = vW.xz;                   // metres from the dive point; +x east, -z north
      vec2 ll = uTarget + vec2(xz.x / (${M_PER_DEG}.0 * cos(radians(uTarget.y))), -xz.y / ${M_PER_DEG}.0);
      vec2 rq = (ll - uRegionB.xy) / (uRegionB.zw - uRegionB.xy);
      vec2 lq = (ll - uLakeB.xy) / (uLakeB.zw - uLakeB.xy);
      float inR = inside(rq, 0.04) * uSatReady, inL = inside(lq, 0.03);

      // The same satellite picture the globe showed, lit the same way.
      vec3 sat = vec3(0.07, 0.08, 0.05);
      sat = mix(sat, texture2D(uRegion, rq).rgb, inR);
      sat = mix(sat, texture2D(uLakeSat, lq).rgb, inL * uSatReady);
      vec3 sunCol = vec3(1.0, 0.93, 0.84);
      vec3 land = sat * 1.05 * sunCol;
      float wet = texture2D(uMask, lq).r * inL;

      // Live water, brighter and more detailed as the camera comes down.
      vec3 n = nrm(xz / 9.0 + uTime * vec2(0.012, 0.008)) + nrm(xz / 3.1 - uTime * vec2(0.01, 0.017))
             + nrm(xz / 47.0 + uTime * vec2(-0.004, 0.003)) * 1.4 + nrm(xz / 260.0 + uTime * 0.002) * 2.0;
      n = normalize(vec3(n.x, 4.2, n.z));
      // The drop lands: rings travelling outward from the dive point (scroll-driven).
      float r = length(xz);
      float behind = uRing - r;
      if (behind > 0.0 && uRingA > 0.0) {
        float env = exp(-behind / (uRing * 0.35 + 0.5)) * uRingA;
        n.xz += normalize(xz + 1e-4) * sin(behind * 6.2831 / uWave) * env * 0.55;
        n = normalize(n);
      }
      vec3 V = normalize(uCam - vW);
      float fres = 0.04 + 0.96 * pow(1.0 - max(dot(n, V), 0.0), 5.0);
      float tint = texture2D(uNormals, xz / 900.0).r;
      vec3 body = mix(vec3(0.03, 0.15, 0.2), vec3(0.06, 0.27, 0.3), tint);
      vec3 live = mix(body, skyColor(reflect(-V, n), 0.0), fres);
      vec3 Ls = normalize(vec3(0.35, 0.7, -0.6));
      live += vec3(1.0, 0.86, 0.65) * pow(max(dot(reflect(-V, n), Ls), 0.0), 900.0) * 1.0;
      float detail = 1.0 - smoothstep(250.0, 4500.0, uCamH);
      vec3 waterCol = mix(land * 1.12 + vec3(0.0, 0.01, 0.015), live, detail);
      vec3 col = mix(land, waterCol, wet);

      // Haze: the globe's aerial perspective high up, distance haze near the water.
      col = mix(col, vec3(0.62, 0.72, 0.84), 0.08 * smoothstep(400.0, 9000.0, uCamH));
      float dist = length(uCam - vW);
      col = mix(col, vec3(0.8, 0.88, 0.95), 1.0 - exp(-max(dist - uCamH * 1.05, 0.0) / 5000.0));
      gl_FragColor = vec4(col, 1.0);
      #include <colorspace_fragment>
    }`,
});
const ground = new THREE.Mesh(new THREE.PlaneGeometry(90000, 90000, 160, 160), groundMat);
ground.rotation.x = -Math.PI / 2;
sScene.add(ground);
const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false, uniforms: { uShore: groundMat.uniforms.uShore },
  vertexShader: `varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `${SKY_GLSL} varying vec3 vD; void main(){ gl_FragColor = vec4(skyColor(vD, uShore), 1.0); \n#include <colorspace_fragment>\n }`,
});
const skyDome = new THREE.Mesh(new THREE.SphereGeometry(45000, 64, 32), skyMat);
sScene.add(skyDome);

const upG = new THREE.Vector3();
function placeSurface(t) {
  const W = innerWidth, H = innerHeight;
  const eS = easeInOut(seg(R.surface));
  const eT = easeInOut(seg(R.tilt));
  const eL = easeInOut(seg(R.low));
  // Straight down at first, matching the globe's last frame (same altitude, lens and turn).
  const dist = p < R.surface[0] ? globeState.altKm * 1000 : Math.exp(lerp(Math.log(ALT_END_KM * 1000), Math.log(6), eS)) * lerp(1, 0.42, eL);
  const pitch = (lerp(89.4, 10, eT) - 7 * eL) * D2R;
  const roll = 0.5;
  upG.set(Math.sin(roll), 0, -Math.cos(roll));            // the globe camera's "up" on the ground
  sCamera.position.copy(upG).multiplyScalar(-dist * Math.cos(pitch));
  sCamera.position.y = dist * Math.sin(pitch);
  sCamera.up.set(0, Math.cos(pitch), 0).addScaledVector(upG, Math.sin(pitch));
  sCamera.lookAt(0, 0, 0);
  sCamera.fov = lerp(30, 46, eT);
  sCamera.near = Math.max(0.02, sCamera.position.y * 0.2);
  sCamera.setViewOffset(W, H, 0, -0.17 * H * eT * (1 - eL * 0.6), W, H);
  sCamera.updateProjectionMatrix();
  const u = groundMat.uniforms;
  u.uTime.value = t;
  u.uCam.value.copy(sCamera.position);
  u.uCamH.value = sCamera.position.y;
  u.uShore.value = 1 - smooth(clamp((sCamera.position.y - 20) / 200, 0, 1));
  skyDome.position.copy(sCamera.position);
  // Ring sizes follow the camera height, so the drop reads the same at every altitude.
  u.uRing.value = dist * 0.42 * (0.25 + seg([0.47, 0.63]));
  u.uWave.value = Math.max(0.22, dist * 0.035);
  u.uRingA.value = bell(0.47, 0.5, 0.62, 0.68);
}

// ===========================================================================
// Layer 3 — beneath the surface: fish, and a hook that catches one now and then
// ===========================================================================

// Palette shared with the Earth hero: deep navy, ocean blue, and the warm coral sun.
const DEEP = new THREE.Color().setRGB(0.018, 0.085, 0.16);      // linear
const uScene = new THREE.Scene();
const uCamera = new THREE.PerspectiveCamera(55, 1, 0.05, 80);
uScene.fog = new THREE.FogExp2(DEEP, 0.06);
uScene.background = DEEP.clone();
uScene.add(new THREE.HemisphereLight(0xbfe4ff, 0x0b2440, 2.4));
const sunUnder = new THREE.DirectionalLight(0xffe0c4, 2.8);
sunUnder.position.set(4, 10, 2);
uScene.add(sunUnder);
const rim = new THREE.DirectionalLight(0xff9a70, 0.9);
rim.position.set(-3, 2, -6);
uScene.add(rim);

// Gradient water column behind everything, with the sun's warm glow high up.
uScene.add(new THREE.Mesh(new THREE.SphereGeometry(60, 32, 16), new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false, fog: false,
  vertexShader: `varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `varying vec3 vD; void main(){ float h = vD.y;
    vec3 c = mix(vec3(0.004, 0.018, 0.045), vec3(0.018, 0.085, 0.16), smoothstep(-0.7, 0.0, h));
    c = mix(c, vec3(0.1, 0.36, 0.6), smoothstep(0.0, 0.9, h));
    c += vec3(1.0, 0.55, 0.32) * pow(max(dot(vD, normalize(vec3(0.5, 0.8, -0.3))), 0.0), 6.0) * 0.35;
    gl_FragColor = vec4(c, 1.0);
    #include <colorspace_fragment>
  }`,
})));

// The surface seen from below, light dancing through it.
const underSurfMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false,
  uniforms: { uNormals: { value: waterNormals }, uTime: { value: 0 }, uCam: { value: new THREE.Vector3() } },
  vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
  fragmentShader: `uniform sampler2D uNormals; uniform float uTime; uniform vec3 uCam; varying vec3 vW;
    void main(){
      vec2 xz = vW.xz;
      vec3 n = texture2D(uNormals, xz / 3.0 + uTime * vec2(0.02, 0.013)).rgb + texture2D(uNormals, xz / 1.3 - uTime * vec2(0.015, 0.02)).rgb;
      float l = pow(clamp((n.r + n.g) * 0.5 - 0.35, 0.0, 1.0), 1.6);
      vec3 V = normalize(vW - uCam);
      float window = smoothstep(0.35, 0.85, V.y);          // Snell's window overhead
      float sun = pow(max(dot(V, normalize(vec3(0.5, 0.8, -0.3))), 0.0), 18.0);
      float d = length(vW - uCam);
      vec3 c = mix(vec3(0.08, 0.3, 0.5), vec3(0.7, 0.9, 1.0), window) + l * 0.55 * (0.3 + window);
      c += vec3(1.0, 0.7, 0.45) * sun * 0.9;
      c = mix(vec3(0.018, 0.085, 0.16), c, exp(-d * 0.1));          // fade into the deep
      gl_FragColor = vec4(c, 1.0);
      #include <colorspace_fragment>
    }`,
});
const underSurf = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), underSurfMat);
underSurf.rotation.x = Math.PI / 2;
uScene.add(underSurf);

// Lake bed with moving caustics.
const CAUSTIC = /* glsl */ `
  vec2 cHash(vec2 p) { p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3))); return fract(sin(p) * 43758.5453); }
  float cWeb(vec2 p, float t) {
    vec2 i = floor(p), f = fract(p);
    float f1 = 8.0, f2 = 8.0;
    for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 o = 0.5 + 0.45 * sin(t * 0.7 + 6.2831 * cHash(i + g));
      float d = length(g + o - f);
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
    }
    return 1.0 - smoothstep(0.0, 0.32, f2 - f1);
  }
  float caustic(vec2 p, float t) {
    vec2 w = p * 1.3 + vec2(sin(p.y * 1.1 + t * 0.35), cos(p.x * 0.9 - t * 0.3)) * 0.55;
    float a = cWeb(w, t), b = cWeb(w * 1.7 + 3.7, t * 1.25);
    return pow(a * b, 1.6) * 1.1 + pow(a, 4.0) * 0.25;   // light gathers where the two webs cross
  }`;
const bedMat = new THREE.ShaderMaterial({
  fog: true,
  uniforms: { ...THREE.UniformsLib.fog, uTime: { value: 0 } },
  vertexShader: `varying vec3 vW; \n#include <fog_pars_vertex>\n
    void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vec4 mvPosition = viewMatrix * w; gl_Position = projectionMatrix * mvPosition; \n#include <fog_vertex>\n }`,
  fragmentShader: `uniform float uTime; varying vec3 vW; ${NOISE} ${CAUSTIC} \n#include <fog_pars_fragment>\n
    void main(){
      float n = fbm(vec3(vW.xz * 0.35, 0.0));
      vec3 c = mix(vec3(0.07, 0.09, 0.1), vec3(0.3, 0.27, 0.2), n);
      c += caustic(vW.xz * 0.8, uTime) * vec3(0.6, 0.85, 1.0) * 0.42;
      gl_FragColor = vec4(c, 1.0);
      \n#include <fog_fragment>\n
      \n#include <colorspace_fragment>\n
    }`,
});
const bed = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), bedMat);
bed.rotation.x = -Math.PI / 2;
bed.position.y = -5.5;
uScene.add(bed);

// Shafts of sunlight from the surface, warm at the top like the sunlit edge of the Earth.
const rayMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
  uniforms: { uTime: { value: 0 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `uniform float uTime; varying vec2 vUv;
    void main(){ float edge = pow(sin(vUv.x * 3.14159), 3.0); float fall = pow(vUv.y, 2.2);
      float flick = 0.7 + 0.3 * sin(uTime * 0.6 + vUv.x * 4.0 + vUv.y * 2.0);
      vec3 c = mix(vec3(0.5, 0.78, 1.0), vec3(1.0, 0.8, 0.6), smoothstep(0.6, 1.0, vUv.y));
      gl_FragColor = vec4(c * edge * fall * flick * 0.09, 1.0);
      #include <colorspace_fragment>
    }`,
});
const rays = [];
for (let i = 0; i < 6; i++) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(2.4 + Math.random() * 2.5, 11), rayMat);
  m.position.set(-8 + i * 3.2 + Math.random(), -5.2, -6 - Math.random() * 7);
  m.rotation.z = -0.32 + Math.random() * 0.06;
  m.userData.sway = Math.random() * 6;
  rays.push(m);
  uScene.add(m);
}

// Suspended particles (marine snow).
const SNOW = isSmall() ? 500 : 1100;
const snowGeo = new THREE.BufferGeometry();
const snowPos = new Float32Array(SNOW * 3);
for (let i = 0; i < SNOW; i++) {
  snowPos[i * 3] = (Math.random() - 0.5) * 26;
  snowPos[i * 3 + 1] = -Math.random() * 5.5;
  snowPos[i * 3 + 2] = -18 + Math.random() * 26;
}
snowGeo.setAttribute('position', new THREE.BufferAttribute(snowPos, 3));
const snowMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, fog: false,
  uniforms: { uTime: { value: 0 }, uPx: { value: 1 } },
  vertexShader: `uniform float uTime, uPx; varying float vA;
    void main(){ vec3 p = position; p.x += sin(uTime * 0.21 + position.z) * 0.25; p.y += mod(uTime * 0.03 + position.x * 0.1, 1.0) * 0.4;
      vec4 mv = modelViewMatrix * vec4(p, 1.0); gl_PointSize = uPx * 22.0 / -mv.z; vA = exp(mv.z * 0.09); gl_Position = projectionMatrix * mv; }`,
  fragmentShader: `varying float vA; void main(){ float d = length(gl_PointCoord - 0.5); gl_FragColor = vec4(vec3(0.82, 0.92, 1.0), smoothstep(0.5, 0.0, d) * 0.45 * vA); }`,
});
uScene.add(new THREE.Points(snowGeo, snowMat));

// Fish: a photoscanned barramundi (CC0, Khronos glTF samples), swimming via a vertex bend.
const FISH = Array.from({ length: isSmall() ? 9 : 14 }, (_, i) => (i < 3
  ? [{ c: [-0.7, -1.45, -0.5], a: 2.1, b: 1.1, w: 0.16, ph: 0.0, s: 1.9 },
    { c: [-1.8, -2.1, -3.6], a: 3.0, b: 1.8, w: -0.13, ph: 2.1, s: 1.7 },
    { c: [2.0, -1.0, -5.2], a: 2.6, b: 1.5, w: 0.15, ph: 4.0, s: 1.6 }][i]
  : { c: [-6 + (i % 6) * 2.4, -1.2 - (i % 3) * 0.8, -7 - Math.floor(i / 6) * 3.5], a: 2 + (i % 4), b: 1.2 + (i % 3) * 0.5,
    w: (i % 2 ? 1 : -1) * (0.12 + (i % 5) * 0.02), ph: i * 1.3, s: 1.2 + (i % 4) * 0.2 }));
const fishPath = (f, t, out) => {
  const a = f.w * t + f.ph;
  out.set(f.c[0] + f.a * Math.cos(a), f.c[1] + 0.25 * Math.sin(2 * a + f.ph), f.c[2] + f.b * Math.sin(a));
  return out;
};
const fishObjs = [];
let fishLen = 0.5;

function makeFish(base, len, s, phase) {
  const mat = base.material.clone();
  mat.envMapIntensity = 0;
  mat.roughness = 0.5;
  mat.color.multiplyScalar(1.3);
  const uni = { uTime: { value: 0 }, uPhase: { value: phase }, uLen: { value: len }, uFreq: { value: 7 }, uWag: { value: 1 } };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uni);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime, uPhase, uLen, uFreq, uWag; varying vec3 vCW;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        float s = clamp(transformed.z / uLen + 0.5, 0.0, 1.0);      // 0 = head (-z), 1 = tail (+z)
        float tail = pow(s, 1.7);
        transformed.x += sin(uTime * uFreq + s * 5.0 + uPhase) * uLen * (0.025 + 0.11 * tail) * uWag;`)
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvCW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform float uTime; varying vec3 vCW;\n${CAUSTIC}`)
      .replace('#include <opaque_fragment>', `outgoingLight += diffuseColor.rgb * caustic(vCW.xz * 1.4, uTime) * vec3(0.6, 0.85, 1.0) * 0.55;\n#include <opaque_fragment>`);
  };
  const mesh = new THREE.Mesh(base.geometry, mat);
  mesh.rotation.y = Math.PI;      // the model's head points to -z; face the direction of travel (+z)
  const holder = new THREE.Group();
  holder.add(mesh);
  holder.scale.setScalar(s);
  uScene.add(holder);
  return { holder, mesh, uni };
}

// The hook: a steel J-hook with a coral soft-plastic bait on a line from the surface.
const hook = new THREE.Group();
{
  const steel = new THREE.MeshStandardMaterial({ color: 0xdfe6ee, metalness: 0.55, roughness: 0.28, emissive: 0x1b2633 });
  const shape = new THREE.CatmullRomCurve3([
    [0, 0.12], [0, 0.07], [0, 0.03], [0.006, 0.006], [0.025, -0.002], [0.044, 0.008], [0.05, 0.03], [0.048, 0.05],
  ].map(([x, y]) => new THREE.Vector3(x - 0.025, y, 0)));
  hook.add(new THREE.Mesh(new THREE.TubeGeometry(shape, 48, 0.0032, 8), steel));
  const eye = new THREE.Mesh(new THREE.TorusGeometry(0.008, 0.0025, 8, 20), steel);
  eye.position.set(-0.025, 0.128, 0);
  eye.rotation.y = Math.PI / 2;
  hook.add(eye);
  const barb = new THREE.Mesh(new THREE.ConeGeometry(0.005, 0.016, 8), steel);
  barb.position.set(0.0215, 0.05, 0);
  barb.rotation.z = 0.5;
  hook.add(barb);
  const bait = new THREE.Mesh(new THREE.CapsuleGeometry(0.009, 0.05, 6, 12),
    new THREE.MeshStandardMaterial({ color: 0xef9168, emissive: 0x6a2410, roughness: 0.45 }));
  bait.position.set(-0.025, 0.07, 0);
  hook.add(bait);
}
const lineMat = new THREE.MeshBasicMaterial({ color: 0xe8f4ff, transparent: true, opacity: 0.55, fog: false });
const line = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 6, 1, true), lineMat);
uScene.add(hook, line);
let biter = null;
const catchPop = document.createElement('div');
catchPop.className = 'catch-pop';
overlay.appendChild(catchPop);

new GLTFLoader().load('assets/fish/fish.json', (gltf) => {
  let base = null;
  gltf.scene.traverse((o) => { if (o.isMesh && !base) base = o; });
  if (!base) return;
  base.geometry.computeBoundingBox();
  const bb = base.geometry.boundingBox;
  base.geometry.translate(0, -(bb.min.y + bb.max.y) / 2, -(bb.min.z + bb.max.z) / 2);
  const len = bb.max.z - bb.min.z;
  for (const f of FISH) fishObjs.push({ f, ...makeFish(base, len, f.s, f.ph * 3), pos: new THREE.Vector3(), next: new THREE.Vector3() });
  biter = makeFish(base, len, 1.7, 1.0);
  biter.half = (len / 2) * 1.7 * 0.92;
  fishLen = len * 1.7;
  hook.scale.setScalar((fishLen * 0.28) / 0.13);
});

// One catch every CATCH_T seconds (ambient): the hook drops, a fish takes it, and it's reeled out.
const CATCH_T = 18;
const hookAt = new THREE.Vector3(), mouth = new THREE.Vector3(), headDir = new THREE.Vector3(), tmpA = new THREE.Vector3();
const bez = (a, b, c, t, out) => out.copy(a).multiplyScalar((1 - t) * (1 - t)).addScaledVector(b, 2 * (1 - t) * t).addScaledVector(c, t * t);
const S0 = new THREE.Vector3(), C0 = new THREE.Vector3();
function placeHook(t, W, H, showPop) {
  const k = ((t % CATCH_T) + CATCH_T) % CATCH_T;
  const halfW = Math.tan(27.5 * D2R) * 5 * uCamera.aspect;
  const home = new THREE.Vector3(Math.min(3.4, halfW * 0.72), -1.7, -1.6);
  // Hook height through the cycle.
  let y = home.y + 0.03 * Math.sin(t * 1.7);
  if (k < 2.5) y = lerp(0.4, home.y, easeOut(k / 2.5));
  else if (k > 7.5 && k < 8.1) y += 0.05 * Math.sin((k - 7.5) * 30);
  else if (k >= 8.1) y = lerp(home.y, 0.9, Math.pow(clamp((k - 8.1) / 3.2, 0, 1), 1.6));
  const sway = k >= 8.1 ? Math.sin(t * 9) * 0.06 * clamp((k - 8.1) * 2, 0, 1) : Math.sin(t * 0.8) * 0.02;
  hookAt.set(home.x + sway, y, home.z);
  hook.position.copy(hookAt);
  hook.rotation.set(0, -0.6 + Math.sin(t * 0.7) * 0.25, sway * 2);
  hook.visible = k < 11.6;
  // The line, from the hook's eye up through the surface.
  const top = hookAt.y + fishLen * 0.27;
  line.position.set(hookAt.x, (top + 1.2) / 2, hookAt.z);
  line.scale.set(0.0035, 1.2 - top, 0.0035);
  line.visible = hook.visible && top < 1.2;
  if (!biter) return;
  // The fish: swims in, bites, is reeled out head-first, thrashing.
  biter.holder.visible = k > 2.5 && k < 11.6;
  biter.uni.uTime.value = t;
  biter.uni.uFreq.value = k >= 7.5 ? 17 : 7;
  biter.uni.uWag.value = k >= 7.5 ? 1.7 : 1;
  mouth.copy(hookAt);
  if (k < 7.5) {
    S0.set(home.x - 3.4, home.y - 0.5, home.z - 3.6);
    C0.set(home.x - 0.4, home.y - 0.6, home.z - 2.4);
    const u = easeInOut(clamp((k - 2.5) / 5, 0, 1));
    bez(S0, C0, hookAt, u, tmpA);
    bez(S0, C0, hookAt, Math.min(1, u + 0.02), headDir);
    headDir.sub(tmpA).normalize();
    if (u > 0.98) headDir.set(0.35, 0.15, 0.93).normalize();
    biter.holder.position.copy(tmpA).addScaledVector(headDir, -biter.half);
  } else {
    headDir.set(Math.sin(t * 8) * 0.35, k < 8.1 ? 0.2 : 1, k < 8.1 ? 0.95 : 0.25).normalize();
    biter.holder.position.copy(mouth).addScaledVector(headDir, -biter.half);
  }
  biter.holder.lookAt(tmpA.copy(biter.holder.position).add(headDir));
  // "+points" as the catch breaks the surface.
  const list = fishFor(loc.water || {});
  const fish = FISH_INFO[list[Math.floor(t / CATCH_T) % Math.max(1, list.length)]];
  const pop = showPop && fish ? clamp((k - 9.6) / 0.4, 0, 1) * (1 - clamp((k - 12.6) / 0.6, 0, 1)) : 0;
  if (pop > 0) {
    tmpA.set(hookAt.x, 0, hookAt.z).project(uCamera);
    const x = (tmpA.x * 0.5 + 0.5) * W, yy = (-tmpA.y * 0.5 + 0.5) * H;
    catchPop.innerHTML = `<b>+${fish.points} pts</b><span>${fish.name}</span>`;
    catchPop.style.transform = `translate(${x.toFixed(1)}px, ${Math.max(70, yy - 10 - 26 * pop).toFixed(1)}px) translate(-50%, -100%)`;
  }
  catchPop.style.opacity = pop.toFixed(3);
}

function placeUnder(t, waterY) {
  const W = innerWidth, H = innerHeight;
  const eU = easeInOut(seg(R.under));
  const sway = Math.sin(t * 0.4) * 0.05;
  uCamera.position.set(sway, lerp(-0.5, -1.25, eU), lerp(6.2, 3.4, eU));
  uCamera.lookAt(sway * 2, lerp(-0.9, -1.55, eU), -4);
  uCamera.updateProjectionMatrix();
  underSurfMat.uniforms.uTime.value = t;
  underSurfMat.uniforms.uCam.value.copy(uCamera.position);
  bedMat.uniforms.uTime.value = t;
  rayMat.uniforms.uTime.value = t;
  snowMat.uniforms.uTime.value = t;
  snowMat.uniforms.uPx.value = RT.under.height / 900;
  for (const r of rays) r.position.x += Math.sin(t * 0.3 + r.userData.sway) * 0.0015;
  for (const o of fishObjs) {
    fishPath(o.f, t, o.pos);
    fishPath(o.f, t + 0.05, o.next);
    o.holder.position.copy(o.pos);
    o.holder.lookAt(o.next);
    o.uni.uTime.value = t;
  }
  placeHook(t, W, H, waterY < 0.2 && p < R.board[0]);
}

// ===========================================================================
// Compositor
// ===========================================================================

const compMat = new THREE.ShaderMaterial({
  uniforms: {
    tGlobe: { value: RT.globe.texture }, tSurface: { value: RT.surface.texture }, tUnder: { value: RT.under.texture },
    tStars: { value: tex('assets/stars.jpg') },
    wSurface: { value: 0 }, uUnder: { value: 0 }, uWaterY: { value: 2 },
    uTime: { value: 0 }, uRes: { value: new THREE.Vector2(1, 1) }, uSkyDay: { value: 0 },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tGlobe, tSurface, tUnder, tStars;
    uniform float wSurface, uUnder, uWaterY, uTime, uSkyDay;
    uniform vec2 uRes;
    varying vec2 vUv;
    vec3 sky(vec2 uv) {
      vec3 c = mix(vec3(0.006, 0.016, 0.03), vec3(0.018, 0.045, 0.08), smoothstep(0.0, 1.0, uv.y * 0.7 + (1.0 - uv.x) * 0.3));
      float g = exp(-pow(length((uv - vec2(1.0, 1.0)) * vec2(1.3, 1.0)) / 0.5, 2.0));
      c += vec3(0.75, 0.32, 0.16) * g * 0.32;
      c += pow(texture2D(tStars, uv * vec2(uRes.x / uRes.y, 1.0) * 0.6).rgb, vec3(2.2)) * 0.25;
      return mix(c, vec3(0.45, 0.62, 0.8), uSkyDay);
    }
    void main() {
      vec2 uv = vUv;
      vec4 g = texture2D(tGlobe, uv);
      vec3 col = g.rgb + sky(uv) * (1.0 - clamp(g.a, 0.0, 1.0));
      if (wSurface > 0.0) col = mix(col, texture2D(tSurface, uv).rgb, wSurface);

      // The waterline: a half-submerged lens.
      if (uUnder > 0.0) {
        float ys = 1.0 - uv.y;
        float wl = uWaterY + 0.005 * sin(uv.x * 17.0 + uTime * 1.6) + 0.003 * sin(uv.x * 43.0 - uTime * 2.4);
        if (ys > wl) {
          vec2 uu = uv + vec2(0.004 * sin(ys * 38.0 + uTime * 1.8), 0.0);
          col = texture2D(tUnder, uu).rgb;
          col *= 1.0 - 0.25 * exp(-(ys - wl) * uRes.y / 60.0);
        }
        float m = exp(-pow((ys - wl) * uRes.y / 2.4, 2.0));
        col += m * vec3(0.8, 0.95, 1.0) * 0.55;
      }
      float v = smoothstep(1.25, 0.35, length((uv - 0.5) * vec2(uRes.x / uRes.y, 1.0)));
      col *= mix(0.82, 1.0, v);
      gl_FragColor = vec4(col, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
});
const compScene = new THREE.Scene();
compScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), compMat));
const flatCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

// ===========================================================================
// Choosing the water: imagery, mask and labels
// ===========================================================================

let satToken = 0;
const lakeBoundsFor = (w) => {
  const dLon = 4500 / (M_PER_DEG * Math.cos(w.lat * D2R)), dLat = 4500 / M_PER_DEG;
  return [w.lon - dLon, w.lat - dLat, w.lon + dLon, w.lat + dLat];
};
function regionBoundsFor(user, w) {
  const c = lerpLL(user, w, 0.5);
  const half = clamp(Math.max(Math.abs(user.lat - w.lat), Math.abs(user.lon - w.lon) * Math.cos(c.lat * D2R)) * 0.9 + 0.12, 0.3, 2.4);
  const hLon = half / Math.cos(c.lat * D2R);
  return [c.lon - hLon, c.lat - half, c.lon + hLon, c.lat + half];
}
// Water mask for imagery fetched at runtime: the lake's outline (OpenStreetMap) when known,
// else open water around the dive point.
function maskCanvas(b, shape, w) {
  const c = document.createElement('canvas');
  c.width = c.height = 1024;
  const x = c.getContext('2d');
  x.fillStyle = '#000';
  x.fillRect(0, 0, 1024, 1024);
  const px = ([lon, lat]) => [((lon - b[0]) / (b[2] - b[0])) * 1024, ((b[3] - lat) / (b[3] - b[1])) * 1024];
  if (shape && shape.outer && shape.outer.length) {
    x.beginPath();
    for (const ring of [...shape.outer, ...(shape.inner || [])]) ring.forEach((pt, i) => x[i ? 'lineTo' : 'moveTo'](...px(pt)));
    x.fillStyle = '#fff';
    x.fill('evenodd');
  } else {
    const [cx, cy] = px([w.lon, w.lat]);
    const g = x.createRadialGradient(cx, cy, 0, cx, cy, 160);
    g.addColorStop(0, '#fff');
    g.addColorStop(0.45, '#fff');
    g.addColorStop(1, '#000');
    x.fillStyle = g;
    x.fillRect(0, 0, 1024, 1024);
  }
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}

async function setWater(w) {
  const token = ++satToken;
  loc.water = w;
  loc.km = Math.max(0.5, kmBetween(loc.user, w));
  earthMat.uniforms.uTarget.value.set(w.lon, w.lat);
  groundMat.uniforms.uTarget.value.set(w.lon, w.lat);
  moveLabel('water', w.lat, w.lon, `${w.name} · ${fmtKm(loc.km)}`);
  renderSpots();
  SAT.ready.value = 0;
  let shape = null;
  if (!w.sat && w.osm) {
    try {
      shape = await fetchJSON(`/api/water/shape?osm=${encodeURIComponent(w.osm)}`);
      if (token !== satToken) return;
      if (shape.target) {
        w.lat = shape.target[1];
        w.lon = shape.target[0];
        earthMat.uniforms.uTarget.value.set(w.lon, w.lat);
        groundMat.uniforms.uTarget.value.set(w.lon, w.lat);
        moveLabel('water', w.lat, w.lon, `${w.name} · ${fmtKm(loc.km)}`);
      }
    } catch { /* outline unavailable: fall back to open water around the point */ }
  }
  const rb = w.sat ? w.sat.regionB : regionBoundsFor(loc.user, w);
  const lb = w.sat ? w.sat.lakeB : lakeBoundsFor(w);
  const rh = clamp(Math.round((2048 * (rb[3] - rb[1])) / ((rb[2] - rb[0]) * Math.cos(w.lat * D2R))), 512, 2048);
  try {
    const [region, lake, mask] = await Promise.all(w.sat
      ? [loadTex(w.sat.region), loadTex(w.sat.lake), loadTex(w.sat.mask, false)]
      : [loadTex(`/api/sat?bbox=${rb.join(',')}&w=2048&h=${rh}`), loadTex(`/api/sat?bbox=${lb.join(',')}&w=1024&h=1024`), Promise.resolve(maskCanvas(lb, shape, w))]);
    if (token !== satToken) return;
    for (const [k, t] of [['region', region], ['lake', lake], ['mask', mask]]) {
      if (SAT[k].value !== blank) SAT[k].value.dispose();
      SAT[k].value = t;
    }
    SAT.regionB.value.set(...rb);
    SAT.lakeB.value.set(...lb);
    SAT.ready.value = 1;
  } catch {
    // No imagery reachable: the globe keeps Blue Marble, and the lake is all live water.
    if (token !== satToken) return;
    if (SAT.mask.value !== blank) SAT.mask.value.dispose();
    SAT.mask.value = maskCanvas(lb, shape, w);
    SAT.lakeB.value.set(...lb);
  }
}

function setUser(user) {
  loc.user = user;
  earthMat.uniforms.uPin.value.set(user.lon, user.lat);
  moveLabel('you', user.lat, user.lon, `You · ${user.name}`);
}

// ===========================================================================
// "Find your location" and spots to fish around you
// ===========================================================================

const fetchJSON = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
};
const fmtKm = (km) => (km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const spotsList = $('#spots-list');
const spotsWhere = $('#spots-where');
const locateBtn = $('#locate');

function curatedNear(user) {
  return (window.TIDECAST_WATERS || []).map((w) => ({ ...w, km: kmBetween(user, w) })).sort((a, b) => a.km - b.km);
}

function renderSpots() {
  spotsList.innerHTML = loc.waters.slice(0, isSmall() ? 2 : 3).map((w, i) => {
    const fish = fishFor(w).slice(0, isSmall() ? 2 : 3).map((id) => FISH_INFO[id]);
    return `<li><button type="button" data-i="${i}" aria-pressed="${w === loc.water}">
      <span class="spot-head"><strong>${esc(w.name)}</strong><em>${fmtKm(w.km)}</em></span>
      <span class="spot-kind">${esc(w.kind || 'Water')}</span>
      <span class="spot-fish">${fish.map((f) => `<i>${esc(f.name)} <b>${f.points}</b></i>`).join('')}</span>
    </button></li>`;
  }).join('');
}
spotsList.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-i]');
  if (b) setWater(loc.waters[+b.dataset.i]);
});

async function findWaters(user) {
  try {
    const { waters } = await fetchJSON(`/api/water?lat=${user.lat.toFixed(4)}&lon=${user.lon.toFixed(4)}`);
    if (waters && waters.length) return waters.map((w) => ({ ...w, km: kmBetween(user, w) }));
  } catch { /* offline or blocked: use the built-in list */ }
  return curatedNear(user);
}

async function useLocation(user, known = false) {
  setUser(user);
  spotsWhere.innerHTML = `Finding water near <b>${esc(user.name)}</b>…`;
  // The default location uses the built-in list, so the opening dive is always the same;
  // a real location asks OpenStreetMap for every named water around it.
  const waters = known ? await findWaters(user) : curatedNear(user);
  // The baked imagery of a built-in water is better than a runtime fetch of the same place.
  const curated = window.TIDECAST_WATERS || [];
  loc.waters = waters.map((w) => curated.find((c) => c.sat && kmBetween(c, w) < 2.5) ? { ...curated.find((c) => c.sat && kmBetween(c, w) < 2.5), km: w.km } : w);
  spotsWhere.innerHTML = `Spots near <b>${esc(user.name)}</b>${known ? '' : ' <span>(default)</span>'}`;
  await setWater(loc.waters[0]);
}

function locate() {
  if (!navigator.geolocation) {
    spotsWhere.textContent = 'This browser can’t share a location.';
    return;
  }
  locateBtn.disabled = true;
  locateBtn.classList.add('busy');
  spotsWhere.textContent = 'Finding your location…';
  navigator.geolocation.getCurrentPosition(async (pos) => {
    const user = { lat: pos.coords.latitude, lon: pos.coords.longitude, name: 'your location' };
    try {
      const r = await fetchJSON(`/api/reverse?lat=${user.lat.toFixed(4)}&lon=${user.lon.toFixed(4)}`);
      if (r.name) user.name = r.name;
    } catch { /* keep the generic name */ }
    await useLocation(user, true);
    locateBtn.disabled = false;
    locateBtn.classList.remove('busy');
  }, () => {
    spotsWhere.innerHTML = `Location unavailable — showing spots near <b>${esc(HOME.name)}</b>`;
    locateBtn.disabled = false;
    locateBtn.classList.remove('busy');
  }, { enableHighAccuracy: false, timeout: 15000, maximumAge: 600000 });
}
locateBtn.onclick = locate;

// ===========================================================================
// DOM: hero, spots panel, leaderboard
// ===========================================================================

const hero = $('#hero');
const hint = $('#scroll-hint');
const board = $('#board');
const spotsPanel = $('#spots');
const chapterBtns = [...document.querySelectorAll('#chapters button')];

function placeDom() {
  const H = innerHeight;
  const hOut = seg(R.heroOut);
  hero.style.opacity = (1 - hOut).toFixed(3);
  hero.style.transform = `translateY(${(-60 * hOut).toFixed(1)}px)`;
  hero.style.visibility = hOut >= 1 ? 'hidden' : 'visible';
  hint.style.opacity = (1 - seg([0, 0.02])).toFixed(3);
  const sp = bell(0.03, 0.07, 0.84, 0.87);
  spotsPanel.style.opacity = sp.toFixed(3);
  spotsPanel.style.transform = `translateY(${((1 - sp) * 16).toFixed(1)}px)`;
  spotsPanel.style.visibility = sp > 0.01 ? 'visible' : 'hidden';
  // Leaderboard: rises up through the water and settles in front of the fish at the end.
  const eB = seg(R.board);
  board.style.visibility = eB > 0 ? 'visible' : 'hidden';
  board.style.transform = `translate(-50%, calc(-46% + ${((1 - easeOut(eB)) * 1.15 * H).toFixed(1)}px))`;
  board.inert = eB < 0.98;
  document.body.classList.toggle('in-water', p > 0.5);
  const nearest = chapterBtns.reduce((best, b) => (Math.abs(+b.dataset.to - p) < Math.abs(+best.dataset.to - p) ? b : best), chapterBtns[0]);
  chapterBtns.forEach((b) => b.classList.toggle('on', b === nearest));
}

const allRows = () => (window.TIDECAST_LEADERBOARD || []).slice().sort((a, b) => (b.points || 0) - (a.points || 0));
const rowsFor = (period) => allRows().filter((r) => period === 'all' || (r.period || 'week') === 'week');
const initials = (n) => String(n || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const hue = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
function renderBoard(period = 'week') {
  const rows = rowsFor(period);
  $('#podium').innerHTML = rows.slice(0, 3).map((r, i) => `
    <article><div class="medal">${i + 1}</div><strong>${esc(r.angler)}</strong><span>${esc(r.species)} · ${esc(r.measure)}</span><span>${esc(r.location)}</span><em>${(r.points || 0).toLocaleString()} pts</em></article>`).join('');
  $('#rows').innerHTML = rows.slice(3).map((r, i) => `
    <li><span class="rank">${i + 4}</span><span class="avatar" style="background:hsl(${hue(r.angler)} 45% 42%)">${esc(initials(r.angler))}</span>
      <span class="who"><strong>${esc(r.angler)}</strong><span>${esc(r.species)} · ${esc(r.location)}</span></span>
      <span class="measure">${esc(r.measure)}</span><span class="pts">${(r.points || 0).toLocaleString()} pts</span></li>`).join('');
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.period === period)));
  const top = rowsFor('week')[0];
  if (top) {
    $('#teaser-title').textContent = `${top.species}, ${top.measure}`;
    $('#teaser-sub').textContent = `${top.angler} · ${top.location}`;
  }
}

// ===========================================================================
// Frame loop
// ===========================================================================

// Where the waterline sits on screen (fraction from the top; > 1 = not visible, < 0 = all under).
function waterline() {
  if (p < 0.645) return 2;
  return lerp(lerp(1.08, 0.5, easeInOut(seg([0.645, 0.69]))), -0.08, easeInOut(seg([0.7, 0.76])));
}

function resize() {
  const W = innerWidth, H = innerHeight, dpr = DPR();
  renderer.setPixelRatio(dpr);
  renderer.setSize(W, H, false);
  for (const rt of Object.values(RT)) rt.setSize(Math.round(W * dpr), Math.round(H * dpr));
  for (const c of [gCamera, sCamera, uCamera]) c.aspect = W / H;
  compMat.uniforms.uRes.value.set(W * dpr, H * dpr);
  readScroll();
}

let last = performance.now();
let clock = 0;
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  clock += dt;
  // Light smoothing so wheel steps glide; it settles where the scroll stopped and holds.
  p += (pTarget - p) * (1 - Math.exp(-dt * 14));
  if (Math.abs(pTarget - p) < 1e-5) p = pTarget;

  const wSurface = seg([0.455, 0.47]);
  const waterY = waterline();
  const globeOn = wSurface < 1;
  const underOn = waterY < 1.02;
  const surfaceOn = wSurface > 0 && waterY > -0.04;

  if (globeOn) {
    placeGlobe(dt, clock);
    renderer.setRenderTarget(RT.globe);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(gScene, gCamera);
  } else {
    updateGlobeLabels(clock, {});
  }
  if (surfaceOn) {
    placeSurface(clock);
    renderer.setRenderTarget(RT.surface);
    renderer.render(sScene, sCamera);
  }
  if (underOn) {
    placeUnder(clock, waterY);
    renderer.setRenderTarget(RT.under);
    renderer.render(uScene, uCamera);
  } else {
    catchPop.style.opacity = '0';
  }

  const cu = compMat.uniforms;
  cu.wSurface.value = wSurface;
  cu.uUnder.value = underOn ? 1 : 0;
  cu.uWaterY.value = waterY;
  cu.uSkyDay.value = seg([0.3, 0.45]);
  cu.uTime.value = clock;
  renderer.setRenderTarget(null);
  renderer.render(compScene, flatCam);

  placeDom();
  requestAnimationFrame(frame);
}

// ===========================================================================
// Events
// ===========================================================================

addEventListener('resize', () => { resize(); renderSpots(); });
$('#nav-leaderboard').onclick = () => scrollToP(1);
$('#teaser').onclick = () => scrollToP(1);
$('#back').onclick = () => scrollToP(0);
chapterBtns.forEach((b) => (b.onclick = () => scrollToP(+b.dataset.to)));
document.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => renderBoard(b.dataset.period)));
$('#nav-how').onclick = () => ($('#how').hidden = false);
$('#how-close').onclick = () => ($('#how').hidden = true);
$('#how').onclick = (e) => { if (e.target.id === 'how') $('#how').hidden = true; };
addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#how').hidden = true; });

renderBoard('week');
resize();
if (location.hash === '#leaderboard') requestAnimationFrame(() => scrollTo(0, maxScroll()));
p = pTarget;
// Start at College Station (or wherever TIDECAST_HOME says); if the visitor already allowed
// location access, use where they really are.
useLocation({ ...HOME });
navigator.permissions?.query({ name: 'geolocation' }).then((s) => { if (s.state === 'granted') locate(); }).catch(() => {});
requestAnimationFrame(frame);
