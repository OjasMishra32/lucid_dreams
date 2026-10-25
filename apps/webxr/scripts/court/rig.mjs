// Stream C's e2e helpers (not a scenario): IWER's head and hands driven by their joints, read through the probe pages'
// window.__courtUi (ui.ts) and window.__courtSeat (seat.ts). The left palm is turned up toward the eyes to open the
// menu; the right index tip is pushed into a button (front -> 6 mm inside -> front) or held there.

const qmul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qinv = (q) => [-q[0], -q[1], -q[2], q[3]];
const yawQuat = (yaw) => [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
const fmt = (v, d = 3) => (Array.isArray(v) ? `[${v.map((x) => x.toFixed(d)).join(", ")}]` : Number(v).toFixed(d));
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/** The hand, head and menu helpers over one page. */
export function rig(ctx) {
  const ui = (fn, arg) => ctx.page.evaluate(([src, a]) => new Function("ui", "arg", `return (${src})(ui, arg)`)(window.__courtUi, a), [fn.toString(), arg]);
  const seat = () => ctx.page.evaluate(() => window.__courtSeat?.report() ?? null);
  /** seat.ts's distance from a room point to the bounds (the edge fade's input, P35). */
  const edge = (p) => ctx.page.evaluate((x) => window.__courtSeat?.boundsDistance(x) ?? null, p);
  const head = { p: [0, 1.15, 0], yaw: 0 };
  const r = {
    ui,
    seat,
    edge,
    head,
    async setHead(p, yaw = 0) {
      head.p = p;
      head.yaw = yaw;
      await ctx.device((d, a) => {
        d.position.set(a.p[0], a.p[1], a.p[2]);
        d.quaternion.set(a.q[0], a.q[1], a.q[2], a.q[3]);
      }, { p, q: yawQuat(yaw) });
    },
    joint: (side, name) => ui((u, a) => u.joint(a[0], a[1]), [side, name]),
    async moveJointTo(side, name, target) {
      for (let i = 0; i < 2; i++) {
        const j = await r.joint(side, name);
        if (!j) throw new Error(`IWER ${side} ${name} is not tracked`);
        await ctx.device((d, a) => {
          const h = d.hands[a.side];
          h.position.set(h.position.x + a.t[0] - a.j[0], h.position.y + a.t[1] - a.j[1], h.position.z + a.t[2] - a.j[2]);
        }, { side, t: target, j: j.p });
        await ctx.frames(3);
      }
    },
    /** Left palm up toward the eyes (or down), 0.37 m below and 0.32 m in front of them, then wait for the menu's 220 ms. */
    async palm(up) {
      await ctx.device((d) => {
        d.hands.left.poseId = "default";
        d.hands.left.updatePinchValue(0);
      });
      await ctx.frames(3);
      const mc = await r.joint("left", "middle-finger-metacarpal");
      if (!mc) throw new Error("IWER left palm is not tracked");
      const hand = await ctx.device((d) => d.hands.left.quaternion.toArray?.() ?? [d.hands.left.quaternion.x, d.hands.left.quaternion.y, d.hands.left.quaternion.z, d.hands.left.quaternion.w]);
      // in WebXR a joint's -Y points out of the palm: up = turned pi about X, then about the head's yaw
      const target = qmul(yawQuat(head.yaw), up ? [1, 0, 0, 0] : [0, 0, 0, 1]);
      const q = qmul(qmul(target, qinv(mc.q)), hand);
      await ctx.device((d, a) => d.hands.left.quaternion.set(a[0], a[1], a[2], a[3]), q);
      await ctx.frames(3);
      const s = Math.sin(head.yaw);
      const c = Math.cos(head.yaw);
      // (-0.16, -0.37, -0.32) in the head's frame
      const off = [-0.16 * c + -0.32 * s, -0.37, 0.16 * s + -0.32 * c];
      await r.moveJointTo("left", "middle-finger-metacarpal", [head.p[0] + off[0], head.p[1] + off[1], head.p[2] + off[2]]);
      await ctx.frames(40);
    },
    menuOpen: () => ui((u) => u.menuOpen()),
    buttons: () => ui((u) => u.buttons()),
    async button(id) {
      const b = (await r.buttons()).find((x) => x.id === id);
      if (!b) throw new Error(`no "${id}" on the menu (have ${(await r.buttons()).map((x) => x.id).join(", ")})`);
      return b;
    },
    async point() {
      await ctx.device((d) => {
        d.hands.right.poseId = "point";
        d.hands.right.updatePinchValue(0);
      });
      await ctx.frames(3);
    },
    /** A fingertip press: in front, 6 mm in, back out. */
    async press(id) {
      await r.point();
      const b = await r.button(id);
      await r.moveJointTo("right", "index-finger-tip", b.front);
      await ctx.frames(6);
      await r.moveJointTo("right", "index-finger-tip", b.inside);
      await ctx.frames(4);
      await r.moveJointTo("right", "index-finger-tip", b.front);
      await ctx.frames(6);
    },
    /** Hold the right index tip in a button for `ms` of real time (the frame loop's clock), then take it out. */
    async hold(id, ms) {
      await r.point();
      const b = await r.button(id);
      await r.moveJointTo("right", "index-finger-tip", b.front);
      await ctx.frames(6);
      await r.moveJointTo("right", "index-finger-tip", b.inside);
      await ctx.page.waitForTimeout(ms);
      await r.moveJointTo("right", "index-finger-tip", [b.front[0], b.front[1], b.front[2]]);
      await ctx.frames(30);
    },
    /** Both hands well away from the menu, palm down. */
    async handsAway() {
      await r.palm(false);
      await ctx.device((d) => {
        d.hands.left.position.set(-0.9, 1.0, -0.6);
        d.hands.right.position.set(0.9, 1.0, -0.6);
      });
      await ctx.frames(30);
    },
    /** The hand-over: headset off (the Quest reports visible-blurred), then on. */
    async handOver() {
      await ctx.device((d) => d.updateVisibilityState("visible-blurred"));
      await ctx.frames(20);
      await ctx.device((d) => d.updateVisibilityState("visible"));
      await ctx.frames(3);
    },
  };
  return r;
}

/** wrap: an angle into (-pi, pi]; fmt: numbers for a check's detail. */
export { wrap, fmt };
