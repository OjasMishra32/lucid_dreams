// Court Side (`?mode=court`): one real NBA moment at life size. renderCourt(root) loads the court bundle (`?bundle=`
// <court.json URL or folder>, else the stand-in in dev and /bundle/ from serve.mjs; `?show=small` / `?hz=90` pick a
// pre-built stream), builds every module, runs the immersive-ar session drawn opaque (required local-floor; optional
// anchors, hand-tracking, bounded-floor; requested here rather than through SparkXr, which ends a session on
// `visible-blurred` and would break the headset-off hand-over, P38), and drives the phase machine once per XR frame:
//   setup (until Seat here) -> arrival (black and room tone until the hand-over, the session not visible and then
//   visible again, and the seated head still 1 s: seat.arrival; then 2.5 s of lights-up) -> watching (pass 1, pass 2; Step into the court arms or takes an ease) -> easing
//   (the time stop) -> handoff (handoff(t) from F) -> open -> walking (Walk closer or standing up: the walking
//   anchoring; Next view) -> returning (through the room to the chair, re-seat, handback(t)) -> resume (through the
//   make) -> ended (Replay).
// See my room works in every phase; the edge fade runs every frame; every button, key and probe action is queued to
// the next frame, right after its head pose is read. A throw inside the frame is logged once and the loop keeps going
// (a stopped loop freezes the headset). `?stats` keeps the frame log; `?probe` (dev only) hands the loop to the e2e
// harness (probe.ts). Owned by the integrator only: streams export their pieces and the integrator wires them here.
import * as THREE from "three";
import { SparkRenderer } from "@sparkjsdev/spark";
import { handSides } from "../xr/menu";
import { XR_QUALITY } from "../xr/quality";
import { BUILT as CLOCK_BUILT, Clock, type ClockState } from "./clock";
import { loadCourt, type CourtBundle, type StreamFallback } from "./format";
import { BUILT as FREEZE_BUILT, Freeze } from "./freeze";
import { BACK_BEATS, BEATS, BUILT as HANDOFF_BUILT, HANDBACK_END, HANDOFF_END, handback, handoff, type HandoffParts } from "./handoff";
import { ARRIVAL_S, BUILT as LIGHT_BUILT, LightField, PART } from "./lightfield";
import { Probe, viewOf } from "./probe";
import { judgeRate, wantRate, type XrRate } from "./rate";
import { BUILT as PROXIES_BUILT, Proxies, layerVisibility } from "./proxies";
import { BUILT as SEAT_BUILT, PersistentLock, Seat } from "./seat";
import { BUILT as SEATMATH_BUILT, STAND_RISE, toCourt } from "./seatmath";
import { BUILT as SOUND_BUILT, Sound } from "./sound";
import { FrameStats } from "./stats";
import type { Head, Phase } from "./types";
import { BUILT as UI_BUILT, Ui, type UiAction } from "./ui";
import { BUILT as VIDEO_BUILT, ShowVideo } from "./video";
import { BUILT as VRHANDS_BUILT, VrHands } from "./vrhands";
import { BUILT as WORLD_BUILT, CourtWorld } from "./world";

/** The stand-in during development (scripts/court/standin.mjs writes it); serve.mjs serves a real bundle at /bundle/. */
const DEFAULT_BUNDLE = import.meta.env.DEV ? "/scripts/court/out/standin/" : "/bundle/";
/** The arrival's lights-up, once seat.arrival says the judge is in (3.2): the light field's own rise from black, long
 * enough to stay under 1 grey level a frame on white (P44), so the watch starts at full light. */
const LIGHTS_UP_S = ARRIVAL_S;
/** See my room fades out over 0.6 s and back over 0.8 s (P34). */
const ROOM_OUT_S = 0.6;
const ROOM_BACK_S = 0.8;
/** A head rise this big mid-fade finishes the video fade within 0.3 s (P10): in 0.25 s from the frame that sees it,
 * which leaves the frame or two before the rise is seen inside the bar. */
