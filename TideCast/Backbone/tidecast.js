// Tidecast — "Follow the Ping".
// One scroll-driven journey: Earth → a tag ping from Lake Somerville, Texas → descent from orbit
// through the atmosphere and a cloud deck (Sentinel-2 imagery) → the lake surface, where the ping
// becomes a ripple → the waterline → tagged fish tracked underwater → the leaderboard rising out
// of the water. Every story element is a pure function of scroll position, so the journey stops,
// reverses and scrubs exactly with the scrollbar. Only ambient motion (globe spin, water, fish
// swimming, leaf sway) runs on its own.
import * as THREE from 'three';
import { GLTFLoader } from './vendor/addons/loaders/GLTFLoader.js';

const $ = (s) => document.querySelector(s);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const D2R = Math.PI / 180;
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
  clouds: [0.4, 0.5],
  surface: [0.455, 0.6],
  tilt: [0.53, 0.64],
  toPhoto: [0.615, 0.645],
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
// Renderer, layers and compositor
// ===========================================================================

const canvas = $('#stage');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;
const DPR = () => Math.min(window.devicePixelRatio || 1, isSmall() ? 1.5 : 2);
const makeRT = (samples) => new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples });
const RT = { globe: makeRT(4), surface: makeRT(0), photo: makeRT(0), under: makeRT(4) };

const loader = new THREE.TextureLoader();
const tex = (url, srgb = true, wrap = false) => {
  const t = loader.load(url);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  if (wrap) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
};

const NOISE = /* glsl */ `
  float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float vnoise(vec3 x) {
    vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  float fbm(vec3 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 6; i++) { s += a * vnoise(p); p = p * 2.03 + 3.1; a *= 0.5; } return s; }
`;

// ===========================================================================
// Layer 1 — the globe
// ===========================================================================

