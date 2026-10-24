import * as THREE from "three";
import { SparkRenderer, type SplatMesh } from "@sparkjsdev/spark";
import { WorldLock } from "../xr/anchor";
import { XrButton } from "../xr/hands";
import { HandMenu, handSides } from "../xr/menu";
import { XR_QUALITY } from "../xr/quality";
import { buildSyntheticFreeze, loadDreamFreeze, splatCount, type Person } from "./people";
import { makeSet } from "./scene";
import { Hud, type ResultsView } from "./hud";
import { handDots } from "./vrhands";
import { makeVideoScreen, type VideoStat } from "./video";
import { dropped, heapMB, snapRate, summarize } from "./stats";
import { EASE_FROM_FRAME, StreamPlayer, VideoLayer, configOf, loadStream, probeDecoders, videoQuad, type LayerStats, type Probe, type Stream } from "./webcodecs";
import { SortWatch } from "./sortwatch";
import { GpuTimer } from "./gputimer";
import { AnchorTest, Features, OPTIONAL_FEATURES, VisibilityLog, checkSpaces, setRate, type Boundary, type RateCheck, type SpaceCheck } from "./xrchecks";
import { RoomFade } from "./room";
import { EDGE_FULL_M, EDGE_START_M, EdgeFade, makeCurtain } from "./edge";
import { AnswerPanel, QUESTIONS, type Answers, type PanelView } from "./answers";
import type { XRDevice } from "iwer";

declare global {
  interface Window {
    __xrDevice?: XRDevice;
    __spikeScreenshot?: (name: string) => Promise<string>;
    __spikeResult?: unknown;
  }
}

// "vr": immersive-vr. "ar-opaque": immersive-ar with everything drawn fully opaque, so it looks like VR until
// "See my room" fades the arena and the clear alpha to 0 and the passthrough shows.
export type Mode = "vr" | "ar-opaque";
const SESSION_MODE: Record<Mode, XRSessionMode> = { vr: "immersive-vr", "ar-opaque": "immersive-ar" };

type Phase = {
  key: string;
  name: string;
  short: string;
  hint: string;
  video: boolean;
  splats: "none" | "freeze" | "big";
  walk: boolean;
  fade: boolean; // video fades out while the 3D pair fades in
  seconds: number;
  custom: boolean; // a v2 phase, driven by drive()
};

export type FrameInfo = { stage: number; key: string; stageElapsed: number; head: THREE.Vector3; time: number };

type Tally = { max: number; sum: number; n: number };
type PhaseStats = {
  intervals: number[];
  cpu: number[];
  gpu: number[];
  visible: Tally; // splats in visible meshes
  drawn: Tally; // splats Spark actually draws (its last sort's active count)
  videoStats: VideoStat | null;
  heap: number | null;
  wc: LayerStats | null;
  decodeMs: number[];
  marks: Record<string, number>; // frame number within the phase of a switch or a reveal
  sub: Record<string, number[]>; // the room phase, split by what is showing
  edgeFrames: number; // AR-opaque: frames the edge fade let the room in
};

type Run = {
  mode: Mode;
  phases: Phase[];
  stage: number; // -1 settling, 0..phases.length-1 the phases, phases.length done
  stageStart: number;
  skip: boolean;
  lastTime: number | null;
  prevStage: number;
  prevSub: Sub;
  settleFrames: number;
  stats: PhaseStats[];
  warm: number[]; // the unmeasured settle's frame intervals
  videoBase: { decoded: number; dropped: number };
  placed: boolean;
  eye: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  interrupted: string | null; // the session left "visible" (headset off, system menu) while phases ran
  answers: Answers;
  qIndex: number; // the boundary question on show
};

type SessionInfo = {
  mode: Mode;
  spaces: SpaceCheck;
  rate: RateCheck | null;
  anchors: AnchorTest;
  vis: VisibilityLog;
  blend: string | null;
  features: Features;
  boundary: Boundary | null;
};

// one line per phase of a finished run, kept per mode (and in localStorage) for the VR vs AR-opaque table
type ModeSummary = {
  mode: Mode; savedAt: string; thisPage: boolean; hz: number; edge: string; answers: Answers;
  phases: { key: string; short: string; fr50: number; fr95: number; drop: number; gpu50: number | null }[];
};

type Sub = "none" | "opaque" | "room" | "fade";
const SUBS: Sub[] = ["none", "opaque", "room", "fade"];

const q = new URLSearchParams(location.search);
const emulate = import.meta.env.DEV && q.has("emulate");
const selftest = emulate && q.has("selftest");
const num = (name: string, fallback: number) => (q.has(name) && Number.isFinite(Number(q.get(name))) ? Number(q.get(name)) : fallback);
const PHASE_S = num("phaseS", selftest ? 2 : 12);
const SETTLE_S = selftest ? 1 : 4;
const TARGET_HZ = num("hz", 72);
const FREEZE_SPLATS = num("per", 250000); // synthetic people: splats per player in the freeze frame
const BIG_SPLATS = num("big", 400000);
const HANDOFF_S = 2;
const FADE_S = 0.6; // "See my room" fades out and back over this
const AFTER = 36; // display frames after a switch or a reveal that count as "at" it (0.5 s at 72 Hz)
// the v2 phases' timing (the desktop self-test runs them shorter; its splats are hidden < 3 s before the reveals)
const S = selftest
  ? { wc: 3, switchMin: 0.5, switchCap: 12, coldPre: 1, coldPost: 1.5, warmHidden: 1, warmUnder: 1, warmPost: 1.5, roomEdge: 0.5, roomHold: 1.2 }
  : { wc: 10, switchMin: 0.5, switchCap: 15, coldPre: 3, coldPost: 3, warmHidden: 3.5, warmUnder: 2, warmPost: 3, roomEdge: 1, roomHold: 3 };
const CLEAR = new THREE.Color(0x03050a);
const SAVE_KEY = "s6-quest-v2-last";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const round = (v: number, d = 2) => Number(v.toFixed(d));
const fmtK = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : `${Math.round(n / 1000)}k`);
const f1 = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? "-" : v.toFixed(1));
const yn = (v: boolean | null | undefined) => (v === null || v === undefined ? "?" : v ? "yes" : "no");
const yesNo = (v: boolean | "skip" | undefined) => (v === undefined ? "-" : v === "skip" ? "skip" : v ? "YES" : "NO");
const smooth = (t: number) => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};
const freshTally = (): Tally => ({ max: 0, sum: 0, n: 0 });
const freshStats = (): PhaseStats => ({
  intervals: [], cpu: [], gpu: [], visible: freshTally(), drawn: freshTally(), videoStats: null, heap: null, wc: null, decodeMs: [], marks: {}, sub: {}, edgeFrames: 0,
});
const pushSub = (st: PhaseStats, key: string, v: number) => (st.sub[key] ??= []).push(v);
const heldWithin = (wc: LayerStats | null, from: number) => (wc ? wc.heldAt.filter((f) => f >= from && f < from + AFTER).length : null);

