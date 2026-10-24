// proxies.ts, the parts that run without a GPU: a card's plane, the splat-depth proxy rasterised from camera F
// (distance along each ray, the ball included, dilated so a card morphs onto it without tearing), the GLB reader,
// the light chunk, and the two plate layers' alphas and visibility.
import "./ts-resolve.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Vec3 } from "../../src/court/format.ts";
import type { PinholeCamera } from "../../src/court/camera.ts";

const { Proxies } = await import("../../src/court/proxies.ts");
const THREE = await import("three");
const { cardPlane, depthBox, rasterDepth, dilateDepth, parseGlb, depthWeight, lightChunk, plateAlphas, layerVisibility, floorClips, behindStands, maskSurfaceHit } = await import("../../src/court/proxies.ts");
const { lookRotation, project, rayOf } = await import("../../src/court/camera.ts");

const close = (a: number, b: number, eps = 1e-9, what = "") => assert.ok(Math.abs(a - b) <= eps, `${what} ${a} vs ${b}`);
const C: Vec3 = [-22, 1, -9];
const PAIR: Vec3 = [6, 0, 1];
const camF = (): PinholeCamera => ({ centre: C, q: lookRotation([PAIR[0] - C[0], 1 - C[1], PAIR[2] - C[2]]), f: 25000, cx: 1919.5, cy: 1079.5, width: 3840, height: 2160 });

test("a person's card stands upright at their foot, square to the camera's horizontal ray; the ball's faces the camera", () => {
  const p = cardPlane([6, 0, 1], C, "person");
  close(p.normal[1], 0, 1e-12, "upright");
  const h = Math.hypot(6 - C[0], 1 - C[2]);
  close(p.normal[0], (6 - C[0]) / h, 1e-12);
  const b = cardPlane([6, 1.2, 1], C, "ball");
  const d = Math.hypot(6 - C[0], 1.2 - C[1], 1 - C[2]);
  close(b.normal[1], (1.2 - C[1]) / d, 1e-12);
});

/** A sphere of radius 0.3 at `at`, as a triangle mesh (the proxy stand-in for one body part). */
function sphereMesh(at: Vec3, r: number, n = 24) {
  const pos: number[] = [];
  const idx: number[] = [];
  for (let j = 0; j <= n; j++)
    for (let i = 0; i <= n; i++) {
      const th = (Math.PI * j) / n;
      const ph = (2 * Math.PI * i) / n;
      pos.push(at[0] + r * Math.sin(th) * Math.cos(ph), at[1] + r * Math.cos(th), at[2] + r * Math.sin(th) * Math.sin(ph));
    }
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i;
      idx.push(a, a + n + 1, a + 1, a + 1, a + n + 1, a + n + 2);
    }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

test("the depth proxy from camera F: each ray's distance to the nearest surface, the ball's front included", () => {
  const cam = camF();
  const body: Vec3 = [6, 1, 1];
  const mesh = sphereMesh(body, 0.3);
  const box = depthBox(cam, mesh.positions, 0.1);
  const w = 64;
  const h = 64;
  const ball = { centre: [6, 1, 0.7] as Vec3, radius: 0.12 };
  const d = rasterDepth(mesh.positions, mesh.indices, cam, box, w, h, ball);
  // the centre ray hits the sphere's front at about |body - C| - 0.3
  const centre = project(cam, body)!;
  const st = [((centre[0] + 0.5 - box[0]) / (box[2] - box[0])) * w, ((centre[1] + 0.5 - box[1]) / (box[3] - box[1])) * h];
  const k = Math.floor(st[1]) * w + Math.floor(st[0]);
  const expect = Math.hypot(body[0] - C[0], body[1] - C[1], body[2] - C[2]) - 0.3;
  close(d[k], expect, 0.01, "front of the body");
  // a ray through the ball's centre stops on the ball (in front of the body)
  const bc = project(cam, ball.centre)!;
  const kb = Math.floor(((bc[1] + 0.5 - box[1]) / (box[3] - box[1])) * h) * w + Math.floor(((bc[0] + 0.5 - box[0]) / (box[2] - box[0])) * w);
  const ray = rayOf(cam, bc[0], bc[1]);
  const toBall = Math.hypot(ball.centre[0] - C[0], ball.centre[1] - C[1], ball.centre[2] - C[2]);
  assert.ok(d[kb] > 0 && d[kb] < toBall, "on the ball's near side");
  void ray;
  // the corners miss
  assert.equal(d[0], 0);
  // dilation: holes filled from the neighbours, validity 1 on the body, falling to 0 a band away
  const { depth, valid } = dilateDepth(d, w, h, 6);
  assert.equal(valid[k], 1);
  assert.ok(depth[0] === 0 || valid[0] < 1);
  const edge = d.findIndex((v, i) => v === 0 && i > w * 32 && (d[i + 1] > 0 || d[i - 1] > 0));
  assert.ok(depth[edge] > 0 && valid[edge] > 0.5, "one texel off the silhouette: filled and still trusted");
});

