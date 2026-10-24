import * as THREE from "three";
import { PERSON } from "../config";
import { contactShadow, floorGlow, Person } from "./person";
import { clamp01, damp, easeInOut, onTick, reducedMotion, smooth } from "../motion";
import { Stage } from "./stage";

const REVEAL_MS = 2800; // feet to head
const TURN_S = 64; // one slow turn

/**
 * The hero: the person rises out of the floor, then turns slowly. The camera frames them inside `figure` (an empty
 * element the page lays out), so the CSS decides where they stand at every screen size.
 */
export async function mountHero(host: HTMLElement, figure: HTMLElement): Promise<Person> {
  const stage = new Stage(host, { splats: true, fov: 22 });
  let person: Person;
  try {
    person = await Person.load(PERSON);
  } catch (e) {
    stage.dispose();
    throw e;
  }
  const { scene, camera } = stage;
  scene.add(floorGlow(1.7, 0x2c2c30, 0.7));
  scene.add(contactShadow(0.95, 0.75, 0.6));
  scene.add(person.group);

  const still = reducedMotion();
  const H = person.height;
  const target = new THREE.Vector3(0, H * 0.5, 0);
  let dist = 6;
  const layout = () => {
    stage.resize();
    const rect = stage.rectOf(figure);
    const fullH = stage.aimAt(rect);
    dist = stage.fitBoth(H * 0.62, H * 1.04, rect, fullH);
  };
  layout();
  new ResizeObserver(layout).observe(host);
  new ResizeObserver(layout).observe(figure);

  let pointerX = 0;
  let pointerY = 0;
  let px = 0;
  let py = 0;
  addEventListener(
    "pointermove",
    (e) => {
      if (e.pointerType !== "mouse") return;
      pointerX = (e.clientX / innerWidth) * 2 - 1;
      pointerY = (e.clientY / innerHeight) * 2 - 1;
    },
    { passive: true },
  );

  const canvas = stage.renderer.domElement;
  const t0 = performance.now();
  let spin = -0.55; // starts three-quarter on, turns toward you as they rise
  let t = 0;
  let revealed = false;
  onTick((dt, now) => {
    const s = clamp01(scrollY / Math.max(1, innerHeight));
    if (!still) canvas.style.transform = `translate3d(0, ${(s * innerHeight * 0.32).toFixed(1)}px, 0)`;
    if (!stage.onScreen) return;
    t += dt;
    if (!revealed) {
      const r = still ? 1 : clamp01((now - t0) / REVEAL_MS);
      person.u.reveal.value = -0.3 + easeInOut(r) * (H + 0.6);
      person.u.glow.value = 0.6 * (1 - smooth(0.7, 1, r));
      if (r >= 1) {
        revealed = true;
        person.u.reveal.value = 100;
        person.u.glow.value = 0;
      }
      person.touch();
    }
    if (!still) spin += (dt * Math.PI * 2) / TURN_S;
    person.group.rotation.y = Math.PI + spin;
    person.at(t);
    person.opacity = 1 - smooth(0.2, 0.85, s);

    px = damp(px, pointerX, 2.5, dt);
    py = damp(py, pointerY, 2.5, dt);
    const az = px * 0.09;
    const el = 0.03 + py * 0.035;
    camera.position.set(
      target.x + Math.sin(az) * Math.cos(el) * dist,
      target.y + Math.sin(el) * dist,
      target.z + Math.cos(az) * Math.cos(el) * dist,
    );
    camera.lookAt(target);
    stage.render();
  });
  return person;
}
