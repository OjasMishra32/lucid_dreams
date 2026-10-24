// The cast: everyone in the library standing in one line on a black floor, each a real Gaussian frame from the middle
// of their own move, rendered live. Scroll first shows the whole line, then dollies along it, one person at a time;
// each one scans up from the floor as it arrives (streamed one after another, the nearest first). Client only.
import * as THREE from "three";
import { SparkRenderer, type SplatMesh } from "@sparkjsdev/spark";
import { loadSplat, makeUniforms, type Uniforms } from "./story";

export interface CastMember {
  id: string;
  frame: string; // one .spz frame, mid-move
}

export interface CastHooks {
  progress: () => number; // 0-1 through the section's scroll track
  focus: (i: number) => void; // the person the camera is on (-1: the whole line)
  failed: () => void;
}

const SPACING = 1.5; // metres between people
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function shadowTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, "rgba(255,255,255,0.10)");
  r.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = r;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

export async function mountCast(host: HTMLElement, cast: CastMember[], hooks: CastHooks): Promise<() => void> {
  let ok = false;
  try {
    ok = !!document.createElement("canvas").getContext("webgl2");
  } catch {
    ok = false;
  }
  if (!ok || !cast.length) {
    hooks.failed();
    return () => {};
  }
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, powerPreference: "high-performance" });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.domElement.className = "cast-gl";
  host.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 200);
  scene.add(new SparkRenderer({ renderer }));

  const n = cast.length;
  const x0 = -((n - 1) * SPACING) / 2;
  const glowTex = shadowTexture();
  const people = cast.map((m, i) => {
    const g = new THREE.Group();
    g.position.x = x0 + i * SPACING;
    g.rotation.y = Math.PI; // bundles face -Z; they face the camera
    scene.add(g);
    // a pool of light at their feet
    const pool = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 1.4), new THREE.MeshBasicMaterial({ map: glowTex, transparent: true, depthWrite: false }));
    pool.rotation.x = -Math.PI / 2;
    pool.position.set(g.position.x, 0.002, 0);
    scene.add(pool);
    return { m, g, u: makeUniforms(), mesh: null as SplatMesh | null, born: 0, loading: false, lit: 1 };
  });
  for (const p of people) {
    p.u.lo.value = -0.2;
    p.u.hi.value = -0.2;
    p.u.glow.value = 0.45;
  }

  // stream them in, nearest the camera first, one at a time
  let gone = false;
  let near = 0;
  const pump = async () => {
    while (!gone) {
      const order = people.map((p, i) => ({ p, d: Math.abs(i - near) })).filter(({ p }) => !p.mesh && !p.loading).sort((a, b) => a.d - b.d);
      if (!order.length) return;
      const p = order[0].p;
      p.loading = true;
      try {
        const mesh = await loadSplat(p.m.frame, p.u);
        if (gone) return;
        p.g.add(mesh);
        p.mesh = mesh;
        p.born = performance.now();
      } catch {
        // one that won't load stays an empty spot
      }
    }
  };
  let started = false;

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
  let onScreen = false;
  const io = new IntersectionObserver(([e]) => {
    onScreen = e.isIntersecting;
    if (onScreen && !started) {
      started = true;
      void pump();
    }
  }, { rootMargin: "120% 0px" });
  io.observe(host);

  const look = new THREE.Vector3();
  let focused = -2;
  const t0 = performance.now();
  const frame = () => {
    resize();
    if (!onScreen) return;
    const now = performance.now();
    const time = (now - t0) / 1000;
    const p = hooks.progress();
    const portrait = w / Math.max(1, h) < 0.9;
    // 0-0.14: the whole line; then along it, one person per stretch of scroll
    const wide = 1 - smooth(0.08, 0.18, p);
    const along = smooth(0.14, 0.98, p) * (n - 1);
    const at = Math.round(along);
    near = Math.min(n - 1, Math.max(0, at));
    const xLine = x0 + along * SPACING;
    const widthAll = n * SPACING + 1;
    const zWide = (widthAll / 2 / Math.tan(THREE.MathUtils.degToRad(15)) / (w / Math.max(1, h))) * 1.05;
    const zClose = portrait ? 6.2 : 5.2;
    const z = zClose + (Math.max(zWide, 6) - zClose) * wide;
    const x = xLine * (1 - wide);
    const sway = still ? 0 : Math.sin(time * 0.3) * 0.35 * (1 - wide);
    camera.position.set(x + sway, 1.15 + 0.25 * wide, z);
    look.set(x, 0.86, 0);
    camera.lookAt(look);
    // close up, the one in focus stands right of centre (their name is on the left); on a phone, centred above it
    const shift = portrait ? 0 : 0.2 * (1 - wide);
    const lift = portrait ? 0.12 * (1 - wide) : 0;
    if (shift > 0.001 || lift > 0.001) camera.setViewOffset(w, h, -shift * w, -lift * h, w, h);
    else camera.clearViewOffset();
    camera.updateProjectionMatrix();
    const f = wide > 0.5 ? -1 : near;
    if (f !== focused) {
      focused = f;
      hooks.focus(f);
    }
    // each one scans up as it arrives, turns a little on its own, and the one in focus faces you squarely
    for (let i = 0; i < n; i++) {
      const q = people[i];
      if (!q.mesh) continue;
      const k = still ? 1 : smooth(0, 1.6, (now - q.born) / 1000);
      q.u.hi.value = -0.1 + k * 2.2;
      const off = i - along;
      q.g.rotation.y = Math.PI + (still ? 0 : Math.sin(time * 0.4 + i * 1.7) * 0.25) - off * 0.18 * (1 - wide);
      // a spotlight: up close, the one in focus at full strength and the rest faded back
      // (darker, still solid: fading their opacity shows a ghost of their Gaussians)
      const want = wide > 0.5 ? 1 : Math.max(0.22, 1 - Math.abs(off) * 0.9);
      q.lit += (want - q.lit) * 0.12;
      q.mesh.recolor.setScalar(q.lit);
      q.mesh.updateVersion();
    }
    renderer.render(scene, camera);
  };
  renderer.setAnimationLoop(frame);

  return () => {
    gone = true;
    renderer.setAnimationLoop(null);
    io.disconnect();
    for (const p of people) p.mesh?.dispose?.();
    renderer.dispose();
    renderer.domElement.remove();
  };
}

export type { Uniforms };
