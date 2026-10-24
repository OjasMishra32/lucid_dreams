import "./styles.css";
import { REPO_URL } from "./config";
import { mountHeroGl } from "./heroGl";
import { Typer } from "./typer";
import { clamp01, onTick, reducedMotion, smooth, webgl2Available } from "./motion";

const $ = <T extends HTMLElement = HTMLElement>(s: string, root: ParentNode = document) => root.querySelector<T>(s)!;
const $$ = <T extends HTMLElement = HTMLElement>(s: string, root: ParentNode = document) => Array.from(root.querySelectorAll<T>(s));
const root = document.documentElement;
root.classList.add("js");
const has3d = webgl2Available();
const still = reducedMotion();

$$<HTMLAnchorElement>("[data-repo]").forEach((a) => (a.href = REPO_URL));

// ---------------------------------------------------------------- scroll scenes

/** 0 at the top of a tall sticky track, 1 when its sticky child is about to leave. */
const trackProgress = (track: HTMLElement) => {
  const r = track.getBoundingClientRect();
  return clamp01(-r.top / Math.max(1, r.height - innerHeight));
};
/** 0 when an element's top meets the bottom of the screen, 1 when its bottom leaves the top. */
const passProgress = (el: HTMLElement) => {
  const r = el.getBoundingClientRect();
  return clamp01((innerHeight - r.top) / (innerHeight + r.height));
};

interface Scene {
  el: HTMLElement;
  near: boolean;
  beats: { el: HTMLElement; a: number; b: number }[];
  update?: (p: number, dt: number, now: number) => void;
}
const scenes = new Map<string, Scene>();
const nearby = new IntersectionObserver(
  (entries) => entries.forEach((e) => (scenes.get((e.target as HTMLElement).dataset.scene!)!.near = e.isIntersecting)),
  { rootMargin: "60% 0px" },
);
for (const el of $$("[data-scene]")) {
  const beats = $$("[data-beat]", el).map((b) => {
    const [a, z] = b.dataset.beat!.split(" ").map(Number);
    return { el: b, a, b: z };
  });
  scenes.set(el.dataset.scene!, { el, near: false, beats });
  nearby.observe(el);
}
const scene = (name: string, update: Scene["update"]) => (scenes.get(name)!.update = update);
const progressOf = (name: string) => trackProgress(scenes.get(name)!.el);

onTick((dt, now) => {
  for (const s of scenes.values()) {
    if (!s.near) continue;
    const p = trackProgress(s.el);
    for (const b of s.beats) b.el.classList.toggle("on", p >= b.a && p < b.b);
    s.update?.(p, dt, now);
  }
});

/** Videos that play only while on screen (and never on their own with reduced motion). */
const inView = new IntersectionObserver(
  (entries) =>
    entries.forEach((e) => {
      const v = e.target as HTMLVideoElement;
      if (e.isIntersecting) {
        for (const s of $$<HTMLSourceElement>("source[data-src]", v)) {
          s.src = s.dataset.src!;
          s.removeAttribute("data-src");
          v.load();
        }
        if (!still) v.play().catch(() => {});
      } else v.pause();
    }),
  { rootMargin: "20% 0px" },
);
$$<HTMLVideoElement>("video.lazy-video").forEach((v) => inView.observe(v));

// one-time reveals
for (const el of $$(".reveal")) {
  const sibs = Array.from(el.parentElement?.children ?? []).filter((c) => c.classList.contains("reveal"));
  el.style.setProperty("--i", String(Math.min(5, sibs.indexOf(el))));
}
const revealer = new IntersectionObserver(
  (entries) =>
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      e.target.classList.add("in");
      revealer.unobserve(e.target);
    }),
  { rootMargin: "0px 0px -10% 0px", threshold: 0.1 },
);
$$(".reveal").forEach((el) => revealer.observe(el));

// nav
const nav = $("#nav");
const setNav = () => nav.classList.toggle("scrolled", scrollY > 8);
addEventListener("scroll", setNav, { passive: true });
setNav();

// ---------------------------------------------------------------- 1. hero

