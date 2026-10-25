// Court Side's freeze (Vishal's ?mode=court), for the film and the website's card: the two players as their bundle has
// them (each a freeze.ply in the court's own space, the ball in Luka's hands) standing on a dark floor with their own
// baked contact shadows, scanning in from the floor up, the camera turning from the broadcast camera's side. Client only.
import * as THREE from "three";
import { SparkRenderer, type SplatMesh } from "@sparkjsdev/spark";
import { loadSplat, makeUniforms } from "./story";

export interface CourtPlayer {
  splats: string;
  shadow?: { image: string; rect: [number, number, number, number] }; // the bundle's FloorRect: x0, z0, x1, z1
}

export interface CourtHooks {
  reveal: () => number; // 0 -> 1: the players scan in from the floor up
  yaw: () => number; // radians, turning away from the broadcast camera's side
  dist?: () => number; // metres from the pair's centre (default 5.6)
  shift?: number; // move them right by this share of the width (a lens shift, so type can sit on the left)
  failed: () => void;
}

/** A floor map's alpha as a black contact shadow (the bundle bakes it in straight alpha). */
function shadowQuad(map: THREE.Texture, [x0, z0, x1, z1]: [number, number, number, number], fade: { value: number }): THREE.Mesh {
  const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0);
  g.rotateX(-Math.PI / 2); // the image's top row at minZ, as Court Side lays it
  g.translate((x0 + x1) / 2, 0.003, (z0 + z1) / 2);
  const m = new THREE.Mesh(
    g,
    new THREE.ShaderMaterial({
      uniforms: { uMap: { value: map }, uK: fade },
      vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
      fragmentShader:
        "uniform sampler2D uMap; uniform float uK; varying vec2 vUv; void main() { float a = 1.0 - pow(1.0 - texture2D(uMap, vUv).a, 1.6); gl_FragColor = vec4(0.0, 0.0, 0.0, a * 0.85 * uK); }",
      transparent: true,
      depthWrite: false,
    }),
  );
  m.renderOrder = -1;
  return m;
}

/** A pool of light on the floor under them, fading to the black around it. */
function floorPool(radius: number): THREE.Mesh {
  const c = document.createElement("canvas");
  c.width = c.height = 512;
  const g = c.getContext("2d")!;
  const r = g.createRadialGradient(256, 256, 0, 256, 256, 256);
  r.addColorStop(0, "rgba(58,52,46,1)");
  r.addColorStop(0.45, "rgba(30,27,24,0.85)");
  r.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = r;
  g.fillRect(0, 0, 512, 512);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(new THREE.CircleGeometry(radius, 96), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  m.rotation.x = -Math.PI / 2;
  m.renderOrder = -2;
  return m;
}

export async function mountCourt(
  host: HTMLElement,
  players: CourtPlayer[],
  camera0: [number, number, number], // the broadcast camera's centre, in the same space
  hooks: CourtHooks,
): Promise<() => void> {
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
  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, powerPreference: "high-performance" });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  host.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 60);
  scene.add(new SparkRenderer({ renderer }));
  const world = new THREE.Group();
  scene.add(world);
  const u = makeUniforms();
  u.lo.value = -1;
  u.hi.value = -1;

  let meshes: SplatMesh[] = [];
  let gone = false;
  try {
    meshes = await Promise.all(players.map((p) => loadSplat(p.splats, u)));
  } catch {
    hooks.failed();
    renderer.dispose();
    renderer.domElement.remove();
    return () => {};
  }
  if (gone) return () => {};
  meshes.forEach((m) => world.add(m));

  // the pair's centre on the floor and their height, from robust bounds over both (stray splats mustn't move them)
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  for (const m of meshes)
    m.forEachSplat((_i, c) => {
      xs.push(c.x);
      ys.push(c.y);
      zs.push(c.z);
    });
  const q = (v: number[], f: number) => {
    v.sort((a, b) => a - b);
    return v[Math.min(v.length - 1, Math.max(0, Math.floor(v.length * f)))] ?? 0;
  };
  const cx = (q(xs, 0.002) + q(xs, 0.998)) / 2;
  const cz = (q(zs, 0.002) + q(zs, 0.998)) / 2;
  const top = q(ys, 0.998);
  world.position.set(-cx, 0, -cz);

  // the floor and the shadows come up with the scan's first moments, never before the players
  const fade = { value: 0 };
  const pool = floorPool(3.2);
  scene.add(pool);
  const loader = new THREE.TextureLoader();
  for (const p of players)
    if (p.shadow)
      loader.load(p.shadow.image, (t) => {
        if (!gone) world.add(shadowQuad(t, p.shadow!.rect, fade));
      });

  // the broadcast camera's direction from the pair, on the floor plane: yaw 0 looks the way the footage did
  const d0 = new THREE.Vector2(camera0[0] - cx, camera0[2] - cz).normalize();

  let w = 0;
  let hh = 0;
  const resize = () => {
    if (host.clientWidth === w && host.clientHeight === hh) return;
    w = host.clientWidth;
    hh = host.clientHeight;
    renderer.setSize(w, hh, false);
    camera.aspect = w / Math.max(1, hh);
    if (hooks.shift) camera.setViewOffset(w, hh, -hooks.shift * w, 0, w, hh);
    camera.updateProjectionMatrix();
  };
  renderer.setAnimationLoop(() => {
    resize();
    if (!w || !hh) return;
    const k = Math.min(1, Math.max(0, hooks.reveal()));
    u.hi.value = -0.06 + k * (top + 0.2);
    u.glow.value = k < 1 ? 0.9 : 0;
    fade.value = Math.min(1, k * 5);
    (pool.material as THREE.MeshBasicMaterial).opacity = fade.value;
    for (const m of meshes) m.updateVersion();
    const a = hooks.yaw();
    const dist = hooks.dist?.() ?? 5.6;
    const dx = d0.x * Math.cos(a) - d0.y * Math.sin(a);
    const dz = d0.x * Math.sin(a) + d0.y * Math.cos(a);
    camera.position.set(dx * dist, 1.45, dz * dist);
    camera.lookAt(0, 0.86, 0);
    renderer.render(scene, camera);
  });
  return () => {
    gone = true;
    renderer.setAnimationLoop(null);
    for (const m of meshes) m.dispose?.();
    renderer.dispose();
    renderer.domElement.remove();
  };
}
