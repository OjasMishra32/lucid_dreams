import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { Chess, type Move, type Square } from "chess.js";
import { SparkRenderer } from "@sparkjsdev/spark";
import { SkinnedAvatar } from "../avatar";
import { loadDream } from "../dream";
import { handOccluder, XrButton } from "../xr/hands";
import { HandMenu, handIndex, handSides } from "../xr/menu";
import { WorldLock } from "../xr/anchor";
import { Engine, STRENGTHS, type Strength } from "./engine";
import { bookMove } from "./repertoire";
import { board, localToSquare, pieceGeometries, pieceHeight, pieceMaterials, type PieceType, SQUARE, squareToLocal } from "./pieces";
import { ChessClock } from "./clock";
import { hashSeed } from "./person";
import { FloatingNote } from "./room";
import { type Carry, SEAT_DISTANCE, SeatedOpponent } from "./seated";
import { TableSounds } from "./sound";
import { XR_QUALITY } from "../xr/quality";

// Chess in your room: a real-size board on your table, pieces you pick up with a pinch, and Stockfish across from
// you at the strength you choose, with a real clock (10 + 0) at your right. Hands only, and nothing moves unless you
// mean it: the board is pinned to your real room (a WebXR anchor), the controls live on your left palm (turn it up),
// a piece you take goes into your hand so you hit your clock with it and set it down beside the board. On a laptop
// it's the same game with a mouse. Someone sits across the table (seated.ts): a legend's strength brings their avatar, otherwise ?opponent=<avatar
// dream id>, otherwise nobody. They think, move their own pieces with either hand, press their clock, set captured
// pieces aside, and shake your hand at the end. They never speak: a legend is always labelled as Stockfish at that
// player's rating.

