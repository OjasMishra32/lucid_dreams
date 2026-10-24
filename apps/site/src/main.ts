import "./styles.css";
import { DEMO_URL, PERSON, REPO_URL } from "./config";
import { Typer } from "./typer";
import { clamp01, onTick, reducedMotion, webgl2Available } from "./motion";

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector<T>(s)!;
const $$ = <T extends HTMLElement = HTMLElement>(s: string) => Array.from(document.querySelectorAll<T>(s));
const root = document.documentElement;
root.classList.add("js");
const has3d = webgl2Available();
if (!has3d) root.classList.add("no-3d");
const still = reducedMotion();

// ---------------------------------------------------------------- links from config

$$<HTMLAnchorElement>("[data-repo]").forEach((a) => (a.href = REPO_URL));
const demo = $<HTMLAnchorElement>("#demo-link");
if (DEMO_URL) {
  demo.href = DEMO_URL;
} else {
  demo.setAttribute("aria-disabled", "true");
  demo.title = "The demo film is on its way";
  demo.addEventListener("click", (e) => e.preventDefault());
}

// ---------------------------------------------------------------- the load sequence

/** A section whose 3D failed drops its canvas; the rest of the page keeps theirs. */
const fallback = (section: string) => (why: unknown) => {
  console.warn(`3D is off in ${section}:`, why);
  $(section).classList.add("no-3d");
};
let arrived = false;
const arrive = () => {
  if (arrived) return;
  arrived = true;
  document.body.classList.add("is-in");
};
// the type comes in with the person, or on its own if they take a moment
setTimeout(arrive, 700);

const caption = $("#hero-caption");
if (has3d) {
  import("./three/hero")
    .then(({ mountHero }) => mountHero($("#hero-canvas"), $("#hero-figure")))
    .then((person) => {
      const n = person.count.toLocaleString("en-US");
      caption.textContent = `${PERSON.label}. ${n} Gaussians, rendered live.`;
      arrive();
    })
    .catch((e) => {
      fallback("#top")(e);
      arrive();
    });
} else arrive();

// ---------------------------------------------------------------- nav

const nav = $("#nav");
const setNav = () => nav.classList.toggle("scrolled", scrollY > 8);
addEventListener("scroll", setNav, { passive: true });
setNav();

// ---------------------------------------------------------------- reveals

