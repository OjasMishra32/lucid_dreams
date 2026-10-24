import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { SparkRenderer, SparkXr, SplatMesh } from "@sparkjsdev/spark";
import { SkinnedAvatar } from "./avatar";
import { HeadLook } from "./look";
import { cueAt, type Cue, parseVtt, SpatialCaption } from "./captions";
import { Coach, coachAvailable, type CoachState } from "./coach";
import { type Dream, dreamUrl, framePath, loadDream } from "./dream";
import { fallbackExperience, Lesson, loadExperience, say, StepCard } from "./experience";
import { nextPlace, type Place, Places, startingPlace } from "./places";
import { loadProps } from "./props";
import { fingertips, handOccluder, XrButton } from "./xr/hands";

// Bundle coordinates: meters, +Y up, feet on y = 0, the person's front faces -Z. In the room we use the WebXR
// "local-floor" space, so y = 0 is the real floor and nothing is ever scaled: the person is exactly their real size.

const PLAY = `<svg viewBox="0 0 16 16"><path d="M4 2.5v11l9-5.5z"/></svg>`;
const PAUSE = `<svg viewBox="0 0 16 16"><path d="M3.5 2h3v12h-3zM9.5 2h3v12h-3z"/></svg>`;
const BACK = `<svg viewBox="0 0 12 20"><path d="M10 2 2 10l8 8" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const MIC = `<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.25" y="1" width="5.5" height="9" rx="2.75"/><path d="M3 7.5a5 5 0 0 0 10 0M8 12.5V15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
// what the Ask button says in each state: on the step card, and on the fingertip bar in your room
const ASK: Record<CoachState, [string, string]> = {
  idle: ["Ask about this step", "Ask"],
  starting: ["Starting…", "Starting…"],
  listening: ["Listening…", "Listening…"],
  thinking: ["Thinking…", "Thinking…"],
  answering: ["Answering…", "Answering…"],
};
const PLACE_DISTANCE = 1.8; // meters in front of you when you enter the room
const LOAD_CONCURRENCY = 4;
const LONG_PINCH_MS = 800; // hold a pinch this long to bring the person in front of you
const SPEEDS = [1, 0.5, 0.25];

