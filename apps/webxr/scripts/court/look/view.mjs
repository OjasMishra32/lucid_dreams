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

/** Luma (0-255) of a saved frame in an r-pixel window round each court point, one value per point (NaN off screen). */
export function lumaEach(ctx, name, view, points, r = 3) {
  const img = readPng(join(ctx.out, `${name}.png`));
  return points.map((p) => {
    const px = project(view, p);
    if (!px) return NaN;
    let sum = 0;
    let n = 0;
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const X = Math.round(px[0]) + dx;
        const Y = Math.round(px[1]) + dy;
        if (X < 0 || Y < 0 || X >= img.width || Y >= img.height) continue;
        const o = (Y * img.width + X) * img.channels;
        sum += 0.2126 * img.data[o] + 0.7152 * img.data[o + 1] + 0.0722 * img.data[o + 2];
        n++;
      }
    return n ? sum / n : NaN;
  });
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

/**
 * Floor points the bundle marks as filmed and as rendered (imagined), for the Reality check (P23): a 0.5 m grid over the
 * court read against floor-seen.png (filmed: white within 0.6 m all round; imagined: black within 0.6 m all round, so
 * no point sits on the mask's soft edge), plus the apron round the court (outside floor-seen's extent, always rendered).
 * Points off the frame, or under a person, the ball or the hoop in `view`, are left out.
 */
export async function realityPoints(ctx, view) {
  const c = ctx.court.court;
  const [hl, hw] = [c.length / 2, c.width / 2];
  const grid = [];
  for (let x = -hl - 1.7; x <= hl + 1.7; x += 0.5)
    for (let z = -hw - 1.7; z <= hw + 1.7; z += 0.5) {
      const inside = Math.abs(x) <= hl - 0.3 && Math.abs(z) <= hw - 0.3;
      const apron = Math.abs(x) >= hl + 0.3 || Math.abs(z) >= hw + 0.3;
      if (inside || apron) grid.push([x, z, inside]);
    }
  // the mask, read in the page from the bundle's own file
  const marks = await ctx.page.evaluate(
    async ([pts, path, len, wid]) => {
      const img = new Image();
      img.src = window.__courtLook.world.bundle.file(path);
      await img.decode();
      const cv = document.createElement("canvas");
      cv.width = img.naturalWidth;
      cv.height = img.naturalHeight;
      const g = cv.getContext("2d", { willReadFrequently: true });
      g.drawImage(img, 0, 0);
      const data = g.getImageData(0, 0, cv.width, cv.height).data;
      // the floor shader's uv: u along +x, v = 1 - (z + w/2) / w on a flipY texture, so image row 0 is z = -w/2
      const at = (x, z) => {
        const u = Math.min(1, Math.max(0, (x + len / 2) / len));
        const v = Math.min(1, Math.max(0, (z + wid / 2) / wid));
        const X = Math.min(cv.width - 1, Math.floor(u * cv.width));
        const Y = Math.min(cv.height - 1, Math.floor(v * cv.height));
        return data[(Y * cv.width + X) * 4] / 255;
      };
      return pts.map(([x, z, inside]) => {
        if (!inside) return "imagined";
        let lo = 1;
        let hi = 0;
        for (const dx of [-0.6, 0, 0.6])
          for (const dz of [-0.6, 0, 0.6]) {
            const m = at(x + dx, z + dz);
            lo = Math.min(lo, m);
            hi = Math.max(hi, m);
          }
        return lo >= 0.99 ? "seen" : hi <= 0.01 ? "imagined" : null;
      });
    },
    [grid, c.floorSeen, c.length, c.width],
  );
  const boxes = standingBoxes(ctx, view);
  const out = { seen: [], imagined: [] };
  grid.forEach(([x, z], i) => {
    if (!marks[i]) return;
    const q = project(view, [x, 0, z]);
    const [vx, vy, vw, vh] = view.viewport;
    if (!q || q[0] < vx + 4 || q[1] < vy + 4 || q[0] >= vx + vw - 4 || q[1] >= vy + vh - 4) return;
    if (boxes.some(([x0, y0, x1, y1]) => q[0] >= x0 && q[0] <= x1 && q[1] >= y0 && q[1] <= y1)) return;
    out[marks[i]].push([x, 0, z]);
  });
  return out;
}

/** What stands on the floor in `view` (the players, the extras, the ball, the hoop), as screen boxes with 8 px to spare. */
export function standingBoxes(ctx, view) {
  const fz = ctx.court.freeze;
  const boxes = [];
  const box = (min, max) => {
    const px = [];
    for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) px.push(project(view, [x, y, z]));
    if (px.some((q) => !q)) return;
    boxes.push([Math.min(...px.map((q) => q[0])) - 8, Math.min(...px.map((q) => q[1])) - 8, Math.max(...px.map((q) => q[0])) + 8, Math.max(...px.map((q) => q[1])) + 8]);
  };
  for (const p of fz.players) box(p.bounds.min, p.bounds.max);
  for (const o of fz.others) box([o.foot[0] - 0.7, 0, o.foot[2] - 0.7], [o.foot[0] + 0.7, o.height + 0.1, o.foot[2] + 0.7]);
  const b = fz.ball;
  box(b.centre.map((v) => v - b.radius), b.centre.map((v) => v + b.radius));
  const rim = ctx.court.court.rim;
  box([rim[0] - 2.2, 0, rim[2] - 1.2], [rim[0] + 2.2, rim[1] + 1.3, rim[2] + 1.2]); // ring, board, pole and base
  return boxes;
}

/** Court floor points (0.5 m grid) at least `away` metres from the pair's centre, on screen in `view`, not under anyone. */
export function backgroundPoints(ctx, view, away = 4.5) {
  const c = ctx.court.court;
  const [px, , pz] = ctx.court.seat.pairCentre;
  const boxes = standingBoxes(ctx, view);
  const [vx, vy, vw, vh] = view.viewport;
  const out = [];
  for (let x = -c.length / 2 + 0.25; x < c.length / 2; x += 0.5)
    for (let z = -c.width / 2 + 0.25; z < c.width / 2; z += 0.5) {
      if (Math.hypot(x - px, z - pz) < away) continue;
      const q = project(view, [x, 0, z]);
      if (!q || q[0] < vx + 4 || q[1] < vy + 4 || q[0] >= vx + vw - 4 || q[1] >= vy + vh - 4) continue;
      if (boxes.some(([x0, y0, x1, y1]) => q[0] >= x0 && q[0] <= x1 && q[1] >= y0 && q[1] <= y1)) continue;
      out.push([x, 0, z]);
    }
  return out;
}

/** Blue over red, summed over r-pixel windows round each court point of a saved frame. */
export function blueRedAt(ctx, name, view, points, r = 2) {
  const img = readPng(join(ctx.out, `${name}.png`));
  let red = 0;
  let blue = 0;
  for (const p of points) {
    const px = project(view, p);
    if (!px) continue;
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const o = ((Math.round(px[1]) + dy) * img.width + Math.round(px[0]) + dx) * img.channels;
        red += img.data[o];
        blue += img.data[o + 2];
      }
  }
  return blue / Math.max(1, red);
}

export const alphaOk = (frames) => frames.every((f) => f.alphaMin === 255);
