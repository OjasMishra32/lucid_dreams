// The home page's opening, one WebGL canvas behind five beats of scroll: a real person rebuilt from one video (a
// Gaussian splat frame of a replay bundle, rendered live with Spark) standing like a product shot; turning; ringed by
// 4DAnyone's 48 generated cameras (its own cameras.json: three rings of 16, flying in to where they stood); turned
// round as the Reality check sweeps her into blue wherever no camera really saw her; then at eye level, life size.
// Client only (three.js, Spark). Scroll drives everything through progress().
import * as THREE from "three";
import { dyno, SparkRenderer, SplatMesh } from "@sparkjsdev/spark";

export interface RigCamera {
  id: number;
  ring: number;
  pitch: number;
  yaw: number;
  fy: number;
  w: number;
  h: number;
  c2w: number[][];
}

export interface StoryInput {
  frame: string; // the person: one .spz frame
  reality: string | null; // the same frame, what no camera saw tinted blue (the pipeline's own)
  cameras: RigCamera[];
}

export interface StoryHooks {
  progress: () => number; // 0-1 through the story's scroll track
  loading: (fraction: number) => void;
  ready: (info: { count: number; height: number }) => void;
  failed: () => void;
  hud: (h: { yaw: number; fps: number; cams: number; scan: number }) => void;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const lerp = THREE.MathUtils.lerp;

/**
 * Shader inputs for one splat mesh: a scan band (shown between lo and hi, with a soft bright line at its edges), size,
 * and the exploded view (every Gaussian pushed out from her centre, each by its own share of `explode` metres).
 */
export function makeUniforms() {
  return {
    lo: dyno.dynoFloat(-1),
    hi: dyno.dynoFloat(-1),
    edge: dyno.dynoFloat(0.06),
    glow: dyno.dynoFloat(0.9),
    size: dyno.dynoFloat(1),
    explode: dyno.dynoFloat(0),
  };
}
export type Uniforms = ReturnType<typeof makeUniforms>;

export function modifier(u: Uniforms) {
  return dyno.dynoBlock({ gsplat: dyno.Gsplat }, { gsplat: dyno.Gsplat }, ({ gsplat }) => {
    const d = new dyno.Dyno({
      inTypes: { gsplat: dyno.Gsplat, lo: "float", hi: "float", edge: "float", glow: "float", size: "float", explode: "float" },
      outTypes: { gsplat: dyno.Gsplat },
      statements: ({ inputs: i, outputs: o }) =>
        dyno.unindentLines(`
          ${o.gsplat} = ${i.gsplat};
          float y = ${i.gsplat}.center.y;
          float a = clamp((${i.hi} - y) / ${i.edge}, 0.0, 1.0);
          float b = clamp((y - ${i.lo}) / ${i.edge}, 0.0, 1.0);
          float k = a * b;
          k = k * k * (3.0 - 2.0 * k);
          float rim = 4.0 * k * (1.0 - k);
          ${o.gsplat}.rgba.a *= k;
          ${o.gsplat}.scales *= ${i.size} * mix(0.35, 1.0, k);
          vec3 col = ${o.gsplat}.rgba.rgb;
          col = mix(col, vec3(0.75, 0.9, 1.0), rim * ${i.glow});
          ${o.gsplat}.rgba.rgb = col;
          vec3 c = ${i.gsplat}.center;
          float h = fract(sin(dot(c, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
          vec3 out_ = c - vec3(0.0, 0.9, 0.0);
          out_ = out_ / max(length(out_), 0.05);
          ${o.gsplat}.center = c + out_ * ${i.explode} * (0.25 + 0.75 * h * h);
        `),
    });
    const { lo, hi, edge, glow, size, explode } = u;
    return { gsplat: d.apply({ gsplat, lo, hi, edge, glow, size, explode }).gsplat };
  });
}

export async function loadSplat(url: string, u: Uniforms, onProgress?: (f: number) => void): Promise<SplatMesh> {
  const mesh = new SplatMesh({
    url,
    objectModifier: modifier(u),
    onProgress: (e) => {
      if (onProgress && e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
    },
  });
  await Promise.race([mesh.initialized, new Promise((_, no) => setTimeout(() => no(new Error(`timed out: ${url}`)), 40000))]);
  return mesh;
}

/** A soft shadow under her feet, and (while the cameras are up) the ring they stand on. */
function floor() {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d")!;
  const r = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  r.addColorStop(0, "rgba(0,0,0,0.42)");
  r.addColorStop(0.45, "rgba(0,0,0,0.16)");
  r.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = r;
  g.fillRect(0, 0, 256, 256);
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.8), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.002;
  shadow.renderOrder = -2;
  const ringMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false });
  const ring = new THREE.Mesh(new THREE.RingGeometry(2.735, 2.75, 128), ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.003;
  return { shadow, ring, ringMat };
}