const TARGET = { lat: 30.307, lon: -96.5855 };           // open water, Lake Somerville
const PIN = { lat: 30.628, lon: -96.334 };               // College Station
const EARTH_KM = 6371;
const REGION_B = [-96.9126365, 29.7234785, -95.7864375, 30.6962704];   // Sentinel-2 tile 14RQU (lon/lat)
const LAKE_B = [-96.705, 30.27, -96.535, 30.4];

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
    uRegion: { value: tex('assets/region.jpg') },
    uLakeSat: { value: tex('assets/lake-sat.jpg') },
    uRegionB: { value: new THREE.Vector4(...REGION_B) },
    uLakeB: { value: new THREE.Vector4(...LAKE_B) },
    uRegionMix: { value: 0 }, uLakeMix: { value: 0 },
    uTarget: { value: new THREE.Vector2(TARGET.lon, TARGET.lat) },
    uAltKm: { value: 10000 }, uPing: { value: 0 }, uPingA: { value: 0 }, uPulse: { value: 0 },
    uHaze: { value: 0 }, uCloudA: { value: 1 },
    uSun: { value: SUN }, uTime: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv; varying vec3 vN; varying vec3 vPos; varying vec3 vObj; varying vec3 vNorth;
    void main() {
      vUv = uv; vObj = position;
      vN = normalize(normalMatrix * normal);
      vNorth = normalize(normalMatrix * vec3(0.0, 1.0, 0.0));
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      vPos = mv.xyz;
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D uDay, uNight, uRelief, uWater, uRegion, uLakeSat;
    uniform vec4 uRegionB, uLakeB; uniform vec2 uTarget;
    uniform float uRegionMix, uLakeMix, uAltKm, uPing, uPingA, uPulse, uHaze, uCloudA, uTime;
    uniform vec3 uSun;
    varying vec2 vUv; varying vec3 vN; varying vec3 vPos; varying vec3 vObj; varying vec3 vNorth;
    ${NOISE}
    float edgeMask(vec2 q, float f) {
      return smoothstep(0.0, f, q.x) * smoothstep(0.0, f, 1.0 - q.x) * smoothstep(0.0, f, q.y) * smoothstep(0.0, f, 1.0 - q.y);
    }
    void main() {
      vec3 V = normalize(-vPos);
      vec3 N = normalize(vN);
      vec3 L = normalize(uSun);
      vec2 ll = vec2(vUv.x * 360.0 - 180.0, vUv.y * 180.0 - 90.0);

      // Sentinel-2 imagery for the dive (lon/lat-aligned decals).
      vec2 rq = (ll - uRegionB.xy) / (uRegionB.zw - uRegionB.xy);
      vec2 lq = (ll - uLakeB.xy) / (uLakeB.zw - uLakeB.xy);
      float rIn = edgeMask(rq, 0.06) * uRegionMix;
      float lIn = edgeMask(lq, 0.08) * uLakeMix;
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

      vec3 cp = vObj * vec3(4.4, 7.5, 4.4) + vec3(uTime * 0.012, 0.0, uTime * 0.006);
      float cloud = smoothstep(0.6, 0.9, fbm(cp)) * (0.75 - 0.35 * abs(vObj.y)) * uCloudA;
      col *= 1.0 - smoothstep(0.6, 0.9, fbm(cp + vec3(0.04, -0.03, 0.0))) * 0.12 * uCloudA;
      col = mix(col, vec3(1.0) * (max(ndl, 0.0) * 1.05 + 0.04) * sunCol, cloud * 0.5);

      float fres = pow(1.0 - max(dot(N, V), 0.0), 3.6);
      vec3 atm = mix(vec3(0.32, 0.58, 1.0), vec3(1.0, 0.68, 0.48), smoothstep(0.3, 1.0, dot(N, L)));
      col = mix(col, atm * (lit * 0.95 + 0.08), fres * 0.45);
      col = mix(col, vec3(0.62, 0.72, 0.84), uHaze * 0.22);            // aerial perspective

      // The tag's signal: a scroll-driven ping wave plus sonar pulses sized to the view.
      vec2 dk = vec2((ll.x - uTarget.x) * cos(radians(uTarget.y)), ll.y - uTarget.y) * 111.2;
      float dist = length(dk);
      float ring = exp(-pow((dist - uPing) / max(uAltKm * 0.006, 0.12), 2.0)) * uPingA * 0.75;
      for (int k = 0; k < 3; k++) {
        float f = fract(uTime * 0.32 + float(k) / 3.0);
        float r = uAltKm * 0.34 * f;
        ring += exp(-pow((dist - r) / max(uAltKm * 0.0032, 0.02), 2.0)) * (1.0 - f) * 0.75 * uPulse;
      }
      float core = exp(-pow(dist / max(uAltKm * 0.005, 0.02), 2.0)) * uPulse;
      col += (ring + core * 1.4) * vec3(1.0, 0.48, 0.3) * 1.2;

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
const globeLabels = [
  { lat: 17, lon: -121, html: 'PACIFIC<br>OCEAN', cls: 'ocean-label', group: 'hero' },
  { lat: 31, lon: -62, html: 'ATLANTIC<br>OCEAN', cls: 'ocean-label', group: 'hero' },
  { lat: 24.5, lon: -90, html: 'GULF OF<br>MEXICO', cls: 'ocean-label', group: 'hero' },
  { lat: -10, lon: 75, html: 'INDIAN<br>OCEAN', cls: 'ocean-label', group: 'hero' },
  { lat: PIN.lat, lon: PIN.lon, html: `<i></i><span>${PIN_SVG}College Station, TX</span>`, cls: 'pin', group: 'hero' },
  { lat: TARGET.lat, lon: TARGET.lon, html: `<i class="ping"></i><span>${PIN_SVG}Tag ping · Lake Somerville</span>`, cls: 'pin target', group: 'signal' },
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

const tmpV = new THREE.Vector3(), tmpN = new THREE.Vector3(), camDir = new THREE.Vector3();
const Y_AXIS = new THREE.Vector3(0, 1, 0);
function updateGlobeLabels(t, alpha) {
  const W = innerWidth, H = innerHeight;
  for (const l of globeLabels) {
    const a = alpha[l.group];
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

let ambientAngle = 0;
const TARGET_SPIN = -(TARGET.lon + 90) * D2R;
const TARGET_TILT = TARGET.lat * D2R;
const ALT_END_KM = 9;
const globeState = { altKm: 10000 };

function placeGlobe(dt, t) {
  const W = innerWidth, H = innerHeight;
  const hv = heroView();
  const eSig = easeInOut(seg(R.signal));
  const eDesc = seg(R.descent);
  // Ambient spin slows to a stop as the story takes over.
  ambientAngle += 0.045 * dt * (1 - eSig);
  const goal = ambientAngle + Math.atan2(Math.sin(TARGET_SPIN - ambientAngle), Math.cos(TARGET_SPIN - ambientAngle));
  spin.rotation.y = lerp(ambientAngle, goal, eSig);
  tilt.rotation.x = lerp(0.1, TARGET_TILT, eSig);

  const dHero = distFor(hv.r), dSig = distFor(isSmall() ? 0.3 : 0.36);
  let d = lerp(dHero, dSig, eSig);
  if (eDesc > 0) {
    const a0 = Math.log(dSig - 1), a1 = Math.log(ALT_END_KM / EARTH_KM);
    d = 1 + Math.exp(lerp(a0, a1, easeInOut(eDesc)));
  }
  const cx = lerp(hv.cx, 0.5, eSig), cy = lerp(hv.cy, 0.5, eSig);
  const roll = 0.5 * easeInOut(eDesc);          // a slow turn as we dive
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
  u.uLakeMix.value = 1 - smooth(clamp((altKm - 35) / 55, 0, 1));
  u.uHaze.value = 1 - smooth(clamp((altKm - 20) / 2500, 0, 1));
  u.uCloudA.value = smooth(clamp((altKm - 300) / 2000, 0, 1));
  u.uPing.value = seg([0.1, 0.24]) * 1400;
  u.uPingA.value = bell(0.1, 0.13, 0.2, 0.25);
  u.uPulse.value = seg([0.1, 0.18]) * (1 - seg([0.44, 0.47]));
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
  updateGlobeLabels(t, { hero: heroA, signal: bell(0.1, 0.15, 0.28, 0.33) });
}

// ===========================================================================
// Layer 2 — the lake surface, from 2.5 km up down to the water
// ===========================================================================

const sScene = new THREE.Scene();
const sCamera = new THREE.PerspectiveCamera(42, 1, 0.1, 40000);
const waterNormals = tex('assets/waternormals.jpg', false, true);
const SKY_GLSL = /* glsl */ `
  vec3 skyColor(vec3 d) {
    float h = clamp(d.y, 0.0, 1.0);
    vec3 c = mix(vec3(0.86, 0.9, 0.9), vec3(0.36, 0.58, 0.86), pow(h, 0.55));
    float sun = max(dot(normalize(d), normalize(vec3(0.35, 0.7, -0.6))), 0.0);
    return c + vec3(1.0, 0.85, 0.6) * (pow(sun, 400.0) * 6.0 + pow(sun, 12.0) * 0.18);
  }`;
const waterMat = new THREE.ShaderMaterial({
  uniforms: {
    uNormals: { value: waterNormals }, uTime: { value: 0 }, uCam: { value: new THREE.Vector3() },
    uRing: { value: 0 }, uRingA: { value: 0 }, uWave: { value: 1 }, uSonar: { value: 0 },
  },
  vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D uNormals; uniform float uTime, uRing, uRingA, uWave, uSonar; uniform vec3 uCam;
    varying vec3 vW;
    ${SKY_GLSL}
    vec3 nrm(vec2 uv) { return texture2D(uNormals, uv).rbg * 2.0 - 1.0; }
    void main() {
      vec2 xz = vW.xz;
      vec3 n = nrm(xz / 9.0 + uTime * vec2(0.012, 0.008)) + nrm(xz / 3.1 - uTime * vec2(0.01, 0.017))
             + nrm(xz / 47.0 + uTime * vec2(-0.004, 0.003)) * 1.4 + nrm(xz / 260.0 + uTime * 0.002) * 2.0;
      n = normalize(vec3(n.x, 4.2, n.z));
      // The ping lands: rings travelling outward from the dive point (scroll-driven).
      float r = length(xz);
      float behind = uRing - r;
      if (behind > 0.0 && uRingA > 0.0) {
        float env = exp(-behind / (uRing * 0.35 + 0.5)) * uRingA;
        float wave = sin(behind * 6.2831 / uWave);
        n.xz += normalize(xz + 1e-4) * wave * env * 0.55;
        n = normalize(n);
      }
      vec3 V = normalize(uCam - vW);
      float fres = 0.05 + 0.95 * pow(1.0 - max(dot(n, V), 0.0), 5.0);
      float tint = texture2D(uNormals, xz / 900.0).r;
      vec3 body = mix(vec3(0.04, 0.07, 0.055), vec3(0.08, 0.12, 0.09), tint);
      vec3 col = mix(body, skyColor(reflect(-V, n)), fres);
      float sonar = exp(-pow((r - uRing) / max(uWave * 0.16, 0.06), 2.0)) * uSonar;
      col += vec3(1.0, 0.48, 0.3) * sonar * 0.9;
      float dist = length(uCam - vW);
      col = mix(col, vec3(0.78, 0.84, 0.86), 1.0 - exp(-dist / 7000.0));
      gl_FragColor = vec4(col, 1.0);
      #include <colorspace_fragment>
    }`,
});
const water = new THREE.Mesh(new THREE.PlaneGeometry(60000, 60000), waterMat);
water.rotation.x = -Math.PI / 2;
sScene.add(water);
const skyDome = new THREE.Mesh(new THREE.SphereGeometry(30000, 32, 16), new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false,
  vertexShader: `varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `${SKY_GLSL} varying vec3 vD; void main(){ gl_FragColor = vec4(skyColor(vD), 1.0); \n#include <colorspace_fragment>\n }`,
}));
sScene.add(skyDome);

function placeSurface(t) {
  const W = innerWidth, H = innerHeight;
  const eS = easeOut(seg(R.surface));
  const eT = easeInOut(seg(R.tilt));
  const dist = Math.exp(lerp(Math.log(2600), Math.log(5.5), eS));
  const pitch = lerp(89.4, 12, eT) * D2R;
  sCamera.position.set(0, dist * Math.sin(pitch), dist * Math.cos(pitch));
  sCamera.up.set(0, 1, 0);
  sCamera.lookAt(0, 0, 0);
  sCamera.setViewOffset(W, H, 0, -0.17 * H * eT, W, H);
  sCamera.updateProjectionMatrix();
  const u = waterMat.uniforms;
  u.uTime.value = t;
  u.uCam.value.copy(sCamera.position);
  // Ring sizes follow the camera height, so the ping reads the same at every altitude.
  u.uRing.value = dist * 0.42 * (0.25 + seg([0.47, 0.63]));
  u.uWave.value = Math.max(0.22, dist * 0.035);
  u.uRingA.value = bell(0.46, 0.48, 0.6, 0.66);
  u.uSonar.value = (1 - seg([0.5, 0.58])) * seg([0.455, 0.47]);
}

// ===========================================================================
// Layer 3 — the lake at eye level (photo, cut-out leaf, live ripples)
// ===========================================================================

const IMG = { w: 1244, h: 700 };
const RIPPLE = { x: 622, y: 470 };
const pScene = new THREE.Scene();
const flatCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const photoMat = new THREE.ShaderMaterial({
  uniforms: {
    uPlate: { value: tex('assets/lake.jpg') }, uLeaf: { value: tex('assets/leaf.png') },
    uRes: { value: new THREE.Vector2(1, 1) }, uTime: { value: 0 }, uRing: { value: 0 }, uRingA: { value: 0 }, uZoom: { value: 1 },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D uPlate, uLeaf; uniform vec2 uRes; uniform float uTime, uRing, uRingA, uZoom;
    varying vec2 vUv;
    const vec2 IMG = vec2(${IMG.w}.0, ${IMG.h}.0);
    const vec2 C = vec2(${RIPPLE.x}.0, ${RIPPLE.y}.0);
    void main() {
      // Cover-fit the photo, zooming gently toward the ripple as we sink to the water.
      vec2 sp = vec2(vUv.x, 1.0 - vUv.y) * uRes;
      float s = max(uRes.x / IMG.x, uRes.y / IMG.y) * uZoom;
      vec2 off = (uRes - IMG * s) / 2.0 + (C - IMG / 2.0) * (s - s / uZoom) * -1.0;
      vec2 p = (sp - off) / s;
      // Water: shimmer plus the ping's ring and a slow ambient ring.
      float w = smoothstep(290.0, 340.0, p.y);
      float persp = 0.35 + (p.y - 300.0) / 400.0;
      vec2 o = vec2(sin(p.y * 0.09 + uTime * 1.4) * 0.9, cos(p.x * 0.025 + uTime * 0.9) * 0.6) * persp;
      vec2 d = p - C; d.y *= 3.4;
      float dist = length(d);
      vec2 dir = d / max(dist, 1.0); dir.y /= 3.4;
      float light = 0.0;
      for (int i = 0; i < 2; i++) {
        float front = i == 0 ? uRing : mod(uTime * 60.0, 520.0);
        float amp = i == 0 ? uRingA : 0.25 * (1.0 - mod(uTime * 60.0, 520.0) / 520.0);
        float behind = front - dist;
        if (behind > 0.0) {
          float env = exp(-behind / 120.0) * smoothstep(0.0, 18.0, behind) * amp;
          o += dir * sin(behind * 0.115) * env * 9.0 * persp;
          light += cos(behind * 0.115) * env * 0.1;
        }
      }
      vec3 c = texture2D(uPlate, vec2((p.x + o.x * w) / IMG.x, 1.0 - (p.y + o.y * w) / IMG.y)).rgb * (1.0 + light * w);
      // Leaf with a gentle breeze (top stays attached).
      float sway = 0.05 * sin(uTime * 1.3) + 0.03 * sin(uTime * 2.1 + 1.0);
      float tt = clamp(p.y / 228.0, 0.0, 1.15);
      vec2 q = p - vec2(-11.0, 36.0) * tt * tt * sway;
      vec2 luv = (q - vec2(330.0, 0.0)) / vec2(370.0, 300.0);
      if (luv.x >= 0.0 && luv.x <= 1.0 && luv.y >= 0.0 && luv.y <= 1.0) {
        vec4 leaf = texture2D(uLeaf, vec2(luv.x, 1.0 - luv.y));
        c = mix(c, leaf.rgb, leaf.a);
      }
      gl_FragColor = vec4(c, 1.0);
      #include <colorspace_fragment>
    }`,
});
pScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), photoMat));

function placePhoto(t) {
  const u = photoMat.uniforms;
  u.uRes.value.set(RT.photo.width, RT.photo.height);
  u.uTime.value = t;
  u.uRing.value = seg([0.6, 0.78]) * 560;
  u.uRingA.value = bell(0.6, 0.62, 0.74, 0.8);
  u.uZoom.value = 1 + 0.14 * easeInOut(seg([0.62, 0.74]));
}

// ===========================================================================
// Layer 4 — beneath the surface: tagged fish and their tracks
// ===========================================================================

const uScene = new THREE.Scene();
const uCamera = new THREE.PerspectiveCamera(55, 1, 0.05, 80);
const MURK = new THREE.Color().setRGB(0.05, 0.16, 0.14);       // linear
uScene.fog = new THREE.FogExp2(MURK, 0.07);
uScene.background = MURK.clone();
uScene.add(new THREE.HemisphereLight(0xc8fff0, 0x10302a, 2.6));
const sunUnder = new THREE.DirectionalLight(0xf0fff6, 2.6);
sunUnder.position.set(2, 10, 3);
uScene.add(sunUnder);

// Gradient water column behind everything.
uScene.add(new THREE.Mesh(new THREE.SphereGeometry(60, 32, 16), new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false, fog: false,
  vertexShader: `varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `varying vec3 vD; void main(){ float h = vD.y;
    vec3 murk = vec3(0.05, 0.16, 0.14);
    vec3 c = mix(vec3(0.008, 0.035, 0.03), murk, smoothstep(-0.7, 0.0, h));
    c = mix(c, vec3(0.2, 0.42, 0.36), smoothstep(0.0, 0.9, h));
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
      float d = length(vW - uCam);
      vec3 c = mix(vec3(0.12, 0.3, 0.26), vec3(0.62, 0.86, 0.76), window) + l * 0.45 * (0.3 + window);
      c = mix(vec3(0.05, 0.16, 0.14), c, exp(-d * 0.07));          // fade into the murk
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
  vertexShader: `varying vec3 vW; #include <fog_pars_vertex>
    void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vec4 mvPosition = viewMatrix * w; gl_Position = projectionMatrix * mvPosition; \n#include <fog_vertex>\n }`.replace('#include <fog_pars_vertex>', '\n#include <fog_pars_vertex>\n'),
  fragmentShader: `uniform float uTime; varying vec3 vW; ${NOISE} ${CAUSTIC} \n#include <fog_pars_fragment>\n
    void main(){
      float n = fbm(vec3(vW.xz * 0.35, 0.0));
      vec3 c = mix(vec3(0.09, 0.1, 0.065), vec3(0.24, 0.23, 0.15), n);
      c += caustic(vW.xz * 0.8, uTime) * vec3(0.5, 0.72, 0.58) * 0.32;
      gl_FragColor = vec4(c, 1.0);
      \n#include <fog_fragment>\n
      \n#include <colorspace_fragment>\n
    }`,
});
const bed = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), bedMat);
bed.rotation.x = -Math.PI / 2;
bed.position.y = -5.5;
uScene.add(bed);

// Shafts of light from the surface.
const rayMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
  uniforms: { uTime: { value: 0 } },
  vertexShader: `varying vec2 vUv; varying float vSeed; void main(){ vUv = uv; vSeed = position.z; gl_Position = projectionMatrix * modelViewMatrix * vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: `uniform float uTime; varying vec2 vUv;
    void main(){ float edge = pow(sin(vUv.x * 3.14159), 3.0); float fall = pow(vUv.y, 2.2);
      float flick = 0.7 + 0.3 * sin(uTime * 0.6 + vUv.x * 4.0 + vUv.y * 2.0);
      gl_FragColor = vec4(vec3(0.55, 0.85, 0.75) * edge * fall * flick * 0.07, 1.0);
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
  fragmentShader: `varying float vA; void main(){ float d = length(gl_PointCoord - 0.5); gl_FragColor = vec4(vec3(0.8, 0.92, 0.85), smoothstep(0.5, 0.0, d) * 0.45 * vA); }`,
});
uScene.add(new THREE.Points(snowGeo, snowMat));

// Fish: a photoscanned barramundi (CC0, Khronos glTF samples), swimming via a vertex bend.
const FISH = [
  // tagged fish (with ping rings, tracks and labels)
  { tag: 'A-417', c: [0.3, -1.45, -0.6], a: 2.3, b: 1.2, w: 0.16, ph: 0.0, s: 1.9, chip: [18, -46] },
  { tag: 'B-208', c: [-1.8, -2.1, -3.6], a: 3.0, b: 1.8, w: -0.13, ph: 2.1, s: 1.7, chip: [-190, 18] },
  { tag: 'C-093', c: [2.3, -1.0, -4.8], a: 2.6, b: 1.6, w: 0.15, ph: 4.0, s: 1.6, chip: [18, -40] },
  // the rest of the school
  ...Array.from({ length: isSmall() ? 6 : 11 }, (_, i) => ({
    c: [-6 + (i % 6) * 2.4, -1.2 - (i % 3) * 0.8, -7 - Math.floor(i / 6) * 3.5], a: 2 + (i % 4), b: 1.2 + (i % 3) * 0.5,
    w: (i % 2 ? 1 : -1) * (0.12 + (i % 5) * 0.02), ph: i * 1.3, s: 1.2 + (i % 4) * 0.2,
  })),
];
const fishPath = (f, t, out) => {
  const a = f.w * t + f.ph;
  out.set(f.c[0] + f.a * Math.cos(a), f.c[1] + 0.25 * Math.sin(2 * a + f.ph), f.c[2] + f.b * Math.sin(a));
  return out;
};
const fishObjs = [];
const pingTex = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d');
  x.strokeStyle = 'rgba(255,150,110,1)';
  x.lineWidth = 6;
  x.beginPath();
  x.arc(64, 64, 56, 0, Math.PI * 2);
  x.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();
const TRAIL = 46;
const tagLayer = document.createElement('div');
overlay.appendChild(tagLayer);

new GLTFLoader().load('assets/fish.glb', (gltf) => {
  let base = null;
  gltf.scene.traverse((o) => { if (o.isMesh && !base) base = o; });
  if (!base) return;
  base.geometry.computeBoundingBox();
  const bb = base.geometry.boundingBox;
  base.geometry.translate(0, -(bb.min.y + bb.max.y) / 2, -(bb.min.z + bb.max.z) / 2);
  const len = bb.max.z - bb.min.z;
  for (const f of FISH) {
    const mat = base.material.clone();
    mat.envMapIntensity = 0;
    mat.roughness = 0.62;
    mat.color.multiplyScalar(1.25);
    const uni = { uTime: { value: 0 }, uPhase: { value: f.ph * 3 }, uLen: { value: len } };
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, uni);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime, uPhase, uLen; varying vec3 vCW;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          float s = clamp(transformed.z / uLen + 0.5, 0.0, 1.0);      // 0 = head (-z), 1 = tail (+z)
          float tail = pow(s, 1.7);
          transformed.x += sin(uTime * 7.0 + s * 5.0 + uPhase) * uLen * (0.025 + 0.11 * tail);`)
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvCW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>\nuniform float uTime; varying vec3 vCW;\n${CAUSTIC}`)
        .replace('#include <opaque_fragment>', `outgoingLight += diffuseColor.rgb * caustic(vCW.xz * 1.4, uTime) * vec3(0.5, 0.75, 0.62) * 0.55;\n#include <opaque_fragment>`);
    };
    const mesh = new THREE.Mesh(base.geometry, mat);
    mesh.rotation.y = Math.PI;      // the model's head points to -z; face the direction of travel
    const holder = new THREE.Group();
    holder.add(mesh);
    holder.scale.setScalar(f.s);
    uScene.add(holder);
    const obj = { f, holder, mesh, uni, pos: new THREE.Vector3(), next: new THREE.Vector3() };
    if (f.tag) {
      const tag = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.07, 10), new THREE.MeshStandardMaterial({ color: 0xff7a45, emissive: 0x662010 }));
      tag.rotation.x = Math.PI / 2;
      tag.position.set(0, (bb.max.y - bb.min.y) * 0.42, -len * 0.05);
      mesh.add(tag);
      obj.tagMesh = tag;
      obj.rings = [0, 1, 2].map(() => {
        const r = new THREE.Sprite(new THREE.SpriteMaterial({ map: pingTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
        uScene.add(r);
        return r;
      });
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL * 3), 3));
      const fade = new Float32Array(TRAIL);
      for (let i = 0; i < TRAIL; i++) fade[i] = 1 - i / TRAIL;
      g.setAttribute('fade', new THREE.BufferAttribute(fade, 1));
      obj.trail = new THREE.Points(g, new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, fog: false,
        uniforms: { uPx: { value: 1 }, uReveal: { value: 0 } },
        vertexShader: `attribute float fade; uniform float uPx, uReveal; varying float vA;
          void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); float on = step(1.0 - uReveal, fade);
            gl_PointSize = uPx * (10.0 + 18.0 * fade) / -mv.z * on; vA = fade * on * exp(mv.z * 0.07); gl_Position = projectionMatrix * mv; }`,
        fragmentShader: `varying float vA; void main(){ float d = length(gl_PointCoord - 0.5); gl_FragColor = vec4(1.0, 0.55, 0.38, smoothstep(0.5, 0.15, d) * vA); }`,
      }));
      uScene.add(obj.trail);
      obj.chip = document.createElement('div');
      obj.chip.className = 'tag-chip';
      obj.chip.innerHTML = `<i></i><b>TAG ${f.tag}</b><span></span>`;
      tagLayer.appendChild(obj.chip);
    }
    fishObjs.push(obj);
  }
});

