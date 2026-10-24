// Tidecast landing page.
//  1. A photoreal rotating Earth (NASA Blue Marble, night lights, relief, ocean glint,
//     procedural clouds, atmosphere) with fishing spots, routes, labels and a pin.
//  2. "Leaderboard": the Earth morphs into a water drop, the view follows it down into
//     a lake (the lake photo, re-lit live in WebGL), it splashes, the rebound pops the
//     leaderboard up onto a leaf that bends under it; dropping the drop that forms on the
//     leaf tip raises the full leaderboard.
import * as THREE from './vendor/three.module.min.js';

const gsap = window.gsap;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = (s) => document.querySelector(s);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const DPR = () => Math.min(window.devicePixelRatio || 1, 2);

// ===========================================================================
// Globe
// ===========================================================================

const globeCanvas = $('#globe');
const gRenderer = new THREE.WebGLRenderer({ canvas: globeCanvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
gRenderer.outputColorSpace = THREE.SRGBColorSpace;
gRenderer.toneMapping = THREE.ACESFilmicToneMapping;
gRenderer.toneMappingExposure = 1.16;
const gScene = new THREE.Scene();
const gCamera = new THREE.PerspectiveCamera(26, 1, 0.05, 50);
const tilt = new THREE.Group();
const spin = new THREE.Group();
tilt.add(spin);
gScene.add(tilt);

const loader = new THREE.TextureLoader();
const tex = (url, srgb) => {
  const t = loader.load(url);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = gRenderer.capabilities.getMaxAnisotropy();
  return t;
};

// Where the globe sits on screen (fractions of the viewport) and its radius in px.
const view = { cx: 0.74, cy: 1.15, r: 1.045, spinSpeed: 0.045, angle: 0 };
const heroView = () => {
  const W = innerWidth, H = innerHeight;
  if (W < 860) return { cx: 0.62, cy: 1.08, r: Math.min(0.62, (0.95 * W) / H) };
  return { cx: 0.74, cy: 1.15, r: Math.min(1.045, (0.62 * W) / H) };
};

const SUN = new THREE.Vector3(0.95, 0.75, 1.0).normalize(); // camera space: upper right, in front

const NOISE = /* glsl */ `
  float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float vnoise(vec3 x) {
    vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  float fbm(vec3 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 6; i++) { s += a * vnoise(p); p = p * 2.03 + 3.1; a *= 0.5; } return s; }
`;

const earthMat = new THREE.ShaderMaterial({
  transparent: true,
  uniforms: {
    uDay: { value: tex('assets/earth-day.jpg', true) },
    uNight: { value: tex('assets/earth-night.jpg', true) },
    uRelief: { value: tex('assets/earth-relief.jpg') },
    uWater: { value: tex('assets/earth-water.jpg') },
    uSun: { value: SUN },
    uMorph: { value: 0 },
    uTime: { value: 0 },
  },
  vertexShader: /* glsl */ `
    uniform float uMorph;
    uniform float uTime;
    varying vec2 vUv; varying vec3 vN; varying vec3 vPos; varying vec3 vObj; varying vec3 vNorth;
    void main() {
      vUv = uv; vObj = position;
      vec3 p = position, n = normal;
      // Morph the sphere into a water drop (tip up): profile r(t), y(t) over polar angle t.
      float t = acos(clamp(p.y, -1.0, 1.0));
      float s2 = sin(t * 0.5);
      float r = sin(t) * s2 * 1.12;
      float y = cos(t) * 1.18 + 0.12;
      float dr = (cos(t) * s2 + sin(t) * 0.5 * cos(t * 0.5)) * 1.12;
      float dy = -sin(t) * 1.18;
      vec2 dir = length(p.xz) > 1e-5 ? normalize(p.xz) : vec2(0.0);
      vec3 tp = vec3(dir.x * r, y, dir.y * r);
      vec3 tn = normalize(vec3(dir.x * -dy, dr, dir.y * -dy) + vec3(0.0, 1e-4, 0.0));
      float wob = uMorph * 0.025 * sin(uTime * 9.0 + p.y * 3.0);
      p = mix(p, tp * (1.0 + wob), uMorph);
      n = normalize(mix(n, tn, uMorph));
      vN = normalize(normalMatrix * n);
      vNorth = normalize(normalMatrix * vec3(0.0, 1.0, 0.0));
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      vPos = mv.xyz;
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D uDay, uNight, uRelief, uWater;
    uniform vec3 uSun; uniform float uMorph, uTime;
    varying vec2 vUv; varying vec3 vN; varying vec3 vPos; varying vec3 vObj; varying vec3 vNorth;
    ${NOISE}
    void main() {
      vec3 V = normalize(-vPos);
      vec3 N = normalize(vN);
      vec3 L = normalize(uSun);
      // Relief: bump the normal with the topography gradient.
      float h = texture2D(uRelief, vUv).r;
      float hx = texture2D(uRelief, vUv + vec2(1.0 / 2048.0, 0.0)).r - h;
      float hy = texture2D(uRelief, vUv + vec2(0.0, 1.0 / 1024.0)).r - h;
      vec3 east = normalize(cross(vNorth, N) + 1e-5);
      vec3 north = cross(N, east);
      vec3 Nb = normalize(N - (east * hx + north * hy) * 2.2 * (1.0 - uMorph));

      vec3 day = texture2D(uDay, vUv).rgb;
      day = max(mix(vec3(dot(day, vec3(0.299, 0.587, 0.114))), day, 1.2), 0.0);   // a touch more vivid
      float water = texture2D(uWater, vUv).r;
      // Shallow seas read teal, deep ocean stays navy (as in the reference art).
      float shallow = smoothstep(0.02, 0.12, max(day.g - day.b * 0.55, 0.0)) * water;
      day = mix(day, day * vec3(0.75, 1.15, 1.18) + vec3(0.0, 0.02, 0.03), shallow * 0.6);
      day = mix(day, day * vec3(1.12, 1.02, 0.86), (1.0 - water) * 0.35);   // warmer land

      float ndl = dot(Nb, L);
      float lit = smoothstep(-0.12, 0.35, ndl);
      vec3 sunCol = vec3(1.0, 0.93, 0.84);
      vec3 col = day * (max(ndl, 0.0) * 1.25 + 0.035) * sunCol;

      // Ocean glint.
      vec3 H = normalize(L + V);
      float nh = max(dot(N, H), 0.0);
      col += (pow(nh, 1400.0) * 0.55 + pow(nh, 160.0) * 0.06) * water * vec3(1.0, 0.86, 0.68) * lit;

      // City lights on the night side.
      vec3 night = texture2D(uNight, vUv).rgb;
      col += night * vec3(1.0, 0.72, 0.42) * 1.8 * (1.0 - lit) * (1.0 - uMorph);

      // Clouds (procedural) with soft shadows.
      // Thin, wispy clouds: high-frequency noise, sparse coverage.
      vec3 cp = vObj * vec3(4.4, 7.5, 4.4) + vec3(uTime * 0.012, 0.0, uTime * 0.006);
      float cloud = smoothstep(0.6, 0.9, fbm(cp)) * (0.75 - 0.35 * abs(vObj.y));
      float shadow = smoothstep(0.6, 0.9, fbm(cp + vec3(0.04, -0.03, 0.0)));
      col *= 1.0 - shadow * 0.12 * (1.0 - uMorph);
      col = mix(col, vec3(1.0) * (max(ndl, 0.0) * 1.05 + 0.04) * sunCol, cloud * 0.5 * (1.0 - uMorph));

      // Atmosphere: blue rim, warm on the sun side.
      float fres = pow(1.0 - max(dot(N, V), 0.0), 3.6);
      vec3 atm = mix(vec3(0.32, 0.58, 1.0), vec3(1.0, 0.68, 0.48), smoothstep(0.3, 1.0, dot(N, L)));
      col = mix(col, atm * (lit * 0.95 + 0.08), fres * 0.45 * (1.0 - uMorph));

      // Water drop: the Earth seen through water, glassy rim and highlights.
      float fw = pow(1.0 - max(dot(N, V), 0.0), 1.6);
      vec3 drop = col * 0.55 + vec3(0.05, 0.16, 0.24);
      drop = mix(drop, vec3(0.78, 0.9, 0.97), fw * 0.75);
      drop += pow(max(dot(reflect(-L, N), V), 0.0), 140.0) * 3.0;
      drop += pow(max(dot(reflect(-normalize(vec3(-0.7, 0.4, 0.6)), N), V), 0.0), 30.0) * 0.35;
      col = mix(col, drop, uMorph);

      gl_FragColor = vec4(col, mix(1.0, 0.9 + 0.1 * fw, uMorph));
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
});
const earth = new THREE.Mesh(new THREE.SphereGeometry(1, 192, 128), earthMat);
earth.renderOrder = -1; // draw first so routes and spots on the near side stay visible
spin.add(earth);

// Outer glow (fades out as the Earth turns into water).
const glowMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, side: THREE.BackSide, blending: THREE.AdditiveBlending,
  uniforms: { uSun: { value: SUN }, uFade: { value: 1 } },
  vertexShader: `varying vec3 vN; varying vec3 vP; void main(){ vN = normalize(normalMatrix * normal); vec4 mv = modelViewMatrix * vec4(position,1.0); vP = mv.xyz; gl_Position = projectionMatrix * mv; }`,
  fragmentShader: `uniform vec3 uSun; uniform float uFade; varying vec3 vN; varying vec3 vP;
    void main(){
      // Back faces of a slightly larger sphere: strongest just outside the Earth's limb.
      float dv = -dot(vN, normalize(-vP));
      float i = pow(clamp(dv * 2.7, 0.0, 1.0), 3.0);
      float k = clamp(dot(vN, normalize(uSun)) * 0.6 + 0.4, 0.0, 1.0);
      vec3 c = mix(vec3(0.28, 0.55, 1.0), vec3(1.0, 0.62, 0.42), k);
      gl_FragColor = vec4(c * i * 0.95 * uFade, i * 0.8 * uFade);
      #include <colorspace_fragment>
    }`,
});
const glow = new THREE.Mesh(new THREE.SphereGeometry(1.05, 96, 64), glowMat);
glow.renderOrder = 1;
tilt.add(glow);

// Positions on the globe.
const D2R = Math.PI / 180;
function latLon(lat, lon, r = 1) {
  const phi = (lon + 180) * D2R, theta = (90 - lat) * D2R;
  return new THREE.Vector3(-r * Math.cos(phi) * Math.sin(theta), r * Math.cos(theta), r * Math.sin(phi) * Math.sin(theta));
}

// Fishing spots (glowing coral markers).
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

function spotTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.16, 'rgba(255,240,230,1)');
  g.addColorStop(0.24, 'rgba(240,110,80,1)');
  g.addColorStop(0.36, 'rgba(236,100,70,0.95)');
  g.addColorStop(0.5, 'rgba(240,120,80,0.35)');
  g.addColorStop(1, 'rgba(240,120,80,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const spotMat = new THREE.SpriteMaterial({ map: spotTexture(), transparent: true, depthWrite: false });
const spots = SPOTS.map(([lat, lon], i) => {
  const s = new THREE.Sprite(spotMat.clone());
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
  line.renderOrder = 2;
  line.computeLineDistances();
  spin.add(line);
}

// HTML overlays that follow the globe.
const overlay = $('#globe-overlay');
const FISH_SVG = '<svg viewBox="0 0 46 14"><path d="M2 7c6-6 18-7 28-2l8-5-2 7 2 7-8-5C20 14 8 13 2 7z" fill="rgba(200,215,225,.9)"/></svg>';
const labels = [
  { lat: 17, lon: -121, html: 'PACIFIC<br>OCEAN', cls: 'ocean-label' },
  { lat: 31, lon: -62, html: 'ATLANTIC<br>OCEAN', cls: 'ocean-label' },
  { lat: 24.5, lon: -90, html: 'GULF OF<br>MEXICO', cls: 'ocean-label small' },
  { lat: -10, lon: 75, html: 'INDIAN<br>OCEAN', cls: 'ocean-label' },
  { lat: 30.628, lon: -96.334, html: '<i></i><span><svg viewBox="0 0 24 24"><path d="M12 22s7-6.3 7-12a7 7 0 1 0-14 0c0 5.7 7 12 7 12z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="10" r="2.6" fill="currentColor"/></svg>College Station, TX</span>', cls: 'pin' },
  { lat: 30, lon: -135, html: FISH_SVG, cls: 'fish', drift: 1 },
  { lat: 2, lon: -118, html: FISH_SVG, cls: 'fish', drift: -1 },
  { lat: 32, lon: -60, html: FISH_SVG, cls: 'fish', drift: 1 },
  { lat: 15, lon: -40, html: FISH_SVG, cls: 'fish', drift: -1 },
].map((l) => {
  const el = document.createElement('div');
  el.className = l.cls;
  el.innerHTML = l.html;
  overlay.appendChild(el);
  return { ...l, el, pos: latLon(l.lat, l.lon, 1.0) };
});

const overlayState = { opacity: 1 };
const tmpV = new THREE.Vector3(), tmpN = new THREE.Vector3(), camDir = new THREE.Vector3();
function updateOverlays(t) {
  const W = innerWidth, H = innerHeight;
  for (const l of labels) {
    tmpV.copy(l.pos);
    if (l.drift) tmpV.applyAxisAngle(new THREE.Vector3(0, 1, 0), Math.sin(t * 0.05 + l.lat) * 0.04 * l.drift);
    spin.localToWorld(tmpV);
    tmpN.copy(tmpV).normalize();
    camDir.copy(gCamera.position).sub(tmpV).normalize();
    const facing = tmpN.dot(camDir);
    tmpV.project(gCamera);
    const x = (tmpV.x * 0.5 + 0.5) * W, y = (-tmpV.y * 0.5 + 0.5) * H;
    // Keep the fish out from behind the headline text.
    const clear = l.cls === 'fish' ? clamp((x - 0.47 * W) / (0.05 * W), 0, 1) : 1;
    const vis = clamp((facing - 0.06) / 0.2, 0, 1) * overlayState.opacity * clear;
    l.el.style.opacity = vis.toFixed(3);
    l.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%)${l.drift ? ` scaleX(${l.drift})` : ''}`;
    l.el.style.left = '0px';
    l.el.style.top = '0px';
  }
}

function layoutGlobe() {
  const W = innerWidth, H = innerHeight;
  const Rpx = view.r * H;
  const fov = gCamera.fov * D2R;
  const k = H / 2 / (Math.tan(fov / 2) * Rpx);
  const d = Math.sqrt(1 + k * k);
  gCamera.position.set(0, 0, d);
  gCamera.lookAt(0, 0, 0);
  gCamera.setViewOffset(W, H, W / 2 - view.cx * W, H / 2 - view.cy * H, W, H);
  gCamera.near = Math.max(0.01, d - 2);
  gCamera.far = d + 2;
  gCamera.updateProjectionMatrix();
}

// ===========================================================================
// Lake (photo plate + cut-out leaf, live ripples, refracting drops)
// ===========================================================================

const IMG = { w: 1244, h: 700 };
const IMPACT = { x: 622, y: 470 };          // where the drop hits the water (photo px)
const LEAF_TIP = { x: 627, y: 224 };        // tip of the leaf (photo px)
const LEAF_SEAT = { x: 556, y: 150 };       // where the leaderboard lands on the leaf
const MAX_DROPS = 12, MAX_RIPS = 8;

const lakeCanvas = $('#lake');
const lRenderer = new THREE.WebGLRenderer({ canvas: lakeCanvas, antialias: false, alpha: true, premultipliedAlpha: true });
lRenderer.outputColorSpace = THREE.SRGBColorSpace;
const lScene = new THREE.Scene();
const lCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const plateTex = loader.load('assets/lake.jpg');
plateTex.colorSpace = THREE.SRGBColorSpace;
const leafTex = loader.load('assets/leaf.png');
leafTex.colorSpace = THREE.SRGBColorSpace;

const lake = {
  pan: 0, bend: 0, sway: 1, dim: 0, scale: 1, ox: 0, oy: 0,
  drops: Array.from({ length: MAX_DROPS }, () => ({ ax: 0, ay: 0, ra: 0, bx: 0, by: 0, rb: 0, alpha: 0 })),
  rips: [],
};

const lakeMat = new THREE.ShaderMaterial({
  transparent: true,
  uniforms: {
    uPlate: { value: plateTex }, uLeaf: { value: leafTex },
    uRes: { value: new THREE.Vector2(1, 1) }, uScale: { value: 1 }, uOff: { value: new THREE.Vector2() },
    uTime: { value: 0 }, uPan: { value: 0 }, uBend: { value: 0 }, uDim: { value: 0 },
    uDA: { value: Array.from({ length: MAX_DROPS }, () => new THREE.Vector4()) },
    uDB: { value: Array.from({ length: MAX_DROPS }, () => new THREE.Vector4()) },
    uRip: { value: Array.from({ length: MAX_RIPS }, () => new THREE.Vector4(0, 0, -100, 0)) },
  },
  vertexShader: `void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: /* glsl */ `
    #define MAX_DROPS ${MAX_DROPS}
    #define MAX_RIPS ${MAX_RIPS}
    uniform sampler2D uPlate, uLeaf;
    uniform vec2 uRes, uOff; uniform float uScale, uTime, uPan, uBend, uDim;
    uniform vec4 uDA[MAX_DROPS]; uniform vec4 uDB[MAX_DROPS]; uniform vec4 uRip[MAX_RIPS];
    const vec2 IMG = vec2(${IMG.w}.0, ${IMG.h}.0);

    vec2 bendDisp(vec2 p) { float t = clamp(p.y / 228.0, 0.0, 1.15); float s = t * t; return uBend * vec2(-11.0 * s, 36.0 * s); }

    vec3 plate(vec2 p) { return texture2D(uPlate, vec2(p.x / IMG.x, 1.0 - p.y / IMG.y)).rgb; }

    // Lake water: gentle shimmer plus the expanding rings of every impact.
    vec2 waterOffset(vec2 p, out float light) {
      light = 0.0;
      float w = smoothstep(290.0, 340.0, p.y);
      if (w <= 0.0) return vec2(0.0);
      float persp = 0.35 + (p.y - 300.0) / 400.0;
      vec2 off = vec2(sin(p.y * 0.09 + uTime * 1.4) * 0.9, cos(p.x * 0.025 + uTime * 0.9) * 0.6) * persp;
      for (int i = 0; i < MAX_RIPS; i++) {
        vec4 r = uRip[i];
        float t = uTime - r.z;
        if (t < 0.0 || t > 6.0 || r.w <= 0.0) continue;
        vec2 d = p - r.xy; d.y *= 3.4;                       // rings flattened by perspective
        float dist = length(d);
        float front = t * 150.0;
        float behind = front - dist;
        if (behind < 0.0) continue;
        float env = exp(-behind / 120.0) * smoothstep(0.0, 18.0, behind) * exp(-t * 0.55) * r.w;
        float wave = sin(behind * 0.115) * env;
        vec2 dir = d / max(dist, 1.0); dir.y /= 3.4;
        off += dir * wave * 9.0 * persp;
        light += cos(behind * 0.115) * env * 0.11;
        light += exp(-t * 6.0) * exp(-dist * dist / 900.0) * r.w * 0.35;   // splash flash
      }
      return off * w;
    }

    vec3 scene(vec2 p, out float a) {
      a = smoothstep(-70.0, 0.0, p.y);
      float light;
      vec2 off = waterOffset(p, light);
      vec3 c = plate(p + off) * (1.0 + light);
      // Cut-out leaf, bent from its stem (top stays put).
      vec2 q = p - bendDisp(p - bendDisp(p));
      vec2 luv = (q - vec2(330.0, 0.0)) / vec2(370.0, 300.0);
      if (luv.x >= 0.0 && luv.x <= 1.0 && luv.y >= 0.0 && luv.y <= 1.0) {
        vec4 leaf = texture2D(uLeaf, vec2(luv.x, 1.0 - luv.y));
        c = mix(c, leaf.rgb * (1.0 + uBend * 0.05), leaf.a);
      }
      c *= 1.0 - uDim * 0.38;
      return c;
    }

    float sdUnevenCapsule(vec2 p, vec2 pa, vec2 pb, float ra, float rb) {
      p -= pa; pb -= pa;
      float h = dot(pb, pb);
      if (h < 1e-3) return length(p) - ra;
      vec2 q = vec2(dot(p, vec2(pb.y, -pb.x)), dot(p, pb)) / h;
      q.x = abs(q.x);
      float b = ra - rb;
      vec2 c = vec2(sqrt(max(h - b * b, 1e-4)), b);
      float k = c.x * q.y - c.y * q.x;
      float m = dot(c, q);
      float n = dot(q, q);
      if (k < 0.0) return sqrt(h * n) - ra;
      else if (k > c.x) return sqrt(h * (n + 1.0 - 2.0 * q.y)) - rb;
      return m - ra;
    }

    void main() {
      vec2 sp = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);     // screen px, top-left origin
      vec2 ps = (sp - uOff) / uScale;                              // photo px (screen-fixed)
      float panPx = (1.0 - uPan) * uRes.y / uScale;
      vec2 pScene = ps - vec2(0.0, panPx);
      float a;
      vec3 col = scene(pScene, a);
      vec3 pc = col * a;     // premultiplied
      float pa = a;

      for (int i = 0; i < MAX_DROPS; i++) {
        vec4 A = uDA[i]; vec4 B = uDB[i];
        if (A.w <= 0.0) continue;
        float d = sdUnevenCapsule(ps, A.xy, B.xy, A.z, B.z);
        if (d > 2.0 / uScale) continue;
        float e = 0.6;
        vec2 g = normalize(vec2(
          sdUnevenCapsule(ps + vec2(e, 0.0), A.xy, B.xy, A.z, B.z) - sdUnevenCapsule(ps - vec2(e, 0.0), A.xy, B.xy, A.z, B.z),
          sdUnevenCapsule(ps + vec2(0.0, e), A.xy, B.xy, A.z, B.z) - sdUnevenCapsule(ps - vec2(0.0, e), A.xy, B.xy, A.z, B.z)) + 1e-5);
        float f = clamp(-d / max(A.z, 1.0), 0.0, 1.0);
        float rr = 1.0 - f;
        float nz = sqrt(max(1.0 - rr * rr, 0.0));
        vec2 nxy = g * rr;
        // Refraction: a drop is a tiny lens, the scene behind it appears inverted.
        float sa;
        vec3 refr = scene(pScene - nxy * A.z * 1.9, sa) * 0.95 + vec3(0.01, 0.03, 0.05);
        refr = mix(vec3(0.05, 0.1, 0.16), refr, sa);
        float k = pow(1.0 - nz, 2.6);
        vec3 c = mix(refr, refr * 0.22 + vec3(0.02, 0.05, 0.06), k * 0.85);
        c += vec3(0.8, 0.9, 0.95) * smoothstep(0.6, 1.0, rr) * 0.14 * (0.6 + 0.4 * -g.y);
        vec3 N3 = vec3(nxy.x, -nxy.y, nz);
        c += pow(max(dot(N3, normalize(vec3(-0.45, 0.55, 0.7))), 0.0), 70.0) * 2.2;
        c += pow(max(dot(N3, normalize(vec3(0.35, -0.6, 0.72))), 0.0), 26.0) * vec3(1.0, 0.97, 0.88) * 0.32;
        float m = clamp(0.5 - d * uScale, 0.0, 1.0) * A.w;
        pc = c * m + pc * (1.0 - m);
        pa = m + pa * (1.0 - m);
      }
      gl_FragColor = vec4(pc / max(pa, 1e-4), pa);
      #include <colorspace_fragment>
      gl_FragColor.rgb *= gl_FragColor.a;
    }`,
});
lScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), lakeMat));

function layoutLake() {
  const W = innerWidth, H = innerHeight;
  lake.scale = Math.max(W / IMG.w, H / IMG.h);
  lake.ox = (W - IMG.w * lake.scale) / 2;
  lake.oy = (H - IMG.h * lake.scale) / 2;
}
const toScreen = (x, y) => ({ x: x * lake.scale + lake.ox, y: y * lake.scale + lake.oy });
const toPhoto = (x, y) => ({ x: (x - lake.ox) / lake.scale, y: (y - lake.oy) / lake.scale });
// Same bend as the shader (plus the idle sway), so the card can ride the leaf.
const leafBend = (t) => lake.bend + lake.sway * 0.05 * Math.sin(t * 1.3) + lake.sway * 0.03 * Math.sin(t * 2.1 + 1);
function bendDisp(x, y, b) {
  const t = clamp(y / 228, 0, 1.15), s = t * t;
  return { x: -11 * s * b, y: 36 * s * b };
}

function pushRipple(x, y, strength, t) {
  lake.rips.push({ x, y, t0: t, w: strength });
  if (lake.rips.length > MAX_RIPS) lake.rips.shift();
}

function syncLakeUniforms(t) {
  const dpr = DPR();
  const u = lakeMat.uniforms;
  u.uRes.value.set(lakeCanvas.width, lakeCanvas.height);
  u.uScale.value = lake.scale * dpr;
  u.uOff.value.set(lake.ox * dpr, lake.oy * dpr);
  u.uTime.value = t;
  u.uPan.value = lake.pan;
  u.uBend.value = leafBend(t);
  u.uDim.value = lake.dim;
  lake.drops.forEach((d, i) => {
    u.uDA.value[i].set(d.ax, d.ay, d.ra, d.alpha);
    u.uDB.value[i].set(d.bx, d.by, d.rb, 0);
  });
  for (let i = 0; i < MAX_RIPS; i++) {
    const r = lake.rips[i];
    u.uRip.value[i].set(r ? r.x : 0, r ? r.y : 0, r ? r.t0 : -100, r ? r.w : 0);
  }
}

// ===========================================================================
// Leaderboard
// ===========================================================================

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const allRows = () => (window.TIDECAST_LEADERBOARD || []).slice().sort((a, b) => (b.points || 0) - (a.points || 0));
const rowsFor = (period) => allRows().filter((r) => period === 'all' || (r.period || 'week') === 'week');
const initials = (n) => String(n || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const hue = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

function renderBoard(period = 'week') {
  const rows = rowsFor(period);
  const medals = ['1', '2', '3'];
  $('#podium').innerHTML = rows.slice(0, 3).map((r, i) => `
    <article><div class="medal">${medals[i]}</div><strong>${esc(r.angler)}</strong><span>${esc(r.species)} · ${esc(r.measure)}</span><span>${esc(r.location)}</span><em>${(r.points || 0).toLocaleString()} pts</em></article>`).join('');
  $('#rows').innerHTML = rows.slice(3).map((r, i) => `
    <li><span class="rank">${i + 4}</span><span class="avatar" style="background:hsl(${hue(r.angler)} 45% 42%)">${esc(initials(r.angler))}</span>
      <span class="who"><strong>${esc(r.angler)}</strong><span>${esc(r.species)} · ${esc(r.location)}</span></span>
      <span class="measure">${esc(r.measure)}</span><span class="pts">${(r.points || 0).toLocaleString()} pts</span></li>`).join('') ||
    (rows.length > 3 ? '' : '<li class="empty"><span></span><span></span><span class="who"><span>More anglers coming soon.</span></span></li>');
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.period === period)));
}

function renderMini() {
  $('#mini-rows').innerHTML = rowsFor('week').slice(0, 3).map((r, i) => `<li><b>${i + 1}</b><span>${esc(r.angler)}</span><em>${esc(r.measure)}</em></li>`).join('');
  const top = rowsFor('week')[0];
  if (top) {
    $('#teaser-title').textContent = `${top.species}, ${top.measure}`;
    $('#teaser-sub').textContent = `${top.angler} · ${top.location}`;
  }
}

// ===========================================================================
// The sequence
// ===========================================================================

let phase = 'hero';           // hero | intro | leaf | board | outro
let tl = null;
let clock = 0;
let autoDrop = null;
const card = $('#mini-card');
const cardState = { x: 0, y: 0, s: 0, rot: 0, o: 0, onLeaf: false };
const dropHit = $('#drop-hit');
const hero = $('#hero');
const sky = $('#sky');

function resetDrops() {
  for (const d of lake.drops) Object.assign(d, { ax: 0, ay: 0, ra: 0, bx: 0, by: 0, rb: 0, alpha: 0 });
}

// Screen position/size of the globe-drop's round body, to hand it to the lake shader.
function globeDropInPhoto() {
  const W = innerWidth, H = innerHeight;
  const R = view.r * H;
  const body = toPhoto(view.cx * W, view.cy * H + 0.25 * R);
  const tip = toPhoto(view.cx * W, view.cy * H - 1.25 * R);
  return { ax: body.x, ay: body.y, ra: (0.86 * R) / lake.scale, bx: tip.x, by: tip.y, rb: (0.04 * R) / lake.scale };
}

function playLeaderboard() {
  if (phase !== 'hero') return;
  phase = 'intro';
  setTimeout(() => phase !== 'hero' && document.body.classList.add('in-lake'), 2300);
  renderMini();
  renderBoard('week');
  $('#skip').hidden = false;
  if (reduceMotion) return finishToBoard(true);

  layoutLake();
  const W = innerWidth, H = innerHeight;
  const dropX = toScreen(IMPACT.x, 0).x / W;
  const dropR = (26 * lake.scale) / H;                     // drop radius ≈ 26 photo px
  const u = earthMat.uniforms;
  const fall = { y: 0 };
  const main = lake.drops[0];
  tl = gsap.timeline({ defaults: { ease: 'power2.inOut' } });

  // 1. The text leaves; the Earth spins up, shrinks to the centre and turns into water.
  tl.to(hero, { opacity: 0, y: -24, duration: 0.7, ease: 'power2.in' }, 0)
    .to(overlayState, { opacity: 0, duration: 0.6 }, 0)
    .to(view, { spinSpeed: 1.6, duration: 1.4, ease: 'power2.in' }, 0)
    .to(view, { cx: dropX, cy: 0.3, r: dropR, duration: 1.9, ease: 'power3.inOut' }, 0.15)
    .to(tilt.rotation, { x: 0, duration: 1.6 }, 0.2)
    .to(u.uMorph, { value: 1, duration: 1.1, ease: 'power2.inOut' }, 1.0)
    .to(glowMat.uniforms.uFade, { value: 0, duration: 0.8 }, 0.9)
    .to(view, { spinSpeed: 0.2, duration: 0.6 }, 1.5)
  // 2. The camera follows the drop down: sky slides away, the lake rises into view.
    .to(lake, { pan: 1, duration: 1.4, ease: 'power2.inOut' }, 2.05)
    .to(sky, { yPercent: -100, opacity: 0.2, duration: 1.4, ease: 'power2.inOut' }, 2.05)
  // 3. Hand the drop to the lake shader (it refracts the real scene), then let it fall.
    .add(() => {
      Object.assign(main, globeDropInPhoto(), { alpha: 0 });
    }, 3.0)
    .to(main, { alpha: 1, duration: 0.25 }, 3.0)
    .to(globeCanvas, { opacity: 0, duration: 0.25 }, 3.0)
    .add(() => {
      const start = { ...main };
      const targetR = 13;
      fall.y = 0;
      gsap.to(fall, {
        y: 1, duration: 0.62, ease: 'power2.in',
        onUpdate() {
          const k = fall.y;
          main.ra = start.ra + (targetR - start.ra) * Math.min(1, k * 1.6);
          main.ax = start.ax + (IMPACT.x - start.ax) * k;
          main.ay = start.ay + (IMPACT.y - main.ra * 0.4 - start.ay) * k;
          main.rb = Math.max(1.2, main.ra * 0.12);
          main.bx = main.ax;
          main.by = main.ay - main.ra * (1.6 - k * 0.9);   // tail relaxes into a falling sphere
        },
        onComplete: () => splash(clock),
      });
    }, 3.25);
}

// Impact: rings, crown droplets, the rebound jet, and the leaderboard popping out of it.
function splash(t0) {
  const [main, ...rest] = lake.drops;
  main.alpha = 0;
  pushRipple(IMPACT.x, IMPACT.y, 1.0, t0);
  pushRipple(IMPACT.x, IMPACT.y, 0.55, t0 + 0.35);
  pushRipple(IMPACT.x, IMPACT.y, 0.3, t0 + 0.75);

  // Crown droplets (ballistic).
  const crown = rest.slice(0, 7).map((d, i) => {
    const ang = -Math.PI / 2 + (i - 3) * 0.42 + (Math.random() - 0.5) * 0.2;
    return { d, x: IMPACT.x + (i - 3) * 3, y: IMPACT.y - 2, vx: Math.cos(ang) * (95 + Math.random() * 60), vy: Math.sin(ang) * (150 + Math.random() * 90), r: 1.6 + Math.random() * 2.2 };
  });
  const jet = rest[7], top = rest[8];
  const j = { h: 0 };
  const g = 900;
  let last = clock;
  const tick = () => {
    const dt = Math.min(0.05, clock - last);
    last = clock;
    for (const c of crown) {
      if (c.d.alpha === 0 && c.done) continue;
      c.vy += g * dt;
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      Object.assign(c.d, { ax: c.x, ay: c.y, ra: c.r, bx: c.x - c.vx * 0.012, by: c.y - c.vy * 0.012, rb: c.r * 0.6, alpha: 1 });
      if (c.vy > 0 && c.y > IMPACT.y + 6) {
        c.d.alpha = 0;
        c.done = true;
      }
    }
    Object.assign(jet, { ax: IMPACT.x, ay: IMPACT.y + 2, ra: 7, bx: IMPACT.x, by: IMPACT.y - j.h, rb: 4.2, alpha: j.h > 0.5 ? 1 : 0 });
  };
  gsap.ticker.add(tick);

  // Worthington jet, then the rebound drop pinches off and rises.
  const rebound = { y: IMPACT.y - 70 };
  gsap.timeline({ onComplete: () => gsap.ticker.remove(tick) })
    .to(j, { h: 74, duration: 0.3, ease: 'power2.out' }, 0.05)
    .add(() => Object.assign(top, { ax: IMPACT.x, ay: rebound.y, ra: 6.5, bx: IMPACT.x, by: rebound.y + 5, rb: 3, alpha: 1 }), 0.32)
    .to(j, { h: 0, duration: 0.45, ease: 'power2.in' }, 0.36)
    .to(rebound, { y: IMPACT.y - 190, duration: 0.55, ease: 'power2.out', onUpdate: () => { top.ay = rebound.y; top.by = rebound.y + 5; } }, 0.32)
    .add(() => popCard(top), 0.9)
    .add(() => pushRipple(IMPACT.x, IMPACT.y, 0.25, clock), 0.85);
}

// The rebound drop bursts and the leaderboard rides out of it onto the leaf.
function popCard(top) {
  const at = toScreen(top.ax, top.ay);
  const w = card.offsetWidth, h = card.offsetHeight;
  Object.assign(cardState, { x: at.x, y: at.y + h / 2, s: 0.05, rot: 0, o: 1, onLeaf: false });
  gsap.to(top, { ra: 11, alpha: 0, duration: 0.25, ease: 'power1.out' });
  const seat = () => {
    const b = bendDisp(LEAF_SEAT.x, LEAF_SEAT.y, leafBend(clock));
    return toScreen(LEAF_SEAT.x + b.x, LEAF_SEAT.y + b.y);
  };
  const path = { k: 0 };
  const from = { x: cardState.x, y: cardState.y };
  gsap.timeline()
    .to(cardState, { s: 0.42, duration: 0.35, ease: 'back.out(2.2)' }, 0)
    .to(path, {
      k: 1, duration: 1.05, ease: 'power2.inOut',
      onUpdate() {
        const to = seat();
        const k = path.k;
        cardState.x = from.x + (to.x - from.x) * k;
        cardState.y = from.y + (to.y - from.y) * k - Math.sin(Math.PI * k) * 0.22 * innerHeight;  // arc
        cardState.s = 0.42 + 0.58 * k;
        cardState.rot = -8 * Math.sin(Math.PI * k) + 14 * k * k;
      },
    }, 0.2)
    .add(() => {
      cardState.onLeaf = true;
      phase = 'leaf';
      // The leaf takes the weight.
      gsap.to(lake, { bend: 1, duration: 1.5, ease: 'elastic.out(1, 0.42)' });
      gsap.to(lake, { sway: 0.35, duration: 1 });
      growTipDrop();
    }, 1.25);
}

// A drop gathers at the leaf tip; dropping it raises the leaderboard.
const tip = { grow: 0, fall: 0, released: false };
function tipAnchor() {
  const b = bendDisp(LEAF_TIP.x, LEAF_TIP.y, leafBend(clock));
  return { x: LEAF_TIP.x + b.x, y: LEAF_TIP.y + b.y };
}
function growTipDrop() {
  Object.assign(tip, { grow: 0, fall: 0, released: false });
  gsap.to(tip, {
    grow: 1, duration: 1.8, delay: 0.7, ease: 'power1.inOut',
    onComplete: () => {
      dropHit.classList.add('ready');
      dropHit.focus({ preventScroll: true });
      autoDrop = setTimeout(releaseTipDrop, 8000);
    },
  });
}
function updateTipDrop() {
  const d = lake.drops[10];
  if (phase !== 'leaf' && !tip.released) {
    d.alpha = 0;
    return;
  }
  const a = tipAnchor();
  const ra = 4 + 10.5 * tip.grow;
  if (!tip.released) {
    Object.assign(d, { bx: a.x, by: a.y - 2, rb: 2.2, ax: a.x - 0.5, ay: a.y + 5 + 12 * tip.grow, ra, alpha: tip.grow > 0.02 ? 1 : 0 });
    const s = toScreen(d.ax, d.ay);
    dropHit.style.transform = `translate(${s.x}px, ${s.y}px)`;
  }
}
function releaseTipDrop() {
  if (tip.released || phase !== 'leaf') return;
  clearTimeout(autoDrop);
  tip.released = true;
  dropHit.classList.remove('ready');
  const d = lake.drops[10];
  const startY = d.ay, x = d.ax;
  const fall = { k: 0 };
  // The leaf, relieved of the drop, springs back; the leaderboard lifts off it and rises.
  gsap.to(lake, { bend: 0.25, duration: 1.4, ease: 'elastic.out(1.1, 0.35)' });
  riseBoard();
  gsap.to(fall, {
    k: 1, duration: 0.6, ease: 'power2.in',
    onUpdate() {
      d.ay = startY + (IMPACT.y - 4 - startY) * fall.k;
      d.ax = x + (IMPACT.x - x) * fall.k;
      d.by = d.ay - d.ra * (1.0 + 0.8 * fall.k);
      d.bx = d.ax;
      d.rb = 2;
    },
    onComplete() {
      d.alpha = 0;
      pushRipple(IMPACT.x, IMPACT.y, 0.7, clock);
      pushRipple(IMPACT.x, IMPACT.y, 0.35, clock + 0.4);
    },
  });
}

function riseBoard() {
  phase = 'board';
  cardState.onLeaf = false;
  const board = $('#board');
  board.hidden = false;
  const r = board.getBoundingClientRect();
  gsap.set(board, { opacity: 0 });
  gsap.timeline()
    .to(cardState, { x: r.left + r.width / 2, y: r.top + r.height / 2 + card.offsetHeight / 2, rot: 0, s: r.width / card.offsetWidth, duration: 0.9, ease: 'power3.inOut' }, 0.15)
    .to(cardState, { o: 0, duration: 0.35 }, 0.8)
    .to(board, { opacity: 1, duration: 0.5 }, 0.75)
    .from('#podium article, #rows li', { opacity: 0, y: 14, stagger: 0.05, duration: 0.4 }, 0.95)
    .to(lake, { dim: 1, sway: 0.15, duration: 1.2 }, 0.3)
    .add(() => {
      $('#skip').hidden = true;
      $('#back').focus({ preventScroll: true });
    });
}

// Jump straight to the board (Skip, reduced motion, or a second visit).
function finishToBoard(still) {
  if (tl) tl.kill();
  gsap.killTweensOf([view, lake, cardState, tip, overlayState, earthMat.uniforms.uMorph]);
  clearTimeout(autoDrop);
  phase = 'board';
  layoutLake();
  resetDrops();
  Object.assign(lake, { pan: 1, bend: 0, dim: 1, sway: still ? 0 : 0.15 });
  gsap.set(sky, { yPercent: -100, opacity: 0.2 });
  gsap.set(hero, { opacity: 0 });
  gsap.set(globeCanvas, { opacity: 0 });
  overlayState.opacity = 0;
  cardState.o = 0;
  document.body.classList.add('in-lake');
  dropHit.classList.remove('ready');
  $('#skip').hidden = true;
  const board = $('#board');
  board.hidden = false;
  gsap.fromTo(board, { opacity: 0 }, { opacity: 1, duration: still ? 0 : 0.4 });
}

// Back to the globe: the lake sinks away and the drop becomes the Earth again.
function backToGlobe() {
  if (phase !== 'board') return;
  phase = 'outro';
  const hv = heroView();
  gsap.to('#board', { opacity: 0, duration: 0.3, onComplete: () => ($('#board').hidden = true) });
  resetDrops();
  tip.released = false;
  document.body.classList.remove('in-lake');
  gsap.timeline({ onComplete: () => { phase = 'hero'; lake.rips = []; } })
    .to(lake, { dim: 0, bend: 0, sway: 1, duration: 0.4 }, 0)
    .to(lake, { pan: 0, duration: reduceMotion ? 0 : 1.3, ease: 'power2.inOut' }, 0.2)
    .to(sky, { yPercent: 0, opacity: 1, duration: reduceMotion ? 0 : 1.3, ease: 'power2.inOut' }, 0.2)
    .to(globeCanvas, { opacity: 1, duration: 0.4 }, 0.6)
    .to(view, { ...hv, spinSpeed: 0, duration: reduceMotion ? 0 : 1.6, ease: 'power3.inOut' }, 0.6)
    .to(view, { angle: Math.ceil(view.angle / (2 * Math.PI) + 0.25) * 2 * Math.PI, duration: reduceMotion ? 0 : 2.2, ease: 'power3.out' }, 0.6)
    .set(view, { spinSpeed: 0.045 }, 2.8)
    .to(earthMat.uniforms.uMorph, { value: 0, duration: reduceMotion ? 0 : 1.0 }, 0.7)
    .to(tilt.rotation, { x: 0.1, duration: 1.2 }, 0.7)
    .to(glowMat.uniforms.uFade, { value: 1, duration: 0.8 }, 1.2)
    .to(overlayState, { opacity: 1, duration: 0.6 }, 1.8)
    .to(hero, { opacity: 1, y: 0, duration: 0.7 }, 1.7);
}

// ===========================================================================
// Loop, sizing, events
// ===========================================================================

function resize() {
  const W = innerWidth, H = innerHeight, dpr = DPR();
  gRenderer.setPixelRatio(dpr);
  gRenderer.setSize(W, H, false);
  lRenderer.setPixelRatio(dpr);
  lRenderer.setSize(W, H, false);
  if (phase === 'hero') Object.assign(view, heroView());
  layoutLake();
}

let lastT = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;
  clock += dt;
  view.angle += view.spinSpeed * dt;
  spin.rotation.y = view.angle;
  earthMat.uniforms.uTime.value = clock;
  for (const s of spots) {
    const k = 0.034 + 0.008 * Math.sin(clock * 2.2 + s.userData.phase);
    s.scale.set(k, k, k);
    s.material.opacity = overlayState.opacity;
  }
  routeMat.opacity = 0.42 * overlayState.opacity;

  if (Number(getComputedStyle(globeCanvas).opacity) > 0.01) {
    layoutGlobe();
    gRenderer.render(gScene, gCamera);
    updateOverlays(clock);
  }
  if (lake.pan > 0.001 || phase !== 'hero') {
    updateTipDrop();
    syncLakeUniforms(clock);
    lRenderer.render(lScene, lCamera);
    lakeCanvas.style.visibility = 'visible';
  } else {
    lakeCanvas.style.visibility = 'hidden';
  }
  if (cardState.onLeaf) {
    const b = leafBend(clock);
    const d = bendDisp(LEAF_SEAT.x, LEAF_SEAT.y, b);
    const s = toScreen(LEAF_SEAT.x + d.x, LEAF_SEAT.y + d.y);
    cardState.x = s.x;
    cardState.y = s.y;
    cardState.rot = 14 + 9 * b;    // follow the slope of the leaf
  }
  card.style.opacity = cardState.o;
  card.style.transform = `translate(${cardState.x - card.offsetWidth / 2}px, ${cardState.y - card.offsetHeight}px) rotate(${cardState.rot}deg) scale(${cardState.s})`;
  requestAnimationFrame(frame);
}

addEventListener('resize', resize);
$('#nav-leaderboard').onclick = () => (phase === 'board' ? null : playLeaderboard());
$('#teaser').onclick = playLeaderboard;
$('#skip').onclick = () => finishToBoard(false);
$('#back').onclick = backToGlobe;
dropHit.onclick = releaseTipDrop;
document.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => {
  renderBoard(b.dataset.period);
  gsap.from('#podium article, #rows li', { opacity: 0, y: 10, stagger: 0.04, duration: 0.3 });
}));
$('#nav-how').onclick = () => ($('#how').hidden = false);
$('#how-close').onclick = () => ($('#how').hidden = true);
$('#how').onclick = (e) => { if (e.target.id === 'how') $('#how').hidden = true; };
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('#how').hidden) $('#how').hidden = true;
    else if (phase === 'board') backToGlobe();
  }
});
// Scrolling down from the hero plays the sequence too.
let wheelSum = 0;
addEventListener('wheel', (e) => {
  if (phase !== 'hero' || !$('#how').hidden) return;
  wheelSum = Math.max(0, wheelSum + e.deltaY);
  if (wheelSum > 120) {
    wheelSum = 0;
    playLeaderboard();
  }
}, { passive: true });
let touchY = null;
addEventListener('touchstart', (e) => (touchY = e.touches[0].clientY), { passive: true });
addEventListener('touchend', (e) => {
  if (touchY !== null && phase === 'hero' && touchY - e.changedTouches[0].clientY > 80) playLeaderboard();
  touchY = null;
});

renderMini();
tilt.rotation.x = 0.1;
resize();
if (location.hash === '#leaderboard') finishToBoard(true);
requestAnimationFrame(frame);

