import * as THREE from "three";
import { Chess, type Move, type Square } from "chess.js";
import { XrButton } from "../xr/hands";
import type { HandMenu } from "../xr/menu";
import { FAMOUS, type FamousGame, plyOf, sanList } from "./famous-games";
import { SQUARE, squareToLocal } from "./pieces";
import type { SeatedOpponent } from "./seated";
import type { TableSounds } from "./sound";

// Their famous moves: the legend across the table, and a position from one of his real games on the board, the moment
// before the move he's remembered for (famous-games.ts, every one replayed and engine-checked by
// scripts/check_famous.ts). You find his move by hand. Right: he nods, and the game goes on a few moves, his own moves
// played by his hand. Wrong: the piece slides back and he shakes his head slightly; after two misses the piece he moved
// is lit, after three he shows you. A score of found / total per legend, and the next position.
//
// Hands only, and nothing moves unless you mean it: the board takes no hand while it's setting up, while he's moving,
// or after the position is done; a piece put back on its own square, or an illegal move, isn't a try. He never speaks.

export interface FamousHost {
  root: HTMLElement;
  chess: Chess;
  boardGroup: THREE.Group;
  table: THREE.Group;
  meshes: Map<string, THREE.Object3D>;
  taken: THREE.Group;
  sounds: TableSounds;
  menu: HandMenu;
  seated: () => SeatedOpponent | null;
  presenting: () => boolean;
  eye: (out: THREE.Vector3) => THREE.Vector3;
  /** The strength picked now (a legend's id when it's one). */
  strength: () => string;
  /** Pick a strength (a legend brings his avatar), without starting a game. */
  pick: (id: string) => void;
  /** Stop the game in progress: no engine answer, no clock, nothing in your hand. */
  halt: () => void;
  /** Turn the board so `c` is on your side, and play `c`. */
  orient: (c: "w" | "b") => void;
  sync: (moving?: { from: Square; to: Square }) => void;
  /** His hand plays a move already made on `chess`; `then` once it's down. False with nobody in the chair. */
  handMove: (mv: Move, then: () => void) => boolean;
  /** The status line again (game.ts asks famous.status while this is on). */
  refresh: () => void;
  /** Back to a game against the engine, at this strength if given. */
  leave: (strength?: string) => void;
}

type State = "off" | "setup" | "find" | "playing" | "done";
interface Anim {
  obj: THREE.Object3D;
  from: THREE.Vector3;
  to: THREE.Vector3;
  t0: number;
  dur: number;
  s0: number;
  s1: number;
  leave?: boolean;
}

const FONT = '-apple-system, "SF Pro Text", "Inter", sans-serif';
const STORE = "lucid.chess.famous";
const NEXT_AFTER_MS = 9000; // a finished position stays this long, then the next one sets up
const SURNAME: Record<string, string> = { fischer: "Fischer", carlsen: "Carlsen" };

