import * as THREE from "three";
import { heroPerson } from "../people";
import { contactShadow, floorGlow, Person } from "./person";
import { damp, onTick, reducedMotion } from "../motion";
import { Stage } from "./stage";

const TURN_S = 26;

export interface HonestyHooks {
  figure: HTMLElement;
  /** Whether Reality check is on (the page owns the button). */
  on: () => boolean;
}

/** Reality check: the person turns, and everything the source camera never saw is tinted blue. */
export async function mountHonesty(host: HTMLElement, hooks: HonestyHooks): Promise<Person> {
  const stage = new Stage(host, { splats: true, fov: 22 });
  let person: Person;
  try {
    person = await Person.load((await heroPerson()).still); // one frame: the hero already holds the replay
  } catch (e) {
    stage.dispose();
    throw e;
  }
  const { scene, camera } = stage;
  const H = person.height;
  person.u.reveal.value = 100;
  person.u.glow.value = 0;
  person.touch();
  scene.add(floorGlow(1.5, 0x1c2a40, 0.55));
  scene.add(contactShadow(0.95, 0.75, 0.6));
  scene.add(person.group);

  const target = new THREE.Vector3(0, H * 0.5, 0);
  let dist = 6;
  const layout = () => {
    stage.resize();
    const rect = stage.rectOf(hooks.figure);
    const fullH = stage.aimAt(rect);
    dist = stage.fitBoth(H * 0.62, H * 1.06, rect, fullH);
  };
  layout();
  new ResizeObserver(layout).observe(host);

  const still = reducedMotion();
  let spin = 0.9;
  let tint = 0;
  let wasOn = false;
  let t = 0;
  onTick((dt) => {
    if (!stage.onScreen) return;
    t += dt;
    const on = hooks.on();
    if (person.hasRealityFiles) {
      if (on !== wasOn) void person.setReality(on);
    } else {
      tint = damp(tint, on ? 1 : 0, 5, dt);
      person.u.tint.value = tint;
      person.touch();
    }
    wasOn = on;
    if (!still) spin += (dt * Math.PI * 2) / TURN_S;
    person.group.rotation.y = Math.PI + spin;
    person.at(t);
    const el = 0.05;
    camera.position.set(0, target.y + Math.sin(el) * dist, Math.cos(el) * dist);
    camera.lookAt(target);
    stage.render();
  });
  return person;
}
