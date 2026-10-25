// seat.ts, the runtime: every move is a 0.3 s fade-jump with the world written only at full black (P24), Seat here /
// the walking anchoring / Next view / Back to my seat land where seatmath says, the edge fade's distance, the seated test, and
// the persistent anchor (old handles deleted before the new one is asked for; restored on a new session). seat.ts
// imports three and seatmath by value, so this file resolves extensionless sibling imports itself (vite does in the app).
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import type { Court, ShowFrame, Vec3 } from "../../src/court/format.ts";
import type { Head } from "../../src/court/types.ts";
import { standinBundle } from "./standin.mjs";

registerHooks({
  resolve(specifier, context, next) {
    if (/^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier) && context.parentURL?.endsWith(".ts")) {
      try {
        return next(`${specifier}.ts`, context);
      } catch {
        // not a sibling .ts: resolve as written
      }
    }
    return next(specifier, context);
  },
});
const THREE = await import("three");
const { JUMP_S, PersistentLock, Seat } = await import("../../src/court/seat.ts");
const M = await import("../../src/court/seatmath.ts");

const close = (a: number, b: number, eps = 1e-9, what = "") => assert.ok(Math.abs(a - b) <= eps, `${what} ${a} vs ${b}`);
/** Yaws compared on the circle (the group's read-back wraps to (-pi, pi]). */
const sameYaw = (a: number, b: number, what = "") => close(Math.atan2(Math.sin(a - b), Math.cos(a - b)), 0, 1e-9, `${what} yaw`);
const { court, frames } = standinBundle() as { court: Court; frames: ShowFrame[] };
const DT = 1 / 72;
const head = (room: Vec3, yaw = 0): Head => ({ room, court: room, yaw, quaternion: [0, 0, 0, 1] });

class FakeLock {
  calls: string[] = [];
  lock() {
    this.calls.push("lock");
  }
  release() {
    this.calls.push("release");
  }
  update() {}
}

function setup(distance?: number) {
  const scene = new THREE.Scene();
  const group = new THREE.Group();
  scene.add(group);
  const lock = new FakeLock();
  const seat = new Seat(court, frames, group, lock, distance);
  return { scene, group, lock, seat };
}

/** Step the seat until its fade-jump is done; the veil and the group's position each frame. */
function settle(seat: InstanceType<typeof Seat>, group: InstanceType<typeof THREE.Group>, h?: Head) {
  const log: { veil: number; x: number; z: number; yaw: number }[] = [];
  for (let i = 0; i < Math.ceil(JUMP_S / DT) + 2; i++) {
    seat.update(DT, h);
    log.push({ veil: seat.veil, x: group.position.x, z: group.position.z, yaw: group.rotation.y });
  }
  return log;
}

test("P24: Seat here is a fade-jump: the world moves once, at full black, and the veil is clear after 0.3 s", () => {
  const { seat, group, lock, scene } = setup();
  const h = head([0.3, 1.15, -0.4], 0.6);
  seat.place(h, h.yaw);
  const log = settle(seat, group, h);
  const moves = log.filter((f, i) => i > 0 && (f.x !== log[i - 1].x || f.z !== log[i - 1].z));
  assert.equal(moves.length, 1, "one move");
  const at = log.findIndex((f, i) => i > 0 && f.x !== log[i - 1].x);
  close(log[at].veil, 1, 1e-9, "veil at the move");
  assert.ok(at > 0 && log[at - 1].veil > 0.5);
  assert.equal(log.findIndex((f) => f.veil === 0 && log.indexOf(f) > at), Math.round(JUMP_S / DT) - 1, "clear by 0.3 s");
  assert.deepEqual(lock.calls, ["release", "lock"], "the anchor is released at the press and locked after the move");
  // where seatmath says: the seat's floor point under the head, F's view along its yaw (P1)
  const want = M.placeWorld(M.seatPoint(court, M.freezeCamera(court, frames), 5), h.room, h.yaw);
  close(seat.world.position[0], want.position[0]);
  close(seat.world.position[2], want.position[2]);
  sameYaw(seat.world.yaw, want.yaw);
  const r = seat.report();
  close(Math.hypot(r.seatFloor[0] - h.room[0], r.seatFloor[2] - h.room[2]), 0, 1e-9, "seat floor under the head");
  assert.equal(r.bounds, "play-area");
  // the chair and the veil live in room space
  assert.ok(scene.getObjectByName("court-chair")?.visible);
  assert.equal(scene.getObjectByName("court-veil")?.visible, false);
});

test("the demo draws no chair: drawChair(false) keeps it hidden through Seat here, and true brings it back", () => {
  const { seat, scene } = setup();
  const h = head([0.3, 1.15, -0.4], 0.6);
  seat.drawChair(false);
  seat.place(h, h.yaw);
  assert.equal(scene.getObjectByName("court-chair")?.visible, false);
  seat.drawChair(true);
  assert.ok(scene.getObjectByName("court-chair")?.visible);
});