const label = (ply: number, san: string) => `${Math.floor(ply / 2) + 1}${ply % 2 ? "..." : "."}${san}`;
const bare = (san: string) => san.replace(/[+#]$/, "");

export class FamousMoves {
  state: State = "off";
  /** What the status line says while this is on. */
  status = "";
  private legend = "fischer";
  private list: FamousGame[] = [];
  private index = 0;
  private game: FamousGame | null = null;
  private sans: string[] = [];
  private ply = 0; // the famous move's ply in the score
  private color: "w" | "b" = "w"; // his side (the side to move)
  private want: Move | null = null;
  private misses = 0;
  private shown = false; // he showed it (three misses): not counted as found
  private token = 0; // bumped on every new position or stop: anything scheduled for an older one is dropped
  private queue: { at: number; token: number; fn: () => void }[] = [];
  private anims: Anim[] = [];
  private leaving = new THREE.Group();
  private byHand = new Set<number>(); // plies since the position was set up that his hand played
  private found: Record<string, string[]> = {};
  private hint = new THREE.Group();
  private hintSquare: THREE.MeshBasicMaterial;
  private hintRing: THREE.MeshBasicMaterial;
  private hintOn = false;
  private chime: AudioBuffer;
  private voice: THREE.Audio;
  private card: Card;
  private dom: HTMLElement;
  private toggle: HTMLButtonElement;
  private menuButton: XrButton;
  private nextButton: XrButton;
  private eyeAt = new THREE.Vector3();

  constructor(private host: FamousHost) {
    try {
      this.found = JSON.parse(localStorage.getItem(STORE) ?? "{}") ?? {};
    } catch {
      this.found = {};
    }
    host.boardGroup.add(this.leaving);
    // the piece he moved, lit after two misses: its square glows warm and a ring breathes around its foot
    this.hintSquare = new THREE.MeshBasicMaterial({ color: 0xffd60a, transparent: true, opacity: 0, depthWrite: false });
    this.hintRing = new THREE.MeshBasicMaterial({ color: 0xffd60a, transparent: true, opacity: 0, depthWrite: false });
    const sq = new THREE.Mesh(new THREE.PlaneGeometry(SQUARE * 0.96, SQUARE * 0.96), this.hintSquare);
    const ring = new THREE.Mesh(new THREE.RingGeometry(SQUARE * 0.39, SQUARE * 0.48, 48), this.hintRing);
    ring.position.z = 0.0003;
    this.hint.add(sq, ring);
    this.hint.rotation.x = -Math.PI / 2;
    this.hint.visible = false;
    host.boardGroup.add(this.hint);
    const ctx = host.sounds.listener.context;
    this.chime = chime(ctx);
    this.voice = new THREE.Audio(host.sounds.listener);
    this.card = new Card();
    host.table.add(this.card.mesh);

    // the laptop: a toggle with the game's controls, and the card at the left
    this.toggle = document.createElement("button");
    this.toggle.className = "pill";
    this.toggle.id = "famous";
    this.toggle.textContent = "Their famous moves";
    this.toggle.addEventListener("click", () => (this.active ? this.leave() : this.start()));
    const controls = host.root.querySelector(".chess-controls");
    controls?.insertBefore(this.toggle, controls.querySelector("#undo"));
    this.dom = document.createElement("aside");
    this.dom.className = "famous-card";
    this.dom.hidden = true;
    this.dom.setAttribute("aria-live", "polite");
    this.dom.innerHTML = `<p class="famous-eyebrow"></p><h3></h3><p class="famous-where"></p>
      <p class="famous-status"></p><div class="famous-foot"><span class="famous-score"></span><button class="pill" type="button">Next position</button></div>
      <p class="famous-fine">Moves from the real game. A likeness, not affiliated.</p>`;
    this.dom.querySelector("button")!.addEventListener("click", () => this.next());
    host.root.appendChild(this.dom);

    // the headset: one entry on the palm menu, and Next while it's on
    this.menuButton = new XrButton("famous", "Famous moves", () => (this.active ? this.leave() : this.start()));
    this.nextButton = new XrButton("famous-next", "Next position", () => this.next());
    host.menu.add(this.menuButton);
  }

  get active() {
    return this.state !== "off";
  }

  /** No hand takes a piece: setting up, his moves, or a position that's done. */
  get locked() {
    return this.active && this.state !== "find";
  }

  /** For game.ts's captured rows: false puts move i (since the position was set up) at his end of the table. */
  row(i: number): boolean | undefined {
    return this.active && this.byHand.has(i) ? false : undefined;
  }

  /** ?famous (or ?famous=carlsen) opens straight into it. */
  fromUrl() {
    const q = new URLSearchParams(location.search);
    if (!q.has("famous")) return;
    const id = q.get("famous");
    const at = Number(q.get("at") ?? NaN);
    this.start(id && SURNAME[id] ? id : undefined, Number.isFinite(at) ? at : undefined);
  }

  /** On, for a legend (the one picked, else Fischer), at its first position not yet found (or `at`). */
  start(legend?: string, at?: number) {
    const id = legend ?? (SURNAME[this.host.strength()] ? this.host.strength() : "fischer");
    const was = this.active;
    this.legend = id;
    this.list = FAMOUS.filter((g) => g.legend === id);
    if (!this.list.length) return;
    if (this.host.strength() !== id) this.host.pick(id);
    if (!was) {
      this.host.halt();
      this.host.menu.add(this.nextButton);
    }
    const done = new Set(this.found[id] ?? []);
    this.index = at !== undefined ? THREE.MathUtils.clamp(at, 0, this.list.length - 1) : Math.max(0, this.list.findIndex((g) => !done.has(g.id)));
    this.toggle.classList.add("on");
    this.menuButton.setOn(true);
    this.dom.hidden = false;
    this.setUp(this.list[this.index]);
  }

  /** Off (the game's own New game, side and level all come through here). Leaves the board as it is. */
  stop() {
    if (!this.active) return;
    this.token++;
    this.state = "off";
    this.queue = [];
    this.finishAnims();
    this.byHand.clear();
    this.showHint(false);
    this.toggle.classList.remove("on");
    this.menuButton.setOn(false);
    this.host.menu.remove(this.nextButton);
    this.dom.hidden = true;
    this.card.mesh.visible = false;
  }

  /** Off, and back to a game. */
  leave(strength?: string) {
    this.stop();
    this.host.leave(strength);
  }

  /** The laptop's strength buttons while this is on: a legend switches whose games, anything else leaves. */
  choose(id: string) {
    if (SURNAME[id]) this.start(id);
    else this.leave(id);
  }

  next() {
    if (!this.active) return;
    this.index = (this.index + 1) % this.list.length;
    this.setUp(this.list[this.index]);
  }

  /**
   * game.ts's tryMove, with your legal move already made on the board's chess: true keeps it (his move), false takes
   * it back (it's undone there and the piece slides back to its square).
   */
  accept(mv: Move): boolean {
    if (this.state !== "find" || !this.want) return false;
    const w = this.want;
    if (mv.from === w.from && mv.to === w.to && (mv.promotion ?? "") === (w.promotion ?? "")) {
      this.right();
      return true;
    }
    const s = this.host.seated();
    if (this.game?.alsoWins?.some((a) => bare(a) === bare(mv.san))) {
      // a move that wins as well isn't a miss: it just isn't his
      this.say(`${bare(mv.san)} wins too, but it isn't what he played. Try again.`);
      s?.glance(0.25, 1.2);
      return false;
    }
    this.misses++;
    this.after(380, () => s?.headShake()); // once the piece is on its way back
    s?.glance(0.1, 1.4);
    if (this.misses === 1) this.say("Not his move. Try again.");
    else if (this.misses === 2) {
      this.say("Not his move. The piece he moved is lit.");
      this.showHint(true);
    } else {
      this.say(`He shows you: ${this.game!.find}`);
      this.state = "playing";
      this.shown = true;
      this.showHint(false);
      this.after(1300, () => this.playOut(this.ply, false));
    }
    return false;
  }

  /** Once a frame: anything scheduled, the board setting itself up, the lit piece, and the card in the room. */
  update() {
    const timeMs = performance.now(); // the clock game.ts's tweens start on (a frame's time can lag it)
    if (!this.active) return;
    for (let k = 0; k < this.queue.length; ) {
      const q = this.queue[k];
      if (q.token !== this.token) this.queue.splice(k, 1);
      else if (timeMs >= q.at) {
        this.queue.splice(k, 1);
        q.fn();
      } else k++;
    }
    for (let k = this.anims.length - 1; k >= 0; k--) {
      const a = this.anims[k];
      const u = THREE.MathUtils.clamp((timeMs - a.t0) / a.dur, 0, 1);
      const e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
      a.obj.position.lerpVectors(a.from, a.to, e);
      a.obj.position.y += Math.sin(Math.PI * e) * 0.035;
      a.obj.scale.setScalar(Math.max(1e-3, THREE.MathUtils.lerp(a.s0, a.s1, e)));
      if (u >= 1) {
        this.anims.splice(k, 1);
        a.obj.position.copy(a.to);
        a.obj.scale.setScalar(a.s1);
        if (a.leave) this.leaving.remove(a.obj);
      }
    }
    if (this.hintOn) {
      const b = 0.5 + 0.5 * Math.sin(timeMs / 280);
      this.hintSquare.opacity = 0.34 + 0.16 * b;
      this.hintRing.opacity = 0.7 + 0.3 * b;
    }
    // the card: at your left over the table, turned to your eyes; the laptop has its own
    this.card.mesh.visible = this.host.presenting() && !!this.game;
    if (this.card.mesh.visible) {
      this.card.mesh.position.set(-SQUARE * 4 - 0.17, 0.2, 0.06);
      this.host.table.updateMatrixWorld();
      this.card.mesh.lookAt(this.host.eye(this.eyeAt));
    }
  }

  // ---------------- one position ----------------

  private setUp(g: FamousGame) {
    const tok = ++this.token;
    this.queue = [];
    this.finishAnims();
    this.game = g;
    this.sans = sanList(g.moves);
    const { ply, san } = plyOf(g.find);
    this.ply = ply;
    const c = new Chess();
    for (const m of this.sans.slice(0, ply)) c.move(m);
    this.color = c.turn();
    this.want = new Chess(c.fen()).move(san);
    this.misses = 0;
    this.shown = false;
    this.byHand.clear();
    this.showHint(false);
    this.state = "setup";
    const s = this.host.seated();
    s?.cancel();
    // the pieces as they stand now (on the board and beside it), in the world, before the board turns
    const before = [...this.host.meshes.values(), ...this.host.taken.children].map((obj) => ({
      obj,
      type: obj.userData.type as string,
      color: obj.userData.color as string,
      world: obj.getWorldPosition(new THREE.Vector3()),
    }));
    this.host.orient(this.color);
    this.host.chess.load(c.fen());
    this.host.sync();
    this.animateIn(before);
    this.drawCard();
    this.say(`Find his move. ${this.color === "w" ? "White" : "Black"} to move.`);
    this.after(1100, () => {
      if (tok !== this.token) return;
      this.state = "find";
      this.host.refresh();
    });
  }

  /** Every piece goes from where it stood to its square in the new position; ones not needed leave the board. */
  private animateIn(before: { obj: THREE.Object3D; type: string; color: string; world: THREE.Vector3 }[]) {
    const bg = this.host.boardGroup;
    bg.updateMatrixWorld(true);
    const old = before.map((b) => ({ ...b, local: bg.worldToLocal(b.world.clone()) }));
    const targets = [...this.host.meshes.values()];
    // nearest same piece first, over all pairs
    const pairs: { t: number; o: number; d: number }[] = [];
    targets.forEach((t, ti) =>
      old.forEach((o, oi) => {
        if (o.type === t.userData.type && o.color === t.userData.color) pairs.push({ t: ti, o: oi, d: o.local.distanceTo(t.position) });
      }),
    );
    pairs.sort((a, b) => a.d - b.d);
    const tUsed = new Map<number, number>();
    const oUsed = new Set<number>();
    for (const p of pairs) {
      if (tUsed.has(p.t) || oUsed.has(p.o)) continue;
      tUsed.set(p.t, p.o);
      oUsed.add(p.o);
    }
    const side = (z: number) => new THREE.Vector3(-(SQUARE * 4 + 0.07), 0, THREE.MathUtils.clamp(z, -SQUARE * 3.5, SQUARE * 3.5)); // beside the board, at your left
    let k = 0;
    targets.forEach((t, ti) => {
      const to = t.position.clone();
      const o = tUsed.get(ti);
      const moves = o === undefined || old[o].local.distanceTo(to) > 1e-4;
      if (!moves) return;
      const from = o === undefined ? side(to.z) : old[o].local;
      this.anims.push({ obj: t, from, to, t0: performance.now() + 40 + k++ * 22, dur: 640, s0: o === undefined ? 0 : 1, s1: 1 });
      t.position.copy(from);
      t.scale.setScalar(o === undefined ? 1e-3 : 1);
    });
    old.forEach((o, oi) => {
      if (oUsed.has(oi)) return;
      o.obj.position.copy(o.local);
      this.leaving.add(o.obj);
      this.anims.push({ obj: o.obj, from: o.local.clone(), to: side(o.local.z), t0: performance.now() + 20 + (k++ % 12) * 18, dur: 520, s0: 1, s1: 0, leave: true });
    });
  }

  private finishAnims() {
    for (const a of this.anims) {
      a.obj.position.copy(a.to);
      a.obj.scale.setScalar(a.s1 || 1);
      if (a.leave) this.leaving.remove(a.obj);
    }
    this.anims = [];
    this.leaving.clear();
  }

  private right() {
    this.state = "playing";
    this.showHint(false);
    const g = this.game!;
    const list = this.found[this.legend] ?? (this.found[this.legend] = []);
    if (!list.includes(g.id)) list.push(g.id);
    try {
      localStorage.setItem(STORE, JSON.stringify(this.found));
    } catch {
      /* the score just isn't kept */
    }
    this.say(`${g.find}. That's his move.`);
    this.drawCard();
    this.playChime();
    const s = this.host.seated();
    s?.glance(0.2, 1.6);
    this.after(450, () => s?.nod());
    this.after(1700, () => this.playOut(this.ply + 1, false));
  }

  /**
   * The game from ply `from` on: his moves by his hand (the famous one too, when he's showing it), the other side's
   * slide by themselves. Then the forced line that was coming, if the game ended here (both sides slide: they were
   * never played), then what happened.
   */
  private playOut(from: number, coming: boolean) {
    const g = this.game!;
    const tok = this.token;
    const line = coming ? sanList(g.coming ?? "") : this.sans;
    const last = coming ? line.length : this.ply + 1 + g.play;
    const step = (i: number) => {
      if (tok !== this.token) return;
      if (i >= last) {
        if (!coming && g.coming) {
          this.say(`${this.color === "w" ? g.black : g.white} resigned here. What was coming: ${g.coming}`);
          this.after(2200, () => playComing());
        } else this.finish();
        return;
      }
      const chess = this.host.chess;
      const ply = coming ? this.ply + 1 + g.play + i : i;
      const mover = chess.turn();
      let mv: Move;
      try {
        mv = chess.move(line[i]);
      } catch {
        return this.finish(); // never: check_famous.ts replays every line
      }
      const text = label(ply, mv.san);
      const isFind = !coming && i === this.ply;
      this.say(coming ? `What was coming: ${text}` : isFind ? `He shows you: ${text}` : `In the game: ${text}`);
      const next = () => this.after(coming ? 900 : 750, () => step(i + 1));
      if (!coming && mover === this.color) {
        this.byHand.add(chess.history().length - 1);
        let went = false;
        const go = () => {
          if (went || tok !== this.token) return;
          went = true;
          next();
        };
        if (this.host.handMove(mv, go)) {
          // his hand puts it down in a few seconds; if he's gone meanwhile (another legend took the chair), it's shown
          this.after(12000, () => {
            if (went) return;
            this.host.sync();
            go();
          });
          return;
        }
        this.byHand.delete(chess.history().length - 1);
      }
      this.host.sync({ from: mv.from, to: mv.to });
      this.after(620, next);
    };
    const playComing = () => this.playOut(0, true);
    if (coming) return step(0);
    step(from);
  }

  private finish() {
    this.state = "done";
    const g = this.game!;
    this.say(`${this.shown ? `His move was ${g.find}. ` : ""}${g.after}`);
    this.drawCard();
    this.after(NEXT_AFTER_MS, () => this.next());
  }

  private showHint(on: boolean) {
    this.hintOn = on;
    this.hint.visible = on && !!this.want;
    if (on && this.want) this.hint.position.copy(squareToLocal(this.want.from, 0.0016));
    else this.hintSquare.opacity = this.hintRing.opacity = 0;
  }

  private after(ms: number, fn: () => void) {
    this.queue.push({ at: performance.now() + ms, token: this.token, fn });
  }

  private say(text: string) {
    this.status = text;
    this.host.refresh();
    (this.dom.querySelector(".famous-status") as HTMLElement).textContent = text;
    this.card.setStatus(text);
  }

  private drawCard() {
    const g = this.game;
    if (!g) return;
    const who = SURNAME[this.legend];
    const found = (this.found[this.legend] ?? []).filter((id) => this.list.some((x) => x.id === id)).length;
    const lines = {
      eyebrow: `From ${who}'s real game  ·  ${this.index + 1} of ${this.list.length}`,
      title: `${g.white} vs ${g.black}`,
      where: g.where + (g.nickname ? `  ·  ${g.nickname}` : ""),
      score: `Found ${found} of ${this.list.length}`,
    };
    const q = (s: string) => this.dom.querySelector(s) as HTMLElement;
    q(".famous-eyebrow").textContent = lines.eyebrow;
    q("h3").textContent = lines.title;
    q(".famous-where").textContent = lines.where;
    q(".famous-score").textContent = lines.score;
    this.card.set(lines);
  }

  private playChime() {
    if (this.host.sounds.listener.context.state !== "running") return;
    if (this.voice.isPlaying) this.voice.stop();
    this.voice.setBuffer(this.chime);
    this.voice.setVolume(0.35);
    this.voice.play();
  }
}

/** A calm two-note chime, made here: a soft fourth, like a bell heard from the next room. */
function chime(ctx: BaseAudioContext): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.floor(sr * 2.2);
  const buf = ctx.createBuffer(1, n, sr);
  const d = buf.getChannelData(0);
  const notes = [
    { f: 783.99, at: 0, amp: 0.55 }, // G5
    { f: 1046.5, at: 0.16, amp: 0.45 }, // C6
  ];
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let v = 0;
    for (const nt of notes) {
      const tt = t - nt.at;
      if (tt < 0) continue;
      const env = Math.min(1, tt / 0.012) * Math.exp(-tt / 0.65);
      v += nt.amp * env * (Math.sin(2 * Math.PI * nt.f * tt) + 0.12 * Math.sin(2 * Math.PI * nt.f * 2.01 * tt) + 0.05 * Math.sin(2 * Math.PI * nt.f * 3 * tt));
    }
    d[i] = v;
  }
  let m = 0;
  for (const v of d) m = Math.max(m, Math.abs(v));
  if (m > 0) for (let i = 0; i < n; i++) d[i] *= 0.7 / m;
  return buf;
}

