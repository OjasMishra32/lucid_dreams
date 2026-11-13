import * as THREE from "three";
import { dreamUrl, type Dream } from "../dream";

/**
 * The person's own phone video, life size where they're about to stand: it plays once as you enter the room, then
 * they step out of it. The video wipes away from the feet up behind a thin blue edge while their Gaussians fade in
 * (the viewer's reveal), so the first thing you see is the clip they were made from turning into them.
 *
 * dream.json `intro` (optional): { video, height, below, x?, z?, label? } — the clip's height in metres shown at the
 * person's real size, how far its bottom edge sits under their soles, where its centre stands in the bundle's space
 * (x, z, metres; a replay that doesn't stand at the origin), and the line over it. A child of the person's group, so
 * it's placed, turned and anchored with them; their front faces -Z, and so does the video. A replay holds its first
 * frame until it has stepped out, then plays from the top.
 */
export interface IntroSpec {
  video: string;
  height: number;
  below?: number;
  x?: number;
  z?: number;
  label?: string;
}

const LEAVE_S = 1.4; // the same time the viewer's reveal takes
const BLUE = new THREE.Color(0x2e7dff);

export class StepOut {
  readonly group = new THREE.Group();
  private readonly video: HTMLVideoElement;
  private readonly panel: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private readonly label: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private wipe = 0;
  private playedFor = 0;
  state: "idle" | "playing" | "leaving" | "done" = "idle";

  constructor(dream: Dream, spec: IntroSpec, labelText: string) {
    const v = (this.video = document.createElement("video"));
    v.src = dreamUrl(dream.id, spec.video);
    v.crossOrigin = "anonymous";
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    const tex = new THREE.VideoTexture(v);
    tex.colorSpace = THREE.SRGBColorSpace;
    const h = spec.height;
    const below = spec.below ?? 0;
    const w = h * (720 / 1226); // until the clip says otherwise
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { map: { value: tex }, wipe: { value: 0 }, fade: { value: 0 }, blue: { value: BLUE } },
      vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        uniform sampler2D map; uniform float wipe; uniform float fade; uniform vec3 blue; varying vec2 vUv;
        void main() {
          vec4 c = texture2D(map, vUv);
          float edge = wipe * 1.12 - 0.06;                         // below the edge the video is gone
          float a = smoothstep(edge, edge + 0.05, vUv.y) * fade;
          float line = exp(-pow((vUv.y - edge - 0.025) / 0.01, 2.0)) * step(0.001, wipe) * step(wipe, 0.999);
          gl_FragColor = vec4(mix(c.rgb, blue, line * 0.85), max(a, line * fade));
          #include <colorspace_fragment>
        }`,
    });
    this.panel = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    this.panel.position.y = h / 2 - below;
    this.group.add(this.panel);
    v.addEventListener("loadedmetadata", () => {
      if (!v.videoWidth || !v.videoHeight) return;
      this.panel.geometry.dispose();
      this.panel.geometry = new THREE.PlaneGeometry(h * (v.videoWidth / v.videoHeight), h);
    });

    // a line over the clip: what it is
    const canvas = document.createElement("canvas");
    canvas.width = 1024;
    canvas.height = 96;
    const g = canvas.getContext("2d")!;
    g.font = '500 44px -apple-system, "SF Pro Text", "Helvetica Neue", Arial, sans-serif';
    g.fillStyle = "rgba(245,245,247,0.92)";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(spec.label ?? labelText, 512, 48);
    const ltex = new THREE.CanvasTexture(canvas);
    ltex.colorSpace = THREE.SRGBColorSpace;
    this.label = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.075), new THREE.MeshBasicMaterial({ map: ltex, transparent: true, depthWrite: false, opacity: 0 }));
    this.label.position.y = h - below + 0.07;
    this.group.add(this.label);
    // both face the person's front (-Z), towards you
    this.group.rotation.y = Math.PI;
    this.group.position.set(spec.x ?? 0, 0, spec.z ?? 0);
    this.group.visible = false;
  }

  /** While the clip plays the person stays hidden (the viewer holds its reveal at 0). */
  get holding(): boolean {
    return this.state === "playing";
  }

  start() {
    this.state = "playing";
    this.wipe = 0;
    this.playedFor = 0;
    this.group.visible = true;
    this.video.currentTime = 0;
    // muted, so it may start without a press (and entering the room was one)
    void this.video.play().catch(() => this.leave());
  }

  /** Straight to them (a press on the menu, or the clip can't play). */
  leave() {
    if (this.state === "playing") this.state = "leaving";
  }

  update(dt: number) {
    const m = this.panel.material;
    if (this.state === "playing") {
      this.playedFor += dt;
      m.uniforms.fade.value = Math.min(1, m.uniforms.fade.value + dt / 0.5);
      const d = this.video.duration;
      if (this.video.ended || (d && this.video.currentTime >= d - 0.06) || this.playedFor > 20) this.leave();
    } else if (this.state === "leaving") {
      this.wipe = Math.min(1, this.wipe + dt / LEAVE_S);
      if (this.wipe >= 1) {
        this.state = "done";
        this.group.visible = false;
        this.video.pause();
      }
    }
    m.uniforms.wipe.value = this.wipe;
    this.label.material.opacity = this.state === "playing" ? m.uniforms.fade.value : Math.max(0, 1 - this.wipe * 2);
  }

  /** Leaving the room: stop, and play again next time in. */
  reset() {
    this.video.pause();
    this.state = "idle";
    this.wipe = 0;
    this.group.visible = false;
    this.panel.material.uniforms.fade.value = 0;
  }
}
