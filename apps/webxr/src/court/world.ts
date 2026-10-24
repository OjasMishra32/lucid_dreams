// The arena around the footage: the court floor (the footage's own floor inside floor-seen, the rendered rulebook
// court elsewhere: hardwood from court.json, navy three-point and halfcourt lines, dark beyond the apron), falling to
// dark outside the camera's frame during the watch and lit afterwards only where the light field's pool reaches; it
// writes no depth, so reflections show. Around it structured darkness (a dim seating bowl, never filmed), house-light
// glows that ignite in sequence at the arrival and take the players' white point (P13), and the 3D hoop at
// court.rim (props.ts standaloneHoop, placed and turned to face the play). Every surface is multiplied by the one
// light field (lightfield.ts); the courtside plate dims off camera F's ray through Proxies.dim (P30). The black BackSide dome is drawn first (no depth test or write) and writes (0, 0, 0, a):
// three 0.186 clears to (0, 0, 0, 0) in an alpha-blend session (three.module.js:1379-1381), so the dome is what makes
// the arena opaque (P33). See my room and the always-on edge fade lower it and the arena's surfaces (P34, P35); the
// Reality check tints everything not filmed blue (P23). Stream E (`look`) builds it.
import * as THREE from "three";
import { standaloneHoop } from "../props";
import { cameraOf, type PinholeCamera } from "./camera";
import type { CourtBundle } from "./format";
import { PART, REACH_GLSL, edgeLevel, linear, ramp, reachAt, reachPlanes, roomCurves, veil, type LightField, type LightSet } from "./lightfield";
import type { Proxies } from "./proxies";
import { EDGE_FADE } from "./seatmath";
import type { Head } from "./types";

/** True once stream E has built this module. */
export const BUILT = true;

/** Rendered court colours (linear): white lines, navy three-point and halfcourt lines (this court), navy lane paint. */
const LINE_WHITE = new THREE.Color().setRGB(0.72, 0.72, 0.69);
const LINE_NAVY = new THREE.Color().setRGB(0.012, 0.022, 0.07);
const LANE_PAINT = new THREE.Color().setRGB(0.014, 0.03, 0.095);
/** The out-of-bounds apron (a deeper stain of the hardwood), metres past the lines, and the arena floor beyond it. */
const APRON_M = 2.0;
const APRON_STAIN = 0.62;
const ARENA_FLOOR = new THREE.Color().setRGB(0.004, 0.004, 0.005);
/** The seating bowl: tiers from this far past the sidelines / baselines, never filmed. */
const BOWL = { side: 3.2, end: 3.6, tiers: 7, depth: 0.85, rise: 0.42, base: 0.45 };
/** The house lights: fixtures over the court, igniting one after another over the arrival's first 60%. */
const FIXTURES: [number, number][] = [[-10.5, -5], [-3.5, -5], [3.5, -5], [10.5, -5], [-10.5, 5], [-3.5, 5], [3.5, 5], [10.5, 5]];
const FIXTURE_Y = 11.5;
const REALITY_BLUE = new THREE.Vector3(0.1, 0.28, 1.0);

const FLOOR_VERTEX = /* glsl */ `
VERTEX_LIGHT
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vLightCourt = lightCourt(w);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const FLOOR_FRAGMENT = /* glsl */ `
FRAGMENT_LIGHT
varying vec3 vLightCourt;
REACH
uniform sampler2D uFloorMap;
uniform sampler2D uSeenMap;
uniform float uHasFloor;
uniform vec4 uCourt;    // half length, half width, apron, basket from the baseline
uniform vec3 uWood;
uniform vec3 uApron;
uniform vec3 uDark;
uniform vec3 uWhite;
uniform vec3 uNavy;
uniform vec3 uPaint;
uniform vec3 uBlue;
uniform float uReality;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float lineMask(float d, float hw) {
  float aa = max(fwidth(d), 1e-4);
  return 1.0 - smoothstep(hw - aa, hw + aa, d);
}
float box(vec2 q, vec2 h) {
  vec2 d = abs(q) - h;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}