/** 4DAnyone's rig in three.js terms, re-centred on the point all 48 cameras look at, +Y up, the person's front +Z. */
function rigPoses(cams: RigCamera[]) {
  const poses = cams.map((c) => {
    const m = c.c2w;
    const pos = new THREE.Vector3(m[0][3], m[1][3], m[2][3]);
    const x = new THREE.Vector3(m[0][0], m[1][0], m[2][0]);
    const y = new THREE.Vector3(-m[0][1], -m[1][1], -m[2][1]);
    const z = new THREE.Vector3(-m[0][2], -m[1][2], -m[2][2]);
    return { c, pos, x, y, z };
  });
  // the point closest to every optical axis (least squares): sum (I - d d^T) p = sum (I - d d^T) o
  const A = new THREE.Matrix3().set(0, 0, 0, 0, 0, 0, 0, 0, 0);
  const a = new Array(9).fill(0);
  const b = new THREE.Vector3();
  for (const { pos, z } of poses) {
    const d = z.clone().negate();
    const I = [1 - d.x * d.x, -d.x * d.y, -d.x * d.z, -d.y * d.x, 1 - d.y * d.y, -d.y * d.z, -d.z * d.x, -d.z * d.y, 1 - d.z * d.z];
    for (let i = 0; i < 9; i++) a[i] += I[i];
    b.x += I[0] * pos.x + I[1] * pos.y + I[2] * pos.z;
    b.y += I[3] * pos.x + I[4] * pos.y + I[5] * pos.z;
    b.z += I[6] * pos.x + I[7] * pos.y + I[8] * pos.z;
  }
  A.set(a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7], a[8]);
  const focus = b.applyMatrix3(A.clone().invert());
  // the steepest ring sits highest: if not, this world has +Y down
  const ringY = (r: number) => {
    const s = poses.filter((p) => p.c.ring === r);
    return s.reduce((n, p) => n + p.pos.y, 0) / Math.max(1, s.length);
  };
  const steep = Math.max(...poses.map((p) => p.c.ring));
  const flip = ringY(steep) < ringY(0) ? -1 : 1;
  return poses.map((p) => {
    const pos = p.pos.clone().sub(focus);
    pos.y *= flip;
    const fwd = p.z.clone().negate();
    fwd.y *= flip;
    return { ...p, pos, fwd: fwd.normalize() };
  });
}