const heroVideo = $<HTMLVideoElement>("#hero-video");
const heroMedia = $("#hero-media");
const heroTitle = $(".hero-title");
const heroFoot = $(".hero-foot");
const heroReveal = $(".hero-reveal");
if (!mountHeroGl(heroVideo, heroMedia)) heroVideo.style.mixBlendMode = "lighten";
if (!still) heroVideo.play().catch(() => {});
new IntersectionObserver(([e]) => (e.isIntersecting ? !still && heroVideo.play().catch(() => {}) : heroVideo.pause())).observe(heroMedia);
const arrive = () => document.body.classList.add("is-in");
requestAnimationFrame(() => requestAnimationFrame(arrive));

scene("hero", (p) => {
  // the headline parts and leaves; the person stays and comes closer; then the truth about what you're looking at
  const out = smooth(0.04, 0.42, p);
  const lines = $$(".line", heroTitle);
  lines[0].style.transform = `translate3d(${(-out * 18).toFixed(2)}vw, 0, 0)`;
  lines[1].style.transform = `translate3d(${(out * 18).toFixed(2)}vw, 0, 0)`;
  heroTitle.style.opacity = String(1 - smooth(0.12, 0.42, p));
  heroFoot.style.opacity = String(1 - smooth(0.02, 0.16, p));
  const s = 1 + smooth(0, 0.6, p) * 0.06 - smooth(0.6, 1, p) * 0.1;
  const x = smooth(0.4, 0.7, p) * (innerWidth > 900 ? 14 : 0);
  heroMedia.style.transform = `translate3d(${x.toFixed(2)}vw, 0, 0) scale(${s.toFixed(4)})`;
  heroMedia.style.opacity = String(1 - smooth(0.88, 1, p));
  heroReveal.classList.toggle("on", p > 0.46 && p < 0.97);
});

// ---------------------------------------------------------------- 2. one video in

const inputClip = $("#input-clip");
const inputSpec = $("#input-spec");
$$("div", inputSpec).forEach((d, i) => d.style.setProperty("--i", String(i)));
scene("input", (p) => {
  const s = 1.18 - smooth(0.0, 0.4, p) * 0.18;
  inputClip.style.transform = `scale(${s.toFixed(4)})`;
  inputSpec.classList.toggle("on", p > 0.3);
});

// ---------------------------------------------------------------- 3. 48 cameras

