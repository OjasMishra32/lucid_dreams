import * as THREE from "three";
import type { XRDevice } from "iwer";
import type { FrameInfo, Mode } from "./court-quest";

type TestApp = {
  device: XRDevice;
  nextFrame: () => Promise<FrameInfo>;
  session: XRSession;
  phaseS: number;
  mode: Mode;
  focus: () => THREE.Vector3; // world point between the two players' chests
  hud: () => THREE.Vector3;
  panel: () => THREE.Vector3;
  buttons: () => { yes: THREE.Vector3; no: THREE.Vector3; asking: boolean };
  answers: () => Record<string, boolean | "skip">;
  edge: () => { level: number; distanceM: number | null; area: string };
  result: () => object;
};

const RING_M = 1.5;
const OFF_MS = 1500;

// Desktop proof: screenshots of each kind of phase, one walk round a 1.5 m ring during the walk phase while the page
// measures, the boundary questions answered by pinching, a sideways walk to the edge of the play area, then the
// headset taken "off" (IWER visibility hidden) for 1.5 s and put back on. Returns what it saw; the page publishes it.
export async function runSelfTest(app: TestApp): Promise<Record<string, unknown>> {
  const { device, nextFrame } = app;
  const shots: string[] = [];
  const limitations: string[] = [];
  const shotAt: Record<string, [string, number]> = {
    video: ["s6-video", 1], freeze: ["s6-freeze", 1], handoff: ["s6-handoff", 1], wc: ["s6-wc", 1.5],
    "reveal-cold": ["s6-veil", 0.5], "reveal-warm": ["s6-under-veil", 1.5], room: ["s6-room", 1.6],
  };
  const taken = new Set<string>();
  const seen = new Set<string>();
  const poses: { radiusM: number; angleDeg: number }[] = [];
  let center: THREE.Vector3 | null = null;
  let angle0 = 0;
  let info: FrameInfo;
  const shoot = async (name: string, lookAt?: THREE.Vector3) => {
    if (lookAt) {
      // stand 0.8 m in front of a panel, on the line from the start, facing it
      const stand = new THREE.Vector3(0, 1.6, 0).sub(lookAt).setY(0).normalize().multiplyScalar(0.8).add(lookAt).setY(1.6);
      const face = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(stand, lookAt, new THREE.Vector3(0, 1, 0)));
      device.position.set(stand.x, stand.y, stand.z);
      device.quaternion.set(face.x, face.y, face.z, face.w);
      for (let i = 0; i < 20; i++) await nextFrame();
    }
    if (window.__spikeScreenshot) shots.push(await window.__spikeScreenshot(name));
    else limitations.push(`Screenshot ${name} unavailable outside spike_run.mjs.`);
  };
  do {
    info = await nextFrame();
    seen.add(info.key);
    const shot = shotAt[info.key];
    if (shot && !taken.has(info.key) && info.stageElapsed >= shot[1]) {
      taken.add(info.key);
      await shoot(`${shot[0]}${app.mode === "vr" ? "" : "-ar"}`);
    }
    if (info.key !== "freeze-walk") continue;
    if (!center) {
      center = app.focus();
      angle0 = Math.atan2(info.head.z - center.z, info.head.x - center.x);
    }
    const dx = info.head.x - center.x;
    const dz = info.head.z - center.z;
    poses.push({ radiusM: Math.hypot(dx, dz), angleDeg: THREE.MathUtils.radToDeg(Math.atan2(dz, dx)) });
    const angle = angle0 + 2 * Math.PI * Math.min(1, info.stageElapsed / app.phaseS);
    const head = new THREE.Vector3(center.x + RING_M * Math.cos(angle), 1.6, center.z + RING_M * Math.sin(angle));
    const look = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(head, center, new THREE.Vector3(0, 1, 0)));
    device.position.set(head.x, head.y, head.z);
    device.quaternion.set(look.x, look.y, look.z, look.w);
  } while (info.key !== "done");
  for (let i = 0; i < 20; i++) await nextFrame();

  // the boundary questions: aim the right hand's ray at a button and pinch (VR: yes, no; AR-opaque: no, yes, yes)
  const planned = app.mode === "vr" ? [true, false] : [false, true, true];
  const presses: { wanted: boolean; recorded: boolean | "skip" | null }[] = [];
  const hand = device.hands.right!;
  await shoot(`s6-question${app.mode === "vr" ? "" : "-ar"}`, app.panel());
  for (const wanted of planned) {
    const before = Object.keys(app.answers()).length;
    const { yes, no, asking } = app.buttons();
    if (!asking) break;
    const target = wanted ? yes : no;
    const from = new THREE.Vector3(device.position.x + 0.2, device.position.y - 0.3, device.position.z);
    const aim = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(from, target, new THREE.Vector3(0, 1, 0)));
    hand.position.set(from.x, from.y, from.z);
    hand.quaternion.set(aim.x, aim.y, aim.z, aim.w);
    for (let i = 0; i < 6; i++) await nextFrame();
    if (!presses.length) await shoot(`s6-aim${app.mode === "vr" ? "" : "-ar"}`);
    hand.updatePinchValue(1);
    for (let i = 0; i < 6; i++) await nextFrame();
    hand.updatePinchValue(0);
    for (let i = 0; i < 8; i++) await nextFrame();
    const now = app.answers();
    const ids = Object.keys(now);
    presses.push({ wanted, recorded: ids.length > before ? now[ids[ids.length - 1]] : null });
  }
  for (let i = 0; i < 10; i++) await nextFrame();
  await shoot(`s6-answers${app.mode === "vr" ? "" : "-ar"}`, app.panel());

  // the edge fade: step sideways (left, clear of the players) from the start to the edge of the play area, reading
  // its level (it is only applied in AR-opaque)
  const edgeProbe: { leftM: number; distanceM: number | null; level: number }[] = [];
  const start = new THREE.Vector3(0, 1.6, 0);
  for (const left of [0, 0.9, 1.15, 1.3, 1.45, 1.6, 1.9]) {
    device.position.set(start.x - left, start.y, start.z);
    device.quaternion.set(0, 0, 0, 1);
    for (let i = 0; i < 4; i++) await nextFrame();
    const e = app.edge();
    edgeProbe.push({ leftM: left, distanceM: e.distanceM === null ? null : Number(e.distanceM.toFixed(3)), level: Number(e.level.toFixed(3)) });
    if (left === 1.3 && app.mode !== "vr") await shoot("s6-edge-half-ar");
    if (left === 1.6 && app.mode !== "vr") await shoot("s6-edge-room-ar");
  }
  device.position.set(start.x, start.y, start.z);

  // "take the headset off": hidden for 1.5 s, then visible again
  device.updateVisibilityState("hidden");
  await nextFrame();
  await new Promise((resolve) => setTimeout(resolve, OFF_MS));
  device.updateVisibilityState("visible");
  for (let i = 0; i < 20; i++) await nextFrame();

  // both panels, read from 0.8 m (hands put away, so their dots don't cover them)
  for (const h of [device.hands.left, device.hands.right]) if (h) h.connected = false;
  await shoot(`s6-hud${app.mode === "vr" ? "" : "-ar"}`, app.hud());
  await shoot(`s6-panel${app.mode === "vr" ? "" : "-ar"}`, app.panel());
  const radii = poses.map((p) => p.radiusM);
  const swept = poses.length ? poses.reduce((sum, p, i) => {
    if (!i) return 0;
    let d = p.angleDeg - poses[i - 1].angleDeg;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    return sum + Math.abs(d);
  }, 0) : 0;
  return {
    mode: app.mode, frameRateInEffect: app.session.frameRate ?? null, phasesSeen: [...seen],
    walk: { samples: poses.length, ringM: RING_M, minRadiusM: Math.min(...radii), maxRadiusM: Math.max(...radii), sweptDeg: Math.round(swept) },
    offMs: OFF_MS, presses, edgeProbe, shots, limitations,
  };
}
