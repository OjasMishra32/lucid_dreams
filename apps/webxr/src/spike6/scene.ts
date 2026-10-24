import * as THREE from "three";
import { backdropTexture, billboardTexture, courtTexture, textureBytes } from "./textures";
import { FREEZE_AT, jump } from "./people";
import { makeArena } from "./arena";

// Court Side's non-splat content, in the court group's frame: people near the origin, the viewer at -Z.
export function makeSet(renderer: THREE.WebGLRenderer, vr: boolean) {
  const court = new THREE.Group();
  court.name = "court";
  const anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  const floorMap = courtTexture(anisotropy);
  const standsMap = backdropTexture(anisotropy);
  const cutoutMap = billboardTexture();

  let arenaBytes = 0;
  if (vr) {
    // full immersion: the whole court, tiered stands, lights and darkness
    const arena = makeArena(floorMap, standsMap);
    arenaBytes = arena.textureBytes;
    court.add(arena.group);
  } else {
    // passthrough: a 12 x 9 m patch of the 4K court, with the key under the players, and a flat backdrop
    const patch = { w: 12, h: 9, centerX: 5.5, length: 28.65, width: 15.24 };
    floorMap.repeat.set(patch.w / patch.length, patch.h / patch.width);
    floorMap.offset.set(patch.centerX / patch.length - floorMap.repeat.x / 2, 0.5 - floorMap.repeat.y / 2);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(patch.w, patch.h), new THREE.MeshBasicMaterial({ map: floorMap }));
    floor.rotation.x = -Math.PI / 2;
    court.add(floor);
    const stands = new THREE.Mesh(new THREE.PlaneGeometry(30, 12), new THREE.MeshBasicMaterial({ map: standsMap }));
    stands.position.set(0, 6, 12);
    stands.rotation.y = Math.PI;
    court.add(stands);
  }

  const billboards: THREE.Mesh[] = [];
  for (const [x, z] of [[-2.1, 2.2], [2.4, 2.7], [-3.2, 4.2]]) {
    const board = new THREE.Mesh(
      new THREE.PlaneGeometry(0.6, 2),
      new THREE.MeshBasicMaterial({ map: cutoutMap, alphaTest: 0.5, side: THREE.DoubleSide }),
    );
    board.position.set(x, 1, z);
    court.add(board);
    billboards.push(board);
  }

  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.12, 32, 24), new THREE.MeshBasicMaterial({ color: 0xd87422 }));
  const seam = new THREE.MeshBasicMaterial({ color: 0x261a17 });
  for (const axis of ["x", "y", "z"] as const) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.1202, 0.002, 4, 64), seam);
    ring.rotation[axis] = Math.PI / 2;
    ball.add(ring);
  }
  court.add(ball);

  // exactly 0.7 m between the two roots, the second toward the viewer (-Z)
  const rootA = new THREE.Group();
  const rootB = new THREE.Group();
  rootB.position.set(0.64, 0, -Math.sqrt(0.7 ** 2 - 0.64 ** 2));
  court.add(rootA, rootB);

  ball.position.set(-0.02, 2.4 + jump(FREEZE_AT), -0.08);
  ball.visible = false;
  const textures = [floorMap, standsMap, cutoutMap];
  return {
    court, rootA, rootB, ball, billboards,
    textureBytes: textures.reduce((sum, map) => sum + textureBytes(map), 0) + arenaBytes,
    textureSizes: { court: floorMap.image.width, backdrop: standsMap.image.width },
  };
}