const camerasEl = $("#cameras");
const wallVideo = document.createElement("video");
Object.assign(wallVideo, { muted: true, loop: true, playsInline: true, preload: "none", crossOrigin: "anonymous" });
wallVideo.src = "media/wall-dance.mp4";
const rigFallback = () => {
  camerasEl.classList.add("no-rig");
  inView.observe($("#wall-fallback"));
};
if (has3d) {
  const io = new IntersectionObserver(
    ([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      wallVideo.preload = "auto";
      import("./three/rig")
        .then(({ mountRig }) => mountRig($("#rig-canvas"), { progress: () => progressOf("cameras"), labels: $("#rig-labels"), video: wallVideo, camerasUrl: "media/cameras-dance.json" }))
        .catch((e) => {
          console.warn("The camera rig is off:", e);
          rigFallback();
        });
    },
    { rootMargin: "100% 0px" },
  );
  io.observe(camerasEl);
} else rigFallback();

// ---------------------------------------------------------------- 3b. bullet time

const bullet = $<HTMLCanvasElement>("#bullet-canvas");
const bctx = bullet.getContext("2d");
const FRAMES = 32;
const sets = new Map<string, HTMLImageElement[]>();
let who = "dance";
let shownFrame = -1;
const loadSet = (name: string) => {
  if (!sets.has(name))
    sets.set(
      name,
      Array.from({ length: FRAMES }, (_, i) => {
        const img = new Image();
        img.decoding = "async";
        img.src = `media/bullet-${name}/${String(i).padStart(3, "0")}.webp`;
        img.onload = () => {
          if (name === who && i === Math.max(0, shownFrame)) shownFrame = -1; // redraw now that it's here
        };
        return img;
      }),
    );
  return sets.get(name)!;
};
const dialDot = $("#dial-dot") as unknown as SVGCircleElement;
const dialDeg = $("#dial-deg");
new IntersectionObserver(([e]) => e.isIntersecting && loadSet(who), { rootMargin: "150% 0px" }).observe(bullet);
$$<HTMLButtonElement>(".seg-btn").forEach((btn) =>
  btn.addEventListener("click", () => {
    who = btn.dataset.who!;
    $$<HTMLButtonElement>(".seg-btn").forEach((b) => {
      b.classList.toggle("on", b === btn);
      b.setAttribute("aria-pressed", String(b === btn));
    });
    loadSet(who);
    shownFrame = -1;
  }),
);
scene("bullet", (p) => {
  const i = Math.min(FRAMES - 1, Math.floor(smooth(0.05, 0.95, p) * FRAMES));
  if (i === shownFrame || !bctx) return;
  const img = loadSet(who)[i];
  if (!img.complete || !img.naturalWidth) return;
  bctx.drawImage(img, 0, 0, bullet.width, bullet.height);
  shownFrame = i;
  const yaw = (i % 16) * 22.5;
  const a = (yaw * Math.PI) / 180;
  dialDot.setAttribute("cx", (50 + Math.sin(a) * 44).toFixed(2));
  dialDot.setAttribute("cy", (50 - Math.cos(a) * 44).toFixed(2));
  dialDeg.textContent = `${yaw.toFixed(1)}°`;
});

// ---------------------------------------------------------------- 4 + 5. the live 3D person

const gaussCount = $("#gauss-count");
let gaussians = 286566;
const chunks = $("#chunks");
// 121 frames in 12 chunks of 11: each GPU takes a slice of the clip
const cells: HTMLElement[][] = [];
for (let g = 0; g < 12; g++) {
  const col = document.createElement("div");
  const c = document.createElement("div");
  c.className = "chunk";
  const row: HTMLElement[] = [];
  for (let k = 0; k < 11; k++) {
    const i = document.createElement("i");
    if (g * 11 + k >= 121) i.className = "none";
    c.appendChild(i);
    row.push(i);
  }
  const label = document.createElement("p");
  label.className = "chunk-label";
  label.textContent = String(g + 1).padStart(2, "0");
  col.append(c, label);
  chunks.appendChild(col);
  cells.push(row);
}
const GPU_PACE = [1, 0.97, 1.04, 0.99, 1.02, 0.95, 1.01, 0.98, 1.03, 0.96, 1.0, 0.94];
scene("reconstruct", (p) => {
  const n = Math.round(smooth(0.06, 0.5, p) * gaussians);
  gaussCount.textContent = n.toLocaleString("en-US");
  const g = smooth(0.62, 0.95, p);
  cells.forEach((row, gi) => row.forEach((cell, k) => cell.classList.toggle("done", g * GPU_PACE[gi] * 11.4 > k + 0.4)));
});

const realityBtn = $<HTMLButtonElement>("#reality");
let realityPressed: boolean | null = null; // null: scroll decides
realityBtn.addEventListener("click", () => {
  realityPressed = !(realityPressed ?? realityBtn.getAttribute("aria-pressed") === "true");
  realityBtn.setAttribute("aria-pressed", String(realityPressed));
});
scene("honesty", (p) => {
  if (realityPressed === null) realityBtn.setAttribute("aria-pressed", String(p > 0.34));
});
const realityOn = () => realityBtn.getAttribute("aria-pressed") === "true";

const splatSlots = { reconstruct: $("#slot-reconstruct"), honesty: $("#slot-honesty") };
const noSplat = () => {
  for (const id of ["#reconstruct", "#honesty"]) $(id).classList.add("no-splat");
  $$<HTMLVideoElement>(".slot-fallback").forEach((v) => inView.observe(v));
};
if (has3d) {
  const io = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      import("./three/splat")
        .then(({ mountSplats }) =>
          mountSplats({
            slots: splatSlots,
            active: () => {
              const r = scenes.get("reconstruct")!;
              const h = scenes.get("honesty")!;
              const vis = (el: HTMLElement) => {
                const b = el.getBoundingClientRect();
                return b.top < innerHeight && b.bottom > 0;
              };
              if (r.near && vis(r.el)) return "reconstruct";
              if (h.near && vis(h.el)) return "honesty";
              return null;
            },
            progress: (s) => progressOf(s),
            reality: realityOn,
          }),
        )
        .then((live) => {
          gaussians = live.count;
          if (!live.seenIsEstimate) $("#seen-num").textContent = String(Math.round(live.seenFraction * 100));
        })
        .catch((e) => {
          console.warn("The live 3D is off:", e);
          noSplat();
        });
    },
    { rootMargin: "120% 0px" },
  );
  io.observe($("#reconstruct"));
  io.observe($("#honesty"));
} else noSplat();

