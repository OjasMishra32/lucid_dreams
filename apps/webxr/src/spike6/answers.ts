import * as THREE from "three";
import type { Mode } from "./court-quest";

// The panel on your right after the results: the boundary questions (answered by aiming a hand at Yes or No and
// pinching), everyone's answers for VR and AR-opaque, and the two modes' frame times for the same scene side by side.

export type QuestionId = "edgeWall" | "pastEdge" | "edgeFade";
export type Answer = boolean | "skip";
export type Answers = Partial<Record<QuestionId, Answer>>;
export const QUESTIONS: { id: QuestionId; short: string; lines: string[]; modes: Mode[]; edgeOff: boolean }[] = [
  {
    id: "edgeWall", short: "Boundary wall/grid at the edge", modes: ["vr", "ar-opaque"], edgeOff: true,
    lines: ["Walk slowly, a hand out, someone spotting you.", "At the edge of your boundary: does the", "boundary wall or grid appear? (None: stop.)"],
  },
  {
    id: "pastEdge", short: "Room shows a foot past the edge", modes: ["vr", "ar-opaque"], edgeOff: true,
    lines: ["Only if the wall appeared: step one foot", "past it. Does your room show through?", "(No wall: press Skip, don't step past.)"],
  },
  {
    id: "edgeFade", short: "Edge fade: room from 0.6 m, all at 0.3", modes: ["ar-opaque"], edgeOff: false,
    lines: ["Walk slowly toward the edge of the play area.", "Does your room appear from about 0.6 m out", "and show fully at 0.3 m?"],
  },
];

export type PanelView = {
  title: string;
  question: { index: number; total: number; lines: string[]; note: string } | null;
  answers: { head: string[]; rows: string[][] };
  compare: { head: string[]; rows: string[][]; note: string };
  footer: string[];
};

