// The judge's hands in the arena: the session is drawn opaque, so the real hands don't show; each tracked hand is drawn
// as the standard WebXR hand (three's XRHandModelFactory 'mesh' model, skinned to the tracked joints: the generic-hand
// glTF from @webxr-input-profiles/assets, vendored in public/court/hands/ so the headset fetches nothing outside),
// shaded by a soft neutral matcap (plus the LOOKS below) and lit by the arena (light(level): dark in the arrival's black hold, so nothing
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

/**
 * One touch added to the hands' matcap shader, each on its own. An `attribute` is a per-vertex weight from the hand's
 * bind pose, read in GLSL as `v_<name>`; `fragment` runs just before the colour is written and may change
 * `outgoingLight` and `diffuseColor.a` (`normal` and `viewDir` are the matcap's own, in view space).
 */
interface Look {
  attribute?: { name: string; weigh: (pose: BindPose) => Float32Array };
  uniforms?: Record<string, THREE.IUniform>;
  fragmentPars?: string;
  fragment: string;
}
const LOOKS: Look[] = [];

/** A soft neutral matcap, as the headset's default hands: light from above left, a little darker toward the rim. */
function matcap(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(48, 40, 6, 64, 64, 64);
  grad.addColorStop(0, "#ebecef");
  grad.addColorStop(0.55, "#c5c8cf");
  grad.addColorStop(0.9, "#878b95");
  grad.addColorStop(1, "#5a5e67");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// A soft cool rim (fresnel): the edges glow a little, so the hands read against the dark arena without being flat
// white; scaled by the arena's light like the rest (diffuseColor is light(level)).
LOOKS.push({
  fragment: `float rim = pow(1.0 - saturate(dot(normal, viewDir)), 2.5);
outgoingLight += diffuseColor.rgb * vec3(0.80, 0.88, 1.0) * (0.55 * rim);`,
});

/** A skinned hand mesh in its bind pose: vertex `i` and a joint's position, in the same space. */
interface BindPose {
  count: number;
  /** True for the right hand. */
  right: boolean;
  at(i: number, out: THREE.Vector3): THREE.Vector3;
  joint(name: string): THREE.Vector3 | null;
}

function bindPose(mesh: THREE.SkinnedMesh, right: boolean): BindPose {
  const pos = mesh.geometry.getAttribute("position");
  const m = new THREE.Matrix4();
  return {
    count: pos.count,
    right,
    at: (i, out) => out.fromBufferAttribute(pos, i).applyMatrix4(mesh.bindMatrix),
    joint: (name) => {
      const k = mesh.skeleton.bones.findIndex((b) => b.name === name);
      return k < 0 ? null : new THREE.Vector3().setFromMatrixPosition(m.copy(mesh.skeleton.boneInverses[k]).invert());
    },
  };
}

// The glTF's forearm ends in a cut cylinder (only ~2 cm behind the wrist joint): the wrist fades out toward it (opaque
// 3 cm into the palm, gone just short of the cut), as the headset's own hands do, so there's no hard edge. Fully faded
// pixels are dropped, so they don't hide the menu behind them in depth.
LOOKS.push({
  attribute: {
    name: "handFade",
    weigh: (pose) => {
      const w = new Float32Array(pose.count).fill(1);
      const wrist = pose.joint("wrist");
      const knuckle = pose.joint("middle-finger-phalanx-proximal");
      if (!wrist || !knuckle) return w;
      const axis = knuckle.sub(wrist).normalize();
      const v = new THREE.Vector3();
      const t = new Float32Array(pose.count);
      let cut = 0;
      for (let i = 0; i < pose.count; i++) cut = Math.min(cut, (t[i] = pose.at(i, v).sub(wrist).dot(axis)));
      const from = 0.03; // opaque from 3 cm ahead of the wrist joint
      const to = cut + 0.004; // gone 4 mm short of the cut
      if (cut > -0.005) return w; // no forearm to fade
      for (let i = 0; i < pose.count; i++) {
        const x = Math.min(1, Math.max(0, (t[i] - to) / (from - to)));
        w[i] = x * x * (3 - 2 * x);
      }
      return w;
    },
  },
  fragment: "diffuseColor.a *= v_handFade;\nif (diffuseColor.a < 0.01) discard;",
});

/** The hands' material: the matcap with every LOOK patched in. */
function handMaterial(): THREE.MeshMatcapMaterial {
  const material = new THREE.MeshMatcapMaterial({ matcap: matcap(), transparent: true, opacity: OPACITY });
  material.onBeforeCompile = (shader) => {
    for (const look of LOOKS) {
      Object.assign(shader.uniforms, look.uniforms);
      const a = look.attribute?.name;
      const vertexPars = a ? `attribute float ${a};\nvarying float v_${a};` : "";
      const fragmentPars = `${a ? `varying float v_${a};` : ""}\n${look.fragmentPars ?? ""}`;
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", `#include <common>\n${vertexPars}`)
        .replace("#include <begin_vertex>", `#include <begin_vertex>\n${a ? `v_${a} = ${a};` : ""}`);
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>\n${fragmentPars}`)
        .replace("#include <opaque_fragment>", `${look.fragment}\n#include <opaque_fragment>`);
    }
  };
  material.customProgramCacheKey = () => `court-hands:${LOOKS.length}`;
  return material;
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
  private readonly press: PressGlow;

  /** `hands` are renderer.xr.getHand(0) and (1), already in the scene. */
  constructor(hands: THREE.Object3D[], scene: THREE.Scene) {
    this.hands = hands;
    this.material = handMaterial();
    // the model loads when its hand connects (left.glb or right.glb by the input source's handedness)
    const factory = new XRHandModelFactory(null, (object) => {
      const right = (object.parent as { xrInputSource?: { handedness?: string } } | null)?.xrInputSource?.handedness === "right";
      object.traverse((o) => {
        if (!(o as THREE.Mesh).isMesh) return;
        const mesh = o as THREE.Mesh;
        mesh.name = "court-hands"; // e2e controls find the drawn hands by name
        mesh.material = this.material;
        mesh.renderOrder = HANDS_ORDER;
        mesh.castShadow = mesh.receiveShadow = false;
        mesh.frustumCulled = false;
        if (!(mesh as THREE.SkinnedMesh).isSkinnedMesh) return;
        const pose = bindPose(mesh as THREE.SkinnedMesh, right);
        for (const look of LOOKS)
          if (look.attribute && !mesh.geometry.getAttribute(look.attribute.name))
            mesh.geometry.setAttribute(look.attribute.name, new THREE.BufferAttribute(look.attribute.weigh(pose), 1));
      });
    }).setPath(`${import.meta.env?.BASE_URL ?? "/"}court/hands/`);
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
    this.press = new PressGlow(scene);
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
    this.press.update(this.hands, this.models);
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

/** How bright the right index fingertip glows, 0-1 (eased; shared by the hands' one material). */
const PRESS = { value: 0 };

// Press feedback: the right index fingertip brightens softly while it's on a button (the weight is the right hand's
// fingertip, 0 everywhere on the left).
LOOKS.push({
  attribute: {
    name: "handTip",
    weigh: (pose) => {
      const w = new Float32Array(pose.count);
      const tip = pose.joint("index-finger-tip");
      if (!pose.right || !tip) return w;
      const v = new THREE.Vector3();
      for (let i = 0; i < pose.count; i++) {
        const x = Math.min(1, Math.max(0, (0.02 - pose.at(i, v).distanceTo(tip)) / 0.014)); // full within 6 mm, none past 2 cm
        w[i] = x * x * (3 - 2 * x);
      }
      return w;
    },
  },
  uniforms: { handPress: PRESS },
  fragmentPars: "uniform float handPress;",
  fragment: "outgoingLight = mix(outgoingLight, vec3(0.86, 0.93, 1.0) * 1.2, 0.75 * v_handTip * handPress);",
});

/**
 * Whether the right index fingertip is on one of the palm menu's buttons (ui.ts draws them as planes over the hands, at
 * a renderOrder above HANDS_ORDER; found in the scene once a second), easing PRESS toward it.
 */
class PressGlow {
  private buttons: THREE.Mesh[] = [];
  private scanned = -Infinity;
  private at = -1;
  private readonly tip = new THREE.Vector3();
  private readonly local = new THREE.Vector3();

  constructor(private readonly scene: THREE.Scene) {}

  update(hands: THREE.Object3D[], models: THREE.Object3D[]): void {
    const now = performance.now();
    if (now - this.scanned > 1000) {
      this.scanned = now;
      this.buttons = [];
      this.scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh && m.geometry.type === "PlaneGeometry" && m.renderOrder > HANDS_ORDER) this.buttons.push(m);
      });
    }
    let on = false;
    hands.forEach((hand, i) => {
      if (!models[i].visible || (models[i] as { xrInputSource?: { handedness?: string } }).xrInputSource?.handedness !== "right") return;
      const tip = liveJoints(hand)["index-finger-tip"];
      if (tip?.visible) on = this.touching(tip.getWorldPosition(this.tip));
    });
    const dt = this.at < 0 ? 0 : now - this.at;
    this.at = now;
    PRESS.value += ((on ? 1 : 0) - PRESS.value) * (1 - Math.exp(-dt / 60));
  }

  /** On a shown button's face: over it, from just in front (8 mm) to pushed 3 cm in. */
  private touching(tip: THREE.Vector3): boolean {
    return this.buttons.some((b) => {
      for (let o: THREE.Object3D | null = b; o; o = o.parent) if (!o.visible) return false;
      const { width, height } = (b.geometry as THREE.PlaneGeometry).parameters;
      b.worldToLocal(this.local.copy(tip));
      return Math.abs(this.local.x) < width / 2 && Math.abs(this.local.y) < height / 2 && this.local.z < 0.008 && this.local.z > -0.03;
    });
  }
}
