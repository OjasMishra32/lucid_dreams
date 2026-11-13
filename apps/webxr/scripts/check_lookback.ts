// The field-of-view chevron (src/xr/lookback.ts) on a stand-in head: nothing while the person is in view; turned away
// for 2 s, a chevron 12 cm off the middle of your view on the side they're on; looking back within 35°, it goes.
//   ../web/node_modules/.bin/tsx scripts/check_lookback.ts
import * as THREE from "three";
import { LookBack } from "../src/xr/lookback.ts";

(globalThis as Record<string, unknown>).document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => new Proxy({}, { get: () => () => {} }) }),
};
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!ok) failed++;
};
const scene = new THREE.Scene();
const head = new THREE.Object3D();
head.position.set(0, 1.6, 0);
scene.add(head);
const lb = new LookBack(scene);
const target = new THREE.Vector3(0, 1.1, -1.8); // the person, ahead
const run = (s: number) => {
  for (let t = 0; t < s; t += 1 / 72) {
    head.updateMatrixWorld(true);
    lb.update(head, target, 1 / 72);
  }
};
run(5);
check("in view: no chevron", !lb.mesh.visible);
head.rotation.set(0, -Math.PI / 2, 0); // turned 90° to the right: they're on your left
run(1.5);
check("turned away 1.5 s: not yet", !lb.mesh.visible);
run(1.0);
const local = head.worldToLocal(lb.mesh.position.clone());
check("turned away 2.5 s: shown", lb.mesh.visible && lb.mesh.material.opacity > 0.5, `opacity ${lb.mesh.material.opacity.toFixed(2)}`);
check("on the side they're on (left), near the middle of the view", local.x < -0.08 && Math.abs(local.z + 0.6) < 0.01 && Math.abs(local.y) < 0.1, `x ${local.x.toFixed(3)} y ${local.y.toFixed(3)} z ${local.z.toFixed(3)}`);
head.rotation.set(0, -0.4, 0); // back to within 35°
run(1.0);
check("looking back: gone", !lb.mesh.visible);
head.rotation.set(0, 0, 0);
lb.update(head, null, 1 / 72);
check("no target: nothing", !lb.mesh.visible);
console.log(failed ? `LOOKBACK_FAIL ${failed}` : "LOOKBACK_OK");
process.exit(failed ? 1 : 0);
