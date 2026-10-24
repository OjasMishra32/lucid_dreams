import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { SparkRenderer } from "@sparkjsdev/spark";
import { SkinnedAvatar } from "../avatar";
import { loadDream } from "../dream";
import { XrButton } from "../xr/hands";
import { HandMenu, handIndex, handSides } from "../xr/menu";
import { WorldLock } from "../xr/anchor";
import { XR_QUALITY } from "../xr/quality";
import { hashSeed } from "../chess/person";
import { C, buildCourt, inCourt, inServiceBox } from "./court";
import { type Ball, type BallEvent, BALL_R, STEP, aimToReach, copyBall, newBall, predict, spinFor, stepBall } from "./physics";
import { BallView } from "./ball";
import { HandRacket, type Pose, buildRacket, lerpPose, racketPoint, sweep } from "./racket";
import { type AssistInfo, type ShotKind, assistShot, racketResponse, rallyRegion } from "./shots";
import { LEVELS, Opponent, type HitResult } from "./opponent";
import { FORMATS, type Format, Score, type Side } from "./score";
import { FloatText, Scoreboard } from "./board";
import { CourtSounds, Umpire } from "./sound";
import { HandsView } from "./hands";
import { loadClips } from "./motion";

// Tennis on a full-size grass court: you against an AI opponent with a photoreal avatar's body, hands only. Your
// racket is in your right hand whenever it's tracked; you serve by raising your left hand (the ball floats above your
// palm) and hitting the toss; the umpire calls the score in the device's voice. The court is pinned to your room where
// you start (a WebXR anchor), and since nobody can run 24 m in a living room, rally assist brings his balls to within
// a step of you and Glide slides the court under you (never faster than 1 m/s) toward the ball's line. On a laptop it's
// the same match with the keyboard and mouse. The opponent is labelled as an AI with someone's likeness, not affiliated,
// and never speaks. Ends never change: you keep the near side (+z) all match.

type Phase = "idle" | "youHold" | "youToss" | "oppServe" | "serveFlight" | "rally" | "over" | "feed" | "practice";

interface RecFrame {
  t: number;
  ball: [number, number, number];
  shown: boolean;
  racket: [number, number, number, number, number, number, number] | null;
  opp: { g: [number, number, number]; v: [number, number, number]; stroke: { kind: string; tc: number; c: [number, number, number] } | null; split: number; hold: boolean };
}

const PLAYER_ID_DEFAULTS = ["roger-federer-uika", "roger-federer-lhm", "roger-federer", "magnus-carlsen-uika", "test-avatar"];

