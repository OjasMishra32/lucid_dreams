// The frozen 3D: the pair's freeze splats and the ball, brought up under the opaque picture from F - 0.45 s (reveal;
// Spark's first sort is done before the fade, and their opacity never fades in, P10), the other players (3.4b: splats
// or body PLY, relief GLB, each lit by the floor under their feet), the ball (a sphere at
// freeze.ball carrying F's own ball pixels projected from camera F, and erased inside the listed players' splats),
// contact shadows and soft reflections baked from the splats (court-spikes/ground/: floor maps on each FloorRect, the
// reflection by Schlick Fresnel with f0 0.06), the capsule proximity fade (torso or head within 0.2 m -> 30% over
// 300 ms; hands and ball never, P17), the light field's dyno modifier on every splat mesh (so the 3D gets the
// footage's numbers, P44), the players' white point for the arena's lights (P13) and the Reality check (reality.ply
// swapped in, the ball's far side and the extras placed from C tinted, seen % per player). Stream E (`look`) builds
// it. Siblings are type-only imports, so node --test can import the pure helpers below.
import * as THREE from "three";
import { dyno, SplatMesh, type SparkRenderer } from "@sparkjsdev/spark";
import type { Capsule, CourtBundle, FloorMap, Quat, Vec3 } from "./format";
import type { LightField, LightPerson } from "./lightfield";
import { loads } from "./loading";
import type { Head } from "./types";

/** True once stream E has built this module. */
export const BUILT = true;

/** The proximity fade (P17): an eye this close to a torso or head capsule fades that player to FADE_TO over FADE_S. */
export const FADE_NEAR = 0.2;
export const FADE_TO = 0.3;
export const FADE_S = 0.3;
/** Reflections: Schlick f0 and a gain on the baked map (court-spikes/ground/ reflect.ts's decal numbers). */
const F0 = 0.06;
const REFLECTIVITY = 2.4;
const REALITY_BLUE = new THREE.Vector3(0.1, 0.28, 1.0);

/** Distance from p to a capsule's surface (negative inside), metres. */
export function capsuleDistance(p: Vec3, c: Capsule): number {
  const ab = [c.b[0] - c.a[0], c.b[1] - c.a[1], c.b[2] - c.a[2]];
  const ap = [p[0] - c.a[0], p[1] - c.a[1], p[2] - c.a[2]];
  const len2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
  const t = len2 > 0 ? Math.min(1, Math.max(0, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / len2)) : 0;
  return Math.hypot(ap[0] - ab[0] * t, ap[1] - ab[1] * t, ap[2] - ab[2] * t) - c.r;
}

/** True when the eye is within FADE_NEAR of any of the player's capsules (torso and head only: never hands or ball). */
export function nearBody(eye: Vec3, capsules: readonly Capsule[]): boolean {
  return capsules.some((c) => capsuleDistance(eye, c) <= FADE_NEAR);
}

/** One frame of the proximity fade: toward FADE_TO when near, back to 1 when not, at (1 - FADE_TO) / FADE_S per second. */
export function fadeStep(opacity: number, near: boolean, dt: number): number {
  const step = ((1 - FADE_TO) / FADE_S) * dt;
  return near ? Math.max(FADE_TO, opacity - step) : Math.min(1, opacity + step);
}

/**
 * Whether court (x, z) is inside the bounds polygon ([x, z] corners in order, either way round; even-odd rule). No
 * bounds, or fewer than 3 corners: nothing is inside.
 */