test("a depth step in the proxy stays a step: triangles stretched across it are dropped, the gap filled from each side", () => {
  const cam = camF();
  // a grid in camera F's image: its left half at 25 m, its right half 1 m further, joined by one column of stretched cells
  const nu = 8;
  const nv = 8;
  const pos: number[] = [];
  const idx: number[] = [];
  for (let j = 0; j <= nv; j++)
    for (let i = 0; i <= nu; i++) {
      const u = 1800 + i * 30;
      const v = 900 + j * 30;
      const r = rayOf(cam, u, v);
      const t = i <= nu / 2 ? 25 : 26;
      pos.push(...r.dir.map((d, k) => r.origin[k] + d * t));
    }
  for (let j = 0; j < nv; j++)
    for (let i = 0; i < nu; i++) {
      const a = j * (nu + 1) + i;
      idx.push(a, a + nu + 1, a + 1, a + 1, a + nu + 1, a + nu + 2);
    }
  const box: [number, number, number, number] = [1800.5, 900.5, 2040.5, 1140.5];
  const w = 48;
  const h = 48;
  const raw = rasterDepth(new Float32Array(pos), new Uint32Array(idx), cam, box, w, h);
  const { depth } = dilateDepth(raw, w, h, 12);
  // the stretched column spans texels 24-30 (u 1920-1950): its left texels take the near side, its right the far
  const row = 20;
  close(depth[row * w + 25], 25, 0.05, "just right of the step's start: near");
  close(depth[row * w + 29], 26, 0.05, "just left of its end: far");
  close(depth[row * w + 10], 25, 0.01, "left half");
  close(depth[row * w + 40], 26, 0.01, "right half");
});

test("a continuous slanted surface keeps its depth, however far its corners are apart (only a step seen edge-on is cut)", () => {
  const cam = camF();
  // two triangles, 1 m wide and 2 m tall at ~29.5 m, turning 0.4 m away across their width (a stands plane or a
  // backboard at an angle): each spans more than 0.1 m of depth, all of it real surface
  const corner = (u: number, v: number, t: number) => {
    const r = rayOf(cam, u, v);
    return r.dir.map((d, k) => r.origin[k] + d * t);
  };
  const [u0, u1, v0, v1] = [1500, 2347, 700, 2395];
  const positions = new Float32Array([...corner(u0, v0, 29.5), ...corner(u1, v0, 29.9), ...corner(u1, v1, 29.9), ...corner(u0, v1, 29.5)]);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
  const box: [number, number, number, number] = [u0 + 0.5, v0 + 0.5, u1 + 0.5, v1 + 0.5];
  const raw = rasterDepth(positions, indices, cam, box, 32, 64);
  const hits = Array.from(raw).filter((d) => d > 0).length;
  assert.ok(hits > 32 * 64 * 0.9, `${hits} of ${32 * 64} texels have the surface`);
  const row = Array.from(raw.slice(32 * 32, 33 * 32));
  close(row[0], 29.5, 0.03, "the near edge");
  close(row[31], 29.9, 0.03, "the far edge");
  assert.ok(row.every((d, i) => i === 0 || d > row[i - 1]), "turning away steadily across its width");
});

