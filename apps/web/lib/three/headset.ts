// The headset: a real Meta Quest 3S model ("Quest 3S with controllers" by OG_MATTER on Sketchfab, CC BY 4.0; trimmed
// to the headset in public/media/quest-3s.glb), lit like a studio product shot. Scroll turns it from a front
// three-quarter to the side to the inside, then the two eye frusta draw out of the lenses into the room. Client only.
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";

type V3 = THREE.Vector3;
const v3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

// Metres. The front faces +Z; the wearer's eyes are behind it, at -Z.
const W = 0.191; // the 3S visor across: the model is scaled to it
const FRONT_Z = 0.022; // where its front face sits
const IPD = 0.063; // 3S lenses sit at 58, 63 or 68 mm
const ACCENT = 0x2997ff;
// each eye sees 96 x 90 degrees, canted outward like a real headset (wider on the outer side, below the eye)
const FOV = { out: 52, in: 44, up: 43, down: 47 };
const REACH = 0.5; // how far the frusta go into the room

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
};
const rad = THREE.MathUtils.degToRad;

function canvasTex(draw: (g: CanvasRenderingContext2D, n: number) => void, n = 256): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = n;
  draw(c.getContext("2d")!, n);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export async function mountHeadset(host: HTMLElement, hooks: { progress: () => number; failed: () => void }): Promise<() => void> {
  let ok = false;
  try {
    ok = !!document.createElement("canvas").getContext("webgl2");
  } catch {
    ok = false;
  }
  if (!ok) {
    hooks.failed();
    return () => {};
  }
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
  } catch {
    hooks.failed();
    return () => {};
  }
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.domElement.className = "headset-gl";
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(22, 1, 0.01, 30);

  // studio light: the room's reflections plus a soft key and a cool rim that separates the dark parts from black
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const env = pmrem.fromScene(room, 0.035).texture;
  room.dispose();
  pmrem.dispose();
  scene.environment = env;
  scene.environmentIntensity = 0.6;
  const aim = new THREE.Object3D();
  aim.position.set(0, -0.005, -0.1);
  scene.add(aim);
  // a big soft spot close in: its falloff puts a gentle gradient across the broad white faces
  const key = new THREE.SpotLight(0xfff5ea, 1.7, 0, rad(40), 1, 2);
  key.target = aim;
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.radius = 6;
  key.shadow.bias = -0.0002;
  key.shadow.normalBias = 0.0012;
  key.shadow.camera.near = 0.3;
  key.shadow.camera.far = 1.4;
  const rim = new THREE.DirectionalLight(0xe4ecff, 2.2);
  rim.target = aim;
  scene.add(key, rim);

  const textures: THREE.Texture[] = [];
  const keep = <T extends THREE.Texture>(t: T) => (textures.push(t), t);

  const rig = new THREE.Group(); // idle float
  scene.add(rig);
  const model = new THREE.Group();
  rig.add(model);

  // the real headset: scaled so its front cover is 191 mm across, that cover centred on the axis, its face at FRONT_Z
  let gltf: Awaited<ReturnType<GLTFLoader["loadAsync"]>>;
  try {
    gltf = await new GLTFLoader().loadAsync("/media/quest-3s.glb");
  } catch {
    hooks.failed();
    renderer.dispose();
    renderer.domElement.remove();
    return () => {};
  }
  const quest = gltf.scene;
  quest.updateMatrixWorld(true);
  const byName = (re: RegExp) => {
    let hit: THREE.Object3D | null = null;
    quest.traverse((o) => {
      if (!hit && o instanceof THREE.Mesh && re.test(o.name)) hit = o;
    });
    return hit as THREE.Object3D | null;
  };
  const cover = byName(/^Object_34/) ?? quest;
  const coverBox = new THREE.Box3().setFromObject(cover);
  const k = W / Math.max(1e-6, coverBox.max.x - coverBox.min.x);
  const c = coverBox.getCenter(v3());
  quest.scale.setScalar(k);
  quest.position.set(-c.x * k, -c.y * k, FRONT_Z - coverBox.max.z * k);
  model.add(quest);
  model.updateMatrixWorld(true);
  quest.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    o.castShadow = true;
    o.receiveShadow = true;
    // the strap's three parts: framed with the headset, left out when the camera frames the visor alone
    if (/^Object_(14|28|30)/.test(o.name)) o.userData.strap = true;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (m instanceof THREE.MeshStandardMaterial) m.envMapIntensity = 1.1;
    }
  });

  // the eyes: 63 mm apart, centred on the lens panel, 2 cm behind it (eye relief)
  const eyes: V3[] = [];
  {
    const panel = byName(/^Object_32/);
    const b = panel ? new THREE.Box3().setFromObject(panel) : new THREE.Box3(v3(-0.06, -0.025, -0.04), v3(0.06, 0.03, -0.035));
    const y = (b.min.y + b.max.y) / 2;
    const z = b.min.z - 0.02;
    for (const side of [1, -1]) eyes.push(v3((side * IPD) / 2, y, z));
  }

  // ---- the eye frusta ----
  const corners = eyes.map((e, i) => {
    const side = i === 0 ? 1 : -1;
    const xo = e.x + side * Math.tan(rad(FOV.out)) * REACH;
    const xi = e.x - side * Math.tan(rad(FOV.in)) * REACH;
    const yt = e.y + Math.tan(rad(FOV.up)) * REACH;
    const yb = e.y - Math.tan(rad(FOV.down)) * REACH;
    const z = e.z + REACH;
    return [v3(xo, yt, z), v3(xi, yt, z), v3(xi, yb, z), v3(xo, yb, z)];
  });
  const frusta = new THREE.Group();
  model.add(frusta);
  const segCount = 16;
  const segs = new Float32Array(segCount * 6);
  const lineGeo = new LineSegmentsGeometry();
  lineGeo.setPositions(segs);
  const lineMat = (width: number, opacity: number, hidden: boolean) =>
    new LineMaterial({
      color: ACCENT,
      linewidth: width,
      transparent: true,
      opacity,
      depthWrite: false,
      depthFunc: hidden ? THREE.GreaterDepth : THREE.LessEqualDepth,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
  // a bright core and a soft halo where the lines are in the open; a faint trace where they pass through the visor
  const lineMats = [lineMat(1.5, 0.62, false), lineMat(6, 0.09, false), lineMat(1.2, 0.16, true), lineMat(5, 0.03, true)];
  const lineBase = lineMats.map((m) => m.opacity);
  for (const m of lineMats) {
    const l = new LineSegments2(lineGeo, m);
    l.frustumCulled = false;
    l.renderOrder = 2;
    frusta.add(l);
  }
  // the per-eye image plane: a faint glass rectangle with a fine grid
  const planeTex = canvasTex((g, n) => {
    g.fillStyle = "rgba(255,255,255,0.22)";
    g.fillRect(0, 0, n, n);
    g.strokeStyle = "rgba(255,255,255,0.32)";
    g.lineWidth = 1;
    for (let i = 1; i < 8; i++) {
      const t = Math.round((i / 8) * n) + 0.5;
      g.beginPath();
      g.moveTo(t, 0);
      g.lineTo(t, n);
      g.moveTo(0, t);
      g.lineTo(n, t);
      g.stroke();
    }
    const r = g.createRadialGradient(n / 2, n / 2, n * 0.1, n / 2, n / 2, n * 0.72);
    r.addColorStop(0, "rgba(0,0,0,0.55)");
    r.addColorStop(1, "rgba(0,0,0,0)");
    g.globalCompositeOperation = "destination-out";
    g.fillStyle = r;
    g.fillRect(0, 0, n, n);
  }, 512);
  keep(planeTex);
  const planeMat = new THREE.MeshBasicMaterial({
    color: ACCENT,
    map: planeTex,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  for (const c of corners) {
    const g = new THREE.BufferGeometry().setFromPoints([c[3], c[2], c[1], c[0]]);
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    const m = new THREE.Mesh(g, planeMat);
    m.renderOrder = 1;
    frusta.add(m);
  }
  // a small glow at each eye point
  const glowTex = keep(
    canvasTex((g, n) => {
      const r = g.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
      r.addColorStop(0, "rgba(255,255,255,1)");
      r.addColorStop(0.18, "rgba(150,200,255,0.75)");
      r.addColorStop(0.5, "rgba(41,151,255,0.18)");
      r.addColorStop(1, "rgba(41,151,255,0)");
      g.fillStyle = r;
      g.fillRect(0, 0, n, n);
    }, 128),
  );
  const glowMat = new THREE.SpriteMaterial({ map: glowTex, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
  for (const e of eyes) {
    const s = new THREE.Sprite(glowMat);
    s.position.copy(e);
    s.scale.setScalar(0.014);
    s.renderOrder = 3;
    frusta.add(s);
  }
  frusta.visible = false;

  const _a = v3();
  const _b = v3();
  const writeSegs = (p: number) => {
    let k = 0;
    const put = (a: V3, b: V3) => {
      segs[k++] = a.x;
      segs[k++] = a.y;
      segs[k++] = a.z;
      segs[k++] = b.x;
      segs[k++] = b.y;
      segs[k++] = b.z;
    };
    let shown = 0;
    eyes.forEach((e, i) => {
      const lag = i * 0.025;
      const g1 = smooth(0.61 + lag, 0.75 + lag, p);
      const g2 = smooth(0.71 + lag, 0.83 + lag, p);
      shown = Math.max(shown, g1);
      const c = corners[i];
      for (let j = 0; j < 4; j++) put(e, _a.copy(c[j]).sub(e).multiplyScalar(Math.max(g1, 1e-4)).add(e));
      for (let j = 0; j < 4; j++) {
        _b.copy(c[(j + 1) % 4]).sub(c[j]);
        put(c[j], _a.copy(c[j]).addScaledVector(_b, Math.max(g2, 1e-4)));
      }
    });
    const iab = lineGeo.getAttribute("instanceStart") as THREE.InterleavedBufferAttribute;
    iab.data.array.set(segs);
    iab.data.needsUpdate = true;
    return shown;
  };

  // points to frame: the whole headset, the visor alone (for the inside view), and the headset with both frusta
  model.updateMatrixWorld(true);
  const headPts: V3[] = [];
  const visorPts: V3[] = [];
  model.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || frusta.getObjectById(o.id)) return;
    const p = o.geometry.getAttribute("position") as THREE.BufferAttribute;
    const step = Math.max(1, Math.floor(p.count / 160));
    for (let i = 0; i < p.count; i += step) {
      const q = v3().fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld);
      headPts.push(q);
      if (!o.userData.strap) visorPts.push(q);
    }
  });
  const allPts = [...headPts, ...eyes, ...corners.flat()];

  // camera keyframes: [progress, azimuth from the front (deg), elevation (deg)]
  const KEYS: [number, number, number][] = [
    [0, 40, 18],
    [0.3, 48, 15],
    [0.43, 90, 4],
    [0.47, 94, 4],
    [0.6, 180, 24],
    [1, 199, 13],
  ];
  const view = (p: number): [number, number] => {
    let i = 0;
    while (i < KEYS.length - 2 && p > KEYS[i + 1][0]) i++;
    const [p0, a0, e0] = KEYS[i];
    const [p1, a1, e1] = KEYS[i + 1];
    const t = smooth(p0, p1, p);
    return [a0 + (a1 - a0) * t, e0 + (e1 - e0) * t];
  };

  // Place the camera for a fixed orientation so `pts` exactly fill fractions (fx, fy) of the frame: in the camera's
  // own axes each point gives a bound on how close the camera may be; the pan centres the tightest pair.
  const R = v3();
  const U = v3();
  const F = v3();
  const fit = (pts: V3[], kx: number, ky: number, out: V3) => {
    let ax = Infinity;
    let bx = Infinity;
    let ay = Infinity;
    let by = Infinity;
    for (const p of pts) {
      const px = p.dot(R);
      const py = p.dot(U);
      const pz = p.dot(F);
      ax = Math.min(ax, pz - px / kx);
      bx = Math.min(bx, pz + px / kx);
      ay = Math.min(ay, pz - py / ky);
      by = Math.min(by, pz + py / ky);
    }
    const cx = (kx * (bx - ax)) / 2;
    const cy = (ky * (by - ay)) / 2;
    const cz = Math.min((ax + bx) / 2, (ay + by) / 2);
    return out.set(0, 0, 0).addScaledVector(R, cx).addScaledVector(U, cy).addScaledVector(F, cz);
  };
  const camA = v3();
  const camV = v3();
  const camB = v3();
  const back = v3();
  const basis = new THREE.Matrix4();
  const lightDir = (x: number, y: number, z: number, out: V3) =>
    out.set(0, 0, 0).addScaledVector(R, x).addScaledVector(U, y).addScaledVector(back, z).normalize();

  let w = 0;
  let h = 0;
  let dirty = true; // reduced motion draws only when something changed
  const resize = () => {
    if (host.clientWidth === w && host.clientHeight === h) return;
    dirty = true;
    w = host.clientWidth;
    h = host.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
    for (const m of lineMats) m.resolution.set(w, h);
  };
  let onScreen = false;
  let snap = true;
  const io = new IntersectionObserver(
    ([e]) => {
      // coming back into view (from either side), start from where the scroll is, not where we left off
      if (e.isIntersecting && !onScreen) snap = true;
      onScreen = e.isIntersecting;
    },
    { rootMargin: "10% 0px" },
  );
  io.observe(host);

  let shown = 1;
  let last = performance.now();
  const t0 = last;
  const ld = v3();
  const frame = () => {
    resize();
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (!onScreen || !w || !h || (still && !dirty)) return;
    dirty = false;
    // scroll is stepped; follow it with a short ease so nothing jumps
    const target = clamp(hooks.progress(), 0, 1);
    if (still) shown = 1;
    else if (snap) shown = target;
    else shown += (target - shown) * (1 - Math.exp(-dt * 6));
    snap = false;
    const p = shown;
    const time = (now - t0) / 1000;

    // reduced motion holds one rear three-quarter, lenses and frusta both in view
    const [az, el] = still ? [156, 17] : view(p);
    const a = rad(az);
    const e = rad(el);
    back.set(Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e));
    F.copy(back).negate();
    R.crossVectors(F, THREE.Object3D.DEFAULT_UP).normalize();
    U.crossVectors(R, F);
    const tv = Math.tan(rad(camera.fov / 2));
    const th = tv * camera.aspect;
    const portrait = camera.aspect < 0.9;
    fit(headPts, th * (portrait ? 0.84 : 0.6), tv * (portrait ? 0.5 : 0.62), camA);
    fit(visorPts, th * (portrait ? 0.72 : 0.56), tv * (portrait ? 0.4 : 0.56), camV);
    fit(allPts, th * (portrait ? 0.94 : 0.86), tv * (portrait ? 0.62 : 0.8), camB);
    camA.lerp(camV, smooth(0.47, 0.6, p));
    camera.position.lerpVectors(camA, camB, smooth(0.6, 0.88, p));
    camera.quaternion.setFromRotationMatrix(basis.makeBasis(R, U, back));

    // the lights and reflections turn with the camera, like a turntable under fixed studio lights
    scene.environmentRotation.set(0, a + rad(150), 0);
    key.position.copy(aim.position).addScaledVector(lightDir(-0.42, 1, 0.42, ld), 0.75);
    rim.position.copy(aim.position).addScaledVector(lightDir(0.65, 0.55, -0.85, ld), 0.7);

    // the faintest float, so it reads as an object in the air rather than a picture
    rig.rotation.y = still ? 0 : Math.sin(time * 0.38) * 0.012;
    rig.position.y = still ? 0 : Math.sin(time * 0.62) * 0.0011;

    const g = writeSegs(p);
    frusta.visible = g > 0.001;
    if (frusta.visible) {
      const fade = Math.min(1, g * 5);
      lineMats.forEach((m, i) => (m.opacity = lineBase[i] * fade));
      planeMat.opacity = 0.3 * smooth(0.76, 0.9, p);
      glowMat.opacity = smooth(0.61, 0.68, p);
    }
    renderer.render(scene, camera);
  };
  renderer.setAnimationLoop(frame);

  return () => {
    renderer.setAnimationLoop(null);
    io.disconnect();
    const mats = new Set<THREE.Material>();
    scene.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Sprite) {
        o.geometry.dispose();
        (Array.isArray(o.material) ? o.material : [o.material]).forEach((m: THREE.Material) => mats.add(m));
      }
    });
    lineGeo.dispose();
    for (const m of lineMats) m.dispose();
    for (const m of mats) m.dispose();
    for (const t of textures) t.dispose();
    env.dispose();
    key.shadow.map?.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    renderer.domElement.remove();
  };
}
