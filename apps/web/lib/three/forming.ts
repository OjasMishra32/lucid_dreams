// The pipeline's build step, live: a person's Gaussians (a replay frame or an avatar's rest pose) starting as a
// scattered, shrunken cloud and pulling together as `amount()` goes 0 -> 1, turning slowly. Client only.
import * as THREE from "three";
import { SparkRenderer, type SplatMesh } from "@sparkjsdev/spark";
import { loadSplat, makeUniforms } from "./story";

export interface FormingHooks {
  amount: () => number; // 0: a loose cloud of points, 1: the finished person
  active: () => boolean; // draw only while its stage is on screen
  failed: () => void;
}

export async function mountForming(host: HTMLElement, frame: string, hooks: FormingHooks): Promise<() => void> {
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
  const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 50);
  scene.add(new SparkRenderer({ renderer }));
  const person = new THREE.Group();
  person.rotation.y = Math.PI; // bundles face -Z
  scene.add(person);
  const u = makeUniforms();
  u.lo.value = -1;
  u.hi.value = 3;
  u.glow.value = 0;
  let mesh: SplatMesh | null = null;
  let gone = false;
  try {
    mesh = await loadSplat(frame, u);
  } catch {
    hooks.failed();
    renderer.dispose();
    renderer.domElement.remove();
    return () => {};
  }
  if (gone) return () => {};
  person.add(mesh);
  const box = mesh.getBoundingBox(true);
  const h = Math.max(1.2, box.max.y - box.min.y);
  // feet on y = 0, centred: a replay frame already is, an avatar's rest pose hangs from its pelvis
  mesh.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);

  let w = 0;
  let hh = 0;
  const resize = () => {
    if (host.clientWidth === w && host.clientHeight === hh) return;
    w = host.clientWidth;
    hh = host.clientHeight;
    renderer.setSize(w, hh, false);
    camera.aspect = w / Math.max(1, hh);
    camera.updateProjectionMatrix();
  };
  const t0 = performance.now();
  let shown = 0;
  let last = t0;
  const frameLoop = () => {
    resize();
    if (!hooks.active() || !w || !hh) {
      last = performance.now();
      return;
    }
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const target = still ? 1 : Math.min(1, Math.max(0, hooks.amount()));
    shown += (target - shown) * (1 - Math.exp(-dt * 6));
    const k = shown * shown * (3 - 2 * shown);
    u.explode.value = (1 - k) * 0.9;
    u.size.value = 0.12 + 0.88 * k;
    mesh!.updateVersion();
    const yaw = still ? 0.4 : 0.4 + ((now - t0) / 1000) * 0.25;
    const dist = h * (2.45 + 1.4 * (1 - k)); // further out while it's still a loose cloud
    camera.position.set(Math.sin(yaw) * dist, h * 0.55, Math.cos(yaw) * dist);
    camera.lookAt(0, h * 0.48, 0);
    renderer.render(scene, camera);
  };
  renderer.setAnimationLoop(frameLoop);
  return () => {
    gone = true;
    renderer.setAnimationLoop(null);
    mesh?.dispose?.();
    renderer.dispose();
    renderer.domElement.remove();
  };
}
