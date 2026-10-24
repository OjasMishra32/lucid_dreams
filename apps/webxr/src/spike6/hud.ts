import * as THREE from "three";

export type HudView = {
  title: string;
  phase: string;
  hint: string;
  countdown: string;
  lines: string[];
};

export type ResultsView = {
  title: string;
  lines: string[]; // above the table
  table: { head: string[]; rows: string[][] };
  checks: string[]; // below the table
  footer: string[];
};

const W = 1536;
const H = 1536;
const MONO = `ui-monospace, "SF Mono", Menlo, Consolas, monospace`;

/** A large canvas panel for the headset: redrawn only when its text changes. */
export class Hud {
  readonly group = new THREE.Group(); // world-locked; the panel inside turns to face you
  readonly panel: THREE.Mesh;
  private ctx: CanvasRenderingContext2D;
  private tex: THREE.CanvasTexture;
  private last = "";

  constructor() {
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    this.ctx = canvas.getContext("2d")!;
    this.tex = new THREE.CanvasTexture(canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 8;
    this.panel = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 1.2), new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthWrite: false }));
    this.panel.renderOrder = 10;
    this.group.add(this.panel);
  }

  /** Face the viewer, turning about the vertical axis only. */
  face(head: THREE.Vector3) {
    this.panel.lookAt(head.x, this.group.position.y + this.panel.position.y, head.z);
  }

  private changed(view: unknown) {
    const key = JSON.stringify(view);
    if (key === this.last) return false;
    this.last = key;
    return true;
  }

  private background(height: number) {
    const c = this.ctx;
    c.clearRect(0, 0, W, H);
    c.fillStyle = "rgba(9,13,22,0.92)";
    c.beginPath();
    c.roundRect(8, 8, W - 16, Math.min(H, height) - 16, 40);
    c.fill();
    c.textBaseline = "alphabetic";
    c.textAlign = "left";
  }

  /** While a phase runs: its name, what to do, a countdown and live numbers. */
  draw(view: HudView) {
    if (!this.changed(view)) return;
    const c = this.ctx;
    this.background(320 + view.lines.length * 54 + 40);
    c.fillStyle = "#8fb4ff";
    c.font = `600 40px system-ui, sans-serif`;
    c.fillText(view.title, 56, 82);
    c.fillStyle = "#ffffff";
    c.font = `700 72px system-ui, sans-serif`;
    c.fillText(view.phase, 56, 176);
    c.fillStyle = "#ffd479";
    c.font = `500 44px system-ui, sans-serif`;
    c.fillText(view.hint, 56, 240);
    c.textAlign = "right";
    c.fillStyle = "#ffffff";
    c.font = `700 150px ${MONO}`;
    c.fillText(view.countdown, W - 56, 200);
    c.textAlign = "left";
    let y = 320;
    c.font = `500 38px ${MONO}`;
    c.fillStyle = "#e6edf7";
    for (const line of view.lines) {
      c.fillText(line, 56, y);
      y += 54;
    }
    this.tex.needsUpdate = true;
  }

  /** The table to photograph: one row per phase, then the checks. */
  drawResults(view: ResultsView) {
    if (!this.changed(view)) return;
    const c = this.ctx;
    const rowH = 44;
    const lineH = 41;
    const height = 120 + view.lines.length * lineH + 30 + (view.table.rows.length + 1) * rowH + 24 + view.checks.length * lineH + view.footer.length * 38 + 40;
    this.background(height);
    c.fillStyle = "#8fb4ff";
    c.font = `700 46px system-ui, sans-serif`;
    c.fillText(view.title, 48, 78);
    let y = 128;
    c.font = `500 30px ${MONO}`;
    c.fillStyle = "#e6edf7";
    for (const line of view.lines) {
      c.fillText(line, 48, y);
      y += lineH;
    }
    y += 22;
    const cols = view.table.head.length;
    const first = 232;
    const step = (W - 96 - first) / (cols - 1);
    const cell = (text: string, i: number) => {
      c.textAlign = i === 0 ? "left" : "right";
      c.fillText(text, i === 0 ? 48 : 48 + first + step * i, y);
    };
    c.font = `700 29px ${MONO}`;
    c.fillStyle = "#8fb4ff";
    view.table.head.forEach(cell);
    c.font = `500 31px ${MONO}`;
    view.table.rows.forEach((row, r) => {
      y += rowH;
      c.fillStyle = r % 2 ? "#e6edf7" : "#ffffff";
      row.forEach(cell);
    });
    c.textAlign = "left";
    y += 24;
    c.font = `500 30px ${MONO}`;
    for (const line of view.checks) {
      y += lineH;
      c.fillStyle = /FAIL|ENDED|no:|failed|unsupported/i.test(line) ? "#ff9b8f" : "#e6edf7";
      c.fillText(line, 48, y);
    }
    c.font = `500 28px ${MONO}`;
    c.fillStyle = "#a9b6c9";
    for (const line of view.footer) {
      y += 38;
      c.fillText(line, 48, y);
    }
    this.tex.needsUpdate = true;
  }
}