/** The 48 cameras as wireframe frustums (one draw), each flying in from far out to where it stood, and its ray to her. */
function cameraRig(cams: RigCamera[], centreY: number) {
  const poses = rigPoses(cams);
  const n = poses.length;
  const SEG = 8 + 1; // 4 edges from the lens, 4 round the frame, 1 ray to the person
  const pos = new Float32Array(n * SEG * 2 * 3);
  const col = new Float32Array(n * SEG * 2 * 3);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  const mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
  const lines = new THREE.LineSegments(g, mat);
  lines.frustumCulled = false;
  const rng = (i: number) => {
    const s = Math.sin(i * 12.9898) * 43758.5453;
    return s - Math.floor(s);
  };
  const items = poses.map((p, i) => {
    const D = 0.3;
    const th = (p.c.h / 2 / p.c.fy) * D;
    const tw = th * (p.c.w / p.c.h);
    const right = new THREE.Vector3().crossVectors(p.fwd, new THREE.Vector3(0, 1, 0)).normalize();
    const up = new THREE.Vector3().crossVectors(right, p.fwd).normalize();
    const final = p.pos.clone().add(new THREE.Vector3(0, centreY, 0));
    const away = final.clone().sub(new THREE.Vector3(0, centreY, 0)).normalize();
    const start = final.clone().addScaledVector(away, 6 + rng(i) * 6).add(new THREE.Vector3(0, (rng(i + 7) - 0.3) * 5, 0));
    const col = (p.c.yaw / 360) * 16;
    return { p, D, th, tw, right, up, final, start, delay: p.c.ring * 0.045 + (col / 16) * 0.07 + rng(i + 3) * 0.02 };
  });
  const tmp = new THREE.Vector3();
  const corners = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  /** k: how far in (0 out, 1 home), per camera with its delay; ray: 0-1; spin: the rig turned about the person. */
  const update = (k: number, ray: number, spin: number, heads: THREE.Vector3) => {
    let v = 0;
    const put = (a: THREE.Vector3, b: THREE.Vector3, c: number[]) => {
      pos.set([a.x, a.y, a.z, b.x, b.y, b.z], v * 3);
      col.set([...c, ...c], v * 3);
      v += 2;
    };
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), spin);
    let home = 0;
    for (const it of items) {
      const t = smooth(it.delay, it.delay + 0.55, k);
      if (t > 0.98) home++;
      const o = tmp.lerpVectors(it.start, it.final, t).sub(heads).applyQuaternion(q).add(heads).clone();
      const f = it.p.fwd.clone().applyQuaternion(q);
      const r = it.right.clone().applyQuaternion(q);
      const u = it.up.clone().applyQuaternion(q);
      const c = o.clone().addScaledVector(f, it.D);
      corners[0].copy(c).addScaledVector(r, -it.tw).addScaledVector(u, it.th);
      corners[1].copy(c).addScaledVector(r, it.tw).addScaledVector(u, it.th);
      corners[2].copy(c).addScaledVector(r, it.tw).addScaledVector(u, -it.th);
      corners[3].copy(c).addScaledVector(r, -it.tw).addScaledVector(u, -it.th);
      const bright = 0.25 + 0.75 * t;
      const w = [0.9 * bright, 0.9 * bright, 0.92 * bright];
      for (let j = 0; j < 4; j++) put(o, corners[j], w);
      for (let j = 0; j < 4; j++) put(corners[j], corners[(j + 1) % 4], w);
      // its ray to her: drawn out from the lens as it settles
      const end = o.clone().lerp(heads, Math.min(1, ray * t));
      const rc = [0.32 * ray * t, 0.32 * ray * t, 0.34 * ray * t];
      put(o, end, rc);
    }
    g.attributes.position.needsUpdate = true;
    g.attributes.color.needsUpdate = true;
    return home;
  };
  return { lines, mat, update, count: n };
}

