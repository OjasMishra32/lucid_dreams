import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { SparkRenderer, SparkXr, SplatMesh } from "@sparkjsdev/spark";
import { type Dream, dreamUrl, framePath, loadDream } from "./dream";

// Bundle coordinates: meters, +Y up, feet on y = 0, the person's front faces -Z. In the room we use the WebXR
// "local-floor" space, so y = 0 is the real floor and nothing is ever scaled: the person is exactly their real size.

const PLAY = `<svg viewBox="0 0 16 16"><path d="M4 2.5v11l9-5.5z"/></svg>`;
const PAUSE = `<svg viewBox="0 0 16 16"><path d="M3.5 2h3v12h-3zM9.5 2h3v12h-3z"/></svg>`;
const BACK = `<svg viewBox="0 0 12 20"><path d="M10 2 2 10l8 8" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const PLACE_DISTANCE = 1.8; // meters in front of you when you enter the room
const LOAD_CONCURRENCY = 4;

export async function renderViewer(root: HTMLElement, id: string) {
  root.innerHTML = `
    <div class="stage" id="stage"></div>
    <div class="topbar"><a class="back" href="./">${BACK}Dreams</a><div class="title"><div id="title"></div><div class="subtitle" id="subtitle"></div></div><div></div></div>
    <div class="loader" id="loader"><div class="loader-inner">
      <svg class="ring" viewBox="0 0 44 44"><circle class="track" cx="22" cy="22" r="19"/><circle class="bar" id="ring" cx="22" cy="22" r="19"/></svg>
      <h2 id="loading-title">Bringing them in</h2><p id="loading-pct">0%</p></div></div>
    <div class="controls" id="controls" hidden>
      <button class="play" id="play" aria-label="Play">${PAUSE}</button>
      <input type="range" id="scrub" min="0" max="1" step="0.001" value="0" aria-label="Scrub" />
      <span class="time" id="time">0.0 / 0.0 s</span>
      <div class="segmented" id="speeds"><button data-speed="0.25">0.25×</button><button data-speed="0.5">0.5×</button><button data-speed="1" class="on">1×</button></div>
      <button class="pill" id="reality" hidden aria-pressed="false">Reality check</button>
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

  // The person: a group placed on the floor. Front faces -Z in the bundle, so turn it to face the viewer.
  const person = new THREE.Group();
  person.rotation.y = Math.PI;
  scene.add(person);
  person.add(floorShadow(dream));

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
  await Promise.all(Array.from({ length: Math.min(LOAD_CONCURRENCY, count) }, worker));
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
  const duration = Math.max(dream.durationS, 1 / dream.fps);
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
    if (playing && audio.paused) audio.play().catch(() => {});
    if (!playing && !audio.paused) audio.pause();
  };
  const playBtn = $("#play");
  const setPlaying = (p: boolean) => {
    playing = p;
    playBtn.innerHTML = p ? PAUSE : PLAY;
    playBtn.setAttribute("aria-label", p ? "Pause" : "Play");
    syncAudio();
  };
  playBtn.addEventListener("click", () => setPlaying(!playing));
  const scrub = $<HTMLInputElement>("#scrub");
  scrub.addEventListener("input", () => {
    t = Number(scrub.value) * duration;
    syncAudio();
  });
  root.querySelectorAll<HTMLButtonElement>("#speeds button").forEach((b) =>
    b.addEventListener("click", () => {
      speed = Number(b.dataset.speed);
      root.querySelectorAll("#speeds button").forEach((x) => x.classList.toggle("on", x === b));
      syncAudio();
    }),
  );
  addEventListener("keydown", (e) => {
    if (e.code === "Space") {
      e.preventDefault();
      setPlaying(!playing);
    }
  });
  syncAudio();

  // ---------------- reality check: what the camera really saw vs what was imagined ----------------
  const realityBtn = $("#reality");
  const seenPct = dream.metrics?.seenFraction != null ? Math.round(dream.metrics.seenFraction * 100) : null;
  if (dream.kind === "replay" && dream.frames?.reality) realityBtn.hidden = false;
  let realityLoaded: Promise<void> | null = null;
  realityBtn.addEventListener("click", async () => {
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
  });

  // ---------------- your room (WebXR passthrough) ----------------
  const caption = spatialCaption(dream.name, "Pinch to pause  ·  Squeeze to bring them here");
  caption.visible = false;
  person.add(caption);
  let captionUntil = 0;
  let placeNextFrame = false;
  const xr = new SparkXr({
    renderer,
    mode: "ar",
    referenceSpaceType: "local-floor",
    button: false,
    enableHands: true,
    onEnterXr: () => {
      scene.background = null;
      placeNextFrame = true;
      const session = renderer.xr.getSession();
      session?.addEventListener("select", () => {
        setPlaying(!playing);
        captionUntil = performance.now() + 4000;
      });
      session?.addEventListener("squeeze", () => (placeNextFrame = true));
      caption.visible = true;
      captionUntil = performance.now() + 7000;
    },
    onExitXr: () => {
      person.position.set(0, 0, 0);
      person.rotation.y = Math.PI;
      caption.visible = false;
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
    person.position.set(head.x + forward.x * PLACE_DISTANCE, 0, head.z + forward.z * PLACE_DISTANCE);
    person.rotation.y = Math.atan2(forward.x, forward.z); // front (-Z) turned to face you
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
    if (renderer.xr.isPresenting && placeNextFrame) {
      placeInFrontOfYou();
      placeNextFrame = false;
    }
    if (playing) t = (t + dt * speed) % duration;
    reveal = Math.min(1, reveal + dt / 1.4);
    if (renderer.xr.isPresenting) {
      const target = !playing || performance.now() < captionUntil ? 1 : 0;
      const m = caption.material as THREE.MeshBasicMaterial;
      m.opacity += (target - m.opacity) * Math.min(1, dt * 4);
    }
    show(Math.min(count - 1, Math.floor(t * dream.fps)));
    if (document.activeElement !== scrub) scrub.value = String(t / duration);
    timeLabel.textContent = `${t.toFixed(1)} / ${duration.toFixed(1)} s`;
    if (!renderer.xr.isPresenting) controls.update();
    renderer.render(scene, camera);
  });
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