test("GLB: positions and indices of every mesh, node transforms applied", () => {
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const idx = new Uint16Array([0, 1, 2]);
  const bin = new Uint8Array(pos.byteLength + 8);
  bin.set(new Uint8Array(pos.buffer), 0);
  bin.set(new Uint8Array(idx.buffer), pos.byteLength);
  const json = {
    asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, translation: [10, 0, 0] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }], buffers: [{ byteLength: bin.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 6 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" }, { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" }],
  };
  let jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const pad = (4 - (jsonBytes.length % 4)) % 4;
  jsonBytes = new Uint8Array([...jsonBytes, ...new Array(pad).fill(0x20)]);
  const total = 12 + 8 + jsonBytes.length + 8 + bin.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.length, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  dv.setUint32(20 + jsonBytes.length, bin.length, true);
  dv.setUint32(24 + jsonBytes.length, 0x004e4942, true);
  out.set(bin, 28 + jsonBytes.length);
  const g = parseGlb(out.buffer);
  assert.deepEqual([...g.positions], [10, 0, 0, 11, 0, 0, 10, 1, 0]);
  assert.deepEqual([...g.indices], [0, 1, 2]);
});

test("the card depth weight: 1 on F, 0 a third of a second of real time away, smooth between", () => {
  close(depthWeight(600, 600, 180), 1, 0);
  close(depthWeight(600 - 0.36 * 180, 600, 180), 0, 1e-12);
  close(depthWeight(600 + 0.5 * 180, 600, 180), 0, 0);
  const a = depthWeight(600 - 10, 600, 180);
  assert.ok(a > 0 && a < 1);
});

test("the light chunk: lightfield.ts's GLSL as given, with any helper the stub lacks filled in as 1 (no dither, the arena, the pair at full light)", () => {
  const stub = "float courtLight(vec3 worldPos, float part) { return 1.0; }\n";
  const filled = lightChunk(stub);
  assert.ok(filled.startsWith(stub), "the field's own GLSL first");
  for (const name of ["vec3 lightDither(", "float lightRoomStands(", "float lightRoomFloor(", "float lightPair("]) assert.ok(filled.includes(name), name);
  const full = `${stub}float lightPair() { return uLightLevel.z; }\nfloat lightRoomStands() { return uLightView.y; }\nfloat lightRoomFloor() { return uLightView.z; }\nvec3 lightDither(vec3 rgb) { return rgb + 0.0; }\n`;
  assert.equal(lightChunk(full), full, "nothing added when the field has them all");
});

test("the two plate layers stacked are always the one plate at the frame's feathered alpha, See my room's fade included (P44)", () => {
  for (const room of [1, 0.6, 0.2, 0])
    for (const f of [0, 0.1, 0.37, 0.8, 1])
      for (const v of [0, 0.01, 0.25, 0.5, 0.75, 0.99, 1]) {
        const { video, background } = plateAlphas(v, f, room);
        // the 3D's plates draw first (under the splats), the video's over them
        const stacked = video + (1 - video) * background;
        assert.ok(Math.abs(stacked - f * room) < 1e-9, `v ${v} f ${f} room ${room}: ${stacked}`);
        assert.ok(Math.abs(video - v * f * room) < 1e-12, "the video layer at its opacity");
      }
});

test("the floor plate stops at the stands: no floor behind a stands plane, where it would show through the stands from the seat", () => {
  const wall = [[16, 0, -16], [16, 0, 16], [16, 9, 16], [16, 9, -16]] as [Vec3, Vec3, Vec3, Vec3];
  const clips = floorClips([wall], [0, 0, 0]);
  assert.equal(clips.length, 1);
  assert.equal(behindStands([20, 0, 0], clips), true, "behind the wall");
  assert.equal(behindStands([10, 0, 0], clips), false, "the court side");
  assert.equal(behindStands([20, 0, 30], clips), false, "past the wall's end: nothing hides it");
  assert.equal(behindStands([-20, 0, 0], clips), false, "the other side of the court");
  // a wall described the other way round clips the same side
  const reversed = floorClips([[wall[1], wall[0], wall[3], wall[2]]], [0, 0, 0]);
  assert.equal(behindStands([20, 0, 0], reversed), true);
  assert.equal(behindStands([10, 0, 0], reversed), false);
});

