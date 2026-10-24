import { livePerson } from "../people";
import { contactShadow, floorGlow, Person } from "./person";
import { damp, easeInOut, lerp, onTick, reducedMotion, smooth } from "../motion";
import { Stage, type Rect } from "./stage";

// One live Gaussian person for two scenes: Reconstruction (the Gaussians rise out of the floor as bare points, then
// grow into the person) and Honesty (Reality check tints what no camera saw). One WebGL context, one download: the
// canvas moves into whichever scene is on screen.

export type SplatScene = "reconstruct" | "honesty";

export interface SplatHooks {
  slots: Record<SplatScene, HTMLElement>;
  /** Which scene is on screen now (null: neither). */
  active: () => SplatScene | null;
  progress: (s: SplatScene) => number;
  reality: () => boolean;
}

export interface Splats {
  person: Person;
  /** Gaussians in the frame on screen. */
  count: number;
  seenFraction: number;
  seenIsEstimate: boolean;
}

export async function mountSplats(hooks: SplatHooks): Promise<Splats> {
  const stage = new Stage(hooks.slots.reconstruct, { splats: true, fov: 24, maxDpr: 1.75 });
  let person: Person;
  const cfg = await livePerson();
  try {
    person = await Person.load(cfg);
  } catch (e) {
    stage.dispose();
    throw e;
  }
  const { scene, camera } = stage;
  const glow = floorGlow(1.6, 0x26262a, 0.6);
  scene.add(glow);
  scene.add(contactShadow(0.95, 0.75, 0.6));
  scene.add(person.group);
  const H = person.height;
  const canvas = stage.renderer.domElement;
  const still = reducedMotion();

  // where the person stands on screen: a rect in canvas pixels, per scene and screen shape
  const frame = (s: SplatScene): Rect => {
    const w = stage.width;
    const h = stage.height;
    const phone = w < 900;
    if (phone) return s === "honesty" ? { x: 0, y: h * 0.06, w, h: h * 0.52 } : { x: 0, y: h * 0.2, w, h: h * 0.58 };
    if (s === "honesty") return { x: w * 0.5, y: h * 0.08, w: w * 0.36, h: h * 0.86 };
    // centre stage, then aside to the left once the GPUs come in
    const cx = 0.5 - 0.14 * shift;
    return { x: w * (cx - 0.25), y: h * 0.1, w: w * 0.5, h: h * 0.84 };
  };

  let current: SplatScene = "reconstruct";
  let shift = 0; // 0-1: Reconstruction's person steps aside for the GPU chart
  let dist = 6;
  const layout = () => {
    stage.resize();
    const rect = frame(current);
    const fullH = stage.aimAt(rect);
    dist = stage.fitBoth(H * 0.6, H * 1.06, rect, fullH);
  };
  layout();
  new ResizeObserver(layout).observe(document.documentElement);

  // drag to turn (Honesty): horizontal only, so a vertical swipe still scrolls the page
  let drag = 0;
  let dragV = 0;
  let down: { x: number; id: number } | null = null;
  canvas.addEventListener("pointerdown", (e) => {
    if (current !== "honesty") return;
    down = { x: e.clientX, id: e.pointerId };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!down || e.pointerId !== down.id) return;
    const dx = e.clientX - down.x;
    down.x = e.clientX;
    drag += (dx / Math.max(320, stage.width)) * Math.PI * 2;
    dragV = dx;
  });
  const up = () => (down = null);
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);

  let p = 0;
  let spin = 0;
  let realityOn = false;
  let tint = 0;
  onTick((dt) => {
    const s = hooks.active();
    if (s && s !== current) {
      current = s;
      stage.attach(hooks.slots[s]);
      canvas.style.cursor = s === "honesty" ? "grab" : "";
      layout();
      p = hooks.progress(s);
    }
    if (!s || !stage.onScreen) return;
    const target = hooks.progress(current);
    p = still ? target : damp(p, target, 7, dt);

    let az: number;
    let el: number;
    if (current === "reconstruct") {
      const sh = stage.width < 900 ? 0 : smooth(0.56, 0.66, p);
      if (Math.abs(sh - shift) > 1e-4) {
        shift = sh;
        layout();
      }
      // rise as points (0.04-0.3), grow into splats (0.3-0.52), then the full person turns
      const rise = smooth(0.04, 0.3, p);
      person.u.reveal.value = -0.3 + easeInOut(rise) * (H + 0.6);
      person.u.glow.value = 0.85 * (1 - smooth(0.24, 0.34, p));
      person.u.edge.value = 0.22;
      person.u.size.value = lerp(0.11, 1, smooth(0.3, 0.52, p));
      person.u.tint.value = 0;
      if (realityOn) {
        realityOn = false;
        void person.setReality(false);
      }
      person.touch();
      glow.visible = true;
      az = lerp(0.85, -0.55, p);
      el = lerp(0.2, 0.06, smooth(0, 0.6, p));
    } else {
      person.u.reveal.value = 100;
      person.u.glow.value = 0;
      person.u.size.value = 1;
      const on = hooks.reality();
      if (person.hasRealityFiles) {
        if (on !== realityOn) {
          realityOn = on;
          void person.setReality(on);
        }
      } else {
        tint = damp(tint, on ? 1 : 0, 6, dt);
        person.u.tint.value = tint;
      }
      person.touch();
      if (!down) {
        dragV = damp(dragV, 0, 4, dt);
        if (!still) spin += dt * 0.16;
      }
      az = 0.5 - p * Math.PI * 1.1 - spin + drag;
      el = 0.06;
    }
    person.group.rotation.y = Math.PI;
    const ty = H * 0.5;
    camera.position.set(Math.sin(az) * Math.cos(el) * dist, ty + Math.sin(el) * dist, Math.cos(az) * Math.cos(el) * dist);
    camera.lookAt(0, ty, 0);
    stage.render();
  });

  return {
    person,
    count: cfg.gaussians ?? person.count,
    seenFraction: person.seenFraction,
    seenIsEstimate: person.seenIsEstimate,
  };
}

