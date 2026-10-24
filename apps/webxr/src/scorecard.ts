import * as THREE from "three";

// The card at the end of a routine: each step with its stars and match, the best step and the one to practise (with
// the tip that matters most for it). Drawn at twice its size on a 56 x 40 cm card and filtered for angles, so it reads
// sharp at arm's length in the headset; it stands where the step card does, for a while, then the step card is back.

export interface StepScore {
  title: string;
  score: number | null; // 0-100, or null when that step wasn't tried
  stars: number | null;
  tip?: string;
}

const W = 1024, H = 732, DPR = 2; // logical size; the canvas is DPR times that
const FONT = '-apple-system, "SF Pro Text", "Inter", sans-serif';
const DISPLAY = '-apple-system, "SF Pro Display", "Inter", sans-serif';

export class ScoreCard {
  readonly mesh: THREE.Mesh;
  /** When it goes away again (performance.now()), or 0 while hidden. */
  until = 0;
  /** What it last showed (for checks). */
  shown: { title: string; rows: StepScore[]; best: string | null; practise: string | null } | null = null;
  private canvas = document.createElement("canvas");
  private tex: THREE.CanvasTexture;

  constructor() {
    this.canvas.width = W * DPR;
    this.canvas.height = H * DPR;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 8;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.56, (0.56 * H) / W), new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthWrite: false, opacity: 0 }));
    this.mesh.renderOrder = 10;
    this.mesh.visible = false;
  }

  get visible() {
    return this.until > 0;
  }

  /** Shows the card for `seconds` from now. */
  show(title: string, rows: StepScore[], now: number, seconds = 14) {
    const tried = rows.filter((r) => r.score != null);
    const best = tried.length ? tried.reduce((a, b) => (b.score! > a.score! ? b : a)) : null;
    const worst = tried.length > 1 ? tried.reduce((a, b) => (b.score! < a.score! ? b : a)) : null;
    // the step to practise: the weakest, when it's clearly behind the best or short of four and a half stars
    const practise = worst && best && worst !== best && (worst.score! < 90 || best.score! - worst.score! >= 6) ? worst : null;
    this.shown = { title, rows, best: best?.title ?? null, practise: practise?.title ?? null };
    this.draw(title, rows, best, practise);
    this.until = now + seconds * 1000;
    this.mesh.visible = true;
  }

  hide() {
    this.until = 0;
  }

  /** Once a frame: fades in, holds, fades out. True while it shows. */
  update(now: number, dt: number): boolean {
    const m = this.mesh.material as THREE.MeshBasicMaterial;
    const want = this.until > now ? 1 : 0;
    if (!want) this.until = 0;
    m.opacity += (want - m.opacity) * Math.min(1, dt * 6);
    this.mesh.visible = m.opacity > 0.01;
    return want > 0;
  }

  private draw(title: string, rows: StepScore[], best: StepScore | null, practise: StepScore | null) {
    const c = this.canvas.getContext("2d")!;
    c.setTransform(DPR, 0, 0, DPR, 0, 0);
    c.clearRect(0, 0, W, H);
    const P = 56;
    // the same glass as the step card
    const g = c.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "rgba(44,44,48,0.9)");
    g.addColorStop(1, "rgba(22,22,24,0.9)");
    c.fillStyle = g;
    c.beginPath();
    c.roundRect(3, 3, W - 6, H - 6, 44);
    c.fill();
    c.strokeStyle = "rgba(255,255,255,0.14)";
    c.lineWidth = 1.5;
    c.stroke();
    c.textBaseline = "alphabetic";
    c.textAlign = "left";
    c.fillStyle = "#409cff";
    c.font = `600 26px ${FONT}`;
    c.fillText("Routine done", P, 74);
    c.fillStyle = "#f5f5f7";
    c.font = `700 52px ${DISPLAY}`;
    c.fillText(title, P, 136, W - 2 * P);
    // a row per step: number, title, stars, match
    const top = 176;
    const rowH = Math.min(84, (H - top - 210) / Math.max(1, rows.length));
    rows.forEach((r, i) => {
      const y = top + i * rowH;
      if (i) {
        c.fillStyle = "rgba(255,255,255,0.08)";
        c.fillRect(P, y, W - 2 * P, 1.5);
      }
      const mid = y + rowH / 2;
      c.fillStyle = "#8e8e93";
      c.font = `600 28px ${FONT}`;
      c.fillText(String(i + 1), P, mid + 10);
      c.fillStyle = r === best && rows.length > 1 ? "#f5f5f7" : "#e5e5ea";
      c.font = `${r === best && rows.length > 1 ? 600 : 500} 34px ${FONT}`;
      c.fillText(r.title, P + 46, mid + 12, 470);
      const starsX = W - P - 120 - 5 * 40;
      if (r.stars == null) {
        c.fillStyle = "#8e8e93";
        c.font = `500 28px ${FONT}`;
        c.fillText("Not tried", starsX, mid + 10);
      } else {
        for (let k = 0; k < 5; k++) star(c, starsX + k * 40 + 17, mid, 16, THREE.MathUtils.clamp(r.stars - k, 0, 1));
        c.fillStyle = "#f5f5f7";
        c.font = `600 34px ${FONT}`;
        c.textAlign = "right";
        c.fillText(String(Math.round(r.score!)), W - P, mid + 12);
        c.textAlign = "left";
      }
    });
    // best and practise
    let y = top + rows.length * rowH + 58;
    c.fillStyle = "rgba(255,255,255,0.08)";
    c.fillRect(P, y - 44, W - 2 * P, 1.5);
    const line = (label: string, colour: string, text: string, sub?: string) => {
      c.fillStyle = colour;
      c.font = `600 26px ${FONT}`;
      c.fillText(label, P, y);
      c.fillStyle = "#f5f5f7";
      c.font = `600 34px ${FONT}`;
      c.fillText(text, P + 150, y + 2, W - 2 * P - 150);
      if (sub) {
        c.fillStyle = "#ffd99a";
        c.font = `500 28px ${FONT}`;
        c.fillText(sub, P + 150, y + 44, W - 2 * P - 150);
      }
      y += sub ? 96 : 60;
    };
    if (best) line("Best", "#30d158", best.title);
    if (practise) line("Practise", "#ffc86b", practise.title, practise.tip);
    else if (best) line("Next", "#409cff", "Again at full speed");
    this.tex.needsUpdate = true;
  }
}

/** A five-pointed star, filled `fill` of the way across (0 empty, 0.5 half, 1 full). */
function star(c: CanvasRenderingContext2D, x: number, y: number, r: number, fill: number) {
  const path = new Path2D();
  for (let k = 0; k < 10; k++) {
    const a = -Math.PI / 2 + (k * Math.PI) / 5;
    const rr = k % 2 ? r * 0.45 : r;
    const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr;
    if (k) path.lineTo(px, py);
    else path.moveTo(px, py);
  }
  path.closePath();
  c.fillStyle = "rgba(255,255,255,0.2)";
  c.fill(path);
  if (fill <= 0) return;
  c.save();
  c.beginPath();
  c.rect(x - r, y - r, 2 * r * fill, 2 * r);
  c.clip();
  c.fillStyle = "#ffd60a";
  c.fill(path);
  c.restore();
}