const tagWorld = new THREE.Vector3();
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

  const reveal = clamp(seg([0.7, 0.86]), 0, 1);
  const chipsOn = waterY < 0.96 ? 1 - seg([0.92, 0.97]) : 0;
  for (const o of fishObjs) {
    const { f } = o;
    fishPath(f, t, o.pos);
    fishPath(f, t + 0.05, o.next);
    o.holder.position.copy(o.pos);
    o.holder.lookAt(o.next);
    o.uni.uTime.value = t;
    if (!o.tagMesh) continue;
    o.tagMesh.getWorldPosition(tagWorld);
    o.rings.forEach((r, i) => {
      const k = (t * 0.45 + i / 3) % 1;
      r.position.copy(tagWorld);
      r.scale.setScalar(0.05 + k * 0.9);
      r.material.opacity = (1 - k) * 0.85 * reveal;
    });
    const arr = o.trail.geometry.attributes.position.array;
    for (let i = 0; i < TRAIL; i++) {
      fishPath(f, t - i * 0.32, tmpV);
      arr[i * 3] = tmpV.x;
      arr[i * 3 + 1] = tmpV.y + 0.12 * f.s;
      arr[i * 3 + 2] = tmpV.z;
    }
    o.trail.geometry.attributes.position.needsUpdate = true;
    o.trail.material.uniforms.uReveal.value = reveal;
    o.trail.material.uniforms.uPx.value = RT.under.height / 900;
    // Label chip, only where the underwater view is on screen.
    tmpV.copy(tagWorld).project(uCamera);
    const x = (tmpV.x * 0.5 + 0.5) * W, y = (-tmpV.y * 0.5 + 0.5) * H;
    const depth = (-o.pos.y).toFixed(1);
    const vis = tmpV.z < 1 && y > waterY * H + 20 && x > 0 && x < W ? reveal * chipsOn : 0;
    o.chip.style.opacity = vis.toFixed(3);
    o.chip.style.transform = `translate(${(x + f.chip[0]).toFixed(1)}px, ${(y + f.chip[1]).toFixed(1)}px)`;
    o.chip.lastChild.textContent = `${depth} m · ping ${Math.floor((t * 0.45) % 1 * 4) + 1}s ago`;
  }
}