export async function renderViewer(root: HTMLElement, id: string) {
  root.innerHTML = `
    <div class="stage" id="stage"></div>
    <div id="place-scrim" style="position: fixed; inset: 0 0 auto 0; height: 120px; z-index: 9; pointer-events: none; opacity: 0; transition: opacity 0.6s ease; background: linear-gradient(rgba(0, 0, 0, 0.55), rgba(0, 0, 0, 0))"></div>
    <div class="topbar"><a class="back" href="./">${BACK}Dreams</a><div class="title"><div id="title"></div><div class="subtitle" id="subtitle"></div></div><div></div></div>
    <div class="loader" id="loader"><div class="loader-inner">
      <svg class="ring" viewBox="0 0 44 44"><circle class="track" cx="22" cy="22" r="19"/><circle class="bar" id="ring" cx="22" cy="22" r="19"/></svg>
      <h2 id="loading-title">Bringing them in</h2><p id="loading-pct">0%</p></div></div>
    <aside class="step-card" id="step-card" hidden>
      <p class="step-count" id="step-count"></p><h3 id="step-title"></h3><p class="step-tip" id="step-tip"></p>
      <div class="coach" id="coach" hidden aria-live="polite"><p class="coach-q" id="coach-q"></p><p class="coach-a" id="coach-a"></p></div>
      <div class="step-progress"><i id="step-bar"></i></div>
      <div class="step-nav"><button class="pill" id="step-back">Back</button><button class="pill" id="step-again">Again</button><button class="pill" id="step-next">Next</button></div>
      <button class="ask" id="ask" hidden aria-pressed="false" title="Ask the coach about this step (A)">${MIC}<span id="ask-label">${ASK.idle[0]}</span><span class="ask-level" aria-hidden="true"><i></i><i></i><i></i></span></button>
    </aside>
    <p class="cue" id="cue" hidden></p>
    <div class="controls" id="controls" hidden>
      <button class="play" id="play" aria-label="Play">${PAUSE}</button>
      <input type="range" id="scrub" min="0" max="1" step="0.001" value="0" aria-label="Scrub" />
      <span class="time" id="time">0.0 / 0.0 s</span>
      <div class="segmented" id="speeds"><button data-speed="0.25">0.25×</button><button data-speed="0.5">0.5×</button><button data-speed="1" class="on">1×</button></div>
      <button class="pill" id="place" title="Change the place around them (P)" aria-label="Place: Your room"><span style="color: var(--muted)">Place</span>&nbsp; <span id="place-name">Your room</span></button>
      <button class="pill" id="reality" hidden aria-pressed="false">Reality check</button>
      <button class="pill on" id="cc" hidden aria-pressed="true">Captions</button>
      <a class="pill" id="play-chess" hidden>Play chess</a>
      <button class="cta" id="room" hidden>View in your room</button>
    </div>`;
  const $ = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;

  let dream: Dream;
  try {
    dream = await loadDream(id);
  } catch (e) {
    $("#loading-title").textContent = "This dream isn't here yet";
    $("#loading-pct").textContent = String((e as Error).message);
    return;
  }
  document.title = `${dream.name} · Lucid Dreams`;
  $("#title").textContent = dream.name;
  $("#loading-title").textContent = `Bringing ${dream.name} in`;

  // ---------------- three + Spark ----------------
  const stage = $("#stage");
  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.setClearColor(0x000000, 0);
  stage.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.05, 100);
  const height = dream.bounds ? dream.bounds.max[1] : 1.8;
  camera.position.set(0, height * 0.58, Math.max(3.2, height * 2.3)); // whole body in frame, eye level-ish
  const spark = new SparkRenderer({ renderer });
  scene.add(spark);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, height * 0.47, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 0.8;
  controls.maxDistance = 8;
  controls.maxPolarAngle = Math.PI * 0.55;
  controls.update();

  // Places: a full 360-degree environment instead of your room (or, on a screen, the dark stage). Off: passthrough
  // only (Ojasva, Sat 3:30 AM: your own room reads as more real than any panorama). Flip PLACES to bring them back.
  const PLACES = false;
  const places = new Places(renderer);
  scene.add(places.group);

  // The person: a group placed on the floor. Front faces -Z in the bundle, so turn it to face the viewer.
  const person = new THREE.Group();
  person.rotation.y = Math.PI;
  scene.add(person);
  person.add(floorShadow(dream));
  // the objects around them (the ball, a hoop): in their space, so wherever they're placed the props come along
  const propsReady = loadProps(dream, renderer).catch((e) => {
    console.warn("Showing the person without props.", e);
    return null;
  });

  // ---------------- frames ----------------
  const count = dream.kind === "replay" ? dream.frameCount : 1;
  const frames: (SplatMesh | null)[] = new Array(count).fill(null);
  const realityFrames: (SplatMesh | null)[] = new Array(count).fill(null);
  let active = frames;
  let loaded = 0;
  const ring = $<HTMLElement>("#ring") as unknown as SVGCircleElement;
  const circumference = 2 * Math.PI * 19;
  ring.style.strokeDasharray = `${circumference}`;
  ring.style.strokeDashoffset = `${circumference}`;
  const onProgress = () => {
    const pct = Math.round((loaded / count) * 100);
    $("#loading-pct").textContent = `${pct}%`;
    ring.style.strokeDashoffset = `${circumference * (1 - loaded / count)}`;
  };
  const queue = Array.from({ length: count }, (_, i) => i);
  const loadInto = async (target: (SplatMesh | null)[], reality: boolean, q: number[], progress?: () => void) => {
    for (let i = q.shift(); i !== undefined; i = q.shift()) {
      const url = dream.kind === "replay" ? dreamUrl(dream.id, framePath(dream, i, reality)) : dreamUrl(dream.id, dream.avatar!.file);
      const mesh = new SplatMesh({ url });
      await mesh.initialized;
      mesh.visible = false;
      person.add(mesh);
      target[i] = mesh;
      progress?.();
    }
  };
  const worker = () => loadInto(frames, false, queue, () => {
    loaded++;
    onProgress();
  });
  // an avatar with a rig moves live (any motion, one Gaussian file); everything else plays its frames
  let avatar: SkinnedAvatar | null = null;
  if (SkinnedAvatar.canSkin(dream)) {
    try {
      avatar = await SkinnedAvatar.load(dream);
      person.add(avatar.mesh);
      loaded = count;
      onProgress();
    } catch (e) {
      console.warn("Showing the rest pose: the rig didn't load.", e);
    }
  }
  if (!avatar) await Promise.all(Array.from({ length: Math.min(LOAD_CONCURRENCY, count) }, worker));
  const props = await propsReady;
  if (props) {
    person.add(props.group);
    if (props.hoops.length) frameWithHoop(camera, controls, person, dream, props.hoops[0]);
  }
  $("#loader").classList.add("done");
  $("#controls").hidden = false;

  // ---------------- playback ----------------
  // Their voice comes from where they stand: positional (HRTF) audio at mouth height, heard through the headset or
  // the laptop the way a real person in the room would sound. Prefers the cleaned-up voice track when the bundle has one.
  const track = dream.voice ?? dream.audio;
  const audio = track ? new Audio(dreamUrl(dream.id, track)) : null;
  const listener = new THREE.AudioListener();
  camera.add(listener);
  if (audio) {
    audio.crossOrigin = "anonymous";
    audio.preservesPitch = true;
    const voice = new THREE.PositionalAudio(listener);
    voice.setMediaElementSource(audio);
    voice.setDistanceModel("inverse");
    voice.setRefDistance(1.2);
    voice.setRolloffFactor(1.1);
    voice.panner.panningModel = "HRTF";
    const mouth = dream.bounds ? dream.bounds.max[1] - 0.13 : 1.6;
    voice.position.set(0, mouth, -0.08); // the person's front is -Z in their own space
    person.add(voice);
  }
  // browsers only start audio after a tap or click
  const wake = () => listener.context.state !== "running" && listener.context.resume().catch(() => {});
  addEventListener("pointerdown", wake);
  addEventListener("keydown", wake);
  let playing = true;
  let speed = 1;
  let t = 0; // seconds into the clip
  let shown = -1;
  const duration = avatar ? avatar.duration : Math.max(dream.durationS, 1 / dream.fps);
  // what you came to do with them (experience.json, written from your intent)
  const experience = (await loadExperience(dream)) ?? fallbackExperience(dream, duration);
  const steps = (experience?.steps ?? []).map((st) => ({ ...st, end: Math.min(st.end, duration) })).filter((st) => st.end > st.start);
  const lesson = experience?.mode === "teach" && steps.length ? new Lesson(steps) : null;
  // eye contact: someone you're with or playing against looks at you (a teacher looks at the move)
  const look = avatar && (experience?.mode === "companion" || experience?.mode === "play") ? new HeadLook() : null;
  const eye = new THREE.Vector3();
  if (experience?.title) $("#subtitle").textContent = experience.title;
  if (experience?.mode === "play" && experience.play?.game === "chess") {
    const a = $<HTMLAnchorElement>("#play-chess");
    a.href = `?mode=chess&opponent=${encodeURIComponent(dream.id)}&strength=${encodeURIComponent(experience.play.strength ?? "gm")}`;
    a.textContent = `Play chess with ${dream.name}`;
    a.hidden = false;
  }

  // ---------------- places: a concert hall, a court, a ring around them instead of your room ----------------
  const placeBtn = $("#place");
  placeBtn.hidden = !PLACES;
  let xrPlace: XrButton | null = null;
  const placedForward = new THREE.Vector3(0, 0, -1); // the way you faced when they were last placed in your room
  places.onChange = (p: Place | null) => {
    const name = p?.name ?? "Your room";
    $("#place-name").textContent = name;
    placeBtn.classList.toggle("on", !!p);
    placeBtn.setAttribute("aria-label", `Place: ${name}`);
    $("#place-scrim").style.opacity = p ? "1" : "0"; // keeps the title readable over a bright place
    xrPlace?.setLabel(name);
    xrPlace?.setOn(!!p);
  };
  // seen from where you are, with its interesting side (the stage, the corner) ahead of you and behind the person
  const anchorPlace = () => {
    if (renderer.xr.isPresenting) places.anchor(renderer.xr.getCamera().getWorldPosition(new THREE.Vector3()), placedForward);
    else places.anchor(camera.position, controls.target.clone().sub(camera.position));
  };
  const setPlace = (p: Place | null) => {
    if (!places.visible) anchorPlace();
    void places.set(p);
  };
  const cyclePlace = () => setPlace(nextPlace(places.current));
  placeBtn.addEventListener("click", cyclePlace);
  // ?place= (a demo link), else experience.json's "environment", else what the intent suggests, else your room
  setPlace(PLACES ? startingPlace(new URLSearchParams(location.search).get("place") ?? experience?.environment, experience?.intent ?? dream.intent) : null);

  let reveal = 0; // 0 -> 1 over the first moments: the person materialises instead of popping in
  const show = (i: number, force = false) => {
    if (active[i]) active[i]!.opacity = reveal;
    if (i === shown && !force) return;
    for (const set of [frames, realityFrames]) if (shown >= 0 && set[shown]) set[shown]!.visible = false;
    if (active[i]) active[i]!.visible = true;
    shown = i;
  };
  const syncAudio = () => {
    if (!audio) return;
    audio.playbackRate = speed;
    if (Math.abs(audio.currentTime - t) > 0.12) audio.currentTime = t;
    const audible = playing && lesson?.phase !== "turn"; // quiet while it's your turn
    if (audible && audio.paused) audio.play().catch(() => {});
    if (!audible && !audio.paused) audio.pause();
  };
  const playBtn = $("#play");
  let xrPlay: XrButton | null = null;
  let xrSpeed: XrButton | null = null;
  const setPlaying = (p: boolean) => {
    playing = p;
    playBtn.innerHTML = p ? PAUSE : PLAY;
    playBtn.setAttribute("aria-label", p ? "Pause" : "Play");
    xrPlay?.setLabel(p ? "Pause" : "Play");
    syncAudio();
  };
  playBtn.addEventListener("click", () => setPlaying(!playing));
  const scrub = $<HTMLInputElement>("#scrub");
  scrub.addEventListener("input", () => {
    t = Number(scrub.value) * duration;
    syncAudio();
  });
  const setSpeed = (v: number) => {
    speed = v;
    root.querySelectorAll<HTMLButtonElement>("#speeds button").forEach((x) => x.classList.toggle("on", Number(x.dataset.speed) === v));
    xrSpeed?.setLabel(`${v}×`);
    syncAudio();
  };
  root.querySelectorAll<HTMLButtonElement>("#speeds button").forEach((b) => b.addEventListener("click", () => setSpeed(Number(b.dataset.speed))));

  // ---------------- a lesson: watch each step slowed down, then your turn ----------------
  const stepCard = new StepCard();
  const stepCardGroup = new THREE.Group();
  stepCardGroup.add(stepCard.mesh);
  stepCard.mesh.scale.setScalar(0.66);
  stepCardGroup.visible = false;
  scene.add(stepCardGroup);

  // ---------------- Ask: the coach (Gemini Live) answers out loud about the step on screen ----------------
  // Only in a lesson, and only when the bridge has a Gemini key (no dead button otherwise). The teacher pauses while
  // you ask; the answer is read in the device's voice, like the tips. Stops (mic released) when the step changes.
  const askBtn = $("#ask");
  let xrAsk: XrButton | null = null;
  let askedAbout = -1; // the step the coach's note is about
  let resumeAfterAsk = false;
  const note = { q: "", a: "" };
  const showNote = () => {
    $("#coach").hidden = !note.q && !note.a;
    $("#coach-q").hidden = !note.q;
    $("#coach-q").textContent = note.q ? `You asked: “${note.q}”` : "";
    $("#coach-a").hidden = !note.a;
    $("#coach-a").textContent = note.a;
    stepCard.note = note.a ? { label: "Coach", text: note.a } : note.q ? { label: "You asked", text: note.q } : null;
    if (lesson) stepCard.draw(lesson, performance.now());
  };
  const coach = lesson
    ? new Coach({
        state: (s) => {
          const on = s !== "idle";
          askBtn.dataset.state = s;
          askBtn.classList.toggle("on", on);
          askBtn.setAttribute("aria-pressed", String(on));
          $("#ask-label").textContent = ASK[s][0];
          xrAsk?.setLabel(ASK[s][1]);
          xrAsk?.setOn(on);
        },
        heard: (q) => {
          note.q = q;
          showNote();
        },
        answer: (a) => {
          note.a = a;
          showNote();
        },
        error: (message) => {
          note.q = "";
          note.a = message;
          showNote();
        },
        end: () => {
          if (resumeAfterAsk) setPlaying(true);
          resumeAfterAsk = false;
        },
      })
    : null;
  const ask = () => {
    if (!coach || !lesson || askBtn.hidden) return;
    if (coach.active) return coach.stop();
    // they stop to listen, the way a teacher does when you put your hand up
    resumeAfterAsk = playing;
    setPlaying(false);
    askedAbout = lesson.i;
    note.q = note.a = "";
    showNote();
    const st = lesson.step;
    void coach.start({
      dream: dream.id,
      index: lesson.i,
      count: lesson.steps.length,
      title: st.title,
      tip: st.tip,
      start: st.start,
      end: st.end,
      speed: lesson.speed,
      at: Math.round(t * 10) / 10,
      plan: { title: experience?.title, intent: experience?.intent ?? dream.intent ?? undefined },
    });
  };
  askBtn.addEventListener("click", ask);
  addEventListener("pagehide", () => coach?.stop());

  let lastSaid = "";
  const showStep = () => {
    if (!lesson) return;
    if (lesson.i !== askedAbout) {
      // a new step: the coach was answering about the last one (stop it before this step's tip is read)
      coach?.stop();
      askedAbout = lesson.i;
      if (note.q || note.a) {
        note.q = note.a = "";
        showNote();
      }
    }
    const st = lesson.step;
    $("#step-card").hidden = false;
    $("#step-count").textContent = lesson.phase === "turn" ? "Your turn" : `Step ${lesson.i + 1} of ${lesson.steps.length}`;
    $("#step-title").textContent = st.title;
    $("#step-tip").textContent = st.tip ?? "";
    $("#step-card").classList.toggle("turn", lesson.phase === "turn");
    stepCard.draw(lesson, performance.now());
    if (lesson.phase === "watch") {
      setSpeed(lesson.speed);
      t = st.start;
    }
    const line = lesson.phase === "turn" ? "Your turn." : `${st.title}. ${st.tip ?? ""}`;
    if (line !== lastSaid) {
      // the lesson moved on (Again, or the turn): the device never reads it over the coach, nor into its open mic
      coach?.stop();
      say((lastSaid = line));
    }
    syncAudio();
  };
  if (lesson) {
    lesson.onChange = showStep;
    $("#step-back").addEventListener("click", () => lesson.go(lesson.i - 1));
    $("#step-again").addEventListener("click", () => {
      lastSaid = "";
      lesson.go(lesson.i);
    });
    $("#step-next").addEventListener("click", () => lesson.go(lesson.i + 1));
    showStep();
  }
  addEventListener("keydown", (e) => {
    if (e.code === "Space") {
      e.preventDefault();
      setPlaying(!playing);
    }
    if (PLACES && e.code === "KeyP" && !e.metaKey && !e.ctrlKey && !e.altKey) cyclePlace();
    if (e.code === "KeyA" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.repeat) ask();
  });
  syncAudio();

  // ---------------- reality check: what the camera really saw vs what was imagined ----------------
  const realityBtn = $("#reality");
  const seenPct = dream.metrics?.seenFraction != null ? Math.round(dream.metrics.seenFraction * 100) : null;
  if ((dream.kind === "replay" && dream.frames?.reality) || (avatar && dream.avatar?.reality)) realityBtn.hidden = false;
  let avatarReality: SkinnedAvatar | null = null;
  let avatarRealityOn = false;
  let realityLoaded: Promise<void> | null = null;
  const toggleReality = async (): Promise<boolean> => {
    if (avatar) {
      // an avatar's reality file has the same Gaussians in the same order, so it skins and moves identically
      const on = !avatarRealityOn;
      if (on && !avatarReality) {
        realityBtn.textContent = "Loading…";
        avatarReality = await SkinnedAvatar.load(dream, avatar.motion, dream.avatar!.reality!);
        person.add(avatarReality.mesh);
      }
      avatarRealityOn = on;
      avatar.mesh.visible = !on;
      avatarReality!.mesh.visible = on;
      realityBtn.textContent = "Reality check";
      realityBtn.classList.toggle("on", on);
      realityBtn.setAttribute("aria-pressed", String(on));
      $("#subtitle").textContent = on && seenPct != null ? `${seenPct}% seen in the photo · blue was imagined` : "";
      return on;
    }
    const on = active === frames;
    if (on && !realityLoaded) {
      realityBtn.textContent = "Loading…";
      const q = Array.from({ length: count }, (_, i) => i);
      realityLoaded = Promise.all(Array.from({ length: LOAD_CONCURRENCY }, () => loadInto(realityFrames, true, q))).then(() => {});
      await realityLoaded;
    }
    active = on ? realityFrames : frames;
    realityBtn.textContent = "Reality check";
    realityBtn.classList.toggle("on", on);
    realityBtn.setAttribute("aria-pressed", String(on));
    $("#subtitle").textContent = on && seenPct != null ? `${seenPct}% seen by the camera · blue was imagined` : "";
    show(shown < 0 ? 0 : shown, true);
    return on;
  };
  realityBtn.addEventListener("click", () => void toggleReality());

  // ---------------- captions: what they say, beside them ----------------
  let cues: Cue[] = [];
  let captionsOn = true;
  const cueEl = $("#cue");
  const ccBtn = $("#cc");
  const spoken = new SpatialCaption();
  // in front of them at chest height, toward you (their front is -Z), so it never cuts through their body
  spoken.mesh.position.set(0, height * 0.6, -0.42);
  spoken.mesh.rotation.y = Math.PI;
  person.add(spoken.mesh);
  if (dream.captions)
    fetch(dreamUrl(dream.id, dream.captions), { cache: "no-cache" })
      .then((r) => (r.ok ? r.text() : ""))
      .then((vtt) => {
        cues = parseVtt(vtt);
        ccBtn.hidden = cues.length === 0;
      })
      .catch(() => {});
  ccBtn.addEventListener("click", () => {
    captionsOn = !captionsOn;
    ccBtn.classList.toggle("on", captionsOn);
    ccBtn.setAttribute("aria-pressed", String(captionsOn));
  });

  // ---------------- your room (WebXR passthrough) ----------------
  // hands only: your real hands stay in front of the person, and a small bar of fingertip buttons sits within reach
  const hands = [0, 1].map((i) => renderer.xr.getHand(i));
  hands.forEach((h) => scene.add(h));
  const occluders = hands.map((h) => handOccluder(h, scene));
  const bar = new THREE.Group();
  const tilt = new THREE.Group();
  tilt.rotation.x = -0.75; // faces up toward your eyes
  bar.add(tilt);
  bar.visible = false;
  scene.add(bar);
  const xrButtons: XrButton[] = [];
  xrPlay = new XrButton("play", "Pause", () => setPlaying(!playing));
  xrSpeed = new XrButton("speed", "1×", () => setSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]));
  xrButtons.push(xrPlay);
  if (lesson)
    xrButtons.push(
      new XrButton("back", "Back", () => lesson.go(lesson.i - 1)),
      new XrButton("again", "Again", () => {
        lastSaid = "";
        lesson.go(lesson.i);
      }),
      new XrButton("next", "Next", () => lesson.go(lesson.i + 1)),
    );
  else xrButtons.push(xrSpeed);
  if (!realityBtn.hidden) {
    const xrReality: XrButton = new XrButton("reality", "Reality check", () => void toggleReality().then((on) => xrReality.setOn(on)));
    xrButtons.push(xrReality);
  }
  xrButtons.push(new XrButton("here", "Bring here", () => (placeNextFrame = true)));
  xrButtons.forEach((b, i) => {
    b.mesh.position.x = (i - (xrButtons.length - 1) / 2) * 0.1;
    tilt.add(b.mesh);
  });
  // the place on a row of its own just beyond the others: Your room -> each place -> back
  if (PLACES) {
    xrPlace = new XrButton("place", places.current?.name ?? "Your room", cyclePlace);
    xrPlace.setOn(!!places.current);
    xrPlace.mesh.position.y = 0.045;
    tilt.add(xrPlace.mesh);
    xrButtons.push(xrPlace);
  }
  // Ask shares that row, to the right of the place, once the bridge says the coach is on
  if (coach) {
    xrAsk = new XrButton("ask", ASK.idle[1], ask);
    xrAsk.mesh.visible = false; // hidden buttons can't be pressed
    xrAsk.mesh.position.set(PLACES ? 0.05 : 0, 0.045, 0);
    tilt.add(xrAsk.mesh);
    xrButtons.push(xrAsk);
    const placeBtn3d = xrPlace;
    void coachAvailable().then((on) => {
      if (!on) return console.info("Ask is off: the bridge on :5170 has no Gemini key, or isn't running.");
      askBtn.hidden = false;
      xrAsk!.mesh.visible = true;
      if (placeBtn3d) placeBtn3d.mesh.position.x = -0.05;
    });
  }

  const caption = spatialCaption(dream.name, "Pinch to pause  ·  Hold the pinch to bring them here");
  caption.visible = false;
  person.add(caption);
  let captionUntil = 0;
  let placeNextFrame = false;
  const pinches = new Map<XRInputSource, number>();
  const xr = new SparkXr({
    renderer,
    mode: "ar",
    referenceSpaceType: "local-floor",
    button: false,
    enableHands: true,
    onEnterXr: () => {
      scene.background = null;
      placeNextFrame = true;
      reveal = 0; // they arrive in your room, rather than already standing there
      const session = renderer.xr.getSession();
      // a quick pinch pauses or plays; holding it brings them in front of you (works with hands or controllers)
      session?.addEventListener("selectstart", (e) => pinches.set(e.inputSource, performance.now()));
      session?.addEventListener("selectend", (e) => {
        if (!pinches.delete(e.inputSource)) return; // already used as a long pinch
        setPlaying(!playing);
        captionUntil = performance.now() + 4000;
      });
      session?.addEventListener("squeeze", () => (placeNextFrame = true));
      bar.visible = true;
      stepCardGroup.visible = !!lesson;
      caption.visible = true;
      captionUntil = performance.now() + 7000;
    },
    onExitXr: () => {
      coach?.stop(); // leaving the room ends the question: the mic is released
      bar.visible = false;
      stepCardGroup.visible = false;
      pinches.clear();
      person.position.set(0, 0, 0);
      person.rotation.y = Math.PI;
      caption.visible = false;
      places.anchor(camera.position, controls.target.clone().sub(camera.position));
    },
    onReady: (supported) => {
      $("#room").hidden = !supported;
    },
  });
  $("#room").addEventListener("click", () => {
    wake();
    xr.toggleXr();
  });

  const head = new THREE.Vector3();
  const forward = new THREE.Vector3();
  const placeInFrontOfYou = () => {
    const cam = renderer.xr.getCamera();
    cam.getWorldPosition(head);
    cam.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    forward.normalize();
    const right = new THREE.Vector3(-forward.z, 0, forward.x);
    const place = experience?.place ?? "facing";
    if (place === "beside") {
      // at your side, facing the way you face: copy them like the person next to you in a class
      person.position.set(head.x + right.x * 0.8 + forward.x * 0.5, 0, head.z + right.z * 0.8 + forward.z * 0.5);
      person.rotation.y = Math.atan2(forward.x, forward.z) + Math.PI;
    } else if (place === "ahead") {
      // in front of you, facing away: follow them like the teacher at the front of the room
      person.position.set(head.x + forward.x * 1.5, 0, head.z + forward.z * 1.5);
      person.rotation.y = Math.atan2(forward.x, forward.z) + Math.PI;
    } else {
      person.position.set(head.x + forward.x * PLACE_DISTANCE, 0, head.z + forward.z * PLACE_DISTANCE);
      person.rotation.y = Math.atan2(forward.x, forward.z); // front (-Z) turned to face you
    }
    // the step card: at eye level, off to the right so it never hides them
    stepCardGroup.position.set(head.x + forward.x * 0.95 + right.x * 0.42, head.y - 0.08, head.z + forward.z * 0.95 + right.z * 0.42);
    stepCardGroup.rotation.y = Math.atan2(-forward.x, -forward.z) - 0.35;
    // the control bar: within reach, a little below your eyes, between you and them
    bar.position.set(head.x + forward.x * 0.42, Math.max(0.7, head.y - 0.42), head.z + forward.z * 0.42);
    bar.rotation.y = Math.atan2(-forward.x, -forward.z);
    // the place re-centres on you too: its stage ahead of you, behind them (for any `place`: facing, beside or ahead)
    placedForward.copy(forward);
    places.anchor(head, forward);
  };

  // ---------------- loop ----------------
  const clock = new THREE.Clock();
  addEventListener("resize", () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });
  const timeLabel = $("#time");
  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.1);
    if (renderer.xr.isPresenting) {
      const now = performance.now();
      for (const [src, t0] of pinches)
        if (now - t0 > LONG_PINCH_MS) {
          pinches.delete(src);
          placeNextFrame = true;
        }
      if (placeNextFrame) {
        placeInFrontOfYou();
        placeNextFrame = false;
      }
      occluders.forEach((o) => o());
      const tips = fingertips(hands);
      for (const b of xrButtons) b.touch(tips, now);
    }
    if (lesson) {
      if (playing && lesson.phase === "watch") t = Math.min(t + dt * speed, duration);
      if (playing) t = lesson.update(t, performance.now());
      if (lesson.phase === "turn") {
        const pct = lesson.turnProgress(performance.now());
        $("#step-bar").style.width = `${pct * 100}%`;
        if (renderer.xr.isPresenting && Math.floor(pct * 30) !== Math.floor((pct - dt) * 30)) stepCard.draw(lesson, performance.now());
      }
    } else if (playing) t = (t + dt * speed) % duration;
    reveal = Math.min(1, reveal + dt / 1.4);
    if (renderer.xr.isPresenting) {
      const target = !playing || performance.now() < captionUntil ? 1 : 0;
      const m = caption.material as THREE.MeshBasicMaterial;
      m.opacity += (target - m.opacity) * Math.min(1, dt * 4);
    }
    const cue = captionsOn ? cueAt(cues, t) : null;
    if (cueEl.textContent !== (cue?.text ?? "")) cueEl.textContent = cue?.text ?? "";
    cueEl.hidden = !cue || renderer.xr.isPresenting;
    if (cue) spoken.set(cue.text);
    spoken.fade(!!cue && renderer.xr.isPresenting, dt);
    if (avatar) {
      const shownAvatar = avatarRealityOn && avatarReality ? avatarReality : avatar;
      if (look) {
        // your eyes (the headset, or the laptop's camera) in the person's own space
        (renderer.xr.isPresenting ? renderer.xr.getCamera() : camera).getWorldPosition(eye);
        shownAvatar.mesh.worldToLocal(eye);
        shownAvatar.pose(t, (local, rootT, skeleton) => look.apply(local, rootT, skeleton, eye, dt));
      } else shownAvatar.pose(t);
      shownAvatar.mesh.opacity = reveal;
    } else show(Math.min(count - 1, Math.floor(t * dream.fps)));
    props?.update(t, dt, reveal);
    places.update(dt);
    if (coach?.state === "listening") askBtn.style.setProperty("--level", coach.level.toFixed(2));
    if (document.activeElement !== scrub) scrub.value = String(t / duration);
    timeLabel.textContent = `${t.toFixed(1)} / ${duration.toFixed(1)} s`;
    if (!renderer.xr.isPresenting) controls.update();
    renderer.render(scene, camera);
  });
  if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__viewer = { camera, controls, person, places, setPlace, renderer };
}

