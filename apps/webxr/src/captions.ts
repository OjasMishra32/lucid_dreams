import * as THREE from "three";

// What the person says, from the bundle's captions.vtt (WebVTT, in the clip's own time).

export interface Cue {
  start: number;
  end: number;
  text: string;
}

const seconds = (t: string) => t.trim().split(":").reduce((acc, part) => acc * 60 + Number(part), 0);

export function parseVtt(vtt: string): Cue[] {
  const cues: Cue[] = [];
  for (const block of vtt.replace(/\r/g, "").split(/\n{2,}/)) {
    const lines = block.split("\n");
    const at = lines.findIndex((l) => l.includes("-->"));
    if (at < 0) continue;
    const [a, b] = lines[at].split("-->");
    const text = lines.slice(at + 1).join("\n").replace(/<[^>]+>/g, "").trim();
    if (text) cues.push({ start: seconds(a), end: seconds(b.trim().split(/\s+/)[0]), text });
  }
  return cues.sort((x, y) => x.start - y.start);
}

export function cueAt(cues: Cue[], t: number): Cue | null {
  for (const c of cues) if (t >= c.start && t < c.end) return c;
  return null;
}

/** A caption floating in the room: a dark pill with up to two lines, sized to its text. Call set() as cues change. */
export class SpatialCaption {
  mesh: THREE.Mesh;
  private canvas = document.createElement("canvas");
  private tex: THREE.CanvasTexture;
  private text = "";
  private static readonly W = 1280;
  private static readonly H = 220;

  constructor() {
    this.canvas.width = SpatialCaption.W;
    this.canvas.height = SpatialCaption.H;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(0.8, 0.8 * (SpatialCaption.H / SpatialCaption.W)),
      new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, opacity: 0, depthWrite: false }),
    );
    this.mesh.renderOrder = 10;
  }

  set(text: string) {
    if (text === this.text) return;
    this.text = text;
    const c = this.canvas.getContext("2d")!;
    const { W, H } = SpatialCaption;
    c.clearRect(0, 0, W, H);
    if (!text) return void (this.tex.needsUpdate = true);
    c.font = '500 64px -apple-system, "SF Pro Text", "Inter", sans-serif';
    const lines = text.split("\n").slice(0, 2);
    const w = Math.min(W - 16, Math.max(...lines.map((l) => c.measureText(l).width)) + 96);
    const h = lines.length === 1 ? 120 : 196;
    c.fillStyle = "rgba(29,29,31,0.78)";
    c.beginPath();
    c.roundRect((W - w) / 2, (H - h) / 2, w, h, 40);
    c.fill();
    c.fillStyle = "#f5f5f7";
    c.textAlign = "center";
    c.textBaseline = "middle";
    lines.forEach((l, i) => c.fillText(l, W / 2, H / 2 + (i - (lines.length - 1) / 2) * 76, W - 64));
    this.tex.needsUpdate = true;
  }

  /** Ease toward visible or hidden. */
  fade(visible: boolean, dt: number) {
    const m = this.mesh.material as THREE.MeshBasicMaterial;
    m.opacity += ((visible ? 1 : 0) - m.opacity) * Math.min(1, dt * 8);
  }
}