// ---------------------------------------------------------------- measured: the real frame against our render

const compare = $("#compare");
const handle = $("#compare-handle");
let touched = false;
const setX = (pct: number) => {
  const v = Math.max(0, Math.min(100, pct));
  compare.style.setProperty("--x", `${v.toFixed(2)}%`);
  handle.setAttribute("aria-valuenow", String(Math.round(v)));
  handle.setAttribute("aria-valuetext", v < 50 ? `${Math.round(100 - v)}% our render` : `${Math.round(v)}% real frame`);
};
setX(50);
let dragging = false;
const fromPointer = (e: PointerEvent) => {
  const r = compare.getBoundingClientRect();
  setX(((e.clientX - r.left) / r.width) * 100);
};
compare.addEventListener("pointerdown", (e) => {
  touched = dragging = true;
  compare.setPointerCapture(e.pointerId);
  fromPointer(e);
});
compare.addEventListener("pointermove", (e) => dragging && fromPointer(e));
compare.addEventListener("pointerup", () => (dragging = false));
compare.addEventListener("pointercancel", () => (dragging = false));
handle.addEventListener("keydown", (e) => {
  const now = Number(handle.getAttribute("aria-valuenow"));
  const step = e.shiftKey ? 10 : 2;
  if (e.key === "ArrowLeft" || e.key === "ArrowDown") setX(now - step);
  else if (e.key === "ArrowRight" || e.key === "ArrowUp") setX(now + step);
  else if (e.key === "Home") setX(0);
  else if (e.key === "End") setX(100);
  else return;
  touched = true;
  e.preventDefault();
});
// dance or tai chi: the real frame, our render, their number, and the generated views
const TRUTH: Record<string, { db: string; who: string }> = { dance: { db: "40.3", who: "the dancer" }, taichi: { db: "46.6", who: "the tai chi player" } };
$$<HTMLButtonElement>(".truth-btn").forEach((btn) =>
  btn.addEventListener("click", () => {
    const k = btn.dataset.truth!;
    $$<HTMLButtonElement>(".truth-btn").forEach((b) => {
      b.classList.toggle("on", b === btn);
      b.setAttribute("aria-pressed", String(b === btn));
    });
    const real = $<HTMLImageElement>("#truth-real");
    const render = $<HTMLImageElement>("#truth-render");
    real.src = `media/truth-${k}-real.jpg`;
    real.alt = `A frame of the real input video: ${TRUTH[k].who}, mid-move`;
    render.src = `media/truth-${k}-render.jpg`;
    $<HTMLImageElement>("#views-img").src = `media/views-${k}.jpg`;
    $<HTMLImageElement>("#views-img").alt = `Five generated views of ${TRUTH[k].who} from all around, each beside our render from the same view`;
    $("#truth-db").textContent = TRUTH[k].db;
  }),
);
const viewsTrack = $("#views-track");
const views = $("#views");
let truthNear = false;
new IntersectionObserver(([e]) => (truthNear = e.isIntersecting), { rootMargin: "20% 0px" }).observe($("#truth"));
onTick(() => {
  if (!truthNear) return;
  // until you take the handle, scrolling sweeps it from the real frame across to our render
  if (!touched) setX(82 - smooth(0.25, 0.7, passProgress(compare)) * 64);
  const over = viewsTrack.scrollWidth - views.clientWidth;
  if (over > 0) viewsTrack.style.transform = `translate3d(${(-smooth(0.15, 0.85, passProgress(views)) * over).toFixed(1)}px, 0, 0)`;
});

