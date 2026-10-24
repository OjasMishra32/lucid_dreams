import * as THREE from "three";

// In the headset, things you choose with a fingertip: a small floating card per legend (name and peak rating), and
// the line that always goes with a legend: it's Stockfish at their rating, not them.

const FONT = '-apple-system, "SF Pro Text", "Inter", sans-serif';

/** A card you press by pushing an index fingertip through it. */
export class LegendCard {
  readonly mesh: THREE.Mesh;
  private canvas = document.createElement("canvas");
  private tex: THREE.CanvasTexture;
  private on = false;
  private wasInside = [false, false];
  private cooldownUntil = 0;
  private pressedUntil = 0;
  private local = new THREE.Vector3();
  static readonly W = 0.11;
  static readonly H = 0.062;

  constructor(
    readonly id: string,
    private name: string,
    private rating: string,
    private onPress: () => void,
  ) {
    this.canvas.width = 512;
    this.canvas.height = 288;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 8;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(LegendCard.W, LegendCard.H), new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthWrite: false }));
    this.draw(false);
  }

  setOn(on: boolean) {
    if (on === this.on) return;
    this.on = on;
    this.draw(false);
  }

  private draw(pressed: boolean) {
    const c = this.canvas.getContext("2d")!;
    c.clearRect(0, 0, 512, 288);
    c.fillStyle = pressed ? "rgba(0,113,227,0.95)" : "rgba(28,28,30,0.86)";
    c.beginPath();
    c.roundRect(6, 6, 500, 276, 40);
    c.fill();
    if (this.on && !pressed) {
      c.strokeStyle = "#0a84ff";
      c.lineWidth = 8;
      c.stroke();
    }
    c.textAlign = "left";
    c.textBaseline = "alphabetic";
    c.fillStyle = "#f5f5f7";
    c.font = `600 58px ${FONT}`;
    c.fillText(this.name, 40, 128);
    c.fillStyle = pressed ? "#f5f5f7" : "#a1a1a6";
    c.font = `400 40px ${FONT}`;
    c.fillText(this.rating, 40, 200);
    this.tex.needsUpdate = true;
  }

  /** Index fingertips in world space; presses once each time a tip pushes through the face. */
  touch(tips: (THREE.Vector3 | null)[], now: number) {
    if (!this.mesh.visible) return;
    tips.forEach((tip, h) => {
      let inside = false;
      if (tip) {
        this.local.copy(tip);
        this.mesh.worldToLocal(this.local);
        inside = Math.abs(this.local.x) < LegendCard.W / 2 && Math.abs(this.local.y) < LegendCard.H / 2 && this.local.z < 0.004 && this.local.z > -0.02;
      }
      if (inside && !this.wasInside[h] && now > this.cooldownUntil) {
        this.cooldownUntil = now + 400;
        this.pressedUntil = now + 180;
        this.draw(true);
        this.onPress();
      }
      this.wasInside[h] = inside;
    });
    if (this.pressedUntil && now > this.pressedUntil) {
      this.pressedUntil = 0;
      this.draw(false);
    }
  }
}

/** One quiet line of text floating in the room, turned toward whoever looks at it. */
export class FloatingNote {
  readonly mesh: THREE.Mesh;
  private canvas = document.createElement("canvas");
  private tex: THREE.CanvasTexture;
  private text = "";

  constructor() {
    this.canvas.width = 1280;
    this.canvas.height = 96;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 8;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.44, 0.033), new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthWrite: false }));
    this.mesh.visible = false;
  }

  setText(text: string) {
    this.mesh.visible = !!text;
    if (text === this.text) return;
    this.text = text;
    const c = this.canvas.getContext("2d")!;
    c.clearRect(0, 0, 1280, 96);
    if (!text) return;
    c.font = `500 40px ${FONT}`;
    const w = Math.min(1268, c.measureText(text).width + 64);
    c.fillStyle = "rgba(0,0,0,0.55)";
    c.beginPath();
    c.roundRect(640 - w / 2, 6, w, 84, 42);
    c.fill();
    c.fillStyle = "#e5e5ea";
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText(text, 640, 50);
    this.tex.needsUpdate = true;
  }

  /** Place it at a world point, turned (about the vertical only) to face the viewer. */
  place(at: THREE.Vector3, viewer: THREE.Vector3) {
    this.mesh.position.copy(at);
    this.mesh.rotation.set(0, Math.atan2(viewer.x - at.x, viewer.z - at.z), 0);
  }
}
