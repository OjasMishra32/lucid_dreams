// Everyone we made, side by side: each person's own turning preview (their bundle's preview.mp4, on black), standing on
// one glossy black floor with a soft reflection, the camera starting close on Ian's grandma and pulling back to all of
// them, then one word. Black drops out of every preview ("lighten"), so they stand in one space with no tiles.

import type { Scene, Shared } from "./scenes";

const W = 1920;
const H = 1080;
const FONT = '"SF Pro Display", system-ui, -apple-system, "Helvetica Neue", sans-serif';
const PEOPLE = ["dance-01", "golf-01", "guitar-01", "taichi-01", "lebron-shot", "bobby-fischer-uika", "ian-grandma",
  "magnus-carlsen-uika-360", "roger-federer-uika", "vishal", "jump-shot-hq"];
const CENTRE = PEOPLE.indexOf("ian-grandma");

const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const smooth = (x: number) => {
  const t = clamp(x);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
};
const ease = (x: number) => {
  const t = clamp(x);
  return t * t * (3 - 2 * t);
};

function videoEl(src: string): Promise<HTMLVideoElement> {
  return new Promise((ok, no) => {
    const v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    v.onloadeddata = () => ok(v);
    v.onerror = () => no(new Error(`no video: ${src}`));
    v.src = `/api/film/media?p=${encodeURIComponent(src)}`;
    v.load();
  });
}

export function lineup(key: string, dur: number, word: string, line: string): Scene {
  const vids: HTMLVideoElement[] = [];
  return {
    key,
    dur,
    async prepare(s: Shared) {
      for (const id of PEOPLE) {
        const v = await videoEl(`sources/previews/${id}.mp4`);
        vids.push(v);
        // each turns at its own pace, offset so they don't all face the same way
        const off = (PEOPLE.indexOf(id) * 0.37) % 1;
        s.clips.push({ v, at: (t) => ((off * v.duration + t * 0.9) % Math.max(0.1, v.duration - 0.05)) });
      }
    },
    draw(g, t) {
      // the pull-back: from Grandma close to all of them
      const k = smooth((t - 0.2) / (dur * 0.62));
      const zoom = 2.35 + (1 - 2.35) * k;
      const spacing = 168;
      const tileH = 560;
      const tileW = (tileH * 1080) / 1920;
      const floor = 790;
      const cx = W / 2;
      // the camera scales about Grandma's face, so the opening is her face, not her feet; the floor moves with it
      const face = floor - tileH * 0.85;
      const floorS = face + zoom * (floor - face);
      g.save();
      // floor: a soft pool of light, darker at the edges
      if (floorS < H) {
        const pool = g.createRadialGradient(cx, floorS + 10, 20, cx, floorS + 10, 980 * zoom);
        pool.addColorStop(0, "rgba(40,40,46,0.9)");
        pool.addColorStop(0.5, "rgba(16,16,20,0.6)");
        pool.addColorStop(1, "rgba(0,0,0,0)");
        g.fillStyle = pool;
        g.fillRect(0, floorS, W, H - floorS);
      }
      // everyone, scaled about Grandma's face
      g.translate(cx, face);
      g.scale(zoom, zoom);
      g.translate(0, floor - face);
      g.globalCompositeOperation = "lighten";
      vids.forEach((v, i) => {
        if (v.readyState < 2) return;
        const x = (i - CENTRE) * spacing - tileW / 2;
        // arrive: the outer ones a beat later, so the line fills from the middle out
        const arrive = ease((t - 0.3 - Math.abs(i - CENTRE) * 0.12) / 0.9);
        if (arrive <= 0.001) return;
        g.globalAlpha = arrive;
        g.drawImage(v, x, -tileH * 0.93, tileW, tileH);
        // the reflection, faded into the floor
        g.save();
        g.scale(1, -1);
        g.globalAlpha = arrive * 0.18;
        g.drawImage(v, x, -tileH * 0.07 - 2 - tileH * 0.55, tileW, tileH * 0.55);
        g.restore();
      });
      g.restore();
      // a gradient over the reflections so they fade out downward
      if (floorS + 8 < H) {
        g.save();
        const fade = g.createLinearGradient(0, floorS, 0, Math.max(H, floorS + 1));
        fade.addColorStop(0, "rgba(0,0,0,0)");
        fade.addColorStop(1, "rgba(0,0,0,1)");
        g.fillStyle = fade;
        g.fillRect(0, floorS + 8, W, H - floorS);
        g.restore();
      }

      // the word, then the line
      const a = ease((t - dur * 0.55) / 0.8);
      if (a > 0.001) {
        g.save();
        g.filter = a < 0.999 ? `blur(${((1 - a) * 12).toFixed(2)}px)` : "none";
        g.globalAlpha = a;
        g.textAlign = "center";
        g.textBaseline = "alphabetic";
        g.font = `700 132px ${FONT}`;
        const grad = g.createLinearGradient(cx - 300, 0, cx + 300, 0);
        grad.addColorStop(0, "#ffffff");
        grad.addColorStop(1, "#9cc9ff");
        g.fillStyle = grad;
        (g as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = "-4px";
        g.fillText(word, cx, 196 + (1 - a) * 22);
        g.restore();
      }
      const b = ease((t - dur * 0.55 - 0.45) / 0.8);
      if (b > 0.001) {
        g.save();
        g.globalAlpha = b;
        g.textAlign = "center";
        g.font = `500 34px ${FONT}`;
        g.fillStyle = "#a1a1a6";
        g.fillText(line, cx, 262 + (1 - b) * 14);
        g.restore();
      }
    },
  };
}
