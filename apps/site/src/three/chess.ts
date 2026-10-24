import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { CHESS_SET_URL } from "../config";
import { clamp01, damp, lerp, onTick, smooth } from "../motion";
import { Stage } from "./stage";

/**
 * A real-size board (Poly Haven's chess set, 55 cm), seen from your chair. Scrolling turns the view a little and plays
 * your first move, e2 to e4.
 */
export async function mountChess(host: HTMLElement, progress: () => number): Promise<void> {
  const stage = new Stage(host, { antialias: true, fov: 30 });
  const { renderer, scene, camera } = stage;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.88;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.32;

  const key = new THREE.DirectionalLight(0xffeedd, 2.8);
  key.position.set(-0.55, 1.1, 0.35);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.002;
  const sc = key.shadow.camera;
  sc.left = sc.bottom = -0.42;
  sc.right = sc.top = 0.42;
  sc.near = 0.2;
  sc.far = 3;
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xbcd2ff, 0.9);
  rim.position.set(0.7, 0.5, -0.9);
  scene.add(rim);

  let gltf;
  try {
    gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(CHESS_SET_URL);
  } catch (e) {
    stage.dispose();
    throw e;
  }
  const root = gltf.scene;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.castShadow = true;
      m.receiveShadow = true;
    }
  });
  scene.add(root);
  root.updateMatrixWorld(true);

  // Which way is black, and which pawn is on e2: work it out from where the pieces stand.
  const centerOf = (o: THREE.Object3D) => new THREE.Box3().setFromObject(o).getCenter(new THREE.Vector3());
  const pieces = root.children.filter((o) => o.name.startsWith("piece_"));
  const avgZ = (side: string) => {
    const s = pieces.filter((o) => o.name.includes(side));
    return s.reduce((a, o) => a + centerOf(o).z, 0) / Math.max(1, s.length);
  };
  const forward = avgZ("black") < avgZ("white") ? -1 : 1; // +1: black is toward +Z
  const pawns = pieces
    .filter((o) => o.name.startsWith("piece_pawn_white"))
    .map((o) => ({ o, x: centerOf(o).x }))
    .sort((a, b) => (forward < 0 ? a.x - b.x : b.x - a.x)); // a-file first, from white's chair
  const square = pawns.length === 8 ? Math.abs(pawns[7].x - pawns[0].x) / 7 : 0.05;
  const ePawn = pawns[4]?.o ?? null;
  const ePawnStart = ePawn ? ePawn.position.clone() : new THREE.Vector3();

  const board = new THREE.Box3().setFromObject(root);
  const center = board.getCenter(new THREE.Vector3());
  center.y = board.min.y;

  let rect = { x: 0, y: 0, w: 1, h: 1 };
  let fullH = 1;
  const layout = () => {
    stage.resize();
    rect = { x: 0, y: 0, w: stage.width, h: stage.height };
    fullH = stage.aimAt(rect);
  };
  layout();
  new ResizeObserver(layout).observe(host);

  let p = 0;
  const look = new THREE.Vector3();
  onTick((dt) => {
    if (!stage.onScreen) return;
    p = damp(p, progress(), 5, dt);

    // your move: lift, carry two squares, set down
    if (ePawn) {
      const f = smooth(0.4, 0.58, p);
      ePawn.position.copy(ePawnStart);
      ePawn.position.z += forward * square * 2 * f;
      ePawn.position.y += Math.sin(Math.PI * f) * square * 0.7;
    }

    // from your chair, drifting a little as you scroll
    const az = lerp(-0.42, 0.28, clamp01(p));
    const el = lerp(0.52, 0.4, clamp01(p));
    const dist = stage.fitBoth(0.74, 0.46, rect, fullH, 0.9);
    const back = -forward; // white's side
    look.set(center.x, center.y + 0.02, center.z + forward * 0.015);
    camera.position.set(
      look.x + Math.sin(az) * Math.cos(el) * dist,
      look.y + Math.sin(el) * dist,
      look.z + back * Math.cos(az) * Math.cos(el) * dist,
    );
    camera.lookAt(look);
    stage.render();
  });
}
