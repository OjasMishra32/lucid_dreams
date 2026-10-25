// The headset: a real Meta Quest 3S model ("Quest 3S with controllers" by OG_MATTER on Sketchfab, CC BY 4.0; trimmed
// to the headset in public/media/quest-3s.glb), lit like a studio product shot and taken through five scroll beats:
// its parts fly in and lock together under a blue scan line; a slow turn with a light sweeping the shell; an exploded
// view (front cover forward, lens panel back, strap up and away); the inside, lenses lit; then the camera pulls back
// as each eye's frustum beams out and a real person (a Gaussian splat frame) scans in, life size, where they land.
// Client only.
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { SparkRenderer, type SplatMesh } from "@sparkjsdev/spark";
import { loadSplat, makeUniforms } from "./story";

type V3 = THREE.Vector3;
const v3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

// Metres. The front faces +Z; the wearer's eyes are behind it, at -Z.
const W = 0.191; // the 3S visor across: the model is scaled to it
const FRONT_Z = 0.022; // where its front face sits
const IPD = 0.063; // 3S lenses sit at 58, 63 or 68 mm
const ACCENT = 0x2997ff;
// each eye sees 96 x 90 degrees, canted outward like a real headset (wider on the outer side, below the eye)
const FOV = { out: 52, in: 44, up: 43, down: 47 };
const EYE_HEIGHT = 1.6; // the headset is worn at eye height: the floor is this far below it
const PERSON_Z = 2.1; // the person stands this far in front of your eyes
const REACH = PERSON_Z; // the frusta reach them

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

// where each part goes in the exploded view (model space, metres): the front cover forward, the lens panel back,
// the strap up and back, the button out to the side; anything else straight out from the centre
const EXPLODE: [RegExp, [number, number, number]][] = [
  [/^Object_34/, [0, 0.01, 0.11]],
  [/^Object_12/, [0, 0.005, 0.075]],
  [/^Object_10/, [0, 0, 0.035]],
  [/^Object_32/, [0, -0.01, -0.09]],
  [/^Object_(14|28)/, [0, 0.03, -0.14]],
  [/^Object_30/, [0, 0.12, -0.06]],
  [/^Object_54/, [0.08, 0, 0]],
];

export interface HeadsetHooks {
  progress: () => number;
  failed: () => void;
  person?: string | null; // one .spz frame: who the eyes see at the end
}