/** The card in the room: whose game, where, what to do, the score, and what just happened. Drawn at 2x, never blurry. */
class Card {
  readonly mesh: THREE.Mesh;
  private canvas = document.createElement("canvas");
  private tex: THREE.CanvasTexture;
  private lines = { eyebrow: "", title: "", where: "", score: "" };
  private status = "";
  static readonly W = 0.24;
  static readonly H = 0.135;

  constructor() {
    this.canvas.width = 2048;
    this.canvas.height = 1152;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 8;
    this.tex.generateMipmaps = true;
    this.tex.minFilter = THREE.LinearMipmapLinearFilter;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(Card.W, Card.H), new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthWrite: false }));
    this.mesh.renderOrder = 2;
    this.mesh.visible = false;
  }

  set(lines: Card["lines"]) {
    this.lines = lines;
    this.draw();
  }

  setStatus(text: string) {
    this.status = text;
    this.draw();
  }

  private draw() {
    const c = this.canvas.getContext("2d")!;
    const W = 1024;
    const H = 576;
    c.setTransform(2, 0, 0, 2, 0, 0);
    c.clearRect(0, 0, W, H);
    c.fillStyle = "rgba(29,29,31,0.86)";
    c.beginPath();
    c.roundRect(4, 4, W - 8, H - 8, 44);
    c.fill();
    const x = 52;
    const fit = (text: string, weight: number, size: number, max: number) => {
      let s = size;
      do c.font = `${weight} ${s}px ${FONT}`;
      while (c.measureText(text).width > max && (s -= 2) > 18);
    };
    c.textAlign = "left";
    c.textBaseline = "alphabetic";
    const { eyebrow, title, where, score } = this.lines;
    c.fillStyle = "#2997ff";
    fit(eyebrow, 600, 30, W - 2 * x);
    c.fillText(eyebrow, x, 84);
    c.fillStyle = "#f5f5f7";
    fit(title, 600, 58, W - 2 * x);
    c.fillText(title, x, 154);
    c.fillStyle = "#a1a1a6";
    fit(where, 400, 30, W - 2 * x);
    c.fillText(where, x, 202);
    // what to do, and what just happened: up to four lines, wrapped
    c.fillStyle = "#f5f5f7";
    c.font = `500 36px ${FONT}`;
    const words = this.status.split(" ");
    const rows: string[] = [];
    let row = "";
    for (const w of words) {
      const t = row ? `${row} ${w}` : w;
      if (c.measureText(t).width > W - 2 * x && row) {
        rows.push(row);
        row = w;
      } else row = t;
    }
    if (row) rows.push(row);
    rows.slice(0, 4).forEach((r, i) => c.fillText(r, x, 284 + i * 46));
    c.fillStyle = "rgba(255,255,255,0.12)";
    c.fillRect(x, 476, W - 2 * x, 2);
    c.fillStyle = "#a1a1a6";
    fit(score, 500, 28, W - 2 * x);
    c.fillText(score, x, 522);
    c.textAlign = "right";
    c.font = `400 22px ${FONT}`;
    c.fillStyle = "#86868b";
    c.fillText("A likeness, not affiliated", W - x, 522);
    this.tex.needsUpdate = true;
  }
}