test("the cinema mask finds the surface each view ray meets (floor or stands, as the plates do), so its dark matches the picture's edge", () => {
  const wall = [[16, 0, -16], [16, 0, 16], [16, 9, 16], [16, 9, -16]] as [Vec3, Vec3, Vec3, Vec3];
  const clips = floorClips([wall], [0, 0, 0]);
  assert.deepEqual(clips[0].y, [0, 9]);
  const eye: Vec3 = [0, 1.2, 0];
  const at = (to: Vec3) => maskSurfaceHit(eye, [to[0] - eye[0], to[1] - eye[1], to[2] - eye[2]], clips);
  const wallHit = at([16, 4, 0]);
  assert.equal(wallHit.kind, 1);
  close(wallHit.point[0], 16, 1e-9);
  close(wallHit.point[1], 4, 1e-9);
  const floorHit = at([2.4, 0, 0]);
  assert.equal(floorHit.kind, 0);
  close(floorHit.point[0], 2.4, 1e-9);
  assert.equal(at([16, 12, 0]).kind, -1, "over the stands: nothing (the mask is fully dark there)");
  // toward the floor behind the wall: the wall is met first
  const behind = at([25, 0, 0]);
  assert.equal(behind.kind, 1);
  close(behind.point[0], 16, 1e-9);
  assert.equal(at([0, 0, 45]).kind, -1, "past the floor's edge");
});

test("what each layer draws: the video's plates while the picture or the mask's dark shows, its cards with the picture, the 3D's plates once it fades", () => {
  assert.deepEqual(layerVisibility(1, 0), { plates: true, cards: true, background: false }, "the watch");
  assert.deepEqual(layerVisibility(0.5, 0.5), { plates: true, cards: true, background: true }, "mid fade");
  assert.deepEqual(layerVisibility(0, 0.5), { plates: true, cards: false, background: true }, "faded, the mask still lifting");
  assert.deepEqual(layerVisibility(0, 1), { plates: false, cards: false, background: true }, "the open world");
});

test("dispose() frees every geometry, material and texture the proxies made (the surfaces, the card grid, the mask's shell)", () => {
  const court = {
    camera: { centre: C, cx: 1919.5, cy: 1079.5, width: 3840, height: 2160 },
    video: { segments: { pass2: [0, 1], eases: [{ start: 0, frames: [0, 1], seconds: 1 }] } },
    freeze: { players: [] },
  };
  const frames = [0, 1].map(() => ({ src: 0, interp: false, q: [0, 0, 0, 1], f: 25000 }));
  const video = { listen: () => {}, opacity: 1, maskLevel: 0, wipeLevel: 0, stats: { onScreen: -1 } };
  const light = { glsl: "float courtLight(vec3 p, float part) { return 1.0; }\n", uniforms: {} };
  const proxies = new Proxies(null as never, { court, frames, cards: [] } as never, video as never, light as never);
  const freed: string[] = [];
  const watch = <T extends { dispose(): void }>(o: T, name: string) => {
    o.addEventListener?.("dispose", () => freed.push(name));
    return o;
  };
  const geometry = watch(new THREE.PlaneGeometry(1, 1) as never, "geometry");
  const material = watch(new THREE.MeshBasicMaterial() as never, "material");
  proxies.group.add(new THREE.Mesh(geometry, material));
  proxies.group.add(new THREE.Mesh(geometry, material)); // shared: freed once
  proxies.dispose();
  assert.deepEqual(freed.sort(), ["geometry", "material"]);
});
