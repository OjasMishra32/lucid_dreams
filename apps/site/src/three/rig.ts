import * as THREE from "three";
import { damp, lerp, onTick, reducedMotion, smooth } from "../motion";

// 4DAnyone's rig, drawn from its own cameras.json: 48 cameras in three rings of 16 (pitch -10, 15 and 35 degrees),
// each with a screen in front of it playing the view that camera "filmed" (its tile of the camera-wall video). Scroll
// flies around the rig, then the 48 screens leave their cameras and line up into the wall: 3 rows (the rings) x 16.

interface Cam {
  id: number;
  ring: number;
  pitch: number;
  yaw: number;
  fy: number;
  w: number;
  h: number;
  c2w: number[][];
}

export interface RigHooks {
  progress: () => number;
  labels: HTMLElement;
  video: HTMLVideoElement;
  camerasUrl: string;
}

const COLS = 16;
const ROWS = 3;
const SCREEN_D = 0.95; // metres in front of each camera

const SCREEN_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const SCREEN_FRAG = /* glsl */ `
  uniform sampler2D map;
  uniform vec4 tile;
  uniform float opacity;
  uniform float back;
  varying vec2 vUv;
  void main() {
    vec3 c = texture2D(map, tile.xy + vUv * tile.zw).rgb;
    c *= gl_FrontFacing ? 1.0 : back;
    gl_FragColor = vec4(c, opacity);
  }`;