const PINCH_ON = 0.018; // meters between thumb and index tips
const PINCH_OFF = 0.03;
const PINCH_LET_GO_MS = 70; // fingers apart this long before a pinch ends: tracking jitter never drops a piece
const PINCH_LOST_MS = 300; // a hand lost to tracking keeps hold of its piece this long
const PINCH_FIRM = 0.024; // fingers opening past this: what they hold stays where it is (it lands where you let go)
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
  // the 3D view fills the space between the top bar and the controls, whatever the window's shape: the camera's
  // centre moves into that gap and it widens until what's framed (baseFov's worth) fits there
  let baseFov = 40;
  const frameView = () => {
    const H = innerHeight;
    const top = root.querySelector(".topbar")?.getBoundingClientRect().bottom ?? 0;
    const bottom = Math.min(H, root.querySelector(".chess-controls")?.getBoundingClientRect().top ?? H);
    const free = THREE.MathUtils.clamp((bottom - top) / H, 0.3, 1);
    camera.fov = Math.min(115, THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(baseFov) / 2) / free)));
    camera.aspect = innerWidth / H;
    camera.setViewOffset(innerWidth, H, 0, H / 2 - (top + bottom) / 2, innerWidth, H);
    camera.updateProjectionMatrix();
  };
  frameView();
  new ResizeObserver(frameView).observe(root.querySelector(".chess-controls")!);
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
  const taken = new THREE.Group(); // captured pieces, standing beside the board
  boardGroup.add(taken);
  const clock = new ChessClock(600); // 10 + 0
  clock.group.position.set(SQUARE * 4 + 0.13, 0, 0); // at your right, beside the board
  table.add(clock.group);
  const sounds = new TableSounds(camera, scene);
  const legendNote = new FloatingNote();
  scene.add(legendNote.mesh);

  // someone across the table: an avatar bundle, seated on a chair on the far side, facing you. A legend's strength
  // brings their avatar (the first of its ids that exists); otherwise ?opponent=<id>; otherwise nobody (the board
  // alone). Nothing is picked from the library on its own.
  const opponentId = new URLSearchParams(location.search).get("opponent");
  let opponent: SkinnedAvatar | null = null;
  let seated: SeatedOpponent | null = null;
  let reaching = false; // their hand is moving a piece: the board is theirs until it lets go
  let opponentName = "";
  let opponentSince = 0;
  let opponentToken = 0;
  let spark: SparkRenderer | null = null;
  const opponentGroup = new THREE.Group();
  scene.add(opponentGroup);
  let opponentShownId: string | null = null;
  const clearOpponent = () => {
    if (!opponent) return;
    opponentGroup.remove(opponent.mesh);
    opponent.mesh.dispose();
    opponent = null;
    if (seated) {
      opponentGroup.remove(seated.chair);
      seated.dispose();
      seated = null;
    }
    if (reaching) {
      reaching = false; // the move is already made: show it
      sync();
    }
    opponentName = "";
    opponentShownId = null;
  };
  // the current opponent stays until the new one has loaded, so switching never flickers; ids are tried in order
  const setOpponent = (ids: string[]) => {
    const token = ++opponentToken;
    const [id, ...rest] = ids;
    if (id && id === opponentShownId) return;
    if (!id) {
      clearOpponent();
      return updateStatus();
    }
    if (!spark) scene.add((spark = new SparkRenderer({ renderer })));
    loadDream(id)
      .then(async (d) => {
        if (!SkinnedAvatar.canSkin(d)) throw new Error(`${d.id} has no rig`);
        const a = await SkinnedAvatar.load(d);
        if (token !== opponentToken) return a.mesh.dispose(); // a newer choice won
        clearOpponent();
        opponent = a;
        opponentShownId = id;
        opponentName = d.name;
        opponent.mesh.opacity = 0;
        opponentSince = performance.now();
        opponentGroup.add(opponent.mesh);
        seated = new SeatedOpponent(a, table, boardGroup);
        seated.reseed(hashSeed(id, gameNumber));
        seated.setClock(() => clock.buttonTop("far"));
        seated.setOpacity(0);
        opponentGroup.add(seated.chair);
        // on a laptop: from a seated player's eyes, the board in front and them behind it, facing you (in the
        // headset you just look up)
        baseFov = 44;
        frameView();
        camera.position.set(0, 1.28, 1.0);
        controls.target.set(0, 0.95, -0.32);
        controls.update();
        updateStatus();
      })
      .catch((e) => {
        if (token !== opponentToken) return;
        console.info(`No avatar for ${id} yet:`, (e as Error).message);
        setOpponent(rest);
      });
  };
  const farSide = new THREE.Vector3();
  const placeOpponent = () => {
    table.updateMatrixWorld();
    farSide.set(0, 0, -(seated?.seatDistance ?? SEAT_DISTANCE)); // their hips; the chair and the pose are built around this point
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
  const askedStrength = new URLSearchParams(location.search).get("strength");
  let strength: Strength = STRENGTHS.find((s) => s.id === askedStrength) ?? STRENGTHS.find((s) => s.id === "gm")!;
  let side: "w" | "b" = "w";
  let thinking = false;
  const meshes = new Map<string, THREE.Object3D>(); // square -> piece
  const tweens: { obj: THREE.Object3D; from: THREE.Vector3; to: THREE.Vector3; t0: number; dur: number; onDone?: () => void }[] = [];
  // a piece you took, in your hand (the headset): you hit your clock with it, then set it down beside the board. It's
  // your index-th capture; `armed` once you're pinching it, so letting go sets it down
  let inHand: { obj: THREE.Object3D; index: number; hand: number; armed: boolean; pressedAt: number; lostSince: number } | null = null;
  const takenSpots = new Map<number, THREE.Vector3>(); // where you set your captures down yourself (board space)
  let gameId = 0; // bumped by a new game or an undo: an engine answer for an older position is dropped
  let gameNumber = 0; // bumped by a new game only: the opponent's habits are seeded by it
  let lastEval: number | null = null; // the opponent's view of the position after its last move, centipawns
  const other = (c: "w" | "b") => (c === "w" ? "b" : "w");
  const isOver = () => chess.isGameOver() || !!clock.flagged;
  const worldAt = (boardLocal: THREE.Vector3) => boardGroup.localToWorld(boardLocal.clone());
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

  // pieces taken off the board stand beside it in neat rows, each player's on their own end of the table, at your
  // left (the clock is at your right)
  const slot = (byPlayer: boolean, i: number) => {
    const tl = new THREE.Vector3(-(SQUARE * 4 + 0.05 + Math.floor(i / 4) * 0.042), 0, (byPlayer ? 1 : -1) * (SQUARE * 3.5 - (i % 4) * 0.045));
    boardGroup.updateMatrix();
    return tl.applyMatrix4(boardGroup.matrix.clone().invert()); // table -> board (the board turns when you play black)
  };
  const takenPieces = () => {
    const byPlayer: { type: PieceType; color: "w" | "b" }[] = [];
    const byOpponent: { type: PieceType; color: "w" | "b" }[] = [];
    for (const m of chess.history({ verbose: true })) if (m.captured) (m.color === side ? byPlayer : byOpponent).push({ type: m.captured as PieceType, color: other(m.color) });
    return { byPlayer, byOpponent };
  };
  let takenMeshes: { byPlayer: THREE.Object3D[]; byOpponent: THREE.Object3D[] } = { byPlayer: [], byOpponent: [] };

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
    if (reaching) {
      seated?.cancel(); // a new game or a new opponent mid-move: the hand lets go and goes back to rest
      reaching = false;
    }
    pieces.clear();
    meshes.clear();
    for (const row of chess.board())
      for (const cell of row) {
        if (!cell) continue;
        const p = makePiece(cell.type as PieceType, cell.color);
        const target = squareToLocal(cell.square);
        p.position.copy(moving && cell.square === moving.to ? squareToLocal(moving.from) : target);
        if (moving && cell.square === moving.to) tweens.push({ obj: p, from: p.position.clone(), to: target, t0: performance.now(), dur: 520, onDone: () => sounds.clack(worldAt(target)) });
        pieces.add(p);
        meshes.set(cell.square, p);
      }
    taken.clear();
    const t = takenPieces();
    for (const k of takenSpots.keys()) if (k >= t.byPlayer.length) takenSpots.delete(k);
    const place = (list: typeof t.byPlayer, byPlayer: boolean) =>
      list.map((c, i) => {
        const m = makePiece(c.type, c.color);
        m.position.copy((byPlayer && takenSpots.get(i)) || slot(byPlayer, i));
        taken.add(m);
        return m;
      });
    takenMeshes = { byPlayer: place(t.byPlayer, true), byOpponent: place(t.byOpponent, false) };
    if (inHand) {
      // the piece in your hand is rebuilt with the rest: the new one stays in your hand
      const m = takenMeshes.byPlayer[inHand.index];
      if (m) {
        m.position.copy(inHand.obj.position);
        inHand.obj = m;
      } else inHand = null;
    }
    showHints(null);
    updateStatus();
  };

  const setStatus = (text: string) => {
    $("#status").textContent = text;
    drawPanel(text);
  };
  let opening = ""; // the legend's own line while they're in it
  // you press your own clock: after your move your time keeps running until you do, and only then do they start
  let awaitingPress = false;
  let pressedOnce = false; // the hint shows until you've done it once
  let awaitSince = 0;
  let pulsed = false;
  const clockHint = () => (renderer.xr.isPresenting ? "Tap your clock" : "Tap your clock (click it, or press Space)");
  const updateStatus = () => {
    const who = strength.legend ? `${strength.legend} (engine, ${strength.elo})` : opponentName ? `${opponentName} (${strength.label})` : strength.label;
    if (reaching) return setStatus(`${who} is moving…`);
    if (clock.flagged) return setStatus(clock.flagged === "near" ? "Out of time. Well played, engine." : "Out of time. You win.");
    if (chess.isCheckmate()) return setStatus(chess.turn() === side ? "Checkmate. Well played, engine." : "Checkmate. You win.");
    if (chess.isDraw()) return setStatus("Draw");
    if (thinking) return setStatus(`${who} is thinking…`);
    if (awaitingPress) return setStatus(pressedOnce ? "Your clock is running" : clockHint());
    const line = opening ? `  ·  ${opening}` : "";
    // new to the room: how it works, until it's been a moment or you've used it
    if (renderer.xr.isPresenting && hintUntil > performance.now() && chess.turn() === side) return setStatus("Pinch a piece to move it  ·  Left palm up for the menu");
    setStatus((chess.turn() === side ? (chess.inCheck() ? "Check. Your move" : "Your move") : `${who} to move`) + line);
  };

  const engineMove = async () => {
    if (isOver() || chess.turn() === side) return;
    const id = gameId;
    thinking = true;
    updateStatus();
    const t0 = performance.now();
    // as the search deepens, the opponent learns what your last move did: a big drop for them is a nod for you
    let deepest = { depth: 0, cp: 0 };
    let judged = false;
    const bests: string[] = []; // the move the search thought best, each time it changed its mind
    const judge = (cp: number) => {
      judged = true;
      if (lastEval !== null && lastEval - cp > 150) seated?.nod();
    };
    // a legend opens with his own lines (Fischer's 1.e4 and Najdorf, Carlsen's Catalan and Sveshnikov), then the engine
    let bookUci: string | null = null;
    const book = strength.legend ? bookMove(strength.id, chess.history()) : null;
    if (book) {
      try {
        const m = new Chess(chess.fen()).move(book.san);
        bookUci = m.from + m.to + (m.promotion ?? "");
        // named only once both sides are in the line (after 1.e4 alone it could still become anything)
        if (chess.history().length >= 3) opening = `${strength.legend?.split(" ").pop()}'s ${book.name}`;
      } catch {
        bookUci = null;
      }
    }
    const uci = bookUci ?? await engine.bestMove(chess.fen(), strength, (depth, cp, pv) => {
      if (depth >= deepest.depth) deepest = { depth, cp };
      if (!judged && depth >= 10) judge(cp);
      if (pv && depth >= 8 && pv !== bests[bests.length - 1]) {
        bests.push(pv);
        seated?.consider(squareToLocal(pv.slice(0, 2)), squareToLocal(pv.slice(2, 4))); // their eyes go to it
      }
    });
    if (id !== gameId) return; // a new game meanwhile
    if (!judged && deepest.depth) judge(deepest.cp);
    const swing = lastEval !== null && deepest.depth ? lastEval - deepest.cp : 0;
    if (deepest.depth) lastEval = deepest.cp;
    let hardness = 0.3;
    if (seated) {
      // someone at the table takes a moment: quick in the opening and on recaptures, longer when it's sharp
      const prev = chess.history({ verbose: true }).at(-1);
      const think = seated.thinkTime({
        ply: chess.history().length,
        legal: chess.moves().length,
        inCheck: chess.inCheck(),
        swing,
        bestChanges: Math.max(0, bests.length - 1),
        evalCp: deepest.cp,
        recapture: !!prev?.captured && !!uci && uci.slice(2, 4) === prev.to,
        clockS: clock.time.far,
      });
      hardness = think.hardness;
      await sleep(think.ms - (performance.now() - t0));
    }
    if (id !== gameId) return;
    thinking = false;
    if (!uci || uci === "(none)" || isOver()) return updateStatus();
    let mv: Move;
    try {
      mv = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] ?? "q" });
    } catch {
      return updateStatus();
    }
    if (handMove(mv, hardness)) return;
    sync({ from: mv.from, to: mv.to });
    afterOpponentMove(true);
  };

  // their move is on the board: your clock runs, or the game is over
  const afterOpponentMove = (clickClock: boolean) => {
    if (isOver()) {
      clock.run(null);
      updateStatus();
      return ending();
    }
    clock.run("near");
    if (clickClock) sounds.click(clock.worldPosition("far"));
  };

  // the opponent moves their own piece: the board keeps the old position until their hand lets go. A capture
  // first goes beside the board; castling is the king, then the rook; then they press their clock.
  const handMove = (mv: Move, hardness = 0.3): boolean => {
    const obj = meshes.get(mv.from);
    if (!seated || !obj) return false;
    const carry = (o: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3, role: Carry["role"], soft = false): Carry => ({
      obj: o,
      from,
      to,
      role,
      height: o.userData.height as number,
      shadow: o.children[1],
      onLand: () => sounds.clack(worldAt(to), soft),
    });
    const carries: Carry[] = [];
    const takenOn = mv.flags.includes("e") ? mv.to[0] + mv.from[1] : mv.to; // en passant takes beside, not on, the square
    const victim = mv.captured ? meshes.get(takenOn) : undefined;
    if (victim) carries.push(carry(victim, victim.position.clone(), slot(false, takenPieces().byOpponent.length - 1), "victim", true));
    carries.push(carry(obj, squareToLocal(mv.from), squareToLocal(mv.to), "piece"));
    if (mv.flags.includes("k") || mv.flags.includes("q")) {
      const [rf, rt] = mv.flags.includes("k") ? ["h", "f"] : ["a", "d"];
      const rook = meshes.get(rf + mv.from[1]);
      if (rook) carries.push(carry(rook, squareToLocal(rf + mv.from[1]), squareToLocal(rt + mv.from[1]), "rook"));
    }
    reaching = true;
    updateStatus();
    const over = isOver();
    seated.play(
      carries,
      () => {
        reaching = false;
        sync(); // the real position, promotions included
        if (isOver()) afterOpponentMove(false);
      },
      over
        ? undefined
        : {
            at: () => clock.buttonTop("far"),
            onTap: () => {
              sounds.click(clock.worldPosition("far"));
              if (!isOver() && chess.turn() === side) clock.run("near");
            },
          },
      { hardness },
    );
    return true;
  };

  // the game is over: if they lost they tip their king over, then (win, lose or draw) they offer a handshake
  const ending = () => {
    if (!seated) return;
    const theyLost = (chess.isCheckmate() && chess.turn() !== side) || clock.flagged === "far";
    let king: THREE.Object3D | undefined;
    if (theyLost)
      for (const row of chess.board()) for (const c of row) if (c && c.type === "k" && c.color !== side) king = meshes.get(c.square);
    if (!king) return seated.endGame();
    const k = king;
    // it falls toward their right, along the board's edge
    const fall = new THREE.Vector3(-1, 0, 0).applyQuaternion(boardGroup.quaternion.clone().invert());
    seated.endGame({ obj: k, base: k.position.clone(), fall, height: k.userData.height as number, shadow: k.children[1], onTipped: () => sounds.clack(k.getWorldPosition(new THREE.Vector3()), true) });
  };

  // `hand`: the headset hand that moved it (a capture goes into that hand)
  const tryMove = (from: Square, to: Square | null, hand?: number): boolean => {
    if (!to || to === from || isOver()) return false;
    let mv: Move | null = null;
    try {
      mv = chess.move({ from, to, promotion: "q" });
    } catch {
      mv = null;
    }
    if (!mv) return false;
    putAside(); // still holding your last capture: it goes beside the board first
    const takenOn = mv.flags.includes("e") ? mv.to[0] + mv.from[1] : mv.to;
    // a piece you'd lifted with your other hand: it's yours now if this took it, else it's back on its square
    const lifted = handHold.findIndex((h) => h?.victim && h.square === takenOn);
    handHold.forEach((h, i) => h?.victim && (handHold[i] = null));
    sync();
    sounds.clack(worldAt(squareToLocal(mv.to)));
    if (mv.captured) {
      const index = takenMeshes.byPlayer.length - 1;
      const m = takenMeshes.byPlayer[index];
      const by = lifted >= 0 ? lifted : hand;
      if (m && by !== undefined) {
        // in the headset it's in your hand: hit your clock with it, then set it down beside the board
        takenSpots.delete(index);
        m.position.copy(squareToLocal(takenOn));
        inHand = { obj: m, index, hand: by, armed: lifted >= 0, pressedAt: 0, lostSince: 0 };
      } else if (m) {
        // with a mouse your capture goes beside the board, to the end of your row
        const dest = m.position.clone();
        m.position.copy(squareToLocal(takenOn));
        tweens.push({ obj: m, from: m.position.clone(), to: dest, t0: performance.now(), dur: 620, onDone: () => sounds.clack(worldAt(dest), true) });
      }
    }
    if (isOver()) {
      clock.run(null);
      updateStatus();
      ending();
      return true;
    }
    // your move is on the board and your time keeps running until you press your clock (pressClock)
    seated?.saw(squareToLocal(mv.to)); // their eyes go to your move
    awaitingPress = true;
    awaitSince = performance.now();
    pulsed = false;
    updateStatus();
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
    gameId++;
    gameNumber++;
    thinking = false;
    awaitingPress = false;
    lastEval = null;
    chess.reset();
    clock.reset();
    inHand = null;
    takenSpots.clear();
    seated?.cancel();
    if (seated && opponentShownId) seated.reseed(hashSeed(opponentShownId, gameNumber));
    engine.newGame();
    opening = "";
    await engine.setStrength(strength);
    boardGroup.rotation.y = side === "w" ? 0 : Math.PI;
    sync();
    void engineMove();
  };

  // ---------------- picking up pieces (mouse, hands, controllers) ----------------
  // `victim`: one of their pieces you lifted first, to take it with your other hand (or put it back)
  type Hold = { square: Square; obj: THREE.Object3D; offset: THREE.Vector3; victim?: boolean; legal?: Set<string> };
  const canTouch = (sq: string) => !thinking && !reaching && !isOver() && chess.turn() === side && chess.get(sq as Square)?.color === side;
  // one of theirs that a move of yours can take
  const canLift = (sq: string) =>
    !thinking && !reaching && !isOver() && chess.turn() === side && chess.get(sq as Square)?.color === other(side) &&
    chess.moves({ verbose: true }).some((m) => m.captured && (m.flags.includes("e") ? m.to[0] + m.from[1] : m.to) === sq);
  const nearestPiece = (worldPoint: THREE.Vector3, lift = false, radius = GRAB_RADIUS): { sq: string; victim: boolean } | null => {
    let best: { sq: string; victim: boolean } | null = null;
    let bestD = radius;
    const p = new THREE.Vector3();
    for (const [sq, obj] of meshes) {
      const victim = !canTouch(sq);
      if (victim && !(lift && canLift(sq))) continue;
      obj.getWorldPosition(p);
      p.y += (obj.userData.height as number) * 0.6;
      const d = p.distanceTo(worldPoint);
      if (d < bestD) {
        bestD = d;
        best = { sq, victim };
      }
    }
    return best;
  };
  const toBoardLocal = (world: THREE.Vector3) => boardGroup.worldToLocal(world.clone());
  const grab = (sq: string, worldPoint: THREE.Vector3, victim = false): Hold => {
    const obj = meshes.get(sq)!;
    if (!victim) showHints(sq as Square);
    const legal = victim ? undefined : new Set(chess.moves({ square: sq as Square, verbose: true }).map((m) => m.to as string));
    return { square: sq as Square, obj, offset: toBoardLocal(worldPoint).sub(obj.position).setY(0), victim, legal };
  };
  // a lifted piece of theirs you didn't take goes back where it stood
  const putBack = (h: Hold) => {
    const back = squareToLocal(h.square);
    tweens.push({ obj: h.obj, from: h.obj.position.clone(), to: back, t0: performance.now(), dur: 260, onDone: () => sounds.clack(worldAt(back), true) });
  };
  const moveHeld = (h: Hold, worldPoint: THREE.Vector3) => {
    const local = toBoardLocal(worldPoint).sub(h.offset);
    h.obj.position.set(local.x, Math.max(0.012, local.y - (h.obj.userData.height as number) * 0.6), local.z);
  };
  const release = (h: Hold, hand?: number) => {
    const local = h.obj.position.clone();
    if (!tryMove(h.square, localToSquare(local) as Square | null, hand)) {
      const back = squareToLocal(h.square);
      tweens.push({ obj: h.obj, from: h.obj.position.clone(), to: back, t0: performance.now(), dur: 260, onDone: () => sounds.clack(worldAt(back), true) });
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
  const pointerNdc = new THREE.Vector2(2, 2); // where the mouse is (off-screen until it moves)
  renderer.domElement.addEventListener("pointerdown", (e) => {
    ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    if (clock.hitNear(ray)) return pressClock();
    const sq = pickPiece();
    if (!sq) return;
    controls.enabled = false;
    const w = pointerWorld(e, 0.03);
    mouseHold = w ? { ...grab(sq, w), offset: new THREE.Vector3() } : null;
  });
  addEventListener("pointermove", (e) => {
    pointerNdc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
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
  const sideOf = handSides(hands);
  const handHold: (Hold | null)[] = [null, null];
  const ctrlDown = [false, false];
  ctrls.forEach((c, i) => {
    c.addEventListener("selectstart", () => (ctrlDown[i] = true));
    c.addEventListener("selectend", () => (ctrlDown[i] = false));
  });
  const occluders = hands.map((h) => handOccluder(h, scene));
  const jointsOf = (i: number) => (hands[i] as unknown as { joints?: Record<string, THREE.Object3D> }).joints ?? {};
  // a pinch is thumb and index tips together. It lasts through a few frames of jitter or lost tracking, so a piece
  // never drops out of your fingers on its own
  const pinch = [0, 1].map(() => ({ down: false, offSince: 0, lostSince: 0, point: new THREE.Vector3() }));
  const tip = new THREE.Vector3();
  const thumb = new THREE.Vector3();
  const pinchPoint = (i: number, now: number): { point: THREE.Vector3; down: boolean; firm: boolean } | null => {
    const joints = jointsOf(i);
    const s = pinch[i];
    const idx = joints["index-finger-tip"];
    const th = joints["thumb-tip"];
    if (idx?.visible && th?.visible) {
      idx.getWorldPosition(tip);
      th.getWorldPosition(thumb);
      const d = tip.distanceTo(thumb);
      if (!s.down) s.down = d < PINCH_ON;
      else if (d > PINCH_OFF) {
        s.offSince ||= now;
        if (now - s.offSince > PINCH_LET_GO_MS) s.down = false;
      } else s.offSince = 0;
      if (!s.down) s.offSince = 0;
      s.lostSince = 0;
      s.point.copy(tip).add(thumb).multiplyScalar(0.5);
      return { point: s.point, down: s.down, firm: d < PINCH_FIRM };
    }
    if (Object.keys(joints).length) {
      // a hand that tracking lost this frame: whatever it holds stays held for a moment
      if (s.down && now - (s.lostSince ||= now) < PINCH_LOST_MS) return { point: s.point, down: true, firm: false };
      s.down = false;
      return null;
    }
    if (ctrls[i]?.visible) return { point: ctrls[i].getWorldPosition(new THREE.Vector3()), down: ctrlDown[i], firm: true };
    return null;
  };

  // the board is pinned to your real room where it's placed (an anchor: no recenter or drift slides it). It moves only
  // by its handle: a bar on your side, like the one under a Quest window. Pinch it, drag the board anywhere (onto your
  // real table), let go and it's pinned there
  const lock = new WorldLock(renderer, table);
  let boardDrag: { hand: number; offset: THREE.Vector3 } | null = null;
  const HANDLE_Z = SQUARE * 4 + 0.058;
  const handleMat = new THREE.MeshBasicMaterial({ color: 0xf5f5f7, transparent: true, opacity: 0.55, depthWrite: false });
  const handle = new THREE.Mesh(new THREE.CapsuleGeometry(0.0055, 0.11, 6, 16), handleMat);
  handle.rotation.z = Math.PI / 2; // lying along the board's edge
  handle.position.set(0, 0.012, HANDLE_Z);
  handle.visible = false;
  table.add(handle);
  const handleLabel = (() => {
    const c = document.createElement("canvas");
    c.width = 512;
    c.height = 96;
    const g = c.getContext("2d")!;
    g.fillStyle = "#f5f5f7";
    g.font = '600 46px -apple-system, "SF Pro Text", "Inter", sans-serif';
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText("Pinch to move the board", 256, 50);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 0.0225), new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0, depthWrite: false }));
    m.position.set(0, 0.032, HANDLE_Z + 0.004);
    m.rotation.x = -0.9; // tilted up toward your eyes
    table.add(m);
    return m;
  })();
  const handleLocal = new THREE.Vector3();
  const nearHandle = (world: THREE.Vector3, slack = 0) => {
    table.worldToLocal(handleLocal.copy(world));
    return Math.abs(handleLocal.x) < 0.07 + slack && Math.abs(handleLocal.y - 0.012) < 0.03 + slack && Math.abs(handleLocal.z - HANDLE_Z) < 0.03 + slack;
  };
  // a pinch takes hold of something only as it starts (a pinch already held never picks up what it passes over)
  const pinchStarted = [0, 0];
  const PINCH_TAKES_MS = 160;
  const placeBoardAt = (p: THREE.Vector3) => {
    const cam = renderer.xr.getCamera();
    const head = cam.getWorldPosition(new THREE.Vector3());
    table.position.set(p.x, p.y, p.z);
    table.rotation.set(0, Math.atan2(head.x - p.x, head.z - p.z), 0); // your side of the board faces you
  };

  // a piece you took: in your hand until you set it down (let go of it, or lower it to the table beside the board
  // after hitting your clock), else it goes beside the board on its own
  const tableLocal = new THREE.Vector3();
  const onClock = (local: THREE.Vector3) => Math.abs(local.x - clock.group.position.x) < 0.075 && Math.abs(local.z - clock.group.position.z) < 0.12;
  const putAside = () => {
    if (!inHand) return;
    const { obj, index } = inHand;
    inHand = null;
    takenSpots.delete(index);
    const dest = slot(true, index);
    tweens.push({ obj, from: obj.position.clone(), to: dest, t0: performance.now(), dur: 420, onDone: () => sounds.clack(worldAt(dest), true) });
  };
  const setDown = () => {
    if (!inHand) return;
    const { obj, index } = inHand;
    table.worldToLocal(obj.getWorldPosition(tableLocal));
    const offBoard = Math.max(Math.abs(tableLocal.x), Math.abs(tableLocal.z)) > SQUARE * 4 + 0.02;
    if (!offBoard || tableLocal.y > 0.12 || onClock(tableLocal)) return putAside(); // over the board, in the air or on the clock
    inHand = null;
    const at = obj.position.clone().setY(0);
    takenSpots.set(index, at);
    tweens.push({ obj, from: obj.position.clone(), to: at, t0: performance.now(), dur: 140, onDone: () => sounds.clack(worldAt(at), true) });
  };
  const follow = new THREE.Vector3();
  const followHand = (point: THREE.Vector3) => {
    if (!inHand) return;
    follow.copy(point);
    follow.y -= (inHand.obj.userData.height as number) * 0.55; // held near its top, between thumb and finger
    inHand.obj.position.copy(taken.worldToLocal(follow));
  };

  // what a pinch would take: a ring under it (blue for yours, orange for one of theirs you can take), and the square a
  // held piece would land on (green when it's a legal move)
  const ring = new THREE.Mesh(new THREE.RingGeometry(SQUARE * 0.36, SQUARE * 0.45, 40), new THREE.MeshBasicMaterial({ color: 0x64d2ff, transparent: true, opacity: 0.9, depthWrite: false }));
  ring.rotation.x = -Math.PI / 2;
  ring.visible = false;
  boardGroup.add(ring);
  const landing = new THREE.Mesh(new THREE.PlaneGeometry(SQUARE * 0.96, SQUARE * 0.96), new THREE.MeshBasicMaterial({ color: 0x30d158, transparent: true, opacity: 0.32, depthWrite: false }));
  landing.rotation.x = -Math.PI / 2;
  landing.visible = false;
  boardGroup.add(landing);

  // everything that can hit your clock: every fingertip and the palm of both hands, and a piece in your hand
  const CLOCK_JOINTS = ["thumb-tip", "index-finger-tip", "middle-finger-tip", "ring-finger-tip", "pinky-finger-tip", "middle-finger-metacarpal"];
  const clockPoints: (THREE.Vector3 | null)[] = Array.from({ length: CLOCK_JOINTS.length * 2 + 1 }, () => new THREE.Vector3());
  const clockPointVecs = clockPoints.map((v) => v!);
  const fillClockPoints = () => {
    [0, 1].forEach((i) => {
      const joints = jointsOf(i);
      CLOCK_JOINTS.forEach((n, k) => {
        const at = i * CLOCK_JOINTS.length + k;
        clockPoints[at] = joints[n]?.visible ? joints[n].getWorldPosition(clockPointVecs[at]) : null;
      });
    });
    const last = clockPoints.length - 1;
    clockPoints[last] = inHand ? inHand.obj.getWorldPosition(clockPointVecs[last]) : null;
  };

  // ---------------- floating status panel in the room ----------------
  const panelCanvas = document.createElement("canvas");
  panelCanvas.width = 2048; // drawn at twice its layout size: crisp across the board
  panelCanvas.height = 320;
  const panelTex = new THREE.CanvasTexture(panelCanvas);
  panelTex.colorSpace = THREE.SRGBColorSpace;
  panelTex.anisotropy = 8;
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(0.32, 0.05), new THREE.MeshBasicMaterial({ map: panelTex, transparent: true, depthWrite: false }));
  panel.position.set(0, 0.14, -SQUARE * 4 - 0.06);
  panel.rotation.x = -0.25;
  panel.visible = false;
  table.add(panel);
  function drawPanel(text: string) {
    const c = panelCanvas.getContext("2d")!;
    c.setTransform(2, 0, 0, 2, 0, 0);
    c.clearRect(0, 0, 1024, 160);
    c.fillStyle = "rgba(29,29,31,0.78)";
    c.beginPath();
    c.roundRect(8, 8, 1008, 144, 72);
    c.fill();
    c.fillStyle = "#f5f5f7";
    let size = 64;
    do c.font = `600 ${size}px -apple-system, "SF Pro Display", "Inter", sans-serif`;
    while (c.measureText(text).width > 940 && (size -= 4) > 28); // a long line gets smaller, never cut off
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText(text, 512, 84);
    panelTex.needsUpdate = true;
  }

  // your clock button (a fingertip in the room, a click or the space bar on a laptop): after your move, pressing it
  // stops your time and starts theirs, and only then do they start thinking
  const pressClock = () => {
    sounds.click(clock.worldPosition("near"));
    if (!awaitingPress || isOver()) return;
    if (inHand) inHand.pressedAt = performance.now(); // the piece you took: now set it down
    awaitingPress = false;
    pressedOnce = true;
    clock.run("far");
    void engineMove();
  };
  addEventListener("keydown", (e) => {
    if (e.code !== "Space" || e.repeat) return;
    e.preventDefault(); // not a page scroll, nor a click on whichever button has focus
    (document.activeElement as HTMLElement | null)?.blur?.();
    pressClock();
  });

  const undo = () => {
    if (thinking || reaching) return;
    awaitingPress = false;
    gameId++;
    lastEval = null;
    seated?.cancel();
    chess.undo();
    if (chess.turn() !== side) chess.undo();
    clock.flagged = null;
    if (clock.running) clock.run(chess.turn() === side ? "near" : "far");
    sync();
  };

  // ---------------- controls on your left palm (turn it up; press with your right index fingertip) ----------------
  // nothing sits on the table for a hand to brush against while it moves pieces or sets a capture down
  const menu = new HandMenu(hands, sideOf, scene);
  const setSide = (s: "w" | "b") => {
    side = s;
    root.querySelectorAll<HTMLButtonElement>("#sides button").forEach((x) => x.classList.toggle("on", x.dataset.side === s));
    sideButton.setLabel(s === "w" ? "Play black" : "Play white");
    void newGame();
  };
  const sideButton = new XrButton("side", "Play black", () => setSide(other(side)));
  const strengthButton = new XrButton("strength", `Level · ${strength.label}`, () => {
    const i = STRENGTHS.findIndex((s) => s.id === strength.id);
    selectStrength(STRENGTHS[(i + 1) % STRENGTHS.length].id);
    void newGame();
  });
  // the legends, one button each: the chosen one takes the seat
  const legendButtons = STRENGTHS.filter((st) => st.legend).map(
    (st) =>
      new XrButton(st.id, st.legend!, () => {
        if (strength.id === st.id) return;
        selectStrength(st.id);
        void newGame();
      }),
  );
  menu.add(
    new XrButton("new", "New game", () => void newGame()),
    new XrButton("undo", "Undo", () => undo()),
    ...legendButtons,
    strengthButton,
    sideButton,
  );

  // ---------------- XR session ----------------
  let placed = false;
  let hintUntil = 0; // how to play, on the status panel for your first moments in the room
  if (navigator.xr && (await navigator.xr.isSessionSupported("immersive-ar").catch(() => false))) $("#room").hidden = false;
  $("#room").addEventListener("click", async () => {
    const session = await navigator.xr!.requestSession("immersive-ar", { requiredFeatures: ["local-floor"], optionalFeatures: ["hand-tracking", "anchors"] });
    renderer.xr.setFramebufferScaleFactor(XR_QUALITY.res);
    renderer.xr.setFoveation(XR_QUALITY.fov); // three's default is full foveation: the clock, the menu and the edges blurred
    await renderer.xr.setSession(session);
    placed = false;
    panel.visible = true;
    hintUntil = performance.now() + 20000;
    updateStatus();
    session.addEventListener("end", () => {
      panel.visible = false;
      menu.group.visible = menu.open = false;
      lock.release();
      boardDrag = null;
      handle.visible = false;
      (handleLabel.material as THREE.MeshBasicMaterial).opacity = 0;
      handHold.forEach((h, i) => {
        if (h) h.victim ? putBack(h) : release(h);
        handHold[i] = null;
      });
      putAside();
      table.position.set(0, 0.75, 0);
      table.rotation.set(0, 0, 0);
      frameView(); // the headset's projection was the camera's while presenting
    });
  });

  // ---------------- UI ----------------
  const selectStrength = (id: string) => {
    strength = STRENGTHS.find((s) => s.id === id)!;
    $("#legend-note").textContent = strength.legend ? `Stockfish at ${strength.legend}'s peak rating (${strength.elo}). Not affiliated.` : "";
    strengthButton.setLabel(`Level · ${strength.label}`);
    legendButtons.forEach((b) => b.setOn(b.id === id));
    root.querySelectorAll<HTMLButtonElement>("#strengths button").forEach((b) => b.classList.toggle("on", b.dataset.id === id));
    void engine.setStrength(strength);
    setOpponent([...(strength.avatar ?? []), ...(opponentId ? [opponentId] : [])]);
    updateStatus();
  };
  root.querySelectorAll<HTMLButtonElement>("#strengths button").forEach((b) => b.addEventListener("click", () => selectStrength(b.dataset.id!)));
  root.querySelectorAll<HTMLButtonElement>("#sides button").forEach((b) => b.addEventListener("click", () => setSide(b.dataset.side as "w" | "b")));
  $("#new").addEventListener("click", () => void newGame());
  $("#undo").addEventListener("click", () => undo());
  selectStrength(strength.id);
  await newGame();
  // ---------------- loop ----------------
  addEventListener("resize", () => {
    renderer.setSize(innerWidth, innerHeight);
    frameView();
  });
  const viewer = new THREE.Vector3();
  const watchAt = new THREE.Vector3();
  let lastTime = 0;
  clock.onFlag = () => {
    updateStatus();
    if (!reaching) ending(); // mid-move, their hand finishes first
  };
  const shakeRay = new THREE.Raycaster();
  const headPos = new THREE.Vector3();
  const handJoints = ["wrist", "index-finger-tip", "middle-finger-metacarpal", "thumb-tip"];
  const frame = (time: number) => {
    const dt = lastTime ? Math.min(0.1, (time - lastTime) / 1000) : 0;
    lastTime = time;
    clock.update(dt);
    // still not pressed after 10 s: it's your time, they wait; the hint pulses once
    if (awaitingPress && !pulsed && performance.now() - awaitSince > 10000) {
      pulsed = true;
      setStatus(clockHint());
      $("#status").animate([{ transform: "scale(1)" }, { transform: "scale(1.12)" }, { transform: "scale(1)" }], { duration: 900, easing: "ease-in-out" });
    }
    if (renderer.xr.isPresenting) {
      const cam = renderer.xr.getCamera();
      const head = cam.getWorldPosition(headPos);
      if (!placed) {
        const fwd = cam.getWorldDirection(new THREE.Vector3()).setY(0).normalize();
        placeBoardAt(new THREE.Vector3(head.x + fwd.x * 0.5, Math.min(1.0, Math.max(0.62, head.y - 0.5)), head.z + fwd.z * 0.5));
        placed = true;
        lock.lock();
      }
      if (!boardDrag) lock.update();
      occluders.forEach((o) => o());
      const menuOpen = menu.update(head, time, dt);
      const menuHand = handIndex(sideOf, "left");
      fillClockPoints();
      if (clock.touch(clockPoints, time)) pressClock();
      if (hintUntil && time > hintUntil) {
        hintUntil = 0;
        updateStatus();
      }
      let hover: { sq: string; victim: boolean } | null = null;
      let handleHover = false;
      for (const i of [0, 1]) {
        const p = pinchPoint(i, time);
        const held = handHold[i];
        if (p?.down && !pinchStarted[i]) pinchStarted[i] = time;
        else if (!p?.down) pinchStarted[i] = 0;
        const fresh = !!p?.down && time - pinchStarted[i] < PINCH_TAKES_MS;
        if (!p) {
          // a hand tracking lost for good: what it held goes back (or beside the board)
          if (held) {
            held.victim ? putBack(held) : release(held);
            handHold[i] = null;
          }
          if (inHand?.hand === i && time - (inHand.lostSince ||= time) > 800) putAside();
          if (boardDrag?.hand === i) boardDrag = null;
          continue;
        }
        if (inHand?.hand === i) inHand.lostSince = 0;
        // the board's handle in your fingers: the board follows, turned to face you; let go and it's pinned there
        if (boardDrag) {
          if (boardDrag.hand === i) {
            if (p.down && p.firm) placeBoardAt(p.point.clone().add(boardDrag.offset));
            else {
              boardDrag = null;
              lock.lock();
              sounds.clack(table.getWorldPosition(new THREE.Vector3()), true);
            }
          }
          continue;
        }
        if (menuOpen && i === menuHand && !held) continue; // the hand holding the menu up picks nothing up
        if (inHand?.hand === i) {
          // the piece you took: pinch it and let go to set it down
          if (p.down) inHand.armed = true;
          else if (inHand.armed) setDown();
          if (inHand?.hand === i && (p.firm || !inHand.armed)) followHand(p.point);
          continue;
        }
        if (p.down && !held) {
          if (!fresh) continue;
          const hit = nearestPiece(p.point, true);
          if (hit) handHold[i] = grab(hit.sq, p.point, hit.victim);
          else if (nearHandle(p.point)) {
            lock.release();
            boardDrag = { hand: i, offset: table.position.clone().sub(p.point) };
            if (hintUntil) hintUntil = 1; // you've found it: the hint can go
          }
        } else if (p.down && held) {
          if (p.firm) moveHeld(held, p.point);
        } else if (held) {
          handHold[i] = null;
          if (held.victim) putBack(held);
          else release(held, i);
        }
        if (!p.down && !handHold[i]) {
          hover ??= nearestPiece(p.point, true, GRAB_RADIUS * 1.2);
          handleHover ||= !hover && nearHandle(p.point, 0.025);
        }
      }
      // the handle: brighter under your fingers, blue while it's carrying the board; its label while you're new here
      handle.visible = true;
      handleMat.color.set(boardDrag ? 0x0a84ff : 0xf5f5f7);
      handleMat.opacity += ((boardDrag || handleHover ? 0.95 : 0.5) - handleMat.opacity) * Math.min(1, dt * 12);
      const labelMat = handleLabel.material as THREE.MeshBasicMaterial;
      labelMat.opacity += ((handleHover || boardDrag || hintUntil > time ? 0.9 : 0) - labelMat.opacity) * Math.min(1, dt * 8);
      // after hitting your clock with it: lower it to the table beside the board and it's set down there; otherwise it
      // goes beside the board on its own
      if (inHand?.pressedAt) {
        table.worldToLocal(inHand.obj.getWorldPosition(tableLocal));
        const offBoard = Math.max(Math.abs(tableLocal.x), Math.abs(tableLocal.z)) > SQUARE * 4 + 0.02;
        if (offBoard && tableLocal.y < 0.03 && !onClock(tableLocal)) setDown();
        else if (performance.now() - inHand.pressedAt > 3000) putAside();
      }
      ring.visible = !!hover;
      if (hover) {
        ring.position.copy(meshes.get(hover.sq)!.position).setY(0.0014);
        (ring.material as THREE.MeshBasicMaterial).color.set(hover.victim ? 0xff9f0a : 0x64d2ff);
      }
      const holding = handHold.find((h) => h && !h.victim);
      const to = holding ? localToSquare(holding.obj.position) : null;
      landing.visible = !!(holding && to && holding.legal?.has(to));
      if (landing.visible) landing.position.copy(squareToLocal(to!, 0.0011));
    } else {
      controls.update();
      ring.visible = landing.visible = false;
    }
    clock.prompt = awaitingPress && !isOver();
    if (opponent && seated) {
      placeOpponent();
      if (renderer.xr.isPresenting) renderer.xr.getCamera().getWorldPosition(viewer);
      else viewer.copy(camera.position);
      const watching = mouseHold?.obj ?? handHold[0]?.obj ?? handHold[1]?.obj; // a piece in your hand draws their eyes
      const pressure = THREE.MathUtils.clamp((60 - clock.time.far) / 50, 0, 1); // their clock running short
      seated.update(time, { thinking, viewer, pressure, watch: watching ? watching.getWorldPosition(watchAt) : null });
      const o = Math.min(1, (performance.now() - opponentSince) / 1400); // they arrive, not pop in
      opponent.mesh.opacity = o;
      seated.setOpacity(o);
      // a hand held out: your hand (or the mouse) within about 12 cm of it, and you shake
      if (seated.offering) {
        const theirs = seated.handWorld;
        let met = false;
        if (renderer.xr.isPresenting) {
          const p = new THREE.Vector3();
          for (const h of hands) {
            const joints = (h as unknown as { joints: Record<string, THREE.Object3D> }).joints ?? {};
            for (const n of handJoints) if (joints[n]?.visible && joints[n].getWorldPosition(p).distanceTo(theirs) < 0.12) met = true;
          }
          for (const c of ctrls) if (c.visible && c.getWorldPosition(p).distanceTo(theirs) < 0.12) met = true;
        } else if (Math.abs(pointerNdc.x) <= 1) {
          shakeRay.setFromCamera(pointerNdc, camera);
          met = shakeRay.ray.distanceToPoint(theirs) < 0.12;
        }
        if (met) seated.shake();
      }
    }
    // a legend is always labelled: it's Stockfish at their rating, not them
    legendNote.setText(strength.legend ? `Stockfish at ${strength.legend}'s peak rating (${strength.elo}). Not affiliated.` : "");
    if (legendNote.mesh.visible) {
      const at = opponent ? opponentGroup.localToWorld(new THREE.Vector3(0, 1.45, -0.12)) : table.localToWorld(new THREE.Vector3(0, 0.4, -0.35));
      legendNote.place(at, renderer.xr.isPresenting ? renderer.xr.getCamera().getWorldPosition(new THREE.Vector3()) : camera.position);
    }
    for (let k = tweens.length - 1; k >= 0; k--) {
      const tw = tweens[k];
      const u = THREE.MathUtils.clamp((time - tw.t0) / tw.dur, 0, 1);
      const e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
      tw.obj.position.lerpVectors(tw.from, tw.to, e);
      tw.obj.position.y = tw.to.y + Math.sin(Math.PI * e) * 0.03; // a small lift, like a hand moving it
      if (u >= 1) {
        tweens.splice(k, 1);
        tw.onDone?.();
      }
    }
    renderer.render(scene, camera);
  };
  renderer.setAnimationLoop(frame);
  if (import.meta.env.DEV)
    (window as unknown as Record<string, unknown>).__chess = { chess, meshes, tryMove, camera, pieces, ray, renderer, scene, opponentGroup, table, boardGroup, frame, seated: () => seated, busy: () => reaching || thinking, clock, sounds, taken, undo, newGame: () => newGame(), hands, jointsOf, handHold, inHand: () => inHand, sync: () => sync(), awaiting: (on: boolean) => (awaitingPress = on), menu, handle, lock, pressed: () => !awaitingPress };
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
