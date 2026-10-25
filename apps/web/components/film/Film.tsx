"use client";

import { useEffect, useRef, useState } from "react";
import { H, SCENES, W, type FilmData, type Shared } from "./scenes";

// Plays one scene of the film (?scene=<key>), or renders it (?capture): a virtual clock stands in for
// performance.now / Date.now / requestAnimationFrame, so the website's renderers advance exactly 1/60 s per frame
// however long a frame takes to draw; each frame waits for Spark's depth sort, then the 3D layer and the type layer
// are composited and posted to /api/film/frame, which encodes the scene to ~/Downloads/lucid-video/motion.

// Real time, kept before the virtual clock takes performance.now over. Waits yield through a MessageChannel, which
// a hidden page doesn't throttle (its timers drop to once a second).
const realNow = performance.now.bind(performance);
const tick = () =>
  new Promise<void>((r) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => r();
    ch.port2.postMessage(0);
  });
const sleep = async (ms: number) => {
  const until = realNow() + ms;
  while (realNow() < until) await tick();
};

// React's development mode runs an effect twice (mount, unmount, mount): only one render may own the scene's frames
let rendering = false;

function virtualClock() {
  let now = performance.now();
  const base = Date.now() - now;
  const queue = new Map<number, FrameRequestCallback>();
  let id = 1;
  Object.defineProperty(performance, "now", { value: () => now, configurable: true });
  Date.now = () => Math.round(base + now);
  window.requestAnimationFrame = (cb) => {
    queue.set(id, cb);
    return id++;
  };
  window.cancelAnimationFrame = (i) => {
    queue.delete(i);
  };
  return {
    advance(ms: number) {
      now += ms;
      const cbs = [...queue.values()];
      queue.clear();
      for (const cb of cbs) {
        try {
          cb(now);
        } catch (e) {
          console.error(e);
        }
      }
    },
  };
}