test("?seat= clamps D' to the bundle's range", () => {
  assert.equal(setup(9).seat.distance, 7);
  assert.equal(setup(4.5).seat.distance, 4.5);
  assert.equal(setup(Number.NaN).seat.distance, court.seat.distance);
});

test("Walk closer (or standing up), Next view and Back to my seat: each one fade-jump to seatmath's pose", () => {
  const { seat, group } = setup();
  const h = head([0, 1.15, 1.8], 0);
  seat.place(h, h.yaw);
  settle(seat, group);
  const home = { ...seat.world, position: [...seat.world.position] as Vec3 };
  assert.equal(seat.hasNextView(), false, "not before the walking anchoring");
  seat.nextView();
  settle(seat, group);
  close(seat.world.position[0], home.position[0]);
  // at 3.5 x 3.5 m (the play area from the chair) the walking anchoring, and no Next view
  seat.closer();
  settle(seat, group);
  const chair = { position: [0, 0, 1.8] as Vec3, yaw: 0 };
  const w35 = M.walkingWorld(court, M.playArea(chair.position, chair.yaw), chair)!;
  close(seat.world.position[0], w35.position[0]);
  close(seat.world.position[2], w35.position[2]);
  sameYaw(seat.world.yaw, w35.yaw);
  assert.equal(seat.hasNextView(), false);
  assert.equal(seat.layout().kind, "chair");
  close(Math.hypot(...([0, 2].map((k) => M.toRoom(seat.world, seat.layout().points[0])[k] - chair.position[k]) as [number, number])), 0, 1e-9, "spot 0 is the chair");
  const r = seat.report();
  assert.ok(r.walking && r.chairClearance! >= court.seat.clear && Math.min(...r.inside) >= 0.3 && r.problems.length === 0, JSON.stringify(r.problems));
  // a 4.8 m room (bounded-floor) with the chair mid-side: a second placement passes, so Next view cycles two
  seat.useBounds([[-2.4, -2.4], [2.4, -2.4], [2.4, 2.4], [-2.4, 2.4]]);
  seat.closer();
  settle(seat, group);
  const bounds = seat.bounds!;
  const first = M.walkingWorld(court, bounds, chair)!;
  sameYaw(seat.world.yaw, first.yaw, "re-anchored on the new bounds");
  assert.equal(seat.hasNextView(), true);
  seat.nextView();
  settle(seat, group);
  const second = M.nextViewWorld(court, bounds, chair, first)!;
  sameYaw(seat.world.yaw, second.yaw, "the second placement");
  seat.nextView();
  settle(seat, group);
  sameYaw(seat.world.yaw, first.yaw, "back to the first");
  // Back to my seat: the watch anchoring
  seat.restore();
  settle(seat, group);
  close(seat.world.position[0], home.position[0]);
  sameYaw(seat.world.yaw, home.yaw);
  assert.equal(seat.report().walking, false);
  assert.equal(seat.hasNextView(), false);
});

test("a second press mid-fade retargets the jump: still one move, never a pop", () => {
  const { seat, group } = setup();
  seat.place(head([0, 1.15, 1.8]), 0);
  seat.useBounds([[-2.4, -2.4], [2.4, -2.4], [2.4, 2.4], [-2.4, 2.4]]);
  settle(seat, group);
  seat.closer();
  seat.update(DT);
  seat.update(DT);
  seat.nextView(); // before the first move happened
  const log = settle(seat, group);
  const moves = log.filter((f, i) => i > 0 && f.x !== log[i - 1].x);
  assert.equal(moves.length, 1);
  const veils = log.map((f) => f.veil);
  for (let i = 1; i < veils.length; i++) assert.ok(Math.abs(veils[i] - veils[i - 1]) < 0.35, `veil ${veils[i - 1]} -> ${veils[i]}`);
});

test("P35: the edge fade's distance is to the play area set at Seat here (corner chair: 0.6 m), or to bounded-floor's polygon", () => {
  const { seat, group } = setup();
  assert.equal(seat.boundsDistance(head([0, 1.2, 0])), Infinity);
  seat.place(head([1, 1.15, 1]), 0.4);
  settle(seat, group);
  close(seat.boundsDistance(head([1, 1.15, 1])), 0.6, 1e-9);
  seat.useBounds([[-2, -2], [2, -2], [2, 2], [-2, 2]]);
  close(seat.boundsDistance(head([1, 1.15, 1])), 1, 1e-9);
  assert.equal(seat.report().bounds, "bounded-floor");
  seat.useBounds(null);
  close(seat.boundsDistance(head([1, 1.15, 1])), 0.6, 1e-9);
});

test("3.5: seated() is true once the judge is back in the chair, low and still for 0.5 s", () => {
  const { seat, group } = setup();
  seat.place(head([0, 1.15, 0]), 0);
  settle(seat, group);
  seat.closer();
  settle(seat, group);
  let n = 0;
  for (; n < 72; n++) seat.seated(head([1.2, 1.7, -0.8]));
  assert.equal(seat.seated(head([0.1, 1.7, 0.1])), false, "standing at the chair");
  for (n = 0; n < 200 && !seat.seated(head([0.05, 1.2, 0.08])); n++);
  assert.ok(n >= 35 && n <= 38, `${n} frames`);
});

