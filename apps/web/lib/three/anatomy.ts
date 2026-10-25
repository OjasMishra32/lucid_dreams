// The technology page's one live stage: a real frame of the dancer (dance-01, 289k Gaussians) taken apart as you scroll.
// splats: what you see; ellipsoids: every Gaussian drawn flat to one standard deviation, its true shape and size;
// centres: only the means, the point cloud underneath; cameras: 4DAnyone's 48 cameras (its own cameras.json) round
// her; skeleton: GVHMR's body fit for the same frame (joints.json); seen: the Reality check twin, blue where no
// camera saw. Client only (three.js, Spark).
import * as THREE from "three";
import { dyno, SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
import { rigPoses, type RigCamera } from "./story";

export type AnatomyMode = "splats" | "ellipsoids" | "centres" | "cameras" | "skeleton" | "seen";

export interface AnatomyInput {
  frame: string;
  reality: string | null;
  cameras: RigCamera[];
  joints: number[][] | null; // one frame of joints.json: 22 SMPL-X body joints, bundle space
}

export interface AnatomyHooks {
  mode: () => AnatomyMode;
  loading: (fraction: number) => void;
  ready: () => void;
  failed: () => void;
}

// SMPL-X's first 22 joints (pelvis to wrists) and each one's parent
const PARENTS = [-1, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 12, 13, 14, 16, 17, 18, 19];

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const approach = (v: number, to: number, dt: number, rate = 5) => v + (to - v) * (1 - Math.exp(-rate * dt));

function shaderInputs() {
  return { size: dyno.dynoFloat(1), solid: dyno.dynoFloat(0) };
}

/** size: every Gaussian's scales, x; solid: its opacity pushed toward 1 so its outline reads (the ellipsoid view). */
function anatomyModifier(u: ReturnType<typeof shaderInputs>) {
  return dyno.dynoBlock({ gsplat: dyno.Gsplat }, { gsplat: dyno.Gsplat }, ({ gsplat }) => {
    const d = new dyno.Dyno({
      inTypes: { gsplat: dyno.Gsplat, size: "float", solid: "float" },
      outTypes: { gsplat: dyno.Gsplat },
      statements: ({ inputs: i, outputs: o }) =>
        dyno.unindentLines(`
          ${o.gsplat} = ${i.gsplat};
          ${o.gsplat}.scales *= ${i.size};
          float a = ${i.gsplat}.rgba.a;
          ${o.gsplat}.rgba.a = mix(a, min(1.0, 0.25 + a * 2.5), ${i.solid});
        `),
    });
    return { gsplat: d.apply({ gsplat, size: u.size, solid: u.solid }).gsplat };
  });
}

async function load(url: string, u: ReturnType<typeof shaderInputs>, onProgress?: (f: number) => void) {
  const mesh = new SplatMesh({
    url,
    objectModifier: anatomyModifier(u),
    onProgress: (e) => {
      if (onProgress && e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
    },
  });
  await Promise.race([mesh.initialized, new Promise((_, no) => setTimeout(() => no(new Error(`timed out: ${url}`)), 40000))]);
  return mesh;
}

/** The 48 cameras as wireframe frustums (one draw), each with its ray to her chest. */
function rig(cams: RigCamera[], centreY: number) {
  const poses = rigPoses(cams);
  const pts: number[] = [];
  const target = new THREE.Vector3(0, centreY, 0);
  for (const p of poses) {
    const D = 0.26;
    const th = (p.c.h / 2 / p.c.fy) * D;
    const tw = th * (p.c.w / p.c.h);
    const right = new THREE.Vector3().crossVectors(p.fwd, new THREE.Vector3(0, 1, 0)).normalize();
    const up = new THREE.Vector3().crossVectors(right, p.fwd).normalize();
    const o = p.pos.clone().add(target);
    const c = o.clone().addScaledVector(p.fwd, D);
    const k = [
      c.clone().addScaledVector(right, -tw).addScaledVector(up, th),
      c.clone().addScaledVector(right, tw).addScaledVector(up, th),
      c.clone().addScaledVector(right, tw).addScaledVector(up, -th),
      c.clone().addScaledVector(right, -tw).addScaledVector(up, -th),
    ];
    const seg = (a: THREE.Vector3, b: THREE.Vector3) => pts.push(a.x, a.y, a.z, b.x, b.y, b.z);
    for (let j = 0; j < 4; j++) seg(o, k[j]);
    for (let j = 0; j < 4; j++) seg(k[j], k[(j + 1) % 4]);
    seg(o, o.clone().lerp(target, 0.92));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  const mat = new THREE.LineBasicMaterial({ color: 0xdfe8ff, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
  const lines = new THREE.LineSegments(g, mat);
  lines.frustumCulled = false;
  return { lines, mat };
}

/** GVHMR's body fit for this frame: bones as glowing lines, joints as small spheres, seen through the body. */
function skeleton(joints: number[][]) {
  const group = new THREE.Group();
  const pts: number[] = [];
  PARENTS.forEach((p, i) => {
    if (p < 0 || !joints[i] || !joints[p]) return;
    pts.push(...joints[p], ...joints[i]);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  const lineMat = new THREE.LineBasicMaterial({ color: 0x2997ff, transparent: true, opacity: 0, depthTest: false, depthWrite: false });
  const bones = new THREE.LineSegments(g, lineMat);
  bones.renderOrder = 10;
  const dotMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthTest: false, depthWrite: false });
  const dots = new THREE.InstancedMesh(new THREE.SphereGeometry(0.014, 12, 8), dotMat, joints.length);
  dots.renderOrder = 11;
  const m = new THREE.Matrix4();
  joints.forEach((j, i) => dots.setMatrixAt(i, m.makeTranslation(j[0], j[1], j[2])));
  group.add(bones, dots);
  return { group, lineMat, dotMat };
}

export async function mountAnatomy(host: HTMLElement, input: AnatomyInput, hooks: AnatomyHooks): Promise<() => void> {
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
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, powerPreference: "high-performance" });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  host.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.05, 100);
  const spark = new SparkRenderer({ renderer });
  scene.add(spark);

  const person = new THREE.Group();
  person.rotation.y = Math.PI; // bundles face -Z
  scene.add(person);
  const u = shaderInputs();
  const ur = shaderInputs();
  let mesh: SplatMesh | null = null;
  let twin: SplatMesh | null = null;
  let twinLoading = false;
  let gone = false;
  try {
    mesh = await load(input.frame, u, hooks.loading);
  } catch {
    hooks.failed();
    renderer.dispose();
    renderer.domElement.remove();
    return () => {};
  }
  if (gone) return () => {};
  person.add(mesh);
  const box = mesh.getBoundingBox(true);
  const height = Math.max(1.2, box.max.y - box.min.y);
  const centreY = height * 0.52;
  hooks.ready();

  const cams = input.cameras.length ? rig(input.cameras, centreY) : null;
  if (cams) scene.add(cams.lines); // world space: the rig doesn't turn with her
  const bones = input.joints ? skeleton(input.joints) : null;
  if (bones) person.add(bones.group);

  const loadTwin = () => {
    if (twin || twinLoading || !input.reality) return;
    twinLoading = true;
    load(input.reality, ur)
      .then((m) => {
        if (gone) return m.dispose();
        m.opacity = 0;
        person.add(m);
        twin = m;
      })
      .catch(() => {
        twinLoading = false;
      });
  };

  let w = 0;
  let h = 0;
  const resize = () => {
    if (host.clientWidth === w && host.clientHeight === h) return;
    w = host.clientWidth;
    h = host.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
  };
  let onScreen = true; // until the observer says otherwise (a hidden page may never report)
  const io = new IntersectionObserver(([e]) => (onScreen = e.isIntersecting), { rootMargin: "20% 0px" });
  io.observe(host);

  // eased toward each mode's look
  const s = { falloff: 1, std: Math.sqrt(8), size: 1, solid: 0, dim: 1, rig: 0, bones: 0, seen: 0, dist: 4.3, lift: 0.0 };
  const look = new THREE.Vector3();
  let yaw = 0.5;
  let last = performance.now();
  const frame = () => {
    resize();
    if (!onScreen) {
      last = performance.now();
      return;
    }
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const mode = hooks.mode();
    if (mode === "seen" || mode === "skeleton") loadTwin();
    const want = {
      falloff: mode === "ellipsoids" || mode === "centres" ? 0 : 1,
      std: mode === "ellipsoids" ? 1 : mode === "centres" ? 1.6 : Math.sqrt(8),
      size: mode === "centres" ? 0.06 : mode === "ellipsoids" ? 0.92 : 1,
      solid: mode === "ellipsoids" || mode === "centres" ? 1 : 0,
      dim: mode === "skeleton" ? 0.3 : 1,
      rig: mode === "cameras" ? 1 : 0,
      bones: mode === "skeleton" ? 1 : 0,
      seen: mode === "seen" && twin ? 1 : 0,
      dist: mode === "cameras" ? 7.8 : mode === "centres" || mode === "ellipsoids" ? 3.3 : 4.3,
      lift: mode === "cameras" ? 2.2 : 0,
    };
    for (const k of Object.keys(want) as (keyof typeof want)[]) s[k] = approach(s[k], want[k], dt, k === "dist" || k === "lift" ? 2.2 : 4);
    spark.falloff = s.falloff;
    spark.maxStdDev = s.std;
    u.size.value = s.size;
    u.solid.value = s.solid;
    ur.size.value = s.size;
    ur.solid.value = s.solid;
    mesh!.recolor.setScalar(s.dim);
    mesh!.opacity = 1 - s.seen;
    mesh!.updateVersion();
    if (twin) {
      twin.opacity = s.seen;
      twin.visible = s.seen > 0.01;
      twin.updateVersion();
    }
    if (cams) cams.mat.opacity = 0.55 * s.rig;
    if (bones) {
      bones.lineMat.opacity = s.bones;
      bones.dotMat.opacity = s.bones;
      bones.group.visible = s.bones > 0.01;
    }
    if (!still) yaw += dt * (mode === "cameras" ? 0.12 : 0.22);
    const r = s.dist;
    const y = centreY + 0.15 + s.lift;
    camera.position.set(Math.sin(yaw) * r, y, Math.cos(yaw) * r);
    look.set(0, centreY - 0.05 * smoothstep(0, 1, s.rig), 0);
    camera.lookAt(look);
    renderer.render(scene, camera);
  };
  renderer.setAnimationLoop(frame);

  return () => {
    gone = true;
    renderer.setAnimationLoop(null);
    io.disconnect();
    mesh?.dispose?.();
    twin?.dispose?.();
    renderer.dispose();
    renderer.domElement.remove();
  };
}
