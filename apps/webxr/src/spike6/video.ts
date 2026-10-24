import * as THREE from "three";

const H_DEG = 35;
const V_DEG = 20;
const ELEVATION_DEG = 4; // centre of the screen above the horizon: its lower edge lands on the floor at 15 m
const RADIUS = 15;
const FEATHER = 0.12; // fraction of each edge that fades out

// make-assets.sh writes it; a literal URL so the bundler can see it
const TEST_720 = new URL("./assets/test-720.mp4", import.meta.url).href;

export type VideoStat = { seconds: number; decodedFrames: number; droppedFrames: number; fps: number };

/** The play, as immersive video: a sphere segment around the viewer (court space) showing a 59.94 fps H.264 clip. */
export function makeVideoScreen(src: string | null) {
  const url = src ?? TEST_720;
  const video = document.createElement("video");
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.preload = "auto";
  video.crossOrigin = "anonymous";
  video.src = url;
  const ready = new Promise<string | null>((resolve) => {
    video.addEventListener("loadeddata", () => resolve(null), { once: true });
    video.addEventListener("error", () => resolve(video.error?.message || `video error ${video.error?.code ?? "?"}`), { once: true });
    setTimeout(() => resolve("video did not load in 30 s"), 30000);
  });

  const texture = new THREE.VideoTexture(video);
  texture.colorSpace = THREE.SRGBColorSpace;
  // feathered edges: a mask that is 1 inside and falls to 0 over the outer 12 % on every side
  const size = { w: 256, h: 144 };
  const mask = document.createElement("canvas");
  mask.width = size.w;
  mask.height = size.h;
  const ctx = mask.getContext("2d")!;
  const pixels = ctx.createImageData(size.w, size.h);
  const edge = (t: number) => {
    const x = Math.min(1, Math.min(t, 1 - t) / FEATHER);
    return x * x * (3 - 2 * x);
  };
  for (let y = 0; y < size.h; y++) {
    for (let x = 0; x < size.w; x++) {
      const v = Math.round(255 * edge((x + 0.5) / size.w) * edge((y + 0.5) / size.h));
      pixels.data.set([v, v, v, 255], 4 * (y * size.w + x));
    }
  }
  ctx.putImageData(pixels, 0, 0);
  const alphaMap = new THREE.CanvasTexture(mask);

  const phiLength = THREE.MathUtils.degToRad(H_DEG);
  const thetaLength = THREE.MathUtils.degToRad(V_DEG);
  const geometry = new THREE.SphereGeometry(RADIUS, 48, 24, Math.PI / 2 - phiLength / 2, phiLength, Math.PI / 2 - THREE.MathUtils.degToRad(ELEVATION_DEG + V_DEG / 2), thetaLength);
  const uv = geometry.attributes.uv;
  for (let k = 0; k < uv.count; k++) uv.setX(k, 1 - uv.getX(k)); // seen from inside, so it reads the right way round
  const material = new THREE.MeshBasicMaterial({ map: texture, alphaMap, transparent: true, side: THREE.BackSide, depthWrite: false, toneMapped: false });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(0, 1.6, -1.6); // the seat, in court space
  mesh.renderOrder = 4;
  mesh.visible = false;

  let on = false;
  const quality = () => {
    const q = video.getVideoPlaybackQuality?.();
    return { decoded: q?.totalVideoFrames ?? 0, dropped: q?.droppedVideoFrames ?? 0 };
  };
  return {
    mesh, video, url, ready,
    /** Start or stop the clip (restarting it from 0), and show or hide the screen. */
    set(playing: boolean, opacity = 1) {
      mesh.visible = playing;
      material.opacity = opacity;
      if (playing === on) return;
      on = playing;
      if (playing) {
        video.currentTime = 0;
        void video.play().catch(() => {});
      } else video.pause();
    },
    quality,
    stat(base: { decoded: number; dropped: number }, seconds: number): VideoStat {
      const now = quality();
      const decodedFrames = now.decoded - base.decoded;
      return { seconds: Number(seconds.toFixed(2)), decodedFrames, droppedFrames: now.dropped - base.dropped, fps: Number((decodedFrames / Math.max(0.001, seconds)).toFixed(1)) };
    },
    textureBytes: () => (video.videoWidth || 0) * (video.videoHeight || 0) * 4 + size.w * size.h * 4,
  };
}
