import * as THREE from "three";
import { dyno, SplatMesh } from "@sparkjsdev/spark";
import type { PersonConfig } from "../config";

// A person from a dream bundle: meters, +Y up, feet on y = 0, their front facing -Z. The group turns them to face +Z,
// toward a camera that sits in front of them. Every Gaussian passes through one small shader (a Spark "dyno") that
// handles the vertical reveal, shrinking splats to points, and the reality-check tint.

const REALITY_BLUE = "vec3(0.0, 0.44, 0.89)"; // the same blue the pipeline uses (pipeline/lucid/export.py, tinted)
const LOAD_TIMEOUT_MS = 25000;

export class Person {
  /** Stands on y = 0, front toward +Z. */
  readonly group = new THREE.Group();
  /** Shader inputs, shared by every frame of this person. Change .value, then call touch(). */
  readonly u = {
    reveal: dyno.dynoFloat(-1), // meters: Gaussians below this height are shown
    edge: dyno.dynoFloat(0.16), // how soft the reveal line is
    glow: dyno.dynoFloat(0.5), // how bright the reveal line is
    size: dyno.dynoFloat(1), // scale multiplier: small turns the person into a cloud of points
    tint: dyno.dynoFloat(0), // 0-1: reality check
    front: dyno.dynoFloat(0), // object-space z behind which the source camera saw nothing (estimate only)
    useMask: dyno.dynoFloat(1), // 1: tint by the estimate; 0: the frames are already tinted (real reality files)
  };
  height = 1.7;
  count = 0;
  /** 0-1, from the bundle when known, otherwise the share of Gaussians on the camera's side. */
  seenFraction = 0;
  readonly seenIsEstimate: boolean;

  private frames: SplatMesh[] = [];
  private reality: SplatMesh[] = [];
  private shown = -1;
  private showReality = false;

  private constructor(private cfg: PersonConfig) {
    this.group.rotation.y = Math.PI;
    this.seenIsEstimate = cfg.seenFraction == null || !cfg.reality;
  }

  static async load(cfg: PersonConfig): Promise<Person> {
    const p = new Person(cfg);
    const first = await p.mesh(cfg.frames[0]);
    p.frames[0] = first;
    p.measure(first);
    p.show(0);
    // the rest of a replay streams in behind the first frame
    void (async () => {
      for (let i = 1; i < cfg.frames.length; i++) p.frames[i] = await p.mesh(cfg.frames[i]).catch(() => first);
    })();
    return p;
  }

  /** Swap to the bundle's reality frames (already tinted by the pipeline) if it has them; otherwise tint here. */
  async setReality(on: boolean) {
    const files = this.cfg.reality;
    if (on && files && !this.reality.length) {
      this.reality = await Promise.all(files.map((f, i) => this.mesh(f).catch(() => this.frames[i] ?? this.frames[0])));
    }
    this.showReality = on && this.reality.length > 0;
    this.u.useMask.value = this.showReality ? 0 : 1;
    const i = Math.max(0, this.shown);
    this.shown = -1;
    this.show(i);
  }

  get hasRealityFiles() {
    return !!this.cfg.reality;
  }

  /** Which frame to show at time t (seconds), looping. */
  at(t: number) {
    const n = this.cfg.frames.length;
    if (n > 1) this.show(Math.floor(t * this.cfg.fps) % n);
  }

  /** Tell Spark the shader inputs changed. */
  touch() {
    const set = this.showReality ? this.reality : this.frames;
    set[this.shown]?.updateVersion();
  }

  set opacity(v: number) {
    for (const m of [...this.frames, ...this.reality]) if (m) m.opacity = v;
  }

  private show(i: number) {
    if (i === this.shown) return;
    for (const m of [...this.frames, ...this.reality]) if (m) m.visible = false;
    const set = this.showReality ? this.reality : this.frames;
    const m = set[i] ?? set[0];
    if (m) {
      m.visible = true;
      m.updateVersion();
    }
    this.shown = i;
  }

