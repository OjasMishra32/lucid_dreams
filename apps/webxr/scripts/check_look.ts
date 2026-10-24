// Checks look.ts (eye contact) on an SMPL-X-shaped chain: the head ends up facing your eyes, stays within ±35° yaw
// and ±20° pitch, looks ahead again when you're behind, settles within 300 ms, and the neck carries 30% of the turn.
//   node scripts/check_look.ts
import * as THREE from "three";
import { HeadLook, headPose } from "../src/look.ts";

const parents = [-1, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 12];
const rest = parents.map((_, j) => [0, 0.1 * j, 0]);
Object.assign(rest, { 0: [0, 0.95, 0], 3: [0, 1.05, 0], 6: [0, 1.2, 0], 9: [0, 1.35, 0], 12: [0, 1.5, 0], 15: [0, 1.62, 0.02] });
const skeleton = { joints: parents.map((_, j) => `j${j}`), parents, rest };
const DEG = 180 / Math.PI;
let failed = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${detail}`);
  if (!ok) failed++;
};

// The motion: standing, turned to face -Z (the bundle's front), as every avatar's root_q does.
const motion = () => parents.map((_, j) => (j === 0 ? new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI) : new THREE.Quaternion()));
const rootT = new THREE.Vector3();

function run(eye: THREE.Vector3 | null, seconds: number, look = new HeadLook()) {
  let local = motion();
  for (let t = 0; t < seconds; t += 1 / 72) {
    local = motion();
    look.apply(local, rootT, skeleton, eye, 1 / 72);
  }
  const { rot, pos } = headPose(local, rootT, skeleton);
  return { look, local, forward: new THREE.Vector3(0, 0, 1).applyQuaternion(rot), pos };
}
const angle = (a: THREE.Vector3, b: THREE.Vector3) => a.angleTo(b) * DEG;
const flat = (v: THREE.Vector3) => new THREE.Vector3(v.x, 0, v.z).normalize();

{
  const eye = new THREE.Vector3(0.4, 1.7, -1.8);
  const r = run(eye, 2);
  const want = eye.clone().sub(r.pos).normalize();
  check("faces your eyes", angle(r.forward, want) < 0.5, `${angle(r.forward, want).toFixed(2)}° off`);
}
{
  const r = run(new THREE.Vector3(2, 1.62, -0.4), 2);
  const yaw = angle(flat(r.forward), new THREE.Vector3(0, 0, -1));
  check("yaw stops at 35°", Math.abs(yaw - 35) < 0.5, `${yaw.toFixed(2)}°`);
  check("turns toward you (+X)", r.forward.x > 0, `forward.x ${r.forward.x.toFixed(3)}`);
}
{
  const r = run(new THREE.Vector3(0, 3.5, -1), 2);
  const pitch = Math.asin(r.forward.y) * DEG;
  check("pitch stops at 20°", Math.abs(pitch - 20) < 0.5, `${pitch.toFixed(2)}°`);
}
{
  const look = run(new THREE.Vector3(1, 1.7, -1.5), 2).look;
  const r = run(new THREE.Vector3(0.1, 1.62, 2), 2, look);
  check("looks ahead again when you're behind", angle(r.forward, new THREE.Vector3(0, 0, -1)) < 0.5, `${angle(r.forward, new THREE.Vector3(0, 0, -1)).toFixed(2)}° off ahead`);
  const back = run(null, 2, look);
  check("eases back to rest without a viewer", back.look.yaw === 0 && back.look.pitch === 0, `yaw ${back.look.yaw}, pitch ${back.look.pitch}`);
}
{
  const eye = new THREE.Vector3(Math.tan(20 / DEG) * 1.8, 1.62, -1.8); // 20° to the side, level
  const r = run(eye, 0.3);
  const yaw = angle(flat(r.forward), new THREE.Vector3(0, 0, -1));
  check("settles within 300 ms", yaw / 20 > 0.94, `${((yaw / 20) * 100).toFixed(1)}% of 20° after 0.3 s`);
}
{
  const r = run(new THREE.Vector3(Math.tan(30 / DEG) * 1.8, 1.62, -1.8), 2);
  const neck = 2 * Math.acos(Math.min(1, Math.abs(r.local[12].w))) * DEG;
  check("neck carries 30%", Math.abs(neck - 9) < 0.5, `neck ${neck.toFixed(2)}° of a 30° turn`);
}
if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log("LOOK_OK");
