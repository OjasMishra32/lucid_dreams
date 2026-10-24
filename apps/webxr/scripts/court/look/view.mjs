// Stream E's e2e helpers (not a scenario: scenarios/ holds only the scenario files). They reach the look through
// window.__courtLook (dev only: world.ts and freeze.ts register themselves), so the checks run before the clock, the
// hand-off and the seat are built; court.ts's own calls take over as those land.
import { join } from "node:path";
import { readPng } from "../png.mjs";

export const HZ = 72;

/** Put the IWER head at the seat (court space through the world group), seated, looking at the pair. */
export async function sitAtSeat(ctx, eye = 1.15) {
  await ctx.page.evaluate(([eyeY]) => {
    const L = window.__courtLook;
    const light = L.world.light;
    const worldGroup = L.world.group.parent;
    worldGroup.updateWorldMatrix(true, false);
    const m = worldGroup.matrixWorld.elements;
    const toRoom = ([x, y, z]) => [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
    const seat = toRoom([light.seatFloor[0], 0, light.seatFloor[2]]);
    const pair = toRoom([light.pairXZ[0], 1.0, light.pairXZ[1]]);
    const eyeP = [seat[0], eyeY, seat[2]];
    const f = [pair[0] - eyeP[0], pair[1] - eyeP[1], pair[2] - eyeP[2]];
    const yaw = Math.atan2(-f[0], -f[2]);
    const pitch = Math.asin(f[1] / Math.hypot(...f));
    // q = qY(yaw) * qX(pitch)
    const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2), cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2);
    const d = window.__xrDevice;
    d.position.set(eyeP[0], eyeP[1], eyeP[2]);
    d.quaternion.set(cy * sp, sy * cp, -sy * sp, cy * cp);
  }, [eye]);
  await ctx.frames(2);
}

/** Put the IWER head at a court-space point (through the world group), keeping its orientation. */
export async function headAt(ctx, court) {
  await ctx.page.evaluate((p) => {
    const g = window.__courtLook.world.group.parent;
    g.updateWorldMatrix(true, false);
    const m = g.matrixWorld.elements;
    window.__xrDevice.position.set(m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]);
  }, court);
}

/** The light (and the freeze's reveal), one display frame at a time, inside the page (one round trip): [beat, t, reveal|null]. */
export async function runLight(ctx, steps) {
  return ctx.page.evaluate(async (list) => {
    const L = window.__courtLook;
    const out = [];
    for (const [beat, t, reveal] of list) {
      L.world.light.set(beat, t);
      if (reveal !== null) L.freeze?.reveal(reveal);
      out.push(await window.__court.nextFrame());
    }
    return out;
  }, steps);
}

/** Largest per-cell luma change between consecutive frames (the 16 x 9 grid), and the frame it happened at. */
export function worstStep(frames) {
  let worst = 0;
  let at = -1;
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1].thumb;
    const b = frames[i].thumb;
    if (!a || !b) continue;
    for (let k = 0; k < a.length; k++) {
      const d = Math.abs(a[k] - b[k]);
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
  }
  return { worst, at };
}

/** A court point in a logged view, as read-back buffer pixels [x, y] (top-down), or null behind it. */
export function project(view, p) {
  const [x, y, z, w] = view.q;
  const v = [p[0] - view.centre[0], p[1] - view.centre[1], p[2] - view.centre[2]];
  // the inverse rotation (conjugate) applied to v
  const qx = -x, qy = -y, qz = -z;
  const tx = 2 * (qy * v[2] - qz * v[1]);
  const ty = 2 * (qz * v[0] - qx * v[2]);
  const tz = 2 * (qx * v[1] - qy * v[0]);
  const c = [v[0] + w * tx + (qy * tz - qz * ty), v[1] + w * ty + (qz * tx - qx * tz), v[2] + w * tz + (qx * ty - qy * tx)];
  if (c[2] <= 1e-6) return null;
  return [view.viewport[0] + view.cx + (view.fx * c[0]) / c[2], view.viewport[1] + view.cy + (view.fy * c[1]) / c[2]];
}

/** Mean luma (0-255) of a saved frame in r-pixel windows round each court point (the points' own pixels). */
export function lumaAt(ctx, name, view, points, r = 3) {
  const img = readPng(join(ctx.out, `${name}.png`));
  let sum = 0;
  let n = 0;
  for (const p of points) {
    const px = project(view, p);
    if (!px) continue;
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const X = Math.round(px[0]) + dx;
        const Y = Math.round(px[1]) + dy;
        if (X < 0 || Y < 0 || X >= img.width || Y >= img.height) continue;
        const o = (Y * img.width + X) * img.channels;
        sum += 0.2126 * img.data[o] + 0.7152 * img.data[o + 1] + 0.0722 * img.data[o + 2];
        n++;
      }
  }
  return n ? sum / n : NaN;
}

/** Blue over red across a saved frame (the Reality check's tint). */
export function blueRatio(ctx, name) {
  const img = readPng(join(ctx.out, `${name}.png`));
  let r = 0;
  let b = 0;
  for (let i = 0; i < img.data.length; i += img.channels) {
    r += img.data[i];
    b += img.data[i + 2];
  }
  return b / Math.max(1, r);
}

export const alphaOk = (frames) => frames.every((f) => f.alphaMin === 255);
