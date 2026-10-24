import * as THREE from "three";
import { type Dream, dreamUrl } from "./dream";

// What you came to do with this person: the plan written from your intent ("teach me this strum") by the experience
// step (Gemini on the bridge), stored as the bundle's experience.json. Contract: AGENTS.md, "Experience".

export interface Step {
  start: number; // seconds in the clip
  end: number;
  title: string;
  tip?: string;
  speed?: number; // playback speed while you watch this step (default 0.5)
  repeat?: number; // times it plays before your turn (default 2)
}

export interface Experience {
  intent?: string;
  mode: "teach" | "watch" | "companion" | "play";
  title?: string;
  summary?: string;
  place?: "facing" | "beside" | "ahead"; // facing you; at your side facing your way; in front facing your way
  steps?: Step[];
  play?: { game: "chess"; strength?: string };
}

export async function loadExperience(dream: Dream): Promise<Experience | null> {
  if (!dream.experience) return null;
  const r = await fetch(dreamUrl(dream.id, dream.experience), { cache: "no-cache" }).catch(() => null);
  if (!r?.ok) return null;
  const e = (await r.json().catch(() => null)) as Experience | null;
  if (!e?.mode) return null;
  e.steps = (e.steps ?? [])
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    .sort((a, b) => a.start - b.start);
  return e;
}

/**
 * A lesson: each step plays slowed down a couple of times, then they freeze in the step's last pose for your turn
 * (as long as the move takes at full speed, plus a breath), then the next step. After the last step it starts over.
 */
export class Lesson {
  i = 0;
  rep = 0;
  phase: "watch" | "turn" = "watch";
  turnEnds = 0;
  turnLength = 0;
  onChange: () => void = () => {};

  constructor(readonly steps: Step[]) {}

  get step(): Step {
    return this.steps[this.i];
  }
  get speed(): number {
    return this.step.speed ?? 0.5;
  }

  go(i: number) {
    this.i = (i + this.steps.length) % this.steps.length;
    this.rep = 0;
    this.phase = "watch";
    this.onChange();
  }

  /** Called each frame with the clip time after this frame's advance; returns where playback should be. */
  update(t: number, now: number): number {
    const s = this.step;
    if (this.phase === "turn") {
      if (now < this.turnEnds) return s.end - 0.001; // frozen in the last pose of the move
      this.go(this.i + 1);
      return this.step.start;
    }
    if (t >= s.end) {
      this.rep++;
      if (this.rep >= (s.repeat ?? 2)) {
        this.phase = "turn";
        this.turnLength = (s.end - s.start) * 1000 + 1500;
        this.turnEnds = now + this.turnLength;
        this.onChange();
        return s.end - 0.001;
      }
      return s.start;
    }
    return t < s.start ? s.start : t;
  }

  /** 0 -> 1 through your turn. */
  turnProgress(now: number): number {
    return this.phase === "turn" ? Math.min(1, 1 - (this.turnEnds - now) / this.turnLength) : 0;
  }
}

/** Says the step out loud in the device's own voice (never the person's). Quietly does nothing where unsupported. */
export function say(text: string) {
  if (!("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1;
  speechSynthesis.speak(u);
}

/** The step card floating beside the person in the room: step count, title, tip, and a bar through your turn. */
export class StepCard {
  mesh: THREE.Mesh;
  private canvas = document.createElement("canvas");
  private tex: THREE.CanvasTexture;

  constructor() {
    this.canvas.width = 1024;
    this.canvas.height = 512;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.56, 0.28), new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthWrite: false }));
    this.mesh.renderOrder = 10;
  }

  draw(lesson: Lesson, now: number) {
    const c = this.canvas.getContext("2d")!;
    const W = 1024, H = 512;
    c.clearRect(0, 0, W, H);
    c.fillStyle = "rgba(29,29,31,0.8)";
    c.beginPath();
    c.roundRect(8, 8, W - 16, H - 16, 56);
    c.fill();
    const s = lesson.step;
    c.textAlign = "left";
    c.textBaseline = "alphabetic";
    c.fillStyle = "#a1a1a6";
    c.font = '500 36px -apple-system, "SF Pro Text", "Inter", sans-serif';
    c.fillText(lesson.phase === "turn" ? "Your turn" : `Step ${lesson.i + 1} of ${lesson.steps.length}`, 64, 104);
    c.fillStyle = "#f5f5f7";
    c.font = '600 64px -apple-system, "SF Pro Display", "Inter", sans-serif';
    c.fillText(s.title, 64, 190, W - 128);
    if (s.tip) {
      c.fillStyle = "#d1d1d6";
      c.font = '400 40px -apple-system, "SF Pro Text", "Inter", sans-serif';
      wrap(c, s.tip, 64, 262, W - 128, 52, 3);
    }
    if (lesson.phase === "turn") {
      c.fillStyle = "rgba(255,255,255,0.14)";
      c.beginPath();
      c.roundRect(64, H - 72, W - 128, 10, 5);
      c.fill();
      c.fillStyle = "#0a84ff";
      c.beginPath();
      c.roundRect(64, H - 72, (W - 128) * lesson.turnProgress(now), 10, 5);
      c.fill();
    }
    this.tex.needsUpdate = true;
  }
}

function wrap(c: CanvasRenderingContext2D, text: string, x: number, y: number, max: number, lh: number, lines: number) {
  const words = text.split(/\s+/);
  let line = "";
  let n = 0;
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (c.measureText(next).width > max && line) {
      c.fillText(n === lines - 1 ? `${line}…` : line, x, y + n * lh);
      if (++n >= lines) return;
      line = w;
    } else line = next;
  }
  if (line) c.fillText(line, x, y + n * lh);
}