export default function Film({ data }: { data: FilmData }) {
  const glRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const [scale, setScale] = useState(0.5);
  const [status, setStatus] = useState("loading");
  const [gl, setGl] = useState<{ x: number; y: number; w: number; h: number }>({ x: 0, y: 0, w: W, h: H });

  useEffect(() => {
    const fit = () => setScale(Math.min(innerWidth / W, innerHeight / H));
    fit();
    addEventListener("resize", fit);
    return () => removeEventListener("resize", fit);
  }, []);

  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const scene = SCENES.find((s) => s.key === q.get("scene")) ?? SCENES[0];
    const capture = q.has("capture");
    const fps = Number(q.get("fps")) || 60;
    const box = scene.gl ?? { x: 0, y: 0, w: W, h: H };
    setGl(box);
    const clock = capture ? virtualClock() : null; // before anything reads the time
    const s: Shared = { data, t: 0, hud: { cams: 0 }, images: [], video: null, heat: null, clips: [] };
    let dispose = () => {};
    let stop = false;

    (async () => {
      if (capture) {
        // the throwaway first run is torn down synchronously: after one tick only the real one is still standing
        await tick();
        if (stop || rendering) return;
        rendering = true;
      }
      await scene.prepare?.(s);
      const host = glRef.current!;
      if (scene.mount) dispose = await scene.mount(host, s);
      const g = overlayRef.current!.getContext("2d")!;

      if (!clock) {
        // play it, looping, in real time
        const t0 = performance.now();
        setStatus(`${scene.key} · playing`);
        const loop = () => {
          if (stop) return;
          s.t = ((performance.now() - t0) / 1000) % scene.dur;
          if (s.video) s.video.currentTime = Math.min(s.video.duration || 0, s.t);
          for (const c of s.clips) {
            const a = c.at(s.t);
            if (a !== null) c.v.currentTime = a;
          }
          g.clearRect(0, 0, W, H);
          scene.draw(g, s.t, s);
          requestAnimationFrame(loop);
        };
        loop();
        return;
      }

      // render it, frame by frame
      const out = document.createElement("canvas");
      out.width = W;
      out.height = H;
      const og = out.getContext("2d")!;
      const post = (qs: string, body?: Blob) =>
        fetch(`/api/film/frame?scene=${scene.key}&${qs}`, { method: "POST", body: body ?? null }).then((r) => r.json());
      await post("do=start");
      if (scene.preroll && scene.mount) {
        s.t = scene.preroll.t;
        for (let k = 0; k < scene.preroll.seconds * fps; k++) {
          clock.advance(1000 / fps);
          if (k % 6 === 0) await sleep(10);
        }
        await sleep(scene.preroll.waitMs);
        clock.advance(0);
      }
      const n = Math.round(scene.dur * fps);
      for (let i = 0; i < n && !stop; i++) {
        s.t = i / fps;
        if (s.video) {
          const v = s.video;
          const at = Math.min(Math.max(0, (v.duration || 0) - 0.05), s.t);
          if (Math.abs(v.currentTime - at) > 1e-3) {
            await new Promise<void>((r) => {
              v.onseeked = () => r();
              v.currentTime = at;
            });
          }
        }
        for (const c of s.clips) {
          const a = c.at(s.t);
          if (a === null) continue;
          // a hair past the frame's own time, so a seek never lands on the frame before
          const at = Math.min(Math.max(0, (c.v.duration || 0) - 0.02), a + 0.004);
          if (Math.abs(c.v.currentTime - at) > 1e-3) {
            await new Promise<void>((r) => {
              c.v.onseeked = () => r();
              c.v.currentTime = at;
            });
          }
        }
        clock.advance(1000 / fps);
        if (scene.mount) {
          await sleep(45); // Spark sorts in a worker: let it finish, then draw again with the new order
          clock.advance(0);
        }
        g.clearRect(0, 0, W, H);
        scene.draw(g, s.t, s);
        og.fillStyle = "#000";
        og.fillRect(0, 0, W, H);
        for (const c of host.querySelectorAll("canvas")) {
          // a scene can split its 3D layer into boxes of its own (the legends, side by side)
          const el = c.parentElement!;
          if (el === host) og.drawImage(c, box.x, box.y, box.w, box.h);
          else og.drawImage(c, box.x + el.offsetLeft, box.y + el.offsetTop, el.clientWidth, el.clientHeight);
        }
        og.drawImage(overlayRef.current!, 0, 0);
        const blob = await new Promise<Blob>((r) => out.toBlob((b) => r(b!), "image/jpeg", 0.95));
        await post(`i=${i}`, blob);
        if (i % 30 === 0) setStatus(`${scene.key} · rendering ${i} / ${n}`);
      }
      if (stop) return; // torn down mid-render: leave the frames to the render that replaced this one
      const done = await post(`do=done&fps=${fps}`);
      setStatus(done.ok ? `${scene.key} · done · ${done.out}` : `${scene.key} · encode failed`);
      document.title = done.ok ? `done ${scene.key}` : `failed ${scene.key}`;
      // ?queue=a,b,c renders the next scene in a fresh page (a clean clock and a fresh GL context each time)
      const queue = (q.get("queue") ?? "").split(",").filter(Boolean);
      if (done.ok && queue.length) {
        const [next, ...rest] = queue;
        location.href = `/film?scene=${next}&capture${rest.length ? `&queue=${rest.join(",")}` : ""}`;
      }
    })().catch((e) => {
      console.error(e);
      setStatus(`error: ${String(e?.message ?? e)}`);
      document.title = `failed ${scene.key}`;
    });
    return () => {
      stop = true;
      dispose();
    };
  }, [data]);

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 1000, background: "#000", overflow: "hidden" }}>
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          width: W,
          height: H,
          transform: `translate(-50%, -50%) scale(${scale})`,
          transformOrigin: "50% 50%",
          background: "#000",
        }}
      >
        <div
          ref={glRef}
          className="film-gl"
          style={{ position: "absolute", left: gl.x, top: gl.y, width: gl.w, height: gl.h, overflow: "hidden" }}
        />
        <canvas ref={overlayRef} width={W} height={H} style={{ position: "absolute", inset: 0, width: W, height: H }} />
      </div>
      <p id="film-status" style={{ position: "absolute", left: 12, bottom: 8, margin: 0, font: "12px system-ui", color: "#555" }}>
        {status}
      </p>
      <style>{`.film-gl canvas{position:absolute!important;inset:0!important;width:100%!important;height:100%!important}`}</style>
    </div>
  );
}
