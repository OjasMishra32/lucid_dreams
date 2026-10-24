import * as THREE from "three";
import { crisp } from "../xr/quality";
import type { Score } from "./score";

// The words around the court, all drawn at twice their layout size and filtered for angles so they stay sharp in the
// headset: the scoreboard at the side of the court, the line over the opponent (who he is, and that he's an AI and
// not affiliated), the big call over the net ("Out", "Fault", "Let") and a quiet hint line in front of you.

const FONT = '-apple-system, "SF Pro Display", "SF Pro Text", "Inter", "Helvetica Neue", sans-serif';
const BALL = "#d4e157";

function canvasTex(w: number, h: number, renderer: THREE.WebGLRenderer) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  crisp(tex, renderer);
  return { c, g: c.getContext("2d")!, tex };
}

export class Scoreboard {
  readonly mesh: THREE.Mesh;
  private c: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private tex: THREE.CanvasTexture;
  private last = "";

  constructor(renderer: THREE.WebGLRenderer) {
    const { c, g, tex } = canvasTex(2048, 768, renderer);
    this.c = c;
    this.g = g;
    this.tex = tex;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.9), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    this.mesh.renderOrder = 12;
  }

  /** Redraw (only when something changed). footer: the line under the score. practice: hits in a row, no score. */
  draw(score: Score | null, server: 0 | 1 | null, footer: string, practice?: { inRow: number; best: number }) {
    const key = JSON.stringify([score?.sets, score?.games, score?.points, score?.tiebreak, score?.names, server, footer, practice]);
    if (key === this.last) return;
    this.last = key;
    const g = this.g;
    const W = this.c.width;
    const H = this.c.height;
    g.clearRect(0, 0, W, H);
    g.fillStyle = "rgba(14,16,18,0.9)";
    g.beginPath();
    g.roundRect(8, 8, W - 16, H - 16, 56);
    g.fill();
    g.textBaseline = "middle";
    if (practice || !score) {
      g.fillStyle = "#f5f5f7";
      g.font = `700 150px ${FONT}`;
      g.textAlign = "left";
      g.fillText("Practice", 90, 200);
      g.font = `600 110px ${FONT}`;
      g.fillStyle = "#a1a1a6";
      g.fillText(`In a row  ${practice?.inRow ?? 0}`, 90, 380);
      g.fillText(`Best  ${practice?.best ?? 0}`, 1150, 380);
    } else {
      const rows: [0 | 1, number][] = [[1, 150], [0, 370]];
      const nameX = 150;
      const colW = 170;
      const ptsW = 300;
      const setCols = score.sets.length;
      const gamesX = W - 70 - ptsW - 40 - colW / 2;
      for (const [s, y] of rows) {
        // a row: who serves, name, the sets so far, this set's games, the points
        if (server === s) {
          g.fillStyle = BALL;
          g.beginPath();
          g.arc(85, y, 26, 0, Math.PI * 2);
          g.fill();
        }
        g.fillStyle = "#f5f5f7";
        g.textAlign = "left";
        g.font = `600 120px ${FONT}`;
        let name = score.names[s];
        while (g.measureText(name).width > gamesX - colW * (setCols + 0.6) - nameX && name.length > 3) name = name.slice(0, -2) + "…";
        g.fillText(s === 0 ? "You" : name, nameX, y + 6);
        g.textAlign = "center";
        g.font = `500 120px ${FONT}`;
        g.fillStyle = "#8e8e93";
        score.sets.forEach((set, i) => g.fillText(String(set[s]), gamesX - colW * (setCols - i), y + 6));
        g.fillStyle = "#f5f5f7";
        g.font = `700 130px ${FONT}`;
        g.fillText(String(score.games[s]), gamesX, y + 6);
        g.fillStyle = "rgba(255,255,255,0.12)";
        g.beginPath();
        g.roundRect(W - 70 - ptsW, y - 95, ptsW, 190, 28);
        g.fill();
        g.fillStyle = "#f5f5f7";
        g.font = `700 130px ${FONT}`;
        g.fillText(score.pointLabel(s), W - 70 - ptsW / 2, y + 6);
      }
      if (score.tiebreak) {
        g.fillStyle = BALL;
        g.font = `600 56px ${FONT}`;
        g.textAlign = "right";
        g.fillText("TIEBREAK", W - 70, 40 + 6);
      }
    }
    g.fillStyle = "rgba(255,255,255,0.1)";
    g.fillRect(70, 520, W - 140, 3);
    g.fillStyle = "#d1d1d6";
    g.textAlign = "center";
    let size = 92;
    do g.font = `500 ${size}px ${FONT}`;
    while (g.measureText(footer).width > W - 160 && (size -= 4) > 40);
    g.fillText(footer, W / 2, 640);
    this.tex.needsUpdate = true;
  }
}

/** One line of text floating in the court, turned toward you. */
export class FloatText {
  readonly mesh: THREE.Mesh;
  private c: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private tex: THREE.CanvasTexture;
  private text = "";
  private mat: THREE.MeshBasicMaterial;

  constructor(renderer: THREE.WebGLRenderer, width: number, private opts = { px: 2048, h: 160, size: 84, weight: 500, bg: "rgba(0,0,0,0.55)", color: "#f2f2f7" }) {
    const { c, g, tex } = canvasTex(opts.px, opts.h, renderer);
    this.c = c;
    this.g = g;
    this.tex = tex;
    this.mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: true });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, (width * opts.h) / opts.px), this.mat);
    this.mesh.renderOrder = 13;
    this.mesh.visible = false;
  }

  set(text: string) {
    this.mesh.visible = !!text;
    if (text === this.text) return;
    this.text = text;
    const { g, c } = this;
    const o = this.opts;
    g.clearRect(0, 0, c.width, c.height);
    if (!text) return;
    let size = o.size;
    do g.font = `${o.weight} ${size}px ${FONT}`;
    while (g.measureText(text).width > c.width - 80 && (size -= 4) > 24);
    const w = Math.min(c.width - 12, g.measureText(text).width + size * 1.4);
    if (o.bg) {
      g.fillStyle = o.bg;
      g.beginPath();
      g.roundRect(c.width / 2 - w / 2, 6, w, c.height - 12, (c.height - 12) / 2);
      g.fill();
    }
    g.fillStyle = o.color;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(text, c.width / 2, c.height / 2 + 4);
    this.tex.needsUpdate = true;
  }

  opacity(a: number) {
    this.mat.opacity = a;
  }

  /** At a point (the parent's space), turned about the vertical to face `eye` (same space). */
  place(at: THREE.Vector3, eye: THREE.Vector3) {
    this.mesh.position.copy(at);
    this.mesh.rotation.set(0, Math.atan2(eye.x - at.x, eye.z - at.z), 0);
  }
}
