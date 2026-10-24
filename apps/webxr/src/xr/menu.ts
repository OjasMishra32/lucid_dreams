import * as THREE from "three";
import { liveJoints, openness, type XrButton } from "./hands";

// Controls on your left palm, the way the Quest's own menus work: turn your open left hand palm up toward your face and
// the buttons appear just above it; press them with your right index fingertip. Nothing floats where a busy hand (a chess
// piece, a club, a dance move) could brush it, and no pinch or gesture changes anything by itself.

const jointsOf = liveJoints;

/** Which tracked hand is which (three numbers hands by input source, not by side); null until it's known. */
export function handSides(hands: THREE.Object3D[]): (i: number) => XRHandedness | null {
  const side: (XRHandedness | null)[] = hands.map(() => null);
  hands.forEach((h, i) => {
    const space = h as THREE.XRHandSpace;
    space.addEventListener("connected", (e) => (side[i] = e.data?.handedness ?? null));
    space.addEventListener("disconnected", () => (side[i] = null));
  });
  return (i) => side[i] ?? null;
}

/** The index of the hand on that side (the first hand for left, the second for right while sides aren't known yet). */
export function handIndex(sideOf: (i: number) => XRHandedness | null, want: "left" | "right"): number {
  if (sideOf(0) === want) return 0;
  if (sideOf(1) === want) return 1;
  return want === "left" ? 0 : 1;
}

const ROW = 0.036;
const COL = 0.1;

export class HandMenu {
  readonly group = new THREE.Group();
  readonly buttons: XrButton[] = [];
  open = false;
  /** While true it stays shut whatever the hands do (your turn in a lesson: both hands are dancing). */
  locked = false;
  private held = 0; // ms the palm has stayed the other way (opening or closing waits for it)
  private palm = new THREE.Vector3();
  private normal = new THREE.Vector3();
  private toHead = new THREE.Vector3();
  private target = new THREE.Vector3();
  private q = new THREE.Quaternion();
  private tip = new THREE.Vector3();

  constructor(
    private hands: THREE.Object3D[],
    private sideOf: (i: number) => XRHandedness | null,
    parent: THREE.Object3D,
    private cols = 2,
  ) {
    this.group.visible = false;
    parent.add(this.group);
  }

  /** Buttons fill rows of `cols`, first row on top. */
  add(...buttons: XrButton[]) {
    this.buttons.push(...buttons);
    const rows = Math.ceil(this.buttons.length / this.cols);
    this.buttons.forEach((b, k) => {
      const r = Math.floor(k / this.cols);
      const inRow = Math.min(this.cols, this.buttons.length - r * this.cols);
      b.mesh.position.set((k % this.cols - (inRow - 1) / 2) * COL, (rows - 1 - r) * ROW, 0);
      if (b.mesh.parent !== this.group) this.group.add(b.mesh);
    });
  }

  remove(button: XrButton) {
    const k = this.buttons.indexOf(button);
    if (k < 0) return;
    this.buttons.splice(k, 1);
    this.group.remove(button.mesh);
    this.add();
  }

  /** Once a frame while presenting, with your eyes' world position. True while the menu is open. */
  update(head: THREE.Vector3, now: number, dt: number): boolean {
    if (this.locked) {
      this.open = this.group.visible = false;
      this.held = 0;
      return false;
    }
    const left = jointsOf(this.hands[handIndex(this.sideOf, "left")]);
    const mc = left["middle-finger-metacarpal"];
    let up = false;
    // an open hand, palm toward your eyes: a hand closed on a club, cupping a ball or pinching a piece never opens it
    const flat = openness(left);
    if (mc?.visible && left.wrist?.visible && flat !== null && flat > (this.open ? 0.82 : 0.88)) {
      mc.getWorldPosition(this.palm);
      mc.getWorldQuaternion(this.q);
      this.normal.set(0, -1, 0).applyQuaternion(this.q); // WebXR: a joint's -Y points out of the palm
      this.toHead.copy(head).sub(this.palm);
      const near = this.toHead.length() < 0.75;
      // and below your eyes: arms up over your head in a dance turn the palms down at your face too, without asking
      const below = this.palm.y < head.y - (this.open ? 0.02 : 0.06);
      up = near && below && this.normal.dot(this.toHead.normalize()) > (this.open ? 0.35 : 0.6);
    }
    // a moment's hold before it opens or closes, so a hand swinging past never flashes it
    if (up !== this.open) {
      this.held += dt * 1000;
      if (this.held > (up ? 220 : 450)) {
        this.open = up;
        this.held = 0;
      }
    } else this.held = 0;
    const wasVisible = this.group.visible;
    this.group.visible = this.open;
    if (!this.open) return false;
    // just above the palm, turned to your eyes, smoothed so it doesn't shake with the hand
    this.target.copy(this.palm).addScaledVector(this.normal, 0.06);
    if (wasVisible) this.group.position.lerp(this.target, Math.min(1, dt * 14));
    else this.group.position.copy(this.target);
    this.group.lookAt(head);
    const right = jointsOf(this.hands[handIndex(this.sideOf, "right")])["index-finger-tip"];
    const tips = [right?.visible ? right.getWorldPosition(this.tip) : null];
    for (const b of this.buttons) b.touch(tips, now);
    return true;
  }
}