// ===========================================================================
// Compositor
// ===========================================================================

const compMat = new THREE.ShaderMaterial({
  uniforms: {
    tGlobe: { value: RT.globe.texture }, tSurface: { value: RT.surface.texture }, tPhoto: { value: RT.photo.texture }, tUnder: { value: RT.under.texture },
    tStars: { value: tex('assets/stars.jpg') },
    wSurface: { value: 0 }, wPhoto: { value: 0 }, uUnder: { value: 0 }, uWaterY: { value: 2 },
    uCloud: { value: 0 }, uCloudZoom: { value: 1 }, uTime: { value: 0 }, uRes: { value: new THREE.Vector2(1, 1) }, uSkyDay: { value: 0 },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tGlobe, tSurface, tPhoto, tUnder, tStars;
    uniform float wSurface, wPhoto, uUnder, uWaterY, uCloud, uCloudZoom, uTime, uSkyDay;
    uniform vec2 uRes;
    varying vec2 vUv;
    ${NOISE}
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
      if (wPhoto > 0.0) col = mix(col, texture2D(tPhoto, uv).rgb, wPhoto);

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
        col += m * vec3(0.75, 0.95, 0.9) * 0.55;
      }

      // Flying through the cloud deck.
      if (uCloud > 0.0) {
        vec2 c = (uv - 0.5) * vec2(uRes.x / uRes.y, 1.0) * uCloudZoom;
        float n = fbm(vec3(c * 1.6, uTime * 0.03)) * 0.65 + fbm(vec3(c * 4.3 + 7.0, uTime * 0.05)) * 0.35;
        float cover = smoothstep(0.62 - uCloud * 0.75, 0.82 - uCloud * 0.6, n);
        vec3 cc = mix(vec3(0.72, 0.77, 0.83), vec3(1.0), smoothstep(0.35, 0.8, n));
        col = mix(col, cc, cover * clamp(uCloud * 1.6, 0.0, 1.0));
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

// ===========================================================================
// DOM: hero, captions, leaderboard
// ===========================================================================

const hero = $('#hero');
const hint = $('#scroll-hint');
const board = $('#board');
const underlay = $('#underlay');
const captions = [...document.querySelectorAll('#captions p')];
const CAPTION_RANGES = { signal: [0.08, 0.11, 0.2, 0.24], descent: [0.25, 0.28, 0.37, 0.41], surface: [0.52, 0.55, 0.63, 0.67], under: [0.74, 0.77, 0.84, 0.87] };
const chapterBtns = [...document.querySelectorAll('#chapters button')];

function placeDom(waterY) {
  const H = innerHeight;
  const hOut = seg(R.heroOut);
  hero.style.opacity = (1 - hOut).toFixed(3);
  hero.style.transform = `translateY(${(-60 * hOut).toFixed(1)}px)`;
  hero.style.visibility = hOut >= 1 ? 'hidden' : 'visible';
  hint.style.opacity = (1 - seg([0, 0.02])).toFixed(3);
  for (const c of captions) {
    const r = CAPTION_RANGES[c.dataset.cap];
    const a = bell(...r);
    c.style.opacity = a.toFixed(3);
    c.style.transform = `translateY(${((1 - a) * 14).toFixed(1)}px)`;
  }
  // Leaderboard: rises from deep below, breaks the surface, settles exactly at the end.
  const eB = seg(R.board);
  board.style.visibility = eB > 0 ? 'visible' : 'hidden';
  board.style.transform = `translate(-50%, calc(-46% + ${((1 - easeOut(eB)) * 1.15 * H).toFixed(1)}px))`;
  board.inert = eB < 0.98;
  underlay.style.top = `${(clamp(waterY, -0.1, 1.2) * 100).toFixed(2)}%`;
  underlay.style.display = waterY < 1.01 && eB > 0 ? 'block' : 'none';
  document.body.classList.toggle('in-water', p > 0.5);
  const nearest = chapterBtns.reduce((best, b) => (Math.abs(+b.dataset.to - p) < Math.abs(+best.dataset.to - p) ? b : best), chapterBtns[0]);
  chapterBtns.forEach((b) => b.classList.toggle('on', b === nearest));
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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

// Where the waterline sits on screen (fraction from the top; > 1 = not visible).
function waterline() {
  if (p < 0.645) return 2;
  if (p < 0.72) {
    const a = seg([0.645, 0.69]), b = seg([0.7, 0.76]);
    return lerp(lerp(1.08, 0.5, easeInOut(a)), -0.08, easeInOut(b));
  }
  if (p < R.board[0] + 0.03) return lerp(0.5, -0.08, easeInOut(seg([0.7, 0.76])));
  return lerp(-0.08, 1.12, easeInOut(seg([0.89, 1.0])));
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

  const wSurface = seg([0.455, 0.475]);
  const wPhoto = seg(R.toPhoto);
  const globeOn = wSurface < 1;
  const surfaceOn = wSurface > 0 && wPhoto < 1;
  const waterY = waterline();
  const underOn = waterY < 1.02;

  if (globeOn) {
    placeGlobe(dt, clock);
    renderer.setRenderTarget(RT.globe);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(gScene, gCamera);
  } else {
    updateGlobeLabels(clock, { hero: 0, signal: 0 });
  }
  if (surfaceOn) {
    placeSurface(clock);
    renderer.setRenderTarget(RT.surface);
    renderer.render(sScene, sCamera);
  }
  if (wPhoto > 0) {
    placePhoto(clock);
    renderer.setRenderTarget(RT.photo);
    renderer.render(pScene, flatCam);
  }
  if (underOn) {
    placeUnder(clock, waterY);
    renderer.setRenderTarget(RT.under);
    renderer.render(uScene, uCamera);
  } else {
    for (const o of fishObjs) if (o.chip) o.chip.style.opacity = '0';
  }

  const cu = compMat.uniforms;
  cu.wSurface.value = wSurface;
  cu.wPhoto.value = wPhoto;
  cu.uUnder.value = underOn ? 1 : 0;
  cu.uWaterY.value = waterY;
  cu.uCloud.value = bell(0.405, 0.46, 0.468, 0.5);
  cu.uCloudZoom.value = lerp(3.6, 0.35, seg(R.clouds));
  cu.uSkyDay.value = seg([0.3, 0.45]);
  cu.uTime.value = clock;
  renderer.setRenderTarget(null);
  renderer.render(compScene, flatCam);

  placeDom(waterY);
  requestAnimationFrame(frame);
}

// ===========================================================================
// Events
// ===========================================================================

addEventListener('resize', resize);
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
requestAnimationFrame(frame);