// stagger siblings: each [data-reveal] gets its index among revealed siblings
for (const el of $$("[data-reveal]")) {
  const sibs = Array.from(el.parentElement?.children ?? []).filter((c) => c.hasAttribute("data-reveal"));
  el.style.setProperty("--i", String(Math.min(6, sibs.indexOf(el))));
}
const revealer = new IntersectionObserver(
  (entries) =>
    entries.forEach((e) => {
      if (e.isIntersecting) {
        e.target.classList.add("in");
        revealer.unobserve(e.target);
      }
    }),
  { rootMargin: "0px 0px -8% 0px", threshold: 0.12 },
);
$$("[data-reveal]").forEach((el) => revealer.observe(el));

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
/** Mount a 3D section once it's within a screen of view. */
const whenNear = (el: HTMLElement, mount: () => void) => {
  const io = new IntersectionObserver(
    ([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      mount();
    },
    { rootMargin: "100% 0px" },
  );
  io.observe(el);
};

// ---------------------------------------------------------------- intent

const EXAMPLES = [
  ["teach me this jump shot", "show me the strum, slowly", "walk me through my knee exercises"],
  ["I just want to sit with her", "let me hear him tell that story again"],
  ["play chess with me", "give me a hard game"],
];
const intentTrack = $("#intent-track");
$("#typed").textContent = ""; // typed in once you scroll here
const typer = new Typer($("#typed"), still);
const modeNames = $$("#modes .mode-name");
const modeLines = $$("#modes .mode-line");
let mode = -1;
let line = 0;
let nextLine = 0;
let intentOn = false;
new IntersectionObserver(([e]) => (intentOn = e.isIntersecting)).observe(intentTrack);
const setMode = (m: number) => {
  mode = m;
  line = 0;
  modeNames.forEach((el, i) => el.classList.toggle("on", i === m));
  modeLines.forEach((el, i) => el.classList.toggle("on", i === m));
  typer.type(EXAMPLES[m][0]);
  nextLine = performance.now() + 3600;
};

// ---------------------------------------------------------------- how it works

const howTrack = $("#how-track");
const steps = $$(".step");
const gpuRow = $("#gpus .gpu-row");
// six B200s and six RTX PRO 6000s, each finishing its slice at its own pace
const GPU_SPEED = [1.0, 0.97, 1.03, 0.99, 1.02, 0.96, 0.84, 0.8, 0.86, 0.82, 0.85, 0.79];
const gpuFills = GPU_SPEED.map(() => {
  const i = document.createElement("i");
  const b = document.createElement("b");
  i.appendChild(b);
  gpuRow.appendChild(i);
  return b;
});
let step = -1;
const howProgress = () => trackProgress(howTrack);
if (has3d)
  whenNear(howTrack, () =>
    import("./three/how")
      .then(({ mountHow }) => mountHow($("#how-canvas"), { progress: howProgress, figure: $("#how-figure"), measure: $("#measure") }))
      .catch(fallback("#how")),
  );

// ---------------------------------------------------------------- play

const play = $("#play");
if (has3d)
  whenNear(play, () =>
    import("./three/chess").then(({ mountChess }) => mountChess($("#chess-canvas"), () => passProgress(play))).catch(fallback("#play")),
  );

// ---------------------------------------------------------------- honesty

const realityBtn = $<HTMLButtonElement>("#reality");
let realityOn = true;
realityBtn.addEventListener("click", () => {
  realityOn = !realityOn;
  realityBtn.setAttribute("aria-pressed", String(realityOn));
});
const seenPct = $("#seen-pct");
if (PERSON.seenFraction != null) {
  seenPct.textContent = String(Math.round(PERSON.seenFraction * 100));
  $("#honesty").classList.add("has-seen");
}
const honesty = $("#honesty");
let honestyInView = false;
new IntersectionObserver(([e]) => (honestyInView = e.isIntersecting), { threshold: 0.25 }).observe($(".honesty-stage"));
if (has3d)
  whenNear(honesty, () =>
    import("./three/honesty")
      .then(({ mountHonesty }) =>
        mountHonesty($("#honesty-canvas"), { figure: $("#honesty-figure"), on: () => realityOn && honestyInView }),
      )
      .then((person) => {
        seenPct.textContent = String(Math.round(person.seenFraction * 100));
        $("#seen-note").hidden = !person.seenIsEstimate;
      })
      .catch(fallback("#honesty")),
  );

// ---------------------------------------------------------------- every frame

onTick((_dt, now) => {
  // intent: three phases down the sticky track, one mode each; examples rotate while you stay
  if (intentOn) {
    const m = Math.min(2, Math.floor(trackProgress(intentTrack) * 3));
    if (m !== mode) setMode(m);
    else if (now > nextLine && typer.idle) {
      line = (line + 1) % EXAMPLES[m].length;
      typer.type(EXAMPLES[m][line]);
      nextLine = now + 3600;
    }
  }

  // how it works: which step, and the GPUs filling during step two
  const p = howProgress();
  const s = p < 0.36 ? 0 : p < 0.7 ? 1 : 2;
  if (s !== step) {
    step = s;
    steps.forEach((el, i) => {
      el.classList.toggle("on", i === s);
      el.classList.toggle("past", i < s);
    });
  }
  const local = clamp01((p - 0.38) / 0.28);
  gpuFills.forEach((b, i) => (b.style.transform = `scaleX(${clamp01(local * GPU_SPEED[i] * 1.12).toFixed(4)})`));
});
