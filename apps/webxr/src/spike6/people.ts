import * as THREE from "three";
import { PackedSplats, SplatMesh } from "@sparkjsdev/spark";
import { framePath, dreamUrl, type Dream } from "../dream";

type Point = [number, number, number];
type Capsule = { a: Point; b: Point; radius: number; color: THREE.Color; weight: number };

export const FREEZE_AT = 60;

// The play is watched as video; only the freeze frame is 3D, so a person is one splat mesh.
export type Person = { label: string; source: "dream" | "synthetic"; freeze: SplatMesh };

export function splatCount(mesh: SplatMesh): number {
  const n = mesh.packedSplats?.numSplats ?? mesh.extSplats?.numSplats;
  if (n === undefined) throw new Error(`Missing splat storage: ${mesh.name}`);
  return n;
}

/** The lift of the synthetic bodies and the ball at the freeze (S4's jump arc over a 121-frame clip). */
export function jump(frame: number): number {
  return 0.6 * Math.sin(Math.PI * frame / 120);
}

// ---------------- dream bundles ----------------

export async function loadDreamFreeze(id: string, freezeUrl: string | null, parent: THREE.Object3D): Promise<Person> {
  const res = await fetch(dreamUrl(id, "dream.json"));
  if (!res.ok) throw new Error(`Dream "${id}": dream.json HTTP ${res.status}`);
  const dream = (await res.json()) as Dream;
  // the middle frame of the clip, unless a freeze file is given
  const middle = dream.kind === "replay" ? Math.floor(dream.frameCount / 2) : 0;
  const mesh = new SplatMesh({ url: freezeUrl ?? dreamUrl(id, framePath(dream, middle)) });
  await mesh.initialized;
  mesh.name = `${id}-freeze`;
  mesh.visible = false;
  parent.add(mesh);
  return { label: id, source: "dream", freeze: mesh };
}

// ---------------- synthetic people (S4's capsule bodies) ----------------

function body(blocker: boolean, pose: number, poses: number): Capsule[] {
  const skin = new THREE.Color(blocker ? "#8d563c" : "#b97b53");
  const jersey = new THREE.Color(blocker ? "#e3e5ed" : "#c52c38");
  const shorts = new THREE.Color(blocker ? "#26344c" : "#9b202c");
  const shoes = new THREE.Color("#eeeeeb");
  const sway = 0.035 * Math.sin(pose * Math.PI * 2 / poses);
  const height = blocker ? 2.05 / 1.9 : 1;
  const capsules: Capsule[] = [];
  const add = (a: Point, b: Point, radius: number, color: THREE.Color, weight: number) => {
    capsules.push({ a: [a[0], a[1] * height, a[2]], b: [b[0], b[1] * height, b[2]], radius, color, weight });
  };
  add([0, 1.07, 0], [0, 1.49, 0], 0.205, jersey, 26);
  add([0, 1.56, 0], [0, 1.65, 0], 0.075, skin, 3);
  add([0, 1.74, -0.015], [0, 1.76, -0.015], 0.14, skin, 10);
  add([-0.13, 0.86, 0], [-0.13, 1.03, 0], 0.13, shorts, 7);
  add([0.13, 0.86, 0], [0.13, 1.03, 0], 0.13, shorts, 7);
  for (const side of [-1, 1]) {
    add([side * 0.13, 0.85, 0], [side * 0.18, 0.53, 0.06], 0.085, skin, 7);
    add([side * 0.18, 0.53, 0.06], [side * 0.17, 0.13, 0], 0.065, skin, 6);
    add([side * 0.17, 0.07, -0.09], [side * 0.17, 0.07, 0.02], 0.065, shoes, 3);
    const shoulder: Point = [side * 0.23, 1.48, 0];
    const elbow: Point = blocker && side === -1 ? [-0.41, 1.86, 0.12] : [side * (0.32 + sway), 1.82, -0.045];
    const hand: Point = blocker && side === -1 ? [-0.61, 2.14, 0.24] : [side * 0.08 + sway, 2.24, -0.08];
    add(shoulder, elbow, 0.068, skin, 5);
    add(elbow, hand, 0.052, skin, 5);
    add(hand, [hand[0], hand[1] + 0.045, hand[2]], 0.055, skin, 2);
  }
  return capsules;
}

function fill(splats: PackedSplats, capsules: Capsule[], count: number) {
  let seed = 0x5eed;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const totalWeight = capsules.reduce((sum, capsule) => sum + capsule.weight, 0);
  const center = new THREE.Vector3();
  const scales = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const color = new THREE.Color();
  let filled = 0;
  let cumulative = 0;
  for (const capsule of capsules) {
    cumulative += capsule.weight;
    const end = Math.round(count * cumulative / totalWeight);
    for (; filled < end; filled++) {
      const t = random();
      const azimuth = random() * Math.PI * 2;
      const vertical = random() * 2 - 1;
      const radial = Math.sqrt(1 - vertical * vertical);
      const radius = capsule.radius * Math.cbrt(random());
      center.set(
        THREE.MathUtils.lerp(capsule.a[0], capsule.b[0], t) + radius * radial * Math.cos(azimuth),
        THREE.MathUtils.lerp(capsule.a[1], capsule.b[1], t) + radius * vertical,
        THREE.MathUtils.lerp(capsule.a[2], capsule.b[2], t) + radius * radial * Math.sin(azimuth),
      );
      scales.set(0.006, 0.008, 0.006).multiplyScalar(0.8 + random() * 0.4);
      color.copy(capsule.color).multiplyScalar(0.8 + random() * 0.3);
      splats.pushSplat(center, scales, rotation, 0.65, color);
    }
  }
}

/** One procedural freeze frame of `count` splats (S4's bodies, with the arms mid-sway). */
export async function buildSyntheticFreeze(blocker: boolean, count: number, parent: THREE.Object3D, tag: string): Promise<Person> {
  const packed = new PackedSplats({ maxSplats: count });
  fill(packed, body(blocker, 3, 12), count);
  await packed.initialized;
  const mesh = new SplatMesh({ packedSplats: packed });
  await mesh.initialized;
  mesh.name = `${blocker ? "blocker" : "shooter"}-${tag}`;
  mesh.position.y = jump(FREEZE_AT);
  mesh.visible = false;
  parent.add(mesh);
  return { label: blocker ? "blocker" : "shooter", source: "synthetic", freeze: mesh };
}
