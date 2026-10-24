import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

// One soft studio light for every solid object we build (the club, the ball and hoop, the guitar, the props): the
// splats carry their own light, only these need one. Prefiltered once per renderer and shared, since each copy is a
// half-float cube map of about 6 MB on the GPU and a few blur passes to make.

const made = new WeakMap<THREE.WebGLRenderer, THREE.Texture>();

export function roomEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  let env = made.get(renderer);
  if (!env) {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    env = pmrem.fromScene(room, 0.04).texture;
    room.dispose();
    pmrem.dispose();
    made.set(renderer, env);
  }
  return env;
}