const RISE_FINISH = 0.1;
const RISE_FADE_S = 0.25;

export async function renderCourt(root: HTMLElement): Promise<void> {
  document.title = "Court Side · Lucid Dreams";
  root.innerHTML = `
    <div class="stage" id="court-stage"></div>
    <div class="topbar"><div></div>
      <div class="title"><div>Court Side</div><div class="subtitle" id="court-status">Loading the court</div></div><div></div></div>
    <div class="controls"><button class="cta" id="court-enter" disabled>Enter</button></div>`;
  const status = root.querySelector<HTMLElement>("#court-status")!;
  const enterButton = root.querySelector<HTMLButtonElement>("#court-enter")!;
  const params = new URLSearchParams(location.search);

  // ---------------- three + Spark (antialias off: MSAA + Spark hangs the Quest; no tone mapping: one grade) ----------------
  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.setClearColor(0x000000, 1);
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.xr.enabled = true;
  root.querySelector("#court-stage")!.appendChild(renderer.domElement);
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.05, 200);
  camera.position.set(0, 1.15, 0);
  const spark = new SparkRenderer({ renderer });
  scene.add(spark);
  /** Everything in court space; its transform is Seat.world (court -> room), written only by Seat. */
  const world = new THREE.Group();
  world.name = "court-world";
  scene.add(world);
  addEventListener("resize", () => {
    if (renderer.xr.isPresenting) return;
    renderer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  });

  const modules = {
    clock: CLOCK_BUILT, video: VIDEO_BUILT, proxies: PROXIES_BUILT, world: WORLD_BUILT, light: LIGHT_BUILT, freeze: FREEZE_BUILT,
    handoff: HANDOFF_BUILT, seatmath: SEATMATH_BUILT, seat: SEAT_BUILT, sound: SOUND_BUILT, vrhands: VRHANDS_BUILT, ui: UI_BUILT,
  };
  let stats: FrameStats | null = null; // made once the bundle says the display rate
  // the machine's state, declared before the probe so its snapshot can read it
  let phase: Phase = "arrival";
  let setup = true; // until Seat here
  let lightsUp = -1;
  let tF = 0; // seconds from F (the hand-off's clock)
  let tLight = 0; // seconds from F in real time: the light's, which a rushed fade never rushes (handoff's lightT, P44)
  let fed = -1; // the show frame this display frame handed the video and the proxies (-1 none)
  let tBack = 0; // seconds from the sit (the hand-back's clock)
  let inRoom = false;
  let roomP = 0;
  let reality = false;
  let clockState: ClockState | null = null;
  let videoRef: ShowVideo | null = null;
  let lightRef: LightField | null = null;
  let clockRef: Clock | null = null;
  let ballsRef: (() => Record<string, boolean>) | null = null;
  // the headset's display rate (rate.ts): what the session runs at and offers, what court.ts asked for, the verdict
  const xr: XrRate = { rate: null, supported: [], requested: null, showHz: 0, verdict: "unknown" };
  // every button, key and probe action waits for the top of the next XR frame (anchors need the XRFrame; one order)
  const queue: (() => void)[] = [];
  const actions = new Map<UiAction, () => void>();
  // the e2e harness, dev only (scripts/court/e2e.mjs runs through serve.mjs --dev)
  const probe = import.meta.env.DEV && params.has("probe") && params.get("probe") !== "headset" // ?probe=headset: real time, headset.ts
    ? new Probe(params.get("probe"), {
        snapshot: () => ({
          phase, setup, still: Number((seat.arrival.waited ?? -1).toFixed(3)), lightsUp: Number(lightsUp.toFixed(3)), tF: Number(tF.toFixed(3)), inRoom, roomP, reality,
          world: { position: [...seat.world.position], yaw: seat.world.yaw }, head: { room: [...head.room], court: [...head.court] },
          // what the e2e's wiring scenario reads: the seat's anchor and session, the dt it was handed, the hands' light
          wiring: { lock: seatLock instanceof PersistentLock ? "persistent" : "other", seatXr: seatLock.xr === renderer.xr, seatDt, hands: handsLevel },
          clock: clockState ?? { frame: -1, segment: "pass1", ease: null, speed: 0, nextEase: null, nextJump: null, armed: false, pass: 0, segmentFrame: 0 },
          onScreen: videoRef?.stats.onScreen ?? -1,
          fed, lightBeat: lightRef?.beat ?? "", lightT: Number((lightRef?.t ?? 0).toFixed(4)), mask: videoRef?.maskLevel ?? -1,
          xr: { ...xr, supported: [...xr.supported] }, xrHz: xr.rate ?? xr.showHz, clockHz: clockRef?.outputHz() ?? 0,
          balls: ballsRef?.() ?? {},
        }),
        seatHere: () => actions.get("seatHere")?.(),
        press: (action) => actions.get(action)?.(),
        modules,
        stats: () => stats,
        view: () => {
          if (!renderer.xr.isPresenting) return null;
          const xrCamera = renderer.xr.getCamera();
          return viewOf(xrCamera.cameras[0] ?? xrCamera, world, gl.drawingBufferWidth, gl.drawingBufferHeight);
        },
      })
    : null;

  // ---------------- the bundle (and the pre-built stream: ?show=small, ?hz=90) ----------------
  const bundleUrl = params.get("bundle") ?? DEFAULT_BUNDLE;
  const fallback: StreamFallback | null = params.get("hz") === "90" ? "hz90" : params.get("show") === "small" ? "small" : null;
  let bundle: CourtBundle;
  try {
    bundle = await loadCourt(bundleUrl, { fallback });
  } catch (e) {
    const msg = (e as Error).message;
    status.textContent = `No court bundle at ${bundleUrl}`;
    if (probe) probe.api.error = msg;
    console.error(`Court Side: ${msg}${import.meta.env.DEV ? "\n(make the stand-in: node apps/webxr/scripts/court/standin.mjs)" : ""}`);
    return;
  }
  const { court, frames } = bundle;
  const hz = court.video.displayHz;
  xr.showHz = hz;
  if (params.has("stats") || params.get("probe") === "timing" || params.get("probe") === "headset") stats = new FrameStats(gl, hz);
  // ?stats on the headset: remote devtools reads __courtStats.report() and __courtStats.xr (the display rate)
  if (stats) (window as unknown as { __courtStats?: FrameStats }).__courtStats = stats;

  // ---------------- the modules ----------------
  const clock = new Clock(court, frames);
  clockRef = clock;
  clockState = clock.state;
  const light = new LightField(court);
  lightRef = light;
  const video = new ShowVideo(renderer, bundle, { element: params.get("video") === "element" });
  videoRef = video;
  const proxies = new Proxies(renderer, bundle, video, light);
  const courtWorld = new CourtWorld(renderer, scene, world, bundle, light, proxies);
  const freeze = new Freeze(world, bundle, spark, light);
  const sound = new Sound(bundle);
  const hands = [renderer.xr.getHand(0), renderer.xr.getHand(1)];
  hands.forEach((h) => scene.add(h));
  const sideOf = handSides(hands);
  const vrHands = new VrHands(hands, scene);
  const ui = new Ui(scene, hands, sideOf, bundle);
  const seatLock = new PersistentLock(renderer, world); // persistent anchors, and the session's bounded-floor for Seat
  const seat = new Seat(court, frames, world, seatLock, params.has("seat") ? Number(params.get("seat")) : undefined);
  world.add(proxies.group);
  const parts: HandoffParts = { video, proxies, world: courtWorld, freeze, sound, light };
  // what draws a ball this frame (the e2e's ball scenario): the ball's card on the video layer, the 3D's own sphere,
  // the holder's splats (freeze.ballInBody); and the holder's card, which the ball's goes with
  const drawn = (o: THREE.Object3D | undefined): boolean => {
    for (let x: THREE.Object3D | null | undefined = o; x; x = x.parent) if (!x.visible) return false;
    return !!o;
  };
  const holder = court.freeze.ballInBody ?? court.freeze.ball.erase[0]?.player ?? court.freeze.players[0]?.id ?? "";
  ballsRef = () => {
    const on = video.stats.onScreen;
    const here = on >= 0 ? bundle.cards[on]?.cards ?? [] : [];
    const cardsUp = layerVisibility(video.opacity, video.maskLevel).cards;
    const ballCardHere = here.some((c) => c.kind === "ball");
    return {
      ballCardHere, card: cardsUp && ballCardHere, holderCard: cardsUp && here.some((c) => c.id === holder),
      sphere: drawn(scene.getObjectByName("court-ball")),
      body: !!court.freeze.ballInBody && drawn(scene.getObjectByName(`court-freeze-${court.freeze.ballInBody}`)),
    };
  };
  // the textures follow the clock's frame every display frame from the watch on, the freeze included (stream D): a held
  // F still goes up once it decodes, and See my room's jump to F can't leave an earlier frame on the video or proxies
  const feed = (frame: number) => {
    video.show(frame);
    proxies.project(frame);
    fed = frame;
  };
  // ?probe=headset (dev only, never built in): the real headset's telemetry, posted to serve.mjs --dev every 2 s (headset.ts)
  const headset = import.meta.env.DEV && params.get("probe") === "headset"
    ? new (await import("./headset")).HeadsetTelemetry({
        bundle, phase: () => phase, inRoom: () => inRoom, clock: () => clockState, onScreen: () => video.stats.onScreen, video: () => video.stats,
        splats: () => spark.activeSplats, xr: () => xr, session: () => renderer.xr.getSession(), stats: () => stats?.report() ?? null,
      })
    : null;
  headset?.start();
  await Promise.all([video.load(), proxies.load(), courtWorld.load(), freeze.load(), sound.load()]);
  // ?splats=<n> (dev only): at most n splats per body, the most important first, to find the frame budget live (splatcap.ts)
  if (import.meta.env.DEV && params.has("splats"))
    await import("./splatcap").then((m) => console.info("Court Side ?splats:", m.capSplats(scene, Number(params.get("splats"))))).catch((e: unknown) => console.error("Court Side ?splats:", e));

  // ---------------- the machine ----------------
  const head: Head = { room: [0, 1.15, 0], court: [0, 1.15, 0], yaw: 0, quaternion: [0, 0, 0, 1] };
  const lastHead = new THREE.Vector3();
  const headPos = new THREE.Vector3();
  const headQ = new THREE.Quaternion();
  const euler = new THREE.Euler();
  let seatedEyeY = 1.15;
  let rushed = false; // the head rose mid-fade: the fade finishes within RISE_FADE_S
  let rushRate = 1; // then the hand-off's seconds per real second, latched at the rise (a straight line to the fade's end)
  let restored = false; // Back to my seat: the chair reached and the world re-seated
  let handsLevel = 0; // the light the drawn hands were last given
  let seatDt = 0; // the dt seat.update was last handed
  const flags = () => ({ inRoom, reality, setup, nextView: seat.hasNextView() });
  const go = (next: Phase) => {
    phase = next;
    ui.setPhase(phase, flags());
  };
  const on = (action: UiAction, fn: () => void) => {
    const queued = () => queue.push(fn);
    actions.set(action, queued);
    ui.on(action, queued);
  };
  on("seatHere", () => {
    seat.place(head, head.yaw);
    // ?solo: one person tests alone, so there is no hand-over to wait for (the seated, still head still gates it)
    if (params.has("solo")) seat.arrival.handedOver = true;
    seatedEyeY = head.room[1];
    setup = false;
    lightsUp = -1; // seat.place re-arms seat.arrival: dark until the next hand-over
    light.set("dark", 0);
    go("arrival");
  });
  on("step", () => {
    if (phase !== "watching") return;
    clock.press();
    sound.oneShot("stepIn");
  });
  on("closer", () => {
    if (phase !== "open" && phase !== "walking") return;
    seat.closer();
    go("walking");
  });
  on("nextView", () => {
    if (phase === "walking") seat.nextView();
  });
  on("back", () => {
    if (phase !== "open" && phase !== "walking") return;
    inRoom = true; // back to the chair always goes through the room (3.5)
    restored = false;
    tBack = 0;
    go("returning");
  });
  on("reality", () => {
    reality = !reality;
    courtWorld.reality(reality);
    proxies.reality(reality);
    freeze.reality(reality);
    ui.setPhase(phase, flags());
  });
  // the show from the top (Replay, Change seat): back to the dolly seat if the world is open, the picture back over the
  // 3D, the hush lifted, the clocks and the light at the start of the watch
  const restart = () => {
    if (phase === "open" || phase === "walking" || phase === "returning") seat.restore();
    video.opacity = 1;
    video.mask(0); // the watch's edge (1 is lifted)
    video.wipe(0);
    freeze.reveal(0);
    courtWorld.open(0);
    light.set("watch", 0);
    sound.release();
    tF = 0;
    tLight = 0;
    tBack = 0;
    rushed = false;
    restored = false;
    clock.restart();
  };
  // Replay, on the menu in every phase after the arrival (3.6): the watch from pass 1
  on("replay", () => {
    if (setup || phase === "arrival") return;
    restart();
    go("watching");
  });
  // Change seat (the presenter, between judges): back to the setup page, the show stopped on its first frame and the
  // world on its anchor until the next Seat here, which takes a new seat and waits for the next hand-over (seat.arrival)
  on("changeSeat", () => {
    if (setup) return;
    restart();
    feed(court.video.segments.pass1[0]);
    setup = true;
    lightsUp = -1;
    go("arrival");
  });
  // See my room, per phase (3.6): arrival replays the lights-up on the way back; watching holds the clock and restarts
  // pass 1 on the way back; mid-ease or mid-hand-off jumps to F and finishes the hand-off under the fade
  const toggleRoom = () => {
    if (phase === "returning" && !restored) return; // the walk back to the chair stays in the room until the sit
    inRoom = !inRoom;
    if (!inRoom && phase === "arrival" && lightsUp >= 0) lightsUp = 0;
    if (!inRoom && phase === "watching") clock.restart();
    if (inRoom && (phase === "easing" || phase === "handoff")) {
      clock.jumpToFreeze();
      sound.timeStop(1); // landed on F: the full hush (it lifts only on the resume)
      tF = HANDOFF_END;
      tLight = HANDOFF_END;
      handoff(tF, parts);
      go("open");
    }
    ui.setPhase(phase, flags());
  };
  on("room", toggleRoom);
  ui.onToggleRoom = () => queue.push(toggleRoom);

  const step = (dt: number) => {
    fed = -1;
    // See my room, in every phase
    roomP = Math.min(1, Math.max(0, roomP + (inRoom ? dt / ROOM_OUT_S : -dt / ROOM_BACK_S)));
    courtWorld.room(roomP);
    sound.room(roomP);
    vrHands.fade(roomP);
    courtWorld.edge(seat.boundsDistance(head));
    // the drawn hands take the arena's light where the judge is: dark through the arrival's hold, up with the lights-up
    const arrive = setup ? 1 : phase === "arrival" ? (lightsUp < 0 ? 0 : Math.min(1, lightsUp / LIGHTS_UP_S)) : 1;
    handsLevel = arrive * light.at(head.court[0], head.court[2], PART.person);
    vrHands.light(handsLevel);
    if (setup) return;
    switch (phase) {
      case "arrival": {
        // the hand-over, then a seated head still for 1 s (seat.arrival, P27, P38)
        if (lightsUp < 0) {
          if (seat.arrival.update(dt, head.room)) lightsUp = 0;
        } else lightsUp += dt;
        const p = Math.max(0, Math.min(1, lightsUp / LIGHTS_UP_S));
        light.set(lightsUp < 0 ? "dark" : "arrival", Math.max(0, lightsUp));
        sound.arrive(p);
        // the lit footage region rises out of black on pass 1's first frame (3.2), so the watch starts on a frame shown
        const first = court.video.segments.pass1[0];
        feed(first);
        video.wipe(1 - p);
        if (lightsUp >= LIGHTS_UP_S) {
          light.set("watch", 0);
          video.wipe(0);
          go("watching");
        }
        break;
      }
      case "watching":
      case "easing":
      case "resume": {
        if (!(inRoom && phase !== "resume")) clockState = clock.update(dt); // the clock holds in the room (3.6)
        const s = clock.state;
        feed(s.frame);
        // the rendered court's darkness follows the pan: the frame on screen (the clock's until the player reports one)
        courtWorld.frame(video.stats.onScreen >= 0 ? video.stats.onScreen : s.frame);
        video.prime(s.nextJump);
        const hush = 1 - s.speed / court.video.pass2Speed; // 0 at pass 2's speed, 1 frozen
        if (phase === "watching" && s.segment === "ease") go("easing");
        if (phase === "easing") {
          const ease = s.ease !== null ? court.video.segments.eases[s.ease] : null;
          tF = ease ? -(ease.frames[1] - s.frame) / hz : 0; // seconds to F
          light.set("ease", ease ? ease.seconds + tF : 0);
          sound.timeStop(Math.max(0, Math.min(1, hush)));
          if (tF >= BEATS.splatsUp[0]) handoff(tF, parts); // the splats come up under the picture before F
        }
        if (phase === "easing" && s.segment === "freeze") {
          tF = 0;
          tLight = 0;
          rushed = false;
          go("handoff");
        }
        if (phase === "resume") {
          light.set("resume", tBack);
          tBack += dt;
          if (s.segment === "ended") go("ended");
        }
        break;
      }
      case "handoff": {
        feed(clock.state.frame);
        const [, fadeEnd] = BEATS.videoFades;
        // rushed: whatever is left of the fade plays out in RISE_FADE_S, at the rate latched at the rise (P10); the
        // light keeps the unrushed time
        if (!rushed && head.room[1] - seatedEyeY > RISE_FINISH && tF < fadeEnd) {
          rushed = true;
          rushRate = (fadeEnd - tF) / RISE_FADE_S;
        }
        tF += rushed && tF < fadeEnd ? Math.max(dt, rushRate * dt) : dt;
        tLight += dt;
        handoff(tF, parts, tLight);
        if (tF >= HANDOFF_END) go("open");
        break;
      }
      case "open":
      case "walking":
        feed(clock.state.frame);
        freeze.update(head, dt);
        // a rushed fade opened the world early: the light's hand-off beat runs on in its own time to its end
        if (tLight < HANDOFF_END) {
          tLight = Math.min(HANDOFF_END, tLight + dt);
          light.set("handoff", tLight);
        }
        break;
      case "returning": {
        feed(clock.state.frame);
        freeze.update(head, dt);
        if (!restored && seat.seated(head)) {
          seat.restore(); // the chair back at the dolly seat, behind the room
          restored = true;
          inRoom = false;
          tBack = BACK_BEATS.videoReturns[0];
          ui.setPhase(phase, flags());
        }
        if (restored) {
          tBack += dt;
          handback(tBack, parts);
          if (tBack >= HANDBACK_END) {
            clock.resume();
            tBack = 0;
            go("resume");
          }
        } else light.set("return", tBack);
        break;
      }
      case "ended":
        break;
    }
    sound.update(head, clock.state, seat.world); // the crowd turns with the court; the hush lifts only on the resume (sound.ts)
    // standing up in the open world jumps to the walking anchoring, as Walk closer does (3.4)
    if (head.room[1] - seatedEyeY > STAND_RISE && phase === "open") {
      seat.closer();
      go("walking");
    }
  };

  // the bounds in court space for the freeze (See my room keeps the extras whose feet are inside them, P34), sent again
  // only when the bounds or the world's placement change
  let sentBounds: unknown = undefined;
  const sentPose = [NaN, NaN, NaN, NaN];
  const syncBounds = () => {
    const b = seat.bounds;
    const [x, y, z] = seat.world.position;
    if (b === sentBounds && x === sentPose[0] && y === sentPose[1] && z === sentPose[2] && seat.world.yaw === sentPose[3]) return;
    sentBounds = b;
    sentPose.splice(0, 4, x, y, z, seat.world.yaw);
    freeze.bounds(b ? b.map(([bx, bz]) => {
      const c = toCourt(seat.world, [bx, 0, bz]);
      return [c[0], c[2]] as [number, number];
    }) : null);
  };

  // ---------------- the frame loop ----------------
  const loopErrors = new Set<string>();
  const logOnce = (e: unknown) => {
    const msg = String(e);
    if (loopErrors.has(msg)) return;
    loopErrors.add(msg);
    probe?.api.errors.push(msg);
    console.error("Court Side frame:", e);
  };
  let lastTime = -1;
  let frameStart = 0;
  const onFrame = (time: number) => {
    // probed, every XR frame is one period of the headset's rate (the session's, else the show's), as on a headset
    const dt = probe ? probe.dt(xr.rate ?? hz) : lastTime < 0 ? 0 : Math.min(0.1, (time - lastTime) / 1000);
    const interval = lastTime < 0 ? 0 : time - lastTime;
    lastTime = time;
    const eye = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
    lastHead.copy(headPos);
    eye.getWorldPosition(headPos);
    eye.getWorldQuaternion(headQ);
    euler.setFromQuaternion(headQ, "YXZ");
    head.room = [headPos.x, headPos.y, headPos.z];
    head.court = toCourt(seat.world, head.room);
    head.yaw = euler.y;
    head.quaternion = [headQ.x, headQ.y, headQ.z, headQ.w];
    // the queued actions, with this frame's head (Seat here takes it); one action's throw never costs the frame its
    // step (the fades and the clock keep their display-frame timing)
    for (const fn of queue.splice(0)) {
      try {
        fn();
      } catch (e) {
        logOnce(e);
      }
    }
    if (renderer.xr.isPresenting) {
      seatDt = dt; // the frame's own dt (the e2e reads what Seat was handed)
      seat.update(seatDt, head); // the only writer of the world group (seat.ts), with the fade-jump veil
      syncBounds();
      vrHands.update();
      ui.update(head, time, dt);
    }
    courtWorld.update(head);
    step(dt);
    stats?.gpu.begin(phase);
    renderer.render(scene, camera);
    stats?.gpu.end();
    stats?.frame(phase, interval, performance.now() - frameStart);
    headset?.frame(interval);
  };
  renderer.setAnimationLoop((time) => {
    if (probe && !probe.run()) return; // the capture's lockstep: only the frames it steps (probe.ts)
    frameStart = performance.now();
    try {
      onFrame(time);
    } catch (e) {
      logOnce(e);
    } finally {
      // even after a throw, so the e2e sees the frame (and the error) instead of waiting for it
      if (renderer.xr.isPresenting) probe?.afterRender(gl, performance.now() - frameStart);
    }
  });

  // ---------------- the session ----------------
  const xrSystem = navigator.xr;
  const supported = xrSystem ? await xrSystem.isSessionSupported("immersive-ar").catch(() => false) : false;
  enterButton.disabled = !supported;
  status.textContent = supported ? court.title : "This browser has no immersive AR";
  if (probe) probe.api.ready = supported;
  let session: XRSession | null = null;
  // the show's own display rate when the headset offers it (rate.ts): the clock shows one show frame per XR frame only
  // there. A headset that can't run it takes the 90 Hz bake when the bundle has one (a reload on the setup page);
  // otherwise the clock's cadence keeps the show's time, and the console and ?stats say so
  const hz90 = fallback === "hz90" ? null : court.video.fallbacks?.hz90?.displayHz ?? null;
  // at the session's start (after the request) and on every frameratechange: the clock's cadence takes the session's
  // rate at once (clock.ts setOutputHz), so the show keeps real time through any change
  const judge = (s: XRSession) => {
    xr.rate = s.frameRate ?? null;
    xr.verdict = judgeRate(hz, xr.rate, xr.supported, hz90);
    clock.setOutputHz(xr.rate);
    if (stats) stats.xr = { ...xr, supported: [...xr.supported] };
    if (xr.verdict === "mismatch") console.warn(`Court Side: the headset runs at ${xr.rate} Hz, the show is baked for ${hz} Hz (offered: ${xr.supported.join(", ") || "none"}): the clock's cadence holds some show frames for two XR frames`);
  };
  const matchRate = async (s: XRSession) => {
    xr.supported = s.supportedFrameRates ? Array.from(s.supportedFrameRates) : [];
    const want = wantRate(hz, xr.supported);
    if (want !== null && s.frameRate !== want && typeof s.updateTargetFrameRate === "function") {
      xr.requested = want;
      await s.updateTargetFrameRate(want).catch((e: unknown) => console.warn(`Court Side: the headset would not run at ${want} Hz:`, e));
    }
    judge(s);
    if (xr.verdict === "hz90" && setup) {
      status.textContent = `This headset can't run ${hz} Hz: loading the 90 Hz show`;
      const url = new URL(location.href);
      url.searchParams.set("hz", "90");
      await s.end().catch(() => {});
      location.replace(url);
    }
  };
  const enter = async () => {
    if (!xrSystem || session) return;
    renderer.xr.setReferenceSpaceType("local-floor");
    renderer.xr.setFramebufferScaleFactor(XR_QUALITY.res);
    renderer.xr.setFoveation(XR_QUALITY.fov);
    const s = await xrSystem.requestSession("immersive-ar", {
      requiredFeatures: ["local-floor"],
      optionalFeatures: ["anchors", "hand-tracking", "bounded-floor"],
    });
    session = s;
    // the session is kept through `visible-blurred` and `hidden` (headset off, the system menu): only its end ends it
    s.addEventListener("visibilitychange", () => seat.arrival.visibility(s.visibilityState)); // the hand-over (P27, P38)
    s.addEventListener("frameratechange", () => judge(s));
    s.addEventListener("end", () => {
      session = null;
      status.textContent = court.title;
    });
    await renderer.xr.setSession(s);
    await matchRate(s);
    scene.background = null;
    lastTime = -1;
    if (setup) go("arrival"); // a re-entry after Seat here keeps the phase, the anchor and the seat (9)
    // ?solo: take the seat where the head is once tracking settles, instead of waiting for a Seat here press
    if (setup && params.has("solo")) setTimeout(() => actions.get("seatHere")?.(), 1500);
    status.textContent = "In the headset";
  };
  enterButton.addEventListener("click", () => {
    sound.start(); // inside the tap: the audio context may start
    enter().catch((e: unknown) => {
      status.textContent = `Could not enter: ${String(e)}`;
      console.error("Court Side session:", e);
    });
  });

  // production (served by serve.mjs): the Service Worker keeps the page and the bundle for a cable-off reload (P37);
  // it takes over after this load, so it's handed the files this load already fetched
  if (!import.meta.env.DEV && "serviceWorker" in navigator)
    navigator.serviceWorker
      .register("/court-sw.js")
      .then(() => navigator.serviceWorker.ready)
      .then((reg) => reg.active?.postMessage({ type: "cache", urls: [location.href, ...performance.getEntriesByType("resource").map((e) => e.name)] }))
      .catch(() => {}); // served without serve.mjs (vite preview): no worker, no cable-off reload
}