async function start() {
  const status = $("#status");
  const report = $("#report");
  try {
    const saved = localStorage.getItem(SAVE_KEY);
    if (saved) report.textContent = `Saved from the last run (${(JSON.parse(saved) as { savedAt: string }).savedAt}):\n${(JSON.parse(saved) as { text: string }).text}\n\n`;
  } catch {
    // no storage (private window): nothing to show
  }
  let device: XRDevice | undefined;
  if (emulate) {
    const { XRDevice, metaQuest3 } = await import("iwer");
    device = new XRDevice(metaQuest3);
    device.installRuntime({ forceInstall: true });
    device.primaryInputMode = "hand";
    device.position.set(0, 1.6, 0);
    window.__xrDevice = device;
  }

  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.setClearColor(CLEAR, 1); // VR and AR-opaque alike: nothing shows through until "See my room"
  renderer.xr.enabled = true;
  document.body.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.05, 100);
  const enableLod = !q.has("nolod");
  // the viewer's own SparkRenderer options (the default), so the number is the viewer's number
  const spark = new SparkRenderer({ renderer, enableLod });
  scene.add(spark);
  const watch = new SortWatch(spark);
  const gpu = new GpuTimer(renderer.getContext() as WebGL2RenderingContext);

  const set = makeSet(renderer, true);
  scene.add(set.court);
  const courtLock = new WorldLock(renderer, set.court);
  const hud = new Hud();
  scene.add(hud.group);
  const hudLock = new WorldLock(renderer, hud.group);

  const hands = [renderer.xr.getHand(0), renderer.xr.getHand(1)];
  const sideOf = handSides(hands);
  hands.forEach((hand) => scene.add(hand));
  // both modes draw the arena opaque, so hands are drawn too (dots on the joints)
  const handUpdate = handDots(hands, scene);
  const menu = new HandMenu(hands, sideOf, scene);

  // ---------------- people, video ----------------
  const idA = q.get("a");
  const idB = q.get("b");
  const people: Person[] = []; // the freeze pair
  const bigs: Person[] = []; // the 400k synthetic pair (phase 3)
  const screen = makeVideoScreen(q.get("video"));
  set.court.add(screen.mesh);
  let videoError: string | null = null;

  // WebCodecs: the window (camera-sized, 60 x 34 degrees, 6 m from the seat, behind the players) and the veil (close in
  // front of the seat, covering the players, drawn over the splats) share one VideoFrameTexture
  const layer = new VideoLayer(renderer);
  const wcWindow = videoQuad(2 * 6 * Math.tan(THREE.MathUtils.degToRad(30)), layer.texture, false);
  wcWindow.position.set(0, 1.6 - 6 * Math.tan(THREE.MathUtils.degToRad(5)), -1.6 + 6);
  wcWindow.rotation.y = Math.PI; // faces the seat
  const wcVeil = videoQuad(3.6, layer.texture, true);
  wcVeil.position.set(0.15, 1.2, -0.9);
  wcVeil.rotation.y = Math.PI;
  set.court.add(wcWindow, wcVeil);
  const wc = {
    probes: [] as Probe[], pick: null as Probe | null, main: null as Stream | null, ease: null as Stream | null, error: null as string | null,
    A: null as StreamPlayer | null, B: null as StreamPlayer | null, aFirstMs: null as number | null, aLimitRaised: false, errors: [] as string[],
    // the press: display frame (within the switch phase) that showed the ease's first frame, its readiness, and the
    // display frame (within the next phase) that went back to the main stream
    sw: { at: -1, bReady: 0, bFirstMs: null as number | null, easeDoneAt: null as number | null, easeShown: 0, back: -1 },
    revealed: { cold: false, under: false, warm: false },
  };
  const wcConfig = () => (wc.pick ? configOf(wc.pick, wc.pick.hardware ? "prefer-hardware" : "no-preference") : null);
  const loadWc = async () => {
    wc.probes = await probeDecoders();
    const want = q.get("wc"); // ?wc=1080 forces the 1080p fallback stream
    const usable = wc.probes.filter((p) => p.supported && (!want || p.stream === want));
    wc.pick = usable.find((p) => p.hardware) ?? usable[0] ?? null; // a software 1440p decoder is not the headset's answer
    if (!wc.pick) throw new Error("no H.264 decoder config supported");
    [wc.main, wc.ease] = await Promise.all([loadStream(wc.pick.stream), loadStream(`${wc.pick.stream}-ease`)]);
  };
  const resetWc = () => {
    for (const p of [wc.A, wc.B]) {
      if (p) wc.errors.push(...p.errors);
      p?.close();
    }
    wc.A = wc.B = null;
    layer.dispose();
    wcWindow.visible = wcVeil.visible = false;
    wc.sw = { at: -1, bReady: 0, bFirstMs: null, easeDoneAt: null, easeShown: 0, back: -1 };
    wc.revealed = { cold: false, under: false, warm: false };
  };

  const load = async () => {
    const wcReady = loadWc().catch((e: unknown) => void (wc.error = String(e).slice(0, 160)));
    if (idA && idB) {
      status.textContent = `Loading freeze frames of ${idA} and ${idB}`;
      people.push(await loadDreamFreeze(idA, q.get("freezeA"), set.rootA));
      people.push(await loadDreamFreeze(idB, q.get("freezeB"), set.rootB));
    } else {
      status.textContent = "Building synthetic people";
      people.push(await buildSyntheticFreeze(false, FREEZE_SPLATS, set.rootA, "freeze"));
      people.push(await buildSyntheticFreeze(true, FREEZE_SPLATS, set.rootB, "freeze"));
    }
    bigs.push(await buildSyntheticFreeze(false, BIG_SPLATS, set.rootA, "big"));
    bigs.push(await buildSyntheticFreeze(true, BIG_SPLATS, set.rootB, "big"));
    status.textContent = "Loading the test videos";
    videoError = await screen.ready;
    await wcReady;
  };
  const pairLabel = (pair: Person[]) => `2x${fmtK(pair.reduce((sum, p) => sum + splatCount(p.freeze), 0) / pair.length)}`;
  let freezeLabel = "";
  let bigLabel = "";

  // AR-opaque's "See my room": everything in the set fades except the people, the ball and the video layers
  const room = new RoomFade(renderer, set.court, (o) => o === set.ball || o === set.rootA || o === set.rootB || o === screen.mesh || o === wcWindow || o === wcVeil, CLEAR);
  // AR-opaque's opacity comes from geometry: a black sphere under everything (three clears alpha-blend to transparent)
  const curtain = makeCurtain();
  scene.add(curtain);
  const curtainMaterial = curtain.material as THREE.MeshBasicMaterial;
  const edge = new EdgeFade();
  let phaseRoom = 1; // the room phase's own fade (1 outside it)

  // ---------------- what is on show ----------------
  const sets = { none: [] as SplatMesh[], freeze: [] as SplatMesh[], big: [] as SplatMesh[] };
  let shown: SplatMesh[] = [];
  let visibleNow = 0;
  let splatOpacity = 1;
  const present = (video: boolean, splats: keyof typeof sets, opacity: { video: number; splats: number }) => {
    screen.set(video, opacity.video);
    const want = sets[splats];
    if (want !== shown) {
      shown.forEach((m) => (m.visible = false));
      want.forEach((m) => {
        m.visible = true;
        m.opacity = opacity.splats;
      });
      shown = want;
      splatOpacity = opacity.splats;
      visibleNow = want.reduce((sum, m) => sum + splatCount(m), 0);
      set.ball.visible = want.length > 0;
    } else if (splatOpacity !== opacity.splats) {
      splatOpacity = opacity.splats;
      shown.forEach((m) => (m.opacity = opacity.splats));
    }
  };
  const full = { video: 1, splats: 1 };
  const freezeCount = () => sets.freeze.reduce((sum, m) => sum + splatCount(m), 0);

  // ---------------- run state ----------------
  let session: XRSession | null = null;
  let info: SessionInfo | null = null;
  let run: Run | null = null;
  let hudHidden = false;
  const runs: unknown[] = [];
  const latest = () => ({ ...(runs[runs.length - 1] as object), runs });

  const phasesFor = (mode: Mode): Phase[] => {
    const base = { video: false, splats: "none" as const, walk: false, fade: false, seconds: PHASE_S, custom: false };
    const wcName = wc.pick ? `WebCodecs ${wc.pick.label} 72 fps` : "WebCodecs (unsupported)";
    const list: Phase[] = [
      { ...base, key: "video", name: "Video 720p", short: "Video", hint: "Stand still and watch", video: true },
      { ...base, key: "freeze", name: `Freeze ${freezeLabel}`, short: `Frz ${freezeLabel.slice(2)}`, hint: "Stand still and look at them", splats: "freeze" },
      { ...base, key: "freeze-big", name: `Freeze ${bigLabel}`, short: `Frz ${bigLabel.slice(2)}`, hint: "Stand still and look at them", splats: "big" },
      { ...base, key: "freeze-walk", name: `Freeze ${freezeLabel} + walk`, short: "Walk", hint: "Walk slowly around them", splats: "freeze", walk: true },
      { ...base, key: "handoff", name: "Video to 3D", short: "Handoff", hint: "Watch the video hand off to the 3D pair", video: true, splats: "freeze", fade: true, seconds: HANDOFF_S },
      { ...base, custom: true, key: "wc", name: wcName, short: "WC video", hint: "Stand still and watch the screen", seconds: S.wc },
      { ...base, custom: true, key: "switch", name: "Press: ease to a stop", short: "Switch", hint: "It slows to a stop by itself", seconds: S.switchCap },
      { ...base, custom: true, key: "reveal-cold", name: "Reveal (hidden before)", short: "Rev cold", hint: "Face the court: do they pop in?", seconds: S.coldPre + S.coldPost },
      { ...base, custom: true, key: "reveal-warm", name: "Reveal (drawn under video)", short: "Rev warm", hint: "Face the court: do they pop in?", seconds: S.warmHidden + S.warmUnder + S.warmPost },
    ];
    if (mode === "ar-opaque") {
      list.push({ ...base, custom: true, key: "room", name: "See my room", short: "Room", hint: "Your room shows, then the arena returns", splats: "freeze", seconds: 2 * S.roomEdge + 2 * FADE_S + S.roomHold });
    }
    list.forEach((p, i) => {
      p.name = `${i + 1}/${list.length}  ${p.name}`;
      p.short = `${i + 1} ${p.short}`;
    });
    return list;
  };
  const fresh = (mode: Mode): Run => {
    const phases = phasesFor(mode);
    return {
      mode, phases, stage: -1, stageStart: -1, skip: false, lastTime: null, prevStage: -1, prevSub: "none", settleFrames: 0,
      stats: phases.map(freshStats), warm: [], videoBase: { decoded: 0, dropped: 0 }, placed: false, eye: null, result: null, interrupted: null,
      answers: {}, qIndex: 0,
    };
  };
  const waiters: ((f: FrameInfo) => void)[] = [];
  const nextFrame = () => new Promise<FrameInfo>((resolve) => waiters.push(resolve));

  const restart = () => {
    if (!run) return;
    const placed = run.placed; // the court stays where it is; only the measurement starts over
    resetWc();
    room.set(1);
    phaseRoom = 1;
    watch.clear();
    run = fresh(run.mode);
    run.placed = placed;
  };
  const restartBtn = new XrButton("restart", "Restart", restart);
  const phaseBtn = new XrButton("phase", "Phase", () => {
    if (run && run.stage < run.phases.length) run.skip = true;
  });
  const hudBtn = new XrButton("hud", "Hide HUD", () => {
    hudHidden = !hudHidden;
    hudBtn.setLabel(hudHidden ? "Show HUD" : "Hide HUD");
  });
  const exitBtn = new XrButton("exit", "Exit", () => void session?.end());
  const questionsBtn = new XrButton("questions", "Questions", () => {
    if (run?.result) run.qIndex = 0; // ask this mode's boundary questions again
  });
  menu.add(restartBtn, phaseBtn, hudBtn, exitBtn, questionsBtn);

  // ---------------- boundary questions and the VR vs AR-opaque table ----------------
  const controllers = [renderer.xr.getController(0), renderer.xr.getController(1)];
  controllers.forEach((c) => scene.add(c));
  const questionsFor = (mode: Mode) => QUESTIONS.filter((x) => x.modes.includes(mode));
  const currentQuestion = (r: Run) => (r.result && !("error" in r.result) ? questionsFor(r.mode)[r.qIndex] ?? null : null);
  const summaries: Partial<Record<Mode, ModeSummary>> = {};
  const summaryKey = (mode: Mode) => `s6-quest-v2-summary-${mode}`;
  for (const mode of ["vr", "ar-opaque"] as Mode[]) {
    try {
      const saved = localStorage.getItem(summaryKey(mode));
      if (saved) summaries[mode] = { ...(JSON.parse(saved) as ModeSummary), thisPage: false };
    } catch {
      // no storage: only this page's runs are compared
    }
  }
  const saveSummary = (sum: ModeSummary) => {
    summaries[sum.mode] = sum;
    try {
      localStorage.setItem(summaryKey(sum.mode), JSON.stringify(sum));
    } catch {
      // no storage
    }
  };
  const answerPanel = new AnswerPanel(scene, controllers, (answer) => {
    const r = run;
    const qn = r && currentQuestion(r);
    if (!r || !qn) return;
    r.answers[qn.id] = answer;
    r.qIndex++;
    const sum = summaries[r.mode];
    if (sum?.thisPage) saveSummary({ ...sum, answers: { ...r.answers } });
    showResults(r);
  });
  const panelView = (r: Run): PanelView => {
    const qs = questionsFor(r.mode);
    const qn = currentQuestion(r);
    const ans = (mode: Mode, id: (typeof QUESTIONS)[number]["id"]) => {
      if (!QUESTIONS.find((x) => x.id === id)!.modes.includes(mode)) return "n/a";
      const a = (mode === r.mode ? r.answers : summaries[mode]?.answers)?.[id];
      return a === undefined ? "-" : a === "skip" ? "skip" : a ? "YES" : "NO";
    };
    const order = ["video", "freeze", "freeze-big", "freeze-walk", "handoff", "wc", "switch", "reveal-cold", "reveal-warm", "room"];
    const vr = summaries.vr;
    const ar = summaries["ar-opaque"];
    const cells = (sum: ModeSummary | undefined, key: string) => {
      const p = sum?.phases.find((x) => x.key === key);
      return p ? [f1(p.fr50), f1(p.fr95), String(p.drop), p.gpu50 === null ? "-" : f1(p.gpu50)] : ["-", "-", "-", "-"];
    };
    const when = (sum: ModeSummary | undefined, name: string) => (!sum ? `${name}: not run yet` : `${name}: ${sum.thisPage ? "this page" : "saved"} ${sum.savedAt}, ${sum.hz} Hz`);
    return {
      title: "Your answers  ·  VR vs AR-opaque",
      question: qn ? { index: r.qIndex, total: qs.length, lines: qn.lines, note: qn.edgeOff && r.mode === "ar-opaque" ? "(edge fade OFF for this one)" : "" } : null,
      answers: { head: ["Question", "VR", "AR-opaque"], rows: QUESTIONS.map((x) => [x.short, ans("vr", x.id), ans("ar-opaque", x.id)]) },
      compare: {
        head: ["Phase", "VR fr50", "fr95", "drop", "gpu50", "AR fr50", "fr95", "drop", "gpu50"],
        rows: order.filter((k) => vr?.phases.some((p) => p.key === k) || ar?.phases.some((p) => p.key === k)).map((k) => [
          (ar ?? vr)!.phases.find((p) => p.key === k)?.short ?? vr!.phases.find((p) => p.key === k)!.short, ...cells(vr, k), ...cells(ar, k),
        ]),
        note: `${when(vr, "VR")}  |  ${when(ar, "AR")}`,
      },
      footer: ["Same scene, same phases; frame interval ms (fr), dropped frames, GPU ms.", "Photograph this panel too."],
    };
  };

  const eyeBuffer = (s: XRSession) => {
    // Quest's browser gives three a projection layer (no baseLayer); the emulator and older browsers a base layer
    const base = s.renderState.baseLayer;
    const layers = (s.renderState as unknown as { layers?: { textureWidth?: number; textureHeight?: number }[] }).layers;
    const proj = layers?.find((l) => l.textureWidth !== undefined);
    const eye = renderer.xr.getCamera().cameras[0]?.viewport;
    return {
      layer: base ? "baseLayer" : proj ? "projectionLayer" : "unknown",
      layerWidth: base?.framebufferWidth ?? proj?.textureWidth ?? null,
      layerHeight: base?.framebufferHeight ?? proj?.textureHeight ?? null,
      perEyeWidth: eye?.width ?? null,
      perEyeHeight: eye?.height ?? null,
      requestedScale: XR_QUALITY.res,
      nativeScale: typeof XRWebGLLayer !== "undefined" && XRWebGLLayer.getNativeFramebufferScaleFactor ? round(XRWebGLLayer.getNativeFramebufferScaleFactor(s), 3) : null,
      foveation: renderer.xr.getFoveation() ?? null,
    };
  };

  const peopleReport = () =>
    people.map((p, i) => ({ label: p.label, source: p.source, freezeSplats: splatCount(p.freeze), bigSplats: splatCount(bigs[i].freeze) }));
  const resident = () => {
    const meshes = [...people, ...bigs].map((p) => p.freeze);
    const splats = meshes.reduce((sum, m) => sum + splatCount(m), 0);
    return { meshes: meshes.length, splats, bytesEstimate: splats * 32 };
  };

  const rateNow = (r: Run) => {
    const reported = session?.frameRate;
    if (reported) return { hz: reported, reported: true };
    const all = r.stats.flatMap((st) => st.intervals).sort((a, b) => a - b);
    return { hz: all.length ? snapRate(all[Math.floor(all.length / 2)]) : TARGET_HZ, reported: false };
  };

  // ---------------- results ----------------
  const keyIndex = (r: Run, key: string) => r.phases.findIndex((p) => p.key === key);
  const statsOf = (r: Run, key: string) => r.stats[keyIndex(r, key)] ?? null;
  const afterMark = (st: PhaseStats | null, mark: string): { intervalMaxMs: number | null; cpuMaxMs: number | null } => {
    const at = st?.marks[mark];
    if (!st || at === undefined) return { intervalMaxMs: null, cpuMaxMs: null };
    const win = (a: number[]) => a.slice(at, at + AFTER);
    return { intervalMaxMs: round(Math.max(0, ...win(st.intervals))), cpuMaxMs: round(Math.max(0, ...win(st.cpu))) };
  };
  const sortSummary = (stage: number, seconds: number) => {
    const list = watch.sorts.filter((s) => s.stage === stage);
    const deg = watch.staleDeg.get(stage) ?? [];
    const cm = watch.staleCm.get(stage) ?? [];
    return {
      sorts: list.length, perSecond: round(list.length / Math.max(0.001, seconds), 1),
      ms: summarize(list.map((s) => s.ms)), readbackMs: summarize(list.map((s) => s.readbackMs)), lagFrames: summarize(list.map((s) => s.lagFrames)),
      staleDeg: summarize(deg), staleCm: summarize(cm),
    };
  };

  const buildResult = (r: Run, rate: { hz: number; reported: boolean }) => {
    const res = resident();
    const wcStats = statsOf(r, "wc");
    const sw = statsOf(r, "switch");
    const cold = statsOf(r, "reveal-cold");
    const roomSt = statsOf(r, "room");
    const reveal = (label: string) => {
      const v = watch.reveals.find((x) => x.label === label);
      return { ran: !!v, drawnBefore: v?.drawnBefore ?? null, drawnAfterFrames: v?.drawnAfterFrames ?? null, firstSortMs: v?.firstSort ? round(v.firstSort.ms) : null, firstSortLag: v?.firstSort?.lagFrames ?? null };
    };
    const subSummary = (st: PhaseStats | null, sub: Sub) =>
      st ? { intervalMs: summarize(st.sub[`int:${sub}`] ?? []), cpuMs: summarize(st.sub[`cpu:${sub}`] ?? []), gpuMs: summarize(st.sub[`gpu:${sub}`] ?? []), frames: (st.sub[`int:${sub}`] ?? []).length } : null;
    return {
      page: "S6 v2 Court Side headset test",
      mode: r.mode,
      sessionMode: SESSION_MODE[r.mode],
      interrupted: r.interrupted,
      finishedAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      quality: { res: XR_QUALITY.res, fov: XR_QUALITY.fov },
      eyeBuffer: r.eye,
      session: info && {
        environmentBlendMode: info.blend, features: info.features.out, referenceSpaces: info.spaces, anchors: info.anchors.out, offOn: info.vis.out,
      },
      edgeFade: {
        on: r.mode === "ar-opaque", area: edge.label(), startM: EDGE_START_M, fullM: EDGE_FULL_M,
        framesPerPhase: Object.fromEntries(r.phases.map((p, i) => [p.key, r.stats[i].edgeFrames])),
        note: "AR-opaque only: the set and the black curtain fade to your room as you near the edge (smoothstep, 0.6 m to 0.3 m). Off while the two boundary questions are asked, so they test the browser's own boundary.",
      },
      answers: r.answers,
      frameRate: {
        target: info?.rate ?? null, inEffect: rate.hz, reportedBySession: rate.reported, dropLimitMs: round(1500 / rate.hz),
      },
      gpuTimer: { available: gpu.available, disjoint: gpu.disjoint, dropped: gpu.dropped },
      loopErrors,
      enableLod,
      source: people[0]?.source,
      people: peopleReport(),
      phaseSeconds: PHASE_S,
      video: { src: screen.url, width: screen.video.videoWidth, height: screen.video.videoHeight, durationS: screen.video.duration, error: videoError },
      webcodecs: {
        probes: wc.probes, using: wc.pick?.label ?? null, hardware: wc.pick?.hardware ?? null, error: wc.error,
        stream: wc.main && { url: wc.main.url, bytes: wc.main.bytes, frames: wc.main.units.length, idr: wc.main.keys },
        ease: wc.ease && { url: wc.ease.url, bytes: wc.ease.bytes, frames: wc.ease.units.length },
        firstFrameMs: wc.aFirstMs === null ? null : round(wc.aFirstMs), decoderNeededMoreInFlight: wc.aLimitRaised,
        errors: [...wc.errors, ...(wc.A?.errors ?? []), ...(wc.B?.errors ?? [])].slice(0, 8),
        play: wcStats && {
          ...wcStats.wc, readyMin: Number.isFinite(wcStats.wc?.readyMin ?? NaN) ? wcStats.wc!.readyMin : null, heldAt: undefined, uploadMs: summarize(wcStats.wc?.uploadMs ?? []),
          decodeMs: summarize(wcStats.decodeMs), missedDisplayFrames: dropped(wcStats.intervals, rate.hz).count,
        },
        switch: sw && {
          easeFromMainFrame: EASE_FROM_FRAME, switched: wc.sw.at >= 0, primedFramesAtSwitch: wc.sw.bReady, primeFirstFrameMs: wc.sw.bFirstMs === null ? null : round(wc.sw.bFirstMs),
          heldAtSwitch: wc.sw.at >= 0 ? heldWithin(sw.wc, wc.sw.at) : null, heldGoingBack: heldWithin(cold?.wc ?? null, 1), easeFramesShown: wc.sw.easeShown,
          decodeMs: summarize(sw.decodeMs), held: sw.wc?.held ?? null, late: sw.wc?.late ?? null,
        },
      },
      sort: {
        note: "lag = display frames from the frame whose view was sorted to the first frame drawn with that order; stale = angle/distance between your head and the view of the order on screen",
        walk: sortSummary(keyIndex(r, "freeze-walk"), PHASE_S),
        still250k: sortSummary(keyIndex(r, "freeze"), PHASE_S),
        still400k: sortSummary(keyIndex(r, "freeze-big"), PHASE_S),
      },
      reveal: {
        cold: { ...reveal("cold"), ...afterMark(cold, "reveal") },
        underVeil: reveal("under-veil"),
        warm: { ...reveal("warm"), ...afterMark(statsOf(r, "reveal-warm"), "reveal") },
      },
      room: roomSt && { opaque: subSummary(roomSt, "opaque"), room: subSummary(roomSt, "room"), fading: subSummary(roomSt, "fade") },
      warmupMs: { frames: r.warm.length, ...summarize(r.warm) },
      resident: { meshes: res.meshes, splats: res.splats, bytesEstimate: res.bytesEstimate, textureBytes: set.textureBytes + screen.textureBytes(), textureSizes: set.textureSizes },
      phases: r.phases.map((p, i) => {
        const st = r.stats[i];
        return {
          key: p.key, short: p.short, video: p.video, splats: p.splats, walking: p.walk,
          frames: st.intervals.length,
          intervalMs: summarize(st.intervals),
          dropped: dropped(st.intervals, rate.hz),
          cpuMs: summarize(st.cpu),
          gpuMs: summarize(st.gpu),
          gpuSamples: st.gpu.length,
          edgeFrames: st.edgeFrames,
          visibleSplats: { max: st.visible.max, mean: Math.round(st.visible.sum / Math.max(1, st.visible.n)) },
          drawnSplats: { max: st.drawn.max, mean: Math.round(st.drawn.sum / Math.max(1, st.drawn.n)) },
          videoPlayback: st.videoStats,
          webcodecs: st.wc ? { shown: st.wc.shown, displayFrames: st.wc.displayFrames, held: st.wc.held, late: st.wc.late, startup: st.wc.startup } : null,
          jsHeapUsedMB: st.heap,
        };
      }),
      notes: [
        "Intervals are differences between consecutive XR animation-frame timestamps, attributed to the phase that was current when the earlier frame started. cpu = the frame callback's JS time (including renderer.render and the WebCodecs upload); gpu = EXT_disjoint_timer_query_webgl2 around renderer.render (Spark's sort readback and splat generation run after the frame and are not in it).",
        "WebCodecs: one new frame per display frame. decodeMs = latency from decode() to the output callback (at most 4 frames decoded or in flight). held = display frames that kept the previous frame because the next was not decoded; late = frames not decoded in time (each causes holds); missedDisplayFrames = intervals over 1.5x the frame time while the video played.",
        "Reveal: drawnAfterFrames = display frames from the reveal until Spark draws at least half the pair (0 = already drawn). cold = hidden until the reveal; warm = drawn under the opaque video layer for the 2 s before it.",
        "The HUD canvas is redrawn once a second; that upload is part of every number.",
        selftest ? "Desktop emulation (IWER): timing is the laptop's and ignores the framebuffer scale; the self-test shortens the phases." : "Measured on this device's browser.",
      ],
    };
  };
  type Result = ReturnType<typeof buildResult>;

  const resultsView = (r: Run, result: Result): ResultsView => {
    const e = result.eyeBuffer as { perEyeWidth: number | null; perEyeHeight: number | null } | null;
    const sp = result.session?.referenceSpaces;
    const rate = result.frameRate.target;
    const an = result.session?.anchors;
    const w = result.webcodecs;
    const play = w.play;
    const sw = w.switch;
    const walk = result.sort.walk;
    const rc = result.reveal.cold;
    const rw = result.reveal.warm;
    const probe = (p: Probe) => `${p.label} ${yn(p.supported)}${p.hardware ? "(hw)" : ""}`;
    const roomLine = result.room
      ? `Room: passthrough p50 ${f1(result.room.room?.intervalMs.p50)} p95 ${f1(result.room.room?.intervalMs.p95)} gpu ${f1(result.room.room?.gpuMs.p50)}  opaque p50 ${f1(result.room.opaque?.intervalMs.p50)} p95 ${f1(result.room.opaque?.intervalMs.p95)} gpu ${f1(result.room.opaque?.gpuMs.p50)}`
      : "Room: (AR-opaque only)";
    return {
      title: `Court Side S6 v2   ${r.mode === "vr" ? "VR" : "AR-opaque"}   RESULTS${r.interrupted ? `  (INTERRUPTED: ${r.interrupted}; Restart)` : ""}`,
      lines: [
        `${result.sessionMode}  blend ${result.session?.environmentBlendMode ?? "?"}  eye ${e?.perEyeWidth ?? "?"}x${e?.perEyeHeight ?? "?"}  res ${XR_QUALITY.res} fov ${XR_QUALITY.fov}`,
        `Rate ${result.frameRate.inEffect} Hz  set(${TARGET_HZ}) ${rate?.api ? (rate.ok ? "ok" : `FAILED ${rate.error ?? ""}`) : "no API"}  supports ${rate?.supported?.join("/") ?? "?"}  GPU timer ${yn(gpu.available)}`,
      ],
      table: {
        head: ["Phase", "fr50", "fr95", "fr99", "drop", "cpu50", "cpu95", "cpu99", "gpu50", "gpu95"],
        rows: result.phases.map((p) => [
          p.short, f1(p.intervalMs.p50), f1(p.intervalMs.p95), f1(p.intervalMs.p99), `${p.dropped.count} ${Math.round(p.dropped.pct)}%`,
          f1(p.cpuMs.p50), f1(p.cpuMs.p95), f1(p.cpuMs.p99), p.gpuSamples ? f1(p.gpuMs.p50) : "-", p.gpuSamples ? f1(p.gpuMs.p95) : "-",
        ]),
      },
      checks: [
        info?.features.line() ?? "Granted: ?",
        r.mode === "ar-opaque"
          ? `Edge fade on: ${edge.label()}, room from ${EDGE_START_M} m, all at ${EDGE_FULL_M} m; in phases ${result.phases.reduce((n, p) => n + p.edgeFrames, 0)} frames`
          : `Edge fade: AR-opaque only (play area here: ${edge.label()})`,
        `You: wall at edge ${yesNo(r.answers.edgeWall)}  room past edge ${yesNo(r.answers.pastEdge)}${r.mode === "ar-opaque" ? `  edge fade ${yesNo(r.answers.edgeFade)}` : ""}  (panel on your right)`,
        `Floor ${sp?.localFloor === "ok" ? "local-floor ok" : `local-floor ${sp?.localFloor ?? "?"}`}  boundary ${sp?.boundsM ? `${sp.boundsM.w} x ${sp.boundsM.d} m` : sp?.boundedFloor === "ok" ? "ok, no shape given" : (sp?.boundedFloor ?? "?").slice(0, 40)}`,
        an?.create === "not run" || an?.create === "running" ? `Anchors: ${an.create === "running" ? "testing..." : "test starts now"}` : `Anchors: create ${an?.create ?? "?"}${an?.createMs !== null && an?.createMs !== undefined ? ` ${Math.round(an.createMs)}ms` : ""} tracked ${yn(an?.tracked)}  persist ${an?.persistentApi ? an.handle : "no API"}  last run's: ${an?.restoredOld ?? "?"}, deleted ${an?.deletedOld ?? 0}`,
        `Decoder ${w.probes.map(probe).join("  ")}`,
        play
          ? `WC ${w.using}${w.hardware ? " hw" : " SW"}: decode lat p50 ${f1(play.decodeMs.p50)} p95 ${f1(play.decodeMs.p95)}  upload p95 ${f1(play.uploadMs.p95)}  first ${f1(w.firstFrameMs)} ms${w.decoderNeededMoreInFlight ? "  >4 in flight!" : ""}`
          : `WC: ${w.error ?? "not run"}`,
        play ? `   shown ${play.shown}/${play.displayFrames}  held ${play.held}  late ${play.late}  dropped ${play.missedDisplayFrames}  ready min ${play.readyMin ?? "-"}` : "",
        sw ? `Switch: primed ${sw.primedFramesAtSwitch} fr (${f1(sw.primeFirstFrameMs)} ms)  held at switch ${sw.heldAtSwitch ?? "-"}  back ${sw.heldGoingBack ?? "-"}  ease ${sw.easeFramesShown}` : "Switch: not run",
        walk.sorts
          ? `Sort walk: p50 ${f1(walk.ms.p50)} p95 ${f1(walk.ms.p95)} ms (readback ${f1(walk.readbackMs.p50)})  lag p50 ${walk.lagFrames.p50} p95 ${walk.lagFrames.p95} max ${walk.lagFrames.max} fr`
          : "Sort walk: no sorts recorded",
        walk.sorts ? `   ${walk.perSecond}/s  stale p95 ${f1(walk.staleDeg.p95)} deg ${f1(walk.staleCm.p95)} cm` : "",
        `Reveal cold: +${rc.drawnAfterFrames ?? "never"} fr  max ${f1(rc.intervalMaxMs)}/${f1(rc.cpuMaxMs)} ms | warm: +${rw.drawnAfterFrames ?? "never"} fr  max ${f1(rw.intervalMaxMs)}/${f1(rw.cpuMaxMs)}`,
        roomLine,
        info?.vis.line() ?? "Off/on: -",
        ...(w.errors.length ? [`WC errors: ${w.errors[0].slice(0, 70)}`] : []),
        ...(loopErrors.length ? [`Frame errors (${loopErrors.length}): ${loopErrors[0].slice(0, 60)}`] : []),
      ].filter(Boolean),
      footer: ["Reveal max = frame interval / cpu ms in the 0.5 s after. Photograph this panel.", "Then take the headset off, count to 10, put it back on: the Off/on line updates."],
    };
  };
  const reportText = (v: ResultsView) => {
    const rows = [v.table.head, ...v.table.rows].map((row) => row.map((cell, i) => (i === 0 ? cell.padEnd(11) : cell.padStart(7))).join(""));
    return [v.title, ...v.lines, ...rows, ...v.checks].join("\n");
  };
  const save = (text: string, result: unknown) => {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify({ savedAt: new Date().toLocaleString(), text, result }));
    } catch {
      // no storage: the page and the HUD still show it
    }
  };
  let reportBase = "";
  const showResults = (r: Run) => {
    if (!r.result) return;
    const view = resultsView(r, r.result as Result);
    hud.drawResults(view);
    answerPanel.draw(panelView(r));
    const text = reportText(view);
    report.textContent = `${reportBase}${text}\n\n`;
    save(text, r.result);
    if (!selftest) window.__spikeResult = latest();
  };
  const finish = (r: Run) => {
    reportBase = report.textContent?.startsWith("Saved from the last run") ? "" : (report.textContent ?? "");
    try {
      const result = buildResult(r, rateNow(r));
      r.result = result;
      runs.push(result);
      saveSummary({
        mode: r.mode, savedAt: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), thisPage: true, hz: result.frameRate.inEffect,
        edge: edge.label(), answers: { ...r.answers },
        phases: result.phases.map((p) => ({ key: p.key, short: p.short, fr50: p.intervalMs.p50, fr95: p.intervalMs.p95, drop: p.dropped.count, gpu50: p.gpuSamples ? p.gpuMs.p50 : null })),
      });
      showResults(r);
      console.log(JSON.stringify(result));
    } catch (e) {
      // keep the frame times at least: one line per phase on the HUD and the page
      loopErrors.push(`results: ${String(e).slice(0, 140)}`);
      const rows = r.phases.map((p, i) => {
        const iv = summarize(r.stats[i].intervals);
        const cpu = summarize(r.stats[i].cpu);
        return `${p.short.padEnd(11)} fr ${f1(iv.p50)} ${f1(iv.p95)} ${f1(iv.p99)}  cpu ${f1(cpu.p50)} ${f1(cpu.p95)}`;
      });
      r.result = { page: "S6 v2", error: String(e), rows };
      runs.push(r.result);
      hud.draw({ title: "Court Side S6 v2  RESULTS (partial)", phase: "Results failed", hint: String(e).slice(0, 60), countdown: "", lines: rows });
      report.textContent = `${reportBase}RESULTS FAILED: ${String(e)}\n${rows.join("\n")}\n\n`;
      if (!selftest) window.__spikeResult = latest();
    }
  };
  const onVisibility = () => {
    if (run && !run.result && run.stage < run.phases.length && session && session.visibilityState !== "visible") {
      run.interrupted ??= `${session.visibilityState} during ${run.stage < 0 ? "setup" : run.phases[run.stage].short}`;
    }
    if (run?.result && !("error" in run.result)) showResults(run);
  };

  // ---------------- live HUD ----------------
  const lengthOf = (r: Run, stage: number) => (stage < 0 ? SETTLE_S : r.phases[stage].seconds);
  const liveLines = (r: Run, p: Phase, elapsed: number): string[] => {
    const st = r.stats[r.stage];
    if (p.key === "wc" || p.key === "switch") {
      const s = layer.stats;
      const lines = [`Decoder ${wc.pick?.label ?? "none"}  decode p95 ${f1(summarize(st.decodeMs).p95)} ms`, `Shown ${s.shown}/${s.displayFrames}  held ${s.held}  late ${s.late}  startup ${s.startup}`];
      if (p.key === "switch") {
        lines.push(wc.sw.at < 0 ? `Ease primed: ${wc.B?.ready.length ?? 0} frames ready (${f1(wc.B?.firstOutputMs)} ms)` : `Switched: held ${heldWithin(s, wc.sw.at)} in the 0.5 s after; ease ${wc.sw.easeShown}/${wc.ease?.units.length ?? "?"}`);
      }
      return lines;
    }
    if (p.key.startsWith("reveal")) {
      const rv = watch.reveals.filter((x) => x.stage === r.stage);
      return rv.length ? rv.map((x) => `${x.label}: drawn after ${x.drawnAfterFrames ?? "..."} frames`) : [`Players appear in ${Math.max(0, Math.ceil(lengthOf(r, r.stage) - (p.key === "reveal-cold" ? S.coldPost : S.warmPost) - elapsed))} s`];
    }
    if (p.key === "room") return [`Arena ${Math.round(room.level * 100)}%`];
    return [];
  };
  const drawHud = (r: Run, elapsed: number) => {
    const rate = rateNow(r);
    const e = r.eye as { perEyeWidth: number | null; perEyeHeight: number | null } | null;
    const title = `Court Side  S6 v2  ${r.mode === "vr" ? "VR" : "AR-opaque"}`;
    const head = [`Rate ${rate.hz} Hz (target ${TARGET_HZ})  eye ${e?.perEyeWidth ?? "?"}x${e?.perEyeHeight ?? "?"}  res ${XR_QUALITY.res}`];
    if (r.stage < 0) {
      hud.draw({ title, phase: "Get ready", hint: "Stand where you entered, face the court", countdown: String(Math.max(0, Math.ceil(SETTLE_S - elapsed))), lines: head });
    } else if (r.stage < r.phases.length) {
      const p = r.phases[r.stage];
      const st = r.stats[r.stage];
      const live = summarize(st.intervals);
      const drops = dropped(st.intervals, rate.hz);
      const video = p.video ? [`Video ${screen.stat(r.videoBase, elapsed).fps} fps decoded, ${screen.stat(r.videoBase, elapsed).droppedFrames} dropped`] : [];
      const countdown = p.key === "switch" ? "" : String(Math.max(0, Math.ceil(lengthOf(r, r.stage) - elapsed)));
      hud.draw({
        title, phase: p.name, hint: p.hint, countdown,
        lines: [...head, `Visible ${fmtK(visibleNow)} splats, drawn ${fmtK(watch.activeSplats)}`, ...video, ...liveLines(r, p, elapsed),
          `Live p50 ${live.p50.toFixed(1)}  p95 ${live.p95.toFixed(1)}  max ${live.max.toFixed(1)} ms`, `Dropped ${drops.count} (${drops.pct}%)  cpu p95 ${f1(summarize(st.cpu).p95)} ms`],
      });
    }
  };

  // ---------------- the v2 phases ----------------
  const enterPhase = (r: Run, stage: number) => {
    const p = r.phases[stage];
    const st = r.stats[stage];
    const cfg = wcConfig();
    if (p.video) r.videoBase = screen.quality();
    if (!p.custom) return;
    if (p.key === "wc") {
      if (!wc.A && cfg && wc.main) wc.A = new StreamPlayer(wc.main, cfg, true);
      if (wc.A) wc.A.decodeMs = st.decodeMs;
      layer.source = wc.A;
      layer.resetStats();
      wcWindow.visible = true;
    } else if (p.key === "switch") {
      if (cfg && wc.ease) wc.B = new StreamPlayer(wc.ease, cfg, false); // primes itself: up to four frames decoded ahead
      if (wc.A) wc.A.decodeMs = st.decodeMs;
      if (wc.B) wc.B.decodeMs = st.decodeMs;
      layer.source = wc.A;
      layer.resetStats();
      wcWindow.visible = true;
    } else if (p.key === "reveal-cold" || p.key === "reveal-warm") {
      // back to the main stream (Back to my seat), on the veil this time
      if (wc.A) {
        wc.A.paused = false;
        wc.A.decodeMs = st.decodeMs;
        wc.A.pump();
      }
      if (wc.B) {
        wc.errors.push(...wc.B.errors);
        wc.B.close();
        wc.B = null;
      }
      layer.source = wc.A;
      layer.resetStats();
      wcWindow.visible = false;
      wcVeil.visible = !!wc.A;
    }
  };
  const exitPhase = (r: Run, stage: number, elapsed: number) => {
    const p = r.phases[stage];
    const st = r.stats[stage];
    st.heap = heapMB();
    if (p.video) st.videoStats = screen.stat(r.videoBase, elapsed);
    if (p.key === "wc" && wc.A) {
      wc.aFirstMs = wc.A.firstOutputMs;
      wc.aLimitRaised = wc.A.limitRaised;
    }
    if (p.custom && p.key !== "room") st.wc = layer.resetStats();
    if (p.key === "switch") wcWindow.visible = false;
    if (p.key === "reveal-warm") {
      if (wc.A) {
        wc.errors.push(...wc.A.errors);
        wc.A.close();
        wc.A = null;
      }
      layer.dispose();
      wcVeil.visible = false;
    }
    if (p.key === "room") phaseRoom = 1;
  };
  const roomLevel = (e: number) => {
    const a = S.roomEdge;
    const b = a + FADE_S;
    const c = b + S.roomHold;
    if (e < a) return 1;
    if (e < b) return 1 - smooth((e - a) / FADE_S);
    if (e < c) return 0;
    return smooth((e - c) / FADE_S);
  };
  /** Per frame, before the video layer ticks. */
  const drive = (r: Run, p: Phase, elapsed: number) => {
    const st = r.stats[r.stage];
    if (p.key === "wc") present(false, "none", full);
    else if (p.key === "switch") {
      present(false, "none", full);
      const A = wc.A;
      const B = wc.B;
      // the press: the ease starts on main frame 216, so switch on the display frame that would have shown it
      if (wc.sw.at < 0 && A && B && wc.main && elapsed >= S.switchMin && (layer.lastIndex + 1) % wc.main.units.length === EASE_FROM_FRAME) {
        wc.sw.at = layer.stats.displayFrames + 1;
        wc.sw.bReady = B.ready.length;
        wc.sw.bFirstMs = B.firstOutputMs;
        st.marks.switch = st.cpu.length;
        A.paused = true; // kept, with its decoded frames, for "Back to my seat"
        layer.source = B;
      }
      if (wc.sw.at >= 0 && wc.sw.easeDoneAt === null && (B?.ended || B?.failed)) wc.sw.easeDoneAt = elapsed;
      if (wc.sw.at < 0 && (A?.failed || B?.failed)) wc.sw.easeDoneAt ??= elapsed; // a decoder died: errors are on the table
      if (!A || !B) wc.sw.easeDoneAt ??= elapsed; // nothing to switch: move on
    } else if (p.key === "reveal-cold") {
      if (elapsed < S.coldPre) present(false, "none", full);
      else {
        if (!wc.revealed.cold) {
          wc.revealed.cold = true;
          wcVeil.visible = false;
          layer.release();
          if (wc.A) wc.A.paused = true;
          st.marks.reveal = st.cpu.length;
        }
        present(false, "freeze", full);
        if (!watch.reveals.some((x) => x.label === "cold")) watch.reveal("cold", freezeCount());
      }
    } else if (p.key === "reveal-warm") {
      if (elapsed < S.warmHidden) present(false, "none", full);
      else if (elapsed < S.warmHidden + S.warmUnder) {
        present(false, "freeze", full); // drawn, under the opaque video
        if (!wc.revealed.under) {
          wc.revealed.under = true;
          watch.reveal("under-veil", freezeCount());
        }
      } else {
        present(false, "freeze", full);
        if (!wc.revealed.warm) {
          wc.revealed.warm = true;
          wcVeil.visible = false;
          layer.release();
          if (wc.A) wc.A.paused = true;
          st.marks.reveal = st.cpu.length;
          watch.reveal("warm", freezeCount());
        }
      }
    } else if (p.key === "room") {
      present(false, "freeze", full);
      phaseRoom = roomLevel(elapsed);
    }
  };
  const phaseDone = (r: Run, p: Phase, elapsed: number) =>
    p.key === "switch" ? (wc.sw.easeDoneAt !== null && elapsed - wc.sw.easeDoneAt >= 0.6) || elapsed >= p.seconds : elapsed >= lengthOf(r, r.stage);
  const subOf = (r: Run): Sub => {
    if (r.stage < 0 || r.stage >= r.phases.length || r.phases[r.stage].key !== "room") return "none";
    return room.level === 1 ? "opaque" : room.level === 0 ? "room" : "fade";
  };

  // ---------------- XR loop ----------------
  let lastKey = "";
  const head = new THREE.Vector3();
  const gaze = new THREE.Vector3();
  const forward = new THREE.Vector3();
  const orient = new THREE.Quaternion();
  const loopErrors: string[] = [];
  const onFrame = (time: number, frame: XRFrame | undefined) => {
    if (!renderer.xr.isPresenting || !frame || !run || !session || !info) return;
    const t0 = performance.now();
    const r = run;
    const END = r.phases.length;
    gpu.poll((tag, ms) => {
      const st = r.stats[tag >> 2];
      if (!st) return;
      st.gpu.push(ms);
      if (tag & 3) pushSub(st, `gpu:${SUBS[tag & 3]}`, ms);
    });
    const space = renderer.xr.getReferenceSpace()!;
    const pose = frame.getViewerPose(space);
    if (!pose) return;
    const pp = pose.transform.position;
    const o = pose.transform.orientation;
    head.set(pp.x, pp.y, pp.z);
    orient.set(o.x, o.y, o.z, o.w);
    gaze.set(0, 0, -1).applyQuaternion(orient);
    if (!r.placed) {
      forward.copy(gaze).setY(0).normalize();
      // 1.6 m ahead, turned so the -Z side of the set (where the viewer stands in S4) faces you; with only a "local"
      // space the floor is guessed 1.6 m below your eyes
      const floorY = info.spaces.used === "local" ? head.y - 1.6 : 0;
      set.court.position.set(head.x + forward.x * 1.6, floorY, head.z + forward.z * 1.6);
      set.court.rotation.set(0, Math.atan2(forward.x, forward.z), 0);
      // the HUD: 1.2 m from where you stand, 35 degrees left of the set, at eye height
      const left = new THREE.Vector3(forward.z, 0, -forward.x); // forward x up, negated
      hud.group.position.set(head.x, head.y - 0.1, head.z).addScaledVector(forward, 1.2 * Math.cos(0.61)).addScaledVector(left, 1.2 * Math.sin(0.61));
      hud.group.quaternion.identity();
      // the answers panel mirrors it, 35 degrees right of the set
      answerPanel.group.position.set(head.x, head.y - 0.1, head.z).addScaledVector(forward, 1.2 * Math.cos(0.61)).addScaledVector(left, -1.2 * Math.sin(0.61));
      if (info.boundary) edge.setBoundary(info.boundary.space, info.boundary.points);
      else edge.setSquare(head, forward);
      r.placed = true;
      courtLock.lock();
      hudLock.lock();
    }
    if (r.stage >= END) info.anchors.frame(frame, space); // after the results: anchor calls never touch a measured frame
    info.features.frame(frame);
    // the edge fade is always on in AR-opaque, except while a boundary question tests the browser's own boundary
    edge.enabled = !currentQuestion(r)?.edgeOff;
    edge.update(frame, head);
    courtLock.update();
    hudLock.update();
    if (r.stageStart < 0) r.stageStart = time; // after Restart

    const dt = r.lastTime === null ? 1 / 72 : (time - r.lastTime) / 1000;
    if (r.lastTime !== null) {
      const interval = time - r.lastTime;
      if (r.prevStage >= 0 && r.prevStage < END) {
        const st = r.stats[r.prevStage];
        st.intervals.push(interval);
        if (r.prevSub !== "none") pushSub(st, `int:${r.prevSub}`, interval);
      } else if (r.prevStage < 0) r.warm.push(interval);
      else info.vis.frameGap(interval); // after the results: the headset off/on gap
    }
    r.lastTime = time;

    let elapsed = (time - r.stageStart) / 1000;
    const phase = r.stage >= 0 && r.stage < END ? r.phases[r.stage] : null;
    if (r.stage < END && (r.skip || (phase ? phaseDone(r, phase, elapsed) : elapsed >= SETTLE_S))) {
      if (r.stage >= 0) exitPhase(r, r.stage, elapsed);
      r.stage++;
      r.stageStart = time;
      r.skip = false;
      elapsed = 0;
      if (r.stage === 0) r.eye = eyeBuffer(session);
      if (r.stage < END) enterPhase(r, r.stage);
      else finish(r);
    }
    watch.beginFrame(r.stage, head, gaze);

    // what is on screen: the settle shows the video, the 250k pair and the 400k pair for a third each (unmeasured
    // first-use uploads); then each phase's own content. Phase 5 fades the video out as the pair fades in.
    if (r.stage < 0) {
      const third = Math.min(2, Math.floor((elapsed / SETTLE_S) * 3));
      present(third === 0, third === 0 ? "none" : third === 1 ? "freeze" : "big", full);
      // one settle frame with the set's materials transparent, so a later fade doesn't compile shaders mid-measurement
      phaseRoom = r.mode === "ar-opaque" && r.settleFrames === 0 ? 0.999 : 1;
      r.settleFrames++;
    } else if (r.stage < END) {
      const p = r.phases[r.stage];
      if (p.custom) drive(r, p, elapsed);
      else {
        const t = p.fade ? Math.min(1, elapsed / p.seconds) : 1;
        present(p.video, p.splats, p.fade ? { video: 1 - t, splats: t } : full);
      }
    } else present(false, "freeze", full);
    layer.tick();
    if (wc.B && layer.lastSource === wc.B) wc.sw.easeShown = layer.lastIndex + 1;
    const level = r.mode === "ar-opaque" ? Math.min(phaseRoom, edge.level) : 1;
    room.set(level);
    curtainMaterial.opacity = level;
    curtain.position.copy(head);
    if (r.stage >= 0 && r.stage < END && edge.level < 1 && r.mode === "ar-opaque") r.stats[r.stage].edgeFrames++;
    const sub = subOf(r);
    if (r.stage >= 0 && r.stage < END) {
      const st = r.stats[r.stage];
      st.visible.max = Math.max(st.visible.max, visibleNow);
      st.visible.sum += visibleNow;
      st.visible.n++;
      st.drawn.max = Math.max(st.drawn.max, watch.activeSplats);
      st.drawn.sum += watch.activeSplats;
      st.drawn.n++;
    }
    r.prevStage = r.stage;
    r.prevSub = sub;
    const secondKey = `${r.stage}:${Math.floor(elapsed)}`;
    if (secondKey !== lastKey && r.stage < END) {
      lastKey = secondKey;
      drawHud(r, elapsed);
    }
    hud.group.visible = !hudHidden;
    hud.face(head);
    answerPanel.group.visible = !!r.result && !("error" in r.result) && !hudHidden;
    if (answerPanel.group.visible) {
      answerPanel.draw(panelView(r));
      answerPanel.face(head);
      const qn = currentQuestion(r);
      const d = edge.distanceM;
      answerPanel.drawLive(
        d === null ? "Edge: unknown" : `Edge ${d.toFixed(2)} m (${edge.label()})${r.mode === "ar-opaque" ? `  room ${Math.round((1 - level) * 100)}%${qn?.edgeOff ? "  fade OFF" : ""}` : ""}`,
      );
      answerPanel.update();
    } else answerPanel.hide();
    handUpdate();
    menu.update(head, time, Math.min(0.1, dt));
    const measured = r.stage >= 0 && r.stage < END;
    if (measured) gpu.begin((r.stage << 2) | SUBS.indexOf(sub));
    renderer.render(scene, camera);
    if (measured) gpu.end();
    if (measured) {
      const cpu = performance.now() - t0;
      r.stats[r.stage].cpu.push(cpu);
      if (sub !== "none") pushSub(r.stats[r.stage], `cpu:${sub}`, cpu);
    }
    const fi: FrameInfo = { stage: r.stage, key: r.phases[r.stage]?.key ?? (r.stage < 0 ? "settle" : "done"), stageElapsed: elapsed, head: head.clone(), time };
    waiters.splice(0).forEach((resolve) => resolve(fi));
  };
  // a throw inside the XR frame callback would stop three's loop and freeze the headset: keep going, and report it
  renderer.setAnimationLoop((time, frame) => {
    try {
      onFrame(time, frame);
    } catch (e) {
      gpu.end();
      if (loopErrors.length < 8) {
        loopErrors.push(String(e).slice(0, 160));
        console.error(e);
      }
    }
  });

  // ---------------- entering ----------------
  const enter = async (mode: Mode) => {
    renderer.xr.setFramebufferScaleFactor(XR_QUALITY.res);
    renderer.xr.setFoveation(XR_QUALITY.fov);
    // playing a muted clip once, inside the click, lets the browser start it later without a gesture
    if (screen.video.paused) void screen.video.play().then(() => screen.video.pause()).catch(() => {});
    // nothing required: local-floor, the boundary and anchors are each checked and logged
    const s = await navigator.xr!.requestSession(SESSION_MODE[mode], { optionalFeatures: OPTIONAL_FEATURES });
    session = s;
    const { check: spaces, boundary } = await checkSpaces(s);
    renderer.xr.setReferenceSpaceType(spaces.used);
    info = {
      mode, spaces, rate: null, anchors: new AnchorTest(onVisibility), vis: new VisibilityLog(s, onVisibility),
      blend: s.environmentBlendMode ?? null, features: new Features(s, spaces), boundary,
    };
    const here = info;
    s.addEventListener("end", () => {
      here.vis.ended();
      here.anchors.release();
      courtLock.release();
      hudLock.release();
      menu.group.visible = menu.open = false;
      resetWc();
      phaseRoom = 1;
      room.set(1);
      curtainMaterial.opacity = 1;
      answerPanel.hide();
      if (run?.result && !("error" in run.result)) showResults(run);
      if (run && run.stage < run.phases.length) {
        status.textContent = `Session ended during ${run.stage < 0 ? "setup" : run.phases[run.stage].name}${here.vis.out.endedWhileOff ? " (while the headset was off)" : ""}; no result for this run.`;
      } else status.textContent = `Done${here.vis.out.endedWhileOff ? " (the session ended while the headset was off)" : ""}. Results are below and in window.__spikeResult. Pick a mode to run again.`;
      session = null;
      run = null;
      buttons.forEach((b) => (b.disabled = false));
    });
    s.addEventListener("frameratechange", () => console.log(`frameratechange: ${s.frameRate}`));
    await renderer.xr.setSession(s);
    info.rate = await setRate(s, TARGET_HZ);
    if (session !== s) return s; // it ended while the rate was being set
    lastKey = "";
    watch.clear();
    run = fresh(mode);
    hudHidden = false;
    hudBtn.setLabel("Hide HUD");
    buttons.forEach((b) => (b.disabled = true));
    status.textContent = `In ${SESSION_MODE[mode]} (rate ${s.frameRate ?? "unreported"} Hz, blend ${s.environmentBlendMode ?? "?"}). Phases run by themselves.`;
    return s;
  };

  const buttons = (["vr", "ar-opaque"] as Mode[]).map((mode) => {
    const b = document.createElement("button");
    b.textContent = mode === "vr" ? "Enter VR" : "Enter AR-opaque";
    b.disabled = true;
    b.addEventListener("click", () => void enter(mode).catch((e: unknown) => {
      status.textContent = `Could not enter ${SESSION_MODE[mode]}: ${String(e)}`;
    }));
    $("#modes").appendChild(b);
    return b;
  });
  addEventListener("resize", () => {
    if (renderer.xr.isPresenting) return;
    renderer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  });

  await load();
  sets.freeze = people.map((p) => p.freeze);
  sets.big = bigs.map((p) => p.freeze);
  freezeLabel = pairLabel(people);
  bigLabel = pairLabel(bigs);
  const resNow = resident();
  const probeText = wc.probes.map((p) => `${p.label} ${yn(p.supported)}${p.hardware ? " (hw)" : ""}`).join(", ");
  status.textContent = `Loaded ${people.map((p) => p.label).join(" + ")} (${freezeLabel} freeze, ${bigLabel} big, ${fmtK(resNow.splats)} splats resident); ${videoError ? `VIDEO FAILED: ${videoError}` : `video ${screen.video.videoWidth}x${screen.video.videoHeight} ready`}; WebCodecs: ${probeText}${wc.error ? ` FAILED: ${wc.error}` : `, using ${wc.pick?.label}`}. Pick a mode.`;
  buttons.forEach((b) => (b.disabled = false));

  if (selftest && device) {
    const test = await import("./selftest");
    // ?mode=ar: AR-opaque only; ?mode=both: VR, then AR-opaque in the same page (fills the side-by-side table)
    const modes: Mode[] = q.get("mode") === "both" ? ["vr", "ar-opaque"] : [q.get("mode") === "ar" ? "ar-opaque" : "vr"];
    const tests: Record<string, unknown>[] = [];
    for (const mode of modes) {
      device.position.set(0, 1.6, 0);
      device.quaternion.set(0, 0, 0, 1);
      for (const h of [device.hands.left, device.hands.right]) if (h) h.connected = true;
      const s = await enter(mode);
      tests.push(await test.runSelfTest({
        device, nextFrame, session: s, phaseS: PHASE_S, mode,
        focus: () => set.court.localToWorld(new THREE.Vector3(0.32, 1.2, -0.14)),
        hud: () => hud.group.position.clone(),
        panel: () => answerPanel.group.position.clone(),
        buttons: () => ({ yes: answerPanel.buttons.yes.getWorldPosition(new THREE.Vector3()), no: answerPanel.buttons.no.getWorldPosition(new THREE.Vector3()), asking: answerPanel.asking }),
        answers: () => ({ ...(run?.answers ?? {}) }),
        edge: () => ({ level: edge.level, distanceM: edge.distanceM, area: edge.label() }),
        result: latest,
      }));
      if (mode !== modes[modes.length - 1]) {
        await s.end();
        while (session) await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    window.__spikeResult = { ...latest(), selftest: tests.length === 1 ? tests[0] : tests };
    status.textContent = "Self-test complete";
  }
}

void start().catch((error: unknown) => {
  console.error(error);
  $("#status").textContent = `Failed: ${String(error)}`;
  window.__spikeResult = { error: String(error) };
});