// ---------------------------------------------------------------- 6. in your room: stills from the WebXR viewer

const SHOTS: Record<string, { src: string; alt: string }> = {
  golf: { src: "media/room-golf.webp", alt: "A golfer rebuilt in 3D at the top of his backswing, beside the lesson card: Your turn, Part 1" },
  ball: { src: "media/room-ball.webp", alt: "A basketball player rebuilt in 3D rising into a jump shot, the ball in his hands, a regulation hoop ahead of him" },
  guitar: { src: "media/room-guitar.webp", alt: "A seated guitarist rebuilt in 3D, strumming, beside the lesson card: Your turn, Part 1" },
  chess: { src: "media/room-chess.webp", alt: "A real-size chess board in the starting position, a chess clock beside it" },
};
for (const el of $$("[data-shot]")) {
  const s = SHOTS[el.dataset.shot!];
  if (!s) continue;
  const img = document.createElement("img");
  Object.assign(img, { src: s.src, alt: s.alt, loading: "lazy", decoding: "async", width: 1040, height: 780 });
  el.append(img);
}

// ---------------------------------------------------------------- 7. one sentence becomes a plan

const PLAN = `{
  "intent": "teach me this strum",
  "mode": "teach",
  "title": "Down, down-up: a first strum",
  "place": "beside",
  "steps": [
    { "start": 0.0, "end": 1.6, "title": "Rest the wrist",
      "tip": "Let it hang loose over the sound hole.",
      "speed": 0.5, "repeat": 2 },
    { "start": 1.6, "end": 2.8, "title": "Down",
      "tip": "One stroke, all six strings.",
      "speed": 0.5, "repeat": 3 },
    { "start": 2.8, "end": 4.4, "title": "Down-up",
      "tip": "The up-stroke catches the top strings only.",
      "speed": 0.75, "repeat": 3 }
  ]
}`;
const STEPS = [
  { t: "Rest the wrist", s: 0.5, r: 2, d: 1.6 },
  { t: "Down", s: 0.5, r: 3, d: 1.2 },
  { t: "Down-up", s: 0.75, r: 3, d: 1.6 },
];
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const tint = (s: string) =>
  esc(s)
    .replace(/("[^"]*")(\s*:)/g, '<span class="k">$1</span>$2')
    .replace(/(:\s*)("[^"]*")/g, '$1<span class="s">$2</span>')
    .replace(/(:\s*)(-?\d+(?:\.\d+)?)/g, '$1<span class="n">$2</span>');
const planLines = PLAN.split("\n");
const code = $("#json code");
const stepsEl = $("#steps");
const stepBars = STEPS.map((st) => {
  const el = document.createElement("div");
  el.className = "step-bar";
  el.style.flex = String(st.d * st.r / st.s);
  el.innerHTML = `<i></i><b>${st.t}</b><em>${st.s}× · ×${st.r}</em>`;
  stepsEl.appendChild(el);
  return el;
});
$("[data-mode=teach]").classList.add("on");
const typer = new Typer($("#typed"), still);
let typed = false;
let shownLines = -1;
scene("plan", (p) => {
  if (!typed && p > 0.02) {
    typed = true;
    typer.type("teach me this strum");
  }
  const n = still ? planLines.length : Math.round(smooth(0.12, 0.6, p) * planLines.length);
  if (n !== shownLines) {
    shownLines = n;
    code.innerHTML = tint(planLines.slice(0, n).join("\n"));
  }
  stepBars.forEach((b, i) => {
    b.classList.toggle("on", p > 0.5 + i * 0.05);
    const f = smooth(0.62 + i * 0.1, 0.72 + i * 0.1, p);
    (b.firstElementChild as HTMLElement).style.setProperty("--f", f.toFixed(3));
  });
});
