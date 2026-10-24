import * as THREE from "three";

const JOINTS = [
  "wrist", "thumb-metacarpal", "thumb-phalanx-proximal", "thumb-phalanx-distal", "thumb-tip",
  ...["index-finger", "middle-finger", "ring-finger", "pinky-finger"].flatMap((f) =>
    [`${f}-metacarpal`, `${f}-phalanx-proximal`, `${f}-phalanx-intermediate`, `${f}-phalanx-distal`, `${f}-tip`]),
];

/**
 * In VR there is no passthrough to show your hands, so each tracked joint is drawn as a small ball (one instanced
 * draw for both hands). Returns the per-frame update.
 */
export function handDots(hands: THREE.Object3D[], scene: THREE.Scene): () => void {
  const mesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0xd9b69a }), hands.length * JOINTS.length);
  mesh.frustumCulled = false;
  mesh.count = 0;
  scene.add(mesh);
  const position = new THREE.Vector3();
  const matrix = new THREE.Matrix4();
  const scale = new THREE.Vector3();
  const identity = new THREE.Quaternion();
  return () => {
    let n = 0;
    for (const hand of hands) {
      if (!hand.visible) continue; // three hides a hand that disconnects but leaves its joints as they were
      const joints = (hand as unknown as { joints?: Record<string, THREE.Object3D & { jointRadius?: number }> }).joints ?? {};
      for (const name of JOINTS) {
        const joint = joints[name];
        if (!joint?.visible) continue;
        joint.getWorldPosition(position);
        matrix.compose(position, identity, scale.setScalar(Math.max(0.006, joint.jointRadius ?? 0.008)));
        mesh.setMatrixAt(n++, matrix);
      }
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
  };
}