export function inBounds(x: number, z: number, bounds: readonly (readonly [number, number])[] | null): boolean {
  if (!bounds || bounds.length < 3) return false;
  let inside = false;
  for (let i = 0, j = bounds.length - 1; i < bounds.length; j = i++) {
    const [xi, zi] = bounds[i];
    const [xj, zj] = bounds[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** A court point in camera F's image, as a texture coordinate of a frame scaled to any width (v up, flipY images). */
export function projectUv(cam: { centre: Vec3; q: Quat; f: number; cx: number; cy: number; width: number; height: number }, p: Vec3): [number, number] | null {
  const [x, y, z, w] = cam.q;
  const v: Vec3 = [p[0] - cam.centre[0], p[1] - cam.centre[1], p[2] - cam.centre[2]];
  // the inverse rotation (conjugate) applied to v
  const qx = -x, qy = -y, qz = -z;
  const tx = 2 * (qy * v[2] - qz * v[1]);
  const ty = 2 * (qz * v[0] - qx * v[2]);
  const tz = 2 * (qx * v[1] - qy * v[0]);
  const c: Vec3 = [v[0] + w * tx + (qy * tz - qz * ty), v[1] + w * ty + (qz * tx - qx * tz), v[2] + w * tz + (qx * ty - qy * tx)];
  if (c[2] <= 1e-9) return null;
  const u = cam.cx + (cam.f * c[0]) / c[2];
  const vv = cam.cy + (cam.f * c[1]) / c[2];
  return [(u + 0.5) / cam.width, 1 - (vv + 0.5) / cam.height];
}

/** The ball's shader: F's pixels projected from camera F (the same pixels the video shows), lit with the pair. */
function ballMaterial(light: LightField, freeze: THREE.Texture | null, cam: { centre: Vec3; q: Quat; f: number; cx: number; cy: number; width: number; height: number }, reality: { value: number }): THREE.ShaderMaterial {
  const R = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion(...cam.q))).transpose();
  return new THREE.ShaderMaterial({
    uniforms: {
      ...light.uniforms,
      uFreeze: { value: freeze },
      uHas: { value: freeze ? 1 : 0 },
      uCamC: { value: new THREE.Vector3(...cam.centre) },
      uCamR: { value: R },
      uCam: { value: new THREE.Vector4(cam.f, cam.cx, cam.cy, 0) },
      uSize: { value: new THREE.Vector2(cam.width, cam.height) },
      uBlue: { value: REALITY_BLUE.clone() },
      uReality: reality,
    },
    vertexShader: /* glsl */ `
      ${light.glslVertex}
      varying vec3 vN;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vLightCourt = lightCourt(w);
        vN = normal; // the sphere sits unrotated in court space
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      ${light.glsl}
      varying vec3 vLightCourt;
      uniform sampler2D uFreeze; uniform float uHas;
      uniform vec3 uCamC; uniform mat3 uCamR; uniform vec4 uCam; uniform vec2 uSize;
      uniform vec3 uBlue; uniform float uReality;
      varying vec3 vN;
      void main() {
        vec3 c = uCamR * (vLightCourt - uCamC);
        vec2 px = uCam.yz + uCam.x * c.xy / max(c.z, 1e-6);
        vec2 uv = vec2((px.x + 0.5) / uSize.x, 1.0 - (px.y + 0.5) / uSize.y);
        vec3 col = uHas > 0.5 ? texture2D(uFreeze, uv).rgb : vec3(0.42, 0.12, 0.03);
        col *= lightPair();
        // the far side: camera F never saw it
        float far = step(0.0, dot(normalize(vN), normalize(vLightCourt - uCamC)));
        col = mix(col, uBlue * (0.04 + dot(col, vec3(0.2126, 0.7152, 0.0722))), far * 0.75 * uReality);
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
}

/** A floor map (shadow or reflection) on its FloorRect, just above the floor. */
function floorQuad(rect: FloorMap["rect"], material: THREE.Material, order: number): THREE.Mesh {
  const [x0, z0, x1, z1] = rect;
  const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0);
  g.rotateX(-Math.PI / 2); // +y up; the image's top row (v = 1) at minZ
  g.translate((x0 + x1) / 2, 0.003, (z0 + z1) / 2);
  const m = new THREE.Mesh(g, material);
  m.renderOrder = order;
  m.frustumCulled = false;
  return m;
}

const QUAD_VERTEX = /* glsl */ `
  varying vec2 vUv; varying vec3 vWorld;
  void main() {
    vUv = vec2(uv.x, uv.y);
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }`;

/** Contact shadow: black at the map's alpha (straight alpha), darkening only; dithered against 8-bit banding. */
function shadowMaterial(map: THREE.Texture, k: { value: number }): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uMap: { value: map }, uK: k },
    vertexShader: QUAD_VERTEX,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap; uniform float uK;
      varying vec2 vUv;
      float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
      void main() {
        float a = texture2D(uMap, vUv).a * uK;
        a += (ign(gl_FragCoord.xy) - 0.5) / 255.0 * step(0.002, a);
        gl_FragColor = vec4(0.0, 0.0, 0.0, clamp(a, 0.0, 1.0));
      }`,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
}

/**
 * Soft reflection: the baked map's colour by Schlick Fresnel of the view, premultiplied over the floor, in the
 * person's light; off in the room (3.6), with the arena floor.
 */
function reflectionMaterial(map: THREE.Texture, k: { value: number }, light: { value: number }, field: LightField): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uMap: { value: map }, uK: k, uLight: light, uLightView: field.uniforms.uLightView },
    vertexShader: QUAD_VERTEX,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap; uniform float uK; uniform float uLight; uniform vec4 uLightView;
      varying vec2 vUv; varying vec3 vWorld;
      void main() {
        vec4 t = texture2D(uMap, vUv);
        float cosPhi = clamp(normalize(cameraPosition - vWorld).y, 0.0, 1.0);
        float fresnel = ${F0.toFixed(3)} + ${(1 - F0).toFixed(3)} * pow(1.0 - cosPhi, 5.0);
        float a = clamp(t.a * ${REFLECTIVITY.toFixed(2)} * fresnel * uK * uLightView.z, 0.0, 1.0);
        gl_FragColor = vec4(t.rgb * uLight, 1.0);
        #include <colorspace_fragment>
        gl_FragColor = vec4(gl_FragColor.rgb * a, a);
      }`,
    transparent: true,
    premultipliedAlpha: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
}

/** Erase the splats inside the ball (they become the ball): an object-space modifier (the PLYs are in court space). */
function eraseModifier(centre: Vec3, radius: number) {
  const c = dyno.dynoVec3(new THREE.Vector3(...centre));
  const r = dyno.dynoFloat(radius);
  const erase = new dyno.Dyno({
    inTypes: { gsplat: dyno.Gsplat, c: "vec3", r: "float" },
    outTypes: { gsplat: dyno.Gsplat },
    inputs: { c, r },
    globals: () => [dyno.defineGsplat],
    statements: ({ inputs, outputs }) => {
      const { gsplat: out } = outputs;
      if (!out) return [];
      return [`${out} = ${inputs.gsplat};`, `if (distance(${out}.center, ${inputs.c}) < ${inputs.r}) ${out}.rgba.a = 0.0;`];
    },
  });
  return dyno.dynoBlock({ gsplat: dyno.Gsplat }, { gsplat: dyno.Gsplat }, ({ gsplat }) => ({ gsplat: erase.apply({ gsplat }).gsplat }));
}

/** One person in the freeze: their splats (and reality splats), floor maps and fade state. */
interface Person {
  id: string;
  pair: boolean;
  /** Placed from C (A never saw them): tinted in the Reality check (their reality.ply). */
  fromC: boolean;
  normal: THREE.Object3D;
  reality: THREE.Object3D | null;
  splats: SplatMesh[];
  capsules: Capsule[];
  opacity: number;
  lightPerson: LightPerson;
  /** The person's linear light (the reflection and a relief mesh multiply by it; splats get it through the dyno). */
  lit: { value: number };
  /** Their contact shadow's and reflection's strength: up with reveal, and an extra's go with them in the room. */
  floorK: { value: number };
  /** A relief extra's (unlit) materials, faded like splats. */
  reliefMats: THREE.Material[];
  /** Court [x, z] under them, and whether that is inside the room's bounds (an extra there stays in the room). */
  foot: [number, number];
  inside: boolean;
}

export class Freeze {
  /** Seen fraction per player id (court.json seenFraction), for the Reality check's panel. */
  readonly seen: Record<string, number>;
  /** Everything frozen, in court space (a child of the world group). */
  readonly group = new THREE.Group();
  private readonly world: THREE.Group;
  private readonly bundle: CourtBundle;
  private readonly spark: SparkRenderer;
  private readonly light: LightField;
  private people: Person[] = [];
  private ball: THREE.Mesh | null = null;
  private readonly realityU = { value: 0 };
  private revealP = 0;
  private realityOn = false;
  /** The loads after load(): the Reality check's splats, started by allLoaded. */
  private readonly late: (() => Promise<void>)[] = [];
  private lateLoads: Promise<void> | null = null;
  private roomBounds: [number, number][] | null = null;

  /** Splats and maps go in `world` (court space). */
  constructor(world: THREE.Group, bundle: CourtBundle, spark: SparkRenderer, light: LightField) {
    this.world = world;
    this.bundle = bundle;
    this.spark = spark;
    this.light = light;
    this.seen = Object.fromEntries(bundle.court.freeze.players.map((p) => [p.id, p.seenFraction]));
    this.group.name = "court-freeze";
    this.group.visible = false;
    world.add(this.group);
    if (import.meta.env?.DEV && typeof window !== "undefined") {
      const w = window as unknown as { __courtLook?: Record<string, unknown> };
      (w.__courtLook ??= {}).freeze = this;
    }
  }

  /** Start the Reality check's splats (once; after load()), resolving when they are in. */
  allLoaded(): Promise<void> {
    this.lateLoads ??= Promise.all(this.late.map((start) => start())).then(() => {});
    return this.lateLoads;
  }

  /** Load every player's splats, the extras, the floor maps; build the ball. The reality splats follow (allLoaded). */
  async load(): Promise<void> {
    const light = this.light;
    const { court, frames } = this.bundle;
    const fz = court.freeze;
    const texLoader = new THREE.TextureLoader();
    const tex = async (path: string, color: boolean): Promise<THREE.Texture | null> => {
      try {
        const t = await texLoader.loadAsync(this.bundle.file(path));
        t.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        return t;
      } catch {
        return null;
      }
    };
    const splats = async (path: string): Promise<SplatMesh> => {
      // Spark fetches in its worker: its progress feeds the loading page's bar (loading.ts)
      loads.progress(path, 0, 0);
      const mesh = new SplatMesh({ url: this.bundle.file(path), onProgress: (e) => loads.progress(path, e.loaded, e.lengthComputable ? e.total : 0) });
      try {
        await mesh.initialized;
      } catch (e) {
        loads.failed(path, e);
        throw e;
      }
      loads.finished(path);
      return mesh;
    };
    const relief = async (path: string): Promise<THREE.Object3D> => {
      const { GLTFLoader } = await import("three/addons/loaders/GLTFLoader.js");
      return (await new GLTFLoader().loadAsync(this.bundle.file(path))).scene;
    };
    // a holder whose own splats hold the ball (freeze.ballInBody) keeps them all: their ball is the ball
    const eraseFor = (id: string) => (id === fz.ballInBody ? undefined : fz.ball.erase.find((e) => e.player === id));

    const addPerson = async (p: {
      id: string; pair: boolean; fromC: boolean; kind: "splats" | "body" | "relief"; file: string; reality: string;
      foot: [number, number]; capsules: Capsule[]; shadow: FloorMap; reflection: FloorMap;
    }) => {
      const lightPerson: LightPerson = p.pair ? { pair: true } : { foot: p.foot };
      const meshes: SplatMesh[] = [];
      const lit = { value: light.personLight(lightPerson) };
      // the person's light can move in any phase (the ease, the hand-off): refresh it as their maps or relief draw
      const refresh = () => (lit.value = light.personLight(lightPerson));
      const reliefMats: THREE.Material[] = [];
      const make = async (path: string): Promise<THREE.Object3D> => {
        if (p.kind === "relief") {
          const r = await relief(path);
          r.traverse((o) => {
            const mesh = o as THREE.Mesh;
            if (!mesh.isMesh) return;
            // a relief is the frame's own pixels: unlit (the court has no lights), then the field's light
            const src = ([] as THREE.Material[]).concat(mesh.material)[0] as THREE.MeshStandardMaterial;
            const m = new THREE.MeshBasicMaterial({ map: src.map ?? null, color: src.color ?? new THREE.Color(1, 1, 1), transparent: true });
            m.onBeforeCompile = (sh) => {
              sh.uniforms.uLit = lit;
              sh.fragmentShader = sh.fragmentShader
                .replace("#include <common>", "#include <common>\nuniform float uLit;")
                .replace("#include <opaque_fragment>", "outgoingLight *= uLit;\n#include <opaque_fragment>");
            };
            mesh.material = m;
            mesh.onBeforeRender = refresh;
            reliefMats.push(m);
          });
          return r;
        }
        const m = await splats(path);
        const e = eraseFor(p.id);
        if (e) {
          m.objectModifiers = [...(m.objectModifiers ?? []), eraseModifier(fz.ball.centre, e.radius)];
          m.updateGenerator();
        }
        light.modifier(m, lightPerson, dyno);
        meshes.push(m);
        return m;
      };
      const normal = await make(p.file);
      const person: Person = {
        id: p.id, pair: p.pair, fromC: p.fromC, normal, reality: null, splats: meshes, capsules: p.capsules, opacity: 1,
        lightPerson, lit, floorK: { value: 0 }, reliefMats, foot: p.foot, inside: inBounds(p.foot[0], p.foot[1], this.roomBounds),
      };
      const sub = new THREE.Group();
      sub.name = `court-freeze-${p.id}`;
      sub.add(normal);
      // the Reality check's splats load once the page is ready (allLoaded): only that button needs them, and they are
      // a quarter of the bundle's bytes, which a slow link would otherwise wait out on the loading page
      this.late.push(() =>
        make(p.reality)
          .then((reality) => {
            person.reality = reality;
            sub.add(reality);
            this.reality(this.realityOn);
            this.applyOpacity();
          })
          .catch(() => {}),
      );
      const [shadowMap, reflectMap] = await Promise.all([tex(p.shadow.image, false), tex(p.reflection.image, true)]);
      if (reflectMap) {
        const quad = floorQuad(p.reflection.rect, reflectionMaterial(reflectMap, person.floorK, person.lit, light), -11);
        quad.onBeforeRender = refresh;
        sub.add(quad);
      }
      if (shadowMap) sub.add(floorQuad(p.shadow.rect, shadowMaterial(shadowMap, person.floorK), -10));
      this.group.add(sub);
      this.people.push(person);
      return person;
    };

    // the pair is the show (a missing pair fails the load); an extra that won't load is left out, loudly
    await Promise.all([
      ...fz.players.map((p) => {
        const mid: [number, number] = [(p.bounds.min[0] + p.bounds.max[0]) / 2, (p.bounds.min[2] + p.bounds.max[2]) / 2];
        return addPerson({ id: p.id, pair: true, fromC: false, kind: "splats", file: p.splats, reality: p.reality, foot: mid, capsules: p.capsules, shadow: p.shadow, reflection: p.reflection });
      }),
      ...fz.others.map((o) =>
        addPerson({ id: o.id, pair: false, fromC: o.pose === "C", kind: o.kind, file: o.file, reality: o.reality, foot: [o.foot[0], o.foot[2]], capsules: [], shadow: o.shadow, reflection: o.reflection }).catch(
          (e: unknown) => console.error(`Court Side: extra "${o.id}" left out (${(e as Error)?.message ?? e})`),
        ),
      ),
    ]);

    // the ball: F's own pixels projected from camera F onto a sphere at freeze.ball, unless the holder's splats hold it
    // (freeze.ballInBody: a sphere there would draw a second ball)
    const fIndex = court.video.segments.eases[0]?.frames[1] ?? 0;
    const fr = frames[Math.min(frames.length - 1, fIndex)];
    const camF = { centre: court.camera.centre, q: fr.q, f: fr.f, cx: court.camera.cx, cy: court.camera.cy, width: court.camera.width, height: court.camera.height };
    const freezeTex = await tex(court.video.freeze, true);
    if (freezeTex) freezeTex.generateMipmaps = true;
    if (!fz.ballInBody) {
      this.ball = new THREE.Mesh(new THREE.SphereGeometry(fz.ball.radius, 48, 32), ballMaterial(light, freezeTex, camF, this.realityU));
      this.ball.position.set(...fz.ball.centre);
      this.ball.name = "court-ball";
      this.group.add(this.ball);
    }

    // the players' white point, for the arena's own lights (P13)
    const colors: number[] = [];
    for (const person of this.people.filter((x) => x.pair))
      for (const m of person.splats.slice(0, 1))
        m.forEachSplat((_i, _c, _s, _q, opacity, color) => {
          if (opacity > 0.5) colors.push(color.r, color.g, color.b);
        });
    if (colors.length) light.setWhite(colors);
  }

  /**
   * 0 = nothing drawn, 1 = the pair, the ball and the extras drawn (under the picture first), with shadows and
   * reflections at full strength. Never splat opacity: anything above 0 draws them whole.
   */
  reveal(p: number): void {
    this.revealP = Math.min(1, Math.max(0, p));
    this.group.visible = this.revealP > 0;
    this.applyOpacity();
  }

  /** The Reality check: swap in reality.ply, tint the ball's far side and the extras placed from C. */
  reality(on: boolean): void {
    this.realityOn = on;
    this.realityU.value = on ? 1 : 0;
    for (const p of this.people) {
      if (!p.reality) continue;
      p.normal.visible = !on;
      p.reality.visible = on;
    }
  }

  /**
   * The room's bounds in court space, [x, z] corners in order (court.ts after Seat here and every seat move; null when
   * there are none): in See my room an extra whose feet are inside stays, one beyond them goes with the arena (P34).
   */
  bounds(points: [number, number][] | null): void {
    this.roomBounds = points && points.length >= 3 ? points.map(([x, z]) => [x, z] as [number, number]) : null;
    for (const p of this.people) p.inside = inBounds(p.foot[0], p.foot[1], this.roomBounds);
    this.applyOpacity();
  }

  /** Once a frame: the capsule proximity fade (head in court space); the reflections follow their person's light. */
  update(head: Head, dt: number): void {
    for (const p of this.people) {
      if (p.capsules.length) p.opacity = fadeStep(p.opacity, nearBody(head.court, p.capsules), dt);
      p.lit.value = this.light.personLight(p.lightPerson);
    }
    this.applyOpacity();
  }

  /** A player's proximity fade now (1 = whole, FADE_TO = faded), for the e2e's P17 check. */
  opacityOf(id: string): number {
    return this.people.find((p) => p.id === id)?.opacity ?? NaN;
  }

  /**
   * The splats' opacity: the proximity fade (P17), and the extras beyond the room's bounds going with the arena in the
   * room (the pair, the ball and extras inside the bounds stay). Spark regenerates a mesh only when its opacity
   * changes. Shadows and reflections come up with reveal.
   */
  private applyOpacity(): void {
    const room = this.light.arenaOpacity().floor;
    for (const p of this.people) {
      const stays = p.pair || p.inside;
      const k = p.opacity * (stays ? 1 : room);
      for (const m of p.splats) if (m.opacity !== k) m.opacity = k;
      for (const m of p.reliefMats) m.opacity = k;
      p.floorK.value = this.revealP * (stays ? 1 : room);
    }
  }
}