float segment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
}
// the rulebook court (NBA): boards along x, the lines, the lane paint; 1 = inside the court in w
vec3 rulebook(vec2 p, out float court) {
  float board = floor(p.y / 0.057);
  float plank = floor((p.x + hash(vec2(board, 1.0)) * 2.4) / 2.4);
  float grain = (hash(vec2(board, plank)) - 0.5) * 0.12 * (1.0 - smoothstep(0.01, 0.06, fwidth(p.y)));
  vec3 wood = uWood * (1.0 + grain);
  vec2 a = abs(p);
  court = step(a.x, uCourt.x) * step(a.y, uCourt.y);
  float apron = step(a.x, uCourt.x + uCourt.z) * step(a.y, uCourt.y + uCourt.z);
  vec3 col = mix(uDark, mix(uApron * (1.0 + grain), wood, court), apron);
  float hw = 0.0254;
  vec2 q = vec2(a.x, p.y); // each end mirrored onto +x
  vec2 c = vec2(uCourt.x - uCourt.w, 0.0); // the basket
  float zc = uCourt.y - 0.91;
  float R = 7.24;
  float xa = c.x - sqrt(max(R * R - zc * zc, 0.0));
  // the lane and its paint
  vec2 laneC = vec2(uCourt.x - 2.895, 0.0);
  float lane = box(q - laneC, vec2(2.895, 2.44));
  col = mix(col, uPaint, step(lane, 0.0) * court);
  float white = lineMask(abs(box(p, vec2(uCourt.x, uCourt.y) - hw)), hw);  // sidelines and baselines
  white = max(white, lineMask(abs(lane), hw) * step(q.x, uCourt.x));
  white = max(white, lineMask(abs(length(p) - 1.83), hw));                  // centre circle
  vec2 ft = vec2(uCourt.x - 5.79, 0.0);
  white = max(white, lineMask(abs(length(q - ft) - 1.83), hw) * step(q.x, ft.x)); // free-throw circle
  white = max(white, lineMask(abs(length(q - c) - 1.22), hw) * step(q.x, c.x));   // restricted area
  float navy = lineMask(a.x, hw) * step(a.y, uCourt.y);                     // halfcourt
  float three = min(segment(q, vec2(xa, zc), vec2(uCourt.x, zc)), segment(q, vec2(xa, -zc), vec2(uCourt.x, -zc)));
  if (q.x <= xa) three = min(three, abs(length(q - c) - R));
  navy = max(navy, lineMask(three, hw));
  col = mix(col, uWhite, white * court);
  col = mix(col, uNavy, navy * court);
  return col;
}
void main() {
  vec2 p = vLightCourt.xz;
  float court;
  vec3 col = rulebook(p, court);
  vec2 uv = vec2((p.x + uCourt.x) / (2.0 * uCourt.x), 1.0 - (p.y + uCourt.y) / (2.0 * uCourt.y));
  float seen = texture2D(uSeenMap, uv).r * court * uHasFloor;
  col = mix(col, texture2D(uFloorMap, uv).rgb, seen);
  col *= lightFloor(p, lightReach(vLightCourt));
  col = mix(col, uBlue * (0.04 + dot(col, vec3(0.2126, 0.7152, 0.0722))), (1.0 - seen) * 0.75 * uReality);
  gl_FragColor = vec4(col, lightRoomFloor());
  #include <colorspace_fragment>
  gl_FragColor.rgb = lightDither(gl_FragColor.rgb);
}
`;

const BOWL_FRAGMENT = /* glsl */ `
FRAGMENT_LIGHT
varying vec3 vLightCourt;
uniform vec3 uBlue;
uniform float uReality;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  // a dim crowd of muted colours: a person every 0.5 m along the tier, head and shirt rows on each riser
  vec3 w = vLightCourt;
  vec2 cell = floor(vec2(w.x + w.z, w.y) / vec2(0.32, 0.21));
  float h = hash(cell);
  vec3 tint = vec3(0.9 + 0.2 * hash(cell + 3.0), 0.85 + 0.2 * hash(cell + 5.0), 0.8 + 0.3 * hash(cell + 9.0));
  vec3 shirt = mix(vec3(0.004, 0.004, 0.005), vec3(0.008, 0.0075, 0.007) * tint * (0.7 + 0.6 * hash(cell + 7.0)), step(0.3, h));
  shirt *= 1.0 - 0.5 * smoothstep(0.5, 3.5, w.y); // the upper rows fall into the dark
  vec3 col = shirt * lightHouse();
  col = mix(col, uBlue * (0.03 + dot(col, vec3(0.2126, 0.7152, 0.0722))), 0.75 * uReality);
  gl_FragColor = vec4(col, lightRoomStands());
  #include <colorspace_fragment>
  gl_FragColor.rgb = lightDither(gl_FragColor.rgb);
}
`;

/** The e2e's handle on the look (dev only). */
export function look(): Record<string, unknown> {
  const w = window as unknown as { __courtLook?: Record<string, unknown> };
  return (w.__courtLook ??= {});
}

/**
 * Blend over the room by the shader's alpha, staying in the opaque list (three turns NormalBlending off there). The
 * colour goes over the black dome; the alpha takes the larger of the two (MaxEquation ignores the factors), so a
 * half-faded floor over a half-faded dome opens the room by the same amount as the dome alone, with no step where
 * the floor ends.
 */
function overRoom(m: THREE.Material): void {
  m.blending = THREE.CustomBlending;
  m.blendSrc = THREE.SrcAlphaFactor;
  m.blendDst = THREE.OneMinusSrcAlphaFactor;
  m.blendEquationAlpha = THREE.MaxEquation;
  m.blendSrcAlpha = THREE.OneFactor;
  m.blendDstAlpha = THREE.OneFactor;
}

/** A soft radial glow (the fixtures), white: tinted per sprite. */
function glowTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, "rgba(255,255,255,1)");
  r.addColorStop(0.18, "rgba(255,255,255,0.55)");
  r.addColorStop(0.5, "rgba(255,255,255,0.12)");
  r.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = r;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** The seating bowl's tiers round the court (one merged geometry, court space). */
function bowlGeometry(halfL: number, halfW: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const add = (w: number, h: number, d: number, x: number, y: number, z: number, rotY: number) => {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(0, y, 0);
    g.rotateY(rotY);
    g.translate(x, 0, z);
    parts.push(g);
  };
  // farthest tier first: the bowl writes no depth (the footage's stands proxy must paint over it), so nearer tiers
  // are drawn over farther ones in index order
  for (let i = BOWL.tiers - 1; i >= 0; i--) {
    const h = BOWL.base + i * BOWL.rise;
    const ds = halfW + BOWL.side + (i + 0.5) * BOWL.depth;
    const de = halfL + BOWL.end + (i + 0.5) * BOWL.depth;
    const lenS = 2 * (halfL + BOWL.end);
    const lenE = 2 * (halfW + BOWL.side);
    add(lenS, h, BOWL.depth, 0, h / 2, ds, 0);
    add(lenS, h, BOWL.depth, 0, h / 2, -ds, 0);
    add(lenE, h, BOWL.depth, de, h / 2, 0, Math.PI / 2);
    add(lenE, h, BOWL.depth, -de, h / 2, 0, Math.PI / 2);
  }
  let total = 0;
  for (const p of parts) total += p.getAttribute("position").count;
  const pos = new Float32Array(total * 3);
  const index: number[] = [];
  let at = 0;
  for (const p of parts) {
    const n = p.getAttribute("position").count;
    pos.set(p.getAttribute("position").array as Float32Array, at * 3);
    for (const i of p.getIndex()!.array) index.push(i + at);
    at += n;
    p.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setIndex(index);
  return g;
}

export class CourtWorld {
  /** The black dome, in room space around the head, drawn first: opaque arena = 1, the room = 0. */
  readonly dome: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  /** The one light field (court.ts's, shared with proxies.ts and freeze.ts). */
  readonly light: LightField;
  /** Everything the arena draws in court space (a child of the world group). */
  readonly group = new THREE.Group();
  private readonly renderer: THREE.WebGLRenderer;
  private readonly bundle: CourtBundle;
  private readonly world: THREE.Group;
  private readonly proxies: Proxies;
  private readonly reachU = { uReachCentre: { value: new THREE.Vector3() }, uReachPlanes: { value: [0, 1, 2, 3].map(() => new THREE.Vector4()) } };
  private readonly realityU = { value: 0 };
  private readonly blueU = { value: REALITY_BLUE.clone() };
  private floor: THREE.Mesh | null = null;
  private glows: { sprite: THREE.Sprite; delay: number }[] = [];
  private hoop: THREE.Group | null = null;
  private hoopMats: { m: THREE.Material; base: number }[] = [];
  private readonly hoopK = { value: 1 };
  private readonly hoopReality = { value: 0 };
  // the room and edge state (court.ts calls room(p) then edge(d) every frame)
  private roomP = 0;
  private edgeD = Infinity;
  private veilT = -1;
  private dtEst = 1 / 72;
  private openP = 0;
  /** The arena's opacity now (stands and darkness, floor), for the e2e report. */
  readonly arena = { stands: 1, floor: 1, dome: 1 };

  /** `world` is the world group (court space); the dome goes in `scene` (room space). */
  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, world: THREE.Group, bundle: CourtBundle, light: LightField, proxies: Proxies) {
    this.renderer = renderer;
    this.bundle = bundle;
    this.world = world;
    this.light = light;
    this.proxies = proxies;
    // the field from court.json alone (court.ts) learns camera F's own ray and frame, the chosen set (?light=alt, the
    // dark set shown at Q2) and D' (?seat=, as seat.ts reads it) for the lane to the seat
    const params = typeof location === "undefined" ? new URLSearchParams() : new URLSearchParams(location.search);
    const set: LightSet = params.get("light") === "alt" ? "alternative" : "main";
    const seat = params.has("seat") ? Number(params.get("seat")) : undefined;
    light.fitFrames(bundle.frames);
    light.select({ set, seatDistance: seat });
    this.dome = new THREE.Mesh(
      new THREE.SphereGeometry(50, 16, 8),
      // opaque and first in the opaque list: a `transparent` material would be sorted after every opaque object and,
      // with no depth test, paint over them. NoBlending writes (0, 0, 0, opacity) as it is: 1 = the arena, a half-
      // faded dome dims the room under it (alpha is premultiplied: the 50% veil).
      new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide, depthTest: false, depthWrite: false, blending: THREE.NoBlending }),
    );
    this.dome.renderOrder = -1000;
    this.dome.frustumCulled = false;
    scene.add(this.dome);
    this.group.name = "court-arena";
    world.add(this.group);
    // the e2e's handle (dev only): scripts/court/scenarios/{room,look}.mjs drive the field and the edge directly
    if (import.meta.env.DEV) look().world = this;
  }

  /** e2e only: a simulated distance to the bounds (null: court.ts's own, from seat.ts). */
  testEdge: number | null = null;

  /** Build the floor, bowl, glows and hoop; load floor.jpg and floor-seen.png. */
  async load(): Promise<void> {
    const { court, frames } = this.bundle;
    const c = court.court;
    const halfL = c.length / 2;
    const halfW = c.width / 2;
    const loader = new THREE.TextureLoader();
    const [floorMap, seenMap] = await Promise.all([
      loader.loadAsync(this.bundle.file(c.floor)).catch(() => null),
      loader.loadAsync(this.bundle.file(c.floorSeen)).catch(() => null),
    ]);
    const aniso = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    if (floorMap) {
      floorMap.colorSpace = THREE.SRGBColorSpace;
      floorMap.anisotropy = aniso;
    }
    if (seenMap) {
      seenMap.colorSpace = THREE.NoColorSpace;
      seenMap.anisotropy = aniso;
    }
    const wood = new THREE.Color().setRGB(c.hardwood[0], c.hardwood[1], c.hardwood[2], THREE.SRGBColorSpace);
    const light = this.light;

    // the floor: court, apron and the dark arena floor out to the bowl
    const size = 2 * (halfL + BOWL.end + 1);
    const floorGeo = new THREE.PlaneGeometry(size, 2 * (halfW + BOWL.side + 1), 1, 1);
    floorGeo.rotateX(-Math.PI / 2);
    const floorMat = new THREE.ShaderMaterial({
      uniforms: {
        ...light.uniforms,
        ...this.reachU,
        uFloorMap: { value: floorMap },
        uSeenMap: { value: seenMap },
        uHasFloor: { value: floorMap && seenMap ? 1 : 0 },
        uCourt: { value: new THREE.Vector4(halfL, halfW, APRON_M, halfL - Math.abs(c.rim[0])) },
        uWood: { value: new THREE.Vector3(wood.r, wood.g, wood.b) },
        uApron: { value: new THREE.Vector3(wood.r, wood.g, wood.b).multiplyScalar(APRON_STAIN) },
        uDark: { value: new THREE.Vector3(ARENA_FLOOR.r, ARENA_FLOOR.g, ARENA_FLOOR.b) },
        uWhite: { value: new THREE.Vector3(LINE_WHITE.r, LINE_WHITE.g, LINE_WHITE.b) },
        uNavy: { value: new THREE.Vector3(LINE_NAVY.r, LINE_NAVY.g, LINE_NAVY.b) },
        uPaint: { value: new THREE.Vector3(LANE_PAINT.r, LANE_PAINT.g, LANE_PAINT.b) },
        uBlue: this.blueU,
        uReality: this.realityU,
      },
      vertexShader: FLOOR_VERTEX.replace("VERTEX_LIGHT", light.glslVertex),
      fragmentShader: FLOOR_FRAGMENT.replace("FRAGMENT_LIGHT", light.glsl).replace("REACH", REACH_GLSL),
      depthWrite: false,
    });
    overRoom(floorMat);
    this.floor = new THREE.Mesh(floorGeo, floorMat);
    this.floor.name = "court-floor";
    this.floor.renderOrder = -900;
    this.floor.frustumCulled = false;
    this.group.add(this.floor);

    // the seating bowl: structured darkness, lit only by the house
    const bowlMat = new THREE.ShaderMaterial({
      uniforms: { ...light.uniforms, uBlue: this.blueU, uReality: this.realityU },
      vertexShader: FLOOR_VERTEX.replace("VERTEX_LIGHT", light.glslVertex),
      fragmentShader: BOWL_FRAGMENT.replace("FRAGMENT_LIGHT", light.glsl),
      depthWrite: false,
    });
    overRoom(bowlMat);
    const bowl = new THREE.Mesh(bowlGeometry(halfL, halfW), bowlMat);
    bowl.name = "court-bowl";
    bowl.renderOrder = -890;
    bowl.frustumCulled = false;
    this.group.add(bowl);

    // the house lights over the court
    const tex = glowTexture();
    this.glows = FIXTURES.map(([x, z], i) => {
      const m = new THREE.SpriteMaterial({ map: tex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false });
      const sprite = new THREE.Sprite(m);
      sprite.position.set(x, FIXTURE_Y, z);
      sprite.scale.setScalar(1.4);
      sprite.renderOrder = -880;
      this.group.add(sprite);
      return { sprite, delay: (i / FIXTURES.length) * 0.6 };
    });

    // the hoop at the rim the play attacks, facing centre court; lit by the field where it stands
    const hoop = standaloneHoop(this.renderer);
    const outer = new THREE.Group();
    outer.name = "court-hoop";
    outer.add(hoop);
    outer.position.set(c.rim[0], c.rim[1] - 3.05, c.rim[2]);
    outer.rotation.y = Math.atan2(-Math.sign(c.rim[0]) || -1, 0);
    hoop.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.renderOrder = -5; // before the splats (they write no depth): players in front of the hoop stay in front
      for (const m of ([] as THREE.Material[]).concat(mesh.material)) {
        if (this.hoopMats.some((h) => h.m === m)) continue;
        this.hoopMats.push({ m, base: m.opacity });
        // fade with the arena without recompiling: transparent from the start (opacity 1 still writes alpha 1)
        m.transparent = true;
        const prev = m.onBeforeCompile;
        m.onBeforeCompile = (sh, r) => {
          prev.call(m, sh, r);
          sh.uniforms.uHoopK = this.hoopK;
          sh.uniforms.uHoopReality = this.hoopReality;
          sh.uniforms.uBlue = this.blueU;
          sh.fragmentShader = sh.fragmentShader
            .replace("#include <common>", "#include <common>\nuniform float uHoopK;\nuniform float uHoopReality;\nuniform vec3 uBlue;")
            .replace(
              "#include <opaque_fragment>",
              "outgoingLight *= uHoopK;\noutgoingLight = mix(outgoingLight, uBlue * (0.03 + dot(outgoingLight, vec3(0.2126, 0.7152, 0.0722))), 0.75 * uHoopReality);\n#include <opaque_fragment>",
            );
        };
        m.customProgramCacheKey = () => `court-hoop-${m.type}`;
        m.needsUpdate = true;
      }
    });
    this.hoop = outer;
    this.group.add(outer);

    // the frame's reach: camera F's until court.ts hands over the show frame (frame(n)); the hand-off and the open
    // world are lit under F's frame
    const fIndex = court.video.segments.eases[0]?.frames[1] ?? court.video.segments.pass1[0];
    if (frames.length) this.frustum(cameraOf(court, frames[Math.min(frames.length - 1, fIndex)]));
    this.refresh();
  }

  /** The arena after the hand-off: 0 = the watch's look, 1 = the world as the pool leaves it (the field does the light). */
  open(p: number): void {
    this.openP = Math.min(1, Math.max(0, p));
  }

  /** The show frame on screen (court.ts, with proxies.project): the rendered court's darkness falloff follows its frame. */
  frame(showFrame: number): void {
    const f = this.bundle.frames[showFrame];
    if (f) this.frustum(cameraOf(this.bundle.court, f));
  }

  /** See my room: 0 = the arena, 1 = the room (darkness and stands first, then the floor; a 50% veil eases off). */
  room(p: number): void {
    const q = Math.min(1, Math.max(0, p));
    // the frame's dt from roomP's own steps (court.ts passes no dt here); a step that hit 0 or 1 is cut short, so skip it
    if (q !== this.roomP && q > 0 && q < 1) this.dtEst = Math.min(0.1, Math.abs(q - this.roomP) * (q > this.roomP ? 0.6 : 0.8));
    if (q > 0 && this.roomP === 0 && q > this.roomP) this.veilT = 0; // the toggle: the veil starts
    else if (this.veilT >= 0) this.veilT += this.dtEst;
    if (q === 0) this.veilT = -1;
    this.roomP = q;
    this.refresh();
  }

  /** The edge fade, every frame: metres to the bounds; the room opens from EDGE_FADE[0] and is fully open at EDGE_FADE[1]. */
  edge(distance: number): void {
    this.edgeD = this.testEdge === null ? distance : Math.min(distance, this.testEdge);
    this.refresh();
  }

  /** The Reality check: tint everything the camera never filmed (the rendered court, the bowl, the hoop). */
  reality(on: boolean): void {
    this.realityU.value = on ? 1 : 0;
    this.hoopReality.value = on ? 1 : 0;
  }

  /** The show frame's camera: the rendered court's darkness falloff follows its frame. */
  frustum(camera: PinholeCamera): void {
    const r = reachPlanes(camera);
    this.light.setReach(r);
    this.reachU.uReachCentre.value.set(r.centre[0], r.centre[1], r.centre[2]);
    r.planes.forEach((pl, i) => this.reachU.uReachPlanes.value[i].set(pl[0], pl[1], pl[2], pl[3]));
  }

  /** Once a frame: the dome follows the head; the field learns where the court is; the plate dims off the ray (P30). */
  update(head: Head): void {
    this.dome.position.set(head.room[0], head.room[1], head.room[2]);
    this.light.frame(this.world);
    this.proxies.dim(this.light.offRayAt(head.court[0], head.court[2]));
    this.refresh();
  }

  /** The arena's opacity from See my room and the edge, onto the dome, the field and the hoop; the lights' levels. */
  private refresh(): void {
    const curves = roomCurves(this.roomP);
    const e = edgeLevel(this.edgeD, EDGE_FADE);
    const stands = Math.min(curves.stands, e);
    const floor = Math.min(curves.floor, e);
    const dome = Math.max(stands, veil(this.veilT) * e);
    this.arena.stands = stands;
    this.arena.floor = floor;
    this.arena.dome = dome;
    this.dome.material.opacity = dome;
    this.light.room(stands, floor);
    const rim = this.bundle.court.court.rim;
    const reach = this.light.reach ? reachAt(this.light.reach, [rim[0], 0, rim[2]]) : 1;
    this.hoopK.value = this.light.at(rim[0], rim[2], PART.floor, reach);
    for (const { m, base } of this.hoopMats) m.opacity = base * floor;
    // the house lights: each ignites on its own curve at the arrival, then follows the house; tinted to the players' white
    const house = this.light.crowdLevelNow;
    const w = this.light.white;
    const norm = Math.max(w[0], w[1], w[2]);
    for (const { sprite, delay } of this.glows) {
      const k = 0.55 * linear(house * ramp((this.light.arrivalNow - delay) / 0.4)) * stands;
      sprite.material.color.setRGB((w[0] / norm) * k, (w[1] / norm) * k, (w[2] / norm) * k);
      sprite.material.opacity = stands;
    }
  }
}
