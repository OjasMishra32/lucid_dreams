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
  environment?: string; // a place id from places.ts ("concert-hall", "court", ...) to start in, or "room" for your own room
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

const saying = new Set<SpeechSynthesisUtterance>(); // held until spoken: Chrome drops events of collected utterances

/**
 * Like say(), same voice, but after whatever the device is already saying. Resolves once it's said, dropped, or (on a
 * device whose speech engine never reports back) after about as long as saying it would take.
 */
export function sayNext(text: string): Promise<void> {
  return new Promise((done) => {
    if (!("speechSynthesis" in window) || !text.trim()) return done();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1;
    saying.add(u);
    const long = () => 2000 + text.length * 100;
    let timer = setTimeout(finish, long());
    function finish() {
      clearTimeout(timer);
      if (saying.delete(u)) done();
    }
    u.onstart = () => {
      clearTimeout(timer);
      timer = setTimeout(finish, long());
    };
    u.onend = u.onerror = finish;
    speechSynthesis.speak(u);
  });
}

/** The step card floating beside the person in the room: where you are in the lesson, the step's name and tip, and a
 * bar through your turn. Drawn large (1536 x 768 on a 56 cm card) and filtered for angles, so it reads crisp in the
 * headset. */
export class StepCard {
  mesh: THREE.Mesh;
  /** The coach's line (what you asked, then its answer), shown in place of the tip while there is one. */
  note: { label: string; text: string } | null = null;
  private canvas = document.createElement("canvas");
  private tex: THREE.CanvasTexture;

  constructor() {
    this.canvas.width = 1536;
    this.canvas.height = 768;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 8;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.56, 0.28), new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthWrite: false }));
    this.mesh.renderOrder = 10;
  }

  draw(lesson: Lesson, now: number) {
    const c = this.canvas.getContext("2d")!;
    const W = 1536, H = 768, P = 96;
    c.clearRect(0, 0, W, H);
    // glass: deep and quiet, a hairline of light on its edge
    const g = c.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "rgba(44,44,48,0.86)");
    g.addColorStop(1, "rgba(22,22,24,0.86)");
    c.fillStyle = g;
    c.beginPath();
    c.roundRect(6, 6, W - 12, H - 12, 72);
    c.fill();
    c.strokeStyle = "rgba(255,255,255,0.14)";
    c.lineWidth = 3;
    c.stroke();
    const s = lesson.step;
    const turn = lesson.phase === "turn";
    // where you are: a dot per step, the current one long
    let x = P;
    lesson.steps.forEach((_, k) => {
      const on = k === lesson.i;
      c.fillStyle = on ? (turn ? "#0a84ff" : "#f5f5f7") : "rgba(255,255,255,0.28)";
      c.beginPath();
      c.roundRect(x, 104, on ? 64 : 18, 18, 9);
      c.fill();
      x += (on ? 64 : 18) + 14;
    });
    c.textAlign = "left";
    c.textBaseline = "alphabetic";
    c.fillStyle = turn ? "#409cff" : "#a1a1a6";
    c.font = '600 44px -apple-system, "SF Pro Text", "Inter", sans-serif';
    c.fillText(turn ? "Your turn" : `Step ${lesson.i + 1} of ${lesson.steps.length}`, x + 16, 124);
    c.fillStyle = "#f5f5f7";
    c.font = '700 96px -apple-system, "SF Pro Display", "Inter", sans-serif';
    fit(c, s.title, W - 2 * P, 96, 64, '700 %spx -apple-system, "SF Pro Display", "Inter", sans-serif');
    c.fillText(s.title, P, 262, W - 2 * P);
    if (this.note) {
      c.fillStyle = "#409cff";
      c.font = '600 44px -apple-system, "SF Pro Text", "Inter", sans-serif';
      c.fillText(this.note.label, P, 352, W - 2 * P);
      c.fillStyle = "#e5e5ea";
      c.font = '400 52px -apple-system, "SF Pro Text", "Inter", sans-serif';
      wrap(c, this.note.text, P, 428, W - 2 * P, 68, 3);
    } else if (s.tip) {
      c.fillStyle = "#e5e5ea";
      c.font = '400 56px -apple-system, "SF Pro Text", "Inter", sans-serif';
      wrap(c, s.tip, P, 368, W - 2 * P, 74, 3);
    }
    // your turn: a bar that empties as the time runs out
    if (turn) {
      c.fillStyle = "rgba(255,255,255,0.14)";
      c.beginPath();
      c.roundRect(P, H - 104, W - 2 * P, 16, 8);
      c.fill();
      c.fillStyle = "#0a84ff";
      c.beginPath();
      c.roundRect(P, H - 104, Math.max(16, (W - 2 * P) * (1 - lesson.turnProgress(now))), 16, 8);
      c.fill();
    }
    this.tex.needsUpdate = true;
  }
}

/** A title that would run long gets a smaller size (down to `min` px) instead of being squeezed. */
function fit(c: CanvasRenderingContext2D, text: string, max: number, size: number, min: number, font: string) {
  while (size > min) {
    c.font = font.replace("%s", String(size));
    if (c.measureText(text).width <= max) return;
    size -= 4;
  }
  c.font = font.replace("%s", String(min));
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

/**
 * Until the experience step has written a plan, the intent alone still shapes what happens: "teach me / show me / how
 * to" becomes a lesson in three equal parts, "chess" a game, "be with / sit with / miss" a companion. Generic on
 * purpose; Gemini's plan replaces it.
 */
export function fallbackExperience(dream: Dream, duration: number): Experience | null {
  const intent = dream.intent?.trim();
  if (!intent) return null;
  const said = intent.toLowerCase();
  if (/\bchess\b/.test(said)) return { intent, mode: "play", play: { game: "chess", strength: "gm" } };
  if (/\b(teach|learn|show me|how (do|to)|practi[cs]e|coach)\b/.test(said)) {
    const parts = duration >= 3 ? 3 : 2;
    const len = duration / parts;
    return {
      intent,
      mode: "teach",
      title: intent.charAt(0).toUpperCase() + intent.slice(1),
      // an instrument is learned sitting next to the teacher; a movement by following them; anything else face to face
      place: /\b(piano|keyboard|guitar|violin|cello|drums|ukulele|instrument|play this song|play this piece)\b/.test(said)
        ? "beside"
        : /\b(dance|move|shoot|swing|throw|kick|form|step)\b/.test(said)
          ? "ahead"
          : "facing",
      steps: Array.from({ length: parts }, (_, i) => ({
        start: i * len,
        end: (i + 1) * len,
        title: `Part ${i + 1}`,
        tip: i === 0 ? "Watch it slowly, then copy it." : "Same again: watch, then your turn.",
        speed: 0.5,
        repeat: 2,
      })),
    };
  }
  if (/\b(be with|sit with|stay with|miss|talk|hug|remember)\b/.test(said)) return { intent, mode: "companion", place: "facing" };
  return { intent, mode: "watch" };
}