export async function mountRig(host: HTMLElement, hooks: RigHooks): Promise<() => void> {
  const rig = (await (await fetch(hooks.camerasUrl)).json()) as { cameras: Cam[] };
  const cams = rig.cameras.slice().sort((a, b) => a.id - b.id);
  if (cams.length !== COLS * ROWS) throw new Error(`expected 48 cameras, got ${cams.length}`);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  host.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 100);

  // ---- the cameras, in three.js terms (OpenCV: x right, y down, z forward -> three: x right, y up, -z forward)
  const poses = cams.map((c) => {
    const m = c.c2w;
    const pos = new THREE.Vector3(m[0][3], m[1][3], m[2][3]);
    const x = new THREE.Vector3(m[0][0], m[1][0], m[2][0]);
    const y = new THREE.Vector3(-m[0][1], -m[1][1], -m[2][1]);
    const z = new THREE.Vector3(-m[0][2], -m[1][2], -m[2][2]);
    const quat = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
    const forward = z.clone().negate();
    return { pos, quat, forward };
  });

  // the point every camera looks at: closest to all 48 optical axes (least squares)
  const A = new THREE.Matrix3().set(0, 0, 0, 0, 0, 0, 0, 0, 0);
  const b = new THREE.Vector3();
  const a = new Array(9).fill(0);
  for (const { pos, forward: d } of poses) {
    const I = [1 - d.x * d.x, -d.x * d.y, -d.x * d.z, -d.y * d.x, 1 - d.y * d.y, -d.y * d.z, -d.z * d.x, -d.z * d.y, 1 - d.z * d.z];
    for (let i = 0; i < 9; i++) a[i] += I[i];
    b.x += I[0] * pos.x + I[1] * pos.y + I[2] * pos.z;
    b.y += I[3] * pos.x + I[4] * pos.y + I[5] * pos.z;
    b.z += I[6] * pos.x + I[7] * pos.y + I[8] * pos.z;
  }
  A.set(a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7], a[8]);
  const centre = b.applyMatrix3(A.clone().invert());

  // ---- the wall video as one texture; each screen samples its own tile
  const tex = new THREE.VideoTexture(hooks.video);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;

  const c0 = cams[0];
  const halfH = (SCREEN_D * (c0.h / 2)) / c0.fy;
  const halfW = (halfH * c0.w) / c0.h;
  const screenGeo = new THREE.PlaneGeometry(halfW * 2, halfH * 2);
  const frustumGeo = (() => {
    const c = [
      [-halfW, -halfH],
      [halfW, -halfH],
      [halfW, halfH],
      [-halfW, halfH],
    ].map(([x, y]) => [x, y, -SCREEN_D]);
    const v: number[] = [];
    for (let i = 0; i < 4; i++) v.push(0, 0, 0, ...c[i]);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(v, 3));
    return g;
  })();
  const camBody = (() => {
    // a small camera body at the apex, so each one reads as a camera at a glance
    const g = new THREE.BoxGeometry(0.09, 0.07, 0.06);
    g.translate(0, 0, 0.03);
    return new THREE.EdgesGeometry(g);
  })();

  const tw = 1 / COLS;
  const th = 1 / ROWS;
  const inset = 0.6 / 1920;
  const screens = cams.map((c, i) => {
    const pose = poses[i];
    const ring = c.ring;
    const col = c.id % COLS;
    const mat = new THREE.ShaderMaterial({
      vertexShader: SCREEN_VERT,
      fragmentShader: SCREEN_FRAG,
      uniforms: {
        map: { value: tex },
        tile: { value: new THREE.Vector4(col * tw + inset, 1 - (ring + 1) * th + inset, tw - 2 * inset, th - 2 * inset) },
        opacity: { value: 0 },
        back: { value: 0.32 },
      },
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(screenGeo, mat);
    // where it sits on the rig: SCREEN_D in front of its camera, facing back at it
    const rigPos = pose.pos.clone().addScaledVector(pose.forward, SCREEN_D);
    const rigQuat = pose.quat.clone();
    mesh.position.copy(rigPos);
    mesh.quaternion.copy(rigQuat);
    mesh.renderOrder = 2;
    scene.add(mesh);

    const lineMat = new THREE.LineBasicMaterial({ color: 0xf5f5f7, transparent: true, opacity: 0, depthWrite: false });
    const holder = new THREE.Group();
    holder.position.copy(pose.pos);
    holder.quaternion.copy(pose.quat);
    holder.add(new THREE.LineSegments(frustumGeo, lineMat));
    holder.add(new THREE.LineSegments(camBody, lineMat));
    scene.add(holder);
    return { mesh, mat, lineMat, holder, rigPos, rigQuat, ring, col };
  });

  // ---- the floor: rings under the cameras and a mark where the person stood
  const floorMat = new THREE.LineBasicMaterial({ color: 0xf5f5f7, transparent: true, opacity: 0, depthWrite: false });
  const floor = new THREE.Group();
  for (const r of [0.5, 1.5, 2.5, 3.0]) {
    const pts: THREE.Vector3[] = [];
    for (let k = 0; k <= 128; k++) pts.push(new THREE.Vector3(Math.cos((k / 128) * Math.PI * 2) * r, 0, Math.sin((k / 128) * Math.PI * 2) * r));
    floor.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), floorMat));
  }
  floor.add(
    new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-0.15, 0, 0), new THREE.Vector3(0.15, 0, 0), new THREE.Vector3(0, 0, -0.15), new THREE.Vector3(0, 0, 0.15)]),
      floorMat,
    ),
  );
  floor.position.set(centre.x, 0, centre.z);
  scene.add(floor);

  // ---- labels (HTML, placed over the 3D)
  const ringLabels = [-10, 15, 35].map((deg, r) => {
    const el = document.createElement("span");
    el.className = "rig-label";
    el.innerHTML = `<b>Ring ${r + 1}</b> · ${deg < 0 ? "−" : ""}${Math.abs(deg)}° · 16 cameras`;
    hooks.labels.appendChild(el);
    return el;
  });
  const rowLabels = [-10, 15, 35].map((deg) => {
    const el = document.createElement("span");
    el.className = "rig-label row";
    el.textContent = `${deg < 0 ? "−" : ""}${Math.abs(deg)}°`;
    hooks.labels.appendChild(el);
    return el;
  });

  // ---- layout and the loop
  let width = 1;
  let height = 1;
  const resize = () => {
    const w = Math.max(1, host.clientWidth);
    const h = Math.max(1, host.clientHeight);
    if (w === width && h === height) return;
    width = w;
    height = h;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(host);

  let onScreen = false;
  const io = new IntersectionObserver(([e]) => {
    onScreen = e.isIntersecting;
    if (onScreen) hooks.video.play().catch(() => {});
    else hooks.video.pause();
  });
  io.observe(host);

  const still = reducedMotion();
  let p = 0;
  let drift = 0;
  const tmp = new THREE.Vector3();
  const gridPos = new THREE.Vector3();
  const gridQuat = new THREE.Quaternion();
  const toScreen = (v: THREE.Vector3) => {
    tmp.copy(v).project(camera);
    return { x: ((tmp.x + 1) / 2) * width, y: ((1 - tmp.y) / 2) * height, behind: tmp.z > 1 };
  };

  const stop = onTick((dt) => {
    if (!onScreen) return;
    resize();
    const target = hooks.progress();
    p = still ? target : damp(p, target, 6, dt);
    if (!still) drift += dt * 0.035;

    // camera: high above the rig, down and around it, then square on to the front for the wall
    const toFront = smooth(0.56, 0.7, p);
    const phone = width < 700;
    const orbitAz = lerp(-0.95, 0.75, smooth(0.02, 0.56, p)) + drift * (1 - toFront);
    const az = lerp(orbitAz, 0, toFront);
    const el = lerp(lerp(0.78, 0.2, smooth(0.04, 0.5, p)), 0.02, toFront);
    const dist = lerp(lerp(phone ? 15 : 10.5, phone ? 11.5 : 8.2, smooth(0.04, 0.5, p)), 7, toFront);
    const ty = lerp(centre.y * 0.7, centre.y, smooth(0, 0.5, p));
    camera.position.set(centre.x + Math.sin(az) * Math.cos(el) * dist, ty + Math.sin(el) * dist, centre.z + Math.cos(az) * Math.cos(el) * dist);
    camera.lookAt(centre.x, ty, centre.z);
    camera.updateMatrixWorld();

    // the wall's size in front of the camera, D metres away: 16 x 3 tiles across most of the screen
    const D = 4;
    const vh = 2 * D * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const vw = vh * camera.aspect;
    const gap = vw * 0.004;
    let tileW = (vw * (phone ? 0.98 : 0.92) - (COLS - 1) * gap) / COLS;
    let tileH = tileW * (halfH / halfW);
    const maxH = vh * 0.6;
    if (ROWS * tileH + (ROWS - 1) * gap > maxH) {
      tileH = (maxH - (ROWS - 1) * gap) / ROWS;
      tileW = tileH * (halfW / halfH);
    }
    const gridW = COLS * tileW + (COLS - 1) * gap;
    const yOff = vh * 0.03;

    const lines = 1 - smooth(0.58, 0.68, p);
    floorMat.opacity = 0.16 * smooth(0.0, 0.12, p) * lines;
    screens.forEach((s) => {
      // appear ring by ring, around each ring
      const start = 0.03 + s.ring * 0.07 + (s.col / COLS) * 0.08;
      const shown = smooth(start, start + 0.06, p);
      // fly to the wall, left to right
      const fs = 0.58 + (s.col / COLS) * 0.07 + s.ring * 0.015;
      const f = smooth(fs, fs + 0.12, p);
      s.mat.uniforms.opacity.value = shown;
      s.mat.uniforms.back.value = lerp(0.32, 1, f);
      s.lineMat.opacity = 0.32 * shown * lines * (1 - f);
      s.holder.visible = s.lineMat.opacity > 0.003;
      s.mesh.visible = shown > 0.003;
      const pop = lerp(0.55, 1, shown);
      if (f <= 0) {
        s.mesh.position.copy(s.rigPos);
        s.mesh.quaternion.copy(s.rigQuat);
        s.mesh.scale.setScalar(pop);
        return;
      }
      gridPos.set(-gridW / 2 + s.col * (tileW + gap) + tileW / 2, ((ROWS - 1) / 2 - s.ring) * (tileH + gap) + yOff, -D).applyMatrix4(camera.matrixWorld);
      gridQuat.copy(camera.quaternion);
      const e = f * f * (3 - 2 * f);
      s.mesh.position.lerpVectors(s.rigPos, gridPos, e);
      s.mesh.quaternion.slerpQuaternions(s.rigQuat, gridQuat, e);
      s.mesh.scale.setScalar(lerp(pop, tileW / (halfW * 2), e));
    });

    // ring labels while orbiting: beside each ring's right-most screen
    const ringsOn = smooth(0.26, 0.32, p) * (1 - smooth(0.52, 0.58, p));
    ringLabels.forEach((el, r) => {
      let best = { x: -1e9, y: 0, behind: true };
      for (const s of screens) if (s.ring === r) {
        const q = toScreen(s.rigPos);
        if (!q.behind && q.x > best.x) best = q;
      }
      el.style.opacity = String(ringsOn);
      el.style.transform = `translate3d(${Math.min(best.x + 26, width - 210).toFixed(1)}px, ${(best.y - 8).toFixed(1)}px, 0)`;
    });
    // row labels on the finished wall: left of each row
    const rowsOn = smooth(0.76, 0.82, p);
    rowLabels.forEach((el, r) => {
      const s = screens[r * COLS];
      const q = toScreen(s.mesh.position);
      el.style.opacity = String(rowsOn);
      el.style.transform = `translate3d(${Math.max(4, q.x - tileW * 0.5 * (width / vw) - 46).toFixed(1)}px, ${(q.y - 8).toFixed(1)}px, 0)`;
    });

    renderer.render(scene, camera);
  });

  return () => {
    stop();
    io.disconnect();
    ro.disconnect();
    renderer.dispose();
    renderer.domElement.remove();
  };
}