export async function renderTennis(root: HTMLElement) {
  document.title = "Tennis · Lucid Dreams";
  const params = new URLSearchParams(location.search);
  root.innerHTML = `
    <style>
      .tennis-keys { position: fixed; left: 50%; transform: translateX(-50%); top: 64px; margin: 0; font-size: 12px; color: var(--muted); z-index: 9; white-space: nowrap; }
      @media (max-width: 640px) { .tennis-keys { display: none; } }
    </style>
    <div class="stage" id="stage"></div>
    <div class="topbar"><a class="back" href="./"><svg viewBox="0 0 12 20"><path d="M10 2 2 10l8 8" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>Dreams</a>
      <div class="title"><div>Tennis</div><div class="subtitle" id="status">Loading the court…</div></div><div></div></div>
    <p class="tennis-keys">Space or click: swing (serve: toss, then swing) · Q lob · E drop shot · A / D move · R replay</p>
    <div class="controls chess-controls">
      <div class="segmented" id="levels">${LEVELS.map((l) => `<button data-id="${l.id}">${l.label}</button>`).join("")}</div>
      <div class="segmented" id="formats">${FORMATS.map((f) => `<button data-id="${f.id}">${f.label}</button>`).join("")}<button data-id="practice">Practice</button></div>
      <button class="pill on" id="assist">Rally assist</button>
      <button class="pill on" id="glide">Glide</button>
      <button class="pill" id="first">You serve first</button>
      <button class="pill" id="new">New match</button>
      <button class="cta" id="court" hidden>Play on court</button>
    </div>
    <p class="legend-note" id="label"></p>`;
  const $ = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;

  // ---------------- scene ----------------
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.setClearColor(0x000000, 0);
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType("local-floor");
  $("#stage").appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.03, 500);
  scene.add(camera);
  scene.add(new THREE.HemisphereLight(0xe2efff, 0x5a7444, 1.25));
  const sun = new THREE.DirectionalLight(0xfff3df, 1.6);
  sun.position.set(-10.5, 10, 1.8); // where the sky's sun is
  scene.add(sun);

  // the room (pinned where you start) holds the court; Glide moves the court inside it
  const room = new THREE.Group();
  scene.add(room);
  const courtGroup = new THREE.Group();
  room.add(courtGroup);
  const court = buildCourt(renderer);
  courtGroup.add(court.group);
  const ballView = new BallView(courtGroup);
  const opponent = new Opponent(courtGroup, env);
  const board = new Scoreboard(renderer);
  board.mesh.position.set(-(C.halfD + 1.9), 3.0, -1.2);
  board.mesh.scale.setScalar(1.35); // 3.2 m wide: readable from your baseline
  board.mesh.rotation.y = Math.atan2(0 - board.mesh.position.x, C.halfL + 1 - board.mesh.position.z);
  courtGroup.add(board.mesh);
  const label = new FloatText(renderer, 3.4, { px: 2048, h: 128, size: 66, weight: 500, bg: "rgba(0,0,0,0.5)", color: "#e5e5ea" });
  courtGroup.add(label.mesh);
  const callText = new FloatText(renderer, 3.6, { px: 2048, h: 320, size: 230, weight: 700, bg: "", color: "#ffffff" });
  courtGroup.add(callText.mesh);
  const hint = new FloatText(renderer, 1.1, { px: 2048, h: 160, size: 80, weight: 500, bg: "rgba(20,20,22,0.7)", color: "#f5f5f7" });
  courtGroup.add(hint.mesh);
  const sounds = new CourtSounds(camera, scene);
  const umpire = new Umpire();
  // the ball machine for practice: a dark box with its chute, at the far baseline
  const machine = new THREE.Group();
  {
    const mat = new THREE.MeshLambertMaterial({ color: 0x2b2f33 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.6, 0.55), mat);
    body.position.y = 0.42;
    const chute = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.4, 12), mat);
    chute.rotation.x = Math.PI / 2 - 0.35;
    chute.position.set(0, 0.85, 0.18);
    const hopper = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.22, 0.3, 16, 1, true), new THREE.MeshLambertMaterial({ color: 0x3a4046, side: THREE.DoubleSide }));
    hopper.position.y = 0.88;
    machine.add(body, chute, hopper);
    machine.position.set(0, 0, -(C.halfL + 1.2));
    machine.visible = false;
    courtGroup.add(machine);
  }

  // ---------------- state ----------------
  let level = LEVELS.find((l) => l.id === params.get("level")) ?? LEVELS[1];
  let format: Format = (FORMATS.find((f) => f.id === params.get("format"))?.id ?? "best3") as Format;
  let practice = params.get("format") === "practice";
  let rallyAssist = params.get("assist") !== "0";
  let glideOn = params.get("glide") !== "0";
  let youFirst = params.get("first") !== "him";
  let oppShort = "Opponent";
  let score = new Score(format, youFirst ? 0 : 1, ["You", oppShort]);
  const ball: Ball = newBall();
  let simT = 0;
  let acc = 0;
  let phase: Phase = "idle";
  let serveNo: 1 | 2 = 1;
  let server: Side = 0;
  let deuce = true;
  let lastHitter: Side | null = null;
  let bounces = 0;
  let tape = false;
  let lastEventT = 0;
  let nextAt = -1; // sim time the next thing (a point, a serve, a feed) starts
  let next: (() => void) | null = null;
  let footer = "";
  let ballAlpha = 0;
  let ballShown = false;
  let callUntil = 0;
  let hitCooldown = 0;
  let toldEnds = false;
  let practiceStats = { inRow: 0, best: 0 };
  let practiceFore = true;
  let lastShotInfo: (AssistInfo & { speed: number }) | null = null;
  let lastOppShot: HitResult | null = null;
  let incoming: { C: THREE.Vector3; t: number } | null = null; // where his ball will be best to hit (court), and when
  const log: string[] = []; // for checks: the calls and events, newest last
  const note = (s: string) => {
    log.push(`${simT.toFixed(2)} ${s}`);
    if (log.length > 200) log.shift();
  };
  opponent.level = level;
  opponent.rallyAssist = rallyAssist;

  // ---------------- the opponent's body ----------------
  let spark: SparkRenderer | null = null;
  let labelText = "";
  const opponentIds = [params.get("opponent"), ...PLAYER_ID_DEFAULTS].filter(Boolean) as string[];
  const loadOpponent = async (ids: string[]) => {
    for (const id of ids) {
      try {
        const d = await loadDream(id);
        if (!SkinnedAvatar.canSkin(d)) throw new Error("no rig");
        if (!spark) scene.add((spark = new SparkRenderer({ renderer })));
        const a = await SkinnedAvatar.load(d);
        const display = /\(|test/i.test(d.name) ? "Your opponent" : d.name;
        oppShort = /\(|test/i.test(d.name) ? "Opponent" : d.name.trim().split(/\s+/).pop()!;
        opponent.setAvatar(a, oppShort);
        score.names = ["You", oppShort];
        labelText = id.startsWith("roger-federer")
          ? "Roger Federer's likeness. AI opponent, not affiliated."
          : display === "Your opponent"
            ? "Stand-in avatar. AI opponent, not affiliated."
            : `${display}'s likeness. AI opponent, not affiliated.`;
        $("#label").textContent = labelText;
        if (opponent.anim.rig) {
          const clips = await loadClips(opponent.anim.rig);
          opponent.anim.clips = clips;
          if (clips.size) note(`clips: ${[...clips.keys()].join(",")}`);
        }
        note(`opponent ${id}`);
        return;
      } catch (e) {
        console.info(`No tennis opponent ${id} yet:`, (e as Error).message);
      }
    }
    labelText = "AI opponent, not affiliated.";
    $("#label").textContent = labelText;
  };

  // ---------------- XR: hands, racket, menu ----------------
  const hands = [0, 1].map((i) => renderer.xr.getHand(i));
  hands.forEach((h) => scene.add(h));
  const sideOf = handSides(hands);
  const racket = new HandRacket(scene, env);
  const handsView = new HandsView(scene, hands);
  const menu = new HandMenu(hands, sideOf, scene, 2);
  const lock = new WorldLock(renderer, room);
  let placed = false;
  let roomMode = false;
  let arSession = false;

  // ---------------- the desktop player ----------------
  const desk = { x: 0.8, z: C.halfL + 0.4, swingAt: -10, swingKind: "drive" as "drive" | "lob" | "drop", swingSide: 1, keys: new Set<string>() };
  const deskRacket = buildRacket({ frame: 0x283447, grip: "#f1f1ec", wrap: "#cfd2d0" }, env);
  courtGroup.add(deskRacket);

  // ---------------- where you are ----------------
  const headWorld = new THREE.Vector3();
  const headCourt = new THREE.Vector3();
  const playerCourt = new THREE.Vector3(); // on the floor
  const eyeCourt = new THREE.Vector3();
  const updatePlayer = () => {
    if (renderer.xr.isPresenting) {
      renderer.xr.getCamera().getWorldPosition(headWorld);
      courtGroup.updateMatrixWorld();
      headCourt.copy(headWorld);
      courtGroup.worldToLocal(headCourt);
      eyeCourt.copy(headCourt);
      playerCourt.set(headCourt.x, 0, headCourt.z);
    } else {
      playerCourt.set(desk.x, 0, desk.z);
      eyeCourt.set(desk.x, 1.65, desk.z);
      camera.getWorldPosition(headWorld);
    }
  };

  // ---------------- glide: the court slides under you ----------------
  const glide = { offset: new THREE.Vector3(), vel: new THREE.Vector3(), target: new THREE.Vector3(), betweenPoints: false };
  /** Put the court where `spot` (court) is under your feet now, smoothly. */
  const glideTo = (spot: THREE.Vector3) => {
    if (!renderer.xr.isPresenting) {
      desk.x = spot.x;
      desk.z = spot.z;
      return;
    }
    // court position (room space) = your position (room space) - spot
    const you = room.worldToLocal(headWorld.clone());
    glide.target.set(you.x - spot.x, 0, you.z - spot.z);
    glide.betweenPoints = true;
  };
  const stepGlide = (dt: number) => {
    if (!renderer.xr.isPresenting) return;
    if (!glide.betweenPoints) {
      glide.target.copy(courtGroup.position);
      if (glideOn && incoming && lastHitter === 1 && (phase === "rally" || phase === "serveFlight" || phase === "feed")) {
        // the court slides so his ball's best hitting point drifts to your forehand (or backhand), within 1 m/s
        const fore = incoming.C.x > playerCourt.x - 0.15 ? 1 : -1;
        const dx = incoming.C.x - (playerCourt.x + fore * 0.75);
        const dz = incoming.C.z - (playerCourt.z - 0.4);
        glide.target.x = courtGroup.position.x - dx;
        if (Math.abs(dz) > 0.8) glide.target.z = courtGroup.position.z - (dz - Math.sign(dz) * 0.8) * 0.6;
      }
    }
    const max = glide.betweenPoints ? 2.2 : 1.0;
    const to = glide.target.clone().sub(courtGroup.position);
    const d = to.length();
    const want = d > 0.005 ? to.multiplyScalar(Math.min(max, Math.sqrt(2 * 2.5 * d)) / d) : to.set(0, 0, 0);
    const dv = want.sub(glide.vel);
    if (dv.length() > 3 * dt) dv.setLength(3 * dt);
    glide.vel.add(dv);
    if (glide.vel.length() > max) glide.vel.setLength(max);
    courtGroup.position.addScaledVector(glide.vel, dt);
    if (glide.betweenPoints && d < 0.02) {
      glide.betweenPoints = false;
      glide.vel.set(0, 0, 0);
    }
  };

  // ---------------- calls ----------------
  const flash = (text: string) => {
    callText.set(text.toUpperCase());
    callUntil = simT + 1.6;
  };
  const say = (text: string, interrupt = false) => {
    note(`call: ${text}`);
    umpire.call(text, interrupt);
  };
  const setFooter = (text: string) => {
    footer = text;
    $("#status").textContent = text;
  };
  const serverWord = () => (server === 0 ? "Your serve" : `${oppShort} to serve`);
  const drawBoard = () => board.draw(practice ? null : score, practice ? null : server, footer, practice ? practiceStats : undefined);

  // ---------------- a point ----------------
  const later: { at: number; fn: () => void }[] = [];
  const after0 = (seconds: number, fn: () => void) => later.push({ at: simT + seconds, fn });
  const after = (seconds: number, fn: () => void) => {
    nextAt = simT + seconds;
    next = fn;
  };

  const startServe = () => {
    lastHitter = null;
    bounces = 0;
    tape = false;
    incoming = null;
    hitCooldown = 0;
    lastEventT = simT;
    ball.v.set(0, 0, 0);
    ball.w.set(0, 0, 0);
    ball.rolling = false;
    const side = deuce ? "deuce court" : "ad court";
    if (server === 0) {
      phase = "youHold";
      glideTo(new THREE.Vector3(deuce ? 0.75 : -0.75, 0, C.halfL + 0.35));
      const rp = opponent.receivePosition(deuce, serveNo === 2);
      opponent.placeAt(rp.x, rp.z);
      setFooter(`${serveNo === 2 ? "Second serve" : "Your serve"}, ${side}. ${renderer.xr.isPresenting ? "Raise your left hand to toss" : "Space to toss, Space to hit"}`);
    } else {
      phase = "oppServe";
      glideTo(new THREE.Vector3(deuce ? 1.5 : -1.5, 0, C.halfL + (serveNo === 2 ? 0.2 : 0.9)));
      opponent.startServe(simT + 0.4, deuce, serveNo === 2);
      setFooter(`${serveNo === 2 ? "Second serve" : `${oppShort} serving`}, ${side}`);
    }
    ballShown = true;
    if (server === 0) holdBallInPalm();
    else opponent.ballInHand(ball.p);
    note(`serve ${server === 0 ? "you" : "opp"} ${deuce ? "deuce" : "ad"} #${serveNo}`);
    recording = [];
  };

  const startPoint = () => {
    if (practice) return startPractice();
    if (score.winner !== null) {
      phase = "idle";
      setFooter(score.winner === 0 ? "You win the match. New match from the menu." : `${oppShort} wins the match. New match from the menu.`);
      return;
    }
    server = score.server();
    deuce = score.deuce();
    serveNo = 1;
    startServe();
  };

  const endPoint = (winner: Side, call: string, why: string) => {
    if (phase === "over") return;
    phase = "over";
    incoming = null;
    opponent.plan = null;
    note(`point ${winner === 0 ? "you" : "opp"} (${why})`);
    if (call) {
      say(call, true);
      flash(call);
    }
    const out = score.pointTo(winner);
    lastRecording = recording;
    if (out.game && winner === 1) after0(0.5, () => opponent.cheer(out.match ? "celebrate" : "fistPump"));
    after(call ? 1.0 : 0.6, () => {
      say(out.call);
      if (out.game) {
        flash(out.match ? "Match" : out.set ? "Set" : "Game");
        const played = score.sets.reduce((n, s) => n + s[0] + s[1], 0) + score.games[0] + score.games[1];
        if (!out.match && played % 2 === 1) {
          setFooter("Change of ends: you keep the near side");
          if (!toldEnds) {
            toldEnds = true;
            say("The ends don't change here. You keep the near side.");
          }
        }
      }
      drawBoard();
      after(out.game ? 2.6 : 1.7, startPoint);
    });
  };

  const fault = (why: string) => {
    if (phase === "over") return;
    note(`fault (${why})`);
    if (serveNo === 1) {
      phase = "over";
      incoming = null;
      opponent.plan = null;
      say("Fault", true);
      flash("Fault");
      serveNo = 2;
      after(1.8, startServe);
    } else {
      endPoint((1 - server) as Side, "Double fault", why);
    }
  };

  const letServe = () => {
    phase = "over";
    incoming = null;
    opponent.plan = null;
    say("Let", true);
    flash("Let");
    note("let");
    after(1.8, startServe);
  };

  // ---------------- practice: the ball machine ----------------
  const startPractice = () => {
    phase = "feed";
    machine.visible = true;
    opponent.placeAt(-3.4, -(C.halfL + 1.6));
    lastHitter = 1;
    bounces = 0;
    ballShown = true;
    glideTo(new THREE.Vector3(practiceFore ? 0.2 : -0.2, 0, C.halfL + 0.6));
    setFooter("Practice: the machine feeds you. Hit them in");
    after(1.4, feed);
  };
  const feed = () => {
    if (!practice) return;
    phase = "practice";
    lastHitter = 1;
    bounces = 0;
    tape = false;
    hitCooldown = 0;
    lastEventT = simT;
    practiceFore = !practiceFore;
    const from = new THREE.Vector3(0, 0.95, -(C.halfL + 0.95));
    const fore = practiceFore ? 1 : -1;
    const H = new THREE.Vector3(playerCourt.x + fore * 0.8, 1.0, playerCourt.z - 0.35);
    const { shot, at } = aimToReach(from, H, 15 + Math.random() * 3, 150, rallyRegion(1, 0.6), 0.5);
    ball.p.copy(from);
    ball.v.copy(shot.v);
    ball.w.copy(shot.w);
    ball.rolling = false;
    ballAlpha = 1;
    incoming = { C: at, t: simT + 1 };
    sounds.hit(courtGroup.localToWorld(from.clone()), 12);
    recording = [];
  };

  // ---------------- what the ball does (rules) ----------------
  const onEvent = (e: BallEvent) => {
    const at = courtGroup.localToWorld(e.p.clone());
    if (e.type === "bounce") sounds.bounce(at, e.vIn);
    else if (e.type === "net") sounds.netCord(at);
    lastEventT = simT;
    if (phase === "over" || phase === "idle" || phase === "youHold") return;
    if (phase === "youToss") {
      if (e.type === "bounce") {
        // the toss came down unhit: toss again, no fault
        phase = "youHold";
        note("toss dropped");
      }
      return;
    }
    const sideOfZ = (z: number): Side => (z > 0 ? 0 : 1);
    if (phase === "oppServe") return; // his toss in the air
    if (phase === "serveFlight") {
      const receiver = (1 - server) as Side;
      if (e.type === "net") {
        if (e.tape) tape = true;
        return;
      }
      if (e.type === "wall") return fault("long");
      if (sideOfZ(e.p.z) !== receiver) return fault("net");
      if (inServiceBox(e.p.x, e.p.z, e.patch, receiver === 0 ? 1 : -1, deuce)) {
        if (tape) return letServe();
        phase = "rally";
        bounces = 1;
        note(`serve in ${e.p.x.toFixed(2)},${e.p.z.toFixed(2)}`);
        return;
      }
      note(`serve out ${e.p.x.toFixed(2)},${e.p.z.toFixed(2)}`);
      return fault("out");
    }
    if (phase === "rally") {
      if (lastHitter === null) return;
      const receiver = (1 - lastHitter) as Side;
      if (e.type === "net") return;
      if (e.type === "wall") {
        if (bounces === 0) return endPoint(receiver, "Out", "out of the air");
        return endPoint(lastHitter, "", "past");
      }
      const s = sideOfZ(e.p.z);
      note(`bounce ${e.p.x.toFixed(2)},${e.p.z.toFixed(2)}`);
      // a second bounce anywhere (even back over the net, off heavy backspin) is the receiver's miss
      if (bounces >= 1) return endPoint(lastHitter, "", "two bounces");
      if (s === lastHitter) return endPoint(receiver, "", "net");
      bounces++;
      if (bounces === 1 && !inCourt(e.p.x, e.p.z, e.patch)) {
        note(`out ${e.p.x.toFixed(2)},${e.p.z.toFixed(2)}`);
        return endPoint(receiver, "Out", "out");
      }
      if (bounces >= 2) return endPoint(lastHitter, "", "two bounces");
      return;
    }
    if (phase === "practice") {
      if (e.type !== "bounce") return;
      const s = sideOfZ(e.p.z);
      if (lastHitter === 1 && s === 0) {
        bounces++;
        if (bounces >= 2) {
          practiceStats.inRow = 0;
          practiceDone();
        }
      } else if (lastHitter === 0) {
        if (s === 1 && inCourt(e.p.x, e.p.z, e.patch)) {
          practiceStats.inRow++;
          practiceStats.best = Math.max(practiceStats.best, practiceStats.inRow);
          flash("In");
        } else {
          practiceStats.inRow = 0;
          flash(s === 0 ? "Net" : "Out");
        }
        practiceDone();
      }
    }
  };
  const practiceDone = () => {
    phase = "feed";
    drawBoard();
    after(1.2, feed);
  };

  /** His ball is on its way: where you'll want to hit it (for Glide, the laptop's auto-move and timing). */
  const readIncoming = () => {
    const pred = predict(ball, 3.5, (b) => b.p.z > C.halfL + 5);
    let bounced = false;
    let best: { C: THREE.Vector3; t: number } | null = null;
    let apex: { C: THREE.Vector3; t: number } | null = null;
    let prevVy = 0;
    for (const s of pred.samples) {
      if (!bounced) {
        bounced = pred.events.some((e) => e.e.type === "bounce" && e.t <= s.t);
        prevVy = s.v.y;
        continue;
      }
      if (prevVy > 0 && s.v.y <= 0) apex = { C: s.p.clone(), t: simT + s.t };
      prevVy = s.v.y;
      if (s.v.y < 0 && s.p.y < 1.05) {
        best = apex && apex.C.y < 1.15 ? apex : { C: s.p.clone(), t: simT + s.t };
        break;
      }
    }
    incoming = best ?? apex;
  };

  const onOppHit = (r: HitResult) => {
    lastOppShot = r;
    note(`opp ${r.kind} ${r.type} ${r.speed.toFixed(1)}`);
    sounds.hit(courtGroup.localToWorld(ball.p.clone()), r.speed);
    lastHitter = 1;
    bounces = 0;
    tape = false;
    lastEventT = simT;
    if (r.kind === "serve") phase = "serveFlight";
    else phase = "rally";
    readIncoming();
  };

  /** You hit it (the headset's racket, or the laptop's swing). */
  const onYouHit = (info: AssistInfo, speed: number) => {
    lastShotInfo = { ...info, speed };
    note(`you ${info.kind} ${speed.toFixed(1)} assist ${info.assist.toFixed(2)}`);
    sounds.hit(courtGroup.localToWorld(ball.p.clone()), speed);
    hitCooldown = simT + 0.3;
    lastEventT = simT;
    incoming = null;
    if (phase === "youToss") {
      phase = "serveFlight";
      lastHitter = 0;
      bounces = 0;
      tape = false;
      opponent.read(ball, simT, { deuce });
      return;
    }
    if (phase === "practice") {
      lastHitter = 0;
      bounces = 0;
      return;
    }
    if (phase === "serveFlight" && server === 1) return endPoint(1, "", "the serve must bounce");
    if (phase !== "rally") return;
    if (lastHitter === 0) return;
    if (ball.p.z < -0.05) return endPoint(1, "", "before it crossed the net");
    lastHitter = 0;
    bounces = 0;
    opponent.splitStep(simT);
    opponent.read(ball, simT, null);
  };

  // ---------------- your racket meeting the ball (the headset) ----------------
  const poses: Pose[] = [0, 1, 2].map(() => ({ p: new THREE.Vector3(), q: new THREE.Quaternion() })); // oldest .. newest (court)
  const dts = [1 / 72, 1 / 72];
  let posesValid = 0;
  const rA: Pose = { p: new THREE.Vector3(), q: new THREE.Quaternion() };
  const rB: Pose = { p: new THREE.Vector3(), q: new THREE.Quaternion() };
  const invCourt = new THREE.Matrix4();
  const tmpM = new THREE.Matrix4();
  const tmpS = new THREE.Vector3();
  const readRacketPose = (dt: number) => {
    racket.obj.updateMatrixWorld();
    courtGroup.updateMatrixWorld();
    invCourt.copy(courtGroup.matrixWorld).invert();
    tmpM.multiplyMatrices(invCourt, racket.obj.matrixWorld);
    const [p0, p1, p2] = poses;
    p0.p.copy(p1.p);
    p0.q.copy(p1.q);
    p1.p.copy(p2.p);
    p1.q.copy(p2.q);
    tmpM.decompose(p2.p, p2.q, tmpS);
    dts[0] = dts[1];
    dts[1] = Math.max(dt, 1 / 200);
    posesValid = racket.live ? Math.min(3, posesValid + 1) : 0;
  };
  const canHit = () => simT > hitCooldown && (phase === "youToss" || phase === "practice" || ((phase === "rally" || phase === "serveFlight") && lastHitter !== 0));

  const tryRacket = (b0: THREE.Vector3, b1: THREE.Vector3, f0: number, f1: number) => {
    if (posesValid < 3 || !canHit()) return;
    lerpPose(poses[1], poses[2], f0, rA);
    lerpPose(poses[1], poses[2], f1, rB);
    const hit = sweep(b0, b1, rA, rB);
    if (!hit) return;
    // the strings' velocity where they met the ball, over the last two frames (hand tracking is noisy frame to frame)
    const pNow = racketPoint(poses[2], hit.local);
    const pBefore = racketPoint(poses[0], hit.local);
    const vR = pNow.sub(pBefore).divideScalar(dts[0] + dts[1]);
    const n = new THREE.Vector3(0, 0, 1).applyQuaternion(rB.q).multiplyScalar(hit.side);
    const res = racketResponse(ball.v, vR, n, ball.w, hit.offCentre);
    if (!res) return;
    // on the strings: 1 at the centre, 0.7 at their edge; past the strings (the frame, the zone's outer ring): a mishit
    const quality = hit.offCentre > 1.45 ? 0.1 : 1 - 0.3 * THREE.MathUtils.clamp(hit.offCentre - 0.5, 0, 1);
    const contact = racketPoint(rB, hit.local).addScaledVector(n, BALL_R + 0.006);
    const isServe = phase === "youToss";
    const volley = phase === "rally" && bounces === 0;
    const info = {} as AssistInfo;
    const shot = assistShot(contact, res.v, res.w, quality, vR.length(), -1, isServe ? { deuce } : null, volley, info);
    ball.p.copy(contact);
    ball.v.copy(shot.v);
    ball.w.copy(shot.w);
    ball.rolling = false;
    onYouHit(info, shot.v.length());
  };

  // ---------------- your serve: the ball over your left palm, tossed by raising the hand ----------------
  const palm = new THREE.Vector3();
  const palmPrev = new THREE.Vector3();
  const palmVel = new THREE.Vector3();
  let palmValid = false;
  const palmN = new THREE.Vector3();
  const jq = new THREE.Quaternion();
  const readPalm = (dt: number) => {
    const L = hands[handIndex(sideOf, "left")] as unknown as THREE.Object3D & { joints?: Record<string, THREE.Object3D> };
    const mc = L.visible ? L.joints?.["middle-finger-metacarpal"] : undefined; // a lost hand keeps its joints' last state
    if (!mc?.visible) {
      palmValid = false;
      return false;
    }
    mc.getWorldPosition(palm);
    courtGroup.worldToLocal(palm);
    mc.getWorldQuaternion(jq);
    palmN.set(0, -1, 0).applyQuaternion(jq);
    if (palmValid) palmVel.lerp(palm.clone().sub(palmPrev).divideScalar(Math.max(dt, 1 / 200)), 0.5);
    else palmVel.set(0, 0, 0);
    palmPrev.copy(palm);
    palmValid = true;
    return true;
  };
  const holdBallInPalm = () => {
    // just above the palm (or in front of you, low, if the hand isn't seen)
    if (renderer.xr.isPresenting && palmValid) ball.p.copy(palm).add(new THREE.Vector3(0, 0.055, 0));
    else if (renderer.xr.isPresenting) ball.p.copy(eyeCourt).add(new THREE.Vector3(-0.25, -0.55, -0.35));
    else ball.p.set(desk.x - 0.3, 1.1, desk.z - 0.35);
    ball.v.set(0, 0, 0);
  };
  const toss = (v: THREE.Vector3) => {
    phase = "youToss";
    ball.v.copy(v);
    ball.w.set(0, 0, 0);
    ball.rolling = false;
    note(`toss ${v.y.toFixed(2)}`);
    opponent.splitStep(simT + 0.6);
  };

  // ---------------- the laptop's swing ----------------
  const deskSwing = (kind: "drive" | "lob" | "drop") => {
    sounds.resume();
    if (phase === "youHold") return toss(new THREE.Vector3(0.02, 4.7, -0.15));
    desk.swingAt = simT;
    desk.swingKind = kind;
    desk.swingSide = ball.p.x >= desk.x - 0.1 ? 1 : -1;
  };
  /** Each step: during a laptop swing, the ball in your hitting zone is struck, the timing deciding the line. */
  const deskContact = () => {
    const ts = simT - desk.swingAt;
    if (ts < 0 || ts > 0.38 || !canHit()) return;
    const b = ball.p;
    if (phase === "youToss") {
      if (b.y < 1.7 || b.y > 3.3 || ball.v.y > 0.8) return;
      const q = THREE.MathUtils.clamp(1 - Math.abs(b.y - 2.55) / 0.9, 0, 1);
      const tx = (deuce ? -1 : 1) * (1.2 + Math.random() * 2);
      const dir = new THREE.Vector3(tx - b.x, 0, -5.4 - b.z).normalize();
      const vNat = dir.multiplyScalar(28 + q * 16).setY(-2);
      const info = {} as AssistInfo;
      const shot = assistShot(b.clone(), vNat, new THREE.Vector3(-60, 0, 0), q, 20, -1, { deuce }, false, info);
      ball.v.copy(shot.v);
      ball.w.copy(shot.w);
      return onYouHit(info, shot.v.length());
    }
    if (!(lastHitter === 1 || phase === "practice")) return;
    if (ball.v.z < 0) return;
    const side = desk.swingSide;
    const zoneX = desk.x + side * 0.8;
    if (Math.abs(b.x - zoneX) > 1.1 || b.z < desk.z - 1.5 || b.z > desk.z + 0.3 || b.y < 0.12 || b.y > 2.8) return;
    if (b.z < desk.z - 0.45 && ts < 0.16) return; // let it come to the contact point unless the swing is late
    const timing = ts - 0.18; // < 0 early (pulled crosscourt), > 0 late (pushed down the line)
    const volley = phase === "rally" && bounces === 0;
    let speed = THREE.MathUtils.clamp(24 - Math.abs(timing) * 40, 11, 26);
    const tx = THREE.MathUtils.clamp(-side * 2.4 + timing * side * 14, -3.6, 3.6);
    let tz = -(9.4 + Math.random() * 1.6);
    let racketSpeed = 15;
    let elev = 0.16;
    if (b.y > 1.9) {
      speed = 32;
      elev = -0.15;
      tz = -(7 + Math.random() * 3);
    } else if (desk.swingKind === "lob") {
      speed = 18;
      elev = 0.7;
    } else if (desk.swingKind === "drop") {
      speed = 8;
      racketSpeed = 2;
      tz = -(2 + Math.random() * 2);
    }
    const dir = new THREE.Vector3(tx - b.x, 0, tz - b.z).normalize();
    const vNat = dir.clone().multiplyScalar(Math.cos(elev) * speed).setY(Math.sin(elev) * speed);
    const wNat = spinFor(dir, desk.swingKind === "drop" ? -220 : desk.swingKind === "lob" ? 120 : 230); // topspin, or backspin on a drop
    const q = THREE.MathUtils.clamp(1 - Math.abs(timing) / 0.25, 0, 1);
    const info = {} as AssistInfo;
    const shot = assistShot(b.clone(), vNat, wNat, q, racketSpeed, -1, null, volley, info);
    ball.v.copy(shot.v);
    ball.w.copy(shot.w);
    ball.rolling = false;
    desk.swingAt = -10;
    onYouHit(info, shot.v.length());
  };

  // ---------------- one physics step ----------------
  const b0 = new THREE.Vector3();
  const substep = (f0: number, f1: number) => {
    const held = phase === "youHold" || phase === "idle" || phase === "feed" || (phase === "oppServe" && opponent.holdingBall);
    if (phase === "youHold") holdBallInPalm();
    else if (phase === "oppServe" && opponent.holdingBall) opponent.ballInHand(ball.p);
    if (!held) {
      b0.copy(ball.p);
      stepBall(ball, STEP, onEvent);
      if (renderer.xr.isPresenting) tryRacket(b0, ball.p, f0, f1);
      else deskContact();
      // a toss you let fall: toss again
      if (phase === "youToss" && ball.p.y < 0.5 && ball.v.y < 0) {
        phase = "youHold";
        note("toss dropped");
      }
    }
    const r = opponent.tryHit(ball, simT, playerCourt);
    if (r && phase !== "over") onOppHit(r);
    simT += STEP;
    // nothing has happened for a long time (a ball stuck somewhere): the point goes to whoever didn't hit last
    if ((phase === "rally" || phase === "serveFlight") && simT - lastEventT > 7 && lastHitter !== null) endPoint((1 - lastHitter) as Side, "", "timeout");
  };

  // ---------------- the replay of the last point ----------------
  let recording: RecFrame[] = [];
  let lastRecording: RecFrame[] = [];
  let replay: { frames: RecFrame[]; i: number; el: number } | null = null;
  const ghost = buildRacket({ frame: 0x8fa3bf, grip: "#f1f1ec", wrap: "#cfd2d0" });
  ghost.visible = false;
  courtGroup.add(ghost);
  const record = () => {
    if (recording.length > 72 * 30) return;
    const st = opponent.stroke;
    const rp = renderer.xr.isPresenting && racket.obj.visible ? poses[2] : null;
    recording.push({
      t: simT,
      ball: [ball.p.x, ball.p.y, ball.p.z],
      shown: ballAlpha > 0.5,
      racket: rp ? [rp.p.x, rp.p.y, rp.p.z, rp.q.x, rp.q.y, rp.q.z, rp.q.w] : null,
      opp: { g: [opponent.ground.x, 0, opponent.ground.z], v: [opponent.vel.x, 0, opponent.vel.z], stroke: st ? { kind: st.kind, tc: st.tc, c: [st.contact.x, st.contact.y, st.contact.z] } : null, split: -1, hold: opponent.holdingBall },
    });
  };
  const startReplay = () => {
    if (!lastRecording.length || replay) return;
    replay = { frames: lastRecording, i: 0, el: 0 };
    setFooter("Replay of the last point");
    flash("Replay");
  };

  // ---------------- menus and buttons ----------------
  const newMatch = () => {
    score = new Score(format, youFirst ? 0 : 1, ["You", oppShort]);
    practiceStats = { inRow: 0, best: 0 };
    machine.visible = practice;
    toldEnds = false;
    phase = "idle";
    opponent.reseed(hashSeed("tennis", Date.now() % 100000));
    opponent.placeAt(0, -(C.halfL + 0.7));
    drawBoard();
    note(`new ${practice ? "practice" : format} ${level.id}`);
    after(0.8, startPoint);
  };
  const levelButton = new XrButton("level", `Level · ${level.label}`, () => {
    setLevel(LEVELS[(LEVELS.indexOf(level) + 1) % LEVELS.length].id);
  });
  const formatButton = new XrButton("format", FORMATS.find((f) => f.id === format)!.label, () => {
    const order = [...FORMATS.map((f) => f.id), "practice"] as const;
    const cur = practice ? "practice" : format;
    setFormat(order[(order.indexOf(cur) + 1) % order.length]);
  });
  const firstButton = new XrButton("first", youFirst ? "You serve first" : "He serves first", () => setFirst(!youFirst));
  const assistButton = new XrButton("assist", "Rally assist", () => setAssist(!rallyAssist));
  const glideButton = new XrButton("glide", "Glide", () => setGlide(!glideOn));
  const envButton = new XrButton("env", "Your room", () => setRoom(!roomMode));
  menu.add(
    new XrButton("new", "New match", () => newMatch()),
    formatButton,
    levelButton,
    firstButton,
    assistButton,
    glideButton,
    envButton,
    new XrButton("recentre", "Re-centre", () => {
      placed = false;
    }),
    new XrButton("replay", "Replay", () => startReplay()),
  );
  const setLevel = (id: string) => {
    level = LEVELS.find((l) => l.id === id) ?? level;
    opponent.level = level;
    levelButton.setLabel(`Level · ${level.label}`);
    root.querySelectorAll<HTMLButtonElement>("#levels button").forEach((b) => b.classList.toggle("on", b.dataset.id === level.id));
  };
  const setFormat = (id: string) => {
    practice = id === "practice";
    if (!practice) format = id as Format;
    formatButton.setLabel(practice ? "Practice" : FORMATS.find((f) => f.id === format)!.label);
    root.querySelectorAll<HTMLButtonElement>("#formats button").forEach((b) => b.classList.toggle("on", b.dataset.id === (practice ? "practice" : format)));
    newMatch();
  };
  const setFirst = (you: boolean) => {
    youFirst = you;
    firstButton.setLabel(you ? "You serve first" : "He serves first");
    $("#first").textContent = you ? "You serve first" : `${oppShort} serves first`;
    newMatch();
  };
  const setAssist = (on: boolean) => {
    rallyAssist = on;
    opponent.rallyAssist = on;
    assistButton.setOn(on);
    $("#assist").classList.toggle("on", on);
  };
  const setGlide = (on: boolean) => {
    glideOn = on;
    glideButton.setOn(on);
    $("#glide").classList.toggle("on", on);
  };
  const setRoom = (on: boolean) => {
    if (on && !arSession) return; // a VR-only headset has no passthrough
    roomMode = on;
    court.setRoom(on);
    handsView.setRoom(on);
    envButton.setLabel(on ? "Court" : "Your room");
  };
  root.querySelectorAll<HTMLButtonElement>("#levels button").forEach((b) => b.addEventListener("click", () => setLevel(b.dataset.id!)));
  root.querySelectorAll<HTMLButtonElement>("#formats button").forEach((b) => b.addEventListener("click", () => setFormat(b.dataset.id!)));
  $("#assist").addEventListener("click", () => setAssist(!rallyAssist));
  $("#glide").addEventListener("click", () => setGlide(!glideOn));
  $("#first").addEventListener("click", () => setFirst(!youFirst));
  $("#new").addEventListener("click", () => newMatch());
  setLevel(level.id);
  setAssist(rallyAssist);
  setGlide(glideOn);
  root.querySelectorAll<HTMLButtonElement>("#formats button").forEach((b) => b.classList.toggle("on", b.dataset.id === (practice ? "practice" : format)));

  // keyboard and mouse
  addEventListener("keydown", (e) => {
    if (renderer.xr.isPresenting) return;
    const k = e.key.toLowerCase();
    if (e.code === "Space") {
      e.preventDefault();
      (document.activeElement as HTMLElement | null)?.blur?.();
      if (!e.repeat) deskSwing("drive");
    } else if (k === "q") deskSwing("lob");
    else if (k === "e") deskSwing("drop");
    else if (k === "r") startReplay();
    else desk.keys.add(k);
  });
  addEventListener("keyup", (e) => desk.keys.delete(e.key.toLowerCase()));
  renderer.domElement.addEventListener("pointerdown", () => {
    if (!renderer.xr.isPresenting) deskSwing("drive");
  });

  // ---------------- the headset session ----------------
  const arOk = !!navigator.xr && (await navigator.xr.isSessionSupported("immersive-ar").catch(() => false));
  const vrOk = !!navigator.xr && (await navigator.xr.isSessionSupported("immersive-vr").catch(() => false));
  if (arOk || vrOk) $("#court").hidden = false;
  $("#court").addEventListener("click", async () => {
    sounds.resume();
    arSession = arOk;
    const session = await navigator.xr!.requestSession(arOk ? "immersive-ar" : "immersive-vr", { requiredFeatures: ["local-floor"], optionalFeatures: ["hand-tracking", "anchors"] });
    renderer.xr.setFramebufferScaleFactor(XR_QUALITY.res); // full resolution: the lines, the ball and the text stay sharp
    renderer.xr.setFoveation(XR_QUALITY.fov);
    await renderer.xr.setSession(session);
    placed = false;
    setRoom(false);
    note(`session ${arOk ? "ar" : "vr"}`);
    session.addEventListener("end", () => {
      lock.release();
      menu.group.visible = menu.open = false;
      racket.hide();
      room.position.set(0, 0, 0);
      room.quaternion.identity();
      courtGroup.position.set(0, 0, 0);
      setRoom(false);
      glide.betweenPoints = false;
      onResize();
    });
    newMatch();
  });

  const placeCourt = () => {
    const cam = renderer.xr.getCamera();
    cam.getWorldPosition(headWorld);
    const fwd = cam.getWorldDirection(new THREE.Vector3()).setY(0);
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();
    room.position.set(headWorld.x, 0, headWorld.z);
    room.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(-fwd.x, -fwd.z)); // the court's -z (the net) ahead of you
    room.updateMatrixWorld(true);
    lock.lock();
    // you're where the point needs you: behind your baseline
    const spot = phase === "oppServe" ? new THREE.Vector3(deuce ? 1.5 : -1.5, 0, C.halfL + 0.9) : new THREE.Vector3(deuce ? 0.75 : -0.75, 0, C.halfL + 0.35);
    courtGroup.position.set(-spot.x, 0, -spot.z);
    glide.vel.set(0, 0, 0);
    glide.betweenPoints = false;
    placed = true;
  };

  // ---------------- the loop ----------------
  const onResize = () => {
    renderer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  };
  addEventListener("resize", onResize);
  let lastTime = 0;
  const tmp = new THREE.Vector3();
  let camView: { p: THREE.Vector3; t: THREE.Vector3 } | null = null; // dev: a fixed view for checks
  let paused = false; // dev: hold everything still (his pose can be set by hand)
  camera.position.set(desk.x * 0.8, 2.15, desk.z + 3.6);
  const frame = (time: number) => {
    const dt = lastTime ? THREE.MathUtils.clamp((time - lastTime) / 1000, 0, 0.1) : 1 / 72; // a clock that jumps back: no time passes
    lastTime = time;
    const xr = renderer.xr.isPresenting;
    let menuOpen = false;
    if (xr) {
      if (!placed) placeCourt();
      lock.update();
      updatePlayer();
      menuOpen = menu.update(headWorld, time, dt);
      handsView.update();
      racket.update(hands[handIndex(sideOf, "right")], dt);
      readRacketPose(dt);
      readPalm(dt);
      // the toss: the hand rising fast (or opening as it rises) lets the ball go
      if (phase === "youHold" && palmValid && !menuOpen && palmVel.y > 1.15 && palm.y > 0.9) {
        const v = palmVel.clone();
        toss(new THREE.Vector3(v.x * 0.25, THREE.MathUtils.clamp(v.y * 1.6, 3.6, 5.4), v.z * 0.25 - 0.15));
      }
      stepGlide(dt);
    } else {
      // the laptop: keys move you, and with rally assist you drift toward his ball yourself
      const mv = new THREE.Vector3((desk.keys.has("d") || desk.keys.has("arrowright") ? 1 : 0) - (desk.keys.has("a") || desk.keys.has("arrowleft") ? 1 : 0), 0, (desk.keys.has("s") || desk.keys.has("arrowdown") ? 1 : 0) - (desk.keys.has("w") || desk.keys.has("arrowup") ? 1 : 0));
      if (mv.lengthSq()) desk.x += mv.x * 4 * dt, desk.z += mv.z * 4 * dt;
      else if (rallyAssist && incoming && lastHitter === 1 && phase !== "over") {
        const fore = incoming.C.x > desk.x - 0.15 ? 1 : -1;
        const want = incoming.C.x - fore * 0.8;
        desk.x += THREE.MathUtils.clamp(want - desk.x, -4.5 * dt, 4.5 * dt);
        const wz = incoming.C.z + 0.4;
        if (Math.abs(wz - desk.z) > 0.3) desk.z += THREE.MathUtils.clamp(wz - desk.z, -3 * dt, 3 * dt);
      }
      desk.x = THREE.MathUtils.clamp(desk.x, -(C.halfD + 3), C.halfD + 3);
      desk.z = THREE.MathUtils.clamp(desk.z, 0.5, C.halfL + 5.5);
      updatePlayer();
    }

    if (paused) {
      opponent.update(0, simT, ball, true); // held still: nothing moves, the pose is re-solved
    } else if (replay) {
      // the last point again, as it happened (the ball, his body, your racket)
      const f = replay.frames[replay.i];
      replay.el += dt;
      const el = replay.el;
      while (replay.i < replay.frames.length - 1 && replay.frames[replay.i + 1].t - replay.frames[0].t < el) replay.i++;
      ball.p.set(...f.ball);
      ballAlpha = f.shown ? 1 : 0;
      opponent.ground.set(...f.opp.g);
      opponent.vel.set(...f.opp.v);
      opponent.stroke = f.opp.stroke ? { kind: f.opp.stroke.kind as never, tc: f.opp.stroke.tc, contact: new THREE.Vector3(...f.opp.stroke.c) } : null;
      opponent.holdingBall = f.opp.hold;
      opponent.update(dt, f.t, ball, true);
      ghost.visible = !!f.racket;
      if (f.racket) {
        ghost.position.set(f.racket[0], f.racket[1], f.racket[2]);
        ghost.quaternion.set(f.racket[3], f.racket[4], f.racket[5], f.racket[6]);
      }
      if (replay.i >= replay.frames.length - 1) {
        replay = null;
        ghost.visible = false;
        setFooter(serverWord());
        opponent.placeAt(...([opponent.ground.x, opponent.ground.z] as [number, number]));
      }
    } else {
      // the physics, in fixed steps (what the opponent predicted is what happens)
      acc += dt;
      const n = Math.min(48, Math.floor(acc / STEP));
      acc -= n * STEP;
      for (let i = 0; i < n; i++) substep(i / n, (i + 1) / n);
      if (next && simT >= nextAt) {
        const fn = next;
        next = null;
        fn();
      }
      for (let i = later.length - 1; i >= 0; i--) if (simT >= later[i].at) later.splice(i, 1)[0].fn();
      opponent.update(dt, simT, ball, phase === "rally" || phase === "serveFlight" || phase === "oppServe" || phase === "youToss" || phase === "practice");
      if (phase !== "over" && phase !== "idle") record();
    }

    // the ball: in play, fading out after a point, back in the server's hand for the next
    const showBall = ballShown && (phase !== "over" || simT < nextAt - 0.5 || next === null) && phase !== "idle" && phase !== "feed";
    if (!replay) ballAlpha = THREE.MathUtils.clamp(ballAlpha + (showBall ? dt / 0.25 : -dt / 0.4), 0, 1);
    ballView.setAlpha(ballAlpha);
    ballView.update(ball, dt, eyeCourt);

    // words: the call over the net, the label over him, the hint in front of you, the scoreboard
    callText.opacity(THREE.MathUtils.clamp((callUntil - simT) / 0.4, 0, 1));
    callText.mesh.visible = simT < callUntil;
    callText.place(tmp.set(0, 2.5, -0.3), eyeCourt);
    label.set(labelText);
    label.place(tmp.copy(opponent.ground).setY(opponent.height + 0.5), eyeCourt);
    const hintText = phase === "youHold" ? (xr ? "Your serve: raise your left hand to toss, then hit it" : "Your serve: Space to toss, Space to hit") : "";
    hint.set(xr ? hintText : "");
    hint.place(tmp.set(playerCourt.x - 0.2, Math.max(1.1, eyeCourt.y - 0.45), playerCourt.z - 1.4), eyeCourt);
    drawBoard();

    // the laptop's view: behind you, the whole court ahead; your racket at your side, swinging when you swing
    deskRacket.visible = !xr;
    if (!xr && camView) {
      camera.position.copy(camView.p);
      camera.lookAt(camView.t);
    } else if (!xr) {
      camera.position.lerp(tmp.set(desk.x * 0.8, 2.15, desk.z + 3.6), Math.min(1, dt * 5));
      camera.lookAt(desk.x * 0.45, 0.9, -5);
      const ts = simT - desk.swingAt;
      const side = desk.swingSide;
      const swing = ts >= 0 && ts < 0.45 ? ts / 0.45 : -1;
      const a = swing < 0 ? 0 : Math.sin(swing * Math.PI);
      deskRacket.position.set(desk.x + side * (0.45 - 0.2 * a), 0.95 + 0.25 * a, desk.z - 0.15 - 0.4 * a);
      deskRacket.rotation.set(-0.3, side * (1.2 - 2.6 * Math.max(0, swing)), side * -1.1);
      if (phase === "youToss" || phase === "youHold") {
        deskRacket.position.set(desk.x + 0.35, 1.25, desk.z + 0.1);
        deskRacket.rotation.set(0.4, 0, -0.5);
      }
    }
    renderer.render(scene, camera);
  };
  renderer.setAnimationLoop(frame);

  drawBoard();
  setFooter("Loading your opponent…");
  void loadOpponent(opponentIds).then(() => {
    score.names = ["You", oppShort];
    $("#first").textContent = youFirst ? "You serve first" : `${oppShort} serves first`;
    if (!renderer.xr.isPresenting) newMatch();
  });

  if (import.meta.env.DEV)
    (window as unknown as Record<string, unknown>).__tennis = {
      renderer, scene, camera, court: courtGroup, room, ball, opponent, racket, hands, menu, board, desk, log, lock,
      score: () => score,
      state: () => ({ phase, server, deuce, serveNo, lastHitter, bounces, tape, simT: +simT.toFixed(3), incoming: incoming ? { C: incoming.C.toArray().map((v) => +v.toFixed(2)), t: +(incoming.t - simT).toFixed(2) } : null, player: playerCourt.toArray().map((v) => +v.toFixed(2)), court: courtGroup.position.toArray().map((v) => +v.toFixed(2)), lastShot: lastShotInfo && { kind: lastShotInfo.kind, speed: +lastShotInfo.speed.toFixed(1), assist: +lastShotInfo.assist.toFixed(2), target: lastShotInfo.target.toArray().map((v) => +v.toFixed(2)) }, lastOpp: lastOppShot, practice: practiceStats, opp: opponent.debug(), points: score.points, games: score.games, sets: score.sets }),
      swing: (k: "drive" | "lob" | "drop" = "drive") => deskSwing(k),
      pause: (on: boolean) => (paused = on),
      pose: (kind: string, tau: number, contact?: number[]) => {
        paused = true;
        const k = kind as "forehand";
        opponent.plan = null;
        opponent.stroke = { kind: k, tc: simT - tau, contact: contact ? new THREE.Vector3(...contact) : opponent.anim.contactOffset(k) };
        opponent.anim.resetFeet(opponent.ground, k);
      },
      view: (p: number[] | null, t?: number[]) => (camView = p ? { p: new THREE.Vector3(...p), t: new THREE.Vector3(...(t ?? [0, 1, 0])) } : null),
      setLevel, setFormat, setAssist, setGlide, setRoom, setFirst, newMatch, startReplay,
      frame,
      // run the match ahead without drawing (desktop checks): seconds of sim, with an optional per-step hook
      advance: (seconds: number, each?: () => void) => {
        const steps = Math.round(seconds / STEP);
        for (let i = 0; i < steps; i++) {
          substep(0, 1);
          if (next && simT >= nextAt) {
            const fn = next;
            next = null;
            fn();
          }
          if (i % 4 === 0) opponent.update(STEP * 4, simT, ball, true);
          each?.();
        }
      },
      pointTo: (w: Side) => endPoint(w, "", "test"),
      forceShot: (v: number[], w: number[]) => {
        ball.v.set(v[0], v[1], v[2]);
        ball.w.set(w[0], w[1], w[2]);
      },
      copyBall: () => copyBall(newBall(), ball),
    };
}
