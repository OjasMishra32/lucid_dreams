// The judge's hands in the arena: the session is drawn opaque, so the real hands don't show; each tracked hand is drawn
// as the standard WebXR hand (three's XRHandModelFactory 'mesh' model, skinned to the tracked joints: the generic-hand
// glTF from @webxr-input-profiles/assets, vendored in public/court/hands/ so the headset fetches nothing outside),
// shaded by a soft neutral matcap and lit by the arena (light(level): dark in the arrival's black hold, so nothing
// shows before the lights come up). In See my room they fade out as the real ones appear in passthrough, and depth-only
// occluders (xr/hands.ts handOccluder) keep the real hands in front of the players there (3.6). Stream C (`core`).
import * as THREE from "three";
import { XRHandModelFactory } from "three/addons/webxr/XRHandModelFactory.js";
import { handOccluder, liveJoints } from "../xr/hands";

/** True once stream C has built this module. */
export const BUILT = true;

/** The drawn hands' renderOrder: after stream D's footage layers (50-90, drawn without the depth test), so the footage never paints over them. */
export const HANDS_ORDER = 100;
/** The hands' opacity in the arena (solid, as the headset's own hands; fade() takes it to 0 in the room). */
const OPACITY = 1;

/** A soft neutral matcap, as the headset's default hands: light from above left, a little darker toward the rim. */
function matcap(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(48, 40, 6, 64, 64, 64);
  grad.addColorStop(0, "#f6f6f8");
  grad.addColorStop(0.55, "#d3d5da");
  grad.addColorStop(0.9, "#8e919a");
  grad.addColorStop(1, "#5c5f66");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class VrHands {
  private readonly hands: THREE.Object3D[];
  /** One XRHandModel per hand, in the scene (named "court-hands"), placed where its hand is each frame. */
  private readonly models: THREE.Object3D[];
  private readonly material: THREE.MeshMatcapMaterial;
  private readonly occluders: { update: () => void; group: THREE.Object3D | undefined }[];
  private room = 0;
  /** The arena's light on the hands, 0-1: 0 (the default, until court.ts says) draws nothing. */
  private level = 0;

  /** `hands` are renderer.xr.getHand(0) and (1), already in the scene. */
  constructor(hands: THREE.Object3D[], scene: THREE.Scene) {
    this.hands = hands;
    this.material = new THREE.MeshMatcapMaterial({ matcap: matcap(), transparent: true, opacity: OPACITY });
    // the model loads when its hand connects (left.glb or right.glb by the input source's handedness)
    const factory = new XRHandModelFactory(null, (object) =>
      object.traverse((o) => {
        if (!(o as THREE.Mesh).isMesh) return;
        const mesh = o as THREE.Mesh;
        mesh.name = "court-hands"; // e2e controls find the drawn hands by name
        mesh.material = this.material;
        mesh.renderOrder = HANDS_ORDER;
        mesh.castShadow = mesh.receiveShadow = false;
        mesh.frustumCulled = false;
      }),
    ).setPath(`${import.meta.env?.BASE_URL ?? "/"}court/hands/`);
    this.models = hands.map((h) => {
      const model = factory.createHandModel(h as THREE.Group, "mesh");
      model.name = "court-hands";
      model.renderOrder = HANDS_ORDER;
      model.matrixAutoUpdate = false;
      model.visible = false;
      scene.add(model);
      return model;
    });
    // the occluders are on only in the room (in the arena they would fight the drawn hands for depth)
    this.occluders = hands.map((h) => {
      const before = new Set(scene.children);
      const update = handOccluder(h, scene);
      const group = scene.children.find((c) => !before.has(c));
      if (group) group.visible = false;
      return { update, group };
    });
  }

  /** Once a frame while presenting. */
  update(): void {
    this.show();
    this.hands.forEach((hand, i) => {
      const model = this.models[i];
      if (!model.visible) return;
      // the model's bones take the joints' poses in their hand's space, so the model sits where the hand is
      hand.updateWorldMatrix(true, false);
      model.matrix.copy(hand.matrixWorld);
      model.matrixWorldNeedsUpdate = true;
    });
    for (const o of this.occluders) {
      if (this.room > 0) o.update();
      else if (o.group) o.group.visible = false;
    }
  }

  /** 0 = drawn hands (the arena), 1 = faded out (the room: the real hands show, occluders on). */
  fade(p: number): void {
    this.room = Math.min(1, Math.max(0, p));
    this.material.opacity = OPACITY * (1 - this.room);
    this.show();
  }

  /**
   * The arena's light where the judge is, 0-1 (court.ts: 0 in the arrival's dark hold, rising with the lights-up, then
   * the light field's level for a person at the head's floor point). The hands are shaded by it; 0 hides them.
   */
  light(level: number): void {
    this.level = Math.min(1, Math.max(0, level));
    this.material.color.setScalar(this.level);
    this.show();
  }

  /** A hand shows only while drawn and tracked (no joints: hidden, so nothing is left at its last pose or the origin). */
  private show(): void {
    const drawn = this.room < 1 && this.level > 0.01;
    this.hands.forEach((hand, i) => (this.models[i].visible = drawn && !!liveJoints(hand).wrist?.visible));
  }
}