/** A soft contact shadow under the feet, so the person reads as standing on the floor rather than floating. */
function floorShadow(dream: Dream): THREE.Mesh {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(0,0,0,0.42)");
  g.addColorStop(0.45, "rgba(0,0,0,0.18)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const b = dream.bounds;
  const w = b ? Math.max(0.6, (b.max[0] - b.min[0]) * 1.4) : 0.9;
  const d = b ? Math.max(0.5, (b.max[2] - b.min[2]) * 1.4) : 0.7;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(w, d),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true, depthWrite: false }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.002;
  mesh.renderOrder = -1;
  return mesh;
}

/**
 * With a hoop in the room the desktop view comes round to the shooter's right side, just in front of side-on so their
 * face still shows: the person whole and as large as fits, the ring beyond them (the board may be cut off). If the
 * screen is too narrow for both, the usual front view stays.
 */
function frameWithHoop(camera: THREE.PerspectiveCamera, controls: OrbitControls, person: THREE.Object3D, dream: Dream, rimLocal: THREE.Vector3) {
  person.updateMatrixWorld(true);
  const b = dream.bounds ?? { min: [-0.4, 0, -0.3], max: [0.4, 1.8, 0.3] };
  const rim = person.localToWorld(rimLocal.clone());
  const body = person.localToWorld(new THREE.Vector3(0, b.max[1] / 2, 0));
  const toward = rim.clone().sub(body).setY(0);
  const far = toward.length();
  if (far < 0.5) return; // standing under it: the front view already shows both
  toward.divideScalar(far);
  const right = new THREE.Vector3(-toward.z, 0, toward.x); // a right-handed shooter's ball side
  const angle = THREE.MathUtils.degToRad(86);
  const view = toward.clone().multiplyScalar(Math.cos(angle)).addScaledVector(right, Math.sin(angle));
  const corners: THREE.Vector3[] = [];
  for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) corners.push(person.localToWorld(new THREE.Vector3(x, y, z)));
  const inFrame = (pts: THREE.Vector3[], m: number) =>
    pts.every((p) => {
      const q = p.clone().project(camera);
      return Math.abs(q.x) < m && Math.abs(q.y) < m && q.z < 1;
    });
  const from = camera.position.clone();
  for (let d = 3.6; d <= 7.2; d += 0.2)
    for (const lead of [0.3, 0.4, 0.2, 0.5, 0.1]) {
      const target = body.clone().addScaledVector(toward, far * lead).setY(rim.y * 0.42);
      camera.position.copy(target).addScaledVector(view, d).setY(1.4);
      camera.lookAt(target);
      camera.updateMatrixWorld();
      if (inFrame(corners, 0.88) && inFrame([rim], 0.96)) {
        controls.target.copy(target);
        controls.maxDistance = Math.max(controls.maxDistance, d + 2);
        controls.update();
        return;
      }
    }
  camera.position.copy(from);
  camera.lookAt(controls.target);
  camera.updateMatrixWorld();
}

/** A small floating label beside the person, set like system text: the name, then a hint. Faces the viewer. */
function spatialCaption(title: string, hint: string): THREE.Mesh {
  const w = 1024, h = 256;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "rgba(29,29,31,0.72)";
  const r = 72;
  ctx.beginPath();
  ctx.roundRect(8, 8, w - 16, h - 16, r);
  ctx.fill();
  ctx.fillStyle = "#f5f5f7";
  ctx.font = '600 72px -apple-system, "SF Pro Display", "Inter", sans-serif';
  ctx.textAlign = "center";
  ctx.fillText(title, w / 2, 118);
  ctx.fillStyle = "#a1a1a6";
  ctx.font = '500 40px -apple-system, "SF Pro Text", "Inter", sans-serif';
  ctx.fillText(hint, w / 2, 190);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(0.64, 0.16),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0, depthWrite: false }),
  );
  // beside the person at chest height, turned toward the viewer (the person group faces -Z)
  mesh.position.set(-0.62, 1.25, -0.15);
  mesh.rotation.y = Math.PI;
  return mesh;
}