  private async mesh(url: string): Promise<SplatMesh> {
    const mesh = new SplatMesh({ url, objectModifier: this.modifier() });
    mesh.visible = false;
    let timer = 0;
    const timeout = new Promise<never>((_, reject) => {
      timer = window.setTimeout(() => reject(new Error(`Timed out loading ${url}`)), LOAD_TIMEOUT_MS);
    });
    try {
      await Promise.race([mesh.initialized, timeout]);
    } finally {
      clearTimeout(timer);
    }
    this.group.add(mesh);
    return mesh;
  }

  private measure(mesh: SplatMesh) {
    // height from the top of the head, ignoring the odd stray Gaussian above it (a high percentile, not the max)
    const ys: number[] = [];
    const zs: number[] = [];
    mesh.forEachSplat((_i, c) => {
      ys.push(c.y);
      zs.push(c.z);
    });
    const n = ys.length;
    this.count = n;
    if (!n) return;
    const sortedY = Float32Array.from(ys).sort();
    const top = sortedY[Math.min(n - 1, Math.floor(n * 0.998))];
    if (top > 0.3) this.height = top;
    const sortedZ = Float32Array.from(zs).sort();
    const mid = (sortedZ[Math.floor(n * 0.01)] + sortedZ[Math.floor(n * 0.99)]) / 2;
    this.u.front.value = mid;
    let seen = 0;
    for (const z of zs) if (z <= mid) seen++;
    this.seenFraction = this.cfg.seenFraction ?? seen / n;
  }

  private modifier() {
    const u = this.u;
    return dyno.dynoBlock({ gsplat: dyno.Gsplat }, { gsplat: dyno.Gsplat }, ({ gsplat }) => {
      const d = new dyno.Dyno({
        inTypes: {
          gsplat: dyno.Gsplat,
          reveal: "float",
          edge: "float",
          glow: "float",
          size: "float",
          tint: "float",
          front: "float",
          useMask: "float",
        },
        outTypes: { gsplat: dyno.Gsplat },
        statements: ({ inputs: i, outputs: o }) =>
          dyno.unindentLines(`
            ${o.gsplat} = ${i.gsplat};
            float y = ${i.gsplat}.center.y;
            float k = clamp((${i.reveal} - y) / ${i.edge}, 0.0, 1.0);
            k = k * k * (3.0 - 2.0 * k);
            float rim = 4.0 * k * (1.0 - k);
            ${o.gsplat}.rgba.a *= k;
            ${o.gsplat}.scales *= ${i.size} * mix(0.3, 1.0, k);
            vec3 col = ${o.gsplat}.rgba.rgb;
            col = mix(col, vec3(1.0), rim * ${i.glow});
            float imagined = mix(1.0, smoothstep(${i.front} - 0.02, ${i.front} + 0.07, ${i.gsplat}.center.z), ${i.useMask});
            col = mix(col, 0.35 * col + 0.65 * ${REALITY_BLUE}, ${i.tint} * imagined * ${i.useMask});
            ${o.gsplat}.rgba.rgb = col;
          `),
      });
      return {
        gsplat: d.apply({
          gsplat,
          reveal: u.reveal,
          edge: u.edge,
          glow: u.glow,
          size: u.size,
          tint: u.tint,
          front: u.front,
          useMask: u.useMask,
        }).gsplat,
      };
    });
  }
}

/** A soft contact shadow, so the person stands on the floor instead of floating. */
export function contactShadow(width = 0.9, depth = 0.7, strength = 0.5): THREE.Mesh {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, `rgba(0,0,0,${strength})`);
  g.addColorStop(0.5, `rgba(0,0,0,${strength * 0.4})`);
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width, depth),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true, depthWrite: false }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.002;
  mesh.renderOrder = -1;
  return mesh;
}

/** A pool of light on the floor: the only "room" the person needs on a black page. */
export function floorGlow(radius = 1.6, color = 0x2a2a2e, strength = 0.55): THREE.Mesh {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const c = new THREE.Color(color);
  const rgb = `${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)}`;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, `rgba(${rgb},${strength})`);
  g.addColorStop(0.55, `rgba(${rgb},${strength * 0.35})`);
  g.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(radius * 2, radius * 2),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.001;
  mesh.renderOrder = -2;
  return mesh;
}