test("3.5: a judge who never stood and presses Back is seated at once (still for 0.5 s at their own seated height)", () => {
  const { seat, group } = setup();
  seat.place(head([0, 1.15, 0]), 0);
  settle(seat, group);
  seat.closer();
  settle(seat, group);
  let n = 0;
  for (; n < 120 && !seat.seated(head([0.02, 1.16, 0.03])); n++);
  assert.ok(n >= 35 && n <= 38, `${n} frames`);
});

test("useBounds refuses bounds with no area (empty, coincident, flat): the play area stays and Walk closer still works", () => {
  const { seat, group } = setup();
  const h = head([0, 1.15, 1.8], 0);
  seat.place(h, h.yaw);
  settle(seat, group);
  for (const poly of [[], [[0, 0], [0, 0], [0, 0]], [[0, 0], [1, 0], [2, 0]]] as [number, number][][]) {
    seat.useBounds(poly);
    const r = seat.report();
    assert.equal(r.bounds, "play-area", JSON.stringify(poly));
    assert.notEqual(r.why, "no usable bounds");
  }
  seat.closer();
  settle(seat, group);
  assert.equal(seat.report().walking, true);
});

// ---------------- the persistent anchor ----------------

class FakeAnchor {
  deleted = false;
  anchorSpace = {};
  constructor(readonly site: FakeSite) {}
  delete() {
    this.deleted = true;
  }
  requestPersistentHandle() {
    this.site.log.push(`request (held ${this.site.handles.size})`);
    const uuid = `h${++this.site.n}`;
    this.site.handles.add(uuid);
    return Promise.resolve(uuid);
  }
}
class FakeSite {
  handles = new Set<string>();
  log: string[] = [];
  n = 0;
  /** The site refuses to delete (a stale or foreign handle). */
  stuck = false;
}
function fakeXr(site: FakeSite) {
  const session = {
    get persistentAnchors() {
      return [...site.handles];
    },
    deletePersistentAnchor(uuid: string) {
      site.log.push(`delete ${uuid}`);
      if (site.stuck) return Promise.reject(new Error("refused"));
      site.handles.delete(uuid);
      return Promise.resolve();
    },
    restorePersistentAnchor(uuid: string) {
      site.log.push(`restore ${uuid}`);
      return site.handles.has(uuid) ? Promise.resolve(new FakeAnchor(site)) : Promise.reject(new Error("gone"));
    },
  };
  const frame = { createAnchor: () => Promise.resolve(new FakeAnchor(site)), getPose: () => null };
  return { xr: { session, getSession: () => session as unknown as XRSession, getFrame: () => frame as unknown as XRFrame, getReferenceSpace: () => ({}) as XRReferenceSpace } };
}
(globalThis as Record<string, unknown>).XRRigidTransform ??= class {
  constructor(readonly position: unknown, readonly orientation: unknown) {}
};
const tick = () => new Promise((r) => setTimeout(r, 0));

test("the persistent anchor: old handles are deleted before the new one is asked for, so the site never holds more than one", async () => {
  const site = new FakeSite();
  site.handles.add("stale-1").add("stale-2"); // left by an earlier run
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  const r = fakeXr(site);
  const lock = new PersistentLock(r, new THREE.Group(), storage);
  for (let i = 0; i < 4; i++) {
    lock.lock();
    await tick();
    await tick();
    assert.equal(site.handles.size, 1, `after Seat here ${i + 1}: ${[...site.handles]}`);
  }
  const requests = site.log.filter((l) => l.startsWith("request"));
  assert.ok(requests.every((l) => l === "request (held 0)"), site.log.join(", "));
  assert.equal(store.get("court-side.anchor"), [...site.handles][0]);
  // a new session (re-entry after a system pinch) restores this page's handle
  const again = fakeXr(site);
  const lock2 = new PersistentLock(again, new THREE.Group(), storage);
  lock2.update();
  await tick();
  assert.ok(site.log.at(-1)!.startsWith("restore h"), site.log.at(-1));
});

test("the persistent anchor: a handle the site won't delete stops new requests (never fills the 8-handle quota), and a later delete frees it", async () => {
  const site = new FakeSite();
  site.handles.add("stale-1");
  site.stuck = true;
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  const lock = new PersistentLock(fakeXr(site), new THREE.Group(), storage);
  for (let i = 0; i < 4; i++) {
    lock.lock();
    await tick();
    await tick();
  }
  assert.equal(site.log.filter((l) => l.startsWith("request")).length, 0, site.log.join(", "));
  assert.deepEqual([...site.handles], ["stale-1"]);
  assert.equal(store.get("court-side.anchor"), undefined, "the old pose never comes back on a re-entry");
  // the site lets go: the next Seat here deletes it and asks for one
  site.stuck = false;
  lock.lock();
  await tick();
  await tick();
  assert.equal(site.handles.size, 1);
  assert.ok(!site.handles.has("stale-1"));
  assert.deepEqual(site.log.filter((l) => l.startsWith("request")), ["request (held 0)"]);
});
