// diff.mjs (the screenshot diff: PSNR, SSIM, alignment in degrees) and png.mjs (the PNG codec it reads with).
import { test } from "node:test";
import assert from "node:assert/strict";
import { alignment, compare, psnr, pxPerDeg, shift, ssim } from "./diff.mjs";
import { decodePng, encodePng } from "./png.mjs";

type Img = { width: number; height: number; channels: number; data: Uint8Array };

/** A textured RGB test image (smooth blobs and edges), optionally moved by (dx, dy) px with bilinear sampling. */
function scene(w: number, h: number, dx = 0, dy = 0): Img {
  const data = new Uint8Array(w * h * 3);
  const f = (x: number, y: number) => {
    const a = 128 + 60 * Math.sin(x / 7.3) * Math.cos(y / 5.1) + 40 * Math.sin((x + 2 * y) / 13.7);
    const edge = (x - 0.6 * y) % 40 < 20 ? 30 : -30;
    return Math.max(0, Math.min(255, a + edge * (((x / 40) | 0) % 2 ? 1 : 0.5)));
  };
  const sample = (x: number, y: number) => {
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    return (1 - fx) * (1 - fy) * f(x0, y0) + fx * (1 - fy) * f(x0 + 1, y0) + (1 - fx) * fy * f(x0, y0 + 1) + fx * fy * f(x0 + 1, y0 + 1);
  };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = sample(x - dx, y - dy);
      data.set([v, 0.8 * v + 20, 255 - v], (y * w + x) * 3);
    }
  return { width: w, height: h, channels: 3, data };
}

function noisy(img: Img, sigma: number, seed = 1): Img {
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const out = new Uint8Array(img.data.length);
  for (let i = 0; i < out.length; i++) {
    // Box-Muller
    const n = Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
    out[i] = Math.max(0, Math.min(255, Math.round(img.data[i] + sigma * n)));
  }
  return { ...img, data: out };
}

function blurred(img: Img, r: number): Img {
  const { width: w, height: h, channels: c } = img;
  const out = new Uint8Array(img.data.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let k = 0; k < c; k++) {
        let sum = 0, n = 0;
        for (let j = -r; j <= r; j++)
          for (let i = -r; i <= r; i++) {
            const xx = Math.min(w - 1, Math.max(0, x + i)), yy = Math.min(h - 1, Math.max(0, y + j));
            sum += img.data[(yy * w + xx) * c + k];
            n++;
          }
        out[(y * w + x) * c + k] = Math.round(sum / n);
      }
  return { ...img, data: out };
}

test("identical images: PSNR infinite, SSIM 1, no shift", () => {
  const a = scene(160, 120);
  assert.equal(psnr(a, a), Infinity);
  assert.ok(Math.abs(ssim(a, a) - 1) < 1e-9);
  const s = shift(a, a, { maxPx: 4 });
  assert.ok(Math.abs(s.dx) < 1e-6 && Math.abs(s.dy) < 1e-6);
});

test("PSNR of Gaussian noise matches 20 log10(255 / sigma)", () => {
  const a = scene(200, 150);
  const b = noisy(a, 4);
  const want = 20 * Math.log10(255 / 4);
  assert.ok(Math.abs(psnr(a, b) - want) < 0.6, `${psnr(a, b)} vs ${want}`);
});

test("PSNR inside a mask ignores everything outside it", () => {
  const a = scene(100, 80);
  const b = { ...a, data: a.data.slice() };
  for (let i = 0; i < 40 * 80; i++) {
    const x = i % 40;
    const y = (i / 40) | 0;
    b.data.fill(0, (y * 100 + x) * 3, (y * 100 + x) * 3 + 3); // the left 40 columns blacked out
  }
  const mask = new Uint8Array(100 * 80).map((_, i) => (i % 100 >= 40 ? 255 : 0));
  assert.equal(psnr(a, b, mask), Infinity);
  assert.ok(psnr(a, b) < 20);
});

test("SSIM falls as the image blurs", () => {
  const a = scene(160, 120);
  const s1 = ssim(a, blurred(a, 1));
  const s3 = ssim(a, blurred(a, 3));
  assert.ok(s1 < 1 && s1 > s3 && s3 > 0.2, `${s1} ${s3}`);
});

test("a whole-pixel shift is found exactly", () => {
  const a = scene(240, 180);
  const b = scene(240, 180, 3, -2);
  const s = shift(a, b, { maxPx: 6 });
  assert.ok(Math.abs(s.dx - 3) < 0.05 && Math.abs(s.dy + 2) < 0.05, JSON.stringify(s));
});

test("a sub-pixel shift is found to a tenth of a pixel", () => {
  const a = scene(240, 180);
  const b = scene(240, 180, 1.5, 0.3);
  const s = shift(a, b, { maxPx: 4 });
  assert.ok(Math.abs(s.dx - 1.5) < 0.12 && Math.abs(s.dy - 0.3) < 0.12, JSON.stringify(s));
});

test("pixels per degree at the image centre, and shifts in degrees", () => {
  // a 90 deg vertical field over 2000 px: (1000 / tan 45 deg) x pi / 180
  assert.ok(Math.abs(pxPerDeg(90, 2000) - (1000 * Math.PI) / 180) < 1e-9);
  const a = scene(320, 240);
  const b = scene(320, 240, 2, 0);
  const al = alignment(a, b, { pxPerDeg: 20, maxPx: 4, tile: 80 });
  assert.ok(Math.abs(al.medianDeg - 0.1) < 0.01 && Math.abs(al.p95Deg - 0.1) < 0.015, JSON.stringify(al));
  assert.ok(al.tiles > 4);
});

test("compare reports each bar as a PASS or FAIL line", () => {
  const a = scene(160, 120);
  const ok = compare(a, noisy(a, 2), { pxPerDeg: 19.5, maxDeg: 0.05, minPsnr: 30, minSsim: 0.9 });
  assert.equal(ok.pass, true, ok.lines.join("\n"));
  assert.ok(ok.lines.every((l: string) => l.startsWith("PASS")));
  const bad = compare(a, scene(160, 120, 3, 0), { pxPerDeg: 19.5, maxDeg: 0.05, minPsnr: 30 });
  assert.equal(bad.pass, false);
  assert.ok(bad.lines.some((l: string) => l.startsWith("FAIL") && l.includes("deg")));
});

test("PNG round trip for grey, grey+alpha, RGB and RGBA", () => {
  for (const channels of [1, 2, 3, 4]) {
    const img = { width: 7, height: 5, channels, data: new Uint8Array(7 * 5 * channels).map((_, i) => (i * 37 + channels) & 255) };
    const back = decodePng(encodePng(img));
    assert.deepEqual({ ...back, data: [...back.data] }, { ...img, data: [...img.data] });
  }
});