export async function mountHeadset(host: HTMLElement, hooks: HeadsetHooks): Promise<() => void> {
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
  renderer.localClippingEnabled = true; // the scan line is a clipped band of edges
  renderer.domElement.className = "headset-gl";
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(22, 1, 0.01, 40);

  // studio light: the room's reflections plus a soft key that sweeps across the shell and a cool rim
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const env = pmrem.fromScene(room, 0.035).texture;
  room.dispose();
  pmrem.dispose();
  scene.environment = env;
  scene.environmentIntensity = 0.6;
  const aim = new THREE.Object3D();
  aim.position.set(0, -0.005, -0.06);
  scene.add(aim);
  const key = new THREE.SpotLight(0xfff5ea, 1.8, 0, rad(40), 1, 2);
  key.target = aim;
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.radius = 6;
  key.shadow.bias = -0.0002;
  key.shadow.normalBias = 0.0012;
  key.shadow.camera.near = 0.3;
  key.shadow.camera.far = 1.6;
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

  // each part: where it rests, which way it explodes (as a local offset per metre of travel), how it tumbles in
  const scanLo = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const scanHi = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
  const edgeMat = new THREE.LineBasicMaterial({
    color: ACCENT,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    clippingPlanes: [scanLo, scanHi],
  });
  const parts: { mesh: THREE.Mesh; rest: V3; restQ: THREE.Quaternion; step: V3; axis: V3; spin: number; delay: number }[] = [];
  const meshes: THREE.Mesh[] = [];
  quest.traverse((o) => {
    if (o instanceof THREE.Mesh) meshes.push(o);
  });
  const centre = new THREE.Box3().setFromObject(quest).getCenter(v3());
  meshes.forEach((o, i) => {
    o.castShadow = true;
    o.receiveShadow = true;
    if (/^Object_(14|28|30)/.test(o.name)) o.userData.strap = true;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (m instanceof THREE.MeshStandardMaterial) m.envMapIntensity = 1.1;
    }
    const wp = new THREE.Box3().setFromObject(o).getCenter(v3());
    const dir = EXPLODE.find(([re]) => re.test(o.name))?.[1];
    const d = dir ? v3(...dir) : wp.clone().sub(centre).normalize().multiplyScalar(0.06);
    // a world offset d, expressed in the mesh's parent's local space (the glTF tree carries scale and rotation)
    const parent = o.parent!;
    const a = parent.worldToLocal(wp.clone());
    const b = parent.worldToLocal(wp.clone().add(d));
    const seed = Math.sin((i + 1) * 12.9898) * 43758.5453;
    const r = seed - Math.floor(seed);
    parts.push({
      mesh: o,
      rest: o.position.clone(),
      restQ: o.quaternion.clone(),
      step: b.sub(a),
      axis: v3(Math.sin(i * 2.1), Math.cos(i * 1.3), Math.sin(i * 0.7)).normalize(),
      spin: 1.4 + r * 1.6,
      delay: r * 0.05,
    });
    // its edges, for the scan line
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(o.geometry, 28), edgeMat);
    edges.renderOrder = 4;
    o.add(edges);
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
  const top = new THREE.Box3().setFromObject(quest).max.y;
  const bottom = new THREE.Box3().setFromObject(quest).min.y;

  // ---- the eye frusta, out to where the person stands ----
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
  const lineMats = [lineMat(1.5, 0.7, false), lineMat(7, 0.1, false), lineMat(1.2, 0.16, true), lineMat(5, 0.03, true)];
  const lineBase = lineMats.map((m) => m.opacity);
  for (const m of lineMats) {
    const l = new LineSegments2(lineGeo, m);
    l.frustumCulled = false;
    l.renderOrder = 2;
    frusta.add(l);
  }
  // each eye's image plane: a faint glass rectangle with a fine grid, where the person stands
  const planeTex = keep(
    canvasTex((g, n) => {
      g.fillStyle = "rgba(255,255,255,0.18)";
      g.fillRect(0, 0, n, n);
      g.strokeStyle = "rgba(255,255,255,0.3)";
      g.lineWidth = 1;
      for (let i = 1; i < 10; i++) {
        const t = Math.round((i / 10) * n) + 0.5;
        g.beginPath();
        g.moveTo(t, 0);
        g.lineTo(t, n);
        g.moveTo(0, t);
        g.lineTo(n, t);
        g.stroke();
      }
      const r = g.createRadialGradient(n / 2, n / 2, n * 0.1, n / 2, n / 2, n * 0.72);
      r.addColorStop(0, "rgba(0,0,0,0.6)");
      r.addColorStop(1, "rgba(0,0,0,0)");
      g.globalCompositeOperation = "destination-out";
      g.fillStyle = r;
      g.fillRect(0, 0, n, n);
    }, 512),
  );
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
  for (const cs of corners) {
    const g = new THREE.BufferGeometry().setFromPoints([cs[3], cs[2], cs[1], cs[0]]);
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    const m = new THREE.Mesh(g, planeMat);
    m.renderOrder = 1;
    frusta.add(m);
  }
  // a glow at each eye point, and one in each lens as they light up
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
  const lensGlowMat = glowMat.clone();
  for (const e of eyes) {
    const s = new THREE.Sprite(glowMat);
    s.position.copy(e);
    s.scale.setScalar(0.014);
    s.renderOrder = 3;
    frusta.add(s);
    const l = new THREE.Sprite(lensGlowMat);
    l.position.copy(e).add(v3(0, 0, 0.022));
    l.scale.setScalar(0.05);
    l.renderOrder = 3;
    model.add(l);
  }
  frusta.visible = false;

  // ---- who the eyes see: a real person, scanned in where the frusta land ----
  const spark = new SparkRenderer({ renderer });
  scene.add(spark);
  const person = new THREE.Group();
  person.position.set(0, -EYE_HEIGHT, eyes[0].z + PERSON_Z);
  model.add(person);
  const pu = makeUniforms();
  pu.lo.value = -0.3;
  pu.hi.value = -0.3;
  pu.glow.value = 1;
  let splat: SplatMesh | null = null;
  let splatLoading = false;
  let gone = false;
  const loadPerson = () => {
    if (splat || splatLoading || !hooks.person) return;
    splatLoading = true;
    loadSplat(hooks.person, pu)
      .then((m) => {
        if (gone) return m.dispose?.();
        person.add(m);
        splat = m;
      })
      .catch(() => {
        // no person: the frusta still draw
      });
  };
  const personPts = [v3(-0.35, -EYE_HEIGHT, person.position.z - 0.25), v3(0.35, -EYE_HEIGHT + 1.75, person.position.z + 0.25)];
  // a soft pool of light on the floor under them
  const poolTex = keep(
    canvasTex((g, n) => {
      const r = g.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
      r.addColorStop(0, "rgba(41,151,255,0.45)");
      r.addColorStop(1, "rgba(41,151,255,0)");
      g.fillStyle = r;
      g.fillRect(0, 0, n, n);
    }, 128),
  );
  const poolMat = new THREE.MeshBasicMaterial({ map: poolTex, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
  const pool = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.6), poolMat);
  pool.rotation.x = -Math.PI / 2;
  pool.position.y = 0.003;
  person.add(pool);

  const _a = v3();
  const _b = v3();
  const writeSegs = (g1: number, g2: number) => {
    let n = 0;
    const put = (a: V3, b: V3) => {
      segs[n++] = a.x;
      segs[n++] = a.y;
      segs[n++] = a.z;
      segs[n++] = b.x;
      segs[n++] = b.y;
      segs[n++] = b.z;
    };
    eyes.forEach((e, i) => {
      const cs = corners[i];
      for (let j = 0; j < 4; j++) put(e, _a.copy(cs[j]).sub(e).multiplyScalar(Math.max(g1, 1e-4)).add(e));
      for (let j = 0; j < 4; j++) {
        _b.copy(cs[(j + 1) % 4]).sub(cs[j]);
        put(cs[j], _a.copy(cs[j]).addScaledVector(_b, Math.max(g2, 1e-4)));
      }
    });
    const iab = lineGeo.getAttribute("instanceStart") as THREE.InterleavedBufferAttribute;
    iab.data.array.set(segs);
    iab.data.needsUpdate = true;
  };

  // points to frame: the headset, the visor alone (for the inside view), and the headset with the person at the end
  model.updateMatrixWorld(true);
  const headPts: V3[] = [];
  const visorPts: V3[] = [];
  for (const o of meshes) {
    const p = o.geometry.getAttribute("position") as THREE.BufferAttribute;
    const step = Math.max(1, Math.floor(p.count / 160));
    for (let i = 0; i < p.count; i += step) {
      const q = v3().fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld);
      headPts.push(q);
      if (!o.userData.strap) visorPts.push(q);
    }
  }
  // the exploded view needs room for the parts in flight
  const explodedPts = [...headPts, v3(0, 0, 0.14), v3(0, 0.14, -0.1), v3(0, 0, -0.2), v3(0.12, 0, 0), v3(-0.12, 0, 0)];
  const finalPts = [...headPts, ...personPts];

  // camera keyframes: [progress, azimuth from the front (deg), elevation (deg)]
  const KEYS: [number, number, number][] = [
    [0, 28, 20],
    [0.2, 38, 16],
    [0.34, 64, 12],
    [0.48, 112, 22],
    [0.62, 128, 18],
    [0.74, 186, 10],
    [0.86, 200, 9],
    [1, 206, 11],
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
  const camE = v3();
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
  let onScreen = true; // until the observer says otherwise (a hidden page, like the film's renderer, may never report)
  let snap = true;
  const io = new IntersectionObserver(
    ([e]) => {
      // coming back into view (from either side), start from where the scroll is, not where we left off
      if (e.isIntersecting && !onScreen) snap = true;
      onScreen = e.isIntersecting;
      if (e.isIntersecting) loadPerson();
    },
    { rootMargin: "30% 0px" },
  );
  io.observe(host);
  loadPerson();

  let shown = 1;
  let last = performance.now();
  const t0 = last;
  const ld = v3();
  const tq = new THREE.Quaternion();
  const frame = () => {
    resize();
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (!onScreen || !w || !h || (still && !dirty && splat)) return;
    dirty = false;
    // scroll is stepped; follow it with a short ease so nothing jumps
    const target = clamp(hooks.progress(), 0, 1);
    if (still) shown = 1;
    else if (snap) shown = target;
    else shown += (target - shown) * (1 - Math.exp(-dt * 6));
    snap = false;
    const p = shown;
    const time = (now - t0) / 1000;

    // the parts: flying in and locking together, then the exploded view and back
    const fly = still ? 0 : 1 - smooth(0.0, 0.17, p);
    const burst = smooth(0.36, 0.45, p) - smooth(0.56, 0.63, p);
    for (const part of parts) {
      const f = still ? 0 : 1 - smooth(part.delay, 0.15 + part.delay, p);
      const out = f * f * 5 + burst;
      part.mesh.position.copy(part.rest).addScaledVector(part.step, out);
      tq.setFromAxisAngle(part.axis, f * part.spin);
      part.mesh.quaternion.copy(part.restQ).multiply(tq);
    }
    // the scan line: a band of blue edges sweeping down as it assembles, and the whole wireframe while it's apart
    const sweep = smooth(0.03, 0.2, p);
    const band = lerpN(top + 0.02, bottom - 0.02, sweep);
    const scanOn = (1 - smooth(0.17, 0.22, p)) * (fly < 1 ? 1 : 0);
    const wire = burst;
    if (wire > 0.02) {
      scanLo.constant = 10;
      scanHi.constant = 10;
    } else {
      scanLo.constant = -(band - 0.012); // keeps y >= band - 12 mm
      scanHi.constant = band + 0.012; // keeps y <= band + 12 mm
    }
    edgeMat.opacity = still ? 0 : Math.max(scanOn * 0.95, wire * 0.45);

    // reduced motion holds the end: the inside view, the frusta and the person
    const [az, el] = still ? [204, 11] : view(p);
    const a = rad(az);
    const e = rad(el);
    back.set(Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e));
    F.copy(back).negate();
    R.crossVectors(F, THREE.Object3D.DEFAULT_UP).normalize();
    U.crossVectors(R, F);
    const tv = Math.tan(rad(camera.fov / 2));
    const th = tv * camera.aspect;
    const portrait = camera.aspect < 0.9;
    fit(headPts, th * (portrait ? 0.84 : 0.58), tv * (portrait ? 0.5 : 0.6), camA);
    fit(explodedPts, th * (portrait ? 0.9 : 0.7), tv * (portrait ? 0.56 : 0.7), camE);
    fit(visorPts, th * (portrait ? 0.72 : 0.56), tv * (portrait ? 0.4 : 0.56), camV);
    fit(finalPts, th * (portrait ? 0.9 : 0.84), tv * (portrait ? 0.7 : 0.84), camB);
    camA.lerp(camE, burst);
    camA.lerp(camV, smooth(0.63, 0.74, p));
    camera.position.lerpVectors(camA, camB, still ? 1 : smooth(0.76, 0.95, p));
    camera.quaternion.setFromRotationMatrix(basis.makeBasis(R, U, back));

    // the lights turn with the camera (a turntable under studio lights), and the key sweeps across the shell once
    scene.environmentRotation.set(0, a + rad(150), 0);
    const swing = still ? 0 : Math.sin(smooth(0.18, 0.4, p) * Math.PI) * 0.9;
    key.position.copy(aim.position).addScaledVector(lightDir(-0.42 + swing, 1, 0.42, ld), 0.75);
    rim.position.copy(aim.position).addScaledVector(lightDir(0.65, 0.55, -0.85, ld), 0.7);

    // the faintest float, so it reads as an object in the air rather than a picture
    rig.rotation.y = still ? 0 : Math.sin(time * 0.38) * 0.012;
    rig.position.y = still ? 0 : Math.sin(time * 0.62) * 0.0011;

    // the lenses light up, then each eye's frustum beams out to the person, who scans in where it lands
    lensGlowMat.opacity = (still ? 1 : smooth(0.66, 0.74, p)) * (0.55 + 0.15 * Math.sin(time * 2.2));
    const g1 = still ? 1 : smooth(0.74, 0.84, p);
    const g2 = still ? 1 : smooth(0.8, 0.9, p);
    writeSegs(g1, g2);
    frusta.visible = g1 > 0.001;
    if (frusta.visible) {
      const fade = Math.min(1, g1 * 5);
      lineMats.forEach((m, i) => (m.opacity = lineBase[i] * fade));
      planeMat.opacity = 0.22 * g2;
      glowMat.opacity = g1;
    }
    const scan = still ? 1 : smooth(0.8, 0.97, p);
    pu.hi.value = -0.1 + scan * 2.0;
    poolMat.opacity = 0.9 * scan;
    if (splat) {
      splat.visible = scan > 0.001;
      splat.updateVersion();
    }
    renderer.render(scene, camera);
  };
  renderer.setAnimationLoop(frame);

  return () => {
    gone = true;
    renderer.setAnimationLoop(null);
    io.disconnect();
    const mats = new Set<THREE.Material>();
    scene.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Sprite || o instanceof THREE.LineSegments) {
        o.geometry.dispose();
        (Array.isArray(o.material) ? o.material : [o.material]).forEach((m: THREE.Material) => mats.add(m));
      }
    });
    splat?.dispose?.();
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

function lerpN(a: number, b: number, t: number) {
  return a + (b - a) * t;
}
