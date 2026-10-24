import * as THREE from "three";
import { heroPerson } from "../people";
import { contactShadow, Person } from "./person";
import { clamp01, damp, lerp, onTick, smooth } from "../motion";
import { Stage } from "./stage";

// How it works, as one camera move through one scene, driven by scroll:
//   1. 48 views: 4DAnyone's virtual cameras appear around the person, three rings of 16 (pitch -10, 15 and 35 degrees,
//      the settings the pipeline runs: --views_per_layer 16 --layer_pitches '[-10,15,35]').
//   2. 12 GPUs: the cameras go; the person drops to bare Gaussian centres and grows back into a solid body.
//   3. Life-size: the camera comes down to standing eye height (1.6 m) beside a metre grid and a height marker.

const RINGS = [-10, 15, 35];
const PER_RING = 16;
const RING_RADIUS = 2.45;
const EYE = 1.6;

interface Key {
  p: number; // scroll progress where this key is reached
  az: number; // radians around the person
  el: number | null; // radians above the target; null = standing eye height
  fit: number; // meters that must fit the frame
  ty: number; // target height as a fraction of the person
}
const KEYS: Key[] = [
  { p: 0.0, az: 0.75, el: 0.5, fit: 6.4, ty: 0.42 },
  { p: 0.3, az: 1.35, el: 0.44, fit: 6.2, ty: 0.45 },
  { p: 0.5, az: 0.42, el: 0.16, fit: 2.3, ty: 0.5 },
  { p: 0.68, az: 0.2, el: 0.1, fit: 2.25, ty: 0.5 },
  { p: 0.86, az: -0.05, el: null, fit: 2.3, ty: 0.56 },
  { p: 1.0, az: -0.12, el: null, fit: 2.3, ty: 0.56 },
];

export interface HowHooks {
  /** 0-1 scroll progress through the section. */
  progress: () => number;
  /** The element the person should be framed in. */
  figure: HTMLElement;
  /** The "1.73 m" label, placed over the marker's top. */
  measure: HTMLElement;
}

