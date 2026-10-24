import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { Chess, type Move, type Square } from "chess.js";
import { SparkRenderer } from "@sparkjsdev/spark";
import { SkinnedAvatar } from "../avatar";
import { loadDream } from "../dream";
import { Engine, STRENGTHS, type Strength } from "./engine";
import { board, localToSquare, pieceGeometries, pieceHeight, pieceMaterials, type PieceType, SQUARE, squareToLocal } from "./pieces";

// Chess in your room: a real-size board on your table, pieces you pick up with a pinch, and Stockfish across from
// you at the strength you choose. On a laptop it's the same game with a mouse. ?opponent=<avatar dream id> stands a
// rigged avatar across the table, playing its own motion.

const PINCH_ON = 0.018; // meters between thumb and index tips
const PINCH_OFF = 0.03;
const GRAB_RADIUS = 0.055;

export async function renderChess(root: HTMLElement) {
  document.title = "Chess · Lucid Dreams";
  root.innerHTML = `
    <div class="stage" id="stage"></div>
    <div class="topbar"><a class="back" href="./">${`<svg viewBox="0 0 12 20"><path d="M10 2 2 10l8 8" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`}Dreams</a>
      <div class="title"><div>Chess</div><div class="subtitle" id="status">Your move</div></div><div></div></div>
    <div class="controls chess-controls">
      <div class="segmented" id="strengths">${STRENGTHS.map((s) => `<button data-id="${s.id}">${s.label}</button>`).join("")}</div>
      <div class="segmented" id="sides"><button data-side="w" class="on">White</button><button data-side="b">Black</button></div>
      <button class="pill" id="undo">Undo</button>
      <button class="pill" id="new">New game</button>
      <button class="cta" id="room" hidden>Play in your room</button>
    </div>
    <p class="legend-note" id="legend-note"></p>`;
  const $ = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;

  // ---------------- scene ----------------
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.setClearColor(0x000000, 0);
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType("local-floor");
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  $("#stage").appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
  const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.02, 50);
  camera.position.set(0, 1.25, 0.62);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0.75, 0);
  controls.enableDamping = true;
  controls.minDistance = 0.3;
  controls.maxDistance = 2;
  controls.maxPolarAngle = Math.PI * 0.47;
  controls.update();
  const key = new THREE.DirectionalLight(0xffffff, 1.2);
  key.position.set(0.6, 2, 0.8);
  scene.add(key, new THREE.HemisphereLight(0xffffff, 0x444444, 0.5));

  // the board sits at table height in front of you
  const table = new THREE.Group();
  table.position.set(0, 0.75, 0);
  scene.add(table);
  const boardGroup = board();
  table.add(boardGroup);
  const pieces = new THREE.Group();
  boardGroup.add(pieces);
  const hints = new THREE.Group();
  boardGroup.add(hints);

  // someone across the table: any avatar bundle, standing on the floor on the far side, facing you
  const opponentId = new URLSearchParams(location.search).get("opponent");
  let opponent: SkinnedAvatar | null = null;
  let opponentName = "";
  let opponentSince = 0;
  const opponentGroup = new THREE.Group();
  scene.add(opponentGroup);
  if (opponentId) {
    scene.add(new SparkRenderer({ renderer }));
    loadDream(opponentId)
      .then(async (d) => {
        if (!SkinnedAvatar.canSkin(d)) throw new Error(`${d.id} has no rig`);
        opponent = await SkinnedAvatar.load(d);
        opponentName = d.name;
        opponent.mesh.opacity = 0;
        opponentSince = performance.now();
        opponentGroup.add(opponent.mesh);
        // on a laptop, step back so they're in the frame with the board (in the headset you just look up)
        camera.fov = 50;
        camera.updateProjectionMatrix();
        camera.position.set(0, 1.3, 2.0);
        controls.target.set(0, 1.0, -0.3);
        controls.update();
        updateStatus();
      })
      .catch((e) => console.warn("No opponent avatar:", e));
  }
  const farSide = new THREE.Vector3();
  const placeOpponent = () => {
    table.updateMatrixWorld();
    farSide.set(0, 0, -SQUARE * 4 - 0.38);
    table.localToWorld(farSide);
    opponentGroup.position.set(farSide.x, 0, farSide.z); // on the real floor, never scaled
    opponentGroup.rotation.y = table.rotation.y + Math.PI; // the avatar's front (-Z) turned toward you
  };

  const geom = pieceGeometries();
  const mats = pieceMaterials();
  const shadowTex = contactShadowTexture();
  const hitMaterial = new THREE.MeshBasicMaterial({ visible: false });

  // ---------------- game state ----------------
  const chess = new Chess();
  const engine = new Engine();
  let strength: Strength = STRENGTHS.find((s) => s.id === "gm")!;
  let side: "w" | "b" = "w";
  let thinking = false;
  const meshes = new Map<string, THREE.Object3D>(); // square -> piece
  const tweens: { obj: THREE.Object3D; from: THREE.Vector3; to: THREE.Vector3; t0: number; dur: number }[] = [];

  const makePiece = (type: PieceType, color: "w" | "b") => {
    const g = new THREE.Group();
    const m = new THREE.Mesh(geom[type], mats[color]);
    if (type === "n" && color === "b") m.rotation.y = Math.PI; // knights look at the other side
    g.add(m);
    const s = new THREE.Mesh(new THREE.PlaneGeometry(SQUARE * 0.95, SQUARE * 0.95), new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }));
    s.rotation.x = -Math.PI / 2;
    s.position.y = 0.0009;
    g.add(s);
    // an invisible, slightly larger cylinder: what the mouse actually hits (easier to grab than the silhouette)
    const hit = new THREE.Mesh(new THREE.CylinderGeometry(SQUARE * 0.42, SQUARE * 0.42, pieceHeight(type), 12), hitMaterial);
    hit.position.y = pieceHeight(type) / 2;
    hit.name = "hit";
    g.add(hit);
    g.userData = { type, color, height: pieceHeight(type) };
    return g;
  };

  const sync = (moving?: { from: Square; to: Square }) => {
    pieces.clear();
    meshes.clear();
    for (const row of chess.board())
      for (const cell of row) {
        if (!cell) continue;
        const p = makePiece(cell.type as PieceType, cell.color);
        const target = squareToLocal(cell.square);
        p.position.copy(moving && cell.square === moving.to ? squareToLocal(moving.from) : target);
        if (moving && cell.square === moving.to) tweens.push({ obj: p, from: p.position.clone(), to: target, t0: performance.now(), dur: 520 });
        pieces.add(p);
        meshes.set(cell.square, p);
      }
    showHints(null);
    updateStatus();
  };

  const setStatus = (text: string) => {
    $("#status").textContent = text;
    drawPanel(text);
  };
  const updateStatus = () => {
    if (chess.isCheckmate()) return setStatus(chess.turn() === side ? "Checkmate. Well played, engine." : "Checkmate. You win.");
    if (chess.isDraw()) return setStatus("Draw");
    const who = opponentName ? `${opponentName} (${strength.label})` : strength.legend ?? strength.label;
    if (thinking) return setStatus(`${who} is thinking…`);
    setStatus(chess.turn() === side ? (chess.inCheck() ? "Check. Your move" : "Your move") : `${who} to move`);
  };

  const engineMove = async () => {
    if (chess.isGameOver() || chess.turn() === side) return;
    thinking = true;
    updateStatus();
    const uci = await engine.bestMove(chess.fen(), strength);
    thinking = false;
    if (!uci || uci === "(none)") return updateStatus();
    const mv = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] ?? "q" });
    sync({ from: mv.from, to: mv.to });
  };

  const tryMove = (from: Square, to: Square | null): boolean => {
    if (!to || to === from) return false;
    let mv: Move | null = null;
    try {
      mv = chess.move({ from, to, promotion: "q" });
    } catch {
      mv = null;
    }
    if (!mv) return false;
    sync();
    void engineMove();
    return true;
  };

  // legal-move dots for the piece in hand
  const dot = new THREE.Mesh(new THREE.CircleGeometry(SQUARE * 0.14, 32), new THREE.MeshBasicMaterial({ color: 0x0071e3, transparent: true, opacity: 0.75, depthWrite: false }));
  dot.rotation.x = -Math.PI / 2;
  const showHints = (from: Square | null) => {
    hints.clear();
    if (!from) return;
    for (const m of chess.moves({ square: from, verbose: true })) {
      const d = dot.clone();
      d.position.copy(squareToLocal(m.to, 0.0012));
      hints.add(d);
    }
  };

  const newGame = async () => {
    chess.reset();
    engine.newGame();
    await engine.setStrength(strength);
    boardGroup.rotation.y = side === "w" ? 0 : Math.PI;
    sync();
    void engineMove();
  };

  // ---------------- picking up pieces (mouse, hands, controllers) ----------------
  type Hold = { square: Square; obj: THREE.Object3D; offset: THREE.Vector3 };
  const canTouch = (sq: string) => !thinking && !chess.isGameOver() && chess.turn() === side && chess.get(sq as Square)?.color === side;
  const nearestPiece = (worldPoint: THREE.Vector3): string | null => {
    let best: string | null = null;
    let bestD = GRAB_RADIUS;
    const p = new THREE.Vector3();
    for (const [sq, obj] of meshes) {
      if (!canTouch(sq)) continue;
      obj.getWorldPosition(p);
      p.y += (obj.userData.height as number) * 0.6;
      const d = p.distanceTo(worldPoint);
      if (d < bestD) {
        bestD = d;
        best = sq;
      }
    }
    return best;
  };
  const toBoardLocal = (world: THREE.Vector3) => boardGroup.worldToLocal(world.clone());
  const grab = (sq: string, worldPoint: THREE.Vector3): Hold => {
    const obj = meshes.get(sq)!;
    showHints(sq as Square);
    return { square: sq as Square, obj, offset: toBoardLocal(worldPoint).sub(obj.position).setY(0) };
  };
  const moveHeld = (h: Hold, worldPoint: THREE.Vector3) => {
    const local = toBoardLocal(worldPoint).sub(h.offset);
    h.obj.position.set(local.x, Math.max(0.012, local.y - (h.obj.userData.height as number) * 0.6), local.z);
  };
  const release = (h: Hold) => {
    const local = h.obj.position.clone();
    if (!tryMove(h.square, localToSquare(local) as Square | null)) {
      tweens.push({ obj: h.obj, from: h.obj.position.clone(), to: squareToLocal(h.square), t0: performance.now(), dur: 260 });
      showHints(null);
    }
  };

  // mouse / touch
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const plane = new THREE.Plane();
  let mouseHold: Hold | null = null;
  const pointerWorld = (e: PointerEvent, y: number): THREE.Vector3 | null => {
    ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const n = new THREE.Vector3(0, 1, 0);
    const o = boardGroup.localToWorld(new THREE.Vector3(0, y, 0));
    plane.setFromNormalAndCoplanarPoint(n, o);
    return ray.ray.intersectPlane(plane, new THREE.Vector3());
  };
  // the piece whose upright axis passes closest to the pointer ray: what the eye expects, even when pieces overlap
  const pickPiece = (): string | null => {
    let best: string | null = null;
    let bestD = 0.022 ** 2;
    const base = new THREE.Vector3();
    const top = new THREE.Vector3();
    for (const [sq, obj] of meshes) {
      if (!canTouch(sq)) continue;
      obj.getWorldPosition(base);
      top.copy(base).y += obj.userData.height as number;
      const d = ray.ray.distanceSqToSegment(base, top);
      if (d < bestD) {
        bestD = d;
        best = sq;
      }
    }
    return best;
  };
  renderer.domElement.addEventListener("pointerdown", (e) => {
    ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const sq = pickPiece();
    if (!sq) return;
    controls.enabled = false;
    const w = pointerWorld(e, 0.03);
    mouseHold = w ? { ...grab(sq, w), offset: new THREE.Vector3() } : null;
  });
  addEventListener("pointermove", (e) => {
    if (!mouseHold) return;
    const w = pointerWorld(e, 0.03);
    if (w) moveHeld(mouseHold, w.add(new THREE.Vector3(0, (mouseHold.obj.userData.height as number) * 0.6 + 0.02, 0)));
  });
  addEventListener("pointerup", () => {
    if (mouseHold) release(mouseHold);
    mouseHold = null;
    controls.enabled = true;
  });

  // hands and controllers in the headset
  const hands = [0, 1].map((i) => renderer.xr.getHand(i));
  const ctrls = [0, 1].map((i) => renderer.xr.getController(i));
  hands.forEach((h) => scene.add(h));
  ctrls.forEach((c) => scene.add(c));
  const handHold: (Hold | null)[] = [null, null];
  const pinching = [false, false];
  const ctrlDown = [false, false];
  ctrls.forEach((c, i) => {
    c.addEventListener("selectstart", () => (ctrlDown[i] = true));
    c.addEventListener("selectend", () => (ctrlDown[i] = false));
  });
  const occluders = hands.map((h) => handOccluder(h, scene));
  const tip = new THREE.Vector3();
  const thumb = new THREE.Vector3();
  const pinchPoint = (i: number): { point: THREE.Vector3; down: boolean } | null => {
    const joints = (hands[i] as unknown as { joints: Record<string, THREE.Object3D> }).joints;
    const idx = joints?.["index-finger-tip"];
    const th = joints?.["thumb-tip"];
    if (idx && th && idx.visible !== false && th.visible !== false) {
      idx.getWorldPosition(tip);
      th.getWorldPosition(thumb);
      const d = tip.distanceTo(thumb);
      if (pinching[i] ? d < PINCH_OFF : d < PINCH_ON) pinching[i] = true;
      else pinching[i] = false;
      return { point: tip.clone().add(thumb).multiplyScalar(0.5), down: pinching[i] };
    }
    if (ctrls[i]) return { point: ctrls[i].getWorldPosition(new THREE.Vector3()), down: ctrlDown[i] };
    return null;
  };

  // long pinch on empty space re-places the board right there (pinch your real table)
  const longPinchSince = [0, 0];
  const LONG_PINCH_MS = 900;
  const placeBoardAt = (p: THREE.Vector3) => {
    const cam = renderer.xr.getCamera();
    const head = cam.getWorldPosition(new THREE.Vector3());
    table.position.set(p.x, p.y, p.z);
    table.rotation.y = Math.atan2(head.x - p.x, head.z - p.z); // your side of the board faces you
  };

  // ---------------- floating status panel in the room ----------------
  const panelCanvas = document.createElement("canvas");
  panelCanvas.width = 1024;
  panelCanvas.height = 160;
  const panelTex = new THREE.CanvasTexture(panelCanvas);
  panelTex.colorSpace = THREE.SRGBColorSpace;
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(0.32, 0.05), new THREE.MeshBasicMaterial({ map: panelTex, transparent: true, depthWrite: false }));
  panel.position.set(0, 0.14, -SQUARE * 4 - 0.06);
  panel.rotation.x = -0.25;
  panel.visible = false;
  table.add(panel);
  function drawPanel(text: string) {
    const c = panelCanvas.getContext("2d")!;
    c.clearRect(0, 0, 1024, 160);
    c.fillStyle = "rgba(29,29,31,0.78)";
    c.beginPath();
    c.roundRect(8, 8, 1008, 144, 72);
    c.fill();
    c.fillStyle = "#f5f5f7";
    c.font = '600 64px -apple-system, "SF Pro Display", "Inter", sans-serif';
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText(text, 512, 84);
    panelTex.needsUpdate = true;
  }

  // ---------------- buttons you press with a fingertip (no controllers needed) ----------------
  const xrButtons: XrButton[] = [];
  const addButton = (id: string, label: string, x: number, onPress: () => void) => {
    const b = new XrButton(id, label, onPress);
    b.mesh.position.set(x, 0.035, SQUARE * 4 + 0.075); // your side of the board, a little above the table
    b.mesh.rotation.x = -0.9;
    table.add(b.mesh);
    xrButtons.push(b);
  };
  addButton("new", "New game", -0.15, () => void newGame());
  addButton("undo", "Undo", -0.05, () => {
    if (thinking) return;
    chess.undo();
    if (chess.turn() !== side) chess.undo();
    sync();
  });
  addButton("strength", strength.label, 0.065, () => {
    const i = STRENGTHS.findIndex((s) => s.id === strength.id);
    selectStrength(STRENGTHS[(i + 1) % STRENGTHS.length].id);
    void newGame();
  });
  addButton("move", "Move board", 0.175, () => {
    movingBoard = true;
    setStatus("Pinch where the board should go");
  });
  xrButtons.forEach((b) => (b.mesh.visible = false));
  let movingBoard = false;

  // ---------------- XR session ----------------
  let placed = false;
  if (navigator.xr && (await navigator.xr.isSessionSupported("immersive-ar").catch(() => false))) $("#room").hidden = false;
  $("#room").addEventListener("click", async () => {
    const session = await navigator.xr!.requestSession("immersive-ar", { requiredFeatures: ["local-floor"], optionalFeatures: ["hand-tracking"] });
    await renderer.xr.setSession(session);
    placed = false;
    panel.visible = true;
    xrButtons.forEach((b) => (b.mesh.visible = true));
    session.addEventListener("end", () => {
      panel.visible = false;
      xrButtons.forEach((b) => (b.mesh.visible = false));
      table.position.set(0, 0.75, 0);
      table.rotation.y = 0;
    });
  });

  // ---------------- UI ----------------
  const selectStrength = (id: string) => {
    strength = STRENGTHS.find((s) => s.id === id)!;
    $("#legend-note").textContent = strength.legend ? `Stockfish at ${strength.legend}'s peak rating (${strength.elo}). Not affiliated.` : "";
    xrButtons.find((b) => b.id === "strength")?.setLabel(strength.label);
    root.querySelectorAll<HTMLButtonElement>("#strengths button").forEach((b) => b.classList.toggle("on", b.dataset.id === id));
    void engine.setStrength(strength);
    updateStatus();
  };
  root.querySelectorAll<HTMLButtonElement>("#strengths button").forEach((b) => b.addEventListener("click", () => selectStrength(b.dataset.id!)));
  root.querySelectorAll<HTMLButtonElement>("#sides button").forEach((b) =>
    b.addEventListener("click", () => {
      side = b.dataset.side as "w" | "b";
      root.querySelectorAll("#sides button").forEach((x) => x.classList.toggle("on", x === b));
      void newGame();
    }),
  );
  $("#new").addEventListener("click", () => void newGame());
  $("#undo").addEventListener("click", () => {
    if (thinking) return;
    chess.undo();
    if (chess.turn() !== side) chess.undo();
    sync();
  });
  selectStrength(strength.id);
  await newGame();
  if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__chess = { chess, meshes, tryMove, camera, pieces, ray, renderer, scene, opponentGroup };

  // ---------------- loop ----------------
  addEventListener("resize", () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });
  renderer.setAnimationLoop((time) => {
    if (renderer.xr.isPresenting) {
      if (!placed) {
        const cam = renderer.xr.getCamera();
        const head = cam.getWorldPosition(new THREE.Vector3());
        const fwd = cam.getWorldDirection(new THREE.Vector3()).setY(0).normalize();
        placeBoardAt(new THREE.Vector3(head.x + fwd.x * 0.5, Math.min(1.0, Math.max(0.62, head.y - 0.5)), head.z + fwd.z * 0.5));
        placed = true;
      }
      occluders.forEach((o) => o());
      const tips = [0, 1].map((i) => {
        const t = (hands[i] as unknown as { joints: Record<string, THREE.Object3D> }).joints?.["index-finger-tip"];
        return t && t.visible ? t.getWorldPosition(new THREE.Vector3()) : null;
      });
      for (const b of xrButtons) b.touch(tips, time);
      for (const i of [0, 1]) {
        const p = pinchPoint(i);
        if (!p) continue;
        if (movingBoard && p.down) {
          placeBoardAt(p.point); // pinch your real table: the board lands there
          movingBoard = false;
          updateStatus();
          continue;
        }
        const held = handHold[i];
        if (p.down && !held) {
          const sq = nearestPiece(p.point);
          if (sq) handHold[i] = grab(sq, p.point);
          else if (!longPinchSince[i]) longPinchSince[i] = time;
          else if (time - longPinchSince[i] > LONG_PINCH_MS) {
            placeBoardAt(p.point); // about a second of pinching empty air: the board moves there
            longPinchSince[i] = 0;
          }
        } else if (p.down && held) moveHeld(held, p.point);
        else {
          longPinchSince[i] = 0;
          if (held) {
            release(held);
            handHold[i] = null;
          }
        }
      }
    } else controls.update();
    if (opponent) {
      placeOpponent();
      opponent.pose(time / 1000);
      opponent.mesh.opacity = Math.min(1, (performance.now() - opponentSince) / 1400); // they arrive, not pop in
    }
    for (let k = tweens.length - 1; k >= 0; k--) {
      const tw = tweens[k];
      const u = Math.min(1, (time - tw.t0) / tw.dur);
      const e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
      tw.obj.position.lerpVectors(tw.from, tw.to, e);
      tw.obj.position.y = tw.to.y + Math.sin(Math.PI * e) * 0.03; // a small lift, like a hand moving it
      if (u >= 1) tweens.splice(k, 1);
    }
    renderer.render(scene, camera);
  });
}

function contactShadowTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, "rgba(0,0,0,0.45)");
  grad.addColorStop(0.5, "rgba(0,0,0,0.15)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}


const FINGER_CHAINS = [
  ["wrist", "thumb-metacarpal", "thumb-phalanx-proximal", "thumb-phalanx-distal", "thumb-tip"],
  ...["index-finger", "middle-finger", "ring-finger", "pinky-finger"].map((f) =>
    ["wrist", `${f}-metacarpal`, `${f}-phalanx-proximal`, `${f}-phalanx-intermediate`, `${f}-phalanx-distal`, `${f}-tip`]),
];

/**
 * Invisible, depth-only stand-ins for a tracked hand (a capsule per finger bone), drawn before everything else, so
 * your real fingers in passthrough stay in front of a piece you reach behind. Returns the per-frame update.
 */
function handOccluder(hand: THREE.Object3D, scene: THREE.Scene): () => void {
  const mat = new THREE.MeshBasicMaterial({ colorWrite: false });
  const unitBone = new THREE.CylinderGeometry(1, 1, 1, 10, 1, true);
  const unitJoint = new THREE.SphereGeometry(1, 10, 8);
  const group = new THREE.Group();
  group.visible = false; // shown only while the hand is tracked (unit-size stand-ins would hide the board)
  scene.add(group);
  const bones = FINGER_CHAINS.flatMap((c) => c.slice(1).map((name, k) => [c[k], name] as const));
  const boneMeshes = bones.map(() => new THREE.Mesh(unitBone, mat));
  const jointNames = [...new Set(FINGER_CHAINS.flat())];
  const jointMeshes = jointNames.map(() => new THREE.Mesh(unitJoint, mat));
  [...boneMeshes, ...jointMeshes].forEach((m) => {
    m.renderOrder = -1;
    group.add(m);
  });
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const radius = (j: THREE.Object3D) => Math.max(0.006, (j as unknown as { jointRadius?: number }).jointRadius ?? 0.008);
  return () => {
    const joints = (hand as unknown as { joints: Record<string, THREE.Object3D> }).joints ?? {};
    const tracked = joints.wrist?.visible === true;
    group.visible = tracked;
    if (!tracked) return;
    jointNames.forEach((n, k) => {
      const j = joints[n];
      const m = jointMeshes[k];
      m.visible = !!j?.visible;
      if (!m.visible) return;
      j.getWorldPosition(m.position);
      m.scale.setScalar(radius(j));
    });
    bones.forEach(([from, to], k) => {
      const ja = joints[from];
      const jb = joints[to];
      const m = boneMeshes[k];
      m.visible = !!(ja?.visible && jb?.visible);
      if (!m.visible) return;
      ja.getWorldPosition(a);
      jb.getWorldPosition(b);
      const len = a.distanceTo(b);
      const r = Math.min(radius(ja), radius(jb));
      m.position.copy(a).add(b).multiplyScalar(0.5);
      m.quaternion.setFromUnitVectors(up, b.sub(a).normalize());
      m.scale.set(r, len, r);
    });
  };
}

/** A soft, glassy button floating over the table. Pressed by pushing an index fingertip through it. */
class XrButton {
  mesh: THREE.Mesh;
  private canvas = document.createElement("canvas");
  private tex: THREE.CanvasTexture;
  private pressedUntil = 0;
  private cooldownUntil = 0;
  private wasInside = [false, false];
  private local = new THREE.Vector3();
  constructor(
    public id: string,
    private label: string,
    private onPress: () => void,
  ) {
    this.canvas.width = 512;
    this.canvas.height = 160;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.09, 0.028), new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthWrite: false }));
    this.draw(false);
  }
  setLabel(label: string) {
    this.label = label;
    this.draw(false);
  }
  private draw(pressed: boolean) {
    const c = this.canvas.getContext("2d")!;
    c.clearRect(0, 0, 512, 160);
    c.fillStyle = pressed ? "rgba(0,113,227,0.95)" : "rgba(44,44,46,0.82)";
    c.beginPath();
    c.roundRect(6, 6, 500, 148, 74);
    c.fill();
    c.fillStyle = "#f5f5f7";
    c.font = '600 58px -apple-system, "SF Pro Text", "Inter", sans-serif';
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText(this.label, 256, 84);
    this.tex.needsUpdate = true;
  }
  /** Both index fingertips in world space (null when not tracked). Fires once each time a tip pushes into the face. */
  touch(fingertips: (THREE.Vector3 | null)[], now: number) {
    if (!this.mesh.visible) return;
    fingertips.forEach((tip, h) => {
      let inside = false;
      if (tip) {
        this.local.copy(tip);
        this.mesh.worldToLocal(this.local);
        inside = Math.abs(this.local.x) < 0.045 && Math.abs(this.local.y) < 0.014 && this.local.z < 0.004 && this.local.z > -0.02;
      }
      if (inside && !this.wasInside[h] && now > this.cooldownUntil) {
        this.cooldownUntil = now + 300;
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