export async function mountStory(host: HTMLElement, input: StoryInput, hooks: StoryHooks): Promise<() => void> {
  let gl2 = false;
  try {
    gl2 = !!document.createElement("canvas").getContext("webgl2");
  } catch {
    gl2 = false;
  }
  if (!gl2) {
    hooks.failed();
    return () => {};
  }
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, powerPreference: "high-performance" });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.75));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.domElement.className = "story-gl";
  host.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 200);
  const spark = new SparkRenderer({ renderer });
  scene.add(spark);

  const person = new THREE.Group();
  person.rotation.y = Math.PI; // bundles face -Z; she faces the camera
  scene.add(person);
  const uMain = makeUniforms();
  const uReal = makeUniforms();
  let main: SplatMesh;
  try {
    main = await loadSplat(input.frame, uMain, (f) => hooks.loading(f));
  } catch {
    renderer.dispose();
    renderer.domElement.remove();
    hooks.failed();
    return () => {};
  }
  person.add(main);
  // her height (the head's top, past a stray Gaussian or two) and her count
  const ys: number[] = [];
  main.forEachSplat((_i, c) => ys.push(c.y));
  ys.sort((a, b) => a - b);
  const count = ys.length;
  const height = Math.max(1.2, ys[Math.min(count - 1, Math.floor(count * 0.998))] ?? 1.7);
  const centreY = height / 2;
  hooks.ready({ count, height });

  let real: SplatMesh | null = null;
  let realLoading = false;
  const wantReality = () => {
    if (real || realLoading || !input.reality) return;
    realLoading = true;
    loadSplat(input.reality, uReal)
      .then((m) => {
        real = m;
        person.add(m);
      })
      .catch(() => {});
  };

  const ground = floor();
  scene.add(ground.shadow, ground.ring);
  const rig = cameraRig(input.cameras, centreY);
  scene.add(rig.lines);

  // dragging turns her (with a little inertia); the pointer leans the view a touch
  let drag = 0;
  let dragV = 0;
  let pointerX = 0;
  let pointerY = 0;
  let down: { x: number; t: number } | null = null;
  const el = renderer.domElement;
  const onDown = (e: PointerEvent) => {
    down = { x: e.clientX, t: performance.now() };
    el.setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent) => {
    pointerX = (e.clientX / innerWidth) * 2 - 1;
    pointerY = (e.clientY / innerHeight) * 2 - 1;
    if (!down) return;
    const dx = (e.clientX - down.x) / 220;
    drag += dx;
    dragV = dx / Math.max(0.008, (performance.now() - down.t) / 1000);
    down = { x: e.clientX, t: performance.now() };
  };
  const onUp = () => (down = null);
  el.addEventListener("pointerdown", onDown);
  addEventListener("pointermove", onMove, { passive: true });
  addEventListener("pointerup", onUp);

  let w = 0;
  let h = 0;
  const resize = () => {
    const nw = host.clientWidth;
    const nh = host.clientHeight;
    if (nw === w && nh === h) return;
    w = nw;
    h = nh;
    renderer.setSize(w, h, false);
  };

  let onScreen = true;
  const io = new IntersectionObserver(([e]) => (onScreen = e.isIntersecting), { rootMargin: "100px 0px" });
  io.observe(host);

  const born = performance.now();
  let last = born;
  let fps = 60;
  let yaw = 0;
  const camPos = new THREE.Vector3();
  const camTgt = new THREE.Vector3();
  const heads = new THREE.Vector3(0, centreY, 0);
  const tmpA = new THREE.Vector3();

  // where the camera is for each beat: position, target (metres; she stands at the origin, about 1.7 m tall)
  const K = (p: [number, number, number], t: [number, number, number]) => ({ p: new THREE.Vector3(...p), t: new THREE.Vector3(...t) });

  const frame = () => {
    resize();
    if (!onScreen) return;
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    fps = lerp(fps, 1 / Math.max(1e-3, dt), 0.05);
    const time = (now - born) / 1000;
    const p = hooks.progress();
    const portrait = w / Math.max(1, h) < 0.9;
    const phone = w < 760;

    // beats: 0 the product shot · 1 not a video · 2 what she's made of · 3 the cameras · 4 seen and imagined · 5 life size
    const toClose = smooth(0.08, 0.16, p);
    const toRig = smooth(0.42, 0.5, p);
    const toReal = smooth(0.64, 0.7, p);
    const toLife = smooth(0.84, 0.9, p);
    const zoomOut = portrait ? 1.3 : 1;
    const hero = K([0, 0.98, 4.6 * (portrait ? 1.55 : 1)], [0, 0.9, 0]); // (her arm out: a phone needs more room)
    const close = K([0.25, 0.95, 5.9 * zoomOut], [0, 0.86, 0]);
    const overview = K([8.4 * zoomOut, 6.8 * zoomOut, 12.6 * zoomOut], [0, 0.15, 0]);
    const reality = K([0, 0.95, 5.9 * zoomOut], [0, 0.86, 0]);
    const life = K([0.3, 1.5, 5.6 * zoomOut], [0.06, 0.86, 0]);
    camPos.copy(hero.p).lerp(close.p, toClose);
    camTgt.copy(hero.t).lerp(close.t, toClose);
    camPos.lerp(overview.p, toRig);
    camTgt.lerp(overview.t, toRig);
    camPos.lerp(reality.p, toReal);
    camTgt.lerp(reality.t, toReal);
    camPos.lerp(life.p, toLife);
    camTgt.lerp(life.t, toLife);
    // a slow drift while the rig is up, and the pointer's lean everywhere
    const drift = toRig * (1 - toReal);
    camPos.applyAxisAngle(new THREE.Vector3(0, 1, 0), drift * (still ? 0 : Math.sin(time * 0.12) * 0.25));
    if (!still) camPos.add(tmpA.set(pointerX * 0.18, -pointerY * 0.08, 0));
    camera.position.copy(camPos);
    camera.lookAt(camTgt);
    // desktop: she stands right of centre, beside the words (the camera's axis shifted, no tilt)
    camera.fov = 30;
    camera.aspect = w / Math.max(1, h);
    // centred: above the wordmark in the product shot, then low under each beat's headline
    const low = lerp(phone ? -0.16 : -0.08, phone ? 0.16 : 0.15, toClose);
    camera.setViewOffset(w, h, 0, -h * low, w, h);
    camera.updateProjectionMatrix();

    // her turn: a slow sway, all the way round with the rig, her back to you in the Reality check, then home
    if (!down) {
      drag += dragV * dt;
      dragV *= Math.exp(-dt * 3.5);
    }
    const sway = still ? 0 : Math.sin(time * 0.42) * 0.42 * (1 - toClose);
    const turn = Math.PI * 2 * smooth(0.12, 0.28, p) * (1 - toRig); // all the way round, once, as you scroll
    const spinRig = still ? 0 : time * 0.16 * toRig * (1 - toReal);
    const turnReal = Math.PI * smooth(0.68, 0.78, p) * (1 - smooth(0.8, 0.86, p));
    yaw = sway + turn + spinRig + turnReal + drag;
    person.rotation.y = Math.PI + yaw;

    // the scan in: up from the floor on arrival; dissolved to bare Gaussians in beat 1; scanned to blue and back
    const intro = still ? 1 : smooth(0, 2.4, time);
    const H = height + 0.12;
    // the exploded view: she comes apart into her Gaussians, small and spread, then back together
    const apart = smooth(0.3, 0.37, p) * (1 - smooth(0.4, 0.46, p));
    uMain.explode.value = (still ? 0.5 : 0.62) * apart;
    uMain.size.value = lerp(1, 0.3, apart);
    uMain.glow.value = 0.35;
    const scan = smooth(0.68, 0.76, p) * (1 - smooth(0.8, 0.86, p)); // 0 her colours, 1 the Reality check
    if (scan > 0.001) wantReality();
    if (p > 0.56) wantReality();
    const line = lerp(-0.1, H, scan);
    if (real) {
      uMain.lo.value = line;
      uMain.hi.value = intro * (H + 0.2) - 0.1;
      uReal.lo.value = -0.2;
      uReal.hi.value = line;
      uReal.size.value = 1;
      uReal.glow.value = 0.35;
      real.visible = scan > 0.001;
      real.updateVersion();
    } else {
      uMain.lo.value = -0.2;
      uMain.hi.value = intro * (H + 0.2) - 0.1;
    }
    main.updateVersion();

    // her shadow, the rig and the ring it stands on
    (ground.shadow.material as THREE.MeshBasicMaterial).opacity = intro * (1 - toRig * (1 - toReal) * 0.6);
    const rigK = smooth(0.45, 0.6, p);
    const rigOut = smooth(0.63, 0.68, p);
    rig.mat.opacity = rigK > 0 ? 0.7 * (1 - rigOut) : 0;
    rig.lines.visible = rig.mat.opacity > 0.01;
    ground.ringMat.opacity = 0.22 * rigK * (1 - rigOut);
    const home = rig.lines.visible ? rig.update(still ? (rigK > 0 ? 1 : 0) : rigK, smooth(0.56, 0.62, p), spinRig * 0.5, heads) : 0;

    hooks.hud({ yaw: THREE.MathUtils.euclideanModulo(THREE.MathUtils.radToDeg(yaw), 360), fps, cams: home, scan });
    renderer.render(scene, camera);
  };
  renderer.setAnimationLoop(frame);

  return () => {
    renderer.setAnimationLoop(null);
    io.disconnect();
    el.removeEventListener("pointerdown", onDown);
    removeEventListener("pointermove", onMove);
    removeEventListener("pointerup", onUp);
    main.dispose?.();
    real?.dispose?.();
    renderer.dispose();
    renderer.domElement.remove();
  };
}