const W = 1536;
const MONO = `ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
const PX = 1.2 / W; // metres per canvas pixel
const BUTTON_Y = 470; // canvas y of the buttons' centres

function canvasTexture(w: number, h: number) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return { ctx: canvas.getContext("2d")!, tex };
}

type Kind = "yes" | "no" | "skip";
const LABEL: Record<Kind, string> = { yes: "Yes", no: "No", skip: "Skip" };

function buttonTexture(label: string, hover: boolean) {
  const { ctx: c, tex } = canvasTexture(512, 220);
  c.fillStyle = hover ? "#0a84ff" : label === "Yes" ? "#1f6f43" : label === "No" ? "#7a2a2a" : "#3a3f4a";
  c.beginPath();
  c.roundRect(8, 8, 496, 204, 100);
  c.fill();
  c.lineWidth = hover ? 14 : 0;
  c.strokeStyle = "#ffffff";
  if (hover) c.stroke();
  c.fillStyle = "#ffffff";
  c.font = `700 120px system-ui, sans-serif`;
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.fillText(label, 256, 116);
  return tex;
}

export class AnswerPanel {
  readonly group = new THREE.Group();
  readonly panel: THREE.Mesh;
  readonly buttons: Record<Kind, THREE.Mesh>;
  private ctx: CanvasRenderingContext2D;
  private tex: THREE.CanvasTexture;
  private live: { ctx: CanvasRenderingContext2D; tex: THREE.CanvasTexture; mesh: THREE.Mesh; last: string };
  private looks: Record<Kind, { idle: THREE.Texture; hover: THREE.Texture }>;
  private rays: THREE.Line[] = [];
  private cursors: THREE.Mesh[] = [];
  private hover: (null | Kind)[] = [];
  private raycaster = new THREE.Raycaster();
  private last = "";
  private origin = new THREE.Vector3();
  private dir = new THREE.Vector3();
  private q = new THREE.Quaternion();

  constructor(scene: THREE.Scene, private controllers: THREE.XRTargetRaySpace[], private onAnswer: (answer: Answer) => void) {
    const main = canvasTexture(W, W);
    this.ctx = main.ctx;
    this.tex = main.tex;
    this.panel = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 1.2), new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthWrite: false }));
    this.panel.renderOrder = 10;
    this.group.add(this.panel);
    const look = (kind: Kind) => ({ idle: buttonTexture(LABEL[kind], false), hover: buttonTexture(LABEL[kind], true) });
    this.looks = { yes: look("yes"), no: look("no"), skip: look("skip") };
    const button = (kind: Kind, x: number) => {
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.112), new THREE.MeshBasicMaterial({ map: this.looks[kind].idle, transparent: true, depthWrite: false }));
      mesh.position.set(x, 0.6 - BUTTON_Y * PX, 0.01);
      mesh.renderOrder = 11;
      mesh.name = kind;
      this.panel.add(mesh);
      return mesh;
    };
    this.buttons = { yes: button("yes", -0.3), no: button("no", 0), skip: button("skip", 0.3) };
    const live = canvasTexture(1400, 70);
    const liveMesh = new THREE.Mesh(new THREE.PlaneGeometry(1400 * PX, 70 * PX), new THREE.MeshBasicMaterial({ map: live.tex, transparent: true, depthWrite: false }));
    liveMesh.position.set(0, 0.6 - 590 * PX, 0.005);
    liveMesh.renderOrder = 11;
    this.panel.add(liveMesh);
    this.live = { ...live, mesh: liveMesh, last: "" };
    controllers.forEach((c, i) => {
      const geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]);
      const ray = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: 0x9fd0ff, transparent: true, opacity: 0.8 }));
      ray.frustumCulled = false;
      ray.visible = false;
      scene.add(ray);
      this.rays.push(ray);
      const cursor = new THREE.Mesh(new THREE.SphereGeometry(0.008, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }));
      cursor.visible = false;
      scene.add(cursor);
      this.cursors.push(cursor);
      this.hover.push(null);
      c.addEventListener("select", () => this.select(i));
    });
    this.group.visible = false;
    scene.add(this.group);
  }

  get asking() {
    return this.group.visible && this.buttons.yes.visible;
  }

  /** Face the viewer, turning about the vertical axis only. */
  face(head: THREE.Vector3) {
    this.panel.lookAt(head.x, this.group.position.y + this.panel.position.y, head.z);
  }

  /** Per frame while shown: aim rays from each hand, light the button a ray is on. */
  update() {
    const asking = this.asking;
    this.group.updateMatrixWorld(true);
    this.controllers.forEach((c, i) => {
      const ray = this.rays[i];
      const cursor = this.cursors[i];
      this.hover[i] = null;
      if (!asking || !c.visible) {
        ray.visible = cursor.visible = false;
        return;
      }
      c.updateMatrixWorld(true);
      c.getWorldPosition(this.origin);
      this.dir.set(0, 0, -1).applyQuaternion(c.getWorldQuaternion(this.q));
      this.raycaster.set(this.origin, this.dir);
      const hit = this.raycaster.intersectObjects(Object.values(this.buttons), false)[0];
      const length = hit ? hit.distance : 2.5;
      const pts = ray.geometry.attributes.position as THREE.BufferAttribute;
      pts.setXYZ(0, this.origin.x, this.origin.y, this.origin.z);
      pts.setXYZ(1, this.origin.x + this.dir.x * length, this.origin.y + this.dir.y * length, this.origin.z + this.dir.z * length);
      pts.needsUpdate = true;
      ray.visible = true;
      cursor.visible = !!hit;
      if (hit) {
        cursor.position.copy(hit.point);
        this.hover[i] = hit.object.name as Kind;
      }
    });
    for (const kind of ["yes", "no", "skip"] as const) {
      const map = this.hover.includes(kind) ? this.looks[kind].hover : this.looks[kind].idle;
      const material = this.buttons[kind].material as THREE.MeshBasicMaterial;
      if (material.map !== map) material.map = map;
    }
  }

  private select(i: number) {
    const h = this.hover[i];
    if (this.asking && h) this.onAnswer(h === "skip" ? "skip" : h === "yes");
  }

  hide() {
    this.group.visible = false;
    this.rays.forEach((r) => (r.visible = false));
    this.cursors.forEach((c) => (c.visible = false));
  }

  /** The live line under the question (distance to the edge): its own small canvas, so it can change every frame. */
  drawLive(text: string) {
    if (text === this.live.last) return;
    this.live.last = text;
    const c = this.live.ctx;
    c.clearRect(0, 0, 1400, 70);
    c.fillStyle = "#ffd479";
    c.font = `600 40px ${MONO}`;
    c.textBaseline = "middle";
    c.fillText(text, 0, 36);
    this.live.tex.needsUpdate = true;
  }

  draw(view: PanelView) {
    const key = JSON.stringify(view);
    if (key === this.last) return;
    this.last = key;
    const asking = !!view.question;
    for (const b of Object.values(this.buttons)) b.visible = asking;
    this.live.mesh.visible = asking;
    const c = this.ctx;
    c.clearRect(0, 0, W, W);
    c.fillStyle = "rgba(9,13,22,0.92)";
    c.beginPath();
    c.roundRect(8, 8, W - 16, W - 16, 40);
    c.fill();
    c.textBaseline = "alphabetic";
    c.textAlign = "left";
    c.fillStyle = "#8fb4ff";
    c.font = `700 46px system-ui, sans-serif`;
    c.fillText(view.title, 48, 78);
    let y = 150;
    if (view.question) {
      const qv = view.question;
      c.fillStyle = "#a9b6c9";
      c.font = `600 34px system-ui, sans-serif`;
      c.fillText(`Question ${qv.index + 1} of ${qv.total}${qv.note ? `   ${qv.note}` : ""}`, 48, y);
      c.fillStyle = "#ffffff";
      c.font = `600 44px system-ui, sans-serif`;
      for (const line of qv.lines) {
        y += 56;
        c.fillText(line, 48, y);
      }
      c.fillStyle = "#a9b6c9";
      c.font = `500 30px system-ui, sans-serif`;
      c.fillText("Aim a hand at a button and pinch.", 48, 640);
      y = 700;
    } else {
      c.fillStyle = "#e6edf7";
      c.font = `500 38px system-ui, sans-serif`;
      c.fillText("All answered. Palm menu > Questions to change them.", 48, y);
      y = 210;
    }
    const table = (head: string[], rows: string[][], first: number, widths: number) => {
      const step = (W - 96 - first) / Math.max(1, widths);
      const cell = (text: string, i: number) => {
        c.textAlign = i === 0 ? "left" : "right";
        c.fillText(text, i === 0 ? 48 : 48 + first + step * i, y);
      };
      c.font = `700 29px ${MONO}`;
      c.fillStyle = "#8fb4ff";
      head.forEach(cell);
      c.font = `500 31px ${MONO}`;
      rows.forEach((row, r) => {
        y += 44;
        c.fillStyle = r % 2 ? "#e6edf7" : "#ffffff";
        row.forEach(cell);
      });
      c.textAlign = "left";
    };
    table(view.answers.head, view.answers.rows, 640, 2);
    y += 70;
    table(view.compare.head, view.compare.rows, 232, view.compare.head.length - 1);
    y += 44;
    c.font = `500 28px ${MONO}`;
    c.fillStyle = "#a9b6c9";
    c.fillText(view.compare.note, 48, y);
    for (const line of view.footer) {
      y += 40;
      c.fillText(line, 48, y);
    }
    this.tex.needsUpdate = true;
  }
}