export async function mountHow(host: HTMLElement, hooks: HowHooks): Promise<Person> {
  const stage = new Stage(host, { splats: true, fov: 30 });
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
  scene.add(person.group);
  scene.add(contactShadow(0.95, 0.75, 0.55));

  // ---- the 48 views ----
  const center = new THREE.Vector3(0, H * 0.5, 0);
  const cams: { line: THREE.LineSegments; mat: THREE.LineBasicMaterial; order: number }[] = [];
  const frustum = frustumGeometry(0.11, 0.196, 0.2);
  for (let r = 0; r < RINGS.length; r++) {
    for (let k = 0; k < PER_RING; k++) {
      const az = (k / PER_RING) * Math.PI * 2 + r * 0.13;
      const pitch = THREE.MathUtils.degToRad(RINGS[r]);
      const pos = new THREE.Vector3(
        Math.sin(az) * Math.cos(pitch) * RING_RADIUS,
        center.y + Math.sin(pitch) * RING_RADIUS,
        Math.cos(az) * Math.cos(pitch) * RING_RADIUS,
      );
      const mat = new THREE.LineBasicMaterial({ color: 0xf5f5f7, transparent: true, opacity: 0, depthWrite: false });
      const line = new THREE.LineSegments(frustum, mat);
      line.position.copy(pos);
      line.lookAt(center);
      scene.add(line);
      cams.push({ line, mat, order: k * RINGS.length + r });
    }
  }
  cams.sort((a, b) => a.order - b.order);

  // ---- the floor and the height marker ----
  const grid = floorGrid();
  scene.add(grid.mesh);
  const marker = new THREE.Group();
  const markerMat = new THREE.LineBasicMaterial({ color: 0xf5f5f7, transparent: true, opacity: 0 });
  const x = 0.62;
  const pts = [
    [x, 0, 0, x, H, 0],
    [x - 0.06, 0, 0, x + 0.06, 0, 0],
    [x - 0.06, H, 0, x + 0.06, H, 0],
  ].flat();
  const markerGeo = new THREE.BufferGeometry();
  markerGeo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  marker.add(new THREE.LineSegments(markerGeo, markerMat));
  scene.add(marker);
  hooks.measure.textContent = `${H.toFixed(2)} m`;
  const markerTop = new THREE.Vector3(x, H, 0);

  // ---- layout ----
  let rect = stage.rectOf(hooks.figure);
  let fullH = 1;
  const layout = () => {
    stage.resize();
    rect = stage.rectOf(hooks.figure);
    fullH = stage.aimAt(rect);
  };
  layout();
  new ResizeObserver(layout).observe(host);

  let p = 0; // damped progress: the camera has a little weight to it
  const target = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  onTick((dt) => {
    if (!stage.onScreen) return;
    p = damp(p, hooks.progress(), 6, dt);

    // cameras: sweep in around the circle, then leave
    const shown = smooth(0.02, 0.27, p) * cams.length;
    const leave = 1 - smooth(0.36, 0.46, p);
    cams.forEach((c, i) => {
      c.mat.opacity = clamp01(shown - i) * 0.55 * leave;
      c.line.visible = c.mat.opacity > 0.002;
    });

    // reconstruction: down to points, then back to a solid person
    const down = smooth(0.38, 0.47, p);
    const up = smooth(0.48, 0.66, p);
    person.u.size.value = lerp(1, 0.08, down) + (1 - 0.08) * up * down;
    person.touch();

    // life-size: grid and marker
    const floor = smooth(0.7, 0.84, p);
    grid.material.uniforms.uOpacity.value = floor;
    markerMat.opacity = floor * 0.8;
    hooks.measure.style.opacity = String(floor);

    // the camera
    let a = KEYS[0];
    let b = KEYS[KEYS.length - 1];
    for (let i = 0; i < KEYS.length - 1; i++)
      if (p >= KEYS[i].p && p <= KEYS[i + 1].p) {
        a = KEYS[i];
        b = KEYS[i + 1];
        break;
      }
    const f = smooth(a.p, b.p, p);
    const az = lerp(a.az, b.az, f);
    const fit = lerp(a.fit, b.fit, f);
    const ty = lerp(a.ty, b.ty, f) * H;
    const dist = stage.fitBoth(fit * 0.75, fit, rect, fullH);
    const elOf = (k: Key) => (k.el ?? Math.asin(clamp01((EYE - k.ty * H) / dist)));
    const el = lerp(elOf(a), elOf(b), f);
    target.set(0, ty, 0);
    camera.position.set(Math.sin(az) * Math.cos(el) * dist, ty + Math.sin(el) * dist, Math.cos(az) * Math.cos(el) * dist);
    camera.lookAt(target);
    camera.updateMatrixWorld();

    if (floor > 0.001) {
      tmp.copy(markerTop).project(camera);
      hooks.measure.style.transform = `translate3d(${((tmp.x + 1) / 2) * stage.width}px, ${((1 - tmp.y) / 2) * stage.height}px, 0)`;
    }
    stage.render();
  });
  return person;
}

/** A camera frustum drawn in lines: apex at the camera, a portrait 9:16 frame `depth` in front (toward -Z). */
function frustumGeometry(w: number, h: number, depth: number) {
  const c = [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ].map(([x, y]) => [x, y, depth]);
  // Object3D.lookAt points +Z at the target for non-cameras, so the frame sits at +Z
  const v: number[] = [];
  for (let i = 0; i < 4; i++) v.push(0, 0, 0, ...c[i]);
  for (let i = 0; i < 4; i++) v.push(...c[i], ...c[(i + 1) % 4]);
  // a small tick on top, so up reads at a glance
  v.push(-w * 0.18, h / 2 + 0.012, depth, w * 0.18, h / 2 + 0.012, depth);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(v, 3));
  return g;
}

/** A metre grid on the floor, half-metre lines, fading out from the person. */
function floorGrid() {
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uOpacity: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec2 vXZ;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vXZ = w.xz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uOpacity;
      varying vec2 vXZ;
      void main() {
        vec2 q = vXZ / 0.5;
        vec2 g = abs(fract(q - 0.5) - 0.5) / fwidth(q);
        float line = 1.0 - min(min(g.x, g.y), 1.0);
        float fade = 1.0 - smoothstep(0.8, 3.4, length(vXZ));
        gl_FragColor = vec4(vec3(0.96), line * fade * 0.28 * uOpacity);
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(9, 9), material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = -2;
  return { mesh, material };
}
